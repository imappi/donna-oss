// Donna Inventory I4·posting — P4 pure journal builders (design §5 event map, §9).
//
// PURE (no DB, no I/O, no Date.now/Math.random/new Date, no FX conversion, no valuation
// splits). Consumes the P1A valuation kernel's output (operationEffects[] — already signed,
// balanced legs keyed by economic BUCKET, with per-effect dates + FX facts) and the
// RESOLVED role→account map (P2 capability enablement — no mint-on-post), and emits
// balanced InventoryJournalDrafts in the standard ledger builder shape with
// status:'proposed'. The executor (P5) re-fetches, preflights, and routes each draft
// through the ONE sanctioned gateway; this layer adds nothing, splits nothing, re-orders
// nothing (the kernel's ordering_basis is authoritative).
//
// What the builder DECIDES (the §5 reason/cause routing the kernel can't): which P&L role
// a generic `cogs_or_variance` bucket resolves to (sale COGS vs count variance vs an
// escalation), and which operations REFUSE or ESCALATE rather than auto-post (private use,
// unknown reason/cause, out-of-envelope ops). Every refusal is typed and names the waiter
// that owns it (§12) — nothing rests un-owned (the FIRST principle).
//
// NOT built here: the matched-supplier-bill orchestrator (§5-B — needs bill/tax/AP inputs
// and the "exactly one AP credit per bill accounting version" discipline) and the landed-
// cost builder (§5-B/§7 — needs allocation inputs); those consume settleProvisionalCost /
// allocateLandedCost and are their own builder slice. And the EXACT reversal (§5-G) is
// executor-owned (it reverses the PERSISTED journal, not a kernel rebuild) — a reversal
// effect returns the typed `reversal_requires_persisted_journal` handoff.

import { normalBalanceForRole } from '../accountRoles.js';
import { INVENTORY_POSTING_KINDS } from './postingLog.js';

// The closed issue reasons a shipment/issue carries (design §5-C) and count causes a
// count-correction carries (§5-E). The builder routes on these; an unknown value refuses.
export const INVENTORY_ISSUE_REASONS = Object.freeze([
  'sale', 'customer_return', 'sample', 'promotional', 'donation',
  'damage', 'waste', 'production_consumption', 'internal_transfer'
]);
export const INVENTORY_COUNT_CAUSES = Object.freeze([
  'shrinkage', 'reversal_of_shrinkage', 'unrecorded_receipt',
  'customer_return', 'opening_balance_error', 'transfer_error'
]);

// The typed, closed builder refusals (design §9, extended for the §5 routing + the §5-G
// executor handoff). reason → waiter routing (§12) lives in WAITER_FOR_REFUSAL below.
export const INVENTORY_POSTING_REFUSALS = Object.freeze([
  'unmapped_account',
  'unknown_issue_reason',
  'unknown_count_cause',
  'unsupported_operation',
  'missing_valuation_basis',
  'stale_valuation_run',
  'private_use_requires_review',
  'negative_stock_unsupported',
  'reversal_requires_persisted_journal',
  'unsupported_release_reason',
  'missing_close_fx_rate'
]);

// Which queue owns each refusal (design §12). A missing business fact (what was this issue /
// count?) is the OWNER's to answer; a policy/config judgment is the accountant/operator's;
// an out-of-envelope operation is a product/compliance gate decision; a stale run retries.
const WAITER_FOR_REFUSAL = Object.freeze({
  unmapped_account: 'accountant_operator',
  unknown_issue_reason: 'owner',
  unknown_count_cause: 'owner',
  unsupported_operation: 'product_compliance',
  missing_valuation_basis: 'accountant_operator',
  stale_valuation_run: 'integration_system_retry',
  private_use_requires_review: 'accountant_operator',
  negative_stock_unsupported: 'accountant_operator',
  reversal_requires_persisted_journal: null, // executor-owned, not a human queue
  unsupported_release_reason: 'accountant_operator',
  missing_close_fx_rate: 'integration_system_retry' // §10 — a bounded FX-fact wait, never a guessed rate
});

// The static bucket→role map. `cogs_or_variance` is resolved DYNAMICALLY (effect type +
// reason/cause) below; opening_balance_equity/owner_appropriation have no v1 role (their
// effects refuse/escalate before a leg is ever resolved).
const STATIC_BUCKET_ROLE = Object.freeze({
  inventory: 'asset.inventory',
  grni: 'liability.grni'
});

const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const refuse = (operationId, postingKind, reason, detail = {}) => ({
  applied: false,
  operation_id: operationId ?? null,
  posting_kind: postingKind ?? null,
  reason,
  waiter_type: Object.prototype.hasOwnProperty.call(WAITER_FOR_REFUSAL, reason) ? WAITER_FOR_REFUSAL[reason] : 'accountant_operator',
  detail
});

