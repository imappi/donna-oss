// Donna Inventory I4 — pure/replayable valuation kernel (numbers only).
// Computes moving-average valuation, COGS figures, landed-cost allocation and
// provisional-cost variance inputs for the accounting writer. It performs no DB
// or ledger I/O; callers persist/post elsewhere. Running math is carried at 6
// decimal places (matching inventory core's numeric helper) and reported money
// boundaries are rounded to 2 decimals.
//
// P1A — the valuation-POSTING contract (docs/design-donna-inventory-accounting-i4.md
// §4, D-POST-10). The kernel is the SOLE owner of every signed amount the I4·posting
// layer routes to the ledger. On top of the moving-average fold it now emits, per
// operation, the signed functional-currency movements to the inventory / GRNI /
// COGS-or-variance buckets (with a balanced explicit-leg check), the FX facts used to
// translate each cost into the ledger's functional currency (IAS-21 transaction-date
// basis — §10), the four distinct dates (economic / accounting / tax / document —
// §6/D-POST-11), and a versioned identity (contract / kernel version, deterministic
// valuation-run id, stream version, input hash — §4) so the posting layer can reject a
// stale proposal and record provenance. It computes NUMBERS; it writes nothing. Same
// events → same result (deterministic, `occurred_at` then `id` order), so the identity
// fields are derived from the CANONICAL (sorted) content, never the caller's array
// order.

import { createHash } from 'node:crypto';

import { compareInventoryOperations } from './core.js';
import { INVENTORY_OPERATION_TYPES } from './constants.js';

export const COST_POLICIES = Object.freeze(['moving_average']);
export const LANDED_COST_ALLOCATION_METHODS = Object.freeze(['by_value', 'by_quantity']);
export const INVENTORY_VARIANCE_KINDS = Object.freeze(['provisional_to_actual']);
// The signed variance components a settlement/match decomposes into (§4). They are
// MUTUALLY EXCLUSIVE and sum to the total with a zero residual (D-POST-3 redline).
export const INVENTORY_VARIANCE_COMPONENTS = Object.freeze([
  'purchase_price_variance',
  'quantity_variance',
  'fx_variance',
  'landed_cost_variance',
  'tax_variance'
]);
// The economic buckets an operation effect can move (functional currency). The named
// three (§4) plus the non-GRNI/COGS counterparties the fold can produce.
export const INVENTORY_EFFECT_BUCKETS = Object.freeze([
  'inventory',
  'grni',
  'cogs_or_variance',
  'opening_balance_equity',
  'owner_appropriation'
]);
export const VALUATION_REFUSAL_REASONS = Object.freeze([
  'invalid_command',
  'unsupported_cost_policy',
  'invalid_money',
  'invalid_quantity',
  'missing_cost_basis',
  'mixed_currency_no_rate',
  'missing_fx_rate',
  'unbalanced_effect',
  'negative_running_value',
  'unknown_reversal_target',
  'invalid_reversal',
  'invalid_allocation_method',
  'allocation_requires_lines',
  'unsupported_operation_type'
]);

// The versioned posting contract (§4/§20 P1A). A code-level bump to the fold OR the
// contract shape moves these; the posting layer records them on every receipt so a
// silently-changed contract is a visible receipt diff (the model-id-is-part-of-the-
// receipt rail, applied to deterministic math).
export const VALUATION_CONTRACT_VERSION = 'valuation-posting/1';
export const VALUATION_KERNEL_VERSION = 'i4-valuation/3';
export const VALUATION_ORDERING_BASIS = 'occurred_at,id';

const opTypes = new Set(INVENTORY_OPERATION_TYPES);
const policySet = new Set(COST_POLICIES);
const allocationSet = new Set(LANDED_COST_ALLOCATION_METHODS);
const refusalSet = new Set(VALUATION_REFUSAL_REASONS);
const isoCurrency = /^[A-Z]{3}$/;
const EPSILON = 0.000001;
const MONEY_TOLERANCE = 0.01;

export const decimal = (value, field = 'amount', places = 6) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw Object.assign(new Error(`${field} must be numeric`), { reason: field.includes('quantity') || field === 'qty' ? 'invalid_quantity' : 'invalid_money' });
  const factor = 10 ** places;
  return Math.round((n + Number.EPSILON) * factor) / factor;
};

