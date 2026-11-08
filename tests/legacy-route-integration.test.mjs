import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createStagingRepositoryApp } from '../server/stagingRepositoryRoutes.ts';
import { legacyStorageMethods, validateLegacyStorage } from '../server/storageContract.ts';
import { GitStorage } from '../server/git-store/storage.ts';

const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
function mock() {
  const calls = [];
  const rows = [{ id: 1, userId: 'alice', name: 'synthetic' }, { id: 2, userId: 'bob', name: 'other' }];
  const storage = Object.fromEntries(legacyStorageMethods.map(name => [name, async () => {
    throw new Error(`Unexpected legacy IStorage call: ${name}`);
  }]));
  storage.getRepositories = async id => { calls.push(['getRepositories', id]); return rows.filter(r => r.userId === id); };
  storage.getRepository = async id => { calls.push(['getRepository', id]); return rows.find(r => r.id === id); };
  storage.deleteRepository = async id => { calls.push(['deleteRepository', id]); rows.splice(rows.findIndex(r => r.id === id), 1); };
  storage.createAuditLog = async data => { calls.push(['createAuditLog', data]); return { id: 1, ...data }; };
  return { storage, calls };
}
function select(t) {
  const old = [process.env.NODE_ENV, process.env.FORGEPROOF_STORAGE];
  process.env.NODE_ENV = 'staging'; process.env.FORGEPROOF_STORAGE = 'legacy-route-staging';
  t.after(() => {
    for (const [i, name] of ['NODE_ENV', 'FORGEPROOF_STORAGE'].entries()) {
      if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i];
    }
  });
}
async function fixture(t) {
  select(t);
  const { storage, calls } = mock();
  const principals = { alice: publicKey };
  const app = createStagingRepositoryApp({ storage, principals });
  principals.mallory = publicKey; // cannot mutate trust after registration
  // Exercise Express's actual HTTP request/response stack without a listening socket.
  const base = 'http://127.0.0.1';
  const fetch = async (url, options = {}) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    req.method = options.method ?? 'GET'; req.url = url.slice(base.length);
    req.httpVersion = '1.0'; req.httpVersionMajor = 1; req.httpVersionMinor = 0;
    req.headers = { host: '127.0.0.1', ...options.headers };
    if (options.body) {
      req.headers['content-type'] = 'application/octet-stream';
      req.headers['content-length'] = String(Buffer.byteLength(options.body));
    }
    const res = new ServerResponse(req); res.assignSocket(socket);
    const done = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
    req.complete = true;
    app.handle(req, res);
    if (options.body) req.push(Buffer.from(options.body)); req.push(null);
    await done;
    const raw = Buffer.concat(chunks).toString();
    const split = raw.indexOf('\r\n\r\n');
    socket.destroy();
    return new Response(raw.slice(split + 4), { status: res.statusCode });
  };
  let sequence = 0;
  const headers = (method, path, { id = 'alice', time = String(Date.now()), nonce = `request-${++sequence}`, body = '' } = {}) => {
    const payload = JSON.stringify(['forgeproof-legacy-route-staging-v1', id, method, path, time, nonce, createHash('sha256').update(body).digest('hex')]);
    return { 'x-forgeproof-user': id, 'x-forgeproof-time': time, 'x-forgeproof-request': nonce, 'x-forgeproof-signature': sign(null, Buffer.from(payload), pair.privateKey).toString('base64') };
  };
  const request = (method, path, options) => fetch(base + path, { method, headers: headers(method, path, options) });
  return { base, calls, request, headers, fetch };
}

test('actual legacy list/delete handlers use injected store and enforce ownership with audit parity', async t => {
  const { request, calls } = await fixture(t);
  assert.deepEqual(await (await request('GET', '/api/repositories')).json(), [{ id: 1, userId: 'alice', name: 'synthetic' }]);
  assert.equal((await request('DELETE', '/api/repositories/no-id')).status, 400);
  assert.equal((await request('DELETE', '/api/repositories/99')).status, 404);
  assert.equal((await request('DELETE', '/api/repositories/2')).status, 403);
  assert.equal(calls.some(([name]) => name === 'deleteRepository' || name === 'createAuditLog'), false);
  const deleted = await request('DELETE', '/api/repositories/1');
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { message: 'Repository removed' });
  assert.deepEqual(calls.slice(-2), [['deleteRepository', 1], ['createAuditLog', { userId: 'alice', action: 'repository.deleted', resourceType: 'repository', resourceId: '1' }]]);
  assert.deepEqual(await (await request('GET', '/api/repositories')).json(), []);
});

