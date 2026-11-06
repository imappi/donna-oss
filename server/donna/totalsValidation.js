// Totals validation — THE totals formula (PR 2 of
// docs/invoice-receipt-parsing-plan.md → §"Totals validation"; made the
// single formula by RT-04, docs/plan-2026-09-01-runtime-refactor-slices.md,
// finding F-05 of docs/audit-2026-09-01-accounting-runtime-forensics.md).
//
// Real invoices break the naive `sum(lines) + tax ≈ total` formula
// constantly — shipping, discounts, rounding, tax-inclusive vs
// tax-exclusive lines all shift the expected number. This helper is the
// ONE place that equation lives: the extractor mappers (supplierBill.js,
// salesInvoice.js), the worker's receipt/unified branches
// (inngest/parseDocument.js) and the worker-side validators
// (documentValidator.js validateInvoiceBill / validateReceipt) all
// delegate here. F-05 was three formulas disagreeing: a discount-blind
// `subtotal + tax` copy laundered its verdict into the same
// 'amount_mismatch' token this one feeds, so Social DXB's
// 550 + 27.50 − 27.50 = 550 opened a firm-side review row with no numbers.
// Do not add a second equation anywhere; extend this one.
//
// The return value is a RECEIPT, not a boolean: every number the verdict
// rests on rides along, so `parse_summary.totals_validation` and the
// review-row payload can say which roll-up was tried and by how much it
// missed. Persisted money fields are rounded (4 dp — float noise such as
// 0.1 + 0.2 never reaches a receipt; three-decimal currencies stay whole).
//
// Failure mode is intentionally *soft*: an `amount_mismatch` warning
// never trips `parse_status=failed`. The firm uploaded a usable doc;
// at worst we force every line into review.

const TOLERANCE = 1; // major currency units, per plan. Tighten only with real-data evidence.

const numeric = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const round4 = (value) =>
  value === null || value === undefined ? null : Math.round(value * 10000) / 10000;

// `summary` here is the shape the extractor returns (post-mapping):
//   { subtotal_amount, tax_amount, total_amount, shipping_amount,
//     discount_amount, rounding_amount, line_amounts_include_tax }
// `lines` is the raw extractor line array — each has an `amount`.
//
// Returns the receipt:
//   matches   true  → expected and total are within TOLERANCE (or no opinion)
//             false → caller adds 'amount_mismatch' to summary.warnings
//   reason    null when the equation was evaluated; 'no_total' / 'no_lines'
//             when the inputs were too sparse to hold an opinion (then
//             matches=true — we don't manufacture a mismatch out of missing
//             fields; the plan calls this out: "force review" only when the
//             math actually disagrees)
//   expected / total / drift / tolerance — the verdict's arithmetic (drift is
//             signed: total − expected)
//   strategy  which roll-up came closest to the printed total:
//             declared_tax_inclusive | declared_tax_exclusive (the model's
//             line_amounts_include_tax flag) or inferred_tax_inclusive |
//             inferred_tax_exclusive (the flag's opposite footed better —
//             the numbers outrank one model-read boolean)
//   basis     'lines' when the summed line amounts were the base of the
//             roll-up; 'subtotal' when there were no lines (lines gated off,
//             or a header-only extraction) and the printed subtotal stood in
//   inferred_line_amounts_include_tax — the tax-inclusion reading the
//             winning strategy implies (for basis 'subtotal': whether the
//             printed subtotal already carries the tax)
//   line_sum / subtotal / tax / shipping / discount / rounding — the inputs
export const validateReceiptTotals = ({ summary = {}, lines = [] } = {}) => {
  const total = numeric(summary.total_amount, null);
  const lineList = Array.isArray(lines) ? lines : [];
  const lineSum = lineList.length
    ? lineList.reduce((acc, line) => acc + numeric(line?.amount, 0), 0)
    : null;
  const shipping = numeric(summary.shipping_amount, 0);
  const discount = numeric(summary.discount_amount, 0);
  const rounding = numeric(summary.rounding_amount, 0);
  const subtotal = numeric(summary.subtotal_amount, null);
  const tax = numeric(summary.tax_amount, 0);
  const includeTax = Boolean(summary.line_amounts_include_tax);

  const receipt = (fields) => ({
    matches: true,
    reason: null,
    expected: null,
    total: round4(total),
    drift: null,
    tolerance: TOLERANCE,
    strategy: null,
    basis: null,
    inferred_line_amounts_include_tax: includeTax,
    line_sum: round4(lineSum),
    subtotal: round4(subtotal),
    tax: round4(tax),
    shipping: round4(shipping),
    discount: round4(discount),
    rounding: round4(rounding),
    ...fields
  });

  // Can't compare against a missing total. Treat as "no opinion" —
  // the extractor's other guardrails (confidence floor, partial
  // status) cover the truly-unreadable case.
  if (total === null) return receipt({ reason: 'no_total' });

  // The base of the roll-up: the summed lines when there are lines,
  // else the printed subtotal (lines gated off at the worker boundary, or a
  // header-only extraction). With neither there is nothing to sum — accept
  // the header at face value.
  const basis = lineSum !== null ? 'lines' : subtotal !== null ? 'subtotal' : null;
  if (basis === null) return receipt({ reason: 'no_lines', expected: round4(total), drift: 0 });
  const base = basis === 'lines' ? lineSum : subtotal;

  // `line_amounts_include_tax` is itself a model-read field. Do not let one
  // wrong boolean create a document exception when the arithmetic proves the
  // alternative interpretation. Build every legitimate roll-up supported by
  // the printed header/lines, then use the one closest to the printed total.
  // This keeps the correctness gate strict (one candidate must foot) without
  // making the model's tax-inclusion label stronger evidence than the numbers.
  const inclusiveExpected = base + shipping - discount + rounding;
  const exclusiveExpected = (subtotal !== null ? subtotal : base) +
    tax + shipping - discount + rounding;
  const candidates = includeTax
    ? [
        { expected: inclusiveExpected, strategy: 'declared_tax_inclusive' },
        { expected: exclusiveExpected, strategy: 'inferred_tax_exclusive' }
      ]
    : [
        { expected: exclusiveExpected, strategy: 'declared_tax_exclusive' },
        { expected: inclusiveExpected, strategy: 'inferred_tax_inclusive' }
      ];
  // A printed subtotal can exclude fees listed as separate source lines.
  // Keep that header candidate, and also test the complete pre-tax line sum.
  if (lineSum !== null && subtotal !== null && lineSum !== subtotal) candidates.push({
    expected: lineSum + tax + shipping - discount + rounding, strategy:'inferred_tax_exclusive'
  });
  const best = candidates.reduce((winner, candidate) =>
    Math.abs(total - candidate.expected) < Math.abs(total - winner.expected)
      ? candidate
      : winner
  );
  const expected = round4(best.expected);
  const drift = round4(total - expected);
  return receipt({
    matches: Math.abs(drift) <= TOLERANCE,
    expected,
    drift,
    strategy: best.strategy,
    basis,
    inferred_line_amounts_include_tax:
      best.strategy === 'inferred_tax_inclusive'
        ? true
        : best.strategy === 'inferred_tax_exclusive'
          ? false
          : includeTax
  });
};

export const __TOTALS_TOLERANCE = TOLERANCE;
