// AE — PURE deadline rows for the FTA corporate-tax REGISTRATION timeline
// (the UAE backend lane, 2026-08-30). The row contract is gb/vatDeadlines.js's,
// verbatim: tri-state registration underneath, and every row terminal
// `'scheduled'` (a computed due date) or `'on_owner'` (a named refusal) —
// nothing else, per the two-terminal-states principle. No drain, no DB, no
// flag, no clock: the caller supplies the profile and the date, this module
// answers. Binding the `ae_corporate_tax_registration` obligation (manifest
// flip + drain wiring) is the coordinating session's follow-up.
//
// ── The duty, restated from sources (as_of 2026-08-30) ─────────────────────
// FTA Decision No. 3 of 2024 (issued 2024-02-22, effective 2024-03-01) sets
// the timelines for submitting a corporate-tax registration application:
//   - A resident juridical person incorporated/established/recognised ON OR
//     AFTER 2024-03-01: within THREE MONTHS of incorporation.
//   - A juridical person incorporated BEFORE 2024-03-01: by a 2024 calendar
//     deadline keyed on the month its LICENCE was issued (first tranche
//     2024-05-31) — a fact the profile does not hold, and a schedule whose
//     dates have all passed.
//   - A resident natural person whose business turnover exceeds AED 1m in a
//     Gregorian calendar year: by 31 March of the FOLLOWING year; a
//     non-resident natural person: within three months of becoming taxable.
// Late registration carries a flat AED 10,000 administrative penalty
// (Cabinet Decision No. 75 of 2023 as amended by Cabinet Decision No. 10 of
// 2024, effective 2024-03-01 — lowered from the earlier AED 20,000), with an
// FTA waiver initiative (implemented from 2025) that forgives the penalty
// when the FIRST corporate-tax return (or an exempt person's annual
// declaration) is filed within SEVEN months of the first tax period's end.
// All of the above is corroborated across secondaries; tax.gov.ae and
// mof.gov.ae are egress-blocked here, so nothing is confirmed against
// primary — see the provenance constants.
//
// ── What this module deliberately does and does not compute ────────────────
// The ONLY limb computed is the one the profile can honestly settle: a
// recorded NOT-registered client with an incorporation_date on/after
// 2024-03-01 gets a scheduled row at incorporation + 3 months. Every other
// live-duty shape refuses to the owner BY NAME instead of guessing:
//   - no incorporation_date (which is also every natural person — the AED 1m
//     turnover trigger and its year are owner facts, not profile facts);
//   - incorporation before 2024-03-01 (the licence-issuance-month schedule
//     keys on a fact we do not hold);
//   - a recorded DEREGISTERED record (whether the duty re-arises turns on
//     facts only the owner knows).
// ENTITY-NEUTRAL like the registration record itself: nothing here reads
// `entity_type` or free-zone standing — most free zone persons must register
// exactly as mainland persons must, and QFZP treatment is the return lane's
// question (gap 6, OPEN), never a registration-timeline input.

import { resolveAeCtRegistrationOnDate } from './ctRegistration.js';
import { toUtcIsoDay } from '../dates.js';

export const AE_CT_REGISTRATION_TIMELINE_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  asOf: '2026-08-30',
  authority: 'Federal Tax Authority',
  source: 'FTA Decision No. 3 of 2024 on the Timelines specified for Registration of Taxable Persons for Corporate Tax '
    + '(issued 2024-02-22, effective 2024-03-01), under Federal Decree-Law No. 47 of 2022: resident juridical persons '
    + 'incorporated on/after 2024-03-01 apply within three months of incorporation; those incorporated earlier follow a '
    + '2024 schedule keyed on licence-issuance month (first deadline 2024-05-31); resident natural persons over AED 1m '
    + 'turnover in a Gregorian calendar year apply by 31 March of the following year; non-resident natural persons '
    + 'within three months of becoming taxable. CORROBORATED 2026-08-30 across PwC, DLA Piper, Clyde & Co and further '
    + 'secondaries, plus the FTA\'s own public-clarification page as surfaced in search extraction. Byte-level primary '
    + 'read PENDING: tax.gov.ae is blocked by this environment\'s egress proxy — VERIFY before any AE client is '
    + 'onboarded onto a statutory lane.'
});

// Declared for the eventual escalation-ask copy, deliberately never read by
// the row builder — a penalty amount is context for the OWNER's decision,
// not an input to a deadline computation.
export const AE_CT_LATE_REGISTRATION_PENALTY_AED = 10000;

