// AP aging — pure builder over `buildDocumentInbox` rows.
//
// Sibling of PR 13's `arAging.js`. Structural shape is identical;
// the substitutions:
//   1. Filter `kind === 'supplier_bill'` (vs. AR's 'sales_invoice').
//   2. Section semantics: "what we owe" (vendor relationships at
//      stake) rather than "what we're owed" (customer relationships).
//      The bucket math + tones + currency handling are identical —
//      both are "days past due against an outstanding amount" — but
//      the firm reads the same numbers as different actions.
//
// Backlog item #4 from the PR 11 brief: "Mirror of #3 for bills.
// Half a day given #3's groundwork." Kept parallel rather than
// factored into a shared module because the AR + AP pair is still
// only TWO instances. The codebase convention (PRs 3 / 10 / 11
// keeping `receiptAutoExplain.js`, `salesInvoiceAutoExplain.js`,
// `billAutoExplain.js` parallel) is: factor at the third instance,
// not the second. If a third aging surface ever surfaces, refactor
// into `src/lib/aging/shared.js` then.
//
// Outstanding filter relies on issue #95: `void` and `credit_note`
// round-trip through the extractor, so they fall out of overdue
// buckets cleanly rather than masquerading as `'unpaid'`.

const OUTSTANDING_PAYMENT_STATUSES = new Set(['unpaid', 'partial']);

export const AP_AGING_BUCKETS = Object.freeze([
  'current',
  'overdue_0_30',
  'overdue_31_60',
  'overdue_61_90',
  'overdue_90_plus',
  'no_due_date'
]);

export const AP_AGING_BUCKET_LABELS = Object.freeze({
  current: 'Current',
  overdue_0_30: '1–30 days',
  overdue_31_60: '31–60 days',
  overdue_61_90: '61–90 days',
  overdue_90_plus: '90+ days',
  no_due_date: 'No due date'
});

// Tones mirror the ok/amber/alert/muted vocabulary used by
// `paymentStatusChip` in `documentsInbox.js`. Current is neutral;
// overdue brackets escalate amber → alert as days past due crosses
// 60. Identical to the AR ladder — the visual urgency is the same
// even though the operational meaning differs (firm should pay vs.
// firm should chase).
export const AP_AGING_BUCKET_TONES = Object.freeze({
  current: 'muted',
  overdue_0_30: 'amber',
  overdue_31_60: 'amber',
  overdue_61_90: 'alert',
  overdue_90_plus: 'alert',
  no_due_date: 'muted'
});

const dateOnly = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const daysPastDue = (dueDate, today) => {
  const due = dateOnly(dueDate);
  const ref = dateOnly(today) || dateOnly(new Date());
  if (!due || !ref) return null;
  return Math.round((ref.getTime() - due.getTime()) / MS_PER_DAY);
};

const bucketFor = (days) => {
  if (days === null) return 'no_due_date';
  if (days <= 0) return 'current';
  if (days <= 30) return 'overdue_0_30';
  if (days <= 60) return 'overdue_31_60';
  if (days <= 90) return 'overdue_61_90';
  return 'overdue_90_plus';
};

const safeNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const outstandingFor = (row) => {
  const total = safeNumber(row.totalAmount);
  if (total === null || total <= 0) return 0;
  const settled = safeNumber(row.settledAmount) || 0;
  const remaining = total - settled;
  return remaining > 0 ? remaining : 0;
};

const emptyBuckets = () => {
  const out = {};
  for (const bucket of AP_AGING_BUCKETS) {
    out[bucket] = { count: 0, outstandingAmount: 0, billIds: [] };
  }
  return out;
};

// Filter inbox rows down to outstanding AP (supplier bills with
// paymentStatus in {unpaid, partial}). The exclusion list — paid,
// void, credit_note, unknown — is the load-bearing filter from
// issue #95: void/credit_note are documentation of a reversal, not
// outstanding payable.
export const filterOutstandingApRows = (rows = []) =>
  rows.filter(
    (row) =>
      row &&
      row.kind === 'supplier_bill' &&
      OUTSTANDING_PAYMENT_STATUSES.has(row.paymentStatus)
  );

// Build the aging breakdown from inbox rows. Shape mirrors
// `buildArAging` (PR 13). Returns:
//   {
//     byCurrency: {
//       EUR: { buckets: {...}, totals: { count, outstandingAmount } },
//       ...
//     },
//     currencies: ['EUR', 'USD', ...],
//     totals: { count, outstandingAmountByCurrency: { EUR: 0, ... } },
//     today: <ISO date string used for the cutoff>
//   }
export const buildApAging = ({ inboxRows, today = new Date() } = {}) => {
  const rows = Array.isArray(inboxRows)
    ? inboxRows
    : (inboxRows && Array.isArray(inboxRows.rows) ? inboxRows.rows : []);
  const outstanding = filterOutstandingApRows(rows);

  const byCurrency = {};
  const grandOutstandingByCurrency = {};
  let grandCount = 0;

  for (const row of outstanding) {
    const currency = (row.currency ? String(row.currency).toUpperCase() : null) || 'UNKNOWN';
    const days = daysPastDue(row.dueDate, today);
    const bucket = bucketFor(days);
    const amount = outstandingFor(row);

    if (!byCurrency[currency]) {
      byCurrency[currency] = {
        buckets: emptyBuckets(),
        totals: { count: 0, outstandingAmount: 0 }
      };
    }
    const slot = byCurrency[currency].buckets[bucket];
    slot.count += 1;
    slot.outstandingAmount += amount;
    slot.billIds.push(row.id);

    byCurrency[currency].totals.count += 1;
    byCurrency[currency].totals.outstandingAmount += amount;

    grandCount += 1;
    grandOutstandingByCurrency[currency] = (grandOutstandingByCurrency[currency] || 0) + amount;
  }

  const currencies = Object.keys(byCurrency).sort();
  const todayIso = (dateOnly(today) || dateOnly(new Date())).toISOString().slice(0, 10);

  return {
    byCurrency,
    currencies,
    totals: {
      count: grandCount,
      outstandingAmountByCurrency: grandOutstandingByCurrency
    },
    today: todayIso
  };
};

// Convenience — does the aging have anything to render? Used by the
// panel to decide whether to surface the strip at all.
export const hasOutstandingAp = (aging) =>
  Boolean(aging && aging.totals && aging.totals.count > 0);

// PR 17 — flatten the per-bucket bill ids across every currency for
// click-through filtering. Mirrors `invoiceIdsInBucket` from
// `arAging.js`: a click on the "1–30 days" chip is not currency-
// scoped (single global bucket selection), so the panel needs the
// merged id list to filter the bills sub-table below.
export const billIdsInBucket = (aging, bucket) => {
  if (!aging || !bucket || !AP_AGING_BUCKETS.includes(bucket)) return [];
  const ids = [];
  for (const currency of (aging.currencies || [])) {
    const slice = aging.byCurrency?.[currency];
    const slot = slice?.buckets?.[bucket];
    if (slot && Array.isArray(slot.billIds)) {
      for (const id of slot.billIds) ids.push(id);
    }
  }
  return ids;
};
