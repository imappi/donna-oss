// SG-4 — Singapore corporate income tax: YA (Year of Assessment) resolution,
// ECI (Estimated Chargeable Income) obligations, the startup / partial tax
// exemption schemes, and the Pte Ltd statutory filing deadlines. Pure DATA +
// pure compute — the ennakkovero/taxYear/oyStatutoryDeadlines analogues. This
// module COMPUTES; it never files (a CIT filing lane would be its own
// fail-closed transmit seam) and never re-decides an accounting treatment
// (chargeable income adjustments — non-deductibles, capital allowances — are
// the strong model's proposals, refused or accepted by the Keep layer upstream;
// this module does the deterministic schedule arithmetic on the given figures).
//
// Entity guard: these surfaces are Pte-Ltd-only (assertSingaporeCompanyOnly in
// entity.js) — a sole proprietor's income is assessed on the owner (Form B/B1),
// an LLP's on the partners (Form P). The CALLER asserts; this module is pure.

import { toUtcIsoDay } from '../dates.js';

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Config-plane flag (migration 042 pattern) — read via clientFlagActs with
// envFallback () => false, never an env pair.
export const SINGAPORE_CORPORATE_TAX_FLAG_KEY = 'SINGAPORE_CORPORATE_TAX';

// The flat CIT rate (primary source below). YA-specific rebates and credits
// are outside this gross-tax calculation. Do not present grossTax as net payable.
export const SG_CORPORATE_TAX_RATE = 17;

export const SG_CORPORATE_TAX_PROVENANCE = Object.freeze({
  "url": "https://www.iras.gov.sg/quick-links/tax-rates/corporate-income-tax-rates",
  "title": "Corporate Income Tax Rates",
  "quote": "17%",
  "as_of": "2026-09-24",
  "confirmedAgainstPrimary": true,
  "source": "Rate and post-YA2020 SUTE/PTE bands confirmed; rebates deliberately NOT encoded. grossTax is before YA-specific rebates and credits, not final payable.",
  "scope": "Ordinary 12-month basis periods; caller must establish scheme eligibility. Revenue bands alone do not establish Form C-S eligibility.",
  "statute": {
    "url": "https://sso.agc.gov.sg/Act/ITA1947#pr43-",
    "title": "Income Tax Act 1947 — sections 43(1), (6B), (6C), (6D), (8) and 63",
    "quote": "only 25% is chargeable with tax",
    "as_of": "2026-09-24"
  },
  "exemptions": {
    "url": "https://www.iras.gov.sg/quick-links/tax-rates/corporate-income-tax-rates",
    "title": "Corporate Income Tax Rates",
    "quote": "First $100,000",
    "as_of": "2026-09-24",
    "scope": "SUTE first three consecutive YAs, 75% of first 100000 and 50% of next 100000; PTE 75% first 10000 and 50% next 190000, from YA2020."
  },
  "basis_period": {
    "url": "https://www.iras.gov.sg/taxes/corporate-income-tax/basics-of-corporate-income-tax/basic-guide-to-corporate-income-tax-for-companies",
    "title": "Basic Guide to Corporate Income Tax for Companies",
    "quote": "preceding financial year",
    "as_of": "2026-09-24"
  },
  "eci": {
    "url": "https://www.iras.gov.sg/taxes/corporate-income-tax/estimated-chargeable-income-(eci)-filing",
    "title": "Estimated Chargeable Income (ECI) Filing",
    "quote": "within 3 months",
    "as_of": "2026-09-24",
    "scope": "Annual revenue at most S$5M AND nil ECI before SUTE/PTE; excluded entities and special first periods require separate assessment."
  },
  "eci_month_end": {
    "url": "https://www.iras.gov.sg/due-dates",
    "title": "Due Dates — 2026",
    "quote": "31 Dec 2026",
    "as_of": "2026-09-24",
    "source": "September financial-year-end ECI is due 31 December, not 30 December. Preserve month end for ordinary month-end financial years."
  },
  "forms": {
    "url": "https://www.iras.gov.sg/taxes/corporate-income-tax/form-c-s-form-c-s-(lite)-form-c-filing/overview-of-form-c-s-form-c-s-(lite)-form-c",
    "title": "Overview of Form C-S/ Form C-S (Lite)/ Form C",
    "quote": "$200,000 or below",
    "as_of": "2026-09-24",
    "scope": "C-S revenue <=5M; Lite <=200000 AND all C-S conditions. SG-incorporated; only income taxable at 17% (specified exempt income allowed); no carry-back, group relief, investment allowance, foreign tax credit or tax deducted at source claims."
  },
  "deadline": {
    "url": "https://www.iras.gov.sg/taxes/corporate-income-tax/form-c-s-form-c-s-(lite)-form-c-filing/guidance-on-filing-form-c-s-form-c-s-(lite)-form-c",
    "title": "Guidance on Filing Form C-S/ Form C-S (Lite)/ Form C",
    "quote": "FILE BY 30 NOV",
    "as_of": "2026-09-24"
  }
});

