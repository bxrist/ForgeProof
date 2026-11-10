/// <reference types="node" />
export type ProtectedAuditEncryptionV2 = {
  version: 2;
  algorithm: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  ciphertextSha256: string;
  plaintextSha256: string;
};
export type ProtectedAuditEncryptionV3 = {
  version: 3;
  algorithm: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  ciphertextSha256: string;
  plaintextHmac: string;
};
export interface EncryptedAudit {
  id: number;
  auditCore: string;
  encryption: ProtectedAuditEncryptionV2 | ProtectedAuditEncryptionV3;
}
export function protectLegacyAuditLog(originalBytes: Buffer, tenant: string, repository: string, key: Buffer): EncryptedAudit;
export function verifyProtectedAuditCore(value: unknown): { id: number; auditCoreSha256: string; encryptionVersion: 2 | 3 };
export function restoreProtectedAuditLog(value: unknown, tenant: string, repository: string, key: Buffer): Buffer;
