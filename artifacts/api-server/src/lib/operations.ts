import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import {
  competitionSchedulesTable,
  db,
  depositsTable,
  gamesTable,
  matchParticipantsTable,
  matchesTable,
  modesTable,
  tournamentParticipantsTable,
  tournamentsTable,
  userBankAccountsTable,
  usersTable,
  walletAccountsTable,
  withdrawalsTable,
  type User,
} from "@workspace/db";
import { hashPassword, PASSWORD_ALGO } from "./password";

export class OperationsError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "OperationsError";
  }
}

function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    age: user.age,
    email: user.email,
    mobileNumber: user.mobileNumber,
    accountStatus: user.accountStatus,
    role: user.role,
    mobileVerificationStatus: user.mobileVerificationStatus,
    termsAcceptedAt: user.termsAcceptedAt,
    createdAt: user.createdAt,
  };
}

export async function searchUserByMobile(mobileNumber: string) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.mobileNumber, mobileNumber)).limit(1);
  if (!user) return null;

  const wallets = await db.select().from(walletAccountsTable).where(eq(walletAccountsTable.userId, user.id));
  const [depositTotals] = await db
    .select({ total: sql<string>`coalesce(sum(${depositsTable.amount}), 0)` })
    .from(depositsTable)
    .where(and(eq(depositsTable.userId, user.id), eq(depositsTable.status, "success")));
  const [withdrawalTotals] = await db
    .select({ total: sql<string>`coalesce(sum(${withdrawalsTable.amount}), 0)` })
    .from(withdrawalsTable)
    .where(and(eq(withdrawalsTable.userId, user.id), eq(withdrawalsTable.status, "completed")));
  const [ombActivity] = await db
    .select({ joined: sql<string>`count(*)`, won: sql<string>`count(*) filter (where ${matchParticipantsTable.prizeAmount} > 0)` })
    .from(matchParticipantsTable)
    .where(eq(matchParticipantsTable.userId, user.id));
  const [tournamentActivity] = await db
    .select({ joined: sql<string>`count(*)`, won: sql<string>`count(*) filter (where ${tournamentParticipantsTable.prizeAmount} > 0)` })
    .from(tournamentParticipantsTable)
    .where(eq(tournamentParticipantsTable.userId, user.id));
  const [runningOmb] = await db
    .select({ code: matchesTable.code, id: matchesTable.id })
    .from(matchParticipantsTable)
    .innerJoin(matchesTable, eq(matchesTable.id, matchParticipantsTable.matchId))
    .where(and(eq(matchParticipantsTable.userId, user.id), sql`${matchesTable.status} in ('waiting', 'room_available', 'ongoing', 'result_pending')`))
    .orderBy(desc(matchesTable.createdAt))
    .limit(1);
  const [runningTournament] = await db
    .select({ code: tournamentsTable.code, id: tournamentsTable.id })
    .from(tournamentParticipantsTable)
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, tournamentParticipantsTable.tournamentId))
    .where(and(eq(tournamentParticipantsTable.userId, user.id), sql`${tournamentsTable.status} in ('waiting', 'ongoing', 'result_pending')`))
    .orderBy(desc(tournamentsTable.createdAt))
    .limit(1);
  const recentOmbs = await db
    .select({ id: matchesTable.id, code: matchesTable.code, status: matchesTable.status, prizeAmount: matchParticipantsTable.prizeAmount, joinedAt: matchParticipantsTable.joinedAt })
    .from(matchParticipantsTable)
    .innerJoin(matchesTable, eq(matchesTable.id, matchParticipantsTable.matchId))
    .where(eq(matchParticipantsTable.userId, user.id))
    .orderBy(desc(matchParticipantsTable.joinedAt))
    .limit(10);
  const recentTournaments = await db
    .select({ id: tournamentsTable.id, code: tournamentsTable.code, status: tournamentsTable.status, prizeAmount: tournamentParticipantsTable.prizeAmount, joinedAt: tournamentParticipantsTable.joinedAt })
    .from(tournamentParticipantsTable)
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, tournamentParticipantsTable.tournamentId))
    .where(eq(tournamentParticipantsTable.userId, user.id))
    .orderBy(desc(tournamentParticipantsTable.joinedAt))
    .limit(10);

  return {
    user: publicUser(user),
    wallets: wallets.map((wallet) => ({ walletType: wallet.walletType, balance: wallet.balance, reserved: wallet.reservedBalance, available: wallet.balance - wallet.reservedBalance })),
    totals: { deposited: Number(depositTotals?.total ?? 0), withdrawn: Number(withdrawalTotals?.total ?? 0) },
    activity: {
      ombsJoined: Number(ombActivity?.joined ?? 0), ombsWon: Number(ombActivity?.won ?? 0),
      tournamentsJoined: Number(tournamentActivity?.joined ?? 0), tournamentsWon: Number(tournamentActivity?.won ?? 0),
    },
    current: { omb: runningOmb ?? null, tournament: runningTournament ?? null },
    history: { ombs: recentOmbs, tournaments: recentTournaments },
  };
}

