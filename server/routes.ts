import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replit_integrations/auth/replitAuth";
import { sha256, signData, getKeyPair, computeEntryHash, generateApiKey, verifySignature } from "./crypto";
import { fetchUserRepos, fetchRepoFiles, fetchFileContent, fetchRepoCommits, fetchCommitFiles } from "./github";
import { z } from "zod";
import { getMcpManifest, handleMcpTool } from "./mcp";

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

async function createAttestationReceipt(
  userId: string,
  data: { file_path: string; file_hash: string; file_name?: string; model_name: string; model_provider: string; country_of_origin: string; metadata?: any },
  detectedCountry: string | null,
  repositoryId?: number
) {
  const fileName = data.file_name || data.file_path.split("/").pop() || "unknown";
  const timestamp = new Date().toISOString();
  const latest = await storage.getLatestAttestation();
  const prevEntryHash = latest?.entryHash || null;

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
  const { publicKey } = getKeyPair();
  const complianceStatus = computeComplianceStatus(data.country_of_origin, detectedCountry);

  return storage.createAttestation({
    userId,
    repositoryId: repositoryId || null,
    fileHash: data.file_hash,
    fileName,
    filePath: data.file_path,
    modelName: data.model_name,
    modelProvider: data.model_provider,
    countryOfOrigin: data.country_of_origin,
    detectedCountry,
    complianceStatus,
    signature,
    publicKey,
    prevEntryHash,
    entryHash,
    receiptVersion: "v1",
    metadata: data.metadata || null,
  });
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
    res.json(attestation);
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
          await storage.createRepository({
            userId,
            githubId: repo.githubId,
            name: repo.name,
            fullName: repo.fullName,
            url: repo.url,
            defaultBranch: repo.defaultBranch,
            description: repo.description,
          });
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

  app.delete("/api/repositories/:id", isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const repo = await storage.getRepository(id);
    if (!repo) return res.status(404).json({ message: "Not found" });
    if (repo.userId !== userId) return res.status(403).json({ message: "Forbidden" });
    await storage.deleteRepository(id);
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
        res.redirect("/dashboard?github=connected");
      } else {
        res.redirect("/dashboard?github=error");
      }
    } catch {
      res.redirect("/dashboard?github=error");
    }
  });

  app.get("/api/github/status", isAuthenticated, (_req, res) => {
    const configured = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
    res.json({ configured, connected: false });
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
    const { fullKey, keyHash, keyPrefix } = generateApiKey();
    const apiKey = await storage.createApiKey({
      userId,
      name,
      keyHash,
      keyPrefix,
    });
    res.json({ ...apiKey, fullKey });
  });

  app.delete("/api/api-keys/:id", isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    await storage.deleteApiKey(id, userId);
    res.json({ message: "Deleted" });
  });

  // ─── Public Demo ──────────────────────────────────
  app.get("/api/demo/attestations", demoLimiter, async (_req, res) => {
    const attestations = await storage.getSystemAttestations();
    res.json(attestations);
  });

  app.get("/api/demo/attestations/:id", demoLimiter, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const attestation = await storage.getAttestation(id);
    if (!attestation) return res.status(404).json({ message: "Not found" });
    if (attestation.userId !== "forgeproof-system") {
      return res.status(403).json({ message: "Only system attestations are publicly accessible" });
    }
    res.json(attestation);
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

    const detectedCountry = detectCountryFromRequest(req);
    const receipt = await createAttestationReceipt(userId, parsed.data, detectedCountry);
    res.status(201).json(receipt);
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

  return httpServer;
}
