// The complete interleaved legacy chain stays in one restrictive private archive.
// The tenant mapping digest is pinned OUTSIDE that archive after export review.
import { canonical, exact, hash, identifier, positive } from './schema.mjs';
export function validateMemberships(manifest, pinnedDigest, records) {
  exact(manifest,['version','memberships','total']);
  if (manifest.version !== 1 || hash(canonical(manifest)) !== pinnedDigest || !Array.isArray(manifest.memberships) || manifest.total !== manifest.memberships.length) throw new Error('Invalid pinned archive manifest');
  const ids=new Set();
  for (const member of manifest.memberships) {
    exact(member,['id','tenant','userId']); positive(member.id); identifier(member.tenant); identifier(member.userId);
    if (ids.has(member.id)) throw new Error('Duplicate archive membership');
    ids.add(member.id);
    const row=records[member.id];
    if (!row || JSON.parse(row.original).userId !== member.userId) throw new Error('Archive membership mismatch');
  }
  if (Object.keys(records).length!==manifest.total) throw new Error('Archive totals mismatch');
}
/** Only return this filtered view to a caller already authorized for tenant.
 * Never expose service/repository, global replay output or raw manifest over HTTP. */
export async function readTenantArchive(service, manifest, pinnedDigest, authorizedTenant) {
  identifier(authorizedTenant);
  const state=await service.replay(); // Verifies every original signature AND global predecessor.
  validateMemberships(manifest,pinnedDigest,state.records.receipts);
  return manifest.memberships.filter(m=>m.tenant===authorizedTenant).map(m=>structuredClone(state.records.receipts[m.id]));
}
export async function migrateArchive(service, reviewed, pinnedDigest) {
  exact(reviewed,['version','manifest','receipts']);
  if(reviewed.version!==1 || !Array.isArray(reviewed.receipts)) throw new Error('Unsupported archive export');
  const records=Object.create(null);
  for (const r of reviewed.receipts) {
    exact(r,['id','original']);
    if(records[r.id]) throw new Error('Duplicate original ID');
    records[r.id]=r;
  }
  validateMemberships(reviewed.manifest,pinnedDigest,records);
  // Order is original chain order, never tenant order. Preflight complete input.
  const state=await service.replay();
  if(Object.keys(state.records).some(k=>k!=='receipts'&&Object.keys(state.records[k]).length)) throw new Error('Dedicated restrictive receipt archive required');
  const transactions=reviewed.receipts.map(r=>({idempotencyKey:'archive-'+hash(canonical(r)),operations:[{kind:'receipts',id:r.id,action:'put',expectedVersion:null,record:r}]}));
  let sequence=state.checkpoint?.sequence ?? 0;
  for(const tx of transactions) {
    const old=state.records.receipts[tx.operations[0].id];
    if(old) {if(canonical(old)!==canonical(tx.operations[0].record)) throw new Error('Archive retry mismatch');continue;}
    service.apply(state,tx.operations,++sequence);
  }
  validateMemberships(reviewed.manifest,pinnedDigest,state.records.receipts);
  for(const tx of transactions) await service.append(tx);
  return (await service.replay()).checkpoint;
}
