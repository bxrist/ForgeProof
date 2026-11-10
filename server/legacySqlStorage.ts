import {
  users,
  serviceDashboardBindings,
  serviceDashboardGrants,
  repositories,
  attestationReceipts,
  apiKeys,
  organizations,
  orgMembers,
  auditLogs,
  subscriptions,
  pendingEmails,
  PLAN_LIMITS,
  type InsertRepository,
  type Repository,
  type InsertAttestationReceipt,
  type AttestationReceipt,
  type InsertApiKey,
  type ApiKey,
  type InsertOrganization,
  type Organization,
  type InsertOrgMember,
  type OrgMember,
  type InsertAuditLog,
  type AuditLog,
  type InsertSubscription,
  type Subscription,
  type InsertPendingEmail,
  type PendingEmail,
  type PlanType,
} from "@shared/schema";
import type { User } from "@shared/models/auth";
import { db, pool } from "./db";
import { drizzle } from "drizzle-orm/node-postgres";
import { gitLedgerEnabled, GitLedgerError } from "./gitLedger";
import { enqueueReceiptOutbox, stagingArchivePredecessor } from "./receiptOutbox";
import { computeEntryHash, getKeyPair, signData } from "./crypto";
import { eq, desc, and, or, asc, sql, lte, isNull } from "drizzle-orm";
import type { IStorage } from "./storage";

// One predicate for dashboard list, detail, lineage and child filtering.
export function dashboardReceiptScope(userId: string) {
  return or(eq(attestationReceipts.userId, userId), eq(attestationReceipts.userId, "forgeproof-system"), sql`exists (
    select 1 from ${serviceDashboardBindings} b
    where b.issuer_id = ${attestationReceipts.userId} and b.revoked_at is null
      and (b.scope = 'full-service' or (b.scope = 'selected' and exists (
        select 1 from ${serviceDashboardGrants} g where g.binding_id = b.id
          and g.receipt_id = ${attestationReceipts.id} and g.revoked_at is null
      )))
      and (b.owner_id = ${userId} or exists (
        select 1 from ${organizations} o where o.id = b.org_id
          and (o.owner_id = ${userId} or exists (
            select 1 from ${orgMembers} m where m.org_id = o.id and m.user_id = ${userId}
              and m.role in ('owner', 'admin', 'member')
          ))
      ))
  )`);
}

