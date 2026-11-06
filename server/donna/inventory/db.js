// Donna Inventory substrate (I1+I2) — DB caller helpers. These are the only
// inventory write entry-points in this PR; every applied command is gated by
// INVENTORY_CORE, idempotent at schema level, audited in the same transaction,
// and records append-only operations/corrections rather than mutating history.

import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { INVENTORY_CORE_FLAG_KEY } from './constants.js';
import {
  availabilityFor,
  buildOperationCommand,
  boundedPage,
  closeCountSession,
  decimal,
  findSku as findSkuPure,
  foldOperations,
  groupRollup as groupRollupPure,
  inventorySnapshot as inventorySnapshotPure,
  openCountSession,
  refusal,
  validateMoney,
  skuCard as skuCardPure
} from './core.js';

export { INVENTORY_CORE_FLAG_KEY } from './constants.js';

const withTx = async (client, fn) => {
  await client.query('begin');
  try {
    const out = await fn();
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    if (e.reason) return refusal(e.reason, { message: e.message });
    throw e;
  }
};

const enabled = async ({ client, firmId, clientId }) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  return clientFlagActs({ flagKey: INVENTORY_CORE_FLAG_KEY, snapshot, envFallback: () => false });
};

const originalReceipt = async ({ client, idempotencyKey, firmId, clientId }) => {
  const existing = await client.query('select receipt from inventory_command_receipts where idempotency_key = $1 and firm_id = $2 and client_id = $3', [idempotencyKey, firmId, clientId]);
  return existing.rows[0]?.receipt || null;
};


// One client-wide transaction lock is deliberately conservative for the bounded
// pilot. It covers absent level rows and acquires before PO/SO/session row locks,
// so all physical and commitment writers share one deadlock-free lock order.
export const lockInventoryScope = ({ client, clientId }) => client.query(
  "select pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory:scope:${clientId}`]
);

const validateStockScope = async ({ client, firmId, clientId, itemId, locationId, uomId }) => {
  const item = (await client.query('select base_uom_id from inventory_items where firm_id = $1 and client_id = $2 and id = $3', [firmId, clientId, itemId])).rows[0];
  if (!item) return refusal('unknown_item');
  if (locationId && !(await client.query('select id from inventory_locations where firm_id = $1 and client_id = $2 and id = $3', [firmId, clientId, locationId])).rows.length) return refusal('unknown_location');
  // Stored projection quantities and costs are base-UOM facts. Until commercial
  // conversions can convert the matching unit cost too, refuse other UOMs.
  if (!item.base_uom_id || (uomId && uomId !== item.base_uom_id)) return refusal('undefined_uom_conversion');
  return { applied: true, uomId: item.base_uom_id };
};

const audit = async ({ client, firmId, clientId, actorId, action, resourceType, resourceId, receipt }) => client.query(
  `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
   values ($1, $2, 'user', $3, $4, $5, $6, $7::jsonb)`,
  [firmId, clientId, actorId, action, resourceType, resourceId, JSON.stringify({ receipt })]
);

export const applyInventoryOperationWithinTransaction = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, ...fields }) => {
  if (!client || !firmId || !clientId || !actorId || !idempotencyKey) return refusal('invalid_command');
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  // Idempotency replay AND the `for update` projection read both run INSIDE the
  // transaction. In node-postgres autocommit mode a `select ... for update`
  // issued outside an open transaction takes a row lock that releases the
  // instant that implicit statement commits — it cannot serialise two
  // concurrent commands on the same item, leaving a lost-update window on the
  // projection upsert. The lock must be held from read through write.
  await lockInventoryScope({ client, clientId });
  const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
  if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
  const scope = await validateStockScope({ client, firmId, clientId, itemId: fields.itemId, locationId: fields.locationId || 'default', uomId: fields.uomId });
  if (!scope.applied) return scope;
  fields = { ...fields, uomId: scope.uomId };
  if (fields.operationType === 'reversal') {
    if (!/^\d+$/.test(String(fields.reversesOperationId || ''))) return refusal('invalid_reversal');
    const target = (await client.query('select * from inventory_operations where firm_id = $1 and client_id = $2 and id = $3', [firmId, clientId, fields.reversesOperationId])).rows[0];
    if (!target || target.item_id !== fields.itemId || target.location_id !== (fields.locationId || 'default') || target.operation_type === 'reversal') return refusal('invalid_reversal');
    if (['purchase_order_line', 'sales_order_line'].includes(target.reference_type)) return refusal('reversal_requires_commitment_resolution');
    const prior = (await client.query('select id from inventory_operations where client_id = $1 and reverses_operation_id = $2', [clientId, target.id])).rows;
    if (prior.length) return refusal('invalid_reversal', { alreadyReversed: true });
    const latest = (await client.query("select id, occurred_at from inventory_operations where client_id = $1 and item_id = $2 order by occurred_at desc, id desc limit 1", [clientId, fields.itemId])).rows[0];
    if (String(latest?.id) !== String(target.id) || !Number.isFinite(Date.parse(fields.occurredAt)) || Date.parse(fields.occurredAt) < new Date(target.occurred_at).getTime()) return refusal('stale_reversal');
    const q = decimal(target.quantity);
    const effect = ['opening_balance', 'receipt', 'count_correction'].includes(target.operation_type) ? { on_hand: -q }
      : ['shipment', 'owner_private_use'].includes(target.operation_type) ? { on_hand: q }
        : { quarantined: target.operation_type === 'quarantine' ? -q : q };
    fields = { ...fields, quantity: Math.abs(q), reversalEffect: effect, payload: { ...fields.payload, reversed_operation_id: String(target.id) } };
  }
  const projection = await client.query(
    'select * from inventory_item_levels where client_id = $1 and item_id = $2 and location_id = $3 for update',
    [clientId, fields.itemId, fields.locationId || 'default']
  );
  const command = buildOperationCommand({ ...fields, clientId, actorId, idempotencyKey, dryRun, currentProjection: projection.rows[0] || null });
  if (!command.applied || dryRun) return command;
  const op = command.receipt.operation;
  const inserted = await client.query(
    `insert into inventory_operations
      (firm_id, client_id, item_id, location_id, operation_type, quantity, uom_id, occurred_at,
       idempotency_key, reverses_operation_id, reference_type, reference_id, unit_cost_amount,
       unit_cost_currency, provisional_cost, actor_id, authority_basis, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
     returning id`,
    [firmId, clientId, op.itemId, op.locationId, op.operationType, op.quantity, op.uomId, op.occurredAt,
      idempotencyKey, fields.reversesOperationId || null, fields.referenceType || null, fields.referenceId || null,
      op.unitCost?.amount ?? null, op.unitCost?.currency || null, op.provisionalCost, actorId, command.receipt.authorityBasis || null,
      JSON.stringify({ ...fields.payload, reason: op.reason, reference: command.receipt.reference, ...(op.effect ? { effect: op.effect } : {}) })]
  );
  const opId = inserted.rows[0]?.id;
  await client.query(
    `insert into inventory_item_levels
      (firm_id, client_id, item_id, location_id, on_hand, reserved, allocated, quarantined, available, inbound, backordered, last_operation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (client_id, item_id, location_id) do update set
      on_hand = excluded.on_hand, reserved = excluded.reserved, allocated = excluded.allocated,
      quarantined = excluded.quarantined, available = excluded.available, inbound = excluded.inbound,
      backordered = excluded.backordered, last_operation_id = excluded.last_operation_id, updated_at = now()`,
    [firmId, clientId, op.itemId, op.locationId, command.receipt.consequence.after.on_hand,
      command.receipt.consequence.after.reserved, command.receipt.consequence.after.allocated,
      command.receipt.consequence.after.quarantined, command.receipt.consequence.after.available,
      command.receipt.consequence.after.inbound, command.receipt.consequence.after.backordered, opId]
  );
  for (const a of command.receipt.consequence.anomalies) {
    await client.query(
      `insert into inventory_anomalies (firm_id, client_id, item_id, location_id, anomaly_type, status, payload)
       values ($1,$2,$3,$4,$5,'open',$6::jsonb)`,
      [firmId, clientId, a.itemId || a.item_id || op.itemId, a.locationId || a.location_id || op.locationId, a.type, JSON.stringify(a)]
    );
  }
  const receipt = { ...command.receipt, operationId: opId, payload: fields.payload || {} };
  await client.query('insert into inventory_command_receipts (firm_id, client_id, idempotency_key, intent, receipt) values ($1,$2,$3,$4,$5::jsonb)', [firmId, clientId, idempotencyKey, receipt.intent, JSON.stringify(receipt)]);
  await audit({ client, firmId, clientId, actorId, action: receipt.intent, resourceType: 'inventory_operation', resourceId: opId, receipt });
  return { applied: true, receipt };
};

