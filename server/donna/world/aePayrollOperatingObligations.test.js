import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AE_PAYROLL_OPERATING_REFUSALS,
  AE_PAYROLL_OPERATING_VERSION,
  evaluateAePayrollOperatingWorld,
} from './aePayrollOperatingObligations.js';
import { validateAskRecord } from './askContract.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const FIXTURES = Object.freeze({
  payroll: 'ae-payroll-obligations.json',
  operating: 'ae-operating-obligations.json',
});

test('AE-4 payroll and operating fixtures compose through the shared world, causal, and renderer contracts', async () => {
  for (const [family, filename] of Object.entries(FIXTURES)) {
    const world = await loadWorld(filename);
    assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] }, family);
    assert.deepEqual(validateCausalWorld(world), {
      ok: true,
      version: 'proof0.validity.v1',
      errors: [],
    }, family);

    const result = evaluateAePayrollOperatingWorld(world);
    assert.equal(result.ok, true, `${family}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.version, AE_PAYROLL_OPERATING_VERSION);
    assert.deepEqual(result.terminalInventory.limbo, []);

    const rendered = await renderWorldArtifacts(world);
    assert.equal(rendered.ok, true, `${family}: ${JSON.stringify(rendered.errors)}`);
    assert.equal(rendered.artifacts.length, world.artifacts.length);
    assert.ok(rendered.artifacts.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
  }
});

test('WPS payroll register, settled bank movement, deductions, and ledger expectations tie exactly', async () => {
  const result = evaluateAePayrollOperatingWorld(await loadWorld(FIXTURES.payroll));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.payrollBatches, [{
    batchId: 'payroll/2026-08',
    wpsBatchId: 'WPS-SYNTH-2026-08',
    instructionGenerated: true,
    paid: true,
    grossPayAed: '74000.00',
    employeeDeductionsAed: '4730.00',
    netPayAed: '69270.00',
    bankCreditAed: '69270.00',
    employerBenefitContributionsAed: '6729.60',
    bankLineId: 'bank-line/wps-2026-08',
    lines: [
      { employeeId: 'employee/expat-traditional', grossAed: '12000.00', deductionsAed: '0.00', netAed: '12000.00' },
      { employeeId: 'employee/expat-alternative', grossAed: '15000.00', deductionsAed: '0.00', netAed: '15000.00' },
      { employeeId: 'employee/uae-national', grossAed: '25000.00', deductionsAed: '2750.00', netAed: '22250.00' },
      { employeeId: 'employee/saudi-gcc', grossAed: '22000.00', deductionsAed: '1980.00', netAed: '20020.00' },
    ],
  }]);

  const instructionOnly = await loadWorld(FIXTURES.payroll);
  instructionOnly.aeObligationContract.payrollBatches[0].bankSettlement.amountAed = '0.00';
  const refused = evaluateAePayrollOperatingWorld(instructionOnly);
  assert.equal(refused.payrollBatches[0].instructionGenerated, true);
  assert.equal(refused.payrollBatches[0].paid, false);
  assert.ok(codes(refused).includes(AE_PAYROLL_OPERATING_REFUSALS.WPS_BATCH_TIE_FAILED));
});

test('employee class and effective scheme select one coherent statutory obligation', async () => {
  const result = evaluateAePayrollOperatingWorld(await loadWorld(FIXTURES.payroll));
  const obligations = new Map(result.employeeObligations.map((item) => [item.employeeId, item]));

  assert.deepEqual(obligations.get('employee/expat-traditional'), {
    employeeId: 'employee/expat-traditional',
    employeeClass: 'expatriate',
    schemeKind: 'traditional_gratuity',
    schemeId: 'AE/MOHRE/traditional-eosb',
    effectiveFrom: '2024-08-22',
    serviceDays: 730,
    unpaidLeaveDaysExcluded: 10,
    lastBasicWageAed: '12000.00',
    terminalGratuityAed: '16800.00',
    policySourceIds: ['policy/ae-labour-eosb'],
  });

  const alternative = obligations.get('employee/expat-alternative');
  assert.equal(alternative.schemeKind, 'alternative_savings');
  assert.equal(alternative.priorServiceTreatment, 'preserved_traditional_gratuity_at_enrolment_basic_wage');
  assert.equal(alternative.priorServiceCutoff, '2026-07-31');
  assert.equal(alternative.enrollmentBasicWageAed, '12000.00');
  assert.equal(alternative.traditionalAccrualAfterEnrollment, false);
  assert.equal(alternative.contributionDueRule, 'within_first_15_days_of_calendar_month');
  assert.equal(alternative.employerRatePercent, '8.33');
  assert.equal(alternative.employerContributionAed, '999.60');

  const uaeNational = obligations.get('employee/uae-national');
  assert.equal(uaeNational.schemeId, 'AE/GPSSA/Federal-Law-57-2023');
  assert.equal(uaeNational.employeeRatePercent, '11.00');
  assert.equal(uaeNational.employerRatePercent, '15.00');
  assert.equal(uaeNational.employeeContributionAed, '2750.00');
  assert.equal(uaeNational.employerContributionAed, '3750.00');
  assert.equal(uaeNational.contributionDueRule, 'by_15th_day');

  const gccNational = obligations.get('employee/saudi-gcc');
  assert.equal(gccNational.homeCountry, 'SA');
  assert.equal(gccNational.schemeId, 'SA/GOSI/private-sector');
  assert.equal(gccNational.employeeRatePercent, '9.00');
  assert.equal(gccNational.employerRatePercent, '9.00');
  assert.equal(gccNational.employeeContributionAed, '1980.00');
  assert.equal(gccNational.employerContributionAed, '1980.00');
  assert.equal(gccNational.contributionDueRule, 'by_15th_day');
});

test('joiner, leaver, unpaid leave, salary change, and closed-period boundary stay explicit', async () => {
  const result = evaluateAePayrollOperatingWorld(await loadWorld(FIXTURES.payroll));
  const employees = new Map(result.employees.map((item) => [item.employeeId, item]));
  assert.equal(employees.get('employee/uae-national').joinedOn, '2026-08-15');
  assert.equal(employees.get('employee/expat-traditional').leftOn, '2026-08-31');
  assert.equal(employees.get('employee/expat-traditional').unpaidLeaveDays, 10);
  assert.equal(employees.get('employee/expat-alternative').activeSalary.basicAed, '12000.00');
  assert.deepEqual(result.masterDataAdjustments, [{
    actionId: 'master-action/employee-2-salary',
    employeeId: 'employee/expat-alternative',
    effectiveFrom: '2026-07-15',
    recordedOn: '2026-08-05',
    closedPriorPeriodPreserved: true,
    action: 'post_dated_adjustment',
    postingDate: '2026-08-05',
  }]);

  const rewrite = await loadWorld(FIXTURES.payroll);
  rewrite.aeObligationContract.masterDataActions[0].action = 'rewrite_closed_period';
  rewrite.aeObligationContract.masterDataActions[0].postingDate = '2026-07-15';
  assert.ok(codes(evaluateAePayrollOperatingWorld(rewrite)).includes(AE_PAYROLL_OPERATING_REFUSALS.CLOSED_PERIOD_REWRITE_FORBIDDEN));
});

test('licences, permits, recoverable deposits, rent, and post-dated cheques remain separate obligations', async () => {
  const result = evaluateAePayrollOperatingWorld(await loadWorld(FIXTURES.operating));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const items = new Map(result.operatingObligations.map((item) => [item.itemId, item]));

  assert.deepEqual(items.get('operating/trade-licence-2026'), {
    itemId: 'operating/trade-licence-2026',
    kind: 'annual_trade_licence',
    expenseAed: '1000.00',
    prepaidAssetAed: '11000.00',
    chequeIssuedOn: null,
    bankSettledOn: '2026-08-02',
    bankLineId: 'bank-line/trade-licence-2026',
  });
  assert.deepEqual(items.get('operating/work-permit-2026'), {
    itemId: 'operating/work-permit-2026',
    kind: 'work_permit_and_deposit',
    expenseAed: '3000.00',
    assetAed: '5000.00',
    visaLifecycleIncluded: true,
    bankLineId: 'bank-line/work-permit-2026',
  });
  assert.deepEqual(items.get('operating/annual-rent-2026'), {
    itemId: 'operating/annual-rent-2026',
    kind: 'annual_rent',
    expenseAed: '10000.00',
    prepaidAssetAed: '110000.00',
    chequeIssuedOn: '2026-07-25',
    bankSettledOn: '2026-08-01',
    bankLineId: 'bank-line/rent-2026',
  });
});

test('all material families have discriminating one-fact siblings and every operating subfamily has a convergent temporal pair', async () => {
  const payroll = evaluateAePayrollOperatingWorld(await loadWorld(FIXTURES.payroll));
  const operating = evaluateAePayrollOperatingWorld(await loadWorld(FIXTURES.operating));
  const temporal = [...payroll.temporalPairs, ...operating.temporalPairs];
  const sensitivity = [...payroll.sensitivityPairs, ...operating.sensitivityPairs];
  const families = ['annual_rent_pdc', 'employee_benefits', 'licence_permit_deposit', 'wps_payroll'];

  assert.deepEqual([...new Set(temporal.map(({ family }) => family))].sort(), families);
  assert.equal(temporal.length, 5);
  assert.ok(temporal.every(({ converged }) => converged));
  assert.deepEqual(sensitivity.map(({ family }) => family).sort(), families);
  assert.ok(sensitivity.every(({ leftProjection, rightProjection }) => JSON.stringify(leftProjection) !== JSON.stringify(rightProjection)));

  const missingTemporal = await loadWorld(FIXTURES.payroll);
  missingTemporal.aeObligationContract.temporalPairs = missingTemporal.aeObligationContract.temporalPairs.filter(({ family }) => family !== 'employee_benefits');
  assert.ok(codes(evaluateAePayrollOperatingWorld(missingTemporal)).includes('AE_TEMPORAL_FAMILY_MISSING'));

  const missingSensitivity = await loadWorld(FIXTURES.operating);
  missingSensitivity.aeObligationContract.sensitivityPairs = missingSensitivity.aeObligationContract.sensitivityPairs.filter(({ family }) => family !== 'annual_rent_pdc');
  assert.ok(codes(evaluateAePayrollOperatingWorld(missingSensitivity)).includes('AE_SENSITIVITY_FAMILY_MISSING'));
});

test('all protected AE-4 mutations fail at their named checks', async () => {
  const payroll = await loadWorld(FIXTURES.payroll);
  const operating = await loadWorld(FIXTURES.operating);

  const wpsMismatch = clone(payroll);
  wpsMismatch.aeObligationContract.payrollBatches[0].wpsInstruction.batchId = 'WPS-SIBLING-WRONG';
  expectCode(wpsMismatch, AE_PAYROLL_OPERATING_REFUSALS.WPS_BATCH_TIE_FAILED);

  const observedBankMismatch = clone(payroll);
  const bankArtifact = observedBankMismatch.artifacts.find(({ id }) => id === 'artifact/bank-settlement-2026-08');
  bankArtifact.fields.batchId = 'WPS-SIBLING-WRONG';
  expectCode(observedBankMismatch, AE_PAYROLL_OPERATING_REFUSALS.WPS_BATCH_TIE_FAILED);

  const ambiguousClass = clone(payroll);
  ambiguousClass.aeObligationContract.employees[0].employeeClass = null;
  const ambiguousResult = expectCode(ambiguousClass, AE_PAYROLL_OPERATING_REFUSALS.EMPLOYEE_CLASS_AMBIGUOUS);
  assert.equal(ambiguousResult.ownerAsks.length, 1);
  assert.equal(validateAskRecord(ambiguousResult.ownerAsks[0]).ok, true);
  assert.deepEqual(ambiguousResult.terminalInventory.limbo, []);

  const swapped = clone(payroll);
  swapped.aeObligationContract.employees[0].benefitHistory[0].kind = 'home_country_pension';
  expectCode(swapped, AE_PAYROLL_OPERATING_REFUSALS.EXPAT_EOSB_GCC_PENSION_SWAPPED);

  const traditionalAfterEnrollment = clone(payroll);
  traditionalAfterEnrollment.aeObligationContract.payrollBatches[0].lines[1].schemeKind = 'traditional_gratuity';
  expectCode(traditionalAfterEnrollment, AE_PAYROLL_OPERATING_REFUSALS.TRADITIONAL_EOSB_AFTER_ALTERNATIVE_ENROLLMENT);

  const missingSchemeEvidence = clone(payroll);
  delete missingSchemeEvidence.aeObligationContract.employees[1].benefitHistory[1].schemeId;
  const missingSchemeResult = expectCode(missingSchemeEvidence, AE_PAYROLL_OPERATING_REFUSALS.SCHEME_EFFECTIVE_EVIDENCE_REQUIRED);
  assert.equal(missingSchemeResult.ownerAsks.length, 1);
  assert.equal(validateAskRecord(missingSchemeResult.ownerAsks[0]).ok, true);

  const depositExpensed = clone(operating);
  depositExpensed.aeObligationContract.operatingItems[1].depositCandidateAccount = 'expense.work_permit';
  expectCode(depositExpensed, AE_PAYROLL_OPERATING_REFUSALS.RECOVERABLE_DEPOSIT_EXPENSED);

  const rentExpensed = clone(operating);
  rentExpensed.aeObligationContract.operatingItems[2].monthOneExpenseAed = '120000.00';
  expectCode(rentExpensed, AE_PAYROLL_OPERATING_REFUSALS.ANNUAL_RENT_MONTH_ONE_EXPENSED);

  const chequeAsCash = clone(operating);
  chequeAsCash.aeObligationContract.operatingItems[2].postDatedCheque.cashEffectOnIssueAed = '120000.00';
  expectCode(chequeAsCash, AE_PAYROLL_OPERATING_REFUSALS.PDC_ISSUE_TREATED_AS_CASH);

  const duplicatedAfterReversal = clone(operating);
  duplicatedAfterReversal.aeObligationContract.temporalPairs[2].cashFirst.push({
    kind: 'bank_settlement',
    ref: 'SYNTH-PDC-0001',
    bankLineId: 'bank-line/rent-2026',
  });
  expectCode(duplicatedAfterReversal, AE_PAYROLL_OPERATING_REFUSALS.BANK_LINE_DUPLICATE_POSTING);
});

test('missing business facts rest on owner asks while known accounting rules are refused without punting', async () => {
  const payroll = await loadWorld(FIXTURES.payroll);
  payroll.aeObligationContract.employees[3].employeeClass = 'unknown';
  const missingFact = evaluateAePayrollOperatingWorld(payroll);
  assert.equal(missingFact.ownerAsks[0].fact_class, 'employee_class');
  assert.deepEqual(missingFact.terminalInventory.owner, [missingFact.ownerAsks[0].ask_id]);
  assert.deepEqual(missingFact.terminalInventory.limbo, []);

  const operating = await loadWorld(FIXTURES.operating);
  operating.aeObligationContract.operatingItems[1].depositCandidateAccount = 'expense.work_permit';
  operating.aeObligationContract.operatingItems[2].monthOneExpenseAed = '120000.00';
  const knownRules = evaluateAePayrollOperatingWorld(operating);
  assert.deepEqual(knownRules.ownerAsks, []);
  assert.deepEqual(knownRules.terminalInventory.owner, []);
  assert.deepEqual(knownRules.terminalInventory.limbo, []);
  assert.ok(knownRules.terminalInventory.autoResolved.some((id) => id.includes(AE_PAYROLL_OPERATING_REFUSALS.RECOVERABLE_DEPOSIT_EXPENSED)));
  assert.ok(knownRules.terminalInventory.autoResolved.some((id) => id.includes(AE_PAYROLL_OPERATING_REFUSALS.ANNUAL_RENT_MONTH_ONE_EXPENSED)));
});

test('statutory numbers and employee-class rules carry official effective-dated source receipts', async () => {
  const world = await loadWorld(FIXTURES.payroll);
  const sources = new Map(world.policySources.map((source) => [source.id, source]));
  assert.equal(sources.get('policy/ae-wps-resolution-598').effectiveFrom, '2022-11-25');
  assert.equal(sources.get('policy/ae-labour-eosb').effectiveFrom, '2022-02-02');
  assert.equal(sources.get('policy/ae-alternative-eosb-cabinet-96').effectiveFrom, '2023-10-14');
  assert.equal(sources.get('policy/ae-alternative-eosb-ministerial-668').effectiveFrom, '2023-10-25');
  assert.equal(sources.get('policy/ae-gpssa-law-57').effectiveFrom, '2023-10-31');
  assert.equal(sources.get('policy/ae-gpssa-gcc-extension').effectiveFrom, '2007-01-01');
  assert.ok(world.policySources.every(({ asOf }) => asOf === '2026-08-31'));
  assert.ok(world.policySources.every(({ url }) => new URL(url).protocol === 'https:'));

  assert.ok(sources.get('policy/ae-labour-eosb').verifiedRules.includes('21 days basic wage for each of first five years'));
  assert.ok(sources.get('policy/ae-labour-eosb').verifiedRules.includes('30 days basic wage for each later year'));
  assert.ok(sources.get('policy/ae-alternative-eosb-cabinet-96').verifiedRules.includes('5.83 percent through five years'));
  assert.ok(sources.get('policy/ae-alternative-eosb-cabinet-96').verifiedRules.includes('8.33 percent after five years'));
  assert.ok(sources.get('policy/ae-gpssa-law-57').verifiedRules.includes('employee 11 percent'));
  assert.ok(sources.get('policy/ae-gpssa-law-57').verifiedRules.includes('employer 15 percent'));
  assert.ok(sources.get('policy/ae-gpssa-gcc-extension').verifiedRules.includes('Saudi private-sector GOSI employee 9 percent'));
  assert.ok(sources.get('policy/ae-gpssa-gcc-extension').verifiedRules.includes('Saudi private-sector GOSI employer 9 percent'));
});

test('AE-4 evaluation is byte-stable across deterministic replay', async () => {
  for (const filename of Object.values(FIXTURES)) {
    const world = await loadWorld(filename);
    assert.equal(JSON.stringify(evaluateAePayrollOperatingWorld(world)), JSON.stringify(evaluateAePayrollOperatingWorld(clone(world))));
  }
});

async function loadWorld(filename) {
  const url = new URL(`../../../data/worlds/ae/${filename}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

function expectCode(world, code) {
  const result = evaluateAePayrollOperatingWorld(world);
  assert.equal(result.ok, false, `expected ${code}`);
  assert.ok(codes(result).includes(code), `${code}: ${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.terminalInventory.limbo, []);
  return result;
}

function codes(result) { return result.errors.map(({ code }) => code); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
