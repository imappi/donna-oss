// FI-15 G-8 (Half B) — the FINNISH half of issued-invoice settlement, plus a
// RE-EXPORT SHIM over the arithmetic that is no longer Finnish.
//
// SPLIT 2026-07-27 under Kari's dated gap-8 re-scope. The pure, jurisdiction-
// neutral arithmetic moved verbatim to `server/donna/issuedInvoiceSettlementMath.js`
// so the generic outbound engine stops importing a country module
// (`outbound/paidTruthGuard.js` was gap 8's second edge). It is re-exported
// here UNCHANGED, so every existing `finland/` consumer — and this module's own
// test — keeps its import path and its behaviour. No new logic lives in
// `finland/` as a result of the move; the FI suite green is the acceptance bar.
//
// What is genuinely Finnish and therefore STAYED: the FINLAND_AR_SETTLEMENT
// flag key, `planArSettlement` (the AR posting-swap plan), and
// `buildIssuedInvoiceBannerFi` (Finnish owner copy). The same posture #1129
// took with `ledger.js` — statutory content stays in its market, the engine
// stops reaching across.
//
// Design: docs/design-donna-finland-fi15-g8-credit-notes.md (D-G8-6/7).

export {
  ISSUED_INVOICE_PAYMENT_STATES,
  ISSUED_INVOICE_FLAGS,
  STRUCTURED_REFERENCE_MIN_DIGITS,
  normalizeReferenceText,
  paymentMatchesInvoice,
  evaluateIssuedInvoiceSettlement,
  summarizeIssuedInvoices
} from '../issuedInvoiceSettlementMath.js';

// `planArSettlement` below runs the same rounding and the same 1¢ epsilon the
// relocated arithmetic does — imported rather than re-declared, so the two
// halves can never drift apart.
import { round2, EPSILON } from '../issuedInvoiceSettlementMath.js';

// ---------------------------------------------------------------------------------
// F-G8-1 — the AR settlement PLAN (the pure half of the posting swap).
// Design: docs/design-donna-finland-ar-settlement-posting.md (D-AR-1…7).
// ---------------------------------------------------------------------------------
// The decision logic for swapping a money-in line's credit side from revenue
// to 1700 Myyntisaamiset lives HERE (pure, exhaustively testable); the
// isolation-listed resolver in firmDb.js only hydrates the inputs and calls
// this. Every plan terminates in exactly one of two states: planned (the swap
// executes at commit, receipted) or { planned:false, reason } from the CLOSED
// vocabulary below (the post proceeds byte-identical to today, reason
// receipted — nothing silent, never a third state).

// New dark config-plane flag (D-AR-6a): envFallback () => false everywhere it
// is read; canary per client before any blanket enable — the swap changes
// POSTING behavior for clients already invoicing under FINLAND_INVOICING.
export const FINLAND_AR_SETTLEMENT_FLAG_KEY = 'FINLAND_AR_SETTLEMENT';

// The CLOSED plan-refusal vocabulary (D-AR-2). There is no commit-time
// fallback set on the AR side: unlike AP, the swap posts no second journal,
// so these prepare-time reasons are the COMPLETE enumeration.
export const AR_SETTLEMENT_PLAN_REASONS = Object.freeze([
  'flag_off',
  'cash_basis',
  'not_money_in',
  'no_issued_invoice_match',
  'multiple_invoice_matches',
  'no_issuance_journal',
  'currency_mismatch',
  'overpayment'
]);

