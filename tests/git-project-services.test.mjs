import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign, randomUUID, createHash } from 'node:crypto';
import { GitAppStateService } from '../server/git-store/store.mjs';
import { GitStorage } from '../server/git-store/storage.ts';
import { EncryptedProviderCustodian } from '../server/git-store/custody.ts';
import { validateProjectBinding } from '../server/projectServicePolicy.ts';
const sha = s => createHash('sha256').update(s).digest('hex');

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'forgeproof-project-fixture-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
  const event=generateKeyPairSync('ed25519'), receipt=generateKeyPairSync('ed25519');
  const publicKey=receipt.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const service=new GitAppStateService({directory,tenant:'fixture',repository:'projects',checkpoint:null,
    trust:{eventKeys:{event:{actor:'fixture',publicKey:event.publicKey.export({type:'spki',format:'pem'})}},
      receiptKeys:[publicKey],receiptPredecessor:null},
    signer:{actor:'fixture',keyId:'event',sign:async bytes=>sign(null,bytes,event.privateKey).toString('base64')}});
  const operations=[];
  for(const [i,owner] of ['owner','other'].entries()) {
    operations.push({kind:'users',id:owner,action:'put',expectedVersion:null,record:{id:owner}});
    operations.push({kind:'subscriptions',id:i+1,action:'put',expectedVersion:null,
      record:{id:i+1,userId:owner,plan:'free',status:'active',attestationCount:0,attestationLimit:100,apiKeyLimit:1}});
  }
  for(const [i,project] of ['fixture/ForgeProof','fixture/AgentPort','fixture/Other'].entries())
    operations.push({kind:'repositories',id:i+1,action:'put',expectedVersion:null,
      record:{id:i+1,userId:i===2?'other':'owner',githubId:i+100,name:project.split('/')[1],fullName:project,url:'https://github.com/'+project}});
  await service.append({idempotencyKey:'bootstrap',operations});
  const envelopes=new Map();
  const custody=new EncryptedProviderCustodian({async transact(scope,change){
    const r=change(envelopes.get(scope)); envelopes.set(scope,r.envelope); return r.result;
  }},randomBytes(32));
  const encryption=randomBytes(32), members=['owner','other'];
  const store=principal=>new GitStorage(service,principal,members.includes(principal)?members:[...members,principal],
    'owner',custody,'fixture:projects',undefined,undefined,encryption,true);
  async function enroll(repositoryId=1,owner='owner') {
    const id=randomUUID(), verifier=sha(randomUUID());
    const project=['fixture/ForgeProof','fixture/AgentPort','fixture/Other'][repositoryId-1];
    const binding=await store(owner).enrollProjectService({id,repositoryId,project,
      expiresAt:new Date(Date.now()+86400000).toISOString(),verifier,prefix:randomBytes(6).toString('hex')});
    return {binding,verifier,git:store(binding.serviceIdentity)};
  }
  const signer={publicKey,sign:async bytes=>sign(null,bytes,receipt.privateKey).toString('base64')};
  async function issue(f, stage='source-write', parents=[], requestId=randomUUID(), overrides={}) {
    const source={userId:f.binding.serviceIdentity,fileName:'artifact',filePath:'artifact',
      fileHash:'a'.repeat(64),modelName:'UNSPECIFIED',modelProvider:'UNSPECIFIED',countryOfOrigin:'UNSPECIFIED',
      receiptVersion:'v1',signedAt:'2026-11-17T00:00:00.000Z'};
    return f.git.issueAttestationWithSigner(source,signer,requestId,undefined,
      {project:f.binding.project,stage,parents,observedAt:'2026-11-17T00:00:00Z',
        ...(stage==='commit'?{commitSha:'b'.repeat(40)}:{}),...overrides},
      {id:f.binding.id,verifier:f.verifier});
  }
  return {store,service,custody,enroll,issue,signer};
}

