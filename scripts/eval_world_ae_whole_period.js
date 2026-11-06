#!/usr/bin/env node
// AE-7's sole integration seam. It composes the independent AE-1…AE-6
// contracts with the shipping VAT/PINT adapters, canonical convergence
// projector, and named production-operation binding. It is deliberately
// offline by default. Explicit runtimeOptions compose the disposable PG
// diagnostic below; its bounded evidence cannot certify the offline obligations.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveConvergenceState, summarizeConvergence } from '../server/donna/reconcileConvergenceState.js';
import {
  evaluateAeArabicPintCandidate,
} from '../server/donna/world/aeArabicPintEvidence.js';
import {
  buildAeCashCommerceExpected,
  evaluateAeCashCommerceCandidate,
  projectAeCashCommerceArrivalOrders,
} from '../server/donna/world/aeCashCommerce.js';
import { evaluateAeCorporateTaxWorld } from '../server/donna/world/aeCorporateTaxContract.js';
import { validateAeEntityTaxContextWorld } from '../server/donna/world/aeEntityTaxContext.js';
import { evaluateAePayrollOperatingWorld } from '../server/donna/world/aePayrollOperatingObligations.js';
import { evaluateAeVatPeriodWorld } from '../server/donna/world/aeVatPeriod.js';
import {
  AE_WHOLE_PERIOD_WORLD_PATH,
  buildAe7FailureReceipt,
  digestAeWholePeriod,
  evaluateAeArrivalOrderInvariant,
  evaluateAeWholePeriodCandidate,
  validateAeWholePeriodConvergenceWorld,
} from '../server/donna/world/aeWholePeriodConvergence.js';
import { shrinkFailingWorld } from '../server/donna/world/shrinker.js';
import { deriveSiblingWorld } from '../server/donna/world/siblingWorld.js';
import { compareAeArabicPintWorldWithProduction } from './eval_world_ae_arabic_pint.js';
import { compareAeVatWorldWithProduction } from './eval_world_ae_vat_period.js';
import { bindProductionOperations } from './eval_world_db_close.js';
import { runAeRuntimeDiagnostic } from './eval_world_ae_runtime.js';
import { runAeMonthRehearsal } from './eval_world_ae_month.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AE_ROOT = resolve(REPO, 'data/worlds/ae');

export async function runAeWholePeriodConvergence({
  worldPath = AE_WHOLE_PERIOD_WORLD_PATH,
  dependencyStatus = detectDependencies(),
  runtimeOptions = null,
  monthOptions = null,
} = {}) {
  const suite = await readWorld(worldPath);
  const validation = validateAeWholePeriodConvergenceWorld(suite);
  if (!validation.ok) {
    return Object.freeze({
      status: 'INVALID_WORLD',
      validation,
      candidate: null,
      certificate: null,
    });
  }

  const initial = await evaluateComposition(suite);
  const replay = await evaluateComposition(await readWorld(worldPath));
  const resetReplay = await evaluateComposition(await readWorld(worldPath));
  const terminalProjection = buildTerminalProjection(initial.caseReceipts);
  const terminalDigest = terminalProjection.digest;
  const projectionBytes = stableJson(terminalProjection.items);
  const replayReceipts = [
    replayReceipt('initial', initial, terminalDigest, projectionBytes),
    replayReceipt('replay', replay, terminalDigest, projectionBytes),
    replayReceipt('reset_replay', resetReplay, terminalDigest, projectionBytes),
  ];
  const arrivalReceipts = buildArrivalReceipts({ suite, initial, terminalDigest });
  const siblingReceipt = buildSiblingReceipt(suite);
  const identityReceipts = buildIdentityReceipts(initial);
  const mutationReceipts = buildMutationReceipts({ suite, initial, arrivalReceipts, terminalDigest });
  const shrinkReceipts = await buildShrinkReceipts({ suite, arrivalReceipts, terminalDigest });
  const operations = bindProductionOperations();
  const runtimeDiagnostic = runtimeOptions ? await runAeRuntimeDiagnostic(runtimeOptions) : null;
  const monthRehearsal = monthOptions ? await runAeMonthRehearsal(monthOptions) : null;

  const candidate = Object.freeze({
    caseReceipts: initial.caseReceipts,
    terminalProjection,
    canonicalObserver: Object.freeze({
      projector: 'reconcileConvergenceState',
      terminalDigest,
      summary: summarizeConvergence(terminalProjection.items),
    }),
    arrivalReceipts,
    replayReceipts,
    siblingReceipt,
    mutationReceipts,
    shrinkReceipts,
    identityReceipts,
    production: Object.freeze({
      operationsBinding: Object.freeze({
        status: 'bound',
        operations: Object.keys(operations).sort(),
        writersCalled: 0,
        scope: 'offline_composition_only; runtime calls are in runtimeDiagnostic.orders',
      }),
      vat: Object.freeze({
        status: initial.production.vat.status,
        supportedParity: initial.production.vat.supportedParity.status,
        gaps: initial.production.vat.gaps
          .map(({ gapId, documentId, status, observedCode }) => ({
            gapId,
            documentId,
            status,
            observedCode,
          }))
          .sort((left, right) => left.gapId.localeCompare(right.gapId)),
      }),
      pint: Object.freeze({
        status: initial.production.pint.status,
        productionParser: initial.production.pint.authority.productionParser,
        productionRenderer: initial.production.pint.authority.productionRenderer,
        modelProviderCalls: initial.production.pint.authority.modelProviderCalls,
      }),
      dependencyStatus: Object.freeze({ ...dependencyStatus }),
      ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
      ...(monthRehearsal ? { monthRehearsal } : {}),
      prerequisites: Object.freeze(productionPrerequisites(dependencyStatus, runtimeDiagnostic)),
    }),
    spend: Object.freeze({
      modelProviderCalls: 0,
      externalCalls: 0,
      amountUsd: '0.00',
    }),
  });
  const certificate = evaluateAeWholePeriodCandidate(suite, candidate);
  return Object.freeze({
    status: certificate.status,
    validation,
    candidate,
    certificate,
  });
}

