import { validateAeEntityTaxContextWorld } from './aeEntityTaxContext.js';
import { utcIsoDay } from './utcDay.js';

export const AE_CORPORATE_TAX_CONTRACT_VERSION = 'ae.corporate-tax.v1';

export const AE_CT_REFUSAL_CODES = Object.freeze({
  PERIOD_FACT_REQUIRED: 'AE_CT_PERIOD_FACT_REQUIRED',
  PERIOD_FACT_CONFLICT: 'AE_CT_PERIOD_FACT_CONFLICT',
  SOURCE_POLICY_DRIFT: 'AE_CT_SOURCE_POLICY_DRIFT',
  PROFILE_OUTCOME_FORBIDDEN: 'AE_CT_PROFILE_OUTCOME_FORBIDDEN',
  QFZP_INFERENCE_FORBIDDEN: 'AE_CT_QFZP_INFERENCE_FORBIDDEN',
  EXCLUDED_ACTIVITY_QUALIFYING: 'AE_CT_EXCLUDED_ACTIVITY_QUALIFYING',
  ELECTION_RECEIPT_REQUIRED: 'AE_CT_ELECTION_RECEIPT_REQUIRED',
  AUDIT_FACT_REQUIRED: 'AE_CT_AUDIT_FACT_REQUIRED',
  RELATED_PARTY_FACT_REQUIRED: 'AE_CT_RELATED_PARTY_FACT_REQUIRED',
  BREACH_HORIZON_INCOMPLETE: 'AE_CT_BREACH_HORIZON_INCOMPLETE',
  VAT_AXIS_CONTAMINATION: 'AE_CT_VAT_AXIS_CONTAMINATION',
});

const POLICY = Object.freeze({
  LEGISLATION_REGISTRY: 'policy/ae-mof-legislation-registry',
  CT_LAW: 'policy/ae-ct-law-47-2022',
  QUALIFYING_INCOME: 'policy/ae-cd100-2023',
  ACTIVITIES: 'policy/ae-md229-2025',
  AUDIT: 'policy/ae-md84-2025',
  FREE_ZONE_GUIDE: 'policy/ae-fta-ctgfzp1',
  VAT_DESIGNATED_ZONES: 'policy/ae-vat-designated-zones',
  SBR_BASE: 'policy/ae-md73-2023',
  SBR_EXTENSION: 'policy/ae-md131-2026',
});

const REQUIRED_POLICY_IDENTITIES = Object.freeze({
  [POLICY.LEGISLATION_REGISTRY]: Object.freeze({
    authority: 'Ministry of Finance',
    documentNumber: 'Financial Legislation Registry',
    url: 'https://mof.gov.ae/en/financial-legislation/',
    effectiveFrom: '2026-08-31',
  }),
  [POLICY.CT_LAW]: Object.freeze({
    authority: 'Ministry of Finance',
    documentNumber: 'Federal Decree-Law No. 47 of 2022',
    url: 'https://www.mof.gov.ae/wp-content/uploads/2022/12/Federal-Decree-Law-No.-47-of-2022-EN.pdf?fm=pdf',
    effectiveFrom: '2023-06-01',
  }),
  [POLICY.QUALIFYING_INCOME]: Object.freeze({
    authority: 'UAE Cabinet',
    documentNumber: 'Cabinet Decision No. 100 of 2023',
    url: 'https://mofprod.mof.gov.ae/wp-content/uploads/2023/11/Cabinet-Decision-No.-100-of-2023-on-Determining-Qualifying-Income-for-the-Qualifying-Free-Zone-Person.pdf',
    effectiveFrom: '2023-06-01',
  }),
  [POLICY.ACTIVITIES]: Object.freeze({
    authority: 'Ministry of Finance',
    documentNumber: 'Ministerial Decision No. 229 of 2025',
    url: 'https://mof.gov.ae/wp-content/uploads/2025/09/EN-Ministerial-Decision-No.-229-of-2025-Regarding-Qualifying-Activities-and-Excluded-Activities.pdf',
    effectiveFrom: '2023-06-01',
  }),
  [POLICY.AUDIT]: Object.freeze({
    authority: 'Ministry of Finance',
    documentNumber: 'Ministerial Decision No. 84 of 2025',
    url: 'https://www.mof.gov.ae/wp-content/uploads/2025/04/Ministerial-Decision-No.-84-of-2025-on-Audited-Financial-Statements.pdf',
    effectiveFrom: '2025-01-01',
  }),
  [POLICY.FREE_ZONE_GUIDE]: Object.freeze({
    authority: 'Federal Tax Authority',
    documentNumber: 'CTGFZP1',
    url: 'https://tax.gov.ae/Datafolder/Files/Pdf/2025/Free-Zone-Persons-Guide_AR.pdf',
    effectiveFrom: '2023-06-01',
  }),
  [POLICY.VAT_DESIGNATED_ZONES]: Object.freeze({
    authority: 'Federal Tax Authority',
    documentNumber: 'VATGDZ1',
    url: 'https://tax.gov.ae/-/media/Files/EN/PDF/Guides/Designated-Zones-VAT-Guide.pdf',
    effectiveFrom: '2018-01-01',
  }),
  [POLICY.SBR_BASE]: Object.freeze({
    authority: 'Ministry of Finance',
    documentNumber: 'Ministerial Decision No. 73 of 2023',
    url: 'https://mof.gov.ae/en/news/ministry-of-finance-issues-decision-on-small-business-relief-for-corporate-tax-purposes/',
    effectiveFrom: '2023-06-01',
  }),
  [POLICY.SBR_EXTENSION]: Object.freeze({
    authority: 'Ministry of Finance',
    documentNumber: 'Ministerial Decision No. 131 of 2026',
    url: 'https://mof.gov.ae/wp-content/uploads/2026/08/Ministerial-Decision-No.-131-of-2026-Amending-Certain-Provisions-of-Ministerial-Decision-No.-73-of-2023-on-Small-Business-Relief-for-the-Purposes-of-Federal-Decree-Law-No.-47-of-2022-EN.pdf',
    effectiveFrom: '2023-06-01',
  }),
});

