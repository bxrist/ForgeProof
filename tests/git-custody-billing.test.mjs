import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,sign,randomBytes,createHash} from 'node:crypto';
import Stripe from 'stripe';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';
import {EncryptedProviderCustodian} from '../server/git-store/custody.ts';
import {StripeInbox} from '../server/git-store/stripe-inbox.ts';

// Test-only in-memory atomic vault; never exported or selected by application config.
class FakeVault {
  data=new Map();
  async transact(scope,change) { const {envelope,result}=change(this.data.get(scope)); this.data.set(scope,envelope); return result; }
}
const secret='whsec_local_offline_fixture_secret';
const hash=s=>createHash('sha256').update(s).digest('hex');
const input={userId:'alice',name:'synthetic',keyHash:hash('synthetic-key'),keyPrefix:'fp_test_01',permissions:['attest:read']};
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'fp-phase4-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'tenant.git'); execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
  const keys=generateKeyPairSync('ed25519');
  const options={directory,tenant:'tenant-a',repository:'app',checkpoint:null,trust:{eventKeys:{test:{actor:'test',publicKey:keys.publicKey.export({type:'spki',format:'pem'})}},receiptKeys:[],receiptPredecessor:null},signer:{actor:'test',keyId:'test',sign:async b=>sign(null,b,keys.privateKey).toString('base64')}};
  const service=new GitAppStateService(options);
  await service.append({idempotencyKey:'bootstrap',operations:['alice','bob'].map(id=>({kind:'users',id,action:'put',expectedVersion:null,record:{id}}))});
  const vault=new FakeVault(), custody=new EncryptedProviderCustodian(vault,randomBytes(32));
  const storage=new GitStorage(service,'alice',['alice','bob'],'alice',custody,'tenant-a/app');
  const now=Math.floor(Date.now()/1000), start=now-1000,end=now+1000;
  await storage.createSubscription({userId:'alice',stripeCustomerId:'cus_fixture',stripeSubscriptionId:'sub_fixture',currentPeriodStart:new Date(start*1000),currentPeriodEnd:new Date(end*1000),attestationCount:7,apiKeyLimit:1});
  return {root,directory,service,storage,custody,vault,options,now,start,end};
}
function invoice(f,id='evt_fixture',changes={}) {
  return {id,object:'event',created:f.now,type:'invoice.paid',data:{object:{id:'in_fixture',object:'invoice',customer:'cus_fixture',status:'paid',amount_remaining:0,billing_reason:'subscription_cycle',parent:{subscription_details:{subscription:'sub_fixture'}},lines:{has_more:false,data:[{quantity:1,parent:{subscription_item_details:{subscription:'sub_fixture',proration:false}},pricing:{price_details:{price:'price_fixture'}},period:{start:f.start,end:f.end}}]},...changes}}};
}
function inbox(f) { return new StripeInbox(f.storage,secret,{price_fixture:{plan:'pro',limit:1000,keyLimit:2}},null); }
function deliver(box,event,signSecret=secret,timestamp=Math.floor(Date.now()/1000)) {
  const raw=Buffer.from(JSON.stringify(event));
  const signature=Stripe.webhooks.generateTestHeaderString({payload:raw.toString(),secret:signSecret,timestamp});
  return box.receive(raw,signature);
}
test('custody is unavailable by default; encrypted provider rejects wrong keys and duplicate secrets/prefixes',async t=> {
  const f=await fixture(t);
  const unavailable=new GitStorage(f.service,'alice',['alice','bob'],'alice');
  await assert.rejects(unavailable.createApiKey(input),/custody/);
  const ref=await f.custody.stage('tenant-a/app','stage', {kind:'api-key',verifier:input.keyHash,prefix:input.keyPrefix});
  assert.equal(await f.custody.matches('tenant-a/app',ref,input.keyHash),true);
  assert.equal(await f.custody.matches('tenant-a/app',ref,hash('bad')),false);
  assert.equal(await f.custody.matches('another-scope',ref,input.keyHash),false);
  await assert.rejects(f.custody.stage('tenant-a/app','duplicate',{kind:'api-key',verifier:input.keyHash,prefix:'different'}),/Duplicate/);
  await assert.rejects(f.custody.stage('tenant-a/app','duplicate2',{kind:'api-key',verifier:hash('different'),prefix:input.keyPrefix}),/Duplicate/);
  const wrong=new EncryptedProviderCustodian(f.vault,randomBytes(32));
  await assert.rejects(wrong.matches('tenant-a/app',ref,input.keyHash));
  assert.ok(![...f.vault.data.values()].join('').includes(input.keyHash));
});
test('API keys authorize only accepted Git state, tenant owner, permissions and quota; retries charge once',async t=> {
  const f=await fixture(t), {storage}=f;
  const key=await storage.createApiKeyIdempotent(input,'key-1');
  assert.equal(key.keyHash,''); assert.equal(key.keyPrefix,'');
  assert.deepEqual(await storage.createApiKeyIdempotent(input,'key-1'),key);
  await assert.rejects(storage.createApiKeyIdempotent({...input,name:'changed'},'key-1'),/Idempotency/);
  await assert.rejects(storage.createApiKeyIdempotent({...input,keyHash:hash('key2'),keyPrefix:'fp_test_02'},'key-2'),/quota/);
  assert.equal(await storage.getApiKeyByHash(hash('key2')),undefined);
  await assert.rejects(storage.authenticateApiKey(input.keyHash,'attest:write','use'),/denied/);
  await storage.authenticateApiKey(input.keyHash,'attest:read','use');
  const count=(await f.service.replay()).events.length;
  await storage.authenticateApiKey(input.keyHash,'attest:read','use');
  assert.equal((await f.service.replay()).events.length,count);
  assert.ok((await storage.getApiKeys('alice'))[0].lastUsedAt);
  const bob=new GitStorage(f.service,'bob',['alice','bob'],'alice',f.custody,'tenant-a/app');
  assert.equal(await bob.getApiKeyByHash(input.keyHash),undefined);
  await assert.rejects(bob.updateApiKeyLastUsed(key.id),/denied/);
  await assert.rejects(bob.deleteApiKey(key.id,'alice'),/denied/);
  await assert.rejects(bob.createApiKeyIdempotent({...input,keyPrefix:'other'},'stolen'),/denied/);
  await storage.deleteApiKey(key.id,'alice');
  await assert.rejects(storage.createApiKeyIdempotent(input,'reuse-revoked'),/Duplicate/);
  await assert.rejects(storage.authenticateApiKey(input.keyHash,'attest:read','use'),/denied/);
});
test('crashes before and after Git append retain inert/recoverable custody; revoke fails closed if cleanup fails',async t=> {
  const f=await fixture(t); let mode='before';
  const flaky={replay:()=>f.service.replay(),append:async tx=> { if(mode==='before') throw new Error('crash-before'); const result=await f.service.append(tx); if(mode==='after') throw new Error('crash-after'); return result; }};
  const storage=new GitStorage(flaky,'alice',['alice','bob'],'alice',f.custody,'tenant-a/app');
  await assert.rejects(storage.createApiKeyIdempotent(input,'key'),/crash-before/);
  assert.equal(await storage.getApiKeyByHash(input.keyHash),undefined);
  mode='after'; await assert.rejects(storage.createApiKeyIdempotent(input,'key'),/crash-after/);
  mode='ok'; const key=await storage.createApiKeyIdempotent(input,'key');
  assert.equal((await storage.getApiKeys('alice')).length,1);
  const broken={stage:(...a)=>f.custody.stage(...a),matches:(...a)=>f.custody.matches(...a),destroy:async()=>{throw new Error('cleanup unavailable');}};
  const revoker=new GitStorage(f.service,'alice',['alice','bob'],'alice',broken,'tenant-a/app');
  await assert.rejects(revoker.deleteApiKey(key.id,'alice'),/cleanup/);
  assert.equal(await storage.getApiKeyByHash(input.keyHash),undefined);
  await storage.deleteApiKey(key.id,'alice');
});
test('rotation is atomic, expiry denies use, OIDC material requires Git descriptor and never leaks into Git objects',async t=> {
  const f=await fixture(t), {storage}=f;
  const first=await storage.createApiKeyIdempotent(input,'key1');
  const next={...input,keyHash:hash('rotated-key'),keyPrefix:'fp_test_03'};
  await storage.createApiKeyIdempotent(next,'rotate',first.id);
  assert.equal(await storage.getApiKeyByHash(input.keyHash),undefined);
  assert.ok(await storage.getApiKeyByHash(next.keyHash));
  await storage.deleteApiKey(2,'alice');
  await storage.createApiKeyIdempotent({...input,keyHash:hash('expired-key'),keyPrefix:'fp_expired',expiresAt:new Date(1)},'expired');
  assert.equal(await storage.getApiKeyByHash(hash('expired-key')),undefined);
  const material='synthetic-oidc-access-and-refresh-token';
  const id=await storage.stageOidcSession(material,new Date(Date.now()+60000),'session1');
  assert.equal(await storage.recoverOidcSession(id),material);
  const bob=new GitStorage(f.service,'bob',['alice','bob'],'alice',f.custody,'tenant-a/app');
  await assert.rejects(bob.recoverOidcSession(id),/denied/);
  await storage.revokeOidcSession(id); await assert.rejects(storage.recoverOidcSession(id),/denied/);
  const objects=execFileSync('git',['--git-dir='+f.directory,'cat-file','--batch-all-objects','--batch'],{encoding:'utf8'});
  for(const forbidden of [input.keyHash,input.keyPrefix,next.keyHash,material,'rotated-key']) assert.ok(!objects.includes(forbidden),forbidden);
});
test('Stripe inbox validates exact signed bytes, timestamp, account, customer/subscription and reviewed prices',async t=> {
  const f=await fixture(t), box=inbox(f), e=invoice(f);
  await assert.rejects(box.receive(Buffer.from('{}'),''),/Signed/);
  await assert.rejects(deliver(box,e,'whsec_invalid_secret'),/signature/i);
  await assert.rejects(deliver(box,e,secret,f.now-600),/Timestamp/);
  await assert.rejects(deliver(box,e,secret,f.now+600),/timestamp/);
  const original=JSON.stringify(e);
  const header=Stripe.webhooks.generateTestHeaderString({payload:original,secret});
  await assert.rejects(box.receive(Buffer.from(original+' '),header),/signature/i);
  await assert.rejects(deliver(box,{...e,created:f.now-600}),/Stale/);
  await assert.rejects(deliver(box,{...e,account:'acct_unrelated'}),/authority/);
  await assert.rejects(deliver(box,invoice(f,'evt_unknown',{customer:'cus_other'})),/Unknown/);
  const unknown=invoice(f,'evt_price'); unknown.data.object.lines.data[0].pricing.price_details.price='price_unrelated';
  await assert.rejects(deliver(box,unknown),/Untrusted/);
  assert.equal((await f.storage.getSubscription('alice')).attestationCount,7);
});
test('provider inbox and quota are one CAS event, duplicates/restart/conflicting IDs do not reset counters',async t=> {
  const f=await fixture(t), box=inbox(f), event=invoice(f);
  await Promise.all([deliver(box,event),deliver(box,event)]);
  assert.equal((await f.storage.getSubscription('alice')).attestationCount,7);
  const before=(await f.service.replay()).events.length;
  await deliver(box,event); assert.equal((await f.service.replay()).events.length,before);
  const conflict=invoice(f,event.id,{customer:'cus_other'}); await assert.rejects(deliver(box,conflict),/Idempotency/);
  const old=invoice(f,'evt_backdated'); old.data.object.lines.data[0].period.start=f.start-1;
  old.created+=1; await assert.rejects(deliver(box,old),/Unsafe/);
  // A confirmed new period that has started (fixture previous period ended before now).
  const sub=await f.storage.getSubscription('alice');
  await f.storage.updateSubscription(sub.id,{currentPeriodEnd:new Date((f.now-10)*1000)});
  const renewal=invoice(f,'evt_renew'); renewal.created+=2;
  renewal.data.object.lines.data[0].period={start:f.now-10,end:f.now+2000};
  await deliver(box,renewal); assert.equal((await f.storage.getSubscription('alice')).attestationCount,0);
  await f.storage.updateSubscription(sub.id,{attestationCount:4});
  const restarted=new GitStorage(new GitAppStateService({...f.options,checkpoint:(await f.service.replay()).checkpoint}),'alice',['alice','bob'],'alice',f.custody,'tenant-a/app');
  await deliver(new StripeInbox(restarted,secret,{price_fixture:{plan:'pro',limit:1000,keyLimit:2}},null),renewal);
  assert.equal((await restarted.getSubscription('alice')).attestationCount,4);
  const stale=invoice(f,'evt_old'); await assert.rejects(deliver(box,stale),/Stale/);
});

