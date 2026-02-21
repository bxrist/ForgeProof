import { db } from "./db";
import { attestationReceipts } from "@shared/schema";
import { sha256, signData, getKeyPair, computeEntryHash } from "./crypto";
import { sql } from "drizzle-orm";

const SEED_USER_ID = "forgeproof-system";

const seedFiles = [
  {
    fileName: "schema.ts",
    filePath: "shared/schema.ts",
    modelName: "Replit Agent 3",
    modelProvider: "Replit",
    countryOfOrigin: "US",
    metadata: { purpose: "Data model definitions for ForgeProof platform", self_attested: true },
  },
  {
    fileName: "routes.ts",
    filePath: "server/routes.ts",
    modelName: "Replit Agent 3",
    modelProvider: "Replit",
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
  if (existing[0].count > 0) {
    console.log("Seed data already exists, skipping...");
    return;
  }

  console.log("Seeding database with self-attesting receipts...");
  const { publicKey } = getKeyPair();
  let prevEntryHash: string | null = null;

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

    await db.insert(attestationReceipts).values({
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
    });

    prevEntryHash = entryHash;
  }

  console.log(`Seeded ${seedFiles.length} self-attesting receipts.`);
}
