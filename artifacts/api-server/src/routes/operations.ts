import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireRole, requireSession } from "../middlewares/requireSession";
import { OperationsError, adjustUserWallet, broadcastAdminNotification, getAdminDashboard, listUserPayoutAccounts, resetUserPassword, searchCompetition, searchUsers, searchUserByMobile, updateUserAccountStatus } from "../lib/operations";

const router: IRouter = Router();

router.get("/operations/admin/dashboard", requireSession, requireRole("admin"), async (_req, res) => {
  res.json(await getAdminDashboard());
});

function sendOperationsError(res: Parameters<IRouter["use"]>[1] extends never ? never : any, error: unknown) {
  if (error instanceof OperationsError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  return false;
}

router.get("/operations/users/search", requireSession, requireRole("admin", "support"), async (req, res) => {
  const parsed = z.object({ q: z.string().trim().min(1).max(128).optional(), mobileNumber: z.string().trim().min(5).max(32).optional() }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.message }); return; }
  if (parsed.data.q) { res.json({ users: await searchUsers(parsed.data.q) }); return; }
  const result = await searchUserByMobile(parsed.data.mobileNumber!);
  if (!result) { res.status(404).json({ message: "User was not found." }); return; }
  res.json(result);
});

router.get("/operations/competitions/search", requireSession, requireRole("admin", "support"), async (req, res) => {
  const parsed = z.object({ q: z.string().trim().min(1).max(128).optional(), identifier: z.string().trim().min(1).max(128).optional() }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.message }); return; }
  const result = await searchCompetition(parsed.data.q ?? parsed.data.identifier!);
  if (!result) { res.status(404).json({ message: "Competition was not found." }); return; }
  res.json(result);
});

router.patch("/operations/users/:id/status", requireSession, requireRole("admin"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const parsed = z.object({ accountStatus: z.enum(["active", "suspended", "deactivated"]) }).safeParse(req.body);
  if (!id.success || !parsed.success) { res.status(400).json({ message: "A valid account status is required." }); return; }
  try {
    res.json({ user: await updateUserAccountStatus(id.data, parsed.data.accountStatus) });
  } catch (error) {
    if (sendOperationsError(res, error)) return;
    throw error;
  }
});

router.patch("/admin/users/:id/status", requireSession, requireRole("admin"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ message: "A valid account status is required." }); return; }
  try { res.json({ user: await updateUserAccountStatus(id.data, body.data.status) }); }
  catch (error) { if (sendOperationsError(res, error)) return; throw error; }
});

router.post("/admin/users/:id/wallet-adjust", requireSession, requireRole("admin"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({ walletType: z.enum(["playCoins", "winningCoins"]), amount: z.number().int().refine((value) => value !== 0), reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ message: "A valid wallet adjustment is required." }); return; }
  try {
    const walletType = body.data.walletType === "playCoins" ? "play_coins" : "winning_coins";
    res.status(201).json({ transaction: await adjustUserWallet(id.data, walletType, body.data.amount, body.data.reason) });
  } catch (error) { if (sendOperationsError(res, error)) return; throw error; }
});

router.post("/admin/notifications/broadcast", requireSession, requireRole("admin"), async (req, res) => {
  const body = z.object({
    title: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(4000),
    targetAudience: z.enum(["all", "active_players", "hosts", "specific_user"]),
    type: z.string().trim().min(1).max(64),
    priority: z.string().trim().min(1).max(32),
    deepLink: z.string().trim().max(512),
    userId: z.string().uuid().optional(),
  }).safeParse(req.body);
  if (!body.success || (body.success && body.data.targetAudience === "specific_user" && !body.data.userId)) {
    res.status(400).json({ message: "A valid broadcast audience and message are required." });
    return;
  }
  res.status(201).json(await broadcastAdminNotification(body.data));
});

router.post("/operations/users/:id/password-reset", requireSession, requireRole("admin"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const parsed = z.object({ password: z.string().min(8).max(256) }).safeParse(req.body);
  if (!id.success || !parsed.success) { res.status(400).json({ message: "A valid password is required." }); return; }
  try {
    res.json({ user: await resetUserPassword(id.data, parsed.data.password) });
  } catch (error) {
    if (sendOperationsError(res, error)) return;
    throw error;
  }
});

router.get("/operations/users/:id/payout-accounts", requireSession, requireRole("admin", "support"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ message: "Invalid user identifier." }); return; }
  res.json({ accounts: await listUserPayoutAccounts(id.data) });
});

export default router;
