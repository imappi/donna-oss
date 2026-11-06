import { ASK_CONTRACT_VERSION, validateAskRecord } from './askContract.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';
import { utcIsoDay } from './utcDay.js';

export const AE_PAYROLL_OPERATING_VERSION = 'ae.payroll-operating-obligations.v1';

export const AE_PAYROLL_OPERATING_REFUSALS = Object.freeze({
  WPS_BATCH_TIE_FAILED: 'AE_WPS_BATCH_TIE_FAILED',
  EMPLOYEE_CLASS_AMBIGUOUS: 'AE_EMPLOYEE_CLASS_AMBIGUOUS',
  EXPAT_EOSB_GCC_PENSION_SWAPPED: 'AE_EXPAT_EOSB_GCC_PENSION_SWAPPED',
  TRADITIONAL_EOSB_AFTER_ALTERNATIVE_ENROLLMENT: 'AE_TRADITIONAL_EOSB_AFTER_ALTERNATIVE_ENROLLMENT',
  SCHEME_EFFECTIVE_EVIDENCE_REQUIRED: 'AE_SCHEME_EFFECTIVE_EVIDENCE_REQUIRED',
  RECOVERABLE_DEPOSIT_EXPENSED: 'AE_RECOVERABLE_DEPOSIT_EXPENSED',
  ANNUAL_RENT_MONTH_ONE_EXPENSED: 'AE_ANNUAL_RENT_MONTH_ONE_EXPENSED',
  PDC_ISSUE_TREATED_AS_CASH: 'AE_PDC_ISSUE_TREATED_AS_CASH',
  BANK_LINE_DUPLICATE_POSTING: 'AE_BANK_LINE_DUPLICATE_POSTING',
  CLOSED_PERIOD_REWRITE_FORBIDDEN: 'AE_CLOSED_PERIOD_REWRITE_FORBIDDEN',
});

const EMPLOYEE_CLASSES = new Set(['expatriate', 'uae_national', 'gcc_national']);
const GCC_NATIONALITIES = new Set(['BH', 'KW', 'OM', 'QA', 'SA']);
const MATERIAL_FAMILIES = new Set([
  'wps_payroll',
  'employee_benefits',
  'licence_permit_deposit',
  'annual_rent_pdc',
]);
const TEMPORAL_REQUIRED_KINDS = Object.freeze({
  wps_payroll: ['payroll_register', 'wps_instruction', 'bank_settlement'],
  employee_benefits: ['scheme_evidence', 'payroll_register', 'contribution_settlement'],
  licence_permit_deposit: ['obligation_document', 'bank_settlement', 'custody_asset'],
  annual_rent_pdc: ['lease_document', 'cheque_issue', 'bank_settlement', 'monthly_release'],
});
const REQUIRED_POLICY = Object.freeze({
  wps: 'policy/ae-wps-resolution-598',
  labourEosb: 'policy/ae-labour-eosb',
  alternativeCabinet: 'policy/ae-alternative-eosb-cabinet-96',
  alternativeMinisterial: 'policy/ae-alternative-eosb-ministerial-668',
  uaePension: 'policy/ae-gpssa-law-57',
  gccPension: 'policy/ae-gpssa-gcc-extension',
  accounting: 'policy/ifrs-conceptual-framework',
});
const ALLOWED_POLICY_HOSTS = new Set([
  'mohre.gov.ae',
  'www.mohre.gov.ae',
  'uaelegislation.gov.ae',
  'www.uaelegislation.gov.ae',
  'gpssa.gov.ae',
  'www.gpssa.gov.ae',
  'ifrs.org',
  'www.ifrs.org',
]);

export function evaluateAePayrollOperatingWorld(worldSpec) {
  const errors = [];
  const ownerAsks = [];
  const shape = validateWorldSpec(worldSpec);
  if (!shape.ok) {
    for (const message of shape.errors) addError(errors, 'AE_OBLIGATION_WORLD_SCHEMA_INVALID', 'worldSpec', message);
    return buildResult({ errors, ownerAsks });
  }
  const causal = validateCausalWorld(worldSpec);
  if (!causal.ok) {
    for (const message of causal.errors) addError(errors, 'AE_OBLIGATION_WORLD_CAUSAL_INVALID', 'worldSpec', message);
  }
  if (worldSpec.manifest.jurisdiction !== 'AE') {
    addError(errors, 'AE_OBLIGATION_JURISDICTION_REQUIRED', 'manifest.jurisdiction', 'AE obligations require jurisdiction AE.');
  }
  if (worldSpec.manifest.capabilityId !== 'model_ae_payroll_operating_obligations') {
    addError(errors, 'AE_OBLIGATION_CAPABILITY_REQUIRED', 'manifest.capabilityId', 'Expected model_ae_payroll_operating_obligations.');
  }

  const contract = worldSpec.aeObligationContract;
  if (!isObject(contract)) {
    addError(errors, 'AE_OBLIGATION_CONTRACT_REQUIRED', 'aeObligationContract', 'A payroll/operating obligation contract is required.');
    return buildResult({ errors, ownerAsks });
  }
  if (!isIsoDay(contract.closedThrough)) {
    addError(errors, 'AE_CLOSED_PERIOD_BOUNDARY_REQUIRED', 'aeObligationContract.closedThrough', 'closedThrough must be an ISO day.');
  }

  const evidence = buildEvidenceIndex(worldSpec, errors);
  const policySources = validatePolicySources(worldSpec, contract, errors);
  const employeeResult = evaluateEmployees({ worldSpec, contract, evidence, policySources, errors, ownerAsks });
  const payrollBatches = evaluatePayrollBatches({
    contract,
    employeeById: employeeResult.employeeById,
    employeeObligations: employeeResult.obligations,
    evidence,
    errors,
  });
  const masterDataAdjustments = evaluateMasterDataAdjustments({ contract, evidence, errors });
  const operatingObligations = evaluateOperatingItems({ contract, evidence, errors });
  const temporalPairs = evaluateTemporalPairs(contract.temporalPairs, errors);
  const sensitivityPairs = evaluateSensitivityPairs(contract.sensitivityPairs, errors);
  validateMaterialFamilyCoverage(worldSpec.manifest.requiredWorldFamilies, temporalPairs, sensitivityPairs, errors);

  for (const ask of ownerAsks) {
    const validation = validateAskRecord(ask);
    if (!validation.ok) {
      for (const message of validation.errors) addError(errors, 'AE_OWNER_ASK_INVALID', `ownerAsks.${ask.ask_id}`, message);
    }
  }

  const deterministicRefusals = errors
    .filter(({ code }) => !['AE_EMPLOYEE_CLASS_AMBIGUOUS', 'AE_SCHEME_EFFECTIVE_EVIDENCE_REQUIRED'].includes(code))
    .map(({ code, path }) => `refusal/${code}/${path}`);
  const autoResolved = [
    ...employeeResult.obligations.map(({ employeeId }) => `employee-obligation/${employeeId}`),
    ...payrollBatches.map(({ batchId }) => `payroll-batch/${batchId}`),
    ...operatingObligations.map(({ itemId }) => `operating-obligation/${itemId}`),
    ...deterministicRefusals,
  ].sort();
  const owner = ownerAsks.map(({ ask_id }) => ask_id).sort();

  return buildResult({
    errors,
    ownerAsks,
    employees: employeeResult.employees,
    employeeObligations: employeeResult.obligations,
    payrollBatches,
    masterDataAdjustments,
    operatingObligations,
    temporalPairs,
    sensitivityPairs,
    terminalInventory: { autoResolved, owner, limbo: [] },
  });
}

