import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { walletReservationsTable } from "./reservations";

export const competitionTypeEnum = pgEnum("competition_type", ["omb", "tournament"]);
export const competitionScheduleStatusEnum = pgEnum("competition_schedule_status", [
  "draft",
  "published",
  "closed",
]);
export const competitionStatusEnum = pgEnum("competition_status", [
  "waiting",
  "room_available",
  "ongoing",
  "result_pending",
  "completed",
  "cancelled",
]);
export const hostStatusEnum = pgEnum("host_status", ["active", "disabled"]);
export const hostAssignmentTypeEnum = pgEnum("host_assignment_type", ["omb", "tournament"]);

export interface PrizeDefinition {
  position: number;
  amount: number;
}

export const gamesTable = pgTable(
  "competition_games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("competition_games_name_idx").on(table.name)],
);

export const modesTable = pgTable(
  "competition_modes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => gamesTable.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("competition_modes_game_name_unique").on(table.gameId, table.name),
    index("competition_modes_game_id_idx").on(table.gameId),
  ],
);

export const competitionSchedulesTable = pgTable(
  "competition_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modeId: uuid("mode_id")
      .notNull()
      .references(() => modesTable.id, { onDelete: "restrict" }),
    type: competitionTypeEnum("type").notNull(),
    status: competitionScheduleStatusEnum("status").notNull().default("draft"),
    entryFee: integer("entry_fee").notNull(),
    maxParticipants: integer("max_participants").notNull(),
    teamSize: integer("team_size").notNull().default(1),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    entryClosesAt: timestamp("entry_closes_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes"),
    roomRevealMinutesBeforeStart: integer("room_reveal_minutes_before_start"),
    resultDeadlineMinutes: integer("result_deadline_minutes").notNull().default(90),
    managerAlertAfterMinutes: integer("manager_alert_after_minutes").notNull().default(5),
    tournamentMetric: text("tournament_metric"),
    prizes: jsonb("prizes").$type<PrizeDefinition[]>().notNull().default([]),
    guideVideoUrl: text("guide_video_url"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("competition_schedules_mode_type_status_idx").on(
      table.modeId,
      table.type,
      table.status,
    ),
    check("competition_schedules_entry_fee_positive", sql`${table.entryFee} > 0`),
    check("competition_schedules_max_participants_positive", sql`${table.maxParticipants} > 0`),
    check("competition_schedules_team_size_positive", sql`${table.teamSize} > 0`),
    check("competition_schedules_result_deadline_positive", sql`${table.resultDeadlineMinutes} > 0`),
    check("competition_schedules_manager_alert_nonnegative", sql`${table.managerAlertAfterMinutes} >= 0`),
  ],
);

export const tournamentPositionRevealsTable = pgTable(
  "tournament_position_reveals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => competitionSchedulesTable.id, { onDelete: "cascade" }),
    revealAt: timestamp("reveal_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tournament_position_reveals_schedule_idx").on(table.scheduleId, table.revealAt)],
);

export const hostsTable = pgTable(
  "competition_hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    mobileNumber: text("mobile_number").notNull(),
    upiId: text("upi_id").notNull(),
    role: hostAssignmentTypeEnum("role").notNull(),
    status: hostStatusEnum("status").notNull().default("active"),
    currentAssignmentType: hostAssignmentTypeEnum("current_assignment_type"),
    currentAssignmentId: uuid("current_assignment_id"),
    completedCount: integer("completed_count").notNull().default(0),
    paidCount: integer("paid_count").notNull().default(0),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("competition_hosts_role_status_assignment_idx").on(
      table.role,
      table.status,
      table.currentAssignmentId,
    ),
    check(
      "competition_hosts_assignment_pair_check",
      sql`(${table.currentAssignmentType} IS NULL AND ${table.currentAssignmentId} IS NULL) OR (${table.currentAssignmentType} IS NOT NULL AND ${table.currentAssignmentId} IS NOT NULL)`,
    ),
  ],
);

export const matchesTable = pgTable(
  "competition_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => competitionSchedulesTable.id, { onDelete: "restrict" }),
    hostId: uuid("host_id").references(() => hostsTable.id, { onDelete: "set null" }),
    status: competitionStatusEnum("status").notNull().default("waiting"),
    roomId: text("room_id"),
    roomPassword: text("room_password"),
    roomDetailsAddedAt: timestamp("room_details_added_at", { withTimezone: true }),
    hostClaimedAt: timestamp("host_claimed_at", { withTimezone: true }),
    resultSubmittedAt: timestamp("result_submitted_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    screenshotObjectKey: text("screenshot_object_key"),
    screenshotContentType: text("screenshot_content_type"),
    voiceNoteObjectKey: text("voice_note_object_key"),
    managerUnclaimedAlertedAt: timestamp("manager_unclaimed_alerted_at", { withTimezone: true }),
    managerUnclaimedSnoozedUntil: timestamp("manager_unclaimed_snoozed_until", { withTimezone: true }),
    managerRoomTimeoutAlertedAt: timestamp("manager_room_timeout_alerted_at", { withTimezone: true }),
    managerResultTimeoutAlertedAt: timestamp("manager_result_timeout_alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("competition_matches_schedule_status_created_idx").on(
      table.scheduleId,
      table.status,
      table.createdAt,
    ),
    index("competition_matches_host_status_idx").on(table.hostId, table.status),
  ],
);

