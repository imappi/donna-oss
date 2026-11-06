// Unit pins for the C2b close-action derivation (two-surface IA stage C —
// docs/design-donna-two-surface-ia.md §7): card presence/status come from
// persisted close_periods rows, a locked row never cards (lock resolves the
// card), the synthetic "unchecked" entry keeps the run-checks moment
// reachable, and the badge delta counts only lockable periods.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closeActionForYouCount,
  deriveCloseActionPeriods
} from './close-action-inventory.js';

const row = (overrides = {}) => ({
  id: 'cp-1',
  client_id: 'client-1',
  period_start: '2026-06-01',
  period_end: '2026-06-30',
  status: 'reviewing',
  payload: {
    close_status: 'ready',
    lockable: true,
    generated_at: '2026-07-01T10:00:00.000Z',
    review_counts: { unposted: 0, waiting: 0, asked_client: 0, held: 0, posted: 12 }
  },
  updated_at: '2026-07-01T10:00:05.000Z',
  ...overrides
});

test('a non-locked close_periods row cards with its persisted verdict', () => {
  const periods = deriveCloseActionPeriods({ closePeriods: [row()], transactions: [] });
  assert.equal(periods.length, 1);
  const p = periods[0];
  assert.equal(p.monthKey, '2026-06');
  assert.equal(p.label, 'June 2026');
  assert.equal(p.status, 'ready');
  assert.equal(p.lockable, true);
  assert.equal(p.checkedAt, '2026-07-01T10:00:00.000Z');
  assert.equal(p.counts.posted, 12);
  assert.equal(p.source, 'close_periods');
});

test('a LOCKED row never cards — lock is the card resolution', () => {
  const periods = deriveCloseActionPeriods({
    closePeriods: [row({ status: 'locked' })],
    transactions: []
  });
  assert.deepEqual(periods, []);
});

test('a row without a persisted verdict payload defaults to review, never ready', () => {
  const periods = deriveCloseActionPeriods({
    closePeriods: [row({ payload: null })],
    transactions: []
  });
  assert.equal(periods.length, 1);
  assert.equal(periods[0].status, 'review');
  assert.equal(periods[0].lockable, false);
  assert.equal(periods[0].checkedAt, '2026-07-01T10:00:05.000Z');
  assert.equal(periods[0].counts, null);
});

test('an unknown persisted close_status maps to review', () => {
  const periods = deriveCloseActionPeriods({
    closePeriods: [row({ payload: { close_status: 'locked', lockable: false } })],
    transactions: []
  });
  assert.equal(periods[0].status, 'review');
});

test('the latest activity month cards as unchecked when no row covers it', () => {
  const periods = deriveCloseActionPeriods({
    closePeriods: [],
    transactions: [
      { date: '2026-02-03', created_at: '2026-02-04T00:00:00Z' },
      { date: '2026-02-27' },
      { date: '2026-01-15' }
    ]
  });
  assert.equal(periods.length, 1);
  const p = periods[0];
  assert.equal(p.status, 'unchecked');
  assert.equal(p.lockable, false);
  assert.equal(p.source, 'activity');
  // Leap-year February: the derived period must span the real month.
  assert.equal(p.periodStart, '2026-02-01');
  assert.equal(p.periodEnd, '2026-02-28');
  assert.equal(p.transactionCount, 2);
});

test('no synthetic entry when the latest month is covered — locked or not', () => {
  const transactions = [{ date: '2026-06-15' }];
  const covered = deriveCloseActionPeriods({ closePeriods: [row()], transactions });
  assert.equal(covered.length, 1);
  assert.equal(covered[0].source, 'close_periods');
  const lockedCover = deriveCloseActionPeriods({
    closePeriods: [row({ status: 'locked' })],
    transactions
  });
  assert.deepEqual(lockedCover, []);
});

test('no synthetic entry without transactions; entries sort newest first', () => {
  assert.deepEqual(deriveCloseActionPeriods({ closePeriods: [], transactions: [] }), []);
  const periods = deriveCloseActionPeriods({
    closePeriods: [
      row({ id: 'a', period_start: '2026-05-01', period_end: '2026-05-31' }),
      row({ id: 'b', period_start: '2026-06-01', period_end: '2026-06-30' })
    ],
    transactions: [{ date: '2026-07-09' }]
  });
  assert.deepEqual(periods.map((p) => p.monthKey), ['2026-07', '2026-06', '2026-05']);
  assert.equal(periods[0].status, 'unchecked');
});

test('a TZ-shifted serialized period row keys, labels, and round-trips as its TRUE month', () => {
  // The cactus canary shape (2026-08-26): a January close_periods row whose
  // pg `date` columns serialized on a +01:00 host — the raw strings read
  // December, and the month-key regex filed the row under December while
  // the January synthetic entry still showed the month as uncovered.
  const periods = deriveCloseActionPeriods({
    closePeriods: [row({
      period_start: '2024-12-31T23:00:00.000Z',
      period_end: '2025-01-30T23:00:00.000Z'
    })],
    transactions: [{ date: '2025-01-15' }]
  });
  assert.equal(periods.length, 1);
  const p = periods[0];
  assert.equal(p.monthKey, '2025-01');
  assert.equal(p.label, 'January 2025');
  // Normalized calendar days — the row key stays stable and the values the
  // artifact hands back to the close writers can never mint a shifted row.
  assert.equal(p.periodStart, '2025-01-01');
  assert.equal(p.periodEnd, '2025-01-31');
  // And January counts as covered: no synthetic duplicate for the month.
  assert.equal(periods.filter((entry) => entry.monthKey === '2025-01').length, 1);
});

test('shifted transaction dates resolve the latest activity month TZ-safely', () => {
  const periods = deriveCloseActionPeriods({
    closePeriods: [],
    transactions: [
      { date: '2024-12-31T23:00:00.000Z' }, // a January 1 date column, shifted
      { date: '2024-12-10' }
    ]
  });
  assert.equal(periods.length, 1);
  assert.equal(periods[0].monthKey, '2025-01');
  assert.equal(periods[0].transactionCount, 1);
});

test('non-array inputs degrade to empty', () => {
  assert.deepEqual(deriveCloseActionPeriods({ closePeriods: null, transactions: null }), []);
  assert.deepEqual(deriveCloseActionPeriods(), []);
});

test('the badge delta counts only lockable periods', () => {
  const periods = [
    { lockable: true },
    { lockable: false },
    { status: 'unchecked' },
    { lockable: true }
  ];
  assert.equal(closeActionForYouCount(periods), 2);
  assert.equal(closeActionForYouCount([]), 0);
  assert.equal(closeActionForYouCount(null), 0);
});
