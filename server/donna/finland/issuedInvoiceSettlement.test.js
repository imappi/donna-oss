// FI-15 G-8 Half B — partial-payment awareness, pure arithmetic:
//   node --test server/donna/finland/issuedInvoiceSettlement.test.js
// Design: docs/design-donna-finland-fi15-g8-credit-notes.md (D-G8-6/7).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AR_SETTLEMENT_PLAN_REASONS,
  FINLAND_AR_SETTLEMENT_FLAG_KEY,
  ISSUED_INVOICE_PAYMENT_STATES,
  STRUCTURED_REFERENCE_MIN_DIGITS,
  buildIssuedInvoiceBannerFi,
  evaluateIssuedInvoiceSettlement,
  normalizeReferenceText,
  paymentMatchesInvoice,
  planArSettlement,
  summarizeIssuedInvoices
} from './issuedInvoiceSettlement.js';

// ----- reference matching (the AR matcher's conservative semantics) ---------------

test('normalizeReferenceText strips non-alphanumerics and lowercases', () => {
  assert.equal(normalizeReferenceText('INV-2026 001'), 'inv2026001');
  assert.equal(normalizeReferenceText(null), '');
});

test('paymentMatchesInvoice matches the viitenumero in any text field, min length 4', () => {
  const invoice = { referenceNumber: '20260013', invoiceNumber: '2026001' };
  assert.equal(paymentMatchesInvoice(invoice, { description: 'SEPA VIITE 2026 0013 Asiakas Oy' }), true);
  assert.equal(paymentMatchesInvoice(invoice, { raw_description: 'ref 20260013' }), true);
  // The display invoice number is the fallback.
  assert.equal(paymentMatchesInvoice(invoice, { description: 'maksu laskulle 2026001' }), true);
  assert.equal(paymentMatchesInvoice(invoice, { description: 'jotain muuta' }), false);
  // A short/absent reference NEVER matches — honest unpaid beats a false paid.
  assert.equal(paymentMatchesInvoice({ referenceNumber: '123', invoiceNumber: null }, { description: '123' }), false);
  assert.equal(paymentMatchesInvoice({}, { description: 'anything' }), false);
  assert.equal(paymentMatchesInvoice(invoice, {}), false);
});

// ----- the closed verdict ----------------------------------------------------------

test('the payment-state enum is closed', () => {
  assert.deepEqual([...ISSUED_INVOICE_PAYMENT_STATES], ['unpaid', 'partially_paid', 'paid', 'overpaid', 'credited']);
});

test('unpaid / partially_paid / paid across the sum-based epsilon semantics', () => {
  const base = { total: 500, dueDate: '2026-08-01', onDate: '2026-07-11' };
  assert.equal(evaluateIssuedInvoiceSettlement({ ...base, payments: [] }).payment_state, 'unpaid');
  const partial = evaluateIssuedInvoiceSettlement({ ...base, payments: [{ amount: 200 }] });
  assert.equal(partial.payment_state, 'partially_paid');
  assert.equal(partial.paid_total, 200);
  assert.equal(partial.open_amount, 300);
  // Within a cent of the total counts as paid (the computeSumBasedPaymentStatus epsilon).
  assert.equal(evaluateIssuedInvoiceSettlement({ ...base, payments: [{ amount: 499.995 }] }).payment_state, 'paid');
  assert.equal(evaluateIssuedInvoiceSettlement({ ...base, payments: [{ amount: 250 }, { amount: 250 }] }).payment_state, 'paid');
});

test('overpaid beyond the epsilon', () => {
  const s = evaluateIssuedInvoiceSettlement({ total: 500, payments: [{ amount: 600 }], onDate: '2026-07-11' });
  assert.equal(s.payment_state, 'overpaid');
  assert.equal(s.open_amount, 0);
});

test('credit notes net the effective due; a fully credited invoice is credited', () => {
  const partial = evaluateIssuedInvoiceSettlement({ total: 500, creditedTotal: 200, payments: [{ amount: 300 }], onDate: '2026-07-11' });
  assert.equal(partial.payment_state, 'paid');
  assert.equal(partial.credited_total, 200);

  const credited = evaluateIssuedInvoiceSettlement({ total: 500, creditedTotal: 500, payments: [], onDate: '2026-07-11' });
  assert.equal(credited.payment_state, 'credited');
  assert.equal(credited.open_amount, 0);

  // Fully credited AND paid = overpaid (money arrived for a cancelled-out sale).
  const odd = evaluateIssuedInvoiceSettlement({ total: 500, creditedTotal: 500, payments: [{ amount: 500 }], onDate: '2026-07-11' });
  assert.equal(odd.payment_state, 'overpaid');
});

