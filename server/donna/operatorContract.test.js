// Operator Contract (Phase 0) — fixture tests. Pins:
//   - the seven-intent enum, check statuses, reversibility classes,
//     review modes (literal lists — drift from the docs is a bug)
//   - enum parity: card.triage_source / triage items ↔ OPERATOR_INTENTS,
//     report statuses ↔ CHECK_STATUSES
//   - closed envelopes (required === properties, strict-schema pattern)
//   - JSON-serializability + deep-frozenness of every exported fixture
//   - the docs' own examples validate against their schemas
//   - validator semantics (missing keys, unknown keys, enums, nested
//     types, minItems, anyOf-null)
//   - check-report severity (worst wins, unknown fails closed) and the
//     appliability rule (no report → not appliable; fail blocks;
//     requires_review escalates but does not block)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPLY_RECEIPT_SCHEMA,
  CHECK_REPORT_SCHEMA,
  CHECK_STATUSES,
  EXAMPLE_APPLY_RECEIPT,
  EXAMPLE_CHECK_REPORT,
  EXAMPLE_PROPOSAL_CARD,
  EXAMPLE_TRIAGE_RECEIPT,
  OPERATOR_CONTRACT_INVARIANTS,
  OPERATOR_CONTRACT_SCHEMAS,
  OPERATOR_INTENTS,
  PROPOSAL_CARD_SCHEMA,
  REVERSIBILITY_CLASSES,
  REVIEW_MODES,
  TRIAGE_RECEIPT_SCHEMA,
  assertMatchesOperatorContract,
  proposalCardIsAppliable,
  summarizeCheckReport,
  validateOperatorContract,
  worstCheckStatus
} from './operatorContract.js';

// ─── Enums ───────────────────────────────────────────────────────────────

await test('the seven intents are pinned literally (plan §3.1)', () => {
  assert.deepEqual([...OPERATOR_INTENTS], [
    'diagnostic',
    'state_correction',
    'memory_candidate',
    'policy_request',
    'engineering_escalation',
    'unsupported',
    'question'
  ]);
});

await test('check statuses are pinned in severity order (contract §6)', () => {
  assert.deepEqual([...CHECK_STATUSES], ['pass', 'warning', 'requires_review', 'fail']);
});

await test('reversibility classes are pinned (plan §3.2)', () => {
  assert.deepEqual([...REVERSIBILITY_CLASSES], [
    'recode_before_posting',
    'reversible_via_adjustment',
    'irreversible_external'
  ]);
});

await test('review modes are pinned (contract §11)', () => {
  assert.deepEqual([...REVIEW_MODES], [
    'operator_one_click',
    'accountant_approval',
    'client_confirmation',
    'second_reviewer',
    'engineering'
  ]);
});

await test('the five §3.5 invariants are present with stable ids', () => {
  assert.deepEqual(
    OPERATOR_CONTRACT_INVARIANTS.map((inv) => inv.id),
    ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']
  );
  for (const inv of OPERATOR_CONTRACT_INVARIANTS) {
    assert.equal(typeof inv.rule, 'string');
    assert.ok(inv.rule.length > 0);
  }
});

// ─── Enum parity across schemas ──────────────────────────────────────────

await test('triage receipt intent enums match OPERATOR_INTENTS exactly', () => {
  assert.deepEqual(TRIAGE_RECEIPT_SCHEMA.properties.triage.items.enum, OPERATOR_INTENTS);
  assert.deepEqual(TRIAGE_RECEIPT_SCHEMA.properties.not_handled_as.items.enum, OPERATOR_INTENTS);
});

await test('card triage_source enum matches OPERATOR_INTENTS exactly', () => {
  assert.deepEqual(PROPOSAL_CARD_SCHEMA.properties.triage_source.enum, OPERATOR_INTENTS);
});

await test('card review_mode and reversibility enums match the pinned vocabularies', () => {
  assert.deepEqual(PROPOSAL_CARD_SCHEMA.properties.review_mode.enum, REVIEW_MODES);
  assert.deepEqual(
    PROPOSAL_CARD_SCHEMA.properties.reversibility.enum,
    [...REVERSIBILITY_CLASSES, null]
  );
});

