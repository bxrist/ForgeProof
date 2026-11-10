/// <reference types="node" />
export interface ProtectedMessage {
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}
export interface ProtectedEmailCore {
  id: number;
  status: 'pending' | 'sent' | 'failed';
  retryCount: number;
  nextRetryAt: string;
  createdAt: string;
  originalDigest: string;
  encryption: {
    version: string;
    algorithm: string;
    nonce: string;
    tag: string;
    ciphertext: string;
    ciphertextSha256: string;
  };
}
export function protectQueuedEmail(message: ProtectedMessage, tenant: string, repository: string, id: number, key: Buffer): Pick<ProtectedEmailCore,'encryption' | 'originalDigest'>;
export function verifyProtectedEmailCore(record: unknown): ProtectedEmailCore;
export function restoreQueuedEmail(record: unknown, tenant: string, repository: string, key: Buffer): ProtectedMessage;
