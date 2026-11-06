// Country-owned profile fields. Registration is independent of legal form and tax status.
import { normalizeGstRegistration, normalizeNativeGstRegistration } from './gstRegistration.js';
import { throwProfileBadRequest as throwBadRequest } from '../profileValidation.js';

export const PROFILE_VALIDATORS = Object.freeze({
  gst_period: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('gst_period must be a string.');
    const lower = value.trim().toLowerCase();
    if (!lower) return null;
    const canonical = { month: 'month', monthly: 'month', quarter: 'quarter', quarterly: 'quarter' }[lower];
    if (!canonical) {
      throwBadRequest(`gst_period must be one of month | quarter, got ${JSON.stringify(value)}.`);
    }
    return canonical;
  },
  uen: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('uen must be a string.');
    const trimmed = value.trim().toUpperCase();
    if (!trimmed) return null;
    if (trimmed.length > 12) throwBadRequest('uen must be 12 characters or fewer.');
    return trimmed;
  },
  gst_registration: (value, _warnings, { nativeLineage } = {}) => nativeLineage
    ? normalizeNativeGstRegistration(value) : (value === null ? null : normalizeGstRegistration(value))
});
