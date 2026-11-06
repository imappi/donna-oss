#!/usr/bin/env node
// Backup-package CLI (technical plan §8) — the manual trigger and the
// restore-drill tool. The daily cron and pre-migration triggers use the
// same module (server/donna/desktop/backupPackage.js); this is for a human.
//
//   node scripts/desktop-backup.mjs create   [--data-dir <dir>] [--reason r]
//   node scripts/desktop-backup.mjs list     [--data-dir <dir>]
//   node scripts/desktop-backup.mjs verify   <package-dir>
//   node scripts/desktop-backup.mjs restore  <package-dir> --data-dir <dir>
//
// `create`/`list` default --data-dir to ~/.donna-desktop (the headless
// harness's default; pass the app's dir to back up the desktop app's book).
// `restore` targets the DATA DIR of a fresh install: it starts that dir's
// Postgres (initdb if virgin), creates the database if missing, refuses a
// non-empty one, restores the dump, copies blobs into the store, and
// re-verifies every restored evidence row — the clean-second-Mac drill
// (plan §8/M0b), runnable against any empty data dir.

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  createBackupPackage, restoreBackupPackage, rotateBackupPackages, verifyBackupPackage
} from '../server/donna/desktop/backupPackage.js';
import { ensureLocalPostgres } from '../server/donna/desktop/pgSupervisor.js';

const args = process.argv.slice(2);
const command = args[0];
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
};
const dataDir = flagValue('--data-dir') || process.env.DONNA_DESKTOP_DATA_DIR || path.join(os.homedir(), '.donna-desktop');
const positional = args.filter((a, i) => i > 0 && !a.startsWith('--') && args[i - 1] !== '--data-dir' && args[i - 1] !== '--reason');

const fail = (message) => {
  console.error(`[desktop-backup] ${message}`);
  process.exit(1);
};

if (command === 'verify') {
  const packageDir = positional[0];
  if (!packageDir) fail('verify needs a package dir');
  const report = verifyBackupPackage({ packageDir });
  console.log(JSON.stringify({ ok: report.ok, errors: report.errors, schema_version: report.manifest?.schema_version }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (command === 'list') {
  const { readdirSync, existsSync } = await import('node:fs');
  const backupsDir = path.join(dataDir, 'backups');
  if (!existsSync(backupsDir)) fail(`no backups dir at ${backupsDir}`);
  for (const name of readdirSync(backupsDir).filter((n) => !n.startsWith('.')).sort()) {
    const report = verifyBackupPackage({ packageDir: path.join(backupsDir, name) });
    console.log(`${report.ok ? 'OK  ' : 'BAD '} ${name}  schema=${report.manifest?.schema_version || '?'} blobs=${report.manifest?.blob_count ?? '?'}${report.ok ? '' : `  (${report.errors[0]})`}`);
  }
  process.exit(0);
}

if (command === 'create' || command === 'restore') {
  // create may run WHILE the app owns this data dir's server: attach to it
  // and leave it up (the default reclaim mode fast-stopped a live app's
  // postmaster and left the running app DB-less — observed 2026-08-09).
  // restore must never touch a live dir: it targets a fresh install, so a
  // running server there means the user pointed at the wrong --data-dir.
  const pg = ensureLocalPostgres({
    dataDir,
    logger: console,
    onActive: command === 'create' ? 'attach' : 'refuse'
  });
  try {
    if (command === 'create') {
      const backupsDir = path.join(dataDir, 'backups');
      const result = await createBackupPackage({
        backupsDir,
        blobDir: path.join(dataDir, 'documents'),
        pgBin: pg.pgBin,
        databaseUrl: pg.databaseUrl,
        reason: flagValue('--reason') || 'manual',
        logger: console
      });
      rotateBackupPackages({ backupsDir, logger: console });
      console.log(JSON.stringify({ package: result.packageDir, blobs: result.manifest.blob_count }, null, 2));
    } else {
      const packageDir = positional[0];
      if (!packageDir) fail('restore needs a package dir');
      const blobDir = path.join(dataDir, 'documents');
      mkdirSync(blobDir, { recursive: true });
      const report = await restoreBackupPackage({
        packageDir: path.resolve(packageDir),
        blobDir,
        pgBin: pg.pgBin,
        databaseUrl: pg.databaseUrl,
        logger: console
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.missing_blobs.length) process.exit(1);
    }
  } finally {
    pg.stop();
  }
  process.exit(0);
}

fail(`unknown command "${command || ''}" — use create | list | verify <dir> | restore <dir> --data-dir <dir>`);
