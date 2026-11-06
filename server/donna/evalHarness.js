// Donna eval harness — Slice D scoping pass.
//
// Fixture-driven, offline-runnable eval for high-judgement structured-
// data work. The first consumer is the Slice E LLM reconciliation
// matcher: each fixture describes one parsed sales_invoice + a set of
// candidate bank lines + the human-verified expected proposal(s).
// The harness runs a matcher function against every fixture and
// reports a deterministic JSON metrics blob:
//
//   {
//     suite, mode, ranAt, model,
//     totals: { fixtures, passed, failed, errored, expected_match_count,
//               proposed_match_count, true_positive, false_positive,
//               false_negative },
//     metrics: { precision, recall, f1, accuracy },
//     cases: [{ id, status, expected, actual, notes }]
//   }
//
// Why this shape: the audit reflex in CLAUDE.md ("which file can we
// delete now?") only works if we can show a strong-model pipeline
// matches or beats the old pipeline on the same fixtures. Baselines
// are JSON checked into git, so a model bump or matcher refactor PR
// diffs the metrics file alongside the code change.
//
// Pilot suite: 'reconciliation' (sales_invoice). Subsequent suites
// (extraction, classification) plug into the same harness by
// implementing the same runner shape — fixtures in, normalised JSON
// out, baseline diff in — and injecting a suite-specific scorer.
//
// See docs/donna-llm-trust-strategy.md §3 Slice D.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const PROJECT_ROOT = process.cwd();

export const FIXTURES_ROOT = joinPath(PROJECT_ROOT, 'data', 'evals', 'fixtures');
export const BASELINES_ROOT = joinPath(PROJECT_ROOT, 'data', 'evals', 'baselines');

// Loads every *.json under data/evals/fixtures/<suite>/, returns them
// sorted by id (which is the filename stem) so a run order is stable
// across machines.
export const loadFixtures = (suite, { root = FIXTURES_ROOT } = {}) => {
  const dir = joinPath(root, suite);
  if (!existsSync(dir)) {
    throw new Error(`Eval fixtures directory does not exist: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return files.map((name) => {
    const filePath = joinPath(dir, name);
    const raw = readFileSync(filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Fixture ${name} is not valid JSON: ${error.message}`);
    }
    const id = parsed.id || name.replace(/\.json$/, '');
    return { ...parsed, id, __file: name };
  });
};

// Set helpers — comparing expected vs actual matcher proposals as
// (bank_transaction_id, status) pairs. Status is one of:
//   'auto_matched' | 'suggested' | (omitted when the test only cares
//   that the id matched)
//
// Status-agnostic comparison: when the EXPECTED proposal for a given
// id omits `status`, that target is compared id-ONLY on BOTH sides —
// the actual run's status (auto_matched/suggested) is ignored for that
// id. This honors the documented intent ("...omitted when the test
// only cares that the id matched") and matches fixtures whose narrative
// declares a target-only, set-based comparison (e.g. the partial-payment
// fixtures). When the expected proposal DOES pin a status, that target
// must match (id, status) exactly — authority-band expectations are
// still enforced. The agnostic set is derived from EXPECTED only, so an
// actual proposing an extra/unexpected target still keys with its status
// and counts as a false positive.
const pairKey = (id, status) =>
  status != null && status !== ''
    ? `${id}|${status}`
    : `${id}`;

// Ids for which the EXPECTED side omits a status — these compare id-only.
const statusAgnosticIds = (proposals) => {
  const ids = new Set();
  for (const p of proposals || []) {
    if (!p || p.bank_transaction_id == null) continue;
    if (p.status == null || p.status === '') ids.add(String(p.bank_transaction_id));
  }
  return ids;
};

const proposalsToKeySet = (proposals, agnosticIds = new Set()) => {
  const keys = new Set();
  for (const p of proposals || []) {
    if (!p || p.bank_transaction_id == null) continue;
    const id = String(p.bank_transaction_id);
    keys.add(agnosticIds.has(id) ? id : pairKey(id, p.status));
  }
  return keys;
};

