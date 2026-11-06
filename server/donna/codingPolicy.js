import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { toIsoDay, toUtcIsoDay } from './dates.js';
import { CODING_POLICY_REGISTRY } from './codingPolicyRegistry.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
import { nativeAccountChoices, accountChoicePrompt, resolveNativeAccountChoice, nativeChoiceReceipt, codingChoiceFailure } from './codingAccountChoices.js';

export { CODING_POLICY_REGISTRY };
const FAILURE_CODES = new Set(['jurisdiction_unresolved', 'jurisdiction_unsupported',
  'coding_policy_unavailable', 'coding_policy_invalid', 'jurisdiction_context_conflict']);

export class CodingPolicyError extends Error {
  constructor(code, { jurisdiction = null, details = {} } = {}) {
    super(`Coding policy could not be resolved: ${code}`);
    this.name = 'CodingPolicyError';
    this.code = FAILURE_CODES.has(code) ? code : 'coding_policy_invalid';
    this.statusCode = 409;
    this.jurisdiction = jurisdiction;
    this.details = details;
  }
}
export const isCodingPolicyError = (error) => error instanceof CodingPolicyError
  || ['NATIVE_CHART_LINEAGE_INVALID', 'NATIVE_CODING_CHOICE_INVALID'].includes(error?.code);
