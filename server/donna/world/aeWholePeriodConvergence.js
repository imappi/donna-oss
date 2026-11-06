import { createHash } from 'node:crypto';

import { deriveSiblingWorld } from './siblingWorld.js';
import { validateCausalWorld } from './worldValidity.js';
import { validateWorldSpec } from './worldSchema.js';

export const AE_WHOLE_PERIOD_CONVERGENCE_VERSION = 'ae.whole-period-convergence.v1';
export const AE_WHOLE_PERIOD_WORLD_PATH = 'data/worlds/ae/ae-whole-period-convergence.json';

const REQUIRED_FAMILIES = Object.freeze([
  'ae_entity_tax_context',
  'ae_vat_period',
  'ae_corporate_tax',
  'ae_payroll_operating',
  'ae_cash_commerce',
  'ae_arabic_pint_evidence',
]);
const REQUIRED_ARRIVAL_ORDERS = Object.freeze([
  'document_first',
  'bank_first',
  'posting_first',
  'late_document',
]);
const REQUIRED_CRASH_BOUNDARIES = Object.freeze([
  'post:before',
  'post:inside',
  'lock:before',
  'lock:inside',
  'archive:before',
  'archive:inside',
  'export:before',
  'export:inside',
  'retire:before',
  'retire:inside',
]);
const REQUIRED_IDENTITIES = Object.freeze(['cross_entity', 'same_name', 'derived_id', 'long_id']);
const EXPECTED_MUTATIONS = Object.freeze({
  free_zone_designated_qfzp_conflation: 'AE_DESIGNATED_ZONE_CONFLATED_WITH_STANDING',
  vat_ct_threshold_collision: 'AE_THRESHOLD_BOUNDARY_ON_PROFILE_FORBIDDEN',
  natural_person_sbr_qfzp_collision: 'AE_PROFILE_PERIOD_OUTCOME_FORBIDDEN',
  qfzp_breach_horizon_truncated: 'AE_CT_BREACH_HORIZON_INCOMPLETE',
  vat_fx_evidence_missing_or_wrong_date: 'AE_VAT_FX_RATE_EVIDENCE_REQUIRED',
  customs_imported_service_lane_swap: 'AE_VAT_IMPORT_LANE_MISMATCH',
  blocked_input_vat_recovered: 'AE_VAT_APPORTIONMENT_RATE_MISMATCH',
  unsupported_entertainment_deductibility: 'AE_VAT_JOURNAL_MISMATCH',
  eosb_gcc_pension_swap: 'AE_EXPAT_EOSB_GCC_PENSION_SWAPPED',
  pdf_lookalike_promoted_to_pint: 'AE_PINT_LOOKALIKE_PROMOTED',
  arabic_digit_economics_drift: 'AE_PINT_DIGIT_SYSTEM_ALTERS_ECONOMICS',
  arabic_bidi_identifier_drift: 'AE_PINT_BIDI_CONTROL_ALTERS_IDENTIFIER',
  arabic_page_order_reversed: 'AE_PINT_PAGE_ORDER_REVERSED',
  arrival_order_divergence: 'AE7_ARRIVAL_ORDER_DIVERGENCE',
  held_evidence_upload_requested: 'AE_EVIDENCE_ALREADY_HELD_UPLOAD_REQUEST',
  cross_entity_identity_leak: 'AE_CROSS_ENTITY_LINK',
  same_name_identity_leak: 'AE_CROSS_ENTITY_LINK',
  derived_id_identity_leak: 'AE_CROSS_ENTITY_LINK',
  long_id_identity_leak: 'AE_CROSS_ENTITY_LINK',
});
const TERMINAL_STATES = new Set(['auto_reconciled', 'on_owner']);
const WORLD_PATH = /^data\/worlds\/ae\/[a-z0-9-]+\.json$/;

