import { db } from "./db";
import { attestationReceipts } from "@shared/schema";
import { sha256, signData, getKeyPair, computeEntryHash } from "./crypto";
import { storage } from "./storage";
import { sql } from "drizzle-orm";
import { gitLedgerEnabled } from "./gitLedger";

const SEED_USER_ID = "forgeproof-system";

const GITHUB_REPO = "https://github.com/bxrist/ForgeProof/commit/";

const seedFiles = [
  {
    fileName: "schema.ts",
    filePath: "shared/schema.ts",
    modelName: "GPT-5",
    modelProvider: "OpenAI",
    countryOfOrigin: "US",
    gitCommitUrl: `${GITHUB_REPO}f62d5ce17c8ae9093d393fce7f9a2c426f08f144`,
    gitCommitMessage: "Add Drizzle ORM schema with attestation receipts and hash chain support",
    metadata: { purpose: "Data model definitions for ForgeProof platform", self_attested: true },
  },
  {
    fileName: "routes.ts",
    filePath: "server/routes.ts",
    modelName: "GPT-5",
    modelProvider: "OpenAI",
    countryOfOrigin: "US",
    gitCommitUrl: `${GITHUB_REPO}5471de789d8f014d19aa5bca2a397d491bd2cc30`,
    gitCommitMessage: "Implement REST API routes for attestation CRUD and GitHub OAuth",
    metadata: { purpose: "API endpoint implementations", self_attested: true },
  },
  {
    fileName: "crypto.ts",
    filePath: "server/crypto.ts",
    modelName: "Replit Agent 3",
    modelProvider: "Replit",
    countryOfOrigin: "US",
    gitCommitUrl: `${GITHUB_REPO}cc3552fee89725d3a2c0602259ac79cba7769f14`,
    gitCommitMessage: "Add Ed25519 signing, SHA-256 hashing, and hash chain computation",
    metadata: { purpose: "Ed25519 signing and SHA-256 hashing utilities", self_attested: true },
  },
  {
    fileName: "landing.tsx",
    filePath: "client/src/pages/landing.tsx",
    modelName: "Replit Agent 3",
    modelProvider: "Replit",
    countryOfOrigin: "US",
    gitCommitUrl: `${GITHUB_REPO}d3d6f4e1c2895df9fd2400f71edf7de2befecb5b`,
    gitCommitMessage: "Build comprehensive landing page with sovereignty messaging and architecture diagram",
    metadata: { purpose: "Informational landing page component", self_attested: true },
  },
  {
    fileName: "dashboard.tsx",
    filePath: "client/src/pages/dashboard.tsx",
    modelName: "Replit Agent 3",
    modelProvider: "Replit",
    countryOfOrigin: "US",
    gitCommitUrl: `${GITHUB_REPO}7987b912e38a49ae271ce422f679f7d5ce8b705d`,
    gitCommitMessage: "Add user dashboard with attestation list, GitHub sync, and API key management",
    metadata: { purpose: "User dashboard for managing attestations", self_attested: true },
  },
];

