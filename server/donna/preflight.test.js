// Donna Loops — deterministic preflight unit tests. Load-bearing properties:
//   - pure function: no DB, no LLM, no external calls
//   - each check emits only when it has the inputs to decide it
//   - severity rolls up to the worst member status (CHECK_STATUSES order)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runDeterministicPreflight,
  accountingChecksFromRiskFlags,
  matchVerdictCheck,
  classifyRemediation,
  confidenceHoldsCheck,
  taxJurisdictionCheck,
  DEFAULT_CONFIDENCE_FLOOR
} from './preflight.js';
import { CHECK_STATUSES } from './operatorContract.js';
import { deriveCaseRiskFlags } from './operatorCaseSnapshot.js';

const namesOf = (report) => report.checks.map((c) => c.name);
const statusOf = (report, name) => report.checks.find((c) => c.name === name)?.status;

test('minimal call (targets + state) → only targets_exist, pass', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a', 'b'] },
    targetStates: { a: {}, b: {} }
  });
  assert.deepEqual(namesOf(report), ['targets_exist']);
  assert.equal(report.status, 'pass');
});

test('targets_exist fails (and blocks) when a target has no state', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a', 'b'] },
    targetStates: { a: {} }
  });
  assert.equal(statusOf(report, 'targets_exist'), 'fail');
  assert.equal(report.status, 'fail');
  assert.match(report.checks[0].detail, /missing target state: b/);
});

test('version_match: stale target (live updated_at != precondition) → fail', () => {
  const report = runDeterministicPreflight({
    card: {
      targets: ['a'],
      preconditions: [{ object: 'a', expected_updated_at: '2026-06-12T10:00:00Z' }]
    },
    targetStates: { a: { updated_at: '2026-06-15T09:00:00Z' } }
  });
  assert.equal(statusOf(report, 'version_match'), 'fail');
  assert.match(report.checks.find((c) => c.name === 'version_match').detail, /a/);
});

test('version_match: matching version → pass', () => {
  const report = runDeterministicPreflight({
    card: {
      targets: ['a'],
      preconditions: [{ object: 'a', expected_updated_at: '2026-06-12T10:00:00Z' }]
    },
    targetStates: { a: { updated_at: '2026-06-12T10:00:00Z' } }
  });
  assert.equal(statusOf(report, 'version_match'), 'pass');
});

test('version_match: null expected_updated_at → check skipped for that target', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a'], preconditions: [{ object: 'a', expected_updated_at: null }] },
    targetStates: { a: { updated_at: '2026-06-15T00:00:00Z' } }
  });
  // preByObject is non-empty so version_match is emitted, but the null-version
  // target is not compared → pass.
  assert.equal(statusOf(report, 'version_match'), 'pass');
});

test('period_not_locked: locked → fail; near boundary → warning; open → pass', () => {
  const base = { card: { targets: ['a'] }, targetStates: { a: {} } };
  assert.equal(statusOf(runDeterministicPreflight({ ...base, period: { locked: true, label: '2026-05' } }), 'period_not_locked'), 'fail');
  assert.equal(statusOf(runDeterministicPreflight({ ...base, period: { near_boundary: true } }), 'period_not_locked'), 'warning');
  assert.equal(statusOf(runDeterministicPreflight({ ...base, period: {} }), 'period_not_locked'), 'pass');
});

test('no_target_already_decided: re-touching a decided row → requires_review', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a', 'b'] },
    targetStates: { a: {}, b: {} },
    decidedTargets: ['b']
  });
  assert.equal(statusOf(report, 'no_target_already_decided'), 'requires_review');
});

test('totals_balance: subtotal + tax != total → fail; balanced → pass', () => {
  const bad = runDeterministicPreflight({
    card: { targets: ['a'], detail: { totals: { subtotal: 100, tax: 20, total: 130 } } },
    targetStates: { a: {} }
  });
  assert.equal(statusOf(bad, 'totals_balance'), 'fail');
  const good = runDeterministicPreflight({
    card: { targets: ['a'], detail: { totals: { subtotal: 100, tax: 20, total: 120 } } },
    targetStates: { a: {} }
  });
  assert.equal(statusOf(good, 'totals_balance'), 'pass');
});

test('journal_balances: debits != credits → fail', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a'], detail: { journal: { debits: 100, credits: 90 } } },
    targetStates: { a: {} }
  });
  assert.equal(statusOf(report, 'journal_balances'), 'fail');
});

