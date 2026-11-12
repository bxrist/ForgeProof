import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { createServer } from 'node:http';
import { GitAppStateService } from '../server/git-store/store.mjs';
import { GitStorage } from '../server/git-store/storage.ts';
import { EncryptedProviderCustodian } from '../server/git-store/custody.ts';
import { bindExistingLifeosProject, loadLifeosGitBinding } from '../server/lifeosBinding.ts';
import { installApplicationStorage, requestStorageScope, setVerifiedStoragePrincipal } from '../server/storageBackend.ts';
import { proveLifeosControl, requireLifeosProject } from '../server/lifeosEntitlement.ts';
import { registerRoutes } from '../server/routes.ts';

test('real Git-scoped LifeOS bearer authorization and protected owner binding preserve existing state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeproof-lifeos-binding-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', directory], { stdio: 'ignore' });
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  process.env.NODE_ENV = 'production';
  process.env.FORGEPROOF_ED25519_PRIVATE_KEY_PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.FORGEPROOF_ED25519_PUBLIC_KEY_PIN = publicKey;
  delete process.env.LIFEOS_OWNER_APPROVAL_JSON;
  delete process.env.LIFEOS_OWNER_APPROVAL_FILE;
  const service = new GitAppStateService({
    directory, tenant: 'fixture', repository: 'app', checkpoint: null,
    trust: { eventKeys: { fixture: { actor: 'fixture', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) } },
      receiptKeys: [publicKey], receiptPredecessor: null },
    signer: { actor: 'fixture', keyId: 'fixture', sign: async bytes => sign(null, bytes, pair.privateKey).toString('base64') },
  });
  const values = new Map();
  let vaultWrites = 0;
  const vault = { async transact(scope, change) {
    const before = values.get(scope), next = change(before);
    if (next.envelope !== before) { values.set(scope, next.envelope); vaultWrites++; }
    return next.result;
  }};
  const custody = new EncryptedProviderCustodian(vault, randomBytes(32));
  const token = 'synthetic-fixture-bearer-not-production';
  const verifier = createHash('sha256').update(token).digest('hex');
  const ref = await custody.stage('fixture:app', 'fixture-key', { kind: 'api-key', verifier, prefix: 'fixture' });
  const subject = 'lifeos-service-0a', members = ['fixture-owner', subject, 'fixture-other'];
  const key = { id: 1, userId: subject, name: 'fixture', credentialRef: ref, isActive: true,
    permissions: ['attest:write'], expiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null };
  await service.append({ idempotencyKey: 'bootstrap', operations: [
    ...members.map(id => ({ kind: 'users', id, action: 'put', expectedVersion: null, record: { id } })),
    { kind: 'apiKeys', id: 1, action: 'put', expectedVersion: null, record: key },
  ]});
  const resources = { service, custody, settings: { tenant: 'fixture', stream: 'app', guardUserId: 'fixture-owner' },
    material: { mailEncryptionKey: randomBytes(32), auditEncryptionKey: randomBytes(32), receiptEncryptionKey: randomBytes(32) } };
  const store = id => new GitStorage(service, id, members, 'fixture-owner', custody, 'fixture:app',
    resources.material.mailEncryptionKey, resources.material.auditEncryptionKey, resources.material.receiptEncryptionKey);
  installApplicationStorage(id => store(id ?? 'fixture-owner'));
  assert.equal(await store('fixture-owner').getApiKeyByHash(verifier), undefined); // reproduces old ordering failure
  const original = await service.replay();
  const { auditId } = await bindExistingLifeosProject(resources, 'fixture/project', 'explicit-fixture-owner-authorization');
  process.env.LIFEOS_OWNER_APPROVAL_AUDIT_ID = String(auditId);
  assert.equal(await loadLifeosGitBinding(resources, await service.replay()), true);
  assert.deepEqual(await bindExistingLifeosProject(resources, 'fixture/project', 'explicit-fixture-owner-authorization'), { auditId });
  const after = await service.replay();
  for (const kind of ['receipts', 'apiKeys', 'subscriptions', 'users']) assert.deepEqual(after.records[kind], original.records[kind]);
  assert.equal(JSON.stringify(after).includes(verifier), false);
  assert.equal(JSON.stringify([...values.values()]).includes(verifier), false);

  const app = express();
  app.use(express.json());
  // Signed-out Clerk request fixture; no live account, token or provider call.
  app.use((req, _res, next) => {
    req.auth = Object.assign(() => ({ userId: null, tokenType: 'session_token' }),
      { [Symbol.for('@clerk/express.auth')]: true });
    next();
  });
  app.use((req, _res, next) => requestStorageScope(() => {
    if (req.headers['x-fixture-subject']) setVerifiedStoragePrincipal(String(req.headers['x-fixture-subject']));
    next();
  }));
  await registerRoutes(createServer(app), app);
  const eventCount = after.events.length, writesBeforeReads = vaultWrites;
  const auth = await supertest(app).get('/api/lifeos/authorization').set('Authorization', `Bearer ${token}`);
  assert.equal(auth.status, 200);
  assert.deepEqual(auth.body, { authorized: true, projects: ['fixture/project'], lifecycleEnabled: true });
  assert.equal(auth.text.includes(verifier), false);
  assert.equal(auth.text.includes(token), false);
  for (const authorization of ['', 'Bearer invalid-fixture-key', 'Basic invalid']) {
    assert.equal((await supertest(app).get('/api/lifeos/authorization').set('Authorization', authorization)).status, 403);
  }
  assert.equal((await supertest(app).get('/api/lifeos/authorization').set('Authorization', `Bearer ${token}`)
    .set('x-fixture-subject', 'fixture-other')).status, 403);
  await requestStorageScope(async () => {
    const proof = await proveLifeosControl(`Bearer ${token}`);
    assert.doesNotThrow(() => requireLifeosProject(proof, 'fixture/project'));
    assert.throws(() => requireLifeosProject(proof, 'unapproved/project'));
  });
  for (const route of ['/api/billing/checkout', '/api/billing/portal', '/api/v1/attest'])
    assert.equal((await supertest(app).post(route).set('Authorization', `Bearer ${token}`).send({})).status, 403);
  assert.equal((await service.replay()).events.length, eventCount);
  assert.equal(vaultWrites, writesBeforeReads);

  // Startup diagnostics must distinguish predicates/provider failures without
  // exposing provider exception text, custody references or verifier material.
  const diagnostics = [];
  const report = diagnostic => diagnostics.push(diagnostic);
  const state = await service.replay();
  const failingCustody = { ...resources, custody: {
    recoverLifeosApproval: async () => { throw new Error(`protected-provider-detail:${verifier}`); },
  }};
  assert.equal(await loadLifeosGitBinding(failingCustody, state, report), false);
  assert.deepEqual(diagnostics.pop(), { category: 'custody_read', exception: true });
  const badPermissions = structuredClone(state);
  badPermissions.records.apiKeys[1].permissions = ['attest:write', 'extra'];
  assert.equal(await loadLifeosGitBinding(resources, badPermissions, report), false);
  assert.deepEqual(diagnostics.pop(), { category: 'key_permissions', exception: false });
  assert.equal((await supertest(app).get('/api/lifeos/authorization').set('Authorization', `Bearer ${token}`)).status, 403);
  process.env.LIFEOS_OWNER_APPROVAL_JSON = '{}';
  process.env.LIFEOS_OWNER_APPROVAL_FILE = '/obsolete/unreadable-approval.json';
  assert.equal(await loadLifeosGitBinding(resources, state, report), true);
  assert.equal(diagnostics.length, 0);
  assert.equal((await supertest(app).get('/api/lifeos/authorization').set('Authorization', `Bearer ${token}`)).status, 200);
  assert.equal((await supertest(app).get('/api/lifeos/authorization').set('Authorization', 'Bearer invalid')).status, 403);
  // Invalid selectors still deny even with both legacy alternatives present.
  process.env.LIFEOS_OWNER_APPROVAL_AUDIT_ID = 'invalid';
  assert.equal(await loadLifeosGitBinding(resources, state, report), false);
  assert.deepEqual(diagnostics.pop(), { category: 'selector_invalid', exception: false });
  process.env.LIFEOS_OWNER_APPROVAL_AUDIT_ID = '999999';
  assert.equal(await loadLifeosGitBinding(resources, state, report), false);
  assert.deepEqual(diagnostics.pop(), { category: 'audit_missing', exception: false });
  assert.equal((await supertest(app).get('/api/lifeos/authorization').set('Authorization', `Bearer ${token}`)).status, 403);
  process.env.LIFEOS_OWNER_APPROVAL_AUDIT_ID = String(auditId);
  assert.equal(await loadLifeosGitBinding(resources, await service.replay()), true);
  assert.equal((await supertest(app).get('/api/lifeos/authorization').set('Authorization', `Bearer ${token}`)).status, 200);
  assert.equal(vaultWrites, writesBeforeReads);
  assert.equal((await service.replay()).events.length, eventCount);
  delete process.env.LIFEOS_OWNER_APPROVAL_JSON;
  delete process.env.LIFEOS_OWNER_APPROVAL_FILE;
  // Exercise the reconciled HTTP routes through real request-local principal
  // selection, protected custody and signed Git storage, never a live credential.
  const receiptIds = [];
  for (const stage of ['source-write', 'commit', 'build', 'deployment', 'rollback']) {
    const requestId = `fixture-keyed-${stage}`;
    const parents = stage === 'source-write' ? [] : stage === 'rollback'
      ? [receiptIds[3], receiptIds[2]] : [receiptIds.at(-1)];
    const body = {
      file_path: 'fixture/artifact.txt', file_hash: 'a'.repeat(64),
      model_name: 'UNSPECIFIED', model_provider: 'UNSPECIFIED', country_of_origin: 'UNSPECIFIED',
      signedAt: '2026-11-11T00:00:00.000Z',
      metadata: { privateSentinel: 'PRIVATE_HTTP_FIXTURE' },
      lifecycle: { project: 'fixture/project', stage, parents, observedAt: '2026-11-11T00:00:00Z',
        ...(stage === 'commit' ? { commitSha: 'b'.repeat(40) } : {}) },
    };
    const before = (await service.replay()).events.length;
    const post = () => supertest(app).post('/api/lifeos/attest')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', requestId).send(body);
    const first = await post();
    assert.equal(first.status, 201, first.text);
    assert.equal(first.body.lifecycleEvidence.payload.stage, stage);
    receiptIds.push(first.body.id);
    const retry = await post();
    assert.equal(retry.status, 201, retry.text);
    assert.deepEqual(retry.body, first.body);
    const status = await supertest(app).get(`/api/lifeos/attest/status/${requestId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.status, 200, status.text);
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.deepEqual(status.body, first.body);
    assert.equal(status.text.includes('PRIVATE_HTTP_FIXTURE'), false);
    assert.equal((await service.replay()).events.length, before + 1);
    assert.equal((await supertest(app).post('/api/lifeos/attest')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', requestId)
      .send({ ...body, lifecycle: { ...body.lifecycle, observedAt: '2026-11-11T00:01:00Z' } })).status, 409);
    assert.equal((await service.replay()).events.length, before + 1);
  }
  const recoveryPath = '/api/lifeos/attest/status/fixture-keyed-source-write';
  const beforeStatus = (await service.replay()).events.length;
  assert.equal((await supertest(app).get(recoveryPath)).status, 403);
  assert.equal((await supertest(app).get(recoveryPath).set('Authorization', `Bearer ${token}`)
    .set('x-fixture-subject', 'fixture-other')).status, 403);
  assert.equal((await supertest(app).get('/api/lifeos/attest/status/fixture-absent-key')
    .set('Authorization', `Bearer ${token}`)).status, 404);
  assert.equal((await service.replay()).events.length, beforeStatus);
  assert.equal(vaultWrites, writesBeforeReads);
  assert.deepEqual((await service.replay()).records.subscriptions, original.records.subscriptions);
  await store(subject).deleteApiKey(1, subject);
  assert.equal((await supertest(app).get('/api/lifeos/authorization').set('Authorization', `Bearer ${token}`)).status, 403);
  assert.equal((await supertest(app).get(recoveryPath).set('Authorization', `Bearer ${token}`)).status, 403);
});
