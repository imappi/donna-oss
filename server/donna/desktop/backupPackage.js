// Desktop backup packages (technical plan §8): a backup is ONE verified
// package — PG custom-format dump + every referenced document blob + a
// manifest (hashes, schema version, app version, PG server version,
// timestamp) + a manifest checksum. Backup-on-quit is NOT the protection;
// packages are created by triggers (daily cron via the handler manifest,
// pre-migration in the supervisors, manual via scripts/desktop-backup.mjs)
// and verified BEFORE the rolling window rotates anything older.
//
// All PG interaction goes through the same binaries pgSupervisor drives
// (pg_dump / pg_restore / psql over the private socket) — no second client
// stack, and tests inject execFileImpl. v0 scope, recorded honestly: local
// packages + rolling window + verify + restore; the encrypted EXTERNAL
// destination, manifest SIGNING (needs the tether's key infra), the
// post-close and debounced-material-change triggers, and the `.donna`
// single-file format are later slices (findings §5b).
//
// Failure ordering: packages are written under an `.incomplete-` name and
// renamed into place only after in-place verification passes — a crash
// mid-backup can never leave a package that LOOKS restorable.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { blobPathForHash, hashEvidenceBytes } from './localBlobStore.js';

const execFileAsync = promisify(execFile);

export const MANIFEST_FORMAT = 'donna-backup/1';

