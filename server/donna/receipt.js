// Receipt extraction — PR 1 + PR 2 of
// docs/invoice-receipt-parsing-plan.md. Single OpenAI Responses-API
// call per file using vision + json_schema strict mode. PR 1 shipped
// header-only; PR 2 extends the schema with first-class line items,
// the trio of value-modifier fields the totals-validation helper
// reads (shipping/discount/rounding), plus `due_date`.
//
// PII policy (mirror the bank-statement audit policy + plan
// §"Guardrails"): never log full counterparty_name, reference_number,
// line descriptions, or any other free-text extracted field. Hash a
// correlation id from the filename if cross-line debugging is needed.
// Diagnostic logs in this module only carry the filename, byte
// count, elapsed_ms, and the structured outcome — never the LLM
// response body.

import crypto from 'node:crypto';
import { normalizeIsoDate, normalizeIsoCurrency } from './parsePrimitives.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { buildClientIdentityPromptFragment } from './clientIdentityPrompt.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';
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
// docs/donna-llm-trust-strategy.md) — bump from nano to gpt-5.4. (Until
// 2026-11-10 OPENAI_MODEL tuned it; the document lanes take no provider-wide
// knob, so a stray gpt id cannot pin them to OpenAI.)
const DEFAULT_MODEL = 'gpt-5.4';
// 2026-11-10 (the owner's decision that Donna runs on Claude): the lane
// (type_extractors_legacy) resolves Anthropic first; claude-opus-5-5 reads
// the receipt as a document/image block with structured output. A full
// field + line extraction feeding the books earns `high` effort.
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const ANTHROPIC_EFFORT = 'high';
const ANTHROPIC_MAX_TOKENS = 64_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 180_000;
// RT-12 (audit F-12): every extraction lane stamps its prompt version on
// the receipt. A string constant per module; bump when the prompt or the
// schema changes meaning.
export const RECEIPT_PROMPT_VERSION = 'receipt-extraction-v2';
const REQUEST_TIMEOUT_MS = 60_000;
// Below this floor we treat the extraction as unreadable regardless of
// the LLM's self-reported `extraction_status`. The model is reluctant
// to admit it can't read something; the confidence number is a better
// reality check.
const UNREADABLE_CONFIDENCE_FLOOR = 0.3;

// Issue #95: 'void' and 'credit_note' joined the vocabulary. Rare on
// receipts (a POS refund occasionally emits 'credit_note') but cheap
// to accept so the AR/AP aging surfaces don't have to special-case
// receipt rows that legitimately carry these statuses.
const PAYMENT_STATUS_VALUES = ['paid', 'unpaid', 'partial', 'unknown', 'void', 'credit_note'];
const COUNTERPARTY_ROLE_VALUES = ['vendor', 'customer'];

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

// No model knob: the lane's defaults per provider (the document lanes take
// no provider-wide knob such as OPENAI_MODEL, 2026-11-10).
const getOpenAiConfig = () => resolveDocumentLaneProvider({
  laneId: 'type_extractors_legacy',
  dotEnv: readDotEnv(),
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

const isoDate = normalizeIsoDate;

const normalizeCurrency = normalizeIsoCurrency;

const normalizePaymentStatus = (value) => {
  const str = String(value || '').toLowerCase();
  return PAYMENT_STATUS_VALUES.includes(str) ? str : 'unknown';
};

// JSON schema for the OpenAI Responses-API `text.format.json_schema`
// strict-mode field. Mirrors the plan §"Worker" extractor contract.
// PR 1 shipped header-only; PR 2 adds the `lines` array + the
// totals-validation modifier fields (shipping / discount / rounding /
// line_amounts_include_tax) + `due_date`.
//
// `strict: true` requires `additionalProperties: false` and all
// declared fields listed in `required`. Nullable fields are modeled
// as `{ type: ['string', 'null'] }` style unions so the schema
// validator accepts both the value and a null sentinel — receipts
// often lack a reference_number or explicit tax_amount, and the
// model needs to be allowed to say so.
const RECEIPT_EXTRACTION_SCHEMA = {
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
        'payment_status'
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
        // Legacy single-reference field. Kept for backwards compat with
        // PR 1's writer + matcher. Populated by mapExtractionToWriterShape
        // from the highest-priority entry in `references` (ticket_number
        // > tracking_number > invoice_number > order_id > transaction_id
        // > receipt_number > booking_reference > other) so existing
        // reference-token matching still works while the structured
        // payload gives downstream consumers (matcher, audit, FE) every
        // reference the receipt carries.
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
        payment_status: { type: 'string', enum: PAYMENT_STATUS_VALUES }
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
          // Quantity is 4dp on the column; tax_rate is a decimal
          // (0.09 for 9%), not a percentage.
          quantity: { type: ['number', 'null'] },
          unit_price: { type: ['number', 'null'] },
          amount: { type: ['number', 'null'] },
          tax_rate: { type: ['number', 'null'] }
        }
      }
    }
  }
};

