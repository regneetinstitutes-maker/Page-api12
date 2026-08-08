import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import app from "../app";
import { db, usersTable } from "@workspace/db";
import { createSession, SESSION_COOKIE_NAME } from "../lib/session";
import { hashPassword, PASSWORD_ALGO } from "../lib/password";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const prefix = `tus${Date.now()}`;

// Track all created user IDs for cleanup in afterAll.
const allUserIds: string[] = [];

// Per-fixture mobile number generator — mirrors the withdrawal test pattern.
let _mobileIndex = 0;
function nextMobile(): string {
  _mobileIndex += 1;
  return `+9198${String(_mobileIndex).padStart(3, "0")}${prefix.slice(-5)}`;
}

// ── Fixture: fresh user (not_started, no email, no terms) ─────────────────────
let freshUserId = "";
let freshCookie = "";
const FRESH_MOBILE = nextMobile(); // reserved for MOBILE_NUMBER_ALREADY_TAKEN tests

// ── Fixture: mobile-only user (not_started, no email, no terms) ───────────────
// Separate from freshUser so mobile-submission tests don't collide.
let mobileSubmitUserId = "";
let mobileSubmitCookie = "";

// ── Fixture: user already in "pending" state ──────────────────────────────────
let pendingUserId = "";
let pendingCookie = "";
const PENDING_MOBILE = nextMobile();

// ── Fixture: fully onboarded user (verified, email, terms) ────────────────────
let verifiedUserId = "";
let verifiedCookie = "";
const VERIFIED_MOBILE = nextMobile();
const VERIFIED_EMAIL = `${prefix}-verified@test.example`;

// ── Fixture: user whose mobile is taken (for 409 conflict test) ───────────────
let takenMobileUserId = "";
const TAKEN_MOBILE = nextMobile();

// ── Fixture: user whose email is taken (for 409 conflict test) ───────────────
let takenEmailUserId = "";
const TAKEN_EMAIL = `${prefix}-taken@test.example`;

// ── Fixture: user for email tests (starts with pending mobile) ────────────────
let emailTestUserId = "";
let emailTestCookie = "";

// ── Fixture: user for terms tests (has verified mobile + email) ───────────────
let termsTestUserId = "";
let termsCookie = "";
const TERMS_MOBILE = nextMobile();
const TERMS_EMAIL = `${prefix}-terms@test.example`;

// ── Fixture: second user for email idempotency / correction tests ──────────────
let emailIdempotentUserId = "";
let emailIdempotentCookie = "";