// Per-case verdict. A case PASSES when expected and actual proposal
// sets are equal. When expected.unmatchable_reason is set we also
// require the actual run to surface it.
export const scoreFixture = (fixture, actual) => {
  const expected = fixture.expected || {};
  const agnosticIds = statusAgnosticIds(expected.proposals);
  const expectedSet = proposalsToKeySet(expected.proposals, agnosticIds);
  const actualSet = proposalsToKeySet(actual.proposals, agnosticIds);

  const truePositive = [...expectedSet].filter((k) => actualSet.has(k)).length;
  const falsePositive = [...actualSet].filter((k) => !expectedSet.has(k)).length;
  const falseNegative = [...expectedSet].filter((k) => !actualSet.has(k)).length;

  const unmatchableExpected = expected.unmatchable_reason || null;
  const unmatchableActual = actual.unmatchable_reason || null;
  // A fixture that asserts an unmatchable_reason can either pin the
  // exact token ("no_plausible_match") or just require some non-null
  // reason. The wildcard ANY skips the exact-match assertion.
  let unmatchableOk = true;
  if (unmatchableExpected) {
    unmatchableOk =
      unmatchableExpected === '*'
        ? Boolean(unmatchableActual)
        : unmatchableActual === unmatchableExpected;
  }

  const setEqual =
    expectedSet.size === actualSet.size && falsePositive === 0 && falseNegative === 0;

  const status = setEqual && unmatchableOk ? 'pass' : 'fail';

  return {
    status,
    truePositive,
    falsePositive,
    falseNegative,
    expectedSize: expectedSet.size,
    actualSize: actualSet.size,
    unmatchableExpected,
    unmatchableActual
  };
};

// Entity-name normaliser for the SOFT counterparty-name metric.
// Lower-cases, drops parentheticals ("(Tenant)"), collapses
// punctuation, and strips trailing legal-suffix tokens so that
// "Globex Industries Ltd", "Globex Industries", and "GLOBEX
// INDUSTRIES" all compare equal. Used only by the soft name score —
// the strict scorer never normalises (it compares deep-equality).
const ENTITY_NAME_SUFFIXES = new Set([
  'ltd', 'limited', 'llc', 'inc', 'incorporated', 'oy', 'oyj', 'ab', 'as',
  'plc', 'gmbh', 'bv', 'nv', 'pte', 'pty', 'co', 'corp', 'corporation',
  'company', 'sa', 'sas', 'srl', 'spa', 'kg', 'ag'
]);

export const normalizeEntityName = (name) => {
  if (name == null) return '';
  let s = String(name).toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' '); // drop parentheticals e.g. "(tenant)"
  s = s.replace(/\./g, ''); // "b.v." -> "bv", "e.h." -> "eh"
  s = s.replace(/[,&/]/g, ' '); // other punctuation -> space
  s = s.replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ').filter(Boolean);
  while (tokens.length > 1 && ENTITY_NAME_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
};

// Extraction scorer — field-equality on `expected.document_type`
// plus every key in `expected.header`. Each expected field counts
// as one true-positive when correct, one false-negative when wrong
// or missing. False-positive is structurally always 0 (the unified
// + per-type extractors both return a fixed-shape envelope, so
// there is no notion of an "extra" field). The per-fixture status
// is 'pass' iff every expected field matches.
//
// One consequence of FP being structurally 0: aggregate precision
// over an extraction run is degenerate (always 1.0). The
// load-bearing aggregate metric for extraction is `recall`
// (correctly-extracted expected fields / total expected fields)
// and `accuracy` (per-fixture pass rate). The metrics block keeps
// the same shape as the reconciliation suite so baseline diffs
// look identical across suites.
//
// SOFT counterparty-name metric (decision 2026-06-22): entity names
// are NOT pinned in the strict gold — the unified extractor returns
// them verbatim-as-printed and is non-deterministic about legal
// suffixes ("Globex Industries Ltd" vs "Globex Industries"). When a
// fixture supplies `expected.counterparty_name`, the scorer records a
// `name_soft` result under the suffix/punctuation-insensitive
// normaliser above. It is reported as a SEPARATE aggregate
// (`name_accuracy`) and deliberately does NOT contribute to the strict
// status / recall — that honours "do not massage fixtures" (the strict
// gold stays the genuinely-correct, convention-free fields) while still
// tracking whether the model read the right entity.
export const scoreFixtureExtraction = (fixture, actual) => {
  const expected = fixture.expected || {};
  const expectedHeader = expected.header && typeof expected.header === 'object' ? expected.header : {};
  const actualHeader = actual && typeof actual === 'object' && actual.header && typeof actual.header === 'object'
    ? actual.header
    : {};

  const mismatchedFields = [];
  let truePositive = 0;
  let falseNegative = 0;
  let expectedSize = 0;

  if ('document_type' in expected) {
    expectedSize += 1;
    if (actual && actual.document_type === expected.document_type) {
      truePositive += 1;
    } else {
      falseNegative += 1;
      mismatchedFields.push({
        field: 'document_type',
        expected: expected.document_type,
        actual: actual ? actual.document_type : null
      });
    }
  }

  for (const key of Object.keys(expectedHeader)) {
    expectedSize += 1;
    const expectedValue = expectedHeader[key];
    const actualValue = actualHeader[key];
    if (isDeepStrictEqual(actualValue, expectedValue)) {
      truePositive += 1;
    } else {
      falseNegative += 1;
      mismatchedFields.push({ field: `header.${key}`, expected: expectedValue, actual: actualValue ?? null });
    }
  }

  if (typeof expected.line_count === 'number') {
    expectedSize += 1;
    const actualLineCount = typeof actual?.line_count === 'number' ? actual.line_count : null;
    if (actualLineCount === expected.line_count) {
      truePositive += 1;
    } else {
      falseNegative += 1;
      mismatchedFields.push({ field: 'line_count', expected: expected.line_count, actual: actualLineCount });
    }
  }

  const status = falseNegative === 0 ? 'pass' : 'fail';

  // Soft counterparty-name score — only when the fixture supplies a
  // reference. The counterparty is whichever side is populated
  // (vendor_name for vendor-direction docs, customer_name for
  // customer-direction). Does NOT affect `status`.
  let nameSoft = null;
  if (typeof expected.counterparty_name === 'string' && expected.counterparty_name.trim() !== '') {
    const actualName = actualHeader.vendor_name ?? actualHeader.customer_name ?? null;
    const normExpected = normalizeEntityName(expected.counterparty_name);
    const normActual = normalizeEntityName(actualName);
    nameSoft = {
      expected: expected.counterparty_name,
      actual: actualName ?? null,
      match: normExpected !== '' && normExpected === normActual
    };
  }

  return {
    status,
    truePositive,
    falsePositive: 0,
    falseNegative,
    expectedSize,
    actualSize: expectedSize,
    unmatchableExpected: null,
    unmatchableActual: null,
    mismatched_fields: mismatchedFields,
    fields_correct: truePositive,
    fields_total: expectedSize,
    name_soft: nameSoft
  };
};

