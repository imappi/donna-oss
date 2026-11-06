// RT-16 — the migration 138 backfill law on real PostgreSQL
// (docs/plan-2026-09-01-runtime-refactor-slices.md §5 "Coding-state collapse").
//
// Every row of the mapping table in 138's header is seeded as a LEGACY
// combination on a database migrated to 137 (the queue column still there,
// the payload labels still written), then 138 runs and the column is read
// back: it must equal the row's expected state AND codingState.js's
// codingStateFromLegacy — the JS law and the SQL law pinned to each other.
// Afterwards: the legacy labels are stripped, the queue column is gone, a
// coding transition marks the row for the convergence settle, and RT-13's
// consistency holds (column == derivation for every seeded line once the
// marks settle).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { codingStateFromLegacy, applyCodingTransition, CodingStateTransitionError } from './codingState.js';
import { computeConvergenceForTransactions, settleConvergenceMarks } from './reconcileConvergenceState.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-rt16-backfill';
const CLIENT = 'client-rt16-backfill';

// The mapping table, row by row: what the legacy sources said, what the
// column must read. `queue` seeds a transaction-typed review row (column
// label ∥ payload label ∥ case status ∥ payload extras); `payload` seeds the
// transaction's payload; `status` the transaction status.
const ROWS = [
  { id: 'r01-closed', queue: { column: 'closed' }, payload: { review_state: 'accepted' }, expected: 'closed' },
  { id: 'r02-synced-label', payload: { review_state: 'synced', ai_suggestion_status: 'auto_applied' }, expected: 'synced' },
  { id: 'r02b-synced-marker', payload: { review_state: 'accepted', xero_sync_status: 'synced' }, expected: 'synced' },
  { id: 'r03-posted-label', queue: { column: 'posted', status: 'resolved' }, payload: {}, expected: 'posted' },
  { id: 'r03b-ledger-marker', queue: { payloadLabel: 'accepted' }, payload: { ledger_journal_id: 'lj-1' }, expected: 'posted' },
  { id: 'r04-held', queue: { column: 'held' }, payload: { review_state: 'suggested', ai_suggestion: { proposed_account: 'Rent' } }, expected: 'held' },
  { id: 'r05-asked-client', queue: { column: 'asked_client' }, payload: { ai_suggestion_status: 'suggested' }, expected: 'asked' },
  { id: 'r05b-waiting-vs-accepted', queue: { payloadLabel: 'accepted' }, payload: { review_state: 'waiting' }, expected: 'asked' },
  { id: 'r06-accepted', queue: { column: 'accepted' }, payload: {}, expected: 'applied' },
  { id: 'r06b-resolved', payload: { review_state: 'resolved' }, expected: 'applied' },
  { id: 'r06c-parse-desync', queue: { column: 'suggested', payloadLabel: 'accepted', extras: { auto_categorize_source: 'client_rule' } }, payload: {}, expected: 'applied' },
  { id: 'r06d-spa-apply-receipt', payload: { review_state: 'suggested', ai_suggestion_status: 'applied', ai_suggestion: { proposed_account: 'Rent' } }, expected: 'applied' },
  { id: 'r07-suggested-with-verdict', queue: { column: 'suggested' }, payload: { review_state: 'suggested', ai_suggestion_status: 'suggested', ai_suggestion: { proposed_account: 'Rent' } }, expected: 'proposed' },
  { id: 'r07b-suggested-receipt-alone', payload: { ai_suggestion_status: 'suggested' }, expected: 'proposed' },
  { id: 'r07c-suggested-queue-proposal', queue: { column: 'suggested', extras: { proposed_account: 'Rent' } }, payload: {}, expected: 'proposed' },
  { id: 'r08-needs-client', status: 'needs_client', payload: {}, expected: 'asked' },
  { id: 'r08b-evidence-request-open', payload: { evidence_request: { status: 'open' } }, expected: 'asked' },
  { id: 'r09-closed-case', queue: { status: 'resolved', column: 'suggested' }, payload: {}, expected: 'applied' },
  { id: 'r09b-cancelled-case', queue: { status: 'cancelled', column: 'suggested' }, payload: {}, expected: 'applied' },
  { id: 'r10-case-file-default', queue: { column: 'suggested', payloadLabel: 'suggested' }, payload: {}, expected: null },
  { id: 'r11-nothing', payload: {}, expected: null }
];

