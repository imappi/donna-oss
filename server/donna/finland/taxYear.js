// FI-13 slice 13.1b — the TaxYear object, in three layers (D-FI13-3 v3).
//
// A yhteisö's corporate tax year (VEROVUOSI) is NOT the tilikausi and NOT a rate
// stamped on a period. §1 rule: the tax year is the CALENDAR YEAR, unless the
// tilikausi is off-calendar, in which case the tax year is the tilikausi — or
// tilikaudet — that END during that calendar year, and MULTIPLE periods ending
// in one calendar year COMBINE into ONE tax year. So the tax year is a derived
// identity over the fiscal-period registry, distinct from `fiscal_years`
// (D-FI13-14 / 13.1a). This module is that identity plus the two layers built on
// it, split per Kimi G9:
//
//   • TaxYear            — IMMUTABLE identity: { calendar_year, fiscal_period_ids[],
//                          starts_on, ends_on }. The verovuosi, nothing derived.
//   • TaxYearComputation — DERIVED with lineage: a taxable-income snapshot, a
//                          carried-losses snapshot (incl. loss vintage), the rate
//                          keyed on the TaxYear, and the forecast tax. The
//                          AUTHORITATIVE reconciliation BASIS (D-FI13-4: profit
//                          before tax ± adjustments − usable losses) lands in
//                          slice 13.5; here the layer is the shape + lineage so
//                          13.5 fills it. It NEVER does "rate × posted result".
//   • TaxYearSettlement  — STATE: prepayments, additional prepayments, the Vero
//                          assessment, and return submissions, with a derived net
//                          position. Populated as those events arrive (13.5).
//
// The yhteisövero rate table keys on the TaxYear. 20 % is confirmed; 18 % was
// ANNOUNCED from 2027 but is coded ONLY after the boundary rule is primary-
// confirmed (F-FI13-V) — until then a 2027+ tax year resolves to 20 % carrying a
// dated `pending_rate_change` note, never a silent 18 %. A pilot tilikausi
// crossing the 2026/2027 boundary is ALSO an acceptance-envelope exclusion
// (D-FI13-13), so the RateChangeEvent path stays COLD in the pilot; it is modelled
// here as an extension point that reports "not enacted in code", not a live post.
//
// Pure module: no DB, no model call, deterministic. The DB caller that reads the
// fiscal-period rows and persists computations/settlements arrives with 13.5.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ── The yhteisövero rate table, keyed on the TaxYear (verovuosi) ─────────────

// The confirmed corporate income-tax rate era. 20 % is the standing rate. The
// 18 % era, announced from 2027, is DELIBERATELY absent until F-FI13-V confirms
// the boundary rule against a primary source — see the header. Extend this table
// (add an 18 % era) only on a dated Kari call + a primary citation, never on the
// strength of the announcement alone.
export const YHTEISOVERO_CONFIRMED_RATE = 0.20;

// The first calendar year for which a rate other than the confirmed 20 % has been
// ANNOUNCED but not yet coded. A tax year at/after this resolves to the confirmed
// rate PLUS a pending_rate_change note (never a silent switch).
export const YHTEISOVERO_PENDING_CHANGE_FROM_YEAR = 2027;

// yhteisoveroRateForTaxYear(calendarYear) → { rate, status, note_en, note_fi }.
// status: 'confirmed' (the rate is the coded, current-era rate) or
// 'pending_rate_change' (an announced future rate the code does NOT yet apply —
// the value is still the confirmed rate, flagged). Pure, never throws; a bad
// year resolves to the confirmed rate flagged as unknown-provenance.
export const yhteisoveroRateForTaxYear = (calendarYear) => {
  const year = Number(calendarYear);
  if (!Number.isInteger(year)) {
    return {
      rate: YHTEISOVERO_CONFIRMED_RATE,
      status: 'pending_rate_change',
      note_en: 'Unrecognised tax year; applying the confirmed 20 % rate pending verification.',
      note_fi: 'Tuntematon verovuosi; sovelletaan vahvistettua 20 %:n kantaa varmistukseen asti.'
    };
  }
  if (year >= YHTEISOVERO_PENDING_CHANGE_FROM_YEAR) {
    return {
      rate: YHTEISOVERO_CONFIRMED_RATE,
      status: 'pending_rate_change',
      note_en: `Yhteisövero 18 % was announced from ${YHTEISOVERO_PENDING_CHANGE_FROM_YEAR}; the 18 % era is not yet coded (awaiting primary confirmation). Applying 20 % with a pending-rate-change flag.`,
      note_fi: `Yhteisöveron 18 %:n kanta ilmoitettiin alkavaksi vuodesta ${YHTEISOVERO_PENDING_CHANGE_FROM_YEAR}; 18 %:n aikakautta ei ole vielä koodattu (odottaa ensisijaislähteen varmistusta). Sovelletaan 20 %:a ja merkitään verokannan muutos vireillä -lippu.`
    };
  }
  return {
    rate: YHTEISOVERO_CONFIRMED_RATE,
    status: 'confirmed',
    note_en: null,
    note_fi: null
  };
};

