import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { protectLegacyReceipt, restoreProtectedReceipt, verifyProtectedReceiptCore } from '../server/git-store/protected-receipt.mjs';

function hash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function pemBody(pem) {
  return pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
}

function makeLegacyReceiptWithWhitespace() {
  const keys = generateKeyPairSync('ed25519');
  const signedAt = '2026-10-02T03:04:05.000Z';
  const core = {
    id: 77,
    userId: 'u_abc',
    orgId: 12,
    repositoryId: 34,
    fileHash: 'sha256:' + 'a'.repeat(64),
    fileName: 'auth.ts',
    filePath: 'src/utils/auth.ts',
    modelName: 'gpt-6.1-sol',
    modelProvider: 'OpenAI',
    countryOfOrigin: 'US',
    detectedCountry: 'US',
    complianceStatus: 'verified',
    attestationType: 'origin',
    parentAttestationId: null,
    auditVerdict: 'pass',
    auditDetails: { pii: ['email'], findings: [] },
    signature: '',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    prevEntryHash: null,
    entryHash: '',
    receiptVersion: 'v1',
    signedAt,
    gitCommitUrl: null,
    gitCommitMessage: null,
    metadata: { sourceIp: '203.0.113.2', userAgent: 'sensitive-agent' },
    createdAt: '2026-10-02T03:04:05.000Z',
  };

  const preimage = [
    core.fileHash,
    core.modelName,
    core.modelProvider,
    core.countryOfOrigin,
    'genesis',
    core.signedAt,
  ].join('|');
  core.entryHash = createHash('sha256').update(preimage).digest('hex');
  const payload = `${core.entryHash}|${core.fileHash}|${core.signedAt}`;
  core.signature = sign(null, Buffer.from(payload), keys.privateKey).toString('base64');
  core.publicKey = pemBody(core.publicKey);

  const originalJson = `\n  {\n    "id": ${core.id},\n    "userId": "${core.userId}",\n    "orgId": ${core.orgId},\n    "repositoryId": ${core.repositoryId},\n    "fileHash": "${core.fileHash}",\n    "fileName": "${core.fileName}",\n    "filePath": "${core.filePath}",\n    "modelName": "${core.modelName}",\n    "modelProvider": "${core.modelProvider}",\n    "countryOfOrigin": "${core.countryOfOrigin}",\n    "detectedCountry": "${core.detectedCountry}",\n    "complianceStatus": "${core.complianceStatus}",\n    "attestationType": "${core.attestationType}",\n    "parentAttestationId": null,\n    "auditVerdict": "${core.auditVerdict}",\n    "auditDetails": ${JSON.stringify(core.auditDetails)},\n    "signature": "${core.signature}",\n    "publicKey": ${JSON.stringify(core.publicKey)},\n    "prevEntryHash": null,\n    "entryHash": "${core.entryHash}",\n    "receiptVersion": "${core.receiptVersion}",\n    "signedAt": "${core.signedAt}",\n    "gitCommitUrl": null,\n    "gitCommitMessage": null,\n    "metadata": ${JSON.stringify(core.metadata)},\n    "createdAt": "${core.createdAt}"\n  }\n`;

  return Buffer.from(originalJson, 'utf8');
}

test('protect/verify/restore preserves exact bytes with valid legacy signed receipt', () => {
  const original = makeLegacyReceiptWithWhitespace();
  const key = randomBytes(32);
  const tenant = 'tenant-a';
  const repository = 'repo-a';

  const record = protectLegacyReceipt(original, tenant, repository, key);
  const verified = verifyProtectedReceiptCore(record);
  assert.equal(verified.id, record.id);

  const restored = restoreProtectedReceipt(record, tenant, repository, key);
  assert.deepEqual(restored, original);
});

test('restore fails with wrong key', () => {
  const original = makeLegacyReceiptWithWhitespace();
  const key = randomBytes(32);
  const record = protectLegacyReceipt(original, 't1', 'r1', key);
  assert.throws(() => restoreProtectedReceipt(record, 't1', 'r1', randomBytes(32)), /Decryption failed/);
});

test('restore fails with swapped tenant scope and swapped ciphertext', () => {
  const key = randomBytes(32);
  const rec1 = protectLegacyReceipt(makeLegacyReceiptWithWhitespace(), 'tenant-1', 'repo-1', key);
  const rec2 = protectLegacyReceipt(makeLegacyReceiptWithWhitespace(), 'tenant-2', 'repo-2', key);
  assert.throws(() => restoreProtectedReceipt(rec1, 'tenant-2', 'repo-1', key), /Decryption failed/);
  const mixed = JSON.parse(JSON.stringify(rec1));
  mixed.encryption.ciphertext = rec2.encryption.ciphertext;
  mixed.encryption.ciphertextSha256 = rec2.encryption.ciphertextSha256;
  assert.throws(() => restoreProtectedReceipt(mixed, 'tenant-1', 'repo-1', key), /Decryption failed/);
});

test('verify fails when signed field in originalCore is changed', () => {
  const key = randomBytes(32);
  const record = protectLegacyReceipt(makeLegacyReceiptWithWhitespace(), 'tenant-z', 'repo-z', key);
  const tampered = JSON.parse(JSON.stringify(record));
  const parsedCore = JSON.parse(tampered.originalCore);
  parsedCore.modelProvider = 'TamperedProvider';
  tampered.originalCore = JSON.stringify(parsedCore);
  assert.throws(() => verifyProtectedReceiptCore(tampered), /Invalid historical receipt signature\/hash/);
});

test('restore fails on mutated ciphertext or tag', () => {
  const key = randomBytes(32);
  const record = protectLegacyReceipt(makeLegacyReceiptWithWhitespace(), 'tenant-q', 'repo-q', key);

  const ctMut = JSON.parse(JSON.stringify(record));
  const ctBuf = Buffer.from(ctMut.encryption.ciphertext, 'base64');
  ctBuf[0] ^= 1;
  ctMut.encryption.ciphertext = ctBuf.toString('base64');
  ctMut.encryption.ciphertextSha256 = hash(ctBuf).replace('sha256:','sha256:');
  assert.throws(() => restoreProtectedReceipt(ctMut, 'tenant-q', 'repo-q', key), /Decryption failed|ciphertext hash mismatch/);

  const tagMut = JSON.parse(JSON.stringify(record));
  const tagBuf = Buffer.from(tagMut.encryption.tag, 'base64');
  tagBuf[0] ^= 1;
  tagMut.encryption.tag = tagBuf.toString('base64');
  assert.throws(() => restoreProtectedReceipt(tagMut, 'tenant-q', 'repo-q', key), /Decryption failed/);
});
