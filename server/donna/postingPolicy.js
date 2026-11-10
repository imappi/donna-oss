import { POSTING_POLICY_REGISTRY } from './postingPolicyRegistry.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';

export { POSTING_POLICY_REGISTRY };
export const POSTING_POLICY_OPERATIONS = Object.freeze([
  'prepareLedgerAccounts', 'enrichCoding', 'transactionSplit', 'salesInvoiceTaxPosting', 'supplierBillTaxPosting',
  'planArSettlement', 'arSettlementReceivableCoding',
  // RT-23 (2026-09-09): the Keep-layer invariant on the bank-line post path —
  // a P&L leg for a tax-coding client whose treatment did not resolve to a
  // code REFUSES (a typed 409), never posts uncoded. The AP twin
  // (supplierBillTaxPosting) already refused; the Kampaamo February book
  // posted four Nets sales legs with tax_type null under the coder's own
  // unsure marker ('ALV-tarkistus') — roughly 2 100 EUR of output ALV the
  // return would never see. Runs after enrichCoding on the same coding.
  'assertPostableTaxCoding', 'sourceTaxPosting'
]);

export class PostingPolicyError extends Error {
  constructor(code, { jurisdiction = null, details = {} } = {}) {
    super(`Posting policy could not be applied: ${code}`);
    this.name = 'PostingPolicyError';
    this.code = code;
    this.statusCode = 409;
    this.jurisdiction = jurisdiction;
    this.details = details;
  }
}
const refuse = (code, jurisdiction, reason, details = {}) => {
  throw new PostingPolicyError(code, { jurisdiction, details: { reason, ...details } });
};
const nonemptyString = (value) => typeof value === 'string' && value.trim() === value && value.length > 0;
// Optional country-owned source-evidence rule (taxSourceEvidence.js runs it).
const validTaxEvidence = (rule) => Boolean(rule) && typeof rule === 'object' && nonemptyString(rule.refusalCode)
  && typeof rule.inputRuleCoversAcceptedCoding === 'boolean'
  && ['resolveEntry', 'deductibleInput', 'taxedOutput'].every((key) => typeof rule[key] === 'function');
const stringList = (value) => Array.isArray(value) && value.every(nonemptyString) && new Set(value).size === value.length;
// Optional country-owned tax-registration declaration: the bank-line refusal
// codes its posting policy raises when the business is not recorded as
// registered on the line's date, the tri-state reader of its one registration
// record, and the owner question that asks for that fact (transactionLlm.js
// turns a refused line into that question). Nothing here knows a country.
// The owner's answer is recorded through the same declaration
// (taxRegistrationReply.js): the profile key of the one record, the country's
// own normaliser behind recordFromAnswer, the profile-writer refusal codes
// that mean "this recorded fact is locked" (recordLockedCodes, may be empty),
// and the owner-facing wording of the follow-up (answerQuestion) and of the
// one-line notice of what was recorded (recordedNotice).
// On a date the record says the business is not registered, the country's
// no-VAT treatment (withoutTax): the coder treatment for a purchase and for a
// sale that posts with no VAT leg and no deduction, the coder-facing sentence
// that states the fact (instruction), and the recogniser of a treatment that
// the posting policy refuses for an unregistered business (needsRegistration). The coder's
// contract (transactionLlm.js) tells the coder; the posting policy decides.
const validWithoutTax = (rule) => Boolean(rule) && typeof rule === 'object' && Boolean(rule.treatments)
  && nonemptyString(rule.treatments.purchase) && nonemptyString(rule.treatments.sale)
  && ['instruction', 'needsRegistration'].every((key) => typeof rule[key] === 'function');
const validTaxRegistration = (rule) => Boolean(rule) && typeof rule === 'object' && stringList(rule.refusalCodes)
  && nonemptyString(rule.profileField) && stringList(rule.recordLockedCodes) && validWithoutTax(rule.withoutTax)
  && ['onDate', 'ownerQuestion', 'recordFromAnswer', 'answerQuestion', 'recordedNotice'].every((key) => typeof rule[key] === 'function');

