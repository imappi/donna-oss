// Merchant-signal idempotency — the real-PostgreSQL replay test
// (G−1(d), build spec PR-4).
//
// The double-count this slice closes was invisible to mocked tests by
// construction: `on conflict (id) do nothing` is a perfectly plausible
// SQL string — only a real database shows a replayed apply deduping the
// EVENT while still re-incrementing the ROLLUP, and only a real
// database can prove the rowCount guard and the audit-as-precondition
// rollback. This file exercises the governed writer end to end:
//
//   first write mints event + audit + rollup (weight 3, count 1) →
//   the SAME apply replayed returns duplicate_replay and changes
//   NOTHING (one event, one audit row, rollup still 3/1 — the spec's
//   "rollup counted once") → the retired 'apply_category' kind is
//   REFUSED at the writer with nothing written (§7.6's dated call,
//   2026-08-14 — re-adding it to SIGNAL_KIND_WEIGHT fails exactly this
//   stage) → a DISTINCT remember_merchant apply still accumulates
//   (rollup 6/2) → with audit_events unavailable the whole write rolls
//   back inside its transaction (no event, rollup unchanged — audit as
//   precondition, not decoration).
//
// OPT-IN like its siblings (firmFactsPgLifecycle / feedChatFirmLeakagePg):
// set DONNA_PG_TEST_URL to a scratch PostgreSQL whose role may CREATE
// DATABASE. Without it the test SKIPS loudly. Everything runs in a
// throwaway DATABASE with migrations 001 + 017 executed VERBATIM; the
// writer takes an injected client, so no module-level wiring is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  buildMerchantSignalEventId,
  recordMerchantSignalInDb
} from './merchantSignals.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIRM = 'firm-msig';
const CLIENT_ID = 'venture-sig';

const APPLY = {
  client: null, // injected per call
  firmId: FIRM,
  clientId: CLIENT_ID,
  transactionId: 'tx-77',
  chatMessageId: 'msg-42',
  actionIndex: 0,
  action: {
    merchant_pattern: 'STARBUCKS #1234',
    account_name: 'Meals and entertainment',
    account_code: '5500',
    tax_treatment: 'No GST'
  },
  transaction: { description: 'STARBUCKS #1234 SINGAPORE' },
  signalKind: 'remember_merchant',
  jurisdiction: 'SG',
  actorId: 'kari@leak.test'
};

