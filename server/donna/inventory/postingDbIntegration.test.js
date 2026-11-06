// Donna Inventory I4·posting — P5 real-Postgres integration suite (design §19). The fake-pg
// query-order tests prove GATE ORDERING and journal shape but CANNOT prove constraint /
// rollback / race behavior; these do, against a real database. The whole suite SKIPS unless
// DATABASE_URL is set (the repo's unit harness is mock-pg only), so it is a no-op in the
// standard `npm test` run and runs in a DB-provisioned CI before canary.
//
// Everything runs inside ONE transaction that is ROLLED BACK at the end — the suite seeds a
// throwaway firm + client and never leaves a trace. If the P5 schema (migration 080) is not
// present, the suite skips with a diagnostic rather than failing.
//   DATABASE_URL=postgres://… node --test server/donna/inventory/postingDbIntegration.test.js
//
// §19 scenarios covered here (the ones only a real DB can prove):
//   • partial-unique index: exactly ONE successful application per (operation_id, posting_kind,
//     posting_basis_version) — a second 'posted' at the same key raises a unique violation.
//   • coexistence: refused / superseded / failed attempts at the SAME key coexist freely.
//   • basis versioning: a later posting_basis_version posts a NEW successful row without
//     conflicting with the prior version's success (delta re-posting is not blocked).
//   • inventory_posting_heads: the view returns the latest attempt per (operation, kind).

import assert from 'node:assert/strict';
import test from 'node:test';

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const opts = { skip: HAVE_DB ? false : 'DATABASE_URL not set — real-Postgres suite skipped (mock-pg harness covers gate ordering)' };

// A tiny helper: open a client, BEGIN, seed a throwaway firm+client, run `fn`, ROLLBACK.
const withRolledBackFixture = async (fn) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const firmId = 'itest-firm-inv-p5';
  const clientId = 'itest-client-inv-p5';
  try {
    await client.query('begin');
    // Skip the whole body if the P5 table isn't migrated in this DB.
    const present = await client.query("select to_regclass('public.inventory_posting_attempts') as t");
    if (!present.rows[0]?.t) { await client.query('rollback'); return { skipped: 'inventory_posting_attempts not migrated' }; }
    await client.query(
      `insert into firms (id, name, slug) values ($1, 'ITest Firm', $2) on conflict (id) do nothing`,
      [firmId, `itest-inv-p5-${firmId}`]
    );
    await client.query(
      `insert into clients (id, firm_id, company_name) values ($1, $2, 'ITest Client') on conflict (id) do nothing`,
      [clientId, firmId]
    );
    const result = await fn({ client, firmId, clientId });
    return { result };
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
};

