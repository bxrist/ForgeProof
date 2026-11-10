#!/usr/bin/env node
// Explicit, read-only extraction. No application initialization or default migration.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { canonical, classes, validateRecord, hash, exact } from './schema.mjs';
const tables={users:'users',repositories:'repositories',organizations:'organizations',orgMembers:'org_members',receipts:'attestation_receipts',apiKeys:'api_keys',subscriptions:'subscriptions',auditLogs:'audit_logs',sessions:'sessions',serviceDashboardPrincipals:'service_dashboard_principals',serviceDashboardBindings:'service_dashboard_bindings',serviceDashboardGrants:'service_dashboard_grants'};
const camel=k=>k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
export function validateSnapshotRows(input) {
  if(Object.keys(input).length!==classes.length || classes.some(k=>!Array.isArray(input[k]))) throw new Error('Missing snapshot table');
  const records={}, totals={};
  for(const kind of classes) {
    const ids=new Set();
    records[kind]=input[kind].map(raw=> {
      const row=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(raw).map(([k,v])=>[camel(k),v]))));
      // Envelope identity is the existing natural primary key, not a new user ID.
      if(kind==='serviceDashboardPrincipals' && row.id===undefined) row.id=row.issuerId;
      if(kind==='sessions') throw new Error('Sessions require reviewed custody export; no rows dropped');
      for(const field of ['githubToken','keyHash','keyPrefix','metadata','auditDetails']) {
        if(kind==='receipts' && ['metadata','auditDetails'].includes(field)) continue;
        if(field in row) { if(row[field]!=null) throw new Error('Sensitive content requires reviewed custody export'); delete row[field]; }
      }
      const record=kind==='receipts'?{id:row.id,original:JSON.stringify(row)}:row;
      validateRecord(kind,record);
      if(ids.has(record.id)) throw new Error('Duplicate snapshot ID'); ids.add(record.id);
      return record;
    }).sort((a,b)=>typeof a.id==='number'?a.id-b.id:String(a.id).localeCompare(String(b.id),'en'));
    totals[kind]=records[kind].length;
  }
  return {version:1,totals,records};
}
export function reviewedSnapshotTransactions(input) {
  exact(input,['version','totals','records']);
  if(input.version!==1) throw new Error('Unsupported reviewed snapshot');
  exact(input.totals,classes); exact(input.records,classes);
  for(const kind of classes) {
    if(!Array.isArray(input.records[kind]) || input.totals[kind]!==input.records[kind].length) throw new Error('Snapshot totals mismatch');
    const ids=new Set();
    for(const record of input.records[kind]) {
      validateRecord(kind,record);
      if(ids.has(record.id)) throw new Error('Duplicate snapshot ID'); ids.add(record.id);
    }
  }
  // Regenerate/validate the full extraction contract, including secret exclusions.
  const raw={};
  for(const kind of classes) raw[kind]=input.records[kind].map(r=>kind==='receipts'?JSON.parse(r.original):r);
  validateSnapshotRows(raw);
  const transactions=[];
  for(const kind of classes) for(const record of input.records[kind]) transactions.push({idempotencyKey:'snapshot-'+hash(canonical({kind,record})),operations:[{kind,id:record.id,action:'put',expectedVersion:null,record}]});
  return {version:1,transactions};
}
export async function snapshot(output, authorized) {
  if(authorized!=='--authorized-isolated-read-only' || process.env.NODE_ENV==='production' || !process.env.DATABASE_URL) throw new Error('Explicit authorized isolated DATABASE_URL snapshot required');
  const {default:pg}=await import('pg');
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  let result;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    const rows={};
    for(const [kind,table] of Object.entries(tables)) rows[kind]=(await client.query(`SELECT * FROM "${table}" ORDER BY ${kind==='sessions'?'sid':kind==='serviceDashboardPrincipals'?'issuer_id':'id'}`)).rows;
    result=validateSnapshotRows(rows);
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally {await client.end();}
  const bytes=canonical(result)+'\n';
  await writeFile(output,bytes,{flag:'wx',mode:0o600});
  return {digest:hash(bytes),totals:result.totals};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) snapshot(process.argv[2],process.argv[3]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
