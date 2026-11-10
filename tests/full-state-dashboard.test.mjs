import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {TABLE_ORDER,TABLE_COLUMNS} from '../server/git-store/full-state-inventory.mjs';
import {captureSealedFullState,openSealedFullState} from '../server/git-store/full-state-sealed.mjs';

test('13-table sealed archive retains dashboard natural keys and authenticates every table',async()=>{
  const tables=[...TABLE_ORDER,'service_dashboard_principals','service_dashboard_bindings','service_dashboard_grants'];
  const rows=Object.fromEntries(tables.map(t=>[t,[]]));
  rows.service_dashboard_principals=[{issuer_id:'synthetic-service',tenant_key:'user:fixture'},
    {issuer_id:'synthetic-other',tenant_key:'user:other'}];
  const manifest={version:1,sourceDbFingerprint:'synthetic-only',
    tables:Object.fromEntries(tables.map(t=>[t,{expectedRowCount:rows[t].length,reviewedSchemaColumns:TABLE_COLUMNS[t]}]))};
  const client={query:async sql=>{
    const match=sql.match(/^SELECT \* FROM "([a-z_]+)" ORDER BY "(id|sid|issuer_id)"$/);
    return {rows:match?rows[match[1]]:[]};
  }};
  const scope={tenantId:'fixture',repositoryId:'archive'},key=randomBytes(32),hmac=randomBytes(32);
  const archive=await captureSealedFullState(client,manifest,scope,key,hmac);
  assert.equal(archive.tableRecords.length,13);
  const restored=openSealedFullState(archive,scope,key,hmac,manifest);
  assert.deepEqual(restored.service_dashboard_principals,rows.service_dashboard_principals.slice().reverse());
  const changed=structuredClone(archive);
  changed.tableRecords[12].ciphertextBase64=changed.tableRecords[11].ciphertextBase64;
  assert.throws(()=>openSealedFullState(changed,scope,key,hmac,manifest));
  assert.throws(()=>openSealedFullState(archive,scope,randomBytes(32),hmac,manifest));
});
