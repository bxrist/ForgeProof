import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { GitHubAppStateService, GitHubCredentialVault, GitHubTransport } from '../server/git-store/github-store.mjs';

// Minimal in-memory emulation of the GitHub Git Data API (non-forced ref CAS).
function fakeGitHub() {
  const calls = [];
  const objects = new Map(); const refs = new Map(); let n = 0;
  const id = s => createHash('sha1').update(s).digest('hex');
  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  const request = async (path, init = {}) => {
    const p = path.replace('/repos/o/r', ''); const method = init.method ?? 'GET';
    calls.push({ method, path: p });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (method === 'POST' && p === '/git/blobs') {
      const bytes = Buffer.from(body.content, 'base64');
      const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      objects.set(sha, { type: 'blob', content: bytes.toString('base64') }); return json(201, { sha });
    }
    if (method === 'POST' && p === '/git/trees') { const sha = id('t' + n++); objects.set(sha, { type: 'tree', tree: body.tree }); return json(201, { sha }); }
    if (method === 'POST' && p === '/git/commits') { const sha = id('c' + n++); objects.set(sha, { type: 'commit', tree: body.tree, parents: body.parents }); return json(201, { sha }); }
    if (method === 'POST' && p === '/git/refs') { if (refs.has(body.ref)) return json(422, {}); refs.set(body.ref, body.sha); return json(201, {}); }
    let m;
    if ((m = /^\/git\/refs?\/(.+)$/.exec(p))) {
      const ref = 'refs/' + decodeURIComponent(m[1]);
      if (method === 'PATCH') {
        const cur = refs.get(ref); const c = objects.get(body.sha);
        if (!cur || !c.parents.includes(cur)) return json(422, {});
        refs.set(ref, body.sha); return json(200, {});
      }
      if (!refs.has(ref)) return json(404, {});
      return json(200, { ref, object: { type: 'commit', sha: refs.get(ref) } });
    }
    if ((m = /^\/git\/(commits|trees|blobs)\/([a-f0-9]+)$/.exec(p))) {
      const o = objects.get(m[2]); if (!o) return json(404, {});
      if (m[1] === 'commits') return json(200, { sha: m[2], tree: { sha: o.tree }, parents: o.parents.map(sha => ({ sha })) });
      if (m[1] === 'trees') return json(200, { sha: m[2], truncated: false, tree: o.tree });
      return json(200, { sha: m[2], encoding: 'base64', content: o.content });
    }
    return json(404, {});
  };
  return { request, refs, calls, objects };
}

async function coldFixture() {
  const gh = fakeGitHub();
  const keys = generateKeyPairSync('ed25519');
  const signer = { actor: 'app', keyId: 'k', sign: async b => sign(null, b, keys.privateKey).toString('base64') };
  const trust = { eventKeys: { k: { actor: 'app', publicKey: keys.publicKey.export({type:'spki',format:'pem'}) } }, receiptKeys: [], receiptPredecessor: null };
  const transport = new GitHubTransport({owner:'o',repo:'r',request:gh.request});
  const options = {transport, tenant:'t', repository:'s', trust, checkpoint:null, readCacheMs:0};
  const writer = new GitHubAppStateService({...options, signer});
  let first;
  for (let i=1;i<=9;i++) {
    const result = await writer.append({idempotencyKey:`event-${i}`,operations:[
      {kind:'users',id:`u${i}`,action:'put',expectedVersion:null,record:{id:`u${i}`}},
    ]});
    first ??= result.checkpoint;
  }
  gh.calls.length=0;
  return {gh,options:{...options,checkpoint:first},transport};
}

