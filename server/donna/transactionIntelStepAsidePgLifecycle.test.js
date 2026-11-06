// transaction_intel step-aside — the real-PostgreSQL lifecycle test
// (2026-08-17, Kari's dated go: "go intel step-aside").
//
// The mock-client tests (receiptReconciliation.test.js 16d) pin the SQL
// SHAPE of the seated path; only a real database proves the branched
// enrichment-only UPDATE actually executes (VALUES tuple arity, casts,
// jsonb merge) and that the seated run leaves transaction statuses,
// match rows, review queue, and audit_events in exactly the state the
// step-aside promises. Two stages through the SAME seam the production
// callers use (__refreshTransactionIntelForClientWithClient):
//
//   stage 1 — UNSEATED (no model_lane_policy rows): legacy behavior on
//   real rows — the vendor+amount doc match auto_reconciles and writes
//   an auto_matched intel match row; the unknown line opens a review
//   item; no stepped-aside receipt.
//   stage 2 — SEATED (active firm-wide bank_line_disposition row) with a
//   fresh transfer pair added: enrichment lands (category, cleaned
//   description, provenance marker) but NO status is stamped (the pair
//   rests at the schema default 'pending'), NO match rows are written
//   (transfer pairs included), stage 1's intel residue is cleared, and
//   the transaction_intel.stepped_aside receipt carries honest counts.
//
// OPT-IN like its siblings (correctionTeachingPgLifecycle et al.): set
// DONNA_PG_TEST_URL to a scratch PostgreSQL whose role may CREATE
// DATABASE. Without it the test SKIPS loudly. Runs in a throwaway
// database with the relevant migrations executed VERBATIM; the seam is
// called with this test's own pg client (autocommit), so no
// DATABASE_URL/pool plumbing is involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { TRANSACTION_INTEL_STEPPED_ASIDE_ACTION, __refreshTransactionIntelForClientWithClient } from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIRM = 'firm-step-aside';
const CLIENT_ID = 'venture-step-aside';