export const applyInventoryOperation = (args) => withTx(args.client, () => applyInventoryOperationWithinTransaction(args));

// Accepted physical reconciliation uses this explicit count entrypoint while
// preserving the same operation/projection/receipt/audit writer.
export const applyInventoryCountCorrectionWithinTransaction = (args) => applyInventoryOperationWithinTransaction({ ...args, operationType: 'count_correction' });

export const seedOpeningInventory = (args) => applyInventoryOperation({ ...args, operationType: 'opening_balance' });
const appendPurchaseReceiptOperation = (args) => applyInventoryOperation({ ...args, operationType: 'receipt', referenceType: 'purchase_order_line' });
const appendSalesShipmentOperation = (args) => applyInventoryOperation({ ...args, operationType: 'shipment', referenceType: 'sales_order_line' });
export const reverseInventoryOperation = (args) => applyInventoryOperation({ ...args, operationType: 'reversal' });

export const rebuildInventoryProjectionFromDb = async ({ client, clientId }) => {
  const ops = await client.query('select * from inventory_operations where client_id = $1 order by occurred_at, id', [clientId]);
  return foldOperations(ops.rows);
};

export const createPurchaseOrder = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, supplierId, lines = [] }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  if (!supplierId || !lines.length) return refusal('invalid_command');
  const receipt = { intent: 'inventory.purchase_order.create', idempotencyKey, actorId, dryRun, invariant: 'po_is_authorised_commitment_not_invoice', consequence: { state: 'approved', supplierId, lineCount: lines.length } };
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
    if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    lines = lines.map(line => ({ ...line }));
    for (const line of lines) {
      const scope = await validateStockScope({ client, firmId, clientId, itemId: line.itemId, uomId: line.uomId });
      if (!scope.applied) return scope;
      if (!Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) return refusal('invalid_quantity');
      if (line.expectedUnitCostAmount != null || line.expectedUnitCostCurrency != null) {
        try { validateMoney({ amount: line.expectedUnitCostAmount, currency: line.expectedUnitCostCurrency }); } catch { return refusal('invalid_money'); }
      }
      line.uomId = scope.uomId;
    }
    if (dryRun) return { applied: true, receipt };
    const po = await client.query('insert into inventory_purchase_orders (firm_id, client_id, supplier_id, state, idempotency_key, actor_id, payload) values ($1,$2,$3,$4,$5,$6,$7::jsonb) returning id', [firmId, clientId, supplierId, 'approved', idempotencyKey, actorId, JSON.stringify({})]);
    for (const line of lines) await client.query('insert into inventory_purchase_order_lines (firm_id, client_id, purchase_order_id, item_id, quantity_ordered, uom_id, expected_unit_cost_amount, expected_unit_cost_currency) values ($1,$2,$3,$4,$5,$6,$7,$8)', [firmId, clientId, po.rows[0].id, line.itemId, line.quantity, line.uomId, line.expectedUnitCostAmount ?? null, line.expectedUnitCostCurrency || null]);
    const out = { ...receipt, purchaseOrderId: po.rows[0].id };
    await client.query('insert into inventory_command_receipts (firm_id, client_id, idempotency_key, intent, receipt) values ($1,$2,$3,$4,$5::jsonb)', [firmId, clientId, idempotencyKey, out.intent, JSON.stringify(out)]);
    await audit({ client, firmId, clientId, actorId, action: out.intent, resourceType: 'inventory_purchase_order', resourceId: po.rows[0].id, receipt: out });
    return { applied: true, receipt: out };
  });
};

