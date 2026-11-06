// Donna Inventory I4·posting — P6 reconciliation gatherer, fake-pg tests (design §16/§19).
// The read-only gatherer reads GL balances by canonical role, inventory-journal movements, and
// the allowance register, then runs the pure §16 engines. Fake-pg proves the SQL shape + the
// role/currency summation wiring; the real constraint/rollback behavior is the DATABASE_URL-
// gated integration suite. The gatherer writes NOTHING — this suite asserts every query is a
// SELECT.
//   node --test server/donna/inventory/reconciliationDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { gatherInventoryReconciliationState, runInventoryReconciliationFromDb } from './reconciliationDb.js';

// A fake pg client that routes the three read queries by their FROM clause. `gl` maps
// canonical_role → { debit, credit }; `movements` is the (posting_kind, role, currency) rows;
// `lots` is the allowance register.
const fakeClient = ({ gl = {}, movements = [], lots = [], onMissing = null } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (onMissing) { const e = new Error('relation missing'); e.code = onMissing; throw e; }
      if (sql.includes('information_schema.columns')) return { rows: [] };
      if (sql.includes('with lines as')) return { rows: [{ scope_exists: true, invalid_sources: 0,
        gl: Object.entries(gl).map(([role, v]) => ({ role, debit: v.debit ?? 0, credit: v.credit ?? 0 })),
        movements: movements.map(m => ({ ...m, debit: m.debit ?? 0, credit: m.credit ?? 0 })), allowance_lots: lots,
        operations: [], invalid_operations: 0, currencies: [], stock_operation_ids: [],
        grni_balances: gl['liability.grni'] ? [{currency:movements.find(m=>m.role==='liability.grni')?.currency || 'EUR',
          balance:(gl['liability.grni'].credit || 0)-(gl['liability.grni'].debit || 0)}] : [] }] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    }
  };
};

// A minimal kernel receipt (the wrapped { applied, receipt } the gatherer unwraps).
const kernelReceipt = ({ inventoryValue = 0, effects = [], functionalCurrency = 'EUR', conservation = { delta: 0 } } = {}) => ({
  applied: true,
  receipt: { inventoryValue, operationEffects: effects, functionalCurrency, conservation }
});

test('gatherer runs only SELECTs (read-only) and ties a clean book', async () => {
  const client = fakeClient({
    gl: { 'asset.inventory': { debit: 100, credit: 60 }, 'liability.grni': { debit: 40, credit: 100 } },
    movements: [
      { posting_kind: 'receipt', role: 'asset.inventory', currency: 'EUR', debit: 100, credit: 0 },
      { posting_kind: 'receipt', role: 'liability.grni', currency: 'EUR', debit: 0, credit: 100 },
      { posting_kind: 'matched_supplier_bill', role: 'liability.grni', currency: 'EUR', debit: 40, credit: 0 },
      { posting_kind: 'shipment_cogs', role: 'asset.inventory', currency: 'EUR', debit: 0, credit: 60 },
      { posting_kind: 'shipment_cogs', role: 'expense.cost_of_sales', currency: 'EUR', debit: 60, credit: 0 }
    ]
  });
  const subledger = kernelReceipt({
    inventoryValue: 40, functionalCurrency: 'EUR', conservation: { delta: 0 },
    effects: [
      { amountToInventory: 100, amountToCogsOrVariance: 0, amountToGrni: 100 },
      { amountToInventory: -60, amountToCogsOrVariance: 60, amountToGrni: 0 }
    ]
  });
  const { verdict, state } = await runInventoryReconciliationFromDb({ client, firmId: 'f1', clientId: 'c1', subledger });

  // Every query is a SELECT (no write).
  for (const q of client.queries) assert.match(q.sql.trim().toLowerCase(), /^(select|with)/, `not a select: ${q.sql.slice(0, 40)}`);

  // GL gross inventory = 100 − 60 = 40, ties the subledger 40.
  assert.equal(state.inventoryToGl.glInventoryGross, 40);
  assert.equal(state.inventoryToGl.subledgerValue, 40);
  // GRNI: GL = 100 credit − 40 debit = 60; accrued 100 − matched 40 = 60.
  const eur = state.grni.byCurrency.find((r) => r.currency === 'EUR');
  assert.equal(eur.glGrni, 60);
  assert.equal(eur.accruedReceipts, 100);
  assert.equal(eur.matchedAllocations, 40);
  assert.equal(verdict.engines.inventory_to_gl.status, 'tied');
  assert.equal(verdict.engines.grni_to_open_receipts.status, 'tied');
  assert.equal(verdict.engines.conservation.status, 'tied');
  assert.equal(verdict.tied, true);
});

test('gatherer flips credit-normal roles (GRNI, allowance) to a positive magnitude', async () => {
  const client = fakeClient({
    gl: { 'contra_asset.inventory_valuation_allowance': { debit: 0, credit: 150 } },
    lots: [{ id: 1, scope_item_id: 'SKU1', scope_group: null, allowance_amount: 150, consumed_amount: 0, max_reversible_amount: 150, status: 'active' }]
  });
  const state = await gatherInventoryReconciliationState({ client, firmId: 'f1', clientId: 'c1', subledger: kernelReceipt({}), onHandByScope: { 'item:SKU1': { qty: 3, value: 400 } } });
  assert.equal(state.allowance.glAllowance, 150);          // flipped from a 150 credit
  assert.equal(state.inventoryToGl.glAllowance, 150);
  assert.equal(state.inventoryToGl.registerAllowance, 150);
});

