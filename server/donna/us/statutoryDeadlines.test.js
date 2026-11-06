import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeUsStatutoryDeadlines,
  US_DEADLINE_STATES,
  US_DEADLINE_DATE_POSTURE,
  US_STATUTORY_DEADLINES_FLAG_KEY
} from './statutoryDeadlines.js';

const client = (entity_type, state = 'us-de') => ({
  profile: { entity_type, jurisdiction_subdivision: state }
});

test('flag key and covered-state list are pinned', () => {
  assert.equal(US_STATUTORY_DEADLINES_FLAG_KEY, 'US_STATUTORY_DEADLINES');
  assert.deepEqual(US_DEADLINE_STATES, ['DE']);
});

// The federal arithmetic is the whole point of the module, so every branch is
// pinned rather than sampled. Authority for each date is in the module header.
test('C corporation: 1120 due April 15, four estimates in the tax year', () => {
  const out = computeUsStatutoryDeadlines({ client: client('us-c-corp'), taxYear: 2025 });
  assert.equal(out.federal.return_form, '1120');
  assert.equal(out.federal.return_due_on, '2026-04-15');
  assert.deepEqual(out.federal.estimated_payment_due_on, [
    '2025-04-15', '2025-06-15', '2025-09-15', '2025-12-15'
  ]);
});

test('S corporation: 1120-S due March 15, no entity-level estimates', () => {
  const out = computeUsStatutoryDeadlines({ client: client('us-s-corp'), taxYear: 2025 });
  assert.equal(out.federal.return_form, '1120-S');
  assert.equal(out.federal.return_due_on, '2026-03-15');
  assert.deepEqual(out.federal.estimated_payment_due_on, []);
});

test('partnership: 1065 due March 15', () => {
  const out = computeUsStatutoryDeadlines({ client: client('us-partnership'), taxYear: 2025 });
  assert.equal(out.federal.return_form, '1065');
  assert.equal(out.federal.return_due_on, '2026-03-15');
});

test('sole proprietor: Schedule C, fourth estimate falls in the following January', () => {
  const out = computeUsStatutoryDeadlines({ client: client('us-sole-prop'), taxYear: 2025 });
  assert.equal(out.federal.return_form, '1040 Schedule C');
  assert.equal(out.federal.return_due_on, '2026-04-15');
  assert.deepEqual(out.federal.estimated_payment_due_on, [
    '2025-04-15', '2025-06-15', '2025-09-15', '2026-01-15'
  ]);
});

test('LLC refuses without a persisted federal tax classification, then follows it', () => {
  assert.throws(
    () => computeUsStatutoryDeadlines({ client: client('us-llc'), taxYear: 2025 }),
    { code: 'US_LLC_TAX_CLASSIFICATION_REQUIRED' }
  );
  const out = computeUsStatutoryDeadlines({
    client: client('us-llc'),
    taxYear: 2025,
    federalTaxClassification: 'partnership'
  });
  assert.equal(out.federal.return_form, '1065');
  assert.equal(out.federal_tax_classification, 'partnership');
});

// Delaware keys off the LEGAL FORM, not the federal election — the case most
// likely to be got wrong by a later edit, so it is pinned explicitly.
test('Delaware: corporations report March 1; LLC/LP owe the annual tax June 1', () => {
  assert.deepEqual(
    computeUsStatutoryDeadlines({ client: client('us-c-corp'), taxYear: 2025 }).state_obligations,
    [{ kind: 'annual_report_and_franchise_tax', due_on: '2026-03-01' }]
  );
  assert.deepEqual(
    computeUsStatutoryDeadlines({ client: client('us-partnership'), taxYear: 2025 }).state_obligations,
    [{ kind: 'annual_tax', due_on: '2026-06-01' }]
  );
});

test('an LLC electing C-corp treatment still owes the June 1 Delaware LLC tax', () => {
  const out = computeUsStatutoryDeadlines({
    client: client('us-llc'),
    taxYear: 2025,
    federalTaxClassification: 'c_corp'
  });
  assert.equal(out.federal.return_form, '1120');
  assert.deepEqual(out.state_obligations, [{ kind: 'annual_tax', due_on: '2026-06-01' }]);
});

test('a Delaware sole proprietor carries no state-entity obligation', () => {
  const out = computeUsStatutoryDeadlines({ client: client('us-sole-prop'), taxYear: 2025 });
  assert.deepEqual(out.state_obligations, []);
});

test('unsupported states refuse rather than borrowing a cadence', () => {
  assert.throws(
    () => computeUsStatutoryDeadlines({ client: client('us-s-corp', 'us-ca'), taxYear: 2025 }),
    { code: 'US_STATE_DEADLINES_UNSUPPORTED' }
  );
});

test('unresolvable entity type and state each refuse before computing anything', () => {
  assert.throws(
    () => computeUsStatutoryDeadlines({ client: client('sg-pte'), taxYear: 2025 }),
    { code: 'US_ENTITY_TYPE_UNKNOWN' }
  );
  assert.throws(
    () => computeUsStatutoryDeadlines({
      client: { profile: { entity_type: 'us-c-corp' } },
      taxYear: 2025
    }),
    { code: 'US_STATE_UNKNOWN' }
  );
});

test('an invalid tax year refuses', () => {
  assert.throws(
    () => computeUsStatutoryDeadlines({ client: client('us-c-corp'), taxYear: 'soon' }),
    { code: 'US_TAX_YEAR_INVALID' }
  );
});

test('the verdict states its date posture rather than implying business days', () => {
  const out = computeUsStatutoryDeadlines({ client: client('us-c-corp'), taxYear: 2025 });
  assert.equal(out.date_posture, US_DEADLINE_DATE_POSTURE);
  assert.equal(out.date_posture, 'nominal_dates_holiday_adjustment_not_applied');
  assert.ok(out.provenance.federal.includes('as of 2026-07-27'));
  assert.ok(out.provenance.DE.includes('as of 2026-07-27'));
});
