import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {captureSealedFullState} from '../server/git-store/full-state-sealed.mjs';
import {stageSealedCoreGitState} from '../server/git-store/sealed-core-stage.mjs';
import {stageSealedHistoricalGitEvidence} from '../server/git-store/sealed-evidence-stage.mjs';
import {restoreProtectedReceipt} from '../server/git-store/protected-receipt.mjs';
import {restoreProtectedAuditLog} from '../server/git-store/protected-audit.mjs';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {EncryptedProviderCustodian} from '../server/git-store/custody.ts';
import {TABLE_ORDER,TABLE_COLUMNS} from '../server/git-store/full-state-inventory.mjs';

const BEGIN_SQL='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const LOCAL_TIMEOUT_SQL="SET LOCAL statement_timeout='30s'";
const COMMIT_SQL='COMMIT',ROLLBACK_SQL='ROLLBACK';
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


class MemoryVault {
 data=new Map();
 async transact(scope,change) {
  const {envelope,result}=change(this.data.get(scope));
  this.data.set(scope,envelope);
  return result;
 }
}
async function sealedSource(changes) {
 const {data,trust}=signedFixture();
 data.users[0].default_repo_id=String(data.users[0].default_repo_id);
 data.users[0].detail_repo_id=String(data.users[0].detail_repo_id);
 if(changes)changes(data,trust);
 const manifest=manifestFromFixture(data);
 const enc=randomBytes(32), mac=randomBytes(32), archiveKey=randomBytes(32);
 const envelope=await captureSealedFullState(fakeClient(data),manifest,scope(),enc,mac);
 const vault=new MemoryVault();
 const custody=new EncryptedProviderCustodian(vault,randomBytes(32));
 return {data,trust,manifest,enc,mac,archiveKey,envelope,vault,custody};
}
const stage=(f,trust=f.trust,archiveKey=f.archiveKey)=>
 stageSealedHistoricalGitEvidence(f.envelope,scope(),f.enc,f.mac,f.manifest,trust,archiveKey);

