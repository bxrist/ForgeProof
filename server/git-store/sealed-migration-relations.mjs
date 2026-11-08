import { createHmac, createPublicKey } from 'node:crypto';
import { openSealedFullState } from './full-state-sealed.mjs';
import { receiptFields, validateReceipt } from './schema.mjs';
import { TABLE_ORDER, TABLE_COLUMNS } from './full-state-inventory.mjs';

const GENERIC_ERROR = 'Sealed migration relation check failed';
const RECEIPT_SQL_COLUMNS = [
  'id','user_id','org_id','repository_id','file_hash','file_name','file_path','model_name','model_provider','country_of_origin',
  'detected_country','compliance_status','attestation_type','parent_attestation_id','audit_verdict','audit_details','signature',
  'public_key','prev_entry_hash','entry_hash','receipt_version','signed_at','git_commit_url','git_commit_message','metadata','created_at',
];
const RECEIPT_CAMEL_COLUMNS = [...receiptFields];
const TABLES = [...TABLE_ORDER];

function failClosed() {
  return new Error(GENERIC_ERROR);
}

function hmacHex(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}

function checkTrust(trust) {
  if (!trust || typeof trust !== 'object' || Array.isArray(trust)) throw failClosed();
  const keys = Object.keys(trust);
  if (keys.length !== 2 || !keys.includes('originalReceiptPublicKeys') || !keys.includes('expectedReceiptHeadHash')) throw failClosed();
  if (!Array.isArray(trust.originalReceiptPublicKeys)) throw failClosed();
  const seen=new Set();
  for (const key of trust.originalReceiptPublicKeys) {
    if (typeof key !== 'string' || !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key))
      throw failClosed();
    const bytes = Buffer.from(key, 'base64');
    if (!bytes.length || bytes.toString('base64') !== key) throw failClosed();
    const publicKey=createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519' || seen.has(key)) throw failClosed();
    seen.add(key);
  }
  if (trust.expectedReceiptHeadHash !== null && (typeof trust.expectedReceiptHeadHash !== 'string' || !/^[a-f0-9]{64}$/.test(trust.expectedReceiptHeadHash))) {
    throw failClosed();
  }
}

function toSet(rows, key) {
  const set = new Set();
  for (const row of rows) set.add(row[key]);
  return set;
}

function countMissing(rows, localKey, targetSet) {
  let count = 0;
  for (const row of rows) {
    const value = row[localKey];
    if (value == null) continue;
    if (!targetSet.has(value)) count += 1;
  }
  return count;
}

function countPrivateCustody(fullState) {
  const nonnull=(table,col)=>fullState[table].filter(row=>row[col]!=null).length;
  return {
    githubTokens: nonnull('users','github_token'),
    sqlSessions: fullState.sessions.length,
    apiKeyVerifiers: nonnull('api_keys','key_hash'),
    pendingEmailRecipients: nonnull('pending_emails','to'),
    receiptMetadata: fullState.attestation_receipts.filter(row=>
      row.metadata!=null || row.audit_details!=null).length,
    auditMetadata: nonnull('audit_logs','metadata'),
  };
}

