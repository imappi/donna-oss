// Eval harness tests — Slice D scoping pass.
//
// Covers: fixture loading, scoring (set-equality on proposal pairs),
// unmatchable_reason wildcards, aggregate metrics, baseline diff
// (regressions / improvements / new / dropped cases), and the
// `runEval` orchestrator's error handling (a throwing runner records
// the case as 'error' without poisoning the run).

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';

import {
  aggregateMetrics,
  diffAgainstBaseline,
  formatSummary,
  loadBaseline,
  loadFixtures,
  normalizeEntityName,
  runEval,
  saveBaseline,
  scoreFixture,
  scoreFixtureExtraction
} from './evalHarness.js';

const makeTempFixtures = (suite, fixtures) => {
  const root = mkdtempSync(joinPath(tmpdir(), 'donna-eval-'));
  const suiteDir = joinPath(root, suite);
  mkdirSync(suiteDir, { recursive: true });
  for (const fixture of fixtures) {
    const name = `${fixture.id}.json`;
    writeFileSync(joinPath(suiteDir, name), JSON.stringify(fixture));
  }
  return root;
};

// ── loadFixtures ─────────────────────────────────────────────────────
await test('loadFixtures — reads JSON files in sorted order', () => {
  const root = makeTempFixtures('reconciliation', [
    { id: '002-b', title: 'second' },
    { id: '001-a', title: 'first' }
  ]);
  try {
    const loaded = loadFixtures('reconciliation', { root });
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].id, '001-a', 'filenames sorted lexically');
    assert.equal(loaded[1].id, '002-b');
    assert.equal(loaded[0].__file, '001-a.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('loadFixtures — throws on missing directory', () => {
  assert.throws(
    () => loadFixtures('nonexistent', { root: '/tmp/donna-eval-missing-xyz' }),
    /does not exist/
  );
});

await test('loadFixtures — throws on invalid JSON', () => {
  const root = mkdtempSync(joinPath(tmpdir(), 'donna-eval-bad-'));
  const suiteDir = joinPath(root, 'reconciliation');
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(joinPath(suiteDir, '001-bad.json'), '{not json');
  try {
    assert.throws(
      () => loadFixtures('reconciliation', { root }),
      /not valid JSON/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── scoreFixture ─────────────────────────────────────────────────────
await test('scoreFixture — exact set match → pass', () => {
  const score = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-1', status: 'auto_matched' }] } },
    { proposals: [{ bank_transaction_id: 'tx-1', status: 'auto_matched' }] }
  );
  assert.equal(score.status, 'pass');
  assert.equal(score.truePositive, 1);
  assert.equal(score.falsePositive, 0);
  assert.equal(score.falseNegative, 0);
});

await test('scoreFixture — different status → fail', () => {
  const score = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-1', status: 'auto_matched' }] } },
    { proposals: [{ bank_transaction_id: 'tx-1', status: 'suggested' }] }
  );
  assert.equal(score.status, 'fail');
  assert.equal(score.truePositive, 0);
  assert.equal(score.falseNegative, 1, 'expected pair missed');
  assert.equal(score.falsePositive, 1, 'actual pair unexpected');
});

await test('scoreFixture — extra proposal counts as false positive', () => {
  const score = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-1' }] } },
    { proposals: [{ bank_transaction_id: 'tx-1' }, { bank_transaction_id: 'tx-2' }] }
  );
  assert.equal(score.status, 'fail');
  assert.equal(score.falsePositive, 1);
});

await test('scoreFixture — order-insensitive on multi-proposal sets', () => {
  const score = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-a' }, { bank_transaction_id: 'tx-b' }] } },
    { proposals: [{ bank_transaction_id: 'tx-b' }, { bank_transaction_id: 'tx-a' }] }
  );
  assert.equal(score.status, 'pass');
});

await test('scoreFixture — empty expected vs actual → pass', () => {
  const score = scoreFixture({ expected: { proposals: [] } }, { proposals: [] });
  assert.equal(score.status, 'pass');
  assert.equal(score.expectedSize, 0);
  assert.equal(score.actualSize, 0);
});

