import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {TABLE_ORDER,TABLE_COLUMNS} from '../server/git-store/full-state-inventory.mjs';
import {captureSealedFullState,openSealedFullState} from '../server/git-store/full-state-sealed.mjs';
import {stageSealedApiKeys} from '../server/git-store/sealed-api-key-stage.mjs';
import {stageSealedCoreGitState} from '../server/git-store/sealed-core-stage.mjs';
import {EncryptedProviderCustodian} from '../server/git-store/custody.ts';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';

const scope={tenantId:'synthetic',repositoryId:'keys'};
const stamp='2025-01-01T01:02:03.456Z';
const hash=i=>createHash('sha256').update('synthetic-only-'+i).digest('hex');
const key=i=>({id:i,user_id:'alice',name:'historic '+i,key_hash:hash(i),key_prefix:'TESTKEY_'+i,
 permissions:i===1?['attest:write','attest:read','attest:read']:[],is_active:i!==2,
 last_used_at:i===1?stamp:null,expires_at:i===3?stamp:null,created_at:stamp});
// Test-only encrypted backing store, never a production provider.
class TestVault {
 data=new Map();
 async transact(s,change){const {envelope,result}=change(this.data.get(s));this.data.set(s,envelope);return result;}
}
async function fixture(rows=[key(1),key(2),key(3)],mutate=()=>{}) {
 const data=Object.fromEntries(TABLE_ORDER.map(t=>[t,[]]));
 const empty=t=>Object.fromEntries(TABLE_COLUMNS[t].map(c=>[c,null]));
 data.users=[{...empty('users'),id:'alice',email:'alice@example.invalid',created_at:stamp,updated_at:stamp}];
 data.subscriptions=[{...empty('subscriptions'),id:7,user_id:'alice',plan:'pro',status:'active',
  attestation_limit:100,attestation_count:4,api_key_limit:1,created_at:stamp}];
 data.api_keys=rows;mutate(data);
 const manifest={version:1,sourceDbFingerprint:'synthetic-only',tables:Object.fromEntries(
  TABLE_ORDER.map(t=>[t,{expectedRowCount:data[t].length}]))};
 const enc=randomBytes(32),mac=randomBytes(32),vaultKey=randomBytes(32),vault=new TestVault();
 const custodian=new EncryptedProviderCustodian(vault,vaultKey);
 const envelope=await captureSealedFullState({async query(sql){const m=sql.match(/^SELECT \* FROM "([a-z_]+)"/);return {rows:m?data[m[1]]:[]};}},manifest,scope,enc,mac);
 return {envelope,manifest,enc,mac,vaultKey,vault,custodian,
  trust:{originalReceiptPublicKeys:[],expectedReceiptHeadHash:null},
  binding:{...scope,custodyScope:'synthetic/keys',authenticated:true,durableExternalVault:true}};
}
const stage=f=>stageSealedApiKeys(f.envelope,scope,f.enc,f.mac,f.manifest,f.trust,f.custodian,f.binding);
const rejected=call=>assert.rejects(call,e=>e.message==='Sealed API-key Git staging failed'&&!e.cause);

test('exact historic metadata, encrypted custody, empty state and deterministic retries',async()=>{
 const f=await fixture(),out=await stage(f);
 const rows=openSealedFullState(f.envelope,scope,f.enc,f.mac,f.manifest).api_keys;
 assert.equal(out.summary.apiKeyCount,3);
 assert.equal(out.summary.productionGoAllowed,false);
 assert.equal(out.summary.mustPersistExactStageBeforeAnyAppend,true);
 for (const [i,op] of out.privateStage.transactions[0].operations.entries()) {
  const r=rows[i];const {credentialRef,...metadata}=op.record;
  assert.deepEqual(metadata,{id:r.id,userId:r.user_id,name:r.name,permissions:r.permissions,
   isActive:r.is_active,lastUsedAt:r.last_used_at,expiresAt:r.expires_at,createdAt:r.created_at});
  assert.equal(await f.custodian.matches(f.binding.custodyScope,credentialRef,r.key_hash),true);
  assert.equal(await f.custodian.matches('wrong',credentialRef,r.key_hash),false);
  assert.equal(op.expectedVersion,null);
 }
 assert.deepEqual(await stage(f),out);
 const restarted={...f,custodian:new EncryptedProviderCustodian(f.vault,f.vaultKey)};
 assert.deepEqual(await stage(restarted),out);
 for (const row of rows) for (const material of [row.key_hash,row.key_prefix]) {
  assert.equal(JSON.stringify(out).includes(material),false);
  assert.equal(JSON.stringify([...f.vault.data.values()]).includes(material),false);
 }
 const empty=await stage(await fixture([]));
 assert.deepEqual(empty.privateStage.transactions,[]);assert.equal(empty.summary.apiKeyCount,0);
});

