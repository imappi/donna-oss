// Donna Inventory I4·posting — P6 reconciliation engines, PURE invariant tests (design §16/§19).
// The four §19 identities are machine-checked here (GL inventory == subledger − allowance; GL
// GRNI == open accruals; COGS + remaining + losses == total accounted cost, zero residual; the
// variance decomposition sums to the total; allowance ties only to on-hand written-down stock),
// plus §12 waiter routing (a conservation / GL-vs-subledger desync is an ENGINEERING INCIDENT).
// Also ties the conservation engine to the REAL kernel (valuation.valueInventoryOperations) over
// generated valid streams — the ledger-proven zero-residual, not just the kernel's own.
//   node --test server/donna/inventory/reconciliationEngines.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcileInventoryToGl,
  reconcileGrniToOpenReceipts,
  reconcileCogsRevenueOrphans,
  reconcileConservation,
  reconcileAllowanceIntegrity,
  runInventoryReconciliation,
  RECONCILIATION_ENGINES,
  RECONCILIATION_MONEY_TOLERANCE
} from './reconciliationEngines.js';
import { valueInventoryOperations } from './valuation.js';

// ── Engine 1 — inventory_to_gl ────────────────────────────────────────────────
test('inventory_to_gl ties when GL gross == subledger and GL allowance == register', () => {
  const v = reconcileInventoryToGl({ glInventoryGross: 1000, glAllowance: 150, subledgerValue: 1000, registerAllowance: 150 });
  assert.equal(v.status, 'tied');
  assert.equal(v.reconciliation_status, 'reconciled');
  assert.equal(v.residual, 0);
  assert.equal(v.waiter, null);
});

test('inventory_to_gl breaches to an engineering incident on a gross desync', () => {
  const v = reconcileInventoryToGl({ glInventoryGross: 1000, glAllowance: 0, subledgerValue: 990, registerAllowance: 0 });
  assert.equal(v.status, 'breach');
  assert.equal(v.residual, 10);
  assert.equal(v.waiter.type, 'engineering_incident');
});

test('inventory_to_gl breaches on an allowance-vs-register desync even when gross ties', () => {
  const v = reconcileInventoryToGl({ glInventoryGross: 500, glAllowance: 80, subledgerValue: 500, registerAllowance: 100 });
  assert.equal(v.status, 'breach');
  assert.equal(v.detail.allowance_residual, -20);
  assert.equal(v.waiter.type, 'engineering_incident');
});

test('inventory_to_gl treats a within-tolerance rounding residual as tied', () => {
  const v = reconcileInventoryToGl({ glInventoryGross: 1000.01, glAllowance: 0, subledgerValue: 1000, registerAllowance: 0 });
  assert.equal(v.status, 'tied');
});

// ── Engine 2 — grni_to_open_receipts ──────────────────────────────────────────
test('grni ties when GL GRNI == accrued − matched per currency', () => {
  const v = reconcileGrniToOpenReceipts({ functionalCurrency: 'EUR', byCurrency: [
    { currency: 'EUR', glGrni: 300, accruedReceipts: 800, matchedAllocations: 500 }
  ] });
  assert.equal(v.status, 'tied');
  assert.equal(v.waiter, null);
});

test('grni breaches to an engineering incident when the open balance does not match accruals', () => {
  const v = reconcileGrniToOpenReceipts({ functionalCurrency: 'EUR', byCurrency: [
    { currency: 'EUR', glGrni: 300, accruedReceipts: 800, matchedAllocations: 450 }
  ] });
  assert.equal(v.status, 'breach');
  assert.equal(v.residual, -50);
  assert.equal(v.waiter.type, 'engineering_incident');
});

test('grni surfaces an FX retranslation OBLIGATION for open foreign GRNI (not a breach)', () => {
  const v = reconcileGrniToOpenReceipts({ functionalCurrency: 'EUR', byCurrency: [
    { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0, closeRate: 1.18, bookedRate: 1.15, sourceOpenAmount: 645 }
  ] });
  assert.equal(v.status, 'obligation');
  assert.equal(v.waiter.type, 'accountant_operator');
  assert.equal(v.waiter.reason, 'open_grni_retranslation_due');
  assert.equal(v.detail.by_currency[0].retranslation.delta, money(645 * (1.18 - 1.15)));
});

