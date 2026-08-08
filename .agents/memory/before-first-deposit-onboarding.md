---
name: Before First Deposit Onboarding Module
description: Key decisions and constraints for the BFD onboarding feature (mobile, email, T&C).
---

## Rule: verifyPhoneToken is the only Firebase replacement point
The entire Firebase Phone Auth integration is isolated to `artifacts/api-server/src/lib/phone-verification.ts`.
The stub returns the token itself as the phone number (so tests send the phone number as `firebaseIdToken`).
No other route handler references Firebase directly.

**Why:** Agreed with user to defer Firebase; only this file changes at integration time.

**How to apply:** Never import Firebase Admin SDK outside `phone-verification.ts`.

---

## Rule: termsAcceptedAt must be on every test fixture that calls POST /withdrawals or POST /deposits/initiate via HTTP route
Both deposit and withdrawal routes now gate on `termsAcceptedAt` being non-null. Any fixture user that
triggers these routes through HTTP (not just through lib functions directly) must have `termsAcceptedAt: new Date()` in their DB insert.

**Why:** Missing this caused 2 withdrawal test failures on the first run (cancel user was missing it).

**How to apply:** When adding a new fixture to withdrawals.test.ts or deposits.test.ts that will POST to
`/api/withdrawals` or `/api/deposits/initiate`, always set `termsAcceptedAt: new Date()`.

---

## Rule: Gate order in POST /deposits/initiate
1. mobileNumber present
2. mobileVerificationStatus === "verified"
3. email present
4. termsAcceptedAt non-null  ← NEW
5. amount valid

**Why:** Matches the agreed onboarding sequence; T&C is the last gate before financial action.

---

## Rule: Gate order in POST /withdrawals
1. mobileNumber present
2. mobileVerificationStatus === "verified"
3. termsAcceptedAt non-null  ← NEW
4. Body (amount, bankAccountId, idempotencyKey) validation

---

## Rule: Mobile verification idempotency rules
- Resubmit same number while pending → 200 (no-op)
- Try to change while verified → 409 MOBILE_ALREADY_VERIFIED
- Already verified, call verify again → 200 (no-op)
- Token phone number ≠ stored number → 400 MOBILE_NUMBER_MISMATCH
- No mobile submitted, call verify → 400 MOBILE_NOT_SUBMITTED

---

## Rule: Database push required before tests
`psql` showed empty DB on first test run. Must run `pnpm --filter @workspace/db run push` before
running the test suite in a fresh environment.

**Why:** Tests hit a real PostgreSQL database; schema is deployed with drizzle-kit push (not migrations).

---

## Codegen names (for route handler imports)
- `SubmitMobileNumberBody` — validates POST /users/me/mobile body
- `VerifyMobileNumberBody` — validates POST /users/me/mobile/verify body
- `UpdateEmailBody` — validates PATCH /users/me/email body
- `GetCurrentUserResponse` / `SubmitMobileNumberResponse` / `VerifyMobileNumberResponse` / `UpdateEmailResponse` / `AcceptTermsResponse` — all are the same User shape; routes use `GetCurrentUserResponse.parse(...)` throughout.

---

## Mobile number format
Indian E.164 regex: `^\+91[6-9]\d{9}$`
Stored as-is. Uniqueness enforced at application layer (select before update).
