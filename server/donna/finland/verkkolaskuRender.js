// FI-10 (issue-side, verkkolasku) — serialise the structured Finvoice model
// (`verkkolasku.js` buildFinvoice output) to Finvoice 3.0 XML. Pure compute + a
// KEEP-layer refusal. This is the additive render step: it turns the validated
// intermediate model into the wire XML a verkkolasku operator would accept. It does
// NOT transmit to an operator, email anything, or post an AR journal — transmit is
// I/O and the AR post crosses into the isolation list (🔴, Kari go). Dependency-free
// string serialisation (the tree carries no XML library).
//
// Scope boundary (honest): this renders the invoice SUBSTANCE our model carries —
// parties, invoice header + totals, rows, and the SEPA/EPI payment block — as a
// well-formed Finvoice 3.0 document. The transmission ENVELOPE a live send needs
// (MessageTransmissionDetails: routing identifiers + a message timestamp) is added by
// the transmit layer, not here: it is send-time I/O, it needs a clock (a pure render
// takes no wall-clock), and it is out of this additive slice. What this emits round-
// trips exactly through the FI-9 receive parser (`verkkolaskuReceive.js`) — that
// symmetry is the test.
//
// KEEP-layer: a render must not emit an e-invoice whose numbers disagree with
// themselves. Before serialising, re-assert the totals identity (row net/VAT sums ==
// header subtotal/VAT; subtotal + VAT == total) — the same arithmetic buildFinvoice
// guaranteed, checked again so a hand-built or mutated model can't serialise a lie.
//
// Full arc: docs/design-donna-finland-standalone.md §4.4 (FI-10). Receive side: FI-9.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// XML text escaping (the five predefined entities). Attribute and element text.
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// Monetary values render with exactly two decimals and a '.' separator (Finvoice
// amount format). Non-monetary numbers (quantity, VAT rate, unit price) render as
// their plain numeric string so an integer stays "2", not "2.00".
const money = (n) => (round2(Number(n) || 0)).toFixed(2);
const plain = (n) => String(Number(n));

