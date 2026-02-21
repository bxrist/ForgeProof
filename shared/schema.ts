import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./models/auth";

export { users, sessions } from "./models/auth";

export const repositories = pgTable("repositories", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  orgId: integer("org_id"),
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
  orgId: integer("org_id"),
  repositoryId: integer("repository_id"),
  fileHash: varchar("file_hash", { length: 128 }).notNull(),
  fileName: varchar("file_name").notNull(),
  filePath: varchar("file_path").notNull(),
  modelName: varchar("model_name").notNull(),
  modelProvider: varchar("model_provider").notNull(),
  countryOfOrigin: varchar("country_of_origin").notNull(),
  detectedCountry: varchar("detected_country"),
  complianceStatus: varchar("compliance_status").default("unverified"),
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

export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull(),
  slug: varchar("slug").notNull().unique(),
  ownerId: varchar("owner_id").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const orgMembers = pgTable("org_members", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  userId: varchar("user_id").notNull(),
  role: varchar("role").default("member"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id"),
  action: varchar("action").notNull(),
  resourceType: varchar("resource_type"),
  resourceId: varchar("resource_id"),
  metadata: jsonb("metadata"),
  ipAddress: varchar("ip_address"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  repositories: many(repositories),
  attestationReceipts: many(attestationReceipts),
  apiKeys: many(apiKeys),
  ownedOrganizations: many(organizations),
  orgMemberships: many(orgMembers),
}));

export const repositoriesRelations = relations(repositories, ({ one, many }) => ({
  user: one(users, { fields: [repositories.userId], references: [users.id] }),
  organization: one(organizations, { fields: [repositories.orgId], references: [organizations.id] }),
  attestationReceipts: many(attestationReceipts),
}));

export const attestationReceiptsRelations = relations(attestationReceipts, ({ one }) => ({
  user: one(users, { fields: [attestationReceipts.userId], references: [users.id] }),
  organization: one(organizations, { fields: [attestationReceipts.orgId], references: [organizations.id] }),
  repository: one(repositories, { fields: [attestationReceipts.repositoryId], references: [repositories.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, { fields: [organizations.ownerId], references: [users.id] }),
  members: many(orgMembers),
  repositories: many(repositories),
  attestationReceipts: many(attestationReceipts),
}));

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  organization: one(organizations, { fields: [orgMembers.orgId], references: [organizations.id] }),
  user: one(users, { fields: [orgMembers.userId], references: [users.id] }),
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

export const insertOrganizationSchema = createInsertSchema(organizations).omit({
  id: true,
  createdAt: true,
});

export const insertOrgMemberSchema = createInsertSchema(orgMembers).omit({
  id: true,
  createdAt: true,
});

export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertRepository = z.infer<typeof insertRepositorySchema>;
export type Repository = typeof repositories.$inferSelect;

export type InsertAttestationReceipt = z.infer<typeof insertAttestationReceiptSchema>;
export type AttestationReceipt = typeof attestationReceipts.$inferSelect;

export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeys.$inferSelect;

export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;

export type InsertOrgMember = z.infer<typeof insertOrgMemberSchema>;
export type OrgMember = typeof orgMembers.$inferSelect;

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogs.$inferSelect;