test('scope, trust, source keys, tampering and protected custody failures are generic',async()=>{
 const f=await fixture();
 for (const patch of [{trust:undefined},{trust:{...f.trust,expectedReceiptHeadHash:'a'.repeat(64)}},
  {enc:randomBytes(32)},{mac:randomBytes(32)},{mac:f.enc},{custodian:undefined},
  {custodian:{stage:async()=>{throw Error('private');}}},
  {binding:{...f.binding,authenticated:false}},{binding:{...f.binding,durableExternalVault:false}},
  {binding:{...f.binding,tenantId:'other'}},{binding:{...f.binding,custodyScope:'other'}}])
  await rejected(()=>stage({...f,...patch}));
 await rejected(()=>stageSealedApiKeys(f.envelope,{...scope,repositoryId:'other'},f.enc,f.mac,f.manifest,f.trust,f.custodian,f.binding));
 const corrupt=structuredClone(f.envelope);corrupt.tableRecords[0].tagBase64=Buffer.alloc(16).toString('base64');
 await rejected(()=>stage({...f,envelope:corrupt}));
 await stage(f);
 await rejected(()=>stage({...f,custodian:new EncryptedProviderCustodian(f.vault,randomBytes(32))}));
 const original=f.vault.data.get(f.binding.custodyScope);
 f.vault.data.set(f.binding.custodyScope,original.slice(0,-4)+'AAAA');
 await rejected(()=>stage(f));
});

test('unmappable material, metadata, duplicates and broken relations block before custody',async()=>{
 for (const patch of [{key_hash:'unsupported'},{key_prefix:'unsupported-prefix'},{permissions:['read']},
  {permissions:null},{is_active:null},{name:hash(1)},{name:'TESTKEY_1'}, {user_id:'missing'}]) {
  const f=await fixture([{...key(1),...patch}]);await rejected(()=>stage(f));
 }
 for (const patch of [{key_hash:hash(1)},{key_prefix:key(1).key_prefix}]) {
  const f=await fixture([key(1),{...key(2),...patch}]);await rejected(()=>stage(f));assert.equal(f.vault.data.size,0);
 }
 for (const mutate of [d=>{d.subscriptions=[];},d=>{d.subscriptions[0].user_id='missing';},
  d=>{d.subscriptions[0].status='unknown';},d=>{d.subscriptions.push({...d.subscriptions[0],id:8});}]) {
  const f=await fixture([key(1)],mutate);await rejected(()=>stage(f));assert.equal(f.vault.data.size,0);
 }
});

test('partial external failure stays inert and deterministic retry restores same refs',async()=>{
 const f=await fixture();let n=0;const transact=f.vault.transact.bind(f.vault);
 f.vault.transact=async(...args)=>{if (++n===3) throw Error(hash(1)+key(1).key_prefix);return transact(...args);};
 await rejected(()=>stage(f));
 f.vault.transact=transact;
 const out=await stage(f);assert.deepEqual(await stage(f),out);
 await f.custodian.destroy(f.binding.custodyScope,out.privateStage.transactions[0].operations[0].record.credentialRef);
 await rejected(()=>stage(f));
});

test('saved stage and core replay in independent signed local Git with working historic lookup',async t=>{
 const f=await fixture(),out=await stage(f);
 const core=await stageSealedCoreGitState(f.envelope,scope,f.enc,f.mac,f.manifest,f.trust,f.custodian);
 const root=await mkdtemp(join(tmpdir(),'fp-key-stage-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'private.git');execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
 const pair=generateKeyPairSync('ed25519');
 const opts={directory,tenant:scope.tenantId,repository:scope.repositoryId,checkpoint:null,
  trust:{eventKeys:{test:{actor:'test',publicKey:pair.publicKey.export({type:'spki',format:'pem'})}},receiptKeys:[],receiptPredecessor:null},
  signer:{actor:'test',keyId:'test',sign:async b=>sign(null,b,pair.privateKey).toString('base64')}};
 const service=new GitAppStateService(opts);
 // Serialized private artifact stands in for an owner-controlled durable journal.
 const saved=JSON.parse(JSON.stringify(out.privateStage));
 await service.append(core.transaction);const tx=saved.transactions[0];
 const last=await service.append(tx);assert.equal((await service.append(tx)).duplicate,true);
 const mirror=join(root,'mirror.git');execFileSync('git',['clone','--mirror',directory,mirror],{stdio:'ignore'});
 const clone=new GitAppStateService({...opts,directory:mirror,signer:undefined,checkpoint:last.checkpoint});
 const state=await clone.replay();assert.deepEqual(state.records,(await service.replay()).records);
 const storage=new GitStorage(clone,'alice',['alice'],'alice',f.custodian,f.binding.custodyScope);
 assert.equal((await storage.getApiKeyByHash(hash(1))).id,1);
 assert.equal(await storage.getApiKeyByHash(hash(2)),undefined);
 assert.equal(await storage.getApiKeyByHash(hash(3)),undefined);
 for (const r of [key(1),key(2),key(3)]) for (const material of [r.key_hash,r.key_prefix])
  assert.equal(JSON.stringify(state.events).includes(material),false);
});
