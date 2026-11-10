// Parser repair loop — targeted follow-up LLM call for critical fields
// (vendor_name, document_date, total_amount) that the initial extraction
// AND the filename fallback both failed to populate. Called after
// applyPostExtractionEnrichment() and before the DB write.
//
// PII policy (mirrors receipt.js): never log free-text extracted fields.
// Diagnostic logs carry only the filename correlation id, field names,
// and the structured outcome.

import crypto from 'node:crypto';
import { normalizeIsoDate, normalizeIsoCurrency } from './parsePrimitives.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { clientFlagActs } from './clientConfig.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { asProviderResponse, llmCall } from './llmCall.js';
import {
  documentLaneRequestFromResponses,
  notConfiguredFailure,
  readDocumentLaneReply,
  resolveDocumentLaneProvider
} from './documentLaneRequest.js';

// When this fires it writes vendor/date/total — the most load-bearing
// fields on the document — so it gets the strong tier (Failure-A
// anti-pattern otherwise). The module itself is repair scaffolding and
// a retirement candidate alongside filenameFallback once logs show it
// no longer fires post-strong-extractors; until then it must not be
// the weakest model in the chain it repairs. (OPENAI_MODEL tuned it until
// 2026-11-10; the document lanes take no provider-wide knob.)
const DEFAULT_MODEL = 'gpt-5.4';
const REQUEST_TIMEOUT_MS = 30_000;
// 2026-11-10 (the owner's decision that Donna runs on Claude): Anthropic
// first. Looking again for at most three named fields is a narrow read:
// `medium` effort.
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const ANTHROPIC_EFFORT = 'medium';
const ANTHROPIC_MAX_TOKENS = 16_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 120_000;

const SUPPORTED_DOCUMENT_TYPES = new Set(['receipt', 'supplier_bill']);

const CRITICAL_FIELDS = ['vendor_name', 'document_date', 'total_amount'];

const CONFIDENCE_LLM_REPAIR = 0.65;

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

