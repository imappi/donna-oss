// Bidi isolation for mixed-direction PLAIN TEXT (UAX #9 isolate controls).
//
// The problem this exists for (the AE manifest's languages note names it as
// the first RTL engine test): outbound emails interpolate VALUES into
// template text as raw logical-order strings. When a value and its context
// run in opposite directions — an Arabic counterparty name inside an English
// body, or an amount / IBAN / TRN / invoice number inside an Arabic body —
// the receiving mail client's Unicode Bidirectional Algorithm decides the
// visual order from heuristics (usually first-strong-character), and a line
// like "<arabic description> — 2 × 1,500.00 = 3,000.00 AED" gets its math
// tail visually reordered. The UAX #9 fix is to wrap each interpolated value
// in an ISOLATE so its direction is resolved on its own and it behaves as a
// single neutral run in the surrounding paragraph:
//
//   LRI value PDI   — force the value to lay out left-to-right (amounts,
//                     IBANs, tax registration numbers, invoice numbers);
//   RLI value PDI   — force right-to-left;
//   FSI value PDI   — direction from the value's own first strong character
//                     (the general answer for names and free text).
//
// SCOPE — presentation surfaces that run the UBA (email bodies, chat, HTML
// with dir=auto, and AR-4B1's Unicode PDF typesetter). pdf-lib's standard
// fonts still run no UBA and cannot encode Arabic, so normal LTR PDFs retain
// that renderer while mixed-direction PDFs consume these controls before
// drawing their shaped visual runs.
//
// AR-4A wires these transforms into the outbound issuance mint and render
// composition. Pure string transforms, no I/O, no locale data; values are
// stringified with the same null-tolerance as the renderer. Existing LTR-only
// output stays byte-identical: the render-value composer activates only when
// an RTL value or an already-isolated value is present.

export const LRI = '\u2066'; // LEFT-TO-RIGHT ISOLATE
export const RLI = '\u2067'; // RIGHT-TO-LEFT ISOLATE
export const FSI = '\u2068'; // FIRST STRONG ISOLATE
export const PDI = '\u2069'; // POP DIRECTIONAL ISOLATE

// Strong right-to-left SCRIPTS (property escapes, not hand-kept ranges).
// Script detection, not Bidi_Class — JS regex has no \p{Bidi_Class=R}, and
// the scripts below are the RTL scripts this product could plausibly meet.
const RTL_SCRIPT_RE = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;

// Every UAX #9 explicit formatting character: the implicit marks (ALM, LRM,
// RLM), the legacy embeddings/overrides (LRE..RLO, PDF), and the isolates
// (LRI..PDI). Matched for stripping only — this module never emits the
// legacy embedding forms.
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const BIDI_CONTROL_TEST_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const LEGACY_BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E]/;
const ISOLATE_OPENERS = new Set([LRI, RLI, FSI]);

// Structured free-text fields (currently payment instructions) may contain
// several independently meaningful LTR values. Match the value-bearing run,
// not its surrounding prose, so an Arabic label and its identifier do not
// share one direction decision. Ordered most-specific first.
const LTR_DATA_RE = new RegExp([
  String.raw`https?:\/\/[^\s]+`,
  String.raw`[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+`,
  String.raw`\b[A-Z]{2}\d{2}(?:[ \t]?[A-Z0-9]){11,30}\b`,
  String.raw`\b\d{15}\b`,
  String.raw`\b[A-Z0-9]+(?:[-/._][A-Z0-9]+)+\b`
].join('|'), 'giu');

const asText = (value) => String(value ?? '');

const isolationError = (reason) => {
  const error = new Error(`invalid bidi isolation: ${reason}`);
  error.code = 'OUTBOUND_BIDI_ISOLATION_INVALID';
  return error;
};

// True when the text carries at least one strong RTL-script character —
// the trigger for isolating a value against an opposite-direction context.
export const containsRtl = (text) => RTL_SCRIPT_RE.test(asText(text));

export const hasBidiControls = (text) => BIDI_CONTROL_TEST_RE.test(asText(text));

// Accept only non-nested UAX #9 isolate pairs. Legacy marks/embeddings,
// unmatched PDI and nested (double-wrapped) isolates fail closed: silently
// stripping or adding another wrapper would make the emitted byte contract
// ambiguous. Multiple top-level pairs are valid for a composed field.
export const assertWellFormedBidiIsolation = (value) => {
  const text = asText(value);
  if (LEGACY_BIDI_CONTROL_RE.test(text)) {
    throw isolationError('legacy bidi formatting controls are not accepted');
  }
  let open = null;
  for (const char of text) {
    if (ISOLATE_OPENERS.has(char)) {
      if (open) throw isolationError('nested or double-wrapped isolate');
      open = char;
    } else if (char === PDI) {
      if (!open) throw isolationError('unmatched PDI');
      open = null;
    }
  }
  if (open) throw isolationError('unterminated isolate');
  return text;
};

const isExactlyIsolated = (text, opener) => {
  if (!text.startsWith(opener) || !text.endsWith(PDI)) return false;
  const controls = text.match(BIDI_CONTROL_RE) || [];
  return controls.length === 2;
};

