// AE ae_corporate_tax_registration — the registry watch's PURE half: the two
// ask kinds, the refusal-code vocabulary handed to the row builder,
// deterministic classification of a computed application deadline, and the
// owner-voiced question builders. The drain that sweeps these
// (drainAeCtRegistrationEscalations, firmDb.js) is bound by name on the
// jurisdiction-neutral obligation sweep as 'ae_ct_registration_escalation' —
// core never imports ae/ directly. Design: docs/design-donna-ae-corporate-tax.md
// (build-state 2026-08-31).
//
// Two-terminal-states, applied to a REGISTRY duty: the client is either
// REGISTERED with the record as evidence (discharged — the sweep stays
// silent), or something is on the OWNER by name — the status itself is
// unknown, the deadline cannot be computed from the profile, or a computed
// deadline is close/past and only the owner can register (in EmaraTax; Donna
// never registers). Nothing rests on Donna or on nobody.

import { AE_CT_LATE_REGISTRATION_PENALTY_AED } from './ctRegistrationDeadlines.js';

// The watch runs UNCONDITIONALLY for every AE-jurisdiction client — the flag
// this module was born with (AE_CT_REGISTRATION_WATCH) was deleted the same
// day it was born (Kari 2026-08-31, "nothing dark"; flag terminal state 1 of
// the rollout-flags rail, same motion as the two sibling AE watches). A
// wrong version mints a deduped owner ask, never a ledger write.

// Market-neutral evidence types, the vat_threshold_review convention: a GB
// corporation-tax-registration watch (UTR-shaped) would reuse these names.
export const AE_CT_REGISTRATION_STATUS_EVIDENCE_TYPE = 'ct_registration_status';
export const AE_CT_REGISTRATION_DEADLINE_EVIDENCE_TYPE = 'ct_registration_deadline';

// The ask vocabulary handed to buildAeCtRegistrationDeadlineRows — the row
// builder's contract has the CALLER name the refusal codes (the
// gb/vatDeadlines.js convention), and this binding is that caller.
export const AE_CT_REGISTRATION_REFUSAL_CODES = Object.freeze({
  ctRegistration: 'AE_CT_REGISTRATION_STATUS_UNKNOWN',
  ctRegistrationDeadline: 'AE_CT_REGISTRATION_DEADLINE_UNRESOLVED'
});

// How far ahead of a COMPUTED application deadline the ask mints. The
// statutory window is three months from incorporation; 30 days of lead
// leaves the owner a third of it — longer than the return watch's 14 on
// purpose, because this duty is one-shot and the late penalty is flat
// (AED 10,000), not a per-day accrual the owner can partially outrun. A
// deterministic product constant, not a statutory number.
export const AE_CT_REGISTRATION_DEADLINE_LEAD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const dateOnly = (value) => String(value || '').slice(0, 10);

