// FI-13 slice 13.3A PR3 (D-FI13-15) — the Oy monthly-close checklist + terminal state.
//
// A reconciled bank feed is NOT an Oy close. An osakeyhtiö close is complete only
// when every balance-sheet account is reconciled, material P&L movements are
// evidenced, owner/company transfers are resolved through the D-FI13-9 taxonomy,
// statutory liabilities are reconciled, and every unresolved judgment item is
// assigned to a NAMED HUMAN. This module is the CONSUMER of the 13.3A detection
// layer: it folds the balance-sheet watches (PR2), the owner-transaction taxonomy
// (13.2), scope-drift, and the open StatutoryBlocker set onto a CLOSED checklist,
// and drives each item to exactly one of the two terminal states.
//
// Two-terminal-states (CLAUDE.md FIRST principle) applied to the close: every
// checklist item comes to rest in exactly one of
//   • 'settled'  — reconciled / evidenced / explicitly not-applicable (terminal 1), OR
//   • 'on_human' — resting on a named human as a StatutoryBlocker (terminal 2).
// There is NO third state. In particular ABSENCE of a signal is NEVER settled — an
// item with nothing computed for it is 'on_human' with reason 'pending_upstream',
// conservatively on the firm. Silent settle-from-absence is the limbo the principle
// forbids.
//
// DOCTRINE GUARD (accounting-runtime): this is the GoalReport / convergence-verdict
// for the close — it PROJECTS the existing detection verdicts and the StatutoryBlocker
// store onto a terminal, it does NOT build a third parallel structure. The pure
// evaluator here does the folding + terminal derivation; the DB reader
// (getFinlandOyMonthlyCloseFromDb) assembles the signals and persists the 'on_human'
// terminals by minting idempotent blockers. Pure; never throws on garbage.

// Config-plane flag (migration 042 pattern) — clientFlagActs, envFallback () => false;
// dark by default, canary per client (flags-born-on-the-config-plane rail).
export const FINLAND_OY_MONTHLY_CLOSE_FLAG_KEY = 'FINLAND_OY_MONTHLY_CLOSE';

// The two terminal states a checklist item may rest in. Nothing else.
export const OY_CLOSE_ITEM_TERMINALS = Object.freeze(['settled', 'on_human']);

// The named human an unresolved item rests on. The StatutoryBlocker store
// (migration 076) accepts firm / client / accountant / auditor / counsel — there
// is NO 'reviewer' there (PR2's watches emit 'reviewer' but never mint, so they
// never hit the store's CHECK). Since the close MINTS, every resting human it
// names must be a store-valid assignee, and a folded 'reviewer' from a PR2 watch
// is normalized to 'accountant' (the professional judgment human) so the minted
// blocker and the rendered verdict agree.
const STORE_VALID_ASSIGNEES = new Set(['firm', 'client', 'accountant', 'auditor', 'counsel']);
const normalizeAssignee = (a) => (a === 'reviewer' ? 'accountant' : (STORE_VALID_ASSIGNEES.has(a) ? a : 'accountant'));
export const OY_CLOSE_ASSIGNEES = Object.freeze(['firm', 'accountant', 'counsel']);

