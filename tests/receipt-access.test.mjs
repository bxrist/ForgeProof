import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as crypto from '../server/crypto.ts';
import * as access from '../server/receiptAccess.ts';

const issuer = 'https://replit.com/oidc';
const owner = (sub = 'owner') => ({ isAuthenticated: () => true, user: {
  claims: { sub, iss: issuer }, expires_at: Math.floor(Date.now() / 1000) + 600,
} });
const anonymous = () => ({ isAuthenticated: () => false });
const receipts = [
  ...Array.from({ length: 5 }, (_, i) => ({ id: 41 + i, userId: access.LIFEOS_SERVICE_ACCOUNT,
    fileName: `internal-${i}.ts`, filePath: `private/internal-${i}.ts`, entryHash: `hash-${i}`,
    prevEntryHash: i ? `hash-${i - 1}` : null, signature: 'recorded-signature', gitCommitUrl: null,
    modelName: 'recorded-model', modelProvider: 'recorded-provider', createdAt: new Date(0) })),
  { id: 50, userId: 'customer', fileName: 'customer.ts', filePath: 'customer.ts', entryHash: 'customer-hash', prevEntryHash: 'hash-0' },
  { id: 51, userId: 'forgeproof-system', fileName: 'demo.ts', filePath: 'demo.ts', entryHash: 'demo-hash' },
  { id: 52, userId: 'other', fileName: 'other.ts', filePath: 'other.ts', entryHash: 'other-hash' },
];
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
for (const [i, receipt] of receipts.entries()) {
  Object.assign(receipt, { fileHash: 'sha256:' + 'a'.repeat(64), modelName: 'recorded-model',
    modelProvider: 'recorded-provider', countryOfOrigin: 'US', signedAt: '2026-11-03T12:00:00.000Z',
    publicKey, prevEntryHash: i ? receipts[i - 1].entryHash : null });
  receipt.entryHash = crypto.computeEntryHash({ ...receipt, timestamp: receipt.signedAt });
  receipt.signature = sign(null, Buffer.from(`${receipt.entryHash}|${receipt.fileHash}|${receipt.signedAt}`), keys.privateKey).toString('base64');
}
const noop = (_req, _res, next) => next();
const source = readFileSync(new URL('../server/routes.ts', import.meta.url), 'utf8');

async function fixture() {
  const routes = new Map();
  const listCalls = [];
  const storage = {
    getAttestations: async (id, includeLifeos) => {
      listCalls.push({ id, includeLifeos });
      return receipts.filter(r => r.userId === id || r.userId === 'forgeproof-system'
        || (includeLifeos && access.isLifeosReceipt(r)));
    },
    getAttestation: async id => receipts.find(r => r.id === id),
    getAttestationByEntryHash: async hash => receipts.find(r => r.entryHash === hash),
    getAttestationsByParentId: async () => [receipts[0], receipts[6], receipts[7]],
    getAllAttestationsOrdered: async () => receipts,
  };
  const exported = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: exported, process, console,
    require: name => {
      if (name === './receiptAccess') return access;
      if (name === './storage') return { storage };
      if (name === 'express-rate-limit') return { default: () => noop };
      if (name === './httpSecurity') return { createUiLimiter: () => noop };
      if (name.includes('replitAuth')) return { setupAuth: async () => {}, isAuthenticated: (req, res, next) => req.isAuthenticated() ? next() : res.status(401).json({}) };
      if (name === './crypto') return crypto;
      return {};
    },
  });
  const app = { use() {} };
  for (const method of ['get', 'post', 'delete', 'patch', 'put']) app[method] = (path, ...handlers) => routes.set(`${method} ${path}`, handlers);
  await exported.registerRoutes({}, app);
  return { listCalls, async call(path, req, params = {}, query = {}) {
    Object.assign(req, { params, query });
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; },
      setHeader(name, value) { this.headers[name] = value; } };
    for (const handler of routes.get(`get ${path}`)) {
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next) break;
    }
    return res;
  } };
}

