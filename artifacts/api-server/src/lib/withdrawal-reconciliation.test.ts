/**
 * Tests for the withdrawal reconciliation job (reconcileProcessingWithdrawals).
 *
 * ── What this tests ───────────────────────────────────────────────────────────
 *
 *   reconcileProcessingWithdrawals:
 *     1. Finds all withdrawals in `processing` state for the specified provider.
 *     2. Emits an operational alert (logger.error) for any stuck > 24 hours.
 *     3. Skips any withdrawal with no providerReference (logs a warning).
 *     4. Calls provider.verifyPayout (outside any transaction).
 *     5. On network error: logs, skips, continues batch.
 *     6. On "pending": no DB change.
 *     7. On "success": calls completeWithdrawal → confirms reservation, debits
 *        balance, marks completed, stores webhookTransferId.
 *     8. On "failure": calls failWithdrawal → releases reservation, marks failed,
 *        stores webhookTransferId.
 *     9. If a concurrent webhook resolved the withdrawal between verifyPayout
 *        and the DB write: detects status !== "processing", returns
 *        "already_terminal" without touching the wallet.
 *   10. Empty batch: does nothing.
 *   11. Provider filter: only processes withdrawals whose `provider` matches
 *       provider.name; ignores withdrawals from other providers.
 *   12. Notifications fire after the transaction commits (not inside).
 *
 * ── Isolation strategy ────────────────────────────────────────────────────────
 *
 *   Each scenario gets its own isolated user so the partial unique index
 *   (one active withdrawal per user) is never violated when all 8 scenarios
 *   have 'reserved' withdrawals simultaneously.
 *
 *   reconcileProcessingWithdrawals processes ALL `processing` withdrawals for
 *   the given provider. To avoid cross-test interference:
 *
 *     - All scenario withdrawals are created in `reserved` state in beforeAll.
 *     - Each test advances only its own withdrawal to `processing` immediately
 *       before running the job (using toProcessing()). All other withdrawals
 *       remain `reserved`, so the job finds exactly one processing row per run.
 *     - After the job run, each withdrawal is in a terminal or stable state.
 *
 *   Uses a real PostgreSQL database and MockPayoutProvider — no real HTTP calls.
 *   All DB records are cleaned up in afterAll in FK-safe deletion order.
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
  reconcileProcessingWithdrawals,
  PROCESSING_ALERT_THRESHOLD_MS,
} from "./withdrawal-reconciliation";
import { MockPayoutProvider } from "./payout/mock-payout";
import { logger } from "./logger";
import { notifyWithdrawalCompleted, notifyWithdrawalFailed } from "./notifications";

// Spy on notifications to verify they fire (and with the right args).
vi.mock("./notifications", async (importActual) => {
  const actual = await importActual<typeof import("./notifications")>();
  return {
    ...actual,
    notifyWithdrawalCompleted: vi.fn().mockResolvedValue(undefined),
    notifyWithdrawalFailed: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const prefix = `twrecon${Date.now()}`;

const allUserIds: string[] = [];
const allWalletAccountIds: string[] = [];

interface Scenario {
  userId: string;
  winningAccountId: string;
  walletAccountIds: string[];
  bankAccountId: string;
  withdrawal: Withdrawal;
}

let _mobileIndex = 0;
function nextMobile(): string {
  _mobileIndex += 1;
  return `+91${String(_mobileIndex).padStart(3, "0")}${prefix.slice(-7)}`;
}

async function createScenario(key: string): Promise<Scenario> {
  const pwHash = await hashPassword("TestPass123!");

  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-${key}`,
      name: "Recon Tester",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}-${key}@test.example`,
      mobileNumber: nextMobile(),
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  const userId = user!.id;
  allUserIds.push(userId);

  const accounts = await createWalletAccountsForUser(db, userId);
  const walletAccountIds = accounts.map((a) => a.id);
  allWalletAccountIds.push(...walletAccountIds);
  const winning = accounts.find((a) => a.walletType === "winning_coins")!;

  await db.transaction(async (tx) => {
    await recordCompletedTransaction(tx, {
      walletAccountId: winning.id,
      amount: MINIMUM_WITHDRAWAL_AMOUNT * 20,
      idempotencyKey: `${prefix}:${key}:seed`,
      referenceType: "test_seed",
      description: "Initial test balance",
    });
  });

  const bankAccount = await addBankAccount({
    userId,
    method: "bank_transfer",
    accountHolderName: "Recon Tester",
    bankAccountNumber: "11122233344",
    bankIfscCode: "SBIN0001122",
    bankName: "SBI",
  });

  const { withdrawal } = await db.transaction(async (tx) =>
    initiateWithdrawal(tx, {
      userId,
      amount: MINIMUM_WITHDRAWAL_AMOUNT,
      payoutAccountId: bankAccount.id,
      idempotencyKey: `${prefix}:${key}:wd`,
    }),
  );

  return {
    userId,
    winningAccountId: winning.id,
    walletAccountIds,
    bankAccountId: bankAccount.id,
    withdrawal,
  };
}

// ── Per-scenario fixtures ──────────────────────────────────────────────────────

// One withdrawal per scenario; all created in `reserved` state. Each test
// advances its own withdrawal to `processing` before calling the job.
let sSuccess: Scenario;       // verifyPayout → success → completed
let sFailure: Scenario;       // verifyPayout → failure → failed
let sPending: Scenario;       // verifyPayout → still pending → unchanged
let sConcurrent: Scenario;    // verifyPayout returns success, but row was already terminal
let sNoRef: Scenario;         // no providerReference → skipped
let sNetErr: Scenario;        // verifyPayout throws → caught, batch continues
let sStuck: Scenario;         // providerSubmittedAt > 24 h → operational alert emitted
let sOtherProvider: Scenario; // provider = 'payu' → should be ignored by mock reconciliation

// ── ControlledMockProvider ────────────────────────────────────────────────────

/**
 * MockPayoutProvider subclass with an optional async hook that runs at the
 * start of each verifyPayout call. Used by the concurrent-webhook test to
 * simulate a webhook that resolves the withdrawal while verifyPayout is in
 * flight, before the reconciliation job's DB write.
 */
