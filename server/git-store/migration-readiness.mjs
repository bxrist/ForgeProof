// Pure source preflight: adapters are deliberately opaque and never invoked.
import {openSealedFullState} from './full-state-sealed.mjs';
import {verifySealedMigrationRelations} from './sealed-migration-relations.mjs';
import {assessSealedSessionContinuity} from './sealed-session-continuity.mjs';
import {stageSealedHistoricalGitEvidence} from './sealed-evidence-stage.mjs';
import {stageSealedPendingEmails} from './sealed-email-stage.mjs';
import {validateRecord} from './schema.mjs';
import {TABLE_ORDER} from './full-state-inventory.mjs';

const ERROR='Migration readiness preflight failed';
const core={users:'users',organizations:'organizations',repositories:'repositories',
 org_members:'orgMembers',subscriptions:'subscriptions'};
const camel=s=>s.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
const placeholder='custodian:00000000-0000-4000-8000-000000000000';

/** Authenticated owner workflow supplies source, signer pins and adapter binding.
 * No adapter capability/durability is inferred from an object or assertion.
 * Pure evidence/mail validators generate ephemeral ciphertext in memory only;
 * these bytes are discarded and MUST NOT be used as a retryable migration stage.
 */
export function preflightMigrationReadiness({envelope,scope,encryptionKey,hmacKey,
 reviewedManifest,trust,archiveKey,mailKey,now,binding,custodian,journal}) {
 try {
  if (!binding || Object.keys(binding).sort().join(',')!==
      'authenticated,custodyScope,durableExternalVault,repositoryId,tenantId' ||
      binding.authenticated!==true || binding.durableExternalVault!==true ||
      binding.tenantId!==scope.tenantId || binding.repositoryId!==scope.repositoryId ||
      binding.custodyScope!==scope.tenantId+'/'+scope.repositoryId ||
      !custodian || !journal) throw new Error();
  const keys=[encryptionKey,hmacKey,archiveKey,mailKey];
  if(keys.some(k=>!Buffer.isBuffer(k)||k.length!==32) ||
     keys.some((k,i)=>keys.slice(i+1).some(other=>k.equals(other))))throw new Error();
  const args=[envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust];
  const report=verifySealedMigrationRelations(...args);
  if(report.importEligible!==true)throw new Error();
  const source=openSealedFullState(envelope,scope,encryptionKey,hmacKey,reviewedManifest);
  const sessions=assessSealedSessionContinuity(...args,now);
  let coreCount=0;
  for(const [table,kind] of Object.entries(core)) for(const row of source[table]) {
   const record=Object.fromEntries(Object.entries(row).map(([k,v])=>
    [k==='github_token'?'githubTokenRef':camel(k),k==='github_token'?null:v]));
   validateRecord(kind,record);coreCount++;
   if(table==='users' && row.github_token!==null &&
      (typeof row.github_token!=='string'||!row.github_token||row.github_token.length>16384))throw new Error();
  }
  if(coreCount>1000 || source.api_keys.length>1000)throw new Error();
  for(const sub of source.subscriptions) {
   if(source.subscriptions.filter(s=>s.user_id===sub.user_id).length!==1)throw new Error();
   if(sub.org_id!==null && !source.organizations.some(o=>o.id===sub.org_id &&
     (o.owner_id===sub.user_id || source.org_members.some(m=>m.org_id===o.id && m.user_id===sub.user_id))))throw new Error();
  }
  const hashes=new Set(),prefixes=new Set();
  for(const row of source.api_keys) {
   if(typeof row.key_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.key_hash)||
      typeof row.key_prefix!=='string'||!/^[a-zA-Z0-9_]{1,12}$/.test(row.key_prefix)||
      hashes.has(row.key_hash)||prefixes.has(row.key_prefix)||
      source.subscriptions.filter(s=>s.user_id===row.user_id).length!==1)throw new Error();
   hashes.add(row.key_hash);prefixes.add(row.key_prefix);
   const record=Object.fromEntries(Object.entries(row).filter(([k])=>
    !['key_hash','key_prefix'].includes(k)).map(([k,v])=>[camel(k),v]));
   validateRecord('apiKeys',{...record,credentialRef:placeholder});
   const metadata=JSON.stringify(record);
   if(metadata.includes(row.key_hash)||metadata.includes(row.key_prefix))throw new Error();
  }
  // Existing validators check round-trip preservation and event-size bounds.
  // No custody, journal, Git, DB, mail transport or network adapter is called.
  stageSealedHistoricalGitEvidence(...args,archiveKey);
  stageSealedPendingEmails(...args,mailKey);
  return {
   version:1,status:sessions.sessionCount?'STOP':'SOURCE_PREFLIGHT_PASSED',
   tableCounts:Object.fromEntries(TABLE_ORDER.map(t=>[t,source[t].length])),
   sourceCommitment:report.sourceCommitment,
   sessionCount:sessions.sessionCount,activeSessionCount:sessions.activeCount,
   expiredSessionCount:sessions.expiredCount,
   sourcePreflightPassed:true,stageCompatibilityProven:false,
   custodyVerified:false,journalVerified:false,fullMigrationReady:false,
   productionGoAllowed:false,fullApplicationMigrationComplete:false,
   gates:{sessions:sessions.status,custody:'NOT_PROBED',journal:'NOT_PROBED',
    exactStages:'NOT_CREATED',combinedReplay:'NOT_PROVEN'},
  };
 } catch {throw new Error(ERROR);}
}
