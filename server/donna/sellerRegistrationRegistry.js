// Named composition root for the seller-registration operation. Coding or
// outbound support never implies that a registration regime is implemented.
import { resolveSellerRegistration as gb } from './gb/sellerRegistration.js';
import { resolveSellerRegistration as ae } from './ae/sellerRegistration.js';
import { resolveSellerRegistration as fi } from './finland/sellerRegistration.js';
import { resolveSellerRegistration as sg } from './singapore/sellerRegistration.js';
import { unknownSellerRegistration, isRegistrationRecord } from './sellerRegistration.js';
import { toIsoDay, toUtcIsoDay } from './dates.js';
import { normalizeProfileJurisdiction } from './profileValidation.js';

export const createSellerRegistrationRegistry = (definitions) => {
  const registry = {};
  for (const [country, resolver] of Object.entries(definitions)) {
    if (!/^[a-z]{2}$/.test(country) || (resolver !== null && typeof resolver !== 'function')) {
      throw new TypeError('Seller registration requires canonical country keys and resolver functions or explicit null.');
    }
    registry[country] = resolver;
  }
  return Object.freeze(registry);
};

// Null explicitly records no authored regime; it does not assert non-registration.
export const SELLER_REGISTRATION_REGISTRY = createSellerRegistrationRegistry({ gb, ae, fi, sg, us: null, au: null });

export const resolveRegisteredSellerTax = ({ jurisdiction, profile = {}, onDate } = {},
  { registry = SELLER_REGISTRATION_REGISTRY } = {}) => {
  const at = toIsoDay(onDate);
  if (!at) return unknownSellerRegistration(null, 'no_as_of_date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || toUtcIsoDay(at) !== at) {
    return unknownSellerRegistration(null, 'invalid_as_of_date');
  }
  const country = normalizeProfileJurisdiction(jurisdiction);
  if (!country || !/^[a-z]{2}$/.test(country)) return unknownSellerRegistration(null, 'jurisdiction_unresolved');
  if (!Object.prototype.hasOwnProperty.call(registry, country) || registry[country] === null) {
    return unknownSellerRegistration(null, 'no_regime_for_jurisdiction');
  }
  if (typeof registry[country] !== 'function') return unknownSellerRegistration(null, 'seller_registration_invalid');
  let result;
  try { result = registry[country]({ profile: isRegistrationRecord(profile) ? profile : {}, onDate: at }); }
  catch { return unknownSellerRegistration(null, 'seller_registration_unavailable'); }
  if (!result || ![true, false, null].includes(result.taxRegistered)
    || !(result.taxRegistrationId === null || (typeof result.taxRegistrationId === 'string' && result.taxRegistrationId.trim()))
    || !(result.regime === null || (typeof result.regime === 'string' && result.regime.trim()))
    || typeof result.reason !== 'string' || !result.reason.trim()
    || typeof result.confirmedAgainstPrimary !== 'boolean'
    || (result.taxRegistered !== true && result.taxRegistrationId !== null)) {
    return unknownSellerRegistration(null, 'seller_registration_invalid');
  }
  return result;
};