// The CLOSED checklist catalog (D-FI13-15), in presentation order. Each item
// carries the named human it rests on WHEN unresolved (default assignee), the
// blocker severity for that resting state, and bilingual copy. `blocker_surface`
// + `reason_code` are the StatutoryBlocker coordinates the DB reader mints under
// (deterministic id ⇒ idempotent, so re-running a close collapses, never spams).
const CLOSE_ITEM_CATALOG = Object.freeze([
  {
    id: 'bank_processor_reconciliation',
    default_assignee: 'firm', severity: 'review_required',
    label_fi: 'Pankki- ja maksunvälittäjätäsmäytys',
    label_en: 'Bank / processor reconciliation'
  },
  {
    id: 'ar_ap_reconciliation',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Myynti- ja ostoreskontran täsmäytys',
    label_en: 'AR / AP reconciliation'
  },
  {
    id: 'alv_reconciliation',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'ALV-täsmäytys',
    label_en: 'VAT (ALV) reconciliation'
  },
  {
    id: 'payroll_journal_import',
    default_assignee: 'firm', severity: 'review_required',
    label_fi: 'Palkkakirjausten tuonti ja velkojen täsmäytys',
    label_en: 'Payroll-journal import + liability reconciliation'
  },
  {
    id: 'reimbursements',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Kulukorvaukset',
    label_en: 'Reimbursements'
  },
  {
    id: 'loan_principal_interest',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Lainojen pääoma ja korko',
    label_en: 'Loan principal / interest'
  },
  {
    id: 'accruals_prepayments',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Jaksotukset ja siirtosaamiset/-velat',
    label_en: 'Accruals / prepayments'
  },
  {
    id: 'fixed_assets_depreciation',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Käyttöomaisuus ja poistot',
    label_en: 'Fixed assets / depreciation'
  },
  {
    id: 'tax_prepayments',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Ennakkoverot',
    label_en: 'Tax prepayments'
  },
  {
    id: 'shareholder_related_party_balances',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Osakas- ja lähipiirisaldot',
    label_en: 'Shareholder / related-party balances'
  },
  {
    id: 'equity_roll_forward',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Oman pääoman täsmäytys',
    label_en: 'Equity roll-forward'
  },
  {
    id: 'negative_equity_check',
    default_assignee: 'firm', severity: 'legal_violation',
    label_fi: 'Negatiivisen oman pääoman tarkistus',
    label_en: 'Negative-equity check'
  },
  {
    id: 'governance_evidence',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Hallinnon tositteet',
    label_en: 'Governance evidence'
  },
  {
    id: 'period_locks',
    default_assignee: 'firm', severity: 'review_required',
    label_fi: 'Kauden lukitus',
    label_en: 'Period locks'
  },
  {
    id: 'unresolved_judgment_items',
    default_assignee: 'accountant', severity: 'review_required',
    label_fi: 'Ratkaisemattomat harkintakohteet',
    label_en: 'Unresolved judgment items'
  }
]);

export const OY_CLOSE_CHECKLIST_ITEM_IDS = Object.freeze(CLOSE_ITEM_CATALOG.map((i) => i.id));
const CATALOG_BY_ID = new Map(CLOSE_ITEM_CATALOG.map((i) => [i.id, i]));

export const buildOyCloseReasonCode = (itemId) => `oy_close.${itemId}`;
export const OY_CLOSE_BLOCKER_SURFACE = 'finland_oy_monthly_close';

// Which checklist item a fired balance-sheet watch (PR2) lands on. A watch is a
// persisted detection verdict; the close renders it onto its item, never a fresh
// inference (render-the-persisted-verdict).
const WATCH_TO_ITEM = Object.freeze({
  negative_equity: 'negative_equity_check',
  distributable_equity_depleted: 'equity_roll_forward',
  related_party_receivable_ageing: 'shareholder_related_party_balances',
  unsupported_shareholder_debit: 'shareholder_related_party_balances',
  registry_books_period_mismatch: 'period_locks'
});
// Overdue statutory liabilities split by kind onto the item that owns them.
const STATUTORY_LIABILITY_KIND_TO_ITEM = Object.freeze({
  vat: 'alv_reconciliation',
  employer_contribution: 'payroll_journal_import',
  corporate_tax: 'tax_prepayments'
});

// Which checklist item an ESCALATING owner-transaction (13.2 taxonomy) lands on.
// A 'proposal' verdict does NOT block — only an 'escalate' rests on a human.
const OWNER_TX_TYPE_TO_ITEM = Object.freeze({
  salary: 'payroll_journal_import',
  expense_reimbursement: 'reimbursements',
  travel_reimbursement: 'reimbursements',
  dividend: 'equity_roll_forward',
  capital_contribution: 'equity_roll_forward',
  share_subscription: 'equity_roll_forward',
  svop_contribution: 'equity_roll_forward',
  return_of_capital: 'equity_roll_forward',
  shareholder_loan_to_owner: 'loan_principal_interest',
  shareholder_loan_to_company: 'loan_principal_interest',
  loan_repayment: 'loan_principal_interest',
  interest: 'loan_principal_interest',
  related_party_purchase: 'shareholder_related_party_balances',
  related_party_sale: 'shareholder_related_party_balances',
  unknown_owner_transfer: 'unresolved_judgment_items'
});

const SEVERITY_RANK = Object.freeze({ informational: 0, review_required: 1, legal_violation: 2 });
// The balance-sheet watches use 'legal_duty' for their strongest tier; the
// StatutoryBlocker vocabulary uses 'legal_violation'. Map on the way in.
const normalizeSeverity = (s) => (s === 'legal_duty' ? 'legal_violation' : s);
const rankSeverity = (s) => SEVERITY_RANK[normalizeSeverity(s)] ?? 1;
const worseSeverity = (a, b) => (rankSeverity(a) >= rankSeverity(b) ? normalizeSeverity(a) : normalizeSeverity(b));

