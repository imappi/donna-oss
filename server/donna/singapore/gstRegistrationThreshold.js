// SG production-readiness — the GST registration-threshold watch for a
// NON-GST-registered Singapore client. Pure KEEP-layer arithmetic, mirroring
// finland/alvRegistrationThreshold.js 1:1: taxable turnover vs the statutory
// registration threshold, three closed statuses, no model call anywhere. The
// watch never registers anybody and never touches the books — it makes sure a
// client quietly crossing the threshold becomes an owner conversation instead
// of a compliance surprise (late registration carries back-dated liability and
// penalties in SG — the surprise is expensive).
//
// Scope guard: the watch applies ONLY where SINGAPORE_GST_CODING does NOT act —
// a GST-registered client's obligations are watched by the return engine.
// The DB caller enforces that; this module is pure.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Config-plane flag (migration 042 pattern) — read via clientFlagActs with
// envFallback () => false, never an env pair. Canary per client.
export const SINGAPORE_GST_THRESHOLD_WATCH_FLAG_KEY = 'SINGAPORE_GST_THRESHOLD_WATCH';

// The registration threshold: S$1,000,000 taxable turnover. Two statutory
// views (GST Act First Schedule):
//   • RETROSPECTIVE — taxable turnover at the end of a calendar year exceeds
//     S$1M → liable to register (apply within 30 days; registration effective
//     per IRAS assignment).
//   • PROSPECTIVE — reasonable expectation that taxable turnover in the NEXT
//     12 months will exceed S$1M → liable to register.
// The watch uses historical trailing/YTD turnover as an early warning only.
// These inputs cannot establish the prospective statutory test or its trigger
// date. Retrospective applications are due by 30 January following year end;
// prospective applications within 30 days of the reasonably certain forecast.
// Since 1 July 2025 prospective registration takes effect two months from that
// forecast date (IRAS source below), not when this watch first exceeds S$1M.
export const GST_REGISTRATION_THRESHOLD_SGD = 1000000;
export const GST_THRESHOLD_PROVENANCE = Object.freeze({
  "url": "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-registration-deregistration/do-i-need-to-register-for-gst",
  "title": "Do I need to register for GST",
  "quote": "more than $1 million",
  "as_of": "2026-09-24",
  "confirmedAgainstPrimary": true,
  "source": "S$1,000,000; strict excess; calendar-year retrospective / reasonably certain next-12-month prospective tests. The watch itself is only an early warning.",
  "statute": {
    "url": "https://sso.agc.gov.sg/Act/GSTA1993#Sc1-",
    "title": "Goods and Services Tax Act 1993 — First Schedule paragraph 1",
    "quote": "has exceeded $1 million",
    "as_of": "2026-09-24"
  }
});

// Warn early enough that the owner can act before the crossing, late enough to
// not cry wolf on every small book.
export const GST_THRESHOLD_APPROACH_FRACTION = 0.8;

export const GST_THRESHOLD_STATUSES = Object.freeze(['ok', 'approaching', 'exceeded']);

// The evidence type the exceeded-escalation ask carries (a closed constant,
// matched by the deterministic ask id in the drain — the G-6 pattern).
export const GST_THRESHOLD_EVIDENCE_TYPE = 'gst_threshold_review';

// buildGstThresholdEscalationQuestion({ watch }) — the owner ask minted when
// the watch says `exceeded`. States the numbers, carries the honesty boundary
// verbatim: registration happens on myTax Portal by the OWNER (or their filer)
// — Donna never registers anybody, and GST must not be charged on invoices
// before the registration is effective. Returns null for any non-exceeded
// watch (the caller must not ask). This is an owner-FACT ask (two-terminal-
// states: the registration status is something only the owner can confirm).
export const buildGstThresholdEscalationQuestion = ({ watch } = {}) => {
  if (!watch || watch.status !== 'exceeded') return null;
  const sgd = (n) => `S$${Number(n).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    `Your taxable turnover (${sgd(watch.drivingTurnover)}) has crossed the GST registration threshold (${sgd(watch.thresholdSgd)}). ` +
    `This is an early warning, not a determination of registration liability. Check taxable turnover for the completed calendar year and the reasonably certain next-12-month forecast. Retrospective applications are due by 30 January of the following year; prospective applications within 30 days of the forecast, through myTax Portal, ` +
    `and Donna cannot register on your behalf. Do not charge GST on invoices before your registration is effective. ` +
    `Have you already registered for GST or started the application? Reply here and I'll keep the books aligned with your answer.`
  );
};

// buildGstRegistrationWatch({ year, calendarYearTurnover, trailing12mTurnover })
// → the watch verdict. Pure, never throws. Turnovers are the taxable-turnover
// sums (credit − debit over revenue-type lines, excluding exempt supplies) the
// DB caller reads from the posted ledger; negative sums clamp to 0 (a
// refund-heavy period is not negative turnover for threshold purposes —
// conservative). The DRIVING turnover is the max of the two views — the
// conservative warn-on-either posture, same as the FI watch's two-year rule.
export const buildGstRegistrationWatch = ({
  year,
  calendarYearTurnover = 0,
  trailing12mTurnover = 0,
  thresholdSgd = GST_REGISTRATION_THRESHOLD_SGD
} = {}) => {
  const calendarYear = Math.max(0, round2(num(calendarYearTurnover)));
  const trailing = Math.max(0, round2(num(trailing12mTurnover)));
  const threshold = num(thresholdSgd) > 0 ? round2(num(thresholdSgd)) : GST_REGISTRATION_THRESHOLD_SGD;
  const driving = Math.max(calendarYear, trailing);
  const fraction = round2(driving / threshold);
  const status = driving > threshold
    ? 'exceeded'
    : (driving >= threshold * GST_THRESHOLD_APPROACH_FRACTION ? 'approaching' : 'ok');
  const sgd = (n) => `S$${n.toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const note = status === 'exceeded'
    ? `Taxable turnover (${sgd(driving)}) has crossed the GST registration threshold (${sgd(threshold)}) — review the completed-calendar-year and prospective tests before determining any obligation (myTax Portal). This historical-turnover watch alone does not establish liability. No GST on invoices before registration is effective.`
    : status === 'approaching'
      ? `Taxable turnover (${sgd(driving)}) is approaching the GST registration threshold (${sgd(threshold)}, ${Math.round(fraction * 100)}%). Watch the run rate and prepare for registration.`
      : null;
  return {
    applicable: true,
    year: num(year) || null,
    thresholdSgd: threshold,
    calendarYearTurnover: calendarYear,
    trailing12mTurnover: trailing,
    drivingTurnover: driving,
    fraction,
    headroomSgd: round2(Math.max(0, threshold - driving)),
    status,
    note,
    provenance: { ...GST_THRESHOLD_PROVENANCE }
  };
};
