// Donna Loops — Phase 2 deterministic preflight. Produces a CheckReport
// (operatorContract.js CHECK_REPORT_SCHEMA) for a ProposalCard from PRE-FETCHED
// state. It is intentionally a PURE function: no LLM, no external calls, no DB
// reads — the caller fetches the target/period state and passes it in. That keeps
// INV-10 (deterministic apply) and INV-11 (no external call in a DB txn) trivially
// satisfied, and the whole module unit-testable without a database.
//
// These are the Keep-layer arithmetic / version / period gates from Phase 0 §3e.
// They VALIDATE; they never substitute for the model's judgment (trust-the-
// strong-LLM): the strong model proposes the coding/match, and the deterministic
// preflight only checks the things arithmetic and concurrency can decide —
// existence, staleness, locked periods, balanced totals, and structural
// tax-code ↔ jurisdiction validity (is the code even from this country's set —
// not whether the treatment is right).
//
// Each check emits ONLY when it has the inputs to decide it, so a minimal call
// (just targets + their state) still returns a meaningful, non-misleading report.
// Severity is CHECK_STATUSES order (summarizeCheckReport): fail blocks the Apply
// button, requires_review escalates the review mode, warning renders.
//
// BOUNDARY — shadow vs real gating. Every check operates on the state the CALLER
// SUPPLIES (e.g. `targets_exist` means "present in the supplied target state", not a
// live DB read). Omitting an undecidable check is correct HERE because nothing gates
// on this verdict yet (Phase 2 is shadow). When preflight gates a REAL apply
// (Phase 3+), the caller must supply authoritative DB-read state (current target
// version, period-lock, decided rows) and a MISSING authoritative input must then
// fail-closed (requires_review/fail), never be silently omitted.

import { summarizeCheckReport } from './operatorContract.js';
import { classifyTaxCodeForJurisdiction, classifyTaxCodeForPolicy, jurisdictionVocabulary } from './taxCodeJurisdiction.js';

const TOLERANCE = 0.01;
const mkCheck = (name, status, detail = null) => ({ name, status, detail });

// The Keep-layer confidence floor (CLAUDE.md L1: "low-confidence stays proposed
// (never posted)"). 0.75 matches the codebase's existing per-producer floors
// (DEFAULT_SETTLEMENT_ACCOUNT_CONFIDENCE_FLOOR / the disposition floor), so the
// generic preflight gate and the producer floors agree. Under the 100%
// self-service model this is load-bearing: a low-confidence answer that
// auto-posts has NO professional catch — it must stay proposed.
export const DEFAULT_CONFIDENCE_FLOOR = 0.75;

// ─── Slice D: accounting-domain checks from Slice-C risk flags ──────────────
//
// preflight stays a PURE LEAF: it does NOT import operatorCaseSnapshot.js (a
// heavy module). Instead, consistent with the existing contract ("the caller
// fetches the state and passes it in"), the caller computes the risk flags via
// `deriveCaseRiskFlags` (Slice C) — supplying the `riskContext` that resolves
// materiality/first-use/duplicate/tax — and hands the RESULT in. This module
// turns those flags into deterministic CheckReport entries.
//
// These checks VALIDATE; they do not substitute for the model's judgment
// (trust-the-strong-LLM). A FIRED flag escalates a check; 'clear' is a pass;
// 'unknown' OMITS the check — preflight only emits a check it has the inputs to
// decide (the same rule the Phase-0 checks follow). In shadow that omission is
// correct; when this gates a REAL apply, the caller must supply the context so
// the flag resolves rather than staying unknown (the BOUNDARY note below).

// How a FIRED accounting-domain risk flag maps onto check severity
// (CHECK_STATUSES). suspense/first-use RENDER (warning); evidence/materiality/
// duplicate/tax ESCALATE the review mode (requires_review) — none HARD-blocks,
// because a deliberate, authorized apply of a flagged line is legitimate; the
// arithmetic gates above are the only `fail`s.
const RISK_FLAG_CHECK_SEVERITY = Object.freeze({
  suspense_exposure: 'warning',
  evidence_required: 'requires_review',
  materiality_band: 'requires_review',
  first_use_account: 'warning',
  duplicate_risk: 'requires_review',
  tax_treatment_required: 'requires_review'
});

