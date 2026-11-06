// Donna Inventory I4·posting — P6 reconciliation, the READ-ONLY DB gatherer (design §16).
//
// The pure §16 engines live in reconciliationEngines.js; this module is their read-side
// shell: it gathers the PERSISTED ledger + posting-log + allowance-register state, assembles
// the pure-engine input, runs the engines, and returns the combined verdict. It is strictly
// READ-ONLY — no INSERT/UPDATE/DELETE, no ledger write, no posting. A reconciliation
// adjustment that must POST (an FX retranslation journal, an allowance-release journal) routes
// through the P5 gateway/executor (post_inventory_journal) in a later slice — never here,
// never a new writer (INV-1).
//
// Current callers supply the whole-client kernel receipt. Historical reads instead own
// their operation cutoff and reuse valueInventoryOperations per item/location. A calendar
// cutoff is inclusive for journal DATEs and ends at the next UTC midnight for operations.
// Original posted journals remain included after reversal: the separately dated reversal
// is the compensating entry, not permission to erase the original from earlier books.

import {
  runInventoryReconciliation,
  RECONCILIATION_MONEY_TOLERANCE
} from './reconciliationEngines.js';
import { valueInventoryOperations } from './valuation.js';
import { toUtcIsoDay } from '../dates.js';

// The canonical roles the reconciliation reads. Kept explicit (not a wildcard) so a new role
// is a deliberate addition, never a silent inclusion.
const INVENTORY_ROLE = 'asset.inventory';
const GRNI_ROLE = 'liability.grni';
const ALLOWANCE_ROLE = 'contra_asset.inventory_valuation_allowance';
const COGS_ROLE = 'expense.cost_of_sales';
const COGS_ADJ_ROLE = 'expense.cost_of_sales_adjustment';
const WRITE_DOWN_ROLE = 'expense.inventory_write_down';
const COUNT_VARIANCE_ROLE = 'pnl.inventory_count_variance';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

const isMissingRelation = (error) => error?.code === '42P01' || error?.code === '42703';

