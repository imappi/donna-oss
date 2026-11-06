// backupPackage — plan §8's verified packages. Real filesystem, fake PG
// binaries (injected execFileImpl). What must hold: a package only earns
// its final name after self-verification (a crash leaves .incomplete, never
// a plausible-looking package); tampering with dump, blob, or manifest is
// caught; rotation never deletes the last verifying backup; restore refuses
// unverified packages and dirty targets, and reports missing blobs loudly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBackupPackage, hasPendingMigrations, listBackupPackages, parseLocalDatabaseUrl,
  restoreBackupPackage, rotateBackupPackages, verifyBackupPackage
} from './backupPackage.js';
import { blobPathForHash, hashEvidenceBytes } from './localBlobStore.js';

const DB_URL = 'postgresql://donna@localhost/donna_local?host=%2Ftmp%2Fsock&port=5433';
const NOW = () => new Date('2026-08-03T12:00:00Z');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'donna-backup-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let caseId = 0;
const freshDirs = () => {
  caseId += 1;
  const base = path.join(tmp, `case-${caseId}`);
  const dirs = { backupsDir: path.join(base, 'backups'), blobDir: path.join(base, 'documents') };
  mkdirSync(dirs.backupsDir, { recursive: true });
  mkdirSync(dirs.blobDir, { recursive: true });
  return dirs;
};

const seedBlob = (blobDir, content) => {
  const bytes = Buffer.from(content);
  const hash = hashEvidenceBytes(bytes);
  const file = blobPathForHash(blobDir, hash);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return hash;
};

const makeFakePg = ({ hashes = [], schema = '113_local_evidence_objects', tables = '0', dumpBytes = Buffer.from('FAKE-PG-DUMP') } = {}) => {
  const calls = [];
  return {
    calls,
    execFileImpl: async (file, args) => {
      const bin = path.basename(file);
      calls.push({ bin, args });
      if (bin === 'pg_dump') {
        writeFileSync(args[args.indexOf('-f') + 1], dumpBytes);
        return { stdout: '' };
      }
      if (bin === 'pg_restore') return { stdout: '' };
      if (bin === 'psql') {
        const sql = args[args.length - 1];
        if (sql.includes('content_hash')) return { stdout: hashes.join('\n') };
        if (sql.includes('schema_migrations')) return { stdout: schema };
        if (sql.includes('server_version')) return { stdout: '16.4' };
        if (sql.includes('pg_tables')) return { stdout: tables };
        return { stdout: '' };
      }
      throw new Error(`unexpected binary: ${bin}`);
    }
  };
};

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

test('parseLocalDatabaseUrl decodes the supervisor URL shape', () => {
  assert.deepEqual(parseLocalDatabaseUrl(DB_URL), {
    socketDir: '/tmp/sock', port: '5433', user: 'donna', database: 'donna_local'
  });
  assert.throws(() => parseLocalDatabaseUrl('postgresql://u@host/db'), /unix-socket/);
});

test('create → verified package with dump, blobs, manifest, checksum; no .incomplete left', async () => {
  const { backupsDir, blobDir } = freshDirs();
  const hash = seedBlob(blobDir, 'receipt bytes');
  const fake = makeFakePg({ hashes: [hash] });
  const result = await createBackupPackage({
    backupsDir, blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
    reason: 'daily', now: NOW, logger: quietLogger, execFileImpl: fake.execFileImpl
  });
  assert.ok(result.verified);
  assert.match(path.basename(result.packageDir), /^2026-08-03T12-00-00-000Z-daily$/);
  assert.ok(existsSync(path.join(result.packageDir, 'donna.dump')));
  assert.ok(existsSync(path.join(result.packageDir, 'manifest.sha256')));
  assert.equal(result.manifest.schema_version, '113_local_evidence_objects');
  assert.equal(result.manifest.blob_count, 1);
  assert.equal(result.manifest.blobs[0].hash, hash);
  assert.ok(!readdirSync(backupsDir).some((n) => n.startsWith('.incomplete-')), 'no incomplete dirs remain');
  assert.equal(verifyBackupPackage({ packageDir: result.packageDir }).ok, true);
});

