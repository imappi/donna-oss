// RT-01 acceptance fixture (docs/plan-2026-09-01-runtime-refactor-slices.md;
// audit finding F-01): a desktop host holding ONE provider key keeps its
// scheduler, certifies entities, and receipts its dark model lanes. A missing
// optional credential is a lane receipt on Host Certificate A and on the
// public health route — never a host failure.
//
// Before v5 the laptop's only blocker was `model_routes` INCOMPLETE for a
// missing ANTHROPIC_API_KEY (2026-08-31 evening handoff §3). INCOMPLETE was
// neither mutation-ready nor queue-recoverable, so the local scheduler never
// started and every enrolled entity failed `host_certificate_not_pass`. This
// suite pins the product outcome on the real desktop assembly, not a helper:
// the same createDonnaRuntimeServer the Electron shell boots.

import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { createDonnaRuntimeServer } from './desktop/runtimeServer.js';
import { defaultDotEnvFiles } from './desktop/providerKeyDotEnv.js';
import { __endFirmDbPoolForTests, createClientInDb, withFirmDbClient } from './firmDb.js';
import { HOST_CERTIFICATE_A_VERSION } from './hostCertificateA.js';
import { provisionEntityReadiness } from './runtimeReadiness.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-lane-decoupling-pg';
const MEMBER_ID = 'member-lane-decoupling-pg';
const CLIENT_ID = 'client-lane-decoupling-pg';
const OPENAI_PRESENCE_ONLY = 'rt01-openai-presence-only-not-a-key';

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

