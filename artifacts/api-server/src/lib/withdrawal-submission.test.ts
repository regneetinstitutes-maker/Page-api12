/**
 * Tests for submitPendingWithdrawals.
 *
 * Verifies the three-phase submission pattern:
 *  Phase 1 — lease acquisition (inside transaction)
 *  Phase 2 — HTTP call to provider (outside transaction)
 *  Phase 3 — outcome application (inside new transaction)
 *
 * ── Isolation strategy ────────────────────────────────────────────────────────
 *
 *   Each test scenario gets its own isolated user so that the partial unique
 *   index (one active withdrawal per user) is never violated when multiple
 *   'reserved' withdrawals coexist.
 *
 *   The submission job picks up ALL 'reserved' withdrawals without a lease.
 *   To ensure each test run processes exactly ONE withdrawal:
 *     - A fresh submission lease (lastSubmissionAttemptAt = now) is set on
 *       every withdrawal in beforeAll EXCEPT wMaxAttempts (which is intended
 *       to run with no lease and max attempts already set).
 *     - Each test calls clearLease() on its own withdrawal before invoking
 *       the job. All other withdrawals retain their leases, so the job
 *       ignores them.
 *
 * ── Payout method coverage ────────────────────────────────────────────────────
 *
 *   Most scenarios use bank_transfer accounts. The `sUpi` scenario verifies
 *   that the submission job correctly builds a UPI-method SubmitPayoutInput
 *   (with upiId, no account_number/ifsc_code) from the withdrawal snapshot.
 *
 * Uses a real PostgreSQL database and MockPayoutProvider.
 * All DB records are cleaned up in afterAll in FK-safe deletion order.
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
  submitPendingWithdrawals,
  MAX_SUBMISSION_ATTEMPTS,
} from "./withdrawal-submission";
import { MockPayoutProvider } from "./payout/mock-payout";
import { notifyWithdrawalFailed } from "./notifications";

// Spy on notifications to verify they are called (and not inside a transaction).
vi.mock("./notifications", async (importActual) => {
  const actual = await importActual<typeof import("./notifications")>();
  return {
    ...actual,
    notifyWithdrawalFailed: vi.fn().mockResolvedValue(undefined),
    notifyWithdrawalCompleted: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const prefix = `twsub${Date.now()}`;

const allUserIds: string[] = [];
const allWalletAccountIds: string[] = [];

interface Scenario {
  userId: string;
  winningAccountId: string;
  walletAccountIds: string[];
  /** ID of the saved payout account (bank transfer or UPI). */
  savedAccountId: string;
  withdrawal: Withdrawal;
}

let _mobileIndex = 0;
function nextMobile(): string {
  _mobileIndex += 1;
  return `+91${String(_mobileIndex).padStart(3, "0")}${prefix.slice(-7)}`;
}

async function createBankTransferScenario(key: string): Promise<Scenario> {
  const pwHash = await hashPassword("TestPass123!");

  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-${key}`,
      name: "Submission Tester",
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

  const savedAccount = await addBankAccount({
    userId,
    method: "bank_transfer",
    accountHolderName: "Submission Tester",
    bankAccountNumber: "98765432101",
    bankIfscCode: "ICIC0009876",
    bankName: "ICICI Bank",
  });

  const { withdrawal } = await db.transaction(async (tx) =>
    initiateWithdrawal(tx, {
      userId,
      amount: MINIMUM_WITHDRAWAL_AMOUNT,
      payoutAccountId: savedAccount.id,
      idempotencyKey: `${prefix}:${key}:wd`,
    }),
  );

  return {
    userId,
    winningAccountId: winning.id,
    walletAccountIds,
    savedAccountId: savedAccount.id,
    withdrawal,
  };
}

async function createUpiScenario(key: string): Promise<Scenario> {
  const pwHash = await hashPassword("TestPass123!");

  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-${key}`,
      name: "UPI Submission Tester",
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
      description: "Initial test balance for UPI submission scenario",
    });
  });

  const savedAccount = await addBankAccount({
    userId,
    method: "upi",
    accountHolderName: "UPI Submission Tester",
    upiId: "upisubmit@okhdfc",
  });

  const { withdrawal } = await db.transaction(async (tx) =>
    initiateWithdrawal(tx, {
      userId,
      amount: MINIMUM_WITHDRAWAL_AMOUNT,
      payoutAccountId: savedAccount.id,
      idempotencyKey: `${prefix}:${key}:wd`,
    }),
  );

  return {
    userId,
    winningAccountId: winning.id,
    walletAccountIds,
    savedAccountId: savedAccount.id,
    withdrawal,
  };
}

