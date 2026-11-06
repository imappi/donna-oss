// AR aging — plain-Node test harness. Mirrors documentsInbox.test.js
// style: no DOM, no jsdom.

import {
  AR_AGING_BUCKETS,
  AR_AGING_BUCKET_LABELS,
  AR_AGING_BUCKET_TONES,
  buildArAging,
  filterOutstandingArRows,
  hasOutstandingAr,
  invoiceIdsInBucket
} from './arAging.js';

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

// Today reference used across the fixture set. 2026-05-20 matches the
// session date so the bucket math reads naturally.
const TODAY = new Date('2026-05-20T12:00:00Z');

// Row factory — defaults shape an outstanding EUR sales invoice 30
// days past due. Each test overrides the fields it cares about.
const arRow = (overrides = {}) => ({
  id: 'inv-1',
  kind: 'sales_invoice',
  paymentStatus: 'unpaid',
  totalAmount: 1000,
  settledAmount: 0,
  dueDate: '2026-04-20', // 30 days before TODAY
  currency: 'EUR',
  ...overrides
});

// ── 1: shape contract ────────────────────────────────────────────────
test('AR_AGING_BUCKETS lists the six standard accounting buckets in order', () => {
  assertDeepEqual(
    [...AR_AGING_BUCKETS],
    ['current', 'overdue_0_30', 'overdue_31_60', 'overdue_61_90', 'overdue_90_plus', 'no_due_date'],
    'bucket order'
  );
});

test('AR_AGING_BUCKET_LABELS + TONES cover every bucket', () => {
  for (const bucket of AR_AGING_BUCKETS) {
    assertTrue(AR_AGING_BUCKET_LABELS[bucket], `label for ${bucket}`);
    assertTrue(AR_AGING_BUCKET_TONES[bucket], `tone for ${bucket}`);
  }
});

// ── 2: filterOutstandingArRows ──────────────────────────────────────
test('filterOutstandingArRows: includes unpaid + partial sales invoices', () => {
  const rows = [
    arRow({ id: 'unpaid', paymentStatus: 'unpaid' }),
    arRow({ id: 'partial', paymentStatus: 'partial' })
  ];
  const filtered = filterOutstandingArRows(rows);
  assertEqual(filtered.length, 2, 'two rows');
});

test('filterOutstandingArRows: excludes paid / void / credit_note / unknown', () => {
  const rows = [
    arRow({ id: 'paid', paymentStatus: 'paid' }),
    arRow({ id: 'void', paymentStatus: 'void' }),
    arRow({ id: 'credit_note', paymentStatus: 'credit_note' }),
    arRow({ id: 'unknown', paymentStatus: 'unknown' })
  ];
  const filtered = filterOutstandingArRows(rows);
  assertEqual(filtered.length, 0, 'none included');
});

test('filterOutstandingArRows: excludes non-sales_invoice kinds', () => {
  const rows = [
    arRow({ id: 'inv', kind: 'sales_invoice' }),
    arRow({ id: 'bill', kind: 'supplier_bill' }),
    arRow({ id: 'rcpt', kind: 'receipt' })
  ];
  const filtered = filterOutstandingArRows(rows);
  assertEqual(filtered.length, 1, 'only sales invoice');
  assertEqual(filtered[0].id, 'inv', 'invoice id preserved');
});

// ── 3: bucket boundaries ────────────────────────────────────────────
test('bucket: due_date in the future → current', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-06-01' })], // 12 days in the future
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.current.count, 1, 'current bucket');
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 0, 'no overdue');
});

test('bucket: due_date == today → current (firm has end-of-day grace)', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-05-20' })], // exactly today
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.current.count, 1, 'due-today is current');
});

test('bucket: 1 day past due → overdue_0_30', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-05-19' })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 1, '1 day past due');
});

test('bucket: 30 days past due → overdue_0_30 (inclusive)', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-04-20' })], // exactly 30 days
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 1, '30 days at boundary');
});

test('bucket: 31 days past due → overdue_31_60', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-04-19' })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_31_60.count, 1, '31 days');
});

test('bucket: 61 days past due → overdue_61_90', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-03-20' })], // 61 days
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_61_90.count, 1, '61 days');
});

test('bucket: 91+ days past due → overdue_90_plus', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-02-18' })], // 91 days
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_90_plus.count, 1, '91 days');
});

