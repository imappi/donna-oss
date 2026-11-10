// Reconciliation PR 2 — receipt semantic classifier.
//
// Adds semantic metadata to parsed receipts via a text-only OpenAI
// Responses-API call. The classifier is the LLM half of the plan's
// "use LLMs for semantic understanding, use deterministic code for
// final action" invariant. It writes ONE sub-object onto
// `documents.parse_summary.semantic` (via the worker → writer path)
// and emits ONE PII-safe audit event per receipt. It NEVER writes
// `reconciliation_matches`, `transactions`, `transaction_review_queue`,
// or `client_rules`. It NEVER blocks the parse — every failure path
// returns a deterministic fallback `SemanticOutput`.
//
// PII policy (carries over from receipt.js): never log raw vendor
// names, reference numbers, line descriptions, OCR text, or any
// other free-text extracted field. Diagnostic logs in this module
// carry the correlation id + structured categorical outcome only.

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { CATEGORY_ACCOUNTS, canonicalMerchantPattern } from './transactionIntel.js';
import { asProviderResponse, llmCall } from './llmCall.js';
import {
  documentLaneRequestFromResponses,
  notConfiguredFailure,
  readDocumentLaneReply,
  resolveDocumentLaneProvider,
  stopFailureReason
} from './documentLaneRequest.js';
import { classifyModelProvenance } from './providerEndpoints.js';

const DEFAULT_MODEL = 'gpt-5.4-nano';
const REQUEST_TIMEOUT_MS = 30_000;
// 2026-11-10 (the owner's decision that Donna runs on Claude): Anthropic
// first. Labelling an already-extracted receipt from a fixed vocabulary is
// a classification: `low` effort (adaptive thinking cannot be switched off).
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const ANTHROPIC_EFFORT = 'low';
const ANTHROPIC_MAX_TOKENS = 16_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 90_000;

// Version constants — module-local, NOT LLM output. The sanitizer
// attaches these to every SemanticOutput so the LLM cannot spoof a
// stale or hostile version into the persisted payload. PR 3's
// version-compatibility gate reads them from
// `parse_summary.semantic.classifier_version`.
export const RECEIPT_SEMANTIC_VERSION = 'receipt_semantic_v1';
export const RECEIPT_SEMANTIC_PROMPT_VERSION = 'receipt_semantic_prompt_v1';

// Safe list — PR 3 may consider these for auto-explain.
const SAFE_EXPENSE_KINDS = [
  'taxi',
  'public_transport',
  'parking_toll',
  'courier_postage',
  'software_subscription',
  'office_supplies'
];

// Cautious list — PR 3 routes to review by default regardless of
// confidence.
const CAUTIOUS_EXPENSE_KINDS = [
  'restaurant_cafe',
  'hotel_travel',
  'fuel',
  'bank_fee',
  'groceries'
];

export const EXPENSE_KINDS = [
  ...SAFE_EXPENSE_KINDS,
  ...CAUTIOUS_EXPENSE_KINDS,
  'unknown'
];

// De-duped union of CATEGORY_ACCOUNTS values + 'unknown'. Re-uses the
// transactionIntel vocabulary so PR 3 / PR 5 can compare account
// suggestions against the same canonical list the deterministic
// coding pass uses.
const ACCOUNT_LABEL_VALUES = Array.from(new Set(Object.values(CATEGORY_ACCOUNTS)));
export const ACCOUNT_LABELS = [...ACCOUNT_LABEL_VALUES, 'unknown'];

const TAX_SENSITIVITY_VALUES = ['low', 'medium', 'high', 'unknown'];
const MATERIALITY_RISK_VALUES = ['low', 'medium', 'high'];

// Categorical warning tokens the classifier may emit. The sanitizer
// drops anything outside this set so free-text "warnings" can't sneak
// PII through the audit log.
export const SEMANTIC_WARNINGS = [
  'missing_business_purpose',
  'generic_merchant',
  'personal_expense_likely',
  'high_amount_for_category',
  'currency_unusual',
  'date_in_future',
  'multiple_kinds_detected',
  'duplicate_line_items_detected',
  // Emitted by the deterministic fallback, not the LLM. Listed here so
  // the sanitizer's enum guard passes when the fallback path runs.
  'classifier_fallback'
];

