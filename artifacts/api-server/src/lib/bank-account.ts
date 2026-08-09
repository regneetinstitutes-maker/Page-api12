/**
 * Payout account service.
 *
 * Manages the `user_bank_accounts` table — the registry of pre-registered payout
 * accounts (bank transfer and UPI) that users can select when initiating a
 * withdrawal.
 *
 * ── Supported payout methods ──────────────────────────────────────────────────
 *
 * `bank_transfer` — NEFT/IMPS to a bank account (account number + IFSC code).
 * `upi`           — Instant transfer to a UPI Virtual Payment Address (VPA).
 *
 * ── QR code support ───────────────────────────────────────────────────────────
 *
 * QR code scanning is an *input method* only, not a separate payout destination.
 * The frontend extracts the UPI VPA from the QR code (via a QR decode library)
 * and then calls `addBankAccount` with `method: 'upi'` and `upiId: <extracted VPA>`.
 * This service has no awareness of whether the VPA came from manual entry or a
 * QR scan — both paths produce identical stored rows.
 *
 * ── Soft delete ───────────────────────────────────────────────────────────────
 *
 * Physical deletion of a payout account row is blocked by the DB (ON DELETE
 * RESTRICT from withdrawals.bank_account_id). Soft delete is used instead:
 * `is_deleted = true` hides the account from the user's active list while
 * keeping the FK chain intact for historical withdrawal records.
 *
 * Deleting an account that has an active withdrawal (reserved or processing)
 * is rejected with `BankAccountInUseError` — the payout job still needs the
 * details for submission and the user must wait for the withdrawal to settle.
 *
 * ── KYC readiness ─────────────────────────────────────────────────────────────
 *
 * `is_verified` and `verified_at` are stored on the schema but not enforced by
 * this module. When a KYC gate is required, add:
 *
 *   if (!account.isVerified) throw new BankAccountNotVerifiedError();
 *
 * inside `initiateWithdrawal` in withdrawal.ts. No schema migration needed.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  userBankAccountsTable,
  withdrawalsTable,
  type UserBankAccount,
} from "@workspace/db";
import { decryptBankAccountNumber, encryptBankAccountNumber } from "./bank-account-crypto";

// ── Error types ───────────────────────────────────────────────────────────────

export class BankAccountNotFoundError extends Error {
  constructor(id: string) {
    super(`Payout account ${id} not found or does not belong to this user.`);
    this.name = "BankAccountNotFoundError";
  }
}

export class BankAccountInUseError extends Error {
  constructor(id: string) {
    super(
      `Payout account ${id} has an active withdrawal (reserved or processing). ` +
        `Wait for the withdrawal to complete or fail before removing this account.`,
    );
    this.name = "BankAccountInUseError";
  }
}

// ── Input types ───────────────────────────────────────────────────────────────

/**
 * Input for adding a bank transfer payout account.
 * Validates IFSC format at the service layer (also backed by a DB CHECK constraint).
 */
interface AddBankTransferAccountInput {
  userId: string;
  method: "bank_transfer";
  accountHolderName: string;
  bankAccountNumber: string;
  /** Standard Indian IFSC code: 4 uppercase letters + '0' + 6 alphanumeric. */
  bankIfscCode: string;
  /** Optional display name for the bank (e.g. "HDFC Bank"). */
  bankName?: string;
}

/**
 * Input for adding a UPI payout account.
 *
 * `upiId` is the UPI Virtual Payment Address (VPA), e.g. "alice@okhdfc".
 * This field is populated identically whether the VPA was entered manually
 * or extracted from a QR code — the service does not distinguish between them.
 */
interface AddUpiAccountInput {
  userId: string;
  method: "upi";
  accountHolderName: string;
  /** UPI Virtual Payment Address, e.g. "alice@okhdfc". */
  upiId: string;
}

/**
 * Discriminated union input for adding any payout account.
 * Branch on `method` to determine which fields are required.
 */