function evaluateEmployees({ worldSpec, contract, evidence, policySources, errors, ownerAsks }) {
  const employees = [];
  const obligations = [];
  const employeeById = new Map();
  const list = array(contract.employees);
  const ids = new Set();

  for (const [index, employee] of list.entries()) {
    const path = `aeObligationContract.employees[${index}]`;
    if (!isObject(employee) || !nonEmpty(employee.id)) {
      addError(errors, 'AE_EMPLOYEE_ID_REQUIRED', `${path}.id`, 'Employee id is required.');
      continue;
    }
    if (ids.has(employee.id)) {
      addError(errors, 'AE_EMPLOYEE_ID_DUPLICATED', `${path}.id`, 'Employee ids must be unique.');
      continue;
    }
    ids.add(employee.id);
    employeeById.set(employee.id, employee);

    if (!EMPLOYEE_CLASSES.has(employee.employeeClass)) {
      addError(errors, AE_PAYROLL_OPERATING_REFUSALS.EMPLOYEE_CLASS_AMBIGUOUS, `${path}.employeeClass`, 'Employee class must be expatriate, uae_national, or gcc_national.');
      addOwnerAsk(ownerAsks, {
        targetId: employee.id,
        factClass: 'employee_class',
        obligations: [`employee-obligation/${employee.id}`],
        hypotheses: ['expatriate', 'uae_national', 'gcc_national'],
        evidenceChecked: array(employee.evidenceAlreadyChecked),
        answerType: 'employee_class_with_nationality_evidence',
      });
      continue;
    }
    const classArtifact = requireEvidence(employee.classSourceArtifactId, `${path}.classSourceArtifactId`, evidence, errors, 'AE_EMPLOYEE_CLASS_EVIDENCE_REQUIRED');
    if (classArtifact && !employeeClassMatchesNationality(employee.employeeClass, classArtifact.fields?.nationality)) {
      addError(errors, AE_PAYROLL_OPERATING_REFUSALS.EMPLOYEE_CLASS_AMBIGUOUS, `${path}.employeeClass`, 'Employee class conflicts with the observed nationality evidence.');
      addOwnerAsk(ownerAsks, {
        targetId: employee.id,
        factClass: 'employee_class',
        obligations: [`employee-obligation/${employee.id}`],
        hypotheses: ['expatriate', 'uae_national', 'gcc_national'],
        evidenceChecked: array(employee.evidenceAlreadyChecked),
        answerType: 'employee_class_with_nationality_evidence',
      });
      continue;
    }
    if (!isIsoDay(employee.joinedOn) || (employee.leftOn !== null && !isIsoDay(employee.leftOn))) {
      addError(errors, 'AE_EMPLOYMENT_DATES_REQUIRED', path, 'joinedOn and optional leftOn must be ISO days.');
      continue;
    }
    if (isIsoDay(employee.leftOn) && employee.leftOn < employee.joinedOn) {
      addError(errors, 'AE_EMPLOYMENT_DATES_INVALID', `${path}.leftOn`, 'leftOn cannot precede joinedOn.');
    }
    if (classArtifact && !employeeMasterEvidenceMatches(employee, classArtifact.fields)) {
      addError(errors, 'AE_EMPLOYEE_MASTER_EVIDENCE_MISMATCH', path, 'Employee identity and employment boundary dates must match the observed master record.');
      continue;
    }
    const activeSalary = activeTimelineRecord(employee.salaryHistory, worldSpec.effectiveDate, `${path}.salaryHistory`, errors);
    if (!activeSalary) continue;
    const salaryArtifact = requireEvidence(activeSalary.sourceArtifactId, `${path}.salaryHistory.sourceArtifactId`, evidence, errors, 'AE_SALARY_EVIDENCE_REQUIRED');
    if (toFils(activeSalary.basicAed) === null || toFils(activeSalary.grossAed) === null) {
      addError(errors, 'AE_SALARY_AMOUNT_INVALID', `${path}.salaryHistory`, 'Salary money values require exact AED strings with two decimals.');
      continue;
    }
    if (salaryArtifact && !salaryEvidenceMatches(employee.id, activeSalary, salaryArtifact.fields)) {
      addError(errors, 'AE_SALARY_EVIDENCE_MISMATCH', `${path}.salaryHistory`, 'Active salary identity, amount, and effective date must match the observed source artifact.');
      continue;
    }
    validateUnpaidLeaveEvidence(employee, path, evidence, errors);

    const benefitHistory = array(employee.benefitHistory);
    const activeBenefit = activeTimelineRecord(benefitHistory, worldSpec.effectiveDate, `${path}.benefitHistory`, errors, { allowEmpty: true });
    const obligation = evaluateEmployeeBenefit({
      employee,
      activeSalary,
      activeBenefit,
      benefitHistory,
      worldSpec,
      path,
      evidence,
      policySources,
      errors,
      ownerAsks,
    });
    if (obligation) obligations.push(obligation);
    employees.push({
      employeeId: employee.id,
      employeeClass: employee.employeeClass,
      joinedOn: employee.joinedOn,
      leftOn: employee.leftOn,
      activeSalary: clone(activeSalary),
      unpaidLeaveDays: countUnpaidLeaveDays(employee.unpaidLeave, errors, `${path}.unpaidLeave`),
    });
  }
  return { employees, obligations, employeeById };
}

