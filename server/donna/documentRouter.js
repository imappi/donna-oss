import { isProviderSpendLimit } from './providerTransport.js';
// Document Router — Phase 8b of Donna Document Intelligence.
//
// LLM-based document classification over the document itself (vision).
// Provider-agnostic since 2026-11-10 (the owner's decision that Donna runs
// on Claude): Anthropic (claude-opus-5-5, the file as a document/image
// block, structured output) first, the OpenAI Responses API (gpt-5.4) only
// when no Anthropic key is configured — resolved by laneProviderResolver.js,
// every call through the llmCall envelope. The router's verdict OVERRIDES the upload-time document type for
// every family it can name once it clears DOCUMENT_ROUTER_MIN_CONFIDENCE
// and the two blast-radius guards in `inngest/parseDocument.js`
// (`__buildClassification`). Shadow mode — log-but-don't-override, with
// per-family promotion flags — was retired for good in RT-05 (2026-09-01,
// decision D6, zero-users rail); the upload-time type from the filename
// classifier is a HINT the router refines, never a verdict it defers to.
//
// PII policy (mirrors the receipt/bank-statement audit policy): never
// log full free-text extracted fields. Hash a correlation id from the
// filename if cross-line debugging is needed. Diagnostic logs in this
// module only carry the correlation_id, byte count, elapsed_ms, and
// the structured outcome — never the LLM response body.

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { asProviderResponse, llmCall } from './llmCall.js';
import { anthropicFileBlock, callAnthropicMessages, isAnthropicStopFailure } from './anthropicMessages.js';
import { envWithDotEnv, resolveLaneProvider } from './laneProviderResolver.js';
import { classifyModelProvenance } from './providerEndpoints.js';

// Routing was the one principled nano use under the bulk-filter
// carve-out (CLAUDE.md) — but the router OVERRIDES the upload-time type,
// and nano nondeterminism produced real wrong flips (the Mann Lake bill →
// sales_invoice class). A surface with override authority gets the strong
// tier (firm call, 06-11). DOCUMENT_ROUTER_MODEL stays the override knob.
const DEFAULT_MODEL = 'gpt-5.4';
// 2026-11-10: the lane's Anthropic default.
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const REQUEST_TIMEOUT_MS = 30_000;
// A routing decision names a family from a fixed list: `low` effort is the
// depth it needs (adaptive thinking cannot be switched off). The Anthropic
// request reads the whole file with thinking on, so it gets a longer wall
// than the 30s the OpenAI call has always had.
const ANTHROPIC_EFFORT = 'low';
const ANTHROPIC_MAX_TOKENS = 16_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 90_000;

// ── Document families ───────────────────────────────────────────────
const DOCUMENT_FAMILIES = Object.freeze([
  'bank_statement',
  'invoice_or_bill',
  'receipt',
  'contract',
  'company_or_statutory_record',
  'payment_confirmation',
  'payment_account_statement',
  // RT-18 (2026-09-02): the revenue-side settlement family the round-4
  // Desert Rose review scoped (audit F-04 part 2 / F-23). A processor /
  // POS / delivery-platform payout statement and a cash / cheque deposit
  // slip are the firm's own sales proceeds ARRIVING — money in, one net
  // amount on the bank feed — and each gets its own document type so the
  // payout extractor reads the breakdown and the payout matcher scans
  // money_in. Market-neutral by construction: a Deliveroo AED payout and
  // a Square USD payout are the same shape.
  'payout_statement',
  'deposit_slip',
  'tax_or_government_notice',
  'payroll',
  'financing',
  'insurance',
  'certificate_or_compliance',
  'unknown_but_relevant',
  'not_accounting_relevant'
]);

const DOCUMENT_FAMILIES_SET = new Set(DOCUMENT_FAMILIES);

const DIRECTION_HINTS = Object.freeze(['ap', 'ar', 'unknown']);