const safeDivide = (numerator, denominator) =>
  denominator > 0 ? numerator / denominator : null;

// Aggregate metrics across a run. Returns precision / recall / F1
// computed against (bank_transaction_id, status) pairs. Null when the
// denominator is zero — JSON-friendly and unambiguous.
export const aggregateMetrics = (caseResults) => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let expectedTotal = 0;
  let proposedTotal = 0;
  // Soft counterparty-name metric — tracked separately from the strict
  // precision/recall above (extraction suite only; reconciliation cases
  // carry no name_soft, so name_checked stays 0 and name_accuracy null).
  let nameChecked = 0;
  let nameCorrect = 0;

  for (const c of caseResults) {
    if (c.status === 'error') {
      errored += 1;
      continue;
    }
    tp += c.score.truePositive;
    fp += c.score.falsePositive;
    fn += c.score.falseNegative;
    expectedTotal += c.score.expectedSize;
    proposedTotal += c.score.actualSize;
    if (c.status === 'pass') passed += 1;
    else failed += 1;
    if (c.score.name_soft) {
      nameChecked += 1;
      if (c.score.name_soft.match) nameCorrect += 1;
    }
  }

  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  const f1 = precision != null && recall != null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  const accuracy = safeDivide(passed, passed + failed);
  const nameAccuracy = safeDivide(nameCorrect, nameChecked);

  return {
    totals: {
      fixtures: caseResults.length,
      passed,
      failed,
      errored,
      expected_match_count: expectedTotal,
      proposed_match_count: proposedTotal,
      true_positive: tp,
      false_positive: fp,
      false_negative: fn,
      name_checked: nameChecked,
      name_correct: nameCorrect
    },
    metrics: { precision, recall, f1, accuracy, name_accuracy: nameAccuracy }
  };
};

// runEval — the harness entry point. `runner` is an async function
// `(fixture) => actual` whose shape depends on the suite (the
// reconciliation runner returns `{proposals, unmatchable_reason}`;
// the extraction runner returns `{document_type, header,
// line_count}`). `scorer(fixture, actual)` defaults to the
// reconciliation set-equality scorer; pass `scoreFixtureExtraction`
// (or any other custom scorer with the same return shape) to plug
// the harness into a different suite. Fixtures that throw are
// recorded as errors and do not contribute to precision / recall.
export const runEval = async ({
  suite,
  runner,
  scorer = scoreFixture,
  mode = null,
  model = null,
  fixturesRoot = FIXTURES_ROOT,
  fixtures = null,
  ranAt = null
} = {}) => {
  if (typeof runner !== 'function') {
    throw new Error('runEval requires a runner function');
  }
  if (typeof scorer !== 'function') {
    throw new Error('runEval requires a scorer function');
  }
  const loaded = fixtures || loadFixtures(suite, { root: fixturesRoot });

  const caseResults = [];
  for (const fixture of loaded) {
    try {
      const actual = await runner(fixture);
      const score = scorer(fixture, actual || {});
      caseResults.push({
        id: fixture.id,
        title: fixture.title || null,
        status: score.status,
        score,
        expected: fixture.expected || null,
        actual: actual || {}
      });
    } catch (error) {
      caseResults.push({
        id: fixture.id,
        title: fixture.title || null,
        status: 'error',
        error: error?.message || String(error),
        expected: fixture.expected || null,
        ...(error?.modelUsage && typeof error.modelUsage === 'object'
          ? { modelUsage: structuredClone(error.modelUsage) }
          : {})
      });
    }
  }

  const aggregate = aggregateMetrics(caseResults);

  return {
    suite,
    mode,
    model,
    ranAt: ranAt || new Date().toISOString(),
    totals: aggregate.totals,
    metrics: aggregate.metrics,
    cases: caseResults
  };
};

