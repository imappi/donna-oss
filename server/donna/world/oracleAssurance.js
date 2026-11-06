import { createHash, createPublicKey, verify } from 'node:crypto';
import { utcIsoDay } from './utcDay.js';

export const ORACLE_ASSURANCE_VERSION = 'eaw.oracle-assurance.v1';
export const REVIEWER_ARRANGEMENT_VERSION = 'eaw.reviewer-arrangement.v1';
export const ORACLE_ASSURANCE_LEVEL = 'independent_practitioner_blind_review';
export const AWAITING_INDEPENDENT_REVIEW = 'awaiting_independent_review';

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DISALLOWED_REVIEWER_IDENTITY = /(?:\bcodex\b|\bchatgpt\b|\bgpt(?:[-\s]|$)|\bclaude\b|\blanguage model\b|\bmodel\b)/i;
const REQUIRED_REREVIEW_TRIGGERS = Object.freeze([
  'policy_version_change',
  'oracle_version_change',
  'new_or_reopened_oracle_gap',
  'competence_or_identity_change',
]);

const TOP_LEVEL_KEYS = new Set([
  'version', 'recordId', 'recordPurpose', 'assuranceLevel', 'reviewBasis',
  'supplementalSignals', 'practitioner', 'competence', 'reviewedPolicy',
  'blindReview', 'legitimateAlternatives', 'disagreements', 'oracleGapFindings',
  'decision', 'reReview', 'signature', 'reviewDigest',
]);

export function canonicalOracleAssuranceJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalOracleAssuranceJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalOracleAssuranceJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('oracle assurance canonical JSON supports only finite JSON values');
}

export function computePractitionerIdentityDigest(practitioner) {
  if (!isPlainObject(practitioner)) throw new TypeError('practitioner must be an object');
  const { identityDigest: _ignored, ...identity } = practitioner;
  return sha256(canonicalOracleAssuranceJson(identity));
}

export function computeBlindSampleDigest(cases) {
  if (!Array.isArray(cases)) throw new TypeError('blind cases must be an array');
  return sha256(canonicalOracleAssuranceJson(cases));
}

export function computeOracleAssuranceDigest(record) {
  if (!isPlainObject(record)) throw new TypeError('oracle assurance record must be an object');
  const { reviewDigest: _digest, signature: _signature, ...reviewedContent } = record;
  return sha256(canonicalOracleAssuranceJson(reviewedContent));
}

export function createNonSigningOracleAssuranceRecord(input) {
  const record = cloneJson({
    ...input,
    version: ORACLE_ASSURANCE_VERSION,
    recordPurpose: 'synthetic_shape_non_signing',
    signature: null,
  });
  if (isPlainObject(record.practitioner)) {
    record.practitioner.identityDigest = computePractitionerIdentityDigest(record.practitioner);
  }
  if (isPlainObject(record.blindReview) && Array.isArray(record.blindReview.cases)) {
    record.blindReview.sampleDigest = computeBlindSampleDigest(record.blindReview.cases);
  }
  record.reviewDigest = computeOracleAssuranceDigest(record);
  return deepFreeze(record);
}