const riskFlagDetail = (kind, flag) => {
  const bits = [];
  if (kind === 'materiality_band' && flag.amount != null) {
    bits.push(`${flag.amount}${flag.currency ? ' ' + flag.currency : ''}${flag.band ? ' (' + flag.band + ')' : ''}`);
  }
  if (kind === 'first_use_account' && flag.account) bits.push(`account: ${flag.account}`);
  if (kind === 'duplicate_risk' && Array.isArray(flag.candidate_ids) && flag.candidate_ids.length) {
    bits.push(`candidates: ${flag.candidate_ids.join(', ')}`);
  }
  if (kind === 'suspense_exposure' && flag.coded_account !== undefined) {
    bits.push(`coded: ${flag.coded_account ?? 'none'}`);
  }
  if (flag.reason) bits.push(flag.reason);
  return bits.length ? bits.join(' · ') : null;
};

// Map a Slice-C risk-flags object ({present, flags, ...}) to check entries.
// Exported so it is independently testable and reusable by a non-card caller.
export const accountingChecksFromRiskFlags = (riskFlags) => {
  const out = [];
  if (!riskFlags || riskFlags.present !== true || !riskFlags.flags) return out;
  for (const [kind, firedSeverity] of Object.entries(RISK_FLAG_CHECK_SEVERITY)) {
    const flag = riskFlags.flags[kind];
    if (!flag) continue;
    if (flag.status === 'clear') { out.push(mkCheck(kind, 'pass', flag.reason || null)); continue; }
    if (flag.status === 'flagged') { out.push(mkCheck(kind, firedSeverity, riskFlagDetail(kind, flag))); continue; }
    // 'unknown' → omit: undecidable without the context the snapshot didn't load.
  }
  return out;
};

// The match/FX check DELEGATES to the persisted reconciliationLlmCore verdict —
// it RENDERS it, it never re-checks (the "render the persisted verdict" rail;
// Failure-B is already fixed upstream by the strong matcher). `matchVerdict` is
// the persisted evaluation the caller read: { reconciles: boolean, reason? }.
// Absent ⇒ no check (nothing to render).
export const matchVerdictCheck = (matchVerdict) => {
  if (!matchVerdict || typeof matchVerdict.reconciles !== 'boolean') return null;
  return mkCheck(
    'match_reconciles',
    matchVerdict.reconciles ? 'pass' : 'requires_review',
    matchVerdict.reason || (matchVerdict.reconciles ? null : 'persisted reconciliation verdict: does not reconcile')
  );
};

// confidence_holds — the L1 "low-confidence stays proposed (never posted)"
// invariant, as a pure card-level gate. A model-supplied confidence below the
// floor escalates to `requires_review` — NOT a hard `fail`: the diff engine
// reads requires_review as appliable-but-no-AUTO-commit, which is exactly "stays
// proposed" (a deliberate, authorized apply is still legitimate). Emits ONLY when
// the card carries a numeric confidence (the module's "decide only what you have
// inputs for" rule); a card with no confidence is undecidable here, not a pass.
// Deterministic defense-in-depth behind the producers' own floors, the same
// posture as re-checking the materiality ceiling at post time.
export const confidenceHoldsCheck = (confidence, floor = DEFAULT_CONFIDENCE_FLOOR) => {
  // Require a GENUINE number — never coerce. Number(null)===0 / Number('')===0
  // would turn "no confidence supplied" into a spurious below-floor escalation;
  // the module's contract is to OMIT an undecidable check, not invent one.
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  const c = confidence;
  const f = Number.isFinite(Number(floor)) ? Number(floor) : DEFAULT_CONFIDENCE_FLOOR;
  return c >= f
    ? mkCheck('confidence_holds', 'pass', null)
    : mkCheck('confidence_holds', 'requires_review', `confidence ${c} below floor ${f} — stays proposed, never auto-posted`);
};