export async function seedDatabase() {
  // An activated archive must never receive synthetic startup receipts.
  if (gitLedgerEnabled()) return;
  const existing = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts);
  const existingCount = Number(existing[0].count);

  if (existingCount > 0) {
    const staleCheck = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts).where(sql`signed_at IS NULL AND user_id = 'forgeproof-system'`);
    const staleCount = Number(staleCheck[0].count);
    if (staleCount > 0) {
      console.log(`Found ${staleCount} stale seed attestations without signedAt. Clearing and re-seeding...`);
      await db.delete(attestationReceipts).where(sql`user_id = 'forgeproof-system'`);
    } else {
      const hasMultiModel = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts).where(sql`attestation_type = 'security_audit'`);
      const multiModelCount = Number(hasMultiModel[0].count);
      const hasOpenAI = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts).where(sql`model_provider = 'OpenAI' AND user_id = 'forgeproof-system'`);
      const openAICount = Number(hasOpenAI[0].count);
      if (multiModelCount > 0 && openAICount > 0) {
        const missingGitUrls = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts).where(sql`git_commit_url IS NULL AND user_id = 'forgeproof-system'`);
        const missingCount = Number(missingGitUrls[0].count);
        const hasRealUrls = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts).where(sql`git_commit_url LIKE '%cc3552fee89725d3a2c0602259ac79cba7769f14%' AND user_id = 'forgeproof-system'`);
        const realUrlCount = Number(hasRealUrls[0].count);
        const missingCommitMessages = await db.select({ count: sql<number>`count(*)` }).from(attestationReceipts).where(sql`git_commit_message IS NULL AND user_id = 'forgeproof-system'`);
        const missingMsgCount = Number(missingCommitMessages[0].count);
        const hasLegacyLineage = await db.execute(sql`
          SELECT count(*) AS count FROM attestation_receipts r
          JOIN attestation_receipts o ON r.parent_attestation_id = o.id
          WHERE r.user_id = 'forgeproof-system' AND r.model_name = 'GPT-5' AND r.attestation_type = 'refactor'
            AND o.model_name = 'GPT-4' AND o.user_id = 'forgeproof-system'
            AND o.git_commit_url LIKE '%5471de789d8f014d19aa5bca2a397d491bd2cc30%'
        `);
        const legacyCount = Number((hasLegacyLineage as any).rows?.[0]?.count ?? (hasLegacyLineage as any)[0]?.count ?? 0);

        if (missingCount === 0 && realUrlCount > 0 && missingMsgCount === 0 && legacyCount > 0) {
          // Guard: verify no stale model names remain. The expected set is exactly:
          //   GPT-5, Replit Agent 3, claude-sonnet-5 (current names), plus GPT-4
          //   which is kept intentionally for the legacy-lineage demonstration row.
          const staleModels = await db
            .select({ count: sql<number>`count(*)` })
            .from(attestationReceipts)
            .where(
              sql`user_id = 'forgeproof-system'
                  AND model_name NOT IN ('GPT-5', 'Replit Agent 3', 'claude-sonnet-5', 'GPT-4')`
            );
          const staleModelCount = Number(staleModels[0].count);
          if (staleModelCount > 0) {
            console.log(
              `Seed data has ${staleModelCount} row(s) with stale model names. Clearing and re-seeding...`
            );
            await db
              .delete(attestationReceipts)
              .where(sql`user_id = 'forgeproof-system'`);
            // Fall through to re-seed below.
          } else {
            console.log("Seed data already exists and is complete, skipping...");
            return;
          }
        }
        if (missingCount > 0) {
          console.log(`Seed data has ${missingCount} entries missing git commit URLs. Clearing and re-seeding...`);
        } else if (realUrlCount === 0) {
          console.log("Seed data has placeholder git commit URLs. Clearing and re-seeding with real URLs...");
        } else if (missingMsgCount > 0) {
          console.log(`Seed data missing commit messages (${missingMsgCount} entries). Clearing and re-seeding...`);
        } else {
          console.log("Seed data missing legacy-model lineage example. Clearing and re-seeding...");
        }
        await db.delete(attestationReceipts).where(sql`user_id = 'forgeproof-system'`);
      } else {
        console.log("Seed data missing OpenAI entries. Clearing and re-seeding...");
        await db.delete(attestationReceipts).where(sql`user_id = 'forgeproof-system'`);
      }
    }
  }

  const { publicKey } = getKeyPair();
  const latestAttestation = await storage.getLatestAttestation();
  let prevEntryHash: string | null = latestAttestation?.entryHash || null;

  const createdAttestations: Array<{ id: number; fileHash: string; fileName: string; filePath: string; entryHash: string }> = [];

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
      signedAt: timestamp,
      gitCommitUrl: file.gitCommitUrl,
      gitCommitMessage: file.gitCommitMessage,
      metadata: file.metadata,
    }).returning();

    createdAttestations.push({ id: created.id, fileHash, fileName: file.fileName, filePath: file.filePath, entryHash });
    prevEntryHash = entryHash;
  }
  console.log(`Seeded ${seedFiles.length} self-attesting receipts.`);

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
      modelName: "claude-sonnet-5",
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
      modelName: "claude-sonnet-5",
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
      signedAt: timestamp,
      gitCommitUrl: `${GITHUB_REPO}53a268098939b9744903a608ea585fa30d1708bc`,
      gitCommitMessage: "Anthropic audit: crypto module passes all security checks",
      metadata: { purpose: "Multi-model security audit of crypto module", auditor: "claude-sonnet-5" },
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
      signedAt: timestamp,
      gitCommitUrl: `${GITHUB_REPO}84d1eef8732d4e4fe8e7251a8e3df0907c2054e0`,
      gitCommitMessage: "OpenAI secondary audit: verify Ed25519 and hash chain integrity",
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
      signedAt: timestamp,
      gitCommitUrl: `${GITHUB_REPO}073bd5ac9af7945755962285e3b6299cfceb27f4`,
      gitCommitMessage: "Add Express server entry point with rate limiting and middleware",
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
      modelName: "claude-sonnet-5",
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
      modelName: "claude-sonnet-5",
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
      signedAt: timestamp,
      gitCommitUrl: `${GITHUB_REPO}b743e220061e6bd9271bc9d69587d61b11a77362`,
      gitCommitMessage: "Claude audit: flag SQL injection risk in dynamic query construction",
      metadata: { purpose: "Multi-model security audit of routes module", auditor: "claude-sonnet-5" },
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
      modelName: "claude-sonnet-5",
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
      modelName: "claude-sonnet-5",
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
      signedAt: timestamp,
      gitCommitUrl: `${GITHUB_REPO}14e6c786be3188764941b8b78c9b4554d6972495`,
      gitCommitMessage: "Fix SQL injection: refactor to parameterized queries",
      metadata: { purpose: "Remediation of flagged security issue in routes module", auditor: "claude-sonnet-5" },
    });
    prevEntryHash = entryHash;
  }

  console.log("Seeded 3 multi-model attestation examples (secure audit, flagged audit, remediation).");

  // 4. Legacy-model lineage on github.ts: Origin (GPT-4, 2024-era) → Refactor (GPT-5)
  // Demonstrates that older receipts permanently keep the model that actually wrote the code.
  let legacyOriginId: number;
  const legacyFileHash = sha256("ForgeProof self-attestation: server/github.ts");
  {
    const timestamp = new Date().toISOString();
    const entryHash = computeEntryHash({
      fileHash: legacyFileHash,
      modelName: "GPT-4",
      modelProvider: "OpenAI",
      countryOfOrigin: "US",
      prevEntryHash,
      timestamp,
    });
    const signaturePayload = `${entryHash}|${legacyFileHash}|${timestamp}`;
    const signature = signData(signaturePayload);

    const [legacyOrigin] = await db.insert(attestationReceipts).values({
      userId: SEED_USER_ID,
      fileHash: legacyFileHash,
      fileName: "github.ts",
      filePath: "server/github.ts",
      modelName: "GPT-4",
      modelProvider: "OpenAI",
      countryOfOrigin: "US",
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      signedAt: timestamp,
      gitCommitUrl: `${GITHUB_REPO}5471de789d8f014d19aa5bca2a397d491bd2cc30`,
      gitCommitMessage: "Add GitHub API client for repo sync and file fetching",
      metadata: { purpose: "GitHub integration module — original implementation under a legacy model", self_attested: true },
    }).returning();
    legacyOriginId = legacyOrigin.id;
    prevEntryHash = entryHash;
  }

  {
    const refactoredFileHash = sha256("ForgeProof self-attestation: server/github.ts (refactored)");
    const timestamp = new Date().toISOString();
    const entryHash = computeEntryHash({
      fileHash: refactoredFileHash,
      modelName: "GPT-5",
      modelProvider: "OpenAI",
      countryOfOrigin: "US",
      prevEntryHash,
      timestamp,
    });
    const signaturePayload = `${entryHash}|${refactoredFileHash}|${timestamp}`;
    const signature = signData(signaturePayload);

    await db.insert(attestationReceipts).values({
      userId: SEED_USER_ID,
      fileHash: refactoredFileHash,
      fileName: "github.ts",
      filePath: "server/github.ts",
      modelName: "GPT-5",
      modelProvider: "OpenAI",
      countryOfOrigin: "US",
      attestationType: "refactor",
      parentAttestationId: legacyOriginId,
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      signedAt: timestamp,
      gitCommitUrl: `${GITHUB_REPO}14e6c786be3188764941b8b78c9b4554d6972495`,
      gitCommitMessage: "Refactor GitHub client: retries, pagination, and typed responses",
      metadata: { purpose: "Modernization of GitHub client — original GPT-4 receipt preserved in lineage", self_attested: true },
    });
    prevEntryHash = entryHash;
  }

  console.log("Seeded legacy-model lineage example (GPT-4 origin → GPT-5 refactor on server/github.ts).");
}