export const money = (value) => decimal(value, 'money', 2);
export const refusal = (reason, detail = {}) => ({ applied: false, reason: refusalSet.has(reason) ? reason : 'invalid_command', detail });
export const applied = (receipt) => ({ applied: true, receipt: Object.freeze(receipt) });

const validateCurrency = (currency) => {
  const c = String(currency || '');
  if (!isoCurrency.test(c)) throw Object.assign(new Error('ISO currency required'), { reason: 'invalid_money' });
  return c;
};

const qtyOf = (row) => decimal(row?.qty ?? row?.quantity ?? 0, 'quantity');
const costAmountOf = (row) => row?.unitCost?.amount ?? row?.unit_cost_amount ?? row?.unitCostAmount;
const costCurrencyOf = (row) => row?.unitCost?.currency ?? row?.unit_cost_currency ?? row?.unitCostCurrency;
const hasCost = (row) => costAmountOf(row) !== undefined && costAmountOf(row) !== null && costCurrencyOf(row) !== undefined && costCurrencyOf(row) !== null;
const opId = (row) => row?.id ?? row?.operationId;
const occurredAtOf = (row) => { const value = row?.occurred_at || row?.occurredAt || row?.created_at || null; return value instanceof Date ? value.toISOString() : value; };
const sortOperations = (ops) => [...ops].sort(compareInventoryOperations);

const validateUnitCost = (op, expectedCurrency = null) => {
  const amount = decimal(costAmountOf(op), 'unit_cost');
  if (amount < 0) throw Object.assign(new Error('unit cost must be non-negative'), { reason: 'invalid_money' });
  const currency = validateCurrency(costCurrencyOf(op));
  if (expectedCurrency && currency !== expectedCurrency) throw Object.assign(new Error('mixed currency without rate'), { reason: 'mixed_currency_no_rate' });
  return { amount, currency };
};

const inventoryValue = (qty, avg) => decimal(decimal(qty, 'quantity') * decimal(avg, 'average'), 'inventory_value');

// ─── P1A helpers: identity hashing, FX facts, per-operation posting effects ────────

// Deterministic content hash — key-sorted so object key order never changes the
// digest, and fed the CANONICAL (sorted) operation stream so a caller's array order
// never changes the identity (the replay invariant). node:crypto's createHash is pure
// (same input → same digest); it introduces no time/randomness.
const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
};
const contentHash = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');

const opForHash = (op) => ({
  id: String(opId(op) ?? ''),
  type: op.operation_type || op.operationType || null,
  qty: qtyOf(op),
  unit_cost_amount: costAmountOf(op) ?? null,
  unit_cost_currency: costCurrencyOf(op) ?? null,
  occurred_at: occurredAtOf(op),
  reverses: op.reverses_operation_id ?? op.reversesOperationId ?? null,
  provisional: !!(op.provisional_cost ?? op.provisionalCost)
});

const fxFactForHash = (rate) => ({
  from: rate?.from ?? rate?.source ?? rate?.currency ?? null,
  to: rate?.to ?? rate?.functional ?? null,
  date: rate?.date ?? null,
  rate: Number(rate?.rate),
  fx_fact_id: rate?.fx_fact_id ?? rate?.fxFactId ?? null
});

// Resolve a caller-supplied FX fact for source→functional at a date. The kernel NEVER
// fetches or guesses a rate (§10): the table comes in as an argument. A date-exact
// fact wins; a dateless flat rate is the fallback. Absent ⇒ null (the caller refuses).
const resolveFxRate = ({ fxRates, from, to, date }) => {
  if (!Array.isArray(fxRates)) return null;
  const cands = fxRates
    .map(fxFactForHash)
    .filter((r) => r.from === from && r.to === to && Number.isFinite(r.rate) && r.rate > 0);
  if (!cands.length) return null;
  const exact = cands.find((r) => r.date && String(r.date) === String(date));
  const pick = exact || cands.find((r) => !r.date) || cands[0];
  return { rate: pick.rate, fxFactId: pick.fx_fact_id };
};

const datesOf = (op) => ({
  economic_date: occurredAtOf(op),
  accounting_date: op.accounting_date ?? op.accountingDate ?? null,
  tax_date: op.tax_date ?? op.taxDate ?? null,
  document_date: op.document_date ?? op.documentDate ?? null,
  accounting_date_basis: 'operation.occurred_at'
});