// ── Layer 1: the TaxYear identity (verovuosi) ────────────────────────────────

// A fiscal period is { id, starts_on, ends_on }. The verovuosi is keyed by the
// calendar year the period ENDS in (§1). deriveTaxYears groups a client's periods
// into TaxYears, COMBINING every period that ends in the same calendar year into
// one tax year. Returns the tax years sorted ascending by calendar_year. Pure;
// periods with a non-ISO ends_on are ignored (they cannot be placed).
export const deriveTaxYears = ({ fiscalPeriods = [] } = {}) => {
  const byYear = new Map();
  for (const p of Array.isArray(fiscalPeriods) ? fiscalPeriods : []) {
    if (!isIsoDate(p?.ends_on)) continue;
    const calendarYear = Number(p.ends_on.slice(0, 4));
    const entry = byYear.get(calendarYear) || { calendar_year: calendarYear, periods: [] };
    entry.periods.push(p);
    byYear.set(calendarYear, entry);
  }
  return [...byYear.values()]
    .sort((a, b) => a.calendar_year - b.calendar_year)
    .map(({ calendar_year, periods }) => {
      const sorted = [...periods].sort((a, b) =>
        a.starts_on < b.starts_on ? -1 : a.starts_on > b.starts_on ? 1 : 0
      );
      return buildTaxYear({
        calendarYear: calendar_year,
        fiscalPeriodIds: sorted.map((p) => p.id ?? null),
        // The tax year spans from the earliest start to the latest end of its
        // combined periods (a single off-calendar period, or two short ones).
        startsOn: sorted.reduce((min, p) => (isIsoDate(p.starts_on) && (!min || p.starts_on < min) ? p.starts_on : min), null),
        endsOn: sorted.reduce((max, p) => (isIsoDate(p.ends_on) && (!max || p.ends_on > max) ? p.ends_on : max), null),
        combinedPeriodCount: sorted.length
      });
    });
};

// buildTaxYear(...) → the immutable identity record. `combined` is true when more
// than one tilikausi ends in the calendar year (a signal downstream: combined
// tax years need the accountant's eye on which period the 6B reports).
export const buildTaxYear = ({
  calendarYear, fiscalPeriodIds = [], startsOn = null, endsOn = null, combinedPeriodCount = null
} = {}) => ({
  calendar_year: Number(calendarYear),
  fiscal_period_ids: [...fiscalPeriodIds],
  starts_on: startsOn,
  ends_on: endsOn,
  combined: (combinedPeriodCount ?? fiscalPeriodIds.length) > 1,
  provenance: { deterministic: true, rule: 'verovuosi = calendar year of tilikausi end; multiple periods ending in one year combine (D-FI13-3 §1)' }
});

// ── Layer 2: the TaxYear computation (derived, with lineage) ─────────────────

