// Prospecting Lab — pure vocabulary and invariants for P0
// (docs/design-donna-prospecting.md v4, approved 2026-07-05).
//
// The lab's doctrine, enforced deterministically here:
//   - campaign ≠ source: provenance and learning are separate keys.
//   - No signal, no dossier: a dossier without cited disorder/lifecycle
//     evidence cannot be minted.
//   - The negative-evidence block is mandatory — the drafter must argue
//     against its own prospect, or the mint refuses.
//   - research_only is a real state: Red-tier segments park there instead of
//     forcing a false reject-or-progress choice; capability flags keep them
//     dossier-able but never sendable/billable without a dated sign-off.
//   - Rejections carry machine-readable reasons (§10A) — the lab's learning
//     output in its first weeks.
//
// Pure module: no DB, no network. The SQL layer (prospectLabDb.js) and the
// source modules stay thin around it.

import { validateDraftCopy } from './marketingOutbound.js';

export const PROSPECT_SOURCES = Object.freeze([
  'companies_house_overdue',
  'companies_house_first_filing',
  'manual_upload'
]);

// The prospect clock's run receipts reuse marketing_source_run under this
// source (M2). It is a RUN vocabulary entry only — never a mint source: a
// prospect can not be minted BY the clock, so mintProspect keeps validating
// against PROSPECT_SOURCES alone.
export const CLOCK_SOURCE = 'prospect_clock';

export const PROSPECT_STATUSES = Object.freeze([
  'candidate',
  'investigating',
  'on_kari',
  'approved_for_draft',
  'approved_for_send',
  'contacted_awaiting_reply',
  'closed_no_reply',
  'converted',
  'unfit',
  'suppressed',
  'research_only'
]);

export const TERMINAL_PROSPECT_STATUSES = Object.freeze([
  'closed_no_reply',
  'converted',
  'unfit',
  'suppressed'
]);

// Acceptance tiers (§3C — Kari, 2026-07-05). Capability flags per tier:
// research/dossier is always allowed; message drafting is a per-segment call
// for red; sending and billing NEVER follow from tier alone — red requires an
// explicit dated sign-off recorded outside this table, and green/yellow still
// pass the per-send approval + P1 gates like every other send.
export const PROSPECT_TIERS = Object.freeze(['green', 'yellow', 'red']);

export const tierCapabilities = (tier) => ({
  can_generate_dossier: true,
  can_generate_message: tier !== 'red',
  can_send: tier === 'red' ? 'requires_segment_signoff' : 'per_send_approval',
  can_bill: tier === 'red' ? 'requires_billing_rail_signoff' : 'standard'
});

// §10A reject taxonomy — every Kari rejection picks one or more.
export const REJECT_REASONS = Object.freeze([
  'no_real_signal',
  'weak_fit',
  'too_inventory_heavy',
  'too_high_volume',
  'too_remediation_heavy',
  'contact_not_legitimate',
  'message_tone_bad',
  'too_risky',
  'too_small',
  'too_large',
  'already_has_accounting_function',
  'wrong_country',
  'not_alive',
  'bad_timing',
  'other'
]);

// The dossier scoring rubric (§6.10) — each dimension scored 1..3.
export const RUBRIC_DIMENSIONS = Object.freeze([
  'pain_evidence',
  'fit_confidence',
  'contact_legitimacy',
  'delivery_complexity',
  'payment_compliance_risk',
  'message_quality',
  'expected_value'
]);

export const RECOMMENDED_ACTIONS = Object.freeze([
  'approve',
  'reject',
  'hold',
  'research_only'
]);

