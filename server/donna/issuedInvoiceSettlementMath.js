// Issued-invoice settlement ARITHMETIC — jurisdiction-neutral.
//
// RELOCATED 2026-07-27 from `finland/issuedInvoiceSettlement.js` under Kari's
// dated gap-8 re-scope (`docs/donna-country-pack-contract-gaps.md`): move
// EXISTING PURE FUNCTIONS out of `finland/` into a neutral home, leave
// RE-EXPORT SHIMS behind, no behaviour change, no new logic. Every symbol below
// is byte-identical to what it was in `finland/`; the FI module now re-exports
// all of it, so `finland/` keeps serving its existing consumers unchanged and
// the FI suite is the acceptance bar.
//
// WHY it moved, stated once so a later session does not re-derive it: the
// generic outbound engine (`outbound/paidTruthGuard.js`) imported this
// arithmetic from `finland/`, which put a country module UPSTREAM of the engine
// — gap 8's second edge. Nothing here is Finnish. Sum-of-settlements vs total
// with a 1¢ epsilon, an overdue flag from two dates, and conservative reference
// substring matching are generic invoice arithmetic; the UK needs the identical
// semantics with no viite in sight. The genuinely Finnish half —
// `FINLAND_AR_SETTLEMENT_FLAG_KEY`, `planArSettlement`, the Finnish banner copy
// — deliberately STAYED in `finland/issuedInvoiceSettlement.js`. This is the
// same posture #1129 took with `ledger.js`: the statutory data stays in its
// market, the engine stops reaching across.
//
// The `viitenumero` language in the comments below is kept verbatim rather than
// genericised, because it documents WHY the structured-reference rule decides
// both ways, and that reasoning is Finnish payment semantics even though the
// arithmetic implementing it is not. Read it as the worked example that
// produced the rule, not as a jurisdiction restriction.
//
// Original header, preserved:
//
// FI-15 G-8 (Half B) — partial-payment awareness for Donna-issued invoices.
// Design: docs/design-donna-finland-fi15-g8-credit-notes.md (D-G8-6/7).
//
// PURE, deterministic KEEP-layer arithmetic — no LLM call anywhere on this
// surface, and no stored derived state: payment states compute at READ time
// from persisted rows (issued invoices + issued credit notes + money-in bank
// lines) and are never written back. The sum-based semantics mirror the
// tree's canonical computeSumBasedPaymentStatus (sum of settlements vs total,
// 1¢ epsilon); the reference matching mirrors the AR matcher's conservative
// normalization (strip non-alphanumerics, lowercase, substring, minimum 4
// chars — the matcher itself is isolation-listed and stays untouched; these
// semantics are reimplemented here on purpose). An unmatched payment simply
// leaves the invoice honestly `unpaid` — a false `paid` is the failure mode
// this conservatism refuses.

// EXPORTED as of the 2026-07-27 relocation (previously module-private): the FI
// half left behind in `finland/issuedInvoiceSettlement.js` uses both in
// `planArSettlement`, and the 1¢ epsilon is the settlement contract itself
// rather than an implementation detail — two consumers rounding differently
// is exactly the drift this module exists to prevent. Bodies unchanged.
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const EPSILON = 0.01;

// Closed verdict enum (D-G8-7). `credited` = fully credited, nothing due.
export const ISSUED_INVOICE_PAYMENT_STATES = Object.freeze([
  'unpaid',
  'partially_paid',
  'paid',
  'overpaid',
  'credited'
]);

// Closed flag vocabulary. `overdue` = past due date while money is still owed.
export const ISSUED_INVOICE_FLAGS = Object.freeze(['overdue']);

// ---------------------------------------------------------------------------------
// Reference matching (the AR matcher's conservative semantics).
// ---------------------------------------------------------------------------------
const REFERENCE_MIN_LEN = 4;

export const normalizeReferenceText = (value) =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const transactionText = (transaction = {}) =>
  `${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.contact || ''} ${transaction.source_line || ''}`;