test('the overdue flag rides unpaid/partially_paid past the due date, never paid/credited', () => {
  const overdue = evaluateIssuedInvoiceSettlement({ total: 500, dueDate: '2026-07-01', payments: [], onDate: '2026-07-11' });
  assert.deepEqual(overdue.flags, ['overdue']);
  const notDue = evaluateIssuedInvoiceSettlement({ total: 500, dueDate: '2026-08-01', payments: [], onDate: '2026-07-11' });
  assert.deepEqual(notDue.flags, []);
  const paidLate = evaluateIssuedInvoiceSettlement({ total: 500, dueDate: '2026-07-01', payments: [{ amount: 500 }], onDate: '2026-07-11' });
  assert.deepEqual(paidLate.flags, []);
  const noDueDate = evaluateIssuedInvoiceSettlement({ total: 500, dueDate: null, payments: [], onDate: '2026-07-11' });
  assert.deepEqual(noDueDate.flags, []);
});

test('negative and malformed payment amounts are ignored, never subtract', () => {
  const s = evaluateIssuedInvoiceSettlement({ total: 500, payments: [{ amount: -100 }, { amount: 'x' }, { amount: 200 }], onDate: '2026-07-11' });
  assert.equal(s.paid_total, 200);
  assert.equal(s.payment_state, 'partially_paid');
});

// ----- summary + banner (quiet-on-healthy) -----------------------------------------

test('summarizeIssuedInvoices counts states, overdue flags, and open amounts', () => {
  const summary = summarizeIssuedInvoices([
    { settlement: { payment_state: 'paid', flags: [], open_amount: 0 } },
    { settlement: { payment_state: 'unpaid', flags: ['overdue'], open_amount: 300 } },
    { settlement: { payment_state: 'partially_paid', flags: ['overdue'], open_amount: 150 } },
    { settlement: { payment_state: 'credited', flags: [], open_amount: 0 } },
    { settlement: { payment_state: 'nonsense', flags: [], open_amount: 999 } }
  ]);
  assert.equal(summary.total, 4); // the nonsense state is excluded
  assert.equal(summary.paid, 1);
  assert.equal(summary.unpaid, 1);
  assert.equal(summary.partially_paid, 1);
  assert.equal(summary.credited, 1);
  assert.equal(summary.overdue, 2);
  assert.equal(summary.open_amount, 450);
});

test('the banner is quiet on healthy books, loud only on overdue/overpaid', () => {
  assert.equal(buildIssuedInvoiceBannerFi({ overdue: 0, overpaid: 0 }), null);
  assert.equal(buildIssuedInvoiceBannerFi({}), null);
  assert.match(buildIssuedInvoiceBannerFi({ overdue: 1, overpaid: 0 }), /1 lähetetty lasku on erääntynyt/);
  assert.match(buildIssuedInvoiceBannerFi({ overdue: 3, overpaid: 0 }), /3 lähetettyä laskua/);
  const both = buildIssuedInvoiceBannerFi({ overdue: 1, overpaid: 2 });
  assert.match(both, /erääntynyt/);
  assert.match(both, /2 laskua näyttää maksetun yli/);
});

// ----- F-G8-1: planArSettlement (the pure half of the AR posting swap) -------------
// Design: docs/design-donna-finland-ar-settlement-posting.md (D-AR-1/2/7).

const candidate = (over = {}) => ({
  invoice_id: 'inv-001',
  invoice_number: '2026001',
  reference_number: '20260013',
  buyer_name: 'Asiakas Oy',
  currency: 'EUR',
  total_eur: 620,
  credited_total_eur: 0,
  settled_before_eur: 0,
  has_issuance_journal: true,
  ...over
});

const plan = (over = {}) => planArSettlement({
  flagActs: true,
  basis: 'accrual',
  direction: 'receive',
  amountEur: 620,
  transactionCurrency: 'EUR',
  matchCount: 1,
  candidate: candidate(),
  ...over
});

