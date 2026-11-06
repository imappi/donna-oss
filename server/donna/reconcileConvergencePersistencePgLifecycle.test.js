// RT-13 — the persisted convergence state, walked through the writers on real
// PostgreSQL (docs/plan-2026-09-01-runtime-refactor-slices.md §5 RT-13; audit
// F-14, F-08). Every resting state the policy table in
// reconcileConvergenceState.test.js pins is driven here through a REAL writer
// — the disposition stamp (recordReconciliationEvaluation), the match cascade
// (cascadeAutoMatch), the RT-11 D4 retraction, ask status flips, review-queue
// rows, goal reports, document parse states — and after each write the column
// is asserted equal to a FRESH derivation from the row's inputs
// (computeConvergenceForTarget) and to the expected verdict. Two seams are
// proven on the way: the commit-time settle (a transactional writer's column
// changes in its own transaction) and the post-callback sweep (an autocommit
// writer's marks settle within the same connection use). The nightly drift
// receipt is shown to REPORT a corrupted column and never rewrite it, and the
// SQL case-id expression the gather uses is pinned to caseManager.buildCaseId.
//
// Written FIRST and watched fail on the pre-137 tree (no columns, no marks).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  applyConvergenceState,
  computeConvergenceForTarget,
  recomputeConvergenceDrift,
  settleConvergenceMarks,
  RECONCILIATION_CASE_ID_SQL,
  CONVERGENCE_SETTLE_DISABLED_ENV
} from './reconcileConvergenceState.js';
import { recordReconciliationEvaluation } from './reconciliationLlmCore.js';
import { cascadeAutoMatch } from './reconciliationTriage.js';
import { AUTO_EXPLAIN_RETRACTS_FLAG_KEY, retractAsksSettledByAutoExplain } from './reconciliationTwinAging.js';
import { readClientConfigSnapshot, setClientFlagStage } from './clientConfig.js';
import { BANK_LINE_DISPOSITION_FAMILY, BANK_LINE_DISPOSITION_TARGET_TYPE } from './bankLineDispositionShape.js';
import { buildCaseId } from './caseManager.js';
import { checkConvergenceDriftForFirm, CONVERGENCE_DRIFT_AUDIT_ACTION } from './convergenceDriftCheck.js';
import { withFirmDbClient, __endFirmDbPoolForTests } from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-rt13';
const CLIENT = 'client-rt13';

const bootScratchDatabase = async () => {
  const dbName = `donna_rt13_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const scratchUrl = new URL(PG_URL);
  scratchUrl.pathname = `/${dbName}`;
  const seed = new pg.Client({ connectionString: scratchUrl.toString() });
  await seed.connect();
  const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
  const files = (await readdir(path.join(ROOT, 'db', 'migrations')))
    .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
    .sort();
  for (const file of files) await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
  await seed.query(`insert into firms (id, name, slug) values ($1, 'RT-13 Firm', 'rt13-firm')`, [FIRM]);
  await seed.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'RT-13 Client')`, [CLIENT, FIRM]);
  const stop = async () => {
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  };
  return { seed, scratchUrl: scratchUrl.toString(), stop };
};

// Every write below that should reach the column through the connection hook
// goes through withFirmDbClient — the seam firmDb.js's ONE call wraps.
const inTransaction = (fn) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try {
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
});
const autocommit = (fn) => withFirmDbClient((client) => fn(client));
// A hooked WRITE that changes nothing: the nudge that settles marks a
// FOREIGN connection (the scratch seed client) left behind — the sweep is
// synchronous after a hooked write, and only best-effort on release.
const nudge = () => autocommit((client) => client.query('update firms set name = name where id = $1', [FIRM]));

const persisted = async (seed, { transactionId = null, documentId = null }) => {
  const table = transactionId ? 'transactions' : 'documents';
  const row = (await seed.query(
    `select convergence_state, convergence_reason, convergence_as_of from ${table} where firm_id = $1 and id = $2`,
    [FIRM, transactionId || documentId]
  )).rows[0];
  return { state: row?.convergence_state ?? null, reason: row?.convergence_reason ?? null, as_of: row?.convergence_as_of ?? null };
};

const marksFor = async (seed, targetId) => Number((await seed.query(
  'select count(*)::int as n from convergence_marks where firm_id = $1 and target_id = $2', [FIRM, targetId]
)).rows[0].n);

