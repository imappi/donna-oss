import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AE_CORPORATE_TAX_CONTRACT_VERSION,
  AE_CT_REFUSAL_CODES,
  evaluateAeCorporateTaxWorld,
  expandAeDeMinimisBoundarySets,
} from './aeCorporateTaxContract.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const CORPORATE_TAX_FIXTURE = 'ae-free-zone-corporate-tax-periods.json';
const SBR_FIXTURE = 'ae-small-business-relief-2026-extension.json';

test('AE-3 fixtures compose through the shared schema, causal validity, renderer, and AE corporate-tax contract', async () => {
  const malformed = evaluateAeCorporateTaxWorld(null);
  assert.equal(malformed.ok, false);
  assert.ok(malformed.errors.length > 0);
  for (const filename of [CORPORATE_TAX_FIXTURE, SBR_FIXTURE]) {
    const world = await loadWorld(filename);
    assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] }, filename);
    assert.deepEqual(validateCausalWorld(world), {
      ok: true,
      version: 'proof0.validity.v1',
      errors: [],
    }, filename);
    const evaluation = evaluateAeCorporateTaxWorld(world);
    assert.equal(evaluation.ok, true, `${filename}: ${JSON.stringify(evaluation.errors)}`);
    assert.equal(evaluation.version, AE_CORPORATE_TAX_CONTRACT_VERSION);
    assert.equal(evaluation.authority.scope, 'oracle_expected_policy_consequences_only');
    assert.deepEqual(evaluation.authority.prohibitedActions, [
      'write_tax_state', 'file', 'pay', 'post_journal', 'grant_production_authority',
    ]);
    const rendered = await renderWorldArtifacts(world);
    assert.equal(rendered.ok, true, `${filename}: ${JSON.stringify(rendered.errors)}`);
    assert.ok(rendered.artifacts.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
  }
});

