import { randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  db,
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
  walletAccountsTable,
  walletReservationsTable,
  walletTransactionsTable,
  type CompetitionSchedule,
  type Match,
  type PrizeDefinition,
  type Tournament,
} from "@workspace/db";
import { createReservation, confirmReservation, releaseReservation } from "./reservation";
import { recordCompletedTransaction } from "./wallet";
import { logger } from "./logger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CompetitionType = "omb" | "tournament";
type Event = Match | Tournament;

export const LOW_PARTICIPATION_REASON =
  "This competition was canceled due to low participation. To ensure fairness, awards were distributed randomly according to the awards chart.";

function eventCode(type: CompetitionType): string {
  return `${type === "omb" ? "OMB" : "T"}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function winnerCount(schedule: CompetitionSchedule): number {
  return schedule.prizes.length;
}

function revealAt(schedule: CompetitionSchedule): Date | null {
  if (!schedule.startsAt || schedule.roomRevealMinutesBeforeStart == null) return null;
  return new Date(schedule.startsAt.getTime() - schedule.roomRevealMinutesBeforeStart * 60_000);
}

function resultDeadline(schedule: CompetitionSchedule): Date | null {
  const end = schedule.type === "omb"
    ? schedule.startsAt
    : schedule.entryClosesAt;
  if (!end) return null;
  return new Date(end.getTime() + schedule.resultDeadlineMinutes * 60_000);
}

async function getSchedule(tx: Tx, scheduleId: string, type?: CompetitionType): Promise<CompetitionSchedule> {
  const [schedule] = await tx
    .select()
    .from(competitionSchedulesTable)
    .where(and(eq(competitionSchedulesTable.id, scheduleId), type ? eq(competitionSchedulesTable.type, type) : undefined))
    .limit(1);
  if (!schedule) throw new CompetitionError("SCHEDULE_NOT_FOUND", "Competition schedule was not found.");
  return schedule;
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
  return db
    .select()
    .from(competitionSchedulesTable)
    .where(
      and(
        eq(competitionSchedulesTable.type, type),
        eq(competitionSchedulesTable.status, "published"),
        modeId ? eq(competitionSchedulesTable.modeId, modeId) : undefined,
      ),
    )
    .orderBy(asc(competitionSchedulesTable.startsAt), asc(competitionSchedulesTable.entryClosesAt));
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
    const now = new Date();
    const closingTime = schedule.type === "omb" ? schedule.startsAt : schedule.entryClosesAt;
    if (closingTime && now >= closingTime) {
      throw new CompetitionError("ENTRY_CLOSED", "Entry for this competition has closed.");
    }
    await assertNotAlreadyJoined(tx, input.userId, input.scheduleId, schedule.type);
    const wallet = await getWallet(tx, input.userId);

    const existing =
      schedule.type === "omb"
        ? await findOpenMatch(tx, schedule.id, schedule.maxParticipants)
        : await findOpenTournament(tx, schedule.id, schedule.maxParticipants);
    const event =
      existing ??
      (schedule.type === "omb"
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
      amount: schedule.entryFee,
      reasonType: "competition_entry",
      reasonId: event.id,
      idempotencyKey: `competition-entry:${event.id}:${input.userId}`,
    });
    const settled = await confirmReservation(tx, {
      reservationId: reservation.id,
      transactionIdempotencyKey: `competition-entry-debit:${event.id}:${input.userId}`,
      referenceType: schedule.type === "omb" ? "omb_entry" : "tournament_entry",
      referenceId: event.id,
      description: `${schedule.type === "omb" ? "OMB" : "Tournament"} entry ${event.code}`,
    });

    const participant =
      schedule.type === "omb"
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
    return { type: schedule.type, event, participant };
  });
  logger.info({ event: "competition.joined", type: result.type, competitionId: result.event.id }, "Competition joined.");
  return result;
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

export async function getCompetition(type: CompetitionType, id: string) {
  if (type === "omb") {
    const [match] = await db.select().from(matchesTable).where(eq(matchesTable.id, id)).limit(1);
    if (!match) return null;
    const participants = await db
      .select()
      .from(matchParticipantsTable)
      .where(eq(matchParticipantsTable.matchId, id))
      .orderBy(asc(matchParticipantsTable.position), asc(matchParticipantsTable.joinedAt));
    return { type, event: match, participants };
  }
  const [tournament] = await db.select().from(tournamentsTable).where(eq(tournamentsTable.id, id)).limit(1);
  if (!tournament) return null;
  const participants = await db
    .select()
    .from(tournamentParticipantsTable)
    .where(eq(tournamentParticipantsTable.tournamentId, id))
    .orderBy(asc(tournamentParticipantsTable.rank), asc(tournamentParticipantsTable.joinedAt));
  return { type, event: tournament, participants };
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

export async function addRoomDetails(id: string, userId: string, roomId: string, roomPassword: string) {
  return db.transaction(async (tx) => {
    await getHostForEvent(tx, "omb", id, userId);
    const [updated] = await tx
      .update(matchesTable)
      .set({ roomId: roomId.trim(), roomPassword: roomPassword.trim(), roomDetailsAddedAt: new Date(), status: "room_available" })
      .where(and(eq(matchesTable.id, id), inArray(matchesTable.status, ["waiting", "room_available"])))
      .returning();
    if (!updated) throw new CompetitionError("INVALID_STATUS", "Room details cannot be changed now.");
    return updated;
  });
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
  positions: Array<{ participantId: string; position: number; isCheater?: boolean }>,
) {
  return db.transaction(async (tx) => {
    const host = await getHostForEvent(tx, "omb", id, userId);
    const [match] = await tx.select().from(matchesTable).where(eq(matchesTable.id, id)).for("update");
    if (!match || !["room_available", "ongoing", "result_pending"].includes(match.status)) {
      throw new CompetitionError("INVALID_STATUS", "Results cannot be submitted for this match.");
    }
    const [schedule] = await tx.select().from(competitionSchedulesTable).where(eq(competitionSchedulesTable.id, match.scheduleId)).limit(1);
    if (!schedule) throw new CompetitionError("SCHEDULE_NOT_FOUND", "Schedule was not found.", 500);
    const participants = await tx.select().from(matchParticipantsTable).where(eq(matchParticipantsTable.matchId, id)).for("update");
    if (!participants.length || positions.length !== participants.length) {
      throw new CompetitionError("POSITIONS_REQUIRED", "Submit exactly one position for every participant.");
    }
    const positionSet = new Set(positions.map((item) => item.position));
    if (positionSet.size !== positions.length || Math.min(...positions.map((item) => item.position)) < 1) {
      throw new CompetitionError("INVALID_POSITIONS", "Positions must be unique positive numbers.");
    }
    const prizeByPosition = new Map(schedule.prizes.map((prize) => [prize.position, prize.amount]));
    for (const item of positions) {
      const participant = participants.find((candidate) => candidate.id === item.participantId);
      if (!participant) throw new CompetitionError("PARTICIPANT_NOT_FOUND", "A submitted participant was not found.");
      const isCheater = item.isCheater === true;
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
}

export interface TournamentInitialValue {
  participantId: string;
  initialValue: number;
}

export interface TournamentFinalValue {
  participantId: string;
  finalValue: number;
  isCheater?: boolean;
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
  return db.transaction(async (tx) => {
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
      return {
        participant,
        finalValue: submitted.finalValue,
        isCheater: submitted.isCheater === true,
        performance: submitted.finalValue - participant.initialValue,
      };
    });
    scored.sort((a, b) => b.performance - a.performance || a.participant.joinedAt.getTime() - b.participant.joinedAt.getTime());
    const schedule = await getSchedule(tx, tournament.scheduleId, "tournament");
    const prizeByPosition = new Map(schedule.prizes.map((prize) => [prize.position, prize.amount]));
    for (const [index, item] of scored.entries()) {
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
}

export async function createTournamentPositionReveal(input: {
  scheduleId: string;
  revealAt: Date;
}) {
  const schedule = await db
    .select({ id: competitionSchedulesTable.id, type: competitionSchedulesTable.type })
    .from(competitionSchedulesTable)
    .where(eq(competitionSchedulesTable.id, input.scheduleId))
    .limit(1);
  if (!schedule[0] || schedule[0].type !== "tournament") {
    throw new CompetitionError("SCHEDULE_NOT_FOUND", "Tournament schedule was not found.", 404);
  }
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
  return db.transaction(async (tx) => {
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
    const winnerCount = (await getSchedule(tx, tournament.scheduleId, "tournament")).prizes.length;
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
}

export async function getTournamentParticipantList(
  tournamentId: string,
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

async function distributeLowParticipationPrizes(
  tx: Tx,
  type: CompetitionType,
  competitionId: string,
  participants: Array<{ id: string; userId: string; reservationId: string }>,
  schedule: CompetitionSchedule,
) {
  const shuffled = [...schedule.prizes].sort(() => randomInt(-1_000_000, 1_000_001));
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
  return db.transaction(async (tx) => {
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
      const schedule = await getSchedule(tx, event.scheduleId, type);
      await distributeLowParticipationPrizes(tx, type, id, participants, schedule);
    }
    const [updated] = await tx.update(table).set({ status: "cancelled", cancellationReason: reason, cancelledAt: new Date() }).where(eq(table.id, id)).returning();
    if (event.hostId) {
      await tx.update(hostsTable).set({ currentAssignmentId: null, currentAssignmentType: null }).where(eq(hostsTable.id, event.hostId));
    }
    return updated;
  });
}

export async function listHosts(role?: "omb" | "tournament", onlyFree = false) {
  return db
    .select()
    .from(hostsTable)
    .where(
      and(
        role ? eq(hostsTable.role, role) : undefined,
        eq(hostsTable.status, "active"),
        onlyFree ? isNull(hostsTable.currentAssignmentId) : undefined,
      ),
    )
    .orderBy(asc(hostsTable.createdAt));
}

export async function createGame(input: { name: string; logoUrl?: string | null }) {
  const [game] = await db.insert(gamesTable).values({ name: input.name.trim(), logoUrl: input.logoUrl ?? null }).returning();
  return game;
}

export async function createMode(input: { gameId: string; name: string; logoUrl?: string | null }) {
  const [mode] = await db.insert(modesTable).values({ gameId: input.gameId, name: input.name.trim(), logoUrl: input.logoUrl ?? null }).returning();
  return mode;
}

export async function createSchedule(input: Omit<CompetitionSchedule, "id" | "createdAt" | "updatedAt">) {
  const [schedule] = await db.insert(competitionSchedulesTable).values(input).returning();
  return schedule;
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
    const type = schedule.type;
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
        }
      }
      const lowParticipationAt = type === "omb" ? revealAt(schedule) : schedule.entryClosesAt;
      if (eventRecord.status === "waiting" && lowParticipationAt && now >= lowParticipationAt && participantCount <= winnerCount(schedule)) {
        await cancelCompetition(type, eventRecord.id, LOW_PARTICIPATION_REASON, false, true);
        continue;
      }
      if (type === "omb" && eventRecord.status === "waiting" && schedule.startsAt && now >= new Date(schedule.startsAt.getTime() + 5 * 60_000) && !(eventRecord as Match).roomId) {
        await cancelCompetition(type, eventRecord.id, "Room details were not submitted in time.", true);
        continue;
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
      }
      const deadline =
        type === "tournament" && (eventRecord as Tournament).endsAt
          ? new Date((eventRecord as Tournament).endsAt!.getTime() + schedule.resultDeadlineMinutes * 60_000)
          : resultDeadline(schedule);
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
      }
      if (deadline && ["waiting", "room_available", "ongoing", "result_pending"].includes(eventRecord.status) && now >= new Date(deadline.getTime() + 5 * 60_000)) {
        await cancelCompetition(type, eventRecord.id, "Results were not submitted in time.", true);
      }
    }
  }
}