beforeAll(async () => {
  const pwHash = await hashPassword("TestPass123!");

  const sessionCookieFor = async (userId: string): Promise<string> => {
    const { token, expiresAt } = await createSession(userId);
    return `${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${expiresAt.toUTCString()}; HttpOnly`;
  };

  // 1. Fresh user — nothing set
  const [fresh] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-fresh`,
      name: "Fresh User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      // No mobile, email, or terms set — pure clean state.
    })
    .returning({ id: usersTable.id });
  freshUserId = fresh!.id;
  allUserIds.push(freshUserId);
  freshCookie = await sessionCookieFor(freshUserId);

  // 2. Mobile-submit test user — fresh (not_started)
  const [mobileSubmit] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-mobsub`,
      name: "Mobile Submit User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
    })
    .returning({ id: usersTable.id });
  mobileSubmitUserId = mobileSubmit!.id;
  allUserIds.push(mobileSubmitUserId);
  mobileSubmitCookie = await sessionCookieFor(mobileSubmitUserId);

  // 3. Pending user — mobileNumber submitted, status=pending
  const [pending] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-pending`,
      name: "Pending User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      mobileNumber: PENDING_MOBILE,
      mobileVerificationStatus: "pending",
    })
    .returning({ id: usersTable.id });
  pendingUserId = pending!.id;
  allUserIds.push(pendingUserId);
  pendingCookie = await sessionCookieFor(pendingUserId);

  // 4. Verified user — fully onboarded
  const [verified] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-verified`,
      name: "Verified User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: VERIFIED_EMAIL,
      mobileNumber: VERIFIED_MOBILE,
      mobileVerificationStatus: "verified",
      mobileVerifiedAt: new Date(),
      termsAcceptedAt: new Date(),
    })
    .returning({ id: usersTable.id });
  verifiedUserId = verified!.id;
  allUserIds.push(verifiedUserId);
  verifiedCookie = await sessionCookieFor(verifiedUserId);

  // 5. Taken-mobile user — occupies TAKEN_MOBILE
  const [takenMobile] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-tknmob`,
      name: "Taken Mobile User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      mobileNumber: TAKEN_MOBILE,
      mobileVerificationStatus: "pending",
    })
    .returning({ id: usersTable.id });
  takenMobileUserId = takenMobile!.id;
  allUserIds.push(takenMobileUserId);

  // 6. Taken-email user — occupies TAKEN_EMAIL
  const [takenEmail] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-tkneml`,
      name: "Taken Email User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: TAKEN_EMAIL,
    })
    .returning({ id: usersTable.id });
  takenEmailUserId = takenEmail!.id;
  allUserIds.push(takenEmailUserId);

  // 7. Email test user — starts with pending mobile (for email submission tests)
  const [emailTest] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-emltst`,
      name: "Email Test User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      mobileNumber: nextMobile(),
      mobileVerificationStatus: "pending",
    })
    .returning({ id: usersTable.id });
  emailTestUserId = emailTest!.id;
  allUserIds.push(emailTestUserId);
  emailTestCookie = await sessionCookieFor(emailTestUserId);

  // 8. Terms test user — verified mobile + email, no terms yet
  const [termsTest] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-trmtst`,
      name: "Terms Test User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: TERMS_EMAIL,
      mobileNumber: TERMS_MOBILE,
      mobileVerificationStatus: "verified",
      mobileVerifiedAt: new Date(),
    })
    .returning({ id: usersTable.id });
  termsTestUserId = termsTest!.id;
  allUserIds.push(termsTestUserId);
  termsCookie = await sessionCookieFor(termsTestUserId);

  // 9. Email idempotency/correction user — fresh state
  const [emailIdem] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-emlidem`,
      name: "Email Idem User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
    })
    .returning({ id: usersTable.id });
  emailIdempotentUserId = emailIdem!.id;
  allUserIds.push(emailIdempotentUserId);
  emailIdempotentCookie = await sessionCookieFor(emailIdempotentUserId);
});

afterAll(async () => {
  if (allUserIds.length > 0) {
    // Cascade deletes sessions and other child rows.
    await db.delete(usersTable).where(inArray(usersTable.id, allUserIds));
  }
});

// ── GET /api/users/me ─────────────────────────────────────────────────────────

describe("GET /api/users/me", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await request(app).get("/api/users/me");
    expect(res.status).toBe(401);
  });

  it("returns 200 with full profile including new onboarding fields", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Cookie", freshCookie);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(freshUserId);
    expect(res.body.username).toBe(`${prefix}-fresh`);
    // Onboarding fields
    expect(res.body.mobileVerificationStatus).toBe("not_started");
    expect(res.body.mobileNumber).toBeNull();
    expect(res.body.termsAcceptedAt).toBeNull();
  });

  it("reflects verified state for a fully onboarded user", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Cookie", verifiedCookie);

    expect(res.status).toBe(200);
    expect(res.body.mobileVerificationStatus).toBe("verified");
    expect(res.body.mobileNumber).toBe(VERIFIED_MOBILE);
    expect(res.body.email).toBe(VERIFIED_EMAIL);
    expect(res.body.termsAcceptedAt).not.toBeNull();
  });

  it("reflects pending state for a user with unverified mobile", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Cookie", pendingCookie);

    expect(res.status).toBe(200);
    expect(res.body.mobileVerificationStatus).toBe("pending");
    expect(res.body.mobileNumber).toBe(PENDING_MOBILE);
    expect(res.body.termsAcceptedAt).toBeNull();
  });

  it("slides the session — Set-Cookie header is present in the response", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Cookie", freshCookie);

    expect(res.status).toBe(200);
    const setCookieHeader = res.headers["set-cookie"] as string[] | string | undefined;
    expect(setCookieHeader).toBeDefined();
    const cookieStr = Array.isArray(setCookieHeader)
      ? setCookieHeader.join("; ")
      : setCookieHeader ?? "";
    expect(cookieStr).toContain(SESSION_COOKIE_NAME);
  });
});

// ── POST /api/users/me/mobile ─────────────────────────────────────────────────

describe("POST /api/users/me/mobile", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile")
      .send({ mobileNumber: "+919876543210" });

    expect(res.status).toBe(401);
  });

  it("returns 400 for a number missing the +91 prefix", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile")
      .set("Cookie", mobileSubmitCookie)
      .send({ mobileNumber: "9876543210" });

    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 for a number starting with an invalid digit (0–5)", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile")
      .set("Cookie", mobileSubmitCookie)
      .send({ mobileNumber: "+911234567890" });

    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 when mobileNumber is missing", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile")
      .set("Cookie", mobileSubmitCookie)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 409 MOBILE_NUMBER_ALREADY_TAKEN when the number belongs to another account", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile")
      .set("Cookie", mobileSubmitCookie)
      .send({ mobileNumber: TAKEN_MOBILE });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MOBILE_NUMBER_ALREADY_TAKEN");
    expect(typeof res.body.message).toBe("string");
  });

  // Happy path — modifies mobileSubmitUser state; must run before idempotency test.
  describe("valid submission", () => {
    const SUBMIT_MOBILE = nextMobile();
    let body: Record<string, unknown>;

    beforeAll(async () => {
      const res = await request(app)
        .post("/api/users/me/mobile")
        .set("Cookie", mobileSubmitCookie)
        .send({ mobileNumber: SUBMIT_MOBILE });

      expect(res.status).toBe(200);
      body = res.body as Record<string, unknown>;
    });

    it("returns mobileVerificationStatus=pending", () => {
      expect(body.mobileVerificationStatus).toBe("pending");
    });

    it("returns the submitted mobileNumber", () => {
      expect(body.mobileNumber).toBe(SUBMIT_MOBILE);
    });

    it("persists mobileNumber and status to the database", async () => {
      const [row] = await db
        .select({
          mobileNumber: usersTable.mobileNumber,
          mobileVerificationStatus: usersTable.mobileVerificationStatus,
        })
        .from(usersTable)
        .where(
          (await import("drizzle-orm")).eq(usersTable.id, mobileSubmitUserId),
        );

      expect(row?.mobileNumber).toBe(SUBMIT_MOBILE);
      expect(row?.mobileVerificationStatus).toBe("pending");
    });

    it("is idempotent — resubmitting the same number while pending returns 200 without error", async () => {
      const res = await request(app)
        .post("/api/users/me/mobile")
        .set("Cookie", mobileSubmitCookie)
        .send({ mobileNumber: SUBMIT_MOBILE });

      expect(res.status).toBe(200);
      expect(res.body.mobileVerificationStatus).toBe("pending");
      expect(res.body.mobileNumber).toBe(SUBMIT_MOBILE);
    });
  });

  it("returns 409 MOBILE_ALREADY_VERIFIED when mobile is already verified", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile")
      .set("Cookie", verifiedCookie)
      .send({ mobileNumber: nextMobile() });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MOBILE_ALREADY_VERIFIED");
    expect(typeof res.body.message).toBe("string");
  });
});

// ── POST /api/users/me/mobile/verify ─────────────────────────────────────────

describe("POST /api/users/me/mobile/verify", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile/verify")
      .send({ firebaseIdToken: PENDING_MOBILE });

    expect(res.status).toBe(401);
  });

  it("returns 400 when firebaseIdToken is missing", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile/verify")
      .set("Cookie", pendingCookie)
      .send({});

    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 MOBILE_NOT_SUBMITTED when no mobile number has been submitted", async () => {
    const res = await request(app)
      .post("/api/users/me/mobile/verify")
      .set("Cookie", freshCookie)
      .send({ firebaseIdToken: "+919876543210" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MOBILE_NOT_SUBMITTED");
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 MOBILE_NUMBER_MISMATCH when token phone number does not match stored number", async () => {
    // The stub treats the token as the phone number itself.
    // Submit a different number than PENDING_MOBILE to trigger a mismatch.
    const res = await request(app)
      .post("/api/users/me/mobile/verify")
      .set("Cookie", pendingCookie)
      .send({ firebaseIdToken: "+919111111111" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MOBILE_NUMBER_MISMATCH");
    expect(typeof res.body.message).toBe("string");
  });

  // Happy path — modifies pendingUser state. Must run before idempotency test.
  describe("valid verification", () => {
    let body: Record<string, unknown>;

    beforeAll(async () => {
      // The stub verifyPhoneToken treats the token as the phone number.
      const res = await request(app)
        .post("/api/users/me/mobile/verify")
        .set("Cookie", pendingCookie)
        .send({ firebaseIdToken: PENDING_MOBILE });

      expect(res.status).toBe(200);
      body = res.body as Record<string, unknown>;
    });

    it("returns mobileVerificationStatus=verified", () => {
      expect(body.mobileVerificationStatus).toBe("verified");
    });

    it("returns the verified mobileNumber", () => {
      expect(body.mobileNumber).toBe(PENDING_MOBILE);
    });

    it("persists mobileVerificationStatus=verified to the database", async () => {
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select({
          mobileVerificationStatus: usersTable.mobileVerificationStatus,
          mobileVerifiedAt: usersTable.mobileVerifiedAt,
        })
        .from(usersTable)
        .where(eq(usersTable.id, pendingUserId));

      expect(row?.mobileVerificationStatus).toBe("verified");
      expect(row?.mobileVerifiedAt).not.toBeNull();
    });

    it("is idempotent — calling verify again while already verified returns 200", async () => {
      const res = await request(app)
        .post("/api/users/me/mobile/verify")
        .set("Cookie", pendingCookie)
        .send({ firebaseIdToken: PENDING_MOBILE });

      expect(res.status).toBe(200);
      expect(res.body.mobileVerificationStatus).toBe("verified");
    });
  });
});

// ── PATCH /api/users/me/email ─────────────────────────────────────────────────

describe("PATCH /api/users/me/email", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await request(app)
      .patch("/api/users/me/email")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid email format", async () => {
    const res = await request(app)
      .patch("/api/users/me/email")
      .set("Cookie", emailTestCookie)
      .send({ email: "notanemail" });

    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 when email field is missing", async () => {
    const res = await request(app)
      .patch("/api/users/me/email")
      .set("Cookie", emailTestCookie)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 409 EMAIL_ALREADY_TAKEN when the address belongs to another account", async () => {
    const res = await request(app)
      .patch("/api/users/me/email")
      .set("Cookie", emailTestCookie)
      .send({ email: TAKEN_EMAIL });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_ALREADY_TAKEN");
    expect(typeof res.body.message).toBe("string");
  });

  // Happy path — modifies emailTestUser state.
  describe("valid email submission", () => {
    const SUBMIT_EMAIL = `${prefix}-Submit@Test.EXAMPLE`;
    const SUBMIT_EMAIL_LOWER = SUBMIT_EMAIL.toLowerCase();
    let body: Record<string, unknown>;

    beforeAll(async () => {
      const res = await request(app)
        .patch("/api/users/me/email")
        .set("Cookie", emailTestCookie)
        .send({ email: SUBMIT_EMAIL });

      expect(res.status).toBe(200);
      body = res.body as Record<string, unknown>;
    });

    it("returns the email normalized to lowercase", () => {
      expect(body.email).toBe(SUBMIT_EMAIL_LOWER);
    });

    it("persists the email to the database in lowercase", async () => {
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select({ email: usersTable.email })
        .from(usersTable)
        .where(eq(usersTable.id, emailTestUserId));

      expect(row?.email).toBe(SUBMIT_EMAIL_LOWER);
    });

    it("is idempotent — resubmitting the same address returns 200 without error", async () => {
      const res = await request(app)
        .patch("/api/users/me/email")
        .set("Cookie", emailTestCookie)
        .send({ email: SUBMIT_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(SUBMIT_EMAIL_LOWER);
    });
  });

  it("allows correcting a typo — a different email can replace an existing one", async () => {
    const originalEmail = `${prefix}-orig@test.example`;
    const correctedEmail = `${prefix}-corrected@test.example`;

    // Set an initial email.
    const first = await request(app)
      .patch("/api/users/me/email")
      .set("Cookie", emailIdempotentCookie)
      .send({ email: originalEmail });
    expect(first.status).toBe(200);
    expect(first.body.email).toBe(originalEmail);

    // Correct it.
    const second = await request(app)
      .patch("/api/users/me/email")
      .set("Cookie", emailIdempotentCookie)
      .send({ email: correctedEmail });
    expect(second.status).toBe(200);
    expect(second.body.email).toBe(correctedEmail);
  });
});

// ── POST /api/users/me/terms ──────────────────────────────────────────────────

describe("POST /api/users/me/terms", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await request(app).post("/api/users/me/terms");
    expect(res.status).toBe(401);
  });

  // Happy path — modifies termsTestUser state. Must run before idempotency test.
  describe("first acceptance", () => {
    let body: Record<string, unknown>;
    let acceptedAt: string;

    beforeAll(async () => {
      const res = await request(app)
        .post("/api/users/me/terms")
        .set("Cookie", termsCookie);

      expect(res.status).toBe(200);
      body = res.body as Record<string, unknown>;
      acceptedAt = body.termsAcceptedAt as string;
    });

    it("returns a non-null termsAcceptedAt timestamp", () => {
      expect(body.termsAcceptedAt).not.toBeNull();
      expect(typeof body.termsAcceptedAt).toBe("string");
    });

    it("persists termsAcceptedAt to the database", async () => {
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select({ termsAcceptedAt: usersTable.termsAcceptedAt })
        .from(usersTable)
        .where(eq(usersTable.id, termsTestUserId));

      expect(row?.termsAcceptedAt).not.toBeNull();
    });

    it("is idempotent — calling again returns 200 without overwriting the original timestamp", async () => {
      const res = await request(app)
        .post("/api/users/me/terms")
        .set("Cookie", termsCookie);

      expect(res.status).toBe(200);
      expect(res.body.termsAcceptedAt).toBe(acceptedAt);
    });
  });
});
