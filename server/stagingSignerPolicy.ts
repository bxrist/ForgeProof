import { createHash, createPublicKey } from "node:crypto";

// Independently supplied production SPKI fingerprint: deny for staging writes,
// never remove from historical signature verification trust.
export const ORIGINAL_PRODUCTION_SIGNER_PIN =
  "38dd16a7f4357a1a90f6d645c9b1a6c22d92f5627d78ee6ccd668c76ac4ff089";

export function forbiddenStagingSigner(pin: string, historicalReceiptPin?: string): boolean {
  return pin === ORIGINAL_PRODUCTION_SIGNER_PIN || pin === historicalReceiptPin;
}

export function publicSignerFingerprint(value: string): string {
  const key = createPublicKey(value.includes("-----BEGIN PUBLIC KEY-----")
    ? value
    : { key: Buffer.from(value, "base64"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Staging signer must be Ed25519");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}