// Catalog admission keeps absent relations/columns from aborting a caller-owned transaction.
// The actual facts below are gathered in ONE SQL statement (one MVCC snapshot), including
// the historical operations. No transaction control, locks or writes belong to this reader.
const requiredColumns = {
  clients: ['id', 'firm_id'],
  ledger_lines: ['journal_id', 'account_id', 'firm_id', 'client_id', 'debit', 'credit', 'currency'],
  ledger_journals: ['id', 'firm_id', 'client_id', 'status', 'journal_date', 'source_type', 'reversal_of_journal_id'],
  ledger_accounts: ['id', 'firm_id', 'client_id', 'canonical_role'],
  inventory_posting_journals: ['posting_attempt_id', 'ledger_journal_id', 'firm_id', 'client_id'],
  inventory_posting_attempts: ['id', 'firm_id', 'client_id', 'posting_kind', 'outcome', 'operation_id'],
  inventory_valuation_allowances: ['id', 'firm_id', 'client_id', 'scope_item_id', 'scope_group',
    'allowance_amount', 'consumed_amount', 'max_reversible_amount', 'status', 'currency', 'valuation_run_id']
};
const historicalColumns = {
  inventory_operations: ['id', 'firm_id', 'client_id', 'item_id', 'location_id', 'uom_id',
    'operation_type', 'quantity', 'occurred_at', 'unit_cost_amount', 'unit_cost_currency', 'provisional_cost', 'reverses_operation_id'],
  inventory_items: ['id', 'firm_id', 'client_id', 'base_uom_id'],
  inventory_locations: ['id', 'firm_id', 'client_id'],
  inventory_units_of_measure: ['id', 'firm_id', 'client_id']
};
const validateCutoff = (cutoff) => {
  if (typeof cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || cutoff.startsWith('0000')) return false;
  return toUtcIsoDay(cutoff) === cutoff;
};
const unavailable = (reason, detail = {}) => ({ availability: { status: 'unavailable', reason, ...detail } });
const readSources = async (client, firmId, clientId, roles, cutoff) => {
  const columns = { ...requiredColumns, ...(cutoff ? historicalColumns : {}) };
  const required = Object.entries(columns).flatMap(([table, names]) => names.map(column => ({ table, column })));
  const missing = await client.query(`select r.table_name, r.column_name
    from jsonb_to_recordset($1::jsonb) as r(table_name text, column_name text)
    where not exists (select 1 from information_schema.columns c
      where c.table_schema='public' and c.table_name=r.table_name and c.column_name=r.column_name)`,
  [JSON.stringify(required.map(r => ({ table_name: r.table, column_name: r.column })))]);
  if (missing.rows.length) return unavailable('reconciliation_schema_unavailable', { missing: missing.rows });
  const sourceSql = `with lines as (
    select ll.*, la.canonical_role as role, lj.status as journal_status, lj.journal_date,
      (la.id is not null and lj.id is not null) as scoped
    from ledger_lines ll
    left join ledger_accounts la on la.id=ll.account_id and la.firm_id=ll.firm_id and la.client_id=ll.client_id
    left join ledger_journals lj on lj.id=ll.journal_id and lj.firm_id=ll.firm_id and lj.client_id=ll.client_id
    where ll.firm_id=$1 and ll.client_id=$2
  ), applicable as (
    select * from lines where scoped and journal_status in ('posted','closed') and ($4::date is null or journal_date <= $4::date)
  ), links as (
    select ipj.*, ipa.posting_kind, ipa.outcome, ipa.operation_id, lj.reversal_of_journal_id, lj.status as journal_status, lj.journal_date,
      (ipa.id is not null and lj.id is not null) as scoped
    from inventory_posting_journals ipj
    left join inventory_posting_attempts ipa on ipa.id=ipj.posting_attempt_id and ipa.firm_id=ipj.firm_id and ipa.client_id=ipj.client_id
    left join ledger_journals lj on lj.id=ipj.ledger_journal_id and lj.firm_id=ipj.firm_id and lj.client_id=ipj.client_id
    where ipj.firm_id=$1 and ipj.client_id=$2
  )
  select exists(select 1 from clients where firm_id=$1 and id=$2) as scope_exists,
    (select count(*) from lines where not scoped or (journal_status in ('posted','closed') and journal_date is null)) +
    (select count(*) from ledger_journals j where j.firm_id=$1 and j.client_id=$2 and j.status in ('posted','closed')
      and ($4::date is null or j.journal_date <= $4::date) and not exists(select 1 from applicable l where l.journal_id=j.id)) +
    (select count(*) from ledger_journals j where j.firm_id=$1 and j.client_id=$2 and j.status in ('posted','closed')
      and j.source_type='inventory_posting' and ($4::date is null or j.journal_date <= $4::date)
      and not exists(select 1 from links p where p.ledger_journal_id=j.id and p.scoped and p.outcome='posted')) +
    (select count(*) from links where not scoped or (journal_status in ('posted','closed') and
      (outcome <> 'posted' or journal_date is null or not exists(select 1 from applicable l where l.journal_id=links.ledger_journal_id)
       and ($4::date is null or journal_date <= $4::date)))) as invalid_sources,
    coalesce((select jsonb_agg(g) from (select role, sum(debit) as debit, sum(credit) as credit
      from applicable where role=any($3::text[]) group by role) g), '[]') as gl,
    coalesce((select jsonb_agg(g) from (select currency, sum(credit)-sum(debit) as balance
      from applicable where role='liability.grni' group by currency) g), '[]') as grni_balances,
    coalesce((select jsonb_agg(m) from (select p.posting_kind, l.role, l.currency, sum(l.debit) as debit, sum(l.credit) as credit
      from links p join applicable l on l.journal_id=p.ledger_journal_id
      where p.scoped and p.outcome='posted' group by p.posting_kind,l.role,l.currency) m), '[]') as movements,
    coalesce((select jsonb_agg(d) from (select p.operation_id,p.posting_kind,p.ledger_journal_id,p.reversal_of_journal_id,l.currency,
      sum(case when l.role='asset.inventory' then l.debit-l.credit else 0 end) as inventory,
      sum(case when l.role in ('expense.cost_of_sales','expense.cost_of_sales_adjustment','pnl.inventory_count_variance') then l.debit-l.credit else 0 end) as cogs,
      sum(case when l.role='liability.grni' then l.credit-l.debit else 0 end) as grni
      from links p join applicable l on l.journal_id=p.ledger_journal_id
      where p.scoped and p.outcome='posted'
      group by p.operation_id,p.posting_kind,p.ledger_journal_id,p.reversal_of_journal_id,l.currency) d), '[]') as posting_dispositions,
    coalesce((select jsonb_agg(a) from (select id, scope_item_id, scope_group, allowance_amount, consumed_amount,
      max_reversible_amount, status, currency, valuation_run_id from inventory_valuation_allowances
      where firm_id=$1 and client_id=$2) a), '[]') as allowance_lots,
    coalesce((select jsonb_agg(distinct currency) from applicable where role=any($3::text[]) and (debit <> 0 or credit <> 0)), '[]') as currencies,
    exists(select 1 from applicable where role in ('expense.cost_of_sales','expense.cost_of_sales_adjustment')
      and (debit <> 0 or credit <> 0)) as cogs_present,
    coalesce((select jsonb_agg(p.operation_id) from (select ipa.operation_id from links l
      join inventory_posting_attempts ipa on ipa.id=l.posting_attempt_id
      where l.scoped and l.outcome='posted' and l.journal_status in ('posted','closed')
        and ($4::date is null or l.journal_date <= $4::date)
        and l.posting_kind in ('receipt','shipment_cogs','count_adjustment','private_use')) p), '[]') as stock_operation_ids`;
  const historicalSql = sourceSql + `, coalesce((select jsonb_agg(to_jsonb(o) || jsonb_build_object('id',o.id::text,'reverses_operation_id',o.reverses_operation_id::text,
        'occurred_at',to_char(o.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by o.occurred_at,o.id) from inventory_operations o
      where o.firm_id=$1 and o.client_id=$2 and o.occurred_at < (($4::date + 1)::timestamp at time zone 'UTC')), '[]') as operations,
      (select count(*) from inventory_operations o
        left join inventory_items i on i.id=o.item_id and i.firm_id=o.firm_id and i.client_id=o.client_id
        left join inventory_locations l on l.id=o.location_id and l.firm_id=o.firm_id and l.client_id=o.client_id
        left join inventory_units_of_measure u on u.id=o.uom_id and u.firm_id=o.firm_id and u.client_id=o.client_id
        where o.firm_id=$1 and o.client_id=$2 and o.occurred_at < (($4::date + 1)::timestamp at time zone 'UTC')
          and (i.id is null or l.id is null or u.id is null or o.uom_id <> i.base_uom_id)) as invalid_operations`;
  const result = await client.query(cutoff ? historicalSql : sourceSql,
  [firmId, clientId, roles, cutoff]);
  const row = result.rows[0];
  if (!row?.scope_exists) return unavailable('reconciliation_scope_unavailable');
  if (num(row.invalid_sources) || num(row.invalid_operations)) return unavailable('reconciliation_source_scope_invalid');
  const glByRole = Object.fromEntries(row.gl.map(r => [r.role, { debit: num(r.debit), credit: num(r.credit), net: money(num(r.debit) - num(r.credit)) }]));
  const movements = row.movements.map(r => ({ ...r, currency: String(r.currency || '').toUpperCase(), debit: num(r.debit), credit: num(r.credit), net: money(num(r.debit) - num(r.credit)) }));
  return { glByRole, movements, allowanceLots: row.allowance_lots, operations: row.operations, currencies: row.currencies, cogsPresent: row.cogs_present, grniBalances: row.grni_balances, stockOperationIds: row.stock_operation_ids, postingDispositions: row.posting_dispositions || [] };
};

