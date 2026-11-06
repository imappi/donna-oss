import { lifecycleJurisdiction } from './countryLifecycleContext.js';
// Named client lifecycle composition root. Identity validation and persistence
// remain in the named profile/client writers; only country-owned effects dispatch here.
import { FI_CLIENT_LIFECYCLE } from './finland/clientLifecycle.js';
import { SG_CLIENT_LIFECYCLE } from './singapore/clientLifecycle.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
export const CLIENT_LIFECYCLE_REGISTRY = Object.freeze({ fi: FI_CLIENT_LIFECYCLE, sg: SG_CLIENT_LIFECYCLE });
export const resolveClientLifecycle = (jurisdiction, registry = CLIENT_LIFECYCLE_REGISTRY) =>
  Object.hasOwn(registry, normalizeJurisdictionKey(jurisdiction)) ? registry[normalizeJurisdictionKey(jurisdiction)] : null;
export const resolveClientLifecycleAxis = (row, registry = CLIENT_LIFECYCLE_REGISTRY) => {
  const country = lifecycleJurisdiction(row);
  return country ? resolveClientLifecycle(country, registry)?.entityAxis?.(row) ?? null : null;
};

// Bounded FI pilot intake is installed at this existing country composition root.
export const readFinnishProfileIntakeWithClient = FI_CLIENT_LIFECYCLE.profileIntake.read;
export const assertFinnishProfileIntakeMutableWithClient = FI_CLIENT_LIFECYCLE.profileIntake.assertMutable;
