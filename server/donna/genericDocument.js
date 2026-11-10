import { isProviderSpendLimit } from './providerTransport.js';
// Generic document extraction — fallback extractor for documents that
// don't match any known type (receipt, supplier_bill, sales_invoice,
// bank_statement, contract). Real examples: student loan payment
// confirmations, rent receipts for BTL properties, council tax bills,
// gas safety certificates, letting agent invoices.
//
// Uses the same OpenAI Responses API + vision + strict JSON schema
// pattern as receipt.js / supplierBill.js / contract.js. Returns the
// discriminated union the worker expects.
//
// PII policy (mirrors receipt.js): never log free-text extracted
// fields. Hash a correlation id from the filename; surface only
// counts + confidence bands in logs.

import crypto from 'node:crypto';
import { normalizeIsoDate, normalizeIsoCurrency } from './parsePrimitives.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { buildLineageForGenericProjection } from './decisionLineage.js';
import { calibrate } from './confidenceCalibration.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { extractionFailureForStatus, readProviderError } from './inngest/parseErrors.js';

// Generic extraction is a load-bearing call — its output is persisted
// and reasoned about downstream, and these are the HARDEST documents
// (no known type). Running it on a nano-class model was the Failure-A
// anti-pattern (CLAUDE.md). Strong model by default; GENERIC_DOC_MODEL
// stays the override knob.
const DEFAULT_MODEL = 'gpt-5.4';
// RT-12 (audit F-12): every extraction lane stamps its prompt version on
// the receipt. A string constant per module; bump when the prompt or the
// schema changes meaning.
export const GENERIC_DOCUMENT_PROMPT_VERSION = 'evidence-v2';
const REQUEST_TIMEOUT_MS = 60_000;
// Below this floor we treat the extraction as unreadable regardless of
// the LLM's self-reported `extraction_status`. Generic documents are
// inherently harder to parse so the floor is lower than receipt (0.3).
const UNREADABLE_CONFIDENCE_FLOOR = 0.25;

// Cap limits — defend against over-eager LLM output.
const PARTIES_MAX = 10;
const AMOUNTS_MAX = 20;
const DATES_MAX = 20;
const REFERENCES_MAX = 10;

const NAME_MAX_LEN = 200;
const LABEL_MAX_LEN = 200;
const VALUE_MAX_LEN = 80;
const SUMMARY_TEXT_MAX_LEN = 500;

const PARTY_ROLE_VALUES = new Set([
  'supplier', 'merchant', 'customer', 'payer', 'payee', 'bank',
  'government_agency', 'company', 'director', 'shareholder',
  'landlord', 'tenant', 'certifier', 'insurer', 'lender',
  'borrower', 'employer', 'employee', 'unknown'
]);

const AMOUNT_ROLE_VALUES = new Set([
  'amount_paid', 'amount_due', 'total_gross', 'subtotal', 'tax',
  'monthly_installment', 'annual_total', 'opening_balance',
  'closing_balance', 'credit_limit', 'loan_principal', 'interest',
  'deposit', 'fee', 'premium', 'claim_amount', 'penalty',
  'refund', 'discount', 'unknown'
]);

const DATE_ROLE_VALUES = new Set([
  'document_date', 'due_date', 'payment_date', 'issue_date',
  'effective_date', 'expiry_date', 'period_start', 'period_end',
  'transaction_date', 'service_date', 'filing_date', 'unknown'
]);

const REFERENCE_TYPE_VALUES = new Set([
  'invoice_number', 'receipt_number', 'order_id', 'transaction_id',
  'ticket_number', 'tracking_number', 'booking_reference',
  'account_number', 'policy_number', 'company_number',
  'tax_reference', 'payment_reference', 'contract_number',
  'confirmation_code', 'other'
]);

const VENDOR_ALLOWED_ROLES = new Set(['supplier', 'merchant']);
const CUSTOMER_ALLOWED_ROLES = new Set(['customer']);
const TOTAL_AMOUNT_ROLE_PRIORITY = ['amount_paid', 'amount_due', 'total_gross'];
const DOCUMENT_DATE_ROLE_PRIORITY = ['document_date', 'issue_date', 'payment_date'];

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
      process.env.GENERIC_DOC_MODEL ||
      dotEnv.GENERIC_DOC_MODEL ||
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