// The consistency assertion: column == fresh derivation == expected.
const expectConverged = async (seed, target, expected, label) => {
  const column = await persisted(seed, target);
  const fresh = await computeConvergenceForTarget(seed, { firmId: FIRM, ...target });
  const derived = { state: fresh?.derived?.state ?? null, reason: fresh?.derived?.reason ?? null };
  assert.deepEqual({ state: column.state, reason: column.reason }, derived, `${label}: the column equals a fresh derivation`);
  assert.deepEqual(derived, expected, `${label}: the derivation is the expected verdict`);
  if (expected.state != null) assert.ok(column.as_of, `${label}: as_of is stamped`);
  assert.equal(await marksFor(seed, target.transactionId || target.documentId), 0, `${label}: no unsettled mark rests on the row`);
};

const insertTransaction = (client, { id, moneyOut = 120, moneyIn = 0, status = 'pending', payload = {} }) => client.query(
  `insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, reconciliation_status, payload)
   values ($1, $2, $3, '2026-08-20', $4, $5, $6, 'GBP', $7, $8::jsonb)`,
  [id, FIRM, CLIENT, `line ${id}`, moneyIn, moneyOut, status, JSON.stringify(payload)]
);
// 122's addressee check: a seat ask names a firm principal, an agent ask an
// AI occupant, a client ask neither.
const ADDRESSEE = { client: [null, null], seat: ['firm_member', 'member-1'], agent: ['ai_occupant', 'agent-1'] };
const insertAsk = (client, { id, transactionId = null, evidenceType = 'business_purpose', status = 'open', audience = 'client', requestPayload = {} }) => client.query(
  `insert into client_evidence_requests
     (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload, created_by, audience, addressee_principal_type, addressee_principal_id)
   values ($1, $2, $3, $4, $5, $6, 'Question?', $7::jsonb, 'ask_batch', $8, $9, $10)`,
  [id, FIRM, CLIENT, transactionId, status, evidenceType, JSON.stringify(requestPayload), audience, ...ADDRESSEE[audience]]
);
const setAskStatus = (client, id, status) => client.query('update client_evidence_requests set status = $2 where id = $1', [id, status]);
const stampDisposition = (client, { transactionId, verdict = 'no_match', payload }) => recordReconciliationEvaluation({
  client, firmId: FIRM, clientId: CLIENT,
  targetType: BANK_LINE_DISPOSITION_TARGET_TYPE, targetId: transactionId, matcherFamily: BANK_LINE_DISPOSITION_FAMILY,
  verdict, unmatchableReason: verdict === 'no_match' ? 'evidence_needed' : null, model: 'test-model', payload
});
const insertDocument = (client, { id, type = 'supplier_bill', parseStatus = 'completed', total = 600, extra = {} }) => client.query(
  `insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, total_amount, currency, payload, parse_error, parse_summary, duplicate_of)
   values ($1, $2, $3, $4, $5, 'uploaded', $6, $7, 'GBP', $8::jsonb, $9::jsonb, $10::jsonb, $11)`,
  [id, FIRM, CLIENT, `${id}.pdf`, type, parseStatus, total,
    JSON.stringify(extra.payload || {}), extra.parseError ? JSON.stringify(extra.parseError) : null,
    extra.parseSummary ? JSON.stringify(extra.parseSummary) : null, extra.duplicateOf || null]
);