export function validateAeWholePeriodConvergenceWorld(world) {
  const errors = [];
  const shape = validateWorldSpec(world);
  if (!shape.ok) {
    for (const message of shape.errors) add(errors, 'AE7_WORLD_SCHEMA_INVALID', 'worldSpec', message);
    return result(errors);
  }
  const causal = validateCausalWorld(world);
  if (!causal.ok) {
    for (const message of causal.errors) add(errors, 'AE7_CAUSAL_WORLD_INVALID', 'worldSpec', message);
  }
  if (world.manifest.jurisdiction !== 'AE') {
    add(errors, 'AE7_JURISDICTION_REQUIRED', 'manifest.jurisdiction', 'AE-7 requires jurisdiction AE.');
  }
  if (world.manifest.capabilityId !== 'certify_ae_whole_period_convergence') {
    add(errors, 'AE7_CAPABILITY_REQUIRED', 'manifest.capabilityId', 'AE-7 requires its integration-only capability.');
  }
  if (world.manifest.maximumAuthority !== 'synthetic_offline_certification_only') {
    add(errors, 'AE7_AUTHORITY_TOO_WIDE', 'manifest.maximumAuthority', 'AE-7 cannot grant production authority.');
  }
  exactSet(errors, 'AE7_WORLD_FAMILIES_INCOMPLETE', 'manifest.requiredWorldFamilies', world.manifest.requiredWorldFamilies, REQUIRED_FAMILIES);

  const contract = world.aeWholePeriod;
  if (!plain(contract)) {
    add(errors, 'AE7_CONTRACT_REQUIRED', 'aeWholePeriod', 'The whole-period contract is required.');
    return result(errors);
  }
  if (contract.version !== AE_WHOLE_PERIOD_CONVERGENCE_VERSION) {
    add(errors, 'AE7_VERSION_INVALID', 'aeWholePeriod.version', `Expected ${AE_WHOLE_PERIOD_CONVERGENCE_VERSION}.`);
  }

  const cases = array(contract.worldCases);
  const caseIds = uniqueStrings(cases.map(({ caseId }) => caseId));
  if (cases.length !== 12 || caseIds.size !== cases.length) {
    add(errors, 'AE7_WORLD_CASES_INCOMPLETE', 'aeWholePeriod.worldCases', 'AE-7 requires twelve unique shipped world/focused-family cases.');
  }
  for (const [index, entry] of cases.entries()) {
    const path = `aeWholePeriod.worldCases[${index}]`;
    if (!plain(entry) || !REQUIRED_FAMILIES.includes(entry.family) || !WORLD_PATH.test(entry.path ?? '')) {
      add(errors, 'AE7_WORLD_CASE_INVALID', path, 'Each case needs a known family and bounded AE fixture path.');
    }
  }
  exactSet(errors, 'AE7_ARRIVAL_ORDER_SET_INCOMPLETE', 'aeWholePeriod.arrivalOrders', contract.arrivalOrders, REQUIRED_ARRIVAL_ORDERS);
  exactSet(errors, 'AE7_CRASH_BOUNDARY_SET_INCOMPLETE', 'aeWholePeriod.crashBoundaries', contract.crashBoundaries, REQUIRED_CRASH_BOUNDARIES);
  exactSet(errors, 'AE7_IDENTITY_CASE_SET_INCOMPLETE', 'aeWholePeriod.identityCases', contract.identityCases, REQUIRED_IDENTITIES);

  const mutations = array(contract.mutationContracts);
  const mutationById = new Map(mutations.map((entry) => [entry?.id, entry]));
  if (mutations.length !== Object.keys(EXPECTED_MUTATIONS).length || mutationById.size !== mutations.length) {
    add(errors, 'AE7_MUTATION_SET_INCOMPLETE', 'aeWholePeriod.mutationContracts', 'Every permanent AE mutation must appear exactly once.');
  }
  for (const [id, expectedCode] of Object.entries(EXPECTED_MUTATIONS)) {
    const mutation = mutationById.get(id);
    if (mutation?.expectedCode !== expectedCode || !world.manifest.protectedFailures.includes(id)) {
      add(errors, 'AE7_MUTATION_CONTRACT_INVALID', `aeWholePeriod.mutationContracts.${id}`, `Expected protected refusal ${expectedCode}.`);
    }
  }

  if (!Number.isSafeInteger(contract.shrink?.maxEvaluations) || contract.shrink.maxEvaluations < 2
      || contract.shrink.failureClass !== 'AE7_ARRIVAL_ORDER_DIVERGENCE'
      || contract.shrink.earliestObservableDivergence !== 'terminal_digest'
      || contract.shrink.consequence !== 'terminal_inventory_changed') {
    add(errors, 'AE7_SHRINK_CONTRACT_INVALID', 'aeWholePeriod.shrink', 'The bounded arrival-divergence shrink contract is required.');
  }

  const sibling = deriveSiblingWorld(world);
  if (!sibling.ok) {
    add(errors, 'AE7_HIDDEN_SIBLING_INVALID', 'counterfactualMutation', sibling.errors.join('; '));
  }
  if (world.entities.length !== 1) {
    add(errors, 'AE7_SUITE_ENTITY_REQUIRED', 'entities', 'The integration controller has one synthetic suite identity.');
  }
  return result(errors, {
    counts: {
      worldCases: cases.length,
      mutations: mutations.length,
      arrivalOrders: array(contract.arrivalOrders).length,
      crashBoundaries: array(contract.crashBoundaries).length,
      identityCases: array(contract.identityCases).length,
    },
  });
}

