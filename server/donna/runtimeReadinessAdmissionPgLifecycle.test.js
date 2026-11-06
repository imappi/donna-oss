import { withAdmissionCleanupDeadline } from './db/admissionLeaseLifecycle.js';
import { applyCreditApplicationsWithClient, withCreditApplicationTransaction } from './creditNoteApplications.js';
import { acquireEntityReadinessAdmissionLeaseWithClient } from './runtimeReadinessAdmission.js';
// Gate 1B.2 — enforced entity admission, real PostgreSQL/local-storage proof.
//
// One explicitly enrolled desktop client reaches ready, mints a generation-
// bound local upload token, then loses a load-bearing dependency before the
// byte PUT. The migration trigger invalidates the saga before every production
// mutation seam is exercised. All refuse onto the system recovery lane, no
// business mutation lands, reads stay open, and a bounded retry resumes the
// same saga and the original upload.

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { findActiveActionAuthorityGrant } from './actionAuthorityGrants.js';
import { handleDonnaApiRequest } from './api.js';
import { storeInboundMediaAsEvidence } from './channels/inboundCore.js';
import { ENTITY_READINESS_ADMISSION_FLAG, setClientFlagStage } from './clientConfig.js';
import { buildDesktopHandlerManifest } from './desktop/handlerManifest.js';
import { createLocalScheduler } from './desktop/localScheduler.js';
import { DESKTOP_CLIENT_FLAG_SEEDS } from './desktop/hostPlaneSeed.js';
import {
  __endFirmDbPoolForTests,
  __writeLedgerJournalRows,
  createClientInDb,
  getFirmSnapshotFromDb,
  queryFirmDb,
  sendClientAskBatchInDb,
  withFirmDbClient
} from './firmDb.js';
import { observeHostCertificateA } from './hostCertificateA.js';
import { claimParseRunInDb, registerDocumentInDb } from './parseDocumentsDb.js';
import { findActiveAuthorityGrant } from './reconciliationAuthorityGrants.js';
import {
  ENTITY_READINESS_ADMISSION_ERROR,
  ENTITY_READINESS_BLOCKED_ACTION,
  ENTITY_READINESS_BOUNDARIES,
  EntityReadinessAdmissionError,
  evaluateEntityReadinessAdmissionWithClient,
  runWithEntityReadinessWorkerAdmission
} from './runtimeReadinessAdmission.js';
import { persistHostReadinessAttempt, provisionEntityReadiness } from './runtimeReadiness.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-readiness-admission-pg';
const MEMBER_ID = 'member-readiness-admission-pg';
const CLIENT_ID = 'client-readiness-admission-pg';
const DOCUMENT_ID = 'document-readiness-admission-pg';
const REGISTER_DOCUMENT_ID = 'document-register-refused-pg';
const PARSE_RUN_ID = '3bf7bf72-35f1-4dfc-9a32-79fbc53a5730';
const ASK_BATCH_ID = 'ask-readiness-admission-pg';
const ACCESS_TOKEN = 'gate1b2-runtime-token';

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

const scalarCounts = async (client) => {
  const { rows } = await client.query(`
    select
      (select count(*)::int from ledger_accounts where firm_id = $1 and client_id = $2) as accounts,
      (select count(*)::int from ledger_journals where firm_id = $1 and client_id = $2) as journals,
      (select count(*)::int from ledger_lines where firm_id = $1 and client_id = $2) as lines,
      (select count(*)::int from client_evidence_requests where firm_id = $1 and client_id = $2) as asks,
      (select count(*)::int from local_evidence_objects) as blobs
  `, [FIRM_ID, CLIENT_ID]);
  return rows[0];
};

