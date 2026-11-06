// FI-10 (issue-side, verkkolasku) — the structured Finnish e-invoice (Finvoice 3.0)
// model built on top of `invoice.js` buildInvoice. Pure compute + KEEP-layer
// arithmetic. This assembles the STRUCTURED artifact a Finvoice XML renderer would
// serialize (an intermediate representation, not raw tag soup) and validates it; it
// does NOT render XML, transmit to a verkkolasku operator, or post an AR journal to
// the ledger — the AR post crosses into the isolation list (🔴, Kari go). No ledger
// post, no isolation-listed import.
//
// KEEP-layer (arithmetic/format invariants, not model judgment — the same discipline
// as buildInvoice's `subtotal + alvTotal == total`):
//   • the Finnish reference number (viitenumero) check digit (7-3-1 weighting) —
//     a payment reference with a wrong check digit is refused, not shaded;
//   • the IBAN check (ISO 13616 mod-97) — an unpayable account is refused;
//   • the Finvoice totals must equal the source invoice's totals;
//   • a non-ALV toiminimi issues NO VAT rows and MUST carry the AVL 3 § exemption
//     note (mirrors buildInvoice; a VAT amount on a non-ALV invoice is refused).
//
// Full arc: docs/design-donna-finland-standalone.md §4.4 (FI-10). Non-ALV toiminimi
// is the Phase-1 launch ICP.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// ---------------------------------------------------------------------------------
// Finnish reference number (kansallinen viitenumero) — KEEP-layer arithmetic.
// ---------------------------------------------------------------------------------
// Base is 3–19 digits (typically the invoice number). The check digit is
// 10 − (Σ digit×weight mod 10) mod 10, weights 7,3,1 cycling from the RIGHTMOST
// base digit. The returned reference is base + check digit (4–20 digits).
export const finnishReferenceNumber = (base) => {
  const b = digitsOnly(base).replace(/^0+/, '') || '0';
  if (b === '0' || b.length < 3 || b.length > 19) {
    const error = new Error('A Finnish reference number base must be 3–19 digits.');
    error.code = 'VIITENUMERO_BASE_LENGTH';
    throw error;
  }
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < b.length; i += 1) {
    const digit = Number(b[b.length - 1 - i]);
    sum += digit * weights[i % 3];
  }
  const check = (10 - (sum % 10)) % 10;
  return `${b}${check}`;
};

// Validate a complete viitenumero (base + check digit): recompute the check over
// all but the last digit and compare. Non-numeric / too-short ⇒ false, never throws.
export const isValidFinnishReferenceNumber = (reference) => {
  const r = digitsOnly(reference);
  if (r.length < 4 || r.length > 20) return false;
  const base = r.slice(0, -1).replace(/^0+/, '') || '0';
  if (base === '0' || base.length < 3) return false;
  try {
    return finnishReferenceNumber(base) === `${base}${r.slice(-1)}`;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------
// IBAN check (ISO 13616 mod-97) — KEEP-layer format invariant.
// ---------------------------------------------------------------------------------
// A Finnish IBAN is 18 chars (FI + 2 check + 14). We enforce the FI length when the
// country is FI, and the generic mod-97 rule for any IBAN. Never throws.
export const isValidIban = (iban) => {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  if (s.startsWith('FI') && s.length !== 18) return false;
  if (s.length < 15 || s.length > 34) return false;
  // Move the first four chars to the end, then replace letters with 10..35.
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) {
      remainder = (remainder * 10 + Number(d)) % 97;
    }
  }
  return remainder === 1;
};

// ---------------------------------------------------------------------------------
// Finnish business ID (Y-tunnus) check — KEEP-layer format invariant.
// ---------------------------------------------------------------------------------
// Format NNNNNNN-C: 7 body digits + a check digit (weights 7,9,10,5,8,4,2). A
// remainder of 1 is invalid (no valid check digit exists). Never throws.
export const isValidBusinessId = (businessId) => {
  const s = String(businessId ?? '').trim();
  const m = s.match(/^(\d{7})-(\d)$/);
  if (!m) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2];
  const sum = m[1].split('').reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
  const mod = sum % 11;
  if (mod === 1) return false;
  const check = mod === 0 ? 0 : 11 - mod;
  return check === Number(m[2]);
};