// Validate a dossier before it may be persisted / put on Kari. Returns [] or
// a list of human-readable violations. This is the "no signal, no dossier"
// and "argue against yourself" invariant — writer-level, not prompt-level.
export const validateDossier = (dossier = {}) => {
  const violations = [];

  const signal = dossier.disorder_signal || {};
  if (!String(signal.summary || '').trim()) {
    violations.push('missing disorder/lifecycle signal summary (no signal, no dossier)');
  }
  if (!String(signal.citation || '').trim()) {
    violations.push('signal has no citation (where is this publicly verifiable?)');
  }

  if (!String(dossier.why_now || '').trim()) {
    violations.push('missing the one-line "why this business, why now"');
  }
  if (!RECOMMENDED_ACTIONS.includes(dossier.recommended_action)) {
    violations.push(`recommended_action must be one of ${RECOMMENDED_ACTIONS.join('/')}`);
  }
  if (!String(dossier.main_risk || '').trim()) {
    violations.push('missing the one-line main risk');
  }

  const negatives = Array.isArray(dossier.negative_evidence) ? dossier.negative_evidence : [];
  if (negatives.length === 0 || negatives.every((n) => !String(n || '').trim())) {
    violations.push('negative-evidence block is empty (the drafter must argue against its own prospect)');
  }

  const scores = dossier.rubric || {};
  for (const dim of RUBRIC_DIMENSIONS) {
    const v = Number(scores[dim]);
    if (!Number.isInteger(v) || v < 1 || v > 3) {
      violations.push(`rubric.${dim} must be an integer 1..3`);
    }
  }

  const fit = dossier.fit || {};
  for (const gate of ['service_business', 'volume_under_1000', 'single_entity', 'country_in_icp']) {
    const v = fit[gate];
    if (v !== 'yes' && v !== 'no' && v !== 'unknown') {
      violations.push(`fit.${gate} must be yes/no/unknown (never guessed into fit)`);
    }
  }

  // A drafted 1:1 message (when present — red-tier dossiers carry none) must
  // pass the SAME claim checklist every outbound draft passes (§6.6): honest
  // promise, pricing.js numbers only, unsubscribe placeholder, no fake
  // Re:/Fwd:. Writer-level: an on-Kari dossier never carries a rail-violating
  // message.
  if (dossier.message != null) {
    const subject = String(dossier.message.subject || '');
    const body = String(dossier.message.body || '');
    if (!subject.trim() || !body.trim()) {
      violations.push('message must carry a non-empty subject and body (or be omitted entirely)');
    }
    for (const violation of validateDraftCopy({ subject, body })) {
      violations.push(`message: ${violation}`);
    }
  }

  return violations;
};

// A lifecycle transition guard: which hops are legal. Kept minimal — the DB
// layer applies it in guarded UPDATEs so a stale click can't teleport a
// prospect.
const LEGAL_TRANSITIONS = Object.freeze({
  candidate: ['investigating', 'unfit'],
  investigating: ['on_kari', 'unfit', 'research_only'],
  on_kari: ['approved_for_draft', 'approved_for_send', 'unfit', 'research_only'],
  approved_for_draft: ['approved_for_send', 'on_kari', 'unfit'],
  approved_for_send: ['contacted_awaiting_reply', 'unfit', 'suppressed'],
  contacted_awaiting_reply: ['closed_no_reply', 'converted', 'suppressed'],
  research_only: ['investigating', 'on_kari', 'unfit'],
  closed_no_reply: [],
  converted: [],
  unfit: [],
  suppressed: []
});

export const isLegalTransition = (from, to) =>
  Array.isArray(LEGAL_TRANSITIONS[from]) && LEGAL_TRANSITIONS[from].includes(to);

// Normalize reject reasons to the taxonomy; unknown entries survive as
// {reason:'other', note} rather than being dropped (nothing silent).
export const normalizeRejectReasons = (reasons = []) =>
  (Array.isArray(reasons) ? reasons : [reasons])
    .filter(Boolean)
    .map((entry) => {
      const reason = typeof entry === 'string' ? entry : entry?.reason;
      if (REJECT_REASONS.includes(reason)) {
        const note = typeof entry === 'object' && entry?.note ? String(entry.note) : undefined;
        return note ? { reason, note } : { reason };
      }
      return { reason: 'other', note: String(reason || entry) };
    });
