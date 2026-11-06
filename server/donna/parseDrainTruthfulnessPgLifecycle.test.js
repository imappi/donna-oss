// RT-02 acceptance fixtures — real PostgreSQL.
//
// The bug lived in the interleaving of three real writers (claim →
// release-for-retry → the drain's terminal write), so the mock client cannot
// prove the fix. This test runs the production SQL against the current schema
// with the worker replaced by a fake that performs exactly the writer calls the
// worker performs (claim, release, complete) and throws the provider errors the
// audit named. No model or transport is called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rateLimited = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });

test(
  'real PG: the drain never stamps a released row failed, bounds retries at PARSE_MAX_ATTEMPTS, and holds refused entities without an audit storm',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — parse drain truthfulness not exercised in this run' },
  async () => {
    const dbName = `donna_parse_drain_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();

    const priorEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      LOOPS_TIER: process.env.LOOPS_TIER,
      LOOPS_SHADOW: process.env.LOOPS_SHADOW
    };
    let endPool = async () => {};
    try {
      const supabaseOnly = new Set([
        '010_evidence_object_storage.sql',
        '032_lock_down_public_rls.sql',
        '060_procountor_api_key.sql'
      ]);
      const files = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
        .sort();
      for (const file of files) {
        await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }

      process.env.DATABASE_URL = scratchUrl.toString();
      // Loops ON so "no ask_draft.requested row" below is a real assertion:
      // with loops on, a terminal parse failure DOES enqueue the wake.
      process.env.LOOPS_TIER = 'canary';
      process.env.LOOPS_SHADOW = 'true';

      const firmDb = await import('./firmDb.js');
      const parsing = await import('./parseDocumentsDb.js');
      const clientConfig = await import('./clientConfig.js');
      const { runParseDrainTick } = await import('./api.js');
      endPool = firmDb.__endFirmDbPoolForTests;

      const firmId = 'firm-parse-drain-truth';
      const clientId = 'client-parse-drain-truth';
      const heldClientId = 'client-parse-drain-held';
      await db.query(
        `insert into firms (id, name, slug, metadata)
         values ($1, 'Parse Drain Firm', 'parse-drain-firm', $2::jsonb)`,
        [firmId, JSON.stringify({ loops: { tier: 'canary' } })]
      );
      for (const id of [clientId, heldClientId]) {
        await db.query(
          `insert into clients (id, firm_id, company_name, profile)
           values ($1, $2, $1, '{}'::jsonb)`,
          [id, firmId]
        );
      }
      const insertPending = async ({ id, runId, clientId: cid = clientId, payload = {} }) => {
        await db.query(
          `insert into documents
             (id, firm_id, client_id, filename, document_type, parse_status, parse_run_id, parse_attempts,
              parse_enqueued_at, payload)
           values ($1, $2, $3, $4, 'unknown', 'pending', $5::uuid, 0, now() - interval '1 minute', $6::jsonb)`,
          [id, firmId, cid, `${id}.pdf`, runId, JSON.stringify(payload)]
        );
      };
      const docRow = async (id) => (await db.query(
        `select parse_status, parse_attempts, parse_error, payload->'parse_hold' as parse_hold
           from documents where firm_id=$1 and id=$2`,
        [firmId, id]
      )).rows[0];
      const auditCount = async (action, documentId = null) => Number((await db.query(
        `select count(*)::int as n from audit_events
          where firm_id=$1 and action=$2 ${documentId ? 'and resource_id=$3' : ''}`,
        documentId ? [firmId, action, documentId] : [firmId, action]
      )).rows[0].n);
      const askWakes = async (cid) => Number((await db.query(
        `select count(*)::int as n from loop_event_outbox
          where firm_id=$1 and client_id=$2 and event_type='ask_draft.requested'`,
        [firmId, cid]
      )).rows[0].n);

      // The fake worker: the exact writer sequence runParseAndWrite performs.
      const makeWorker = (script) => async (row) => {
        const step = script.shift();
        const claim = await parsing.claimParseRunInDb({
          firmId: row.firm_id, documentId: row.id, parseRunId: row.parse_run_id
        });
        if (!claim.claimed) {
          return {
            handled: false,
            reason: claim.outcome,
            claim_outcome: claim.outcome,
            reason_code: claim.decision?.reason_code || null,
            hold: claim.hold || null
          };
        }
        if (step === '429') {
          await parsing.releaseParseRunForRetryInDb({
            firmId: row.firm_id, documentId: row.id, parseRunId: row.parse_run_id
          });
          throw rateLimited();
        }
        await parsing.markParseCompletedInDb({
          firmId: row.firm_id, documentId: row.id, parseRunId: row.parse_run_id,
          summary: { source: 'rt02_fixture', transaction_count: 0 }
        });
        return { handled: true, outcome: 'completed' };
      };
      const tick = async (runParse, opts = {}) => runParseDrainTick({
        drainable: await parsing.fetchDrainablePendingRowsInDb({
          limit: 12, thresholdSeconds: 0, holdRecheckSeconds: 300
        }),
        runParse,
        markParseFailed: parsing.markParseFailedInDb,
        maxAttempts: 4,
        log: { info() {}, warn() {}, error() {} },
        ...opts
      });

      // ── Fixture 1: 429 once, then 200 ───────────────────────────────────
      const runOnce = '11111111-0000-4000-8000-000000000001';
      await insertPending({ id: 'doc-429-then-200', runId: runOnce });
      const worker1 = makeWorker(['429', '200']);
      const tick1 = await tick(worker1);
      assert.equal(tick1.retry_pending, 1, JSON.stringify(tick1));
      assert.equal(tick1.failed, 0);
      let doc = await docRow('doc-429-then-200');
      assert.equal(doc.parse_status, 'pending', 'released row stays pending for the next tick');
      assert.equal(doc.parse_attempts, 1);
      const tick2 = await tick(worker1);
      assert.equal(tick2.succeeded, 1, JSON.stringify(tick2));
      doc = await docRow('doc-429-then-200');
      assert.equal(doc.parse_status, 'completed');
      assert.equal(doc.parse_attempts, 2);
      assert.equal(await auditCount('document.parse.failed', 'doc-429-then-200'), 0, 'no failed audit for a transient error');
      assert.equal(await askWakes(clientId), 0, 'no ask_draft.requested minted by a transient error');

      // ── Fixture 2: 429 five times ───────────────────────────────────────
      const runFive = '22222222-0000-4000-8000-000000000002';
      await insertPending({ id: 'doc-429-x5', runId: runFive });
      const worker2 = makeWorker(['429', '429', '429', '429', '429']);
      const ticks = [];
      for (let i = 0; i < 5; i += 1) ticks.push(await tick(worker2));
      assert.deepEqual(ticks.map((t) => t.retry_pending), [1, 1, 1, 0, 0]);
      assert.deepEqual(ticks.map((t) => t.exhausted), [0, 0, 0, 1, 0]);
      assert.equal(ticks[4].picked, 0, 'a terminal row is no longer drainable');
      doc = await docRow('doc-429-x5');
      assert.equal(doc.parse_status, 'failed');
      assert.equal(doc.parse_attempts, 4);
      assert.equal(doc.parse_error.retryable, false);
      assert.equal(doc.parse_error.retry_owner, null);
      assert.equal(doc.parse_error.code, 'OCR_RATE_LIMIT');
      assert.deepEqual(doc.parse_error.retry_exhausted, { attempts: 4, max_attempts: 4 });
      assert.doesNotMatch(doc.parse_error.safe_user_message, /retrying shortly/i);
      assert.equal(await auditCount('document.parse.failed', 'doc-429-x5'), 1, 'exactly one failed audit');
      const failedAudit = (await db.query(
        `select metadata from audit_events where firm_id=$1 and action='document.parse.failed' and resource_id='doc-429-x5'`,
        [firmId]
      )).rows[0].metadata;
      assert.equal(failedAudit.retryable, false);
      assert.equal(failedAudit.retry_owner, null);
      assert.equal(await askWakes(clientId), 1, 'the honest terminal failure wakes the ask draft once');

      // ── Fixture 3: entity refused at parse_claim ────────────────────────
      await clientConfig.setClientFlagStage(db, {
        firmId,
        clientId: heldClientId,
        flagKey: clientConfig.ENTITY_READINESS_ADMISSION_FLAG,
        stage: 'canary',
        source: 'manual',
        reason: 'RT-02 fixture: enrolled with no saga ⇒ legacy_uncertified',
        actorType: 'system',
        actorId: 'rt02'
      });
      const runHeldA = '33333333-0000-4000-8000-000000000003';
      const runHeldB = '33333333-0000-4000-8000-000000000004';
      await insertPending({ id: 'doc-held-a', runId: runHeldA, clientId: heldClientId, payload: { storage_provider: 'local_blob' } });
      await insertPending({ id: 'doc-held-b', runId: runHeldB, clientId: heldClientId, payload: { storage_provider: 'local_blob' } });
      const worker3 = makeWorker(['200', '200', '200', '200']);
      const tick3 = await tick(worker3);
      assert.equal(tick3.admission_refused, 2, JSON.stringify(tick3));
      assert.equal(tick3.processed, 1, 'one admission check per entity per tick');
      assert.equal(tick3.holds.length, 1);
      assert.equal(tick3.holds[0].reason_code, 'legacy_uncertified');
      const blockedAfterTick3 = await auditCount('runtime.readiness_admission_blocked');
      assert.equal(blockedAfterTick3, 1, 'one blocked audit for the entity, not one per row');
      const heldA = await docRow('doc-held-a');
      const heldB = await docRow('doc-held-b');
      for (const held of [heldA, heldB]) {
        assert.equal(held.parse_status, 'pending');
        assert.equal(held.parse_hold?.reason_code, 'legacy_uncertified');
        assert.ok(held.parse_hold?.since, 'hold carries since');
        assert.ok(held.parse_hold?.checked_at, 'hold carries checked_at');
      }
      const receipt = (await db.query(
        `select id from audit_events where firm_id=$1 and action='runtime.readiness_admission_blocked'`,
        [firmId]
      )).rows[0].id;
      assert.equal(Number(heldA.parse_hold.receipt_id), Number(receipt), 'hold names the blocked receipt');

      const tick4 = await tick(worker3);
      assert.equal(tick4.held, 2, JSON.stringify(tick4));
      assert.equal(tick4.processed, 0, 'a fresh hold is not re-claimed');
      assert.equal(await auditCount('runtime.readiness_admission_blocked'), 1, 'a second tick adds no second blocked audit');

      // Hold removal on success: age the hold past the recheck window, lift the
      // enrollment so admission passes, and the claim strips the hold.
      await db.query(
        `update documents set payload = jsonb_set(payload, '{parse_hold,checked_at}', to_jsonb((now() - interval '20 minutes')::text))
          where firm_id=$1 and client_id=$2`,
        [firmId, heldClientId]
      );
      await db.query(
        `update client_capability_config set valid_to = now() where firm_id=$1 and client_id=$2`,
        [firmId, heldClientId]
      );
      const tick5 = await tick(worker3);
      assert.equal(tick5.succeeded, 2, JSON.stringify(tick5));
      const liftedA = await docRow('doc-held-a');
      assert.equal(liftedA.parse_status, 'completed');
      assert.equal(liftedA.parse_hold, null, 'a successful claim removes the hold');

      // The stuck sweep names its retry owner (manual) so the tray never promises.
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status, parse_run_id, parse_heartbeat_at)
         values ('doc-stuck', $1, $2, 'stuck.pdf', 'unknown', 'processing', '44444444-0000-4000-8000-000000000005'::uuid, now() - interval '10 minutes')`,
        [firmId, clientId]
      );
      await parsing.failStuckProcessingRowsInDb({ thresholdSeconds: 300 });
      const stuck = await docRow('doc-stuck');
      assert.equal(stuck.parse_error.retry_owner, 'manual');

      // markParseFailedInDb can no longer overwrite a completed/newer row.
      const late = await parsing.markParseFailedInDb({
        firmId, documentId: 'doc-429-then-200', parseRunId: runOnce,
        parseError: { code: 'INTERNAL', retryable: true }
      });
      assert.equal(late, null, 'terminal writer refuses a row that is no longer processing/pending');
      assert.equal((await docRow('doc-429-then-200')).parse_status, 'completed');
    } finally {
      await endPool().catch(() => {});
      await db.end().catch(() => {});
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
