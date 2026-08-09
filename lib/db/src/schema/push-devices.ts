import { index, pgTable, text, timestamp, unique, uuid, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const pushDevicesTable = pgTable(
  "push_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    platform: text("platform").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("push_devices_user_token_unique").on(table.userId, table.token),
    index("push_devices_user_active_idx").on(table.userId, table.isActive),
  ],
);

export type PushDevice = typeof pushDevicesTable.$inferSelect;
