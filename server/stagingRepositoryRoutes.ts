import express, { type Express, type RequestHandler } from "express";
import { createHash, createPublicKey, verify } from "node:crypto";
import type { IStorage } from "./storage";
import { validateLegacyStorage } from "./storageContract";
import { registerRepositoryList, registerRepositoryDelete } from "./repositoryRoutes";
import { createUiLimiter } from "./httpSecurity";

export type StagingRouteOptions = {
  storage: IStorage;
  /** Trusted public keys supplied by the harness operator, never by requests. */
  principals: Readonly<Record<string, string>>;
};

/** Bounded real-route integration. No SQL, Passport, email, GitHub or Stripe imports.
 * Call on a fresh app. This registrar terminates all other routes.
 */
export function registerStagingRepositoryRoutes(app: Express, options: StagingRouteOptions) {
  if (process.env.NODE_ENV !== "staging" || process.env.FORGEPROOF_STORAGE !== "legacy-route-staging") {
    throw new Error("Explicit staging-only legacy-route-staging selection required");
  }
  validateLegacyStorage(options.storage);
  // Pin keys at registration so later mutation of caller configuration cannot add trust.
  const keys = new Map(Object.entries(options.principals).map(([id, pem]) => {
    const key = createPublicKey(pem);
    if (!id || key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 staging principal required");
    return [id, key] as const;
  }));
  if (!keys.size) throw new Error("Explicit staging principals required");
  const storage = options.storage;
  const used = new Map<string, number>();
  app.use(express.raw({ type: () => true, limit: "64kb" }));
  const authenticate: RequestHandler = (req, res, next) => {
    const id = req.get("x-forgeproof-user") ?? "";
    const timestamp = req.get("x-forgeproof-time") ?? "";
    const nonce = req.get("x-forgeproof-request") ?? "";
    const signature = req.get("x-forgeproof-signature") ?? "";
    const key = keys.get(id);
    const now = Date.now();
    used.forEach((expiry, token) => { if (expiry < now) used.delete(token); });
    const token = JSON.stringify([id, nonce]);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const payload = JSON.stringify(["forgeproof-legacy-route-staging-v1", id, req.method, req.originalUrl, timestamp, nonce, createHash("sha256").update(body).digest("hex")]);
    const bytes = Buffer.from(signature, "base64");
    if (!key || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60000 ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(nonce) || used.has(token) || used.size >= 10000 ||
        bytes.length !== 64 || bytes.toString("base64") !== signature || !verify(null, Buffer.from(payload), key, bytes)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    used.set(token, Number(timestamp) + 60000);
    // Only a verified, explicitly pinned principal becomes a legacy handler user.
    req.user = { id, claims: { sub: id } } as Express.User;
    next();
  };
  const limiter = createUiLimiter();
  registerRepositoryList(app, storage, limiter, authenticate);
  registerRepositoryDelete(app, storage, limiter, authenticate);
  app.use((_req, res) => { res.status(404).json({ message: "Unavailable in staging route integration" }); });
}

export function createStagingRepositoryApp(options: StagingRouteOptions) {
  const app = express();
  registerStagingRepositoryRoutes(app, options);
  return app;
}
