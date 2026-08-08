/**
 * Payout account routes.
 *
 * All endpoints require an authenticated session. For bank transfer accounts,
 * the account number is never returned in full — responses expose only the last
 * 4 digits (masked) to protect the user's financial data while still allowing
 * identification.
 *
 * ── Supported methods ─────────────────────────────────────────────────────────
 *
 * POST /bank-accounts accepts a discriminated union on `method`:
 *   { method: 'bank_transfer', accountHolderName, bankAccountNumber, bankIfscCode, bankName? }
 *   { method: 'upi', accountHolderName, upiId }
 *
 * The endpoint URL is kept as `/bank-accounts` for backward compatibility.
 *
 * ── QR code support ───────────────────────────────────────────────────────────
 *
 * QR code scanning is a frontend concern only. The frontend decodes the QR
 * image, extracts the UPI VPA (e.g. "alice@okhdfc"), and then calls
 * POST /bank-accounts with `method: 'upi'` and `upiId: <extracted VPA>`.
 * This route has no awareness of whether the VPA came from manual entry or a
 * QR scan — both paths are handled identically.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireSession } from "../middlewares/requireSession";
import {
  addBankAccount,
  getUserBankAccounts,
  getBankAccount,
  softDeleteBankAccount,
  BankAccountNotFoundError,
  BankAccountInUseError,
} from "../lib/bank-account";
import type { UserBankAccount } from "@workspace/db";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskAccountNumber(accountNumber: string): string {
  if (accountNumber.length <= 4) return accountNumber;
  return `****${accountNumber.slice(-4)}`;
}

/**
 * Maps a UserBankAccount DB row to the HTTP response shape.
 * Method-specific fields: bank_transfer includes masked account number and IFSC;
 * upi includes the VPA (not sensitive — no masking required).
 */
function toBankAccountResponse(account: UserBankAccount) {
  const base = {
    id: account.id,
    userId: account.userId,
    method: account.method,
    accountHolderName: account.accountHolderName,
    isVerified: account.isVerified,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };

  if (account.method === "bank_transfer") {
    return {
      ...base,
      /** Full account number is never returned; only last 4 digits exposed. */
      bankAccountNumberMasked: account.bankAccountNumber
        ? maskAccountNumber(account.bankAccountNumber)
        : null,
      bankIfscCode: account.bankIfscCode ?? null,
      bankName: account.bankName ?? null,
      upiId: null,
    };
  }

  // method === "upi"
  return {
    ...base,
    bankAccountNumberMasked: null,
    bankIfscCode: null,
    bankName: null,
    upiId: account.upiId ?? null,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Discriminated union validator for adding a payout account.
 * The `method` field determines which other fields are required.
 */
const AddBankAccountBody = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("bank_transfer"),
    accountHolderName: z.string().min(1).max(100).trim(),
    /** Must be 5–30 characters. Stored as-is; masked in all responses. */
    bankAccountNumber: z.string().min(5).max(30).trim(),
    /**
     * Standard Indian IFSC code: 4 uppercase letters + literal '0' + 6
     * uppercase alphanumeric characters. Normalised to uppercase before storage.
     */
    bankIfscCode: z
      .string()
      .regex(
        /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/,
        "Invalid IFSC code. Format: 4 letters, '0', then 6 alphanumeric characters (e.g. HDFC0001234).",
      )
      .transform((v) => v.toUpperCase()),
    bankName: z.string().min(1).max(100).trim().optional(),
  }),
  z.object({
    method: z.literal("upi"),
    accountHolderName: z.string().min(1).max(100).trim(),
    /**
     * UPI Virtual Payment Address (VPA). Format: localpart@handle.
     * Populated identically whether entered manually or extracted from a QR code.
     */
    upiId: z
      .string()
      .min(3)
      .max(50)
      .trim()
      .regex(
        /^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/,
        "Invalid UPI ID. Format: localpart@handle (e.g. alice@okhdfc).",
      ),
  }),
]);

const IdParam = z.string().uuid("Invalid payout account ID format.");

// ── POST /bank-accounts ───────────────────────────────────────────────────────

/**
 * Saves a new payout account (bank transfer or UPI) for the authenticated user.
 *
 * For bank_transfer: validates and normalises IFSC to uppercase.
 * For upi: validates VPA format. QR-derived VPAs are accepted identically to
 *   manually entered ones — the backend does not distinguish the source.
 *
 * 201 — Account saved.
 * 400 — Validation error (missing fields, invalid IFSC, invalid UPI VPA format).
 * 401 — Not authenticated.
 */
router.post("/bank-accounts", requireSession, async (req, res): Promise<void> => {
  const parsed = AddBankAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const data = parsed.data;
  const account = await addBankAccount({
    userId: req.user!.id,
    ...data,
  });

  res.status(201).json(toBankAccountResponse(account));
});

// ── GET /bank-accounts ────────────────────────────────────────────────────────

/**
 * Returns all non-deleted payout accounts for the authenticated user.
 * Includes both bank_transfer and UPI accounts.
 *
 * 200 — Array of accounts (possibly empty).
 * 401 — Not authenticated.
 */
router.get("/bank-accounts", requireSession, async (req, res): Promise<void> => {
  const accounts = await getUserBankAccounts(req.user!.id);
  res.status(200).json({ bankAccounts: accounts.map(toBankAccountResponse) });
});

// ── GET /bank-accounts/:id ────────────────────────────────────────────────────

/**
 * Returns a single payout account by ID, with ownership validation.
 *
 * 200 — Account found.
 * 400 — Invalid UUID.
 * 401 — Not authenticated.
 * 404 — Not found or does not belong to this user.
 */
router.get("/bank-accounts/:id", requireSession, async (req, res): Promise<void> => {
  const idParsed = IdParam.safeParse(req.params["id"]);
  if (!idParsed.success) {
    res.status(400).json({ message: "Invalid payout account ID." });
    return;
  }

  const account = await getBankAccount(idParsed.data, req.user!.id);
  if (!account) {
    res.status(404).json({ message: "Payout account not found or does not belong to this user." });
    return;
  }

  res.status(200).json(toBankAccountResponse(account));
});

// ── DELETE /bank-accounts/:id ─────────────────────────────────────────────────

/**
 * Soft-deletes a payout account.
 *
 * Physical deletion is blocked by the DB (ON DELETE RESTRICT from
 * withdrawals.bank_account_id). Soft delete hides the account from the
 * user's active list while keeping the FK chain intact for historical records.
 *
 * Fails with 409 if the account is referenced by a reserved or processing
 * withdrawal — the user must wait for the withdrawal to reach a terminal
 * state before removing the account.
 *
 * 204 — Account soft-deleted.
 * 400 — Invalid UUID.
 * 401 — Not authenticated.
 * 404 — Not found or does not belong to this user.
 * 409 — Account is in use by an active withdrawal.
 */
router.delete("/bank-accounts/:id", requireSession, async (req, res): Promise<void> => {
  const idParsed = IdParam.safeParse(req.params["id"]);
  if (!idParsed.success) {
    res.status(400).json({ message: "Invalid payout account ID." });
    return;
  }

  try {
    await softDeleteBankAccount(idParsed.data, req.user!.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof BankAccountNotFoundError) {
      res.status(404).json({ message: err.message });
      return;
    }
    if (err instanceof BankAccountInUseError) {
      res.status(409).json({ message: err.message });
      return;
    }
    throw err;
  }
});

export default router;
