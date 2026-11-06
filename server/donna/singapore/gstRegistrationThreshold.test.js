// SG — the GST registration-threshold watch: closed statuses, the
// warn-on-either-view rule, the escalation question.
// node --test server/donna/singapore/gstRegistrationThreshold.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SINGAPORE_GST_THRESHOLD_WATCH_FLAG_KEY,
  GST_REGISTRATION_THRESHOLD_SGD,
  GST_THRESHOLD_APPROACH_FRACTION,
  GST_THRESHOLD_STATUSES,
  GST_THRESHOLD_EVIDENCE_TYPE,
  buildGstThresholdEscalationQuestion,
  buildGstRegistrationWatch
} from './gstRegistrationThreshold.js';

test('the threshold pin: S$1M, 80% approach band, closed statuses', () => {
  assert.equal(GST_REGISTRATION_THRESHOLD_SGD, 1000000);
  assert.equal(GST_THRESHOLD_APPROACH_FRACTION, 0.8);
  assert.deepEqual([...GST_THRESHOLD_STATUSES], ['ok', 'approaching', 'exceeded']);
  assert.equal(SINGAPORE_GST_THRESHOLD_WATCH_FLAG_KEY, 'SINGAPORE_GST_THRESHOLD_WATCH');
  assert.equal(GST_THRESHOLD_EVIDENCE_TYPE, 'gst_threshold_review');
});

test('the watch drives on the MAX of the two views (warn-on-either, conservative)', () => {
  const ok = buildGstRegistrationWatch({ year: 2026, calendarYearTurnover: 300000, trailing12mTurnover: 400000 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.drivingTurnover, 400000);
  assert.equal(ok.headroomSgd, 600000);
  assert.equal(ok.note, null);

  const approaching = buildGstRegistrationWatch({ year: 2026, calendarYearTurnover: 850000, trailing12mTurnover: 200000 });
  assert.equal(approaching.status, 'approaching');
  assert.match(approaching.note, /approaching/);

  const exceeded = buildGstRegistrationWatch({ year: 2026, calendarYearTurnover: 100000, trailing12mTurnover: 1000000.01 });
  assert.equal(exceeded.status, 'exceeded');
  assert.match(exceeded.note, /myTax Portal/);
  assert.match(exceeded.note, /No GST on invoices before registration/);
});

test('negative turnover clamps to zero; provenance rides every verdict', () => {
  const watch = buildGstRegistrationWatch({ year: 2026, calendarYearTurnover: -50000, trailing12mTurnover: -1 });
  assert.equal(watch.status, 'ok');
  assert.equal(watch.drivingTurnover, 0);
  assert.equal(watch.provenance.confirmedAgainstPrimary, true);
  assert.ok(watch.provenance.source.includes('S$1,000,000'));
});

test('the escalation question exists only for exceeded and carries the honesty boundary', () => {
  assert.equal(buildGstThresholdEscalationQuestion({ watch: { status: 'ok' } }), null);
  assert.equal(buildGstThresholdEscalationQuestion({ watch: { status: 'approaching' } }), null);
  assert.equal(buildGstThresholdEscalationQuestion({}), null);
  const q = buildGstThresholdEscalationQuestion({
    watch: buildGstRegistrationWatch({ year: 2026, calendarYearTurnover: 1200000 })
  });
  assert.match(q, /S\$1,200,000\.00/);
  assert.match(q, /Donna cannot register on your behalf/);
  assert.match(q, /Do not charge GST on invoices before/);
  assert.match(q, /Have you already registered/);
});

// IRAS Do I need to register for GST; First Schedule para 1: "has exceeded".
// https://sso.agc.gov.sg/Act/GSTA1993#Sc1- (retrieved 2026-09-24).
test('SG-2: exactly S$1M does not exceed the statutory threshold', () => {
  assert.equal(buildGstRegistrationWatch({ calendarYearTurnover: 1000000 }).status, 'approaching');
  assert.equal(buildGstRegistrationWatch({ calendarYearTurnover: 1000000.01 }).status, 'exceeded');
  const watch = buildGstRegistrationWatch({ trailing12mTurnover: 1100000 });
  assert.match(watch.note, /does not establish liability/);
  const question = buildGstThresholdEscalationQuestion({ watch });
  assert.match(question, /30 January/);
  assert.match(question, /30 days of the forecast/);
  assert.doesNotMatch(question, /likely required/);
  assert.equal(watch.provenance.as_of, '2026-09-24');
  assert.match(watch.provenance.url, /^https:\/\/www\.iras\.gov\.sg\//);
});
