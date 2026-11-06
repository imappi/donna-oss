// RT-17 PR 8 — the in-memory two-terminal projection READERS read the persisted
// column (docs/plan-2026-09-01-runtime-refactor-slices.md §5 RT-17, the one
// non-move; RT-13 handoff §4 item 1). After RT-13 every writer persists the
// verdict (transactions.convergence_state / convergence_reason, migration 137)
// and the consistency fixtures pin column == derivation after every write. The
// four readers that still re-derived in memory — the firm snapshot, the feed
// chat rows, the case-health read and the operator case snapshot — now render
// the column, so a reader can never disagree with the writer.
//
// Written FIRST and watched fail on the pre-switch tree on exactly the two
// cases where the in-memory readers were KNOWN-lossy (RT-13 §4 item 1):
//   - the case-health read built its disposition holder without RT-10's lane,
//     so a needs_human verdict projected `disposition:needs_human` while the
//     column (the law) says `disposition:needs_human:<lane>`;
//   - the operator case snapshot never read client_evidence_requests, so a
//     line the OWNER holds projected `hanging` with a caveat while the column
//     says `on_owner`.
// Everything else is the column == projection pin, now asserted at the READER.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { CONVERGENCE_SETTLE_DISABLED_ENV, convergenceMetrics } from './reconcileConvergenceState.js';
import { recordReconciliationEvaluation } from './reconciliationLlmCore.js';
import { BANK_LINE_DISPOSITION_FAMILY, BANK_LINE_DISPOSITION_TARGET_TYPE } from './bankLineDispositionShape.js';
import { buildCaseHealth } from './caseHealth.js';
import { getOperatorCaseSnapshot } from './operatorCaseSnapshot.js';
import { getFeedChatRowsFromDb, getFirmSnapshotFromDb, withFirmDbClient, __endFirmDbPoolForTests } from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-rt17';
const CLIENT = 'client-rt17';