test('separate project credentials, five-stage signed graph, owner metering and durable recovery',async t=>{
  const f=await fixture(t), a=await f.enroll(), b=await f.enroll(2);
  assert.notEqual(a.binding.serviceIdentity,b.binding.serviceIdentity);
  assert.equal((await f.store('owner').listProjectServices()).length,2);
  assert.deepEqual(await f.store('other').listProjectServices(),[]);
  const read=await f.store('owner').authenticateProjectService(a.binding.id,a.verifier);
  assert.equal(read.project,'fixture/ForgeProof'); assert.equal(read.tenant,'user:owner');
  assert.equal(JSON.stringify(read).includes(a.verifier),false);
  const key=randomUUID(), source=await f.issue(a,'source-write',[],key);
  assert.equal((await f.issue(a,'source-write',[],key)).id,source.id);
  const commit=await f.issue(a,'commit',[source.id]), build=await f.issue(a,'build',[commit.id]);
  const deploy=await f.issue(a,'deployment',[build.id]), rollback=await f.issue(a,'rollback',[deploy.id,build.id]);
  for(const r of [source,commit,build,deploy,rollback]) {
    const evidence=await a.git.getPublicLifecycleEvidence(r.id);
    assert.equal(evidence.verified,true); assert.equal(evidence.parentsVerified,true);
    assert.equal(evidence.payload.project,a.binding.project);
  }
  const recovered=await a.git.getAttestationByRequestId(key,
    s=>a.git.verifyProjectService(s,a.binding.id,a.verifier,a.binding.project));
  assert.equal(recovered.signature,source.signature);
  assert.equal(await b.git.getAttestationByRequestId(key,
    s=>b.git.verifyProjectService(s,b.binding.id,b.verifier,b.binding.project)),undefined);
  const state=await f.service.replay();
  assert.equal(state.records.subscriptions[1].attestationCount,5);
  assert.equal(state.records.subscriptions[2].attestationCount,0);
  assert.equal(Object.keys(state.records.receipts).length,5);
  assert.ok(state.events.some(e=>e.body.operations.some(o=>o.kind==='auditLogs' && o.record?.action==='project-service-enroll')));
});

test('wrong credentials, cross-project/cross-tenant parents, forged graph and revocation fail closed',async t=>{
  const f=await fixture(t), a=await f.enroll(), b=await f.enroll(2), c=await f.enroll(3,'other');
  await assert.rejects(f.store('owner').authenticateProjectService(a.binding.id,b.verifier),/denied/);
  await assert.rejects(f.enroll(3),/denied/);
  await assert.rejects(f.store('other').revokeProjectService(a.binding.id),/denied/);
  await assert.rejects(f.issue(a,'source-write',[],randomUUID(),{project:b.binding.project}),/denied/);
  const source=await f.issue(a);
  const verified=await f.service.replay(), row=verified.records.projectServices[a.binding.id];
  for(const override of [{permissions:'attest:read'},{tenantKey:'user:other'},{ownerId:'other'}])
    assert.throws(()=>validateProjectBinding(verified,{...row,...override}),/denied/);
  await assert.rejects(f.issue(b,'commit',[source.id]),/same account and project/);
  await assert.rejects(f.issue(c,'commit',[source.id]),/same account and project/);
  await assert.rejects(f.issue(a,'build',[source.id]),/stage linkage/);
  await assert.rejects(f.issue(a,'commit',[999999]),/Missing|missing|not found/i);
  await f.store('owner').revokeProjectService(a.binding.id);
  await assert.rejects(f.issue(a),/denied/);
  await assert.rejects(f.store('owner').authenticateProjectService(a.binding.id,a.verifier),/denied/);
  assert.equal(Object.keys((await f.service.replay()).records.receipts).length,1);
});

test('expiry and custody/replay failures deny without a signed append or fallback',async t=>{
  const f=await fixture(t), a=await f.enroll();
  const state=await f.service.replay(), row=state.records.projectServices[a.binding.id];
  await f.service.append({idempotencyKey:randomUUID(),operations:[{kind:'projectServices',id:row.id,
    action:'put',expectedVersion:state.versions['projectServices/'+row.id],
    record:{...row,createdAt:'2020-01-01T00:00:00Z',expiresAt:'2020-01-02T00:00:00Z'}}]});
  await assert.rejects(f.issue(a),/denied/);
  const b=await f.enroll(2);
  const original=f.custody.matches.bind(f.custody);
  f.custody.matches=async()=>{throw new Error('provider unavailable')};
  await assert.rejects(f.issue(b),/provider unavailable/);
  f.custody.matches=original;
  const replay=f.service.replay.bind(f.service);
  f.service.replay=async()=>{throw new Error('replay unavailable')};
  await assert.rejects(f.issue(b),/replay unavailable/);
  f.service.replay=replay;
  assert.equal(Object.keys((await replay()).records.receipts).length,0);
});

test('ambiguous append recovers exactly one receipt and conflicts never create a second',async t=>{
  const f=await fixture(t), a=await f.enroll(), key=randomUUID();
  const append=f.service.append.bind(f.service); let once=true;
  f.service.append=async transaction=>{
    const result=await append(transaction);
    if(once){once=false;throw new Error('response lost after commit');} return result;
  };
  await assert.rejects(f.issue(a,'source-write',[],key),/response lost/);
  const recovered=await a.git.getAttestationByRequestId(key,
    s=>a.git.verifyProjectService(s,a.binding.id,a.verifier,a.binding.project));
  assert.ok(recovered.signature);
  assert.equal((await f.issue(a,'source-write',[],key)).id,recovered.id);
  await assert.rejects(f.issue(a,'source-write',[],key,{actor:{id:'different',kind:'agent'}}),/conflict/);
  assert.equal(Object.keys((await f.service.replay()).records.receipts).length,1);
});