function verifyReceipts(receipts, trust) {
  const sorted = [...receipts].sort((left, right) => left.id - right.id);
  const trustedLegacy = new Set(trust.originalReceiptPublicKeys);
  let invalidSignatures = 0;
  let untrustedSignerCount = 0;
  let predecessorMismatches = 0;

  const mapPairs = RECEIPT_SQL_COLUMNS.map((sqlKey, idx) => [sqlKey, RECEIPT_CAMEL_COLUMNS[idx]]);
  if (mapPairs.length !== 26 ||
      RECEIPT_SQL_COLUMNS.some((col,i)=>TABLE_COLUMNS.attestation_receipts[i]!==col))
    throw failClosed();

  let priorEntryHash = null;
  for (const row of sorted) {
    if (Object.keys(row).length!==RECEIPT_SQL_COLUMNS.length ||
        RECEIPT_SQL_COLUMNS.some(col=>!Object.hasOwn(row,col))) throw failClosed();
    const rebuilt = {};
    for (const [sqlKey, camelKey] of mapPairs) rebuilt[camelKey] = row[sqlKey];

    if (!trustedLegacy.has(rebuilt.publicKey)) untrustedSignerCount += 1;

    const copy = { ...rebuilt, metadata: null, auditDetails: null };
    try {
      validateReceipt({ id: row.id, original: JSON.stringify(copy) });
    } catch {
      invalidSignatures += 1;
    }

    const currentPrev = rebuilt.prevEntryHash ?? null;
    if (priorEntryHash === null) {
      if (currentPrev !== null) predecessorMismatches += 1;
    } else if (currentPrev !== priorEntryHash) {
      predecessorMismatches += 1;
    }
    priorEntryHash = rebuilt.entryHash ?? null;
  }

  const headMismatch = sorted.length===0
    ? Number(trust.expectedReceiptHeadHash !== null)
    : Number(priorEntryHash !== trust.expectedReceiptHeadHash);

  return {
    count: sorted.length,
    invalidSignatures,
    untrustedSignerCount,
    predecessorMismatches,
    headMismatch,
  };
}

export function verifySealedMigrationRelations(envelope, scope, encryptionKey, hmacKey, reviewedManifest, trust) {
  try {
    checkTrust(trust);
    const fullState = openSealedFullState(envelope, scope, encryptionKey, hmacKey, reviewedManifest);

    if (Object.keys(fullState).length !== TABLES.length ||
        TABLES.some(table=>!Array.isArray(fullState[table]))) throw failClosed();
    const users = toSet(fullState.users, 'id');
    const orgs = toSet(fullState.organizations, 'id');
    const repos = toSet(fullState.repositories, 'id');
    const receipts = toSet(fullState.attestation_receipts, 'id');

    const linkFindings = {
      organizationsMissingOwner: countMissing(fullState.organizations, 'owner_id', users),
      repositoriesMissingUser: countMissing(fullState.repositories, 'user_id', users),
      repositoriesMissingOrg: countMissing(fullState.repositories, 'org_id', orgs),
      orgMembersMissingUser: countMissing(fullState.org_members, 'user_id', users),
      orgMembersMissingOrg: countMissing(fullState.org_members, 'org_id', orgs),
      apiKeysMissingUser: countMissing(fullState.api_keys, 'user_id', users),
      subscriptionsMissingUser: countMissing(fullState.subscriptions, 'user_id', users),
      subscriptionsMissingOrg: countMissing(fullState.subscriptions, 'org_id', orgs),
      auditLogsMissingUser: countMissing(fullState.audit_logs, 'user_id', users),
      receiptsMissingUser: countMissing(fullState.attestation_receipts, 'user_id', users),
      receiptsMissingOrg: countMissing(fullState.attestation_receipts, 'org_id', orgs),
      receiptsMissingRepository: countMissing(fullState.attestation_receipts, 'repository_id', repos),
      receiptsMissingParent: countMissing(fullState.attestation_receipts, 'parent_attestation_id', receipts),
    };

    const receiptFindings = verifyReceipts(fullState.attestation_receipts, trust);
    const privateCustodyCounts = countPrivateCustody(fullState);

    const totalFindings = Object.values(linkFindings).reduce((sum, n) => sum + n, 0)
      + receiptFindings.invalidSignatures
      + receiptFindings.untrustedSignerCount
      + receiptFindings.predecessorMismatches
      + receiptFindings.headMismatch;

    return {
      version: 1,
      tableCounts: Object.fromEntries(TABLES.map(table=>[table,fullState[table].length])),
      linkFindings,
      receiptFindings,
      privateCustodyCounts,
      sourceCommitment: envelope.wholeStateCommitment,
      importEligible: totalFindings === 0,
      productionGoAllowed: false,
    };
  } catch {
    throw failClosed();
  }
}