export const matchParticipantsTable = pgTable(
  "competition_match_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matchesTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    gameUid: text("game_uid").notNull(),
    gameName: text("game_name").notNull(),
    seatNumber: integer("seat_number").notNull(),
    roomConfirmedAt: timestamp("room_confirmed_at", { withTimezone: true }),
    position: integer("position"),
    isCheater: boolean("is_cheater").notNull().default(false),
    prizeAmount: integer("prize_amount").notNull().default(0),
    reservationId: uuid("reservation_id")
      .notNull()
      .unique()
      .references(() => walletReservationsTable.id, { onDelete: "restrict" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("competition_match_participants_match_user_unique").on(table.matchId, table.userId),
    unique("competition_match_participants_match_seat_unique").on(table.matchId, table.seatNumber),
    index("competition_match_participants_user_joined_idx").on(table.userId, table.joinedAt),
  ],
);

export const tournamentsTable = pgTable(
  "competition_tournaments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => competitionSchedulesTable.id, { onDelete: "restrict" }),
    hostId: uuid("host_id").references(() => hostsTable.id, { onDelete: "set null" }),
    status: competitionStatusEnum("status").notNull().default("waiting"),
    entryClosesAt: timestamp("entry_closes_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    hostClaimedAt: timestamp("host_claimed_at", { withTimezone: true }),
    resultSubmittedAt: timestamp("result_submitted_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    voiceNoteObjectKey: text("voice_note_object_key"),
    managerUnclaimedAlertedAt: timestamp("manager_unclaimed_alerted_at", { withTimezone: true }),
    managerUnclaimedSnoozedUntil: timestamp("manager_unclaimed_snoozed_until", { withTimezone: true }),
    managerResultTimeoutAlertedAt: timestamp("manager_result_timeout_alerted_at", { withTimezone: true }),
    participantListNotifiedAt: timestamp("participant_list_notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("competition_tournaments_schedule_status_created_idx").on(
      table.scheduleId,
      table.status,
      table.createdAt,
    ),
    index("competition_tournaments_host_status_idx").on(table.hostId, table.status),
  ],
);

export const tournamentParticipantsTable = pgTable(
  "competition_tournament_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournamentsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    gameUid: text("game_uid").notNull(),
    gameName: text("game_name").notNull(),
    initialValue: integer("initial_value"),
    finalValue: integer("final_value"),
    performance: integer("performance"),
    rank: integer("rank"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    isCheater: boolean("is_cheater").notNull().default(false),
    prizeAmount: integer("prize_amount").notNull().default(0),
    reservationId: uuid("reservation_id")
      .notNull()
      .unique()
      .references(() => walletReservationsTable.id, { onDelete: "restrict" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("competition_tournament_participants_tournament_user_unique").on(
      table.tournamentId,
      table.userId,
    ),
    unique("competition_tournament_participants_tournament_seat_unique").on(
      table.tournamentId,
      table.gameUid,
    ),
    index("competition_tournament_participants_user_joined_idx").on(table.userId, table.joinedAt),
  ],
);

export const tournamentPositionValuesTable = pgTable(
  "tournament_position_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revealId: uuid("reveal_id")
      .notNull()
      .references(() => tournamentPositionRevealsTable.id, { onDelete: "cascade" }),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournamentsTable.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => tournamentParticipantsTable.id, { onDelete: "cascade" }),
    metricValue: integer("metric_value").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tournament_position_values_reveal_participant_unique").on(
      table.revealId,
      table.participantId,
    ),
    index("tournament_position_values_tournament_reveal_idx").on(
      table.tournamentId,
      table.revealId,
    ),
  ],
);

export const insertGameSchema = createInsertSchema(gamesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertModeSchema = createInsertSchema(modesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertScheduleSchema = createInsertSchema(competitionSchedulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Game = typeof gamesTable.$inferSelect;
export type Mode = typeof modesTable.$inferSelect;
export type CompetitionSchedule = typeof competitionSchedulesTable.$inferSelect;
export type Host = typeof hostsTable.$inferSelect;
export type Match = typeof matchesTable.$inferSelect;
export type MatchParticipant = typeof matchParticipantsTable.$inferSelect;
export type Tournament = typeof tournamentsTable.$inferSelect;
export type TournamentParticipant = typeof tournamentParticipantsTable.$inferSelect;
export type InsertGame = z.infer<typeof insertGameSchema>;
export type InsertMode = z.infer<typeof insertModeSchema>;
export type InsertCompetitionSchedule = z.infer<typeof insertScheduleSchema>;