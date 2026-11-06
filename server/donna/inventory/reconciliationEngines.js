// Donna Inventory I4·posting — P6 reconciliation engines (design §16), the PURE core.
//
// "Posted" is only trustworthy with the control loops that PROVE the books tie (§12: a
// posted journal is accounted-and-controlled, NOT yet reconciled — the reconciliation
// verdict is P6's to own, never collapsed into posting_status). This module is those five
// control loops as PURE invariant checks — no DB, no I/O, no LLM, no Date.now/Math.random/
// new Date — mirroring the discipline of reconcileConvergenceState.js (the FIRST-principle
// read-collapse) and the valuation kernel (valuation.js): the judgment is deterministic,
// so the invariant is MACHINE-CHECKED (reconciliationEngines.test.js), and a surface renders
// the PERSISTED verdict this produces — never a fresh render-time inference (CLAUDE.md:
// "render the persisted verdict, not the legacy layer").
//
// The five §16 engines:
//   1. inventory_to_gl        — GL asset.inventory (net of the allowance) == kernel cost
//                               subledger − valuation allowance, per client.
//   2. grni_to_open_receipts  — GL liability.grni == accrued receipts − matched allocations,
//                               per currency, WITH the open foreign-currency retranslation
//                               obligation surfaced at close (§10, IAS 21 monetary liability).
//   3. cogs_revenue_orphans   — posted COGS with no matching revenue event (and vice versa)
//                               surfaces as an exception (§5-C).
//   4. conservation           — posted COGS + remaining inventory + explicit losses == total
//                               accounted cost, ZERO residual within the documented tolerance,
//                               proven against the LEDGER (not just the kernel output), and the
//                               §4 variance decomposition sums to the total with no residual.
//   5. allowance_integrity    — allowance balance ties ONLY to still-on-hand written-down
//                               stock: no stranded allowance against derecognized stock (the
//                               §5-F consumption redline), no double-relief, and a
//                               market-recovery reversal never exceeds the original write-down.
//
// Each engine returns a VERDICT: { engine, status, reconciliation_status, residual, tolerance,
// waiter, detail }. `status` is one of TIED / BREACH / OBLIGATION / EXCEPTION / UNAVAILABLE. A BREACH names
// its §12 waiter (a conservation / GL-vs-subledger desync is an ENGINEERING INCIDENT — the
// books do not tie; a policy-shaped gap routes to the accountant/operator; a missing FX fact
// is a bounded integration/system retry). Nothing rests without a named owner — the
// two-terminal-states audit question survives verbatim: can a row sit here with nobody
// obligated to move it? If yes, bug.
//
// This module PROVES the invariants; it POSTS nothing. A reconciliation adjustment that must
// post (an FX retranslation journal, an allowance-release journal) routes through the P5
// gateway/executor (post_inventory_journal) in a later slice — never a new writer, never here.

// The documented rounding tolerance — the kernel's MONEY_TOLERANCE (valuation.js). Reported
// money is carried to 2 decimals; a residual within this band is zero (§16 "within the
// documented rounding tolerance"). Callers may override for a stricter/looser suite.
export const RECONCILIATION_MONEY_TOLERANCE = 0.01;

export const RECONCILIATION_ENGINES = Object.freeze([
  'inventory_to_gl',
  'grni_to_open_receipts',
  'cogs_revenue_orphans',
  'conservation',
  'allowance_integrity'
]);

// A verdict's status. TIED = the books tie. BREACH = a residual outside tolerance (the
// invariant is violated). OBLIGATION = a required action that is not itself a breach (the
// open-GRNI retranslation at close). EXCEPTION = a surfaced mismatch that is a review item,
// not a numeric desync (a COGS/revenue orphan).
export const RECONCILIATION_STATUSES = Object.freeze(['tied', 'breach', 'obligation', 'exception', 'unavailable']);

// §12 waiter types (a subset of the posting-log taxonomy that P6 breaches actually route to).
// A GL-vs-subledger / conservation desync is an ENGINEERING INCIDENT (the books do not tie);
// a policy/derecognition gap routes to the accountant/operator; a missing FX fact is a bounded
// integration/system retry that escalates on exhaustion (D-POST-14 — never a dead end).
export const RECONCILIATION_WAITERS = Object.freeze([
  'engineering_incident',
  'accountant_operator',
  'integration_system_retry'
]);