function evaluateEmployeeBenefit({
  employee,
  activeSalary,
  activeBenefit,
  benefitHistory,
  worldSpec,
  path,
  evidence,
  policySources,
  errors,
  ownerAsks,
}) {
  if (!activeBenefit || !nonEmpty(activeBenefit.kind) || !nonEmpty(activeBenefit.schemeId) || !isIsoDay(activeBenefit.effectiveFrom)) {
    addError(errors, AE_PAYROLL_OPERATING_REFUSALS.SCHEME_EFFECTIVE_EVIDENCE_REQUIRED, `${path}.benefitHistory`, 'Active scheme identity and effective-date evidence are required.');
    addOwnerAsk(ownerAsks, {
      targetId: employee.id,
      factClass: 'active_benefit_scheme_and_effective_date',
      obligations: [`employee-obligation/${employee.id}`],
      hypotheses: benefitHypotheses(employee.employeeClass),
      evidenceChecked: array(employee.evidenceAlreadyChecked),
      answerType: 'scheme_identifier_and_effective_date',
    });
    return null;
  }
  const schemeArtifact = requireEvidence(activeBenefit.sourceArtifactId, `${path}.benefitHistory.sourceArtifactId`, evidence, errors, AE_PAYROLL_OPERATING_REFUSALS.SCHEME_EFFECTIVE_EVIDENCE_REQUIRED);
  if (schemeArtifact && !schemeEvidenceMatches(activeBenefit, employee.id, schemeArtifact.fields)) {
    addError(errors, AE_PAYROLL_OPERATING_REFUSALS.SCHEME_EFFECTIVE_EVIDENCE_REQUIRED, `${path}.benefitHistory`, 'Active scheme identity or effective date does not match the observed scheme evidence.');
    addOwnerAsk(ownerAsks, {
      targetId: employee.id,
      factClass: 'active_benefit_scheme_and_effective_date',
      obligations: [`employee-obligation/${employee.id}`],
      hypotheses: benefitHypotheses(employee.employeeClass),
      evidenceChecked: array(employee.evidenceAlreadyChecked),
      answerType: 'scheme_identifier_and_effective_date',
    });
    return null;
  }

  const classScheme = `${employee.employeeClass}:${activeBenefit.kind}`;
  if (classScheme === 'expatriate:home_country_pension' || classScheme === 'gcc_national:traditional_gratuity') {
    addError(errors, AE_PAYROLL_OPERATING_REFUSALS.EXPAT_EOSB_GCC_PENSION_SWAPPED, `${path}.benefitHistory`, 'Expatriate EOSB and GCC home-country pension cannot be swapped.');
  }

  if (employee.employeeClass === 'expatriate') {
    requirePolicy(policySources, REQUIRED_POLICY.labourEosb, `${path}.benefitHistory`, errors);
    if (!['traditional_gratuity', 'alternative_savings'].includes(activeBenefit.kind)) {
      addError(errors, AE_PAYROLL_OPERATING_REFUSALS.SCHEME_EFFECTIVE_EVIDENCE_REQUIRED, `${path}.benefitHistory`, 'An expatriate requires traditional gratuity or effective alternative-savings enrollment.');
      return null;
    }
    if (activeBenefit.kind === 'alternative_savings') {
      requirePolicy(policySources, REQUIRED_POLICY.alternativeCabinet, `${path}.benefitHistory`, errors);
      requirePolicy(policySources, REQUIRED_POLICY.alternativeMinisterial, `${path}.benefitHistory`, errors);
      if (activeBenefit.priorServiceTreatment !== 'preserved_traditional_gratuity_at_enrolment_basic_wage') {
        addError(errors, 'AE_ALTERNATIVE_PRIOR_SERVICE_TREATMENT_REQUIRED', `${path}.benefitHistory`, 'Prior service must remain a preserved traditional gratuity measured at the enrollment basic wage.');
      }
      if (activeBenefit.priorServiceCutoff !== addDays(activeBenefit.effectiveFrom, -1)
        || toFils(activeBenefit.enrollmentBasicWageAed) === null) {
        addError(errors, 'AE_ALTERNATIVE_TRANSITION_EVIDENCE_REQUIRED', `${path}.benefitHistory`, 'Alternative enrollment requires the prior-service cutoff and enrollment basic wage.');
      }
      const overlappingTraditional = benefitHistory.some((record) => record?.kind === 'traditional_gratuity'
        && rangesOverlap(record.effectiveFrom, record.effectiveTo, activeBenefit.effectiveFrom, activeBenefit.effectiveTo));
      if (overlappingTraditional) {
        addError(errors, AE_PAYROLL_OPERATING_REFUSALS.TRADITIONAL_EOSB_AFTER_ALTERNATIVE_ENROLLMENT, `${path}.benefitHistory`, 'Traditional gratuity cannot continue accruing after alternative-scheme enrollment becomes effective.');
      }
      const rateBasisPoints = hasExceededYears(employee.joinedOn, worldSpec.effectiveDate, 5) ? 833 : 583;
      return {
        employeeId: employee.id,
        employeeClass: employee.employeeClass,
        schemeKind: activeBenefit.kind,
        schemeId: activeBenefit.schemeId,
        effectiveFrom: activeBenefit.effectiveFrom,
        priorServiceTreatment: activeBenefit.priorServiceTreatment,
        priorServiceCutoff: activeBenefit.priorServiceCutoff,
        enrollmentBasicWageAed: activeBenefit.enrollmentBasicWageAed,
        traditionalAccrualAfterEnrollment: false,
        contributionBasisAed: activeSalary.basicAed,
        contributionDueRule: 'within_first_15_days_of_calendar_month',
        employerRatePercent: rateBasisPoints === 833 ? '8.33' : '5.83',
        employeeRatePercent: '0.00',
        employerContributionAed: formatFils(percentOf(toFils(activeSalary.basicAed), rateBasisPoints)),
        employeeContributionAed: '0.00',
        policySourceIds: [REQUIRED_POLICY.labourEosb, REQUIRED_POLICY.alternativeCabinet, REQUIRED_POLICY.alternativeMinisterial],
      };
    }
    const excludedDays = countUnpaidLeaveDays(employee.unpaidLeave, errors, `${path}.unpaidLeave`);
    const serviceDays = isIsoDay(employee.leftOn)
      ? Math.max(0, daysBetween(employee.joinedOn, addDays(employee.leftOn, 1)) - excludedDays)
      : Math.max(0, daysBetween(employee.joinedOn, addDays(worldSpec.effectiveDate, 1)) - excludedDays);
    const serviceYears = serviceDays / 365;
    const dailyBasicFils = toFils(activeSalary.basicAed) / 30;
    const firstFiveYears = Math.min(serviceYears, 5);
    const laterYears = Math.max(serviceYears - 5, 0);
    const gratuityFils = Math.round((dailyBasicFils * 21 * firstFiveYears) + (dailyBasicFils * 30 * laterYears));
    return {
      employeeId: employee.id,
      employeeClass: employee.employeeClass,
      schemeKind: activeBenefit.kind,
      schemeId: activeBenefit.schemeId,
      effectiveFrom: activeBenefit.effectiveFrom,
      serviceDays,
      unpaidLeaveDaysExcluded: excludedDays,
      lastBasicWageAed: activeSalary.basicAed,
      terminalGratuityAed: serviceDays >= 365 ? formatFils(gratuityFils) : '0.00',
      policySourceIds: [REQUIRED_POLICY.labourEosb],
    };
  }

  if (employee.employeeClass === 'uae_national') {
    requirePolicy(policySources, REQUIRED_POLICY.uaePension, `${path}.benefitHistory`, errors);
    if (activeBenefit.kind !== 'uae_pension' || activeBenefit.schemeId !== 'AE/GPSSA/Federal-Law-57-2023'
      || !isIsoDay(activeBenefit.firstFederalPensionEmploymentOn)) {
      addError(errors, AE_PAYROLL_OPERATING_REFUSALS.SCHEME_EFFECTIVE_EVIDENCE_REQUIRED, `${path}.benefitHistory`, 'UAE-national pension cohort and exact scheme evidence are required.');
      return null;
    }
    if (activeBenefit.firstFederalPensionEmploymentOn < '2023-10-31') {
      addError(errors, 'AE_GPSSA_LAW_57_COHORT_INVALID', `${path}.benefitHistory.firstFederalPensionEmploymentOn`, 'Law 57 is not inferred for a pre-31 October 2023 GPSSA cohort.');
    }
    const basisFils = toFils(activeBenefit.contributionSalaryAed);
    if (basisFils === null || basisFils < toFils('3000.00') || basisFils > toFils('70000.00')) {
      addError(errors, 'AE_GPSSA_CONTRIBUTION_SALARY_OUT_OF_RANGE', `${path}.benefitHistory.contributionSalaryAed`, 'Law 57 private-sector contribution salary must be AED 3,000-70,000.');
      return null;
    }
    return {
      employeeId: employee.id,
      employeeClass: employee.employeeClass,
      schemeKind: activeBenefit.kind,
      schemeId: activeBenefit.schemeId,
      effectiveFrom: activeBenefit.effectiveFrom,
      contributionBasisAed: activeBenefit.contributionSalaryAed,
      employerRatePercent: '15.00',
      employeeRatePercent: '11.00',
      contributionDueRule: 'by_15th_day',
      governmentSupportRatePercent: basisFils < toFils('20000.00') ? '2.50' : '0.00',
      employerContributionAed: formatFils(percentOf(basisFils, 1500)),
      employeeContributionAed: formatFils(percentOf(basisFils, 1100)),
      policySourceIds: [REQUIRED_POLICY.uaePension],
    };
  }

  requirePolicy(policySources, REQUIRED_POLICY.gccPension, `${path}.benefitHistory`, errors);
  if (activeBenefit.kind !== 'home_country_pension' || activeBenefit.homeCountry !== 'SA'
    || activeBenefit.schemeId !== 'SA/GOSI/private-sector') {
    addError(errors, AE_PAYROLL_OPERATING_REFUSALS.SCHEME_EFFECTIVE_EVIDENCE_REQUIRED, `${path}.benefitHistory`, 'The GCC national home-country scheme identity must be retained.');
    return null;
  }
  const basisFils = toFils(activeBenefit.contributionSalaryAed);
  if (basisFils === null) {
    addError(errors, 'AE_GCC_CONTRIBUTION_SALARY_INVALID', `${path}.benefitHistory.contributionSalaryAed`, 'The home-country contribution basis must be exact AED money.');
    return null;
  }
  return {
    employeeId: employee.id,
    employeeClass: employee.employeeClass,
    homeCountry: activeBenefit.homeCountry,
    schemeKind: activeBenefit.kind,
    schemeId: activeBenefit.schemeId,
    effectiveFrom: activeBenefit.effectiveFrom,
    contributionBasisAed: activeBenefit.contributionSalaryAed,
    employerRatePercent: '9.00',
    employeeRatePercent: '9.00',
    contributionDueRule: 'by_15th_day',
    employerContributionAed: formatFils(percentOf(basisFils, 900)),
    employeeContributionAed: formatFils(percentOf(basisFils, 900)),
    policySourceIds: [REQUIRED_POLICY.gccPension],
  };
}

