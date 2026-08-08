---
name: UPI payout multi-method implementation
description: Key decisions and invariants from the bank_transfer + UPI payout account feature
---

## Rule
`user_bank_accounts` uses a single unified table with a `payout_method` pgEnum discriminator (`bank_transfer | upi`). Bank columns (`bank_account_number`, `bank_ifsc_code`) are nullable; `upi_id` is nullable. DB CHECK constraints gate field presence on `method`.

**Why:** avoids a separate UPI table, keeps the FK chain from `withdrawals` simple, and allows atomic migrations (all additive — no renames, no FK changes).

## Rule
`SubmitPayoutInput` is a discriminated union on `method`. Only `submitPayout` in the provider implementations branches on method. `verifyPayout`, `parseWebhook`, reconciliation, completion, and webhook handling are all method-agnostic.

**Why:** the PayU Transfer Money API uses identical response/webhook format for both payout types; only the `var1` JSON in `make_transfer` differs.

## Rule
`InitiateWithdrawalInput.payoutAccountId` (not `bankAccountId`) is the request field. The DB FK column stays `bank_account_id` and the response field stays `bankAccountId` — only the input field was renamed.

**Why:** avoids DB migration while making the public API method-neutral.

## Rule
QR code scanning is frontend-only. The backend accepts `{ method: "upi", upiId: "extracted@vpa" }` regardless of VPA origin. No QR images, no scan metadata, no code-path branching.

## Rule
Snapshot columns on `withdrawals`: `snapshot_payout_method` (NOT NULL, default `bank_transfer` in migration), `snapshot_upi_id` (nullable). `snapshot_bank_account_number` and `snapshot_bank_ifsc_code` are now nullable (were NOT NULL). Non-null assertions in `withdrawal-submission.ts` are safe given service-layer invariants.

## Rule
`error class names kept as BankAccountNotFoundError / BankAccountInUseError` despite the table being multi-method. Changing them would break all test imports for no functional gain.

## How to apply
- Any new payout method (e.g. wallet-to-wallet) follows the same pattern: add enum value, add nullable column(s), extend `SubmitPayoutInput` union, branch only in `submitPayout`.
- DB push required after schema changes: `pnpm --filter @workspace/db run push`
- Client regen after OpenAPI changes: `pnpm --filter @workspace/api-spec run codegen`
