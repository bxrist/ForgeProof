// Version 1 intentionally rejects arbitrary JSON/free-form metadata and credentials.
import { createHash, createPublicKey, verify } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new Error('Non-canonical JSON value');
}
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw new Error('Unknown fields');
}
export function text(value) { if (typeof value !== 'string' || !value.length || value.length > 65536) throw new Error('Invalid text'); }
export function identifier(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid identifier'); }
export function positive(value) { if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid positive integer'); }
export function signatureValid(payload, signature, publicKey) {
  try {
    const key = createPublicKey(publicKey);
    if (typeof signature !== 'string') return false;
    const bytes = Buffer.from(signature, 'base64');
    return key.asymmetricKeyType === 'ed25519' && bytes.length === 64 && bytes.toString('base64') === signature && verify(null, Buffer.from(payload), key, bytes);
  } catch { return false; }
}
const common = 'createdAt updatedAt';
// All credentials, session content, arbitrary metadata and billing instrument data are excluded.
const fields = {
  users: `id email firstName lastName profileImageUrl githubUsername notificationEmail stripeCustomerId defaultRepoId credentialRef ${common}`,
  repositories: `id userId orgId githubId name fullName url defaultBranch description lastSyncedAt ${common}`,
  organizations: `id name slug ownerId description ${common}`,
  orgMembers: `id orgId userId role ${common}`,
  apiKeys: `id userId name permissions isActive lastUsedAt expiresAt credentialRef ${common}`,
  subscriptions: `id userId orgId stripeCustomerId stripeSubscriptionId plan status currentPeriodStart currentPeriodEnd attestationLimit attestationCount apiKeyLimit billingEventCreated billingEventId ${common}`,
  auditLogs: `id userId action resourceType resourceId detailsRef ipAddress ${common}`,
  sessions: `id userId expiresAt custodianRef ${common}`,
  receipts: 'id original',
  receiptAnnotations: 'id receiptEntryHash gitCommitUrl gitCommitMessage createdAt',
  pendingEmails: 'id status retryCount nextRetryAt createdAt originalDigest encryption',
};
export const classes = Object.freeze(Object.keys(fields));
const numbers = new Set('orgId githubId repositoryId attestationLimit attestationCount apiKeyLimit billingEventCreated'.split(' '));
const receiptCommitUrl = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/commit\/([a-f0-9]{40}|[a-f0-9]{64})$/;
export function validateRecord(kind, record) {
  if (!classes.includes(kind)) throw new Error('Unknown record class');
  // Protected historical receipts retain a verified redacted signed core and
  // encrypted exact original bytes. The complete encryption envelope is
  // verified again in GitAppStateService.apply on both append and replay.
  if (kind === 'receipts' && Object.prototype.hasOwnProperty.call(record, 'originalCore')) {
    exact(record, ['id', 'originalCore', 'encryption']);
    positive(record.id);
    return validateReceipt({id: record.id, original: record.originalCore});
  }
  // Historical audit metadata remains encrypted in private Git, not in safe replay.
  if (kind === 'auditLogs' && Object.prototype.hasOwnProperty.call(record, 'auditCore')) {
    exact(record, ['id', 'auditCore', 'encryption']);
    positive(record.id);
    if (typeof record.auditCore !== 'string') throw new Error('Invalid protected audit core');
    const core = JSON.parse(record.auditCore);
    exact(core, ['id','userId','action','resourceType','resourceId','metadata','ipAddress','createdAt']);
    if (core.id !== record.id || core.metadata !== null) throw new Error('Invalid protected audit identity');
    const {metadata: _protected, ...safe} = core;
    return validateRecord('auditLogs', safe);
  }
  if (kind === 'receiptAnnotations') {
    exact(record, ['id','receiptEntryHash','gitCommitUrl','gitCommitMessage','createdAt']);
    positive(record.id);
    if (typeof record.receiptEntryHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.receiptEntryHash)) throw new Error('Invalid annotation receipt hash');
    const pieces = typeof record.gitCommitUrl === 'string' ? receiptCommitUrl.exec(record.gitCommitUrl) : null;
    if (!pieces || [pieces[1],pieces[2]].some(component => component === '.' || component === '..'))
      throw new Error('Invalid annotation git commit URL');
    if (record.gitCommitMessage !== null && (typeof record.gitCommitMessage !== 'string' || record.gitCommitMessage.length < 1 || record.gitCommitMessage.length > 1024)) throw new Error('Invalid annotation git commit message');
    if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('Invalid annotation timestamp');
    return;
  }
  if (kind === 'pendingEmails') {
    exact(record, ['id','status','retryCount','nextRetryAt','createdAt','originalDigest','encryption']);
    positive(record.id);
    if (!['pending','sent','failed'].includes(record.status)) throw new Error('Invalid pending email status');
    if (!Number.isSafeInteger(record.retryCount) || record.retryCount < 0) throw new Error('Invalid pending email retryCount');
    if (typeof record.nextRetryAt !== 'string' || !Number.isFinite(Date.parse(record.nextRetryAt))) throw new Error('Invalid pending email nextRetryAt');
    if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('Invalid pending email createdAt');
    if (typeof record.originalDigest !== 'string' || !/^hmac-sha256:[a-f0-9]{64}$/.test(record.originalDigest)) throw new Error('Invalid pending email originalDigest');
    if (!record.encryption || typeof record.encryption !== 'object' || Array.isArray(record.encryption)) throw new Error('Invalid pending email encryption');
    exact(record.encryption, ['version','algorithm','nonce','tag','ciphertext','ciphertextSha256']);
    return;
  }
  exact(record, fields[kind].split(' '));
  if (kind === 'users' || kind === 'sessions') identifier(record.id); else positive(record.id);
  for (const [key, value] of Object.entries(record)) {
    if (value === null || key === 'id') continue;
    if (numbers.has(key)) { if (!Number.isSafeInteger(value) || value < -1) throw new Error('Invalid numeric field'); }
    else if (key === 'permissions') { if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !/^attest:(read|write)$/.test(v))) throw new Error('Invalid permissions'); }
    else if (key === 'isActive') { if (typeof value !== 'boolean') throw new Error('Invalid boolean'); }
    else { text(value); if ((key.endsWith('At') || ['currentPeriodStart','currentPeriodEnd'].includes(key)) && !Number.isFinite(Date.parse(value))) throw new Error('Invalid timestamp'); if (['userId','ownerId'].includes(key)) identifier(value); if (key.endsWith('Ref') && !/^custodian:[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid custodian reference'); }
  }
  const required = {
    users: [], repositories: ['userId','githubId','name','fullName','url'], organizations: ['name','slug','ownerId'],
    orgMembers: ['orgId','userId','role'], apiKeys: ['userId','name','credentialRef','isActive','permissions'],
    subscriptions: ['userId','plan','status','attestationLimit','attestationCount','apiKeyLimit'],
    auditLogs: ['action'], sessions: ['userId','expiresAt','custodianRef'], receipts: ['original'],
  }[kind];
  for (const key of required) if (record[key] === undefined || record[key] === null) throw new Error('Missing required field: ' + key);
  if (kind === 'subscriptions') {
    if (!['free','pro','enterprise'].includes(record.plan) || !['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused'].includes(record.status)) throw new Error('Invalid subscription state');
    if (record.attestationCount < 0) throw new Error('Invalid usage count');
  }
  if (kind === 'orgMembers' && !['owner','admin','member'].includes(record.role)) throw new Error('Invalid role');
  if (kind === 'receipts') return validateReceipt(record);
}
export const receiptFields = 'id userId orgId repositoryId fileHash fileName filePath modelName modelProvider countryOfOrigin detectedCountry complianceStatus attestationType parentAttestationId auditVerdict auditDetails signature publicKey prevEntryHash entryHash receiptVersion signedAt gitCommitUrl gitCommitMessage metadata createdAt'.split(' ');
export function validateReceipt(record) {
  // The original text is retained byte-for-byte, never reserialized or re-signed.
  const r = JSON.parse(record.original);
  exact(r, receiptFields);
  if (r.id !== record.id) throw new Error('Receipt ID mismatch');
  for (const k of ['fileHash','modelName','modelProvider','countryOfOrigin','entryHash','signature','publicKey','filePath','userId']) text(r[k]);
  for (const k of ['fileHash','modelName','modelProvider','countryOfOrigin']) if (r[k].includes('|')) throw new Error('Ambiguous legacy signed field');
  // Legacy unstructured payloads need explicit external review/custody; never silently import them.
  if (r.metadata != null || r.auditDetails != null) throw new Error('Unstructured receipt content requires reviewed migration');
  if (r.receiptVersion !== 'v1') throw new Error('Unsupported receipt version');
  let timestamp = r.signedAt;
  if (timestamp == null && r.createdAt && Number.isFinite(Date.parse(r.createdAt))) timestamp = new Date(r.createdAt).toISOString();
  if (typeof timestamp !== 'string' || !timestamp.trim() || !Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid receipt timestamp');
  const entry = hash([r.fileHash,r.modelName,r.modelProvider,r.countryOfOrigin,r.prevEntryHash || 'genesis',timestamp].join('|'));
  const pem = `-----BEGIN PUBLIC KEY-----\n${r.publicKey}\n-----END PUBLIC KEY-----`;
  if (entry !== r.entryHash || !signatureValid(`${entry}|${r.fileHash}|${timestamp}`, r.signature, pem)) throw new Error('Invalid historical receipt signature/hash');
  return r;
}