// Resolve the P&L role a `cogs_or_variance` leg routes to, from the effect type + the
// operation's issue_reason / count_cause (design §5-C / §5-E). Returns { role } or
// { refusal:{reason,detail} }.
const resolveCogsRole = ({ effectType, context }) => {
  if (effectType === 'shipment') {
    const reason = context.issue_reason;
    if (!reason) return { refusal: { reason: 'unknown_issue_reason', detail: { effectType } } };
    if (!INVENTORY_ISSUE_REASONS.includes(reason)) return { refusal: { reason: 'unknown_issue_reason', detail: { issue_reason: reason } } };
    switch (reason) {
      case 'sale':
        return { role: 'expense.cost_of_sales' };
      case 'damage':
      case 'waste':
        // Shrinkage-style relief (§5-C) → the neutral count-variance line.
        return { role: 'pnl.inventory_count_variance' };
      case 'sample':
      case 'promotional':
      case 'donation':
        // Policy-pack mapping if certified, else escalate (§5-C). v1 has no certified pack.
        return { refusal: { reason: 'unsupported_operation', detail: { issue_reason: reason, needs: 'policy_pack' } } };
      case 'production_consumption':
        return { refusal: { reason: 'unsupported_operation', detail: { issue_reason: reason } } }; // envelope §2
      case 'customer_return':
      case 'internal_transfer':
        // These are not plain shipment-COGS relief; they are handled by the returns/
        // no-journal paths and should not present as a generic shipment here.
        return { refusal: { reason: 'unsupported_operation', detail: { issue_reason: reason } } };
      default:
        return { refusal: { reason: 'unknown_issue_reason', detail: { issue_reason: reason } } };
    }
  }
  if (effectType === 'shrinkage') {
    // Count LOSS has a fixed treatment (§5-E): the neutral count-variance line.
    return { role: 'pnl.inventory_count_variance' };
  }
  if (effectType === 'found_stock') {
    // Count FOUND is NOT auto shrinkage credit (§5-E): only a CONFIRMED reversal of earlier
    // shrinkage auto-credits count variance; every other cause escalates.
    const cause = context.count_cause;
    if (cause === 'reversal_of_shrinkage') return { role: 'pnl.inventory_count_variance' };
    return { refusal: { reason: 'unknown_count_cause', detail: { count_cause: cause ?? null } } };
  }
  return { refusal: { reason: 'unsupported_operation', detail: { effectType } } };
};

// Resolve the canonical role for one effect leg's bucket.
const roleForBucket = ({ bucket, effectType, context }) => {
  if (STATIC_BUCKET_ROLE[bucket]) return { role: STATIC_BUCKET_ROLE[bucket] };
  if (bucket === 'cogs_or_variance') return resolveCogsRole({ effectType, context });
  // opening_balance_equity / owner_appropriation reach here only if an effect leaked a leg
  // the effect-type guard should have refused first — treat as unsupported.
  return { refusal: { reason: 'unsupported_operation', detail: { bucket } } };
};

// Normalize a resolved account descriptor into the standard builder account shape.
const normalizeAccount = (role, account) => {
  const code = String(account.code ?? account.account_code ?? '').trim();
  const name = String(account.name ?? account.account_name ?? code).trim();
  return {
    role: 'inventory_' + role.replace(/\./g, '_'),
    code,
    name,
    type: String(account.type ?? account.account_type ?? 'unknown').trim() || 'unknown',
    normal_balance: (String(account.normal_balance ?? normalBalanceForRole(role) ?? 'debit').toLowerCase() === 'credit') ? 'credit' : 'debit',
    tax_type: String(account.tax_type ?? 'NONE').trim() || 'NONE',
    canonical_role: role,
    label: account.label ?? name ?? code,
    mapping_provenance_id: account.mapping_provenance_id ?? null
  };
};

// The posting kind for an effect type (design §3/§5).
const POSTING_KIND_FOR_EFFECT = Object.freeze({
  receipt: 'receipt',
  shipment: 'shipment_cogs',
  shrinkage: 'count_adjustment',
  found_stock: 'count_adjustment'
});

