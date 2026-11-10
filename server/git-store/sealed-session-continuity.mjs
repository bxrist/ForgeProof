// Source-only STOP gate. This is not a session importer or authentication adapter.
import {TABLE_COLUMNS,normalizeRowStrict} from './full-state-inventory.mjs';
import {openSealedFullState} from './full-state-sealed.mjs';
import {verifySealedMigrationRelations} from './sealed-migration-relations.mjs';

const ERROR='Sealed session continuity assessment failed';

/** No provider mapping or compatibility contract is implemented in the existing
 * runtime. Do not accept assertions pretending to supply either. No custodian,
 * store, callback, network client or session contents escape this function.
 * now is an explicit review instant, not an authorization or expiry mutation.
 */
export function assessSealedSessionContinuity(
 envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust,now
) {
 try {
  if (arguments.length!==7 || typeof now!=='string' ||
      !Number.isFinite(Date.parse(now)) || new Date(now).toISOString()!==now ||
      TABLE_COLUMNS.sessions.join(',')!=='sid,sess,expire') throw new Error();
  const report=verifySealedMigrationRelations(
   envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust);
  if (report.importEligible!==true || report.productionGoAllowed!==false) throw new Error();
  const source=openSealedFullState(envelope,scope,encryptionKey,hmacKey,reviewedManifest);
  const seen=new Set();
  let activeCount=0,expiredCount=0;
  for (const input of source.sessions) {
   const row=normalizeRowStrict('sessions',input,TABLE_COLUMNS.sessions);
   if (seen.has(row.sid) || !row.sess || typeof row.sess!=='object' ||
       Array.isArray(row.sess) || typeof row.expire!=='string' ||
       !Number.isFinite(Date.parse(row.expire))) throw new Error();
   seen.add(row.sid);
   // Require normalized SQL JSON object, never parse a second encoded string,
   // extract an identity, rewrite cookie timestamps, or drop expired records.
   if (JSON.stringify(JSON.parse(JSON.stringify(row.sess)))!==JSON.stringify(row.sess))
    throw new Error();
   if (Date.parse(row.expire)<=Date.parse(now)) expiredCount++;
   else activeCount++;
  }
  return {
   version:1,status:source.sessions.length?'STOP':'EMPTY_SOURCE',
   sessionCount:source.sessions.length,activeCount,expiredCount,
   stagedSessionCount:0,sessionStageComplete:source.sessions.length===0,
   stopReasons:source.sessions.length?[
    'AUTH_PROVIDER_PRINCIPAL_MAPPING_NOT_INTEGRATED',
    'REVIEWED_SID_COOKIE_CONTINUITY_CONTRACT_NOT_IMPLEMENTED',
   ]:[],
   productionGoAllowed:false,fullApplicationMigrationComplete:false,
  };
 } catch {throw new Error(ERROR);}
}