const baselineFilename = (suite, mode) =>
  mode ? `${suite}_${mode}.json` : `${suite}.json`;

export const baselinePath = (suite, mode, { root = BASELINES_ROOT } = {}) =>
  joinPath(root, baselineFilename(suite, mode));

export const loadBaseline = (suite, mode, { root = BASELINES_ROOT } = {}) => {
  const path = baselinePath(suite, mode, { root });
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
};

export const saveBaseline = (result, { root = BASELINES_ROOT } = {}) => {
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const path = baselinePath(result.suite, result.mode, { root });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
};

// Diff a fresh run against a baseline. Returns the new/regressed/
// improved cases AND the metric deltas. Used by CI to fail when a
// matcher refactor regresses against a checked-in baseline.
export const diffAgainstBaseline = (current, baseline) => {
  if (!baseline) {
    return {
      hasBaseline: false,
      regressions: [],
      improvements: [],
      newCases: current.cases.map((c) => c.id),
      droppedCases: [],
      metricDeltas: {
        precision: current.metrics.precision,
        recall: current.metrics.recall,
        f1: current.metrics.f1,
        accuracy: current.metrics.accuracy
      }
    };
  }
  const baselineById = new Map(baseline.cases.map((c) => [c.id, c]));
  const currentById = new Map(current.cases.map((c) => [c.id, c]));
  const regressions = [];
  const improvements = [];
  const newCases = [];
  const droppedCases = [];

  for (const [id, cur] of currentById) {
    const base = baselineById.get(id);
    if (!base) {
      newCases.push(id);
      continue;
    }
    if (base.status === 'pass' && cur.status !== 'pass') regressions.push(id);
    else if (base.status !== 'pass' && cur.status === 'pass') improvements.push(id);
  }
  for (const id of baselineById.keys()) {
    if (!currentById.has(id)) droppedCases.push(id);
  }

  const delta = (a, b) => (a == null || b == null ? null : a - b);

  return {
    hasBaseline: true,
    regressions,
    improvements,
    newCases,
    droppedCases,
    metricDeltas: {
      precision: delta(current.metrics.precision, baseline.metrics.precision),
      recall: delta(current.metrics.recall, baseline.metrics.recall),
      f1: delta(current.metrics.f1, baseline.metrics.f1),
      accuracy: delta(current.metrics.accuracy, baseline.metrics.accuracy)
    }
  };
};

// Human-readable one-screen summary — for `--print` in the runner
// script and the PR description. Deliberately terse; the full JSON
// is the canonical artifact.
export const formatSummary = (result, diff = null) => {
  const lines = [];
  lines.push(`suite=${result.suite} mode=${result.mode || '(n/a)'} model=${result.model || '(n/a)'}`);
  lines.push(`fixtures: ${result.totals.fixtures} (pass ${result.totals.passed} / fail ${result.totals.failed} / error ${result.totals.errored})`);
  const m = result.metrics;
  const fmt = (v) => (v == null ? 'n/a' : v.toFixed(3));
  lines.push(`precision=${fmt(m.precision)} recall=${fmt(m.recall)} f1=${fmt(m.f1)} accuracy=${fmt(m.accuracy)}`);
  if (m.name_accuracy != null) {
    lines.push(`name_accuracy=${fmt(m.name_accuracy)} (soft; ${result.totals.name_correct}/${result.totals.name_checked}, not in strict metrics)`);
  }
  if (diff && diff.hasBaseline) {
    const d = diff.metricDeltas;
    const fmtDelta = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}`);
    lines.push(`Δ vs baseline: precision=${fmtDelta(d.precision)} recall=${fmtDelta(d.recall)} f1=${fmtDelta(d.f1)} accuracy=${fmtDelta(d.accuracy)}`);
    if (diff.regressions.length) lines.push(`REGRESSIONS: ${diff.regressions.join(', ')}`);
    if (diff.improvements.length) lines.push(`improvements: ${diff.improvements.join(', ')}`);
    if (diff.newCases.length) lines.push(`new cases: ${diff.newCases.join(', ')}`);
    if (diff.droppedCases.length) lines.push(`dropped cases: ${diff.droppedCases.join(', ')}`);
  }
  return lines.join('\n');
};