test('LifeOS owner binding and route isolation', async t => {
  const saved = { serverIssuer: process.env.ISSUER_URL, sub: process.env.FORGEPROOF_LIFEOS_OWNER_SUB, issuer: process.env.FORGEPROOF_LIFEOS_OWNER_ISSUER };
  t.after(() => {
    for (const [key, value] of [['FORGEPROOF_LIFEOS_OWNER_SUB', saved.sub], ['FORGEPROOF_LIFEOS_OWNER_ISSUER', saved.issuer], ['ISSUER_URL', saved.serverIssuer]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.ISSUER_URL = issuer;
  delete process.env.FORGEPROOF_LIFEOS_OWNER_SUB;
  delete process.env.FORGEPROOF_LIFEOS_OWNER_ISSUER;
  assert.equal(access.canReadLifeosReceipts(owner()), false);
  process.env.FORGEPROOF_LIFEOS_OWNER_SUB = 'owner';
  assert.equal(access.canReadLifeosReceipts(owner()), false);
  process.env.FORGEPROOF_LIFEOS_OWNER_ISSUER = issuer;
  assert.equal(access.canReadLifeosReceipts(owner()), true);
  for (const req of [anonymous(), owner('customer'), { ...owner(), user: { id: 'owner', email: 'admin@example.com', role: 'admin' } },
    { ...owner(), user: { ...owner().user, expires_at: 1 } },
    { ...owner(), user: { ...owner().user, claims: { sub: 'owner', iss: 'https://evil.invalid' } } }]) {
    assert.equal(access.canReadLifeosReceipts(req), false);
  }
  const f = await fixture();
  const list = await f.call('/api/attestations', owner(), {}, { userId: 'other', includeLifeos: 'true' });
  assert.deepEqual(Array.from(list.body, r => r.id), [41, 42, 43, 44, 45, 51]);
  const customer = await f.call('/api/attestations', owner('customer'), {}, { userId: 'owner', includeLifeos: 'true' });
  assert.deepEqual(Array.from(customer.body, r => r.id), [50, 51]);
  assert.deepEqual(f.listCalls, [{ id: 'owner', includeLifeos: true }, { id: 'customer', includeLifeos: false }]);
  assert.equal((await f.call('/api/attestations', anonymous())).statusCode, 401);
  for (const id of [41, 42, 43, 44, 45]) {
    const detail = await f.call('/api/attestations/:id', owner(), { id: String(id) });
    assert.equal(detail.body.signature, receipts[id - 41].signature);
    assert.equal(detail.body.gitCommitUrl, null);
    assert.equal(detail.body.modelName, 'recorded-model');
    assert.ok(!detail.body.childAttestations.some(r => r.userId === 'other'));
    assert.equal((await f.call('/api/attestations/:id', owner('customer'), { id: String(id) })).statusCode, 404);
  }
  for (const req of [anonymous(), owner('customer')]) {
    for (const q of ['41', receipts[0].entryHash]) {
      const lookup = await f.call('/api/lookup', req, {}, { q });
      assert.equal(lookup.body.id, 41);
      assert.equal(lookup.body.signatureValid, true);
      assert.equal(lookup.body.hashMatch, true);
      assert.equal(lookup.headers['Cache-Control'], undefined);
    }
    const ledger = await f.call('/api/verify/chain', req);
    assert.deepEqual(Array.from(ledger.body.entries, r => r.id), receipts.map(r => r.id));
    assert.equal(ledger.body.chainIntegrity, true);
    for (const id of [41, 42, 43, 44, 45]) {
      assert.equal((await f.call('/api/verify/entry/:id', req, { id: String(id) })).body.signatureValid, true);
    }
    assert.equal((await f.call('/api/analytics', req)).body.total, receipts.length);
    const badge = await f.call('/api/badge/:id.svg', req, { id: '41' });
    assert.equal(badge.statusCode, 200);
    assert.equal(badge.headers['Cache-Control'], 'no-cache');
    const repoBadge = await f.call('/api/badge/repo/:repoName.svg', req, { repoName: 'private/internal' });
    assert.ok(repoBadge.body.includes('5 attestations'));
    assert.equal(repoBadge.headers['Cache-Control'], 'no-cache');
    const lineage = await f.call('/api/v1/attestation/:id/chain', req, { id: '41' });
    assert.equal(lineage.statusCode, 200);
  }
  const demo = await f.call('/api/demo/attestations/:id', anonymous(), { id: '51' });
  assert.equal(demo.statusCode, 200);
  assert.equal((await f.call('/api/attestations/:id', owner('customer'), { id: '51' })).statusCode, 200);
  const publicEntry = await f.call('/api/verify/entry/:id', anonymous(), { id: '42' });
  assert.equal(publicEntry.body.prevEntry.id, 41);
  process.env.FORGEPROOF_LIFEOS_OWNER_SUB = 'replacement-owner';
  assert.equal((await f.call('/api/attestations/:id', owner(), { id: '41' })).statusCode, 404);
  assert.equal((await f.call('/api/lookup', anonymous(), {}, { q: '41' })).body.id, 41);
  const signature = receipts[0].signature;
  try {
    receipts[0].signature = 'AAAA';
    const ledger = await f.call('/api/verify/chain', anonymous());
    assert.equal(ledger.body.chainIntegrity, false);
    assert.equal(ledger.body.entries[0].signatureValid, false);
    assert.equal(ledger.body.entries.length, receipts.length);
  } finally { receipts[0].signature = signature; }

});

test('storage constrains the database query to the caller, demos, and explicit LifeOS grant', async () => {
  const schema = await import('../shared/schema.ts');
  const operators = await import('drizzle-orm');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  let predicate;
  const exported = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../server/storage.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: exported, require: name => {
    if (name === '@shared/schema') return schema;
    if (name === './receiptAccess') return access;
    if (name === 'drizzle-orm') return operators;
    if (name === './db') return { db: { select: () => ({ from: () => ({ where: value => {
      predicate = value;
      return { orderBy: async () => [] };
    } }) }) } };
    return {};
  } });
  const storage = new exported.DatabaseStorage();
  await storage.getAttestations('customer');
  let query = new PgDialect().sqlToQuery(predicate);
  assert.deepEqual(query.params, ['customer', 'forgeproof-system']);
  assert.doesNotMatch(query.sql, /1\s*=\s*1/);
  await storage.getAttestations('owner', true);
  query = new PgDialect().sqlToQuery(predicate);
  assert.deepEqual(query.params, ['owner', 'forgeproof-system', 'lifeos-service-0a']);
});

test('MCP lookup and chain preserve complete public ledger verification', async () => {
  const exported = {};
  const storage = {
    getAttestation: async id => receipts.find(r => r.id === id),
    getAttestationByEntryHash: async hash => receipts.find(r => r.entryHash === hash),
    getAllAttestationsOrdered: async () => receipts,
    createAttestation: async () => { throw new Error('Unexpected write'); },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../server/mcp.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: exported, require: name => {
    if (name === './receiptAccess') return access;
    if (name === './storage') return { storage };
    if (name === './crypto') return crypto;
    return {};
  } });
  for (const query of ['41', receipts[0].entryHash]) {
    const result = await exported.handleMcpTool('forgeproof_lookup', { query }, 'owner');
    assert.equal(result.found, true);
  }
  const chain = await exported.handleMcpTool('forgeproof_verify_chain', {}, 'owner');
  assert.deepEqual(Array.from(chain.entries, r => r.id), receipts.map(r => r.id));
  assert.equal(chain.chain_integrity, true);
  const signature = receipts[0].signature;
  try {
    receipts[0].signature = 'AAAA';
    const invalid = await exported.handleMcpTool('forgeproof_verify_chain', {}, 'customer');
    assert.equal(invalid.chain_integrity, false);
    assert.equal(invalid.entries[0].signature_valid, false);
    assert.equal(invalid.entries.length, receipts.length);
  } finally { receipts[0].signature = signature; }
});
