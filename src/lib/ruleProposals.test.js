// Reconciliation PR 5 — Proposed memory helper tests.
//
// Plain-Node, no DOM, no JSDOM — mirrors src/lib/receiptReview.test.js.
// FE-side coverage for tests 18, 19, 20 in the PR 5 test plan, plus
// supplementary structural assertions for the helpers the JSX renders.

import {
  allowedRuleActionsFor,
  buildProposedRuleRow,
  buildProposedRuleRows,
  buildRulePatchForAction,
  buildRuleTelemetry,
  formatRuleChip,
  proposedRuleSummary,
  requiresRuleConfirmPrompt,
  ruleChipLabel,
  ruleTelemetryHasPii
} from './ruleProposals.js';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  fail ${name}`);
    console.error(`       ${err?.message || err}`);
  }
};

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const assertDeepEqual = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label}: expected ${b}, got ${a}`);
  }
};

const assertTrue = (value, label) => {
  if (!value) throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
};

const assertFalse = (value, label) => {
  if (value) throw new Error(`${label}: expected falsy, got ${JSON.stringify(value)}`);
};

const proposedRule = (overrides = {}) => ({
  id: 'rule-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  status: 'proposed',
  created_by: 'system_learned',
  pattern_text: 'taxi',
  account_code: '6420',
  payload: {
    source: 'system_learned',
    merchant_pattern: 'taxi',
    expense_kind: 'taxi',
    account_code: '6420',
    observation_count: 3,
    observation_window_days: 90,
    confidence_avg: 0.93,
    last_observed_at: '2026-05-12T00:00:00.000Z',
    policy_version: 'rule_learner_v1'
  },
  updated_at: '2026-05-13T00:00:00.000Z',
  ...overrides
});

console.log('ruleProposals:');

// =====================================================================
// Test 18: buildProposedRuleRows filters to status='proposed'.
// =====================================================================
test('18: buildProposedRuleRows filters out active and retired rules', () => {
  const rules = [
    proposedRule({ id: 'p1' }),
    proposedRule({ id: 'a1', status: 'active' }),
    proposedRule({ id: 'r1', status: 'retired' }),
    proposedRule({ id: 'p2' })
  ];
  const rows = buildProposedRuleRows({ clientRules: rules });
  assertEqual(rows.length, 2, 'two proposed rules in the bucket');
  const ids = rows.map((r) => r.id).sort();
  assertDeepEqual(ids, ['p1', 'p2'], 'only proposed rule ids');
});

test('18b: buildProposedRuleRows excludes firm-typed proposed rules', () => {
  const rules = [
    proposedRule({ id: 'human-typed', created_by: 'human', payload: { merchant_pattern: 'taxi' } }),
    proposedRule({ id: 'p1' })
  ];
  const rows = buildProposedRuleRows({ clientRules: rules });
  assertEqual(rows.length, 1, 'system-learned only');
  assertEqual(rows[0].id, 'p1', 'system-learned id');
});

// =====================================================================
// Test 19: allowedRuleActionsFor returns the right set per status.
// =====================================================================
test('19: allowedRuleActionsFor proposed=[commit,discard]; active=[]; retired=[]', () => {
  assertDeepEqual(allowedRuleActionsFor(proposedRule()), ['commit', 'discard'], 'proposed actions');
  assertDeepEqual(allowedRuleActionsFor(proposedRule({ status: 'active' })), [], 'active terminal');
  assertDeepEqual(allowedRuleActionsFor(proposedRule({ status: 'retired' })), [], 'retired terminal');
  assertDeepEqual(allowedRuleActionsFor({}), [], 'unknown status');
});

// =====================================================================
// Test 20: buildRuleTelemetry is PII-safe.
// =====================================================================
test('20: buildRuleTelemetry contains only categorical + numeric fields', () => {
  const payload = buildRuleTelemetry({
    action: 'commit',
    rule: proposedRule({
      // raw PII fields that MUST NOT leak into telemetry
      payload: {
        ...proposedRule().payload,
        vendor_name: 'Grab Singapore Pte Ltd',
        merchant_display_name: 'Grab',
        reference_number: 'INV-12345',
        description: 'Late-night ride',
        raw_description: 'GRAB*TAXI 12345 SG',
        contact: 'Grab Holdings'
      }
    })
  });
  assertEqual(payload.event, 'rule_proposal.action_clicked', 'event name');
  assertEqual(payload.action, 'commit', 'action');
  assertEqual(payload.prev_status, 'proposed', 'prev_status');
  assertEqual(payload.next_status, 'active', 'next_status');
  assertEqual(payload.has_classifier_metadata, true, 'has_classifier_metadata');
  assertEqual(payload.confidence_band, 'high', 'confidence_band');
  assertEqual(payload.observation_count, 3, 'observation_count');
  assertFalse(ruleTelemetryHasPii(payload), 'no PII fields');

  // exhaustive: ensure NONE of the PII fields landed
  ['vendor_name', 'merchant_display_name', 'reference_number', 'description', 'raw_description', 'contact'].forEach((key) =>
    assertFalse(Object.prototype.hasOwnProperty.call(payload, key), `payload has no ${key}`)
  );
  // and the raw vendor name strings must not be embedded in any field
  const asString = JSON.stringify(payload).toLowerCase();
  assertFalse(asString.includes('grab singapore'), 'raw vendor name not embedded');
  assertFalse(asString.includes('inv-12345'), 'reference number not embedded');
  assertFalse(asString.includes('late-night ride'), 'raw description not embedded');
});

