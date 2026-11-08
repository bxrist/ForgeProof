import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {TABLE_ORDER,TABLE_COLUMNS} from '../server/git-store/full-state-inventory.mjs';
import {captureSealedFullState} from '../server/git-store/full-state-sealed.mjs';
import {verifySealedMigrationRelations} from '../server/git-store/sealed-migration-relations.mjs';

const BEGIN_SQL='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const LOCAL_TIMEOUT_SQL="SET LOCAL statement_timeout='30s'";
const COMMIT_SQL='COMMIT';
const ROLLBACK_SQL='ROLLBACK';
function scope() {
  return { tenantId: 'tenant_alpha', repositoryId: 'repo_main' };
}

function fixture() {
  return {
    users: [{ id: 'user_1', email: 'EMAIL_RECIPIENT@secret.example', first_name: 'Ada', last_name: 'Lovelace', profile_image_url: 'https://img.example/x', github_token: 'SENTINEL_TOKEN', github_username: 'ada', notification_email: 'notify@example.com', notify_on_git_failure: true, stripe_customer_id: 'cus_1', default_repo_id: 10, detail_repo_id: 10, last_active_tab: 'dashboard', created_at: new Date('2025-01-01T00:00:00.000Z'), updated_at: new Date('2025-01-02T00:00:00.000Z') }],
    sessions: [{ sid: 'SESSION_SECRET', sess: { body: 'SESSION' }, expire: new Date('2025-01-03T00:00:00.000Z') }],
    repositories: [{ id: 10, user_id: 'user_1', org_id: 77, github_id: 1001, name: 'repo', full_name: 'o/repo', url: 'https://github.com/o/repo', default_branch: 'main', description: 'd', last_synced_at: new Date('2025-01-04T00:00:00.000Z'), created_at: new Date('2025-01-05T00:00:00.000Z') }],
    attestation_receipts: [{ id: 20, user_id: 'user_1', org_id: 77, repository_id: 10, file_hash: 'sha256:abc', file_name: 'x.ts', file_path: 'src/x.ts', model_name: 'm', model_provider: 'p', country_of_origin: 'US', detected_country: 'US', compliance_status: 'ok', attestation_type: 'origin', parent_attestation_id: null, audit_verdict: 'pass', audit_details: { nested: 'json' }, signature: 'sig', public_key: 'pk', prev_entry_hash: null, entry_hash: 'eh', receipt_version: 'v1', signed_at: new Date('2025-01-06T00:00:00.000Z'), git_commit_url: 'https://git/c', git_commit_message: 'm', metadata: { RECEIPT_PRIVATE_METADATA: 'secret' }, created_at: new Date('2025-01-07T00:00:00.000Z') }],
    api_keys: [{ id: 30, user_id: 'user_1', name: 'k', key_hash: 'API_KEY_VERIFIER', key_prefix: 'fp_sk_', permissions: ['read'], is_active: true, last_used_at: null, expires_at: null, created_at: new Date('2025-01-08T00:00:00.000Z') }],
    organizations: [{ id: 77, name: 'org', slug: 'org', owner_id: 'user_1', description: 'desc', created_at: new Date('2025-01-09T00:00:00.000Z') }],
    org_members: [{ id: 88, org_id: 77, user_id: 'user_1', role: 'owner', created_at: new Date('2025-01-10T00:00:00.000Z') }],
    subscriptions: [{ id: 90, user_id: 'user_1', org_id: 77, stripe_customer_id: 'cus', stripe_subscription_id: 'sub', plan: 'pro', status: 'active', current_period_start: new Date('2025-01-11T00:00:00.000Z'), current_period_end: new Date('2025-02-11T00:00:00.000Z'), attestation_limit: 100, attestation_count: 1, api_key_limit: 3, created_at: new Date('2025-01-12T00:00:00.000Z') }],
    pending_emails: [{ id: 99, to: 'EMAIL_RECIPIENT@example.com', subject: 's', body_html: '<p>EMAIL_BODY</p>', body_text: 'EMAIL_BODY', retry_count: 0, next_retry_at: null, status: 'queued', created_at: new Date('2025-01-13T00:00:00.000Z') }],
    audit_logs: [{ id: 111, user_id: 'user_1', action: 'create', resource_type: 'repo', resource_id: '10', metadata: { AUDIT_METADATA: 'sensitive' }, ip_address: '127.0.0.1', created_at: new Date('2025-01-14T00:00:00.000Z') }],
  };
}

