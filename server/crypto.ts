import { createHash, generateKeyPairSync, sign, verify, randomBytes, createPrivateKey, createPublicKey } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const KEY_DIR = join(process.cwd(), ".keys");
const PRIVATE_KEY_PATH = join(KEY_DIR, "ed25519_private.pem");
const PUBLIC_KEY_PATH = join(KEY_DIR, "ed25519_public.pem");

let cachedKeyPair: { publicKey: string; privateKey: string } | null = null;

function normalizePrivatePem(value: string): string {
  // Replit single-line secret inputs collapse PEM newlines to spaces.
  const spaced = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PRIVATE KEY-----\s*$/.exec(value);
  if (spaced && !value.includes("\n")) {
    const body = spaced[1].replace(/\s/g, "");
    if (Buffer.from(body, "base64").toString("base64") !== body) throw new Error("Invalid ForgeProof private PEM");
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  }
  if (!value.includes("\\")) return value;
  // Single-line deployment secret inputs need literal \\n separators. Accept
  // only bounded PKCS8 PEM, never general JSON escapes or mixed LF/escapes.
  const match = value.length <= 1024 && /^-----BEGIN PRIVATE KEY-----\\n([A-Za-z0-9+/=]+(?:\\n[A-Za-z0-9+/=]+)*)\\n-----END PRIVATE KEY-----(?:\\n)?$/.exec(value);
  if (!match || match[0] !== value) throw new Error("Invalid escaped ForgeProof private PEM");
  const body = match[1].replace(/\\n/g, "");
  if (body.length < 64 || body.length > 256 || Buffer.from(body, "base64").toString("base64") !== body) {
    throw new Error("Invalid escaped ForgeProof private PEM");
  }
  return value.replace(/\\n/g, "\n");
}

/** The live production receipt signer (SPKI SHA-256 38dd16a7…) is held in the
 * existing FORGEPROOF_STAGING_SIGNER_* secret pair. Production uses it when the
 * FORGEPROOF_ED25519_* names are not set; development never borrows it. */
export function configuredSignerSecrets(): { privatePem?: string; publicPin?: string } {
  const privatePem = process.env.FORGEPROOF_ED25519_PRIVATE_KEY_PEM;
  const publicPin = process.env.FORGEPROOF_ED25519_PUBLIC_KEY_PIN;
  if (privatePem || publicPin || process.env.NODE_ENV !== "production") return { privatePem, publicPin };
  return {
    privatePem: process.env.FORGEPROOF_STAGING_SIGNER_PRIVATE_KEY_PEM,
    publicPin: process.env.FORGEPROOF_STAGING_SIGNER_PUBLIC_KEY_PIN,
  };
}

export function normalizedSignerPem(): string {
  const { privatePem } = configuredSignerSecrets();
  if (!privatePem) throw new Error("ForgeProof signer is not configured");
  return normalizePrivatePem(privatePem);
}