const CONDITION_SPECS = Object.freeze({
  qualifyingIncome: Object.freeze({
    statuses: Object.freeze(['supported', 'not_supported', 'unknown']),
    policySourceId: POLICY.QUALIFYING_INCOME,
  }),
  adequateSubstance: Object.freeze({
    statuses: Object.freeze(['met', 'not_met', 'unknown']),
    policySourceId: POLICY.CT_LAW,
  }),
  armLength: Object.freeze({
    statuses: Object.freeze(['met', 'not_met', 'unknown']),
    policySourceId: POLICY.CT_LAW,
  }),
  transferPricingDocumentation: Object.freeze({
    statuses: Object.freeze(['met', 'not_met', 'unknown']),
    policySourceId: POLICY.CT_LAW,
  }),
  auditedFinancialStatements: Object.freeze({
    statuses: Object.freeze(['met', 'not_met', 'unknown']),
    policySourceId: POLICY.AUDIT,
    missingCode: AE_CT_REFUSAL_CODES.AUDIT_FACT_REQUIRED,
  }),
});

const QUALIFYING_ACTIVITY_KINDS = new Set([
  'manufacturing',
  'processing',
  'qualifying_commodities_trading',
  'holding_shares_and_securities',
  'ship_ownership_management_operation',
  'reinsurance_services',
  'fund_management_services',
  'wealth_and_investment_management_services',
  'headquarters_services_to_related_parties',
  'treasury_and_financing_to_related_parties_or_own_account',
  'aircraft_financing_and_leasing',
  'distribution_from_designated_zone',
  'logistics_services',
  'ancillary_to_qualifying_activity',
]);

const EXCLUDED_ACTIVITY_KINDS = new Set([
  'excluded_natural_person_transaction',
  'excluded_banking',
  'excluded_insurance',
  'excluded_finance_or_leasing',
  'excluded_immovable_property',
  'ancillary_to_excluded_activity',
]);

const OTHER_NON_QUALIFYING_ACTIVITY_KINDS = new Set(['other_non_qualifying']);
const PE_SCOPES = new Set(['domestic_permanent_establishment', 'foreign_permanent_establishment']);
const INCOME_SCOPES = new Set([
  'free_zone_person',
  'mainland_person',
  'domestic_permanent_establishment',
  'foreign_permanent_establishment',
]);
const CT_TREATMENTS = new Set(['qualifying', 'non_qualifying', 'permanent_establishment_separate', 'unassured']);
const RELATED_PARTY_STATUSES = new Set(['related_party', 'not_related_party', 'unknown']);
const AED_5_MILLION_FILS = 500_000_000n;
const AED_3_MILLION_FILS = 300_000_000n;

export function evaluateAeCorporateTaxWorld(worldSpec) {
  const world = isPlainObject(worldSpec) ? worldSpec : {};
  const errors = [];
  const entityContext = validateAeEntityTaxContextWorld(world);
  for (const error of entityContext.errors) {
    errors.push(clone(error));
    if (error.code === 'AE_PROFILE_PERIOD_OUTCOME_FORBIDDEN') {
      addError(
        errors,
        AE_CT_REFUSAL_CODES.PROFILE_OUTCOME_FORBIDDEN,
        error.path,
        'Corporate-tax outcomes are period projections and cannot be persisted on the entity profile.',
      );
    }
  }

  if (world.manifest?.capabilityId !== 'assess_ae_corporate_tax_period') {
    addError(errors, 'AE_CT_CAPABILITY_REQUIRED', 'manifest.capabilityId', 'Expected assess_ae_corporate_tax_period.');
  }
  if (!isIsoDay(world.policyAsOf)) {
    addError(errors, 'AE_CT_POLICY_AS_OF_REQUIRED', 'policyAsOf', 'An ISO policyAsOf date is required.');
  }

  const sources = validatePolicyRegistry(world, errors);
  const evidence = buildEvidenceIndex(world);
  const context = entityContext.contexts.length === 1 ? entityContext.contexts[0] : null;
  if (entityContext.contexts.length !== 1) {
    addError(errors, 'AE_CT_ENTITY_CONTEXT_REQUIRED', 'entities', 'Exactly one valid AE-1 entity context is required.');
  }

  const corporatePeriods = validateCorporatePeriods({
    worldSpec: world,
    sources,
    evidence,
    context,
    errors,
  });
  const deMinimisBoundaryCases = validateAndExpandBoundarySets(world, sources, errors);
  const smallBusinessReliefPeriods = validateSbrPeriods({ worldSpec: world, sources, evidence, errors });

  if (corporatePeriods.length === 0 && smallBusinessReliefPeriods.length === 0) {
    addError(errors, 'AE_CT_PERIOD_SET_REQUIRED', 'worldSpec', 'At least one corporate-tax or Small Business Relief period is required.');
  }

  const periods = errors.length === 0
    ? projectCorporatePeriods(corporatePeriods, world.breachConsequence, errors)
    : [];
  const sbrPeriods = errors.length === 0 ? projectSbrPeriods(smallBusinessReliefPeriods) : [];

  return {
    ok: errors.length === 0,
    version: AE_CORPORATE_TAX_CONTRACT_VERSION,
    policyAsOf: world.policyAsOf ?? null,
    authority: Object.freeze({
      scope: 'oracle_expected_policy_consequences_only',
      prohibitedActions: Object.freeze(['write_tax_state', 'file', 'pay', 'post_journal', 'grant_production_authority']),
    }),
    errors,
    periods,
    deMinimisBoundaryCases,
    smallBusinessReliefPeriods: sbrPeriods,
  };
}

