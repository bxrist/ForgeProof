/// <reference types="node" />
export interface EncryptedAudit {
  id: number;
  auditCore: string;
  encryption: {
    version: number;
    algorithm: string;
    nonce: string;
    tag: string;
    ciphertext: string;
    ciphertextSha256: string;
    plaintextSha256: string;
  };
}
export function protectLegacyAuditLog(originalBytes: Buffer, tenant: string, repository: string, key: Buffer): EncryptedAudit;
export function verifyProtectedAuditCore(value: unknown): unknown;
export function restoreProtectedAuditLog(value: unknown, tenant: string, repository: string, key: Buffer): Buffer;