// The desktop boot fills provider keys from the repo's .env files where the
// process env is unset (providerKeyDotEnv.js). A developer machine whose .env
// carries an Anthropic key cannot stage "Anthropic absent"; CI never has one.
// A visible skip, never a silent green — same posture as the missing-PG skip.
const dotEnvSupplyingAnthropicKey = () => defaultDotEnvFiles().find((file) => {
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .some((line) => /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?[^"'\s]+/.test(line));
});

const skipReason = () => {
  if (!PG_URL) return 'DONNA_PG_TEST_URL not set — OpenAI-only desktop boot not exercised on real PG';
  const dotEnv = dotEnvSupplyingAnthropicKey();
  if (dotEnv) return `${path.basename(dotEnv)} supplies ANTHROPIC_API_KEY — cannot stage an Anthropic-dark host here`;
  return false;
};

// A GET over the runtime's Unix socket: { status, text }.
const requestOverSocket = (socketPath, path) => new Promise((resolve, reject) => {
  const request = http.request({ socketPath, method: 'GET', path }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  });
  request.on('error', reject);
  request.end();
});

test(
  'real PG: an OpenAI-only desktop boot passes Host A, admits the scheduler, certifies an entity, and receipts the dark Anthropic lanes',
  { skip: skipReason() },
  async () => {
    const dbName = `donna_lane_${Date.now().toString(36)}_${process.pid}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-lane-decoupling-'));
    const socketPath = path.join(os.tmpdir(), `donna-rt01-${process.pid}.sock`);
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
      'DONNA_RUNTIME_BUILD_DIRTY',
      'DONNA_DESKTOP_SCHEDULER',
      'DONNA_ACCESS_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'TYPESAFE_API_KEY',
      'OPENAI_COMPATIBLE_API_KEY',
      'OPENAI_COMPATIBLE_BASE_URL'
    ];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    let runtime = null;

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
      await seed.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency)
         values ($1, 'Lane Decoupling Firm', 'lane-decoupling-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status)
         values ($1, $2, 'founder@lane-decoupling.test', 'Lane Founder', 'admin', 'active')`,
        [MEMBER_ID, FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '3';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
      process.env.DONNA_BUILD_COMMIT_SHA = 'rt01-lane-decoupling-build';
      process.env.DONNA_BUILD_DIRTY = 'false';
      process.env.DONNA_RUNTIME_BUILD_DIRTY = 'false';
      process.env.DONNA_DESKTOP_SCHEDULER = 'on';
      process.env.DONNA_ACCESS_TOKEN = 'rt01-runtime-token';
      process.env.OPENAI_API_KEY = OPENAI_PRESENCE_ONLY;
      // The staged host: exactly one provider key. Anthropic-keyed lanes
      // (unified extractor, reconciliation reasoning, chat, K1, triage…) are
      // dark; the parse, coding and ask-drafting lanes are not.
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.TYPESAFE_API_KEY;
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
      delete process.env.OPENAI_COMPATIBLE_BASE_URL;

      runtime = await createDonnaRuntimeServer({
        listen: { socketPath },
        logger: { log: () => {}, error: () => {}, warn: () => {} }
      });

      // 1. Host Certificate A: PASS, the dark lanes on the receipt.
      const host = (await seed.query(
        `select h.status, h.reason_code, a.certificate
           from runtime_host_readiness h
           join runtime_host_readiness_attempts a on a.id = h.latest_attempt_id
          where h.host_id = 'desktop-local'`
      )).rows[0];
      assert.ok(host, 'the desktop boot persisted a Host A receipt');
      const checkSummary = () => JSON.stringify((host.certificate?.checks || []).map(({ id, status, detail }) => [id, status, detail?.reason || null]));
      assert.equal(host.status, 'PASS', `an OpenAI-only host must PASS Host A: ${checkSummary()}`);
      assert.equal(host.reason_code, null);
      assert.equal(host.certificate.version, HOST_CERTIFICATE_A_VERSION);
      const modelRoutes = host.certificate.checks.find(({ id }) => id === 'model_routes');
      assert.equal(modelRoutes.status, 'PASS', 'a missing optional credential is a receipt, not an incomplete probe');
      assert.deepEqual(modelRoutes.detail.dark_providers, ['anthropic', 'typesafe']);
      assert.ok(modelRoutes.detail.dark_lanes.includes('jev_reconciliation'), 'Jev stays dark without its credential');
      assert.ok(modelRoutes.detail.dark_lanes.includes('reconciliation_reasoning'), 'the dark lanes are named on the receipt');
      // RT-12: the unified extractor is provider-agnostic — the OpenAI key lights it.
      assert.ok(!modelRoutes.detail.dark_lanes.includes('unified_extraction'), 'the unified lane is lit through the OpenAI key');
      assert.ok(!modelRoutes.detail.dark_lanes.includes('type_extractors_legacy'), 'the lit OpenAI lanes are not reported dark');
      assert.equal(
        modelRoutes.detail.lanes.find(({ lane_id }) => lane_id === 'transaction_coding').credential_present,
        true
      );
      assert.equal(
        modelRoutes.detail.lanes.find(({ lane_id }) => lane_id === 'reconciliation_reasoning').credential_present,
        false
      );
      assert.ok(
        !JSON.stringify(host.certificate).includes(OPENAI_PRESENCE_ONLY),
        'the certificate never carries key material'
      );

      // 2. The scheduler is admitted: parse drain, disposition sweeps, ask
      //    drafting and readiness heals all ride it.
      assert.equal(runtime.schedulerRunning(), true, 'the local scheduler runs on an OpenAI-only host');

      // 3. The public health receipt names lane status as booleans, never a key.
      //    (RT-14 deleted the runtime's own socket-fetch shim — the manifest no
      //    longer self-calls — so this fixture dials the socket itself.)
      const health = await requestOverSocket(socketPath, '/api/donna/firms/health');
      assert.equal(health.status, 200);
      const healthBody = JSON.parse(health.text);
      assert.deepEqual(healthBody.model_lanes, { openai: true, anthropic: false, openai_compatible: false, typesafe: false });
      assert.ok(!JSON.stringify(healthBody).includes(OPENAI_PRESENCE_ONLY), 'the health receipt never carries key material');

      // 4. An enrolled entity certifies ready against this host.
      await createClientInDb({
        firmId: FIRM_ID,
        profile: {
          id: CLIENT_ID,
          companyName: 'Lane Decoupling Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd'
        },
        creationPrincipal: {
          principalType: 'firm_member',
          principalId: MEMBER_ID,
          authoritySource: 'rt01_lane_decoupling'
        }
      });
      const ready = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        creationPath: 'desktop_firm_intake',
        observedAt: new Date().toISOString(),
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'rt01_lane_decoupling', principal_id: MEMBER_ID }
      });
      const hostCompatibility = ready.certificate.checks.find(({ id }) => id === 'host_compatibility');
      assert.equal(
        hostCompatibility.status,
        'PASS',
        `Certificate B host compatibility on an OpenAI-only host: ${JSON.stringify(hostCompatibility.detail?.failures)}`
      );
      assert.equal(ready.row.state, 'ready', JSON.stringify(ready.certificate.checks.map(({ id, status }) => [id, status])));
      assert.equal(ready.row.reason_code, null);
    } finally {
      if (runtime) await runtime.stop().catch(() => {});
      await __endFirmDbPoolForTests();
      for (const key of envKeys) restoreEnv(key, priorEnv[key]);
      await seed.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
      await rm(blobDir, { recursive: true, force: true });
      await rm(socketPath, { force: true });
    }
  }
);