// The country's no-VAT treatment labels (withoutTax.treatments), for the
// policy-vocabulary checks: a coder may propose one only on a line whose
// registration fact says not registered (transactionLlm.js admits it there),
// so it is a valid label of that country although the standing vocabulary
// does not list it. Whether it may post on the line's date is the posting
// policy's decision. [] for a country without a registration declaration.
export const withoutTaxTreatmentsFor = (jurisdiction) => {
  try {
    const treatments = resolvePostingPolicy({ jurisdiction }).taxRegistration?.withoutTax?.treatments;
    return treatments ? [...new Set([treatments.purchase, treatments.sale])] : [];
  } catch { return []; }
};

// Validate the selected declaration and its exact explicit capabilities. A malformed
// handler never becomes an implicit no-op, and unsupported is different from missing.
const validateDefinition = (definition, country) => {
  if (!definition) refuse('posting_policy_unavailable', country, 'definition_unavailable');
  if (definition.jurisdiction !== country || !nonemptyString(definition.policyId)
      || !Number.isInteger(definition.policyVersion) || definition.policyVersion < 1
      || !stringList(definition.nativeTaxCodePrefixes) || !stringList(definition.nativeTaxCodes)
      || !stringList(definition.salesInvoiceChannels)
      || !(definition.postingTaxCodingFlagKey === null || nonemptyString(definition.postingTaxCodingFlagKey))
      || !(definition.supplierBillAdmissionFlagKey === null || nonemptyString(definition.supplierBillAdmissionFlagKey))
      || !(definition.arSettlementFlagKey === null || nonemptyString(definition.arSettlementFlagKey))
      || typeof definition.supplierBillNeedsChart !== 'boolean'
      || !(definition.salesTaxControlRole === null || nonemptyString(definition.salesTaxControlRole))
      || (Object.hasOwn(definition, 'taxFactAutomation') && typeof definition.taxFactAutomation !== 'function')
      || (Object.hasOwn(definition, 'taxEvidence') && !validTaxEvidence(definition.taxEvidence))
      || (Object.hasOwn(definition, 'taxRegistration') && !validTaxRegistration(definition.taxRegistration))
      || !definition.capabilities || typeof definition.capabilities !== 'object'
      || Object.keys(definition.capabilities).some((key) => !POSTING_POLICY_OPERATIONS.includes(key))) {
    refuse('posting_policy_invalid', country, 'definition_invalid');
  }
  for (const operation of POSTING_POLICY_OPERATIONS) {
    const supported = definition.capabilities[operation];
    if (typeof supported !== 'boolean' || (supported && typeof definition[operation] !== 'function')
        || (!supported && definition[operation] != null)) {
      refuse('posting_policy_invalid', country, 'operation_declaration_invalid', { operation });
    }
  }
  return definition;
};

// Native code ownership is data on the same registered adapter. Neither the first
// recognizable tax code nor a legacy enrichment flag may select the country.
export const assertPostingCoding = (policy, coding = {}) => {
  if (policy?.status !== 'resolved') refuse('posting_policy_invalid', null, 'resolved_policy_required');
  for (const field of ['tax_type', 'xero_tax_type']) {
    const code = String(coding?.[field] || '').trim().toUpperCase();
    if (!code) continue;
    const owners = policy.nativeTaxCodeOwnership.filter(({ prefixes, codes }) =>
      prefixes.some((prefix) => code.startsWith(prefix)) || codes.includes(code));
    if (owners.some(({ jurisdiction }) => jurisdiction !== policy.jurisdiction)) {
      refuse('posting_tax_code_foreign', policy.jurisdiction, 'foreign_native_tax_code', { field, code });
    }
    if (owners.length && !owners.some(({ codes }) => codes.includes(code))) {
      refuse('posting_tax_code_invalid', policy.jurisdiction, 'unknown_native_tax_code', { field, code });
    }
  }
  return coding;
};

