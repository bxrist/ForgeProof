import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./models/auth";

export { users, sessions } from "./models/auth";

export const repositories = pgTable("repositories", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  githubId: integer("github_id").notNull(),
  name: varchar("name").notNull(),
  fullName: varchar("full_name").notNull(),
  url: varchar("url").notNull(),
  defaultBranch: varchar("default_branch").default("main"),
  description: text("description"),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const attestationReceipts = pgTable("attestation_receipts", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  repositoryId: integer("repository_id"),
  fileHash: varchar("file_hash", { length: 128 }).notNull(),
  fileName: varchar("file_name").notNull(),
  filePath: varchar("file_path").notNull(),
  modelName: varchar("model_name").notNull(),
  modelProvider: varchar("model_provider").notNull(),
  countryOfOrigin: varchar("country_of_origin").notNull(),
  signature: text("signature").notNull(),
  publicKey: text("public_key").notNull(),
  prevEntryHash: varchar("prev_entry_hash", { length: 128 }),
  entryHash: varchar("entry_hash", { length: 128 }).notNull(),
  receiptVersion: varchar("receipt_version").default("v1"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  name: varchar("name").notNull(),
  keyHash: varchar("key_hash").notNull(),
  keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),
  permissions: text("permissions").array().default(sql`ARRAY['attest:write', 'attest:read']`),
  isActive: boolean("is_active").default(true),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  repositories: many(repositories),
  attestationReceipts: many(attestationReceipts),
  apiKeys: many(apiKeys),
}));

export const repositoriesRelations = relations(repositories, ({ one, many }) => ({
  user: one(users, { fields: [repositories.userId], references: [users.id] }),
  attestationReceipts: many(attestationReceipts),
}));

export const attestationReceiptsRelations = relations(attestationReceipts, ({ one }) => ({
  user: one(users, { fields: [attestationReceipts.userId], references: [users.id] }),
  repository: one(repositories, { fields: [attestationReceipts.repositoryId], references: [repositories.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

export const insertRepositorySchema = createInsertSchema(repositories).omit({
  id: true,
  createdAt: true,
  lastSyncedAt: true,
});

export const insertAttestationReceiptSchema = createInsertSchema(attestationReceipts).omit({
  id: true,
  createdAt: true,
});

export const insertApiKeySchema = createInsertSchema(apiKeys).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});

export type InsertRepository = z.infer<typeof insertRepositorySchema>;
export type Repository = typeof repositories.$inferSelect;

export type InsertAttestationReceipt = z.infer<typeof insertAttestationReceiptSchema>;
export type AttestationReceipt = typeof attestationReceipts.$inferSelect;

export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeys.$inferSelect;
