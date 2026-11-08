import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomBytes,sign,createHash} from 'node:crypto';
import {TABLE_ORDER} from '../server/git-store/full-state-inventory.mjs';
import {captureSealedFullState} from '../server/git-store/full-state-sealed.mjs';
import {stageSealedCoreGitState} from '../server/git-store/sealed-core-stage.mjs';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';
import {EncryptedProviderCustodian} from '../server/git-store/custody.ts';

const BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const LOCAL_TIMEOUT_SQL = "SET LOCAL statement_timeout='30s'";
const COMMIT_SQL = 'COMMIT';
const ROLLBACK_SQL = 'ROLLBACK';
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


class MemoryVault {
  data=new Map();
  async transact(scope,change) {
    const {envelope,result}=change(this.data.get(scope));
    this.data.set(scope,envelope);
    return result;
  }
}
async function syntheticSource(change) {
  const data=fixture();
  // Original full-state fixture intentionally used numeric convenience values
  // for these varchar preference columns. This migration fixture must reflect
  // the real Replit SQL schema and strict private Git text type instead.
  data.users[0].default_repo_id=String(data.users[0].default_repo_id);
  data.users[0].detail_repo_id=String(data.users[0].detail_repo_id);
  // A complete verified source snapshot may contain many non-core rows; all
  // historical receipts require actual signer trust, not fake fixture values.
  data.attestation_receipts=[];
  if (change) change(data);
  const manifest=manifestFromFixture(data);
  const key=randomBytes(32),mac=randomBytes(32);
  const envelope=await captureSealedFullState(fakeClient(data),manifest,scope(),key,mac);
  const trust={originalReceiptPublicKeys:[],expectedReceiptHeadHash:null};
  const vault=new MemoryVault(),custody=new EncryptedProviderCustodian(vault,randomBytes(32));
  return {data,manifest,envelope,key,mac,trust,vault,custody};
}
const stage=(s,custodian=s.custody,scopeValue=scope(),trust=s.trust)=>
 stageSealedCoreGitState(s.envelope,scopeValue,s.key,s.mac,s.manifest,trust,custodian);

