// Sales invoice extraction — PR 7 of
// docs/invoice-receipt-parsing-plan.md. Parallel to supplierBill.js;
// reuses the same OpenAI Responses-API strict-mode JSON schema, same
// REFERENCE_TYPE_PRIORITY ordering, and the same normalizePaymentTerms
// helper (both exported from receipt.js / supplierBill.js).
//
// Incoming sales evidence includes sales invoices, receipts the firm
// issued, and processor/cash-deposit confirmations. Sales invoices look
// superficially identical to bills but with the firm and counterparty
// swapped. PR 7's failure mode is direction drift, not extractor accuracy:
//
//   - Supplier bill: vendor (supplier) → firm (buyer). Money OUT.
//     vendor_name = the supplier. customer_name = null.
//   - Sales invoice: firm (vendor) → customer (buyer). Money IN.
//     vendor_name = null (the firm IS the vendor; we don't write
//     the firm's own name onto its own invoice). customer_name = the
//     buyer.
//
// Three load-bearing flips vs the bill extractor (brief invariants 3+4+5):
//   1. vendor_name is ALWAYS null on the writer-shape header.
//   2. customer_name is populated from the LLM's counterparty_name.
//   3. counterparty_role is forced to 'customer' regardless of what
//      the LLM returns. If the LLM mistakenly emits 'vendor' (it
//      confused the direction), we coerce back to 'customer'.
//
// payment_status default is 'unpaid' — the customer hasn't paid at
// the moment the firm issued the invoice. Same contract as bills:
// confidently-identified states (paid / partial / unknown) round-trip
// unchanged; only un-enum-able values fall back to 'unpaid'.
//
// PII policy mirrors receipt.js / supplierBill.js: never log free-text
// extracted fields. Hash a correlation id from the filename; surface
// only counts + confidence bands in logs.

import crypto from 'node:crypto';
import { normalizeIsoOrDayFirstDate, normalizeIsoCurrency } from './parsePrimitives.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  REFERENCE_TYPE_PRIORITY
} from './receipt.js';
import { normalizePaymentTerms } from './supplierBill.js';
import { validateReceiptTotals } from './totalsValidation.js';
import { buildClientIdentityPromptFragment } from './clientIdentityPrompt.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { extractionFailureForStatus, readProviderError } from './inngest/parseErrors.js';

// Slice A of the LLM-trust downgrade plan (see CLAUDE.md +
// docs/donna-llm-trust-strategy.md). gpt-5.4 — not the nano — for the
// load-bearing extraction. The cost delta is dwarfed by the cost of a
// wrong direction call (e.g. a director-services bill silently
// extracted as a sales invoice). Env override stays available for
// per-deploy tuning.
const DEFAULT_MODEL = 'gpt-5.4';
// RT-12 (audit F-12): every extraction lane stamps its prompt version on
// the receipt. A string constant per module; bump when the prompt or the
// schema changes meaning.
export const SALES_INVOICE_PROMPT_VERSION = 'sales-invoice-extraction-v2';
const REQUEST_TIMEOUT_MS = 60_000;
const UNREADABLE_CONFIDENCE_FLOOR = 0.3;

// Issue #95: 'void' and 'credit_note' joined the vocabulary so the
// AR-aging dashboard doesn't pollute its overdue buckets with
// cancelled or reversed documents. Both round-trip through the
// extractor instead of being coerced back to the default.
const PAYMENT_STATUS_VALUES = ['paid', 'unpaid', 'partial', 'unknown', 'void', 'credit_note'];
const COUNTERPARTY_ROLE_VALUES = ['vendor', 'customer'];

const COUNTERPARTY_NAME_MAX = 200;
const REFERENCE_VALUE_MAX = 80;
const REFERENCE_LIST_MAX = 8;

let dotEnvCache = null;

const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // best-effort dotenv fallback
  }
  dotEnvCache = vars;
  return vars;
};

const getOpenAiConfig = () => {
  const dotEnv = readDotEnv();
  return {
    apiKey: process.env.OPENAI_API_KEY || dotEnv.OPENAI_API_KEY || '',
    model:
      process.env.INVOICE_EXTRACTOR_MODEL ||
      dotEnv.INVOICE_EXTRACTOR_MODEL ||
      process.env.OPENAI_MODEL ||
      dotEnv.OPENAI_MODEL ||
      DEFAULT_MODEL
  };
};

