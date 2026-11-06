// firmApi — pure-helper tests.
//
// Pins error-coercion behaviour. The bug this file was created to
// catch: edge-layer 404 bodies of the shape
// `{ error: { code: "404", message: "The page could not be found" } }`
// were JSON.stringified by coerceErrorMessage and dumped verbatim into
// toast / load-error surfaces (e.g. red `{"code":"404","message":"…"}`
// under "Ask about this document"). The fix prefers .message / .error
// string fields and never falls back to raw JSON.

import assert from 'node:assert/strict';

import { coerceErrorMessage, formatFirmError } from './firmApi.js';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.stack || err?.message || err}`);
  }
};

console.log('firmApi (error coercion):');

// ─── coerceErrorMessage: string passthrough ─────────────────────────────

await test('coerceErrorMessage: non-empty string passes through unchanged', () => {
  assert.equal(coerceErrorMessage('Already posted.', 'fallback'), 'Already posted.');
});

await test('coerceErrorMessage: whitespace-only string → fallback', () => {
  assert.equal(coerceErrorMessage('   ', 'fallback'), 'fallback');
});

await test('coerceErrorMessage: null / undefined → fallback', () => {
  assert.equal(coerceErrorMessage(null, 'fallback'), 'fallback');
  assert.equal(coerceErrorMessage(undefined, 'fallback'), 'fallback');
});

// ─── coerceErrorMessage: object handling (the bug surface) ──────────────

await test('coerceErrorMessage: object with .message string → returns .message', () => {
  assert.equal(
    coerceErrorMessage({ message: 'The page could not be found' }, 'fallback'),
    'The page could not be found'
  );
});

await test('coerceErrorMessage: object with .error string → returns .error', () => {
  assert.equal(
    coerceErrorMessage({ error: 'Database is not configured.' }, 'fallback'),
    'Database is not configured.'
  );
});

await test('coerceErrorMessage: .message wins over .error when both present', () => {
  // .message is the human-readable user-facing string by convention;
  // .error is often the machine code. Prefer .message.
  assert.equal(
    coerceErrorMessage({ message: 'Friendly text', error: 'INTERNAL_CODE' }, 'fallback'),
    'Friendly text'
  );
});

await test('coerceErrorMessage: regression — Hapi-style 404 body never dumps raw JSON', () => {
  // This is the exact body shape that appeared under "Ask about this
  // document" — a CDN/edge layer 404 wrapped in donna's error envelope:
  //   { error: { code: "404", message: "The page could not be found" } }
  // Before the fix, coerceErrorMessage(body.error, fallback) called
  // JSON.stringify(value) and the literal JSON ended up in the user's
  // load-error surface. After the fix, we extract the .message.
  const bodyError = { code: '404', message: 'The page could not be found' };
  const out = coerceErrorMessage(bodyError, 'Firm data request failed with 404');
  assert.equal(out, 'The page could not be found');
  assert.ok(!out.includes('{'), 'must not contain raw JSON braces');
  assert.ok(!out.includes('"code"'), 'must not leak the code field as JSON');
});

await test('coerceErrorMessage: object lacking string .message/.error → fallback (NOT raw JSON)', () => {
  // The function intentionally drops JSON.stringify. If neither field
  // is a usable string, the caller's fallback is strictly more useful
  // than dumping the object.
  assert.equal(coerceErrorMessage({ code: 'XYZ' }, 'Request failed.'), 'Request failed.');
  assert.equal(coerceErrorMessage({}, 'Request failed.'), 'Request failed.');
  assert.equal(coerceErrorMessage({ message: 123 }, 'Request failed.'), 'Request failed.');
  assert.equal(coerceErrorMessage({ message: { nested: 'object' } }, 'Request failed.'), 'Request failed.');
});

await test('coerceErrorMessage: empty-string .message → fallback (treat blank as missing)', () => {
  assert.equal(coerceErrorMessage({ message: '' }, 'Request failed.'), 'Request failed.');
  assert.equal(coerceErrorMessage({ message: '   ' }, 'Request failed.'), 'Request failed.');
});

// ─── formatFirmError: composes through coerceErrorMessage ───────────────

await test('formatFirmError: known error code maps to the curated FIRM_ERROR_MESSAGES copy', () => {
  // The code-mapping path should bypass coerceErrorMessage entirely so
  // backend message wording can't override the curated UX copy.
  const out = formatFirmError({ code: 'CLOSE_PERIOD_LOCKED', message: 'raw backend wording' });
  assert.equal(out, 'Close period is already locked.');
});

await test('formatFirmError: unknown code falls through to .message string', () => {
  const out = formatFirmError({ message: 'Transaction not found.' });
  assert.equal(out, 'Transaction not found.');
});

await test('formatFirmError: unknown code, object .message → fallback (no raw JSON)', () => {
  // Defensive — if a backend ever returns a structured .message (shouldn't,
  // but we don't want to bet on it), formatFirmError must NOT dump JSON.
  const out = formatFirmError({ message: { nested: 'x' } }, 'Action failed.');
  assert.equal(out, 'Action failed.');
});

await test('formatFirmError: null / undefined input → fallback', () => {
  assert.equal(formatFirmError(null, 'Action failed.'), 'Action failed.');
  assert.equal(formatFirmError(undefined, 'Action failed.'), 'Action failed.');
});

await test('formatFirmError: Error-like object with .message string → returns .message', () => {
  // Mirrors the parseJsonResponse path: thrown Error has .message set
  // from coerceErrorMessage, and call sites pass the Error to formatFirmError.
  const err = new Error('Firm data request failed with 404');
  const out = formatFirmError(err, 'Could not load.');
  assert.equal(out, 'Firm data request failed with 404');
});

console.log(`\nfirmApi (error coercion): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
