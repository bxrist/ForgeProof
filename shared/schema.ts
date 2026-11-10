import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, jsonb, boolean, foreignKey, check, uniqueIndex, index } from "drizzle-orm/pg-core";
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
  attestationType: varchar("attestation_type").default("origin"),
  parentAttestationId: integer("parent_attestation_id"),
  auditVerdict: varchar("audit_verdict"),
  auditDetails: text("audit_details"),
  signature: text("signature").notNull(),
  publicKey: text("public_key").notNull(),
  prevEntryHash: varchar("prev_entry_hash", { length: 128 }),
  entryHash: varchar("entry_hash", { length: 128 }).notNull(),
  receiptVersion: varchar("receipt_version").default("v1"),
  signedAt: varchar("signed_at"),
  gitCommitUrl: varchar("git_commit_url"),
  gitCommitMessage: varchar("git_commit_message"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Transactional intent for the private Git ledger. Payloads contain only the
// signed public receipt allowlist; tenant IDs, metadata, credentials, and
// billing fields remain in the application database.
export const receiptOutbox = pgTable("receipt_outbox", {
  id: serial("id").primaryKey(),
  receiptId: integer("receipt_id").notNull().unique()
    .references(() => attestationReceipts.id, { onDelete: "restrict" }),
  eventId: varchar("event_id", { length: 64 }).notNull().unique(),
  payload: jsonb("payload").notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  status: varchar("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  leaseOwner: varchar("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  lastErrorCode: varchar("last_error_code"),
  gitCommitSha: varchar("git_commit_sha"),
  ledgerSequence: integer("ledger_sequence"),
  ledgerEventHash: varchar("ledger_event_hash", { length: 64 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at"),
}, (t) => [
  check("receipt_outbox_status", sql`${t.status} in ('pending', 'processing', 'delivered', 'blocked')`),
  index("receipt_outbox_due").on(t.status, t.nextAttemptAt, t.id),
]);

// Local high-water mark is cross-checked against the signed Git checkpoint on
// every delivery. A mismatch blocks writes; it never rewinds either ledger.
export const receiptLedgerState = pgTable("receipt_ledger_state", {
  singleton: boolean("singleton").primaryKey().default(true),
  baseReceiptId: integer("base_receipt_id").notNull(),
  sequence: integer("sequence").notNull(),
  eventHash: varchar("event_hash", { length: 64 }).notNull(),
  receiptEntryHash: varchar("receipt_entry_hash", { length: 128 }).notNull(),
  commitSha: varchar("commit_sha").notNull(),
  signerKeyId: varchar("signer_key_id", { length: 64 }).notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  check("receipt_ledger_state_singleton", sql`${t.singleton} = true`),
]);

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

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(),
  orgId: integer("org_id"),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  plan: varchar("plan").notNull().default("free"),
  status: varchar("status").notNull().default("active"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  attestationLimit: integer("attestation_limit").notNull().default(100),
  attestationCount: integer("attestation_count").notNull().default(0),
  apiKeyLimit: integer("api_key_limit").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

export const pendingEmails = pgTable("pending_emails", {
  id: serial("id").primaryKey(),
  to: varchar("to").notNull(),
  subject: varchar("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  bodyText: text("body_text").notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at").notNull().defaultNow(),
  status: varchar("status").notNull().default("pending"),
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

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  organization: one(organizations, { fields: [subscriptions.orgId], references: [organizations.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  repositories: many(repositories),
  attestationReceipts: many(attestationReceipts),
  apiKeys: many(apiKeys),
  ownedOrganizations: many(organizations),
  orgMemberships: many(orgMembers),
  subscriptions: many(subscriptions),
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

export const insertSubscriptionSchema = createInsertSchema(subscriptions).omit({
  id: true,
  createdAt: true,
});

export const insertPendingEmailSchema = createInsertSchema(pendingEmails).omit({
  id: true,
  createdAt: true,
});

export type InsertPendingEmail = z.infer<typeof insertPendingEmailSchema>;
export type PendingEmail = typeof pendingEmails.$inferSelect;

export const PLAN_LIMITS = {
  free: { attestationLimit: 100, apiKeyLimit: 1, teamMembers: 1 },
  pro: { attestationLimit: 10000, apiKeyLimit: 10, teamMembers: 10 },
  enterprise: { attestationLimit: -1, apiKeyLimit: -1, teamMembers: -1 },
} as const;

export type PlanType = "free" | "pro" | "enterprise";

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

export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptions.$inferSelect;

// Operator-verified ownership only; never populated from issuance metadata or API keys.
// Permanent tenant pin survives revocation and organization deletion.
export const serviceDashboardPrincipals = pgTable("service_dashboard_principals", {
  issuerId: varchar("issuer_id").primaryKey().references(() => users.id),
  tenantKey: text("tenant_key").notNull(),
}, t => [uniqueIndex("service_dashboard_principal_target").on(t.issuerId, t.tenantKey)]);
export const serviceDashboardBindings = pgTable("service_dashboard_bindings", {
  id: serial("id").primaryKey(),
  issuerId: varchar("issuer_id").notNull().references(() => users.id),
  ownerId: varchar("owner_id").references(() => users.id),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  tenantKey: text("tenant_key").notNull(),
  scope: text("scope").notNull().default("selected"),
  scopeEvidence: text("scope_evidence"),
  evidence: text("evidence").notNull(),
  verifiedBy: varchar("verified_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (t) => [
  foreignKey({ columns: [t.issuerId, t.tenantKey], foreignColumns: [serviceDashboardPrincipals.issuerId, serviceDashboardPrincipals.tenantKey] }),
  check("service_dashboard_binding_tenant_key", sql`${t.tenantKey} = case when ${t.ownerId} is not null then 'user:' || ${t.ownerId} else 'org:' || ${t.orgId}::text end`),
  check("service_dashboard_binding_scope", sql`${t.scope} in ('selected', 'full-service')`),
  check("service_dashboard_binding_scope_evidence", sql`(${t.scope} = 'selected' and ${t.scopeEvidence} is null) or (${t.scope} = 'full-service' and ${t.scopeEvidence} is not null and length(trim(${t.scopeEvidence})) > 0)`),
  check("service_dashboard_binding_target", sql`(${t.ownerId} is null) <> (${t.orgId} is null)`),
  check("service_dashboard_binding_service", sql`${t.issuerId} <> 'forgeproof-system'`),
  check("service_dashboard_binding_separate_owner", sql`${t.ownerId} is distinct from ${t.issuerId}`),
  check("service_dashboard_binding_evidence", sql`length(trim(${t.evidence})) > 0`),
  check("service_dashboard_binding_verifier", sql`length(trim(${t.verifiedBy})) > 0`),
  uniqueIndex("service_dashboard_binding_tenant").on(t.issuerId).where(sql`${t.revokedAt} is null`),
]);
export const serviceDashboardGrants = pgTable("service_dashboard_grants", {
  id: serial("id").primaryKey(),
  bindingId: integer("binding_id").notNull().references(() => serviceDashboardBindings.id, { onDelete: "cascade" }),
  receiptId: integer("receipt_id").notNull().references(() => attestationReceipts.id, { onDelete: "cascade" }),
  grantedBy: varchar("granted_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (t) => [
  uniqueIndex("service_dashboard_grant_active").on(t.bindingId, t.receiptId).where(sql`${t.revokedAt} is null`),
  index("service_dashboard_grant_receipt").on(t.receiptId).where(sql`${t.revokedAt} is null`),
]);