const isoDate = normalizeIsoDate;

const normalizeCurrency = normalizeIsoCurrency;

const capString = (value, maxLen) => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str ? str.slice(0, maxLen) : null;
};

// ── JSON schema for OpenAI Responses-API strict mode ─────────────────

const GENERIC_DOCUMENT_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'extraction_status',
    'extraction_confidence',
    'document_type_guess',
    'parties',
    'amounts',
    'dates',
    'references',
    'summary_text',
    'warnings'
  ],
  properties: {
    extraction_status: { type: 'string', enum: ['validated', 'partial', 'failed'] },
    extraction_confidence: { type: 'number' },
    document_type_guess: { type: 'string' },
    parties: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role'],
        properties: {
          name: { type: 'string' },
          role: {
            type: 'string',
            enum: [...PARTY_ROLE_VALUES]
          }
        }
      }
    },
    amounts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'currency', 'label', 'role'],
        properties: {
          value: { type: 'number' },
          currency: { type: 'string' },
          label: { type: 'string' },
          role: {
            type: 'string',
            enum: [...AMOUNT_ROLE_VALUES]
          }
        }
      }
    },
    dates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'label', 'role'],
        properties: {
          value: { type: 'string' },
          label: { type: 'string' },
          role: {
            type: 'string',
            enum: [...DATE_ROLE_VALUES]
          }
        }
      }
    },
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'type'],
        properties: {
          value: { type: 'string' },
          type: {
            type: 'string',
            enum: [...REFERENCE_TYPE_VALUES]
          }
        }
      }
    },
    summary_text: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } }
  }
};

// ── System prompt ────────────────────────────────────────────────────

const INSTRUCTIONS = `You are extracting structured data from a document that doesn't match standard accounting types (receipt, invoice, bill, bank statement, contract).

Extract all parties, monetary amounts, dates, and reference numbers you can find.

document_type_guess: your best one-word or short-phrase classification (e.g., 'payment_confirmation', 'tax_notice', 'safety_certificate', 'insurance_policy', 'utility_bill', 'government_letter', 'rental_agreement', etc.)

For parties, identify the role relative to the money flow: who pays (payer) vs who receives (payee). If the document isn't transactional, use 'issuer' and 'recipient'.

For amounts, capture ALL monetary values shown, with a label describing each.

For dates, capture ALL dates with labels.

summary_text: a single sentence summarizing what this document IS and its key data.

If the document is completely unreadable or blank, set extraction_status to 'failed'.

For party roles, be specific about the entity's function:
- "supplier" or "merchant": a business selling goods or services
- "customer": a business or person buying goods or services
- "bank": a financial institution
- "government_agency": tax authority, council, regulator, government body
- "landlord" / "tenant": property rental context
- "insurer": insurance provider
- "certifier": safety/compliance inspector or certification body
- "lender" / "borrower": loan/financing context
- "employer" / "employee": employment context
- "company": the client's own entity (when identifiable)
- "unknown": when the role cannot be determined
Do NOT use "supplier" or "merchant" for government agencies, banks, certifiers, insurers, landlords, or other non-commercial entities.

For amount roles, identify what each monetary value represents:
- "amount_paid": what was actually paid or charged
- "amount_due": what is owed / outstanding
- "total_gross": total including tax
- "monthly_installment" / "annual_total": periodic amounts
- "opening_balance" / "closing_balance": account balance figures
- "fee", "premium", "deposit", "penalty", "interest": specific charge types
- "tax" / "subtotal": tax and pre-tax components
- "unknown": when the role cannot be determined
Do NOT label balance figures, credit limits, or loan principals as "amount_paid" or "amount_due."

For date roles, identify what each date represents:
- "document_date": the date printed on the document
- "due_date": payment due date
- "payment_date": when payment was made
- "issue_date": when the document was issued
- "effective_date" / "expiry_date": agreement validity period
- "period_start" / "period_end": statement or report period
- "unknown": when the role cannot be determined`;