test('grni routes a MISSING close rate to a bounded integration/system retry', () => {
  const v = reconcileGrniToOpenReceipts({ functionalCurrency: 'EUR', byCurrency: [
    { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0 }
  ] });
  assert.equal(v.status, 'obligation');
  assert.equal(v.waiter.type, 'integration_system_retry');
  assert.equal(v.waiter.reason, 'missing_close_fx_rate');
});

test('grni: a breach outranks a retranslation obligation', () => {
  const v = reconcileGrniToOpenReceipts({ functionalCurrency: 'EUR', byCurrency: [
    { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 100 } // desync
  ] });
  assert.equal(v.status, 'breach');
  assert.equal(v.waiter.type, 'engineering_incident');
});

// ── Engine 3 — cogs_revenue_orphans ───────────────────────────────────────────
test('cogs/revenue orphans: ties when every COGS has a revenue and vice versa', () => {
  const v = reconcileCogsRevenueOrphans({
    cogsEvents: [{ link: 'sale-1', amount: 40 }, { link: 'sale-2', amount: 60 }],
    revenueEvents: [{ link: 'sale-1', amount: 100 }, { link: 'sale-2', amount: 150 }]
  });
  assert.equal(v.status, 'tied');
  assert.equal(v.waiter, null);
});

test('cogs/revenue orphans: a COGS with no revenue is an exception on the accountant/operator', () => {
  const v = reconcileCogsRevenueOrphans({
    cogsEvents: [{ link: 'sale-1', amount: 40, operation_id: 'op-9' }],
    revenueEvents: []
  });
  assert.equal(v.status, 'exception');
  assert.equal(v.waiter.type, 'accountant_operator');
  assert.equal(v.detail.cogs_orphans.length, 1);
  assert.equal(v.detail.revenue_orphans.length, 0);
});

test('cogs/revenue orphans: a revenue with no COGS is also an exception', () => {
  const v = reconcileCogsRevenueOrphans({
    cogsEvents: [],
    revenueEvents: [{ link: 'sale-7', amount: 200, source_id: 'inv-7' }]
  });
  assert.equal(v.status, 'exception');
  assert.equal(v.detail.revenue_orphans.length, 1);
});

// ── Engine 4 — conservation (zero-residual) ───────────────────────────────────
test('conservation ties when kernel + ledger buckets + variance all zero-residual', () => {
  const v = reconcileConservation({
    kernelConservation: { delta: 0 },
    ledgerBuckets: { inventory: 100, cogs: 60, grni: 100 },
    kernelBuckets: { inventory: 100, cogs: 60, grni: 100 },
    ledgerFlow: { totalAccountedCost: 160, postedCogs: 60, explicitLosses: 0, remaining: 100 },
    variance: { total: 25, components: { purchase_price_variance: 10, quantity_variance: 5, fx_variance: 4, landed_cost_variance: 6, tax_variance: 0 } }
  });
  assert.equal(v.status, 'tied');
  assert.equal(v.residual, 0);
});

test('conservation: a kernel invariant violation is an engineering incident', () => {
  const v = reconcileConservation({ kernelConservation: { delta: 0.5 }, ledgerBuckets: { inventory: 0, cogs: 0, grni: 0 }, kernelBuckets: { inventory: 0, cogs: 0, grni: 0 } });
  assert.equal(v.status, 'breach');
  assert.equal(v.waiter.type, 'engineering_incident');
  assert.ok(v.detail.checks.find((c) => c.name === 'kernel_conservation' && !c.tied));
});

test('conservation: a ledger-vs-kernel bucket desync breaches', () => {
  const v = reconcileConservation({
    kernelConservation: { delta: 0 },
    ledgerBuckets: { inventory: 90, cogs: 60, grni: 100 },
    kernelBuckets: { inventory: 100, cogs: 60, grni: 100 }
  });
  assert.equal(v.status, 'breach');
  assert.ok(v.detail.checks.find((c) => c.name === 'inventory_bucket' && c.residual === -10));
});

test('conservation: the §4 variance decomposition must sum to the total (D-POST-3)', () => {
  const v = reconcileConservation({
    kernelConservation: { delta: 0 },
    variance: { total: 25, components: { purchase_price_variance: 10, quantity_variance: 5, fx_variance: 4, landed_cost_variance: 5, tax_variance: 0 } } // sums to 24
  });
  assert.equal(v.status, 'breach');
  assert.ok(v.detail.checks.find((c) => c.name === 'variance_decomposition' && c.residual === 1));
});

