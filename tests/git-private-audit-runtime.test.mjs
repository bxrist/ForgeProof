import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { GitAppStateService } from '../server/git-store/store.mjs';
import { GitStorage } from '../server/git-store/storage.ts';
import { restoreProtectedAuditLog } from '../server/git-store/protected-audit.mjs';

test('runtime protected audit path seals metadata in signed Git and restores only with authorized key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forgeproof-audit-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dir = join(root, 'private.git');
  execFileSync('git', ['init', '--bare', dir], { stdio: 'ignore' });

  const keys = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const signer = {
    actor: 'test-audit-runtime',
    keyId: 'test-audit-runtime-signer',
    sign: async bytes => sign(null, bytes, keys.privateKey).toString('base64'),
  };

  const opts = {
    directory: dir,
    tenant: 'tenant-runtime-audit',
    repository: 'evidence',
    trust: {
      eventKeys: {
        'test-audit-runtime-signer': {
          actor: signer.actor,
          publicKey: keys.publicKey,
        },
      },
      receiptKeys: [],
      receiptPredecessor: null,
    },
    checkpoint: null,
    signer,
  };

  const service = new GitAppStateService(opts);
  const auditKey = randomBytes(32);
  const storage = new GitStorage(service, 'runtime-user', ['runtime-user'], 'runtime-user', undefined, '', undefined, auditKey);

  await service.append({idempotencyKey:'bootstrap-audit-user',operations:[{
    kind:'users',id:'runtime-user',action:'put',expectedVersion:null,
    record:{id:'runtime-user',email:'runtime-user@example.invalid'}
  }]});

  const sentinel = 'PRIVATE_AUDIT_RUNTIME_SENTINEL';
  const created = await storage.createAuditLog({
    userId: 'runtime-user',
    action: 'view',
    resourceType: 'fixture',
    resourceId: 'runtime-resource',
    metadata: { sentinel, nested: { n: 1 } },
    ipAddress: '127.0.0.1',
  });

  assert.equal(created.userId, 'runtime-user');
  assert.equal(created.action, 'view');
  assert.equal(created.resourceType, 'fixture');
  assert.equal(created.resourceId, 'runtime-resource');
  assert.equal(created.ipAddress, '127.0.0.1');
  assert.deepEqual(created.metadata, { sentinel, nested: { n: 1 } });

  const redacted = (await storage.getAuditLogs('runtime-user')).filter(r=>r.resourceType==='fixture');
  assert.equal(redacted.length, 1);
  assert.equal(redacted[0].metadata, null);
  assert.equal(redacted[0].resourceId, 'runtime-resource');

  const replay = await service.replay();
  const stored = replay.records.auditLogs[String(created.id)];
  assert.ok(stored);

  const originalBytes = restoreProtectedAuditLog(stored, opts.tenant, opts.repository, auditKey);
  assert.deepEqual(JSON.parse(originalBytes.toString('utf8')), {
    id: created.id,
    userId: 'runtime-user',
    action: 'view',
    resourceType: 'fixture',
    resourceId: 'runtime-resource',
    metadata: { sentinel, nested: { n: 1 } },
    ipAddress: '127.0.0.1',
    createdAt: created.createdAt.toISOString(),
  });

  const eventText = await service.git(['show', `${replay.checkpoint.commit}:event.json`]);
  assert.doesNotMatch(eventText, /PRIVATE_AUDIT_RUNTIME_SENTINEL/);

  assert.throws(
    () => restoreProtectedAuditLog(stored, opts.tenant, opts.repository, randomBytes(32)),
    /Decryption failed/
  );
  assert.throws(
    () => restoreProtectedAuditLog(stored, 'wrong-tenant', opts.repository, auditKey),
    /Decryption failed/
  );

  const clone = join(root, 'clone.git');
  execFileSync('git', ['clone', '--mirror', dir, clone], { stdio: 'ignore' });
  const readOnly = new GitAppStateService({ ...opts, directory: clone, checkpoint: replay.checkpoint, signer: undefined });
  const replayClone = await readOnly.replay();
  const cloneStored = replayClone.records.auditLogs[String(created.id)];
  assert.deepEqual(
    JSON.parse(restoreProtectedAuditLog(cloneStored, opts.tenant, opts.repository, auditKey).toString('utf8')),
    JSON.parse(originalBytes.toString('utf8'))
  );

  const noKeyStorage = new GitStorage(service, 'runtime-user', ['runtime-user'], 'runtime-user');
  await assert.rejects(
    noKeyStorage.createAuditLog({
      userId: 'runtime-user',
      action: 'view',
      resourceType: 'fixture',
      resourceId: 'runtime-resource-2',
      metadata: { sentinel: 'ANOTHER_SENTINEL' },
      ipAddress: null,
    }),
    /Private Git-backed audit metadata unavailable/
  );

  const plain = await noKeyStorage.createAuditLog({
    userId: 'runtime-user',
    action: 'view',
    resourceType: 'fixture',
    resourceId: 'runtime-resource-v1',
    metadata: null,
    ipAddress: null,
  });
  assert.equal(plain.metadata, null);
});
