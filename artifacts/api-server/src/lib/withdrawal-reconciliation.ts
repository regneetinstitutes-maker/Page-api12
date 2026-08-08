/**
 * Withdrawal reconciliation job.
 *
 * Monitors withdrawals stuck in the `processing` state. For each:
 *
 *   1. Generates an operational alert if the withdrawal has been processing
 *      for more than PROCESSING_ALERT_THRESHOLD_MS (24 hours).
 *
 *   2. Calls provider.verifyPayout to get the current status from the
 *      payout provider.
 *
 *   3. If the provider has a final result:
 *        success → completeWithdrawal (debit balance, mark completed)
 *                  Store the verified providerReference in webhookTransferId.
 *        failure → failWithdrawal (release reservation, mark failed)
 *                  Store the verified providerReference in webhookTransferId.
 *
 *   4. If the provider still reports `pending`, leaves the withdrawal in
 *      `processing` and continues. The 24h alert fires on the next run.
 *
 * ── Why reconciliation is needed ─────────────────────────────────────────────
 *
 *   The normal path is: PayU webhook → completeWithdrawal / failWithdrawal.
 *   But webhooks can be missed (network partition, misconfigured URL). The
 *   reconciliation job is the safety net that resolves stuck withdrawals by
 *   polling the provider's verify API.
 *
 * ── HTTP call placement ───────────────────────────────────────────────────────
 *
 *   provider.verifyPayout is called OUTSIDE any DB transaction, for the same
 *   reason as submitPayout in withdrawal-submission.ts: holding a row lock
 *   during an HTTP call exhausts the connection pool under load.
 *
 *   After the HTTP call returns, the withdrawal row is locked again inside a
 *   new transaction. The status is re-checked (idempotency guard) so any
 *   concurrent webhook that arrived during the verify call is handled correctly.
 *
 * ── Notification placement ────────────────────────────────────────────────────
 *
 *   Notifications are NEVER fired inside a DB transaction. Each notification
 *   payload is collected into a local variable inside the transaction closure,
 *   then fired with `void` AFTER `db.transaction()` returns (i.e. after commit).
 *   This ensures a rolled-back transaction never sends a ghost notification.
 *   The pattern matches the one used in routes/payments.ts.
 *
 * ── Provider filtering ────────────────────────────────────────────────────────
 *
 *   The reconciliation batch query filters by `provider = provider.name`.
 *   This ensures that when multiple payout providers are registered, each
 *   reconciliation run only verifies withdrawals submitted via that specific
 *   provider. The scheduler calls this function once per registered provider.
 *
 * ── Architecture (mirrors deposit reconciliation) ─────────────────────────────
 *
 *   webhook path:        route handler → completeWithdrawal ─┐
 *                        route handler → failWithdrawal       ┤ shared service
 *                                                             │
 *   reconciliation path: reconcileProcessingWithdrawals       │
 *                          → verifyPayout (HTTP, outside tx)  │
 *                          → completeWithdrawal ──────────────┘
 *                          → failWithdrawal ─────────────────┘
 */

import { and, eq, lt } from "drizzle-orm";
import { db, withdrawalsTable } from "@workspace/db";
import { logger } from "./logger";
import { notifyWithdrawalCompleted, notifyWithdrawalFailed } from "./notifications";
import type { WithdrawalCompletedPayload, WithdrawalFailedPayload } from "./notifications";
import { completeWithdrawal, failWithdrawal } from "./withdrawal-completion";
import type { PayoutProvider, VerifyPayoutResult } from "./payout/provider";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Threshold after which a `processing` withdrawal triggers an operational alert.
 * Set to 24 hours. The alert is a signal for manual investigation — the payout
 * may have settled at the bank without a webhook, or the provider may be having
 * an outage.
 */
export const PROCESSING_ALERT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Maximum withdrawals to process per reconciliation run. */
const BATCH_SIZE = 50;

