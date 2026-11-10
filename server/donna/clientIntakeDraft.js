// Client intake draft — "drop anything" venture onboarding.
//
// One strong-LLM call turns ANY identity-bearing document — a registry
// extract from any jurisdiction (Bizfile, Certificate of Formation,
// Companies House extract), a bank/payment-account statement, a tax
// notice, an invoice — into a draft client profile: names, jurisdiction
// (best guess with stated basis), entity type, address, currency.
//
// This module REPLACES the hand-written client-side Bizfile regex parser
// (src/lib/bizfileParser.js) — a single-registry, single-jurisdiction
// rule stack — with the trust-the-strong-LLM pattern: give the model the
// whole document and the schema, render what it says, let the bookkeeper
// correct it cheaply in the preview before Create (see CLAUDE.md).
//
// The model is the STRONG tier by default, not nano: this is the
// load-bearing extraction call for a venture's identity — the firm
// anchor every downstream extractor and matcher leans on. entityFacts.js
// (the in-pipeline statutory-doc extractor) still runs nano and is a
// separate review-reflex target.
//
// Party ambiguity is the one real failure class (an invoice names two
// parties and there is no firm anchor yet to disambiguate) — so the
// schema FORCES the model to surface every other plausible party plus
// its reasoning, and the UI renders them one click away. A wrong pick is
// a cheap correction, not a silent misfile.
//
// PII policy mirrors entityFacts.js: company identity is public-record
// data, but raw values never reach logs — counts, enums, and confidence
// bands only.

import crypto from 'node:crypto';
import { normalizeIsoCurrency } from './parsePrimitives.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { asProviderResponse, llmCall } from './llmCall.js';
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

// Strong tier by default — see module header. Override for evals only.
const DEFAULT_MODEL = 'gpt-5.4';
// 2026-11-10 (the owner's decision that Donna runs on Claude): Anthropic
// first. Reading WHO the business is off a registry extract or a bill is
// identity extraction, not line-level arithmetic: `medium` effort.
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const ANTHROPIC_EFFORT = 'medium';
const ANTHROPIC_MAX_TOKENS = 32_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 90_000;

const NAME_MAX_LEN = 200;
const DETAIL_MAX_LEN = 300;
const LEGAL_NAMES_MAX = 8;
const OTHER_PARTIES_MAX = 6;
const FACTS_MAX = 12;
const WARNINGS_MAX = 10;
const PEOPLE_MAX = 60;

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

