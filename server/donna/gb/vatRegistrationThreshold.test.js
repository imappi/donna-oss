// GB gb_vat_registration_threshold — the pure watch.
//   node --test server/donna/gb/vatRegistrationThreshold.test.js
//
// Sibling of finland/alvRegistrationThreshold.test.js. The tests that matter
// most here are the ones with NO Finnish counterpart: the forward-look limb,
// and the guard against conflating the registration and deregistration
// thresholds.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GB_VAT_THRESHOLD_EVIDENCE_TYPE,
  GB_VAT_THRESHOLD_LIMBS,
  GB_VAT_THRESHOLD_STATUSES,
  GB_VAT_THRESHOLD_WATCH_FLAG_KEY,
  VAT_DEREGISTRATION_THRESHOLD_GBP,
  VAT_REGISTRATION_THRESHOLD_GBP,
  VAT_THRESHOLD_PROVENANCE,
  buildGbVatRegistrationWatch,
  buildGbVatThresholdEscalationQuestion
} from './vatRegistrationThreshold.js';

const AS_OF = '2026-07-27';

test('the statutory numbers are the right two, and they are not the same number', () => {
  assert.equal(VAT_REGISTRATION_THRESHOLD_GBP, 90000);
  assert.equal(VAT_DEREGISTRATION_THRESHOLD_GBP, 88000);
  assert.notEqual(VAT_REGISTRATION_THRESHOLD_GBP, VAT_DEREGISTRATION_THRESHOLD_GBP);
});

test('provenance carries an as_of and does NOT claim a primary confirmation it does not have', () => {
  assert.equal(VAT_THRESHOLD_PROVENANCE.confirmedAgainstPrimary, false);
  assert.equal(VAT_THRESHOLD_PROVENANCE.asOf, '2026-07-27');
  assert.match(VAT_THRESHOLD_PROVENANCE.authority, /HM Revenue/);
  assert.match(VAT_THRESHOLD_PROVENANCE.source, /Schedule 1/);
});

test('the deregistration threshold plays NO part in the registration test', () => {
  // £89,000: over the deregistration threshold, under the registration one.
  // Conflating the two would make this "exceeded". It must not.
  const watch = buildGbVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 89000 });
  assert.notEqual(watch.status, 'exceeded');
  assert.equal(watch.backward.status, 'approaching');
});

test('backward look: rolling turnover over £90,000 is exceeded, and names its limb', () => {
  const watch = buildGbVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 95000 });
  assert.equal(watch.status, 'exceeded');
  assert.equal(watch.drivingLimb, 'backward_look');
  assert.equal(watch.rollingTurnover, 95000);
  assert.match(watch.note, /exceeds the VAT registration threshold/);
  assert.match(watch.note, /within 30 days of the end of the month/);
});

test('exactly AT the threshold is not exceeded — both paragraphs test "exceeds"', () => {
  const watch = buildGbVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 90000 });
  assert.notEqual(watch.status, 'exceeded');
});

test('forward look: committed supplies in the 30-day window ALONE can trigger on their own', () => {
  // Backward limb is quiet (a brand-new business), forward limb is not: one
  // big contract landing inside 30 days. This is the case with no FI analogue.
  const watch = buildGbVatRegistrationWatch({
    asOf: AS_OF, rollingTurnover: 5000, committedNext30Days: 120000
  });
  assert.equal(watch.status, 'exceeded');
  assert.equal(watch.drivingLimb, 'forward_look');
  assert.equal(watch.backward.status, 'ok');
  assert.match(watch.note, /30-day window alone/);
});

test('the forward limb is NOT an annualised run-rate', () => {
  // £10,000 committed in 30 days annualises to £120,000 — over the threshold.
  // A run-rate implementation would fire here. The statute tests the 30-day
  // window alone, so this must stay quiet.
  const watch = buildGbVatRegistrationWatch({
    asOf: AS_OF, rollingTurnover: 0, committedNext30Days: 10000
  });
  assert.equal(watch.status, 'ok');
  assert.equal(watch.forward.status, 'ok');
});

test('the worse limb drives the verdict, and both limbs are always reported', () => {
  const watch = buildGbVatRegistrationWatch({
    asOf: AS_OF, rollingTurnover: 75000, committedNext30Days: 200000
  });
  assert.equal(watch.backward.status, 'approaching');
  assert.equal(watch.forward.status, 'exceeded');
  assert.equal(watch.status, 'exceeded');
  assert.equal(watch.drivingLimb, 'forward_look');
  assert.deepEqual(
    [watch.backward.limb, watch.forward.limb],
    [...GB_VAT_THRESHOLD_LIMBS]
  );
});

test('approaching fires at 80% and reports headroom', () => {
  const watch = buildGbVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 72000 });
  assert.equal(watch.status, 'approaching');
  assert.equal(watch.backward.headroomGbp, 18000);
  assert.match(watch.note, /approaching/);
});

test('a quiet book is ok, with no note and no driving limb', () => {
  const watch = buildGbVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 1000 });
  assert.equal(watch.status, 'ok');
  assert.equal(watch.note, null);
  assert.equal(watch.drivingLimb, null);
  assert.ok(GB_VAT_THRESHOLD_STATUSES.includes(watch.status));
});

test('negative turnover clamps to zero rather than going negative', () => {
  const watch = buildGbVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: -5000 });
  assert.equal(watch.rollingTurnover, 0);
  assert.equal(watch.status, 'ok');
});

test('never throws on garbage input', () => {
  for (const bad of [undefined, {}, { rollingTurnover: 'abc' }, { rollingTurnover: null }]) {
    const watch = buildGbVatRegistrationWatch(bad);
    assert.equal(watch.applicable, true);
    assert.ok(GB_VAT_THRESHOLD_STATUSES.includes(watch.status));
  }
});

test('the ask is minted ONLY for exceeded', () => {
  assert.equal(buildGbVatThresholdEscalationQuestion({ watch: null }), null);
  for (const turnover of [1000, 72000, 90000]) {
    const watch = buildGbVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: turnover });
    assert.equal(buildGbVatThresholdEscalationQuestion({ watch }), null);
  }
});

test('the backward-limb ask states the numbers and the honesty boundary', () => {
  const watch = buildGbVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 95000 });
  const q = buildGbVatThresholdEscalationQuestion({ watch });
  assert.match(q, /£95,000\.00/);
  assert.match(q, /£90,000\.00/);
  // Donna never registers anybody, and never implies a human will.
  assert.match(q, /cannot register on your behalf/);
  assert.match(q, /no VAT can go on your invoices until the registration is effective/);
  assert.doesNotMatch(q, /accountant|bookkeeper|our team|we will review/i);
});

test('the forward-limb ask asks for the OWNER\'S EXPECTATION, not just the number', () => {
  // The whole point: para 1(1)(b) turns on a belief Donna cannot observe, so
  // the ask must put the question to the owner rather than assert the answer.
  const watch = buildGbVatRegistrationWatch({
    asOf: AS_OF, rollingTurnover: 0, committedNext30Days: 120000
  });
  const q = buildGbVatThresholdEscalationQuestion({ watch });
  assert.match(q, /Do you expect/);
  assert.match(q, /next 30 days/);
  assert.match(q, /cannot register on your behalf/);
});

test('the flag key and evidence type are the closed constants the drain keys on', () => {
  assert.equal(GB_VAT_THRESHOLD_WATCH_FLAG_KEY, 'GB_VAT_THRESHOLD_WATCH');
  assert.equal(GB_VAT_THRESHOLD_EVIDENCE_TYPE, 'vat_threshold_review');
});
