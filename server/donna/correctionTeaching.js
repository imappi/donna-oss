// Correction scope + the correction≠teaching receipt — G1(d), build-spec
// PR-11.
//
// Doctrine (plan §5 G1d, round 2's sharpest product point): "fix this
// transaction" NEVER silently means "learn a durable rule" or "contribute
// a cross-firm signal". Four separate consequences, only the first
// defaulting on: (1) correct this object; (2) remember for this entity;
// (3) create a future merchant rule; (4) contribute a quarantined
// product-level signal. This module owns the grammar and the receipt for
// (1), and the refusal that keeps (2)-(4) with their EXPLICIT verbs
// (remember_fact / remember_merchant; (4) is DECIDED OFF for ordinary
// corrections — §7.6, Kari 2026-08-14 — remember_merchant is the only
// signal mint) — one mint path per consequence, each with its own Apply
// click.
//
// Pure leaf: no DB, no imports beyond the standard library. Shared by the
// feed sanitizer (demote-with-note — proposals stay appliable), the two
// apply routes (refuse-at-apply backstop — the per-transaction chat has
// no proposal-time sanitizer, so a stale/forged request must read a
// refusal here), and the receipt builders on both surfaces (one owner —
// both chat surfaces report identically, the PR-9 lock-step rule).

// The verbs that CORRECT the book (override Donna's coding) and therefore
// carry the correction grammar. Teaching verbs (remember_merchant,
// remember_fact) are deliberately NOT here — their whole point is scope.
export const CORRECTION_SCOPE_ACTION_TYPES = Object.freeze([
  'apply_category',
  'recode_decided',
  'mark_personal'
]);

// The closed scope enum (plan §5 G1d). The narrowest is the default —
// a null/absent correction_scope means 'transaction'. 'global_candidate'
// is NEVER a default and never appliable from a correction verb.
export const CORRECTION_SCOPES = Object.freeze([
  'transaction',
  'case',
  'client',
  'merchant_for_client',
  'global_candidate'
]);

// Scopes a correction verb may CARRY (recorded on the receipt + audit):
// they declare breadth of intent without minting anything.
export const NON_TEACHING_CORRECTION_SCOPES = Object.freeze(['transaction', 'case']);

// Scopes that CLAIM durable teaching. On a correction verb these demote
// (feed sanitize) or refuse (apply backstop) — durable teaching happens
// ONLY through the explicit verbs, so a correction receipt can never
// claim a memory that was not minted.
export const TEACHING_CORRECTION_SCOPES = Object.freeze([
  'client',
  'merchant_for_client',
  'global_candidate'
]);

// The closed reason taxonomy (plan §5 G1d) — feeds eval promotion and
// signal governance. 'other' keeps the enum honest: a closed list with no
// escape invites laundering the eighth reason into the seventh.
export const CORRECTION_REASON_CODES = Object.freeze([
  'wrong_category',
  'personal_expense',
  'duplicate',
  'stale_memory',
  'one_off_exception',
  'other'
]);

export const CORRECTION_RECURRENCES = Object.freeze(['one_off', 'recurring']);

// Why each teaching scope is redirected — shared verbatim by the
// sanitizer note and the apply refusal so the two surfaces never drift.
export const TEACHING_SCOPE_REDIRECTS = Object.freeze({
  client:
    'a correction changes only the selected rows; durable client/entity memory is '
    + 'remember_fact — propose it as its own action so the firm applies it explicitly.',
  merchant_for_client:
    'a correction changes only the selected rows; a future-lines merchant rule is '
    + 'remember_merchant — propose it as its own action so the firm applies it explicitly.',
  global_candidate:
    'global is never a default and has no explicit-scope path from a correction; an ordinary '
    + 'correction contributes no cross-firm signal (§7.6, decided 2026-08-14) — '
    + 'remember_merchant is the only signal mint.'
});

const isIsoDateString = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value.trim()) && !Number.isNaN(Date.parse(value));

const isFutureDate = (value, now = Date.now()) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now;
};

