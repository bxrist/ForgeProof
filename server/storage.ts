import {
  users,
  repositories,
  attestationReceipts,
  apiKeys,
  organizations,
  orgMembers,
  auditLogs,
  subscriptions,
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
  type PlanType,
} from "@shared/schema";
import type { User } from "@shared/models/auth";
import { db } from "./db";
import { eq, desc, and, or, asc, sql } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  updateUser(id: string, data: Partial<User>): Promise<void>;

  getRepositories(userId: string): Promise<Repository[]>;
  getRepository(id: number): Promise<Repository | undefined>;
  getRepositoryByGithubId(githubId: number, userId: string): Promise<Repository | undefined>;
  createRepository(repo: InsertRepository): Promise<Repository>;
  updateRepository(id: number, data: Partial<InsertRepository>): Promise<void>;
  updateRepositoryLastSynced(id: number): Promise<void>;
  deleteRepository(id: number): Promise<void>;

  getAttestations(userId: string): Promise<AttestationReceipt[]>;
  getSystemAttestations(): Promise<AttestationReceipt[]>;
  getAllAttestationsOrdered(): Promise<AttestationReceipt[]>;
  getAttestation(id: number): Promise<AttestationReceipt | undefined>;
  getAttestationByEntryHash(entryHash: string): Promise<AttestationReceipt | undefined>;
  getAttestationsByParentId(parentId: number): Promise<AttestationReceipt[]>;
  getLatestAttestation(): Promise<AttestationReceipt | undefined>;
  createAttestation(receipt: InsertAttestationReceipt): Promise<AttestationReceipt>;

  getApiKeys(userId: string): Promise<ApiKey[]>;
  getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined>;
  createApiKey(key: InsertApiKey): Promise<ApiKey>;
  deleteApiKey(id: number, userId: string): Promise<void>;
  updateApiKeyLastUsed(id: number): Promise<void>;

  getOrganizations(userId: string): Promise<Organization[]>;
  getOrganization(id: number): Promise<Organization | undefined>;
  getOrganizationBySlug(slug: string): Promise<Organization | undefined>;
  createOrganization(org: InsertOrganization): Promise<Organization>;
  updateOrganization(id: number, data: Partial<InsertOrganization>): Promise<void>;
  deleteOrganization(id: number): Promise<void>;

  getOrgMembers(orgId: number): Promise<OrgMember[]>;
  getOrgMember(orgId: number, userId: string): Promise<OrgMember | undefined>;
  addOrgMember(member: InsertOrgMember): Promise<OrgMember>;
  removeOrgMember(orgId: number, userId: string): Promise<void>;
  updateOrgMemberRole(orgId: number, userId: string, role: string): Promise<void>;

  createAuditLog(log: InsertAuditLog): Promise<AuditLog>;
  getAuditLogs(userId?: string, limit?: number): Promise<AuditLog[]>;
  getAuditLogsByResource(resourceType: string, resourceId: string): Promise<AuditLog[]>;
  clearAllAttestations(): Promise<void>;

  getSubscription(userId: string): Promise<Subscription | undefined>;
  getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | undefined>;
  getSubscriptionByCustomerId(stripeCustomerId: string): Promise<Subscription | undefined>;
  createSubscription(sub: InsertSubscription): Promise<Subscription>;
  updateSubscription(id: number, data: Partial<InsertSubscription>): Promise<void>;
  incrementAttestationCount(userId: string): Promise<void>;
  resetAttestationCount(subscriptionId: number): Promise<void>;
  getOrCreateFreeSubscription(userId: string): Promise<Subscription>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
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
      .where(or(eq(attestationReceipts.userId, userId), eq(attestationReceipts.userId, "forgeproof-system")))
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

  async getAttestationsByParentId(parentId: number): Promise<AttestationReceipt[]> {
    return db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.parentAttestationId, parentId))
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
    const [created] = await db.insert(attestationReceipts).values(receipt).returning();
    return created;
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

    return this.createSubscription({
      userId,
      plan: "free",
      status: "active",
      attestationLimit: PLAN_LIMITS.free.attestationLimit,
      attestationCount: 0,
      apiKeyLimit: PLAN_LIMITS.free.apiKeyLimit,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });
  }
}

export const storage = new DatabaseStorage();