test('confidence_holds: below floor → requires_review (stays proposed); at/above → pass; absent → omitted', () => {
  const low = runDeterministicPreflight({
    card: { targets: ['a'], detail: { confidence: 0.4 } },
    targetStates: { a: {} }
  });
  assert.equal(statusOf(low, 'confidence_holds'), 'requires_review');

  const high = runDeterministicPreflight({
    card: { targets: ['a'], detail: { confidence: 0.9 } },
    targetStates: { a: {} }
  });
  assert.equal(statusOf(high, 'confidence_holds'), 'pass');

  const atFloor = runDeterministicPreflight({
    card: { targets: ['a'], detail: { confidence: DEFAULT_CONFIDENCE_FLOOR } },
    targetStates: { a: {} }
  });
  assert.equal(statusOf(atFloor, 'confidence_holds'), 'pass', 'at the floor passes (>=)');

  const none = runDeterministicPreflight({
    card: { targets: ['a'], detail: {} },
    targetStates: { a: {} }
  });
  assert.equal(namesOf(none).includes('confidence_holds'), false, 'no confidence in the card → check omitted, not a pass');
});

test('confidence_holds: a below-floor card cannot auto-commit (report escalates to requires_review)', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a'], detail: { confidence: 0.5 } },
    targetStates: { a: {} }
  });
  // targets_exist passes, but the low confidence must lift the whole report off
  // 'pass' so the diff engine never AUTO-commits it (L1: stays proposed).
  assert.equal(report.status, 'requires_review');
});

test('confidenceHoldsCheck: helper honours a custom floor and omits non-numeric', () => {
  assert.equal(confidenceHoldsCheck(0.6, 0.5)?.status, 'pass', '0.6 >= custom floor 0.5');
  assert.equal(confidenceHoldsCheck(0.4, 0.5)?.status, 'requires_review', '0.4 < custom floor 0.5');
  assert.equal(confidenceHoldsCheck(null), null, 'non-numeric → null (omit)');
  assert.equal(confidenceHoldsCheck(undefined), null, 'absent → null (omit)');
  assert.equal(confidenceHoldsCheck(0.9, 'nonsense')?.status, 'pass', 'bad floor falls back to the default');
});

test('rolls up to the worst status across all member checks', () => {
  const report = runDeterministicPreflight({
    card: {
      targets: ['a'],
      preconditions: [{ object: 'a', expected_updated_at: 'T1' }],
      detail: { totals: { subtotal: 100, tax: 20, total: 130 } } // fail
    },
    targetStates: { a: { updated_at: 'T1' } }, // version pass
    period: { near_boundary: true } // warning
  });
  // worst of {pass, pass, warning, fail} = fail
  assert.equal(report.status, 'fail');
  assert.ok(report.checks.length >= 4);
  assert.ok(report.status === CHECK_STATUSES[CHECK_STATUSES.length - 1]);
});

// ─── Slice D — accounting-domain checks from Slice-C risk flags ──────────────

test('accountingChecksFromRiskFlags: absent / non-present riskFlags → no checks', () => {
  assert.deepEqual(accountingChecksFromRiskFlags(null), []);
  assert.deepEqual(accountingChecksFromRiskFlags({ present: false, reason: 'not_included' }), []);
  assert.deepEqual(accountingChecksFromRiskFlags({ present: true }), []);
});

test('accountingChecksFromRiskFlags: flagged escalates, clear passes, unknown is OMITTED', () => {
  const riskFlags = {
    present: true,
    flags: {
      suspense_exposure: { status: 'flagged', reason: 'no_coded_account', coded_account: null },
      evidence_required: { status: 'flagged', reason: 'persisted_model_verdict' },
      materiality_band: { status: 'flagged', reason: 'threshold_applied', amount: 9000, currency: 'EUR', band: 'material' },
      first_use_account: { status: 'unknown', reason: 'no_account_history_in_context' },
      duplicate_risk: { status: 'unknown', reason: 'no_duplicate_index_in_context' },
      tax_treatment_required: { status: 'clear', reason: 'persisted_model_verdict' }
    }
  };
  const checks = accountingChecksFromRiskFlags(riskFlags);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  // suspense/first-use RENDER (warning); evidence/materiality/duplicate/tax ESCALATE.
  assert.equal(byName.suspense_exposure.status, 'warning');
  assert.equal(byName.evidence_required.status, 'requires_review');
  assert.equal(byName.materiality_band.status, 'requires_review');
  assert.match(byName.materiality_band.detail, /9000 EUR \(material\)/);
  // clear → pass
  assert.equal(byName.tax_treatment_required.status, 'pass');
  // unknown → omitted entirely (preflight only emits a check it can decide)
  assert.ok(!('first_use_account' in byName));
  assert.ok(!('duplicate_risk' in byName));
  // every emitted check uses the controlled status vocabulary
  for (const c of checks) assert.ok(CHECK_STATUSES.includes(c.status));
});

