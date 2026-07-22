import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { pool } from "./db";
import { setupAuth, isAuthenticated } from "./replit_integrations/auth/replitAuth";
import { sha256, signData, getKeyPair, computeEntryHash, generateApiKey, verifySignature } from "./crypto";
import { fetchUserRepos, fetchRepoFiles, fetchFileContent, fetchRepoCommits, fetchCommitFiles, commitAttestationToGit } from "./github";
import { z } from "zod";
import { getMcpManifest, handleMcpTool } from "./mcp";
import { sendGitCommitFailureEmail } from "./email";
import { attestationReceipts } from "@shared/schema";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

const publicApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

const agentApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Rate limit exceeded for agent API." },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many verification requests." },
});

const demoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests to demo endpoints." },
});

const attestRequestSchema = z.object({
  file_path: z.string(),
  file_hash: z.string(),
  model_name: z.string(),
  model_provider: z.string(),
  country_of_origin: z.string(),
  repository: z.string().optional(),
  file_name: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  attestation_type: z.enum(["origin", "security_audit", "refactor", "review"]).optional().default("origin"),
  parent_attestation_id: z.number().optional(),
  audit_verdict: z.enum(["secure", "flagged", "remediated", "needs_review"]).optional(),
  audit_details: z.string().optional(),
});

