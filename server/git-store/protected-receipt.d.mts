/// <reference types="node" />
export type ProtectedReceiptEncryptionV2 = {
  version: 2;
  algorithm: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  ciphertextSha256: string;
  plaintextSha256: string;
};
export type ProtectedReceiptEncryptionV3 = {
  version: 3;
  algorithm: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  ciphertextSha256: string;
  plaintextHmac: string;
};
export function protectLegacyReceipt(
  originalBytes: Buffer,
  tenant: string,
  repository: string,
  key: Buffer,
): {
  id: number;
  originalCore: string;
  encryption: ProtectedReceiptEncryptionV3;
};
export function verifyProtectedReceiptCore(value: unknown): { id: number; entryHash: string; publicKey: string; userId: string; prevEntryHash: string | null; parentAttestationId: number | null; encryptionVersion: 2 | 3 };
export function restoreProtectedReceipt(value: unknown, tenant: string, repository: string, key: Buffer): Buffer;
