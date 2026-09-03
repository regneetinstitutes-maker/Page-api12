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
import { recordCompletedTransaction } from "./wallet";
import { notifyPush } from "./notifications";

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

export async function searchUsers(query: string) {
  const normalized = query.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);
  const users = await db.select().from(usersTable).where(
    isUuid
      ? eq(usersTable.id, normalized)
      : or(
          sql`${usersTable.username} ILIKE ${`%${normalized}%`}`,
          sql`${usersTable.name} ILIKE ${`%${normalized}%`}`,
          sql`${usersTable.email} ILIKE ${`%${normalized}%`}`,
          sql`${usersTable.mobileNumber} ILIKE ${`%${normalized}%`}`,
        ),
  ).limit(25);
  return Promise.all(users.map(async (user) => {
    const wallets = await db.select().from(walletAccountsTable).where(eq(walletAccountsTable.userId, user.id));
    const [activity] = await db.select({ played: sql<string>`count(*)`, won: sql<string>`count(*) filter (where ${matchParticipantsTable.prizeAmount} > 0)` }).from(matchParticipantsTable).where(eq(matchParticipantsTable.userId, user.id));
    return { user: publicUser(user), wallets, totalMatchesPlayed: Number(activity?.played ?? 0), totalWon: Number(activity?.won ?? 0), status: user.accountStatus === "active" ? "active" as const : "suspended" as const };
  }));
}

export async function adjustUserWallet(userId: string, walletType: "play_coins" | "winning_coins", amount: number, reason: string) {
  return db.transaction(async (tx) => {
    const [wallet] = await tx.select().from(walletAccountsTable).where(and(eq(walletAccountsTable.userId, userId), eq(walletAccountsTable.walletType, walletType))).limit(1);
    if (!wallet) throw new OperationsError("WALLET_NOT_FOUND", "Wallet was not found.", 404);
    try {
      return await recordCompletedTransaction(tx, { walletAccountId: wallet.id, amount, referenceType: "admin_adjustment", idempotencyKey: `admin-adjustment:${userId}:${walletType}:${crypto.randomUUID()}`, description: reason });
    } catch (error) {
      if (error instanceof Error && error.name === "InsufficientBalanceError") throw new OperationsError("INSUFFICIENT_BALANCE", "The adjustment would make the balance negative.");
      throw error;
    }
  });
}

export async function broadcastAdminNotification(input: { title: string; message: string; targetAudience: "all" | "active_players" | "hosts" | "specific_user"; type: string; priority: string; deepLink: string; userId?: string }) {
  const audience = input.targetAudience === "specific_user"
    ? (input.userId ? [{ id: input.userId }] : [])
    : await db.select({ id: usersTable.id }).from(usersTable).where(
        input.targetAudience === "hosts"
          ? or(eq(usersTable.role, "omb_host"), eq(usersTable.role, "tournament_host"))
          : input.targetAudience === "active_players"
            ? and(eq(usersTable.role, "user"), eq(usersTable.accountStatus, "active"))
            : eq(usersTable.accountStatus, "active"),
      );
  for (const user of audience) notifyPush({ userId: user.id, title: input.title, body: input.message, data: { type: input.type, priority: input.priority, deepLink: input.deepLink } });
  return { recipients: audience.length };
}

export async function updateUserAccountStatus(userId: string, accountStatus: "active" | "suspended" | "deactivated") {
  const [updated] = await db.update(usersTable).set({ accountStatus }).where(eq(usersTable.id, userId)).returning();
  if (!updated) throw new OperationsError("USER_NOT_FOUND", "User was not found.", 404);
  return publicUser(updated);
}

export async function listManagers() {
  const managers = await db.select().from(usersTable).where(eq(usersTable.role, "manager")).orderBy(asc(usersTable.createdAt));
  return managers.map(publicUser);
}

export async function createManager(input: { username: string; name: string; mobileNumber?: string; password: string }) {
  return db.transaction(async (tx) => {
    const username = input.username.trim().toLowerCase();
    const mobileNumber = input.mobileNumber?.trim() || null;
    const [usernameConflict] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username)).limit(1);
    if (usernameConflict) throw new OperationsError("USERNAME_EXISTS", "This username is already in use.", 409);
    if (mobileNumber) {
      const [mobileConflict] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.mobileNumber, mobileNumber)).limit(1);
      if (mobileConflict) throw new OperationsError("MOBILE_EXISTS", "This mobile number is already in use.", 409);
    }
    const [manager] = await tx.insert(usersTable).values({
      username,
      name: input.name.trim(),
      age: 18,
      passwordHash: await hashPassword(input.password),
      passwordAlgo: PASSWORD_ALGO,
      mobileNumber,
      role: "manager",
      mobileVerificationStatus: mobileNumber ? "verified" : "not_started",
      mobileVerifiedAt: mobileNumber ? new Date() : null,
    }).returning();
    if (!manager) throw new OperationsError("MANAGER_CREATE_FAILED", "Unable to create manager.", 500);
    return publicUser(manager);
  });
}

