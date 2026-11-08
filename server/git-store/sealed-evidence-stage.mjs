// Source-only historical evidence staging from authenticated complete SQL snapshot.
// The returned encrypted transactions are private and MUST be durably persisted
// before append: fresh AES-GCM nonces make regenerating a stage non-idempotent.
import {createHmac, timingSafeEqual} from 'node:crypto';
import {MAX_EVENT_BYTES} from './store.mjs';
import {receiptFields} from './schema.mjs';
import {TABLE_COLUMNS} from './full-state-inventory.mjs';
import {openSealedFullState} from './full-state-sealed.mjs';
import {verifySealedMigrationRelations} from './sealed-migration-relations.mjs';
import {
  protectLegacyReceipt,restoreProtectedReceipt,verifyProtectedReceiptCore
} from './protected-receipt.mjs';
import {
  protectLegacyAuditLog,restoreProtectedAuditLog,verifyProtectedAuditCore
} from './protected-audit.mjs';

const ERROR='Sealed historical Git staging failed';
const fail=()=>new Error(ERROR);
const RECEIPT_COLUMNS=[
 'id','user_id','org_id','repository_id','file_hash','file_name','file_path',
 'model_name','model_provider','country_of_origin','detected_country',
 'compliance_status','attestation_type','parent_attestation_id','audit_verdict',
 'audit_details','signature','public_key','prev_entry_hash','entry_hash',
 'receipt_version','signed_at','git_commit_url','git_commit_message','metadata','created_at',
];
const AUDIT_COLUMNS=[
 'id','user_id','action','resource_type','resource_id','metadata','ip_address','created_at',
];
const AUDIT_CAMEL=[
 'id','userId','action','resourceType','resourceId','metadata','ipAddress','createdAt',
];
function assertMapper(sqlTable,sqlNames,gitNames) {
 const expected=TABLE_COLUMNS[sqlTable];
 if (!expected || sqlNames.length!==expected.length ||
     sqlNames.some((column,i)=>column!==expected[i]) ||
     gitNames.length!==sqlNames.length ||
     new Set(gitNames).size!==gitNames.length) throw fail();
}
assertMapper('attestation_receipts',RECEIPT_COLUMNS,receiptFields);
assertMapper('audit_logs',AUDIT_COLUMNS,AUDIT_CAMEL);
const verifiedScope=value=>value &&
 typeof value==='object' && !Array.isArray(value) &&
 Object.keys(value).length===2 &&
 ['tenantId','repositoryId'].every(k=>
  typeof value[k]==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value[k]));
function rowBytes(row,src,dst) {
 if (!row || typeof row!=='object' || Array.isArray(row) ||
     Object.keys(row).length!==src.length ||
     src.some(k=>!Object.hasOwn(row,k))) throw fail();
 const mapped={};
 for(let i=0;i<src.length;i++)mapped[dst[i]]=row[src[i]];
 return Buffer.from(JSON.stringify(mapped),'utf8');
}
function hmac(key,value) {
 return createHmac('sha256',key).update(value).digest('hex');
}
/**
 * Bound, non-production historical evidence stage.
 * The encrypted original is a complete canonical SQL-export projection, NOT
 * a claim about original HTTP issuance serialization or PostgreSQL raw bytes.
 * The returned private transaction sequence MUST be stored verbatim before
 * applying to any private Git stream and never sent to public GitHub/logs.
 */