export const createSalesOrder = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, customerRef, lines = [] }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  if (!customerRef || !lines.length) return refusal('invalid_command');
  const receipt = { intent: 'inventory.sales_order.create', idempotencyKey, actorId, dryRun, invariant: 'sales_order_is_commercial_commitment_not_movement', consequence: { state: 'order', customerRef, lineCount: lines.length } };
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
    if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    lines = lines.map(line => ({ ...line }));
    for (const line of lines) {
      const scope = await validateStockScope({ client, firmId, clientId, itemId: line.itemId, uomId: line.uomId });
      if (!scope.applied) return scope;
      if (!Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) return refusal('invalid_quantity');
      line.uomId = scope.uomId;
    }
    if (dryRun) return { applied: true, receipt };
    const so = await client.query('insert into inventory_sales_orders (firm_id, client_id, customer_ref, state, idempotency_key, actor_id, payload) values ($1,$2,$3,$4,$5,$6,$7::jsonb) returning id', [firmId, clientId, customerRef, 'order', idempotencyKey, actorId, JSON.stringify({})]);
    for (const line of lines) await client.query('insert into inventory_sales_order_lines (firm_id, client_id, sales_order_id, item_id, quantity_ordered, uom_id) values ($1,$2,$3,$4,$5,$6)', [firmId, clientId, so.rows[0].id, line.itemId, line.quantity, line.uomId]);
    const out = { ...receipt, salesOrderId: so.rows[0].id };
    await client.query('insert into inventory_command_receipts (firm_id, client_id, idempotency_key, intent, receipt) values ($1,$2,$3,$4,$5::jsonb)', [firmId, clientId, idempotencyKey, out.intent, JSON.stringify(out)]);
    await audit({ client, firmId, clientId, actorId, action: out.intent, resourceType: 'inventory_sales_order', resourceId: so.rows[0].id, receipt: out });
    return { applied: true, receipt: out };
  });
};

export const openInventoryCountSession = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, scope }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
    if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    const existing = await client.query("select id from inventory_count_sessions where client_id = $1 and state = 'open' and scope = $2::jsonb", [clientId, JSON.stringify(scope)]);
    const command = openCountSession({ scope, existingOpen: existing.rows, actorId, idempotencyKey, dryRun });
    if (!command.applied || dryRun) return command;
    const row = await client.query('insert into inventory_count_sessions (firm_id, client_id, scope, state, idempotency_key, actor_id) values ($1,$2,$3::jsonb,$4,$5,$6) returning id', [firmId, clientId, JSON.stringify(scope), 'open', idempotencyKey, actorId]);
    const receipt = { ...command.receipt, countSessionId: row.rows[0].id };
    await client.query('insert into inventory_command_receipts (firm_id, client_id, idempotency_key, intent, receipt) values ($1,$2,$3,$4,$5::jsonb)', [firmId, clientId, idempotencyKey, receipt.intent, JSON.stringify(receipt)]);
    await audit({ client, firmId, clientId, actorId, action: receipt.intent, resourceType: 'inventory_count_session', resourceId: row.rows[0].id, receipt });
    return { applied: true, receipt };
  });
};

export const closeInventoryCountSessionWithinTransaction = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, sessionId, lines = [] }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  await lockInventoryScope({ client, clientId });
  const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
  if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
  const session = (await client.query('select * from inventory_count_sessions where client_id = $1 and id = $2 for update', [clientId, sessionId])).rows[0];
  if (session?.physical_reconciliation === true) return refusal('invalid_state_transition', { required: 'physical_reconciliation_resolution' });
  lines = lines.map(line => ({ ...line }));
  for (const line of lines) {
    const scope = await validateStockScope({ client, firmId, clientId, itemId: line.item_id, locationId: line.location_id || 'default', uomId: line.uom_id });
    if (!scope.applied) return scope;
    line.uom_id = scope.uomId;
  }
  const projections = (await client.query('select * from inventory_item_levels where client_id = $1 for update', [clientId])).rows;
  const command = closeCountSession({ session, lines, projections, actorId, idempotencyKey, dryRun });
  if (!command.applied || dryRun) return command;
  await client.query("update inventory_count_sessions set state = 'closed', closed_at = now() where id = $1", [sessionId]);
  for (const line of lines) await client.query('insert into inventory_count_lines (firm_id, client_id, count_session_id, item_id, location_id, counted_quantity, uom_id, payload) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [firmId, clientId, sessionId, line.item_id, line.location_id || 'default', line.counted_quantity, line.uom_id, JSON.stringify(line.payload || {})]);
  const levelByKey = new Map(projections.map((p) => [`${p.item_id}:${p.location_id}`, p]));
  const correctionOps = [];
  let correctionIndex = 0;
  for (const corr of command.receipt.consequence.operations) {
    const locationId = corr.location_id || 'default';
    const current = levelByKey.get(`${corr.item_id}:${locationId}`) || { on_hand: 0, reserved: 0, allocated: 0, quarantined: 0, inbound: 0, backordered: 0 };
    const onHand = decimal(Number(current.on_hand || 0) + Number(corr.quantity || 0), 'on_hand');
    const available = decimal(onHand - Number(current.reserved || 0) - Number(current.allocated || 0) - Number(current.quarantined || 0), 'available');
    const inserted = await client.query(
      `insert into inventory_operations
        (firm_id, client_id, item_id, location_id, operation_type, quantity, uom_id, occurred_at,
         idempotency_key, reference_type, reference_id, actor_id, payload)
       values ($1,$2,$3,$4,'count_correction',$5,$6, statement_timestamp(), $7, 'count_session', $8, $9, $10::jsonb)
       returning id`,
      [firmId, clientId, corr.item_id, locationId, corr.quantity, corr.uom_id || null, `${idempotencyKey}:corr:${correctionIndex++}`, String(sessionId), actorId, JSON.stringify({ count_session_id: sessionId, count_line_evidence: lines.find(line => line.item_id === corr.item_id && (line.location_id || 'default') === locationId)?.payload || {} })]
    );
    const opId = inserted.rows[0]?.id;
    await client.query(
      `insert into inventory_item_levels
        (firm_id, client_id, item_id, location_id, on_hand, reserved, allocated, quarantined, available, inbound, backordered, last_operation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (client_id, item_id, location_id) do update set
        on_hand = excluded.on_hand, available = excluded.available,
        last_operation_id = excluded.last_operation_id, updated_at = now()`,
      [firmId, clientId, corr.item_id, locationId, onHand, Number(current.reserved || 0), Number(current.allocated || 0), Number(current.quarantined || 0), available, Number(current.inbound || 0), Number(current.backordered || 0), opId]
    );
    correctionOps.push({ ...corr, location_id: locationId, operation_id: opId, on_hand: onHand });
  }
  for (const a of command.receipt.consequence.anomalies) {
    await client.query(
      `insert into inventory_anomalies (firm_id, client_id, item_id, location_id, anomaly_type, status, payload)
       values ($1,$2,$3,$4,$5,'open',$6::jsonb)`,
      [firmId, clientId, a.item_id || null, a.location_id || 'default', a.type, JSON.stringify(a)]
    );
  }
  const receipt = { ...command.receipt, countSessionId: sessionId, lines, consequence: { ...command.receipt.consequence, operations: correctionOps } };
  await client.query('insert into inventory_command_receipts (firm_id, client_id, idempotency_key, intent, receipt) values ($1,$2,$3,$4,$5::jsonb)', [firmId, clientId, idempotencyKey, receipt.intent, JSON.stringify(receipt)]);
  await audit({ client, firmId, clientId, actorId, action: receipt.intent, resourceType: 'inventory_count_session', resourceId: sessionId, receipt });
  return { applied: true, receipt };
};

