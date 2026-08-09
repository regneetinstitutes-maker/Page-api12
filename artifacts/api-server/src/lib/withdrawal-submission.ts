/**
 * Withdrawal submission job.
 *
 * Picks up withdrawals in the `reserved` state and submits them to the payout
 * provider. This module is designed to run as a background job (e.g. every
 * 30 seconds via a scheduler). It can run on multiple workers concurrently
 * without double-submitting — the submission lease prevents that.
 *
 * ── Submission flow (per withdrawal) ─────────────────────────────────────────
 *
 *   Phase 1 (inside transaction):
 *     a) Lock withdrawal row FOR UPDATE.
 *     b) Re-check status === "reserved" (skip if already handled).
 *     c) Check submissionAttempts < MAX_SUBMISSION_ATTEMPTS.
 *        If at or over the limit → call failWithdrawal → COMMIT.
 *        Collect notification payload; fire AFTER the transaction commits.
 *     d) Increment submissionAttempts, set lastSubmissionAttemptAt = NOW().
 *     e) COMMIT (lock released before HTTP call).
 *
 *   Phase 2 (OUTSIDE any transaction):
 *     Build SubmitPayoutInput from snapshot columns (discriminated on method).
 *     Call provider.submitPayout(...).
 *     Network/HTTP errors → leave in `reserved`; job retries on next run.
 *
 *   Phase 3 (inside a new transaction):
 *     f) Lock withdrawal row again FOR UPDATE.
 *     g) Re-check status === "reserved" (a concurrent webhook may have changed it).
 *     h) accepted → status = "processing", store provider/providerReference.
 *        rejected → failWithdrawal.
 *        Collect notification payload; fire AFTER the transaction commits.
 *
 * ── Lease mechanism ───────────────────────────────────────────────────────────
 *
 *   `lastSubmissionAttemptAt` acts as a short-lived lease. The job query
 *   filters out rows where this is more recent than SUBMISSION_LEASE_DURATION_MS.
 *   This prevents two concurrent workers from double-submitting the same
 *   withdrawal during the HTTP round-trip (Phase 2).
 *
 *   If a worker crashes after Phase 1 but before Phase 3, the lease expires
 *   and the next job run picks up the withdrawal again.
 *
 * ── HTTP call placement ───────────────────────────────────────────────────────
 *
 *   provider.submitPayout is called in Phase 2, OUTSIDE any DB transaction.
 *   Holding a PostgreSQL row lock open during an HTTP call (which can take
 *   100 ms–5 s) exhausts the connection pool under load and blocks concurrent
 *   operations on the same wallet. The lease (Phase 1) prevents double-submission
 *   without requiring a held lock during the HTTP call.
 *
 * ── Payout method handling ────────────────────────────────────────────────────
 *
 *   The SubmitPayoutInput is a discriminated union on `method`. Phase 2 builds
 *   the correct variant from the withdrawal's snapshot columns:
 *     - snapshotPayoutMethod === 'bank_transfer' → uses snapshotBankAccountNumber
 *       and snapshotBankIfscCode (guaranteed non-null by service layer invariants).
 *     - snapshotPayoutMethod === 'upi' → uses snapshotUpiId (guaranteed non-null
 *       by service layer invariants).
 *
 * ── Notification placement ────────────────────────────────────────────────────
 *
 *   Notifications are NEVER fired inside a DB transaction. Each notification
 *   payload is collected into a local variable inside the transaction closure,
 *   then fired with `void` AFTER `db.transaction()` returns (i.e. after commit).
 *   This ensures a rolled-back transaction never sends a ghost notification.
 */

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, withdrawalsTable, type Withdrawal } from "@workspace/db";
import { logger } from "./logger";
import { notifyWithdrawalFailed } from "./notifications";
import { decryptBankAccountNumber } from "./bank-account-crypto";
import type { WithdrawalFailedPayload } from "./notifications";
import { failWithdrawal } from "./withdrawal-completion";
import type { PayoutProvider, SubmitPayoutInput, SubmitPayoutResult } from "./payout/provider";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of submission attempts before permanently failing a withdrawal.
 */
export const MAX_SUBMISSION_ATTEMPTS = 3;

/**
 * Duration of the submission lease in milliseconds (2 minutes).
 */
export const SUBMISSION_LEASE_DURATION_MS = 2 * 60 * 1000;

/**
 * Maximum number of withdrawals to process per job run.
 */
const BATCH_SIZE = 50;

// ── buildSubmitPayoutInput ────────────────────────────────────────────────────

