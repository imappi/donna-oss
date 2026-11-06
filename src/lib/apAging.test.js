// AP aging — plain-Node test harness. Mirrors arAging.test.js
// shape; the substitutions are the bill kind on fixtures + bill
// id field on bucket payloads.

import {
  AP_AGING_BUCKETS,
  AP_AGING_BUCKET_LABELS,
  AP_AGING_BUCKET_TONES,
  billIdsInBucket,
  buildApAging,
  filterOutstandingApRows,
  hasOutstandingAp
} from './apAging.js';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  fail ${name}`);
    console.error(`       ${err?.message || err}`);
  }
};

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const assertDeepEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const assertTrue = (value, label) => {
  if (!value) throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
};

const TODAY = new Date('2026-05-20T12:00:00Z');

// Row factory — defaults shape an outstanding EUR supplier bill 30
// days past due. Each test overrides what it cares about.
const apRow = (overrides = {}) => ({
  id: 'bill-1',
  kind: 'supplier_bill',
  paymentStatus: 'unpaid',
  totalAmount: 1000,
  settledAmount: 0,
  dueDate: '2026-04-20', // 30 days before TODAY
  currency: 'EUR',
  ...overrides
});

// ── 1: shape contract ────────────────────────────────────────────────
test('AP_AGING_BUCKETS lists the six standard accounting buckets in order', () => {
  assertDeepEqual(
    [...AP_AGING_BUCKETS],
    ['current', 'overdue_0_30', 'overdue_31_60', 'overdue_61_90', 'overdue_90_plus', 'no_due_date'],
    'bucket order'
  );
});

test('AP_AGING_BUCKET_LABELS + TONES cover every bucket', () => {
  for (const bucket of AP_AGING_BUCKETS) {
    assertTrue(AP_AGING_BUCKET_LABELS[bucket], `label for ${bucket}`);
    assertTrue(AP_AGING_BUCKET_TONES[bucket], `tone for ${bucket}`);
  }
});

// ── 2: filterOutstandingApRows ──────────────────────────────────────
test('filterOutstandingApRows: includes unpaid + partial supplier bills', () => {
  const rows = [
    apRow({ id: 'unpaid', paymentStatus: 'unpaid' }),
    apRow({ id: 'partial', paymentStatus: 'partial' })
  ];
  const filtered = filterOutstandingApRows(rows);
  assertEqual(filtered.length, 2, 'two rows');
});

test('filterOutstandingApRows: excludes paid / void / credit_note / unknown', () => {
  const rows = [
    apRow({ id: 'paid', paymentStatus: 'paid' }),
    apRow({ id: 'void', paymentStatus: 'void' }),
    apRow({ id: 'credit_note', paymentStatus: 'credit_note' }),
    apRow({ id: 'unknown', paymentStatus: 'unknown' })
  ];
  const filtered = filterOutstandingApRows(rows);
  assertEqual(filtered.length, 0, 'none included');
});

test('filterOutstandingApRows: excludes non-supplier_bill kinds', () => {
  const rows = [
    apRow({ id: 'bill', kind: 'supplier_bill' }),
    apRow({ id: 'inv', kind: 'sales_invoice' }),
    apRow({ id: 'rcpt', kind: 'receipt' })
  ];
  const filtered = filterOutstandingApRows(rows);
  assertEqual(filtered.length, 1, 'only supplier bill');
  assertEqual(filtered[0].id, 'bill', 'bill id preserved');
});

// AR-side defensive check: a sales_invoice row (outstanding from
// AR's perspective) MUST NOT enter the AP aging. This is the
// cross-pass discipline that protects firms from double-counting
// AR + AP across the panel.
test('cross-pass discipline: outstanding sales_invoice rows are invisible to AP aging', () => {
  const aging = buildApAging({
    inboxRows: [
      apRow({ id: 'ar-1', kind: 'sales_invoice', paymentStatus: 'unpaid', totalAmount: 999 })
    ],
    today: TODAY
  });
  assertEqual(aging.totals.count, 0, 'AR row not counted as AP');
});

// ── 3: bucket boundaries ────────────────────────────────────────────
test('bucket: due_date in the future → current', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-06-01' })], // 12 days in the future
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.current.count, 1, 'current bucket');
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 0, 'no overdue');
});

test('bucket: due_date == today → current (firm has end-of-day grace)', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-05-20' })], // exactly today
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.current.count, 1, 'due-today is current');
});

test('bucket: 1 day past due → overdue_0_30', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-05-19' })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 1, '1 day past due');
});

test('bucket: 30 days past due → overdue_0_30 (inclusive)', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-04-20' })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 1, '30 days at boundary');
});

test('bucket: 31 days past due → overdue_31_60', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-04-19' })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_31_60.count, 1, '31 days');
});

test('bucket: 61 days past due → overdue_61_90', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-03-20' })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_61_90.count, 1, '61 days');
});

test('bucket: 91+ days past due → overdue_90_plus', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-02-18' })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_90_plus.count, 1, '91 days');
});

test('bucket: null due_date → no_due_date', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: null })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.no_due_date.count, 1, 'null due_date');
});

// ── 4: outstanding amount arithmetic ───────────────────────────────
test('outstandingAmount: unpaid bill → full total', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ totalAmount: 1000, settledAmount: 0 })],
    today: TODAY
  });
  assertEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.outstandingAmount,
    1000,
    'full total outstanding'
  );
});

test('outstandingAmount: partial settlement → total - settled', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ paymentStatus: 'partial', totalAmount: 1000, settledAmount: 300 })],
    today: TODAY
  });
  assertEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.outstandingAmount,
    700,
    'partial → 700 outstanding'
  );
});

test('outstandingAmount: settledAmount >= total → clamped at 0', () => {
  // Defensive — if a partial-flagged bill's settled sum has caught
  // up to total (race between PR 11 F2 helper and FE snapshot),
  // don't go negative.
  const aging = buildApAging({
    inboxRows: [apRow({ paymentStatus: 'partial', totalAmount: 1000, settledAmount: 1100 })],
    today: TODAY
  });
  assertEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.outstandingAmount,
    0,
    'clamped at zero'
  );
});

test('outstandingAmount: invalid totalAmount → 0 (still counted)', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ totalAmount: null })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 1, 'row still counted');
  assertEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.outstandingAmount,
    0,
    'no usable amount → 0'
  );
});

// ── 5: multi-currency grouping ─────────────────────────────────────
test('multi-currency: separate aging strip per currency', () => {
  const aging = buildApAging({
    inboxRows: [
      apRow({ id: 'eur-1', currency: 'EUR', totalAmount: 1000 }),
      apRow({ id: 'usd-1', currency: 'USD', totalAmount: 2000 }),
      apRow({ id: 'eur-2', currency: 'EUR', totalAmount: 500 })
    ],
    today: TODAY
  });
  assertDeepEqual([...aging.currencies], ['EUR', 'USD'], 'sorted currencies');
  assertEqual(aging.byCurrency.EUR.totals.count, 2, 'EUR: 2 bills');
  assertEqual(aging.byCurrency.EUR.totals.outstandingAmount, 1500, 'EUR: 1500 total');
  assertEqual(aging.byCurrency.USD.totals.count, 1, 'USD: 1 bill');
  assertEqual(aging.byCurrency.USD.totals.outstandingAmount, 2000, 'USD: 2000 total');
});

test('currency: case-insensitive uppercase normalisation', () => {
  const aging = buildApAging({
    inboxRows: [
      apRow({ id: 'a', currency: 'eur' }),
      apRow({ id: 'b', currency: 'EUR' })
    ],
    today: TODAY
  });
  assertEqual(aging.currencies.length, 1, 'single currency bucket');
  assertEqual(aging.byCurrency.EUR.totals.count, 2, 'merged on EUR');
});

test('currency: null/missing → UNKNOWN bucket', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ currency: null })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.UNKNOWN.totals.count, 1, 'UNKNOWN currency carrier');
});

// ── 6: totals + hasOutstandingAp ───────────────────────────────────
test('totals: grandCount aggregates across currencies', () => {
  const aging = buildApAging({
    inboxRows: [
      apRow({ id: 'a', currency: 'EUR', totalAmount: 100 }),
      apRow({ id: 'b', currency: 'USD', totalAmount: 200 })
    ],
    today: TODAY
  });
  assertEqual(aging.totals.count, 2, 'grand count');
  assertDeepEqual(
    aging.totals.outstandingAmountByCurrency,
    { EUR: 100, USD: 200 },
    'per-currency totals'
  );
});

test('hasOutstandingAp: true when at least one outstanding bill exists', () => {
  const aging = buildApAging({ inboxRows: [apRow()], today: TODAY });
  assertEqual(hasOutstandingAp(aging), true, 'has outstanding');
});

test('hasOutstandingAp: false on empty input', () => {
  const aging = buildApAging({ inboxRows: [], today: TODAY });
  assertEqual(hasOutstandingAp(aging), false, 'no outstanding');
});

test('hasOutstandingAp: false when all bills are paid/void/credit_note', () => {
  const aging = buildApAging({
    inboxRows: [
      apRow({ id: 'a', paymentStatus: 'paid' }),
      apRow({ id: 'b', paymentStatus: 'void' }),
      apRow({ id: 'c', paymentStatus: 'credit_note' })
    ],
    today: TODAY
  });
  assertEqual(hasOutstandingAp(aging), false, 'no outstanding rows after filter');
});

// ── 7: input flexibility ───────────────────────────────────────────
test('accepts the {rows, byKind} inbox object directly', () => {
  const aging = buildApAging({
    inboxRows: { rows: [apRow()], byKind: { supplier_bill: [apRow()] } },
    today: TODAY
  });
  assertEqual(aging.totals.count, 1, 'one outstanding from .rows');
});

test('today defaults to runtime now when omitted', () => {
  const aging = buildApAging({ inboxRows: [apRow({ dueDate: null })] });
  assertEqual(aging.totals.count, 1, 'row counted under default today');
});

// ── 8: bill id tracking (for future click-through) ─────────────────
test('each bucket carries the matched bill ids', () => {
  const aging = buildApAging({
    inboxRows: [
      apRow({ id: 'b1', dueDate: '2026-05-19' }),
      apRow({ id: 'b2', dueDate: '2026-05-15' })
    ],
    today: TODAY
  });
  assertDeepEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.billIds,
    ['b1', 'b2'],
    'both bill ids tracked'
  );
});

// ── 9: empty / null inputs ─────────────────────────────────────────
test('empty input returns shape with zero totals', () => {
  const aging = buildApAging({ inboxRows: [], today: TODAY });
  assertEqual(aging.totals.count, 0, 'zero count');
  assertDeepEqual(aging.currencies, [], 'no currencies');
  assertDeepEqual(aging.totals.outstandingAmountByCurrency, {}, 'empty totals map');
});

test('null inputs return safe empty shape (no throw)', () => {
  const aging = buildApAging({ inboxRows: null, today: TODAY });
  assertEqual(aging.totals.count, 0, 'null rows handled');
});

test('today as ISO string is accepted', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-04-20' })],
    today: '2026-05-20'
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 1, 'parsed today string');
  assertEqual(aging.today, '2026-05-20', 'today echoed as ISO date');
});

// ── 10: billIdsInBucket (PR 17 click-through helper) ───────────────
test('billIdsInBucket: single currency → returns that bucket\'s ids', () => {
  const aging = buildApAging({
    inboxRows: [
      apRow({ id: 'b1', dueDate: '2026-05-19' }),
      apRow({ id: 'b2', dueDate: '2026-05-15' }),
      apRow({ id: 'b3', dueDate: '2026-03-20' }) // 61 days → different bucket
    ],
    today: TODAY
  });
  assertDeepEqual(
    billIdsInBucket(aging, 'overdue_0_30'),
    ['b1', 'b2'],
    'two bills in 1-30 bucket'
  );
  assertDeepEqual(
    billIdsInBucket(aging, 'overdue_61_90'),
    ['b3'],
    'one bill in 61-90 bucket'
  );
});

test('billIdsInBucket: cross-currency merge', () => {
  const aging = buildApAging({
    inboxRows: [
      apRow({ id: 'eur-1', currency: 'EUR', dueDate: '2026-05-19' }),
      apRow({ id: 'usd-1', currency: 'USD', dueDate: '2026-05-15' })
    ],
    today: TODAY
  });
  assertDeepEqual(
    billIdsInBucket(aging, 'overdue_0_30').sort(),
    ['eur-1', 'usd-1'],
    'ids from both currencies merged'
  );
});

test('billIdsInBucket: empty for unmatched bucket', () => {
  const aging = buildApAging({
    inboxRows: [apRow({ dueDate: '2026-05-19' })],
    today: TODAY
  });
  assertDeepEqual(billIdsInBucket(aging, 'overdue_90_plus'), [], 'empty bucket');
});

test('billIdsInBucket: defensive — invalid bucket → []', () => {
  const aging = buildApAging({ inboxRows: [apRow()], today: TODAY });
  assertDeepEqual(billIdsInBucket(aging, 'nonsense'), [], 'invalid bucket name');
  assertDeepEqual(billIdsInBucket(aging, null), [], 'null bucket');
  assertDeepEqual(billIdsInBucket(null, 'current'), [], 'null aging');
});

console.log(`\napAging: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
