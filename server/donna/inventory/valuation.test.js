import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COST_POLICIES,
  INVENTORY_VARIANCE_KINDS,
  INVENTORY_VARIANCE_COMPONENTS,
  INVENTORY_EFFECT_BUCKETS,
  LANDED_COST_ALLOCATION_METHODS,
  VALUATION_REFUSAL_REASONS,
  VALUATION_CONTRACT_VERSION,
  VALUATION_KERNEL_VERSION,
  VALUATION_ORDERING_BASIS,
  allocateLandedCost,
  settleProvisionalCost,
  valueInventoryOperations
} from './valuation.js';

test('closed enums and refusal shape are pinned', () => {
  assert.deepEqual(COST_POLICIES, Object.freeze(['moving_average']));
  assert.deepEqual(LANDED_COST_ALLOCATION_METHODS, Object.freeze(['by_value', 'by_quantity']));
  assert.deepEqual(INVENTORY_VARIANCE_KINDS, Object.freeze(['provisional_to_actual']));
  assert.ok(VALUATION_REFUSAL_REASONS.includes('mixed_currency_no_rate'));
  const out = valueInventoryOperations({ policy: 'fifo', operations: [] });
  assert.deepEqual(out, { applied: false, reason: 'unsupported_cost_policy', detail: { policy: 'fifo' } });
});

test('moving average computes COGS, ending inventory and conservation', () => {
  const out = valueInventoryOperations({ operations: [
    { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 'r2', operation_type: 'receipt', quantity: 10, unit_cost_amount: 7, unit_cost_currency: 'USD', occurred_at: '2026-01-02T00:00:00Z' },
    { id: 's1', operation_type: 'shipment', quantity: 5, occurred_at: '2026-01-03T00:00:00Z' }
  ] });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.movingAverage, 6);
  assert.equal(out.receipt.cogs[0].cogsAmount, 30);
  assert.equal(out.receipt.qtyOnHand, 15);
  assert.equal(out.receipt.inventoryValue, 90);
  assert.equal(out.receipt.conservation.delta, 0);
});

test('reversal of a receipt restores the prior average exactly', () => {
  const out = valueInventoryOperations({ operations: [
    { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 'r2', operation_type: 'receipt', quantity: 10, unit_cost_amount: 7, unit_cost_currency: 'USD', occurred_at: '2026-01-02T00:00:00Z' },
    { id: 'rev-r2', operation_type: 'reversal', quantity: 10, reverses_operation_id: 'r2', occurred_at: '2026-01-03T00:00:00Z' }
  ] });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.qtyOnHand, 10);
  assert.equal(out.receipt.movingAverage, 5);
  assert.equal(out.receipt.inventoryValue, 50);
});

test('reversal after intervening issues refuses instead of emitting a negative running value', () => {
  // r1 receives 10@5; s1 ships 8 (2 on hand). Reversing r1 would drive qty to
  // -8 — not a valid moving-average state — so it refuses typed rather than
  // silently distorting the average fed to the posting layer.
  const out = valueInventoryOperations({ operations: [
    { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 's1', operation_type: 'shipment', quantity: 8, occurred_at: '2026-01-02T00:00:00Z' },
    { id: 'rev-r1', operation_type: 'reversal', quantity: 10, reverses_operation_id: 'r1', occurred_at: '2026-01-03T00:00:00Z' }
  ] });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'negative_running_value');
});

test('landed-cost allocation by value and quantity is exhaustive with deterministic remainder', () => {
  const lines = [
    { id: 'small', quantity: 3, unit_cost_amount: 10, unit_cost_currency: 'USD' },
    { id: 'large', quantity: 7, unit_cost_amount: 10, unit_cost_currency: 'USD' }
  ];
  const byValue = allocateLandedCost({ pool: { amount: 10.01, currency: 'USD' }, lines, method: 'by_value' });
  assert.equal(byValue.applied, true);
  assert.equal(byValue.receipt.exhaustive.delta, 0);
  assert.equal(byValue.receipt.allocations.reduce((s, l) => Math.round((s + l.allocatedAmount) * 100) / 100, 0), 10.01);
  assert.equal(byValue.receipt.allocations.find((l) => l.lineId === 'large').allocatedAmount, 7.01);
  const byQty = allocateLandedCost({ pool: { amount: 10.01, currency: 'USD' }, lines, method: 'by_quantity' });
  assert.equal(byQty.receipt.exhaustive.delta, 0);
  assert.equal(byQty.receipt.allocations.find((l) => l.lineId === 'large').allocatedAmount, 7.01);
});

