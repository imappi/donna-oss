// FI-13 slice 13.4 PR2 (D-FI13-17) — the issuance-side ALV activation resolver.
//
// This is the single place the invoice-issuance path decides "does this invoice
// carry ALV, and at what per-line rate?" It composes the two pieces PR1 shipped
// and the FI-3 rate table:
//   • the effective-dated registration model (alvRegistration.resolveAlvRegistrationAsOf)
//   • the date-effective rate table (alvCodes.fiAlvRateSetForDate)
//   • the config-plane flag FINLAND_ALV_INVOICING (dark by default)
//
// ALV is ACTIVE for an invoice iff the flag acts AND an effective registration
// exists on the invoice date. FORM-INDEPENDENT — never reads entity_type. When
// ALV is not active (flag off, OR no effective registration, OR a garbage record)
// every line resolves to rate 0 / exempt, which is BYTE-IDENTICAL to today's
// hardcoded non-ALV issuance. That is the whole safety story: the live toiminimi
// book, with the flag dark, sees exactly the current behaviour.
//
// Per-line rate (trust-the-strong-LLM): when ALV is active the issuance model
// PROPOSES a rate per line; this resolver accepts it only if it is a real rate in
// the invoice date's era (standard or a reduced rate) or 0 (a genuinely
// exempt/zero line), and otherwise defaults to the standard rate — a registered
// seller's line is standard-rated unless the model marks it reduced/exempt. The
// owner corrects on the rendered draft; the correction is the training signal.

import { resolveAlvRegistrationAsOf } from './alvRegistration.js';
import { fiAlvRateSetForDate } from './alvCodes.js';

// Config-plane flag (migration 042 pattern) — clientFlagActs, envFallback
// () => false; dark by default, canary per client (flags-born-on-the-plane rail).
export const FINLAND_ALV_INVOICING_FLAG_KEY = 'FINLAND_ALV_INVOICING';

const roundRate = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// The set of per-line rates a registered seller may legitimately charge on a
// given date: the era's standard + reduced rates, plus 0 (an exempt / zero-rated
// line on an otherwise registered seller). A proposed rate outside this set is
// not trusted — it defaults to standard.
const allowedRatesForDate = (asOf) => {
  const set = fiAlvRateSetForDate(asOf);
  const rates = new Set([0, roundRate(set.standard)]);
  for (const r of Array.isArray(set.reduced) ? set.reduced : []) rates.add(roundRate(r));
  return { rateSet: set, allowed: rates, standard: roundRate(set.standard) };
};

// resolveIssuanceAlvContext({ registration, asOf, flagActs }) — the issuance ALV
// context. Pure; never throws.
//
// Returns:
//   { alvActive, alvRegistered, asOf, rateSet, standardRate,
//     resolveLineRate(proposed), confirmedAgainstPrimary }
//
//   alvActive / alvRegistered — true iff the flag acts AND an effective
//     registration covers asOf. (Two names, one meaning: `alvRegistered` is the
//     boolean buildInvoice/buildIssuanceArtifacts already speak; `alvActive` is
//     the issuance-intent/prompt gate. They are always equal.)
//   resolveLineRate(proposed) — the per-line rate to bill: 0 when ALV is not
//     active; otherwise the proposed rate if it is an allowed rate for the date,
//     else the standard rate. A registered seller never silently under-charges to
//     0 from a bad proposal — it falls back to standard, not exempt.
export const resolveIssuanceAlvContext = ({ registration = null, asOf = null, flagActs = false } = {}) => {
  const resolved = resolveAlvRegistrationAsOf({ registration, asOf });
  const alvActive = flagActs === true && resolved.registered === true;

  if (!alvActive) {
    // The exempt path — byte-identical to today. No rate table is consulted.
    return {
      alvActive: false,
      alvRegistered: false,
      asOf: resolved.as_of,
      rateSet: null,
      standardRate: 0,
      confirmedAgainstPrimary: false,
      resolveLineRate: () => 0
    };
  }

  const { rateSet, allowed, standard } = allowedRatesForDate(resolved.as_of);
  return {
    alvActive: true,
    alvRegistered: true,
    asOf: resolved.as_of,
    rateSet,
    standardRate: standard,
    // The registration's own verification rides through — an unverified
    // registration still activates ALV (the firm entered it) but the invoice
    // inherits confirmedAgainstPrimary:false for the F-FI13-V surface.
    confirmedAgainstPrimary: resolved.confirmedAgainstPrimary && rateSet.confirmedAgainstPrimary !== false,
    resolveLineRate: (proposed) => {
      // No proposal at all (null/undefined — the model omitted the rate) is NOT
      // an exempt marking: it defaults to standard. Only an EXPLICIT 0 renders
      // a zero-rated line. (Number(null) is 0 — without this guard a missing
      // proposal would silently under-charge to exempt.)
      if (proposed === null || proposed === undefined) return standard;
      const r = roundRate(proposed);
      if (Number.isFinite(r) && allowed.has(r)) return r;
      return standard;
    }
  };
};
