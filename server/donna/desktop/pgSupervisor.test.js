// findPgBin — the PG 16 discovery contract (plan §3, pinned major). What must
// hold: an explicit PG_BIN of the wrong major refuses rather than initdb'ing a
// cluster the rest of the generation cannot open, and the candidate list covers
// the no-Homebrew macOS route (Postgres.app) that a real Mac hit on first run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PG_MAJOR, findPgBin, pgBinCandidates } from './pgSupervisor.js';

// A bin dir whose pg_ctl reports the given version, the way the real probe
// reads it.
const fakeBin = (version) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pgbin-'));
  const pgCtl = path.join(dir, 'pg_ctl');
  writeFileSync(pgCtl, `#!/bin/sh\necho "pg_ctl (PostgreSQL) ${version}"\n`);
  chmodSync(pgCtl, 0o755);
  return dir;
};

const withPgBin = (value, fn) => {
  const prior = process.env.PG_BIN;
  if (value === undefined) delete process.env.PG_BIN;
  else process.env.PG_BIN = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.PG_BIN;
    else process.env.PG_BIN = prior;
  }
};

test('explicit PG_BIN of the pinned major is used', () => {
  const dir = fakeBin(`${PG_MAJOR}.4`);
  assert.equal(withPgBin(dir, findPgBin), dir);
});

test('explicit PG_BIN of another major refuses instead of initdb-ing it', () => {
  const dir = fakeBin(`${PG_MAJOR + 1}.1`);
  assert.throws(() => withPgBin(dir, findPgBin), /pinned to Postgres 16/);
});

test('explicit PG_BIN is honored when pg_ctl yields no version', () => {
  // An unreadable/absent pg_ctl is the operator's problem to see downstream;
  // discovery must not invent a version mismatch out of it.
  const dir = mkdtempSync(path.join(tmpdir(), 'pgbin-'));
  assert.equal(withPgBin(dir, findPgBin), dir);
});

// DONNA_BUNDLED_PG_BIN — the packaged-app payload contract (M0b): a set
// bundle wins over every host candidate, and a set-but-broken bundle is a
// loud packaging defect, never a silent fall-through to host Postgres.
const withBundled = (value, fn) => {
  const prior = process.env.DONNA_BUNDLED_PG_BIN;
  if (value === undefined) delete process.env.DONNA_BUNDLED_PG_BIN;
  else process.env.DONNA_BUNDLED_PG_BIN = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.DONNA_BUNDLED_PG_BIN;
    else process.env.DONNA_BUNDLED_PG_BIN = prior;
  }
};

test('bundled payload of the pinned major wins', () => {
  const dir = fakeBin(`${PG_MAJOR}.4`);
  assert.equal(withBundled(dir, () => withPgBin(undefined, findPgBin)), dir);
});

test('explicit PG_BIN overrides the bundled payload', () => {
  const bundled = fakeBin(`${PG_MAJOR}.4`);
  const explicit = fakeBin(`${PG_MAJOR}.2`);
  assert.equal(withBundled(bundled, () => withPgBin(explicit, findPgBin)), explicit);
});

test('bundled payload with no pg_ctl fails loudly, never falls through', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'pgbin-'));
  assert.throws(
    () => withBundled(empty, () => withPgBin(undefined, findPgBin)),
    /missing or corrupt/
  );
});

test('bundled payload of another major fails loudly as a corrupt bundle', () => {
  const dir = fakeBin(`${PG_MAJOR + 1}.0`);
  assert.throws(
    () => withBundled(dir, () => withPgBin(undefined, findPgBin)),
    /bundle is corrupt/
  );
});

// The 2026-08-07 Mac drill regression: Homebrew (and Debian) append a suffix
// after the version, which the old end-anchored probe regex missed — a
// healthy Homebrew-sourced payload was refused as "corrupt". The probe must
// parse every real-world `pg_ctl --version` format.
test('bundled payload with a Homebrew version suffix is accepted', () => {
  const dir = fakeBin(`${PG_MAJOR}.14 (Homebrew)`);
  assert.equal(withBundled(dir, () => withPgBin(undefined, findPgBin)), dir);
});

test('bundled payload with a Debian suffix parses the leading major, not the packaging version', () => {
  const dir = fakeBin(`${PG_MAJOR}.9 (Debian ${PG_MAJOR}.9-1.pgdg120+1)`);
  assert.equal(withBundled(dir, () => withPgBin(undefined, findPgBin)), dir);
});

test('a wrong-major payload with a Homebrew suffix still refuses', () => {
  const dir = fakeBin(`${PG_MAJOR + 1}.1 (Homebrew)`);
  assert.throws(
    () => withBundled(dir, () => withPgBin(undefined, findPgBin)),
    /bundle is corrupt/
  );
});

test('candidates cover the no-Homebrew macOS route', () => {
  const candidates = pgBinCandidates();
  assert.ok(
    candidates.some((dir) => dir.includes('Postgres.app')),
    'Postgres.app is how a Mac without Homebrew gets PG binaries'
  );
  assert.ok(candidates.includes(`/opt/homebrew/opt/postgresql@${PG_MAJOR}/bin`));
});

