import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AE_ENTITY_TAX_CONTEXT_VERSION,
  expandAeVatThresholdBoundarySet,
  validateAeEntityTaxContextWorld,
} from './aeEntityTaxContext.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const FIXTURES = Object.freeze({
  mainland: 'ae-entity-context-mainland.json',
  freeZoneService: 'ae-entity-context-free-zone-service.json',
  soleEstablishment: 'ae-entity-context-sole-establishment.json',
  designatedZoneGoods: 'ae-entity-context-designated-zone-goods.json',
  thresholdBoundaries: 'ae-vat-registration-threshold-boundaries.json',
});

test('AE-1 entity families compose through schema, causal validity, fact validation, and rendering', async () => {
  for (const [family, filename] of Object.entries(FIXTURES)) {
    const world = await loadWorld(filename);
    assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] }, family);
    assert.deepEqual(validateCausalWorld(world), {
      ok: true,
      version: 'proof0.validity.v1',
      errors: [],
    }, family);

    const facts = validateAeEntityTaxContextWorld(world);
    assert.equal(facts.ok, true, `${family}: ${JSON.stringify(facts.errors)}`);
    assert.equal(facts.version, AE_ENTITY_TAX_CONTEXT_VERSION);
    assert.equal(facts.contexts.length, 1);

    const rendered = await renderWorldArtifacts(world);
    assert.equal(rendered.ok, true, `${family}: ${JSON.stringify(rendered.errors)}`);
    assert.ok(rendered.artifacts.length >= 3);
    assert.ok(rendered.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  }
});

test('mainland, free-zone, designated-zone, and sole-establishment facts remain independent', async () => {
  const mainland = oneContext(validateAeEntityTaxContextWorld(await loadWorld(FIXTURES.mainland)));
  assert.equal(mainland.legalForm, 'ae-llc');
  assert.equal(mainland.freeZoneStanding.standing, 'mainland');
  assert.equal(mainland.designatedZone.status, 'not_designated');
  assert.equal(mainland.vatRegistration.status, 'registered');
  assert.equal(mainland.ftaVatPeriods[0].periodKey, '2026-Q3');
  assert.equal(mainland.ftaVatPeriods[0].dueOn, '2026-10-28');

  const freeZone = oneContext(validateAeEntityTaxContextWorld(await loadWorld(FIXTURES.freeZoneService)));
  assert.equal(freeZone.legalForm, 'ae-free-zone-co');
  assert.equal(freeZone.freeZoneStanding.standing, 'free_zone');
  assert.equal(freeZone.designatedZone.status, 'not_designated');
  assert.equal(freeZone.designatedZone.zoneName, 'Dubai Multi Commodities Centre');
  assert.ok(!Object.hasOwn(freeZone, 'isQfzp'));

  const designated = oneContext(validateAeEntityTaxContextWorld(await loadWorld(FIXTURES.designatedZoneGoods)));
  assert.equal(designated.freeZoneStanding.standing, 'free_zone');
  assert.equal(designated.designatedZone.status, 'designated');
  assert.equal(designated.designatedZone.zoneName, 'Jebel Ali Free Zone (North-South)');
  assert.ok(!Object.hasOwn(designated, 'qfzpStatus'));

  const sole = oneContext(validateAeEntityTaxContextWorld(await loadWorld(FIXTURES.soleEstablishment)));
  assert.equal(sole.legalForm, 'ae-sole-establishment');
  assert.equal(sole.vatRegistration.registrationSubject, 'natural_person_all_sole_establishments');
  assert.equal(sole.vatRegistration.registrationSubjectId, 'natural-person/salim-haddad');
  assert.equal(sole.vatRegistration.status, 'not_registered');
  assert.deepEqual(sole.ftaVatPeriods, []);
});

test('missing and conflated mainland/free-zone/designated-zone axes refuse by stable code', async () => {
  const source = await loadWorld(FIXTURES.mainland);

  const missingStanding = clone(source);
  delete missingStanding.entities[0].facts.freeZoneStanding;
  assert.ok(codes(missingStanding).includes('AE_FREE_ZONE_STANDING_REQUIRED'));

  const conflated = clone(source);
  conflated.entities[0].facts.freeZoneStanding[0].designatedZone = false;
  delete conflated.entities[0].facts.designatedZone;
  assert.ok(codes(conflated).includes('AE_DESIGNATED_ZONE_CONFLATED_WITH_STANDING'));
  assert.ok(codes(conflated).includes('AE_DESIGNATED_ZONE_REQUIRED'));

  const designatedMainland = clone(source);
  designatedMainland.entities[0].facts.designatedZone[0].status = 'designated';
  designatedMainland.entities[0].facts.designatedZone[0].zoneName = 'Jebel Ali Free Zone (North-South)';
  assert.ok(codes(designatedMainland).includes('AE_DESIGNATED_ZONE_REQUIRES_FREE_ZONE'));

  const contradictoryForm = clone(source);
  contradictoryForm.entities[0].facts.freeZoneStanding[0].standing = 'free_zone';
  assert.ok(codes(contradictoryForm).includes('AE_LEGAL_FORM_STANDING_CONFLICT'));

  const mismatchedManifest = clone(source);
  mismatchedManifest.manifest.entityType = 'ae-free-zone-co';
  assert.ok(codes(mismatchedManifest).includes('AE_MANIFEST_ENTITY_TYPE_MISMATCH'));
});

