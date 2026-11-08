import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspectCompleteApplicationSource } from '../server/git-store/full-state-inventory.mjs';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const local = "SET LOCAL statement_timeout='30s'";
const commit = 'COMMIT';

const tableOrder = [
  'users',
  'sessions',
  'repositories',
  'attestation_receipts',
  'api_keys',
  'organizations',
  'org_members',
  'subscriptions',
  'pending_emails',
  'audit_logs',
];

function manifestFromFixture(fx) {
  const tables = {};
  for (const t of tableOrder) {
    tables[t] = {
      expectedRowCount: fx[t].length,
      reviewedSchemaColumns: Object.keys(fx[t][0] ?? {}).sort((a, b) => 0),
    };
  }
  return { version: 1, sourceDbFingerprint: 'source-db-fingerprint-v1', tables };
}

function fixture() {
  const date = new Date('2026-11-08T00:00:00.000Z');
  return {
    users: [
      {
        id: 'user_1', email: 'u1@example.com', first_name: 'U', last_name: 'One', profile_image_url: null,
        github_token: 'SECRET_GITHUB_TOKEN_SENTINEL',
        github_username:'fixture',notification_email:'notify@example.invalid',
        notify_on_git_failure:true,stripe_customer_id:null,default_repo_id:null,
        detail_repo_id:null,last_active_tab:null,
        created_at: date, updated_at: date,
      },
    ],
    sessions: [
      { sid: 'sess_1', sess: { token: 'SECRET_SESSION_SENTINEL' }, expire: date },
    ],
    repositories: [
      {
        id: 1, user_id: 'user_1', org_id: null, github_id: 101, name: 'repo', full_name: 'u1/repo', url: 'https://x',
        default_branch: 'main', description: null, last_synced_at: null, created_at: date,
      },
    ],
    attestation_receipts: [
      {
        id: 1, user_id: 'user_1', org_id: null, repository_id: 1, file_hash: 'sha256:abc', file_name: 'a.ts',
        file_path: 'src/a.ts', model_name: 'gpt', model_provider: 'OpenAI', country_of_origin: 'US',
        detected_country: null, compliance_status: 'ok', attestation_type: 'origin', parent_attestation_id: null,
        audit_verdict: null, audit_details: null, signature: 'ed25519:abc', public_key: 'pk', prev_entry_hash: null,
        entry_hash: 'sha256:def', receipt_version: 'v1', signed_at: null, git_commit_url: null,
        git_commit_message: null, metadata: { k: 'v' }, created_at: date,
      },
    ],
    api_keys: [
      {
        id: 1, user_id: 'user_1', name: 'key', key_hash: 'SECRET_KEY_HASH_SENTINEL', key_prefix: 'SECRET_PREFIX',
        permissions: ['attest:read'], is_active: true, last_used_at: null, expires_at: null, created_at: date,
      },
    ],
    organizations: [{ id: 1, name: 'Org', slug: 'org', owner_id: 'user_1', description: null, created_at: date }],
    org_members: [{ id: 1, org_id: 1, user_id: 'user_1', role: 'owner', created_at: date }],
    subscriptions: [
      {
        id: 1, user_id: 'user_1', org_id: null, stripe_customer_id: null, stripe_subscription_id: null,
        plan: 'free', status: 'active', current_period_start: null, current_period_end: null,
        attestation_limit: 100, attestation_count: 1, api_key_limit: 1, created_at: date,
      },
    ],
    pending_emails: [
      {
        id: 1, to: 'SECRET_EMAIL_SENTINEL@example.com', subject: 's', body_html: 'SECRET_BODY_HTML_SENTINEL',
        body_text: 'SECRET_BODY_TEXT_SENTINEL', retry_count: 0, next_retry_at: date, status: 'pending', created_at: date,
      },
    ],
    audit_logs: [
      {
        id: 1, user_id: 'user_1', action: 'a', resource_type: 'r', resource_id: '1', metadata: { m: 1 },
        ip_address: '127.0.0.1', created_at: date,
      },
    ],
  };
}

function fakeClient(fx, options = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (options.failSql && options.failSql === sql) {
        throw new Error('driver leak SECRET_DATABASE_URL_SENTINEL');
      }
      const match=/^SELECT \* FROM "([a-z_]+)" ORDER BY "(id|sid)"$/.exec(sql);
      if (match) {
        const [,table,idCol]=match;
        if (!tableOrder.includes(table) || idCol!==(table==='sessions'?'sid':'id'))
          throw Error('Unknown synthetic SQL table');
        return {rows:fx[table],rowCount:fx[table].length};
      }
      return { rows: [] };
    },
  };
}

