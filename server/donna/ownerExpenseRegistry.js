// Named composition root: expense support is independent of coding and outbound.
// Register existing operations only. Rates and their limitations belong to countries.
import { computeOwnerMileage as fiMileage } from './finland/ownerExpensePolicy.js';
import { computeOwnerMileage as gbMileage } from './gb/ownerExpensePolicy.js';
import { computeOwnerMileage as usMileage } from './us/ownerExpensePolicy.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';

export const createOwnerExpenseRegistry = (definitions) => {
  const registry = {};
  for (const [country, operations] of Object.entries(definitions)) {
    if (!/^[a-z]{2}$/.test(country) || !operations || typeof operations !== 'object'
        || Object.values(operations).some((operation) => typeof operation !== 'function')) {
      throw new TypeError('Owner expense registration requires canonical country and callable operations.');
    }
    registry[country] = Object.freeze({ ...operations });
  }
  return Object.freeze(registry);
};
export const OWNER_EXPENSE_REGISTRY = createOwnerExpenseRegistry({
  fi: { mileage: fiMileage }, gb: { mileage: gbMileage }, us: { mileage: usMileage }
});

// Preserve documented aliases at the pure compatibility entry. Database admission
// passes only strict persisted identity, never a substring inferred from prose.
const aliases = Object.freeze({ finland: 'fi', usa: 'us', 'united states': 'us', 'united states of america': 'us', 'united kingdom': 'gb' });
export const resolveOwnerExpenseCapability = ({ jurisdiction, operation, registry = OWNER_EXPENSE_REGISTRY } = {}) => {
  const raw = String(jurisdiction || '').trim().toLowerCase();
  const country = normalizeJurisdictionKey(raw) || aliases[raw];
  if (!country || !Object.hasOwn(registry, country) || !Object.hasOwn(registry[country], operation)) return null;
  const implementation = registry[country][operation];
  if (typeof implementation !== 'function') throw new TypeError('Invalid owner expense implementation.');
  return Object.freeze({ operation, jurisdiction: country, implementation });
};