// ── Result type ───────────────────────────────────────────────────────────────

/**
 * The outcome of reconciling a single processing withdrawal.
 *
 * "completed"       — provider confirmed success; balance debited, completed.
 * "failed"          — provider reported failure; reservation released, failed.
 * "still_processing"— provider still pending; no DB change, will retry later.
 * "already_terminal"— withdrawal was already in a terminal state when locked;
 *                     a concurrent webhook beat the reconciliation job.
 * "no_reference"    — withdrawal has no providerReference; cannot verify.
 *                     Requires manual investigation.
 */
export type ReconcileWithdrawalResult =
  | "completed"
  | "failed"
  | "still_processing"
  | "already_terminal"
  | "no_reference";

// ── reconcileOneWithdrawal ────────────────────────────────────────────────────

/**
 * Reconciles a single `processing` withdrawal.
 *
 * @internal  Called only by reconcileProcessingWithdrawals.
 */
async function reconcileOneWithdrawal(
  withdrawalId: string,
  providerReference: string,
  provider: PayoutProvider,
): Promise<ReconcileWithdrawalResult> {
  // ── Step 1: Verify with provider (OUTSIDE any transaction) ────────────────
  let verifyResult: VerifyPayoutResult;
  try {
    verifyResult = await provider.verifyPayout(providerReference, withdrawalId);
  } catch (err) {
    logger.warn(
      {
        withdrawalId,
        providerReference,
        err: err instanceof Error ? err.message : String(err),
      },
      "Reconciliation: verifyPayout network error; skipping this withdrawal.",
    );
    throw err; // caller logs and continues with next withdrawal
  }

  if (verifyResult.outcome === "pending") {
    return "still_processing";
  }

  // ── Step 2: Apply final outcome (inside a new transaction) ────────────────
  // Notification payloads collected inside the transaction; fired AFTER commit.
  let completedPayload: WithdrawalCompletedPayload | null = null;
  let failedPayload: WithdrawalFailedPayload | null = null;

  const result = await db.transaction(async (tx) => {
    // Lock the withdrawal row. Re-check status — a concurrent webhook may have
    // already resolved this withdrawal between Step 1 and Step 2.
    const [withdrawal] = await tx
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, withdrawalId))
      .for("update");

    if (!withdrawal) {
      logger.warn({ withdrawalId }, "Reconciliation: withdrawal not found when locking.");
      return "already_terminal" as ReconcileWithdrawalResult;
    }

    if (withdrawal.status !== "processing") {
      logger.info(
        { withdrawalId, status: withdrawal.status },
        "Reconciliation: withdrawal already in terminal state (handled by concurrent webhook).",
      );
      return "already_terminal" as ReconcileWithdrawalResult;
    }

    if (verifyResult.outcome === "success") {
      // Store the provider's settle reference for the audit trail.
      // This is the transfer ID returned by verifyPayout — may match
      // providerReference (set at submission) or be a settlement-specific ID.
      await tx
        .update(withdrawalsTable)
        .set({ webhookTransferId: verifyResult.providerReference })
        .where(eq(withdrawalsTable.id, withdrawalId));

      const completed = await completeWithdrawal(tx, withdrawal);
      logger.info(
        { withdrawalId, providerReference },
        "Reconciliation: withdrawal completed successfully.",
      );
      // Collect payload — notification fires AFTER this transaction commits (below).
      completedPayload = {
        userId: completed.userId,
        withdrawalId: completed.id,
        amount: completed.amount,
      };
      return "completed" as ReconcileWithdrawalResult;
    }

    // verifyResult.outcome === "failure"
    const reason = verifyResult.reason;

    // Store the provider reference for the audit trail even on failure.
    await tx
      .update(withdrawalsTable)
      .set({ webhookTransferId: providerReference })
      .where(eq(withdrawalsTable.id, withdrawalId));

    const failed = await failWithdrawal(tx, withdrawal, reason);
    logger.info(
      { withdrawalId, providerReference, reason },
      "Reconciliation: withdrawal failed; reservation released.",
    );
    // Collect payload — notification fires AFTER this transaction commits (below).
    failedPayload = {
      userId: failed.userId,
      withdrawalId: failed.id,
      amount: failed.amount,
      reason: failed.failureReason ?? null,
    };
    return "failed" as ReconcileWithdrawalResult;
  });

  // ── Post-transaction notifications (after commit) ─────────────────────────
  if (completedPayload) {
    void notifyWithdrawalCompleted(completedPayload);
  }
  if (failedPayload) {
    void notifyWithdrawalFailed(failedPayload);
  }

  return result;
}