export async function updateUserAccountStatus(userId: string, accountStatus: "active" | "suspended" | "deactivated") {
  const [updated] = await db.update(usersTable).set({ accountStatus }).where(eq(usersTable.id, userId)).returning();
  if (!updated) throw new OperationsError("USER_NOT_FOUND", "User was not found.", 404);
  return publicUser(updated);
}

export async function resetUserPassword(userId: string, password: string) {
  const passwordHash = await hashPassword(password);
  const [updated] = await db.update(usersTable).set({ passwordHash, passwordAlgo: PASSWORD_ALGO }).where(eq(usersTable.id, userId)).returning({ id: usersTable.id });
  if (!updated) throw new OperationsError("USER_NOT_FOUND", "User was not found.", 404);
  return updated;
}

export async function searchCompetition(identifier: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier);
  const [match] = await db
    .select({ event: matchesTable, schedule: competitionSchedulesTable, mode: modesTable, game: gamesTable })
    .from(matchesTable)
    .innerJoin(competitionSchedulesTable, eq(competitionSchedulesTable.id, matchesTable.scheduleId))
    .innerJoin(modesTable, eq(modesTable.id, competitionSchedulesTable.modeId))
    .innerJoin(gamesTable, eq(gamesTable.id, modesTable.gameId))
    .where(isUuid ? or(eq(matchesTable.id, identifier), eq(matchesTable.code, identifier)) : eq(matchesTable.code, identifier))
    .limit(1);
  if (match) {
    const participants = await db.select().from(matchParticipantsTable).where(eq(matchParticipantsTable.matchId, match.event.id)).orderBy(asc(matchParticipantsTable.position), asc(matchParticipantsTable.joinedAt));
    return { type: "omb" as const, ...match, participants };
  }
  const [tournament] = await db
    .select({ event: tournamentsTable, schedule: competitionSchedulesTable, mode: modesTable, game: gamesTable })
    .from(tournamentsTable)
    .innerJoin(competitionSchedulesTable, eq(competitionSchedulesTable.id, tournamentsTable.scheduleId))
    .innerJoin(modesTable, eq(modesTable.id, competitionSchedulesTable.modeId))
    .innerJoin(gamesTable, eq(gamesTable.id, modesTable.gameId))
    .where(isUuid ? or(eq(tournamentsTable.id, identifier), eq(tournamentsTable.code, identifier)) : eq(tournamentsTable.code, identifier))
    .limit(1);
  if (!tournament) return null;
  const participants = await db.select().from(tournamentParticipantsTable).where(eq(tournamentParticipantsTable.tournamentId, tournament.event.id)).orderBy(asc(tournamentParticipantsTable.rank), asc(tournamentParticipantsTable.joinedAt));
  return { type: "tournament" as const, ...tournament, participants };
}

export async function listUserPayoutAccounts(userId: string) {
  return db.select({ id: userBankAccountsTable.id, method: userBankAccountsTable.method, accountHolderName: userBankAccountsTable.accountHolderName, bankIfscCode: userBankAccountsTable.bankIfscCode, bankName: userBankAccountsTable.bankName, upiId: userBankAccountsTable.upiId, isVerified: userBankAccountsTable.isVerified, isDeleted: userBankAccountsTable.isDeleted, createdAt: userBankAccountsTable.createdAt }).from(userBankAccountsTable).where(eq(userBankAccountsTable.userId, userId)).orderBy(desc(userBankAccountsTable.createdAt));
}
