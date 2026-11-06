import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildExpectedClose, evaluateCandidateClose } from './oracleSuite.js';
import { readProof0PolicyPack } from './oracleSuite.js';
import { buildTemporalEvidenceContracts, evaluateTemporalEvidence } from './temporalEvidence.js';

const loadWorld = async () => JSON.parse(await readFile('data/worlds/slice2-delayed-contradiction.json', 'utf8'));

function conformingCandidate(contracts) {
  return {
    originalAskDigests: { [contracts.retries[0].askId]: 'original' },
    reopenOutcomes: contracts.contradictions.map((item) => ({ reopenEventId: item.reopenEventId, action: 'reopen_case', receiptId: item.receiptId, mutatedObservationIds: [] })),
    askActivity: [
      { askId: contracts.retries[0].askId, kind: 'nudge', at: '2026-08-10', contentDigest: 'nudge-1' },
      { askId: contracts.retries[0].askId, kind: 'answered', at: '2026-08-11', contentDigest: 'answer' },
    ],
  };
}

test('full Slice 1 family schedule composes delayed contradiction through Unit 49 reopen and oracle scoring', async () => {
  const world = await loadWorld();
  const contracts = buildTemporalEvidenceContracts(world);
  assert.equal(contracts.ok, true);
  assert.equal(contracts.schedule.observations.find(({ observationId }) => observationId === 'later-owner-evidence').delayed, true);
  assert.deepEqual(contracts.contradictions.map(({ observationId, reopenEventId, appendOnly, reopenReceiptRequired }) => ({ observationId, reopenEventId, appendOnly, reopenReceiptRequired })), [
    { observationId: 'later-owner-evidence', reopenEventId: 'event/case-reopen', appendOnly: true, reopenReceiptRequired: true },
  ]);
  assert.deepEqual(evaluateTemporalEvidence(contracts, conformingCandidate(contracts)).failures, []);

  const expected = buildExpectedClose(world, await readProof0PolicyPack());
  const causalOutcomes = expected.causalExpectations.map((item) => ({ eventId: item.eventId, action: item.requiredAction, terminalState: item.terminalState, adjustmentDate: item.adjustmentDate, preservedEventIds: item.preservedEventIds, preservedReceiptIds: item.preservedReceiptIds, inPlaceEdit: false }));
  const candidate = { candidateId: 'unit58', entries: expected.expectedEntries, ownerFacts: expected.requiredOwnerFacts.map((fact) => ({ eventId: fact.eventId, kind: fact.requiredFactKind })), actions: [], causalOutcomes };
  assert.equal(evaluateCandidateClose(world, await readProof0PolicyPack(), candidate).ok, true);
});

test('contradiction history and reopen receipt fail closed', async () => {
  const contracts = buildTemporalEvidenceContracts(await loadWorld());
  const candidate = conformingCandidate(contracts);
  candidate.reopenOutcomes[0].receiptId = null;
  candidate.reopenOutcomes[0].mutatedObservationIds = ['owner-purpose-answer'];
  assert.deepEqual(evaluateTemporalEvidence(contracts, candidate).failures, [
    'contradiction.later-owner-evidence.history_mutated',
    'contradiction.later-owner-evidence.reopen_receipt_missing_or_wrong',
  ]);
});

test('retry contract enforces deferral, at-most-N, distinct nudges, and never re-asks an answered fact', async () => {
  const contracts = buildTemporalEvidenceContracts(await loadWorld());
  const candidate = conformingCandidate(contracts);
  candidate.askActivity = [
    { askId: contracts.retries[0].askId, kind: 'nudge', at: '2026-08-09', contentDigest: 'original' },
    { askId: contracts.retries[0].askId, kind: 'answered', at: '2026-08-10', contentDigest: 'answer' },
    { askId: contracts.retries[0].askId, kind: 'nudge', at: '2026-08-10', contentDigest: 'same' },
    { askId: contracts.retries[0].askId, kind: 'nudge', at: '2026-08-11', contentDigest: 'same' },
  ];
  assert.deepEqual(evaluateTemporalEvidence(contracts, candidate).failures, [
    `retry.${contracts.retries[0].askId}.answered_fact_reasked`,
    `retry.${contracts.retries[0].askId}.before_deferral_window`,
    `retry.${contracts.retries[0].askId}.identical_ask_repeated`,
    `retry.${contracts.retries[0].askId}.identical_nudge_repeated`,
    `retry.${contracts.retries[0].askId}.nudge_limit_exceeded`,
  ]);
});