const TOL = RECONCILIATION_MONEY_TOLERANCE;

// Round to 2 decimals (reported-money boundary), matching the kernel's money() so a residual
// is compared at the same precision the amounts were posted at. Number.EPSILON nudge mirrors
// valuation.decimal so 0.005 rounds deterministically.
const money = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const within = (residual, tolerance) => Math.abs(num(residual)) <= num(tolerance) + 1e-9;

// The scope key an allowance lot binds to (SKU item, else product group). Mirrors the
// migration-080 CHECK (scope_item_id OR scope_group not null).
const scopeKeyOf = (lot) => {
  const item = lot?.scope_item_id ?? lot?.scopeItemId ?? null;
  const group = lot?.scope_group ?? lot?.scopeGroup ?? null;
  return item != null && item !== '' ? `item:${item}` : (group != null && group !== '' ? `group:${group}` : 'unscoped');
};

// ── Engine 1 — inventory_to_gl ────────────────────────────────────────────────
// GL asset.inventory (gross) == kernel cost subledger (gross moving-average value); GL
// contra_asset.inventory_valuation_allowance == the allowance register's outstanding balance;
// therefore net carrying (GL gross − GL allowance) == (subledger − register). Breach = a
// posting desync between the ledger and the subledger the kernel keeps — an ENGINEERING
// INCIDENT (§12). All amounts functional currency.
export const reconcileInventoryToGl = ({
  glInventoryGross = 0, glAllowance = 0, subledgerValue = 0, registerAllowance = 0, tolerance = TOL
} = {}) => {
  const grossResidual = money(num(glInventoryGross) - num(subledgerValue));
  const allowanceResidual = money(num(glAllowance) - num(registerAllowance));
  const glNet = money(num(glInventoryGross) - num(glAllowance));
  const subledgerNet = money(num(subledgerValue) - num(registerAllowance));
  const netResidual = money(glNet - subledgerNet);
  const tied = within(grossResidual, tolerance) && within(allowanceResidual, tolerance);
  return {
    engine: 'inventory_to_gl',
    status: tied ? 'tied' : 'breach',
    reconciliation_status: tied ? 'reconciled' : 'exception',
    residual: netResidual,
    tolerance: num(tolerance),
    waiter: tied ? null : {
      type: 'engineering_incident',
      next_action: 'open_incident',
      reason: 'gl_inventory_subledger_desync'
    },
    detail: {
      gl_inventory_gross: money(glInventoryGross),
      gl_allowance: money(glAllowance),
      subledger_value: money(subledgerValue),
      register_allowance: money(registerAllowance),
      gross_residual: grossResidual,
      allowance_residual: allowanceResidual,
      gl_net: glNet,
      subledger_net: subledgerNet
    }
  };
};