// Parses the supervisor-shaped DATABASE_URL
// (postgresql://user@localhost/db?host=<socketdir>&port=<n>).
export const parseLocalDatabaseUrl = (databaseUrl) => {
  const url = new URL(databaseUrl);
  const socketDir = url.searchParams.get('host');
  if (!socketDir) throw new Error('Expected a unix-socket DATABASE_URL (…?host=<socket dir>).');
  return {
    socketDir,
    port: url.searchParams.get('port') || '5432',
    user: decodeURIComponent(url.username || 'donna'),
    database: (url.pathname || '/').replace(/^\//, '') || 'donna_local'
  };
};

const pgArgs = (db) => ['-h', db.socketDir, '-p', String(db.port), '-U', db.user];

const makePgTools = ({ pgBin, databaseUrl, execFileImpl }) => {
  const db = parseLocalDatabaseUrl(databaseUrl);
  const run = execFileImpl || ((file, args) => execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024 }));
  return {
    db,
    psql: async (sql) => {
      const { stdout } = await run(path.join(pgBin, 'psql'), [...pgArgs(db), '-d', db.database, '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);
      return String(stdout || '').trim();
    },
    // The storage schema is the 010 host stub — environment, not book data;
    // the restore target's supervisor recreates it, so the package excludes
    // it (and restore's emptiness check ignores it, below).
    pgDump: (outFile) =>
      run(path.join(pgBin, 'pg_dump'), [...pgArgs(db), '-Fc', '-N', 'storage', '-f', outFile, db.database]),
    pgRestore: (dumpFile) =>
      run(path.join(pgBin, 'pg_restore'), [...pgArgs(db), '-d', db.database, '--no-owner', dumpFile])
  };
};

const sha256File = (filePath) => hashEvidenceBytes(readFileSync(filePath));

const packageBlobPath = (packageDir, hash) =>
  path.join(packageDir, 'blobs', 'sha256', hash.slice(0, 2), `${hash}.bin`);

// One package: <backupsDir>/<stamp>-<reason>/ { donna.dump, manifest.json,
// manifest.sha256, blobs/sha256/… }. Returns the verification report.
export const createBackupPackage = async ({
  backupsDir, blobDir, pgBin, databaseUrl, reason = 'manual',
  appVersion = null, now = () => new Date(), logger = console, execFileImpl
} = {}) => {
  if (!backupsDir || !blobDir || !pgBin || !databaseUrl) {
    throw new Error('createBackupPackage needs backupsDir, blobDir, pgBin, and databaseUrl.');
  }
  const tools = makePgTools({ pgBin, databaseUrl, execFileImpl });
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const safeReason = String(reason).replace(/[^\w-]+/g, '-').slice(0, 40);
  const finalDir = path.join(backupsDir, `${stamp}-${safeReason}`);
  const workDir = path.join(backupsDir, `.incomplete-${stamp}-${safeReason}`);
  mkdirSync(workDir, { recursive: true });

  try {
    // 1. The dump first: its MVCC snapshot defines the package's contents.
    const dumpFile = path.join(workDir, 'donna.dump');
    await tools.pgDump(dumpFile);

    // 2. Blobs are enumerated AFTER the dump so the index is a superset of
    //    what the dump references (adds are harmless extras). The tiny
    //    dump↔GC race — a blob deleted in between — is caught by restore's
    //    per-row verification, never silently (findings §5b).
    const hashLines = await tools.psql(
      'select distinct content_hash from local_evidence_objects order by content_hash'
    );
    const hashes = hashLines ? hashLines.split('\n').filter(Boolean) : [];
    const blobs = [];
    for (const hash of hashes) {
      const source = blobPathForHash(blobDir, hash);
      const bytes = readFileSync(source);
      if (hashEvidenceBytes(bytes) !== hash) {
        throw new Error(`Blob ${hash} is corrupt in the live store; refusing to back it up as good.`);
      }
      const target = packageBlobPath(workDir, hash);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      blobs.push({ hash, bytes: bytes.length });
    }

    // 3. The manifest, then its checksum over the exact bytes on disk.
    const manifest = {
      format: MANIFEST_FORMAT,
      created_at: now().toISOString(),
      reason: safeReason,
      app_version: appVersion,
      schema_version: (await tools.psql('select max(version) from schema_migrations')) || null,
      pg_server_version: (await tools.psql('show server_version')) || null,
      dump: { file: 'donna.dump', sha256: sha256File(dumpFile), bytes: statSync(dumpFile).size },
      blob_count: blobs.length,
      blobs
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(path.join(workDir, 'manifest.json'), manifestBytes);
    writeFileSync(path.join(workDir, 'manifest.sha256'), `${hashEvidenceBytes(manifestBytes)}\n`);

    // 4. Verify in place; only a verified package earns its final name.
    const verification = verifyBackupPackage({ packageDir: workDir });
    if (!verification.ok) {
      throw new Error(`Backup self-verification failed: ${verification.errors.join('; ')}`);
    }
    renameSync(workDir, finalDir);
    logger.log?.(`[backup] package created and verified: ${finalDir} (${blobs.length} blobs, schema ${manifest.schema_version})`);
    return { packageDir: finalDir, manifest, verified: true };
  } catch (error) {
    // A failed backup is loud AND leaves no half-package behind.
    rmSync(workDir, { recursive: true, force: true });
    logger.error?.(`[backup] FAILED (${safeReason}): ${error.message}`);
    throw error;
  }
};

// Re-hashes everything against the manifest. Pure fs — safe on any host.
export const verifyBackupPackage = ({ packageDir } = {}) => {
  const errors = [];
  let manifest = null;
  try {
    const manifestBytes = readFileSync(path.join(packageDir, 'manifest.json'));
    const expected = readFileSync(path.join(packageDir, 'manifest.sha256'), 'utf8').trim();
    if (hashEvidenceBytes(manifestBytes) !== expected) {
      errors.push('manifest checksum mismatch');
    }
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    return { ok: false, errors: [`manifest unreadable: ${error.message}`], manifest: null };
  }
  if (manifest.format !== MANIFEST_FORMAT) errors.push(`unknown format ${manifest.format}`);

  const dumpFile = path.join(packageDir, manifest.dump?.file || 'donna.dump');
  if (!existsSync(dumpFile)) errors.push('dump file missing');
  else if (sha256File(dumpFile) !== manifest.dump?.sha256) errors.push('dump hash mismatch');

  for (const blob of manifest.blobs || []) {
    const blobFile = packageBlobPath(packageDir, blob.hash);
    if (!existsSync(blobFile)) errors.push(`blob missing: ${blob.hash}`);
    else if (sha256File(blobFile) !== blob.hash) errors.push(`blob corrupt: ${blob.hash}`);
  }
  return { ok: errors.length === 0, errors, manifest };
};

// The read surface for the settings card: newest-first package summaries
// from the manifests on disk. Deliberately CHEAP — it re-checks only the
// manifest checksum (bytes vs manifest.sha256), never the dump/blob hashes;
// full verification stays verifyBackupPackage's job (create-time, restore-
// time, drills). `manifest_ok: false` still surfaces, because a package
// whose manifest doesn't even checksum is not a backup to count on.
export const listBackupPackages = ({ backupsDir } = {}) => {
  if (!backupsDir || !existsSync(backupsDir)) return [];
  const packages = [];
  for (const entry of readdirSync(backupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const packageDir = path.join(backupsDir, entry.name);
    try {
      const manifestBytes = readFileSync(path.join(packageDir, 'manifest.json'));
      const expected = readFileSync(path.join(packageDir, 'manifest.sha256'), 'utf8').trim();
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      packages.push({
        name: entry.name,
        created_at: manifest.created_at || null,
        reason: manifest.reason || null,
        schema_version: manifest.schema_version || null,
        blob_count: manifest.blob_count ?? (manifest.blobs || []).length,
        dump_bytes: manifest.dump?.bytes ?? null,
        manifest_ok: hashEvidenceBytes(manifestBytes) === expected
      });
    } catch {
      packages.push({
        name: entry.name,
        created_at: null,
        reason: null,
        schema_version: null,
        blob_count: null,
        dump_bytes: null,
        manifest_ok: false
      });
    }
  }
  // created_at, newest first; a package with no readable manifest sinks to
  // the bottom (it is not a backup to count on, so it must never render as
  // "the last backup"), ordered among its kind by name.
  return packages.sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || '') || b.name.localeCompare(a.name)
  );
};

// Rolling window (v0: keep the newest N verified packages; the 14-daily/
// 8-weekly split is later polish). Also sweeps abandoned .incomplete-* dirs.
// Never deletes anything unless at least one SURVIVING package verifies —
// the window must not rotate the last good backup away behind a bad one.
export const rotateBackupPackages = ({ backupsDir, keep = 14, logger = console } = {}) => {
  if (!existsSync(backupsDir)) return { deleted: [] };
  const entries = readdirSync(backupsDir, { withFileTypes: true });
  const deleted = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('.incomplete-')) {
      rmSync(path.join(backupsDir, entry.name), { recursive: true, force: true });
      deleted.push(entry.name);
    }
  }
  const packages = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .reverse(); // stamp prefix sorts newest-first
  if (packages.length <= keep) return { deleted };
  const survivors = packages.slice(0, keep);
  const survivorVerifies = survivors.some(
    (name) => verifyBackupPackage({ packageDir: path.join(backupsDir, name) }).ok
  );
  if (!survivorVerifies) {
    logger.warn?.('[backup] rotation skipped: no surviving package verifies — refusing to delete older backups');
    return { deleted, skipped: 'no_verified_survivor' };
  }
  for (const name of packages.slice(keep)) {
    rmSync(path.join(backupsDir, name), { recursive: true, force: true });
    deleted.push(name);
  }
  return { deleted };
};

