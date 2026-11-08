import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TABLE_ORDER, TABLE_COLUMNS, normalizeRowStrict } from '../server/git-store/full-state-inventory.mjs';
import { captureSealedFullState, openSealedFullState } from '../server/git-store/full-state-sealed.mjs';

const BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const LOCAL_TIMEOUT_SQL = "SET LOCAL statement_timeout='30s'";
const COMMIT_SQL = 'COMMIT';
const ROLLBACK_SQL = 'ROLLBACK';

function scope() {
  return { tenantId: 'tenant_alpha', repositoryId: 'repo_main' };
}

function fixture() {
  return {
    users: [{ id: 'user_1', email: 'EMAIL_RECIPIENT@secret.example', first_name: 'Ada', last_name: 'Lovelace', profile_image_url: 'https://img.example/x', github_token: 'SENTINEL_TOKEN', github_username: 'ada', notification_email: 'notify@example.com', notify_on_git_failure: true, stripe_customer_id: 'cus_1', default_repo_id: 10, detail_repo_id: 10, last_active_tab: 'dashboard', created_at: new Date('2025-01-01T00:00:00.000Z'), updated_at: new Date('2025-01-02T00:00:00.000Z') }],
    sessions: [{ sid: 'SESSION_SECRET', sess: { body: 'SESSION' }, expire: new Date('2025-01-03T00:00:00.000Z') }],
    repositories: [{ id: 10, user_id: 'user_1', org_id: 77, github_id: 1001, name: 'repo', full_name: 'o/repo', url: 'https://github.com/o/repo', default_branch: 'main', description: 'd', last_synced_at: new Date('2025-01-04T00:00:00.000Z'), created_at: new Date('2025-01-05T00:00:00.000Z') }],
    attestation_receipts: [{ id: 20, user_id: 'user_1', org_id: 77, repository_id: 10, file_hash: 'sha256:abc', file_name: 'x.ts', file_path: 'src/x.ts', model_name: 'm', model_provider: 'p', country_of_origin: 'US', detected_country: 'US', compliance_status: 'ok', attestation_type: 'origin', parent_attestation_id: null, audit_verdict: 'pass', audit_details: { nested: 'json' }, signature: 'sig', public_key: 'pk', prev_entry_hash: null, entry_hash: 'eh', receipt_version: 'v1', signed_at: new Date('2025-01-06T00:00:00.000Z'), git_commit_url: 'https://git/c', git_commit_message: 'm', metadata: { RECEIPT_PRIVATE_METADATA: 'secret' }, created_at: new Date('2025-01-07T00:00:00.000Z') }],
    api_keys: [{ id: 30, user_id: 'user_1', name: 'k', key_hash: 'API_KEY_VERIFIER', key_prefix: 'fp_sk_', permissions: ['read'], is_active: true, last_used_at: null, expires_at: null, created_at: new Date('2025-01-08T00:00:00.000Z') }],
    organizations: [{ id: 77, name: 'org', slug: 'org', owner_id: 'user_1', description: 'desc', created_at: new Date('2025-01-09T00:00:00.000Z') }],
    org_members: [{ id: 88, org_id: 77, user_id: 'user_1', role: 'owner', created_at: new Date('2025-01-10T00:00:00.000Z') }],
    subscriptions: [{ id: 90, user_id: 'user_1', org_id: 77, stripe_customer_id: 'cus', stripe_subscription_id: 'sub', plan: 'pro', status: 'active', current_period_start: new Date('2025-01-11T00:00:00.000Z'), current_period_end: new Date('2025-02-11T00:00:00.000Z'), attestation_limit: 100, attestation_count: 1, api_key_limit: 3, created_at: new Date('2025-01-12T00:00:00.000Z') }],
    pending_emails: [{ id: 99, to: 'EMAIL_RECIPIENT@example.com', subject: 's', body_html: '<p>EMAIL_BODY</p>', body_text: 'EMAIL_BODY', retry_count: 0, next_retry_at: null, status: 'queued', created_at: new Date('2025-01-13T00:00:00.000Z') }],
    audit_logs: [{ id: 111, user_id: 'user_1', action: 'create', resource_type: 'repo', resource_id: '10', metadata: { AUDIT_METADATA: 'sensitive' }, ip_address: '127.0.0.1', created_at: new Date('2025-01-14T00:00:00.000Z') }],
  };
}