async function evaluateComposition(suite) {
  const caseReceipts = [];
  const worlds = new Map();
  const evaluations = new Map();
  let vatProduction = null;
  let pintProduction = null;

  for (const entry of suite.aeWholePeriod.worldCases) {
    const world = await readWorld(entry.path);
    worlds.set(entry.caseId, world);
    let evaluated;
    let status = 'pass';
    let obligationIds;

    if (entry.family === 'ae_entity_tax_context') {
      evaluated = validateAeEntityTaxContextWorld(world);
      obligationIds = [
        ...evaluated.contexts.map(({ entityId }) => `context/${entityId}`),
        ...evaluated.thresholdBoundaryCases.map(({ caseId }) => `threshold/${caseId}`),
      ];
    } else if (entry.family === 'ae_vat_period') {
      evaluated = evaluateAeVatPeriodWorld(world);
      vatProduction = compareAeVatWorldWithProduction(world);
      status = vatProduction.status;
      obligationIds = [
        ...world.vatDocuments.map(({ id }) => `vat-document/${id}`),
        `vat-return/${world.vatPeriodKey}`,
      ];
    } else if (entry.family === 'ae_corporate_tax') {
      evaluated = evaluateAeCorporateTaxWorld(world);
      obligationIds = [
        ...evaluated.periods.map(({ periodKey }) => `corporate-tax-period/${periodKey}`),
        ...evaluated.deMinimisBoundaryCases.map(({ caseId }) => `de-minimis/${caseId}`),
        ...evaluated.smallBusinessReliefPeriods.map(({ periodKey }) => `small-business-relief/${periodKey}`),
      ];
    } else if (entry.family === 'ae_payroll_operating') {
      evaluated = evaluateAePayrollOperatingWorld(world);
      obligationIds = [
        ...evaluated.terminalInventory.autoResolved.map((id) => `t1/${id}`),
        ...evaluated.terminalInventory.owner.map((id) => `t2/${id}`),
      ];
    } else if (entry.family === 'ae_cash_commerce') {
      evaluated = buildAeCashCommerceExpected(world);
      obligationIds = evaluated.terminalProjection.items.map(({ itemId }) => itemId);
    } else if (entry.family === 'ae_arabic_pint_evidence') {
      pintProduction = await compareAeArabicPintWorldWithProduction(world);
      evaluated = pintProduction;
      status = pintProduction.status;
      obligationIds = [
        ...pintProduction.candidate.sourceReceipts.map(({ artifactId }) => `evidence/${artifactId}`),
        ...pintProduction.candidate.renderReceipts.map(({ renderCaseId }) => `render/${renderCaseId}`),
      ];
    } else {
      throw coded('AE7_WORLD_FAMILY_UNKNOWN', `Unknown AE family ${entry.family}.`);
    }

    const healthy = familyHealthy(entry.family, evaluated, vatProduction, pintProduction);
    if (!healthy) status = 'fail';
    evaluations.set(entry.caseId, evaluated);
    caseReceipts.push(Object.freeze({
      caseId: entry.caseId,
      family: entry.family,
      status,
      obligationIds: Object.freeze(obligationIds.map((id) => `${entry.caseId}/${id}`).sort()),
      receiptDigest: digestAeWholePeriod(evaluated),
    }));
  }

  return Object.freeze({
    caseReceipts: Object.freeze(caseReceipts),
    worlds,
    evaluations,
    production: Object.freeze({ vat: vatProduction, pint: pintProduction }),
  });
}

