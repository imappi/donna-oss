// Contract extraction — PR 18.
//
// Third doc-type extractor in the wave (after receipts / PR 1, bills /
// PR 6, sales invoices / PR 7). Contracts differ from bills + invoices
// in three load-bearing ways:
//
//   1. No `lines`. Contracts don't have per-line billing rows; a
//      payment schedule (milestone installments) is a distinct concept
//      and is OUT OF SCOPE for v1. The extractor returns `lines: []`
//      always; the writer treats this as a documents-row-only write
//      (no document_lines INSERTs).
//
//   2. No `payment_terms_phrase`. Contracts DEFINE the terms — they
//      don't reference an external invoice deadline. The relevant
//      dates are effective_start_date / effective_end_date, which
//      land on parse_summary.
//
//   3. New shape: `contract_type` enum (service_subscription /
//      services_one_off / goods_purchase / employment / loan / lease
//      / nda / other), plus `recurring_amount` + `recurring_frequency`
//      for subscription-style contracts. A one-off contract sets
//      total_amount; a recurring contract sets recurring_amount +
//      frequency.
//
// counterparty_role: 'vendor' on contracts the firm signed WITH a
// supplier (firm consumes), 'customer' on contracts the firm signed
// WITH a customer (firm provides). Mirrors the bill / invoice
// vendor_name vs customer_name discipline: the firm's own name is
// NEVER written.
//
// PII policy mirrors supplierBill.js / salesInvoice.js: never log
// free-text extracted fields. Hash a correlation id from the
// filename; surface only counts + confidence bands in logs.
//
// payment_status defaults to 'unknown' on contracts — contracts
// aren't "paid" in the same sense as invoices/bills. The semantic
// for contracts is contract_status (Active / Expired / Terminated)
// which is computed downstream from effective dates. v1 doesn't
// surface that chip — the inbox just shows the contract row.

import crypto from 'node:crypto';
import { normalizeIsoOrDayFirstDate, normalizeIsoCurrency } from './parsePrimitives.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  REFERENCE_TYPE_PRIORITY
} from './receipt.js';
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

// Contract extraction is a load-bearing call: its output (counterparty +
// direction, obligations) is persisted and reasoned about downstream, so per
// the trust-the-strong-LLM principle (CLAUDE.md, docs/donna-llm-trust-strategy.md)
// it defaults to gpt-5.4, not the nano — matching salesInvoice / supplierBill /
// receipt. CONTRACT_EXTRACTOR_MODEL stays the per-deploy tuning knob (the
// OPENAI_MODEL fallback ended 2026-11-10: no provider-wide knob).
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
export const CONTRACT_PROMPT_VERSION = 'contract-extraction-v1';
const REQUEST_TIMEOUT_MS = 60_000;
const UNREADABLE_CONFIDENCE_FLOOR = 0.3;

const COUNTERPARTY_ROLE_VALUES = ['vendor', 'customer'];

export const CONTRACT_TYPE_VALUES = Object.freeze([
  'service_subscription',
  'services_one_off',
  'goods_purchase',
  'employment',
  'loan',
  'lease',
  'nda',
  'other'
]);

export const RECURRING_FREQUENCY_VALUES = Object.freeze([
  'monthly',
  'quarterly',
  'semi_annual',
  'annual',
  'none'
]);

export const OBLIGATION_TYPE_VALUES = Object.freeze([
  'recurring_payment',
  'one_time_payment',
  'deposit',
  'revenue_commitment',
  'loan_repayment',
  'interest',
  'termination_fee',
  'rent',
  'service_fee',
  'insurance_premium'
]);

export const OBLIGATION_FREQUENCY_VALUES = Object.freeze([
  'monthly',
  'quarterly',
  'semi_annual',
  'annual',
  'one_time',
  'on_demand'
]);

