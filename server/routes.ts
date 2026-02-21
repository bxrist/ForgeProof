import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replit_integrations/auth/replitAuth";
import { sha256, signData, getKeyPair, computeEntryHash, generateApiKey } from "./crypto";
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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);

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

  app.get("/api/attestations", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const attestations = await storage.getAttestations(userId);
    res.json(attestations);
  });

  app.get("/api/attestations/:id", isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id);
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

  app.get("/api/repositories", isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const repos = await storage.getRepositories(userId);
    res.json(repos);
  });

  app.post("/api/repositories/sync", isAuthenticated, async (_req, res) => {
    res.json({ message: "Repository sync initiated. GitHub OAuth integration will populate repositories." });
  });

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
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    await storage.deleteApiKey(id, userId);
    res.json({ message: "Deleted" });
  });

  app.get("/api/demo/attestations", async (_req, res) => {
    const attestations = await storage.getSystemAttestations();
    res.json(attestations);
  });

  app.get("/api/demo/attestations/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const attestation = await storage.getAttestation(id);
    if (!attestation) return res.status(404).json({ message: "Not found" });
    if (attestation.userId !== "forgeproof-system") {
      return res.status(403).json({ message: "Only system attestations are publicly accessible" });
    }
    res.json(attestation);
  });

  app.post("/api/v1/attest", async (req, res) => {
    const authHeader = req.headers.authorization;
    let userId: string | null = null;

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const keyHash = sha256(token);
      const apiKey = await storage.getApiKeyByHash(keyHash);
      if (!apiKey || !apiKey.isActive) {
        return res.status(401).json({ message: "Invalid or inactive API key" });
      }
      if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
        return res.status(401).json({ message: "API key expired" });
      }
      userId = apiKey.userId;
      await storage.updateApiKeyLastUsed(apiKey.id);
    } else if (req.isAuthenticated()) {
      const user = req.user as any;
      userId = user.claims?.sub || user.id;
    } else {
      return res.status(401).json({ message: "Authentication required" });
    }

    const parsed = attestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", errors: parsed.error.issues });
    }

    const data = parsed.data;
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

    const receipt = await storage.createAttestation({
      userId: userId!,
      fileHash: data.file_hash,
      fileName,
      filePath: data.file_path,
      modelName: data.model_name,
      modelProvider: data.model_provider,
      countryOfOrigin: data.country_of_origin,
      signature,
      publicKey,
      prevEntryHash,
      entryHash,
      receiptVersion: "v1",
      metadata: data.metadata || null,
    });

    res.status(201).json(receipt);
  });

  return httpServer;
}
