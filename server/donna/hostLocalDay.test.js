// RT-15b (audit F-11): the root-file "today" stamps are the HOST-local day.
// Three callers that stamped `new Date(now).toISOString().slice(0, 10)` — the
// UTC day — read under Dubai (UTC+4) one hour after local midnight on New
// Year's Day: the owner's wall clock says Jan 1, the UTC day still says
// Dec 31. Each fails on the old tree with the Dec 31 stamp and passes once
// the site goes through toLocalIsoDay. (The firmDb.js drains have their own
// fixture, firmDbHostLocalDay.test.js.)
//
//   TZ=Asia/Dubai node --test server/donna/hostLocalDay.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { __clampFollowUpAt } from './transactionChat.js';
import { buildOwnerMileageJournal } from './ownerMileageExpense.js';
import { buildFirmFeedChatContext } from './feedChat.js';

// 2025-12-31T21:00Z is 2026-01-01 01:00 in Dubai.
const DUBAI_NEW_YEAR_01_00 = new Date(Date.UTC(2025, 11, 31, 21, 0, 0));

const withTz = (tz, fn) => {
  const priorTz = process.env.TZ;
  try {
    process.env.TZ = tz;
    return fn();
  } finally {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  }
};

test('follow-up clamp: a past date clamps forward to the LOCAL today, not the UTC day', () => {
  withTz('Asia/Dubai', () => {
    assert.equal(__clampFollowUpAt('2024-02-15', { now: DUBAI_NEW_YEAR_01_00 }), '2026-01-01');
    // The local today itself passes through unclamped.
    assert.equal(__clampFollowUpAt('2026-01-01', { now: DUBAI_NEW_YEAR_01_00 }), '2026-01-01');
  });
  withTz('America/New_York', () => {
    // 21:00Z on Dec 31 is still Dec 31 in New York: the clamp lands there.
    assert.equal(__clampFollowUpAt('2024-02-15', { now: DUBAI_NEW_YEAR_01_00 }), '2025-12-31');
  });
});

test('owner mileage journal: the default entry date is the LOCAL today (the rate year follows it)', () => {
  withTz('Asia/Dubai', () => {
    const out = buildOwnerMileageJournal({
      action: { miles: 12, purpose: 'client visit', confidence: 'high' },
      clientProfile: { jurisdiction: 'GB' },
      accounts: [],
      now: DUBAI_NEW_YEAR_01_00
    });
    // No accounts → stays proposed, but the computation has already picked
    // the rate YEAR from the stamped day: 2026 on the local day, 2025 on the
    // UTC day.
    assert.equal(out.status, 'proposed');
    assert.equal(out.computation?.year, 2026);
  });
});

test('firm feed chat context: `today` is the LOCAL day', () => {
  withTz('Asia/Dubai', () => {
    assert.equal(buildFirmFeedChatContext({ ventures: [], now: DUBAI_NEW_YEAR_01_00 }).today, '2026-01-01');
  });
  withTz('America/New_York', () => {
    assert.equal(buildFirmFeedChatContext({ ventures: [], now: DUBAI_NEW_YEAR_01_00 }).today, '2025-12-31');
  });
});
