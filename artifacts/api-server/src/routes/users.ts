/**
 * User profile routes.
 *
 * ── GET /users/me ──────────────────────────────────────────────────────────────
 *   Returns the authenticated user's profile, including onboarding state.
 *
 * ── POST /users/me/mobile ─────────────────────────────────────────────────────
 *   Records the user's Indian mobile number (+91…) and transitions
 *   mobileVerificationStatus from not_started → pending.
 *
 * ── POST /users/me/mobile/verify ──────────────────────────────────────────────
 *   Verifies the mobile number via verifyPhoneToken() (stub pre-Firebase;
 *   replace only that function when Firebase is ready). Sets status → verified.
 *
 * ── PATCH /users/me/email ─────────────────────────────────────────────────────
 *   Stores the user's email address (lowercase, unique).
 *
 * ── POST /users/me/terms ──────────────────────────────────────────────────────
 *   Records Terms & Conditions acceptance (idempotent).
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import type { User as DbUser } from "@workspace/db";
import {
  GetCurrentUserResponse,
  SubmitMobileNumberBody,
  VerifyMobileNumberBody,
  UpdateEmailBody,
} from "@workspace/api-zod";
import { requireSession } from "../middlewares/requireSession";
import { verifyPhoneToken } from "../lib/phone-verification";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Maps a DB user row to the API response shape for all user-profile endpoints.
 * Used by the update endpoints (which return the freshly updated row).
 */
function toUserProfileResponse(user: DbUser) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    age: user.age,
    email: user.email ?? null,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt,
    mobileNumber: user.mobileNumber ?? null,
    mobileVerificationStatus: user.mobileVerificationStatus,
    termsAcceptedAt: user.termsAcceptedAt ?? null,
  };
}

// ── GET /users/me ─────────────────────────────────────────────────────────────

/**
 * Returns the authenticated user's full profile, including onboarding state.
 *
 * 200 — User profile with mobileVerificationStatus and termsAcceptedAt.
 * 401 — Not authenticated.
 */
router.get("/users/me", requireSession, (req, res): void => {
  // requireSession guarantees req.user is set before next() is called.
  // The AuthenticatedUser type now carries all onboarding fields, so
  // GetCurrentUserResponse.parse strips to only what the schema declares.
  res.status(200).json(GetCurrentUserResponse.parse(req.user));
});

// ── POST /users/me/mobile ─────────────────────────────────────────────────────

/**
 * Records the user's Indian mobile number and starts verification.
 *
 * Transitions mobileVerificationStatus: not_started → pending.
 * Idempotent if the same number is resubmitted while still pending.
 *
 * 200 — Mobile number recorded; mobileVerificationStatus is pending.
 * 400 — Invalid E.164 format.
 * 401 — Not authenticated.
 * 409 — Number belongs to another account, or mobile is already verified.
 */
router.post("/users/me/mobile", requireSession, async (req, res): Promise<void> => {
  const parsed = SubmitMobileNumberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const { mobileNumber } = parsed.data;
  const user = req.user!;

  // A verified mobile cannot be changed through this endpoint.
  if (user.mobileVerificationStatus === "verified") {
    res.status(409).json({
      code: "MOBILE_ALREADY_VERIFIED",
      message: "Your mobile number has already been verified and cannot be changed.",
    });
    return;
  }

  // Idempotent: resubmitting the same number while pending is a no-op.
  if (user.mobileVerificationStatus === "pending" && user.mobileNumber === mobileNumber) {
    const [fresh] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1);
    res.status(200).json(GetCurrentUserResponse.parse(toUserProfileResponse(fresh!)));
    return;
  }

  // Uniqueness check: the number must not belong to another account.
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.mobileNumber, mobileNumber))
    .limit(1);

  if (existing && existing.id !== user.id) {
    res.status(409).json({
      code: "MOBILE_NUMBER_ALREADY_TAKEN",
      message: "This mobile number is already registered to another account.",
    });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({
      mobileNumber,
      mobileVerificationStatus: "pending",
    })
    .where(eq(usersTable.id, user.id))
    .returning();

  res.status(200).json(GetCurrentUserResponse.parse(toUserProfileResponse(updated!)));
});

// ── POST /users/me/mobile/verify ──────────────────────────────────────────────