// No model knob: the lane's defaults per provider (no provider-wide knob
// such as OPENAI_MODEL, 2026-11-10).
const getOpenAiConfig = () => resolveDocumentLaneProvider({
  laneId: 'parser_repair',
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

// Build a minimal JSON schema containing only the missing fields.
// Each field is nullable so the LLM can still return null if it
// genuinely cannot find the value.
const buildRepairSchema = (missingFields) => {
  const fieldDefs = {
    vendor_name: { type: ['string', 'null'] },
    document_date: { type: ['string', 'null'] },
    total_amount: { type: ['number', 'null'] }
  };

  const properties = {};
  const required = [];
  for (const field of missingFields) {
    if (fieldDefs[field]) {
      properties[field] = fieldDefs[field];
      required.push(field);
    }
  }

  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties
  };
};

const buildRepairPrompt = (missingFields, filename) => {
  const fieldDescriptions = {
    vendor_name: 'vendor_name (the business name that issued the document)',
    document_date: 'document_date (the date on the document, in YYYY-MM-DD format)',
    total_amount: 'total_amount (the grand total amount including tax)'
  };

  const fieldList = missingFields.map((f) => fieldDescriptions[f] || f).join(', ');

  return `The following fields could not be extracted on the first pass. Look more carefully for: ${fieldList}

Filename: ${filename || 'unknown'}

Return only the requested fields. If you still cannot find a field, return null for it.`;
};

// Single-shot repair call. Indirection via __callOpenAi / __callAnthropic
// lets tests inject canned responses without touching the network. The body
// is built ONCE (Responses shape): OpenAI sends it as is, Anthropic carries
// it over unchanged (documentLaneRequest.js documentLaneRequestFromResponses, onto structuredRequest.js).
const buildDefaultCall = (send) => async ({ apiKey, model, dataUrl, filename, missingFields, signal }) =>
  send({
    apiKey,
    signal,
    filename,
    body: ({
      model,
      store: false,
      instructions: buildRepairPrompt(missingFields, filename),
      input: [
        {
          role: 'user',
          content: [
            buildResponsesDocumentPart({ dataUrl, filename }),
            { type: 'input_text', text: 'Extract the missing fields per the instructions.' }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'parser_repair',
          strict: true,
          schema: buildRepairSchema(missingFields)
        }
      }
    })
  });

const executionFor = (filename) => ({ root: { type: 'parser_repair', id: filenameCorrelationId(filename) } });

const defaultCallOpenAi = buildDefaultCall(({ apiKey, signal, filename, body }) => asProviderResponse(llmCall({
  provider: 'openai',
  url: 'https://api.openai.com/v1/responses',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body,
  sections: { system: body.instructions, tools: body.text.format.schema },
  execution: executionFor(filename),
  fetchImpl: (url, init) => fetch(url, { ...init, signal: init?.signal && signal ? AbortSignal.any([init.signal, signal]) : init?.signal || signal })
})));


// The Anthropic call: the shared structured request (structuredRequest.js,
// via documentLaneRequest.js) through the envelope, called here. llmCall is
// loaded at call time where the module's import graph needs it.
const callAnthropicEnvelope = async (options) => {
  const { llmCall } = await import('./llmCall.js');
  return llmCall(documentLaneRequestFromResponses({ timeoutMs: ANTHROPIC_REQUEST_TIMEOUT_MS, ...options }));
};
const defaultCallAnthropic = buildDefaultCall(({ apiKey, signal, filename, body }) => callAnthropicEnvelope({
  apiKey,
  body,
  effort: ANTHROPIC_EFFORT,
  maxTokens: ANTHROPIC_MAX_TOKENS,
  execution: executionFor(filename),
  signal
}));

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const isoDate = normalizeIsoDate;

const EMPTY_RESULT = Object.freeze({
  repaired: false,
  repairedFields: [],
  candidates: {}
});

/**
 * Attempt to repair missing critical fields via a targeted follow-up LLM call.
 *
 * @param {Object} params
 * @param {string} params.base64 - Document bytes, base64-encoded
 * @param {string} params.filename - Original filename
 * @param {string} params.mimeType - MIME type of the document
 * @param {Object} params.header - Mutable header object (vendor_name, document_date, total_amount, etc.)
 * @param {Object} params.summary - Mutable summary object (warnings, *_candidates arrays)
 * @param {string} params.documentType - 'receipt', 'supplier_bill', etc.
 * @param {Object} [params.configSnapshot] - Per-client config control plane snapshot (batch-2 Slice B)
 * @param {Function} [params.__callOpenAi] - Test hook for injecting canned LLM responses
 * @returns {{ repaired: boolean, repairedFields: string[], candidates: Object }}
 */
export const repairMissingFields = async ({
  base64,
  filename,
  mimeType,
  header,
  summary,
  documentType,
  configSnapshot = null,
  __callOpenAi = defaultCallOpenAi,
  __callAnthropic = defaultCallAnthropic
} = {}) => {
  const correlationId = filenameCorrelationId(filename);

  // ── Gate: feature flag ──
  // Batch-2 Slice B (docs/donna-batch2-extractor-cluster-plane-wiring-plan.md):
  // DB-first — a client_capability_config row for PARSER_REPAIR_ENABLED (flag
  // key == the env var name) decides via the stage vocabulary; without a row
  // the legacy strict-'true' env check decides byte-identically (false in
  // prod, census 2026-07-05: the var is unset).
  const repairEnabled = clientFlagActs({
    flagKey: 'PARSER_REPAIR_ENABLED',
    snapshot: configSnapshot,
    envFallback: () => String(process.env.PARSER_REPAIR_ENABLED || '').toLowerCase() === 'true'
  });
  if (!repairEnabled) {
    return { ...EMPTY_RESULT };
  }

  // ── Gate: unsupported document type ──
  if (!SUPPORTED_DOCUMENT_TYPES.has(documentType)) {
    return { ...EMPTY_RESULT };
  }

  // ── Gate: no base64 ──
  const clean = trimBase64(base64);
  if (!clean) {
    return { ...EMPTY_RESULT };
  }

  // ── Gate: determine which fields are missing ──
  const missingFields = CRITICAL_FIELDS.filter((field) => {
    if (field === 'total_amount') return header?.[field] == null;
    return !header?.[field];
  });

  if (missingFields.length === 0) {
    return { ...EMPTY_RESULT };
  }

  // ── LLM call ──
  const config = getOpenAiConfig();
  if (!config.ok) {
    // No key: the failure names the provider whose key is missing (the
    // lane's first, Anthropic, unless a pinned model id chose another).
    const { reason: notConfigured } = notConfiguredFailure(config, 'parser_repair');
    console.warn('[parserRepair] no model provider key configured', { correlation_id: correlationId, reason: notConfigured });
    return { ...EMPTY_RESULT };
  }

  const dataUrl = `data:${mimeType || 'application/pdf'};base64,${clean}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.provider === 'anthropic' ? ANTHROPIC_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const callArgs = {
    apiKey: config.apiKey,
    model: config.model,
    dataUrl,
    filename,
    missingFields,
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

  if (!reply.ok) {
    // Repair is best-effort: any failure (transport, status, refusal,
    // max_tokens, unreadable body) leaves the header as extracted.
    console.warn('[parserRepair] LLM request failed', {
      correlation_id: correlationId,
      provider: config.provider,
      failure: reply.kind,
      status: reply.status || null,
      stop_reason: reply.error?.stopReason || null,
      error_name: reply.error?.name || null,
      missing_fields: missingFields
    });
    return { ...EMPTY_RESULT };
  }

  let parsed;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    console.warn('[parserRepair] response was not valid JSON', {
      correlation_id: correlationId,
      missing_fields: missingFields
    });
    return { ...EMPTY_RESULT };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ...EMPTY_RESULT };
  }

  // ── Apply repaired values ──
  const repairedFields = [];
  const candidates = {};

  // Ensure summary.warnings is an array
  if (!Array.isArray(summary?.warnings)) {
    if (summary) summary.warnings = [];
  }

  // vendor_name
  if (missingFields.includes('vendor_name') && parsed.vendor_name != null) {
    const vendorValue = String(parsed.vendor_name).trim();
    if (vendorValue && !header.vendor_name) {
      header.vendor_name = vendorValue;
      repairedFields.push('vendor_name');
      summary.warnings.push('repaired_vendor_name');

      const candidate = {
        value: vendorValue,
        source: 'llm_repair',
        confidence: CONFIDENCE_LLM_REPAIR
      };
      candidates.vendor_candidates = [candidate];

      // Append to existing summary candidates
      if (Array.isArray(summary.vendor_candidates)) {
        summary.vendor_candidates.push(candidate);
      } else {
        summary.vendor_candidates = [candidate];
      }
    }
  }

  // document_date
  if (missingFields.includes('document_date') && parsed.document_date != null) {
    const dateValue = isoDate(parsed.document_date);
    if (dateValue && !header.document_date) {
      header.document_date = dateValue;
      repairedFields.push('document_date');
      summary.warnings.push('repaired_document_date');

      const candidate = {
        value: dateValue,
        source: 'llm_repair',
        confidence: CONFIDENCE_LLM_REPAIR
      };
      candidates.date_candidates = [candidate];

      if (Array.isArray(summary.date_candidates)) {
        summary.date_candidates.push(candidate);
      } else {
        summary.date_candidates = [candidate];
      }
    }
  }

  // total_amount
  if (missingFields.includes('total_amount') && parsed.total_amount != null) {
    const amountValue = numberOrNull(parsed.total_amount);
    if (amountValue != null && header.total_amount == null) {
      header.total_amount = amountValue;
      repairedFields.push('total_amount');
      summary.warnings.push('repaired_total_amount');

      const candidate = {
        value: amountValue,
        source: 'llm_repair',
        confidence: CONFIDENCE_LLM_REPAIR
      };
      candidates.amount_candidates = [candidate];

      if (Array.isArray(summary.amount_candidates)) {
        summary.amount_candidates.push(candidate);
      } else {
        summary.amount_candidates = [candidate];
      }
    }
  }

  const repaired = repairedFields.length > 0;

  if (repaired) {
    console.log('[parserRepair] fields repaired', {
      correlation_id: correlationId,
      repaired_fields: repairedFields,
      missing_fields: missingFields
    });
  }

  return { repaired, repairedFields, candidates };
};

// Exported for tests
export const __buildRepairPrompt = buildRepairPrompt;
export const __buildRepairSchema = buildRepairSchema;
export const __REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
export const __DEFAULT_MODEL = DEFAULT_MODEL;