test('provisional settlement returns variance and revised average from receipt', () => {
  const out = settleProvisionalCost({
    receipt: { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', provisional_cost: true },
    actualUnitCost: { amount: 6, currency: 'USD' },
    currentQtyOnHand: 10,
    currentAverage: 5
  });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.variance, 10);
  assert.equal(out.receipt.revisedAverage, 6);
  assert.equal(out.receipt.affectedFrom, 'r1');
});

test('same currency values and mixed currency without rate refuses typed', () => {
  assert.equal(valueInventoryOperations({ operations: [
    { id: 'r1', operation_type: 'receipt', quantity: 1, unit_cost_amount: 1, unit_cost_currency: 'GBP', occurred_at: 'a' },
    { id: 's1', operation_type: 'shipment', quantity: 1, occurred_at: 'b' }
  ] }).receipt.currency, 'GBP');
  const mixed = valueInventoryOperations({ operations: [
    { id: 'r1', operation_type: 'receipt', quantity: 1, unit_cost_amount: 1, unit_cost_currency: 'GBP', occurred_at: 'a' },
    { id: 'r2', operation_type: 'receipt', quantity: 1, unit_cost_amount: 1, unit_cost_currency: 'USD', occurred_at: 'b' }
  ] });
  assert.equal(mixed.applied, false);
  assert.equal(mixed.reason, 'mixed_currency_no_rate');
});

test('issue against empty history refuses; quarantine/release are value-neutral', () => {
  const empty = valueInventoryOperations({ operations: [{ id: 's1', operation_type: 'shipment', quantity: 1, occurred_at: 'a' }] });
  assert.equal(empty.applied, false);
  assert.equal(empty.reason, 'missing_cost_basis');
  const neutral = valueInventoryOperations({ operations: [
    { id: 'r1', operation_type: 'receipt', quantity: 5, unit_cost_amount: 2, unit_cost_currency: 'USD', occurred_at: 'a' },
    { id: 'q1', operation_type: 'quarantine', quantity: 2, occurred_at: 'b' },
    { id: 'rel1', operation_type: 'release_quarantine', quantity: 2, occurred_at: 'c' }
  ] });
  assert.equal(neutral.applied, true);
  assert.equal(neutral.receipt.inventoryValue, 10);
  assert.equal(neutral.receipt.quarantinedQty, 0);
});

test('fold is deterministic and order-stable by occurred_at then id', () => {
  const shuffled = [
    { id: 's1', operation_type: 'shipment', quantity: 2, occurred_at: '2026-01-03' },
    { id: 'r2', operation_type: 'receipt', quantity: 2, unit_cost_amount: 4, unit_cost_currency: 'USD', occurred_at: '2026-01-02' },
    { id: 'r1', operation_type: 'receipt', quantity: 2, unit_cost_amount: 2, unit_cost_currency: 'USD', occurred_at: '2026-01-01' }
  ];
  const sorted = [shuffled[2], shuffled[1], shuffled[0]];
  assert.deepEqual(valueInventoryOperations({ operations: shuffled }), valueInventoryOperations({ operations: sorted }));
});

// ─── P1A — the valuation-posting contract (D-POST-10) ────────────────────────

test('P1A closed enums and versions are pinned', () => {
  assert.deepEqual(INVENTORY_VARIANCE_COMPONENTS, Object.freeze([
    'purchase_price_variance', 'quantity_variance', 'fx_variance', 'landed_cost_variance', 'tax_variance'
  ]));
  assert.deepEqual(INVENTORY_EFFECT_BUCKETS, Object.freeze([
    'inventory', 'grni', 'cogs_or_variance', 'opening_balance_equity', 'owner_appropriation'
  ]));
  assert.ok(VALUATION_REFUSAL_REASONS.includes('missing_fx_rate'));
  assert.ok(VALUATION_REFUSAL_REASONS.includes('unbalanced_effect'));
  assert.equal(VALUATION_CONTRACT_VERSION, 'valuation-posting/1');
  assert.equal(VALUATION_KERNEL_VERSION, 'i4-valuation/3');
  assert.equal(VALUATION_ORDERING_BASIS, 'occurred_at,id');
});

