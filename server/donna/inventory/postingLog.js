// Donna Inventory I4·posting — P3 persistence taxonomy + pure projection helpers.
//
// The closed vocabularies the migration-080 CHECK constraints pin to (migrations.test.js
// asserts every value appears in the SQL, so the column and the runtime never drift), and
// the PURE mirror of the inventory_posting_heads VIEW so callers can project the latest-
// basis head from an in-memory attempt list without a DB round-trip (design §11).
//
// No DB, no I/O, no Date.now/Math.random/new Date. The WRITER that inserts attempts is P5
// (postingDb.js); this module only owns the vocabulary + read-projection.

// The posting kinds (design §3 granularity table + §5 event map). One kind per economic
// event class; value_neutral covers quarantine/release/internal-transfer (no journal),
// private_use is detect-and-escalate in v1 (§5-E — posts nothing, opens a review).
export const INVENTORY_POSTING_KINDS = Object.freeze([
  'receipt',
  'matched_supplier_bill',
  'landed_cost',
  'shipment_cogs',
  'customer_return',
  'supplier_return',
  'count_adjustment',
  'write_down',
  'reversal',
  'private_use',
  'value_neutral',
  // §5-F derecognition consumption (P6b): releasing a bound write-down allowance when the stock
  // it was bound to leaves inventory (sold/scrapped). Posts DR allowance / CR cost_of_sales|
  // count_variance through the P5 executor as a journal-group delta_adjustment. CHECK added in
  // migration 081 (the 080 base + 081 extension together pin this list — migrations.test.js).
  'allowance_release',
  // §10 FX retranslation (P6c): the unrealized FX movement on open foreign-currency GRNI at
  // period-end (IAS 21), posted DR/CR liability.grni vs expense.fx through the P5 executor as a
  // journal-group delta_adjustment. CHECK added in migration 082 (080∪081∪082 pin this list).
  'grni_retranslation'
]);

// The outcome of one posting attempt (design §11/§12). 'posted' and 'no_journal_required'
// are the SUCCESSFUL terminals the partial-unique index guards; the rest are non-terminal
// or failed states that coexist freely in the append-only log.
export const INVENTORY_POSTING_OUTCOMES = Object.freeze([
  'posted',
  'no_journal_required',
  'proposed',
  'refused',
  'blocked_locked_period',
  'integration_wait',
  'superseded',
  'incident'
]);

// The "successful application" outcomes — exactly one per (operation, kind, basis_version)
// is allowed (D-POST-8 redline). MUST match the partial-unique-index predicate in
// migration 080.
export const SUCCESSFUL_POSTING_OUTCOMES = Object.freeze(['posted', 'no_journal_required']);

// Waiter routing (design §12, D-POST-14). Every non-terminal attempt names the queue that
// owns it; a successful terminal has none. integration_system_retry carries an executable
// retry (retry_after + the re-tested condition); engineering_incident opens an incident.
export const INVENTORY_POSTING_WAITER_TYPES = Object.freeze([
  'owner',
  'accountant_operator',
  'integration_system_retry',
  'integration_operator',
  'engineering_incident',
  'product_compliance'
]);

// A journal's role within its posting group (design §5-G / §11). A reversal is a GROUP:
// one exact reversal + zero-or-more downstream delta adjustments.
export const INVENTORY_JOURNAL_RELATIONSHIPS = Object.freeze(['primary', 'reversal', 'delta_adjustment']);

// The allowance-lot lifecycle (design §5-F). active → reversed (capped market recovery) or
// released (consumed on derecognition, uncapped). Partial consumption stays 'active' with
// consumed_amount < allowance_amount until fully released.
export const INVENTORY_ALLOWANCE_STATUSES = Object.freeze(['active', 'released', 'reversed']);

// The appliable verb(s) the inventory EXECUTOR exposes (P5). NOT chat/drawer verbs — like
// reverse_apply they are privileged executor operations — but they are mutating accounting
// verbs, so the accounting-mutation registry inventories them (INV-1) and the registry test
// unions this into its coverage set (the map can't silently drift). Pure export so the test
// imports it without any DB dependency.
export const INVENTORY_EXECUTOR_APPLIABLE_VERBS = Object.freeze(['post_inventory_journal']);

export const isSuccessfulPostingOutcome = (outcome) => SUCCESSFUL_POSTING_OUTCOMES.includes(String(outcome || ''));

export const isInventoryPostingKind = (kind) => INVENTORY_POSTING_KINDS.includes(String(kind || ''));

// projectPostingHeads(attempts) — the PURE mirror of the inventory_posting_heads VIEW.
// Returns the latest attempt per (firm_id, client_id, operation_id, posting_kind), ordered
// newest-first by (created_at, id) — the head, since supersede chains point forward. Pure
// and deterministic; the caller supplies the attempt rows (already read from the log).
export const projectPostingHeads = (attempts = []) => {
  const rows = Array.isArray(attempts) ? attempts : [];
  const latest = new Map();
  for (const a of rows) {
    if (!a) continue;
    const key = [a.firm_id, a.client_id, a.operation_id, a.posting_kind].map((v) => String(v ?? '')).join('\x1f');
    const prior = latest.get(key);
    if (!prior || isNewerAttempt(a, prior)) latest.set(key, a);
  }
  // Deterministic output ordering (mirror the view's ORDER BY key columns then newest).
  return [...latest.values()].sort((x, y) => {
    for (const col of ['firm_id', 'client_id', 'operation_id', 'posting_kind']) {
      const cmp = String(x[col] ?? '').localeCompare(String(y[col] ?? ''));
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
};

// a is newer than b by (created_at desc, id desc) — the head-selection order.
const isNewerAttempt = (a, b) => {
  const at = String(a.created_at ?? '');
  const bt = String(b.created_at ?? '');
  if (at !== bt) return at > bt;
  return Number(a.id ?? 0) > Number(b.id ?? 0);
};