// buildInventoryJournalDraft — one kernel operation effect → a draft, a value-neutral
// terminal, or a typed refusal. PURE.
export const buildInventoryJournalDraft = ({ effect, roleAccounts = {}, context = {}, valuationRunId = null } = {}) => {
  if (!effect || typeof effect !== 'object') return refuse(null, null, 'missing_valuation_basis', { effect: null });
  const operationId = effect.operationId ?? effect.operation_id ?? null;
  const effectType = effect.effectType ?? effect.effect_type ?? null;

  // Value-neutral (quarantine/release/neutral) — a RECORDED terminal, no journal (§11 D-POST-14).
  if (effect.posting === 'no_journal_required' || effectType === 'neutral') {
    return {
      applied: true,
      no_journal_required: true,
      operation_id: operationId,
      posting_kind: 'value_neutral',
      valuation_run_id: valuationRunId,
      journal: null,
      detail: { journal: { debits: 0, credits: 0 } },
      provenance: { operation_id: operationId, valuation_run_id: valuationRunId, effect_type: effectType },
      consequence: { changed: 'nothing (value-neutral)', invariant_checked: 'no_journal_required', commit: 'record_terminal' }
    };
  }

  // Escalations / out-of-envelope effects that never auto-post in v1.
  if (effectType === 'owner_private_use') return refuse(operationId, 'private_use', 'private_use_requires_review', { effectType });
  if (effectType === 'opening_balance') return refuse(operationId, 'value_neutral', 'unsupported_operation', { effectType, note: 'opening-balance posting is outside the v1 §5 event map' });
  if (effectType === 'reversal') return refuse(operationId, 'reversal', 'reversal_requires_persisted_journal', { effectType, reverses: effect.reverses ?? null });

  const postingKind = POSTING_KIND_FOR_EFFECT[effectType];
  if (!postingKind || !INVENTORY_POSTING_KINDS.includes(postingKind)) {
    return refuse(operationId, null, 'unsupported_operation', { effectType });
  }

  const legs = Array.isArray(effect.legs) ? effect.legs : [];
  if (legs.length === 0) return refuse(operationId, postingKind, 'missing_valuation_basis', { note: 'effect carried no legs' });

  // Resolve every leg's bucket → role → account. A single unresolved leg refuses the whole
  // draft (an unbalanced partial journal must never reach the executor).
  const accountsByRole = new Map();
  const lines = [];
  for (const leg of legs) {
    const resolved = roleForBucket({ bucket: leg.bucket, effectType, context });
    if (resolved.refusal) return refuse(operationId, postingKind, resolved.refusal.reason, resolved.refusal.detail);
    const role = resolved.role;
    const account = roleAccounts[role];
    if (!account) return refuse(operationId, postingKind, 'unmapped_account', { role, bucket: leg.bucket });
    const normalized = accountsByRole.get(role) || normalizeAccount(role, account);
    accountsByRole.set(role, normalized);
    const value = money(leg.amount);
    lines.push({
      account: normalized,
      direction: leg.direction,
      debit: leg.direction === 'debit' ? value : 0,
      credit: leg.direction === 'credit' ? value : 0,
      amount: value,
      currency: effect.functionalCurrency ?? effect.functional_currency ?? null,
      memo: `Inventory ${postingKind} · ${effectType}`,
      operation_id: operationId,
      valuation_run_id: valuationRunId
    });
  }

  const debits = money(lines.reduce((s, l) => s + l.debit, 0));
  const credits = money(lines.reduce((s, l) => s + l.credit, 0));
  // The kernel already guarantees balance; re-assert (belt-and-braces) before proposing.
  if (Math.abs(debits - credits) > 0.01) {
    return refuse(operationId, postingKind, 'missing_valuation_basis', { note: 'effect legs do not balance', debits, credits });
  }

  const dates = effect.dates || {};
  const journalDate = dates.accounting_date || dates.economic_date || null;
  const currency = effect.functionalCurrency ?? effect.functional_currency ?? null;
  const journal = {
    // One source_type; the fully-qualified source_id carries kind+op+run so the gateway's
    // natural-key upsert stays safe under retries without blocking versioned re-posting (§11).
    source_type: 'inventory_posting',
    source_id: `${postingKind}:${operationId}:${valuationRunId ?? ''}`,
    journal_date: journalDate,
    currency,
    status: 'proposed',
    memo: `Inventory ${postingKind} · ${effectType}`,
    direction: 'internal',
    amount: debits,
    accounts: [...accountsByRole.values()],
    lines
  };

  return {
    applied: true,
    no_journal_required: false,
    operation_id: operationId,
    posting_kind: postingKind,
    valuation_run_id: valuationRunId,
    journal,
    // detail.journal is what the EXISTING runDeterministicPreflight consumes (journal_balances).
    detail: { journal: { debits, credits } },
    provenance: {
      operation_id: operationId,
      valuation_run_id: valuationRunId,
      effect_type: effectType,
      economic_date: dates.economic_date ?? null,
      accounting_date: dates.accounting_date ?? null,
      tax_date: dates.tax_date ?? null,
      document_date: dates.document_date ?? null,
      fx: effect.fx ?? null
    },
    consequence: {
      changed: lines.map((l) => `${l.direction} ${l.account.canonical_role} ${l.amount}`),
      why: `${effectType}${context.issue_reason ? ` (${context.issue_reason})` : ''}${context.count_cause ? ` (${context.count_cause})` : ''}`,
      evidence: valuationRunId,
      invariant_checked: 'journal_balances',
      suspicious: [],
      commit: 'proposed'
    }
  };
};

// buildInventoryJournalDrafts — map a whole valuation result's operationEffects[] to drafts,
// threading each operation's reason/cause context. Returns a result per effect (draft /
// value-neutral / refusal), in the kernel's authoritative order. PURE.
//
// valuation: the applied() output of valueInventoryOperations (must be applied:true).
// operationContext: { [operationId]: { issue_reason?, count_cause? } }.
export const buildInventoryJournalDrafts = ({ valuation = {}, roleAccounts = {}, operationContext = {} } = {}) => {
  if (!valuation || valuation.applied === false) {
    return { applied: false, reason: 'missing_valuation_basis', detail: { valuation_refusal: valuation?.reason ?? null }, results: [] };
  }
  // The P1A kernel wraps its payload under `.receipt` (valuation.js applied()); accept
  // either the full applied() result or the inner payload directly.
  const payload = valuation.receipt ?? valuation;
  const valuationRunId = payload.valuationRunId ?? payload.valuation_run_id ?? null;
  const effects = Array.isArray(payload.operationEffects) ? payload.operationEffects : [];
  const results = effects.map((effect) => {
    const operationId = effect.operationId ?? effect.operation_id ?? null;
    const context = operationContext[String(operationId)] || {};
    return buildInventoryJournalDraft({ effect, roleAccounts, context, valuationRunId });
  });
  return {
    applied: true,
    contract_version: payload.contractVersion ?? payload.contract_version ?? null,
    valuation_run_id: valuationRunId,
    stream_version: payload.streamVersion ?? payload.stream_version ?? null,
    kernel_version: payload.kernelVersion ?? payload.kernel_version ?? null,
    input_hash: payload.inputHash ?? payload.input_hash ?? null,
    results
  };
};

// ─── P5 additions — the matched-supplier-bill orchestrator (§5-B) and the landed-cost /
// provisional-settlement builders (§5-B/§7). PURE (same rules as above): the executor
// (postingDb.js) re-fetches, preflights, and routes each draft through the ONE gateway. ───

