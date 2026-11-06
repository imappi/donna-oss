// Tests for the single reconciliation terminal-state derivation (uplift Step 4).
// Pure / node --test only. Covers the #315 kill: a present GoalReport verdict
// outranks the legacy reconciliation_status; its absence defers to legacy.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONCILIATION_TERMINAL_SOURCES,
  deriveReconciliationTerminalState
} from './reconciliationTerminalState.js';

test('sources vocabulary', () => {
  assert.deepEqual(RECONCILIATION_TERMINAL_SOURCES, ['goal_report', 'legacy']);
});

test('no verdict → defers to the legacy column (additive / inert)', () => {
  const d = deriveReconciliationTerminalState(null, { legacyStatus: 'needs_review' });
  assert.equal(d.reconciliation_status, 'needs_review');
  assert.equal(d.source, 'legacy');
  assert.equal(d.verdict_present, false);

  // a report with no status is treated as absent.
  assert.equal(deriveReconciliationTerminalState({}, { legacyStatus: 'pending' }).source, 'legacy');
  // no legacy either → null, not a crash.
  assert.equal(deriveReconciliationTerminalState(null).reconciliation_status, null);
});

test('met via a sticky match → reconciled (verdict outranks a stale legacy)', () => {
  const report = { status: 'met', criteria: [{ key: 'matched_or_explained', status: 'met', evidenceRefs: ['sticky_match'] }] };
  const d = deriveReconciliationTerminalState(report, { legacyStatus: 'unreconciled' });
  assert.equal(d.reconciliation_status, 'reconciled'); // NOT the stale legacy 'unreconciled' (#315 kill)
  assert.equal(d.goal_status, 'achieved');
  assert.equal(d.source, 'goal_report');
  assert.equal(d.verdict_present, true);
});

test('met via auto_explained → explained (immaterial recurring noise)', () => {
  const report = { status: 'met', criteria: [{ key: 'matched_or_explained', status: 'met', evidenceRefs: ['auto_explained_verdict'] }] };
  const d = deriveReconciliationTerminalState(report, { legacyStatus: 'needs_review' });
  assert.equal(d.reconciliation_status, 'explained');
  assert.equal(d.goal_status, 'achieved');
});

test('waived → explained (a human waived the goal)', () => {
  const d = deriveReconciliationTerminalState({ status: 'waived', criteria: [] }, { legacyStatus: 'pending' });
  assert.equal(d.reconciliation_status, 'explained');
  assert.equal(d.goal_status, 'waived');
  assert.equal(d.verdict_present, true);
});

test('unmet → needs_review and carries the next conditions (snake or camel)', () => {
  const fromRow = deriveReconciliationTerminalState(
    { status: 'unmet', criteria: [], next_unmet_conditions: ['Upload the bank statement.'] },
    { legacyStatus: 'reconciled' }
  );
  assert.equal(fromRow.reconciliation_status, 'needs_review'); // verdict overrides a stale 'reconciled'
  assert.equal(fromRow.goal_status, 'not_achieved');
  assert.deepEqual(fromRow.next_unmet_conditions, ['Upload the bank statement.']);

  // the in-memory report shape (camelCase) is also accepted.
  const fromMem = deriveReconciliationTerminalState(
    { status: 'unmet', nextUnmetConditions: ['Match this line.'] }
  );
  assert.deepEqual(fromMem.next_unmet_conditions, ['Match this line.']);
});

test('impossible → needs_review (a human gap), not silently met', () => {
  const d = deriveReconciliationTerminalState({ status: 'impossible', criteria: [] });
  assert.equal(d.reconciliation_status, 'needs_review');
  assert.equal(d.goal_status, 'not_achieved');
});

test('indeterminate → defers to legacy (a pending proposed match never overrides)', () => {
  const d = deriveReconciliationTerminalState({ status: 'indeterminate', criteria: [] }, { legacyStatus: 'pending' });
  assert.equal(d.reconciliation_status, 'pending');
  assert.equal(d.source, 'legacy');
  assert.equal(d.verdict_present, false);
  assert.equal(d.goal_status, 'pending');
});
