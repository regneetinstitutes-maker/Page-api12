/**
 * Operational health monitoring for the withdrawal module.
 *
 * Provides three checks:
 *
 *   1. checkReservedBalanceDrift — detects wallets where `reserved_balance`
 *      has drifted away from the sum of active reservation amounts. Drift
 *      indicates a bug that bypassed the reservation service functions.
 *
 *   2. checkStuckReservedWithdrawals — alerts when withdrawals have been in
 *      `reserved` state for longer than the expected submission window. This
 *      is the primary signal that the submission scheduler is not running.
 *
 *   3. checkStuckProcessingWithdrawals — alerts on withdrawals stuck in
 *      `processing` beyond the 24-hour threshold. Duplicates the per-item
 *      alert in reconcileProcessingWithdrawals but provides an aggregate view.
 *
 * These checks are meant to run on a periodic schedule (e.g. every 10 minutes)
 * and emit structured log events that can be forwarded to an alerting system.
 *
 * All checks are read-only; they never modify database state.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import { db, walletAccountsTable, walletReservationsTable, withdrawalsTable } from "@workspace/db";
import { logger } from "./logger";

// ── Thresholds ────────────────────────────────────────────────────────────────

/**
 * A withdrawal sitting in `reserved` for longer than this is suspicious —
 * it means the submission scheduler may have stopped. Set to 2x the default
 * submission interval (30 s) plus a generous buffer for slow DB cycles.
 */
export const STUCK_RESERVED_THRESHOLD_MS = 5 * 60_000; // 5 minutes

/**
 * Processing withdrawals older than this generate individual alerts inside the
 * reconciliation job as well as an aggregate count here.
 */
export const STUCK_PROCESSING_THRESHOLD_MS = 24 * 60 * 60_000; // 24 hours

// ── Health check functions ────────────────────────────────────────────────────

/**
 * Compares each wallet's `reserved_balance` against the sum of its active
 * reservation amounts. Emits a structured error log for any wallet where
 * the two values diverge.
 *
 * A drift means the application bypassed the reservation service at some
 * point and directly mutated `reserved_balance`. This requires manual
 * investigation and a corrective SQL update.
 */
export async function checkReservedBalanceDrift(): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      wa.id            AS wallet_id,
      wa.user_id,
      wa.reserved_balance,
      COALESCE(SUM(wr.amount), 0) AS active_reservation_sum,
      wa.reserved_balance - COALESCE(SUM(wr.amount), 0) AS drift
    FROM ${walletAccountsTable} wa
    LEFT JOIN ${walletReservationsTable} wr
      ON wr.wallet_account_id = wa.id
      AND wr.status = 'active'
    GROUP BY wa.id, wa.user_id, wa.reserved_balance
    HAVING wa.reserved_balance != COALESCE(SUM(wr.amount), 0)
  `);

  if (result.rows.length > 0) {
    logger.error(
      {
        event: "health.reserved_balance_drift",
        count: result.rows.length,
        driftedWallets: result.rows,
      },
      `ALERT: ${result.rows.length} wallet(s) have reserved_balance drift — manual investigation required.`,
    );
  }
}

/**
 * Counts withdrawals that have been in `reserved` state for longer than
 * STUCK_RESERVED_THRESHOLD_MS. A non-zero count is the primary indicator
 * that the submission scheduler job has stopped running.
 */
export async function checkStuckReservedWithdrawals(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_RESERVED_THRESHOLD_MS);

  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.status, "reserved"),
        lt(withdrawalsTable.createdAt, cutoff),
      ),
    );

  const count = Number(row?.count ?? 0);

  if (count > 0) {
    logger.error(
      {
        event: "health.stuck_reserved_withdrawals",
        count,
        thresholdMinutes: STUCK_RESERVED_THRESHOLD_MS / 60_000,
      },
      `ALERT: ${count} withdrawal(s) stuck in 'reserved' for >${STUCK_RESERVED_THRESHOLD_MS / 60_000} minutes — submission scheduler may not be running.`,
    );
  }
}

/**
 * Counts withdrawals stuck in `processing` beyond the 24-hour threshold.
 * Provides an aggregate view to complement the per-withdrawal alerts emitted
 * by the reconciliation job.
 */
export async function checkStuckProcessingWithdrawals(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_MS);

  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.status, "processing"),
        lt(withdrawalsTable.providerSubmittedAt, cutoff),
      ),
    );

  const count = Number(row?.count ?? 0);

  if (count > 0) {
    logger.error(
      {
        event: "health.stuck_processing_withdrawals",
        count,
        thresholdHours: STUCK_PROCESSING_THRESHOLD_MS / 3_600_000,
      },
      `ALERT: ${count} withdrawal(s) stuck in 'processing' for >24 hours — reconciliation may need manual intervention.`,
    );
  }
}

/**
 * Runs all three health checks and logs a summary.
 * Errors from individual checks are caught so one failure does not prevent
 * the others from running.
 *
 * @param overrides — optional overrides for each check function, used in tests
 *   to inject mock implementations without relying on module-level spy patching.
 */
export async function runWithdrawalHealthChecks(overrides?: {
  drift?: () => Promise<void>;
  stuckReserved?: () => Promise<void>;
  stuckProcessing?: () => Promise<void>;
}): Promise<void> {
  const drift = overrides?.drift ?? checkReservedBalanceDrift;
  const stuckReserved = overrides?.stuckReserved ?? checkStuckReservedWithdrawals;
  const stuckProcessing = overrides?.stuckProcessing ?? checkStuckProcessingWithdrawals;

  logger.info("Health: running withdrawal health checks.");

  const results = await Promise.allSettled([
    drift(),
    stuckReserved(),
    stuckProcessing(),
  ]);

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    for (const failure of failures) {
      if (failure.status === "rejected") {
        logger.error(
          { err: failure.reason instanceof Error ? failure.reason.message : String(failure.reason) },
          "Health: a health check threw an unexpected error.",
        );
      }
    }
  }
}