test('bucket: null due_date → no_due_date', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: null })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.EUR.buckets.no_due_date.count, 1, 'null due_date');
});

// ── 4: outstanding amount arithmetic ───────────────────────────────
test('outstandingAmount: unpaid invoice → full total', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ totalAmount: 1000, settledAmount: 0 })],
    today: TODAY
  });
  assertEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.outstandingAmount,
    1000,
    'full total outstanding'
  );
});

test('outstandingAmount: partial settlement → total - settled', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ paymentStatus: 'partial', totalAmount: 1000, settledAmount: 300 })],
    today: TODAY
  });
  assertEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.outstandingAmount,
    700,
    'partial → 700 outstanding'
  );
});

test('outstandingAmount: settledAmount >= total → clamped at 0', () => {
  // Defensive — if a partial-flagged row has settled >= total (race
  // between sum-based F2 helper and FE snapshot), don't go negative.
  const aging = buildArAging({
    inboxRows: [arRow({ paymentStatus: 'partial', totalAmount: 1000, settledAmount: 1100 })],
    today: TODAY
  });
  assertEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.outstandingAmount,
    0,
    'clamped at zero'
  );
});

test('outstandingAmount: invalid totalAmount → 0 (still counted)', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ totalAmount: null })],
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
  const aging = buildArAging({
    inboxRows: [
      arRow({ id: 'eur-1', currency: 'EUR', totalAmount: 1000 }),
      arRow({ id: 'usd-1', currency: 'USD', totalAmount: 2000 }),
      arRow({ id: 'eur-2', currency: 'EUR', totalAmount: 500 })
    ],
    today: TODAY
  });
  assertDeepEqual([...aging.currencies], ['EUR', 'USD'], 'sorted currencies');
  assertEqual(aging.byCurrency.EUR.totals.count, 2, 'EUR: 2 invoices');
  assertEqual(aging.byCurrency.EUR.totals.outstandingAmount, 1500, 'EUR: 1500 total');
  assertEqual(aging.byCurrency.USD.totals.count, 1, 'USD: 1 invoice');
  assertEqual(aging.byCurrency.USD.totals.outstandingAmount, 2000, 'USD: 2000 total');
});

test('currency: case-insensitive uppercase normalisation', () => {
  const aging = buildArAging({
    inboxRows: [
      arRow({ id: 'a', currency: 'eur' }),
      arRow({ id: 'b', currency: 'EUR' })
    ],
    today: TODAY
  });
  assertEqual(aging.currencies.length, 1, 'single currency bucket');
  assertEqual(aging.byCurrency.EUR.totals.count, 2, 'merged on EUR');
});

test('currency: null/missing → UNKNOWN bucket', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ currency: null })],
    today: TODAY
  });
  assertEqual(aging.byCurrency.UNKNOWN.totals.count, 1, 'UNKNOWN currency carrier');
});

