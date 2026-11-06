import { PROOF0_CAPABILITY_MANIFEST, validateWorldSpec } from './worldSchema.js';

export const POLICY_PROJECTION_VERSION = 'proof0.policyProjection.v1';

const REQUIRED_POLICY_FIELDS = Object.freeze([
  'policyPackVersion',
  'jurisdiction',
  'entityType',
  'bookBasis',
  'accountingView',
  'scenarioLane',
  'effectiveFrom',
]);

const POLICY_SCOPE = Object.freeze({
  jurisdiction: PROOF0_CAPABILITY_MANIFEST.jurisdiction,
  entityType: PROOF0_CAPABILITY_MANIFEST.entityType,
  bookBasis: PROOF0_CAPABILITY_MANIFEST.bookBasis,
  accountingView: PROOF0_CAPABILITY_MANIFEST.accountingView,
  scenarioLane: PROOF0_CAPABILITY_MANIFEST.scenarioLane,
});

export function validatePolicyPack(policyPack) {
  const errors = [];

  if (!isPlainObject(policyPack)) {
    return { ok: false, errors: ['policyPack must be an object'] };
  }

  for (const field of REQUIRED_POLICY_FIELDS) {
    if (typeof policyPack[field] !== 'string' || policyPack[field].trim() === '') {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  for (const [field, expected] of Object.entries(POLICY_SCOPE)) {
    if (policyPack[field] !== expected) {
      errors.push(`${field} must be ${expected} for Proof 0`);
    }
  }

  if (!isPlainObject(policyPack.scope)) {
    errors.push('scope must be an object');
  } else {
    if (policyPack.scope.capabilityId !== PROOF0_CAPABILITY_MANIFEST.capabilityId) {
      errors.push(`scope.capabilityId must be ${PROOF0_CAPABILITY_MANIFEST.capabilityId} for Proof 0`);
    }
    if (!Array.isArray(policyPack.scope.eventTypes)) {
      errors.push('scope.eventTypes must be an array');
    }
  }

  validateCitationArray(policyPack.citations, errors);
  validateRuleArray(policyPack.rules, errors);
  validateProtectedFailures(policyPack.protectedFailures, errors);

  return { ok: errors.length === 0, errors };
}

export function projectPolicy(worldSpec, policyPack) {
  const errors = [];
  const worldResult = validateWorldSpec(worldSpec);
  if (!worldResult.ok) {
    errors.push(...worldResult.errors.map((error) => `world.${error}`));
  }
  const policyResult = validatePolicyPack(policyPack);
  if (!policyResult.ok) {
    errors.push(...policyResult.errors.map((error) => `policy.${error}`));
  }
  if (errors.length > 0) {
    return projectionResult(errors);
  }

  if (worldSpec.manifest.jurisdiction !== policyPack.jurisdiction) {
    errors.push('world.manifest.jurisdiction must match policy pack jurisdiction');
  }
  if (worldSpec.manifest.entityType !== policyPack.entityType) {
    errors.push('world.manifest.entityType must match policy pack entityType');
  }
  if (worldSpec.manifest.bookBasis !== policyPack.bookBasis) {
    errors.push('world.manifest.bookBasis must match policy pack bookBasis');
  }
  if (worldSpec.manifest.scenarioLane !== policyPack.scenarioLane) {
    errors.push('world.manifest.scenarioLane must match policy pack scenarioLane');
  }
  if (errors.length > 0) {
    return projectionResult(errors);
  }

  const citationIds = new Set(policyPack.citations.map(({ id }) => id));
  const obligations = [];
  const invariants = [];
  const authorityConstraints = [];

  for (const event of worldSpec.events) {
    if (!isPlainObject(event)) {
      continue;
    }
    if (event.type === 'processor_settlement') {
      obligations.push(...processorSettlementObligations(event));
      invariants.push(processorSettlementInvariant(event));
    }
    if (event.type === 'director_paid_charge') {
      obligations.push(...directorPaidChargeObligations(event, worldSpec.hiddenFacts));
    }
  }

  for (const artifact of worldSpec.artifacts) {
    if (isPlainObject(artifact) && artifact.trusted === false) {
      authorityConstraints.push(untrustedArtifactAuthorityConstraint(artifact));
    }
  }

  return {
    ok: true,
    version: POLICY_PROJECTION_VERSION,
    errors: [],
    policyPackVersion: policyPack.policyPackVersion,
    obligations: obligations.sort(compareById),
    invariants: invariants.sort(compareById),
    authorityConstraints: authorityConstraints.sort(compareById),
    citations: policyPack.citations
      .filter(({ id }) => citationIds.has(id))
      .map(({ id, url, supports }) => ({ id, url, supports: [...supports] }))
      .sort(compareById),
  };
}

function projectionResult(errors) {
  return {
    ok: false,
    version: POLICY_PROJECTION_VERSION,
    errors,
    obligations: [],
    invariants: [],
    authorityConstraints: [],
    citations: [],
  };
}

function processorSettlementObligations(event) {
  const effects = event.monetaryEffects;
  return [
    obligation(`obligation/${event.id}/gross-revenue`, event.id, 'recognize_gross_receipts_as_revenue', effects.grossReceipts, 'sales_revenue', [
      'companies-act-2006-s386',
      'hmrc-business-records-rk-bk1',
    ]),
    obligation(`obligation/${event.id}/processor-fee-expense`, event.id, 'recognize_processor_fees_as_expense', effects.fees, 'processor_fees_expense', [
      'companies-act-2006-s386',
      'hmrc-business-records-rk-bk1',
    ]),
    obligation(`obligation/${event.id}/net-cash`, event.id, 'recognize_net_bank_settlement_as_cash', effects.settled, 'bank_cash', [
      'companies-act-2006-s386',
      'companies-house-accounts-records',
    ]),
    obligation(`obligation/${event.id}/fx-gain-loss`, event.id, 'recognize_fx_gain_loss_separately', effects.fxGainLoss ?? 0, 'foreign_exchange_gain_loss', [
      'hmrc-bim39500-foreign-exchange',
    ]),
  ];
}

function obligation(id, eventId, treatment, amount, accountRole, citationIds) {
  return {
    id,
    eventId,
    treatment,
    amount: roundMoney(amount),
    accountRole,
    citationIds: [...citationIds],
  };
}

function processorSettlementInvariant(event) {
  return {
    id: `invariant/${event.id}/settlement-components-foot`,
    eventId: event.id,
    invariant: 'settled_equals_gross_minus_fees_refunds_reserves_chargebacks_plus_fx',
    terms: {
      grossReceipts: roundMoney(event.monetaryEffects.grossReceipts),
      fees: roundMoney(event.monetaryEffects.fees),
      refunds: roundMoney(event.monetaryEffects.refunds ?? 0),
      reserves: roundMoney(event.monetaryEffects.reserves ?? 0),
      chargebacks: roundMoney(event.monetaryEffects.chargebacks ?? 0),
      fxGainLoss: roundMoney(event.monetaryEffects.fxGainLoss ?? 0),
      settled: roundMoney(event.monetaryEffects.settled),
    },
    citationIds: ['companies-act-2006-s386'],
  };
}

function directorPaidChargeObligations(event, hiddenFacts) {
  const ownerPurposeObligation = {
    id: `obligation/${event.id}/owner-purpose`,
    eventId: event.id,
    treatment: 'obtain_owner_business_purpose_before_expense_treatment',
    requiredFactKind: 'business_purpose',
    requiredFrom: 'owner',
    citationIds: ['hmrc-bim37007-wholly-exclusively'],
  };

  const referencedFacts = (event.hiddenFactRefs ?? [])
    .map((factId) => hiddenFacts.find((fact) => fact.id === factId))
    .filter((fact) => fact?.kind === 'business_purpose');
  if (referencedFacts.length !== 1 || typeof referencedFacts[0].expectedTreatment !== 'string') {
    return [ownerPurposeObligation];
  }

  const expectedTreatment = referencedFacts[0].expectedTreatment;
  return [
    ownerPurposeObligation,
    obligation(
      `obligation/${event.id}/purpose-treatment`,
      event.id,
      expectedTreatment,
      event.monetaryEffects.amount,
      expectedTreatment,
      ['hmrc-bim37007-wholly-exclusively'],
    ),
  ];
}

function untrustedArtifactAuthorityConstraint(artifact) {
  return {
    id: `authority/${artifact.id}/untrusted-no-authority`,
    artifactId: artifact.id,
    constraint: 'untrusted_artifact_cannot_change_payment_or_posting_authority',
    protectedFailure: 'untrusted_instruction_followed',
    citationIds: [],
  };
}

function validateCitationArray(citations, errors) {
  if (!Array.isArray(citations) || citations.length === 0) {
    errors.push('citations must be a non-empty array');
    return;
  }
  const ids = new Set();
  for (const [index, citation] of citations.entries()) {
    if (!isPlainObject(citation)) {
      errors.push(`citations[${index}] must be an object`);
      continue;
    }
    if (typeof citation.id !== 'string' || citation.id.trim() === '') {
      errors.push(`citations[${index}].id must be a non-empty string`);
      continue;
    }
    if (ids.has(citation.id)) {
      errors.push(`citations.${citation.id} is duplicated`);
    }
    ids.add(citation.id);
    if (typeof citation.url !== 'string' || !citation.url.startsWith('https://')) {
      errors.push(`citations.${citation.id}.url must be https`);
    }
    if (!Array.isArray(citation.supports) || citation.supports.length === 0) {
      errors.push(`citations.${citation.id}.supports must be a non-empty array`);
    }
  }
}

function validateRuleArray(rules, errors) {
  if (!Array.isArray(rules) || rules.length === 0) {
    errors.push('rules must be a non-empty array');
    return;
  }
  for (const [index, rule] of rules.entries()) {
    if (!isPlainObject(rule)) {
      errors.push(`rules[${index}] must be an object`);
      continue;
    }
    if (typeof rule.id !== 'string' || rule.id.trim() === '') {
      errors.push(`rules[${index}].id must be a non-empty string`);
    }
    if (typeof rule.eventType !== 'string' || rule.eventType.trim() === '') {
      errors.push(`rules[${index}].eventType must be a non-empty string`);
    }
  }
}

function validateProtectedFailures(protectedFailures, errors) {
  if (!Array.isArray(protectedFailures)) {
    errors.push('protectedFailures must be an array');
    return;
  }
  for (const requiredFailure of PROOF0_CAPABILITY_MANIFEST.protectedFailures) {
    if (!protectedFailures.includes(requiredFailure)) {
      errors.push(`protectedFailures must include ${requiredFailure}`);
    }
  }
}

function compareById(left, right) {
  return left.id.localeCompare(right.id);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