// ── Engine 2 — grni_to_open_receipts ──────────────────────────────────────────
// Per currency: GL liability.grni == accrued receipts − matched (bill-cleared) allocations.
// A residual is a posting desync (engineering incident). Separately, OPEN foreign-currency
// GRNI is a monetary liability retranslated at close (§10, IAS 21): the retranslation DELTA
// is surfaced as an OBLIGATION (not a breach) to post via the P5 gateway later; a MISSING
// close rate is a bounded integration/system retry (§12), never a guessed rate, never an
// owner ask. `functionalCurrency` marks which currency needs no retranslation.
export const reconcileGrniToOpenReceipts = ({ byCurrency = [], functionalCurrency = null, tolerance = TOL } = {}) => {
  const rows = (Array.isArray(byCurrency) ? byCurrency : []).map((c) => {
    const currency = String(c?.currency ?? '').toUpperCase();
    const glGrni = money(c?.glGrni ?? c?.gl_grni);
    const accrued = money(c?.accruedReceipts ?? c?.accrued_receipts);
    const matched = money(c?.matchedAllocations ?? c?.matched_allocations);
    const expectedOpen = money(accrued - matched);
    const residual = money(glGrni - expectedOpen);
    const tied = within(residual, tolerance);
    const isForeign = functionalCurrency != null && currency !== '' && currency !== String(functionalCurrency).toUpperCase();
    const hasOpen = Math.abs(glGrni) > num(tolerance);

    // Retranslation of open foreign GRNI at close (§10). sourceOpenAmount × (closeRate −
    // bookedRate) is the unrealized FX delta on the still-open monetary liability.
    let retranslation = null;
    if (isForeign && hasOpen) {
      const closeRate = c?.closeRate ?? c?.close_rate ?? null;
      if (closeRate == null) {
        retranslation = { required: true, rate_available: false, delta: null };
      } else {
        const bookedRate = num(c?.bookedRate ?? c?.booked_rate ?? 0);
        const sourceOpen = num(c?.sourceOpenAmount ?? c?.source_open_amount ?? 0);
        const delta = money(sourceOpen * (num(closeRate) - bookedRate));
        retranslation = { required: true, rate_available: true, delta, close_rate: num(closeRate), booked_rate: bookedRate };
      }
    }
    return { currency, glGrni, accrued, matched, expectedOpen, residual, tied, retranslation };
  });

  const breached = rows.filter((r) => !r.tied);
  const retranslationsDue = rows.filter((r) => r.retranslation?.required);
  const rateMissing = retranslationsDue.filter((r) => !r.retranslation.rate_available);
  const worstResidual = rows.reduce((m, r) => (Math.abs(r.residual) > Math.abs(m) ? r.residual : m), 0);

  let status = 'tied';
  let waiter = null;
  if (breached.length > 0) {
    status = 'breach';
    waiter = { type: 'engineering_incident', next_action: 'open_incident', reason: 'grni_open_receipt_desync', currencies: breached.map((r) => r.currency) };
  } else if (rateMissing.length > 0) {
    // Not a breach: the balance ties, but close retranslation cannot proceed without the rate.
    status = 'obligation';
    waiter = { type: 'integration_system_retry', next_action: 'await_fx_fact', reason: 'missing_close_fx_rate', currencies: rateMissing.map((r) => r.currency) };
  } else if (retranslationsDue.length > 0) {
    status = 'obligation';
    waiter = { type: 'accountant_operator', next_action: 'post_retranslation_adjustment', reason: 'open_grni_retranslation_due', currencies: retranslationsDue.map((r) => r.currency) };
  }
  return {
    engine: 'grni_to_open_receipts',
    status,
    reconciliation_status: breached.length > 0 ? 'exception' : (retranslationsDue.length > 0 ? 'open' : 'reconciled'),
    residual: money(worstResidual),
    tolerance: num(tolerance),
    waiter,
    detail: { by_currency: rows, functional_currency: functionalCurrency, retranslations_due: retranslationsDue.length, rate_missing: rateMissing.length }
  };
};

// ── Engine 3 — cogs_revenue_orphans ───────────────────────────────────────────
// Posted COGS (a shipment_cogs relief, §5-C) whose sale/fulfilment link has NO matching
// revenue event — and a revenue event with no COGS relief — surface as EXCEPTIONS (not
// posting blockers, §5-C). Matched on a shared `link` (the sale/fulfilment reference the
// upstream operation carries). Routed to the accountant/operator: a revenue-recognition
// mismatch is an accounting review, not a numeric desync.
export const reconcileCogsRevenueOrphans = ({ cogsEvents = [], revenueEvents = [] } = {}) => {
  const cogs = Array.isArray(cogsEvents) ? cogsEvents : [];
  const revenue = Array.isArray(revenueEvents) ? revenueEvents : [];
  const linkOf = (e) => String(e?.link ?? e?.sale_reference ?? e?.saleReference ?? '');
  const revenueLinks = new Set(revenue.map(linkOf).filter((l) => l !== ''));
  const cogsLinks = new Set(cogs.map(linkOf).filter((l) => l !== ''));

  const cogsOrphans = cogs.filter((e) => { const l = linkOf(e); return l === '' || !revenueLinks.has(l); })
    .map((e) => ({ side: 'cogs', link: linkOf(e), operation_id: e?.operation_id ?? e?.operationId ?? null, amount: money(e?.amount), date: e?.date ?? null }));
  const revenueOrphans = revenue.filter((e) => { const l = linkOf(e); return l === '' || !cogsLinks.has(l); })
    .map((e) => ({ side: 'revenue', link: linkOf(e), source_id: e?.source_id ?? e?.sourceId ?? null, amount: money(e?.amount), date: e?.date ?? null }));

  const orphans = [...cogsOrphans, ...revenueOrphans];
  const tied = orphans.length === 0;
  return {
    engine: 'cogs_revenue_orphans',
    status: tied ? 'tied' : 'exception',
    reconciliation_status: tied ? 'reconciled' : 'exception',
    residual: money(orphans.reduce((s, o) => s + Math.abs(num(o.amount)), 0)),
    tolerance: 0,
    waiter: tied ? null : { type: 'accountant_operator', next_action: 'review_cogs_revenue_orphans', reason: 'cogs_revenue_orphan', cogs_orphans: cogsOrphans.length, revenue_orphans: revenueOrphans.length },
    detail: { cogs_orphans: cogsOrphans, revenue_orphans: revenueOrphans, cogs_events: cogs.length, revenue_events: revenue.length }
  };
};

