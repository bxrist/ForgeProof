import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GitAppStateService, ConflictError } from '../server/git-store/store.mjs';
import { canonical, hash } from '../server/git-store/schema.mjs';
import { main } from '../server/git-store/cli.mjs';
const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const publicKey = keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
const signer = { actor: 'fixture-writer', keyId: 'fixture-key', sign: async bytes => sign(null, bytes, keys.privateKey).toString('base64') };
const trust = { eventKeys: { 'fixture-key': { actor: signer.actor, publicKey: keys.publicKey } }, receiptKeys: [publicKey], receiptPredecessor: null };
const git = (dir, ...args) => GitAppStateService.prototype.git.call({ directory: dir }, args);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forgeproof-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private.git');
  execFileSync('git', ['init','--bare',directory], { stdio: 'ignore' });
  const options = { directory, tenant: 'tenant-a', repository: 'repo-a', trust, checkpoint: null, signer };
  return { root, directory, options, service: new GitAppStateService(options) };
}
function put(id, name = 'Example', expectedVersion = null, kind = 'organizations') {
  return { kind, id, action: 'put', expectedVersion, record: { id, name, slug: 'example-' + id, ownerId: 'user-a' } };
}
const tx = (key, ...operations) => ({ idempotencyKey: key, operations });
function receipt(id, previous = null) {
  const r = { id, userId: 'user-a', filePath: 'synthetic.txt', fileHash: 'sha256:' + 'a'.repeat(64), modelName: 'fixture-unattributed', modelProvider: 'fixture-unattributed', countryOfOrigin: 'unknown', prevEntryHash: previous, signedAt: '2026-11-03T12:00:00.000Z', createdAt: '2026-11-04T12:00:00.000Z', receiptVersion: 'v1', publicKey };
  r.entryHash = hash([r.fileHash,r.modelName,r.modelProvider,r.countryOfOrigin,previous || 'genesis',r.signedAt].join('|'));
  r.signature = sign(null, Buffer.from(`${r.entryHash}|${r.fileHash}|${r.signedAt}`), keys.privateKey).toString('base64');
  return r;
}
const receiptOp = r => ({ kind: 'receipts', id: r.id, action: 'put', expectedVersion: null, record: { id: r.id, original: JSON.stringify(r, null, 2) + '\n' } });

test('atomic replay, record versions, stable retry and immutable receipts', async t => {
  const { service } = await fixture(t);
  const r = receipt(42);
  const first = await service.append(tx('initial', put(7), receiptOp(r)));
  assert.equal(first.checkpoint.sequence, 1);
  assert.equal((await service.append(tx('initial', put(7), receiptOp(r)))).duplicate, true);
  await assert.rejects(service.append(tx('initial', put(8))), /Idempotency/);
  await assert.rejects(service.append(tx('stale', put(7, 'Changed'))), ConflictError);
  await assert.rejects(service.append(tx('rewrite-receipt', { ...receiptOp(r), expectedVersion: 1 })), /immutable/);
  await service.append(tx('update', put(7, 'Changed', 1)));
  const state = await service.replay();
  assert.equal(state.records.organizations[7].name, 'Changed');
  assert.equal(state.records.receipts[42].original, JSON.stringify(r, null, 2) + '\n');
  assert.equal(state.versions['organizations/7'], 2);
  assert.equal(state.events.length, 2);
});

test('real competing Git writers lose CAS then replay without dropping either append', async t => {
  const { service, options } = await fixture(t);
  let count = 0, release;
  const barrier = new Promise(r => release = r);
  const beforeCAS = async ({ attempt }) => { if (attempt) return; if (++count === 2) release(); await barrier; };
  const other = new GitAppStateService(options);
  const results = await Promise.all([service.append(tx('race-a', put(1)), { beforeCAS }), other.append(tx('race-b', put(2)), { beforeCAS })]);
  assert.deepEqual(results.map(r => r.checkpoint.sequence).sort(), [1,2]);
  const state = await service.replay();
  assert.equal(state.events.length, 2);
  assert.deepEqual(Object.keys(state.records.organizations).sort(), ['1','2']);
});

