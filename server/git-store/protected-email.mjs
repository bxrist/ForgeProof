import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { exact } from './schema.mjs';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_MESSAGE_BYTES = 512 * 1024;

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}
function keyedDigest(input,key) {
  return 'hmac-sha256:' + createHmac('sha256',key).update(input).digest('hex');
}

function ensureIso(value, field) {
  if (typeof value !== 'string' || !value.length || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${field}`);
}

function mustCanonicalBase64(value, field) {
  if (typeof value !== 'string' || !value.length) throw new Error(`Invalid ${field}`);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) throw new Error(`Invalid canonical base64 ${field}`);
  return bytes;
}

function ensureKey(keyBuffer32) {
  if (!Buffer.isBuffer(keyBuffer32) || keyBuffer32.length !== 32) throw new Error('Invalid mail encryption key');
}

function ensureIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${field}`);
}

function aadFor(tenant, repository, id, originalDigest) {
  ensureIdentifier(tenant, 'tenant');
  ensureIdentifier(repository, 'repository');
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid id');
  if (typeof originalDigest !== 'string' || !/^hmac-sha256:[a-f0-9]{64}$/.test(originalDigest)) throw new Error('Invalid original digest');
  return Buffer.from(JSON.stringify(['forgeproof:protected-email:v1', tenant, repository, id, originalDigest]), 'utf8');
}

function canonicalEnvelope(email) {
  exact(email, ['to', 'subject', 'bodyText', 'bodyHtml']);
  for (const field of ['to', 'subject', 'bodyText', 'bodyHtml']) {
    if (typeof email[field] !== 'string') throw new Error(`Invalid ${field}`);
  }
  const canonical = JSON.stringify(email);
  const bytes = Buffer.from(canonical, 'utf8');
  if (!email.to.trim() || !email.subject.trim() || (!email.bodyText.trim() && !email.bodyHtml.trim())) throw new Error('Incomplete pending email content');
  if (/[\r\n]/.test(email.to) || /[\r\n]/.test(email.subject)) throw new Error('Invalid email header characters');
  if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('Pending email exceeds 512KiB');
  return bytes;
}

export function protectQueuedEmail(email, tenant, repository, id, keyBuffer32) {
  ensureKey(keyBuffer32);
  const original = canonicalEnvelope(email);
  // An unkeyed plaintext hash leaks content via offline dictionary guesses.
  const originalDigest = keyedDigest(original,keyBuffer32);
  const nonce = randomBytes(NONCE_BYTES);
  const aad = aadFor(tenant, repository, id, originalDigest);
  const cipher = createCipheriv(ALGORITHM, keyBuffer32, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(original), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    originalDigest,
    encryption: {
      version: VERSION,
      algorithm: ALGORITHM,
      nonce: nonce.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      ciphertextSha256: `sha256:${sha256(ciphertext)}`,
    },
  };
}

export function verifyProtectedEmailCore(record) {
  exact(record, ['id', 'status', 'retryCount', 'nextRetryAt', 'createdAt', 'originalDigest', 'encryption']);
  if (!Number.isSafeInteger(record.id) || record.id < 1) throw new Error('Invalid id');
  if (!['pending', 'sent', 'failed'].includes(record.status)) throw new Error('Invalid status');
  if (!Number.isSafeInteger(record.retryCount) || record.retryCount < 0) throw new Error('Invalid retryCount');
  ensureIso(record.nextRetryAt, 'nextRetryAt');
  ensureIso(record.createdAt, 'createdAt');
  if (typeof record.originalDigest !== 'string' || !/^hmac-sha256:[a-f0-9]{64}$/.test(record.originalDigest)) throw new Error('Invalid originalDigest');
  const enc = record.encryption;
  exact(enc, ['version', 'algorithm', 'nonce', 'tag', 'ciphertext', 'ciphertextSha256']);
  if (enc.version !== VERSION) throw new Error('Unsupported encryption version');
  if (enc.algorithm !== ALGORITHM) throw new Error('Unsupported encryption algorithm');
  const nonce = mustCanonicalBase64(enc.nonce, 'nonce');
  const tag = mustCanonicalBase64(enc.tag, 'tag');
  const ciphertext = mustCanonicalBase64(enc.ciphertext, 'ciphertext');
  if (nonce.length !== NONCE_BYTES) throw new Error('Invalid nonce size');
  if (tag.length !== TAG_BYTES) throw new Error('Invalid tag size');
  if (!ciphertext.length || ciphertext.length > MAX_MESSAGE_BYTES) throw new Error('Invalid ciphertext size');
  if (enc.ciphertextSha256 !== `sha256:${sha256(ciphertext)}`) throw new Error('ciphertext hash mismatch');
  return record;
}

export function restoreQueuedEmail(record, tenant, repository, keyBuffer32) {
  ensureKey(keyBuffer32);
  const verified = verifyProtectedEmailCore(record);
  const nonce = Buffer.from(verified.encryption.nonce, 'base64');
  const tag = Buffer.from(verified.encryption.tag, 'base64');
  const ciphertext = Buffer.from(verified.encryption.ciphertext, 'base64');
  const aad = aadFor(tenant, repository, verified.id, verified.originalDigest);
  const decipher = createDecipheriv(ALGORITHM, keyBuffer32, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Decryption failed');
  }
  if (keyedDigest(plaintext,keyBuffer32) !== verified.originalDigest) throw new Error('Plaintext HMAC mismatch');
  if (plaintext.length > MAX_MESSAGE_BYTES) throw new Error('Pending email exceeds 512KiB');
  const email = JSON.parse(plaintext.toString('utf8'));
  exact(email, ['to', 'subject', 'bodyText', 'bodyHtml']);
  for (const field of ['to', 'subject', 'bodyText', 'bodyHtml']) {
    if (typeof email[field] !== 'string') throw new Error(`Invalid ${field}`);
  }
  return email;
}
