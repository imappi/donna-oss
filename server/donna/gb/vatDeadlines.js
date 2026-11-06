// Shared VAT deadline rows for GB entity packs. Registration is deliberately
// tri-state: an explicit non-registration is silence, while an absent fact is
// returned to the owner as a named refusal.
import { resolveGbVatQuarterEnds } from './ltdStatutoryDeadlines.js';
import { resolveGbVatRegistrationOnDate } from './vatRegistration.js';
import { toUtcIsoDay } from '../dates.js';

const row = (key, label, due_date) => ({ key, label, due_date, terminal: 'scheduled' });
const refusal = (key, label, reason_code) => ({ key, label, due_date: null, terminal: 'on_owner', reason_code });

export const buildGbVatDeadlineRows = ({
  profile = {},
  onDate,
  year,
  refusalCodes = {}
} = {}) => {
  const vat = resolveGbVatRegistrationOnDate({ registration: profile.vat_registration, onDate });
  if (vat.registered === false) return [];
  if (vat.registered === null) {
    return [refusal('vat_registration', 'VAT registration status', refusalCodes.vatRegistration)];
  }
  if (!profile.vat_stagger) {
    return [refusal('vat_stagger', 'VAT return deadlines', refusalCodes.vatStagger)];
  }
  return resolveGbVatQuarterEnds({ year, stagger: profile.vat_stagger }).map((end, index) => {
    const [endYear, endMonth] = end.split('-').map(Number);
    // UTC on purpose: month-end + 7 days in Date.UTC space — the host zone
    // must not move the statutory day.
    const due = toUtcIsoDay(Date.UTC(endYear, endMonth + 1, 7));
    return row(`vat_${index + 1}`, `VAT return and payment (${end})`, due);
  });
};