// ── Engine 4 — conservation (zero-residual) ───────────────────────────────────
// Proven against the LEDGER, not just the kernel output (§16): the ledger's per-bucket net
// movements over the inventory-posting journals must EQUAL the kernel's conserved COST effect
// totals — inventory (Σ amountToInventory) and COGS/variance/losses (Σ amountToCogsOrVariance)
// — the kernel's own conservation delta must be zero, AND — when the ledger flow components are
// supplied — the direct flow identity total_accounted_cost − posted_cogs − explicit_losses −
// remaining == 0 must hold. The §4 variance decomposition must sum to the total with no
// residual. ANY residual outside tolerance is a conservation breach → ENGINEERING INCIDENT (§12).
//
// GRNI is deliberately NOT a conservation bucket: it is the funding-side monetary LIABILITY
// (a receipt accrues it; a matched supplier bill — NOT a kernel operation effect — CLEARS it),
// so ledger net GRNI legitimately diverges from the kernel's gross accrual. GRNI ties are
// engine 2's sole responsibility (GL GRNI == accrued − matched). Conservation is COST flow only.
export const reconcileConservation = ({
  kernelConservation = null, ledgerBuckets = null, kernelBuckets = null, ledgerFlow = null, variance = null, tolerance = TOL
} = {}) => {
  const checks = [];
  const add = (name, residual) => checks.push({ name, residual: money(residual), tied: within(residual, tolerance) });

  // (a) the kernel's own zero-residual invariant (valuation.js conservation.delta).
  if (kernelConservation && kernelConservation.delta != null) add('kernel_conservation', kernelConservation.delta);

  // (b) per-bucket ledger↔kernel COST ties — the ledger routed exactly the conserved cost totals.
  if (ledgerBuckets && kernelBuckets) {
    add('inventory_bucket', num(ledgerBuckets.inventory) - num(kernelBuckets.inventory));
    add('cogs_bucket', num(ledgerBuckets.cogs) - num(kernelBuckets.cogs));
  }

  // (c) the direct flow identity, ledger-side (when the components are gathered).
  if (ledgerFlow) {
    const flowResidual = num(ledgerFlow.totalAccountedCost) - num(ledgerFlow.postedCogs) - num(ledgerFlow.explicitLosses) - num(ledgerFlow.remaining);
    add('flow_identity', flowResidual);
  }

  // (d) the §4 variance decomposition sums to the total with no residual (D-POST-3).
  if (variance && variance.total != null && variance.components) {
    const componentsSum = Object.values(variance.components).reduce((s, v) => s + num(v), 0);
    add('variance_decomposition', num(variance.total) - componentsSum);
  }

  const breaches = checks.filter((c) => !c.tied);
  const worst = checks.reduce((m, c) => (Math.abs(c.residual) > Math.abs(m) ? c.residual : m), 0);
  const tied = breaches.length === 0;
  return {
    engine: 'conservation',
    status: tied ? 'tied' : 'breach',
    reconciliation_status: tied ? 'reconciled' : 'exception',
    residual: money(worst),
    tolerance: num(tolerance),
    waiter: tied ? null : { type: 'engineering_incident', next_action: 'open_incident', reason: 'conservation_residual', breached: breaches.map((c) => c.name) },
    detail: { checks }
  };
};

