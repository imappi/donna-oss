import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPortalPreviewServer, portalPreviewActivationPath } from './portalPreview.mjs';

const listen = (server, options) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(options, resolve);
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test('activation path is encoded and refuses incomplete identities', () => {
  assert.equal(
    portalPreviewActivationPath({ token: 'token 1', clientId: 'client/a' }),
    '/__donna_portal_preview__/token%201/client/client%2Fa'
  );
  assert.equal(portalPreviewActivationPath({ token: '', clientId: 'client' }), null);
  assert.equal(portalPreviewActivationPath({ token: 'token', clientId: '' }), null);
});

test('loopback preview requires activation, serves the SPA, and proxies with the main-process token', async (t) => {
  const dist = mkdtempSync(path.join(os.tmpdir(), 'donna-portal-preview-dist-'));
  const socketDir = mkdtempSync(path.join(os.tmpdir(), 'donna-portal-preview-socket-'));
  const socketPath = path.join(socketDir, 'runtime.sock');
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><head><title>Portal preview</title></head>');

  let upstreamToken = null;
  const runtime = http.createServer((request, response) => {
    upstreamToken = request.headers['x-donna-access-token'] || null;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  await listen(runtime, { path: socketPath });

  const preview = await createPortalPreviewServer({
    distRoot: dist,
    socketPath,
    accessToken: 'main-only-token',
    contentSecurityPolicy: "default-src 'self'",
    sessionToken: 'preview-secret'
  });
  t.after(async () => {
    await preview.stop();
    await close(runtime);
    rmSync(dist, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  });

  const denied = await fetch(`${preview.origin}/client/client-1`);
  assert.equal(denied.status, 403);

  const activation = await fetch(preview.urlForClient('client/a'), { redirect: 'manual' });
  assert.equal(activation.status, 302);
  assert.equal(activation.headers.get('location'), '/client/client%2Fa');
  const setCookie = activation.headers.get('set-cookie');
  assert.match(setCookie, /donna_portal_preview_session=preview-secret/);
  assert.doesNotMatch(setCookie, /donna_portal_preview=1/);
  const cookie = 'donna_portal_preview_session=preview-secret';

  const page = await fetch(`${preview.origin}/client/client%2Fa`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.equal(
    await page.text(),
    '<!doctype html><head><title>Portal preview</title><meta name="donna-portal-preview" content="desktop"></head>'
  );
  assert.equal(page.headers.get('content-security-policy'), "default-src 'self'");

  const api = await fetch(`${preview.origin}/api/donna/firms/snapshot`, { headers: { Cookie: cookie } });
  assert.deepEqual(await api.json(), { ok: true, path: '/api/donna/firms/snapshot' });
  assert.equal(upstreamToken, 'main-only-token');

  const crossOriginWrite = await fetch(`${preview.origin}/api/donna/owner-reply`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'http://127.0.0.1:9999' },
    body: '{}'
  });
  assert.equal(crossOriginWrite.status, 403);

  const sameOriginWrite = await fetch(`${preview.origin}/api/donna/owner-reply`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: preview.origin },
    body: '{}'
  });
  assert.equal(sameOriginWrite.status, 200);
});

// The client-ask reply with a file runs in the SYSTEM browser through this
// preview: the runtime mints an origin-relative signed URL
// (`/api/donna/evidence-local?token=…`, evidenceStorage.js), the page resolves
// it on the preview origin, and the preview must carry the PUT — bytes,
// content-type, same-origin check, main-process token — to the runtime
// socket. Before 2026-09-04 the runtime minted `donna://app/...` here, which
// Safari cannot fetch from an http origin ("Load failed", no request made).
test('a same-origin signed evidence PUT crosses the preview to the runtime with its bytes and the main-process token', async (t) => {
  const dist = mkdtempSync(path.join(os.tmpdir(), 'donna-portal-preview-put-dist-'));
  const socketDir = mkdtempSync(path.join(os.tmpdir(), 'donna-portal-preview-put-socket-'));
  const socketPath = path.join(socketDir, 'runtime.sock');
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><head><title>Portal preview</title></head>');

  const seen = {};
  const runtime = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      Object.assign(seen, {
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'] || null,
        token: request.headers['x-donna-access-token'] || null,
        body: Buffer.concat(chunks)
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ Key: 'donna-evidence/firm-1/client-1/probe.pdf' }));
    });
  });
  await listen(runtime, { path: socketPath });

  const preview = await createPortalPreviewServer({
    distRoot: dist,
    socketPath,
    accessToken: 'main-only-token',
    contentSecurityPolicy: "default-src 'self'",
    sessionToken: 'preview-secret'
  });
  t.after(async () => {
    await preview.stop();
    await close(runtime);
    rmSync(dist, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  });
  const cookie = 'donna_portal_preview_session=preview-secret';

  // What the runtime mints, resolved the way the browser resolves it: on the
  // origin that served the page. It stays on the preview origin.
  const signedUrl = new URL('/api/donna/evidence-local?token=abc.def', preview.origin);
  assert.equal(signedUrl.origin, preview.origin);

  const bytes = Buffer.from('%PDF-1.4 preview probe');
  const put = await fetch(signedUrl, {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: preview.origin, 'Content-Type': 'application/pdf', 'x-upsert': 'false' },
    body: bytes
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { Key: 'donna-evidence/firm-1/client-1/probe.pdf' });
  assert.equal(seen.method, 'PUT');
  assert.equal(seen.url, '/api/donna/evidence-local?token=abc.def');
  assert.equal(seen.contentType, 'application/pdf');
  assert.equal(seen.token, 'main-only-token');
  assert.ok(Buffer.from(seen.body).equals(bytes), 'the PUT body must reach the runtime byte for byte');

  // The shape the runtime used to mint cannot resolve onto this origin at all.
  const legacy = new URL('donna://app/api/donna/evidence-local?token=abc.def', preview.origin);
  assert.notEqual(`${legacy.protocol}//${legacy.host}`, preview.origin);
});