// ─── Proposal-time sanitize (feed chat) ──────────────────────────────────
//
// Field-level demotion, never action-level: the correction itself stays
// appliable — only a field that would make the receipt LIE (claim a
// teaching that will not happen, promise a time bound nothing enforces)
// is nulled, with a note the ProposalCard can render. Non-correction
// action types pass through untouched (their correction fields are
// schema-nullable noise; the apply paths never read them).
export const sanitizeCorrectionScopeFields = (action, { now = Date.now() } = {}) => {
  if (!action || !CORRECTION_SCOPE_ACTION_TYPES.includes(action.type)) return action;
  const notes = [];
  const out = { ...action };

  const scope = out.correction_scope;
  if (scope != null) {
    if (!CORRECTION_SCOPES.includes(scope)) {
      notes.push(`correction_scope "${scope}" is not in the closed enum — recorded as the narrowest (this transaction).`);
      out.correction_scope = null;
    } else if (TEACHING_CORRECTION_SCOPES.includes(scope)) {
      notes.push(`correction_scope "${scope}" demoted to the narrowest: ${TEACHING_SCOPE_REDIRECTS[scope]}`);
      out.correction_scope = null;
      out.correction_scope_demoted_from = scope;
    }
  }

  if (out.reason_code != null && !CORRECTION_REASON_CODES.includes(out.reason_code)) {
    notes.push(`reason_code "${out.reason_code}" is not in the closed taxonomy — dropped.`);
    out.reason_code = null;
  }

  if (out.recurrence != null) {
    if (!CORRECTION_RECURRENCES.includes(out.recurrence)) {
      notes.push(`recurrence "${out.recurrence}" is not one_off/recurring — dropped.`);
      out.recurrence = null;
    } else if (out.recurrence === 'recurring') {
      notes.push(
        'recurrence "recurring" dropped: an unscoped correction changes only the selected rows — '
        + 'recurring behavior is remember_merchant / remember_fact.'
      );
      out.recurrence = null;
    }
  }

  if (out.effective_until != null) {
    notes.push(
      'effective_until dropped: time-bounded corrections are not enforced anywhere yet — '
      + 'a receipt must not promise a bound nothing checks. Record the bound in the reason text.'
    );
    out.effective_until = null;
  }

  if (out.effective_from != null) {
    if (!isIsoDateString(out.effective_from)) {
      notes.push(`effective_from "${out.effective_from}" is not an ISO date — dropped.`);
      out.effective_from = null;
    } else if (isFutureDate(out.effective_from, now)) {
      notes.push('effective_from is in the future — dropped: scheduled corrections are not supported; the change applies now.');
      out.effective_from = null;
    }
  }

  return notes.length ? { ...out, correction_notes: notes } : out;
};

// ─── Apply-time backstop (both surfaces) ─────────────────────────────────
//
// The per-transaction chat has NO proposal-time sanitizer, and a feed
// apply can be replayed from a stale message — so the apply route
// re-refuses what the sanitizer would have demoted. Returns null when the
// action is appliable, or a one-line refusal message (HTTP 400) naming
// the right verb. Mirrors the factRequestsAutonomy dual-guard pattern.
export const validateCorrectionFieldsForApply = (action, { now = Date.now() } = {}) => {
  if (!action || !CORRECTION_SCOPE_ACTION_TYPES.includes(action.type)) return null;
  const scope = action.correction_scope;
  if (scope != null) {
    if (!CORRECTION_SCOPES.includes(scope)) {
      return `correction_scope "${scope}" is not in the closed enum.`;
    }
    if (TEACHING_CORRECTION_SCOPES.includes(scope)) {
      return `correction_scope "${scope}" is not appliable on a correction — ${TEACHING_SCOPE_REDIRECTS[scope]}`;
    }
  }
  if (action.reason_code != null && !CORRECTION_REASON_CODES.includes(action.reason_code)) {
    return `reason_code "${action.reason_code}" is not in the closed taxonomy.`;
  }
  if (action.recurrence != null && action.recurrence !== 'one_off') {
    return 'recurrence beyond one_off is not appliable on a correction — recurring behavior is remember_merchant / remember_fact.';
  }
  if (action.effective_until != null) {
    return 'effective_until is not appliable: time-bounded corrections are not enforced anywhere yet.';
  }
  if (action.effective_from != null && (!isIsoDateString(action.effective_from) || isFutureDate(action.effective_from, now))) {
    return 'effective_from must be a past-or-today ISO date — scheduled corrections are not supported.';
  }
  return null;
};

