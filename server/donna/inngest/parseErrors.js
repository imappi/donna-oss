// Error categorization for the async-parse worker
// (see docs/async-parsing-plan.md → "Error categorization").
//
// `parse_error` is FE-visible. Raw provider responses / stack traces /
// document text MUST stay in server logs — they can contain PII pulled
// out of a statement. Only the categorized envelope is returned here.

import { isProviderSpendLimit } from '../providerTransport.js';

const RETRYABLE_CODES = new Set([
  'STATEMENT_VALIDATION_FAILED',
  'OCR_TIMEOUT',
  'OCR_RATE_LIMIT',
  'OCR_TRANSIENT_5XX',
  'STORAGE_FETCH_FAILED',
  'CHECKSUM_MISMATCH',
  // The config-plane snapshot decides whether a document extractor may
  // run. Treat an unavailable snapshot as retryable instead of silently
  // falling through to the env default: on the desktop host those flags
  // deliberately have no env fallback, so a transient DB-pool stall would
  // otherwise be misreported as an unsupported document type.
  'CONFIG_SNAPSHOT_UNAVAILABLE',
  // Document-neutral extractor failure (PR 1 of
  // docs/invoice-receipt-parsing-plan.md → "Failure modes"). Covers
  // provider hiccups — timeout, 5xx, rate-limit — surfaced by the
  // receipt/invoice/bill extractor as a single class so future doc
  // types reuse the vocabulary without renaming.
  'DOCUMENT_EXTRACTION_FAILED',
  'INTERNAL'
]);

const TERMINAL_CODES = new Set([
  'DOCUMENT_SPEND_LIMIT',
  'INVALID_PDF',
  'UNSUPPORTED_FORMAT',
  'EXTRACTION_NO_TRANSACTIONS',
  'FILE_TOO_LARGE',
  // Document-neutral unreadable: the LLM responded but said it
  // couldn't read enough fields (extraction_status='unreadable' /
  // confidence below floor). Terminal — re-running won't help.
  'DOCUMENT_EXTRACTION_UNREADABLE',
  // Deterministic provider rejection: a 4xx that is not a timeout (408)
  // or rate limit (429) — wrong model id, schema refused, unsupported
  // input. Retrying replays the identical request, so riding the
  // retryable class just burned Inngest's attempts and ended as
  // cron-STUCK with no cause named (the 2026-07-21 Telegram photo
  // carousel, docs/donna-telegram-receipt-silence-diagnostic.md §7 —
  // "retryable so an operator can triage" in practice read as STUCK).
  // Terminal, with the parse_error naming the cause instead.
  'DOCUMENT_EXTRACTION_REJECTED',
  // 2026-09-12 (FI reliability pass): a 401/403 from the model provider is a
  // CREDENTIAL failure — the key is missing, revoked or wrong — never a fact
  // about the document. It used to ride DOCUMENT_EXTRACTION_REJECTED and tell
  // the owner "the provider rejected this file", which sent them hunting for a
  // document problem while every upload failed the same way. Terminal (the
  // same request replays byte-identically until the key changes); the human
  // who fixes the key is the retry owner.
  'DOCUMENT_EXTRACTION_UNAUTHORIZED'
]);

const VALID_CODES = new Set([...RETRYABLE_CODES, ...TERMINAL_CODES]);

// Base copy is PROMISE-FREE on purpose (RT-02, audit F-02). "Retrying
// shortly" used to be baked into every retryable code, and on the desktop —
// where the drain is the transport and nothing retried a `failed` row — the
// owner read a promise nobody kept. A retry promise is now a function of WHO
// owns the retry (`retry_owner`, below), appended only when an owner exists.
const SAFE_MESSAGES = {
  DOCUMENT_SPEND_LIMIT: 'Model work is paused because its spending allowance is exhausted. Increase the allowance before retrying this upload.',
  STATEMENT_VALIDATION_FAILED: 'Donna read this statement, but the extracted transactions did not match its balances. No bank lines were imported.',
  OCR_TIMEOUT: "The OCR provider didn't respond in time.",
  OCR_RATE_LIMIT: 'OCR provider is rate-limited.',
  OCR_TRANSIENT_5XX: 'OCR provider had a transient error.',
  STORAGE_FETCH_FAILED: "Couldn't fetch the uploaded file from storage.",
  CHECKSUM_MISMATCH: "Uploaded file didn't match its expected checksum.",
  CONFIG_SNAPSHOT_UNAVAILABLE: "Couldn't load the parser configuration.",
  INTERNAL: 'Something went wrong while parsing.',
  INVALID_PDF: 'This file looks corrupt or is not a PDF.',
  UNSUPPORTED_FORMAT: "We can't read this file format yet (e.g. password-protected PDF).",
  EXTRACTION_NO_TRANSACTIONS: "Couldn't find any transactions in this file.",
  FILE_TOO_LARGE: 'This file is too large to parse.',
  DOCUMENT_EXTRACTION_FAILED: 'Document extraction provider had a problem.',
  DOCUMENT_EXTRACTION_UNREADABLE: "Couldn't read enough fields from this document to be useful.",
  DOCUMENT_EXTRACTION_REJECTED: 'The extraction provider rejected this file, so retrying will not help.',
  DOCUMENT_EXTRACTION_UNAUTHORIZED: "The model provider rejected Donna's API key, so this document could not be read. Check the provider key in Settings → AI & models, then retry."
};