export async function updateManager(id: string, input: { username?: string; name?: string; mobileNumber?: string | null }) {
  return db.transaction(async (tx) => {
    const [manager] = await tx.select().from(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.role, "manager"))).for("update");
    if (!manager) throw new OperationsError("MANAGER_NOT_FOUND", "Manager was not found.", 404);
    const username = input.username?.trim().toLowerCase();
    const mobileNumber = input.mobileNumber === undefined ? manager.mobileNumber : input.mobileNumber?.trim() || null;
    if (username && username !== manager.username) {
      const [conflict] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username)).limit(1);
      if (conflict) throw new OperationsError("USERNAME_EXISTS", "This username is already in use.", 409);
    }
    if (mobileNumber && mobileNumber !== manager.mobileNumber) {
      const [conflict] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.mobileNumber, mobileNumber)).limit(1);
      if (conflict) throw new OperationsError("MOBILE_EXISTS", "This mobile number is already in use.", 409);
    }
    const [updated] = await tx.update(usersTable).set({
      username: username ?? manager.username,
      name: input.name?.trim() ?? manager.name,
      mobileNumber,
    }).where(eq(usersTable.id, id)).returning();
    return publicUser(updated);
  });
}

export async function deleteManager(id: string, permanent = false) {
  if (!permanent) return updateUserAccountStatus(id, "deactivated");
  return db.transaction(async (tx) => {
    const [manager] = await tx.select().from(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.role, "manager"))).for("update");
    if (!manager) throw new OperationsError("MANAGER_NOT_FOUND", "Manager was not found.", 404);
    const [wallet] = await tx.select({ id: walletAccountsTable.id }).from(walletAccountsTable).where(eq(walletAccountsTable.userId, id)).limit(1);
    const [deposit] = await tx.select({ id: depositsTable.id }).from(depositsTable).where(eq(depositsTable.userId, id)).limit(1);
    const [withdrawal] = await tx.select({ id: withdrawalsTable.id }).from(withdrawalsTable).where(eq(withdrawalsTable.userId, id)).limit(1);
    if (wallet || deposit || withdrawal) throw new OperationsError("MANAGER_HAS_HISTORY", "This manager has account or financial records and can only be deactivated.", 409);
    await tx.delete(usersTable).where(eq(usersTable.id, id));
    return { id };
  });
}

export async function resetUserPassword(userId: string, password: string) {
  const passwordHash = await hashPassword(password);
  const [updated] = await db.update(usersTable).set({ passwordHash, passwordAlgo: PASSWORD_ALGO }).where(eq(usersTable.id, userId)).returning({ id: usersTable.id });
  if (!updated) throw new OperationsError("USER_NOT_FOUND", "User was not found.", 404);
  return updated;
}

export async function resetManagerPassword(userId: string, password: string) {
  const [manager] = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.role, "manager"))).limit(1);
  if (!manager) throw new OperationsError("MANAGER_NOT_FOUND", "Manager was not found.", 404);
  return resetUserPassword(userId, password);
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

