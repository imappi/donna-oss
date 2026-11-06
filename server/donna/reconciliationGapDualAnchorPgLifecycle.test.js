// Reconciliation gap dual-anchor lifecycle — real PostgreSQL proof.
//
// A persisted reconciliation match names both a document and a bank transaction.
// The matcher completion sweep is commonly document-scoped, so closing only the
// document case leaves an earlier transaction-side "missing receipt" blocker stale.
// This test drives the production post-run hook against the real case spine and
// proves sticky matches settle both anchors while suggestions relabel (not resolve)
// the transaction-side owner decision.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { openBlocker, openOrFindCase } from './caseManager.js';
import {
  onDocumentParseCompleted,
  onReconciliationRunCompleted,
  PROPOSED_MATCH_GAP_REASON
} from './loopsShadowProducers.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test(
  'real PG: a document-target completion projects sticky and suggested matches to their transaction cases',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG dual-anchor lifecycle not exercised in this run' },
  async () => {
    const dbName = `donna_recon_dual_anchor_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();
    const priorTier = process.env.LOOPS_TIER;

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

      await db.query(
        `insert into firms (id, name, slug)
         values ('firm-recon-dual-anchor', 'Dual Anchor Firm', 'dual-anchor-firm')`
      );
      await db.query(
        `insert into clients (id, firm_id, company_name)
         values ('client-recon-dual-anchor', 'firm-recon-dual-anchor', 'Universal Match Fixture')`
      );
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, status, total_amount, currency)
         values
           ('doc-sticky', 'firm-recon-dual-anchor', 'client-recon-dual-anchor', 'sticky.pdf', 'receipt', 'completed', 120.77, 'USD'),
           ('doc-suggested', 'firm-recon-dual-anchor', 'client-recon-dual-anchor', 'suggested.pdf', 'receipt', 'completed', 75.00, 'USD'),
           ('doc-retried', 'firm-recon-dual-anchor', 'client-recon-dual-anchor', 'retried.pdf', 'receipt', 'completed', 45.00, 'USD')`
      );
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out, currency, status)
         values
           ('tx-sticky', 'firm-recon-dual-anchor', 'client-recon-dual-anchor', '2026-06-22', 'STICKY MATCH', 120.77, 'USD', 'needs_review'),
           ('tx-suggested', 'firm-recon-dual-anchor', 'client-recon-dual-anchor', '2026-06-23', 'SUGGESTED MATCH', 75.00, 'USD', 'needs_review')`
      );

      const stickyCase = await openOrFindCase({
        client: db,
        firmId: 'firm-recon-dual-anchor',
        clientId: 'client-recon-dual-anchor',
        caseType: 'reconciliation',
        primaryObject: { type: 'transaction', id: 'tx-sticky' }
      });
      const suggestedCase = await openOrFindCase({
        client: db,
        firmId: 'firm-recon-dual-anchor',
        clientId: 'client-recon-dual-anchor',
        caseType: 'reconciliation',
        primaryObject: { type: 'transaction', id: 'tx-suggested' }
      });
      const uploadCase = await openOrFindCase({
        client: db,
        firmId: 'firm-recon-dual-anchor',
        clientId: 'client-recon-dual-anchor',
        caseType: 'upload',
        primaryObject: { type: 'document', id: 'doc-retried' }
      });
      const staleReason = 'The owner should provide a supporting receipt.';
      await openBlocker({
        client: db,
        firmId: 'firm-recon-dual-anchor',
        clientId: 'client-recon-dual-anchor',
        caseId: stickyCase.id,
        blockerType: 'unclear_match',
        ownerType: 'client',
        objectType: 'transaction',
        objectId: 'tx-sticky',
        reason: staleReason
      });
      await openBlocker({
        client: db,
        firmId: 'firm-recon-dual-anchor',
        clientId: 'client-recon-dual-anchor',
        caseId: uploadCase.id,
        blockerType: 'parse_failed',
        ownerType: 'system',
        objectType: 'document',
        objectId: 'doc-retried',
        reason: 'The first parse attempt failed.'
      });
      await openBlocker({
        client: db,
        firmId: 'firm-recon-dual-anchor',
        clientId: 'client-recon-dual-anchor',
        caseId: suggestedCase.id,
        blockerType: 'unclear_match',
        ownerType: 'client',
        objectType: 'transaction',
        objectId: 'tx-suggested',
        reason: staleReason
      });

      await db.query(
        `insert into reconciliation_matches
           (id, firm_id, client_id, bank_transaction_id, matched_object_type,
            matched_object_id, match_amount, match_confidence, status)
         values
           ('match-sticky', 'firm-recon-dual-anchor', 'client-recon-dual-anchor',
            'tx-sticky', 'document', 'doc-sticky', 120.77, 0.99, 'auto_matched'),
           ('match-suggested', 'firm-recon-dual-anchor', 'client-recon-dual-anchor',
            'tx-suggested', 'document', 'doc-suggested', 75.00, 0.75, 'suggested')`
      );

      process.env.LOOPS_TIER = 'canary';
      const result = await onReconciliationRunCompleted({
        client: db,
        firmId: 'firm-recon-dual-anchor',
        clientId: 'client-recon-dual-anchor',
        targets: [
          { targetType: 'document', targetId: 'doc-sticky' },
          { targetType: 'document', targetId: 'doc-suggested' }
        ]
      });
      assert.deepEqual(
        { resolved: result.resolved, relabeled: result.relabeled, opened: result.opened },
        { resolved: 1, relabeled: 1, opened: 0 }
      );

      const blockers = await db.query(
        `select case_id, status, reason
           from bookkeeping_case_blockers
          where case_id = any($1::text[])
          order by case_id`,
        [[stickyCase.id, suggestedCase.id]]
      );
      const stickyBlocker = blockers.rows.find((row) => row.case_id === stickyCase.id);
      const suggestedBlocker = blockers.rows.find((row) => row.case_id === suggestedCase.id);
      assert.equal(stickyBlocker.status, 'resolved');
      assert.equal(suggestedBlocker.status, 'open');
      assert.equal(suggestedBlocker.reason, PROPOSED_MATCH_GAP_REASON);

      const cases = await db.query(
        `select id, status, terminal_state
           from bookkeeping_cases
          where id = any($1::text[])
          order by id`,
        [[stickyCase.id, suggestedCase.id]]
      );
      assert.deepEqual(
        cases.rows.find((row) => row.id === stickyCase.id),
        { id: stickyCase.id, status: 'resolved', terminal_state: 'resolved' }
      );
      assert.deepEqual(
        cases.rows.find((row) => row.id === suggestedCase.id),
        { id: suggestedCase.id, status: 'waiting_client', terminal_state: null }
      );
      assert.equal(
        Number((await db.query(
          `select count(*)
             from bookkeeping_cases
            where firm_id = 'firm-recon-dual-anchor'
              and case_type = 'reconciliation'
              and primary_object_type = 'document'`
        )).rows[0].count),
        0,
        'the post-run projection settles the existing transaction cases without inventing document cases'
      );

      const parseResult = await onDocumentParseCompleted({
        client: db,
        firmId: 'firm-recon-dual-anchor',
        clientId: 'client-recon-dual-anchor',
        documentId: 'doc-retried',
        parseRunId: 'parse-run-retry',
        summary: { transaction_count: 0 }
      });
      assert.deepEqual(
        { resolved: parseResult.resolved, status: parseResult.status },
        { resolved: 1, status: 'resolved' }
      );
      const uploadState = await db.query(
        `select c.status, c.terminal_state, b.status as blocker_status
           from bookkeeping_cases c
           join bookkeeping_case_blockers b on b.case_id = c.id
          where c.id = $1`,
        [uploadCase.id]
      );
      assert.deepEqual(uploadState.rows[0], {
        status: 'resolved', terminal_state: 'resolved', blocker_status: 'resolved'
      });
    } finally {
      if (priorTier === undefined) delete process.env.LOOPS_TIER;
      else process.env.LOOPS_TIER = priorTier;
      await db.end().catch(() => null);
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [dbName]
      ).catch(() => null);
      await admin.query(`drop database if exists "${dbName}"`).catch(() => null);
      await admin.end().catch(() => null);
    }
  }
);
