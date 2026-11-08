import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {buildProtectedHistoricalArchivePreflight} from '../server/git-store/protected-archive.mjs';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {restoreProtectedReceipt} from '../server/git-store/protected-receipt.mjs';
import {restoreProtectedAuditLog} from '../server/git-store/protected-audit.mjs';

const hash = s=>createHash('sha256').update(s).digest('hex');
function fixture() {
  const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const publicKey=keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'');
  const ts='2026-11-07T21:00:00.000Z';
  const make=(id,prev,tag)=>{
    const r={id,userId:'synthetic-user',fileHash:'sha256:'+'a'.repeat(64),fileName:'fixture.ts',
      filePath:'src/fixture.ts',modelName:'fixture-model',modelProvider:'fixture-provider',
      countryOfOrigin:'unknown',detectedCountry:null,complianceStatus:'unverified',
      attestationType:'origin',orgId:null,repositoryId:null,parentAttestationId:id===102?101:null,
      auditVerdict:null,gitCommitUrl:null,gitCommitMessage:null,
      prevEntryHash:prev,signedAt:ts,createdAt:ts,
      receiptVersion:'v1',publicKey,metadata:{privateTag:tag},auditDetails:'audit-'+tag};
    r.entryHash=hash([r.fileHash,r.modelName,r.modelProvider,r.countryOfOrigin,prev||'genesis',ts].join('|'));
    r.signature=sign(null,Buffer.from([r.entryHash,r.fileHash,ts].join('|')),keys.privateKey).toString('base64');
    return r;
  };
  const r1=make(101,null,'PRIVATE_CHAIN_SENTINEL_A');
  const r2=make(102,r1.entryHash,'PRIVATE_CHAIN_SENTINEL_B');
  const original1=Buffer.from(JSON.stringify(r1,null,2)+'\n');
  const original2=Buffer.from('\n '+JSON.stringify(r2,null,2)+'\n');
  const audit1={id:6,userId:'synthetic-user',action:'inspect',resourceType:'fixture',
    resourceId:'fixture-6',metadata:{private:'PRIVATE_AUDIT_SENTINEL'},
    ipAddress:null,createdAt:ts};
  const audit2={id:7,userId:'synthetic-user',action:'inspect',resourceType:'fixture',
    resourceId:'fixture-7',metadata:null,ipAddress:null,createdAt:ts};
  const auditBytes1=Buffer.from(JSON.stringify(audit1,null,2)+'\n');
  const auditBytes2=Buffer.from('\n '+JSON.stringify(audit2));
  const source={version:2,tenant:'private-archive',repository:'global-receipts',
    manifest:{expectedReceiptCount:2,expectedAuditCount:2,expectedHeadHash:r2.entryHash,
      trustedOriginalReceiptPublicKeys:[publicKey],sourceDbFingerprint:'synthetic-source-001'},
    receipts:[{id:101,originalBytes:original1},{id:102,originalBytes:original2}],
    auditLogs:[{id:6,originalBytes:auditBytes1},{id:7,originalBytes:auditBytes2}]};
  return {keys,publicKey,make,r1,r2,source,original1,original2,auditBytes1,auditBytes2};
}
test('strict protected export preflight, full signed Git replay and exact-byte disconnected recovery', async t=>{
  const f=fixture(), key=randomBytes(32);
  const packaged=buildProtectedHistoricalArchivePreflight(f.source,key);
  assert.equal(packaged.stagedMigration.version,1);
  assert.equal(packaged.stagedMigration.transactions.length,4);
  assert.equal(packaged.sourceSummary.uniqueOriginalSigners,1);
  assert.match(packaged.stageDigest,/^sha256:[a-f0-9]{64}$/);
  const stageText=JSON.stringify(packaged.stagedMigration);
  assert.doesNotMatch(stageText,/PRIVATE_CHAIN_SENTINEL|PRIVATE_AUDIT_SENTINEL/);
  assert.equal(packaged.reviewedManifest.expectedReceiptCount,2);
  const root=await mkdtemp(join(tmpdir(),'forgeproof-reviewed-export-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'private.git');
  execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
  const eventKeys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const signer={actor:'synthetic-migrator',keyId:'synthetic-key',sign:async bytes=>sign(null,bytes,eventKeys.privateKey).toString('base64')};
  const options={directory,tenant:f.source.tenant,repository:f.source.repository,
    trust:{eventKeys:{'synthetic-key':{actor:signer.actor,publicKey:eventKeys.publicKey}},
      receiptKeys:[f.publicKey],receiptPredecessor:null},
    checkpoint:null,signer};
  const service=new GitAppStateService(options);
  let last;
  for (const transaction of packaged.stagedMigration.transactions) {
    last=await service.append(transaction);
    assert.equal((await service.append(transaction)).duplicate,true);
  }
  let state=await service.replay();
  assert.equal(state.events.length,4);
  assert.equal(state.receiptHead,f.r2.entryHash);
  assert.deepEqual(restoreProtectedReceipt(state.records.receipts[101],options.tenant,options.repository,key),f.original1);
  assert.deepEqual(restoreProtectedReceipt(state.records.receipts[102],options.tenant,options.repository,key),f.original2);
  assert.deepEqual(restoreProtectedAuditLog(state.records.auditLogs[6],options.tenant,options.repository,key),f.auditBytes1);
  assert.deepEqual(restoreProtectedAuditLog(state.records.auditLogs[7],options.tenant,options.repository,key),f.auditBytes2);
  const clone=join(root,'independent.git');
  execFileSync('git',['clone','--mirror',directory,clone],{stdio:'ignore'});
  const independent=new GitAppStateService({...options,directory:clone,checkpoint:last.checkpoint,signer:undefined});
  state=await independent.replay();
  assert.equal(state.events.length,4);
  assert.equal(state.receiptHead,f.r2.entryHash);
  assert.deepEqual(restoreProtectedReceipt(state.records.receipts[102],options.tenant,options.repository,key),f.original2);
  assert.deepEqual(restoreProtectedAuditLog(state.records.auditLogs[7],options.tenant,options.repository,key),f.auditBytes2);
});
test('full preflight rejects wrong reviewed manifest, untrusted signer, missing predecessor and altered source',()=>{
  const f=fixture(), key=randomBytes(32);
  const base=f.source;
  const build=s=>buildProtectedHistoricalArchivePreflight(s,key);
  assert.throws(()=>build({...base,manifest:{...base.manifest,expectedHeadHash:'f'.repeat(64)}}),/Reviewed receipt head mismatch/);
  assert.throws(()=>build({...base,manifest:{...base.manifest,trustedOriginalReceiptPublicKeys:[generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}).publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'')]}}),/Untrusted historical signer/);
  const wrongParent=f.make(102,'f'.repeat(64),'PRIVATE_SYNTHETIC_WRONG_PARENT');
  const wrongBytes=Buffer.from(JSON.stringify(wrongParent));
  assert.throws(()=>build({...base,receipts:[base.receipts[0],{id:102,originalBytes:wrongBytes}]}),/Receipt predecessor mismatch/);
  assert.throws(()=>build({...base,receipts:[base.receipts[0],base.receipts[0]]}),/Duplicate receipt id/);
  const tampered=JSON.parse(f.original2);
  tampered.modelName='forged-model';
  assert.throws(()=>build({...base,receipts:[base.receipts[0],{id:102,originalBytes:Buffer.from(JSON.stringify(tampered))}]}),/Invalid historical receipt signature\/hash/);
  assert.throws(()=>build({...base,manifest:{...base.manifest,expectedAuditCount:3}}),/Audit count mismatch/);
  assert.throws(()=>build({...base,extraneous:true}),/Invalid source fields/);
  const incomplete=JSON.parse(f.original1);
  delete incomplete.auditDetails;
  assert.throws(()=>build({...base,receipts:[{id:101,originalBytes:Buffer.from(JSON.stringify(incomplete))},base.receipts[1]]}),/complete SQL receipt row/);
});