export const OBLIGATION_PARTY_ROLE_VALUES = Object.freeze([
  'provider',
  'client',
  'landlord',
  'tenant',
  'lender',
  'borrower',
  'licensor',
  'licensee',
  'employer',
  'employee',
  'party'
]);

const OBLIGATIONS_MAX = 10;
const EVIDENCE_SNIPPET_MAX = 300;

const isContractObligationsEnabled = () =>
  String(process.env.CONTRACT_OBLIGATIONS_ENABLED || '').toLowerCase() === 'true';

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

// The lane's model knob pins the provider by id; no provider-wide knob.
const getOpenAiConfig = () => resolveDocumentLaneProvider({
  laneId: 'type_extractors_legacy',
  dotEnv: readDotEnv(),
  modelEnvKeys: ['CONTRACT_EXTRACTOR_MODEL'],
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

const isoDate = normalizeIsoOrDayFirstDate;

const normalizeCurrency = normalizeIsoCurrency;

const normalizeContractType = (value) => {
  const str = String(value || '').toLowerCase();
  return CONTRACT_TYPE_VALUES.includes(str) ? str : 'other';
};

const normalizeRecurringFrequency = (value) => {
  const str = String(value || '').toLowerCase();
  return RECURRING_FREQUENCY_VALUES.includes(str) ? str : 'none';
};

const sanitizeText = (value, maxLength) => {
  if (value == null) return null;
  const cleaned = String(value).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
};

// JSON schema for the OpenAI Responses-API strict mode. Same shape
// discipline as bill / invoice — every property in `required`,
// `additionalProperties: false` everywhere.

const OBLIGATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'obligation_type',
    'payer',
    'payee',
    'payer_role',
    'payee_role',
    'amount',
    'currency',
    'frequency',
    'start_date',
    'end_date',
    'due_day',
    'escalation_clause',
    'tax_clause',
    'confidence',
    'source_evidence'
  ],
  properties: {
    obligation_type: { type: 'string', enum: [...OBLIGATION_TYPE_VALUES] },
    payer: { type: ['string', 'null'] },
    payee: { type: ['string', 'null'] },
    payer_role: { type: 'string', enum: [...OBLIGATION_PARTY_ROLE_VALUES] },
    payee_role: { type: 'string', enum: [...OBLIGATION_PARTY_ROLE_VALUES] },
    amount: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    frequency: { type: 'string', enum: [...OBLIGATION_FREQUENCY_VALUES] },
    start_date: { type: ['string', 'null'] },
    end_date: { type: ['string', 'null'] },
    due_day: { type: ['number', 'null'] },
    escalation_clause: { type: ['string', 'null'] },
    tax_clause: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    source_evidence: { type: ['string', 'null'] }
  }
};

const HEADER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'counterparty_name',
    'counterparty_role',
    'contract_type',
    'document_date',
    'effective_start_date',
    'effective_end_date',
    'auto_renew',
    'notice_period_days',
    'currency',
    'total_amount',
    'recurring_amount',
    'recurring_frequency',
    'reference_number',
    'references'
  ],
  properties: {
    counterparty_name: { type: ['string', 'null'] },
    counterparty_role: { type: 'string', enum: COUNTERPARTY_ROLE_VALUES },
    contract_type: { type: 'string', enum: [...CONTRACT_TYPE_VALUES] },
    document_date: { type: ['string', 'null'] },
    effective_start_date: { type: ['string', 'null'] },
    effective_end_date: { type: ['string', 'null'] },
    auto_renew: { type: ['boolean', 'null'] },
    notice_period_days: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    total_amount: { type: ['number', 'null'] },
    recurring_amount: { type: ['number', 'null'] },
    recurring_frequency: {
      type: 'string',
      enum: [...RECURRING_FREQUENCY_VALUES]
    },
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
              'contract_number',
              'agreement_number',
              'order_id',
              'invoice_number',
              'transaction_id',
              'other'
            ]
          },
          value: { type: 'string' }
        }
      }
    }
  }
};