// The variance-component → canonical P&L role map (design §4/§5-B). The kernel LABELS each
// variance leg (settleProvisionalCost.components / allocateLandedCost.varianceComponent);
// the builder routes each to its role so a landed-cost uplift or an fx swing is never
// blended into the PPV line (Failure B's blend was exactly this).
const VARIANCE_COMPONENT_ROLE = Object.freeze({
  purchase_price_variance: 'expense.purchase_price_variance',
  fx_variance: 'expense.fx',
  landed_cost_variance: 'expense.cost_of_sales_adjustment',
  quantity_variance: 'expense.cost_of_sales_adjustment',
  tax_variance: 'liability.tax_payable'
});

// assembleRoleJournal — build a balanced draft from explicit {role, direction, amount} legs
// (the §5-B / landed-cost paths supply legs directly rather than via kernel effect buckets).
// Resolves each role via roleAccounts (refuse unmapped_account on a missing or null role),
// asserts balance (refuse missing_valuation_basis on imbalance — an inconsistent
// decomposition has no valid basis, same choice the effect builder makes), and emits the
// standard draft shape. PURE.
const assembleRoleJournal = ({
  operationId, postingKind, effectType, legs = [], roleAccounts = {},
  valuationRunId, journalDate, currency, memo, sourceId, provenance = {}, consequenceWhy
}) => {
  const accountsByRole = new Map();
  const lines = [];
  for (const leg of legs) {
    const amount = money(leg.amount);
    if (!(amount > 0)) continue; // a zero leg contributes nothing — skip it (keeps the journal minimal)
    const role = leg.role;
    if (!role) return refuse(operationId, postingKind, 'unmapped_account', { role: role ?? null, memo: leg.memo ?? null });
    const account = roleAccounts[role];
    if (!account) return refuse(operationId, postingKind, 'unmapped_account', { role });
    const normalized = accountsByRole.get(role) || normalizeAccount(role, account);
    accountsByRole.set(role, normalized);
    lines.push({
      account: normalized,
      direction: leg.direction,
      debit: leg.direction === 'debit' ? amount : 0,
      credit: leg.direction === 'credit' ? amount : 0,
      amount,
      currency,
      memo: leg.memo || memo,
      operation_id: operationId,
      valuation_run_id: valuationRunId
    });
  }
  if (lines.length === 0) return refuse(operationId, postingKind, 'missing_valuation_basis', { note: 'no non-zero legs' });
  const debits = money(lines.reduce((s, l) => s + l.debit, 0));
  const credits = money(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(debits - credits) > 0.01) {
    return refuse(operationId, postingKind, 'missing_valuation_basis', { note: 'legs do not balance', debits, credits });
  }
  const journal = {
    source_type: 'inventory_posting',
    source_id: sourceId,
    journal_date: journalDate,
    currency,
    status: 'proposed',
    memo,
    direction: 'internal',
    amount: debits,
    accounts: [...accountsByRole.values()],
    lines
  };
  return {
    applied: true,
    no_journal_required: false,
    operation_id: operationId,
    posting_kind: postingKind,
    valuation_run_id: valuationRunId,
    journal,
    detail: { journal: { debits, credits } },
    provenance: { operation_id: operationId, valuation_run_id: valuationRunId, effect_type: effectType, ...provenance },
    consequence: {
      changed: lines.map((l) => `${l.direction} ${l.account.canonical_role} ${l.amount}`),
      why: consequenceWhy || effectType,
      evidence: valuationRunId,
      invariant_checked: 'journal_balances',
      suspicious: [],
      commit: 'proposed'
    }
  };
};