export async function getAdminDashboard() {
  const [[users], [hosts], [play], [winning], [cancelledOmbs], [cancelledTournaments]] = await Promise.all([
    db.select({ total: sql<string>`count(*)` }).from(usersTable),
    db.select({ total: sql<string>`count(*)` }).from(usersTable).where(or(eq(usersTable.role, "omb_host"), eq(usersTable.role, "tournament_host"))),
    db.select({ total: sql<string>`coalesce(sum(${walletAccountsTable.balance}), 0)` }).from(walletAccountsTable).where(eq(walletAccountsTable.walletType, "play_coins")),
    db.select({ total: sql<string>`coalesce(sum(${walletAccountsTable.balance}), 0)` }).from(walletAccountsTable).where(eq(walletAccountsTable.walletType, "winning_coins")),
    db.select({ total: sql<string>`count(*)` }).from(matchesTable).where(eq(matchesTable.status, "cancelled")),
    db.select({ total: sql<string>`count(*)` }).from(tournamentsTable).where(eq(tournamentsTable.status, "cancelled")),
  ]);
  const topDeposits = await db.select({ userId: depositsTable.userId, total: sql<string>`sum(${depositsTable.amount})` }).from(depositsTable).where(eq(depositsTable.status, "success")).groupBy(depositsTable.userId).orderBy(desc(sql`sum(${depositsTable.amount})`)).limit(20);
  const topWithdrawals = await db.select({ userId: withdrawalsTable.userId, total: sql<string>`sum(${withdrawalsTable.amount})` }).from(withdrawalsTable).where(eq(withdrawalsTable.status, "completed")).groupBy(withdrawalsTable.userId).orderBy(desc(sql`sum(${withdrawalsTable.amount})`)).limit(20);
  const [[activeUsers], [activeOmbs], [activeTournaments], [upcoming], [completedOmbs], [completedTournaments], [deposited], [withdrawn]] = await Promise.all([
    db.select({ total: sql<string>`count(*)` }).from(usersTable).where(sql`${usersTable.updatedAt} >= now() - interval '24 hours'`),
    db.select({ total: sql<string>`count(*)` }).from(matchesTable).where(sql`${matchesTable.status} in ('waiting', 'room_available', 'ongoing', 'result_pending')`),
    db.select({ total: sql<string>`count(*)` }).from(tournamentsTable).where(sql`${tournamentsTable.status} in ('waiting', 'ongoing', 'result_pending')`),
    db.select({ total: sql<string>`count(*)` }).from(competitionSchedulesTable).where(and(eq(competitionSchedulesTable.status, "published"), sql`${competitionSchedulesTable.startsAt} > now()`)),
    db.select({ total: sql<string>`count(*)` }).from(matchesTable).where(sql`${matchesTable.status} = 'completed' and ${matchesTable.updatedAt}::date = current_date`),
    db.select({ total: sql<string>`count(*)` }).from(tournamentsTable).where(sql`${tournamentsTable.status} = 'completed' and ${tournamentsTable.updatedAt}::date = current_date`),
    db.select({ total: sql<string>`coalesce(sum(${depositsTable.amount}), 0)` }).from(depositsTable).where(eq(depositsTable.status, "success")),
    db.select({ total: sql<string>`coalesce(sum(${withdrawalsTable.amount}), 0)` }).from(withdrawalsTable).where(eq(withdrawalsTable.status, "completed")),
  ]);
  const topWinners = await db.select({ userId: matchParticipantsTable.userId, name: usersTable.name, amount: sql<string>`sum(${matchParticipantsTable.prizeAmount})` }).from(matchParticipantsTable).innerJoin(usersTable, eq(usersTable.id, matchParticipantsTable.userId)).groupBy(matchParticipantsTable.userId, usersTable.name).orderBy(desc(sql`sum(${matchParticipantsTable.prizeAmount})`)).limit(10);
  const topDepositorUsers = await db.select({ userId: depositsTable.userId, name: usersTable.name, amount: sql<string>`sum(${depositsTable.amount})` }).from(depositsTable).innerJoin(usersTable, eq(usersTable.id, depositsTable.userId)).where(eq(depositsTable.status, "success")).groupBy(depositsTable.userId, usersTable.name).orderBy(desc(sql`sum(${depositsTable.amount})`)).limit(10);
  return {
    users: { total: Number(users?.total ?? 0), activeLast24h: Number(activeUsers?.total ?? 0) },
    competitions: { active: Number(activeOmbs?.total ?? 0) + Number(activeTournaments?.total ?? 0), upcoming: Number(upcoming?.total ?? 0), completedToday: Number(completedOmbs?.total ?? 0) + Number(completedTournaments?.total ?? 0) },
    financials: { totalDeposited: Number(deposited?.total ?? 0), totalWithdrawn: Number(withdrawn?.total ?? 0), platformMargin: Number(deposited?.total ?? 0) - Number(withdrawn?.total ?? 0) },
    leaders: { topWinners: topWinners.map((row) => ({ userId: row.userId, name: row.name, amount: Number(row.amount ?? 0) })), topDepositors: topDepositorUsers.map((row) => ({ userId: row.userId, name: row.name, amount: Number(row.amount ?? 0) })) },
    totals: {
      users: Number(users?.total ?? 0), hosts: Number(hosts?.total ?? 0), playCoins: Number(play?.total ?? 0), winningCoins: Number(winning?.total ?? 0), cancelledOmbs: Number(cancelledOmbs?.total ?? 0), cancelledTournaments: Number(cancelledTournaments?.total ?? 0),
    },
    topDeposits: topDeposits.map((row) => ({ userId: row.userId, total: Number(row.total ?? 0) })),
    topWithdrawals: topWithdrawals.map((row) => ({ userId: row.userId, total: Number(row.total ?? 0) })),
  };
}