test('a corrupt blob in the LIVE store fails the backup loudly and leaves nothing', async () => {
  const { backupsDir, blobDir } = freshDirs();
  const hash = seedBlob(blobDir, 'honest bytes');
  writeFileSync(blobPathForHash(blobDir, hash), 'swapped'); // corrupt on disk
  const fake = makeFakePg({ hashes: [hash] });
  await assert.rejects(
    () => createBackupPackage({
      backupsDir, blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
      now: NOW, logger: quietLogger, execFileImpl: fake.execFileImpl
    }),
    /corrupt in the live store/
  );
  assert.equal(readdirSync(backupsDir).length, 0, 'no package, no .incomplete');
});

test('verify catches a tampered dump, blob, and manifest', async () => {
  const { backupsDir, blobDir } = freshDirs();
  const hash = seedBlob(blobDir, 'blob to tamper');
  const fake = makeFakePg({ hashes: [hash] });
  const { packageDir } = await createBackupPackage({
    backupsDir, blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
    now: NOW, logger: quietLogger, execFileImpl: fake.execFileImpl
  });

  writeFileSync(path.join(packageDir, 'donna.dump'), 'TAMPERED');
  let report = verifyBackupPackage({ packageDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes('dump hash mismatch')));

  writeFileSync(path.join(packageDir, 'donna.dump'), 'FAKE-PG-DUMP'); // restore dump
  writeFileSync(path.join(packageDir, 'blobs', 'sha256', hash.slice(0, 2), `${hash}.bin`), 'evil');
  report = verifyBackupPackage({ packageDir });
  assert.ok(report.errors.some((e) => e.includes(`blob corrupt: ${hash}`)));

  const manifestPath = path.join(packageDir, 'manifest.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('"manual"', '"weekly"'));
  report = verifyBackupPackage({ packageDir });
  assert.ok(report.errors.some((e) => e.includes('manifest checksum mismatch')));
});

test('rotation keeps the newest N, sweeps .incomplete, and refuses to rotate behind bad survivors', async () => {
  const { backupsDir, blobDir } = freshDirs();
  const fake = makeFakePg({ hashes: [] });
  for (let day = 1; day <= 4; day += 1) {
    await createBackupPackage({
      backupsDir, blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL, reason: 'daily',
      now: () => new Date(`2026-08-0${day}T01:30:00Z`), logger: quietLogger, execFileImpl: fake.execFileImpl
    });
  }
  mkdirSync(path.join(backupsDir, '.incomplete-2026-08-05-crashed'));

  const first = rotateBackupPackages({ backupsDir, keep: 2, logger: quietLogger });
  assert.equal(first.deleted.length, 3, 'two old packages + one incomplete dir');
  const remaining = readdirSync(backupsDir).sort();
  assert.equal(remaining.length, 2);
  assert.ok(remaining[1].startsWith('2026-08-04'), 'newest survives');

  // Corrupt every survivor: rotation must refuse to delete anything older.
  for (const name of remaining) {
    writeFileSync(path.join(backupsDir, name, 'donna.dump'), 'ROT');
  }
  const blocked = rotateBackupPackages({ backupsDir, keep: 1, logger: quietLogger });
  assert.equal(blocked.skipped, 'no_verified_survivor');
  assert.equal(readdirSync(backupsDir).length, 2, 'nothing deleted behind bad survivors');
});

test('restore: refuses unverified packages and non-empty targets; happy path verifies every row', async () => {
  const { backupsDir, blobDir } = freshDirs();
  const hash = seedBlob(blobDir, 'restorable evidence');
  const fake = makeFakePg({ hashes: [hash] });
  const { packageDir } = await createBackupPackage({
    backupsDir, blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
    now: NOW, logger: quietLogger, execFileImpl: fake.execFileImpl
  });

  const dirty = makeFakePg({ hashes: [hash], tables: '7' });
  await assert.rejects(
    () => restoreBackupPackage({
      packageDir, blobDir: freshDirs().blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
      logger: quietLogger, execFileImpl: dirty.execFileImpl
    }),
    /not empty/
  );

  const target = freshDirs();
  const clean = makeFakePg({ hashes: [hash] });
  const report = await restoreBackupPackage({
    packageDir, blobDir: target.blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
    logger: quietLogger, execFileImpl: clean.execFileImpl
  });
  assert.deepEqual(report.missing_blobs, []);
  assert.ok(clean.calls.some((c) => c.bin === 'pg_restore'), 'pg_restore invoked');
  assert.ok(existsSync(blobPathForHash(target.blobDir, hash)), 'blob copied into the target store');

  writeFileSync(path.join(packageDir, 'donna.dump'), 'TAMPERED');
  await assert.rejects(
    () => restoreBackupPackage({
      packageDir, blobDir: target.blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
      logger: quietLogger, execFileImpl: clean.execFileImpl
    }),
    /Refusing to restore an unverified package/
  );
});

test('restore reports a hash the restored DB references but no store carries', async () => {
  const { backupsDir, blobDir } = freshDirs();
  const packaged = seedBlob(blobDir, 'packaged blob');
  const fake = makeFakePg({ hashes: [packaged] });
  const { packageDir } = await createBackupPackage({
    backupsDir, blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
    now: NOW, logger: quietLogger, execFileImpl: fake.execFileImpl
  });
  const ghost = hashEvidenceBytes(Buffer.from('referenced but never packaged'));
  const target = freshDirs();
  const restoredDb = makeFakePg({ hashes: [packaged, ghost] });
  const report = await restoreBackupPackage({
    packageDir, blobDir: target.blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
    logger: quietLogger, execFileImpl: restoredDb.execFileImpl
  });
  assert.deepEqual(report.missing_blobs, [ghost], 'the dump↔GC race surfaces loudly, never silently');
});

test('hasPendingMigrations: virgin false, current false, behind true', async () => {
  const migrationsDir = path.join(tmp, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(path.join(migrationsDir, '001_a.sql'), '--');
  writeFileSync(path.join(migrationsDir, '002_b.sql'), '--');

  const virgin = { execFileImpl: async () => { throw new Error('relation does not exist'); } };
  assert.equal(await hasPendingMigrations({ pgBin: '/f', databaseUrl: DB_URL, migrationsDir, execFileImpl: virgin.execFileImpl }), false);

  const current = makeFakePg({ schema: '002_b' });
  assert.equal(await hasPendingMigrations({ pgBin: '/f', databaseUrl: DB_URL, migrationsDir, execFileImpl: current.execFileImpl }), false);

  const behind = makeFakePg({ schema: '001_a' });
  assert.equal(await hasPendingMigrations({ pgBin: '/f', databaseUrl: DB_URL, migrationsDir, execFileImpl: behind.execFileImpl }), true);
});

test('listBackupPackages summarizes newest-first from manifests, cheaply and tolerantly', async () => {
  const { backupsDir, blobDir } = freshDirs();
  assert.deepEqual(listBackupPackages({ backupsDir: path.join(backupsDir, 'missing') }), []);

  const hash = seedBlob(blobDir, 'list-me');
  const fake = makeFakePg({ hashes: [hash] });
  await createBackupPackage({
    backupsDir, blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
    reason: 'daily', now: () => new Date('2026-08-06T01:30:00Z'), logger: { log: () => {} },
    execFileImpl: fake.execFileImpl
  });
  await createBackupPackage({
    backupsDir, blobDir, pgBin: '/fake/bin', databaseUrl: DB_URL,
    reason: 'manual', now: () => new Date('2026-08-07T09:00:00Z'), logger: { log: () => {} },
    execFileImpl: fake.execFileImpl
  });
  // Abandoned work dirs are invisible; a junk dir surfaces as manifest_ok:false.
  mkdirSync(path.join(backupsDir, '.incomplete-2026-08-08'), { recursive: true });
  mkdirSync(path.join(backupsDir, 'not-a-package'), { recursive: true });

  const listed = listBackupPackages({ backupsDir });
  assert.equal(listed.length, 3);
  assert.equal(listed[0].reason, 'manual');
  assert.equal(listed[0].created_at, '2026-08-07T09:00:00.000Z');
  assert.equal(listed[0].manifest_ok, true);
  assert.equal(listed[0].blob_count, 1);
  assert.ok(listed[0].dump_bytes > 0);
  assert.equal(listed[1].reason, 'daily');
  assert.equal(listed[2].name, 'not-a-package');
  assert.equal(listed[2].manifest_ok, false);

  // A tampered manifest reads as not-ok, not as a crash.
  const victim = listed[1];
  const manifestPath = path.join(backupsDir, victim.name, 'manifest.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('"daily"', '"weekly"'));
  const relisted = listBackupPackages({ backupsDir });
  assert.equal(relisted.find((p) => p.name === victim.name).manifest_ok, false);
});
