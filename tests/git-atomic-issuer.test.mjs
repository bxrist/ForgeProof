import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomBytes,randomUUID,sign,verify,createHash} from 'node:crypto';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';
import {restoreProtectedReceipt} from '../server/git-store/protected-receipt.mjs';

const sha=parts=>createHash('sha256').update(parts.join('|')).digest('hex');
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'forgeproof-0b-atomic-issuer-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'private.git');
 execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
 const event=generateKeyPairSync('ed25519');
 const receipt=generateKeyPairSync('ed25519');
 const pem=receipt.publicKey.export({type:'spki',format:'pem'});
 const publicKey=receipt.publicKey.export({type:'spki',format:'der'}).toString('base64');
 const opts={
   directory,tenant:'tenant-atomic',repository:'production-fixture',checkpoint:null,
   trust:{eventKeys:{'event-key':{actor:'fixture-event-service',
      publicKey:event.publicKey.export({type:'spki',format:'pem'})}},
      receiptKeys:[publicKey],receiptPredecessor:null},
   signer:{actor:'fixture-event-service',keyId:'event-key',
      sign:async bytes=>sign(null,bytes,event.privateKey).toString('base64')}
 };
 const service=new GitAppStateService(opts);
 await service.append({idempotencyKey:'bootstrap',operations:[
   {kind:'users',id:'guard',action:'put',expectedVersion:null,record:{id:'guard'}},
   {kind:'users',id:'alice',action:'put',expectedVersion:null,record:{id:'alice'}},
   {kind:'users',id:'bob',action:'put',expectedVersion:null,record:{id:'bob'}},
   {kind:'subscriptions',id:1,action:'put',expectedVersion:null,record:{
      id:1,userId:'alice',plan:'pro',status:'active',attestationLimit:2,
      attestationCount:0,apiKeyLimit:3}}
 ]});
 const protectedKey=randomBytes(32);
 let signCount=0;
 const signer={publicKey,sign:async bytes=>{
  signCount++;return sign(null,bytes,receipt.privateKey).toString('base64');
 }};
 const alice=new GitStorage(service,'alice',['guard','alice','bob'],'guard',
   undefined,'',undefined,undefined,protectedKey);
 const bob=new GitStorage(service,'bob',['guard','alice','bob'],'guard',
   undefined,'',undefined,undefined,protectedKey);
 const source={
  userId:'alice',orgId:null,repositoryId:null,
  fileName:'fixture.ts',filePath:'src/fixture.ts',fileHash:'sha256:'+'a'.repeat(64),
  modelName:'user-declared-model',modelProvider:'user-declared-provider',
  countryOfOrigin:'unknown',detectedCountry:null,complianceStatus:'unverified',
  receiptVersion:'v1',signedAt:'2026-11-08T01:00:00.000Z',
  attestationType:'origin',parentAttestationId:null,auditVerdict:null,
  auditDetails:'PRIVATE_AUDIT_FIXTURE_ONLY',metadata:{sentinel:'PRIVATE_METADATA_SENTINEL_ONLY'}
 };
 return {root,directory,opts,service,alice,bob,source,signer,receipt,protectedKey,
   getSignCount:()=>signCount};
}
test('concurrent signed Git attestation issuance re-signs changing head, commits exactly one quota per receipt',async t=>{
 const f=await fixture(t);
 const next={...f.source,fileName:'another.ts',filePath:'src/another.ts',
  fileHash:'sha256:'+'b'.repeat(64),metadata:{sentinel:'SECOND_PRIVATE_SENTINEL'}};
 const [first,second]=await Promise.all([
  f.alice.issueAttestationWithSigner(f.source,f.signer,'atomic-request-0001'),
  f.alice.issueAttestationWithSigner(next,f.signer,'atomic-request-0002')
 ]);
 assert.notEqual(first.id,second.id);
 const ordered=[first,second].sort((a,b)=>a.id-b.id);
 assert.deepEqual(ordered.map(r=>r.id),[1,2]);
 assert.equal(ordered[0].prevEntryHash,null);
 assert.equal(ordered[1].prevEntryHash,ordered[0].entryHash);
 for(const [i,r] of ordered.entries()){
  const timestamp=r.signedAt instanceof Date ? r.signedAt.toISOString() : r.signedAt;
  assert.equal(r.entryHash,sha([r.fileHash,r.modelName,r.modelProvider,r.countryOfOrigin,
    i===0?'genesis':ordered[i-1].entryHash,timestamp]));
  assert.equal(verify(null,Buffer.from([r.entryHash,r.fileHash,timestamp].join('|')),
    f.receipt.publicKey,Buffer.from(r.signature,'base64')),true);
  assert.equal(r.metadata,null);assert.equal(r.auditDetails,null);
 }
 const state=await f.service.replay();
 assert.equal(state.receiptHead,ordered.at(-1).entryHash);
 assert.equal(state.records.subscriptions[1].attestationCount,2);
 assert.equal(Object.keys(state.records.receipts).length,2);
 const before=state.events.length,signCount=f.getSignCount();
 const duplicate=await f.alice.issueAttestationWithSigner(f.source,f.signer,'atomic-request-0001');
 assert.equal(duplicate.id,first.id);
 assert.equal(duplicate.entryHash,first.entryHash);
 assert.equal(f.getSignCount(),signCount);
 assert.equal((await f.service.replay()).events.length,before);
 await assert.rejects(f.alice.issueAttestationWithSigner(
  {...f.source,metadata:{changed:'different'}},f.signer,'atomic-request-0001'),/Idempotency request conflict/);
 await assert.rejects(f.alice.issueAttestationWithSigner(
  {...f.source,fileHash:'sha256:'+'c'.repeat(64)},f.signer,'atomic-request-0003'),/Quota/);
 assert.equal((await f.service.replay()).events.length,before);
 for(const receipt of ordered){
  const record=state.records.receipts[receipt.id];
  const recovered=JSON.parse(restoreProtectedReceipt(record,f.opts.tenant,f.opts.repository,f.protectedKey));
  assert.equal(recovered.entryHash,receipt.entryHash);
  assert.ok(recovered.metadata.sentinel.startsWith(receipt.fileHash.endsWith('a'.repeat(64))?'PRIVATE_METADATA':'SECOND_PRIVATE'));
 }
 const serialized=JSON.stringify(state.events);
 for(const secret of ['PRIVATE_METADATA_SENTINEL_ONLY','SECOND_PRIVATE_SENTINEL','PRIVATE_AUDIT_FIXTURE_ONLY'])
  assert.ok(!serialized.includes(secret));
 const clone=join(f.root,'disconnected.git');
 execFileSync('git',['clone','--mirror',f.directory,clone],{stdio:'ignore'});
 const readOnly=new GitAppStateService({...f.opts,directory:clone,checkpoint:state.checkpoint,signer:undefined});
 const replay=await readOnly.replay();
 assert.equal(replay.receiptHead,ordered[1].entryHash);
 assert.equal(replay.records.subscriptions[1].attestationCount,2);
 assert.equal(Object.keys(replay.records.receipts).length,2);
});
test('untrusted signer, wrong user, invalid signed source and missing key fail before writing',async t=>{
 const f=await fixture(t);
 const before=(await f.service.replay()).events.length;
 const untrustedKeys=generateKeyPairSync('ed25519');
 const unauthorized={publicKey:untrustedKeys.publicKey.export({type:'spki',format:'der'}).toString('base64'),
  sign:async b=>sign(null,b,untrustedKeys.privateKey).toString('base64')};
 await assert.rejects(f.alice.issueAttestationWithSigner(f.source,unauthorized,'bad-signer-00001'),/Signer key not trusted/);
 await assert.rejects(f.bob.issueAttestationWithSigner(f.source,f.signer,'wrong-owner-0001'),/Receipt owner denied/);
 await assert.rejects(f.alice.issueAttestationWithSigner({...f.source,receiptVersion:'v2'},
  f.signer,'wrong-version-0001'),/Unsupported original receipt version/);
 await assert.rejects(f.alice.issueAttestationWithSigner({...f.source,signedAt:'INVALID'},
  f.signer,'wrong-timestamp-0001'),/Explicit signedAt/);
 const badSignature={publicKey:f.signer.publicKey,sign:async()=>Buffer.alloc(64,0).toString('base64')};
 await assert.rejects(f.alice.issueAttestationWithSigner(f.source,badSignature,'bad-signature-0001'),
   /Invalid historical receipt signature|signature|hash/i);
 const missing=new GitStorage(f.service,'alice',['guard','alice','bob'],'guard');
 await assert.rejects(missing.issueAttestationWithSigner(f.source,f.signer,'missing-key-0001'),/Receipt protection key/);
 assert.equal((await f.service.replay()).events.length,before);
});