test('F-G8-1 pins: the AR flag key and the CLOSED plan-reason vocabulary', () => {
  assert.equal(FINLAND_AR_SETTLEMENT_FLAG_KEY, 'FINLAND_AR_SETTLEMENT');
  assert.deepEqual([...AR_SETTLEMENT_PLAN_REASONS], [
    'flag_off',
    'cash_basis',
    'not_money_in',
    'no_issued_invoice_match',
    'multiple_invoice_matches',
    'no_issuance_journal',
    'currency_mismatch',
    'overpayment'
  ]);
});

test('planArSettlement plans the full-payment swap with open-before/after receipted', () => {
  const verdict = plan();
  assert.equal(verdict.planned, true);
  assert.equal(verdict.invoice_id, 'inv-001');
  assert.equal(verdict.invoice_number, '2026001');
  assert.equal(verdict.reference_number, '20260013');
  assert.equal(verdict.amount_eur, 620);
  assert.equal(verdict.open_before_eur, 620);
  assert.equal(verdict.open_after_eur, 0);
});

test('partial payments plan normally; credits and prior settlements shrink the open amount', () => {
  const partial = plan({ amountEur: 200 });
  assert.equal(partial.planned, true);
  assert.equal(partial.open_after_eur, 420);

  const second = plan({ amountEur: 200, candidate: candidate({ settled_before_eur: 200 }) });
  assert.equal(second.planned, true);
  assert.equal(second.open_before_eur, 420);
  assert.equal(second.open_after_eur, 220);

  const credited = plan({ amountEur: 300, candidate: candidate({ credited_total_eur: 320 }) });
  assert.equal(credited.planned, true);
  assert.equal(credited.open_before_eur, 300);
  assert.equal(credited.open_after_eur, 0);
});

test('every gate refuses with its typed reason, in canonical order', () => {
  assert.deepEqual(plan({ flagActs: false }), { planned: false, reason: 'flag_off' });
  assert.deepEqual(plan({ basis: 'cash' }), { planned: false, reason: 'cash_basis' });
  assert.deepEqual(plan({ direction: 'spend' }), { planned: false, reason: 'not_money_in' });
  assert.deepEqual(plan({ amountEur: 0 }), { planned: false, reason: 'not_money_in' });
  assert.deepEqual(plan({ matchCount: 0, candidate: null }), { planned: false, reason: 'no_issued_invoice_match' });
  assert.deepEqual(plan({ matchCount: 2, candidate: {} }), { planned: false, reason: 'multiple_invoice_matches' });
  assert.deepEqual(plan({ candidate: candidate({ has_issuance_journal: false }) }), { planned: false, reason: 'no_issuance_journal' });
  assert.deepEqual(plan({ transactionCurrency: 'GBP' }), { planned: false, reason: 'currency_mismatch' });
  assert.deepEqual(plan({ candidate: candidate({ currency: null }) }), { planned: false, reason: 'currency_mismatch' });
});

test('overpayment refuses (D-AR-2.7): beyond the open amount, or nothing open at all', () => {
  assert.deepEqual(plan({ amountEur: 620.02 }), { planned: false, reason: 'overpayment' });
  // Fully credited invoice: nothing open — a payment against it refuses.
  assert.deepEqual(plan({ amountEur: 10, candidate: candidate({ credited_total_eur: 620 }) }), { planned: false, reason: 'overpayment' });
  // Already fully settled by a prior line.
  assert.deepEqual(plan({ amountEur: 10, candidate: candidate({ settled_before_eur: 620 }) }), { planned: false, reason: 'overpayment' });
  // The 1-cent epsilon: a rounding-hair overshoot still plans.
  assert.equal(plan({ amountEur: 620.01 }).planned, true);
});

test('every planArSettlement refusal reason is in the closed vocabulary (two-terminal discipline)', () => {
  const refusals = [
    plan({ flagActs: false }),
    plan({ basis: 'cash' }),
    plan({ direction: 'spend' }),
    plan({ matchCount: 0, candidate: null }),
    plan({ matchCount: 3, candidate: {} }),
    plan({ candidate: candidate({ has_issuance_journal: false }) }),
    plan({ transactionCurrency: 'SEK' }),
    plan({ amountEur: 9999 })
  ];
  for (const verdict of refusals) {
    assert.equal(verdict.planned, false);
    assert.ok(AR_SETTLEMENT_PLAN_REASONS.includes(verdict.reason), verdict.reason);
  }
});

// ── G12: structured reference on the bank line (migration 097) ───────────────

