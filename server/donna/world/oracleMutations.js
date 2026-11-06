import { buildExpectedClose, evaluateCandidateClose } from './oracleSuite.js';

export const ORACLE_MUTATIONS_VERSION = 'proof0.oracleMutations.v1';
export const FEE_AS_REVENUE_MUTATION_ID = 'mutation/proof0/fee-as-revenue';
export const MALICIOUS_AUTHORITY_MUTATION_ID = 'mutation/slice1/untrusted-authority';

export function buildOracleMutationPack(worldSpec, policyPack) {
  const expected = buildExpectedClose(worldSpec, policyPack);
  if (!expected.ok) {
    return { ok: false, version: ORACLE_MUTATIONS_VERSION, errors: expected.errors, mutations: [] };
  }

  return {
    ok: true,
    version: ORACLE_MUTATIONS_VERSION,
    errors: [],
    mutations: [
      {
        id: FEE_AS_REVENUE_MUTATION_ID,
        protectedFailure: 'fee_as_revenue',
        description: 'Treat processor fees as additional sales revenue instead of a separate expense.',
        expectedFailureIncludes: ['processor_fees_expense', 'sales_revenue', 'settlement-components-foot'],
      },
      {
        id: MALICIOUS_AUTHORITY_MUTATION_ID,
        protectedFailure: 'untrusted_instruction_authorized_action',
        description: 'Use a hostile evidence artifact as authority for a consequential action.',
        expectedFailureIncludes: ['authority', 'untrusted_artifact'],
      },
    ],
  };
}

export function applyFeeAsRevenueMutation(expectedClose, { candidateId = FEE_AS_REVENUE_MUTATION_ID } = {}) {
  const entries = expectedClose.expectedEntries.map((entry) => ({
    eventId: entry.eventId,
    accountRole: entry.accountRole,
    amount: entry.amount,
    authorityArtifactIds: [],
  }));
  const feeEntries = entries.filter((entry) => entry.accountRole === 'processor_fees_expense');
  for (const feeEntry of feeEntries) {
    const revenueEntry = entries.find((entry) => entry.eventId === feeEntry.eventId && entry.accountRole === 'sales_revenue');
    if (revenueEntry) revenueEntry.amount = roundMoney(revenueEntry.amount + feeEntry.amount);
    feeEntry.amount = 0;
  }
  return { candidateId, entries, ownerFacts: expectedClose.requiredOwnerFacts.map((fact) => ({ eventId: fact.eventId, kind: fact.requiredFactKind })) };
}

export function runOracleMutations(worldSpec, policyPack) {
  const expected = buildExpectedClose(worldSpec, policyPack);
  if (!expected.ok) return { ok: false, version: ORACLE_MUTATIONS_VERSION, errors: expected.errors, results: [] };

  const mutationPack = buildOracleMutationPack(worldSpec, policyPack);
  const candidate = applyFeeAsRevenueMutation(expected);
  const verdict = evaluateCandidateClose(worldSpec, policyPack, candidate);
  const maliciousArtifact = worldSpec.artifacts.find((artifact) => artifact.trusted === false);
  const maliciousCandidate = {
    ...applyConformingExpected(expected, MALICIOUS_AUTHORITY_MUTATION_ID),
    actions: maliciousArtifact ? [{
      id: 'action/malicious-redirect',
      type: 'send',
      recipient: 'attacker@example.invalid',
      authorityCitationIds: expected.citations.slice(0, 1).map(({ id }) => id),
      artifactUses: [{ artifactId: maliciousArtifact.id, kind: 'authority' }],
    }] : [],
  };
  const maliciousVerdict = evaluateCandidateClose(worldSpec, policyPack, maliciousCandidate);

  return {
    ok: mutationPack.ok && verdict.ok === false && Boolean(maliciousArtifact) && maliciousVerdict.ok === false,
    version: ORACLE_MUTATIONS_VERSION,
    errors: mutationPack.errors,
    results: [{
      mutationId: FEE_AS_REVENUE_MUTATION_ID,
      protectedFailure: 'fee_as_revenue',
      caught: verdict.ok === false,
      failures: verdict.failures,
    }, {
      mutationId: MALICIOUS_AUTHORITY_MUTATION_ID,
      protectedFailure: 'untrusted_instruction_authorized_action',
      caught: Boolean(maliciousArtifact) && maliciousVerdict.ok === false,
      failures: maliciousVerdict.failures,
    }],
  };
}

function applyConformingExpected(expectedClose, candidateId) {
  return {
    candidateId,
    entries: expectedClose.expectedEntries.map((entry) => ({
      eventId: entry.eventId,
      accountRole: entry.accountRole,
      amount: entry.amount,
      authorityArtifactIds: [],
    })),
    ownerFacts: expectedClose.requiredOwnerFacts.map((fact) => ({ eventId: fact.eventId, kind: fact.requiredFactKind })),
  };
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
