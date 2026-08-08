import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, withdrawalsTable, type Withdrawal } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  verifyReverseHash,
  processPayUSuccess,
  processPayUFailure,
  DepositNotFoundError,
  DepositAlreadyCompletedError,
} from "../lib/payu";
import { completeWithdrawal, failWithdrawal } from "../lib/withdrawal-completion";
import { notifyWithdrawalCompleted, notifyWithdrawalFailed } from "../lib/notifications";
import { resolvePayoutProvider } from "../lib/payout/provider";

const router: IRouter = Router();

// ── Incoming webhook body schema ──────────────────────────────────────────────
// PayU POSTs callbacks as application/x-www-form-urlencoded.
// Express parses this via app.use(express.urlencoded({ extended: true })).
//
// All values are strings (URL-encoded form data is always strings).
// Optional fields default to "" so hash computation receives the same empty
// strings we originally sent to PayU.

const PayUCallbackBody = z.object({
  txnid: z.string().min(1),
  amount: z.string().min(1),
  productinfo: z.string(),
  firstname: z.string(),
  email: z.string(),
  status: z.string(),
  // SHA-512 hex is always exactly 128 characters.
  hash: z.string().length(128),
  mihpayid: z.string().default(""),
  key: z.string().min(1),
  udf1: z.string().default(""),
  udf2: z.string().default(""),
  udf3: z.string().default(""),
  udf4: z.string().default(""),
  udf5: z.string().default(""),
  // PayU stores the failure description in field9.
  field9: z.string().default(""),
});

type PayUCallbackBody = z.infer<typeof PayUCallbackBody>;

// ── Shared parse + verify helper ──────────────────────────────────────────────

/**
 * Parses the webhook body and verifies the PayU reverse hash.
 * Sends HTTP 400 and returns null on any failure.
 *
 * Logging contract:
 * - Logs only txnid (for correlation) on hash failure.
 * - NEVER logs PAYU_SALT, the computed hash, or the received hash.
 * - NEVER logs the full payload (which contains the user's email, etc.).
 */
async function parseAndVerify(req: Request, res: Response): Promise<PayUCallbackBody | null> {
  const parsed = PayUCallbackBody.safeParse(req.body);
  if (!parsed.success) {
    logger.warn("PayU callback: malformed body.");
    res.status(400).json({ message: "Malformed callback payload." });
    return null;
  }

  const body = parsed.data;

  // Read the salt at request time, consistent with how getPayUConfig() works
  // in the deposit lib.  Startup validation guarantees this is non-empty.
  const salt = process.env["PAYU_SALT"] ?? "";

  const valid = verifyReverseHash({
    salt,
    status: body.status,
    udf5: body.udf5,
    udf4: body.udf4,
    udf3: body.udf3,
    udf2: body.udf2,
    udf1: body.udf1,
    email: body.email,
    firstname: body.firstname,
    productinfo: body.productinfo,
    amount: body.amount,
    txnid: body.txnid,
    key: body.key,
    receivedHash: body.hash,
  });

  if (!valid) {
    // Log only txnid for correlation; never log the hash or salt.
    logger.warn({ txnid: body.txnid }, "PayU callback rejected: hash verification failed.");
    res.status(400).json({ message: "Hash verification failed." });
    return null;
  }

  return body;
}

// ── POST /payments/payu/success ───────────────────────────────────────────────

router.post("/payments/payu/success", async (req, res): Promise<void> => {
  const body = await parseAndVerify(req, res);
  if (!body) return;

  if (body.status !== "success") {
    logger.warn(
      { txnid: body.txnid, status: body.status },
      "PayU success URL received unexpected status.",
    );
    res.status(400).json({ message: "Unexpected status for this endpoint." });
    return;
  }

  try {
    await processPayUSuccess({ txnid: body.txnid, mihpayid: body.mihpayid });
    logger.info({ txnid: body.txnid }, "PayU deposit succeeded; Play Coins credited.");
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof DepositNotFoundError) {
      // Return 200 so PayU does not retry indefinitely.  Do not reveal
      // whether the txnid exists or ever existed.
      logger.warn({ txnid: body.txnid }, "PayU success callback for unknown txnid; ignoring.");
      res.status(200).json({ status: "ignored" });
      return;
    }
    if (err instanceof DepositAlreadyCompletedError) {
      logger.info({ txnid: body.txnid }, "PayU success callback: deposit already completed.");
      res.status(200).json({ ok: true });
      return;
    }
    throw err;
  }
});

// ── POST /payments/payu/failure ───────────────────────────────────────────────

