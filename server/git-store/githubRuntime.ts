import { createPrivateKey, createPublicKey, hkdfSync, sign } from "node:crypto";
import { normalizedSignerPem, configuredSignerSecrets } from "../crypto";
import { GitHubAppStateService, GitHubCredentialVault, GitHubTransport } from "./github-store.mjs";
import { EncryptedProviderCustodian } from "./custody";

/**
 * Production Git store: private GitHub repository reached through the project's
 * authorized GitHub connection. Every value here is either public trust data
 * (environment) or derived from the existing signer secret; nothing is generated.
 */
export const GIT_EVENT_ACTOR = "forgeproof-app";
export const GIT_EVENT_KEY_ID = "forgeproof-production-38dd16a7";

const stripPem = (value: string) => value.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");

export function githubStoreSettings(env = process.env) {
  const repository = env.FORGEPROOF_GIT_GITHUB_REPOSITORY;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("FORGEPROOF_GIT_GITHUB_REPOSITORY must be owner/repo");
  const [owner, repo] = repository.split("/");
  const tenant = env.FORGEPROOF_GIT_TENANT ?? "production";
  const stream = env.FORGEPROOF_GIT_STREAM ?? "app";
  const guardUserId = env.FORGEPROOF_GIT_GUARD_USER_ID;
  if (!guardUserId) throw new Error("FORGEPROOF_GIT_GUARD_USER_ID must name the existing owner account");
  const checkpoint = env.FORGEPROOF_GIT_CHECKPOINT ? JSON.parse(env.FORGEPROOF_GIT_CHECKPOINT) : null;
  const receiptKeys = (env.FORGEPROOF_GIT_RECEIPT_KEYS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const receiptPredecessor = env.FORGEPROOF_GIT_RECEIPT_PREDECESSOR || null;
  return { owner, repo, tenant, stream, guardUserId, checkpoint, receiptKeys, receiptPredecessor };
}

export function signerMaterial() {
  const pem = normalizedSignerPem();
  const privateKey = createPrivateKey(pem);
  const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const pin = configuredSignerSecrets().publicPin;
  if (!pin || stripPem(pin) !== stripPem(publicPem)) throw new Error("Git event signer does not match the configured public-key pin");
  const seed = privateKey.export({ type: "pkcs8", format: "der" });
  const derive = (label: string) => Buffer.from(hkdfSync("sha256", seed, "forgeproof-git-store-v1", label, 32));
  return {
    publicPem,
    signer: { actor: GIT_EVENT_ACTOR, keyId: GIT_EVENT_KEY_ID, sign: async (bytes: Buffer) => sign(null, bytes, privateKey).toString("base64") },
    custodyKey: derive("credential-custody"),
    mailEncryptionKey: derive("mail"),
    auditEncryptionKey: derive("audit"),
    receiptEncryptionKey: derive("receipt"),
  };
}

export async function connectorRequest(path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
  const { ReplitConnectors } = await import("@replit/connectors-sdk");
  const client = new ReplitConnectors();
  return client.proxy("github", path, init as any) as Promise<Response>;
}

export function createGitHubStore(env = process.env, request = connectorRequest) {
  const settings = githubStoreSettings(env);
  const material = signerMaterial();
  const transport = new GitHubTransport({ owner: settings.owner, repo: settings.repo, request });
  const trust = {
    eventKeys: { [GIT_EVENT_KEY_ID]: { actor: GIT_EVENT_ACTOR, publicKey: material.publicPem } },
    receiptKeys: settings.receiptKeys,
    receiptPredecessor: settings.receiptPredecessor,
  };
  const service = new GitHubAppStateService({
    transport, tenant: settings.tenant, repository: settings.stream, trust,
    checkpoint: settings.checkpoint, signer: material.signer,
  });
  const vault = new GitHubCredentialVault({ transport, prefix: `forgeproof-vault/${settings.tenant}` });
  const custody = new EncryptedProviderCustodian(vault, material.custodyKey);
  return { settings, service, custody, material, transport };
}