export function validateOracleAssuranceRecord(record, { asOfDate, expectedPolicy } = {}) {
  const errors = [];
  if (!isPlainObject(record)) return result(['record must be an object']);
  unsupportedKeys(record, TOP_LEVEL_KEYS, 'record', errors);

  if (record.version !== ORACLE_ASSURANCE_VERSION) errors.push(`version must be ${ORACLE_ASSURANCE_VERSION}`);
  requiredString(record.recordId, 'recordId', errors);
  if (!['real_practitioner_review', 'synthetic_shape_non_signing'].includes(record.recordPurpose)) {
    errors.push('recordPurpose must be real_practitioner_review or synthetic_shape_non_signing');
  }
  if (record.assuranceLevel !== ORACLE_ASSURANCE_LEVEL) {
    errors.push(`assuranceLevel must remain ${ORACLE_ASSURANCE_LEVEL}; assurance cannot be lowered`);
  }
  if (record.reviewBasis !== 'independent_practitioner_blind_review') {
    errors.push('reviewBasis must be independent_practitioner_blind_review; citations and package comparisons are supplemental only');
  }
  uniqueStrings(record.supplementalSignals, 'supplementalSignals', errors, { allowEmpty: true });

  const asOfValid = validDate(asOfDate, 'asOfDate', errors);
  validatePractitioner(record.practitioner, asOfValid ? asOfDate : null, errors);
  validateCompetence(record.competence, expectedPolicy, asOfValid ? asOfDate : null, errors);
  validateReviewedPolicy(record.reviewedPolicy, expectedPolicy, errors);
  const blindCaseIds = validateBlindReview(record.blindReview, errors);
  validateAlternatives(record.legitimateAlternatives, blindCaseIds, errors);
  validateDisagreements(record.disagreements, blindCaseIds, errors);
  validateOracleGaps(record.oracleGapFindings, blindCaseIds, record.reReview, errors);
  validateDecision(record.decision, asOfValid ? asOfDate : null, errors);
  validateReReview(record.reReview, record.decision, asOfValid ? asOfDate : null, errors);
  validateTemporalConsistency(record, errors);
  validateSignatureShape(record.signature, record.reviewDigest, record.decision, errors);

  if (!SHA256.test(record.reviewDigest ?? '')) errors.push('reviewDigest must be a lowercase SHA-256 digest');
  else {
    try {
      if (computeOracleAssuranceDigest(record) !== record.reviewDigest) errors.push('reviewDigest does not match the complete reviewed content');
    } catch {
      errors.push('reviewed content must contain only canonical JSON values');
    }
  }
  return result(errors);
}