// Who retries a failed parse. `queue` ⇒ an automatic owner (Inngest backoff, or
// the desktop drain while attempts remain) will re-run it and the copy may say
// so; `manual` ⇒ a human click is the designated path; null ⇒ nobody — the
// row rests on the human with an ask, never a promise. The tray renders from
// this field (src/lib/uploadTray.js), so a writer that cannot keep a promise
// must not set `queue`.
export const RETRY_OWNERS = Object.freeze(['queue', 'manual']);

const RETRY_OWNER_SUFFIX = {
  queue: ' Retrying shortly.',
  manual: ' You can retry it.'
};

const normalizeRetryOwner = (retryOwner, retryable) => {
  const owner = RETRY_OWNERS.includes(retryOwner) ? retryOwner : null;
  // A queue never retries a terminal class; do not let a caller promise it.
  if (owner === 'queue' && !retryable) return null;
  return owner;
};

const safeMessageFor = (code, retryOwner) =>
  `${SAFE_MESSAGES[code] || SAFE_MESSAGES.INTERNAL}${RETRY_OWNER_SUFFIX[retryOwner] || ''}`;

// Marker class so the worker can build a categorized error in-place
// (e.g. `throw new ParseError('CHECKSUM_MISMATCH', {expected, actual})`)
// without needing to round-trip through inference rules.
export class ParseError extends Error {
  constructor(code, { message, provider, retryable, details, reason, model } = {}) {
    super(message || SAFE_MESSAGES[code] || code);
    this.name = 'ParseError';
    this.parseErrorCode = code;
    this.provider = provider || null;
    this.retryable = typeof retryable === 'boolean' ? retryable : RETRYABLE_CODES.has(code);
    this.details = details || null;
    // The receipt fields (2026-08-06, the Mann Lake round-trip): which
    // enumerated failure fired (reason) and which model id was on the lane
    // (model). Both are safe, non-PII enum/config values — they ride
    // parse_error so a failed row answers "what refused, on which model"
    // from the data instead of costing a log dig ("the model id is part of
    // the receipt", CLAUDE.md).
    this.reason = reason || null;
    this.model = model || null;
  }
}

const inferCode = (err) => {
  if (isProviderSpendLimit(err)) return 'DOCUMENT_SPEND_LIMIT';
  if (err instanceof ParseError && VALID_CODES.has(err.parseErrorCode)) return err.parseErrorCode;
  const explicit = err?.parseErrorCode || err?.code;
  if (explicit && VALID_CODES.has(explicit)) return explicit;

  const message = String(err?.message || '').toLowerCase();
  const status = Number(err?.status || err?.statusCode || 0);

  if (status === 401 || status === 403 || /invalid[_ ]api[_ ]key|incorrect api key|authentication_error|invalid x-api-key/.test(message)) return 'DOCUMENT_EXTRACTION_UNAUTHORIZED';
  if (status === 429 || /rate ?limit|too many requests/.test(message)) return 'OCR_RATE_LIMIT';
  if (status === 408 || /timeout|timed out|aborted/.test(message)) return 'OCR_TIMEOUT';
  if (status >= 500 && status < 600) return 'OCR_TRANSIENT_5XX';
  if (/storage|supabase|bucket|signed url/.test(message)) return 'STORAGE_FETCH_FAILED';
  if (/password|encrypted|protected/.test(message)) return 'UNSUPPORTED_FORMAT';
  if (/not a pdf|invalid pdf|corrupt|malformed/.test(message)) return 'INVALID_PDF';
  if (/no transactions|empty extraction|no readable/.test(message)) return 'EXTRACTION_NO_TRANSACTIONS';
  if (/file too large|exceeds limit|payload too large/.test(message)) return 'FILE_TOO_LARGE';
  return 'INTERNAL';
};

