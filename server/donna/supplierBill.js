// Supplier bill extraction — PR 6 of
// docs/invoice-receipt-parsing-plan.md. Parallel to receipt.js; same
// OpenAI Responses-API single-shot call with strict-mode JSON schema,
// same error envelope, same correlation-id PII discipline.
//
// Bills differ from receipts in three load-bearing ways:
//   1. payment_status defaults to 'unpaid' — a bill is an outstanding
//      liability until matched to a payment, vs receipts which are
//      typically already settled when uploaded.
//   2. `payment_terms_phrase` + `payment_terms_days` are extracted and
//      land on parse_summary (no migration needed — Q4 confirmed).
//   3. `lines: []` is exceptional for bills — when it happens the
//      extractor surfaces 'no_lines_detected' on parse_summary.warnings
//      so the firm sees the gap (tax law treats the line breakdown as
//      primary evidence).
//
// PII policy mirrors receipt.js: never log free-text extracted fields.
// Hash a correlation id from the filename; surface only counts +
// confidence bands in logs.

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  REFERENCE_TYPE_PRIORITY
} from './receipt.js';
import { validateReceiptTotals } from './totalsValidation.js';
import { buildClientIdentityPromptFragment } from './clientIdentityPrompt.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { normalizeIsoCurrency, normalizeIsoOrDayFirstDate } from './parsePrimitives.js';
import { extractionFailureForStatus } from './inngest/parseErrors.js';
import {
  documentLaneRequestFromResponses,
  notConfiguredFailure,
  readDocumentLaneReply,
  resolveDocumentLaneProvider,
  stopFailureCode,
  stopFailureReason,
  thrownReason
} from './documentLaneRequest.js';
import { classifyModelProvenance } from './providerEndpoints.js';

// Slice A of the LLM-trust downgrade plan (see CLAUDE.md +
// docs/donna-llm-trust-strategy.md) — bump from nano to the full
// gpt-5.4. Env override remains the per-deploy tuning knob.
const DEFAULT_MODEL = 'gpt-5.4';
// 2026-11-10 (the owner's decision that Donna runs on Claude): the lane
// (type_extractors_legacy) resolves Anthropic first; claude-opus-5-5 reads
// the document as a document/image block with structured output. A full
// field extraction feeding the books earns `high` effort.
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const ANTHROPIC_EFFORT = 'high';
const ANTHROPIC_MAX_TOKENS = 64_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 180_000;
// RT-12 (audit F-12): every extraction lane stamps its prompt version on
// the receipt. A string constant per module; bump when the prompt or the
// schema changes meaning.
export const SUPPLIER_BILL_PROMPT_VERSION = 'supplier-bill-extraction-v2';
const REQUEST_TIMEOUT_MS = 60_000;
const UNREADABLE_CONFIDENCE_FLOOR = 0.3;

// Issue #95: 'void' and 'credit_note' joined the vocabulary so the
// AR-aging dashboard doesn't pollute its overdue buckets with
// cancelled or reversed documents. Both round-trip through the
// extractor instead of being coerced back to the default.
const PAYMENT_STATUS_VALUES = ['paid', 'unpaid', 'partial', 'unknown', 'void', 'credit_note'];
const COUNTERPARTY_ROLE_VALUES = ['vendor', 'customer'];

const VENDOR_NAME_MAX = 200;
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

// The lane's model knob pins the provider by id; no provider-wide knob.
const getOpenAiConfig = () => resolveDocumentLaneProvider({
  laneId: 'type_extractors_legacy',
  dotEnv: readDotEnv(),
  modelEnvKeys: ['BILL_EXTRACTOR_MODEL'],
  defaultModels: { anthropic: DEFAULT_ANTHROPIC_MODEL, openai: DEFAULT_MODEL }
});

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

const dayFirstHint = (hint) => /DD\/MM\/YYYY-convention/.test(String(hint || ''));
const isoDate = (value, hint) => normalizeIsoOrDayFirstDate(value, { allowDayFirst: dayFirstHint(hint) });
const normalizeCurrency = normalizeIsoCurrency;

const normalizePaymentStatus = (value) => {
  const str = String(value || '').toLowerCase();
  return PAYMENT_STATUS_VALUES.includes(str) ? str : 'unpaid';
};

// Strip control chars + cap to safe payload length. Used on every
// free-text field the LLM might emit (vendor_name, line description).
const sanitizeText = (value, maxLength) => {
  if (value == null) return null;
  const cleaned = String(value).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
};

