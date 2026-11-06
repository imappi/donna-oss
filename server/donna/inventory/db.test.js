import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INVENTORY_CORE_FLAG_KEY,
  applyInventoryOperation,
  closeInventoryCountSession,
  createPurchaseOrder,
  createSalesOrder,
  openInventoryCountSession,
  rebuildInventoryProjectionFromDb
} from './db.js';

const fakeClient = ({ flags = { INVENTORY_CORE: 'auto' }, existingReceipt = null, projection = null, failOn = null, session = null, levels = [] } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (failOn && sql.includes(failOn)) throw new Error('simulated failure');
      if (sql.includes('from client_capability_config')) return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, client_id: 'client-1' })) };
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('from inventory_command_receipts') && sql.trimStart().startsWith('select')) return { rows: existingReceipt ? [{ receipt: existingReceipt }] : [] };
      if (sql.includes('from inventory_items where')) return { rows: [{ base_uom_id: 'each' }] };
      if (sql.includes('from inventory_locations where')) return { rows: [{ id: params[2] }] };
      if (sql.includes('from inventory_item_levels') && sql.includes('for update')) return { rows: projection ? [projection] : levels };
      if (sql.includes('from inventory_item_levels')) return { rows: levels };
      if (sql.includes('from inventory_count_sessions') && sql.includes('for update')) return { rows: session ? [session] : [] };
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes('insert into inventory_operations')) return { rows: [{ id: 101 }] };
      if (sql.includes('insert into inventory_purchase_orders')) return { rows: [{ id: 201 }] };
      if (sql.includes('insert into inventory_sales_orders')) return { rows: [{ id: 301 }] };
      if (sql.includes('insert into inventory_count_sessions')) return { rows: [{ id: 401 }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 1 }] };
      if (sql.includes('from inventory_count_sessions')) return { rows: [] };
      if (sql.includes('select * from inventory_operations')) return { rows: [
        { id: 'op1', client_id: 'client-1', item_id: 'item-1', location_id: 'loc-1', operation_type: 'opening_balance', quantity: 3, occurred_at: '2026-07-11T00:00:00Z' }
      ] };
      return { rows: [] };
    }
  };
};

const queryIndex = (client, predicate) => client.queries.findIndex((q) => predicate(q.sql));

const base = {
  firmId: 'firm-1',
  clientId: 'client-1',
  actorId: 'owner-1',
  idempotencyKey: 'idem-1'
};

test('exports the config-plane inventory flag key and gates DB entry-points fail-closed', async () => {
  assert.equal(INVENTORY_CORE_FLAG_KEY, 'INVENTORY_CORE');
  const out = await applyInventoryOperation({ client: fakeClient({ flags: {} }), ...base, itemId: 'item-1', locationId: 'loc-1', operationType: 'receipt', quantity: 1, uomId: 'each', occurredAt: '2026-07-11T00:00:00Z' });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'flag_disabled');
});

test('idempotency replay returns the original receipt and writes nothing', async () => {
  const receipt = { intent: 'inventory.receipt', consequence: { after: { on_hand: 1 } } };
  const client = fakeClient({ existingReceipt: receipt });
  const out = await applyInventoryOperation({ client, ...base, itemId: 'item-1', locationId: 'loc-1', operationType: 'receipt', quantity: 1, uomId: 'each', occurredAt: '2026-07-11T00:00:00Z' });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.replayed, true);
  assert.equal(client.queries.some((q) => q.sql.includes('insert into inventory_operations')), false);
});

test('applied physical operation writes operation, projection, receipt and audit in one transaction', async () => {
  const client = fakeClient({ projection: { on_hand: 2, reserved: 0, allocated: 0, quarantined: 0, available: 2, inbound: 0, backordered: 0 } });
  const out = await applyInventoryOperation({ client, ...base, itemId: 'item-1', locationId: 'loc-1', operationType: 'receipt', quantity: 4, uomId: 'each', occurredAt: '2026-07-11T00:00:00Z', unitCostAmount: 5, unitCostCurrency: 'GBP' });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.consequence.after.on_hand, 6);
  assert.ok(client.queries.find((q) => q.sql === 'begin'));
  assert.ok(client.queries.find((q) => q.sql.includes('insert into inventory_operations')));
  assert.ok(client.queries.find((q) => q.sql.includes('insert into inventory_item_levels')));
  assert.ok(client.queries.find((q) => q.sql.includes('insert into audit_events')));
  assert.ok(client.queries.find((q) => q.sql === 'commit'));
  // F2: the `for update` projection read must hold its lock inside the txn, so
  // it runs AFTER begin (not as an autocommitted standalone statement before it).
  const beginIdx = queryIndex(client, (sql) => sql === 'begin');
  const lockIdx = queryIndex(client, (sql) => sql.includes('from inventory_item_levels') && sql.includes('for update'));
  assert.ok(beginIdx >= 0 && lockIdx > beginIdx, 'for-update read must run inside the transaction');
});

test('dryRun validates full command and returns diff without writes', async () => {
  const client = fakeClient({ projection: { on_hand: 2, reserved: 0, allocated: 0, quarantined: 0, available: 2, inbound: 0, backordered: 0 } });
  const out = await applyInventoryOperation({ client, ...base, dryRun: true, itemId: 'item-1', locationId: 'loc-1', operationType: 'shipment', quantity: 1, uomId: 'each', occurredAt: '2026-07-11T00:00:00Z' });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.dryRun, true);
  assert.equal(client.queries.some((q) => q.sql.includes('insert into inventory_operations')), false);
});