// A model-class failure whose thrower named no provider is attributed to the
// model provider without guessing WHICH one. Until 2026-11-10 every such
// failure was called 'openai'; since the owner's decision that Donna runs on
// Claude the document lanes resolve Anthropic first, and a missing key names
// no provider at all — an envelope must not blame one it never called.
const inferProvider = (err, code) => {
  if (err?.provider) return err.provider;
  if (code.startsWith('OCR_') || code === 'EXTRACTION_NO_TRANSACTIONS') return 'model_provider';
  if (code.startsWith('DOCUMENT_EXTRACTION_')) return 'model_provider';
  if (code === 'STORAGE_FETCH_FAILED' || code === 'CHECKSUM_MISMATCH') return 'supabase';
  return 'internal';
};

export const categorizeError = (err, { retryOwner = null } = {}) => {
  const code = inferCode(err);
  const retryable =
    err instanceof ParseError && typeof err.retryable === 'boolean'
      ? err.retryable
      : RETRYABLE_CODES.has(code);
  const provider = inferProvider(err, code);
  // A credential failure rests on the human who holds the key: the copy
  // names the retry so the row never reads as a dead document.
  const owner = ['DOCUMENT_EXTRACTION_UNAUTHORIZED', 'DOCUMENT_SPEND_LIMIT'].includes(code) ? 'manual' : normalizeRetryOwner(retryOwner, retryable);

  return {
    code,
    // `message` is the internal-only diagnostic; the API layer strips
    // this before returning the row to the FE if anyone wires it
    // through accidentally. Keeping it here so server logs have it.
    message: String(err?.message || code),
    safe_user_message: safeMessageFor(code, owner),
    retryable,
    retry_owner: owner,
    provider,
    // Enum reason + model id, when the thrower carried them (ParseError
    // above; extractors stamp both on their failure unions). Absent keys,
    // not nulls, so pre-existing envelopes stay byte-identical.
    ...(err?.reason ? { reason: String(err.reason) } : {}),
    ...(err?.model ? { model: String(err.model) } : {}),
    occurred_at: new Date().toISOString()
  };
};

// Re-stamp the retry owner on an envelope once the caller knows who (if
// anyone) will retry. The copy is re-derived from the code — never edited in
// place — so a promise written under one owner cannot survive a hand-off to
// none. Strips the internal `message` so the result is safe to persist.
export const withRetryOwner = (envelope = {}, retryOwner = null) => {
  const { message: _internal, ...persisted } = envelope || {};
  const code = VALID_CODES.has(persisted.code) ? persisted.code : 'INTERNAL';
  const retryable = typeof persisted.retryable === 'boolean' ? persisted.retryable : RETRYABLE_CODES.has(code);
  const owner = normalizeRetryOwner(retryOwner, retryable);
  return {
    ...persisted,
    code,
    retryable,
    retry_owner: owner,
    safe_user_message: safeMessageFor(code, owner)
  };
};

// The honest terminal for a retryable-class failure whose automatic budget is
// spent (decision D7: up to PARSE_MAX_ATTEMPTS, then rest terminal). Keeps the
// original code as the receipt of what failed; `retryable:false` + no owner
// means the row now rests on the human, and the copy says why.
export const parseRetriesExhaustedEnvelope = (envelope = {}, { attempts, maxAttempts } = {}) => {
  const { message: _internal, ...persisted } = envelope || {};
  const code = VALID_CODES.has(persisted.code) ? persisted.code : 'INTERNAL';
  const n = Number(attempts) || 0;
  return {
    ...persisted,
    code,
    retryable: false,
    retry_owner: null,
    retry_exhausted: { attempts: n, max_attempts: Number(maxAttempts) || n },
    safe_user_message: `Couldn't parse after ${n} attempt${n === 1 ? '' : 's'}; automatic retries are exhausted.`
  };
};

export const isRetryableCode = (code) => RETRYABLE_CODES.has(code);
export const isTerminalCode = (code) => TERMINAL_CODES.has(code);

// The one shared mapping from a provider HTTP status to the extractor
// failure envelope, so every extractor agrees on which statuses are worth
// a retry. 408 (timeout) and 429 (rate limit) stay in the retryable class;
// every other 4xx is a deterministic rejection — the same request replays
// byte-identically, so the retry budget only delays the terminal verdict.
// 5xx / 0 / unknown stay retryable. Lives here (not in the extractors) so
// the code names and their retryability semantics never drift apart.
export const extractionFailureForStatus = (status, { provider = 'openai' } = {}) => {
  const n = Number(status || 0);
  const unauthorized = n === 401 || n === 403;
  const deterministic = n >= 400 && n < 500 && n !== 408 && n !== 429;
  return {
    kind: 'failed',
    code: unauthorized ? 'DOCUMENT_EXTRACTION_UNAUTHORIZED' : deterministic ? 'DOCUMENT_EXTRACTION_REJECTED' : 'DOCUMENT_EXTRACTION_FAILED',
    reason: `${provider}_${n || 'unknown'}`
  };
};
