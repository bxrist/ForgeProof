// Source-only; caller must privately persist this stage before any append.
import {createHmac} from 'node:crypto';
import {EncryptedProviderCustodian} from './custody.ts';
import {TABLE_COLUMNS} from './full-state-inventory.mjs';
import {openSealedFullState} from './full-state-sealed.mjs';
import {verifySealedMigrationRelations} from './sealed-migration-relations.mjs';
import {canonical,validateRecord} from './schema.mjs';
import {MAX_EVENT_BYTES} from './store.mjs';

const ERROR='Sealed API-key Git staging failed';
const mapping={id:'id',user_id:'userId',name:'name',permissions:'permissions',
 is_active:'isActive',last_used_at:'lastUsedAt',expires_at:'expiresAt',created_at:'createdAt'};
const refPattern=/^custodian:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest('hex');

/** Binding is supplied by authenticated owner workflow, never source/request data.
 * durableExternalVault is an explicit operator assertion, not a durability probe.
 * No app authorization or append occurs here. Custody failures may leave inert
 * staged entries: retain the same source, keys and vault for deterministic retry.
 */
export async function stageSealedApiKeys(
 envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust,custodian,binding
) {
 try {
  if (!(custodian instanceof EncryptedProviderCustodian) || !binding ||
      Object.keys(binding).sort().join(',')!==
       'authenticated,custodyScope,durableExternalVault,repositoryId,tenantId' ||
      binding.authenticated!==true || binding.durableExternalVault!==true ||
      binding.tenantId!==scope.tenantId || binding.repositoryId!==scope.repositoryId ||
      binding.custodyScope!==scope.tenantId+'/'+scope.repositoryId) throw new Error();
  const report=verifySealedMigrationRelations(envelope,scope,encryptionKey,hmacKey,reviewedManifest,trust);
  if (!report.importEligible || report.productionGoAllowed!==false) throw new Error();
  const source=openSealedFullState(envelope,scope,encryptionKey,hmacKey,reviewedManifest);
  // Validate subscription compatibility without applying current issuance quotas.
  for (const sub of source.subscriptions) {
   const record=Object.fromEntries(Object.entries(sub).map(([k,v])=>
    [k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
   validateRecord('subscriptions',record);
   if (source.subscriptions.filter(s=>s.user_id===sub.user_id).length!==1) throw new Error();
   if (sub.org_id!==null) {
    const org=source.organizations.find(o=>o.id===sub.org_id);
    if (!org || (org.owner_id!==sub.user_id && !source.org_members.some(m=>
     m.org_id===sub.org_id && m.user_id===sub.user_id))) throw new Error();
   }
  }
  const columns=TABLE_COLUMNS.api_keys;
  if (columns.length!==Object.keys(mapping).length+2 ||
      columns.some(c=>!Object.hasOwn(mapping,c)&&!['key_hash','key_prefix'].includes(c))) throw new Error();
  if (source.api_keys.length>1000) throw new Error();
  // Prevalidate the whole batch before creating any external custody entries.
  const seenHashes=new Set(),seenPrefixes=new Set();
  const operations=source.api_keys.map(row=>{
   if (Object.keys(row).length!==columns.length || columns.some(c=>!Object.hasOwn(row,c)) ||
       typeof row.key_hash!=='string' || !/^[a-f0-9]{64}$/.test(row.key_hash) ||
       typeof row.key_prefix!=='string' || !/^[a-zA-Z0-9_]{1,12}$/.test(row.key_prefix) ||
       seenHashes.has(row.key_hash) || seenPrefixes.has(row.key_prefix)) throw new Error();
   seenHashes.add(row.key_hash);seenPrefixes.add(row.key_prefix);
   if (source.subscriptions.filter(s=>s.user_id===row.user_id).length!==1) throw new Error();
   const record=Object.fromEntries(Object.entries(mapping).map(([a,b])=>[b,row[a]]));
   validateRecord('apiKeys',{...record,credentialRef:'custodian:00000000-0000-4000-8000-000000000000'});
   return {kind:'apiKeys',id:row.id,action:'put',expectedVersion:null,record};
  }).sort((a,b)=>a.id-b.id);
  const safeMetadata=canonical(operations);
  if (source.api_keys.some(r=>safeMetadata.includes(r.key_hash)||safeMetadata.includes(r.key_prefix))) throw new Error();
  const tag=hmac(hmacKey,'forgeproof:0b:api-keys:v1:'+binding.custodyScope+':'+report.sourceCommitment);
  const refs=new Set();
  for (const op of operations) {
   const row=source.api_keys.find(r=>r.id===op.id);
   const ref=await custodian.stage(binding.custodyScope,'migration-api-'+tag+'-'+row.id,
    {kind:'api-key',verifier:row.key_hash,prefix:row.key_prefix});
   if (typeof ref!=='string' || !refPattern.test(ref) || refs.has(ref) ||
       !await custodian.matches(binding.custodyScope,ref,row.key_hash)) throw new Error();
   refs.add(ref);op.record.credentialRef=ref;validateRecord('apiKeys',op.record);
  }
  const transactions=operations.length?[{idempotencyKey:'mkeys_'+tag,operations}]:[];
  if (transactions.some(tx=>Buffer.byteLength(canonical(tx))>MAX_EVENT_BYTES-1024)) throw new Error();
  const privateStage={version:1,scope:{...scope},sourceCommitment:report.sourceCommitment,transactions};
  // Refuse even accidental material echoed through a safe metadata field.
  const serialized=canonical(privateStage);
  if (source.api_keys.some(r=>serialized.includes(r.key_hash)||serialized.includes(r.key_prefix))) throw new Error();
  return {privateStage,summary:{apiKeyCount:operations.length,sourceCommitment:report.sourceCommitment,
   stageDigest:'hmac-sha256:'+hmac(hmacKey,canonical(privateStage)),
   mustPersistExactStageBeforeAnyAppend:true,productionGoAllowed:false,fullApplicationMigrationComplete:false}};
 } catch {throw new Error(ERROR);}
}
