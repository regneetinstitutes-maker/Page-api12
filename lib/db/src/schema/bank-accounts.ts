import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Payout method enum.
 *
 * `bank_transfer` — NEFT/IMPS to a bank account (account number + IFSC).
 * `upi`           — Instant transfer to a UPI Virtual Payment Address (VPA).
 *
 * This enum is also imported by the withdrawals schema for snapshot columns.
 */
export const payoutMethodEnum = pgEnum("payout_method", ["bank_transfer", "upi"]);

/**
 * Stores verified payout accounts that users have pre-registered for withdrawals.
 * Supports bank_transfer (account number + IFSC) and upi (VPA) methods.
 *
 * A user may have multiple saved accounts; they choose one per withdrawal request.
 *
 * ── QR code support ──────────────────────────────────────────────────────────
 *
 * QR code scanning is an *input method* only, not a separate payout destination.
 * The frontend extracts the UPI VPA from the QR code and submits it as a
 * normal UPI account. The backend stores only the VPA string; QR images are
 * never persisted.
 *
 * ── Soft delete ───────────────────────────────────────────────────────────────
 *
 * Physical deletion of a bank account row is blocked by the DB (ON DELETE
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
 * `is_verified` / `verified_at` are stored now so that a future KYC gate in
 * `initiateWithdrawal` can enforce `isVerified === true` without any schema
 * migration. Currently, all accounts are created with `is_verified = false`
 * and withdrawals do not check this field.
 *
 * ── Column constraints ─────────────────────────────────────────────────────────
 *
 * `bank_account_number` and `bank_ifsc_code` are nullable because UPI accounts
 * do not have these fields. CHECK constraints enforce that:
 *   - bank_transfer accounts have non-null, non-empty account number + IFSC code.
 *   - upi accounts have a non-null, non-empty upi_id.
 */
export const userBankAccountsTable = pgTable(
  "user_bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    /**
     * Payout method. Determines which fields (bank vs UPI) are populated.
     * Immutable after creation — to change method, delete and re-add.
     */
    method: payoutMethodEnum("method").notNull(),
    accountHolderName: text("account_holder_name").notNull(),
    // ── Bank transfer fields (populated only when method = 'bank_transfer') ──
    // Stored as plain text. Encryption at rest (application-level or TDE) is
    // a future infrastructure concern.
    bankAccountNumber: text("bank_account_number"),
    // Standard Indian IFSC: 4 letters + '0' + 6 alphanumeric.
    bankIfscCode: text("bank_ifsc_code"),
    // Optional: populated from user input. Useful for display; not used in
    // payout API calls (which use account number + IFSC).
    bankName: text("bank_name"),
    // ── UPI fields (populated only when method = 'upi') ─────────────────────
    // UPI Virtual Payment Address (VPA), e.g. "alice@okhdfc".
    // Source may be manual entry or QR-code scan — the backend does not
    // distinguish between them; only the VPA string is stored.
    upiId: text("upi_id"),
    // ── KYC readiness fields ──────────────────────────────────────────────────
    isVerified: boolean("is_verified").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // ── Soft delete ────────────────────────────────────────────────────────────
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Primary query pattern: list all accounts for a user.
    index("user_bank_accounts_user_id_idx").on(table.userId),
    // Bank transfer: account number and IFSC are required and correctly formatted.
    check(
      "user_bank_accounts_bank_transfer_fields",
      sql`${table.method} != 'bank_transfer' OR (
        ${table.bankAccountNumber} IS NOT NULL
        AND length(trim(${table.bankAccountNumber})) > 0
        AND ${table.bankIfscCode} IS NOT NULL
        AND ${table.bankIfscCode} ~ '^[A-Z]{4}0[A-Z0-9]{6}$'
      )`,
    ),
    // UPI: upi_id is required and non-blank.
    check(
      "user_bank_accounts_upi_fields",
      sql`${table.method} != 'upi' OR (
        ${table.upiId} IS NOT NULL
        AND length(trim(${table.upiId})) > 0
      )`,
    ),
    // Holder name must not be blank (applies to all methods).
    check(
      "user_bank_accounts_holder_name_not_empty",
      sql`length(trim(${table.accountHolderName})) > 0`,
    ),
  ],
);

export const insertUserBankAccountSchema = createInsertSchema(userBankAccountsTable).omit({
  id: true,
  // KYC fields are set internally, never by the caller.
  isVerified: true,
  verifiedAt: true,
  // Soft-delete fields are managed internally.
  isDeleted: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUserBankAccount = z.infer<typeof insertUserBankAccountSchema>;
export type UserBankAccount = typeof userBankAccountsTable.$inferSelect;