function manifestFromFixture(data) {
  return {
    version: 1,
    sourceDbFingerprint: 'reviewed-db-fingerprint',
    tables: Object.fromEntries(TABLE_ORDER.map((table) => [table, { expectedRowCount: data[table].length, reviewedSchemaColumns: undefined }])),
  };
}

function fakeClient(data, opts = {}) {
  return {
    calls: [],
    async query(sql) {
      this.calls.push(sql);
      if (opts.failSql && sql === opts.failSql) throw new Error('DB_URL=SECRET_DATABASE_URL_SENTINEL');
      if (sql === BEGIN_SQL || sql === LOCAL_TIMEOUT_SQL || sql === COMMIT_SQL || sql === ROLLBACK_SQL) return { rows: [] };
      const match = sql.match(/^SELECT \* FROM "([a-z_]+)" ORDER BY "(id|sid)"$/);
      if (!match) throw new Error('bad sql');
      const table = match[1];
      return { rows: data[table] ?? [] };
    },
  };
}


function signedFixture() {
  const data=fixture();
  const keys=generateKeyPairSync('ed25519');
  const publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const stamp='2026-11-08T00:00:00.000Z';
  const fileHash='sha256:'+'a'.repeat(64);
  const create=(id,prev,parent,metadata)=>{
    const row={...data.attestation_receipts[0],id,
      user_id:'user_1',org_id:77,repository_id:10,file_hash:fileHash,
      model_name:'synthetic-model',model_provider:'synthetic-provider',
      country_of_origin:'unknown',prev_entry_hash:prev,
      signed_at:new Date(stamp),created_at:new Date(stamp),
      public_key:publicKey,receipt_version:'v1',parent_attestation_id:parent,
      audit_details:null,metadata,git_commit_url:null,git_commit_message:null};
    row.entry_hash=createHash('sha256').update(
      [row.file_hash,row.model_name,row.model_provider,row.country_of_origin,
       prev??'genesis',stamp].join('|')).digest('hex');
    row.signature=sign(null,Buffer.from(
      [row.entry_hash,row.file_hash,stamp].join('|')),keys.privateKey).toString('base64');
    return row;
  };
  const one=create(20,null,null,{private:'RECEIPT_PRIVATE_METADATA_SENTINEL'});
  const two=create(21,one.entry_hash,20,null);
  data.attestation_receipts=[one,two];
  return {data,trust:{originalReceiptPublicKeys:[publicKey],expectedReceiptHeadHash:two.entry_hash}};
}
async function sealedFixture(data) {
  const enc=randomBytes(32),mac=randomBytes(32),manifest=manifestFromFixture(data);
  const envelope=await captureSealedFullState(fakeClient(data),manifest,scope(),enc,mac);
  const read=(trust)=>verifySealedMigrationRelations(envelope,scope(),enc,mac,manifest,trust);
  return {enc,mac,manifest,envelope,read};
}

test('complete actual snake-case SQL records have valid Ed25519 chain, references and no secret output',async()=>{
  const {data,trust}=signedFixture();
  const {envelope,read}=await sealedFixture(data);
  const result=read(trust);
  assert.equal(result.version,1);
  assert.equal(result.productionGoAllowed,false);
  assert.equal(result.importEligible,true);
  assert.deepEqual(Object.keys(result.tableCounts).sort(),[...TABLE_ORDER].sort());
  assert.equal(result.tableCounts.attestation_receipts,2);
  assert.equal(result.tableCounts.pending_emails,1);
  assert.deepEqual(result.receiptFindings,{count:2,invalidSignatures:0,
    untrustedSignerCount:0,predecessorMismatches:0,headMismatch:0});
  assert.ok(Object.values(result.linkFindings).every(x=>x===0));
  assert.equal(result.privateCustodyCounts.githubTokens,1);
  assert.equal(result.privateCustodyCounts.sqlSessions,1);
  assert.equal(result.privateCustodyCounts.apiKeyVerifiers,1);
  assert.equal(result.privateCustodyCounts.pendingEmailRecipients,1);
  assert.equal(result.privateCustodyCounts.receiptMetadata,1);
  assert.equal(result.privateCustodyCounts.auditMetadata,1);
  assert.equal(result.sourceCommitment,envelope.wholeStateCommitment);
  const visible=JSON.stringify(result);
  for(const privateText of ['EMAIL_RECIPIENT','SENTINEL_TOKEN','API_KEY_VERIFIER',
    'SESSION_SECRET','RECEIPT_PRIVATE_METADATA_SENTINEL','AUDIT_METADATA',
    'reviewed-db-fingerprint','user_1','sha256:'])
    assert.ok(!visible.includes(privateText),privateText);
});