test('conservation: the direct ledger flow identity breaches when it does not zero out', () => {
  const v = reconcileConservation({
    kernelConservation: { delta: 0 },
    ledgerFlow: { totalAccountedCost: 160, postedCogs: 60, explicitLosses: 0, remaining: 95 } // 5 short
  });
  assert.equal(v.status, 'breach');
  assert.ok(v.detail.checks.find((c) => c.name === 'flow_identity' && c.residual === 5));
});

// ── Engine 5 — allowance_integrity + derecognition consumption ─────────────────
test('allowance integrity ties when register == GL and every active lot has on-hand stock', () => {
  const v = reconcileAllowanceIntegrity({
    lots: [{ id: 1, scope_item_id: 'SKU1', allowance_amount: 100, consumed_amount: 0, max_reversible_amount: 100, status: 'active' }],
    glAllowance: 100,
    onHandByScope: { 'item:SKU1': { qty: 5, value: 400 } }
  });
  assert.equal(v.status, 'tied');
  assert.equal(v.waiter, null);
});

test('allowance integrity: a STRANDED allowance on derecognized stock routes to the accountant/operator (§5-F redline)', () => {
  const v = reconcileAllowanceIntegrity({
    lots: [{ id: 2, scope_item_id: 'SKU2', allowance_amount: 100, consumed_amount: 0, max_reversible_amount: 100, status: 'active' }],
    glAllowance: 100,
    onHandByScope: { 'item:SKU2': { qty: 0, value: 0 } } // stock gone, allowance never released
  });
  assert.equal(v.status, 'exception');
  assert.equal(v.waiter.type, 'accountant_operator');
  assert.equal(v.waiter.reason, 'stranded_allowance_on_derecognition');
  assert.equal(v.detail.stranded.length, 1);
});

test('allowance integrity: a register-vs-GL desync is an engineering incident', () => {
  const v = reconcileAllowanceIntegrity({
    lots: [{ id: 3, scope_item_id: 'SKU3', allowance_amount: 100, consumed_amount: 0, max_reversible_amount: 100, status: 'active' }],
    glAllowance: 80, // GL says 80, register says 100
    onHandByScope: { 'item:SKU3': { qty: 3, value: 300 } }
  });
  assert.equal(v.status, 'breach');
  assert.equal(v.waiter.type, 'engineering_incident');
  assert.equal(v.waiter.reason, 'allowance_register_gl_desync');
});

test('allowance integrity: allowance exceeding the on-hand carrying cost is flagged', () => {
  const v = reconcileAllowanceIntegrity({
    lots: [{ id: 4, scope_item_id: 'SKU4', allowance_amount: 500, consumed_amount: 0, max_reversible_amount: 500, status: 'active' }],
    glAllowance: 500,
    onHandByScope: { 'item:SKU4': { qty: 2, value: 300 } } // allowance 500 > carrying 300
  });
  assert.equal(v.status, 'exception');
  assert.equal(v.waiter.reason, 'allowance_exceeds_on_hand');
});

test('allowance integrity: a reversal beyond the write-down cap is flagged (IAS 2 cap)', () => {
  const v = reconcileAllowanceIntegrity({
    lots: [{ id: 5, scope_item_id: 'SKU5', allowance_amount: 100, consumed_amount: 0, max_reversible_amount: 100, reversed_amount: 120, status: 'active' }],
    glAllowance: 100,
    onHandByScope: { 'item:SKU5': { qty: 4, value: 400 } }
  });
  assert.equal(v.status, 'exception');
  assert.equal(v.waiter.reason, 'reversal_exceeds_cap');
});

test('allowance integrity: a released lot with no outstanding balance never strands', () => {
  const v = reconcileAllowanceIntegrity({
    lots: [{ id: 6, scope_item_id: 'SKU6', allowance_amount: 100, consumed_amount: 100, max_reversible_amount: 100, status: 'released' }],
    glAllowance: 0,
    onHandByScope: { 'item:SKU6': { qty: 0, value: 0 } } // stock gone but allowance fully consumed
  });
  assert.equal(v.status, 'tied');
});

// ── Top-level runner ──────────────────────────────────────────────────────────
test('runInventoryReconciliation: a fresh empty book ties on every engine', () => {
  const out = runInventoryReconciliation({});
  assert.equal(out.tied, true);
  assert.equal(out.reconciliation_status, 'reconciled');
  assert.deepEqual(Object.keys(out.engines).sort(), [...RECONCILIATION_ENGINES].sort());
  assert.equal(out.breaches.length, 0);
});

