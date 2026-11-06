import { usBusinessMileageDeduction } from './mileage.js';

export const computeOwnerMileage = ({ miles, year }) => {
  const computed = usBusinessMileageDeduction({ miles, year });
  if (!computed.exactRate) return { status: 'needs_clarification', reason: 'missing_us_rate_for_year', year };
  return { status: 'computed', unit: 'mile', ...computed };
};