// Build the signed, balanced posting effect for one operation. `functionalValue` is the
// (positive) functional-currency magnitude the operation moves; effectType fixes the
// direction of each bucket. The explicit legs are asserted to balance (Σdebit==Σcredit)
// — a kernel that cannot emit a balanced effect refuses `unbalanced_effect` rather than
// hand the posting layer a bad number.
const buildPostingEffect = ({ op, effectType, functionalValue, functionalCurrency, source, dates }) => {
  const V = money(Math.abs(functionalValue));
  let amountToInventory = 0;
  let amountToGrni = 0;
  let amountToCogsOrVariance = 0;
  let counterparty = null;

  if (effectType === 'receipt') { amountToInventory = V; amountToGrni = V; }
  else if (effectType === 'opening_balance') { amountToInventory = V; counterparty = { bucket: 'opening_balance_equity', direction: 'credit', amount: V }; }
  else if (effectType === 'shipment') { amountToInventory = -V; amountToCogsOrVariance = V; }
  else if (effectType === 'owner_private_use') { amountToInventory = -V; counterparty = { bucket: 'owner_appropriation', direction: 'debit', amount: V }; }
  else if (effectType === 'found_stock') { amountToInventory = V; amountToCogsOrVariance = -V; }
  else if (effectType === 'shrinkage') { amountToInventory = -V; amountToCogsOrVariance = V; }

  const legs = [];
  // inventory + cogs are DEBIT-normal (positive signed ⇒ debit); grni is CREDIT-normal
  // (positive signed ⇒ credit).
  const pushDebitNormal = (bucket, signed) => { if (signed !== 0) legs.push({ bucket, direction: signed > 0 ? 'debit' : 'credit', amount: money(Math.abs(signed)) }); };
  const pushCreditNormal = (bucket, signed) => { if (signed !== 0) legs.push({ bucket, direction: signed > 0 ? 'credit' : 'debit', amount: money(Math.abs(signed)) }); };
  pushDebitNormal('inventory', amountToInventory);
  pushCreditNormal('grni', amountToGrni);
  pushDebitNormal('cogs_or_variance', amountToCogsOrVariance);
  if (counterparty) legs.push({ ...counterparty });

  const debitTotal = money(legs.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0));
  const creditTotal = money(legs.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amount, 0));
  if (Math.abs(debitTotal - creditTotal) > MONEY_TOLERANCE) {
    throw Object.assign(new Error('operation effect does not balance'), { reason: 'unbalanced_effect' });
  }

  return {
    operationId: opId(op),
    effectType,
    posting: 'journal',
    functionalCurrency,
    amountToInventory: money(amountToInventory),
    amountToGrni: money(amountToGrni),
    amountToCogsOrVariance: money(amountToCogsOrVariance),
    counterparty,
    legs,
    balanced: true,
    debitTotal,
    creditTotal,
    fx: {
      sourceUnitCost: money(source.amount),
      sourceCurrency: source.currency,
      rate: source.rate,
      fxFactId: source.fxFactId,
      functionalUnitCost: money(source.functionalUnit)
    },
    dates
  };
};

// The value-neutral / reversal effects don't come from buildPostingEffect's direction
// table: neutral emits no journal, reversal negates the target's persisted-in-fold
// effect exactly (the kernel side of §5-G — the POSTING layer reverses the persisted
// LEDGER journal; here we only report the valuation-delta the reversal implies).
const neutralEffect = (op, effectType, functionalCurrency, dates) => ({
  operationId: opId(op),
  effectType,
  posting: 'no_journal_required',
  functionalCurrency,
  amountToInventory: 0,
  amountToGrni: 0,
  amountToCogsOrVariance: 0,
  counterparty: null,
  legs: [],
  balanced: true,
  debitTotal: 0,
  creditTotal: 0,
  fx: null,
  dates
});

