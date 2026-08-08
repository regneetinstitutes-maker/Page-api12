// Set env vars before any module that reads process.env is imported.
process.env["PAYU_KEY"] = "wd-test-key";
process.env["PAYU_SALT"] = "wd-test-salt";
process.env["PAYU_ENV"] = "test";
process.env["PAYU_SURL"] = "https://example.com/success";
process.env["PAYU_FURL"] = "https://example.com/failure";
process.env["PAYU_PAYOUT_KEY"] = "wd-payout-test-key";
process.env["PAYU_PAYOUT_SALT"] = "wd-payout-test-salt";

/**
 * Mock resolvePayoutProvider so payout webhook tests never make real HTTP calls
 * and can accept any body built by _mockProvider.buildWebhookEvent.
 */
import { vi } from "vitest";

const _mockProvider = vi.hoisted(() => {
  return {
    name: "mock" as const,
    buildWebhookEvent(
      outcome: "success" | "failure",
      withdrawalId: string,
      providerReference: string,
      reason?: string,
    ) {
      return { _mock: true, outcome, withdrawalId, providerReference, reason: reason ?? "" };
    },
    parseWebhook(body: Record<string, unknown>, _headers: Record<string, string>) {
      if (body["_mock"] !== true) return null;
      const { withdrawalId, providerReference, outcome, reason } = body as {
        withdrawalId: unknown;
        providerReference: unknown;
        outcome: unknown;
        reason: unknown;
      };
      if (typeof withdrawalId !== "string" || typeof providerReference !== "string") return null;
      if (outcome !== "success" && outcome !== "failure") return null;
      if (outcome === "success") {
        return { outcome: "success" as const, providerReference, withdrawalId };
      }
      return {
        outcome: "failure" as const,
        providerReference,
        withdrawalId,
        reason: typeof reason === "string" ? reason : "Unknown failure",
      };
    },
    async submitPayout() {
      return { outcome: "accepted" as const, providerReference: "MOCK_REF" };
    },
    async verifyPayout(ref: string, _id: string) {
      return { outcome: "success" as const, providerReference: ref };
    },
  };
});