test(
  'real PG/local storage: dependency invalidation fences every irreversible seam and recovery resumes the same saga',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — Gate 1B.2 admission lifecycle not exercised' },
  async () => {
    const dbName = `donna_readiness_admission_${Date.now().toString(36)}_${process.pid}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-readiness-admission-blobs-'));
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
      'ANTHROPIC_API_KEY'
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
          [file.replace(/\.sql$/, '')]
        );
      }

      await seed.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency)
         values ($1, 'Admission Firm', 'readiness-admission-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status)
         values ($1, $2, 'founder@admission.test', 'Admission Founder', 'admin', 'active')`,
        [MEMBER_ID, FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '4';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
      process.env.DONNA_BUILD_COMMIT_SHA = 'gate1b2-real-pg-build';
      process.env.DONNA_BUILD_DIRTY = 'false';
      process.env.DONNA_DESKTOP_SCHEDULER = 'on';
      process.env.DONNA_ACCESS_TOKEN = ACCESS_TOKEN;
      process.env.OPENAI_API_KEY = 'gate1b2-presence-only';
      process.env.ANTHROPIC_API_KEY = 'gate1b2-presence-only';

      const manifest = buildDesktopHandlerManifest({ rootDir: ROOT });
      const scheduler = createLocalScheduler({
        manifest,
        client: seed,
        pollIntervalMs: 60 * 60 * 1000
      });
      await scheduler.initialize();
      const observedAt = new Date().toISOString();
      const hostCertificate = await observeHostCertificateA({
        env: process.env,
        rootDir: ROOT,
        observedAt,
        manifest,
        schedulerEnabled: true,
        query: (text, params) => queryFirmDb(text, params)
      });
      assert.equal(hostCertificate.status, 'PASS', JSON.stringify(hostCertificate.checks, null, 2));
      await persistHostReadinessAttempt({
        withFirmDbClientFn: withFirmDbClient,
        certificate: hostCertificate,
        eventType: 'boot'
      });

      await createClientInDb({
        firmId: FIRM_ID,
        profile: {
          id: CLIENT_ID,
          companyName: 'Ready Admission Apiary Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd'
        },
        creationPrincipal: {
          principalType: 'firm_member',
          principalId: MEMBER_ID,
          authoritySource: 'gate1b2_real_pg'
        }
      });
      const firstReady = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        creationPath: 'desktop_firm_intake',
        observedAt,
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'gate1b2_real_pg', principal_id: MEMBER_ID }
      });
      assert.equal(firstReady.row.state, 'ready');

      // Add both authority planes to the certified baseline. The first insert
      // invalidates attempt 1; one retry certifies the complete baseline.
      await seed.query(
        `insert into reconciliation_authority_grants
           (id, firm_id, client_id, scope_kind, scope_key, archetype, action,
            amount_ceiling, currency, authorized_by_actor_type,
            authorized_by_actor_id, source, status)
         values
           ('recon-readiness-admission', $1, $2, 'merchant', 'merchant:apiary-rent',
            'recurring_rent_lease', 'accept_match', 1000, 'GBP', 'firm_operator',
            $3, 'operator_one_click', 'active')`,
        [FIRM_ID, CLIENT_ID, MEMBER_ID]
      );
      await seed.query(
        `insert into action_authority_grants
           (id, firm_id, client_id, domain, action_type, scope_kind, scope_key,
            amount_ceiling, currency, authorized_by_actor_type,
            authorized_by_actor_id, source, status)
         values
           ('action-readiness-admission', $1, $2, 'outbound', 'send_quote',
            'counterparty', 'party-1', 1000, 'GBP', 'owner', $3,
            'owner_approval', 'active')`,
        [FIRM_ID, CLIENT_ID, MEMBER_ID]
      );
      const certified = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        retry: true,
        lifecycle: 'retry',
        compatibilityScope: 'current_generation_compatibility',
        observedAt: new Date().toISOString(),
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'authority_baseline_retry', principal_id: MEMBER_ID }
      });
      assert.equal(certified.row.state, 'ready');
      // Episode budget (migration 130): 'ready' closes the episode at 0.
      assert.equal(Number(certified.row.attempt_count), 0);

      // Idempotent account upserts name the projected columns in their UPDATE
      // clause. PostgreSQL UPDATE OF triggers still fire for name=name, so the
      // migration must compare the actual certificate projection and avoid a
      // readiness churn on a semantic no-op.
      await seed.query(
        'update ledger_accounts set name = name where firm_id = $1 and client_id = $2',
        [FIRM_ID, CLIENT_ID]
      );
      assert.equal((await seed.query(
        'select state from entity_readiness_sagas where firm_id = $1 and client_id = $2',
        [FIRM_ID, CLIENT_ID]
      )).rows[0].state, 'ready');

      // Only this explicit manual canary row enables enforcement. Migration
      // 127 excludes the extension row itself from the certified digest.
      await setClientFlagStage(seed, {
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        flagKey: ENTITY_READINESS_ADMISSION_FLAG,
        stage: 'canary',
        source: 'manual',
        reason: 'Gate 1B.2 isolated EAW certificate',
        actorType: 'firm_member',
        actorId: MEMBER_ID
      });
      const stillReady = await seed.query(
        'select state, attempt_count from entity_readiness_sagas where firm_id = $1 and client_id = $2',
        [FIRM_ID, CLIENT_ID]
      );
      assert.deepEqual(stillReady.rows[0], { state: 'ready', attempt_count: 0 });

      // Real session cleanup: a completed worker must not leave a shared
      // admission lock blocking provisioning on another PostgreSQL connection.
      const leaseKey = `entity-readiness:${FIRM_ID}:${CLIENT_ID}`;
      const exclusiveAvailable = async () => {
        const acquired = (await seed.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [leaseKey])).rows[0].acquired;
        if (acquired) await seed.query('select pg_advisory_unlock(hashtextextended($1, 0))', [leaseKey]);
        return acquired;
      };
      const worker = (client, work) => runWithEntityReadinessWorkerAdmission({ client, firmId: FIRM_ID, clientId: CLIENT_ID, work });
      await withFirmDbClient(client => worker(client, async () => {
        assert.equal(await exclusiveAvailable(), false, 'the original whole-work fence stays held');
        return 'completed';
      }));
      assert.equal(await exclusiveAvailable(), true);
      await withFirmDbClient(async client => {
        const parameters = client.connectionParameters;
        let workRan = false;
        client.connectionParameters = { host: 'aws-0-private.pooler.supabase.com', port: 6543 };
        try {
          await assert.rejects(worker(client, async () => { workRan = true; }), { code: 'ADMISSION_SESSION_POOLING_UNSUPPORTED' });
        } finally { client.connectionParameters = parameters; }
        assert.equal(workRan, false);
        assert.equal(await exclusiveAvailable(), true, 'known incompatible endpoint is refused before taking a session lock');
      });

      // Error before outer rollback: cleanup sees 25P02, but the original SQL
      // error survives; the checkout owner retries after rollback and unlocks.
      let originalSqlError;
      await assert.rejects(withFirmDbClient(async client => {
        try {
          return await worker(client, async () => {
            await client.query('begin');
            try { await client.query('select 1/0'); }
            catch (error) { originalSqlError = error; throw error; }
          });
        } finally { await client.query('rollback'); }
      }), error => {
        assert.equal(error, originalSqlError);
        assert.equal(error.code, '22012');
        assert.ok(error.admission_lease_cleanup.some(cause => cause.code === '25P02'));
        return true;
      });
      assert.equal(await exclusiveAvailable(), true, 'rollback alone is not enough; owner cleanup released the session lock');

      // A standalone lease can be retried after failed release, including a
      // false unlock result. The second release must issue SQL, not no-op.
      await withFirmDbClient(async client => {
        const raw = client.query.bind(client);
        let mismatched = true;
        client.query = async (...args) => {
          if (String(args[0]).includes('pg_advisory_unlock_shared') && mismatched) {
            mismatched = false;
            return seed.query(...args); // real wrong backend: PostgreSQL returns false
          }
          return raw(...args);
        };
        try {
          const lease = await acquireEntityReadinessAdmissionLeaseWithClient({ client, firmId: FIRM_ID, clientId: CLIENT_ID, boundary: 'reconciliation_authority' });
          await assert.rejects(lease.release(), { code: 'ADMISSION_LEASE_RELEASE_MISMATCH' });
          assert.equal(await exclusiveAvailable(), false);
          await lease.release();
          assert.equal(await exclusiveAvailable(), true);
          await lease.release(); // idempotent only after the true unlock
        } finally { client.query = raw; }
      });

      // Reentrant leases require one unlock per acquisition. Concurrent calls
      // to one lease's release must not accidentally release its sibling.
      await withFirmDbClient(async client => {
        const options = { client, firmId: FIRM_ID, clientId: CLIENT_ID, boundary: 'reconciliation_authority' };
        const first = await acquireEntityReadinessAdmissionLeaseWithClient(options);
        const second = await acquireEntityReadinessAdmissionLeaseWithClient(options);
        await Promise.all([first.release(), first.release()]);
        assert.equal(await exclusiveAvailable(), false);
        await second.release();
        assert.equal(await exclusiveAvailable(), true);
      });
      // A lost acquisition response is uncertain, not proof the lock was never
      // taken. The same owner cleanup releases it before pooling the connection.
      await assert.rejects(withFirmDbClient(async client => {
        const raw = client.query.bind(client);
        let loseResponse = true;
        client.query = async (...args) => {
          const result = await raw(...args);
          if (loseResponse && String(args[0]).includes('pg_advisory_lock_shared')) {
            loseResponse = false;
            throw Object.assign(new Error('fixture lost lock response'), { code: 'ECONNRESET' });
          }
          return result;
        };
        return worker(client, async () => assert.fail('work after uncertain acquisition'));
      }), { code: 'ECONNRESET' });
      assert.equal(await exclusiveAvailable(), true);

      // A successful work body with failing cleanup is not returned as success.
      // Repeated false-unlock is an irrecoverable checkout: discard it, retaining
      // the named cause. Closing this real direct PG session releases its lock.
      let discardedPid;
      await assert.rejects(withFirmDbClient(client => {
        discardedPid = client.processID;
        const raw = client.query.bind(client);
        client.query = (...args) => String(args[0]).includes('pg_advisory_unlock_shared')
          ? seed.query(...args) : raw(...args);
        return worker(client, async () => 'must not be reported successful');
      }), { code: 'ADMISSION_LEASE_RELEASE_MISMATCH' });
      // Wait on PG's definitive close event rather than a fixed sleep.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!(await seed.query('select 1 from pg_stat_activity where pid=$1', [discardedPid])).rowCount) break;
        if (attempt === 99) assert.fail('discarded connection remained alive');
      }
      assert.equal(await exclusiveAvailable(), true);

      // The cleanup bound closes and awaits a real in-flight PG query. It
      // never starts an unlock later after the checkout has been discarded.
      const stalled = new pg.Client({ connectionString: scratchUrl.toString() });
      await stalled.connect();
      const stalledPid = stalled.processID;
      try {
        // Socket close ends local execution; server statement timeout remains
        // the bound for an already-running SQL command (as in Host observation).
        await stalled.query("set statement_timeout='100ms'");
        await stalled.query('select pg_advisory_lock_shared(hashtextextended($1,0))', [leaseKey]);
        let reachedAfterStall = false;
        await assert.rejects(withAdmissionCleanupDeadline(stalled, async () => {
          await stalled.query('select pg_sleep(10)');
          reachedAfterStall = true;
        }, 30), { code: 'ADMISSION_LEASE_CLEANUP_TIMEOUT' });
        assert.equal(reachedAfterStall, false);
        await seed.query("set lock_timeout='1s'");
        try {
          await seed.query('select pg_advisory_lock(hashtextextended($1,0))', [leaseKey]);
          await seed.query('select pg_advisory_unlock(hashtextextended($1,0))', [leaseKey]);
        } finally { await seed.query('set lock_timeout=0'); }
        assert.equal((await seed.query('select 1 from pg_stat_activity where pid=$1', [stalledPid])).rowCount, 0);
      } finally { await stalled.end(); }

      // Credit application admission belongs to the caller's transaction.
      // Even after its helper returns, the fence stays until commit/rollback.
      const creditInvoice = 'document-credit-lease-proof';
      await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,status,total_amount,currency)
        values($1,$2,$3,'lease-proof.pdf','sales_invoice','ready',100,'GBP')`, [creditInvoice,FIRM_ID,CLIENT_ID]);
      await withFirmDbClient(async client => {
        await client.query('begin');
        await withCreditApplicationTransaction(client, () => applyCreditApplicationsWithClient({
          client, firmId: FIRM_ID, clientId: CLIENT_ID, invoice: { id: creditInvoice, currency: 'GBP' }
        }));
        assert.equal(await exclusiveAvailable(), false, 'savepoint release retains outer transaction fence');
        await client.query('rollback');
      });
      assert.equal(await exclusiveAvailable(), true);
      await withFirmDbClient(async client => {
        await client.query('begin');
        await client.query('create temp table credit_outer_marker(value int) on commit drop');
        await client.query('insert into credit_outer_marker values(1)');
        const raw = client.query.bind(client);
        let inject = true;
        client.query = (...args) => {
          if (inject && String(args[0]).includes('from document_credit_applications')) {
            inject = false;
            return raw('select 1/0');
          }
          return raw(...args);
        };
        try {
          await assert.rejects(withCreditApplicationTransaction(client, () => applyCreditApplicationsWithClient({
            client, firmId: FIRM_ID, clientId: CLIENT_ID, invoice: { id: creditInvoice, currency: 'GBP' },
            applications: [{ credit_document_id: 'no-write-before-failure' }]
          })), { code: '22012' });
        } finally { client.query = raw; }
        assert.equal((await client.query('select count(*)::int as n from credit_outer_marker')).rows[0].n, 1, 'inner failure preserved caller transaction');
        await client.query('rollback');
      });
      assert.equal(await exclusiveAvailable(), true);
      await seed.query('delete from documents where id=$1', [creditInvoice]);

      await seed.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, status, payload,
            parse_status, parse_run_id, parse_attempts, storage_bucket, storage_object_key)
         values
           ($1, $2, $3, 'pending-local.pdf', 'supplier_bill', 'received',
            $4::jsonb, 'pending', $5::uuid, 0, 'donna-evidence', 'pending-local.pdf')`,
        [DOCUMENT_ID, FIRM_ID, CLIENT_ID, JSON.stringify({ storage_provider: 'local_blob' }), PARSE_RUN_ID]
      );
      await seed.query(
        `insert into client_ask_batches
           (id, firm_id, client_id, status, subject, message_markdown, payload,
            created_by)
         values
           ($1, $2, $3, 'draft', 'Readiness question', 'Question body', '{}'::jsonb, $4)`,
        [ASK_BATCH_ID, FIRM_ID, CLIENT_ID, MEMBER_ID]
      );

      // Every boundary agrees on the same healthy early decision before the
      // dependency changes. The actual upload-sign route then carries that
      // exact dependency generation into the local signed token.
      await withFirmDbClient(async (client) => {
        for (const boundary of ENTITY_READINESS_BOUNDARIES) {
          const decision = await evaluateEntityReadinessAdmissionWithClient({
            client, firmId: FIRM_ID, clientId: CLIENT_ID, boundary
          });
          assert.equal(decision.allowed, true, boundary);
          assert.equal(decision.enforced, true, boundary);
          assert.equal(decision.entity_dependency_digest, certified.row.ready_dependency_digest, boundary);
        }
      });
      const signed = await requestApi({
        method: 'POST',
        url: '/api/donna/firms/documents/upload-url',
        headers: {
          authorization: `Bearer ${ACCESS_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          firm_id: FIRM_ID,
          client_id: CLIENT_ID,
          filename: 'generation-bound.pdf',
          mime_type: 'application/pdf',
          size: 24
        })
      });
      assert.equal(signed.statusCode, 200, signed.body);
      assert.equal(signed.json.provider, 'local_blob');
      const signedUrl = new URL(signed.json.signed_url, 'http://127.0.0.1');

      const before = await scalarCounts(seed);
      // This is the TOCTOU edge: signing already succeeded, but the baseline
      // changes before the irreversible byte PUT. Drive the second production
      // signer too: inbound owner media must carry the same generation claim,
      // rather than minting a legacy local token that bypasses PUT admission.
      let invalidatedFlagId = null;
      await assert.rejects(
        storeInboundMediaAsEvidence({
          firmId: FIRM_ID,
          clientId: CLIENT_ID,
          evidenceRequest: { id: 'inbound-readiness-ask', transaction_id: null },
          message: { id: 'inbound-readiness-message' },
          media: {
            bytes: Buffer.from('inbound-refused-by-readiness'),
            filename: 'inbound-generation-bound.pdf',
            mimeType: 'application/pdf'
          },
          descriptor: { id: 'inbound-readiness-media', filename: 'inbound-generation-bound.pdf' },
          fetchImpl: async (url, options) => {
            invalidatedFlagId = (await seed.query(
              `update client_capability_config
                  set valid_to = now()
                where firm_id = $1 and client_id = $2 and flag_key = $3
                  and valid_to is null
                returning id`,
              [FIRM_ID, CLIENT_ID, DESKTOP_CLIENT_FLAG_SEEDS[0]]
            )).rows[0].id;
            const target = new URL(url, 'http://127.0.0.1');
            const response = await requestApi({
              method: options.method,
              url: `${target.pathname}${target.search}`,
              headers: options.headers,
              body: options.body
            });
            return {
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode,
              text: async () => response.body
            };
          }
        }),
        (error) => error?.code === 'EVIDENCE_STORAGE_UPLOAD_FAILED'
          && error?.statusCode === 503
      );
      assert.ok(invalidatedFlagId);
      const invalidated = (await seed.query(
        `select state, reason_code, responsible_system, attempt_count,
                root_cause_receipt_id, observed_dependency_digest
           from entity_readiness_sagas
          where firm_id = $1 and client_id = $2`,
        [FIRM_ID, CLIENT_ID]
      )).rows[0];
      assert.equal(invalidated.state, 'failed');
      assert.equal(invalidated.reason_code, 'entity_dependency_changed');
      assert.equal(invalidated.responsible_system, 'donna_readiness');
      assert.equal(Number(invalidated.attempt_count), 0, 'invalidation is not a provisioning attempt');
      assert.equal(invalidated.observed_dependency_digest, null);
      const invalidationReceipt = (await seed.query(
        'select actor_type, actor_id, action, metadata from audit_events where id = $1',
        [invalidated.root_cause_receipt_id]
      )).rows[0];
      assert.deepEqual(
        [invalidationReceipt.actor_type, invalidationReceipt.actor_id, invalidationReceipt.action],
        ['system', 'entityReadinessDependencyFence', 'entity.readiness.invalidated']
      );
      assert.equal(invalidationReceipt.metadata.dependency_table, 'client_capability_config');

      const refusedSign = await requestApi({
        method: 'POST',
        url: '/api/donna/firms/documents/upload-url',
        headers: {
          authorization: `Bearer ${ACCESS_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          firm_id: FIRM_ID,
          client_id: CLIENT_ID,
          filename: 'refused.pdf',
          mime_type: 'application/pdf',
          size: 10
        })
      });
      assert.equal(refusedSign.statusCode, 503, refusedSign.body);
      assert.equal(refusedSign.json.code, ENTITY_READINESS_ADMISSION_ERROR);

      const refusedPut = await requestApi({
        method: 'PUT',
        url: `${signedUrl.pathname}${signedUrl.search}`,
        headers: { 'content-type': 'application/pdf' },
        body: 'refused-by-readiness'
      });
      assert.equal(refusedPut.statusCode, 503, refusedPut.body);
      assert.equal(refusedPut.json.code, ENTITY_READINESS_ADMISSION_ERROR);

      await assert.rejects(
        registerDocumentInDb({
          firmId: FIRM_ID,
          document: {
            id: REGISTER_DOCUMENT_ID,
            client_id: CLIENT_ID,
            filename: 'refused-register.pdf',
            document_type: 'supplier_bill',
            storage_bucket: 'donna-evidence',
            storage_object_key: `${FIRM_ID}/${CLIENT_ID}/evidence/refused-register.pdf`,
            storage_provider: 'local_blob'
          }
        }),
        (error) => error instanceof EntityReadinessAdmissionError
          && error.code === ENTITY_READINESS_ADMISSION_ERROR
      );
      // RT-02: the claim reports a typed outcome, not a bare null.
      const refusedClaim = await claimParseRunInDb({
        firmId: FIRM_ID,
        documentId: DOCUMENT_ID,
        parseRunId: PARSE_RUN_ID
      });
      assert.equal(refusedClaim.claimed, null);
      assert.equal(refusedClaim.outcome, 'admission_refused');
      assert.equal(refusedClaim.decision?.allowed, false);
      assert.ok(refusedClaim.hold?.reason_code, 'a refused claim persists a parse_hold receipt');

      let workerRan = false;
      await assert.rejects(
        withFirmDbClient((client) => runWithEntityReadinessWorkerAdmission({
          client,
          firmId: FIRM_ID,
          clientId: CLIENT_ID,
          work: async () => { workerRan = true; }
        })),
        (error) => error instanceof EntityReadinessAdmissionError
          && error.code === ENTITY_READINESS_ADMISSION_ERROR
      );
      assert.equal(workerRan, false);

      await assert.rejects(
        sendClientAskBatchInDb({
          firmId: FIRM_ID,
          clientId: CLIENT_ID,
          batchId: ASK_BATCH_ID,
          actorId: MEMBER_ID
        }),
        (error) => error instanceof EntityReadinessAdmissionError
          && error.code === ENTITY_READINESS_ADMISSION_ERROR
      );

      await withFirmDbClient(async (client) => {
        const reconciliationGrant = await findActiveAuthorityGrant({
          client,
          firmId: FIRM_ID,
          clientId: CLIENT_ID,
          authorization: {
            band: 'suggested',
            reasons: ['above_materiality_ceiling'],
            gates: { A: true, B: true, C: true, D: true, E: false }
          },
          matchAmount: 500,
          currency: 'GBP',
          archetype: 'recurring_rent_lease',
          scopeKey: 'merchant:apiary-rent',
          env: { RECONCILIATION_DELEGATED_AUTHORITY: '1' }
        });
        assert.equal(reconciliationGrant, null);

        await assert.rejects(
          findActiveActionAuthorityGrant(client, {
            firmId: FIRM_ID,
            clientId: CLIENT_ID,
            domain: 'outbound',
            actionType: 'send_quote',
            scopeKey: 'party-1',
            amount: 500,
            currency: 'GBP'
          }),
          (error) => error instanceof EntityReadinessAdmissionError
            && error.code === ENTITY_READINESS_ADMISSION_ERROR
        );
      });

      await assert.rejects(
        withFirmDbClient(async (client) => {
          await client.query('begin');
          try {
            await __writeLedgerJournalRows({
              client,
              firmId: FIRM_ID,
              clientId: CLIENT_ID,
              journal: { source_type: 'readiness_certificate', source_id: 'refused-ledger', lines: [] }
            });
          } finally {
            await client.query('rollback').catch(() => {});
          }
        }),
        (error) => error instanceof EntityReadinessAdmissionError
          && error.code === ENTITY_READINESS_ADMISSION_ERROR
      );

      const after = await scalarCounts(seed);
      assert.deepEqual(after, before, 'every refused business store remains byte-count stable');
      const refusedDocument = await seed.query(
        'select count(*)::int as n from documents where id = $1',
        [REGISTER_DOCUMENT_ID]
      );
      assert.equal(refusedDocument.rows[0].n, 0);
      const pendingDocument = (await seed.query(
        'select parse_status, parse_attempts from documents where id = $1',
        [DOCUMENT_ID]
      )).rows[0];
      assert.deepEqual(pendingDocument, { parse_status: 'pending', parse_attempts: 0 });
      const draftBatch = (await seed.query(
        'select status, sent_at from client_ask_batches where id = $1',
        [ASK_BATCH_ID]
      )).rows[0];
      assert.deepEqual(draftBatch, { status: 'draft', sent_at: null });
      const diskFiles = await readdir(blobDir, { recursive: true });
      assert.equal(diskFiles.some((file) => String(file).endsWith('.bin')), false);

      const blockedReceipts = await seed.query(
        `select actor_type, actor_id, resource_type, resource_id, metadata->>'boundary' as boundary
           from audit_events
          where firm_id = $1 and client_id = $2 and action = $3
          order by id`,
        [FIRM_ID, CLIENT_ID, ENTITY_READINESS_BLOCKED_ACTION]
      );
      assert.ok(blockedReceipts.rows.length >= ENTITY_READINESS_BOUNDARIES.length);
      assert.deepEqual(blockedReceipts.rows.filter(row => row.boundary === 'ledger_write'), [{
        actor_type: 'system', actor_id: 'system', resource_type: 'ledger_source',
        resource_id: 'readiness_certificate:refused-ledger', boundary: 'ledger_write'
      }], 'the direct ledger fixture carries its actual default actor');
      assert.ok(blockedReceipts.rows.filter(row => row.boundary !== 'ledger_write').every(row =>
        row.actor_type === 'system' && row.actor_id === 'entityReadinessAdmission'));
      assert.deepEqual(
        new Set(blockedReceipts.rows.map(({ boundary }) => boundary)),
        new Set(ENTITY_READINESS_BOUNDARIES)
      );

      const snapshot = await getFirmSnapshotFromDb({ firmId: FIRM_ID });
      assert.equal(snapshot.clients.find(({ id }) => id === CLIENT_ID).runtime_readiness.effective_state, 'failed');
      assert.equal(snapshot.clients.find(({ id }) => id === CLIENT_ID).runtime_readiness.mutation_ready, false);

      // Recovery stays open while admission is closed. Restore the exact
      // dependency, append one bounded attempt, and keep saga identity stable.
      await seed.query(
        'update client_capability_config set valid_to = null where id = $1',
        [invalidatedFlagId]
      );
      const recovered = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        retry: true,
        lifecycle: 'retry',
        compatibilityScope: 'current_generation_compatibility',
        observedAt: new Date().toISOString(),
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'dependency_recovery', principal_id: MEMBER_ID }
      });
      assert.equal(recovered.row.state, 'ready');
      assert.equal(Number(recovered.row.attempt_count), 0);
      assert.equal(recovered.row.saga_id, certified.row.saga_id);
      assert.equal(recovered.row.idempotency_key, certified.row.idempotency_key);
      assert.equal(recovered.row.ready_dependency_digest, certified.row.ready_dependency_digest);

      // The original generation-bound token is valid again because recovery
      // certified the exact same dependency set; the local byte store resumes.
      const resumedPut = await requestApi({
        method: 'PUT',
        url: `${signedUrl.pathname}${signedUrl.search}`,
        headers: { 'content-type': 'application/pdf' },
        body: 'resumed-after-recovery'
      });
      assert.equal(resumedPut.statusCode, 200, resumedPut.body);
      assert.equal((await scalarCounts(seed)).blobs, 1);
      assert.equal((await readdir(blobDir, { recursive: true }))
        .filter((file) => String(file).endsWith('.bin')).length, 1);
    } finally {
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
    }
  }
);