export const closeInventoryCountSession = (args) => withTx(args.client, () => closeInventoryCountSessionWithinTransaction(args));

const num = (v) => decimal(Number(v || 0));
const recalcAvailable = (row) => decimal(num(row.on_hand) - num(row.reserved) - num(row.allocated) - num(row.quarantined));
const okReceipt = async ({ client, firmId, clientId, idempotencyKey, intent, receipt }) => client.query(
  'insert into inventory_command_receipts (firm_id, client_id, idempotency_key, intent, receipt) values ($1,$2,$3,$4,$5::jsonb)',
  [firmId, clientId, idempotencyKey, intent, JSON.stringify(receipt)]
);
const levelUpsert = async ({ client, firmId, clientId, itemId, locationId, before, after, lastOperationId = null }) => client.query(
  `insert into inventory_item_levels
    (firm_id, client_id, item_id, location_id, on_hand, reserved, allocated, quarantined, available, inbound, backordered, last_operation_id)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
   on conflict (client_id, item_id, location_id) do update set
    on_hand = excluded.on_hand, reserved = excluded.reserved, allocated = excluded.allocated,
    quarantined = excluded.quarantined, available = excluded.available, inbound = excluded.inbound,
    backordered = excluded.backordered, last_operation_id = coalesce(excluded.last_operation_id, inventory_item_levels.last_operation_id), updated_at = now()`,
  [firmId, clientId, itemId, locationId, num(after.on_hand ?? before.on_hand), num(after.reserved), num(after.allocated), num(after.quarantined), recalcAvailable(after), num(after.inbound), num(after.backordered), lastOperationId]
);
const anomaly = ({ client, firmId, clientId, itemId = null, locationId = null, type, payload = {} }) => client.query(
  `insert into inventory_anomalies (firm_id, client_id, item_id, location_id, anomaly_type, status, payload)
   values ($1,$2,$3,$4,$5,'open',$6::jsonb)`,
  [firmId, clientId, itemId, locationId, type, JSON.stringify({ type, ...payload })]
);
const defaultLocation = async ({ client, clientId }) => (await client.query("select id from inventory_locations where client_id = $1 and is_default = true order by id limit 1", [clientId])).rows[0]?.id || 'default';
const updateInbound = async ({ client, firmId, clientId, itemId, locationId }) => {
  const r = await client.query(
    `select coalesce(sum(greatest(pol.quantity_ordered - pol.quantity_received, 0)), 0) as inbound
       from inventory_purchase_order_lines pol
       join inventory_purchase_orders po on po.id = pol.purchase_order_id
      where pol.client_id = $1 and pol.item_id = $2 and not pol.closed_short and po.state in ('ordered','acknowledged','partially_received')`,
    [clientId, itemId]
  );
  const level = (await client.query('select * from inventory_item_levels where client_id = $1 and item_id = $2 and location_id = $3 for update', [clientId, itemId, locationId])).rows[0] || { on_hand: 0, reserved: 0, allocated: 0, quarantined: 0, inbound: 0, backordered: 0 };
  const after = { ...level, inbound: num(r.rows[0]?.inbound) };
  await levelUpsert({ client, firmId, clientId, itemId, locationId, before: level, after });
  return { before: level, after };
};

// FIFO-consume `amount` units across the ACTIVE child rows (reservations or
// allocations) of a sales-order line: decrement each row's quantity and mark it
// terminal ONLY when fully consumed. A partial op must NOT blanket-terminate
// every active row — otherwise item_levels.reserved (decremented by the exact
// qty) diverges from sum(active reservations), breaking the rebuild invariant.
const CONSUMABLE_COMMITMENT_TABLES = new Set(['inventory_reservations', 'inventory_allocations']);
const consumeLineCommitments = async ({ client, table, clientId, salesOrderLineId, locationId, amount, terminalState }) => {
  if (!CONSUMABLE_COMMITMENT_TABLES.has(table)) throw new Error(`unsupported commitment table ${table}`);
  let remaining = decimal(amount);
  const rows = (await client.query(`select id, quantity from ${table} where client_id = $1 and sales_order_line_id = $2 and location_id = $3 and state = 'active' order by created_at, id for update`, [clientId, salesOrderLineId, locationId])).rows;
  for (const r of rows) {
    if (remaining <= 0) break;
    const take = decimal(Math.min(remaining, num(r.quantity)));
    remaining = decimal(remaining - take);
    if (take >= num(r.quantity)) await client.query(`update ${table} set state = $1 where id = $2`, [terminalState, r.id]);
    else await client.query(`update ${table} set quantity = quantity - $1 where id = $2`, [take, r.id]);
  }
};