test('success: deterministic inventory, order, counts, and no secret plaintext leakage', async () => {
  const fx = fixture();
  const manifest = manifestFromFixture(fx);
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  const c1 = fakeClient(fx);
  const r1 = await inspectCompleteApplicationSource(c1, manifest, k1);
  const c2 = fakeClient(fx);
  const r2 = await inspectCompleteApplicationSource(c2, manifest, k1);
  const c3 = fakeClient(fx);
  const r3 = await inspectCompleteApplicationSource(c3, manifest, k2);

  assert.equal(r1.sourceTotals.sourceHmacDigest, r2.sourceTotals.sourceHmacDigest);
  assert.notEqual(r1.sourceTotals.sourceHmacDigest, r3.sourceTotals.sourceHmacDigest);

  const selects = c1.calls.filter((x) => x.startsWith('SELECT * FROM '));
  assert.equal(selects.length, 10);
  assert.deepEqual(selects, tableOrder.map((t) =>
    `SELECT * FROM "${t}" ORDER BY "${t==='sessions'?'sid':'id'}"`));
  assert.deepEqual(c1.calls, [begin, local, ...selects, commit]);

  assert.equal(r1.sourceTotals.tableCount, 10);
  assert.equal(r1.sourceTotals.rowCount, 10);
  assert.equal(r1.tables.users.observedRowCount, 1);
  assert.equal(r1.secretCustodyRequirement.sensitiveNonNullCounts.users_github_token, 1);
  assert.equal(r1.secretCustodyRequirement.sensitiveNonNullCounts.api_keys_key_hash, 1);
  assert.equal(r1.secretCustodyRequirement.sensitiveNonNullCounts.sessions_sess, 1);
  assert.equal(r1.secretCustodyRequirement.sensitiveNonNullCounts.pending_emails_to, 1);
  assert.equal(r1.stripeCoverage.productionGoAllowed, false);

  const serialized = JSON.stringify(r1);
  assert.doesNotMatch(serialized, /SECRET_/);
  assert.doesNotMatch(serialized, /user_1/);
  assert.doesNotMatch(serialized, /example.com/);
});

test('mismatched reviewed counts fail closed and rollback', async () => {
  const fx = fixture();
  const manifest = manifestFromFixture(fx);
  manifest.tables.users.expectedRowCount = 999;
  const c = fakeClient(fx);
  await assert.rejects(inspectCompleteApplicationSource(c, manifest, randomBytes(32)), /Application state inventory failed/);
  assert.equal(c.calls.at(-1), 'ROLLBACK');
});

test('missing or extra columns are rejected and rollback', async () => {
  const fx1 = fixture();
  delete fx1.repositories[0].url;
  const m1 = manifestFromFixture(fixture());
  const c1 = fakeClient(fx1);
  await assert.rejects(inspectCompleteApplicationSource(c1, m1, randomBytes(32)), /Application state inventory failed/);
  assert.equal(c1.calls.at(-1), 'ROLLBACK');

  const fx2 = fixture();
  fx2.repositories[0].unexpected = 'x';
  const m2 = manifestFromFixture(fixture());
  const c2 = fakeClient(fx2);
  await assert.rejects(inspectCompleteApplicationSource(c2, m2, randomBytes(32)), /Application state inventory failed/);
  assert.equal(c2.calls.at(-1), 'ROLLBACK');
});

test('duplicate IDs fail closed and rollback', async () => {
  const fx = fixture();
  fx.organizations.push({ ...fx.organizations[0] });
  const manifest = manifestFromFixture(fx);
  const c = fakeClient(fx);
  await assert.rejects(inspectCompleteApplicationSource(c, manifest, randomBytes(32)), /Application state inventory failed/);
  assert.equal(c.calls.at(-1), 'ROLLBACK');
});

