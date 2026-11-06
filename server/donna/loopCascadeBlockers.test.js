// Donna Loops — the §6.2 cascade safety guard (audit P1 "multiple-parent wake").
//
// The dispatcher's handleCascade fans `dependency.resolved` to a child the moment
// ONE parent resolves — but a child with MULTIPLE blocking parents is NOT fully
// unblocked until they are ALL resolved. So every `dependency.resolved` subscriber
// MUST re-check its WHOLE blocker set and must never treat "a parent resolved" as
// "I'm done". These pin that contract on the two real subscribers today (coding +
// reconciliation), so a future evaluator that regresses to "one parent ⇒ met" is
// caught. Pure: it drives the deterministic goal evaluators directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCodingGoal, evaluateReconciliationGoal } from './loopGoalRegistry.js';

test('coding goal stays unmet when only SOME blocking parents are answered', () => {
  // two evidence cases block the batch; a single answer leaves it waiting.
  const partial = evaluateCodingGoal({ totalBlocking: 2, answered: 1 });
  assert.equal(partial.action, 'noop', 'a partially-answered batch must not resolve');
  assert.notEqual(partial.goalReport.status, 'met');

  // only when every blocking question is answered may the batch resolve.
  const full = evaluateCodingGoal({ totalBlocking: 2, answered: 2 });
  assert.equal(full.action, 'resolve_coding_case');
  assert.equal(full.goalReport.status, 'met');
});

test('reconciliation goal is not met by an upstream resolve alone', () => {
  // An upstream coding case resolving does NOT create a sticky match or change the
  // persisted verdict; a line still on a `no_match` verdict with no settling match
  // remains a gap. (This is also why the cascade re-wake alone cannot close the gap
  // — the Trap-2 / fresh-evaluation point.)
  const stillGap = evaluateReconciliationGoal({ verdict: 'no_match', hasStickyMatch: false, hasEvaluation: true });
  assert.notEqual(stillGap.goalReport.status, 'met');
  assert.equal(stillGap.action, 'open_gap');

  // Only a sticky match (or an explained/settling verdict) flips it to met.
  const settled = evaluateReconciliationGoal({ hasStickyMatch: true });
  assert.equal(settled.goalReport.status, 'met');
});
