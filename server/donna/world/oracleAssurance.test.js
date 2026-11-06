import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AWAITING_INDEPENDENT_REVIEW,
  ORACLE_ASSURANCE_LEVEL,
  ORACLE_ASSURANCE_VERSION,
  REVIEWER_ARRANGEMENT_VERSION,
  computeBlindSampleDigest,
  computeOracleAssuranceDigest,
  computePractitionerIdentityDigest,
  createNonSigningOracleAssuranceRecord,
  evaluateOracleAssuranceGate,
  validateOracleAssuranceRecord,
  verifyOracleAssuranceSignature,
} from './oracleAssurance.js';

const POLICY_PATH = 'data/worlds/policy/gb-uk-ltd-management-books-v1.json';
const POLICY_BYTES = readFileSync(POLICY_PATH);
const POLICY = JSON.parse(POLICY_BYTES);
const expectedPolicy = Object.freeze({
  version: POLICY.policyPackVersion,
  digest: createHash('sha256').update(POLICY_BYTES).digest('hex'),
  effectiveFrom: POLICY.effectiveFrom,
  jurisdiction: POLICY.jurisdiction,
  accountingView: POLICY.accountingView,
});
const options = Object.freeze({ asOfDate: '2026-08-09', expectedPolicy });
const hex = (character) => character.repeat(64);

function unsignedInput() {
  return {
    recordId: 'assurance/gb-processor-settlement/v1',
    assuranceLevel: ORACLE_ASSURANCE_LEVEL,
    reviewBasis: 'independent_practitioner_blind_review',
    supplementalSignals: ['authoritative_citations', 'commercial_package_comparison'],
    practitioner: {
      practitionerId: 'practitioner/example-independent-001',
      name: 'Example Independent Practitioner',
      actorKind: 'human',
      organization: 'Example Independent Practice',
      independence: { status: 'independent', declaredAt: '2026-08-01', conflicts: [] },
      identityEvidence: {
        type: 'professional_registry',
        issuer: 'Example registry',
        credentialRef: 'EXAMPLE-001',
        digest: hex('1'),
        validFrom: '2026-01-01',
        validThrough: '2026-12-31',
      },
    },
    competence: {
      jurisdictions: ['GB'],
      accountingViews: ['management_books'],
      evidenceRef: 'competence/example-independent-001',
      evidenceDigest: hex('2'),
      validFrom: '2026-01-01',
      validThrough: '2026-12-31',
    },
    reviewedPolicy: {
      version: expectedPolicy.version,
      digest: expectedPolicy.digest,
      effectiveFrom: expectedPolicy.effectiveFrom,
      jurisdiction: expectedPolicy.jurisdiction,
      accountingView: expectedPolicy.accountingView,
      reviewedAt: '2026-08-08',
    },
    blindReview: {
      receiptId: 'blind-work/example-001',
      resolvedAt: '2026-08-08',
      solverAnswerAccess: 'not_seen_before_independent_resolution',
      answerUnsealedAt: null,
      cases: [{
        caseId: 'slice1/family-2/blind-001',
        worldDigest: hex('3'),
        independentResolutionDigest: hex('4'),
        resolvedAt: '2026-08-08',
      }],
    },
    legitimateAlternatives: [{
      caseId: 'slice1/family-2/blind-001',
      alternativeIds: ['gross-fee-separate', 'gross-fee-netted-clearing'],
      classification: 'legitimate',
      rationale: 'Both preserve gross revenue, fee expense, and settlement footing.',
    }],
    disagreements: [{
      disagreementId: 'disagreement/example-001',
      caseId: 'slice1/family-2/blind-001',
      alternativeIds: ['gross-fee-separate', 'gross-fee-netted-clearing'],
      disposition: 'alternative_admitted',
      rationale: 'The oracle admits both representations as effect-equivalent.',
    }],
    oracleGapFindings: [],
    decision: {
      outcome: 'approve',
      decidedAt: '2026-08-09',
      effectiveFrom: '2026-08-09',
      effectiveThrough: '2026-12-31',
      rationale: 'Synthetic shape only; this is not practitioner approval.',
    },
    reReview: {
      noLaterThan: '2026-12-31',
      triggers: [
        'policy_version_change',
        'oracle_version_change',
        'new_or_reopened_oracle_gap',
        'competence_or_identity_change',
      ],
    },
  };
}

