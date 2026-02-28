import { db } from "./db";
import { attestationReceipts } from "@shared/schema";
import { sha256, signData, getKeyPair, computeEntryHash } from "./crypto";
import { storage } from "./storage";
import { sql } from "drizzle-orm";

const SEED_USER_ID = "forgeproof-system";

const seedFiles = [
    {
    fileName: "schema.ts",
    filePath: "shared/schema.ts",
    modelName: "GPT-5",
    modelProvider: "OpenAI",
    countryOfOrigin: "US",
    metadata: { purpose: "Data model definitions for ForgeProof platform", self_attested: true },
  },
  {
    fileName: "routes.ts",
    filePath: "server/routes.ts",
    modelName: "GPT-5",
    modelProvider: "OpenAI",
    countryOfOrigin: "US",
    metadata: { purpose: "API endpoint implementations", self_attested: true },
  },
  {
    fileName: "crypto.ts",
    filePath: "server/crypto.ts",
    modelName: "Replit Agent 3",
    modelProvider: "Replit",
    countryOfOrigin: "US",
    metadata: { purpose: "Ed25519 signing and SHA-256 hashing utilities", self_attested: true },
  },
  {
    fileName: "landing.tsx",
    filePath: "client/src/pages/landing.tsx",
    modelName: "Replit Agent 3",
    modelProvider: "Replit",
    countryOfOrigin: "US",
    metadata: { purpose: "Informational landing page component", self_attested: true },
  },
  {
    fileName: "dashboard.tsx",
    filePath: "client/src/pages/dashboard.tsx",
    modelName: "Replit Agent 3",
    modelProvider: "Replit",
    countryOfOrigin: "US",
    metadata: { purpose: "User dashboard for managing attestations", self_attested: true },
  },
];