function evaluatePayrollBatches({ contract, employeeById, employeeObligations, evidence, errors }) {
  const outputs = [];
  const obligationByEmployee = new Map(employeeObligations.map((item) => [item.employeeId, item]));
  for (const [index, batch] of array(contract.payrollBatches).entries()) {
    const path = `aeObligationContract.payrollBatches[${index}]`;
    const registerArtifact = requireEvidence(batch?.payrollRegisterArtifactId, `${path}.payrollRegisterArtifactId`, evidence, errors, 'AE_PAYROLL_REGISTER_EVIDENCE_REQUIRED');
    const instructionArtifact = requireEvidence(batch?.wpsInstructionArtifactId, `${path}.wpsInstructionArtifactId`, evidence, errors, 'AE_WPS_INSTRUCTION_EVIDENCE_REQUIRED');
    const bankArtifact = requireEvidence(batch?.bankSettlementArtifactId, `${path}.bankSettlementArtifactId`, evidence, errors, 'AE_WPS_BANK_SETTLEMENT_EVIDENCE_REQUIRED');
    const lines = array(batch?.lines);
    let grossFils = 0;
    let deductionsFils = 0;
    let netFils = 0;
    let employerBenefitFils = 0;
    const lineReceipts = [];
    for (const [lineIndex, line] of lines.entries()) {
      const linePath = `${path}.lines[${lineIndex}]`;
      const employee = employeeById.get(line?.employeeId);
      if (!employee) {
        addError(errors, 'AE_PAYROLL_EMPLOYEE_UNKNOWN', `${linePath}.employeeId`, 'Payroll line must reference a declared employee.');
        continue;
      }
      const amounts = ['grossAed', 'employeeDeductionsAed', 'netAed'].map((field) => toFils(line[field]));
      if (amounts.some((value) => value === null)) {
        addError(errors, 'AE_PAYROLL_LINE_AMOUNT_INVALID', linePath, 'Payroll line money must be exact AED strings.');
        continue;
      }
      const [lineGross, lineDeductions, lineNet] = amounts;
      if (lineGross - lineDeductions !== lineNet) {
        addError(errors, AE_PAYROLL_OPERATING_REFUSALS.WPS_BATCH_TIE_FAILED, linePath, 'Payroll gross less deductions must equal net.');
      }
      const obligation = obligationByEmployee.get(line.employeeId);
      if (obligation) {
        if (line.schemeKind !== obligation.schemeKind) {
          const code = obligation.schemeKind === 'alternative_savings' && line.schemeKind === 'traditional_gratuity'
            ? AE_PAYROLL_OPERATING_REFUSALS.TRADITIONAL_EOSB_AFTER_ALTERNATIVE_ENROLLMENT
            : AE_PAYROLL_OPERATING_REFUSALS.EXPAT_EOSB_GCC_PENSION_SWAPPED;
          addError(errors, code, `${linePath}.schemeKind`, 'Payroll benefit lane must match the effective employee scheme.');
        }
        if (toFils(line.employeeDeductionsAed) !== toFils(obligation.employeeContributionAed ?? '0.00')) {
          addError(errors, AE_PAYROLL_OPERATING_REFUSALS.WPS_BATCH_TIE_FAILED, `${linePath}.employeeDeductionsAed`, 'Payroll deduction must equal the active scheme employee contribution.');
        }
        employerBenefitFils += toFils(obligation.employerContributionAed ?? '0.00') ?? 0;
      }
      grossFils += lineGross;
      deductionsFils += lineDeductions;
      netFils += lineNet;
      lineReceipts.push({ employeeId: line.employeeId, grossAed: line.grossAed, deductionsAed: line.employeeDeductionsAed, netAed: line.netAed });
    }
    if (batch?.wpsInstruction?.batchId !== batch?.wpsBatchId
      || batch?.bankSettlement?.batchId !== batch?.wpsBatchId
      || toFils(batch?.wpsInstruction?.amountAed) !== netFils
      || toFils(batch?.bankSettlement?.amountAed) !== netFils) {
      addError(errors, AE_PAYROLL_OPERATING_REFUSALS.WPS_BATCH_TIE_FAILED, path, 'WPS instruction and settled bank movement must tie to the payroll batch net.');
    }
    if (!payrollEvidenceTies({ batch, registerArtifact, instructionArtifact, bankArtifact, grossFils, deductionsFils, netFils })) {
      addError(errors, AE_PAYROLL_OPERATING_REFUSALS.WPS_BATCH_TIE_FAILED, path, 'Observed payroll register, WPS instruction, and bank evidence must carry the same batch identity and exact amounts.');
    }
    const wageDebit = ledgerRoleTotal(batch?.wageLedger?.debits, 'expense.payroll');
    const wageBankCredit = ledgerRoleTotal(batch?.wageLedger?.credits, 'asset.bank');
    const wageDeductionCredit = ledgerRoleTotal(batch?.wageLedger?.credits, 'liability.employee_social_security');
    if (wageDebit !== grossFils || wageBankCredit !== netFils || wageDeductionCredit !== deductionsFils
      || ledgerTotal(batch?.wageLedger?.debits) !== ledgerTotal(batch?.wageLedger?.credits)) {
      addError(errors, AE_PAYROLL_OPERATING_REFUSALS.WPS_BATCH_TIE_FAILED, `${path}.wageLedger`, 'Payroll, bank and wage-ledger expectations must tie exactly.');
    }
    if (ledgerTotal(batch?.benefitLedger?.debits) !== employerBenefitFils
      || ledgerTotal(batch?.benefitLedger?.credits) !== employerBenefitFils
      || ledgerTotal(batch?.benefitLedger?.debits) !== ledgerTotal(batch?.benefitLedger?.credits)) {
      addError(errors, 'AE_BENEFIT_LEDGER_TIE_FAILED', `${path}.benefitLedger`, 'Employer benefit expense and scheme liabilities must tie exactly.');
    }
    outputs.push({
      batchId: batch?.id,
      wpsBatchId: batch?.wpsBatchId,
      instructionGenerated: true,
      paid: toFils(batch?.bankSettlement?.amountAed) === netFils,
      grossPayAed: formatFils(grossFils),
      employeeDeductionsAed: formatFils(deductionsFils),
      netPayAed: formatFils(netFils),
      bankCreditAed: formatFils(wageBankCredit ?? 0),
      employerBenefitContributionsAed: formatFils(employerBenefitFils),
      bankLineId: batch?.bankSettlement?.bankLineId,
      lines: lineReceipts,
    });
  }
  return outputs;
}