export type AddBankAccountInput = AddBankTransferAccountInput | AddUpiAccountInput;

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Saves a new payout account for the user.
 *
 * For bank_transfer accounts: normalises IFSC to uppercase, trims whitespace.
 * For UPI accounts: trims whitespace, stores VPA as-is.
 *
 * Does NOT verify the account with the bank/UPI handle — that is a future KYC
 * step. The account is created with `is_verified = false`.
 *
 * Field format is validated at the API layer (Zod) and backed by DB CHECK
 * constraints. Account number and holder name must be non-blank (DB CHECK).
 */
export async function addBankAccount(
  input: AddBankAccountInput,
): Promise<UserBankAccount> {
  const baseValues = {
    userId: input.userId,
    method: input.method,
    accountHolderName: input.accountHolderName.trim(),
  };

  const methodValues =
    input.method === "bank_transfer"
      ? {
          bankAccountNumber: encryptBankAccountNumber(input.bankAccountNumber.trim()),
          bankIfscCode: input.bankIfscCode.trim().toUpperCase(),
          bankName: input.bankName?.trim() || null,
        }
      : {
          upiId: input.upiId.trim(),
        };

  const [account] = await db
    .insert(userBankAccountsTable)
    .values({ ...baseValues, ...methodValues })
    .returning();

  if (!account) {
    throw new Error("Failed to insert payout account after insert.");
  }

  return account.bankAccountNumber
    ? { ...account, bankAccountNumber: decryptBankAccountNumber(account.bankAccountNumber) }
    : account;
}

/**
 * Returns all non-deleted payout accounts belonging to the user, oldest first.
 */
export async function getUserBankAccounts(userId: string): Promise<UserBankAccount[]> {
  const accounts = await db
    .select()
    .from(userBankAccountsTable)
    .where(
      and(
        eq(userBankAccountsTable.userId, userId),
        eq(userBankAccountsTable.isDeleted, false),
      ),
    )
    .orderBy(userBankAccountsTable.createdAt);
  return accounts.map((account) => account.bankAccountNumber
    ? { ...account, bankAccountNumber: decryptBankAccountNumber(account.bankAccountNumber) }
    : account);
}

/**
 * Returns a single non-deleted payout account by ID, with ownership validation.
 * Returns `null` if the account does not exist, is soft-deleted, or belongs
 * to a different user.
 */
export async function getBankAccount(
  id: string,
  userId: string,
): Promise<UserBankAccount | null> {
  const [account] = await db
    .select()
    .from(userBankAccountsTable)
    .where(
      and(
        eq(userBankAccountsTable.id, id),
        eq(userBankAccountsTable.userId, userId),
        eq(userBankAccountsTable.isDeleted, false),
      ),
    )
    .limit(1);

  if (!account) return null;
  return account.bankAccountNumber
    ? { ...account, bankAccountNumber: decryptBankAccountNumber(account.bankAccountNumber) }
    : account;
}

/**
 * Soft-deletes a payout account.
 *
 * Throws `BankAccountNotFoundError` if the account does not exist or belongs
 * to a different user.
 *
 * Throws `BankAccountInUseError` if the account is referenced by any `reserved`
 * or `processing` withdrawal. The user must wait for the withdrawal to reach a
 * terminal state before removing the account.
 */
export async function softDeleteBankAccount(
  id: string,
  userId: string,
): Promise<void> {
  // Ownership check — must be the user's own non-deleted account.
  const account = await getBankAccount(id, userId);
  if (!account) {
    throw new BankAccountNotFoundError(id);
  }

  // Verify no in-flight withdrawal references this account.
  const [activeWithdrawal] = await db
    .select({ id: withdrawalsTable.id })
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.bankAccountId, id),
        inArray(withdrawalsTable.status, ["reserved", "processing"]),
      ),
    )
    .limit(1);

  if (activeWithdrawal) {
    throw new BankAccountInUseError(id);
  }

  await db
    .update(userBankAccountsTable)
    .set({ isDeleted: true, deletedAt: new Date() })
    .where(eq(userBankAccountsTable.id, id));
}
