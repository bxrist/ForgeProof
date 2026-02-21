import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replit_integrations/auth/replitAuth";
import { sha256, signData, getKeyPair, computeEntryHash, generateApiKey, verifySignature } from "./crypto";
import { fetchUserRepos, fetchRepoFiles, fetchFileContent, fetchRepoCommits, fetchCommitFiles } from "./github";
import { z } from "zod";

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
  app.get("/api/demo/attestations", async (_req, res) => {
    const attestations = await storage.getSystemAttestations();
    res.json(attestations);
  });

  app.get("/api/demo/attestations/:id", async (req, res) => {
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
  app.post("/api/v1/attest", async (req, res) => {
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
  app.post("/api/v1/agents/openai", async (req, res) => {
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

  app.post("/api/v1/agents/claude", async (req, res) => {
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

  app.post("/api/v1/agents/replit", async (req, res) => {
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
  app.get("/api/verify/chain", async (_req, res) => {
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

  app.get("/api/verify/entry/:id", async (req, res) => {
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

  return httpServer;
}