await test('scoreFixture — id-only expected matches any status from actual', () => {
  // When expected omits status, only id-equality is checked on BOTH
  // sides. The weighted / LLM modes can disagree on auto_matched vs
  // suggested and still pass a "did the right bank line get proposed?"
  // test — the partial-payment fixtures' documented intent.
  const score = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-1' }] } },
    { proposals: [{ bank_transaction_id: 'tx-1', status: 'auto_matched' }] }
  );
  assert.equal(score.status, 'pass',
    'status-agnostic expected ignores the actual status for that id');
  // Symmetric — same on both sides — passes.
  const score2 = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-1' }] } },
    { proposals: [{ bank_transaction_id: 'tx-1' }] }
  );
  assert.equal(score2.status, 'pass');
  // Multi-target, id-only expected (partial-payment shape): both legs
  // proposed with auto_matched still pass; a decoy still fails.
  const partial = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-dep' }, { bank_transaction_id: 'tx-bal' }] } },
    { proposals: [{ bank_transaction_id: 'tx-dep', status: 'auto_matched' }, { bank_transaction_id: 'tx-bal', status: 'auto_matched' }] }
  );
  assert.equal(partial.status, 'pass', 'both legs matched id-only regardless of status');
  const decoy = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-dep' }] } },
    { proposals: [{ bank_transaction_id: 'tx-dep', status: 'auto_matched' }, { bank_transaction_id: 'tx-decoy', status: 'suggested' }] }
  );
  assert.equal(decoy.status, 'fail', 'an unexpected extra target is still a false positive');
});

await test('scoreFixture — status-pinned expected still enforces the authority band', () => {
  // Regression guard for the status-agnostic change: when expected PINS
  // a status, an aggressive band error (got auto_matched, wanted
  // suggested) must still fail.
  const aggressive = scoreFixture(
    { expected: { proposals: [{ bank_transaction_id: 'tx-1', status: 'suggested' }] } },
    { proposals: [{ bank_transaction_id: 'tx-1', status: 'auto_matched' }] }
  );
  assert.equal(aggressive.status, 'fail',
    'status-pinned expected still distinguishes auto_matched from suggested');
});

await test('scoreFixture — unmatchable_reason exact match', () => {
  const score = scoreFixture(
    { expected: { proposals: [], unmatchable_reason: 'no_plausible_match' } },
    { proposals: [], unmatchable_reason: 'no_plausible_match' }
  );
  assert.equal(score.status, 'pass');
});

await test('scoreFixture — unmatchable_reason mismatch → fail', () => {
  const score = scoreFixture(
    { expected: { proposals: [], unmatchable_reason: 'no_plausible_match' } },
    { proposals: [], unmatchable_reason: 'invalid_llm_response' }
  );
  assert.equal(score.status, 'fail');
});

await test('scoreFixture — unmatchable_reason wildcard accepts any reason', () => {
  const score = scoreFixture(
    { expected: { proposals: [], unmatchable_reason: '*' } },
    { proposals: [], unmatchable_reason: 'no_plausible_match' }
  );
  assert.equal(score.status, 'pass');
  const fail = scoreFixture(
    { expected: { proposals: [], unmatchable_reason: '*' } },
    { proposals: [], unmatchable_reason: null }
  );
  assert.equal(fail.status, 'fail',
    'wildcard still requires SOME reason');
});

// ── aggregateMetrics ─────────────────────────────────────────────────
await test('aggregateMetrics — precision/recall/F1', () => {
  const cases = [
    { status: 'pass', score: { truePositive: 1, falsePositive: 0, falseNegative: 0, expectedSize: 1, actualSize: 1 } },
    { status: 'fail', score: { truePositive: 0, falsePositive: 1, falseNegative: 1, expectedSize: 1, actualSize: 1 } },
    { status: 'pass', score: { truePositive: 2, falsePositive: 0, falseNegative: 0, expectedSize: 2, actualSize: 2 } }
  ];
  const agg = aggregateMetrics(cases);
  assert.equal(agg.totals.fixtures, 3);
  assert.equal(agg.totals.passed, 2);
  assert.equal(agg.totals.failed, 1);
  assert.equal(agg.totals.true_positive, 3);
  assert.equal(agg.totals.false_positive, 1);
  assert.equal(agg.totals.false_negative, 1);
  // precision = 3 / (3+1) = 0.75; recall = 3 / (3+1) = 0.75; F1 = 0.75
  assert.equal(agg.metrics.precision, 0.75);
  assert.equal(agg.metrics.recall, 0.75);
  assert.equal(agg.metrics.f1, 0.75);
  assert.equal(agg.metrics.accuracy, 2 / 3);
});