export async function seedDatabase() {
  const existing = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts);
  const hasMultiModel = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts).where(sql`attestation_type = 'security_audit'`);
  
  if (existing[0].count > 0 && hasMultiModel[0].count > 0) {
    console.log("Seed data already exists, skipping...");
    return;
  }

  const { publicKey } = getKeyPair();
  const latestAttestation = await storage.getLatestAttestation();
  let prevEntryHash: string | null = latestAttestation?.entryHash || null;

  const createdAttestations: Array<{ id: number; fileHash: string; fileName: string; filePath: string; entryHash: string }> = [];

  if (existing[0].count === 0) {
    console.log("Seeding database with self-attesting receipts...");
    for (const file of seedFiles) {
    const fileContent = `ForgeProof self-attestation: ${file.filePath}`;
    const fileHash = sha256(fileContent);
    const timestamp = new Date().toISOString();

    const entryHash = computeEntryHash({
      fileHash,
      modelName: file.modelName,
      modelProvider: file.modelProvider,
      countryOfOrigin: file.countryOfOrigin,
      prevEntryHash,
      timestamp,
    });

    const signaturePayload = `${entryHash}|${fileHash}|${timestamp}`;
    const signature = signData(signaturePayload);

    const [created] = await db.insert(attestationReceipts).values({
      userId: SEED_USER_ID,
      fileHash,
      fileName: file.fileName,
      filePath: file.filePath,
      modelName: file.modelName,
      modelProvider: file.modelProvider,
      countryOfOrigin: file.countryOfOrigin,
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      metadata: file.metadata,
    }).returning();

      createdAttestations.push({ id: created.id, fileHash, fileName: file.fileName, filePath: file.filePath, entryHash });
      prevEntryHash = entryHash;
    }
    console.log(`Seeded ${seedFiles.length} self-attesting receipts.`);
  } else {
    const allAttestations = await storage.getAllAttestationsOrdered();
    for (const a of allAttestations) {
      createdAttestations.push({ id: a.id, fileHash: a.fileHash, fileName: a.fileName, filePath: a.filePath, entryHash: a.entryHash });
    }
    console.log("Origin seed data exists. Adding multi-model attestation examples...");
  }

  const cryptoOrigin = createdAttestations.find(a => a.fileName === "crypto.ts")!;
  const routesOrigin = createdAttestations.find(a => a.fileName === "routes.ts")!;
  if (!cryptoOrigin || !routesOrigin) {
    console.log("Could not find origin attestations for crypto.ts/routes.ts, skipping multi-model seeding.");
    return;
  }

  // 1. Secure audit on crypto.ts: Origin (Replit) → Audit: Secure (Claude)
  {
    const timestamp = new Date().toISOString();
    const entryHash = computeEntryHash({
      fileHash: cryptoOrigin.fileHash,
      modelName: "claude-3.5-sonnet",
      modelProvider: "Anthropic",
      countryOfOrigin: "US",
      prevEntryHash,
      timestamp,
    });
    const signaturePayload = `${entryHash}|${cryptoOrigin.fileHash}|${timestamp}`;
    const signature = signData(signaturePayload);

    await db.insert(attestationReceipts).values({
      userId: SEED_USER_ID,
      fileHash: cryptoOrigin.fileHash,
      fileName: cryptoOrigin.fileName,
      filePath: cryptoOrigin.filePath,
      modelName: "claude-3.5-sonnet",
      modelProvider: "Anthropic",
      countryOfOrigin: "US",
      attestationType: "security_audit",
      parentAttestationId: cryptoOrigin.id,
      auditVerdict: "secure",
      auditDetails: "Security audit passed. No vulnerabilities detected in cryptographic operations. Ed25519 implementation follows best practices. Key generation uses secure random sources. Hash chain construction is tamper-evident.",
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      metadata: { purpose: "Multi-model security audit of crypto module", auditor: "claude-3.5-sonnet" },
    });
    prevEntryHash = entryHash;
  }

  // 1b. OpenAI Audit on crypto.ts: Origin (Replit) → Audit: Secure (GPT-5)
  {
    const timestamp = new Date().toISOString();
    const entryHash = computeEntryHash({
      fileHash: cryptoOrigin.fileHash,
      modelName: "GPT-5",
      modelProvider: "OpenAI",
      countryOfOrigin: "US",
      prevEntryHash,
      timestamp,
    });
    const signaturePayload = `${entryHash}|${cryptoOrigin.fileHash}|${timestamp}`;
    const signature = signData(signaturePayload);

    await db.insert(attestationReceipts).values({
      userId: SEED_USER_ID,
      fileHash: cryptoOrigin.fileHash,
      fileName: cryptoOrigin.fileName,
      filePath: cryptoOrigin.filePath,
      modelName: "GPT-5",
      modelProvider: "OpenAI",
      countryOfOrigin: "US",
      attestationType: "security_audit",
      parentAttestationId: cryptoOrigin.id,
      auditVerdict: "secure",
      auditDetails: "Independent cryptographic review completed by GPT-5. Verified SHA-256 hash chain integrity and Ed25519 signature verification logic. All security constraints are satisfied.",
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      metadata: { purpose: "Secondary security audit of crypto module", auditor: "GPT-5" },
    });
    prevEntryHash = entryHash;
  }

  // 1c. Primary GPT-5 Attestation for index.ts
  {
    const fileContent = "ForgeProof self-attestation: server/index.ts";
    const fileHash = sha256(fileContent);
    const timestamp = new Date().toISOString();
    const entryHash = computeEntryHash({
      fileHash,
      modelName: "GPT-5",
      modelProvider: "OpenAI",
      countryOfOrigin: "US",
      prevEntryHash,
      timestamp,
    });
    const signaturePayload = `${entryHash}|${fileHash}|${timestamp}`;
    const signature = signData(signaturePayload);

    await db.insert(attestationReceipts).values({
      userId: SEED_USER_ID,
      fileHash,
      fileName: "index.ts",
      filePath: "server/index.ts",
      modelName: "GPT-5",
      modelProvider: "OpenAI",
      countryOfOrigin: "US",
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      metadata: { purpose: "Main server entry point", self_attested: true },
    });
    prevEntryHash = entryHash;
  }

  // 2. Flagged audit on routes.ts: Origin (Replit) → Audit: Flagged (Claude)
  let flaggedAuditId: number;
  {
    const timestamp = new Date().toISOString();
    const entryHash = computeEntryHash({
      fileHash: routesOrigin.fileHash,
      modelName: "claude-3.5-sonnet",
      modelProvider: "Anthropic",
      countryOfOrigin: "US",
      prevEntryHash,
      timestamp,
    });
    const signaturePayload = `${entryHash}|${routesOrigin.fileHash}|${timestamp}`;
    const signature = signData(signaturePayload);

    const [flaggedAudit] = await db.insert(attestationReceipts).values({
      userId: SEED_USER_ID,
      fileHash: routesOrigin.fileHash,
      fileName: routesOrigin.fileName,
      filePath: routesOrigin.filePath,
      modelName: "claude-3.5-sonnet",
      modelProvider: "Anthropic",
      countryOfOrigin: "US",
      attestationType: "security_audit",
      parentAttestationId: routesOrigin.id,
      auditVerdict: "flagged",
      auditDetails: "SQL injection risk detected in dynamic query construction. Parameterized queries recommended.",
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      metadata: { purpose: "Multi-model security audit of routes module", auditor: "claude-3.5-sonnet" },
    }).returning();
    flaggedAuditId = flaggedAudit.id;
    prevEntryHash = entryHash;
  }

  // 3. Remediation on routes.ts: Audit: Flagged (Claude) → Remediation (Claude)
  {
    const remediatedFileHash = sha256(`ForgeProof self-attestation: ${routesOrigin.filePath} (remediated)`);
    const timestamp = new Date().toISOString();
    const entryHash = computeEntryHash({
      fileHash: remediatedFileHash,
      modelName: "claude-3.5-sonnet",
      modelProvider: "Anthropic",
      countryOfOrigin: "US",
      prevEntryHash,
      timestamp,
    });
    const signaturePayload = `${entryHash}|${remediatedFileHash}|${timestamp}`;
    const signature = signData(signaturePayload);

    await db.insert(attestationReceipts).values({
      userId: SEED_USER_ID,
      fileHash: remediatedFileHash,
      fileName: routesOrigin.fileName,
      filePath: routesOrigin.filePath,
      modelName: "claude-3.5-sonnet",
      modelProvider: "Anthropic",
      countryOfOrigin: "US",
      attestationType: "security_audit",
      parentAttestationId: flaggedAuditId,
      auditVerdict: "remediated",
      auditDetails: "Refactored query construction to use parameterized queries. SQL injection risk eliminated.",
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      metadata: { purpose: "Remediation of flagged security issue in routes module", auditor: "claude-3.5-sonnet" },
    });
    prevEntryHash = entryHash;
  }

  console.log("Seeded 3 multi-model attestation examples (secure audit, flagged audit, remediation).");
}
