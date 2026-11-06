import assert from 'node:assert/strict';
import test from 'node:test';

import { INVENTORY_REFUSAL_REASONS } from './constants.js';
import {
  acknowledgeSupplier,
  allocateSalesOrderLine,
  expireStaleReservations,
  flagOverduePurchaseOrders,
  receivePurchaseOrderLine,
  reserveSalesOrderLine,
  shipSalesOrderLine
} from './db.js';

const base = { firmId: 'firm-1', clientId: 'client-1', actorId: 'owner-1' };
const mkLevel = (o = {}) => ({ on_hand: 10, reserved: 0, allocated: 0, quarantined: 0, available: 10, inbound: 0, backordered: 0, ...o });

const fakeCommitClient = ({ level = mkLevel(), soLine = null, poLine = null, existingReceipt = null, backorders = [], reservations = [], allocations = [], pos = [], failOn = null } = {}) => {
  const queries = [];
  return { queries, async query(sql, params = []) {
    queries.push({ sql, params });
    if (failOn && sql.includes(failOn)) throw new Error('simulated failure');
    if (sql.includes('from client_capability_config')) return { rows: [{ flag_key: 'INVENTORY_CORE', stage: 'auto', client_id: 'client-1' }] };
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('from inventory_command_receipts') && sql.trimStart().startsWith('select')) return { rows: existingReceipt ? [{ receipt: existingReceipt }] : [] };
    if (sql.includes('from inventory_items where')) return { rows: [{ base_uom_id: 'each' }] };
    if (sql.includes('sum(quantity)') && sql.includes('inventory_reservations')) return { rows: [{ quantity: reservations.reduce((s, r) => s + Number(r.quantity), 0) }] };
    if (sql.includes('sum(quantity)') && sql.includes('inventory_allocations')) return { rows: [{ quantity: allocations.reduce((s, r) => s + Number(r.quantity), 0) }] };
    if (sql.includes('sum(quantity)') && sql.includes('inventory_backorders')) return { rows: [{ quantity: backorders.reduce((s, r) => s + Number(r.quantity), 0) }] };
    if (sql.includes('from inventory_sales_order_lines')) return { rows: soLine ? [soLine] : [] };
    if (sql.includes('from inventory_purchase_order_lines pol')) return { rows: poLine ? [poLine] : [] };
    if (sql.includes('from inventory_purchase_orders where')) return { rows: pos };
    if (sql.includes('from inventory_item_levels') && sql.includes('for update')) return { rows: [level] };
    if (sql.includes('from inventory_backorders')) return { rows: backorders };
    if (sql.includes('from inventory_reservations')) return { rows: reservations };
    if (sql.includes('from inventory_allocations')) return { rows: allocations };
    if (sql.includes('sum(greatest')) return { rows: [{ inbound: 7 }] };
    if (sql.includes('bool_and')) return { rows: [{ done: false, any_received: true }] };
    if (sql.includes('from inventory_locations')) return { rows: [{ id: 'loc-default' }] };
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
    if (sql.includes('insert into inventory_reservations')) return { rows: [{ id: 11 }] };
    if (sql.includes('insert into inventory_backorders')) return { rows: [{ id: 12 }] };
    if (sql.includes('insert into inventory_allocations')) return { rows: [{ id: 13 }] };
    if (sql.includes('insert into inventory_operations')) return { rows: [{ id: 14 }] };
    if (sql.includes('insert into audit_events')) return { rows: [{ id: 15 }] };
    return { rows: [] };
  } };
};

// Rebuild a child-row column from the mutations the writer actually issued —
// the hard-rule-6 reconciliation the fake-pg pattern allows: the stored
// projection column must equal sum(active child-row quantities) after the op.
const decimalish = (n) => Math.round(n * 1e6) / 1e6;
const activeQtyAfter = (client, table, startQty) => {
  let qty = startQty;
  for (const q of client.queries) {
    if (q.sql.includes(`update ${table} set state = $1`) && ['fulfilled', 'shipped'].includes(q.params[0])) qty = 0;
    else if (q.sql.includes(`update ${table} set quantity = quantity - $1`)) qty = decimalish(qty - q.params[0]);
  }
  return qty;
};

