// Prospecting Lab spine — unit coverage for the pure invariants: dossier
// validation (no signal / no negative evidence / rubric shape), lifecycle
// transitions (research_only is parkable, terminals are dead ends), tier
// capability flags (red never sends or bills off tier alone), and the reject
// taxonomy normalization.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROSPECT_SOURCES,
  PROSPECT_STATUSES,
  PROSPECT_TIERS,
  REJECT_REASONS,
  RUBRIC_DIMENSIONS,
  TERMINAL_PROSPECT_STATUSES,
  isLegalTransition,
  normalizeRejectReasons,
  tierCapabilities,
  validateDossier
} from './prospectLab.js';

const GOOD_DOSSIER = {
  disorder_signal: {
    summary: 'Accounts overdue at Companies House',
    citation: 'companyProfile accounts.next_accounts.overdue=true, due_on 2026-03-31, checked 2026-07-05'
  },
  why_now: 'Overdue since March; penalties double at six months.',
  recommended_action: 'approve',
  main_risk: 'Could be a broken-books remediation case rather than merely behind.',
  negative_evidence: ['Website last updated 2024 — trading status unverified.'],
  rubric: {
    pain_evidence: 3,
    fit_confidence: 2,
    contact_legitimacy: 3,
    delivery_complexity: 2,
    payment_compliance_risk: 1,
    message_quality: 3,
    expected_value: 2
  },
  fit: {
    service_business: 'yes',
    volume_under_1000: 'unknown',
    single_entity: 'yes',
    country_in_icp: 'yes'
  }
};

test('a complete dossier validates clean', () => {
  assert.deepEqual(validateDossier(GOOD_DOSSIER), []);
});

test('no signal, no dossier — and citations are mandatory', () => {
  const noSignal = validateDossier({ ...GOOD_DOSSIER, disorder_signal: {} });
  assert.ok(noSignal.some((v) => /no signal, no dossier/.test(v)));
  const noCite = validateDossier({
    ...GOOD_DOSSIER,
    disorder_signal: { summary: 'feels behind' }
  });
  assert.ok(noCite.some((v) => /citation/.test(v)));
});

test('an empty negative-evidence block refuses (no optimistic SDR)', () => {
  const violations = validateDossier({ ...GOOD_DOSSIER, negative_evidence: ['  '] });
  assert.ok(violations.some((v) => /negative-evidence/.test(v)));
});

test('rubric scores must be integers 1..3 across all dimensions', () => {
  const violations = validateDossier({
    ...GOOD_DOSSIER,
    rubric: { ...GOOD_DOSSIER.rubric, expected_value: 5 }
  });
  assert.ok(violations.some((v) => /rubric\.expected_value/.test(v)));
  assert.equal(RUBRIC_DIMENSIONS.length, 7);
});

test('fit gates are yes/no/unknown — never guessed into fit', () => {
  const violations = validateDossier({
    ...GOOD_DOSSIER,
    fit: { ...GOOD_DOSSIER.fit, volume_under_1000: 'probably' }
  });
  assert.ok(violations.some((v) => /fit\.volume_under_1000/.test(v)));
});

test('lifecycle: research_only parks and can resume; terminals are dead ends', () => {
  assert.equal(isLegalTransition('investigating', 'research_only'), true);
  assert.equal(isLegalTransition('research_only', 'on_kari'), true);
  assert.equal(isLegalTransition('on_kari', 'research_only'), true);
  for (const terminal of TERMINAL_PROSPECT_STATUSES) {
    for (const to of PROSPECT_STATUSES) {
      assert.equal(isLegalTransition(terminal, to), false, `${terminal} → ${to} must be illegal`);
    }
  }
  // No teleporting: a candidate can't be contacted without passing Kari.
  assert.equal(isLegalTransition('candidate', 'contacted_awaiting_reply'), false);
  assert.equal(isLegalTransition('on_kari', 'approved_for_send'), true);
});

test('tier capabilities: red never sends or bills off tier alone', () => {
  assert.deepEqual(PROSPECT_TIERS, ['green', 'yellow', 'red']);
  const red = tierCapabilities('red');
  assert.equal(red.can_generate_dossier, true);
  assert.equal(red.can_generate_message, false);
  assert.equal(red.can_send, 'requires_segment_signoff');
  assert.equal(red.can_bill, 'requires_billing_rail_signoff');
  const green = tierCapabilities('green');
  assert.equal(green.can_send, 'per_send_approval'); // never unsupervised either
});

test('reject reasons normalize to the taxonomy; unknown reasons survive as other', () => {
  assert.ok(REJECT_REASONS.includes('too_inventory_heavy'));
  assert.deepEqual(normalizeRejectReasons(['weak_fit', 'volume way too big']), [
    { reason: 'weak_fit' },
    { reason: 'other', note: 'volume way too big' }
  ]);
  assert.deepEqual(normalizeRejectReasons({ reason: 'bad_timing', note: 'mid-audit' }), [
    { reason: 'bad_timing', note: 'mid-audit' }
  ]);
});

test('source vocabulary is pinned (campaign ≠ source lives in the schema)', () => {
  assert.deepEqual([...PROSPECT_SOURCES], [
    'companies_house_overdue',
    'companies_house_first_filing',
    'manual_upload'
  ]);
});
