/**
 * PayU Transfer Money payout provider tests.
 *
 * ── Part 1: Webhook hash verification ────────────────────────────────────────
 *
 * Validates that computeWebhookHash implements the correct formula:
 *
 *   sha512(SALT|status|amount|txnid|key)
 *
 * and that PayUPayoutProvider.parseWebhook correctly accepts signatures built
 * with this formula and rejects any mutation (wrong order, wrong value, wrong
 * length).
 *
 * ── Part 2: submitPayout request construction ─────────────────────────────────
 *
 * Validates that submitPayout builds the correct `var1` JSON for both
 * `bank_transfer` and `upi` payout methods. Uses vi.stubGlobal to intercept
 * fetch without making real HTTP calls.
 */

// Set env vars before any module that reads process.env is imported.
process.env["PAYU_PAYOUT_KEY"] = "test_payout_key_abc123";
process.env["PAYU_PAYOUT_SALT"] = "test_payout_salt_xyz789";
process.env["PAYU_PAYOUT_ENV"] = "test";

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { createHash } from "node:crypto";
import { PayUPayoutProvider, computeWebhookHash } from "./payu-payout";
import type { SubmitPayoutInput } from "./provider";

// ── Test constants ─────────────────────────────────────────────────────────────

const KEY = process.env["PAYU_PAYOUT_KEY"]!;
const SALT = process.env["PAYU_PAYOUT_SALT"]!;

/**
 * Reference implementation of the expected hash formula.
 * This is the independent "oracle" we compare computeWebhookHash against.
 * Formula: sha512(SALT|status|amount|txnid|key)
 */
function referenceHash(
  salt: string,
  status: string,
  amount: string,
  txnid: string,
  key: string,
): string {
  return createHash("sha512")
    .update(`${salt}|${status}|${amount}|${txnid}|${key}`)
    .digest("hex");
}

// ── computeWebhookHash unit tests ─────────────────────────────────────────────

