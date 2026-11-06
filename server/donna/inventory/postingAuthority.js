// Donna Inventory I4·posting — P7 §13 delegated-authority ceilings (the PURE check).
//
// Per-journal materiality alone is bypassable by a thousand small journals (design §13). An
// inventory posting grant (the 040 reconciliation_authority_grants pattern, extended — migration
// 083) authorizes UNATTENDED posting for a class of inventory journals, bounded by: allowed
// posting kinds, allowed accounts, a per-journal ceiling, a DAILY aggregate ceiling, a PERIOD
// aggregate ceiling, currency, a confidence floor, evidence requirements, a validity window, and
// jurisdiction. This module is the PURE, fail-closed authorization decision — no DB, no I/O, no
// Date.now/Math.random/new Date (asOf is injected). The read-side that gathers the grant + the
// already-posted aggregates lives in postingAuthorityDb.js; the executor consults this verdict
// BEFORE a post in a later (isolation-class) wiring slice — like P6b's consumption primitive, the
// check ships ready and the trigger wires later.
//
// KEEP-LAYER, NOT INTELLIGENCE-SUBSTITUTING: this is deterministic authorization arithmetic (does
// this proposed post fit inside a human-minted authority envelope?). It does NOT re-decide the
// model's classification — it only decides WHETHER the model's proposal may post unattended, or
// must escalate to a human. Every doubt → NOT authorized (the line escalates, never silently posts).

// The event classes that ALWAYS escalate regardless of amount or any covering grant (design §13):
// a write-down and a private-use posting are accounting-judgment events; a first-use account
// mapping and an unusual count variance are config/anomaly events. No grant can pre-authorize
// them — they are the accountant/operator's by construction.
export const ALWAYS_ESCALATE_POSTING_KINDS = Object.freeze(['write_down', 'private_use']);

// The closed set of authorization breach reasons (why a proposed post is NOT authorized to post
// unattended). Each names the specific envelope boundary crossed, so the escalation is legible.
export const POSTING_AUTHORITY_BREACHES = Object.freeze([
  'no_grant',
  'grant_inactive',
  'grant_corrected',
  'event_class_always_escalates',
  'kind_not_allowed',
  'account_not_allowed',
  'currency_mismatch',
  'confidence_below_floor',
  'evidence_required',
  'per_journal_ceiling',
  'daily_aggregate_ceiling',
  'period_aggregate_ceiling',
  'not_yet_valid',
  'expired',
  'review_due',
  'jurisdiction_mismatch'
]);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const normCcy = (c) => String(c ?? '').trim().toUpperCase();
const toEpoch = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const asArray = (v) => (Array.isArray(v) ? v : []);

const deny = (reason, detail = {}) => ({ authorized: false, reason, detail });