// ISO (YYYY-MM-DD) → Finvoice Format="CCYYMMDD" (YYYYMMDD). Anything already 8 digits
// passes through; anything else we can't confidently reformat is emitted as-is (the
// receive parser is equally lenient), so a non-ISO date is never silently dropped.
const ccyymmdd = (v) => {
  const s = String(v ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return digits.slice(0, 8);
  if (/^\d{8}$/.test(s)) return s;
  return esc(s);
};

// A single element with optional attributes; omitted entirely when the value is null/
// empty (Finvoice prefers an absent element to an empty one).
const el = (indent, name, value, attrs = '') => {
  if (value == null || value === '') return '';
  return `${indent}<${name}${attrs}>${esc(value)}</${name}>\n`;
};
const amountEl = (indent, name, value, currency) =>
  `${indent}<${name} AmountCurrencyIdentifier="${esc(currency)}">${money(value)}</${name}>\n`;

// ---------------------------------------------------------------------------------
// KEEP-layer: the model's totals must foot before we serialise it.
// ---------------------------------------------------------------------------------
export const assertFinvoiceModelFoots = (finvoice) => {
  const errors = [];
  if (!finvoice || typeof finvoice !== 'object') return ['finvoice model is required'];
  const d = finvoice.invoiceDetails || {};
  const rows = Array.isArray(finvoice.rows) ? finvoice.rows : [];
  if (!isNonEmptyString(d.invoiceNumber)) errors.push('invoiceNumber is required');
  if (rows.length === 0) errors.push('at least one row is required');

  const subtotal = round2(Number(d.subtotal) || 0);
  const vatTotal = round2(Number(d.vatTotal) || 0);
  const total = round2(Number(d.total) || 0);
  if (round2(subtotal + vatTotal) !== total) {
    errors.push(`totals do not foot: subtotal (${subtotal}) + VAT (${vatTotal}) != total (${total})`);
  }
  const rowNet = round2(rows.reduce((s, r) => s + (Number(r.rowAmount) || 0), 0));
  const rowVat = round2(rows.reduce((s, r) => s + (Number(r.rowVatAmount) || 0), 0));
  if (rowNet !== subtotal) errors.push(`row net sum (${rowNet}) != subtotal (${subtotal})`);
  if (rowVat !== vatTotal) errors.push(`row VAT sum (${rowVat}) != VAT total (${vatTotal})`);
  return errors;
};

// ---------------------------------------------------------------------------------
// renderFinvoiceXml — the model → Finvoice 3.0 XML serialiser.
// ---------------------------------------------------------------------------------
// Accepts the `finvoice` model directly, OR a full buildFinvoice result ({ ok,
// finvoice }). Returns { ok, errors, xml }. Refuses (ok false, xml null) when the
// model does not foot — a render never emits an inconsistent invoice.
export const renderFinvoiceXml = (input) => {
  const finvoice = input && input.schema ? input : input?.finvoice;
  const errors = assertFinvoiceModelFoots(finvoice);
  if (errors.length) return { ok: false, errors, xml: null };

  const d = finvoice.invoiceDetails;
  const currency = d.currency || 'EUR';
  const seller = finvoice.sellerParty || {};
  const buyer = finvoice.buyerParty || {};
  const pay = finvoice.paymentDetails || {};
  const i2 = '  ';
  const i4 = '    ';
  const i6 = '      ';

  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<Finvoice Version="3.0">\n';

  // Seller party.
  x += `${i2}<SellerPartyDetails>\n`;
  x += el(i4, 'SellerPartyIdentifier', seller.businessId);
  x += el(i4, 'SellerOrganisationName', seller.name);
  if (isNonEmptyString(seller.address)) {
    x += `${i4}<SellerPostalAddressDetails>\n`;
    x += el(i6, 'SellerStreetName', seller.address);
    x += `${i4}</SellerPostalAddressDetails>\n`;
  }
  x += `${i2}</SellerPartyDetails>\n`;

  // Buyer party.
  x += `${i2}<BuyerPartyDetails>\n`;
  x += el(i4, 'BuyerPartyIdentifier', buyer.businessId);
  x += el(i4, 'BuyerOrganisationName', buyer.name);
  if (isNonEmptyString(buyer.address)) {
    x += `${i4}<BuyerPostalAddressDetails>\n`;
    x += el(i6, 'BuyerStreetName', buyer.address);
    x += `${i4}</BuyerPostalAddressDetails>\n`;
  }
  x += `${i2}</BuyerPartyDetails>\n`;

  // Invoice header + totals. G-8 (D-G8-4): a credit note (hyvityslasku) renders
  // as INV02 with NEGATIVE amounts and the OriginalInvoiceNumber reference —
  // the statutory Finvoice convention. The sign is presentation: the model
  // stays positive, the wire format carries the minus.
  const isCreditNote = d.typeCode === 'INV02';
  const sign = isCreditNote ? -1 : 1;
  x += `${i2}<InvoiceDetails>\n`;
  x += `${i4}<InvoiceTypeCode>${isCreditNote ? 'INV02' : 'INV01'}</InvoiceTypeCode>\n`;
  x += el(i4, 'InvoiceNumber', d.invoiceNumber);
  if (isCreditNote && isNonEmptyString(d.originalInvoiceNumber)) {
    x += el(i4, 'OriginalInvoiceNumber', d.originalInvoiceNumber);
  }
  if (isNonEmptyString(d.invoiceDate)) x += `${i4}<InvoiceDate Format="CCYYMMDD">${ccyymmdd(d.invoiceDate)}</InvoiceDate>\n`;
  x += amountEl(i4, 'InvoiceTotalVatExcludedAmount', sign * d.subtotal, currency);
  x += amountEl(i4, 'InvoiceTotalVatAmount', sign * d.vatTotal, currency);
  x += amountEl(i4, 'InvoiceTotalVatIncludedAmount', sign * d.total, currency);
  if (isNonEmptyString(d.dueDate)) {
    x += `${i4}<PaymentTermsDetails>\n`;
    x += `${i6}<InvoiceDueDate Format="CCYYMMDD">${ccyymmdd(d.dueDate)}</InvoiceDueDate>\n`;
    x += `${i4}</PaymentTermsDetails>\n`;
  }
  // A non-ALV toiminimi carries the AVL 3 § exemption note as free text.
  if (finvoice.invoiceDetails.alvExempt && isNonEmptyString(finvoice.invoiceDetails.exemptionNote)) {
    x += el(i4, 'InvoiceFreeText', finvoice.invoiceDetails.exemptionNote);
  }
  x += `${i2}</InvoiceDetails>\n`;

  // Rows. On INV02 the row amounts (and unit price, so qty × price still agrees
  // with the row net) carry the negative sign; quantities stay positive.
  for (const r of finvoice.rows) {
    x += `${i2}<InvoiceRow>\n`;
    x += el(i4, 'ArticleName', r.articleName);
    if (r.deliveredQuantity != null) x += `${i4}<DeliveredQuantity>${esc(plain(r.deliveredQuantity))}</DeliveredQuantity>\n`;
    if (r.unitPriceAmount != null) x += `${i4}<UnitPriceAmount>${esc(plain(sign * r.unitPriceAmount))}</UnitPriceAmount>\n`;
    x += `${i4}<RowVatRatePercent>${esc(plain(r.rowVatRatePercent || 0))}</RowVatRatePercent>\n`;
    x += `${i4}<RowVatExcludedAmount>${money(sign * r.rowAmount)}</RowVatExcludedAmount>\n`;
    x += `${i4}<RowVatAmount>${money(sign * r.rowVatAmount)}</RowVatAmount>\n`;
    x += `${i2}</InvoiceRow>\n`;
  }

  // EPI (SEPA) payment block.
  x += `${i2}<EpiDetails>\n`;
  x += `${i4}<EpiPartyDetails>\n`;
  x += `${i6}<EpiBeneficiaryPartyDetails>\n`;
  if (isNonEmptyString(pay.iban)) x += `${i6}  <EpiAccountID IdentificationSchemeName="IBAN">${esc(pay.iban)}</EpiAccountID>\n`;
  if (isNonEmptyString(pay.bic)) x += `${i6}  <EpiBfiIdentifier IdentificationSchemeName="BIC">${esc(pay.bic)}</EpiBfiIdentifier>\n`;
  x += `${i6}</EpiBeneficiaryPartyDetails>\n`;
  x += `${i4}</EpiPartyDetails>\n`;
  x += `${i4}<EpiPaymentInstructionDetails>\n`;
  if (isNonEmptyString(pay.referenceNumber)) x += `${i6}<EpiRemittanceInfoIdentifier IdentificationSchemeName="SPY">${esc(pay.referenceNumber)}</EpiRemittanceInfoIdentifier>\n`;
  // A credit note instructs no payment (nothing to pay on a hyvityslasku);
  // the EPI block keeps its structure with an honest zero.
  x += `${i6}<EpiInstructedAmount AmountCurrencyIdentifier="${esc(currency)}">${money(isCreditNote ? 0 : (pay.amountToPay != null ? pay.amountToPay : d.total))}</EpiInstructedAmount>\n`;
  if (isNonEmptyString(pay.dueDate)) x += `${i6}<EpiDateOptionDate Format="CCYYMMDD">${ccyymmdd(pay.dueDate)}</EpiDateOptionDate>\n`;
  x += `${i4}</EpiPaymentInstructionDetails>\n`;
  x += `${i2}</EpiDetails>\n`;

  x += '</Finvoice>\n';

  return { ok: true, errors: [], xml: x };
};
