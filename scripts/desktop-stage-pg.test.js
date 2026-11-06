// desktop-stage-pg — the plan layer's contract (the Mac-only fixup/verify
// passes are exercised on the Mac; what must hold everywhere): the source
// layout resolver understands the three real-world PG distributions, the
// plan refuses a source missing any required binary, and share/ is
// normalized to share/postgresql whatever the source called it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { REQUIRED_BINARIES, planStaging, resolvePayloadRef, resolveSourceLayout } from './desktop-stage-pg.mjs';
import { PG_MAJOR } from '../server/donna/desktop/pgSupervisor.js';

// A fake PG install in one of the real-world layouts.
const fakePg = ({ shareFlavor }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pgsrc-'));
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  for (const name of REQUIRED_BINARIES) {
    writeFileSync(path.join(root, 'bin', name), '#!/bin/sh\n');
  }
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  const share = path.join(root, 'share', shareFlavor);
  mkdirSync(share, { recursive: true });
  writeFileSync(path.join(share, 'postgres.bki'), '');
  return root;
};

test('resolves the Homebrew keg share flavor', () => {
  const root = fakePg({ shareFlavor: `postgresql@${PG_MAJOR}` });
  const source = resolveSourceLayout(root);
  assert.equal(source.bin, path.join(root, 'bin'));
  assert.ok(source.share.endsWith(`postgresql@${PG_MAJOR}`));
});

test('resolves the Postgres.app/EDB share flavor, from a bin dir argument', () => {
  const root = fakePg({ shareFlavor: 'postgresql' });
  const source = resolveSourceLayout(path.join(root, 'bin'));
  assert.ok(source.share.endsWith(path.join('share', 'postgresql')));
});

test('refuses a source with no postgres.bki (initdb would fail at first run)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pgsrc-'));
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'bin', 'pg_ctl'), '');
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  assert.throws(() => resolveSourceLayout(root), /postgres\.bki/);
});

test('plan covers every required binary and normalizes share/', () => {
  const root = fakePg({ shareFlavor: `postgresql@${PG_MAJOR}` });
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'pgout-')), `pg${PG_MAJOR}`);
  const plan = planStaging({ source: resolveSourceLayout(root), out });
  for (const name of REQUIRED_BINARIES) {
    assert.ok(plan.some((s) => s.to === path.join(out, 'bin', name)), `plan misses ${name}`);
  }
  assert.ok(plan.some((s) => s.dir && s.to === path.join(out, 'share', 'postgresql')));
  assert.ok(plan.some((s) => s.dir && s.to === path.join(out, 'lib')));
});

test('plan refuses a source missing a required binary', () => {
  const root = fakePg({ shareFlavor: 'postgresql' });
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'pgout-')), `pg${PG_MAJOR}`);
  const source = resolveSourceLayout(root);
  // pg_dump is what backup packages ride on — its absence must refuse loudly.
  rmSync(path.join(root, 'bin', 'pg_dump'));
  assert.throws(() => planStaging({ source, out }), /pg_dump/);
});

// resolvePayloadRef — the @-reference resolution the closure fixup and both
// verify layers use. The libicudata regression (first bundled initdb,
// 2026-08-07): Homebrew ICU references siblings via @loader_path, so a
// reference can LOOK relocatable while its target was never staged; these
// pin the dyld semantics the checks rely on.
test('@loader_path resolves against the referencing file dir', () => {
  assert.equal(
    resolvePayloadRef({ dep: '@loader_path/libicudata.78.dylib', fileDir: '/p/lib', binDir: '/p/bin' }),
    '/p/lib/libicudata.78.dylib'
  );
  // Subdir modules (lib/postgresql/*.so) resolve relative to THEIR dir.
  assert.equal(
    resolvePayloadRef({ dep: '@loader_path/../libpq.5.dylib', fileDir: '/p/lib/postgresql', binDir: '/p/bin' }),
    '/p/lib/libpq.5.dylib'
  );
});

test('@executable_path resolves against the payload bin dir (dyld: the process executable, always a payload binary here)', () => {
  assert.equal(
    resolvePayloadRef({ dep: '@executable_path/../lib/libpq.5.dylib', fileDir: '/p/lib', binDir: '/p/bin' }),
    '/p/lib/libpq.5.dylib'
  );
});

test('@rpath is not statically resolvable', () => {
  assert.equal(
    resolvePayloadRef({ dep: '@rpath/libssl.3.dylib', fileDir: '/p/lib', binDir: '/p/bin' }),
    null
  );
});