import {registerLifeosAttestationRoutes} from '../server/lifeosAttestationRoutes.mjs';
import {parseLifeosRequestIdentity} from '../server/lifeosRequestIdentity.mjs';

async function routesFixture(t) {
 const f=await fixture(t);
 await f.service.append({idempotencyKey:'fixture-service-key',operations:[{kind:'apiKeys',id:1,action:'put',expectedVersion:null,record:{id:1,userId:'alice',name:'synthetic',credentialRef:'custodian:fixture',isActive:true,permissions:['attest:write']}}]});
 const routes={};
 let available=true, revoked=false, principal='alice', creates=0, principalBound=false;
 const proof={userId:'alice',apiKeyId:1,keyHash:'synthetic'};
 const verifyState=async (_proof,userId,state,matches=true)=>{
  if(revoked || !matches || !state.records.users[userId]) throw Object.assign(new Error('Denied'),{status:403});
 };
 const guard=state=>verifyState(proof,'alice',state);
 const selected=()=>principal==='alice'?f.alice:f.bob;
 for(const store of [f.alice,f.bob]) {
  // Synthetic proof custody only; production uses the approved key verifier.
  store.custody.matches=async()=>true;
 }
 registerLifeosAttestationRoutes({
  post:(path,_limit,handler)=>{routes.POST=handler;},
  get:(path,_limit,handler)=>{routes.GET=handler;},
 },{
  limiter:()=>{},getStorage:()=>available && principalBound?selected():undefined,
  proveControl:async header=>{
   if(header!=='Bearer fixture' || revoked) throw Object.assign(new Error('Denied'),{status:403});
   principalBound=true;
   return {...proof,userId:principal};
  },
  parseBody:body=>({success:true,data:body}),detectCountry:req=>req.headers['cf-ipcountry'],
  verifyState,
  createReceipt:async(userId,data,country,_repo,_proof,identity)=>{
   creates++;
   return selected().issueAttestationWithSigner({...f.source,userId,
    fileHash:data.file_hash ?? f.source.fileHash,metadata:data.metadata,
    detectedCountry:country,signedAt:identity?.signedAt ?? new Date().toISOString()},
    f.signer,identity?.requestId ?? randomUUID(),guard);
  },
 });
 const invoke=async(method,options={})=>{
  principalBound=false; // Each request starts without a verified storage principal.
  const {key='lifeos-request-0001',body={signedAt:f.source.signedAt},auth='Bearer fixture',country='US'}=options;
  const response={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=JSON.parse(JSON.stringify(value));return this;}};
  await routes[method]({headers:{authorization:auth,...(options.legacy?{}:{'idempotency-key':key}),'cf-ipcountry':country},body,params:{requestId:key}},response);
  return {status:response.statusCode,body:response.body};
 };
 return {...f,invoke,setAvailable:v=>{available=v;},setRevoked:v=>{revoked=v;},setPrincipal:v=>{principal=v;},guard,getCreates:()=>creates};
}