const isolateWith = (value, opener, label) => {
  const text = assertWellFormedBidiIsolation(value);
  if (!hasBidiControls(text)) return `${opener}${text}${PDI}`;
  if (isExactlyIsolated(text, opener)) return text;
  throw isolationError(`${label} value already carries a different or composite isolate`);
};

// Isolate a value as left-to-right: amounts, IBANs, TRNs, invoice numbers,
// dates — anything that must read as one LTR unit inside RTL text.
export const isolateLtr = (value) => isolateWith(value, LRI, 'LTR');

// Isolate a value as right-to-left: an Arabic fragment that must hold
// together inside LTR text.
export const isolateRtl = (value) => isolateWith(value, RLI, 'RTL');

// Isolate a value with direction taken from its own first strong character —
// the safe default for party names and other free text of unknown script.
export const bidiIsolate = (value) => isolateWith(value, FSI, 'first-strong');

const wrapProseSegments = (text) => text
  .split(/(\n)/)
  .map((part) => (part === '\n' || part === '' ? part : bidiIsolate(part)))
  .join('');

// Compose a structured prose field containing identifiers. Logical bytes are
// unchanged after stripping: prose is first-strong and the recognized data
// values are independent LTR islands. An already-composed value validates and
// returns byte-for-byte, making the operation idempotent.
export const isolateStructuredText = (value) => {
  const text = assertWellFormedBidiIsolation(value);
  if (hasBidiControls(text)) return text;

  const matches = [...text.matchAll(LTR_DATA_RE)];
  if (!matches.length) return containsRtl(text) ? bidiIsolate(text) : isolateLtr(text);

  let cursor = 0;
  let rendered = '';
  for (const match of matches) {
    rendered += wrapProseSegments(text.slice(cursor, match.index));
    rendered += isolateLtr(match[0]);
    cursor = match.index + match[0].length;
  }
  rendered += wrapProseSegments(text.slice(cursor));
  return rendered;
};

// buildLinesBlock's grammar has one semantic split: the description is
// prose/name-like, while the complete quantity × unit = net currency tail is
// one LTR mathematical island. Keep the tail whole so '=' cannot reorder its
// operands. Existing composed lines validate and return unchanged.
export const isolateLinesBlock = (value) => {
  const text = assertWellFormedBidiIsolation(value);
  if (hasBidiControls(text)) return text;
  return text.split('\n').map((line) => {
    const divider = line.indexOf(' — ');
    if (divider < 0) return isolateStructuredText(line);
    return `${bidiIsolate(line.slice(0, divider))} — ${isolateLtr(line.slice(divider + 3))}`;
  }).join('\n');
};

const LTR_RENDER_VALUE_KEY_RE = /(?:^|_)(?:amount|total|currency|date|number|reference|trn|iban|email|url|overdue|until)(?:_|$)/;

// The one render-values boundary. It activates only for a mixed-direction
// payload (or a payload already processed by this function), classifies the
// closed issuance vocabulary, and returns a new object. Applying it twice is
// byte-identical; malformed or double-isolated input throws before rendering.
export const bidiSafeRenderValues = (values = {}, { force = false } = {}) => {
  const entries = Object.entries(values || {});
  for (const [, value] of entries) {
    if (value !== undefined && value !== null) assertWellFormedBidiIsolation(value);
  }
  const active = force || entries.some(([, value]) => (
    value !== undefined && value !== null
      && (containsRtl(value) || hasBidiControls(value))
  ));
  if (!active) return { ...values };

  return Object.fromEntries(entries.map(([key, value]) => {
    if (value === undefined || value === null) return [key, value];
    if (key === 'lines_block') return [key, isolateLinesBlock(value)];
    if (key === 'payment_instructions') return [key, isolateStructuredText(value)];
    if (['seller_address', 'buyer_address',
      'seller_tax_registration_block', 'buyer_tax_registration_block',
      'invoice_tax_totals_block'].includes(key)) {
      // Invoice blocks and addresses may contain line breaks without any
      // identifier. Keep each isolate on one PDF line; explicit empty blocks
      // stay empty so they retain their inapplicable-limb meaning.
      return [key, String(value).split('\n').map((line) => line === '' ? '' : isolateStructuredText(line)).join('\n')];
    }
    if (LTR_RENDER_VALUE_KEY_RE.test(key) || key === 'step_number' || key === 'days_until_due') {
      return [key, isolateLtr(value)];
    }
    return [key, bidiIsolate(value)];
  }));
};

// Strip shallow render values for comparisons and legacy consumers that do
// not implement UAX #9. The AR-4B1 PDF typesetter deliberately consumes the
// controls before removing them from drawn/logical PDF text.
export const stripBidiControlsFromValues = (values = {}) => Object.fromEntries(
  Object.entries(values || {}).map(([key, value]) => [
    key,
    value === undefined || value === null ? value : stripBidiControls(value)
  ])
);

// Remove every bidi formatting character. For comparisons, logs, filenames,
// and explicit renderer-internal cleanup after direction has been resolved.
export const stripBidiControls = (text) => asText(text).replace(BIDI_CONTROL_RE, '');
