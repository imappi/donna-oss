// Tests for the parse-worker error categorization helper. The
// categorized envelope is FE-visible; the matrix in
// docs/async-parsing-plan.md → "Error categorization" is what these
// assertions encode.

import { categorizeError, ParseError, isRetryableCode, isTerminalCode, extractionFailureForStatus, withRetryOwner, parseRetriesExhaustedEnvelope } from './parseErrors.js';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  fail ${name}`);
    console.error(`       ${err?.message || err}`);
  }
};

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const assertTrue = (value, label) => {
  if (!value) throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
};

console.log('parseErrors:');

test('ParseError marks CHECKSUM_MISMATCH as retryable by default', () => {
  const err = new ParseError('CHECKSUM_MISMATCH', { message: 'bytes differ' });
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'CHECKSUM_MISMATCH', 'code');
  assertEqual(categorized.retryable, true, 'retryable');
  assertEqual(categorized.provider, 'supabase', 'provider');
});

test('ParseError marks INVALID_PDF as terminal', () => {
  const err = new ParseError('INVALID_PDF', { message: 'corrupt header' });
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'INVALID_PDF', 'code');
  assertEqual(categorized.retryable, false, 'retryable');
});

test('CONFIG_SNAPSHOT_UNAVAILABLE is retryable and safe for the upload tray', () => {
  const err = new ParseError('CONFIG_SNAPSHOT_UNAVAILABLE', {
    message: 'connection pool timed out while loading a private client flag'
  });
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'CONFIG_SNAPSHOT_UNAVAILABLE', 'code');
  assertEqual(categorized.retryable, true, 'retryable');
  assertEqual(categorized.provider, 'internal', 'provider');
  assertTrue(!categorized.safe_user_message.includes('private'), 'safe message must be canned');
  assertTrue(isRetryableCode('CONFIG_SNAPSHOT_UNAVAILABLE'), 'in retryable set');
});

test('OpenAI 429 maps to OCR_RATE_LIMIT (retryable)', () => {
  const err = new Error('429 too many requests');
  err.status = 429;
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'OCR_RATE_LIMIT', 'code');
  assertEqual(categorized.retryable, true, 'retryable');
});

test('OpenAI 503 maps to OCR_TRANSIENT_5XX (retryable)', () => {
  const err = new Error('upstream 503');
  err.status = 503;
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'OCR_TRANSIENT_5XX', 'code');
  assertEqual(categorized.retryable, true, 'retryable');
});

test('Timeout messages map to OCR_TIMEOUT', () => {
  const err = new Error('Request aborted: timeout');
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'OCR_TIMEOUT', 'code');
  assertEqual(categorized.retryable, true, 'retryable');
});

test('Storage failure infers STORAGE_FETCH_FAILED', () => {
  const err = new Error('Supabase storage download failed with 500');
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'STORAGE_FETCH_FAILED', 'code');
  assertEqual(categorized.provider, 'supabase', 'provider');
});

test('Password-protected PDF maps to UNSUPPORTED_FORMAT (terminal)', () => {
  const err = new Error('Cannot extract: PDF is password protected.');
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'UNSUPPORTED_FORMAT', 'code');
  assertEqual(categorized.retryable, false, 'retryable');
});

test('Uncategorized errors fall through to INTERNAL (retryable)', () => {
  const err = new Error('weird unrelated thing');
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'INTERNAL', 'code');
  assertEqual(categorized.retryable, true, 'retryable');
});

test('Categorized envelope never leaks raw error message to safe_user_message', () => {
  const err = new Error('Statement balance was 1234.56 EUR for Acme Ltd account 1234');
  err.status = 500;
  const categorized = categorizeError(err);
  // safe_user_message is canned per code, not derived from err.message —
  // protects against accidental PII leak from extracted document text
  // when the err.message gets enriched with provider response bodies.
  assertTrue(!categorized.safe_user_message.includes('1234.56'), 'safe_user_message must not leak amount');
  assertTrue(!categorized.safe_user_message.includes('Acme'), 'safe_user_message must not leak vendor');
});

test('isRetryableCode / isTerminalCode are consistent', () => {
  ['OCR_TIMEOUT', 'OCR_RATE_LIMIT', 'STORAGE_FETCH_FAILED', 'CHECKSUM_MISMATCH', 'CONFIG_SNAPSHOT_UNAVAILABLE', 'INTERNAL'].forEach((code) => {
    assertTrue(isRetryableCode(code), `${code} should be retryable`);
  });
  ['INVALID_PDF', 'UNSUPPORTED_FORMAT', 'EXTRACTION_NO_TRANSACTIONS', 'FILE_TOO_LARGE'].forEach((code) => {
    assertTrue(isTerminalCode(code), `${code} should be terminal`);
  });
});

test('DOCUMENT_EXTRACTION_FAILED is retryable and attributes to the model provider (no provider named: none is guessed, 2026-11-10)', () => {
  const err = new ParseError('DOCUMENT_EXTRACTION_FAILED', { message: 'gateway timeout from llm' });
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'DOCUMENT_EXTRACTION_FAILED', 'code');
  assertEqual(categorized.retryable, true, 'retryable');
  assertEqual(categorized.provider, 'model_provider', 'provider');
  assertTrue(isRetryableCode('DOCUMENT_EXTRACTION_FAILED'), 'in retryable set');
});

test('DOCUMENT_EXTRACTION_UNREADABLE is terminal and attributes to the model provider (no provider named: none is guessed, 2026-11-10)', () => {
  const err = new ParseError('DOCUMENT_EXTRACTION_UNREADABLE', { message: 'no fields readable' });
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'DOCUMENT_EXTRACTION_UNREADABLE', 'code');
  assertEqual(categorized.retryable, false, 'retryable');
  assertEqual(categorized.provider, 'model_provider', 'provider');
  assertTrue(isTerminalCode('DOCUMENT_EXTRACTION_UNREADABLE'), 'in terminal set');
});

test('DOCUMENT_EXTRACTION_REJECTED is terminal and attributes to the model provider (no provider named: none is guessed, 2026-11-10)', () => {
  const err = new ParseError('DOCUMENT_EXTRACTION_REJECTED', { message: 'openai 400: schema refused' });
  const categorized = categorizeError(err);
  assertEqual(categorized.code, 'DOCUMENT_EXTRACTION_REJECTED', 'code');
  assertEqual(categorized.retryable, false, 'retryable');
  assertEqual(categorized.provider, 'model_provider', 'provider');
  assertTrue(isTerminalCode('DOCUMENT_EXTRACTION_REJECTED'), 'in terminal set');
});

test('extractionFailureForStatus: deterministic 4xx is terminal, 408/429/5xx/unknown stay retryable', () => {
  assertEqual(extractionFailureForStatus(400).code, 'DOCUMENT_EXTRACTION_REJECTED', '400');
  assertEqual(extractionFailureForStatus(404).code, 'DOCUMENT_EXTRACTION_REJECTED', '404');
  assertEqual(extractionFailureForStatus(422).code, 'DOCUMENT_EXTRACTION_REJECTED', '422');
  assertEqual(extractionFailureForStatus(408).code, 'DOCUMENT_EXTRACTION_FAILED', '408 timeout');
  assertEqual(extractionFailureForStatus(429).code, 'DOCUMENT_EXTRACTION_FAILED', '429 rate limit');
  assertEqual(extractionFailureForStatus(500).code, 'DOCUMENT_EXTRACTION_FAILED', '500');
  assertEqual(extractionFailureForStatus(0).code, 'DOCUMENT_EXTRACTION_FAILED', 'unknown status');
  assertEqual(extractionFailureForStatus(400).reason, 'openai_400', 'reason carries status');
  assertEqual(extractionFailureForStatus(0).reason, 'openai_unknown', 'unknown reason');
  assertEqual(extractionFailureForStatus(400).kind, 'failed', 'kind');
});

test('DOCUMENT_EXTRACTION_* safe messages do not leak provider details', () => {
  // The extractor wraps an OpenAI 500 with the document-neutral code;
  // the err.message can carry the raw upstream body. safe_user_message
  // is canned per code so PII pulled into err.message can't surface
  // to the firm tray.
  const err = new ParseError('DOCUMENT_EXTRACTION_FAILED', {
    message: 'openai 500: response body contained "Acme Ltd invoice 4042"'
  });
  const categorized = categorizeError(err);
  assertTrue(!categorized.safe_user_message.includes('Acme'), 'safe_user_message must not echo vendor');
  assertTrue(!categorized.safe_user_message.includes('4042'), 'safe_user_message must not echo reference');
});

test('categorizeError carries reason + model when the thrower stamped them (the Mann Lake receipt gap, 2026-08-06)', () => {
  const err = new ParseError('DOCUMENT_EXTRACTION_UNREADABLE', {
    provider: 'openai',
    reason: 'low_confidence',
    model: 'gpt-5.4'
  });
  const categorized = categorizeError(err);
  assertEqual(categorized.reason, 'low_confidence', 'reason rides parse_error');
  assertEqual(categorized.model, 'gpt-5.4', 'model id is part of the receipt');
});

test('categorizeError omits reason/model keys entirely when absent (pre-existing envelopes stay byte-identical)', () => {
  const categorized = categorizeError(new ParseError('DOCUMENT_EXTRACTION_UNREADABLE', { provider: 'openai' }));
  assertTrue(!('reason' in categorized), 'no reason key when not stamped');
  assertTrue(!('model' in categorized), 'no model key when not stamped');
});


// ── RT-02: retry_owner + promise-free copy (audit F-02) ─────────────────
//
// "Retrying shortly" was baked into every retryable code's copy, and on the
// desktop nothing retried a failed row. The promise is now a function of who
// owns the retry, carried on the envelope as `retry_owner`.

test('RT-02: default envelope carries retry_owner null and makes no promise', () => {
  const categorized = categorizeError(Object.assign(new Error('429'), { status: 429 }));
  assertEqual(categorized.code, 'OCR_RATE_LIMIT', 'code');
  assertEqual(categorized.retryable, true, 'retryable');
  assertEqual(categorized.retry_owner, null, 'retry_owner');
  assertTrue(!/retry(ing)? shortly|we'll retry/i.test(categorized.safe_user_message), `no promise without an owner: ${categorized.safe_user_message}`);
});

test('RT-02: no SAFE_MESSAGES base copy promises a retry', () => {
  for (const code of ['OCR_TIMEOUT', 'OCR_RATE_LIMIT', 'OCR_TRANSIENT_5XX', 'STORAGE_FETCH_FAILED', 'CHECKSUM_MISMATCH', 'CONFIG_SNAPSHOT_UNAVAILABLE', 'INTERNAL', 'DOCUMENT_EXTRACTION_FAILED']) {
    const categorized = categorizeError(new ParseError(code));
    assertTrue(!/retry(ing)? shortly|we'll retry/i.test(categorized.safe_user_message), `${code}: ${categorized.safe_user_message}`);
  }
});

test('RT-02: retry_owner queue appends the promise; manual appends the invitation', () => {
  const queue = categorizeError(new ParseError('OCR_TIMEOUT'), { retryOwner: 'queue' });
  assertEqual(queue.retry_owner, 'queue', 'queue owner');
  assertTrue(/retrying shortly/i.test(queue.safe_user_message), `queue promises: ${queue.safe_user_message}`);
  const manual = categorizeError(new ParseError('OCR_TIMEOUT'), { retryOwner: 'manual' });
  assertEqual(manual.retry_owner, 'manual', 'manual owner');
  assertTrue(/you can retry/i.test(manual.safe_user_message), `manual invites: ${manual.safe_user_message}`);
  assertTrue(!/retrying shortly/i.test(manual.safe_user_message), 'manual never promises');
});

test('RT-02: a queue owner on a non-retryable class is normalized to null', () => {
  const terminal = categorizeError(new ParseError('INVALID_PDF'), { retryOwner: 'queue' });
  assertEqual(terminal.retry_owner, null, 'terminal has no queue owner');
  assertTrue(!/retrying shortly/i.test(terminal.safe_user_message), 'no promise on terminal');
});

test('RT-02: withRetryOwner re-derives the copy from the code, never from a prior promise', () => {
  const queue = categorizeError(new ParseError('STORAGE_FETCH_FAILED'), { retryOwner: 'queue' });
  const orphaned = withRetryOwner(queue, null);
  assertEqual(orphaned.retry_owner, null, 'owner cleared');
  assertTrue(!/retrying shortly/i.test(orphaned.safe_user_message), `promise removed: ${orphaned.safe_user_message}`);
  assertEqual(orphaned.code, 'STORAGE_FETCH_FAILED', 'code kept');
  assertEqual(orphaned.retryable, true, 'retryable class kept');
});

test('RT-02: the exhausted envelope is terminal, ownerless, and names the budget', () => {
  const base = categorizeError(Object.assign(new Error('429'), { status: 429 }));
  const exhausted = parseRetriesExhaustedEnvelope(base, { attempts: 4, maxAttempts: 4 });
  assertEqual(exhausted.retryable, false, 'retryable');
  assertEqual(exhausted.retry_owner, null, 'retry_owner');
  assertEqual(exhausted.code, 'OCR_RATE_LIMIT', 'code kept as the receipt');
  assertEqual(exhausted.retry_exhausted.attempts, 4, 'attempts');
  assertEqual(exhausted.retry_exhausted.max_attempts, 4, 'max_attempts');
  assertTrue(/4 attempts/.test(exhausted.safe_user_message), `names the budget: ${exhausted.safe_user_message}`);
  assertTrue(!/retrying shortly/i.test(exhausted.safe_user_message), 'no promise');
  assertTrue(!('message' in exhausted), 'internal message never rides the persisted envelope');
});

console.log(`\nparseErrors: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
