// Named composition root for country-owned obligation adapters. This registry
// grants no country support beyond the separately validated outbound declaration.
import { STATUTORY_OBLIGATION_BINDINGS as fi } from './finland/statutoryObligations.js';
import { STATUTORY_OBLIGATION_BINDINGS as gb } from './gb/statutoryObligations.js';
import { STATUTORY_OBLIGATION_BINDINGS as ae } from './ae/statutoryObligations.js';

export const createStatutoryObligationRegistry = (registrations) => {
  const bindings = {};
  for (const registration of registrations) {
    for (const [name, entry] of Object.entries(registration)) {
      if (Object.hasOwn(bindings, name) || !entry || typeof entry.run !== 'function'
          || (entry.hourly !== undefined && typeof entry.hourly !== 'boolean')) {
        throw new TypeError(`Invalid or duplicate statutory obligation binding: ${name}`);
      }
      bindings[name] = Object.freeze({ ...entry });
    }
  }
  return Object.freeze(bindings);
};

export const STATUTORY_OBLIGATION_BINDINGS = createStatutoryObligationRegistry([fi, gb, ae]);
