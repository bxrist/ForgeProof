import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomBytes,sign,verify,createHash} from 'node:crypto';
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