// ── Family → extractor mapping ──────────────────────────────────────
// Computed from family + direction, NOT from the LLM. Null means no
// specialist extractor is currently wired up for that family. Two
// families branch on direction:
//   - invoice_or_bill: ap → supplier_bill, ar → sales_invoice.
//   - receipt:         ap → receipt,       ar → issued_receipt.
//   - payment_confirmation:
//                      ap → payment_confirmation,
//                      ar → issued_receipt (a customer's remittance advice).
//   payout_statement and deposit_slip (RT-18) map directly; the router
//   always hints "ar" for them.
const FAMILY_TO_EXTRACTOR = Object.freeze({
  bank_statement: 'bank_statement',
  invoice_or_bill: null, // depends on direction_hint
  receipt: null,         // depends on direction_hint
  contract: 'contract',
  company_or_statutory_record: null,
  // Outbound payment confirmations use the generic extractor. An INBOUND
  // confirmation (a customer's remittance advice for an invoice the firm
  // issued) still resolves directionally below to issued_receipt; a
  // processor / platform PAYOUT is its own family (payout_statement) since
  // RT-18 and never lands here.
  payment_confirmation: 'payment_confirmation',
  // payment_account_statement is its own first-class type so the
  // matcher (Stage 2 of the AR/AP-aggregator work) can recognise it
  // without re-doing classification. The extractor is the generic
  // perception layer for now — perception-first; a dedicated
  // statement-with-underlying-charges extractor is deferred until
  // generic shape gaps actually bite. See PR description.
  payment_account_statement: 'payment_account_statement',
  // RT-18: both settlement shapes land on the payout extractor
  // (server/donna/payoutStatement.js) under their own document type; the
  // worker's pickExtractor maps either type to that one module.
  payout_statement: 'payout_statement',
  deposit_slip: 'deposit_slip',
  tax_or_government_notice: null,
  // RT-22 (2026-09-09): the three EVIDENCE families that previously had no
  // extractor and rested `unknown` with zero lines — the Kampaamo Kultalanka
  // February book showed the router naming each at 0.98–0.99 confidence
  // (payslip, OP loan installment notice, Turva-Suomi insurance invoice)
  // while the generic path read only a total, so the coder asked the
  // owner what a salary payment was for with the payslip in the book.
  // Each is a PAYABLE the firm settles from its bank account, so it lands
  // on the bill lane of the unified strong extractor (counterparty =
  // employee / lender / insurer; total = the amount the firm pays this
  // period; lines = the components as printed) and inherits the bill
  // matcher and the coder's evidence read. Market-neutral by construction:
  // a UK payslip, a US loan statement and an FI insurance invoice are the
  // same shape. `parse_summary.router.family` keeps the finer family.
  payroll: 'supplier_bill',
  financing: 'supplier_bill',
  insurance: 'supplier_bill',
  certificate_or_compliance: null,
  unknown_but_relevant: null,
  not_accounting_relevant: null
});

const resolveExtractor = (family, directionHint) => {
  if (family === 'invoice_or_bill') {
    if (directionHint === 'ar') return 'sales_invoice';
    // ap and unknown both default to supplier_bill
    return 'supplier_bill';
  }
  if (family === 'receipt') {
    // A receipt the client ISSUED to a customer (rent receipt, paid
    // invoice acknowledgement) is structurally an AR document — money
    // already flowed in. It lands through the sales_invoice extractor
    // and the sales_invoice matcher pipeline, but keeps a distinct
    // document_type so accounting templates can render "Receipt
    // issued" rather than "Sales invoice / paid".
    if (directionHint === 'ar') return 'issued_receipt';
    // ap and unknown both fall back to the standard expense receipt
    // extractor.
    return 'receipt';
  }
  if (family === 'payment_confirmation') {
    // A single settlement confirmation can prove either direction. Card,
    // tax and lender payments are outbound; a customer's remittance advice
    // for an invoice the firm issued is inbound and reuses the
    // issued_receipt lane (money_in matcher). Processor / platform payouts
    // are NOT this family any more — they are payout_statement (RT-18),
    // whose extractor reads the gross → fees → net breakdown instead of
    // projecting one net figure through the sales-invoice schema.
    if (directionHint === 'ar') return 'issued_receipt';
    return 'payment_confirmation';
  }
  return FAMILY_TO_EXTRACTOR[family] ?? null;
};

// ── OpenAI config (same pattern as receipt.js) ──────────────────────
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