const negatePostingEffect = (target, op, dates) => {
  const flip = (d) => (d === 'debit' ? 'credit' : 'debit');
  return {
    operationId: opId(op),
    effectType: 'reversal',
    posting: 'journal',
    functionalCurrency: target.functionalCurrency,
    amountToInventory: money(-target.amountToInventory),
    amountToGrni: money(-target.amountToGrni),
    amountToCogsOrVariance: money(-target.amountToCogsOrVariance),
    counterparty: target.counterparty ? { ...target.counterparty, direction: flip(target.counterparty.direction) } : null,
    legs: (target.legs || []).map((l) => ({ ...l, direction: flip(l.direction) })),
    balanced: true,
    debitTotal: target.creditTotal,
    creditTotal: target.debitTotal,
    fx: null,
    reverses: target.operationId,
    dates
  };
};

export const valueInventoryOperations = ({ operations = [], policy = 'moving_average', functionalCurrency = null, fxRates = null } = {}) => {
  try {
    if (!policySet.has(policy)) return refusal('unsupported_cost_policy', { policy });
    const sorted = sortOperations(operations);
    // Functional currency: the explicit arg (translate every cost into it), else the
    // first incoming op's currency establishes it lazily (native single-currency mode,
    // where a second currency without a rate still refuses `mixed_currency_no_rate`).
    let functionalCcy = functionalCurrency ? validateCurrency(functionalCurrency) : null;
    const nativeMode = !functionalCurrency;

    let qty = 0;
    let quarantinedQty = 0;
    let average = 0;
    const cogs = [];
    const valuationEffects = new Map();
    const reversedIds = new Set();
    const valueInLines = [];
    const snapshots = [];
    const operationEffects = [];

    // Translate a source cost into functional currency at its transaction-date rate.
    const toFunctional = (source, date) => {
      if (!functionalCcy) functionalCcy = source.currency;
      if (source.currency === functionalCcy) return { functionalAmount: source.amount, rate: 1, fxFactId: null };
      const hit = resolveFxRate({ fxRates, from: source.currency, to: functionalCcy, date });
      if (!hit) throw Object.assign(new Error('fx rate required'), { reason: nativeMode ? 'mixed_currency_no_rate' : 'missing_fx_rate' });
      return { functionalAmount: decimal(source.amount * hit.rate, 'value_in'), rate: hit.rate, fxFactId: hit.fxFactId };
    };

    const applyIncoming = (op, q, source, effectType, dates) => {
      const { functionalAmount: funcUnit, rate, fxFactId } = toFunctional(source, dates.economic_date);
      const before = { qty, average, value: inventoryValue(qty, average) };
      const addedValue = decimal(q * funcUnit, 'value_in');
      const newQty = decimal(qty + q, 'quantity');
      const newValue = decimal(before.value + addedValue, 'inventory_value');
      qty = newQty;
      average = newQty === 0 ? 0 : decimal(newValue / newQty, 'moving_average');
      valueInLines.push({ operationId: opId(op), qty: q, unitCost: funcUnit, amount: money(addedValue), currency: functionalCcy, effectType });
      const postingEffect = buildPostingEffect({
        op, effectType, functionalValue: addedValue, functionalCurrency: functionalCcy,
        source: { amount: source.amount, currency: source.currency, rate, fxFactId, functionalUnit: funcUnit }, dates
      });
      return { qtyDelta: q, valueDelta: addedValue, cogsLine: null, before, after: { qty, average, value: inventoryValue(qty, average) }, effectType, postingEffect };
    };

    const applyOutgoing = (op, q, effectType, dates) => {
      if (!functionalCcy || qty <= EPSILON) throw Object.assign(new Error('missing cost basis'), { reason: 'missing_cost_basis' });
      const before = { qty, average, value: inventoryValue(qty, average) };
      const cogsAmount = decimal(q * average, 'cogs');
      qty = decimal(qty - q, 'quantity');
      const afterValue = inventoryValue(qty, average);
      if (afterValue < -EPSILON) throw Object.assign(new Error('negative running value'), { reason: 'negative_running_value' });
      const line = { operationId: opId(op), qty: q, unitCostApplied: decimal(average, 'unitCostApplied'), cogsAmount: money(cogsAmount), currency: functionalCcy, policy, inputs: { operationType: op.operation_type || op.operationType, occurredAt: occurredAtOf(op) } };
      cogs.push(line);
      const postingEffect = buildPostingEffect({
        op, effectType, functionalValue: cogsAmount, functionalCurrency: functionalCcy,
        source: { amount: average, currency: functionalCcy, rate: 1, fxFactId: null, functionalUnit: average }, dates
      });
      return { qtyDelta: -q, valueDelta: -cogsAmount, cogsLine: line, before, after: { qty, average, value: afterValue }, effectType, postingEffect };
    };

    for (const op of sorted) {
      const type = op.operation_type || op.operationType;
      if (!opTypes.has(type)) return refusal('unsupported_operation_type', { operationType: type });
      const dates = datesOf(op);
      const q = Math.abs(qtyOf(op));
      let effect = { qtyDelta: 0, valueDelta: 0, cogsLine: null, before: { qty, average, value: inventoryValue(qty, average) }, after: null, effectType: 'neutral', postingEffect: neutralEffect(op, 'neutral', functionalCcy, dates) };
      if (type === 'opening_balance' || type === 'receipt') {
        const unitCost = validateUnitCost(op);
        effect = applyIncoming(op, q, unitCost, type, dates);
      } else if (type === 'shipment' || type === 'owner_private_use') {
        effect = applyOutgoing(op, q, type, dates);
      } else if (type === 'count_correction') {
        const signed = qtyOf(op);
        if (signed > 0) {
          if (!hasCost(op) && !functionalCcy) throw Object.assign(new Error('missing cost basis'), { reason: 'missing_cost_basis' });
          effect = applyIncoming(op, signed, hasCost(op) ? validateUnitCost(op) : { amount: average, currency: functionalCcy }, 'found_stock', dates);
        } else if (signed < 0) {
          effect = applyOutgoing(op, Math.abs(signed), 'shrinkage', dates);
        }
      } else if (type === 'quarantine') {
        quarantinedQty = decimal(quarantinedQty + q, 'quantity');
        effect.quarantinedDelta = q;
      } else if (type === 'release_quarantine') {
        quarantinedQty = decimal(quarantinedQty - q, 'quantity');
        effect.quarantinedDelta = -q;
      } else if (type === 'reversal') {
        const targetId = String(op.reverses_operation_id ?? op.reversesOperationId);
        if (reversedIds.has(targetId)) return refusal('invalid_reversal', { alreadyReversed: targetId });
        const target = valuationEffects.get(targetId);
        if (target?.effectType === 'reversal') return refusal('invalid_reversal');
        reversedIds.add(targetId);
        quarantinedQty = decimal(quarantinedQty - (target?.quarantinedDelta || 0), 'quantity');
        if (!target) return refusal('unknown_reversal_target', { operationId: opId(op), reverses: op.reverses_operation_id ?? op.reversesOperationId });
        const before = { qty, average, value: inventoryValue(qty, average) };
        // Moving-average reversal is exact ONLY for the most-recent value-affecting op:
        // it backs out the target's original qty/value deltas. If intervening issues
        // have since consumed that stock at a changed average, removing the deltas
        // drives qty/value negative — not a valid moving-average state, and would emit
        // a distorted average to the posting layer. Refuse typed rather than emit a bad
        // number; such a case needs an explicit correcting operation, not a late
        // reversal.
        const newQty = decimal(qty - target.qtyDelta, 'quantity');
        const newValue = decimal(before.value - target.valueDelta, 'inventory_value');
        if (newQty < -EPSILON || newValue < -EPSILON) throw Object.assign(new Error('negative running value'), { reason: 'negative_running_value' });
        qty = newQty;
        average = qty === 0 ? 0 : decimal(newValue / qty, 'moving_average');
        const postingEffect = target.postingEffect ? negatePostingEffect(target.postingEffect, op, dates) : neutralEffect(op, 'reversal', functionalCcy, dates);
        effect = { qtyDelta: -target.qtyDelta, valueDelta: -target.valueDelta, cogsLine: null, before, after: { qty, average, value: inventoryValue(qty, average) }, effectType: 'reversal', postingEffect };
      }
      effect.after = effect.after || { qty, average, value: inventoryValue(qty, average) };
      valuationEffects.set(String(opId(op)), effect);
      operationEffects.push(effect.postingEffect);
      snapshots.push({ operationId: opId(op), operationType: type, qtyOnHand: qty, quarantinedQty, movingAverage: average, inventoryValue: money(effect.after.value), currency: functionalCcy, policy });
    }

    const valueIn = money(valueInLines.reduce((s, l) => s + l.amount, 0));
    const cogsOut = money(cogs.reduce((s, l) => s + l.cogsAmount, 0));
    const endingValue = money(inventoryValue(qty, average));
    // Effect-level conservation (§16): the signed inventory movements over all effects
    // must equal the ending inventory value (inventory starts at 0) — a ZERO-residual
    // check on the numbers the posting layer will actually route, not just on the
    // kernel's own value/COGS totals.
    const inventoryFromEffects = money(operationEffects.reduce((s, e) => s + (e.amountToInventory || 0), 0));

    // Identity — derived from the CANONICAL (sorted) content so a caller's array order
    // never changes it (replay). input_hash covers ops + policy + functional currency +
    // FX facts; stream_version fingerprints the operation shape; valuation_run_id is a
    // deterministic surrogate over the input hash.
    const canonical = {
      contract: VALUATION_CONTRACT_VERSION,
      kernel: VALUATION_KERNEL_VERSION,
      policy,
      functional_currency: functionalCcy,
      ordering: VALUATION_ORDERING_BASIS,
      operations: sorted.map(opForHash),
      fx_rates: Array.isArray(fxRates) ? fxRates.map(fxFactForHash) : null
    };
    const inputHash = contentHash(canonical);
    const streamVersion = contentHash(sorted.map((o) => [String(opId(o) ?? ''), String(occurredAtOf(o) ?? ''), o.operation_type || o.operationType || ''])).slice(0, 32);
    const valuationRunId = `vrun_${inputHash.slice(0, 24)}`;

    return applied({
      contractVersion: VALUATION_CONTRACT_VERSION,
      kernelVersion: VALUATION_KERNEL_VERSION,
      orderingBasis: VALUATION_ORDERING_BASIS,
      valuationRunId,
      streamVersion,
      inputHash,
      policy,
      rounding: 'running quantities/averages at 6 decimals; reported money at 2 decimals',
      currency: functionalCcy,
      functionalCurrency: functionalCcy,
      qtyOnHand: decimal(qty, 'quantity'),
      quarantinedQty,
      movingAverage: average,
      inventoryValue: endingValue,
      cogs,
      valueIn: valueInLines,
      conservation: { valueIn, cogsOut, endingValue, delta: money(valueIn - cogsOut - endingValue), tolerance: MONEY_TOLERANCE },
      effectConservation: { inventoryFromEffects, endingValue, delta: money(inventoryFromEffects - endingValue), tolerance: MONEY_TOLERANCE },
      operationEffects,
      snapshots
    });
  } catch (e) {
    return refusal(e.reason || 'invalid_command', { message: e.message });
  }
};

