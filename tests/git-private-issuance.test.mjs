import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomBytes,sign,createHash} from 'node:crypto';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';
import {restoreProtectedReceipt} from '../server/git-store/protected-receipt.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');

test('new original signed receipts atomically increment quota in a private encrypted Git stream', async t=>{
 const root=await mkdtemp(join(tmpdir(),'forgeproof-private-issuance-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'private.git');
 execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
 const keys=generateKeyPairSync('ed25519',{
   publicKeyEncoding:{type:'spki',format:'pem'},
   privateKeyEncoding:{type:'pkcs8',format:'pem'}
 });
 const publicKey=keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'');
 const signer={actor:'test-signer',keyId:'test-signer-key',
   sign:async bytes=>sign(null,bytes,keys.privateKey).toString('base64')};
 const trust={eventKeys:{'test-signer-key':{actor:signer.actor,publicKey:keys.publicKey}},
   receiptKeys:[publicKey],receiptPredecessor:null};
 const options={directory,tenant:'tenant-private',repository:'global-receipts',trust,
   checkpoint:null,signer};
 const service=new GitAppStateService(options);
 const receiptKey=randomBytes(32);
 const owner=new GitStorage(service,'alice',['alice'],'alice',undefined,'',
   undefined,undefined,receiptKey);
 const noKey=new GitStorage(service,'alice',['alice'],'alice');
 await service.append({idempotencyKey:'bootstrap',operations:[{
   kind:'users',id:'alice',action:'put',expectedVersion:null,record:{id:'alice'}
 }]});
 await owner.createSubscription({userId:'alice',plan:'pro',status:'active',
   attestationLimit:4,stripeCustomerId:'cus_synthetic',stripeSubscriptionId:'sub_synthetic',
   currentPeriodStart:new Date('2026-11-01')});

 const signed=(previous=null,metadataText='SYNTHETIC_PRIVATE_SENTINEL_A')=>{
   const ts='2026-11-07T22:00:00.000Z', fh='sha256:'+'a'.repeat(64);
   const x={userId:'alice',fileHash:fh,fileName:'fixture.ts',filePath:'src/fixture.ts',
     modelName:'fixture',modelProvider:'fixture',countryOfOrigin:'unknown',
     complianceStatus:'unverified',detectedCountry:null,
     publicKey,signature:'',prevEntryHash:previous,entryHash:'',receiptVersion:'v1',
     signedAt:ts,metadata:{privateNote:metadataText},auditDetails:'PRIVATE_AUDIT_SYNTHETIC'};
   x.entryHash=sha([x.fileHash,x.modelName,x.modelProvider,x.countryOfOrigin,
     previous||'genesis',ts].join('|'));
   x.signature=sign(null,Buffer.from([x.entryHash,x.fileHash,ts].join('|')),
     keys.privateKey).toString('base64');
   return x;
 };
 const input1=signed();
 await assert.rejects(async()=>noKey.createAttestationAndCount(input1,'without-key'),
   /Receipt protection key required/);
 const first=await owner.createAttestationAndCount(input1,'private-request-1');
 assert.equal(first.id,1);
 assert.equal(first.metadata,null);
 assert.equal(first.auditDetails,null);
 assert.deepEqual(await owner.createAttestationAndCount(input1,'private-request-1'),first);
 await assert.rejects(async()=>owner.createAttestationAndCount({
   ...input1,metadata:{privateNote:'DIFFERENT_PRIVATE_SENTINEL'}
 },'private-request-1'),/Idempotency/);
 assert.equal((await owner.getSubscription('alice')).attestationCount,1);

 const input2=signed(input1.entryHash,'SYNTHETIC_PRIVATE_SENTINEL_B');
 const second=await owner.createAttestationAndCount(input2,'private-request-2');
 assert.equal(second.id,2);
 assert.equal((await owner.getSubscription('alice')).attestationCount,2);

 const evidence=await service.replay();
 assert.equal(evidence.receiptHead,input2.entryHash);
 assert.equal(evidence.events.filter(e=>e.body.operations.some(o=>o.kind==='receipts')).length,2);
 for(const item of [{id:1,source:input1},{id:2,source:input2}]){
   const sealed=evidence.records.receipts[item.id];
   assert.equal(JSON.parse(sealed.originalCore).metadata,null);
   assert.equal(JSON.parse(sealed.originalCore).auditDetails,null);
   assert.deepEqual(JSON.parse(restoreProtectedReceipt(sealed,options.tenant,
     options.repository,receiptKey)),{
       ...JSON.parse(sealed.originalCore),metadata:item.source.metadata,
       auditDetails:item.source.auditDetails
     });
 }
 const stream=JSON.stringify(evidence.events);
 for(const privateText of ['SYNTHETIC_PRIVATE_SENTINEL_A',
   'SYNTHETIC_PRIVATE_SENTINEL_B','PRIVATE_AUDIT_SYNTHETIC']){
   assert.doesNotMatch(stream,new RegExp(privateText));
 }
 assert.doesNotMatch(stream,/"metadata":\s*\{"privateNote"/);
 const safeList=await owner.getAttestations('alice');
 assert.deepEqual(safeList.map(r=>r.id),[2,1]);
 assert.ok(safeList.every(r=>r.metadata===null && r.auditDetails===null));
 const sealed1=evidence.records.receipts[1];
 assert.throws(()=>restoreProtectedReceipt(sealed1,'wrong-tenant',
   options.repository,receiptKey),/Decryption failed/);
 assert.throws(()=>restoreProtectedReceipt(sealed1,options.tenant,
   options.repository,randomBytes(32)),/Decryption failed/);

 const signedNext=signed(input2.entryHash,'SYNTHETIC_PRIVATE_SENTINEL_C');
 const before=evidence.events.length;
 await assert.rejects(async()=>owner.createAttestationAndCount({...signedNext,
   signature:'NOT_VALID'},'bad-signature'),/signature|hash/i);
 await assert.rejects(async()=>owner.createAttestationAndCount({...signedNext,
   signedAt:null},'missing-time'),/signedAt required/);
 await assert.rejects(async()=>owner.createAttestationAndCount({...signedNext,
   userId:'bob'},'wrong-owner'),/owner denied/);
 await assert.rejects(async()=>owner.createAttestationAndCount({...signedNext,
   id:999},'injected-id'),/Unknown attestation field/);
 await assert.rejects(async()=>owner.createAttestationAndCount({...signedNext,
   gitCommitUrl:'https://github.com/example/fake/commit/'+'a'.repeat(40)
 },'fake-export'),/signed annotation/);
 const wrongHead=signed('f'.repeat(64),'SYNTHETIC_PRIVATE_SENTINEL_BAD_HEAD');
 await assert.rejects(async()=>owner.createAttestationAndCount(wrongHead,
   'wrong-head'),/predecessor mismatch/i);
 assert.equal((await service.replay()).events.length,before);
 assert.equal((await owner.getSubscription('alice')).attestationCount,2);

 const clone=join(root,'read-only-clone.git');
 execFileSync('git',['clone','--mirror',directory,clone],{stdio:'ignore'});
 const reopened=new GitAppStateService({...options,directory:clone,checkpoint:evidence.checkpoint,
   signer:undefined});
 assert.equal((await reopened.replay()).receiptHead,input2.entryHash);
 assert.deepEqual(JSON.parse(restoreProtectedReceipt(
   (await reopened.replay()).records.receipts[2],
   options.tenant,options.repository,receiptKey)).metadata,input2.metadata);
});