function evaluateMasterDataAdjustments({ contract, evidence, errors }) {
  const outputs = [];
  for (const [index, action] of array(contract.masterDataActions).entries()) {
    const path = `aeObligationContract.masterDataActions[${index}]`;
    if (!isIsoDay(action?.effectiveFrom) || !isIsoDay(action?.recordedOn)) {
      addError(errors, 'AE_MASTER_DATA_DATES_REQUIRED', path, 'Master-data action dates must be ISO days.');
      continue;
    }
    const artifact = requireEvidence(action.sourceArtifactId, `${path}.sourceArtifactId`, evidence, errors, 'AE_MASTER_DATA_EVIDENCE_REQUIRED');
    if (artifact && (artifact.fields?.employeeId !== action.employeeId
      || artifact.fields?.effectiveFrom !== action.effectiveFrom
      || artifact.fields?.recordedOn !== action.recordedOn)) {
      addError(errors, 'AE_MASTER_DATA_EVIDENCE_MISMATCH', path, 'Master-data action identity and boundary dates must match the observed source artifact.');
      continue;
    }
    const lateClosedFact = action.effectiveFrom <= contract.closedThrough && action.recordedOn > contract.closedThrough;
    if (lateClosedFact && (action.action !== 'post_dated_adjustment' || !isIsoDay(action.postingDate) || action.postingDate <= contract.closedThrough)) {
      addError(errors, AE_PAYROLL_OPERATING_REFUSALS.CLOSED_PERIOD_REWRITE_FORBIDDEN, path, 'A late master-data fact cannot silently rewrite a closed prior period.');
      continue;
    }
    outputs.push({
      actionId: action.id,
      employeeId: action.employeeId,
      effectiveFrom: action.effectiveFrom,
      recordedOn: action.recordedOn,
      closedPriorPeriodPreserved: !lateClosedFact || action.action === 'post_dated_adjustment',
      action: lateClosedFact ? 'post_dated_adjustment' : action.action,
      postingDate: lateClosedFact ? action.postingDate : null,
    });
  }
  return outputs;
}

function evaluateOperatingItems({ contract, evidence, errors }) {
  const outputs = [];
  const bankLineIds = new Set();
  for (const [index, item] of array(contract.operatingItems).entries()) {
    const path = `aeObligationContract.operatingItems[${index}]`;
    const sourceArtifact = requireEvidence(item?.sourceArtifactId, `${path}.sourceArtifactId`, evidence, errors, 'AE_OPERATING_OBLIGATION_EVIDENCE_REQUIRED');
    const amountFils = toFils(item?.amountAed);
    if (amountFils === null) {
      addError(errors, 'AE_OPERATING_AMOUNT_INVALID', `${path}.amountAed`, 'Operating obligation amount must be exact AED money.');
      continue;
    }
    if (item.kind === 'work_permit_and_deposit') {
      const feeFils = toFils(item.permitFeeAed);
      const depositFils = toFils(item.recoverableDepositAed);
      if (feeFils === null || depositFils === null || feeFils + depositFils !== amountFils) {
        addError(errors, 'AE_PERMIT_DEPOSIT_TIE_FAILED', path, 'Permit fee plus recoverable deposit must equal the obligation amount.');
      }
      if (item.depositCandidateAccount !== 'asset.recoverable_deposit') {
        addError(errors, AE_PAYROLL_OPERATING_REFUSALS.RECOVERABLE_DEPOSIT_EXPENSED, `${path}.depositCandidateAccount`, 'A recoverable deposit remains a balance-sheet asset until valid release or forfeiture evidence.');
      }
      if (item.depositRefundable !== true) addError(errors, 'AE_RECOVERABLE_DEPOSIT_FACT_REQUIRED', `${path}.depositRefundable`, 'The recoverable-deposit fact must be explicit.');
      if (sourceArtifact && (sourceArtifact.fields?.permitFeeAed !== item.permitFeeAed
        || sourceArtifact.fields?.recoverableDepositAed !== item.recoverableDepositAed
        || sourceArtifact.fields?.depositRefundable !== item.depositRefundable
        || sourceArtifact.fields?.visaLifecycle !== 'residence_and_work_authorisation')) {
        addError(errors, 'AE_PERMIT_DEPOSIT_EVIDENCE_MISMATCH', path, 'Permit, visa lifecycle, and refundable-deposit facts must match the observed source artifact.');
      }
      validateOperatingSettlementEvidence(item, path, evidence, errors, bankLineIds);
      outputs.push({ itemId: item.id, kind: item.kind, expenseAed: item.permitFeeAed, assetAed: item.recoverableDepositAed, visaLifecycleIncluded: item.visaLifecycleIncluded === true, bankLineId: item.bankSettlement?.bankLineId });
      continue;
    }
    if (item.kind === 'annual_trade_licence' || item.kind === 'annual_rent') {
      if (sourceArtifact && !annualPrepaymentEvidenceMatches(item, sourceArtifact.fields)) {
        addError(errors, 'AE_ANNUAL_PREPAYMENT_EVIDENCE_MISMATCH', path, 'Annual amount and service dates must match the observed obligation document.');
      }
      const months = wholeMonths(item.startsOn, item.endsOn);
      const monthExpenseFils = months > 0 ? Math.round(amountFils / months) : null;
      const candidateFils = toFils(item.monthOneExpenseAed);
      if (months !== 12 || candidateFils === null) {
        addError(errors, 'AE_ANNUAL_PREPAYMENT_PERIOD_INVALID', path, 'Annual prepayment requires a twelve-month service period and exact month-one expense.');
      } else if (candidateFils !== monthExpenseFils) {
        const code = item.kind === 'annual_rent' && candidateFils === amountFils
          ? AE_PAYROLL_OPERATING_REFUSALS.ANNUAL_RENT_MONTH_ONE_EXPENSED
          : 'AE_PREPAYMENT_RELEASE_INVALID';
        addError(errors, code, `${path}.monthOneExpenseAed`, 'Only the causally elapsed monthly portion may be expensed.');
      }
      if (item.kind === 'annual_rent' && (toFils(item.postDatedCheque?.cashEffectOnIssueAed) ?? 0) !== 0) {
        addError(errors, AE_PAYROLL_OPERATING_REFUSALS.PDC_ISSUE_TREATED_AS_CASH, `${path}.postDatedCheque`, 'Cheque custody/issue is not cleared bank cash.');
      }
      validateOperatingSettlementEvidence(item, path, evidence, errors, bankLineIds);
      if (item.kind === 'annual_rent') {
        const chequeArtifact = requireEvidence(item.chequeArtifactId, `${path}.chequeArtifactId`, evidence, errors, 'AE_PDC_CUSTODY_EVIDENCE_REQUIRED');
        if (chequeArtifact && (chequeArtifact.fields?.chequeNumber !== item.postDatedCheque?.chequeNumber
          || chequeArtifact.fields?.issuedOn !== item.postDatedCheque?.issuedOn
          || chequeArtifact.fields?.amountAed !== item.amountAed)) {
          addError(errors, AE_PAYROLL_OPERATING_REFUSALS.PDC_ISSUE_TREATED_AS_CASH, `${path}.postDatedCheque`, 'Cheque custody evidence must remain distinct and tie by cheque identity and amount.');
        }
      }
      outputs.push({
        itemId: item.id,
        kind: item.kind,
        expenseAed: monthExpenseFils === null ? null : formatFils(monthExpenseFils),
        prepaidAssetAed: monthExpenseFils === null ? null : formatFils(amountFils - monthExpenseFils),
        chequeIssuedOn: item.postDatedCheque?.issuedOn ?? null,
        bankSettledOn: item.bankSettlement?.settledOn ?? null,
        bankLineId: item.bankSettlement?.bankLineId,
      });
      continue;
    }
    addError(errors, 'AE_OPERATING_ITEM_KIND_UNSUPPORTED', `${path}.kind`, 'Unsupported operating obligation kind.');
  }
  return outputs;
}