// tax_code_jurisdiction — the Keep-layer "tax-code ↔ jurisdiction compatibility"
// invariant (CLAUDE.md L1). A proposed tax code must belong to the vocabulary the
// client's onboarding jurisdiction mandates (taxCodeJurisdiction.js is the
// registry). This is VALIDITY (set membership), not TREATMENT: it catches a
// Singapore GST code leaking onto a Finnish client's line — the Failure-A class
// of jurisdiction bleed — not whether a rate is right (that stays the model's
// judgment).
//
// Severity is `fail`, NOT the `requires_review` the risk-flag escalations use,
// and deliberately so: a foreign-jurisdiction code is a STRUCTURAL error, in the
// same class as the arithmetic/version gates — there is no scenario where an
// owner should be able to apply a Finnish ALV code onto a US ledger, so it must
// block the Apply button (the safe next action is RE-CODE → auto_reconciled, a
// firm/model remediation, never an owner ask). A risk flag (materiality,
// evidence) can be deliberately, legitimately applied; a wrong-country code
// cannot. Emits ONLY when it can decide: a code present AND a registered
// jurisdiction to check it against (every ICP jurisdiction — fi/sg/gb/au/us —
// has been registered since 2026-07-23 via taxVocabularies.js; anything ELSE is
// UNDECIDABLE and omits, honest about the coverage gap rather than validating a
// line against another country's codes).
//
// Missing policy is a structural refusal when a tax treatment is proposed.
// Rollout flags cannot make a foreign-country code applicable.
export const taxJurisdictionCheck = (taxCode, jurisdiction, { codingPolicy = null, policyError = null } = {}) => {
  if (taxCode == null || String(taxCode).trim() === '') return null;
  if (policyError) return mkCheck('tax_code_jurisdiction', 'fail', policyError.code || 'coding_policy_unavailable');
  if (codingPolicy) {
    const valid = classifyTaxCodeForPolicy(codingPolicy, taxCode) === 'valid';
    return mkCheck('tax_code_jurisdiction', valid ? 'pass' : 'fail', valid ? null : `tax code '${String(taxCode).trim()}' is not valid for policy ${codingPolicy.policyId}@${codingPolicy.policyVersion}`);
  }
  const verdict = classifyTaxCodeForJurisdiction(taxCode, jurisdiction);
  if (verdict === 'valid') return mkCheck('tax_code_jurisdiction', 'pass', null);
  const entry = jurisdictionVocabulary(jurisdiction);
  const jurLabel = `${String(jurisdiction || 'unresolved').trim().toUpperCase()}${entry ? ` (${entry.label})` : ''}`;
  return mkCheck('tax_code_jurisdiction', 'fail', verdict === 'undecidable'
    ? `coding policy is unresolved for jurisdiction ${jurLabel}`
    : `tax code '${String(taxCode).trim()}' is not valid for jurisdiction ${jurLabel}`);
};

// ─── "Not just no" — the safe next action + the terminal it targets ─────────
//
// The two-terminal-states FIRST principle (CLAUDE.md) says nothing rests in a
// firm-side limbo: a line is either AUTO-RECONCILED or ON THE OWNER. A bare
// "this check escalates" is exactly that forbidden limbo. So when a flag fires,
// preflight ALSO classifies the safe next action and WHICH terminal it drives
// toward — deterministically, conservatively, and WITHOUT deciding the coding
// (that stays the model's judgment). The ONLY branch that routes to the owner is
// `evidence_required` (the one thing only the owner can answer); everything else
// is a firm/model remediation that ends AUTO-RECONCILED. The CheckReport schema
// is closed, so this is a SIBLING artifact, never a field on the report.
//
// Precedence = most owner-blocking first. The first FIRED flag wins.
const REMEDIATION_PRECEDENCE = Object.freeze([
  ['evidence_required',      { safe_next_action: 'request_evidence',         terminal_target: 'on_owner' }],
  ['duplicate_risk',         { safe_next_action: 'review_duplicate',         terminal_target: 'auto_reconciled' }],
  ['materiality_band',       { safe_next_action: 'seek_delegated_authority', terminal_target: 'auto_reconciled' }],
  ['tax_treatment_required', { safe_next_action: 'classify_tax_treatment',   terminal_target: 'auto_reconciled' }],
  ['first_use_account',      { safe_next_action: 'confirm_account',          terminal_target: 'auto_reconciled' }],
  ['suspense_exposure',      { safe_next_action: 'recode_from_suspense',     terminal_target: 'auto_reconciled' }]
]);