export const allocateLandedCost = ({ pool, lines = [], method = 'by_value' } = {}) => {
  try {
    if (!allocationSet.has(method)) return refusal('invalid_allocation_method', { method });
    if (!Array.isArray(lines) || lines.length === 0) return refusal('allocation_requires_lines');
    const currency = validateCurrency(pool?.currency);
    const poolAmount = money(pool?.amount);
    const bases = lines.map((line) => {
      const quantity = qtyOf(line);
      const unit = validateUnitCost(line, currency);
      return { lineId: line.id ?? line.lineId, quantity, lineValue: money(quantity * unit.amount), unitCost: unit.amount };
    });
    const totalBase = bases.reduce((s, l) => s + (method === 'by_value' ? l.lineValue : l.quantity), 0);
    if (totalBase <= 0) return refusal('invalid_quantity', { totalBase });
    let allocatedSoFar = 0;
    const largest = [...bases].sort((a, b) => (method === 'by_value' ? b.lineValue - a.lineValue : b.quantity - a.quantity) || String(a.lineId).localeCompare(String(b.lineId)))[0].lineId;
    const allocations = bases.map((line) => {
      const base = method === 'by_value' ? line.lineValue : line.quantity;
      const allocated = money(poolAmount * (base / totalBase));
      allocatedSoFar = money(allocatedSoFar + allocated);
      return { ...line, allocatedAmount: allocated };
    });
    const remainder = money(poolAmount - allocatedSoFar);
    const final = allocations.map((line) => {
      const allocatedAmount = line.lineId === largest ? money(line.allocatedAmount + remainder) : line.allocatedAmount;
      return {
        lineId: line.lineId,
        allocatedAmount,
        currency,
        // The allocated uplift IS a landed-cost variance component (§4) — labelled so
        // the posting layer routes it to that bucket, not blended into price variance.
        varianceComponent: 'landed_cost_variance',
        unitCostUplift: line.quantity === 0 ? 0 : decimal(allocatedAmount / line.quantity, 'unitCostUplift'),
        inputs: { method, poolAmount, base: method === 'by_value' ? line.lineValue : line.quantity }
      };
    });
    return applied({ method, pool: { amount: poolAmount, currency }, allocations: final, exhaustive: { allocatedTotal: money(final.reduce((s, l) => s + l.allocatedAmount, 0)), poolAmount, delta: money(final.reduce((s, l) => s + l.allocatedAmount, 0) - poolAmount) } });
  } catch (e) {
    return refusal(e.reason || 'invalid_command', { message: e.message });
  }
};

