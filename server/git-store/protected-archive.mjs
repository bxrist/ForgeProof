// Nonproduction evidence-only preflight. This is not the commercial app-state
// cutover: users, keys, sessions, subscriptions and external billing remain separate.
import { createHash, createPublicKey } from 'node:crypto';
import { MAX_EVENT_BYTES } from './store.mjs';
import { receiptFields } from './schema.mjs';
import { protectLegacyReceipt, restoreProtectedReceipt, verifyProtectedReceiptCore } from './protected-receipt.mjs';
import { protectLegacyAuditLog, restoreProtectedAuditLog, verifyProtectedAuditCore } from './protected-audit.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;
const sha = value => createHash('sha256').update(value).digest('hex');

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some(k => !fields.includes(k))) throw new Error('Invalid ' + label + ' fields');
}
function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid ' + label);
}
function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error('Invalid ' + label);
}
function inputRow(item, label) {
  exact(item, ['id','originalBytes'], label);
  if (!Number.isSafeInteger(item.id) || item.id < 1 ||
    !Buffer.isBuffer(item.originalBytes) || !item.originalBytes.length ||
    item.originalBytes.length > MAX_EVENT_BYTES) throw new Error('Invalid ' + label + ' bytes or id');
}
function signerKey(value) {
  if (typeof value !== 'string' || !value || Buffer.from(value,'base64').toString('base64') !== value) {
    throw new Error('Invalid trusted receipt key');
  }
  const pem = '-----BEGIN PUBLIC KEY-----\n' + value + '\n-----END PUBLIC KEY-----';
  try {
    if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('Wrong key type');
  } catch { throw new Error('Invalid trusted receipt key'); }
}
function prepareInput(source, key) {
  exact(source,['version','tenant','repository','manifest','receipts','auditLogs'],'source');
  if (source.version !== 2) throw new Error('Unsupported source version');
  identifier(source.tenant,'tenant');
  identifier(source.repository,'repository');
  if (!Array.isArray(source.receipts) || !Array.isArray(source.auditLogs)) throw new Error('Missing evidence arrays');
  exact(source.manifest,[
    'expectedReceiptCount','expectedAuditCount','expectedHeadHash',
    'trustedOriginalReceiptPublicKeys','sourceDbFingerprint'
  ],'reviewed manifest');
  count(source.manifest.expectedReceiptCount,'receipt count');
  count(source.manifest.expectedAuditCount,'audit count');
  if (!HEX64.test(source.manifest.expectedHeadHash)) throw new Error('Invalid expected head hash');
  if (typeof source.manifest.sourceDbFingerprint !== 'string' ||
    !source.manifest.sourceDbFingerprint.length || source.manifest.sourceDbFingerprint.length > 128)
    throw new Error('Invalid source fingerprint');
  if (!Array.isArray(source.manifest.trustedOriginalReceiptPublicKeys) ||
    !source.manifest.trustedOriginalReceiptPublicKeys.length) throw new Error('Missing trusted receipt keys');
  const keys=new Set();
  for (const value of source.manifest.trustedOriginalReceiptPublicKeys) {
    signerKey(value);
    if (keys.has(value)) throw new Error('Duplicate trusted receipt key');
    keys.add(value);
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid private archive key');
  if (source.receipts.length !== source.manifest.expectedReceiptCount) throw new Error('Receipt count mismatch');
  if (source.auditLogs.length !== source.manifest.expectedAuditCount) throw new Error('Audit count mismatch');
  return keys;
}
function checkedTransaction(kind, id, record, sourceTag) {
  const transaction={
    idempotencyKey: 'arch-'+sourceTag+'-'+(kind==='receipts'?'r':'a')+'-'+id,
    operations:[{kind,id,action:'put',expectedVersion:null,record}]
  };
  // Preserve the already enforced Git event envelope ceiling, without a new
  // invented independent size gate. Full signed preflight runs again in CLI.
  if (Buffer.byteLength(JSON.stringify(transaction)) + 2048 > MAX_EVENT_BYTES) {
    throw new Error('Signed event size ceiling would be exceeded');
  }
  return transaction;
}
/** Verify all source rows in memory, then return ONLY encrypted Git transactions.
 * The caller must durably store the sealed stage once; random GCM nonces mean
 * regenerating it is not a safe way to retry the same idempotency keys.
 * This does not query Postgres or emit plaintext source rows to disk/logs.
 */
export function buildProtectedHistoricalArchivePreflight(source, encryptionKey) {
  const trustedKeys=prepareInput(source,encryptionKey);
  const sourceTag=sha(source.manifest.sourceDbFingerprint).slice(0,20);
  const receipts=[], audits=[], seenReceiptIds=new Set(), seenAuditIds=new Set();
  for (const item of source.receipts) {
    inputRow(item,'receipt');
    if (seenReceiptIds.has(item.id)) throw new Error('Duplicate receipt id');
    seenReceiptIds.add(item.id);
    const sourceText=item.originalBytes.toString('utf8');
    if (!Buffer.from(sourceText,'utf8').equals(item.originalBytes)) throw new Error('Invalid UTF-8 source receipt');
    let sourceRow;
    try { sourceRow=JSON.parse(sourceText); } catch { throw new Error('Invalid source receipt JSON'); }
    // The SQL export must include every current receipt column. Signature validation
    // alone cannot detect an omitted unsigned column or lost metadata.
    exact(sourceRow,receiptFields,'complete SQL receipt row');
    const record=protectLegacyReceipt(item.originalBytes,source.tenant,source.repository,encryptionKey);
    if (record.id !== item.id) throw new Error('Receipt id mismatch');
    const core=verifyProtectedReceiptCore(record); // real Ed25519 / entry hash check
    if (!trustedKeys.has(core.publicKey)) throw new Error('Untrusted historical signer');
    if (!restoreProtectedReceipt(record,source.tenant,source.repository,encryptionKey).equals(item.originalBytes))
      throw new Error('Receipt source bytes mismatch');
    receipts.push({id:item.id,core,record});
  }
  receipts.sort((a,b)=>a.id-b.id);
  let predecessor=null;
  for (const item of receipts) {
    if (item.core.prevEntryHash !== predecessor) throw new Error('Receipt predecessor mismatch');
    predecessor=item.core.entryHash;
  }
  if ((predecessor || '0'.repeat(64)) !== source.manifest.expectedHeadHash)
    throw new Error('Reviewed receipt head mismatch');
  for (const item of source.auditLogs) {
    inputRow(item,'audit');
    if (seenAuditIds.has(item.id)) throw new Error('Duplicate audit id');
    seenAuditIds.add(item.id);
    const record=protectLegacyAuditLog(item.originalBytes,source.tenant,source.repository,encryptionKey);
    if (record.id !== item.id) throw new Error('Audit id mismatch');
    verifyProtectedAuditCore(record);
    if (!restoreProtectedAuditLog(record,source.tenant,source.repository,encryptionKey).equals(item.originalBytes))
      throw new Error('Audit source bytes mismatch');
    audits.push({id:item.id,record});
  }
  audits.sort((a,b)=>a.id-b.id);
  const transactions=[
    ...receipts.map(item=>checkedTransaction('receipts',item.id,item.record,sourceTag)),
    ...audits.map(item=>checkedTransaction('auditLogs',item.id,item.record,sourceTag))
  ];
  const stagedMigration={version:1,transactions};
  return {
    stagedMigration,
    stageDigest:'sha256:'+sha(JSON.stringify(stagedMigration)),
    reviewedManifest:{
      expectedReceiptCount:source.manifest.expectedReceiptCount,
      expectedAuditCount:source.manifest.expectedAuditCount,
      expectedHeadHash:source.manifest.expectedHeadHash,
      sourceDbFingerprint:source.manifest.sourceDbFingerprint
    },
    sourceSummary:{receiptCount:receipts.length,auditCount:audits.length,
      headHash:predecessor,uniqueOriginalSigners:new Set(receipts.map(x=>x.core.publicKey)).size}
  };
}