// ── Sanitisation helpers ─────────────────────────────────────────────

const sanitizeParties = (rawParties) => {
  if (!Array.isArray(rawParties)) return [];
  const out = [];
  for (const entry of rawParties) {
    if (!entry || typeof entry !== 'object') continue;
    const name = capString(entry.name, NAME_MAX_LEN);
    if (!name) continue;
    const role = typeof entry.role === 'string' && PARTY_ROLE_VALUES.has(entry.role)
      ? entry.role
      : 'unknown';
    out.push({ name, role });
    if (out.length >= PARTIES_MAX) break;
  }
  return out;
};

const sanitizeAmounts = (rawAmounts) => {
  if (!Array.isArray(rawAmounts)) return [];
  const out = [];
  for (const entry of rawAmounts) {
    if (!entry || typeof entry !== 'object') continue;
    const value = numberOrNull(entry.value);
    if (value === null) continue;
    const currency = normalizeCurrency(entry.currency);
    const label = capString(entry.label, LABEL_MAX_LEN) || '';
    const role = typeof entry.role === 'string' && AMOUNT_ROLE_VALUES.has(entry.role)
      ? entry.role
      : 'unknown';
    out.push({ value, currency, label, role });
    if (out.length >= AMOUNTS_MAX) break;
  }
  return out;
};

const sanitizeDates = (rawDates) => {
  if (!Array.isArray(rawDates)) return [];
  const out = [];
  for (const entry of rawDates) {
    if (!entry || typeof entry !== 'object') continue;
    const value = isoDate(entry.value);
    if (!value) continue;
    const label = capString(entry.label, LABEL_MAX_LEN) || '';
    const role = typeof entry.role === 'string' && DATE_ROLE_VALUES.has(entry.role)
      ? entry.role
      : 'unknown';
    out.push({ value, label, role });
    if (out.length >= DATES_MAX) break;
  }
  return out;
};

const sanitizeReferences = (rawReferences) => {
  if (!Array.isArray(rawReferences)) return [];
  const out = [];
  for (const entry of rawReferences) {
    if (!entry || typeof entry !== 'object') continue;
    const value = capString(entry.value, VALUE_MAX_LEN);
    if (!value) continue;
    const type = typeof entry.type === 'string' && REFERENCE_TYPE_VALUES.has(entry.type)
      ? entry.type
      : 'other';
    out.push({ value, type });
    if (out.length >= REFERENCES_MAX) break;
  }
  return out;
};

// ── Writer-shape mapping ─────────────────────────────────────────────
// Convert generic extraction output to the standard writer contract
// consumed by writeParsedDocumentExtractionInDb.

