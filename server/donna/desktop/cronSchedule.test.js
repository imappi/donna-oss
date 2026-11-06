// cronSchedule — the desktop scheduler's 5-field cron matcher. Load-bearing
// properties: exact UTC matching for every schedule shape the tree uses,
// bounded next/previous occurrence scans, and hard parse failures for
// anything outside the supported grammar (misfiring silently is the bug
// class this module must not have).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cronMatches, nextCronOccurrence, parseCronExpression, previousCronOccurrence
} from './cronSchedule.js';

const at = (iso) => new Date(iso);

test('matches the exact schedule shapes the tree uses today', () => {
  // Hourly at minute 0 (bank-line sweeps)
  assert.equal(cronMatches('0 * * * *', at('2026-08-02T13:00:00Z')), true);
  assert.equal(cronMatches('0 * * * *', at('2026-08-02T13:01:00Z')), false);
  // Daily at 04:00 UTC (convergence metrics)
  assert.equal(cronMatches('0 4 * * *', at('2026-08-02T04:00:00Z')), true);
  assert.equal(cronMatches('0 4 * * *', at('2026-08-02T05:00:00Z')), false);
  // Every minute (drain/outbox/stuck)
  assert.equal(cronMatches('* * * * *', at('2026-08-02T23:59:00Z')), true);
  // Every 5 minutes (coding_convergence)
  assert.equal(cronMatches('*/5 * * * *', at('2026-08-02T13:05:00Z')), true);
  assert.equal(cronMatches('*/5 * * * *', at('2026-08-02T13:07:00Z')), false);
  // Offset minutes (ledger auto-export 23 4, mirror verify 47 3)
  assert.equal(cronMatches('23 4 * * *', at('2026-08-02T04:23:00Z')), true);
  assert.equal(cronMatches('47 3 * * *', at('2026-08-02T03:47:00Z')), true);
});

test('ranges, lists, and stepped ranges parse and match', () => {
  assert.equal(cronMatches('0 9-17 * * *', at('2026-08-02T12:00:00Z')), true);
  assert.equal(cronMatches('0 9-17 * * *', at('2026-08-02T18:00:00Z')), false);
  assert.equal(cronMatches('0,30 * * * *', at('2026-08-02T10:30:00Z')), true);
  assert.equal(cronMatches('0,30 * * * *', at('2026-08-02T10:15:00Z')), false);
  assert.equal(cronMatches('0 0-12/6 * * *', at('2026-08-02T06:00:00Z')), true);
  assert.equal(cronMatches('0 0-12/6 * * *', at('2026-08-02T03:00:00Z')), false);
});

test('day-of-week matching, with 7 normalized to Sunday', () => {
  // 2026-08-02 is a Sunday.
  assert.equal(cronMatches('0 4 * * 0', at('2026-08-02T04:00:00Z')), true);
  assert.equal(cronMatches('0 4 * * 7', at('2026-08-02T04:00:00Z')), true);
  assert.equal(cronMatches('0 4 * * 1', at('2026-08-02T04:00:00Z')), false);
});

test('classic OR rule when both day fields are restricted', () => {
  // 2026-08-02 is Sunday the 2nd: dom=15 misses, dow=0 hits — OR matches.
  assert.equal(cronMatches('0 4 15 * 0', at('2026-08-02T04:00:00Z')), true);
  // Neither: no match.
  assert.equal(cronMatches('0 4 15 * 3', at('2026-08-02T04:00:00Z')), false);
  // dom restricted, dow wildcard: AND semantics as usual.
  assert.equal(cronMatches('0 4 15 * *', at('2026-08-02T04:00:00Z')), false);
  assert.equal(cronMatches('0 4 2 * *', at('2026-08-02T04:00:00Z')), true);
});

test('nextCronOccurrence is strictly after, and rolls over days', () => {
  assert.equal(
    nextCronOccurrence('0 4 * * *', at('2026-08-02T04:00:00Z')).toISOString(),
    '2026-08-03T04:00:00.000Z'
  );
  assert.equal(
    nextCronOccurrence('0 4 * * *', at('2026-08-02T03:59:30Z')).toISOString(),
    '2026-08-02T04:00:00.000Z'
  );
});

test('previousCronOccurrence is at-or-before — the bounded catch-up primitive', () => {
  assert.equal(
    previousCronOccurrence('0 4 * * *', at('2026-08-02T04:00:30Z')).toISOString(),
    '2026-08-02T04:00:00.000Z'
  );
  // Slept through three daily ticks: the latest one is the answer, not a list.
  assert.equal(
    previousCronOccurrence('0 4 * * *', at('2026-08-05T03:00:00Z')).toISOString(),
    '2026-08-04T04:00:00.000Z'
  );
  assert.equal(
    previousCronOccurrence('* * * * *', at('2026-08-02T13:07:42Z')).toISOString(),
    '2026-08-02T13:07:00.000Z'
  );
});

test('month boundaries roll correctly', () => {
  assert.equal(
    nextCronOccurrence('0 3 1 * *', at('2026-08-02T00:00:00Z')).toISOString(),
    '2026-09-01T03:00:00.000Z'
  );
  assert.equal(
    previousCronOccurrence('0 3 1 * *', at('2026-08-02T00:00:00Z')).toISOString(),
    '2026-08-01T03:00:00.000Z'
  );
});

test('unsupported or malformed expressions throw at parse time', () => {
  assert.throws(() => parseCronExpression('0 4 * *'));         // 4 fields
  assert.throws(() => parseCronExpression('0 4 * * * *'));     // 6 fields
  assert.throws(() => parseCronExpression('61 * * * *'));      // out of range
  assert.throws(() => parseCronExpression('0 25 * * *'));      // out of range
  assert.throws(() => parseCronExpression('x * * * *'));       // not a number
  assert.throws(() => parseCronExpression('*/0 * * * *'));     // zero step
  assert.throws(() => parseCronExpression('5-1 * * * *'));     // inverted range
  assert.throws(() => parseCronExpression(''));
});

test('every cron default and vercel schedule shape in the tree parses', () => {
  const shapes = [
    '0 * * * *', '0 4 * * *', '30 4 * * *', '0 3 * * *', '23 4 * * *',
    '47 3 * * *', '40 3 * * *', '20 * * * *', '10 2 * * *', '40 13 * * *',
    '40 * * * *', '50 * * * *', '* * * * *', '*/5 * * * *', '0 2 * * *',
    '15 4 * * *', '0 8 * * *', '30 7 * * *'
  ];
  for (const shape of shapes) assert.ok(parseCronExpression(shape));
});