test('LifeOS lost acknowledgement, concurrent retries and restart resolve one original Git receipt',async t=>{
 const f=await routesFixture(t);
 const before=(await f.service.replay()).events.length;
 const lost=await f.invoke('POST'); // Persisted response discarded by client.
 assert.equal(lost.status,201);
 const [a,b]=await Promise.all([f.invoke('POST',{country:'CA'}),f.invoke('POST')]);
 assert.deepEqual(a,lost);assert.deepEqual(b,lost);
 assert.equal((await f.service.replay()).events.length,before+1);
 const status=await f.invoke('GET');assert.equal(status.status,200);assert.deepEqual(status.body,lost.body);
 const recovered=new GitStorage(new GitAppStateService({...f.opts,checkpoint:(await f.service.replay()).checkpoint}),
  'alice',['guard','alice','bob'],'guard',undefined,'',undefined,undefined,f.protectedKey);
 assert.equal((await recovered.getAttestationByRequestId('lifeos-request-0001',f.guard)).signature,lost.body.signature);
 assert.equal((await f.service.replay()).events.length,before+1);
 const conflict=await f.invoke('POST',{body:{signedAt:f.source.signedAt,metadata:{changed:true}}});
 assert.equal(conflict.status,409);
 const timeConflict=await f.invoke('POST',{body:{signedAt:'2026-11-08T01:00:01.000Z'}});
 assert.equal(timeConflict.status,409);
 assert.equal((await f.service.replay()).events.length,before+1);
});