// Aggregate kernel receipts, not a second costing algorithm. Native single-currency
// streams are supported here; mixed currencies/missing costs remain unavailable.
const valueCutoffSources = (operations) => {
  const groups = new Map();
  for (const op of operations) {
    const key = JSON.stringify([op.item_id, op.location_id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(op);
  }
  const receipts = [], onHandByScope = {};
  for (const ops of groups.values()) {
    const valued = valueInventoryOperations({ operations: ops });
    if (!valued.applied) return unavailable('cutoff_valuation_unavailable', { valuationReason: valued.reason });
    const receipt = valued.receipt;
    receipts.push({ itemId: ops[0].item_id, locationId: ops[0].location_id, ...receipt });
    const key = `item:${ops[0].item_id}`, prior = onHandByScope[key] || { qty: 0, value: 0 };
    onHandByScope[key] = { qty: prior.qty + receipt.qtyOnHand, value: money(prior.value + receipt.inventoryValue) };
  }
  const currencies = new Set(receipts.map(r => r.currency).filter(Boolean));
  if (currencies.size > 1) return unavailable('cutoff_valuation_currency_unavailable');
  return { subledger: { inventoryValue: money(receipts.reduce((sum, r) => sum + r.inventoryValue, 0)),
    currency: [...currencies][0] || null, operationEffects: receipts.flatMap(r => r.operationEffects) },
  onHandByScope, receipts };
};

// A zero aggregate cannot prove that each monetary movement was accounted for.
// Primary drafts use kernel operation IDs; the existing reversal owner instead
// keys its attempt by the original journal and stamps reversal_of_journal_id.
// Follow that recorded lineage and compare each effect's buckets separately.
const cutoffPostingCompleteness = (effects, dispositions) => {
  const kinds = { receipt: 'receipt', shipment: 'shipment_cogs', shrinkage: 'count_adjustment',
    found_stock: 'count_adjustment', owner_private_use: 'private_use' };
  const monetary = effect => (effect.legs || []).some(leg => num(leg.amount) !== 0);
  const primary = effect => dispositions.filter(d => String(d.operation_id) === String(effect.operationId)
    && kinds[effect.effectType] && d.posting_kind === kinds[effect.effectType] && !d.reversal_of_journal_id);
  const byId = new Map(effects.map(effect => [String(effect.operationId), effect]));
  const missing = [];
  for (const effect of effects) {
    let rows = primary(effect);
    if (effect.effectType === 'reversal') {
      const target = byId.get(String(effect.reverses));
      const original = target ? primary(target) : [];
      const journalIds = new Set(original.map(d => d.ledger_journal_id));
      rows = dispositions.filter(d => d.posting_kind === 'reversal'
        && journalIds.has(d.operation_id) && d.reversal_of_journal_id === d.operation_id);
      if (!journalIds.size || [...journalIds].some(id => !rows.some(d => d.reversal_of_journal_id === id))) rows = [];
    }
    // A proven free/neutral effect needs no monetary journal. If linked
    // journals exist, their amounts must still agree with the zero effect.
    if (!monetary(effect) && !rows.length) continue;
    const sum = bucket => money(rows.reduce((total, row) => total + num(row[bucket]), 0));
    if (!rows.length || rows.some(row => row.currency !== effect.functionalCurrency)
      || Math.abs(sum('inventory') - effect.amountToInventory) > RECONCILIATION_MONEY_TOLERANCE
      || Math.abs(sum('cogs') - effect.amountToCogsOrVariance) > RECONCILIATION_MONEY_TOLERANCE
      || Math.abs(sum('grni') - effect.amountToGrni) > RECONCILIATION_MONEY_TOLERANCE) {
      missing.push(String(effect.operationId));
    }
  }
  return { status: missing.length ? 'unavailable' : 'complete', unsupportedOperationIds: missing };
};

// Assemble the inventory_to_gl + conservation ledger sums from the movement rows + GL balances.
const buildInventoryToGl = ({ glByRole, subledger, allowanceLots }) => {
  const glInventoryGross = num(glByRole[INVENTORY_ROLE]?.net);       // debit-normal → positive
  const glAllowance = money(-num(glByRole[ALLOWANCE_ROLE]?.net));    // credit-normal → flip to positive magnitude
  const subledgerValue = num(subledger?.inventoryValue);
  const registerAllowance = money(
    allowanceLots.filter((l) => l.status === 'active').reduce((s, l) => s + (l.allowance_amount - l.consumed_amount), 0)
  );
  return { glInventoryGross, glAllowance, subledgerValue, registerAllowance };
};

// The GRNI engine input: per currency, GL GRNI balance vs accrued (receipt credits) − matched
// (bill-clearing debits). Accrued = receipt/customer_return/count/... postings that CREDIT
// GRNI; matched = matched_supplier_bill / supplier_return postings that DEBIT GRNI.
const buildGrni = ({ movements, grniBalances, subledger, closeRates }) => {
  const byCurrency = new Map();
  const ensure = (ccy) => {
    if (!byCurrency.has(ccy)) byCurrency.set(ccy, { currency: ccy, glGrni: 0, accruedReceipts: 0, matchedAllocations: 0 });
    return byCurrency.get(ccy);
  };
  for (const balance of grniBalances) ensure(String(balance.currency || '').toUpperCase()).glGrni = money(balance.balance);
  for (const m of movements) {
    if (m.role !== GRNI_ROLE) continue;
    const row = ensure(m.currency);
    row.accruedReceipts = money(row.accruedReceipts + m.credit);
    row.matchedAllocations = money(row.matchedAllocations + m.debit);
  }
  const functionalCurrency = subledger?.functionalCurrency ?? subledger?.currency ?? null;
  const rows = [...byCurrency.values()].map((r) => {
    const close = closeRates?.[r.currency] ?? null;
    return close && typeof close === 'object'
      ? { ...r, closeRate: close.closeRate ?? close.rate ?? null, bookedRate: close.bookedRate ?? null, sourceOpenAmount: close.sourceOpenAmount ?? null }
      : r;
  });
  return { byCurrency: rows, functionalCurrency };
};

// Conservation: ledger per-bucket nets (inventory-posting journals only) vs the kernel's
// conserved effect totals, the kernel's own conservation delta, and the §4 variance split.
const buildConservation = ({ movements, subledger }) => {
  const ledgerBuckets = { inventory: 0, cogs: 0, grni: 0 };
  for (const m of movements) {
    if (m.role === INVENTORY_ROLE) ledgerBuckets.inventory = money(ledgerBuckets.inventory + (m.debit - m.credit));
    else if (m.role === COGS_ROLE || m.role === COGS_ADJ_ROLE || m.role === COUNT_VARIANCE_ROLE) ledgerBuckets.cogs = money(ledgerBuckets.cogs + (m.debit - m.credit));
    else if (m.role === GRNI_ROLE) ledgerBuckets.grni = money(ledgerBuckets.grni + (m.credit - m.debit));
  }
  const effects = Array.isArray(subledger?.operationEffects) ? subledger.operationEffects : [];
  const kernelBuckets = {
    inventory: money(effects.reduce((s, e) => s + num(e.amountToInventory), 0)),
    cogs: money(effects.reduce((s, e) => s + num(e.amountToCogsOrVariance), 0)),
    grni: money(effects.reduce((s, e) => s + num(e.amountToGrni), 0))
  };
  return {
    kernelConservation: subledger?.conservation ?? null,
    ledgerBuckets,
    kernelBuckets,
    variance: subledger?.variance ?? null
  };
};

// cutoff selects historical mode. It must be an ISO calendar date. Historical callers
// cannot supply the current subledger, allowance scope values or undated event evidence.
export const gatherInventoryReconciliationState = async ({
  client, firmId, clientId, cutoff = null, mode = null, subledger = null, onHandByScope = {}, closeRates = {},
  cogsEvents = [], revenueEvents = [], tolerance = RECONCILIATION_MONEY_TOLERANCE
} = {}) => {
  if (!client || !firmId || !clientId) throw new Error('gatherInventoryReconciliationState requires client, firmId, clientId');
  const historical = cutoff !== null || mode === 'historical';
  if (historical && !validateCutoff(cutoff)) return unavailable('invalid_reconciliation_cutoff');
  let sub = subledger?.applied === true && subledger.receipt ? subledger.receipt : subledger;
  if (!historical && (!sub || sub.applied === false || sub.inventoryValue == null ||
    !Number.isFinite(Number(sub.inventoryValue)) || !Array.isArray(sub.operationEffects))) return unavailable('subledger_basis_unavailable');
  const roles = [INVENTORY_ROLE, GRNI_ROLE, ALLOWANCE_ROLE, COGS_ROLE, COGS_ADJ_ROLE, WRITE_DOWN_ROLE, COUNT_VARIANCE_ROLE];
  let sources;
  try { sources = await readSources(client, firmId, clientId, roles, cutoff); }
  catch (error) {
    if (!isMissingRelation(error)) throw error;
    return unavailable('reconciliation_schema_unavailable');
  }
  if (sources.availability) return sources;
  const { glByRole, movements, allowanceLots } = sources;
  let basis = { mode: 'current', cutoff: null }, unavailableEngines = {};
  if (historical) {
    // These primary stock draft kinds use the kernel operation ID. Other kinds
    // (bills, allowance release, journal reversal) deliberately use business identities.
    const operationIds = new Set(sources.operations.map(op => String(op.id)));
    if (sources.stockOperationIds.some(id => !operationIds.has(String(id)))) return unavailable('cutoff_operation_basis_unavailable');
    const valued = valueCutoffSources(sources.operations);
    if (valued.availability) return valued;
    sub = valued.subledger;
    if (sources.currencies.some(currency => currency !== sub.currency)) return unavailable('cutoff_valuation_currency_unavailable');
    onHandByScope = valued.onHandByScope;
    basis = { mode: 'historical', cutoff, operationBoundary: 'next UTC midnight (exclusive)', scopes: valued.receipts.map(r => ({
      itemId: r.itemId, locationId: r.locationId, valuationRunId: r.valuationRunId, inputHash: r.inputHash, streamVersion: r.streamVersion
    })) };
    const postingCompleteness = cutoffPostingCompleteness(sub.operationEffects, sources.postingDispositions);
    basis.postingCompleteness = postingCompleteness;
    if (postingCompleteness.status !== 'complete') unavailableEngines.conservation = 'historical_posting_disposition_unavailable';
    // This register has no immutable consumption/status history. Even released lots
    // or lots created later cannot establish the historical remaining balance.
    if (allowanceLots.length || num(glByRole[ALLOWANCE_ROLE]?.net)) {
      unavailableEngines.inventory_to_gl = 'historical_allowance_history_unavailable';
      unavailableEngines.allowance_integrity = 'historical_allowance_history_unavailable';
    }
    if (sources.cogsPresent || sub.operationEffects.some(e => e.effectType === 'shipment' || num(e.amountToCogsOrVariance)) || cogsEvents.length || revenueEvents.length) {
      unavailableEngines.cogs_revenue_orphans = 'historical_revenue_basis_unavailable';
    }
    cogsEvents = []; revenueEvents = [];
    // FX close facts also lack a server-owned cutoff receipt in this slice.
    closeRates = {};
  }
  return {
    tolerance, basis, unavailableEngines,
    inventoryToGl: buildInventoryToGl({ glByRole, subledger: sub, allowanceLots: historical ? [] : allowanceLots }),
    grni: buildGrni({ movements, grniBalances: sources.grniBalances, subledger: sub, closeRates }),
    cogsRevenue: { cogsEvents, revenueEvents },
    conservation: buildConservation({ movements, subledger: sub }),
    allowance: { lots: historical ? [] : allowanceLots, glAllowance: money(-num(glByRole[ALLOWANCE_ROLE]?.net)), onHandByScope },
    _sources: { glByRole, movements, allowanceLots: historical ? [] : allowanceLots }
  };
};

export const runInventoryReconciliationFromDb = async (params = {}) => {
  const state = await gatherInventoryReconciliationState(params);
  return { verdict: runInventoryReconciliation(state), state };
};