await test('aggregateMetrics — error cases excluded from p/r/F1', () => {
  const cases = [
    { status: 'pass', score: { truePositive: 1, falsePositive: 0, falseNegative: 0, expectedSize: 1, actualSize: 1 } },
    { status: 'error', error: 'boom' }
  ];
  const agg = aggregateMetrics(cases);
  assert.equal(agg.totals.errored, 1);
  assert.equal(agg.totals.passed, 1);
  // Error did not move TP/FP/FN counters.
  assert.equal(agg.metrics.precision, 1);
  assert.equal(agg.metrics.recall, 1);
});

await test('aggregateMetrics — zero denominators → null metrics', () => {
  const agg = aggregateMetrics([]);
  assert.equal(agg.metrics.precision, null);
  assert.equal(agg.metrics.recall, null);
  assert.equal(agg.metrics.f1, null);
  assert.equal(agg.metrics.accuracy, null);
});

// ── runEval ─────────────────────────────────────────────────────────
await test('runEval — runs every fixture and aggregates', async () => {
  const fixtures = [
    {
      id: 'happy',
      expected: { proposals: [{ bank_transaction_id: 'tx-1' }] }
    },
    {
      id: 'sad',
      expected: { proposals: [{ bank_transaction_id: 'tx-2' }] }
    }
  ];
  const result = await runEval({
    suite: 'recon',
    fixtures,
    runner: async (f) => f.id === 'happy'
      ? { proposals: [{ bank_transaction_id: 'tx-1' }] }
      : { proposals: [{ bank_transaction_id: 'tx-WRONG' }] }
  });
  assert.equal(result.totals.fixtures, 2);
  assert.equal(result.totals.passed, 1);
  assert.equal(result.totals.failed, 1);
  assert.equal(result.cases[0].id, 'happy');
  assert.equal(result.cases[0].status, 'pass');
  assert.equal(result.cases[1].status, 'fail');
});

await test('runEval — throwing runner records error', async () => {
  const modelUsage = { version: 'eaw.model-usage.v1', status: 'incomplete', calls: [{ outcome: 'transport_error' }] };
  const result = await runEval({
    suite: 'recon',
    fixtures: [{ id: 'boom', expected: { proposals: [] } }],
    runner: async () => {
      const error = new Error('upstream down');
      error.modelUsage = modelUsage;
      throw error;
    }
  });
  assert.equal(result.totals.errored, 1);
  assert.equal(result.cases[0].status, 'error');
  assert.match(result.cases[0].error, /upstream down/);
  assert.deepEqual(result.cases[0].modelUsage, modelUsage, 'failed live calls retain their spend receipt');
  // Error did not poison the aggregate.
  assert.equal(result.totals.failed, 0);
  assert.equal(result.totals.passed, 0);
});

await test('runEval — requires a runner function', async () => {
  await assert.rejects(
    runEval({ suite: 'recon', fixtures: [], runner: null }),
    /requires a runner function/
  );
});

await test('runEval — records mode + model + ranAt', async () => {
  const result = await runEval({
    suite: 'recon',
    mode: 'llm',
    model: 'claude-opus-4-7',
    fixtures: [],
    runner: async () => ({ proposals: [] }),
    ranAt: '2026-06-08T00:00:00.000Z'
  });
  assert.equal(result.mode, 'llm');
  assert.equal(result.model, 'claude-opus-4-7');
  assert.equal(result.ranAt, '2026-06-08T00:00:00.000Z');
});

