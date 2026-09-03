import { randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  db,
  userBankAccountsTable,
  competitionSchedulesTable,
  competitionStatusEnum,
  gamesTable,
  hostsTable,
  matchParticipantsTable,
  matchesTable,
  modesTable,
  tournamentParticipantsTable,
  tournamentPositionRevealsTable,
  tournamentPositionValuesTable,
  tournamentsTable,
  usersTable,
  depositsTable,
  withdrawalsTable,
  walletAccountsTable,
  walletReservationsTable,
  walletTransactionsTable,
  type CompetitionSchedule,
  type Match,
  type Mode,
  type PrizeDefinition,
  type Tournament,
} from "@workspace/db";
import { createReservation, confirmReservation, releaseReservation } from "./reservation";
import { recordCompletedTransaction } from "./wallet";
import { logger } from "./logger";
import { createWalletAccountsForUser } from "./wallet";
import { hashPassword, PASSWORD_ALGO } from "./password";
import { competitionObjectKey, createDownloadUrl, createUploadUrl, verifyUploadedObject } from "./storage";
import { notifyPush, notifyRolePush } from "./notifications";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CompetitionType = "omb" | "tournament";
type Event = Match | Tournament;
type CompetitionViewer = {
  userId: string;
  role: "user" | "admin" | "manager" | "support" | "omb_host" | "tournament_host";
};

export const LOW_PARTICIPATION_REASON =
  "This competition was canceled due to low participation. To ensure fairness, awards were distributed randomly according to the awards chart.";