export const reserveSalesOrderLine = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, salesOrderLineId, locationId = 'default', quantity, expiresAt = null }) => {
  if (!client || !firmId || !clientId || !actorId || !idempotencyKey) return refusal('invalid_command');
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
    if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    const line = (await client.query('select sol.*, so.state as sales_order_state from inventory_sales_order_lines sol join inventory_sales_orders so on so.id = sol.sales_order_id where sol.client_id = $1 and sol.id = $2 for update', [clientId, salesOrderLineId])).rows[0];
    if (!line) return refusal('commitment_not_found');
    const requested = num(quantity);
    const waiting = (await client.query("select coalesce(sum(quantity), 0) as quantity from inventory_backorders where client_id = $1 and sales_order_line_id = $2 and state in ('open','partially_filled')", [clientId, salesOrderLineId])).rows[0];
    const remaining = decimal(num(line.quantity_ordered) - num(line.quantity_reserved) - num(waiting?.quantity));
    if (requested <= 0) return refusal('invalid_quantity');
    if (requested > remaining) return refusal('over_reservation', { requested, remaining });
    const scope = await validateStockScope({ client, firmId, clientId, itemId: line.item_id, locationId, uomId: line.uom_id });
    if (!scope.applied) return scope;
    const level = (await client.query('select * from inventory_item_levels where client_id = $1 and item_id = $2 and location_id = $3 for update', [clientId, line.item_id, locationId])).rows[0] || { on_hand: 0, reserved: 0, allocated: 0, quarantined: 0, inbound: 0, backordered: 0 };
    const available = Math.max(0, recalcAvailable(level));
    const reserveQty = decimal(Math.min(requested, available));
    const backorderQty = decimal(requested - reserveQty);
    const after = { ...level, reserved: decimal(num(level.reserved) + reserveQty), backordered: decimal(num(level.backordered) + backorderQty) };
    const state = reserveQty > 0 ? 'reserved' : 'backordered';
    const receipt = { intent: 'inventory.reserve', idempotencyKey, actorId, dryRun, invariant: 'reserve_available_and_track_shortfall_as_backorder', consequence: { line: { id: salesOrderLineId, before: line, after: { quantity_reserved: decimal(num(line.quantity_reserved) + reserveQty), state } }, projection: { before: level, after }, reservation: { quantity: reserveQty, state: reserveQty ? 'active' : null }, backorder: { quantity: backorderQty, state: backorderQty ? 'open' : null } } };
    if (dryRun) return { applied: true, receipt };
    let reservationId = null, backorderId = null;
    if (reserveQty > 0) reservationId = (await client.query("insert into inventory_reservations (firm_id, client_id, sales_order_line_id, item_id, location_id, quantity, state, expires_at) values ($1,$2,$3,$4,$5,$6,'active',$7) returning id", [firmId, clientId, salesOrderLineId, line.item_id, locationId, reserveQty, expiresAt])).rows[0]?.id;
    if (backorderQty > 0) backorderId = (await client.query("insert into inventory_backorders (firm_id, client_id, sales_order_line_id, item_id, quantity, state, location_id) values ($1,$2,$3,$4,$5,'open',$6) returning id", [firmId, clientId, salesOrderLineId, line.item_id, backorderQty, locationId])).rows[0]?.id;
    await client.query('update inventory_sales_order_lines set quantity_reserved = quantity_reserved + $1 where id = $2', [reserveQty, salesOrderLineId]);
    // Reserving stock does not imply a shipment. Preserve more advanced
    // work on another line while reporting a wholly unshipped order honestly.
    const order = (await client.query(`select bool_and(quantity_shipped >= quantity_ordered) as done,
      bool_or(quantity_shipped > 0) as has_shipment,
      bool_or(quantity_allocated > quantity_shipped) as has_allocation,
      bool_or(quantity_reserved > quantity_shipped) as has_reservation
      from inventory_sales_order_lines where client_id = $1 and sales_order_id = $2`, [clientId, line.sales_order_id])).rows[0] || {};
    const orderState = order.done ? 'shipped' : order.has_shipment ? 'partially_shipped'
      : order.has_allocation ? 'allocated' : order.has_reservation ? 'reserved' : 'backordered';
    await client.query('update inventory_sales_orders set state = $1, updated_at = now() where id = $2', [orderState, line.sales_order_id]);
    await levelUpsert({ client, firmId, clientId, itemId: line.item_id, locationId, before: level, after });
    const out = { ...receipt, reservationId, backorderId };
    await okReceipt({ client, firmId, clientId, idempotencyKey, intent: out.intent, receipt: out });
    await audit({ client, firmId, clientId, actorId, action: out.intent, resourceType: 'inventory_sales_order_line', resourceId: salesOrderLineId, receipt: out });
    return { applied: true, receipt: out };
  });
};

export const allocateSalesOrderLine = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, salesOrderLineId, locationId = 'default', quantity }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
    if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    const line = (await client.query('select sol.*, so.state as sales_order_state from inventory_sales_order_lines sol join inventory_sales_orders so on so.id = sol.sales_order_id where sol.client_id = $1 and sol.id = $2 for update', [clientId, salesOrderLineId])).rows[0];
    if (!line) return refusal('commitment_not_found');
    const requested = num(quantity); const allocatable = decimal(num(line.quantity_reserved) - num(line.quantity_allocated));
    if (requested <= 0) return refusal('invalid_quantity');
    if (requested > allocatable) return refusal('over_allocation', { requested, allocatable });
    const scope = await validateStockScope({ client, firmId, clientId, itemId: line.item_id, locationId, uomId: line.uom_id });
    if (!scope.applied) return scope;
    const level = (await client.query('select * from inventory_item_levels where client_id = $1 and item_id = $2 and location_id = $3 for update', [clientId, line.item_id, locationId])).rows[0] || { on_hand: 0, reserved: 0, allocated: 0, quarantined: 0, inbound: 0, backordered: 0 };
    const scopedReserved = (await client.query("select coalesce(sum(quantity), 0) as quantity from inventory_reservations where client_id = $1 and sales_order_line_id = $2 and location_id = $3 and state = 'active'", [clientId, salesOrderLineId, locationId])).rows[0];
    if (requested > num(scopedReserved?.quantity)) return refusal('over_allocation');
    const after = { ...level, reserved: decimal(num(level.reserved) - requested), allocated: decimal(num(level.allocated) + requested) };
    const receipt = { intent: 'inventory.allocate', idempotencyKey, actorId, dryRun, invariant: 'allocated_stock_must_have_been_reserved_available_unchanged', consequence: { projection: { before: level, after }, line: { id: salesOrderLineId, before: line, after: { quantity_allocated: decimal(num(line.quantity_allocated) + requested), state: 'allocated' } }, allocation: { quantity: requested, state: 'active' } } };
    if (dryRun) return { applied: true, receipt };
    const allocationId = (await client.query("insert into inventory_allocations (firm_id, client_id, sales_order_line_id, item_id, location_id, quantity, state) values ($1,$2,$3,$4,$5,$6,'active') returning id", [firmId, clientId, salesOrderLineId, line.item_id, locationId, requested])).rows[0]?.id;
    await consumeLineCommitments({ client, table: 'inventory_reservations', clientId, salesOrderLineId, locationId, amount: requested, terminalState: 'fulfilled' });
    await client.query('update inventory_sales_order_lines set quantity_allocated = quantity_allocated + $1 where id = $2', [requested, salesOrderLineId]);
    await client.query("update inventory_sales_orders set state = 'allocated', updated_at = now() where id = $1", [line.sales_order_id]);
    await levelUpsert({ client, firmId, clientId, itemId: line.item_id, locationId, before: level, after });
    const out = { ...receipt, allocationId };
    await okReceipt({ client, firmId, clientId, idempotencyKey, intent: out.intent, receipt: out });
    await audit({ client, firmId, clientId, actorId, action: out.intent, resourceType: 'inventory_sales_order_line', resourceId: salesOrderLineId, receipt: out });
    return { applied: true, receipt: out };
  });
};