// G12: lines examined by the reference-capture sweep (migration 098) may
// carry a CAPTURED, scheme-validated reference. When BOTH sides carry one —
// the line a captured reference, the invoice a viite past the capture noise
// floor — the structured comparison DECIDES, both ways: equality settles the
// line to this invoice whatever the free text says, and inequality refuses
// it entirely. That is Finnish payment semantics, not a heuristic: the viite
// on a credit transfer IS the allocation instruction, so a viite-addressed
// line belongs to its viite's invoice — crediting it to another invoice
// whose digits happen to appear in the text is the substring matcher's
// embedded-run false hit AND a double-count (the same money credited to two
// invoices). Donna-minted viitteet embed their invoice number (base + check
// digit), so lane-by-lane disqualification would be toothless — the decision
// must be whole-line.
//
// The floor guard keeps the rule honest: a viite below the capture floor
// could have been skipped by the sweep, so a differing capture proves
// nothing about it — and an invoice with NO viite (the parsed/foreign lane)
// keeps the conservative substring matcher unchanged, capture or not.
export const STRUCTURED_REFERENCE_MIN_DIGITS = 6; // = referenceCapture.CAPTURE_MIN_DIGITS (pinned by test)
const digitsOnly = (value) => String(value ?? '').replace(/\D+/g, '');

// Does a money-in bank line's text carry this invoice's viitenumero (or, as a
// fallback, its display invoice number)? Both references are >= 7 digits by
// construction (formatInvoiceNumber), well past the min-4 noise floor.
export const paymentMatchesInvoice = ({ referenceNumber = null, invoiceNumber = null } = {}, transaction = {}) => {
  const captured = digitsOnly(transaction.structured_reference);
  const invoiceRef = digitsOnly(referenceNumber);
  if (captured && invoiceRef
    && captured.length >= STRUCTURED_REFERENCE_MIN_DIGITS
    && invoiceRef.length >= STRUCTURED_REFERENCE_MIN_DIGITS) {
    return captured === invoiceRef;
  }
  const tx = normalizeReferenceText(transactionText(transaction));
  if (!tx) return false;
  for (const candidate of [referenceNumber, invoiceNumber]) {
    const ref = normalizeReferenceText(candidate);
    if (ref && ref.length >= REFERENCE_MIN_LEN && tx.includes(ref)) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------------
// evaluateIssuedInvoiceSettlement — the closed verdict.
// ---------------------------------------------------------------------------------
// total: the invoice's positive total. creditedTotal: sum of ISSUED credit
// notes referencing it. payments: matched money-in amounts. onDate: the read
// date (for the overdue flag). Returns { payment_state, flags, paid_total,
// credited_total, open_amount }.
export const evaluateIssuedInvoiceSettlement = ({
  total = 0,
  dueDate = null,
  creditedTotal = 0,
  payments = [],
  onDate = null
} = {}) => {
  const invoiceTotal = round2(total);
  const credited = round2(Math.max(0, Number(creditedTotal) || 0));
  const paid = round2(
    (Array.isArray(payments) ? payments : [])
      .reduce((sum, p) => sum + Math.max(0, Number(p?.amount ?? p) || 0), 0)
  );
  const effectiveDue = round2(invoiceTotal - credited);

  let paymentState;
  if (effectiveDue <= EPSILON) {
    paymentState = paid > EPSILON ? 'overpaid' : 'credited';
  } else if (paid <= EPSILON) {
    paymentState = 'unpaid';
  } else if (paid > effectiveDue + EPSILON) {
    paymentState = 'overpaid';
  } else if (paid + EPSILON >= effectiveDue) {
    paymentState = 'paid';
  } else {
    paymentState = 'partially_paid';
  }

  const flags = [];
  const readDay = String(onDate || '').slice(0, 10);
  const dueDay = String(dueDate || '').slice(0, 10);
  if ((paymentState === 'unpaid' || paymentState === 'partially_paid')
    && /^\d{4}-\d{2}-\d{2}$/.test(dueDay) && /^\d{4}-\d{2}-\d{2}$/.test(readDay)
    && readDay > dueDay) {
    flags.push('overdue');
  }

  return {
    payment_state: paymentState,
    flags,
    paid_total: paid,
    credited_total: credited,
    open_amount: Math.max(0, round2(effectiveDue - paid))
  };
};

// ---------------------------------------------------------------------------------
// Report summary + banner copy (quiet-on-healthy).
// ---------------------------------------------------------------------------------
export const summarizeIssuedInvoices = (invoices = []) => {
  const counts = { total: 0, unpaid: 0, partially_paid: 0, paid: 0, overpaid: 0, credited: 0, overdue: 0 };
  let openAmount = 0;
  for (const inv of Array.isArray(invoices) ? invoices : []) {
    const s = inv?.settlement || inv || {};
    if (!ISSUED_INVOICE_PAYMENT_STATES.includes(s.payment_state)) continue;
    counts.total += 1;
    counts[s.payment_state] += 1;
    if ((s.flags || []).includes('overdue')) counts.overdue += 1;
    openAmount = round2(openAmount + (Number(s.open_amount) || 0));
  }
  return { ...counts, open_amount: openAmount };
};