const mapExtractionToWriterShape = (parsed, { modelId = '' } = {}) => {
  const parties = sanitizeParties(parsed?.parties);
  const amounts = sanitizeAmounts(parsed?.amounts);
  const dates = sanitizeDates(parsed?.dates);
  const references = sanitizeReferences(parsed?.references);
  const confidence = numberOrNull(parsed?.extraction_confidence) ?? 0;
  const documentTypeGuess = capString(parsed?.document_type_guess, LABEL_MAX_LEN) || 'unknown';
  const summaryText = capString(parsed?.summary_text, SUMMARY_TEXT_MAX_LEN) || '';

  // vendor_name: ONLY from supplier or merchant roles
  const vendorParty = parties.find((p) => VENDOR_ALLOWED_ROLES.has(p.role)) || null;
  const vendorName = vendorParty ? vendorParty.name.slice(0, NAME_MAX_LEN) : null;

  // customer_name: ONLY from customer role, and only if vendor_name is set
  let customerName = null;
  if (vendorName) {
    const customerParty = parties.find((p) => CUSTOMER_ALLOWED_ROLES.has(p.role)) || null;
    customerName = customerParty ? customerParty.name.slice(0, NAME_MAX_LEN) : null;
  }

  // total_amount: role-gated with priority amount_paid > amount_due > total_gross
  // NOT "largest amount"
  let totalAmount = null;
  let totalCurrency = null;
  for (const role of TOTAL_AMOUNT_ROLE_PRIORITY) {
    const match = amounts.find((a) => a.role === role);
    if (match) {
      totalAmount = match.value;
      totalCurrency = normalizeCurrency(match.currency);
      break;
    }
  }

  // Payment confirmation extractions often report the payment leg with
  // a sign (e.g. Amex statement: amount_paid = -941.42 representing a
  // credit-card payment outflow). The matcher math and chip-display
  // logic both want the magnitude — auto-categorisation that compares
  // against a signed bank txn amount silently fails when one side is
  // negative. Coerce to absolute value at the writer boundary so
  // downstream consumers see the canonical positive total.
  if (
    totalAmount != null &&
    documentTypeGuess.toLowerCase() === 'payment_confirmation'
  ) {
    totalAmount = Math.abs(totalAmount);
  }

  // document_date: role-gated with priority document_date > issue_date > payment_date
  // NOT "first date"
  let documentDate = null;
  for (const role of DOCUMENT_DATE_ROLE_PRIORITY) {
    const match = dates.find((d) => d.role === role);
    if (match) {
      documentDate = match.value;
      break;
    }
  }

  // due_date: from due_date role if present
  const dueDateEntry = dates.find((d) => d.role === 'due_date');
  const dueDate = dueDateEntry ? dueDateEntry.value : null;

  // reference_number = first reference value
  const referenceNumber = references.length > 0
    ? references[0].value.slice(0, VALUE_MAX_LEN)
    : null;

  const header = {
    vendor_name: vendorName,
    customer_name: customerName,
    document_date: documentDate,
    due_date: dueDate,
    total_amount: totalAmount,
    currency: totalCurrency,
    tax_amount: null,
    reference_number: referenceNumber,
    payment_status: 'unknown',
    extraction_confidence: confidence
  };

  const warnings = Array.isArray(parsed?.warnings)
    ? parsed.warnings.map((w) => String(w).slice(0, 200)).slice(0, 6)
    : [];

  const confidenceEnvelope = calibrate(confidence, {
    model: 'generic_document_extractor',
    source: 'extraction'
  });

  const summary = {
    source: 'async_parse',
    prompt_version: GENERIC_DOCUMENT_PROMPT_VERSION,
    document_type: 'generic_document',
    document_type_guess: documentTypeGuess,
    parties,
    amounts,
    dates,
    references,
    summary_text: summaryText,
    extraction_status: parsed?.extraction_status || 'failed',
    extraction_confidence: confidence,
    confidence_envelope: confidenceEnvelope,
    warnings,
    line_count: 0,
    coded_line_count: 0,
    review_line_count: 0
  };

  // The model id in the lineage is a receipt of the call that actually
  // ran — threaded from the extractor's resolved config, never
  // hardcoded (a hardcoded id silently lies the moment the default or
  // an env knob changes).
  summary.decision_lineage = buildLineageForGenericProjection({
    header, parties, amounts, dates,
    confidence: confidenceEnvelope,
    model_id: modelId || 'unknown',
    prompt_version: 'evidence-v2'
  });

  return { header, summary, lines: [] };
};

// ── OpenAI call ──────────────────────────────────────────────────────

const defaultCallOpenAi = async ({ apiKey, model, dataUrl, filename, signal }) =>
  fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    signal,
    body: JSON.stringify({
      model,
      store: false,
      instructions: INSTRUCTIONS,
      input: [
        {
          role: 'user',
          content: [
            buildResponsesDocumentPart({ dataUrl, filename }),
            { type: 'input_text', text: 'Extract all structured data from this document per the schema.' }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'generic_document_extraction',
          strict: true,
          schema: GENERIC_DOCUMENT_EXTRACTION_SCHEMA
        }
      }
    })
  });

// ── Public extractor ─────────────────────────────────────────────────
//
// Same discriminated-union contract as receipt.js / supplierBill.js:
//   { kind: 'completed', header, summary, lines }
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason }
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_UNREADABLE', reason }

