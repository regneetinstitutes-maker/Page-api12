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
import { MockPayoutProvider } from "./payout/mock-payout";

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

import { submitPendingWithdrawals } from "./withdrawal-submission";
import { reconcileProcessingWithdrawals } from "./withdrawal-reconciliation";
import { runWithdrawalHealthChecks } from "./health";
import { reconcilePendingDeposits } from "./deposit-reconciliation";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("startScheduler", () => {
  it("returns null in the test environment (NODE_ENV=test)", () => {
    // NODE_ENV is set to 'test' by vitest automatically.
    const result = startScheduler();
    expect(result).toBeNull();
  });
});

describe("createScheduler", () => {
  let provider: MockPayoutProvider;

  beforeEach(() => {
    provider = new MockPayoutProvider();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls submitPendingWithdrawals on the configured interval", async () => {
    const scheduler = createScheduler({
      provider,
      submissionIntervalMs: 1_000,
      reconciliationIntervalMs: 60_000,
      healthCheckIntervalMs: 600_000,
    });

    // No immediate call.
    expect(submitPendingWithdrawals).not.toHaveBeenCalled();

    // Advance one submission interval.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitPendingWithdrawals).toHaveBeenCalledTimes(1);
    expect(submitPendingWithdrawals).toHaveBeenCalledWith(provider);

    // Advance another interval.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitPendingWithdrawals).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("calls reconcileProcessingWithdrawals on the configured interval", async () => {
    const scheduler = createScheduler({
      provider,
      submissionIntervalMs: 60_000,
      reconciliationIntervalMs: 2_000,
      healthCheckIntervalMs: 600_000,
    });

    expect(reconcileProcessingWithdrawals).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcileProcessingWithdrawals).toHaveBeenCalledTimes(1);
    expect(reconcileProcessingWithdrawals).toHaveBeenCalledWith(provider);

    scheduler.stop();
  });

  it("calls runWithdrawalHealthChecks on the configured interval", async () => {
    const scheduler = createScheduler({
      provider,
      submissionIntervalMs: 60_000,
      reconciliationIntervalMs: 60_000,
      healthCheckIntervalMs: 3_000,
    });

    expect(runWithdrawalHealthChecks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(runWithdrawalHealthChecks).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("calls reconcilePendingDeposits on the configured interval", async () => {
    const scheduler = createScheduler({
      provider,
      submissionIntervalMs: 60_000,
      reconciliationIntervalMs: 60_000,
      healthCheckIntervalMs: 600_000,
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

  it("stop() prevents any further job invocations", async () => {
    const scheduler = createScheduler({
      provider,
      submissionIntervalMs: 1_000,
      reconciliationIntervalMs: 1_000,
      healthCheckIntervalMs: 1_000,
      depositReconciliationIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const withdrawalSubmissionCalls = (submitPendingWithdrawals as ReturnType<typeof vi.fn>).mock.calls.length;
    const depositReconciliationCalls = (reconcilePendingDeposits as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(withdrawalSubmissionCalls).toBeGreaterThan(0);
    expect(depositReconciliationCalls).toBeGreaterThan(0);

    scheduler.stop();

    // Advance further — no new calls should be made for any timer.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(submitPendingWithdrawals).toHaveBeenCalledTimes(withdrawalSubmissionCalls);
    expect(reconcileProcessingWithdrawals).toHaveBeenCalledTimes(withdrawalSubmissionCalls);
    expect(reconcilePendingDeposits).toHaveBeenCalledTimes(depositReconciliationCalls);
  });

  it("continues processing after a job throws an error", async () => {
    // Make the submission job throw on the first call.
    (submitPendingWithdrawals as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("Transient DB error"))
      .mockResolvedValue(undefined);

    const scheduler = createScheduler({
      provider,
      submissionIntervalMs: 1_000,
      reconciliationIntervalMs: 600_000,
      healthCheckIntervalMs: 600_000,
    });

    // First interval — throws, scheduler catches and continues.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitPendingWithdrawals).toHaveBeenCalledTimes(1);

    // Second interval — succeeds.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitPendingWithdrawals).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("passes the same provider instance to both submission and reconciliation jobs", async () => {
    const scheduler = createScheduler({
      provider,
      submissionIntervalMs: 500,
      reconciliationIntervalMs: 500,
      healthCheckIntervalMs: 600_000,
    });

    await vi.advanceTimersByTimeAsync(500);

    const submissionCall = (submitPendingWithdrawals as ReturnType<typeof vi.fn>).mock.calls[0];
    const reconciliationCall = (reconcileProcessingWithdrawals as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(submissionCall?.[0]).toBe(provider);
    expect(reconciliationCall?.[0]).toBe(provider);

    scheduler.stop();
  });
});