const idx = (c, pred) => c.queries.findIndex((q) => pred(q.sql));

test('pin-tests commitment refusal enum additions', () => {
  for (const reason of ['over_reservation', 'over_allocation', 'ship_exceeds_allocation', 'commitment_not_found']) {
    assert.ok(INVENTORY_REFUSAL_REASONS.includes(reason));
  }
});

test('reserve creates active reservation plus backorder and updates projection inside the transaction', async () => {
  const client = fakeCommitClient({ level: mkLevel({ on_hand: 5, available: 5 }), soLine: { id: 501, sales_order_id: 301, item_id: 'item-1', quantity_ordered: 8, quantity_reserved: 0, quantity_allocated: 0, quantity_shipped: 0, uom_id: 'each' } });
  const out = await reserveSalesOrderLine({ client, ...base, idempotencyKey: 'reserve-1', salesOrderLineId: 501, locationId: 'loc-1', quantity: 8 });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.consequence.reservation.quantity, 5);
  assert.equal(out.receipt.consequence.backorder.quantity, 3);
  assert.equal(out.receipt.consequence.projection.after.reserved, 5);
  assert.equal(out.receipt.consequence.projection.after.backordered, 3);
  assert.ok(client.queries.some((q) => q.sql.includes('insert into inventory_reservations')));
  assert.ok(client.queries.some((q) => q.sql.includes('insert into inventory_backorders')));
  assert.ok(idx(client, (s) => s === 'begin') < idx(client, (s) => s.includes('from inventory_item_levels') && s.includes('for update')));
});

test('reserve refuses over-reservation with typed shape', async () => {
  const out = await reserveSalesOrderLine({ client: fakeCommitClient({ soLine: { id: 1, sales_order_id: 2, item_id: 'item-1', quantity_ordered: 2, quantity_reserved: 1 } }), ...base, idempotencyKey: 'reserve-over', salesOrderLineId: 1, quantity: 2 });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'over_reservation');
});

test('allocate moves reserved to allocated without changing available and is idempotent on replay', async () => {
  const line = { id: 501, sales_order_id: 301, item_id: 'item-1', quantity_ordered: 5, quantity_reserved: 5, quantity_allocated: 0, quantity_shipped: 0, uom_id: 'each' };
  const client = fakeCommitClient({ level: mkLevel({ on_hand: 10, reserved: 5, allocated: 0 }), soLine: line, reservations: [{ id: 11, quantity: 5 }] });
  const out = await allocateSalesOrderLine({ client, ...base, idempotencyKey: 'alloc-1', salesOrderLineId: 501, locationId: 'loc-1', quantity: 4 });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.consequence.projection.before.available, out.receipt.consequence.projection.after.available);
  assert.equal(out.receipt.consequence.projection.after.reserved, 1);
  assert.equal(out.receipt.consequence.projection.after.allocated, 4);
  // F-A: a PARTIAL allocation must DECREMENT the active reservation (5→1), not
  // blanket-fulfill it — else stored reserved (1) would diverge from the active
  // reservation quantity. Assert the reconciliation invariant holds.
  assert.ok(client.queries.some((q) => q.sql.includes('update inventory_reservations set quantity = quantity - $1') && q.params[0] === 4));
  assert.equal(client.queries.some((q) => q.sql.includes("update inventory_reservations set state = $1") && q.params[0] === 'fulfilled'), false);
  assert.equal(activeQtyAfter(client, 'inventory_reservations', 5), out.receipt.consequence.projection.after.reserved);
  const replay = await allocateSalesOrderLine({ client: fakeCommitClient({ existingReceipt: out.receipt, soLine: line }), ...base, idempotencyKey: 'alloc-1', salesOrderLineId: 501, quantity: 4 });
  assert.equal(replay.receipt.replayed, true);
});