const NON_SIGNING = createNonSigningOracleAssuranceRecord(unsignedInput());

function changed(mutator, { recompute = true } = {}) {
  const record = structuredClone(NON_SIGNING);
  mutator(record);
  if (recompute) {
    if (record.practitioner && typeof record.practitioner === 'object') {
      record.practitioner.identityDigest = computePractitionerIdentityDigest(record.practitioner);
    }
    if (record.blindReview?.cases) record.blindReview.sampleDigest = computeBlindSampleDigest(record.blindReview.cases);
    record.reviewDigest = computeOracleAssuranceDigest(record);
  }
  return record;
}

function errors(record, overrides = {}) {
  return validateOracleAssuranceRecord(record, { ...options, ...overrides }).errors.join('\n');
}

test('positive synthetic shape is explicitly non-signing and leaves box 6 refused', () => {
  assert.equal(NON_SIGNING.version, ORACLE_ASSURANCE_VERSION);
  assert.equal(NON_SIGNING.recordPurpose, 'synthetic_shape_non_signing');
  assert.equal(NON_SIGNING.signature, null);
  assert.deepEqual(validateOracleAssuranceRecord(NON_SIGNING, options), {
    ok: true,
    version: ORACLE_ASSURANCE_VERSION,
    errors: [],
  });
  const gate = evaluateOracleAssuranceGate(NON_SIGNING, options);
  assert.equal(gate.status, AWAITING_INDEPENDENT_REVIEW);
  assert.equal(gate.gateOpen, false);
  assert.equal(gate.appendixDBox6, 'refused_unticked');
  assert.equal(gate.certificationClaim, false);
  assert.match(gate.refusalReasons.join('\n'), /synthetic shape is explicitly non-signing/);
});

test('absent, malformed, model-authored, conflicted, and stale identities fail closed', () => {
  const cases = [
    changed((record) => { delete record.practitioner; }),
    changed((record) => { record.practitioner.name = ''; }),
    changed((record) => { record.practitioner.actorKind = 'model'; record.practitioner.name = 'Codex'; }),
    changed((record) => { record.practitioner.independence.conflicts = ['Donna implementation role']; }),
    changed((record) => { record.practitioner.identityEvidence.digest = 'ABC'; }),
  ];
  for (const record of cases) {
    const gate = evaluateOracleAssuranceGate(record, options);
    assert.equal(gate.gateOpen, false);
    assert.equal(gate.status, AWAITING_INDEPENDENT_REVIEW);
    assert.ok(gate.refusalReasons.length > 0);
  }
  assert.match(errors(NON_SIGNING, { asOfDate: '2027-01-01' }), /identity evidence is absent, future, or stale/);
});

test('identity and competence validity boundaries are inclusive but one day outside is stale', () => {
  assert.equal(validateOracleAssuranceRecord(NON_SIGNING, { ...options, asOfDate: '2026-12-31' }).ok, true);
  const future = changed((record) => {
    record.decision.effectiveThrough = '2027-12-31';
    record.reReview.noLaterThan = '2027-12-31';
  });
  assert.match(errors(future, { asOfDate: '2027-01-01' }), /identity evidence.*stale|competence.*stale/);
});

test('absent, malformed, stale, or wrong-jurisdiction/view competence fails closed', () => {
  assert.match(errors(changed((record) => { delete record.competence; })), /competence must be an object/);
  assert.match(errors(changed((record) => { record.competence.jurisdictions = ['US']; })), /expected jurisdiction/);
  assert.match(errors(changed((record) => { record.competence.accountingViews = ['statutory_accounts']; })), /expected accounting view/);
  assert.match(errors(changed((record) => { record.competence.validThrough = '2026-08-08'; })), /competence.*stale/);
  assert.match(errors(changed((record) => { record.competence.validFrom = '2026-12-31'; record.competence.validThrough = '2026-01-01'; })), /contradictory/);
});