// ── Engine 5 — allowance_integrity + derecognition-consumption check ───────────
// The allowance balance ties ONLY to still-on-hand written-down stock (§5-F redline):
//   • register↔GL: GL contra_asset.allowance == Σ (allowance_amount − consumed_amount) over
//     active lots — a desync is an engineering incident.
//   • no stranded allowance: an active lot whose bound stock has left inventory (on-hand
//     qty/value gone) with allowance still outstanding is STRANDED — the derecognition should
//     have CONSUMED it (§5-F). Surfaced to the accountant/operator. (Until the P6 consumption
//     POST lands, this engine HONESTLY surfaces every strand — that is the invariant doing its
//     job, not a false positive.)
//   • no over-allowance: outstanding allowance ≤ the carrying cost of the still-on-hand stock
//     it is bound to.
//   • no double-relief: consumed_amount ≤ allowance_amount.
//   • capped market-recovery: a reversal never exceeds the original write-down
//     (reversed_amount ≤ max_reversible_amount ≤ allowance_amount).
// `onHandByScope` maps a scope key (item:<id> / group:<g>) → { qty, value } from the subledger.
export const reconcileAllowanceIntegrity = ({ lots = [], glAllowance = 0, onHandByScope = {}, tolerance = TOL } = {}) => {
  const rows = Array.isArray(lots) ? lots : [];
  const activeLots = rows.filter((l) => String(l?.status ?? 'active') === 'active');
  const outstandingOf = (l) => money(num(l?.allowance_amount ?? l?.allowanceAmount) - num(l?.consumed_amount ?? l?.consumedAmount));
  const outstandingTotal = money(activeLots.reduce((s, l) => s + outstandingOf(l), 0));
  const registerResidual = money(num(glAllowance) - outstandingTotal);

  const stranded = [];
  const overAllowance = [];
  const doubleRelief = [];
  const overReversal = [];

  for (const lot of rows) {
    const key = scopeKeyOf(lot);
    const outstanding = outstandingOf(lot);
    const onHand = onHandByScope?.[key] ?? { qty: 0, value: 0 };
    const status = String(lot?.status ?? 'active');
    const allowanceAmount = num(lot?.allowance_amount ?? lot?.allowanceAmount);
    const consumed = num(lot?.consumed_amount ?? lot?.consumedAmount);
    const maxReversible = num(lot?.max_reversible_amount ?? lot?.maxReversibleAmount);
    const reversed = num(lot?.reversed_amount ?? lot?.reversedAmount ?? 0);

    // Stranded: active lot, outstanding allowance, but the bound stock is gone.
    if (status === 'active' && outstanding > num(tolerance) && (num(onHand.qty) <= 0 || num(onHand.value) <= num(tolerance))) {
      stranded.push({ lot_id: lot?.id ?? null, scope: key, outstanding });
    }
    // Over-allowance: outstanding exceeds the carrying cost of the on-hand stock it binds.
    if (status === 'active' && num(onHand.value) > num(tolerance) && outstanding - num(onHand.value) > num(tolerance)) {
      overAllowance.push({ lot_id: lot?.id ?? null, scope: key, outstanding, on_hand_value: money(onHand.value) });
    }
    // Double-relief: consumed beyond the lot's allowance.
    if (consumed - allowanceAmount > num(tolerance)) {
      doubleRelief.push({ lot_id: lot?.id ?? null, scope: key, consumed: money(consumed), allowance_amount: money(allowanceAmount) });
    }
    // Over-reversal: a market-recovery reversal beyond the original write-down cap.
    if (reversed - maxReversible > num(tolerance) || maxReversible - allowanceAmount > num(tolerance)) {
      overReversal.push({ lot_id: lot?.id ?? null, scope: key, reversed: money(reversed), max_reversible: money(maxReversible), allowance_amount: money(allowanceAmount) });
    }
  }

  const registerTied = within(registerResidual, tolerance);
  const hasBreach = !registerTied || doubleRelief.length > 0;         // numeric desyncs → incident
  const hasPolicyGap = stranded.length > 0 || overAllowance.length > 0 || overReversal.length > 0; // → accountant/operator
  const tied = !hasBreach && !hasPolicyGap;

  let waiter = null;
  if (hasBreach) {
    waiter = { type: 'engineering_incident', next_action: 'open_incident', reason: !registerTied ? 'allowance_register_gl_desync' : 'allowance_double_relief' };
  } else if (hasPolicyGap) {
    waiter = { type: 'accountant_operator', next_action: 'review_allowance_integrity', reason: stranded.length > 0 ? 'stranded_allowance_on_derecognition' : (overAllowance.length > 0 ? 'allowance_exceeds_on_hand' : 'reversal_exceeds_cap') };
  }
  return {
    engine: 'allowance_integrity',
    status: tied ? 'tied' : (hasBreach ? 'breach' : 'exception'),
    reconciliation_status: tied ? 'reconciled' : 'exception',
    residual: registerResidual,
    tolerance: num(tolerance),
    waiter,
    detail: {
      gl_allowance: money(glAllowance),
      outstanding_total: outstandingTotal,
      register_residual: registerResidual,
      stranded,
      over_allowance: overAllowance,
      double_relief: doubleRelief,
      over_reversal: overReversal,
      active_lots: activeLots.length,
      total_lots: rows.length
    }
  };
};