const INSTRUCTIONS = `You are extracting fields from a single receipt for the entity whose books are being kept. Entity facts are supplied separately when resolved; missing context never implies a country.

Return only the requested structured object. The file is a receipt the vendor issued to the buyer — counterparty_role is always "vendor".

VENDOR IDENTIFICATION (counterparty_name) — this is the single most important field. The vendor is the BUSINESS that issued the receipt, i.e. the entity selling the goods or services.

Look for the vendor in this priority order:
  1. The brand name / logo at the top of the document — usually the largest text, e.g. "FINNAIR", "STRIPE", "APPLE", "GRAB", "STARBUCKS".
  2. Lines explicitly labeled with the vendor role: "Issuing Airline", "Issued by", "Sold by", "Vendor", "Merchant", "Service Provider".
  3. The business name in the header section, typically appearing above or near the date, often in bold or larger type.
  4. "Operated by" or "Marketed by" if no clearer indicator exists (common on travel/utility receipts where the marketer differs from the operator — prefer the marketer name, which is what the buyer transacted with).
  5. The legal entity in the footer if it's the only business named on the document (rare).

DO NOT use any of these as the vendor:
  - Passenger names, traveler names, customer names, "Bill to" or "Sold to" recipients — those are the BUYER, not the vendor.
  - Card brand names (Visa, Mastercard, Amex, JCB) — those are payment networks, not vendors.
  - Payment processor names that only appear on the payment line (e.g. "Stripe", "Adyen", "PayPal") UNLESS the processor IS the actual merchant (e.g. a Stripe Atlas invoice from Stripe itself).
  - Generic placeholder terms ("Customer", "Buyer", "Receiver", "Guest", "Member").
  - Booking platform name when a downstream operator clearly owns the service (e.g. for a flight booked via Expedia, the vendor is the AIRLINE, not Expedia).

VENDOR NAME STYLE — use the shortest recognisable brand name, not the full legal/branding name:
  - "Lowe's" not "Lowe's Home Improvement"
  - "Amazon" not "Amazon.com Services LLC"
  - "The Home Depot" not "Home Depot USA Inc"
  Keep the apostrophe in brand names like "Lowe's" or "Menard's".

If multiple businesses appear and you're uncertain, prefer the brand most prominently displayed (largest font / logo). If you cannot confidently identify any vendor, return null — never invent.

Header fields — be conservative:
- If a field is not legible or not present, return null for it (do not invent values).
- document_date is the date printed on the receipt, in YYYY-MM-DD form. For travel receipts, use the receipt issuance date (often labeled "Issuing Airline and date" or "Issued"), NOT the travel/service date. due_date is rarely present on a receipt — return null unless it's explicit.
- currency is the ISO-4217 code supported by the document itself. An explicit code or unambiguous currency symbol is evidence; a bare dollar sign, display locale, entity jurisdiction or book currency is not enough. If ambiguous or absent, return null and add currency_unresolved to warnings.
- total_amount is the grand total the buyer paid, including tax. For travel receipts, this is the "Grand Total" or "Total" line — NOT the fare-only or fare-equivalent line. tax_amount is the total tax line if shown (sum of multiple tax codes if itemized).
- subtotal_amount is total minus tax when both are visible; otherwise null.
- shipping_amount / discount_amount / rounding_amount: only if the receipt explicitly shows a line for them; default 0 if not present (NOT null — the totals validation reads 0 as "absent").
- line_amounts_include_tax is true when the per-line "amount" on the receipt already has tax baked in (when the printed prices include tax). false when tax is listed as a separate footer line and the line amounts are net.
- payment_status: "paid" if the receipt clearly shows the charge was settled (card-charged, cash-paid, "EXT" / external payment, etc.), "unpaid" only if an invoice/bill stamp says so, "partial" for split payment, "unknown" when in doubt.

REFERENCES — capture ALL structured identifiers printed on the receipt as a list. Bank statements typically embed one or more of these in transaction descriptions, so accuracy here is what makes downstream auto-reconciliation work.

For each reference, return an object with a "type" tag and the literal "value" as printed (strip leading/trailing whitespace, but preserve internal characters including spaces, hyphens, slashes):
  - ticket_number: airline e-ticket numbers, often with an IATA airline prefix (e.g. "105 1234567890"). Keep the airline prefix and the trailing digits as a single value.
  - tracking_number: courier / shipping tracking numbers (UPS, FedEx, DHL, etc.).
  - invoice_number: sequential invoice IDs (e.g. "INV-2024-001234", "I-77441").
  - order_id: e-commerce order numbers (e.g. "Order #ABC123", "1029384756").
  - transaction_id: payment gateway / processor transaction ids (e.g. Stripe "pi_..." / "ch_...").
  - receipt_number: receipt-specific sequential ids.
  - booking_reference: PNR codes / reservation locators (e.g. "MXXRRG"), usually 5-7 alphanumeric chars.
  - other: any other structured identifier that looks like a stable reference but doesn't fit the above (e.g. waybill numbers, confirmation codes).

DO NOT include as references:
  - Card last-4 digits ("**** 1234"), card numbers, phone numbers, addresses, email addresses.
  - Dates, amounts, currencies.
  - Passenger / customer names.
  - Generic labels without an accompanying value ("Reference: ___").
  - Form-of-payment markers ("EXT", "CASH", "VI", "MC") — those are payment-method codes, not references.

Return an empty references array ([]) if no recognizable references appear. Do not duplicate the same value under multiple type tags.

reference_number (legacy single field): leave as null — the writer will pick the highest-priority entry from references.

Lines:
- Return one entry in "lines" per purchasable item on the receipt. Skip non-purchase lines (subtotal, tax, total, change due, points balance, payment method).
- description is the line item text as printed. quantity defaults to 1 if not shown. unit_price is amount / quantity when not separately printed.
- amount is the per-line monetary total (inc. tax if line_amounts_include_tax=true, else excl.).
- tax_rate is the per-line tax rate as a decimal (0.09 for a printed 9% rate), null if not shown or not applicable. Do NOT scale to a percentage.
- Return an empty array if there are no individual line items (e.g. a single-amount receipt with no item breakdown, or a travel receipt where the journey is the only "item" — those are header-only).

extraction_confidence is your own 0–1 confidence that the extracted values are usable. extraction_status is "validated" when every required field was readable, "partial" when some were readable but others weren't (typical for travel receipts where the journey itinerary isn't itemized as line items), and "failed" if the document isn't a receipt or you couldn't read enough to be useful.`;

