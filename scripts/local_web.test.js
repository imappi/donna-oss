// scripts/local_web.mjs — the loopback server the quickstart uses to put the
// built web app and the runtime API on one origin. Load-bearing properties:
//   - /api/ requests reach the runtime unchanged: same method, path, body and
//     headers, and nothing added (no token, no cookie);
//   - a path outside dist/ is never served;
//   - client-side routes get index.html, a missing asset is a 404;
//   - a stopped runtime is a JSON 502 that says how to start it.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLocalWebServer, isApiPath, resolveStaticFile } from './local_web.mjs';

const makeDist = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'donna-local-web-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1);');
  return dir;
};

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

const request = (port, { method = 'GET', urlPath = '/', headers = {}, body = null } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

test('isApiPath: only /api and below', () => {
  assert.equal(isApiPath('/api/donna/firms/snapshot'), true);
  assert.equal(isApiPath('/api'), true);
  assert.equal(isApiPath('/apix'), false);
  assert.equal(isApiPath('/firms'), false);
});

test('resolveStaticFile: serves files inside dist only', () => {
  const dist = makeDist();
  try {
    assert.equal(resolveStaticFile(dist, '/assets/app.js'), path.join(dist, 'assets', 'app.js'));
    assert.equal(resolveStaticFile(dist, '/index.html?x=1'), path.join(dist, 'index.html'));
    assert.equal(resolveStaticFile(dist, '/assets'), null, 'a directory is not a file');
    assert.equal(resolveStaticFile(dist, '/firms'), null);
    assert.equal(resolveStaticFile(dist, '/../package.json'), null);
    assert.equal(resolveStaticFile(dist, '/%2e%2e/%2e%2e/etc/passwd'), null);
    assert.equal(resolveStaticFile(dist, '/assets/%00app.js'), null);
    assert.equal(resolveStaticFile(dist, '/%E0%A4%A'), null, 'a malformed escape is not served');
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('the server forwards /api/ unchanged and adds nothing', async () => {
  const dist = makeDist();
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Upstream': 'yes' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upstreamPort = await listen(upstream);
  const web = createLocalWebServer({ distDir: dist, runtimePort: upstreamPort });
  const webPort = await listen(web);
  try {
    const anonymous = await request(webPort, { method: 'POST', urlPath: '/api/donna/firms/clients?x=1', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    assert.equal(anonymous.status, 201);
    assert.equal(anonymous.headers['x-upstream'], 'yes');
    assert.deepEqual(JSON.parse(anonymous.body), { ok: true });
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/api/donna/firms/clients?x=1');
    assert.equal(seen[0].body, '{"a":1}');
    assert.equal(seen[0].headers['x-donna-access-token'], undefined, 'no token is added');
    assert.equal(seen[0].headers.authorization, undefined, 'no bearer is added');
    assert.equal(seen[0].headers.cookie, undefined);

    const signed = await request(webPort, { urlPath: '/api/donna/firms/snapshot', headers: { Authorization: 'Bearer from-the-browser' } });
    assert.equal(signed.status, 201);
    assert.equal(seen[1].headers.authorization, 'Bearer from-the-browser', 'the browser\'s own header passes through');
  } finally {
    await close(web);
    await close(upstream);
    rmSync(dist, { recursive: true, force: true });
  }
});

test('the server answers app routes with index.html, missing assets with 404, and a stopped runtime with 502', async () => {
  const dist = makeDist();
  // A port that was just free: nothing listens there.
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await close(probe);
  const web = createLocalWebServer({ distDir: dist, runtimePort: deadPort });
  const webPort = await listen(web);
  try {
    const page = await request(webPort, { urlPath: '/firms?entity=x' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /<title>app<\/title>/);

    const asset = await request(webPort, { urlPath: '/assets/app.js' });
    assert.equal(asset.status, 200);
    assert.match(asset.headers['content-type'], /javascript/);

    const missing = await request(webPort, { urlPath: '/assets/missing.js' });
    assert.equal(missing.status, 404);

    const write = await request(webPort, { method: 'POST', urlPath: '/firms' });
    assert.equal(write.status, 405);

    const down = await request(webPort, { urlPath: '/api/donna/firms/health' });
    assert.equal(down.status, 502);
    const body = JSON.parse(down.body);
    assert.equal(body.code, 'LOCAL_RUNTIME_UNREACHABLE');
    assert.match(body.error, /npm run local:runtime/);
  } finally {
    await close(web);
    rmSync(dist, { recursive: true, force: true });
  }
});
