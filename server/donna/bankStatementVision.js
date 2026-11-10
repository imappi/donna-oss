import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { PDFDocument } from 'pdf-lib';

import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { asProviderResponse, llmCall } from './llmCall.js';
import { classifyModelProvenance } from './providerEndpoints.js';
import {
  ANTHROPIC_MAX_REQUEST_BYTES,
  anthropicFileBlock,
  documentLaneAnthropicRequest,
  missingProviderFor,
  resolveDocumentLaneProvider
} from './documentLaneRequest.js';

// PROVIDERS (2026-11-10, the owner's decision that Donna runs on Claude):
// the lane resolves its provider through providerEndpoints.js
// resolveLaneProvider (documentLaneRequest.js) — Anthropic (claude-opus-5-5)
// first, OpenAI (gpt-5.4) only when no Anthropic key is configured. Every
// call rides the llmCall envelope; on Anthropic the shared structured
// request (structuredRequest.js: document block + structured output,
// streamed). The model id this module returns is the one the provider's
// RESPONSE named. The exported names below still say "OpenAi" because the
// pipeline and tests import them by those names; they serve both providers.
//
// Structured statement extraction on the strong model, two transports:
//
//   1. VISION (extractStructuredFromOpenAiVisionPaginated) — the PDF goes
//      to the provider as a file (OpenAI input_file / Anthropic document
//      block). Historically the OCR fallback for scanned statements with no
//      text layer.
//   2. TEXT (extractStructuredFromStatementText) — the PDF's own text
//      layer (or a pasted/text upload) goes as input_text. This is the
//      LLM-first tier for native-text statements: the same schema, no
//      vision spend. Added after a client's tiliote showed the regex
//      parser shipping payment-type words ("Tilisiirto") as descriptions
//      — the model maps ANY bank's layout onto the semantic line schema
//      (counterparty / payment_method / message / reference), which is
//      what makes a never-seen statement format Just Work.
//
// Both transports share STRUCTURED_RESPONSE_SCHEMA, the normalizer, and
// the display composition. Deterministic validation of the result
// (balance equation, printed-totals cross-check) lives in
// bankStatement.js — the model extracts, arithmetic decides acceptance.
//
// There is also a plain-OCR entry (ocrPdfWithOpenAiVision) whose output
// feeds the legacy regex parser; it predates the structured paths.

