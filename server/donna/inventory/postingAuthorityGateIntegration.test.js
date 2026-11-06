// Donna Inventory I4·posting — P7 §13 executor gate, real-Postgres integration (design §19). The
// fake-pg tests prove the gate wiring + branch logic; this proves it end-to-end against the real
// executor + gateway + a real migration-083 grant: an authorized unattended post lands a real
// ledger journal attributed to the grant, and the DAILY aggregate — summed through the real
// attempts → journals → ledger_journals join — binds cumulative posting so a later post breaches.
// SKIPS unless DATABASE_URL is set, and skips if 080/083 aren't migrated. Runs in ONE rolled-back
// transaction — no trace left.
//   DATABASE_URL=postgres://… node --test server/donna/inventory/postingAuthorityGateIntegration.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { postInventoryJournalWithinTransaction } from './postingDb.js';
import { buildInventoryJournalDraft } from './posting.js';

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const opts = { skip: HAVE_DB ? false : 'DATABASE_URL not set — real-Postgres suite skipped' };

const roleAccounts = {
  'asset.inventory': { role: 'inventory_asset_inventory', code: '1400', name: 'Inventory', canonical_role: 'asset.inventory', normal_balance: 'debit' },
  'liability.grni': { role: 'inventory_liability_grni', code: '2880', name: 'GRNI', canonical_role: 'liability.grni', normal_balance: 'credit' }
};

const receiptDraft = (operationId, amount) => buildInventoryJournalDraft({
  effect: {
    operationId, effectType: 'receipt', functionalCurrency: 'EUR', dates: { accounting_date: '2026-07-02' },
    legs: [
      { bucket: 'inventory', direction: 'debit', amount },
      { bucket: 'grni', direction: 'credit', amount }
    ]
  },
  roleAccounts, valuationRunId: `vrun-${operationId}`
});

const AUTHZ = { enforce: true, context: { confidence: 0.96, evidencePresent: true }, asOf: '2026-07-12T00:00:00Z' };

const withRolledBackFixture = async (fn) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const firmId = 'itest-firm-inv-gate';
  const clientId = 'itest-client-inv-gate';
  try {
    await client.query('begin');
    if (!(await client.query("select to_regclass('public.inventory_posting_authority_grants') as t")).rows[0]?.t) { await client.query('rollback'); return { skipped: '083 not migrated' }; }
    await client.query(`insert into firms (id, name, slug) values ($1, 'ITest Firm', $2) on conflict (id) do nothing`, [firmId, `itest-inv-gate-${firmId}`]);
    await client.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'ITest Client') on conflict (id) do nothing`, [clientId, firmId]);
    const result = await fn({ client, firmId, clientId });
    return { result };
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
};

// A grant with valid_from in the past (decoupled from the run clock) + a daily ceiling of 120.
const insertGrant = (client, { firmId, clientId }) =>
  client.query(
    `insert into inventory_posting_authority_grants
       (id, firm_id, client_id, allowed_posting_kinds, allowed_accounts, per_journal_ceiling,
        daily_aggregate_ceiling, currency, authorized_by_actor_type, source, status, valid_from)
     values ('g-gate',$1,$2, array['receipt'], array['asset.inventory','liability.grni'], 1000,
        120,'EUR','accountant','accountant_approval','active','2020-01-01')`,
    [firmId, clientId]
  );

test('P7 §13: an authorized unattended post lands attributed to the grant; the daily ceiling binds cumulative posting (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    await insertGrant(client, { firmId, clientId });

    // Post 1 (50) and Post 2 (50) → cumulative 100 ≤ 120 → both authorized.
    const p1 = await postInventoryJournalWithinTransaction(client, { firmId, clientId, actorId: 'loop', draft: receiptDraft('op-1', 50), authorization: AUTHZ });
    const p2 = await postInventoryJournalWithinTransaction(client, { firmId, clientId, actorId: 'loop', draft: receiptDraft('op-2', 50), authorization: AUTHZ });
    // Post 3 (50) → cumulative 150 > 120 → denied by the daily aggregate ceiling (summed through
    // the real attempts→journals→ledger_journals join of posts 1 + 2).
    const p3 = await postInventoryJournalWithinTransaction(client, { firmId, clientId, actorId: 'loop', draft: receiptDraft('op-3', 50), authorization: AUTHZ });

    const postedCount = (await client.query(
      "select count(*)::int n from inventory_posting_attempts where firm_id=$1 and client_id=$2 and outcome='posted' and authority_grant_id='g-gate'",
      [firmId, clientId]
    )).rows[0].n;
    const p1Attempt = (await client.query('select authority_grant_id from inventory_posting_attempts where id=$1', [p1.attempt_id])).rows[0];
    return {
      p1: p1.status, p2: p2.status, p3Refused: p3.refused, p3Reason: p3.reason_code, p3Waiter: p3.waiter_type,
      p3Ledger: p3.ledger_journal_id ?? null, postedCount, p1GrantId: p1Attempt?.authority_grant_id
    };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.p1, 'posted', 'first post authorized');
  assert.equal(result.p2, 'posted', 'second post authorized (cumulative 100 ≤ 120)');
  assert.equal(result.p1GrantId, 'g-gate', 'the posted attempt is attributed to the covering grant');
  assert.equal(result.p3Refused, true, 'third post breaches the daily aggregate ceiling');
  assert.equal(result.p3Reason, 'authority_daily_aggregate_ceiling');
  assert.equal(result.p3Waiter, 'accountant_operator');
  assert.equal(result.p3Ledger, null, 'the denied post wrote no ledger journal');
  assert.equal(result.postedCount, 2, 'exactly two posts landed under the grant — the third was held');
});

test('P7 §13: an unattended post with NO grant is denied and posts nothing (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    // No grant inserted → fail-closed deny.
    const res = await postInventoryJournalWithinTransaction(client, { firmId, clientId, actorId: 'loop', draft: receiptDraft('op-nogrant', 50), authorization: AUTHZ });
    const posted = (await client.query("select count(*)::int n from inventory_posting_attempts where firm_id=$1 and client_id=$2 and outcome='posted'", [firmId, clientId])).rows[0].n;
    return { refused: res.refused, reason: res.reason_code, posted };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'authority_no_grant');
  assert.equal(result.posted, 0, 'no journal posted without a covering grant');
});
