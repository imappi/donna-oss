// SG-5 — ACRA annual return + AGM obligations for a Pte Ltd. Pure DATA + pure
// compute — the finland/annualReturn.js (PRH) analogue. This module COMPUTES
// the statutory calendar and readiness verdicts; the Bizfile filing lane would
// be its own fail-closed transmit seam (nothing here transmits).
//
// Entity guard: ACRA annual returns apply to COMPANIES (Pte Ltd). A sole
// proprietorship/LLP renews its registration differently — the CALLER asserts
// entity via assertSingaporeCompanyOnly; this module is pure.

import { toUtcIsoDay } from '../dates.js';

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Config-plane flag (migration 042 pattern) — envFallback () => false.
export const SINGAPORE_ACRA_FILINGS_FLAG_KEY = 'SINGAPORE_ACRA_FILINGS';

export const ACRA_FILING_PROVENANCE = Object.freeze({
  "url": "https://sso.agc.gov.sg/Act/CoA1967#pr175-",
  "title": "Companies Act 1967 — sections 175, 175A, 197 and 203",
  "quote": "6 months",
  "as_of": "2026-09-24",
  "confirmedAgainstPrimary": true,
  "source": "Non-listed private company: AGM 6 months, annual return 7 months; AGM exemptions subject to member rights. Section 197(1A) overseas branch-register exception is 8 months.",
  "scope": "Ordinary non-listed private companies, without an overseas branch register, special regulatory filing regime or extension.",
  "annual_return": {
    "url": "https://sso.agc.gov.sg/Act/CoA1967#pr197-",
    "title": "Companies Act 1967 — section 197",
    "quote": "7 months",
    "as_of": "2026-09-24"
  },
  "agm_exemption": {
    "url": "https://sso.agc.gov.sg/Act/CoA1967#pr175A-",
    "title": "Companies Act 1967 — sections 175A and 203",
    "quote": "all the members",
    "as_of": "2026-09-24",
    "scope": "Unanimous resolution, timely financial statements (5 months), or dormant relevant company; statutory member/auditor meeting rights remain."
  },
  "xbrl": {
    "url": "https://www.acra.gov.sg/manage/companies/legal-requirements-common-offences/filing-financial-statements-in-xbrl-format/requirements-exemptions/",
    "title": "Financial statements: Filing requirements & exemptions",
    "quote": "$500,000",
    "as_of": "2026-09-24",
    "scope": "Revenue AND total assets <=500000, current FY consolidated where required, non-publicly-accountable: Simplified XBRL + PDF. Other ordinary private companies: Full XBRL. Solvent EPC need not file. Banks/insurers, CLGs, dormant relevant companies and approved other accounting standards require separate assessment."
  },
  "epc": {
    "url": "https://sso.agc.gov.sg/Act/CoA1967#pr4-",
    "title": "Companies Act 1967 — section 4",
    "quote": "not more than 20 members",
    "as_of": "2026-09-24",
    "scope": "No direct/indirect corporate beneficial interest; alternative gazetted wholly government-owned EPC limb. Statute controls over ACRA web summary saying fewer than 20."
  }
});

const addMonthsISO = (dateISO, months) => {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  if (dt.getUTCDate() !== d) dt.setUTCDate(0); // clamp month-end overflow
  return toUtcIsoDay(dt); // UTC on purpose: Date.UTC arithmetic on a bare calendar day
};

