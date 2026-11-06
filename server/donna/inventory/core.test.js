import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALIAS_SOURCES,
  ALIAS_STATUSES,
  AVAILABILITY_STATES,
  COUNT_SESSION_STATES,
  INVENTORY_ANOMALY_TYPES,
  INVENTORY_OPERATION_TYPES,
  INVENTORY_REFUSAL_REASONS,
  PURCHASE_ORDER_STATES,
  SALES_ORDER_STATES
} from './constants.js';
import {
  availabilityFor,
  buildOperationCommand,
  closeCountSession,
  convertQuantity,
  findSku,
  foldOperations,
  groupRollup,
  inventorySnapshot,
  openCountSession,
  projectionEquals,
  skuCard,
  validateAliasCommand
} from './core.js';

const enums = {
  INVENTORY_OPERATION_TYPES,
  INVENTORY_REFUSAL_REASONS,
  INVENTORY_ANOMALY_TYPES,
  PURCHASE_ORDER_STATES,
  SALES_ORDER_STATES,
  COUNT_SESSION_STATES,
  ALIAS_STATUSES,
  ALIAS_SOURCES,
  AVAILABILITY_STATES
};

test('closed enums are frozen and pinned', () => {
  for (const [name, values] of Object.entries(enums)) {
    assert.equal(Object.isFrozen(values), true, name);
    assert.equal(new Set(values).size, values.length, name);
  }
  assert.deepEqual(INVENTORY_OPERATION_TYPES, ['opening_balance', 'receipt', 'shipment', 'count_correction', 'quarantine', 'release_quarantine', 'owner_private_use', 'reversal']);
  assert.ok(INVENTORY_REFUSAL_REASONS.includes('negative_stock_unauthorised'));
});

test('command envelope applies deterministic receipt and refuses unauthorised negative', () => {
  const ok = buildOperationCommand({ clientId: 'c1', itemId: 'sku1', operationType: 'receipt', quantity: 5, uomId: 'each', occurredAt: '2026-07-11T00:00:00Z', actorId: 'owner-1', idempotencyKey: 'k1', currentProjection: { on_hand: 1, reserved: 1, allocated: 0, quarantined: 0, available: 0 }, unitCostAmount: '12.50', unitCostCurrency: 'USD' });
  assert.equal(ok.applied, true);
  assert.equal(ok.receipt.consequence.after.on_hand, 6);
  assert.equal(ok.receipt.consequence.after.available, 5);
  assert.equal(ok.receipt.operation.unitCost.currency, 'USD');
  const refused = buildOperationCommand({ clientId: 'c1', itemId: 'sku1', operationType: 'shipment', quantity: 10, uomId: 'each', occurredAt: '2026-07-11T00:00:00Z', actorId: 'owner-1', idempotencyKey: 'k2', currentProjection: { on_hand: 1, reserved: 0, allocated: 0, quarantined: 0, available: 1 } });
  assert.deepEqual(Object.keys(refused).sort(), ['applied', 'detail', 'reason']);
  assert.equal(refused.reason, 'negative_stock_unauthorised');
});

test('credible observed count records reality and mints anomalies', () => {
  const out = buildOperationCommand({ clientId: 'c1', itemId: 'sku1', operationType: 'count_correction', quantity: -3, uomId: 'each', occurredAt: '2026-07-11T00:00:00Z', actorId: 'worker-1', idempotencyKey: 'count-1', currentProjection: { on_hand: 1, reserved: 0, allocated: 0, quarantined: 0, available: 1 } });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.consequence.after.on_hand, -2);
  assert.deepEqual(out.receipt.consequence.anomalies.map((a) => a.type), ['negative_observed_count', 'count_variance']);
});

test('replay fold equals stored projections after reversals and out-of-order backfills', () => {
  const operations = [
    { id: 'op3', client_id: 'c1', item_id: 'sku1', location_id: 'loc1', operation_type: 'shipment', quantity: 2, occurred_at: '2026-07-12T00:00:00Z' },
    { id: 'op1', client_id: 'c1', item_id: 'sku1', location_id: 'loc1', operation_type: 'opening_balance', quantity: 10, occurred_at: '2026-07-10T00:00:00Z' },
    { id: 'op2', client_id: 'c1', item_id: 'sku1', location_id: 'loc1', operation_type: 'receipt', quantity: 5, occurred_at: '2026-07-11T00:00:00Z' },
    { id: 'op4', client_id: 'c1', item_id: 'sku1', location_id: 'loc1', operation_type: 'reversal', quantity: 0, effect: { on_hand: 2 }, occurred_at: '2026-07-13T00:00:00Z' }
  ];
  const projection = foldOperations(operations);
  assert.equal(projection[0].on_hand, 15);
  assert.equal(projection[0].available, 15);
  assert.equal(projectionEquals(projection, foldOperations(operations)), true);
});