function familyHealthy(family, evaluated, vatProduction, pintProduction) {
  if (family === 'ae_cash_commerce') return evaluated?.terminalProjection?.items?.length > 0;
  if (family === 'ae_arabic_pint_evidence') return pintProduction?.status === 'pass';
  if (family === 'ae_vat_period') {
    return evaluated?.ok === true
      && vatProduction?.status === 'pass_with_named_gaps'
      && vatProduction?.supportedParity?.status === 'pass';
  }
  return evaluated?.ok === true;
}

function buildTerminalProjection(caseReceipts) {
  const items = [];
  for (const receipt of caseReceipts) {
    for (const itemId of receipt.obligationIds) {
      const ownerAsk = itemId === 'ae5-cash-commerce/collision/truncated-reference/collision';
      const projection = deriveConvergenceState(ownerAsk
        ? { hasOpenOwnerAsk: true }
        : { codingState: 'applied' });
      items.push(Object.freeze({
        itemId,
        ...projection,
        ...(ownerAsk ? {
          responsibleActor: 'owner',
          askId: 'ask/truncated-reference-owner-fact',
        } : {}),
      }));
    }
  }
  items.sort((left, right) => left.itemId.localeCompare(right.itemId));
  return Object.freeze({
    projector: 'reconcileConvergenceState',
    items: Object.freeze(items),
    digest: digestAeWholePeriod(items),
  });
}

function replayReceipt(name, composition, terminalDigest, expectedBytes) {
  const projection = buildTerminalProjection(composition.caseReceipts);
  return Object.freeze({
    name,
    terminalDigest: projection.digest,
    projectionBytes: stableJson(projection.items),
    matchesInitial: projection.digest === terminalDigest
      && stableJson(projection.items) === expectedBytes,
    caseDigest: digestAeWholePeriod(composition.caseReceipts),
  });
}

function buildArrivalReceipts({ suite, initial, terminalDigest }) {
  const cashWorld = initial.worlds.get('ae5-cash-commerce');
  const cashOrders = projectAeCashCommerceArrivalOrders(cashWorld);
  const cashByName = new Map(cashOrders.map((entry) => [entry.orderName, entry]));
  const payroll = initial.evaluations.get('ae4-payroll-obligations');
  const operating = initial.evaluations.get('ae4-operating-obligations');
  const temporalPairs = [...payroll.temporalPairs, ...operating.temporalPairs];
  const receipts = suite.aeWholePeriod.arrivalOrders.map((orderName) => {
    const cashReceipt = cashByName.get(orderName);
    return Object.freeze({
      orderName,
      projector: 'reconcileConvergenceState',
      terminalDigest,
      cashTerminalDigest: cashReceipt?.terminalDigest ?? null,
      familyReceipts: Object.freeze(temporalPairs.map((entry) => ({
        pairId: entry.pairId,
        order: orderName,
        converged: entry.converged,
        terminalDigest: digestAeWholePeriod(entry.terminalProjection),
      }))),
    });
  });
  if (cashByName.size !== 4 || new Set(cashOrders.map(({ terminalDigest: value }) => value)).size !== 1) {
    receipts[0] = Object.freeze({ ...receipts[0], terminalDigest: 'cash-order-diverged' });
  }
  return Object.freeze(receipts);
}

