import {
  users,
  repositories,
  attestationReceipts,
  apiKeys,
  type InsertRepository,
  type Repository,
  type InsertAttestationReceipt,
  type AttestationReceipt,
  type InsertApiKey,
  type ApiKey,
} from "@shared/schema";
import type { User } from "@shared/models/auth";
import { db } from "./db";
import { eq, desc, and, or, asc } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;

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
  getLatestAttestation(): Promise<AttestationReceipt | undefined>;
  createAttestation(receipt: InsertAttestationReceipt): Promise<AttestationReceipt>;

  getApiKeys(userId: string): Promise<ApiKey[]>;
  getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined>;
  createApiKey(key: InsertApiKey): Promise<ApiKey>;
  deleteApiKey(id: number, userId: string): Promise<void>;
  updateApiKeyLastUsed(id: number): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
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
}

export const storage = new DatabaseStorage();