const bootScratchDatabase = async () => {
  const dbName = `donna_rt17_${Date.now().toString(36)}_${process.pid}`;
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
  await seed.query(`insert into firms (id, name, slug) values ($1, 'RT-17 Firm', 'rt17-firm')`, [FIRM]);
  await seed.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'RT-17 Client')`, [CLIENT, FIRM]);
  const stop = async () => {
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  };
  return { seed, scratchUrl: scratchUrl.toString(), stop };
};

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

const insertTransaction = (client, { id, moneyOut = 120, status = 'pending', payload = {} }) => client.query(
  `insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, reconciliation_status, payload)
   values ($1, $2, $3, '2026-08-20', $4, 0, $5, 'GBP', $6, $7::jsonb)`,
  [id, FIRM, CLIENT, `line ${id}`, moneyOut, status, JSON.stringify(payload)]
);
const insertAsk = (client, { id, transactionId, status = 'open' }) => client.query(
  `insert into client_evidence_requests
     (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload, created_by, audience)
   values ($1, $2, $3, $4, $5, 'business_purpose', 'Question?', '{}'::jsonb, 'ask_batch', 'client')`,
  [id, FIRM, CLIENT, transactionId, status]
);
const insertReviewItem = (client, { id, transactionId, reason = 'needs_review' }) => client.query(
  `insert into transaction_review_queue (id, firm_id, client_id, item_type, item_id, reason, status, payload)
   values ($1, $2, $3, 'transaction', $4, $5, 'open', $6::jsonb)`,
  [id, FIRM, CLIENT, transactionId, reason, JSON.stringify({ transaction_id: transactionId })]
);
const stampDisposition = (client, { transactionId, payload }) => recordReconciliationEvaluation({
  client, firmId: FIRM, clientId: CLIENT,
  targetType: BANK_LINE_DISPOSITION_TARGET_TYPE, targetId: transactionId, matcherFamily: BANK_LINE_DISPOSITION_FAMILY,
  verdict: 'no_match', unmatchableReason: 'evidence_needed', model: 'test-model', payload
});

const persisted = async (seed) => Object.fromEntries((await seed.query(
  'select id, convergence_state, convergence_reason from transactions where firm_id = $1 order by id', [FIRM]
)).rows.map((row) => [row.id, { state: row.convergence_state, reason: row.convergence_reason }]));

test(
  'real PG (RT-17 PR 8): the snapshot, the feed rows, the case-health read and the operator snapshot render the persisted convergence column',
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
      // Three lines, three resting states, all written through the hooked
      // connection so the column settles at commit (RT-13's seam):
      //   t-bare   — a bare pending line → hanging (reconciliation_status:pending)
      //   t-owner  — an open OWNER ask → on_owner (open_owner_ask)
      //   t-lane   — RT-10's machine re-run lane on a needs_human verdict →
      //              hanging (disposition:needs_human:machine_rerun)
      // plus an open review case file on t-bare (a case file, never a state).
      await inTransaction(async (client) => {
        await insertTransaction(client, { id: 't-bare' });
        await insertTransaction(client, { id: 't-owner' });
        await insertTransaction(client, { id: 't-lane' });
        await insertAsk(client, { id: 'ask-owner', transactionId: 't-owner' });
        await insertReviewItem(client, { id: 'ri-bare', transactionId: 't-bare' });
        await stampDisposition(client, {
          transactionId: 't-lane',
          payload: { disposition: 'needs_human', lane: { kind: 'machine_rerun', attempt: 1, max_attempts: 3 }, reasoning: 'transport error' }
        });
      });
      const column = await persisted(seed);
      assert.deepEqual(column, {
        't-bare': { state: 'hanging', reason: 'reconciliation_status:pending' },
        't-owner': { state: 'on_owner', reason: 'open_owner_ask' },
        't-lane': { state: 'hanging', reason: 'disposition:needs_human:machine_rerun' }
      }, 'the writers persisted the three verdicts (RT-13)');

      // ── 1. The firm snapshot: every transaction, every review case file, and the metric read the column ──
      const snapshot = await getFirmSnapshotFromDb({ firmId: FIRM });
      for (const tx of snapshot.transactions) {
        assert.deepEqual(
          { state: tx.convergence_state, reason: tx.convergence_reason },
          column[tx.id],
          `snapshot transaction ${tx.id} renders the persisted verdict`
        );
      }
      const reviewItem = snapshot.transactionReviewQueue.find((item) => item.item_id === 't-bare');
      assert.ok(reviewItem, 'the review case file is in the snapshot');
      assert.deepEqual(
        { state: reviewItem.convergence_state, reason: reviewItem.convergence_reason },
        column['t-bare'],
        'a review case file carries its transaction\'s persisted verdict (the column is review-item-first by construction)'
      );
      const expectedMetric = convergenceMetrics(Object.values(column));
      assert.deepEqual(snapshot.convergenceMetrics.overall, expectedMetric, 'the metric aggregates the persisted verdicts');
      assert.deepEqual(snapshot.convergenceMetrics.by_client[CLIENT], expectedMetric, 'per client too');

      // ── 2. The feed chat rows ──
      const feed = await getFeedChatRowsFromDb({ firmId: FIRM, clientId: CLIENT });
      assert.equal(feed.totalCount, 3);
      for (const tx of feed.rows) {
        assert.deepEqual(
          { state: tx.convergence_state, reason: tx.convergence_reason },
          column[tx.id],
          `feed row ${tx.id} renders the persisted verdict`
        );
      }

      // ── 3. The case-health read: the lane-suffixed reason the column carries (FAILED on the old tree: `disposition:needs_human`) ──
      const laneRow = (await seed.query('select * from transactions where id = $1', ['t-lane'])).rows[0];
      const laneEvaluations = (await seed.query(
        'select * from reconciliation_evaluations where firm_id = $1 and target_id = $2', [FIRM, 't-lane']
      )).rows;
      const health = buildCaseHealth({ transaction: laneRow, evaluations: laneEvaluations });
      assert.deepEqual(
        { state: health.convergence.state, reason: health.convergence.reason },
        column['t-lane'],
        'case health renders the persisted verdict, lane suffix included'
      );

      // ── 4. The operator case snapshot: the owner-held line is on_owner (FAILED on the old tree: hanging + caveat, the CER table was never read) ──
      const operator = await getOperatorCaseSnapshot({
        firmId: FIRM, clientId: CLIENT, focus: { type: 'transaction', id: 't-owner' }, include: ['convergence']
      });
      assert.equal(operator.convergence.present, true);
      assert.deepEqual(
        { state: operator.convergence.state, reason: operator.convergence.reason },
        column['t-owner'],
        'the operator snapshot renders the persisted verdict'
      );
      assert.equal(operator.convergence.owner_ask_signal, 'persisted_column');
      assert.equal(operator.convergence.caveat, null, 'no caveat: the column already accounts for the asks');
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorPoolMax === undefined) delete process.env.DATABASE_POOL_MAX; else process.env.DATABASE_POOL_MAX = priorPoolMax;
      if (priorKill === undefined) delete process.env[CONVERGENCE_SETTLE_DISABLED_ENV]; else process.env[CONVERGENCE_SETTLE_DISABLED_ENV] = priorKill;
      await stop();
    }
  }
);