// ── reconcileProcessingWithdrawals ────────────────────────────────────────────

/**
 * Finds all withdrawals currently in `processing` for the specified provider,
 * generates 24h operational alerts for any that have been stuck, and verifies
 * each one with the provider.
 *
 * The batch query is filtered by `provider.name` so that when multiple payout
 * providers are active, each invocation only reconciles its own withdrawals.
 * The scheduler should call this once per registered provider.
 *
 * Designed to be called by a scheduler (e.g. every 5 minutes). Safe to run
 * concurrently — each withdrawal is locked individually.
 *
 * Errors from individual withdrawals are caught and logged; a failure on one
 * withdrawal does not prevent processing of the rest.
 *
 * @param provider — the resolved `PayoutProvider` instance.
 */
export async function reconcileProcessingWithdrawals(provider: PayoutProvider): Promise<void> {
  const alertCutoff = new Date(Date.now() - PROCESSING_ALERT_THRESHOLD_MS);

  // Find all processing withdrawals for this specific provider (ordered oldest
  // first so the most urgent ones are checked first).
  const processing = await db
    .select({
      id: withdrawalsTable.id,
      providerReference: withdrawalsTable.providerReference,
      providerSubmittedAt: withdrawalsTable.providerSubmittedAt,
      userId: withdrawalsTable.userId,
    })
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.status, "processing"),
        eq(withdrawalsTable.provider, provider.name),
      ),
    )
    .orderBy(withdrawalsTable.createdAt)
    .limit(BATCH_SIZE);

  if (processing.length === 0) {
    return;
  }

  logger.info(
    { count: processing.length, provider: provider.name },
    "Reconciliation job: checking processing withdrawals.",
  );

  for (const row of processing) {
    // ── Operational alert for withdrawals stuck >24h ───────────────────────
    if (row.providerSubmittedAt && row.providerSubmittedAt < alertCutoff) {
      const hoursStuck = Math.round(
        (Date.now() - row.providerSubmittedAt.getTime()) / 3_600_000,
      );
      logger.error(
        {
          event: "withdrawal.processing.stuck_alert",
          withdrawalId: row.id,
          userId: row.userId,
          providerReference: row.providerReference,
          providerSubmittedAt: row.providerSubmittedAt,
          hoursStuck,
          provider: provider.name,
        },
        `ALERT: Withdrawal has been in 'processing' for ${hoursStuck} hour(s) — manual investigation required.`,
      );
    }

    if (!row.providerReference) {
      logger.warn(
        { withdrawalId: row.id },
        "Reconciliation: processing withdrawal has no providerReference; cannot verify. Manual investigation required.",
      );
      continue;
    }

    try {
      const result = await reconcileOneWithdrawal(row.id, row.providerReference, provider);

      if (result !== "still_processing") {
        logger.info(
          { withdrawalId: row.id, result },
          "Reconciliation: withdrawal resolved.",
        );
      }
    } catch (err) {
      // Error already logged inside reconcileOneWithdrawal. Continue with next.
      logger.error(
        {
          withdrawalId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Reconciliation: unexpected error; skipping this withdrawal.",
      );
    }
  }
}