export const settleProvisionalCost = ({ receipt, actualUnitCost, currentQtyOnHand, currentAverage, functionalCurrency = null, provisionalFxRate = null, actualFxRate = null } = {}) => {
  try {
    if (!receipt?.provisional_cost && !receipt?.provisionalCost) return refusal('invalid_command', { provisionalCost: 'required' });
    const provisional = validateUnitCost(receipt);
    const actual = { amount: decimal(actualUnitCost?.amount ?? actualUnitCost, 'actualUnitCost'), currency: validateCurrency(actualUnitCost?.currency ?? provisional.currency) };
    if (actual.currency !== provisional.currency) return refusal('mixed_currency_no_rate', { provisional: provisional.currency, actual: actual.currency });
    const qty = qtyOf(receipt);

    // FX facts (§10). When functional rates are supplied the total variance decomposes
    // into a price component (valued at the ORIGINAL rate) and an fx component (the rate
    // change on the NEW price) — mutually exclusive, summing to the total with a zero
    // residual (D-POST-3). Without rates both rates are 1 and the whole variance is
    // price (source currency == functional).
    const provRate = provisionalFxRate != null ? decimal(provisionalFxRate, 'fx_rate') : 1;
    const actRate = actualFxRate != null ? decimal(actualFxRate, 'fx_rate') : 1;
    const functionalCcy = functionalCurrency ? validateCurrency(functionalCurrency) : provisional.currency;

    const variance = money((actual.amount * actRate - provisional.amount * provRate) * qty);
    const purchasePriceVariance = money((actual.amount - provisional.amount) * provRate * qty);
    const fxVariance = money(actual.amount * (actRate - provRate) * qty);
    const components = {
      purchase_price_variance: purchasePriceVariance,
      quantity_variance: 0,
      fx_variance: fxVariance,
      landed_cost_variance: 0,
      tax_variance: 0
    };
    const componentsResidual = money(variance - Object.values(components).reduce((s, v) => s + v, 0));
    if (Math.abs(componentsResidual) > MONEY_TOLERANCE) {
      throw Object.assign(new Error('variance components do not sum to the total'), { reason: 'unbalanced_effect' });
    }

    const onHand = decimal(currentQtyOnHand ?? qty, 'quantity');
    const avg = decimal(currentAverage ?? provisional.amount, 'moving_average');
    const revisedAverage = onHand === 0 ? 0 : decimal((inventoryValue(onHand, avg) + variance) / onHand, 'moving_average');
    return applied({
      kind: 'provisional_to_actual',
      variance,
      components,
      componentsResidual,
      currency: functionalCcy,
      revisedAverage,
      affectedFrom: opId(receipt),
      inputs: { receiptId: opId(receipt), qty, provisionalUnitCost: provisional.amount, actualUnitCost: actual.amount, provisionalFxRate: provRate, actualFxRate: actRate, currentQtyOnHand: onHand, currentAverage: avg }
    });
  } catch (e) {
    return refusal(e.reason || 'invalid_command', { message: e.message });
  }
};

export default Object.freeze({
  valueInventoryOperations,
  allocateLandedCost,
  settleProvisionalCost,
  COST_POLICIES,
  LANDED_COST_ALLOCATION_METHODS,
  INVENTORY_VARIANCE_KINDS,
  INVENTORY_VARIANCE_COMPONENTS,
  INVENTORY_EFFECT_BUCKETS,
  VALUATION_REFUSAL_REASONS,
  VALUATION_CONTRACT_VERSION,
  VALUATION_KERNEL_VERSION,
  VALUATION_ORDERING_BASIS
});
