/**
 * Withdrawal routes.
 *
 * All endpoints require an authenticated session. Initiating a withdrawal also
 * requires a verified mobile number (product requirement #9).
 *
 * The account number snapshot on the withdrawal row is masked in all responses —
 * only the last 4 digits are exposed. UPI withdrawals return the UPI VPA as-is
 * (it is not sensitive) and null for bank-account-specific fields.
 *
 * ── Rate limiting ─────────────────────────────────────────────────────────────
 *
 *   POST /withdrawals applies a per-user rate limit to prevent abuse. The limit
 *   is enforced using an in-memory sliding window (simple, no external deps).
 *
 *   Configuration via environment variables:
 *     WITHDRAWAL_RATE_LIMIT_MAX     — max requests per window (default: 10)
 *     WITHDRAWAL_RATE_LIMIT_WINDOW_MS — window duration in ms (default: 60 000)
 *
 *   The limiter is bypassed when NODE_ENV === 'test' to prevent rate-limiting
 *   interference in the integration test suite.
 */

import { type NextFunction, type Request, type Response, Router, type IRouter } from "express";
import { z } from "zod";
import { and, count, eq, gte } from "drizzle-orm";
import { db, withdrawalsTable } from "@workspace/db";
import { requireSession } from "../middlewares/requireSession";
import {
  initiateWithdrawal,
  cancelWithdrawal,
  getWithdrawal,
  getUserWithdrawals,
  MINIMUM_WITHDRAWAL_AMOUNT,
  WithdrawalAmountBelowMinimumError,
  ActiveWithdrawalExistsError,
  WithdrawalBankAccountNotFoundError,
  DuplicateWithdrawalIdempotencyKeyError,
  WithdrawalNotFoundError,
  WithdrawalCannotBeCancelledError,
  InsufficientAvailableBalanceError,
} from "../lib/withdrawal";
import type { Withdrawal } from "@workspace/db";
import { decryptBankAccountNumber } from "../lib/bank-account-crypto";
import { withDatabaseAdvisoryLock } from "../lib/db-lock";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskAccountNumber(accountNumber: string): string {
  if (accountNumber.length <= 4) return accountNumber;
  return `****${accountNumber.slice(-4)}`;
}

/**
 * Maps a Withdrawal DB row to the HTTP response shape.
 * Method-aware: bank_transfer responses include masked account number and IFSC;
 * UPI responses include the VPA and null for bank-account-specific fields.
 * The full bank account number is never exposed — only last 4 digits.
 */