// CLIENT_INTAKE_MODEL is the lane knob; its id pins the provider.
const getOpenAiConfig = () => resolveDocumentLaneProvider({
  laneId: 'client_intake_draft',
  dotEnv: readDotEnv(),
  modelEnvKeys: ['CLIENT_INTAKE_MODEL'],
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

const capString = (value, maxLen) => {
  if (value === null || value === undefined) return null;
  const str = String(value).replace(/[\x00-\x1F\x7F]/g, '').trim();
  return str ? str.slice(0, maxLen) : null;
};

const capStringArray = (value, maxItems, maxLen) =>
  (Array.isArray(value) ? value : [])
    .map((item) => capString(item, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);

export const DOCUMENT_KIND_VALUES = Object.freeze([
  'registry_extract',
  'bank_statement',
  'invoice_or_bill',
  'tax_notice',
  'utility_bill',
  'contract',
  'other'
]);

const DOCUMENT_KIND_SET = new Set(DOCUMENT_KIND_VALUES);

// ── JSON schema ─────────────────────────────────────────────────────

const INTAKE_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'extraction_status',
    'extraction_confidence',
    'document_kind',
    'document_kind_detail',
    'company_name',
    'legal_names',
    'registration_number',
    'registration_number_kind',
    'entity_type',
    'incorporation_date',
    'jurisdiction',
    'jurisdiction_detail',
    'jurisdiction_basis',
    'default_currency',
    'registered_address',
    'primary_contact',
    'chosen_party_reasoning',
    'other_parties',
    'officers',
    'shareholders',
    'facts',
    'warnings'
  ],
  properties: {
    extraction_status: { type: 'string', enum: ['confident', 'partial', 'ambiguous', 'failed'] },
    extraction_confidence: { type: 'number' },
    document_kind: { type: 'string', enum: [...DOCUMENT_KIND_VALUES] },
    document_kind_detail: { type: ['string', 'null'] },
    company_name: { type: ['string', 'null'] },
    legal_names: { type: 'array', items: { type: 'string' } },
    registration_number: { type: ['string', 'null'] },
    registration_number_kind: { type: ['string', 'null'] },
    entity_type: { type: ['string', 'null'] },
    incorporation_date: { type: ['string', 'null'] },
    jurisdiction: { type: ['string', 'null'] },
    jurisdiction_detail: { type: ['string', 'null'] },
    jurisdiction_basis: { type: ['string', 'null'] },
    default_currency: { type: ['string', 'null'] },
    registered_address: {
      type: 'object',
      additionalProperties: false,
      required: ['line1', 'line2', 'city', 'state', 'postal_code', 'country'],
      properties: {
        line1: { type: ['string', 'null'] },
        line2: { type: ['string', 'null'] },
        city: { type: ['string', 'null'] },
        state: { type: ['string', 'null'] },
        postal_code: { type: ['string', 'null'] },
        country: { type: ['string', 'null'] }
      }
    },
    primary_contact: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'role', 'email'],
      properties: {
        name: { type: ['string', 'null'] },
        role: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] }
      }
    },
    chosen_party_reasoning: { type: ['string', 'null'] },
    other_parties: { type: 'array', items: { type: 'string' } },
    // Structured people channel — the People & ownership tab renders
    // from these, NOT from facts. The regex bizfileParser used to build
    // these tables; when intake moved to this draft the channel was
    // dropped and the tab went dark (June 2026 pilot-client rebuild receipt).
    officers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role', 'appointed_on'],
        properties: {
          name: { type: 'string' },
          role: { type: ['string', 'null'] },
          appointed_on: { type: ['string', 'null'] }
        }
      }
    },
    shareholders: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'holding'],
        properties: {
          name: { type: 'string' },
          holding: { type: ['string', 'null'] }
        }
      }
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value'],
        properties: {
          label: { type: 'string' },
          value: { type: 'string' }
        }
      }
    },
    warnings: { type: 'array', items: { type: 'string' } }
  }
};

// ── System prompt ───────────────────────────────────────────────────