// ── Per-scenario fixtures ──────────────────────────────────────────────────────

let sAccept: Scenario;
let sReject: Scenario;
let sNetworkError: Scenario;
let sPhase3Concurrent: Scenario;
let sMaxAttempts: Scenario;
let sUpi: Scenario;  // UPI payout method submission scenario

// ── Setup / teardown ──────────────────────────────────────────────────────────

async function setLease(withdrawalId: string) {
  await db
    .update(withdrawalsTable)
    .set({ lastSubmissionAttemptAt: new Date() })
    .where(eq(withdrawalsTable.id, withdrawalId));
}

async function clearLease(withdrawalId: string) {
  await db
    .update(withdrawalsTable)
    .set({ lastSubmissionAttemptAt: null })
    .where(eq(withdrawalsTable.id, withdrawalId));
}

beforeAll(async () => {
  // Create isolated user+wallet+account+withdrawal for each scenario.
  sAccept           = await createBankTransferScenario("accept");
  sReject           = await createBankTransferScenario("reject");
  sNetworkError     = await createBankTransferScenario("neterr");
  sPhase3Concurrent = await createBankTransferScenario("phase3");
  sMaxAttempts      = await createBankTransferScenario("maxattempts");
  sUpi              = await createUpiScenario("upi");

  // Immediately lease every withdrawal so the job won't pick any of them up
  // until each test explicitly calls clearLease() for its own scenario.
  await setLease(sAccept.withdrawal.id);
  await setLease(sReject.withdrawal.id);
  await setLease(sNetworkError.withdrawal.id);
  await setLease(sPhase3Concurrent.withdrawal.id);
  await setLease(sMaxAttempts.withdrawal.id);
  await setLease(sUpi.withdrawal.id);

  // wMaxAttempts: pre-set submission_attempts = MAX so Phase 1 fails it immediately
  // when the test clears the lease and the job picks it up.
  await db
    .update(withdrawalsTable)
    .set({ submissionAttempts: MAX_SUBMISSION_ATTEMPTS })
    .where(eq(withdrawalsTable.id, sMaxAttempts.withdrawal.id));
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("submitPendingWithdrawals", () => {
  let provider: MockPayoutProvider;

  beforeEach(() => {
    provider = new MockPayoutProvider();
    vi.clearAllMocks();
  });

  it("submits a bank_transfer withdrawal and moves it to 'processing' on acceptance", async () => {
    provider.nextSubmitResult = { outcome: "accepted", providerReference: "REF_ACCEPT_001" };
    // Make sAccept the only unleased 'reserved' withdrawal so the job picks only it.
    await clearLease(sAccept.withdrawal.id);

    await submitPendingWithdrawals(provider);

    const w = await db
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, sAccept.withdrawal.id))
      .then((r) => r[0]!);
    expect(w.status).toBe("processing");
    expect(w.providerReference).toBe("REF_ACCEPT_001");
    expect(w.provider).toBe("mock");
    expect(w.providerSubmittedAt).not.toBeNull();
    expect(w.submissionAttempts).toBe(1);

    // Provider received the correct payout details.
    expect(provider.submittedPayouts).toHaveLength(1);
    const submitted = provider.submittedPayouts[0]!;
    expect(submitted.withdrawalId).toBe(sAccept.withdrawal.id);
    expect(submitted.amount).toBe(MINIMUM_WITHDRAWAL_AMOUNT);
    expect(submitted.accountHolderName).toBe("Submission Tester");
    // Discriminated union: narrow to bank_transfer before asserting bank fields.
    expect(submitted.method).toBe("bank_transfer");
    if (submitted.method === "bank_transfer") {
      expect(submitted.bankAccountNumber).toBe("98765432101");
      expect(submitted.bankIfscCode).toBe("ICIC0009876");
    }
    // Idempotency key is embedded in merchantReference.
    expect(submitted.merchantReference).toContain(sAccept.withdrawal.idempotencyKey);

    // No failure notification for an accepted submission.
    expect(notifyWithdrawalFailed).not.toHaveBeenCalled();
  });

  it("moves withdrawal to 'failed' and releases reservation when provider rejects", async () => {
    provider.nextSubmitResult = { outcome: "rejected", reason: "Invalid IFSC code" };
    await clearLease(sReject.withdrawal.id);

    const walletBefore = (await db
      .select()
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, sReject.winningAccountId)))[0]!;

    await submitPendingWithdrawals(provider);

    const w = (await db
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, sReject.withdrawal.id)))[0]!;
    expect(w.status).toBe("failed");
    expect(w.failureReason).toBe("Invalid IFSC code");
    expect(w.failedAt).not.toBeNull();
    expect(w.submissionAttempts).toBe(1);

    // Reservation released: reserved_balance decremented, balance unchanged.
    const walletAfter = (await db
      .select()
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, sReject.winningAccountId)))[0]!;
    expect(walletAfter.balance).toBe(walletBefore.balance);
    expect(walletAfter.reservedBalance).toBe(
      walletBefore.reservedBalance - MINIMUM_WITHDRAWAL_AMOUNT,
    );

    // Failure notification must fire (after transaction commits).
    expect(notifyWithdrawalFailed).toHaveBeenCalledOnce();
    expect(notifyWithdrawalFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        withdrawalId: sReject.withdrawal.id,
        reason: "Invalid IFSC code",
      }),
    );
  });

  it("permanently fails a withdrawal that has reached MAX_SUBMISSION_ATTEMPTS without attempting HTTP", async () => {
    // sMaxAttempts was pre-configured with submissionAttempts = MAX_SUBMISSION_ATTEMPTS.
    // Clear its lease now so the job picks it up (only this one withdrawal is unleased).
    await clearLease(sMaxAttempts.withdrawal.id);

    await submitPendingWithdrawals(provider);

    const w = (await db
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, sMaxAttempts.withdrawal.id)))[0]!;
    expect(w.status).toBe("failed");
    expect(w.failureReason).toContain(`${MAX_SUBMISSION_ATTEMPTS} attempts`);

    // No HTTP call was made — failed before Phase 2.
    expect(provider.submittedPayouts).toHaveLength(0);

    // Failure notification must fire after max-attempts failure.
    expect(notifyWithdrawalFailed).toHaveBeenCalledOnce();
    expect(notifyWithdrawalFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        withdrawalId: sMaxAttempts.withdrawal.id,
      }),
    );
  });

  it("leaves withdrawal in 'reserved' on a transient provider network error", async () => {
    // Replace submitPayout with a function that throws.
    provider.submitPayout = async () => {
      throw new Error("Connection refused");
    };
    await clearLease(sNetworkError.withdrawal.id);

    await submitPendingWithdrawals(provider);

    const w = (await db
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, sNetworkError.withdrawal.id)))[0]!;
    // Still reserved — transient error; will be retried on next job run.
    expect(w.status).toBe("reserved");
    // Attempt counter incremented (lease was acquired in Phase 1).
    expect(w.submissionAttempts).toBeGreaterThan(0);
    // Lease was set during Phase 1.
    expect(w.lastSubmissionAttemptAt).not.toBeNull();

    // No notification for a transient network error.
    expect(notifyWithdrawalFailed).not.toHaveBeenCalled();
  });

  it("does not double-process if a concurrent webhook moved the withdrawal to 'processing' between Phase 1 and Phase 3", async () => {
    // Intercept submitPayout: simulate a concurrent webhook by updating the
    // withdrawal to 'processing' DURING the (simulated) HTTP call.
    provider.submitPayout = async (input) => {
      await db
        .update(withdrawalsTable)
        .set({
          status: "processing",
          provider: "concurrent-webhook",
          providerReference: "REF_CONCURRENT",
          providerSubmittedAt: new Date(),
        })
        .where(eq(withdrawalsTable.id, input.withdrawalId));
      // Return an "accepted" result — but Phase 3 should detect the concurrent
      // status change and skip applying its own update.
      return { outcome: "accepted", providerReference: "REF_FROM_SUBMISSION" };
    };
    await clearLease(sPhase3Concurrent.withdrawal.id);

    await submitPendingWithdrawals(provider);

    // The concurrent webhook's state wins — the submission job's Phase 3
    // idempotency guard detects status !== 'reserved' and skips the update.
    const w = (await db
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, sPhase3Concurrent.withdrawal.id)))[0]!;
    expect(w.status).toBe("processing");
    expect(w.providerReference).toBe("REF_CONCURRENT");
    expect(w.provider).toBe("concurrent-webhook");

    // No spurious notification for the concurrent-webhook path.
    expect(notifyWithdrawalFailed).not.toHaveBeenCalled();
  });

  it("submits a UPI withdrawal with correct SubmitPayoutInput (method=upi, upiId set, no bank fields)", async () => {
    provider.nextSubmitResult = { outcome: "accepted", providerReference: "REF_UPI_001" };
    await clearLease(sUpi.withdrawal.id);

    await submitPendingWithdrawals(provider);

    const w = (await db
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, sUpi.withdrawal.id)))[0]!;
    expect(w.status).toBe("processing");
    expect(w.providerReference).toBe("REF_UPI_001");
    expect(w.snapshotPayoutMethod).toBe("upi");

    // Provider received a UPI-method SubmitPayoutInput.
    expect(provider.submittedPayouts).toHaveLength(1);
    const submitted = provider.submittedPayouts[0]!;
    expect(submitted.method).toBe("upi");
    expect(submitted.withdrawalId).toBe(sUpi.withdrawal.id);
    expect(submitted.amount).toBe(MINIMUM_WITHDRAWAL_AMOUNT);
    expect(submitted.accountHolderName).toBe("UPI Submission Tester");
    // UPI-specific field present.
    if (submitted.method === "upi") {
      expect(submitted.upiId).toBe("upisubmit@okhdfc");
    }
    // Bank-specific fields must NOT be present on the UPI input variant.
    expect((submitted as unknown as Record<string, unknown>)["bankAccountNumber"]).toBeUndefined();
    expect((submitted as unknown as Record<string, unknown>)["bankIfscCode"]).toBeUndefined();

    // No failure notification for an accepted UPI submission.
    expect(notifyWithdrawalFailed).not.toHaveBeenCalled();
  });

  it("is a no-op when all reservations are either leased or in terminal states", async () => {
    // At this point:
    //   sAccept          → 'processing'  (non-reserved)
    //   sReject          → 'failed'      (non-reserved)
    //   sMaxAttempts     → 'failed'      (non-reserved)
    //   sNetworkError    → 'reserved' but has a lease (set in Phase 1 of its test)
    //   sPhase3Concurrent→ 'processing'  (non-reserved)
    //   sUpi             → 'processing'  (non-reserved)
    // No unprocessed reservations without leases → job should do nothing.
    await submitPendingWithdrawals(provider);
    expect(provider.submittedPayouts).toHaveLength(0);
    expect(notifyWithdrawalFailed).not.toHaveBeenCalled();
  });
});