const insertAttempt = (client, { firmId, clientId, operationId, postingKind, basis, outcome, actor = 'itest' }) =>
  client.query(
    `insert into inventory_posting_attempts
       (firm_id, client_id, operation_id, posting_kind, posting_basis_version, valuation_run_id, outcome, actor_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [firmId, clientId, operationId, postingKind, basis, `vrun-${operationId}-${basis}`, outcome, actor]
  );

test('partial-unique index: a second successful application at the same key conflicts', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    const key = { firmId, clientId, operationId: 'op-uniq', postingKind: 'receipt', basis: 1 };
    await insertAttempt(client, { ...key, outcome: 'posted' });
    // A refused + a superseded at the SAME key must coexist (partial index only guards successes).
    await insertAttempt(client, { ...key, outcome: 'refused' });
    await insertAttempt(client, { ...key, outcome: 'superseded' });
    // A second 'posted' at the same key must violate the partial-unique index.
    let conflicted = false;
    try {
      await client.query('savepoint sp1');
      await insertAttempt(client, { ...key, outcome: 'posted' });
    } catch (e) {
      conflicted = e.code === '23505'; // unique_violation
      await client.query('rollback to savepoint sp1');
    }
    return { conflicted };
  });
  if (skipped) return t.skip(skipped);
  assert.equal(result.conflicted, true, 'a second successful application at the same basis version must conflict');
});

test('basis versioning: a new posting_basis_version posts a fresh success without conflict', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    const base = { firmId, clientId, operationId: 'op-basis', postingKind: 'landed_cost' };
    await insertAttempt(client, { ...base, basis: 1, outcome: 'posted' });
    await insertAttempt(client, { ...base, basis: 2, outcome: 'posted' }); // delta re-post — must be allowed
    const count = await client.query(
      `select count(*)::int as n from inventory_posting_attempts
        where firm_id=$1 and client_id=$2 and operation_id=$3 and posting_kind=$4 and outcome='posted'`,
      [firmId, clientId, 'op-basis', 'landed_cost']
    );
    return { n: count.rows[0].n };
  });
  if (skipped) return t.skip(skipped);
  assert.equal(result.n, 2, 'two successful posts at different basis versions coexist');
});

test('inventory_posting_heads returns the latest attempt per (operation, kind)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    const base = { firmId, clientId, operationId: 'op-head', postingKind: 'shipment_cogs' };
    const first = await insertAttempt(client, { ...base, basis: 1, outcome: 'refused' });
    const second = await insertAttempt(client, { ...base, basis: 1, outcome: 'posted' });
    const head = await client.query(
      `select attempt_id, outcome from inventory_posting_heads
        where firm_id=$1 and client_id=$2 and operation_id=$3 and posting_kind=$4`,
      [firmId, clientId, 'op-head', 'shipment_cogs']
    );
    return { headId: head.rows[0]?.attempt_id, headOutcome: head.rows[0]?.outcome, firstId: first.rows[0].id, secondId: second.rows[0].id };
  });
  if (skipped) return t.skip(skipped);
  assert.equal(result.headOutcome, 'posted', 'the head is the newest attempt');
  assert.equal(String(result.headId), String(result.secondId));
});

// ── §5-F register writer + derecognition consumption (P6b, real Postgres) ──────
import { postInventoryJournalWithinTransaction, consumeInventoryAllowanceWithinTransaction } from './postingDb.js';
import { buildInventoryWriteDownDraft } from './posting.js';

const releaseRoleAccounts = {
  'expense.inventory_write_down': { role: 'inventory_expense_inventory_write_down', code: '5300', name: 'Write-down', canonical_role: 'expense.inventory_write_down', normal_balance: 'debit' },
  'contra_asset.inventory_valuation_allowance': { role: 'inventory_contra_asset_inventory_valuation_allowance', code: '1490', name: 'Allowance', canonical_role: 'contra_asset.inventory_valuation_allowance', normal_balance: 'credit' },
  'expense.cost_of_sales': { role: 'inventory_expense_cost_of_sales', code: '5000', name: 'COGS', canonical_role: 'expense.cost_of_sales', normal_balance: 'debit' }
};

test('P6b: write-down persists a bound lot, then a sale consumes it proportionally (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    if (!(await client.query("select to_regclass('public.inventory_valuation_allowances') as t")).rows[0]?.t) return { skipped: '080 not migrated' };
    // Bail if 081 (bound_quantity) isn't migrated.
    const hasCol = (await client.query("select 1 from information_schema.columns where table_name='inventory_valuation_allowances' and column_name='bound_quantity'")).rowCount;
    if (!hasCol) return { skipped: '081 not migrated' };

    // 1. Post the write-down through the P5 executor + persist the lot (30 on 10 units).
    const wd = buildInventoryWriteDownDraft({
      writeDown: { id: 'wd-1', amount: 30, currency: 'EUR', date: '2026-07-08', scope_item_id: 'SKU1', reviewer: 'itest', valuation_run_id: 'vrun-wd' },
      roleAccounts: releaseRoleAccounts
    });
    const wdRes = await postInventoryJournalWithinTransaction(client, {
      firmId, clientId, actorId: 'itest', draft: wd, valuationIdentity: { valuationRunId: 'vrun-wd' },
      allowanceLot: { scope_item_id: 'SKU1', valuation_date: '2026-07-08', allowance_amount: 30, currency: 'EUR', max_reversible_amount: 30, bound_quantity: 10, reviewer: 'itest' }
    });

    const lot0 = (await client.query('select allowance_amount, consumed_amount, bound_quantity, remaining_quantity, status from inventory_valuation_allowances where id = $1', [wdRes.allowance_lot_id])).rows[0];

    // 2. Sell 4 units → release 12, lot moves to consumed 12 / remaining 6, still active.
    const c1 = await consumeInventoryAllowanceWithinTransaction(client, {
      firmId, clientId, actorId: 'itest', scopeItemId: 'SKU1', derecognizedQty: 4, reason: 'sale',
      roleAccounts: releaseRoleAccounts, derecognitionOperationId: 'ship-1', currency: 'EUR', date: '2026-07-10'
    });
    const lot1 = (await client.query('select consumed_amount, remaining_quantity, status from inventory_valuation_allowances where id = $1', [wdRes.allowance_lot_id])).rows[0];

    // 3. Sell the remaining 6 → release the rest (18), lot fully released.
    const c2 = await consumeInventoryAllowanceWithinTransaction(client, {
      firmId, clientId, actorId: 'itest', scopeItemId: 'SKU1', derecognizedQty: 6, reason: 'sale',
      roleAccounts: releaseRoleAccounts, derecognitionOperationId: 'ship-2', currency: 'EUR', date: '2026-07-11'
    });
    const lot2 = (await client.query('select consumed_amount, remaining_quantity, status from inventory_valuation_allowances where id = $1', [wdRes.allowance_lot_id])).rows[0];

    // A release attempt was recorded under the allowance_release kind (081 CHECK accepts it).
    const releaseAttempts = (await client.query("select count(*)::int n from inventory_posting_attempts where firm_id=$1 and client_id=$2 and posting_kind='allowance_release' and outcome='posted'", [firmId, clientId])).rows[0].n;

    return { lot0, c1, lot1, c2, lot2, releaseAttempts };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);

  assert.equal(Number(result.lot0.bound_quantity), 10);
  assert.equal(Number(result.lot0.remaining_quantity), 10);
  assert.equal(result.lot0.status, 'active');

  assert.equal(result.c1.released_total, 12);
  assert.equal(Number(result.lot1.consumed_amount), 12);
  assert.equal(Number(result.lot1.remaining_quantity), 6);
  assert.equal(result.lot1.status, 'active');

  assert.equal(result.c2.released_total, 18);
  assert.equal(Number(result.lot2.consumed_amount), 30);
  assert.equal(Number(result.lot2.remaining_quantity), 0);
  assert.equal(result.lot2.status, 'released');

  assert.equal(result.releaseAttempts, 2, 'two allowance_release attempts posted');
});

test('P6b: re-consuming the SAME derecognition is idempotent — no double release (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    const hasCol = (await client.query("select 1 from information_schema.columns where table_name='inventory_valuation_allowances' and column_name='bound_quantity'")).rowCount;
    if (!hasCol) return { skipped: '081 not migrated' };
    const wd = buildInventoryWriteDownDraft({ writeDown: { id: 'wd-2', amount: 30, currency: 'EUR', date: '2026-07-08', scope_item_id: 'SKU2', reviewer: 'itest', valuation_run_id: 'vrun-wd2' }, roleAccounts: releaseRoleAccounts });
    const wdRes = await postInventoryJournalWithinTransaction(client, { firmId, clientId, actorId: 'itest', draft: wd, valuationIdentity: { valuationRunId: 'vrun-wd2' }, allowanceLot: { scope_item_id: 'SKU2', valuation_date: '2026-07-08', allowance_amount: 30, currency: 'EUR', max_reversible_amount: 30, bound_quantity: 10, reviewer: 'itest' } });
    // Consume the same derecognition twice.
    await consumeInventoryAllowanceWithinTransaction(client, { firmId, clientId, actorId: 'itest', scopeItemId: 'SKU2', derecognizedQty: 4, reason: 'sale', roleAccounts: releaseRoleAccounts, derecognitionOperationId: 'ship-dup', currency: 'EUR', date: '2026-07-10' });
    const second = await consumeInventoryAllowanceWithinTransaction(client, { firmId, clientId, actorId: 'itest', scopeItemId: 'SKU2', derecognizedQty: 4, reason: 'sale', roleAccounts: releaseRoleAccounts, derecognitionOperationId: 'ship-dup', currency: 'EUR', date: '2026-07-10' });
    const lot = (await client.query('select consumed_amount, remaining_quantity from inventory_valuation_allowances where id = $1', [wdRes.allowance_lot_id])).rows[0];
    return { secondOutcome: second.consumed[0]?.outcome, consumed: Number(lot.consumed_amount), remaining: Number(lot.remaining_quantity) };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  // The second run REPLAYED the release (no fresh post) and did NOT decrement again.
  assert.equal(result.secondOutcome, 'replayed');
  assert.equal(result.consumed, 12, 'consumed only once');
  assert.equal(result.remaining, 6, 'remaining decremented only once');
});

// ── §10 FX retranslation of open GRNI at close (P6c, real Postgres) ────────────
import { retranslateOpenGrniWithinTransaction } from './postingDb.js';

const retransRoleAccounts = {
  'liability.grni': { role: 'inventory_liability_grni', code: '2880', name: 'GRNI', canonical_role: 'liability.grni', normal_balance: 'credit' },
  'expense.fx': { role: 'inventory_expense_fx', code: '7600', name: 'FX gain/loss', canonical_role: 'expense.fx', normal_balance: 'debit' }
};

test('P6c: open foreign GRNI retranslates at close, posts a grni_retranslation journal, idempotent replay (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    // 082 must be migrated (the grni_retranslation kind is in the CHECK).
    const kindOk = (await client.query(
      "select pg_get_constraintdef(oid) def from pg_constraint where conname='inventory_posting_attempts_posting_kind_check'"
    )).rows[0]?.def || '';
    if (!kindOk.includes('grni_retranslation')) return { skipped: '082 not migrated' };

    const grniByCurrency = [
      { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0, closeRate: 1.18, bookedRate: 1.15, sourceOpenAmount: 745 }
    ];
    // First close run → posts the delta (745 × 0.03 = 22.35, DR fx / CR grni).
    const r1 = await retranslateOpenGrniWithinTransaction(client, {
      firmId, clientId, actorId: 'itest', closePeriod: '2026-Q3', functionalCurrency: 'EUR',
      grniByCurrency, roleAccounts: retransRoleAccounts, journalDate: '2026-09-30'
    });
    // A second run of the SAME close is an idempotent replay — no second journal.
    const r2 = await retranslateOpenGrniWithinTransaction(client, {
      firmId, clientId, actorId: 'itest', closePeriod: '2026-Q3', functionalCurrency: 'EUR',
      grniByCurrency, roleAccounts: retransRoleAccounts, journalDate: '2026-09-30'
    });
    const attempts = (await client.query(
      "select count(*)::int n from inventory_posting_attempts where firm_id=$1 and client_id=$2 and posting_kind='grni_retranslation' and outcome='posted'",
      [firmId, clientId]
    )).rows[0].n;
    return { r1Posted: r1.posted_count, r1Status: r1.retranslations[0]?.status, r2Status: r2.retranslations[0]?.status, attempts };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.r1Posted, 1, 'the first close run posts the retranslation');
  assert.equal(result.r1Status, 'posted');
  assert.equal(result.r2Status, 'replayed', 'the second run of the same close replays');
  assert.equal(result.attempts, 1, 'exactly one successful retranslation attempt — no double-post');
});

test('P6c: a missing close rate records an integration_system_retry attempt, no journal (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    const kindOk = (await client.query(
      "select pg_get_constraintdef(oid) def from pg_constraint where conname='inventory_posting_attempts_posting_kind_check'"
    )).rows[0]?.def || '';
    if (!kindOk.includes('grni_retranslation')) return { skipped: '082 not migrated' };
    const res = await retranslateOpenGrniWithinTransaction(client, {
      firmId, clientId, actorId: 'itest', closePeriod: '2026-Q4', functionalCurrency: 'EUR',
      grniByCurrency: [{ currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0, sourceOpenAmount: 745 }], // no closeRate
      roleAccounts: retransRoleAccounts
    });
    const refused = (await client.query(
      "select waiter_type, reason_code from inventory_posting_attempts where firm_id=$1 and client_id=$2 and posting_kind='grni_retranslation' and outcome='refused' order by id desc limit 1",
      [firmId, clientId]
    )).rows[0];
    const posted = (await client.query(
      "select count(*)::int n from inventory_posting_attempts where firm_id=$1 and client_id=$2 and posting_kind='grni_retranslation' and outcome='posted'",
      [firmId, clientId]
    )).rows[0].n;
    return { rateMissing: res.rate_missing, waiter: refused?.waiter_type, reason: refused?.reason_code, posted };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.rateMissing, 1);
  assert.equal(result.waiter, 'integration_system_retry');
  assert.equal(result.reason, 'missing_close_fx_rate');
  assert.equal(result.posted, 0, 'no journal posted on a missing rate');
});