test('full allocation fulfills the reservation and stored reserved reconciles to zero', async () => {
  const line = { id: 501, sales_order_id: 301, item_id: 'item-1', quantity_ordered: 5, quantity_reserved: 5, quantity_allocated: 0, quantity_shipped: 0, uom_id: 'each' };
  const client = fakeCommitClient({ level: mkLevel({ on_hand: 10, reserved: 5, allocated: 0 }), soLine: line, reservations: [{ id: 11, quantity: 5 }] });
  const out = await allocateSalesOrderLine({ client, ...base, idempotencyKey: 'alloc-full', salesOrderLineId: 501, locationId: 'loc-1', quantity: 5 });
  assert.equal(out.receipt.consequence.projection.after.reserved, 0);
  assert.ok(client.queries.some((q) => q.sql.includes('update inventory_reservations set state = $1') && q.params[0] === 'fulfilled'));
  assert.equal(activeQtyAfter(client, 'inventory_reservations', 5), 0);
});

test('ship requires allocated quantity, appends shipment and releases allocated with available unchanged', async () => {
  const line = { id: 501, sales_order_id: 301, item_id: 'item-1', quantity_ordered: 5, quantity_reserved: 5, quantity_allocated: 5, quantity_shipped: 0, uom_id: 'each' };
  const client = fakeCommitClient({ level: mkLevel({ on_hand: 10, reserved: 0, allocated: 5, available: 5 }), soLine: line, allocations: [{ id: 13, quantity: 5 }] });
  const out = await shipSalesOrderLine({ client, ...base, idempotencyKey: 'ship-1', salesOrderLineId: 501, locationId: 'loc-1', quantity: 2, occurredAt: '2026-07-11T00:00:00Z' });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.consequence.projection.before.available, out.receipt.consequence.projection.after.available);
  assert.equal(out.receipt.consequence.projection.after.on_hand, 8);
  assert.equal(out.receipt.consequence.projection.after.allocated, 3);
  assert.ok(client.queries.some((q) => q.sql.includes('insert into inventory_operations')));
  // F-A: partial ship decrements the active allocation (5→3), does not blanket-ship it.
  assert.ok(client.queries.some((q) => q.sql.includes('update inventory_allocations set quantity = quantity - $1') && q.params[0] === 2));
  assert.equal(activeQtyAfter(client, 'inventory_allocations', 5), out.receipt.consequence.projection.after.allocated);
});

test('receive updates PO line, mints receipt anomalies, fills backorders and refreshes inbound', async () => {
  const poLine = { id: 601, purchase_order_id: 701, item_id: 'item-1', quantity_ordered: 5, quantity_received: 4, purchase_order_state: 'acknowledged', uom_id: 'each' };
  const client = fakeCommitClient({ level: mkLevel({ on_hand: 0, reserved: 0, backordered: 3, inbound: 5 }), poLine, backorders: [{ id: 12, item_id: 'item-1', sales_order_line_id: 501, quantity: 3, state: 'open' }] });
  const out = await receivePurchaseOrderLine({ client, ...base, idempotencyKey: 'recv-1', purchaseOrderLineId: 601, quantity: 3, occurredAt: '2026-07-11T00:00:00Z', closeShort: false });
  assert.equal(out.applied, true);
  assert.deepEqual(out.receipt.consequence.anomalies, ['over_receipt']);
  assert.equal(out.receipt.consequence.backorderFills[0].quantity, 3);
  assert.ok(client.queries.some((q) => q.sql.includes('update inventory_backorders')));
  assert.ok(client.queries.some((q) => q.sql.includes('sum(greatest')));
  // F-B: the fill DECREMENTS the backorder quantity (not just a state flip), so a
  // later receipt can't re-fill the same units.
  assert.ok(client.queries.some((q) => q.sql.includes('update inventory_backorders set quantity = quantity - $1') && q.params[0] === 3));
  // F-C: the filled stock is re-reserved to the waiting sales-order line, and the
  // projection moves backordered→reserved rather than releasing to free available.
  assert.equal(out.receipt.consequence.reReserved, 3);
  assert.equal(out.receipt.consequence.projection.after.reserved, 3);
  assert.equal(out.receipt.consequence.projection.after.backordered, 0);
  assert.ok(client.queries.some((q) => q.sql.includes('insert into inventory_reservations')));
  assert.ok(client.queries.some((q) => q.sql.includes('update inventory_sales_order_lines set quantity_reserved = quantity_reserved + $1') && q.params[0] === 3 && q.params[1] === 501));
});