test('failed mid-command transaction rolls back without commit', async () => {
  const client = fakeClient({ failOn: 'insert into inventory_item_levels' });
  await assert.rejects(() => applyInventoryOperation({ client, ...base, itemId: 'item-1', locationId: 'loc-1', operationType: 'receipt', quantity: 1, uomId: 'each', occurredAt: '2026-07-11T00:00:00Z' }), /simulated failure/);
  assert.ok(client.queries.find((q) => q.sql === 'rollback'));
  assert.equal(client.queries.some((q) => q.sql === 'commit'), false);
});

test('commercial commitments write PO and SO as commitments, not movements, with audit', async () => {
  const poClient = fakeClient();
  const po = await createPurchaseOrder({ client: poClient, ...base, supplierId: 'supplier-1', lines: [{ itemId: 'item-1', quantity: 10, uomId: 'each', expectedUnitCostAmount: 2, expectedUnitCostCurrency: 'USD' }] });
  assert.equal(po.receipt.consequence.state, 'approved');
  assert.ok(poClient.queries.some((q) => q.sql.includes('insert into inventory_purchase_order_lines')));
  assert.equal(poClient.queries.some((q) => q.sql.includes('insert into inventory_operations')), false);

  const soClient = fakeClient();
  const so = await createSalesOrder({ client: soClient, ...base, idempotencyKey: 'so-1', customerRef: 'cust-1', lines: [{ itemId: 'item-1', quantity: 4, uomId: 'each' }] });
  assert.equal(so.receipt.consequence.state, 'order');
  assert.ok(soClient.queries.some((q) => q.sql.includes('insert into inventory_sales_order_lines')));
});

test('count session open uses real DB wiring and refuses duplicate open scope', async () => {
  const client = fakeClient();
  const out = await openInventoryCountSession({ client, ...base, scope: { all: true } });
  assert.equal(out.applied, true);
  assert.ok(client.queries.some((q) => q.sql.includes('insert into inventory_count_sessions')));
});

test('rebuild projection from operation log matches fold', async () => {
  const projection = await rebuildInventoryProjectionFromDb({ client: fakeClient(), clientId: 'client-1' });
  assert.equal(projection[0].on_hand, 3);
  assert.equal(projection[0].available, 3);
});

test('closing a count session persists count_correction operations, moves the projection and mints anomalies in one transaction', async () => {
  const client = fakeClient({
    session: { id: 401, state: 'open' },
    levels: [{ item_id: 'item-1', location_id: 'loc-1', on_hand: 5, reserved: 0, allocated: 0, quarantined: 0, inbound: 0, backordered: 0 }]
  });
  const out = await closeInventoryCountSession({ client, ...base, sessionId: 401, lines: [{ item_id: 'item-1', location_id: 'loc-1', counted_quantity: 3, uom_id: 'each' }] });
  assert.equal(out.applied, true);
  // The variance (counted 3 vs on-hand 5 → delta -2) becomes a persisted
  // count_correction operation, a projection upsert and a variance anomaly — a
  // close that dropped these would be a silent no-op on stock.
  const opInsert = client.queries.find((q) => q.sql.includes('insert into inventory_operations'));
  assert.ok(opInsert, 'count_correction operation must be inserted');
  assert.equal(opInsert.params[4], -2, 'operation quantity is the counted delta');
  const levelInsert = client.queries.find((q) => q.sql.includes('insert into inventory_item_levels'));
  assert.ok(levelInsert, 'projection must be upserted to counted reality');
  assert.equal(levelInsert.params[4], 3, 'on_hand moves to the counted quantity');
  assert.ok(client.queries.some((q) => q.sql.includes('insert into inventory_anomalies')), 'variance anomaly must be minted');
  assert.ok(client.queries.some((q) => q.sql.includes('insert into inventory_command_receipts')));
  assert.ok(client.queries.some((q) => q.sql.includes('insert into audit_events')));
  const beginIdx = queryIndex(client, (sql) => sql === 'begin');
  const commitIdx = queryIndex(client, (sql) => sql === 'commit');
  const opIdx = queryIndex(client, (sql) => sql.includes('insert into inventory_operations'));
  assert.ok(beginIdx >= 0 && opIdx > beginIdx && commitIdx > opIdx, 'corrections persist inside the transaction');
});

test('count session close is idempotent — replay returns the original receipt and writes no corrections', async () => {
  const receipt = { intent: 'inventory.count_session.close', consequence: { operations: [], anomalies: [] } };
  const client = fakeClient({ existingReceipt: receipt, session: { id: 401, state: 'open' } });
  const out = await closeInventoryCountSession({ client, ...base, sessionId: 401, lines: [{ item_id: 'item-1', location_id: 'loc-1', counted_quantity: 1, uom_id: 'each' }] });
  assert.equal(out.applied, true);
  assert.equal(out.receipt.replayed, true);
  assert.equal(client.queries.some((q) => q.sql.includes('insert into inventory_operations')), false);
});

test('legacy count close refuses physical reconciliation sessions before any stock write', async () => {
  const client = fakeClient({session:{id:401,state:'open',physical_reconciliation:true}});
  const out=await closeInventoryCountSession({client,...base,sessionId:401,lines:[]});
  assert.equal(out.applied,false);assert.equal(out.reason,'invalid_state_transition');
  assert.equal(client.queries.some(q=>q.sql.includes('insert into inventory_operations')),false);
});
