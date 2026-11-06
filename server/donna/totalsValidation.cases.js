// Shared totals-validation case table (RT-04, plan
// docs/plan-2026-09-01-runtime-refactor-slices.md §5, finding F-05).
//
// ONE table, consumed by both `totalsValidation.test.js` (the formula) and
// `documentValidator.test.js` (the invoice/bill and receipt validators that
// delegate to it). The recurrence mechanism F-05 names was exactly that each
// validator had its own unit test asserting its own formula, so a discounted
// invoice could foot under one and fail under another with nothing noticing.
// Every case here must produce the same verdict through every entry point.
//
// `summary` is the extractor's post-mapping shape; the validators also read
// `header.total_amount` / `header.tax_amount`, which the consumers derive
// from the same numbers. Not a test file by name on purpose — the runner
// discovers `*.test.js` only.
//
// `header_only: true` marks cases with no lines and a printed subtotal. The
// formula evaluates them on the subtotal (basis 'subtotal'); the invoice/bill
// validator always judged header-only bills and keeps doing so; the receipt
// validator only ever judged receipts WITH lines and stays silent on these
// (entry conditions are each validator's own — the equation is shared).

export const TOTALS_TOLERANCE_CASES = Object.freeze([
  {
    name: 'Social DXB — discounted bill: subtotal 550 + tax 27.50 − discount 27.50 = 550',
    summary: {
      subtotal_amount: 550,
      tax_amount: 27.5,
      discount_amount: 27.5,
      total_amount: 550,
      line_amounts_include_tax: false
    },
    lines: [{ amount: 200 }, { amount: 200 }, { amount: 150 }],
    expect: { matches: true, strategy: 'declared_tax_exclusive', drift: 0 }
  },
  {
    name: 'exclusive: subtotal + tax',
    summary: { subtotal_amount: 100, tax_amount: 9, total_amount: 109, line_amounts_include_tax: false },
    lines: [{ amount: 60 }, { amount: 40 }],
    expect: { matches: true, strategy: 'declared_tax_exclusive', drift: 0 }
  },
  {
    name: 'exclusive: every modifier (shipping, discount, rounding)',
    summary: {
      subtotal_amount: 100,
      tax_amount: 9,
      shipping_amount: 5,
      discount_amount: 4,
      rounding_amount: 0.01,
      total_amount: 110.01,
      line_amounts_include_tax: false
    },
    lines: [{ amount: 100 }],
    expect: { matches: true, strategy: 'declared_tax_exclusive', drift: 0 }
  },
  {
    name: 'inclusive: sum(lines) already carries the tax',
    summary: { tax_amount: 1.13, total_amount: 13.63, line_amounts_include_tax: true },
    lines: [{ amount: 6.82 }, { amount: 6.81 }],
    expect: { matches: true, strategy: 'declared_tax_inclusive', drift: 0 }
  },
  {
    name: 'Cactus Blossom — model said exclusive, the printed line sum proves inclusive',
    summary: { tax_amount: 2, total_amount: 77.78, line_amounts_include_tax: false },
    lines: [{ amount: 45.18 }, { amount: 32.6 }],
    expect: { matches: true, strategy: 'inferred_tax_inclusive', drift: 0 }
  },
  {
    name: 'model said inclusive, the printed subtotal + tax proves exclusive',
    summary: { subtotal_amount: 100, tax_amount: 9, total_amount: 109, line_amounts_include_tax: true },
    lines: [{ amount: 60 }, { amount: 40 }],
    expect: { matches: true, strategy: 'inferred_tax_exclusive', drift: 0 }
  },
  {
    name: 'genuine mismatch under both tax interpretations',
    summary: { tax_amount: 2, total_amount: 82, line_amounts_include_tax: false },
    lines: [{ amount: 45.18 }, { amount: 32.6 }],
    expect: { matches: false, strategy: 'declared_tax_exclusive', drift: 2.22 }
  },
  {
    name: 'discounted bill that genuinely does not foot (total 600 against 550)',
    summary: {
      subtotal_amount: 550,
      tax_amount: 27.5,
      discount_amount: 27.5,
      total_amount: 600,
      line_amounts_include_tax: false
    },
    lines: [{ amount: 200 }, { amount: 200 }, { amount: 150 }],
    expect: { matches: false, strategy: 'declared_tax_exclusive', drift: 50 }
  },
  {
    name: 'drift exactly at the tolerance is still a match',
    summary: { subtotal_amount: 100, tax_amount: 9, total_amount: 110, line_amounts_include_tax: false },
    lines: [{ amount: 100 }],
    expect: { matches: true, strategy: 'declared_tax_exclusive', drift: 1 }
  },
  {
    name: 'header only (lines gated off): subtotal + tax = total',
    header_only: true,
    summary: { subtotal_amount: 100, tax_amount: 10, total_amount: 110, line_amounts_include_tax: false },
    lines: [],
    expect: { matches: true, strategy: 'declared_tax_exclusive', drift: 0, basis: 'subtotal' }
  },
  {
    name: 'header only (lines gated off): discounted bill still foots',
    header_only: true,
    summary: {
      subtotal_amount: 550,
      tax_amount: 27.5,
      discount_amount: 27.5,
      total_amount: 550,
      line_amounts_include_tax: false
    },
    lines: [],
    expect: { matches: true, strategy: 'declared_tax_exclusive', drift: 0, basis: 'subtotal' }
  },
  {
    name: 'header only (lines gated off): subtotal + tax ≠ total',
    header_only: true,
    summary: { subtotal_amount: 100, tax_amount: 10, total_amount: 130, line_amounts_include_tax: false },
    lines: [],
    expect: { matches: false, strategy: 'declared_tax_exclusive', drift: 20, basis: 'subtotal' }
  }
]);

// Inputs too sparse to hold an opinion on. Every entry point must stay
// silent here — no warning, no outcome, no review row.
export const TOTALS_NO_OPINION_CASES = Object.freeze([
  {
    name: 'no total printed',
    summary: { subtotal_amount: 100, line_amounts_include_tax: false },
    lines: [{ amount: 100 }],
    expect: { reason: 'no_total' }
  },
  {
    name: 'no lines and no subtotal — accept the header at face value',
    summary: { total_amount: 13.63 },
    lines: [],
    expect: { reason: 'no_lines' }
  }
]);

// The persisted receipt shape (parse_summary.totals_validation and the
// review-row payload). A key missing here is a receipt that cannot be read.
export const TOTALS_RECEIPT_KEYS = Object.freeze([
  'matches',
  'reason',
  'expected',
  'total',
  'drift',
  'tolerance',
  'strategy',
  'basis',
  'inferred_line_amounts_include_tax',
  'line_sum',
  'subtotal',
  'tax',
  'shipping',
  'discount',
  'rounding'
]);

// Derive the `header` the worker-side validators read from a case summary,
// the way every extractor mapper does (header.total_amount === summary.total_amount).
export const headerForCase = (summary) => ({
  total_amount: summary.total_amount ?? null,
  tax_amount: summary.tax_amount ?? null
});
