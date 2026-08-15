/**
 * Background job scheduler for payment processing.
 *
 * Runs the periodic jobs that remain enabled for the PayU customer payment
 * flow:
 *
 *   1. runWithdrawalHealthChecks — monitors for reserved_balance drift and
 *      stuck withdrawals. Default: every 10 minutes.
 *
 *   2. reconcilePendingDeposits — polls PayU for `pending` deposits that have
 *      been waiting longer than the staleness threshold (15 minutes) without
 *      receiving a webhook callback. Default: every 5 minutes.
 *
 *   3. runCompetitionScheduler — keeps competition lifecycle state current.
 *
 * ── Configuration ──────────────────────────────────────────────────────────
 *
 *   SUBMISSION_JOB_INTERVAL_MS            — override submission interval (ms)
 *   RECONCILIATION_JOB_INTERVAL_MS        — override withdrawal reconciliation interval (ms)
 *   HEALTH_CHECK_INTERVAL_MS              — override health check interval (ms)
 *   DEPOSIT_RECONCILIATION_JOB_INTERVAL_MS — override deposit reconciliation interval (ms)
 *
 * ── Test safety ────────────────────────────────────────────────────────────
 *
 *   startScheduler() returns null when NODE_ENV === 'test'. This prevents
 *   timer leaks in the test suite (tests import from app.ts, not index.ts,
 *   but the guard makes the contract explicit and future-proof).
 *
 *   Use createScheduler() directly in tests to exercise scheduler behaviour
 *   with a mock provider and fake timers.
 *
 * ── Graceful shutdown ──────────────────────────────────────────────────────
 *
 *   Call scheduler.stop() on SIGTERM / SIGINT. All timers use .unref() so
 *   they do not prevent the process from exiting if stop() is not called.
 */

import { logger } from "./logger";
import { runWithdrawalHealthChecks } from "./health";
import { reconcilePendingDeposits } from "./deposit-reconciliation";
import { runCompetitionScheduler } from "./competition";
import { withDatabaseAdvisoryLock } from "./db-lock";

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10 * 60_000;            // 10 minutes
const DEFAULT_DEPOSIT_RECONCILIATION_INTERVAL_MS = 5 * 60_000;   // 5 minutes
const DEFAULT_COMPETITION_INTERVAL_MS = 30_000;                  // 30 seconds

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  provider?: unknown;
  submissionIntervalMs?: number;
  reconciliationIntervalMs?: number;
  healthCheckIntervalMs?: number;
  depositReconciliationIntervalMs?: number;
  competitionIntervalMs?: number;
}

export interface SchedulerHandles {
  stop(): void;
}

// ── createScheduler ───────────────────────────────────────────────────────────

/**
 * Creates and starts the background job timers.
 *
 * This function is intentionally separate from `startScheduler` so tests can
 * call it directly with a mock provider and vitest fake timers, without
 * triggering the NODE_ENV guard.
 */
export function createScheduler(options: SchedulerOptions): SchedulerHandles {
  const {
    submissionIntervalMs: _submissionIntervalMs,
    reconciliationIntervalMs: _reconciliationIntervalMs,
    healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    depositReconciliationIntervalMs = DEFAULT_DEPOSIT_RECONCILIATION_INTERVAL_MS,
    competitionIntervalMs = DEFAULT_COMPETITION_INTERVAL_MS,
  } = options;

  logger.info(
    {
      healthCheckIntervalMs,
      depositReconciliationIntervalMs,
      competitionIntervalMs,
    },
    "Scheduler: background jobs starting.",
  );

  const healthTimer = setInterval(async () => {
    logger.debug("Scheduler: running health checks.");
    try {
      await withDatabaseAdvisoryLock("withdrawal-health", () => runWithdrawalHealthChecks());
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Scheduler: unexpected error in health check job.",
      );
    }
  }, healthCheckIntervalMs);

  const depositReconciliationTimer = setInterval(async () => {
    logger.debug("Scheduler: running deposit reconciliation job.");
    try {
      await withDatabaseAdvisoryLock("deposit-reconciliation", () => reconcilePendingDeposits());
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Scheduler: unexpected error in deposit reconciliation job.",
      );
    }
  }, depositReconciliationIntervalMs);

  const competitionTimer = setInterval(async () => {
    logger.debug("Scheduler: running competition lifecycle job.");
    try {
      await withDatabaseAdvisoryLock("competition-lifecycle", () => runCompetitionScheduler());
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Scheduler: unexpected error in competition lifecycle job.",
      );
    }
  }, competitionIntervalMs);

  // Allow the process to exit even if timers are still pending.
  healthTimer.unref();
  depositReconciliationTimer.unref();
  competitionTimer.unref();

  return {
    stop() {
      clearInterval(healthTimer);
      clearInterval(depositReconciliationTimer);
      clearInterval(competitionTimer);
      logger.info("Scheduler: background jobs stopped.");
    },
  };
}

// ── startScheduler ────────────────────────────────────────────────────────────

/**
 * Starts the non-payout background jobs that remain enabled for the customer
 * payment flow.
 *
 * Returns null when NODE_ENV === 'test' so that importing index.ts in tests
 * does not start real timers.
 */
export function startScheduler(): SchedulerHandles | null {
  if (process.env.NODE_ENV === "test") {
    logger.debug("Scheduler: disabled in test environment.");
    return null;
  }

  const healthCheckIntervalMs =
    Number(process.env["HEALTH_CHECK_INTERVAL_MS"]) || DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  const depositReconciliationIntervalMs =
    Number(process.env["DEPOSIT_RECONCILIATION_JOB_INTERVAL_MS"]) ||
    DEFAULT_DEPOSIT_RECONCILIATION_INTERVAL_MS;
  const competitionIntervalMs =
    Number(process.env["COMPETITION_JOB_INTERVAL_MS"]) || DEFAULT_COMPETITION_INTERVAL_MS;

  return createScheduler({
    healthCheckIntervalMs,
    depositReconciliationIntervalMs,
    competitionIntervalMs,
  });
}
