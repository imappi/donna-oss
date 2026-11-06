import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deriveCorrectionExpectations, evaluateCorrectionOutcomes } from './correctionEvents.js';

const loadWorld = async () => JSON.parse(await readFile('data/worlds/slice2-correction-reopen.json', 'utf8'));
const conforming = (expectations) => expectations.map((expected) => ({
  eventId: expected.eventId,
  action: expected.requiredAction,
  terminalState: expected.terminalState,
  adjustmentDate: expected.adjustmentDate,
  preservedEventIds: [...expected.preservedEventIds],
  preservedReceiptIds: [...expected.preservedReceiptIds],
  inPlaceEdit: false,
}));

test('derives append-only correction, reversal, and reopen expectations', async () => {
  const expectations = deriveCorrectionExpectations(await loadWorld());
  assert.deepEqual(expectations.map(({ kind, requiredAction, terminalState }) => ({ kind, requiredAction, terminalState })), [
    { kind: 'case_reopen', requiredAction: 'reopen_case', terminalState: 'resolved' },
    { kind: 'entry_reversal', requiredAction: 'reversal_entry', terminalState: 'resolved' },
    { kind: 'owner_correction', requiredAction: 'dated_adjustment_journal', terminalState: 'resolved' },
  ]);
  assert.deepEqual(evaluateCorrectionOutcomes(expectations, conforming(expectations)), []);
});

test('refuses locked-period in-place edits and deletion of pre-correction trail', async () => {
  const expectations = deriveCorrectionExpectations(await loadWorld());
  const outcomes = conforming(expectations);
  const correction = outcomes.find(({ eventId }) => eventId === 'event/owner-correction');
  correction.action = 'edit_original_entry';
  correction.inPlaceEdit = true;
  correction.preservedEventIds = ['event/owner-correction'];
  correction.preservedReceiptIds = [];
  assert.deepEqual(evaluateCorrectionOutcomes(expectations, outcomes), [
    'causal.event/owner-correction.action expected dated_adjustment_journal got edit_original_entry',
    'causal.event/owner-correction.in_place_edit_forbidden',
    'causal.event/owner-correction.receipt_trail_missing.receipt/owner-answer-original',
    'causal.event/owner-correction.trail_missing.event/owner-answer-original',
  ]);
});