async function signedService(t) {
  const root=await mkdtemp(join(tmpdir(),'fp-0b-core-stage-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bare=join(root,'private.git');
  execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
  const keys=generateKeyPairSync('ed25519');
  const opts={directory:bare,tenant:'tenant_alpha',repository:'repo_main',
    trust:{eventKeys:{synthetic:{actor:'synthetic',
       publicKey:keys.publicKey.export({type:'spki',format:'pem'})}},
       receiptKeys:[],receiptPredecessor:null},
    checkpoint:null,signer:{actor:'synthetic',keyId:'synthetic',
       sign:async bytes=>sign(null,bytes,keys.privateKey).toString('base64')}};
  const service=new GitAppStateService(opts);
  return {root,bare,opts,service};
}
test('five-table staged private Git event has exact reviewed business fields, external OAuth custody and clone recovery',async t=>{
  const s=await syntheticSource();
  const one=await stage(s);
  const two=await stage(s);
  assert.deepEqual(one.transaction,two.transaction);
  assert.equal(one.version,1);
  assert.equal(one.summary.productionGoAllowed,false);
  assert.equal(one.summary.fullApplicationMigrationComplete,false);
  assert.deepEqual(one.summary.coreTableCounts,{users:1,organizations:1,repositories:1,org_members:1,subscriptions:1});
  assert.deepEqual(one.summary.remainingTableCounts,{sessions:1,attestation_receipts:0,api_keys:1,pending_emails:1,audit_logs:1});
  assert.equal(one.summary.externalGithubTokenCount,1);
  assert.equal(one.transaction.operations.length,5);
  assert.deepEqual(one.transaction.operations.map(x=>x.kind),['users','organizations','repositories','orgMembers','subscriptions']);
  assert.ok(one.transaction.operations.every(x=>x.action==='put' && x.expectedVersion===null));
  const raw=JSON.stringify(one.transaction);
  for(const secret of ['SENTINEL_TOKEN','SESSION_SECRET','API_KEY_VERIFIER',
    'EMAIL_BODY','AUDIT_METADATA','reviewed-db-fingerprint','EMAIL_RECIPIENT@example.com'])
    assert.equal(raw.includes(secret),false,'Private sentinel in Git');
  const user=one.transaction.operations[0].record;
  assert.equal(user.id,'user_1');
  assert.equal(user.notifyOnGitFailure,true);
  assert.equal(user.firstName,'Ada');
  assert.equal(user.detailRepoId,s.data.users[0].detail_repo_id);
  assert.equal(user.githubToken,undefined);
  assert.match(user.githubTokenRef,/^custodian:[a-f0-9-]{36}$/);
  assert.equal(one.transaction.operations[4].record.attestationCount,s.data.subscriptions[0].attestation_count);
  const f=await signedService(t);
  const append=await f.service.append(one.transaction);
  assert.equal(append.duplicate,false);
  const duplicate=await f.service.append(two.transaction);
  assert.equal(duplicate.duplicate,true);
  const state=await f.service.replay();
  assert.equal(state.events.length,1);
  assert.equal(state.records.repositories[10].githubId,1001);
  assert.equal(state.records.organizations[77].ownerId,'user_1');
  assert.equal(state.records.orgMembers[88].role,'owner');
  assert.equal(state.records.subscriptions[90].plan,'pro');
  assert.equal(state.records.subscriptions[90].stripeSubscriptionId,'sub');
  assert.equal(JSON.stringify(state.events).includes('SENTINEL_TOKEN'),false);
  for(const ciphertext of s.vault.data.values())
    assert.equal(ciphertext.includes('SENTINEL_TOKEN'),false);
  const owner=new GitStorage(f.service,'user_1',['user_1'],'user_1',
    s.custody,'tenant_alpha/repo_main');
  assert.equal((await owner.getUser('user_1')).githubToken,'SENTINEL_TOKEN');
  const cloned=join(f.root,'offline-private.git');
  execFileSync('git',['clone','--mirror',f.bare,cloned],{stdio:'ignore'});
  const readOnly=new GitAppStateService({...f.opts,directory:cloned,
    checkpoint:state.checkpoint,signer:undefined});
  const recovered=await readOnly.replay();
  assert.deepEqual(recovered.records,state.records);
  assert.deepEqual(recovered.checkpoint,state.checkpoint);
});
test('no external OAuth custodian with source token fails closed before any Git writes',async()=>{
 const s=await syntheticSource();
 await assert.rejects(stage(s,null),error=>error.message==='Sealed core Git staging failed');
 assert.equal(s.vault.data.size,0);
});
test('missing OAuth token requires no external vault and stages null reference',async()=>{
 const s=await syntheticSource(d=>{d.users[0].github_token=null;});
 const result=await stage(s,null);
 assert.equal(result.transaction.operations[0].record.githubTokenRef,null);
 assert.equal(result.summary.externalGithubTokenCount,0);
});
test('unreviewed commercial plan or subscription status is never normalized',async()=>{
 for(const [field,value] of [['plan','platinum'],['status','unknown_external_state']]){
  const s=await syntheticSource(d=>{d.subscriptions[0][field]=value;});
  await assert.rejects(stage(s),error=>error.message==='Sealed core Git staging failed');
  assert.equal(s.vault.data.size,0);
 }
});
test('wrong AES key, scope or historical receipt head fails with only generic errors',async()=>{
 const s=await syntheticSource();
 const calls=[
  ()=>stageSealedCoreGitState(s.envelope,scope(),randomBytes(32),s.mac,s.manifest,s.trust,s.custody),
  ()=>stage(s,s.custody,{tenantId:'other',repositoryId:'repo_main'}),
  ()=>stage(s,s.custody,scope(),{originalReceiptPublicKeys:[],expectedReceiptHeadHash:'a'.repeat(64)})
 ];
 for(const call of calls)
  await assert.rejects(call(),error=>error.message==='Sealed core Git staging failed');
});
test('broken original org/repository relationship fails before external credential stage',async()=>{
 const s=await syntheticSource(d=>{d.repositories[0].org_id=999;});
 await assert.rejects(stage(s),error=>error.message==='Sealed core Git staging failed');
 assert.equal(s.vault.data.size,0);
});
test('more than 1000 source core rows fail closed rather than dropping or splitting',async()=>{
 const s=await syntheticSource(d=>{
   const base=d.users[0];
   d.users=Array.from({length:1002},(_,i)=>({
     ...base,id:'user_'+i,email:'synthetic'+i+'@invalid.example',
     github_token:null,github_username:null
   }));
 });
 await assert.rejects(stage(s),error=>error.message==='Sealed core Git staging failed');
 assert.equal(s.vault.data.size,0);
});
test('source schema omissions are rejected by sealed capture before staging',async()=>{
 const data=fixture();
 delete data.users[0].last_active_tab;
 const manifest=manifestFromFixture(data);
 await assert.rejects(captureSealedFullState(fakeClient(data),manifest,scope(),
  randomBytes(32),randomBytes(32)),/Protected full state capture failed/);
});

test('same verified SQL source re-exported with fresh GCM nonces stages byte-identical Git input',async()=>{
 const s=await syntheticSource();
 const first=await stage(s);
 const secondEnvelope=await captureSealedFullState(fakeClient(s.data),
   s.manifest,scope(),s.key,s.mac);
 assert.notEqual(secondEnvelope.tableRecords[0].ciphertextBase64,
   s.envelope.tableRecords[0].ciphertextBase64);
 assert.equal(secondEnvelope.wholeStateCommitment,s.envelope.wholeStateCommitment);
 const second=await stageSealedCoreGitState(secondEnvelope,scope(),
   s.key,s.mac,s.manifest,s.trust,s.custody);
 assert.deepEqual(first.transaction,second.transaction);
 assert.equal(first.summary.sourceCommitment,second.summary.sourceCommitment);
 assert.equal(s.vault.data.size,1,'same source must not produce another OAuth vault namespace');
});