test('competing updates cannot overwrite; concurrent identical retries produce one event', async t => {
  const { service, options } = await fixture(t);
  const first = await service.append(tx('seed', put(1)));
  const a = new GitAppStateService({ ...options, checkpoint: first.checkpoint });
  const b = new GitAppStateService({ ...options, checkpoint: first.checkpoint });
  const results = await Promise.allSettled([a.append(tx('change-a', put(1,'A',1))), b.append(tx('change-b', put(1,'B',1)))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const same = tx('same', put(3));
  await Promise.all([a.append(same), b.append(same)]);
  assert.equal((await service.replay()).events.length, 3);
});

test('crash before ref publication leaves no acknowledged event; retry after restart', async t => {
  const { service, options } = await fixture(t);
  await assert.rejects(service.append(tx('crash', put(1)), { beforeCAS: () => { throw new Error('synthetic crash'); } }), /synthetic crash/);
  assert.equal(await service.head(), null);
  const restarted = new GitAppStateService(options);
  await restarted.append(tx('crash', put(1)));
  assert.equal((await restarted.replay()).events.length, 1);
});

test('tenant/repository isolation and independent refs', async t => {
  const { service, options } = await fixture(t);
  const other = new GitAppStateService({ ...options, tenant: 'tenant-b' });
  const repo = new GitAppStateService({ ...options, repository: 'repo-b' });
  await service.append(tx('a', put(1)));
  await other.append(tx('b', put(1,'Tenant B')));
  await repo.append(tx('c', put(1,'Repo B')));
  assert.equal((await service.replay()).records.organizations[1].name, 'Example');
  assert.equal((await other.replay()).records.organizations[1].name, 'Tenant B');
  assert.equal((await repo.replay()).records.organizations[1].name, 'Repo B');
  await service.git(['update-ref', other.ref, await service.head()]);
  await assert.rejects(other.replay(), /scope mismatch/);
});

test('pinned checkpoint detects rollback, deletion, divergent signed rewrite and key substitution', async t => {
  const { service, directory, options } = await fixture(t);
  const first = await service.append(tx('one', put(1)));
  const second = await service.append(tx('two', put(2)));
  await git(directory, 'update-ref', service.ref, first.checkpoint.commit);
  await assert.rejects(service.replay(), /rollback\/rewrite/);
  await git(directory, 'update-ref', '-d', service.ref);
  await assert.rejects(service.replay(), /Missing trusted/);
  const alternative = new GitAppStateService(options);
  await alternative.append(tx('rewrite', put(3)));
  await assert.rejects(service.replay(), /rollback\/rewrite/);
  await git(directory, 'update-ref', service.ref, second.checkpoint.commit);
  const wrong = new GitAppStateService({ ...options, checkpoint: second.checkpoint, trust: { ...trust, eventKeys: {} } });
  await assert.rejects(wrong.replay(), /Untrusted event/);
});

test('raw tree mutation, extra files, absent ancestry and invalid event signature fail closed', async t => {
  const { service, directory, options } = await fixture(t);
  const good = await service.append(tx('one', put(1)));
  const original = await service.git(['show', `${good.checkpoint.commit}:event.json`]);
  async function replace(raw, parent, extra = '') {
    const blob = await service.git(['hash-object','-w','--stdin'], raw);
    const tree = await service.git(['mktree'], `100644 blob ${blob}\tevent.json\n${extra}`);
    const commit = await service.git(['commit-tree',tree,...(parent ? ['-p',parent] : [])], 'tamper');
    await git(directory,'update-ref',service.ref,commit);
  }
  const altered = JSON.parse(original); altered.body.operations[0].record.name = 'tamper';
  await replace(canonical(altered));
  await assert.rejects(new GitAppStateService(options).replay(), /signature/);
  await replace(original + '\n');
  await assert.rejects(new GitAppStateService(options).replay(), /Noncanonical/);
  const blob = await service.git(['hash-object','-w','--stdin'], 'extra');
  await replace(original, undefined, `100644 blob ${blob}\textra\n`);
  await assert.rejects(new GitAppStateService(options).replay(), /tree content/);
  // A second event without its parent cannot masquerade as genesis.
  await git(directory,'update-ref',service.ref,good.checkpoint.commit);
  const second = await new GitAppStateService(options).append(tx('two',put(2)));
  await replace(await service.git(['show',`${second.checkpoint.commit}:event.json`]));
  await assert.rejects(new GitAppStateService(options).replay(), /chain\/scope/);
});

test('reject secret fields, arbitrary metadata, invalid signatures and wrong receipt ancestry', async t => {
  const { service, options } = await fixture(t);
  await assert.rejects(service.append(tx('secret', { kind: 'users', id: 'user-a', action: 'put', expectedVersion: null, record: { id: 'user-a', githubToken: 'synthetic-not-a-token' } })), /Unknown fields/);
  const r = receipt(42);
  for (const change of [{ signature: 'AAAA' }, { modelName: 'altered' }, { signedAt: '' }, { metadata: { token: 'synthetic' } }]) {
    await assert.rejects(service.append(tx('invalid', receiptOp({ ...r, ...change }))));
  }
  await assert.rejects(service.append(tx('wrong-parent', receiptOp(receipt(43, 'f'.repeat(64))))), /predecessor/);
  const untrusted = new GitAppStateService({ ...options, trust: { ...trust, receiptKeys: [] } });
  await assert.rejects(untrusted.append(tx('wrong-key', receiptOp(r))), /Untrusted historical/);
  assert.equal(await service.head(), null);
});

test('clone-only offline verification and full application reconstruction without DB or dependencies', async t => {
  const { service, directory, root, options } = await fixture(t);
  const data = {
    users: { id: 'user-a', email: 'fixture@example.invalid', credentialRef: 'custodian:user-a' },
    repositories: { id: 1, userId: 'user-a', githubId: 99, name: 'fixture', fullName: 'fixture/repo', url: 'https://example.invalid' },
    organizations: { id: 2, name: 'Fixture', slug: 'fixture', ownerId: 'user-a' },
    orgMembers: { id: 3, orgId: 2, userId: 'user-a', role: 'owner' },
    apiKeys: { id: 4, userId: 'user-a', name: 'fixture', credentialRef: 'custodian:key-a', isActive: true, permissions: ['attest:read'] },
    subscriptions: { id: 5, userId: 'user-a', plan: 'pro', status: 'active', attestationLimit: 10000, attestationCount: 6, apiKeyLimit: 10, stripeCustomerId: 'synthetic_customer' },
    auditLogs: { id: 6, userId: 'user-a', action: 'fixture.import', detailsRef: 'custodian:audit-a' },
    sessions: { id: 'session-descriptor-a', userId: 'user-a', expiresAt: '2026-12-01T00:00:00Z', custodianRef: 'custodian:session-a' },
  };
  const operations = Object.entries(data).map(([kind,record]) => ({ kind, id: record.id, action: 'put', expectedVersion: null, record }));
  operations.push(receiptOp(receipt(42)));
  const result = await service.append(tx('all-classes', ...operations));
  const clone = join(root,'recovered.git');
  execFileSync('git',['clone','--mirror','--no-local',directory,clone],{ stdio: 'ignore' });
  await rm(directory,{ recursive:true,force:true });
  const configPath = join(root,'trust.json');
  await writeFile(configPath, JSON.stringify({ tenant: options.tenant, repository: options.repository, trust, checkpoint: result.checkpoint }));
  const restoredPath = join(root,'restored.json');
  await main(['verify',clone,configPath,join(root,'verify.json')]);
  const restored = await main(['restore',clone,configPath,restoredPath]);
  for (const [kind,record] of Object.entries(data)) assert.deepEqual(restored.records[kind][record.id],record);
  assert.equal(restored.records.receipts[42].original, receiptOp(receipt(42)).record.original);
  assert.equal(restored.records.subscriptions[5].attestationCount,6);
  assert.deepEqual(JSON.parse(await readFile(restoredPath,'utf8')).checkpoint,result.checkpoint);
  assert.equal(await git(clone,'fsck','--full'), '');
});

test('migration CLI preflights, preserves historical IDs/bytes, resumes idempotently and restores offline', async t => {
  const { root, directory, service, options } = await fixture(t);
  const config = join(root,'config.json');
  await writeFile(config, JSON.stringify({ tenant: options.tenant, repository: options.repository, trust, checkpoint: null }));
  const signingModule = join(root,'synthetic-signer.mjs');
  await writeFile(signingModule, `import { sign } from 'node:crypto';\nexport const signer = { actor: 'fixture-writer', keyId: 'fixture-key', sign: async bytes => sign(null, bytes, ${JSON.stringify(keys.privateKey)}).toString('base64') };`, { mode: 0o600 });
  const r1 = receipt(42), r2 = receipt(104, r1.entryHash);
  const original = receiptOp(r1).record.original;
  const transactions = [tx('migrate-one',put(1),receiptOp(r1)),tx('migrate-two',receiptOp(r2))];
  const input = join(root,'export.json');
  await writeFile(input, JSON.stringify({ version: 1, transactions: [...transactions,tx('bad-last',receiptOp({ ...receipt(105,r2.entryHash), signature: 'AAAA' }))] }));
  await assert.rejects(main(['migrate',directory,config,join(root,'bad-output'),input,signingModule]), /signature/);
  assert.equal(await service.head(),null);
  await writeFile(input,JSON.stringify({ version: 1, transactions }));
  const a = await main(['migrate',directory,config,join(root,'migration-a'),input,signingModule]);
  const b = await main(['migrate',directory,config,join(root,'migration-b'),input,signingModule]);
  assert.deepEqual(a.checkpoint,b.checkpoint);
  const state = await service.replay();
  assert.equal(state.events.length,2);
  assert.deepEqual(Object.keys(state.records.receipts),['42','104']);
  assert.equal(state.records.receipts[42].original,original);
  // Execute the actual dependency-free CLI in another process.
  const verified = await promisify(execFile)('node', ['server/git-store/cli.mjs','verify',directory,config,join(root,'external-verification')], { env: { PATH: process.env.PATH } });
  assert.equal(JSON.parse(verified.stdout).verified,true);
});

test('delete tombstones prevent stale resurrection; transaction failure publishes nothing', async t => {
  const { service } = await fixture(t);
  await service.append(tx('seed',put(1)));
  await assert.rejects(service.append(tx('partial',put(2),put(1,'stale'))), /version conflict/);
  assert.equal((await service.replay()).records.organizations[2],undefined);
  await service.append(tx('delete',{ kind:'organizations',id:1,action:'delete',expectedVersion:1 }));
  await assert.rejects(service.append(tx('stale-create',put(1))), /version conflict/);
  await service.append(tx('recreate',put(1,'New generation',2)));
  assert.equal((await service.replay()).versions['organizations/1'],3);
});

test('untrusted or mismatched event signer and unknown schema fail before publication', async t => {
  const { options, service } = await fixture(t);
  const bad = new GitAppStateService({ ...options, signer: { ...signer, actor:'other-actor' } });
  await assert.rejects(bad.append(tx('spoof',put(1))), /Signer not authorized/);
  await assert.rejects(service.append(tx('unknown',{ ...put(1), kind:'unknown' })), /Unknown class/);
  await assert.rejects(service.append(tx('invalid-number',{ kind:'subscriptions',id:1,action:'put',expectedVersion:null,record:{ id:1,userId:'user-a',plan:'pro',status:'active',attestationLimit:100,attestationCount:-1,apiKeyLimit:1 } })), /usage count/);
  assert.equal(await service.head(),null);
  assert.throws(() => new GitAppStateService({ ...options, checkpoint:undefined }), /Explicit trusted/);
  assert.throws(() => new GitAppStateService({ ...options, tenant:'../escape' }), /Invalid identifier/);
});

test('observed checkpoints cannot regress through a stale read or acknowledgment', async t => {
  const { service } = await fixture(t);
  const first = await service.append(tx('one',put(1)));
  const second = await service.append(tx('two',put(2)));
  assert.throws(() => service.observe(first.checkpoint), /behind or divergent/);
  assert.deepEqual(service.checkpoint,second.checkpoint);
  assert.throws(() => service.observe({ ...second.checkpoint, eventHash:'0'.repeat(64) }), /divergent/);
  assert.deepEqual(service.checkpoint,second.checkpoint);
});

test('missing committed ancestry fails closed, and a graft cannot hide real parents', async t => {
  const { service, options, directory } = await fixture(t);
  const first = await service.append(tx('one',put(1)));
  const second = await service.append(tx('two',put(2)));
  // A graft advertises the second commit as a root; raw object parents must still be checked.
  const grafts = join(directory,'info','grafts');
  await writeFile(grafts,second.checkpoint.commit + '\n');
  await assert.rejects(new GitAppStateService(options).replay(), /ancestry/);
  await rm(grafts);
  await rm(join(directory,'objects',first.checkpoint.commit.slice(0,2),first.checkpoint.commit.slice(2)));
  await assert.rejects(new GitAppStateService({ ...options, checkpoint:second.checkpoint }).replay(), /git rev-list failed/);
});

test('symbolic refs cannot redirect a writer into another tenant stream', async t => {
  const { service, options } = await fixture(t);
  const other = new GitAppStateService({ ...options, tenant:'tenant-b' });
  const original = await other.append(tx('other',put(1,'Tenant B')));
  await service.git(['symbolic-ref',service.ref,other.ref]);
  await assert.rejects(service.append(tx('redirect',put(2))), /Symbolic/);
  assert.equal(await other.head(),original.checkpoint.commit);
  // A dangling symbolic ref must also never dereference into the named target at publication.
  await service.git(['symbolic-ref',service.ref,'refs/heads/uncreated-target']);
  await assert.rejects(service.append(tx('safe-bootstrap',put(3))), /dangling symref/);
  assert.equal(await service.git(['for-each-ref','--format=%(refname)','refs/heads/uncreated-target']), '');
  assert.equal((await service.replay()).events.length,0);
});

test('signature encoding is canonical and ambiguous legacy pipe-delimited fields are rejected', async t => {
  const { service } = await fixture(t);
  const r = receipt(42);
  await assert.rejects(service.append(tx('malleable',receiptOp({ ...r, signature:r.signature + '\n' }))), /signature/);
  const ambiguous = { ...r, modelName:'fixture|unattributed' };
  ambiguous.entryHash = hash([ambiguous.fileHash,ambiguous.modelName,ambiguous.modelProvider,ambiguous.countryOfOrigin,'genesis',ambiguous.signedAt].join('|'));
  ambiguous.signature = sign(null,Buffer.from(`${ambiguous.entryHash}|${ambiguous.fileHash}|${ambiguous.signedAt}`),keys.privateKey).toString('base64');
  await assert.rejects(service.append(tx('ambiguous',receiptOp(ambiguous))), /Ambiguous legacy/);
  assert.equal(await service.head(),null);
});
