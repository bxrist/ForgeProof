import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';

test('signed annotation preserves immutable receipt bytes and verifies owner, URL and clone',async t=>{
 const root=await mkdtemp(join(tmpdir(),'forgeproof-ann-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const bare=join(root,'private.git');
 execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
 const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const publicKey=keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'');
 const signer={actor:'fixture',keyId:'fixture-key',sign:async b=>sign(null,b,keys.privateKey).toString('base64')};
 const trust={eventKeys:{'fixture-key':{actor:'fixture',publicKey:keys.publicKey}},receiptKeys:[publicKey],receiptPredecessor:null};
 const config={directory:bare,tenant:'fixture-tenant',repository:'fixture-repo',trust,checkpoint:null,signer};
 const service=new GitAppStateService(config);
 const ts='2026-11-07T21:00:00.000Z',fh='sha256:'+'a'.repeat(64);
 const r={id:101,userId:'owner',orgId:null,repositoryId:null,fileHash:fh,
  fileName:'fixture.ts',filePath:'src/fixture.ts',modelName:'fixture',modelProvider:'fixture',
  countryOfOrigin:'unknown',detectedCountry:null,complianceStatus:'unverified',
  attestationType:'origin',parentAttestationId:null,auditVerdict:null,auditDetails:null,
  signature:'',publicKey,prevEntryHash:null,entryHash:'',receiptVersion:'v1',
  signedAt:ts,gitCommitUrl:null,gitCommitMessage:null,metadata:null,createdAt:ts};
 r.entryHash=createHash('sha256').update([fh,r.modelName,r.modelProvider,r.countryOfOrigin,'genesis',ts].join('|')).digest('hex');
 r.signature=sign(null,Buffer.from([r.entryHash,fh,ts].join('|')),keys.privateKey).toString('base64');
 const original=JSON.stringify(r);
 const put=(kind,id,record)=>({kind,id,action:'put',expectedVersion:null,record});
 await service.append({idempotencyKey:'bootstrap',operations:[
  put('users','owner',{id:'owner',email:'owner@example.invalid'}),
  put('receipts',101,{id:101,original})
 ]});
 const owner=new GitStorage(service,'owner',['owner'],'owner');
 const other=new GitStorage(service,'other',['owner','other'],'owner');
 const url='https://github.com/FlyingCloud/ForgeProof/commit/'+'a'.repeat(40);
 await assert.rejects(other.updateAttestationGitCommitUrl(101,url),/Only owner/);
 await assert.rejects(owner.updateAttestationGitCommitUrl(999,url),/Receipt not found/);
 for(const invalid of [
  'https://github.com.evil.com/FlyingCloud/ForgeProof/commit/'+'a'.repeat(40),
  'https://user:pass@github.com/FlyingCloud/ForgeProof/commit/'+'a'.repeat(40),
  'http://github.com/FlyingCloud/ForgeProof/commit/'+'a'.repeat(40),
  'https://github.com/../Repo/commit/'+'a'.repeat(40),
  'https://github.com/Org/../commit/'+'a'.repeat(40),
  url+'?token=secret'
 ]) await assert.rejects(owner.updateAttestationGitCommitUrl(101,invalid),/Invalid git commit URL/);
 await owner.updateAttestationGitCommitUrl(101,url.slice(0,-40)+'A'.repeat(40),'synthetic-export');
 let snapshot=await service.replay();
 assert.equal(snapshot.records.receipts[101].original,original);
 assert.equal(snapshot.records.receiptAnnotations[101].receiptEntryHash,r.entryHash);
 for(const value of [
  await owner.getAttestation(101),
  (await owner.getAttestations('owner'))[0],
  (await owner.getAllAttestationsOrdered())[0],
  await owner.getAttestationByEntryHash(r.entryHash)
 ]){assert.equal(value.gitCommitUrl,url);assert.equal(value.gitCommitMessage,'synthetic-export');}
 await owner.updateAttestationGitCommitUrl(101,url,'synthetic-export');
 await assert.rejects(owner.updateAttestationGitCommitUrl(101,url,'conflicting'),/Conflicting receipt annotation/);
 snapshot=await service.replay();
 assert.equal(snapshot.records.receipts[101].original,original);
 await assert.rejects(service.append({idempotencyKey:'annotation-with-bad-id',operations:[
  put('receiptAnnotations',202,{id:202,receiptEntryHash:r.entryHash,gitCommitUrl:url,gitCommitMessage:null,createdAt:ts})
 ]}),/Missing annotated receipt/);
 await assert.rejects(service.append({idempotencyKey:'annotation-delete',operations:[
  {kind:'receiptAnnotations',id:101,action:'delete',expectedVersion:snapshot.versions['receiptAnnotations/101']}
 ]}),/Invalid deletion/);
 const clone=join(root,'disconnected.git');
 execFileSync('git',['clone','--mirror',bare,clone],{stdio:'ignore'});
 const independent=new GitAppStateService({...config,directory:clone,checkpoint:snapshot.checkpoint,signer:undefined});
 const detached=new GitStorage(independent,'owner',['owner'],'owner');
 assert.equal((await detached.getAttestation(101)).gitCommitUrl,url);
 assert.equal((await independent.replay()).records.receipts[101].original,original);
});
