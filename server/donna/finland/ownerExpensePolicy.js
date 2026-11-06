import { mileageDeduction as finlandMileageDeduction } from './mileageAndPerDiem.js';

export const computeOwnerMileage = ({ miles, km, year }) => {
  const rawKm = Number(km ?? (Number(miles) * 1.609344));
  const computed = finlandMileageDeduction({ trips: [{ km: rawKm }], year });
  if (!computed.exactRate) return { status: 'needs_clarification', reason: 'missing_fi_rate_for_year', year };
  return {
    status: 'computed', jurisdiction: 'FI', unit: 'km', year: computed.year,
    exactRate: computed.exactRate, km: computed.totalKm, rate: computed.rate,
    currency: 'EUR', deduction: computed.deduction,
    source: 'Verohallinto tax-free travel-cost reimbursement decision rate table'
  };
};
