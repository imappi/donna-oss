// SG — retention arithmetic, the purge guard's typed refusal, the PDPA anchors.
// node --test server/donna/singapore/pdpa.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SG_RECORD_RETENTION_YEARS,
  buildSgRetentionAssessment,
  assertSgRetentionAllowsPurge,
  SG_PDPA_PURPOSES,
  SG_PDPA_DATA_CLASSES,
  SG_PDPA_PROVENANCE,
  SG_RETENTION_PROVENANCE
} from './pdpa.js';

test('retention: 5 years with the income-tax calendar-year anchor, expiry only on a supplied now', () => {
  assert.equal(SG_RECORD_RETENTION_YEARS, 5);
  const assessment = buildSgRetentionAssessment({ periodEndsOn: '2025-12-31' });
  assert.equal(assessment.retain_until, '2030-12-31');
  assert.equal(assessment.expired, false, 'no now supplied → never expired');
  assert.equal(buildSgRetentionAssessment({ periodEndsOn: '2025-12-31', now: '2031-01-01' }).expired, true);
  assert.equal(buildSgRetentionAssessment({ periodEndsOn: '2025-12-31', now: '2030-12-31' }).expired, false, 'inclusive end');
  assert.match(assessment.note, /retained until 2030-12-31/);
  assert.throws(() => buildSgRetentionAssessment({}), (e) => e.code === 'SINGAPORE_RETENTION_PERIOD_INVALID');
  assert.equal(SG_RETENTION_PROVENANCE.confirmedAgainstPrimary, true);
});

test('the purge guard refuses inside the window (typed 409) and allows after it', () => {
  try {
    assertSgRetentionAllowsPurge({ periodEndsOn: '2025-12-31', onDate: '2027-05-01' });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'SINGAPORE_RETENTION_PURGE_REFUSED');
    assert.equal(error.retainUntil, '2030-12-31');
  }
  const allowed = assertSgRetentionAllowsPurge({ periodEndsOn: '2025-12-31', onDate: '2031-01-01' });
  assert.equal(allowed.retain_until, '2030-12-31');
  assert.throws(() => assertSgRetentionAllowsPurge({ periodEndsOn: '2025-12-31' }), /onDate/);
});

test('the PDPA anchors are closed, and the PayNow mobile proxy is named as personal data', () => {
  assert.ok(SG_PDPA_PURPOSES.includes('bookkeeping_and_reconciliation'));
  assert.ok(SG_PDPA_DATA_CLASSES.includes('paynow_mobile_proxies'), 'the SG-specific class is explicit');
  assert.ok(SG_PDPA_DATA_CLASSES.includes('payroll_records'));
  assert.equal(SG_PDPA_PROVENANCE.confirmedAgainstPrimary, true);
});

// IRAS Record Keeping Requirements, Example 2, retrieved 2026-09-24:
// https://www.iras.gov.sg/taxes/corporate-income-tax/basics-of-corporate-income-tax/record-keeping-requirements
test('SG-2: September FYE records cannot be released before the IRAS December anchor', () => {
  const assessment = buildSgRetentionAssessment({ periodEndsOn: '2022-09-30', now: '2027-10-01' });
  assert.equal(assessment.retain_until, '2027-12-31');
  assert.equal(assessment.expired, false);
  assert.throws(() => assertSgRetentionAllowsPurge({ periodEndsOn: '2022-09-30', onDate: '2027-12-31' }),
    { code: 'SINGAPORE_RETENTION_PURGE_REFUSED' });
  assert.equal(assertSgRetentionAllowsPurge({ periodEndsOn: '2022-09-30', onDate: '2028-01-01' }).expired, true);
  assert.equal(buildSgRetentionAssessment({ periodEndsOn: '2024-02-29' }).retain_until, '2029-12-31');
  assert.equal(SG_RETENTION_PROVENANCE.as_of, '2026-09-24');
  assert.match(SG_RETENTION_PROVENANCE.quote, /31 Dec 2027/);
});
