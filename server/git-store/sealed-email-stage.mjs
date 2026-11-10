// Source-only staging; never publish or log private stages. No live importer.
import {createHmac} from 'node:crypto';
import {TABLE_COLUMNS} from './full-state-inventory.mjs';
import {openSealedFullState} from './full-state-sealed.mjs';
import {verifySealedMigrationRelations} from './sealed-migration-relations.mjs';
import {protectQueuedEmail,restoreQueuedEmail,verifyProtectedEmailCore} from './protected-email.mjs';
import {MAX_EVENT_BYTES} from './store.mjs';

const ERROR='Sealed pending-email Git staging failed';
const COLUMNS=['id','to','subject','body_html','body_text','retry_count','next_retry_at','status','created_at'];
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest('hex');

/**
 * All-or-nothing, lossless mapping of compatible normalized SQL email rows.
 * Persist the exact privateStage before append: random nonces make regeneration
 * unsafe for retry despite deterministic transaction IDs. No delivery is done.
 */
export function stageSealedPendingEmails(
 envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust,mailKey
) {
 try {
  if ([encryptionKey,hmacKey,mailKey].some(k=>!Buffer.isBuffer(k)||k.length!==32) ||
      encryptionKey.equals(hmacKey)||encryptionKey.equals(mailKey)||hmacKey.equals(mailKey))
   throw new Error();
  if (COLUMNS.length!==TABLE_COLUMNS.pending_emails.length ||
      COLUMNS.some((c,i)=>c!==TABLE_COLUMNS.pending_emails[i])) throw new Error();
  const report=verifySealedMigrationRelations(
   envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust);
  if (report.importEligible!==true || report.productionGoAllowed!==false) throw new Error();
  const source=openSealedFullState(envelope,scope,encryptionKey,hmacKey,reviewedManifest);
  const rows=source.pending_emails;
  if (!Array.isArray(rows)||rows.length!==report.tableCounts.pending_emails ||
      !/^[a-f0-9]{64}$/.test(report.sourceCommitment)) throw new Error();
  const tag=hmac(hmacKey,'forgeproof:0b:pending-email:v1:'+scope.tenantId+'/'+
   scope.repositoryId+':'+report.sourceCommitment).slice(0,32);
  const transactions=[];
  for (const row of [...rows].sort((a,b)=>a.id-b.id)) {
   if (Object.keys(row).length!==COLUMNS.length ||
       COLUMNS.some(c=>!Object.hasOwn(row,c))) throw new Error();
   // Match signed-store insertion invariants; never reset historical attempts.
   if (row.status!=='pending' || row.retry_count!==0) throw new Error();
   const content={to:row.to,subject:row.subject,bodyText:row.body_text,bodyHtml:row.body_html};
   const record={id:row.id,status:row.status,retryCount:row.retry_count,
    nextRetryAt:row.next_retry_at,createdAt:row.created_at,
    ...protectQueuedEmail(content,scope.tenantId,scope.repositoryId,row.id,mailKey)};
   verifyProtectedEmailCore(record);
   const recovered=restoreQueuedEmail(record,scope.tenantId,scope.repositoryId,mailKey);
   const restored={id:record.id,to:recovered.to,subject:recovered.subject,
    body_html:recovered.bodyHtml,body_text:recovered.bodyText,
    retry_count:record.retryCount,next_retry_at:record.nextRetryAt,
    status:record.status,created_at:record.createdAt};
   if (COLUMNS.some(c=>restored[c]!==row[c])) throw new Error();
   const transaction={idempotencyKey:'mail_'+tag+'_'+row.id,
    operations:[{kind:'pendingEmails',id:row.id,action:'put',expectedVersion:null,record}]};
   if (Buffer.byteLength(JSON.stringify(transaction),'utf8')>MAX_EVENT_BYTES-1024)
    throw new Error();
   transactions.push(transaction);
  }
  // The keyed proof binds source, scope, complete scheduling state and ciphertext.
  const privateStage={version:1,sourceCommitment:report.sourceCommitment,
   scope:{tenantId:scope.tenantId,repositoryId:scope.repositoryId},transactions};
  return {privateStage,summary:{emailCount:rows.length,sourceCommitment:report.sourceCommitment,
   stageDigest:'hmac-sha256:'+hmac(mailKey,JSON.stringify(privateStage)),
   mustPersistExactStageBeforeAnyAppend:true,stageIsRegenerationUnsafe:true,
   productionGoAllowed:false,fullApplicationMigrationComplete:false}};
 } catch { throw new Error(ERROR); }
}