function manifestFromFixture(data) {
  return {
    version: 1,
    sourceDbFingerprint: 'reviewed-db-fingerprint',
    tables: Object.fromEntries(TABLE_ORDER.map((table) => [table, { expectedRowCount: data[table].length, reviewedSchemaColumns: undefined }])),
  };
}

function fakeClient(data, opts = {}) {
  return {
    calls: [],
    async query(sql) {
      this.calls.push(sql);
      if (opts.failSql && sql === opts.failSql) throw new Error('DB_URL=SECRET_DATABASE_URL_SENTINEL');
      if (sql === BEGIN_SQL || sql === LOCAL_TIMEOUT_SQL || sql === COMMIT_SQL || sql === ROLLBACK_SQL) return { rows: [] };
      const match = sql.match(/^SELECT \* FROM "([a-z_]+)" ORDER BY "(id|sid)"$/);
      if (!match) throw new Error('bad sql');
      const table = match[1];
      return { rows: data[table] ?? [] };
    },
  };
}

test('capture/open reconstruct exact normalized data and counts', async () => {
  const data = fixture();
  const manifest = manifestFromFixture(data);
  const client = fakeClient(data);
  const key=randomBytes(32), mac=randomBytes(32);
  const envelope = await captureSealedFullState(client, manifest, scope(), key, mac);
  assert.equal(client.calls[0], BEGIN_SQL);
  assert.equal(client.calls[1], LOCAL_TIMEOUT_SQL);
  assert.equal(client.calls.at(-1), COMMIT_SQL);
  assert.equal(envelope.productionGoAllowed, false);
  assert.equal(envelope.tableRecords.length, 10);

  const opened = openSealedFullState(envelope, scope(), key, mac, manifest);
  assert.equal(Object.keys(opened).length, 10);
  for (const table of TABLE_ORDER) {
    const rows=data[table].map(r=>normalizeRowStrict(table,r,TABLE_COLUMNS[table]));
    assert.deepEqual(opened[table],rows,table);
  }
});

test('envelope never includes sentinel plaintext secrets', async () => {
  const data = fixture();
  const manifest = manifestFromFixture(data);
  const envelope = await captureSealedFullState(fakeClient(data), manifest, scope(), randomBytes(32), randomBytes(32));
  const text = JSON.stringify(envelope);
  assert.doesNotMatch(text, /SENTINEL_TOKEN|SESSION_SECRET|API_KEY_VERIFIER|EMAIL_RECIPIENT|EMAIL_BODY|RECEIPT_PRIVATE_METADATA|AUDIT_METADATA/);
});

test('randomized ciphertext and deterministic HMAC with fixed nonce source', async () => {
  const data = fixture();
  const manifest = manifestFromFixture(data);
  const key = randomBytes(32);
  const mac = randomBytes(32);
  const env1 = await captureSealedFullState(fakeClient(data), manifest, scope(), key, mac);
  const env2 = await captureSealedFullState(fakeClient(data), manifest, scope(), key, mac);
  assert.notEqual(env1.tableRecords[0].ciphertextBase64, env2.tableRecords[0].ciphertextBase64);
  assert.equal(env1.tableRecords[0].tableCommitmentHmac, env2.tableRecords[0].tableCommitmentHmac);
  assert.equal(env1.wholeStateCommitment, env2.wholeStateCommitment);
});

test('wrong keys fail closed', async () => {
  const data = fixture();
  const manifest = manifestFromFixture(data);
  const key = randomBytes(32);
  const mac = randomBytes(32);
  const envelope = await captureSealedFullState(fakeClient(data), manifest, scope(), key, mac);
  assert.throws(() => openSealedFullState(envelope, scope(), randomBytes(32), mac, manifest), /Protected full state capture failed/);
  assert.throws(() => openSealedFullState(envelope, scope(), key, randomBytes(32), manifest), /Protected full state capture failed/);
});

test('wrong tenant or repository fails closed', async () => {
  const data = fixture();
  const manifest = manifestFromFixture(data);
  const key = randomBytes(32);
  const mac = randomBytes(32);
  const envelope = await captureSealedFullState(fakeClient(data), manifest, scope(), key, mac);
  assert.throws(() => openSealedFullState(envelope, { tenantId: 'other', repositoryId: 'repo_main' }, key, mac, manifest), /Protected full state capture failed/);
  assert.throws(() => openSealedFullState(envelope, { tenantId: 'tenant_alpha', repositoryId: 'other_repo' }, key, mac, manifest), /Protected full state capture failed/);
});

