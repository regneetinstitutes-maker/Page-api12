/**
 * Tests for the background job scheduler.
 *
 * Uses vitest fake timers so the tests run synchronously without real delays,
 * and a MockPayoutProvider so no real HTTP calls are made.
 *
 * The tests exercise createScheduler() directly (bypassing the NODE_ENV guard
 * in startScheduler) to verify:
 *   - The scheduler calls each job on its configured interval.
 *   - stop() clears all timers (no further jobs run after stop).
 *   - startScheduler() returns null in the test environment.
 *   - Interval values are configurable via options.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createScheduler, startScheduler } from "./scheduler";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock the job functions so we can assert they were called without touching the DB.
vi.mock("./withdrawal-submission", () => ({
  submitPendingWithdrawals: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./withdrawal-reconciliation", () => ({
  reconcileProcessingWithdrawals: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./health", () => ({
  runWithdrawalHealthChecks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./deposit-reconciliation", () => ({
  reconcilePendingDeposits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./competition", () => ({
  runCompetitionScheduler: vi.fn().mockResolvedValue(undefined),
}));

import { submitPendingWithdrawals } from "./withdrawal-submission";
import { reconcileProcessingWithdrawals } from "./withdrawal-reconciliation";
import { runWithdrawalHealthChecks } from "./health";
import { reconcilePendingDeposits } from "./deposit-reconciliation";
import { runCompetitionScheduler } from "./competition";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("startScheduler", () => {
  it("returns null in the test environment (NODE_ENV=test)", () => {
    // NODE_ENV is set to 'test' by vitest automatically.
    const result = startScheduler();
    expect(result).toBeNull();
  });
});

describe("createScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls runWithdrawalHealthChecks on the configured interval", async () => {
    const scheduler = createScheduler({
      healthCheckIntervalMs: 3_000,
    });

    expect(runWithdrawalHealthChecks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(runWithdrawalHealthChecks).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("calls reconcilePendingDeposits on the configured interval", async () => {
    const scheduler = createScheduler({
      depositReconciliationIntervalMs: 2_000,
    });

    // No immediate call — the first tick fires after the full interval.
    expect(reconcilePendingDeposits).not.toHaveBeenCalled();

    // Advance one deposit-reconciliation interval.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcilePendingDeposits).toHaveBeenCalledTimes(1);

    // Advance another interval — must fire again.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcilePendingDeposits).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("calls the competition lifecycle job on its configured interval", async () => {
    const scheduler = createScheduler({
      competitionIntervalMs: 2_000,
    });

    expect(runCompetitionScheduler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runCompetitionScheduler).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("stop() prevents any further job invocations", async () => {
    const scheduler = createScheduler({
      healthCheckIntervalMs: 1_000,
      depositReconciliationIntervalMs: 1_000,
      competitionIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const healthCalls = (runWithdrawalHealthChecks as ReturnType<typeof vi.fn>).mock.calls.length;
    const depositCalls = (reconcilePendingDeposits as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(healthCalls).toBeGreaterThan(0);
    expect(depositCalls).toBeGreaterThan(0);

    scheduler.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runWithdrawalHealthChecks).toHaveBeenCalledTimes(healthCalls);
    expect(reconcilePendingDeposits).toHaveBeenCalledTimes(depositCalls);
  });

  it("continues processing after a job throws an error", async () => {
    (runWithdrawalHealthChecks as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("Transient DB error"))
      .mockResolvedValue(undefined);

    const scheduler = createScheduler({
      healthCheckIntervalMs: 1_000,
      depositReconciliationIntervalMs: 600_000,
      competitionIntervalMs: 600_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runWithdrawalHealthChecks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runWithdrawalHealthChecks).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
});