// buildMatchedInventorySupplierBillDraft — the §5-B orchestrator. ONE path credits gross AP
// per bill accounting-basis version (D-POST-9); the post-hoc-match path RECLASSIFIES the
// generic holding/expense lines into GRNI/inventory with AP UNTOUCHED (never a 2nd credit).
// The AP-credit identity is the BILL's accounting-basis version, NOT a per-allocation id, so
// one bill with several receipt allocations credits AP exactly once. PURE.
//
// bill: {
//   id, currency, accounting_date|date, accounting_basis_version (default 1),
//   gross_amount,                     // primary path: gross bill total → CR liability.accounts_payable ONCE
//   grni_clearing_amount,             // matched accrued inventory cost → DR liability.grni
//   variance_lines: [{component, direction, amount}],  // kernel price/cost variance split → DR/CR variance role
//   input_tax_amount,                 // recoverable input tax → DR liability.tax_payable (net-VAT control)
//   other_lines: [{role, direction, amount, memo}],    // non-inventory / unreceived portion
//   ap_already_posted,                // true ⇒ post-hoc reclassification (AP untouched)
//   reclassify_from: [{role, direction, amount, memo}]  // (reclassification) the generic lines to move OUT
// }
export const buildMatchedInventorySupplierBillDraft = ({ bill = {}, roleAccounts = {}, valuationRunId = null } = {}) => {
  const billId = bill.id ?? bill.bill_id ?? null;
  const currency = bill.currency ?? null;
  const basisVersion = Number.isInteger(bill.accounting_basis_version) ? bill.accounting_basis_version : 1;
  const journalDate = bill.accounting_date ?? bill.date ?? null;
  const postingKind = 'matched_supplier_bill';
  const grniAmount = money(bill.grni_clearing_amount);
  const varianceLines = Array.isArray(bill.variance_lines) ? bill.variance_lines : [];

  // An unknown variance component has no role — refuse rather than silently drop its leg
  // (an imbalanced AP credit would result).
  for (const v of varianceLines) {
    if (!VARIANCE_COMPONENT_ROLE[v.component]) {
      return refuse(billId, postingKind, 'unsupported_operation', { variance_component: v.component ?? null });
    }
  }
  const varianceLegs = varianceLines.map((v) => ({
    role: VARIANCE_COMPONENT_ROLE[v.component], direction: v.direction, amount: money(v.amount),
    memo: `Variance ${v.component}`
  }));

  // Post-hoc reclassification — AP already credited by the generic writer; move the generic
  // holding/expense lines into GRNI/inventory, AP UNTOUCHED. Bumps the basis version.
  if (bill.ap_already_posted) {
    const legs = [
      { role: 'liability.grni', direction: 'debit', amount: grniAmount, memo: 'GRNI clearing (reclassification)' },
      ...varianceLegs,
      ...(Array.isArray(bill.reclassify_from) ? bill.reclassify_from.map((r) => ({
        role: r.role, direction: r.direction, amount: money(r.amount), memo: r.memo || 'Reclassified from generic holding'
      })) : [])
    ];
    return assembleRoleJournal({
      operationId: billId, postingKind, effectType: 'matched_supplier_bill_reclassification',
      legs, roleAccounts, valuationRunId, journalDate, currency,
      memo: `Matched supplier bill ${billId} · reclassification (basis v${basisVersion})`,
      sourceId: `matched_supplier_bill:${billId}:v${basisVersion}:reclass:${valuationRunId ?? ''}`,
      provenance: { bill_id: billId, accounting_basis_version: basisVersion, reclassification: true, ap_credited: false },
      consequenceWhy: 'matched_supplier_bill (post-hoc reclassification — AP untouched)'
    });
  }

  // Primary path — credit gross AP exactly once for this bill accounting-basis version.
  const grossAp = money(bill.gross_amount);
  if (!(grossAp > 0)) {
    return refuse(billId, postingKind, 'missing_valuation_basis', { note: 'matched bill requires a positive gross amount', gross: grossAp });
  }
  const legs = [
    { role: 'liability.grni', direction: 'debit', amount: grniAmount, memo: 'GRNI clearing (matched accrued cost)' },
    ...varianceLegs,
    // Recoverable input tax → the net-VAT control (DR reduces net payable). Skipped when zero.
    { role: 'liability.tax_payable', direction: 'debit', amount: money(bill.input_tax_amount), memo: 'Recoverable input tax' },
    ...(Array.isArray(bill.other_lines) ? bill.other_lines.map((o) => ({
      role: o.role, direction: o.direction || 'debit', amount: money(o.amount), memo: o.memo || 'Non-inventory / unreceived portion'
    })) : []),
    { role: 'liability.accounts_payable', direction: 'credit', amount: grossAp, memo: 'Gross bill total' }
  ];
  return assembleRoleJournal({
    operationId: billId, postingKind, effectType: 'matched_supplier_bill',
    legs, roleAccounts, valuationRunId, journalDate, currency,
    memo: `Matched supplier bill ${billId} (basis v${basisVersion})`,
    sourceId: `matched_supplier_bill:${billId}:v${basisVersion}:${valuationRunId ?? ''}`,
    provenance: { bill_id: billId, accounting_basis_version: basisVersion, reclassification: false, ap_credited: true },
    consequenceWhy: 'matched_supplier_bill'
  });
};

// buildInventoryLandedCostDraft — capitalize an allocateLandedCost pool to inventory (§5-B/
// §7). The allocated uplift DR asset.inventory; the counter (freight accrual / AP / GRNI) is
// caller-supplied (creditRole). Per-receipt allocation splits ride inventory_journal_allocations
// (persisted by the executor). Consumes the kernel's allocateLandedCost output (applied or
// its inner payload). PURE.
export const buildInventoryLandedCostDraft = ({
  allocation = {}, creditRole = 'liability.accounts_payable', roleAccounts = {},
  operationId = null, valuationRunId = null, journalDate = null
} = {}) => {
  const postingKind = 'landed_cost';
  if (allocation.applied === false) {
    return refuse(operationId, postingKind, 'missing_valuation_basis', { allocation_refusal: allocation.reason ?? null });
  }
  const payload = allocation.receipt ?? allocation;
  const allocations = Array.isArray(payload.allocations) ? payload.allocations : [];
  const currency = payload.pool?.currency ?? null;
  const poolAmount = money(payload.pool?.amount);
  if (!(poolAmount > 0)) {
    return refuse(operationId, postingKind, 'missing_valuation_basis', { note: 'landed-cost pool requires a positive amount', poolAmount });
  }
  return assembleRoleJournal({
    operationId, postingKind, effectType: 'landed_cost',
    legs: [
      { role: 'asset.inventory', direction: 'debit', amount: poolAmount, memo: 'Landed-cost capitalization' },
      { role: creditRole, direction: 'credit', amount: poolAmount, memo: 'Landed-cost source (freight / accrual)' }
    ],
    roleAccounts, valuationRunId, journalDate, currency,
    memo: 'Inventory landed cost',
    sourceId: `landed_cost:${operationId}:${valuationRunId ?? ''}`,
    provenance: {
      landed_cost_method: payload.method ?? null,
      allocations: allocations.map((a) => ({ line_id: a.lineId, allocated_amount: a.allocatedAmount, unit_cost_uplift: a.unitCostUplift }))
    },
    consequenceWhy: 'landed_cost'
  });
};

