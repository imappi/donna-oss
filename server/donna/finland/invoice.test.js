import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCreditNote, buildInvoice, validateInvoiceInput, ALV_EXEMPTION_NOTE } from './invoice.js';

const baseInput = () => ({
  invoiceNumber: '2026-001',
  date: '2026-07-09',
  dueDate: '2026-07-23',
  seller: { name: 'Matti Yrittäjä tmi' },
  buyer: { name: 'Asiakas Oy' },
  lines: [
    { description: 'Konsultointi', quantity: 10, unitPrice: 90 },
    { description: 'Matkakulut', quantity: 1, unitPrice: 45.5 }
  ]
});

test('a valid non-ALV invoice computes totals and attaches the exemption note', () => {
  const { ok, errors, invoice } = buildInvoice(baseInput());
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(invoice.subtotal, 945.5); // 900 + 45.5
  assert.equal(invoice.alvTotal, 0);
  assert.equal(invoice.total, 945.5);
  assert.equal(invoice.alvExempt, true);
  assert.equal(invoice.exemptionNote, ALV_EXEMPTION_NOTE.fi);
});

test('the totals identity subtotal + alvTotal == total holds', () => {
  const { invoice } = buildInvoice(baseInput());
  assert.equal(Math.round((invoice.subtotal + invoice.alvTotal) * 100) / 100, invoice.total);
});

test('per-line net is quantity * unitPrice, rounded to cents', () => {
  const { invoice } = buildInvoice({ ...baseInput(), lines: [{ description: 'X', quantity: 3, unitPrice: 33.333 }] });
  assert.equal(invoice.lines[0].net, 100); // 99.999 -> 100.00
});

test('a non-ALV seller may not charge ALV', () => {
  const { ok, errors } = buildInvoice({ ...baseInput(), lines: [{ description: 'X', quantity: 1, unitPrice: 100, alvRate: 25.5 }] });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /cannot charge ALV/.test(e)));
});

test('an ALV-registered invoice applies per-line rates', () => {
  const { ok, invoice } = buildInvoice({
    ...baseInput(),
    alvRegistered: true,
    lines: [{ description: 'Palvelu', quantity: 1, unitPrice: 100, alvRate: 25.5 }]
  });
  assert.equal(ok, true);
  assert.equal(invoice.subtotal, 100);
  assert.equal(invoice.alvTotal, 25.5);
  assert.equal(invoice.total, 125.5);
  assert.equal(invoice.alvExempt, false);
  assert.equal(invoice.exemptionNote, null);
});

test('validation rejects empty lines, missing parties, bad quantities', () => {
  assert.ok(validateInvoiceInput({}).length > 0);
  const errs = validateInvoiceInput({ ...baseInput(), lines: [{ description: '', quantity: 0, unitPrice: -1 }] });
  assert.ok(errs.some((e) => /description/.test(e)));
  assert.ok(errs.some((e) => /quantity/.test(e)));
  assert.ok(errs.some((e) => /unitPrice/.test(e)));
});

test('buildInvoice returns errors (not a throw) on invalid input', () => {
  const { ok, invoice, errors } = buildInvoice({ lines: [] });
  assert.equal(ok, false);
  assert.equal(invoice, null);
  assert.ok(errors.length > 0);
});

test('the English exemption note is selectable by locale', () => {
  const { invoice } = buildInvoice({ ...baseInput(), locale: 'en' });
  assert.equal(invoice.exemptionNote, ALV_EXEMPTION_NOTE.en);
});

// ── G-8: buildCreditNote (hyvityslasku) ────────────────────────────────────────

const originalInvoice = () => buildInvoice(baseInput()).invoice; // total 945.5

test('a bare credit note (no amount) drafts a FULL credit of the remaining creditable amount', () => {
  const { ok, errors, creditNote } = buildCreditNote({
    originalInvoice: originalInvoice(),
    invoiceNumber: '2026-002',
    date: '2026-07-11'
  });
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(creditNote.kind, 'credit_note');
  assert.equal(creditNote.creditsInvoiceNumber, '2026-001');
  assert.equal(creditNote.total, 945.5); // POSITIVE model — sign is presentation
  assert.ok(creditNote.total > 0);
  assert.equal(creditNote.lines[0].description, 'Hyvitys laskulle 2026-001');
});

test('a stated amount drafts a partial credit', () => {
  const { ok, creditNote } = buildCreditNote({
    originalInvoice: originalInvoice(),
    invoiceNumber: '2026-002',
    date: '2026-07-11',
    amount: 200,
    reason: 'sovittu alennus'
  });
  assert.equal(ok, true);
  assert.equal(creditNote.total, 200);
  assert.equal(creditNote.creditReason, 'sovittu alennus');
});

test('prior credits shrink the full-credit default and the cap', () => {
  const full = buildCreditNote({
    originalInvoice: originalInvoice(),
    priorCreditedTotal: 900,
    invoiceNumber: '2026-003',
    date: '2026-07-11'
  });
  assert.equal(full.ok, true);
  assert.equal(full.creditNote.total, 45.5);

  const over = buildCreditNote({
    originalInvoice: originalInvoice(),
    priorCreditedTotal: 900,
    invoiceNumber: '2026-003',
    date: '2026-07-11',
    amount: 100
  });
  assert.equal(over.ok, false);
  assert.ok(over.errors.some((e) => /exceeds the remaining creditable/.test(e)));
});

test('a fully credited original refuses another credit note', () => {
  const { ok, errors } = buildCreditNote({
    originalInvoice: originalInvoice(),
    priorCreditedTotal: 945.5,
    invoiceNumber: '2026-004',
    date: '2026-07-11'
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /already fully credited/.test(e)));
});

test('a credit note refuses a missing/invalid original and non-positive amounts', () => {
  assert.equal(buildCreditNote({ invoiceNumber: '2026-002', date: '2026-07-11' }).ok, false);
  const zero = buildCreditNote({ originalInvoice: originalInvoice(), invoiceNumber: '2026-002', date: '2026-07-11', amount: 0 });
  assert.equal(zero.ok, false);
  const negative = buildCreditNote({ originalInvoice: originalInvoice(), invoiceNumber: '2026-002', date: '2026-07-11', amount: -50 });
  assert.equal(negative.ok, false);
});

test('the credit note inherits the original parties and currency', () => {
  const { creditNote } = buildCreditNote({
    originalInvoice: originalInvoice(),
    invoiceNumber: '2026-002',
    date: '2026-07-11',
    amount: 100
  });
  assert.equal(creditNote.buyer.name, 'Asiakas Oy');
  assert.equal(creditNote.seller.name, 'Matti Yrittäjä tmi');
  assert.equal(creditNote.currency, 'EUR');
  assert.equal(creditNote.alvExempt, true);
});