/**
 * Constructs the method-appropriate SubmitPayoutInput from a withdrawal row's
 * snapshot columns. The discriminated union ensures the provider receives
 * exactly the fields it needs for the payout method.
 *
 * Invariant: the service layer guarantees that bank_transfer withdrawals have
 * non-null snapshotBankAccountNumber and snapshotBankIfscCode, and that UPI
 * withdrawals have a non-null snapshotUpiId. The non-null assertions here are
 * safe given those invariants.
 */
function buildSubmitPayoutInput(w: Withdrawal, idempotencyKey: string): SubmitPayoutInput {
  const common = {
    withdrawalId: w.id,
    merchantReference: `withdrawal:${idempotencyKey}:submit`,
    amount: w.amount,
    accountHolderName: w.snapshotAccountHolderName,
  };

  if (w.snapshotPayoutMethod === "bank_transfer") {
    return {
      ...common,
      method: "bank_transfer",
      // Non-null assertion is safe: service layer guarantees these fields are set
      // for bank_transfer withdrawals at initiation time.
      bankAccountNumber: decryptBankAccountNumber(w.snapshotBankAccountNumber!),
      bankIfscCode: w.snapshotBankIfscCode!,
    };
  }

  // method === "upi"
  return {
    ...common,
    method: "upi",
    // Non-null assertion is safe: service layer guarantees snapshotUpiId is set
    // for UPI withdrawals at initiation time.
    upiId: w.snapshotUpiId!,
  };
}

// ── submitOneWithdrawal ───────────────────────────────────────────────────────

/**
 * Submits a single withdrawal to the payout provider, following the three-phase
 * lease-then-submit-then-update pattern described in the module JSDoc.
 *
 * @internal  Called only by submitPendingWithdrawals.
 */
async function submitOneWithdrawal(
  withdrawalId: string,
  idempotencyKey: string,
  provider: PayoutProvider,
): Promise<void> {
  // ── Phase 1: Acquire lease (inside transaction) ───────────────────────────
  let readyForSubmission: Withdrawal | null = null;

  // Notification payload collected inside the transaction; fired AFTER commit.
  let phase1FailedPayload: WithdrawalFailedPayload | null = null;

  await db.transaction(async (tx) => {
    const [w] = await tx
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, withdrawalId))
      .for("update");

    if (!w) {
      logger.warn({ withdrawalId }, "Submission: withdrawal not found; skipping.");
      return;
    }

    // Re-check status: a concurrent webhook may have already moved this past reserved.
    if (w.status !== "reserved") {
      logger.info(
        { withdrawalId, status: w.status },
        "Submission: withdrawal is no longer reserved; skipping.",
      );
      return;
    }

    // Max-attempts guard: permanently fail the withdrawal before wasting an HTTP call.
    if (w.submissionAttempts >= MAX_SUBMISSION_ATTEMPTS) {
      const reason = `Payout submission failed after ${MAX_SUBMISSION_ATTEMPTS} attempts. Manual investigation required.`;
      logger.error(
        { withdrawalId, attempts: w.submissionAttempts },
        `Submission: max attempts reached (${MAX_SUBMISSION_ATTEMPTS}); permanently failing withdrawal.`,
      );
      const failed = await failWithdrawal(tx, w, reason);
      // Collect payload — notification fires AFTER this transaction commits (below).
      phase1FailedPayload = {
        userId: failed.userId,
        withdrawalId: failed.id,
        amount: failed.amount,
        reason: failed.failureReason ?? null,
      };
      return;
    }

    // Acquire the lease: increment attempt counter + set the timestamp.
    const [updated] = await tx
      .update(withdrawalsTable)
      .set({
        submissionAttempts: sql`${withdrawalsTable.submissionAttempts} + 1`,
        lastSubmissionAttemptAt: new Date(),
      })
      .where(eq(withdrawalsTable.id, withdrawalId))
      .returning();

    readyForSubmission = updated ?? null;
  });

  // ── Post-Phase-1 notification (after transaction committed) ───────────────
  if (phase1FailedPayload) {
    void notifyWithdrawalFailed(phase1FailedPayload);
    return;
  }

  if (!readyForSubmission) {
    // Either already handled (wrong status / max attempts) or not found.
    return;
  }

  const w = readyForSubmission as Withdrawal;

  // ── Phase 2: Submit to provider (OUTSIDE any transaction) ─────────────────
  // Build the method-appropriate SubmitPayoutInput from the withdrawal snapshot.
  const submitInput = buildSubmitPayoutInput(w, idempotencyKey);

  let submitResult: SubmitPayoutResult;
  try {
    submitResult = await provider.submitPayout(submitInput);
  } catch (err) {
    // Transient network/HTTP error. Leave the withdrawal in `reserved`.
    // The lease will expire and the next job run will retry (if under max attempts).
    logger.warn(
      {
        withdrawalId: w.id,
        method: w.snapshotPayoutMethod,
        attempt: w.submissionAttempts,
        err: err instanceof Error ? err.message : String(err),
      },
      "Submission: network error communicating with payout provider; will retry.",
    );
    return;
  }

  // ── Phase 3: Apply outcome (inside a new transaction) ─────────────────────
  // Notification payload collected inside the transaction; fired AFTER commit.
  let phase3FailedPayload: WithdrawalFailedPayload | null = null;

  await db.transaction(async (tx) => {
    const [fresh] = await tx
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, w.id))
      .for("update");

    if (!fresh) {
      logger.warn({ withdrawalId: w.id }, "Submission Phase 3: withdrawal not found.");
      return;
    }

    // Idempotency guard: a concurrent webhook may have already processed this.
    if (fresh.status !== "reserved") {
      logger.info(
        { withdrawalId: w.id, status: fresh.status },
        "Submission Phase 3: withdrawal already handled by a concurrent process; skipping.",
      );
      return;
    }

    if (submitResult.outcome === "accepted") {
      await tx
        .update(withdrawalsTable)
        .set({
          status: "processing",
          provider: provider.name,
          providerReference: submitResult.providerReference,
          providerSubmittedAt: new Date(),
        })
        .where(eq(withdrawalsTable.id, w.id));

      logger.info(
        { withdrawalId: w.id, providerReference: submitResult.providerReference, method: w.snapshotPayoutMethod },
        "Submission: accepted by provider; withdrawal now processing.",
      );
    } else {
      // Provider rejected the transfer (non-retriable: bad account details,
      // invalid VPA, etc.)
      const reason = submitResult.reason;
      const failed = await failWithdrawal(tx, fresh, reason);

      logger.info(
        { withdrawalId: w.id, reason, method: w.snapshotPayoutMethod },
        "Submission: rejected by provider; withdrawal failed, reservation released.",
      );

      // Collect payload — notification fires AFTER this transaction commits (below).
      phase3FailedPayload = {
        userId: failed.userId,
        withdrawalId: failed.id,
        amount: failed.amount,
        reason: failed.failureReason ?? null,
      };
    }
  });

  // ── Post-Phase-3 notification (after transaction committed) ───────────────
  if (phase3FailedPayload) {
    void notifyWithdrawalFailed(phase3FailedPayload);
  }
}

