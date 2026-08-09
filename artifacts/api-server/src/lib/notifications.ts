/**
 * User notification service.
 *
 * Provides fire-and-forget notification dispatchers called AFTER a DB
 * transaction commits. Notification delivery must NEVER run inside a DB
 * transaction — failures would roll back committed financial state.
 *
 * Current implementation logs the event. Replace the log statements with real
 * delivery (push notification, SMS, email) when notification infrastructure is
 * available. The call sites (withdrawal-completion.ts, withdrawal routes) do
 * not need to change — they always call these functions after committing.
 *
 * Design contract:
 *   - These functions are async and return a Promise<void>.
 *   - Callers invoke them WITHOUT `await` (fire-and-forget) so a notification
 *     failure does not surface as an error to the user or affect the HTTP
 *     response.
 *   - Each function silently swallows its own errors after logging them.
 *     A notification failure is never propagated to the caller.
 */

import { logger } from "./logger";
import { and, eq } from "drizzle-orm";
import { db, pushDevicesTable } from "@workspace/db";

export interface PushNotification {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

async function deliverPush(notification: PushNotification): Promise<void> {
  const endpoint = process.env.PUSH_PROVIDER_URL;
  if (!endpoint) {
    logger.warn({ event: "push.not_configured", userId: notification.userId }, "Push provider is not configured.");
    return;
  }
  const devices = await db.select({ token: pushDevicesTable.token }).from(pushDevicesTable).where(and(eq(pushDevicesTable.userId, notification.userId), eq(pushDevicesTable.isActive, true)));
  await Promise.all(devices.map(async (device) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.PUSH_PROVIDER_TOKEN ? { authorization: `Bearer ${process.env.PUSH_PROVIDER_TOKEN}` } : {}) },
      body: JSON.stringify({ ...notification, token: device.token }),
    });
    if (!response.ok) throw new Error(`Push provider returned ${response.status}.`);
  }));
}

export function notifyPush(notification: PushNotification): void {
  void deliverPush(notification).catch((error) => logger.error({ event: "push.delivery_failed", userId: notification.userId, error: error instanceof Error ? error.message : String(error) }, "Push notification delivery failed."));
}

// ── Withdrawal notifications ──────────────────────────────────────────────────

export interface WithdrawalCompletedPayload {
  userId: string;
  withdrawalId: string;
  /** Amount in whole Winning Coins (= rupees at 1:1). */
  amount: number;
}

/**
 * Notifies the user that their withdrawal was successfully paid out.
 *
 * Fire-and-forget: invoke without `await`.
 *
 * @example
 * // After tx.commit():
 * void notifyWithdrawalCompleted({ userId, withdrawalId, amount });
 */
export async function notifyWithdrawalCompleted(
  payload: WithdrawalCompletedPayload,
): Promise<void> {
  try {
    // TODO: replace with real notification delivery (push, SMS, email).
    logger.info(
      {
        event: "withdrawal.notification.completed",
        userId: payload.userId,
        withdrawalId: payload.withdrawalId,
        amount: payload.amount,
      },
      `Withdrawal ₹${payload.amount} completed for user ${payload.userId}.`,
    );
  } catch (err) {
    // Notification failures must never propagate to the caller.
    logger.error(
      {
        event: "withdrawal.notification.error",
        type: "completed",
        userId: payload.userId,
        withdrawalId: payload.withdrawalId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to send withdrawal-completed notification.",
    );
  }
}

export interface WithdrawalFailedPayload {
  userId: string;
  withdrawalId: string;
  amount: number;
  /** Human-readable reason from the payout provider. */
  reason: string | null;
}

/**
 * Notifies the user that their withdrawal failed and funds have been returned
 * to their Winning Coins balance.
 *
 * Fire-and-forget: invoke without `await`.
 */
export async function notifyWithdrawalFailed(
  payload: WithdrawalFailedPayload,
): Promise<void> {
  try {
    // TODO: replace with real notification delivery.
    logger.info(
      {
        event: "withdrawal.notification.failed",
        userId: payload.userId,
        withdrawalId: payload.withdrawalId,
        amount: payload.amount,
        reason: payload.reason,
      },
      `Withdrawal ₹${payload.amount} failed for user ${payload.userId}. Funds returned.`,
    );
  } catch (err) {
    logger.error(
      {
        event: "withdrawal.notification.error",
        type: "failed",
        userId: payload.userId,
        withdrawalId: payload.withdrawalId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to send withdrawal-failed notification.",
    );
  }
}
