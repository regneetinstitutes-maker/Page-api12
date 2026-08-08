/**
 * Deposit reconciliation batch runner.
 *
 * Monitors deposits stuck in the `pending` state.  For each deposit that has
 * been pending longer than PENDING_STALENESS_THRESHOLD_MS:
 *
 *   1. Generates an operational alert if the deposit has been pending for more
 *      than PENDING_ALERT_THRESHOLD_MS (2 hours).
 *
 *   2. Calls reconcileDeposit to query the PayU Verify API and apply the
 *      final outcome (success / failure / still pending).
 *
 * ── Why reconciliation is needed ─────────────────────────────────────────────
 *
 *   The normal path is: PayU webhook → processPayUSuccess / processPayUFailure.
 *   But webhooks can be missed (network partition, misconfigured URL, provider
 *   outage).  The reconciliation job is the safety net that resolves stuck
 *   deposits by polling the PayU Verify API.
 *
 * ── Staleness threshold ───────────────────────────────────────────────────────
 *
 *   Only deposits older than PENDING_STALENESS_THRESHOLD_MS (15 minutes) are
 *   reconciled.  Brand-new pending deposits are excluded because PayU typically
 *   delivers the webhook within seconds; reconciling them immediately would
 *   waste Verify API calls and produce spurious "still_pending" results.
 *
 * ── HTTP call placement ───────────────────────────────────────────────────────
 *
 *   reconcileDeposit calls the PayU Verify API OUTSIDE any DB transaction,
 *   for the same reason as the withdrawal path: holding a row lock during an
 *   HTTP call exhausts the connection pool under load.
 *
 *   After the HTTP call returns, reconcileDeposit re-acquires a FOR UPDATE
 *   lock inside a new transaction and re-checks status so that any concurrent
 *   webhook that arrived during the verify call is handled correctly.
 *
 * ── Architecture (mirrors withdrawal reconciliation) ──────────────────────────
 *
 *   webhook path:        route handler → completeSuccessfulDeposit ─┐
 *                        route handler → completeFailedDeposit       ┤ shared service
 *                                                                     │
 *   reconciliation path: reconcilePendingDeposits (this file)         │
 *                          → reconcileDeposit                         │
 *                            → callPayUVerify (HTTP, outside tx)      │
 *                            → completeSuccessfulDeposit ─────────────┘
 *                            → completeFailedDeposit ────────────────┘
 */

import { and, eq, lt } from "drizzle-orm";
import { db, depositsTable } from "@workspace/db";
import { logger } from "./logger";
import { reconcileDeposit } from "./reconciliation";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum age of a pending deposit before the reconciliation job attempts to
 * verify it with PayU.  Deposits created more recently than this are skipped.
 *
 * Set to 15 minutes.  PayU webhooks typically arrive within seconds; this
 * threshold avoids wasting Verify API calls on deposits that simply haven't
 * received their webhook yet.
 */
export const PENDING_STALENESS_THRESHOLD_MS = 15 * 60_000;

/**
 * Threshold after which a pending deposit triggers an operational alert.
 * Set to 2 hours.  A deposit stuck pending this long requires investigation —
 * the webhook may never arrive, or PayU may be experiencing an outage.
 */
export const PENDING_ALERT_THRESHOLD_MS = 2 * 60 * 60_000;

/** Maximum deposits to process per reconciliation run. */
const BATCH_SIZE = 50;

// ── reconcilePendingDeposits ──────────────────────────────────────────────────

/**
 * Finds all deposits that have been `pending` beyond the staleness threshold,
 * generates operational alerts for any stuck beyond the alert threshold, and
 * reconciles each one against the PayU Verify API.
 *
 * Designed to be called by a scheduler (e.g. every 5 minutes).  Safe to run
 * concurrently — each deposit is locked individually inside reconcileDeposit.
 *
 * Errors from individual deposits are caught and logged; a failure on one
 * deposit does not prevent processing of the rest.
 */
export async function reconcilePendingDeposits(): Promise<void> {
  const stalenessCutoff = new Date(Date.now() - PENDING_STALENESS_THRESHOLD_MS);
  const alertCutoff = new Date(Date.now() - PENDING_ALERT_THRESHOLD_MS);

  // Find stale pending deposits, oldest first so the most overdue are checked
  // first.
  const stale = await db
    .select({
      id: depositsTable.id,
      merchantOrderId: depositsTable.merchantOrderId,
      createdAt: depositsTable.createdAt,
      userId: depositsTable.userId,
    })
    .from(depositsTable)
    .where(
      and(
        eq(depositsTable.status, "pending"),
        lt(depositsTable.createdAt, stalenessCutoff),
      ),
    )
    .orderBy(depositsTable.createdAt)
    .limit(BATCH_SIZE);

  if (stale.length === 0) {
    return;
  }

  logger.info(
    { count: stale.length },
    "Deposit reconciliation job: checking stale pending deposits.",
  );

  for (const row of stale) {
    // ── Operational alert for deposits stuck beyond the alert threshold ────
    if (row.createdAt < alertCutoff) {
      const minutesStuck = Math.round(
        (Date.now() - row.createdAt.getTime()) / 60_000,
      );
      logger.error(
        {
          event: "deposit.pending.stuck_alert",
          depositId: row.id,
          userId: row.userId,
          merchantOrderId: row.merchantOrderId,
          createdAt: row.createdAt,
          minutesStuck,
        },
        `ALERT: Deposit has been in 'pending' for ${minutesStuck} minute(s) — manual investigation required.`,
      );
    }

    try {
      const result = await reconcileDeposit(row.merchantOrderId);

      if (result !== "still_pending" && result !== "already_processed") {
        logger.info(
          { depositId: row.id, merchantOrderId: row.merchantOrderId, result },
          "Deposit reconciliation job: deposit resolved.",
        );
      }
    } catch (err) {
      // Error already logged inside reconcileDeposit.  Continue with next.
      logger.error(
        {
          depositId: row.id,
          merchantOrderId: row.merchantOrderId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Deposit reconciliation job: unexpected error; skipping this deposit.",
      );
    }
  }
}