const poTransition = (from, to) => async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, purchaseOrderId, acknowledgedAt = null, payload = {} }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
    if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    const po = (await client.query('select * from inventory_purchase_orders where client_id = $1 and id = $2 for update', [clientId, purchaseOrderId])).rows[0];
    if (!po) return refusal('commitment_not_found');
    if (po.state !== from) return refusal('invalid_state_transition', { from: po.state, required: from, to });
    if (to === 'acknowledged' && !acknowledgedAt) return refusal('invalid_command', { acknowledgedAt: 'required' });
    const receipt = { intent: `inventory.po.${to === 'ordered' ? 'place' : to}`, idempotencyKey, actorId, dryRun, invariant: 'purchase_order_lifecycle_is_explicit_and_audited', consequence: { purchaseOrder: { id: purchaseOrderId, before: po.state, after: to } } };
    if (dryRun) return { applied: true, receipt };
    await client.query('update inventory_purchase_orders set state = $1, updated_at = now() where id = $2', [to, purchaseOrderId]);
    if (to === 'acknowledged') await client.query('insert into inventory_supplier_acknowledgements (firm_id, client_id, purchase_order_id, acknowledged_at, payload) values ($1,$2,$3,$4,$5::jsonb)', [firmId, clientId, purchaseOrderId, acknowledgedAt, JSON.stringify(payload)]);
    if (to === 'ordered' || to === 'acknowledged') {
      const loc = await defaultLocation({ client, clientId });
      const lines = (await client.query('select item_id from inventory_purchase_order_lines where client_id = $1 and purchase_order_id = $2', [clientId, purchaseOrderId])).rows;
      for (const l of lines) await updateInbound({ client, firmId, clientId, itemId: l.item_id, locationId: loc });
    }
    await okReceipt({ client, firmId, clientId, idempotencyKey, intent: receipt.intent, receipt });
    await audit({ client, firmId, clientId, actorId, action: receipt.intent, resourceType: 'inventory_purchase_order', resourceId: purchaseOrderId, receipt });
    return { applied: true, receipt };
  });
};
export const approvePurchaseOrder = poTransition('proposal', 'approved');
export const placePurchaseOrder = poTransition('approved', 'ordered');
export const acknowledgeSupplier = poTransition('ordered', 'acknowledged');

export const shipSalesOrderLine = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, salesOrderLineId, locationId = 'default', quantity, uomId, occurredAt, ...rest }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
    if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    const line = (await client.query('select sol.*, so.state as sales_order_state from inventory_sales_order_lines sol join inventory_sales_orders so on so.id = sol.sales_order_id where sol.client_id = $1 and sol.id = $2 for update', [clientId, salesOrderLineId])).rows[0];
    if (!line) return refusal('commitment_not_found');
    if (uomId && uomId !== line.uom_id) return refusal('undefined_uom_conversion');
    const q = num(quantity); const shippable = decimal(num(line.quantity_allocated) - num(line.quantity_shipped));
    if (q <= 0) return refusal('invalid_quantity');
    if (q > shippable) return refusal('ship_exceeds_allocation', { requested: q, shippable });
    const scope = await validateStockScope({ client, firmId, clientId, itemId: line.item_id, locationId, uomId: line.uom_id });
    if (!scope.applied) return scope;
    const level = (await client.query('select * from inventory_item_levels where client_id = $1 and item_id = $2 and location_id = $3 for update', [clientId, line.item_id, locationId])).rows[0] || { on_hand: 0, reserved: 0, allocated: 0, quarantined: 0, inbound: 0, backordered: 0 };
    const scopedAllocation = (await client.query("select coalesce(sum(quantity), 0) as quantity from inventory_allocations where client_id = $1 and sales_order_line_id = $2 and location_id = $3 and state = 'active'", [clientId, salesOrderLineId, locationId])).rows[0];
    if (q > num(scopedAllocation?.quantity)) return refusal('ship_exceeds_allocation');
    const opCmd = buildOperationCommand({ ...rest, clientId, actorId, idempotencyKey: `${idempotencyKey}:operation`, dryRun, currentProjection: level, itemId: line.item_id, locationId, operationType: 'shipment', quantity: q, uomId: uomId || line.uom_id, occurredAt });
    if (!opCmd.applied) return opCmd;
    const after = { ...opCmd.receipt.consequence.after, allocated: decimal(num(level.allocated) - q) };
    after.available = recalcAvailable(after);
    const newShipped = decimal(num(line.quantity_shipped) + q);
    const state = newShipped >= num(line.quantity_ordered) ? 'shipped' : 'partially_shipped';
    const receipt = { intent: 'inventory.ship', idempotencyKey, actorId, dryRun, invariant: 'shipping_requires_allocated_stock_and_releases_allocation_in_same_transaction', consequence: { projection: { before: level, after }, line: { id: salesOrderLineId, before: line, after: { quantity_shipped: newShipped, state } } } };
    if (dryRun) return { applied: true, receipt };
    const inserted = await client.query(`insert into inventory_operations (firm_id, client_id, item_id, location_id, operation_type, quantity, uom_id, occurred_at, idempotency_key, reference_type, reference_id, actor_id, payload) values ($1,$2,$3,$4,'shipment',$5,$6,$7,$8,'sales_order_line',$9,$10,$11::jsonb) returning id`, [firmId, clientId, line.item_id, locationId, q, uomId || line.uom_id, occurredAt, `${idempotencyKey}:operation`, String(salesOrderLineId), actorId, JSON.stringify({})]);
    await consumeLineCommitments({ client, table: 'inventory_allocations', clientId, salesOrderLineId, locationId, amount: q, terminalState: 'shipped' });
    await client.query('update inventory_sales_order_lines set quantity_shipped = quantity_shipped + $1 where id = $2', [q, salesOrderLineId]);
    const orderDone = (await client.query('select bool_and(quantity_shipped >= quantity_ordered) as done from inventory_sales_order_lines where client_id = $1 and sales_order_id = $2', [clientId, line.sales_order_id])).rows[0]?.done;
    await client.query('update inventory_sales_orders set state = $1, updated_at = now() where id = $2', [orderDone ? 'shipped' : 'partially_shipped', line.sales_order_id]);
    await levelUpsert({ client, firmId, clientId, itemId: line.item_id, locationId, before: level, after, lastOperationId: inserted.rows[0]?.id });
    const out = { ...receipt, operationId: inserted.rows[0]?.id };
    await okReceipt({ client, firmId, clientId, idempotencyKey, intent: out.intent, receipt: out });
    await audit({ client, firmId, clientId, actorId, action: out.intent, resourceType: 'inventory_sales_order_line', resourceId: salesOrderLineId, receipt: out });
    return { applied: true, receipt: out };
  });
};

export const receivePurchaseOrderLine = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, purchaseOrderLineId, locationId = null, quantity, uomId, occurredAt, closeShort = false, ...rest }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId });
    if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    const line = (await client.query('select pol.*, po.state as purchase_order_state from inventory_purchase_order_lines pol join inventory_purchase_orders po on po.id = pol.purchase_order_id where pol.client_id = $1 and pol.id = $2 for update', [clientId, purchaseOrderLineId])).rows[0];
    if (!line) return refusal('commitment_not_found');
    if (line.closed_short || !['ordered','acknowledged','partially_received'].includes(line.purchase_order_state)) return refusal('invalid_state_transition', { state: line.purchase_order_state });
    const loc = locationId || await defaultLocation({ client, clientId }); const q = num(quantity);
    if (q <= 0) return refusal('invalid_quantity');
    const scope = await validateStockScope({ client, firmId, clientId, itemId: line.item_id, locationId: loc, uomId: uomId || line.uom_id });
    if (!scope.applied) return scope;
    const level = (await client.query('select * from inventory_item_levels where client_id = $1 and item_id = $2 and location_id = $3 for update', [clientId, line.item_id, loc])).rows[0] || { on_hand: 0, reserved: 0, allocated: 0, quarantined: 0, inbound: 0, backordered: 0 };
    const opCmd = buildOperationCommand({ unitCostAmount: line.expected_unit_cost_amount ?? null, unitCostCurrency: line.expected_unit_cost_currency ?? null, provisionalCost: true, ...rest, clientId, actorId, idempotencyKey: `${idempotencyKey}:operation`, dryRun, currentProjection: level, itemId: line.item_id, locationId: loc, operationType: 'receipt', quantity: q, uomId: uomId || line.uom_id, occurredAt });
    if (!opCmd.applied) return opCmd;
    const newReceived = decimal(num(line.quantity_received) + q);
    const anomalies = [];
    if (newReceived > num(line.quantity_ordered)) anomalies.push('over_receipt');
    if (closeShort && newReceived < num(line.quantity_ordered)) anomalies.push('short_receipt');
    const openBack = (await client.query("select * from inventory_backorders where client_id = $1 and item_id = $2 and state in ('open','partially_filled') and (location_id = $3 or (location_id is null and $3 = $4)) order by created_at, id for update", [clientId, line.item_id, loc, await defaultLocation({ client, clientId })])).rows;
    let remaining = q; const fills = [];
    for (const b of openBack) { if (remaining <= 0) break; const fill = decimal(Math.min(remaining, num(b.quantity))); remaining = decimal(remaining - fill); fills.push({ backorder: b, fill }); }
    const totalFilled = decimal(fills.reduce((s, f) => s + f.fill, 0));
    // Arrived stock that fills a backorder is re-reserved to the waiting sales-
    // order line (F-C): reserved rises by the filled amount, backordered falls by
    // it — the stock is committed to the customer, not released to free available.
    const after = { ...opCmd.receipt.consequence.after, reserved: decimal(num(level.reserved) + totalFilled), backordered: decimal(Math.max(0, num(level.backordered) - totalFilled)) };
    after.available = recalcAvailable(after);
    const receipt = { intent: 'inventory.receive', idempotencyKey, actorId, dryRun, invariant: 'receipt_updates_physical_stock_po_line_inbound_and_backorder_followthrough_atomically', consequence: { projection: { before: level, after }, line: { id: purchaseOrderLineId, before: line, after: { quantity_received: newReceived } }, backorderFills: fills.map(f => ({ id: f.backorder.id, quantity: f.fill, salesOrderLineId: f.backorder.sales_order_line_id })), reReserved: totalFilled, anomalies } };
    if (dryRun) return { applied: true, receipt };
    const inserted = await client.query(`insert into inventory_operations (firm_id, client_id, item_id, location_id, operation_type, quantity, uom_id, occurred_at, idempotency_key, reference_type, reference_id, actor_id, payload, unit_cost_amount, unit_cost_currency, provisional_cost, authority_basis) values ($1,$2,$3,$4,'receipt',$5,$6,$7,$8,'purchase_order_line',$9,$10,$11::jsonb,$12,$13,$14,$15) returning id`, [firmId, clientId, line.item_id, loc, q, uomId || line.uom_id, occurredAt, `${idempotencyKey}:operation`, String(purchaseOrderLineId), actorId, JSON.stringify({ reference: rest.reference || null }), opCmd.receipt.operation.unitCost?.amount ?? null, opCmd.receipt.operation.unitCost?.currency ?? null, rest.provisionalCost ?? (rest.unitCostAmount == null), rest.authorityBasis || null]);
    await client.query('update inventory_purchase_order_lines set quantity_received = quantity_received + $1, closed_short = $3 where id = $2', [q, purchaseOrderLineId, Boolean(closeShort && newReceived < num(line.quantity_ordered))]);
    const poDone = (await client.query('select bool_and(quantity_received >= quantity_ordered or closed_short) as done, bool_or(quantity_received > 0) as any_received from inventory_purchase_order_lines where client_id = $1 and purchase_order_id = $2', [clientId, line.purchase_order_id])).rows[0] || {};
    const poState = poDone.done ? 'fully_received' : 'partially_received';
    await client.query('update inventory_purchase_orders set state = $1, updated_at = now() where id = $2', [poState, line.purchase_order_id]);
    for (const f of fills) {
      const b = f.backorder;
      // F-B: decrement the backorder quantity so a partial fill can't be re-filled
      // in full by a later receipt; only reach 'filled' when nothing remains.
      await client.query("update inventory_backorders set quantity = quantity - $1, state = case when quantity - $1 <= 0 then 'filled' else 'partially_filled' end where id = $2", [f.fill, b.id]);
      // F-C: re-reserve the filled quantity to the waiting sales-order line.
      if (b.sales_order_line_id) {
        await client.query("insert into inventory_reservations (firm_id, client_id, sales_order_line_id, item_id, location_id, quantity, state) values ($1,$2,$3,$4,$5,$6,'active')", [firmId, clientId, b.sales_order_line_id, line.item_id, loc, f.fill]);
        await client.query('update inventory_sales_order_lines set quantity_reserved = quantity_reserved + $1 where id = $2', [f.fill, b.sales_order_line_id]);
        await client.query("update inventory_sales_orders set state = 'reserved', updated_at = now() where id = (select sales_order_id from inventory_sales_order_lines where id = $1)", [b.sales_order_line_id]);
      }
    }
    for (const t of anomalies) await anomaly({ client, firmId, clientId, itemId: line.item_id, locationId: loc, type: t, payload: { purchaseOrderLineId, quantityReceived: newReceived, quantityOrdered: num(line.quantity_ordered) } });
    await levelUpsert({ client, firmId, clientId, itemId: line.item_id, locationId: loc, before: level, after, lastOperationId: inserted.rows[0]?.id });
    const inbound = await updateInbound({ client, firmId, clientId, itemId: line.item_id, locationId: await defaultLocation({ client, clientId }) });
    if (loc === await defaultLocation({ client, clientId })) receipt.consequence.projection.after.inbound = inbound.after.inbound;
    const out = { ...receipt, operationId: inserted.rows[0]?.id };
    await okReceipt({ client, firmId, clientId, idempotencyKey, intent: out.intent, receipt: out });
    await audit({ client, firmId, clientId, actorId, action: out.intent, resourceType: 'inventory_purchase_order_line', resourceId: purchaseOrderLineId, receipt: out });
    return { applied: true, receipt: out };
  });
};

