/**
 * Tests for withdrawal health monitoring functions.
 *
 * Uses a real PostgreSQL database. Each test creates its own isolated data
 * and cleans up in afterAll. The tests verify that health check functions
 * emit the correct structured log events for unhealthy conditions and are
 * silent for healthy ones.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  walletAccountsTable,
  walletTransactionsTable,
  walletReservationsTable,
  withdrawalsTable,
  userBankAccountsTable,
  type Withdrawal,
} from "@workspace/db";
import { hashPassword, PASSWORD_ALGO } from "./password";
import { createWalletAccountsForUser, recordCompletedTransaction } from "./wallet";
import { addBankAccount } from "./bank-account";
import { initiateWithdrawal, MINIMUM_WITHDRAWAL_AMOUNT } from "./withdrawal";
import {
  checkReservedBalanceDrift,
  checkStuckReservedWithdrawals,
  checkStuckProcessingWithdrawals,
  runWithdrawalHealthChecks,
  STUCK_RESERVED_THRESHOLD_MS,
  STUCK_PROCESSING_THRESHOLD_MS,
} from "./health";
import { logger } from "./logger";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const prefix = `thealth${Date.now()}`;

let userId = "";
let winningAccountId = "";
let walletAccountIds: string[] = [];
let bankAccountId = "";

let wReserved: Withdrawal;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const pwHash = await hashPassword("TestPass123!");

  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-u`,
      name: "Health Tester",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}@test.example`,
      mobileNumber: `+91900${prefix.slice(-7)}`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  userId = user!.id;

  const accounts = await createWalletAccountsForUser(db, userId);
  walletAccountIds = accounts.map((a) => a.id);
  const winning = accounts.find((a) => a.walletType === "winning_coins")!;
  winningAccountId = winning.id;

  await db.transaction(async (tx) => {
    await recordCompletedTransaction(tx, {
      walletAccountId: winningAccountId,
      amount: MINIMUM_WITHDRAWAL_AMOUNT * 10,
      idempotencyKey: `${prefix}:seed`,
      referenceType: "test_seed",
      description: "Initial test balance",
    });
  });

  const account = await addBankAccount({
    userId,
    method: "bank_transfer",
    accountHolderName: "Health Tester",
    bankAccountNumber: "12312312312",
    bankIfscCode: "HDFC0001234",
    bankName: "HDFC Bank",
  });
  bankAccountId = account.id;

  // Create a reserved withdrawal to use in tests.
  const result = await db.transaction(async (tx) =>
    initiateWithdrawal(tx, {
      userId,
      amount: MINIMUM_WITHDRAWAL_AMOUNT,
      payoutAccountId: bankAccountId,
      idempotencyKey: `${prefix}:reserved`,
    }),
  );
  wReserved = result.withdrawal;
});

afterAll(async () => {
  if (!userId) return;

  await db.delete(withdrawalsTable).where(eq(withdrawalsTable.userId, userId));
  await db
    .delete(walletReservationsTable)
    .where(inArray(walletReservationsTable.walletAccountId, walletAccountIds));
  await db
    .delete(walletTransactionsTable)
    .where(inArray(walletTransactionsTable.walletAccountId, walletAccountIds));
  await db.delete(userBankAccountsTable).where(eq(userBankAccountsTable.userId, userId));
  await db
    .delete(walletAccountsTable)
    .where(inArray(walletAccountsTable.id, walletAccountIds));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

// ── checkReservedBalanceDrift ─────────────────────────────────────────────────

describe("checkReservedBalanceDrift", () => {
  it("emits no log for a wallet with correct reserved_balance", async () => {
    // The wallet currently has a reservation from wReserved.
    // reserved_balance should equal the reservation amount.
    const logSpy = vi.spyOn(logger, "error");

    await checkReservedBalanceDrift();

    // No drift for this test's wallet (or any wallet in a clean DB).
    const driftCalls = logSpy.mock.calls.filter(([obj]) => {
      return typeof obj === "object" && obj !== null && "event" in obj &&
        (obj as Record<string, unknown>)["event"] === "health.reserved_balance_drift";
    });
    expect(driftCalls.length).toBe(0);

    logSpy.mockRestore();
  });

  it("emits an error log when reserved_balance drifts from active reservations", async () => {
    const logSpy = vi.spyOn(logger, "error");

    // Directly corrupt the wallet's reserved_balance to simulate drift.
    // Use +1 so reserved_balance stays within the balance (avoids CHECK constraint).
    await db
      .update(walletAccountsTable)
      .set({ reservedBalance: sql`${walletAccountsTable.reservedBalance} + 1` })
      .where(eq(walletAccountsTable.id, winningAccountId));

    try {
      await checkReservedBalanceDrift();

      const driftCalls = logSpy.mock.calls.filter(([obj]) => {
        return typeof obj === "object" && obj !== null && "event" in obj &&
          (obj as Record<string, unknown>)["event"] === "health.reserved_balance_drift";
      });
      expect(driftCalls.length).toBeGreaterThan(0);
    } finally {
      // Restore correct reserved_balance to avoid interfering with other tests.
      await db
        .update(walletAccountsTable)
        .set({ reservedBalance: sql`${walletAccountsTable.reservedBalance} - 1` })
        .where(eq(walletAccountsTable.id, winningAccountId));

      logSpy.mockRestore();
    }
  });
});

// ── checkStuckReservedWithdrawals ─────────────────────────────────────────────

describe("checkStuckReservedWithdrawals", () => {
  it("emits no log when reserved withdrawal is recent", async () => {
    // wReserved was just created — well within the threshold.
    const logSpy = vi.spyOn(logger, "error");

    await checkStuckReservedWithdrawals();

    const stuckCalls = logSpy.mock.calls.filter(([obj]) => {
      return typeof obj === "object" && obj !== null && "event" in obj &&
        (obj as Record<string, unknown>)["event"] === "health.stuck_reserved_withdrawals";
    });
    expect(stuckCalls.length).toBe(0);

    logSpy.mockRestore();
  });

  it("emits an error log when a reserved withdrawal is stuck beyond the threshold", async () => {
    const logSpy = vi.spyOn(logger, "error");

    // Backdate the withdrawal's created_at to simulate a stuck withdrawal.
    const oldDate = new Date(Date.now() - STUCK_RESERVED_THRESHOLD_MS - 60_000);
    await db
      .update(withdrawalsTable)
      .set({ createdAt: oldDate })
      .where(eq(withdrawalsTable.id, wReserved.id));

    try {
      await checkStuckReservedWithdrawals();

      const stuckCalls = logSpy.mock.calls.filter(([obj]) => {
        return typeof obj === "object" && obj !== null && "event" in obj &&
          (obj as Record<string, unknown>)["event"] === "health.stuck_reserved_withdrawals";
      });
      expect(stuckCalls.length).toBeGreaterThan(0);

      const [logObj] = stuckCalls[0]!;
      expect((logObj as Record<string, unknown>)["count"]).toBeGreaterThan(0);
    } finally {
      // Restore the created_at to now so other tests aren't affected.
      await db
        .update(withdrawalsTable)
        .set({ createdAt: new Date() })
        .where(eq(withdrawalsTable.id, wReserved.id));

      logSpy.mockRestore();
    }
  });
});

// ── checkStuckProcessingWithdrawals ───────────────────────────────────────────

describe("checkStuckProcessingWithdrawals", () => {
  it("emits no log when there are no processing withdrawals", async () => {
    // wReserved is 'reserved', not 'processing'.
    const logSpy = vi.spyOn(logger, "error");

    await checkStuckProcessingWithdrawals();

    const stuckCalls = logSpy.mock.calls.filter(([obj]) => {
      return typeof obj === "object" && obj !== null && "event" in obj &&
        (obj as Record<string, unknown>)["event"] === "health.stuck_processing_withdrawals";
    });
    expect(stuckCalls.length).toBe(0);

    logSpy.mockRestore();
  });

  it("emits an error log when a processing withdrawal is stuck beyond 24h", async () => {
    const logSpy = vi.spyOn(logger, "error");

    // Move wReserved to processing with an old submission timestamp.
    const oldDate = new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_MS - 60_000);
    await db
      .update(withdrawalsTable)
      .set({
        status: "processing",
        provider: "mock",
        providerReference: "MOCK_STUCK",
        providerSubmittedAt: oldDate,
      })
      .where(eq(withdrawalsTable.id, wReserved.id));

    try {
      await checkStuckProcessingWithdrawals();

      const stuckCalls = logSpy.mock.calls.filter(([obj]) => {
        return typeof obj === "object" && obj !== null && "event" in obj &&
          (obj as Record<string, unknown>)["event"] === "health.stuck_processing_withdrawals";
      });
      expect(stuckCalls.length).toBeGreaterThan(0);
    } finally {
      // Restore to reserved so cleanup in afterAll works correctly.
      await db
        .update(withdrawalsTable)
        .set({ status: "reserved", provider: null, providerReference: null, providerSubmittedAt: null })
        .where(eq(withdrawalsTable.id, wReserved.id));

      logSpy.mockRestore();
    }
  });
});

// ── runWithdrawalHealthChecks ─────────────────────────────────────────────────

describe("runWithdrawalHealthChecks", () => {
  it("runs all three checks without throwing", async () => {
    // Just ensure the orchestrator completes without errors.
    await expect(runWithdrawalHealthChecks()).resolves.toBeUndefined();
  });

  it("continues running remaining checks when one throws", async () => {
    // Inject a failing drift check directly via the overrides parameter, avoiding
    // the ES-module live-binding limitation that prevents vi.spyOn from intercepting
    // intra-module function calls in runWithdrawalHealthChecks.
    const errorSpy = vi.spyOn(logger, "error");

    await expect(
      runWithdrawalHealthChecks({
        drift: async () => {
          throw new Error("Simulated drift check failure");
        },
      }),
    ).resolves.toBeUndefined();

    // The error should be logged, not thrown.
    const errorCalls = errorSpy.mock.calls.filter(([obj]) => {
      return typeof obj === "object" && obj !== null && "err" in obj;
    });
    expect(errorCalls.length).toBeGreaterThan(0);

    errorSpy.mockRestore();
  });
});
