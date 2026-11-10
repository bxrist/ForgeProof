import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { storage } from "./storage";
import { lifeosApproval, type LifeosApproval } from "./lifeosApproval";
import { sessionUserId } from "./middlewares/requireAuth";
import { hasPinnedDurableSigner } from "./crypto";
import { hasApplicationStorage, setVerifiedStoragePrincipal } from "./storageBackend";
import type { Replay } from "./git-store/store.mjs";

const proofs = new WeakSet<object>();
export interface LifeosProof {
  readonly userId: string;
  readonly apiKeyId: number;
  readonly keyHash: string;
}

function deny(message = "Verified LifeOS service binding required"): never {
  throw Object.assign(new Error(message), { status: 403 });
}

function approval(): Readonly<LifeosApproval> | null {
  const a = lifeosApproval;
  if (!a) return null;
  if (a.service !== "lifeos" || a.userId !== "lifeos-service-0a" || a.dedicated !== true ||
      !Number.isSafeInteger(a.apiKeyId) || a.apiKeyId <= 0 ||
      !/^[a-f0-9]{64}$/.test(a.apiKeyHash) ||
      !a.approvedBySubject || a.approvedBySubject === a.userId ||
      !a.approvalReference?.trim() ||
      !Number.isFinite(Date.parse(a.approvedAt)) || Date.parse(a.approvedAt) > Date.now()) {
    deny("Invalid LifeOS owner approval; no exemption granted");
  }
  return a;
}

export function assertNotLifeosBillingSubject(userId: string): void {
  // Never fall back to charging the nominated subject if approval is malformed.
  if (lifeosApproval?.userId === userId) {
    deny("Dedicated LifeOS service identity cannot enter billing");
  }
}

function tokenHash(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ") || !header.slice(7)) return null;
  return createHash("sha256").update(header.slice(7)).digest("hex");
}

function validKey(key: any, a: LifeosApproval): boolean {
  const expiresAt = key?.expiresAt ? new Date(key.expiresAt).getTime() : NaN;
  return key && key.id === a.apiKeyId && key.userId === a.userId &&
    key.keyHash === a.apiKeyHash && key.isActive &&
    Number.isFinite(expiresAt) && expiresAt > Date.now() &&
    Array.isArray(key.permissions) && key.permissions.length === 1 &&
    key.permissions[0] === "attest:write";
}

function noCommercialAssociation(user: any, sub: any): boolean {
  return !!user && !user.stripeCustomerId && !user.githubToken &&
    (!sub || (sub.plan === "free" && !sub.stripeCustomerId && !sub.stripeSubscriptionId));
}

// A successful match is proof of possession on this request, not a permanent
// grant. Sessions and caller-supplied service/org labels cannot produce proof.
export async function proveLifeosControl(header: string | undefined): Promise<LifeosProof> {
  const a = approval();
  if (!hasPinnedDurableSigner()) deny("LifeOS requires the verified durable ForgeProof signer");
  const hash = tokenHash(header);
  if (!a || hash !== a.apiKeyHash) deny();
  const key = await storage.getApiKeyByHash(hash);
  if (!validKey(hasApplicationStorage() && key ? {...key,keyHash:hash} : key, a)) deny();
  setVerifiedStoragePrincipal(a.userId);
  const [user, owner, sub, keys] = await Promise.all([
    storage.getUser(a.userId),
    storage.getUser(a.approvedBySubject),
    storage.getSubscription(a.userId),
    storage.getApiKeys(a.userId),
  ]);
  if (!owner || !noCommercialAssociation(user, sub) ||
      keys.some(k => k.id !== a.apiKeyId && k.isActive &&
        (!k.expiresAt || new Date(k.expiresAt).getTime() > Date.now()))) {
    deny("LifeOS binding is not an isolated non-commercial service identity");
  }
  const proof = Object.freeze({ userId: a.userId, apiKeyId: a.apiKeyId, keyHash: hash });
  proofs.add(proof);
  return proof;
}

export function verifyLifeosGitState(proof: LifeosProof, userId: string, state: Replay, credentialMatches: boolean): void {
  const a=approval();
  if (!a || !proofs.has(proof) || proof.userId!==userId || userId!==a.userId || !credentialMatches) deny();
  const key=state.records.apiKeys[proof.apiKeyId];
  const user=state.records.users[userId];
  const sub=Object.values(state.records.subscriptions).find(s=>s.userId===userId);
  if (!state.records.users[a.approvedBySubject] || !validKey({...key,keyHash:proof.keyHash},a) ||
      !noCommercialAssociation(user && {...user,githubToken:user.githubTokenRef},sub) ||
      Object.values(state.records.apiKeys).some(k=>k.userId===userId && k.id!==a.apiKeyId && k.isActive &&
        (!k.expiresAt || Date.parse(String(k.expiresAt))>Date.now()))) deny();
}

// Recheck under the SAME transaction as the receipt insert, locking the key and
// user so revocation/reassignment cannot race an unmetered insertion.
export async function verifyLifeosInTransaction(
  client: { query: (sql: string, params?: any[]) => Promise<any> },
  proof: LifeosProof,
  userId: string,
): Promise<void> {
  const a = approval();
  if (!a || !proofs.has(proof) || proof.userId !== userId || userId !== a.userId) deny();
  const result = await client.query(
    `SELECT k.id, k.user_id AS "userId", k.key_hash AS "keyHash",
            k.is_active AS "isActive", k.expires_at AS "expiresAt", k.permissions,
            u.stripe_customer_id AS "stripeCustomerId", u.github_token AS "githubToken"
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.id = $1 AND k.user_id = $2 FOR SHARE OF k, u`,
    [proof.apiKeyId, userId],
  );
  const row = result.rows[0];
  const subscriptions = await client.query(
    `SELECT plan, stripe_customer_id AS "stripeCustomerId",
            stripe_subscription_id AS "stripeSubscriptionId"
       FROM subscriptions WHERE user_id = $1 FOR SHARE`, [userId],
  );
  if (!validKey(row, a) || !noCommercialAssociation(row, subscriptions.rows[0])) deny();
}

// A dedicated principal must not accidentally take a metered/checkout path.
// Other customers bypass this middleware unchanged. GET remains read-only here.
export const restrictLifeosServiceWrites: RequestHandler = async (req, res, next) => {
  try {
    const subject = lifeosApproval?.userId;
    if (!subject || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    let isService = sessionUserId(req) === subject;
    const hash = tokenHash(req.headers.authorization);
    if (hash) {
      const key = await storage.getApiKeyByHash(hash);
      isService ||= key?.userId === subject;
    }
    if (isService && req.path !== "/lifeos/attest") {
      return res.status(403).json({ message: "Use the dedicated LifeOS attestation endpoint; billing and other writes are prohibited." });
    }
    next();
  } catch (error) {
    next(error);
  }
};