export function getKeyPair() {
  // Guarded durable-key rollout. Once either setting is configured, both must
  // be valid and match; never fall back to a different signer on bad config.
  const { privatePem, publicPin } = configuredSignerSecrets();
  if (process.env.NODE_ENV === "production" && (!privatePem || !publicPin)) {
    throw new Error("Production ForgeProof signer requires both private PEM and independent public-key pin");
  }
  if (privatePem || publicPin) {
    if (!privatePem || !publicPin) throw new Error("Durable ForgeProof signer requires both private PEM and independent public-key pin");
    const normalizedPrivatePem = normalizePrivatePem(privatePem);
    const privateKeyObject = createPrivateKey(normalizedPrivatePem);
    const publicKeyObject = createPublicKey(privateKeyObject);
    if (privateKeyObject.asymmetricKeyType !== "ed25519" || publicKeyObject.asymmetricKeyType !== "ed25519") {
      throw new Error("Configured ForgeProof signer must be Ed25519");
    }
    const derivedPem = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
    const derived = derivedPem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
    const normalizedPin = publicPin.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
    if (derived !== normalizedPin) throw new Error("Configured ForgeProof signer does not match independent public-key pin");
    if (cachedKeyPair) {
      if (cachedKeyPair.publicKey.replace(/\s/g, "") !== derived) {
        throw new Error("Configured ForgeProof signer does not match cached signer");
      }
      return cachedKeyPair;
    }
    cachedKeyPair = { publicKey: derived, privateKey: normalizedPrivatePem };
    return cachedKeyPair;
  }

  // Local files and implicit key generation are development-only. Check the
  // production environment requirements above even when a signer is cached.
  if (cachedKeyPair) return cachedKeyPair;
  const hasPrivateFile = existsSync(PRIVATE_KEY_PATH);
  const hasPublicFile = existsSync(PUBLIC_KEY_PATH);
  if (hasPrivateFile || hasPublicFile) {
    if (!hasPrivateFile || !hasPublicFile) throw new Error("Existing ForgeProof signer files are incomplete; refusing implicit rotation");
    const privateKey = readFileSync(PRIVATE_KEY_PATH, "utf-8");
    const publicKeyRaw = readFileSync(PUBLIC_KEY_PATH, "utf-8");
    const publicKey = publicKeyRaw.replace(/-----BEGIN PUBLIC KEY-----\n?/g, "").replace(/\n?-----END PUBLIC KEY-----\n?/g, "").trim();
    const privateKeyObject = createPrivateKey(privateKey);
    if (privateKeyObject.asymmetricKeyType !== "ed25519") throw new Error("Existing ForgeProof signer is not Ed25519");
    const derived = createPublicKey(privateKeyObject).export({ type: "spki", format: "pem" }).toString()
      .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
    if (derived !== publicKey) throw new Error("Existing ForgeProof signer files do not match; refusing to sign");
    cachedKeyPair = { publicKey, privateKey };
    return cachedKeyPair;
  }

  const { publicKey: pubPem, privateKey: privPem } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  if (!existsSync(KEY_DIR)) {
    mkdirSync(KEY_DIR, { recursive: true });
  }
  writeFileSync(PRIVATE_KEY_PATH, privPem, { mode: 0o600 });
  writeFileSync(PUBLIC_KEY_PATH, pubPem, { mode: 0o644 });

  const publicKey = pubPem.replace(/-----BEGIN PUBLIC KEY-----\n?/g, "").replace(/\n?-----END PUBLIC KEY-----\n?/g, "").trim();
  cachedKeyPair = { publicKey, privateKey: privPem };
  return cachedKeyPair;
}

export function hasPinnedDurableSigner(): boolean {
  const { privatePem, publicPin } = configuredSignerSecrets();
  if (!privatePem && !publicPin) return false;
  if (!privatePem || !publicPin) throw new Error("Durable ForgeProof signer requires both private PEM and independent public-key pin");

  const privateKeyObject = createPrivateKey(normalizePrivatePem(privatePem));
  if (privateKeyObject.asymmetricKeyType !== "ed25519") throw new Error("Configured ForgeProof signer must be Ed25519");
  const derived = createPublicKey(privateKeyObject).export({ type: "spki", format: "pem" }).toString()
    .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  const normalizedPin = publicPin.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  if (derived !== normalizedPin) throw new Error("Configured ForgeProof signer does not match independent public-key pin");
  if (cachedKeyPair) {
    const cachedPublicKey = cachedKeyPair.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
    if (cachedPublicKey !== derived) throw new Error("Configured ForgeProof signer does not match cached signer");
  }
  return true;
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function signData(data: string): string {
  const { privateKey } = getKeyPair();
  const signature = sign(null, Buffer.from(data), privateKey);
  return signature.toString("base64");
}

export function verifySignature(data: string, signature: string, publicKeyBase64: string): boolean {
  try {
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;
    return verify(null, Buffer.from(data), publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function computeEntryHash(receipt: {
  fileHash: string;
  modelName: string;
  modelProvider: string;
  countryOfOrigin: string;
  prevEntryHash: string | null;
  timestamp: string;
}): string {
  const payload = [
    receipt.fileHash,
    receipt.modelName,
    receipt.modelProvider,
    receipt.countryOfOrigin,
    receipt.prevEntryHash || "genesis",
    receipt.timestamp,
  ].join("|");
  return sha256(payload);
}

export function generateApiKey(): { fullKey: string; keyHash: string; keyPrefix: string } {
  const bytes = randomBytes(32);
  const fullKey = `fp_sk_${bytes.toString("base64url")}`;
  const keyHash = sha256(fullKey);
  const keyPrefix = fullKey.substring(0, 12);
  return { fullKey, keyHash, keyPrefix };
}
