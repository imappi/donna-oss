import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidFiscalPeriodBounds,
  overlappingFiscalPeriods,
  planFiscalPeriodRegistration,
  statutoryBoundProvenanceFor,
  FISCAL_PERIOD_STATUTORY_BOUND_PROVENANCE
} from './fiscalPeriodIntake.js';

const gbYear = { label: '2026/27', startsOn: '2026-04-01', endsOn: '2027-03-31' };
const persisted = (over = {}) => ({ id: 'fy-1', label: '2026/27', starts_on: '2026-04-01', ends_on: '2027-03-31', status: 'open', ...over });

const refuses = (fn, code, message) => {
  assert.throws(fn, (error) => error.code === code, message || code);
};

test('neutral bounds refuse non-ISO dates and a period that ends before it starts', () => {
  for (const bad of [
    { startsOn: '2026-4-1', endsOn: '2027-03-31' },
    { startsOn: '2026-04-01', endsOn: 'next March' },
    { startsOn: '', endsOn: '2027-03-31' },
    { startsOn: undefined, endsOn: undefined }
  ]) {
    refuses(() => assertValidFiscalPeriodBounds(bad), 'FISCAL_PERIOD_BAD_BOUNDS');
  }
  refuses(() => assertValidFiscalPeriodBounds({ startsOn: '2027-03-31', endsOn: '2026-04-01' }), 'FISCAL_PERIOD_BAD_BOUNDS');
  // A single-day period is degenerate but not invalid — the schema allows it too.
  assert.deepEqual(
    assertValidFiscalPeriodBounds({ startsOn: '2026-04-01', endsOn: '2026-04-01' }),
    { startsOn: '2026-04-01', endsOn: '2026-04-01' }
  );
});

test('overlap is inclusive on both ends, and abutting periods do not overlap', () => {
  const existing = [persisted()];
  // Shares only the last day.
  assert.equal(overlappingFiscalPeriods({ startsOn: '2027-03-31', endsOn: '2028-03-30' }, existing).length, 1);
  // Shares only the first day.
  assert.equal(overlappingFiscalPeriods({ startsOn: '2025-04-01', endsOn: '2026-04-01' }, existing).length, 1);
  // Abuts on either side — the normal year-over-year case, must be clean.
  assert.equal(overlappingFiscalPeriods({ startsOn: '2027-04-01', endsOn: '2028-03-31' }, existing).length, 0);
  assert.equal(overlappingFiscalPeriods({ startsOn: '2025-04-01', endsOn: '2026-03-31' }, existing).length, 0);
  // A row with unusable bounds is skipped rather than treated as a match.
  assert.equal(overlappingFiscalPeriods({ startsOn: '2026-06-01', endsOn: '2026-07-01' }, [persisted({ starts_on: null, ends_on: null })]).length, 0);
});

test('a first GB period plans an insert, with the statutory bound recorded as UNENFORCED', () => {
  const plan = planFiscalPeriodRegistration({ ...gbYear, existingPeriods: [], jurisdiction: 'GB' });
  assert.equal(plan.decision, 'insert');
  assert.deepEqual(plan.period, { label: '2026/27', starts_on: '2026-04-01', ends_on: '2027-03-31', status: 'open' });
  // The honesty this module exists for: no GB maximum is asserted, and the plan
  // says so rather than leaving the reader to assume a check ran.
  assert.equal(plan.statutory.bound_enforced, false);
  assert.equal(plan.statutory.jurisdiction, 'GB');
  assert.equal(FISCAL_PERIOD_STATUTORY_BOUND_PROVENANCE.GB.enforced, false);
  assert.equal(FISCAL_PERIOD_STATUTORY_BOUND_PROVENANCE.GB.source, null);
  assert.equal(statutoryBoundProvenanceFor('gb').authority, 'Companies House / HMRC');
});