test('reviewed policy must match independently supplied version, digest, effective date, jurisdiction, and view', () => {
  for (const field of ['version', 'digest', 'effectiveFrom', 'jurisdiction', 'accountingView']) {
    const record = changed((value) => { value.reviewedPolicy[field] = field === 'digest' ? hex('9') : `stale-${field}`; });
    assert.match(errors(record), new RegExp(`reviewedPolicy\\.${field}`));
  }
  assert.match(errors(NON_SIGNING, { expectedPolicy: undefined }), /expectedPolicy must be supplied independently/);
  assert.match(errors(changed((record) => { record.reviewedPolicy.reviewedAt = '2026-08-04'; })), /before its effective period/);
});

test('blind-work receipt refuses an absent or empty sample and accepts the one-case boundary', () => {
  assert.equal(NON_SIGNING.blindReview.cases.length, 1);
  assert.equal(validateOracleAssuranceRecord(NON_SIGNING, options).ok, true);
  assert.match(errors(changed((record) => { delete record.blindReview; })), /blindReview must be an object/);
  assert.match(errors(changed((record) => { record.blindReview.cases = []; })), /at least one independently resolved case/);
  assert.match(errors(changed((record) => { record.blindReview.sampleDigest = hex('8'); }, { recompute: false })), /sampleDigest does not match/);
  assert.match(errors(changed((record) => {
    record.blindReview.resolvedAt = '2026-08-04';
    record.blindReview.cases[0].resolvedAt = '2026-08-04';
  })), /predates the reviewed policy effective period/);
});

test('solver-answer leakage before blind resolution is rejected through labels, timestamps, and hidden fields', () => {
  assert.match(errors(changed((record) => { record.blindReview.solverAnswerAccess = 'seen_before_resolution'; })), /not seen before independent resolution/);
  assert.match(errors(changed((record) => { record.blindReview.answerUnsealedAt = '2026-08-07'; })), /leaked before blind resolution/);
  const smuggled = changed((record) => { record.blindReview.cases[0].solverAnswer = 'fee is revenue'; });
  assert.match(errors(smuggled), /unsupported field: solverAnswer/);
  assert.match(errors(changed((record) => { record.blindReview.cases[0].resolvedAt = '2026-08-09'; })), /resolves after the blind-work receipt/);
});

test('citations and commercial-package comparison remain supplemental and cannot substitute for blind practitioner review', () => {
  for (const reviewBasis of ['authoritative_citations', 'commercial_package_comparison']) {
    const record = changed((value) => { value.reviewBasis = reviewBasis; value.blindReview = null; });
    const gate = evaluateOracleAssuranceGate(record, options);
    assert.equal(gate.gateOpen, false);
    assert.match(gate.refusalReasons.join('\n'), /citations and package comparisons are supplemental only/);
  }
});

test('unsigned approval and absent Kari arrangement cannot open the gate', () => {
  const unsigned = evaluateOracleAssuranceGate(NON_SIGNING, options);
  assert.equal(unsigned.gateOpen, false);
  assert.equal(unsigned.appendixDBox6, 'refused_unticked');

  const purportedReal = changed((record) => { record.recordPurpose = 'real_practitioner_review'; });
  const gate = evaluateOracleAssuranceGate(purportedReal, options);
  assert.equal(gate.gateOpen, false);
  assert.match(gate.refusalReasons.join('\n'), /signature is absent/);
});

test('review and signature digests are mandatory, canonical, and tamper evident', () => {
  const missing = changed((record) => { delete record.reviewDigest; }, { recompute: false });
  assert.match(errors(missing), /reviewDigest must be/);

  const tampered = changed((record) => {}, { recompute: false });
  tampered.decision.rationale = 'changed after digest';
  assert.match(errors(tampered), /reviewDigest does not match/);

  const malformedSignature = changed((record) => {
    record.signature = { algorithm: 'ed25519', keyId: 'key/example', signedDigest: record.reviewDigest, value: '***', signedAt: '2026-08-09' };
  }, { recompute: false });
  assert.match(errors(malformedSignature), /canonical base64/);

  const wrongDigest = changed((record) => {
    record.signature = { algorithm: 'ed25519', keyId: 'key/example', signedDigest: hex('f'), value: 'AAAA', signedAt: '2026-08-09' };
  }, { recompute: false });
  assert.match(errors(wrongDigest), /signedDigest must equal reviewDigest/);

  const staleSignature = changed((record) => {
    record.signature = { algorithm: 'ed25519', keyId: 'key/example', signedDigest: record.reviewDigest, value: 'AAAA', signedAt: '2027-01-01' };
  }, { recompute: false });
  assert.match(errors(staleSignature), /postdates the decision effective period/);
});

