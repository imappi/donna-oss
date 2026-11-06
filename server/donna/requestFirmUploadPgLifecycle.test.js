// RT-03 (audit F-03) — one firm resolver, real PostgreSQL proof.
//
// The first-run shape: NO DONNA_DEFAULT_FIRM_ID in the environment, one firm
// row minted as `firm-<slug>`, the desktop boot re-pointing the LIVE default
// to it. Before this slice the upload-url route keyed evidence under the
// literal 'donna-demo-firm' and resolved admission from the env-only
// resolver, so a real firm's evidence landed under the demo tenant and the
// upload_sign / local_blob_put readiness boundaries were silently
// unenforced (not enrolled ⇒ allowed, token without a readiness claim).
//
// This fixture drives the actual route without firm_id — the way the SPA
// calls it — and pins: the key prefix is the firm's own id; an allowed
// admission for THAT firm is what the signed token carries; a blocked
// admission for THAT firm is what the audit trail records; and the
// storage-orphan sweep attributes only to firms/clients that exist.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { handleDonnaApiRequest } from './api.js';
import { createDonnaRuntimeServer } from './desktop/runtimeServer.js';
import { verifyLocalEvidenceAccess } from './evidenceStorage.js';
import {
  __endFirmDbPoolForTests,
  createClientInDb,
  getDefaultFirmId,
  withFirmDbClient
} from './firmDb.js';
import { provisionEntityReadiness } from './runtimeReadiness.js';
import {
  ENTITY_READINESS_ADMISSION_ERROR,
  ENTITY_READINESS_BLOCKED_ACTION
} from './runtimeReadinessAdmission.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO_FIRM_ID = 'donna-demo-firm';
const FIRM_ID = 'firm-test-x';
const MEMBER_ID = 'member-test-x';
const CLIENT_ID = 'client-test-x';
const ACCESS_TOKEN = 'request-firm-upload-runtime-token';
const BUCKET = 'donna-evidence';

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const createResponse = (resolve) => {
  const headers = new Map();
  const chunks = [];
  return {
    statusCode: 200,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* binary response */ }
      resolve({ statusCode: this.statusCode, headers: Object.fromEntries(headers), body, json });
    }
  };
};

const requestApi = async ({ method = 'GET', url, headers = {}, body } = {}) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return new Promise((resolve, reject) => {
    const res = createResponse(resolve);
    Promise.resolve(handleDonnaApiRequest(req, res)).catch(reject);
  });
};

const authJson = { authorization: `Bearer ${ACCESS_TOKEN}`, 'content-type': 'application/json' };

// The SPA's call shape: client_id, filename, mime_type, size — and NO firm_id
// (src/lib/firmApi.js createFirmDocumentUploadUrl).
const signWithoutFirmId = ({ filename, size }) => requestApi({
  method: 'POST',
  url: '/api/donna/firms/documents/upload-url',
  headers: authJson,
  body: JSON.stringify({ client_id: CLIENT_ID, filename, mime_type: 'application/pdf', size })
});