export function expandAeDeMinimisBoundarySets(boundarySets = []) {
  if (!Array.isArray(boundarySets)) return [];
  return [...boundarySets]
    .sort((left, right) => String(left?.caseSetId || '').localeCompare(String(right?.caseSetId || '')))
    .flatMap((boundarySet) => {
      const totalFils = parseAedToFils(boundarySet?.totalRelevantRevenueAed);
      if (totalFils === null) return [];
      const threshold = deMinimisThreshold(totalFils);
      const deltas = Array.isArray(boundarySet.deltasFils)
        ? [...boundarySet.deltasFils].filter(Number.isSafeInteger).sort((left, right) => left - right)
        : [];
      return deltas.map((deltaFils) => {
        const nonQualifyingFils = threshold.thresholdFils + BigInt(deltaFils);
        return {
          caseId: `${boundarySet.caseSetId}/${boundaryLabel(deltaFils)}`,
          lowerLimb: threshold.lowerLimb,
          totalRelevantRevenueAed: formatFils(totalFils),
          thresholdAed: formatFils(threshold.thresholdFils),
          nonQualifyingRevenueAed: formatFils(nonQualifyingFils),
          deltaFils,
          status: nonQualifyingFils <= threshold.thresholdFils ? 'passed' : 'breached',
          policySourceId: boundarySet.policySourceId,
        };
      });
    });
}

function validatePolicyRegistry(worldSpec, errors) {
  const sources = new Map();
  for (const source of Array.isArray(worldSpec?.policySources) ? worldSpec.policySources : []) {
    if (!isPlainObject(source) || typeof source.id !== 'string') continue;
    sources.set(source.id, source);
  }

  const required = new Set();
  if (Array.isArray(worldSpec?.corporateTaxPeriods) && worldSpec.corporateTaxPeriods.length > 0) {
    [POLICY.LEGISLATION_REGISTRY, POLICY.CT_LAW, POLICY.QUALIFYING_INCOME, POLICY.ACTIVITIES, POLICY.AUDIT,
      POLICY.FREE_ZONE_GUIDE, POLICY.VAT_DESIGNATED_ZONES].forEach((id) => required.add(id));
    validateBinding(worldSpec, 'corporateTaxLaw', POLICY.CT_LAW, errors);
    validateBinding(worldSpec, 'qualifyingIncome', POLICY.QUALIFYING_INCOME, errors);
    validateBinding(worldSpec, 'qualifyingActivities', POLICY.ACTIVITIES, errors);
    validateBinding(worldSpec, 'auditedFinancialStatements', POLICY.AUDIT, errors);
    validateBinding(worldSpec, 'freeZoneGuidance', POLICY.FREE_ZONE_GUIDE, errors);
    validateBinding(worldSpec, 'vatDesignatedZones', POLICY.VAT_DESIGNATED_ZONES, errors);
  }
  if (Array.isArray(worldSpec?.smallBusinessReliefPeriods) && worldSpec.smallBusinessReliefPeriods.length > 0) {
    [POLICY.LEGISLATION_REGISTRY, POLICY.CT_LAW, POLICY.SBR_BASE, POLICY.SBR_EXTENSION].forEach((id) => required.add(id));
    validateBinding(worldSpec, 'smallBusinessReliefBase', POLICY.SBR_BASE, errors);
    validateBinding(worldSpec, 'smallBusinessReliefCurrent', POLICY.SBR_EXTENSION, errors);
  }

  for (const id of required) {
    const source = sources.get(id);
    const expected = REQUIRED_POLICY_IDENTITIES[id];
    if (!source
      || source.authority !== expected.authority
      || source.documentNumber !== expected.documentNumber
      || source.url !== expected.url
      || source.effectiveFrom !== expected.effectiveFrom
      || source.asOf !== worldSpec.policyAsOf
      || !source.url.startsWith('https://')) {
      addError(
        errors,
        AE_CT_REFUSAL_CODES.SOURCE_POLICY_DRIFT,
        `policySources.${id}`,
        `Expected the current ${expected.documentNumber} identity and ${worldSpec.policyAsOf} source receipt.`,
      );
    }
  }
  return sources;
}

function validateBinding(worldSpec, field, expectedId, errors) {
  if (worldSpec?.policyBindings?.[field] !== expectedId) {
    addError(
      errors,
      AE_CT_REFUSAL_CODES.SOURCE_POLICY_DRIFT,
      `policyBindings.${field}`,
      `Expected ${expectedId}; older or cross-plane policy sources cannot control this consequence.`,
    );
  }
}

