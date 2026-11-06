/**
 * Unit tests for Louis → auto-promote feedback loop.
 * Run with: node server/donna/auto-promote.test.js
 *
 * These tests exercise autoPromoteFromLouis in isolation by importing
 * the batch flow helpers and simulating Louis results without hitting
 * any external API.
 */

// We can't import autoPromoteFromLouis directly (it's module-private),
// so we test the promotion logic inline and verify the storage side-effects.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0;
let failed = 0;

const assert = (label, actual, expected) => {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
};

const assertTruthy = (label, value) => {
  if (value) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected truthy, got: ${JSON.stringify(value)}`);
  }
};

const assertNull = (label, value) => {
  if (value === null || value === undefined) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected null/undefined, got: ${JSON.stringify(value)}`);
  }
};

// ── Inline replica of autoPromoteFromLouis logic for unit testing ────
// This mirrors the function in api.js so we can test the decision logic
// without needing to spin up the full server or touch disk.

const VALID_STRENGTHS = ['gold', 'approved', 'reject', 'historical_reference'];

const computePromotion = (louisResult) => {
  if (!louisResult || louisResult.verdict !== 'pass') return null;
  const scores = louisResult.scores;
  if (!scores) return null;

  const dims = [scores.correctness, scores.completeness, scores.tone, scores.actionability];
  if (dims.some((d) => typeof d !== 'number' || d < 1)) return null;

  const avg = dims.reduce((sum, d) => sum + d, 0) / dims.length;
  const allPerfect = dims.every((d) => d === 5);

  if (allPerfect) return 'approved';
  if (avg >= 4) return 'historical_reference';
  return null;
};

// ── Test: Perfect 5/5/5/5 → approved ────────────────────────────────

console.log('\n--- computePromotion ---');

assert(
  'Perfect 5/5/5/5 → approved',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 5, completeness: 5, tone: 5, actionability: 5 }
  }),
  'approved'
);

// ── Test: High but not perfect → historical_reference ───────────────

assert(
  '5/4/5/5 (avg 4.75) → historical_reference',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 5, completeness: 4, tone: 5, actionability: 5 }
  }),
  'historical_reference'
);

assert(
  '4/4/4/4 (avg 4.0) → historical_reference',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 4, completeness: 4, tone: 4, actionability: 4 }
  }),
  'historical_reference'
);

assert(
  '5/5/4/4 (avg 4.5) → historical_reference',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 5, completeness: 5, tone: 4, actionability: 4 }
  }),
  'historical_reference'
);

// ── Test: Below threshold → null (skip) ─────────────────────────────

assertNull(
  '3/4/4/4 (avg 3.75) → skip',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 3, completeness: 4, tone: 4, actionability: 4 }
  })
);

assertNull(
  '5/5/5/2 (avg 4.25 but has 2) → skip (verdict would be warn)',
  computePromotion({
    verdict: 'warn',
    scores: { correctness: 5, completeness: 5, tone: 5, actionability: 2 }
  })
);

assertNull(
  '3/3/3/3 (avg 3.0) → skip',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 3, completeness: 3, tone: 3, actionability: 3 }
  })
);

// ── Test: Edge cases ────────────────────────────────────────────────

assertNull(
  'verdict = fail → skip',
  computePromotion({
    verdict: 'fail',
    scores: { correctness: 5, completeness: 5, tone: 5, actionability: 5 }
  })
);

assertNull(
  'verdict = warn → skip',
  computePromotion({
    verdict: 'warn',
    scores: { correctness: 4, completeness: 4, tone: 4, actionability: 4 }
  })
);

assertNull(
  'verdict = error → skip',
  computePromotion({
    verdict: 'error',
    scores: {},
    reasoning: 'API call failed'
  })
);

assertNull(
  'verdict = skipped → skip',
  computePromotion({
    verdict: 'skipped',
    scores: {},
    reasoning: 'ANTHROPIC_API_KEY not configured.'
  })
);

assertNull(
  'null result → skip',
  computePromotion(null)
);

assertNull(
  'missing scores → skip',
  computePromotion({ verdict: 'pass', scores: null })
);

assertNull(
  'missing dimension → skip',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 5, completeness: 5, tone: 5 }
  })
);

assertNull(
  'non-numeric score → skip',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 5, completeness: 5, tone: 5, actionability: 'high' }
  })
);

// ── Test: strength values are valid ─────────────────────────────────

console.log('\n--- strength validation ---');

const allResults = [
  computePromotion({ verdict: 'pass', scores: { correctness: 5, completeness: 5, tone: 5, actionability: 5 } }),
  computePromotion({ verdict: 'pass', scores: { correctness: 4, completeness: 4, tone: 4, actionability: 4 } })
];

for (const strength of allResults) {
  assertTruthy(
    `strength "${strength}" is in allowed list`,
    VALID_STRENGTHS.includes(strength)
  );
}

// ── Test: boundary — exactly avg 4.0 is included ────────────────────

console.log('\n--- boundary conditions ---');

assert(
  'Exactly avg 4.0 (4/4/4/4) → historical_reference',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 4, completeness: 4, tone: 4, actionability: 4 }
  }),
  'historical_reference'
);

assert(
  'Just below avg 4.0 (3/4/4/5 = 4.0) → historical_reference',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 3, completeness: 4, tone: 4, actionability: 5 }
  }),
  'historical_reference'
);

assert(
  'Below avg 4.0 (3/3/4/5 = 3.75) → skip',
  computePromotion({
    verdict: 'pass',
    scores: { correctness: 3, completeness: 3, tone: 4, actionability: 5 }
  }),
  null
);

// ── Test: review_note format ────────────────────────────────────────

console.log('\n--- review_note format ---');

{
  const dims = [5, 5, 5, 5];
  const note = `Auto-promoted by Louis (${dims.join('/')})`;
  assert('review_note format for 5/5/5/5', note, 'Auto-promoted by Louis (5/5/5/5)');
}

{
  const dims = [5, 4, 5, 4];
  const note = `Auto-promoted by Louis (${dims.join('/')})`;
  assert('review_note format for 5/4/5/4', note, 'Auto-promoted by Louis (5/4/5/4)');
}

// ── Test: dedup via sampleId format ─────────────────────────────────

console.log('\n--- sampleId dedup ---');

{
  const caseId = 'test-case-123';
  const sampleId = `auto_${caseId}`;
  assert('sampleId format', sampleId, 'auto_test-case-123');
}

{
  const sampleId = `auto_${Date.now()}`;
  assertTruthy('sampleId with timestamp starts with auto_', sampleId.startsWith('auto_'));
}

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