const readDotEnvFromCwd = () => {
  const vars = {};
  try {
    const path = resolvePath(process.cwd(), '.env');
    if (!existsSync(path)) return vars;
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch { /* best-effort */ }
  return vars;
};

const readPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const DEFAULT_MAX_PDF_BYTES = 25 * 1024 * 1024;

const getSupabaseConfig = (dotEnv) => {
  const url = String(
    process.env.SUPABASE_URL ||
      process.env.VITE_SUPABASE_URL ||
      dotEnv.SUPABASE_URL ||
      dotEnv.VITE_SUPABASE_URL ||
      ''
  ).trim().replace(/\/+$/, '');
  const key = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      dotEnv.SUPABASE_SERVICE_ROLE_KEY ||
      dotEnv.SUPABASE_SERVICE_KEY ||
      dotEnv.SUPABASE_SECRET_KEY ||
      ''
  ).trim().replace(/^['"]|['"]$/g, '');
  return { url, key };
};

// The lane's strong default per provider. The project-wide OPENAI_MODEL is
// deliberately NOT read here: it is often a small/fast model tuned for chat
// latency, and dense financial PDFs need the strong tier. OPENAI_VISION_MODEL
// stays the lane's model knob (any provider's id: a claude id pins Anthropic,
// a gpt id pins OpenAI).
export const STATEMENT_READER_DEFAULT_MODELS = Object.freeze({
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.4'
});
// Depth per call on Anthropic (adaptive thinking is always on): reading
// every line of a statement exactly is the work that repays depth; the
// plain transcription entry is mechanical reading.
const STRUCTURED_EFFORT = 'high';
const TRANSCRIPTION_EFFORT = 'medium';
// Thinking counts toward max_tokens; a 4-page chunk or a 48K-char text
// fragment can carry a long line list. A reply that still hits the cap is
// a named failure (PROVIDER_OUTPUT_LIMIT), never a truncated statement.
const STATEMENT_MAX_TOKENS = 64_000;

const getOpenAiConfig = () => {
  const dotEnv = readDotEnvFromCwd();
  const resolved = resolveDocumentLaneProvider({
    laneId: 'bank_statement_vision',
    dotEnv,
    modelEnvKeys: ['OPENAI_VISION_MODEL'],
    defaultModels: STATEMENT_READER_DEFAULT_MODELS
  });
  return {
    provider: resolved.provider,
    // The provider whose key is missing when none is configured: the lane's
    // first (the parse wait names ANTHROPIC_API_KEY, not a key the
    // installation never meant to hold).
    missingProvider: resolved.ok ? null : missingProviderFor(resolved, 'bank_statement_vision'),
    apiKey: resolved.ok ? resolved.apiKey : '',
    configured: resolved.ok,
    reason: resolved.reason,
    model: resolved.model,
    pagesPerChunk: readPositiveInt(
      process.env.OPENAI_VISION_PAGES_PER_CHUNK || dotEnv.OPENAI_VISION_PAGES_PER_CHUNK,
      4
    ),
    concurrency: readPositiveInt(
      process.env.OPENAI_VISION_CONCURRENCY || dotEnv.OPENAI_VISION_CONCURRENCY,
      6
    ),
    maxPdfBytes: readPositiveInt(
      process.env.OPENAI_VISION_MAX_PDF_BYTES || dotEnv.OPENAI_VISION_MAX_PDF_BYTES,
      DEFAULT_MAX_PDF_BYTES
    ),
    cache: (() => {
      const supabase = getSupabaseConfig(dotEnv);
      const disabled =
        String(process.env.OPENAI_VISION_CACHE_DISABLED || dotEnv.OPENAI_VISION_CACHE_DISABLED || '')
          .toLowerCase() === 'true';
      return {
        enabled: Boolean(supabase.url && supabase.key) && !disabled,
        url: supabase.url,
        key: supabase.key,
        bucket: String(
          process.env.DONNA_EVIDENCE_BUCKET ||
            process.env.SUPABASE_EVIDENCE_BUCKET ||
            dotEnv.DONNA_EVIDENCE_BUCKET ||
            dotEnv.SUPABASE_EVIDENCE_BUCKET ||
            'donna-evidence'
        ),
        prefix: String(
          process.env.OPENAI_VISION_CACHE_PREFIX ||
            dotEnv.OPENAI_VISION_CACHE_PREFIX ||
            'cache/bank-statement-vision/'
        )
      };
    })()
  };
};

const OCR_PROMPT = [
  'You are reading a bank or payment-provider statement (PDF, possibly a',
  'scanned image). Transcribe ALL visible text exactly as it appears, row',
  'by row, preserving the order on the page. Do not paraphrase, summarize,',
  'or add commentary. For tabular data, keep one transaction per line and',
  'separate columns (date · description · amount · balance · currency)',
  'with single spaces. Include statement header (account number, period,',
  'opening/closing balance) at the top. Output plain text only — no',
  'markdown, no JSON, no code fences.'
].join(' ');

const STRUCTURED_PROMPT = [
  'You are extracting transactions from a bank or payment-provider',
  'statement. The statement may be in ANY language (English, Finnish,',
  'Swedish, German, …) and ANY layout — map what the columns MEAN, not',
  'what they are called. Return EVERY transaction visible in the',
  'document — do not omit any. Preserve separate source rows even when',
  'their dates, parties and amounts are identical; never deduplicate them.',
  'Extract movements only once: a fees/charges summary repeats amounts already',
  'included in the transaction table and is not another debit. Opening/closing',
  'balances, subtotals and carried-forward rows are not transactions.',
  'Keep transaction sequence numbers separate from the amount column.',
  'For each transaction:',
  '',
  '- `date`: the calendar date of the transaction in ISO format YYYY-MM-DD.',
  '  If only the day and month are visible, infer the year from the',
  '  statement period header.',
  '- `counterparty`: the OTHER PARTY of the transaction — the payee,',
  '  payer, or merchant name exactly as printed (e.g. the Finnish',
  '  "Saaja/Maksaja" column). Null when the line genuinely names no',
  '  party (e.g. a bank service fee or interest line). NEVER put the',
  '  payment type here.',
  '- `payment_method`: the payment instrument or transaction-type word',
  '  printed on the line, when the statement has one — e.g. Finnish',
  '  "Selitys" values like TILISIIRTO, KORTTIMAKSU, VIITESIIRTO,',
  '  PALVELUMAKSU, or "Direct Debit", "GIRO", "Standing Order". Null',
  '  when absent. This is metadata, never the description of the',
  '  transaction.',
  '- `message`: the free-text message / narrative on the line (e.g. the',
  '  Finnish "Viesti" field), if any. Null when absent.',
  '- `reference`: the structured payment reference number (e.g. the',
  '  Finnish "Viite" / viitenumero, or a UK payment reference), if any.',
  '  Null when absent.',
  '- `description`: one readable line for a human list view. Lead with',
  '  the counterparty when one exists; add the message or reference when',
  '  it helps. Do NOT let this be just the payment-type word when the',
  '  line names a party.',
  '- `direction`: "in" for money received / credits, "out" for money',
  '  paid / debits. Use the sign of the amount column or the column the',
  '  amount is in (DEBIT vs CREDIT / PANO vs OTTO). Note trailing-minus',
  '  amounts ("123,45-") are debits.',
  '- `amount`: the absolute amount, as a positive number (no currency',
  '  symbol, no thousands separator, decimal as `.` — normalize',
  '  European formats like "1 234,56" to 1234.56).',
  '- `currency`: the ISO 4217 code for the transaction currency. If the',
  '  statement is in a single currency, repeat that code for each row.',
  '- `balance`: the running balance after the transaction, if shown,',
  '  as a positive or negative number. Use null when not printed for that',
  '  row; never calculate or invent intermediate balances.',
  '',
  'Also return a `statement_summary` object with whatever header values',
  'are visible: `opening_balance`, `closing_balance` (e.g. Finnish',
  '"Saldo"), `total_deposits`, `total_payouts` (e.g. "Panot yhteensä" /',
  '"Otot yhteensä"), `currency`, `period_start`, `period_end`,',
  '`account_identifier` (account number or IBAN). For a bundle of daily',
  'statements use the first opening and last closing balance, and aggregate',
  'the printed daily movement totals once each. Do not confuse row counts',
  'with amounts. When chunked, summarize only the supplied fragment.',
  '',
  'If the document is not actually a bank statement, return an empty',
  'transactions array. Do NOT invent data. Do NOT include narrative text',
  'outside the JSON.'
].join('\n');

const STRUCTURED_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', description: 'ISO 8601 calendar date, YYYY-MM-DD.' },
          counterparty: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'The other party (payee/payer/merchant) as printed; never the payment type.'
          },
          payment_method: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Payment instrument / transaction-type word on the line (TILISIIRTO, KORTTIMAKSU, Direct Debit, …).'
          },
          message: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Free-text message / narrative on the line.'
          },
          reference: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Structured payment reference number (viite, payment reference).'
          },
          description: { type: 'string' },
          direction: { type: 'string', enum: ['in', 'out'] },
          amount: { type: 'number', description: 'Absolute amount; sign is conveyed by direction.' },
          currency: { type: 'string', description: 'ISO 4217 currency code.' },
          balance: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: 'Running balance after the transaction, if printed.'
          }
        },
        required: ['date', 'counterparty', 'payment_method', 'message', 'reference', 'description', 'direction', 'amount', 'currency', 'balance']
      }
    },
    statement_summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        opening_balance: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        closing_balance: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        total_deposits: {
          anyOf: [{ type: 'number' }, { type: 'null' }],
          description: 'Printed total of money in over the period, when the statement shows one.'
        },
        total_payouts: {
          anyOf: [{ type: 'number' }, { type: 'null' }],
          description: 'Printed total of money out over the period, when the statement shows one.'
        },
        currency: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        period_start: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        period_end: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        account_identifier: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      },
      required: ['opening_balance', 'closing_balance', 'total_deposits', 'total_payouts', 'currency', 'period_start', 'period_end', 'account_identifier']
    }
  },
  required: ['transactions', 'statement_summary']
};