// planArSettlement — the closed verdict. Inputs are hydrated by the resolver:
//   flagActs      — FINLAND_AR_SETTLEMENT acts for the client
//   basis         — the client's accounting basis ('accrual' | 'cash')
//   direction     — the ledger direction of the line ('receive' | 'spend' | …)
//   amountEur     — the money-in amount
//   transactionCurrency
//   matchCount    — how many issued invoices the line's text matched
//                   (paymentMatchesInvoice, the Half B matcher — conservative)
//   candidate     — the SINGLE matched invoice, hydrated:
//                   { invoice_id, invoice_number, reference_number, buyer_name,
//                     currency, total_eur, credited_total_eur,
//                     settled_before_eur, has_issuance_journal }
// Returns { planned:true, …receipt fields, open_before_eur, open_after_eur }
// or { planned:false, reason }. Pure; never throws on garbage.
export const planArSettlement = ({
  flagActs = false,
  basis = null,
  direction = null,
  amountEur = null,
  transactionCurrency = null,
  matchCount = 0,
  candidate = null
} = {}) => {
  if (!flagActs) return { planned: false, reason: 'flag_off' };
  // Cash-basis clients book income at receipt — CR revenue on the money-in
  // line is CORRECT for them; there is no receivable to clear.
  if (basis !== 'accrual') return { planned: false, reason: 'cash_basis' };
  const amount = round2(Number(amountEur));
  if (direction !== 'receive' || !(amount > 0)) return { planned: false, reason: 'not_money_in' };
  if (!Number(matchCount) || !candidate || typeof candidate !== 'object') {
    return { planned: false, reason: 'no_issued_invoice_match' };
  }
  // One line settling MANY invoices is split territory, not v1 (the AP §T.3 line).
  if (Number(matchCount) > 1) return { planned: false, reason: 'multiple_invoice_matches' };
  // KEEP: CR 1700 on a settlement ⟺ the receivable was actually booked. A
  // paid invoice whose issuance journal is missing falls back — never a blind swap.
  if (candidate.has_issuance_journal !== true) return { planned: false, reason: 'no_issuance_journal' };
  const txCurrency = String(transactionCurrency || '').trim().toUpperCase();
  const invCurrency = String(candidate.currency || '').trim().toUpperCase();
  if (!txCurrency || !invCurrency || txCurrency !== invCurrency) {
    return { planned: false, reason: 'currency_mismatch' };
  }
  // Open amount = total − issued credits − prior AR-settled amounts (the
  // ledger's own record of what already cleared 1700 for this invoice).
  // Beyond-open payment refuses (D-AR-2.7, Kari 2026-07-11): the overpaid
  // state is F-G8-2's owner-ask, never a posting improvisation. Partial
  // payments plan normally — CR 1700 at the line amount clears partially.
  const openBefore = round2(
    (Number(candidate.total_eur) || 0)
    - Math.max(0, Number(candidate.credited_total_eur) || 0)
    - Math.max(0, Number(candidate.settled_before_eur) || 0)
  );
  if (openBefore <= EPSILON || amount > openBefore + EPSILON) {
    return { planned: false, reason: 'overpayment' };
  }
  return {
    planned: true,
    invoice_id: candidate.invoice_id,
    invoice_number: candidate.invoice_number || null,
    reference_number: candidate.reference_number || null,
    buyer_name: candidate.buyer_name || null,
    amount_eur: amount,
    open_before_eur: openBefore,
    open_after_eur: round2(openBefore - amount)
  };
};

// The banner surfaces ONLY what needs a look: overdue and overpaid. Healthy
// books (everything paid/unpaid-but-not-due/credited) stay quiet — null.
export const buildIssuedInvoiceBannerFi = (summary = {}) => {
  const overdue = Number(summary.overdue) || 0;
  const overpaid = Number(summary.overpaid) || 0;
  if (overdue <= 0 && overpaid <= 0) return null;
  const parts = [];
  if (overdue > 0) {
    parts.push(overdue === 1
      ? '1 lähetetty lasku on erääntynyt maksamattomana.'
      : `${overdue} lähetettyä laskua on erääntynyt maksamattomina.`);
  }
  if (overpaid > 0) {
    parts.push(overpaid === 1
      ? '1 lasku näyttää maksetun yli laskutetun summan.'
      : `${overpaid} laskua näyttää maksetun yli laskutetun summan.`);
  }
  return parts.join(' ');
};
