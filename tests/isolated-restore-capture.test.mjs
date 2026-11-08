import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TABLE_ORDER, TABLE_COLUMNS } from '../server/git-store/full-state-inventory.mjs';
import { openSealedFullState } from '../server/git-store/full-state-sealed.mjs';
import { captureIsolatedRestore, RESTORE_COUNTS, RESTORE_SQL, HISTORICAL_HEAD } from '../server/git-store/isolated-restore-capture.mjs';
import { saveIsolatedEnvelope } from '../server/git-store/isolated-restore-save.mjs';

function fixture() {
  const data = Object.fromEntries(TABLE_ORDER.map(t => [t, Array.from({ length: RESTORE_COUNTS[t] }, (_, i) => {
    const row = Object.fromEntries(TABLE_COLUMNS[t].map(c => [c, null]));
    if (t === 'sessions') row.sid = `session_${i}`;
    else row.id = t === 'users' ? `user_${i}` : i + 1;
    return row;
  })]));
  data.users[0].github_token = 'synthetic-sensitive-oauth';
  data.api_keys[0].key_hash = 'synthetic-sensitive-verifier';
  data.attestation_receipts.at(-1).entry_hash = HISTORICAL_HEAD;
  const manifest = { version: 1, sourceDbFingerprint: 'synthetic-only', tables: Object.fromEntries(TABLE_ORDER.map(t => [t, { expectedRowCount: RESTORE_COUNTS[t] }])) };
  const keys = { encryptionKey: Buffer.alloc(32, 7), hmacKey: Buffer.alloc(32, 9) };
  const scope = { tenantId: 'synthetic', repositoryId: 'test' };
  let commits = 0;
  const f = { data, manifest, scope, keys, change: () => {}, identity: { database: 'forgeproof_0b_restore_test', version: '170006', listeners: '', address: null, pid: 42, username: 'owner' }, schemas: [{ name: 'public' }] };
  f.client = { async query(sql) {
    if (sql === RESTORE_SQL.identity) return { rows: [f.identity] };
    if (sql === RESTORE_SQL.schemas) return { rows: f.schemas };
    if (sql === RESTORE_SQL.columns) return { rows: TABLE_ORDER.flatMap(t => TABLE_COLUMNS[t].map(c => ({ table_name: t, column_name: c }))) };
    if (sql === RESTORE_SQL.head) return { rows: [{ entry_hash: data.attestation_receipts.at(-1).entry_hash }] };
    if (sql === 'COMMIT') { if (++commits === 1) f.change(); }
    const match = sql.match(/^SELECT \* FROM "([a-z_]+)"/);
    return { rows: match ? structuredClone(data[match[1]]) : [] };
  } };
  f.trustedPreflight = async () => ({ authenticated: true, transport: 'unix', peerIdentityVerified: true, noTcpListeners: true, backendPid: 42, databaseUser: 'owner' });
  f.privateKeySource = async () => keys;
  return f;
}
const capture = f => captureIsolatedRestore(f);

test('complete current 62-row inventory, private output and deterministic commitments', async () => {
  const f = fixture(), a = await capture(f), b = await capture(f);
  assert.equal(Object.values(a.counts).reduce((x, y) => x + y), 62);
  assert.equal(a.counts.organizations, 1); assert.equal(a.counts.org_members, 1); assert.equal(a.counts.audit_logs, 15);
  assert.equal(a.wholeStateCommitment, b.wholeStateCommitment);
  assert.notDeepEqual(a.envelope.tableRecords, b.envelope.tableRecords);
  assert.equal(a.productionGoAllowed, false);
  assert.doesNotMatch(JSON.stringify(a), /synthetic-sensitive/);
  assert.equal(f.keys.encryptionKey[0], 7);
});

