import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalReviewDeadline } from './physicalReviewCalendar.js';
const calendar = { timeZone: 'Europe/London', workingDays: [1,2,3,4,5], holidays: ['2026-10-26'] };
test('physical service deadlines use named timezone, weekend and explicit holidays across DST', () => {
  assert.equal(physicalReviewDeadline({ asOf: '2026-10-23T12:00:00Z', businessDays: 1, calendar }), '2026-10-27T23:59:59.000Z');
  assert.equal(physicalReviewDeadline({ asOf: '2026-10-23T12:00:00Z', businessDays: 2, calendar }), '2026-10-28T23:59:59.000Z');
  assert.equal(physicalReviewDeadline({ asOf: '2026-10-07T12:00:00Z', businessDays: 1, calendar }), '2026-10-08T22:59:59.000Z');
});
test('absent or invalid physical service calendars refuse instead of inventing coverage', () => {
  for (const c of [null, {}, { ...calendar, timeZone: 'invalid' }, { ...calendar, workingDays: [] }]) assert.throws(() => physicalReviewDeadline({ asOf: '2026-10-07T12:00:00Z', businessDays: 2, calendar: c }));
});
