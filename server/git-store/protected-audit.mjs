import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION_V2 = 2;
const VERSION_V3 = 3;
const ALGORITHM = 'aes-256-gcm';
const CONTEXT_V2 = 'ForgeProof-protected-audit-v2';
const CONTEXT_V3 = 'ForgeProof-protected-audit-v3';
const HMAC_ALGORITHM = 'hmac-sha256';
const HKDF_INFO = 'ForgeProof/protected-audit/plaintext-hmac/v3';
const HKDF_SALT = Buffer.from('ForgeProof/protected-audit/hkdf-salt/v3', 'utf8');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HMAC_BYTES = 32;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const OPTIONAL_STRING_FIELDS = ['userId', 'resourceType', 'resourceId', 'ipAddress', 'createdAt'];
const AUDIT_FIELDS = ['id', 'userId', 'action', 'resourceType', 'resourceId', 'metadata', 'ipAddress', 'createdAt'];


function sha256Hex(data) {
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
  if (bytes.length === 0 && value !== '') throw new Error(`Invalid ${name}`);
  if (bytes.toString('base64') !== value) throw new Error(`Non-canonical ${name}`);
  return bytes;
}

function ensureNonEmptyString(value,name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid '+name);
}
function ensureOptionalStringOrNull(value,name) {
  if (value == null) return;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid '+name);
}
function parseUtf8JsonObject(bytes,name) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Invalid '+name);
  const text=bytes.toString('utf8');
  if (!Buffer.from(text,'utf8').equals(bytes)) throw new Error('Invalid '+name);
  let object;
  try { object=JSON.parse(text); } catch { throw new Error('Invalid '+name); }
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Invalid '+name);
  return object;
}
function validateAuditCoreObject(core) {
  exactKeys(core,AUDIT_FIELDS,'auditCore');
  if (!Number.isSafeInteger(core.id) || core.id<1) throw new Error('Invalid id');
  ensureNonEmptyString(core.action,'action');
  for (const field of OPTIONAL_STRING_FIELDS) ensureOptionalStringOrNull(core[field],field);
  if (core.metadata !== null) throw new Error('auditCore.metadata must be null');
}
function parseAndCanonicalizeAuditCoreText(auditCore) {
  if (typeof auditCore !== 'string' || !auditCore) throw new Error('Invalid auditCore');
  const parsed=parseUtf8JsonObject(Buffer.from(auditCore,'utf8'),'auditCore');
  validateAuditCoreObject(parsed);
  return JSON.stringify(parsed);
}
function parseAndCanonicalizeAuditBuffer(bytes) {
  const parsed=parseUtf8JsonObject(bytes,'original audit row');
  exactKeys(parsed,AUDIT_FIELDS,'original audit row');
  if (!Number.isSafeInteger(parsed.id) || parsed.id<1) throw new Error('Invalid id');
  ensureNonEmptyString(parsed.action,'action');
  for (const field of OPTIONAL_STRING_FIELDS) ensureOptionalStringOrNull(parsed[field],field);
  const copy={...parsed,metadata:null};
  validateAuditCoreObject(copy);
  return {parsed,canonical:JSON.stringify(copy)};
}

function aadFor(tenant, repository, id, auditCoreSha256, context) {
  if (typeof tenant !== 'string' || tenant.length === 0) throw new Error('Invalid tenant');
  if (typeof repository !== 'string' || repository.length === 0) throw new Error('Invalid repository');
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id');
  if (typeof auditCoreSha256 !== 'string' || !HASH_RE.test(auditCoreSha256)) throw new Error('Invalid auditCoreSha256');
  return Buffer.from(JSON.stringify([context, tenant, repository, id, auditCoreSha256]), 'utf8');
}

function ensureKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid key');
}

function deriveAuditHmacKey(key) {
  return hkdfSync('sha256', key, HKDF_SALT, Buffer.from(HKDF_INFO, 'utf8'), HMAC_BYTES);
}

