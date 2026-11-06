// Operation registration is distinct from country identity and from authority to
// act. Coding registrations live in CODING_POLICY_REGISTRY; an outbound pack is
// explicitly registered by packs/<cc>/capabilities.json. Neither implies the other.
// The sidecar owns only { outbound: { manifest: 'manifest.json' } }; absence means
// no outbound capability. Existing versioned manifest/evidence bytes stay intact.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OWNER_EXPENSE_REGISTRY } from './ownerExpenseRegistry.js';
import { CODING_POLICY_REGISTRY } from './codingPolicyRegistry.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';

export const COUNTRY_PACKS_ROOT = fileURLToPath(new URL('../../packs/', import.meta.url));
const OPERATIONS = new Set(['coding', 'outbound', 'owner_expense']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class CountryCapabilityError extends Error {
  constructor(code, { operation, jurisdiction = null, reason } = {}) {
    super(`Country capability '${operation}' for '${jurisdiction || 'unresolved'}': ${reason || code}`);
    this.name = 'CountryCapabilityError';
    this.code = code;
    this.operation = operation;
    this.jurisdiction = jurisdiction;
    this.reason = reason || code;
  }
}
const refuse = (code, operation, jurisdiction, reason) => {
  throw new CountryCapabilityError(code, { operation, jurisdiction, reason });
};
const assertOperation = (operation) => {
  if (!OPERATIONS.has(operation)) refuse('country_operation_invalid', operation, null, 'unknown_operation');
};

// Missing registration is an ordinary absent capability; unreadable or malformed
// declared registration is a system error. Read only this country's directory so
// a broken peer cannot prevent a healthy country's operation.
const outboundRegistration = (jurisdiction, packsRoot) => {
  const declarationPath = path.join(packsRoot, jurisdiction, 'capabilities.json');
  let declaration;
  try {
    declaration = JSON.parse(readFileSync(declarationPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    refuse(error instanceof SyntaxError ? 'country_capability_invalid' : 'country_capability_unavailable',
      'outbound', jurisdiction, `capability_declaration_unreadable: ${error.message}`);
  }
  if (!object(declaration) || Object.keys(declaration).some((key) => key !== 'outbound')) {
    refuse('country_capability_invalid', 'outbound', jurisdiction, 'capability_declaration_invalid');
  }
  if (!own(declaration, 'outbound')) return null;
  const outbound = declaration.outbound;
  if (!object(outbound) || Object.keys(outbound).length !== 1 || outbound.manifest !== 'manifest.json') {
    refuse('country_capability_invalid', 'outbound', jurisdiction, 'outbound_manifest_registration_invalid');
  }
  return Object.freeze({ operation: 'outbound', jurisdiction, manifestPath: path.join(packsRoot, jurisdiction, outbound.manifest) });
};

// Resolves registration, never accounting policy or permission to send. Coding
// still resolves effective dates, entity/tax context and lineage through the
// existing resolveCodingPolicy boundary. No country or operation default.
export const resolveCountryCapability = ({ jurisdiction, operation } = {},
  { packsRoot = COUNTRY_PACKS_ROOT, codingRegistry = CODING_POLICY_REGISTRY, expenseRegistry = OWNER_EXPENSE_REGISTRY } = {}) => {
  assertOperation(operation);
  const country = normalizeJurisdictionKey(jurisdiction);
  if (!country || !/^[a-z]{2}$/.test(country)) return null;
  if (operation === 'outbound') return outboundRegistration(country, packsRoot);
  if (operation === 'owner_expense') {
    if (!own(expenseRegistry, country)) return null;
    const implementation = expenseRegistry[country];
    if (!object(implementation) || !Object.keys(implementation).length || Object.values(implementation).some((fn) => typeof fn !== 'function')) {
      refuse('country_capability_invalid', operation, country, 'expense_registration_invalid');
    }
    return Object.freeze({ operation, jurisdiction: country, implementation });
  }
  if (!own(codingRegistry, country)) return null;
  const implementation = codingRegistry[country];
  if (typeof implementation !== 'function' && (!object(implementation) || implementation.jurisdiction !== country)) {
    refuse('country_capability_invalid', operation, country, 'coding_registration_invalid');
  }
  return Object.freeze({ operation, jurisdiction: country, implementation });
};

// Discovery carries failures alongside registrations so a sweep can report each
// broken country and continue its healthy peers. Ordinary list consumers refuse
// errors rather than silently shrinking the available-country inventory.
export const discoverCountryCapabilities = (operation,
  { packsRoot = COUNTRY_PACKS_ROOT, codingRegistry = CODING_POLICY_REGISTRY, expenseRegistry = OWNER_EXPENSE_REGISTRY } = {}) => {
  assertOperation(operation);
  const registrations = [];
  const unavailable = [];
  let countries;
  try {
    countries = operation === 'owner_expense' ? Object.keys(expenseRegistry) : operation === 'coding' ? Object.keys(codingRegistry) : readdirSync(packsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z]{2}$/.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    unavailable.push(new CountryCapabilityError('country_capability_unavailable', {
      operation, reason: `capability_inventory_unreadable: ${error.message}`
    }));
    return { registrations, unavailable };
  }
  for (const jurisdiction of countries.sort()) {
    try {
      const entry = resolveCountryCapability({ jurisdiction, operation }, { packsRoot, codingRegistry, expenseRegistry });
      if (entry) registrations.push(entry);
    } catch (error) {
      unavailable.push(error);
    }
  }
  return { registrations, unavailable };
};