// =====================================================================
// Patch + prompt helpers.
// =====================================================================
test('commit action targets active; discard targets retired', () => {
  assertDeepEqual(
    buildRulePatchForAction({ action: 'commit', rule: proposedRule() }),
    { status: 'active' },
    'commit patch'
  );
  assertDeepEqual(
    buildRulePatchForAction({ action: 'discard', rule: proposedRule() }),
    { status: 'retired' },
    'discard patch'
  );
  assertEqual(buildRulePatchForAction({ action: 'unknown', rule: proposedRule() }), null, 'unknown action');
});

test('both commit and discard require confirmation prompt (Q9)', () => {
  assertEqual(requiresRuleConfirmPrompt('commit'), true, 'commit prompts');
  assertEqual(requiresRuleConfirmPrompt('discard'), true, 'discard prompts');
  assertEqual(requiresRuleConfirmPrompt('other'), false, 'other no prompt');
});

// =====================================================================
// Summary + chip formatting.
// =====================================================================
test('proposedRuleSummary extracts canonical pattern + count', () => {
  const summary = proposedRuleSummary(proposedRule());
  assertEqual(summary.pattern_display, 'taxi', 'pattern_display');
  assertEqual(summary.kind_display, 'Taxi', 'kind_display title-cased');
  assertEqual(summary.account_code, '6420', 'account_code');
  assertEqual(summary.observation_count, 3, 'observation_count');
  assertEqual(summary.confidence_band, 'high', 'confidence_band');
  assertEqual(summary.window_days, 90, 'window_days');
});

test('proposedRuleSummary returns null when pattern is empty', () => {
  assertEqual(
    proposedRuleSummary(proposedRule({ pattern_text: '', payload: { merchant_pattern: '' } })),
    null,
    'empty pattern → null summary'
  );
});

test('formatRuleChip renders PII-free copy', () => {
  const summary = proposedRuleSummary(proposedRule());
  const chip = formatRuleChip(summary);
  assertEqual(chip, 'Taxi · 3 firm confirmations', 'chip copy');
  assertFalse(chip.toLowerCase().includes('grab'), 'no vendor name in chip');
});

test('formatRuleChip handles singular firm confirmation correctly', () => {
  const summary = proposedRuleSummary(
    proposedRule({ payload: { ...proposedRule().payload, observation_count: 1 } })
  );
  assertEqual(formatRuleChip(summary), 'Taxi · 1 firm confirmation', 'singular copy');
});

// =====================================================================
// Row construction.
// =====================================================================
test('buildProposedRuleRow returns null for non-system-learned rules', () => {
  assertEqual(buildProposedRuleRow({ rule: proposedRule({ created_by: 'human' }) }), null, 'human-typed');
  assertEqual(buildProposedRuleRow({ rule: null }), null, 'null rule');
  assertEqual(buildProposedRuleRow({ rule: proposedRule({ status: 'active' }) }), null, 'active rule');
});

test('buildProposedRuleRow returns row with summary + actions for proposed', () => {
  const row = buildProposedRuleRow({ rule: proposedRule() });
  assertTrue(row, 'row built');
  assertEqual(row.id, 'rule-1', 'id');
  assertEqual(row.chip, 'proposed', 'chip key');
  assertEqual(row.chipLabel, 'Proposed memory', 'chip label');
  assertDeepEqual(row.allowedActions, ['commit', 'discard'], 'actions');
});

test('buildProposedRuleRows sorts newest first', () => {
  const rules = [
    proposedRule({ id: 'old', payload: { ...proposedRule().payload, last_observed_at: '2026-04-01T00:00:00.000Z' } }),
    proposedRule({ id: 'new', payload: { ...proposedRule().payload, last_observed_at: '2026-05-12T00:00:00.000Z' } }),
    proposedRule({ id: 'mid', payload: { ...proposedRule().payload, last_observed_at: '2026-05-01T00:00:00.000Z' } })
  ];
  const ids = buildProposedRuleRows({ clientRules: rules }).map((r) => r.id);
  assertDeepEqual(ids, ['new', 'mid', 'old'], 'newest-first order');
});

test('ruleChipLabel covers each status', () => {
  assertEqual(ruleChipLabel({ status: 'proposed' }), 'Proposed memory', 'proposed');
  assertEqual(ruleChipLabel({ status: 'active' }), 'Active memory', 'active');
  assertEqual(ruleChipLabel({ status: 'retired' }), 'Retired memory', 'retired');
  assertEqual(ruleChipLabel({ status: 'mystery' }), 'Proposed memory', 'unknown fallback');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