// ── Top-level runner ──────────────────────────────────────────────────────────
// Runs all five §16 engines over one gathered `state` and returns a combined verdict. Every
// non-tied engine contributes its §12 waiter to `breaches` (a numeric desync / conservation
// violation) or `obligations` / `exceptions` — so a caller can route each per §12 and a
// surface can render the persisted verdict. `tied` is the whole-client convergence: every
// engine ties, no obligation or exception outstanding.
export const runInventoryReconciliation = (state = {}) => {
  const tolerance = state.tolerance != null ? num(state.tolerance) : TOL;
  const engines = {
    inventory_to_gl: reconcileInventoryToGl({ ...(state.inventoryToGl || {}), tolerance }),
    grni_to_open_receipts: reconcileGrniToOpenReceipts({ ...(state.grni || {}), tolerance }),
    cogs_revenue_orphans: reconcileCogsRevenueOrphans({ ...(state.cogsRevenue || {}) }),
    conservation: reconcileConservation({ ...(state.conservation || {}), tolerance }),
    allowance_integrity: reconcileAllowanceIntegrity({ ...(state.allowance || {}), tolerance })
  };
  // Missing facts are not zero balances. Retain the established waiter contract while
  // exposing a typed unavailable engine and no invented numeric residual.
  for (const engine of RECONCILIATION_ENGINES) {
    const reason = state.availability?.reason || state.unavailableEngines?.[engine];
    if (reason) engines[engine] = { engine, status: 'unavailable', reconciliation_status: 'open', residual: null, tolerance,
      waiter: { type: 'accountant_operator', next_action: 'restore_reconciliation_evidence', reason },
      detail: state.availability || { reason } };
  }
  const verdicts = Object.values(engines);
  const breaches = verdicts.filter((v) => v.status === 'breach');
  const obligations = verdicts.filter((v) => v.status === 'obligation');
  const exceptions = verdicts.filter((v) => v.status === 'exception');
  const unavailable = verdicts.filter(v => v.status === 'unavailable');
  const tied = breaches.length === 0 && obligations.length === 0 && exceptions.length === 0 && unavailable.length === 0;
  return {
    tied,
    reconciliation_status: tied ? 'reconciled' : (breaches.length > 0 ? 'exception' : (exceptions.length > 0 ? 'exception' : 'open')),
    engines,
    breaches: breaches.map((v) => ({ engine: v.engine, residual: v.residual, waiter: v.waiter })),
    obligations: obligations.map((v) => ({ engine: v.engine, waiter: v.waiter })),
    exceptions: exceptions.map((v) => ({ engine: v.engine, waiter: v.waiter })),
    unavailable: unavailable.map(v => ({ engine: v.engine, waiter: v.waiter })),
    tolerance
  };
};