const outputTextFromResponse = (response = {}) => {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text;
    }
  }
  return '';
};

const trimBase64 = (value = '') => String(value || '').replace(/[\r\n\s]/g, '');

const filenameCorrelationId = (filename = '') =>
  crypto.createHash('sha256').update(String(filename || 'unknown')).digest('hex').slice(0, 12);

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const isoDate = normalizeIsoOrDayFirstDate;

const normalizeCurrency = normalizeIsoCurrency;

const normalizePaymentStatus = (value) => {
  const str = String(value || '').toLowerCase();
  return PAYMENT_STATUS_VALUES.includes(str) ? str : 'unpaid';
};

const sanitizeText = (value, maxLength) => {
  if (value == null) return null;
  const cleaned = String(value).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
};

// JSON schema for the OpenAI Responses-API strict mode. Identical
// shape to BILL_EXTRACTION_SCHEMA — the direction discriminator lives
// downstream of the LLM in `mapExtractionToWriterShape`.
const INVOICE_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'extraction_status',
    'extraction_confidence',
    'header',
    'lines',
    'warnings'
  ],
  properties: {
    extraction_status: { type: 'string', enum: ['validated', 'partial', 'failed'] },
    extraction_confidence: { type: 'number' },
    warnings: { type: 'array', items: { type: 'string' } },
    header: {
      type: 'object',
      additionalProperties: false,
      required: [
        'counterparty_name',
        'counterparty_role',
        'document_date',
        'due_date',
        'currency',
        'subtotal_amount',
        'tax_amount',
        'shipping_amount',
        'discount_amount',
        'rounding_amount',
        'total_amount',
        'line_amounts_include_tax',
        'reference_number',
        'references',
        'payment_status',
        'payment_terms_phrase'
      ],
      properties: {
        counterparty_name: { type: ['string', 'null'] },
        counterparty_role: { type: 'string', enum: COUNTERPARTY_ROLE_VALUES },
        document_date: { type: ['string', 'null'] },
        due_date: { type: ['string', 'null'] },
        currency: { type: ['string', 'null'] },
        subtotal_amount: { type: ['number', 'null'] },
        tax_amount: { type: ['number', 'null'] },
        shipping_amount: { type: ['number', 'null'] },
        discount_amount: { type: ['number', 'null'] },
        rounding_amount: { type: ['number', 'null'] },
        total_amount: { type: ['number', 'null'] },
        line_amounts_include_tax: { type: 'boolean' },
        reference_number: { type: ['string', 'null'] },
        references: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'value'],
            properties: {
              type: {
                type: 'string',
                enum: [
                  'ticket_number',
                  'tracking_number',
                  'invoice_number',
                  'order_id',
                  'transaction_id',
                  'receipt_number',
                  'booking_reference',
                  'other'
                ]
              },
              value: { type: 'string' }
            }
          }
        },
        payment_status: { type: 'string', enum: PAYMENT_STATUS_VALUES },
        payment_terms_phrase: { type: ['string', 'null'] }
      }
    },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'quantity', 'unit_price', 'amount', 'tax_rate'],
        properties: {
          description: { type: ['string', 'null'] },
          quantity: { type: ['number', 'null'] },
          unit_price: { type: ['number', 'null'] },
          amount: { type: ['number', 'null'] },
          tax_rate: { type: ['number', 'null'] }
        }
      }
    }
  }
};