export const AE_CT_LATE_REGISTRATION_PENALTY_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  asOf: '2026-08-30',
  authority: 'Federal Tax Authority / UAE Cabinet',
  source: 'Cabinet Decision No. 75 of 2023 on Administrative Penalties (corporate tax), as amended by Cabinet Decision '
    + 'No. 10 of 2024 effective 2024-03-01: AED 10,000 for late submission of the corporate-tax registration '
    + 'application (lowered from AED 20,000). An FTA waiver initiative implemented from 2025 forgives the penalty when '
    + 'the first corporate-tax return (or an exempt person\'s annual declaration) is filed within seven months of the '
    + 'end of the first tax period — first period only, applied automatically. CORROBORATED 2026-08-30 across DLA '
    + 'Piper and further secondaries, plus the FTA\'s own waiver announcement as surfaced in search extraction. '
    + 'Byte-level primary read PENDING (tax.gov.ae egress-blocked).'
});

// The pre-decision cutover: incorporation on/after this date puts a juridical
// person on the three-month clock; before it, on the licence-month schedule.
export const AE_CT_REGISTRATION_TIMELINE_EFFECTIVE_FROM = '2024-03-01';

const isIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// Three CALENDAR months, clamped to the last day of the target month
// (2026-11-30 + 3 months → 2027-02-28, never a rolled-over 2027-03-02). The
// clamp is the conservative reading: a computed deadline may be earlier than
// the statutory one, never later.
const addThreeMonthsClamped = (isoDate) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const targetMonthLastDay = new Date(Date.UTC(y, m + 3, 0)).getUTCDate();
  // UTC on purpose: Date.UTC arithmetic on a bare calendar day — the host
  // zone must not move the statutory day.
  return toUtcIsoDay(Date.UTC(y, m - 1 + 3, Math.min(d, targetMonthLastDay)));
};

const row = (key, label, due_date) => ({ key, label, due_date, terminal: 'scheduled' });
const refusal = (key, label, reason_code) => ({ key, label, due_date: null, terminal: 'on_owner', reason_code });

// buildAeCtRegistrationDeadlineRows({ profile, onDate, refusalCodes }) — the
// registration duty's deadline rows for one client on one date. The refusal
// codes are caller-supplied (the gb/vatDeadlines.js convention) so the
// obligation binding names its own ask vocabulary:
//   refusalCodes.ctRegistration — the registration STATUS is unknown;
//   refusalCodes.ctRegistrationDeadline — the duty is live (or may have
//     re-arisen) but its deadline cannot be computed from the profile.
export const buildAeCtRegistrationDeadlineRows = ({
  profile = {},
  onDate,
  refusalCodes = {}
} = {}) => {
  const ct = resolveAeCtRegistrationOnDate({ registration: profile.ct_registration, onDate });

  // Registration duty discharged: an effective registration, or one recorded
  // with a future effective date (the application clearly exists). The
  // standing record is the evidence; there is nothing to schedule.
  if (ct.registered === true || ct.reason === 'not_yet_effective') return [];

  // Unknown is an owner question, never silence — the registry duty's whole
  // point is that "we don't know" must not read as either answer.
  if (ct.registered === null) {
    return [refusal('ct_registration', 'Corporate tax registration status', refusalCodes.ctRegistration)];
  }

  // A recorded deregistration: whether the duty re-arises (business ceased?
  // restarted? re-registration in flight?) turns on facts only the owner
  // knows. Refuse by name rather than scheduling a guessed clock.
  if (ct.reason === 'deregistered') {
    return [refusal('ct_registration_deadline', 'Corporate tax re-registration', refusalCodes.ctRegistrationDeadline)];
  }

  // Recorded not_registered — the duty is LIVE. Compute only the limb the
  // profile can settle; everything else is the owner's to answer.
  const incorporationDate = isIsoDate(profile.incorporation_date) ? profile.incorporation_date : null;
  if (!incorporationDate || incorporationDate < AE_CT_REGISTRATION_TIMELINE_EFFECTIVE_FROM) {
    // No incorporation date (natural persons included — their trigger is a
    // turnover year the profile does not hold), or a pre-2024-03-01
    // incorporation whose deadline keyed on licence-issuance month.
    return [refusal('ct_registration_deadline', 'Corporate tax registration deadline', refusalCodes.ctRegistrationDeadline)];
  }
  return [row(
    'ct_registration',
    `Corporate tax registration (FTA, within 3 months of incorporation ${incorporationDate})`,
    addThreeMonthsClamped(incorporationDate)
  )];
};