function validateCorporatePeriods({ worldSpec, sources, evidence, context, errors }) {
  if (worldSpec.corporateTaxPeriods === undefined) return [];
  if (!Array.isArray(worldSpec.corporateTaxPeriods) || worldSpec.corporateTaxPeriods.length === 0) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, 'corporateTaxPeriods', 'Corporate-tax periods must be a non-empty array.');
    return [];
  }
  if (worldSpec?.breachConsequence?.currentAndFollowingTaxPeriods !== 5
    || worldSpec?.breachConsequence?.policySourceId !== POLICY.ACTIVITIES) {
    addError(
      errors,
      AE_CT_REFUSAL_CODES.BREACH_HORIZON_INCOMPLETE,
      'breachConsequence',
      'A QFZP condition breach must cover the current and four following tax periods under the current source.',
    );
  }

  const periods = [...worldSpec.corporateTaxPeriods]
    .sort((left, right) => String(left?.startsOn || '').localeCompare(String(right?.startsOn || '')));
  const keys = new Set();
  const normalized = [];
  for (const [index, period] of periods.entries()) {
    const path = period?.periodKey ? `corporateTaxPeriods.${period.periodKey}` : `corporateTaxPeriods[${index}]`;
    if (!isPlainObject(period) || typeof period.periodKey !== 'string' || period.periodKey.trim() === '') {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, 'A stable periodKey is required.');
      continue;
    }
    if (keys.has(period.periodKey)) {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_CONFLICT, `${path}.periodKey`, 'Tax-period keys must be unique.');
    }
    keys.add(period.periodKey);
    if (!isIsoDay(period.startsOn) || !isIsoDay(period.endsOn) || period.endsOn < period.startsOn) {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, 'Ordered ISO startsOn and endsOn dates are required.');
    }
    if (period.qfzpBasis !== 'per_period_sourced_conditions') {
      addError(
        errors,
        AE_CT_REFUSAL_CODES.QFZP_INFERENCE_FORBIDDEN,
        `${path}.qfzpBasis`,
        'The words “free zone” do not establish QFZP status; use per-period sourced conditions.',
      );
    }
    normalized.push(validateCorporatePeriod({ period, path, sources, evidence, context, errors }));
  }
  for (let index = 1; index < periods.length; index += 1) {
    if (isIsoDay(periods[index - 1]?.endsOn) && periods[index - 1].endsOn >= periods[index].startsOn) {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_CONFLICT, 'corporateTaxPeriods', 'Corporate-tax periods must not overlap.');
      break;
    }
  }
  return normalized;
}

function validateCorporatePeriod({ period, path, sources, evidence, context, errors }) {
  const conditions = {};
  for (const [name, spec] of Object.entries(CONDITION_SPECS)) {
    conditions[name] = selectPeriodFact({
      records: period?.conditions?.[name],
      period,
      path: `${path}.conditions.${name}`,
      spec,
      sources,
      evidence,
      errors,
    });
  }
  conditions.ownerElection = selectOwnerElection({
    records: period?.conditions?.ownerElection,
    period,
    path: `${path}.conditions.ownerElection`,
    sources,
    evidence,
    errors,
  });

  const income = validateIncomeFacts({
    records: period?.incomeFacts,
    period,
    path: `${path}.incomeFacts`,
    sources,
    evidence,
    context,
    errors,
  });
  const sums = income.reduce((current, entry) => {
    if (entry.amountFils === null) return current;
    if (entry.counterpartyScope === 'domestic_permanent_establishment') current.domesticPe += entry.amountFils;
    else if (entry.counterpartyScope === 'foreign_permanent_establishment') current.foreignPe += entry.amountFils;
    else {
      current.relevant += entry.amountFils;
      if (entry.claimedCtTreatment === 'non_qualifying') current.nonQualifying += entry.amountFils;
      if (entry.relatedPartyStatus === 'related_party') current.relatedParty += entry.amountFils;
      if (entry.counterpartyScope === 'mainland_person') current.mainland += entry.amountFils;
    }
    return current;
  }, { relevant: 0n, nonQualifying: 0n, relatedParty: 0n, mainland: 0n, domesticPe: 0n, foreignPe: 0n });
  const threshold = deMinimisThreshold(sums.relevant);
  const deMinimis = {
    totalRelevantRevenueAed: formatFils(sums.relevant),
    nonQualifyingRevenueAed: formatFils(sums.nonQualifying),
    percentageLimbAed: formatFils(threshold.percentageFils),
    fixedLimbAed: formatFils(AED_5_MILLION_FILS),
    lowerLimb: threshold.lowerLimb,
    thresholdAed: formatFils(threshold.thresholdFils),
    status: sums.nonQualifying <= threshold.thresholdFils ? 'passed' : 'breached',
  };

  const unknownConditions = Object.entries(conditions)
    .filter(([, fact]) => !fact || fact.status === 'unknown' || fact.decision === 'unknown')
    .map(([name]) => name);
  const failedConditions = Object.entries(conditions)
    .filter(([, fact]) => fact && ['not_supported', 'not_met'].includes(fact.status))
    .map(([name]) => name);
  if (conditions.ownerElection?.decision === 'elected_standard_tax') failedConditions.push('ownerElection');
  if (income.some((entry) => entry.claimedCtTreatment === 'unassured')) unknownConditions.push('incomeTreatment');
  if (income.some((entry) => entry.relatedPartyStatus === 'unknown')) unknownConditions.push('relatedParty');

  return {
    periodKey: period.periodKey,
    startsOn: period.startsOn,
    endsOn: period.endsOn,
    conditions,
    income,
    incomeByScope: {
      relatedPartyAed: formatFils(sums.relatedParty),
      mainlandAed: formatFils(sums.mainland),
      domesticPermanentEstablishmentAed: formatFils(sums.domesticPe),
      foreignPermanentEstablishmentAed: formatFils(sums.foreignPe),
    },
    deMinimis,
    unknownConditions: [...new Set(unknownConditions)].sort(),
    failedConditions: [...new Set(failedConditions)].sort(),
  };
}