const INSTRUCTIONS = `You are drafting a bookkeeping client profile from one document a bookkeeper uploaded while onboarding a NEW business entity ("venture").

The document can be ANYTHING that identifies the business: a company registry extract from any jurisdiction (Singapore Bizfile, US Certificate of Formation / Secretary of State filing, UK Companies House extract, …), a bank or payment-account statement, a tax notice, a utility bill, an invoice, or a contract. First classify it (document_kind), then extract the identity of the business it belongs to.

WHICH PARTY IS THE CLIENT:
- The profile describes the prospective bookkeeping client — the business being onboarded.
- Registry extracts, tax notices, and statements name one subject: the registered company / the account holder. That is the client.
- Invoices, bills, and contracts name TWO OR MORE parties and you cannot know for certain which one is being onboarded. Pick the most plausible candidate (the party whose registration details, address, or account information the document centres on), explain your pick in chosen_party_reasoning, and list EVERY other named party in other_parties so the bookkeeper can flip the choice in one click. Never leave a plausible alternative out.
- For single-subject documents, set chosen_party_reasoning to a short basis statement (e.g. "account holder on the statement") and other_parties to [].

NAMES:
- company_name: the best display name for the client.
- legal_names: every legal name and registered alias found, canonical form first. Preserve original-script names (Chinese, Japanese, …) as separate entries alongside romanised forms. Do not invent abbreviations.

JURISDICTION (best guess is expected — state your basis):
- jurisdiction: ISO 3166-1 alpha-2 country code, uppercase (SG, US, GB, FI, …). Use the strongest available signal: the registry itself, the registered address, the bank's country and statement format, the currency, tax identifiers. null only when there is genuinely no signal.
- jurisdiction_detail: human phrasing with subdivision when known (e.g. "Arkansas, United States").
- jurisdiction_basis: one short sentence naming the evidence (e.g. "registered office address on the extract", "USD account at a US routing-number bank").

OTHER FIELDS:
- registration_number: the company identifier exactly as printed (UEN, EIN, Companies House number, ABN, Business ID, …) with registration_number_kind naming which kind. Never fabricate one; null when absent.
- incorporation_date: YYYY-MM-DD when printed; null otherwise.
- default_currency: ISO 4217 best guess for the books — a statement's account currency is a strong signal; otherwise infer from jurisdiction. null when no signal.
- registered_address: the business's own address from the document (not the counterparty's, not the bank branch's).
- primary_contact: only when an individual is clearly associated with the business (owner, director, signatory). Never the counterparty's staff.
- officers: EVERY officer printed on a registry extract — directors, secretaries, managers — with role exactly as printed and appointed_on (YYYY-MM-DD) when shown. Empty array for documents that list no officers.
- shareholders: EVERY shareholder/member printed, with holding exactly as printed ("80,500 ordinary shares", "33.3%"). Empty array when the document lists none. Officers and shareholders also belong in facts only when space allows — the structured arrays are the canonical channel.
- facts: up to ${FACTS_MAX} notable label/value pairs worth showing the bookkeeper (entity status, share capital, FYE, statement period, account number with all but last 4 digits masked, registry name, …).
- warnings: anything that should give the bookkeeper pause (poor scan quality, conflicting names, document names a different country than the address, …).

extraction_status: "confident" when the identity is unambiguous, "ambiguous" when other_parties is non-empty or names conflict, "partial" when key fields are unreadable, "failed" when the document identifies no business at all.
extraction_confidence: 0..1, your honest calibration for company_name + jurisdiction together.`;

// ── OpenAI call ─────────────────────────────────────────────────────

// The request body is built ONCE (Responses shape); the OpenAI transport
// sends it as is and the Anthropic transport carries it over unchanged.
const buildDefaultCall = (send) => async ({ apiKey, model, dataUrl, filename, text, signal }) => {
  const content = [];
  if (dataUrl) {
    content.push(buildResponsesDocumentPart({ dataUrl, filename }));
  }
  content.push({
    type: 'input_text',
    text: text
      ? `Draft the client intake profile from this pasted document text per the schema.\n\n${text}`
      : 'Draft the client intake profile from this document per the schema.'
  });
  return send({
    apiKey,
    signal,
    filename,
    body: {
      model,
      store: false,
      instructions: INSTRUCTIONS,
      input: [{ role: 'user', content }],
      text: {
        format: {
          type: 'json_schema',
          name: 'client_intake_draft',
          strict: true,
          schema: INTAKE_DRAFT_SCHEMA
        }
      }
    }
  });
};

const executionFor = (filename) => ({ root: { type: 'client_intake_draft', id: filenameCorrelationId(filename) } });