test('LifeOS simultaneous first submissions append once and status is scoped and read only',async t=>{
 const f=await routesFixture(t);
 const before=(await f.service.replay()).events.length;
 const [a,b]=await Promise.all([f.invoke('POST'),f.invoke('POST')]);
 assert.equal(a.status,201);assert.deepEqual(a,b);
 assert.equal((await f.service.replay()).events.length,before+1);
 assert.equal((await f.invoke('GET',{auth:'Bearer wrong'})).status,403);
 assert.equal((await f.invoke('POST',{auth:'Bearer wrong'})).status,403);
 assert.equal((await f.invoke('GET',{key:'unknown-request-0001'})).status,404);
 f.setPrincipal('bob');assert.equal((await f.invoke('GET')).status,404);f.setPrincipal('alice');
 f.setRevoked(true);assert.equal((await f.invoke('GET')).status,403);
 await assert.rejects(f.alice.issueAttestationWithSigner({...f.source,metadata:{source:'lifeos_service',metering:'internal'}},
  f.signer,'lifeos-request-0001',f.guard),/Denied/);
 f.setRevoked(false);
 const replay=f.service.replay.bind(f.service);f.service.replay=async()=>{throw new Error('Unverified Git');};
 assert.equal((await f.invoke('GET')).status,503);f.service.replay=replay;
 assert.equal((await f.service.replay()).events.length,before+1);
});

test('LifeOS key/time validation and Git outage fail before receipt creation; legacy remains opt out',async t=>{
 const f=await routesFixture(t);
 assert.equal(parseLifeosRequestIdentity(undefined,undefined),undefined);
 for(const [key,signedAt] of [['valid-key',undefined],['bad',f.source.signedAt],
  [['duplicate-key'],f.source.signedAt],['valid-key','2026-02-30T00:00:00.000Z'],['valid-key','2026-11-08'],
  ['valid-key','2026-11-08T01:00:00Z'],['valid-key','invalid']]) {
  assert.throws(()=>parseLifeosRequestIdentity(key,signedAt),{status:400});
  assert.equal((await f.invoke('POST',{key,body:{signedAt}})).status,400);
 }
 assert.throws(()=>parseLifeosRequestIdentity(undefined,f.source.signedAt),{status:400});
 assert.equal(f.getCreates(),0);
 f.setAvailable(false);
 assert.equal((await f.invoke('POST')).status,503);
 assert.equal((await f.invoke('GET')).status,503);
 assert.equal(f.getCreates(),0);
 f.setAvailable(true);
 const a=await f.invoke('POST',{legacy:true,body:{}}), b=await f.invoke('POST',{legacy:true,body:{}});
 assert.equal(a.status,201);assert.equal(b.status,201);assert.notEqual(a.body.id,b.body.id);
});

test('LifeOS proof binds storage before the first keyed POST and unauthorized requests never write',async t=>{
 const f=await routesFixture(t);
 const before=(await f.service.replay()).events.length;
 assert.equal((await f.invoke('POST',{auth:'Bearer wrong'})).status,403);
 assert.equal((await f.invoke('POST',{auth:'Bearer wrong',key:'bad'})).status,403);
 assert.equal(f.getCreates(),0);
 assert.equal((await f.service.replay()).events.length,before);
 const first=await f.invoke('POST');
 assert.equal(first.status,201);
 assert.equal(f.getCreates(),1);
 assert.equal((await f.service.replay()).events.length,before+1);
 assert.deepEqual(await f.invoke('POST'),first);
 assert.equal((await f.invoke('GET')).status,200);
 assert.equal((await f.invoke('POST',{auth:'Bearer wrong'})).status,403);
 assert.equal(f.getCreates(),2); // Only the authorized first request and replay reached issuance.
 assert.equal((await f.service.replay()).events.length,before+1);
});