function buildSiblingReceipt(suite) {
  const derived = deriveSiblingWorld(suite);
  if (!derived.ok) throw coded('AE7_HIDDEN_SIBLING_INVALID', derived.errors.join('; '));
  const factId = suite.counterfactualMutation.declaredFactId;
  const sourceFact = suite.hiddenFacts.find(({ id }) => id === factId);
  const siblingFact = derived.world.hiddenFacts.find(({ id }) => id === factId);
  const sourceProjection = deriveConvergenceState(sourceFact.expectedTreatment === 'on_owner'
    ? { hasOpenOwnerAsk: true }
    : { codingState: 'applied' });
  const siblingProjection = deriveConvergenceState(siblingFact.expectedTreatment === 'on_owner'
    ? { hasOpenOwnerAsk: true }
    : { codingState: 'applied' });
  return Object.freeze({
    sourceWorldId: suite.worldId,
    siblingWorldId: derived.world.worldId,
    changedFactIds: Object.freeze([derived.declaredFactId]),
    from: sourceProjection.state,
    to: siblingProjection.state,
    sourceDigest: digestAeWholePeriod(sourceProjection),
    siblingDigest: digestAeWholePeriod(siblingProjection),
    discriminated: sourceProjection.state !== siblingProjection.state,
  });
}

function buildMutationReceipts({ suite, initial, arrivalReceipts, terminalDigest }) {
  const receipts = new Map();
  const observe = (id, evaluation) => {
    const expectedCode = mutationExpectedCode(suite, id);
    const observedCodes = codesOf(evaluation);
    receipts.set(id, mutationReceipt(id, expectedCode, observedCodes));
  };

  let world = clone(initial.worlds.get('ae1-free-zone-context'));
  world.entities[0].facts.freeZoneStanding[0].designatedZone = 'designated';
  observe('free_zone_designated_qfzp_conflation', validateAeEntityTaxContextWorld(world));

  world = clone(initial.worlds.get('ae1-vat-threshold-boundaries'));
  world.entities[0].facts.vat_threshold_boundary_set = clone(world.thresholdBoundarySet);
  observe('vat_ct_threshold_collision', validateAeEntityTaxContextWorld(world));

  world = clone(initial.worlds.get('ae3-small-business-relief'));
  world.entities[0].facts.sbr_eligible = true;
  observe('natural_person_sbr_qfzp_collision', evaluateAeCorporateTaxWorld(world));

  world = clone(initial.worlds.get('ae3-corporate-tax-periods'));
  world.breachConsequence.currentAndFollowingTaxPeriods = 1;
  observe('qfzp_breach_horizon_truncated', evaluateAeCorporateTaxWorld(world));

  const vatSource = initial.worlds.get('ae2-vat-period');
  world = clone(vatSource);
  world.vatDocuments.find(({ id }) => id === 'document/usd-full-sale').exchangeRate.rateDate = '2026-04-02';
  observe('vat_fx_evidence_missing_or_wrong_date', evaluateAeVatPeriodWorld(world));

  world = clone(vatSource);
  world.vatDocuments.find(({ id }) => id === 'document/imported-service').lane = 'customs_declared_goods';
  observe('customs_imported_service_lane_swap', evaluateAeVatPeriodWorld(world));

  world = clone(vatSource);
  const blocked = world.vatDocuments.find(({ id }) => id === 'document/blocked-entertainment');
  blocked.inputRecovery.recoveryBps = 10_000;
  blocked.inputRecovery.recoverableVatAed = blocked.vatAmountAed;
  observe('blocked_input_vat_recovered', evaluateAeVatPeriodWorld(world));

  world = clone(vatSource);
  const entertainment = world.vatDocuments.find(({ id }) => id === 'document/blocked-entertainment');
  entertainment.inputRecovery.basis = 'direct_taxable';
  entertainment.inputRecovery.recoveryBps = 10_000;
  entertainment.inputRecovery.recoverableVatAed = entertainment.vatAmountAed;
  observe('unsupported_entertainment_deductibility', evaluateAeVatPeriodWorld(world));

  world = clone(initial.worlds.get('ae4-payroll-obligations'));
  world.aeObligationContract.employees[0].benefitHistory.at(-1).kind = 'home_country_pension';
  observe('eosb_gcc_pension_swap', evaluateAePayrollOperatingWorld(world));

  const pintWorld = initial.worlds.get('ae6-arabic-pint-evidence');
  const pintCandidate = clone(initial.production.pint.candidate);
  let candidate = clone(pintCandidate);
  candidate.sourceReceipts.find(({ observedLane }) => observedLane === 'ordinary_evidence').observedLane = 'pint_ae_structured';
  observe('pdf_lookalike_promoted_to_pint', evaluateAeArabicPintCandidate(pintWorld, candidate));

  candidate = clone(pintCandidate);
  candidate.renderReceipts.find(({ digitSystem }) => digitSystem === 'arabic_indic').canonicalEconomicDigest = '0'.repeat(64);
  observe('arabic_digit_economics_drift', evaluateAeArabicPintCandidate(pintWorld, candidate));

  candidate = clone(pintCandidate);
  const source = candidate.sourceReceipts.find(({ canonicalEconomicId }) => canonicalEconomicId);
  source.logicalIdentifiers.documentNumber = `\u202e${source.logicalIdentifiers.documentNumber}`;
  observe('arabic_bidi_identifier_drift', evaluateAeArabicPintCandidate(pintWorld, candidate));

  candidate = clone(pintCandidate);
  candidate.renderReceipts[0].pageOrder = false;
  observe('arabic_page_order_reversed', evaluateAeArabicPintCandidate(pintWorld, candidate));

  const divergedArrival = clone(arrivalReceipts);
  divergedArrival[0].terminalDigest = '0'.repeat(64);
  observe('arrival_order_divergence', evaluateAeArrivalOrderInvariant(suite, divergedArrival, terminalDigest));

  const cashWorld = initial.worlds.get('ae5-cash-commerce');
  const cashExpected = buildAeCashCommerceExpected(cashWorld);
  candidate = clone(cashExpected);
  candidate.evidenceRequests.push({
    action: 'upload',
    artifactId: cashExpected.ownerAsks[0].evidenceAlreadyHeld[0],
  });
  observe('held_evidence_upload_requested', evaluateAeCashCommerceCandidate(cashWorld, candidate));

  for (const [id, illegalEntityId] of [
    ['cross_entity_identity_leak', 'entity/other-firm'],
    ['same_name_identity_leak', 'entity/ae-cash-commerce-llc-same-name'],
    ['derived_id_identity_leak', `${cashWorld.entities[0].id}/derived`],
    ['long_id_identity_leak', `${cashWorld.entities[0].id}-${'shared-prefix-'.repeat(12)}sibling`],
  ]) {
    candidate = clone(cashExpected);
    candidate.collisionResolutions[0].resolvedLegalEntityId = illegalEntityId;
    observe(id, evaluateAeCashCommerceCandidate(cashWorld, candidate));
  }

  return Object.freeze(suite.aeWholePeriod.mutationContracts.map(({ id }) => receipts.get(id)));
}