test('effective-dated facts reject overlaps, timeline gaps, and evidence not yet observed', async () => {
  const source = await loadWorld(FIXTURES.mainland);

  const overlap = clone(source);
  overlap.entities[0].facts.freeZoneStanding.push({
    ...overlap.entities[0].facts.freeZoneStanding[0],
    standing: 'free_zone',
    effectiveFrom: '2026-06-01',
  });
  assert.ok(codes(overlap).includes('AE_FREE_ZONE_STANDING_OVERLAP'));
  assert.ok(codes(overlap).includes('AE_FREE_ZONE_STANDING_NOT_EFFECTIVE'));

  const gap = clone(source);
  gap.entities[0].facts.designatedZone[0].effectiveTo = '2026-08-30';
  assert.ok(codes(gap).includes('AE_DESIGNATED_ZONE_NOT_EFFECTIVE'));

  const futureObservation = clone(source);
  const licenceObservation = futureObservation.observations.find(({ artifactId }) => artifactId === 'artifact/ae-mainland-trade-licence');
  licenceObservation.observedAt = '2026-09-01';
  assert.ok(codes(futureObservation).includes('AE_FACT_SOURCE_NOT_OBSERVED'));

  const preEntityDesignation = clone(source);
  preEntityDesignation.entities[0].facts.designatedZone[0].effectiveFrom = '2025-12-31';
  assert.ok(codes(preEntityDesignation).includes('AE_FACT_PRECEDES_ENTITY'));

  const impossibleCalendarDate = clone(source);
  impossibleCalendarDate.entities[0].facts.designatedZone[0].effectiveFrom = '2026-13-01';
  assert.ok(codes(impossibleCalendarDate).includes('AE_DESIGNATED_ZONE_REQUIRED_EFFECTIVE_FROM'));
});

test('VAT registration and exact FTA periods refuse incomplete or contradictory facts', async () => {
  const mainland = await loadWorld(FIXTURES.mainland);

  const missingTrn = clone(mainland);
  missingTrn.entities[0].facts.vatRegistration[0].trn = null;
  assert.ok(codes(missingTrn).includes('AE_VAT_TRN_REQUIRED'));

  const cadenceOnly = clone(mainland);
  cadenceOnly.entities[0].facts.ftaVatPeriods = [];
  assert.ok(codes(cadenceOnly).includes('AE_FTA_VAT_PERIOD_REQUIRED'));

  const outsideRegistration = clone(mainland);
  outsideRegistration.entities[0].facts.ftaVatPeriods[0].startsOn = '2025-07-01';
  outsideRegistration.entities[0].facts.ftaVatPeriods[0].endsOn = '2025-09-30';
  outsideRegistration.entities[0].facts.ftaVatPeriods[0].dueOn = '2025-10-28';
  assert.ok(codes(outsideRegistration).includes('AE_FTA_VAT_PERIOD_OUTSIDE_REGISTRATION'));

  const crossesDeregistration = clone(mainland);
  crossesDeregistration.entities[0].facts.vatRegistration[0].effectiveTo = '2026-08-31';
  assert.ok(codes(crossesDeregistration).includes('AE_FTA_VAT_PERIOD_OUTSIDE_REGISTRATION'));

  const overlappingPeriods = clone(mainland);
  overlappingPeriods.entities[0].facts.ftaVatPeriods.push({
    ...overlappingPeriods.entities[0].facts.ftaVatPeriods[0],
    periodKey: '2026-Q3-overlap',
    startsOn: '2026-09-01',
    endsOn: '2026-11-30',
    dueOn: '2026-12-28',
  });
  assert.ok(codes(overlappingPeriods).includes('AE_FTA_VAT_PERIOD_OVERLAP'));

  const sole = await loadWorld(FIXTURES.soleEstablishment);
  sole.entities[0].facts.vatRegistration[0].registrationSubject = 'legal_entity';
  sole.entities[0].facts.vatRegistration[0].registrationSubjectId = sole.entities[0].id;
  const soleCodes = codes(sole);
  assert.ok(soleCodes.includes('AE_SOLE_ESTABLISHMENT_AGGREGATION_REQUIRED'));
  assert.ok(soleCodes.includes('AE_SOLE_ESTABLISHMENT_OWNER_ID_REQUIRED'));
});