// Canonical-pattern → expense_kind lookup. Drives the deterministic
// fallback when the LLM is unavailable. Keys are the strings returned
// by `transactionIntel.canonicalMerchantPattern` for known merchants;
// values are the corresponding `expense_kind` enum members. We
// intentionally keep this small — the fallback is pessimistic, not
// ambitious, and we don't want to add merchant strings without a
// reason to.
const FALLBACK_KIND_BY_CANONICAL = {
  taxi: 'taxi',
  uber: 'taxi',
  cabify: 'taxi',
  bolt: 'taxi',
  grab: 'taxi',
  freenow: 'taxi',
  finnair: 'hotel_travel'
};

// Token-level fallback for vendors that don't collapse to a single
// canonical pattern (e.g. "AWS", "Stripe Billing") but do contain a
// well-known service token. Same merchant set the transactionLlm
// heuristic already uses for Software subscriptions.
const FALLBACK_KIND_BY_TOKEN = {
  aws: 'software_subscription',
  google: 'software_subscription',
  microsoft: 'software_subscription',
  openai: 'software_subscription',
  stripe: 'software_subscription',
  github: 'software_subscription',
  slack: 'software_subscription',
  zoom: 'software_subscription',
  notion: 'software_subscription',
  vercel: 'software_subscription'
};

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
    // Best-effort dotenv fallback for local development.
  }
  dotEnvCache = vars;
  return vars;
};

// RECEIPT_CLASSIFIER_MODEL is the lane knob (its id pins the provider); no
// provider-wide knob.
const getOpenAiConfig = () => resolveDocumentLaneProvider({
  laneId: 'receipt_classification',
  dotEnv: readDotEnv(),
  modelEnvKeys: ['RECEIPT_CLASSIFIER_MODEL'],
  defaultModels: { anthropic: DEFAULT_ANTHROPIC_MODEL, openai: DEFAULT_MODEL }
});

const filenameCorrelationId = (filename = '') =>
  crypto.createHash('sha256').update(String(filename || 'unknown')).digest('hex').slice(0, 12);

// Strip control characters and cap length. Used on every text field
// before it crosses the prompt boundary — `header.vendor_name`,
// reference numbers, line descriptions, etc. all go through here.
// Treats the upstream text as untrusted (prompt-injection defense).
const sanitizeText = (value, maxLength = 200) => {
  if (value === null || value === undefined) return '';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
};

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const clampConfidence = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
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

// LLM schema — strict-mode json_schema body for the Responses API.
// `additionalProperties: false` at every level. All declared fields
// listed in `required`. The metadata fields (classifier_version,
// prompt_version, provider, used_fallback, fallback_reason, model)
// are NOT in this schema — the sanitizer attaches them from module
// constants after parsing, so the LLM cannot influence them.
const RECEIPT_CLASSIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'expense_kind',
    'merchant_display_name',
    'suggested_account_label',
    'tax_sensitivity',
    'business_purpose_guess',
    'evidence_sufficient_signal',
    'confidence',
    'materiality_risk',
    'needs_human_reason',
    'warnings'
  ],
  properties: {
    expense_kind: { type: 'string', enum: EXPENSE_KINDS },
    merchant_display_name: { type: 'string', maxLength: 80 },
    suggested_account_label: { type: 'string', enum: ACCOUNT_LABELS },
    tax_sensitivity: { type: 'string', enum: TAX_SENSITIVITY_VALUES },
    business_purpose_guess: { type: 'string', maxLength: 120 },
    evidence_sufficient_signal: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    materiality_risk: { type: 'string', enum: MATERIALITY_RISK_VALUES },
    needs_human_reason: { type: ['string', 'null'], maxLength: 120 },
    warnings: {
      type: 'array',
      items: { type: 'string', enum: SEMANTIC_WARNINGS }
    }
  }
};

const INSTRUCTIONS = `You classify a single business receipt. Output strictly conforms to the provided JSON schema. Do not invent fields, do not return prose, do not include the raw vendor name in free-text fields.

Categorization rules:
- expense_kind MUST be one of the enum values. If the receipt does not clearly match a category, return "unknown" with a low confidence.
- suggested_account_label MUST be one of the enum values or "unknown". Do not return a free-text account name.
- confidence is your overall confidence in the classification, NOT in the OCR. Clamp [0, 1].
- tax_sensitivity reflects whether this kind of expense typically requires careful tax review. "low" is passenger transport and small office supplies. "medium" is meals, travel, hotels, software. "high" is anything that could plausibly be personal, gifts, entertainment, or alcohol.
- materiality_risk reflects the materiality of misposting. Small recurring receipts are "low"; high-amount or unfamiliar-kind receipts are "medium" or "high".
- evidence_sufficient_signal=true means a reasonable bookkeeper would accept this receipt as sufficient evidence for the expense without additional context. For ambiguous receipts, return false.
- needs_human_reason is a short phrase when you cannot classify confidently (max 120 chars). For the happy path, return null.
- warnings are categorical tokens from the enum, not free-text notes.

You do NOT decide accounting outcomes. You do NOT decide whether the transaction is explained. You suggest categorical signals that a downstream deterministic policy will combine with other evidence.`;