test('G12: a captured reference equal to the viite settles deterministically, whatever the free text says', () => {
  const invoice = { referenceNumber: '20260013', invoiceNumber: '2026001' };
  // Equality decides even when the text itself carries nothing recognizable.
  assert.equal(paymentMatchesInvoice(invoice, {
    description: 'SEPA IN', structured_reference: '20260013'
  }), true);
});

test('G12: a DIFFERING captured reference refuses the line whole — the viite is the allocation instruction', () => {
  const invoice = { referenceNumber: '20260013', invoiceNumber: '2026001' };
  // The line's single validated reference is some OTHER viite whose digit run
  // happens to CONTAIN this invoice's viite (and therefore its invoice
  // number — Donna viitteet embed their base). The substring lanes would
  // falsely settle this invoice AND double-count the money already allocated
  // to the other invoice; the structured decision refuses the line.
  assert.equal(paymentMatchesInvoice(invoice, {
    description: 'REF 1202600135', structured_reference: '1202600135'
  }), false);
  // Without the capture, the same line is the known substring false hit —
  // pinned so the G12 win stays visible.
  assert.equal(paymentMatchesInvoice(invoice, { description: 'REF 1202600135' }), true);
  // A viite-addressed line does not ALSO credit another invoice cited in
  // free text — one payment, one allocation.
  assert.equal(paymentMatchesInvoice(invoice, {
    description: 'maksu laskulle 2026001', structured_reference: '99100238'
  }), false);
});

test('G12: the structured decision needs both sides past the capture floor; otherwise the status quo stands', () => {
  // A short viite (below the capture floor) could have been skipped by the
  // sweep — a differing capture proves nothing about it; the (min-4)
  // substring matcher stands for it.
  const shortViite = { referenceNumber: '1344', invoiceNumber: null };
  assert.equal(paymentMatchesInvoice(shortViite, {
    description: 'viite 1344', structured_reference: '99100238'
  }), true, 'a below-floor viite keeps its substring match despite a differing capture');
  // An invoice with NO viite (the parsed/foreign lane) keeps the substring
  // matcher on its invoice number, capture or not.
  assert.equal(paymentMatchesInvoice({ referenceNumber: null, invoiceNumber: 'INV-2299' }, {
    description: 'payment INV-2299', structured_reference: '99100238'
  }), true);
  const invoice = { referenceNumber: '20260013', invoiceNumber: '2026001' };
  assert.equal(paymentMatchesInvoice(invoice, { description: 'SEPA VIITE 2026 0013' }), true,
    'no capture: the normalized substring matcher is unchanged');
  assert.equal(STRUCTURED_REFERENCE_MIN_DIGITS, 6);
});

// ── gap 8 relocation (2026-07-27): the shim is a shim, not a fork ───────────
//
// The jurisdiction-neutral arithmetic moved to `issuedInvoiceSettlementMath.js`
// and is re-exported here. If a later edit ever re-implements one of these in
// `finland/` instead of re-exporting it, the two copies drift and a Finnish
// invoice and a British one start settling by different rules. Identity —
// literally the same function object — is the cheapest possible proof that
// cannot happen.
test('the finland/ module re-exports the relocated arithmetic rather than re-implementing it', async () => {
  const math = await import('../issuedInvoiceSettlementMath.js');
  const shim = await import('./issuedInvoiceSettlement.js');
  for (const name of [
    'ISSUED_INVOICE_PAYMENT_STATES',
    'ISSUED_INVOICE_FLAGS',
    'STRUCTURED_REFERENCE_MIN_DIGITS',
    'normalizeReferenceText',
    'paymentMatchesInvoice',
    'evaluateIssuedInvoiceSettlement',
    'summarizeIssuedInvoices'
  ]) {
    assert.equal(shim[name], math[name], `finland/ must re-export ${name}, not re-declare it`);
  }
  // ...and the genuinely Finnish half stayed put.
  assert.equal(typeof shim.planArSettlement, 'function');
  assert.equal(typeof shim.buildIssuedInvoiceBannerFi, 'function');
  assert.equal(shim.FINLAND_AR_SETTLEMENT_FLAG_KEY, 'FINLAND_AR_SETTLEMENT');
  assert.equal(math.planArSettlement, undefined, 'planArSettlement must NOT leak into the neutral module');
  assert.equal(math.buildIssuedInvoiceBannerFi, undefined, 'the Finnish banner copy must NOT leak into the neutral module');
});