// ── submitPendingWithdrawals ──────────────────────────────────────────────────

/**
 * Finds all `reserved` withdrawals whose submission lease has expired (or was
 * never set) and submits them to the payout provider, one at a time.
 *
 * Designed to be called by a scheduler (e.g. every 30 seconds). Safe to run
 * on multiple workers concurrently — the lease prevents double-submission.
 *
 * Errors from individual submissions are caught and logged; a failure on one
 * withdrawal does not prevent processing of the rest.
 *
 * @param provider — the resolved `PayoutProvider` instance.
 */
export async function submitPendingWithdrawals(provider: PayoutProvider): Promise<void> {
  const leaseCutoff = new Date(Date.now() - SUBMISSION_LEASE_DURATION_MS);

  // Find reserved withdrawals whose lease has expired or was never set.
  const pending = await db
    .select({
      id: withdrawalsTable.id,
      idempotencyKey: withdrawalsTable.idempotencyKey,
    })
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.status, "reserved"),
        or(
          isNull(withdrawalsTable.lastSubmissionAttemptAt),
          lt(withdrawalsTable.lastSubmissionAttemptAt, leaseCutoff),
        ),
      ),
    )
    .orderBy(withdrawalsTable.createdAt)
    .limit(BATCH_SIZE);

  if (pending.length === 0) {
    return;
  }

  logger.info({ count: pending.length }, "Submission job: processing reserved withdrawals.");

  for (const { id, idempotencyKey } of pending) {
    try {
      await submitOneWithdrawal(id, idempotencyKey, provider);
    } catch (err) {
      // Catch unexpected errors so one bad withdrawal does not halt the batch.
      logger.error(
        {
          withdrawalId: id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Submission job: unexpected error processing withdrawal; continuing with next.",
      );
    }
  }
}