function eventCode(type: CompetitionType): string {
  return `${type === "omb" ? "OMB" : "T"}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function winnerCount(mode: Pick<Mode, "prizes">): number {
  return mode.prizes.length;
}

function revealAt(schedule: CompetitionSchedule): Date | null {
  if (!schedule.startsAt || schedule.roomRevealMinutesBeforeStart == null) return null;
  return new Date(schedule.startsAt.getTime() - schedule.roomRevealMinutesBeforeStart * 60_000);
}

function resultDeadline(mode: Pick<Mode, "type">, schedule: CompetitionSchedule): Date | null {
  const end = mode.type === "omb"
    ? schedule.startsAt
    : schedule.entryClosesAt;
  if (!end) return null;
  return new Date(end.getTime() + schedule.resultDeadlineMinutes * 60_000);
}

async function getModeForSchedule(tx: Tx | typeof db, scheduleId: string, type?: CompetitionType): Promise<Mode> {
  const [row] = await tx
    .select({ mode: modesTable })
    .from(competitionSchedulesTable)
    .innerJoin(modesTable, eq(modesTable.id, competitionSchedulesTable.modeId))
    .where(and(eq(competitionSchedulesTable.id, scheduleId), type ? eq(modesTable.type, type) : undefined))
    .limit(1);
  if (!row) throw new CompetitionError("SCHEDULE_NOT_FOUND", "Competition schedule was not found.");
  return row.mode;
}

async function getSchedule(tx: Tx | typeof db, scheduleId: string, type?: CompetitionType): Promise<CompetitionSchedule> {
  const [row] = await tx
    .select({ schedule: competitionSchedulesTable })
    .from(competitionSchedulesTable)
    .innerJoin(modesTable, eq(modesTable.id, competitionSchedulesTable.modeId))
    .where(and(eq(competitionSchedulesTable.id, scheduleId), type ? eq(modesTable.type, type) : undefined))
    .limit(1);
  if (!row) throw new CompetitionError("SCHEDULE_NOT_FOUND", "Competition schedule was not found.");
  return row.schedule;
}

async function getWallet(tx: Tx, userId: string) {
  const [wallet] = await tx
    .select()
    .from(walletAccountsTable)
    .where(and(eq(walletAccountsTable.userId, userId), eq(walletAccountsTable.walletType, "play_coins")))
    .for("update");
  if (!wallet) throw new CompetitionError("WALLET_NOT_FOUND", "Play Coins wallet was not found.");
  return wallet;
}

export class CompetitionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "CompetitionError";
  }
}

function assertDoubleEntry(first: string | number | boolean, second: string | number | boolean) {
  if (first !== second) {
    throw new CompetitionError("DOUBLE_ENTRY_MISMATCH", "You haven't entered information correctly. Please re-enter carefully and with concentration.");
  }
}

export interface CreateHostInput {
  name: string;
  username?: string;
  mobileNumber: string;
  upiId: string;
  password: string;
  role: "omb" | "tournament";
}

export async function createHost(input: CreateHostInput) {
  return db.transaction(async (tx) => {
    const mobileNumber = input.mobileNumber.trim();
    const username = input.username?.trim() || `host_${mobileNumber.replace(/\D/g, "")}`;
    const [existing] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.mobileNumber, mobileNumber))
      .limit(1);
    if (existing) {
      throw new CompetitionError("HOST_MOBILE_EXISTS", "A user with this mobile number already exists.", 409);
    }
    const [usernameConflict] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username)).limit(1);
    if (usernameConflict) throw new CompetitionError("HOST_USERNAME_EXISTS", "This username is already in use.", 409);

    const passwordHash = await hashPassword(input.password);
    const [user] = await tx
      .insert(usersTable)
      .values({
        username,
        name: input.name.trim(),
        age: 18,
        passwordHash,
        passwordAlgo: PASSWORD_ALGO,
        mobileNumber,
        mobileVerificationStatus: "verified",
        mobileVerifiedAt: new Date(),
        role: input.role === "omb" ? "omb_host" : "tournament_host",
      })
      .returning();
    if (!user) throw new CompetitionError("HOST_CREATE_FAILED", "Unable to create host.", 500);

    await createWalletAccountsForUser(tx, user.id);
    const [host] = await tx
      .insert(hostsTable)
      .values({
        userId: user.id,
        mobileNumber,
        upiId: input.upiId.trim(),
        role: input.role,
      })
      .returning();
    if (!host) throw new CompetitionError("HOST_CREATE_FAILED", "Unable to create host.", 500);
    return {
      host,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        mobileNumber: user.mobileNumber,
        role: user.role,
      },
    };
  });
}

export async function updateHost(
  hostId: string,
  input: { name?: string; username?: string; mobileNumber?: string; upiId?: string; role?: "omb" | "tournament"; status?: "active" | "disabled" },
) {
  return db.transaction(async (tx) => {
    const [host] = await tx.select().from(hostsTable).where(eq(hostsTable.id, hostId)).for("update");
    if (!host) throw new CompetitionError("HOST_NOT_FOUND", "Host was not found.", 404);
    if (input.role && host.currentAssignmentId && input.role !== host.role) {
      throw new CompetitionError("HOST_BUSY", "A host role cannot change while an assignment is active.");
    }
    const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, host.userId)).for("update");
    if (!user) throw new CompetitionError("HOST_NOT_FOUND", "Host user was not found.", 404);
    const nextRole = input.role ?? host.role;
    const nextStatus = input.status ?? host.status;
    if (input.username && input.username.trim() !== user.username) {
      const [conflict] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, input.username.trim())).limit(1);
      if (conflict && conflict.id !== user.id) throw new CompetitionError("HOST_USERNAME_EXISTS", "This username is already in use.", 409);
    }
    if (input.mobileNumber && input.mobileNumber.trim() !== host.mobileNumber) {
      const [conflict] = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.mobileNumber, input.mobileNumber.trim()))
        .limit(1);
      if (conflict && conflict.id !== user.id) {
        throw new CompetitionError("HOST_MOBILE_EXISTS", "A user with this mobile number already exists.", 409);
      }
    }
    await tx.update(usersTable).set({
      name: input.name?.trim() ?? user.name,
      username: input.username?.trim() ?? user.username,
      mobileNumber: input.mobileNumber?.trim() ?? user.mobileNumber,
      role: nextRole === "omb" ? "omb_host" : "tournament_host",
    }).where(eq(usersTable.id, user.id));
    const [updated] = await tx.update(hostsTable).set({
      mobileNumber: input.mobileNumber?.trim() ?? host.mobileNumber,
      upiId: input.upiId?.trim() ?? host.upiId,
      role: nextRole,
      status: nextStatus,
    }).where(eq(hostsTable.id, hostId)).returning();
    return updated;
  });
}

export async function resetHostPassword(hostId: string, password: string) {
  const [host] = await db.select().from(hostsTable).where(eq(hostsTable.id, hostId)).limit(1);
  if (!host) throw new CompetitionError("HOST_NOT_FOUND", "Host was not found.", 404);
  const [updated] = await db.update(usersTable).set({ passwordHash: await hashPassword(password), passwordAlgo: PASSWORD_ALGO }).where(eq(usersTable.id, host.userId)).returning({ id: usersTable.id });
  if (!updated) throw new CompetitionError("HOST_NOT_FOUND", "Host user was not found.", 404);
  return updated;
}

export async function markHostPaid(hostId: string) {
  const [updated] = await db
    .update(hostsTable)
    .set({ paidCount: sql`${hostsTable.completedCount}` })
    .where(eq(hostsTable.id, hostId))
    .returning();
  if (!updated) throw new CompetitionError("HOST_NOT_FOUND", "Host was not found.", 404);
  return updated;
}

export async function listGames() {
  return db.select().from(gamesTable).where(eq(gamesTable.isActive, true)).orderBy(asc(gamesTable.name));
}

export async function listModes(gameId?: string) {
  return db
    .select()
    .from(modesTable)
    .where(and(eq(modesTable.isActive, true), gameId ? eq(modesTable.gameId, gameId) : undefined))
    .orderBy(asc(modesTable.name));
}

export async function listSchedules(type: CompetitionType, modeId?: string) {
  const rows = await db
    .select({ schedule: competitionSchedulesTable })
    .from(competitionSchedulesTable)
    .innerJoin(modesTable, eq(modesTable.id, competitionSchedulesTable.modeId))
    .where(
      and(
        eq(modesTable.type, type),
        eq(competitionSchedulesTable.status, "published"),
        modeId ? eq(competitionSchedulesTable.modeId, modeId) : undefined,
      ),
    )
    .orderBy(asc(competitionSchedulesTable.startsAt), asc(competitionSchedulesTable.entryClosesAt));
  return rows.map((row) => row.schedule);
}

async function findOpenMatch(tx: Tx, scheduleId: string, maxParticipants: number) {
  const rows = await tx
    .select({ match: matchesTable, participantCount: count(matchParticipantsTable.id) })
    .from(matchesTable)
    .leftJoin(matchParticipantsTable, eq(matchParticipantsTable.matchId, matchesTable.id))
    .where(and(eq(matchesTable.scheduleId, scheduleId), eq(matchesTable.status, "waiting")))
    .groupBy(matchesTable.id)
    .orderBy(asc(matchesTable.createdAt))
    .for("update");
  return rows.find((row) => Number(row.participantCount) < maxParticipants)?.match;
}

async function findOpenTournament(tx: Tx, scheduleId: string, maxParticipants: number) {
  const rows = await tx
    .select({ tournament: tournamentsTable, participantCount: count(tournamentParticipantsTable.id) })
    .from(tournamentsTable)
    .leftJoin(
      tournamentParticipantsTable,
      eq(tournamentParticipantsTable.tournamentId, tournamentsTable.id),
    )
    .where(and(eq(tournamentsTable.scheduleId, scheduleId), eq(tournamentsTable.status, "waiting")))
    .groupBy(tournamentsTable.id)
    .orderBy(asc(tournamentsTable.createdAt))
    .for("update");
  return rows.find((row) => Number(row.participantCount) < maxParticipants)?.tournament;
}

async function assertNotAlreadyJoined(
  tx: Tx,
  userId: string,
  scheduleId: string,
  type: CompetitionType,
) {
  const [existing] =
    type === "omb"
      ? await tx
          .select({ id: matchParticipantsTable.id })
          .from(matchParticipantsTable)
          .innerJoin(matchesTable, eq(matchesTable.id, matchParticipantsTable.matchId))
          .where(
            and(
              eq(matchParticipantsTable.userId, userId),
              eq(matchesTable.scheduleId, scheduleId),
              inArray(matchesTable.status, ["waiting", "room_available", "ongoing", "result_pending"]),
            ),
          )
          .limit(1)
      : await tx
          .select({ id: tournamentParticipantsTable.id })
          .from(tournamentParticipantsTable)
          .innerJoin(tournamentsTable, eq(tournamentsTable.id, tournamentParticipantsTable.tournamentId))
          .where(
            and(
              eq(tournamentParticipantsTable.userId, userId),
              eq(tournamentsTable.scheduleId, scheduleId),
              inArray(tournamentsTable.status, ["waiting", "ongoing", "result_pending"]),
            ),
          )
          .limit(1);
  if (existing) throw new CompetitionError("ALREADY_JOINED", "You have already joined this competition.");
}

export interface JoinInput {
  userId: string;
  scheduleId: string;
  gameUid: string;
  gameName: string;
}

export async function joinCompetition(input: JoinInput) {
  const result = await db.transaction(async (tx) => {
    // The schedule row is the serialization point for first-participant and
    // next-full-match creation. This remains correct with multiple API nodes.
    const [schedule] = await tx
      .select()
      .from(competitionSchedulesTable)
      .where(eq(competitionSchedulesTable.id, input.scheduleId))
      .for("update");
    if (!schedule || schedule.status !== "published") {
      throw new CompetitionError("SCHEDULE_UNAVAILABLE", "This competition is not available for joining.");
    }
    const mode = await getModeForSchedule(tx, schedule.id);
    const now = new Date();
    const closingTime = mode.type === "omb" ? schedule.startsAt : schedule.entryClosesAt;
    if (closingTime && now >= closingTime) {
      throw new CompetitionError("ENTRY_CLOSED", "Entry for this competition has closed.");
    }
    await assertNotAlreadyJoined(tx, input.userId, input.scheduleId, mode.type);
    const wallet = await getWallet(tx, input.userId);

    const existing =
      mode.type === "omb"
        ? await findOpenMatch(tx, schedule.id, mode.maxParticipants)
        : await findOpenTournament(tx, schedule.id, mode.maxParticipants);
    const event =
      existing ??
      (mode.type === "omb"
        ? (
            await tx
              .insert(matchesTable)
              .values({ code: eventCode("omb"), scheduleId: schedule.id })
              .returning()
          )[0]
        : (
            await tx
              .insert(tournamentsTable)
              .values({
                code: eventCode("tournament"),
                scheduleId: schedule.id,
                entryClosesAt: schedule.entryClosesAt,
              })
              .returning()
          )[0]);
    if (!event) throw new CompetitionError("EVENT_CREATE_FAILED", "Unable to create the competition.", 500);

    const reservation = await createReservation(tx, {
      walletAccountId: wallet.id,
      amount: mode.entryFee,
      reasonType: "competition_entry",
      reasonId: event.id,
      idempotencyKey: `competition-entry:${event.id}:${input.userId}`,
    });
    const settled = await confirmReservation(tx, {
      reservationId: reservation.id,
      transactionIdempotencyKey: `competition-entry-debit:${event.id}:${input.userId}`,
      referenceType: mode.type === "omb" ? "omb_entry" : "tournament_entry",
      referenceId: event.id,
      description: `${mode.type === "omb" ? "OMB" : "Tournament"} entry ${event.code}`,
    });

    const participant =
      mode.type === "omb"
        ? (
            await tx
              .insert(matchParticipantsTable)
              .values({
                matchId: event.id,
                userId: input.userId,
                gameUid: input.gameUid.trim(),
                gameName: input.gameName.trim(),
                seatNumber: (await nextSeat(tx, event.id, "omb")),
                reservationId: settled.reservation.id,
              })
              .returning()
          )[0]
        : (
            await tx
              .insert(tournamentParticipantsTable)
              .values({
                tournamentId: event.id,
                userId: input.userId,
                gameUid: input.gameUid.trim(),
                gameName: input.gameName.trim(),
                reservationId: settled.reservation.id,
              })
              .returning()
          )[0];
    if (!participant) throw new CompetitionError("JOIN_FAILED", "Unable to join the competition.", 500);
    return { type: mode.type, event, participant };
  });
  logger.info({ event: "competition.joined", type: result.type, competitionId: result.event.id }, "Competition joined.");
  void notifyNewCompetitionHosts(result.type, result.event.id);
  return result;
}

async function notifyNewCompetitionHosts(type: CompetitionType, competitionId: string) {
  const hosts = await db.select({ userId: hostsTable.userId }).from(hostsTable).where(and(eq(hostsTable.role, type === "omb" ? "omb" : "tournament"), eq(hostsTable.status, "active")));
  for (const host of hosts) notifyPush({ userId: host.userId, title: type === "omb" ? "New match available" : "New tournament available", body: `A new ${type === "omb" ? "match" : "tournament"} is available to claim.`, data: { type, competitionId } });
}

async function notifyCompetitionParticipants(type: CompetitionType, competitionId: string, title: string, body: string) {
  try {
    const participants = type === "omb"
      ? await db.select({ userId: matchParticipantsTable.userId }).from(matchParticipantsTable).where(eq(matchParticipantsTable.matchId, competitionId))
      : await db.select({ userId: tournamentParticipantsTable.userId }).from(tournamentParticipantsTable).where(eq(tournamentParticipantsTable.tournamentId, competitionId));
    for (const participant of participants) notifyPush({ userId: participant.userId, title, body, data: { type, competitionId } });
  } catch (error) {
    logger.error({ event: "competition.notification_lookup_failed", type, competitionId, error: error instanceof Error ? error.message : String(error) }, "Competition participant notification lookup failed.");
  }
}

export async function setAdminRoomDetails(type: CompetitionType, competitionId: string, roomId: string, roomPassword: string) {
  const updated = await db.transaction(async (tx) => {
    if (type !== "omb") throw new CompetitionError("INVALID_COMPETITION_TYPE", "Room details are only available for OMB competitions.");
    const [event] = await tx.update(matchesTable).set({ roomId, roomPassword, roomDetailsAddedAt: new Date(), status: "room_available" }).where(eq(matchesTable.id, competitionId)).returning();
    if (!event) throw new CompetitionError("COMPETITION_NOT_FOUND", "Competition was not found.", 404);
    return event;
  });
  void notifyCompetitionParticipants(type, competitionId, "Room details available", `The room ID and password for ${updated.code} are now available.`);
  return updated;
}

async function nextSeat(tx: Tx, eventId: string, type: CompetitionType): Promise<number> {
  const [row] =
    type === "omb"
      ? await tx
          .select({ max: sql<number>`coalesce(max(${matchParticipantsTable.seatNumber}), 0)` })
          .from(matchParticipantsTable)
          .where(eq(matchParticipantsTable.matchId, eventId))
      : [{ max: 0 }];
  return Number(row?.max ?? 0) + 1;
}

export async function getCompetition(type: CompetitionType, id: string, viewer: CompetitionViewer) {
  if (type === "omb") {
    const [match] = await db.select().from(matchesTable).where(eq(matchesTable.id, id)).limit(1);
    if (!match) return null;
    const participants = await db
      .select()
      .from(matchParticipantsTable)
      .where(eq(matchParticipantsTable.matchId, id))
      .orderBy(asc(matchParticipantsTable.position), asc(matchParticipantsTable.joinedAt));
    const isStaff = ["admin", "manager", "support"].includes(viewer.role);
    const isAssignedHost = viewer.role === "omb_host" && match.hostId != null &&
      (await db.select({ id: hostsTable.id }).from(hostsTable).where(and(eq(hostsTable.id, match.hostId), eq(hostsTable.userId, viewer.userId))).limit(1)).length > 0;
    if (!isStaff && !isAssignedHost && !participants.some((participant) => participant.userId === viewer.userId)) {
      return null;
    }
    return {
      type,
      event: isStaff || isAssignedHost || match.status !== "waiting"
        ? match
        : { ...match, roomId: null, roomPassword: null },
      participants: isStaff || isAssignedHost
        ? participants
        : participants.filter((participant) => participant.userId === viewer.userId),
    };
  }
  const [tournament] = await db.select().from(tournamentsTable).where(eq(tournamentsTable.id, id)).limit(1);
  if (!tournament) return null;
  const participants = await db
    .select()
    .from(tournamentParticipantsTable)
    .where(eq(tournamentParticipantsTable.tournamentId, id))
    .orderBy(asc(tournamentParticipantsTable.rank), asc(tournamentParticipantsTable.joinedAt));
  const isStaff = ["admin", "manager", "support"].includes(viewer.role);
  const isAssignedHost = viewer.role === "tournament_host" && tournament.hostId != null &&
    (await db.select({ id: hostsTable.id }).from(hostsTable).where(and(eq(hostsTable.id, tournament.hostId), eq(hostsTable.userId, viewer.userId))).limit(1)).length > 0;
  if (!isStaff && !isAssignedHost && !participants.some((participant) => participant.userId === viewer.userId)) {
    return null;
  }
  return {
    type,
    event: tournament,
    participants: isStaff || isAssignedHost
      ? participants
      : participants.map((participant) => participant.userId === viewer.userId
        ? participant
        : {
            ...participant,
            userId: undefined,
            reservationId: undefined,
          }),
  };
}

export async function claimCompetition(type: CompetitionType, id: string, userId: string) {
  return db.transaction(async (tx) => {
    const [host] = await tx
      .select()
      .from(hostsTable)
      .where(and(eq(hostsTable.userId, userId), eq(hostsTable.status, "active")))
      .for("update");
    if (!host || host.role !== (type === "omb" ? "omb" : "tournament")) {
      throw new CompetitionError("HOST_ROLE_REQUIRED", "You are not an active host for this competition type.", 403);
    }
    if (host.currentAssignmentId) {
      throw new CompetitionError("HOST_BUSY", "You already have an active assignment.");
    }
    const table = type === "omb" ? matchesTable : tournamentsTable;
    const [event] = await tx.select().from(table).where(eq(table.id, id)).for("update");
    if (!event) throw new CompetitionError("COMPETITION_NOT_FOUND", "Competition was not found.", 404);
    if (event.status !== "waiting") throw new CompetitionError("NOT_AVAILABLE", "This competition is not available to claim.");
    const [updated] = await tx
      .update(table)
      .set({ hostId: host.id, hostClaimedAt: new Date() })
      .where(eq(table.id, id))
      .returning();
    await tx
      .update(hostsTable)
      .set({ currentAssignmentType: type, currentAssignmentId: id })
      .where(eq(hostsTable.id, host.id));
    return updated;
  });
}

export async function releaseCompetition(type: CompetitionType, id: string, userId: string) {
  return db.transaction(async (tx) => {
    const [host] = await tx.select().from(hostsTable).where(eq(hostsTable.userId, userId)).for("update");
    if (!host || host.currentAssignmentId !== id || host.currentAssignmentType !== type) {
      throw new CompetitionError("ASSIGNMENT_REQUIRED", "This competition is not your active assignment.", 403);
    }
    const table = type === "omb" ? matchesTable : tournamentsTable;
    const [event] = await tx.select().from(table).where(eq(table.id, id)).for("update");
    if (!event || event.status === "completed" || event.status === "cancelled") {
      throw new CompetitionError("NOT_RELEASEABLE", "This competition can no longer be released.");
    }
    const [updated] = await tx.update(table).set({ hostId: null, hostClaimedAt: null }).where(eq(table.id, id)).returning();
    await tx.update(hostsTable).set({ currentAssignmentType: null, currentAssignmentId: null }).where(eq(hostsTable.id, host.id));
    return updated;
  });
}

function assertHostAssignment(host: { currentAssignmentId: string | null; currentAssignmentType: string | null }, type: CompetitionType, id: string) {
  if (host.currentAssignmentId !== id || host.currentAssignmentType !== type) {
    throw new CompetitionError("ASSIGNMENT_REQUIRED", "This competition is not your active assignment.", 403);
  }
}

async function getHostForEvent(tx: Tx, type: CompetitionType, id: string, userId: string) {
  const [host] = await tx.select().from(hostsTable).where(eq(hostsTable.userId, userId)).for("update");
  if (!host) throw new CompetitionError("HOST_REQUIRED", "Host account was not found.", 403);
  assertHostAssignment(host, type, id);
  return host;
}

export async function addRoomDetails(id: string, userId: string, roomId: string, roomPassword: string, roomIdConfirmation: string, roomPasswordConfirmation: string) {
  assertDoubleEntry(roomId.trim(), roomIdConfirmation.trim());
  assertDoubleEntry(roomPassword.trim(), roomPasswordConfirmation.trim());
  const updated = await db.transaction(async (tx) => {
    await getHostForEvent(tx, "omb", id, userId);
    const [updated] = await tx
      .update(matchesTable)
      .set({ roomId: roomId.trim(), roomPassword: roomPassword.trim(), roomDetailsAddedAt: new Date(), status: "room_available" })
      .where(and(eq(matchesTable.id, id), inArray(matchesTable.status, ["waiting", "room_available"])))
      .returning();
    if (!updated) throw new CompetitionError("INVALID_STATUS", "Room details cannot be changed now.");
    return updated;
  });
  void notifyCompetitionParticipants("omb", id, "Room details available", "Room details are now available for your match.");
  return updated;
}

export async function confirmRoomParticipant(id: string, participantId: string, userId: string) {
  return db.transaction(async (tx) => {
    await getHostForEvent(tx, "omb", id, userId);
    const [updated] = await tx
      .update(matchParticipantsTable)
      .set({ roomConfirmedAt: new Date() })
      .where(and(eq(matchParticipantsTable.id, participantId), eq(matchParticipantsTable.matchId, id)))
      .returning();
    if (!updated) throw new CompetitionError("PARTICIPANT_NOT_FOUND", "Participant was not found.", 404);
    return updated;
  });
}

async function refundParticipant(tx: Tx, reservationId: string, competitionId: string, userId: string) {
  const [reservation] = await tx.select().from(walletReservationsTable).where(eq(walletReservationsTable.id, reservationId)).for("update");
  if (!reservation || reservation.status !== "confirmed" || !reservation.confirmedByTransactionId) return;
  const [entryTx] = await tx.select().from(walletTransactionsTable).where(eq(walletTransactionsTable.id, reservation.confirmedByTransactionId)).limit(1);
  if (!entryTx) throw new Error(`Missing entry transaction for reservation ${reservationId}`);
  const [wallet] = await tx.select().from(walletAccountsTable).where(eq(walletAccountsTable.id, reservation.walletAccountId)).for("update");
  if (!wallet) throw new Error(`Missing wallet for reservation ${reservationId}`);
  await recordCompletedTransaction(tx, {
    walletAccountId: wallet.id,
    amount: reservation.amount,
    referenceType: "competition_refund",
    referenceId: competitionId,
    idempotencyKey: `competition-refund:${competitionId}:${userId}`,
    reversalOfTransactionId: entryTx.id,
    description: "Competition cancellation refund",
  });
}

async function creditPrize(tx: Tx, userId: string, amount: number, competitionId: string, participantId: string) {
  if (amount <= 0) return;
  const [wallet] = await tx
    .select()
    .from(walletAccountsTable)
    .where(and(eq(walletAccountsTable.userId, userId), eq(walletAccountsTable.walletType, "winning_coins")))
    .for("update");
  if (!wallet) throw new Error(`Winning Coins wallet not found for user ${userId}`);
  await recordCompletedTransaction(tx, {
    walletAccountId: wallet.id,
    amount,
    referenceType: "competition_prize",
    referenceId: competitionId,
    idempotencyKey: `competition-prize:${competitionId}:${participantId}`,
    description: "Competition prize",
  });
}

export async function submitOmbResults(
  id: string,
  userId: string,
  positions: Array<{ participantId: string; position: number; positionConfirmation: number; isCheater?: boolean; cheaterConfirmation?: boolean }>,
) {
  const cheaterUserIds: string[] = [];
  const updated = await db.transaction(async (tx) => {
    const host = await getHostForEvent(tx, "omb", id, userId);
    const [match] = await tx.select().from(matchesTable).where(eq(matchesTable.id, id)).for("update");
    if (!match || !["room_available", "ongoing", "result_pending"].includes(match.status)) {
      throw new CompetitionError("INVALID_STATUS", "Results cannot be submitted for this match.");
    }
    const [schedule] = await tx.select().from(competitionSchedulesTable).where(eq(competitionSchedulesTable.id, match.scheduleId)).limit(1);
    if (!schedule) throw new CompetitionError("SCHEDULE_NOT_FOUND", "Schedule was not found.", 500);
    const mode = await getModeForSchedule(tx, schedule.id, "omb");
    const participants = await tx.select().from(matchParticipantsTable).where(eq(matchParticipantsTable.matchId, id)).for("update");
    if (!participants.length || positions.length !== participants.length) {
      throw new CompetitionError("POSITIONS_REQUIRED", "Submit exactly one position for every participant.");
    }
    const positionSet = new Set(positions.map((item) => item.position));
    if (positionSet.size !== positions.length || Math.min(...positions.map((item) => item.position)) < 1) {
      throw new CompetitionError("INVALID_POSITIONS", "Positions must be unique positive numbers.");
    }
    const prizeByPosition = new Map(mode.prizes.map((prize) => [prize.position, prize.amount]));
    for (const item of positions) {
      assertDoubleEntry(item.position, item.positionConfirmation);
      assertDoubleEntry(item.isCheater === true, item.cheaterConfirmation === true);
      const participant = participants.find((candidate) => candidate.id === item.participantId);
      if (!participant) throw new CompetitionError("PARTICIPANT_NOT_FOUND", "A submitted participant was not found.");
      const isCheater = item.isCheater === true;
      if (isCheater) cheaterUserIds.push(participant.userId);
      await tx.update(matchParticipantsTable).set({
        position: item.position,
        isCheater,
        prizeAmount: isCheater ? 0 : (prizeByPosition.get(item.position) ?? 0),
      }).where(eq(matchParticipantsTable.id, participant.id));
      if (!isCheater) await creditPrize(tx, participant.userId, prizeByPosition.get(item.position) ?? 0, id, participant.id);
    }
    const [updated] = await tx.update(matchesTable).set({ status: "completed", resultSubmittedAt: new Date() }).where(eq(matchesTable.id, id)).returning();
    await tx.update(hostsTable).set({ currentAssignmentId: null, currentAssignmentType: null, completedCount: sql`${hostsTable.completedCount} + 1` }).where(eq(hostsTable.id, host.id));
    return updated;
  });
  void notifyCompetitionParticipants("omb", id, "Results are out", "Check your match result and prize.");
  for (const userId of cheaterUserIds) notifyPush({ userId, title: "Hacker/Cheater tag applied", body: "A Hacker/Cheater tag was applied to your result. Contact Support to appeal.", data: { type: "omb", competitionId: id } });
  if (cheaterUserIds.length) {
    void notifyRolePush("admin", "Hacker/Cheater tag", "A competition participant was tagged as a Hacker/Cheater.", { type: "omb", competitionId: id });
    void notifyRolePush("support", "Hacker/Cheater tag", "A competition participant was tagged as a Hacker/Cheater.", { type: "omb", competitionId: id });
  }
  return updated;
}

export interface TournamentInitialValue {
  participantId: string;
  initialValue: number;
  initialValueConfirmation: number;
}

export interface TournamentFinalValue {
  participantId: string;
  finalValue: number;
  finalValueConfirmation: number;
  isCheater?: boolean;
  cheaterConfirmation?: boolean;
}

/**
 * Starts a tournament and records the immutable starting metric for every
 * participant in one transaction. The host must submit a value for every
 * participant so ranking can never be based on a partially initialized event.
 */
export async function startTournament(
  id: string,
  userId: string,
  values: TournamentInitialValue[],
) {
  return db.transaction(async (tx) => {
    const host = await getHostForEvent(tx, "tournament", id, userId);
    const [tournament] = await tx
      .select()
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, id))
      .for("update");
    if (!tournament || tournament.status !== "waiting") {
      throw new CompetitionError("INVALID_STATUS", "This tournament cannot be started.");
    }
    const [schedule] = await tx
      .select()
      .from(competitionSchedulesTable)
      .where(eq(competitionSchedulesTable.id, tournament.scheduleId))
      .limit(1);
    if (!schedule || !schedule.durationMinutes) {
      throw new CompetitionError("SCHEDULE_NOT_FOUND", "Tournament schedule was not found.", 500);
    }
    if (tournament.entryClosesAt && new Date() < tournament.entryClosesAt) {
      throw new CompetitionError("ENTRY_OPEN", "A tournament can only start after entry closes.");
    }
    const participants = await tx
      .select()
      .from(tournamentParticipantsTable)
      .where(eq(tournamentParticipantsTable.tournamentId, id))
      .for("update");
    if (!participants.length || values.length !== participants.length) {
      throw new CompetitionError("INITIAL_VALUES_REQUIRED", "Submit exactly one initial value for every participant.");
    }
    const valueByParticipant = new Map(values.map((value) => [value.participantId, value.initialValue]));
    if (valueByParticipant.size !== values.length || values.some((value) => !Number.isInteger(value.initialValue))) {
      throw new CompetitionError("INVALID_INITIAL_VALUES", "Initial values must be unique participant entries and whole numbers.");
    }
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + schedule.durationMinutes * 60_000);
    for (const participant of participants) {
      const initialValue = valueByParticipant.get(participant.id);
      if (initialValue === undefined) {
        throw new CompetitionError("PARTICIPANT_NOT_FOUND", "An initial value was submitted for an unknown participant.");
      }
      const submitted = values.find((value) => value.participantId === participant.id)!;
      assertDoubleEntry(initialValue, submitted.initialValueConfirmation);
      await tx
        .update(tournamentParticipantsTable)
        .set({ initialValue, startedAt, endsAt })
        .where(eq(tournamentParticipantsTable.id, participant.id));
    }
    const [updated] = await tx
      .update(tournamentsTable)
      .set({ status: "ongoing", startedAt, endsAt })
      .where(eq(tournamentsTable.id, id))
      .returning();
    await tx
      .update(hostsTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(hostsTable.id, host.id));
    return updated;
  });
}

export async function startTournamentParticipant(
  tournamentId: string,
  participantId: string,
  userId: string,
  initialValue: number,
  initialValueConfirmation: number,
) {
  assertDoubleEntry(initialValue, initialValueConfirmation);
  const updatedParticipant = await db.transaction(async (tx) => {
    await getHostForEvent(tx, "tournament", tournamentId, userId);
    const [tournament] = await tx
      .select()
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId))
      .for("update");
    if (!tournament || !["waiting", "ongoing"].includes(tournament.status)) {
      throw new CompetitionError("INVALID_STATUS", "This tournament participant cannot be started.");
    }
    if (tournament.entryClosesAt && new Date() < tournament.entryClosesAt) {
      throw new CompetitionError("ENTRY_OPEN", "A tournament participant can only start after entry closes.");
    }
    if (!Number.isInteger(initialValue) || initialValue < 0) {
      throw new CompetitionError("INVALID_INITIAL_VALUE", "Initial value must be a non-negative whole number.");
    }
    const [participant] = await tx
      .select()
      .from(tournamentParticipantsTable)
      .where(
        and(
          eq(tournamentParticipantsTable.id, participantId),
          eq(tournamentParticipantsTable.tournamentId, tournamentId),
        ),
      )
      .for("update");
    if (!participant) throw new CompetitionError("PARTICIPANT_NOT_FOUND", "Participant was not found.", 404);
    if (participant.startedAt) {
      throw new CompetitionError("PARTICIPANT_ALREADY_STARTED", "This participant has already been started.");
    }
    const schedule = await getSchedule(tx, tournament.scheduleId, "tournament");
    if (!schedule.durationMinutes) {
      throw new CompetitionError("SCHEDULE_NOT_FOUND", "Tournament duration is not configured.", 500);
    }
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + schedule.durationMinutes * 60_000);
    const [updatedParticipant] = await tx
      .update(tournamentParticipantsTable)
      .set({ initialValue, startedAt, endsAt })
      .where(eq(tournamentParticipantsTable.id, participantId))
      .returning();
    const tournamentStartedAt = tournament.startedAt ?? startedAt;
    const tournamentEndsAt = !tournament.endsAt || endsAt > tournament.endsAt ? endsAt : tournament.endsAt;
    await tx
      .update(tournamentsTable)
      .set({ status: "ongoing", startedAt: tournamentStartedAt, endsAt: tournamentEndsAt })
      .where(eq(tournamentsTable.id, tournamentId));
    return updatedParticipant;
  });
  notifyPush({ userId: updatedParticipant.userId, title: "Your tournament has started", body: "Your tournament has started. Good luck!", data: { type: "tournament", competitionId: tournamentId } });
  return updatedParticipant;
}

/**
 * Completes a tournament atomically. Performance is finalValue - initialValue;
 * higher performance ranks first. Equal performances use join order as the
 * deterministic tie-breaker, so every participant receives one stable rank.
 */
export async function submitTournamentResults(
  id: string,
  userId: string,
  values: TournamentFinalValue[],
) {
  const cheaterUserIds: string[] = [];
  const updated = await db.transaction(async (tx) => {
    const host = await getHostForEvent(tx, "tournament", id, userId);
    const [tournament] = await tx
      .select()
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, id))
      .for("update");
    if (!tournament || !["ongoing", "result_pending"].includes(tournament.status)) {
      throw new CompetitionError("INVALID_STATUS", "Results cannot be submitted for this tournament.");
    }
    if (tournament.endsAt && new Date() < tournament.endsAt) {
      throw new CompetitionError("TOURNAMENT_ACTIVE", "Tournament results cannot be submitted before the tournament ends.");
    }
    const participants = await tx
      .select()
      .from(tournamentParticipantsTable)
      .where(eq(tournamentParticipantsTable.tournamentId, id))
      .orderBy(asc(tournamentParticipantsTable.joinedAt))
      .for("update");
    if (!participants.length || values.length !== participants.length) {
      throw new CompetitionError("FINAL_VALUES_REQUIRED", "Submit exactly one final value for every participant.");
    }
    const valueByParticipant = new Map(values.map((value) => [value.participantId, value]));
    if (
      valueByParticipant.size !== values.length ||
      values.some((value) => !Number.isInteger(value.finalValue))
    ) {
      throw new CompetitionError("INVALID_FINAL_VALUES", "Final values must be unique participant entries and whole numbers.");
    }
    const scored = participants.map((participant) => {
      const submitted = valueByParticipant.get(participant.id);
      if (!submitted || participant.initialValue == null) {
        throw new CompetitionError("INITIAL_VALUES_REQUIRED", "Every participant must have an initial value before results.");
      }
      assertDoubleEntry(submitted.finalValue, submitted.finalValueConfirmation);
      assertDoubleEntry(submitted.isCheater === true, submitted.cheaterConfirmation === true);
      return {
        participant,
        finalValue: submitted.finalValue,
        isCheater: submitted.isCheater === true,
        performance: submitted.finalValue - participant.initialValue,
      };
    });
    scored.sort((a, b) => b.performance - a.performance || a.participant.joinedAt.getTime() - b.participant.joinedAt.getTime());
    const schedule = await getSchedule(tx, tournament.scheduleId, "tournament");
    const mode = await getModeForSchedule(tx, schedule.id, "tournament");
    const prizeByPosition = new Map(mode.prizes.map((prize) => [prize.position, prize.amount]));
    for (const [index, item] of scored.entries()) {
      if (item.isCheater) cheaterUserIds.push(item.participant.userId);
      const rank = index + 1;
      const prizeAmount = item.isCheater ? 0 : (prizeByPosition.get(rank) ?? 0);
      await tx
        .update(tournamentParticipantsTable)
        .set({
          finalValue: item.finalValue,
          performance: item.performance,
          rank,
          isCheater: item.isCheater,
          prizeAmount,
        })
        .where(eq(tournamentParticipantsTable.id, item.participant.id));
      if (!item.isCheater) {
        await creditPrize(tx, item.participant.userId, prizeAmount, id, item.participant.id);
      }
    }
    const [updated] = await tx
      .update(tournamentsTable)
      .set({ status: "completed", resultSubmittedAt: new Date() })
      .where(eq(tournamentsTable.id, id))
      .returning();
    await tx
      .update(hostsTable)
      .set({
        currentAssignmentId: null,
        currentAssignmentType: null,
        completedCount: sql`${hostsTable.completedCount} + 1`,
      })
      .where(eq(hostsTable.id, host.id));
    return updated;
  });
  void notifyCompetitionParticipants("tournament", id, "Results are out", "Check your tournament result and prize.");
  for (const userId of cheaterUserIds) notifyPush({ userId, title: "Hacker/Cheater tag applied", body: "A Hacker/Cheater tag was applied to your result. Contact Support to appeal.", data: { type: "tournament", competitionId: id } });
  if (cheaterUserIds.length) {
    void notifyRolePush("admin", "Hacker/Cheater tag", "A competition participant was tagged as a Hacker/Cheater.", { type: "tournament", competitionId: id });
    void notifyRolePush("support", "Hacker/Cheater tag", "A competition participant was tagged as a Hacker/Cheater.", { type: "tournament", competitionId: id });
  }
  return updated;
}

export async function createTournamentPositionReveal(input: {
  scheduleId: string;
  revealAt: Date;
}) {
  const schedule = await db
    .select({ id: competitionSchedulesTable.id, modeId: competitionSchedulesTable.modeId })
    .from(competitionSchedulesTable)
    .where(eq(competitionSchedulesTable.id, input.scheduleId))
    .limit(1);
  if (!schedule[0]) {
    throw new CompetitionError("SCHEDULE_NOT_FOUND", "Tournament schedule was not found.", 404);
  }
  const mode = await getModeForSchedule(db, schedule[0].id, "tournament");
  const [reveal] = await db
    .insert(tournamentPositionRevealsTable)
    .values({ scheduleId: input.scheduleId, revealAt: input.revealAt })
    .returning();
  return reveal;
}

/**
 * Stores one complete scheduled standings snapshot. A partial snapshot is not
 * published: all current participants must be submitted in the same request.
 */
export async function submitTournamentPositionReveal(
  tournamentId: string,
  revealId: string,
  userId: string,
  values: Array<{ participantId: string; metricValue: number }>,
) {
  const result = await db.transaction(async (tx) => {
    await getHostForEvent(tx, "tournament", tournamentId, userId);
    const [tournament] = await tx
      .select()
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId))
      .for("update");
    if (!tournament || !["ongoing", "result_pending"].includes(tournament.status)) {
      throw new CompetitionError("INVALID_STATUS", "Standings cannot be submitted for this tournament.");
    }
    const [reveal] = await tx
      .select()
      .from(tournamentPositionRevealsTable)
      .where(
        and(
          eq(tournamentPositionRevealsTable.id, revealId),
          eq(tournamentPositionRevealsTable.scheduleId, tournament.scheduleId),
        ),
      )
      .limit(1);
    if (!reveal) throw new CompetitionError("REVEAL_NOT_FOUND", "Position reveal schedule was not found.", 404);
    const participants = await tx
      .select()
      .from(tournamentParticipantsTable)
      .where(eq(tournamentParticipantsTable.tournamentId, tournamentId))
      .orderBy(asc(tournamentParticipantsTable.joinedAt))
      .for("update");
    if (!participants.length || values.length !== participants.length) {
      throw new CompetitionError("STANDINGS_REQUIRED", "Submit one metric value for every participant.");
    }
    const valueByParticipant = new Map(values.map((value) => [value.participantId, value.metricValue]));
    if (
      valueByParticipant.size !== values.length ||
      values.some((value) => !Number.isInteger(value.metricValue)) ||
      participants.some((participant) => !valueByParticipant.has(participant.id))
    ) {
      throw new CompetitionError("INVALID_STANDINGS", "Standings must contain exactly one value for every participant.");
    }
    const existing = await tx
      .select({ id: tournamentPositionValuesTable.id })
      .from(tournamentPositionValuesTable)
      .where(eq(tournamentPositionValuesTable.revealId, revealId))
      .limit(1);
    if (existing[0]) {
      throw new CompetitionError("REVEAL_ALREADY_SUBMITTED", "This position reveal has already been submitted.");
    }
    const submittedAt = new Date();
    await tx.insert(tournamentPositionValuesTable).values(
      participants.map((participant) => ({
        revealId,
        tournamentId,
        participantId: participant.id,
        metricValue: valueByParticipant.get(participant.id)!,
        submittedAt,
      })),
    );
    const winnerCount = (await getModeForSchedule(tx, tournament.scheduleId, "tournament")).prizes.length;
    return {
      revealId,
      tournamentId,
      publishedAt: submittedAt,
      chart: participants
        .map((participant) => ({
          gameUid: participant.gameUid,
          gameName: participant.gameName,
          metricValue: valueByParticipant.get(participant.id)!,
          submittedAt,
        }))
        .sort((a, b) => b.metricValue - a.metricValue)
        .slice(0, winnerCount),
    };
  });
  void notifyCompetitionParticipants("tournament", tournamentId, "Standings update", "A new standings update is available.");
  return result;
}

export async function getTournamentParticipantList(
  tournamentId: string,
  viewer: CompetitionViewer,
  now = new Date(),
) {
  const [tournament] = await db
    .select()
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId))
    .limit(1);
  if (!tournament) return null;
  if (!tournament.entryClosesAt || now.getTime() < tournament.entryClosesAt.getTime() + 60 * 60_000) {
    throw new CompetitionError("PARTICIPANT_LIST_LOCKED", "The participant list is available one hour after entry closes.");
  }
  if (!["admin", "manager", "support"].includes(viewer.role)) {
    const [joined] = await db
      .select({ id: tournamentParticipantsTable.id })
      .from(tournamentParticipantsTable)
      .where(and(eq(tournamentParticipantsTable.tournamentId, tournamentId), eq(tournamentParticipantsTable.userId, viewer.userId)))
      .limit(1);
    if (!joined) return null;
  }
  const participants = await db
    .select({
      gameUid: tournamentParticipantsTable.gameUid,
      gameName: tournamentParticipantsTable.gameName,
      joinedAt: tournamentParticipantsTable.joinedAt,
    })
    .from(tournamentParticipantsTable)
    .where(eq(tournamentParticipantsTable.tournamentId, tournamentId))
    .orderBy(asc(tournamentParticipantsTable.joinedAt));
  return { tournamentId, participants };
}

export async function snoozeCompetitionUnclaimedAlert(
  type: CompetitionType,
  id: string,
  minutes: number,
) {
  const snoozedUntil = new Date(Date.now() + minutes * 60_000);
  const table = type === "omb" ? matchesTable : tournamentsTable;
  const [updated] = await db
    .update(table)
    .set({ managerUnclaimedSnoozedUntil: snoozedUntil })
    .where(and(eq(table.id, id), eq(table.status, "waiting"), isNull(table.hostId)))
    .returning();
  if (!updated) throw new CompetitionError("NOT_AVAILABLE", "This competition is no longer unclaimed.");
  return updated;
}

export async function createCompetitionUploadUrl(
  type: CompetitionType,
  id: string,
  kind: "screenshot" | "voice-note",
  userId: string,
  contentType: string,
) {
  if (kind === "screenshot" && type !== "omb") {
    throw new CompetitionError("INVALID_OBJECT", "Screenshots are supported for OMBs only.");
  }
  const allowedTypes = kind === "screenshot"
    ? ["image/jpeg", "image/png", "image/webp"]
    : ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm"];
  if (!allowedTypes.includes(contentType)) {
    throw new CompetitionError("INVALID_CONTENT_TYPE", "This file type is not supported.");
  }
  return db.transaction(async (tx) => {
    if (kind === "voice-note") {
      const [manager] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.role, "manager"))).limit(1);
      if (!manager) throw new CompetitionError("MANAGER_REQUIRED", "Only a manager can upload cancellation voice notes.", 403);
    } else {
      await getHostForEvent(tx, type, id, userId);
    }
    const table = type === "omb" ? matchesTable : tournamentsTable;
    const [event] = await tx.select({ id: table.id, status: table.status }).from(table).where(eq(table.id, id)).for("update");
    if (!event || event.status === "completed" || (event.status === "cancelled" && kind === "screenshot")) {
      throw new CompetitionError("INVALID_STATUS", "Files cannot be uploaded for this competition.");
    }
    if (kind === "voice-note" && event.status !== "cancelled") {
      throw new CompetitionError("INVALID_STATUS", "Voice notes can only be attached to cancelled competitions.");
    }
    const key = competitionObjectKey(type, id, kind);
    return { key, uploadUrl: await createUploadUrl({ key, contentType, maxBytes: kind === "screenshot" ? 10_000_000 : 20_000_000 }) };
  });
}

export async function attachCompetitionObject(
  type: CompetitionType,
  id: string,
  kind: "screenshot" | "voice-note",
  key: string,
  userId: string,
) {
  if (key !== competitionObjectKey(type, id, kind)) {
    throw new CompetitionError("INVALID_OBJECT_KEY", "The object key does not belong to this competition.");
  }
  const contentTypes = kind === "screenshot"
    ? ["image/jpeg", "image/png", "image/webp"]
    : ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm"];
  await verifyUploadedObject({ key, contentTypes, maxBytes: kind === "screenshot" ? 10_000_000 : 20_000_000 });
  return db.transaction(async (tx) => {
    if (kind === "voice-note") {
      const [manager] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.role, "manager"))).limit(1);
      if (!manager) throw new CompetitionError("MANAGER_REQUIRED", "Only a manager can attach cancellation voice notes.", 403);
    } else {
      await getHostForEvent(tx, type, id, userId);
    }
    const [event] = type === "omb"
      ? await tx.select({ status: matchesTable.status }).from(matchesTable).where(eq(matchesTable.id, id)).for("update")
      : await tx.select({ status: tournamentsTable.status }).from(tournamentsTable).where(eq(tournamentsTable.id, id)).for("update");
    if (!event) throw new CompetitionError("COMPETITION_NOT_FOUND", "Competition was not found.", 404);
    if (kind === "voice-note" && event.status !== "cancelled") throw new CompetitionError("INVALID_STATUS", "Voice notes can only be attached to cancelled competitions.");
    const [updated] = type === "omb"
      ? await tx.update(matchesTable).set(kind === "screenshot" ? { screenshotObjectKey: key } : { voiceNoteObjectKey: key }).where(eq(matchesTable.id, id)).returning()
      : await tx.update(tournamentsTable).set({ voiceNoteObjectKey: key }).where(eq(tournamentsTable.id, id)).returning();
    if (!updated) throw new CompetitionError("COMPETITION_NOT_FOUND", "Competition was not found.", 404);
    return updated;
  });
}

export async function getCompetitionObjectDownloadUrl(
  type: CompetitionType,
  id: string,
  kind: "screenshot" | "voice-note",
  viewer: CompetitionViewer,
) {
  const result = await getCompetition(type, id, viewer);
  if (!result) return null;
  if (kind === "voice-note" && !["admin", "manager", "support"].includes(viewer.role)) return null;
  const key = kind === "screenshot"
    ? (type === "omb" ? (result.event as Match).screenshotObjectKey : null)
    : (result.event as Match | Tournament).voiceNoteObjectKey;
  return key ? createDownloadUrl(key) : null;
}

async function distributeLowParticipationPrizes(
  tx: Tx,
  type: CompetitionType,
  competitionId: string,
  participants: Array<{ id: string; userId: string; reservationId: string }>,
  mode: Pick<Mode, "prizes">,
) {
  const shuffled = [...mode.prizes].sort(() => randomInt(-1_000_000, 1_000_001));
  for (const [index, participant] of participants.entries()) {
    const prizeAmount = shuffled[index]?.amount ?? 0;
    if (type === "omb") {
      await tx.update(matchParticipantsTable).set({ prizeAmount }).where(eq(matchParticipantsTable.id, participant.id));
    } else {
      await tx.update(tournamentParticipantsTable).set({ prizeAmount }).where(eq(tournamentParticipantsTable.id, participant.id));
    }
    await creditPrize(tx, participant.userId, prizeAmount, competitionId, participant.id);
  }
}

export async function cancelCompetition(
  type: CompetitionType,
  id: string,
  reason: string,
  refund: boolean,
  lowParticipation = false,
) {
  const updated = await db.transaction(async (tx) => {
    const table = type === "omb" ? matchesTable : tournamentsTable;
    const [event] = await tx.select().from(table).where(eq(table.id, id)).for("update");
    if (!event || event.status === "completed" || event.status === "cancelled") return event;
    const participants =
      type === "omb"
        ? await tx.select().from(matchParticipantsTable).where(eq(matchParticipantsTable.matchId, id)).for("update")
        : await tx.select().from(tournamentParticipantsTable).where(eq(tournamentParticipantsTable.tournamentId, id)).for("update");
    if (refund) {
      for (const participant of participants) await refundParticipant(tx, participant.reservationId, id, participant.userId);
    } else if (lowParticipation) {
      const mode = await getModeForSchedule(tx, event.scheduleId, type);
      await distributeLowParticipationPrizes(tx, type, id, participants, mode);
    }
    const [updated] = await tx.update(table).set({ status: "cancelled", cancellationReason: reason, cancelledAt: new Date() }).where(eq(table.id, id)).returning();
    if (event.hostId) {
      await tx.update(hostsTable).set({ currentAssignmentId: null, currentAssignmentType: null }).where(eq(hostsTable.id, event.hostId));
    }
    return updated;
  });
  void notifyCompetitionParticipants(type, id, "Competition cancelled", `${type === "omb" ? "Your match" : "Your tournament"} was cancelled. ${reason}`);
  for (const role of ["manager", "admin", "support"] as const) {
    void notifyRolePush(role, "Competition cancelled", `${type === "omb" ? "Match" : "Tournament"} ${id} was cancelled.`, { type, competitionId: id });
  }
  return updated;
}

export async function listHosts(
  role?: "omb" | "tournament",
  onlyFree = false,
  includeDisabled = false,
  search?: string,
) {
  const hosts = await db
    .select({ host: hostsTable, username: usersTable.username })
    .from(hostsTable)
    .innerJoin(usersTable, eq(usersTable.id, hostsTable.userId))
    .where(
      and(
        role ? eq(hostsTable.role, role) : undefined,
        includeDisabled ? undefined : eq(hostsTable.status, "active"),
        onlyFree ? isNull(hostsTable.currentAssignmentId) : undefined,
        search ? sql`${usersTable.name} ILIKE ${`%${search.trim()}%`}` : undefined,
      ),
    )
    .orderBy(asc(hostsTable.createdAt));
  return hosts.map(({ host, username }) => ({ ...host, username }));
}

export async function listCancelledCompetitions(type?: CompetitionType) {
  const types: CompetitionType[] = type ? [type] : ["omb", "tournament"];
  const competitions: Array<Record<string, unknown>> = [];
  for (const competitionType of types) {
    const table = competitionType === "omb" ? matchesTable : tournamentsTable;
    const rows = await db
      .select({ event: table, schedule: competitionSchedulesTable, mode: modesTable, game: gamesTable })
      .from(table)
      .innerJoin(competitionSchedulesTable, eq(competitionSchedulesTable.id, table.scheduleId))
      .innerJoin(modesTable, eq(modesTable.id, competitionSchedulesTable.modeId))
      .innerJoin(gamesTable, eq(gamesTable.id, modesTable.gameId))
      .where(eq(table.status, "cancelled"))
      .orderBy(desc(table.cancelledAt));
    competitions.push(...rows.map((row) => ({ type: competitionType, ...row })));
  }
  return competitions;
}

export async function createGame(input: { name: string; logoUrl?: string | null }) {
  const [game] = await db.insert(gamesTable).values({ name: input.name.trim(), logoUrl: input.logoUrl ?? null }).returning();
  return game;
}

export async function updateGame(id: string, input: { name?: string; logoUrl?: string | null; isActive?: boolean }) {
  const [game] = await db.update(gamesTable).set({ name: input.name?.trim(), logoUrl: input.logoUrl, isActive: input.isActive }).where(eq(gamesTable.id, id)).returning();
  if (!game) throw new CompetitionError("GAME_NOT_FOUND", "Game was not found.", 404);
  return game;
}

export async function deleteGame(id: string) {
  return db.transaction(async (tx) => {
    const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, id)).for("update");
    if (!game) throw new CompetitionError("GAME_NOT_FOUND", "Game was not found.", 404);
    const [mode] = await tx.select({ id: modesTable.id }).from(modesTable).where(eq(modesTable.gameId, id)).limit(1);
    if (mode) throw new CompetitionError("GAME_HAS_MODES", "Delete all modes for this game before deleting it.", 409);
    const [deleted] = await tx.update(gamesTable).set({ isActive: false }).where(eq(gamesTable.id, id)).returning();
    return deleted;
  });
}

export async function createMode(input: {
  gameId: string;
  name: string;
  type: CompetitionType;
  entryFee: number;
  maxParticipants: number;
  teamSize?: number;
  prizes?: PrizeDefinition[];
  tournamentMetric?: string | null;
  logoUrl?: string | null;
}) {
  const [mode] = await db.insert(modesTable).values({
    gameId: input.gameId,
    name: input.name.trim(),
    type: input.type,
    entryFee: input.entryFee,
    maxParticipants: input.maxParticipants,
    teamSize: input.teamSize ?? 1,
    prizes: input.prizes ?? [],
    tournamentMetric: input.tournamentMetric ?? null,
    logoUrl: input.logoUrl ?? null,
  }).returning();
  return mode;
}

export async function updateMode(id: string, input: {
  name?: string;
  type?: CompetitionType;
  entryFee?: number;
  maxParticipants?: number;
  teamSize?: number;
  prizes?: PrizeDefinition[];
  tournamentMetric?: string | null;
  logoUrl?: string | null;
  isActive?: boolean;
}) {
  const [mode] = await db.update(modesTable).set({
    name: input.name?.trim(),
    type: input.type,
    entryFee: input.entryFee,
    maxParticipants: input.maxParticipants,
    teamSize: input.teamSize,
    prizes: input.prizes,
    tournamentMetric: input.tournamentMetric,
    logoUrl: input.logoUrl,
    isActive: input.isActive,
  }).where(eq(modesTable.id, id)).returning();
  if (!mode) throw new CompetitionError("MODE_NOT_FOUND", "Mode was not found.", 404);
  return mode;
}

export async function deleteMode(id: string) {
  return db.transaction(async (tx) => {
    const [mode] = await tx.select().from(modesTable).where(eq(modesTable.id, id)).for("update");
    if (!mode) throw new CompetitionError("MODE_NOT_FOUND", "Mode was not found.", 404);
    const [schedule] = await tx.select({ status: competitionSchedulesTable.status }).from(competitionSchedulesTable).where(eq(competitionSchedulesTable.modeId, id)).limit(1);
    if (schedule) {
      const reason = schedule.status === "published"
        ? "Delete active or upcoming schedules for this mode first."
        : "Delete existing schedules for this mode first.";
      throw new CompetitionError("MODE_HAS_SCHEDULES", reason, 409);
    }
    const [deleted] = await tx.delete(modesTable).where(eq(modesTable.id, id)).returning();
    return deleted;
  });
}

export async function createSchedule(input: Omit<CompetitionSchedule, "id" | "createdAt" | "updatedAt">) {
  const [schedule] = await db.insert(competitionSchedulesTable).values(input).returning();
  return schedule;
}

export async function updateSchedule(id: string, input: Partial<Omit<CompetitionSchedule, "id" | "createdAt" | "updatedAt" | "type">>) {
  const [schedule] = await db.update(competitionSchedulesTable).set(input).where(eq(competitionSchedulesTable.id, id)).returning();
  if (!schedule) throw new CompetitionError("SCHEDULE_NOT_FOUND", "Schedule was not found.", 404);
  return schedule;
}

export async function deleteSchedule(id: string, force = false) {
  const inspection = await db.transaction(async (tx) => {
    const [schedule] = await tx.select().from(competitionSchedulesTable).where(eq(competitionSchedulesTable.id, id)).for("update");
    if (!schedule) throw new CompetitionError("SCHEDULE_NOT_FOUND", "Schedule was not found.", 404);
    const [mode] = await tx.select({ type: modesTable.type }).from(modesTable).where(eq(modesTable.id, schedule.modeId)).limit(1);
    if (!mode) throw new CompetitionError("MODE_NOT_FOUND", "The schedule mode was not found.", 409);
    const table = mode.type === "omb" ? matchesTable : tournamentsTable;
    const events = await tx.select({ id: table.id }).from(table).where(eq(table.scheduleId, id));
    const eventIds = events.map((event) => event.id);
    const participantCount = mode.type === "omb"
      ? (eventIds.length ? (await tx.select({ id: matchParticipantsTable.id }).from(matchParticipantsTable).where(inArray(matchParticipantsTable.matchId, eventIds))).length : 0)
      : (eventIds.length ? (await tx.select({ id: tournamentParticipantsTable.id }).from(tournamentParticipantsTable).where(inArray(tournamentParticipantsTable.tournamentId, eventIds))).length : 0);
    return { type: mode.type, eventIds, participantCount };
  });

  if (inspection.participantCount > 0 && !force) {
    await db.update(competitionSchedulesTable).set({ status: "closed" }).where(eq(competitionSchedulesTable.id, id));
    throw new CompetitionError("SCHEDULE_HAS_PARTICIPANTS", "This schedule has participant entries or wallet holds and was closed instead. Use force=true to refund and cancel them.", 409);
  }
  if (inspection.participantCount > 0 && force) {
    for (const eventId of inspection.eventIds) await cancelCompetition(inspection.type, eventId, "Schedule deleted by an administrator.", true);
    await db.update(competitionSchedulesTable).set({ status: "closed" }).where(eq(competitionSchedulesTable.id, id));
    return;
  }
  return db.transaction(async (tx) => {
    const [schedule] = await tx.select().from(competitionSchedulesTable).where(eq(competitionSchedulesTable.id, id)).for("update");
    if (!schedule) throw new CompetitionError("SCHEDULE_NOT_FOUND", "Schedule was not found.", 404);
    const table = inspection.type === "omb" ? matchesTable : tournamentsTable;
    await tx.delete(table).where(eq(table.scheduleId, id));
    const [deleted] = await tx.delete(competitionSchedulesTable).where(eq(competitionSchedulesTable.id, id)).returning();
    return deleted;
  });
}

export async function deleteHost(id: string) {
  const [host] = await db.update(hostsTable).set({ status: "disabled", currentAssignmentId: null, currentAssignmentType: null }).where(eq(hostsTable.id, id)).returning();
  if (!host) throw new CompetitionError("HOST_NOT_FOUND", "Host was not found.", 404);
  return host;
}

export async function permanentlyDeleteHost(id: string) {
  return db.transaction(async (tx) => {
    const [host] = await tx.select().from(hostsTable).where(eq(hostsTable.id, id)).for("update");
    if (!host) throw new CompetitionError("HOST_NOT_FOUND", "Host was not found.", 404);
    if (host.currentAssignmentId) throw new CompetitionError("HOST_BUSY", "Unassign this host before permanently deleting it.", 409);
    const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, host.userId)).for("update");
    if (!user) throw new CompetitionError("HOST_NOT_FOUND", "Host user was not found.", 404);

    const [financialReference] = await tx.select({ id: walletTransactionsTable.id }).from(walletTransactionsTable).innerJoin(walletAccountsTable, eq(walletAccountsTable.id, walletTransactionsTable.walletAccountId)).where(eq(walletAccountsTable.userId, user.id)).limit(1);
    const [reservation] = await tx.select({ id: walletReservationsTable.id }).from(walletReservationsTable).innerJoin(walletAccountsTable, eq(walletAccountsTable.id, walletReservationsTable.walletAccountId)).where(eq(walletAccountsTable.userId, user.id)).limit(1);
    const [deposit] = await tx.select({ id: depositsTable.id }).from(depositsTable).where(eq(depositsTable.userId, user.id)).limit(1);
    const [withdrawal] = await tx.select({ id: withdrawalsTable.id }).from(withdrawalsTable).where(eq(withdrawalsTable.userId, user.id)).limit(1);
    const [bankAccount] = await tx.select({ id: userBankAccountsTable.id }).from(userBankAccountsTable).where(eq(userBankAccountsTable.userId, user.id)).limit(1);
    const [participant] = await tx.select({ id: matchParticipantsTable.id }).from(matchParticipantsTable).where(eq(matchParticipantsTable.userId, user.id)).limit(1);
    const [tournamentParticipant] = await tx.select({ id: tournamentParticipantsTable.id }).from(tournamentParticipantsTable).where(eq(tournamentParticipantsTable.userId, user.id)).limit(1);
    if (financialReference || reservation || deposit || withdrawal || bankAccount || participant || tournamentParticipant) {
      throw new CompetitionError("HOST_HAS_HISTORY", "This host has financial or competition history and can only be disabled, not permanently deleted.", 409);
    }

    await tx.delete(hostsTable).where(eq(hostsTable.id, id));
    await tx.delete(walletAccountsTable).where(eq(walletAccountsTable.userId, user.id));
    await tx.delete(usersTable).where(eq(usersTable.id, user.id));
    return { id };
  });
}

export async function getAvailableCompetitions(type: CompetitionType) {
  const table = type === "omb" ? matchesTable : tournamentsTable;
  return db
    .select({ event: table, schedule: competitionSchedulesTable, mode: modesTable, game: gamesTable, participantCount: count(type === "omb" ? matchParticipantsTable.id : tournamentParticipantsTable.id) })
    .from(table)
    .innerJoin(competitionSchedulesTable, eq(competitionSchedulesTable.id, table.scheduleId))
    .innerJoin(modesTable, eq(modesTable.id, competitionSchedulesTable.modeId))
    .innerJoin(gamesTable, eq(gamesTable.id, modesTable.gameId))
    .leftJoin(
      type === "omb" ? matchParticipantsTable : tournamentParticipantsTable,
      type === "omb" ? eq(matchParticipantsTable.matchId, table.id) : eq(tournamentParticipantsTable.tournamentId, table.id),
    )
    .where(eq(table.status, "waiting"))
    .groupBy(table.id, competitionSchedulesTable.id, modesTable.id, gamesTable.id)
    .orderBy(asc(table.createdAt));
}

export async function runCompetitionScheduler(now = new Date()) {
  const schedules = await db.select().from(competitionSchedulesTable);
  for (const schedule of schedules) {
    const mode = await getModeForSchedule(db, schedule.id);
    const type = mode.type;
    const table = type === "omb" ? matchesTable : tournamentsTable;
    const events = await db.select().from(table).where(inArray(table.status, ["waiting", "room_available", "ongoing", "result_pending"]));
    for (const event of events.filter((candidate) => candidate.scheduleId === schedule.id)) {
      const eventRecord = type === "omb" ? (event as Match) : (event as Tournament);
      const countResult =
        type === "omb"
          ? await db.select({ count: count(matchParticipantsTable.id) }).from(matchParticipantsTable).where(eq(matchParticipantsTable.matchId, event.id))
          : await db.select({ count: count(tournamentParticipantsTable.id) }).from(tournamentParticipantsTable).where(eq(tournamentParticipantsTable.tournamentId, event.id));
      const participantCount = Number(countResult[0]?.count ?? 0);
      if (eventRecord.status === "waiting" && !eventRecord.hostId && now.getTime() >= eventRecord.createdAt.getTime() + schedule.managerAlertAfterMinutes * 60_000) {
        const shouldAlert =
          eventRecord.managerUnclaimedSnoozedUntil == null ||
          now >= eventRecord.managerUnclaimedSnoozedUntil;
        if (shouldAlert) {
          const alertAt = new Date(now);
          if (type === "omb") {
            await db
              .update(matchesTable)
              .set({ managerUnclaimedAlertedAt: alertAt })
              .where(and(eq(matchesTable.id, eventRecord.id), isNull(matchesTable.managerUnclaimedAlertedAt)));
          } else {
            await db
              .update(tournamentsTable)
              .set({ managerUnclaimedAlertedAt: alertAt })
              .where(and(eq(tournamentsTable.id, eventRecord.id), isNull(tournamentsTable.managerUnclaimedAlertedAt)));
          }
          logger.warn({ event: "competition.unclaimed", competitionId: eventRecord.id, type }, "Competition has no host.");
          void notifyRolePush("manager", "Competition unclaimed", `No host has claimed this ${type === "omb" ? "match" : "tournament"}.`, { type, competitionId: eventRecord.id });
        }
      }
      const lowParticipationAt = type === "omb" ? revealAt(schedule) : schedule.entryClosesAt;
      const [latestEvent] = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.scheduleId, schedule.id))
        .orderBy(desc(table.createdAt))
        .limit(1);
      if (eventRecord.status === "waiting" && latestEvent?.id === eventRecord.id && lowParticipationAt && now >= lowParticipationAt && participantCount <= winnerCount(mode)) {
        await cancelCompetition(type, eventRecord.id, LOW_PARTICIPATION_REASON, false, true);
        continue;
      }
      const tournamentRecord = type === "tournament" ? eventRecord as Tournament : null;
      if (tournamentRecord?.entryClosesAt && now >= new Date(tournamentRecord.entryClosesAt.getTime() + 60 * 60_000) && !tournamentRecord.participantListNotifiedAt) {
        const [marked] = await db
          .update(tournamentsTable)
          .set({ participantListNotifiedAt: new Date(now) })
          .where(and(eq(tournamentsTable.id, eventRecord.id), isNull(tournamentsTable.participantListNotifiedAt)))
          .returning({ id: tournamentsTable.id });
        if (marked) {
          void notifyCompetitionParticipants("tournament", eventRecord.id, "Participant list available", "The participant list for your tournament is now available.");
        }
      }
      if (type === "omb" && eventRecord.status === "waiting" && schedule.startsAt && now >= new Date(schedule.startsAt.getTime() + 5 * 60_000) && !(eventRecord as Match).roomId) {
        await cancelCompetition(type, eventRecord.id, "Room details were not submitted in time.", true);
        continue;
      }
      if (type === "omb" && eventRecord.status === "room_available" && schedule.startsAt && now >= schedule.startsAt) {
        await db.update(matchesTable).set({ status: "result_pending" }).where(and(eq(matchesTable.id, eventRecord.id), eq(matchesTable.status, "room_available")));
        void notifyCompetitionParticipants("omb", eventRecord.id, "Match ended", "Your match has ended. Results are being processed.");
      }
      if (type === "tournament" && eventRecord.status === "ongoing" && (eventRecord as Tournament).endsAt && now >= (eventRecord as Tournament).endsAt!) {
        await db.update(tournamentsTable).set({ status: "result_pending" }).where(and(eq(tournamentsTable.id, eventRecord.id), eq(tournamentsTable.status, "ongoing")));
        void notifyCompetitionParticipants("tournament", eventRecord.id, "Tournament duration complete", "Your tournament duration is complete. Results are being processed.");
      }
      if (
        type === "omb" &&
        eventRecord.status === "waiting" &&
        schedule.startsAt &&
        now >= new Date(schedule.startsAt.getTime() - (schedule.roomRevealMinutesBeforeStart ?? 0) * 60_000 + 3 * 60_000) &&
        !(eventRecord as Match).roomId &&
        (eventRecord as Match).managerRoomTimeoutAlertedAt == null
      ) {
        await db
          .update(matchesTable)
          .set({ managerRoomTimeoutAlertedAt: new Date(now) })
          .where(and(eq(matchesTable.id, eventRecord.id), isNull(matchesTable.managerRoomTimeoutAlertedAt)));
        logger.warn({ event: "competition.room_timeout", competitionId: eventRecord.id, type }, "Host has not uploaded room details.");
        void notifyRolePush("manager", "Room details timeout", "Host has not uploaded room details on time.", { type, competitionId: eventRecord.id });
      }
      const deadline =
        type === "tournament" && (eventRecord as Tournament).endsAt
          ? new Date((eventRecord as Tournament).endsAt!.getTime() + schedule.resultDeadlineMinutes * 60_000)
          : resultDeadline(mode, schedule);
      if (
        deadline &&
        now >= new Date(deadline.getTime() + 3 * 60_000) &&
        now < new Date(deadline.getTime() + 5 * 60_000) &&
        eventRecord.managerResultTimeoutAlertedAt == null &&
        ["waiting", "room_available", "ongoing", "result_pending"].includes(eventRecord.status)
      ) {
        if (type === "omb") {
          await db
            .update(matchesTable)
            .set({ managerResultTimeoutAlertedAt: new Date(now) })
            .where(and(eq(matchesTable.id, eventRecord.id), isNull(matchesTable.managerResultTimeoutAlertedAt)));
        } else {
          await db
            .update(tournamentsTable)
            .set({ managerResultTimeoutAlertedAt: new Date(now) })
            .where(and(eq(tournamentsTable.id, eventRecord.id), isNull(tournamentsTable.managerResultTimeoutAlertedAt)));
        }
        logger.warn({ event: "competition.result_timeout", competitionId: eventRecord.id, type }, "Host has not submitted results.");
        void notifyRolePush("manager", "Result submission timeout", "Host has not submitted competition results on time.", { type, competitionId: eventRecord.id });
      }
      if (deadline && ["waiting", "room_available", "ongoing", "result_pending"].includes(eventRecord.status) && now >= new Date(deadline.getTime() + 5 * 60_000)) {
        await cancelCompetition(type, eventRecord.id, "Results were not submitted in time.", true);
      }
    }
  }
}