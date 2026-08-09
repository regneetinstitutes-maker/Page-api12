/**
 * Background job scheduler for payment processing.
 *
 * Runs four periodic jobs:
 *
 *   1. submitPendingWithdrawals  — picks up `reserved` withdrawals and
 *      submits them to the payout provider. Default: every 30 seconds.
 *
 *   2. reconcileProcessingWithdrawals — polls the provider for `processing`
 *      withdrawals that did not receive a webhook callback. Default: every
 *      5 minutes.
 *
 *   3. runWithdrawalHealthChecks — monitors for reserved_balance drift and
 *      stuck withdrawals. Default: every 10 minutes.
 *
 *   4. reconcilePendingDeposits — polls PayU for `pending` deposits that have
 *      been waiting longer than the staleness threshold (15 minutes) without
 *      receiving a webhook callback. Default: every 5 minutes.
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
import { submitPendingWithdrawals } from "./withdrawal-submission";
import { reconcileProcessingWithdrawals } from "./withdrawal-reconciliation";
import { runWithdrawalHealthChecks } from "./health";
import { reconcilePendingDeposits } from "./deposit-reconciliation";
import { resolvePayoutProvider } from "./payout/provider";
import type { PayoutProvider } from "./payout/provider";
import { runCompetitionScheduler } from "./competition";

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SUBMISSION_INTERVAL_MS = 30_000;                   // 30 seconds
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60_000;           // 5 minutes
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10 * 60_000;            // 10 minutes
const DEFAULT_DEPOSIT_RECONCILIATION_INTERVAL_MS = 5 * 60_000;   // 5 minutes
const DEFAULT_COMPETITION_INTERVAL_MS = 30_000;                  // 30 seconds

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  provider: PayoutProvider;
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
    provider,
    submissionIntervalMs = DEFAULT_SUBMISSION_INTERVAL_MS,
    reconciliationIntervalMs = DEFAULT_RECONCILIATION_INTERVAL_MS,
    healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    depositReconciliationIntervalMs = DEFAULT_DEPOSIT_RECONCILIATION_INTERVAL_MS,
    competitionIntervalMs = DEFAULT_COMPETITION_INTERVAL_MS,
  } = options;

  logger.info(
    {
      provider: provider.name,
      submissionIntervalMs,
      reconciliationIntervalMs,
      healthCheckIntervalMs,
      depositReconciliationIntervalMs,
      competitionIntervalMs,
    },
    "Scheduler: background jobs starting.",
  );

  const submissionTimer = setInterval(async () => {
    logger.debug("Scheduler: running submission job.");
    try {
      await submitPendingWithdrawals(provider);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Scheduler: unexpected error in submission job.",
      );
    }
  }, submissionIntervalMs);

  const reconciliationTimer = setInterval(async () => {
    logger.debug("Scheduler: running reconciliation job.");
    try {
      await reconcileProcessingWithdrawals(provider);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Scheduler: unexpected error in reconciliation job.",
      );
    }
  }, reconciliationIntervalMs);

  const healthTimer = setInterval(async () => {
    logger.debug("Scheduler: running health checks.");
    try {
      await runWithdrawalHealthChecks();
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
      await reconcilePendingDeposits();
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
      await runCompetitionScheduler();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Scheduler: unexpected error in competition lifecycle job.",
      );
    }
  }, competitionIntervalMs);

  // Allow the process to exit even if timers are still pending.
  submissionTimer.unref();
  reconciliationTimer.unref();
  healthTimer.unref();
  depositReconciliationTimer.unref();
  competitionTimer.unref();

  return {
    stop() {
      clearInterval(submissionTimer);
      clearInterval(reconciliationTimer);
      clearInterval(healthTimer);
      clearInterval(depositReconciliationTimer);
      clearInterval(competitionTimer);
      logger.info("Scheduler: background jobs stopped.");
    },
  };
}

// ── startScheduler ────────────────────────────────────────────────────────────

/**
 * Reads configuration from environment variables, resolves the payout provider,
 * and starts the background jobs.
 *
 * Returns null when NODE_ENV === 'test' so that importing index.ts in tests
 * does not start real timers.
 */
export function startScheduler(): SchedulerHandles | null {
  if (process.env.NODE_ENV === "test") {
    logger.debug("Scheduler: disabled in test environment.");
    return null;
  }

  const provider = resolvePayoutProvider();

  const submissionIntervalMs =
    Number(process.env["SUBMISSION_JOB_INTERVAL_MS"]) || DEFAULT_SUBMISSION_INTERVAL_MS;
  const reconciliationIntervalMs =
    Number(process.env["RECONCILIATION_JOB_INTERVAL_MS"]) || DEFAULT_RECONCILIATION_INTERVAL_MS;
  const healthCheckIntervalMs =
    Number(process.env["HEALTH_CHECK_INTERVAL_MS"]) || DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  const depositReconciliationIntervalMs =
    Number(process.env["DEPOSIT_RECONCILIATION_JOB_INTERVAL_MS"]) ||
    DEFAULT_DEPOSIT_RECONCILIATION_INTERVAL_MS;
  const competitionIntervalMs =
    Number(process.env["COMPETITION_JOB_INTERVAL_MS"]) || DEFAULT_COMPETITION_INTERVAL_MS;

  return createScheduler({
    provider,
    submissionIntervalMs,
    reconciliationIntervalMs,
    healthCheckIntervalMs,
    depositReconciliationIntervalMs,
    competitionIntervalMs,
  });
}
