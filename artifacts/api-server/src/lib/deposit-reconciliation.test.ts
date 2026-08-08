// Set PayU env vars before any module that reads process.env is imported.
process.env["PAYU_KEY"] = "pmnt-test-key";
process.env["PAYU_SALT"] = "pmnt-test-salt";
process.env["PAYU_ENV"] = "test";
process.env["PAYU_SURL"] = "https://example.com/success";
process.env["PAYU_FURL"] = "https://example.com/failure";

/**
 * Mock reconcileDeposit so this file tests only the batch-runner behaviour.
 * The single-item reconciler is tested exhaustively in reconciliation.test.ts.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";

vi.mock("./reconciliation", () => ({
  reconcileDeposit: vi.fn(),
}));

import { eq } from "drizzle-orm";
import { db, usersTable, depositsTable } from "@workspace/db";
import { hashPassword, PASSWORD_ALGO } from "./password";
import { reconcileDeposit } from "./reconciliation";
import {
  reconcilePendingDeposits,
  PENDING_STALENESS_THRESHOLD_MS,
  PENDING_ALERT_THRESHOLD_MS,
} from "./deposit-reconciliation";

// ── Mocked function handle ─────────────────────────────────────────────────────

const mockReconcile = vi.mocked(reconcileDeposit);

// ── Shared state ──────────────────────────────────────────────────────────────

const prefix = `tdrecon${Date.now()}`;
let userId = "";

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const pwHash = await hashPassword("TestPass123!");

  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-u`,
      name: "Deposit Recon Tester",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}u@test.example`,
      mobileNumber: `+91903${prefix.slice(-7)}`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  userId = user!.id;
});

afterAll(async () => {
  if (!userId) return;
  await db.delete(depositsTable).where(eq(depositsTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

// Clean up deposits between tests so each starts from a known state.
afterEach(async () => {
  if (userId) {
    await db.delete(depositsTable).where(eq(depositsTable.userId, userId));
  }
});

beforeEach(() => {
  mockReconcile.mockReset();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inserts a pending deposit with createdAt backdated by ageMs from now.
 * Using an explicit createdAt simulates staleness without real clock delays.
 */