// Given the Slice-C risk flags, name the safe next action + terminal target.
//   - any flag fired      → its remediation (owner-blocking flags first)
//   - none fired, some unknown → 'resolve_context' (terminal undecidable until
//     the caller supplies the missing context — an HONEST non-terminal, surfaced)
//   - all clear           → 'apply' → auto_reconciled
//   - no flags present     → null (nothing to classify)
export const classifyRemediation = (riskFlags) => {
  if (!riskFlags || riskFlags.present !== true || !riskFlags.flags) return null;
  const flags = riskFlags.flags;
  for (const [kind, remediation] of REMEDIATION_PRECEDENCE) {
    if (flags[kind]?.status === 'flagged') {
      return { ...remediation, reason: `flag:${kind}` };
    }
  }
  const unknown = Object.keys(flags).filter((k) => flags[k]?.status === 'unknown');
  if (unknown.length) {
    return { safe_next_action: 'resolve_context', terminal_target: null, reason: `flags_unknown:${unknown.join(',')}` };
  }
  return { safe_next_action: 'apply', terminal_target: 'auto_reconciled', reason: 'all_flags_clear' };
};

export const runDeterministicPreflight = ({
  card, targetStates = {}, decidedTargets = [], period = null,
  // Slice D — the accounting-domain inputs, PRE-COMPUTED by the caller and
  // passed in (preflight stays a pure leaf). `riskFlags` is a Slice-C
  // deriveCaseRiskFlags result; `matchVerdict` is the persisted
  // reconciliationLlmCore evaluation to RENDER (not re-check). Both optional —
  // omitted ⇒ those checks simply don't emit (shadow-safe).
  riskFlags = null, matchVerdict = null,
  // The Keep-layer confidence floor for the L1 low-confidence gate. Defaults to
  // the shared 0.75; a caller may pass a per-surface floor.
  confidenceFloor = DEFAULT_CONFIDENCE_FLOOR,
  // Tax-code ↔ jurisdiction validity (structural). `jurisdiction` is the
  // client's onboarding jurisdiction (clients.jurisdiction). `taxCode` is the
  // proposed code, passed in explicitly by the caller; when omitted it falls
  // back to card.detail.tax_treatment (the coder's persisted treatment). Both
  // optional — omitted ⇒ the check simply doesn't emit (shadow-safe).
  jurisdiction = null, taxCode = null, codingPolicy = null, policyError = null
} = {}) => {
  const checks = [];
  const targets = Array.isArray(card?.targets) ? card.targets.map(String) : [];
  const states = targetStates || {};

  // targets_exist — every proposed target must be present in the SUPPLIED state
  // (the caller's pre-fetched snapshot; see the BOUNDARY note above — not a live DB
  // read). A proposed target with no supplied state blocks.
  const missing = targets.filter((id) => !(id in states));
  checks.push(mkCheck(
    'targets_exist',
    missing.length ? 'fail' : 'pass',
    missing.length ? `missing target state: ${missing.join(', ')}` : null
  ));

  // no_target_already_decided — INV-4 stickiness. A target already in a decided
  // (sticky) state is re-verified, not silently re-written: escalate the review
  // mode rather than hard-block (a deliberate recode is legitimate).
  const decided = new Set((decidedTargets || []).map(String));
  if (decided.size) {
    const already = targets.filter((id) => decided.has(id));
    checks.push(mkCheck(
      'no_target_already_decided',
      already.length ? 'requires_review' : 'pass',
      already.length ? `already-decided targets re-touched: ${already.join(', ')}` : null
    ));
  }

  // version_match — optimistic concurrency. The precondition's
  // expected_updated_at is the object version captured at proposal time; if the
  // live object has moved since, the proposal is stale and must not apply blind.
  const preByObject = new Map();
  for (const p of Array.isArray(card?.preconditions) ? card.preconditions : []) {
    if (p && p.object != null) preByObject.set(String(p.object), p);
  }
  if (preByObject.size) {
    const stale = [];
    for (const id of targets) {
      const expected = preByObject.get(id)?.expected_updated_at ?? null;
      if (!expected) continue; // no recorded version → nothing to compare
      const current = states[id]?.updated_at ?? null;
      if (current && String(current) !== String(expected)) stale.push(id);
    }
    checks.push(mkCheck(
      'version_match',
      stale.length ? 'fail' : 'pass',
      stale.length ? `target changed since proposal: ${stale.join(', ')}` : null
    ));
  }

  // period_not_locked — a posting into a locked close period is blocked; near the
  // open-period boundary it renders a warning (the contract's own example).
  if (period) {
    if (period.locked) {
      checks.push(mkCheck('period_not_locked', 'fail', `period ${period.label ?? ''}`.trim() + ' is locked'));
    } else if (period.near_boundary) {
      checks.push(mkCheck('period_not_locked', 'warning', 'posts near the open-period boundary'));
    } else {
      checks.push(mkCheck('period_not_locked', 'pass', null));
    }
  }

  // totals_balance — arithmetic (Keep-layer), only when the detail carries the
  // numbers: subtotal + tax == total.
  const totals = card?.detail?.totals;
  if (totals && ['subtotal', 'tax', 'total'].every((k) => typeof totals[k] === 'number')) {
    const ok = Math.abs((totals.subtotal + totals.tax) - totals.total) < TOLERANCE;
    checks.push(mkCheck(
      'totals_balance',
      ok ? 'pass' : 'fail',
      ok ? null : `subtotal ${totals.subtotal} + tax ${totals.tax} != total ${totals.total}`
    ));
  }

  // journal_balances — arithmetic, only when the detail carries a journal:
  // debits == credits.
  const journal = card?.detail?.journal;
  if (journal && typeof journal.debits === 'number' && typeof journal.credits === 'number') {
    const ok = Math.abs(journal.debits - journal.credits) < TOLERANCE;
    checks.push(mkCheck(
      'journal_balances',
      ok ? 'pass' : 'fail',
      ok ? null : `debits ${journal.debits} != credits ${journal.credits}`
    ));
  }

  // confidence_holds — L1 low-confidence gate on the card's own confidence
  // (emits only when the card carries a numeric confidence).
  const confidenceCheck = confidenceHoldsCheck(card?.detail?.confidence, confidenceFloor);
  if (confidenceCheck) checks.push(confidenceCheck);

  // tax_code_jurisdiction — structural Keep-layer gate: the proposed tax code
  // must belong to the client's onboarding-jurisdiction vocabulary. Emits only
  // when a code AND a registered jurisdiction are both present.
  const proposedTaxCode = taxCode ?? card?.detail?.tax_treatment ?? null;
  const taxCheck = taxJurisdictionCheck(proposedTaxCode, jurisdiction, { codingPolicy, policyError });
  if (taxCheck) checks.push(taxCheck);

  // Accounting-domain checks (Slice D) — from the caller's pre-computed Slice-C
  // risk flags. Each fired flag escalates a check; clear passes; unknown omits.
  for (const check of accountingChecksFromRiskFlags(riskFlags)) checks.push(check);

  // Match/FX — render the persisted strong-matcher verdict (never re-check).
  const matchCheck = matchVerdictCheck(matchVerdict);
  if (matchCheck) checks.push(matchCheck);

  return summarizeCheckReport(checks);
};