// buildInventoryProvisionalSettlementDraft — post a settleProvisionalCost variance (§4/§5-B).
// The signed variance splits pro-rata across the still-on-hand portion (capitalized to
// inventory) and the already-consumed portion (routed to expense.cost_of_sales_adjustment);
// each variance COMPONENT (PPV / fx) rides its own role for the consumed share; the counter
// (AP / accrual owed on the actual cost) carries the full variance. Split defaults to
// fully-on-hand when the kernel inputs don't pin qty (settlement usually precedes the sale).
// PURE.
export const buildInventoryProvisionalSettlementDraft = ({
  settlement = {}, roleAccounts = {}, counterRole = 'liability.accounts_payable',
  operationId = null, valuationRunId = null, journalDate = null
} = {}) => {
  const postingKind = 'landed_cost'; // provisional→actual is a cost-basis delta in the landed-cost family (§5-B)
  if (settlement.applied === false) {
    return refuse(operationId, postingKind, 'missing_valuation_basis', { settlement_refusal: settlement.reason ?? null });
  }
  const payload = settlement.receipt ?? settlement;
  const variance = money(payload.variance);
  const currency = payload.currency ?? null;
  const opId = operationId ?? payload.affectedFrom ?? null;
  if (variance === 0) {
    // A zero variance is a RECORDED terminal (no journal) — the actual matched the provisional.
    return {
      applied: true, no_journal_required: true, operation_id: opId, posting_kind: 'value_neutral',
      valuation_run_id: valuationRunId, journal: null, detail: { journal: { debits: 0, credits: 0 } },
      provenance: { operation_id: opId, valuation_run_id: valuationRunId, effect_type: 'provisional_settlement', variance: 0 },
      consequence: { changed: 'nothing (actual == provisional)', invariant_checked: 'no_journal_required', commit: 'record_terminal' }
    };
  }
  const qty = money(payload.inputs?.qty);
  const onHand = payload.inputs?.currentQtyOnHand != null ? money(payload.inputs.currentQtyOnHand) : qty;
  const onHandFraction = qty > 0 ? Math.min(1, Math.max(0, onHand / qty)) : 1;
  const onHandVariance = money(variance * onHandFraction);
  const consumedVariance = money(variance - onHandVariance);

  // Direction: a POSITIVE variance (actual > provisional) means more cost — DR inventory /
  // DR variance, CR the counter (owed). A negative variance flips both sides.
  const dr = (amt) => (amt >= 0 ? 'debit' : 'credit');
  const cr = (amt) => (amt >= 0 ? 'credit' : 'debit');
  const components = payload.components || {};
  // Route the CONSUMED share across its variance components (PPV / fx / …), pro-rata to the
  // component magnitudes; the on-hand share capitalizes to inventory as one line.
  const componentEntries = Object.entries(components).filter(([, v]) => money(v) !== 0);
  let consumedLegs;
  if (componentEntries.length && consumedVariance !== 0) {
    // Pro-rata shares, THEN push the rounding remainder onto the largest-magnitude component so
    // Σ shares == consumedVariance EXACTLY (else a 0.01 residual would refuse a valid settlement,
    // the same exhaustive-allocation discipline allocateLandedCost uses).
    const shares = componentEntries.map(([component, compVal]) => ({
      component, share: money(consumedVariance * (money(compVal) / variance))
    }));
    const allocated = money(shares.reduce((s, x) => s + x.share, 0));
    const remainder = money(consumedVariance - allocated);
    if (remainder !== 0) {
      const largest = shares.reduce((a, b) => (Math.abs(b.share) > Math.abs(a.share) ? b : a));
      largest.share = money(largest.share + remainder);
    }
    consumedLegs = shares.map(({ component, share }) => ({
      role: VARIANCE_COMPONENT_ROLE[component] || 'expense.cost_of_sales_adjustment',
      direction: dr(share), amount: Math.abs(share), memo: `Consumed variance ${component}`
    })).filter((l) => l.amount > 0);
  } else if (consumedVariance !== 0) {
    consumedLegs = [{ role: 'expense.cost_of_sales_adjustment', direction: dr(consumedVariance), amount: Math.abs(consumedVariance), memo: 'Consumed variance' }];
  } else {
    consumedLegs = [];
  }

  const legs = [
    { role: 'asset.inventory', direction: dr(onHandVariance), amount: Math.abs(onHandVariance), memo: 'On-hand cost adjustment' },
    ...consumedLegs,
    { role: counterRole, direction: cr(variance), amount: Math.abs(variance), memo: 'Provisional-to-actual settlement' }
  ];
  return assembleRoleJournal({
    operationId: opId, postingKind, effectType: 'provisional_settlement',
    legs, roleAccounts, valuationRunId, journalDate, currency,
    memo: 'Inventory provisional-to-actual settlement',
    sourceId: `provisional_settlement:${opId}:${valuationRunId ?? ''}`,
    provenance: {
      variance, on_hand_variance: onHandVariance, consumed_variance: consumedVariance,
      revised_average: payload.revisedAverage ?? null, components
    },
    consequenceWhy: 'provisional_settlement'
  });
};

