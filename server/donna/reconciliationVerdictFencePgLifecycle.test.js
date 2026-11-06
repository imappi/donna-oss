// Migration 131's verdict fence — real PostgreSQL lifecycle.
//
// The burst race, machine-checked in both interleavings (2026-08-31, the
// Honeybee LAND LEASE line: match minted 23:32:14, stale `no_match ·
// receipt_needed` stamped 23:32:34 off a pre-match candidate scan):
//   1. a document match minting over a stale bank-line disposition stamp
//      supersedes it, with an audit receipt, in the writer's transaction;
//   2. a stamp landing over a live document match is born superseded;
//   3. a rejected match releases the line — a fresh stamp stands again, so
//      the sweep re-evaluates a genuinely bare line.
// The fence never terminalizes anything: it only removes the stale
// contradictory verdict so the hang is attributed honestly.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { summarizeBankLineDispositions } from './bankLineDispositionShape.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-verdict-fence-pg';
const CLIENT_ID = 'client-verdict-fence-pg';
const TX_RACE = 'tx-fence-race-pg';
const TX_STAMP_AFTER = 'tx-fence-stamp-after-pg';

const STAMP_PAYLOAD = {
  disposition: 'chase_receipt',
  materiality: 'material',
  policy_version: 'bank_line_disposition_v1',
  reasoning: 'A material recurring payment that should have a lease agreement on file.'
};

test(
  'real PG: a live document match and a bank-line disposition stamp cannot coexist, in either order',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — verdict fence not exercised' },
  async () => {
    const dbName = `donna_verdict_fence_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();

    try {
      await db.query(`
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
        await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await db.query(
          'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
          [file.replace(/\.sql$/, '')]
        );
      }
      await db.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency)
         values ($1, 'Verdict Fence Firm', 'verdict-fence-firm', 'US', 'USD')`,
        [FIRM_ID]
      );
      await db.query(
        `insert into clients (id, firm_id, company_name, jurisdiction, entity_type, status)
         values ($1, $2, 'Verdict Fence Apiary LLC', 'US', 'us-llc', 'active')`,
        [CLIENT_ID, FIRM_ID]
      );
      for (const txId of [TX_RACE, TX_STAMP_AFTER]) {
        await db.query(
          `insert into transactions (id, firm_id, client_id, description, money_out)
           values ($1, $2, $3, 'LAND LEASE PMT · 801743248367', 831.35)`,
          [txId, FIRM_ID, CLIENT_ID]
        );
      }

      const stamp = async (txId) => db.query(
        `insert into reconciliation_evaluations (
           id, firm_id, client_id, target_type, target_id, matcher_family,
           matcher_mode, verdict, unmatchable_reason, proposal_count,
           candidate_count, eligible_count, model, payload
         ) values (
           $1, $2, $3, 'transaction', $4, 'bank_line_disposition',
           'llm', 'no_match', 'receipt_needed', 0, 1, 1, 'claude-test', $5::jsonb
         )
         on conflict (firm_id, client_id, target_type, target_id, matcher_family) do update
           set verdict = excluded.verdict,
               unmatchable_reason = excluded.unmatchable_reason,
               payload = excluded.payload,
               evaluated_at = now()`,
        [`eval-${txId}`, FIRM_ID, CLIENT_ID, txId, JSON.stringify(STAMP_PAYLOAD)]
      );
      const mintMatch = async (id, txId, status = 'suggested') => db.query(
        `insert into reconciliation_matches (
           id, firm_id, client_id, bank_transaction_id, matched_object_type,
           matched_object_id, match_amount, match_confidence, match_reason, status
         ) values ($1, $2, $3, $4, 'document', $5, 831.35, 0.95,
                   'Exact amount on the bill date.', $6)`,
        [id, FIRM_ID, CLIENT_ID, txId, `doc-${id}`, status]
      );
      const evaluationOf = async (txId) => (await db.query(
        `select verdict, unmatchable_reason, payload from reconciliation_evaluations
          where firm_id = $1 and client_id = $2 and target_type = 'transaction'
            and target_id = $3 and matcher_family = 'bank_line_disposition'`,
        [FIRM_ID, CLIENT_ID, txId]
      )).rows[0] || null;
      const fenceReceipts = async (txId) => (await db.query(
        `select metadata from audit_events
          where firm_id = $1 and client_id = $2
            and action = 'reconciliation.disposition.superseded_by_match'
            and metadata->>'bank_transaction_id' = $3
          order by id`,
        [FIRM_ID, CLIENT_ID, txId]
      )).rows;

      // ── Interleaving 1: the observed race — stamp exists, match lands ──
      await stamp(TX_RACE);
      assert.equal((await evaluationOf(TX_RACE)).verdict, 'no_match');
      await mintMatch('match-race-1', TX_RACE);
      let evaluation = await evaluationOf(TX_RACE);
      assert.equal(evaluation.verdict, 'superseded');
      assert.equal(evaluation.unmatchable_reason, null);
      assert.equal(evaluation.payload.superseded_by_match_id, 'match-race-1');
      assert.equal(evaluation.payload.prior_verdict, 'no_match');
      assert.equal(evaluation.payload.prior_payload.disposition, 'chase_receipt');
      assert.equal(
        evaluation.payload.disposition ?? null, null,
        'the projection/hanging-count key is gone — the stale verdict can no longer bind'
      );
      let receipts = await fenceReceipts(TX_RACE);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].metadata.prior_disposition, 'chase_receipt');
      assert.equal(receipts[0].metadata.match_id, 'match-race-1');

      // The feed summarizer renders nothing for a superseded stamp.
      const rows = (await db.query(
        `select target_id, target_type, matcher_family, verdict, unmatchable_reason, model, payload
           from reconciliation_evaluations where firm_id = $1 and client_id = $2`,
        [FIRM_ID, CLIENT_ID]
      )).rows;
      assert.equal(summarizeBankLineDispositions(rows).size, 0);

      // ── Interleaving 2: match is live first, the stamp lands after ──
      await mintMatch('match-after-1', TX_STAMP_AFTER);
      await stamp(TX_STAMP_AFTER);
      evaluation = await evaluationOf(TX_STAMP_AFTER);
      assert.equal(evaluation.verdict, 'superseded', 'a stamp over a live match is born superseded');
      assert.equal(evaluation.payload.superseded_by_match_id, 'match-after-1');
      assert.equal((await fenceReceipts(TX_STAMP_AFTER)).length, 1);

      // ── Release: a rejected match frees the line; a fresh stamp stands ──
      await db.query(
        `update reconciliation_matches set status = 'rejected', updated_at = now() where id = $1`,
        ['match-race-1']
      );
      await stamp(TX_RACE);
      evaluation = await evaluationOf(TX_RACE);
      assert.equal(evaluation.verdict, 'no_match', 'no live match — the verdict stands again');
      assert.equal(evaluation.payload.disposition, 'chase_receipt');
      assert.equal(
        evaluation.payload.policy_version, 'bank_line_disposition_v1',
        'the sweep incremental guard sees a current verdict again'
      );
      assert.equal((await fenceReceipts(TX_RACE)).length, 1, 'no second supersede fired');

      // Re-arming the rejected match (accept flow) fences the fresh stamp too.
      await db.query(
        `update reconciliation_matches set status = 'confirmed', updated_at = now() where id = $1`,
        ['match-race-1']
      );
      evaluation = await evaluationOf(TX_RACE);
      assert.equal(evaluation.verdict, 'superseded');
      assert.equal((await fenceReceipts(TX_RACE)).length, 2);
    } finally {
      await db.end().catch(() => {});
      await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