const fail = (code, jurisdiction, reason) => { throw new CodingPolicyError(code, { jurisdiction, details: { reason } }); };
const normalizedDate = (value, jurisdiction) => {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isFinite(value.getTime())) fail('coding_policy_invalid', jurisdiction, 'business_date_invalid');
  const raw = value instanceof Date ? toIsoDay(value) : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw)) {
    fail('coding_policy_invalid', jurisdiction, 'business_date_invalid');
  }
  const text = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || toUtcIsoDay(text) !== text) {
    fail('coding_policy_invalid', jurisdiction, 'business_date_invalid');
  }
  return text;
};
const canonicalContext = (value) => {
  if (value == null) return null;
  if (['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalContext);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalContext(value[key])]));
  }
  throw new TypeError('Coding context must be JSON data');
};
const digestTaxProfile = (value, jurisdiction) => {
  try { return createHash('sha256').update(JSON.stringify(canonicalContext(value))).digest('hex'); }
  catch { fail('coding_policy_invalid', jurisdiction, 'tax_profile_invalid'); }
};
const validNames = (names) => Array.isArray(names) && names.length > 0
  && names.every((name) => typeof name === 'string' && name.trim() === name && name.length > 0)
  && new Set(names).size === names.length;

// The decision-guidance variants a call owner may select (FIK-2). null is the
// definition's authored guidance; 'reviewed' renders its reviewed entries in
// place of the clauses they cover. A definition without reviewed guidance
// resolves null whatever was asked, so its receipts never change.
export const CODING_GUIDANCE_VARIANTS = Object.freeze(['reviewed']);
// FIK-3's offline provisional arm. No call owner selects it: a definition's
// provisionalGuidanceFor answers only inside the harness scope (FI:
// finland/decisionGuidance.js), and there it is the only variant. Named here
// so a stamp carrying it re-resolves under the same scope, and refuses outside.
const PROVISIONAL_GUIDANCE_VARIANT = 'provisional';

// No clock, no flags, no fallback country. Dated definitions select against the
// operation's business date; a menu may resolve a timeless definition without one.
// The guidance variant is an input chosen by the call owner from its client
// config snapshot (codingGuidanceVariant.js); this resolver reads no flag.
export const resolveCodingPolicy = ({ jurisdiction, profileJurisdiction, entityType = null, profileEntityType = null,
  businessDate = null, taxProfile = null, accountingSystem = null, guidanceVariant = null, nativeChart = null } = {},
{ registry = CODING_POLICY_REGISTRY } = {}) => {
  const country = normalizeJurisdictionKey(jurisdiction);
  if (!country) fail('jurisdiction_unresolved', null, 'persisted_jurisdiction_missing');
  // An unsupported persisted country has no setup choices or executable policy.
  // Report the capability gap before classifying secondary profile conflicts.
  if (!Object.prototype.hasOwnProperty.call(registry, country)) fail('jurisdiction_unsupported', country, 'unregistered_jurisdiction');
  if (profileJurisdiction != null && profileJurisdiction !== ''
      && normalizeJurisdictionKey(profileJurisdiction) !== country) {
    fail('jurisdiction_context_conflict', country, 'profile_jurisdiction_conflict');
  }
  const taxProfileDigest = digestTaxProfile(taxProfile, country);
  const accounting = typeof accountingSystem === 'string' && accountingSystem.trim() ? accountingSystem.trim().toLowerCase() : null;
  const storedEntity = typeof entityType === 'string' && entityType.trim() ? entityType.trim().toLowerCase() : null;
  const profileEntity = typeof profileEntityType === 'string' && profileEntityType.trim() ? profileEntityType.trim().toLowerCase() : null;
  if (storedEntity && profileEntity && storedEntity !== profileEntity) fail('jurisdiction_context_conflict', country, 'profile_entity_conflict');
  const entity = storedEntity || profileEntity;
  if (entity && /^[a-z]{2}-/.test(entity) && normalizeJurisdictionKey(entity.slice(0, 2)) !== country) {
    fail('jurisdiction_context_conflict', country, 'entity_jurisdiction_conflict');
  }
  const date = normalizedDate(businessDate, country);
  if (guidanceVariant != null && guidanceVariant !== PROVISIONAL_GUIDANCE_VARIANT && !CODING_GUIDANCE_VARIANTS.includes(guidanceVariant)) {
    fail('coding_policy_invalid', country, 'guidance_variant_invalid');
  }
  let selectedVariant = null;
  let definition;
  let palette;
  let ownerTransactionPolicy;
  let guidance = null;
  let effectiveFrom = null;
  let effectiveTo = null;
  try {
    const registered = registry[country];
    const nativeMenu = nativeAccountChoices(nativeChart, { businessDate: date });
    if (nativeMenu && (country !== 'sg' || entity !== 'sg-pte' || accounting !== 'none')) {
      fail('coding_policy_invalid', country, 'native_identity_conflict');
    }
    definition = typeof registered === 'function' ? registered({ businessDate: date, entityType: entity, taxProfile, accountingSystem, nativeMenu }) : registered;
    if (!definition) fail('coding_policy_unavailable', country, 'definition_unavailable');
    if (definition.effectiveFrom || definition.effectiveTo) {
      const from = normalizedDate(definition.effectiveFrom, country);
      const to = normalizedDate(definition.effectiveTo, country);
      effectiveFrom = from;
      effectiveTo = to;
      if (from && to && from > to) fail('coding_policy_invalid', country, 'policy_interval_invalid');
      if (!date) fail('coding_policy_invalid', country, 'business_date_required');
      if ((from && date < from) || (to && date > to)) {
        fail('coding_policy_unavailable', country, 'business_date_outside_policy_interval');
      }
    }
    palette = definition.loadAccountPalette ? definition.loadAccountPalette({ entityType: entity, businessDate: date, taxProfile }) : definition;
    ownerTransactionPolicy = definition.ownerPolicyFor?.({ entityType: entity, businessDate: date, taxProfile }) || null;
    const provisional = typeof definition.provisionalGuidanceFor === 'function'
      ? definition.provisionalGuidanceFor({ entityType: entity, businessDate: date }) : null;
    if (provisional) {
      // Inside the harness scope a reviewed selection is a configuration error.
      if (guidanceVariant === 'reviewed' || provisional.guidanceVariant !== PROVISIONAL_GUIDANCE_VARIANT) {
        fail('coding_policy_invalid', country, 'guidance_variant_conflict');
      }
      guidance = provisional;
      selectedVariant = PROVISIONAL_GUIDANCE_VARIANT;
    } else if (guidanceVariant === PROVISIONAL_GUIDANCE_VARIANT) {
      // A provisional stamp outside the harness scope never resolves.
      fail('coding_policy_invalid', country, 'provisional_guidance_out_of_scope');
    } else if (guidanceVariant === 'reviewed' && typeof definition.reviewedGuidanceFor === 'function') {
      guidance = definition.reviewedGuidanceFor({ entityType: entity, businessDate: date });
      selectedVariant = guidanceVariant;
    }
  } catch (error) {
    if (isCodingPolicyError(error)) throw error;
    fail('coding_policy_unavailable', country, 'definition_load_failed');
  }
  if (definition.jurisdiction !== country || typeof definition.id !== 'string' || !definition.id
      || !Number.isInteger(definition.version) || definition.version < 1
      || !validNames(definition.taxTreatmentOptions) || !validNames(palette?.accountOptions)
      || !palette.accountOptions.includes(palette.suspenseAccountName)
      || !definition.taxTreatmentOptions.includes(definition.defaultTaxTreatment)
      || !definition.taxTreatmentOptions.includes(definition.outOfScopeTaxTreatment)
      || (definition.uncertainTaxTreatment && !definition.taxTreatmentOptions.includes(definition.uncertainTaxTreatment))
      || typeof definition.taxInstructions !== 'string' || !definition.taxInstructions.trim()
      || (definition.requiredAccountNames && !validNames(definition.requiredAccountNames))) {
    fail('coding_policy_invalid', country, 'definition_contract_invalid');
  }
  if (guidance && (typeof guidance.taxInstructions !== 'string' || !guidance.taxInstructions.trim()
      || !/^[0-9a-f]{64}$/.test(guidance.guidanceDigest || ''))) {
    fail('coding_policy_invalid', country, 'guidance_contract_invalid');
  }
  if (ownerTransactionPolicy && (!validNames(ownerTransactionPolicy.types)
      || typeof ownerTransactionPolicy.classify !== 'function' || typeof ownerTransactionPolicy.instructions !== 'string')) {
    fail('coding_policy_invalid', country, 'owner_policy_contract_invalid');
  }
  return Object.freeze({
    status: 'resolved', jurisdiction: country, policyId: definition.id, policyVersion: definition.version,
    effectiveFrom, effectiveTo,
    guidanceVariant: guidance ? selectedVariant : null, guidanceDigest: guidance ? guidance.guidanceDigest : null,
    businessDate: date, entityType: entity, taxProfile, taxProfileDigest, accountingSystem: accounting,
    ownerTransactionPolicy,
    ...(definition.nativeMenu ? { nativeMenu: definition.nativeMenu } : {}),
    // Optional evidence extraction belongs to the registered country owner,
    // never to a caller-supplied policy stamp or accounting authority receipt.
    ...(typeof definition.bankLineContextFor === 'function'
      ? { bankLineContextFor: definition.bankLineContextFor } : {}),
    excludedAccountNames: Object.freeze([...(palette.excludedAccountNames || [])]),
    accountOptions: Object.freeze([...palette.accountOptions]), suspenseAccountName: palette.suspenseAccountName,
    requiredAccountNames: Object.freeze([...(definition.requiredAccountNames || [])]),
    taxTreatmentOptions: Object.freeze([...definition.taxTreatmentOptions]),
    uncertainTaxTreatment: definition.uncertainTaxTreatment || definition.defaultTaxTreatment,
    historicalTaxTreatmentsFor: typeof definition.historicalTaxTreatmentsFor === 'function' ? definition.historicalTaxTreatmentsFor : () => [],
    taxRatesInForceFor: typeof definition.taxRatesInForceFor === 'function' ? definition.taxRatesInForceFor : () => null,
    defaultTaxTreatment: definition.defaultTaxTreatment, outOfScopeTaxTreatment: definition.outOfScopeTaxTreatment,
    taxInstructions: `${guidance ? guidance.taxInstructions : definition.taxInstructions}\nTax registration is not implied by jurisdiction. Use the supplied client tax profile and evidence; if registration or treatment cannot be established, use the policy's uncertainty treatment instead of assuming registration.`,
  });
};

// The guidance keys are present ONLY when a reviewed variant was selected, so
// every receipt minted without one (every stored receipt, every market) keeps
// its exact bytes and still matches. The comparison always includes them: a
// v8 receipt never passes against v7, nor a v7 receipt against v8.
const GUIDANCE_RECEIPT_KEYS = Object.freeze(['guidanceVariant', 'guidanceDigest']);
export const codingPolicyReceipt = (policy) => Object.freeze({
  policyId: policy.policyId, policyVersion: policy.policyVersion, jurisdiction: policy.jurisdiction,
  businessDate: policy.businessDate, effectiveFrom: policy.effectiveFrom, effectiveTo: policy.effectiveTo,
  entityType: policy.entityType, accountingSystem: policy.accountingSystem, taxProfileDigest: policy.taxProfileDigest,
  ...(policy.nativeMenu ? { native_chart: policy.nativeMenu.context, native_menu_digest: policy.nativeMenu.digest,
    native_registration: policy.nativeMenu.registrationEligibility } : {}),
  ...(policy.guidanceDigest ? { guidanceVariant: policy.guidanceVariant, guidanceDigest: policy.guidanceDigest } : {})
});
export const assertCodingPolicyReceipt = (policy, receipt) => {
  const current = codingPolicyReceipt(policy);
  const keys = [...new Set([...Object.keys(current), ...GUIDANCE_RECEIPT_KEYS, 'native_chart', 'native_menu_digest', 'native_registration'])];
  if (!receipt || keys.some((key) => !isDeepStrictEqual(receipt[key] ?? null, current[key] ?? null))) {
    fail('jurisdiction_context_conflict', policy.jurisdiction, 'coding_policy_receipt_conflict');
  }
  return policy;
};

// A stamped policy is a context/lineage assertion, never executable input. Resolve
// the registered implementation again, rejecting stale or conflicting assertions.
// The stamp carries the guidance variant its call owner selected from config;
// re-resolving under it keeps every downstream prompt on the stamped variant.
export const requireCodingPolicyForClient = (profile = {}, { businessDate } = {}) => {
  const stamp = profile.codingPolicy;
  const policy = resolveCodingPolicy({ guidanceVariant: stamp?.guidanceVariant ?? null, jurisdiction: profile.jurisdiction,
    profileJurisdiction: profile.profileJurisdiction ?? profile.profile?.jurisdiction,
    entityType: profile.entityType ?? profile.entity_type,
    profileEntityType: profile.profileEntityType ?? profile.profile?.entity_type ?? profile.profile?.entityType,
    businessDate: businessDate === undefined ? profile.codingPolicy?.businessDate : businessDate,
    taxProfile: profile.taxProfile ?? profile.tax_profile,
    accountingSystem: profile.accountingSystem ?? profile.accounting_system,
    nativeChart: stamp?.nativeMenu?.context ?? stamp?.native_chart ?? null });
  if (stamp) {
    if ((stamp.native_menu_digest ?? stamp.nativeMenu?.digest ?? null) !== (policy.nativeMenu?.digest ?? null)
        || stamp.policyId !== policy.policyId || stamp.policyVersion !== policy.policyVersion
        || stamp.jurisdiction !== policy.jurisdiction || stamp.entityType !== policy.entityType
        || stamp.accountingSystem !== policy.accountingSystem || stamp.taxProfileDigest !== policy.taxProfileDigest
        || (stamp.guidanceVariant ?? null) !== policy.guidanceVariant
        // Reviewed content is dated, so its digest is comparable only on the same day.
        || ((stamp.businessDate || !policy.businessDate) && (stamp.guidanceDigest ?? null) !== policy.guidanceDigest)
        || (stamp.businessDate && stamp.businessDate !== policy.businessDate)) {
      fail('jurisdiction_context_conflict', policy.jurisdiction, 'stamped_policy_context_conflict');
    }
  }
  return policy;
};

// Diagnostic context can be built without an entity, but never acquires a tax
// vocabulary. A supplied entity or explicit override must satisfy the same policy
// contract as the coder. Overrides cannot hide uncertainty or introduce foreign tax.
export const codingPolicyChatContext = (profile, { businessDate, taxTreatmentOptions } = {}) => {
  if (!profile) {
    if (taxTreatmentOptions !== undefined && taxTreatmentOptions !== null && taxTreatmentOptions.length) {
      fail('jurisdiction_unresolved', null, 'tax_menu_requires_jurisdiction');
    }
    return null;
  }
  const policy = requireCodingPolicyForClient(profile, { businessDate });
  if (taxTreatmentOptions !== undefined && JSON.stringify(taxTreatmentOptions) !== JSON.stringify(policy.taxTreatmentOptions)) {
    fail('jurisdiction_context_conflict', policy.jurisdiction, 'tax_menu_policy_conflict');
  }
  return {
    ...codingPolicyReceipt(policy),
    ...(policy.nativeMenu ? { account_choices: accountChoicePrompt(policy.nativeMenu), unavailable_actions: ['mark_personal', 'remember_merchant'] } : {}),
    tax_treatment_options: policy.taxTreatmentOptions,
    tax_instructions: policy.taxInstructions,
    tax_uncertainty_treatment: policy.uncertainTaxTreatment,
    tax_out_of_scope_treatment: policy.outOfScopeTaxTreatment,
    owner_transaction_policy: policy.ownerTransactionPolicy ? {
      axis: policy.ownerTransactionPolicy.axis, types: policy.ownerTransactionPolicy.types,
      instructions: policy.ownerTransactionPolicy.instructions
    } : null
  };
};

export const codingPolicyReceiptForChatTransaction = (context, transaction) => {
  if (!context?.coding_policy || !context?.client || !transaction) {
    fail('jurisdiction_context_conflict', context?.coding_policy?.jurisdiction || null, 'coding_policy_context_missing');
  }
  const policy = requireCodingPolicyForClient({ ...context.client, codingPolicy: context.coding_policy }, {
    businessDate: transaction.date ?? transaction.transaction_date ?? null
  });
  return codingPolicyReceipt(policy);
};

// Run after schema validation. Only server-captured menus/source receipts are
// eligible; a provider cannot contribute these authority fields itself.
export const nativeCodingChatAction = (action, context, transactionIds) => {
  const menu = nativeAccountChoices(context?.coding_policy?.native_chart);
  if (!menu) return action;
  if (!['apply_category', 'recode_decided'].includes(action.type)) codingChoiceFailure('chat_action_not_supported');
  if (!transactionIds.length) codingChoiceFailure('chat_source_receipt_missing');
  const choice = resolveNativeAccountChoice(menu, { handle: action.account_name,
    ...(action.account_code ? { account_code: action.account_code } : {}) });
  const sources = Object.fromEntries(transactionIds.map(id => {
    const receipt = context.native_coding_sources?.[id];
    if (!receipt || receipt.transaction_id !== id || receipt.client_id !== menu.context.client_life.client_id
      || receipt.firm_id !== menu.context.client_life.firm_id) codingChoiceFailure('chat_source_receipt_missing');
    return [id, receipt];
  }));
  return { ...action, account_name: choice.name, account_code: choice.code, account_id: choice.id,
    native_choice: nativeChoiceReceipt(menu, choice), native_source_by_transaction: sources };
};