function evaluateTemporalPairs(pairs, errors) {
  const outputs = [];
  for (const [index, pair] of array(pairs).entries()) {
    const path = `aeObligationContract.temporalPairs[${index}]`;
    if (!MATERIAL_FAMILIES.has(pair?.family)) {
      addError(errors, 'AE_TEMPORAL_FAMILY_INVALID', `${path}.family`, 'Temporal pair family is not material.');
      continue;
    }
    const documentFirst = projectTemporalSequence(pair.documentFirst, pair.family, `${path}.documentFirst`, errors);
    const cashFirst = projectTemporalSequence(pair.cashFirst, pair.family, `${path}.cashFirst`, errors);
    const converged = stableStringify(documentFirst) === stableStringify(cashFirst);
    if (!converged) addError(errors, 'AE_TEMPORAL_PAIR_DID_NOT_CONVERGE', path, 'Document-first and cash-first arrival orders must converge.');
    outputs.push({ pairId: pair.id, family: pair.family, converged, terminalProjection: documentFirst });
  }
  return outputs;
}

function projectTemporalSequence(sequence, family, path, errors) {
  const requiredKinds = TEMPORAL_REQUIRED_KINDS[family];
  const observed = new Map();
  const bankLines = new Set();
  for (const [index, item] of array(sequence).entries()) {
    if (!requiredKinds.includes(item?.kind) || !nonEmpty(item?.ref)) {
      addError(errors, 'AE_TEMPORAL_OBSERVATION_INVALID', `${path}[${index}]`, 'Temporal observations require a permitted kind and stable ref.');
      continue;
    }
    if (['bank_settlement', 'contribution_settlement'].includes(item.kind)) {
      if (!nonEmpty(item.bankLineId)) {
        addError(errors, 'AE_BANK_LINE_ID_REQUIRED', `${path}[${index}].bankLineId`, 'Bank settlement requires a stable bank line id.');
      } else if (bankLines.has(item.bankLineId)) {
        addError(errors, AE_PAYROLL_OPERATING_REFUSALS.BANK_LINE_DUPLICATE_POSTING, `${path}[${index}].bankLineId`, 'Arrival-order reversal cannot post the same bank line twice.');
      } else {
        bankLines.add(item.bankLineId);
      }
    }
    observed.set(`${item.kind}:${item.ref}`, { kind: item.kind, ref: item.ref, bankLineId: item.bankLineId ?? null });
  }
  for (const kind of requiredKinds) {
    if (![...observed.values()].some((item) => item.kind === kind)) {
      addError(errors, 'AE_TEMPORAL_OBSERVATION_MISSING', path, `Missing ${kind} observation.`);
    }
  }
  return [...observed.values()].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function evaluateSensitivityPairs(pairs, errors) {
  const outputs = [];
  for (const [index, pair] of array(pairs).entries()) {
    const path = `aeObligationContract.sensitivityPairs[${index}]`;
    if (!MATERIAL_FAMILIES.has(pair?.family)) {
      addError(errors, 'AE_SENSITIVITY_FAMILY_INVALID', `${path}.family`, 'Sensitivity pair family is not material.');
      continue;
    }
    const differences = diffPaths(pair.left, pair.right);
    if (differences.length !== 1 || differences[0] !== pair.changedFact) {
      addError(errors, 'AE_SENSITIVITY_ONE_FACT_REQUIRED', path, 'Sensitivity siblings must differ at exactly the declared fact.');
    }
    const leftProjection = projectSensitivity(pair.family, pair.left);
    const rightProjection = projectSensitivity(pair.family, pair.right);
    if (stableStringify(leftProjection) === stableStringify(rightProjection)) {
      addError(errors, 'AE_SENSITIVITY_NOT_DISCRIMINATING', path, 'The one-fact change must alter the obligation projection.');
    }
    outputs.push({ pairId: pair.id, family: pair.family, changedFact: pair.changedFact, leftProjection, rightProjection });
  }
  return outputs;
}

function validateMaterialFamilyCoverage(requiredFamilies, temporalPairs, sensitivityPairs, errors) {
  const temporalFamilies = new Set(temporalPairs.map(({ family }) => family));
  const sensitivityFamilies = new Set(sensitivityPairs.map(({ family }) => family));
  for (const family of array(requiredFamilies).filter((value) => MATERIAL_FAMILIES.has(value))) {
    if (!temporalFamilies.has(family)) {
      addError(errors, 'AE_TEMPORAL_FAMILY_MISSING', 'aeObligationContract.temporalPairs', `Missing temporal pair for ${family}.`);
    }
    if (!sensitivityFamilies.has(family)) {
      addError(errors, 'AE_SENSITIVITY_FAMILY_MISSING', 'aeObligationContract.sensitivityPairs', `Missing sensitivity pair for ${family}.`);
    }
  }
}

function projectSensitivity(family, facts) {
  if (family === 'wps_payroll') return { paymentState: facts?.bankCleared ? 'paid' : 'instruction_only' };
  if (family === 'employee_benefits') return { alternativeEmployerRatePercent: Number(facts?.completedServiceYears) > 5 ? '8.33' : '5.83' };
  if (family === 'licence_permit_deposit') return { treatment: facts?.depositRefundable ? 'asset.recoverable_deposit' : 'expense.permit_cost' };
  if (family === 'annual_rent_pdc') return { chequeState: facts?.bankCleared ? 'cash_settled' : 'custody_only' };
  return {};
}

function validatePolicySources(worldSpec, contract, errors) {
  const map = new Map();
  for (const [index, source] of array(worldSpec.policySources).entries()) {
    const path = `policySources[${index}]`;
    if (!isObject(source) || !nonEmpty(source.id) || !nonEmpty(source.authority) || !nonEmpty(source.title)
      || !isIsoDay(source.effectiveFrom) || !isIsoDay(source.asOf)) {
      addError(errors, 'AE_POLICY_SOURCE_INVALID', path, 'Policy sources require identity, authority, title, effectiveFrom, and asOf.');
      continue;
    }
    let url;
    try { url = new URL(source.url); } catch { url = null; }
    if (!url || url.protocol !== 'https:' || !ALLOWED_POLICY_HOSTS.has(url.hostname)) {
      addError(errors, 'AE_POLICY_PRIMARY_SOURCE_REQUIRED', `${path}.url`, 'Use a live official primary-source HTTPS URL.');
    }
    if (source.effectiveFrom > worldSpec.effectiveDate || source.asOf > worldSpec.effectiveDate) {
      addError(errors, 'AE_POLICY_SOURCE_NOT_EFFECTIVE', path, 'Policy source dates cannot be later than the world effective date.');
    }
    if (map.has(source.id)) addError(errors, 'AE_POLICY_SOURCE_DUPLICATED', `${path}.id`, 'Policy source ids must be unique.');
    map.set(source.id, source);
  }
  if (array(contract.payrollBatches).length) requirePolicy(map, REQUIRED_POLICY.wps, 'policySources', errors);
  if (array(contract.operatingItems).length) requirePolicy(map, REQUIRED_POLICY.accounting, 'policySources', errors);
  return map;
}

function buildEvidenceIndex(worldSpec, errors) {
  const artifacts = new Map(array(worldSpec.artifacts).map((item) => [item.id, item]));
  const observations = new Map();
  for (const observation of array(worldSpec.observations)) {
    if (nonEmpty(observation?.artifactId) && isIsoDay(observation?.observedAt)) {
      const prior = observations.get(observation.artifactId);
      if (!prior || observation.observedAt < prior) observations.set(observation.artifactId, observation.observedAt);
    }
  }
  for (const [artifactId, observedAt] of observations) {
    if (!artifacts.has(artifactId)) addError(errors, 'AE_EVIDENCE_ARTIFACT_MISSING', `observations.${artifactId}`, 'Observed artifact must exist.');
    if (observedAt > worldSpec.effectiveDate) addError(errors, 'AE_EVIDENCE_NOT_YET_OBSERVED', `observations.${artifactId}`, 'Evidence is not visible by the world effective date.');
  }
  return { artifacts, observations, effectiveDate: worldSpec.effectiveDate };
}

function requireEvidence(artifactId, path, evidence, errors, code) {
  if (!nonEmpty(artifactId) || !evidence.artifacts.has(artifactId) || !evidence.observations.has(artifactId)
    || evidence.observations.get(artifactId) > evidence.effectiveDate) {
    addError(errors, code, path, 'A declared artifact observed by the world effective date is required.');
    return null;
  }
  return evidence.artifacts.get(artifactId);
}

function validateOperatingSettlementEvidence(item, path, evidence, errors, bankLineIds) {
  const artifact = requireEvidence(item.bankSettlementArtifactId, `${path}.bankSettlementArtifactId`, evidence, errors, 'AE_OPERATING_BANK_SETTLEMENT_EVIDENCE_REQUIRED');
  const bankLineId = item.bankSettlement?.bankLineId;
  if (nonEmpty(bankLineId)) {
    if (bankLineIds.has(bankLineId)) addError(errors, AE_PAYROLL_OPERATING_REFUSALS.BANK_LINE_DUPLICATE_POSTING, `${path}.bankSettlement.bankLineId`, 'One observed bank line may settle only one obligation.');
    bankLineIds.add(bankLineId);
  }
  if (artifact && (artifact.fields?.bankLineId !== bankLineId
    || artifact.fields?.amountAed !== item.bankSettlement?.amountAed
    || artifact.fields?.settledOn !== item.bankSettlement?.settledOn)) {
    addError(errors, 'AE_OPERATING_BANK_SETTLEMENT_TIE_FAILED', `${path}.bankSettlement`, 'Operating settlement must tie to the observed bank line identity, amount, and date.');
  }
}

function employeeClassMatchesNationality(employeeClass, nationality) {
  if (!nonEmpty(nationality)) return false;
  if (employeeClass === 'uae_national') return nationality === 'AE';
  if (employeeClass === 'gcc_national') return GCC_NATIONALITIES.has(nationality);
  return nationality !== 'AE' && !GCC_NATIONALITIES.has(nationality);
}

function employeeMasterEvidenceMatches(employee, fields = {}) {
  return fields.employeeId === employee.id
    && fields.joinedOn === employee.joinedOn
    && (employee.leftOn === null || fields.leftOn === employee.leftOn);
}

function salaryEvidenceMatches(employeeId, salary, fields = {}) {
  return fields.employeeId === employeeId
    && fields.basicAed === salary.basicAed
    && fields.grossAed === salary.grossAed
    && (!isIsoDay(fields.effectiveFrom) || fields.effectiveFrom === salary.effectiveFrom);
}

function validateUnpaidLeaveEvidence(employee, path, evidence, errors) {
  for (const [index, leave] of array(employee.unpaidLeave).entries()) {
    const artifact = requireEvidence(leave?.sourceArtifactId, `${path}.unpaidLeave[${index}].sourceArtifactId`, evidence, errors, 'AE_UNPAID_LEAVE_EVIDENCE_REQUIRED');
    const ranges = array(artifact?.fields?.unpaidLeave);
    if (artifact && !ranges.some((range) => range?.startsOn === leave.startsOn && range?.endsOn === leave.endsOn)) {
      addError(errors, 'AE_UNPAID_LEAVE_EVIDENCE_MISMATCH', `${path}.unpaidLeave[${index}]`, 'Unpaid-leave dates must match an observed employee record.');
    }
  }
}

function annualPrepaymentEvidenceMatches(item, fields = {}) {
  const sourceAmount = item.kind === 'annual_rent' ? fields.annualRentAed : fields.amountAed;
  return sourceAmount === item.amountAed
    && fields.startsOn === item.startsOn
    && fields.endsOn === item.endsOn;
}

function schemeEvidenceMatches(activeBenefit, employeeId, fields = {}) {
  if (nonEmpty(fields.employeeId) && fields.employeeId !== employeeId) return false;
  if (nonEmpty(fields.schemeId) && fields.schemeId !== activeBenefit.schemeId) return false;
  if (isIsoDay(fields.effectiveFrom) && fields.effectiveFrom !== activeBenefit.effectiveFrom) return false;
  if (isIsoDay(fields.priorServiceCutoff) && fields.priorServiceCutoff !== activeBenefit.priorServiceCutoff) return false;
  if (nonEmpty(fields.enrollmentBasicWageAed) && fields.enrollmentBasicWageAed !== activeBenefit.enrollmentBasicWageAed) return false;
  if (nonEmpty(fields.homeCountry) && fields.homeCountry !== activeBenefit.homeCountry) return false;
  if (nonEmpty(fields.contributionSalaryAed) && fields.contributionSalaryAed !== activeBenefit.contributionSalaryAed) return false;
  if (isIsoDay(fields.firstFederalPensionEmploymentOn)
    && fields.firstFederalPensionEmploymentOn !== activeBenefit.firstFederalPensionEmploymentOn) return false;
  return true;
}

function payrollEvidenceTies({ batch, registerArtifact, instructionArtifact, bankArtifact, grossFils, deductionsFils, netFils }) {
  if (!registerArtifact || !instructionArtifact || !bankArtifact) return false;
  const register = registerArtifact.fields ?? {};
  const instruction = instructionArtifact.fields ?? {};
  const bank = bankArtifact.fields ?? {};
  return register.wpsBatchId === batch.wpsBatchId
    && toFils(register.grossAed) === grossFils
    && toFils(register.deductionsAed) === deductionsFils
    && toFils(register.netAed) === netFils
    && instruction.batchId === batch.wpsBatchId
    && toFils(instruction.amountAed) === netFils
    && bank.batchId === batch.wpsBatchId
    && bank.bankLineId === batch.bankSettlement?.bankLineId
    && toFils(bank.amountAed) === netFils
    && bank.settledOn === batch.bankSettlement?.settledOn;
}

function requirePolicy(policySources, id, path, errors) {
  if (!policySources.has(id)) addError(errors, 'AE_POLICY_SOURCE_REQUIRED', path, `Missing policy source ${id}.`);
}

function addOwnerAsk(ownerAsks, { targetId, factClass, obligations, hypotheses, evidenceChecked, answerType }) {
  const askId = `ask/ae-obligation/${targetId}/${factClass}`;
  if (ownerAsks.some((ask) => ask.ask_id === askId)) return;
  ownerAsks.push({
    version: ASK_CONTRACT_VERSION,
    ask_id: askId,
    case_id: `case/ae-obligation/${targetId}`,
    fact_class: factClass,
    affected_obligations: obligations,
    remaining_hypotheses: hypotheses,
    evidence_already_checked: [...new Set(evidenceChecked.filter(nonEmpty))].sort(),
    expected_answer_type: answerType,
    reliability_required: 'owner_answer_with_supporting_record',
    next_state_if_answered: 'recompute_obligation',
    deferrable_until: null,
    bundle_id: null,
  });
}

function benefitHypotheses(employeeClass) {
  if (employeeClass === 'expatriate') return ['traditional_gratuity', 'alternative_savings'];
  if (employeeClass === 'uae_national') return ['AE/GPSSA/Federal-Law-7-1999', 'AE/GPSSA/Federal-Law-57-2023'];
  return ['home_country_scheme_confirmed', 'home_country_scheme_not_confirmed'];
}

function activeTimelineRecord(records, onDate, path, errors, { allowEmpty = false } = {}) {
  const list = array(records);
  if (!list.length) {
    if (!allowEmpty) addError(errors, 'AE_EFFECTIVE_TIMELINE_REQUIRED', path, 'An effective-dated timeline is required.');
    return null;
  }
  const active = [];
  for (const [index, record] of list.entries()) {
    if (!isObject(record) || !isIsoDay(record.effectiveFrom) || (record.effectiveTo !== null && !isIsoDay(record.effectiveTo))) {
      addError(errors, 'AE_EFFECTIVE_TIMELINE_INVALID', `${path}[${index}]`, 'Timeline records require effectiveFrom and optional effectiveTo ISO days.');
      continue;
    }
    if (record.effectiveTo !== null && record.effectiveTo < record.effectiveFrom) {
      addError(errors, 'AE_EFFECTIVE_TIMELINE_INVALID', `${path}[${index}]`, 'effectiveTo cannot precede effectiveFrom.');
    }
    if (record.effectiveFrom <= onDate && (record.effectiveTo === null || onDate <= record.effectiveTo)) active.push(record);
  }
  if (active.length > 1) addError(errors, 'AE_EFFECTIVE_TIMELINE_OVERLAP', path, 'Exactly one timeline record may be active on the effective date.');
  if (!active.length && !allowEmpty) addError(errors, 'AE_EFFECTIVE_TIMELINE_GAP', path, 'A timeline record must be active on the effective date.');
  return active[0] ?? null;
}

function countUnpaidLeaveDays(leaves, errors, path) {
  let days = 0;
  for (const [index, leave] of array(leaves).entries()) {
    if (!isIsoDay(leave?.startsOn) || !isIsoDay(leave?.endsOn) || leave.endsOn < leave.startsOn) {
      addError(errors, 'AE_UNPAID_LEAVE_DATES_INVALID', `${path}[${index}]`, 'Unpaid leave requires ordered ISO boundary dates.');
      continue;
    }
    days += daysBetween(leave.startsOn, addDays(leave.endsOn, 1));
  }
  return days;
}

function ledgerRoleTotal(entries, role) {
  let total = 0;
  let found = false;
  for (const entry of array(entries)) {
    if (entry?.role !== role) continue;
    const amount = toFils(entry.amountAed);
    if (amount === null) return null;
    total += amount;
    found = true;
  }
  return found ? total : 0;
}

function ledgerTotal(entries) {
  let total = 0;
  for (const entry of array(entries)) {
    const amount = toFils(entry?.amountAed);
    if (amount === null) return null;
    total += amount;
  }
  return total;
}

function wholeMonths(startsOn, endsOn) {
  if (!isIsoDay(startsOn) || !isIsoDay(endsOn) || endsOn < startsOn) return null;
  const start = parseDay(startsOn);
  const endAfter = parseDay(addDays(endsOn, 1));
  return ((endAfter.year - start.year) * 12) + endAfter.month - start.month;
}

function hasExceededYears(startsOn, onDate, years) {
  if (!isIsoDay(startsOn) || !isIsoDay(onDate) || !Number.isInteger(years)) return false;
  const start = parseDay(startsOn);
  const anniversary = `${String(start.year + years).padStart(4, '0')}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`;
  return onDate > anniversary;
}

function daysBetween(startsOn, endsExclusive) {
  return Math.round((Date.parse(`${endsExclusive}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000);
}

function addDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return utcIsoDay(date);
}

function rangesOverlap(leftFrom, leftTo, rightFrom, rightTo) {
  if (!isIsoDay(leftFrom) || !isIsoDay(rightFrom)) return false;
  const leftEnd = leftTo ?? '9999-12-31';
  const rightEnd = rightTo ?? '9999-12-31';
  return leftFrom <= rightEnd && rightFrom <= leftEnd;
}

function percentOf(fils, basisPoints) {
  return Math.round((fils * basisPoints) / 10_000);
}

function toFils(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.\d{2}$/.test(value)) return null;
  const [whole, fraction] = value.split('.');
  const fils = (Number(whole) * 100) + Number(fraction);
  return Number.isSafeInteger(fils) ? fils : null;
}

function formatFils(value) {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function diffPaths(left, right, prefix = '') {
  if (stableStringify(left) === stableStringify(right)) return [];
  if (!isObject(left) || !isObject(right)) return [prefix || '$'];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => diffPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function parseDay(value) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function isIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && utcIsoDay(date) === value;
}

function buildResult({
  errors,
  ownerAsks,
  employees = [],
  employeeObligations = [],
  payrollBatches = [],
  masterDataAdjustments = [],
  operatingObligations = [],
  temporalPairs = [],
  sensitivityPairs = [],
  terminalInventory = { autoResolved: [], owner: [], limbo: [] },
}) {
  return {
    ok: errors.length === 0,
    version: AE_PAYROLL_OPERATING_VERSION,
    errors,
    employees,
    employeeObligations,
    payrollBatches,
    masterDataAdjustments,
    operatingObligations,
    temporalPairs,
    sensitivityPairs,
    ownerAsks,
    terminalInventory,
  };
}

function addError(errors, code, path, message) {
  if (!errors.some((error) => error.code === code && error.path === path && error.message === message)) {
    errors.push({ code, path, message });
  }
}

function array(value) { return Array.isArray(value) ? value : []; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