await test('check report status enums match CHECK_STATUSES', () => {
  assert.deepEqual(CHECK_REPORT_SCHEMA.properties.status.enum, CHECK_STATUSES);
  assert.deepEqual(CHECK_REPORT_SCHEMA.properties.checks.items.properties.status.enum, CHECK_STATUSES);
});

// ─── Envelope discipline ─────────────────────────────────────────────────

await test('closed envelopes require every property (strict-schema pattern)', () => {
  const closed = [
    TRIAGE_RECEIPT_SCHEMA,
    CHECK_REPORT_SCHEMA,
    PROPOSAL_CARD_SCHEMA,
    PROPOSAL_CARD_SCHEMA.properties.blast_radius,
    APPLY_RECEIPT_SCHEMA,
    APPLY_RECEIPT_SCHEMA.properties.per_target.items
  ];
  for (const schema of closed) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  }
});

await test('the registry exposes exactly the four contract schemas', () => {
  assert.deepEqual(
    Object.keys(OPERATOR_CONTRACT_SCHEMAS).sort(),
    ['apply_receipt', 'check_report', 'proposal_card', 'triage_receipt']
  );
});

// ─── Fixture hygiene ─────────────────────────────────────────────────────

function assertDeepFrozen(node, path = '$') {
  if (node && typeof node === 'object') {
    assert.ok(Object.isFrozen(node), `${path} is not frozen`);
    for (const [key, value] of Object.entries(node)) assertDeepFrozen(value, `${path}.${key}`);
  }
}

await test('every exported fixture is JSON-serializable and deep-frozen', () => {
  const fixtures = {
    ...OPERATOR_CONTRACT_SCHEMAS,
    invariants: OPERATOR_CONTRACT_INVARIANTS,
    example_triage: EXAMPLE_TRIAGE_RECEIPT,
    example_report: EXAMPLE_CHECK_REPORT,
    example_card: EXAMPLE_PROPOSAL_CARD,
    example_receipt: EXAMPLE_APPLY_RECEIPT
  };
  for (const [name, fixture] of Object.entries(fixtures)) {
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture, `${name} round-trips through JSON`);
    assertDeepFrozen(fixture, name);
  }
});

// ─── The docs' examples validate against their schemas ───────────────────

await test('canonical examples satisfy their schemas', () => {
  assert.deepEqual(validateOperatorContract(TRIAGE_RECEIPT_SCHEMA, EXAMPLE_TRIAGE_RECEIPT).errors, []);
  assert.deepEqual(validateOperatorContract(CHECK_REPORT_SCHEMA, EXAMPLE_CHECK_REPORT).errors, []);
  assert.deepEqual(validateOperatorContract(PROPOSAL_CARD_SCHEMA, EXAMPLE_PROPOSAL_CARD).errors, []);
  assert.deepEqual(validateOperatorContract(APPLY_RECEIPT_SCHEMA, EXAMPLE_APPLY_RECEIPT).errors, []);
});

await test('assertMatchesOperatorContract passes good values through and names violations', () => {
  assert.equal(assertMatchesOperatorContract('proposal_card', EXAMPLE_PROPOSAL_CARD), EXAMPLE_PROPOSAL_CARD);
  assert.throws(
    () => assertMatchesOperatorContract('triage_receipt', { triage: ['question'] }),
    /triage_receipt contract violation.*not_handled_as.*required/s
  );
  assert.throws(() => assertMatchesOperatorContract('nope', {}), /Unknown operator-contract schema/);
});

// ─── Validator semantics ─────────────────────────────────────────────────

await test('validator rejects unknown keys on closed envelopes', () => {
  const card = { ...EXAMPLE_PROPOSAL_CARD, surprise: true };
  const { ok, errors } = validateOperatorContract(PROPOSAL_CARD_SCHEMA, card);
  assert.equal(ok, false);
  assert.ok(errors.some((err) => err.includes('$.surprise') && err.includes('unknown key')));
});