// buildInventoryWriteDownDraft — the §5-F write-down (explicit-amount only in v1, no
// automated NRV). DR expense.inventory_write_down / CR contra_asset.inventory_valuation_allowance.
// PURE; independent of the kernel operation stream (a write-down is an approved valuation
// event, not an inventory movement).
export const buildInventoryWriteDownDraft = ({ writeDown = {}, roleAccounts = {} } = {}) => {
  const amount = money(writeDown.amount);
  const operationId = writeDown.id ?? writeDown.operation_id ?? null;
  if (!(amount > 0)) return refuse(operationId, 'write_down', 'missing_valuation_basis', { note: 'write-down requires a positive amount', amount });
  const expenseAcct = roleAccounts['expense.inventory_write_down'];
  const allowanceAcct = roleAccounts['contra_asset.inventory_valuation_allowance'];
  if (!expenseAcct) return refuse(operationId, 'write_down', 'unmapped_account', { role: 'expense.inventory_write_down' });
  if (!allowanceAcct) return refuse(operationId, 'write_down', 'unmapped_account', { role: 'contra_asset.inventory_valuation_allowance' });

  const expense = normalizeAccount('expense.inventory_write_down', expenseAcct);
  const allowance = normalizeAccount('contra_asset.inventory_valuation_allowance', allowanceAcct);
  const currency = writeDown.currency ?? null;
  const valuationRunId = writeDown.valuation_run_id ?? null;
  const memo = `Inventory write-down${writeDown.scope_item_id ? ` · ${writeDown.scope_item_id}` : ''}`;
  const mkLine = (account, direction) => ({
    account, direction,
    debit: direction === 'debit' ? amount : 0,
    credit: direction === 'credit' ? amount : 0,
    amount, currency, memo, operation_id: operationId, valuation_run_id: valuationRunId
  });
  const lines = [mkLine(expense, 'debit'), mkLine(allowance, 'credit')];

  return {
    applied: true,
    no_journal_required: false,
    operation_id: operationId,
    posting_kind: 'write_down',
    valuation_run_id: valuationRunId,
    journal: {
      source_type: 'inventory_posting',
      source_id: `write_down:${operationId}:${valuationRunId ?? ''}`,
      journal_date: writeDown.date ?? null,
      currency,
      status: 'proposed',
      memo,
      direction: 'internal',
      amount,
      accounts: [expense, allowance],
      lines
    },
    detail: { journal: { debits: amount, credits: amount } },
    provenance: {
      operation_id: operationId,
      valuation_run_id: valuationRunId,
      effect_type: 'write_down',
      scope_item_id: writeDown.scope_item_id ?? null,
      scope_group: writeDown.scope_group ?? null,
      reviewer: writeDown.reviewer ?? null
    },
    consequence: {
      changed: [`debit expense.inventory_write_down ${amount}`, `credit contra_asset.inventory_valuation_allowance ${amount}`],
      why: 'write_down',
      evidence: valuationRunId,
      invariant_checked: 'journal_balances',
      suspicious: [],
      commit: 'proposed'
    }
  };
};

// ── §5-F derecognition consumption — release the bound allowance when the stock leaves ────
//
// The write-down created an allowance LOT bound to specific SKU/group stock. When that stock is
// derecognized (sold, scrapped, damaged/wasted), the bound allowance is RELEASED in the SAME
// event (§5-F redline) so it never strands against stock that no longer exists. Consumption is
// UNCAPPED (distinct from a market-recovery reversal, which the max_reversible cap governs): it
// is the release of an allowance whose stock is gone. Explicit-amount only in v1.

// The derecognition reasons a v1 release supports, and the P&L role each release CREDITS. A
// sale reduces COGS (net COGS = gross cost − the allowance already expensed at write-down); a
// scrap/damage/waste reduces the shrinkage loss (same logic on the count-variance line). Other
// reasons (e.g. customer return / restock, which re-binds rather than releases) refuse in v1.
export const ALLOWANCE_RELEASE_REASONS = Object.freeze(['sale', 'scrap', 'damage', 'waste']);
const RELEASE_COUNTERPARTY_ROLE = Object.freeze({
  sale: 'expense.cost_of_sales',
  scrap: 'pnl.inventory_count_variance',
  damage: 'pnl.inventory_count_variance',
  waste: 'pnl.inventory_count_variance'
});

// computeAllowanceRelease — PURE proportional consumption of a lot's outstanding allowance for a
// derecognized quantity. FULL consumption (qty ≥ the lot's remaining bound quantity) releases the
// ENTIRE remainder — no rounding drift, no stranded sub-cent remainder; a partial consumes
// (outstanding / remaining_quantity) × qty. Returns { releaseAmount, releaseQuantity, fullyConsumed }.
export const computeAllowanceRelease = ({ lot = {}, derecognizedQty = 0 } = {}) => {
  const outstanding = money(Number(lot.allowance_amount ?? 0) - Number(lot.consumed_amount ?? 0));
  const remainingQty = Number(lot.remaining_quantity ?? 0);
  const qty = Math.min(Number(derecognizedQty ?? 0), remainingQty);
  if (!(outstanding > 0) || !(qty > 0) || !(remainingQty > 0)) return { releaseAmount: 0, releaseQuantity: 0, fullyConsumed: false };
  if (qty >= remainingQty - 1e-9) return { releaseAmount: outstanding, releaseQuantity: remainingQty, fullyConsumed: true };
  return { releaseAmount: money((outstanding / remainingQty) * qty), releaseQuantity: qty, fullyConsumed: false };
};