async function signedService(t,receiptKeys) {
 const root=await mkdtemp(join(tmpdir(),'fp-0b-evidence-stage-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const bare=join(root,'private.git');
 execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
 const pair=generateKeyPairSync('ed25519');
 const opts={directory:bare,tenant:'tenant_alpha',repository:'repo_main',
   checkpoint:null,
   trust:{eventKeys:{fixture:{actor:'fixture',
      publicKey:pair.publicKey.export({type:'spki',format:'pem'})}},
      receiptKeys,receiptPredecessor:null},
   signer:{actor:'fixture',keyId:'fixture',
      sign:async bytes=>sign(null,bytes,pair.privateKey).toString('base64')}};
 return {root,bare,opts,service:new GitAppStateService(opts)};
}

test('same sealed source can stage core, true original-signed receipts and full private audits and independently recover signed history',async t=>{
 const f=await sealedSource();
 const core=await stageSealedCoreGitState(f.envelope,scope(),
   f.enc,f.mac,f.manifest,f.trust,f.custody);
 assert.equal(core.transaction.operations.length,5);
 const packaged=stage(f);
 assert.equal(packaged.privateStage.transactions.length,3);
 assert.equal(packaged.summary.receiptCount,2);
 assert.equal(packaged.summary.auditCount,1);
 assert.equal(packaged.summary.encryptedPrivateReceiptCount,1);
 assert.equal(packaged.summary.encryptedAuditMetadataCount,1);
 assert.equal(packaged.summary.mustPersistExactStageBeforeAnyAppend,true);
 assert.equal(packaged.summary.productionGoAllowed,false);
 assert.equal(packaged.summary.fullApplicationMigrationComplete,false);
 assert.match(packaged.summary.stageDigest,/^hmac-sha256:[a-f0-9]{64}$/);
 const serialized=JSON.stringify(packaged.privateStage);
 for(const secret of ['RECEIPT_PRIVATE_METADATA_SENTINEL','AUDIT_METADATA','EMAIL_BODY','SESSION_SECRET','SENTINEL_TOKEN'])
   assert.equal(serialized.includes(secret),false,secret);
 assert.ok(packaged.privateStage.transactions.every(tx=>tx.operations.length===1 && tx.operations[0].action==='put'));
 assert.deepEqual(packaged.privateStage.transactions.map(t=>t.operations[0].kind),
   ['receipts','receipts','auditLogs']);
 for(const tx of packaged.privateStage.transactions){
   assert.match(tx.idempotencyKey,/^[A-Za-z0-9_-]+$/);
   assert.equal(tx.operations[0].expectedVersion,null);
   assert.equal(tx.operations[0].record.encryption.version,3);
   assert.equal('plaintextSha256' in tx.operations[0].record.encryption,false);
 }
 const fGit=await signedService(t,f.trust.originalReceiptPublicKeys);
 await fGit.service.append(core.transaction);
 await fGit.service.preflight(packaged.privateStage.transactions);
 let latest;
 for(const tx of packaged.privateStage.transactions) {
   latest=await fGit.service.append(tx);
   assert.equal(latest.duplicate,false);
   assert.equal((await fGit.service.append(tx)).duplicate,true);
 }
 const state=await fGit.service.replay();
 assert.equal(state.events.length,4);
 assert.equal(state.receiptHead,f.trust.expectedReceiptHeadHash);
 assert.equal(Object.keys(state.records.receipts).length,2);
 assert.equal(Object.keys(state.records.auditLogs).length,1);
 const r1=JSON.parse(restoreProtectedReceipt(state.records.receipts[20],
   scope().tenantId,scope().repositoryId,f.archiveKey).toString('utf8'));
 assert.equal(r1.metadata.private,'RECEIPT_PRIVATE_METADATA_SENTINEL');
 const audit=JSON.parse(restoreProtectedAuditLog(state.records.auditLogs[111],
   scope().tenantId,scope().repositoryId,f.archiveKey).toString('utf8'));
 assert.equal(audit.metadata.AUDIT_METADATA,'sensitive');
 const mirror=join(fGit.root,'independent.git');
 execFileSync('git',['clone','--mirror',fGit.bare,mirror],{stdio:'ignore'});
 const clone=new GitAppStateService({...fGit.opts,directory:mirror,
    signer:undefined,checkpoint:latest.checkpoint});
 const recovered=await clone.replay();
 assert.deepEqual(recovered.records,state.records);
 assert.equal(recovered.receiptHead,f.trust.expectedReceiptHeadHash);
 assert.equal(JSON.stringify(state.events).includes('RECEIPT_PRIVATE_METADATA_SENTINEL'),false);
});
test('same source produces randomized encryption and must persist exact stage for safe idempotent retry',async()=>{
 const f=await sealedSource();
 const first=stage(f),second=stage(f);
 assert.deepEqual(first.privateStage.transactions.map(x=>x.idempotencyKey),
   second.privateStage.transactions.map(x=>x.idempotencyKey));
 assert.notEqual(JSON.stringify(first.privateStage.transactions),
   JSON.stringify(second.privateStage.transactions));
 assert.notEqual(first.summary.stageDigest,second.summary.stageDigest);
 assert.equal(first.summary.sourceCommitment,second.summary.sourceCommitment);
});
test('wrong verified source, signer, head, key and scope fail generically without private content',async()=>{
 const f=await sealedSource();
 const wrong=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64');
 const attempts=[
   ()=>stage(f,{...f.trust,originalReceiptPublicKeys:[wrong]}),
   ()=>stage(f,{...f.trust,expectedReceiptHeadHash:'a'.repeat(64)}),
   ()=>stage(f,f.trust,randomBytes(16)),
   ()=>stageSealedHistoricalGitEvidence(f.envelope,
      {tenantId:'other',repositoryId:'repo_main'},f.enc,f.mac,f.manifest,f.trust,f.archiveKey),
   ()=>stageSealedHistoricalGitEvidence(f.envelope,scope(),
      randomBytes(32),f.mac,f.manifest,f.trust,f.archiveKey),
 ];
 for(const call of attempts)
   assert.throws(call,e=>e.message==='Sealed historical Git staging failed');
});
test('canonical SQL row remains whole even when metadata present and provenance is signed, never reissued',async()=>{
 const f=await sealedSource();
 const packaged=stage(f);
 const old=f.data.attestation_receipts[0];
 const op=packaged.privateStage.transactions[0].operations[0];
 const recovered=JSON.parse(restoreProtectedReceipt(op.record,
   scope().tenantId,scope().repositoryId,f.archiveKey));
 assert.equal(recovered.entryHash,old.entry_hash);
 assert.equal(recovered.signature,old.signature);
 assert.equal(recovered.publicKey,old.public_key);
 assert.equal(recovered.metadata.private,'RECEIPT_PRIVATE_METADATA_SENTINEL');
 assert.equal(recovered.signedAt,old.signed_at.toISOString());
 assert.equal(recovered.parentAttestationId,null);
 assert.equal(packaged.privateStage.transactions[0].operations[0].record.originalCore.includes('RECEIPT_PRIVATE_METADATA_SENTINEL'),false);
});
test('missing source relationships, damaged source ciphertext and unsupported source plan all fail before protected stage',async()=>{
 const variations=[
  data=>{data.repositories[0].org_id=10101;},
  data=>{data.attestation_receipts[1].parent_attestation_id=99;},
 ];
 for (const mutate of variations){
  const f=await sealedSource(mutate);
  assert.throws(()=>stage(f),e=>e.message==='Sealed historical Git staging failed');
 }
 const f=await sealedSource();
 const corrupt=structuredClone(f.envelope);
 corrupt.tableRecords[0].nonceBase64='CORRUPTED';
 assert.throws(()=>stageSealedHistoricalGitEvidence(corrupt,scope(),
   f.enc,f.mac,f.manifest,f.trust,f.archiveKey),
   e=>e.message==='Sealed historical Git staging failed');
});