// Payment-terms parser. Returns `{ phrase, days }` where days is an
// integer (or null when unparseable). The raw phrase round-trips so a
// firm can read "Two weeks from invoice" in the UI even when we
// couldn't normalise it.
//
// Supported patterns (Q2 confirmed):
//   - "Net N" / "Net N days" → N
//   - "N days" / "N day" → N
//   - "Due on receipt" / "Due immediately" / "Payable on receipt" → 0
//   - "Two weeks" → 14, "One month" → 30 (approximations)
//   - "End of month" / "EOM" → null (needs issue date to resolve)
//   - Anything else → { phrase: <raw>, days: null }
//
// Exported for unit testing.
export const normalizePaymentTerms = (rawPhrase) => {
  if (rawPhrase == null) return { phrase: null, days: null };
  const phrase = String(rawPhrase).trim();
  if (!phrase) return { phrase: null, days: null };
  const safePhrase = phrase.slice(0, 120);
  const lower = phrase.toLowerCase();

  if (/(^|\b)(due on receipt|due immediately|payable on receipt|on receipt|immediate)\b/i.test(lower)) {
    return { phrase: safePhrase, days: 0 };
  }
  // "Net 30" / "Net 30 days" / "n30"
  const netMatch = lower.match(/\bnet[\s-]*(\d{1,3})\b/);
  if (netMatch) {
    return { phrase: safePhrase, days: Number(netMatch[1]) };
  }
  // "30 days from invoice date" / "30 day"
  const daysMatch = lower.match(/\b(\d{1,3})\s*(?:calendar\s+)?days?\b/);
  if (daysMatch) {
    return { phrase: safePhrase, days: Number(daysMatch[1]) };
  }
  // Word-style durations.
  if (/\b(one|1)\s*(week|wk)s?\b/.test(lower)) return { phrase: safePhrase, days: 7 };
  if (/\b(two|2)\s*(week|wk)s?\b/.test(lower)) return { phrase: safePhrase, days: 14 };
  if (/\b(three|3)\s*(week|wk)s?\b/.test(lower)) return { phrase: safePhrase, days: 21 };
  if (/\b(four|4)\s*(week|wk)s?\b/.test(lower)) return { phrase: safePhrase, days: 28 };
  if (/\b(one|1)\s*month\b/.test(lower)) return { phrase: safePhrase, days: 30 };
  if (/\b(two|2)\s*months?\b/.test(lower)) return { phrase: safePhrase, days: 60 };
  if (/\b(three|3)\s*months?\b/.test(lower)) return { phrase: safePhrase, days: 90 };
  // End-of-month forms need the issue date to resolve — out of scope
  // for v1 per the brief. Keep the raw phrase so the firm sees it.
  if (/\b(eom|end of month|end of next month)\b/.test(lower)) {
    return { phrase: safePhrase, days: null };
  }
  return { phrase: safePhrase, days: null };
};

