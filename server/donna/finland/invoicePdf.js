// FI-10 (PDF render lane) — statutory sales-invoice PDF for the B2C lane, plus
// the human-readable attachment on the B2B email lane.
// Design: docs/design-donna-finland-fi10-pdf-render.md.
//
// Two layers, kept separate (the verkkolaskuRender/verkkolaskuTransmit split):
//   • PURE — buildInvoicePdfModel projects the PERSISTED finvoice model into the
//     ordered PDF content and REFUSES when statutory content is missing
//     (D-FI10-P5); renderInvoicePdf draws that model with pdf-lib. Neither
//     computes a figure — totals, viitenumero, and the exemption note were
//     footed/validated by buildInvoice/buildFinvoice before any draft existed
//     (render-the-persisted-verdict).
//   • I/O-INJECTABLE — transmitInvoicePdfEmail: the B2C transmit channel, with
//     the exact refusal + receipt discipline of transmitFinvoiceEmail (authority
//     basis, actor, valid recipient, renderable artifact, model id on receipt).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const clean = (v) => String(v ?? '').trim();
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v));

// Finnish display formats. Pure string transforms of persisted values — the €
// amounts and ISO dates come from the validated finvoice, never re-computed.
const fiMoney = (value) => {
  const n = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}${grouped},${dec}`;
};
const fiDate = (isoDate) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(isoDate));
  return m ? `${Number(m[3])}.${Number(m[2])}.${Number(m[1])}` : clean(isoDate);
};
const fiQuantity = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return clean(value);
  return Number.isInteger(n) ? String(n) : fiMoney(n);
};

// IBAN display grouping (FI49 5000 9420 0287 30).
const groupIban = (iban) => clean(iban).replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

// G11 — virtuaaliviivakoodi (the Finanssiala bank barcode, version 4): the
// 54-digit string Finnish banking apps accept by paste or scan, printed in
// the payment block as a Finnish payment convention. Pure projection of the
// ALREADY-VALIDATED payment data (IBAN mod-97 and the viite check digit were
// enforced by buildFinvoice) — nothing is computed here.
//
// Version 4 layout (national viitenumero — the only kind the FI lane mints;
// an RF reference would need version 5, deliberately unimplemented):
//   "4" · 16 digits of the FI IBAN (after the country code) · 8-digit amount
//   (EUR cents; zeros when unknown or out of the spec's 0..999999.99 range —
//   the payer's bank asks, never a truncated figure) · "000" reserve ·
//   viite zero-padded to 20 · due date YYMMDD ("000000" when absent).
//
// Returns null when no valid version-4 barcode exists (non-FI IBAN, non-
// numeric reference) — the caller omits the row; a statutory-valid invoice
// never fails over a convenience string.
export const buildVirtualBarcode = ({ iban, amountToPay, referenceNumber, dueDate } = {}) => {
  const compactIban = clean(iban).replace(/\s+/g, '').toUpperCase();
  if (!/^FI\d{16}$/.test(compactIban)) return null;
  const reference = clean(referenceNumber).replace(/\s+/g, '');
  if (!/^\d{4,20}$/.test(reference)) return null;
  const cents = Math.round((Number(amountToPay) + Number.EPSILON) * 100);
  const amountField = Number.isInteger(cents) && cents > 0 && cents <= 99999999
    ? String(cents).padStart(8, '0')
    : '00000000';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(dueDate));
  const dueField = m ? `${m[1].slice(2)}${m[2]}${m[3]}` : '000000';
  return `4${compactIban.slice(2)}${amountField}000${reference.padStart(20, '0')}${dueField}`;
};

// A Finnish VAT rate for display: fi decimal comma, no trailing zeros (25.5 →
// "25,5", 10 → "10").
const fiRate = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return clean(value);
  return String(n).replace('.', ',');
};

// Group Finvoice rows by VAT rate for the statutory per-rate breakdown (AVL
// 209 e §): each distinct rate → its summed net base + VAT amount, in ascending
// rate order so the render is deterministic.
const vatBreakdownRows = (rows) => {
  const byRate = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const rate = Number(r?.rowVatRatePercent) || 0;
    const cur = byRate.get(rate) || { rate, net: 0, vat: 0 };
    cur.net = Math.round((cur.net + (Number(r?.rowAmount) || 0)) * 100) / 100;
    cur.vat = Math.round((cur.vat + (Number(r?.rowVatAmount) || 0)) * 100) / 100;
    byRate.set(rate, cur);
  }
  return [...byRate.values()].sort((a, b) => a.rate - b.rate);
};

// ---------------------------------------------------------------------------------
// buildInvoicePdfModel — PURE. finvoice → { ok, errors, model }.
// ---------------------------------------------------------------------------------
// The D-FI10-P5 statutory refusals live HERE, so tests assert content — not
// pixels — and the renderer stays a dumb projector. Most of these are already
// guaranteed by buildFinvoice; refusing again at the artifact boundary is the
// same defense-in-depth posture as renderFinvoiceXml.
export const buildInvoicePdfModel = ({ finvoice } = {}) => {
  const errors = [];
  const f = finvoice && finvoice.schema ? finvoice : finvoice?.finvoice;
  if (!f || typeof f !== 'object') {
    return { ok: false, errors: ['a built finvoice model is required'], model: null };
  }
  const seller = f.sellerParty || {};
  const buyer = f.buyerParty || {};
  const d = f.invoiceDetails || {};
  const pay = f.paymentDetails || {};
  const rows = Array.isArray(f.rows) ? f.rows : [];

  // G-8 (D-G8-4): a credit note (hyvityslasku) renders with its own title,
  // negative amounts, the original-invoice reference, and NO payment
  // instruction (nothing is payable on a hyvityslasku — no due date either).
  const isCreditNote = d.typeCode === 'INV02';
  // C-1 (D-C1-3): a quote (tarjous) renders with a validity line and NO due
  // date, viitenumero, or payment block — nothing is owed on a tarjous. The
  // TARJOUS typeCode is internal-only (never Finvoice XML).
  const isQuote = d.typeCode === 'TARJOUS';
  const needsPayment = !isCreditNote && !isQuote;

  if (!isNonEmptyString(seller.name)) errors.push('seller name is required on the invoice PDF');
  if (!isNonEmptyString(buyer.name)) errors.push('buyer name is required on the invoice PDF');
  if (!isNonEmptyString(d.invoiceNumber)) errors.push('invoice number is required on the invoice PDF');
  if (!isNonEmptyString(d.invoiceDate)) errors.push('invoice date is required on the invoice PDF');
  if (needsPayment && !isNonEmptyString(d.dueDate)) errors.push('due date is required on the invoice PDF');
  if (isCreditNote && !isNonEmptyString(d.originalInvoiceNumber)) errors.push('the original invoice number is required on a credit note PDF');
  if (isQuote && !isNonEmptyString(d.validUntil)) errors.push('a validity date is required on a quote PDF');
  if (!rows.length) errors.push('at least one invoice line is required on the invoice PDF');
  rows.forEach((r, i) => {
    if (!isNonEmptyString(r.articleName)) errors.push(`line ${i + 1}: description is required on the invoice PDF`);
    if (!Number.isFinite(Number(r.deliveredQuantity))) errors.push(`line ${i + 1}: quantity is required on the invoice PDF`);
    if (!Number.isFinite(Number(r.unitPriceAmount))) errors.push(`line ${i + 1}: unit price is required on the invoice PDF`);
  });
  if (!Number.isFinite(Number(d.total))) errors.push('invoice total is required on the invoice PDF');
  // ALV boundary (FI-13 13.4): an EXEMPT invoice must carry its AVL 3 § note; an
  // ALV invoice must carry coherent per-line VAT + a VAT total. The old Phase-1
  // refusal of any non-exempt invoice is lifted — the ALV lane is now open, and
  // buildInvoice/buildFinvoice already produce the VAT rows this renders.
  const alvExempt = d.alvExempt === true;
  if (alvExempt) {
    if (!isNonEmptyString(d.exemptionNote)) errors.push('the AVL 3 § exemption note is required on an ALV-exempt invoice PDF');
  } else {
    const missingNum = (v) => v === null || v === undefined || !Number.isFinite(Number(v));
    if (missingNum(d.vatTotal)) errors.push('a VAT total is required on an ALV invoice PDF');
    if (missingNum(d.subtotal)) errors.push('a taxable (net) subtotal is required on an ALV invoice PDF');
    rows.forEach((r, i) => {
      if (missingNum(r.rowVatRatePercent)) errors.push(`line ${i + 1}: a VAT rate is required on an ALV invoice PDF`);
      if (missingNum(r.rowVatAmount)) errors.push(`line ${i + 1}: a VAT amount is required on an ALV invoice PDF`);
    });
  }
  if (needsPayment && !isNonEmptyString(pay.iban)) errors.push('payment IBAN is required on the invoice PDF');
  if (needsPayment && !isNonEmptyString(String(pay.referenceNumber ?? ''))) errors.push('viitenumero is required on the invoice PDF');
  if (needsPayment && !Number.isFinite(Number(pay.amountToPay))) errors.push('amount to pay is required on the invoice PDF');

  if (errors.length) return { ok: false, errors, model: null };

  const currency = d.currency || 'EUR';
  const sign = isCreditNote ? -1 : 1;
  // G11: composable only on a payable invoice with an FI IBAN; null omits
  // the row (a convenience string never blocks a statutory-valid invoice).
  const virtualBarcode = needsPayment
    ? buildVirtualBarcode({
        iban: pay.iban,
        amountToPay: pay.amountToPay,
        referenceNumber: pay.referenceNumber,
        dueDate: pay.dueDate || d.dueDate
      })
    : null;
  const model = {
    title: isCreditNote ? 'HYVITYSLASKU' : (isQuote ? 'TARJOUS' : 'LASKU'),
    buyerLabel: isQuote ? 'Vastaanottaja' : 'Laskutettava',
    seller: {
      name: clean(seller.name),
      businessId: clean(seller.businessId) || null,
      address: clean(seller.address) || null
    },
    buyer: {
      name: clean(buyer.name),
      businessId: clean(buyer.businessId) || null,
      address: clean(buyer.address) || null
    },
    meta: isCreditNote
      ? [
          { label: 'Hyvityslaskun numero', value: clean(d.invoiceNumber) },
          { label: 'Hyvityslasku laskulle', value: clean(d.originalInvoiceNumber) },
          { label: 'Päiväys', value: fiDate(d.invoiceDate) }
        ]
      : isQuote
        ? [
            { label: 'Tarjouksen numero', value: clean(d.invoiceNumber) },
            { label: 'Päiväys', value: fiDate(d.invoiceDate) },
            { label: 'Voimassa asti', value: fiDate(d.validUntil) }
          ]
        : [
            { label: 'Laskun numero', value: clean(d.invoiceNumber) },
            { label: 'Laskun päiväys', value: fiDate(d.invoiceDate) },
            { label: 'Eräpäivä', value: fiDate(d.dueDate) },
            { label: 'Viitenumero', value: String(pay.referenceNumber) }
          ],
    lines: rows.map((r) => ({
      description: clean(r.articleName),
      quantity: fiQuantity(r.deliveredQuantity),
      unitPrice: fiMoney(sign * r.unitPriceAmount),
      amount: fiMoney(sign * r.rowAmount)
    })),
    // A non-exempt invoice shows the statutory VAT breakdown (AVL 209 e §): the
    // taxable net subtotal, the VAT amount per rate, then the gross total. An
    // exempt invoice keeps the single total + the exemption note (unchanged).
    totals: alvExempt
      ? [{ label: 'Yhteensä', value: `${fiMoney(sign * d.total)} ${currency}`, bold: true }]
      : [
          { label: 'Veroton yhteensä', value: `${fiMoney(sign * d.subtotal)} ${currency}` },
          ...vatBreakdownRows(rows).map((g) => ({
            label: `ALV ${fiRate(g.rate)} %`,
            value: `${fiMoney(sign * g.vat)} ${currency}`
          })),
          { label: 'Yhteensä', value: `${fiMoney(sign * d.total)} ${currency}`, bold: true }
        ],
    exemptionNote: clean(d.exemptionNote),
    virtualBarcode,
    payment: (isCreditNote || isQuote)
      ? []
      : [
          { label: 'Saaja', value: clean(seller.name) },
          { label: 'IBAN', value: groupIban(pay.iban) },
          ...(isNonEmptyString(pay.bic) ? [{ label: 'BIC', value: clean(pay.bic) }] : []),
          { label: 'Viitenumero', value: String(pay.referenceNumber) },
          { label: 'Summa', value: `${fiMoney(pay.amountToPay)} ${currency}` },
          { label: 'Eräpäivä', value: fiDate(pay.dueDate || d.dueDate) },
          ...(virtualBarcode ? [{ label: 'Virtuaaliviivakoodi', value: virtualBarcode }] : [])
        ]
  };
  return { ok: true, errors: [], model };
};

// ---------------------------------------------------------------------------------
// renderInvoicePdf — the model drawn onto A4 with pdf-lib. Never throws on bad
// input; returns { ok, errors, bytes } (bytes: Uint8Array).
// ---------------------------------------------------------------------------------
// Helvetica encodes WinAnsi — ä/ö/€ are all in CP1252, so the Finnish copy needs
// no font embedding (the financialReportExport.js pattern).
const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait, points.
const MARGIN = 56;
const LINE = 16;

export const renderInvoicePdf = async ({ finvoice } = {}) => {
  const built = buildInvoicePdfModel({ finvoice });
  if (!built.ok) return { ok: false, errors: built.errors, bytes: null };
  const m = built.model;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.4, 0.43, 0.49);
  const ruleColor = rgb(0.85, 0.87, 0.9);

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  const rightX = PAGE.width - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  };
  const ensure = (needed = LINE) => {
    if (y - needed < MARGIN) newPage();
  };
  const text = (value, { x = MARGIN, size = 10, useFont = font, color = ink } = {}) => {
    page.drawText(String(value ?? ''), { x, y, size, font: useFont, color });
  };
  const rightText = (value, { size = 10, useFont = font, color = ink } = {}) => {
    const s = String(value ?? '');
    const w = useFont.widthOfTextAtSize(s, size);
    page.drawText(s, { x: rightX - w, y, size, font: useFont, color });
  };
  const rule = () => {
    ensure(6);
    page.drawLine({ start: { x: MARGIN, y: y + 10 }, end: { x: rightX, y: y + 10 }, thickness: 0.6, color: ruleColor });
  };

  // Header: seller block (left) + LASKU + meta (right).
  text(m.seller.name, { size: 14, useFont: bold });
  rightText(m.title, { size: 18, useFont: bold });
  y -= LINE * 1.2;
  if (m.seller.businessId) {
    text(`Y-tunnus ${m.seller.businessId}`, { size: 9, color: muted });
    y -= LINE * 0.9;
  }
  if (m.seller.address) {
    text(m.seller.address, { size: 9, color: muted });
    y -= LINE * 0.9;
  }
  y -= LINE * 0.4;
  for (const row of m.meta) {
    ensure();
    text(row.label, { size: 10, color: muted });
    rightText(row.value, { size: 10, useFont: bold });
    y -= LINE;
  }
  y -= LINE * 0.6;

  // Buyer block.
  ensure(LINE * 3);
  text(m.buyerLabel || 'Laskutettava', { size: 9, color: muted });
  y -= LINE * 0.9;
  text(m.buyer.name, { size: 11, useFont: bold });
  y -= LINE;
  if (m.buyer.businessId) {
    text(`Y-tunnus ${m.buyer.businessId}`, { size: 9, color: muted });
    y -= LINE * 0.9;
  }
  if (m.buyer.address) {
    text(m.buyer.address, { size: 9, color: muted });
    y -= LINE * 0.9;
  }
  y -= LINE * 0.8;

  // Line table.
  const cols = { qty: rightX - 220, unit: rightX - 120, amount: rightX };
  const colRight = (value, atX, opts = {}) => {
    const s = String(value ?? '');
    const useFont = opts.useFont || font;
    const size = opts.size || 10;
    const w = useFont.widthOfTextAtSize(s, size);
    page.drawText(s, { x: atX - w, y, size, font: useFont, color: opts.color || ink });
  };
  ensure(LINE * 2);
  text('Kuvaus', { size: 9, color: muted });
  colRight('Määrä', cols.qty, { size: 9, color: muted });
  colRight('à-hinta', cols.unit, { size: 9, color: muted });
  colRight('Yhteensä', cols.amount, { size: 9, color: muted });
  y -= LINE;
  rule();
  for (const line of m.lines) {
    ensure();
    text(line.description, { size: 10 });
    colRight(line.quantity, cols.qty);
    colRight(line.unitPrice, cols.unit);
    colRight(line.amount, cols.amount);
    y -= LINE;
  }
  rule();
  for (const total of m.totals) {
    ensure();
    text(total.label, { size: 11, useFont: total.bold ? bold : font });
    rightText(total.value, { size: 11, useFont: total.bold ? bold : font });
    y -= LINE;
  }
  y -= LINE * 0.4;

  // Statutory exemption note (AVL 3 §) — always present in this lane.
  ensure(LINE);
  text(m.exemptionNote, { size: 9, color: muted });
  y -= LINE * 1.6;

  // Payment block — absent on a credit note (nothing is payable).
  if (m.payment.length) {
    ensure(LINE * (m.payment.length + 2));
    text('Maksutiedot', { size: 11, useFont: bold });
    y -= LINE;
    rule();
    for (const row of m.payment) {
      ensure();
      text(row.label, { size: 10, color: muted });
      rightText(row.value, { size: 10, useFont: bold });
      y -= LINE;
    }
  }

  const bytes = await pdf.save();
  return { ok: true, errors: [], bytes };
};

// A filesystem-safe attachment name for the invoice PDF.
export const invoicePdfFilename = (invoiceNumber) =>
  `lasku-${String(invoiceNumber ?? '').replace(/[^0-9A-Za-z_-]/g, '_') || 'x'}.pdf`;

// ---------------------------------------------------------------------------------
// transmitInvoicePdfEmail — the B2C transmit channel. I/O fully injected.
// ---------------------------------------------------------------------------------
// Refusals (typed, thrown — a refused transmit must not look like a soft error;
// the transmitFinvoiceEmail contract):
//   • INVOICE_PDF_TRANSMIT_AUTHORITY_REQUIRED — no authorityBasis/actorId.
//   • INVOICE_PDF_TRANSMIT_NO_TRANSPORT / _NO_RECIPIENT — wiring errors.
//   • INVOICE_PDF_TRANSMIT_NOT_RENDERABLE — the persisted model refuses to render.
// Returns { receipt } with channel/format, actor, authority basis, and the model
// id when one drafted the invoice (the model id is part of the receipt).
export const transmitInvoicePdfEmail = async ({
  finvoice,
  to,
  subject = null,
  bodyText = null,
  authorityBasis = null,
  actorId = null,
  model = null,
  now = () => new Date().toISOString(),
  sendEmail
} = {}) => {
  if (!authorityBasis || !authorityBasis.source || !actorId) {
    const error = new Error('Invoice PDF transmit requires an authority basis (the owner\'s instruction receipt) and an actor id.');
    error.code = 'INVOICE_PDF_TRANSMIT_AUTHORITY_REQUIRED';
    throw error;
  }
  if (typeof sendEmail !== 'function') {
    const error = new Error('Invoice PDF email transmit requires an injected sendEmail transport.');
    error.code = 'INVOICE_PDF_TRANSMIT_NO_TRANSPORT';
    throw error;
  }
  const recipient = clean(to);
  if (!isEmail(recipient)) {
    const error = new Error('Invoice PDF email transmit requires a valid recipient email address.');
    error.code = 'INVOICE_PDF_TRANSMIT_NO_RECIPIENT';
    throw error;
  }

  const rendered = await renderInvoicePdf({ finvoice });
  if (!rendered.ok) {
    const error = new Error(`Invoice PDF does not render: ${rendered.errors.join('; ')}`);
    error.code = 'INVOICE_PDF_TRANSMIT_NOT_RENDERABLE';
    error.errors = rendered.errors;
    throw error;
  }

  const f = finvoice && finvoice.schema ? finvoice : finvoice?.finvoice;
  const invoiceNumber = f?.invoiceDetails?.invoiceNumber || null;
  const typeCode = f?.invoiceDetails?.typeCode || null;
  const artifactLabel = typeCode === 'INV02' ? 'Hyvityslasku' : (typeCode === 'TARJOUS' ? 'Tarjous' : 'Lasku');
  // C-1: a tarjous attachment must not be named lasku-*; invoice/credit-note
  // filenames stay byte-identical to before.
  const filename = typeCode === 'TARJOUS'
    ? `tarjous-${String(invoiceNumber ?? '').replace(/[^0-9A-Za-z_-]/g, '_') || 'x'}.pdf`
    : invoicePdfFilename(invoiceNumber);

  const sendResult = await sendEmail({
    to: recipient,
    subject: subject || `${artifactLabel} ${invoiceNumber}`,
    text: bodyText || `Liitteenä ${artifactLabel.toLowerCase()} ${invoiceNumber} (PDF).`,
    // Buffer, not Uint8Array: resendClient base64-encodes Buffers; a raw
    // Uint8Array would fall to the String() branch and corrupt the bytes.
    attachments: [{ filename, content: Buffer.from(rendered.bytes), contentType: 'application/pdf' }]
  });

  return {
    receipt: {
      channel: 'email',
      format: 'pdf',
      to: recipient,
      invoice_number: invoiceNumber,
      transmitted_at: now(),
      provider_result: sendResult ?? null,
      authority_basis: authorityBasis,
      actor_id: actorId,
      model: model || null
    }
  };
};
