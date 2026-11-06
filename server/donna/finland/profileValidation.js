// Country-owned profile fields. Registration is independent of legal form and tax status.
import { normalizeYelProfile } from './yel.js';
import { normalizeEnnakkoveroProfile } from './ennakkovero.js';
import { normalizeTaxAdjustmentsProfile } from './taxAdjustments.js';
import { normalizeCutoverProfile } from './cutover.js';
import { normalizeAlvRegistrationProfile } from './alvRegistration.js';
import { throwProfileBadRequest as throwBadRequest } from '../profileValidation.js';

export const PROFILE_VALIDATORS = Object.freeze({
  yel: (value) => normalizeYelProfile(value),
  ennakkovero: (value) => normalizeEnnakkoveroProfile(value),
  tax_adjustments: (value) => normalizeTaxAdjustmentsProfile(value),
  cutover: (value) => normalizeCutoverProfile(value),
  alv_registration: (value) => normalizeAlvRegistrationProfile(value),
  verokausi: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('verokausi must be a string.');
    const lower = value.trim().toLowerCase();
    if (!lower) return null;
    const canonical = {
      month: 'month', monthly: 'month', kuukausi: 'month',
      quarter: 'quarter', quarterly: 'quarter', neljannes: 'quarter', neljännes: 'quarter',
      year: 'year', yearly: 'year', annual: 'year', annually: 'year', vuosi: 'year'
    }[lower];
    if (!canonical) {
      throwBadRequest(`verokausi must be one of month | quarter | year, got ${JSON.stringify(value)}.`);
    }
    return canonical;
  }
});