test('an injected statutory assertion runs, and its own named refusal is not re-wrapped', () => {
  const seen = [];
  const plan = planFiscalPeriodRegistration({
    label: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31', existingPeriods: [], jurisdiction: 'FI',
    statutoryAssert: (bounds) => { seen.push(bounds); }
  });
  assert.deepEqual(seen, [{ starts_on: '2026-01-01', ends_on: '2026-12-31' }]);
  assert.equal(plan.statutory.bound_enforced, true);
  assert.equal(plan.statutory.authority, 'Kirjanpitolaki (Finnish Accounting Act)');

  refuses(() => planFiscalPeriodRegistration({
    label: '2026', startsOn: '2026-01-01', endsOn: '2028-12-31', existingPeriods: [], jurisdiction: 'FI',
    statutoryAssert: () => { throw Object.assign(new Error('too long'), { code: 'TILIKAUSI_TOO_LONG' }); }
  }), 'TILIKAUSI_TOO_LONG', 'the statute that refused stays visible to the caller');
});

test('bounds and label are validated BEFORE any statutory assertion runs', () => {
  let called = false;
  const assertCalled = () => { called = true; };
  refuses(() => planFiscalPeriodRegistration({ ...gbYear, label: '', jurisdiction: 'FI', statutoryAssert: assertCalled }), 'FISCAL_PERIOD_LABEL_REQUIRED');
  refuses(() => planFiscalPeriodRegistration({ ...gbYear, label: '   ', jurisdiction: 'FI', statutoryAssert: assertCalled }), 'FISCAL_PERIOD_LABEL_REQUIRED');
  refuses(() => planFiscalPeriodRegistration({ label: '2026', startsOn: 'nope', endsOn: '2027-03-31', jurisdiction: 'FI', statutoryAssert: assertCalled }), 'FISCAL_PERIOD_BAD_BOUNDS');
  assert.equal(called, false, 'a malformed period never reaches the statutory check');
});

test('re-registering the identical period is a NOOP, so a retry emits no second receipt', () => {
  const plan = planFiscalPeriodRegistration({ ...gbYear, existingPeriods: [persisted()], jurisdiction: 'GB' });
  assert.equal(plan.decision, 'noop');
  assert.equal(plan.existing.id, 'fy-1');
  // Whitespace around the label is not a different fact.
  assert.equal(planFiscalPeriodRegistration({ ...gbYear, label: '  2026/27  ', existingPeriods: [persisted()], jurisdiction: 'GB' }).decision, 'noop');
});

test('a period that disagrees with a persisted one refuses by name rather than repairing it', async () => {
  // Same start, different end — the shape that would silently move a year end.
  await refuses(() => planFiscalPeriodRegistration({
    label: '2026/27', startsOn: '2026-04-01', endsOn: '2027-06-30', existingPeriods: [persisted()], jurisdiction: 'GB'
  }), 'FISCAL_PERIOD_CONFLICTS_EXISTING');
  // Same start, different label.
  await refuses(() => planFiscalPeriodRegistration({
    label: 'FY27', startsOn: '2026-04-01', endsOn: '2027-03-31', existingPeriods: [persisted()], jurisdiction: 'GB'
  }), 'FISCAL_PERIOD_CONFLICTS_EXISTING');
  // Label already taken by a different period — the table's second unique key.
  await refuses(() => planFiscalPeriodRegistration({
    label: '2026/27', startsOn: '2027-04-01', endsOn: '2028-03-31', existingPeriods: [persisted()], jurisdiction: 'GB'
  }), 'FISCAL_PERIOD_LABEL_CONFLICT');
  // Overlapping but distinct — the case NO database constraint catches.
  await refuses(() => planFiscalPeriodRegistration({
    label: 'FY27', startsOn: '2026-10-01', endsOn: '2027-09-30', existingPeriods: [persisted()], jurisdiction: 'GB'
  }), 'FISCAL_PERIOD_OVERLAPS_EXISTING');
});

test('a clean second year alongside a persisted first one plans an insert', () => {
  const plan = planFiscalPeriodRegistration({
    label: '2027/28', startsOn: '2027-04-01', endsOn: '2028-03-31', existingPeriods: [persisted()], jurisdiction: 'GB'
  });
  assert.equal(plan.decision, 'insert');
  assert.equal(plan.existing, null);
});