router.post("/payments/payu/failure", async (req, res): Promise<void> => {
  const body = await parseAndVerify(req, res);
  if (!body) return;

  if (body.status !== "failure") {
    logger.warn(
      { txnid: body.txnid, status: body.status },
      "PayU failure URL received unexpected status.",
    );
    res.status(400).json({ message: "Unexpected status for this endpoint." });
    return;
  }

  try {
    await processPayUFailure({ txnid: body.txnid, failureReason: body.field9 });
    logger.info({ txnid: body.txnid }, "PayU deposit failed; status recorded.");
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof DepositNotFoundError) {
      // Return 200 so PayU does not retry indefinitely.  Do not reveal
      // whether the txnid exists or ever existed.
      logger.warn({ txnid: body.txnid }, "PayU failure callback for unknown txnid; ignoring.");
      res.status(200).json({ status: "ignored" });
      return;
    }
    if (err instanceof DepositAlreadyCompletedError) {
      logger.info({ txnid: body.txnid }, "PayU failure callback: deposit already completed.");
      res.status(200).json({ ok: true });
      return;
    }
    throw err;
  }
});

// ── POST /payments/payu/payout ────────────────────────────────────────────────
//
// PayU Transfer Money webhook callback. PayU POSTs here when a payout settles
// (success or failure). The route verifies the webhook hash, resolves the
// withdrawal, and calls completeWithdrawal or failWithdrawal.
//
// Audit trail: the provider's transferId from the webhook is stored in the
// `webhook_transfer_id` column atomically within the same transaction as the
// status update. This allows every completed withdrawal to be traced back to
// a specific PayU payment ID.
//
// Idempotency: if the withdrawal is already in a terminal state (completed /
// failed / cancelled), the webhook is silently accepted (200) so PayU stops
// retrying.
//
// Always returns 200 to prevent PayU from retrying indefinitely.
// The only exception is 400 for failed hash verification.

router.post("/payments/payu/payout", async (req, res): Promise<void> => {
  const provider = resolvePayoutProvider();

  const event = provider.parseWebhook(
    req.body as Record<string, unknown>,
    req.headers as Record<string, string>,
  );

  if (!event) {
    logger.warn("Payout webhook: rejected — invalid signature or malformed body.");
    res.status(400).json({ message: "Webhook verification failed." });
    return;
  }

  let completedWithdrawal: Withdrawal | null = null;
  let failedWithdrawal: Withdrawal | null = null;

  await db.transaction(async (tx) => {
    const [withdrawal] = await tx
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.id, event.withdrawalId))
      .for("update");

    if (!withdrawal) {
      logger.warn(
        { withdrawalId: event.withdrawalId },
        "Payout webhook: withdrawal not found; ignoring.",
      );
      return; // Will return 200 — do not reveal existence of withdrawal IDs.
    }

    // Idempotency guard: already in a terminal state — webhook already processed.
    if (withdrawal.status !== "processing") {
      logger.info(
        { withdrawalId: event.withdrawalId, status: withdrawal.status },
        "Payout webhook: withdrawal is not in 'processing' state; ignoring (already handled).",
      );
      return;
    }

    // Store the provider's transfer ID from this webhook for the audit trail.
    // This creates a traceable link: withdrawal → PayU payment ID.
    // Done atomically with the status update in this transaction.
    await tx
      .update(withdrawalsTable)
      .set({ webhookTransferId: event.providerReference })
      .where(eq(withdrawalsTable.id, event.withdrawalId));

    if (event.outcome === "success") {
      completedWithdrawal = await completeWithdrawal(tx, withdrawal);
      logger.info(
        {
          withdrawalId: event.withdrawalId,
          providerReference: event.providerReference,
          webhookTransferId: event.providerReference,
        },
        "Payout webhook: withdrawal completed successfully.",
      );
    } else {
      failedWithdrawal = await failWithdrawal(tx, withdrawal, event.reason);
      logger.info(
        {
          withdrawalId: event.withdrawalId,
          reason: event.reason,
          webhookTransferId: event.providerReference,
        },
        "Payout webhook: withdrawal failed; reservation released.",
      );
    }
  });

  // Fire-and-forget notifications OUTSIDE the transaction.
  // Notification failures must never affect the HTTP response to PayU.
  if (completedWithdrawal) {
    const w = completedWithdrawal as Withdrawal;
    void notifyWithdrawalCompleted({ userId: w.userId, withdrawalId: w.id, amount: w.amount });
  }
  if (failedWithdrawal) {
    const w = failedWithdrawal as Withdrawal;
    void notifyWithdrawalFailed({
      userId: w.userId,
      withdrawalId: w.id,
      amount: w.amount,
      reason: w.failureReason ?? null,
    });
  }

  res.status(200).json({ ok: true });
});

export default router;
