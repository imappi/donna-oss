import { lifecycleJurisdiction } from './countryLifecycleContext.js';
// Named close operation composition. Capabilities are independent of coding,
// outbound and rollout flags; a foreign flag never opts a client into a country's law.
import { FI_CLOSE_POLICY } from './finland/closePolicy.js';
import { GB_CLOSE_POLICY } from './gb/closePolicy.js';
import { SG_CLOSE_POLICY } from './singapore/closePolicy.js';
import { AE_CLOSE_POLICY } from './ae/closePolicy.js';
import { US_CLOSE_POLICY } from './us/closePolicy.js';
import { AU_CLOSE_POLICY } from './au/closePolicy.js';
export const CLOSE_POLICY_REGISTRY = Object.freeze({ fi: FI_CLOSE_POLICY, gb: GB_CLOSE_POLICY, sg: SG_CLOSE_POLICY, ae: AE_CLOSE_POLICY, us: US_CLOSE_POLICY, au: AU_CLOSE_POLICY });
export const resolveClosePolicy = (row, registry = CLOSE_POLICY_REGISTRY) => {
  const country = lifecycleJurisdiction(row);
  return country && Object.hasOwn(registry, country) ? registry[country] : null;
};
export const readClosePolicyWithClient = async ({ client, firmId, clientId }) => {
  // Preserve the existing reader's MVCC semantics. A row lock here can invert
  // the named writer's readiness key against a concurrent dependency trigger.
  const row = (await client.query('select jurisdiction, entity_type, incorporation_date, profile from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId])).rows[0];
  return { row, policy: resolveClosePolicy(row) };
};

// A retained archive selects its original country's retention operation from
// its persisted commitment, independently of today's repaired identity.
export const retainedArchivePolicies = (retentions, registry = CLOSE_POLICY_REGISTRY) =>
  Object.values(registry).filter(policy => typeof policy.recognizesRetainedArchive === 'function')
    .map(policy => ({ policy, starts: retentions.filter(r => policy.recognizesRetainedArchive(r)).map(r => r.fiscal_year.starts_on) }))
    .filter(({ starts }) => starts.length);
export const hasActingRetentionPolicy = (snapshot, registry = CLOSE_POLICY_REGISTRY) =>
  Object.values(registry).some(policy => policy.retentionActs?.({ snapshot }));