test('UOM conversions use exact declared package model and refuse undefined conversions', () => {
  assert.equal(convertQuantity({ quantity: 2, fromUom: 'case', toUom: 'each', conversions: [{ from_uom_id: 'case', to_uom_id: 'each', factor: 12 }] }), 24);
  assert.throws(() => convertQuantity({ quantity: 2, fromUom: 'pallet', toUom: 'each', conversions: [] }), /undefined conversion/);
});

test('availability separates on-hand from available-to-promise', () => {
  const out = availabilityFor({ projection: { on_hand: 10, reserved: 3, allocated: 2, quarantined: 1 }, inbound: 7, backordered: 4 });
  assert.equal(out.state.on_hand, 10);
  assert.equal(out.state.available, 4);
  assert.equal(out.state.inbound, 7);
});

test('structured count sessions are opened and closed in bulk with correction operations', () => {
  const opened = openCountSession({ scope: { skus: ['a', 'b'] }, actorId: 'worker-1', idempotencyKey: 'open-1' });
  assert.equal(opened.applied, true);
  const closed = closeCountSession({ session: { id: 's1', state: 'open' }, actorId: 'worker-1', idempotencyKey: 'close-1', projections: [{ item_id: 'a', location_id: 'default', on_hand: 5 }], lines: [{ item_id: 'a', location_id: 'default', counted_quantity: 3, uom_id: 'each' }, { item_id: 'b', location_id: 'default', counted_quantity: -1, uom_id: 'each' }] });
  assert.equal(closed.applied, true);
  assert.equal(closed.receipt.consequence.operations.length, 2);
  assert.ok(closed.receipt.consequence.anomalies.some((a) => a.type === 'negative_observed_count'));
});

test('alias controls cap and exact-match precedence; findSku ranks exact sku/barcode before alias/name', () => {
  assert.equal(validateAliasCommand({ itemId: 'i1', alias: 'widget', source: 'manual', exactSkuOrBarcodeMatch: true }).reason, 'exact_match_precedes_alias');
  assert.equal(validateAliasCommand({ itemId: 'i1', alias: 'widget', source: 'manual', existingAliases: Array.from({ length: 25 }, () => ({ itemId: 'i1', status: 'active' })) }).reason, 'alias_limit_exceeded');
  const items = [{ id: 'i1', sku: 'ABC', name: 'Blue Widget', barcodes: ['123'] }, { id: 'i2', sku: 'DEF', name: 'Red Thing', barcodes: [] }];
  assert.equal(findSku({ query: 'ABC', items, aliases: [{ itemId: 'i2', alias: 'ABC' }] })[0].match, 'exact_sku');
  assert.equal(findSku({ query: '123', items })[0].match, 'exact_barcode');
  assert.equal(findSku({ query: 'widget', items, aliases: [{ itemId: 'i2', alias: 'widget' }] })[0].item.id, 'i2');
});

test('bounded reads refuse unbounded scans and preserve exception-first shape for 10k SKU snapshot', () => {
  assert.equal(inventorySnapshot({ projections: [], limit: 1000 }).reason, 'unbounded_read_refused');
  const projections = Array.from({ length: 10000 }, (_, i) => ({ item_id: `sku-${i}`, on_hand: i }));
  const out = inventorySnapshot({ projections, exceptions: [{ type: 'negative' }], limit: 100, offset: 0 });
  assert.equal(out.exceptions.length, 1);
  assert.equal(out.rollups.length, 100);
  assert.equal(groupRollup({ projections: [{ group_path: 'a/b', item_id: '1' }, { group_path: 'a/c', item_id: '2' }], prefix: 'a/', limit: 10 }).rows.length, 2);
  assert.equal(skuCard({ item: { id: 'i1' }, operations: Array.from({ length: 1000 }, (_, i) => ({ id: i })), limit: 50 }).operations.length, 50);
});
