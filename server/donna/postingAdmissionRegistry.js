import { lifecycleJurisdiction } from './countryLifecycleContext.js';
// Named operation composition for country admission, separate from tax planning.
import { FI_POSTING_ADMISSION } from './finland/postingAdmission.js';
import { US_POSTING_ADMISSION } from './us/postingAdmission.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
export const POSTING_ADMISSION_REGISTRY = Object.freeze({ fi: FI_POSTING_ADMISSION, us: US_POSTING_ADMISSION });
export const resolvePostingAdmission = (row, registry = POSTING_ADMISSION_REGISTRY) => {
  const country = lifecycleJurisdiction(row);
  return country && Object.hasOwn(registry, country) ? registry[country] : null;
};
export const readPostingAdmissionWithClient = async ({ client, firmId, clientId }) => {
  // The named writer already holds its readiness fence. Preserve MVCC reads:
  // a profile update may own the row while its dependency trigger waits on that key.
  const row = (await client.query('select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId])).rows[0];
  return { row, policy: resolvePostingAdmission(row) };
};
// Historical country-named entry points remain explicitly bound operations.
// Their named writers still enforce current posting context before journal mutation.
export const requirePostingAdmission = (jurisdiction, registry = POSTING_ADMISSION_REGISTRY) => {
  const key = normalizeJurisdictionKey(jurisdiction);
  const policy = Object.hasOwn(registry, key) ? registry[key] : null;
  if (!policy) throw Object.assign(new Error('Country posting admission unavailable.'), { code: 'posting_admission_unavailable', statusCode: 409 });
  return policy;
};