test('per-period tax outcomes are forbidden on the profile while owner elections remain facts', async () => {
  const world = await loadWorld(FIXTURES.freeZoneService);
  world.entities[0].facts.isQfzp = true;
  world.entities[0].facts.periodTax = {
    sbrEligible: true,
    deMinimisStatus: 'passed',
  };
  world.entities[0].facts.ownerElections = [{ kind: 'sbr', effectiveFrom: '2026-01-01' }];

  const result = validateAeEntityTaxContextWorld(world);
  assert.equal(result.ok, false);
  const forbidden = result.errors.filter(({ code }) => code === 'AE_PROFILE_PERIOD_OUTCOME_FORBIDDEN');
  assert.deepEqual(forbidden.map(({ path }) => path).sort(), [
    'entities.entity/ae-free-zone-service.facts.isQfzp',
    'entities.entity/ae-free-zone-service.facts.periodTax.deMinimisStatus',
    'entities.entity/ae-free-zone-service.facts.periodTax.sbrEligible',
  ]);
  assert.ok(!forbidden.some(({ path }) => path.includes('ownerElections')));
});

test('VAT threshold sensitivity pairs preserve exact fils for both statutory limbs without projecting outcomes', async () => {
  const world = await loadWorld(FIXTURES.thresholdBoundaries);
  const result = validateAeEntityTaxContextWorld(world);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.thresholdBoundaryCases, expandAeVatThresholdBoundarySet(world.thresholdBoundarySet));
  assert.deepEqual(result.thresholdBoundaryCases, [
    {caseId: 'preceding_12_months/minus_one_fils', limb: 'preceding_12_months', thresholdAed: '375000.00', amountAed: '374999.99', deltaFils: -1, policySourceId: 'policy/ae-vat-registration'},
    {caseId: 'preceding_12_months/exact', limb: 'preceding_12_months', thresholdAed: '375000.00', amountAed: '375000.00', deltaFils: 0, policySourceId: 'policy/ae-vat-registration'},
    {caseId: 'preceding_12_months/plus_one_fils', limb: 'preceding_12_months', thresholdAed: '375000.00', amountAed: '375000.01', deltaFils: 1, policySourceId: 'policy/ae-vat-registration'},
    {caseId: 'next_30_days/minus_one_fils', limb: 'next_30_days', thresholdAed: '375000.00', amountAed: '374999.99', deltaFils: -1, policySourceId: 'policy/ae-vat-registration'},
    {caseId: 'next_30_days/exact', limb: 'next_30_days', thresholdAed: '375000.00', amountAed: '375000.00', deltaFils: 0, policySourceId: 'policy/ae-vat-registration'},
    {caseId: 'next_30_days/plus_one_fils', limb: 'next_30_days', thresholdAed: '375000.00', amountAed: '375000.01', deltaFils: 1, policySourceId: 'policy/ae-vat-registration'},
  ]);
  assert.equal(new Set(result.thresholdBoundaryCases.map(({ caseId }) => caseId)).size, 6);
  assert.ok(result.thresholdBoundaryCases.every((entry) => !Object.hasOwn(entry, 'outcome')));
  assert.ok(result.thresholdBoundaryCases.every((entry) => !Object.hasOwn(entry, 'registrationRequired')));
});

test('threshold matrices reject missing boundaries, imprecise money, policy-less facts, and embedded outcomes', async () => {
  const source = await loadWorld(FIXTURES.thresholdBoundaries);

  const incomplete = clone(source);
  incomplete.thresholdBoundarySet.deltasFils = [-1, 1];
  assert.ok(codes(incomplete).includes('AE_VAT_THRESHOLD_BOUNDARIES_INCOMPLETE'));

  const imprecise = clone(source);
  imprecise.thresholdBoundarySet.thresholdAed = 375000;
  assert.ok(codes(imprecise).includes('AE_VAT_THRESHOLD_AMOUNT_INVALID'));

  const policyless = clone(source);
  policyless.thresholdBoundarySet.policySourceId = 'policy/missing';
  assert.ok(codes(policyless).includes('AE_VAT_THRESHOLD_POLICY_SOURCE_REQUIRED'));

  const outcome = clone(source);
  outcome.thresholdBoundarySet.registrationRequired = true;
  assert.ok(codes(outcome).includes('AE_VAT_THRESHOLD_OUTCOME_FORBIDDEN'));

  const profileThreshold = clone(source);
  profileThreshold.entities[0].facts.thresholdBoundarySet = clone(profileThreshold.thresholdBoundarySet);
  assert.ok(codes(profileThreshold).includes('AE_THRESHOLD_BOUNDARY_ON_PROFILE_FORBIDDEN'));
});

async function loadWorld(filename) {
  const url = new URL(`../../../data/worlds/ae/${filename}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

function oneContext(result) {
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.contexts.length, 1);
  return result.contexts[0];
}

function codes(world) {
  return validateAeEntityTaxContextWorld(world).errors.map(({ code }) => code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
