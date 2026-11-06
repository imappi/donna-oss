// The rollup's metric day is the previous UTC day BY CONTRACT
// (outbound/metrics.js bounds a day at T00:00:00Z..T24:00:00Z), so unlike
// the outbound "today" stamps this site keeps the UTC day on purpose. RT-15a
// pins that: the sweep must not flip it to the host-local day.

import assert from 'node:assert/strict';
import test from 'node:test';

import { previousUtcDay } from './outboundMetricsRollup.js';

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

test('previousUtcDay is the UTC day before the instant, whatever the host zone', () => {
  // 2026-03-01 22:00 UTC is already 2026-03-02 02:00 in Dubai; the day
  // before in UTC is still 2026-02-28.
  const now = Date.parse('2026-03-01T22:00:00Z');
  for (const tz of ['UTC', 'Asia/Dubai', 'America/New_York']) {
    withTz(tz, () => assert.equal(previousUtcDay(now), '2026-02-28', tz));
  }
  // 2026-03-01 02:00 UTC is 2026-02-28 21:00 in New York; the UTC day
  // before is 2026-02-28, not New York's 2026-02-27.
  withTz('America/New_York', () => assert.equal(previousUtcDay(Date.parse('2026-03-01T02:00:00Z')), '2026-02-28'));
});