// JSON schema for the OpenAI Responses-API strict mode. Mirrors
// receipt.js's RECEIPT_EXTRACTION_SCHEMA shape — same `additional
// Properties: false` everywhere, every property listed in `required`.
const BILL_EXTRACTION_SCHEMA = {
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
        // Raw phrase as printed on the bill — "Net 30", "Due on receipt",
        // "30 days from invoice date". The mapping helper turns this into
        // an integer day count (or null if unparseable).
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

const INSTRUCTIONS = `You are extracting fields from a single outgoing payable: a supplier invoice, an insurance premium invoice, a loan installment notice, or a payslip/payroll record for one employee. These already-supported document families share the supplier_bill schema. A readable non-invoice payable is not a failed extraction merely because it lacks an invoice number or supplier logo.

Return only the requested structured object. counterparty_role is always "vendor": the other party the firm pays. Read the file to determine which payable it contains; never infer an amount or family solely from its filename.

NON-INVOICE PAYABLES — these rules specialize the ordinary invoice instructions below:
- PAYSLIP / PAYROLL RECORD: counterparty_name is the EMPLOYEE receiving the net transfer, not the employer whose logo/name heads the record. Preserve the employee's printed name. total_amount is the NET pay transferred for this pay period, never gross earnings, year-to-date totals or total employer cost. document_date is the printed payment/pay date; do not invent one from a period label. Lines are the printed components of that net transfer: gross earnings and allowances POSITIVE, tax withheld and each employee deduction NEGATIVE, so their signed amounts sum to net pay. Do not include gross/net subtotal or cumulative summary rows again. Employer-side contributions payable elsewhere are NOT employee deductions and NOT lines in this transfer; retain any separately printed employer contribution amount in warnings as "model:employer_contributions_<amount>". Income-tax withholding is a signed deduction, not header tax_amount or a VAT tax_rate. For this non-VAT transfer, header tax_amount is 0, line tax_rate is null, subtotal_amount is the net signed component sum (null if not readable), and line_amounts_include_tax is true. This extracts source facts only; a payslip does not establish a complete payroll journal or authorize accounting.
- LOAN / FINANCING NOTICE: counterparty_name is the lender. total_amount is the installment due THIS period: its printed principal repayment, interest and fees. Never substitute outstanding principal, original loan amount, credit limit, annual totals or future scheduled payments. Lines are only this installment's printed components, each once; keep principal, interest and fee labels distinct. A financing agreement without a readable current installment must leave total_amount null rather than invent a repayment. Capture actual payment/loan references without fabricating an invoice number. Interest/principal are not a VAT tax line; extract a fee's tax only when separately printed.
- INSURANCE PREMIUM INVOICE: counterparty_name is the insurer; total_amount is the current premium/payment due, never the insured sum, coverage limit or an annual premium when this notice asks for one installment. Keep the printed premium components and any separately printed tax; do not invent VAT.
- For every family, absent invoice-only fields such as payment terms, invoice number or due date remain null/empty. Preserve uncertain facts as null and a warning or partial extraction. Unreadable source still fails. Never add balancing components to make a document foot; the existing totals validator checks the printed components.

The following vendor-identification priority and shortest-brand style apply to ordinary supplier invoices and insurer/lender names; the employee-name rule above takes precedence for payroll.

VENDOR IDENTIFICATION (counterparty_name) — the SUPPLIER that issued the bill. Look in this priority order:
  1. The supplier brand / logo at the top of the document.
  2. Lines explicitly labeled "From", "Vendor", "Supplier", "Bill from", "Issued by".
  3. The legal entity in the header section, often above the buyer's "Bill to" address.
  4. The footer's legal entity if it's the only business named on the bill.

VENDOR NAME STYLE — use the shortest recognisable brand name, not the full legal/branding name:
  - "Lowe's" not "Lowe's Home Improvement"
  - "Wells Fargo" not "Wells Fargo Home Mortgage Division"
  - "Amazon" not "Amazon.com Services LLC"
  - "The Home Depot" not "Home Depot USA Inc"
  Keep the apostrophe in brand names like "Lowe's" or "Menard's".
  Keep "The" only when it is part of the recognisable brand (e.g. "The Home Depot").

DO NOT use as the vendor:
  - The "Bill to" / "Sold to" / "Invoice to" recipient — those identify the BUYER, not the supplier.
  - Card brand names or payment processors.
  - Generic placeholders ("Customer", "Receiver").

If you cannot confidently identify the supplier, return null — never invent.

Header fields:
- document_date is the bill's issue date in YYYY-MM-DD form.
- due_date is the explicit payment deadline. If the bill only shows payment terms ("Net 30"), set due_date to null and surface the phrase via payment_terms_phrase — downstream code computes the deadline.
- currency is the ISO-4217 code; infer from the symbol/locale if not spelled out.
- total_amount is the grand total the firm owes, including tax.
- tax_amount is the total tax line (sum of multiple tax codes if itemised).
- subtotal_amount is total minus tax when both are visible; otherwise null.
- shipping_amount / discount_amount / rounding_amount: only if the bill explicitly shows a line for them; default 0 if not present.
- line_amounts_include_tax: true when the per-line "amount" already has tax baked in; false when tax is a separate footer line.
- payment_status: default "unpaid" (bills represent outstanding liabilities). Set to "paid" only if the bill carries an explicit paid stamp; "partial" for a partial payment; "unknown" if you can't tell.
- payment_terms_phrase: the EXACT phrase as printed ("Net 30", "Due on receipt", "30 days from invoice date", "Two weeks", "End of month"). Null if no terms are stated.

REFERENCES — capture ALL structured identifiers as a list. For bills, the most important is the bill/invoice number itself, which downstream reconciliation reads as the canonical reference.

For each reference, return an object with a "type" tag and the literal "value":
  - invoice_number: bill / invoice / sequential billing ids (e.g. "INV-2024-0042", "BILL-77441", a Finvoice invoice number). Map bill_number / bill_id / billing_reference all to this type.
  - order_id: purchase order numbers (e.g. "PO-9988").
  - transaction_id: payment gateway / processor transaction ids.
  - booking_reference: reservation locators where the bill is a booking confirmation (rare on bills).
  - receipt_number: receipt-specific sequential ids if the bill doubles as one.
  - ticket_number: airline e-ticket numbers (rare on bills).
  - tracking_number: courier / shipping numbers (rare on bills).
  - other: any other structured identifier that looks stable but doesn't fit above.

DO NOT include card last-4 digits, phone numbers, addresses, dates, amounts, or form-of-payment markers as references.

Return an empty references array ([]) if no recognisable references appear. Do not duplicate the same value under multiple type tags.

reference_number (legacy single field): leave as null — the writer picks the highest-priority entry from references.

Lines:
- Return one entry in "lines" per billable item. Skip non-purchase lines (subtotal, tax, total, payment terms text).
- description is the line item text as printed. quantity defaults to 1 if not shown. unit_price is amount / quantity when not separately printed.
- amount is the per-line monetary total (inc. tax if line_amounts_include_tax=true, else excl.).
- tax_rate is the per-line tax rate as a decimal (0.09 for 9%, 0.20 for 20%), null if not shown.
- A bill with no recognisable line items is unusual — prefer to extract whatever line detail the bill carries even if it's just one "Services rendered" entry. Return an empty array only when no line breakdown is visible at all.

extraction_confidence is your 0–1 confidence the extracted values are usable. extraction_status is "validated" when every required field was readable, "partial" when some were readable, "failed" if you couldn't read enough.`;

// Map raw LLM response to writer-shape contract. Identical contract to
// receipt.js's mapper:
//   - `header` lands on the documents row via writeParsedDocument
//     ExtractionInDb (vendor_name, document_date, due_date, total_amount,
//     currency, tax_amount, reference_number, payment_status,
//     extraction_confidence). customer_name is null on bills — the firm
//     is the buyer; we don't write the firm's own name.
//   - `summary` is the parse_summary jsonb. NEW fields vs receipts:
//     `payment_terms_phrase`, `payment_terms_days`, document_type=
//     'supplier_bill', counterparty_role='vendor'.
//   - `lines` is the raw extractor line array — same shape the writer
//     turns into document_lines rows.
//
// Two warnings are added deterministically at this layer:
//   - `no_lines_detected` when lines: [] (load-bearing for bills per
//     hard invariant 6 in the brief — bills without lines are almost
//     always extractor failures the reviewer needs to confirm).
//   - `amount_mismatch` when validateReceiptTotals flags drift > $1
//     between the LLM's claimed totals. Same machinery as receipts
//     (per the brief's "reuse the totals-validation logic" anchor).
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

// Pick the highest-priority reference to backfill the legacy
// reference_number column. For bills this almost always resolves to
// `invoice_number` (PR 6 hard invariant 4).
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

const mapExtractionToWriterShape = (parsed, { dateFormatHint = '' } = {}) => {
  const llmHeader = parsed.header || {};
  const counterpartyName = sanitizeText(llmHeader.counterparty_name, VENDOR_NAME_MAX);
  // counterparty_role on a bill is structurally always 'vendor' — the
  // bill's issuer is the supplier. If the LLM returns 'customer' we
  // ignore it and force 'vendor', matching brief invariant 3.
  const counterpartyRole = 'vendor';
  const references = sanitizeReferences(llmHeader.references);
  const referenceNumber = pickPrimaryReferenceValue(references, llmHeader.reference_number);
  const payment_terms = normalizePaymentTerms(llmHeader.payment_terms_phrase);

  const header = {
    vendor_name: counterpartyName,
    // Bills don't carry the buyer in customer_name — the firm is the
    // buyer and we don't write the firm's own name on its own bill.
    customer_name: null,
    document_date: isoDate(llmHeader.document_date, dateFormatHint),
    due_date: isoDate(llmHeader.due_date, dateFormatHint),
    total_amount: numberOrNull(llmHeader.total_amount),
    currency: normalizeCurrency(llmHeader.currency),
    tax_amount: numberOrNull(llmHeader.tax_amount),
    reference_number: referenceNumber,
    // Bills default to 'unpaid' — invariant 3 in the brief.
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
    prompt_version: SUPPLIER_BILL_PROMPT_VERSION,
    document_type: 'supplier_bill',
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

  // Append deterministic warnings (brief invariants 5, 6). Both lands
  // on the same `summary.warnings` array the worker and downstream
  // surfaces already read. Dedup before push so a re-extraction doesn't
  // pile up the same token.
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

const buildDefaultCall = (send) => async ({ apiKey, model, dataUrl, filename, dateFormatHint, clientIdentity, signal }) => {
  const userContent = [
    buildResponsesDocumentPart({ dataUrl, filename, fallbackFilename: 'supplier-bill.pdf' }),
    { type: 'input_text', text: 'Extract this outgoing payable and its printed payment components per the schema.' }
  ];
  if (dateFormatHint) {
    userContent.push({ type: 'input_text', text: dateFormatHint });
  }
  const instructions = `${INSTRUCTIONS}${buildClientIdentityPromptFragment(clientIdentity)}`;
  return send({
    apiKey,
    signal,
    body: {
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
          name: 'supplier_bill_extraction',
          strict: true,
          schema: BILL_EXTRACTION_SCHEMA
        }
      }
    }
  });
};

// The request body is built ONCE (Responses shape) and sent by either
// transport: OpenAI as is, Anthropic carried over unchanged
// (documentLaneRequest.js documentLaneRequestFromResponses, onto structuredRequest.js). Both ride llmCall.
const executionFor = (filename) => ({ root: { type: 'document_extraction', id: filenameCorrelationId(filename) } });

const sendOpenAi = async ({ apiKey, signal, body }) => {
  // Loaded at call time: llmCall's evidence writer reaches the firm DB,
  // whose parse writer imports this module (an import cycle at load).
  const { asProviderResponse, llmCall } = await import('./llmCall.js');
  return asProviderResponse(llmCall({
    provider: 'openai',
    // The lane's own wall, honoured inside a worker too (llmCall hands it to
    // the deadline transport, bounded by the job's remaining budget).
    timeoutMs: REQUEST_TIMEOUT_MS,
    url: 'https://api.openai.com/v1/responses',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body,
    sections: { system: body.instructions, tools: body.text?.format?.schema },
    execution: executionFor(body.input?.[0]?.content?.[0]?.filename),
    promptVersion: SUPPLIER_BILL_PROMPT_VERSION,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: init?.signal && signal ? AbortSignal.any([init.signal, signal]) : init?.signal || signal })
  }));
};


