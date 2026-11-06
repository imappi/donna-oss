// FI-9 (receive-side, verkkolasku) — the INBOUND structured e-invoice parse
// compute-half. Symmetric to FI-10's issue side (`verkkolasku.js` buildFinvoice):
// where FI-10 assembles an outbound Finvoice model from our own invoice, FI-9 reads
// an inbound Finvoice 3.0 or EN16931 (UBL) e-invoice XML and NORMALISES it into the
// same structured model, so the two sides share one shape.
//
// This is pure compute. It parses + validates + normalises; it does NOT post an AP
// journal to the ledger, transmit anything, or reach a live e-invoice operator inbox
// — receiving media and posting the resulting supplier bill cross into the isolation
// list (🔴, Kari go). No ledger post, no isolation-listed import. Dependency-free XML
// parse (the sandbox has no XML library, and an inbound e-invoice is untrusted data a
// bounded reader is the honest tool for).
//
// Trust-the-strong-LLM: this is the KEEP layer, not intelligence. It does NOT try to
// guess a vendor, a category, or a match — a strong model does that downstream from
// the normalised fields. What lives here is only arithmetic/format invariants:
//   • the totals must foot (row net sum == subtotal, row VAT sum == VAT total,
//     subtotal + VAT == grand total) — an inbound invoice whose numbers don't add up
//     is surfaced, never silently accepted (mirrors buildInvoice's subtotal+alv==total);
//   • the IBAN (ISO 13616 mod-97), the viitenumero (7-3-1 check digit) and the seller
//     Y-tunnus check digit — validated with the SAME functions the issue side uses
//     (reuse, not a second implementation).
//
// Two-terminal-states: `receiveEInvoice` returns exactly `terminal: 'proposal'` (the
// invoice parsed and its numbers foot → a normalised inbound supplier-bill proposal a
// human/AP path reviews) OR `terminal: 'escalate'` (unparseable, unrecognised, or the
// numbers don't add up → surfaced with an owner-facing question). There is no third
// resting state — a bad e-invoice is never dropped on the floor.
//
// Full arc: docs/design-donna-finland-standalone.md (FI-9; issue side is FI-10).