test('gatherer surfaces a register-vs-GL allowance desync as an engineering incident', async () => {
  const client = fakeClient({
    gl: { 'contra_asset.inventory_valuation_allowance': { debit: 0, credit: 120 } }, // GL 120
    lots: [{ id: 1, scope_item_id: 'SKU1', scope_group: null, allowance_amount: 150, consumed_amount: 0, max_reversible_amount: 150, status: 'active' }] // register 150
  });
  const { verdict } = await runInventoryReconciliationFromDb({ client, firmId: 'f1', clientId: 'c1', subledger: kernelReceipt({}), onHandByScope: { 'item:SKU1': { qty: 3, value: 400 } } });
  assert.equal(verdict.engines.allowance_integrity.status, 'breach');
  assert.equal(verdict.engines.allowance_integrity.waiter.type, 'engineering_incident');
});

test('gatherer surfaces a stranded allowance (stock gone, lot still active) to the accountant/operator', async () => {
  const client = fakeClient({
    gl: { 'contra_asset.inventory_valuation_allowance': { debit: 0, credit: 100 } },
    lots: [{ id: 1, scope_item_id: 'SKU-GONE', scope_group: null, allowance_amount: 100, consumed_amount: 0, max_reversible_amount: 100, status: 'active' }]
  });
  const { verdict } = await runInventoryReconciliationFromDb({ client, firmId: 'f1', clientId: 'c1', subledger: kernelReceipt({}), onHandByScope: { 'item:SKU-GONE': { qty: 0, value: 0 } } });
  const eng = verdict.engines.allowance_integrity;
  assert.equal(eng.status, 'exception');
  assert.equal(eng.waiter.reason, 'stranded_allowance_on_derecognition');
});

test('gatherer reports missing schema as unavailable, never an empty tied book', async () => {
  const client = fakeClient({ onMissing: '42P01' });
  const { verdict } = await runInventoryReconciliationFromDb({ client, firmId: 'f1', clientId: 'c1', subledger: kernelReceipt({}) });
  assert.equal(verdict.tied, false);
  assert.equal(verdict.reconciliation_status, 'open');
  assert.equal(verdict.engines.inventory_to_gl.status, 'unavailable');
  assert.equal(verdict.unavailable.length, 5);
});

test('gatherer feeds closeRates into the open-GRNI retranslation obligation', async () => {
  const client = fakeClient({
    gl: { 'liability.grni': { debit: 0, credit: 745 } },
    movements: [{ posting_kind: 'receipt', role: 'liability.grni', currency: 'GBP', debit: 0, credit: 745 }]
  });
  const subledger = kernelReceipt({ functionalCurrency: 'EUR' });
  const { verdict } = await runInventoryReconciliationFromDb({
    client, firmId: 'f1', clientId: 'c1', subledger,
    closeRates: { GBP: { closeRate: 1.18, bookedRate: 1.15, sourceOpenAmount: 645 } }
  });
  const eng = verdict.engines.grni_to_open_receipts;
  assert.equal(eng.status, 'obligation');
  assert.equal(eng.waiter.reason, 'open_grni_retranslation_due');
});

test('gatherer requires client, firmId, clientId', async () => {
  await assert.rejects(() => gatherInventoryReconciliationState({ firmId: 'f', clientId: 'c' }), /requires client/);
});


test('historical cutoff requires a valid explicit calendar date', async () => {
  for (const cutoff of ['', '2026-02-30', '2026-10-01T23:00:00Z', '0000-01-01', 20261001]) {
    const client = fakeClient();
    const out = await runInventoryReconciliationFromDb({ client, firmId:'f', clientId:'c', cutoff });
    assert.equal(out.verdict.tied, false);
    assert.equal(out.state.availability.reason, 'invalid_reconciliation_cutoff');
    assert.equal(client.queries.length, 0);
  }
  const out = await runInventoryReconciliationFromDb({ client:fakeClient(), firmId:'f', clientId:'c', mode:'historical' });
  assert.equal(out.state.availability.reason, 'invalid_reconciliation_cutoff');
});

test('historical empty book is evidenced and ignores an arbitrary current subledger', async () => {
  const client = fakeClient();
  const { verdict, state } = await runInventoryReconciliationFromDb({ client, firmId:'f', clientId:'c', cutoff:'2026-02-28',
    subledger: kernelReceipt({ inventoryValue:999 }), onHandByScope:{'item:fake':{qty:100,value:999}} });
  assert.equal(verdict.tied, true);
  assert.equal(state.inventoryToGl.subledgerValue, 0);
  assert.equal(state.basis.cutoff, '2026-02-28');
  assert.equal(client.queries.length, 2, 'catalog admission then one source snapshot');
  const sql=client.queries[1].sql;
  assert.match(sql, /journal_status in \('posted','closed'\)/);
  assert.match(sql, /journal_date <= \$4::date/);
  assert.match(sql, /at time zone 'UTC'/);
});

test('missing current kernel facts are unavailable rather than defaulting to zero', async () => {
  for (const subledger of [null, {inventoryValue:0}, {applied:false,reason:'missing_cost_basis'}, {inventoryValue:NaN,operationEffects:[]}]) {
    const out=await runInventoryReconciliationFromDb({client:fakeClient(),firmId:'f',clientId:'c',subledger});
    assert.equal(out.state.availability.reason,'subledger_basis_unavailable');
    assert.equal(out.verdict.tied,false);
  }
});
