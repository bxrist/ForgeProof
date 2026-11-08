import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign,createHash} from 'node:crypto';
import {captureProtectedEvidence} from '../server/git-store/snapshot-protected.mjs';
import {receiptFields} from '../server/git-store/schema.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const sqlKey=key=>key.replace(/[A-Z]/g,letter=>'_'+letter.toLowerCase());

function fixture() {
 const keys=generateKeyPairSync('ed25519',{
   publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}
 });
 const publicKey=keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'');
 const ts='2026-11-07T21:00:00.000Z';
 const make=(id,prev,tag)=>{
   const row={id,userId:'synthetic-user',orgId:null,repositoryId:null,
     fileHash:'sha256:'+'a'.repeat(64),fileName:'fixture.ts',filePath:'src/fixture.ts',
     modelName:'fixture-model',modelProvider:'fixture-provider',countryOfOrigin:'unknown',
     detectedCountry:null,complianceStatus:'unverified',attestationType:'origin',
     parentAttestationId:id===1?null:1,auditVerdict:null,auditDetails:'audit-'+tag,
     signature:'',publicKey,prevEntryHash:prev,entryHash:'',receiptVersion:'v1',
     signedAt:ts,gitCommitUrl:null,gitCommitMessage:null,
     metadata:{private:'PRIVATE_SNAPSHOT_SENTINEL_'+tag},createdAt:ts};
   assert.deepEqual(Object.keys(row).sort(),[...receiptFields].sort());
   row.entryHash=hash([row.fileHash,row.modelName,row.modelProvider,row.countryOfOrigin,prev||'genesis',ts].join('|'));
   row.signature=sign(null,Buffer.from([row.entryHash,row.fileHash,ts].join('|')),keys.privateKey).toString('base64');
   return row;
 };
 const first=make(1,null,'A');
 const second=make(2,first.entryHash,'B');
 const logs=[
  {id:4,userId:'synthetic-user',action:'write',resourceType:'fixture',resourceId:'4',
    metadata:{message:'PRIVATE_AUDIT_SENTINEL'},ipAddress:null,createdAt:ts},
  {id:5,userId:'synthetic-user',action:'read',resourceType:'fixture',resourceId:'5',
    metadata:null,ipAddress:null,createdAt:ts}
 ];
 const rows=records=>records.map(record=>Object.fromEntries(Object.entries(record).map(([k,v])=>[
   sqlKey(k), k==='createdAt'?new Date(v):v
 ])));
 return {
  reviewed:{tenant:'private-archive',repository:'global-receipts',
    manifest:{expectedReceiptCount:2,expectedAuditCount:2,expectedHeadHash:second.entryHash,
      trustedOriginalReceiptPublicKeys:[publicKey],sourceDbFingerprint:'synthetic-pg-fingerprint'}},
  receipts:rows([first,second]),audits:rows(logs)
 };
}
function fakeClient(f,{failSql=null}={}) {
 const calls=[];
 return {calls,async query(sql){
   calls.push(sql);
   if(sql===failSql) throw new Error('PRIVATE_DATABASE_CREDENTIAL_SHOULD_NOT_LEAK');
   if(sql==='SELECT * FROM "attestation_receipts" ORDER BY id') return {rows:f.receipts,rowCount:f.receipts.length};
   if(sql==='SELECT * FROM "audit_logs" ORDER BY id') return {rows:f.audits,rowCount:f.audits.length};
   return {rows:[],rowCount:0};
 }};
}
const begin='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const local="SET LOCAL statement_timeout = '30s'";
const receiptsSql='SELECT * FROM "attestation_receipts" ORDER BY id';
const auditsSql='SELECT * FROM "audit_logs" ORDER BY id';
test('consistent SQL read-only transaction produces only encrypted reviewed signed archive',async()=>{
 const f=fixture(), c=fakeClient(f);
 const result=await captureProtectedEvidence(c,f.reviewed,randomBytes(32));
 assert.deepEqual(c.calls,[begin,local,receiptsSql,auditsSql,'COMMIT']);
 assert.equal(result.sourceSummary.receiptCount,2);
 assert.equal(result.sourceSummary.auditCount,2);
 assert.equal(result.stagedMigration.transactions.length,4);
 assert.match(result.stageDigest,/^sha256:[a-f0-9]{64}$/);
 assert.match(result.serializationNote,/not necessarily original HTTP issuance bytes/);
 const serialized=JSON.stringify(result);
 assert.doesNotMatch(serialized,/PRIVATE_SNAPSHOT_SENTINEL|PRIVATE_AUDIT_SENTINEL/);
 assert.equal('originalBytes' in result,false);
});
test('reviewed signer pins and SQL column mapping fail closed with ROLLBACK',async()=>{
 const f=fixture(),c1=fakeClient(f);
 const bad={...f.reviewed,manifest:{...f.reviewed.manifest,trustedOriginalReceiptPublicKeys:[generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}).publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'')]}};
 await assert.rejects(captureProtectedEvidence(c1,bad,randomBytes(32)),/Protected evidence capture failed/);
 assert.equal(c1.calls.at(-1),'ROLLBACK');
 const f2=fixture();f2.receipts[0].unexpected_private_col='should fail';
 const c2=fakeClient(f2);
 await assert.rejects(captureProtectedEvidence(c2,f2.reviewed,randomBytes(32)),/Protected evidence capture failed/);
 assert.equal(c2.calls.at(-1),'ROLLBACK');
 const f3=fixture();delete f3.receipts[0].file_path;
 const c3=fakeClient(f3);
 await assert.rejects(captureProtectedEvidence(c3,f3.reviewed,randomBytes(32)),/Protected evidence capture failed/);
 assert.equal(c3.calls.at(-1),'ROLLBACK');
});
test('SQL failure uses same connection and rolls back without credential leakage',async()=>{
 const f=fixture(), c=fakeClient(f,{failSql:auditsSql});
 await assert.rejects(captureProtectedEvidence(c,f.reviewed,randomBytes(32)),error=>{
   assert.equal(error.message,'Protected evidence capture failed');
   assert.doesNotMatch(error.message,/PRIVATE_DATABASE_CREDENTIAL/);
   return true;
 });
 assert.deepEqual(c.calls,[begin,local,receiptsSql,auditsSql,'ROLLBACK']);
});