test('P1A identity: run/stream/input ids present, order-stable, and shape-sensitive', () => {
  const ops = [
    { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 's1', operation_type: 'shipment', quantity: 4, occurred_at: '2026-01-02T00:00:00Z' }
  ];
  const a = valueInventoryOperations({ operations: ops });
  const b = valueInventoryOperations({ operations: [ops[1], ops[0]] }); // shuffled input
  assert.equal(a.receipt.contractVersion, 'valuation-posting/1');
  assert.equal(a.receipt.kernelVersion, 'i4-valuation/3');
  assert.match(a.receipt.inputHash, /^[a-f0-9]{64}$/);
  assert.match(a.receipt.valuationRunId, /^vrun_[a-f0-9]{24}$/);
  // Same event SET → identical identity regardless of caller array order (replay).
  assert.equal(a.receipt.inputHash, b.receipt.inputHash);
  assert.equal(a.receipt.streamVersion, b.receipt.streamVersion);
  assert.equal(a.receipt.valuationRunId, b.receipt.valuationRunId);
  // A different stream → a different identity.
  const c = valueInventoryOperations({ operations: [{ id: 'r1', operation_type: 'receipt', quantity: 11, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: '2026-01-01T00:00:00Z' }] });
  assert.notEqual(a.receipt.inputHash, c.receipt.inputHash);
});

test('P1A operation effects carry signed balanced legs and conserve to ending value', () => {
  const out = valueInventoryOperations({ operations: [
    { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 'r2', operation_type: 'receipt', quantity: 10, unit_cost_amount: 7, unit_cost_currency: 'USD', occurred_at: '2026-01-02T00:00:00Z' },
    { id: 's1', operation_type: 'shipment', quantity: 5, occurred_at: '2026-01-03T00:00:00Z' }
  ] });
  const [r1, , s1] = out.receipt.operationEffects;
  // Receipt: DR inventory / CR GRNI at cost.
  assert.equal(r1.amountToInventory, 50);
  assert.equal(r1.amountToGrni, 50);
  assert.equal(r1.amountToCogsOrVariance, 0);
  assert.equal(r1.debitTotal, r1.creditTotal);
  assert.deepEqual(r1.legs, [
    { bucket: 'inventory', direction: 'debit', amount: 50 },
    { bucket: 'grni', direction: 'credit', amount: 50 }
  ]);
  // Shipment: DR COGS / CR inventory at moving average (6 × 5 = 30).
  assert.equal(s1.amountToCogsOrVariance, 30);
  assert.equal(s1.amountToInventory, -30);
  assert.equal(s1.debitTotal, s1.creditTotal);
  // Every effect balances; effect-conservation is zero-residual.
  for (const e of out.receipt.operationEffects) assert.ok(Math.abs(e.debitTotal - e.creditTotal) < 0.01);
  assert.equal(out.receipt.effectConservation.delta, 0);
  assert.equal(out.receipt.effectConservation.inventoryFromEffects, out.receipt.inventoryValue);
});

test('P1A opening balance and owner private use carry the right counterparty', () => {
  const out = valueInventoryOperations({ operations: [
    { id: 'ob', operation_type: 'opening_balance', quantity: 4, unit_cost_amount: 10, unit_cost_currency: 'USD', occurred_at: '2026-01-01' },
    { id: 'pu', operation_type: 'owner_private_use', quantity: 1, occurred_at: '2026-01-02' }
  ] });
  const [ob, pu] = out.receipt.operationEffects;
  assert.equal(ob.amountToInventory, 40);
  assert.deepEqual(ob.counterparty, { bucket: 'opening_balance_equity', direction: 'credit', amount: 40 });
  assert.equal(pu.amountToInventory, -10);
  assert.deepEqual(pu.counterparty, { bucket: 'owner_appropriation', direction: 'debit', amount: 10 });
  assert.equal(pu.debitTotal, pu.creditTotal);
});

test('P1A value-neutral ops emit a no_journal_required effect; reversal negates the target', () => {
  const out = valueInventoryOperations({ operations: [
    { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: '2026-01-01' },
    { id: 'q1', operation_type: 'quarantine', quantity: 2, occurred_at: '2026-01-02' },
    { id: 'rev', operation_type: 'reversal', quantity: 10, reverses_operation_id: 'r1', occurred_at: '2026-01-03' }
  ] });
  const byId = Object.fromEntries(out.receipt.operationEffects.map((e) => [e.operationId, e]));
  assert.equal(byId.q1.posting, 'no_journal_required');
  assert.deepEqual(byId.q1.legs, []);
  // Reversal of the receipt negates its legs exactly.
  assert.equal(byId.rev.effectType, 'reversal');
  assert.equal(byId.rev.amountToInventory, -50);
  assert.equal(byId.rev.amountToGrni, -50);
  assert.deepEqual(byId.rev.legs, [
    { bucket: 'inventory', direction: 'credit', amount: 50 },
    { bucket: 'grni', direction: 'debit', amount: 50 }
  ]);
});