// ---------------------------------------------------------------------------------
// Year of Assessment (YA) resolution.
// ---------------------------------------------------------------------------------
// Singapore assesses on a preceding-year basis: income of the basis period (the
// financial year) ENDING in calendar year N is assessed in YA N+1. E.g. FYE
// 2025-06-30 → YA 2026; FYE 2025-12-31 → YA 2026.
export const yearOfAssessmentForFye = (fyeDateISO) => {
  const d = String(fyeDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return Number(d.slice(0, 4)) + 1;
};

// resolveBasisPeriod({ fyEndsOn }) → { ya, starts_on, ends_on }. The basis
// period is the financial year ending on fyEndsOn; starts_on derives as the day
// after the prior FYE (12-month FY assumed — a first/long/short period is
// client data the caller supplies explicitly, not something to guess here).
export const resolveBasisPeriod = ({ fyEndsOn, fyStartsOn = null } = {}) => {
  const ends = String(fyEndsOn || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ends)) {
    const error = new Error('resolveBasisPeriod requires fyEndsOn (ISO date).');
    error.statusCode = 400;
    error.code = 'SINGAPORE_BASIS_PERIOD_INVALID';
    throw error;
  }
  let starts = String(fyStartsOn || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(starts)) {
    // Day after (FYE − 1 year): a plain 12-month financial year.
    const dt = new Date(`${ends}T00:00:00Z`);
    dt.setUTCFullYear(dt.getUTCFullYear() - 1);
    dt.setUTCDate(dt.getUTCDate() + 1);
    starts = toUtcIsoDay(dt); // UTC on purpose: bare-day arithmetic at T00:00:00Z
  }
  return { ya: yearOfAssessmentForFye(ends), starts_on: starts, ends_on: ends };
};

// ---------------------------------------------------------------------------------
// Exemption schemes (post-YA2020 tiers).
// ---------------------------------------------------------------------------------
// Startup Tax Exemption (SUTE) — first 3 YAs of a qualifying new company
// (SG-incorporated and tax-resident for the YA; throughout its basis period,
// <=20 direct beneficial shareholders, either all individuals OR at least one
// individual with >=10% ordinary shares; not investment-holding/property
// development). Caller establishes these facts; the tiers alone do not: 75% of the first S$100,000 of normal
// chargeable income + 50% of the next S$100,000.
export const STARTUP_EXEMPTION = Object.freeze({
  yaCount: 3,
  tiers: Object.freeze([
    Object.freeze({ upTo: 100000, exemptFraction: 0.75 }),
    Object.freeze({ upTo: 200000, exemptFraction: 0.5 })
  ])
});

// Partial Tax Exemption (PTE) — every other company: 75% of the first S$10,000
// + 50% of the next S$190,000.
export const PARTIAL_EXEMPTION = Object.freeze({
  tiers: Object.freeze([
    Object.freeze({ upTo: 10000, exemptFraction: 0.75 }),
    Object.freeze({ upTo: 200000, exemptFraction: 0.5 })
  ])
});

