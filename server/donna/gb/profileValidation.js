// Country-owned profile fields. Registration is independent of legal form and tax status.
import { normalizeGbVatRegistration } from './vatRegistration.js';
import { toUtcIsoDay } from '../dates.js';
import { throwProfileBadRequest as throwBadRequest } from '../profileValidation.js';
const isIsoDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // toUtcIsoDay round-trips a bare day and refuses an impossible one
  // (2026-02-30 → '', never a rolled-over March 2).
  return toUtcIsoDay(value) === value;
};

const normalizeGbProfile = (value, warnings = []) => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwBadRequest('gb must be an object or null.');
  }
  const out = {};
  for (const [key, innerValue] of Object.entries(value)) {
    if (key === 'vat_stagger') {
      if (innerValue !== null && ![1, 2, 3].includes(innerValue)) {
        throwBadRequest('GB_VAT_STAGGER_INVALID: gb.vat_stagger must be 1, 2, 3, or null.');
      }
      out[key] = innerValue;
    } else if (key === 'confirmation_review_period_end' || key === 'accounting_period_end') {
      if (innerValue !== null && !isIsoDate(innerValue)) {
        throwBadRequest(`GB_FILING_DATE_INVALID: gb.${key} must be an ISO date or null.`);
      }
      out[key] = innerValue;
    } else {
      warnings.push(`Unknown gb profile key preserved: ${key}.`);
      out[key] = innerValue;
    }
  }
  return out;
};

export const PROFILE_VALIDATORS = Object.freeze({
  gb: normalizeGbProfile,
  vat_registration: (value) => normalizeGbVatRegistration(value)
});
