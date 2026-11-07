import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import { createHmac } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpsRequest } from 'node:https';
import { runInNewContext } from 'node:vm';
import rateLimit from 'express-rate-limit';
import ts from 'typescript';
import { createTransportRateLimitKey, createUiLimiter, issueCsrfToken, requireSessionCsrf, sessionCsrfProtection, transportRateLimitKey } from '../server/httpSecurity.ts';
import { verifyGitHubWebhookSignature } from '../server/security.ts';

async function fixture(t, limit = 100) {
  const tlsDir = mkdtempSync(join(tmpdir(), 'forgeproof-test-tls-'));
  t.after(() => rmSync(tlsDir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = readFileSync(join(tlsDir, 'cert.pem'));
  const key = readFileSync(join(tlsDir, 'key.pem'));
  const app = express();
  app.set('trust proxy', 1); // existing production setting; UI uses separate safe keys
  app.use(express.json({ verify: (req, _res, body) => { req.rawBody = body; } }));
  app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
  app.use(session({ secret: 'local-test-session-secret', resave: false, saveUninitialized: false, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
  app.use(sessionCsrfProtection);
  app.use((req, _res, next) => {
    req.isAuthenticated = () => !!req.session.loggedIn;
    if (req.isAuthenticated()) req.user = { claims: { sub: 'test-user' } };
    next();
  });
  app.get('/api/csrf-token', createUiLimiter(), issueCsrfToken);
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
  const server = createServer({ key, cert }, app).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `https://127.0.0.1:${server.address().port}`;
  let cookie;
  const request = async (path, options = {}) => {
    const response = await new Promise((resolve, reject) => {
      const req = httpsRequest(base + path, { ca: cert, method: options.method || 'GET',
        headers: { ...(cookie ? { cookie } : {}), ...options.headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
          status: res.statusCode, headers: Object.entries(res.headers).flatMap(([name, values]) =>
            (Array.isArray(values) ? values : [values]).map(value => [name, value])),
        })));
      });
      req.on('error', reject);
      req.end(options.body);
    });
    if (response.headers.get('set-cookie')) {
      const issuedCookie = response.headers.get('set-cookie');
      assert.match(issuedCookie, /; Secure/i);
      assert.match(issuedCookie, /; HttpOnly/i);
      assert.match(issuedCookie, /; SameSite=Lax/i);
      cookie = issuedCookie.split(';')[0];
    }
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
  assert.equal((await request(`/api/preferences?csrfToken=${csrfToken}`, { method: 'POST' })).status, 403);
  assert.equal((await request('/api/preferences', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken }),
  })).status, 403);
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


test('CSRF dispatch preserves safe OIDC methods and independent protocols without doing authorization', () => {
  const response = { status(code) { this.code = code; return this; }, json() {} };
  const request = (method, path) => ({ method, path, protocol: 'https',
    session: {}, get: () => undefined,
    isAuthenticated() { throw new Error('CSRF dispatch must not perform authorization'); } });
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    for (const path of ['/api/login', '/api/callback', '/api/logout', '/api/github/callback']) {
      let continued = false;
      sessionCsrfProtection(request(method, path), response, () => { continued = true; });
      assert.equal(continued, true);
    }
  }
  for (const path of ['/api/stripe/webhook', '/api/github/webhook', '/api/mcp/tools',
    '/api/v1/attest', '/api/v1/agents/openai', '/api/v1/agents/claude', '/api/v1/agents/replit']) {
    let continued = false;
    sessionCsrfProtection(request('POST', path), response, () => { continued = true; });
    assert.equal(continued, true);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    let continued = false;
    sessionCsrfProtection(request(method, '/api/preferences'), response, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(response.code, 403);
  }
});

test('browser apiRequest obtains a session token before mutation and fails closed on token fetch failure', async t => {
  const { request } = await fixture(t);
  const source = readFileSync(new URL('../client/src/lib/queryClient.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  const calls = [];
  let failToken = false;
  runInNewContext(compiled, { exports: exported,
    require: () => ({ QueryClient: class {} }),
    fetch: async (path, options) => {
      calls.push({ path, options });
      if (failToken && path === '/api/csrf-token') return new Response('Unavailable', { status: 503 });
      return request(path, options);
    },
  });
  assert.equal((await exported.apiRequest('POST', '/api/preferences', { theme: 'dark' })).status, 204);
  assert.equal(calls[0].path, '/api/csrf-token');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.credentials, 'include');
  assert.match(calls[1].options.headers['X-CSRF-Token'], /^[a-f0-9]{64}$/);
  assert.equal(calls[1].options.credentials, 'include');
  failToken = true;
  calls.length = 0;
  await assert.rejects(exported.apiRequest('PATCH', '/api/preferences', {}), /503/);
  assert.equal(calls.length, 1);
});
