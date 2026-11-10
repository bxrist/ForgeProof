import type { InsertRepository, Repository, InsertAttestationReceipt, AttestationReceipt, InsertApiKey, ApiKey, InsertOrganization, Organization, InsertOrgMember, OrgMember, InsertAuditLog, AuditLog, InsertSubscription, Subscription, InsertPendingEmail, PendingEmail, PlanType } from "@shared/schema";
import type { User } from "@shared/models/auth";
import { applicationStorageFacade } from "./storageBackend";

export interface IStorage {
  ensureUser(id: string): Promise<User | undefined>;
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
  getAttestationsByFilePath(filePath: string, userId: string, repositoryId: number | null, issuerId?: string): Promise<AttestationReceipt[]>;
  getAttestationByEntryHash(entryHash: string): Promise<AttestationReceipt | undefined>;
  getAttestationsByParentId(parentId: number, ownerId: string): Promise<AttestationReceipt[]>;
  getLatestAttestation(): Promise<AttestationReceipt | undefined>;
  createAttestation(receipt: InsertAttestationReceipt): Promise<AttestationReceipt>;
  updateAttestationGitCommitUrl(id: number, url: string, commitMessage?: string): Promise<void>;

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

  createPendingEmail(email: InsertPendingEmail): Promise<PendingEmail>;
  getDuePendingEmails(): Promise<PendingEmail[]>;
  updatePendingEmail(id: number, data: Partial<InsertPendingEmail>): Promise<void>;
}

export const storage = applicationStorageFacade();