/**
 * Verifies the user's mobile number using a phone authentication token.
 *
 * The token is processed by verifyPhoneToken() — a single abstraction layer
 * that currently runs a pre-Firebase stub. To integrate Firebase Phone Auth,
 * replace only the implementation inside verifyPhoneToken() in
 * src/lib/phone-verification.ts. This route handler never changes.
 *
 * Transitions mobileVerificationStatus: pending → verified.
 * Idempotent if already verified (returns 200).
 *
 * 200 — Mobile number verified.
 * 400 — Mobile not submitted, token invalid, or phone number mismatch.
 * 401 — Not authenticated.
 */
router.post("/users/me/mobile/verify", requireSession, async (req, res): Promise<void> => {
  const parsed = VerifyMobileNumberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const user = req.user!;

  // Mobile must have been submitted before it can be verified.
  if (user.mobileVerificationStatus === "not_started") {
    res.status(400).json({
      code: "MOBILE_NOT_SUBMITTED",
      message:
        "No mobile number has been submitted. Call POST /users/me/mobile first.",
    });
    return;
  }

  // Idempotent: already verified — return the current profile without changes.
  if (user.mobileVerificationStatus === "verified") {
    const [fresh] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1);
    res.status(200).json(GetCurrentUserResponse.parse(toUserProfileResponse(fresh!)));
    return;
  }

  // Delegate token verification to the abstraction layer.
  // Only this layer will change when Firebase is integrated.
  let verifiedPhoneNumber: string;
  try {
    const result = await verifyPhoneToken(parsed.data.firebaseIdToken);
    verifiedPhoneNumber = result.phoneNumber;
  } catch {
    res.status(400).json({
      code: "TOKEN_VERIFICATION_FAILED",
      message: "Phone authentication token could not be verified.",
    });
    return;
  }

  // The phone number returned by the token must match what the user submitted.
  if (verifiedPhoneNumber !== user.mobileNumber) {
    res.status(400).json({
      code: "MOBILE_NUMBER_MISMATCH",
      message:
        "The phone number in the token does not match the submitted mobile number.",
    });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({
      mobileVerificationStatus: "verified",
      mobileVerifiedAt: new Date(),
    })
    .where(eq(usersTable.id, user.id))
    .returning();

  res.status(200).json(GetCurrentUserResponse.parse(toUserProfileResponse(updated!)));
});

// ── PATCH /users/me/email ─────────────────────────────────────────────────────

/**
 * Sets or updates the user's email address.
 *
 * Normalises to lowercase before storing. Idempotent if the same address is
 * submitted again. Allows correcting a typo before the first deposit. Returns
 * an error if the address is already registered to another account.
 *
 * 200 — Email stored.
 * 400 — Invalid format.
 * 401 — Not authenticated.
 * 409 — Email already registered to another account.
 */
router.patch("/users/me/email", requireSession, async (req, res): Promise<void> => {
  const parsed = UpdateEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const user = req.user!;

  // Idempotent: resubmitting the same email is a no-op.
  if (user.email === email) {
    const [fresh] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1);
    res.status(200).json(GetCurrentUserResponse.parse(toUserProfileResponse(fresh!)));
    return;
  }

  // Uniqueness check: the email must not belong to another account.
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing && existing.id !== user.id) {
    res.status(409).json({
      code: "EMAIL_ALREADY_TAKEN",
      message: "This email address is already registered to another account.",
    });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ email })
    .where(eq(usersTable.id, user.id))
    .returning();

  res.status(200).json(GetCurrentUserResponse.parse(toUserProfileResponse(updated!)));
});

// ── POST /users/me/terms ──────────────────────────────────────────────────────

/**
 * Records acceptance of Terms & Conditions.
 *
 * Idempotent — repeated calls return 200 without overwriting the original
 * acceptance timestamp.
 *
 * 200 — Terms accepted (or were already accepted).
 * 401 — Not authenticated.
 */
router.post("/users/me/terms", requireSession, async (req, res): Promise<void> => {
  const user = req.user!;

  // Idempotent: terms already accepted — return current profile without changes.
  if (user.termsAcceptedAt !== null) {
    const [fresh] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1);
    res.status(200).json(GetCurrentUserResponse.parse(toUserProfileResponse(fresh!)));
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ termsAcceptedAt: new Date() })
    .where(eq(usersTable.id, user.id))
    .returning();

  res.status(200).json(GetCurrentUserResponse.parse(toUserProfileResponse(updated!)));
});

export default router;