vi.mock("../lib/payout/provider", async (importActual) => {
  const actual = await importActual<typeof import("../lib/payout/provider")>();
  return { ...actual, resolvePayoutProvider: () => _mockProvider };
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import app from "../app";
import {
  db,
  usersTable,
  walletAccountsTable,
  walletTransactionsTable,
  walletReservationsTable,
  withdrawalsTable,
  userBankAccountsTable,
  userSessionsTable,
  type Withdrawal,
} from "@workspace/db";
import { hashPassword, PASSWORD_ALGO } from "../lib/password";
import { createSession, SESSION_COOKIE_NAME } from "../lib/session";
import { createWalletAccountsForUser, recordCompletedTransaction } from "../lib/wallet";
import { addBankAccount } from "../lib/bank-account";
import { initiateWithdrawal, MINIMUM_WITHDRAWAL_AMOUNT } from "../lib/withdrawal";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const prefix = `twd${Date.now()}`;

// Track all created users and wallet accounts for cleanup.
const allUserIds: string[] = [];
const allWalletAccountIds: string[] = [];

let _mobileIndex = 0;
function nextMobile(): string {
  _mobileIndex += 1;
  return `+91${String(_mobileIndex).padStart(3, "0")}${prefix.slice(-7)}`;
}

// ── Primary test user (for POST /withdrawals, GET /withdrawals route tests) ──
let userId = "";
let userId2 = "";     // second user — for ownership enforcement tests
let sessionToken = "";
let sessionToken2 = "";
let noTermsSessionToken = "";
let winningAccountId = "";
let walletAccountIds: string[] = [];
/** ID of the primary user's pre-registered bank_transfer payout account. */
let payoutAccountId = "";
/** ID of the primary user's pre-registered UPI payout account. */
let upiPayoutAccountId = "";

// ── Withdrawal-scenario users (each owns exactly one withdrawal) ──────────────
//
// The partial unique index (one active withdrawal per user) prevents two
// 'reserved' or 'processing' withdrawals from coexisting for the same user.
// Each withdrawal scenario therefore gets its own isolated user.
let sessionTokenCancel = "";      // owns wCancel
let sessionTokenCancelProc = "";  // owns wCancelProcessing
let payoutAccountIdCancel = "";   // userCancelId's payout account (for idempotency tests)

// Pre-created withdrawals (one per scenario).
let wCancel: Withdrawal;          // 'reserved' — will be cancelled by the idempotency test
let wCancelProcessing: Withdrawal; // 'processing' — cannot cancel
let wWebhookSuccess: Withdrawal;  // 'processing' for webhook test
let wWebhookFailure: Withdrawal;  // 'processing' for webhook test
let wWebhookAlreadyDone: Withdrawal; // 'completed' before webhook arrives

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const pwHash = await hashPassword("TestPass123!");

  // ── Primary user (userId) — clean slate, no pre-created withdrawals ──
  const [u1] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-u1`,
      name: "Withdrawal Route Tester",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}u1@test.example`,
      mobileNumber: nextMobile(),
      mobileVerificationStatus: "verified",
      termsAcceptedAt: new Date(),
    })
    .returning({ id: usersTable.id });
  userId = u1!.id;
  allUserIds.push(userId);

  const s1 = await createSession(userId);
  sessionToken = s1.token;

  const accounts1 = await createWalletAccountsForUser(db, userId);
  walletAccountIds = accounts1.map((a) => a.id);
  allWalletAccountIds.push(...walletAccountIds);
  const winning1 = accounts1.find((a) => a.walletType === "winning_coins")!;
  winningAccountId = winning1.id;

  await db.transaction(async (tx) => {
    await recordCompletedTransaction(tx, {
      walletAccountId: winningAccountId,
      amount: MINIMUM_WITHDRAWAL_AMOUNT * 20,
      idempotencyKey: `${prefix}:u1:seed`,
      referenceType: "test_seed",
      description: "Initial test balance",
    });
  });

  // Pre-register a bank_transfer payout account for the primary user.
  const account1 = await addBankAccount({
    userId,
    method: "bank_transfer",
    accountHolderName: "Withdrawal Route Tester",
    bankAccountNumber: "55566677788",
    bankIfscCode: "ICIC0005566",
    bankName: "ICICI Bank",
  });
  payoutAccountId = account1.id;

  // Pre-register a UPI payout account for the primary user (for UPI tests).
  const upiAccount1 = await addBankAccount({
    userId,
    method: "upi",
    accountHolderName: "Withdrawal Route Tester",
    upiId: "withdrawtester@okhdfc",
  });
  upiPayoutAccountId = upiAccount1.id;

  // ── Secondary user (userId2) — no withdrawals, for ownership tests ──
  const [u2] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-u2`,
      name: "Other User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}u2@test.example`,
      mobileNumber: nextMobile(),
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  userId2 = u2!.id;
  allUserIds.push(userId2);

  const s2 = await createSession(userId2);
  sessionToken2 = s2.token;

  // ── noTermsUser — verified mobile + email, but NO termsAcceptedAt ──
  // Used only for the TERMS_NOT_ACCEPTED gate test on POST /withdrawals.
  const [uNoTerms] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-noterms`,
      name: "NoTerms User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}noterms@test.example`,
      mobileNumber: nextMobile(),
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  const noTermsUserId = uNoTerms!.id;
  allUserIds.push(noTermsUserId);
  const sNoTerms = await createSession(noTermsUserId);
  noTermsSessionToken = sNoTerms.token;

  // ── userCancelId — owns wCancel ──
  const [uCancel] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-cancel`,
      name: "Cancel Tester",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}cancel@test.example`,
      mobileNumber: nextMobile(),
      mobileVerificationStatus: "verified",
      termsAcceptedAt: new Date(),
    })
    .returning({ id: usersTable.id });
  const userCancelId = uCancel!.id;
  allUserIds.push(userCancelId);

  const sCancel = await createSession(userCancelId);
  sessionTokenCancel = sCancel.token;

  const accountsCancel = await createWalletAccountsForUser(db, userCancelId);
  allWalletAccountIds.push(...accountsCancel.map((a) => a.id));
  const winningCancel = accountsCancel.find((a) => a.walletType === "winning_coins")!;

  await db.transaction(async (tx) => {
    await recordCompletedTransaction(tx, {
      walletAccountId: winningCancel.id,
      amount: MINIMUM_WITHDRAWAL_AMOUNT * 10,
      idempotencyKey: `${prefix}:cancel:seed`,
      referenceType: "test_seed",
      description: "Initial test balance",
    });
  });

  const acctCancel = await addBankAccount({
    userId: userCancelId,
    method: "bank_transfer",
    accountHolderName: "Cancel Tester",
    bankAccountNumber: "55566677788",
    bankIfscCode: "ICIC0005566",
    bankName: "ICICI Bank",
  });
  payoutAccountIdCancel = acctCancel.id;

  const { withdrawal: wc } = await db.transaction(async (tx) =>
    initiateWithdrawal(tx, {
      userId: userCancelId,
      amount: MINIMUM_WITHDRAWAL_AMOUNT,
      payoutAccountId: payoutAccountIdCancel,
      idempotencyKey: `${prefix}:cancel`,
    }),
  );
  wCancel = wc;

  // ── userCancelProcId — owns wCancelProcessing ──
  const [uCancelProc] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-cancelproc`,
      name: "Cancel Proc Tester",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}cancelproc@test.example`,
      mobileNumber: nextMobile(),
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  const userCancelProcId = uCancelProc!.id;
  allUserIds.push(userCancelProcId);

  const sCancelProc = await createSession(userCancelProcId);
  sessionTokenCancelProc = sCancelProc.token;

  const accountsCancelProc = await createWalletAccountsForUser(db, userCancelProcId);
  allWalletAccountIds.push(...accountsCancelProc.map((a) => a.id));
  const winningCancelProc = accountsCancelProc.find((a) => a.walletType === "winning_coins")!;

  await db.transaction(async (tx) => {
    await recordCompletedTransaction(tx, {
      walletAccountId: winningCancelProc.id,
      amount: MINIMUM_WITHDRAWAL_AMOUNT * 10,
      idempotencyKey: `${prefix}:cancelproc:seed`,
      referenceType: "test_seed",
      description: "Initial test balance",
    });
  });

  const acctCancelProc = await addBankAccount({
    userId: userCancelProcId,
    method: "bank_transfer",
    accountHolderName: "Cancel Proc Tester",
    bankAccountNumber: "55566677788",
    bankIfscCode: "ICIC0005566",
    bankName: "ICICI Bank",
  });

  const { withdrawal: wcp } = await db.transaction(async (tx) =>
    initiateWithdrawal(tx, {
      userId: userCancelProcId,
      amount: MINIMUM_WITHDRAWAL_AMOUNT,
      payoutAccountId: acctCancelProc.id,
      idempotencyKey: `${prefix}:cancelproc`,
    }),
  );
  wCancelProcessing = wcp;

  // ── Webhook scenario users (no sessions needed; webhooks don't use auth) ──

  const createWebhookScenario = async (key: string): Promise<Withdrawal> => {
    const [u] = await db
      .insert(usersTable)
      .values({
        username: `${prefix}-${key}`,
        name: `Webhook ${key}`,
        age: 25,
        passwordHash: pwHash,
        passwordAlgo: PASSWORD_ALGO,
        email: `${prefix}${key}@test.example`,
        mobileNumber: nextMobile(),
        mobileVerificationStatus: "verified",
      })
      .returning({ id: usersTable.id });
    const uId = u!.id;
    allUserIds.push(uId);

    const accts = await createWalletAccountsForUser(db, uId);
    allWalletAccountIds.push(...accts.map((a) => a.id));
    const winning = accts.find((a) => a.walletType === "winning_coins")!;

    await db.transaction(async (tx) => {
      await recordCompletedTransaction(tx, {
        walletAccountId: winning.id,
        amount: MINIMUM_WITHDRAWAL_AMOUNT * 10,
        idempotencyKey: `${prefix}:${key}:seed`,
        referenceType: "test_seed",
        description: "Initial test balance",
      });
    });

    const acct = await addBankAccount({
      userId: uId,
      method: "bank_transfer",
      accountHolderName: `Webhook ${key}`,
      bankAccountNumber: "55566677788",
      bankIfscCode: "ICIC0005566",
      bankName: "ICICI Bank",
    });

    const { withdrawal } = await db.transaction(async (tx) =>
      initiateWithdrawal(tx, {
        userId: uId,
        amount: MINIMUM_WITHDRAWAL_AMOUNT,
        payoutAccountId: acct.id,
        idempotencyKey: `${prefix}:${key}`,
      }),
    );
    return withdrawal;
  };

  wWebhookSuccess = await createWebhookScenario("webhooksuccess");
  wWebhookFailure = await createWebhookScenario("webhookfailure");
  wWebhookAlreadyDone = await createWebhookScenario("webhookalreadydone");

  // Advance appropriate withdrawals to 'processing' state.
  const advanceToProcessing = async (w: Withdrawal): Promise<Withdrawal> => {
    const [updated] = await db
      .update(withdrawalsTable)
      .set({
        status: "processing",
        provider: "mock",
        providerReference: `MOCK_REF_${w.id}`,
        providerSubmittedAt: new Date(),
      })
      .where(eq(withdrawalsTable.id, w.id))
      .returning();
    return updated!;
  };

  wCancelProcessing = await advanceToProcessing(wCancelProcessing);
  wWebhookSuccess = await advanceToProcessing(wWebhookSuccess);
  wWebhookFailure = await advanceToProcessing(wWebhookFailure);
  wWebhookAlreadyDone = await advanceToProcessing(wWebhookAlreadyDone);

  // wWebhookAlreadyDone: advance to 'completed' so we can test the idempotency guard.
  await db
    .update(withdrawalsTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(withdrawalsTable.id, wWebhookAlreadyDone.id));
});

