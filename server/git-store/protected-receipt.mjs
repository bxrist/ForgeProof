import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { validateReceipt } from './schema.mjs';

const VERSION_V2 = 2;
const VERSION_V3 = 3;
const ALGORITHM = 'aes-256-gcm';
const CONTEXT_V2 = 'ForgeProof-protected-receipt-v2';
const CONTEXT_V3 = 'ForgeProof-protected-receipt-v3';
const HMAC_ALGORITHM = 'hmac-sha256';
const HKDF_INFO = 'ForgeProof/protected-receipt/plaintext-hmac/v3';
const HKDF_SALT = Buffer.from('ForgeProof/protected-receipt/hkdf-salt/v3', 'utf8');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HMAC_BYTES = 32;

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
  if (bytes.length === 0 && value !== '') throw new Error(`Invalid ${name}`);
  if (bytes.toString('base64') !== value) throw new Error(`Non-canonical ${name}`);
  return bytes;
}

function parseAndCanonicalizeOriginalCoreText(originalCore) {
  if (typeof originalCore !== 'string' || originalCore.length === 0) throw new Error('Invalid originalCore');
  const parsed = JSON.parse(originalCore);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid originalCore');
  const copy = { ...parsed, metadata: null, auditDetails: null };
  return JSON.stringify(copy);
}

function parseAndCanonicalizeReceiptBuffer(bytes) {
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid receipt payload');
  const copy = { ...parsed, metadata: null, auditDetails: null };
  return { parsed, canonical: JSON.stringify(copy) };
}

function aadFor(tenant, repository, id, entryHash, context) {
  if (typeof tenant !== 'string' || tenant.length === 0) throw new Error('Invalid tenant');
  if (typeof repository !== 'string' || repository.length === 0) throw new Error('Invalid repository');
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id');
  if (typeof entryHash !== 'string' || entryHash.length === 0) throw new Error('Invalid entryHash');
  return Buffer.from(JSON.stringify([context, tenant, repository, id, entryHash]), 'utf8');
}

function ensureKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid key');
}

function deriveReceiptHmacKey(key) {
  return hkdfSync('sha256', key, HKDF_SALT, Buffer.from(HKDF_INFO, 'utf8'), HMAC_BYTES);
}

export function protectLegacyReceipt(originalBytes, tenant, repository, key) {
  if (!Buffer.isBuffer(originalBytes) || originalBytes.length === 0) throw new Error('Invalid originalBytes');
  ensureKey(key);

  const { parsed, canonical } = parseAndCanonicalizeReceiptBuffer(originalBytes);
  const verified = validateReceipt({ id: parsed.id, original: canonical });
  const id = verified.id;
  const entryHash = verified.entryHash;

  const nonce = randomBytes(NONCE_BYTES);
  const aad = aadFor(tenant, repository, id, entryHash, CONTEXT_V3);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(originalBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const plaintextHmac = createHmac('sha256', deriveReceiptHmacKey(key)).update(originalBytes).digest('hex');

  return {
    id,
    originalCore: canonical,
    encryption: {
      version: VERSION_V3,
      algorithm: ALGORITHM,
      nonce: nonce.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      ciphertextSha256: `sha256:${sha256Bytes(ciphertext)}`,
      plaintextHmac: `${HMAC_ALGORITHM}:${plaintextHmac}`,
    },
  };
}

export function verifyProtectedReceiptCore(protectedRecord) {
  exactKeys(protectedRecord, ['id', 'originalCore', 'encryption'], 'protectedRecord');
  if (!Number.isInteger(protectedRecord.id) || protectedRecord.id <= 0) throw new Error('Invalid id');
  const canonicalCore = parseAndCanonicalizeOriginalCoreText(protectedRecord.originalCore);
  if (canonicalCore !== protectedRecord.originalCore) throw new Error('Non-canonical originalCore');

  const verified = validateReceipt({ id: protectedRecord.id, original: protectedRecord.originalCore });

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
  if (enc.ciphertextSha256 !== `sha256:${sha256Bytes(ciphertext)}`) throw new Error('ciphertext hash mismatch');

  if (enc.version === VERSION_V2) {
    if (typeof enc.plaintextSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(enc.plaintextSha256)) {
      throw new Error('Invalid plaintext hash format');
    }
  } else {
    if (typeof enc.plaintextHmac !== 'string' || !enc.plaintextHmac.startsWith(`${HMAC_ALGORITHM}:`)) {
      throw new Error('Invalid plaintext hmac format');
    }
    const hmacHex = enc.plaintextHmac.slice(`${HMAC_ALGORITHM}:`.length);
    if (!/^[0-9a-f]{64}$/.test(hmacHex)) throw new Error('Invalid plaintext hmac format');
  }

  // All signed originalCore fields must survive keyless verification. The
  // append/replay engine needs the pinned receipt public key, owner and actual
  // predecessor to enforce the signed chain and parent ownership.
  return {...verified, encryptionVersion: enc.version};
}

export function restoreProtectedReceipt(protectedRecord, tenant, repository, key) {
  ensureKey(key);
  const verified = verifyProtectedReceiptCore(protectedRecord);
  const enc = protectedRecord.encryption;
  const nonce = Buffer.from(enc.nonce, 'base64');
  const tag = Buffer.from(enc.tag, 'base64');
  const ciphertext = Buffer.from(enc.ciphertext, 'base64');

  const aad = aadFor(
    tenant,
    repository,
    verified.id,
    verified.entryHash,
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
    if (`sha256:${sha256Bytes(plaintext)}` !== enc.plaintextSha256) throw new Error('plaintext hash mismatch');
  } else {
    const actual = Buffer.from(createHmac('sha256', deriveReceiptHmacKey(key)).update(plaintext).digest('hex'), 'hex');
    const expected = Buffer.from(enc.plaintextHmac.slice(`${HMAC_ALGORITHM}:`.length), 'hex');
    if (actual.length !== HMAC_BYTES || expected.length !== HMAC_BYTES || !timingSafeEqual(actual, expected)) {
      throw new Error('plaintext hmac mismatch');
    }
  }

  const { canonical } = parseAndCanonicalizeReceiptBuffer(plaintext);
  if (canonical !== protectedRecord.originalCore) throw new Error('Inconsistent original core');

  return plaintext;
}