const exemptAmountForTiers = (chargeableIncome, tiers) => {
  const ci = Math.max(0, num(chargeableIncome));
  let exempt = 0;
  let prevCap = 0;
  for (const tier of tiers) {
    const band = Math.min(ci, tier.upTo) - prevCap;
    if (band > 0) exempt += band * tier.exemptFraction;
    prevCap = tier.upTo;
    if (ci <= tier.upTo) break;
  }
  return round2(exempt);
};

// computeSingaporeCorporateTax({ chargeableIncome, scheme }) — the deterministic
// schedule arithmetic. `chargeableIncome` is the NORMAL chargeable income
// (post-adjustment, pre-exemption) the upstream compute produced; `scheme` is
// 'startup' | 'partial' | 'none'. Returns { chargeableIncome, scheme,
// exemptAmount, taxableAfterExemption, rate, grossTax, provenance }. No rebate
// line — see the provenance note above.
export const computeSingaporeCorporateTax = ({ chargeableIncome = 0, scheme = 'partial' } = {}) => {
  const ci = Math.max(0, round2(num(chargeableIncome)));
  const kind = ['startup', 'partial', 'none'].includes(String(scheme)) ? String(scheme) : 'partial';
  const exemptAmount = kind === 'startup'
    ? exemptAmountForTiers(ci, STARTUP_EXEMPTION.tiers)
    : kind === 'partial'
      ? exemptAmountForTiers(ci, PARTIAL_EXEMPTION.tiers)
      : 0;
  const taxableAfterExemption = round2(Math.max(0, ci - exemptAmount));
  const grossTax = round2((taxableAfterExemption * SG_CORPORATE_TAX_RATE) / 100);
  return {
    chargeableIncome: ci,
    scheme: kind,
    exemptAmount,
    taxableAfterExemption,
    rate: SG_CORPORATE_TAX_RATE,
    grossTax,
    provenance: { ...SG_CORPORATE_TAX_PROVENANCE }
  };
};

// startupExemptionApplies({ incorporationYa, ya }) — is this YA within the
// company's first 3 YAs? ELIGIBILITY (shareholding, excluded activities) is a
// business FACT the owner confirms / the profile records — this only does the
// YA-window arithmetic. Returns false on missing data (conservative: partial
// exemption is the safe default, never over-promise the startup tiers).
export const startupExemptionApplies = ({ incorporationYa, ya } = {}) => {
  const first = num(incorporationYa);
  const current = num(ya);
  if (!first || !current) return false;
  return current >= first && current < first + STARTUP_EXEMPTION.yaCount;
};

// ---------------------------------------------------------------------------------
// ECI (Estimated Chargeable Income).
// ---------------------------------------------------------------------------------
// An ordinary company files ECI within 3 months of its FYE, UNLESS waived: annual
// revenue ≤ S$5,000,000 AND ECI is nil (both conditions). The waiver is
// self-assessed — no application needed. ECI is before SUTE/PTE; specified
// excluded entities are outside this helper (see the ECI primary source).
export const ECI_WAIVER_REVENUE_CEILING_SGD = 5000000;

const addMonthsISO = (dateISO, months) => {
  const [y, m, d] = dateISO.split('-').map(Number);
  // IRAS Due Dates (SG_CORPORATE_TAX_PROVENANCE.eci_month_end): an
  // ordinary month-end FYE stays at month end, e.g. Sep 30 → Dec 31.
  if (d === new Date(Date.UTC(y, m, 0)).getUTCDate()) {
    return toUtcIsoDay(Date.UTC(y, m + months, 0));
  }
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  // Clamp month-end overflow (e.g. Nov 30 + 3 → Feb 28/29, not Mar 2).
  if (dt.getUTCDate() !== d) dt.setUTCDate(0);
  return toUtcIsoDay(dt); // UTC on purpose: Date.UTC arithmetic on a bare calendar day
};

