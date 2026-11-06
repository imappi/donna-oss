// AE ae_vat_registration_threshold — the pure watch.
//   node --test server/donna/ae/vatRegistrationThreshold.test.js
//
// Sibling of gb/vatRegistrationThreshold.test.js. The tests that matter most
// here are the AE-specific guards: the voluntary threshold playing no part in
// the mandatory test, and the statute-shaped limb names.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AE_VAT_THRESHOLD_EVIDENCE_TYPE,
  AE_VAT_THRESHOLD_LIMBS,
  AE_VAT_THRESHOLD_STATUSES,
  VAT_MANDATORY_REGISTRATION_THRESHOLD_AED,
  VAT_VOLUNTARY_REGISTRATION_THRESHOLD_AED,
  AE_VAT_THRESHOLD_PROVENANCE,
  buildAeVatRegistrationWatch,
  buildAeVatThresholdEscalationQuestion
} from './vatRegistrationThreshold.js';

const AS_OF = '2026-08-30';

test('the statutory numbers are the right two, and the voluntary one is half the mandatory one', () => {
  assert.equal(VAT_MANDATORY_REGISTRATION_THRESHOLD_AED, 375000);
  assert.equal(VAT_VOLUNTARY_REGISTRATION_THRESHOLD_AED, 187500);
  assert.equal(VAT_VOLUNTARY_REGISTRATION_THRESHOLD_AED * 2, VAT_MANDATORY_REGISTRATION_THRESHOLD_AED);
});

test('provenance carries an as_of and does NOT claim a primary confirmation it does not have', () => {
  assert.equal(AE_VAT_THRESHOLD_PROVENANCE.confirmedAgainstPrimary, false);
  assert.equal(AE_VAT_THRESHOLD_PROVENANCE.asOf, '2026-08-30');
  assert.match(AE_VAT_THRESHOLD_PROVENANCE.authority, /Federal Tax Authority/);
  assert.match(AE_VAT_THRESHOLD_PROVENANCE.source, /Decree-Law No\. 8 of 2017/);
  assert.match(AE_VAT_THRESHOLD_PROVENANCE.source, /Article 13/);
});

test('the voluntary threshold plays NO part in the mandatory registration test', () => {
  // AED 200,000: above the voluntary threshold, barely over half the mandatory
  // one. Conflating the two would make this "exceeded" (or "approaching").
  // It must be plainly ok.
  const watch = buildAeVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 200000 });
  assert.equal(watch.status, 'ok');
});

test('preceding 12 months: rolling turnover over AED 375,000 is exceeded, and names its limb', () => {
  const watch = buildAeVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 400000 });
  assert.equal(watch.status, 'exceeded');
  assert.equal(watch.drivingLimb, 'preceding_12_months');
  assert.equal(watch.rollingTurnover, 400000);
  assert.match(watch.note, /exceeds the mandatory VAT registration threshold/);
  assert.match(watch.note, /Federal Tax Authority/);
});

test('exactly AT the threshold is not exceeded — the test is "exceeds", strictly', () => {
  const watch = buildAeVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 375000 });
  assert.notEqual(watch.status, 'exceeded');
});

test('next 30 days: committed supplies in the window ALONE can trigger on their own', () => {
  // Backward limb quiet (a brand-new business), forward limb not: one big
  // contract landing inside 30 days — the limb with no FI analogue, now on
  // its third market.
  const watch = buildAeVatRegistrationWatch({
    asOf: AS_OF, rollingTurnover: 10000, committedNext30Days: 380000
  });
  assert.equal(watch.status, 'exceeded');
  assert.equal(watch.drivingLimb, 'next_30_days');
  assert.equal(watch.backward.status, 'ok');
  assert.match(watch.note, /30-day window alone/);
});