// Pure prompt builder. Receives the extractor's structured output
// (NOT raw OCR / NOT PDF bytes — the receipt.js extractor already did
// vision). Returns { instructions, input } ready to feed into the
// Responses-API call.
export const buildClassifierPrompt = ({
  header = {},
  summary = {},
  lines = [],
  filename = ''
} = {}) => {
  const correlationId = filenameCorrelationId(filename);
  const vendorName = sanitizeText(header.vendor_name, 80);
  const rawLines = Array.isArray(lines) ? lines : [];
  const sanitizedLineDescriptions = rawLines
    .slice(0, 12)
    .map((line) => sanitizeText(line?.description, 80))
    .filter(Boolean);
  // Cap at 12 + a single sentinel — receipts with > 12 lines get the
  // first 12 plus "... N more lines", not the raw remainder. Cost
  // discipline + defense against prompt-injection via long line items.
  const lineDescriptions = rawLines.length > 12
    ? [...sanitizedLineDescriptions, `... ${rawLines.length - 12} more lines`]
    : sanitizedLineDescriptions;

  const inputObject = {
    vendor_name: vendorName,
    canonical_merchant_pattern: canonicalMerchantPattern(vendorName),
    document_date: header.document_date || null,
    total_amount: numberOrNull(header.total_amount),
    currency: header.currency || null,
    tax_amount: numberOrNull(header.tax_amount),
    reference_number: header.reference_number ? sanitizeText(header.reference_number, 40) : null,
    payment_status: header.payment_status || null,
    line_descriptions: lineDescriptions,
    extractor_warnings: Array.isArray(summary.warnings)
      ? summary.warnings.map((w) => sanitizeText(w, 60)).filter(Boolean).slice(0, 8)
      : []
  };

  return {
    instructions: INSTRUCTIONS,
    input: JSON.stringify(inputObject),
    correlation_id: correlationId
  };
};

// Deterministic fallback driven by the canonical merchant pattern.
// Used when:
//   - OPENAI_API_KEY missing
//   - HTTP error from provider
//   - JSON parse failure on the response
//   - sanitize rejected every required field
//   - network error / timeout
// Sets used_fallback=true and provider='deterministic_fallback'.
// Pessimistic by design — confidence ≤ 0.3, materiality_risk='medium',
// evidence_sufficient_signal=false, needs_human_reason='classifier_unavailable'
// — so PR 3's auto-explain gate routes these to review.
export const makeDeterministicSemanticOutput = ({ vendor = '', reason = '' } = {}) => {
  const canonical = canonicalMerchantPattern(vendor);
  let expenseKind = FALLBACK_KIND_BY_CANONICAL[canonical] || 'unknown';
  if (expenseKind === 'unknown' && canonical) {
    for (const token of canonical.split(' ')) {
      if (FALLBACK_KIND_BY_TOKEN[token]) {
        expenseKind = FALLBACK_KIND_BY_TOKEN[token];
        break;
      }
    }
  }
  return {
    expense_kind: expenseKind,
    merchant_display_name: sanitizeText(vendor, 80),
    suggested_account_label: 'unknown',
    tax_sensitivity: 'unknown',
    business_purpose_guess: '',
    evidence_sufficient_signal: false,
    confidence: expenseKind === 'unknown' ? 0.0 : 0.3,
    materiality_risk: 'medium',
    needs_human_reason: 'classifier_unavailable',
    warnings: ['classifier_fallback'],
    classifier_version: RECEIPT_SEMANTIC_VERSION,
    prompt_version: RECEIPT_SEMANTIC_PROMPT_VERSION,
    provider: 'deterministic_fallback',
    used_fallback: true,
    fallback_reason: reason || 'unknown',
    model: null
  };
};

