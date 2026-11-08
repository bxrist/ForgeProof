// Experimental source-only migration stage. Never publish private transactions.
import { createHash, createHmac } from 'node:crypto';
import { canonical, validateRecord } from './schema.mjs';
import { MAX_EVENT_BYTES } from './store.mjs';
import { TABLE_COLUMNS } from './full-state-inventory.mjs';
import { openSealedFullState } from './full-state-sealed.mjs';
import { verifySealedMigrationRelations } from './sealed-migration-relations.mjs';

const ERROR = 'Sealed core Git staging failed';
const fail = () => new Error(ERROR);
const CORE = Object.freeze([
  ['users', 'users'],
  ['organizations', 'organizations'],
  ['repositories', 'repositories'],
  ['org_members', 'orgMembers'],
  ['subscriptions', 'subscriptions'],
]);
const REMAINING = Object.freeze([
  'sessions','attestation_receipts','api_keys','pending_emails','audit_logs'
]);
const SOURCE_TO_GIT = Object.freeze({
  users: [
    ['id','id'], ['email','email'], ['first_name','firstName'],
    ['last_name','lastName'], ['profile_image_url','profileImageUrl'],
    ['github_token','githubTokenRef'], ['github_username','githubUsername'],
    ['notification_email','notificationEmail'],
    ['notify_on_git_failure','notifyOnGitFailure'],
    ['stripe_customer_id','stripeCustomerId'],
    ['default_repo_id','defaultRepoId'], ['detail_repo_id','detailRepoId'],
    ['last_active_tab','lastActiveTab'], ['created_at','createdAt'],
    ['updated_at','updatedAt'],
  ],
  organizations: [
    ['id','id'],['name','name'],['slug','slug'],['owner_id','ownerId'],
    ['description','description'],['created_at','createdAt'],
  ],
  repositories: [
    ['id','id'],['user_id','userId'],['org_id','orgId'],
    ['github_id','githubId'],['name','name'],['full_name','fullName'],
    ['url','url'],['default_branch','defaultBranch'],
    ['description','description'],['last_synced_at','lastSyncedAt'],
    ['created_at','createdAt'],
  ],
  org_members: [
    ['id','id'],['org_id','orgId'],['user_id','userId'],
    ['role','role'],['created_at','createdAt'],
  ],
  subscriptions: [
    ['id','id'],['user_id','userId'],['org_id','orgId'],
    ['stripe_customer_id','stripeCustomerId'],
    ['stripe_subscription_id','stripeSubscriptionId'],
    ['plan','plan'],['status','status'],
    ['current_period_start','currentPeriodStart'],
    ['current_period_end','currentPeriodEnd'],
    ['attestation_limit','attestationLimit'],
    ['attestation_count','attestationCount'],
    ['api_key_limit','apiKeyLimit'],['created_at','createdAt'],
  ],
});
const idHash = id => createHash('sha256').update(id).digest('hex');
const hmac = (key, data) => createHmac('sha256',key).update(data).digest('hex');
const safeScope = scope =>
  scope && typeof scope === 'object' && !Array.isArray(scope) &&
  Object.keys(scope).length === 2 &&
  ['tenantId','repositoryId'].every(key =>
    typeof scope[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(scope[key]));

function verifyMapping(table) {
  const mappings=SOURCE_TO_GIT[table];
  const columns=TABLE_COLUMNS[table];
  if (!Array.isArray(mappings) || mappings.length !== columns.length ||
      mappings.some((pair,i)=>pair[0]!==columns[i]) ||
      new Set(mappings.map(pair=>pair[1])).size!==mappings.length) throw fail();
}
for (const [table] of CORE) verifyMapping(table);

function projectRow(row,table) {
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      Object.keys(row).length !== TABLE_COLUMNS[table].length ||
      TABLE_COLUMNS[table].some(key=>!Object.hasOwn(row,key))) throw fail();
  const record={};
  for (const [sql,git] of SOURCE_TO_GIT[table]) {
    record[git]=sql==='github_token' ? null : row[sql];
  }
  return record;
}
function sortRows(rows,table) {
  if (!Array.isArray(rows)) throw fail();
  return [...rows].sort((a,b)=>{
    if (table==='users') {
      if (typeof a.id!=='string' || typeof b.id!=='string') throw fail();
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    if (!Number.isSafeInteger(a.id) || !Number.isSafeInteger(b.id)) throw fail();
    return a.id-b.id;
  });
}
function verifyKeys(encryptionKey,hmacKey) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length!==32 ||
      !Buffer.isBuffer(hmacKey) || hmacKey.length!==32 ||
      encryptionKey.equals(hmacKey)) throw fail();
}