export function evaluateAeArrivalOrderInvariant(world, arrivalReceipts, terminalDigest) {
  const validation = validateAeWholePeriodConvergenceWorld(world);
  if (!validation.ok) return evaluation('INVALID_WORLD', validation.errors);
  const failures = [];
  const byName = new Map(array(arrivalReceipts).map((entry) => [entry?.orderName, entry]));
  for (const orderName of REQUIRED_ARRIVAL_ORDERS) {
    const receipt = byName.get(orderName);
    if (!receipt || receipt.terminalDigest !== terminalDigest || receipt.projector !== 'reconcileConvergenceState') {
      add(failures, 'AE7_ARRIVAL_ORDER_DIVERGENCE', `arrivalReceipts.${orderName}`, 'Every arrival order must converge to the same canonical terminal bytes.');
    }
  }
  if (byName.size !== REQUIRED_ARRIVAL_ORDERS.length) {
    add(failures, 'AE7_ARRIVAL_ORDER_DIVERGENCE', 'arrivalReceipts', 'Arrival receipts must contain exactly the four declared orders.');
  }
  return evaluation(failures.length ? 'FAIL' : 'PASS', failures);
}

export function buildAe7FailureReceipt(world) {
  const contract = world?.aeWholePeriod?.shrink;
  return Object.freeze({
    failureClass: contract?.failureClass,
    earliestObservableDivergence: Object.freeze({
      field: contract?.earliestObservableDivergence,
      expected: 'canonical_terminal_digest',
      observed: 'mutated_terminal_digest',
    }),
    consequence: Object.freeze({
      field: contract?.consequence,
      expected: 'same_t1_t2_inventory',
      observed: 'different_terminal_inventory',
    }),
  });
}

