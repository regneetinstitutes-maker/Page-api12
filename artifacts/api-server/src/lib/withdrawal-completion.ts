/**
 * Shared withdrawal-completion service.
 *
 * ── Responsibility boundary ───────────────────────────────────────────────────
 *
 *   This module owns the two terminal-state transitions for a withdrawal:
 *
 *     completeWithdrawal — confirms reservation, debits balance, marks completed.
 *     failWithdrawal     — releases reservation, marks failed. Funds returned.
 *
 * ── Why shared? ───────────────────────────────────────────────────────────────
 *
 *   Both transitions are called from two places:
 *
 *     1. Payout webhook handler (routes/payments.ts)
 *        Called when PayU POSTs a success/failure callback.
 *
 *     2. Withdrawal reconciliation job (lib/withdrawal-reconciliation.ts)
 *        Called when the scheduler polls `verifyPayout` for withdrawals
 *        stuck in `processing`.
 *
 *   Sharing the logic eliminates duplicate wallet-debit/release code and
 *   ensures both paths apply the same idempotency keys, lock ordering, and
 *   constraint-safe operation order.
 *
 * ── Contract for callers ──────────────────────────────────────────────────────
 *
 *   Both functions must be called INSIDE an existing DB transaction, after
 *   the caller has already:
 *
 *     a) Acquired a `SELECT … FOR UPDATE` lock on the withdrawal row.
 *     b) Verified the withdrawal's current status (idempotency guard).
 *
 *   The functions do NOT open a new transaction; they enlist in the caller's
 *   transaction so every mutation is committed or rolled back atomically.
 *
 * ── Lock order ────────────────────────────────────────────────────────────────
 *
 *   Consistent with withdrawal.ts and reservation.ts across all mutations:
 *
 *     1. withdrawal row   (FOR UPDATE — caller's responsibility)
 *     2. wallet account   (FOR UPDATE — inside confirmReservation / releaseReservation)
 *     3. reservation row  (FOR UPDATE — inside confirmReservation / releaseReservation)
 *
 * ── Notifications ─────────────────────────────────────────────────────────────
 *
 *   Callers are responsible for firing notifyWithdrawalCompleted /
 *   notifyWithdrawalFailed AFTER the transaction commits (fire-and-forget).
 *   Notification delivery must NEVER run inside the DB transaction.
 */

import { eq } from "drizzle-orm";
import { db, withdrawalsTable, type Withdrawal } from "@workspace/db";
import { confirmReservation, releaseReservation } from "./reservation";

type DbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

function assertIsTransaction(executor: DbExecutor, fnName: string): void {
  if (executor === (db as unknown)) {
    throw new Error(
      `${fnName}() must be called inside a db.transaction() context. ` +
        `Calling it with the bare 'db' makes its operations non-atomic.`,
    );
  }
}

// ── completeWithdrawal ────────────────────────────────────────────────────────

/**
 * Finalises a successful withdrawal inside the caller's transaction.
 *
 * Steps (all within the caller-supplied `tx`):
 *  1. Confirms the reservation — decrements `reserved_balance`, debits
 *     `balance`, writes an immutable ledger entry.
 *  2. Updates the withdrawal row: status → "completed", `completedAt`.
 *
 * Operation order in step 1 is critical (see confirmReservation):
 *   reserved_balance decremented BEFORE balance is debited, so the DB
 *   `balance >= reserved_balance` CHECK constraint is never violated
 *   at statement level during the transaction.
 *
 * Idempotency key for the ledger entry: `withdrawal:<withdrawal.id>:complete`
 * A retry that re-enters this function with the same withdrawal ID will find
 * the existing ledger entry and return without double-debiting.
 *
 * Caller must have already:
 *  - Locked the withdrawal row with SELECT … FOR UPDATE.
 *  - Verified `withdrawal.status === "processing"` (idempotency guard).
 */
export async function completeWithdrawal(
  tx: DbExecutor,
  withdrawal: Withdrawal,
): Promise<Withdrawal> {
  assertIsTransaction(tx, "completeWithdrawal");

  // Step 1 — Confirm reservation: decrements reserved_balance, debits balance,
  // writes immutable ledger entry. Lock order: wallet → reservation.
  await confirmReservation(tx, {
    reservationId: withdrawal.reservationId,
    transactionIdempotencyKey: `withdrawal:${withdrawal.id}:complete`,
    referenceType: "withdrawal",
    referenceId: withdrawal.id,
    description: "Withdrawal payout completed",
  });

  // Step 2 — Mark withdrawal completed.
  const [completed] = await tx
    .update(withdrawalsTable)
    .set({
      status: "completed",
      completedAt: new Date(),
    })
    .where(eq(withdrawalsTable.id, withdrawal.id))
    .returning();

  if (!completed) {
    throw new Error(`Failed to update withdrawal ${withdrawal.id} to completed.`);
  }

  return completed;
}

// ── failWithdrawal ────────────────────────────────────────────────────────────

/**
 * Finalises a failed withdrawal inside the caller's transaction.
 *
 * Steps (all within the caller-supplied `tx`):
 *  1. Releases the reservation — decrements `reserved_balance`. No ledger
 *     entry is written; the user's settled balance was never changed.
 *  2. Updates the withdrawal row: status → "failed", `failedAt`,
 *     `failureReason`.
 *
 * Valid pre-failure states: "reserved" (submission rejected) or "processing"
 * (provider webhook / reconciliation failure).
 *
 * Caller must have already:
 *  - Locked the withdrawal row with SELECT … FOR UPDATE.
 *  - Verified the withdrawal is in a pre-failure state.
 *
 * After this function returns and the transaction commits, callers MUST
 * fire-and-forget `notifyWithdrawalFailed` OUTSIDE the transaction.
 */
export async function failWithdrawal(
  tx: DbExecutor,
  withdrawal: Withdrawal,
  reason: string | null,
): Promise<Withdrawal> {
  assertIsTransaction(tx, "failWithdrawal");

  // Step 1 — Release reservation: decrements reserved_balance, no balance
  // change. Lock order inside releaseReservation: wallet → reservation.
  await releaseReservation(tx, withdrawal.reservationId);

  // Step 2 — Mark withdrawal failed.
  const [failed] = await tx
    .update(withdrawalsTable)
    .set({
      status: "failed",
      failedAt: new Date(),
      failureReason: reason ?? null,
    })
    .where(eq(withdrawalsTable.id, withdrawal.id))
    .returning();

  if (!failed) {
    throw new Error(`Failed to update withdrawal ${withdrawal.id} to failed.`);
  }

  return failed;
}