test('tamper and swap ciphertext fail closed', async () => {
  const data = fixture();
  const manifest = manifestFromFixture(data);
  const key = randomBytes(32);
  const mac = randomBytes(32);
  const envelope = await captureSealedFullState(fakeClient(data), manifest, scope(), key, mac);

  const tampered = structuredClone(envelope);
  tampered.tableRecords[0].ciphertextBase64 = tampered.tableRecords[0].ciphertextBase64.slice(0, -2) + 'AA';
  assert.throws(() => openSealedFullState(tampered, scope(), key, mac, manifest), /Protected full state capture failed/);

  const swapped = structuredClone(envelope);
  const tmp = swapped.tableRecords[0].ciphertextBase64;
  swapped.tableRecords[0].ciphertextBase64 = swapped.tableRecords[1].ciphertextBase64;
  swapped.tableRecords[1].ciphertextBase64 = tmp;
  assert.throws(() => openSealedFullState(swapped, scope(), key, mac, manifest), /Protected full state capture failed/);
});

test('missing table, wrong count, wrong columns fail closed', async () => {
  const data = fixture();
  const manifest = manifestFromFixture(data);
  const key = randomBytes(32);
  const mac = randomBytes(32);
  const envelope = await captureSealedFullState(fakeClient(data), manifest, scope(), key, mac);

  const missing = structuredClone(envelope);
  missing.tableRecords.pop();
  assert.throws(() => openSealedFullState(missing, scope(), key, mac, manifest), /Protected full state capture failed/);

  const wrongCount = structuredClone(envelope);
  wrongCount.tableRecords[0].rowCount += 1;
  assert.throws(() => openSealedFullState(wrongCount, scope(), key, mac, manifest), /Protected full state capture failed/);

  const wrongCols = structuredClone(envelope);
  wrongCols.tableRecords[0].columns = ['id'];
  assert.throws(() => openSealedFullState(wrongCols, scope(), key, mac, manifest), /Protected full state capture failed/);
});

test('duplicate IDs, undefined, NaN fail closed during capture', async () => {
  const d1 = fixture();
  d1.users.push({ ...d1.users[0] });
  await assert.rejects(captureSealedFullState(fakeClient(d1), manifestFromFixture(fixture()), scope(), randomBytes(32), randomBytes(32)), /Protected full state capture failed/);

  const d2 = fixture();
  d2.users[0].github_username = undefined;
  await assert.rejects(captureSealedFullState(fakeClient(d2), manifestFromFixture(fixture()), scope(), randomBytes(32), randomBytes(32)), /Protected full state capture failed/);

  const d3 = fixture();
  d3.repositories[0].github_id = Number.NaN;
  await assert.rejects(captureSealedFullState(fakeClient(d3), manifestFromFixture(fixture()), scope(), randomBytes(32), randomBytes(32)), /Protected full state capture failed/);
});

test('query failure rolls back with generic non-leaking error', async () => {
  const data = fixture();
  const manifest = manifestFromFixture(data);
  const failSql = 'SELECT * FROM "subscriptions" ORDER BY "id"';
  const client = fakeClient(data, { failSql });
  await assert.rejects(captureSealedFullState(client, manifest, scope(), randomBytes(32), randomBytes(32)), (err) => {
    assert.equal(err.message, 'Protected full state capture failed');
    assert.doesNotMatch(err.message, /SECRET_DATABASE_URL_SENTINEL/);
    return true;
  });
  assert.equal(client.calls.at(-1), ROLLBACK_SQL);
});

test('empty table still encrypted and open succeeds', async () => {
  const data = fixture();
  data.pending_emails = [];
  const manifest = manifestFromFixture(data);
  const key = randomBytes(32);
  const mac = randomBytes(32);
  const envelope = await captureSealedFullState(fakeClient(data), manifest, scope(), key, mac);
  const rec = envelope.tableRecords.find((r) => r.table === 'pending_emails');
  assert.ok(rec);
  assert.equal(rec.rowCount, 0);
  assert.notEqual(rec.ciphertextBase64, '');
  const opened = openSealedFullState(envelope, scope(), key, mac, manifest);
  assert.deepEqual(opened.pending_emails, []);
});