function selectPeriodFact({ records, period, path, spec, sources, evidence, errors }) {
  if (!Array.isArray(records) || records.length === 0) {
    addError(errors, spec.missingCode || AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, 'A sourced fact covering the whole tax period is required.');
    return null;
  }
  const covering = [];
  for (const [index, record] of records.entries()) {
    const recordPath = `${path}[${index}]`;
    validateEffectiveFact(record, period, recordPath, spec.policySourceId, sources, evidence, errors);
    if (!spec.statuses.includes(record?.status)) {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, `${recordPath}.status`, `Expected ${spec.statuses.join(' | ')}.`);
    }
    if (coversPeriod(record, period)) covering.push(record);
  }
  if (covering.length !== 1) {
    addError(
      errors,
      covering.length > 1 ? AE_CT_REFUSAL_CODES.PERIOD_FACT_CONFLICT : (spec.missingCode || AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED),
      path,
      `Exactly one sourced fact must cover ${period.periodKey}; found ${covering.length}.`,
    );
    return null;
  }
  return clone(covering[0]);
}

function selectOwnerElection({ records, period, path, sources, evidence, errors }) {
  const spec = {
    statuses: ['not_elected', 'elected_standard_tax', 'unknown'],
    policySourceId: POLICY.CT_LAW,
  };
  if (!Array.isArray(records) || records.length === 0) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, 'A sourced Article 19 owner-election fact is required for each period.');
    return null;
  }
  const covering = [];
  for (const [index, record] of records.entries()) {
    const recordPath = `${path}[${index}]`;
    validateEffectiveFact(record, period, recordPath, spec.policySourceId, sources, evidence, errors);
    if (!spec.statuses.includes(record?.decision)) {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, `${recordPath}.decision`, `Expected ${spec.statuses.join(' | ')}.`);
    }
    validateElectionReceipt(record?.receipt, record, `${recordPath}.receipt`, evidence, errors);
    if (coversPeriod(record, period)) covering.push(record);
  }
  if (covering.length !== 1) {
    addError(
      errors,
      covering.length > 1 ? AE_CT_REFUSAL_CODES.PERIOD_FACT_CONFLICT : AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED,
      path,
      `Exactly one Article 19 election fact must cover ${period.periodKey}; found ${covering.length}.`,
    );
    return null;
  }
  return { ...clone(covering[0]), status: covering[0].decision === 'unknown' ? 'unknown' : 'known' };
}

function validateElectionReceipt(receipt, fact, path, evidence, errors) {
  if (!isPlainObject(receipt)
    || typeof receipt.id !== 'string'
    || typeof receipt.actorId !== 'string'
    || receipt.actorId.trim() === ''
    || receipt.actorId === 'system'
    || typeof receipt.authorityBasis !== 'string'
    || receipt.authorityBasis.trim() === ''
    || !isIsoDay(receipt.recordedAt)
    || receipt.sourceArtifactId !== fact?.sourceArtifactId
    || !evidence.artifacts.has(receipt?.sourceArtifactId)) {
    addError(
      errors,
      AE_CT_REFUSAL_CODES.ELECTION_RECEIPT_REQUIRED,
      path,
      'An election requires the real owner/member actor, authority basis, date, and matching source receipt.',
    );
  }
}

