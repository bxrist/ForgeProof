import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

// Session storage table.
// Preserved legacy sessions. Keep declared so schema pushes cannot drop data.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

// User storage table.
// Active application accounts; Clerk owns identity, this table owns app state.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  githubToken: text("github_token"),
  githubUsername: varchar("github_username"),
  notificationEmail: varchar("notification_email"),
  notifyOnGitFailure: boolean("notify_on_git_failure").notNull().default(true),
  stripeCustomerId: varchar("stripe_customer_id"),
  defaultRepoId: varchar("default_repo_id"),
  detailRepoId: varchar("detail_repo_id"),
  lastActiveTab: varchar("last_active_tab"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