test(
  'merchant signal real-PG replay: event deduped, rollup counted once, audit is a precondition',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG merchant-signal idempotency not exercised in this run' },
  async () => {
    const dbName = `donna_msig_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const client = new pg.Client({ connectionString: scratchUrl.toString() });
    await client.connect();
    try {
      for (const file of ['001_firm_core.sql', '017_merchant_signals.sql']) {
        await client.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }
      await client.query(
        `insert into firms (id, name, slug) values ($1, 'Signal Test Firm', 'signal-test-firm')`,
        [FIRM]
      );
      await client.query(
        `insert into clients (id, firm_id, company_name) values ($1, $2, 'Signal Venture Pte Ltd')`,
        [CLIENT_ID, FIRM]
      );

      const counts = async () => {
        const events = await client.query('select count(*)::int as n from merchant_signal_events');
        const audits = await client.query(
          `select count(*)::int as n from audit_events where action = 'merchant_signal.recorded'`
        );
        const rollup = await client.query(
          'select occurrence_weight, occurrence_count from merchant_signal_rollup'
        );
        return {
          events: events.rows[0].n,
          audits: audits.rows[0].n,
          rollup: rollup.rows[0] || null
        };
      };

      // ── 1. First write: event + audit + rollup, actor attributed ─────────
      const first = await recordMerchantSignalInDb({ ...APPLY, client });
      assert.equal(first.written, true);
      assert.equal(
        first.event_id,
        buildMerchantSignalEventId({
          firmId: FIRM,
          clientId: CLIENT_ID,
          transactionId: 'tx-77',
          chatMessageId: 'msg-42',
          actionIndex: 0,
          signalKind: 'remember_merchant'
        }),
        'the persisted id is the deterministic tuple hash'
      );
      assert.equal(first.rollup_weight, 3);
      let state = await counts();
      assert.deepEqual(
        { events: state.events, audits: state.audits },
        { events: 1, audits: 1 }
      );
      assert.deepEqual(state.rollup, { occurrence_weight: 3, occurrence_count: 1 });
      const audit = await client.query(
        `select actor_id, resource_id, metadata from audit_events where action = 'merchant_signal.recorded'`
      );
      assert.equal(audit.rows[0].actor_id, 'kari@leak.test', 'real actor on the mint row');
      assert.equal(audit.rows[0].resource_id, first.event_id);
      assert.equal(audit.rows[0].metadata.signal_kind, 'remember_merchant');

      // ── 2. The SAME apply replayed: nothing moves ────────────────────────
      const replay = await recordMerchantSignalInDb({ ...APPLY, client });
      assert.deepEqual(replay, {
        written: false,
        skipped_reason: 'duplicate_replay',
        event_id: first.event_id
      });
      state = await counts();
      assert.equal(state.events, 1, 'event deduped');
      assert.equal(state.audits, 1, 'a replay mints nothing, so it audits nothing');
      assert.deepEqual(
        state.rollup,
        { occurrence_weight: 3, occurrence_count: 1 },
        'the rollup is counted ONCE — the rowCount guard, not just on-conflict'
      );

      // ── 3. The retired apply_category kind is REFUSED, nothing written ───
      // §7.6's dated call (2026-08-14): an ordinary correction contributes
      // NO cross-firm signal. The kind's absence from SIGNAL_KIND_WEIGHT
      // refuses fail-closed at the writer — a stale/hostile caller cannot
      // mint. (Both-ways neuter: re-adding `apply_category: 1` to the
      // weight map flips this to written:true and fails here.)
      const retired = await recordMerchantSignalInDb({
        ...APPLY,
        client,
        transactionId: 'tx-78',
        actionIndex: 1,
        signalKind: 'apply_category'
      });
      assert.deepEqual(
        retired,
        { written: false, skipped_reason: 'invalid_signal_kind' },
        'apply_category no longer mints a cross-firm signal (§7.6)'
      );
      state = await counts();
      assert.equal(state.events, 1, 'the refused kind wrote no event');
      assert.equal(state.audits, 1, 'the refused kind audited nothing');
      assert.deepEqual(
        state.rollup,
        { occurrence_weight: 3, occurrence_count: 1 },
        'the rollup never saw the refused kind'
      );

      // ── 4. A DISTINCT remember_merchant apply still accumulates ──────────
      const second = await recordMerchantSignalInDb({
        ...APPLY,
        client,
        transactionId: 'tx-78',
        actionIndex: 1,
        signalKind: 'remember_merchant'
      });
      assert.equal(second.written, true);
      assert.notEqual(second.event_id, first.event_id);
      state = await counts();
      assert.deepEqual(
        { events: state.events, audits: state.audits },
        { events: 2, audits: 2 }
      );
      assert.deepEqual(state.rollup, { occurrence_weight: 6, occurrence_count: 2 });

      // ── 5. Audit as PRECONDITION: no audit row, no event ─────────────────
      await client.query('alter table audit_events rename to audit_events_offline');
      await client.query('begin');
      await assert.rejects(
        recordMerchantSignalInDb({
          ...APPLY,
          client,
          transactionId: 'tx-79',
          actionIndex: 2,
          signalKind: 'remember_merchant'
        }),
        /audit_events/,
        'a failed audit insert fails the write'
      );
      await client.query('rollback');
      await client.query('alter table audit_events_offline rename to audit_events');
      state = await counts();
      assert.equal(state.events, 2, 'the event insert rolled back with its audit');
      assert.deepEqual(
        state.rollup,
        { occurrence_weight: 6, occurrence_count: 2 },
        'the rollup never saw the failed write'
      );
    } finally {
      await client.end();
      try { await admin.query(`drop database "${dbName}" with (force)`); } catch { /* teardown best-effort */ }
      await admin.end();
    }
  }
);
