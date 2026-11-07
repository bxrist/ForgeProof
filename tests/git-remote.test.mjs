import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GitAppStateService } from '../server/git-store/store.mjs';
import { RemoteGitAppStateService } from '../server/git-store/remote.mjs';
import { hash } from '../server/git-store/schema.mjs';
import { main } from '../server/git-store/cli.mjs';
const keys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
let signatures = 0;
const signer = { actor: 'fixture', keyId: 'fixture', sign: async bytes => { signatures++; return sign(null, bytes, keys.privateKey).toString('base64'); } };
const trust = { eventKeys: { fixture: { actor: 'fixture', publicKey: pem } }, receiptKeys: [publicKey], receiptPredecessor: null };
const ref = 'refs/heads/forgeproof/tenant/app';
const git = (directory, ...args) => execFileSync('git', ['--git-dir=' + directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = id => ({ kind: 'organizations', id, action: 'put', expectedVersion: null, record: { id, name: 'Synthetic', slug: 'synthetic-' + id, ownerId: 'user' } });
const tx = id => ({ idempotencyKey: 'request-' + id, operations: [put(id)] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fp-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream.git');
  execFileSync('git', ['init', '--bare', upstream], { stdio: 'ignore' });
  git(upstream, 'config', 'receive.denyNonFastForwards', 'true');
  git(upstream, 'config', 'receive.denyDeletes', 'true');
  const options = { tenant: 'tenant', repository: 'app', trust, signer };
  const seed = new GitAppStateService({ ...options, directory: upstream, checkpoint: null });
  const checkpoint = (await seed.append(tx(1))).checkpoint;
  let n = 0;
  async function worker(extra = {}) {
    const directory = join(root, 'worker-' + ++n + '.git');
    execFileSync('git', ['init', '--bare', directory], { stdio: 'ignore' });
    const retained = [];
    const config = { ...options, directory, remote: upstream, privateStore: { url: upstream, tenant: 'tenant', repository: 'app' }, checkpoint, retainCheckpoint: async pin => retained.push(pin), transport: { localTestOnly: true }, ...extra };
    return { service: new RemoteGitAppStateService(config), config, retained };
  }
  return { root, upstream, checkpoint, seed, worker, options };
}

test('macOS bare init filesystem booleans permit verified remote replay and append', async t => {
  const f = await fixture(t); const a = await f.worker();
  for (const value of ['true', 'false']) {
    git(a.config.directory, 'config', 'core.ignorecase', value);
    git(a.config.directory, 'config', 'core.precomposeunicode', value);
    const before = await a.service.replay();
    const id = value === 'true' ? 2 : 3;
    const result = await a.service.append(tx(id));
    assert.equal(result.checkpoint.sequence, before.checkpoint.sequence + 1);
    assert.equal(result.checkpoint.commit, git(f.upstream, 'rev-parse', ref));
    const fresh = await f.worker({ checkpoint: a.retained.at(-1) });
    const recovered = await fresh.service.replay();
    assert.equal(recovered.records.organizations[id].id, id);
    assert.deepEqual(recovered.checkpoint, result.checkpoint);
  }
});

test('macOS config allowance still rejects transport, executable, include and path injection before I/O', async t => {
  const f = await fixture(t); const a = await f.worker();
  git(a.config.directory, 'config', 'core.ignorecase', 'true');
  git(a.config.directory, 'config', 'core.precomposeunicode', 'true');
  let calls = 0;
  a.service.transportGit = async () => { calls++; throw new Error('unexpected transport'); };
  for (const [key, value] of [
    ['url.ext::evil.insteadOf', f.upstream],
    ['credential.helper', '!evil'],
    ['core.sshCommand', 'evil'],
    ['include.path', '../../outside-config'],
    ['includeIf.gitdir:/**.path', '../../outside-config'],
    ['alias.fetch', '!evil'],
    ['core.hooksPath', '../../hooks'],
    ['core.worktree', '../../outside'],
    ['core.gitProxy', 'evil'],
  ]) {
    git(a.config.directory, 'config', key, value);
    await assert.rejects(a.service.replay(), /Untrusted local Git transport configuration/, key);
    await assert.rejects(a.service.append(tx(2)), /Untrusted local Git transport configuration/, key);
    git(a.config.directory, 'config', '--unset-all', key);
  }
  assert.equal(calls, 0);
});

test('macOS filesystem config rejects invalid booleans including overridden duplicates before I/O', async t => {
  const f = await fixture(t); const a = await f.worker();
  await a.service.local.ready;
  let calls = 0;
  a.service.transportGit = async () => { calls++; throw new Error('unexpected transport'); };
  for (const key of ['core.ignorecase', 'core.precomposeunicode']) {
    git(a.config.directory, 'config', key, '../../outside');
    await assert.rejects(a.service.replay(), /Untrusted local Git transport configuration/);
    git(a.config.directory, 'config', '--add', key, 'true');
    await assert.rejects(a.service.append(tx(2)), /Untrusted local Git transport configuration/);
    git(a.config.directory, 'config', '--unset-all', key);
  }
  assert.equal(calls, 0);
});

test('separate clones race publication and retain both events; stale refs are not authority', async t => {
  const f = await fixture(t); const a = await f.worker(); const b = await f.worker();
  let count = 0, release; const barrier = new Promise(r => release = r);
  for (const w of [a, b]) {
    const real = w.service.transportGit.bind(w.service);
    let first = true;
    w.service.transportGit = async (args, ...rest) => {
      if (args[0] === 'push' && first) { first = false; if (++count === 2) release(); await barrier; }
      return real(args, ...rest);
    };
  }
  await Promise.all([a.service.append(tx(2)), b.service.append(tx(3))]);
  const state = await a.service.replay();
  assert.deepEqual(Object.keys(state.records.organizations), ['1', '2', '3']);
  assert.equal(state.events.length, 3);
  assert.equal(a.retained.at(-1).commit, git(f.upstream, 'rev-parse', ref));
});

test('ambiguous successful push reads back before retry; idempotency survives restart', async t => {
  const f = await fixture(t); const a = await f.worker(); const real = a.service.transportGit.bind(a.service);
  a.service.transportGit = async (args, ...rest) => { const result = await real(args, ...rest); if (args[0] === 'push') throw new Error('lost reply'); return result; };
  signatures = 0;
  await a.service.append(tx(2));
  assert.equal(signatures, 1);
  const restarted = new RemoteGitAppStateService({ ...a.config, checkpoint: a.retained.at(-1) });
  assert.equal((await restarted.append(tx(2))).duplicate, true);
  assert.equal(signatures, 1);
  await assert.rejects(restarted.append({ ...tx(2), operations: [put(4)] }), /Idempotency/);
});

test('push succeeded but readback unavailable: no acknowledgment, fresh clone discovers operation', async t => {
  const f = await fixture(t); const a = await f.worker(); const real = a.service.transportGit.bind(a.service); let pushed = false;
  a.service.transportGit = async (args, ...rest) => { if (pushed) throw new Error('network down'); const result = await real(args, ...rest); if (args[0] === 'push') pushed = true; return result; };
  await assert.rejects(a.service.append(tx(2)), /network down/);
  const b = await f.worker(); signatures = 0;
  assert.equal((await b.service.append(tx(2))).duplicate, true);
  assert.equal(signatures, 0);
});

test('crash before push reuses signed pending candidate; unavailable remote never signs', async t => {
  const f = await fixture(t); const a = await f.worker(); const real = a.service.transportGit.bind(a.service); let failed = false;
  a.service.transportGit = async (args, ...rest) => {
    if (args[0] === 'push') { failed = true; throw new Error('crash'); }
    if (failed) throw new Error('offline');
    return real(args, ...rest);
  };
  signatures = 0;
  await assert.rejects(a.service.append(tx(2)), /offline/);
  assert.equal(signatures, 1);
  const restart = new RemoteGitAppStateService(a.config);
  await restart.append(tx(2));
  assert.equal(signatures, 1);
  const b = await f.worker(); b.service.transportGit = async () => { throw new Error('offline'); };
  await assert.rejects(b.service.append(tx(3)), /offline/);
  assert.equal(signatures, 1);
});

test('simultaneous identical operations in separate clones publish one receipt and one quota increment', async t => {
  const f = await fixture(t); const a = await f.worker(); const b = await f.worker();
  const r = { id: 42, userId: 'user', filePath: 'synthetic.txt', fileHash: 'sha256:' + 'a'.repeat(64), modelName: 'fixture', modelProvider: 'fixture', countryOfOrigin: 'unknown', prevEntryHash: null, signedAt: '2026-11-07T00:00:00.000Z', receiptVersion: 'v1', publicKey };
  r.entryHash = hash([r.fileHash,r.modelName,r.modelProvider,r.countryOfOrigin,'genesis',r.signedAt].join('|'));
  r.signature = sign(null, Buffer.from(`${r.entryHash}|${r.fileHash}|${r.signedAt}`), keys.privateKey).toString('base64');
  const subscription = { id: 1, userId: 'user', plan: 'pro', status: 'active', attestationLimit: 100, attestationCount: 0, apiKeyLimit: 3 };
  await a.service.append({ idempotencyKey: 'subscription-seed', operations: [{ kind: 'subscriptions', id: 1, action: 'put', expectedVersion: null, record: subscription }] });
  const request = { idempotencyKey: 'receipt-request', operations: [{ kind: 'receipts', id: 42, action: 'put', expectedVersion: null, record: { id: 42, original: JSON.stringify(r) } }, { kind: 'subscriptions', id: 1, action: 'put', expectedVersion: 2, record: { ...subscription, attestationCount: 1 } }] };
  await Promise.all([a.service.append(request), b.service.append(request)]);
  const state = await a.service.replay();
  assert.equal(state.events.length, 3); assert.equal(Object.keys(state.records.receipts).length, 1);
  assert.equal(state.records.subscriptions[1].attestationCount, 1);
  const mirror = join(f.root, 'receipt-mirror.git');
  execFileSync('git', ['clone', '--mirror', '--no-local', f.upstream, mirror], { stdio: 'ignore' });
  const offline = new GitAppStateService({ ...f.options, signer: undefined, directory: mirror, checkpoint: state.checkpoint });
  const recovered = await offline.replay();
  assert.deepEqual(recovered.records, state.records);
  assert.equal(recovered.records.receipts[42].original, JSON.stringify(r));
  await assert.rejects(new GitAppStateService({ ...f.options, directory: mirror, checkpoint: state.checkpoint, trust: { ...trust, receiptKeys: [] } }).replay(), /receipt key/);
});

test('remote deletion, rewind, signed divergence, wrong scope and incorrect checkpoint fail closed', async t => {
  const f = await fixture(t); const a = await f.worker(); await a.service.append(tx(2));
  git(f.upstream, 'update-ref', ref, f.checkpoint.commit);
  await assert.rejects(a.service.replay(), /rollback|checkpoint|behind/i);
  git(f.upstream, 'update-ref', '-d', ref);
  await assert.rejects(a.service.replay(), /Missing/);
  const divergent = new GitAppStateService({ ...f.options, directory: f.upstream, checkpoint: null });
  await divergent.append(tx(9));
  await assert.rejects(a.service.replay(), /rollback|checkpoint|behind/i);
  const wrongTenant = new GitAppStateService({ ...f.options, tenant: 'other', directory: f.upstream, checkpoint: null });
  const wrong = await wrongTenant.append(tx(8)); git(f.upstream, 'update-ref', ref, wrong.checkpoint.commit);
  const b = await f.worker(); await assert.rejects(b.service.replay(), /scope/);
  git(f.upstream, 'update-ref', ref, f.checkpoint.commit);
  const bad = await f.worker({ checkpoint: { ...f.checkpoint, eventHash: '0'.repeat(64) } });
  await assert.rejects(bad.service.replay(), /Checkpoint/);
});

test('symbolic remote, missing object and local transport config injection fail closed', async t => {
  const f = await fixture(t); const a = await f.worker();
  git(f.upstream, 'symbolic-ref', ref, 'refs/heads/other'); git(f.upstream, 'update-ref', 'refs/heads/other', f.checkpoint.commit);
  await assert.rejects(a.service.replay(), /symbolic|invalid/i);
  git(f.upstream, 'symbolic-ref', '--delete', ref); git(f.upstream, 'update-ref', ref, f.checkpoint.commit);
  git(a.config.directory, 'config', 'url.ext::evil.insteadOf', f.upstream);
  await assert.rejects(a.service.replay(), /configuration/);
  git(a.config.directory, 'config', '--unset-all', 'url.ext::evil.insteadOf');
  await rm(join(f.upstream, 'objects', f.checkpoint.commit.slice(0, 2), f.checkpoint.commit.slice(2)));
  await assert.rejects(a.service.replay(), /transport/);
});

test('external checkpoint persistence failure prevents receipt acknowledgment', async t => {
  const f = await fixture(t); let calls = 0;
  const a = await f.worker({ retainCheckpoint: async () => { if (++calls > 1) throw new Error('checkpoint unavailable'); } });
  await assert.rejects(a.service.append(tx(2)), /checkpoint unavailable/);
  const b = await f.worker(); assert.equal((await b.service.append(tx(2))).duplicate, true);
  assert.throws(() => new RemoteGitAppStateService({ ...b.config, checkpoint: null }), /checkpoint/);
  assert.throws(() => new RemoteGitAppStateService({ ...b.config, privateStore: { ...b.config.privateStore, tenant: 'wrong' } }), /scope/);
  assert.throws(() => new RemoteGitAppStateService({ ...b.config, remote: 'ext::bad' }), /scope|transport/);
});

test('mirror, bundle backup and disconnected fresh clone rebuild all rows with independent pin', async t => {
  const f = await fixture(t); const a = await f.worker(); await a.service.append(tx(2));
  const pin = a.retained.at(-1); const mirror = join(f.root, 'mirror.git');
  execFileSync('git', ['clone', '--mirror', '--no-local', f.upstream, mirror], { stdio: 'ignore' });
  const bundle = join(f.root, 'backup.bundle'); git(mirror, 'bundle', 'create', bundle, '--all'); git(mirror, 'bundle', 'verify', bundle);
  const restored = join(f.root, 'restored.git'); execFileSync('git', ['clone', '--mirror', bundle, restored], { stdio: 'ignore' });
  await rm(f.upstream, { recursive: true, force: true });
  const config = join(f.root, 'trust.json'); await writeFile(config, JSON.stringify({ tenant: 'tenant', repository: 'app', trust, checkpoint: pin }));
  const result = await main(['restore', restored, config, join(f.root, 'rows.json')]);
  assert.deepEqual(Object.keys(result.records.organizations), ['1', '2']);
  await writeFile(config, JSON.stringify({ tenant: 'tenant', repository: 'app', trust, checkpoint: { ...pin, commit: '0'.repeat(40) } }));
  await assert.rejects(main(['verify', restored, config, join(f.root, 'bad.json')]), /checkpoint/i);
});

test('deletion or rewind after verified fetch cannot be silently recreated by push', async t => {
  for (const mode of ['delete', 'rewind']) {
    const f = await fixture(t); const a = await f.worker(); await a.service.append(tx(2));
    const real = a.service.transportGit.bind(a.service); let changed = false;
    a.service.transportGit = async (args, ...rest) => {
      if (args[0] === 'push' && !changed) {
        changed = true;
        if (mode === 'delete') git(f.upstream, 'update-ref', '-d', ref);
        else git(f.upstream, 'update-ref', ref, f.checkpoint.commit);
      }
      return real(args, ...rest);
    };
    await assert.rejects(a.service.append(tx(3)), /Missing|rollback|checkpoint/i);
    if (mode === 'delete') assert.throws(() => git(f.upstream, 'rev-parse', '--verify', ref));
    else assert.equal(git(f.upstream, 'rev-parse', ref), f.checkpoint.commit);
  }
});
