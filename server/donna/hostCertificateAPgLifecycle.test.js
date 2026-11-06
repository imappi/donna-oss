// Host Certificate A queue health on real PostgreSQL.
//
// The v3 predicate — a dead cron tick superseded by a later succeeded run of
// the same function is residue, unsuperseded dead work still fails the host —
// lives in one SQL aggregate. The unit suite exercises it through a mock
// client, which is exactly the chain that cannot catch a real-Postgres pin
// (the 2026-08-31 lesson), so this file proves the semantics on live rows.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { observeHostCertificateA } from './hostCertificateA.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CRON_FUNCTION = 'parse-cron:drain';
const OBSERVER_ENV = {
  DATABASE_URL: 'postgresql://bound-through-query-param.invalid/unused',
  DONNA_BUILD_COMMIT_SHA: 'hostcert-pg-test',
  DONNA_BUILD_DIRTY: 'false'
};
const MANIFEST = [{
  functionId: CRON_FUNCTION, kind: 'http-cron', cron: '*/10 * * * *', maxAttempts: 1,
  concurrency: 1, leaseMs: 1000, timeoutMs: 1000, handlerVersion: '1', run: async () => {}
}];

const databaseCheckOf = async (seed) => {
  const certificate = await observeHostCertificateA({
    env: OBSERVER_ENV,
    rootDir: ROOT,
    observedAt: new Date().toISOString(),
    manifest: MANIFEST,
    schedulerEnabled: true,
    query: (text, params) => seed.query(text, params)
  });
  return certificate.checks.find(({ id }) => id === 'database_schema');
};

const insertJob = (seed, { functionId, status, completedAt }) => seed.query(
  `insert into local_jobs (function_id, status, attempt_count, max_attempts, last_error, completed_at)
   values ($1, $2, 1, 1, $3, $4::timestamptz)`,
  [functionId, status, status === 'dead' ? 'timed out after 300000ms' : null, completedAt]
);

test(
  'real PG: superseded dead cron ticks stay reported residue, unsuperseded dead work fails the database check',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — host queue semantics not exercised on real PG' },
  async () => {
    const dbName = `donna_hostcert_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`drop database if exists "${dbName}"`);
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();
    try {
      await seed.query(`
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key, name text, public boolean,
          file_size_limit bigint, allowed_mime_types text[]);
        create table if not exists storage.objects (
          id uuid default gen_random_uuid() primary key,
          bucket_id text references storage.buckets(id), name text, metadata jsonb);
      `);
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      for (const file of migrations) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await seed.query(
          'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
          [file.replace(/\.sql$/, '')]
        );
      }

      // v5 (RT-01): this observer env holds NO provider key. That is a lane
      // receipt, never an incomplete host — the database check below is the
      // only check this suite ever lets fail.
      const keyless = await observeHostCertificateA({
        env: OBSERVER_ENV,
        rootDir: ROOT,
        observedAt: new Date().toISOString(),
        manifest: MANIFEST,
        schedulerEnabled: true,
        query: (text, params) => seed.query(text, params)
      });
      const keylessRoutes = keyless.checks.find(({ id }) => id === 'model_routes');
      assert.equal(keylessRoutes.status, 'PASS');
      assert.deepEqual(keylessRoutes.detail.dark_providers, ['anthropic', 'openai', 'typesafe']);
      assert.ok(keylessRoutes.detail.dark_lanes.includes('jev_reconciliation'));

      // A dead tick with a LATER success of the same cron function: residue.
      await insertJob(seed, { functionId: CRON_FUNCTION, status: 'dead', completedAt: '2026-08-28T20:54:36.353Z' });
      await insertJob(seed, { functionId: CRON_FUNCTION, status: 'succeeded', completedAt: '2026-08-29T09:00:00.000Z' });
      const residue = await databaseCheckOf(seed);
      assert.equal(residue.status, 'PASS', JSON.stringify(residue.detail, null, 2));
      assert.equal(residue.detail.queue.dead, 1, 'residue stays visible in the receipt');
      assert.equal(residue.detail.queue.dead_unsuperseded, 0);

      // The same cron function dead AFTER its last success: currently failing.
      await insertJob(seed, { functionId: CRON_FUNCTION, status: 'dead', completedAt: '2026-08-30T10:00:00.000Z' });
      const failing = await databaseCheckOf(seed);
      assert.equal(failing.status, 'FAIL');
      assert.equal(failing.detail.queue.dead, 2);
      assert.equal(failing.detail.queue.dead_unsuperseded, 1);

      // Repair: a newer success supersedes it again; then a dead NON-cron job
      // (real lost work — no tick ever redoes it) fails the host regardless.
      await insertJob(seed, { functionId: CRON_FUNCTION, status: 'succeeded', completedAt: '2026-08-30T11:00:00.000Z' });
      const repaired = await databaseCheckOf(seed);
      assert.equal(repaired.status, 'PASS', JSON.stringify(repaired.detail, null, 2));
      await insertJob(seed, { functionId: 'one-off-client-export', status: 'dead', completedAt: '2026-08-01T00:00:00.000Z' });
      await insertJob(seed, { functionId: 'one-off-client-export', status: 'succeeded', completedAt: '2026-08-30T12:00:00.000Z' });
      const lostWork = await databaseCheckOf(seed);
      assert.equal(lostWork.status, 'FAIL', 'a dead non-cron job is lost work even beside later successes');
      assert.equal(lostWork.detail.queue.dead_unsuperseded, 1);
    } finally {
      await seed.end();
      await admin.query(`drop database if exists "${dbName}"`);
      await admin.end();
    }
  }
);