function validateIncomeFacts({ records, period, path, sources, evidence, context, errors }) {
  if (!Array.isArray(records) || records.length === 0) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, 'Each period requires sourced income facts.');
    return [];
  }
  return records.map((record, index) => {
    const recordPath = record?.id ? `${path}.${record.id}` : `${path}[${index}]`;
    const amountFils = parseAedToFils(record?.amountAed);
    if (amountFils === null) {
      addError(errors, 'AE_CT_MONEY_INVALID', `${recordPath}.amountAed`, 'Use an exact non-negative AED decimal with two fils digits.');
    }
    const policySourceId = PE_SCOPES.has(record?.counterpartyScope) ? POLICY.QUALIFYING_INCOME : POLICY.ACTIVITIES;
    validateEffectiveFact(record, period, recordPath, policySourceId, sources, evidence, errors);
    if (!INCOME_SCOPES.has(record?.counterpartyScope)) {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, `${recordPath}.counterpartyScope`, 'A separate free-zone, mainland, or permanent-establishment scope is required.');
    }
    if (!CT_TREATMENTS.has(record?.claimedCtTreatment)) {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, `${recordPath}.claimedCtTreatment`, 'A bounded CT treatment fact is required.');
    }
    const isQualifyingKind = QUALIFYING_ACTIVITY_KINDS.has(record?.activityKind);
    const isExcludedKind = EXCLUDED_ACTIVITY_KINDS.has(record?.activityKind);
    const isOtherNonQualifying = OTHER_NON_QUALIFYING_ACTIVITY_KINDS.has(record?.activityKind);
    if (!isQualifyingKind && !isExcludedKind && !isOtherNonQualifying) {
      addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, `${recordPath}.activityKind`, 'Use a sourced policy activity category; descriptions are not classified by keyword.');
    }
    if (isExcludedKind && record?.claimedCtTreatment === 'qualifying') {
      addError(
        errors,
        AE_CT_REFUSAL_CODES.EXCLUDED_ACTIVITY_QUALIFYING,
        `${recordPath}.claimedCtTreatment`,
        'An activity enumerated as excluded by Ministerial Decision 229 cannot be treated as qualifying.',
      );
    }
    if ((isOtherNonQualifying && record?.claimedCtTreatment === 'qualifying')
      || (isQualifyingKind && record?.claimedCtTreatment === 'non_qualifying' && !PE_SCOPES.has(record?.counterpartyScope))) {
      addError(errors, AE_CT_REFUSAL_CODES.SOURCE_POLICY_DRIFT, `${recordPath}.claimedCtTreatment`, 'The treatment conflicts with the sourced bounded activity category.');
    }
    if (PE_SCOPES.has(record?.counterpartyScope) !== (record?.claimedCtTreatment === 'permanent_establishment_separate')) {
      addError(errors, 'AE_CT_PE_INCOME_SEPARATION_REQUIRED', recordPath, 'Domestic and foreign permanent-establishment income must stay outside the ordinary QFZP income pool.');
    }

    const relatedParty = record?.relatedParty;
    if (!isPlainObject(relatedParty) || !RELATED_PARTY_STATUSES.has(relatedParty.status)) {
      addError(
        errors,
        AE_CT_REFUSAL_CODES.RELATED_PARTY_FACT_REQUIRED,
        `${recordPath}.relatedParty`,
        'Every income fact needs a separate sourced related-party status.',
      );
    } else {
      validateEffectiveFact(relatedParty, period, `${recordPath}.relatedParty`, POLICY.CT_LAW, sources, evidence, errors);
      if (record?.activityKind === 'headquarters_services_to_related_parties'
        && relatedParty.status === 'not_related_party') {
        addError(
          errors,
          'AE_CT_RELATED_PARTY_FACT_CONFLICT',
          `${recordPath}.relatedParty.status`,
          'Headquarters services selected under the related-party activity category require a related-party fact.',
        );
      }
    }

    const vatFact = validateVatFact(record?.vat, period, `${recordPath}.vat`, sources, evidence, context, errors);
    return {
      id: record?.id,
      amountFils,
      activityKind: record?.activityKind,
      counterpartyScope: record?.counterpartyScope,
      claimedCtTreatment: record?.claimedCtTreatment,
      relatedPartyStatus: relatedParty?.status,
      vat: vatFact,
    };
  });
}

function validateVatFact(vat, period, path, sources, evidence, context, errors) {
  if (!isPlainObject(vat)) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, 'Each income fact needs a separate sourced VAT supply-kind fact.');
    return null;
  }
  validateEffectiveFact(vat, period, path, POLICY.VAT_DESIGNATED_ZONES, sources, evidence, errors);
  if (!['goods', 'service'].includes(vat.supplyKind)) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, `${path}.supplyKind`, 'Expected goods or service.');
  }
  const designated = context?.designatedZone?.status === 'designated';
  const expectedTreatment = vat.supplyKind === 'service' || !designated
    ? 'normal_uae_vat_rules'
    : 'designated_zone_goods_conditions_required';
  if (vat.treatmentBasis !== expectedTreatment) {
    addError(
      errors,
      AE_CT_REFUSAL_CODES.VAT_AXIS_CONTAMINATION,
      `${path}.treatmentBasis`,
      'CT/QFZP status and VAT designated-zone goods treatment are independent; services always use the normal UAE VAT rules.',
    );
  }
  return {
    supplyKind: vat.supplyKind,
    designatedZoneStatus: context?.designatedZone?.status ?? 'unknown',
    treatment: expectedTreatment,
  };
}

function validateEffectiveFact(record, period, path, expectedPolicyId, sources, evidence, errors) {
  if (!isPlainObject(record)
    || !isIsoDay(record.effectiveFrom)
    || (record.effectiveTo !== null && record.effectiveTo !== undefined && !isIsoDay(record.effectiveTo))) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, 'An effective-dated fact is required.');
    return;
  }
  if (!coversPeriod(record, period)) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, `The fact must cover all of ${period.periodKey}.`);
  }
  if (record.policySourceId !== expectedPolicyId || !sources.has(record.policySourceId)) {
    addError(errors, AE_CT_REFUSAL_CODES.SOURCE_POLICY_DRIFT, `${path}.policySourceId`, `Expected ${expectedPolicyId}.`);
  }
  if (typeof record.sourceArtifactId !== 'string'
    || !evidence.artifacts.has(record.sourceArtifactId)
    || !(evidence.observedByArtifact.get(record.sourceArtifactId) || []).some((date) => date <= evidence.onDate)) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, `${path}.sourceArtifactId`, 'The fact needs evidence observed by the world effective date.');
  }
}

