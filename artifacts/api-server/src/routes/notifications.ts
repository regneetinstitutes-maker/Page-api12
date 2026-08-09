import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pushDevicesTable } from "@workspace/db";
import { requireSession } from "../middlewares/requireSession";

const router: IRouter = Router();

router.post("/notifications/devices", requireSession, async (req, res) => {
  const parsed = z.object({ token: z.string().trim().min(1).max(4096), platform: z.enum(["ios", "android", "web"]) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.message }); return; }
  const [device] = await db.insert(pushDevicesTable).values({ userId: req.user!.id, token: parsed.data.token, platform: parsed.data.platform, isActive: true, lastSeenAt: new Date() }).onConflictDoUpdate({ target: [pushDevicesTable.userId, pushDevicesTable.token], set: { platform: parsed.data.platform, isActive: true, lastSeenAt: new Date() } }).returning();
  res.status(201).json({ device: { id: device!.id, platform: device!.platform, isActive: device!.isActive } });
});

router.delete("/notifications/devices/:id", requireSession, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ message: "Invalid device identifier." }); return; }
  await db.update(pushDevicesTable).set({ isActive: false }).where(and(eq(pushDevicesTable.id, id.data), eq(pushDevicesTable.userId, req.user!.id)));
  res.status(204).send();
});

export default router;