export function verifyOracleAssuranceSignature(record, reviewerArrangement, { asOfDate } = {}) {
  const errors = validateReviewerArrangement(reviewerArrangement, record, asOfDate);
  if (errors.length > 0) return { ok: false, errors };
  if (!isPlainObject(record?.signature)) return { ok: false, errors: ['independent practitioner signature is absent'] };
  try {
    const publicKey = createPublicKey(reviewerArrangement.publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return { ok: false, errors: ['reviewer public key must be Ed25519'] };
    const signature = decodeCanonicalBase64(record.signature.value);
    const ok = verify(null, Buffer.from(record.reviewDigest, 'hex'), publicKey, signature);
    return ok ? { ok: true, errors: [] } : { ok: false, errors: ['independent practitioner signature verification failed'] };
  } catch {
    return { ok: false, errors: ['independent practitioner signature or public key is malformed'] };
  }
}

export function evaluateOracleAssuranceGate(record, options = {}) {
  const validation = validateOracleAssuranceRecord(record, options);
  const refusalReasons = [...validation.errors];

  if (validation.ok && record.recordPurpose !== 'real_practitioner_review') {
    refusalReasons.push('synthetic shape is explicitly non-signing and cannot satisfy practitioner assurance');
  }
  if (validation.ok && record.signature === null) {
    refusalReasons.push('independent practitioner signature is absent');
  }

  let signatureVerification = { ok: false, errors: [] };
  if (validation.ok && record.recordPurpose === 'real_practitioner_review' && record.signature !== null) {
    signatureVerification = verifyOracleAssuranceSignature(record, options.reviewerArrangement, { asOfDate: options.asOfDate });
    refusalReasons.push(...signatureVerification.errors);
  }

  const openGap = validation.ok && record.oracleGapFindings.some((finding) => finding.status === 'open' || finding.severity === 'blocking');
  if (openGap) refusalReasons.push('open or blocking oracle-gap findings prevent assurance');

  const ready = validation.ok
    && record.recordPurpose === 'real_practitioner_review'
    && signatureVerification.ok
    && record.decision.outcome === 'approve'
    && !openGap;

  if (ready) {
    return {
      status: 'ready_for_certification_review',
      gateOpen: true,
      appendixDBox6: 'unticked_eligible_for_certification_review',
      certificationClaim: false,
      refusalReasons: [],
    };
  }

  const signedRefusal = validation.ok
    && record.recordPurpose === 'real_practitioner_review'
    && signatureVerification.ok
    && record.decision.outcome === 'refuse';
  return {
    status: signedRefusal ? 'independent_review_refused' : AWAITING_INDEPENDENT_REVIEW,
    gateOpen: false,
    appendixDBox6: 'refused_unticked',
    certificationClaim: false,
    refusalReasons: [...new Set(refusalReasons)],
  };
}

function validatePractitioner(practitioner, asOfDate, errors) {
  if (!plainObject(practitioner, 'practitioner', errors)) return;
  unsupportedKeys(practitioner, new Set([
    'practitionerId', 'name', 'actorKind', 'organization', 'independence',
    'identityEvidence', 'identityDigest',
  ]), 'practitioner', errors);
  for (const [field, value] of [['practitionerId', practitioner.practitionerId], ['name', practitioner.name], ['organization', practitioner.organization]]) {
    requiredString(value, `practitioner.${field}`, errors);
  }
  if (practitioner.actorKind !== 'human') errors.push('practitioner.actorKind must be human; Codex or a model cannot self-sign');
  const identityText = [practitioner.practitionerId, practitioner.name, practitioner.organization].filter((value) => typeof value === 'string').join(' ');
  if (DISALLOWED_REVIEWER_IDENTITY.test(identityText)) errors.push('practitioner identity cannot name Codex or a model');

  const independence = practitioner.independence;
  if (plainObject(independence, 'practitioner.independence', errors)) {
    unsupportedKeys(independence, new Set(['status', 'declaredAt', 'conflicts']), 'practitioner.independence', errors);
    if (independence.status !== 'independent') errors.push('practitioner independence status must be independent');
    validDate(independence.declaredAt, 'practitioner.independence.declaredAt', errors);
    if (!Array.isArray(independence.conflicts)) errors.push('practitioner.independence.conflicts must be an array');
    else if (independence.conflicts.length > 0) errors.push('declared practitioner conflicts require a new Kari arrangement and cannot pass this gate');
  }

  const evidence = practitioner.identityEvidence;
  if (plainObject(evidence, 'practitioner.identityEvidence', errors)) {
    unsupportedKeys(evidence, new Set(['type', 'issuer', 'credentialRef', 'digest', 'validFrom', 'validThrough']), 'practitioner.identityEvidence', errors);
    for (const field of ['type', 'issuer', 'credentialRef']) requiredString(evidence[field], `practitioner.identityEvidence.${field}`, errors);
    digest(evidence.digest, 'practitioner.identityEvidence.digest', errors);
    const from = validDate(evidence.validFrom, 'practitioner.identityEvidence.validFrom', errors);
    const through = validDate(evidence.validThrough, 'practitioner.identityEvidence.validThrough', errors);
    if (from && through && evidence.validFrom > evidence.validThrough) errors.push('practitioner identity validity period is contradictory');
    if (asOfDate && from && through && !within(asOfDate, evidence.validFrom, evidence.validThrough)) errors.push('practitioner identity evidence is absent, future, or stale for asOfDate');
  }
  digest(practitioner.identityDigest, 'practitioner.identityDigest', errors);
  try {
    if (SHA256.test(practitioner.identityDigest ?? '') && computePractitionerIdentityDigest(practitioner) !== practitioner.identityDigest) {
      errors.push('practitioner.identityDigest does not match identity content');
    }
  } catch {
    errors.push('practitioner identity must be canonical JSON');
  }
}

function validateCompetence(competence, expectedPolicy, asOfDate, errors) {
  if (!plainObject(competence, 'competence', errors)) return;
  unsupportedKeys(competence, new Set(['jurisdictions', 'accountingViews', 'evidenceRef', 'evidenceDigest', 'validFrom', 'validThrough']), 'competence', errors);
  const jurisdictions = uniqueStrings(competence.jurisdictions, 'competence.jurisdictions', errors);
  const views = uniqueStrings(competence.accountingViews, 'competence.accountingViews', errors);
  requiredString(competence.evidenceRef, 'competence.evidenceRef', errors);
  digest(competence.evidenceDigest, 'competence.evidenceDigest', errors);
  const from = validDate(competence.validFrom, 'competence.validFrom', errors);
  const through = validDate(competence.validThrough, 'competence.validThrough', errors);
  if (from && through && competence.validFrom > competence.validThrough) errors.push('competence validity period is contradictory');
  if (asOfDate && from && through && !within(asOfDate, competence.validFrom, competence.validThrough)) errors.push('practitioner competence is absent, future, or stale for asOfDate');
  if (isPlainObject(expectedPolicy)) {
    if (jurisdictions && !competence.jurisdictions.includes(expectedPolicy.jurisdiction)) errors.push('competence does not cover the expected jurisdiction');
    if (views && !competence.accountingViews.includes(expectedPolicy.accountingView)) errors.push('competence does not cover the expected accounting view');
  }
}

function validateReviewedPolicy(reviewedPolicy, expectedPolicy, errors) {
  if (!plainObject(reviewedPolicy, 'reviewedPolicy', errors)) return;
  unsupportedKeys(reviewedPolicy, new Set(['version', 'digest', 'effectiveFrom', 'jurisdiction', 'accountingView', 'reviewedAt']), 'reviewedPolicy', errors);
  for (const field of ['version', 'jurisdiction', 'accountingView']) requiredString(reviewedPolicy[field], `reviewedPolicy.${field}`, errors);
  digest(reviewedPolicy.digest, 'reviewedPolicy.digest', errors);
  const effective = validDate(reviewedPolicy.effectiveFrom, 'reviewedPolicy.effectiveFrom', errors);
  const reviewed = validDate(reviewedPolicy.reviewedAt, 'reviewedPolicy.reviewedAt', errors);
  if (effective && reviewed && reviewedPolicy.reviewedAt < reviewedPolicy.effectiveFrom) errors.push('policy cannot be reviewed before its effective period');

  if (!isPlainObject(expectedPolicy)) {
    errors.push('expectedPolicy must be supplied independently to detect stale or substituted policy');
    return;
  }
  unsupportedKeys(expectedPolicy, new Set(['version', 'digest', 'effectiveFrom', 'jurisdiction', 'accountingView']), 'expectedPolicy', errors);
  for (const field of ['version', 'jurisdiction', 'accountingView']) requiredString(expectedPolicy[field], `expectedPolicy.${field}`, errors);
  digest(expectedPolicy.digest, 'expectedPolicy.digest', errors);
  validDate(expectedPolicy.effectiveFrom, 'expectedPolicy.effectiveFrom', errors);
  for (const field of ['version', 'digest', 'effectiveFrom', 'jurisdiction', 'accountingView']) {
    if (reviewedPolicy[field] !== expectedPolicy[field]) errors.push(`reviewedPolicy.${field} does not match the independently expected policy`);
  }
}

function validateBlindReview(blindReview, errors) {
  const caseIds = new Set();
  if (!plainObject(blindReview, 'blindReview', errors)) return caseIds;
  unsupportedKeys(blindReview, new Set(['receiptId', 'resolvedAt', 'solverAnswerAccess', 'answerUnsealedAt', 'cases', 'sampleDigest']), 'blindReview', errors);
  requiredString(blindReview.receiptId, 'blindReview.receiptId', errors);
  const resolved = validDate(blindReview.resolvedAt, 'blindReview.resolvedAt', errors);
  if (blindReview.solverAnswerAccess !== 'not_seen_before_independent_resolution') {
    errors.push('blindReview.solverAnswerAccess must prove the solver answer was not seen before independent resolution');
  }
  const unsealed = blindReview.answerUnsealedAt === null
    ? true
    : validDate(blindReview.answerUnsealedAt, 'blindReview.answerUnsealedAt', errors);
  if (resolved && unsealed && blindReview.answerUnsealedAt !== null && blindReview.answerUnsealedAt < blindReview.resolvedAt) {
    errors.push('solver answer leaked before blind resolution');
  }
  if (!Array.isArray(blindReview.cases) || blindReview.cases.length < 1) {
    errors.push('blindReview.cases must contain at least one independently resolved case');
  } else {
    for (const [index, blindCase] of blindReview.cases.entries()) {
      if (!plainObject(blindCase, `blindReview.cases[${index}]`, errors)) continue;
      unsupportedKeys(blindCase, new Set(['caseId', 'worldDigest', 'independentResolutionDigest', 'resolvedAt']), `blindReview.cases[${index}]`, errors);
      requiredString(blindCase.caseId, `blindReview.cases[${index}].caseId`, errors);
      digest(blindCase.worldDigest, `blindReview.cases[${index}].worldDigest`, errors);
      digest(blindCase.independentResolutionDigest, `blindReview.cases[${index}].independentResolutionDigest`, errors);
      const caseResolved = validDate(blindCase.resolvedAt, `blindReview.cases[${index}].resolvedAt`, errors);
      if (resolved && caseResolved && blindCase.resolvedAt > blindReview.resolvedAt) errors.push(`blindReview.cases[${index}] resolves after the blind-work receipt`);
      if (caseIds.has(blindCase.caseId)) errors.push(`duplicate blind case: ${blindCase.caseId}`);
      caseIds.add(blindCase.caseId);
    }
  }
  digest(blindReview.sampleDigest, 'blindReview.sampleDigest', errors);
  try {
    if (SHA256.test(blindReview.sampleDigest ?? '') && Array.isArray(blindReview.cases)
      && computeBlindSampleDigest(blindReview.cases) !== blindReview.sampleDigest) {
      errors.push('blindReview.sampleDigest does not match the blind case sample');
    }
  } catch {
    errors.push('blind case sample must be canonical JSON');
  }
  return caseIds;
}

function validateAlternatives(alternatives, blindCaseIds, errors) {
  if (!Array.isArray(alternatives)) return errors.push('legitimateAlternatives must be an explicit array');
  const seen = new Set();
  alternatives.forEach((alternative, index) => {
    if (!plainObject(alternative, `legitimateAlternatives[${index}]`, errors)) return;
    unsupportedKeys(alternative, new Set(['caseId', 'alternativeIds', 'classification', 'rationale']), `legitimateAlternatives[${index}]`, errors);
    requiredString(alternative.caseId, `legitimateAlternatives[${index}].caseId`, errors);
    const ids = uniqueStrings(alternative.alternativeIds, `legitimateAlternatives[${index}].alternativeIds`, errors);
    if (ids && alternative.alternativeIds.length < 2) errors.push(`legitimateAlternatives[${index}] must name at least two treatments`);
    if (!['legitimate', 'not_legitimate'].includes(alternative.classification)) errors.push(`legitimateAlternatives[${index}].classification is invalid`);
    requiredString(alternative.rationale, `legitimateAlternatives[${index}].rationale`, errors);
    if (!blindCaseIds.has(alternative.caseId)) errors.push(`legitimateAlternatives[${index}] refers to a case outside the blind sample`);
    if (seen.has(alternative.caseId)) errors.push(`duplicate legitimate-alternative disposition for ${alternative.caseId}`);
    seen.add(alternative.caseId);
  });
}

function validateDisagreements(disagreements, blindCaseIds, errors) {
  if (!Array.isArray(disagreements)) return errors.push('disagreements must be an explicit array');
  const seen = new Set();
  const dispositions = new Set(['oracle_amended', 'alternative_admitted', 'reviewer_position_adopted', 'no_change_with_rationale']);
  disagreements.forEach((disagreement, index) => {
    if (!plainObject(disagreement, `disagreements[${index}]`, errors)) return;
    unsupportedKeys(disagreement, new Set(['disagreementId', 'caseId', 'alternativeIds', 'disposition', 'rationale']), `disagreements[${index}]`, errors);
    requiredString(disagreement.disagreementId, `disagreements[${index}].disagreementId`, errors);
    requiredString(disagreement.caseId, `disagreements[${index}].caseId`, errors);
    uniqueStrings(disagreement.alternativeIds, `disagreements[${index}].alternativeIds`, errors);
    if (!dispositions.has(disagreement.disposition)) errors.push(`disagreements[${index}] requires a final disposition`);
    requiredString(disagreement.rationale, `disagreements[${index}].rationale`, errors);
    if (!blindCaseIds.has(disagreement.caseId)) errors.push(`disagreements[${index}] refers to a case outside the blind sample`);
    if (seen.has(disagreement.disagreementId)) errors.push(`duplicate disagreement: ${disagreement.disagreementId}`);
    seen.add(disagreement.disagreementId);
  });
}

function validateOracleGaps(findings, blindCaseIds, reReview, errors) {
  if (!Array.isArray(findings)) return errors.push('oracleGapFindings must be an explicit array');
  const triggers = new Set(Array.isArray(reReview?.triggers) ? reReview.triggers : []);
  const seen = new Set();
  findings.forEach((finding, index) => {
    if (!plainObject(finding, `oracleGapFindings[${index}]`, errors)) return;
    unsupportedKeys(finding, new Set(['findingId', 'caseId', 'severity', 'status', 'disposition', 'reReviewTrigger']), `oracleGapFindings[${index}]`, errors);
    requiredString(finding.findingId, `oracleGapFindings[${index}].findingId`, errors);
    requiredString(finding.caseId, `oracleGapFindings[${index}].caseId`, errors);
    if (!['low', 'moderate', 'high', 'blocking'].includes(finding.severity)) errors.push(`oracleGapFindings[${index}].severity is invalid`);
    if (!['open', 'resolved', 'accepted_limitation'].includes(finding.status)) errors.push(`oracleGapFindings[${index}].status is invalid`);
    requiredString(finding.disposition, `oracleGapFindings[${index}].disposition`, errors);
    requiredString(finding.reReviewTrigger, `oracleGapFindings[${index}].reReviewTrigger`, errors);
    if (!blindCaseIds.has(finding.caseId)) errors.push(`oracleGapFindings[${index}] refers to a case outside the blind sample`);
    if (typeof finding.reReviewTrigger === 'string' && !triggers.has(finding.reReviewTrigger)) errors.push(`oracleGapFindings[${index}] re-review trigger is not declared`);
    if (finding.severity === 'blocking' && finding.status === 'accepted_limitation') errors.push('a blocking oracle gap cannot be accepted as a limitation');
    if (seen.has(finding.findingId)) errors.push(`duplicate oracle gap finding: ${finding.findingId}`);
    seen.add(finding.findingId);
  });
}

function validateDecision(decision, asOfDate, errors) {
  if (!plainObject(decision, 'decision', errors)) return;
  unsupportedKeys(decision, new Set(['outcome', 'decidedAt', 'effectiveFrom', 'effectiveThrough', 'rationale']), 'decision', errors);
  if (!['approve', 'refuse'].includes(decision.outcome)) errors.push('decision.outcome must be approve or refuse');
  const decided = validDate(decision.decidedAt, 'decision.decidedAt', errors);
  const from = validDate(decision.effectiveFrom, 'decision.effectiveFrom', errors);
  const through = validDate(decision.effectiveThrough, 'decision.effectiveThrough', errors);
  requiredString(decision.rationale, 'decision.rationale', errors);
  if (decided && from && decision.effectiveFrom < decision.decidedAt) errors.push('decision cannot become effective before it is made');
  if (from && through && decision.effectiveFrom > decision.effectiveThrough) errors.push('decision effective period is contradictory');
  if (asOfDate && from && through && !within(asOfDate, decision.effectiveFrom, decision.effectiveThrough)) errors.push('decision is not effective for asOfDate');
}

function validateReReview(reReview, decision, asOfDate, errors) {
  if (!plainObject(reReview, 'reReview', errors)) return;
  unsupportedKeys(reReview, new Set(['noLaterThan', 'triggers']), 'reReview', errors);
  const noLater = validDate(reReview.noLaterThan, 'reReview.noLaterThan', errors);
  const triggers = uniqueStrings(reReview.triggers, 'reReview.triggers', errors);
  if (triggers) for (const trigger of REQUIRED_REREVIEW_TRIGGERS) if (!reReview.triggers.includes(trigger)) errors.push(`reReview.triggers must include ${trigger}`);
  if (noLater && validDateValue(decision?.effectiveThrough) && reReview.noLaterThan > decision.effectiveThrough) {
    errors.push('reReview.noLaterThan cannot silently extend beyond the decision effective period');
  }
  if (asOfDate && noLater && asOfDate > reReview.noLaterThan) errors.push('re-review deadline is stale for asOfDate');
}

function validateTemporalConsistency(record, errors) {
  const reviewedAt = record.reviewedPolicy?.reviewedAt;
  const policyEffectiveFrom = record.reviewedPolicy?.effectiveFrom;
  const blindResolved = record.blindReview?.resolvedAt;
  const decidedAt = record.decision?.decidedAt;
  if (validDateValue(reviewedAt) && validDateValue(decidedAt) && reviewedAt > decidedAt) errors.push('policy review occurs after the recorded decision');
  if (validDateValue(blindResolved) && validDateValue(decidedAt) && blindResolved > decidedAt) errors.push('blind resolution occurs after the recorded decision');
  if (validDateValue(blindResolved) && validDateValue(policyEffectiveFrom) && blindResolved < policyEffectiveFrom) errors.push('blind-work receipt predates the reviewed policy effective period');
  if (validDateValue(record.practitioner?.independence?.declaredAt) && validDateValue(decidedAt)
    && record.practitioner.independence.declaredAt > decidedAt) errors.push('independence declaration occurs after the recorded decision');
  for (const [date, label] of [[blindResolved, 'blind resolution'], [reviewedAt, 'policy review'], [decidedAt, 'decision']]) {
    if (validDateValue(date)
      && validDateValue(record.competence?.validFrom)
      && validDateValue(record.competence?.validThrough)
      && !within(date, record.competence.validFrom, record.competence.validThrough)) {
      errors.push(`${label} falls outside the practitioner competence period`);
    }
    if (validDateValue(date)
      && validDateValue(record.practitioner?.identityEvidence?.validFrom)
      && validDateValue(record.practitioner?.identityEvidence?.validThrough)
      && !within(date, record.practitioner.identityEvidence.validFrom, record.practitioner.identityEvidence.validThrough)) {
      errors.push(`${label} falls outside the practitioner identity period`);
    }
  }
}

function validateSignatureShape(signature, reviewDigest, decision, errors) {
  if (signature === null) return;
  if (!plainObject(signature, 'signature', errors)) return;
  unsupportedKeys(signature, new Set(['algorithm', 'keyId', 'signedDigest', 'value', 'signedAt']), 'signature', errors);
  if (signature.algorithm !== 'ed25519') errors.push('signature.algorithm must be ed25519');
  requiredString(signature.keyId, 'signature.keyId', errors);
  digest(signature.signedDigest, 'signature.signedDigest', errors);
  if (SHA256.test(signature.signedDigest ?? '') && signature.signedDigest !== reviewDigest) errors.push('signature.signedDigest must equal reviewDigest');
  if (typeof signature.value !== 'string' || !isCanonicalBase64(signature.value)) errors.push('signature.value must be canonical base64');
  const signed = validDate(signature.signedAt, 'signature.signedAt', errors);
  if (signed && validDateValue(decision?.decidedAt) && signature.signedAt < decision.decidedAt) errors.push('signature predates the practitioner decision');
  if (signed && validDateValue(decision?.effectiveThrough) && signature.signedAt > decision.effectiveThrough) errors.push('signature postdates the decision effective period');
}

function validateReviewerArrangement(arrangement, record, asOfDate) {
  const errors = [];
  if (!isPlainObject(arrangement)) return ['Kari reviewer arrangement is absent'];
  unsupportedKeys(arrangement, new Set([
    'version', 'decisionId', 'decidedBy', 'decidedAt', 'practitionerId',
    'reviewerIdentityDigest', 'keyId', 'publicKeyPem', 'validFrom', 'validThrough',
  ]), 'reviewerArrangement', errors);
  if (arrangement.version !== REVIEWER_ARRANGEMENT_VERSION) errors.push(`reviewerArrangement.version must be ${REVIEWER_ARRANGEMENT_VERSION}`);
  requiredString(arrangement.decisionId, 'reviewerArrangement.decisionId', errors);
  if (arrangement.decidedBy !== 'Kari') errors.push('reviewer arrangement must be Kari\'s dated decision');
  const decided = validDate(arrangement.decidedAt, 'reviewerArrangement.decidedAt', errors);
  const from = validDate(arrangement.validFrom, 'reviewerArrangement.validFrom', errors);
  const through = validDate(arrangement.validThrough, 'reviewerArrangement.validThrough', errors);
  requiredString(arrangement.publicKeyPem, 'reviewerArrangement.publicKeyPem', errors);
  if (decided && from && arrangement.decidedAt > arrangement.validFrom) errors.push('reviewer arrangement cannot start before Kari decides it');
  if (from && through && arrangement.validFrom > arrangement.validThrough) errors.push('reviewer arrangement validity period is contradictory');
  if (validDateValue(asOfDate) && from && through && !within(asOfDate, arrangement.validFrom, arrangement.validThrough)) errors.push('Kari reviewer arrangement is future or stale for asOfDate');
  if (validDateValue(record?.decision?.decidedAt) && from && through
    && !within(record.decision.decidedAt, arrangement.validFrom, arrangement.validThrough)) errors.push('practitioner decision falls outside Kari reviewer arrangement');
  if (validDateValue(record?.signature?.signedAt) && from && through
    && !within(record.signature.signedAt, arrangement.validFrom, arrangement.validThrough)) errors.push('practitioner signature falls outside Kari reviewer arrangement');
  if (arrangement.practitionerId !== record?.practitioner?.practitionerId) errors.push('reviewer arrangement practitioner does not match the record');
  digest(arrangement.reviewerIdentityDigest, 'reviewerArrangement.reviewerIdentityDigest', errors);
  if (arrangement.reviewerIdentityDigest !== record?.practitioner?.identityDigest) errors.push('reviewer arrangement identity digest does not match the practitioner');
  requiredString(arrangement.keyId, 'reviewerArrangement.keyId', errors);
  if (arrangement.keyId !== record?.signature?.keyId) errors.push('reviewer arrangement key does not match the signature');
  return errors;
}

function unsupportedKeys(object, allowed, path, errors) {
  for (const key of Object.keys(object)) if (!allowed.has(key)) errors.push(`${path} unsupported field: ${key}`);
}
function requiredString(value, field, errors) { if (typeof value !== 'string' || value.trim() === '') errors.push(`${field} must be a non-empty string`); }
function digest(value, field, errors) { if (!SHA256.test(value ?? '')) errors.push(`${field} must be a lowercase SHA-256 digest`); }
function uniqueStrings(value, field, errors, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || item.trim() === '') || new Set(value).size !== value.length) {
    errors.push(`${field} must be ${allowEmpty ? 'a' : 'a non-empty'} unique string array`);
    return false;
  }
  return true;
}
function validDate(value, field, errors) {
  if (!validDateValue(value)) { errors.push(`${field} must be a real YYYY-MM-DD date`); return false; }
  return true;
}
function validDateValue(value) {
  return typeof value === 'string' && ISO_DATE.test(value)
    && utcIsoDay(new Date(`${value}T00:00:00.000Z`)) === value;
}
function within(value, from, through) { return value >= from && value <= through; }
function plainObject(value, field, errors) { if (!isPlainObject(value)) { errors.push(`${field} must be an object`); return false; } return true; }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
function isCanonicalBase64(value) { try { return decodeCanonicalBase64(value).toString('base64') === value; } catch { return false; } }
function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new TypeError('invalid base64');
  return Buffer.from(value, 'base64');
}
function result(errors) { return { ok: errors.length === 0, version: ORACLE_ASSURANCE_VERSION, errors }; }
