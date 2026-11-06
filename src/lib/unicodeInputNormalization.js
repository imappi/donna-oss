// Shared deterministic Unicode normalization for presentation/search
// comparisons. This module never mutates or replaces the source value: callers
// use the returned key only for matching and keep stored text, identifiers,
// amounts, model input, and receipts byte-for-byte.

export const MAX_UNICODE_INPUT_LENGTH = 4096;

// UAX #9 formatting controls are unsafe inside an untrusted search key. Search
// must fail closed rather than strip them into an identifier match.
const UNSAFE_BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

// Common Arabic combining marks/harakat. The split ranges deliberately retain
// U+06E5/U+06E6 (small waw/yeh), which are letters rather than diacritics.
const ARABIC_DIACRITIC_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u08D3-\u08E1\u08E3-\u08FF]/gu;
const TATWEEL_RE = /\u0640/gu;

const ARABIC_INDIC_ZERO = 0x0660;
const EASTERN_ARABIC_ZERO = 0x06F0;

export const hasUnsafeBidiControls = (value) =>
  UNSAFE_BIDI_CONTROL_RE.test(String(value ?? ''));

const normalizeDigitsAndSeparators = (text) => {
  let normalized = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint >= ARABIC_INDIC_ZERO && codePoint <= ARABIC_INDIC_ZERO + 9) {
      normalized += String(codePoint - ARABIC_INDIC_ZERO);
    } else if (codePoint >= EASTERN_ARABIC_ZERO && codePoint <= EASTERN_ARABIC_ZERO + 9) {
      normalized += String(codePoint - EASTERN_ARABIC_ZERO);
    } else if (char === '\u066B') {
      normalized += '.';
    } else if (char === '\u066C') {
      normalized += ',';
    } else {
      normalized += char;
    }
  }
  return normalized;
};

// Search-only equivalence. This is intentionally narrow: common alef forms,
// alef maqsura/Persian yeh, and Persian keheh. It does not fold taa marbuta,
// hamza, waw, or other meaning-bearing Arabic letters.
const foldArabicSearchLetters = (text) => text
  .replace(/[\u0622\u0623\u0625\u0671]/gu, '\u0627')
  .replace(/[\u0649\u06CC]/gu, '\u064A')
  .replace(/\u06A9/gu, '\u0643');

const normalizeUnicodeInput = (value, { foldSearchLetters = false } = {}) => {
  const source = String(value ?? '');
  if (source.length > MAX_UNICODE_INPUT_LENGTH || hasUnsafeBidiControls(source)) return null;

  let normalized = source.normalize('NFKC');
  if (normalized.length > MAX_UNICODE_INPUT_LENGTH || hasUnsafeBidiControls(normalized)) return null;
  normalized = normalizeDigitsAndSeparators(normalized)
    .replace(ARABIC_DIACRITIC_RE, '')
    .replace(TATWEEL_RE, '');
  return foldSearchLetters ? foldArabicSearchLetters(normalized) : normalized;
};

// Presentation/search key only. Lowercasing and edge trimming preserve the
// existing manual-link and mention-search comparison contract.
export const normalizeUnicodeSearchKey = (value) => {
  const normalized = normalizeUnicodeInput(value, { foldSearchLetters: true });
  return normalized == null ? null : normalized.toLowerCase().trim();
};

// Numeric corroboration only. Letters are deliberately not folded, and the
// caller still owns parsing/comparison; this merely exposes ASCII digits and
// separators to the existing deterministic amount check.
export const normalizeUnicodeNumericText = (value) =>
  normalizeUnicodeInput(value, { foldSearchLetters: false });