test('matchVerdictCheck RENDERS the persisted verdict (never re-checks); absent → null', () => {
  assert.equal(matchVerdictCheck(null), null);
  assert.equal(matchVerdictCheck({ reason: 'no boolean' }), null);
  assert.equal(matchVerdictCheck({ reconciles: true }).status, 'pass');
  const bad = matchVerdictCheck({ reconciles: false, reason: 'FX hop unverified' });
  assert.equal(bad.status, 'requires_review');
  assert.equal(bad.name, 'match_reconciles');
  assert.match(bad.detail, /FX hop unverified/);
});

test('runDeterministicPreflight appends the domain + match checks and rolls up', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a'] },
    targetStates: { a: {} },
    riskFlags: {
      present: true,
      flags: {
        suspense_exposure: { status: 'clear', reason: 'coded:Rent' },
        evidence_required: { status: 'flagged', reason: 'persisted_model_verdict' },
        materiality_band: { status: 'unknown', reason: 'no_materiality_threshold_in_context' },
        first_use_account: { status: 'unknown', reason: 'x' },
        duplicate_risk: { status: 'unknown', reason: 'x' },
        tax_treatment_required: { status: 'unknown', reason: 'x' }
      }
    },
    matchVerdict: { reconciles: true }
  });
  const names = report.checks.map((c) => c.name);
  assert.ok(names.includes('targets_exist'));
  assert.ok(names.includes('suspense_exposure'));     // clear → pass, emitted
  assert.ok(names.includes('evidence_required'));     // flagged → requires_review
  assert.ok(names.includes('match_reconciles'));      // rendered verdict → pass
  assert.ok(!names.includes('materiality_band'));     // unknown → omitted
  // worst of {pass, pass(suspense), requires_review(evidence), pass(match)} = requires_review
  assert.equal(report.status, 'requires_review');
});

test('omitting riskFlags/matchVerdict is shadow-safe: behaves exactly as before (no live change)', () => {
  const before = runDeterministicPreflight({ card: { targets: ['a'] }, targetStates: { a: {} } });
  assert.deepEqual(before.checks.map((c) => c.name), ['targets_exist']);
  assert.equal(before.status, 'pass');
});

test('classifyRemediation: "not just no" — every escalation names a safe next action + terminal', () => {
  // No flags → nothing to classify.
  assert.equal(classifyRemediation(null), null);
  assert.equal(classifyRemediation({ present: false }), null);

  // evidence_required is the ONLY branch that routes to the owner (FIRST principle).
  const owner = classifyRemediation({ present: true, flags: { evidence_required: { status: 'flagged' }, suspense_exposure: { status: 'flagged' } } });
  assert.deepEqual(owner, { safe_next_action: 'request_evidence', terminal_target: 'on_owner', reason: 'flag:evidence_required' });

  // A non-owner flag remediates toward auto_reconciled.
  const suspense = classifyRemediation({ present: true, flags: { suspense_exposure: { status: 'flagged' } } });
  assert.equal(suspense.safe_next_action, 'recode_from_suspense');
  assert.equal(suspense.terminal_target, 'auto_reconciled');

  // Owner-blocking precedence: evidence beats materiality.
  const both = classifyRemediation({ present: true, flags: { materiality_band: { status: 'flagged' }, evidence_required: { status: 'flagged' } } });
  assert.equal(both.safe_next_action, 'request_evidence');

  // None fired but some unknown → honest non-terminal: resolve the context first.
  const unknown = classifyRemediation({ present: true, flags: { materiality_band: { status: 'unknown' }, suspense_exposure: { status: 'clear' } } });
  assert.equal(unknown.safe_next_action, 'resolve_context');
  assert.equal(unknown.terminal_target, null);

  // All clear → apply → auto_reconciled.
  const clean = classifyRemediation({ present: true, flags: { suspense_exposure: { status: 'clear' }, evidence_required: { status: 'clear' } } });
  assert.deepEqual(clean, { safe_next_action: 'apply', terminal_target: 'auto_reconciled', reason: 'all_flags_clear' });
});

// ─── tax_code_jurisdiction — structural validity gate ────────────────────────

test('taxJurisdictionCheck: foreign/unresolved jurisdiction → fail; valid → pass; absent code → null', () => {
  // A Singapore GST code leaking onto a Finnish client's line (Failure-A class).
  const foreign = taxJurisdictionCheck('GST 9%', 'fi');
  assert.equal(foreign.status, 'fail');
  assert.equal(foreign.name, 'tax_code_jurisdiction');
  assert.match(foreign.detail, /not valid for jurisdiction FI/);
  assert.match(foreign.detail, /Finland ALV/);

  assert.equal(taxJurisdictionCheck('GST 9%', 'sg').status, 'pass');
  assert.equal(taxJurisdictionCheck('ALV 25,5 %', 'fi').status, 'pass');
  // 2026-07-23: gb/au/us now have registered vocabularies (taxVocabularies.js)
  // — an SG treatment on a US client is affirmatively foreign, no longer the
  // coverage-gap omit.
  assert.equal(taxJurisdictionCheck('No sales tax', 'us').status, 'pass');
  assert.equal(taxJurisdictionCheck('GST 9%', 'us').status, 'fail');

  // A missing code has no membership to check; unresolved policy cannot authorize a supplied code.
  assert.equal(taxJurisdictionCheck(null, 'sg'), null, 'no code → omit');
  assert.equal(taxJurisdictionCheck('GST 9%', 'de').status, 'fail', 'unregistered jurisdiction cannot accept a tax code');
  assert.equal(taxJurisdictionCheck('GST 9%', null).status, 'fail', 'no jurisdiction cannot accept a tax code');
});