test('current primary-source receipts pin MD 229, MD 131, and current FTA guidance as of 2026-08-31', async () => {
  const corporate = await loadWorld(CORPORATE_TAX_FIXTURE);
  const sbr = await loadWorld(SBR_FIXTURE);
  const registry = corporate.policySources.find(({ id }) => id === 'policy/ae-mof-legislation-registry');
  const md229 = corporate.policySources.find(({ id }) => id === 'policy/ae-md229-2025');
  const guidance = corporate.policySources.find(({ id }) => id === 'policy/ae-fta-ctgfzp1');
  const md131 = sbr.policySources.find(({ id }) => id === 'policy/ae-md131-2026');
  assert.deepEqual({
    authority: registry.authority,
    url: registry.url,
    effectiveFrom: registry.effectiveFrom,
    asOf: registry.asOf,
  }, {
    authority: 'Ministry of Finance',
    url: 'https://mof.gov.ae/en/financial-legislation/',
    effectiveFrom: '2026-08-31',
    asOf: '2026-08-31',
  });
  assert.deepEqual({
    authority: md229.authority,
    documentNumber: md229.documentNumber,
    effectiveFrom: md229.effectiveFrom,
    asOf: md229.asOf,
    supersedes: md229.supersedes,
  }, {
    authority: 'Ministry of Finance',
    documentNumber: 'Ministerial Decision No. 229 of 2025',
    effectiveFrom: '2023-06-01',
    asOf: '2026-08-31',
    supersedes: 'Ministerial Decision No. 265 of 2023',
  });
  assert.match(md229.url, /^https:\/\/mof\.gov\.ae\//);
  assert.deepEqual({
    authority: md131.authority,
    documentNumber: md131.documentNumber,
    effectiveFrom: md131.effectiveFrom,
    asOf: md131.asOf,
    legalCommencement: md131.legalCommencement,
  }, {
    authority: 'Ministry of Finance',
    documentNumber: 'Ministerial Decision No. 131 of 2026',
    effectiveFrom: '2023-06-01',
    asOf: '2026-08-31',
    legalCommencement: 'day_after_official_gazette_publication',
  });
  assert.equal(guidance.authority, 'Federal Tax Authority');
  assert.equal(guidance.issuedOn, '2025-12-19');
  assert.equal(guidance.language, 'ar');
  assert.match(guidance.url, /^https:\/\/tax\.gov\.ae\//);
});

test('one invoice breaches de minimis and flips the current and exactly four following tax periods', async () => {
  const evaluation = evaluateAeCorporateTaxWorld(await loadWorld(CORPORATE_TAX_FIXTURE));
  assert.equal(evaluation.ok, true, JSON.stringify(evaluation.errors));
  assert.deepEqual(evaluation.periods.map(({ periodKey, qfzpStatus, breachPeriodKey, breachOffset }) => ({
    periodKey, qfzpStatus, breachPeriodKey, breachOffset,
  })), [
    { periodKey: '2025', qfzpStatus: 'qualifying_free_zone_person', breachPeriodKey: undefined, breachOffset: undefined },
    { periodKey: '2026', qfzpStatus: 'ceased_from_period_start', breachPeriodKey: '2026', breachOffset: 0 },
    { periodKey: '2027', qfzpStatus: 'not_qualifying_breach_carryforward', breachPeriodKey: '2026', breachOffset: 1 },
    { periodKey: '2028', qfzpStatus: 'not_qualifying_breach_carryforward', breachPeriodKey: '2026', breachOffset: 2 },
    { periodKey: '2029', qfzpStatus: 'not_qualifying_breach_carryforward', breachPeriodKey: '2026', breachOffset: 3 },
    { periodKey: '2030', qfzpStatus: 'not_qualifying_breach_carryforward', breachPeriodKey: '2026', breachOffset: 4 },
  ]);
  assert.deepEqual(evaluation.periods.slice(0, 2).map(({ periodKey, deMinimis }) => ({
    periodKey,
    total: deMinimis.totalRelevantRevenueAed,
    nonQualifying: deMinimis.nonQualifyingRevenueAed,
    threshold: deMinimis.thresholdAed,
    status: deMinimis.status,
  })), [
    { periodKey: '2025', total: '20000000.00', nonQualifying: '999999.99', threshold: '1000000.00', status: 'passed' },
    { periodKey: '2026', total: '20000000.00', nonQualifying: '1000000.01', threshold: '1000000.00', status: 'breached' },
  ]);
});

test('both de-minimis limbs preserve minus-one, exact inclusive, and plus-one fils boundaries', async () => {
  const world = await loadWorld(CORPORATE_TAX_FIXTURE);
  const cases = expandAeDeMinimisBoundarySets(world.deMinimisBoundarySets);
  assert.deepEqual(cases, [
    { caseId: 'aed_5_million_limb/minus_one_fils', lowerLimb: 'aed_5_million', totalRelevantRevenueAed: '120000000.00', thresholdAed: '5000000.00', nonQualifyingRevenueAed: '4999999.99', deltaFils: -1, status: 'passed', policySourceId: 'policy/ae-md229-2025' },
    { caseId: 'aed_5_million_limb/exact', lowerLimb: 'aed_5_million', totalRelevantRevenueAed: '120000000.00', thresholdAed: '5000000.00', nonQualifyingRevenueAed: '5000000.00', deltaFils: 0, status: 'passed', policySourceId: 'policy/ae-md229-2025' },
    { caseId: 'aed_5_million_limb/plus_one_fils', lowerLimb: 'aed_5_million', totalRelevantRevenueAed: '120000000.00', thresholdAed: '5000000.00', nonQualifyingRevenueAed: '5000000.01', deltaFils: 1, status: 'breached', policySourceId: 'policy/ae-md229-2025' },
    { caseId: 'five_percent_limb/minus_one_fils', lowerLimb: 'five_percent', totalRelevantRevenueAed: '20000000.00', thresholdAed: '1000000.00', nonQualifyingRevenueAed: '999999.99', deltaFils: -1, status: 'passed', policySourceId: 'policy/ae-md229-2025' },
    { caseId: 'five_percent_limb/exact', lowerLimb: 'five_percent', totalRelevantRevenueAed: '20000000.00', thresholdAed: '1000000.00', nonQualifyingRevenueAed: '1000000.00', deltaFils: 0, status: 'passed', policySourceId: 'policy/ae-md229-2025' },
    { caseId: 'five_percent_limb/plus_one_fils', lowerLimb: 'five_percent', totalRelevantRevenueAed: '20000000.00', thresholdAed: '1000000.00', nonQualifyingRevenueAed: '1000000.01', deltaFils: 1, status: 'breached', policySourceId: 'policy/ae-md229-2025' },
  ]);
  assert.deepEqual(evaluateAeCorporateTaxWorld(world).deMinimisBoundaryCases, cases);
});

test('related-party, mainland, and permanent-establishment income remain separate', async () => {
  const evaluation = evaluateAeCorporateTaxWorld(await loadWorld(CORPORATE_TAX_FIXTURE));
  const period2026 = evaluation.periods.find(({ periodKey }) => periodKey === '2026');
  assert.deepEqual(period2026.incomeByScope, {
    relatedPartyAed: '500000.00',
    mainlandAed: '19500000.00',
    domesticPermanentEstablishmentAed: '0.00',
    foreignPermanentEstablishmentAed: '250000.00',
  });
  assert.equal(period2026.deMinimis.totalRelevantRevenueAed, '20000000.00');
});

test('current MD 131 source keeps SBR available through 2029-12-31 and unavailable after the window', async () => {
  const evaluation = evaluateAeCorporateTaxWorld(await loadWorld(SBR_FIXTURE));
  assert.equal(evaluation.ok, true, JSON.stringify(evaluation.errors));
  assert.deepEqual(evaluation.smallBusinessReliefPeriods.map(({ periodKey, reliefStatus, effectiveWindowStatus, sourcePolicyId }) => ({
    periodKey, reliefStatus, effectiveWindowStatus, sourcePolicyId,
  })), [
    { periodKey: '2026-calendar', reliefStatus: 'available', effectiveWindowStatus: 'inside_current_window', sourcePolicyId: 'policy/ae-md131-2026' },
    { periodKey: '2029-calendar', reliefStatus: 'available', effectiveWindowStatus: 'inside_current_window', sourcePolicyId: 'policy/ae-md131-2026' },
    { periodKey: '2030-calendar', reliefStatus: 'not_available', effectiveWindowStatus: 'outside_current_window', sourcePolicyId: 'policy/ae-md131-2026' },
  ]);
});

test('CT/QFZP, VAT designated-zone status, and VAT goods treatment remain independent', async () => {
  const evaluation = evaluateAeCorporateTaxWorld(await loadWorld(CORPORATE_TAX_FIXTURE));
  const period2025 = evaluation.periods.find(({ periodKey }) => periodKey === '2025');
  const service = period2025.vatAxes.find(({ incomeFactId }) => incomeFactId === 'income/2025-related-hq');
  const goods = period2025.vatAxes.find(({ incomeFactId }) => incomeFactId === 'income/2025-distribution');
  assert.deepEqual(service, {
    incomeFactId: 'income/2025-related-hq',
    ctIncomeTreatment: 'qualifying',
    vatSupplyKind: 'service',
    vatDesignatedZoneStatus: 'designated',
    vatTreatment: 'normal_uae_vat_rules',
  });
  assert.deepEqual(goods, {
    incomeFactId: 'income/2025-distribution',
    ctIncomeTreatment: 'qualifying',
    vatSupplyKind: 'goods',
    vatDesignatedZoneStatus: 'designated',
    vatTreatment: 'designated_zone_goods_conditions_required',
  });
});

test('unknown judgment facts land explicitly on the owner without granting tax authority', async () => {
  const world = await loadWorld(CORPORATE_TAX_FIXTURE);
  world.corporateTaxPeriods[0].conditions.auditedFinancialStatements[0].status = 'unknown';
  const evaluation = evaluateAeCorporateTaxWorld(world);
  assert.equal(evaluation.ok, true, JSON.stringify(evaluation.errors));
  assert.deepEqual(evaluation.periods[0].terminalState, {
    state: 'blocked',
    responsibleActor: 'owner',
    missingFacts: ['auditedFinancialStatements'],
    nextPermittedAction: 'request_missing_tax_period_fact',
  });
  assert.equal(evaluation.periods[0].qfzpStatus, 'unassured');

  const relationshipUnknown = await loadWorld(CORPORATE_TAX_FIXTURE);
  relationshipUnknown.corporateTaxPeriods[0].incomeFacts[0].relatedParty.status = 'unknown';
  const relationshipEvaluation = evaluateAeCorporateTaxWorld(relationshipUnknown);
  assert.equal(relationshipEvaluation.ok, true, JSON.stringify(relationshipEvaluation.errors));
  assert.deepEqual(relationshipEvaluation.periods[0].terminalState.missingFacts, ['relatedParty']);
  assert.equal(relationshipEvaluation.periods[0].terminalState.responsibleActor, 'owner');
});

test('healthy consequences have paired mutations caught at their predeclared refusal checks', async () => {
  const mutationCertificates = [
    {
      name: 'missing period fact',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED,
      mutate: (world) => { delete world.corporateTaxPeriods[0].conditions.adequateSubstance; },
    },
    {
      name: 'conflicting period fact',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.PERIOD_FACT_CONFLICT,
      mutate: (world) => { world.corporateTaxPeriods[0].conditions.armLength.push(clone(world.corporateTaxPeriods[0].conditions.armLength[0])); },
    },
    {
      name: 'source-policy drift to superseded MD 265',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.SOURCE_POLICY_DRIFT,
      mutate: (world) => { world.policyBindings.qualifyingActivities = 'policy/ae-md265-2023'; },
    },
    {
      name: 'period tax outcome stored on entity profile',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.PROFILE_OUTCOME_FORBIDDEN,
      mutate: (world) => { world.entities[0].facts.corporateTaxOutcome = 'qfzp'; },
    },
    {
      name: 'QFZP inferred from free-zone label',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.QFZP_INFERENCE_FORBIDDEN,
      mutate: (world) => { world.corporateTaxPeriods[0].qfzpBasis = 'free_zone_label'; },
    },
    {
      name: 'excluded banking activity treated as qualifying',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.EXCLUDED_ACTIVITY_QUALIFYING,
      mutate: (world) => { world.corporateTaxPeriods[2].incomeFacts[0].activityKind = 'excluded_banking'; },
    },
    {
      name: 'unreceipted Article 19 owner election',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.ELECTION_RECEIPT_REQUIRED,
      mutate: (world) => { delete world.corporateTaxPeriods[0].conditions.ownerElection[0].receipt; },
    },
    {
      name: 'missing audit fact',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.AUDIT_FACT_REQUIRED,
      mutate: (world) => { delete world.corporateTaxPeriods[0].conditions.auditedFinancialStatements; },
    },
    {
      name: 'missing related-party fact',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.RELATED_PARTY_FACT_REQUIRED,
      mutate: (world) => { delete world.corporateTaxPeriods[0].incomeFacts[0].relatedParty; },
    },
    {
      name: 'related-party activity conflicts with an unrelated-party fact',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: 'AE_CT_RELATED_PARTY_FACT_CONFLICT',
      mutate: (world) => { world.corporateTaxPeriods[0].incomeFacts[1].relatedParty.status = 'not_related_party'; },
    },
    {
      name: 'de-minimis breach applied to one period',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.BREACH_HORIZON_INCOMPLETE,
      mutate: (world) => { world.breachConsequence.currentAndFollowingTaxPeriods = 1; },
    },
    {
      name: 'designated-zone goods treatment copied to a service',
      fixture: CORPORATE_TAX_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.VAT_AXIS_CONTAMINATION,
      mutate: (world) => { world.corporateTaxPeriods[0].incomeFacts[1].vat.treatmentBasis = 'designated_zone_goods_conditions_required'; },
    },
    {
      name: 'SBR current source regressed to the stale 2026 sunset source',
      fixture: SBR_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.SOURCE_POLICY_DRIFT,
      mutate: (world) => { world.policyBindings.smallBusinessReliefCurrent = 'policy/ae-md73-2023'; },
    },
    {
      name: 'unreceipted SBR election',
      fixture: SBR_FIXTURE,
      expectedCode: AE_CT_REFUSAL_CODES.ELECTION_RECEIPT_REQUIRED,
      mutate: (world) => { delete world.smallBusinessReliefPeriods[0].fact.electionReceipt; },
    },
  ];

  for (const certificate of mutationCertificates) {
    const world = await loadWorld(certificate.fixture);
    assert.equal(evaluateAeCorporateTaxWorld(world).ok, true, `${certificate.name}: healthy control`);
    certificate.mutate(world);
    const evaluation = evaluateAeCorporateTaxWorld(world);
    assert.equal(evaluation.ok, false, `${certificate.name}: mutation must refuse`);
    assert.ok(codes(evaluation).includes(certificate.expectedCode), `${certificate.name}: ${JSON.stringify(evaluation.errors)}`);
  }
});

test('fixture artifacts carry evidence rather than oracle judge labels', async () => {
  for (const filename of [CORPORATE_TAX_FIXTURE, SBR_FIXTURE]) {
    const world = await loadWorld(filename);
    const serializedArtifacts = JSON.stringify(world.artifacts);
    for (const forbidden of ['qfzpStatus', 'deMinimisStatus', 'corporateTaxOutcome', 'expectedOutcome', 'judgeLabel']) {
      assert.equal(serializedArtifacts.includes(forbidden), false, `${filename}: ${forbidden}`);
    }
  }
});

async function loadWorld(filename) {
  const url = new URL(`../../../data/worlds/ae/${filename}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

function codes(evaluation) {
  return evaluation.errors.map(({ code }) => code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