function toWithdrawalResponse(w: Withdrawal) {
  return {
    id: w.id,
    userId: w.userId,
    amount: w.amount,
    status: w.status,
    bankAccountId: w.bankAccountId,
    snapshotPayoutMethod: w.snapshotPayoutMethod,
    snapshotAccountHolderName: w.snapshotAccountHolderName,
    /** Masked: only last 4 digits of the bank account number. Null for UPI withdrawals. */
    snapshotBankAccountNumberMasked: w.snapshotBankAccountNumber
      ? maskAccountNumber(decryptBankAccountNumber(w.snapshotBankAccountNumber))
      : null,
    snapshotBankIfscCode: w.snapshotBankIfscCode ?? null,
    snapshotBankName: w.snapshotBankName ?? null,
    /** UPI Virtual Payment Address. Null for bank_transfer withdrawals. */
    snapshotUpiId: w.snapshotUpiId ?? null,
    provider: w.provider ?? null,
    providerReference: w.providerReference ?? null,
    failureReason: w.failureReason ?? null,
    cancellationReason: w.cancellationReason ?? null,
    completedAt: w.completedAt ?? null,
    failedAt: w.failedAt ?? null,
    cancelledAt: w.cancelledAt ?? null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

// ── Per-user rate limiter ─────────────────────────────────────────────────────

/**
 * Creates a per-user rate-limiting middleware using PostgreSQL as the source
 * of truth. The advisory lock makes the check and request admission safe when
 * multiple EC2 instances receive requests for the same user concurrently.
 *
 * @param maxRequests - Maximum requests allowed per window.
 * @param windowMs    - Window duration in milliseconds.
 */
export function createUserRateLimiter(
  maxRequests: number,
  windowMs: number,
): (req: Request, res: Response, next: NextFunction) => void {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Bypass in test environment to prevent interference with integration tests.
    if (process.env.NODE_ENV === "test") {
      next();
      return;
    }

    // At this point requireSession has already run, so req.user is set.
    const userId = req.user?.id;
    if (!userId) {
      // No user — let requireSession handle the 401.
      next();
      return;
    }

    const result = await withDatabaseAdvisoryLock(`withdrawal-rate:${userId}`, async () => {
      const now = Date.now();
      const cutoff = new Date(now - windowMs);
      const [row] = await db.select({ count: count() }).from(withdrawalsTable).where(and(eq(withdrawalsTable.userId, userId), gte(withdrawalsTable.createdAt, cutoff)));
      const requestCount = Number(row?.count ?? 0);
      if (requestCount >= maxRequests) {
        const retryAfterSec = Math.ceil(windowMs / 1000);
        res.setHeader("Retry-After", String(retryAfterSec));
        res.status(429).json({ code: "RATE_LIMIT_EXCEEDED", message: `Too many withdrawal requests. Please wait ${retryAfterSec} second(s) before trying again.` });
        return false;
      }
      next();
      return true;
    });
    if (result === undefined && !res.headersSent) res.status(429).json({ code: "RATE_LIMIT_BUSY", message: "Please retry this request." });
  };
}

const withdrawalRateLimiter = createUserRateLimiter(
  Number(process.env["WITHDRAWAL_RATE_LIMIT_MAX"]) || 10,
  Number(process.env["WITHDRAWAL_RATE_LIMIT_WINDOW_MS"]) || 60_000,
);

// ── Validation ────────────────────────────────────────────────────────────────

const InitiateWithdrawalBody = z.object({
  amount: z
    .number()
    .int(`Withdrawal amount must be a whole number of Winning Coins.`)
    .min(
      MINIMUM_WITHDRAWAL_AMOUNT,
      `Minimum withdrawal amount is ${MINIMUM_WITHDRAWAL_AMOUNT} Winning Coins (₹${MINIMUM_WITHDRAWAL_AMOUNT}).`,
    ),
  /** ID of a pre-registered payout account (bank transfer or UPI) belonging to this user. */
  payoutAccountId: z.string().uuid("payoutAccountId must be a valid UUID."),
  /** Client-generated. Retry with the same key + same params returns existing record. */
  idempotencyKey: z.string().min(1).max(128),
});

const GetWithdrawalsQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 20))
    .pipe(z.number().int().min(1).max(100)),
  before: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? new Date(v) : undefined))
    .pipe(z.date().optional()),
});

const WithdrawalIdParam = z.string().uuid("Withdrawal ID must be a valid UUID.");

// ── POST /withdrawals ─────────────────────────────────────────────────────────

/**
 * Initiates a new withdrawal.
 *
 * Requires: authenticated session + verified mobile number.
 * Rate limited: max 10 requests per 60 seconds per user.
 *
 * `payoutAccountId` references any saved payout account (bank transfer or UPI).
 *
 * 201 — Withdrawal created.
 * 200 — Idempotent: same key + same params returns existing withdrawal.
 * 400 — Validation error, amount below minimum, or mobile not verified.
 * 401 — Not authenticated.
 * 404 — Payout account not found.
 * 409 — Active withdrawal already exists, or conflicting idempotency key.
 * 422 — Insufficient balance.
 * 429 — Rate limit exceeded.
 */