export function evaluateAeWholePeriodCandidate(world, candidate) {
  const validation = validateAeWholePeriodConvergenceWorld(world);
  if (!validation.ok) return certificate('INVALID_WORLD', 'FAIL', validation.errors, [], candidate);
  if (!plain(candidate)) {
    return certificate('INCOMPLETE', 'FAIL', [{ code: 'AE7_CANDIDATE_REQUIRED', path: 'candidate', message: 'Candidate must be an object.' }], [], candidate);
  }

  const failures = [];
  const prerequisites = [];
  const contract = world.aeWholePeriod;
  const expectedCases = new Map(contract.worldCases.map((entry) => [entry.caseId, entry]));
  const caseReceipts = array(candidate.caseReceipts);
  const caseById = new Map(caseReceipts.map((entry) => [entry?.caseId, entry]));
  const obligationIds = [];
  for (const [caseId, expected] of expectedCases) {
    const receipt = caseById.get(caseId);
    if (!receipt || receipt.family !== expected.family || !['pass', 'pass_with_named_gaps'].includes(receipt.status)) {
      add(failures, 'AE7_HEALTHY_WORLD_FAILED', `caseReceipts.${caseId}`, 'Every shipped AE family must pass its own evaluator.');
      continue;
    }
    const ids = array(receipt.obligationIds);
    if (ids.length === 0 || ids.some((id) => !nonEmpty(id))) {
      add(failures, 'AE7_ATOMIC_OBLIGATION_INVENTORY_MISSING', `caseReceipts.${caseId}.obligationIds`, 'Each family must enumerate its atomic obligations.');
    }
    obligationIds.push(...ids);
  }
  if (caseById.size !== expectedCases.size) {
    add(failures, 'AE7_WORLD_RECEIPT_SET_MISMATCH', 'caseReceipts', 'World receipts must cover exactly the declared cases.');
  }

  const terminalItems = array(candidate.terminalProjection?.items);
  const terminalIds = terminalItems.map(({ itemId }) => itemId);
  if (candidate.terminalProjection?.projector !== 'reconcileConvergenceState') {
    add(failures, 'AE7_CANONICAL_PROJECTOR_REQUIRED', 'terminalProjection.projector', 'Only the canonical production convergence projector is accepted.');
  }
  if (!sameSet(terminalIds, obligationIds) || new Set(terminalIds).size !== terminalIds.length) {
    add(failures, 'AE7_TERMINAL_INVENTORY_MISMATCH', 'terminalProjection.items', 'Every atomic obligation must occur exactly once in the terminal inventory.');
  }
  for (const item of terminalItems) {
    if (!TERMINAL_STATES.has(item?.state)) {
      add(failures, 'AE7_THIRD_RESTING_STATE', `terminalProjection.items.${item?.itemId ?? 'unknown'}`, 'Only T1 auto_reconciled or T2 on_owner may rest.');
    }
    if (item?.state === 'on_owner'
        && (item.responsibleActor !== 'owner' || !nonEmpty(item.askId) || item.reason !== 'open_owner_ask')) {
      add(failures, 'AE7_REAL_OWNER_ASK_REQUIRED', `terminalProjection.items.${item?.itemId ?? 'unknown'}`, 'T2 requires a real named owner ask projected by the canonical runtime.');
    }
  }
  const terminalDigest = digest(terminalItems);
  if (candidate.terminalProjection?.digest !== terminalDigest) {
    add(failures, 'AE7_TERMINAL_DIGEST_MISMATCH', 'terminalProjection.digest', 'Terminal projection bytes must carry their own canonical digest.');
  }

  const observer = candidate.canonicalObserver;
  if (observer?.projector !== 'reconcileConvergenceState'
      || observer?.terminalDigest !== terminalDigest
      || observer?.summary?.total !== terminalItems.length
      || observer?.summary?.hanging !== 0
      || observer?.summary?.converged !== true) {
    add(failures, 'AE7_CANONICAL_OBSERVER_PARITY_FAILED', 'canonicalObserver', 'The canonical runtime projector must agree with the terminal inventory.');
  }

  const arrivals = evaluateAeArrivalOrderInvariant(world, candidate.arrivalReceipts, terminalDigest);
  failures.push(...arrivals.failures);

  const replayReceipts = array(candidate.replayReceipts);
  const replayNames = ['initial', 'replay', 'reset_replay'];
  if (replayReceipts.length !== replayNames.length
      || replayReceipts.some((entry, index) => entry?.name !== replayNames[index]
        || entry?.terminalDigest !== terminalDigest
        || entry?.projectionBytes !== replayReceipts[0]?.projectionBytes)) {
    add(failures, 'AE7_REPLAY_NOT_BYTE_STABLE', 'replayReceipts', 'Initial, replay, and reset/replay projections must be byte-identical.');
  }

  const sibling = candidate.siblingReceipt;
  if (sibling?.changedFactIds?.length !== 1
      || sibling.changedFactIds[0] !== world.counterfactualMutation.declaredFactId
      || sibling?.from !== world.counterfactualMutation.expectedTreatmentChange.from
      || sibling?.to !== world.counterfactualMutation.expectedTreatmentChange.to
      || sibling?.sourceDigest === sibling?.siblingDigest
      || sibling?.discriminated !== true) {
    add(failures, 'AE7_HIDDEN_SIBLING_NOT_DISCRIMINATED', 'siblingReceipt', 'The derived sibling must change one hidden fact and its accounting consequence.');
  }

  const mutations = new Map(array(candidate.mutationReceipts).map((entry) => [entry?.id, entry]));
  for (const [id, expectedCode] of Object.entries(EXPECTED_MUTATIONS)) {
    const receipt = mutations.get(id);
    if (!receipt || receipt.status !== 'refused' || receipt.expectedCode !== expectedCode
        || receipt.observedCode !== expectedCode || !array(receipt.observedCodes).includes(expectedCode)) {
      add(failures, 'AE7_PROTECTED_MUTATION_SURVIVED', `mutationReceipts.${id}`, `Mutation must refuse at ${expectedCode}.`);
    }
  }
  if (mutations.size !== Object.keys(EXPECTED_MUTATIONS).length) {
    add(failures, 'AE7_MUTATION_RECEIPT_SET_MISMATCH', 'mutationReceipts', 'Mutation receipts must cover exactly the protected set.');
  }

  const shrinkReceipts = array(candidate.shrinkReceipts);
  if (shrinkReceipts.length !== 2
      || shrinkReceipts.some((entry) => entry?.ok !== true
        || entry?.exhausted === true
        || entry?.quarantineCount !== 0
        || entry?.removedCount < 1
        || entry?.evaluations > contract.shrink.maxEvaluations)
      || shrinkReceipts[0]?.digest !== shrinkReceipts[1]?.digest
      || shrinkReceipts[0]?.targetSignature !== shrinkReceipts[1]?.targetSignature
      || shrinkReceipts[0]?.evaluations !== shrinkReceipts[1]?.evaluations) {
    add(failures, 'AE7_SHRINK_RECEIPT_INVALID', 'shrinkReceipts', 'Two bounded shrink runs must preserve one failure and produce identical receipts without quarantine.');
  }

  const identities = new Map(array(candidate.identityReceipts).map((entry) => [entry?.identityCase, entry]));
  for (const identityCase of REQUIRED_IDENTITIES) {
    const receipt = identities.get(identityCase);
    if (receipt?.status !== 'refused' || receipt?.code !== 'AE_CROSS_ENTITY_LINK') {
      add(failures, 'AE7_ENTITY_ISOLATION_FAILED', `identityReceipts.${identityCase}`, 'Every ambiguous entity identity must fail closed at the legal-entity boundary.');
    }
  }
  if (identities.size !== REQUIRED_IDENTITIES.length) {
    add(failures, 'AE7_ENTITY_ISOLATION_SET_MISMATCH', 'identityReceipts', 'Identity receipts must cover cross-entity, same-name, derived-id, and long-id cases exactly.');
  }

  if (candidate.spend?.modelProviderCalls !== 0 || candidate.spend?.externalCalls !== 0
      || candidate.spend?.amountUsd !== '0.00') {
    add(failures, 'AE7_ZERO_SPEND_VIOLATED', 'spend', 'AE-7 is offline and must make zero provider or external calls.');
  }
  if (candidate.production?.operationsBinding?.status !== 'bound'
      || array(candidate.production?.operationsBinding?.operations).length === 0) {
    add(failures, 'AE7_PRODUCTION_BOUNDARY_UNBOUND', 'production.operationsBinding', 'The existing named production operations boundary must bind successfully.');
  }
  if (candidate.production?.vat?.status !== 'pass_with_named_gaps'
      || array(candidate.production?.vat?.gaps).length !== 2) {
    add(failures, 'AE7_VAT_PRODUCTION_PARITY_FAILED', 'production.vat', 'The supported VAT subset must pass and retain both named production gaps.');
  }
  if (candidate.production?.pint?.status !== 'pass'
      || candidate.production?.pint?.modelProviderCalls !== 0) {
    add(failures, 'AE7_PINT_PRODUCTION_PARITY_FAILED', 'production.pint', 'The shipping PINT/parser renderer seam must pass at zero provider calls.');
  }

  for (const prerequisite of array(candidate.production?.prerequisites)) {
    if (prerequisite?.status === 'INCOMPLETE') prerequisites.push(prerequisite);
    else if (prerequisite?.status !== 'PASS') {
      add(failures, 'AE7_PRODUCTION_PREREQUISITE_RECEIPT_INVALID', 'production.prerequisites', 'Production prerequisites must either pass or remain explicitly incomplete.');
    }
  }
  const prerequisiteCodes = new Set(prerequisites.map(({ code }) => code));
  for (const code of [
    'AE7_POSTGRESQL_LIFECYCLE_NOT_RUN',
    'AE7_PERSISTED_OBSERVER_NOT_RUN',
    'AE7_CRASH_RESUME_NOT_RUN',
    'AE7_RETIREMENT_CLEANUP_NOT_RUN',
  ]) {
    if (!prerequisiteCodes.has(code) && !array(candidate.production?.prerequisites).some((entry) => entry?.code === code && entry?.status === 'PASS')) {
      add(failures, 'AE7_PRODUCTION_PREREQUISITE_MISSING', 'production.prerequisites', `Missing production prerequisite receipt ${code}.`);
    }
  }

  const offlineStatus = failures.length ? 'FAIL' : 'PASS';
  const status = failures.length ? 'FAIL' : prerequisites.length ? 'INCOMPLETE' : 'PASS';
  return certificate(status, offlineStatus, failures, prerequisites, candidate, terminalDigest);
}

