// G-9 (FI-15) — KPL 2:10 retention: the two closed classes, the TWO DIFFERENT
// clocks (10y from FY end date vs 6y from the end of the calendar year the FY
// ended in), the open-year no-hold rule, and the archive statement block.
//   node --test server/donna/finland/retention.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RETENTION_CLASSES,
  RETENTION_YEARS,
  RETENTION_PROVENANCE,
  retentionUntil,
  evaluateRetentionHold,
  describeArchiveRetention
} from './retention.js';

test('retention classes and years are the closed KPL 2:10 vocabulary', () => {
  assert.deepEqual([...RETENTION_CLASSES], ['tosite', 'kirjanpitokirja']);
  assert.equal(RETENTION_YEARS.tosite, 6);
  assert.equal(RETENTION_YEARS.kirjanpitokirja, 10);
  assert.equal(RETENTION_PROVENANCE.statute, 'Kirjanpitolaki 2:10');
  // Honest verification state: flips only after the primary finlex.fi read
  // (F-G9-V, network-open pass).
  assert.equal(RETENTION_PROVENANCE.confirmedAgainstPrimary, false);
});

test('kirjanpitokirja: 10 years from the fiscal-year END DATE', () => {
  assert.equal(retentionUntil({ retentionClass: 'kirjanpitokirja', fiscalYearEndsOn: '2026-12-31' }), '2036-12-31');
  // Off-calendar fiscal year keeps its month-day anchor.
  assert.equal(retentionUntil({ retentionClass: 'kirjanpitokirja', fiscalYearEndsOn: '2027-03-31' }), '2037-03-31');
});

test('tosite: 6 years from the end of the CALENDAR YEAR the fiscal year ended in', () => {
  assert.equal(retentionUntil({ retentionClass: 'tosite', fiscalYearEndsOn: '2026-12-31' }), '2032-12-31');
  // The design-doc example: FY ending 2027-03-31 → tositteet to 2033-12-31,
  // NOT 2033-03-31 — the clocks genuinely differ.
  assert.equal(retentionUntil({ retentionClass: 'tosite', fiscalYearEndsOn: '2027-03-31' }), '2033-12-31');
});

test('leap-day fiscal-year end clamps instead of rolling into March', () => {
  assert.equal(retentionUntil({ retentionClass: 'kirjanpitokirja', fiscalYearEndsOn: '2028-02-29' }), '2038-02-28');
});

test('unknown class and bad dates throw typed errors (persisted rows only — garbage is a bug)', () => {
  assert.throws(() => retentionUntil({ retentionClass: 'receipt', fiscalYearEndsOn: '2026-12-31' }), (e) => e.code === 'RETENTION_UNKNOWN_CLASS');
  assert.throws(() => retentionUntil({ retentionClass: 'tosite', fiscalYearEndsOn: 'joulukuu' }), (e) => e.code === 'RETENTION_BAD_DATE');
});

test('hold arms only when the fiscal year leaves open; closing counts as held', () => {
  const base = { retentionClass: 'tosite', fiscalYearEndsOn: '2026-12-31', at: '2027-06-01' };
  assert.equal(evaluateRetentionHold({ ...base, status: 'open' }).held, false);
  assert.equal(evaluateRetentionHold({ ...base, status: 'closing' }).held, true);
  assert.equal(evaluateRetentionHold({ ...base, status: 'closed' }).held, true);
});

test('hold releases the day after retain_until', () => {
  const base = { retentionClass: 'tosite', fiscalYearEndsOn: '2026-12-31', status: 'closed' };
  assert.equal(evaluateRetentionHold({ ...base, at: '2032-12-31' }).held, true);
  const released = evaluateRetentionHold({ ...base, at: '2033-01-01' });
  assert.equal(released.held, false);
  assert.equal(released.retain_until, '2032-12-31');
});

test('describeArchiveRetention renders the persisted fiscal-year row; both horizons + bilingual commitment', () => {
  const block = describeArchiveRetention({
    fiscalYear: { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'closed' },
    at: '2027-02-01'
  });
  assert.equal(block.statute, 'Kirjanpitolaki 2:10');
  assert.equal(block.classes.tosite.retain_until, '2032-12-31');
  assert.equal(block.classes.kirjanpitokirja.retain_until, '2036-12-31');
  assert.match(block.commitment_fi, /tositteet säilytetään 2032-12-31 saakka/u);
  assert.match(block.commitment_fi, /kirjanpitokirjat sekä tilinpäätös 2036-12-31 saakka/u);
  assert.match(block.commitment_en, /retained until 2032-12-31/u);
  assert.equal(block.provenance.confirmedAgainstPrimary, false);
});

test('describeArchiveRetention returns null without a persisted row — never fabricates', () => {
  assert.equal(describeArchiveRetention({ fiscalYear: null }), null);
  assert.equal(describeArchiveRetention({ fiscalYear: { ends_on: 'not-a-date' } }), null);
});