// classifyAeCtRegistrationDeadline({ row, asOf }) → { state, daysUntilDue }
// for a 'scheduled' row from buildAeCtRegistrationDeadlineRows. Same closed
// states as the return watch: 'scheduled' (outside the lead window — the
// sweep stays silent), 'due_soon', 'overdue'. Pure calendar arithmetic
// against the row's computed due date.
export const classifyAeCtRegistrationDeadline = ({ row = {}, asOf } = {}) => {
  const due = dateOnly(row.due_date);
  const at = dateOnly(asOf);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    throw new Error('classifyAeCtRegistrationDeadline requires ISO dates for the due date and asOf.');
  }
  const daysUntilDue = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${at}T00:00:00Z`)) / DAY_MS);
  if (daysUntilDue < 0) return { state: 'overdue', daysUntilDue };
  if (daysUntilDue <= AE_CT_REGISTRATION_DEADLINE_LEAD_DAYS) return { state: 'due_soon', daysUntilDue };
  return { state: 'scheduled', daysUntilDue };
};

// One ask per (firm, client, calendar year), the threshold watch's
// convention: an open ask is never re-nagged within its year, a resolved ask
// stays answered for its year, and a duty still undischarged NEXT year asks
// again rather than staying silent forever. Two id families because the two
// asks resolve differently — a status answer can settle the deadline ask's
// premise, never the other way round.
export const aeCtRegistrationStatusAskId = ({ firmId, clientId, year }) =>
  `ct-registration-status-${firmId}-${clientId}-${year}`;

export const aeCtRegistrationDeadlineAskId = ({ firmId, clientId, year }) =>
  `ct-registration-deadline-${firmId}-${clientId}-${year}`;

const penaltyAed = `AED ${AE_CT_LATE_REGISTRATION_PENALTY_AED.toLocaleString('en-AE')}`;

// buildAeCtRegistrationStatusQuestion() — the ask for an UNKNOWN registration
// status. For a registry duty "unknown" read as "registered" silently
// discharges an open statutory duty and read as "not registered" asserts
// one; both are the forbidden guess, so the status itself is the owner fact
// this ask requests.
export const buildAeCtRegistrationStatusQuestion = () => (
  'Nearly every UAE business must register for corporate tax with the FTA — separately from VAT, with its own 15-digit corporate tax TRN — and I do not have your corporate tax registration on file. '
  + 'If you are registered, reply with your corporate tax TRN and effective registration date (EmaraTax shows them under your account). '
  + `If you are not, tell me and I will work out your registration deadline and keep you ahead of it — registering late carries a flat ${penaltyAed} FTA penalty.`
);

// buildAeCtRegistrationDeadlineQuestion({ row, classification, registration })
// — the ask for a LIVE duty. Two shapes, selected by the row's terminal:
//   • an 'on_owner' refusal row → the deadline cannot be computed from the
//     profile; the copy names the missing facts (a recorded deregistration
//     gets its own wording — whether the duty re-arises is the owner's fact).
//     classification is not consulted (a refusal row has no due date).
//   • a 'scheduled' row inside the lead window → the computed deadline with
//     the penalty context; overdue adds the waiver note (first CT return
//     within seven months of the first period end), because the cheapest
//     honest mitigation belongs in the ask that reports the miss.
// Returns null for a 'scheduled' classification state (the caller must not
// ask). The owner registers in EmaraTax — Donna never registers; the ask
// says so.
export const buildAeCtRegistrationDeadlineQuestion = ({ row = {}, classification = null, registration = null } = {}) => {
  if (row.terminal === 'on_owner') {
    if (registration?.reason === 'deregistered') {
      return (
        'Your record shows your UAE corporate tax registration was deregistered. Whether you need to re-register turns on facts only you know — is the business still trading, or trading again? '
        + 'Reply with where things stand (and your new corporate tax TRN if you have already re-registered) and I will track the duty from there. You register in EmaraTax — I cannot register on your behalf.'
      );
    }
    return (
      'You are recorded as not registered for UAE corporate tax, and I cannot work out your registration deadline from what I have on file. '
      + 'It depends on facts only you can supply: your incorporation date and licence details (for companies incorporated before March 2024 the FTA keyed the deadline on the licence month, and those dates have all passed), or for an individual, the year business turnover first exceeded AED 1,000,000. '
      + `Registering late carries a flat ${penaltyAed} FTA penalty. Reply with those details — or with your corporate tax TRN if you are in fact already registered — and I will keep you ahead of the deadline. You register in EmaraTax — I cannot register on your behalf.`
    );
  }
  if (!classification || classification.state === 'scheduled' || classification.state === undefined) return null;
  const due = dateOnly(row.due_date);
  if (classification.state === 'overdue') {
    return (
      `Your UAE corporate tax registration was due ${due} (three months from incorporation) and is now overdue — the FTA's late-registration penalty is a flat ${penaltyAed}. `
      + 'The FTA has waived that penalty where the FIRST corporate tax return is filed within seven months of the first tax period ending, so registering promptly still matters. '
      + 'Please register in EmaraTax as soon as you can — I cannot register on your behalf. Reply with your corporate tax TRN and effective registration date once it is in, or reply here if any of this looks wrong.'
    );
  }
  return (
    `Your UAE corporate tax registration is due by ${due} — three months from your incorporation date. `
    + `Registering late carries a flat ${penaltyAed} FTA penalty. `
    + 'You register in EmaraTax — I cannot register on your behalf. Reply with your corporate tax TRN and effective registration date once it is in, or reply here if any of this looks wrong.'
  );
};