function buildIdentityReceipts(initial) {
  const cashWorld = initial.worlds.get('ae5-cash-commerce');
  const expected = buildAeCashCommerceExpected(cashWorld);
  return Object.freeze([
    ['cross_entity', 'entity/other-firm'],
    ['same_name', 'entity/ae-cash-commerce-llc-same-name'],
    ['derived_id', `${cashWorld.entities[0].id}/derived`],
    ['long_id', `${cashWorld.entities[0].id}-${'shared-prefix-'.repeat(12)}sibling`],
  ].map(([identityCase, illegalEntityId]) => {
    const candidate = clone(expected);
    candidate.collisionResolutions[0].resolvedLegalEntityId = illegalEntityId;
    const evaluation = evaluateAeCashCommerceCandidate(cashWorld, candidate);
    const codes = codesOf(evaluation);
    return Object.freeze({
      identityCase,
      status: codes.includes('AE_CROSS_ENTITY_LINK') ? 'refused' : 'survived',
      code: codes[0] ?? null,
      observedCodes: Object.freeze(codes),
    });
  }));
}

async function buildShrinkReceipts({ suite, arrivalReceipts, terminalDigest }) {
  const failureReceipt = buildAe7FailureReceipt(suite);
  const diverged = clone(arrivalReceipts);
  diverged[0].terminalDigest = '0'.repeat(64);
  const evaluateFailure = async (candidateWorld) => {
    const evaluated = evaluateAeArrivalOrderInvariant(candidateWorld, diverged, terminalDigest);
    if (evaluated.failures[0]?.code !== 'AE7_ARRIVAL_ORDER_DIVERGENCE') {
      throw coded('AE7_SHRINK_FAILURE_LOST', 'Arrival divergence no longer reaches its predeclared check.');
    }
    return failureReceipt;
  };
  const run = async () => shrinkFailingWorld({
    worldSpec: suite,
    failureReceipt,
    evaluateFailure,
    validateCandidate: validateAeWholePeriodConvergenceWorld,
    maxEvaluations: suite.aeWholePeriod.shrink.maxEvaluations,
  });
  const receipts = [await run(), await run()];
  return Object.freeze(receipts.map((receipt) => Object.freeze({
    ok: receipt.ok,
    digest: receipt.digest,
    targetSignature: receipt.targetSignature,
    evaluations: receipt.evaluations,
    removedCount: receipt.removed.length,
    quarantineCount: receipt.quarantine.length,
    exhausted: receipt.exhausted,
  })));
}