test(
  'real PG: a first-run firm with no firm_id on the request keys evidence under its own id and its readiness boundaries are enforced for it',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — RT-03 firm resolver not exercised' },
  async () => {
    const dbName = `donna_request_firm_${Date.now().toString(36)}_${process.pid}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-request-firm-blobs-'));
    const socketPath = `/tmp/donna-rt03-${process.pid}-${Date.now().toString(36)}.sock`;
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
      'ANTHROPIC_API_KEY'
    ];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const priorWarn = console.warn;
    const warnings = [];
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
      // The firm the desktop first-run mint produces: `firm-<slug>`, and the
      // ONLY firms row on the book. The demo tenant does not exist here.
      await seed.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency, metadata)
         values ($1, 'Test X Ltd', 'test-x', 'GB', 'GBP', '{"created_via":"desktop_first_run"}'::jsonb)`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status, access_level)
         values ($1, $2, 'owner@test-x.test', 'Test X Owner', 'admin', 'active', 'owner')`,
        [MEMBER_ID, FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '2';
      // The first-run shape: nothing configured. The live default is whatever
      // the boot re-points it to — and the route must follow THAT.
      delete process.env.DONNA_DEFAULT_FIRM_ID;
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
      process.env.DONNA_BUILD_COMMIT_SHA = 'rt03-request-firm-build';
      process.env.DONNA_BUILD_DIRTY = 'false';
      process.env.DONNA_RUNTIME_BUILD_DIRTY = 'false';
      process.env.DONNA_DESKTOP_SCHEDULER = 'on';
      process.env.DONNA_ACCESS_TOKEN = ACCESS_TOKEN;
      process.env.OPENAI_API_KEY = 'rt03-presence-only';
      process.env.ANTHROPIC_API_KEY = 'rt03-presence-only';

      // Precondition the bug lives on: firmDb baked the demo id at load.
      assert.equal(getDefaultFirmId(), DEMO_FIRM_ID, 'load-time default is the demo tenant');

      await createClientInDb({
        firmId: FIRM_ID,
        creationPrincipal: {
          principalType: 'firm_member',
          principalId: MEMBER_ID,
          authoritySource: 'rt03_request_firm_pg'
        },
        profile: {
          id: CLIENT_ID,
          companyName: 'Test X Apiary Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd'
        }
      });

      // The real desktop boot: resolves the sole firm and re-points the live
      // default (firmDb.adoptResolvedDefaultFirmId, reason desktop_boot_sole_firm).
      runtime = await createDonnaRuntimeServer({
        listen: { socketPath },
        logger: { log: () => {}, error: () => {} }
      });
      assert.equal(runtime.server.listening, true);
      assert.equal(runtime.schedulerRunning(), true, 'Host A must PASS so admission can be enforced');
      assert.equal(getDefaultFirmId(), FIRM_ID, 'boot re-pointed the live default to the sole firm');

      const observedAt = new Date().toISOString();
      const ready = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        creationPath: 'desktop_firm_intake',
        observedAt,
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'rt03_request_firm_pg', principal_id: MEMBER_ID }
      });
      assert.equal(ready.row.state, 'ready');

      // ── 1. Sign without firm_id: key under the firm's own id, admission
      //       evaluated (allowed, ENFORCED) for that firm — the token claim is
      //       the receipt of that decision.
      const bytes = Buffer.from(`rt03-first-run-evidence-${'x'.repeat(48)}`);
      const signed = await signWithoutFirmId({ filename: 'first-run.pdf', size: bytes.length });
      assert.equal(signed.statusCode, 200, signed.body);
      assert.equal(signed.json.provider, 'local_blob');
      assert.ok(
        String(signed.json.key).startsWith(`${FIRM_ID}/${CLIENT_ID}/`),
        `key must be under the firm's own id, got ${signed.json.key}`
      );
      assert.equal(String(signed.json.key).startsWith(`${DEMO_FIRM_ID}/`), false);
      // Origin-relative by contract: the SPA resolves it on whichever Donna
      // origin served the page (renderer or system-browser preview); a fixture
      // supplies the base a browser would.
      assert.ok(
        String(signed.json.signed_url).startsWith('/api/donna/evidence-local?token='),
        `signed_url must be origin-relative, got ${signed.json.signed_url}`
      );
      const signedUrl = new URL(signed.json.signed_url, 'http://127.0.0.1');
      const { claim } = verifyLocalEvidenceAccess({
        token: signedUrl.searchParams.get('token') || '',
        method: 'PUT'
      });
      assert.ok(claim, 'signed token verifies');
      assert.equal(claim.key, signed.json.key);
      assert.equal(claim.firmId, FIRM_ID, 'upload_sign admission was evaluated for the real firm');
      assert.equal(claim.clientId, CLIENT_ID);
      assert.equal(claim.entityDependencyDigest, ready.row.ready_dependency_digest);

      // The PUT rides the same claim through the local_blob_put boundary.
      const put = await requestApi({
        method: 'PUT',
        url: `${signedUrl.pathname}${signedUrl.search}`,
        headers: { 'content-type': 'application/pdf' },
        body: bytes
      });
      assert.equal(put.statusCode, 200, put.body);
      const stored = await seed.query('select bucket, key from local_evidence_objects order by key');
      assert.equal(stored.rowCount, 1);
      assert.equal(stored.rows[0].bucket, BUCKET);
      assert.equal(stored.rows[0].key, signed.json.key);
      assert.equal(
        (await seed.query(`select count(*)::int as n from local_evidence_objects where key like '${DEMO_FIRM_ID}/%'`)).rows[0].n,
        0,
        'nothing lands under the demo tenant'
      );

      // ── 2. Sign without firm_id while the entity is NOT ready: the refusal
      //       and its receipt name the real firm, not the demo tenant.
      await seed.query(
        `update entity_readiness_sagas
            set state = 'failed',
                ready_dependency_digest = null,
                retry_state = 'scheduled',
                reason_code = 'rt03_forced_not_ready',
                responsible_system = 'donna_readiness',
                root_cause_receipt_id = latest_attempt_id,
                next_retry_at = now() + interval '1 hour',
                ready_at = null,
                failed_at = now(),
                updated_at = now()
          where firm_id = $1 and client_id = $2`,
        [FIRM_ID, CLIENT_ID]
      );
      const refused = await signWithoutFirmId({ filename: 'refused.pdf', size: 10 });
      assert.equal(refused.statusCode, 503, refused.body);
      assert.equal(refused.json.code, ENTITY_READINESS_ADMISSION_ERROR);
      const blocked = await seed.query(
        `select firm_id, client_id, resource_type, metadata
           from audit_events
          where action = $1
          order by id`,
        [ENTITY_READINESS_BLOCKED_ACTION]
      );
      assert.equal(blocked.rowCount, 1, 'exactly one blocked decision recorded');
      assert.equal(blocked.rows[0].firm_id, FIRM_ID);
      assert.equal(blocked.rows[0].client_id, CLIENT_ID);
      assert.equal(blocked.rows[0].resource_type, 'evidence_upload');
      assert.equal(blocked.rows[0].metadata.boundary, 'upload_sign');
      assert.equal(blocked.rows[0].metadata.reason_code, 'rt03_forced_not_ready');

      // ── 3. Storage-orphan sweep: attribution is validated against firms
      //       and clients that exist; an unknown prefix is a warning, never
      //       an audit row under a firm that is not there.
      await seed.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, status, payload,
            parse_status, parse_run_id, parse_attempts, storage_bucket, storage_object_key)
         values
           ($1, $2, $3, 'first-run.pdf', 'supplier_bill', 'received',
            $4::jsonb, 'pending', $5::uuid, 0, $6, $7)`,
        [
          'document-test-x', FIRM_ID, CLIENT_ID,
          JSON.stringify({ storage_provider: 'local_blob' }),
          crypto.randomUUID(), BUCKET, signed.json.key
        ]
      );
      const orphanKnown = `${FIRM_ID}/${CLIENT_ID}/evidence/2026-08/orphan-known.pdf`;
      const orphanGhostClient = `${FIRM_ID}/client-ghost/evidence/2026-08/orphan-ghost-client.pdf`;
      const orphanGhostFirm = `firm-ghost/client-ghost/evidence/2026-08/orphan-ghost-firm.pdf`;
      for (const key of [orphanKnown, orphanGhostClient, orphanGhostFirm]) {
        await seed.query(
          `insert into local_evidence_objects (bucket, key, content_hash, byte_length, content_type, created_at)
           values ($1, $2, $3, 12, 'application/pdf', now() - interval '2 hours')`,
          [BUCKET, key, crypto.createHash('sha256').update(key).digest('hex')]
        );
      }
      console.warn = (...args) => { warnings.push(args); };
      const sweep = await requestApi({
        method: 'GET',
        url: '/api/donna/firms/documents/parse-cron?task=storage_orphans',
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` }
      });
      console.warn = priorWarn;
      assert.equal(sweep.statusCode, 200, sweep.body);
      // DMEM-R1 W1 (INV-15): the two orphans under a firm on this book are deleted
      // (each authorized in the audit trail BEFORE the delete, then receipted);
      // the ghost-FIRM prefix is REFUSED — kept, counted, receipted — never deleted
      // unattributed.
      assert.equal(sweep.json.storage_orphans.deleted_total, 2, JSON.stringify(sweep.json.storage_orphans));
      assert.equal(sweep.json.storage_orphans.refused_total, 1, JSON.stringify(sweep.json.storage_orphans));
      assert.deepEqual(
        (await seed.query('select key from local_evidence_objects order by key')).rows.map((row) => row.key),
        [orphanGhostFirm, signed.json.key].sort(),
        'the referenced upload survives; the two attributable orphans are gone; the foreign-prefixed one is kept'
      );
      const cleaned = await seed.query(
        `select firm_id, client_id, resource_id
           from audit_events
          where action = 'storage.orphan_cleaned'
          order by resource_id`
      );
      assert.deepEqual(cleaned.rows, [
        { firm_id: FIRM_ID, client_id: null, resource_id: orphanGhostClient },
        { firm_id: FIRM_ID, client_id: CLIENT_ID, resource_id: orphanKnown }
      ]);
      const ghostWarnings = warnings.filter((args) =>
        args.some((arg) => JSON.stringify(arg).includes(orphanGhostFirm)));
      assert.equal(ghostWarnings.length, 1, `one warning for the unknown firm prefix, got ${JSON.stringify(warnings)}`);
      const authorized = await seed.query(
        `select resource_id from audit_events where action = 'storage.cleanup_authorized' order by resource_id`
      );
      assert.deepEqual(authorized.rows.map((row) => row.resource_id), [orphanGhostClient, orphanKnown], 'every delete was authorized in the trail first');
    } finally {
      console.warn = priorWarn;
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
      await rm(socketPath, { force: true });
      await rm(blobDir, { recursive: true, force: true });
    }
  }
);