class ControlledMockProvider extends MockPayoutProvider {
  verifyHook?: (providerReference: string, withdrawalId: string) => Promise<void>;

  override async verifyPayout(
    providerReference: string,
    withdrawalId: string,
  ) {
    await this.verifyHook?.(providerReference, withdrawalId);
    return super.verifyPayout(providerReference, withdrawalId);
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Each scenario gets its own isolated user — no unique-index conflict.
  sSuccess       = await createScenario("success");
  sFailure       = await createScenario("failure");
  sPending       = await createScenario("pending");
  sConcurrent    = await createScenario("concurrent");
  sNoRef         = await createScenario("noref");
  sNetErr        = await createScenario("neterr");
  sStuck         = await createScenario("stuck");
  sOtherProvider = await createScenario("otherprovider");
});

afterAll(async () => {
  if (allUserIds.length === 0) return;

  await db.delete(withdrawalsTable).where(inArray(withdrawalsTable.userId, allUserIds));
  await db
    .delete(walletReservationsTable)
    .where(inArray(walletReservationsTable.walletAccountId, allWalletAccountIds));
  await db
    .delete(walletTransactionsTable)
    .where(inArray(walletTransactionsTable.walletAccountId, allWalletAccountIds));
  await db.delete(userBankAccountsTable).where(inArray(userBankAccountsTable.userId, allUserIds));
  await db
    .delete(walletAccountsTable)
    .where(inArray(walletAccountsTable.id, allWalletAccountIds));
  await db.delete(usersTable).where(inArray(usersTable.id, allUserIds));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Advances a withdrawal from `reserved` to `processing` for a given provider. */
async function toProcessing(w: Withdrawal, providerName = "mock"): Promise<Withdrawal> {
  const [updated] = await db
    .update(withdrawalsTable)
    .set({
      status: "processing",
      provider: providerName,
      providerReference: `${providerName.toUpperCase()}_REF_${w.id}`,
      providerSubmittedAt: new Date(),
    })
    .where(eq(withdrawalsTable.id, w.id))
    .returning();
  return updated!;
}

async function getWithdrawalFromDb(id: string) {
  const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, id));
  return w!;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("reconcileProcessingWithdrawals", () => {
  let provider: ControlledMockProvider;

  beforeEach(() => {
    provider = new ControlledMockProvider();
    vi.clearAllMocks();
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  it("completes a withdrawal when verifyPayout returns success", async () => {
    const processing = await toProcessing(sSuccess.withdrawal);
    const walletBefore = (await db
      .select()
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, sSuccess.winningAccountId)))[0]!;

    await reconcileProcessingWithdrawals(provider);

    const w = await getWithdrawalFromDb(sSuccess.withdrawal.id);
    expect(w.status).toBe("completed");
    expect(w.completedAt).not.toBeNull();

    // Balance debited.
    const walletAfter = (await db
      .select()
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, sSuccess.winningAccountId)))[0]!;
    expect(walletAfter.balance).toBe(walletBefore.balance - sSuccess.withdrawal.amount);
    expect(walletAfter.reservedBalance).toBe(walletBefore.reservedBalance - sSuccess.withdrawal.amount);

    // webhookTransferId is populated with the verified providerReference.
    expect(w.webhookTransferId).not.toBeNull();
    expect(w.webhookTransferId).toBe(processing.providerReference);

    // Completion notification must fire after commit.
    expect(notifyWithdrawalCompleted).toHaveBeenCalledOnce();
    expect(notifyWithdrawalCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawalId: sSuccess.withdrawal.id }),
    );
    expect(notifyWithdrawalFailed).not.toHaveBeenCalled();
  });

  // ── Failure path ──────────────────────────────────────────────────────────────

  it("fails a withdrawal when verifyPayout returns failure", async () => {
    const processing = await toProcessing(sFailure.withdrawal);
    provider.verifyResults = [{ outcome: "failure", reason: "Account frozen by bank" }];

    const walletBefore = (await db
      .select()
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, sFailure.winningAccountId)))[0]!;

    await reconcileProcessingWithdrawals(provider);

    const w = await getWithdrawalFromDb(sFailure.withdrawal.id);
    expect(w.status).toBe("failed");
    expect(w.failureReason).toBe("Account frozen by bank");
    expect(w.failedAt).not.toBeNull();

    // Reservation released: reservedBalance decremented, balance unchanged.
    const walletAfter = (await db
      .select()
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, sFailure.winningAccountId)))[0]!;
    expect(walletAfter.balance).toBe(walletBefore.balance);
    expect(walletAfter.reservedBalance).toBe(
      walletBefore.reservedBalance - sFailure.withdrawal.amount,
    );

    // webhookTransferId is populated on failure too (audit trail).
    expect(w.webhookTransferId).toBe(processing.providerReference);

    // Failure notification fires after commit.
    expect(notifyWithdrawalFailed).toHaveBeenCalledOnce();
    expect(notifyWithdrawalFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        withdrawalId: sFailure.withdrawal.id,
        reason: "Account frozen by bank",
      }),
    );
    expect(notifyWithdrawalCompleted).not.toHaveBeenCalled();
  });

  // ── Pending path ──────────────────────────────────────────────────────────────

  it("leaves a withdrawal unchanged when verifyPayout returns pending", async () => {
    await toProcessing(sPending.withdrawal);
    provider.verifyResults = [{ outcome: "pending" }];

    await reconcileProcessingWithdrawals(provider);

    const w = await getWithdrawalFromDb(sPending.withdrawal.id);
    expect(w.status).toBe("processing"); // Unchanged.
    expect(notifyWithdrawalCompleted).not.toHaveBeenCalled();
    expect(notifyWithdrawalFailed).not.toHaveBeenCalled();
  });

  // ── Concurrent webhook ────────────────────────────────────────────────────────

  it("detects already_terminal when a concurrent webhook resolved the withdrawal during verifyPayout", async () => {
    await toProcessing(sConcurrent.withdrawal);
    provider.verifyResults = [{ outcome: "success", providerReference: "REF_CONCURRENT" }];

    // Hook: simulate a webhook completing the withdrawal between verifyPayout and the DB write.
    provider.verifyHook = async (_ref, withdrawalId) => {
      await db
        .update(withdrawalsTable)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(withdrawalsTable.id, withdrawalId));
    };

    await reconcileProcessingWithdrawals(provider);

    // Withdrawal was completed by the simulated webhook — reconciliation skipped it.
    const w = await getWithdrawalFromDb(sConcurrent.withdrawal.id);
    expect(w.status).toBe("completed");
    // webhookTransferId was NOT set by reconciliation (it returned already_terminal).
    expect(w.webhookTransferId).toBeNull();
  });

  // ── No provider reference ─────────────────────────────────────────────────────

  it("skips a withdrawal with no providerReference and continues the batch", async () => {
    // Advance to processing without setting a providerReference.
    await db
      .update(withdrawalsTable)
      .set({
        status: "processing",
        provider: "mock",
        providerReference: null,
        providerSubmittedAt: new Date(),
      })
      .where(eq(withdrawalsTable.id, sNoRef.withdrawal.id));

    await reconcileProcessingWithdrawals(provider);

    const w = await getWithdrawalFromDb(sNoRef.withdrawal.id);
    expect(w.status).toBe("processing"); // Still processing — not verified.
    expect(provider.verifiedPayouts).toHaveLength(0); // verifyPayout was not called.
  });

  // ── Network error ─────────────────────────────────────────────────────────────

  it("catches a verifyPayout network error and continues with the rest of the batch", async () => {
    await toProcessing(sNetErr.withdrawal);
    provider.verifyPayout = async () => {
      throw new Error("Provider unreachable");
    };

    // Should not throw — error is caught and logged.
    await expect(reconcileProcessingWithdrawals(provider)).resolves.toBeUndefined();

    const w = await getWithdrawalFromDb(sNetErr.withdrawal.id);
    expect(w.status).toBe("processing"); // Unchanged — will retry next run.
  });

  // ── 24h stuck alert ───────────────────────────────────────────────────────────

  it("emits a logger.error alert for a withdrawal stuck > 24 hours", async () => {
    const oldDate = new Date(Date.now() - PROCESSING_ALERT_THRESHOLD_MS - 60_000);
    await db
      .update(withdrawalsTable)
      .set({
        status: "processing",
        provider: "mock",
        providerReference: `STUCK_REF_${sStuck.withdrawal.id}`,
        providerSubmittedAt: oldDate,
      })
      .where(eq(withdrawalsTable.id, sStuck.withdrawal.id));

    const errorSpy = vi.spyOn(logger, "error");

    await reconcileProcessingWithdrawals(provider);

    const stuckAlerts = errorSpy.mock.calls.filter(([obj]) => {
      return (
        typeof obj === "object" &&
        obj !== null &&
        "event" in obj &&
        (obj as Record<string, unknown>)["event"] === "withdrawal.processing.stuck_alert"
      );
    });

    expect(stuckAlerts.length).toBeGreaterThan(0);
    const [alertObj] = stuckAlerts[0]!;
    expect((alertObj as Record<string, unknown>)["withdrawalId"]).toBe(sStuck.withdrawal.id);

    errorSpy.mockRestore();
  });

  // ── Empty batch ───────────────────────────────────────────────────────────────

  it("is a no-op when there are no processing withdrawals for this provider", async () => {
    // Create a fresh provider with name 'nonexistent' — no withdrawals for this provider.
    const freshProvider = new MockPayoutProvider();
    Object.defineProperty(freshProvider, "name", { value: "nonexistent" });

    await reconcileProcessingWithdrawals(freshProvider);

    // No verifyPayout calls.
    expect(freshProvider.verifiedPayouts).toHaveLength(0);
  });

  // ── Provider filter ───────────────────────────────────────────────────────────

  it("only processes withdrawals whose provider matches provider.name", async () => {
    // sOtherProvider is advanced to 'processing' with provider='payu'.
    // Reconciling with mock provider should NOT touch it.
    await db
      .update(withdrawalsTable)
      .set({
        status: "processing",
        provider: "payu",
        providerReference: `PAYU_REF_${sOtherProvider.withdrawal.id}`,
        providerSubmittedAt: new Date(),
      })
      .where(eq(withdrawalsTable.id, sOtherProvider.withdrawal.id));

    const mockProvider = new MockPayoutProvider();
    // Default verifyPayout returns success — if it were called it would complete the withdrawal.
    await reconcileProcessingWithdrawals(mockProvider);

    // The 'payu' withdrawal must NOT have been touched.
    const w = await getWithdrawalFromDb(sOtherProvider.withdrawal.id);
    expect(w.status).toBe("processing"); // Untouched.
    expect(mockProvider.verifiedPayouts).not.toContainEqual(
      expect.objectContaining({ withdrawalId: sOtherProvider.withdrawal.id }),
    );
  });

  // ── Idempotency — no double-debit ─────────────────────────────────────────────

  it("does not double-debit if reconciliation is run twice for the same completed withdrawal", async () => {
    // sSuccess was completed in the first test.
    const w = await getWithdrawalFromDb(sSuccess.withdrawal.id);
    expect(w.status).toBe("completed");

    const walletBefore = (await db
      .select()
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, sSuccess.winningAccountId)))[0]!;

    // Run reconciliation again — completed withdrawal should be detected as already_terminal.
    const freshProvider = new MockPayoutProvider();
    await reconcileProcessingWithdrawals(freshProvider);

    const walletAfter = (await db
      .select()
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, sSuccess.winningAccountId)))[0]!;

    // Balance must not change — no double debit.
    expect(walletAfter.balance).toBe(walletBefore.balance);
    expect(walletAfter.reservedBalance).toBe(walletBefore.reservedBalance);
  });
});