test('stable source commitments ignore source row iteration order but ciphertext rotates', async () => {
  const data=fixture();
  data.users.push({...data.users[0],id:'user_2',email:'other@example.invalid',github_token:null});
  const reversed=structuredClone(data);
  reversed.users.reverse();
  const manifest=manifestFromFixture(data);
  const enc=randomBytes(32),mac=randomBytes(32);
  const first=await captureSealedFullState(fakeClient(data),manifest,scope(),enc,mac);
  const second=await captureSealedFullState(fakeClient(reversed),manifest,scope(),enc,mac);
  assert.equal(first.wholeStateCommitment,second.wholeStateCommitment);
  assert.equal(first.tableRecords[0].tableCommitmentHmac,second.tableRecords[0].tableCommitmentHmac);
  assert.notEqual(first.tableRecords[0].ciphertextBase64,second.tableRecords[0].ciphertextBase64);
  const opened=openSealedFullState(second,scope(),enc,mac,manifest);
  assert.deepEqual(opened.users.map(x=>x.id),['user_1','user_2']);
});

test('SQL rowCount disagreement fails and rolls back without leaking driver details', async () => {
  const data=fixture(),manifest=manifestFromFixture(data);
  const client=fakeClient(data);
  const query=client.query.bind(client);
  client.query=async sql=>{
    const result=await query(sql);
    return sql.includes('FROM "users"') ? {...result,rowCount:result.rows.length+2}:result;
  };
  await assert.rejects(captureSealedFullState(client,manifest,scope(),randomBytes(32),randomBytes(32)),
    err=>err.message==='Protected full state capture failed');
  assert.equal(client.calls.at(-1),ROLLBACK_SQL);
});

test('malformed envelope scopes, table arrays and base64 encodings fail generically',async()=>{
  const data=fixture(),manifest=manifestFromFixture(data),key=randomBytes(32),mac=randomBytes(32);
  const env=await captureSealedFullState(fakeClient(data),manifest,scope(),key,mac);
  const invalid=[
    null,
    {...env,scope:null},
    {...env,tableRecords:null},
    {...env,extraField:'secret'},
    {...env,scope:{tenantId:'tenant_alpha',repositoryId:'repo_main',override:'yes'}},
    {...env,tableRecords:env.tableRecords.map((r,i)=>i===0?{...r,nonceBase64:r.nonceBase64+'\\n'}:r)},
    {...env,tableRecords:env.tableRecords.map((r,i)=>i===0?{...r,ciphertextBase64:r.ciphertextBase64+'='}:r)},
    {...env,tableRecords:env.tableRecords.map((r,i)=>i===1?{...r,nonceBase64:env.tableRecords[0].nonceBase64}:r)},
  ];
  for (const value of invalid) assert.throws(
    ()=>openSealedFullState(value,scope(),key,mac,manifest),
    err=>err.message==='Protected full state capture failed');
});

test('bad reviewed manifest and identical independent keys are denied before SQL',async()=>{
 const data=fixture(),client=fakeClient(data),key=randomBytes(32);
 await assert.rejects(captureSealedFullState(client,manifestFromFixture(data),scope(),key,key),
   err=>err.message==='Protected full state capture failed');
 assert.deepEqual(client.calls,[]);
 const manifest=manifestFromFixture(data);
 manifest.tables.extra={expectedRowCount:0};
 await assert.rejects(captureSealedFullState(client,manifest,scope(),randomBytes(32),randomBytes(32)),
   err=>err.message==='Protected full state capture failed');
 assert.deepEqual(client.calls,[]);
});


test('reviewed source identity is bound by keyed HMAC in AAD without exposing raw DB fingerprint',async()=>{
  const data=fixture(),manifest=manifestFromFixture(data);
  manifest.sourceDbFingerprint='PRIVATE_DB_HOSTNAME_SOURCE_FINGERPRINT_SENTINEL';
  const key=randomBytes(32),mac=randomBytes(32);
  const envelope=await captureSealedFullState(fakeClient(data),manifest,scope(),key,mac);
  const serialized=JSON.stringify(envelope);
  assert.doesNotMatch(serialized,/PRIVATE_DB_HOSTNAME_SOURCE_FINGERPRINT_SENTINEL/);
  const changed=structuredClone(manifest);
  changed.sourceDbFingerprint='another-real-production-database';
  assert.throws(()=>openSealedFullState(envelope,scope(),key,mac,changed),
    err=>err.message==='Protected full state capture failed');
  const accepted=openSealedFullState(envelope,scope(),key,mac,manifest);
  assert.equal(accepted.users.length,1);
  assert.match(envelope.schema.sourceFingerprintCommitment,/^[a-f0-9]{64}$/);
});