const agentAttestSchema = z.object({
  files: z.array(z.object({
    file_path: z.string(),
    file_hash: z.string(),
    file_name: z.string().optional(),
  })),
  model_name: z.string(),
  model_provider: z.string(),
  country_of_origin: z.string(),
  repository: z.string().optional(),
  session_id: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

function detectCountryFromRequest(req: Request): string | null {
  const cfCountry = req.headers["cf-ipcountry"] as string | undefined;
  if (cfCountry && cfCountry !== "XX" && cfCountry !== "T1") return cfCountry;

  const xForwardedFor = req.headers["x-forwarded-for"] as string | undefined;
  if (xForwardedFor) {
    return null;
  }

  const xRealIp = req.headers["x-real-ip"] as string | undefined;
  if (xRealIp) {
    return null;
  }

  return null;
}

function computeComplianceStatus(declared: string, detected: string | null): string {
  if (!detected) return "unverified";
  if (declared.toUpperCase() === detected.toUpperCase()) return "verified";
  return "mismatch";
}

async function authenticateApiKey(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.substring(7);
  const keyHash = sha256(token);
  const apiKey = await storage.getApiKeyByHash(keyHash);
  if (!apiKey || !apiKey.isActive) return null;
  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) return null;

  await storage.updateApiKeyLastUsed(apiKey.id);
  return apiKey.userId;
}

const ADVISORY_LOCK_ID = 7329105;
const MAX_RETRIES = 3;

async function createAttestationReceipt(
  userId: string,
  data: { file_path: string; file_hash: string; file_name?: string; model_name: string; model_provider: string; country_of_origin: string; metadata?: any; attestation_type?: string; parent_attestation_id?: number; audit_verdict?: string; audit_details?: string },
  detectedCountry: string | null,
  repositoryId?: number
) {
  const subscription = await storage.getOrCreateFreeSubscription(userId);

  const fileName = data.file_name || data.file_path.split("/").pop() || "unknown";
  const { publicKey } = getKeyPair();
  const complianceStatus = computeComplianceStatus(data.country_of_origin, detectedCountry);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);

      const quotaResult = await client.query(
        `UPDATE subscriptions
         SET attestation_count = attestation_count + 1
         WHERE user_id = $1 AND (attestation_limit = -1 OR attestation_count < attestation_limit)
         RETURNING id`,
        [userId]
      );
      if (quotaResult.rows.length === 0) {
        await client.query("ROLLBACK");
        const err: any = new Error(
          `Monthly attestation limit reached (${subscription.attestationLimit} on the ${subscription.plan} plan). Upgrade your plan to continue attesting.`
        );
        err.status = 402;
        throw err;
      }

      const latestResult = await client.query(
        `SELECT entry_hash FROM attestation_receipts ORDER BY id DESC LIMIT 1`
      );
      const prevEntryHash = latestResult.rows.length > 0 ? latestResult.rows[0].entry_hash : null;

      const timestamp = new Date().toISOString();
      const entryHash = computeEntryHash({
        fileHash: data.file_hash,
        modelName: data.model_name,
        modelProvider: data.model_provider,
        countryOfOrigin: data.country_of_origin,
        prevEntryHash,
        timestamp,
      });

      const signaturePayload = `${entryHash}|${data.file_hash}|${timestamp}`;
      const signature = signData(signaturePayload);

      const insertResult = await client.query(
        `INSERT INTO attestation_receipts (
          user_id, repository_id, file_hash, file_name, file_path,
          model_name, model_provider, country_of_origin, detected_country, compliance_status,
          attestation_type, parent_attestation_id, audit_verdict, audit_details,
          signature, public_key, prev_entry_hash, entry_hash,
          receipt_version, signed_at, metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        RETURNING *`,
        [
          userId,
          repositoryId || null,
          data.file_hash,
          fileName,
          data.file_path,
          data.model_name,
          data.model_provider,
          data.country_of_origin,
          detectedCountry,
          complianceStatus,
          data.attestation_type || "origin",
          data.parent_attestation_id || null,
          data.audit_verdict || null,
          data.audit_details || null,
          signature,
          publicKey,
          prevEntryHash,
          entryHash,
          "v1",
          timestamp,
          data.metadata ? JSON.stringify(data.metadata) : null,
        ]
      );

      await client.query("COMMIT");

      const row = insertResult.rows[0];
      return {
        id: row.id,
        userId: row.user_id,
        orgId: row.org_id,
        repositoryId: row.repository_id,
        fileHash: row.file_hash,
        fileName: row.file_name,
        filePath: row.file_path,
        modelName: row.model_name,
        modelProvider: row.model_provider,
        countryOfOrigin: row.country_of_origin,
        detectedCountry: row.detected_country,
        complianceStatus: row.compliance_status,
        attestationType: row.attestation_type,
        parentAttestationId: row.parent_attestation_id,
        auditVerdict: row.audit_verdict,
        auditDetails: row.audit_details,
        signature: row.signature,
        publicKey: row.public_key,
        prevEntryHash: row.prev_entry_hash,
        entryHash: row.entry_hash,
        receiptVersion: row.receipt_version,
        signedAt: row.signed_at,
        gitCommitUrl: row.git_commit_url ?? null,
        metadata: row.metadata,
        createdAt: row.created_at,
      };
    } catch (err: any) {
      await client.query("ROLLBACK");
      if (err.code === "40001" && attempt < MAX_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error("Failed to create attestation after maximum retries");
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);

  // ─── Auth ─────────────────────────────────────────
  app.get("/api/auth/user", (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const user = req.user as any;
    const claims = user.claims;
    if (claims) {
      return res.json({
        id: claims.sub,
        email: claims.email,
        firstName: claims.first_name,
        lastName: claims.last_name,
        profileImageUrl: claims.profile_image_url,
      });
    }
    return res.json(user);
  });

  // ─── Attestations (authenticated) ─────────────────
  app.get("/api/attestations", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const attestations = await storage.getAttestations(userId);
    res.json(attestations);
  });

  app.get("/api/attestations/:id", isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const attestation = await storage.getAttestation(id);
    if (!attestation) return res.status(404).json({ message: "Not found" });
    if (attestation.userId !== userId && attestation.userId !== "forgeproof-system") {
      return res.status(403).json({ message: "Forbidden" });
    }
    const childAttestations = await storage.getAttestationsByParentId(id);
    res.json({ ...attestation, childAttestations });
  });

  // ─── Git Backfill: bulk ────────────────────────────
  app.post("/api/attestations/backfill-git", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;

    const dbUser = await storage.getUser(userId);
    if (!dbUser?.githubToken) {
      return res.status(400).json({ message: "No GitHub token. Connect GitHub first." });
    }

    const userRepos = await storage.getRepositories(userId);
    if (userRepos.length === 0) {
      return res.status(400).json({ message: "No repositories connected. Add a repository first." });
    }

    const { repositoryId, fullName } = req.body as { repositoryId?: number; fullName?: string };
    let targetRepo = userRepos[0];
    if (repositoryId) {
      const found = userRepos.find((r) => r.id === repositoryId);
      if (!found) return res.status(400).json({ message: "Repository not found or not owned by you." });
      targetRepo = found;
    } else if (fullName) {
      const found = userRepos.find((r) => r.fullName === fullName);
      if (!found) return res.status(400).json({ message: "Repository not found or not owned by you." });
      targetRepo = found;
    }
    const parts = targetRepo.fullName.split("/");
    if (parts.length !== 2) {
      return res.status(400).json({ message: "Invalid repository name format." });
    }

    const [owner, repoName] = parts;
    const defaultBranch = targetRepo.defaultBranch || "main";

    const attestations = await storage.getAttestations(userId);
    const pending = attestations.filter((a) => !a.gitCommitUrl && a.userId === userId);

    let succeeded = 0;
    let failed = 0;

    for (const attestation of pending) {
      if (attestation.userId !== userId) continue;

      const receiptJson = JSON.stringify({
        receipt_version: attestation.receiptVersion,
        id: attestation.id,
        timestamp: attestation.createdAt,
        file_name: attestation.fileName,
        file_path: attestation.filePath,
        file_hash: attestation.fileHash,
        model_name: attestation.modelName,
        model_provider: attestation.modelProvider,
        country_of_origin: attestation.countryOfOrigin,
        compliance_status: attestation.complianceStatus,
        signature: attestation.signature,
        public_key: attestation.publicKey,
        entry_hash: attestation.entryHash,
        prev_entry_hash: attestation.prevEntryHash,
        signed_at: attestation.signedAt,
        metadata: attestation.metadata,
      }, null, 2);

      try {
        const gitCommitUrl = await commitAttestationToGit(
          dbUser.githubToken,
          owner,
          repoName,
          defaultBranch,
          attestation.entryHash,
          receiptJson,
          attestation.modelProvider,
          attestation.modelName
        );
        await storage.updateAttestationGitCommitUrl(attestation.id, gitCommitUrl);
        succeeded++;
      } catch (err) {
        console.error(`[forgeproof] backfill git commit failed for attestation ${attestation.id}:`, err);
        failed++;
      }
    }

    res.json({ total: pending.length, succeeded, failed });
  });

  // ─── Git Backfill: single attestation ─────────────
  app.post("/api/attestations/:id/git-commit", isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });

    const user = req.user as any;
    const userId = user.claims?.sub || user.id;

    const attestation = await storage.getAttestation(id);
    if (!attestation) return res.status(404).json({ message: "Not found" });
    if (attestation.userId !== userId) return res.status(403).json({ message: "Forbidden" });

    if (attestation.gitCommitUrl) {
      return res.status(409).json({ message: "Already committed to git.", gitCommitUrl: attestation.gitCommitUrl });
    }

    const dbUser = await storage.getUser(userId);
    if (!dbUser?.githubToken) {
      return res.status(400).json({ message: "No GitHub token. Connect GitHub first." });
    }

    const userRepos = await storage.getRepositories(userId);
    if (userRepos.length === 0) {
      return res.status(400).json({ message: "No repositories connected. Add a repository first." });
    }

    const { repositoryId, fullName: bodyFullName } = req.body as { repositoryId?: number; fullName?: string };
    let targetRepo = userRepos[0];
    if (repositoryId) {
      const found = userRepos.find((r) => r.id === repositoryId);
      if (!found) return res.status(400).json({ message: "Repository not found or not owned by you." });
      targetRepo = found;
    } else if (bodyFullName) {
      const found = userRepos.find((r) => r.fullName === bodyFullName);
      if (!found) return res.status(400).json({ message: "Repository not found or not owned by you." });
      targetRepo = found;
    }
    const parts = targetRepo.fullName.split("/");
    if (parts.length !== 2) {
      return res.status(400).json({ message: "Invalid repository name format." });
    }

    const [owner, repoName] = parts;
    const defaultBranch = targetRepo.defaultBranch || "main";

    const receiptJson = JSON.stringify({
      receipt_version: attestation.receiptVersion,
      id: attestation.id,
      timestamp: attestation.createdAt,
      file_name: attestation.fileName,
      file_path: attestation.filePath,
      file_hash: attestation.fileHash,
      model_name: attestation.modelName,
      model_provider: attestation.modelProvider,
      country_of_origin: attestation.countryOfOrigin,
      compliance_status: attestation.complianceStatus,
      signature: attestation.signature,
      public_key: attestation.publicKey,
      entry_hash: attestation.entryHash,
      prev_entry_hash: attestation.prevEntryHash,
      signed_at: attestation.signedAt,
      metadata: attestation.metadata,
    }, null, 2);

    try {
      const gitCommitUrl = await commitAttestationToGit(
        dbUser.githubToken,
        owner,
        repoName,
        defaultBranch,
        attestation.entryHash,
        receiptJson,
        attestation.modelProvider,
        attestation.modelName
      );
      await storage.updateAttestationGitCommitUrl(id, gitCommitUrl);
      res.json({ gitCommitUrl });
    } catch (err: any) {
      res.status(502).json({ message: `Git commit failed: ${err.message}` });
    }
  });

  // ─── GitHub Repositories ──────────────────────────
  app.get("/api/repositories", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const repos = await storage.getRepositories(userId);
    res.json(repos);
  });

  app.post("/api/repositories/sync", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as any;
      const userId = user.claims?.sub || user.id;
      const githubRepos = await fetchUserRepos();

      let synced = 0;
      for (const repo of githubRepos) {
        const existing = await storage.getRepositoryByGithubId(repo.githubId, userId);
        if (existing) {
          await storage.updateRepository(existing.id, {
            name: repo.name,
            fullName: repo.fullName,
            url: repo.url,
            defaultBranch: repo.defaultBranch,
            description: repo.description,
          });
        } else {
          const created = await storage.createRepository({
            userId,
            githubId: repo.githubId,
            name: repo.name,
            fullName: repo.fullName,
            url: repo.url,
            defaultBranch: repo.defaultBranch,
            description: repo.description,
          });
          await storage.createAuditLog({ userId, action: "repository.created", resourceType: "repository", resourceId: String(created.id) });
        }
        synced++;
      }

      res.json({ message: `Synced ${synced} repositories from GitHub`, count: synced });
    } catch (error: any) {
      console.error("GitHub sync error:", error);
      res.status(500).json({ message: error.message || "Failed to sync repositories from GitHub" });
    }
  });

  app.get("/api/repositories/:id/files", isAuthenticated, async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const user = req.user as any;
      const userId = user.claims?.sub || user.id;
      const repo = await storage.getRepository(id);
      if (!repo) return res.status(404).json({ message: "Repository not found" });
      if (repo.userId !== userId) return res.status(403).json({ message: "Forbidden" });

      const [owner, name] = repo.fullName.split("/");
      const files = await fetchRepoFiles(owner, name, repo.defaultBranch || "main");
      res.json(files);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch repository files" });
    }
  });

  app.post("/api/repositories/:id/attest", isAuthenticated, async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const user = req.user as any;
      const userId = user.claims?.sub || user.id;
      const repo = await storage.getRepository(id);
      if (!repo) return res.status(404).json({ message: "Repository not found" });
      if (repo.userId !== userId) return res.status(403).json({ message: "Forbidden" });

      const { files, model_name, model_provider, country_of_origin } = req.body;
      if (!files || !Array.isArray(files) || !model_name || !model_provider || !country_of_origin) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const [owner, name] = repo.fullName.split("/");
      const detectedCountry = detectCountryFromRequest(req);
      const receipts = [];

      for (const file of files) {
        const filePath = file.file_path || file.path;
        const fileName = filePath.split("/").pop() || "unknown";

        let fileHash = file.file_hash;
        if (!fileHash) {
          try {
            const content = await fetchFileContent(owner, name, filePath, repo.defaultBranch || "main");
            fileHash = sha256(content.content);
          } catch {
            continue;
          }
        }

        const receipt = await createAttestationReceipt(
          userId,
          { file_path: `${repo.fullName}/${filePath}`, file_hash: fileHash, file_name: fileName, model_name, model_provider, country_of_origin },
          detectedCountry,
          repo.id
        );
        receipts.push(receipt);
      }

      await storage.updateRepositoryLastSynced(repo.id);
      res.status(201).json({ receipts, count: receipts.length });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to attest files" });
    }
  });

  app.post("/api/repositories", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as any;
      const userId = user.claims?.sub || user.id;
      const { githubId, name, fullName, url, defaultBranch, description } = req.body;
      if (!name || !fullName || !url) {
        return res.status(400).json({ message: "name, fullName, and url are required" });
      }
      const existing = githubId ? await storage.getRepositoryByGithubId(githubId, userId) : null;
      if (existing) return res.status(409).json({ message: "Repository already added" });
      const repo = await storage.createRepository({
        userId,
        githubId: githubId || 0,
        name,
        fullName,
        url,
        defaultBranch: defaultBranch || "main",
        description: description || null,
      });
      await storage.createAuditLog({ userId, action: "repository.created", resourceType: "repository", resourceId: String(repo.id) });
      res.json(repo);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to add repository" });
    }
  });

  app.delete("/api/repositories/:id", isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const repo = await storage.getRepository(id);
    if (!repo) return res.status(404).json({ message: "Not found" });
    if (repo.userId !== userId) return res.status(403).json({ message: "Forbidden" });
    await storage.deleteRepository(id);
    await storage.createAuditLog({ userId, action: "repository.deleted", resourceType: "repository", resourceId: String(req.params.id) });
    res.json({ message: "Repository removed" });
  });

  // ─── GitHub OAuth ──────────────────────────────────
  const oauthStates = new Map<string, number>();

  app.get("/api/github/connect", isAuthenticated, (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return res.status(503).json({ message: "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." });
    }
    const redirectUri = `${req.protocol}://${req.get('host')}/api/github/callback`;
    const scope = "repo read:user";
    const cryptoMod = require("crypto");
    const state = cryptoMod.randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now());
    // Clean up old states (older than 10 minutes)
    oauthStates.forEach((ts, key) => {
      if (Date.now() - ts > 600000) oauthStates.delete(key);
    });
    const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`;
    res.json({ url });
  });

  app.get("/api/github/callback", async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.redirect("/dashboard?github=error");

    if (!state || !oauthStates.has(state as string)) {
      return res.redirect("/dashboard?github=error&reason=invalid_state");
    }
    oauthStates.delete(state as string);

    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      const tokenData = await tokenRes.json() as any;

      if (tokenData.access_token) {
        const ghUserRes = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/json" },
        });
        const githubUser = await ghUserRes.json() as any;

        if (req.isAuthenticated && req.isAuthenticated()) {
          const userId = (req.user as any)?.claims?.sub || (req.user as any)?.id;
          if (userId) {
            await storage.updateUser(userId, { githubToken: tokenData.access_token, githubUsername: githubUser.login });
          }
        }
        res.redirect("/dashboard?github=connected");
      } else {
        res.redirect("/dashboard?github=error");
      }
    } catch {
      res.redirect("/dashboard?github=error");
    }
  });

  app.get("/api/github/status", isAuthenticated, async (req, res) => {
    const configured = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const dbUser = userId ? await storage.getUser(userId) : null;
    const connected = !!(dbUser?.githubToken);
    const githubUsername = dbUser?.githubUsername || null;
    res.json({ configured, connected, githubUsername });
  });

  app.get("/api/github/repos", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const dbUser = userId ? await storage.getUser(userId) : null;
    if (!dbUser?.githubToken) {
      return res.status(400).json({ message: "GitHub not connected" });
    }
    try {
      const ghRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
        headers: { Authorization: `Bearer ${dbUser.githubToken}`, Accept: "application/json" },
      });
      if (!ghRes.ok) return res.status(502).json({ message: "Failed to fetch GitHub repos" });
      const repos = await ghRes.json() as any[];
      res.json(repos.map((r: any) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        url: r.html_url,
        description: r.description,
        default_branch: r.default_branch,
        private: r.private,
      })));
    } catch {
      res.status(502).json({ message: "Failed to fetch GitHub repos" });
    }
  });

  // ─── GitHub Webhook ──────────────────────────────────
  app.post("/api/github/webhook", agentApiLimiter, async (req, res) => {
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (webhookSecret) {
      const sigHeader = req.headers["x-hub-signature-256"] as string;
      if (!sigHeader) return res.status(401).json({ message: "Missing X-Hub-Signature-256 header" });
      const crypto = await import("crypto");
      const expectedSig = "sha256=" + crypto.createHmac("sha256", webhookSecret)
        .update(JSON.stringify(req.body))
        .digest("hex");
      if (sigHeader !== expectedSig) return res.status(401).json({ message: "Invalid webhook signature" });
    }

    const event = req.headers["x-github-event"] as string;
    if (!event) return res.status(400).json({ message: "Missing X-GitHub-Event header" });

    if (event === "push") {
      const payload = req.body;
      const repoName = payload?.repository?.full_name;
      const commits = payload?.commits || [];
      const results: any[] = [];

      for (const commit of commits.slice(0, 10)) {
        for (const file of [...(commit.added || []), ...(commit.modified || [])].slice(0, 20)) {
          const fileHash = sha256(`${repoName}:${file}:${commit.id}`);
          const latestAttestation = await storage.getLatestAttestation();
          const prevEntryHash = latestAttestation?.entryHash || null;
          const timestamp = new Date().toISOString();
          const entryHash = computeEntryHash({
            fileHash,
            modelName: "github-push",
            modelProvider: "github",
            countryOfOrigin: "unknown",
            prevEntryHash: prevEntryHash,
            timestamp,
          });
          const signaturePayload = `${entryHash}|${fileHash}|${timestamp}`;
          const keyPair = getKeyPair();
          const signature = signData(signaturePayload);

          const receipt = await storage.createAttestation({
            fileName: file.split("/").pop() || file,
            filePath: file,
            fileHash,
            entryHash,
            prevEntryHash,
            modelName: "github-push",
            modelProvider: "github",
            countryOfOrigin: "unknown",
            complianceStatus: "unverified",
            detectedCountry: null,
            signature,
            publicKey: keyPair.publicKey,
            receiptVersion: "v1",
            signedAt: timestamp,
            userId: "webhook",
            metadata: { commitSha: commit.id, commitMessage: commit.message, author: commit.author?.name },
          });
          results.push({ file, receiptId: receipt.id });
        }
      }

      return res.json({ event: "push", repo: repoName, receipts: results.length, results });
    }

    res.json({ event, status: "ignored" });
  });

  // ─── Billing ──────────────────────────────────────
  app.get("/api/billing/subscription", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const subscription = await storage.getOrCreateFreeSubscription(userId);
    res.json(subscription);
  });

  app.post("/api/billing/checkout", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as any;
      const userId = user.claims?.sub || user.id;
      const email = user.claims?.email || user.email || null;
      const { plan } = req.body;
      if (plan !== "pro" && plan !== "enterprise") {
        return res.status(400).json({ message: "Invalid plan. Choose 'pro' or 'enterprise'." });
      }
      const { createCheckoutSession } = await import("./stripe");
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const url = await createCheckoutSession(userId, email, plan, baseUrl);
      if (!url) return res.status(503).json({ message: "Billing is not yet configured. Please try again later." });
      res.json({ url });
    } catch (error: any) {
      console.error("Checkout error:", error);
      res.status(500).json({ message: "Failed to create checkout session" });
    }
  });

  app.post("/api/billing/portal", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as any;
      const userId = user.claims?.sub || user.id;
      const { createPortalSession } = await import("./stripe");
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const url = await createPortalSession(userId, baseUrl);
      if (!url) return res.status(400).json({ message: "No billing account found. Subscribe to a plan first." });
      res.json({ url });
    } catch (error: any) {
      console.error("Portal error:", error);
      res.status(500).json({ message: "Failed to open billing portal" });
    }
  });

  // ─── API Keys ─────────────────────────────────────
  app.get("/api/api-keys", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const keys = await storage.getApiKeys(userId);
    const safeKeys = keys.map(({ keyHash, ...rest }) => rest);
    res.json(safeKeys);
  });

  app.post("/api/api-keys", isAuthenticated, async (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ message: "Name is required" });
    }
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;

    const subscription = await storage.getOrCreateFreeSubscription(userId);
    if (subscription.apiKeyLimit !== -1) {
      const existingKeys = await storage.getApiKeys(userId);
      if (existingKeys.length >= subscription.apiKeyLimit) {
        return res.status(402).json({
          message: `API key limit reached (${subscription.apiKeyLimit} on the ${subscription.plan} plan). Upgrade your plan to create more keys.`,
        });
      }
    }

    const { fullKey, keyHash, keyPrefix } = generateApiKey();
    const apiKey = await storage.createApiKey({
      userId,
      name,
      keyHash,
      keyPrefix,
    });
    await storage.createAuditLog({ userId, action: "api_key.created", resourceType: "api_key", resourceId: String(apiKey.id) });
    res.json({ ...apiKey, fullKey });
  });

  app.delete("/api/api-keys/:id", isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    await storage.deleteApiKey(id, userId);
    await storage.createAuditLog({ userId, action: "api_key.deleted", resourceType: "api_key", resourceId: String(req.params.id) });
    res.json({ message: "Deleted" });
  });

  // ─── Organizations ──────────────────────────────────
  app.get("/api/organizations", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const orgs = await storage.getOrganizations(userId);
    res.json(orgs);
  });

  app.post("/api/organizations", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ message: "Name is required" });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const existing = await storage.getOrganizationBySlug(slug);
    if (existing) return res.status(409).json({ message: "Organization slug already taken" });
    const org = await storage.createOrganization({ name, slug, ownerId: userId, description: description || null });
    await storage.addOrgMember({ orgId: org.id, userId, role: "owner" });
    await storage.createAuditLog({ userId, action: "org.created", resourceType: "organization", resourceId: String(org.id), metadata: { name } });
    res.json(org);
  });

  app.get("/api/organizations/:id/members", isAuthenticated, async (req, res) => {
    const orgId = parseInt(req.params.id as string);
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const member = await storage.getOrgMember(orgId, userId);
    if (!member) return res.status(403).json({ message: "Not a member of this organization" });
    const members = await storage.getOrgMembers(orgId);
    res.json(members);
  });

  app.post("/api/organizations/:id/members", isAuthenticated, async (req, res) => {
    const orgId = parseInt(req.params.id as string);
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const member = await storage.getOrgMember(orgId, userId);
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return res.status(403).json({ message: "Only owners and admins can add members" });
    }
    const { userId: newUserId, role } = req.body;
    if (!newUserId) return res.status(400).json({ message: "userId is required" });
    const existing = await storage.getOrgMember(orgId, newUserId);
    if (existing) return res.status(409).json({ message: "User is already a member" });
    const newMember = await storage.addOrgMember({ orgId, userId: newUserId, role: role || "member" });
    await storage.createAuditLog({ userId, action: "org.member_added", resourceType: "organization", resourceId: String(orgId), metadata: { addedUserId: newUserId, role: role || "member" } });
    res.json(newMember);
  });

  app.delete("/api/organizations/:id", isAuthenticated, async (req, res) => {
    const orgId = parseInt(req.params.id as string);
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const org = await storage.getOrganization(orgId);
    if (!org || org.ownerId !== userId) return res.status(403).json({ message: "Only the owner can delete this organization" });
    await storage.deleteOrganization(orgId);
    await storage.createAuditLog({ userId, action: "org.deleted", resourceType: "organization", resourceId: String(orgId) });
    res.json({ message: "Organization deleted" });
  });

  // ─── Audit Logs ──────────────────────────────────
  app.get("/api/audit-logs", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const logs = await storage.getAuditLogs(userId, limit);
    res.json(logs);
  });

  // ─── Notification Preferences ──────────────────────
  app.get("/api/notifications/preferences", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const dbUser = await storage.getUser(userId);
    res.json({ notificationEmail: dbUser?.notificationEmail || null });
  });

  app.post("/api/notifications/preferences", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const { notificationEmail } = req.body;
    await storage.updateUser(userId, { notificationEmail: notificationEmail || null });
    await storage.createAuditLog({ userId, action: "notifications.updated", resourceType: "user", resourceId: userId });
    res.json({ notificationEmail });
  });

  // ─── User Preferences ──────────────────────────────
  app.get("/api/preferences", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const dbUser = await storage.getUser(userId);
    res.json({ defaultRepoId: dbUser?.defaultRepoId || null });
  });

  app.patch("/api/preferences", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user?.claims?.sub || user?.id;
    const { defaultRepoId } = req.body;
    await storage.updateUser(userId, { defaultRepoId: defaultRepoId || null });
    res.json({ defaultRepoId: defaultRepoId || null });
  });

  // ─── Public Demo ──────────────────────────────────
  app.get("/api/demo/attestations", demoLimiter, async (_req, res) => {
    try {
      let attestations = await storage.getSystemAttestations();
      if (attestations.length === 0) {
        try {
          const { seedDatabase } = await import("./seed");
          await seedDatabase();
          attestations = await storage.getSystemAttestations();
        } catch (seedErr) {
          console.error("Auto-seed on empty demo failed:", seedErr);
          return res.status(503).json({ message: "Demo data is temporarily unavailable. Please try again shortly." });
        }
      }
      res.json(attestations);
    } catch (err) {
      console.error("Failed to fetch demo attestations:", err);
      res.status(503).json({ message: "Demo data is temporarily unavailable. Please try again shortly." });
    }
  });

  app.get("/api/demo/attestations/:id", demoLimiter, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const attestation = await storage.getAttestation(id);
    if (!attestation) return res.status(404).json({ message: "Not found" });
    if (attestation.userId !== "forgeproof-system") {
      return res.status(403).json({ message: "Only system attestations are publicly accessible" });
    }
    const childAttestations = await storage.getAttestationsByParentId(id);
    res.json({ ...attestation, childAttestations });
  });

  // ─── Public Attestation API (generic) ─────────────
  app.post("/api/v1/attest", publicApiLimiter, async (req, res) => {
    let userId: string | null = null;

    userId = await authenticateApiKey(req);
    if (!userId && req.isAuthenticated()) {
      const user = req.user as any;
      userId = user.claims?.sub || user.id;
    }
    if (!userId) {
      return res.status(401).json({ message: "Authentication required. Provide a Bearer API key or session." });
    }

    const parsed = attestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", errors: parsed.error.issues });
    }

    const data = parsed.data;
    const attestationType = data.attestation_type || "origin";

    if (attestationType !== "origin") {
      if (!data.parent_attestation_id) {
        return res.status(400).json({ message: "parentAttestationId is required for non-origin attestation types" });
      }
      const parentAttestation = await storage.getAttestation(data.parent_attestation_id);
      if (!parentAttestation) {
        return res.status(400).json({ message: "Parent attestation not found" });
      }
      if (attestationType === "security_audit" && parentAttestation.modelProvider === data.model_provider) {
        return res.status(400).json({ message: "Security audit attestations must use a different model provider than the origin. The model that writes code cannot audit its own output." });
      }
    }

    if (attestationType === "security_audit" && !data.audit_verdict) {
      return res.status(400).json({ message: "auditVerdict is required for security_audit attestation type" });
    }

    const detectedCountry = detectCountryFromRequest(req);
    try {
      const receipt = await createAttestationReceipt(userId, data, detectedCountry);

      let gitCommitUrl: string | null = null;
      try {
        const dbUser = await storage.getUser(userId!);
        if (dbUser?.githubToken) {
          const userRepos = await storage.getRepositories(userId!);
          if (userRepos.length > 0) {
            const targetRepo = (data.repository
              ? userRepos.find(r => r.fullName === data.repository)
              : null) ?? userRepos[0];

            const parts = targetRepo.fullName.split("/");
            if (parts.length === 2) {
              const owner = parts[0];
              const repoName = parts[1];
              const defaultBranch = targetRepo.defaultBranch || "main";

              const receiptJson = JSON.stringify({
                receipt_version: receipt.receiptVersion,
                id: receipt.id,
                timestamp: receipt.createdAt,
                file_name: receipt.fileName,
                file_path: receipt.filePath,
                file_hash: receipt.fileHash,
                model_name: receipt.modelName,
                model_provider: receipt.modelProvider,
                country_of_origin: receipt.countryOfOrigin,
                compliance_status: receipt.complianceStatus,
                signature: receipt.signature,
                public_key: receipt.publicKey,
                entry_hash: receipt.entryHash,
                prev_entry_hash: receipt.prevEntryHash,
                signed_at: receipt.signedAt,
                metadata: receipt.metadata,
              }, null, 2);

              const timeout = new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), 5000)
              );
              const commitResult = await Promise.race([
                commitAttestationToGit(
                  dbUser.githubToken,
                  owner,
                  repoName,
                  defaultBranch,
                  receipt.entryHash,
                  receiptJson,
                  receipt.modelProvider,
                  receipt.modelName
                ),
                timeout,
              ]);

              if (commitResult) {
                gitCommitUrl = commitResult;
                await storage.updateAttestationGitCommitUrl(receipt.id, gitCommitUrl);
              }
            }
          }
        }
      } catch (gitErr: any) {
        console.error("[forgeproof] git commit failed (non-blocking):", gitErr);
        const errorMessage = gitErr?.message ?? String(gitErr);
        try {
          await storage.createAuditLog({
            userId,
            action: "attestation.git_commit_failed",
            resourceType: "attestation",
            resourceId: String(receipt.id),
            metadata: {
              errorMessage,
              receiptId: receipt.id,
              entryHash: receipt.entryHash,
            },
            ipAddress: req.ip ?? null,
          });
        } catch (auditErr) {
          console.error("[forgeproof] failed to write git_commit_failed audit log:", auditErr);
        }
        try {
          const failedUser = userId ? await storage.getUser(userId) : null;
          const notifEmail = failedUser?.notificationEmail;
          if (notifEmail) {
            const baseUrl = `${req.protocol}://${req.get("host")}`;
            await sendGitCommitFailureEmail({
              to: notifEmail,
              receiptId: receipt.id,
              entryHash: receipt.entryHash,
              errorMessage,
              baseUrl,
            });
          }
        } catch (emailErr) {
          console.error("[forgeproof] failed to send git_commit_failed email:", emailErr);
        }
      }

      res.status(201).json({ ...receipt, gitCommitUrl });
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message || "Failed to create attestation" });
    }
  });

  // ─── Attestation Chain ──────────────────────────────
  app.get("/api/v1/attestation/:id/chain", async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });

    const attestation = await storage.getAttestation(id);
    if (!attestation) return res.status(404).json({ message: "Attestation not found" });

    let root = attestation;
    while (root.parentAttestationId) {
      const parent = await storage.getAttestation(root.parentAttestationId);
      if (!parent) break;
      root = parent;
    }

    const chain: any[] = [root];
    const visited = new Set([root.id]);
    const queue = [root.id];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = await storage.getAttestationsByParentId(currentId);
      for (const child of children) {
        if (!visited.has(child.id)) {
          visited.add(child.id);
          chain.push(child);
          queue.push(child.id);
        }
      }
    }

    res.json({
      rootId: root.id,
      attestations: chain,
      chainLength: chain.length,
    });
  });

  // ─── AI Agent Endpoints ───────────────────────────
  app.post("/api/v1/agents/openai", agentApiLimiter, async (req, res) => {
    let userId = await authenticateApiKey(req);
    if (!userId) return res.status(401).json({ message: "Bearer API key required" });

    const parsed = agentAttestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", errors: parsed.error.issues });
    }

    const data = parsed.data;
    if (!["openai", "OpenAI"].includes(data.model_provider)) {
      data.model_provider = "OpenAI";
    }

    const detectedCountry = detectCountryFromRequest(req);
    const receipts = [];
    try {
      for (const file of data.files) {
        const receipt = await createAttestationReceipt(
          userId,
          {
            file_path: file.file_path,
            file_hash: file.file_hash,
            file_name: file.file_name,
            model_name: data.model_name,
            model_provider: data.model_provider,
            country_of_origin: data.country_of_origin,
            metadata: { ...data.metadata, agent: "openai", session_id: data.session_id },
          },
          detectedCountry
        );
        receipts.push(receipt);
      }
    } catch (error: any) {
      return res.status(error.status || 500).json({ message: error.message || "Failed to create attestation", receipts, count: receipts.length });
    }

    res.status(201).json({ receipts, agent: "openai", count: receipts.length });
  });

  app.post("/api/v1/agents/claude", agentApiLimiter, async (req, res) => {
    let userId = await authenticateApiKey(req);
    if (!userId) return res.status(401).json({ message: "Bearer API key required" });

    const parsed = agentAttestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", errors: parsed.error.issues });
    }

    const data = parsed.data;
    if (!["anthropic", "Anthropic"].includes(data.model_provider)) {
      data.model_provider = "Anthropic";
    }

    const detectedCountry = detectCountryFromRequest(req);
    const receipts = [];
    try {
      for (const file of data.files) {
        const receipt = await createAttestationReceipt(
          userId,
          {
            file_path: file.file_path,
            file_hash: file.file_hash,
            file_name: file.file_name,
            model_name: data.model_name,
            model_provider: data.model_provider,
            country_of_origin: data.country_of_origin,
            metadata: { ...data.metadata, agent: "claude", session_id: data.session_id },
          },
          detectedCountry
        );
        receipts.push(receipt);
      }
    } catch (error: any) {
      return res.status(error.status || 500).json({ message: error.message || "Failed to create attestation", receipts, count: receipts.length });
    }

    res.status(201).json({ receipts, agent: "claude", count: receipts.length });
  });

  app.post("/api/v1/agents/replit", agentApiLimiter, async (req, res) => {
    let userId = await authenticateApiKey(req);
    if (!userId) return res.status(401).json({ message: "Bearer API key required" });

    const parsed = agentAttestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", errors: parsed.error.issues });
    }

    const data = parsed.data;
    if (!["replit", "Replit"].includes(data.model_provider)) {
      data.model_provider = "Replit";
    }

    const detectedCountry = detectCountryFromRequest(req);
    const receipts = [];
    try {
      for (const file of data.files) {
        const receipt = await createAttestationReceipt(
          userId,
          {
            file_path: file.file_path,
            file_hash: file.file_hash,
            file_name: file.file_name,
            model_name: data.model_name,
            model_provider: data.model_provider,
            country_of_origin: data.country_of_origin,
            metadata: { ...data.metadata, agent: "replit", session_id: data.session_id },
          },
          detectedCountry
        );
        receipts.push(receipt);
      }
    } catch (error: any) {
      return res.status(error.status || 500).json({ message: error.message || "Failed to create attestation", receipts, count: receipts.length });
    }

    res.status(201).json({ receipts, agent: "replit", count: receipts.length });
  });

  // ─── Hash Chain Verification ──────────────────────
  app.get("/api/verify/chain", verifyLimiter, async (_req, res) => {
    const allAttestations = await storage.getAllAttestationsOrdered();
    const results = [];
    let prevHash: string | null = null;
    let allValid = true;

    for (const entry of allAttestations) {
      const expectedPrev = prevHash;
      const chainValid = entry.prevEntryHash === expectedPrev;

      const timestamp = entry.signedAt || (entry.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString());
      const recomputedHash = computeEntryHash({
        fileHash: entry.fileHash,
        modelName: entry.modelName,
        modelProvider: entry.modelProvider,
        countryOfOrigin: entry.countryOfOrigin,
        prevEntryHash: entry.prevEntryHash,
        timestamp,
      });

      const signaturePayload = `${entry.entryHash}|${entry.fileHash}|${timestamp}`;
      const signatureValid = verifySignature(signaturePayload, entry.signature, entry.publicKey);

      const entryValid = chainValid && signatureValid;
      if (!entryValid) allValid = false;

      results.push({
        id: entry.id,
        fileName: entry.fileName,
        filePath: entry.filePath,
        entryHash: entry.entryHash,
        prevEntryHash: entry.prevEntryHash,
        chainValid,
        signatureValid,
        valid: entryValid,
        complianceStatus: entry.complianceStatus,
        createdAt: entry.createdAt,
      });

      prevHash = entry.entryHash;
    }

    res.json({ chainIntegrity: allValid, entries: results, totalEntries: results.length });
  });

  app.get("/api/verify/entry/:id", verifyLimiter, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const entry = await storage.getAttestation(id);
    if (!entry) return res.status(404).json({ message: "Not found" });

    const timestamp = entry.signedAt || (entry.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString());
    const recomputedHash = computeEntryHash({
      fileHash: entry.fileHash,
      modelName: entry.modelName,
      modelProvider: entry.modelProvider,
      countryOfOrigin: entry.countryOfOrigin,
      prevEntryHash: entry.prevEntryHash,
      timestamp,
    });

    const signaturePayload = `${entry.entryHash}|${entry.fileHash}|${timestamp}`;
    const signatureValid = verifySignature(signaturePayload, entry.signature, entry.publicKey);

    let prevEntry = null;
    if (entry.prevEntryHash) {
      const prev = await storage.getAttestationByEntryHash(entry.prevEntryHash);
      if (prev) {
        prevEntry = { id: prev.id, fileName: prev.fileName, entryHash: prev.entryHash };
      }
    }

    res.json({
      id: entry.id,
      fileName: entry.fileName,
      filePath: entry.filePath,
      fileHash: entry.fileHash,
      entryHash: entry.entryHash,
      prevEntryHash: entry.prevEntryHash,
      signatureValid,
      hashMatch: recomputedHash === entry.entryHash,
      complianceStatus: entry.complianceStatus,
      detectedCountry: entry.detectedCountry,
      countryOfOrigin: entry.countryOfOrigin,
      prevEntry,
      modelName: entry.modelName,
      modelProvider: entry.modelProvider,
      createdAt: entry.createdAt,
    });
  });

  // ─── Public Receipt Lookup ──────────────────────────
  app.get("/api/lookup", verifyLimiter, async (req, res) => {
    const { q } = req.query;
    if (!q || typeof q !== "string") {
      return res.status(400).json({ message: "Query parameter 'q' is required (receipt ID or entry hash)" });
    }

    let entry: any = null;

    const idNum = parseInt(q);
    if (!isNaN(idNum)) {
      entry = await storage.getAttestation(idNum);
    }

    if (!entry) {
      entry = await storage.getAttestationByEntryHash(q);
    }

    if (!entry) {
      return res.status(404).json({ message: "No attestation found for the given ID or hash" });
    }

    const timestamp = entry.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString();
    const recomputedHash = computeEntryHash({
      fileHash: entry.fileHash,
      modelName: entry.modelName,
      modelProvider: entry.modelProvider,
      countryOfOrigin: entry.countryOfOrigin,
      prevEntryHash: entry.prevEntryHash,
      timestamp,
    });

    const signaturePayload = `${entry.entryHash}|${entry.fileHash}|${timestamp}`;
    const signatureValid = verifySignature(signaturePayload, entry.signature, entry.publicKey);

    res.json({
      id: entry.id,
      fileName: entry.fileName,
      filePath: entry.filePath,
      fileHash: entry.fileHash,
      entryHash: entry.entryHash,
      prevEntryHash: entry.prevEntryHash,
      signatureValid,
      hashMatch: recomputedHash === entry.entryHash,
      complianceStatus: entry.complianceStatus,
      detectedCountry: entry.detectedCountry,
      countryOfOrigin: entry.countryOfOrigin,
      modelName: entry.modelName,
      modelProvider: entry.modelProvider,
      signature: entry.signature,
      publicKey: entry.publicKey,
      receiptVersion: entry.receiptVersion,
      createdAt: entry.createdAt,
    });
  });

  // ─── Analytics ────────────────────────────────────
  app.get("/api/analytics", demoLimiter, async (_req, res) => {
    const all = await storage.getAllAttestationsOrdered();

    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    const byCompliance: Record<string, number> = {};
    const byDate: Record<string, number> = {};

    for (const a of all) {
      byProvider[a.modelProvider] = (byProvider[a.modelProvider] || 0) + 1;
      byModel[a.modelName] = (byModel[a.modelName] || 0) + 1;
      byCountry[a.countryOfOrigin] = (byCountry[a.countryOfOrigin] || 0) + 1;
      const status = a.complianceStatus || "unverified";
      byCompliance[status] = (byCompliance[status] || 0) + 1;
      if (a.createdAt) {
        const date = new Date(a.createdAt).toISOString().split("T")[0];
        byDate[date] = (byDate[date] || 0) + 1;
      }
    }

    res.json({
      total: all.length,
      byProvider,
      byModel,
      byCountry,
      byCompliance,
      byDate,
    });
  });

  // ─── Badge Embed ──────────────────────────────────
  app.get("/api/badge/:id.svg", demoLimiter, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).send("Invalid ID");
    const entry = await storage.getAttestation(id);
    if (!entry) return res.status(404).send("Not found");

    const statusColor = entry.complianceStatus === "verified" ? "#22c55e" : entry.complianceStatus === "mismatch" ? "#ef4444" : "#6b7280";
    const statusLabel = entry.complianceStatus === "verified" ? "Verified" : entry.complianceStatus === "mismatch" ? "Mismatch" : "Unverified";

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="20" role="img" aria-label="ForgeProof: ${statusLabel}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="280" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="160" height="20" fill="#1e3a5f"/>
    <rect x="160" width="120" height="20" fill="${statusColor}"/>
    <rect width="280" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="80" y="14">ForgeProof | ${entry.modelProvider}</text>
    <text x="220" y="14">${statusLabel}</text>
  </g>
