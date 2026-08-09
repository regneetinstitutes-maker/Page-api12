import { Router, type IRouter } from "express";
import { z } from "zod";
import { CompetitionError, LOW_PARTICIPATION_REASON, addRoomDetails, cancelCompetition, claimCompetition, confirmRoomParticipant, createGame, createMode, createSchedule, createTournamentPositionReveal, getAvailableCompetitions, getCompetition, getTournamentParticipantList, joinCompetition, listGames, listHosts, listModes, listSchedules, releaseCompetition, runCompetitionScheduler, snoozeCompetitionUnclaimedAlert, startTournament, submitOmbResults, submitTournamentPositionReveal, submitTournamentResults } from "../lib/competition";
import { requireRole, requireSession } from "../middlewares/requireSession";

const router: IRouter = Router();
const competitionType = z.enum(["omb", "tournament"]);

const joinBody = z.object({
  scheduleId: z.string().uuid(),
  gameUid: z.string().trim().min(1).max(128),
  gameName: z.string().trim().min(1).max(128),
});

function sendCompetitionError(res: Parameters<IRouter["use"]>[1] extends never ? never : any, error: unknown) {
  if (error instanceof CompetitionError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  return false;
}

router.get("/competitions/games", async (_req, res) => {
  res.json({ games: await listGames() });
});

router.get("/competitions/modes", async (req, res) => {
  const parsed = z.object({ gameId: z.string().uuid().optional() }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  res.json({ modes: await listModes(parsed.data.gameId) });
});

router.get("/competitions/schedules", async (req, res) => {
  const parsed = z.object({ type: competitionType, modeId: z.string().uuid().optional() }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  res.json({ schedules: await listSchedules(parsed.data.type, parsed.data.modeId) });
});

router.get("/competitions/:type/available", requireSession, requireRole("omb_host", "tournament_host", "manager", "admin"), async (req, res) => {
  const type = competitionType.safeParse(req.params.type);
  if (!type.success) {
    res.status(400).json({ message: "Invalid competition type." });
    return;
  }
  if (req.user!.role === "omb_host" && type.data !== "omb") {
    res.status(403).json({ message: "OMB hosts can only view OMBs." });
    return;
  }
  if (req.user!.role === "tournament_host" && type.data !== "tournament") {
    res.status(403).json({ message: "Tournament hosts can only view tournaments." });
    return;
  }
  res.json({ competitions: await getAvailableCompetitions(type.data) });
});

router.get("/competitions/:type/:id", requireSession, async (req, res) => {
  const type = competitionType.safeParse(req.params.type);
  const id = z.string().uuid().safeParse(req.params.id);
  if (!type.success || !id.success) {
    res.status(400).json({ message: "Invalid competition identifier." });
    return;
  }
  const result = await getCompetition(type.data, id.data);
  if (!result) {
    res.status(404).json({ message: "Competition was not found." });
    return;
  }
  res.json(result);
});

router.post("/competitions/join", requireSession, async (req, res) => {
  const parsed = joinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  try {
    const result = await joinCompetition({ userId: req.user!.id, ...parsed.data });
    res.status(201).json(result);
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/competitions/:type/:id/claim", requireSession, requireRole("omb_host", "tournament_host"), async (req, res) => {
  const type = competitionType.safeParse(req.params.type);
  const id = z.string().uuid().safeParse(req.params.id);
  if (!type.success || !id.success) {
    res.status(400).json({ message: "Invalid competition identifier." });
    return;
  }
  try {
    const result = await claimCompetition(type.data, id.data, req.user!.id);
    res.json({ competition: result });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/competitions/:type/:id/release", requireSession, requireRole("omb_host", "tournament_host"), async (req, res) => {
  const type = competitionType.safeParse(req.params.type);
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({ confirmation: z.literal("release") }).safeParse(req.body);
  if (!type.success || !id.success || !body.success) {
    res.status(400).json({ message: "Type release to confirm releasing the assignment." });
    return;
  }
  try {
    const result = await releaseCompetition(type.data, id.data, req.user!.id);
    res.json({ competition: result });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/competitions/omb/:id/room-details", requireSession, requireRole("omb_host"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({ roomId: z.string().trim().min(1).max(128), roomPassword: z.string().trim().min(1).max(128) }).safeParse(req.body);
  if (!id.success || !body.success) {
    res.status(400).json({ message: "Room ID and password are required." });
    return;
  }
  try {
    res.json({ competition: await addRoomDetails(id.data, req.user!.id, body.data.roomId, body.data.roomPassword) });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/competitions/omb/:id/participants/:participantId/confirm-room", requireSession, requireRole("omb_host"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const participantId = z.string().uuid().safeParse(req.params.participantId);
  if (!id.success || !participantId.success) {
    res.status(400).json({ message: "Invalid participant identifier." });
    return;
  }
  try {
    res.json({ participant: await confirmRoomParticipant(id.data, participantId.data, req.user!.id) });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/competitions/omb/:id/results", requireSession, requireRole("omb_host"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({
    positions: z.array(z.object({
      participantId: z.string().uuid(),
      position: z.number().int().positive(),
      isCheater: z.boolean().optional(),
    })).min(1),
  }).safeParse(req.body);
  if (!id.success || !body.success) {
    res.status(400).json({ message: "A valid result position is required for every participant." });
    return;
  }
  try {
    res.json({ competition: await submitOmbResults(id.data, req.user!.id, body.data.positions) });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/competitions/tournament/:id/start", requireSession, requireRole("tournament_host"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({
    values: z.array(z.object({
      participantId: z.string().uuid(),
      initialValue: z.number().int(),
    })).min(1),
  }).safeParse(req.body);
  if (!id.success || !body.success) {
    res.status(400).json({ message: "A valid initial value is required for every participant." });
    return;
  }
  try {
    res.json({ competition: await startTournament(id.data, req.user!.id, body.data.values) });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/competitions/tournament/:id/results", requireSession, requireRole("tournament_host"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({
    values: z.array(z.object({
      participantId: z.string().uuid(),
      finalValue: z.number().int(),
      isCheater: z.boolean().optional(),
    })).min(1),
  }).safeParse(req.body);
  if (!id.success || !body.success) {
    res.status(400).json({ message: "A valid final value is required for every participant." });
    return;
  }
  try {
    res.json({ competition: await submitTournamentResults(id.data, req.user!.id, body.data.values) });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.get("/competitions/tournament/:id/participants", requireSession, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ message: "Invalid tournament identifier." });
    return;
  }
  try {
    const result = await getTournamentParticipantList(id.data);
    if (!result) {
      res.status(404).json({ message: "Tournament was not found." });
      return;
    }
    res.json(result);
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/competitions/tournament/:id/position-reveals/:revealId", requireSession, requireRole("tournament_host"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const revealId = z.string().uuid().safeParse(req.params.revealId);
  const body = z.object({
    values: z.array(z.object({
      participantId: z.string().uuid(),
      metricValue: z.number().int(),
    })).min(1),
  }).safeParse(req.body);
  if (!id.success || !revealId.success || !body.success) {
    res.status(400).json({ message: "A valid metric value is required for every participant." });
    return;
  }
  try {
    res.json({
      reveal: await submitTournamentPositionReveal(
        id.data,
        revealId.data,
        req.user!.id,
        body.data.values,
      ),
    });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.get("/hosts", requireSession, requireRole("admin", "manager"), async (req, res) => {
  const parsed = z.object({ role: z.enum(["omb", "tournament"]).optional(), free: z.coerce.boolean().optional() }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  res.json({ hosts: await listHosts(parsed.data.role, parsed.data.free ?? false) });
});

router.post("/manager/competitions/:type/:id/unclaimed-snooze", requireSession, requireRole("manager"), async (req, res) => {
  const type = competitionType.safeParse(req.params.type);
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({ minutes: z.number().int().min(1).max(60) }).safeParse(req.body);
  if (!type.success || !id.success || !body.success) {
    res.status(400).json({ message: "A snooze duration from 1 to 60 minutes is required." });
    return;
  }
  try {
    res.json({
      competition: await snoozeCompetitionUnclaimedAlert(type.data, id.data, body.data.minutes),
    });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/admin/competition/games", requireSession, requireRole("admin"), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(128), logoUrl: z.string().url().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  res.status(201).json({ game: await createGame(parsed.data) });
});

router.post("/admin/competition/modes", requireSession, requireRole("admin"), async (req, res) => {
  const parsed = z.object({ gameId: z.string().uuid(), name: z.string().trim().min(1).max(128), logoUrl: z.string().url().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  res.status(201).json({ mode: await createMode(parsed.data) });
});

router.post("/admin/competition/schedules", requireSession, requireRole("admin"), async (req, res) => {
  const parsed = z.object({
    modeId: z.string().uuid(),
    type: competitionType,
    status: z.enum(["draft", "published", "closed"]).default("draft"),
    entryFee: z.number().int().positive(),
    maxParticipants: z.number().int().positive(),
    teamSize: z.number().int().positive().default(1),
    startsAt: z.coerce.date().nullable().optional(),
    entryClosesAt: z.coerce.date().nullable().optional(),
    durationMinutes: z.number().int().positive().nullable().optional(),
    roomRevealMinutesBeforeStart: z.number().int().nonnegative().nullable().optional(),
    resultDeadlineMinutes: z.number().int().positive().default(90),
    managerAlertAfterMinutes: z.number().int().nonnegative().default(5),
    tournamentMetric: z.string().trim().min(1).max(128).nullable().optional(),
    prizes: z.array(z.object({ position: z.number().int().positive(), amount: z.number().int().nonnegative() })).default([]),
    guideVideoUrl: z.string().url().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  }).superRefine((value, context) => {
    if (value.type === "omb" && (!value.startsAt || value.roomRevealMinutesBeforeStart == null)) {
      context.addIssue({ code: "custom", message: "OMBs require startsAt and roomRevealMinutesBeforeStart.", path: ["startsAt"] });
    }
    if (value.type === "tournament" && (!value.entryClosesAt || !value.durationMinutes || !value.tournamentMetric)) {
      context.addIssue({ code: "custom", message: "Tournaments require entryClosesAt, durationMinutes, and tournamentMetric.", path: ["entryClosesAt"] });
    }
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  res.status(201).json({
    schedule: await createSchedule({
      ...parsed.data,
      startsAt: parsed.data.startsAt ?? null,
      entryClosesAt: parsed.data.entryClosesAt ?? null,
      durationMinutes: parsed.data.durationMinutes ?? null,
      roomRevealMinutesBeforeStart: parsed.data.roomRevealMinutesBeforeStart ?? null,
      tournamentMetric: parsed.data.tournamentMetric ?? null,
      guideVideoUrl: parsed.data.guideVideoUrl ?? null,
      notes: parsed.data.notes ?? null,
    }),
  });
});

router.post("/admin/competition/tournament-position-reveals", requireSession, requireRole("admin"), async (req, res) => {
  const parsed = z.object({
    scheduleId: z.string().uuid(),
    revealAt: z.coerce.date(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  try {
    res.status(201).json({ reveal: await createTournamentPositionReveal(parsed.data) });
  } catch (error) {
    if (sendCompetitionError(res, error)) return;
    throw error;
  }
});

router.post("/internal/competition-scheduler", requireSession, requireRole("admin"), async (_req, res) => {
  await runCompetitionScheduler();
  res.status(204).send();
});

export default router;