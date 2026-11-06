import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice } from './invoice.js';
import {
  finnishReferenceNumber,
  isValidFinnishReferenceNumber,
  isValidIban,
  isValidBusinessId,
  buildFinvoice
} from './verkkolasku.js';

// Known-valid fixtures.
const VALID_IBAN = 'FI2112345600000785'; // canonical FI IBAN example
const VALID_YTUNNUS = '0737546-2';

// A non-ALV toiminimi sale invoice (the Phase-1 launch ICP).
const nonAlvInvoice = () => buildInvoice({
  invoiceNumber: '1234',
  date: '2026-03-01',
  dueDate: '2026-03-15',
  seller: { name: 'Matti Meikäläinen tmi', address: 'Kauppakatu 1, Helsinki' },
  buyer: { name: 'Asiakas Oy', address: 'Yritystie 2, Espoo' },
  lines: [{ description: 'Konsultointi', quantity: 10, unitPrice: 50 }],
  alvRegistered: false
}).invoice;

// An ALV-registered invoice (Phase-2 shape; the totals/VAT-row path).
const alvInvoice = () => buildInvoice({
  invoiceNumber: '5678',
  date: '2026-03-01',
  seller: { name: 'Yritys Oy' },
  buyer: { name: 'Asiakas Oy' },
  lines: [{ description: 'Palvelu', quantity: 1, unitPrice: 100, alvRate: 25.5 }],
  alvRegistered: true
}).invoice;

// --- viitenumero -------------------------------------------------------------------
test('finnishReferenceNumber — computes the 7-3-1 check digit', () => {
  assert.equal(finnishReferenceNumber('1234'), '12344');
  assert.equal(finnishReferenceNumber('1234567'), '12345672');
});

test('finnishReferenceNumber — strips non-digits and leading zeros', () => {
  assert.equal(finnishReferenceNumber('00 1234'), '12344');
});

test('finnishReferenceNumber — refuses a base outside 3–19 digits', () => {
  assert.throws(() => finnishReferenceNumber('12'), /3–19 digits/);
  assert.throws(() => finnishReferenceNumber('1'.repeat(20)), /3–19 digits/);
});

test('isValidFinnishReferenceNumber — round-trips a computed reference', () => {
  assert.equal(isValidFinnishReferenceNumber(finnishReferenceNumber('1234567')), true);
  assert.equal(isValidFinnishReferenceNumber('12345'), false); // wrong check digit for base 1234
  assert.equal(isValidFinnishReferenceNumber('abc'), false);
});

// --- IBAN --------------------------------------------------------------------------
test('isValidIban — accepts a valid FI IBAN (mod-97), tolerates spacing', () => {
  assert.equal(isValidIban(VALID_IBAN), true);
  assert.equal(isValidIban('FI21 1234 5600 0007 85'), true);
});

test('isValidIban — rejects a bad check, wrong FI length, and junk', () => {
  assert.equal(isValidIban('FI2112345600000786'), false); // last digit flipped
  assert.equal(isValidIban('FI211234560000078'), false); // 17 chars, not 18
  assert.equal(isValidIban('not-an-iban'), false);
});

// --- Y-tunnus ----------------------------------------------------------------------
test('isValidBusinessId — validates the Y-tunnus check digit', () => {
  assert.equal(isValidBusinessId(VALID_YTUNNUS), true);
  assert.equal(isValidBusinessId('0737546-3'), false); // wrong check
  assert.equal(isValidBusinessId('1234567'), false); // no check digit
});

// --- buildFinvoice: happy paths ----------------------------------------------------
test('buildFinvoice — non-ALV toiminimi: structured model, derived viitenumero, exemption note carried', () => {
  const r = buildFinvoice({
    invoice: nonAlvInvoice(),
    seller: { name: 'Matti Meikäläinen tmi', businessId: VALID_YTUNNUS },
    buyer: { name: 'Asiakas Oy' },
    payment: { iban: VALID_IBAN, bic: 'OKOYFIHH' }
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.finvoice.schema, 'finvoice-3.0');
  assert.equal(r.finvoice.sellerParty.vatRegistered, false);
  assert.equal(r.finvoice.invoiceDetails.alvExempt, true);
  assert.equal(r.finvoice.invoiceDetails.vatTotal, 0);
  assert.match(r.finvoice.invoiceDetails.exemptionNote, /AVL 3/);
  assert.equal(r.finvoice.invoiceDetails.referenceNumber, '12344');
  assert.equal(r.finvoice.paymentDetails.referenceNumber, '12344');
  assert.equal(r.finvoice.paymentDetails.amountToPay, 500);
  assert.equal(r.finvoice.rows.length, 1);
  assert.equal(r.finvoice.rows[0].rowVatRatePercent, 0);
});

test('buildFinvoice — ALV-registered: VAT rows sum to the invoice totals', () => {
  const inv = alvInvoice();
  const r = buildFinvoice({ invoice: inv, seller: { name: 'Yritys Oy' }, buyer: { name: 'Asiakas Oy' }, payment: { iban: VALID_IBAN } });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.finvoice.invoiceDetails.vatTotal, 25.5);
  assert.equal(r.finvoice.invoiceDetails.total, 125.5);
  assert.equal(r.finvoice.rows[0].rowVatRatePercent, 25.5);
});

test('buildFinvoice — accepts a supplied valid viitenumero over the derived one', () => {
  const ref = finnishReferenceNumber('9999');
  const r = buildFinvoice({ invoice: nonAlvInvoice(), payment: { iban: VALID_IBAN }, reference: ref });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.finvoice.invoiceDetails.referenceNumber, ref);
});

// --- buildFinvoice: KEEP-layer refusals --------------------------------------------
test('buildFinvoice — refuses a missing or invalid IBAN', () => {
  assert.deepEqual(buildFinvoice({ invoice: nonAlvInvoice(), payment: {} }).ok, false);
  const bad = buildFinvoice({ invoice: nonAlvInvoice(), payment: { iban: 'FI2112345600000786' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /IBAN/.test(e)));
});

test('buildFinvoice — refuses an invalid supplied reference', () => {
  const r = buildFinvoice({ invoice: nonAlvInvoice(), payment: { iban: VALID_IBAN }, reference: '12345' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /viitenumero/.test(e)));
});

test('buildFinvoice — refuses an invalid seller Y-tunnus', () => {
  const r = buildFinvoice({ invoice: nonAlvInvoice(), seller: { name: 'X', businessId: '0737546-3' }, payment: { iban: VALID_IBAN } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Y-tunnus/.test(e)));
});

test('buildFinvoice — refuses an ALV-exempt invoice that carries a VAT total (tampered)', () => {
  const inv = { ...nonAlvInvoice(), alvTotal: 10, total: 510 };
  const r = buildFinvoice({ invoice: inv, payment: { iban: VALID_IBAN } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /VAT total|does not match/.test(e)));
});

test('buildFinvoice — refuses when the rows do not foot to the invoice total (tampered)', () => {
  const inv = { ...alvInvoice(), total: 999 };
  const r = buildFinvoice({ invoice: inv, payment: { iban: VALID_IBAN } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /does not match/.test(e)));
});

test('buildFinvoice — requires an invoice object', () => {
  assert.equal(buildFinvoice({ payment: { iban: VALID_IBAN } }).ok, false);
});