import { isValidIban, isValidBusinessId, isValidFinnishReferenceNumber } from './verkkolasku.js';
import { parseXml } from '../xmlReader.js';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// A number as it appears in an e-invoice: strings, possibly with a Finnish decimal
// comma or thousands spaces. Returns a finite number or null (never NaN downstream).
const num = (v) => {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/\s+/g, '');
  // If there's a comma and no dot, treat the comma as the decimal separator.
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else s = s.replace(/,/g, ''); // otherwise commas are thousands separators
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Finvoice dates are Format="CCYYMMDD" (e.g. 20260709); UBL dates are already ISO
// (2026-07-09). Normalise both to ISO; pass anything else through untouched.
const normDate = (v) => {
  const s = String(v ?? '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s || null;
};

// Tree navigation helpers (by local name, so prefix-agnostic across Finvoice/UBL).
const kids = (node, local) => (node?.children || []).filter((c) => c.localName === local);
const kid = (node, local) => kids(node, local)[0] || null;
const txt = (node) => (node ? String(node.text || '').trim() : '');
// Follow a path of local names (first match at each level). Returns node or null.
const path = (node, ...locals) => locals.reduce((n, l) => (n ? kid(n, l) : null), node);
const pathTxt = (node, ...locals) => txt(path(node, ...locals));

// ---------------------------------------------------------------------------------
// Format detection.
// ---------------------------------------------------------------------------------
export const detectEInvoiceFormat = (root) => {
  if (!root || !root.localName) return null;
  if (root.localName === 'Finvoice') return 'finvoice';
  // EN16931 is carried in a UBL 2.1 <Invoice> root.
  if (root.localName === 'Invoice') return 'en16931-ubl';
  return null;
};

// ---------------------------------------------------------------------------------
// Finvoice 3.0 → normalised model.
// ---------------------------------------------------------------------------------
const normalizeFinvoice = (root) => {
  const sellerD = kid(root, 'SellerPartyDetails');
  const buyerD = kid(root, 'BuyerPartyDetails');
  const invD = kid(root, 'InvoiceDetails');
  const epi = kid(root, 'EpiDetails');
  const epiBenef = path(epi, 'EpiPartyDetails', 'EpiBeneficiaryPartyDetails');
  const epiInstr = path(epi, 'EpiPaymentInstructionDetails');

  const currency =
    (invD && kid(invD, 'InvoiceTotalVatIncludedAmount')?.attrs?.AmountCurrencyIdentifier) || 'EUR';
  // The payment reference (viitenumero) lives in the EPI remittance block; it is the
  // same value the invoice header carries as its payment reference.
  const viite = pathTxt(epiInstr, 'EpiRemittanceInfoIdentifier') || null;

  const rows = kids(root, 'InvoiceRow').map((r, idx) => ({
    rowPosition: idx + 1,
    articleName: pathTxt(r, 'ArticleName') || null,
    deliveredQuantity: num(pathTxt(r, 'DeliveredQuantity')),
    unitPriceAmount: num(pathTxt(r, 'UnitPriceAmount')),
    rowVatRatePercent: num(pathTxt(r, 'RowVatRatePercent')) ?? 0,
    rowVatAmount: round2(num(pathTxt(r, 'RowVatAmount')) ?? 0),
    // Finvoice net can appear as RowVatExcludedAmount or RowAmount.
    rowAmount: round2(num(pathTxt(r, 'RowVatExcludedAmount')) ?? num(pathTxt(r, 'RowAmount')) ?? 0)
  }));

  return {
    schema: 'finvoice-3.0',
    sellerParty: {
      name: pathTxt(sellerD, 'SellerOrganisationName') || null,
      businessId: pathTxt(sellerD, 'SellerPartyIdentifier') || null,
      address: pathTxt(sellerD, 'SellerPostalAddressDetails', 'SellerStreetName') || null
    },
    buyerParty: {
      name: pathTxt(buyerD, 'BuyerOrganisationName') || null,
      businessId: pathTxt(buyerD, 'BuyerPartyIdentifier') || null,
      address: pathTxt(buyerD, 'BuyerPostalAddressDetails', 'BuyerStreetName') || null
    },
    invoiceDetails: {
      invoiceNumber: pathTxt(invD, 'InvoiceNumber') || null,
      invoiceDate: normDate(pathTxt(invD, 'InvoiceDate')),
      dueDate: normDate(pathTxt(invD, 'PaymentTermsDetails', 'InvoiceDueDate')),
      currency,
      referenceNumber: viite,
      subtotal: round2(num(pathTxt(invD, 'InvoiceTotalVatExcludedAmount')) ?? 0),
      vatTotal: round2(num(pathTxt(invD, 'InvoiceTotalVatAmount')) ?? 0),
      total: round2(num(pathTxt(invD, 'InvoiceTotalVatIncludedAmount')) ?? 0),
      // G-8: a hyvityslasku arrives as INV02 with negative amounts and an
      // OriginalInvoiceNumber reference — carried through so the issue/receive
      // pair stays symmetric (and FI-9's AP side can see what it received).
      typeCode: pathTxt(invD, 'InvoiceTypeCode') || null,
      originalInvoiceNumber: pathTxt(invD, 'OriginalInvoiceNumber') || null
    },
    rows,
    paymentDetails: {
      iban: pathTxt(epiBenef, 'EpiAccountID') || null,
      bic: pathTxt(epiBenef, 'EpiBfiIdentifier') || null,
      referenceNumber: viite,
      amountToPay: num(pathTxt(epiInstr, 'EpiInstructedAmount')),
      dueDate: normDate(pathTxt(epiInstr, 'EpiDateOptionDate'))
    }
  };
};

// ---------------------------------------------------------------------------------
// EN16931 (UBL 2.1 Invoice) → normalised model.
// ---------------------------------------------------------------------------------
const ublParty = (partyWrapper) => {
  const party = kid(partyWrapper, 'Party');
  return {
    name: pathTxt(party, 'PartyName', 'Name') || pathTxt(party, 'PartyLegalEntity', 'RegistrationName') || null,
    businessId: pathTxt(party, 'PartyLegalEntity', 'CompanyID') || null,
    address: pathTxt(party, 'PostalAddress', 'StreetName') || null
  };
};

const normalizeUbl = (root) => {
  const legalTotal = kid(root, 'LegalMonetaryTotal');
  const taxTotal = kid(root, 'TaxTotal');
  const payMeans = kid(root, 'PaymentMeans');
  const payeeAcct = path(payMeans, 'PayeeFinancialAccount');

  const rows = kids(root, 'InvoiceLine').map((r, idx) => ({
    rowPosition: idx + 1,
    articleName: pathTxt(r, 'Item', 'Name') || null,
    deliveredQuantity: num(pathTxt(r, 'InvoicedQuantity')),
    unitPriceAmount: num(pathTxt(r, 'Price', 'PriceAmount')),
    rowVatRatePercent: num(pathTxt(r, 'Item', 'ClassifiedTaxCategory', 'Percent')) ?? 0,
    rowVatAmount: round2(num(pathTxt(r, 'TaxTotal', 'TaxAmount')) ?? 0),
    rowAmount: round2(num(pathTxt(r, 'LineExtensionAmount')) ?? 0)
  }));

  return {
    schema: 'en16931-ubl',
    sellerParty: ublParty(kid(root, 'AccountingSupplierParty')),
    buyerParty: ublParty(kid(root, 'AccountingCustomerParty')),
    invoiceDetails: {
      invoiceNumber: pathTxt(root, 'ID') || null,
      invoiceDate: normDate(pathTxt(root, 'IssueDate')),
      dueDate: normDate(pathTxt(root, 'DueDate')),
      currency: pathTxt(root, 'DocumentCurrencyCode') || 'EUR',
      referenceNumber: pathTxt(payMeans, 'PaymentID') || null,
      subtotal: round2(num(pathTxt(legalTotal, 'TaxExclusiveAmount')) ?? 0),
      vatTotal: round2(num(pathTxt(taxTotal, 'TaxAmount')) ?? 0),
      total: round2(num(pathTxt(legalTotal, 'TaxInclusiveAmount')) ?? num(pathTxt(legalTotal, 'PayableAmount')) ?? 0)
    },
    rows,
    paymentDetails: {
      iban: pathTxt(payeeAcct, 'ID') || null,
      bic: pathTxt(payeeAcct, 'FinancialInstitutionBranch', 'FinancialInstitution', 'ID') || null,
      referenceNumber: pathTxt(payMeans, 'PaymentID') || null,
      amountToPay: num(pathTxt(legalTotal, 'PayableAmount')),
      dueDate: normDate(pathTxt(root, 'DueDate'))
    }
  };
};

// ---------------------------------------------------------------------------------
// KEEP-layer validation of a normalised inbound e-invoice.
// ---------------------------------------------------------------------------------
// `errors` are hard/structural/arithmetic failures that force an ESCALATE (we can't
// trust the numbers enough to propose an AP entry). `warnings` are surfaced-but-not-
// blocking data problems on optional fields the SENDER controls (a dubious IBAN or
// check digit rides along on the proposal for a human to eyeball). Nothing silent.
export const validateReceivedInvoice = (model) => {
  const errors = [];
  const warnings = [];
  if (!model || typeof model !== 'object') {
    return { errors: ['e-invoice did not normalise to a model'], warnings };
  }
  const d = model.invoiceDetails || {};
  const rows = Array.isArray(model.rows) ? model.rows : [];

  if (!isNonEmptyString(d.invoiceNumber)) errors.push('invoice number is missing');
  if (rows.length === 0) errors.push('e-invoice carries no invoice rows');

  // Totals must foot (arithmetic KEEP-layer, mirrors buildInvoice's subtotal+alv==total).
  const subtotal = round2(Number(d.subtotal) || 0);
  const vatTotal = round2(Number(d.vatTotal) || 0);
  const total = round2(Number(d.total) || 0);
  if (total !== 0 && round2(subtotal + vatTotal) !== total) {
    errors.push(`amount_mismatch: subtotal (${subtotal}) + VAT (${vatTotal}) != total (${total})`);
  }
  // Per-row sums vs header (only when every row carries its own net/VAT — otherwise we
  // can't verify and don't invent a failure).
  if (rows.length && rows.every((r) => Number.isFinite(Number(r.rowAmount)))) {
    const rowNet = round2(rows.reduce((s, r) => s + (Number(r.rowAmount) || 0), 0));
    if (subtotal !== 0 && rowNet !== subtotal) {
      errors.push(`amount_mismatch: row net sum (${rowNet}) != subtotal (${subtotal})`);
    }
  }
  if (rows.length && rows.every((r) => Number.isFinite(Number(r.rowVatAmount)))) {
    const rowVat = round2(rows.reduce((s, r) => s + (Number(r.rowVatAmount) || 0), 0));
    if (vatTotal !== 0 && rowVat !== vatTotal) {
      errors.push(`amount_mismatch: row VAT sum (${rowVat}) != VAT total (${vatTotal})`);
    }
  }

  // Format/check-digit invariants on optional fields (reuse the issue-side validators).
  const iban = model.paymentDetails?.iban;
  if (isNonEmptyString(iban) && !isValidIban(iban)) warnings.push('payment IBAN failed the ISO 13616 check');
  const ref = model.paymentDetails?.referenceNumber;
  if (isNonEmptyString(ref) && !isValidFinnishReferenceNumber(ref)) warnings.push('payment reference failed the viitenumero check digit');
  const sellerBiz = model.sellerParty?.businessId;
  if (isNonEmptyString(sellerBiz) && !isValidBusinessId(sellerBiz)) warnings.push('seller businessId is not a valid Y-tunnus');
  const buyerBiz = model.buyerParty?.businessId;
  if (isNonEmptyString(buyerBiz) && !isValidBusinessId(buyerBiz)) warnings.push('buyer businessId is not a valid Y-tunnus');

  return { errors, warnings };
};

// ---------------------------------------------------------------------------------
// receiveEInvoice — the two-terminal-states entry point.
// ---------------------------------------------------------------------------------
// Input: { xml }. Returns exactly one of:
//   { ok: true,  format, terminal: 'proposal', proposal: { source, format, invoice, warnings }, invoice, warnings }
//   { ok: false, format, terminal: 'escalate', escalation: { reason, question, details }, warnings, invoice: null }
export const receiveEInvoice = ({ xml } = {}) => {
  const escalate = (reason, question, format = null, details = null, warnings = []) => ({
    ok: false, format, terminal: 'escalate', escalation: { reason, question, details }, warnings, invoice: null
  });

  if (!isNonEmptyString(xml)) {
    return escalate('empty_input', 'We received an empty e-invoice — can you re-send the file?');
  }
  let root;
  try {
    root = parseXml(xml);
  } catch (err) {
    return escalate('parse_error', 'This e-invoice file could not be read as valid XML — can you re-send it?', null, err?.code || String(err?.message || err));
  }
  const format = detectEInvoiceFormat(root);
  if (!format) {
    return escalate('unrecognized_format', 'This does not look like a Finvoice or EN16931 e-invoice — is it the right file?', null, { rootElement: root.localName });
  }
  let model;
  try {
    model = format === 'finvoice' ? normalizeFinvoice(root) : normalizeUbl(root);
  } catch (err) {
    return escalate('normalize_error', 'We could not read the invoice fields out of this e-invoice — can you check the file?', format, String(err?.message || err));
  }

  const { errors, warnings } = validateReceivedInvoice(model);
  if (errors.length) {
    const supplier = model.sellerParty?.name ? ` from ${model.sellerParty.name}` : '';
    return escalate(
      'amount_or_structure_mismatch',
      `The numbers on this e-invoice${supplier} don't add up (${errors[0]}). Can you check the invoice before we book it?`,
      format,
      { errors },
      warnings
    );
  }

  return {
    ok: true,
    format,
    terminal: 'proposal',
    proposal: { source: 'e_invoice_receive', format, invoice: model, warnings },
    invoice: model,
    warnings
  };
};

// ---------------------------------------------------------------------------------
// FI-9 (R) — the receive LANE: sniff + writer-shape mapping for the parse worker.
// ---------------------------------------------------------------------------------
// Design: docs/design-donna-finland-fi9-receive-and-ap-post.md §R. Everything here
// is pure so the isolation-listed worker branch (inngest/parseDocument.js) stays a
// thin call: flag check → receiveEInvoiceDocument(bytes) → dispatch on `lane`.
//
// The lane COMMITS only once the format is recognised: a file that fails the cheap
// sniff, is not XML, or has an unrecognised root falls through as `not_einvoice`
// and the worker continues byte-identically (vision extractor / skipped). Only a
// RECOGNISED e-invoice that then fails normalisation or footing is an `escalate`
// — that one is real and goes to the owner, never a silent drop.

// A rollout gate for this lane is a config-plane flag (clientFlagActs,
// envFallback false) — never an env pair. Declared here so the worker and the
// WhatsApp hook read the same key.
export const FINLAND_EINVOICE_RECEIVE_FLAG_KEY = 'FINLAND_EINVOICE_RECEIVE';

// Untrusted-input ceiling. Real e-invoices are tens of KBs; a multi-megabyte
// "XML" is either not an e-invoice or abuse — either way the bounded reader
// never sees it. 2 MB is deliberately generous (large embedded row sets).
export const EINVOICE_XML_MAX_BYTES = 2 * 1024 * 1024;

// How much of the head we inspect for root-element tokens. Root tags appear
// within the first few hundred bytes after the XML declaration/comments.
const SNIFF_HEAD_BYTES = 4096;

// Cheap content prefilter — no parse, no allocation beyond the head slice.
// Extension and MIME are deliberately ignored (WhatsApp MIME is unreliable;
// content is the only honest signal). Aligned with detectEInvoiceFormat:
// a <Finvoice> root, or a UBL <Invoice> root carrying the UBL invoice namespace.
export const sniffEInvoiceXml = (bytes) => {
  if (!bytes || !bytes.length || bytes.length > EINVOICE_XML_MAX_BYTES) return false;
  let head = '';
  try {
    head = Buffer.from(bytes.slice(0, SNIFF_HEAD_BYTES)).toString('utf8');
  } catch {
    return false;
  }
  // Strip BOM + leading whitespace; an XML document starts with '<'.
  const trimmed = head.replace(/^﻿/, '').replace(/^\s+/, '');
  if (!trimmed.startsWith('<')) return false;
  if (/<Finvoice[\s>]/.test(trimmed)) return true;
  if (/<(?:\w+:)?Invoice[\s>]/.test(trimmed) && trimmed.includes('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2')) return true;
  return false;
};

const capWarnings = (warnings) =>
  (Array.isArray(warnings) ? warnings : []).map((w) => String(w).slice(0, 200)).slice(0, 6);

// Normalised inbound model → the EXACT {header, summary, lines} writer shape the
// supplier-bill extractor emits (supplierBill.js mapExtractionToWriterShape), so
// writeParsedDocumentExtractionInDb and everything downstream of it — bill↔bank
// matching, auto-explain coding, close checks, the ask pipeline — engage with
// ZERO changes. extraction_confidence is 1 and extraction_status 'validated':
// this is structured data read deterministically, not OCR — and the
// summary.einvoice provenance block is the receipt saying so (no model ran).
export const mapEInvoiceToSupplierBillExtraction = ({ invoice = {}, format = null, warnings = [] } = {}) => {
  const d = invoice.invoiceDetails || {};
  const pay = invoice.paymentDetails || {};
  const seller = invoice.sellerParty || {};
  const buyer = invoice.buyerParty || {};

  const referenceNumber = pay.referenceNumber || d.referenceNumber || d.invoiceNumber || null;
  const header = {
    vendor_name: seller.name || null,
    // The firm is the buyer; a bill never carries its own name in customer_name
    // (same invariant as the supplier-bill extractor).
    customer_name: null,
    document_date: d.invoiceDate || null,
    due_date: d.dueDate || pay.dueDate || null,
    total_amount: Number.isFinite(Number(d.total)) ? round2(Number(d.total)) : null,
    currency: (d.currency || 'EUR').toUpperCase(),
    tax_amount: Number.isFinite(Number(d.vatTotal)) ? round2(Number(d.vatTotal)) : null,
    reference_number: referenceNumber,
    payment_status: 'unpaid',
    extraction_confidence: 1
  };

  const lines = (Array.isArray(invoice.rows) ? invoice.rows : []).map((row) => ({
    description: row.articleName == null ? null : String(row.articleName).slice(0, 500),
    quantity: Number.isFinite(Number(row.deliveredQuantity)) ? Number(row.deliveredQuantity) : null,
    unit_price: Number.isFinite(Number(row.unitPriceAmount)) ? Number(row.unitPriceAmount) : null,
    amount: Number.isFinite(Number(row.rowAmount)) ? round2(Number(row.rowAmount)) : null,
    tax_rate: Number.isFinite(Number(row.rowVatRatePercent)) ? Number(row.rowVatRatePercent) : null
  }));

  const references = [
    d.invoiceNumber ? { type: 'invoice_number', value: String(d.invoiceNumber).slice(0, 100) } : null,
    pay.referenceNumber ? { type: 'payment_reference', value: String(pay.referenceNumber).slice(0, 100) } : null
  ].filter(Boolean);

  const summary = {
    source: 'async_parse',
    document_type: 'supplier_bill',
    counterparty_name: header.vendor_name,
    counterparty_role: 'vendor',
    document_date: header.document_date,
    due_date: header.due_date,
    currency: header.currency,
    subtotal_amount: Number.isFinite(Number(d.subtotal)) ? round2(Number(d.subtotal)) : null,
    tax_amount: header.tax_amount,
    shipping_amount: null,
    discount_amount: null,
    rounding_amount: null,
    total_amount: header.total_amount,
    line_amounts_include_tax: false,
    references,
    payment_terms_phrase: null,
    payment_terms_days: null,
    line_count: lines.length,
    coded_line_count: 0,
    review_line_count: 0,
    extraction_status: 'validated',
    extraction_confidence: 1,
    warnings: capWarnings(warnings),
    // Provenance receipt for the deterministic lane: which format was read, the
    // check-digit identities that rode along, and the explicit "no model ran"
    // marker the worker keys its extractor receipt on.
    einvoice: {
      terminal: 'proposal',
      format,
      invoice_number: d.invoiceNumber || null,
      seller_business_id: seller.businessId || null,
      buyer_business_id: buyer.businessId || null,
      iban: pay.iban || null,
      bic: pay.bic || null,
      payment_reference: pay.referenceNumber || null
    }
  };

  return { header, summary, lines };
};

// Escalation reasons that mean "this is not actually an e-invoice" — the lane
// declines and the worker falls through byte-identically. Everything else
// (normalize_error, amount_or_structure_mismatch) means "this IS an e-invoice
// and it is wrong" — that one goes to the owner.
const NOT_EINVOICE_REASONS = new Set(['empty_input', 'parse_error', 'unrecognized_format']);

// The worker-facing lane entry point. Returns exactly one of:
//   { lane: 'not_einvoice', reason }
//   { lane: 'proposal', format, extraction: {header, summary, lines}, warnings }
//   { lane: 'escalate', format, escalation: {reason, question, details}, warnings, summary }
// The escalate summary is a parse_summary-ready block (persisted verdict) so the
// document row records WHY it went to the owner (render-the-persisted-verdict).
export const receiveEInvoiceDocument = ({ bytes } = {}) => {
  if (!sniffEInvoiceXml(bytes)) return { lane: 'not_einvoice', reason: 'sniff_declined' };
  const result = receiveEInvoice({ xml: Buffer.from(bytes).toString('utf8') });
  if (result.terminal === 'proposal') {
    return {
      lane: 'proposal',
      format: result.format,
      extraction: mapEInvoiceToSupplierBillExtraction({
        invoice: result.invoice,
        format: result.format,
        warnings: result.warnings
      }),
      warnings: result.warnings
    };
  }
  if (NOT_EINVOICE_REASONS.has(result.escalation?.reason)) {
    return { lane: 'not_einvoice', reason: result.escalation.reason };
  }
  return {
    lane: 'escalate',
    format: result.format,
    escalation: result.escalation,
    warnings: result.warnings,
    summary: {
      source: 'async_parse',
      document_type: 'supplier_bill',
      skipped_reason: 'einvoice_escalated',
      warnings: capWarnings(result.warnings),
      einvoice: {
        terminal: 'escalate',
        format: result.format,
        reason: result.escalation?.reason || null,
        question: result.escalation?.question || null,
        details: result.escalation?.details ?? null
      }
    }
  };
};