test('a cryptographically valid test-key signature still cannot turn the explicitly synthetic fixture into approval', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const record = changed((value) => {
    value.signature = {
      algorithm: 'ed25519',
      keyId: 'test-only/non-practitioner-key',
      signedDigest: value.reviewDigest,
      value: sign(null, Buffer.from(value.reviewDigest, 'hex'), privateKey).toString('base64'),
      signedAt: '2026-08-09',
    };
  }, { recompute: false });
  const reviewerArrangement = {
    version: REVIEWER_ARRANGEMENT_VERSION,
    decisionId: 'test-only/not-a-kari-decision',
    decidedBy: 'Kari',
    decidedAt: '2026-08-01',
    practitionerId: record.practitioner.practitionerId,
    reviewerIdentityDigest: record.practitioner.identityDigest,
    keyId: record.signature.keyId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    validFrom: '2026-08-01',
    validThrough: '2026-12-31',
  };
  assert.equal(verifyOracleAssuranceSignature(record, reviewerArrangement, { asOfDate: options.asOfDate }).ok, true, 'cryptographic transport is testable without asserting practitioner status');
  const gate = evaluateOracleAssuranceGate(record, { ...options, reviewerArrangement });
  assert.equal(gate.status, AWAITING_INDEPENDENT_REVIEW);
  assert.equal(gate.gateOpen, false);
  assert.match(gate.refusalReasons.join('\n'), /synthetic shape is explicitly non-signing/);
});

