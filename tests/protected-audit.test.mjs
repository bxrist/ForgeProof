import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  protectLegacyAuditLog,
  verifyProtectedAuditCore,
  restoreProtectedAuditLog,
} from '../server/git-store/protected-audit.mjs';

function sha256(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function baseRecord() {
  return {
    id: 7,
    userId: 'user_123',
    action: 'update_profile',
    resourceType: 'user',
    resourceId: 'user_123',
    metadata: { before: { name: 'A' }, after: { name: 'B' }, note: 'synthetic' },
    ipAddress: '203.0.113.10',
    createdAt: '2026-09-01T12:00:00.000Z',
  };
}

function mutateB64Byte(b64, index = 0) {
  const buf = Buffer.from(b64, 'base64');
  buf[index] ^= 0x01;
  return buf.toString('base64');
}

test('protect + verify + restore roundtrip preserves exact original bytes', () => {
  const key = randomBytes(32);
  const originalText = '{\n  "id": 7,\n  "userId": "user_123",\n  "action": "update_profile",\n  "resourceType": "user",\n  "resourceId": "user_123",\n  "metadata": { "x": 1, "y": [1,2,3] },\n  "ipAddress": "203.0.113.10",\n  "createdAt": "2026-09-01T12:00:00.000Z"\n}\n';
  const original = Buffer.from(originalText, 'utf8');

  const record = protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key);
  const verified = verifyProtectedAuditCore(record);
  assert.equal(verified.id, 7);

  assert.equal(record.encryption.version, 2);
  assert.equal(record.encryption.algorithm, 'aes-256-gcm');
  assert.equal(record.encryption.plaintextSha256, sha256(original));
  assert.equal(record.auditCore.includes('"metadata":null'), true);

  const restored = restoreProtectedAuditLog(record, 'tenant-a', 'repo-a', key);
  assert.equal(Buffer.compare(restored, original), 0);
});

test('wrong key fails restore', () => {
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const original = Buffer.from(JSON.stringify(baseRecord()), 'utf8');
  const record = protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key);
  assert.throws(() => restoreProtectedAuditLog(record, 'tenant-a', 'repo-a', wrongKey), /Decryption failed/);
});

test('swapped tenant fails restore', () => {
  const key = randomBytes(32);
  const original = Buffer.from(JSON.stringify(baseRecord()), 'utf8');
  const record = protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key);
  assert.throws(() => restoreProtectedAuditLog(record, 'tenant-b', 'repo-a', key), /Decryption failed/);
});

test('ciphertext mutation fails verification', () => {
  const key = randomBytes(32);
  const original = Buffer.from(JSON.stringify(baseRecord()), 'utf8');
  const record = protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key);
  const mutated = {
    ...record,
    encryption: { ...record.encryption, ciphertext: mutateB64Byte(record.encryption.ciphertext) },
  };
  assert.throws(() => verifyProtectedAuditCore(mutated), /ciphertext hash mismatch/);
});

test('tag mutation fails restore', () => {
  const key = randomBytes(32);
  const original = Buffer.from(JSON.stringify(baseRecord()), 'utf8');
  const record = protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key);
  const mutated = {
    ...record,
    encryption: { ...record.encryption, tag: mutateB64Byte(record.encryption.tag) },
  };
  assert.throws(() => restoreProtectedAuditLog(mutated, 'tenant-a', 'repo-a', key), /Decryption failed/);
});

test('extra fields are rejected', () => {
  const key = randomBytes(32);
  const original = Buffer.from(JSON.stringify(baseRecord()), 'utf8');
  const record = protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key);

  const withExtraTop = { ...record, extra: true };
  assert.throws(() => verifyProtectedAuditCore(withExtraTop), /Invalid protectedRecord fields/);

  const withExtraEnc = {
    ...record,
    encryption: { ...record.encryption, extra: true },
  };
  assert.throws(() => verifyProtectedAuditCore(withExtraEnc), /Invalid encryption fields/);
});

test('changed nonsecret core field fails on restore', () => {
  const key = randomBytes(32);
  const original = Buffer.from(JSON.stringify(baseRecord()), 'utf8');
  const record = protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key);

  const parsedCore = JSON.parse(record.auditCore);
  parsedCore.action = 'different_action';
  const mutated = { ...record, auditCore: JSON.stringify(parsedCore) };

  assert.throws(() => restoreProtectedAuditLog(mutated, 'tenant-a', 'repo-a', key), /Decryption failed|Inconsistent audit core/);
});

test('metadata must be non-null in original input', () => {
  const key = randomBytes(32);
  const row = baseRecord();
  row.metadata = null;
  const original = Buffer.from(JSON.stringify(row), 'utf8');
  assert.throws(() => protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key), /metadata must be non-null/);
});