test(
  'intel step-aside on real PG: unseated settles; a seated reconcile lane enriches only, clears residue, and receipts',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG step-aside lifecycle not exercised in this run' },
  async () => {
    // The auto-match canary must be at its production default (no
    // allowlist ⇒ every client) for stage 1 to reach auto_matched.
    delete process.env.RECONCILIATION_AUTO_MATCH_CLIENTS;

    const dbName = `donna_stepaside_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();
    try {
      for (const file of [
        '001_firm_core.sql', // firms, clients, documents, transactions, audit_events
        '002_transaction_intelligence.sql', // intel columns, client_rules, reconciliation_matches, transaction_review_queue
        '003_xero_integration.sql', // xero_accounts — the enrichment read
        '004_transaction_review_states.sql',
        '008_transaction_review_posted_states.sql',
        '022_client_jurisdiction.sql', // clients.jurisdiction — the enrichment jurisdiction read
        '042_client_capability_config.sql', // strict config snapshot, including Jev's step-aside gate
        '043_client_cohorts.sql', // inherited config is part of the same strict snapshot
        '121_model_lane_policy.sql' // the seat
      ]) {
        await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }
      await db.query(`insert into firms (id, name, slug) values ($1, 'Step-Aside Test Firm', 'step-aside-test-firm')`, [FIRM]);
      await db.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'Guardco Oy')`, [CLIENT_ID, FIRM]);
      await db.query(
        `insert into documents (id, firm_id, client_id, filename, document_type, vendor_name, document_date, total_amount)
         values ('doc-guardco', $1, $2, 'guardco-receipt.pdf', 'receipt', 'Guardco', '2026-05-01', 10)`,
        [FIRM, CLIENT_ID]
      );
      await db.query(
        `insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_out, currency)
         values ('tx-doc-settle', $1, $2, '2026-05-01', 'GUARDCO PAYMENT', 'GUARDCO PAYMENT', 10, 'EUR'),
                ('tx-unknown', $1, $2, '2026-05-03', 'MYSTERY SHOP 123', 'MYSTERY SHOP 123', 42, 'EUR')`,
        [FIRM, CLIENT_ID]
      );

      // ── Stage 1: UNSEATED — legacy behavior, pinned on real rows ──
      await __refreshTransactionIntelForClientWithClient({ client: db, firmId: FIRM, clientId: CLIENT_ID });

      const settled = await db.query(
        `select reconciliation_status, reconciled_at from transactions where id = 'tx-doc-settle'`
      );
      assert.equal(settled.rows[0].reconciliation_status, 'auto_reconciled', 'unseated: the 0.92 doc match settles');
      assert.ok(settled.rows[0].reconciled_at, 'unseated: reconciled_at stamped');
      const stage1Matches = await db.query(
        `select status from reconciliation_matches
          where firm_id = $1 and coalesce(payload->>'source', 'transaction_intel') = 'transaction_intel'`,
        [FIRM]
      );
      assert.equal(stage1Matches.rows.length, 1, 'unseated: intel wrote its match row');
      assert.equal(stage1Matches.rows[0].status, 'auto_matched');
      const stage1Review = await db.query(
        `select count(*)::int as n from transaction_review_queue
          where firm_id = $1 and status = 'open' and payload->>'source' = 'transaction_intel'`,
        [FIRM]
      );
      assert.equal(stage1Review.rows[0].n, 1, 'unseated: the unknown line opened a review item');
      const stage1Receipts = await db.query(
        `select count(*)::int as n from audit_events where firm_id = $1 and action = $2`,
        [FIRM, TRANSACTION_INTEL_STEPPED_ASIDE_ACTION]
      );
      assert.equal(stage1Receipts.rows[0].n, 0, 'unseated: no stepped-aside receipt');

      // ── Stage 2: SEAT the lane, add a transfer pair, re-run ──
      await db.query(
        `insert into model_lane_policy (id, firm_id, client_id, lane, deciding_model, basis, reason)
         values ('policy-step-aside', $1, null, 'bank_line_disposition', 'qwen3-235b-a22b-instruct', 'experiment', 'model lab')`,
        [FIRM]
      );
      await db.query(
        `insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_out, money_in, currency)
         values ('tx-transfer-out', $1, $2, '2026-05-05', 'Wise internal transfer', 'Wise internal transfer', 500, 0, 'EUR'),
                ('tx-transfer-in', $1, $2, '2026-05-06', 'Transfer between accounts', 'Transfer between accounts', 0, 500, 'EUR')`,
        [FIRM, CLIENT_ID]
      );

      await __refreshTransactionIntelForClientWithClient({ client: db, firmId: FIRM, clientId: CLIENT_ID });

      // The transfer pair legacy would have auto_reconciled at 0.94 —
      // seated it rests at the schema default, unstamped, with NO match
      // row (transfer pairs included in the step-aside).
      const pair = await db.query(
        `select id, reconciliation_status, reconciled_at, category, cleaned_description,
                payload->>'intel_provenance' as intel_provenance,
                payload->>'reconciliation_status' as payload_status
           from transactions where id in ('tx-transfer-out', 'tx-transfer-in') order by id`
      );
      for (const row of pair.rows) {
        assert.equal(row.reconciliation_status, 'pending', `seated: ${row.id} not settled`);
        assert.equal(row.reconciled_at, null, `seated: ${row.id} no reconciled_at`);
        assert.equal(row.category, 'intercompany', `seated: ${row.id} still enriched`);
        assert.ok(row.cleaned_description, `seated: ${row.id} cleaned description enriched`);
        assert.equal(row.intel_provenance, 'transaction_intel:enrichment_only', `seated: ${row.id} provenance marker`);
        assert.equal(row.payload_status, null, `seated: ${row.id} payload carries no status key`);
      }

      // Stage 1's settled line keeps its stamp (the enrichment-only write
      // never touches status columns) while intel's match-row residue is
      // cleared — the per-writer scoreboard converges to ZERO intel rows.
      const keptSettle = await db.query(
        `select reconciliation_status from transactions where id = 'tx-doc-settle'`
      );
      assert.equal(keptSettle.rows[0].reconciliation_status, 'auto_reconciled', 'seated: prior settle not reverted');
      const stage2Matches = await db.query(
        `select count(*)::int as n from reconciliation_matches
          where firm_id = $1 and coalesce(payload->>'source', 'transaction_intel') = 'transaction_intel'`,
        [FIRM]
      );
      assert.equal(stage2Matches.rows[0].n, 0, 'seated: zero intel match rows (residue cleared, nothing rewritten)');
      const stage2Review = await db.query(
        `select count(*)::int as n from transaction_review_queue
          where firm_id = $1 and status = 'open' and payload->>'source' = 'transaction_intel'`,
        [FIRM]
      );
      assert.equal(stage2Review.rows[0].n, 0, 'seated: zero open intel review items');

      // The receipt — one row, honest counts. tx-doc-settle is NOT
      // already-handled by the guard vocabulary (auto_reconciled is not in
      // it), so its re-derived settle counts as suppressed alongside the
      // two transfer legs; the unknown line's review item is suppressed.
      const receipts = await db.query(
        `select metadata from audit_events where firm_id = $1 and action = $2`,
        [FIRM, TRANSACTION_INTEL_STEPPED_ASIDE_ACTION]
      );
      assert.equal(receipts.rows.length, 1, 'seated: exactly one stepped-aside receipt for the run');
      const metadata = receipts.rows[0].metadata;
      assert.deepEqual(metadata.seats, [
        { lane: 'bank_line_disposition', deciding_model: 'qwen3-235b-a22b-instruct', basis: 'experiment' }
      ]);
      assert.equal(metadata.lines_enriched, 4);
      assert.equal(metadata.settles_suppressed, 3);
      assert.equal(metadata.match_rows_suppressed, 3);
      assert.equal(metadata.review_items_suppressed, 1);
      assert.equal(metadata.stale_intel_matches_cleared, 1, 'stage 1 match row counted as cleared');
      assert.equal(metadata.stale_intel_review_items_cleared, 1, 'stage 1 review item counted as cleared');
    } finally {
      await db.end();
      await admin.query(`drop database if exists "${dbName}" with (force)`);
      await admin.end();
    }
  }
);
