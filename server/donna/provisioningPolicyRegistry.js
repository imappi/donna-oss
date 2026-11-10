// Named provisioning composition: chart birth and certificate read the same
// owned contract; registration requirements use the operation's effective date.
import { GB_PROVISIONING_POLICY } from './gb/provisioningPolicy.js';
import { SG_PROVISIONING_POLICY } from './singapore/provisioningPolicy.js';
import { FI_PROVISIONING_POLICY } from './finland/provisioningPolicy.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
export const PROVISIONING_POLICY_REGISTRY = Object.freeze({ gb: GB_PROVISIONING_POLICY, sg: SG_PROVISIONING_POLICY, fi: FI_PROVISIONING_POLICY });
export const resolveProvisioningPolicy = (jurisdiction, registry = PROVISIONING_POLICY_REGISTRY) =>
  Object.hasOwn(registry, normalizeJurisdictionKey(jurisdiction)) ? registry[normalizeJurisdictionKey(jurisdiction)] : null;
// The bank and cash accounts a market's books post to (FI: tilikartta 1910 /
// 1900), or null for a market that declares none — its bank leg keeps the
// engine's default account (donnaLedgerWriteback.defaultDonnaBankAccount).
export const resolveMarketPostingAccounts = (jurisdiction, registry = PROVISIONING_POLICY_REGISTRY) =>
  resolveProvisioningPolicy(jurisdiction, registry)?.postingAccounts || null;
export const resolveProvisioningCertificateChart = (contract, registry = PROVISIONING_POLICY_REGISTRY) => {
  const matches = Object.values(registry).filter(policy => Object.hasOwn(policy.certificateCharts || {}, contract));
  if (matches.length > 1) throw new TypeError(`Ambiguous provisioning chart contract: ${contract}`);
  return matches[0]?.certificateCharts[contract] ?? null;
};

// Explicit version lookup, never a jurisdiction default or a fallback chart.
export const resolveProvisioningBirthContract = (contract, registry = PROVISIONING_POLICY_REGISTRY) => {
  const matches = Object.values(registry).filter(policy => Object.hasOwn(policy.birthContracts || {}, contract));
  if (matches.length > 1) throw new TypeError(`Ambiguous provisioning birth contract: ${contract}`);
  return matches[0]?.birthContracts[contract]() ?? null;
};