test('the forward limb is NOT an annualised run-rate', () => {
  // AED 40,000 committed in 30 days annualises to ~AED 487,000 — over the
  // threshold. A run-rate implementation would fire here. The statute tests
  // the 30-day window alone, so this must stay quiet.
  const watch = buildAeVatRegistrationWatch({
    asOf: AS_OF, rollingTurnover: 0, committedNext30Days: 40000
  });
  assert.equal(watch.status, 'ok');
  assert.equal(watch.forward.status, 'ok');
});

test('the worse limb drives the verdict, and both limbs are always reported', () => {
  const watch = buildAeVatRegistrationWatch({
    asOf: AS_OF, rollingTurnover: 310000, committedNext30Days: 500000
  });
  assert.equal(watch.backward.status, 'approaching');
  assert.equal(watch.forward.status, 'exceeded');
  assert.equal(watch.status, 'exceeded');
  assert.equal(watch.drivingLimb, 'next_30_days');
  assert.deepEqual(
    [watch.backward.limb, watch.forward.limb],
    [...AE_VAT_THRESHOLD_LIMBS]
  );
});

test('approaching fires at 80% and reports headroom', () => {
  const watch = buildAeVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 310000 });
  assert.equal(watch.status, 'approaching');
  assert.equal(watch.backward.headroomAed, 65000);
  assert.match(watch.note, /approaching/);
});

test('a quiet book is ok, with no note and no driving limb', () => {
  const watch = buildAeVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 5000 });
  assert.equal(watch.status, 'ok');
  assert.equal(watch.note, null);
  assert.equal(watch.drivingLimb, null);
  assert.ok(AE_VAT_THRESHOLD_STATUSES.includes(watch.status));
});

test('negative turnover clamps to zero rather than going negative', () => {
  const watch = buildAeVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: -5000 });
  assert.equal(watch.rollingTurnover, 0);
  assert.equal(watch.status, 'ok');
});

test('never throws on garbage input', () => {
  for (const bad of [undefined, {}, { rollingTurnover: 'abc' }, { rollingTurnover: null }]) {
    const watch = buildAeVatRegistrationWatch(bad);
    assert.equal(watch.applicable, true);
    assert.ok(AE_VAT_THRESHOLD_STATUSES.includes(watch.status));
  }
});

test('the ask is minted ONLY for exceeded', () => {
  assert.equal(buildAeVatThresholdEscalationQuestion({ watch: null }), null);
  for (const turnover of [5000, 310000, 375000]) {
    const watch = buildAeVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: turnover });
    assert.equal(buildAeVatThresholdEscalationQuestion({ watch }), null);
  }
});

test('the backward-limb ask states the numbers and the honesty boundary', () => {
  const watch = buildAeVatRegistrationWatch({ asOf: AS_OF, rollingTurnover: 400000 });
  const q = buildAeVatThresholdEscalationQuestion({ watch });
  assert.match(q, /AED 400,000\.00/);
  assert.match(q, /AED 375,000\.00/);
  // Donna never registers anybody, and never implies a human will.
  assert.match(q, /cannot register on your behalf/);
  assert.match(q, /no VAT can go on your invoices until the registration is effective/);
  assert.doesNotMatch(q, /accountant|bookkeeper|our team|we will review/i);
});

test('the forward-limb ask asks for the OWNER\'S EXPECTATION, not just the number', () => {
  // Article 13's forward test turns on an anticipation Donna cannot observe,
  // so the ask must put the question to the owner rather than assert the
  // answer.
  const watch = buildAeVatRegistrationWatch({
    asOf: AS_OF, rollingTurnover: 0, committedNext30Days: 380000
  });
  const q = buildAeVatThresholdEscalationQuestion({ watch });
  assert.match(q, /Do you expect/);
  assert.match(q, /next 30 days/);
  assert.match(q, /cannot register on your behalf/);
});

test('the evidence type is the closed constant the drain keys on', () => {
  // Same value the GB watch uses, deliberately — one duty shape, uniform ask
  // surfaces; the client's jurisdiction disambiguates.
  assert.equal(AE_VAT_THRESHOLD_EVIDENCE_TYPE, 'vat_threshold_review');
});