// buildInventoryAllowanceReleaseDraft — the §5-F release journal (PURE):
//   DR contra_asset.inventory_valuation_allowance / CR (cost_of_sales | count_variance)
// releasing the allowance held against the now-derecognized stock, so the net P&L effect is the
// already-reduced carrying amount, not the gross cost plus a stranded allowance.
export const buildInventoryAllowanceReleaseDraft = ({
  lot = {}, releaseAmount = 0, reason = null, roleAccounts = {},
  operationId = null, date = null, currency = null, valuationRunId = null
} = {}) => {
  const amount = money(releaseAmount);
  if (!(amount > 0)) return refuse(operationId, 'allowance_release', 'missing_valuation_basis', { note: 'release requires a positive amount', releaseAmount });
  const counterpartyRole = RELEASE_COUNTERPARTY_ROLE[reason];
  if (!counterpartyRole) return refuse(operationId, 'allowance_release', 'unsupported_release_reason', { reason });
  return assembleRoleJournal({
    operationId, postingKind: 'allowance_release', effectType: 'allowance_release',
    legs: [
      { role: 'contra_asset.inventory_valuation_allowance', direction: 'debit', amount },
      { role: counterpartyRole, direction: 'credit', amount }
    ],
    roleAccounts, valuationRunId, journalDate: date, currency,
    memo: `Allowance release · ${reason}${lot.scope_item_id ? ` · ${lot.scope_item_id}` : ''}`,
    sourceId: `allowance_release:${operationId}:${lot.id ?? ''}`,
    provenance: { allowance_lot_id: lot.id ?? null, reason, scope_item_id: lot.scope_item_id ?? null, scope_group: lot.scope_group ?? null },
    consequenceWhy: 'allowance_release'
  });
};

// ── §10 FX retranslation of open foreign-currency GRNI at close (IAS 21) ───────────────────────
//
// Open foreign-currency GRNI is a MONETARY liability: at period-end its functional-currency
// carrying value is retranslated from the rate it was booked at to the CLOSING rate, and the
// unrealized FX movement on the still-open liability posts to the FX gain/loss line. The §16 GRNI
// reconciliation engine (reconcileGrniToOpenReceipts) already COMPUTES
// delta = sourceOpen × (closeRate − bookedRate) and surfaces it as an `obligation`; this builder
// is the WRITE side (never re-derives the FX math — it consumes the engine's delta).
//
//   • delta > 0 — the functional value of the liability GREW (the foreign currency strengthened):
//       DR expense.fx (loss) / CR liability.grni.
//   • delta < 0 — it SHRANK: DR liability.grni / CR expense.fx (gain).
//   • delta ≈ 0 — a RECORDED value-neutral terminal (nothing to post, D-POST-14).
//   • rate missing — REFUSE `missing_close_fx_rate` (→ integration_system_retry, §10/§12); NEVER a
//       guessed rate. The §16 engine routes the same wait; the builder names it identically.
//
// The journal is in FUNCTIONAL currency — `delta` is already a functional-currency amount (the
// source open × a rate difference). PURE.
export const buildInventoryGrniRetranslationDraft = ({
  currency = null, functionalCurrency = null, delta = null, closeRate = null, bookedRate = null,
  sourceOpenAmount = null, roleAccounts = {}, operationId = null, date = null, valuationRunId = null
} = {}) => {
  // No close rate ⇒ no basis to retranslate. Refuse, don't guess (§10). The refusal carries the
  // integration_system_retry waiter (WAITER_FOR_REFUSAL) + the concrete re-tested condition, so the
  // executor records an executable retry (D-POST-14), not a dead end.
  if (delta == null || closeRate == null) {
    return refuse(operationId, 'grni_retranslation', 'missing_close_fx_rate', {
      currency, close_rate: closeRate ?? null, next_action: 'await_fx_fact'
    });
  }
  const signedDelta = money(delta);
  const amount = money(Math.abs(signedDelta));
  // A sub-cent (zero) retranslation is a RECORDED terminal — no journal (§11 D-POST-14). The
  // liability's functional value did not move enough to post; still tracked, never a silent gap.
  if (!(amount > 0)) {
    return {
      applied: true,
      no_journal_required: true,
      operation_id: operationId,
      posting_kind: 'grni_retranslation',
      valuation_run_id: valuationRunId,
      journal: null,
      detail: { journal: { debits: 0, credits: 0 }, currency, delta: signedDelta },
      provenance: {
        operation_id: operationId, valuation_run_id: valuationRunId, effect_type: 'grni_retranslation',
        currency, functional_currency: functionalCurrency, close_rate: closeRate, booked_rate: bookedRate,
        source_open_amount: sourceOpenAmount, delta: signedDelta
      },
      consequence: { changed: 'nothing (zero FX delta)', invariant_checked: 'no_journal_required', commit: 'record_terminal' }
    };
  }
  const legs = signedDelta > 0
    ? [{ role: 'expense.fx', direction: 'debit', amount }, { role: 'liability.grni', direction: 'credit', amount }]
    : [{ role: 'liability.grni', direction: 'debit', amount }, { role: 'expense.fx', direction: 'credit', amount }];
  return assembleRoleJournal({
    operationId, postingKind: 'grni_retranslation', effectType: 'grni_retranslation',
    legs, roleAccounts, valuationRunId, journalDate: date, currency: functionalCurrency || currency,
    memo: `GRNI retranslation · ${currency} · ${signedDelta > 0 ? 'loss' : 'gain'}`,
    sourceId: operationId, // already kind-prefixed + (period, currency)-scoped by the executor → a unique natural key
    provenance: {
      currency, functional_currency: functionalCurrency, close_rate: closeRate, booked_rate: bookedRate,
      source_open_amount: sourceOpenAmount, delta: signedDelta
    },
    consequenceWhy: 'grni_retranslation'
  });
};