// ── 6: totals + hasOutstandingAr ───────────────────────────────────
test('totals: grandCount aggregates across currencies', () => {
  const aging = buildArAging({
    inboxRows: [
      arRow({ id: 'a', currency: 'EUR', totalAmount: 100 }),
      arRow({ id: 'b', currency: 'USD', totalAmount: 200 })
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

test('hasOutstandingAr: true when at least one outstanding invoice exists', () => {
  const aging = buildArAging({ inboxRows: [arRow()], today: TODAY });
  assertEqual(hasOutstandingAr(aging), true, 'has outstanding');
});

test('hasOutstandingAr: false on empty input', () => {
  const aging = buildArAging({ inboxRows: [], today: TODAY });
  assertEqual(hasOutstandingAr(aging), false, 'no outstanding');
});

test('hasOutstandingAr: false when all invoices are paid/void/credit_note', () => {
  const aging = buildArAging({
    inboxRows: [
      arRow({ id: 'a', paymentStatus: 'paid' }),
      arRow({ id: 'b', paymentStatus: 'void' }),
      arRow({ id: 'c', paymentStatus: 'credit_note' })
    ],
    today: TODAY
  });
  assertEqual(hasOutstandingAr(aging), false, 'no outstanding rows after filter');
});

// ── 7: input flexibility ───────────────────────────────────────────
test('accepts the {rows, byKind} inbox object directly', () => {
  // Callers may pass buildDocumentInbox()'s output as-is (aging-panel.jsx
  // does). The builder unwraps `.rows` automatically.
  const aging = buildArAging({
    inboxRows: { rows: [arRow()], byKind: { sales_invoice: [arRow()] } },
    today: TODAY
  });
  assertEqual(aging.totals.count, 1, 'one outstanding from .rows');
});

test('today defaults to runtime now when omitted', () => {
  // Smoke — just confirm no throw and a sane shape. We can't pin a
  // specific bucket without injecting `today`.
  const aging = buildArAging({ inboxRows: [arRow({ dueDate: null })] });
  assertEqual(aging.totals.count, 1, 'row counted under default today');
});

// ── 8: invoice id tracking (for future click-through) ──────────────
test('each bucket carries the matched invoice ids', () => {
  const aging = buildArAging({
    inboxRows: [
      arRow({ id: 'i1', dueDate: '2026-05-19' }), // 1 day past
      arRow({ id: 'i2', dueDate: '2026-05-15' })  // 5 days past
    ],
    today: TODAY
  });
  assertDeepEqual(
    aging.byCurrency.EUR.buckets.overdue_0_30.invoiceIds,
    ['i1', 'i2'],
    'both invoice ids tracked'
  );
});

// ── 9: empty / null inputs ─────────────────────────────────────────
test('empty input returns shape with zero totals', () => {
  const aging = buildArAging({ inboxRows: [], today: TODAY });
  assertEqual(aging.totals.count, 0, 'zero count');
  assertDeepEqual(aging.currencies, [], 'no currencies');
  assertDeepEqual(aging.totals.outstandingAmountByCurrency, {}, 'empty totals map');
});

test('null inputs return safe empty shape (no throw)', () => {
  const aging = buildArAging({ inboxRows: null, today: TODAY });
  assertEqual(aging.totals.count, 0, 'null rows handled');
});

test('today as ISO string is accepted', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-04-20' })],
    today: '2026-05-20'
  });
  assertEqual(aging.byCurrency.EUR.buckets.overdue_0_30.count, 1, 'parsed today string');
  assertEqual(aging.today, '2026-05-20', 'today echoed as ISO date');
});

// ── 10: invoiceIdsInBucket (PR 17 click-through helper) ────────────
test('invoiceIdsInBucket: single currency → returns that bucket\'s ids', () => {
  const aging = buildArAging({
    inboxRows: [
      arRow({ id: 'i1', dueDate: '2026-05-19' }),
      arRow({ id: 'i2', dueDate: '2026-05-15' }),
      arRow({ id: 'i3', dueDate: '2026-03-20' }) // 61 days → different bucket
    ],
    today: TODAY
  });
  assertDeepEqual(
    invoiceIdsInBucket(aging, 'overdue_0_30'),
    ['i1', 'i2'],
    'two rows in 1-30 bucket'
  );
  assertDeepEqual(
    invoiceIdsInBucket(aging, 'overdue_61_90'),
    ['i3'],
    'one row in 61-90 bucket'
  );
});

test('invoiceIdsInBucket: cross-currency merge', () => {
  // The chip click is global — collect from every currency the
  // aging knows about.
  const aging = buildArAging({
    inboxRows: [
      arRow({ id: 'eur-1', currency: 'EUR', dueDate: '2026-05-19' }),
      arRow({ id: 'usd-1', currency: 'USD', dueDate: '2026-05-15' })
    ],
    today: TODAY
  });
  assertDeepEqual(
    invoiceIdsInBucket(aging, 'overdue_0_30').sort(),
    ['eur-1', 'usd-1'],
    'ids from both currencies merged'
  );
});

test('invoiceIdsInBucket: empty for unmatched bucket', () => {
  const aging = buildArAging({
    inboxRows: [arRow({ dueDate: '2026-05-19' })],
    today: TODAY
  });
  assertDeepEqual(invoiceIdsInBucket(aging, 'overdue_90_plus'), [], 'empty bucket');
});

test('invoiceIdsInBucket: defensive — invalid bucket → []', () => {
  const aging = buildArAging({ inboxRows: [arRow()], today: TODAY });
  assertDeepEqual(invoiceIdsInBucket(aging, 'nonsense'), [], 'invalid bucket name');
  assertDeepEqual(invoiceIdsInBucket(aging, null), [], 'null bucket');
  assertDeepEqual(invoiceIdsInBucket(null, 'current'), [], 'null aging');
});

console.log(`\narAging: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
