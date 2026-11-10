import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { GitAppStateService } from '../server/git-store/store.mjs';
import { GitStorage } from '../server/git-store/storage.ts';
import {verifyProtectedEmailCore,restoreQueuedEmail} from '../server/git-store/protected-email.mjs';

function git(dir, ...args) {
  return execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8' }).trim();
}

function signerAndTrust() {
  const keys = generateKeyPairSync('ed25519');
  const signer = { actor: 'test', keyId: 'test', sign: async data => sign(null, data, keys.privateKey).toString('base64') };
  const trust = {
    eventKeys: { test: { actor: 'test', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } },
    receiptKeys: [],
    receiptPredecessor: null,
  };
  return { signer, trust };
}

function makeService(root, tenant = 'tenant1', repository = 'repo1') {
  const bare = join(root, 'mail.git');
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '--bare', bare]);
  const { signer, trust } = signerAndTrust();
  return { service: new GitAppStateService({ directory: bare, tenant, repository, trust, checkpoint: null, signer }), bare, trust };
}

test('private pending email queue encrypts content and replays across clone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fp-mail-'));
  try {
    const { service, bare, trust } = makeService(root);
    await service.append({idempotencyKey:'bootstrap-synthetic-mail-owner',operations:[
      {kind:'users',id:'tenant1',action:'put',expectedVersion:null,
        record:{id:'tenant1',email:'fictional@example.invalid'}}
    ]});
    const key = randomBytes(32);
    const storage = new GitStorage(service, 'tenant1', ['tenant1'], 'tenant1', undefined, 'repo1', key);

    const created = await storage.createPendingEmail({
      to: 'alice@example.test',
      subject: 'Subject',
      bodyText: 'hello text',
      bodyHtml: '<p>hello html</p>',
      status: 'pending',
      retryCount: 0,
      nextRetryAt: new Date('2026-11-07T00:00:00.000Z'),
    });
    assert.equal(created.to, 'alice@example.test');

    const initialState = await service.replay();
    const initial = initialState.records.pendingEmails[created.id];
    const fakeMessage={...initial,id:created.id+1};
    await assert.rejects(service.append({
      idempotencyKey:'forged-reused-nonce',operations:[{
        kind:'pendingEmails',id:fakeMessage.id,action:'put',expectedVersion:null,record:fakeMessage
      }]
    }),/nonce reuse forbidden/);
    await assert.rejects(service.append({
      idempotencyKey:'forged-initial-sent',operations:[{
        kind:'pendingEmails',id:fakeMessage.id,action:'put',expectedVersion:null,
        record:{...fakeMessage,status:'sent',encryption:{...fakeMessage.encryption,nonce:randomBytes(12).toString('base64')}}
      }]
    }),/must begin pending with zero attempts/);
    await assert.rejects(service.append({
      idempotencyKey:'forged-initial-attempts',operations:[{
        kind:'pendingEmails',id:fakeMessage.id,action:'put',expectedVersion:null,
        record:{...fakeMessage,retryCount:3,encryption:{...fakeMessage.encryption,nonce:randomBytes(12).toString('base64')}}
      }]
    }),/must begin pending with zero attempts/);
    await assert.rejects(storage.updatePendingEmail(created.id,{to:'forged@example.invalid'}),/content immutable/);
    const due = await storage.getDuePendingEmails();
    assert.equal(due.length, 1);
    assert.equal(due[0].bodyHtml, '<p>hello html</p>');

    const log = git(bare, 'rev-parse', service.ref);
    const raw = git(bare, 'show', `${log}:event.json`);
    assert.equal(raw.includes('alice@example.test'), false);
    assert.equal(raw.includes('hello text'), false);
    assert.equal(raw.includes('<p>hello html</p>'), false);

    const clone = join(root, 'clone.git');
    execFileSync('git', ['clone', '--bare', bare, clone]);
    const restarted = new GitAppStateService({ directory: clone, tenant: 'tenant1', repository: 'repo1', trust, checkpoint: null, signer: undefined });
    const replayStorage = new GitStorage(restarted, 'tenant1', ['tenant1'], 'tenant1', undefined, 'repo1', key);
    const replayDue = await replayStorage.getDuePendingEmails();
    assert.equal(replayDue.length, 1);
    assert.equal(replayDue[0].to, 'alice@example.test');

    const wrongKey = new GitStorage(restarted, 'tenant1', ['tenant1'], 'tenant1', undefined, 'repo1', randomBytes(32));
    await assert.rejects(wrongKey.getDuePendingEmails(), /Decryption failed|Plaintext hash mismatch/);

    const replayState = await restarted.replay();
    assert.throws(()=>restoreQueuedEmail(replayState.records.pendingEmails[1],'different-tenant','repo1',key), /Decryption failed/);

    await storage.updatePendingEmail(created.id, { retryCount: 1, status: 'sent' });
    assert.equal((await storage.getDuePendingEmails()).length,0);
    await assert.rejects(storage.updatePendingEmail(created.id, { status: 'pending' }), /terminal status immutable/);
    const latest = await service.replay();
    await assert.rejects(service.append({idempotencyKey:'delete-queued-email',operations:[{
      kind:'pendingEmails',id:created.id,action:'delete',
      expectedVersion:latest.versions['pendingEmails/'+created.id]
    }]}),/Invalid deletion/);
    await assert.rejects(service.append({idempotencyKey:'restart-terminal-email',operations:[{
      kind:'pendingEmails',id:created.id,action:'put',
      expectedVersion:latest.versions['pendingEmails/'+created.id],
      record:{...latest.records.pendingEmails[created.id],status:'pending'}
    }]}),/terminal status immutable/);

    const noKey = new GitStorage(restarted, 'tenant1', ['tenant1'], 'tenant1');
    await assert.rejects(noKey.getDuePendingEmails(), /pending-email queue unavailable/);
    await assert.rejects(noKey.createPendingEmail({to:'a@example.invalid',subject:'x',bodyText:'x',bodyHtml:'<p>x</p>'}),/pending-email queue unavailable/);
    await assert.rejects(noKey.updatePendingEmail(created.id,{status:'sent'}),/pending-email queue unavailable/);

    const eventHash = git(bare, 'rev-parse', service.ref);
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });
    const eventText = git(bare, 'show', `${eventHash}:event.json`);
    const parsed = JSON.parse(eventText);
    const put = parsed.body.operations.find(o => o.kind === 'pendingEmails');
    put.record.encryption.ciphertext = Buffer.from('broken').toString('base64');
    assert.throws(()=>verifyProtectedEmailCore(put.record),/ciphertext hash mismatch/);
    const blob = await service.git(['hash-object','-w','--stdin'], JSON.stringify(parsed));
    const tree = await service.git(['mktree'], `100644 blob ${blob}\tevent.json\n`);
    const parent = await service.head();
    const commit = await service.git(['commit-tree', tree,'-p',parent], 'tamper\n');
    await service.git(['update-ref','--no-deref',service.ref,commit,parent]);
    const tampered = new GitAppStateService({ directory: bare, tenant: 'tenant1', repository: 'repo1', trust, checkpoint: null, signer: undefined });
    await assert.rejects(tampered.replay(), /signature|hash mismatch|invalid|Integrity|Untrusted|chain\/scope mismatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