// Pure output sanitizer. Coerces every field into the expected type,
// clamps confidence into [0, 1], drops free-text the schema doesn't
// allow, never throws. The version/provider/used_fallback/fallback_reason
// fields are NOT read from rawOutput — they're attached from module
// constants so a hostile LLM can't spoof them. Mirrors transactionLlm's
// sanitize → fallback → guarded-output pattern.
export const sanitizeClassifierOutput = (rawOutput = {}, { vendor = '', model = '', provider = 'openai' } = {}) => {
  const safeOutput = rawOutput && typeof rawOutput === 'object' ? rawOutput : {};

  const expenseKind = EXPENSE_KINDS.includes(safeOutput.expense_kind)
    ? safeOutput.expense_kind
    : 'unknown';
  const suggestedAccountLabel = ACCOUNT_LABELS.includes(safeOutput.suggested_account_label)
    ? safeOutput.suggested_account_label
    : 'unknown';
  const taxSensitivity = TAX_SENSITIVITY_VALUES.includes(safeOutput.tax_sensitivity)
    ? safeOutput.tax_sensitivity
    : 'unknown';
  const materialityRisk = MATERIALITY_RISK_VALUES.includes(safeOutput.materiality_risk)
    ? safeOutput.materiality_risk
    : 'medium';

  // merchant_display_name: prefer the LLM's value (sanitized + capped),
  // fall back to the extractor's vendor_name. Never null — schema is
  // a plain string.
  const merchantDisplayName =
    sanitizeText(safeOutput.merchant_display_name, 80) ||
    sanitizeText(vendor, 80);

  const businessPurposeGuess = sanitizeText(safeOutput.business_purpose_guess, 120);

  // needs_human_reason can be null. Drop any non-string/non-null.
  let needsHumanReason = null;
  if (typeof safeOutput.needs_human_reason === 'string' && safeOutput.needs_human_reason.length > 0) {
    needsHumanReason = sanitizeText(safeOutput.needs_human_reason, 120) || null;
  }

  // warnings: filter to enum-only, dedupe, cap to a reasonable count.
  const rawWarnings = Array.isArray(safeOutput.warnings) ? safeOutput.warnings : [];
  const warnings = Array.from(
    new Set(
      rawWarnings
        .filter((w) => typeof w === 'string' && SEMANTIC_WARNINGS.includes(w))
    )
  ).slice(0, 6);

  return {
    expense_kind: expenseKind,
    merchant_display_name: merchantDisplayName,
    suggested_account_label: suggestedAccountLabel,
    tax_sensitivity: taxSensitivity,
    business_purpose_guess: businessPurposeGuess,
    evidence_sufficient_signal: Boolean(safeOutput.evidence_sufficient_signal),
    confidence: clampConfidence(safeOutput.confidence),
    materiality_risk: materialityRisk,
    needs_human_reason: needsHumanReason,
    warnings,
    // Metadata — set here, NOT by the LLM.
    classifier_version: RECEIPT_SEMANTIC_VERSION,
    prompt_version: RECEIPT_SEMANTIC_PROMPT_VERSION,
    provider,
    used_fallback: false,
    fallback_reason: null,
    model: model || null
  };
};

// Default text-only Responses-API call. Indirection via the
// `__callOpenAi` arg is what unit tests hook to inject canned
// responses without touching the network. Mirrors receipt.js's
// `defaultCallOpenAi`, minus the input_file/file_data slot — the
// classifier is text-only, never vision.
// The body is built ONCE (Responses shape): OpenAI sends it as is, the
// Anthropic transport carries it over unchanged.
const buildBody = ({ model, instructions, input }) => ({
  model,
  store: false,
  instructions,
  input,
  text: {
    format: {
      type: 'json_schema',
      name: 'receipt_semantic_classifier',
      strict: true,
      schema: RECEIPT_CLASSIFIER_SCHEMA
    }
  }
});

const EXECUTION = { root: { type: 'receipt_classification', id: 'semantic' } };

const defaultCallOpenAi = async ({ apiKey, signal, ...args }) => asProviderResponse(llmCall({
  provider: 'openai',
  url: 'https://api.openai.com/v1/responses',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: buildBody(args),
  sections: { system: args.instructions, tools: RECEIPT_CLASSIFIER_SCHEMA },
  execution: EXECUTION,
  promptVersion: RECEIPT_SEMANTIC_PROMPT_VERSION,
  fetchImpl: (url, init) => fetch(url, { ...init, signal: init?.signal && signal ? AbortSignal.any([init.signal, signal]) : init?.signal || signal })
}));


// The Anthropic call: the shared structured request (structuredRequest.js,
// via documentLaneRequest.js) through the envelope, called here. llmCall is
// loaded at call time where the module's import graph needs it.
const callAnthropicEnvelope = async (options) => {
  const { llmCall } = await import('./llmCall.js');
  return llmCall(documentLaneRequestFromResponses({ timeoutMs: ANTHROPIC_REQUEST_TIMEOUT_MS, ...options }));
};
const defaultCallAnthropic = async ({ apiKey, signal, ...args }) => callAnthropicEnvelope({
  apiKey,
  body: buildBody(args),
  effort: ANTHROPIC_EFFORT,
  maxTokens: ANTHROPIC_MAX_TOKENS,
  execution: EXECUTION,
  promptVersion: RECEIPT_SEMANTIC_PROMPT_VERSION,
  signal
});