// DOCUMENT_ROUTER_MODEL is the lane's knob (its id pins the provider);
// OPENAI_MODEL tunes the OpenAI model only.
const getRouterConfig = () => resolveLaneProvider({
  laneId: 'document_routing',
  env: envWithDotEnv(readDotEnv()),
  modelEnvKeys: ['DOCUMENT_ROUTER_MODEL'],
  providerModelEnvKeys: { openai: ['OPENAI_MODEL'] },
  defaultModels: { anthropic: DEFAULT_ANTHROPIC_MODEL, openai: DEFAULT_MODEL }
});

const filenameCorrelationId = (filename = '') =>
  crypto.createHash('sha256').update(String(filename || 'unknown')).digest('hex').slice(0, 12);

const trimBase64 = (value = '') => String(value || '').replace(/[\r\n\s]/g, '');

const outputTextFromResponse = (response = {}) => {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text;
    }
  }
  return '';
};

// ── JSON schema for the Responses API strict mode ───────────────────
const ROUTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'document_family',
    'confidence',
    'direction_hint',
    'candidate_families',
    'language_hint',
    'reason'
  ],
  properties: {
    document_family: {
      type: 'string',
      enum: [...DOCUMENT_FAMILIES]
    },
    confidence: { type: 'number' },
    direction_hint: {
      type: 'string',
      enum: [...DIRECTION_HINTS]
    },
    candidate_families: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['family', 'confidence'],
        properties: {
          family: {
            type: 'string',
            enum: [...DOCUMENT_FAMILIES]
          },
          confidence: { type: 'number' }
        }
      }
    },
    language_hint: { type: 'string' },
    reason: { type: 'string' }
  }
};

