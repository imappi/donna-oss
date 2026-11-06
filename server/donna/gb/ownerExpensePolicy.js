import { GB_OWNER_TRANSACTION_PROVENANCE } from './ownerTransactionTaxonomy.js';
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Preserve the existing AMAP tiers and unverified provenance; this is no rate graduation.
export const computeOwnerMileage = ({ miles, year }) => {
  const distance = Number(miles);
  if (!Number.isFinite(distance) || distance <= 0) return { status: 'needs_clarification', reason: 'missing_distance', year };
  const firstRate = GB_OWNER_TRANSACTION_PROVENANCE.rules.amap_first_10k_rate_gbp.value;
  const overRate = GB_OWNER_TRANSACTION_PROVENANCE.rules.amap_over_10k_rate_gbp.value;
  const firstMiles = Math.min(distance, 10000);
  const overMiles = Math.max(0, distance - 10000);
  return {
    status: 'computed', jurisdiction: 'GB', unit: 'mile', year, exactRate: false,
    miles: distance, firstMiles, overMiles, rate: firstRate, overRate,
    currency: 'GBP', deduction: round2(firstMiles * firstRate + overMiles * overRate),
    source: 'HMRC Approved Mileage Allowance Payments (AMAP), remembered rates pending primary verification',
    confirmedAgainstPrimary: false
  };
};