export const extractGenericDocumentFromBase64 = async ({
  base64,
  filename = '',
  mimeType = '',
  __callOpenAi = defaultCallOpenAi
} = {}) => {
  const startedAt = Date.now();
  const correlationId = filenameCorrelationId(filename);
  const config = getOpenAiConfig();

  if (!config.apiKey) {
    console.warn('[genericDocument] OPENAI_API_KEY not configured', { correlation_id: correlationId });
    return {
      kind: 'failed',
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'openai_not_configured'
    };
  }

  const clean = trimBase64(base64);
  if (!clean) {
    return {
      kind: 'failed',
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
      signal: controller.signal
    });
  } catch (err) {
    if (isProviderSpendLimit(err)) throw err;
    console.error('[genericDocument] OpenAI request threw', {
      correlation_id: correlationId,
      error_code: err?.code || null,
      error_name: err?.name || null,
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
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
    console.error('[genericDocument] OpenAI returned non-OK', {
      correlation_id: correlationId,
      status,
      elapsed_ms: Date.now() - startedAt
    });
    return extractionFailureForStatus(status, { providerError });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: 'failed',
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'response_not_json'
    };
  }

  const text = outputTextFromResponse(payload);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[genericDocument] structured response was not valid JSON', {
      correlation_id: correlationId,
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'structured_bad_json'
    };
  }

  const confidence = Number(parsed?.extraction_confidence || 0);
  if (parsed?.extraction_status === 'failed' || confidence < UNREADABLE_CONFIDENCE_FLOOR) {
    console.warn('[genericDocument] extraction below floor', {
      correlation_id: correlationId,
      extraction_status: parsed?.extraction_status || null,
      confidence_band: confidence < 0.1 ? '<0.1' : confidence < 0.25 ? '0.1-0.25' : '>=0.25',
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      code: 'DOCUMENT_EXTRACTION_UNREADABLE',
      reason: parsed?.extraction_status === 'failed' ? 'extractor_status_failed' : 'low_confidence'
    };
  }

  const { header, summary, lines } = mapExtractionToWriterShape(parsed, { modelId: config.model });

  console.log('[genericDocument] extraction complete', {
    correlation_id: correlationId,
    extraction_status: summary.extraction_status,
    document_type_guess: summary.document_type_guess,
    has_vendor: Boolean(header.vendor_name),
    has_customer: Boolean(header.customer_name),
    has_date: Boolean(header.document_date),
    has_total: header.total_amount != null,
    has_currency: Boolean(header.currency),
    party_count: summary.parties.length,
    amount_count: summary.amounts.length,
    date_count: summary.dates.length,
    reference_count: summary.references.length,
    confidence_band: confidence < 0.5 ? '<0.5' : confidence < 0.8 ? '0.5-0.8' : '>=0.8',
    warning_count: summary.warnings.length,
    elapsed_ms: Date.now() - startedAt
  });

  return { kind: 'completed', header, summary, lines };
};

// Exported for tests so they can assert the schema shape and mapping
// without running the LLM.
export const __GENERIC_DOCUMENT_EXTRACTION_SCHEMA = GENERIC_DOCUMENT_EXTRACTION_SCHEMA;
export const __mapExtractionToWriterShape = mapExtractionToWriterShape;
export const __DEFAULT_MODEL = DEFAULT_MODEL;
export const __VENDOR_ALLOWED_ROLES = VENDOR_ALLOWED_ROLES;
export const __TOTAL_AMOUNT_ROLE_PRIORITY = TOTAL_AMOUNT_ROLE_PRIORITY;
export const __DOCUMENT_DATE_ROLE_PRIORITY = DOCUMENT_DATE_ROLE_PRIORITY;
export const __AMOUNT_ROLE_VALUES = AMOUNT_ROLE_VALUES;
export const __PARTY_ROLE_VALUES = PARTY_ROLE_VALUES;
export const __DATE_ROLE_VALUES = DATE_ROLE_VALUES;