/**
 * Source-only private staging. This cannot be used as a production cutover.
 * The transaction includes private user profile fields: NEVER log, attach to
 * public GitHub, send to third-party tools, or return to untrusted callers.
 * Existing sessions/keys/mail/evidence remain pending in the sealed source.
 */
export async function stageSealedCoreGitState(
  envelope,scope,encryptionKey,hmacKey,reviewedManifest,receiptTrust,custodian
) {
  try {
    verifyKeys(encryptionKey,hmacKey);
    if (!safeScope(scope)) throw fail();
    const report=verifySealedMigrationRelations(
      envelope,scope,encryptionKey,hmacKey,reviewedManifest,receiptTrust);
    if (!report || report.importEligible!==true ||
        report.productionGoAllowed!==false) throw fail();
    const source=openSealedFullState(
      envelope,scope,encryptionKey,hmacKey,reviewedManifest);
    if (!source || typeof source!=='object' || Array.isArray(source) ||
        Object.keys(source).length!==10) throw fail();

    const numberOfCoreRows=CORE.reduce((n,[table])=>{
      if (!Array.isArray(source[table])) throw fail();
      return n+source[table].length;
    },0);
    if (numberOfCoreRows>1000) throw fail();

    const operations=[], tokens=[];
    for (const [table,kind] of CORE) {
      for (const row of sortRows(source[table],table)) {
        const record=projectRow(row,table);
        validateRecord(kind,record);
        operations.push({kind,id:record.id,action:'put',
          expectedVersion:null,record});
        if (table==='users' && row.github_token!=null) {
          if (typeof row.github_token!=='string' || !row.github_token ||
              row.github_token.length>16384) throw fail();
          tokens.push({operation:operations[operations.length-1],
            userId:row.id, material:row.github_token});
        }
      }
    }

    if (tokens.length &&
        (!custodian || typeof custodian.stage!=='function')) throw fail();
    const sourceCommitment=report.sourceCommitment;
    if (typeof sourceCommitment!=='string' ||
        !/^[a-f0-9]{64}$/.test(sourceCommitment)) throw fail();
    const sourceBinding=scope.tenantId+'/'+scope.repositoryId;
    for (const token of tokens) {
      const userHash=idHash(token.userId);
      const vaultScope=sourceBinding+':github:'+userHash;
      const requestId='migration-'+hmac(hmacKey,
        'forgeproof:0b:github-escrow-v1:'+sourceCommitment+':'+token.userId).slice(0,48);
      const ref=await custodian.stage(vaultScope,requestId,
        {kind:'github-oauth',material:token.material});
      token.operation.record.githubTokenRef=ref;
      validateRecord('users',token.operation.record);
    }

    const transaction=operations.length ? {
      idempotencyKey: 'mcore_'+hmac(hmacKey,
        'forgeproof:0b:core-state-v1:'+sourceBinding+':'+sourceCommitment).slice(0,48),
      operations,
    } : null;
    if (transaction &&
        Buffer.byteLength(canonical(transaction),'utf8')>MAX_EVENT_BYTES-1024) throw fail();

    return {
      version:1,
      transaction,
      summary:{
        coreTableCounts:Object.fromEntries(CORE.map(([table])=>[table,source[table].length])),
        remainingTableCounts:Object.fromEntries(
          REMAINING.map(table=>[table,source[table].length])),
        externalGithubTokenCount:tokens.length,
        sourceCommitment,
        productionGoAllowed:false,
        fullApplicationMigrationComplete:false,
      },
    };
  } catch {
    throw fail();
  }
}