const defaultCallOpenAi = buildDefaultCall(({ apiKey, signal, filename, body }) => asProviderResponse(llmCall({
  provider: 'openai',
  // The lane's own wall, honoured inside a worker too (llmCall hands it to
  // the deadline transport, bounded by the job's remaining budget).
  timeoutMs: REQUEST_TIMEOUT_MS,
  url: 'https://api.openai.com/v1/responses',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body,
  sections: { system: INSTRUCTIONS, tools: INTAKE_DRAFT_SCHEMA },
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

// ── Normalization ───────────────────────────────────────────────────

const normalizeIsoDate = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.slice(0, 10)) ? raw.slice(0, 10) : null;
};

const normalizeJurisdiction = (value) => {
  const raw = capString(value, 8);
  if (!raw) return null;
  const code = raw.toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
};

const normalizeCurrency = normalizeIsoCurrency;

const normalizeDraft = (parsed = {}) => {
  const address = parsed.registered_address || {};
  const contact = parsed.primary_contact || {};
  const confidence = Number(parsed.extraction_confidence);
  return {
    extraction_status: ['confident', 'partial', 'ambiguous', 'failed'].includes(parsed.extraction_status)
      ? parsed.extraction_status
      : 'failed',
    extraction_confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
    document_kind: DOCUMENT_KIND_SET.has(parsed.document_kind) ? parsed.document_kind : 'other',
    document_kind_detail: capString(parsed.document_kind_detail, DETAIL_MAX_LEN),
    company_name: capString(parsed.company_name, NAME_MAX_LEN),
    legal_names: capStringArray(parsed.legal_names, LEGAL_NAMES_MAX, NAME_MAX_LEN),
    registration_number: capString(parsed.registration_number, 64),
    registration_number_kind: capString(parsed.registration_number_kind, 64),
    entity_type: capString(parsed.entity_type, NAME_MAX_LEN),
    incorporation_date: normalizeIsoDate(parsed.incorporation_date),
    jurisdiction: normalizeJurisdiction(parsed.jurisdiction),
    jurisdiction_detail: capString(parsed.jurisdiction_detail, DETAIL_MAX_LEN),
    jurisdiction_basis: capString(parsed.jurisdiction_basis, DETAIL_MAX_LEN),
    default_currency: normalizeCurrency(parsed.default_currency),
    registered_address: {
      line1: capString(address.line1, DETAIL_MAX_LEN),
      line2: capString(address.line2, DETAIL_MAX_LEN),
      city: capString(address.city, NAME_MAX_LEN),
      state: capString(address.state, NAME_MAX_LEN),
      postal_code: capString(address.postal_code, 32),
      country: capString(address.country, NAME_MAX_LEN)
    },
    primary_contact: {
      name: capString(contact.name, NAME_MAX_LEN),
      role: capString(contact.role, NAME_MAX_LEN),
      email: capString(contact.email, NAME_MAX_LEN)
    },
    chosen_party_reasoning: capString(parsed.chosen_party_reasoning, DETAIL_MAX_LEN),
    other_parties: capStringArray(parsed.other_parties, OTHER_PARTIES_MAX, NAME_MAX_LEN),
    officers: (Array.isArray(parsed.officers) ? parsed.officers : [])
      .map((officer) => ({
        name: capString(officer?.name, NAME_MAX_LEN),
        role: capString(officer?.role, NAME_MAX_LEN),
        appointed_on: normalizeIsoDate(officer?.appointed_on)
      }))
      .filter((officer) => officer.name)
      .slice(0, PEOPLE_MAX),
    shareholders: (Array.isArray(parsed.shareholders) ? parsed.shareholders : [])
      .map((shareholder) => ({
        name: capString(shareholder?.name, NAME_MAX_LEN),
        holding: capString(shareholder?.holding, DETAIL_MAX_LEN)
      }))
      .filter((shareholder) => shareholder.name)
      .slice(0, PEOPLE_MAX),
    facts: (Array.isArray(parsed.facts) ? parsed.facts : [])
      .map((fact) => ({
        label: capString(fact?.label, 64),
        value: capString(fact?.value, DETAIL_MAX_LEN)
      }))
      .filter((fact) => fact.label && fact.value)
      .slice(0, FACTS_MAX),
    warnings: capStringArray(parsed.warnings, WARNINGS_MAX, DETAIL_MAX_LEN)
  };
};

// ── Public extractor ────────────────────────────────────────────────

// Accepts EITHER a document file ({ base64, filename, mimeType }) or
// pasted text ({ text }). Returns { kind: 'ok', draft } or
// { kind: 'failed', code, reason }.
export const extractClientIntakeDraft = async ({
  base64 = '',
  filename = '',
  mimeType = '',
  text = '',
  __callOpenAi = defaultCallOpenAi,
  __callAnthropic = defaultCallAnthropic
} = {}) => {
  const startedAt = Date.now();
  const correlationId = filenameCorrelationId(filename || text.slice(0, 64));
  const config = getOpenAiConfig();

  if (!config.ok) {
    // No key: the failure names the provider whose key is missing (the
    // lane's first, Anthropic, unless a pinned model id chose another).
    const { provider: missing, reason: notConfigured } = notConfiguredFailure(config, 'client_intake_draft');
    console.warn('[clientIntakeDraft] no model provider key configured', { correlation_id: correlationId, reason: notConfigured, pinned_by: config.pinned_by || null });
    return { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: notConfigured, provider: missing, ...(config.pinned_by ? { pinned_by: config.pinned_by } : {}) };
  }

  const clean = trimBase64(base64);
  const pastedText = String(text || '').trim();
  if (!clean && !pastedText) {
    return { kind: 'failed', code: 'DOCUMENT_EXTRACTION_UNREADABLE', reason: 'empty_input' };
  }

  const dataUrl = clean ? `data:${mimeType || 'application/pdf'};base64,${clean}` : '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.provider === 'anthropic' ? ANTHROPIC_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const callArgs = {
    apiKey: config.apiKey,
    model: config.model,
    dataUrl,
    filename,
    text: pastedText,
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
    console.error('[clientIntakeDraft] provider request threw', {
      correlation_id: correlationId,
      provider: config.provider,
      error_code: reply.error?.code || null,
      error_name: reply.error?.name || null,
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: thrownReason(reply.error)
    };
  }

  if (!reply.ok && reply.kind === 'status') {
    const status = reply.status;
    console.error('[clientIntakeDraft] provider returned non-OK', {
      correlation_id: correlationId,
      provider: config.provider,
      status,
      elapsed_ms: Date.now() - startedAt
    });
    return { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: `${config.provider}_${status || 'unknown'}` };
  }

  if (!reply.ok && reply.kind === 'stop') {
    console.error('[clientIntakeDraft] provider stopped without a usable reply', {
      correlation_id: correlationId, provider: config.provider, failure: reply.error.code, reason: reply.error.reason, elapsed_ms: Date.now() - startedAt
    });
    // Refusal / output limit final; an answer that is not the structured
    // answer retryable (stopFailureCode), receipted with the served model.
    return { kind: 'failed', code: stopFailureCode(reply.error), reason: stopFailureReason(reply.error), model: reply.error.servedModel || null, provider: config.provider };
  }

  if (!reply.ok) {
    return { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'response_not_json' };
  }

  // The model id is the one the response named (configured only when it
  // named none; model_source says which).
  const provenance = classifyModelProvenance({ responseModel: reply.servedModel, requestedModel: config.model });

  let parsed;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    console.error('[clientIntakeDraft] structured response was not valid JSON', {
      correlation_id: correlationId,
      elapsed_ms: Date.now() - startedAt
    });
    return { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'schema_parse_failed' };
  }

  const draft = normalizeDraft(parsed);
  if (draft.extraction_status === 'failed' || !draft.company_name) {
    console.warn('[clientIntakeDraft] document identifies no business', {
      correlation_id: correlationId,
      document_kind: draft.document_kind,
      extraction_status: draft.extraction_status,
      elapsed_ms: Date.now() - startedAt
    });
    return { kind: 'failed', code: 'DOCUMENT_IDENTIFIES_NO_BUSINESS', reason: 'no_entity_found' };
  }

  console.log('[clientIntakeDraft] draft extracted', {
    correlation_id: correlationId,
    provider: config.provider,
    model: provenance.model,
    document_kind: draft.document_kind,
    extraction_status: draft.extraction_status,
    confidence_band: draft.extraction_confidence >= 0.8 ? 'high' : draft.extraction_confidence >= 0.5 ? 'medium' : 'low',
    legal_name_count: draft.legal_names.length,
    other_party_count: draft.other_parties.length,
    has_jurisdiction: Boolean(draft.jurisdiction),
    elapsed_ms: Date.now() - startedAt
  });

  return { kind: 'ok', draft, provider: config.provider, model: provenance.model, model_source: provenance.model_source };
};

// Test-only exports.
export const __INTAKE_DRAFT_SCHEMA = INTAKE_DRAFT_SCHEMA;
export const __INSTRUCTIONS = INSTRUCTIONS;
export const __normalizeDraft = normalizeDraft;
export const __DEFAULT_MODEL = DEFAULT_MODEL;
