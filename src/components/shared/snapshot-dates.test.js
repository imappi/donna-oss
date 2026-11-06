// TZ-safe snapshot date-column normalization (the January-in-December
// sighting from Kari's 2026-08-26 stage-C canary walkthrough): a pg `date`
// column parsed to LOCAL midnight and serialized as a UTC instant must
// resolve to the calendar day the column stores, for any serialization
// offset within ±12h.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dayRangeLabel,
  monthKeyLabel,
  snapshotDayString,
  snapshotMonthKey
} from './snapshot-dates.js';

test('a plain YYYY-MM-DD string passes through verbatim', () => {
  assert.equal(snapshotDayString('2025-01-01'), '2025-01-01');
  assert.equal(snapshotMonthKey('2025-01-01'), '2025-01');
});

test('a positive-offset serialized date column resolves to its true day (the cactus shape)', () => {
  // date '2025-01-01' serialized from a +01:00 host — the exact string in
  // the canary screenshot that grouped a January period under December.
  assert.equal(snapshotDayString('2024-12-31T23:00:00.000Z'), '2025-01-01');
  assert.equal(snapshotMonthKey('2024-12-31T23:00:00.000Z'), '2025-01');
  // date '2025-01-31' serialized the same way.
  assert.equal(snapshotDayString('2025-01-30T23:00:00.000Z'), '2025-01-31');
  // +03:00 (Helsinki summer) and +02:00 shapes resolve identically.
  assert.equal(snapshotDayString('2025-06-30T21:00:00.000Z'), '2025-07-01');
});

test('a negative-offset serialized date column resolves to its true day', () => {
  // date '2025-01-01' serialized from a -05:00 host.
  assert.equal(snapshotDayString('2025-01-01T05:00:00.000Z'), '2025-01-01');
});

test('a true UTC-midnight instant is a no-op', () => {
  assert.equal(snapshotDayString('2025-01-01T00:00:00.000Z'), '2025-01-01');
});

test('Date instances resolve through the same nearest-midnight rule', () => {
  assert.equal(snapshotDayString(new Date('2024-12-31T23:00:00.000Z')), '2025-01-01');
  assert.equal(snapshotDayString(new Date('2025-01-01T00:00:00.000Z')), '2025-01-01');
});

test('missing and unparseable values degrade to empty/null', () => {
  assert.equal(snapshotDayString(null), '');
  assert.equal(snapshotDayString(''), '');
  assert.equal(snapshotDayString('not a date'), '');
  assert.equal(snapshotMonthKey(undefined), null);
  assert.equal(snapshotMonthKey('garbage'), null);
});

test('monthKeyLabel renders the human month heading', () => {
  assert.equal(monthKeyLabel('2025-01'), 'January 2025');
  assert.equal(monthKeyLabel(''), '');
});

test('dayRangeLabel humanizes a period, year once when shared', () => {
  assert.equal(dayRangeLabel('2025-01-01', '2025-01-31'), 'Jan 1 – Jan 31, 2025');
  assert.equal(dayRangeLabel('2025-12-01', '2026-01-31'), 'Dec 1, 2025 – Jan 31, 2026');
  // Shifted serialized columns humanize to the TRUE period.
  assert.equal(
    dayRangeLabel('2024-12-31T23:00:00.000Z', '2025-01-30T23:00:00.000Z'),
    'Jan 1 – Jan 31, 2025'
  );
  // A malformed side falls back to the raw values rather than an empty header.
  assert.equal(dayRangeLabel('garbage', '2025-01-31'), 'garbage → 2025-01-31');
});