// ── System prompt ───────────────────────────────────────────────────
const INSTRUCTIONS = `You are classifying a document for a bookkeeping system. Examine the document and determine its type.

document_family: classify into one of the supported families.
confidence: your 0-1 confidence in the classification.
direction_hint: determine whether the document represents money flowing INTO or OUT OF the firm whose books we're keeping. The firm's identity is supplied separately as "client identity" — match the firm against the document's payer/payee/issuer/recipient to decide direction.
  - "ap" (accounts payable — the firm is the BUYER/PAYER on the document, money going OUT). Applies to:
      * Supplier bills / purchase invoices addressed to the firm.
      * Expense receipts the firm received from a vendor (the firm is the customer on a typical retail receipt).
  - "ar" (accounts receivable — the firm is the SELLER/PAYEE on the document, money coming IN). Applies to:
      * Sales invoices the firm issued to a customer.
      * Receipts the firm ISSUED to acknowledge a payment received (rent receipts, paid acknowledgements where the firm's name is on the issuer line).
  - "unknown" if you can't reliably tell — for example, when the client identity isn't supplied, or when neither party on the document matches the firm.
  - Payment confirmations are directional too: use "ap" when the firm paid money out, and "ar" when a customer confirms it paid the firm.
  - "payout_statement" and "deposit_slip" are ALWAYS "ar": they document the firm's own sales proceeds arriving in its bank account.
  - "payroll" (a payslip / payroll record), "financing" (a loan installment notice, repayment schedule or lender statement) and "insurance" (a premium invoice) are payables the firm settles from its bank account: use "ap".
  For other non-invoice / non-receipt documents (bank statements, payment account statements, contracts, tax notices, etc.) use "unknown".

Five families can look superficially alike — read the document carefully and pick the right one:
  - "bank_statement": a periodic statement from a BANK for a deposit/cash account the firm holds. Many inbound + outbound transactions against a running balance. Issuer is a bank; account is the firm's. Don't pick this just because the word "statement" appears in the filename.
  - "payment_account_statement": a periodic statement from an OUTBOUND PAYMENT-ACCOUNT PROVIDER — credit cards (Amex, Visa, Mastercard), charge cards, fuel cards, or expense platforms (Brex, Ramp, Pleo). The pattern is many UNDERLYING MERCHANT CHARGES aggregated into one statement, settled by ONE outbound payment (typically an ACH from the firm's bank account). The firm did NOT buy a service from the provider — the provider is the conduit; each underlying charge is its own merchant. Issuer is the card/platform provider; the document is the bridge between the merchant-level charges and the eventual settlement payment. Strong tells: a "previous balance / payments / new charges / new balance" header; a list of merchant transactions over a period with a single grand total; a "payment due date" and a single statement balance. NEVER use this family for a merchant-processor payout or deposit report.
  - "payment_confirmation": evidence of a SINGLE bank settlement. Outbound examples: "Tax payment confirmation $3,683.67", "Amex payment confirmation $941.42" (the FIRM paying Amex), wire receipts, ACH notifications; use direction_hint="ap". An inbound remittance advice from a CUSTOMER confirming it paid one of the firm's invoices uses direction_hint="ar". A processor or platform payout is NOT this family — see payout_statement.
  - "payout_statement": a settlement / payout / remittance report from a PAYMENT PROCESSOR, CARD ACQUIRER, POS PROVIDER, MARKETPLACE or DELIVERY PLATFORM (Stripe, Square, Adyen, PayPal, Shopify Payments, Clover, SumUp, Toast, Deliveroo, Talabat, Uber Eats, Careem, DoorDash, Just Eat, Amazon, Etsy, …) showing the firm's GROSS customer sales for a period, refunds and/or fees or commission deducted (often with tax on the fee), optional adjustments, and ONE NET amount paid into the firm's bank account, usually with a payout reference and a settlement period or payout date. Underlying sales rows do not turn one net payout into a payment_account_statement; a "payout", "settlement", "net deposit", "amount transferred to your bank" line is the tell. Direction is ALWAYS "ar".
  - "deposit_slip": a cash and/or cheque deposit at a bank branch, counter or ATM — a paying-in slip, counter deposit receipt, ATM deposit receipt or cheque deposit advice — listing the notes/coins and cheques deposited and ONE total credited to the firm's account, with the account number, branch and date. Direction is ALWAYS "ar".

PAYOUTS AND DEPOSITS are the firm's own customer revenue arriving, not purchases from the processor or bank. A genuine purchase FROM the same brand (for example a Square card reader, a PayPal subscription or a bank fee notice) remains an outbound receipt or bill; direction follows the cash flow, not the brand.

Do NOT classify a credit-card statement as "invoice_or_bill" — the provider did not sell the firm a service. The statement is a settlement artifact, not a vendor bill.

candidate_families: list up to 3 candidate classifications with confidence scores, highest first.
language_hint: ISO 639-1 code of the primary language in the document.
reason: one sentence explaining why you chose this classification — including how the client identity resolved the direction.`;

// Format a structured client identity into a prompt fragment. Both the
// canonical legal name AND any trading-name aliases get listed so the
// LLM can match against whatever form appears on the document (e.g.
// "M & R Holdings (Trading) Ltd" might be written "M&R Holdings" on a
// rent receipt). Returns an empty string when no identity is supplied
// so the call is unchanged from the legacy code path.
export const formatClientIdentity = (identity) => {
  if (!identity || typeof identity !== 'object') return '';
  const displayName = String(identity.display_name || '').trim();
  const legalNames = Array.isArray(identity.legal_names)
    ? identity.legal_names.map((n) => String(n || '').trim()).filter(Boolean)
    : [];
  if (!displayName && legalNames.length === 0) return '';
  const lines = ['Client identity (the firm whose books we are keeping):'];
  if (displayName) lines.push(`- Display name: ${displayName}`);
  if (legalNames.length > 0) {
    lines.push(`- Known legal/trading names this client operates under: ${legalNames.join(' | ')}`);
  }
  lines.push('Use these names to identify which side of the document is the client and which is the counterparty. The OTHER party on the document is the counterparty.');
  return lines.join('\n');
};