test('P1A functional-currency translation uses supplied FX facts; missing rate refuses', () => {
  const out = valueInventoryOperations({
    functionalCurrency: 'EUR',
    fxRates: [{ from: 'USD', to: 'EUR', rate: 0.9, fx_fact_id: 'fx_1' }],
    operations: [
      { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: '2026-01-01' },
      { id: 's1', operation_type: 'shipment', quantity: 4, occurred_at: '2026-01-02' }
    ]
  });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.functionalCurrency, 'EUR');
  assert.equal(out.receipt.movingAverage, 4.5);           // 5 USD × 0.9 = 4.5 EUR
  assert.equal(out.receipt.operationEffects[0].fx.rate, 0.9);
  assert.equal(out.receipt.operationEffects[0].fx.fxFactId, 'fx_1');
  assert.equal(out.receipt.operationEffects[0].fx.functionalUnitCost, 4.5);
  assert.equal(out.receipt.operationEffects[0].amountToInventory, 45);
  // No rate supplied for the translation → typed refusal (not a guessed rate).
  const missing = valueInventoryOperations({
    functionalCurrency: 'EUR',
    operations: [{ id: 'r1', operation_type: 'receipt', quantity: 1, unit_cost_amount: 5, unit_cost_currency: 'USD', occurred_at: 'a' }]
  });
  assert.equal(missing.applied, false);
  assert.equal(missing.reason, 'missing_fx_rate');
});

test('P1A provisional settlement decomposes variance into mutually exclusive components', () => {
  // Same currency: whole variance is purchase price, others zero, residual zero.
  const same = settleProvisionalCost({
    receipt: { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', provisional_cost: true },
    actualUnitCost: { amount: 6, currency: 'USD' }, currentQtyOnHand: 10, currentAverage: 5
  });
  assert.equal(same.receipt.variance, 10);
  assert.equal(same.receipt.components.purchase_price_variance, 10);
  assert.equal(same.receipt.components.fx_variance, 0);
  assert.equal(same.receipt.componentsResidual, 0);
  // With FX: price component at the OLD rate + fx component on the NEW price sum to total.
  const fx = settleProvisionalCost({
    receipt: { id: 'r1', operation_type: 'receipt', quantity: 10, unit_cost_amount: 5, unit_cost_currency: 'USD', provisional_cost: true },
    actualUnitCost: { amount: 6, currency: 'USD' }, currentQtyOnHand: 10, currentAverage: 4.5,
    functionalCurrency: 'EUR', provisionalFxRate: 0.9, actualFxRate: 1.0
  });
  assert.equal(fx.receipt.variance, 15);                          // (6×1.0 − 5×0.9) × 10
  assert.equal(fx.receipt.components.purchase_price_variance, 9); // (6−5) × 0.9 × 10
  assert.equal(fx.receipt.components.fx_variance, 6);             // 6 × (1.0−0.9) × 10
  assert.equal(fx.receipt.componentsResidual, 0);
});

test('P1A landed-cost allocations label the landed_cost_variance component', () => {
  const out = allocateLandedCost({
    pool: { amount: 10, currency: 'USD' },
    lines: [
      { id: 'a', quantity: 5, unit_cost_amount: 10, unit_cost_currency: 'USD' },
      { id: 'b', quantity: 5, unit_cost_amount: 10, unit_cost_currency: 'USD' }
    ],
    method: 'by_quantity'
  });
  assert.equal(out.applied, true);
  assert.ok(out.receipt.allocations.every((l) => l.varianceComponent === 'landed_cost_variance'));
});

test('PostgreSQL Date rows and numeric bigint identities follow database event ordering', () => {
  const timestamp = new Date('2026-10-01T00:00:00Z');
  const operations = [
    { id:'10',operation_type:'shipment',quantity:'2.00000000',occurred_at:timestamp },
    { id:'9',operation_type:'opening_balance',quantity:'3.00000000',unit_cost_amount:'5.00000000',unit_cost_currency:'GBP',occurred_at:timestamp }
  ];
  const result=valueInventoryOperations({operations});
  assert.equal(result.applied,true,JSON.stringify(result));
  assert.equal(result.receipt.qtyOnHand,1);
  assert.equal(result.receipt.inventoryValue,5);
  assert.equal(result.receipt.operationEffects[0].dates.economic_date,'2026-10-01T00:00:00.000Z');
});

test('valuation rejects a second reversal of the same effect',()=>{
  const out=valueInventoryOperations({operations:[
    {id:'1',operation_type:'receipt',quantity:2,unit_cost_amount:5,unit_cost_currency:'GBP',occurred_at:'2026-10-01'},
    {id:'2',operation_type:'reversal',quantity:2,reverses_operation_id:'1',occurred_at:'2026-10-02'},
    {id:'3',operation_type:'reversal',quantity:2,reverses_operation_id:'1',occurred_at:'2026-10-03'}
  ]});
  assert.equal(out.applied,false);assert.equal(out.reason,'invalid_reversal');
});
