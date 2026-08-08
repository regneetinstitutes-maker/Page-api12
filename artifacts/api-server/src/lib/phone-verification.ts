/**
 * Phone authentication verification abstraction.
 *
 * This module is the single seam for Firebase Phone Authentication. The entire
 * Firebase integration is isolated here so the route handler never needs to
 * change when Firebase is added.
 *
 * ── Current implementation ────────────────────────────────────────────────────
 *
 *   STUB / PRE-FIREBASE: `verifyPhoneToken` treats the token as the phone
 *   number itself (self-referential mock). This allows the endpoint and its
 *   full test suite to be exercised before Firebase is available.
 *
 * ── Firebase integration (replace only this file's implementation) ────────────
 *
 *   1. Add firebase-admin to the api-server package:
 *        pnpm --filter @workspace/api-server add firebase-admin
 *
 *   2. Set the FIREBASE_PROJECT_ID environment secret (or a service account
 *      JSON via GOOGLE_APPLICATION_CREDENTIALS).
 *
 *   3. Replace the body of verifyPhoneToken with:
 *
 *        import admin from "firebase-admin";
 *
 *        if (!admin.apps.length) {
 *          admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
 *        }
 *
 *        const decoded = await admin.auth().verifyIdToken(token);
 *        if (!decoded.phone_number) {
 *          throw new Error("Firebase token does not contain a phone number claim.");
 *        }
 *        return { phoneNumber: decoded.phone_number };
 *
 *   4. No route changes, no schema changes, no test changes are required.
 */

export interface PhoneVerificationResult {
  /** Verified phone number in E.164 format (e.g. "+919876543210"). */
  phoneNumber: string;
}

/**
 * Verifies a phone authentication token and returns the verified phone number.
 *
 * CURRENT IMPLEMENTATION — STUB (pre-Firebase):
 *   The token is treated as the phone number itself. Any E.164-formatted string
 *   passed as the token is returned as the verified phone number. Replace this
 *   implementation with Firebase Admin SDK verification after deployment.
 *
 * @param token - In production: a Firebase Phone Auth ID token. In the stub:
 *                the phone number in E.164 format used as a self-referential mock.
 * @returns The verified phone number in E.164 format.
 * @throws If token verification fails (not used by the stub, but the contract
 *         is established for the Firebase implementation).
 */
export async function verifyPhoneToken(token: string): Promise<PhoneVerificationResult> {
  // ── STUB IMPLEMENTATION ──────────────────────────────────────────────────────
  // The token is the phone number. Replace this with Firebase Admin SDK.
  return { phoneNumber: token };
}