test('wrong but well-formed pinned signer is reported by count, not by key disclosure',async()=>{
  const {data,trust}=signedFixture();
  const {read}=await sealedFixture(data);
  const other=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64');
  const report=read({...trust,originalReceiptPublicKeys:[other]});
  assert.equal(report.receiptFindings.untrustedSignerCount,2);
  assert.equal(report.importEligible,false);
  assert.ok(!JSON.stringify(report).includes(other));
});

test('missing users, organizations, repositories and receipt parents counted without leaking identifiers',async()=>{
  const {data,trust}=signedFixture();
  data.organizations[0].owner_id='missing_owner';
  data.repositories[0].user_id='missing_user';
  data.repositories[0].org_id=909;
  data.attestation_receipts[1].user_id='missing_user';
  data.attestation_receipts[1].org_id=909;
  data.attestation_receipts[1].repository_id=909;
  data.attestation_receipts[1].parent_attestation_id=909;
  const {read}=await sealedFixture(data);
  const r=read(trust);
  assert.equal(r.linkFindings.organizationsMissingOwner,1);
  assert.equal(r.linkFindings.repositoriesMissingUser,1);
  assert.equal(r.linkFindings.repositoriesMissingOrg,1);
  assert.equal(r.linkFindings.receiptsMissingUser,1);
  assert.equal(r.linkFindings.receiptsMissingOrg,1);
  assert.equal(r.linkFindings.receiptsMissingRepository,1);
  assert.equal(r.linkFindings.receiptsMissingParent,1);
  assert.equal(r.receiptFindings.invalidSignatures,0);
  assert.equal(r.importEligible,false);
  assert.ok(!JSON.stringify(r).includes('missing_owner'));
});

test('wrong independently pinned head produces count without displaying head bytes',async()=>{
  const {data,trust}=signedFixture();
  const {read}=await sealedFixture(data);
  const expected='a'.repeat(64);
  const r=read({...trust,expectedReceiptHeadHash:expected});
  assert.equal(r.receiptFindings.headMismatch,1);
  assert.equal(r.importEligible,false);
  assert.ok(!JSON.stringify(r).includes(expected));
});

test('signed predecessor mismatch and invalid signature are both observed',async()=>{
  const {data,trust}=signedFixture();
  data.attestation_receipts[1].prev_entry_hash='b'.repeat(64);
  const {read}=await sealedFixture(data);
  const r=read(trust);
  assert.equal(r.receiptFindings.predecessorMismatches,1);
  assert.equal(r.receiptFindings.invalidSignatures,1);
  assert.equal(r.importEligible,false);
});

test('wrong keys, source manifest and malformed ciphertext return only generic error',async()=>{
  const {data,trust}=signedFixture();
  const {envelope,enc,mac,manifest}=await sealedFixture(data);
  const bad=structuredClone(envelope);
  bad.tableRecords[0].nonceBase64='INVALID_CUSTOMER_SECRET';
  for(const call of [
    ()=>verifySealedMigrationRelations(bad,scope(),enc,mac,manifest,trust),
    ()=>verifySealedMigrationRelations(envelope,scope(),randomBytes(32),mac,manifest,trust),
    ()=>verifySealedMigrationRelations(envelope,scope(),enc,mac,
      {...manifest,sourceDbFingerprint:'alternate-source'},trust)
  ]) assert.throws(call,e=>e.message==='Sealed migration relation check failed');
});

test('no receipts requires null independent head and uses all ten table classes',async()=>{
  const {data,trust}=signedFixture();
  data.attestation_receipts=[];
  const {read}=await sealedFixture(data);
  const r=read({originalReceiptPublicKeys:trust.originalReceiptPublicKeys,expectedReceiptHeadHash:null});
  assert.equal(r.receiptFindings.count,0);
  assert.equal(r.receiptFindings.headMismatch,0);
  assert.equal(r.tableCounts.attestation_receipts,0);
  assert.equal(r.importEligible,true);
  const bad=read(trust);
  assert.equal(bad.receiptFindings.headMismatch,1);
});