router.post(
  "/withdrawals",
  requireSession,
  withdrawalRateLimiter,
  async (req, res): Promise<void> => {
    const user = req.user!;

    // Mobile number verification gate.
    if (!user.mobileNumber) {
      res.status(400).json({
        code: "MOBILE_NUMBER_REQUIRED",
        message: "A verified mobile number is required to withdraw funds.",
      });
      return;
    }

    if (user.mobileVerificationStatus !== "verified") {
      res.status(400).json({
        code: "MOBILE_VERIFICATION_REQUIRED",
        message: "Your mobile number must be verified before you can withdraw funds.",
      });
      return;
    }

    // Terms & Conditions must have been accepted.
    if (!user.termsAcceptedAt) {
      res.status(400).json({
        code: "TERMS_NOT_ACCEPTED",
        message: "You must accept the Terms & Conditions before initiating a withdrawal.",
      });
      return;
    }

    const parsed = InitiateWithdrawalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.message });
      return;
    }

    const { amount, payoutAccountId, idempotencyKey } = parsed.data;

    try {
      const { withdrawal, created } = await db.transaction(async (tx) =>
        initiateWithdrawal(tx, {
          userId: user.id,
          amount,
          payoutAccountId,
          idempotencyKey,
        }),
      );

      res.status(created ? 201 : 200).json(toWithdrawalResponse(withdrawal));
    } catch (err) {
      if (err instanceof WithdrawalAmountBelowMinimumError) {
        res.status(400).json({ message: err.message });
        return;
      }
      if (err instanceof WithdrawalBankAccountNotFoundError) {
        res.status(404).json({ message: err.message });
        return;
      }
      if (
        err instanceof ActiveWithdrawalExistsError ||
        err instanceof DuplicateWithdrawalIdempotencyKeyError
      ) {
        res.status(409).json({ message: err.message });
        return;
      }
      if (err instanceof InsufficientAvailableBalanceError) {
        res.status(422).json({ message: err.message });
        return;
      }
      throw err;
    }
  },
);

// ── GET /withdrawals ──────────────────────────────────────────────────────────

/**
 * Returns a paginated list of the authenticated user's withdrawals.
 *
 * Query params:
 *   limit  — max results (1–100, default 20)
 *   before — ISO 8601 timestamp cursor (returns records older than this)
 *
 * 200 — Array of withdrawals (possibly empty).
 * 400 — Invalid query params.
 * 401 — Not authenticated.
 */
router.get("/withdrawals", requireSession, async (req, res): Promise<void> => {
  const parsed = GetWithdrawalsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const { limit, before } = parsed.data;

  const withdrawals = await getUserWithdrawals({
    userId: req.user!.id,
    limit,
    before,
  });

  res.status(200).json({ withdrawals: withdrawals.map(toWithdrawalResponse) });
});

// ── GET /withdrawals/:id ──────────────────────────────────────────────────────

/**
 * Returns a single withdrawal by ID.
 *
 * Returns 404 (not 403) if the withdrawal does not belong to the authenticated
 * user, to avoid revealing whether the withdrawal ID exists.
 *
 * 200 — Withdrawal found.
 * 400 — Invalid UUID.
 * 401 — Not authenticated.
 * 404 — Not found or wrong user.
 */
router.get("/withdrawals/:id", requireSession, async (req, res): Promise<void> => {
  const idParsed = WithdrawalIdParam.safeParse(req.params["id"]);
  if (!idParsed.success) {
    res.status(400).json({ message: "Invalid withdrawal ID." });
    return;
  }

  const withdrawal = await getWithdrawal(idParsed.data, req.user!.id);
  if (!withdrawal) {
    res.status(404).json({ message: "Withdrawal not found or does not belong to this user." });
    return;
  }

  res.status(200).json(toWithdrawalResponse(withdrawal));
});

// ── POST /withdrawals/:id/cancel ──────────────────────────────────────────────

/**
 * Cancels a withdrawal. Only valid for withdrawals in `reserved` state.
 * Idempotent: returns 200 if already cancelled.
 *
 * 200 — Cancelled (or was already cancelled).
 * 400 — Invalid UUID.
 * 401 — Not authenticated.
 * 404 — Not found or wrong user.
 * 409 — Cannot cancel (status is not `reserved`).
 */
router.post("/withdrawals/:id/cancel", requireSession, async (req, res): Promise<void> => {
  const idParsed = WithdrawalIdParam.safeParse(req.params["id"]);
  if (!idParsed.success) {
    res.status(400).json({ message: "Invalid withdrawal ID." });
    return;
  }

  try {
    const cancelled = await db.transaction(async (tx) =>
      cancelWithdrawal(tx, idParsed.data, req.user!.id),
    );

    res.status(200).json(toWithdrawalResponse(cancelled));
  } catch (err) {
    if (err instanceof WithdrawalNotFoundError) {
      res.status(404).json({ message: err.message });
      return;
    }
    if (err instanceof WithdrawalCannotBeCancelledError) {
      res.status(409).json({ message: err.message });
      return;
    }
    throw err;
  }
});

export default router;
