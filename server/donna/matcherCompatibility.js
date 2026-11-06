// Cross-matcher compatibility helpers shared between receipt,
// supplier_bill, and sales_invoice reconciliation. Centralises two
// comparisons whose semantics were previously inconsistent across the
// three matchers (PRs #175 and #176 patched receipt-only regressions
// that should have been caught by a shared invariant test):
//
// 1. Currency comparison has TWO distinct verdicts:
//
//      - suggestion: tolerant of one-sided null. A receipt with
//        currency=null vs a transaction with currency='GBP' can still
//        be SUGGESTED to a reviewer — the reviewer decides whether the
//        missing currency is GBP or something else.
//
//      - autoMatch: strict — both sides MUST carry the same, non-null
//        currency before a candidate is eligible to skip review. Per
//        the production amendment: "one-sided unknown currency should
//        allow a suggested candidate, but block auto-match/auto-explain
//        unless we have independent single-currency evidence."
//
// 2. Date comparison must be Date-object-safe — `node-postgres` returns
//    JavaScript Date objects for `date` columns, which broke the shared
//    `daysBetween` helper in PR #176. The shared helper here re-uses
//    `transactionIntel.daysBetween`; this module exists to give parity
//    tests a single import point for the invariant.

import { daysBetween as intelDaysBetween } from './transactionIntel.js';

const normalizeCurrency = (value) => {
  if (value == null || value === '') return null;
  return String(value).toUpperCase();
};

export const CURRENCY_CERTAINTY = Object.freeze({
  BOTH: 'both',
  ONE_SIDED_NULL: 'one_sided_null',
  BOTH_NULL: 'both_null',
  MISMATCH: 'mismatch'
});

// Returns `{ suggestion, autoMatch, certainty }`. Always returns an
// object — never throws on null/undefined inputs.
export const currencyCompatibility = (a, b) => {
  const normA = normalizeCurrency(a);
  const normB = normalizeCurrency(b);
  if (normA === null && normB === null) {
    return { suggestion: true, autoMatch: false, certainty: CURRENCY_CERTAINTY.BOTH_NULL };
  }
  if (normA === null || normB === null) {
    return { suggestion: true, autoMatch: false, certainty: CURRENCY_CERTAINTY.ONE_SIDED_NULL };
  }
  if (normA !== normB) {
    return { suggestion: false, autoMatch: false, certainty: CURRENCY_CERTAINTY.MISMATCH };
  }
  return { suggestion: true, autoMatch: true, certainty: CURRENCY_CERTAINTY.BOTH };
};

// Boolean shorthands for call sites that don't need the certainty
// field. The full object form is preferred when the certainty needs to
// flow into match_reason for audit purposes.
export const currenciesCompatibleForSuggestion = (a, b) =>
  currencyCompatibility(a, b).suggestion;

export const currenciesCompatibleForAutoMatch = (a, b) =>
  currencyCompatibility(a, b).autoMatch;

// Date gap in whole days. Re-exported here so parity tests can pin all
// three matchers' date semantics to a single source. PR #176 fix is
// authoritative; this is a pass-through.
export const daysBetween = intelDaysBetween;