// ── Default OpenAI caller ───────────────────────────────────────────
const defaultCallOpenAi = async ({ apiKey, model, dataUrl, filename, clientContext, clientIdentity, signal }) => {
  const userContent = [
    buildResponsesDocumentPart({ dataUrl, filename }),
    { type: 'input_text', text: 'Classify this document per the schema.' }
  ];

  // Structured client identity takes precedence — direction inference
  // relies on it. Legacy `clientContext` is still honoured for callers
  // (and tests) that haven't migrated to the structured form.
  const identityFragment = formatClientIdentity(clientIdentity);
  if (identityFragment) {
    userContent.push({
      type: 'input_text',
      text: identityFragment
    });
  } else if (clientContext) {
    userContent.push({
      type: 'input_text',
      text: `Context about the uploading client: ${clientContext}`
    });
  }

  return asProviderResponse(llmCall({
    provider: 'openai',
    url: 'https://api.openai.com/v1/responses',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: {
      model,
      store: false,
      instructions: INSTRUCTIONS,
      input: [
        {
          role: 'user',
          content: userContent
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'document_routing',
          strict: true,
          schema: ROUTER_SCHEMA
        }
      }
    },
    sections: { system: INSTRUCTIONS, tools: ROUTER_SCHEMA },
    execution: { root: { type: 'document_routing', id: filenameCorrelationId(filename) } },
    // The envelope bounds the call by the owning job's deadline when one is
    // in force; the local timeout still reaches the socket.
    fetchImpl: (url, init) => fetch(url, { ...init, signal: init?.signal && signal ? AbortSignal.any([init.signal, signal]) : init?.signal || signal })
  }));
};

// The same request on Anthropic: the file as a content block, then the same
// text parts the OpenAI request carries, in the same order.
const routerTextParts = ({ clientContext, clientIdentity }) => {
  const parts = ['Classify this document per the schema.'];
  const identityFragment = formatClientIdentity(clientIdentity);
  if (identityFragment) parts.push(identityFragment);
  else if (clientContext) parts.push(`Context about the uploading client: ${clientContext}`);
  return parts;
};

const callAnthropicRouter = async ({ apiKey, model, base64, mimeType, filename, clientContext, clientIdentity, signal }) =>
  callAnthropicMessages({
    apiKey,
    model,
    system: INSTRUCTIONS,
    content: [
      anthropicFileBlock({ base64, mimeType, filename }),
      ...routerTextParts({ clientContext, clientIdentity }).map((text) => ({ type: 'text', text }))
    ],
    schema: ROUTER_SCHEMA,
    effort: ANTHROPIC_EFFORT,
    maxTokens: ANTHROPIC_MAX_TOKENS,
    sections: { system: INSTRUCTIONS, tools: ROUTER_SCHEMA },
    execution: { root: { type: 'document_routing', id: filenameCorrelationId(filename) } },
    signal
  });