afterAll(async () => {
  if (allUserIds.length === 0) return;

  await db.delete(withdrawalsTable).where(inArray(withdrawalsTable.userId, allUserIds));
  await db
    .delete(walletReservationsTable)
    .where(inArray(walletReservationsTable.walletAccountId, allWalletAccountIds));
  await db
    .delete(walletTransactionsTable)
    .where(inArray(walletTransactionsTable.walletAccountId, allWalletAccountIds));
  await db
    .delete(userBankAccountsTable)
    .where(inArray(userBankAccountsTable.userId, allUserIds));
  await db
    .delete(walletAccountsTable)
    .where(inArray(walletAccountsTable.id, allWalletAccountIds));
  await db.delete(userSessionsTable).where(inArray(userSessionsTable.userId, allUserIds));
  await db.delete(usersTable).where(inArray(usersTable.id, allUserIds));
});

// ── Helpers ────────────────────────────────────────────────────────────────────

// request.agent(app) returns a persistent SuperTest agent that supports .set()
// before calling a method — unlike request(app) which requires a method first.
function authed(token: string) {
  return request.agent(app).set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
}

async function getWithdrawalFromDb(id: string) {
  const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, id));
  return w!;
}

// ── POST /withdrawals ─────────────────────────────────────────────────────────

describe("POST /api/withdrawals", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app)
      .post("/api/withdrawals")
      .send({ amount: 100, payoutAccountId, idempotencyKey: "idem-unauth" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when the user has no mobile number", async () => {
    // Create a user without a mobile number.
    const [noMobileUser] = await db
      .insert(usersTable)
      .values({
        username: `${prefix}-nomobile`,
        name: "No Mobile",
        age: 25,
        passwordHash: "x",
        passwordAlgo: PASSWORD_ALGO,
        email: `${prefix}nomobile@test.example`,
      })
      .returning({ id: usersTable.id });
    const { token } = await createSession(noMobileUser!.id);

    const res = await request.agent(app)
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`)
      .post("/api/withdrawals")
      .send({ amount: 100, payoutAccountId, idempotencyKey: "idem-nomobile" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MOBILE_NUMBER_REQUIRED");

    // Cleanup.
    await db.delete(userSessionsTable).where(eq(userSessionsTable.userId, noMobileUser!.id));
    await db.delete(usersTable).where(eq(usersTable.id, noMobileUser!.id));
  });

  it("returns 400 when mobile number is not verified", async () => {
    const [unverifiedUser] = await db
      .insert(usersTable)
      .values({
        username: `${prefix}-unverified`,
        name: "Unverified Mobile",
        age: 25,
        passwordHash: "x",
        passwordAlgo: PASSWORD_ALGO,
        email: `${prefix}unverified@test.example`,
        mobileNumber: nextMobile(),
        mobileVerificationStatus: "pending",
      })
      .returning({ id: usersTable.id });
    const { token } = await createSession(unverifiedUser!.id);

    const res = await request.agent(app)
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`)
      .post("/api/withdrawals")
      .send({ amount: 100, payoutAccountId, idempotencyKey: "idem-unverified" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MOBILE_VERIFICATION_REQUIRED");

    await db.delete(userSessionsTable).where(eq(userSessionsTable.userId, unverifiedUser!.id));
    await db.delete(usersTable).where(eq(usersTable.id, unverifiedUser!.id));
  });

  it("returns 400 TERMS_NOT_ACCEPTED when the user has not accepted Terms & Conditions", async () => {
    const res = await request
      .agent(app)
      .set("Cookie", `${SESSION_COOKIE_NAME}=${noTermsSessionToken}`)
      .post("/api/withdrawals")
      .send({ amount: 100, payoutAccountId, idempotencyKey: `${prefix}:noterms` });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TERMS_NOT_ACCEPTED");
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 for amount below minimum", async () => {
    const res = await authed(sessionToken)
      .post("/api/withdrawals")
      .send({
        amount: MINIMUM_WITHDRAWAL_AMOUNT - 1,
        payoutAccountId,
        idempotencyKey: `${prefix}:belowmin`,
      });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-integer amount", async () => {
    const res = await authed(sessionToken)
      .post("/api/withdrawals")
      .send({ amount: 100.5, payoutAccountId, idempotencyKey: `${prefix}:nonint` });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the payout account is not found or does not belong to the user", async () => {
    const res = await authed(sessionToken)
      .post("/api/withdrawals")
      .send({
        amount: MINIMUM_WITHDRAWAL_AMOUNT,
        payoutAccountId: "00000000-0000-0000-0000-000000000000",
        idempotencyKey: `${prefix}:nobankaccount`,
      });
    expect(res.status).toBe(404);
  });

  it("creates a bank_transfer withdrawal and returns 201 with masked bank account number", async () => {
    // userId starts with no active withdrawals in this test file.
    const res = await authed(sessionToken)
      .post("/api/withdrawals")
      .send({
        amount: MINIMUM_WITHDRAWAL_AMOUNT,
        payoutAccountId,
        idempotencyKey: `${prefix}:create1`,
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("reserved");
    expect(res.body.amount).toBe(MINIMUM_WITHDRAWAL_AMOUNT);
    expect(res.body.userId).toBe(userId);
    expect(res.body.bankAccountId).toBe(payoutAccountId);
    expect(res.body.snapshotPayoutMethod).toBe("bank_transfer");
    // Full account number must never be returned.
    expect(res.body.snapshotBankAccountNumber).toBeUndefined();
    expect(res.body.snapshotBankAccountNumberMasked).toBe("****7788");
    // UPI field must be null for bank_transfer withdrawals.
    expect(res.body.snapshotUpiId).toBeNull();
  });

  it("returns 409 when a second active withdrawal is requested", async () => {
    // The withdrawal created above is still 'reserved'.
    const res = await authed(sessionToken)
      .post("/api/withdrawals")
      .send({
        amount: MINIMUM_WITHDRAWAL_AMOUNT,
        payoutAccountId,
        idempotencyKey: `${prefix}:secondactive`,
      });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("active withdrawal");
  });

  it("returns 200 (idempotent) for a retry with the same key and same params", async () => {
    // Use wCancel (owned by userCancelId/sessionTokenCancel) — cancel it first
    // to make room, then retry the exact same request that created wCancel.
    const cancelRes = await authed(sessionTokenCancel)
      .post(`/api/withdrawals/${wCancel.id}/cancel`)
      .send({});
    expect(cancelRes.status).toBe(200);

    // Retry with the exact same idempotency key and params as wCancel was created with.
    const idempotencyKey = `${prefix}:cancel`;
    const retry = await authed(sessionTokenCancel)
      .post("/api/withdrawals")
      .send({
        amount: MINIMUM_WITHDRAWAL_AMOUNT,
        payoutAccountId: payoutAccountIdCancel,
        idempotencyKey,
      });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(wCancel.id); // same withdrawal returned
  });

  it("returns 409 for a conflicting idempotency key (same key, different params)", async () => {
    // wCancel was created with `${prefix}:cancel` as idempotencyKey.
    // Use the same key with a different amount.
    const res = await authed(sessionTokenCancel)
      .post("/api/withdrawals")
      .send({
        amount: MINIMUM_WITHDRAWAL_AMOUNT * 2,
        payoutAccountId: payoutAccountIdCancel,
        idempotencyKey: `${prefix}:cancel`, // same key, different amount
      });
    expect(res.status).toBe(409);
  });
});

// ── POST /withdrawals — UPI payout account ────────────────────────────────────

describe("POST /api/withdrawals (UPI payout account)", () => {
  // Uses a dedicated user so an active bank_transfer withdrawal doesn't block.
  let upiUserId = "";
  let upiSessionToken = "";
  let upiWinningAccountId = "";
  let upiWalletAccountIds: string[] = [];
  let upiSavedAccountId = "";

  beforeAll(async () => {
    const pwHash = await hashPassword("TestPass123!");
    const [u] = await db
      .insert(usersTable)
      .values({
        username: `${prefix}-upiwd`,
        name: "UPI Withdrawal Tester",
        age: 25,
        passwordHash: pwHash,
        passwordAlgo: PASSWORD_ALGO,
        email: `${prefix}upiwd@test.example`,
        mobileNumber: nextMobile(),
        mobileVerificationStatus: "verified",
        termsAcceptedAt: new Date(),
      })
      .returning({ id: usersTable.id });
    upiUserId = u!.id;
    allUserIds.push(upiUserId);

    const s = await createSession(upiUserId);
    upiSessionToken = s.token;

    const accts = await createWalletAccountsForUser(db, upiUserId);
    upiWalletAccountIds = accts.map((a) => a.id);
    allWalletAccountIds.push(...upiWalletAccountIds);
    const winning = accts.find((a) => a.walletType === "winning_coins")!;
    upiWinningAccountId = winning.id;

    await db.transaction(async (tx) => {
      await recordCompletedTransaction(tx, {
        walletAccountId: upiWinningAccountId,
        amount: MINIMUM_WITHDRAWAL_AMOUNT * 10,
        idempotencyKey: `${prefix}:upiwd:seed`,
        referenceType: "test_seed",
        description: "Initial balance for UPI withdrawal test",
      });
    });

    const upiAcct = await addBankAccount({
      userId: upiUserId,
      method: "upi",
      accountHolderName: "UPI Withdrawal Tester",
      upiId: "upiwithdraw@okhdfc",
    });
    upiSavedAccountId = upiAcct.id;
  });

  it("creates a UPI withdrawal and returns 201 with correct snapshot fields", async () => {
    const res = await request
      .agent(app)
      .set("Cookie", `${SESSION_COOKIE_NAME}=${upiSessionToken}`)
      .post("/api/withdrawals")
      .send({
        amount: MINIMUM_WITHDRAWAL_AMOUNT,
        payoutAccountId: upiSavedAccountId,
        idempotencyKey: `${prefix}:upiwd:create1`,
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("reserved");
    expect(res.body.amount).toBe(MINIMUM_WITHDRAWAL_AMOUNT);
    // Method-specific response fields.
    expect(res.body.snapshotPayoutMethod).toBe("upi");
    expect(res.body.snapshotUpiId).toBe("upiwithdraw@okhdfc");
    // Bank-specific fields must be null for UPI withdrawals.
    expect(res.body.snapshotBankAccountNumberMasked).toBeNull();
    expect(res.body.snapshotBankIfscCode).toBeNull();
    expect(res.body.snapshotBankName).toBeNull();
    // Raw account number must never appear.
    expect(res.body.snapshotBankAccountNumber).toBeUndefined();
  });

  it("accepts a UPI withdrawal for a QR-derived VPA (same code path as manual entry)", async () => {
    // The user already has an active withdrawal from the test above.
    // The mock provider returns accepted, so the webhook could complete it.
    // For this test, just verify a separately registered QR-derived VPA account
    // can be used as a withdrawal destination.
    const qrAcct = await addBankAccount({
      userId: upiUserId,
      method: "upi",
      accountHolderName: "QR Scan Tester",
      upiId: "qrmerchant@upi", // VPA extracted from QR scan by frontend
    });

    // The UPI user currently has an active withdrawal — cancel it first.
    const activeWd = await db
      .select({ id: withdrawalsTable.id })
      .from(withdrawalsTable)
      .where(
        and(
          eq(withdrawalsTable.userId, upiUserId),
          eq(withdrawalsTable.status, "reserved"),
        ),
      )
      .limit(1);
    if (activeWd[0]) {
      await db.transaction(async (tx) => {
        const [w] = await tx
          .select()
          .from(withdrawalsTable)
          .where(eq(withdrawalsTable.id, activeWd[0]!.id))
          .for("update");
        if (w && w.status === "reserved") {
          await tx
            .update(withdrawalsTable)
            .set({ status: "cancelled", cancelledAt: new Date() })
            .where(eq(withdrawalsTable.id, w.id));
        }
      });
    }

    const res = await request
      .agent(app)
      .set("Cookie", `${SESSION_COOKIE_NAME}=${upiSessionToken}`)
      .post("/api/withdrawals")
      .send({
        amount: MINIMUM_WITHDRAWAL_AMOUNT,
        payoutAccountId: qrAcct.id,
        idempotencyKey: `${prefix}:upiwd:qr`,
      });

    expect(res.status).toBe(201);
    expect(res.body.snapshotPayoutMethod).toBe("upi");
    expect(res.body.snapshotUpiId).toBe("qrmerchant@upi");
    expect(res.body.snapshotBankAccountNumberMasked).toBeNull();
  });
});

// ── GET /withdrawals ──────────────────────────────────────────────────────────

describe("GET /api/withdrawals", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/withdrawals");
    expect(res.status).toBe(401);
  });

  it("returns a list of withdrawals for the authenticated user", async () => {
    // userId had a withdrawal created in the POST tests above.
    const res = await authed(sessionToken).get("/api/withdrawals");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.withdrawals)).toBe(true);
    expect(res.body.withdrawals.length).toBeGreaterThanOrEqual(1);
    // No raw account numbers in any withdrawal.
    for (const w of res.body.withdrawals) {
      expect(w.snapshotBankAccountNumber).toBeUndefined();
      // snapshotPayoutMethod must be present.
      expect(["bank_transfer", "upi"]).toContain(w.snapshotPayoutMethod);
    }
  });

  it("does not return withdrawals belonging to another user", async () => {
    const res = await authed(sessionToken2).get("/api/withdrawals");
    expect(res.status).toBe(200);
    expect(res.body.withdrawals).toHaveLength(0);
  });

  it("returns 400 for invalid query params", async () => {
    const res = await authed(sessionToken).get("/api/withdrawals?limit=notanumber");
    expect(res.status).toBe(400);
  });

  it("supports pagination via 'before' parameter", async () => {
    // Requesting records before 1970 should return nothing.
    const res = await authed(sessionToken).get("/api/withdrawals?before=1970-01-01T00:00:00.000Z");
    expect(res.status).toBe(200);
    expect(res.body.withdrawals).toHaveLength(0);
  });
});