</svg>`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  app.get("/api/badge/repo/:repoName.svg", demoLimiter, async (req, res) => {
    const repoName = decodeURIComponent(req.params.repoName as string);
    const all = await storage.getAllAttestationsOrdered();
    const repoAttestations = all.filter(a => a.filePath.startsWith(repoName) || a.filePath.includes(repoName));

    const count = repoAttestations.length;
    const providers = Array.from(new Set(repoAttestations.map(a => a.modelProvider))).join(", ");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="20" role="img" aria-label="ForgeProof: ${count} attestations">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="300" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="140" height="20" fill="#1e3a5f"/>
    <rect x="140" width="160" height="20" fill="#3b82f6"/>
    <rect width="300" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="70" y="14">ForgeProof</text>
    <text x="220" y="14">${count} attestations${providers ? " | " + providers : ""}</text>
  </g>
</svg>`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  // ─── OpenAPI Spec for GPT Actions ─────────────────
  app.get("/api/openapi.json", (_req, res) => {
    res.json({
      openapi: "3.1.0",
      info: {
        title: "ForgeProof Attestation API",
        description: "Code provenance attestation platform. Create cryptographic attestation receipts for AI-generated code.",
        version: "1.0.0",
      },
      servers: [{ url: "/" }],
      paths: {
        "/api/v1/attest": {
          post: {
            operationId: "createAttestation",
            summary: "Create a code attestation receipt",
            description: "Create a cryptographically signed attestation receipt for a file. Requires API key authentication.",
            security: [{ bearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["file_path", "file_hash", "model_name", "model_provider", "country_of_origin"],
                    properties: {
                      file_path: { type: "string", description: "Path to the file being attested" },
                      file_hash: { type: "string", description: "SHA-256 hash of the file content" },
                      model_name: { type: "string", description: "Name of the AI model (e.g. gpt-4-turbo, claude-sonnet-4-20250514)" },
                      model_provider: { type: "string", description: "Provider name (e.g. OpenAI, Anthropic, Replit)" },
                      country_of_origin: { type: "string", description: "ISO country code where the code was generated" },
                      repository: { type: "string", description: "Repository name (optional)" },
                      metadata: { type: "object", description: "Additional metadata (optional)" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": { description: "Attestation receipt created successfully" },
              "401": { description: "Authentication required" },
              "400": { description: "Invalid request body" },
            },
          },
        },
        "/api/lookup": {
          get: {
            operationId: "lookupReceipt",
            summary: "Look up an attestation receipt",
            description: "Look up and verify an attestation receipt by ID or entry hash.",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Receipt ID or entry hash" },
            ],
            responses: {
              "200": { description: "Attestation receipt found and verified" },
              "404": { description: "No attestation found" },
            },
          },
        },
        "/api/verify/chain": {
          get: {
            operationId: "verifyChain",
            summary: "Verify the entire hash chain",
            description: "Verify the integrity of the entire attestation hash chain.",
            responses: {
              "200": { description: "Chain verification result" },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", description: "ForgeProof API key (fp_sk_...)" },
        },
      },
    });
  });

  // ─── MCP Tool Server ────────────────────────────────
  app.get("/api/mcp/manifest", demoLimiter, (_req, res) => {
    res.json(getMcpManifest());
  });

  app.post("/api/mcp/tools", agentApiLimiter, async (req, res) => {
    let userId = await authenticateApiKey(req);
    if (!userId) {
      return res.status(401).json({ message: "Bearer API key required for MCP tool execution" });
    }

    const { tool, arguments: args } = req.body;
    if (!tool || typeof tool !== "string") {
      return res.status(400).json({ message: "Missing 'tool' field" });
    }

    try {
      const result = await handleMcpTool(tool, args || {}, userId);
      res.json({ tool, result });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Tool execution failed" });
    }
  });

  // ─── Receipt Export (HTML for print/PDF) ────────────
  app.get("/api/receipt/:id/export", demoLimiter, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).send("Invalid ID");
    const entry = await storage.getAttestation(id);
    if (!entry) return res.status(404).send("Not found");

    const isSystemData = entry.userId === "system" || entry.userId === "forgeproof-system" || entry.userId === "webhook";
    if (!isSystemData) {
      if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).send("Authentication required for non-public receipts");
      }
      const user = req.user as any;
      const userId = user?.claims?.sub || user?.id;
      if (entry.userId !== userId) {
        return res.status(403).send("Access denied");
      }
    }

    const timestamp = entry.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString();
    const recomputedHash = computeEntryHash({
      fileHash: entry.fileHash,
      modelName: entry.modelName,
      modelProvider: entry.modelProvider,
      countryOfOrigin: entry.countryOfOrigin,
      prevEntryHash: entry.prevEntryHash,
      timestamp,
    });

    const signaturePayload = `${entry.entryHash}|${entry.fileHash}|${timestamp}`;
    const signatureValid = verifySignature(signaturePayload, entry.signature, entry.publicKey);
    const hashMatch = recomputedHash === entry.entryHash;

    const statusEmoji = entry.complianceStatus === "verified" ? "&#x2705;" : entry.complianceStatus === "mismatch" ? "&#x274C;" : "&#x2753;";
    const sigEmoji = signatureValid ? "&#x2705;" : "&#x274C;";
    const hashEmoji = hashMatch ? "&#x2705;" : "&#x274C;";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ForgeProof Attestation Certificate #${entry.id}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #f8fafc; color: #1e293b; padding: 40px; }
    .certificate { max-width: 700px; margin: 0 auto; background: white; border: 2px solid #1e3a5f; border-radius: 12px; padding: 48px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { text-align: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 24px; margin-bottom: 32px; }
    .logo-text { font-size: 28px; font-weight: 700; color: #1e3a5f; letter-spacing: -0.5px; }
    .subtitle { font-size: 14px; color: #64748b; margin-top: 4px; }
    .cert-id { font-size: 12px; color: #94a3b8; margin-top: 8px; font-family: 'JetBrains Mono', monospace; }
    .section { margin-bottom: 24px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 8px; font-weight: 600; }
    .field { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9; }
    .field-label { font-size: 13px; color: #64748b; }
    .field-value { font-size: 13px; font-weight: 500; text-align: right; max-width: 400px; word-break: break-all; }
    .hash { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #475569; }
    .status-row { display: flex; gap: 16px; justify-content: center; margin: 24px 0; }
    .status-badge { padding: 8px 16px; border-radius: 8px; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .verified { background: #dcfce7; color: #166534; }
    .failed { background: #fee2e2; color: #991b1b; }
    .pending { background: #f1f5f9; color: #475569; }
    .footer { text-align: center; margin-top: 32px; padding-top: 24px; border-top: 2px solid #e2e8f0; }
    .footer-text { font-size: 11px; color: #94a3b8; }
    .sig-block { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-top: 16px; }
    .sig-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; margin-bottom: 4px; }
    .sig-value { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #475569; word-break: break-all; line-height: 1.5; }
    @media print { body { padding: 0; background: white; } .certificate { box-shadow: none; border: 1px solid #ccc; } }
  </style>
</head>
<body>
  <div class="certificate">
    <div class="header">
      <div class="logo-text">ForgeProof</div>
      <div class="subtitle">Code Provenance Attestation Certificate</div>
      <div class="cert-id">Receipt #${entry.id} &middot; Version ${entry.receiptVersion || 'v1'}</div>
    </div>

    <div class="status-row">
      <div class="status-badge ${signatureValid ? 'verified' : 'failed'}">${sigEmoji} Signature ${signatureValid ? 'Valid' : 'Invalid'}</div>
      <div class="status-badge ${hashMatch ? 'verified' : 'failed'}">${hashEmoji} Hash ${hashMatch ? 'Verified' : 'Mismatch'}</div>
      <div class="status-badge ${entry.complianceStatus === 'verified' ? 'verified' : entry.complianceStatus === 'mismatch' ? 'failed' : 'pending'}">${statusEmoji} Geo ${entry.complianceStatus || 'Unverified'}</div>
    </div>

    <div class="section">
      <div class="section-title">File Information</div>
      <div class="field"><span class="field-label">File Name</span><span class="field-value">${entry.fileName}</span></div>
      <div class="field"><span class="field-label">File Path</span><span class="field-value">${entry.filePath}</span></div>
      <div class="field"><span class="field-label">File Hash</span><span class="field-value hash">${entry.fileHash}</span></div>
    </div>

    <div class="section">
      <div class="section-title">AI Model Information</div>
      <div class="field"><span class="field-label">Model Name</span><span class="field-value">${entry.modelName}</span></div>
      <div class="field"><span class="field-label">Model Provider</span><span class="field-value">${entry.modelProvider}</span></div>
    </div>

    <div class="section">
      <div class="section-title">Geographic Compliance</div>
      <div class="field"><span class="field-label">Declared Country</span><span class="field-value">${entry.countryOfOrigin}</span></div>
      <div class="field"><span class="field-label">Detected Country</span><span class="field-value">${entry.detectedCountry || 'Not detected'}</span></div>
      <div class="field"><span class="field-label">Compliance Status</span><span class="field-value">${(entry.complianceStatus || 'unverified').charAt(0).toUpperCase() + (entry.complianceStatus || 'unverified').slice(1)}</span></div>
    </div>

    <div class="section">
      <div class="section-title">Hash Chain</div>
      <div class="field"><span class="field-label">Entry Hash</span><span class="field-value hash">${entry.entryHash}</span></div>
      <div class="field"><span class="field-label">Previous Hash</span><span class="field-value hash">${entry.prevEntryHash || 'Genesis (first entry)'}</span></div>
      <div class="field"><span class="field-label">Timestamp</span><span class="field-value">${timestamp}</span></div>
    </div>

    <div class="sig-block">
      <div class="sig-label">Ed25519 Digital Signature</div>
      <div class="sig-value">${entry.signature}</div>
    </div>
    <div class="sig-block" style="margin-top: 8px;">
      <div class="sig-label">Public Key</div>
      <div class="sig-value">${entry.publicKey}</div>
    </div>

    <div class="footer">
      <div class="footer-text">This attestation was cryptographically signed using Ed25519 and is part of a SHA-256 hash chain.</div>
      <div class="footer-text" style="margin-top: 4px;">Verify at: /lookup?q=${entry.id}</div>
    </div>
  </div>
</body>
</html>`;
  
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  // Commit URL health check — verifies seed gitCommitUrls are still reachable
  app.get("/api/admin/commit-health", async (_req, res) => {
    try {
      const { checkSeedCommitUrls } = await import("./commitHealthCheck");
      const report = await checkSeedCommitUrls();
      const statusCode = report.broken > 0 ? 207 : 200;
      res.status(statusCode).json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // For demo purposes, we allow clearing and re-seeding via a special internal-only endpoint
  app.post("/api/admin/reseed", async (req, res) => {
    try {
      await storage.clearAllAttestations();
      const { seedDatabase } = await import("./seed");
      await seedDatabase();
      res.json({ message: "Database re-seeded successfully" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}