// ── Public API ──────────────────────────────────────────────────────
// Never throws. Always returns a result object.
//
// `clientIdentity` is the structured form: { display_name, legal_names }.
// `clientContext` is the legacy free-text form — kept for backward
// compatibility but should be migrated to clientIdentity by callers
// that have access to `clients.legal_names`.
export const routeDocument = async ({
  base64,
  filename = '',
  mimeType = '',
  clientContext = '',
  clientIdentity = null,
  __callOpenAi = defaultCallOpenAi
} = {}) => {
  const correlationId = filenameCorrelationId(filename);
  const config = getRouterConfig();

  if (!config.ok) {
    console.warn('[documentRouter] no model provider key configured', { correlation_id: correlationId, reason: config.reason });
    // `api_key_missing` names no provider; `provider_reason` says which key.
    return { routed: false, reason: 'api_key_missing', provider_reason: config.reason };
  }

  const clean = trimBase64(base64);
  if (!clean) {
    return { routed: false, reason: 'empty_input' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.provider === 'anthropic' ? ANTHROPIC_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  let text = '';
  let servedModel = null;
  if (config.provider === 'anthropic') {
    try {
      ({ text, servedModel } = await callAnthropicRouter({
        apiKey: config.apiKey,
        model: config.model,
        base64: clean,
        mimeType,
        filename,
        clientContext,
        clientIdentity,
        signal: controller.signal
      }));
    } catch (err) {
      if (isProviderSpendLimit(err)) throw err;
      console.error('[documentRouter] provider request failed', {
        correlation_id: correlationId,
        provider: 'anthropic',
        error_code: err?.code || null,
        status: err?.status || null,
        error_name: err?.name || null,
        elapsed_ms: Date.now() - startedAt
      });
      return {
        routed: false,
        reason: 'llm_error',
        provider: 'anthropic',
        failure: isAnthropicStopFailure(err) ? err.reason : (err?.code || null),
        ...(err?.servedModel ? { model: err.servedModel } : {})
      };
    } finally {
      clearTimeout(timeout);
    }
  } else {
    const dataUrl = `data:${mimeType || 'application/pdf'};base64,${clean}`;
    let response;
    try {
      response = await __callOpenAi({
        apiKey: config.apiKey,
        model: config.model,
        dataUrl,
        filename,
        clientContext,
        clientIdentity,
        signal: controller.signal
      });
    } catch (err) {
      if (isProviderSpendLimit(err)) throw err;
      console.error('[documentRouter] OpenAI request threw', {
        correlation_id: correlationId,
        error_code: err?.code || null,
        error_name: err?.name || null,
        elapsed_ms: Date.now() - startedAt
      });
      return { routed: false, reason: 'llm_error' };
    } finally {
      clearTimeout(timeout);
    }

    if (!response?.ok) {
      const status = Number(response?.status || 0);
      console.error('[documentRouter] OpenAI returned non-OK', {
        correlation_id: correlationId,
        status,
        elapsed_ms: Date.now() - startedAt
      });
      return { routed: false, reason: 'llm_error' };
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { routed: false, reason: 'llm_error' };
    }
    text = outputTextFromResponse(payload);
    servedModel = typeof payload?.model === 'string' && payload.model ? payload.model : null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[documentRouter] structured response was not valid JSON', {
      correlation_id: correlationId,
      elapsed_ms: Date.now() - startedAt
    });
    return { routed: false, reason: 'llm_error' };
  }

  // ── Normalise / coerce ────────────────────────────────────────────
  let family = String(parsed.document_family || '');
  if (!DOCUMENT_FAMILIES_SET.has(family)) {
    family = 'unknown_but_relevant';
  }

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  let directionHint = String(parsed.direction_hint || 'unknown');
  if (!DIRECTION_HINTS.includes(directionHint)) directionHint = 'unknown';

  const candidateFamilies = Array.isArray(parsed.candidate_families)
    ? parsed.candidate_families.slice(0, 3).map((c) => ({
        family: DOCUMENT_FAMILIES_SET.has(c?.family) ? c.family : 'unknown_but_relevant',
        confidence: Math.max(0, Math.min(1, Number(c?.confidence) || 0))
      }))
    : [];

  const languageHint = String(parsed.language_hint || '').slice(0, 10) || 'unknown';
  const reason = String(parsed.reason || '').slice(0, 500);

  const recommendedExtractor = resolveExtractor(family, directionHint);

  console.log('[documentRouter] classification complete', {
    correlation_id: correlationId,
    family,
    confidence_band: confidence < 0.5 ? '<0.5' : confidence < 0.8 ? '0.5-0.8' : '>=0.8',
    direction_hint: directionHint,
    recommended_extractor: recommendedExtractor,
    elapsed_ms: Date.now() - startedAt
  });

  return {
    routed: true,
    // The model id is part of the receipt — the worker writes it into
    // the classification audit and the router confidence envelope, so
    // it must be the model that actually ran: the one the RESPONSE named,
    // the configured id only when the response named none (and then
    // `model_source` says so).
    ...(() => {
      const provenance = classifyModelProvenance({ responseModel: servedModel, requestedModel: config.model });
      return { model: provenance.model, model_source: provenance.model_source };
    })(),
    provider: config.provider,
    family,
    confidence,
    direction_hint: directionHint,
    recommended_extractor: recommendedExtractor,
    candidate_families: candidateFamilies,
    language_hint: languageHint,
    reason
  };
};

// ── Test-visible exports ────────────────────────────────────────────
export const __DOCUMENT_FAMILIES = DOCUMENT_FAMILIES;
export const __FAMILY_TO_EXTRACTOR = FAMILY_TO_EXTRACTOR;
export const __ROUTER_SCHEMA = ROUTER_SCHEMA;
export const __DEFAULT_MODEL = DEFAULT_MODEL;