function validateAndExpandBoundarySets(worldSpec, sources, errors) {
  if (worldSpec.deMinimisBoundarySets === undefined) return [];
  const sets = worldSpec.deMinimisBoundarySets;
  if (!Array.isArray(sets) || sets.length !== 2) {
    addError(errors, 'AE_CT_DE_MINIMIS_BOUNDARIES_INCOMPLETE', 'deMinimisBoundarySets', 'Both lower-limb boundary sets are required.');
    return [];
  }
  const cases = expandAeDeMinimisBoundarySets(sets);
  const limbs = new Set(cases.map(({ lowerLimb }) => lowerLimb));
  if (!limbs.has('five_percent') || !limbs.has('aed_5_million')) {
    addError(errors, 'AE_CT_DE_MINIMIS_LIMBS_INCOMPLETE', 'deMinimisBoundarySets', 'The matrix must exercise both statutory lower limbs.');
  }
  for (const [index, set] of sets.entries()) {
    const path = set?.caseSetId ? `deMinimisBoundarySets.${set.caseSetId}` : `deMinimisBoundarySets[${index}]`;
    if (set?.policySourceId !== POLICY.ACTIVITIES || !sources.has(set.policySourceId)) {
      addError(errors, AE_CT_REFUSAL_CODES.SOURCE_POLICY_DRIFT, `${path}.policySourceId`, `Expected ${POLICY.ACTIVITIES}.`);
    }
    if (parseAedToFils(set?.totalRelevantRevenueAed) === null) {
      addError(errors, 'AE_CT_MONEY_INVALID', `${path}.totalRelevantRevenueAed`, 'Use exact AED and fils.');
    }
    const deltas = Array.isArray(set?.deltasFils) ? set.deltasFils : [];
    if (deltas.length !== 3 || ![-1, 0, 1].every((delta) => deltas.includes(delta))) {
      addError(errors, 'AE_CT_DE_MINIMIS_BOUNDARIES_INCOMPLETE', `${path}.deltasFils`, 'Require exact −1 fils, exact, and +1 fils cases.');
    }
  }
  return cases;
}

function validateSbrPeriods({ worldSpec, sources, evidence, errors }) {
  if (worldSpec.smallBusinessReliefPeriods === undefined) return [];
  if (!Array.isArray(worldSpec.smallBusinessReliefPeriods) || worldSpec.smallBusinessReliefPeriods.length === 0) {
    addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, 'smallBusinessReliefPeriods', 'SBR periods must be a non-empty array.');
    return [];
  }
  return [...worldSpec.smallBusinessReliefPeriods]
    .sort((left, right) => String(left?.endsOn || '').localeCompare(String(right?.endsOn || '')))
    .map((period, index) => {
      const path = period?.periodKey ? `smallBusinessReliefPeriods.${period.periodKey}` : `smallBusinessReliefPeriods[${index}]`;
      if (!isIsoDay(period?.startsOn) || !isIsoDay(period?.endsOn) || period.endsOn < period.startsOn) {
        addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, path, 'Ordered ISO SBR period dates are required.');
      }
      const fact = period?.fact;
      validateEffectiveFact(fact, period, `${path}.fact`, POLICY.SBR_EXTENSION, sources, evidence, errors);
      if (fact?.basePolicySourceId !== POLICY.SBR_BASE) {
        addError(errors, AE_CT_REFUSAL_CODES.SOURCE_POLICY_DRIFT, `${path}.fact.basePolicySourceId`, `Expected ${POLICY.SBR_BASE}.`);
      }
      const revenueFils = parseAedToFils(fact?.revenueAed);
      if (revenueFils === null) addError(errors, 'AE_CT_MONEY_INVALID', `${path}.fact.revenueAed`, 'Use exact AED and fils.');
      if (![true, false, 'unknown'].includes(fact?.priorPeriodsAtOrBelowThreshold)
        || !['qfzp', 'not_qfzp', 'unknown'].includes(fact?.qfzpStatus)
        || !['member', 'not_member', 'unknown'].includes(fact?.mneGroupStatus)
        || !['elected', 'not_elected', 'unknown'].includes(fact?.election)) {
        addError(errors, AE_CT_REFUSAL_CODES.PERIOD_FACT_REQUIRED, `${path}.fact`, 'SBR needs explicit revenue-history, QFZP, and MNE facts.');
      }
      validateElectionReceipt(fact?.electionReceipt, fact, `${path}.fact.electionReceipt`, evidence, errors);
      return {
        periodKey: period?.periodKey,
        startsOn: period?.startsOn,
        endsOn: period?.endsOn,
        revenueFils,
        priorPeriodsAtOrBelowThreshold: fact?.priorPeriodsAtOrBelowThreshold,
        qfzpStatus: fact?.qfzpStatus,
        mneGroupStatus: fact?.mneGroupStatus,
        election: fact?.election,
      };
    });
}