const INSTRUCTIONS = `You are extracting fields from one INCOMING sales-evidence document for a bookkeeping system.

Return only the requested structured object. The document is one of these money-IN shapes:
1. A sales invoice the firm issued to a customer (payment still expected).
2. A receipt the firm issued after receiving a customer payment (already paid).
3. A payment-processor payout / settlement report or cash-deposit confirmation showing one net amount transferred into the firm's bank account (already paid).

The firm is the seller/recipient of the money. counterparty_role is always "customer" for this writer contract. For a processor payout, use the processor brand as counterparty_name because it aggregates the underlying customers. For a cash deposit with no named external party, return counterparty_name=null. Never return the firm's own name as the counterparty.

PROCESSOR PAYOUT / DEPOSIT RULES — these are not supplier receipts and not outbound payment confirmations:
- Strong tells: "payout", "settlement", "net deposit", "transfer to your bank", gross customer sales, processor fees deducted, transaction/order counts, or a bank deposit confirmation.
- total_amount MUST be the single overall NET amount transferred into the firm's bank account. Do not select one underlying sale, one batch row, gross sales, a fee, reserve, refund, or subtotal when a printed net deposit/settlement total exists.
- document_date is the deposit / settlement / transfer date. due_date is null. payment_status is "paid".
- Lines may describe the components of the payout. Preserve them when usable, but an otherwise-readable one-line deposit confirmation is valid with lines=[].

CUSTOMER IDENTIFICATION for invoices/issued receipts (counterparty_name) — the BUYER the document is addressed to. Look in this priority order:
  1. Lines explicitly labeled "Bill to", "Sold to", "Invoice to", "Customer", "Client".
     Read equivalent labels in the document's language: on a Finnish invoice,
     "Ostaja", "Asiakas" and "Laskutettava" identify the buyer; "Myyjä" and
     "Laskuttaja" identify the seller/issuer. The printed roles, together with
     the explicit FIRM-SIDE ANCHOR below, determine which party is the customer.
  2. The recipient block, typically printed below the firm's own header.
  3. A "Ship to" entry only if no "Bill to" entry is present.

DO NOT use as the customer:
  - The firm's own brand / logo / legal entity at the top — that's the vendor (us), not the customer.
  - "From" / "Vendor" / "Issued by" lines — those identify the firm.
  - Card brand names or payment processors, EXCEPT that the processor brand is the correct counterparty for an aggregated payout/settlement report.
  - Generic placeholders ("Customer", "Receiver") with no real name attached.

CUSTOMER NAME STYLE — use the shortest recognisable name, not the full legal entity:
  - "Acme Corp" not "Acme Corporation of Delaware Inc."
  - "Johnson & Sons" not "Johnson & Sons Holdings International LLC"

Use only the entity names explicitly listed in FIRM-SIDE ANCHOR as the book's
identity. Do not invent another anchor or treat a named buyer as our entity
merely because the names share a word or the document is labelled as a test.
A synthetic/test marker does not erase readable printed party names.
If the printed seller/buyer roles conflict with the supplied entity identity,
explain that precise conflict in warnings and preserve uncertainty; never swap
parties to force agreement. If you cannot confidently identify the customer,
return null — never invent a customer from the filename.

Header fields:
- document_date is the invoice's issue date in YYYY-MM-DD form.
- due_date is the explicit payment deadline. If the invoice only shows payment terms ("Net 30"), set due_date to null and surface the phrase via payment_terms_phrase — downstream code computes the deadline.
- currency is the ISO-4217 code; infer from the symbol/locale if not spelled out.
- total_amount is the grand total the customer owes/paid, or the overall net bank transfer on a payout/deposit confirmation.
- tax_amount is the total tax line (sum of multiple tax codes if itemised).
- subtotal_amount is total minus tax when both are visible; otherwise null.
- shipping_amount / discount_amount / rounding_amount: only if the invoice explicitly shows a line for them; default 0 if not present.
- line_amounts_include_tax: true when the per-line "amount" already has tax baked in; false when tax is a separate footer line.
- payment_status: default "unpaid" for a sales invoice. Use "paid" for an issued receipt, processor payout, settlement report, or completed cash deposit; "partial" for a partial payment; "unknown" if you can't tell.
- payment_terms_phrase: the EXACT phrase as printed ("Net 30", "Due on receipt", "30 days from invoice date", "Two weeks", "End of month"). Null if no terms are stated.

REFERENCES — capture ALL structured identifiers as a list. For sales invoices, the most important is the invoice number itself, which downstream reconciliation reads as the canonical reference.

For each reference, return an object with a "type" tag and the literal "value":
  - invoice_number: invoice / sequential billing ids (e.g. "INV-2024-0042", "SI-77441"). Map bill_number / bill_id / billing_reference all to this type.
  - order_id: purchase order numbers the customer supplied (e.g. "PO-9988").
  - transaction_id: payment gateway / processor transaction ids.
  - booking_reference: reservation locators where the invoice is a booking confirmation.
  - receipt_number: receipt-specific sequential ids if the invoice doubles as one.
  - ticket_number: airline e-ticket numbers (rare on invoices).
  - tracking_number: courier / shipping numbers (rare on invoices).
  - other: any other structured identifier that looks stable but doesn't fit above.

DO NOT include card last-4 digits, phone numbers, addresses, dates, amounts, or form-of-payment markers as references.

Return an empty references array ([]) if no recognisable references appear. Do not duplicate the same value under multiple type tags.

reference_number (legacy single field): leave as null — the writer picks the highest-priority entry from references.

Lines:
- Return one entry in "lines" per billable item. Skip non-purchase lines (subtotal, tax, total, payment terms text).
- description is the line item text as printed. quantity defaults to 1 if not shown. unit_price is amount / quantity when not separately printed.
- amount is the per-line monetary total (inc. tax if line_amounts_include_tax=true, else excl.).
- tax_rate is the per-line tax rate as a decimal (0.09 for 9%, 0.20 for 20%), null if not shown.
- A sales invoice with no recognisable line items is unusual — prefer to extract whatever line detail it carries even if it is one "Services rendered" entry. A payout or deposit confirmation may legitimately have no line breakdown; return an empty array when none is visible.

extraction_confidence is your 0–1 confidence the extracted values are usable. extraction_status is "validated" when every required field was readable, "partial" when some were readable, "failed" if you couldn't read enough.`;