for (const [name, mutate] of Object.entries({
  'old counts': f => { f.manifest.tables.organizations.expectedRowCount = 0; },
  'count drift': f => { f.change = () => f.data.audit_logs.pop(); },
  'same count mutation': f => { f.change = () => { f.data.users[0].email = 'changed'; }; },
  'historical head': f => { f.data.attestation_receipts.at(-1).entry_hash = 'wrong'; },
  'database': f => { f.identity.database = 'production'; },
  'backend identity': f => { f.identity.pid = 0; },
  'TCP connection': f => { f.identity.address = '127.0.0.1'; },
  'missing column': f => { delete f.data.organizations[0].slug; },
  'version': f => { f.identity.version = '160001'; },
  'TCP listener': f => { f.identity.listeners = 'localhost'; },
  'schema': f => { f.schemas.push({ name: 'unexpected' }); },
  'peer': f => { f.trustedPreflight = async () => ({}); },
  'zero key': f => { f.keys.encryptionKey.fill(0); },
  'equal keys': f => { f.keys.hmacKey = f.keys.encryptionKey; },
  'invalid identity': f => { f.data.repositories[0].id = 0; },
  'source error': f => { f.client.query = async () => { throw Error('synthetic-sensitive'); }; },
})) test(`reject ${name} with bounded error`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(capture(f), { message: 'Isolated restore capture rejected' });
});

test('wrong scope, keys and envelope changes rejected', async () => {
  const f = fixture(), { envelope } = await capture(f);
  const open = (e, s, k) => openSealedFullState(e, s, k, f.keys.hmacKey, f.manifest);
  assert.throws(() => open(envelope, { ...f.scope, tenantId: 'wrong' }, f.keys.encryptionKey));
  assert.throws(() => open(envelope, f.scope, Buffer.alloc(32, 5)));
  envelope.tableRecords[0].ciphertextBase64 = 'AAAA';
  assert.throws(() => open(envelope, f.scope, f.keys.encryptionKey));
});

test('atomic encrypted save, private modes, collision, symlink, hardlink and failure', async (t) => {
  for (const marker of ['/.git', path.join(os.tmpdir(), '.git')]) {
    try { await fs.lstat(marker); t.skip('Sandbox temporary ancestor has Git marker; owner-run non-Git filesystem acceptance required'); return; } catch (e) {
      if (e.code !== 'ENOENT') { t.skip('Sandbox denies ancestor Git-marker inspection; owner-run filesystem acceptance required'); return; }
    }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-test-'));
  const f = fixture(), { envelope } = await capture(f);
  const verification = { ...f.keys, manifest: f.manifest, scope: f.scope };
  const save = (dir, name) => saveIsolatedEnvelope(dir, name, envelope, verification);
  try {
    await save(directory, 'capture.json');
    const target = path.join(directory, 'capture.json');
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), envelope);
    await assert.rejects(save(directory, 'capture.json'));
    await fs.symlink(target, path.join(directory, 'symlink.json'));
    await assert.rejects(save(directory, 'symlink.json'));
    await fs.link(target, path.join(directory, 'hardlink.json'));
    await assert.rejects(save(directory, 'hardlink.json'));
    await fs.mkdir(path.join(directory, 'failure.json'));
    await assert.rejects(save(directory, 'failure.json'));
    assert.equal((await fs.readdir(directory)).some(n => n.startsWith('.sealed-')), false);
    await fs.chmod(directory, 0o755);
    await assert.rejects(save(directory, 'public.json'));
    await fs.chmod(directory, 0o700);
    await fs.mkdir(path.join(directory, '.git'));
    await assert.rejects(save(directory, 'git.json'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});


test('persistence rejects invalid output, wrong verification and Git destinations', async () => {
  const f = fixture(), { envelope } = await capture(f);
  const verification = { ...f.keys, manifest: f.manifest, scope: f.scope };
  await assert.rejects(saveIsolatedEnvelope(process.cwd(), 'capture.json', envelope, verification));
  await assert.rejects(saveIsolatedEnvelope('/tmp', '../capture.json', envelope, verification));
  await assert.rejects(saveIsolatedEnvelope('/tmp', 'capture.json', { ...envelope, plaintext: 'synthetic-sensitive' }, verification));
  await assert.rejects(saveIsolatedEnvelope('/tmp', 'capture.json', envelope, { ...verification, encryptionKey: Buffer.alloc(32, 4) }));
});
