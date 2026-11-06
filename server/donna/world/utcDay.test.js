import assert from 'node:assert/strict';
import test from 'node:test';

import { utcIsoDay } from './utcDay.js';

const withTz = (tz, fn) => {
  const prior = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
};

test('utcIsoDay reads the UTC calendar day of an instant on any host zone', () => {
  const lateUtc = new Date('2026-03-01T22:00:00Z'); // already 2026-03-02 02:00 in Dubai
  const earlyUtc = new Date('2026-03-01T02:00:00Z'); // still 2026-02-28 21:00 in New York
  for (const tz of ['UTC', 'Asia/Dubai', 'America/New_York']) {
    withTz(tz, () => {
      assert.equal(utcIsoDay(lateUtc), '2026-03-01', `${tz}: late UTC evening`);
      assert.equal(utcIsoDay(earlyUtc), '2026-03-01', `${tz}: early UTC morning`);
    });
  }
});

test('utcIsoDay zero-pads the month and the day', () => {
  assert.equal(utcIsoDay(new Date('2026-01-05T00:00:00Z')), '2026-01-05');
  assert.equal(utcIsoDay(new Date(Date.UTC(2026, 11, 31))), '2026-12-31');
});

test('an impossible bare day does not round-trip — the validators\' guard', () => {
  const impossible = '2026-02-30';
  assert.notEqual(utcIsoDay(new Date(`${impossible}T00:00:00Z`)), impossible);
  assert.equal(utcIsoDay(new Date('2026-02-28T00:00:00Z')), '2026-02-28');
});