test('backorder partial fill decrements quantity so a later receipt cannot re-fill the same units', async () => {
  const poLine = { id: 601, purchase_order_id: 701, item_id: 'item-1', quantity_ordered: 10, quantity_received: 0, purchase_order_state: 'ordered', uom_id: 'each' };
  // First receipt of 2 against an open backorder of 5 fills only 2.
  const c1 = fakeCommitClient({ level: mkLevel({ on_hand: 0, backordered: 5 }), poLine, backorders: [{ id: 12, item_id: 'item-1', sales_order_line_id: 501, quantity: 5, state: 'open' }] });
  const r1 = await receivePurchaseOrderLine({ client: c1, ...base, idempotencyKey: 'recv-a', purchaseOrderLineId: 601, quantity: 2, occurredAt: '2026-07-11T00:00:00Z' });
  assert.equal(r1.receipt.consequence.backorderFills[0].quantity, 2);
  assert.ok(c1.queries.some((q) => q.sql.includes('update inventory_backorders set quantity = quantity - $1') && q.params[0] === 2));
  assert.equal(r1.receipt.consequence.projection.after.backordered, 3);
  // Second receipt sees the backorder at its REMAINING quantity (3), fills 3 — no double count.
  const c2 = fakeCommitClient({ level: mkLevel({ on_hand: 2, backordered: 3 }), poLine: { ...poLine, quantity_received: 2 }, backorders: [{ id: 12, item_id: 'item-1', sales_order_line_id: 501, quantity: 3, state: 'partially_filled' }] });
  const r2 = await receivePurchaseOrderLine({ client: c2, ...base, idempotencyKey: 'recv-b', purchaseOrderLineId: 601, quantity: 3, occurredAt: '2026-07-11T00:00:00Z' });
  assert.equal(r2.receipt.consequence.backorderFills[0].quantity, 3);
  assert.equal(r2.receipt.consequence.projection.after.backordered, 0);
});

test('expiry and overdue sweeps surface exceptions and keep writes atomic', async () => {
  const expClient = fakeCommitClient({ level: mkLevel({ reserved: 2 }), reservations: [{ id: 11, item_id: 'item-1', location_id: 'loc-1', quantity: 2 }] });
  const expired = await expireStaleReservations({ client: expClient, ...base, idempotencyKey: 'exp-1', now: '2026-07-11T00:00:00Z' });
  assert.equal(expired.applied, true);
  assert.ok(expClient.queries.some((q) => q.sql.includes("state = 'expired'")));
  assert.ok(expClient.queries.some((q) => q.params?.includes('expired_reservation')));

  const poClient = fakeCommitClient({ pos: [{ id: 701, state: 'ordered', payload: { expected_date: '2026-07-01T00:00:00Z' } }] });
  const overdue = await flagOverduePurchaseOrders({ client: poClient, ...base, idempotencyKey: 'late-1', now: '2026-07-11T00:00:00Z' });
  assert.equal(overdue.applied, true);
  assert.ok(poClient.queries.some((q) => q.params?.includes('overdue_purchase_order')));
});

test('PO acknowledgement writes supplier acknowledgement and audits illegal states typed', async () => {
  const ok = await acknowledgeSupplier({ client: fakeCommitClient({ pos: [{ id: 701, state: 'ordered' }] }), ...base, idempotencyKey: 'ack-1', purchaseOrderId: 701, acknowledgedAt: '2026-07-11T00:00:00Z' });
  assert.equal(ok.applied, true);
  const bad = await acknowledgeSupplier({ client: fakeCommitClient({ pos: [{ id: 701, state: 'proposal' }] }), ...base, idempotencyKey: 'ack-bad', purchaseOrderId: 701 });
  assert.equal(bad.applied, false);
  assert.equal(bad.reason, 'invalid_state_transition');
});
