// Canonical-role resolution — the two-terminal planner for a client's chart.
//
// WHY THIS EXISTS. `accountRoles.js` gives every account a machine-facing
// identity, but only for names Donna herself seeds: `roleForSeedName` returns
// null for everything else, with the header comment deferring the real mapping
// to "the STRONG MODEL's job (a later slice)". That slice was never built, so a
// REAL synced chart — the authoritative case in both first-class markets —
// arrives almost entirely unroled, and the posting paths that resolve BY ROLE
// simply refuse.
//
// The refusal is correct and the resting place is not. `accountForRole`
// (firmDb.js:16277) throws a 409 named OUTBOUND_AR_NO_SALES_TAX_ACCOUNT or
// OUTBOUND_AR_AMBIGUOUS_SALES_TAX_ACCOUNT, and the only thing that clears it is
// an operator running `scripts/backfill_gb_sales_tax_roles.js --account <id>`.
// That is a firm-side limbo with a named error code: a per-client manual step in
// a product whose thesis is that there is no back office (CLAUDE.md, the
// two-terminal-states principle; and the row-3 finding in
// docs/donna-fi-uk-area-review-2026-07-29.md, which names an owner-ask lane for
// role disambiguation as the real blocker).
//
// So this module plans exactly two terminals per account, and no third:
//
//   ASSIGN     — the strong model proposed a role, every deterministic
//                invariant agrees, and nothing contends for it. Donna does it.
//   ASK_OWNER  — a genuine tie, or a REQUIRED role with nothing assignable
//                (including one whose only proposals the Keep layer refused).
//                The owner names the account.
//
// A refused proposal for a role nothing REQUIRES is not a third resting state:
// it DEFERS, counted, to the next sweep (Kari's dated call, 2026-08-01, option
// B — see the refusal-vocabulary note below). The account keeps working by
// code/name, no posting path resolves by the role, and no human action is
// needed to clear it; the moment posting reality makes the role required,
// `deriveRequiredRolesForClient` promotes the gap into an owner ask.
//
// WHY AN OWNER ASK IS THE HONEST ESCALATION HERE. Under the 2026-07-23
// self-service re-amendment the fork is FACT vs KNOWLEDGE. "What does a VAT
// control account do" is knowledge and Donna answers it herself — which is why
// the model proposes at all. "WHICH of the two accounts YOUR previous
// bookkeeper set up is the VAT one" is a fact about this owner's chart, and
// when the chart genuinely does not say, no amount of model strength invents
// it. That is the one question this lane may ask, and it should be rare: the
// model resolves "VAT control" vs "Corporation tax payable" on its own.
//
// KEEP LAYER, NOT INTELLIGENCE-SUBSTITUTING. Nothing here classifies an account
// — no name regexes, no arity heuristics. `backfill_gb_sales_tax_roles.js`
// already established both rules this module inherits: account arity carries no
// information about which account is the VAT control, and neither does the
// account NAME. What this module owns is the deterministic refusal set the
// model's proposals must survive (class agreement, normal-balance agreement,
// singleton contention, never overwriting a settled role) and the routing of
// whatever does not survive onto the owner rather than onto the firm.

import { ACCOUNT_ROLES, isAccountRole, roleMeta } from './accountRoles.js';
import { balanceSheetSectionFor } from './ledgerReadModel.js';

// ── Terminals ────────────────────────────────────────────────────────────────
// Two, plus the no-op for a role that was already settled. `already_resolved`
// is not a third resting state — it is the absence of work, and the planner
// emits it so a caller can prove an account was CONSIDERED rather than dropped.
export const ROLE_RESOLUTION_TERMINALS = Object.freeze(['assign', 'ask_owner', 'already_resolved']);

// Closed refusal vocabulary. Every proposal this planner declines names one of
// these, and every one of them lands in exactly one NAMED lane: an owner ask
// (the role is contended, or required with nothing assigned), moot (the same
// account settled via another proposal this run), or a counted deferral to the
// next sweep (`deferred` + `receipt.deferred_to_next_sweep`). A refusal is
// never a silent drop and never a firm-side queue: a deferral rests on Donna's
// own sweep — no human clears it — which is why retry-next-sweep is the honest
// terminal for a refused NON-required proposal (Kari, 2026-08-01, option B).
// Asking the owner instead would put Donna's uncertainty on them for a role no
// posting path needs — and would have to do the same for class_mismatch, i.e.
// ask the owner to bless a proposal the invariants proved wrong.
export const ROLE_RESOLUTION_REFUSALS = Object.freeze([
  'role_unknown',              // proposed role is not in ACCOUNT_ROLES
  'class_mismatch',            // role's class disagrees with the account's declared type
  'normal_balance_conflict',   // role's fixed normal balance disagrees with the account's
  'below_confidence_floor',    // the model was not confident enough to post it
  'singleton_contended',       // 2+ accounts want one role that a posting path resolves uniquely
  'no_candidate'               // a required singleton role that nothing proposes and nothing holds
]);