export function stageSealedHistoricalGitEvidence(
 envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust,archiveKey
) {
 try {
   if (!verifiedScope(scope) ||
       !Buffer.isBuffer(encryptionKey) || encryptionKey.length!==32 ||
       !Buffer.isBuffer(hmacKey) || hmacKey.length!==32 ||
       !Buffer.isBuffer(archiveKey) || archiveKey.length!==32 ||
       encryptionKey.equals(hmacKey) || encryptionKey.equals(archiveKey) ||
       hmacKey.equals(archiveKey)) throw fail();
   const report=verifySealedMigrationRelations(
     envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust);
   if (!report || report.importEligible!==true ||
       report.productionGoAllowed!==false) throw fail();
   const source=openSealedFullState(
     envelope,scope,encryptionKey,hmacKey,reviewedManifest);
   if (!Array.isArray(source.attestation_receipts) ||
       !Array.isArray(source.audit_logs)) throw fail();
   const receiptRows=[...source.attestation_receipts].sort((a,b)=>a.id-b.id);
   const auditRows=[...source.audit_logs].sort((a,b)=>a.id-b.id);
   if (receiptRows.length!==report.receiptFindings.count ||
       auditRows.length!==report.tableCounts.audit_logs ||
       typeof report.sourceCommitment!=='string' ||
       !/^[a-f0-9]{64}$/.test(report.sourceCommitment)) throw fail();
   const tenant=scope.tenantId,repository=scope.repositoryId;
   const trusted=new Set(trust.originalReceiptPublicKeys);
   const transactions=[];
   const tag=hmac(hmacKey,'forgeproof:0b:historical-source:v1:'+
       tenant+'/'+repository+':'+report.sourceCommitment).slice(0,32);
   let predecessor=null;
   let privateReceiptCount=0,privateAuditCount=0;
   for(const row of receiptRows) {
     const original=rowBytes(row,RECEIPT_COLUMNS,receiptFields);
     if(row.prev_entry_hash!==predecessor) throw fail();
     if(row.metadata!==null || row.audit_details!==null)privateReceiptCount++;
     const protectedRecord=protectLegacyReceipt(original,tenant,repository,archiveKey);
     const signed=verifyProtectedReceiptCore(protectedRecord);
     if (!trusted.has(signed.publicKey) ||
         signed.id!==row.id ||
         signed.prevEntryHash!==predecessor) throw fail();
     if (!timingSafeEqual(restoreProtectedReceipt(protectedRecord,
       tenant,repository,archiveKey),original)) throw fail();
     predecessor=signed.entryHash;
     const transaction={idempotencyKey:'he_'+tag+'_r_'+row.id,
       operations:[{kind:'receipts',id:row.id,action:'put',
         expectedVersion:null,record:protectedRecord}]};
     if (Buffer.byteLength(JSON.stringify(transaction),'utf8')>MAX_EVENT_BYTES-1024)
       throw fail();
     transactions.push(transaction);
   }
   if ((predecessor??null)!==(trust.expectedReceiptHeadHash??null)) throw fail();
   for(const row of auditRows) {
     const original=rowBytes(row,AUDIT_COLUMNS,AUDIT_CAMEL);
     if(row.metadata!==null)privateAuditCount++;
     const protectedRecord=protectLegacyAuditLog(original,tenant,repository,archiveKey);
     const safe=verifyProtectedAuditCore(protectedRecord);
     if(safe.id!==row.id) throw fail();
     if (!timingSafeEqual(restoreProtectedAuditLog(protectedRecord,
       tenant,repository,archiveKey),original)) throw fail();
     const transaction={idempotencyKey:'he_'+tag+'_a_'+row.id,
       operations:[{kind:'auditLogs',id:row.id,action:'put',
         expectedVersion:null,record:protectedRecord}]};
     if (Buffer.byteLength(JSON.stringify(transaction),'utf8')>MAX_EVENT_BYTES-1024)
       throw fail();
     transactions.push(transaction);
   }
   const stage={version:1,transactions};
   const stageDigest='hmac-sha256:'+hmac(archiveKey,
     JSON.stringify(stage));
   return {
     privateStage:stage,
     summary:{
       receiptCount:receiptRows.length,
       auditCount:auditRows.length,
       encryptedPrivateReceiptCount:privateReceiptCount,
       encryptedAuditMetadataCount:privateAuditCount,
       sourceCommitment:report.sourceCommitment,
       stageDigest,
       mustPersistExactStageBeforeAnyAppend:true,
       stageIsRegenerationUnsafe:true,
       productionGoAllowed:false,
       fullApplicationMigrationComplete:false,
     },
   };
 } catch {
   throw fail();
 }
}
