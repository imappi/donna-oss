// Named composition root for profile validation. A registered country owns its
// fields; a country with no authored fields never borrows another country's tax.
import { PROFILE_VALIDATORS as fi } from './finland/profileValidation.js';
import { PROFILE_VALIDATORS as sg } from './singapore/profileValidation.js';
import { PROFILE_VALIDATORS as gb } from './gb/profileValidation.js';
import { PROFILE_VALIDATORS as ae } from './ae/profileValidation.js';
import { PROFILE_VALIDATORS as us } from './us/profileValidation.js';
import { PROFILE_VALIDATORS as au } from './au/profileValidation.js';
import { normalizeProfileJurisdiction, throwProfileBadRequest } from './profileValidation.js';

export const createProfileValidationRegistry = (definitions) => {
  const countries = {};
  const fields = new Set();
  for (const [country, validators] of Object.entries(definitions)) {
    if (!/^[a-z]{2}$/.test(country) || !validators || typeof validators !== 'object' || Array.isArray(validators)) {
      throw new TypeError('Profile registry requires canonical country codes and field validators.');
    }
    for (const [key, validator] of Object.entries(validators)) {
      if (typeof validator !== 'function') throw new TypeError(`Invalid profile validator: ${country}.${key}`);
      fields.add(key);
    }
    countries[country] = Object.freeze({ ...validators });
  }
  return Object.freeze({ countries: Object.freeze(countries), fields: Object.freeze([...fields]) });
};

export const PROFILE_VALIDATION_REGISTRY = createProfileValidationRegistry({ sg, fi, gb, ae, us, au });

export const profilePatchNeedsCountryValidation = (patch, registry = PROFILE_VALIDATION_REGISTRY) =>
  Object.entries(patch).some(([key, value]) => value !== null && registry.fields.includes(key));

export const normalizeCountryProfileValue = ({ key, value, jurisdiction, warnings = [], registry = PROFILE_VALIDATION_REGISTRY, nativeLineage = null }) => {
  if (!registry.fields.includes(key)) return { handled: false };
  // Clearing a recorded fact grants no tax status and invokes no country policy.
  if (value === null) return { handled: true, value: null };
  const country = normalizeProfileJurisdiction(jurisdiction);
  const details = { jurisdiction: country || null, key };
  if (!country) throwProfileBadRequest(`${key} requires an explicit client jurisdiction.`, 'profile_jurisdiction_unresolved', details);
  if (!Object.prototype.hasOwnProperty.call(registry.countries, country)) {
    throwProfileBadRequest(`${key} has no profile validation registered for jurisdiction '${country}'.`, 'profile_jurisdiction_unsupported', details);
  }
  const validators = registry.countries[country];
  if (!Object.prototype.hasOwnProperty.call(validators, key)) {
    throwProfileBadRequest(`${key} is not supported for jurisdiction '${country}'.`, 'profile_field_unsupported', details);
  }
  return { handled: true, value: validators[key](value, warnings, { jurisdiction: country, nativeLineage }) };
};