// ── Singleton roles ──────────────────────────────────────────────────────────
// Roles that some posting path resolves BY ROLE and refuses on anything other
// than exactly one match. Two accounts on one of these is not a richer chart —
// it is a book that cannot post, and the failure surfaces later at a posting
// site rather than here where it can still be asked about.
//
// Derived by reading the resolve-by-role call sites, NOT invented:
//   * firmDb.js:16308/16311/16384 — accountForRole() for the GB AR posting legs
//     (asset.accounts_receivable, revenue.operating, liability.sales_tax_payable);
//     `limit 2` then refuse on >1.
//   * gb/cutover.js:22 — the opening-balance intake requires
//     `(byRole.get(role) || []).length !== 1` over its ten SUPPORTED_ROLES.
//   * every control role in ACCOUNT_ROLES — a control account is by definition
//     the one account reconciled against an external balance; two of them means
//     neither reconciles.
//
// NOTE the honest consequence for `revenue.operating`: it is control:false and a
// business may legitimately want several revenue accounts, but the GB AR leg
// resolves it by role today and refuses on two. Declaring it here does not
// create that constraint — it surfaces it while the owner can still be asked,
// instead of at the first VAT-registered sale.
const RESOLVE_BY_ROLE_POSTING_SITES = [
  'asset.accounts_receivable',
  'revenue.operating',
  'liability.sales_tax_payable'
];

const RESOLVE_BY_ROLE_CUTOVER_SITES = [
  'asset.cash',
  'asset.accounts_receivable',
  'asset.inventory',
  'asset.fixed',
  'liability.accounts_payable',
  'liability.sales_tax_payable',
  'equity.share_capital',
  'equity.retained_earnings',
  'equity.owner_capital',
  'liability.director_loan'
];

export const POSTING_SINGLETON_ROLES = Object.freeze([
  ...new Set([
    ...RESOLVE_BY_ROLE_POSTING_SITES,
    ...RESOLVE_BY_ROLE_CUTOVER_SITES,
    ...Object.keys(ACCOUNT_ROLES).filter((role) => ACCOUNT_ROLES[role].control)
  ])
].sort());

const SINGLETON_ROLE_SET = new Set(POSTING_SINGLETON_ROLES);

export const isSingletonRole = (role) => SINGLETON_ROLE_SET.has(String(role || ''));

// ── Deterministic invariants ─────────────────────────────────────────────────

// Statement classes that a declared account_type can be checked against. The
// clearing/control/contra_asset/pnl classes are deliberately absent: an account
// carrying one of those roles is routinely typed 'unknown' or 'liability' by the
// source system, and `ledgerReadModel.classifiedAccountType` already treats them
// as unclassifiable rather than guessing a side. Refusing them for a class
// mismatch would refuse the normal case.
const CHECKABLE_CLASSES = new Set(['asset', 'liability', 'equity', 'revenue', 'expense']);

// `asset.cash` is the one role whose accounts are conventionally typed 'bank'
// rather than 'asset'; balanceSheetSectionFor already folds bank into asset, so
// no special case is needed here — this note exists so a future reader does not
// add one.
const classAgrees = (role, accountType) => {
  const klass = roleMeta(role)?.class;
  if (!CHECKABLE_CLASSES.has(klass)) return true;
  const section = balanceSheetSectionFor(accountType);
  // An unclassifiable declared type is not a disagreement — it is the absence of
  // evidence, and the role is what resolves it (the classifiedAccountType rule).
  if (section === 'unknown') return true;
  return section === klass;
};

const normalBalanceAgrees = (role, normalBalance) => {
  const meta = roleMeta(role);
  if (!meta) return false;
  // Bidirectional and control/clearing roles carry no fixed normal balance.
  if (meta.bidirectional || !meta.normal_balance) return true;
  const declared = String(normalBalance || '').trim().toLowerCase();
  if (!declared) return true;
  return declared === meta.normal_balance;
};