export class DatabaseStorage implements IStorage {
  async ensureUser(id: string): Promise<User | undefined> {
    const existing = await this.getUser(id);
    if (existing) return existing;
    const [created] = await db.insert(users).values({ id }).onConflictDoNothing().returning();
    return created ?? this.getUser(id);
  }
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user || undefined;
  }

  async updateUser(id: string, data: Partial<User>): Promise<void> {
    await db.update(users).set({ ...data, updatedAt: new Date() }).where(eq(users.id, id));
  }

  async getRepositories(userId: string): Promise<Repository[]> {
    return db.select().from(repositories).where(eq(repositories.userId, userId)).orderBy(desc(repositories.createdAt));
  }

  async getRepository(id: number): Promise<Repository | undefined> {
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, id));
    return repo || undefined;
  }

  async getRepositoryByGithubId(githubId: number, userId: string): Promise<Repository | undefined> {
    const [repo] = await db.select().from(repositories).where(
      and(eq(repositories.githubId, githubId), eq(repositories.userId, userId))
    );
    return repo || undefined;
  }

  async createRepository(repo: InsertRepository): Promise<Repository> {
    const [created] = await db.insert(repositories).values(repo).returning();
    return created;
  }

  async updateRepository(id: number, data: Partial<InsertRepository>): Promise<void> {
    await db.update(repositories).set(data).where(eq(repositories.id, id));
  }

  async updateRepositoryLastSynced(id: number): Promise<void> {
    await db.update(repositories).set({ lastSyncedAt: new Date() }).where(eq(repositories.id, id));
  }

  async deleteRepository(id: number): Promise<void> {
    await db.delete(repositories).where(eq(repositories.id, id));
  }

  async getAttestations(userId: string): Promise<AttestationReceipt[]> {
    return db.select().from(attestationReceipts)
      .where(dashboardReceiptScope(userId))
      .orderBy(desc(attestationReceipts.createdAt));
  }

  async getSystemAttestations(): Promise<AttestationReceipt[]> {
    return db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.userId, "forgeproof-system"))
      .orderBy(desc(attestationReceipts.createdAt));
  }

  async getAllAttestationsOrdered(): Promise<AttestationReceipt[]> {
    return db.select().from(attestationReceipts)
      .orderBy(asc(attestationReceipts.id));
  }

  async getAttestation(id: number): Promise<AttestationReceipt | undefined> {
    const [receipt] = await db.select().from(attestationReceipts).where(eq(attestationReceipts.id, id));
    return receipt || undefined;
  }

  async getAttestationsByFilePath(filePath: string, userId: string, repositoryId: number | null, issuerId?: string): Promise<AttestationReceipt[]> {
    const repoCondition = repositoryId === null
      ? isNull(attestationReceipts.repositoryId)
      : eq(attestationReceipts.repositoryId, repositoryId);
    return db.select().from(attestationReceipts)
      .where(and(
        eq(attestationReceipts.filePath, filePath),
        repoCondition,
        issuerId ? eq(attestationReceipts.userId, issuerId) : undefined,
        issuerId ? dashboardReceiptScope(userId) : or(eq(attestationReceipts.userId, userId), eq(attestationReceipts.userId, "forgeproof-system"))
      ))
      .orderBy(asc(attestationReceipts.id));
  }

  async getAttestationsByParentId(parentId: number, ownerId: string): Promise<AttestationReceipt[]> {
    return db.select().from(attestationReceipts)
      .where(and(
        eq(attestationReceipts.parentAttestationId, parentId),
        eq(attestationReceipts.userId, ownerId),
      ))
      .orderBy(asc(attestationReceipts.id));
  }

  async getAttestationByEntryHash(entryHash: string): Promise<AttestationReceipt | undefined> {
    const [receipt] = await db.select().from(attestationReceipts).where(eq(attestationReceipts.entryHash, entryHash));
    return receipt || undefined;
  }

  async getLatestAttestation(): Promise<AttestationReceipt | undefined> {
    const [receipt] = await db.select().from(attestationReceipts).orderBy(desc(attestationReceipts.id)).limit(1);
    return receipt || undefined;
  }

  async createAttestation(receipt: InsertAttestationReceipt): Promise<AttestationReceipt> {
    if (gitLedgerEnabled()) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Same lock as authenticated REST and LifeOS creation. Recompute only
        // this NEW receipt under the lock; never alter an existing signature.
        await client.query("SELECT pg_advisory_xact_lock(7329105)");
        const owner = await client.query("SELECT id FROM users WHERE id = $1", [receipt.userId]);
        if (owner.rows.length !== 1) {
          throw new GitLedgerError("New receipts require an existing authenticated identity", true, "issuer_unresolved");
        }
        const latest = await client.query("SELECT entry_hash FROM attestation_receipts ORDER BY id DESC LIMIT 1");
        const prevEntryHash = latest.rows[0]?.entry_hash ?? await stagingArchivePredecessor(client);
        const signedAt = new Date().toISOString();
        const entryHash = computeEntryHash({ ...receipt, prevEntryHash, timestamp: signedAt });
        const [created] = await drizzle(client).insert(attestationReceipts).values({
          ...receipt, prevEntryHash, signedAt, entryHash,
          publicKey: getKeyPair().publicKey,
          signature: signData(`${entryHash}|${receipt.fileHash}|${signedAt}`),
        }).returning();
        await enqueueReceiptOutbox(client, created);
        await client.query("COMMIT");
        return created;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const [created] = await db.insert(attestationReceipts).values(receipt).returning();
    return created;
  }

  async updateAttestationGitCommitUrl(id: number, url: string, commitMessage?: string): Promise<void> {
    await db.update(attestationReceipts).set({ gitCommitUrl: url, ...(commitMessage ? { gitCommitMessage: commitMessage } : {}) }).where(eq(attestationReceipts.id, id));
  }

  async getApiKeys(userId: string): Promise<ApiKey[]> {
    return db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt));
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
    return key || undefined;
  }

  async createApiKey(key: InsertApiKey): Promise<ApiKey> {
    const [created] = await db.insert(apiKeys).values(key).returning();
    return created;
  }

  async deleteApiKey(id: number, userId: string): Promise<void> {
    await db.delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
  }

  async updateApiKeyLastUsed(id: number): Promise<void> {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
  }

  async getOrganizations(userId: string): Promise<Organization[]> {
    const owned = await db.select().from(organizations).where(eq(organizations.ownerId, userId));
    const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, userId));
    const memberOrgIds = memberships.map(m => m.orgId);
    if (memberOrgIds.length === 0) return owned;
    const memberOrgs = await Promise.all(memberOrgIds.map(id => this.getOrganization(id)));
    const allOrgs = [...owned];
    for (const org of memberOrgs) {
      if (org && !allOrgs.find(o => o.id === org.id)) allOrgs.push(org);
    }
    return allOrgs;
  }

  async getOrganization(id: number): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
    return org || undefined;
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    return org || undefined;
  }

  async createOrganization(org: InsertOrganization): Promise<Organization> {
    const [created] = await db.insert(organizations).values(org).returning();
    return created;
  }

  async updateOrganization(id: number, data: Partial<InsertOrganization>): Promise<void> {
    await db.update(organizations).set(data).where(eq(organizations.id, id));
  }

  async deleteOrganization(id: number): Promise<void> {
    await db.delete(orgMembers).where(eq(orgMembers.orgId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }

  async getOrgMembers(orgId: number): Promise<OrgMember[]> {
    return db.select().from(orgMembers).where(eq(orgMembers.orgId, orgId));
  }

  async getOrgMember(orgId: number, userId: string): Promise<OrgMember | undefined> {
    const [member] = await db.select().from(orgMembers).where(
      and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))
    );
    return member || undefined;
  }

  async addOrgMember(member: InsertOrgMember): Promise<OrgMember> {
    const [created] = await db.insert(orgMembers).values(member).returning();
    return created;
  }

  async removeOrgMember(orgId: number, userId: string): Promise<void> {
    await db.delete(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
  }

  async updateOrgMemberRole(orgId: number, userId: string, role: string): Promise<void> {
    await db.update(orgMembers).set({ role }).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
  }

  async createAuditLog(log: InsertAuditLog): Promise<AuditLog> {
    const [created] = await db.insert(auditLogs).values(log).returning();
    return created;
  }

  async getAuditLogs(userId?: string, limit: number = 100): Promise<AuditLog[]> {
    if (userId) {
      return db.select().from(auditLogs).where(eq(auditLogs.userId, userId)).orderBy(desc(auditLogs.createdAt)).limit(limit);
    }
    return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
  }

  async getAuditLogsByResource(resourceType: string, resourceId: string): Promise<AuditLog[]> {
    return db.select().from(auditLogs).where(
      and(eq(auditLogs.resourceType, resourceType), eq(auditLogs.resourceId, resourceId))
    ).orderBy(desc(auditLogs.createdAt));
  }

  async clearAllAttestations(): Promise<void> {
    if (gitLedgerEnabled()) throw new GitLedgerError("Cannot clear an enabled immutable ledger", true, "immutable_ledger");
    await db.delete(attestationReceipts);
  }

  async getSubscription(userId: string): Promise<Subscription | undefined> {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    return sub || undefined;
  }

  async getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | undefined> {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    return sub || undefined;
  }

  async getSubscriptionByCustomerId(stripeCustomerId: string): Promise<Subscription | undefined> {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.stripeCustomerId, stripeCustomerId));
    return sub || undefined;
  }

  async createSubscription(sub: InsertSubscription): Promise<Subscription> {
    const [created] = await db.insert(subscriptions).values(sub).returning();
    return created;
  }

  async updateSubscription(id: number, data: Partial<InsertSubscription>): Promise<void> {
    await db.update(subscriptions).set(data).where(eq(subscriptions.id, id));
  }

  async incrementAttestationCount(userId: string): Promise<void> {
    await db.update(subscriptions)
      .set({ attestationCount: sql`${subscriptions.attestationCount} + 1` })
      .where(eq(subscriptions.userId, userId));
  }

  async resetAttestationCount(subscriptionId: number): Promise<void> {
    await db.update(subscriptions)
      .set({ attestationCount: 0 })
      .where(eq(subscriptions.id, subscriptionId));
  }

  async getOrCreateFreeSubscription(userId: string): Promise<Subscription> {
    const existing = await this.getSubscription(userId);
    if (existing) return existing;

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const [created] = await db
      .insert(subscriptions)
      .values({
        userId,
        plan: "free",
        status: "active",
        attestationLimit: PLAN_LIMITS.free.attestationLimit,
        attestationCount: 0,
        apiKeyLimit: PLAN_LIMITS.free.apiKeyLimit,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      })
      .onConflictDoNothing({ target: subscriptions.userId })
      .returning();

    if (created) return created;
    const [existingAfterRace] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    return existingAfterRace;
  }

  async createPendingEmail(email: InsertPendingEmail): Promise<PendingEmail> {
    const [created] = await db.insert(pendingEmails).values(email).returning();
    return created;
  }

  async getDuePendingEmails(): Promise<PendingEmail[]> {
    return db.select().from(pendingEmails)
      .where(and(eq(pendingEmails.status, "pending"), lte(pendingEmails.nextRetryAt, new Date())))
      .orderBy(asc(pendingEmails.id));
  }

  async updatePendingEmail(id: number, data: Partial<InsertPendingEmail>): Promise<void> {
    await db.update(pendingEmails).set(data).where(eq(pendingEmails.id, id));
  }
}