test('immutable GETs retry transient upstream errors, but never writes or permanent failures', async () => {
  let calls=0;
  const transport=new GitHubTransport({owner:'o',repo:'r',request:async()=>{
    calls++; return new Response('{}',{status:calls<3?503:200});
  }});
  assert.equal((await transport.call('/git/commits/abc')).status,200);
  assert.equal(calls,3);
  calls=0;
  assert.equal((await transport.call('/git/commits','POST',{})).status,503);
  assert.equal(calls,1);
  calls=0;
  transport.request=async()=>{calls++;return new Response('{}',{status:403});};
  assert.equal((await transport.call('/git/commits/abc')).status,403);
  assert.equal(calls,1);
  calls=0;
  transport.request=async()=>{calls++;return new Response('{}',{status:503});};
  assert.equal((await transport.call('/git/commits/abc')).status,503);
  assert.equal(calls,3,'persistent errors stop after three attempts');
});

test('cold replay overlaps bounded GETs but applies verified events oldest first', async () => {
  const {gh,options,transport} = await coldFixture();
  let active=0, maximum=0;
  transport.request=async(path,init)=>{
    active++; maximum=Math.max(maximum,active);
    try {
      await new Promise(resolve=>setTimeout(resolve,path.includes('/trees/')?20:2));
      return await gh.request(path,init);
    } finally { active--; }
  };
  const reader = new GitHubAppStateService(options);
  const state = await reader.replay();
  assert.ok(maximum>1,'cold fetches actually overlap');
  assert.ok(maximum<=4,'no more than four Git requests in flight');
  assert.equal(active,0);
  assert.equal(gh.calls.length,28,'one ref plus three GETs per event, no duplicate loads');
  assert.ok(gh.calls.every(c=>c.method==='GET'));
  assert.deepEqual(state.events.map(e=>e.body.sequence),[1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(Object.keys(state.records.users),Array.from({length:9},(_,i)=>`u${i+1}`));
  gh.calls.length=0;
  await reader.replay();
  assert.equal(gh.calls.length,1,'warm replay retains verified-head fast path');
});

test('prefetch failures and corrupted content fail closed without advancing checkpoint', async () => {
  const {gh,options,transport} = await coldFixture();
  const pinned=structuredClone(options.checkpoint);
  const reader=new GitHubAppStateService(options);
  let corrupt=true, active=0;
  transport.request=async(path,init)=>{
    active++;
    try {
      await new Promise(resolve=>setTimeout(resolve,2));
      const response=await gh.request(path,init);
      if(corrupt && path.includes('/blobs/')) {
        const data=await response.json();
        data.content=Buffer.from('corrupt').toString('base64');
        return new Response(JSON.stringify(data),{status:200});
      }
      return response;
    } finally {active--;}
  };
  await assert.rejects(reader.replay(),/Git blob hash mismatch/);
  assert.equal(active,0,'failed replay drains prefetched reads');
  assert.deepEqual(reader.checkpoint,pinned);
  corrupt=false;
  assert.equal((await reader.replay()).events.length,9,'failed payload is retryable');
  const untrusted=new GitHubAppStateService({...options,trust:{...options.trust,eventKeys:{}}});
  await assert.rejects(untrusted.replay(),/Untrusted event signature/);
  const wrongPin=new GitHubAppStateService({...options,checkpoint:{...pinned,eventHash:'0'.repeat(64)}});
  await assert.rejects(wrongPin.replay(),/Checkpoint mismatch/);
});

test('GitHub-backed store appends, replays, rejects rewinds and serves custody CAS', async () => {
  const gh = fakeGitHub();
  const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const signer = { actor: 'app', keyId: 'k', sign: async b => sign(null, b, keys.privateKey).toString('base64') };
  const trust = { eventKeys: { k: { actor: 'app', publicKey: keys.publicKey } }, receiptKeys: [], receiptPredecessor: null };
  const transport = new GitHubTransport({ owner: 'o', repo: 'r', request: gh.request });
  const service = new GitHubAppStateService({ transport, tenant: 't', repository: 's', trust, checkpoint: null, signer, readCacheMs: 0 });
  const first = await service.append({ idempotencyKey: 'one', operations: [{ kind: 'users', id: 'u1', action: 'put', expectedVersion: null, record: { id: 'u1' } }] });
  assert.equal(gh.calls.length, 6, 'append uses six API calls, not nine');
  assert.equal(gh.calls.filter(c => c.method === 'GET').length, 2, 'fresh ref checked before and after publication');
  assert.equal(gh.calls.filter(c => c.method === 'GET' && /\/git\/(commits|trees|blobs)\//.test(c.path)).length, 0);
  await service.append({ idempotencyKey: 'two', operations: [{ kind: 'users', id: 'u2', action: 'put', expectedVersion: null, record: { id: 'u2' } }] });
  const dup = await service.append({ idempotencyKey: 'one', operations: [{ kind: 'users', id: 'u1', action: 'put', expectedVersion: null, record: { id: 'u1' } }] });
  assert.equal(dup.duplicate, true);
  // A fresh process pinned to the genesis checkpoint verifies the full chain.
  const reader = new GitHubAppStateService({ transport, tenant: 't', repository: 's', trust, checkpoint: first.checkpoint, readCacheMs: 0 });
  const state = await reader.replay();
  assert.deepEqual(Object.keys(state.records.users).sort(), ['u1', 'u2']);
  assert.equal(state.checkpoint.sequence, 2);
  // Concurrent writer: second instance must CAS-retry rather than overwrite.
  const other = new GitHubAppStateService({ transport, tenant: 't', repository: 's', trust, checkpoint: null, signer, readCacheMs: 0 });
  await Promise.all([
    service.append({ idempotencyKey: 'a', operations: [{ kind: 'users', id: 'a', action: 'put', expectedVersion: null, record: { id: 'a' } }] }),
    other.append({ idempotencyKey: 'b', operations: [{ kind: 'users', id: 'b', action: 'put', expectedVersion: null, record: { id: 'b' } }] }),
  ]);
  assert.equal(Object.keys((await reader.replay()).records.users).length, 4);
  // Rewind behind an observed head is rejected.
  gh.refs.set('refs/heads/forgeproof/t/s', first.checkpoint.commit);
  await assert.rejects(reader.replay(), /rewritten|behind|divergent/);
  // Credential vault CAS.
  const vault = new GitHubCredentialVault({ transport, prefix: 'vault/t' });
  assert.equal(await vault.transact('ns', e => ({ envelope: 'x1', result: e ?? null })), null);
  assert.equal(await vault.transact('ns', e => ({ envelope: 'x2', result: e })), 'x1');
});

test('write-through cache does not bypass signature verification or acknowledge a lost ref', async () => {
  const gh = fakeGitHub();
  const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const signer = { actor: 'app', keyId: 'k', sign: async b => sign(null, b, keys.privateKey).toString('base64') };
  const trust = { eventKeys: { k: { actor: 'app', publicKey: keys.publicKey } }, receiptKeys: [], receiptPredecessor: null };
  const transport = new GitHubTransport({ owner: 'o', repo: 'r', request: gh.request });
  const service = new GitHubAppStateService({ transport, tenant: 't', repository: 's', trust, checkpoint: null, signer, readCacheMs: 0 });
  const tx = { idempotencyKey: 'one', operations: [{ kind: 'users', id: 'u', action: 'put', expectedVersion: null, record: { id: 'u' } }] };
  const cas = transport.compareAndSwap.bind(transport);
  transport.compareAndSwap = async (...args) => {
    const accepted = await cas(...args);
    delete service.trust.eventKeys.k;
    return accepted;
  };
  await assert.rejects(service.append(tx), /Untrusted event signature/);
  service.trust = structuredClone(trust);
  await service.replay();
  transport.compareAndSwap = async (...args) => {
    const accepted = await cas(...args);
    gh.refs.delete(service.ref);
    return accepted;
  };
  await assert.rejects(service.append({ idempotencyKey: 'two', operations: [{ kind: 'users', id: 'v', action: 'put', expectedVersion: null, record: { id: 'v' } }] }), /Missing trusted history/);
});