const isoDate = (value) => {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// ---------------------------------------------------------------------------------
// The statutory calendar (non-listed company, post-2018 alignment regime):
//   • AGM — within 6 months after FYE (unless exempt: a private company that
//     sends financial statements to members within 5 months of FYE, or has
//     dispensed with AGMs by resolution).
//   • Annual return — within 7 months after FYE (no overseas branch register).
// agmExempt is an established legal fact, including member/auditor rights, not
// a result inferred here merely from having prepared financial statements.
// ---------------------------------------------------------------------------------
export const buildAcraStatutoryDeadlines = ({ fyEndsOn, agmExempt = false } = {}) => {
  const ends = isoDate(fyEndsOn);
  if (!ends) {
    const error = new Error('buildAcraStatutoryDeadlines requires fyEndsOn (ISO date).');
    error.statusCode = 400;
    error.code = 'SINGAPORE_ACRA_PERIOD_INVALID';
    throw error;
  }
  return {
    fy_ends_on: ends,
    deadlines: [
      {
        kind: 'agm',
        due_on: addMonthsISO(ends, 6),
        applies: !agmExempt,
        note: agmExempt
          ? 'AGM exempt (private company: financial statements sent to members within 5 months of FYE, or unanimous AGM dispensation/dormant-company exemption; subject to statutory meeting rights).'
          : 'AGM within 6 months of financial year end.'
      },
      {
        kind: 'annual_return',
        due_on: addMonthsISO(ends, 7),
        applies: true,
        note: 'Annual return (Bizfile) within 7 months of financial year end.'
      }
    ],
    provenance: { ...ACRA_FILING_PROVENANCE }
  };
};

// ---------------------------------------------------------------------------------
// XBRL filing requirement (the verkkolasku-format analogue, applied to the
// annual-return financial statements).
// ---------------------------------------------------------------------------------
// Scope: ordinary private companies using prescribed Singapore standards.
// Revenue/assets are consolidated where required; simplified also needs
// a PDF copy. Special regulated, dormant and other-standards cases are outside
// this three-tier helper. See ACRA_FILING_PROVENANCE.xbrl.
// Under the ACRA requirements:
//   • A solvent EXEMPT PRIVATE COMPANY (≤20 shareholders, no corporate
//     beneficial interest directly or indirectly) need not file financial statements at all → 'none'.
//   • An insolvent EPC / a non-EPC private company files XBRL:
//     'simplified' when the company qualifies as a SMALLER company (revenue AND
//     total assets each ≤ S$500,000) and is non-publicly-accountable;
//     'full' otherwise.
export const XBRL_SMALLER_COMPANY_CEILING_SGD = 500000;

export const XBRL_REQUIREMENTS = Object.freeze(['none', 'simplified', 'full']);

export const xbrlRequirementFor = ({
  exemptPrivateCompany = false,
  solvent = true,
  revenue = 0,
  totalAssets = 0,
  publiclyAccountable = false
} = {}) => {
  if (exemptPrivateCompany && solvent) return 'none';
  const smaller = num(revenue) <= XBRL_SMALLER_COMPANY_CEILING_SGD
    && num(totalAssets) <= XBRL_SMALLER_COMPANY_CEILING_SGD
    && !publiclyAccountable;
  return smaller ? 'simplified' : 'full';
};

// buildAnnualReturnAssessment — the readiness verdict for the annual-return
// lane: the calendar + the XBRL requirement + the blockers that keep it from
// being filable. Deterministic; blockers name what is missing so the ask
// pipeline can turn each into an owner question (two-terminal-states: a
// blocked annual return is ON THE OWNER via those asks, never firm-side limbo).
export const buildAnnualReturnAssessment = ({
  fyEndsOn,
  agmExempt = false,
  agmHeldOn = null,
  financialStatementsReady = false,
  exemptPrivateCompany = false,
  solvent = true,
  revenue = 0,
  totalAssets = 0,
  publiclyAccountable = false
} = {}) => {
  const calendar = buildAcraStatutoryDeadlines({ fyEndsOn, agmExempt });
  const xbrl = xbrlRequirementFor({ exemptPrivateCompany, solvent, revenue, totalAssets, publiclyAccountable });
  const blockers = [];
  if (!financialStatementsReady) blockers.push('financial_statements_not_ready');
  if (!agmExempt && !isoDate(agmHeldOn)) blockers.push('agm_not_held');
  if (xbrl !== 'none' && !financialStatementsReady) blockers.push('xbrl_source_statements_missing');
  return {
    fy_ends_on: calendar.fy_ends_on,
    deadlines: calendar.deadlines,
    xbrl_requirement: xbrl,
    status: blockers.length ? 'needs_review' : 'ready',
    blockers,
    provenance: { ...ACRA_FILING_PROVENANCE }
  };
};
