import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import rateLimit from 'express-rate-limit';
import ts from 'typescript';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

for (const mode of ['static', 'vite']) {
  test(`${mode} fallback limits HTML reads while leaving assets and earlier routes untouched`, async t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forgeproof-spa-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'public'));
    writeFileSync(path.join(dir, 'public/index.html'), '<html>production</html>');
    writeFileSync(path.join(dir, 'public/app.js'), 'asset');
    writeFileSync(path.join(dir, 'public/app.css'), 'asset');
    let reads = 0;
    const modules = {
      express,
      path,
      fs: { existsSync: () => true, promises: { readFile: async () => {
        reads++;
        return '<html><script src="/src/main.tsx"></script></html>';
      } } },
      'express-rate-limit': options => {
        assert.equal(options.limit, 12_000);
        assert.equal(options.windowMs, 15 * 60 * 1000);
        return rateLimit({ ...options, limit: 2 });
      },
      vite: {
        createLogger: () => ({ error() {} }),
        createServer: async () => ({
          middlewares: (req, res, next) => {
            if (['/app.js', '/app.css', '/@vite/client'].includes(req.path)) return res.send('asset');
            next();
          },
          transformIndexHtml: async (_url, html) => html,
          ssrFixStacktrace() {},
        }),
      },
      '../vite.config': {},
      nanoid: { nanoid: () => 'test-id' },
    };
    // Execute the actual registration functions with isolated filesystem/Vite dependencies.
    // Production sendFile uses real temporary files; Vite template reads are counted.
    const source = readFileSync(new URL(`../server/${mode}.ts`, import.meta.url), 'utf8')
      .replaceAll('import.meta.dirname', '__dirname');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const exported = {};
    runInNewContext(compiled, { exports: exported, __dirname: dir, require(name) {
      assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
      return modules[name];
    } });
    const app = express();
    app.set('trust proxy', 1);
    const apiPaths = ['/api/v1/attest', '/api/v1/agents/openai', '/api/stripe/webhook', '/api/github/webhook', '/api/billing'];
    for (const route of apiPaths) app.post(route, (_req, res) => res.sendStatus(204));
    if (mode === 'static') await exported.serveStatic(app);
    else await exported.setupVite({}, app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, options = {}) => fetch(base + route, {
      ...options, headers: { 'x-forwarded-for': '192.0.2.1', ...options.headers },
    });
    const checkUnrestricted = async () => {
      for (const route of ['/app.js', '/app.css', ...(mode === 'vite' ? ['/@vite/client'] : [])]) {
        const res = await request(route);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('ratelimit-limit'), null);
        assert.equal(await res.text(), 'asset');
      }
      for (const route of apiPaths) {
        const res = await request(route, { method: 'POST' });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('ratelimit-limit'), null);
      }
    };
    await checkUnrestricted();
    // Root remains Express 5 compatible. Static index serving also bypasses the limiter.
    assert.equal((await request('/')).status, 200);
    if (mode === 'static') assert.equal((await request('/dashboard')).status, 200);
    assert.equal((await request('/lookup/receipt')).status, 200);
    const blocked = await request('/verify');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('ratelimit-limit'), '2');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.deepEqual(await blocked.json(), { message: 'Too many page requests, please try again later.' });
    if (mode === 'vite') assert.equal(reads, 2, 'rejected fallbacks must not read the template');
    await checkUnrestricted();
    assert.equal((await request('/dashboard', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status, 200);
  });
}