// Async entry point. NEVER throws — provider failures convert to
// deterministic fallback. The parse worker can call this
// unconditionally without a try/catch and the parse will always
// complete with `summary.semantic` populated.
export const classifyReceipt = async ({
  header = {},
  summary = {},
  lines = [],
  filename = '',
  __callOpenAi = defaultCallOpenAi,
  __callAnthropic = defaultCallAnthropic
} = {}) => {
  const vendor = header.vendor_name || '';
  const config = getOpenAiConfig();
  const correlationId = filenameCorrelationId(filename);

  if (!config.ok) {
    // No key: the failure names the provider whose key is missing (the
    // lane's first, Anthropic, unless a pinned model id chose another).
    const { provider: missing, reason: notConfigured } = notConfiguredFailure(config, 'receipt_classification');
    console.warn('[receiptClassifier] no model provider key configured', {
      correlation_id: correlationId,
      reason: notConfigured
    });
    return makeDeterministicSemanticOutput({
      vendor,
      reason: notConfigured
    });
  }

  const { instructions, input } = buildClassifierPrompt({ header, summary, lines, filename });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.provider === 'anthropic' ? ANTHROPIC_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const callArgs = {
    apiKey: config.apiKey,
    model: config.model,
    instructions,
    input,
    signal: controller.signal
  };

  let reply;
  try {
    reply = await readDocumentLaneReply({
      provider: config.provider,
      callOpenAi: () => __callOpenAi(callArgs),
      callAnthropic: () => __callAnthropic(callArgs),
      outputText: outputTextFromResponse
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!reply.ok && reply.kind === 'threw') {
    const err = reply.error;
    console.error('[receiptClassifier] provider request threw', {
      correlation_id: correlationId,
      provider: config.provider,
      error_code: err?.code || null,
      error_name: err?.name || null
    });
    return makeDeterministicSemanticOutput({
      vendor,
      reason: err?.name === 'AbortError' || err?.code === 'PROVIDER_TIMEOUT' ? 'timeout' : 'network_error'
    });
  }

  if (!reply.ok && reply.kind === 'status') {
    console.error('[receiptClassifier] provider returned non-OK', {
      correlation_id: correlationId,
      provider: config.provider,
      status: reply.status
    });
    return makeDeterministicSemanticOutput({ vendor, reason: 'http_error' });
  }

  if (!reply.ok && reply.kind === 'stop') {
    console.error('[receiptClassifier] provider stopped without a usable reply', {
      correlation_id: correlationId, provider: config.provider, failure: reply.error.code, reason: reply.error.reason
    });
    return makeDeterministicSemanticOutput({ vendor, reason: reply.error.reason });
  }

  if (!reply.ok) {
    return makeDeterministicSemanticOutput({ vendor, reason: 'json_parse' });
  }

  const { text } = reply;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return makeDeterministicSemanticOutput({ vendor, reason: 'json_parse' });
  }

  if (!parsed || typeof parsed !== 'object') {
    return makeDeterministicSemanticOutput({ vendor, reason: 'sanitize_wipeout' });
  }

  // The model id is the one the response named (configured only when it
  // named none).
  const { model: servedModel } = classifyModelProvenance({ responseModel: reply.servedModel, requestedModel: config.model });
  const sanitized = sanitizeClassifierOutput(parsed, { vendor, model: servedModel, provider: config.provider });

  console.log('[receiptClassifier] classification complete', {
    correlation_id: correlationId,
    expense_kind: sanitized.expense_kind,
    tax_sensitivity: sanitized.tax_sensitivity,
    materiality_risk: sanitized.materiality_risk,
    confidence_band: sanitized.confidence < 0.5 ? '<0.5' : sanitized.confidence < 0.8 ? '0.5-0.8' : '>=0.8',
    evidence_sufficient_signal: sanitized.evidence_sufficient_signal,
    warning_count: sanitized.warnings.length
  });

  return sanitized;
};

// Test seam — exposes the schema so a unit test can assert
// additionalProperties=false / strict-mode compatibility without
// running the LLM.
export const __RECEIPT_CLASSIFIER_SCHEMA = RECEIPT_CLASSIFIER_SCHEMA;
export const __INSTRUCTIONS = INSTRUCTIONS;