export function digestAeWholePeriod(value) {
  return digest(value);
}

function certificate(status, offlineStatus, failures, prerequisites, candidate, terminalDigest = null) {
  return Object.freeze({
    version: AE_WHOLE_PERIOD_CONVERGENCE_VERSION,
    status,
    offlineStatus,
    failures: Object.freeze(failures),
    prerequisites: Object.freeze(prerequisites),
    terminalDigest,
    counts: Object.freeze({
      cases: array(candidate?.caseReceipts).length,
      obligations: array(candidate?.terminalProjection?.items).length,
      t1: array(candidate?.terminalProjection?.items).filter(({ state }) => state === 'auto_reconciled').length,
      t2: array(candidate?.terminalProjection?.items).filter(({ state }) => state === 'on_owner').length,
      limbo: array(candidate?.terminalProjection?.items).filter(({ state }) => !TERMINAL_STATES.has(state)).length,
      mutations: array(candidate?.mutationReceipts).length,
      identityCases: array(candidate?.identityReceipts).length,
    }),
    receiptDigest: digest({ status, offlineStatus, failures, prerequisites, terminalDigest }),
  });
}

function evaluation(status, failures) {
  return Object.freeze({
    version: AE_WHOLE_PERIOD_CONVERGENCE_VERSION,
    status,
    failures: Object.freeze(failures),
    receiptDigest: digest({ status, failures }),
  });
}

function result(errors, extra = {}) {
  return Object.freeze({
    ok: errors.length === 0,
    version: AE_WHOLE_PERIOD_CONVERGENCE_VERSION,
    errors: Object.freeze(errors),
    ...extra,
  });
}

function exactSet(errors, code, path, actual, expected) {
  if (!sameSet(actual, expected)) add(errors, code, path, `Expected exactly: ${expected.join(', ')}.`);
}

function sameSet(left, right) {
  const a = array(left);
  const b = array(right);
  return a.length === b.length && new Set(a).size === a.length && a.every((value) => b.includes(value));
}

function uniqueStrings(values) {
  return new Set(values.filter(nonEmpty));
}

function add(errors, code, path, message) {
  errors.push(Object.freeze({ code, path, message }));
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