// ---------------------------------------------------------------------------------
// buildFinvoice — assemble the structured Finvoice model from a buildInvoice result.
// ---------------------------------------------------------------------------------
// `invoice` is the `buildInvoice(...).invoice` object. `seller`/`buyer` carry the
// party identifiers a verkkolasku needs (businessId / address); `payment` carries
// the bank details (IBAN/BIC). `reference` is optional — when omitted, a viitenumero
// is derived from the invoice number. Returns { ok, errors, finvoice }. Refuses (ok
// false) on any KEEP-layer violation rather than emitting an unpayable/invalid
// e-invoice.
export const buildFinvoice = ({ invoice, seller = {}, buyer = {}, payment = {}, reference = null } = {}) => {
  const errors = [];
  if (!invoice || typeof invoice !== 'object') {
    return { ok: false, errors: ['invoice (a buildInvoice result) is required'], finvoice: null };
  }

  // Party identifiers.
  if (!isNonEmptyString(seller.name) && !isNonEmptyString(invoice.seller?.name)) errors.push('seller.name is required');
  if (seller.businessId && !isValidBusinessId(seller.businessId)) errors.push('seller.businessId is not a valid Y-tunnus');
  if (buyer.businessId && !isValidBusinessId(buyer.businessId)) errors.push('buyer.businessId is not a valid Y-tunnus');

  // Payment account — a verkkolasku must be payable.
  if (!isNonEmptyString(payment.iban)) errors.push('payment.iban is required for a verkkolasku');
  else if (!isValidIban(payment.iban)) errors.push('payment.iban is not a valid IBAN');

  // Reference number: validate a supplied one, else derive from the invoice number.
  let referenceNumber = null;
  if (reference != null) {
    if (!isValidFinnishReferenceNumber(reference)) errors.push('reference is not a valid Finnish viitenumero');
    else referenceNumber = digitsOnly(reference);
  } else {
    try {
      referenceNumber = finnishReferenceNumber(invoice.invoiceNumber);
    } catch {
      errors.push('cannot derive a viitenumero from the invoice number (need 3–19 digits); supply `reference`');
    }
  }

  // G-8: a credit note MUST reference the original invoice it credits — an
  // unanchored hyvityslasku is refused, never rendered (D-G8-4).
  if (invoice.kind === 'credit_note' && !isNonEmptyString(invoice.creditsInvoiceNumber)) {
    errors.push('a credit note (hyvityslasku) must reference the original invoice number');
  }

  // ALV consistency — mirror buildInvoice: a non-ALV toiminimi carries no VAT.
  const alvExempt = invoice.alvExempt === true;
  if (alvExempt) {
    if (round2(invoice.alvTotal) !== 0) errors.push('an ALV-exempt invoice must not carry a VAT total');
    if (!isNonEmptyString(invoice.exemptionNote)) errors.push('an ALV-exempt invoice must carry the AVL 3 § exemption note');
  }

  // Rows + totals: the Finvoice totals must equal the source invoice's totals.
  const rows = (Array.isArray(invoice.lines) ? invoice.lines : []).map((l, i) => ({
    rowPosition: i + 1,
    articleName: l.description,
    deliveredQuantity: l.quantity,
    unitPriceAmount: l.unitPrice,
    rowVatRatePercent: alvExempt ? 0 : round2(l.alvRate || 0),
    rowVatAmount: alvExempt ? 0 : round2(l.alv || 0),
    rowAmount: round2(l.net || 0)
  }));
  const rowNetSum = round2(rows.reduce((s, r) => s + r.rowAmount, 0));
  const rowVatSum = round2(rows.reduce((s, r) => s + r.rowVatAmount, 0));
  if (rowNetSum !== round2(invoice.subtotal)) errors.push('finvoice row net total does not match invoice subtotal');
  if (rowVatSum !== round2(invoice.alvTotal)) errors.push('finvoice row VAT total does not match invoice alvTotal');
  if (round2(rowNetSum + rowVatSum) !== round2(invoice.total)) errors.push('finvoice total (net + VAT) does not match invoice total');

  if (errors.length) return { ok: false, errors, finvoice: null };

  // The structured Finvoice model (a serializer-agnostic intermediate representation;
  // field names track the Finvoice 3.0 elements a renderer maps to).
  const finvoice = {
    schema: 'finvoice-3.0',
    sellerParty: {
      name: seller.name || invoice.seller?.name,
      businessId: seller.businessId || null,
      address: seller.address || invoice.seller?.address || null,
      vatRegistered: !alvExempt
    },
    buyerParty: {
      name: buyer.name || invoice.buyer?.name,
      businessId: buyer.businessId || null,
      address: buyer.address || invoice.buyer?.address || null
    },
    invoiceDetails: {
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.date,
      dueDate: invoice.dueDate || null,
      currency: invoice.currency || 'EUR',
      referenceNumber,
      subtotal: round2(invoice.subtotal),
      vatTotal: round2(invoice.alvTotal),
      total: round2(invoice.total),
      alvExempt,
      exemptionNote: alvExempt ? invoice.exemptionNote : null,
      // G-8 (hyvityslasku, D-G8-4): the model stays positive; the type code +
      // original-invoice reference tell the renderer to apply the statutory
      // INV02 negative presentation.
      typeCode: invoice.kind === 'credit_note' ? 'INV02' : 'INV01',
      originalInvoiceNumber: invoice.kind === 'credit_note' ? (invoice.creditsInvoiceNumber || null) : null
    },
    rows,
    paymentDetails: {
      iban: String(payment.iban).replace(/\s+/g, '').toUpperCase(),
      bic: payment.bic ? String(payment.bic).trim().toUpperCase() : null,
      referenceNumber,
      amountToPay: round2(invoice.total),
      dueDate: invoice.dueDate || null
    }
  };

  return { ok: true, errors: [], finvoice };
};