describe("computeWebhookHash — formula verification", () => {
  it("produces a 128-character lowercase hex string", () => {
    const hash = computeWebhookHash(SALT, "success", "500.00", "txn-abc", KEY);
    expect(hash).toHaveLength(128);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it("matches the reference formula sha512(salt|status|amount|txnid|key)", () => {
    const cases = [
      { status: "success", amount: "500.00", txnid: "withdrawal-uuid-1234" },
      { status: "failure", amount: "100.00", txnid: "withdrawal-uuid-5678" },
      { status: "success", amount: "1.00",   txnid: "withdrawal-uuid-0001" },
      { status: "failure", amount: "9999.00", txnid: "wd-edge-case-id" },
    ];

    for (const { status, amount, txnid } of cases) {
      const expected = referenceHash(SALT, status, amount, txnid, KEY);
      const actual = computeWebhookHash(SALT, status, amount, txnid, KEY);
      expect(actual).toBe(expected);
    }
  });

  it("is NOT sha512(key|status|amount|txnid|salt) (wrong order)", () => {
    // The outbound request hash uses key|...|salt order.
    // The inbound webhook hash uses salt|...|key order (mirror).
    // This test confirms they are distinct.
    const webhookHash = computeWebhookHash(SALT, "success", "500.00", "txn-abc", KEY);
    const outboundOrder = createHash("sha512")
      .update(`${KEY}|success|500.00|txn-abc|${SALT}`)
      .digest("hex");
    expect(webhookHash).not.toBe(outboundOrder);
  });

  it("produces different hashes for different statuses", () => {
    const successHash = computeWebhookHash(SALT, "success", "500.00", "txn-abc", KEY);
    const failureHash = computeWebhookHash(SALT, "failure", "500.00", "txn-abc", KEY);
    expect(successHash).not.toBe(failureHash);
  });

  it("produces different hashes for different amounts", () => {
    const h1 = computeWebhookHash(SALT, "success", "500.00", "txn-abc", KEY);
    const h2 = computeWebhookHash(SALT, "success", "500.01", "txn-abc", KEY);
    expect(h1).not.toBe(h2);
  });

  it("produces different hashes for different txnids", () => {
    const h1 = computeWebhookHash(SALT, "success", "500.00", "txn-abc", KEY);
    const h2 = computeWebhookHash(SALT, "success", "500.00", "txn-xyz", KEY);
    expect(h1).not.toBe(h2);
  });
});

// ── parseWebhook end-to-end tests ─────────────────────────────────────────────

describe("PayUPayoutProvider.parseWebhook — signature verification", () => {
  let provider: PayUPayoutProvider;

  beforeAll(() => {
    provider = new PayUPayoutProvider();
  });

  function makeBody(
    params: { txnid: string; status: string; amount: string; transferId: string },
    hashOverride?: string,
  ): Record<string, unknown> {
    const { txnid, status, amount, transferId } = params;
    const hash =
      hashOverride ?? computeWebhookHash(SALT, status, amount, txnid, KEY);
    return { txnid, status, amount, transferId, hash };
  }

  // ── Success path ────────────────────────────────────────────────────────────

  it("returns a success event for a correctly signed success webhook", () => {
    const body = makeBody({
      txnid: "withdrawal-uuid-success-001",
      status: "success",
      amount: "500.00",
      transferId: "PAYU_TXN_SUCCESS_001",
    });

    const event = provider.parseWebhook(body, {});

    expect(event).not.toBeNull();
    expect(event!.outcome).toBe("success");
    expect(event!.withdrawalId).toBe("withdrawal-uuid-success-001");
    expect(event!.providerReference).toBe("PAYU_TXN_SUCCESS_001");
  });

  it("returns a failure event for a correctly signed failure webhook", () => {
    const body = makeBody({
      txnid: "withdrawal-uuid-fail-002",
      status: "failure",
      amount: "250.00",
      transferId: "PAYU_TXN_FAIL_002",
    });

    const event = provider.parseWebhook(body, {});

    expect(event).not.toBeNull();
    expect(event!.outcome).toBe("failure");
    expect(event!.withdrawalId).toBe("withdrawal-uuid-fail-002");
    expect(event!.providerReference).toBe("PAYU_TXN_FAIL_002");
  });

  // ── Rejection paths ─────────────────────────────────────────────────────────

  it("returns null for a completely wrong hash", () => {
    const body = makeBody(
      { txnid: "withdrawal-uuid-003", status: "success", amount: "100.00", transferId: "REF_003" },
      "a".repeat(128), // 128 chars but wrong value
    );

    expect(provider.parseWebhook(body, {})).toBeNull();
  });

  it("returns null when hash is computed with reversed field order (key|status|amount|txnid|salt)", () => {
    const txnid = "withdrawal-uuid-004";
    const status = "success";
    const amount = "300.00";
    // Wrong order — matches outbound request hash, not webhook hash.
    const wrongHash = createHash("sha512")
      .update(`${KEY}|${status}|${amount}|${txnid}|${SALT}`)
      .digest("hex");

    const body = makeBody(
      { txnid, status, amount, transferId: "REF_004" },
      wrongHash,
    );

    expect(provider.parseWebhook(body, {})).toBeNull();
  });

  it("returns null when the amount field has been tampered with", () => {
    const params = {
      txnid: "withdrawal-uuid-005",
      status: "success",
      amount: "500.00",
      transferId: "REF_005",
    };
    // Build a valid body for 500.00, but modify amount to 1.00 without updating hash.
    const validHash = computeWebhookHash(SALT, params.status, params.amount, params.txnid, KEY);
    const tamperedBody = { ...params, amount: "1.00", hash: validHash };

    expect(provider.parseWebhook(tamperedBody, {})).toBeNull();
  });

  it("returns null when the txnid has been tampered with", () => {
    const params = {
      txnid: "withdrawal-uuid-006",
      status: "success",
      amount: "500.00",
      transferId: "REF_006",
    };
    const validHash = computeWebhookHash(SALT, params.status, params.amount, params.txnid, KEY);
    const tamperedBody = { ...params, txnid: "different-uuid-006", hash: validHash };

    expect(provider.parseWebhook(tamperedBody, {})).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    // Missing 'hash' field entirely.
    const incompleteBody = {
      txnid: "withdrawal-uuid-007",
      status: "success",
      amount: "100.00",
      transferId: "REF_007",
      // hash: omitted
    };

    expect(provider.parseWebhook(incompleteBody, {})).toBeNull();
  });

  it("returns null for an unrecognised status even with a valid hash", () => {
    const txnid = "withdrawal-uuid-008";
    const status = "pending"; // not 'success' or 'failure'
    const amount = "100.00";
    const hash = computeWebhookHash(SALT, status, amount, txnid, KEY);

    const body = { txnid, status, amount, transferId: "REF_008", hash };

    expect(provider.parseWebhook(body, {})).toBeNull();
  });

  // ── Idempotency key inclusion ───────────────────────────────────────────────

  it("correctly extracts the withdrawalId (txnid) as the merchant reference", () => {
    const withdrawalId = "aaaabbbb-cccc-dddd-eeee-ffffgggghhhh";
    const body = makeBody({
      txnid: withdrawalId,
      status: "success",
      amount: "750.00",
      transferId: "PAYU_TXN_750",
    });

    const event = provider.parseWebhook(body, {});

    expect(event).not.toBeNull();
    expect(event!.withdrawalId).toBe(withdrawalId);
  });

  // ── Known test vector ───────────────────────────────────────────────────────

  it("matches a precomputed golden hash vector", () => {
    const salt = "test_payout_salt_xyz789";
    const status = "success";
    const amount = "1000.00";
    const txnid = "golden-vector-withdrawal-id";
    const key = "test_payout_key_abc123";

    // Expected value: sha512("test_payout_salt_xyz789|success|1000.00|golden-vector-withdrawal-id|test_payout_key_abc123")
    const goldenHash = createHash("sha512")
      .update("test_payout_salt_xyz789|success|1000.00|golden-vector-withdrawal-id|test_payout_key_abc123")
      .digest("hex");

    expect(computeWebhookHash(salt, status, amount, txnid, key)).toBe(goldenHash);
    expect(goldenHash).toHaveLength(128);
  });
});

// ── submitPayout request construction ─────────────────────────────────────────
//
// Tests verify that:
//   - bank_transfer sends account_number + ifsc_code (no upi_id)
//   - upi sends upi_id (no account_number, no ifsc_code)
//   - amount is always formatted as a decimal string to 2 places
//   - txnid is always the withdrawalId
//   - the command hash is always included
//   - the webhook format is shared (same parseWebhook logic for both methods)
//
// fetch is stubbed with vi.stubGlobal so no real HTTP calls are made.

describe("PayUPayoutProvider.submitPayout — request construction by method", () => {
  let provider: PayUPayoutProvider;

  beforeEach(() => {
    provider = new PayUPayoutProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeFetchResponse(body: unknown) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    });
  }

  function captureVar1(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    return JSON.parse(params.get("var1")!) as Record<string, unknown>;
  }

  // ── bank_transfer ───────────────────────────────────────────────────────────

  it("sends account_number and ifsc_code for bank_transfer; no upi_id", async () => {
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 1, data: { transferId: "PAYU_REF_BT_001" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const input: SubmitPayoutInput = {
      method: "bank_transfer",
      withdrawalId: "wd-bt-001",
      merchantReference: "withdrawal:key-bt:submit",
      amount: 500,
      accountHolderName: "Alice Kumar",
      bankAccountNumber: "12345678901",
      bankIfscCode: "HDFC0001234",
    };

    await provider.submitPayout(input);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const var1 = captureVar1(fetchSpy);

    expect(var1["account_number"]).toBe("12345678901");
    expect(var1["ifsc_code"]).toBe("HDFC0001234");
    expect(var1["upi_id"]).toBeUndefined();
    expect(var1["amount"]).toBe("500.00");
    expect(var1["txnid"]).toBe("wd-bt-001");
    expect(var1["name"]).toBe("Alice Kumar");
  });

  it("returns accepted with providerReference on successful bank_transfer submission", async () => {
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 1, data: { transferId: "PAYU_REF_BT_002", txnid: "wd-bt-002" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await provider.submitPayout({
      method: "bank_transfer",
      withdrawalId: "wd-bt-002",
      merchantReference: "withdrawal:key-bt2:submit",
      amount: 1000,
      accountHolderName: "Bob Singh",
      bankAccountNumber: "98765432101",
      bankIfscCode: "ICIC0009876",
    });

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.providerReference).toBe("PAYU_REF_BT_002");
    }
  });

  it("returns rejected when PayU rejects a bank_transfer", async () => {
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 0, msg: "Invalid IFSC code" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await provider.submitPayout({
      method: "bank_transfer",
      withdrawalId: "wd-bt-003",
      merchantReference: "withdrawal:key-bt3:submit",
      amount: 200,
      accountHolderName: "Carol Patel",
      bankAccountNumber: "11122233344",
      bankIfscCode: "SBIN0001234",
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("Invalid IFSC code");
    }
  });

  // ── upi ─────────────────────────────────────────────────────────────────────

  it("sends upi_id for upi method; no account_number, no ifsc_code", async () => {
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 1, data: { transferId: "PAYU_REF_UPI_001" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const input: SubmitPayoutInput = {
      method: "upi",
      withdrawalId: "wd-upi-001",
      merchantReference: "withdrawal:key-upi:submit",
      amount: 250,
      accountHolderName: "Dave Sharma",
      upiId: "dave@okhdfc",
    };

    await provider.submitPayout(input);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const var1 = captureVar1(fetchSpy);

    expect(var1["upi_id"]).toBe("dave@okhdfc");
    expect(var1["account_number"]).toBeUndefined();
    expect(var1["ifsc_code"]).toBeUndefined();
    expect(var1["amount"]).toBe("250.00");
    expect(var1["txnid"]).toBe("wd-upi-001");
    expect(var1["name"]).toBe("Dave Sharma");
  });

  it("returns accepted with providerReference on successful UPI submission", async () => {
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 1, data: { transferId: "PAYU_REF_UPI_002" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await provider.submitPayout({
      method: "upi",
      withdrawalId: "wd-upi-002",
      merchantReference: "withdrawal:key-upi2:submit",
      amount: 100,
      accountHolderName: "Eve Kumari",
      upiId: "eve@paytm",
    });

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.providerReference).toBe("PAYU_REF_UPI_002");
    }
  });

  it("returns rejected when PayU rejects a UPI payout (invalid VPA)", async () => {
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 0, msg: "Invalid UPI ID" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await provider.submitPayout({
      method: "upi",
      withdrawalId: "wd-upi-003",
      merchantReference: "withdrawal:key-upi3:submit",
      amount: 500,
      accountHolderName: "Frank Joshi",
      upiId: "frank@invalidvpa",
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("Invalid UPI ID");
    }
  });

  it("formats amount as fixed 2-decimal string for UPI payout", async () => {
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 1, data: { transferId: "PAYU_REF_UPI_004" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await provider.submitPayout({
      method: "upi",
      withdrawalId: "wd-upi-004",
      merchantReference: "withdrawal:key-upi4:submit",
      amount: 1,      // integer — must be formatted as "1.00"
      accountHolderName: "Grace Nair",
      upiId: "grace@ybl",
    });

    const var1 = captureVar1(fetchSpy);
    expect(var1["amount"]).toBe("1.00");
  });

  it("includes a valid request hash in the POST body for UPI", async () => {
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 1, data: { transferId: "PAYU_REF_UPI_005" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await provider.submitPayout({
      method: "upi",
      withdrawalId: "wd-upi-005",
      merchantReference: "withdrawal:key-upi5:submit",
      amount: 300,
      accountHolderName: "Hari Iyer",
      upiId: "hari@oksbi",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    const key = params.get("key")!;
    const command = params.get("command")!;
    const var1 = params.get("var1")!;
    const hash = params.get("hash")!;

    // Re-compute expected hash using the same formula as the implementation.
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha512")
      .update([key, command, var1, SALT].join("|"))
      .digest("hex");

    expect(hash).toBe(expectedHash);
    expect(command).toBe("make_transfer");
  });

  // ── QR-derived UPI account (same as manual UPI — backend agnostic) ───────────

  it("treats a QR-derived UPI VPA identically to a manually entered one", async () => {
    // A QR code containing "upi://pay?pa=merchant@upi&pn=Merchant" would be
    // decoded by the frontend to extract "merchant@upi". This test verifies
    // that such a VPA goes through exactly the same code path.
    const fetchSpy = vi.fn().mockReturnValue(
      makeFetchResponse({ status: 1, data: { transferId: "PAYU_REF_QR_001" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await provider.submitPayout({
      method: "upi",
      withdrawalId: "wd-qr-001",
      merchantReference: "withdrawal:key-qr:submit",
      amount: 750,
      accountHolderName: "QR User",
      upiId: "merchant@upi",  // extracted from QR by frontend
    });

    const var1 = captureVar1(fetchSpy);
    expect(var1["upi_id"]).toBe("merchant@upi");
    expect(var1["account_number"]).toBeUndefined();
    expect(var1["ifsc_code"]).toBeUndefined();
  });
});