test('malformed or contradictory reviewer arrangements and signatures fail closed', () => {
  const record = changed((value) => {
    value.recordPurpose = 'real_practitioner_review';
    value.signature = { algorithm: 'ed25519', keyId: 'key/unknown', signedDigest: value.reviewDigest, value: 'AAAA', signedAt: '2026-08-09' };
  }, { recompute: false });
  assert.match(verifyOracleAssuranceSignature(record).errors.join('\n'), /arrangement is absent/);
  const wrong = {
    version: REVIEWER_ARRANGEMENT_VERSION,
    decisionId: 'decision/not-kari',
    decidedBy: 'Codex',
    decidedAt: '2026-08-01',
    practitionerId: 'different-practitioner',
    reviewerIdentityDigest: hex('0'),
    keyId: 'different-key',
    publicKeyPem: 'not a key',
    validFrom: '2026-08-01',
    validThrough: '2026-12-31',
  };
  const gate = evaluateOracleAssuranceGate(record, { ...options, reviewerArrangement: wrong });
  assert.equal(gate.gateOpen, false);
  assert.match(gate.refusalReasons.join('\n'), /Kari's dated decision|does not match/);

  const stale = { ...wrong, decidedBy: 'Kari', practitionerId: record.practitioner.practitionerId,
    reviewerIdentityDigest: record.practitioner.identityDigest, keyId: record.signature.keyId,
    validFrom: '2026-01-01', validThrough: '2026-08-08' };
  assert.match(verifyOracleAssuranceSignature(record, stale, { asOfDate: '2026-08-09' }).errors.join('\n'), /future or stale|falls outside/);
});

test('every disagreement needs a final disposition and rationale', () => {
  assert.match(errors(changed((record) => { delete record.disagreements; })), /disagreements must be an explicit array/);
  assert.match(errors(changed((record) => { delete record.disagreements[0].disposition; })), /requires a final disposition/);
  assert.match(errors(changed((record) => { record.disagreements[0].disposition = 'unresolved'; })), /requires a final disposition/);
  assert.match(errors(changed((record) => { record.disagreements[0].rationale = ''; })), /rationale must be/);
});

test('open and blocking oracle gaps prevent assurance and must name a declared re-review trigger', () => {
  const open = changed((record) => {
    record.oracleGapFindings = [{
      findingId: 'gap/example-001',
      caseId: 'slice1/family-2/blind-001',
      severity: 'high',
      status: 'open',
      disposition: 'requires oracle amendment',
      reReviewTrigger: 'oracle_version_change',
    }];
  });
  const gate = evaluateOracleAssuranceGate(open, options);
  assert.equal(gate.gateOpen, false);
  assert.match(gate.refusalReasons.join('\n'), /open or blocking oracle-gap/);

  assert.match(errors(changed((record) => {
    record.oracleGapFindings = [{
      findingId: 'gap/example-002', caseId: 'slice1/family-2/blind-001', severity: 'blocking',
      status: 'accepted_limitation', disposition: 'silently accepted', reReviewTrigger: 'undeclared-trigger',
    }];
  })), /cannot be accepted|not declared/);
});

test('decision effective-period boundaries are inclusive and malformed, future, expired, or contradictory dates refuse', () => {
  assert.equal(validateOracleAssuranceRecord(NON_SIGNING, { ...options, asOfDate: '2026-08-09' }).ok, true);
  assert.equal(validateOracleAssuranceRecord(NON_SIGNING, { ...options, asOfDate: '2026-12-31' }).ok, true);
  assert.match(errors(NON_SIGNING, { asOfDate: '2026-08-08' }), /decision is not effective/);
  assert.match(errors(NON_SIGNING, { asOfDate: '2027-01-01' }), /decision is not effective|stale/);
  assert.match(errors(changed((record) => { record.decision.effectiveFrom = '2026-02-30'; })), /real YYYY-MM-DD date/);
  assert.match(errors(changed((record) => { record.decision.effectiveFrom = '2026-08-10'; record.decision.effectiveThrough = '2026-08-09'; })), /contradictory/);
  assert.match(errors(changed((record) => { record.decision.decidedAt = '2026-08-10'; })), /effective before it is made|occurs after/);
});

test('re-review data is mandatory, bounded, trigger-complete, and stale-aware', () => {
  assert.match(errors(changed((record) => { delete record.reReview; })), /reReview must be an object/);
  assert.match(errors(changed((record) => { record.reReview.triggers = ['policy_version_change']; })), /must include oracle_version_change/);
  assert.match(errors(changed((record) => { record.reReview.noLaterThan = '2027-01-01'; })), /cannot silently extend/);
  const stale = changed((record) => {
    record.decision.effectiveThrough = '2027-12-31';
    record.competence.validThrough = '2027-12-31';
    record.practitioner.identityEvidence.validThrough = '2027-12-31';
    record.reReview.noLaterThan = '2026-08-08';
  });
  assert.match(errors(stale), /re-review deadline is stale/);
});

test('assurance cannot be silently lowered and Appendix D box 6 cannot be claimed as ticked', () => {
  const lowered = changed((record) => { record.assuranceLevel = 'citation_only'; });
  assert.match(errors(lowered), /assurance cannot be lowered/);
  const claimed = changed((record) => { record.appendixDBox6 = 'ticked'; });
  const gate = evaluateOracleAssuranceGate(claimed, options);
  assert.equal(gate.gateOpen, false);
  assert.equal(gate.certificationClaim, false);
  assert.match(gate.refusalReasons.join('\n'), /unsupported field: appendixDBox6/);
});

test('duplicate blind identities and cross-sample alternative or disagreement references are contradictory', () => {
  assert.match(errors(changed((record) => { record.blindReview.cases.push(structuredClone(record.blindReview.cases[0])); })), /duplicate blind case/);
  assert.match(errors(changed((record) => { record.legitimateAlternatives[0].caseId = 'outside/sample'; })), /outside the blind sample/);
  assert.match(errors(changed((record) => { record.disagreements[0].caseId = 'outside/sample'; })), /outside the blind sample/);
});