// checkInventoryPostingAuthority — the fail-closed §13 ladder. Returns
//   { authorized: true,  reason: null, detail }  — the proposed post fits the grant envelope
//   { authorized: false, reason: <breach>, detail }  — it must escalate (the reason names why)
//
// `proposed`: {
//   postingKind, amount (functional, > 0), currency, accountRoles: string[] (every role the
//   journal touches), confidence (0..1|null), evidencePresent (bool), firstUseAccount (bool),
//   unusualCountVariance (bool), jurisdiction (string|null)
// }
// `aggregates`: { dailyPosted, periodPosted } — the amount ALREADY posted under this grant in the
//   day / period window (from postingAuthorityDb; 0 when none). The proposed amount is ADDED to
//   each before the ceiling test, so the grant bounds cumulative unattended posting, not just one.
// `grant`: the migration-083 row (or null). `asOf`: the decision instant (injected, never new Date()).
export const checkInventoryPostingAuthority = ({
  grant = null, proposed = {}, aggregates = {}, asOf = null
} = {}) => {
  const postingKind = proposed.postingKind ?? proposed.posting_kind ?? null;
  const amount = num(proposed.amount);
  const currency = normCcy(proposed.currency);
  const accountRoles = asArray(proposed.accountRoles ?? proposed.account_roles);

  // Event-class escalation is checked FIRST and is grant-independent: even a covering active grant
  // cannot authorize these (design §13). A first-use account or an unusual count variance escalates
  // by anomaly; a write-down / private-use kind escalates by class.
  if (ALWAYS_ESCALATE_POSTING_KINDS.includes(String(postingKind))) {
    return deny('event_class_always_escalates', { posting_kind: postingKind, class: 'kind' });
  }
  if (proposed.firstUseAccount === true || proposed.first_use_account === true) {
    return deny('event_class_always_escalates', { class: 'first_use_account' });
  }
  if (proposed.unusualCountVariance === true || proposed.unusual_count_variance === true) {
    return deny('event_class_always_escalates', { class: 'unusual_count_variance' });
  }

  if (!grant || typeof grant !== 'object') return deny('no_grant', {});
  if (grant.status !== 'active') return deny('grant_inactive', { status: grant.status ?? null });
  // A grant whose earlier use was corrected is unusable until re-reviewed (mirror 040's guard).
  if (num(grant.correction_count) > 0) return deny('grant_corrected', { correction_count: grant.correction_count });

  // Allow-lists: the kind and every touched account must be explicitly permitted (fail-closed —
  // an empty/absent allow-list authorizes NOTHING, never everything).
  const allowedKinds = asArray(grant.allowed_posting_kinds);
  if (!allowedKinds.includes(String(postingKind))) return deny('kind_not_allowed', { posting_kind: postingKind, allowed: allowedKinds });
  const allowedAccounts = asArray(grant.allowed_accounts);
  const disallowed = accountRoles.find((r) => !allowedAccounts.includes(String(r)));
  if (disallowed != null) return deny('account_not_allowed', { role: disallowed, allowed: allowedAccounts });

  if (normCcy(grant.currency) !== currency) return deny('currency_mismatch', { grant_currency: grant.currency, proposed_currency: proposed.currency });

  // Confidence floor — a grant may require the model's confidence to clear a bar. Only enforced
  // when the grant sets one (null = not enforced; note num(null)===0, so guard on != null, not
  // isFinite). A null/NaN proposed confidence then fails closed.
  if (grant.confidence_floor != null) {
    const floor = num(grant.confidence_floor);
    const conf = num(proposed.confidence);
    if (!Number.isFinite(conf) || conf < floor) return deny('confidence_below_floor', { floor, confidence: proposed.confidence ?? null });
  }

  // Evidence requirement — when the grant requires evidence, the proposal must affirmatively carry
  // it (the §14 matrix is the executor's accountingReady gate; this is the grant's own requirement).
  if (grant.evidence_required === true && proposed.evidencePresent !== true && proposed.evidence_present !== true) {
    return deny('evidence_required', {});
  }

  // Amount ceilings. The proposed amount must be a real positive number.
  if (!Number.isFinite(amount) || amount <= 0) return deny('per_journal_ceiling', { amount: proposed.amount ?? null, note: 'non-positive or non-finite amount' });
  const perJournal = num(grant.per_journal_ceiling);
  if (!Number.isFinite(perJournal) || perJournal <= 0) return deny('per_journal_ceiling', { per_journal_ceiling: grant.per_journal_ceiling ?? null, note: 'grant has no valid per-journal ceiling' });
  if (amount > perJournal) return deny('per_journal_ceiling', { amount, per_journal_ceiling: perJournal });

  // Aggregate ceilings — the whole point of §13. ALREADY-posted-under-this-grant + this proposal
  // must fit. A missing aggregate defaults to 0 (nothing posted yet); a ceiling that is
  // absent/≤0 is treated as NOT SET (unbounded on that axis) — the per-journal ceiling still binds.
  const dailyCeiling = num(grant.daily_aggregate_ceiling);
  if (Number.isFinite(dailyCeiling) && dailyCeiling > 0) {
    const dailyTotal = (Number.isFinite(num(aggregates.dailyPosted)) ? num(aggregates.dailyPosted) : 0) + amount;
    if (dailyTotal > dailyCeiling) return deny('daily_aggregate_ceiling', { daily_posted: aggregates.dailyPosted ?? 0, amount, daily_aggregate_ceiling: dailyCeiling });
  }
  const periodCeiling = num(grant.period_aggregate_ceiling);
  if (Number.isFinite(periodCeiling) && periodCeiling > 0) {
    const periodTotal = (Number.isFinite(num(aggregates.periodPosted)) ? num(aggregates.periodPosted) : 0) + amount;
    if (periodTotal > periodCeiling) return deny('period_aggregate_ceiling', { period_posted: aggregates.periodPosted ?? 0, amount, period_aggregate_ceiling: periodCeiling });
  }

  // Validity window (mirror 040): not before valid_from, not at/after expires_at, not at/past
  // the mandatory review_after. asOf is injected; a null/unparseable asOf fails closed.
  const now = toEpoch(asOf);
  if (now == null) return deny('review_due', { note: 'no decision instant supplied' });
  const validFrom = toEpoch(grant.valid_from);
  if (validFrom != null && validFrom > now) return deny('not_yet_valid', { valid_from: grant.valid_from });
  const expiresAt = toEpoch(grant.expires_at);
  if (expiresAt != null && expiresAt <= now) return deny('expired', { expires_at: grant.expires_at });
  const reviewAfter = toEpoch(grant.review_after);
  if (reviewAfter != null && reviewAfter <= now) return deny('review_due', { review_after: grant.review_after });

  // Jurisdiction — when the grant is jurisdiction-scoped, the proposal must match.
  if (grant.jurisdiction != null && String(grant.jurisdiction) !== '' &&
      proposed.jurisdiction != null && String(grant.jurisdiction) !== String(proposed.jurisdiction)) {
    return deny('jurisdiction_mismatch', { grant_jurisdiction: grant.jurisdiction, proposed_jurisdiction: proposed.jurisdiction });
  }

  return {
    authorized: true,
    reason: null,
    detail: {
      grant_id: grant.id ?? null,
      per_journal_ceiling: perJournal,
      daily_headroom: Number.isFinite(dailyCeiling) && dailyCeiling > 0 ? Math.max(dailyCeiling - ((num(aggregates.dailyPosted) || 0) + amount), 0) : null,
      period_headroom: Number.isFinite(periodCeiling) && periodCeiling > 0 ? Math.max(periodCeiling - ((num(aggregates.periodPosted) || 0) + amount), 0) : null
    }
  };
};