test('billing crash after accepted append is recovered by real event ID with one usage reset',async t=> {
  const f=await fixture(t);
  const sub=await f.storage.getSubscription('alice');
  await f.storage.updateSubscription(sub.id,{currentPeriodEnd:new Date((f.now-10)*1000)});
  let crash=true;
  const service={replay:()=>f.service.replay(),append:async tx=> { const result=await f.service.append(tx); if(crash) throw new Error('lost acknowledgment'); return result; }};
  const storage=new GitStorage(service,'alice',['alice','bob'],'alice',f.custody,'tenant-a/app');
  const box=new StripeInbox(storage,secret,{price_fixture:{plan:'pro',limit:1000,keyLimit:2}},null);
  const event=invoice(f,'evt_crash'); event.data.object.lines.data[0].period={start:f.now-10,end:f.now+2000};
  await assert.rejects(deliver(box,event),/lost acknowledgment/);
  assert.equal((await f.storage.getSubscription('alice')).attestationCount,0);
  await f.storage.updateSubscription(sub.id,{attestationCount:3});
  crash=false; await deliver(box,event);
  assert.equal((await f.storage.getSubscription('alice')).attestationCount,3);
  const state=await f.service.replay();
  assert.equal(Object.values(state.records.auditLogs).filter(a=>a.resourceType==='stripe-event' && a.resourceId===event.id).length,1);
  const next=invoice(f,'evt_sameperiod'); next.created+=1; next.data.object.lines.data[0].period=event.data.object.lines.data[0].period;
  await deliver(box,next); assert.equal((await f.storage.getSubscription('alice')).attestationCount,3);
});