// Restore into the database DATABASE_URL points at (the drill shape: a
// fresh instance / clean Mac — plan §8). Verifies the package FIRST,
// refuses a dirty target unless told otherwise, copies blobs into the
// store, then re-checks EVERY restored index row against the store — the
// plan's hash-verification-on-restore, and the safety net under the
// dump↔GC race noted in createBackupPackage.
export const restoreBackupPackage = async ({
  packageDir, blobDir, pgBin, databaseUrl, allowNonEmpty = false, logger = console, execFileImpl
} = {}) => {
  if (!packageDir || !blobDir || !pgBin || !databaseUrl) {
    throw new Error('restoreBackupPackage needs packageDir, blobDir, pgBin, and databaseUrl.');
  }
  const verification = verifyBackupPackage({ packageDir });
  if (!verification.ok) {
    throw new Error(`Refusing to restore an unverified package: ${verification.errors.join('; ')}`);
  }
  const tools = makePgTools({ pgBin, databaseUrl, execFileImpl });

  const existingTables = await tools.psql(
    "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema', 'storage')"
  );
  if (existingTables !== '0' && !allowNonEmpty) {
    throw new Error(
      `Target database is not empty (${existingTables} tables). Restore into a fresh database, or pass allowNonEmpty.`
    );
  }

  await tools.pgRestore(path.join(packageDir, verification.manifest.dump.file));

  for (const blob of verification.manifest.blobs || []) {
    const target = blobPathForHash(blobDir, blob.hash);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(packageBlobPath(packageDir, blob.hash), target);
  }

  const restoredHashes = await tools.psql(
    'select distinct content_hash from local_evidence_objects order by content_hash'
  );
  const missing = [];
  for (const hash of restoredHashes ? restoredHashes.split('\n').filter(Boolean) : []) {
    const file = blobPathForHash(blobDir, hash);
    if (!existsSync(file) || sha256File(file) !== hash) missing.push(hash);
  }
  const report = {
    restored: true,
    schema_version: verification.manifest.schema_version,
    blob_count: (verification.manifest.blobs || []).length,
    missing_blobs: missing
  };
  if (missing.length) {
    logger.error?.(`[backup] restore completed WITH ${missing.length} missing/corrupt blob(s): ${missing.join(', ')}`);
  } else {
    logger.log?.(`[backup] restore verified: schema ${report.schema_version}, ${report.blob_count} blobs intact`);
  }
  return report;
};

// Pre-migration trigger support: true when the migrations dir carries a
// version newer than the DB's latest applied one. A virgin DB (no
// schema_migrations) has nothing to protect — returns false.
export const hasPendingMigrations = async ({ pgBin, databaseUrl, migrationsDir, execFileImpl } = {}) => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) return false;
  const latestFile = files[files.length - 1].replace(/\.sql$/, '');
  const tools = makePgTools({ pgBin, databaseUrl, execFileImpl });
  let applied;
  try {
    applied = await tools.psql('select max(version) from schema_migrations');
  } catch {
    return false; // virgin database — first boot, nothing to back up yet
  }
  if (!applied) return false;
  return applied < latestFile;
};
