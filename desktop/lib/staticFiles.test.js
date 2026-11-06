// staticFiles — the donna://app static resolver. Load-bearing: traversal
// attempts resolve to null (never serve outside dist), extensionless SPA
// routes fall back to index.html, and content types cover the Vite output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contentTypeFor, resolveStaticFile } from './staticFiles.mjs';

const dist = mkdtempSync(path.join(os.tmpdir(), 'donna-dist-test-'));
writeFileSync(path.join(dist, 'index.html'), '<!doctype html>');
mkdirSync(path.join(dist, 'assets'));
writeFileSync(path.join(dist, 'assets', 'app.js'), 'js');
writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
writeFileSync(path.join(os.tmpdir(), 'donna-outside-secret.txt'), 'secret');
test.after(() => rmSync(dist, { recursive: true, force: true }));

test('SPA routes (no extension) fall back to index.html', () => {
  for (const route of ['/', '/firms', '/firms/clients/abc', '/client/portal']) {
    const resolved = resolveStaticFile(dist, route);
    assert.ok(resolved, `${route} resolves`);
    assert.equal(path.basename(resolved.filePath), 'index.html');
    assert.match(resolved.contentType, /text\/html/);
  }
});

test('asset paths serve the real file with the right type', () => {
  const js = resolveStaticFile(dist, '/assets/app.js');
  assert.equal(path.basename(js.filePath), 'app.js');
  assert.match(js.contentType, /text\/javascript/);
  const svg = resolveStaticFile(dist, '/favicon.svg');
  assert.equal(svg.contentType, 'image/svg+xml');
});

test('a missing asset (with extension) is null, not an index.html fallback', () => {
  assert.equal(resolveStaticFile(dist, '/assets/nope.js'), null);
});

test('traversal attempts resolve to null', () => {
  assert.equal(resolveStaticFile(dist, '/../donna-outside-secret.txt'), null);
  assert.equal(resolveStaticFile(dist, '/assets/../../donna-outside-secret.txt'), null);
  assert.equal(resolveStaticFile(dist, '/%2e%2e/donna-outside-secret.txt'), null);
  assert.equal(resolveStaticFile(dist, '/%2e%2e%2fdonna-outside-secret.txt'), null);
});

test('malformed percent-encoding is null, not a crash', () => {
  assert.equal(resolveStaticFile(dist, '/%zz.js'), null);
});

test('unknown extensions download as octet-stream', () => {
  assert.equal(contentTypeFor('x.bin'), 'application/octet-stream');
  assert.equal(contentTypeFor('x.woff2'), 'font/woff2');
});