// ── GET /withdrawals/:id ──────────────────────────────────────────────────────

describe("GET /api/withdrawals/:id", () => {
  // Use wCancelProcessing (owned by userCancelProcId/sessionTokenCancelProc).
  const getWithdrawalId = () => wCancelProcessing.id;

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get(`/api/withdrawals/${getWithdrawalId()}`);
    expect(res.status).toBe(401);
  });

  it("returns 200 with masked bank account number for the owner (bank_transfer)", async () => {
    const res = await authed(sessionTokenCancelProc).get(`/api/withdrawals/${getWithdrawalId()}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(getWithdrawalId());
    expect(res.body.status).toBe("processing");
    expect(res.body.snapshotPayoutMethod).toBe("bank_transfer");
    expect(res.body.snapshotBankAccountNumber).toBeUndefined();
    expect(res.body.snapshotBankAccountNumberMasked).toBe("****7788");
    expect(res.body.snapshotUpiId).toBeNull();
  });

  it("returns 404 for a non-existent withdrawal", async () => {
    const res = await authed(sessionTokenCancelProc).get(
      "/api/withdrawals/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when another user requests the withdrawal", async () => {
    const res = await authed(sessionToken2).get(`/api/withdrawals/${getWithdrawalId()}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid UUID", async () => {
    const res = await authed(sessionTokenCancelProc).get("/api/withdrawals/not-a-uuid");
    expect(res.status).toBe(400);
  });
});

