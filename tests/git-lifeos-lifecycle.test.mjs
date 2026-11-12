import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { GitAppStateService } from '../server/git-store/store.mjs';
import { GitStorage } from '../server/git-store/storage.ts';
import { restoreProtectedReceipt } from '../server/git-store/protected-receipt.mjs';
import { verifyLifecycleEnvelope, verifyLifecycleGraph } from '../server/lifeosLifecycle.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'forgeproof-lifecycle-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', directory], { stdio: 'ignore' });
  const event = generateKeyPairSync('ed25519'), receipt = generateKeyPairSync('ed25519');
  const publicKey = receipt.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const service = new GitAppStateService({
    directory, tenant: 'fixture', repository: 'lifecycle', checkpoint: null,
    trust: { eventKeys: { event: { actor: 'fixture', publicKey: event.publicKey.export({ type: 'spki', format: 'pem' }) } },
      receiptKeys: [publicKey], receiptPredecessor: null },
    signer: { actor: 'fixture', keyId: 'event', sign: async bytes => sign(null, bytes, event.privateKey).toString('base64') },
  });
  await service.append({ idempotencyKey: 'bootstrap', operations: ['owner', 'service', 'other'].map(id => ({
    kind: 'users', id, action: 'put', expectedVersion: null, record: { id },
  })) });
  const encryptionKey = randomBytes(32), members = ['owner', 'service', 'other'];
  const store = id => new GitStorage(service, id, members, 'owner', undefined, '', undefined, undefined, encryptionKey);
  const git = store('service'), signer = { publicKey, sign: async bytes => sign(null, bytes, receipt.privateKey).toString('base64') };
  const source = { userId: 'service', fileName: 'artifact', filePath: 'artifact', fileHash: 'a'.repeat(64),
    modelName: 'UNSPECIFIED', modelProvider: 'UNSPECIFIED', countryOfOrigin: 'UNSPECIFIED',
    receiptVersion: 'v1', signedAt: '2026-11-10T00:00:00.000Z',
    metadata: { privateSentinel: 'DO_NOT_PUBLISH_PRIVATE_METADATA' } };
  let n = 0;
  const issue = (stage, parents = [], overrides = {}, target = git, src = source) => target.issueAttestationWithSigner(
    src, signer, `lifecycle-request-${++n}`, async () => {}, {
      project: 'fixture/project', stage, parents, observedAt: '2026-11-10T00:00:00Z',
      ...(stage === 'commit' ? { commitSha: 'b'.repeat(40) } : {}), ...overrides,
    });
  const records = async () => {
    const state = await service.replay();
    return new Map(Object.values(state.records.receipts).map(row => {
      const r = JSON.parse(restoreProtectedReceipt(row, 'fixture', 'lifecycle', encryptionKey).toString());
      return [r.id, r];
    }));
  };
  return { service, git, issue, source, signer, records, store };
}

test('LifeOS lifecycle persists and publicly verifies source, commit, build, deployment and rollback without SQL/billing', async t => {
  const f = await fixture(t);
  const a = await f.issue('source-write');
  const c = await f.issue('commit', [a.id]);
  const b = await f.issue('build', [c.id]);
  const d = await f.issue('deployment', [b.id]);
  const r = await f.issue('rollback', [d.id, b.id]);
  for (const receipt of [a,c,b,d,r]) {
    assert.equal(receipt.metadata, null);
    assert.equal(receipt.lifecycleEvidence.payload.artifactSha256, f.source.fileHash);
    const result = await f.git.getPublicLifecycleEvidence(receipt.id);
    assert.equal(result.verified, true);
    assert.equal(result.parentsVerified, true);
    assert.equal(result.modelAttribution, 'UNKNOWN');
    assert.equal(JSON.stringify(result).includes('DO_NOT_PUBLISH_PRIVATE_METADATA'), false);
    assert.equal(JSON.stringify(result).includes('userId'), false);
  }
  const state = await f.service.replay();
  assert.equal(Object.keys(state.records.receipts).length, 5);
  assert.equal(Object.keys(state.records.subscriptions).length, 0);
  // A fresh adapter reconstructs evidence from signed Git, not process-local state.
  assert.equal((await f.store('owner').getPublicLifecycleEvidence(r.id)).verified, true);
});

test('stage, artifact, model, project, receipt and parent metadata tampering fails verification', async t => {
  const f = await fixture(t);
  const a = await f.issue('source-write', [], { model: { name: 'observed', provider: 'fixture' } });
  const c = await f.issue('commit', [a.id]);
  const rows = await f.records();
  for (const field of ['stage','artifactSha256','project','entryHash','model','parents']) {
    const changed = structuredClone(rows.get(c.id));
    changed.metadata.lifecycleEvidence.payload[field] = field === 'parents' ? [] : field === 'model'
      ? { name: 'fabricated', provider: 'fabricated' } : 'tampered';
    assert.throws(() => verifyLifecycleEnvelope(changed));
  }
  const alteredParent = structuredClone(rows.get(a.id));
  alteredParent.metadata.lifecycleEvidence.payload.observedAt = '2026-11-11T00:00:00Z';
  rows.set(a.id, alteredParent);
  assert.throws(() => verifyLifecycleGraph(c.id, id => rows.get(id)));
});

test('issuance rejects cross-account/project parents, wrong stages and wrong deployed artifacts atomically', async t => {
  const f = await fixture(t), a = await f.issue('source-write');
  const c = await f.issue('commit', [a.id]), b = await f.issue('build', [c.id]);
  const before = Object.keys((await f.service.replay()).records.receipts).length;
  await assert.rejects(f.issue('commit', [a.id], { project: 'different/project' }));
  await assert.rejects(f.issue('commit', [a.id], {}, f.store('other'), { ...f.source, userId: 'other' }));
  await assert.rejects(f.issue('build', [a.id]));
  await assert.rejects(f.issue('commit', [a.id, a.id]));
  await assert.rejects(f.issue('deployment', [b.id], {}, f.git, { ...f.source, fileHash: 'c'.repeat(64) }));
  await assert.rejects(f.issue('build', [c.id], { commitSha: 'c'.repeat(40) }));
  await assert.rejects(f.issue('source-write', [], {}, f.git, { ...f.source, fileHash: 'not-a-sha256' }));
  await assert.rejects(f.issue('rollback', [b.id]));
  assert.equal(Object.keys((await f.service.replay()).records.receipts).length, before);
});

test('ordinary origin receipts remain unchanged; forged metadata cannot become a lifecycle proof', async t => {
  const f = await fixture(t);
  const old = await f.git.issueAttestationWithSigner(f.source, f.signer, 'original-request-1', async () => {});
  assert.equal(old.lifecycleEvidence, undefined);
  assert.equal(await f.git.getPublicLifecycleEvidence(old.id), undefined);
  const fake = await f.git.issueAttestationWithSigner({ ...f.source, metadata: { lifecycleEvidence: { forged: true } } },
    f.signer, 'original-request-2', async () => {});
  await assert.rejects(f.git.getPublicLifecycleEvidence(fake.id));
  await assert.rejects(f.git.issueAttestationWithSigner(f.source, f.signer, 'original-request-3', undefined,
    { project: 'fixture/project', stage: 'source-write', parents: [], observedAt: '2026-11-10T00:00:00Z' }));
});