const REFERENCE_TYPE_VALUES = new Set(REFERENCE_TYPE_PRIORITY);

const sanitizeReferences = (rawReferences) => {
  if (!Array.isArray(rawReferences)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of rawReferences) {
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof entry.type === 'string' && REFERENCE_TYPE_VALUES.has(entry.type)
      ? entry.type
      : null;
    const value = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!type || !value) continue;
    const trimmedValue = value.slice(0, REFERENCE_VALUE_MAX);
    const dedupKey = `${type}::${trimmedValue.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ type, value: trimmedValue });
    if (out.length >= REFERENCE_LIST_MAX) break;
  }
  return out;
};

const pickPrimaryReferenceValue = (references, legacyValue) => {
  if (Array.isArray(references) && references.length) {
    for (const preferredType of REFERENCE_TYPE_PRIORITY) {
      const found = references.find((ref) => ref.type === preferredType);
      if (found?.value) return found.value;
    }
  }
  if (legacyValue && typeof legacyValue === 'string') {
    return legacyValue.trim().slice(0, REFERENCE_VALUE_MAX) || null;
  }
  return null;
};

// Map raw LLM response to writer-shape contract. The three load-bearing
// flips vs supplierBill.js's mapper are pinned here:
//   - header.vendor_name is ALWAYS null (the firm IS the vendor; we
//     never write the firm's own name on its own invoice).
//   - header.customer_name is populated from the LLM's counterparty.
//   - summary.counterparty_role is forced to 'customer'; if the LLM
//     mistakenly emits 'vendor' (it confused the direction), the
//     coercion here pulls it back. Brief invariants 3 + 4 + 5.
const mapExtractionToWriterShape = (parsed) => {
  const llmHeader = parsed.header || {};
  const counterpartyName = sanitizeText(llmHeader.counterparty_name, COUNTERPARTY_NAME_MAX);
  // counterparty_role on a sales invoice is structurally always
  // 'customer' — the invoice's recipient is the buyer. If the LLM
  // returns 'vendor' (direction confused) we coerce back. Inverse of
  // supplierBill.js:402.
  const counterpartyRole = 'customer';
  const references = sanitizeReferences(llmHeader.references);
  const referenceNumber = pickPrimaryReferenceValue(references, llmHeader.reference_number);
  const payment_terms = normalizePaymentTerms(llmHeader.payment_terms_phrase);

  const header = {
    // The firm IS the vendor — we don't write the firm's own name on
    // its own invoice. ALWAYS null regardless of LLM output. The
    // documents inbox reads `customer_name` for sales-invoice rows.
    vendor_name: null,
    customer_name: counterpartyName,
    document_date: isoDate(llmHeader.document_date),
    due_date: isoDate(llmHeader.due_date),
    total_amount: numberOrNull(llmHeader.total_amount),
    currency: normalizeCurrency(llmHeader.currency),
    tax_amount: numberOrNull(llmHeader.tax_amount),
    reference_number: referenceNumber,
    payment_status: normalizePaymentStatus(llmHeader.payment_status),
    extraction_confidence: numberOrNull(parsed.extraction_confidence)
  };

  const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
  const lines = rawLines.map((line) => ({
    description: line?.description == null ? null : sanitizeText(line.description, 500),
    quantity: numberOrNull(line?.quantity),
    unit_price: numberOrNull(line?.unit_price),
    amount: numberOrNull(line?.amount),
    tax_rate: numberOrNull(line?.tax_rate)
  }));

  const summary = {
    source: 'async_parse',
    prompt_version: SALES_INVOICE_PROMPT_VERSION,
    document_type: 'sales_invoice',
    counterparty_name: counterpartyName,
    counterparty_role: counterpartyRole,
    document_date: header.document_date,
    due_date: header.due_date,
    currency: header.currency,
    subtotal_amount: numberOrNull(llmHeader.subtotal_amount),
    tax_amount: header.tax_amount,
    shipping_amount: numberOrNull(llmHeader.shipping_amount),
    discount_amount: numberOrNull(llmHeader.discount_amount),
    rounding_amount: numberOrNull(llmHeader.rounding_amount),
    total_amount: header.total_amount,
    line_amounts_include_tax: Boolean(llmHeader.line_amounts_include_tax),
    references,
    payment_terms_phrase: payment_terms.phrase,
    payment_terms_days: payment_terms.days,
    line_count: lines.length,
    coded_line_count: 0,
    review_line_count: 0,
    extraction_status: parsed.extraction_status,
    extraction_confidence: header.extraction_confidence,
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.map((w) => String(w).slice(0, 200)).slice(0, 6)
      : []
  };

  if (lines.length === 0 && !summary.warnings.includes('no_lines_detected')) {
    summary.warnings.push('no_lines_detected');
  }
  if (lines.length > 0) {
    const totals = validateReceiptTotals({ summary, lines });
    // RT-04 (F-05): persist the receipt — expected / total / drift /
    // strategy — not just the boolean, so a mismatch can be read from
    // parse_summary. The worker's post-repair validation pass re-judges
    // the same formula on the final header and supersedes this copy.
    summary.totals_validation = totals;
    if (!totals.matches && !summary.warnings.includes('amount_mismatch')) {
      summary.warnings.push('amount_mismatch');
    }
  }

  return { header, summary, lines };
};

const defaultCallOpenAi = async ({ apiKey, model, dataUrl, filename, dateFormatHint, clientIdentity, signal }) => {
  const userContent = [
    buildResponsesDocumentPart({ dataUrl, filename, fallbackFilename: 'sales-invoice.pdf' }),
    { type: 'input_text', text: 'Extract the incoming sales-evidence header per the schema.' }
  ];
  if (dateFormatHint) {
    userContent.push({ type: 'input_text', text: dateFormatHint });
  }
  const instructions = `${INSTRUCTIONS}${buildClientIdentityPromptFragment(clientIdentity)}`;
  return fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    signal,
    body: JSON.stringify({
      model,
      store: false,
      instructions,
      input: [
        {
          role: 'user',
          content: userContent
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'sales_invoice_extraction',
          strict: true,
          schema: INVOICE_EXTRACTION_SCHEMA
        }
      }
    })
  });
};

// Public extractor — same `{ base64, filename, mimeType }` in →
// discriminated-union out as receipt.js / supplierBill.js, so the
// worker's dispatch branch can call any of them interchangeably.
//
//   { kind: 'completed', header, summary, lines }
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED' }     // retryable (5xx/timeout/429/network)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_REJECTED' }   // terminal (deterministic 4xx)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_UNREADABLE' } // terminal
export const extractSalesInvoiceFromBase64 = async ({
  base64,
  filename = '',
  mimeType = '',
  // Optional jurisdiction-derived prompt fragment. See receipt.js
  // for the contract.
  dateFormatHint = '',
  // Client identity for the firm-side anchor in the prompt — see
  // clientIdentityPrompt.js. Optional: when null/missing, the
  // extractor falls back to the un-anchored prompt (today's behaviour
  // on rows that pre-date the plumbing).
  clientIdentity = null,
  __callOpenAi = defaultCallOpenAi
} = {}) => {
  const startedAt = Date.now();
  const correlationId = filenameCorrelationId(filename);
  const config = getOpenAiConfig();

  if (!config.apiKey) {
    console.warn('[sales-invoice] OPENAI_API_KEY not configured', { correlation_id: correlationId });
    return {
      kind: 'failed',
      model: config.model,
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'openai_not_configured'
    };
  }

  const clean = trimBase64(base64);
  if (!clean) {
    return {
      kind: 'failed',
      model: config.model,
      code: 'DOCUMENT_EXTRACTION_UNREADABLE',
      reason: 'empty_input'
    };
  }

  const dataUrl = `data:${mimeType || 'application/pdf'};base64,${clean}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await __callOpenAi({
      apiKey: config.apiKey,
      model: config.model,
      dataUrl,
      filename,
      dateFormatHint,
      clientIdentity,
      signal: controller.signal
    });
  } catch (err) {
    console.error('[sales-invoice] OpenAI request threw', {
      correlation_id: correlationId,
      error_code: err?.code || null,
      error_name: err?.name || null,
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      model: config.model,
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: err?.name === 'AbortError' ? 'timeout' : 'network_error'
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) {
    const status = Number(response?.status || 0);
    // The provider's error body tells an empty account from a rate limit or a
    // rejection of this file (parseErrors.providerFaultOfResponse).
    const providerError = await readProviderError(response);
    console.error('[sales-invoice] OpenAI returned non-OK', {
      correlation_id: correlationId,
      status,
      elapsed_ms: Date.now() - startedAt
    });
    return { ...extractionFailureForStatus(status, { providerError }), model: config.model };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: 'failed',
      model: config.model,
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'response_not_json'
    };
  }

  const text = outputTextFromResponse(payload);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[sales-invoice] structured response was not valid JSON', {
      correlation_id: correlationId,
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      model: config.model,
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'structured_bad_json'
    };
  }

  const confidence = Number(parsed?.extraction_confidence || 0);
  if (parsed?.extraction_status === 'failed' || confidence < UNREADABLE_CONFIDENCE_FLOOR) {
    console.warn('[sales-invoice] extraction below floor', {
      correlation_id: correlationId,
      extraction_status: parsed?.extraction_status || null,
      confidence_band: confidence < 0.1 ? '<0.1' : confidence < 0.3 ? '0.1-0.3' : '>=0.3',
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      model: config.model,
      code: 'DOCUMENT_EXTRACTION_UNREADABLE',
      reason: parsed?.extraction_status === 'failed' ? 'extractor_status_failed' : 'low_confidence'
    };
  }

  const { header, summary, lines } = mapExtractionToWriterShape(parsed);

  console.log('[sales-invoice] extraction complete', {
    correlation_id: correlationId,
    extraction_status: summary.extraction_status,
    has_customer: Boolean(header.customer_name),
    has_date: Boolean(header.document_date),
    has_due_date: Boolean(header.due_date),
    has_total: header.total_amount != null,
    has_currency: Boolean(header.currency),
    line_count: lines.length,
    payment_terms_known: summary.payment_terms_days != null,
    confidence_band: confidence < 0.5 ? '<0.5' : confidence < 0.8 ? '0.5-0.8' : '>=0.8',
    warning_count: summary.warnings.length,
    elapsed_ms: Date.now() - startedAt
  });

  const servedModel = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : null;
  return { kind: 'completed', header, summary, lines, model: servedModel, model_source: servedModel ? 'provider_response' : null };
};

// Test seams.
export const __INVOICE_EXTRACTION_SCHEMA = INVOICE_EXTRACTION_SCHEMA;
export const __INSTRUCTIONS = INSTRUCTIONS;
export const __mapExtractionToWriterShape = mapExtractionToWriterShape;
