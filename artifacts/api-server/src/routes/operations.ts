import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireRole, requireSession } from "../middlewares/requireSession";
import { OperationsError, getAdminDashboard, listUserPayoutAccounts, resetUserPassword, searchCompetition, searchUserByMobile, updateUserAccountStatus } from "../lib/operations";

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
  const parsed = z.object({ mobileNumber: z.string().trim().min(5).max(32) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.message }); return; }
  const result = await searchUserByMobile(parsed.data.mobileNumber);
  if (!result) { res.status(404).json({ message: "User was not found." }); return; }
  res.json(result);
});

router.get("/operations/competitions/search", requireSession, requireRole("admin", "support"), async (req, res) => {
  const parsed = z.object({ identifier: z.string().trim().min(1).max(128) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.message }); return; }
  const result = await searchCompetition(parsed.data.identifier);
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
