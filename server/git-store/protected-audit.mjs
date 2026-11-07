import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 2;
const ALGORITHM = 'aes-256-gcm';
const CONTEXT = 'ForgeProof-protected-audit-v2';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const OPTIONAL_STRING_FIELDS = ['userId', 'resourceType', 'resourceId', 'ipAddress', 'createdAt'];
const AUDIT_FIELDS = ['id', 'userId', 'action', 'resourceType', 'resourceId', 'metadata', 'ipAddress', 'createdAt'];

function sha256Bytes(data) {
  return createHash('sha256').update(data).digest('hex');
}

function exactKeys(obj, keys, name) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) throw new Error(`Invalid ${name} fields`);
}

function mustB64Canonical(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) throw new Error(`Invalid ${name}`);
  if (bytes.toString('base64') !== value) throw new Error(`Non-canonical ${name}`);
  return bytes;
}

function ensureNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Invalid ${name}`);
}

function ensureKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid key');
}

function ensureOptionalStringOrNull(value, name) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Invalid ${name}`);
}

function parseUtf8JsonObject(bytes, name) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error(`Invalid ${name}`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Invalid ${name}`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${name}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

function validateAuditCoreObject(core) {
  exactKeys(core, AUDIT_FIELDS, 'auditCore');
  if (!Number.isInteger(core.id) || core.id <= 0) throw new Error('Invalid id');
  ensureNonEmptyString(core.action, 'action');
  for (const field of OPTIONAL_STRING_FIELDS) {
    ensureOptionalStringOrNull(core[field], field);
  }
  if (core.metadata !== null) throw new Error('auditCore.metadata must be null');
}

function parseOriginalAuditBytes(originalBytes) {
  const parsed = parseUtf8JsonObject(originalBytes, 'originalBytes');
  exactKeys(parsed, AUDIT_FIELDS, 'original audit row');
  if (!Number.isInteger(parsed.id) || parsed.id <= 0) throw new Error('Invalid id');
  ensureNonEmptyString(parsed.action, 'action');
  for (const field of OPTIONAL_STRING_FIELDS) {
    ensureOptionalStringOrNull(parsed[field], field);
  }
  if (parsed.metadata === null || parsed.metadata === undefined) throw new Error('metadata must be non-null');

  const auditCoreObject = { ...parsed, metadata: null };
  validateAuditCoreObject(auditCoreObject);

  return {
    id: parsed.id,
    auditCore: JSON.stringify(auditCoreObject),
  };
}

function aadFor(tenant, repository, id, coreSha256) {
  ensureNonEmptyString(tenant, 'tenant');
  ensureNonEmptyString(repository, 'repository');
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id');
  if (!HASH_RE.test(coreSha256)) throw new Error('Invalid core hash');
  return Buffer.from(JSON.stringify([CONTEXT, tenant, repository, id, coreSha256]), 'utf8');
}

export function protectLegacyAuditLog(originalBytes, tenant, repository, key) {
  ensureKey(key);
  const { id, auditCore } = parseOriginalAuditBytes(originalBytes);
  const coreSha = `sha256:${sha256Bytes(Buffer.from(auditCore, 'utf8'))}`;

  const nonce = randomBytes(NONCE_BYTES);
  const aad = aadFor(tenant, repository, id, coreSha);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(originalBytes), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    id,
    auditCore,
    encryption: {
      version: VERSION,
      algorithm: ALGORITHM,
      nonce: nonce.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      ciphertextSha256: `sha256:${sha256Bytes(ciphertext)}`,
      plaintextSha256: `sha256:${sha256Bytes(originalBytes)}`,
    },
  };
}

export function verifyProtectedAuditCore(protectedRecord) {
  exactKeys(protectedRecord, ['id', 'auditCore', 'encryption'], 'protectedRecord');
  if (!Number.isInteger(protectedRecord.id) || protectedRecord.id <= 0) throw new Error('Invalid id');
  if (typeof protectedRecord.auditCore !== 'string' || protectedRecord.auditCore.length === 0) throw new Error('Invalid auditCore');

  const auditCoreBytes = Buffer.from(protectedRecord.auditCore, 'utf8');
  if (auditCoreBytes.toString('utf8') !== protectedRecord.auditCore) throw new Error('Invalid auditCore');

  let parsedCore;
  try {
    parsedCore = JSON.parse(protectedRecord.auditCore);
  } catch {
    throw new Error('Invalid auditCore');
  }
  validateAuditCoreObject(parsedCore);
  if (JSON.stringify(parsedCore) !== protectedRecord.auditCore) throw new Error('Non-canonical auditCore');
  if (parsedCore.id !== protectedRecord.id) throw new Error('id mismatch');

  const enc = protectedRecord.encryption;
  exactKeys(enc, ['version', 'algorithm', 'nonce', 'tag', 'ciphertext', 'ciphertextSha256', 'plaintextSha256'], 'encryption');
  if (enc.version !== VERSION) throw new Error('Unsupported encryption version');
  if (enc.algorithm !== ALGORITHM) throw new Error('Unsupported encryption algorithm');

  const nonce = mustB64Canonical(enc.nonce, 'nonce');
  const tag = mustB64Canonical(enc.tag, 'tag');
  const ciphertext = mustB64Canonical(enc.ciphertext, 'ciphertext');

  if (nonce.length !== NONCE_BYTES) throw new Error('Invalid nonce size');
  if (tag.length !== TAG_BYTES) throw new Error('Invalid tag size');
  if (ciphertext.length === 0) throw new Error('Empty ciphertext');

  if (enc.ciphertextSha256 !== `sha256:${sha256Bytes(ciphertext)}`) throw new Error('ciphertext hash mismatch');
  if (typeof enc.plaintextSha256 !== 'string' || !HASH_RE.test(enc.plaintextSha256)) throw new Error('Invalid plaintextSha256');

  return {
    id: protectedRecord.id,
    coreSha256: `sha256:${sha256Bytes(auditCoreBytes)}`,
  };
}

export function restoreProtectedAuditLog(protectedRecord, tenant, repository, key) {
  ensureKey(key);
  const verified = verifyProtectedAuditCore(protectedRecord);
  const enc = protectedRecord.encryption;

  const nonce = Buffer.from(enc.nonce, 'base64');
  const tag = Buffer.from(enc.tag, 'base64');
  const ciphertext = Buffer.from(enc.ciphertext, 'base64');

  const aad = aadFor(tenant, repository, verified.id, verified.coreSha256);
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Decryption failed');
  }

  if (`sha256:${sha256Bytes(plaintext)}` !== enc.plaintextSha256) throw new Error('Plaintext hash mismatch');

  const parsed = parseUtf8JsonObject(plaintext, 'plaintext');
  exactKeys(parsed, AUDIT_FIELDS, 'plaintext audit row');
  if (parsed.metadata === null || parsed.metadata === undefined) throw new Error('Missing plaintext metadata');

  const expectedCore = JSON.stringify({ ...parsed, metadata: null });
  if (expectedCore !== protectedRecord.auditCore) throw new Error('Inconsistent audit core');

  return plaintext;
}