// Map the raw LLM response onto the writer's contract:
// - `header` is the documents-row shape consumed by
//   writeParsedDocumentExtractionInDb (vendor_name, document_date,
//   due_date, total_amount, currency, tax_amount, reference_number,
//   payment_status, extraction_confidence). customer_name stays null
//   for receipts — receipts only carry a vendor (per plan §"Worker"
//   counterparty_role mapping).
// - `summary` is the parse_summary jsonb payload (per plan
//   §"parse_summary shape"). PR 2 emits a `line_count` reflecting
//   the actual extracted lines plus the totals-validation modifier
//   fields the worker reads before deciding whether to add
//   `amount_mismatch` to warnings. coded_line_count / review_line_
//   count stay 0 / are set by the worker — coding lands in PR 4/5.
// - `lines` is the raw extractor line array — the writer turns each
//   into a `document_lines` row with a computed fingerprint.
// Reference type priority — when multiple references appear on a
// receipt, the legacy single `reference_number` column gets the
// highest-priority value. Ticket / tracking numbers are first because
// bank statements embed those verbatim in transaction descriptions
// (airline ticket numbers like "1051234567890", courier tracking ids).
// Booking references like PNRs are last because banks rarely include
// them.
export const REFERENCE_TYPE_PRIORITY = Object.freeze([
  'ticket_number',
  'tracking_number',
  'invoice_number',
  'order_id',
  'transaction_id',
  'receipt_number',
  'booking_reference',
  'other'
]);

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
    // Cap length to defend against an over-eager LLM dump (8 references
    // × 80 chars is plenty; anything longer almost certainly isn't a
    // structured reference).
    const trimmedValue = value.slice(0, 80);
    const dedupKey = `${type}::${trimmedValue.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ type, value: trimmedValue });
    if (out.length >= 8) break;
  }
  return out;
};

// Pick the highest-priority reference to backfill the legacy
// reference_number column. The matcher's reference-token path already
// tokenizes this string against bank transaction descriptions — keep
// it as the most-likely-to-match identifier so the existing match
// behavior strengthens rather than regresses.
const pickPrimaryReferenceValue = (references, legacyValue) => {
  if (Array.isArray(references) && references.length) {
    for (const preferredType of REFERENCE_TYPE_PRIORITY) {
      const found = references.find((ref) => ref.type === preferredType);
      if (found?.value) return found.value;
    }
  }
  if (legacyValue && typeof legacyValue === 'string') {
    return legacyValue.trim().slice(0, 80) || null;
  }
  return null;
};

const mapExtractionToWriterShape = (parsed) => {
  const llmHeader = parsed.header || {};
  const counterpartyName = String(llmHeader.counterparty_name || '').trim() || null;
  const counterpartyRole = COUNTERPARTY_ROLE_VALUES.includes(llmHeader.counterparty_role)
    ? llmHeader.counterparty_role
    : 'vendor';
  const isVendor = counterpartyRole === 'vendor';
  const references = sanitizeReferences(llmHeader.references);
  const referenceNumber = pickPrimaryReferenceValue(references, llmHeader.reference_number);

  const header = {
    vendor_name: isVendor ? counterpartyName : null,
    // PR 1 covers receipts only. counterparty_role is enum-locked
    // upstream but the writer keeps customer_name null on this code
    // path regardless — supplier_bill / sales_invoice extractors in
    // PR 6/7 will set this field via their own writers.
    customer_name: null,
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
  // Sanitise into a stable line shape. The worker forwards the same
  // shape to replaceDocumentLinesForRun; defensive coercion here means
  // a single bad row doesn't blow up the whole write.
  const lines = rawLines.map((line) => ({
    description: line?.description == null ? null : String(line.description).slice(0, 500),
    quantity: numberOrNull(line?.quantity),
    unit_price: numberOrNull(line?.unit_price),
    amount: numberOrNull(line?.amount),
    tax_rate: numberOrNull(line?.tax_rate)
  }));

  const summary = {
    source: 'async_parse',
    prompt_version: RECEIPT_PROMPT_VERSION,
    document_type: 'receipt',
    counterparty_name: counterpartyName,
    counterparty_role: counterpartyRole,
    document_date: header.document_date,
    due_date: header.due_date,
    currency: header.currency,
    currency_resolution: { version: 1, currency: header.currency, source: header.currency ? 'model_document_evidence' : 'unresolved', candidate: llmHeader.currency ?? null },
    subtotal_amount: numberOrNull(llmHeader.subtotal_amount),
    tax_amount: header.tax_amount,
    shipping_amount: numberOrNull(llmHeader.shipping_amount),
    discount_amount: numberOrNull(llmHeader.discount_amount),
    rounding_amount: numberOrNull(llmHeader.rounding_amount),
    total_amount: header.total_amount,
    line_amounts_include_tax: Boolean(llmHeader.line_amounts_include_tax),
    // Structured references list. The matcher reads this from
    // parse_summary.references in PR 1's reference-token path so each
    // reference value (ticket, tracking, invoice id, etc.) gets a
    // chance at matching against the bank description tokens, not
    // just the single legacy reference_number string.
    references,
    // PR 2 line counts. The worker may override `review_line_count`
    // after totals validation; coding lands in PR 4/5.
    line_count: lines.length,
    coded_line_count: 0,
    review_line_count: 0,
    extraction_status: parsed.extraction_status,
    extraction_confidence: header.extraction_confidence,
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.map((w) => String(w).slice(0, 200)).slice(0, 6)
      : []
  };

  return { header, summary, lines };
};

// The request body, built ONCE in the Responses shape. The OpenAI transport
// sends it as is; the Anthropic transport carries it over unchanged
// (documentLaneRequest.js documentLaneRequestFromResponses: instructions →
// system, the file part → a document/image block, the strict schema →
// structured output). Indirection via the `__callOpenAi` / `__callAnthropic`
// args is what the unit tests hook to inject canned responses.
const buildRequestBody = ({ model, dataUrl, filename, dateFormatHint, clientIdentity }) => {
  const userContent = [
    // Image uploads (Telegram photos, camera receipts) go through the
    // API's image lane; input_file is PDF-only — see responsesInputPart.js.
    buildResponsesDocumentPart({ dataUrl, filename, fallbackFilename: 'receipt.pdf' }),
    { type: 'input_text', text: 'Extract the receipt header per the schema.' }
  ];
  // The locale hint is appended as an additional user-message turn so
  // it sits closer to the document and the LLM weighs it as
  // document-specific context rather than as a system rule. The
  // static INSTRUCTIONS stays untouched — the JSON schema contract is
  // identical across jurisdictions. The firm-side anchor (which name
  // on the page is the client, never the counterparty) is appended to
  // INSTRUCTIONS via buildClientIdentityPromptFragment — see
  // clientIdentityPrompt.js.
  if (dateFormatHint) {
    userContent.push({ type: 'input_text', text: dateFormatHint });
  }
  const instructions = `${INSTRUCTIONS}${buildClientIdentityPromptFragment(clientIdentity)}`;
  return {
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
        name: 'receipt_extraction',
        strict: true,
        schema: RECEIPT_EXTRACTION_SCHEMA
      }
    }
  };
};

const executionFor = (filename) => ({ root: { type: 'document_extraction', id: filenameCorrelationId(filename) } });

const defaultCallOpenAi = async ({ apiKey, signal, ...args }) => {
  const body = buildRequestBody(args);
  // Loaded at call time: llmCall's evidence writer reaches the firm DB,
  // whose parse writer imports this module (an import cycle at load).
  const { asProviderResponse, llmCall } = await import('./llmCall.js');
  return asProviderResponse(llmCall({
    provider: 'openai',
    // The lane's own wall, honoured inside a worker too (llmCall hands it to
    // the deadline transport, bounded by the job's remaining budget).
    timeoutMs: REQUEST_TIMEOUT_MS,
    url: 'https://api.openai.com/v1/responses',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body,
    sections: { system: body.instructions, tools: RECEIPT_EXTRACTION_SCHEMA },
    execution: executionFor(args.filename),
    promptVersion: RECEIPT_PROMPT_VERSION,
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
const defaultCallAnthropic = async ({ apiKey, signal, ...args }) => callAnthropicEnvelope({
  apiKey,
  body: buildRequestBody(args),
  effort: ANTHROPIC_EFFORT,
  maxTokens: ANTHROPIC_MAX_TOKENS,
  execution: executionFor(args.filename),
  promptVersion: RECEIPT_PROMPT_VERSION,
  signal
});

// Public extractor used by the worker. Mirrors the
// extractBankStatementFromBase64 entry shape:
// `{ base64, filename, mimeType }` in → discriminated-union out.
//
//   { kind: 'completed', header, summary, lines }
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED' }     // retryable (5xx/timeout/429/network)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_REJECTED' }   // terminal (deterministic 4xx)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_UNREADABLE' } // terminal
//
// The worker categorises the `code` via parseErrors.js — no other
// failure modes propagate from this function.
export const extractReceiptFromBase64 = async ({
  base64,
  filename = '',
  mimeType = '',
  // Optional jurisdiction-derived prompt fragment that disambiguates
  // locale-sensitive slash dates ("04/05/2026"). Computed by the
  // worker from `firms.jurisdiction` via
  // `jurisdictionDate.dateFormatHintFor` and forwarded verbatim.
  // Empty / unset means no hint is attached — the LLM falls back to
  // its default heuristic.
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
    console.warn('[receipt] no model provider key configured', { correlation_id: correlationId, reason: notConfigured });
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
    console.error('[receipt] provider request threw', {
      correlation_id: correlationId,
      provider: config.provider,
      // Hash-only correlation; never log free-text from the doc.
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
    console.error('[receipt] provider returned non-OK', {
      correlation_id: correlationId,
      provider: config.provider,
      status,
      elapsed_ms: Date.now() - startedAt
    });
    // 4xx other than 408/429 will not clear with a retry — wrong model,
    // schema rejected by the API, unsupported input — so the shared
    // mapper classes them DOCUMENT_EXTRACTION_REJECTED (terminal, cause
    // named in parse_error). The earlier "retryable so an operator can
    // triage" posture in practice read as cron-STUCK with no cause (the
    // 2026-07-21 photo carousel). 408/429/5xx stay retryable.
    // Terminal-unreadable is still reserved for the LLM's own "I can't
    // read it" signal.
    return { ...extractionFailureForStatus(status, { provider: config.provider, providerError: reply.providerError }), ...stamp(null) };
  }

  if (!reply.ok && reply.kind === 'stop') {
    // A refusal or a cut-off reply will not clear with a retry of the same
    // request: terminal, named, receipted with the model that gave it. An
    // answer that is not the structured answer is retryable (stopFailureCode).
    console.error('[receipt] provider stopped without a usable reply', {
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
    console.error('[receipt] structured response was not valid JSON', {
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
    console.warn('[receipt] extraction below floor', {
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

  const { header, summary, lines } = mapExtractionToWriterShape(parsed);

  console.log('[receipt] extraction complete', {
    correlation_id: correlationId,
    extraction_status: summary.extraction_status,
    has_vendor: Boolean(header.vendor_name),
    has_date: Boolean(header.document_date),
    has_total: header.total_amount != null,
    has_currency: Boolean(header.currency),
    // Line count is a non-PII count; description text never appears
    // in logs per the plan's PII policy.
    line_count: lines.length,
    confidence_band: confidence < 0.5 ? '<0.5' : confidence < 0.8 ? '0.5-0.8' : '>=0.8',
    warning_count: summary.warnings.length,
    elapsed_ms: Date.now() - startedAt
  });

  return { kind: 'completed', ...served, header, summary, lines };
};

// Exported for tests so they can assert the schema shape without
// running the LLM.
export const __RECEIPT_EXTRACTION_SCHEMA = RECEIPT_EXTRACTION_SCHEMA;
export const __mapExtractionToWriterShape = mapExtractionToWriterShape;
