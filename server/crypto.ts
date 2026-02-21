import { createHash, generateKeyPairSync, sign, verify, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const KEY_DIR = join(process.cwd(), ".keys");
const PRIVATE_KEY_PATH = join(KEY_DIR, "ed25519_private.pem");
const PUBLIC_KEY_PATH = join(KEY_DIR, "ed25519_public.pem");

let cachedKeyPair: { publicKey: string; privateKey: string } | null = null;

export function getKeyPair() {
  if (cachedKeyPair) return cachedKeyPair;

  if (existsSync(PRIVATE_KEY_PATH) && existsSync(PUBLIC_KEY_PATH)) {
    const privateKey = readFileSync(PRIVATE_KEY_PATH, "utf-8");
    const publicKeyRaw = readFileSync(PUBLIC_KEY_PATH, "utf-8");
    const publicKey = publicKeyRaw.replace(/-----BEGIN PUBLIC KEY-----\n?/g, "").replace(/\n?-----END PUBLIC KEY-----\n?/g, "").trim();
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