const legacyInputsOf = (row) => ({
  queueReviewState: row.queue?.column ?? null,
  queuePayloadReviewState: row.queue?.payloadLabel ?? null,
  queueStatus: row.queue ? (row.queue.status || 'open') : null,
  queueHasProposal: Boolean(row.queue?.extras && (row.queue.extras.ai_suggestion || row.queue.extras.auto_categorize_source || row.queue.extras.proposed_account)),
  payloadReviewState: row.payload?.review_state ?? null,
  aiSuggestionStatus: row.payload?.ai_suggestion_status ?? null,
  hasProposal: Boolean(row.payload?.ai_suggestion || row.payload?.auto_categorize_source),
  xeroSynced: row.payload?.xero_sync_status === 'synced' || Boolean(row.payload?.xero_synced_at || row.payload?.synced_at),
  ledgerPosted: row.payload?.ledger_status === 'posted' || (Boolean(row.payload?.ledger_journal_id) && row.payload?.ledger_status == null),
  needsClient: row.status === 'needs_client' || row.payload?.transaction_status === 'needs_client' || row.payload?.evidence_request?.status === 'open'
});

test(
  'real PG (RT-16): migration 138 backfills coding_state from every legacy combination the mapping table names, strips the labels, drops the queue column',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — the backfill law is not exercised in this run' },
  async () => {
    const dbName = `donna_rt16_backfill_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const url = new URL(PG_URL);
    url.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    try {
      const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
      const files = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
        .sort();
      const before138 = files.filter((file) => file < '138_');
      const from138 = files.filter((file) => file >= '138_');
      assert.ok(from138[0]?.startsWith('138_coding_state'), `138 is the next migration: ${from138[0]}`);
      for (const file of before138) await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));

      // The pre-138 world: the queue column exists, the labels are in payloads.
      const queueColumn = await db.query("select 1 from information_schema.columns where table_name = 'transaction_review_queue' and column_name = 'review_state'");
      assert.equal(queueColumn.rows.length, 1, 'pre-138: the queue carries review_state');

      await db.query(`insert into firms (id, name, slug) values ($1, 'RT-16 backfill firm', 'rt16-backfill-firm') on conflict (id) do nothing`, [FIRM]);
      await db.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'RT-16 backfill client')`, [CLIENT, FIRM]);
      for (const row of ROWS) {
        await db.query(
          `insert into transactions (id, firm_id, client_id, transaction_date, description, money_out, currency, status, reconciliation_status, payload)
           values ($1, $2, $3, '2026-08-01', $1, 10, 'GBP', $4, 'pending', $5::jsonb)`,
          [row.id, FIRM, CLIENT, row.status || 'needs_review', JSON.stringify(row.payload || {})]
        );
        if (row.queue) {
          const queuePayload = { transaction_id: row.id, ...(row.queue.extras || {}), ...(row.queue.payloadLabel ? { review_state: row.queue.payloadLabel } : {}) };
          await db.query(
            `insert into transaction_review_queue (id, firm_id, client_id, item_type, item_id, reason, status, review_state, payload)
             values ($1, $2, $3, 'transaction', $4, 'rt16 backfill', $5, $6, $7::jsonb)`,
            [`rq-${row.id}`, FIRM, CLIENT, row.id, row.queue.status || 'open', row.queue.column || 'suggested', JSON.stringify(queuePayload)]
          );
        }
      }
      // A document_line case file must not be read as a transaction's coding state.
      await db.query(
        `insert into transaction_review_queue (id, firm_id, client_id, item_type, item_id, reason, status, review_state, payload)
         values ('rq-docline', $1, $2, 'document_line', 'r11-nothing', 'line review', 'open', 'accepted', '{}'::jsonb)`,
        [FIRM, CLIENT]
      );

      for (const file of from138) await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));

      // The column reads the mapping table, and the JS law agrees row by row.
      const columns = new Map((await db.query('select id, coding_state, coding_state_as_of, payload from transactions where firm_id = $1', [FIRM])).rows.map((r) => [r.id, r]));
      for (const row of ROWS) {
        const got = columns.get(row.id);
        assert.ok(got, row.id);
        assert.equal(got.coding_state, row.expected, `${row.id}: SQL backfill`);
        assert.equal(codingStateFromLegacy(legacyInputsOf(row)), row.expected, `${row.id}: JS law`);
        assert.ok(got.coding_state_as_of, `${row.id}: stamped`);
        assert.equal(got.payload.review_state, undefined, `${row.id}: payload.review_state stripped`);
        assert.notEqual(got.payload.ai_suggestion_status, 'suggested', `${row.id}: the retired receipt value stripped`);
      }
      assert.equal(columns.get('r06d-spa-apply-receipt').payload.ai_suggestion_status, 'applied', 'an applied receipt survives the strip');
      const queuePayloads = await db.query("select count(*)::int as n from transaction_review_queue where firm_id = $1 and payload ? 'review_state'", [FIRM]);
      assert.equal(queuePayloads.rows[0].n, 0, 'queue payload labels stripped');
      const queueColumnAfter = await db.query("select 1 from information_schema.columns where table_name = 'transaction_review_queue' and column_name = 'review_state'");
      assert.equal(queueColumnAfter.rows.length, 0, 'the queue column is gone');
      const constraint = await db.query("select 1 from pg_constraint where conname = 'transactions_coding_state_valid'");
      assert.equal(constraint.rows.length, 1, 'the CHECK is in place');
      await assert.rejects(() => db.query("update transactions set coding_state = 'suggested' where id = 'r11-nothing'"), /transactions_coding_state_valid/, 'a legacy label cannot enter the column');

      // Idempotent: a second run re-stamps nothing.
      const stamps = new Map((await db.query('select id, coding_state_as_of from transactions where firm_id = $1', [FIRM])).rows.map((r) => [r.id, String(r.coding_state_as_of)]));
      for (const file of from138) await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      for (const [id, stamp] of (await db.query('select id, coding_state_as_of from transactions where firm_id = $1', [FIRM])).rows.map((r) => [r.id, String(r.coding_state_as_of)])) {
        assert.equal(stamp, stamps.get(id), `${id}: re-run is a no-op`);
      }

      // RT-13's consistency through the backfill: settle the marks 137/138
      // left, then column == derivation for every seeded line.
      await settleConvergenceMarks(db, { firmId: FIRM, scope: 'all', limit: 1000 });
      const computed = await computeConvergenceForTransactions(db, { firmId: FIRM, transactionIds: ROWS.map((r) => r.id) });
      for (const c of computed) {
        assert.deepEqual({ state: c.persisted.state, reason: c.persisted.reason }, { state: c.derived.state, reason: c.derived.reason }, `${c.target_id}: convergence column == derivation`);
      }
      const byId = new Map(computed.map((c) => [c.target_id, c.persisted]));
      assert.deepEqual(byId.get('r07-suggested-with-verdict'), { ...byId.get('r07-suggested-with-verdict'), state: 'hanging', reason: 'coding_state:proposed' });
      assert.deepEqual(byId.get('r06-accepted').state, 'auto_reconciled');
      assert.equal(byId.get('r05-asked-client').state, 'on_owner');
      assert.equal(byId.get('r11-nothing').reason, 'reconciliation_status:pending', 'no coding state ⇒ the line reads off its other axes');

      // A coding transition marks the row (138 added the column to the trigger list).
      await db.query('begin');
      const moved = await applyCodingTransition(db, { firmId: FIRM, transactionId: 'r11-nothing', to: 'proposed' });
      assert.deepEqual(moved, { found: true, from: null, to: 'proposed', changed: true });
      const marks = await db.query("select count(*)::int as n from convergence_marks where firm_id = $1 and target_id = 'r11-nothing' and marked_xid = pg_current_xact_id()", [FIRM]);
      assert.equal(marks.rows[0].n, 1, 'the transition marked the row for the settle');
      await db.query('rollback');
      // The machine refuses a ledger rung going backwards, on the real column.
      await db.query('begin');
      await assert.rejects(() => applyCodingTransition(db, { firmId: FIRM, transactionId: 'r03-posted-label', to: 'proposed' }), CodingStateTransitionError);
      await db.query('rollback');
    } finally {
      await db.end().catch(() => {});
      await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
