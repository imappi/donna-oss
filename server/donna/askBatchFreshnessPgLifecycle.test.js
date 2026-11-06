// Ask-batch freshness — real PostgreSQL lifecycle proof.
//
// The unit seams prove the predicates and orchestration, but the production
// guarantee is transactional: after a draft is persisted, a reconciliation
// match may land; a later SEND must lock the draft, observe that match through
// the real joins, supersede the batch + audit in one commit, mint zero owner
// asks, and surface ASK_BATCH_STALE. A mock accepts any SQL shape and cannot
// prove that chain. This opt-in test uses the complete migration set, mirroring
// the other lifecycle tests in this repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  sendClientAskBatchInDb,
  __endFirmDbPoolForTests
} from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test(
  'real PG: ordinary asks stale on a new match while held-match confirms remain sendable',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG ask freshness not exercised in this run' },
  async () => {
    const dbName = `donna_askfresh_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorPoolMax = process.env.DATABASE_POOL_MAX;
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
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }

      await seed.query(`insert into firms (id, name, slug) values ('firm-fresh', 'Fresh Firm', 'fresh-firm')`);
      await seed.query(
        `insert into clients (id, firm_id, company_name)
         values ('client-fresh', 'firm-fresh', 'Fresh Client')`
      );
      await seed.query(
        `insert into transactions
           (id, firm_id, client_id, description, money_out, currency, payload)
         values
           ('tx-fresh', 'firm-fresh', 'client-fresh', 'EXXONMOBIL', 51.38, 'USD', $1::jsonb)`,
        [JSON.stringify({
          ai_suggestion_status: 'suggested',
          ai_suggestion: {
            proposed_account: 'Travel',
            confidence: 'medium',
            evidence_required: true,
            suggested_at: Date.parse('2026-08-28T08:00:00Z')
          }
        })]
      );
      const draft = {
        subject: 'One question',
        message_markdown: 'Please send the Exxon receipt.',
        items: [{
          transaction_id: 'tx-fresh',
          disposition: 'ask',
          question: 'Please send the Exxon receipt.',
          evidence_type: 'receipt'
        }],
        statement_requests: [],
        document_asks: [],
        counts: { ask: 1, notify: 0, skip: 0, statement_requests: 0 }
      };
      await seed.query(
        `insert into client_ask_batches
           (id, firm_id, client_id, status, subject, message_markdown, payload, verdicts_as_of, model, created_by)
         values
           ('batch-fresh', 'firm-fresh', 'client-fresh', 'draft', $1, $2, $3::jsonb,
            '2026-08-28T08:00:00Z', 'test-model', 'system')`,
        [draft.subject, draft.message_markdown, JSON.stringify({
          draft,
          freshness_anchor_ids: { transactionIds: ['tx-fresh'], documentIds: [] }
        })]
      );

      // The accounting state advances AFTER drafting: the receipt is now in
      // Donna and has a live suggested match. This is the production race.
      await seed.query(
        `insert into reconciliation_matches
           (id, firm_id, client_id, bank_transaction_id, matched_object_type,
            matched_object_id, match_amount, match_confidence, status, created_by, payload)
         values
           ('match-fresh', 'firm-fresh', 'client-fresh', 'tx-fresh', 'receipt',
            'doc-fresh', 51.38, 0.95, 'suggested', 'system', '{}'::jsonb)`
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '1';
      await assert.rejects(
        sendClientAskBatchInDb({
          firmId: 'firm-fresh',
          clientId: 'client-fresh',
          batchId: 'batch-fresh',
          actorId: 'system'
        }),
        (error) => error.code === 'ASK_BATCH_STALE'
          && error.details.stale_transaction_ids.includes('tx-fresh')
      );

      const batch = (await seed.query(
        `select status, payload from client_ask_batches where id = 'batch-fresh'`
      )).rows[0];
      assert.equal(batch.status, 'superseded');
      assert.deepEqual(batch.payload.superseded_before_send.stale_transaction_ids, ['tx-fresh']);

      const asks = await seed.query(
        `select count(*)::int as count from client_evidence_requests where client_id = 'client-fresh'`
      );
      assert.equal(asks.rows[0].count, 0, 'the owner was never contacted');

      const audits = await seed.query(
        `select actor_id, metadata from audit_events
          where action = 'ask_batch.superseded_before_send' and resource_id = 'batch-fresh'`
      );
      assert.equal(audits.rows.length, 1);
      assert.equal(audits.rows[0].actor_id, 'system');
      assert.deepEqual(audits.rows[0].metadata.stale_transaction_ids, ['tx-fresh']);

      // A local file is also an eligibility change BEFORE a matcher has
      // created reconciliation_matches. This was the Cactus failure: the
      // evidence existed, but parser/router lag made the ask path call it
      // missing. The send barrier inventories local documents directly.
      await seed.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out, currency, payload)
         values
           ('tx-local', 'firm-fresh', 'client-fresh', '2026-04-14',
            'CHECK 4321', 1200, 'USD', $1::jsonb)`,
        [JSON.stringify({
          ai_suggestion_status: 'suggested',
          ai_suggestion: { proposed_account: 'Suspense', confidence: 'low', suggested_at: Date.now() }
        })]
      );
      const localDraft = {
        subject: 'One document',
        message_markdown: 'Please send the document for check 4321.',
        items: [{
          transaction_id: 'tx-local',
          disposition: 'ask',
          question: 'Please send the document for check 4321.',
          evidence_type: 'supporting_document'
        }],
        statement_requests: [],
        document_asks: [],
        counts: { ask: 1, notify: 0, skip: 0, statement_requests: 0 }
      };
      await seed.query(
        `insert into client_ask_batches
           (id, firm_id, client_id, status, subject, message_markdown, payload,
            verdicts_as_of, model, created_by)
         values
           ('batch-local', 'firm-fresh', 'client-fresh', 'draft', $1, $2, $3::jsonb,
            '2026-08-28T08:30:00Z', 'test-model', 'system')`,
        [localDraft.subject, localDraft.message_markdown, JSON.stringify({
          draft: localDraft,
          freshness_anchor_ids: {
            transactionIds: ['tx-local'],
            agedTwinTransactionIds: [],
            heldMatchTransactionIds: [],
            documentIds: [],
            localEvidenceByTransaction: { 'tx-local': [] }
          }
        })]
      );
      await seed.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status)
         values
           ('doc-local', 'firm-fresh', 'client-fresh',
            'check_4321_2026-04-14.pdf', 'unknown', 'skipped')`
      );

      await assert.rejects(
        sendClientAskBatchInDb({
          firmId: 'firm-fresh',
          clientId: 'client-fresh',
          batchId: 'batch-local',
          actorId: 'system'
        }),
        (error) => error.code === 'ASK_BATCH_STALE'
          && error.details.local_evidence_changes[0].current[0].document_id === 'doc-local'
      );
      const localBatch = (await seed.query(
        `select status from client_ask_batches where id = 'batch-local'`
      )).rows[0];
      assert.equal(localBatch.status, 'superseded');
      const localAsks = await seed.query(
        `select count(*)::int as count from client_evidence_requests where transaction_id = 'tx-local'`
      );
      assert.equal(localAsks.rows[0].count, 0, 'local evidence blocked the irreversible ask');

      // The inverse production case: this suggested match is held by the
      // material-authority rule, so its existence is exactly WHY the owner
      // confirmation is eligible. The prior id-only freshness check rejected
      // this batch forever before it could mint an ask.
      await seed.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, vendor_name,
            document_date, total_amount, currency)
         values
           ('doc-held', 'firm-fresh', 'client-fresh', 'amex-june.pdf',
            'bank_statement', 'American Express', '2026-06-17', 2087.97, 'USD')`
      );
      await seed.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out, currency)
         values
           ('tx-held', 'firm-fresh', 'client-fresh', '2026-06-17',
            'AMEX EPAYMENT 37861257', 2087.97, 'USD')`
      );
      await seed.query(
        `insert into reconciliation_matches
           (id, firm_id, client_id, bank_transaction_id, matched_object_type,
            matched_object_id, match_amount, match_confidence, status, created_by, payload)
         values
           ('match-held', 'firm-fresh', 'client-fresh', 'tx-held', 'bank_statement',
            'doc-held', 2087.97, 0.92, 'suggested', 'system', $1::jsonb)`,
        [JSON.stringify({
          authorization: { reasons: ['above_materiality_ceiling'] },
          match_reason: { reasoning: 'Exact amount and date; owner authority required.' }
        })]
      );
      const heldDraft = {
        subject: 'Please confirm one match',
        message_markdown: 'We matched the AMEX payment to the AMEX statement. Please confirm.',
        items: [{
          transaction_id: 'tx-held',
          disposition: 'ask',
          question: 'Can you confirm this AMEX payment matches the AMEX statement?',
          evidence_type: 'business_purpose'
        }],
        statement_requests: [],
        document_asks: [],
        counts: { ask: 1, notify: 0, skip: 0, statement_requests: 0 }
      };
      await seed.query(
        `insert into client_ask_batches
           (id, firm_id, client_id, status, subject, message_markdown, payload,
            verdicts_as_of, model, created_by)
         values
           ('batch-held', 'firm-fresh', 'client-fresh', 'draft', $1, $2, $3::jsonb,
            '2026-08-28T09:00:00Z', 'test-model', 'system')`,
        [heldDraft.subject, heldDraft.message_markdown, JSON.stringify({
          draft: heldDraft,
          freshness_anchor_ids: {
            transactionIds: [],
            agedTwinTransactionIds: [],
            heldMatchTransactionIds: ['tx-held'],
            documentIds: []
          },
          held_match_groups: [{
            transaction_id: 'tx-held',
            match_ids: ['match-held'],
            candidate_document_ids: ['doc-held'],
            hold_reasons: ['above_materiality_ceiling']
          }]
        })]
      );

      const sent = await sendClientAskBatchInDb({
        firmId: 'firm-fresh',
        clientId: 'client-fresh',
        batchId: 'batch-held',
        actorId: 'system'
      });
      assert.equal(sent.status, 'sent');

      const heldAsks = await seed.query(
        `select status, transaction_id, question
           from client_evidence_requests
          where client_id = 'client-fresh' and transaction_id = 'tx-held'`
      );
      assert.equal(heldAsks.rows.length, 1);
      assert.equal(heldAsks.rows[0].status, 'draft'); // W1: minted by the batch, no channel delivered it
      assert.match(heldAsks.rows[0].question, /confirm this AMEX payment/);

      const heldMatch = (await seed.query(
        `select payload from reconciliation_matches where id = 'match-held'`
      )).rows[0];
      assert.ok(heldMatch.payload.material_hold.asked_at,
        'the send stamps the asked-once marker in the mint transaction');
      assert.equal(heldMatch.payload.material_hold.ask_batch_id, 'batch-held');

      const heldAudit = await seed.query(
        `select count(*)::int as count from audit_events
          where action = 'reconciliation_match.material_hold_to_ask'
            and client_id = 'client-fresh'`
      );
      assert.equal(heldAudit.rows[0].count, 1);
    } finally {
      await __endFirmDbPoolForTests();
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorPoolMax === undefined) delete process.env.DATABASE_POOL_MAX;
      else process.env.DATABASE_POOL_MAX = priorPoolMax;
      await seed.end().catch(() => {});
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
