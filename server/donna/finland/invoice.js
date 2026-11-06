// FI-10 (compute-half) — Sale-invoice (myyntilasku) model builder + totals math
// for a Finnish sole trader. Pure compute. This builds and validates the invoice
// ARTIFACT (numbers, totals, exemption note); it does NOT render a PDF/verkkolasku
// and does NOT post an AR journal to the ledger — those cross into the isolation
// list and wait on Kari's greenlight. Non-ALV toiminimi ⇒ no ALV lines + the
// statutory small-business exemption note.
//
// KEEP-layer: the totals identity subtotal + alvTotal == total is arithmetic, not
// intelligence — it is asserted here, the same discipline as the extractor's
// subtotal+tax==total check.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The statutory note a non-ALV-registered small business must show on its invoices
// (vähäinen toiminta / small-scale activity exemption, Arvonlisäverolaki 3 §).
export const ALV_EXEMPTION_NOTE = {
  fi: 'Ei arvonlisäverovelvollinen (AVL 3 §). Laskulla ei veloiteta arvonlisäveroa.',
  en: 'Not liable for VAT (small-business exemption, VAT Act §3). No VAT charged on this invoice.'
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// validateInvoiceInput(input) — return an array of human-readable errors ([] = ok).
export const validateInvoiceInput = ({ seller, buyer, lines, invoiceNumber, date } = {}) => {
  const errors = [];
  if (!isNonEmptyString(invoiceNumber)) errors.push('invoiceNumber is required');
  if (!isNonEmptyString(date)) errors.push('date is required');
  if (!isNonEmptyString(seller?.name)) errors.push('seller.name is required');
  if (!isNonEmptyString(buyer?.name)) errors.push('buyer.name is required');
  if (!Array.isArray(lines) || lines.length === 0) {
    errors.push('at least one invoice line is required');
  } else {
    lines.forEach((l, i) => {
      if (!isNonEmptyString(l?.description)) errors.push(`line ${i + 1}: description is required`);
      const q = Number(l?.quantity);
      const u = Number(l?.unitPrice);
      if (!Number.isFinite(q) || q <= 0) errors.push(`line ${i + 1}: quantity must be > 0`);
      if (!Number.isFinite(u) || u < 0) errors.push(`line ${i + 1}: unitPrice must be >= 0`);
      const rate = l?.alvRate;
      if (rate !== undefined && rate !== null && (!Number.isFinite(Number(rate)) || Number(rate) < 0)) {
        errors.push(`line ${i + 1}: alvRate must be a non-negative number`);
      }
    });
  }
  return errors;
};

// buildInvoice(input) — returns { ok, errors, invoice }. `alvRegistered` defaults
// false (the Phase-1 non-ALV toiminimi). When not registered, any per-line alvRate
// is rejected (a non-ALV seller cannot charge ALV) and the exemption note is
// attached. When registered, per-line alvRate is applied (Phase-2 callers supply
// the rate via FI-2's resolveAlvCode → the account/return wiring).
export const buildInvoice = (input = {}) => {
  const { seller, buyer, lines = [], invoiceNumber, date, dueDate = null, currency = 'EUR', alvRegistered = false, locale = 'fi' } = input;

  const errors = validateInvoiceInput(input);
  if (!alvRegistered) {
    lines.forEach((l, i) => {
      const rate = Number(l?.alvRate);
      if (Number.isFinite(rate) && rate > 0) errors.push(`line ${i + 1}: a non-ALV-registered seller cannot charge ALV (alvRate must be 0/absent)`);
    });
  }
  if (errors.length) return { ok: false, errors, invoice: null };

  const computedLines = lines.map((l) => {
    const quantity = Number(l.quantity);
    const unitPrice = Number(l.unitPrice);
    const net = round2(quantity * unitPrice);
    const alvRate = alvRegistered ? Number(l.alvRate || 0) : 0;
    const alv = round2(net * (alvRate / 100));
    return { description: l.description.trim(), quantity, unitPrice, alvRate, net, alv };
  });

  const subtotal = round2(computedLines.reduce((s, l) => s + l.net, 0));
  const alvTotal = round2(computedLines.reduce((s, l) => s + l.alv, 0));
  const total = round2(subtotal + alvTotal);

  // KEEP-layer arithmetic guard — must hold by construction.
  if (round2(subtotal + alvTotal) !== total) {
    return { ok: false, errors: ['totals invariant failed: subtotal + alvTotal != total'], invoice: null };
  }

  const alvExempt = !alvRegistered;
  const invoice = {
    invoiceNumber: invoiceNumber.trim(),
    date,
    dueDate,
    currency,
    seller,
    buyer,
    lines: computedLines,
    subtotal,
    alvTotal,
    total,
    alvExempt,
    exemptionNote: alvExempt ? (ALV_EXEMPTION_NOTE[locale] || ALV_EXEMPTION_NOTE.fi) : null
  };
  return { ok: true, errors: [], invoice };
};

// ---------------------------------------------------------------------------------
// buildCreditNote — FI-15 G-8 (hyvityslasku). A credit note is a SEPARATE artifact,
// not a negative sale (the ledger.js boundary): the model carries POSITIVE totals
// plus kind/creditsInvoiceNumber, and the RENDER layers apply the statutory
// negative presentation (Finvoice INV02; D-G8-4). KEEP-layer refusals here:
//   • the original must be a built invoice with a positive total;
//   • credit total must be > 0 and <= original total − priorCreditedTotal
//     (the D-G8-3 cap — over-crediting refuses, never shades);
//   • parties/currency INHERIT from the original (D-G8-8);
//   • non-ALV only (Phase 1) — inherited via buildInvoice's alvRegistered=false.
// With neither `amount` nor `lines`, drafts a FULL credit of the remaining
// creditable amount (D-G8-2 — confirm-first shows it before anything issues).
// Design: docs/design-donna-finland-fi15-g8-credit-notes.md.
export const buildCreditNote = ({
  originalInvoice = null,
  priorCreditedTotal = 0,
  invoiceNumber,
  date,
  amount = null,
  lines = null,
  reason = null,
  locale = 'fi'
} = {}) => {
  const errors = [];
  if (!originalInvoice || typeof originalInvoice !== 'object' || !isNonEmptyString(originalInvoice.invoiceNumber)) {
    return { ok: false, errors: ['a built original invoice (with its invoice number) is required'], creditNote: null };
  }
  const originalTotal = round2(originalInvoice.total);
  if (!(originalTotal > 0)) {
    return { ok: false, errors: ['the original invoice must carry a positive total'], creditNote: null };
  }
  // FI-13 13.4: a credit note against an ALV invoice must mirror its VAT — issuing
  // a VAT-less credit for a VAT invoice would misstate the books. Rather than
  // guess the mixed-rate crediting, refuse an ALV original here; ALV credit notes
  // land with the route activation (PR3). Inert today — an ALV original only
  // exists once ALV invoicing is switched on. The exempt path is unchanged.
  if (originalInvoice.alvExempt === false) {
    return { ok: false, errors: ['crediting an ALV invoice is not yet supported (ALV credit notes: follow-up)'], creditNote: null };
  }
  const prior = round2(Number(priorCreditedTotal) || 0);
  if (prior < 0) errors.push('priorCreditedTotal cannot be negative');
  const remainingCreditable = round2(originalTotal - prior);
  if (remainingCreditable <= 0) {
    errors.push(`invoice ${originalInvoice.invoiceNumber} is already fully credited (${prior} of ${originalTotal})`);
  }
  if (errors.length) return { ok: false, errors, creditNote: null };

  // Credit lines: explicit lines > bare amount > full remaining creditable.
  let creditLines;
  if (Array.isArray(lines) && lines.length) {
    creditLines = lines;
  } else if (amount != null) {
    const a = round2(Number(amount));
    if (!Number.isFinite(a) || a <= 0) {
      return { ok: false, errors: ['credit amount must be a positive number'], creditNote: null };
    }
    creditLines = [{ description: `Hyvitys laskulle ${originalInvoice.invoiceNumber}`, quantity: 1, unitPrice: a }];
  } else {
    creditLines = [{ description: `Hyvitys laskulle ${originalInvoice.invoiceNumber}`, quantity: 1, unitPrice: remainingCreditable }];
  }

  const built = buildInvoice({
    seller: originalInvoice.seller,
    buyer: originalInvoice.buyer,
    lines: creditLines,
    invoiceNumber,
    date,
    dueDate: null,
    currency: originalInvoice.currency || 'EUR',
    alvRegistered: false,
    locale
  });
  if (!built.ok) return { ok: false, errors: built.errors, creditNote: null };
  if (!(built.invoice.total > 0)) {
    return { ok: false, errors: ['credit note total must be positive'], creditNote: null };
  }
  // The D-G8-3 cap: never credit more than the original still carries.
  if (built.invoice.total > remainingCreditable) {
    return {
      ok: false,
      errors: [`credit total ${built.invoice.total} exceeds the remaining creditable amount ${remainingCreditable} of invoice ${originalInvoice.invoiceNumber}`],
      creditNote: null
    };
  }

  return {
    ok: true,
    errors: [],
    creditNote: {
      ...built.invoice,
      kind: 'credit_note',
      creditsInvoiceNumber: originalInvoice.invoiceNumber,
      creditReason: isNonEmptyString(reason) ? reason.trim() : null
    }
  };
};
