// Content fingerprint for `document_lines` rows. PR 2 writes one of
// these on every line at insert time so PR 3's re-parse merge can
// look up "is this the same line as before?" without trusting
// extractor ordering or row ids.
//
// The algorithm is canonical: identical content → identical hash,
// across re-extractions, casing changes, whitespace drift, unicode
// representation differences. Move carefully — any change here
// requires backfilling all existing rows.

import crypto from 'node:crypto';

// Description normalisation rules (locked at PR 2; PR 3 inherits):
//   1. NFKD compatibility decomposition — collapses ligatures,
//      fullwidth chars, etc. to a canonical form.
//   2. lowercase — case-fold so "Latte" and "LATTE" collide.
//   3. strip combining diacritics — "café" → "cafe" after NFKD splits
//      the é into e + combining acute.
//   4. collapse non-alphanumeric runs to a single space — whitespace,
//      punctuation, hyphens all flatten away.
//   5. trim.
//
// Why this trade-off: receipt OCR + LLM extraction is noisy on
// punctuation/casing/whitespace. We'd rather over-merge near-identical
// lines than spuriously split a real match across a Retry.
const normalizeDescription = (raw) =>
  String(raw ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Money columns canonicalise to 2dp. amount and unit_price are
// numeric(14, 2) on the table; quantity is numeric(14, 4). Pin the
// JS-side rounding to the column scale so 12 vs 12.00 don't fingerprint
// differently after a DB round-trip.
const formatAmount = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '';
};

const formatQuantity = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : '';
};

const formatCurrency = (value) =>
  String(value ?? '').trim().toUpperCase();

export const lineFingerprint = ({
  description,
  quantity,
  unit_price,
  amount,
  currency
} = {}) => {
  const parts = [
    normalizeDescription(description),
    formatAmount(amount),
    formatQuantity(quantity),
    formatAmount(unit_price),
    formatCurrency(currency)
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
};

// Exported for tests + (future) backfill scripts that want to mirror
// the exact normalisation rules without re-implementing them.
export const __normalizeDescription = normalizeDescription;
export const __formatAmount = formatAmount;
export const __formatQuantity = formatQuantity;