async function insertPendingDeposit(ageMs: number): Promise<string> {
  const createdAt = new Date(Date.now() - ageMs);
  const [row] = await db
    .insert(depositsTable)
    .values({
      userId,
      amount: 100,
      coinsToCredit: 100,
      status: "pending",
      merchantOrderId: `${prefix}-${ageMs}-${Math.random().toString(36).slice(2)}`,
      createdAt,
    })
    .returning({ merchantOrderId: depositsTable.merchantOrderId });
  return row!.merchantOrderId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reconcilePendingDeposits", () => {
  // ── 1. No stale deposits ───────────────────────────────────────────────────

  it("returns immediately without calling reconcileDeposit when no stale pending deposits exist", async () => {
    // Insert a fresh deposit (within the staleness threshold — should be skipped).
    await insertPendingDeposit(Math.floor(PENDING_STALENESS_THRESHOLD_MS / 2));

    await reconcilePendingDeposits();

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  // ── 2. Stale deposit is reconciled ────────────────────────────────────────

  it("calls reconcileDeposit for each deposit older than the staleness threshold", async () => {
    mockReconcile.mockResolvedValue("resolved_success");

    const merchantOrderId = await insertPendingDeposit(PENDING_STALENESS_THRESHOLD_MS + 60_000);

    await reconcilePendingDeposits();

    expect(mockReconcile).toHaveBeenCalledWith(merchantOrderId);
  });

  // ── 3. Fresh deposits are skipped, stale deposits are not ─────────────────

  it("reconciles only the stale deposit when both a fresh and a stale deposit are present", async () => {
    mockReconcile.mockResolvedValue("still_pending");

    const staleId = await insertPendingDeposit(PENDING_STALENESS_THRESHOLD_MS + 60_000);
    // Fresh deposit — created more recently than the staleness threshold.
    await insertPendingDeposit(Math.floor(PENDING_STALENESS_THRESHOLD_MS / 2));

    await reconcilePendingDeposits();

    const calledWith = mockReconcile.mock.calls.map((c) => c[0]);
    expect(calledWith).toContain(staleId);
    expect(calledWith).toHaveLength(1);
  });

  // ── 4. Per-item error isolation ───────────────────────────────────────────

  it("continues processing remaining deposits when reconcileDeposit throws on one", async () => {
    // Insert two stale deposits; the first will error, the second must still run.
    // createdAt is ordered oldest-first in the batch query, so insert the
    // error-throwing deposit with a slightly older age.
    const firstId = await insertPendingDeposit(PENDING_STALENESS_THRESHOLD_MS + 120_000);
    const secondId = await insertPendingDeposit(PENDING_STALENESS_THRESHOLD_MS + 60_000);

    mockReconcile
      .mockRejectedValueOnce(new Error("PayU API unavailable"))
      .mockResolvedValueOnce("resolved_success");

    // Must not throw even though the first deposit's reconcile call fails.
    await expect(reconcilePendingDeposits()).resolves.toBeUndefined();

    // Both deposits must have been attempted.
    const calledWith = mockReconcile.mock.calls.map((c) => c[0]);
    expect(calledWith).toContain(firstId);
    expect(calledWith).toContain(secondId);
  });

  // ── 5. Non-pending deposits are not reconciled ────────────────────────────

  it("does not call reconcileDeposit for completed deposits regardless of age", async () => {
    // Insert a success deposit that is old enough to qualify as stale — the
    // WHERE status = 'pending' filter must exclude it.
    const [row] = await db
      .insert(depositsTable)
      .values({
        userId,
        amount: 100,
        coinsToCredit: 100,
        status: "success",
        merchantOrderId: `${prefix}-done-${Math.random().toString(36).slice(2)}`,
        completedAt: new Date(),
        createdAt: new Date(Date.now() - (PENDING_STALENESS_THRESHOLD_MS + 60_000)),
      })
      .returning({ merchantOrderId: depositsTable.merchantOrderId });

    await reconcilePendingDeposits();

    const calledWith = mockReconcile.mock.calls.map((c) => c[0]);
    expect(calledWith).not.toContain(row!.merchantOrderId);
  });

  // ── 6. Multiple stale deposits are all processed ──────────────────────────

  it("processes all stale pending deposits in a single run", async () => {
    mockReconcile.mockResolvedValue("still_pending");

    // Insert three deposits with increasing ages so the order is deterministic.
    const ids = await Promise.all([
      insertPendingDeposit(PENDING_STALENESS_THRESHOLD_MS + 60_000),
      insertPendingDeposit(PENDING_STALENESS_THRESHOLD_MS + 120_000),
      insertPendingDeposit(PENDING_STALENESS_THRESHOLD_MS + 180_000),
    ]);

    await reconcilePendingDeposits();

    const calledWith = mockReconcile.mock.calls.map((c) => c[0]);
    for (const id of ids) {
      expect(calledWith).toContain(id);
    }
  });

  // ── 7. Alert threshold — stuck deposits emit an operational alert ─────────

  it("emits an operational alert for deposits stuck beyond the alert threshold", async () => {
    mockReconcile.mockResolvedValue("still_pending");

    // Insert a deposit that exceeds the alert threshold (not just the staleness
    // threshold), and a merely-stale deposit that must not trigger an alert.
    await insertPendingDeposit(PENDING_ALERT_THRESHOLD_MS + 60_000);
    await insertPendingDeposit(PENDING_STALENESS_THRESHOLD_MS + 60_000);

    // Capture logger.error calls to verify the alert fires exactly once.
    const { logger } = await import("./logger");
    const errorSpy = vi.spyOn(logger, "error");

    await reconcilePendingDeposits();

    const alertCalls = errorSpy.mock.calls.filter(
      (args) => typeof args[1] === "string" && args[1].startsWith("ALERT:"),
    );
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0]![0]).toMatchObject({
      event: "deposit.pending.stuck_alert",
      userId,
    });

    errorSpy.mockRestore();
  });
});