const buildExtractionSchema = ({ includeObligations = false } = {}) => {
  const required = [
    'extraction_status',
    'extraction_confidence',
    'header',
    'warnings'
  ];
  const properties = {
    extraction_status: { type: 'string', enum: ['validated', 'partial', 'failed'] },
    extraction_confidence: { type: 'number' },
    warnings: { type: 'array', items: { type: 'string' } },
    header: HEADER_SCHEMA
  };
  if (includeObligations) {
    required.push('obligations');
    properties.obligations = {
      type: 'array',
      items: OBLIGATION_SCHEMA
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties
  };
};

const CONTRACT_EXTRACTION_SCHEMA = buildExtractionSchema({ includeObligations: false });
const CONTRACT_EXTRACTION_SCHEMA_WITH_OBLIGATIONS = buildExtractionSchema({ includeObligations: true });

const INSTRUCTIONS = `You are extracting fields from a single business contract or agreement.

Return only the requested structured object.

DIRECTION (counterparty_role):
- "vendor": the contract is between the firm (a customer/buyer) and a SUPPLIER. Examples: a SaaS subscription the firm signed up for, an office lease the firm rents, a loan agreement the firm took out, a service contract the firm pays for.
- "customer": the contract is between the firm (a supplier/seller) and a CUSTOMER. Examples: a master service agreement the firm signed with a customer, a statement of work the firm agreed to perform.

The firm is whichever party is RECEIVING money / providing service if counterparty_role="customer", or SENDING money / receiving service if counterparty_role="vendor". Use the obligation flow to infer direction. If the contract is purely informational (NDA, partnership MOU), pick the role that matches the dominant economic obligation; default to "vendor" if no money flows at all.

COUNTERPARTY IDENTIFICATION (counterparty_name): the OTHER party. NEVER return the firm's own name. If the firm's name is clearly the entity on one side ("Acme Pte Ltd" matches the firm), return the OTHER party. If you cannot confidently identify the counterparty, return null.

DO NOT use as counterparty:
- Signatory individuals' names (these are people who signed on behalf of an entity).
- Witness names.
- Legal entity types alone ("LLP", "Pte Ltd") without a brand name.

CONTRACT TYPE (contract_type):
- service_subscription: recurring SaaS, cloud, telecom, utilities, content subscriptions.
- services_one_off: a fixed-deliverable services agreement (consulting engagement, project work, design retainer).
- goods_purchase: a contract to buy goods (capex, inventory) with delivery.
- employment: employment contracts, contractor agreements with individuals.
- loan: loan agreements, credit facilities, financing arrangements.
- lease: equipment lease, vehicle lease, office rental.
- nda: non-disclosure / confidentiality agreement.
- other: anything that doesn't fit (partnership agreement, shareholder agreement, MOU).

DATES (all in YYYY-MM-DD form):
- document_date: the date the contract was signed / executed.
- effective_start_date: when obligations begin. Often equals document_date but not always.
- effective_end_date: explicit expiry / termination date. NULL for indefinite or evergreen contracts (most NDAs, employment agreements).
- auto_renew: true if the contract auto-renews at expiry unless cancelled. false if termination is explicit. null if not specified.
- notice_period_days: termination notice required, in days. 30 for "30 days notice", 90 for "three months notice", etc. null if not specified.

AMOUNTS:
- total_amount: ONE-OFF contract value. The full contract price for a fixed-deliverable agreement (e.g. "consulting engagement for $50,000"). Leave null for subscription-style contracts.
- recurring_amount: per-period payment for a subscription / lease / loan installment.
- recurring_frequency: the cadence of recurring_amount. "monthly" / "quarterly" / "semi_annual" / "annual" / "none" (use "none" when not recurring; total_amount carries the value instead).

For employment contracts, recurring_amount + "monthly" frequency is the typical shape (monthly salary).
For loans, recurring_amount + "monthly" / "quarterly" is the typical shape (installment amount).
For SaaS, recurring_amount + the billing cycle is the typical shape.
For services_one_off, total_amount is the typical shape and recurring_frequency is "none".
For NDAs without monetary terms, both amounts are null and recurring_frequency is "none".

REFERENCES — capture structured identifiers as a list:
- contract_number: the contract's own identifier (e.g. "MSA-2024-042", "AG-PR-001").
- agreement_number: agreement-specific id when distinct from contract_number.
- order_id: associated PO number if the contract references one.
- invoice_number: related invoice ids if the contract references them.
- transaction_id: payment gateway ids if any.
- other: any other structured identifier.

DO NOT include personal phone numbers, addresses, dates, or amounts as references.

reference_number (legacy single field): leave as null — the writer picks the highest-priority entry from references.

extraction_confidence is your 0–1 confidence the extracted values are usable. extraction_status is "validated" when every required field was readable, "partial" when some were readable, "failed" if you couldn't read enough.`;

const OBLIGATIONS_INSTRUCTIONS_ADDENDUM = `

OBLIGATIONS:
Extract all financial obligations defined in this contract. Each obligation represents an expected recurring or one-time financial event.

For each obligation:
- obligation_type: the nature of the payment flow:
  - "recurring_payment": generic recurring payment (subscription, retainer)
  - "one_time_payment": a single payment event (project milestone, signing fee)
  - "deposit": security deposit, bond, or upfront holdback
  - "revenue_commitment": minimum spend or revenue guarantee
  - "loan_repayment": principal repayment installment
  - "interest": interest payment (separate from principal)
  - "termination_fee": early termination or break fee
  - "rent": property or equipment rental payment
  - "service_fee": management fee, platform fee, maintenance fee
  - "insurance_premium": insurance premium payment

- payer / payee: the entity name paying / receiving. Use the contract parties' names.
- payer_role / payee_role: the role of each party in this obligation context:
  - "provider" / "client": service provider and service consumer
  - "landlord" / "tenant": property context
  - "lender" / "borrower": loan context
  - "licensor" / "licensee": IP/software licensing context
  - "employer" / "employee": employment context
  - "party": when no specific role applies

- amount: the monetary value per occurrence (monthly rent, installment amount, deposit amount). null if not specified.
- currency: ISO 4217 code. null if not specified.
- frequency: how often: "monthly", "quarterly", "semi_annual", "annual", "one_time", "on_demand".
- start_date / end_date: YYYY-MM-DD. When the obligation begins and ends. null if not specified.
- due_day: day of month (1-31) when payment is due for recurring obligations. null if not specified or one-time.
- escalation_clause: text of any price escalation provision (e.g., "3% annual increase", "CPI-linked"). null if none.
- tax_clause: text of tax treatment (e.g., "plus VAT", "inclusive of GST"). null if none.
- confidence: 0-1 confidence that this obligation is correctly extracted.
- source_evidence: the key phrase or clause from the contract that defines this obligation. Keep under 300 chars.

Extract ALL distinct obligations. A lease contract may have rent (recurring), deposit (one_time), and insurance (recurring) as separate obligations. An employment contract has salary (recurring) and possibly a signing bonus (one_time).

If no financial obligations are found (e.g., an NDA), return an empty obligations array.`;

const CONTRACT_REFERENCE_TYPES = new Set([
  'contract_number',
  'agreement_number',
  'order_id',
  'invoice_number',
  'transaction_id',
  'other'
]);

// Contracts pick the primary reference using contract_number first,
// then agreement_number, then the receipt-shared priority for the
// remaining types. Mirrors the existing REFERENCE_TYPE_PRIORITY
// pattern in receipt.js / supplierBill.js.
export const CONTRACT_REFERENCE_TYPE_PRIORITY = Object.freeze([
  'contract_number',
  'agreement_number',
  'order_id',
  'invoice_number',
  ...REFERENCE_TYPE_PRIORITY.filter((t) => !['order_id', 'invoice_number'].includes(t))
]);

const sanitizeReferences = (rawReferences) => {
  if (!Array.isArray(rawReferences)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of rawReferences) {
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof entry.type === 'string' && CONTRACT_REFERENCE_TYPES.has(entry.type)
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

const OBLIGATION_TYPE_SET = new Set(OBLIGATION_TYPE_VALUES);
const OBLIGATION_FREQUENCY_SET = new Set(OBLIGATION_FREQUENCY_VALUES);
const OBLIGATION_PARTY_ROLE_SET = new Set(OBLIGATION_PARTY_ROLE_VALUES);

const sanitizeObligations = (rawObligations) => {
  if (!Array.isArray(rawObligations)) return [];
  const out = [];
  for (const entry of rawObligations) {
    if (!entry || typeof entry !== 'object') continue;
    const obligationType = typeof entry.obligation_type === 'string' && OBLIGATION_TYPE_SET.has(entry.obligation_type)
      ? entry.obligation_type
      : null;
    if (!obligationType) continue;
    const frequency = typeof entry.frequency === 'string' && OBLIGATION_FREQUENCY_SET.has(entry.frequency)
      ? entry.frequency
      : 'one_time';
    const payerRole = typeof entry.payer_role === 'string' && OBLIGATION_PARTY_ROLE_SET.has(entry.payer_role)
      ? entry.payer_role
      : 'party';
    const payeeRole = typeof entry.payee_role === 'string' && OBLIGATION_PARTY_ROLE_SET.has(entry.payee_role)
      ? entry.payee_role
      : 'party';
    out.push({
      obligation_type: obligationType,
      payer: sanitizeText(entry.payer, COUNTERPARTY_NAME_MAX),
      payee: sanitizeText(entry.payee, COUNTERPARTY_NAME_MAX),
      payer_role: payerRole,
      payee_role: payeeRole,
      amount: numberOrNull(entry.amount),
      currency: normalizeCurrency(entry.currency),
      frequency,
      start_date: isoDate(entry.start_date),
      end_date: isoDate(entry.end_date),
      due_day: (() => {
        const d = numberOrNull(entry.due_day);
        return d !== null && Number.isInteger(d) && d >= 1 && d <= 31 ? d : null;
      })(),
      escalation_clause: sanitizeText(entry.escalation_clause, EVIDENCE_SNIPPET_MAX),
      tax_clause: sanitizeText(entry.tax_clause, EVIDENCE_SNIPPET_MAX),
      confidence: Math.max(0, Math.min(1, numberOrNull(entry.confidence) ?? 0)),
      source_evidence: sanitizeText(entry.source_evidence, EVIDENCE_SNIPPET_MAX)
    });
    if (out.length >= OBLIGATIONS_MAX) break;
  }
  return out;
};

const pickPrimaryReferenceValue = (references, legacyValue) => {
  if (Array.isArray(references) && references.length) {
    for (const preferredType of CONTRACT_REFERENCE_TYPE_PRIORITY) {
      const found = references.find((ref) => ref.type === preferredType);
      if (found?.value) return found.value;
    }
  }
  if (legacyValue && typeof legacyValue === 'string') {
    return legacyValue.trim().slice(0, REFERENCE_VALUE_MAX) || null;
  }
  return null;
};

// Map raw LLM response to writer-shape contract.
//   - `header` lands on the documents row. vendor_name / customer_name
//     split by counterparty_role mirrors the bill / invoice pattern:
//     vendor contracts populate vendor_name, customer contracts
//     populate customer_name. The firm's own name is never written.
//   - `header.total_amount` reflects the ONE-OFF total when the
//     contract is one-off; for subscriptions it carries the per-period
//     amount so the inbox can render a sensible "amount" column.
//     `parse_summary` carries the breakdown (recurring_amount +
//     recurring_frequency) so consumers can disambiguate.
//   - `header.due_date` is NULL. Effective dates land on parse_summary.
//     Conflating effective_end_date with due_date would pollute the
//     aging dashboards' due-date semantics.
//   - `header.payment_status` is 'unknown'. Contracts aren't "paid";
//     they have a separate contract_status dimension which v2 may
//     surface.
//   - `summary` carries the contract-specific shape (contract_type,
//     effective dates, recurring fields, auto_renew, notice_period_days).
//   - `lines` is always [] — contracts don't have line items in v1.
const mapExtractionToWriterShape = (parsed) => {
  const llmHeader = parsed.header || {};
  const counterpartyName = sanitizeText(llmHeader.counterparty_name, COUNTERPARTY_NAME_MAX);
  const llmRole = String(llmHeader.counterparty_role || '').toLowerCase();
  const counterpartyRole = COUNTERPARTY_ROLE_VALUES.includes(llmRole) ? llmRole : 'vendor';
  const contractType = normalizeContractType(llmHeader.contract_type);
  const references = sanitizeReferences(llmHeader.references);
  const referenceNumber = pickPrimaryReferenceValue(references, llmHeader.reference_number);

  const totalAmount = numberOrNull(llmHeader.total_amount);
  const recurringAmount = numberOrNull(llmHeader.recurring_amount);
  const recurringFrequency = normalizeRecurringFrequency(llmHeader.recurring_frequency);
  // Header-level total: prefer the one-off total when present; fall
  // back to the recurring amount so the inbox's amount column has a
  // sensible default. The breakdown lives on parse_summary.
  const headerTotal = totalAmount != null ? totalAmount : recurringAmount;

  const header = {
    // Direction-flip mirrors bill (vendor populated) vs invoice
    // (customer populated). Firm's own name is never written either
    // way — same invariant the bill + invoice extractors enforce.
    vendor_name: counterpartyRole === 'vendor' ? counterpartyName : null,
    customer_name: counterpartyRole === 'customer' ? counterpartyName : null,
    document_date: isoDate(llmHeader.document_date),
    // due_date stays null on contracts — conflating it with
    // effective_end_date would pollute the AR/AP aging dashboards.
    due_date: null,
    total_amount: headerTotal,
    currency: normalizeCurrency(llmHeader.currency),
    tax_amount: null,
    reference_number: referenceNumber,
    payment_status: 'unknown',
    extraction_confidence: numberOrNull(parsed.extraction_confidence)
  };

  const effectiveStart = isoDate(llmHeader.effective_start_date);
  const effectiveEnd = isoDate(llmHeader.effective_end_date);
  const autoRenew = typeof llmHeader.auto_renew === 'boolean' ? llmHeader.auto_renew : null;
  const noticePeriodDays = numberOrNull(llmHeader.notice_period_days);

  const obligations = isContractObligationsEnabled()
    ? sanitizeObligations(parsed.obligations)
    : [];

  const summary = {
    source: 'async_parse',
    prompt_version: CONTRACT_PROMPT_VERSION,
    document_type: 'contract',
    counterparty_name: counterpartyName,
    counterparty_role: counterpartyRole,
    contract_type: contractType,
    document_date: header.document_date,
    effective_start_date: effectiveStart,
    effective_end_date: effectiveEnd,
    auto_renew: autoRenew,
    notice_period_days: noticePeriodDays,
    currency: header.currency,
    total_amount: totalAmount,
    recurring_amount: recurringAmount,
    recurring_frequency: recurringFrequency,
    references,
    obligations,
    obligation_count: obligations.length,
    line_count: 0,
    coded_line_count: 0,
    review_line_count: 0,
    extraction_status: parsed.extraction_status,
    extraction_confidence: header.extraction_confidence,
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.map((w) => String(w).slice(0, 200)).slice(0, 6)
      : []
  };

  const lines = [];

  return { header, summary, lines };
};

const buildDefaultCall = (send) => async ({ apiKey, model, dataUrl, filename, signal, includeObligations = false }) =>
  send({
    apiKey,
    signal,
    body: {
      model,
      store: false,
      instructions: includeObligations
        ? INSTRUCTIONS + OBLIGATIONS_INSTRUCTIONS_ADDENDUM
        : INSTRUCTIONS,
      input: [
        {
          role: 'user',
          content: [
            buildResponsesDocumentPart({ dataUrl, filename, fallbackFilename: 'contract.pdf' }),
            {
              type: 'input_text',
              text: includeObligations
                ? 'Extract the contract header and all financial obligations per the schema.'
                : 'Extract the contract header per the schema.'
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'contract_extraction',
          strict: true,
          schema: includeObligations
            ? CONTRACT_EXTRACTION_SCHEMA_WITH_OBLIGATIONS
            : CONTRACT_EXTRACTION_SCHEMA
        }
      }
    }
  });

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
    promptVersion: CONTRACT_PROMPT_VERSION,
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
  promptVersion: CONTRACT_PROMPT_VERSION,
  signal
});

const defaultCallOpenAi = buildDefaultCall(sendOpenAi);
const defaultCallAnthropic = buildDefaultCall(sendAnthropic);

// Public extractor — same discriminated-union shape as receipt /
// supplierBill / salesInvoice so the worker's dispatch branch can
// call any of them interchangeably.
//
//   { kind: 'completed', header, summary, lines }
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED' }     // retryable (5xx/timeout/429/network)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_REJECTED' }   // terminal (deterministic 4xx)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_UNREADABLE' } // terminal
export const extractContractFromBase64 = async ({
  base64,
  filename = '',
  mimeType = '',
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
    console.warn('[contract] no model provider key configured', { correlation_id: correlationId, reason: notConfigured });
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
  const includeObligations = isContractObligationsEnabled();

  let reply;
  try {
    reply = await readDocumentLaneReply({
      provider: config.provider,
      callOpenAi: () => __callOpenAi({
      apiKey: config.apiKey,
      model: config.model,
      dataUrl,
      filename,
      signal: controller.signal,
      includeObligations
      }),
      callAnthropic: () => __callAnthropic({
      apiKey: config.apiKey,
      model: config.model,
      dataUrl,
      filename,
      signal: controller.signal,
      includeObligations
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
    console.error('[contract] provider request threw', {
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
    console.error('[contract] provider returned non-OK', {
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
    console.error('[contract] provider stopped without a usable reply', {
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
    console.error('[contract] structured response was not valid JSON', {
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
    console.warn('[contract] extraction below floor', {
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

  console.log('[contract] extraction complete', {
    correlation_id: correlationId,
    extraction_status: summary.extraction_status,
    contract_type: summary.contract_type,
    counterparty_role: summary.counterparty_role,
    has_counterparty: Boolean(summary.counterparty_name),
    has_effective_start: Boolean(summary.effective_start_date),
    has_effective_end: Boolean(summary.effective_end_date),
    has_total: header.total_amount != null,
    has_recurring: summary.recurring_amount != null,
    recurring_frequency: summary.recurring_frequency,
    has_currency: Boolean(header.currency),
    obligation_count: summary.obligation_count,
    confidence_band: confidence < 0.5 ? '<0.5' : confidence < 0.8 ? '0.5-0.8' : '>=0.8',
    warning_count: summary.warnings.length,
    elapsed_ms: Date.now() - startedAt
  });

  return { kind: 'completed', ...served, header, summary, lines };
};

// Test seams.
export const __CONTRACT_EXTRACTION_SCHEMA = CONTRACT_EXTRACTION_SCHEMA;
export const __CONTRACT_EXTRACTION_SCHEMA_WITH_OBLIGATIONS = CONTRACT_EXTRACTION_SCHEMA_WITH_OBLIGATIONS;
export const __mapExtractionToWriterShape = mapExtractionToWriterShape;
export const __sanitizeObligations = sanitizeObligations;
