// Donna Loops — the loop-goal scenario/eval harness (design proof, §7 + §9).
//
// See docs/loops-architecture-uplift-design.md. Our replay plan was historical
// (old snapshot -> new model -> compare). The inspiration adds the complementary
// pattern: author realistic scenarios, fix success criteria BEFORE execution,
// run under consistent conditions, fix failures, rerun. This harness is the seed
// of the DESIGNED scenario corpus for the goal layer — and double-duty, it is the
// calibration infra 7.2's disposition turn-on needs before any prod flip.
//
// It REUSES evalHarness.js wholesale (runEval / aggregateMetrics / baseline diff
// / formatSummary) — no edit to that file — and only injects a loop-goal runner +
// scorer. A goal scenario asserts the OUTCOME of evaluating one LoopDefinition's
// goal against a labeled input: the goal_status, the action, and (when a gap
// opens) the blocker/gap-kind/owner + the run's stop_reason.

import { runEval } from './evalHarness.js';
import { deriveStopReason } from './loopGoal.js';
import { getLoopDefinition, evaluateReconciliationGoal } from './loopGoalRegistry.js';

// Map a LoopDefinition's goalEvaluator name to its pure function. (A registry of
// one today; this is the seam every future definition plugs into.)
const GOAL_EVALUATORS = {
  evaluateReconciliationGoal
};

// Run one scenario fixture through a definition's evaluator and shape the
// observable outcome the scorer checks. The stop_reason is derived exactly as a
// LoopRun would derive it, so the corpus also pins the stopping behavior.
export const runGoalScenario = (definition, fixture) => {
  const evaluator = GOAL_EVALUATORS[definition.goalEvaluator];
  if (!evaluator) throw new Error(`no evaluator registered for ${definition.goalEvaluator}`);
  const { goalReport, action, desiredCase } = evaluator(fixture.input || {});

  const authorityRequired = action === 'open_gap';
  const stopReason = deriveStopReason({ goalReport, authorityRequired });

  return {
    goal_status: goalReport.status,
    action,
    blocker_type: desiredCase ? desiredCase.blockerType : null,
    gap_kind: desiredCase ? desiredCase.gapKind : null,
    owner_type: desiredCase ? desiredCase.ownerType : null,
    stop_reason: stopReason
  };
};

// Field-equality scorer over the labeled outcome. Each asserted expected field
// counts as one unit (mirrors scoreFixtureExtraction so it plugs straight into
// aggregateMetrics): precision is structurally 1, recall = correct/asserted,
// accuracy = per-scenario pass rate. A scenario PASSES iff every asserted field
// matches.
const SCORABLE_FIELDS = ['goal_status', 'action', 'blocker_type', 'gap_kind', 'owner_type', 'stop_reason'];

export const scoreGoalScenario = (fixture, actual) => {
  const expected = fixture.expected || {};
  const mismatched = [];
  let truePositive = 0;
  let expectedSize = 0;

  for (const field of SCORABLE_FIELDS) {
    if (!(field in expected)) continue;
    expectedSize += 1;
    if (actual && actual[field] === expected[field]) {
      truePositive += 1;
    } else {
      mismatched.push({ field, expected: expected[field], actual: actual ? actual[field] ?? null : null });
    }
  }

  const falseNegative = expectedSize - truePositive;
  return {
    status: falseNegative === 0 ? 'pass' : 'fail',
    truePositive,
    falsePositive: 0,
    falseNegative,
    expectedSize,
    actualSize: expectedSize,
    unmatchableExpected: null,
    unmatchableActual: null,
    mismatched_fields: mismatched
  };
};

// Entry point — replay the loop-goal scenario corpus for one definition and
// return the same normalized metrics blob every other eval suite produces, so a
// goal-evaluator refactor diffs against a checked-in baseline like any matcher.
export const runLoopGoalEval = async ({
  definitionKey = 'reconciliation_gap_resolution',
  definitionVersion = '1',
  suite = 'loop-goals',
  fixturesRoot = undefined,
  fixtures = null,
  ranAt = null
} = {}) => {
  const definition = getLoopDefinition(definitionKey, definitionVersion);
  if (!definition) throw new Error(`unknown LoopDefinition ${definitionKey}.v${definitionVersion}`);

  return runEval({
    suite,
    runner: (fixture) => runGoalScenario(definition, fixture),
    scorer: scoreGoalScenario,
    mode: 'deterministic',
    model: `${definition.goalEvaluator}@${definition.key}.v${definition.version}`,
    ...(fixturesRoot ? { fixturesRoot } : {}),
    fixtures,
    ranAt
  });
};
