// Gate 2A — real PostgreSQL/local-storage product-path proof.
//
// A deterministic fictional PDF is rendered, then the Gate 2A runner drives
// the authenticated create route, generation-bound signed local PUT,
// /documents/register and the real inline parse worker. No interpreted row is
// inserted by the harness. The receipt must carry exact byte/source lineage,
// prove zero external destinations/model calls, and retire the isolated firm.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { runGate2a } from '../../scripts/eval_world_birth_to_parse.js';
import { buildDesktopHandlerManifest } from './desktop/handlerManifest.js';
import { createLocalScheduler } from './desktop/localScheduler.js';
import {
  __endFirmDbPoolForTests,
  queryFirmDb,
  withFirmDbClient,
} from './firmDb.js';
import { observeHostCertificateA } from './hostCertificateA.js';
import { persistHostReadinessAttempt } from './runtimeReadiness.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCESS_TOKEN = 'gate2a-real-pg-access-token';

test(
  'real PG/local storage: one raw first document reaches terminal parse through the mounted product path',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — Gate 2A real lifecycle not exercised' },
  async () => {
    const dbName = `donna_gate2a_${process.pid}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-gate2a-blobs-'));
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const envKeys = [
      'DATABASE_URL',
      'DATABASE_POOL_MAX',
      'DONNA_DEFAULT_FIRM_ID',
      'DONNA_DESKTOP_BLOB_DIR',
      'DONNA_BUILD_COMMIT_SHA',
      'DONNA_BUILD_DIRTY',
      'DONNA_DESKTOP_SCHEDULER',
      'DONNA_ACCESS_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'INNGEST_EVENT_KEY',
      'INNGEST_SIGNING_KEY',
      'CLIENT_CONFIG_FORCE_DISABLE',
      'AUTO_AI_CODING_ENABLED',
      'PARSE_DRAIN_THRESHOLD_SECONDS',
    ];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

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
          [file.replace(/\.sql$/, '')],
        );
      }

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '4';
      process.env.DONNA_DEFAULT_FIRM_ID = 'unused-gate2a-default';
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
      process.env.DONNA_BUILD_COMMIT_SHA = 'gate2a-real-pg-build';
      process.env.DONNA_BUILD_DIRTY = 'false';
      process.env.DONNA_DESKTOP_SCHEDULER = 'on';
      process.env.DONNA_ACCESS_TOKEN = ACCESS_TOKEN;
      process.env.OPENAI_API_KEY = 'gate2a-host-presence-only';
      process.env.ANTHROPIC_API_KEY = 'gate2a-host-presence-only';
      delete process.env.INNGEST_EVENT_KEY;
      delete process.env.INNGEST_SIGNING_KEY;

      const manifest = buildDesktopHandlerManifest({ rootDir: ROOT });
      const scheduler = createLocalScheduler({ manifest, client: seed, pollIntervalMs: 60 * 60 * 1000 });
      await scheduler.initialize();
      const hostObservedAt = new Date().toISOString();
      const hostCertificate = await observeHostCertificateA({
        env: process.env,
        rootDir: ROOT,
        observedAt: hostObservedAt,
        manifest,
        schedulerEnabled: true,
        query: (text, params) => queryFirmDb(text, params),
      });
      assert.equal(hostCertificate.status, 'PASS', JSON.stringify(hostCertificate.checks, null, 2));
      await persistHostReadinessAttempt({
        withFirmDbClientFn: withFirmDbClient,
        certificate: hostCertificate,
        eventType: 'boot',
      });

      const receipt = await runGate2a({
        runToken: `pg-lifecycle-${process.pid}`,
        actor: { type: 'operator', id: 'gate2a-real-pg-operator' },
        observedAt: new Date().toISOString(),
      });

      assert.equal(receipt.status, 'passed', JSON.stringify(receipt.failure));
      assert.equal(receipt.product_handshake.terminal, 'ready_document_work_queued');
      assert.equal(receipt.source_inventory.registration.parse_status, 'completed');
      assert.equal(receipt.source_inventory.parsed_transactions.length, 1);
      assert.equal(receipt.source_inventory.parsed_transactions[0].source, 'async_parse');
      assert.equal(receipt.source_inventory.parsed_transactions[0].money_in, 100);
      assert.equal(receipt.source_inventory.injection_guard.interpreted_row_injection, false);
      assert.equal(receipt.spend.solveCalls, 0);
      assert.equal(receipt.isolation.external_destinations, 'isolated');
      assert.equal(receipt.isolation.counts.firm_members, 1, 'the sole member is the inert EAW operator identity');
      assert.ok(Object.entries(receipt.isolation.counts)
        .filter(([name]) => name !== 'firm_members')
        .every(([, count]) => count === 0));
      assert.equal(receipt.cleanup.storage_delete.deleted, 1);
      assert.equal(receipt.cleanup.delete_receipt.residue_verified, true);
      assert.equal(receipt.cleanup.post_delete_residue.residue_rows, 0);

      const retained = await seed.query(
        `select metadata->>'created_via' as created_via,
                metadata ? 'eaw_retired_at' as retired
           from firms where id = $1`,
        [`eaw-pg-lifecycle-${process.pid}`],
      );
      assert.deepEqual(retained.rows[0], { created_via: 'eaw_lifecycle', retired: true });
      assert.equal((await seed.query('select count(*)::int as count from local_evidence_objects')).rows[0].count, 0);
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      await seed.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName],
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
      await rm(blobDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
