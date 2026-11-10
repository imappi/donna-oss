#!/usr/bin/env node
// Desktop headless boot harness — the M0a "runtime spike" recipe
// (docs/desktop-m0a-findings.md §1) as runnable code. This is the desktop
// utility-process shape minus Electron: one command brings up supervised
// Postgres (private Unix socket, no TCP — plan §3), applies the existing
// migration chain, mounts the EXISTING router over local HTTP, and starts
// the local scheduler running the desktop handler manifest (plan §4) with
// the content-addressed blob store enabled (plan §6). No Vercel, no Inngest
// Cloud, no Supabase — and since RT-14 no vercel.json read: the manifest is
// functions, called in-process.
//
// The Electron shell (desktop/) reuses the same building blocks:
// pgSupervisor.js + runtimeServer.js; this script stays the headless lane.
//
//   node scripts/desktop-boot.mjs [--seed]
//
// Env (all optional):
//   DONNA_DESKTOP_DATA_DIR  data root   (default: ~/.donna-desktop; the real
//                           app uses ~/Library/Application Support/Donna)
//   DONNA_DESKTOP_PORT      API port    (default 8787, loopback only)
//   DONNA_DESKTOP_DATABASE_URL
//                           a PostgreSQL 16 on a Unix socket to use instead
//                           of supervising one (set by docker-compose.yml for
//                           its database service). Unset, Postgres is
//                           supervised; an inherited DATABASE_URL is ignored
//                           and overwritten, as it always was.
//   DONNA_DESKTOP_PG_PORT   socket name suffix (default 5433)
//   PG_BIN                  Postgres bin dir (autodetected if unset)
//   DONNA_ACCESS_TOKEN      runtime token (generated per boot if unset)

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  attachGivenPostgres, ensureLocalPostgres, resolveDesktopPostgresSource
} from '../server/donna/desktop/pgSupervisor.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SEED = process.argv.includes('--seed');

const DATA_DIR = process.env.DONNA_DESKTOP_DATA_DIR || path.join(os.homedir(), '.donna-desktop');
const API_PORT = Number(process.env.DONNA_DESKTOP_PORT || 8787);

const log = (line) => console.log(`[desktop-boot] ${line}`);

const pgLogger = { log, error: (l) => console.error(l) };
const pgSource = resolveDesktopPostgresSource(process.env);
const pg = pgSource.mode === 'given'
  ? attachGivenPostgres({ databaseUrl: pgSource.databaseUrl, logger: pgLogger })
  : ensureLocalPostgres({ dataDir: DATA_DIR, logger: pgLogger });

try {
  process.env.DATABASE_URL = pg.databaseUrl;
  if (!process.env.DONNA_ACCESS_TOKEN) {
    process.env.DONNA_ACCESS_TOKEN = randomBytes(24).toString('hex');
    log('generated a per-boot DONNA_ACCESS_TOKEN (set one to keep it stable)');
  }
  if (!process.env.DONNA_DESKTOP_BLOB_DIR) {
    process.env.DONNA_DESKTOP_BLOB_DIR = path.join(DATA_DIR, 'documents');
  }
  mkdirSync(process.env.DONNA_DESKTOP_BLOB_DIR, { recursive: true });
  if (!process.env.DONNA_DESKTOP_BACKUP_DIR) {
    process.env.DONNA_DESKTOP_BACKUP_DIR = path.join(DATA_DIR, 'backups');
  }

  // Pre-migration backup (plan §8 trigger): an existing book gets a
  // verified package before any schema change touches it.
  const { hasPendingMigrations, createBackupPackage } = await import('../server/donna/desktop/backupPackage.js');
  if (await hasPendingMigrations({
    pgBin: pg.pgBin, databaseUrl: pg.databaseUrl, migrationsDir: path.join(ROOT, 'db', 'migrations')
  })) {
    log('pending migrations — creating a pre-migration backup package…');
    await createBackupPackage({
      backupsDir: process.env.DONNA_DESKTOP_BACKUP_DIR,
      blobDir: process.env.DONNA_DESKTOP_BLOB_DIR,
      pgBin: pg.pgBin,
      databaseUrl: pg.databaseUrl,
      reason: 'pre-migration',
      logger: console
    });
  }

  log('applying migrations…');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate_firm_db.js')], {
    cwd: ROOT, stdio: 'inherit', env: process.env
  });

  if (SEED) {
    log('seeding sample data…');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed_firm_db.js')], {
      cwd: ROOT, stdio: 'inherit', env: process.env
    });
  }

  const { createDonnaRuntimeServer } = await import('../server/donna/desktop/runtimeServer.js');
  const runtime = await createDonnaRuntimeServer({
    listen: { host: '127.0.0.1', port: API_PORT },
    logger: console
  });
  log(`router listening on http://127.0.0.1:${API_PORT}/api/donna/…`);
  if (runtime.schedulerRunning?.()) {
    const kinds = runtime.manifest.reduce((acc, entry) => ({ ...acc, [entry.kind]: (acc[entry.kind] || 0) + 1 }), {});
    log(`scheduler running ${runtime.manifest.length} handlers (${Object.entries(kinds).map(([kind, n]) => `${n} ${kind}`).join(' + ')})`);
  } else if (runtime.scheduler) {
    log('scheduler paused — Host A is not current/PASS; router diagnostics remain available');
  } else {
    log('scheduler off (DONNA_DESKTOP_SCHEDULER=off) — diagnostic mode');
  }
  log(`access token: ${process.env.DONNA_ACCESS_TOKEN}`);
  log('Donna is up. Ctrl-C to stop.');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} — shutting down…`);
    await runtime.stop();
    pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (error) {
  console.error(`[desktop-boot] boot failed: ${error.message}`);
  pg.stop();
  process.exit(1);
}
