// AE ae_vat_registration — the VAT-registration STATUS watch's PURE half:
// the ask kind, the re-ask window, the deterministic skip/ask classification
// and the owner-voiced question builders. The drain that sweeps these
// (ae/vatRegistrationEscalationDb.js, re-exported through firmDb.js as
// drainAeVatRegistrationEscalations) is bound by name on the
// jurisdiction-neutral obligation sweep as 'ae_vat_registration_escalation'
// — core never imports ae/ directly. RT-19 of
// docs/plan-2026-09-01-runtime-refactor-slices.md (forensics F-23).
//
// THE GAP THIS CLOSES. FTA-assigned tax periods are client DATA recorded
// from the owner's EmaraTax view and the period writer (ae/vatPeriods.js)
// refuses without a persisted registration + TRN — correctly. But nothing
// ASKED the owner for either: the threshold watch asks only once turnover
// crosses AED 375,000, and the return lane's period-intake ask covers
// REGISTRANTS only. A client whose statement already carries an FTA VAT
// payment therefore had an empty ae_vat_periods table, an unknown
// registration, and no ask — a row resting on nobody. This is the VAT twin
// of the corporate-tax STATUS ask (ae/ctRegistrationEscalation.js): for a
// registry duty "unknown" must never read as either answer, so the status
// itself is the owner fact requested.
//
// Two-terminal-states, applied: the client is either RECORDED (registered
// with the record as evidence — the return lane takes over; or recorded
// not-registered — the threshold watch takes over) or the status is on the
// OWNER by name. The re-ask window below is what stops a "not registered"
// answer from being nagged, while VAT activity that CONTRADICTS the answer
// re-opens the question after the window rather than staying silent forever.
//
// The watch runs UNCONDITIONALLY for every AE-jurisdiction client (Kari
// 2026-08-31, "nothing dark" — the AE lane carries no flag; the 2026-08-27
// zero-users rail: an ask-minting watch mints a deduped owner ask, never a
// ledger write).

import { VAT_MANDATORY_REGISTRATION_THRESHOLD_AED } from './vatRegistrationThreshold.js';
import { AE_VAT_RETURN_DUE_DAYS } from './vatPeriods.js';
import { toLocalIsoDay, utcDayDiff } from '../dates.js';

// Market-neutral evidence type, the ct_registration_status convention: a GB
// VAT-registration status watch (VRN-shaped) would reuse this name.
export const AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE = 'vat_registration_status';

// How long a recorded owner answer holds before VAT activity that contradicts
// it may re-open the question. A deterministic product constant, not a
// statutory number: 90 days is one FTA quarter — the shortest span in which a
// "not registered" business could plausibly have registered and started
// paying VAT. Without contradicting activity the answer holds indefinitely
// (the threshold watch owns the not-registered side).
export const AE_VAT_REGISTRATION_REASK_DAYS = 90;

// The persisted signals the drain reads as "this book shows VAT activity".
// Every kind is a PERSISTED VERDICT (render-the-persisted-verdict rail):
//   vat_control_account_coding — a bank line coded (applied, or the strong
//     coder's persisted proposal) to the chart account carrying the
//     liability.sales_tax_payable role — the FTA VAT payment case;
//   vat_control_account_posting — a posted journal line on that account;
//   vat_bearing_sales_invoice — a sales invoice the extractor persisted with
//     a positive tax amount (a UAE business charging VAT is a registrant).
// Deliberately NOT a description keyword match ("FTA", "EmaraTax"): that
// would be intelligence-substituting scaffolding the coder already does
// better. A buyer-TRN-on-bill signal is named in the RT-19 handoff as an
// extractor gap — the bill extractors persist no tax registration ids.
export const AE_VAT_ACTIVITY_EVIDENCE_KINDS = Object.freeze([
  'vat_control_account_coding',
  'vat_control_account_posting',
  'vat_bearing_sales_invoice'
]);