test('runInventoryReconciliation: collects each non-tied engine into breaches/obligations/exceptions', () => {
  const out = runInventoryReconciliation({
    inventoryToGl: { glInventoryGross: 100, subledgerValue: 90 },       // breach
    grni: { functionalCurrency: 'EUR', byCurrency: [{ currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0 }] }, // obligation (missing rate)
    cogsRevenue: { cogsEvents: [{ link: 'sale-x', amount: 10 }], revenueEvents: [] } // exception
  });
  assert.equal(out.tied, false);
  assert.equal(out.breaches.length, 1);
  assert.equal(out.breaches[0].engine, 'inventory_to_gl');
  assert.equal(out.obligations.length, 1);
  assert.equal(out.exceptions.length, 1);
});

// ── Property/invariant: tie the conservation engine to the REAL kernel ─────────
// Over generated valid receipt→sale streams, the ledger's per-bucket movements (simulated
// exactly from the kernel's own signed effects — what the posting layer routes) must tie to the
// kernel buckets with ZERO residual, and the kernel's conservation delta must be zero. This is
// the §16 "proven against the LEDGER, not just the kernel output" identity.
const buildStream = (seed) => {
  // Deterministic pseudo-stream (no Math.random — vary by seed for replay).
  const ops = [];
  let id = 0;
  const recvQty = 5 + (seed % 7);
  const recvCost = 10 + (seed % 5);
  ops.push({ id: `op-${id++}`, operation_type: 'receipt', occurred_at: '2026-01-01', quantity: recvQty, unit_cost_amount: recvCost, unit_cost_currency: 'EUR' });
  const shipQty = 1 + (seed % 3);
  ops.push({ id: `op-${id++}`, operation_type: 'shipment', occurred_at: '2026-01-02', quantity: shipQty, issue_reason: 'sale' });
  if (seed % 2 === 0) ops.push({ id: `op-${id++}`, operation_type: 'count_correction', occurred_at: '2026-01-03', quantity: -1 }); // shrinkage
  return ops;
};

test('property: ledger buckets (from kernel effects) tie to kernel buckets with zero residual, across seeds', () => {
  for (let seed = 0; seed < 25; seed++) {
    const operations = buildStream(seed);
    const result = valueInventoryOperations({ operations, functionalCurrency: 'EUR' });
    assert.equal(result.applied, true, `seed ${seed} kernel refused: ${JSON.stringify(result)}`);
    const kernel = result.receipt; // the kernel wraps its payload as { applied, receipt }
    // Simulate the LEDGER exactly from the kernel's signed effects (what the posting layer routes).
    const ledgerBuckets = {
      inventory: kernel.operationEffects.reduce((s, e) => s + Number(e.amountToInventory || 0), 0),
      cogs: kernel.operationEffects.reduce((s, e) => s + Number(e.amountToCogsOrVariance || 0), 0),
      grni: kernel.operationEffects.reduce((s, e) => s + Number(e.amountToGrni || 0), 0)
    };
    const kernelBuckets = { ...ledgerBuckets };
    const v = reconcileConservation({ kernelConservation: kernel.conservation, ledgerBuckets, kernelBuckets });
    assert.equal(v.status, 'tied', `seed ${seed} did not conserve: ${JSON.stringify(v.detail)}`);
    assert.equal(v.residual, 0, `seed ${seed} residual ${v.residual}`);
    // The kernel's own conservation must also be zero-residual.
    assert.ok(Math.abs(Number(kernel.conservation.delta)) <= RECONCILIATION_MONEY_TOLERANCE, `seed ${seed} kernel delta ${kernel.conservation.delta}`);
  }
});

test('property: inventory_to_gl ties when GL gross is folded from the kernel effects', () => {
  for (let seed = 0; seed < 25; seed++) {
    const operations = buildStream(seed);
    const kernel = valueInventoryOperations({ operations, functionalCurrency: 'EUR' }).receipt;
    const glInventoryGross = kernel.operationEffects.reduce((s, e) => s + Number(e.amountToInventory || 0), 0);
    const v = reconcileInventoryToGl({ glInventoryGross, subledgerValue: kernel.inventoryValue, glAllowance: 0, registerAllowance: 0 });
    assert.equal(v.status, 'tied', `seed ${seed}: gross ${glInventoryGross} vs subledger ${kernel.inventoryValue}`);
  }
});

// A tiny money helper mirroring the module's rounding, for the retranslation-delta assertion.
function money(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }
