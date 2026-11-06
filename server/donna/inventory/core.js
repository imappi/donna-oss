// Donna Inventory substrate (I1+I2) — deterministic physical/commercial kernel.
// This module is pure/replayable: no Date.now(), no Math.random(), no ledger
// writes. DB callers pass ids/timestamps and persist the consequence diff.

import {
  ALIAS_SOURCES,
  ALIAS_STATUSES,
  AVAILABILITY_STATES,
  COUNT_SESSION_STATES,
  DEFAULT_PAGE_LIMIT,
  INVENTORY_ANOMALY_TYPES,
  INVENTORY_OPERATION_TYPES,
  INVENTORY_REFUSAL_REASONS,
  MAX_ALIAS_PER_ITEM,
  MAX_PAGE_LIMIT,
  PURCHASE_ORDER_STATES,
  SALES_ORDER_STATES
} from './constants.js';

export {
  ALIAS_SOURCES,
  ALIAS_STATUSES,
  AVAILABILITY_STATES,
  COUNT_SESSION_STATES,
  INVENTORY_ANOMALY_TYPES,
  INVENTORY_OPERATION_TYPES,
  INVENTORY_REFUSAL_REASONS,
  PURCHASE_ORDER_STATES,
  SALES_ORDER_STATES
};

const refusalSet = new Set(INVENTORY_REFUSAL_REASONS);
const opTypeSet = new Set(INVENTORY_OPERATION_TYPES);
const isoCurrency = /^[A-Z]{3}$/;

export const refusal = (reason, detail = {}) => ({
  applied: false,
  reason: refusalSet.has(reason) ? reason : 'invalid_command',
  detail
});

export const applied = (receipt) => ({ applied: true, receipt: Object.freeze(receipt) });

export const decimal = (value, field = 'quantity') => {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) throw Object.assign(new Error(`${field} must be numeric`), { reason: 'invalid_quantity' });
  const n = Number(value);
  if (!Number.isFinite(n)) throw Object.assign(new Error(`${field} must be numeric`), { reason: 'invalid_quantity' });
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
};

export const validateMoney = ({ amount, currency, field = 'unit_cost' } = {}) => {
  const n = amount === null || amount === undefined || typeof amount === 'boolean' || (typeof amount === 'string' && !amount.trim()) ? NaN : Number(amount);
  if (!Number.isFinite(n) || n < 0 || !isoCurrency.test(String(currency || ''))) {
    throw Object.assign(new Error(`${field} requires numeric amount and ISO currency`), { reason: 'invalid_money' });
  }
  return { amount: decimal(n, field), currency };
};

export const convertQuantity = ({ quantity, fromUom, toUom, conversions = [] }) => {
  const qty = decimal(quantity);
  if (!fromUom || !toUom) throw Object.assign(new Error('uom required'), { reason: 'invalid_quantity' });
  if (fromUom === toUom) return qty;
  const edge = conversions.find((c) => c.from_uom_id === fromUom && c.to_uom_id === toUom)
    || conversions.find((c) => c.fromUom === fromUom && c.toUom === toUom);
  if (!edge) throw Object.assign(new Error('undefined conversion'), { reason: 'undefined_uom_conversion' });
  return decimal(qty * decimal(edge.factor ?? edge.ratio, 'factor'));
};

// PostgreSQL timestamps are Date objects and bigint ids are strings. Canonical
// timestamp/numeric-id ordering must match SQL ORDER BY occurred_at, id.
export const compareInventoryOperations = (a, b) => {
  const stamp = op => { const v = op.occurred_at || op.occurredAt || op.created_at || op.id; return v instanceof Date ? v.toISOString() : String(v); };
  const t = stamp(a).localeCompare(stamp(b));
  if (t) return t;
  const x = String(a.id ?? a.operationId), y = String(b.id ?? b.operationId);
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0;
  return x.localeCompare(y);
};

export const foldOperations = (operations = []) => {
  const byKey = new Map();
  const sorted = [...operations].sort(compareInventoryOperations);
  for (const op of sorted) {
    if (!opTypeSet.has(op.operation_type)) throw Object.assign(new Error('unknown operation type'), { reason: 'invalid_command' });
    const key = `${op.client_id || op.clientId}:${op.item_id || op.itemId}:${op.location_id || op.locationId || 'default'}`;
    const row = byKey.get(key) || {
      client_id: op.client_id || op.clientId,
      item_id: op.item_id || op.itemId,
      location_id: op.location_id || op.locationId || 'default',
      on_hand: 0,
      reserved: 0,
      allocated: 0,
      quarantined: 0,
      inbound: 0,
      backordered: 0,
      available: 0,
      last_operation_id: null
    };
    const q = decimal(op.quantity ?? 0);
    if (['opening_balance', 'receipt', 'count_correction'].includes(op.operation_type)) row.on_hand += q;
    if (['shipment', 'owner_private_use'].includes(op.operation_type)) row.on_hand -= q;
    if (op.operation_type === 'quarantine') row.quarantined += q;
    if (op.operation_type === 'release_quarantine') row.quarantined -= q;
    if (op.operation_type === 'reversal') {
      const effect = op.effect || op.payload?.effect || {};
      for (const [field, delta] of Object.entries(effect)) if (field in row) row[field] += decimal(delta, field);
    }
    row.on_hand = decimal(row.on_hand, 'on_hand');
    row.quarantined = decimal(row.quarantined, 'quarantined');
    row.available = decimal(row.on_hand - row.reserved - row.allocated - row.quarantined, 'available');
    row.last_operation_id = op.id;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => `${a.client_id}:${a.item_id}:${a.location_id}`.localeCompare(`${b.client_id}:${b.item_id}:${b.location_id}`));
};

export const projectionEquals = (a = [], b = []) => JSON.stringify(foldProjectionRows(a)) === JSON.stringify(foldProjectionRows(b));
const foldProjectionRows = (rows) => [...rows].map((r) => ({ ...r })).sort((x, y) => `${x.client_id}:${x.item_id}:${x.location_id}`.localeCompare(`${y.client_id}:${y.item_id}:${y.location_id}`));

export const buildOperationCommand = ({
  clientId,
  itemId,
  locationId = 'default',
  operationType,
  quantity,
  uomId,
  occurredAt,
  actorId,
  idempotencyKey,
  unitCostAmount = null,
  unitCostCurrency = null,
  provisionalCost = false,
  allowNegative = false,
  currentProjection = null,
  dryRun = false,
  reason = null,
  authorityBasis = null,
  modelId = null,
  reference = null,
  reversalEffect = null
} = {}) => {
  try {
    if (!clientId || !itemId || !operationType || !actorId || !idempotencyKey || !occurredAt) return refusal('invalid_command', { required: ['clientId', 'itemId', 'operationType', 'actorId', 'idempotencyKey', 'occurredAt'] });
    if (!Number.isFinite(Date.parse(occurredAt))) return refusal('invalid_command', { occurredAt: 'valid timestamp required' });
    if (!opTypeSet.has(operationType)) return refusal('invalid_command', { operationType });
    const q = decimal(quantity);
    if (q < 0 && operationType !== 'count_correction') return refusal('invalid_quantity', { quantity });
    const cost = unitCostAmount === null && unitCostCurrency === null ? null : validateMoney({ amount: unitCostAmount, currency: unitCostCurrency });
    const before = { ...currentProjection };
    for (const field of AVAILABILITY_STATES) before[field] = decimal(currentProjection?.[field] ?? 0, field);
    const after = { ...before };
    if (['opening_balance', 'receipt', 'count_correction'].includes(operationType)) after.on_hand = decimal(after.on_hand + q);
    if (['shipment', 'owner_private_use'].includes(operationType)) after.on_hand = decimal(after.on_hand - q);
    if (operationType === 'quarantine') after.quarantined = decimal(after.quarantined + q);
    if (operationType === 'release_quarantine') after.quarantined = decimal(after.quarantined - q);
    if (operationType === 'reversal') {
      if (!reversalEffect || Object.keys(reversalEffect).some(k => !['on_hand', 'quarantined'].includes(k))) return refusal('invalid_reversal');
      for (const [field, delta] of Object.entries(reversalEffect)) after[field] = decimal(after[field] + decimal(delta));
    }
    if (after.quarantined < 0) return refusal('invalid_quantity', { quarantined: after.quarantined });
    after.available = decimal(after.on_hand - after.reserved - after.allocated - after.quarantined);
    if (!allowNegative && after.on_hand < 0 && operationType !== 'count_correction') return refusal('negative_stock_unauthorised', { before, requested: q, after });
    const anomalies = [];
    if (operationType === 'count_correction' && after.on_hand < 0) anomalies.push({ type: 'negative_observed_count', itemId, locationId, quantity: after.on_hand });
    if (operationType === 'count_correction' && q !== 0) anomalies.push({ type: 'count_variance', itemId, locationId, delta: q });
    return applied({
      intent: `inventory.${operationType}`,
      idempotencyKey,
      actorId,
      authorityBasis,
      modelId,
      dryRun,
      reference,
      invariant: 'append_only_operation_updates_projection_and_refuses_unauthorised_negative',
      operation: { clientId, itemId, locationId, operationType, quantity: q, uomId, occurredAt, unitCost: cost, provisionalCost: Boolean(provisionalCost), reason, ...(reversalEffect ? { effect: reversalEffect } : {}) },
      consequence: { before, after, anomalies }
    });
  } catch (e) {
    return refusal(e.reason || 'invalid_command', { message: e.message });
  }
};

export const availabilityFor = ({ projection = {}, inbound = 0, backordered = 0 } = {}) => ({
  state: Object.freeze({
    on_hand: decimal(projection.on_hand || 0, 'on_hand'),
    reserved: decimal(projection.reserved || 0, 'reserved'),
    allocated: decimal(projection.allocated || 0, 'allocated'),
    quarantined: decimal(projection.quarantined || 0, 'quarantined'),
    available: decimal((projection.on_hand || 0) - (projection.reserved || 0) - (projection.allocated || 0) - (projection.quarantined || 0), 'available'),
    inbound: decimal(inbound, 'inbound'),
    backordered: decimal(backordered, 'backordered')
  })
});

export const boundedPage = ({ limit = DEFAULT_PAGE_LIMIT, offset = 0 } = {}) => {
  const l = Number(limit);
  const o = Number(offset);
  if (!Number.isInteger(l) || l < 1 || l > MAX_PAGE_LIMIT || !Number.isInteger(o) || o < 0) return refusal('unbounded_read_refused', { limit, offset, max: MAX_PAGE_LIMIT });
  return { limit: l, offset: o };
};

export const inventorySnapshot = ({ projections = [], exceptions = [], limit, offset } = {}) => {
  const page = boundedPage({ limit, offset });
  if (page.applied === false) return page;
  const rankedExceptions = [...exceptions].sort((a, b) => String(a.type).localeCompare(String(b.type))).slice(0, page.limit);
  return { exceptions: rankedExceptions, rollups: projections.slice(page.offset, page.offset + page.limit), page };
};

export const groupRollup = ({ projections = [], prefix, limit, offset } = {}) => {
  const page = boundedPage({ limit, offset });
  if (page.applied === false) return page;
  if (!prefix) return refusal('invalid_command', { prefix: 'required materialized path prefix' });
  return { rows: projections.filter((p) => String(p.group_path || '').startsWith(prefix)).slice(page.offset, page.offset + page.limit), page };
};

export const skuCard = ({ item, operations = [], commitments = [], limit, offset } = {}) => {
  const page = boundedPage({ limit, offset });
  if (page.applied === false) return page;
  if (!item) return refusal('unknown_item');
  return { item, operations: operations.slice(page.offset, page.offset + page.limit), commitments: commitments.slice(0, page.limit), page };
};