test('signed fixture auth rejects unsigned, tampered, stale, replayed and unpinned principals before storage', async t => {
  const { base, request, headers, calls, fetch } = await fixture(t);
  assert.equal((await fetch(base + '/api/repositories')).status, 401);
  assert.equal((await request('GET', '/api/repositories', { id: 'mallory' })).status, 401);
  assert.equal((await request('GET', '/api/repositories', { time: String(Date.now() - 120000) })).status, 401);
  const signed = headers('GET', '/api/repositories');
  assert.equal((await fetch(base + '/api/repositories?tampered=1', { headers: signed })).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(base + '/api/repositories', { headers: signed })).status, 200);
  assert.equal((await fetch(base + '/api/repositories', { headers: signed })).status, 401);
  assert.equal(calls.length, 1);
  const mutation = headers('DELETE', '/api/repositories/1');
  assert.equal((await fetch(base + '/api/repositories/2', { method: 'DELETE', headers: mutation })).status, 401);
  assert.equal((await fetch(base + '/api/repositories/1', { method: 'DELETE', headers: mutation, body: 'tampered' })).status, 401);
});

test('staging exposes no signup, billing, Stripe webhook, email or GitHub provider route', async t => {
  const { request, calls } = await fixture(t);
  for (const path of ['/api/stripe/webhook', '/api/repositories', '/api/repositories/sync', '/api/login', '/api/subscription', '/api/checkout', '/api/v1/attest']) {
    assert.equal((await request('POST', path)).status, 404, path);
  }
  assert.equal(calls.length, 0);
});

test('staging selection and storage diagnostics fail closed; runtime contract tracks every IStorage method', t => {
  select(t);
  const options = { storage: mock().storage, principals: { alice: publicKey } };
  for (const env of ['production', 'development', 'test', '']) {
    process.env.NODE_ENV = env;
    assert.throws(() => createStagingRepositoryApp(options), /staging-only/);
  }
  process.env.NODE_ENV = 'staging'; delete process.env.FORGEPROOF_STORAGE;
  assert.throws(() => createStagingRepositoryApp(options), /staging-only/);
  process.env.FORGEPROOF_STORAGE = 'legacy-route-staging';
  assert.throws(() => createStagingRepositoryApp({ ...options, principals: {} }), /principals required/);
  const incomplete = { ...options.storage }; delete incomplete.createAuditLog; delete incomplete.resetAttestationCount;
  assert.throws(() => createStagingRepositoryApp({ ...options, storage: incomplete }), { message: 'Missing legacy IStorage methods: createAuditLog, resetAttestationCount' });
  const source = readFileSync(new URL('../server/storage.ts', import.meta.url), 'utf8').split('export interface IStorage {')[1].split('\n}')[0];
  assert.deepEqual(legacyStorageMethods, [...source.matchAll(/^  (\w+)\(/gm)].map(m => m[1]));
  // Shape parity alone cannot approve GitStorage's intentionally incompatible operations.
  validateLegacyStorage(GitStorage.prototype);
});

// Pinned to the supplied source SHA; detect changes to production provider paths.
test('default production registration and commerce/auth/email sources retain baseline bytes', () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(readFileSync(new URL('../server/index.ts', import.meta.url))), 'c1fb387ed0048e01af56e63d5a592651b7e4b4cfb0863c3d07928e8da227d319', 'server/index.ts');
  assert.equal(hash(readFileSync(new URL('../server/replit_integrations/auth/replitAuth.ts', import.meta.url))), '81e56441e8c16173bab2ea6d453527e282bd9843097d7fe82d148972130951e1', 'server/replit_integrations/auth/replitAuth.ts');
  assert.equal(hash(readFileSync(new URL('../server/stripe.ts', import.meta.url))), 'ac09974b5e93451f01d765f88eb0f9c4287fd0fcb063732384da18173d77e0b0', 'server/stripe.ts');
  assert.equal(hash(readFileSync(new URL('../server/webhookHandlers.ts', import.meta.url))), '1068171e4e76da340765e1fba5112f196a31815d9f81c22825d671ac2b562b0b', 'server/webhookHandlers.ts');
  assert.equal(hash(readFileSync(new URL('../server/email.ts', import.meta.url))), 'bf652403a52ef53fd98b1a89b6953f97a4a3cf6d03351e20281f8b14441c06e1', 'server/email.ts');
  assert.equal(hash(readFileSync(new URL('../server/storage.ts', import.meta.url))), '042337c47fcf62552e37e4f3e3a6bf5e6686d10b4178f433994621e345418422', 'server/storage.ts');
  const extracted = readFileSync(new URL('../server/repositoryRoutes.ts', import.meta.url), 'utf8');
  const list = extracted.slice(extracted.indexOf('  app.get('), extracted.indexOf('\n}'));
  const deletion = extracted.slice(extracted.indexOf('  app.delete('), extracted.lastIndexOf('\n}'));
  let routes = readFileSync(new URL('../server/routes.ts', import.meta.url), 'utf8');
  routes = routes.split('\n').slice(2).join('\n');
  routes = routes.replace('  registerRepositoryList(app, storage, uiLimiter, isAuthenticated);', list)
    .replace('  registerRepositoryDelete(app, storage, uiLimiter, isAuthenticated);', deletion)
    .replace('  app: Express,\n  staging?: StagingRouteOptions', '  app: Express')
    .replace('  if (staging !== undefined) {\n    registerStagingRepositoryRoutes(app, staging);\n    return httpServer;\n  }\n', '');
  assert.equal(hash(routes), '2fe6721362592f922338c18e7c578a11d94dfb6b2b0d6e5cba27fbec0bc4ca5a');
});