const DEFAULT_CONFIDENCE_FLOOR = 0.8;

const accountRef = (account) => ({
  account_id: account.id ?? null,
  code: account.code ?? null,
  name: account.name ?? null,
  account_type: account.account_type ?? null,
  normal_balance: account.normal_balance ?? null
});

/**
 * Plan canonical-role resolution for one client's chart.
 *
 * Pure: no DB, no model call, no clock. The strong model's proposals come IN as
 * data (`proposals`) so the whole decision surface is testable, and so the
 * Keep-layer refusals below can be exercised without a model in the loop.
 *
 * @param {object}   params
 * @param {Array}    params.accounts        [{ id, code, name, account_type, normal_balance, canonical_role }]
 * @param {Array}    params.proposals       [{ account_id, role, confidence, rationale }] from the strong model
 * @param {Array}    params.requiredRoles   singleton roles this client's posting paths need (e.g. a
 *                                          VAT-registered GB client needs liability.sales_tax_payable)
 * @param {number}   params.confidenceFloor below this a proposal is asked, never posted
 * @returns {{assignments: Array, asks: Array, rejected: Array, alreadyResolved: Array, receipt: object}}
 */
export const planCanonicalRoleResolution = ({
  accounts = [],
  proposals = [],
  requiredRoles = [],
  confidenceFloor = DEFAULT_CONFIDENCE_FLOOR
} = {}) => {
  const chart = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  const byId = new Map(chart.map((account) => [String(account.id), account]));

  // Roles already settled on this chart. Never overwritten — the same rule
  // `backfill_canonical_roles.js` binds itself to, and the same coalesce-FILL
  // discipline the posting upsert follows (firmDb.js:15103-15106).
  const alreadyResolved = chart
    .filter((account) => String(account.canonical_role || '').trim())
    .map((account) => ({
      ...accountRef(account),
      terminal: 'already_resolved',
      role: String(account.canonical_role).trim()
    }));

  const heldRoleCounts = new Map();
  for (const held of alreadyResolved) {
    heldRoleCounts.set(held.role, (heldRoleCounts.get(held.role) || 0) + 1);
  }

  const rejected = [];
  const survivors = [];

  for (const proposal of Array.isArray(proposals) ? proposals.filter(Boolean) : []) {
    const account = byId.get(String(proposal.account_id));
    // A proposal for an account that is not in the chart, or for one whose role
    // is already settled, is not an error to report — it is simply not work.
    if (!account) continue;
    if (String(account.canonical_role || '').trim()) continue;

    const role = String(proposal.role || '').trim();
    const confidence = Number(proposal.confidence);
    const base = { ...accountRef(account), role, confidence: Number.isFinite(confidence) ? confidence : null, rationale: proposal.rationale ?? null };

    if (!isAccountRole(role)) {
      rejected.push({ ...base, refusal: 'role_unknown' });
      continue;
    }
    if (!classAgrees(role, account.account_type)) {
      rejected.push({ ...base, refusal: 'class_mismatch' });
      continue;
    }
    if (!normalBalanceAgrees(role, account.normal_balance)) {
      rejected.push({ ...base, refusal: 'normal_balance_conflict' });
      continue;
    }
    if (!Number.isFinite(confidence) || confidence < confidenceFloor) {
      rejected.push({ ...base, refusal: 'below_confidence_floor' });
      continue;
    }
    survivors.push(base);
  }

  // ── Singleton contention ───────────────────────────────────────────────────
  // Counted across BOTH the surviving proposals and the roles already held, so a
  // proposal cannot quietly become the second account on a role some existing
  // row already owns.
  const contenders = new Map();
  for (const survivor of survivors) {
    if (!isSingletonRole(survivor.role)) continue;
    contenders.set(survivor.role, [...(contenders.get(survivor.role) || []), survivor]);
  }

  const assignments = [];
  const asks = [];

  for (const survivor of survivors) {
    if (!isSingletonRole(survivor.role)) {
      assignments.push({ ...survivor, terminal: 'assign' });
      continue;
    }
    const competing = contenders.get(survivor.role) || [];
    const held = heldRoleCounts.get(survivor.role) || 0;
    if (competing.length + held > 1) continue; // handled below, as one ask per role
    assignments.push({ ...survivor, terminal: 'assign' });
  }

  for (const [role, competing] of contenders) {
    const held = heldRoleCounts.get(role) || 0;
    if (competing.length + held <= 1) continue;
    asks.push({
      terminal: 'ask_owner',
      role,
      role_label: roleMeta(role)?.label || role,
      refusal: 'singleton_contended',
      candidates: competing.map(({ account_id, code, name, account_type, normal_balance, confidence, rationale }) => ({
        account_id, code, name, account_type, normal_balance, confidence, rationale
      })),
      // The chart already holds an account on this role AND the model proposed
      // more — the owner is choosing against a standing assignment, so the ask
      // must say so rather than presenting the candidates as a clean slate.
      held_count: held
    });
    for (const competitor of competing) rejected.push({ ...competitor, refusal: 'singleton_contended' });
  }

  // ── Required roles with nothing to assign ──────────────────────────────────
  // The OUTBOUND_AR_NO_SALES_TAX_ACCOUNT case. Today this is a 409 the owner
  // never sees; here it becomes the owner's question, with every account the
  // Keep layer would accept offered as a candidate.
  const assignedRoles = new Set(assignments.map((assignment) => assignment.role));
  const askedRoles = new Set(asks.map((ask) => ask.role));
  const rejectedByAccount = new Set(rejected.map((entry) => String(entry.account_id)));

  for (const required of Array.isArray(requiredRoles) ? requiredRoles.filter(Boolean) : []) {
    const role = String(required).trim();
    if (!isAccountRole(role)) continue;
    if (assignedRoles.has(role) || askedRoles.has(role)) continue;
    if ((heldRoleCounts.get(role) || 0) >= 1) continue;

    // Candidates are the unroled accounts this role COULD legally land on. That
    // is the Keep layer offering a menu, not a guess: every one of these would
    // pass class and normal-balance agreement, and the owner picks which is
    // theirs. Ordering is by code then name so the ask is stable across runs.
    const candidates = chart
      .filter((account) => !String(account.canonical_role || '').trim())
      .filter((account) => classAgrees(role, account.account_type) && normalBalanceAgrees(role, account.normal_balance))
      .map(accountRef)
      .sort((a, b) => String(a.code || a.name || '').localeCompare(String(b.code || b.name || ''), undefined, { numeric: true }));

    asks.push({
      terminal: 'ask_owner',
      role,
      role_label: roleMeta(role)?.label || role,
      refusal: 'no_candidate',
      candidates,
      held_count: 0,
      // True when the model DID propose something for this role and the Keep
      // layer refused all of it. The ask is the same question either way, but a
      // caller drafting it should know the difference between "Donna had no idea"
      // and "Donna had an idea the invariants would not let her act on".
      had_refused_proposals: candidates.some((candidate) => rejectedByAccount.has(String(candidate.account_id)))
    });
  }

  // ── Refusal accounting — nothing invisible ─────────────────────────────────
  // Partition every rejection into a named lane. `deferred` is the remainder
  // that reached NEITHER terminal this run: refused proposals whose role no ask
  // covers and whose account no other proposal settled. Per the dated call
  // (Kari, 2026-08-01, option B) that set rests on the next sweep — on Donna,
  // not the firm — and the receipt COUNTS it rather than asserting it away.
  const finalAskedRoles = new Set(asks.map((ask) => ask.role));
  const assignedAccountIds = new Set(assignments.map((assignment) => String(assignment.account_id)));
  const deferred = [];
  for (const entry of rejected) {
    if (finalAskedRoles.has(entry.role)) continue; // represented in an owner ask
    if (assignedAccountIds.has(String(entry.account_id))) continue; // account settled anyway
    deferred.push({
      account_id: entry.account_id,
      code: entry.code,
      name: entry.name,
      role: entry.role,
      refusal: entry.refusal,
      confidence: entry.confidence ?? null
    });
  }

  return {
    assignments,
    asks,
    rejected,
    deferred,
    alreadyResolved,
    receipt: {
      accounts_considered: chart.length,
      proposals_received: Array.isArray(proposals) ? proposals.filter(Boolean).length : 0,
      assigned: assignments.length,
      asked: asks.length,
      rejected: rejected.length,
      deferred_to_next_sweep: deferred.length,
      already_resolved: alreadyResolved.length,
      confidence_floor: confidenceFloor,
      // Machine-checkable rather than hoped: every rejection above is in a
      // named lane (an owner ask, mooted by an assignment, or counted in
      // deferred_to_next_sweep). The deferral lane rests on the SWEEP, not on
      // a firm click, so nothing rests firm-side (Kari, 2026-08-01, option B).
      unresolved_resting_firm_side: 0
    }
  };
};