// The Anthropic call: the shared structured request (structuredRequest.js,
// via documentLaneRequest.js) through the envelope, called here. llmCall is
// loaded at call time where the module's import graph needs it.
const callAnthropicEnvelope = async (options) => {
  const { llmCall } = await import('./llmCall.js');
  return llmCall(documentLaneRequestFromResponses({ timeoutMs: ANTHROPIC_REQUEST_TIMEOUT_MS, ...options }));
};
const sendAnthropic = ({ apiKey, signal, body }) => callAnthropicEnvelope({
  apiKey,
  body,
  effort: ANTHROPIC_EFFORT,
  maxTokens: ANTHROPIC_MAX_TOKENS,
  execution: executionFor(body.input?.[0]?.content?.[0]?.filename),
  promptVersion: SUPPLIER_BILL_PROMPT_VERSION,
  signal
});

const defaultCallOpenAi = buildDefaultCall(sendOpenAi);
const defaultCallAnthropic = buildDefaultCall(sendAnthropic);

// Public extractor — same `{ base64, filename, mimeType }` in →
// discriminated-union out as receipt.js, so the worker's dispatch
// branch can call either interchangeably.
//
//   { kind: 'completed', header, summary, lines }
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED' }     // retryable (5xx/timeout/429/network)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_REJECTED' }   // terminal (deterministic 4xx)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_UNREADABLE' } // terminal
export const extractSupplierBillFromBase64 = async ({
  base64,
  filename = '',
  mimeType = '',
  // Optional jurisdiction-derived prompt fragment. See receipt.js
  // for the contract.
  dateFormatHint = '',
  // Client identity for the firm-side anchor in the prompt — see
  // clientIdentityPrompt.js.
  clientIdentity = null,
  __callOpenAi = defaultCallOpenAi,
  __callAnthropic = defaultCallAnthropic
} = {}) => {
  const startedAt = Date.now();
  const correlationId = filenameCorrelationId(filename);
  const config = getOpenAiConfig();

  if (!config.ok) {
    // No key: the failure names the provider whose key is missing (the
    // lane's first, Anthropic, unless a pinned model id chose another).
    const { provider: missing, reason: notConfigured } = notConfiguredFailure(config, 'type_extractors_legacy');
    console.warn('[supplier-bill] no model provider key configured', { correlation_id: correlationId, reason: notConfigured });
    return {
      kind: 'failed',
      model: null,
      provider: missing,
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: notConfigured
    };
  }

  const clean = trimBase64(base64);
  if (!clean) {
    return {
      kind: 'failed',
      model: config.model,
      provider: config.provider,
      code: 'DOCUMENT_EXTRACTION_UNREADABLE',
      reason: 'empty_input'
    };
  }

  const dataUrl = `data:${mimeType || 'application/pdf'};base64,${clean}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.provider === 'anthropic' ? ANTHROPIC_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);

  let reply;
  try {
    reply = await readDocumentLaneReply({
      provider: config.provider,
      callOpenAi: () => __callOpenAi({
      apiKey: config.apiKey,
      model: config.model,
      dataUrl,
      filename,
      dateFormatHint,
      clientIdentity,
      signal: controller.signal
      }),
      callAnthropic: () => __callAnthropic({
      apiKey: config.apiKey,
      model: config.model,
      dataUrl,
      filename,
      dateFormatHint,
      clientIdentity,
      signal: controller.signal
      }),
      outputText: outputTextFromResponse
    });
  } finally {
    clearTimeout(timeout);
  }

  // The model on every receipt from here is the one the response named
  // (the configured id only when it named none — model_source says so).
  const stamp = (servedModel) => {
    const provenance = classifyModelProvenance({ responseModel: servedModel, requestedModel: config.model });
    return { model: provenance.model, model_source: provenance.model_source, provider: config.provider };
  };

  if (!reply.ok && reply.kind === 'threw') {
    const err = reply.error;
    console.error('[supplier-bill] provider request threw', {
      correlation_id: correlationId,
      provider: config.provider,
      error_code: err?.code || null,
      error_name: err?.name || null,
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      ...stamp(null),
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: thrownReason(err)
    };
  }

  if (!reply.ok && reply.kind === 'status') {
    const status = reply.status;
    console.error('[supplier-bill] provider returned non-OK', {
      correlation_id: correlationId,
      provider: config.provider,
      status,
      elapsed_ms: Date.now() - startedAt
    });
    return { ...extractionFailureForStatus(status, { provider: config.provider, providerError: reply.providerError }), ...stamp(null) };
  }

  if (!reply.ok && reply.kind === 'stop') {
    // A refusal or a cut-off reply will not clear with a retry of the same
    // request: terminal, named, receipted with the model that gave it. An
    // answer that is not the structured answer is retryable (stopFailureCode).
    console.error('[supplier-bill] provider stopped without a usable reply', {
      correlation_id: correlationId, provider: config.provider, failure: reply.error.code, reason: reply.error.reason, elapsed_ms: Date.now() - startedAt
    });
    return { kind: 'failed', ...stamp(reply.error.servedModel), code: stopFailureCode(reply.error), reason: stopFailureReason(reply.error) };
  }

  if (!reply.ok) {
    return {
      kind: 'failed',
      ...stamp(null),
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'response_not_json'
    };
  }

  const { text } = reply;
  const served = stamp(reply.servedModel);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[supplier-bill] structured response was not valid JSON', {
      correlation_id: correlationId,
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      ...served,
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'structured_bad_json'
    };
  }

  const confidence = Number(parsed?.extraction_confidence || 0);
  if (parsed?.extraction_status === 'failed' || confidence < UNREADABLE_CONFIDENCE_FLOOR) {
    console.warn('[supplier-bill] extraction below floor', {
      correlation_id: correlationId,
      extraction_status: parsed?.extraction_status || null,
      confidence_band: confidence < 0.1 ? '<0.1' : confidence < 0.3 ? '0.1-0.3' : '>=0.3',
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      ...served,
      code: 'DOCUMENT_EXTRACTION_UNREADABLE',
      reason: parsed?.extraction_status === 'failed' ? 'extractor_status_failed' : 'low_confidence'
    };
  }

  const { header, summary, lines } = mapExtractionToWriterShape(parsed, { dateFormatHint });

  console.log('[supplier-bill] extraction complete', {
    correlation_id: correlationId,
    extraction_status: summary.extraction_status,
    has_vendor: Boolean(header.vendor_name),
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

  return { kind: 'completed', ...served, header, summary, lines };
};

// Test seams.
export const __BILL_EXTRACTION_SCHEMA = BILL_EXTRACTION_SCHEMA;
export const __mapExtractionToWriterShape = mapExtractionToWriterShape;