// ── POST /withdrawals/:id/cancel ──────────────────────────────────────────────

describe("POST /api/withdrawals/:id/cancel", () => {
  // wCancel was already cancelled in the idempotency test above.
  // wCancelProcessing is in 'processing' state (owned by userCancelProcId).

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).post(`/api/withdrawals/${wCancelProcessing.id}/cancel`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when another user tries to cancel the withdrawal", async () => {
    // sessionToken2 (not the owner of wCancelProcessing) → 404
    const res = await authed(sessionToken2).post(`/api/withdrawals/${wCancelProcessing.id}/cancel`);
    expect(res.status).toBe(404);
  });

  it("returns 409 when the withdrawal is in 'processing' state (cannot cancel)", async () => {
    // sessionTokenCancelProc is the owner of wCancelProcessing → 409
    const res = await authed(sessionTokenCancelProc).post(`/api/withdrawals/${wCancelProcessing.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("processing");
  });

  it("returns 200 for an already-cancelled withdrawal (idempotent)", async () => {
    // wCancel was cancelled in the POST /withdrawals idempotency test above.
    const res = await authed(sessionTokenCancel).post(`/api/withdrawals/${wCancel.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("returns 400 for an invalid UUID", async () => {
    const res = await authed(sessionTokenCancel).post("/api/withdrawals/not-a-uuid/cancel");
    expect(res.status).toBe(400);
  });
});

// ── POST /payments/payu/payout (payout webhook) ───────────────────────────────

describe("POST /api/payments/payu/payout", () => {
  it("returns 400 when the webhook body fails provider validation", async () => {
    // Body without the _mock sentinel is rejected by parseWebhook.
    const res = await request(app)
      .post("/api/payments/payu/payout")
      .send({ txnid: "fake", status: "success" });
    expect(res.status).toBe(400);
  });

  it("returns 200 and completes the withdrawal on a success webhook", async () => {
    const webhookBody = _mockProvider.buildWebhookEvent(
      "success",
      wWebhookSuccess.id,
      `MOCK_REF_${wWebhookSuccess.id}`,
    );

    const res = await request(app)
      .post("/api/payments/payu/payout")
      .send(webhookBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const w = await getWithdrawalFromDb(wWebhookSuccess.id);
    expect(w.status).toBe("completed");
    expect(w.completedAt).not.toBeNull();
  });

  it("returns 200 and fails the withdrawal on a failure webhook", async () => {
    const webhookBody = _mockProvider.buildWebhookEvent(
      "failure",
      wWebhookFailure.id,
      `MOCK_REF_${wWebhookFailure.id}`,
      "Beneficiary account closed",
    );

    const res = await request(app)
      .post("/api/payments/payu/payout")
      .send(webhookBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const w = await getWithdrawalFromDb(wWebhookFailure.id);
    expect(w.status).toBe("failed");
    expect(w.failureReason).toBe("Beneficiary account closed");
  });

  it("returns 200 (idempotent) when the withdrawal is already in a terminal state", async () => {
    // wWebhookAlreadyDone was set to 'completed' in beforeAll.
    const webhookBody = _mockProvider.buildWebhookEvent(
      "success",
      wWebhookAlreadyDone.id,
      `MOCK_REF_${wWebhookAlreadyDone.id}`,
    );

    const res = await request(app)
      .post("/api/payments/payu/payout")
      .send(webhookBody);
    expect(res.status).toBe(200); // Not an error — idempotent
  });

  it("returns 200 (not 404) for an unknown withdrawal ID", async () => {
    // Do not reveal whether a withdrawal ID exists — always return 200 to
    // prevent PayU from retrying indefinitely.
    const webhookBody = _mockProvider.buildWebhookEvent(
      "success",
      "00000000-0000-0000-0000-000000000000",
      "MOCK_REF_UNKNOWN",
    );
    const res = await request(app)
      .post("/api/payments/payu/payout")
      .send(webhookBody);
    expect(res.status).toBe(200);
  });
});