// buildTaxYearComputation(...) → the derived tax computation for a TaxYear. This
// is the LAYER (shape + lineage + the rate application); the AUTHORITATIVE
// taxable-income basis (accounting profit before tax ± non-deductibles/timing −
// usable losses, D-FI13-4) is produced by the 13.5 reconciliation and passed in
// as `taxableIncome` — this function NEVER derives it from a posted result. The
// carried-losses snapshot carries vintage so loss expiry is visible downstream.
export const buildTaxYearComputation = ({
  taxYear,
  taxableIncome = null,
  carriedLosses = [],
  lineage = {}
} = {}) => {
  const rate = yhteisoveroRateForTaxYear(taxYear?.calendar_year);
  const income = taxableIncome === null ? null : round2(num(taxableIncome));
  const usableLosses = round2((Array.isArray(carriedLosses) ? carriedLosses : []).reduce((n, l) => n + num(l?.amount), 0));
  const incomeAfterLosses = income === null ? null : round2(Math.max(0, income - usableLosses));
  const forecastTax = incomeAfterLosses === null ? null : round2(incomeAfterLosses * rate.rate);
  return {
    calendar_year: taxYear?.calendar_year ?? null,
    rate: rate.rate,
    rate_status: rate.status,
    rate_note_en: rate.note_en,
    rate_note_fi: rate.note_fi,
    taxable_income: income,
    carried_losses: (Array.isArray(carriedLosses) ? carriedLosses : []).map((l) => ({
      amount: round2(num(l?.amount)),
      vintage_year: l?.vintage_year ?? null,
      source: l?.source ?? null
    })),
    usable_losses: usableLosses,
    taxable_income_after_losses: incomeAfterLosses,
    forecast_tax: forecastTax,
    // Lineage travels so the number is auditable back to its sources; 13.5 fills
    // the reconciliation ids/rules. `basis_pending` marks that the authoritative
    // basis has not yet been supplied (income is null).
    lineage: { ...lineage, basis_pending: income === null },
    provenance: { deterministic: true, basis: 'D-FI13-4 reconciliation supplies taxable_income (slice 13.5); never rate × posted result' }
  };
};

// ── Layer 3: the TaxYear settlement (state) ──────────────────────────────────

// buildTaxYearSettlement(...) → the settlement STATE for a TaxYear: the three
// never-merged concepts (Donna forecast, Vero prepayment decision, final
// assessment) tracked separately, plus submissions, with a derived net position
// = assessment (or forecast if unassessed) − prepayments − additional prepayments.
// Pure aggregation; the writers that record decisions/assessments arrive with 13.5.
export const buildTaxYearSettlement = ({
  taxYear,
  forecastTax = null,
  prepayments = [],
  additionalPrepayments = [],
  assessment = null,
  submissions = []
} = {}) => {
  const sum = (rows) => round2((Array.isArray(rows) ? rows : []).reduce((n, r) => n + num(r?.amount), 0));
  const prepaidTotal = round2(sum(prepayments) + sum(additionalPrepayments));
  const liability = assessment && assessment.amount != null ? round2(num(assessment.amount))
    : forecastTax === null ? null : round2(num(forecastTax));
  const netPosition = liability === null ? null : round2(liability - prepaidTotal);
  return {
    calendar_year: taxYear?.calendar_year ?? null,
    forecast_tax: forecastTax === null ? null : round2(num(forecastTax)),
    prepayments_total: sum(prepayments),
    additional_prepayments_total: sum(additionalPrepayments),
    prepaid_total: prepaidTotal,
    assessment: assessment ? { amount: assessment.amount == null ? null : round2(num(assessment.amount)), decided_on: assessment.decided_on ?? null } : null,
    // > 0 ⇒ residual tax owed; < 0 ⇒ a refund position; based on the assessment
    // when present, else the forecast (clearly flagged by `basis`).
    net_position: netPosition,
    net_position_basis: assessment && assessment.amount != null ? 'assessment' : 'forecast',
    submission_count: Array.isArray(submissions) ? submissions.length : 0,
    provenance: { deterministic: true, note: 'three concepts kept separate: Donna forecast · Vero prepayment decision · final assessment (D-FI13-4)' }
  };
};

// ── RateChangeEvent — cold in the pilot (extension point) ────────────────────

// evaluateRateChange({ taxYear }) → whether a coded rate-era change applies to
// this tax year. In the pilot NO alternate era is coded (see the rate table), so
// this always reports "not enacted in code" — the RateChangeEvent posting path
// (re-evaluate open provisions, post the difference with lineage + owner copy) is
// the D-FI13-3 extension point, wired only when an 18 % (or other) era is
// confirmed AND coded. A pilot tilikausi crossing the boundary is an acceptance
// exclusion (D-FI13-13), so this staying cold is correct, not a gap.
export const evaluateRateChange = ({ taxYear } = {}) => {
  const rate = yhteisoveroRateForTaxYear(taxYear?.calendar_year);
  return {
    applies: false,
    reason: rate.status === 'pending_rate_change' ? 'rate_era_announced_not_coded' : 'no_rate_change',
    calendar_year: taxYear?.calendar_year ?? null,
    coded_rate: rate.rate,
    rate_status: rate.status,
    provenance: { deterministic: true, note: 'RateChangeEvent posts only when an alternate rate era is confirmed AND coded (F-FI13-V); cold in the pilot' }
  };
};