test('every version-pinned candidate names the pinned major', () => {
  for (const dir of pgBinCandidates()) {
    const versions = [...dir.matchAll(/(?:postgresql@|Versions\/)(\d+)/g)]
      .map((match) => match[1]);
    for (const found of versions) {
      assert.equal(
        Number(found), PG_MAJOR,
        `${dir} names a major other than ${PG_MAJOR}`
      );
    }
  }
});

// ── ensureLocalPostgres onActive — live-sibling vs orphan (2026-08-09) ──────
// The backup CLI's default reclaim fast-stopped a LIVE drill app's postmaster
// and then stopped PG on exit, leaving the running app DB-less. These pin the
// three modes against a scripted pg_ctl whose "running server" is a marker
// file: status exits 0 while it exists, start fails while it exists (the
// real "another server might be running" shape), stop removes it.

import { ensureLocalPostgres } from './pgSupervisor.js';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

const supervisorFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pgsup-'));
  const binDir = path.join(root, 'bin');
  const dataDir = path.join(root, 'data');
  const pgData = path.join(dataDir, 'database', 'pg');
  const logPath = path.join(root, 'calls.log');
  const marker = path.join(root, 'running.marker');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(pgData, { recursive: true });
  writeFileSync(path.join(pgData, 'PG_VERSION'), '16\n');
  const script = (name, body) => {
    const file = path.join(binDir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${logPath}"\n${body}\n`);
    chmodSync(file, 0o755);
  };
  script('pg_ctl', [
    `case "$*" in`,
    `  *--version*) echo "pg_ctl (PostgreSQL) 16.14"; exit 0;;`,
    `  *status*) [ -f "${marker}" ] && exit 0 || exit 3;;`,
    `  *stop*) rm -f "${marker}"; exit 0;;`,
    `  *start*) [ -f "${marker}" ] && exit 1 || exit 0;;`,
    `esac`,
    `exit 0`
  ].join('\n'));
  script('psql', 'echo 1\nexit 0');
  script('initdb', 'exit 0');
  script('createdb', 'exit 0');
  const calls = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
  return { binDir, dataDir, pgData, marker, calls };
};

const quietLogger = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l) };
};

test('attach mode uses a running server and stop() leaves it up', () => {
  const fx = supervisorFixture();
  writeFileSync(fx.marker, 'up');
  const logger = quietLogger();
  const pg = withPgBin(fx.binDir, () =>
    ensureLocalPostgres({ dataDir: fx.dataDir, onActive: 'attach', logger })
  );
  assert.equal(pg.attached, true);
  assert.ok(logger.lines.some((l) => l.includes('attaching to the postgres already running')));
  assert.ok(!fx.calls().includes('start'), 'attach must not start a second server');
  pg.stop();
  assert.ok(!fx.calls().includes('stop'), 'attach stop() must leave the live server up');
  assert.ok(existsSync(fx.marker), 'the live server survives');
});

test('refuse mode throws on a live server and touches nothing', () => {
  const fx = supervisorFixture();
  writeFileSync(fx.marker, 'up');
  assert.throws(
    () => withPgBin(fx.binDir, () =>
      ensureLocalPostgres({ dataDir: fx.dataDir, onActive: 'refuse', logger: quietLogger() })
    ),
    /live postgres already owns/
  );
  assert.ok(!fx.calls().includes('start'));
  assert.ok(!fx.calls().includes(' stop'), 'refuse must not stop the live server');
  assert.ok(existsSync(fx.marker), 'the live server survives');
});

test('attach mode with nothing running starts and stops its own server', () => {
  const fx = supervisorFixture();
  const pg = withPgBin(fx.binDir, () =>
    ensureLocalPostgres({ dataDir: fx.dataDir, onActive: 'attach', logger: quietLogger() })
  );
  assert.equal(pg.attached, false);
  assert.ok(fx.calls().includes('start'), 'standalone create still brings PG up');
  writeFileSync(path.join(fx.pgData, 'postmaster.pid'), '123\n');
  pg.stop();
  assert.ok(fx.calls().includes('stop'), 'a server we started is ours to stop');
});

test('default reclaim still stops a running server and restarts it (the orphan path)', () => {
  const fx = supervisorFixture();
  writeFileSync(fx.marker, 'up');
  const logger = quietLogger();
  const pg = withPgBin(fx.binDir, () =>
    ensureLocalPostgres({ dataDir: fx.dataDir, logger })
  );
  assert.equal(pg.attached, false);
  assert.ok(logger.lines.some((l) => l.includes('reclaiming')));
  const starts = fx.calls().split('\n').filter((l) => l.includes('start')).length;
  assert.equal(starts, 2, 'failed start, reclaim, then a clean start');
  assert.ok(!existsSync(fx.marker), 'the orphan was stopped');
});