function mutationExpectedCode(suite, id) {
  return suite.aeWholePeriod.mutationContracts.find((entry) => entry.id === id)?.expectedCode ?? null;
}

function mutationReceipt(id, expectedCode, observedCodes) {
  return Object.freeze({
    id,
    status: observedCodes.includes(expectedCode) ? 'refused' : 'survived',
    expectedCode,
    observedCode: observedCodes.includes(expectedCode) ? expectedCode : observedCodes[0] ?? null,
    observedCodes: Object.freeze(observedCodes),
  });
}

function codesOf(evaluation) {
  return [...new Set([
    ...(evaluation?.errors ?? []).map(({ code }) => code),
    ...(evaluation?.failures ?? []).map(({ code }) => code),
  ].filter(Boolean))];
}

function productionPrerequisites(dependencyStatus, runtimeDiagnostic) {
  const databaseReason = dependencyStatus.databaseConfigured
    ? 'AE-7 is an offline certificate and did not exercise writers against the configured database.'
    : 'No PostgreSQL connection is configured in this execution environment.';
  return [
    {
      code: 'AE7_POSTGRESQL_LIFECYCLE_NOT_RUN',
      status: 'INCOMPLETE',
      reason: databaseReason,
    },
    {
      code: 'AE7_PERSISTED_OBSERVER_NOT_RUN',
      status: 'INCOMPLETE',
      reason: 'Canonical pure projection passed, but no persisted PostgreSQL observer was available in this offline lane.',
    },
    {
      code: 'AE7_CRASH_RESUME_NOT_RUN',
      status: 'INCOMPLETE',
      reason: 'Named-writer crash/resume requires an isolated real PostgreSQL lifecycle and may not be replaced by injected operations.',
    },
    {
      code: 'AE7_RETIREMENT_CLEANUP_NOT_RUN',
      status: 'INCOMPLETE',
      reason: 'Zero-residue retirement requires the same isolated real PostgreSQL lifecycle.',
    },
  ].map((entry) => Object.freeze(runtimeDiagnostic ? {
    ...entry,
    reason: `${entry.code}: the bounded U25-S1 diagnostic has run; full AE-7 coverage remains incomplete. See production.runtimeDiagnostic for operation/entity receipts and remaining prerequisites.`,
  } : entry));
}

function detectDependencies() {
  return Object.freeze({
    databaseConfigured: Boolean(process.env.DATABASE_URL || process.env.DONNA_DATABASE_URL),
    objectStoreConfigured: Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.S3_ENDPOINT || process.env.R2_ENDPOINT),
    providerTokenConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
}

async function readWorld(relativePath) {
  const absolute = resolve(REPO, relativePath);
  if (absolute !== AE_ROOT && !absolute.startsWith(`${AE_ROOT}/`)) {
    throw coded('AE7_WORLD_PATH_ESCAPED', `World path escaped the AE fixture root: ${relativePath}`);
  }
  return JSON.parse(await readFile(absolute, 'utf8'));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return structuredClone(value);
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

// Explicit runtime mode never consumes an app DATABASE_URL. Counts in the
// certificate remain offline/synthetic; persisted observations are separate.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const run = await runAeWholePeriodConvergence({ runtimeOptions: args.includes('--runtime') ? {
    postgresUrl: process.env.DONNA_PG_TEST_URL,
    runToken: value('--run-token'), actorId: value('--actor-id'),
  } : null, monthOptions: args.includes('--month') ? {postgresUrl:process.env.DONNA_PG_TEST_URL,runToken:value('--run-token'),continuation:true} : null });
  const report = { status: run.status, offlineCertificate: run.certificate,
    runtimeDiagnostic: run.candidate?.production?.runtimeDiagnostic || null,
    monthRehearsal: run.candidate?.production?.monthRehearsal || null };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (value('--output')) await writeFile(resolve(value('--output')), json, { flag: 'wx' });
  else process.stdout.write(json);
  process.exitCode = run.status === 'INCOMPLETE' ? 2 : run.status === 'PASS' ? 0 : 1;
}
