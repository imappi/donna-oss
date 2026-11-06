import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finnishPublicHolidaysForYear,
  isFinnishBusinessDay,
  nextFinnishBusinessDayIso,
  computeOyStatutoryDeadlines
} from './oyStatutoryDeadlines.js';

test('the 6B deadline is 4 months from the END of the tilikausi-end MONTH (the §1 worked example)', () => {
  // Design example: a period ending 15.7.2026 is due 30.11.2026, NOT 15.11.
  const d = computeOyStatutoryDeadlines({ tilikausiEnd: '2026-07-15' });
  assert.equal(d.tax_return_6b.statutory_date, '2026-11-30');
  assert.equal(d.tax_return_6b.due_date, '2026-11-30');
  assert.equal(d.tax_return_6b.shifted, false);
});

test('a calendar-year Oy files 6B by end of April and registers at PRH within 8 months', () => {
  const d = computeOyStatutoryDeadlines({ tilikausiEnd: '2026-12-31' });
  assert.equal(d.tax_return_6b.statutory_date, '2027-04-30');
  assert.equal(d.prh_registration.statutory_date, '2027-08-31');
  // The FS attach to the 6B filing (same date, distinct-window pending).
  assert.equal(d.fs_attachment_vero.due_date, d.tax_return_6b.due_date);
  assert.match(d.fs_attachment_vero.note, /pending F-FI13-V/);
});

test('a deadline landing on a weekend/holiday shifts forward to the next business day', () => {
  // A 2027 calendar-year Oy: 6B base is 2028-04-30, a SUNDAY → 2028-05-01 is Vappu
  // (a holiday) → the next business day is 2028-05-02.
  const d = computeOyStatutoryDeadlines({ tilikausiEnd: '2027-12-31' });
  assert.equal(d.tax_return_6b.statutory_date, '2028-04-30');
  assert.equal(d.tax_return_6b.due_date, '2028-05-02');
  assert.equal(d.tax_return_6b.shifted, true);
});

test('the granted-extension extension point pushes the 6B base before the shift', () => {
  const base = computeOyStatutoryDeadlines({ tilikausiEnd: '2026-07-15' });
  const extended = computeOyStatutoryDeadlines({ tilikausiEnd: '2026-07-15', extensionDays: 14 });
  assert.equal(base.tax_return_6b.statutory_date, '2026-11-30');
  assert.equal(extended.tax_return_6b.statutory_date, '2026-12-14');
});

test('computeOyStatutoryDeadlines returns null on a bad date', () => {
  assert.equal(computeOyStatutoryDeadlines({ tilikausiEnd: '2026/07/15' }), null);
  assert.equal(computeOyStatutoryDeadlines({}), null);
});

test('the Finnish holiday calendar resolves the Easter-derived and Midsummer feasts', () => {
  const h2026 = finnishPublicHolidaysForYear(2026);
  // Easter 2026 = 5 Apr → Good Friday 3 Apr, Easter Monday 6 Apr, Ascension 14 May.
  assert.ok(h2026.has('2026-04-03'), 'Good Friday');
  assert.ok(h2026.has('2026-04-06'), 'Easter Monday');
  assert.ok(h2026.has('2026-05-14'), 'Ascension');
  assert.ok(h2026.has('2026-06-19'), 'Midsummer Eve (a Friday)');
  // Fixed national holidays.
  for (const fixed of ['2026-01-01', '2026-01-06', '2026-05-01', '2026-12-06', '2026-12-24', '2026-12-25', '2026-12-26']) {
    assert.ok(h2026.has(fixed), fixed);
  }
});

test('isFinnishBusinessDay excludes weekends and public holidays', () => {
  assert.equal(isFinnishBusinessDay('2026-07-15'), true); // a Wednesday
  assert.equal(isFinnishBusinessDay('2026-07-18'), false); // a Saturday
  assert.equal(isFinnishBusinessDay('2026-07-19'), false); // a Sunday
  assert.equal(isFinnishBusinessDay('2026-12-25'), false); // Christmas
  assert.equal(isFinnishBusinessDay('2026-05-14'), false); // Ascension
  assert.equal(isFinnishBusinessDay('bad'), false);
});

test('nextFinnishBusinessDayIso returns the same day when it is already a business day', () => {
  assert.equal(nextFinnishBusinessDayIso('2026-07-15'), '2026-07-15');
  // 2026-12-24 (Thu, Christmas Eve) + 25 (Fri) holidays, 26/27 weekend → the
  // next business day is Monday 2026-12-28.
  assert.equal(nextFinnishBusinessDayIso('2026-12-24'), '2026-12-28');
});