test('query failure is generic and does not leak driver details', async () => {
  const fx = fixture();
  const manifest = manifestFromFixture(fx);
  const failingSql = 'SELECT * FROM "subscriptions" ORDER BY "id"';
  const c = fakeClient(fx, { failSql: failingSql });
  await assert.rejects(
    inspectCompleteApplicationSource(c, manifest, randomBytes(32)),
    (err) => {
      assert.equal(err.message, 'Application state inventory failed');
      assert.doesNotMatch(err.message, /SECRET_DATABASE_URL_SENTINEL/);
      return true;
    },
  );
  assert.equal(c.calls.at(-1), 'ROLLBACK');
});

test('manifest strict validation and malformed rows fail closed', async () => {
  const fx = fixture();
  const manifest = manifestFromFixture(fx);

  const badManifest = { ...manifest, tables: { ...manifest.tables, extra_table: { expectedRowCount: 0 } } };
  const c1 = fakeClient(fx);
  await assert.rejects(inspectCompleteApplicationSource(c1, badManifest, randomBytes(32)), /Application state inventory failed/);
  assert.equal(c1.calls.length, 0);

  const malformed = fixture();
  malformed.users = [null];
  const c2 = fakeClient(malformed);
  await assert.rejects(inspectCompleteApplicationSource(c2, manifest, randomBytes(32)), /Application state inventory failed/);
  assert.equal(c2.calls.at(-1), 'ROLLBACK');
});


test('complete Replit user columns, strict undefined and NaN values fail closed',async()=>{
  const baseline=fixture();
  const source=manifestFromFixture(baseline);
  const wrong=fixture();
  delete wrong.users[0].github_username;
  const client=fakeClient(wrong);
  await assert.rejects(inspectCompleteApplicationSource(client,source,randomBytes(32)),/Application state inventory failed/);
  assert.equal(client.calls.at(-1),'ROLLBACK');

  const undefinedFixture=fixture();
  undefinedFixture.users[0].github_username=undefined;
  const undefinedClient=fakeClient(undefinedFixture);
  await assert.rejects(inspectCompleteApplicationSource(undefinedClient,source,randomBytes(32)),/Application state inventory failed/);
  assert.equal(undefinedClient.calls.at(-1),'ROLLBACK');

  const invalidNumber=fixture();
  invalidNumber.repositories[0].github_id=Number.NaN;
  const numberClient=fakeClient(invalidNumber);
  await assert.rejects(inspectCompleteApplicationSource(numberClient,source,randomBytes(32)),/Application state inventory failed/);
  assert.equal(numberClient.calls.at(-1),'ROLLBACK');
});
test('source commitment does not expose reviewed fingerprint, row ordering or secrets',async()=>{
 const fixtureA=fixture();
 const fixtureB=fixture();
 fixtureB.organizations.push({...fixtureB.organizations[0],id:2,slug:'other'});
 fixtureA.organizations.push({...fixtureA.organizations[0],id:2,slug:'other'});
 fixtureB.organizations.reverse();
 const manifest=manifestFromFixture(fixtureA);
 manifest.sourceDbFingerprint='SECRET_PRIVATE_HOSTNAME_PROD_DB_FINGERPRINT';
 const key=randomBytes(32);
 const a=await inspectCompleteApplicationSource(fakeClient(fixtureA),manifest,key);
 const b=await inspectCompleteApplicationSource(fakeClient(fixtureB),manifest,key);
 assert.equal(a.sourceTotals.sourceHmacDigest,b.sourceTotals.sourceHmacDigest);
 const text=JSON.stringify(a);
 assert.doesNotMatch(text,/SECRET_|PRIVATE_HOSTNAME|user_1/);
 assert.match(a.reviewedSourceFingerprintHmac,/^[a-f0-9]{64}$/);
});
test('BEGIN failure is generic and never leaks connection message',async()=>{
 const reviewed=manifestFromFixture(fixture());
 const client={calls:[],async query(sql){this.calls.push(sql);throw Error('SECRET_CONNECTION_STRING_CONTENT');}};
 await assert.rejects(inspectCompleteApplicationSource(client,reviewed,randomBytes(32)),err=>{
  assert.equal(err.message,'Application state inventory failed');
  return true;
 });
 assert.deepEqual(client.calls,[begin]);
});
test('reviewed manifest rejects unknown fields before any SQL access',async()=>{
 const manifest=manifestFromFixture(fixture());
 manifest.inventedApproval=true;
 const client=fakeClient(fixture());
 await assert.rejects(inspectCompleteApplicationSource(client,manifest,randomBytes(32)),/Application state inventory failed/);
 assert.deepEqual(client.calls,[]);
});