// buildEciAssessment({ fyEndsOn, annualRevenue, estimatedChargeableIncome }) →
// { ya, dueOn, waived, waiverReason, mustFile }. Deterministic; the revenue and
// ECI figures come from the posted book (render-the-persisted-verdict), never
// re-estimated here.
export const buildEciAssessment = ({ fyEndsOn, annualRevenue = 0, estimatedChargeableIncome = 0 } = {}) => {
  const ends = String(fyEndsOn || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ends)) {
    const error = new Error('buildEciAssessment requires fyEndsOn (ISO date).');
    error.statusCode = 400;
    error.code = 'SINGAPORE_BASIS_PERIOD_INVALID';
    throw error;
  }
  const revenue = Math.max(0, round2(num(annualRevenue)));
  const eci = round2(num(estimatedChargeableIncome));
  const waived = revenue <= ECI_WAIVER_REVENUE_CEILING_SGD && eci <= 0;
  return {
    ya: yearOfAssessmentForFye(ends),
    dueOn: addMonthsISO(ends, 3),
    waived,
    waiverReason: waived ? 'revenue_at_most_5m_and_nil_eci' : null,
    mustFile: !waived,
    annualRevenue: revenue,
    estimatedChargeableIncome: eci,
    provenance: { ...SG_CORPORATE_TAX_PROVENANCE }
  };
};

// ---------------------------------------------------------------------------------
// The annual CIT return form + deadline.
// ---------------------------------------------------------------------------------
// Form C-S: revenue ≤ S$5M (and the C-S qualifying conditions — SG-incorporated,
// 17%-rate income only (IRAS allows specified tax-exempt income), no carry-back,
// group relief, investment allowance, foreign tax credit or tax deducted at source);
// Form C-S (Lite): revenue ≤ S$200,000 AND all C-S conditions; Form C otherwise. Filing deadline:
// 30 November of the YA (e-filing).
export const FORM_CS_REVENUE_CEILING_SGD = 5000000;
export const FORM_CS_LITE_REVENUE_CEILING_SGD = 200000;

// Revenue-band candidate only; the caller must verify all non-revenue C-S
// conditions in SG_CORPORATE_TAX_PROVENANCE.forms before choosing C-S/Lite.
export const citReturnFormForRevenue = (annualRevenue = 0) => {
  const revenue = Math.max(0, num(annualRevenue));
  if (revenue <= FORM_CS_LITE_REVENUE_CEILING_SGD) return 'form_c_s_lite';
  if (revenue <= FORM_CS_REVENUE_CEILING_SGD) return 'form_c_s';
  return 'form_c';
};

export const citFilingDueDate = (ya) => {
  const year = num(ya);
  return year ? `${year}-11-30` : null;
};

// buildPteLtdTaxDeadlines({ fyEndsOn, annualRevenue, estimatedChargeableIncome })
// — the per-FY tax calendar for a Pte Ltd (the oyStatutoryDeadlines analogue,
// tax half): ECI + the annual return form/deadline, each entry a closed shape
// { kind, ya, due_on, applies, note }.
export const buildPteLtdTaxDeadlines = ({ fyEndsOn, annualRevenue = 0, estimatedChargeableIncome = 0 } = {}) => {
  const eci = buildEciAssessment({ fyEndsOn, annualRevenue, estimatedChargeableIncome });
  const form = citReturnFormForRevenue(annualRevenue);
  return {
    ya: eci.ya,
    deadlines: [
      {
        kind: 'eci',
        ya: eci.ya,
        due_on: eci.dueOn,
        applies: eci.mustFile,
        note: eci.waived
          ? 'ECI waived: annual revenue ≤ S$5M and ECI is nil (self-assessed waiver).'
          : 'ECI due within 3 months of financial year end.'
      },
      {
        kind: 'cit_return',
        ya: eci.ya,
        due_on: citFilingDueDate(eci.ya),
        applies: true,
        form,
        note: `Corporate income tax return (${form === 'form_c' ? 'Form C' : form === 'form_c_s' ? 'Form C-S' : 'Form C-S (Lite)'}) due 30 November of YA ${eci.ya}. This is a revenue-band candidate; Form C-S/Lite requires all IRAS qualifying conditions, otherwise use Form C.`
      }
    ],
    provenance: { ...SG_CORPORATE_TAX_PROVENANCE }
  };
};