export const findSku = ({ query, items = [], aliases = [], limit = 10 } = {}) => {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const exactSku = items.filter((i) => String(i.sku || '').toLowerCase() === q).map((i) => ({ item: i, match: 'exact_sku', score: 100 }));
  if (exactSku.length) return exactSku.slice(0, limit);
  const exactBarcode = items.filter((i) => (i.barcodes || []).map((b) => String(b).toLowerCase()).includes(q)).map((i) => ({ item: i, match: 'exact_barcode', score: 95 }));
  if (exactBarcode.length) return exactBarcode.slice(0, limit);
  const aliasHits = aliases.filter((a) => a.status !== 'dismissed' && String(a.alias || '').toLowerCase() === q)
    .map((a) => ({ item: items.find((i) => i.id === a.item_id || i.id === a.itemId), match: 'alias', score: 80, alias: a }))
    .filter((r) => r.item);
  if (aliasHits.length) return aliasHits.slice(0, limit);
  return items.map((i) => ({ item: i, match: 'name', score: nameScore(q, String(i.name || '').toLowerCase()) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

const nameScore = (q, name) => {
  if (!name) return 0;
  if (name.includes(q)) return 50;
  const grams = new Set(q.split('').map((_, i) => q.slice(i, i + 3)).filter((g) => g.length === 3));
  if (!grams.size) return 0;
  let hits = 0;
  for (const g of grams) if (name.includes(g)) hits += 1;
  return Math.round((hits / grams.size) * 40);
};

export const validateAliasCommand = ({ itemId, alias, source, existingAliases = [], exactSkuOrBarcodeMatch = false } = {}) => {
  if (!itemId || !alias || !ALIAS_SOURCES.includes(source)) return refusal('invalid_command');
  if (exactSkuOrBarcodeMatch) return refusal('exact_match_precedes_alias');
  if (existingAliases.filter((a) => (a.item_id || a.itemId) === itemId && a.status !== 'dismissed').length >= MAX_ALIAS_PER_ITEM) return refusal('alias_limit_exceeded', { max: MAX_ALIAS_PER_ITEM });
  return applied({ intent: 'inventory.alias_upsert', invariant: 'client_scoped_alias_capped_and_never_overrides_exact_match', consequence: { itemId, alias, source, status: 'active' } });
};

export const openCountSession = ({ scope, existingOpen = [], actorId, idempotencyKey, dryRun = false } = {}) => {
  if (!scope || !actorId || !idempotencyKey) return refusal('invalid_command');
  if (existingOpen.length) return refusal('duplicate_open_count_session', { existing: existingOpen.map((s) => s.id) });
  return applied({ intent: 'inventory.count_session.open', actorId, idempotencyKey, dryRun, invariant: 'one_open_count_session_per_scope', consequence: { state: 'open', scope } });
};

export const closeCountSession = ({ session, lines = [], projections = [], actorId, idempotencyKey, dryRun = false } = {}) => {
  if (!session || session.state !== 'open' || !actorId || !idempotencyKey) return refusal('invalid_state_transition');
  const operations = [];
  const anomalies = [];
  const seen = new Set();
  for (const line of lines) {
    const key = `${line.item_id}:${line.location_id || 'default'}`;
    if (!line.item_id || seen.has(key)) return refusal('invalid_command', { duplicateOrMissingCountLine: key });
    seen.add(key);
    try { decimal(line.counted_quantity); } catch { return refusal('invalid_quantity'); }
    const current = projections.find((p) => p.item_id === line.item_id && p.location_id === (line.location_id || 'default')) || { on_hand: 0 };
    const delta = decimal(line.counted_quantity - current.on_hand, 'delta');
    if (delta !== 0) operations.push({ operation_type: 'count_correction', item_id: line.item_id, location_id: line.location_id, quantity: delta, uom_id: line.uom_id });
    if (line.counted_quantity < 0) anomalies.push({ type: 'negative_observed_count', item_id: line.item_id, location_id: line.location_id, quantity: line.counted_quantity });
    if (delta !== 0) anomalies.push({ type: 'count_variance', item_id: line.item_id, location_id: line.location_id, delta });
  }
  return applied({ intent: 'inventory.count_session.close', actorId, idempotencyKey, dryRun, invariant: 'counts_record_reality_as_corrections_not_overwrites', consequence: { state: 'closed', operations, anomalies } });
};