// Ask statuses that mean "the owner has this question already" — dedup on an
// OPEN ask per client (the slice's rule), where 'replied' counts as open: an
// answered-but-unrecorded reply must not be re-asked over the owner's head.
export const AE_VAT_REGISTRATION_ASK_OPEN_STATUSES = Object.freeze(['draft', 'open', 'replied']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Day normalisation goes through dates.js (RT-07): pg hands a timestamptz
// back as a Date holding an instant, and the calendar day the owner answered
// on is the HOST's day for that instant (toLocalIsoDay) — the same clock the
// drain stamps "today" with. A bare ISO day passes through validated; a
// mangled or missing value is null, never a guessed day.
export const isoDayOf = (value) => {
  if (value === null || value === undefined) return null;
  const day = value instanceof Date || typeof value === 'number' ? toLocalIsoDay(value) : toLocalIsoDay(String(value).slice(0, 10)) || toLocalIsoDay(String(value));
  return day && ISO_DATE.test(day) ? day : null;
};
const dateOnly = (value) => isoDayOf(value) || '';

// One ask id per (firm, client, watch DATE): the hourly cadence dedupes on the
// id inside a day (on conflict do nothing), the open-ask check dedupes across
// days, and a legitimate re-ask after the window mints a new id. NOT keyed by
// year like the CT ask — a "not registered" answer contradicted by activity
// must be re-askable within the same year.
export const aeVatRegistrationStatusAskId = ({ firmId, clientId, asOf }) =>
  `vat-registration-status-${firmId}-${clientId}-${dateOnly(asOf)}`;

const daysBetween = (fromIso, toIso) => utcDayDiff(dateOnly(toIso), dateOnly(fromIso));

// classifyAeVatRegistrationAsk({ registration, latestAsk, evidence, asOf })
// → { action: 'ask' | 'skip', reason }. Pure; every reason is a closed name.
//
//   registration  the resolveAeVatRegistrationOnDate verdict on asOf
//   latestAsk     the client's most recent vat_registration_status ask
//                 ({ status, resolved_at, responded_at, created_at }) or null
//   evidence      the persisted VAT-activity signals (may be empty)
//
// Skip reasons:
//   ask_open                 an ask is already on the owner
//   registered               recorded registered — discharged; the return
//                            lane's period-intake ask owns the next question
//   recorded_not_yet_effective / recorded_deregistered — a record exists
//   answered_recently        an answer was recorded inside the re-ask window
//   not_registered_no_activity — recorded not registered and nothing in the
//                            book contradicts it; the threshold watch governs
// Ask reasons:
//   status_unknown, status_unknown_with_activity,
//   not_registered_but_vat_activity (the contradiction, after the window)
export const classifyAeVatRegistrationAsk = ({ registration, latestAsk = null, evidence = [], asOf } = {}) => {
  const at = dateOnly(asOf);
  if (!ISO_DATE.test(at)) throw new Error('classifyAeVatRegistrationAsk requires an ISO asOf date.');
  const hasEvidence = Array.isArray(evidence) && evidence.length > 0;

  if (latestAsk && AE_VAT_REGISTRATION_ASK_OPEN_STATUSES.includes(String(latestAsk.status || '').toLowerCase())) {
    return { action: 'skip', reason: 'ask_open' };
  }
  const answeredAt = latestAsk && String(latestAsk.status || '').toLowerCase() === 'resolved'
    ? dateOnly(latestAsk.resolved_at || latestAsk.responded_at || latestAsk.created_at)
    : null;
  const answeredRecently = Boolean(answeredAt && ISO_DATE.test(answeredAt)
    && daysBetween(answeredAt, at) < AE_VAT_REGISTRATION_REASK_DAYS);

  if (registration?.registered === true) return { action: 'skip', reason: 'registered' };
  if (registration?.registered === false && registration.reason !== 'not_registered') {
    return { action: 'skip', reason: `recorded_${registration.reason}` };
  }
  if (registration?.registered === false) {
    if (answeredRecently) return { action: 'skip', reason: 'answered_recently' };
    if (!hasEvidence) return { action: 'skip', reason: 'not_registered_no_activity' };
    return { action: 'ask', reason: 'not_registered_but_vat_activity' };
  }
  // Unknown. A resolved ask that left the record unknown (a firm resolution
  // without a recorded answer) still holds for the window — the owner was
  // asked; re-nagging inside it is the interruption the metric counts.
  if (answeredRecently) return { action: 'skip', reason: 'answered_recently' };
  return { action: 'ask', reason: hasEvidence ? 'status_unknown_with_activity' : 'status_unknown' };
};

const aed = (n) => `AED ${Number(n).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = (item) => {
  const value = Number(item.amount);
  if (!Number.isFinite(value) || value === 0) return null;
  const currency = String(item.currency || 'AED').toUpperCase();
  return currency === 'AED' ? aed(Math.abs(value)) : `${currency} ${Math.abs(value).toFixed(2)}`;
};

// describeAeVatActivityEvidence(evidence) — one owner-readable clause per
// signal, oldest first is not needed; the drain hands the most recent few.
export const describeAeVatActivityEvidence = (evidence = []) => (evidence || []).map((item) => {
  const on = dateOnly(item.on_date);
  const when = ISO_DATE.test(on) ? ` on ${on}` : '';
  const amount = money(item);
  const amountText = amount ? ` (${amount})` : '';
  switch (item.kind) {
    case 'vat_control_account_coding':
      return `a bank line coded to your VAT payable account${when}${amountText}${item.label ? ` — "${item.label}"` : ''}`;
    case 'vat_control_account_posting':
      return `a posted journal on your VAT payable account${when}${amountText}`;
    case 'vat_bearing_sales_invoice':
      return `a sales invoice carrying VAT${item.label ? ` (${item.label})` : ''}${when}${amountText ? `, VAT ${amount}` : ''}`;
    default:
      return `VAT activity${when}`;
  }
});

const threshold = aed(VAT_MANDATORY_REGISTRATION_THRESHOLD_AED);

// buildAeVatRegistrationStatusQuestion({ reason, evidence, answeredAt }) —
// the owner ask. Three shapes keyed on the classification reason: status
// unknown (the onboarding fact), status unknown with activity named (the
// desert-rose case — the book already shows an FTA VAT payment), and the
// contradiction (a recorded "not registered" answer versus later activity).
// Every shape asks for the SAME three owner facts the period writer needs —
// the TRN, the effective date, and the FTA-assigned tax period with its due
// date — and states who registers (the owner, in EmaraTax; Donna never
// registers). The 28-day due-date rule and the threshold are cited from
// their provenance homes, never re-typed here.
export const buildAeVatRegistrationStatusQuestion = ({ reason = 'status_unknown', evidence = [], answeredAt = null } = {}) => {
  const lines = describeAeVatActivityEvidence(evidence);
  const facts = 'If you are registered, reply with your 15-digit VAT TRN, the date the registration took effect (both are on your FTA registration certificate), '
    + `and the tax period the FTA assigned you in EmaraTax with its due date (for example "Jan–Mar, due 28 Apr" — returns are due within ${AE_VAT_RETURN_DUE_DAYS} days of the period end). A screenshot of the EmaraTax period works. `;
  const notRegistered = `If you are not registered, just reply "not registered" and I will keep watching the ${threshold} mandatory registration threshold for you. `;
  const boundary = 'You register in EmaraTax — I cannot register on your behalf.';

  if (reason === 'not_registered_but_vat_activity') {
    const when = answeredAt && ISO_DATE.test(dateOnly(answeredAt)) ? ` on ${dateOnly(answeredAt)}` : '';
    return (
      `You told me${when} that you are not VAT registered, but your books now show ${lines.join('; ')}. Has that changed — are you now registered for VAT with the FTA? `
      + facts
      + 'If you are still not registered, tell me what that activity was and I will code it accordingly. '
      + boundary
    );
  }
  if (reason === 'status_unknown_with_activity' && lines.length > 0) {
    return (
      `Your books show ${lines.join('; ')}, and I do not have your VAT registration on file. Are you registered for VAT with the FTA? `
      + facts + notRegistered + boundary
    );
  }
  return (
    'I do not have your VAT registration on file. Are you registered for VAT with the FTA? '
    + facts + notRegistered + boundary
  );
};
