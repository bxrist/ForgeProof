import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import rateLimit from 'express-rate-limit';
import { createTransportRateLimitKey, createUiLimiter, issueCsrfToken, requireSessionCsrf, sessionCsrfProtection, transportRateLimitKey } from '../server/httpSecurity.ts';
import { verifyGitHubWebhookSignature } from '../server/security.ts';

async function fixture(t, limit = 100) {
  const app = express();
  app.set('trust proxy', 1); // existing production setting; UI uses separate safe keys
  app.use(express.json({ verify: (req, _res, body) => { req.rawBody = body; } }));
  app.use(session({ secret: 'local-test-session-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.isAuthenticated = () => !!req.session.loggedIn;
    if (req.isAuthenticated()) req.user = { claims: { sub: 'test-user' } };
    next();
  });
  app.use(sessionCsrfProtection);
  app.get('/api/csrf-token', issueCsrfToken);
  app.get('/login', (req, res) => { req.session.loggedIn = true; res.sendStatus(200); });
  const uiLimiter = createUiLimiter(limit);
  app.post('/api/preferences', uiLimiter, (_req, res) => res.sendStatus(204));
  app.post('/api/v1/attest', (req, res, next) => {
    if (req.get('authorization') === 'Bearer valid-test-key') return res.sendStatus(204);
    if (!req.isAuthenticated()) return res.sendStatus(401);
    requireSessionCsrf(req, res, next);
  }, (_req, res) => res.sendStatus(204));
  app.post('/api/v1/agents/openai', (req, res) => res.sendStatus(req.get('authorization') === 'Bearer valid-test-key' ? 204 : 401));
  app.post('/api/github/webhook', (req, res) => res.sendStatus(
    verifyGitHubWebhookSignature(req.rawBody, req.get('x-hub-signature-256'), 'local-webhook-test-secret') ? 204 : 401));
  app.get('/limited', createUiLimiter(limit), (req, res) => res.json({ key: transportRateLimitKey(req) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { ...(cookie ? { cookie } : {}), ...options.headers } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  await request('/login');
  return { request, base };
}

test('session token issuance, reuse, valid mutation and rejected missing/invalid tokens and origins', async t => {
  const { request, base } = await fixture(t);
  const issued = await request('/api/csrf-token');
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const { csrfToken } = await issued.json();
  assert.match(csrfToken, /^[a-f0-9]{64}$/);
  assert.equal((await (await request('/api/csrf-token')).json()).csrfToken, csrfToken);
  for (const path of ['/api/preferences', '/api/v1/attest']) {
    for (const token of [undefined, 'bad', '0'.repeat(64)]) {
      const res = await request(path, { method: 'POST', headers: token ? { 'x-csrf-token': token } : {} });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, 'CSRF_INVALID');
    }
    assert.equal((await request(path, { method: 'POST', headers: { 'x-csrf-token': csrfToken, origin: base } })).status, 204);
    for (const headers of [{ origin: 'https://attacker.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await request(path, { method: 'POST', headers: { 'x-csrf-token': csrfToken, ...headers } })).status, 403);
    }
  }
});

test('Bearer boundary never allows a header to bypass session CSRF; independent agent auth and signed webhooks work', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/preferences', { method: 'POST', headers: { authorization: 'Bearer valid-test-key' } })).status, 403);
  for (const path of ['/api/v1/attest', '/api/v1/agents/openai']) {
    assert.equal((await request(path, { method: 'POST', headers: { authorization: 'Bearer valid-test-key' } })).status, 204);
    assert.equal((await request(path, { method: 'POST', headers: { authorization: 'Bearer invalid' } })).status, path.endsWith('attest') ? 403 : 401);
  }
  const body = '{"event":"push"}';
  const signature = 'sha256=' + createHmac('sha256', 'local-webhook-test-secret').update(body).digest('hex');
  assert.equal((await request('/api/github/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } })).status, 204);
  assert.equal((await request('/api/github/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 401);
});

test('UI limiter returns 429 and Retry-After despite changing forwarded IP addresses', async t => {
  const { request } = await fixture(t, 2);
  for (let i = 0; i < 2; i++) assert.equal((await request('/limited', { headers: { 'x-forwarded-for': `192.0.2.${i + 1}` } })).status, 200);
  const blocked = await request('/limited', { headers: { 'x-forwarded-for': '198.51.100.1' } });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
});


test('forwarding trusts only explicit ingress IPs and stops at the nearest untrusted hop', () => {
  const key = createTransportRateLimitKey(['127.0.0.1']);
  const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, get: () => forwarded });
  assert.equal(key(request('127.0.0.1', '192.0.2.1')), '192.0.2.1');
  assert.equal(key(request('192.0.2.2', '192.0.2.1')), '192.0.2.2');
  assert.equal(key(request('127.0.0.1', '192.0.2.1, 198.51.100.2')), '198.51.100.2');
  assert.equal(key(request('127.0.0.1', 'invalid')), '127.0.0.1');
});


test('a token from a different session cannot authorize mutations', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const { csrfToken } = await (await first.request('/api/csrf-token')).json();
  await second.request('/api/csrf-token');
  assert.equal((await second.request('/api/preferences', { method: 'POST', headers: { 'x-csrf-token': csrfToken } })).status, 403);
});


test('existing API limiters preserve default Express IP keying and original quotas behind a proxy', async t => {
  const source = readFileSync(new URL('../server/routes.ts', import.meta.url), 'utf8');
  const app = express();
  app.set('trust proxy', 1);
  for (const [name, max, message] of [
    ['publicApiLimiter', 100, 'Too many requests, please try again later.'],
    ['agentApiLimiter', 200, 'Rate limit exceeded for agent API.'],
    ['verifyLimiter', 300, 'Too many verification requests.'],
    ['demoLimiter', 300, 'Too many requests to demo endpoints.'],
  ]) {
    const definition = source.match(new RegExp(`const ${name} = rateLimit\\(\\{[\\s\\S]*?\\n\\}\\);`));
    assert.ok(definition, `${name} definition exists`);
    let options;
    runInNewContext(definition[0], { rateLimit: config => { options = JSON.parse(JSON.stringify(config)); } });
    assert.deepEqual(options, {
      windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { message },
    });
    app.get(`/${name}`, rateLimit(options), (_req, res) => res.sendStatus(204));
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, max] of [['publicApiLimiter', 100], ['agentApiLimiter', 200], ['verifyLimiter', 300], ['demoLimiter', 300]]) {
    for (let i = 0; i < max; i++) {
      assert.equal((await fetch(`${base}/${name}`, { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 204);
    }
    const blocked = await fetch(`${base}/${name}`, { headers: { 'x-forwarded-for': '192.0.2.1' } });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
    assert.equal((await fetch(`${base}/${name}`, { headers: { 'x-forwarded-for': '192.0.2.2' } })).status, 204);
  }
});