test(
  'real PG (RT-13): every modelled resting state, driven through the writers, lands on the persisted column equal to the ONE derivation',
  { skip: !PG_URL && 'DONNA_PG_TEST_URL not set' },
  async () => {
    const { seed, scratchUrl, stop } = await bootScratchDatabase();
    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorPoolMax = process.env.DATABASE_POOL_MAX;
    const priorKill = process.env[CONVERGENCE_SETTLE_DISABLED_ENV];
    process.env.DATABASE_URL = scratchUrl;
    process.env.DATABASE_POOL_MAX = '1';
    delete process.env[CONVERGENCE_SETTLE_DISABLED_ENV];
    try {
      // ── 0. The migration's own receipt: the columns exist, the marks table is empty ──
      assert.equal(Number((await seed.query('select count(*)::int as n from convergence_marks')).rows[0].n), 0, 'a fresh database carries no marks');

      // ── 1. A bare line, written in a transaction: settled at COMMIT ──
      await inTransaction(async (client) => {
        await insertTransaction(client, { id: 't1' });
        const midway = (await client.query('select convergence_state from transactions where id = $1', ['t1'])).rows[0];
        assert.equal(midway.convergence_state, null, 'before commit the column is not yet derived (the settle runs at commit)');
        assert.equal(Number((await client.query('select count(*)::int as n from convergence_marks where target_id = $1', ['t1'])).rows[0].n), 1, 'the insert trigger recorded a mark');
      });
      await expectConverged(seed, { transactionId: 't1' }, { state: 'hanging', reason: 'reconciliation_status:pending' }, 'bare line');

      // ── 2. The disposition stamp (the real writer): chase_evidence hangs, awaiting its ask ──
      await inTransaction((client) => stampDisposition(client, { transactionId: 't1', payload: { disposition: 'chase_evidence', materiality: 'material', confidence: 0.8, reasoning: 'no document on file' } }));
      await expectConverged(seed, { transactionId: 't1' }, { state: 'hanging', reason: 'disposition:chase_evidence' }, 'chase_evidence stamped');

      // ── 3. An ask minted OUTSIDE the hook (raw seed connection): the mark waits, the next hooked write sweeps it ──
      await insertAsk(seed, { id: 'ask-t1-purpose', transactionId: 't1' });
      assert.equal(await marksFor(seed, 't1'), 1, 'a foreign autocommit write leaves its mark');
      assert.equal((await persisted(seed, { transactionId: 't1' })).reason, 'disposition:chase_evidence', 'the column is stale until a settle runs');
      await nudge();
      await expectConverged(seed, { transactionId: 't1' }, { state: 'on_owner', reason: 'open_owner_ask' }, 'open owner ask (swept by the next hooked write)');

      // ── 4. F8: the owner replies (an autocommit writer on the hooked connection) ──
      await autocommit((client) => setAskStatus(client, 'ask-t1-purpose', 'replied'));
      await expectConverged(seed, { transactionId: 't1' }, { state: 'hanging', reason: 'owner_answered_processing' }, 'replied ask');
      await autocommit((client) => setAskStatus(client, 'ask-t1-purpose', 'resolved'));
      await expectConverged(seed, { transactionId: 't1' }, { state: 'hanging', reason: 'disposition:chase_evidence' }, 'resolved ask falls back to the verdict');

      // ── 5. RT-10 lanes on a needs_human verdict ──
      await inTransaction((client) => stampDisposition(client, { transactionId: 't1', payload: { disposition: 'needs_human', lane: { kind: 'machine_rerun', attempt: 1, max_attempts: 3 }, reasoning: 'transport error' } }));
      await expectConverged(seed, { transactionId: 't1' }, { state: 'hanging', reason: 'disposition:needs_human:machine_rerun' }, 'machine re-run lane');
      await inTransaction(async (client) => {
        await stampDisposition(client, { transactionId: 't1', payload: { disposition: 'needs_human', lane: { kind: 'owner_ask', evidence_request_id: 'ask-t1-nh', minted: true }, reasoning: 'only the owner can say' } });
        await insertAsk(client, { id: 'ask-t1-nh', transactionId: 't1', requestPayload: { lane: 'needs_human_disposition' } });
      });
      await expectConverged(seed, { transactionId: 't1' }, { state: 'on_owner', reason: 'open_owner_ask' }, 'judgment lane with its ask landed');
      await autocommit((client) => setAskStatus(client, 'ask-t1-nh', 'resolved'));
      await inTransaction((client) => stampDisposition(client, { transactionId: 't1', payload: { disposition: 'needs_human', lane: { kind: 'owner_ask_exhausted', asks: 2 } } }));
      await expectConverged(seed, { transactionId: 't1' }, { state: 'hanging', reason: 'disposition:needs_human:owner_ask_exhausted' }, 'exhausted lane is surfaced, not terminal');

      // ── 6. auto_explain settles; an open purpose ask still outranks; RT-11 D4 retracts it ──
      await inTransaction(async (client) => {
        await stampDisposition(client, {
          transactionId: 't1', verdict: 'auto_explained',
          payload: { disposition: 'auto_explain', materiality: 'immaterial', materiality_ceiling: 500, downgraded_from: null, confidence: 0.93, expense_kind: 'tolls_and_parking', reasoning: 'Small recurring toll.' }
        });
        await client.query(`update transactions set reconciliation_status = 'explained', payload = payload || '{"support_basis":"bank_line","support_status":"bank_line_explained","bank_line_disposition_explained":true}'::jsonb where id = 't1'`);
        await insertAsk(client, { id: 'ask-t1-late', transactionId: 't1', evidenceType: 'business_purpose' });
      });
      await expectConverged(seed, { transactionId: 't1' }, { state: 'on_owner', reason: 'open_owner_ask' }, 'auto_explain with a still-open ask is on the owner');
      await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey: AUTO_EXPLAIN_RETRACTS_FLAG_KEY, stage: 'auto', source: 'default', reason: 'desktop_host_default' });
      const retraction = await inTransaction(async (client) => retractAsksSettledByAutoExplain(client, {
        firmId: FIRM, clientId: CLIENT, configSnapshot: await readClientConfigSnapshot(client, { firmId: FIRM, clientId: CLIENT })
      }));
      assert.equal(retraction.acts, true, JSON.stringify(retraction));
      assert.deepEqual([...retraction.retracted_request_ids], ['ask-t1-late']);
      const retractedRow = (await seed.query("select status, response_payload from client_evidence_requests where id = 'ask-t1-late'")).rows[0];
      assert.equal(retractedRow.status, 'resolved', 'D4 rests the ask resolved…');
      assert.equal(retractedRow.response_payload?.retracted, true, '…with the retraction receipted on the row');
      await expectConverged(seed, { transactionId: 't1' }, { state: 'hanging', reason: 'explained_but_uncoded' }, 'D4: the ask is resolved but first coding is still owed');

      // ── 7. The match cascade (the authorized call in reconciliationTriage.js): D3 keeps the purpose ask, the cascade settles the line ──
      await inTransaction(async (client) => {
        await insertTransaction(client, { id: 't2', moneyOut: 550 });
        await insertDocument(client, { id: 'd-bill', total: 550 });
        await insertAsk(client, { id: 'ask-t2-doc', transactionId: 't2', evidenceType: 'supporting_document' });
        await insertAsk(client, { id: 'ask-t2-purpose', transactionId: 't2', evidenceType: 'business_purpose' });
      });
      await expectConverged(seed, { transactionId: 't2' }, { state: 'on_owner', reason: 'open_owner_ask' }, 't2 with two open asks');
      await expectConverged(seed, { documentId: 'd-bill' }, { state: 'hanging', reason: 'doc_awaiting_line_no_verdict' }, 'a parsed bill with no line');
      await inTransaction(async (client) => {
        await client.query(
          `insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, match_amount, match_confidence, match_reason, status, created_by, payload)
           values ('m-t2', $1, $2, 't2', 'supplier_bill', 'd-bill', 550, 0.94, 'amount + date', 'auto_matched', 'system', '{"authorization":{"band":"auto_matched","reasons":["material_auto_fyi"],"material_auto_fyi":{"owner_notified":false}}}'::jsonb)`,
          [FIRM, CLIENT]
        );
        await cascadeAutoMatch({ client, firmId: FIRM, clientId: CLIENT, matchId: 'm-t2', bankTransactionId: 't2', matchedObjectType: 'supplier_bill', documentId: 'd-bill' });
        // The authorized call settled BOTH sides inside this very transaction, before commit.
        const inTxn = (await client.query("select convergence_state, convergence_reason from transactions where id = 't2'")).rows[0];
        assert.deepEqual(inTxn, { convergence_state: 'on_owner', convergence_reason: 'open_owner_ask' }, 'cascadeAutoMatch wrote the column in its own transaction');
        const docInTxn = (await client.query("select convergence_state from documents where id = 'd-bill'")).rows[0];
        assert.equal(docInTxn.convergence_state, null, 'the matched document is no longer a reconcile row');
      });
      const asks = (await seed.query("select id, status from client_evidence_requests where transaction_id = 't2' order by id")).rows;
      assert.deepEqual(asks, [{ id: 'ask-t2-doc', status: 'resolved' }, { id: 'ask-t2-purpose', status: 'open' }], 'D3: the match answers the document ask, not the purpose ask');
      assert.equal((await seed.query("select reconciliation_status from transactions where id = 't2'")).rows[0].reconciliation_status, 'explained');
      await expectConverged(seed, { transactionId: 't2' }, { state: 'on_owner', reason: 'open_owner_ask' }, 'D3: the purpose ask still holds the line on the owner');
      await expectConverged(seed, { documentId: 'd-bill' }, { state: null, reason: null }, 'a matched document carries no verdict of its own');
      await autocommit((client) => setAskStatus(client, 'ask-t2-purpose', 'resolved'));
      await expectConverged(seed, { transactionId: 't2' }, { state: 'hanging', reason: 'explained_but_uncoded' }, 'material_auto_fyi match and purpose answer still need first coding');

      // ── 8. M1.3: a cascade that never landed is a hanging system failure, whatever the line reads ──
      await autocommit((client) => client.query(`update reconciliation_matches set payload = payload || '{"cascade":{"state":"failed","attempts":1}}'::jsonb where id = 'm-t2'`));
      await expectConverged(seed, { transactionId: 't2' }, { state: 'hanging', reason: 'cascade_failed' }, 'failed cascade');
      await autocommit((client) => client.query(`update reconciliation_matches set payload = payload || '{"cascade":{"state":"applied","attempts":2}}'::jsonb where id = 'm-t2'`));
      await expectConverged(seed, { transactionId: 't2' }, { state: 'hanging', reason: 'explained_but_uncoded' }, 'applied cascade still needs first coding');
      // A rejected match returns the document to the no-line population.
      await autocommit((client) => client.query(`update reconciliation_matches set status = 'rejected' where id = 'm-t2'`));
      await expectConverged(seed, { documentId: 'd-bill' }, { state: 'hanging', reason: 'doc_awaiting_line_no_verdict' }, 'a rejected match is not live');

      // ── 9. The coding state (RT-16: transactions.coding_state, the ONE column) ──
      // The case file is context; the transactions trigger (138) marks a
      // coding transition, so the verdict follows the column.
      await inTransaction(async (client) => {
        await insertTransaction(client, { id: 't3' });
        await client.query(
          `insert into transaction_review_queue (id, firm_id, client_id, item_type, item_id, reason, status, payload)
           values ('rq-t3', $1, $2, 'transaction', 't3', 'coding', 'open', '{"transaction_id":"t3"}'::jsonb)`,
          [FIRM, CLIENT]
        );
        await client.query("update transactions set coding_state = 'proposed', coding_state_as_of = now() where id = 't3'");
      });
      await expectConverged(seed, { transactionId: 't3' }, { state: 'hanging', reason: 'coding_state:proposed' }, 'PROPOSED coding (Leak B)');
      await autocommit((client) => client.query("update transactions set coding_state = 'asked' where id = 't3'"));
      await expectConverged(seed, { transactionId: 't3' }, { state: 'on_owner', reason: 'coding_state:asked' }, 'asked: on the owner');
      await autocommit((client) => insertAsk(client, { id: 'ask-t3', transactionId: 't3', status: 'replied' }));
      await expectConverged(seed, { transactionId: 't3' }, { state: 'hanging', reason: 'owner_answered_processing' }, 'post-reply asked is firm-side work');
      await autocommit(async (client) => {
        await setAskStatus(client, 'ask-t3', 'resolved');
        await client.query("update transactions set coding_state = 'applied', payload = payload || '{\"ai_suggestion_status\":\"applied\"}'::jsonb where id = 't3'");
      });
      await expectConverged(seed, { transactionId: 't3' }, { state: 'auto_reconciled', reason: 'coding_state:applied' }, 'applied coding');
      await autocommit((client) => client.query("update transaction_review_queue set status = 'resolved' where id = 'rq-t3'"));
      await expectConverged(seed, { transactionId: 't3' }, { state: 'auto_reconciled', reason: 'coding_state:applied' }, 'closing the case file changes nothing — the state is the transaction\'s own');
      await inTransaction((client) => client.query(`update transactions set coding_state='posted',
        payload=payload || '{"coding_correction_required":{"status":"pending","recovery":{"state":"blocked","code":"CODING_CORRECTION_AUTHORITY_REQUIRED"}}}'::jsonb
        where id='t3'`));
      await expectConverged(seed, { transactionId: 't3' },
        { state: 'hanging', reason: 'posted_evidence_correction_blocked:CODING_CORRECTION_AUTHORITY_REQUIRED' },
        'blocked posted correction persists its actual recovery code');
      await autocommit((client) => client.query(`update transactions set payload=jsonb_set(payload,
        '{coding_correction_required,status}','"corrected"'::jsonb) where id='t3'`));
      await expectConverged(seed, { transactionId: 't3' }, { state: 'auto_reconciled', reason: 'coding_state:posted' },
        'completed posted correction returns to terminal 1');

      // ── 10. Ask audiences (122): a seat ask is terminal 2 under its own key; an agent ask is never terminal ──
      await inTransaction(async (client) => {
        await insertTransaction(client, { id: 't4' });
        await insertAsk(client, { id: 'ask-t4-seat', transactionId: 't4', audience: 'seat' });
      });
      await expectConverged(seed, { transactionId: 't4' }, { state: 'on_owner', reason: 'open_seat_ask' }, 'seat ask');
      await autocommit((client) => insertAsk(client, { id: 'ask-t4-agent', transactionId: 't4', audience: 'agent' }));
      await expectConverged(seed, { transactionId: 't4' }, { state: 'hanging', reason: 'agent_ask_unanswered' }, 'agent ask outranks the seat ask');
      // A consolidated statement ask anchors a sibling line.
      await inTransaction(async (client) => {
        await insertTransaction(client, { id: 't4b' });
        await insertAsk(client, { id: 'ask-anchor', transactionId: null, evidenceType: 'bank_statement', requestPayload: { anchor_transaction_ids: ['t4b'] } });
      });
      await expectConverged(seed, { transactionId: 't4b' }, { state: 'on_owner', reason: 'open_owner_ask' }, 'anchored by a consolidated statement ask');

      // ── 11. The reconciliation GoalReport outranks the legacy column; the SQL case id is buildCaseId's ──
      await inTransaction(async (client) => {
        await insertTransaction(client, { id: 't5', status: 'explained', payload: { account_name: 'Bank fees' } });
      });
      await expectConverged(seed, { transactionId: 't5' }, { state: 'hanging', reason: 'explained_but_uncoded' }, 'legacy explained descriptor still lacks decided coding');
      const caseId = buildCaseId({ firmId: FIRM, clientId: CLIENT, caseType: 'reconciliation', primaryObjectType: 'transaction', primaryObjectId: 't5' });
      const sqlCaseId = (await seed.query(`select ${RECONCILIATION_CASE_ID_SQL('t')} as case_id from transactions t where t.id = 't5'`)).rows[0].case_id;
      assert.equal(sqlCaseId, caseId, 'the gather derives the same case id as caseManager.buildCaseId');
      await inTransaction(async (client) => {
        await client.query(
          `insert into bookkeeping_cases (id, firm_id, client_id, case_type, status, primary_object_type, primary_object_id) values ($1, $2, $3, 'reconciliation', 'open', 'transaction', 't5')`,
          [caseId, FIRM, CLIENT]
        );
        for (const eventId of ['ev-1', 'ev-2']) {
          await client.query(
            `insert into bookkeeping_case_events (id, firm_id, client_id, case_id, event_type, actor_type) values ($1, $2, $3, $4, 'goal_evaluated', 'system')`,
            [eventId, FIRM, CLIENT, caseId]
          );
        }
        await client.query(
          `insert into loop_goal_reports (id, firm_id, client_id, case_id, event_id, goal_key, goal_version, status, criteria, next_unmet_conditions)
           values ('gr-1', $1, $2, $3, 'ev-1', 'reconciliation_gap', '1', 'unmet', '[]'::jsonb, '["settled_by_match"]'::jsonb)`,
          [FIRM, CLIENT, caseId]
        );
      });
      await expectConverged(seed, { transactionId: 't5' }, { state: 'hanging', reason: 'reconciliation_status:needs_review' }, 'an unmet goal verdict outranks the legacy explained column');
      await inTransaction((client) => client.query(
        `insert into loop_goal_reports (id, firm_id, client_id, case_id, event_id, goal_key, goal_version, status, criteria, next_unmet_conditions, created_at)
         values ('gr-2', $1, $2, $3, 'ev-2', 'reconciliation_gap', '1', 'met', '[{"key":"explained","evidenceRefs":["auto_explained_verdict"]}]'::jsonb, '[]'::jsonb, now() + interval '1 second')`,
        [FIRM, CLIENT, caseId]
      ));
      await expectConverged(seed, { transactionId: 't5' }, { state: 'hanging', reason: 'explained_but_uncoded' }, 'a met reconciliation goal does not replace coding');

      // ── 12. Documents: the doc-only resting states and the no-line verdict ──
      await inTransaction(async (client) => {
        await insertDocument(client, { id: 'd-hold', parseStatus: 'pending', extra: { payload: { parse_hold: { reason_code: 'runtime_host_not_ready', boundary: 'parse_claim' } } } });
        await insertDocument(client, { id: 'd-fail', parseStatus: 'failed', extra: { parseError: { code: 'INTERNAL', retryable: false, retry_owner: 'manual', retry_exhausted: { attempts: 4, max_attempts: 4 } } } });
        await insertDocument(client, { id: 'd-retrying', parseStatus: 'failed', extra: { parseError: { code: 'OCR_TIMEOUT', retryable: true, retry_owner: 'queue' } } });
        await insertDocument(client, { id: 'd-dup', type: 'bank_statement', parseStatus: 'duplicate_pending', total: null });
        await insertDocument(client, { id: 'd-collapsed', type: 'receipt', parseStatus: 'skipped', extra: { duplicateOf: 'd-bill', parseSummary: { reason: 'duplicate_auto_collapsed' } } });
        await insertDocument(client, { id: 'd-stmt', type: 'bank_statement', parseStatus: 'completed', total: null });
        await insertDocument(client, { id: 'd-processing', parseStatus: 'processing' });
        await insertDocument(client, { id: 'd-nl', total: 80 });
        await insertAsk(client, { id: 'ask-d-dup', transactionId: null, evidenceType: 'statement_overlap', requestPayload: { document_id: 'd-dup', lane: 'statement_overlap' } });
      });
      await expectConverged(seed, { documentId: 'd-hold' }, { state: 'hanging', reason: 'parse_hold:runtime_host_not_ready' }, 'RT-02/RT-09 parse hold');
      await expectConverged(seed, { documentId: 'd-fail' }, { state: 'hanging', reason: 'parse_failed:manual' }, 'RT-08 terminal parse failure');
      await expectConverged(seed, { documentId: 'd-retrying' }, { state: null, reason: null }, 'a retry the queue still owes is in flight');
      await expectConverged(seed, { documentId: 'd-dup' }, { state: 'on_owner', reason: 'open_owner_ask' }, 'RT-10 period overlap on the owner');
      await expectConverged(seed, { documentId: 'd-collapsed' }, { state: null, reason: null }, 'a byte collapse is not a row');
      await expectConverged(seed, { documentId: 'd-stmt' }, { state: null, reason: null }, 'a statement is not a row');
      await expectConverged(seed, { documentId: 'd-processing' }, { state: null, reason: null }, 'in flight');
      await expectConverged(seed, { documentId: 'd-nl' }, { state: 'hanging', reason: 'doc_awaiting_line_no_verdict' }, 'no-line, no verdict');
      await autocommit((client) => setAskStatus(client, 'ask-d-dup', 'resolved'));
      await expectConverged(seed, { documentId: 'd-dup' }, { state: 'hanging', reason: 'duplicate_pending_no_ask' }, 'overlap with its ask resolved and no decision: surfaced');
      await autocommit((client) => insertAsk(client, { id: 'ask-d-fail', transactionId: null, evidenceType: 'supporting_document', requestPayload: { document_id: 'd-fail' } }));
      await expectConverged(seed, { documentId: 'd-fail' }, { state: 'on_owner', reason: 'open_owner_ask' }, 'an owner ask on a failed document outranks the failure');
      // The document disposition verdict (the real writer) with its RT-10 lane.
      const stampDoc = (client, payload, verdict = 'no_match') => recordReconciliationEvaluation({
        client, firmId: FIRM, clientId: CLIENT, targetType: 'document', targetId: 'd-nl', matcherFamily: 'document_no_line_disposition',
        verdict, unmatchableReason: verdict === 'no_match' ? 'evidence_needed' : null, model: 'test-model', payload
      });
      await inTransaction((client) => stampDoc(client, { disposition: 'needs_human', lane: { kind: 'machine_rerun', attempt: 1 } }));
      await expectConverged(seed, { documentId: 'd-nl' }, { state: 'hanging', reason: 'disposition:needs_human:machine_rerun' }, 'doc machine re-run lane');
      await inTransaction((client) => stampDoc(client, { disposition: 'chase_evidence', settlement_channel: 'uncovered_account' }));
      await expectConverged(seed, { documentId: 'd-nl' }, { state: 'hanging', reason: 'disposition:chase_evidence' }, 'doc chase_evidence');
      await inTransaction(async (client) => {
        await stampDoc(client, { disposition: 'auto_explain', materiality: 'immaterial' }, 'auto_explained');
        await client.query(`update documents set payload = payload || '{"no_line_disposition":{"disposition":"auto_explain","owner_notified":false}}'::jsonb where id = 'd-nl'`);
      });
      await expectConverged(seed, { documentId: 'd-nl' }, { state: 'auto_reconciled', reason: 'disposition:auto_explain' }, 'doc settled by its holder');
      await autocommit((client) => client.query(
        `insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, match_amount, match_confidence, match_reason, status, created_by, payload)
         values ('m-d-nl', $1, $2, 't3', 'supplier_bill', 'd-nl', 80, 0.7, 'amount', 'suggested', 'system', '{}'::jsonb)`,
        [FIRM, CLIENT]
      ));
      await expectConverged(seed, { documentId: 'd-nl' }, { state: null, reason: null }, 'a suggested live match takes the doc out of the population');

      // ── 13. The kill switch: env can only KILL the settle; marks accumulate and the next enabled use sweeps them ──
      process.env[CONVERGENCE_SETTLE_DISABLED_ENV] = '1';
      await inTransaction((client) => insertTransaction(client, { id: 't6' }));
      assert.equal((await persisted(seed, { transactionId: 't6' })).state, null, 'with the settle killed the column stays underived');
      assert.equal(await marksFor(seed, 't6'), 1, 'the mark waits');
      delete process.env[CONVERGENCE_SETTLE_DISABLED_ENV];
      await nudge();
      await expectConverged(seed, { transactionId: 't6' }, { state: 'hanging', reason: 'reconciliation_status:pending' }, 'swept once re-enabled');

      // ── 14. The nightly drift receipt REPORTS a corrupted column and never rewrites it ──
      await seed.query("update transactions set convergence_state = 'auto_reconciled', convergence_reason = 'coding_state:applied' where id = 't6'");
      assert.equal(await marksFor(seed, 't6'), 0, 'writing only the convergence columns records no mark (the settle never re-marks itself)');
      const report = await checkConvergenceDriftForFirm({ client: seed, firmId: FIRM });
      assert.equal(report.drift_count, 1, JSON.stringify(report.drift_by_transition));
      assert.deepEqual(report.drift_by_transition, { 'auto_reconciled->hanging': 1 });
      assert.equal(report.drifted_sample[0].target_id, 't6');
      assert.deepEqual(report.drifted_sample[0].derived, { state: 'hanging', reason: 'reconciliation_status:pending' });
      assert.equal(report.unsettled_marks, 0);
      assert.equal(report.converged, false);
      assert.equal((await persisted(seed, { transactionId: 't6' })).state, 'auto_reconciled', 'the check did NOT rewrite the column');
      const receipts = (await seed.query('select metadata from audit_events where firm_id = $1 and action = $2 order by id', [FIRM, CONVERGENCE_DRIFT_AUDIT_ACTION])).rows;
      assert.equal(receipts.length, 1, 'one receipt per firm per check');
      assert.equal(receipts[0].metadata.drift_count, 1);
      assert.equal(receipts[0].metadata.contract_version, 'donna.convergence-drift.v1');
      // The explicit repair is applyConvergenceState — an operator's call, receipted by the next check reading zero.
      await applyConvergenceState(seed, { firmId: FIRM, transactionId: 't6' });
      const clean = await recomputeConvergenceDrift(seed, { firmId: FIRM });
      assert.equal(clean.drift_count, 0, JSON.stringify(clean.drifted_sample));
      assert.equal(clean.converged, true);
      assert.equal(clean.rows_checked, clean.transactions_checked + clean.documents_checked);

      // ── 15. Nothing rests unsettled at the end of the walk ──
      const leftover = await settleConvergenceMarks(seed, { firmId: FIRM, scope: 'all' });
      assert.equal(leftover.claimed, 0, 'every mark the walk produced was settled by a writer or a sweep');
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorPoolMax === undefined) delete process.env.DATABASE_POOL_MAX; else process.env.DATABASE_POOL_MAX = priorPoolMax;
      if (priorKill === undefined) delete process.env[CONVERGENCE_SETTLE_DISABLED_ENV]; else process.env[CONVERGENCE_SETTLE_DISABLED_ENV] = priorKill;
      await stop();
    }
  }
);