const asArray = (v) => (Array.isArray(v) ? v : []);
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// evaluateOyMonthlyClose({ itemSignals, watches, ownerTransactions, openBlockers, asOf })
//
//   itemSignals        — per-item { status: 'settled'|'blocked', reason?, evidence?,
//                         assigned_to? }. The DB reader fills the items with a direct
//                         ledger source; an ABSENT item is treated as 'pending_upstream'
//                         (on_human), never silently settled.
//   watches            — the evaluateOyBalanceSheetWatches verdict ({ watches: [...] }).
//   ownerTransactions  — an array of classifyOwnerTransaction verdicts; every
//                         terminal:'escalate' blocks its mapped item.
//   openBlockers       — already-open StatutoryBlockers for this client (each { id,
//                         reason_code, severity, assigned_to, status }); an open
//                         blocker keeps its item 'on_human' and feeds the
//                         unresolved_judgment_items catch-all when it maps to nothing.
//
// Returns { terminal, closed, items, blocking, settled_count, on_human_count,
//   assigned_to, confirmedAgainstPrimary, provenance }.
//   terminal — 'closed' iff every checklist item is 'settled'; else 'blocked'.
export const evaluateOyMonthlyClose = ({
  itemSignals = {},
  watches = null,
  ownerTransactions = [],
  openBlockers = [],
  asOf = null
} = {}) => {
  const signals = isPlainObject(itemSignals) ? itemSignals : {};

  // Seed every catalog item as its resting state; a settling signal flips it to
  // 'settled', a blocking signal keeps/sets it 'on_human'. Nothing starts as a
  // third state.
  const state = new Map();
  for (const item of CLOSE_ITEM_CATALOG) {
    state.set(item.id, {
      id: item.id,
      label_fi: item.label_fi,
      label_en: item.label_en,
      terminal: 'on_human',
      assigned_to: item.default_assignee,
      severity: item.severity,
      reason: 'pending_upstream',
      reasons: [],
      evidence: []
    });
  }

  const block = (itemId, { reason, assigned_to, severity, evidence } = {}) => {
    const cur = state.get(itemId);
    if (!cur) return;
    const cat = CATALOG_BY_ID.get(itemId);
    cur.terminal = 'on_human';
    cur.reason = reason || cur.reason || 'requires_review';
    if (reason && !cur.reasons.includes(reason)) cur.reasons.push(reason);
    // Strongest severity + most-specialised human win when several signals land
    // on one item (a legal-duty watch outranks a review-required owner tx).
    cur.severity = worseSeverity(cur.severity, severity || cat.severity);
    if (assigned_to) cur.assigned_to = normalizeAssignee(assigned_to);
    if (evidence !== undefined && evidence !== null) cur.evidence.push(evidence);
  };

  const settle = (itemId, { reason, evidence } = {}) => {
    const cur = state.get(itemId);
    if (!cur) return;
    cur.terminal = 'settled';
    cur.assigned_to = null;
    cur.severity = null;
    cur.reason = reason || 'reconciled';
    cur.reasons = [];
    cur.evidence = evidence !== undefined && evidence !== null ? [evidence] : [];
  };

  // 1 — Explicit per-item signals from the ledger reads. A 'settled' signal is the
  //     ONLY way an item leaves its resting 'on_human' seed; 'blocked' refines the
  //     resting reason. An absent item stays 'pending_upstream' (never settled).
  for (const item of CLOSE_ITEM_CATALOG) {
    const sig = signals[item.id];
    if (!isPlainObject(sig)) continue;
    if (sig.status === 'settled') {
      settle(item.id, { reason: sig.reason, evidence: sig.evidence });
    } else if (sig.status === 'blocked') {
      block(item.id, {
        reason: sig.reason || 'requires_review',
        assigned_to: sig.assigned_to,
        severity: sig.severity,
        evidence: sig.evidence
      });
    }
  }

  // 2 — Balance-sheet watches (PR2). A fired watch always blocks its mapped item,
  //     OVERRIDING a settled signal — a detection verdict cannot be closed away.
  const firedWatches = asArray(watches?.watches);
  for (const w of firedWatches) {
    if (!isPlainObject(w) || !w.id) continue;
    if (w.id === 'overdue_statutory_liability') {
      const overdue = asArray(w.evidence?.overdue);
      const kinds = overdue.length ? overdue : [{ kind: 'vat' }];
      for (const o of kinds) {
        const itemId = STATUTORY_LIABILITY_KIND_TO_ITEM[String(o?.kind || '').trim()] || 'alv_reconciliation';
        block(itemId, { reason: `watch:${w.id}`, assigned_to: w.assigned_to, severity: w.severity, evidence: { watch: w.id, kind: o?.kind } });
      }
      continue;
    }
    const itemId = WATCH_TO_ITEM[w.id];
    if (!itemId) continue;
    block(itemId, { reason: `watch:${w.id}`, assigned_to: w.assigned_to, severity: w.severity, evidence: { watch: w.id } });
  }

  // 3 — Owner-transaction taxonomy (13.2). Only an ESCALATE verdict blocks; a
  //     PROPOSAL is an auto-reconcile path and does not hold the close.
  for (const tx of asArray(ownerTransactions)) {
    if (!isPlainObject(tx) || tx.terminal !== 'escalate') continue;
    const itemId = OWNER_TX_TYPE_TO_ITEM[tx.type] || 'unresolved_judgment_items';
    block(itemId, {
      reason: `owner_tx:${tx.type}:${tx.reason || 'requires_review'}`,
      severity: 'review_required',
      evidence: { owner_transaction: tx.type, missing_evidence: asArray(tx.missing_evidence) }
    });
  }

  // 4 — Already-open StatutoryBlockers. One minted for a close item keeps that item
  //     'on_human'; any OTHER open blocker (a cutover gap, a form-5 quarantine, an
  //     ad-hoc reviewer hold) feeds the unresolved_judgment_items catch-all so a
  //     named-human obligation elsewhere on the client is never invisible to the close.
  for (const b of asArray(openBlockers)) {
    if (!isPlainObject(b) || b.status === 'resolved') continue;
    const closeItem = CLOSE_ITEM_CATALOG.find((i) => buildOyCloseReasonCode(i.id) === b.reason_code);
    if (closeItem) {
      block(closeItem.id, { reason: 'open_blocker', assigned_to: b.assigned_to, severity: b.severity, evidence: { blocker_id: b.id } });
    } else {
      block('unresolved_judgment_items', {
        reason: 'open_blocker_elsewhere',
        assigned_to: normalizeAssignee(b.assigned_to),
        severity: b.severity,
        evidence: { blocker_id: b.id, reason_code: b.reason_code }
      });
    }
  }

  const items = CLOSE_ITEM_CATALOG.map((cat) => {
    const s = state.get(cat.id);
    const catalog = CATALOG_BY_ID.get(cat.id);
    const onHuman = s.terminal === 'on_human';
    return {
      id: s.id,
      label_fi: s.label_fi,
      label_en: s.label_en,
      terminal: s.terminal,
      assigned_to: onHuman ? s.assigned_to : null,
      severity: onHuman ? s.severity : null,
      reason: onHuman ? s.reason : (s.reason || 'reconciled'),
      reasons: onHuman ? s.reasons.slice() : [],
      evidence: s.evidence.slice(),
      // The StatutoryBlocker coordinates for an on_human item — the DB reader mints
      // under these (deterministic id ⇒ idempotent). Null for a settled item.
      blocker_directive: onHuman
        ? {
            surface: OY_CLOSE_BLOCKER_SURFACE,
            reason_code: buildOyCloseReasonCode(s.id),
            severity: s.severity,
            assigned_to: s.assigned_to,
            label_fi: catalog.label_fi,
            label_en: catalog.label_en
          }
        : null
    };
  });

  const blocking = items.filter((i) => i.terminal === 'on_human');
  const settledCount = items.length - blocking.length;
  const closed = blocking.length === 0;

  // Who the open close rests on, grouped — the two-terminal-states answer to
  // "nothing waits on us": every unsettled item names its human.
  const assignedTo = {};
  for (const i of blocking) {
    (assignedTo[i.assigned_to] = assignedTo[i.assigned_to] || []).push(i.id);
  }

  return {
    terminal: closed ? 'closed' : 'blocked',
    closed,
    items,
    blocking: blocking.map((i) => i.id),
    settled_count: settledCount,
    on_human_count: blocking.length,
    assigned_to: assignedTo,
    // The close renders detection verdicts whose statutory references are
    // themselves confirmedAgainstPrimary:false (F-FI13-V); the close verdict
    // inherits that until the underlying watches/deadlines are primary-confirmed.
    confirmedAgainstPrimary: false,
    provenance: {
      deterministic: true,
      as_of: asOf || null,
      policy: 'D-FI13-15 Oy monthly close — reconciled bank lines alone are not a close; every item settled or on a named human'
    }
  };
};