// ── save + load baseline ─────────────────────────────────────────────
await test('saveBaseline + loadBaseline — round-trip', () => {
  const root = mkdtempSync(joinPath(tmpdir(), 'donna-baseline-'));
  try {
    const result = {
      suite: 'recon',
      mode: 'weighted',
      ranAt: '2026-06-08T00:00:00.000Z',
      totals: { fixtures: 1, passed: 1, failed: 0, errored: 0,
                expected_match_count: 1, proposed_match_count: 1,
                true_positive: 1, false_positive: 0, false_negative: 0 },
      metrics: { precision: 1, recall: 1, f1: 1, accuracy: 1 },
      cases: [{ id: 'a', status: 'pass', score: {} }]
    };
    saveBaseline(result, { root });
    const loaded = loadBaseline('recon', 'weighted', { root });
    assert.deepEqual(loaded, result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('loadBaseline — missing file returns null', () => {
  const out = loadBaseline('recon', 'llm', { root: '/tmp/donna-no-baseline-here' });
  assert.equal(out, null);
});

// ── diffAgainstBaseline ──────────────────────────────────────────────
await test('diffAgainstBaseline — no baseline → all cases new', () => {
  const current = {
    suite: 'recon',
    cases: [{ id: 'a', status: 'pass' }, { id: 'b', status: 'fail' }],
    metrics: { precision: 0.5, recall: 0.5, f1: 0.5, accuracy: 0.5 }
  };
  const diff = diffAgainstBaseline(current, null);
  assert.equal(diff.hasBaseline, false);
  assert.deepEqual(diff.newCases, ['a', 'b']);
  assert.deepEqual(diff.regressions, []);
});

await test('diffAgainstBaseline — detects regressions / improvements / new / dropped', () => {
  const baseline = {
    cases: [
      { id: 'a', status: 'pass' }, // becomes fail → regression
      { id: 'b', status: 'fail' }, // becomes pass → improvement
      { id: 'c', status: 'pass' }, // dropped
      { id: 'd', status: 'pass' }  // still pass
    ],
    metrics: { precision: 0.5, recall: 0.5, f1: 0.5, accuracy: 0.5 }
  };
  const current = {
    cases: [
      { id: 'a', status: 'fail' },
      { id: 'b', status: 'pass' },
      { id: 'd', status: 'pass' },
      { id: 'e', status: 'pass' } // new
    ],
    metrics: { precision: 0.75, recall: 0.75, f1: 0.75, accuracy: 0.75 }
  };
  const diff = diffAgainstBaseline(current, baseline);
  assert.equal(diff.hasBaseline, true);
  assert.deepEqual(diff.regressions, ['a']);
  assert.deepEqual(diff.improvements, ['b']);
  assert.deepEqual(diff.newCases, ['e']);
  assert.deepEqual(diff.droppedCases, ['c']);
  assert.equal(diff.metricDeltas.precision, 0.25);
});

await test('diffAgainstBaseline — null metric on one side → null delta', () => {
  const baseline = { cases: [], metrics: { precision: null, recall: 0.5, f1: null, accuracy: 1 } };
  const current = { cases: [], metrics: { precision: 0.8, recall: null, f1: 0.6, accuracy: 1 } };
  const diff = diffAgainstBaseline(current, baseline);
  assert.equal(diff.metricDeltas.precision, null);
  assert.equal(diff.metricDeltas.recall, null);
  assert.equal(diff.metricDeltas.f1, null);
  assert.equal(diff.metricDeltas.accuracy, 0);
});

// ── formatSummary ────────────────────────────────────────────────────
await test('formatSummary — renders metrics + diff', () => {
  const result = {
    suite: 'recon',
    mode: 'llm',
    model: 'claude-opus-4-7',
    totals: { fixtures: 4, passed: 3, failed: 1, errored: 0 },
    metrics: { precision: 0.75, recall: 1, f1: 0.857, accuracy: 0.75 }
  };
  const diff = {
    hasBaseline: true,
    regressions: ['003'],
    improvements: ['001'],
    newCases: [],
    droppedCases: [],
    metricDeltas: { precision: 0.05, recall: 0, f1: 0.03, accuracy: 0.25 }
  };
  const out = formatSummary(result, diff);
  assert.match(out, /suite=recon mode=llm model=claude-opus-4-7/);
  assert.match(out, /fixtures: 4 \(pass 3 \/ fail 1 \/ error 0\)/);
  assert.match(out, /precision=0\.750 recall=1\.000 f1=0\.857/);
  assert.match(out, /Δ vs baseline:/);
  assert.match(out, /REGRESSIONS: 003/);
  assert.match(out, /improvements: 001/);
});

await test('formatSummary — handles null metrics gracefully', () => {
  const result = {
    suite: 'recon',
    mode: 'llm',
    model: null,
    totals: { fixtures: 0, passed: 0, failed: 0, errored: 0 },
    metrics: { precision: null, recall: null, f1: null, accuracy: null }
  };
  const out = formatSummary(result, null);
  assert.match(out, /precision=n\/a recall=n\/a/);
});

// ── scoreFixtureExtraction ───────────────────────────────────────────
await test('scoreFixtureExtraction — every expected field matches → pass', () => {
  const fixture = {
    expected: {
      document_type: 'supplier_bill',
      header: { counterparty_role: 'vendor', currency: 'EUR', total_amount: 110.98 },
      line_count: 2
    }
  };
  const actual = {
    document_type: 'supplier_bill',
    header: { counterparty_role: 'vendor', currency: 'EUR', total_amount: 110.98 },
    line_count: 2
  };
  const score = scoreFixtureExtraction(fixture, actual);
  assert.equal(score.status, 'pass');
  assert.equal(score.truePositive, 5, '4 header fields + 1 doc_type');
  assert.equal(score.falsePositive, 0);
  assert.equal(score.falseNegative, 0);
  assert.equal(score.fields_correct, 5);
  assert.equal(score.fields_total, 5);
  assert.deepEqual(score.mismatched_fields, []);
});

await test('scoreFixtureExtraction — wrong document_type → fail with mismatched_fields', () => {
  const fixture = {
    expected: {
      document_type: 'supplier_bill',
      header: { counterparty_role: 'vendor', currency: 'EUR' }
    }
  };
  const actual = {
    document_type: 'sales_invoice',
    header: { counterparty_role: 'vendor', currency: 'EUR' }
  };
  const score = scoreFixtureExtraction(fixture, actual);
  assert.equal(score.status, 'fail');
  assert.equal(score.truePositive, 2);
  assert.equal(score.falseNegative, 1);
  const m = score.mismatched_fields.find((f) => f.field === 'document_type');
  assert.ok(m);
  assert.equal(m.expected, 'supplier_bill');
  assert.equal(m.actual, 'sales_invoice');
});

await test('scoreFixtureExtraction — header field mismatch → fail', () => {
  const fixture = {
    expected: {
      document_type: 'receipt',
      header: { vendor_name: 'Starbucks', currency: 'SGD', total_amount: 10 }
    }
  };
  const actual = {
    document_type: 'receipt',
    header: { vendor_name: 'Starbucks Coffee Co', currency: 'SGD', total_amount: 10 }
  };
  const score = scoreFixtureExtraction(fixture, actual);
  assert.equal(score.status, 'fail');
  assert.equal(score.falseNegative, 1);
  const m = score.mismatched_fields[0];
  assert.equal(m.field, 'header.vendor_name');
  assert.equal(m.expected, 'Starbucks');
});

await test('scoreFixtureExtraction — missing actual header treats every expected as FN', () => {
  const fixture = {
    expected: {
      document_type: 'supplier_bill',
      header: { counterparty_role: 'vendor', currency: 'EUR' }
    }
  };
  const score = scoreFixtureExtraction(fixture, { document_type: 'supplier_bill' });
  assert.equal(score.status, 'fail');
  // doc_type correct → 1 TP; both header fields missing → 2 FN.
  assert.equal(score.truePositive, 1);
  assert.equal(score.falseNegative, 2);
});

await test('scoreFixtureExtraction — null expected_header value matches null actual', () => {
  // The Failure A regression pins customer_name=null on a bill; the
  // unified extractor's direction-aware mapping returns null in
  // that slot. Make sure null-equality counts as a TP, not a FN.
  const fixture = {
    expected: {
      document_type: 'supplier_bill',
      header: { customer_name: null, counterparty_role: 'vendor' }
    }
  };
  const actual = {
    document_type: 'supplier_bill',
    header: { customer_name: null, counterparty_role: 'vendor' }
  };
  const score = scoreFixtureExtraction(fixture, actual);
  assert.equal(score.status, 'pass');
  assert.equal(score.truePositive, 3);
  assert.equal(score.falseNegative, 0);
});

await test('scoreFixtureExtraction — array values compared with deep-equality', () => {
  const fixture = {
    expected: {
      document_type: 'receipt',
      header: { references: [{ type: 'receipt_number', value: 'R-1' }] }
    }
  };
  const passActual = {
    document_type: 'receipt',
    header: { references: [{ type: 'receipt_number', value: 'R-1' }] }
  };
  assert.equal(scoreFixtureExtraction(fixture, passActual).status, 'pass');
  const failActual = {
    document_type: 'receipt',
    header: { references: [{ type: 'receipt_number', value: 'R-2' }] }
  };
  assert.equal(scoreFixtureExtraction(fixture, failActual).status, 'fail');
});

await test('scoreFixtureExtraction — line_count mismatch → fail', () => {
  const fixture = {
    expected: { document_type: 'receipt', header: {}, line_count: 2 }
  };
  const score = scoreFixtureExtraction(fixture, {
    document_type: 'receipt', header: {}, line_count: 1
  });
  assert.equal(score.status, 'fail');
  const m = score.mismatched_fields.find((f) => f.field === 'line_count');
  assert.ok(m);
  assert.equal(m.expected, 2);
  assert.equal(m.actual, 1);
});

await test('scoreFixtureExtraction — aggregates cleanly through aggregateMetrics', () => {
  // Two extraction-shaped cases with FP=0; precision is degenerate
  // (1.0 when any TP, null otherwise). Recall tracks correctly-
  // extracted fields. Accuracy = per-fixture pass rate.
  const cases = [
    { status: 'pass', score: scoreFixtureExtraction(
      { expected: { document_type: 'receipt', header: { currency: 'SGD' } } },
      { document_type: 'receipt', header: { currency: 'SGD' } }
    ) },
    { status: 'fail', score: scoreFixtureExtraction(
      { expected: { document_type: 'supplier_bill', header: { currency: 'EUR', vendor_name: 'Acme' } } },
      { document_type: 'sales_invoice', header: { currency: 'EUR', vendor_name: 'Acme' } }
    ) }
  ];
  const agg = aggregateMetrics(cases);
  assert.equal(agg.totals.true_positive, 2 + 2, 'pass=2/2, fail=2/3');
  assert.equal(agg.totals.false_negative, 1);
  assert.equal(agg.totals.false_positive, 0);
  assert.equal(agg.metrics.precision, 1, 'FP=0 → precision=1');
  assert.equal(agg.metrics.recall, 4 / 5);
  assert.equal(agg.metrics.accuracy, 0.5);
});

// ── soft counterparty-name metric ────────────────────────────────────
await test('normalizeEntityName — suffix / punctuation / casing insensitive', () => {
  assert.equal(normalizeEntityName('Globex Industries Ltd'), 'globex industries');
  assert.equal(normalizeEntityName('Globex Industries'), 'globex industries');
  assert.equal(normalizeEntityName('GLOBEX INDUSTRIES'), 'globex industries');
  assert.equal(normalizeEntityName('Van der Berg Bouwinspectie B.V.'), 'van der berg bouwinspectie');
  assert.equal(normalizeEntityName('Pinnacle Marketing Ltd (Tenant)'), 'pinnacle marketing');
  assert.equal(normalizeEntityName('Dadant & Sons'), 'dadant sons');
  assert.equal(normalizeEntityName('Acme Office Supplies Oy'), 'acme office supplies');
  assert.equal(normalizeEntityName(null), '');
});

await test('scoreFixtureExtraction — soft name does not gate strict status', () => {
  const fixture = {
    expected: {
      document_type: 'sales_invoice',
      counterparty_name: 'Globex Industries Ltd',
      header: { counterparty_role: 'customer', vendor_name: null, currency: 'GBP' }
    }
  };
  // Strict fields all correct; the name differs only by legal suffix —
  // a strict pin would (wrongly) fail this, the soft metric matches it.
  const score = scoreFixtureExtraction(fixture, {
    document_type: 'sales_invoice',
    header: { counterparty_role: 'customer', vendor_name: null, customer_name: 'Globex Industries', currency: 'GBP' }
  });
  assert.equal(score.status, 'pass', 'name is NOT in the strict gold');
  assert.ok(score.name_soft, 'name_soft recorded when expected.counterparty_name present');
  assert.equal(score.name_soft.match, true);
  assert.equal(score.name_soft.actual, 'Globex Industries');

  // A genuinely wrong entity → soft miss, but strict still passes.
  const wrong = scoreFixtureExtraction(fixture, {
    document_type: 'sales_invoice',
    header: { counterparty_role: 'customer', vendor_name: null, customer_name: 'Initech', currency: 'GBP' }
  });
  assert.equal(wrong.status, 'pass');
  assert.equal(wrong.name_soft.match, false);

  // No reference → no soft score at all.
  const noRef = scoreFixtureExtraction(
    { expected: { document_type: 'receipt', header: { currency: 'SGD' } } },
    { document_type: 'receipt', header: { currency: 'SGD' } }
  );
  assert.equal(noRef.name_soft, null);
});

await test('aggregateMetrics — name_accuracy tracked separately from strict metrics', () => {
  const fixture = {
    expected: {
      document_type: 'sales_invoice', counterparty_name: 'Globex Industries Ltd',
      header: { counterparty_role: 'customer', currency: 'GBP' }
    }
  };
  const hit = { status: 'pass', score: scoreFixtureExtraction(fixture,
    { document_type: 'sales_invoice', header: { counterparty_role: 'customer', customer_name: 'Globex Industries', currency: 'GBP' } }) };
  const miss = { status: 'pass', score: scoreFixtureExtraction(fixture,
    { document_type: 'sales_invoice', header: { counterparty_role: 'customer', customer_name: 'Wrongco', currency: 'GBP' } }) };
  const agg = aggregateMetrics([hit, miss]);
  assert.equal(agg.totals.name_checked, 2);
  assert.equal(agg.totals.name_correct, 1);
  assert.equal(agg.metrics.name_accuracy, 0.5);
  assert.equal(agg.metrics.accuracy, 1, 'strict accuracy unaffected by soft name');

  // A run with no name references → name_accuracy is null (not 0).
  const noNames = aggregateMetrics([{ status: 'pass', score: scoreFixtureExtraction(
    { expected: { document_type: 'receipt', header: { currency: 'SGD' } } },
    { document_type: 'receipt', header: { currency: 'SGD' } }) }]);
  assert.equal(noNames.totals.name_checked, 0);
  assert.equal(noNames.metrics.name_accuracy, null);
});

// ── runEval scorer injection ────────────────────────────────────────
await test('runEval — accepts a custom scorer', async () => {
  const fixtures = [
    { id: 'a', expected: { document_type: 'receipt', header: { currency: 'SGD' } } },
    { id: 'b', expected: { document_type: 'receipt', header: { currency: 'SGD' } } }
  ];
  const result = await runEval({
    suite: 'extraction',
    fixtures,
    runner: async (f) => f.id === 'a'
      ? { document_type: 'receipt', header: { currency: 'SGD' } }
      : { document_type: 'sales_invoice', header: { currency: 'EUR' } },
    scorer: scoreFixtureExtraction
  });
  assert.equal(result.totals.passed, 1);
  assert.equal(result.totals.failed, 1);
  assert.equal(result.cases[0].score.fields_correct, 2);
  assert.equal(result.cases[1].score.fields_correct, 0);
});

await test('runEval — rejects non-function scorer', async () => {
  await assert.rejects(
    runEval({ suite: 'extraction', fixtures: [], runner: async () => ({}), scorer: 'not-a-fn' }),
    /requires a scorer function/
  );
});

await test('runEval — default scorer is scoreFixture (recon set-equality)', async () => {
  // Back-compat: existing reconciliation runner does not pass a
  // scorer and must still see set-equality on proposal pairs.
  const result = await runEval({
    suite: 'reconciliation',
    fixtures: [{
      id: 'r',
      expected: { proposals: [{ bank_transaction_id: 'tx-1', status: 'auto_matched' }] }
    }],
    runner: async () => ({
      proposals: [{ bank_transaction_id: 'tx-1', status: 'auto_matched' }]
    })
  });
  assert.equal(result.cases[0].status, 'pass');
  assert.equal(result.cases[0].score.truePositive, 1);
});

// ── seeded fixtures sanity check ─────────────────────────────────────
// The checked-in fixtures under data/evals/fixtures/reconciliation/
// must parse and carry the minimum fields the runners read. This is
// the gate that catches a malformed fixture before CI burns API
// credits on it.
await test('seeded reconciliation fixtures — present and well-formed', () => {
  const loaded = loadFixtures('reconciliation');
  assert.ok(loaded.length >= 4, 'at least 4 seeded fixtures');
  const ids = loaded.map((f) => f.id);
  for (const f of loaded) {
    assert.ok(f.document?.id, `${f.id} has document.id`);
    assert.ok(Array.isArray(f.candidate_bank_lines),
      `${f.id} has candidate_bank_lines array`);
    assert.ok(f.expected,
      `${f.id} has expected block`);
    assert.ok(Array.isArray(f.expected.proposals),
      `${f.id} expected.proposals is an array`);
  }
});

// Same gate for the extraction suite. The checked-in fixtures
// under data/evals/fixtures/extraction/ carry inline synthetic
// PDFs (base64) generated by scripts/generate_extraction_fixtures.js
// — keep the document_input shape stable so the runner script
// finds what it needs and Failure A's regression fixture stays
// in the set.
await test('seeded extraction fixtures — present and well-formed', () => {
  const loaded = loadFixtures('extraction');
  assert.ok(loaded.length >= 4, 'at least 4 seeded fixtures');
  const ids = loaded.map((f) => f.id);
  for (const f of loaded) {
    assert.ok(f.upload_time_document_type,
      `${f.id} has upload_time_document_type`);
    assert.ok(f.document_input?.base64_synthetic_text_pdf,
      `${f.id} has inline synthetic PDF`);
    assert.ok(f.document_input.mimeType,
      `${f.id} has document_input.mimeType`);
    assert.ok(f.expected,
      `${f.id} has expected block`);
    assert.ok(f.expected.document_type,
      `${f.id} expected.document_type is set`);
    assert.ok(f.expected.header && typeof f.expected.header === 'object',
      `${f.id} expected.header is an object`);
    // PDF magic check — catches a base64 blob that got truncated
    // or rebuilt without the %PDF header.
    const head = Buffer.from(f.document_input.base64_synthetic_text_pdf, 'base64')
      .slice(0, 5).toString('ascii');
    assert.equal(head, '%PDF-', `${f.id} synthetic PDF has valid header`);
  }
});

// Step-1 structural gate: the extraction eval set is per-client
// (strategy §3 Slice D — "Standing eval set per client ... including
// ≥1 cross-currency / processor case per client"). This test encodes
// that invariant so the corpus cannot silently regress below it: every
// named client must be present AND carry at least one cross-currency
// case, and both motivating-bug regressions (Failure A direction-flip,
// Failure B cross-currency/processor) must stay in the set. It is
// offline + LLM-free — it reads only the checked-in fixture JSON, so
// it is safe in CI (the LLM scoring of unified-vs-per-type is gated on
// API keys and lives in scripts/eval_extraction.js).
const EVAL_CLIENTS = ['honeybee', 'wilkes'];

await test('seeded extraction fixtures — per-client cross-currency coverage', () => {
  const loaded = loadFixtures('extraction');
  const byClient = new Map(EVAL_CLIENTS.map((c) => [c, []]));

  for (const f of loaded) {
    assert.ok(EVAL_CLIENTS.includes(f.client),
      `${f.id} has a known client (got ${JSON.stringify(f.client)})`);
    byClient.get(f.client).push(f);
  }

  // Every named client is represented, and each has ≥1 cross-currency
  // / processor case — the Failure-A/B shapes the unified extractor has
  // to beat the per-type path on.
  for (const client of EVAL_CLIENTS) {
    const fixtures = byClient.get(client);
    assert.ok(fixtures.length >= 1, `client "${client}" has at least one fixture`);
    const crossCurrency = fixtures.filter((f) => (f.tags || []).includes('cross_currency'));
    assert.ok(crossCurrency.length >= 1,
      `client "${client}" has at least one cross_currency fixture`);
  }

});

// Gold self-consistency: an `actual` reconstructed verbatim from each
// fixture's `expected` block must score a clean pass. This catches a
// malformed/over-constrained gold (e.g. a header key the scorer can
// never satisfy, or a line_count that contradicts itself) BEFORE an
// LLM run spends credits on it — and is the offline complement to the
// "do not massage fixtures" rail: it proves the gold is internally
// scorable without proving any model can hit it.
await test('seeded extraction fixtures — gold is self-consistent under the scorer', () => {
  const loaded = loadFixtures('extraction');
  for (const f of loaded) {
    const expected = f.expected || {};
    const perfectActual = {
      document_type: expected.document_type,
      header: { ...(expected.header || {}) },
      line_count: expected.line_count
    };
    // Populate the counterparty name on the correct side so the SOFT
    // name metric also resolves to a match for a perfect extraction.
    if (expected.counterparty_name) {
      const role = (expected.header || {}).counterparty_role;
      if (role === 'vendor') perfectActual.header.vendor_name = expected.counterparty_name;
      else if (role === 'customer') perfectActual.header.customer_name = expected.counterparty_name;
    }
    const score = scoreFixtureExtraction(f, perfectActual);
    assert.equal(score.status, 'pass',
      `${f.id} gold scores a pass against itself (mismatches: ${JSON.stringify(score.mismatched_fields)})`);
    if (expected.counterparty_name) {
      assert.ok(score.name_soft && score.name_soft.match,
        `${f.id} soft name matches for a perfect extraction`);
    }
  }
});