export const resolvePostingPolicy = ({ jurisdiction, codingPolicy = null, registry = POSTING_POLICY_REGISTRY } = {}) => {
  const country = normalizeJurisdictionKey(jurisdiction ?? codingPolicy?.jurisdiction);
  if (!country) refuse('jurisdiction_unresolved', null, 'persisted_jurisdiction_missing');
  if (codingPolicy && (codingPolicy.status !== 'resolved' || normalizeJurisdictionKey(codingPolicy.jurisdiction) !== country)) {
    refuse('jurisdiction_context_conflict', country, 'coding_policy_jurisdiction_conflict');
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    refuse('posting_policy_invalid', country, 'registry_invalid');
  }
  if (!Object.prototype.hasOwnProperty.call(registry, country)) refuse('jurisdiction_unsupported', country, 'posting_country_unregistered');
  const definition = validateDefinition(registry[country], country);
  const nativeTaxCodeOwnership = Object.freeze(Object.entries(registry).map(([key, entry]) => {
    // Ownership declarations must remain trustworthy even for a peer country;
    // malformed peers cannot erase the foreign-code guard.
    if (!entry || !stringList(entry.nativeTaxCodePrefixes) || !stringList(entry.nativeTaxCodes)) {
      refuse('posting_policy_invalid', country, 'tax_code_ownership_invalid', { registeredJurisdiction: key });
    }
    return Object.freeze({ jurisdiction: key, prefixes: Object.freeze([...entry.nativeTaxCodePrefixes]), codes: Object.freeze([...entry.nativeTaxCodes]) });
  }));
  const policy = { status: 'resolved', jurisdiction: country, policyId: definition.policyId,
    policyVersion: definition.policyVersion, capabilities: Object.freeze({ ...definition.capabilities }),
    postingTaxCodingFlagKey: definition.postingTaxCodingFlagKey,
    supplierBillAdmissionFlagKey: definition.supplierBillAdmissionFlagKey, supplierBillNeedsChart: definition.supplierBillNeedsChart,
    arSettlementFlagKey: definition.arSettlementFlagKey,
    salesInvoiceChannels: Object.freeze([...definition.salesInvoiceChannels]), salesTaxControlRole: definition.salesTaxControlRole,
    taxEvidence: definition.taxEvidence || null,
    taxRegistration: definition.taxRegistration || null,
    nativeTaxCodeOwnership };
  policy.adapter = Object.freeze(Object.fromEntries(POSTING_POLICY_OPERATIONS.map((operation) => [operation, (input = {}) => {
    if (!policy.capabilities[operation]) refuse('posting_operation_unsupported', country, 'operation_not_supported', { operation });
    if (['enrichCoding', 'transactionSplit', 'supplierBillTaxPosting', 'assertPostableTaxCoding'].includes(operation)) {
      assertPostingCoding(policy, input.coding || input.verdict || {});
      if (input.sourceCoding) assertPostingCoding(policy, input.sourceCoding);
    }
    const result = definition[operation](input);
    if (operation === 'enrichCoding') assertPostingCoding(policy, result);
    return result;
  }])));
  return Object.freeze(policy);
};

export const executePostingPolicyOperation = (policy, operation, input = {}) => {
  if (policy?.status !== 'resolved' || !POSTING_POLICY_OPERATIONS.includes(operation)) {
    refuse('posting_policy_invalid', policy?.jurisdiction || null, 'operation_invalid', { operation });
  }
  return policy.adapter[operation](input);
};


// Optional country-owned source reasoning contract. Unsupported countries have
// no handler; registration cannot infer this authority from tax coding support.
export const loadPostingTaxFactAutomation = async ({ jurisdiction, registry = POSTING_POLICY_REGISTRY } = {}) => {
  const country = normalizeJurisdictionKey(jurisdiction);
  const definition = country && registry?.[country];
  if (!definition) return null;
  validateDefinition(definition, country);
  if (!definition.taxFactAutomation) return null;
  const handler = await definition.taxFactAutomation();
  if (!handler || !['actorId','authorityBasis','evidenceType'].every(key => nonemptyString(handler[key]))
    || !['enabled','clientEnabled','legacyNeedsRecovery','readContext','reason','error','assertActor','validateAnswer','validatePostingFacts']
      .every(key => typeof handler[key] === 'function')) refuse('posting_policy_invalid', country, 'tax_fact_automation_invalid');
  return handler;
};