// Long multi-month statements (Airwallex hit ~16 months in one PDF) can
// take 2-3 minutes for vision + structured JSON to complete. The Vercel
// function cap is configured to 300s in vercel.json; this AbortController
// timeout sits just under that so we surface a clear error rather than
// a hard function kill.
const OPENAI_VISION_TIMEOUT_MS = 240_000;

// Supabase Storage cache lookup/write. Healthy reads return in <500ms;
// a wedged Storage endpoint would otherwise burn the whole parse budget
// silently (the previous code had no AbortController on these fetches).
// 8s default is generous: enough headroom for a cold-start network hop,
// short enough that a hung cache can't push the parse past the function
// ceiling. Read fresh on each call so the test suite can pin a small
// value via env without a module-cache reload.
const getCacheFetchTimeoutMs = () => {
  const raw = Number(process.env.BANK_STATEMENT_CACHE_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
};

const trimBase64 = (base64 = '') => String(base64 || '').replace(/[\r\n\s]/g, '');

const base64ByteLength = (base64 = '') => {
  const clean = trimBase64(base64);
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
};

const computePdfSha256 = (base64 = '') => {
  const clean = trimBase64(base64);
  if (!clean) return '';
  return createHash('sha256').update(Buffer.from(clean, 'base64')).digest('hex');
};

export const computeVisionCacheKey = (base64 = '') => computePdfSha256(base64);

// Per-chunk cache key. Each chunk's base64 is a standalone PDF (carved
// out by splitPdfBase64), so its SHA is stable across re-runs of the
// SAME source PDF: a retry after a partial timeout sees the same chunk
// bytes → the same SHA → the cached result skips OpenAI entirely.
// This is what converts a 300s ceiling-hit into "do the chunks that
// failed, skip the chunks that succeeded" on retry.
export const computeChunkCacheKey = (base64 = '') => computePdfSha256(base64);

const buildChunkPrefix = (basePrefix) => {
  const trimmed = String(basePrefix || '').replace(/\/+$/, '');
  return `${trimmed}/chunks/`;
};

const cacheStorageUrlForPath = (cache, relativePath) => {
  // Old caches may have lost legitimate equal payments or merged column digits.
  const path = `source-rows-v2/${relativePath}`.replace(/\/{2,}/g, '/');
  return `${cache.url}/storage/v1/object/${encodeURIComponent(cache.bucket)}/${path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
};

const cacheStorageUrl = (cache, sha) =>
  cacheStorageUrlForPath(cache, `${cache.prefix}${sha}.json`);

const cacheStorageUrlForChunk = (cache, sha) =>
  cacheStorageUrlForPath(cache, `${buildChunkPrefix(cache.prefix)}${sha}.json`);

// Text-transport results live under their own subpath so a text-layer
// extraction can never collide with a vision result for the same bytes
// (the keys are different hashes anyway — PDF sha vs text sha — but the
// separation keeps the cache legible).
const cacheStorageUrlForText = (cache, sha) =>
  cacheStorageUrlForPath(cache, `${String(cache.prefix || '').replace(/\/+$/, '')}/text/${sha}.json`);

// AbortController-wrapped fetch with a budget that ALWAYS bounds the
// call. Returns a Response on success, null on timeout/network error.
// Used by both the lookup and write paths so a wedged Storage endpoint
// can't add to the extraction budget. The timer is cleared in `finally`
// so it never dangles after the race settles.
const fetchWithBudget = async (url, init, label) => {
  const timeoutMs = getCacheFetchTimeoutMs();
  const controller = new AbortController();
  let timer = null;
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.warn(`[bankStatementVision] ${label} aborted after ${timeoutMs}ms`);
    } else {
      console.warn(`[bankStatementVision] ${label} threw`, { message: error?.message });
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const lookupVisionCacheByUrl = async (cache, url, sha, label) => {
  if (!cache.enabled || !sha) return null;
  const response = await fetchWithBudget(
    url,
    {
      method: 'GET',
      headers: {
        apikey: cache.key,
        Authorization: `Bearer ${cache.key}`
      }
    },
    label
  );
  if (!response) return null;
  if (response.status === 404) return null;
  if (!response.ok) {
    console.warn('[bankStatementVision] cache lookup non-OK', { status: response.status, sha });
    return null;
  }
  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.transactions)) return null;
  return body;
};

const lookupVisionCache = async (cache, sha) =>
  lookupVisionCacheByUrl(cache, cacheStorageUrl(cache, sha), sha, 'cache lookup');

const lookupChunkVisionCache = async (cache, sha) =>
  lookupVisionCacheByUrl(cache, cacheStorageUrlForChunk(cache, sha), sha, 'chunk cache lookup');

const writeVisionCacheByUrl = async (cache, url, sha, payload, label) => {
  if (!cache.enabled || !sha) return false;
  const response = await fetchWithBudget(
    url,
    {
      method: 'POST',
      headers: {
        apikey: cache.key,
        Authorization: `Bearer ${cache.key}`,
        'Content-Type': 'application/json',
        // Supabase Storage: x-upsert overwrites if the object already exists.
        // We want overwrite-on-write so a re-run on the same SHA refreshes
        // rather than 409s.
        'x-upsert': 'true'
      },
      body: JSON.stringify(payload)
    },
    label
  );
  if (!response) return false;
  if (!response.ok) {
    console.warn('[bankStatementVision] cache write failed', { sha, status: response.status });
    return false;
  }
  return true;
};

const writeVisionCache = async (cache, sha, payload) =>
  writeVisionCacheByUrl(cache, cacheStorageUrl(cache, sha), sha, payload, 'cache write');

const writeChunkVisionCache = async (cache, sha, payload) =>
  writeVisionCacheByUrl(cache, cacheStorageUrlForChunk(cache, sha), sha, payload, 'chunk cache write');

const extractTextFromResponse = (payload) => {
  // The Responses API returns output as an array of items; text content
  // lives at output[].content[].text. Handle both that shape and the
  // legacy output_text shortcut.
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const chunks = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const piece of content) {
      if (typeof piece?.text === 'string') chunks.push(piece.text);
      else if (typeof piece?.text?.value === 'string') chunks.push(piece.text.value);
    }
  }
  return chunks.join('\n');
};

// Can the statement reader run at all — does any of the lane's providers
// hold a key? (Name kept: the pipeline imports it.)
export const isOpenAiVisionConfigured = () => getOpenAiConfig().configured;

// Which provider the statement reader is waiting on when it is not
// configured (the parse worker's not_configured record names it).
export const statementReaderMissingProvider = () => getOpenAiConfig().missingProvider;

const notConfiguredError = (config, what) => {
  const error = new Error(`No model provider key is configured for ${what} (${config.reason || 'no_provider_key'}).`);
  error.code = 'STATEMENT_READER_NOT_CONFIGURED';
  error.reason = config.reason || 'no_provider_key';
  return error;
};

// ── the one request ─────────────────────────────────────────────────────
// Every provider call this module makes goes through here: the lane's
// resolved provider, the envelope, and the response-named model back.
// `file` is { base64, mimeType, filename } or null; `schema` null asks for
// plain text. Throws on any failure with a typed code; returns
// { text, servedModel, provider }.
const executionRefFor = (seed) => ({
  root: { type: 'bank_statement_extraction', id: createHash('sha256').update(String(seed || 'statement')).digest('hex').slice(0, 16) }
});

const requestStatementModel = async ({ config, file = null, prompt, schema = null, effort, label, seed }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_VISION_TIMEOUT_MS);
  const execution = executionRefFor(seed);
  const withSignal = (url, init) => fetch(url, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  });
  try {
    if (config.provider === 'anthropic') {
      try {
        const content = file
          ? [anthropicFileBlock({ base64: file.base64, mimeType: file.mimeType, filename: file.filename }), { type: 'text', text: prompt }]
          : [{ type: 'text', text: prompt }];
        const { result } = await llmCall(documentLaneAnthropicRequest({
          apiKey: config.apiKey,
          model: config.model,
          content,
          schema,
          effort,
          maxTokens: STATEMENT_MAX_TOKENS,
          execution,
          sections: { context: prompt, tools: schema || undefined },
          signal: controller.signal,
          timeoutMs: OPENAI_VISION_TIMEOUT_MS
        }));
        return {
          text: schema ? JSON.stringify(result.parsed) : result.text,
          servedModel: result.model || null,
          provider: 'anthropic'
        };
      } catch (error) {
        error.provider ||= 'anthropic';
        if (error?.code === 'LLM_CALL_PROVIDER_ERROR') {
          console.error(`[bankStatementVision] ${label} request failed`, { provider: 'anthropic', status: error.status, model: config.model });
          error.statusCode = error.status;
          // The provider's own error object, where #71's fault reader looks
          // (an account with no credit is a provider wait, not a rejection).
          error.details = { error: error.providerError || null };
        }
        throw error;
      }
    }
    const content = file
      ? [
          buildResponsesDocumentPart({
            dataUrl: `data:${file.mimeType || 'application/pdf'};base64,${file.base64}`,
            filename: file.filename,
            fallbackFilename: 'statement.pdf'
          }),
          { type: 'input_text', text: prompt }
        ]
      : [{ type: 'input_text', text: prompt }];
    const body = { model: config.model, store: false, input: [{ role: 'user', content }] };
    if (schema) body.text = { format: { type: 'json_schema', name: 'bank_statement_extraction', strict: true, schema } };
    const response = await asProviderResponse(llmCall({
      provider: 'openai',
      // The lane's own wall, honoured inside a worker too (llmCall hands it to
      // the deadline transport, bounded by the job's remaining budget).
      timeoutMs: OPENAI_VISION_TIMEOUT_MS,
      url: 'https://api.openai.com/v1/responses',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body,
      sections: { context: prompt, tools: schema || undefined },
      execution,
      fetchImpl: withSignal
    }));
    if (!response.ok) {
      console.error(`[bankStatementVision] ${label} request failed`, { provider: 'openai', status: response.status, model: config.model });
      const error = new Error(`OpenAI ${label} failed with ${response.status}.`);
      error.code = file ? 'OPENAI_VISION_REQUEST_FAILED' : 'OPENAI_TEXT_REQUEST_FAILED';
      error.statusCode = response.status;
      error.provider = 'openai';
      error.details = await response.json().catch(() => null);
      throw error;
    }
    const payload = await response.json();
    return {
      text: extractTextFromResponse(payload),
      servedModel: typeof payload?.model === 'string' && payload.model ? payload.model : null,
      provider: 'openai'
    };
  } finally {
    clearTimeout(timeout);
  }
};

// The model on the statement's receipt is the one each RESPONSE named,
// recorded per call with its source (providerEndpoints.js
// classifyModelProvenance): `response_proven` when the response named it,
// `configured_fallback` when it named none (the requested id stands in), and
// a chunk read back from the cache keeps the source it was stored with
// (`legacy_unproven` for an entry written before sources were stored).
// The read's `model_source` is the weakest of its calls'. One id answers in
// practice; when chunks were answered by different ids (a chunk cached under
// one model, the rest read under another) the read stores the id that
// answered most chunks (the first in page order on a tie) as `model`, and
// every chunk's id and source in `chunk_models` — never a joined string.
const SOURCE_RANK = Object.freeze({ response_proven: 0, configured_fallback: 1, legacy_unproven: 2 });
const callProvenance = (result, config) => (result?.cached_model_source
  ? { model: result.served_model || null, model_source: result.cached_model_source }
  : classifyModelProvenance({ responseModel: result?.served_model, requestedModel: config.model }));
const provenanceOfResults = (results, config, pages = []) => {
  const calls = results.map((result, index) => ({ ...callProvenance(result, config), ...(pages[index] || {}) }));
  const counts = new Map();
  for (const call of calls) if (call.model) counts.set(call.model, (counts.get(call.model) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const model = ranked[0]?.[0] || config.model;
  const modelSource = calls.reduce((worst, call) => ((SOURCE_RANK[call.model_source] ?? 2) > (SOURCE_RANK[worst] ?? 2) ? call.model_source : worst), 'response_proven');
  return { model, model_source: calls.length ? modelSource : 'configured_fallback', ...(counts.size > 1 ? { chunk_models: calls } : {}) };
};

// Anthropic's request limit is on the encoded request (32 MB). A chunk that
// would exceed it is split further — down to single pages — exactly the way
// the lane already splits a long statement; a single page that still does
// not fit fails as too large. Nothing is ever dropped to make it fit.
const ANTHROPIC_CHUNK_BYTE_BUDGET = ANTHROPIC_MAX_REQUEST_BYTES - 1024 * 1024;

const fitChunksToRequestLimit = async (config, chunks, budget = ANTHROPIC_CHUNK_BYTE_BUDGET) => {
  if (config.provider !== 'anthropic') return chunks;
  const fitted = [];
  for (const chunk of chunks) {
    if (chunk.base64.length <= budget) { fitted.push(chunk); continue; }
    const pages = chunk.pageEnd - chunk.pageStart + 1;
    if (pages <= 1) {
      const error = new Error(`One page of this PDF is larger than the ${Math.floor(ANTHROPIC_MAX_REQUEST_BYTES / 1024 / 1024)} MB model request limit.`);
      error.code = 'OPENAI_VISION_PDF_TOO_LARGE';
      error.byteSize = base64ByteLength(chunk.base64);
      error.maxBytes = budget;
      throw error;
    }
    const singles = await splitPdfBase64(chunk.base64, 1);
    fitted.push(...await fitChunksToRequestLimit(config, singles.map((single) => ({
      ...single,
      pageStart: chunk.pageStart + single.pageStart - 1,
      pageEnd: chunk.pageStart + single.pageEnd - 1,
      totalPages: chunk.totalPages
    })), budget));
  }
  return fitted;
};

const cleanLineField = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
};

// Deterministic display composition for a statement line: the
// counterparty leads, the message/reference adds context, and the
// payment-type word ("Tilisiirto", "Korttimaksu", "Direct Debit") is
// NEVER the headline while anything better exists. The model also
// returns its own `description`; we recompose here so the list-view
// contract cannot drift with prompt wording. Exported for tests.
export const composeStatementLineDescription = ({
  counterparty = null,
  payment_method: paymentMethod = null,
  message = null,
  reference = null,
  model_description: modelDescription = null
} = {}) => {
  const party = cleanLineField(counterparty);
  const method = cleanLineField(paymentMethod);
  const note = cleanLineField(message);
  const ref = cleanLineField(reference);
  const modelText = cleanLineField(modelDescription);
  const detail = note || ref;
  if (party) {
    return detail && detail.toLowerCase() !== party.toLowerCase()
      ? `${party} · ${detail}`
      : party;
  }
  if (detail) return detail;
  // No party and no message: the model's own line, unless it is just the
  // payment-type word repeated — then fall through to that word once.
  if (modelText && (!method || modelText.toLowerCase() !== method.toLowerCase())) return modelText;
  return method || modelText || '';
};

// Maps the model's `{ direction, amount }` shape to the parser's
// `{ money_in, money_out }` shape so downstream code (statement-summary
// validation, ledger preview, FE rendering) doesn't have to know
// anything about the OpenAI path. The semantic fields (counterparty,
// payment_method, message, reference) ride along: the parse writer
// spreads the whole row into `transactions.payload`, which is where the
// matcher/coder read their vendor signal from.
const normalizeStructuredTransactions = (rows = [], { parserFlag = 'openai_vision' } = {}) =>
  rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const direction = row.direction === 'in' ? 'in' : 'out';
      const amount = Number.isFinite(row.amount) ? Math.abs(Number(row.amount)) : 0;
      const date = typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : '';
      if (!date || amount === 0) return null;
      const counterparty = cleanLineField(row.counterparty);
      const paymentMethod = cleanLineField(row.payment_method);
      const message = cleanLineField(row.message);
      const reference = cleanLineField(row.reference);
      return {
        date,
        description: composeStatementLineDescription({
          counterparty,
          payment_method: paymentMethod,
          message,
          reference,
          model_description: row.description
        }),
        counterparty,
        payment_method: paymentMethod,
        message,
        reference,
        money_in: direction === 'in' ? amount : 0,
        money_out: direction === 'out' ? amount : 0,
        balance: Number.isFinite(row.balance) ? Number(row.balance) : null,
        currency: typeof row.currency === 'string' ? row.currency.toUpperCase() : '',
        confidence: 'medium',
        parser_flags: [parserFlag],
        source_line: ''
      };
    })
    .filter(Boolean);

const buildChunkPrompt = (chunkContext) => {
  if (!chunkContext) return STRUCTURED_PROMPT;
  const { pageStart, pageEnd, totalPages, periodHint } = chunkContext;
  const header = [
    `This PDF is a fragment of a larger bank statement — specifically pages`,
    `${pageStart}–${pageEnd} of ${totalPages}. Return ONLY transactions visible`,
    `in this fragment. Do not invent rows that would belong on other pages.`,
    periodHint
      ? `The full statement covers approximately ${periodHint}; if a row shows only month+day, infer the year from that range.`
      : 'If a row shows only month+day, infer the year from the date range covered by the visible rows.'
  ].join(' ');
  return `${header}\n\n${STRUCTURED_PROMPT}`;
};

export const extractStructuredFromOpenAiVision = async ({
  base64,
  filename = 'statement.pdf',
  mimeType = 'application/pdf',
  chunkContext = null
} = {}) => {
  const config = getOpenAiConfig();
  if (!config.configured) throw notConfiguredError(config, 'statement reading');
  const clean = trimBase64(base64);
  if (!clean) {
    const error = new Error('No PDF data provided to OCR.');
    error.code = 'OPENAI_EMPTY_INPUT';
    throw error;
  }
  const prompt = buildChunkPrompt(chunkContext);
  const { text, servedModel, provider } = await requestStatementModel({
    config,
    file: { base64: clean, mimeType: mimeType || 'application/pdf', filename },
    prompt,
    schema: STRUCTURED_RESPONSE_SCHEMA,
    effort: STRUCTURED_EFFORT,
    label: 'structured vision',
    seed: computePdfSha256(clean)
  });
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[bankStatementVision] structured response was not valid JSON', {
      provider,
      model: servedModel || config.model,
      filename,
      text_length: String(text || '').length
    });
    const error = new Error('Structured vision returned unparseable JSON.');
    error.code = 'OPENAI_VISION_BAD_JSON';
    throw error;
  }

  const transactions = normalizeStructuredTransactions(
    Array.isArray(parsed?.transactions) ? parsed.transactions : []
  );
  console.log('[bankStatementVision] structured extraction complete', {
    provider,
    model: servedModel || config.model,
    filename,
    raw_transaction_count: Array.isArray(parsed?.transactions) ? parsed.transactions.length : 0,
    normalized_transaction_count: transactions.length,
    has_summary: Boolean(parsed?.statement_summary),
    chunk: chunkContext
      ? `${chunkContext.pageStart}-${chunkContext.pageEnd}/${chunkContext.totalPages}`
      : null
  });
  return {
    transactions,
    statement_summary: parsed?.statement_summary || null,
    served_model: servedModel,
    provider
  };
};

// Fixed metadata stamped onto every chunk PDF so its bytes — and therefore its
// cache SHA — depend ONLY on the source pages, never on the clock. See the
// comment inside splitPdfBase64 for why this is correctness, not cosmetics.
// Changing either value invalidates every cached chunk (a one-off re-extract),
// so treat them as frozen.
const CHUNK_METADATA_EPOCH = new Date(Date.UTC(2000, 0, 1));
const CHUNK_METADATA_PRODUCER = 'donna-chunk-splitter';

// Splits a base64 PDF into N-page chunks. Returns a single-entry array
// (with the original base64 unchanged) when the PDF is small enough that
// chunking would add overhead without buying parallelism. Each chunk
// carries its own page range so the caller can build a chunk-aware prompt
// and preserve source rows on merge.
export const splitPdfBase64 = async (base64, pagesPerChunk = 4) => {
  const clean = trimBase64(base64);
  if (!clean) return [];
  const bytes = Buffer.from(clean, 'base64');
  // ignoreEncryption: many bank statements ship as "owner-password" PDFs
  // that allow read but block edits. pdf-lib refuses to load them by
  // default; the flag lets us still split them.
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const totalPages = src.getPageCount();
  if (totalPages <= pagesPerChunk) {
    return [{ base64: clean, pageStart: 1, pageEnd: totalPages, totalPages }];
  }

  const chunks = [];
  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const dst = await PDFDocument.create();
    // DETERMINISM, and it is load-bearing — not tidiness.
    //
    // pdf-lib stamps a NEW document's Info dictionary with the current clock
    // (CreationDate / ModDate, deflated into an object stream). Those bytes go
    // into the chunk, so the same source PDF split at two different moments
    // produced two different chunk SHAs — which silently broke the retry
    // promise this whole chunk cache exists for: "a retry after a partial
    // timeout sees the same chunk bytes → the same SHA → the cached result
    // skips OpenAI entirely." It never did. Every retry re-ran every chunk.
    //
    // The chunk PDF is an internal artifact — it is handed to the vision call
    // and hashed for the cache key, never delivered to anyone — so pinning its
    // metadata costs nothing and is what makes the documented behaviour true.
    // The epoch is a fixed constant, deliberately not derived from the source
    // (a source PDF may carry no dates at all).
    dst.setCreationDate(CHUNK_METADATA_EPOCH);
    dst.setModificationDate(CHUNK_METADATA_EPOCH);
    dst.setProducer(CHUNK_METADATA_PRODUCER);
    dst.setCreator(CHUNK_METADATA_PRODUCER);
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const copied = await dst.copyPages(src, indices);
    copied.forEach((page) => dst.addPage(page));
    const out = await dst.save();
    chunks.push({
      base64: Buffer.from(out).toString('base64'),
      pageStart: start + 1,
      pageEnd: end,
      totalPages
    });
  }
  return chunks;
};

const runWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    () => runner()
  );
  await Promise.all(workers);
  return results;
};

// Chunks contain disjoint source pages/lines. Equal financial values are not
// row identity: two separate payments can have every display field in common.
// Paginated entry point. Splits the PDF, fans out one structured-vision
// call per chunk with bounded concurrency, then merges. A single-chunk
// statement skips the split entirely and is identical in cost to calling
// extractStructuredFromOpenAiVision directly.
export const extractStructuredFromOpenAiVisionPaginated = async ({
  base64,
  filename = 'statement.pdf',
  mimeType = 'application/pdf',
  periodHint = '',
  pagesPerChunk,
  concurrency,
  bypassCache = false
} = {}) => {
  const config = getOpenAiConfig();
  if (bypassCache) config.cache.enabled = false;
  if (!config.configured) throw notConfiguredError(config, 'statement reading');
  const clean = trimBase64(base64);
  if (!clean) {
    const error = new Error('No PDF data provided to OCR.');
    error.code = 'OPENAI_EMPTY_INPUT';
    throw error;
  }

  // Size guardrail. Vision is the expensive tier — keep dumb-large
  // uploads (someone accidentally drops a 200 MB scanned book) from
  // burning through tokens and timing out the function. Text-layer
  // and local-OCR tiers already ran above this point with no spend.
  const byteSize = base64ByteLength(clean);
  if (byteSize > config.maxPdfBytes) {
    const error = new Error(
      `PDF is ${(byteSize / 1024 / 1024).toFixed(1)} MB, which exceeds the ${(config.maxPdfBytes / 1024 / 1024).toFixed(0)} MB cloud OCR limit.`
    );
    error.code = 'OPENAI_VISION_PDF_TOO_LARGE';
    error.byteSize = byteSize;
    error.maxBytes = config.maxPdfBytes;
    throw error;
  }

  const sha = computePdfSha256(clean);
  const cached = await lookupVisionCache(config.cache, sha);
  if (cached) {
    console.log('[bankStatementVision] cache hit', {
      filename,
      sha: sha.slice(0, 12),
      cached_transaction_count: cached.transactions.length,
      cached_at: cached.cached_at || null,
      cached_model: cached.model || null
    });
    return {
      transactions: cached.transactions,
      statement_summary: cached.statement_summary || null,
      model: cached.model || config.model,
      model_source: cached.model ? (cached.model_source || 'legacy_unproven') : 'configured_fallback',
      ...(cached.chunk_models ? { chunk_models: cached.chunk_models } : {}),
      provider: cached.provider || null,
      cache_hit: true,
      cache_sha: sha
    };
  }

  const effectivePagesPerChunk = pagesPerChunk || config.pagesPerChunk;
  const effectiveConcurrency = concurrency || config.concurrency;

  let chunks;
  try {
    chunks = await splitPdfBase64(clean, effectivePagesPerChunk);
  } catch (error) {
    // Split failed (corrupt or unusual PDF). Fall back to a single
    // unsplit call so we degrade to the pre-chunking behaviour rather
    // than failing the whole extraction.
    console.warn('[bankStatementVision] PDF split failed, sending whole PDF', {
      filename,
      message: error?.message
    });
    chunks = null;
  }

  // A chunk over the provider's request limit is split further (pages are
  // never dropped). Only a PDF that split cleanly can be split again.
  if (chunks) chunks = await fitChunksToRequestLimit(config, chunks);

  if (!chunks || chunks.length <= 1) {
    const single = await extractStructuredFromOpenAiVision({ base64: clean, filename, mimeType });
    const { model, model_source } = provenanceOfResults([single], config);
    await writeVisionCache(config.cache, sha, {
      cached_at: new Date().toISOString(),
      model,
      model_source,
      provider: single.provider,
      filename,
      transactions: single.transactions,
      statement_summary: single.statement_summary
    });
    return {
      transactions: single.transactions,
      statement_summary: single.statement_summary,
      model,
      model_source,
      provider: single.provider,
      cache_hit: false,
      cache_sha: sha
    };
  }

  const startedAt = Date.now();
  console.log('[bankStatementVision] paginated structured extraction starting', {
    filename,
    total_pages: chunks[0].totalPages,
    chunk_count: chunks.length,
    pages_per_chunk: effectivePagesPerChunk,
    concurrency: effectiveConcurrency,
    period_hint: periodHint || null,
    cache_sha: sha.slice(0, 12)
  });

  // Per-chunk cache: each chunk's SHA is stable across re-runs of the
  // same source PDF, so a retry after a partial timeout reuses the
  // chunks that already finished and only re-runs the stragglers. The
  // full-PDF cache above is the happy-path for an identical re-upload;
  // this layer is the safety net for a parse that died midway.
  let chunkCacheHits = 0;
  let chunkCacheMisses = 0;
  const results = await runWithConcurrency(chunks, effectiveConcurrency, async (chunk) => {
    const chunkSha = computeChunkCacheKey(chunk.base64);
    const cachedChunk = await lookupChunkVisionCache(config.cache, chunkSha);
    if (cachedChunk) {
      chunkCacheHits += 1;
      return {
        transactions: Array.isArray(cachedChunk.transactions) ? cachedChunk.transactions : [],
        statement_summary: cachedChunk.statement_summary || null,
        served_model: cachedChunk.model || null,
        cached_model_source: cachedChunk.model ? (cachedChunk.model_source || 'legacy_unproven') : 'configured_fallback',
        provider: cachedChunk.provider || null
      };
    }
    chunkCacheMisses += 1;
    const fresh = await extractStructuredFromOpenAiVision({
      base64: chunk.base64,
      filename,
      mimeType,
      chunkContext: {
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        totalPages: chunk.totalPages,
        periodHint
      }
    });
    // Write-through. A failed write degrades silently — the chunk
    // still flows through to the merge; the worst case is one extra
    // OpenAI call on the next retry.
    const freshProvenance = callProvenance(fresh, config);
    await writeChunkVisionCache(config.cache, chunkSha, {
      cached_at: new Date().toISOString(),
      model: freshProvenance.model,
      model_source: freshProvenance.model_source,
      provider: fresh.provider,
      filename,
      page_start: chunk.pageStart,
      page_end: chunk.pageEnd,
      total_pages: chunk.totalPages,
      transactions: fresh.transactions,
      statement_summary: fresh.statement_summary
    });
    return fresh;
  });

  const merged = results.flatMap((result) => result?.transactions || []);
  const summary = mergeSummaryHints(results.map((result) => result?.statement_summary));
  merged.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  console.log('[bankStatementVision] paginated structured extraction complete', {
    filename,
    chunk_count: chunks.length,
    chunk_cache_hits: chunkCacheHits,
    chunk_cache_misses: chunkCacheMisses,
    merged_transaction_count: merged.length,
    has_summary: Boolean(summary),
    elapsed_ms: Date.now() - startedAt
  });

  const { model, model_source, chunk_models } = provenanceOfResults(results, config,
    chunks.map((chunk) => ({ page_start: chunk.pageStart, page_end: chunk.pageEnd })));
  const provider = results.find((result) => result?.provider)?.provider || config.provider;
  await writeVisionCache(config.cache, sha, {
    cached_at: new Date().toISOString(),
    model,
    model_source,
    ...(chunk_models ? { chunk_models } : {}),
    provider,
    filename,
    transactions: merged,
    statement_summary: summary
  });

  return {
    transactions: merged,
    statement_summary: summary,
    model,
    model_source,
    ...(chunk_models ? { chunk_models } : {}),
    provider,
    cache_hit: false,
    cache_sha: sha
  };
};

// ── Text transport ──────────────────────────────────────────────────────

// One structured call covers the overwhelming majority of statements (a
// 172-line tiliote is ~30 KB of text). Very long multi-year texts chunk
// on line boundaries; each fragment carries the same schema and the rows
// are preserved just as in the disjoint vision chunks.
const TEXT_CHUNK_CHAR_LIMIT = 48_000;

const splitStatementText = (text, charLimit = TEXT_CHUNK_CHAR_LIMIT) => {
  const clean = String(text || '');
  if (clean.length <= charLimit) return [clean];
  const lines = clean.split(/\r?\n/);
  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const line of lines) {
    if (currentLength + line.length + 1 > charLimit && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
};

const buildTextPrompt = (chunkContext = null) => {
  const framing = [
    'Below is the text content of a bank or payment-provider statement',
    '(extracted from the PDF text layer or pasted directly). Column',
    'alignment may be lost — reconstruct rows from the reading order.'
  ].join(' ');
  if (!chunkContext) return `${framing}\n\n${STRUCTURED_PROMPT}`;
  const { index, total, periodHint } = chunkContext;
  const header = [
    `This is fragment ${index + 1} of ${total} of a longer statement.`,
    'Return ONLY transactions visible in this fragment; do not invent',
    'rows that would belong to other fragments.',
    periodHint
      ? `The full statement covers approximately ${periodHint}; if a row shows only month+day, infer the year from that range.`
      : ''
  ].filter(Boolean).join(' ');
  return `${framing}\n\n${header}\n\n${STRUCTURED_PROMPT}`;
};

// First-non-null per field — except the closing side of the statement
// (closing_balance / period_end), which lives on the LAST fragment of a
// chunked text. The single-fragment case reduces to the raw summary.
const mergeSummaryHints = (summaries = []) => {
  const present = summaries.filter((summary) => summary && typeof summary === 'object');
  if (!present.length) return null;
  if (present.length === 1) return present[0];
  const firstNonNull = (key) => present.map((s) => s[key]).find((v) => v != null) ?? null;
  const lastNonNull = (key) => [...present].reverse().map((s) => s[key]).find((v) => v != null) ?? null;
  return {
    opening_balance: firstNonNull('opening_balance'),
    closing_balance: lastNonNull('closing_balance'),
    // Fragment totals may repeat a full-period header or omit partial pages.
    // Do not present one fragment's movement totals as the whole statement's.
    // The full opening/closing equation still validates every imported row.
    total_deposits: null,
    total_payouts: null,
    currency: firstNonNull('currency'),
    period_start: firstNonNull('period_start'),
    period_end: lastNonNull('period_end'),
    account_identifier: firstNonNull('account_identifier')
  };
};

const requestStructuredFromText = async ({ config, text, filename, chunkContext = null }) => {
  const prompt = `${buildTextPrompt(chunkContext)}\n\n--- STATEMENT TEXT (${filename}) ---\n${text}`;
  const { text: raw, servedModel, provider } = await requestStatementModel({
    config,
    prompt,
    schema: STRUCTURED_RESPONSE_SCHEMA,
    effort: STRUCTURED_EFFORT,
    label: 'structured text',
    seed: createHash('sha256').update(String(text || ''), 'utf8').digest('hex')
  });
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[bankStatementVision] structured text response was not valid JSON', {
      provider,
      model: servedModel || config.model,
      filename,
      text_length: String(raw || '').length
    });
    const error = new Error('Structured text extraction returned unparseable JSON.');
    error.code = 'OPENAI_TEXT_BAD_JSON';
    throw error;
  }
  return {
    transactions: normalizeStructuredTransactions(
      Array.isArray(parsed?.transactions) ? parsed.transactions : [],
      { parserFlag: 'openai_text' }
    ),
    statement_summary: parsed?.statement_summary || null,
    served_model: servedModel,
    provider
  };
};

// LLM-first structured extraction over statement TEXT. Same schema and
// normalization as the vision path; cached by text sha so a re-parse of
// the same statement never re-spends the call. Throws on model failure
// — the caller (selectPdfExtraction) falls back to the regex parser and
// records why.
export const extractStructuredFromStatementText = async ({
  text,
  filename = 'statement.txt',
  periodHint = '',
  bypassCache = false
} = {}) => {
  const config = getOpenAiConfig();
  if (bypassCache) config.cache.enabled = false;
  if (!config.configured) throw notConfiguredError(config, 'structured text extraction');
  const clean = String(text || '').trim();
  if (!clean) {
    const error = new Error('No statement text provided.');
    error.code = 'OPENAI_EMPTY_INPUT';
    throw error;
  }

  const sha = createHash('sha256').update(clean, 'utf8').digest('hex');
  const cached = await lookupVisionCacheByUrl(
    config.cache,
    cacheStorageUrlForText(config.cache, sha),
    sha,
    'text cache lookup'
  );
  if (cached) {
    console.log('[bankStatementVision] text cache hit', {
      filename,
      sha: sha.slice(0, 12),
      cached_transaction_count: cached.transactions.length,
      cached_model: cached.model || null
    });
    return {
      transactions: cached.transactions,
      statement_summary: cached.statement_summary || null,
      model: cached.model || config.model,
      model_source: cached.model ? (cached.model_source || 'legacy_unproven') : 'configured_fallback',
      ...(cached.chunk_models ? { chunk_models: cached.chunk_models } : {}),
      provider: cached.provider || null,
      cache_hit: true
    };
  }

  const startedAt = Date.now();
  const chunks = splitStatementText(clean);
  const results = [];
  for (let index = 0; index < chunks.length; index += 1) {
    results.push(
      await requestStructuredFromText({
        config,
        text: chunks[index],
        filename,
        chunkContext: chunks.length > 1 ? { index, total: chunks.length, periodHint } : null
      })
    );
  }

  const merged = results.flatMap((result) => result?.transactions || []);
  merged.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const summary = mergeSummaryHints(results.map((result) => result?.statement_summary));

  const { model, model_source, chunk_models } = provenanceOfResults(results, config, chunks.map((_, index) => ({ chunk: index })));
  const provider = results.find((result) => result?.provider)?.provider || config.provider;
  console.log('[bankStatementVision] structured text extraction complete', {
    provider,
    model,
    filename,
    chunk_count: chunks.length,
    merged_transaction_count: merged.length,
    has_summary: Boolean(summary),
    elapsed_ms: Date.now() - startedAt
  });

  await writeVisionCacheByUrl(
    config.cache,
    cacheStorageUrlForText(config.cache, sha),
    sha,
    {
      cached_at: new Date().toISOString(),
      model,
      model_source,
      ...(chunk_models ? { chunk_models } : {}),
      provider,
      filename,
      transactions: merged,
      statement_summary: summary
    },
    'text cache write'
  );

  return {
    transactions: merged,
    statement_summary: summary,
    model,
    model_source,
    ...(chunk_models ? { chunk_models } : {}),
    provider,
    cache_hit: false
  };
};

export const ocrPdfWithOpenAiVision = async ({ base64, filename = 'statement.pdf', mimeType = 'application/pdf' } = {}) => {
  const config = getOpenAiConfig();
  if (!config.configured) throw notConfiguredError(config, 'statement transcription');
  const clean = trimBase64(base64);
  if (!clean) {
    const error = new Error('No PDF data provided to OCR.');
    error.code = 'OPENAI_EMPTY_INPUT';
    throw error;
  }
  const { text: raw, servedModel, provider } = await requestStatementModel({
    config,
    file: { base64: clean, mimeType: mimeType || 'application/pdf', filename },
    prompt: OCR_PROMPT,
    schema: null,
    effort: TRANSCRIPTION_EFFORT,
    label: 'plain OCR',
    seed: computePdfSha256(clean)
  });
  const text = String(raw || '').trim();
  console.log('[bankStatementVision] plain OCR complete', {
    provider,
    model: servedModel || config.model,
    filename,
    text_length: text.length,
    line_count: text.split(/\r?\n/).filter(Boolean).length
  });
  return text;
};

// Test seam: the request-limit split with an explicit budget.
export const __fitChunksToRequestLimit = fitChunksToRequestLimit;