function projectCorporatePeriods(periods, breachConsequence, errors) {
  const breachWindow = new Map();
  for (const [index, period] of periods.entries()) {
    if (period.unknownConditions.length > 0) continue;
    const directBreach = period.failedConditions.length > 0 || period.deMinimis.status === 'breached';
    if (!directBreach || breachWindow.has(index)) continue;
    if (index + 4 >= periods.length) {
      addError(
        errors,
        AE_CT_REFUSAL_CODES.BREACH_HORIZON_INCOMPLETE,
        `corporateTaxPeriods.${period.periodKey}`,
        'The fixture must expose the breach period and four successor tax periods.',
      );
      continue;
    }
    for (let offset = 0; offset < breachConsequence.currentAndFollowingTaxPeriods; offset += 1) {
      breachWindow.set(index + offset, { breachPeriodKey: period.periodKey, offset });
    }
  }
  if (errors.length > 0) return [];

  return periods.map((period, index) => {
    const breach = breachWindow.get(index);
    const vatAxes = period.income.map((income) => ({
      incomeFactId: income.id,
      ctIncomeTreatment: income.claimedCtTreatment,
      vatSupplyKind: income.vat?.supplyKind,
      vatDesignatedZoneStatus: income.vat?.designatedZoneStatus,
      vatTreatment: income.vat?.treatment,
    }));
    if (breach) {
      return {
        periodKey: period.periodKey,
        startsOn: period.startsOn,
        endsOn: period.endsOn,
        qfzpStatus: breach.offset === 0 ? 'ceased_from_period_start' : 'not_qualifying_breach_carryforward',
        breachPeriodKey: breach.breachPeriodKey,
        breachOffset: breach.offset,
        deMinimis: period.deMinimis,
        incomeByScope: period.incomeByScope,
        vatAxes,
        terminalState: { state: 'auto_reconciled', authority: 'oracle_projection_only' },
      };
    }
    if (period.unknownConditions.length > 0) {
      return {
        periodKey: period.periodKey,
        startsOn: period.startsOn,
        endsOn: period.endsOn,
        qfzpStatus: 'unassured',
        deMinimis: period.deMinimis,
        incomeByScope: period.incomeByScope,
        vatAxes,
        terminalState: {
          state: 'blocked',
          responsibleActor: 'owner',
          missingFacts: period.unknownConditions,
          nextPermittedAction: 'request_missing_tax_period_fact',
        },
      };
    }
    return {
      periodKey: period.periodKey,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      qfzpStatus: 'qualifying_free_zone_person',
      deMinimis: period.deMinimis,
      incomeByScope: period.incomeByScope,
      vatAxes,
      terminalState: { state: 'auto_reconciled', authority: 'oracle_projection_only' },
    };
  });
}

function projectSbrPeriods(periods) {
  return periods.map((period) => {
    const unknown = period.revenueFils === null
      || period.priorPeriodsAtOrBelowThreshold === 'unknown'
      || period.qfzpStatus === 'unknown'
      || period.mneGroupStatus === 'unknown';
    if (unknown) {
      return {
        periodKey: period.periodKey,
        reliefStatus: 'unassured',
        terminalState: {
          state: 'blocked',
          responsibleActor: 'owner',
          nextPermittedAction: 'request_missing_sbr_fact',
        },
      };
    }
    const withinWindow = period.startsOn >= '2023-06-01' && period.endsOn <= '2029-12-31';
    const conditionsMet = period.revenueFils <= AED_3_MILLION_FILS
      && period.priorPeriodsAtOrBelowThreshold === true
      && period.qfzpStatus === 'not_qfzp'
      && period.mneGroupStatus === 'not_member'
      && period.election === 'elected';
    return {
      periodKey: period.periodKey,
      reliefStatus: withinWindow && conditionsMet ? 'available' : 'not_available',
      effectiveWindowStatus: withinWindow ? 'inside_current_window' : 'outside_current_window',
      sourcePolicyId: POLICY.SBR_EXTENSION,
      terminalState: { state: 'auto_reconciled', authority: 'oracle_projection_only' },
    };
  });
}

function deMinimisThreshold(totalRelevantRevenueFils) {
  const percentageFils = (totalRelevantRevenueFils * 5n) / 100n;
  const usePercentage = percentageFils <= AED_5_MILLION_FILS;
  return {
    percentageFils,
    thresholdFils: usePercentage ? percentageFils : AED_5_MILLION_FILS,
    lowerLimb: usePercentage ? 'five_percent' : 'aed_5_million',
  };
}

function buildEvidenceIndex(worldSpec) {
  const artifacts = new Map((worldSpec?.artifacts || []).map((artifact) => [artifact.id, artifact]));
  const observedByArtifact = new Map();
  for (const observation of worldSpec?.observations || []) {
    if (!observation?.artifactId || !isIsoDay(observation.observedAt)) continue;
    if (!observedByArtifact.has(observation.artifactId)) observedByArtifact.set(observation.artifactId, []);
    observedByArtifact.get(observation.artifactId).push(observation.observedAt);
  }
  return { artifacts, observedByArtifact, onDate: worldSpec?.effectiveDate };
}

function coversPeriod(record, period) {
  return isPlainObject(record)
    && isIsoDay(record.effectiveFrom)
    && record.effectiveFrom <= period.startsOn
    && (record.effectiveTo === null || record.effectiveTo === undefined || record.effectiveTo >= period.endsOn);
}

function parseAedToFils(value) {
  const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return BigInt(match[1]) * 100n + BigInt(match[2]);
}

function formatFils(value) {
  if (typeof value !== 'bigint' || value < 0n) return null;
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function boundaryLabel(deltaFils) {
  if (deltaFils === -1) return 'minus_one_fils';
  if (deltaFils === 0) return 'exact';
  if (deltaFils === 1) return 'plus_one_fils';
  return `delta_${deltaFils}_fils`;
}

function isIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && utcIsoDay(parsed) === value;
}

function addError(errors, code, path, message) {
  errors.push({ code, path, message });
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