test('taxJurisdictionCheck: retired routing flags cannot soften foreign-country refusal', () => {
  for (const coderRouted of [false, true, null, undefined]) {
    assert.equal(taxJurisdictionCheck('GST 9%', 'gb', { coderRouted }).status, 'fail');
    assert.equal(taxJurisdictionCheck('ALV 25,5 %', 'gb', { coderRouted }).status, 'fail');
    assert.equal(taxJurisdictionCheck('VAT 20%', 'gb', { coderRouted }).status, 'pass');
  }
});

test('runDeterministicPreflight: an unrouted SG treatment on GB blocks apply', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a'], detail: { tax_treatment: 'GST 9%' } },
    targetStates: { a: {} }, jurisdiction: 'gb', coderRouted: false
  });
  assert.equal(statusOf(report, 'tax_code_jurisdiction'), 'fail');
  assert.equal(report.status, 'fail');
});

test('runDeterministicPreflight: a foreign tax code BLOCKS (report → fail)', () => {
  const report = runDeterministicPreflight({
    card: { targets: ['a'], detail: { tax_treatment: 'GST 9%' } },
    targetStates: { a: {} },
    jurisdiction: 'fi'
  });
  assert.equal(statusOf(report, 'tax_code_jurisdiction'), 'fail');
  // A wrong-country code must lift the whole report to fail (blocks the Apply
  // button) — a structural refusal, not a review escalation.
  assert.equal(report.status, 'fail');
});

test('runDeterministicPreflight: reads card.detail.tax_treatment; explicit taxCode overrides', () => {
  // From the card detail (the coder's persisted treatment).
  const fromCard = runDeterministicPreflight({
    card: { targets: ['a'], detail: { tax_treatment: 'GST 9%' } },
    targetStates: { a: {} },
    jurisdiction: 'sg'
  });
  assert.equal(statusOf(fromCard, 'tax_code_jurisdiction'), 'pass');

  // Explicit taxCode param wins over the card detail.
  const explicit = runDeterministicPreflight({
    card: { targets: ['a'], detail: { tax_treatment: 'GST 9%' } },
    targetStates: { a: {} },
    jurisdiction: 'sg',
    taxCode: 'ALV 25,5 %'
  });
  assert.equal(statusOf(explicit, 'tax_code_jurisdiction'), 'fail');
});

test('runDeterministicPreflight: a supplied tax code requires jurisdiction; absent code has no membership check', () => {
  // A code with no jurisdiction cannot silently pass.
  const noJur = runDeterministicPreflight({
    card: { targets: ['a'], detail: { tax_treatment: 'GST 9%' } },
    targetStates: { a: {} }
  });
  assert.equal(statusOf(noJur, 'tax_code_jurisdiction'), 'fail');

  // Jurisdiction supplied but no code on the card → omitted (undecidable).
  const noCode = runDeterministicPreflight({
    card: { targets: ['a'], detail: {} },
    targetStates: { a: {} },
    jurisdiction: 'sg'
  });
  assert.equal(namesOf(noCode).includes('tax_code_jurisdiction'), false);
});

test('C→D handoff: a real deriveCaseRiskFlags output maps cleanly into the preflight report', () => {
  // Prove the Slice-C → Slice-D pipeline end to end: the snapshot's risk flags,
  // computed with a supplied riskContext, escalate the deterministic checks.
  const riskFlags = deriveCaseRiskFlags({
    transaction: { account_name: 'Suspense', money_in: 9000, account_currency: 'EUR' },
    reviewItem: { payload: {} },
    latestModelDecision: { present: true, proposed_account: 'Consulting revenue', evidence_required: true },
    context: { materialityThreshold: 1000 }   // 9000 ≥ 1000 ⇒ material
  });
  const report = runDeterministicPreflight({
    card: { targets: ['tx-1'] },
    targetStates: { 'tx-1': {} },
    riskFlags
  });
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
  assert.equal(byName.suspense_exposure.status, 'warning');      // parked at Suspense
  assert.equal(byName.evidence_required.status, 'requires_review');
  assert.equal(byName.materiality_band.status, 'requires_review'); // material
  assert.equal(report.status, 'requires_review');
});
