// Display text for a bank-feed line.
//
// The June 2026 receipt: the feed rendered `cleaned_description` — the
// lowercased, punctuation-stripped form that exists for MATCHING
// (canonical merchant patterns, dedupe) — so a row read
// "pay eur 1000 00 to" after truncation while the artifact showed the
// readable original "Pay EUR 1000.00 to Jane Example". The raw
// statement text is the display string; the normalized form is a
// fallback only.
//
// Pipe-delimited statement lines ("EXAMPLE OY | Ref: INV001 | GA EUR |
// DK5000400440116243 | 00000000-…") additionally carry account/wallet
// noise segments that bury the counterparty under boilerplate — those
// are trimmed for display only. Stored data is never touched.

const NOISE_SEGMENT_PATTERNS = [
  /^ga [a-z]{3}$/i, // wallet marker — "GA EUR"
  /^[a-z]{2}\d{8,}$/i, // IBAN-ish account number — "DK5000400440116243"
  /^[0-9a-f]{8}-[0-9a-f-]{10,}$/i // uuid tail — "68146b3a-5e8a-11e8-…"
];

const isNoiseSegment = (segment) =>
  NOISE_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment));

export const displayBankLineDescription = (tx = {}) => {
  const raw = String(tx.description || tx.raw_description || '').trim();
  const text = raw || String(tx.cleaned_description || '').trim();
  if (!text) return '(no description)';
  if (!text.includes('|')) return text;
  const segments = text
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const kept = segments.filter((segment) => !isNoiseSegment(segment));
  return (kept.length ? kept : segments.slice(0, 1)).join(' · ');
};
