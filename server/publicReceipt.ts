import type { AttestationReceipt } from "@shared/schema";
import { computeEntryHash, verifySignature } from "./crypto";
import { getReceiptTimestamp } from "./receiptTimestamp";

// Explicit allowlist shared by public lookup and chain responses. Never spread
// storage rows here: they contain owner IDs, caller metadata and audit details.
export function toPublicReceipt(entry: AttestationReceipt) {
  const timestamp = getReceiptTimestamp(entry) || "";
  const recomputedHash = computeEntryHash({
    fileHash: entry.fileHash,
    modelName: entry.modelName,
    modelProvider: entry.modelProvider,
    countryOfOrigin: entry.countryOfOrigin,
    prevEntryHash: entry.prevEntryHash,
    timestamp,
  });
  const signaturePayload = `${entry.entryHash}|${entry.fileHash}|${timestamp}`;

  return {
    id: entry.id,
    fileName: entry.fileName,
    filePath: entry.filePath,
    fileHash: entry.fileHash,
    entryHash: entry.entryHash,
    prevEntryHash: entry.prevEntryHash,
    signatureValid: !!timestamp && verifySignature(signaturePayload, entry.signature, entry.publicKey),
    hashMatch: !!timestamp && recomputedHash === entry.entryHash,
    complianceStatus: entry.complianceStatus,
    detectedCountry: entry.detectedCountry,
    countryOfOrigin: entry.countryOfOrigin,
    modelName: entry.modelName,
    modelProvider: entry.modelProvider,
    signature: entry.signature,
    publicKey: entry.publicKey,
    receiptVersion: entry.receiptVersion,
    createdAt: entry.createdAt,
    signedAt: entry.signedAt ?? null,
  };
}