await test('validator rejects out-of-enum and wrong nested types with paths', () => {
  const card = JSON.parse(JSON.stringify(EXAMPLE_PROPOSAL_CARD));
  card.triage_source = 'vibes';
  card.blast_radius.transactions = 2.5;
  const { errors } = validateOperatorContract(PROPOSAL_CARD_SCHEMA, card);
  assert.ok(errors.some((err) => err.startsWith('$.triage_source:')));
  assert.ok(errors.some((err) => err.startsWith('$.blast_radius.transactions:')));
});

await test('triage must classify into at least one intent (minItems)', () => {
  const receipt = { triage: [], not_handled_as: [], reason: 'unclassified' };
  const { ok, errors } = validateOperatorContract(TRIAGE_RECEIPT_SCHEMA, receipt);
  assert.equal(ok, false);
  assert.ok(errors.some((err) => err.includes('$.triage') && err.includes('at least 1')));
});

await test('checks may be null pre-preflight (anyOf), but not garbage', () => {
  const card = { ...EXAMPLE_PROPOSAL_CARD, checks: null };
  assert.equal(validateOperatorContract(PROPOSAL_CARD_SCHEMA, card).ok, true);
  const bad = { ...EXAMPLE_PROPOSAL_CARD, checks: 'looks fine' };
  assert.equal(validateOperatorContract(PROPOSAL_CARD_SCHEMA, bad).ok, false);
});

await test('preconditions stay open for per-kind expected_* keys, anchored on object', () => {
  const card = JSON.parse(JSON.stringify(EXAMPLE_PROPOSAL_CARD));
  card.preconditions = [{ object: 'doc_1', expected_parse_status: 'parsed' }];
  assert.equal(validateOperatorContract(PROPOSAL_CARD_SCHEMA, card).ok, true);
  card.preconditions = [{ expected_review_state: 'suggested' }];
  const { errors } = validateOperatorContract(PROPOSAL_CARD_SCHEMA, card);
  assert.ok(errors.some((err) => err.includes('preconditions[0].object: required')));
});

// ─── Check-report helpers ────────────────────────────────────────────────

await test('worstCheckStatus picks the most severe status; empty is pass', () => {
  assert.equal(worstCheckStatus([]), 'pass');
  assert.equal(worstCheckStatus(['pass', 'warning']), 'warning');
  assert.equal(worstCheckStatus(['warning', 'requires_review', 'pass']), 'requires_review');
  assert.equal(worstCheckStatus(['pass', 'fail', 'warning']), 'fail');
});

await test('unknown statuses fail closed', () => {
  assert.equal(worstCheckStatus(['pass', 'okay-ish']), 'fail');
});

await test('summarizeCheckReport derives the rolled-up status and validates', () => {
  const report = summarizeCheckReport([
    { name: 'targets_exist', status: 'pass', detail: null },
    { name: 'journal_balances', status: 'requires_review', detail: 'FX bridge unexplained.' }
  ]);
  assert.equal(report.status, 'requires_review');
  assert.deepEqual(validateOperatorContract(CHECK_REPORT_SCHEMA, report).errors, []);
  assert.deepEqual(summarizeCheckReport(null), { status: 'pass', checks: [] });
});

await test('appliability: no report blocks, fail blocks, requires_review does not', () => {
  assert.equal(proposalCardIsAppliable({ ...EXAMPLE_PROPOSAL_CARD, checks: null }), false);
  assert.equal(proposalCardIsAppliable(EXAMPLE_PROPOSAL_CARD), true);
  const failing = {
    ...EXAMPLE_PROPOSAL_CARD,
    checks: summarizeCheckReport([{ name: 'period_not_locked', status: 'fail', detail: 'May is closed.' }])
  };
  assert.equal(proposalCardIsAppliable(failing), false);
  const escalated = {
    ...EXAMPLE_PROPOSAL_CARD,
    checks: summarizeCheckReport([{ name: 'unusual_tax_treatment', status: 'requires_review', detail: null }])
  };
  assert.equal(proposalCardIsAppliable(escalated), true);
});

await test('an inconsistent report never errs permissive (worst of rollup vs members)', () => {
  const inconsistent = {
    ...EXAMPLE_PROPOSAL_CARD,
    checks: { status: 'fail', checks: [{ name: 'targets_exist', status: 'pass', detail: null }] }
  };
  assert.equal(proposalCardIsAppliable(inconsistent), false);
});
