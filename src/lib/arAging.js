// AR aging — pure builder over `buildDocumentInbox` rows.
//
// Backlog item #3 from the original PR 11 brief, unblocked by issue
// #95 (void / credit_note now round-trip through the extractor, so
// `paymentStatus IN ('unpaid', 'partial')` cleanly excludes reversed
// and cancelled invoices without false positives).
//
// Pure FE — reads PR 8's `settledAmount` + `paymentTermsDays`
// directly off the inbox row. Outstanding amount per invoice is
// `totalAmount - settledAmount` (clamped at zero). Buckets are the
// standard AR aging layout firms recognise from accounting tools:
//
//   current        — not yet due (days_past_due < 0) OR due today
//   overdue_0_30   — 1–30 days past due
//   overdue_31_60  — 31–60 days past due
//   overdue_61_90  — 61–90 days past due
//   overdue_90_plus — 91+ days past due
//   no_due_date    — extractor didn't capture a due date; needs review
//
// Boundary convention: `due_date === today` is current (firm has
// until end of day to receive payment). `due_date` is one day before
// today → 1 day past due → `overdue_0_30`.
//
// Multi-currency books get one bucket strip per currency. The
// builder returns `byCurrency` keyed on the upper-cased currency
// code; the renderer iterates and shows separate strips. Aggregating
// across currencies would invent FX conversions we don't have a
// trusted policy for (mirrors the AR matcher's strict same-currency
// invariant, PR 8).

const OUTSTANDING_PAYMENT_STATUSES = new Set(['unpaid', 'partial']);

export const AR_AGING_BUCKETS = Object.freeze([
  'current',
  'overdue_0_30',
  'overdue_31_60',
  'overdue_61_90',
  'overdue_90_plus',
  'no_due_date'
]);

export const AR_AGING_BUCKET_LABELS = Object.freeze({
  current: 'Current',
  overdue_0_30: '1–30 days',
  overdue_31_60: '31–60 days',
  overdue_61_90: '61–90 days',
  overdue_90_plus: '90+ days',
  no_due_date: 'No due date'
});

// Tones mirror the ok/amber/alert/muted vocabulary used by
// `paymentStatusChip` in `documentsInbox.js`. Current is neutral
// (informational); overdue
// brackets escalate amber → alert as days past due crosses 60.
export const AR_AGING_BUCKET_TONES = Object.freeze({
  current: 'muted',
  overdue_0_30: 'amber',
  overdue_31_60: 'amber',
  overdue_61_90: 'alert',
  overdue_90_plus: 'alert',
  no_due_date: 'muted'
});

const dateOnly = (value) => {
  if (!value) return null;
  // Accept Date instances, ISO strings, and YYYY-MM-DD literals.
  // Strip the time component so days-past-due arithmetic is
  // timezone-stable for date-only inputs.
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
  for (const bucket of AR_AGING_BUCKETS) {
    out[bucket] = { count: 0, outstandingAmount: 0, invoiceIds: [] };
  }
  return out;
};

// Filter inbox rows down to outstanding AR (sales invoices with
// paymentStatus in {unpaid, partial}). The exclusion list — paid,
// void, credit_note, unknown — is the load-bearing filter from
// issue #95: void/credit_note are documentation of a reversal, not
// outstanding receivable.
export const filterOutstandingArRows = (rows = []) =>
  rows.filter(
    (row) =>
      row &&
      row.kind === 'sales_invoice' &&
      OUTSTANDING_PAYMENT_STATUSES.has(row.paymentStatus)
  );

// Build the aging breakdown from inbox rows. Returns:
//   {
//     byCurrency: {
//       EUR: { buckets: {...}, totals: { count, outstandingAmount } },
//       ...
//     },
//     currencies: ['EUR', 'USD', ...],
//     totals: { count, outstandingAmountByCurrency: { EUR: 0, ... } },
//     today: <ISO date string used for the cutoff>
//   }
export const buildArAging = ({ inboxRows, today = new Date() } = {}) => {
  const rows = Array.isArray(inboxRows)
    ? inboxRows
    : (inboxRows && Array.isArray(inboxRows.rows) ? inboxRows.rows : []);
  const outstanding = filterOutstandingArRows(rows);

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
    slot.invoiceIds.push(row.id);

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
export const hasOutstandingAr = (aging) =>
  Boolean(aging && aging.totals && aging.totals.count > 0);

// PR 17 — flatten the per-bucket invoice ids across every currency
// for click-through filtering. A click on the "1–30 days" chip is
// not currency-scoped (single global bucket selection — simpler UX
// for the common case), so the panel needs the merged id list to
// filter the sub-table below.
export const invoiceIdsInBucket = (aging, bucket) => {
  if (!aging || !bucket || !AR_AGING_BUCKETS.includes(bucket)) return [];
  const ids = [];
  for (const currency of (aging.currencies || [])) {
    const slice = aging.byCurrency?.[currency];
    const slot = slice?.buckets?.[bucket];
    if (slot && Array.isArray(slot.invoiceIds)) {
      for (const id of slot.invoiceIds) ids.push(id);
    }
  }
  return ids;
};