export const expireStaleReservations = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, now }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId }); if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    const rows = (await client.query("select * from inventory_reservations where client_id = $1 and state = 'active' and expires_at is not null and expires_at < $2 for update", [clientId, now])).rows;
    const receipt = { intent: 'inventory.reservations.expire', idempotencyKey, actorId, dryRun, invariant: 'expired_reservations_release_stock_and_surface_exception', consequence: { expired: rows.map(r => ({ id: r.id, quantity: num(r.quantity) })) } };
    if (dryRun) return { applied: true, receipt };
    for (const r of rows) {
      const level = (await client.query('select * from inventory_item_levels where client_id = $1 and item_id = $2 and location_id = $3 for update', [clientId, r.item_id, r.location_id])).rows[0] || { on_hand:0,reserved:0,allocated:0,quarantined:0,inbound:0,backordered:0 };
      await client.query("update inventory_reservations set state = 'expired' where id = $1", [r.id]);
      await client.query('update inventory_sales_order_lines set quantity_reserved = quantity_reserved - $1 where client_id = $2 and id = $3', [r.quantity, clientId, r.sales_order_line_id]);
      const after = { ...level, reserved: decimal(num(level.reserved) - num(r.quantity)) };
      await levelUpsert({ client, firmId, clientId, itemId: r.item_id, locationId: r.location_id, before: level, after });
      await anomaly({ client, firmId, clientId, itemId: r.item_id, locationId: r.location_id, type: 'expired_reservation', payload: { reservationId: r.id, quantity: num(r.quantity) } });
    }
    await okReceipt({ client, firmId, clientId, idempotencyKey, intent: receipt.intent, receipt });
    await audit({ client, firmId, clientId, actorId, action: receipt.intent, resourceType: 'inventory_reservation', resourceId: 'sweep', receipt });
    return { applied: true, receipt };
  });
};

export const flagOverduePurchaseOrders = async ({ client, firmId, clientId, actorId, idempotencyKey, dryRun = false, now }) => {
  if (!(await enabled({ client, firmId, clientId }))) return refusal('flag_disabled', { flagKey: INVENTORY_CORE_FLAG_KEY });
  return withTx(client, async () => {
    await lockInventoryScope({ client, clientId });
    const replay = await originalReceipt({ client, idempotencyKey, firmId, clientId }); if (replay) return { applied: true, receipt: { ...replay, replayed: true } };
    const rows = (await client.query("select * from inventory_purchase_orders where client_id = $1 and state in ('ordered','acknowledged') and (payload->>'expected_date')::timestamptz < $2 for update", [clientId, now])).rows;
    const receipt = { intent: 'inventory.po.flag_overdue', idempotencyKey, actorId, dryRun, invariant: 'overdue_supplier_waits_are_tracked_exceptions', consequence: { overdue: rows.map(r => r.id) } };
    if (dryRun) return { applied: true, receipt };
    for (const po of rows) await anomaly({ client, firmId, clientId, type: 'overdue_purchase_order', payload: { purchaseOrderId: po.id, expectedDate: po.payload?.expected_date } });
    await okReceipt({ client, firmId, clientId, idempotencyKey, intent: receipt.intent, receipt });
    await audit({ client, firmId, clientId, actorId, action: receipt.intent, resourceType: 'inventory_purchase_order', resourceId: 'sweep', receipt });
    return { applied: true, receipt };
  });
};

export const inventorySnapshot = async ({ client, clientId, limit, offset }) => {
  const page = boundedPage({ limit, offset });
  if (page.applied === false) return page;
  const projections = (await client.query('select * from inventory_item_levels where client_id = $1 order by item_id, location_id limit $2 offset $3', [clientId, page.limit, page.offset])).rows;
  const exceptions = (await client.query("select * from inventory_anomalies where client_id = $1 and status = 'open' order by created_at desc limit $2", [clientId, page.limit])).rows;
  return inventorySnapshotPure({ projections, exceptions, limit: page.limit, offset: 0 });
};

export const availabilityForItem = async ({ client, clientId, itemId, locationId = 'default' }) => {
  const row = (await client.query('select * from inventory_item_levels where client_id = $1 and item_id = $2 and location_id = $3', [clientId, itemId, locationId])).rows[0] || {};
  return availabilityFor({ projection: row, inbound: row.inbound || 0, backordered: row.backordered || 0 });
};

export const skuCard = async ({ client, clientId, itemId, limit, offset }) => skuCardPure({
  item: (await client.query('select * from inventory_items where client_id = $1 and id = $2', [clientId, itemId])).rows[0],
  operations: (await client.query('select * from inventory_operations where client_id = $1 and item_id = $2 order by occurred_at desc limit $3 offset $4', [clientId, itemId, limit || 100, offset || 0])).rows,
  commitments: [],
  limit,
  offset
});

export const groupRollup = async ({ client, clientId, prefix, limit, offset }) => groupRollupPure({ projections: (await client.query('select * from inventory_item_levels where client_id = $1 order by item_id limit $2 offset $3', [clientId, limit || 100, offset || 0])).rows, prefix, limit, offset });

export const findSku = async ({ client, clientId, query, limit = 10 }) => findSkuPure({
  query,
  limit,
  items: (await client.query('select * from inventory_items where client_id = $1 limit $2', [clientId, 500])).rows,
  aliases: (await client.query("select * from inventory_aliases where client_id = $1 and status = 'active' limit $2", [clientId, 500])).rows
});