// ─── The correction≠teaching receipt ─────────────────────────────────────
//
// Composed from ACTUAL outcomes, never intent (the
// render-the-persisted-verdict rail applied to receipts). The receipt
// states the FULL negative — no rule, no memory, no cross-firm signal —
// and since §7.6's dated call (2026-08-14) that negative is knowable at
// writer time on BOTH surfaces: no correction verb has a signal path
// anywhere, so the feed and the txn chat report identically (the PR-9
// lock-step rule). The per-surface `surfaceHasSignalPath` split and the
// response-side `appendSignalSentence` enrichment retired WITH the
// pending state they existed to report honestly.
//
// DMEM-R1 W1 (2026-09-04, doctrine INV-04; audit F-03, S04/L3): the receipt is
// built from the writer's COMMITTED learning effects (`committed`, the
// `learning` object updateTransactionReviewItemInDb returns), never from the
// surface's intent. `rule_minted` / `memory_minted` are true exactly when the
// apply committed an ACTIVE rule / fact; a staged candidate is reported as
// `candidates_staged` (a proposal on the owner, not memory). Absent `committed`
// (a writer that has no learning path at all) every count is zero — which is
// then also the truth, because no correction verb can mint without one.
const countLearning = (value) => (Array.isArray(value) ? value.length : Number(value) || 0);

export const mergeCommittedLearning = (parts = []) => {
  const merged = { rules_minted: 0, facts_minted: 0, candidates_staged: 0 };
  for (const part of Array.isArray(parts) ? parts : [parts]) {
    if (!part || typeof part !== 'object') continue;
    merged.rules_minted += (Array.isArray(part.rules_minted)
      ? part.rules_minted.filter((row) => !row || row.status == null || row.status === 'active').length
      : countLearning(part.rules_minted));
    merged.facts_minted += countLearning(part.facts_minted);
    merged.candidates_staged += countLearning(part.candidates_staged);
  }
  return merged;
};

export const buildCorrectionTeachingReceipt = ({ action = {}, changedCount = 1, committed = null } = {}) => {
  const scope = NON_TEACHING_CORRECTION_SCOPES.includes(action.correction_scope)
    ? action.correction_scope
    : 'transaction';
  const changed = changedCount === 1
    ? 'Changed this transaction.'
    : `Changed ${changedCount} transactions.`;
  const learning = mergeCommittedLearning(committed ? [committed] : []);
  const ruleMinted = learning.rules_minted > 0;
  const memoryMinted = learning.facts_minted > 0;
  const staged = learning.candidates_staged > 0
    ? ` ${learning.candidates_staged === 1 ? 'One learning candidate was' : `${learning.candidates_staged} learning candidates were`} staged for your review — nothing acts on it until you confirm it.`
    : '';
  const negative = !ruleMinted && !memoryMinted
    ? ' Future behavior was not changed: no merchant rule, firm memory, or cross-firm signal was created.'
    : ` Future behavior changed: ${[ruleMinted ? 'a merchant rule was activated' : null, memoryMinted ? 'firm memory was recorded' : null].filter(Boolean).join(' and ')}; no cross-firm signal was created.`;
  return {
    correction_scope: scope,
    reason_code: CORRECTION_REASON_CODES.includes(action.reason_code) ? action.reason_code : null,
    effective_from: typeof action.effective_from === 'string' ? action.effective_from : null,
    rule_minted: ruleMinted,
    memory_minted: memoryMinted,
    candidates_staged: learning.candidates_staged,
    text: `${changed}${negative}${staged}`
  };
};
