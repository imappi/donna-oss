// SG — PDPA (Personal Data Protection Act) data-handling rails + statutory
// record retention. Pure DATA + pure compute — the finland/retention.js (KILA)
// analogue plus the GDPR-analogue privacy posture the handoff names.
//
// Two concerns, kept explicit:
//   • RETENTION — how long the BOOKS and their evidence must be kept (IRAS +
//     Income Tax Act s67 and Companies Act s199 have different anchors).
//     Donna must not delete evidence earlier, and the client-deletion flow
//     surfaces the obligation before a purge.
//   • PDPA — personal data inside the books (counterparty names, PayNow mobile
//     proxies, payroll data) is held under the PDPA's purpose-limitation and
//     protection obligations. The constants below are the copy/handling
//     anchors the surfaces render; they never substitute for the curated
//     PDPC knowledge base (csKnowledge.js) on judgment questions.

const isoDate = (value) => {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

export const SG_RETENTION_PROVENANCE = Object.freeze({
  "url": "https://www.iras.gov.sg/taxes/corporate-income-tax/basics-of-corporate-income-tax/record-keeping-requirements",
  "title": "Record Keeping Requirements",
  "quote": "31 Dec 2027",
  "as_of": "2026-09-24",
  "confirmedAgainstPrimary": true,
  "source": "IRAS example: FYE 30 September 2022, YA 2023, retain through 31 December 2027. Ordinary income-tax books; special holds/dissolution may require longer.",
  "income_tax_act": {
    "url": "https://sso.agc.gov.sg/Act/ITA1947#pr67-",
    "title": "Income Tax Act 1947 — section 67",
    "quote": "5 years from the year of assessment",
    "as_of": "2026-09-24"
  },
  "company_act": {
    "url": "https://sso.agc.gov.sg/Act/CoA1967#pr199-",
    "title": "Companies Act 1967 — section 199(2)",
    "quote": "not less than 5 years from the end of the financial year",
    "as_of": "2026-09-24"
  },
  "pdpa": {
    "url": "https://sso.agc.gov.sg/Act/PDPA2012#pr25-",
    "title": "Personal Data Protection Act 2012 — section 25",
    "quote": "retention is no longer necessary for legal or business purposes",
    "as_of": "2026-09-24"
  }
});

// The statutory retention period for accounting records and their evidence.
export const SG_RECORD_RETENTION_YEARS = 5;

// buildSgRetentionAssessment({ periodEndsOn, now }) → { retainUntil, expired,
// note }. `periodEndsOn` is the financial year end, not a GST period end.
// Retain through 31 December of its year + 5. This ordinary income-tax floor
// does not cover dissolution or a separate legal hold. `expired` flips only on a
// supplied `now` — the caller decides what to do (a purge flow REFUSES before
// retainUntil; expiry itself never auto-deletes anything).
export const buildSgRetentionAssessment = ({ periodEndsOn, now } = {}) => {
  const ends = isoDate(periodEndsOn);
  if (!ends) {
    const error = new Error('buildSgRetentionAssessment requires periodEndsOn (ISO date).');
    error.statusCode = 400;
    error.code = 'SINGAPORE_RETENTION_PERIOD_INVALID';
    throw error;
  }
  const y = Number(ends.slice(0, 4));
  const retainUntil = `${y + SG_RECORD_RETENTION_YEARS}-12-31`;
  const at = isoDate(now);
  return {
    period_ends_on: ends,
    retention_years: SG_RECORD_RETENTION_YEARS,
    retain_until: retainUntil,
    expired: at ? at > retainUntil : false,
    note: `Accounting records and supporting evidence for the period ending ${ends} must be retained until ${retainUntil} (IRAS income-tax record retention; Companies Act minimum also applies). Expiry does not authorise deletion while another legal or business purpose remains.`,
    provenance: { ...SG_RETENTION_PROVENANCE }
  };
};

// assertSgRetentionAllowsPurge({ periodEndsOn, onDate }) — the KEEP-layer purge
// guard: deleting evidence/records inside the statutory window is a typed
// refusal, never a shade. The client-deletion flow calls this per retained
// period before a hard purge (the firm-memory-dies-with-its-client rail
// governs FACTS; statutory BOOKS answer to this window).
export const assertSgRetentionAllowsPurge = ({ periodEndsOn, onDate } = {}) => {
  const assessment = buildSgRetentionAssessment({ periodEndsOn, now: onDate });
  const at = isoDate(onDate);
  if (!at) throw new Error('assertSgRetentionAllowsPurge requires an onDate (ISO date or timestamp).');
  if (at <= assessment.retain_until) {
    const error = new Error(
      `Records for the period ending ${assessment.period_ends_on} are inside the statutory retention window ` +
      `(until ${assessment.retain_until}, IRAS/Companies Act 5 years) and cannot be purged.`
    );
    error.statusCode = 409;
    error.code = 'SINGAPORE_RETENTION_PURGE_REFUSED';
    error.retainUntil = assessment.retain_until;
    throw error;
  }
  return assessment;
};

// ---------------------------------------------------------------------------------
// PDPA handling anchors — the copy/behaviour constants the surfaces render.
// ---------------------------------------------------------------------------------
// Product purposes, not a statutory exhaustive list or automatic lawful basis.
// Purpose limitation: what the books' personal data is used FOR (the honest,
// closed statement — rendered in the client-facing privacy copy).
export const SG_PDPA_PURPOSES = Object.freeze([
  'bookkeeping_and_reconciliation',
  'statutory_filing_preparation',
  'evidence_retention',
  'owner_communication'
]);

// Data classes that MAY contain personal data about identifiable individuals —
// Business contact information has the section 4(5) exception; company names
// alone are not personal data. These labels do not decide applicability.
// Named so handling surfaces (exports, logs, prompts) can minimise on purpose
// rather than by accident. PayNow MOBILE proxies are the SG-specific one: a
// personal mobile number inside a bank-statement line is personal data even
// when the line itself is business evidence.
export const SG_PDPA_DATA_CLASSES = Object.freeze([
  'counterparty_names',
  'paynow_mobile_proxies',
  'payroll_records',
  'owner_contact_details'
]);

export const SG_PDPA_PROVENANCE = Object.freeze({
  "url": "https://sso.agc.gov.sg/Act/PDPA2012#pr25-",
  "title": "Personal Data Protection Act 2012 — sections 2, 4(5), 18, 24, 25",
  "quote": "retention is no longer necessary for legal or business purposes",
  "as_of": "2026-09-24",
  "confirmedAgainstPrimary": true,
  "source": "Purpose, protection and retention obligations only; product purpose/class lists are not legislated. Section 2 defines identifiable individuals; section 4(5) excludes business contact information from the listed Parts."
});
