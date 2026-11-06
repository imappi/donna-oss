// US standard business mileage rates — KEEP-layer statutory constants.
// Source: IRS "Standard mileage rates" page and Notice 2026-10; verified 2026-07-15.
// The 2026 business rate is 72.5 cents per mile. This is a computation constant,
// not tax advice; eligibility remains professional/owner judgment.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const US_MILEAGE_RATE_BY_YEAR = Object.freeze({
  2026: Object.freeze({
    business: 0.725,
    currency: 'USD',
    unit: 'mile',
    source: 'IRS Notice 2026-10 / irs.gov standard mileage rates, verified 2026-07-15',
    confirmedAgainstPrimary: true
  })
});

export const usMileageRateForYear = (year) => {
  const requested = Number(year);
  const years = Object.keys(US_MILEAGE_RATE_BY_YEAR).map(Number).sort((a, b) => a - b);
  const latest = years.at(-1);
  const resolvedYear = US_MILEAGE_RATE_BY_YEAR[requested] ? requested : latest;
  return {
    year: resolvedYear,
    exact: resolvedYear === requested,
    rate: US_MILEAGE_RATE_BY_YEAR[resolvedYear]
  };
};

export const usBusinessMileageDeduction = ({ miles = 0, year } = {}) => {
  const n = Number(miles);
  const cleanMiles = Number.isFinite(n) && n > 0 ? n : 0;
  const { year: resolvedYear, exact, rate } = usMileageRateForYear(year);
  return {
    jurisdiction: 'US',
    year: resolvedYear,
    exactRate: exact,
    miles: round2(cleanMiles),
    rate: rate.business,
    currency: rate.currency,
    deduction: round2(cleanMiles * rate.business),
    source: rate.source
  };
};