export function protectLegacyAuditLog(originalBytes, tenant, repository, key) {
  if (!Buffer.isBuffer(originalBytes) || originalBytes.length === 0) throw new Error('Invalid originalBytes');
  ensureKey(key);

  const { parsed, canonical } = parseAndCanonicalizeAuditBuffer(originalBytes);
  const id = parsed.id;
  const auditCoreSha256 = `sha256:${sha256Hex(Buffer.from(canonical, 'utf8'))}`;

  const nonce = randomBytes(NONCE_BYTES);
  const aad = aadFor(tenant, repository, id, auditCoreSha256, CONTEXT_V3);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(originalBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const plaintextHmac = createHmac('sha256', deriveAuditHmacKey(key)).update(originalBytes).digest('hex');

  return {
    id,
    auditCore: canonical,
    encryption: {
      version: VERSION_V3,
      algorithm: ALGORITHM,
      nonce: nonce.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      ciphertextSha256: `sha256:${sha256Hex(ciphertext)}`,
      plaintextHmac: `${HMAC_ALGORITHM}:${plaintextHmac}`,
    },
  };
}

export function verifyProtectedAuditCore(protectedRecord) {
  exactKeys(protectedRecord, ['id', 'auditCore', 'encryption'], 'protectedRecord');
  if (!Number.isInteger(protectedRecord.id) || protectedRecord.id <= 0) throw new Error('Invalid id');

  const canonicalCore = parseAndCanonicalizeAuditCoreText(protectedRecord.auditCore);
  if (canonicalCore !== protectedRecord.auditCore) throw new Error('Non-canonical auditCore');

  const parsedCore = JSON.parse(canonicalCore);
  if (parsedCore.id !== protectedRecord.id) throw new Error('Core id mismatch');

  const enc = protectedRecord.encryption;
  if (!enc || typeof enc !== 'object' || Array.isArray(enc)) throw new Error('Invalid encryption');
  if (enc.version === VERSION_V2) {
    exactKeys(enc, ['version', 'algorithm', 'nonce', 'tag', 'ciphertext', 'ciphertextSha256', 'plaintextSha256'], 'encryption');
  } else if (enc.version === VERSION_V3) {
    exactKeys(enc, ['version', 'algorithm', 'nonce', 'tag', 'ciphertext', 'ciphertextSha256', 'plaintextHmac'], 'encryption');
  } else {
    throw new Error('Unsupported encryption version');
  }

  if (enc.algorithm !== ALGORITHM) throw new Error('Unsupported encryption algorithm');

  const nonce = mustB64Canonical(enc.nonce, 'nonce');
  const tag = mustB64Canonical(enc.tag, 'tag');
  const ciphertext = mustB64Canonical(enc.ciphertext, 'ciphertext');
  if (nonce.length !== NONCE_BYTES) throw new Error('Invalid nonce size');
  if (tag.length !== TAG_BYTES) throw new Error('Invalid tag size');
  if (ciphertext.length === 0) throw new Error('Empty ciphertext');
  if (enc.ciphertextSha256 !== `sha256:${sha256Hex(ciphertext)}`) throw new Error('ciphertext hash mismatch');

  if (enc.version === VERSION_V2) {
    if (typeof enc.plaintextSha256 !== 'string' || !HASH_RE.test(enc.plaintextSha256)) {
      throw new Error('Invalid plaintext hash format');
    }
  } else {
    if (typeof enc.plaintextHmac !== 'string' || !enc.plaintextHmac.startsWith(`${HMAC_ALGORITHM}:`)) {
      throw new Error('Invalid plaintext hmac format');
    }
    const hmacHex = enc.plaintextHmac.slice(`${HMAC_ALGORITHM}:`.length);
    if (!/^[0-9a-f]{64}$/.test(hmacHex)) throw new Error('Invalid plaintext hmac format');
  }

  const auditCoreSha256 = `sha256:${sha256Hex(Buffer.from(canonicalCore, 'utf8'))}`;
  return { id: protectedRecord.id, auditCoreSha256, encryptionVersion: enc.version };
}

export function restoreProtectedAuditLog(protectedRecord, tenant, repository, key) {
  ensureKey(key);
  const verified = verifyProtectedAuditCore(protectedRecord);
  const enc = protectedRecord.encryption;

  const nonce = Buffer.from(enc.nonce, 'base64');
  const tag = Buffer.from(enc.tag, 'base64');
  const ciphertext = Buffer.from(enc.ciphertext, 'base64');

  const aad = aadFor(
    tenant,
    repository,
    verified.id,
    verified.auditCoreSha256,
    enc.version === VERSION_V2 ? CONTEXT_V2 : CONTEXT_V3,
  );

  let plaintext;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Decryption failed');
  }

  if (enc.version === VERSION_V2) {
    if (`sha256:${sha256Hex(plaintext)}` !== enc.plaintextSha256) throw new Error('plaintext hash mismatch');
  } else {
    const actual = Buffer.from(createHmac('sha256', deriveAuditHmacKey(key)).update(plaintext).digest('hex'), 'hex');
    const expected = Buffer.from(enc.plaintextHmac.slice(`${HMAC_ALGORITHM}:`.length), 'hex');
    if (actual.length !== HMAC_BYTES || expected.length !== HMAC_BYTES || !timingSafeEqual(actual, expected)) {
      throw new Error('plaintext hmac mismatch');
    }
  }

  const { canonical } = parseAndCanonicalizeAuditBuffer(plaintext);
  if (canonical !== protectedRecord.auditCore) throw new Error('Inconsistent audit core');

  return plaintext;
}
