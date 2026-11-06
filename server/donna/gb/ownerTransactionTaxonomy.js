// Closed GB owner↔business transaction taxonomy — BOTH entity axes. Pure data
// and classification only: no I/O and no ledger touch. A proposal is data that
// must still pass through the accounting-aware ledger writer's invariants
// downstream. Every transfer ends in exactly one state: ready-to-post PROPOSAL
// when fully evidenced and permitted, or OWNER ESCALATION. Types are inputs,
// never inferred from the amount or appearance of a bank transfer.
//
// TWO SPEC TABLES, ONE CLASSIFIER, ONE FLAG. The director/shareholder table
// (Ltd — dividends, DLA, s455 machinery) and the SOLE-TRADER table (drawings,
// capital introduced — no dividends, no DLA, no salary-to-self) are separate
// closed catalogs dispatched by the caller-resolved entity axis
// (`gbEntityType`, the canonical bridge — the axis is an argument here, never
// re-derived from persisted vocabulary). A type that belongs to the OTHER
// axis escalates by name (`sole_trader_type_unavailable`) rather than being
// silently coerced: a "dividend" proposed on an unincorporated book is a
// mis-typed input to surface, not a drawing to guess at.
//
// Market-neutrality note (the standing FI/US question): the SHAPE — closed
// types as inputs, evidence specs, propose/escalate two-terminal — is
// market-neutral machinery; these tables are GB pack data. FI toiminimi
// (yksityisotot/yksityissijoitukset) poses the same two equity movements and
// would land as a sibling pack table on the SAME roles
// (`equity.owner_drawings` / `equity.owner_capital`, both market-neutral by
// their 2026-07-31 minting) when the FI lane activates.

import { clientFlagActs } from '../clientConfig.js';

export const GB_OWNER_TRANSACTION_PROVENANCE = Object.freeze({
  authority: Object.freeze(['Companies House', 'HM Revenue & Customs']),
  asOf: '2026-07-30',
  confirmedAgainstPrimary: false,
  rules: Object.freeze({
    s455_rate: Object.freeze({ value: 0.3375, note: "Remembered CT charge rate on an overdrawn director's loan outstanding 9 months + 1 day after the accounting-period end (s455 CTA 2010); relieved when the loan is repaid. Verify rate and timing against HMRC primary guidance." }),
    s455_due_months_after_period_end: Object.freeze({ value: 9, note: 'Remembered: s455 falls due 9 months and 1 day after the accounting-period end; verify.' }),
    beneficial_loan_threshold_gbp: Object.freeze({ value: 10000, note: 'Remembered: an overdrawn DLA exceeding £10,000 at any point with no/low interest is a taxable benefit-in-kind (P11D, s175 ITEPA); verify threshold.' }),
    amap_first_10k_rate_gbp: Object.freeze({ value: 0.45, note: 'Remembered AMAP car rate for the first 10,000 business miles; verify.' }),
    amap_over_10k_rate_gbp: Object.freeze({ value: 0.25, note: 'Remembered AMAP car rate beyond 10,000 business miles; verify.' }),
    bed_and_breakfasting_note: Object.freeze({ value: '30_day_and_5k_15k_rules', note: 'Remembered anti-avoidance: a DLA repayment followed by redraw within 30 days, or where £5,000+ is repaid and £15,000+ redrawn, does not clear the s455 charge; verify.' }),
    dividend_requires_distributable_profits: Object.freeze({ value: true, note: 'Remembered (CA2006 s830): a dividend is lawful only out of distributable profits; a dividend without them is unlawful and repayable. Verify.' }),
    sole_trader_drawings_not_deductible: Object.freeze({ value: true, note: 'Remembered: a sole trader’s drawings are equity movements, never a deductible expense and never payroll; tax arises on profits via Self Assessment regardless of what is drawn. Verify wording against HMRC guidance (the K1 corpus Q22 source).' }),
    own_use_goods_vat_deemed_supply: Object.freeze({ value: true, note: 'Remembered (VATA 1994 Sch 4; VAT guide 700): a VAT-registered trader taking business goods for private use makes a deemed supply and must account for output VAT. Verify scope and valuation against primary guidance before any acting lane relies on it.' })
  }),
  verificationNote: 'gov.uk was unavailable through the session egress proxy; verify every remembered statutory value and rule against Companies House and HMRC primary guidance before an acting lane relies on it.'
});

export const GB_OWNER_TRANSACTION_TAXONOMY_FLAG_KEY = 'GB_OWNER_TRANSACTION_TAXONOMY';
export const gbOwnerTransactionTaxonomyEnabled = ({ snapshot = null, env = process.env } = {}) => clientFlagActs({
  flagKey: GB_OWNER_TRANSACTION_TAXONOMY_FLAG_KEY,
  snapshot,
  envFallback: () => false,
  env
});

export const GB_OWNER_TRANSACTION_TYPES = Object.freeze([
  'director_salary', 'expense_reimbursement', 'mileage_reimbursement', 'dividend',
  'directors_loan_advance', 'directors_loan_from_director', 'directors_loan_repayment_by_director',
  'loan_repayment_to_director', 'interest_to_director', 'share_subscription',
  'capital_reduction_return', 'related_party_purchase', 'related_party_sale', 'unknown_owner_transfer'
]);

export const GB_OWNER_TRANSACTION_SPECS = Object.freeze({
  director_salary: { type: 'director_salary', direction: 'company_to_owner', name_en: "Director's salary", required_evidence: ['payroll_rti_submission'], suggested_accounts: { debit: '5000', credit: '1400' }, auto_postable: false, escalation_reason: 'owner_salary_requires_payroll', gated_decision: 'GB-DIR-D1' },
  expense_reimbursement: { type: 'expense_reimbursement', direction: 'company_to_owner', name_en: 'Expense reimbursement', required_evidence: ['expense_receipt'], suggested_accounts: { debit: '6900', credit: '2240' }, auto_postable: true },
  mileage_reimbursement: { type: 'mileage_reimbursement', direction: 'company_to_owner', name_en: 'Mileage reimbursement', required_evidence: ['mileage_claim'], suggested_accounts: { debit: '6400', credit: '2240' }, auto_postable: true },
  dividend: { type: 'dividend', direction: 'company_to_owner', name_en: 'Dividend', required_evidence: ['board_minute', 'dividend_voucher', 'distributable_profits_confirmation'], suggested_accounts: { debit: '2100', credit: '2240' }, auto_postable: false, escalation_reason: 'dividend_detect_and_escalate', gated_decision: 'GB-DIR-D2' },
  directors_loan_advance: { type: 'directors_loan_advance', direction: 'company_to_owner', name_en: "Director's loan — advance to director", required_evidence: ['loan_record'], suggested_accounts: { debit: '2240', credit: '1400' }, auto_postable: false, escalation_reason: 'directors_loan_advance_requires_review' },
  directors_loan_from_director: { type: 'directors_loan_from_director', direction: 'owner_to_company', name_en: "Director's loan — from director", required_evidence: ['loan_record'], suggested_accounts: { debit: '1400', credit: '2240' }, auto_postable: true },
  directors_loan_repayment_by_director: { type: 'directors_loan_repayment_by_director', direction: 'owner_to_company', name_en: "Director's loan — repayment by director", required_evidence: ['loan_reference'], suggested_accounts: { debit: '1400', credit: '2240' }, auto_postable: false, escalation_reason: 'dla_repayment_bed_and_breakfasting_review' },
  loan_repayment_to_director: { type: 'loan_repayment_to_director', direction: 'company_to_owner', name_en: 'Loan repayment to director', required_evidence: ['loan_reference'], suggested_accounts: null, auto_postable: false, escalation_reason: 'loan_repayment_needs_principal_reference' },
  interest_to_director: { type: 'interest_to_director', direction: 'either', name_en: 'Interest to director', required_evidence: ['ct61_basis'], suggested_accounts: null, auto_postable: false, escalation_reason: 'related_party_interest_requires_ct61' },
  share_subscription: { type: 'share_subscription', direction: 'owner_to_company', name_en: 'Share subscription', required_evidence: ['sh01_filing'], suggested_accounts: { debit: '1400', credit: '2000' }, auto_postable: false, escalation_reason: 'share_capital_change_requires_registration' },
  capital_reduction_return: { type: 'capital_reduction_return', direction: 'company_to_owner', name_en: 'Capital reduction return', required_evidence: ['solvency_statement', 'board_minute'], suggested_accounts: { debit: '2000', credit: '1400' }, auto_postable: false, escalation_reason: 'capital_reduction_requires_decision' },
  related_party_purchase: { type: 'related_party_purchase', direction: 'company_to_owner', name_en: 'Related-party purchase', required_evidence: ['related_party_invoice'], suggested_accounts: { debit: '6900', credit: '2240' }, auto_postable: false, escalation_reason: 'related_party_pricing_requires_review' },
  related_party_sale: { type: 'related_party_sale', direction: 'owner_to_company', name_en: 'Related-party sale', required_evidence: ['related_party_invoice'], suggested_accounts: { debit: '2240', credit: '3000' }, auto_postable: false, escalation_reason: 'related_party_pricing_requires_review' },
  unknown_owner_transfer: { type: 'unknown_owner_transfer', direction: 'either', name_en: 'Unidentified owner transfer', required_evidence: [], suggested_accounts: null, auto_postable: false, escalation_reason: 'owner_transfer_unresolved' }
});

// ── The sole-trader axis ─────────────────────────────────────────────────────
// An unincorporated owner and the business are ONE legal person: no dividends,
// no director's loan, no salary-to-self. The whole owner↔business surface is
// two equity movements (drawings out, capital in), the expense-paid-personally
// / mileage claims that ride the capital side, and the one VAT hazard (goods
// taken for own use). Account codes reference GB_SOLE_TRADER_DEFAULT_CHART
// (2000 Owner capital introduced · 2010 Owner drawings); as everywhere in this
// module they are DEFAULTS — the posting path resolves the client's own chart
// by canonical role, never these literals.

export const GB_SOLE_TRADER_OWNER_TRANSACTION_TYPES = Object.freeze([
  'owner_drawings', 'owner_capital_introduced', 'business_expense_paid_personally',
  'mileage_claim', 'goods_own_use', 'unknown_owner_transfer'
]);

export const GB_SOLE_TRADER_OWNER_TRANSACTION_SPECS = Object.freeze({
  owner_drawings: { type: 'owner_drawings', direction: 'company_to_owner', name_en: 'Owner drawings', required_evidence: [], suggested_accounts: { debit: '2010', credit: '1400' }, auto_postable: true },
  owner_capital_introduced: { type: 'owner_capital_introduced', direction: 'owner_to_company', name_en: 'Owner capital introduced', required_evidence: [], suggested_accounts: { debit: '1400', credit: '2000' }, auto_postable: true },
  business_expense_paid_personally: { type: 'business_expense_paid_personally', direction: 'owner_to_company', name_en: 'Business expense paid personally', required_evidence: ['expense_receipt'], suggested_accounts: { debit: '6900', credit: '2000' }, auto_postable: true },
  mileage_claim: { type: 'mileage_claim', direction: 'owner_to_company', name_en: 'Mileage claim (simplified expenses)', required_evidence: ['mileage_claim'], suggested_accounts: { debit: '6400', credit: '2000' }, auto_postable: true },
  goods_own_use: { type: 'goods_own_use', direction: 'company_to_owner', name_en: 'Goods taken for own use', required_evidence: [], suggested_accounts: null, auto_postable: false, escalation_reason: 'own_use_vat_deemed_supply_review' },
  unknown_owner_transfer: { type: 'unknown_owner_transfer', direction: 'either', name_en: 'Unidentified owner transfer', required_evidence: [], suggested_accounts: null, auto_postable: false, escalation_reason: 'owner_transfer_unresolved' }
});

const SPEC_TABLES = Object.freeze({
  ltd: GB_OWNER_TRANSACTION_SPECS,
  sole_trader: GB_SOLE_TRADER_OWNER_TRANSACTION_SPECS
});

// Anything that is not the sole-trader axis resolves the director/shareholder
// table — the pre-axis behaviour, byte-identical for every existing caller.
const specTableForAxis = (entityAxis) =>
  SPEC_TABLES[entityAxis === 'sole_trader' ? 'sole_trader' : 'ltd'];

export const isOwnerTransactionType = (value, { entityAxis } = {}) =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(specTableForAxis(entityAxis), value);

export const resolveOwnerTransactionSpec = (type, { entityAxis } = {}) => {
  const table = specTableForAxis(entityAxis);
  return table[type] || table.unknown_owner_transfer;
};

// A type that exists on the OTHER axis is a MIS-TYPED input, not an unknown:
// name it, so "dividend on a sole-trader book" surfaces as the modelling error
// it is instead of dissolving into the generic unresolved question.
const typeBelongsToOtherAxis = (type, entityAxis) => {
  const other = entityAxis === 'sole_trader' ? GB_OWNER_TRANSACTION_SPECS : GB_SOLE_TRADER_OWNER_TRANSACTION_SPECS;
  return typeof type === 'string' && type !== 'unknown_owner_transfer' && Object.prototype.hasOwnProperty.call(other, type);
};

export const classifyOwnerTransaction = ({ type, evidence = [], entityAxis = 'ltd' } = {}) => {
  const table = specTableForAxis(entityAxis);
  if (typeBelongsToOtherAxis(type, entityAxis) && !Object.prototype.hasOwnProperty.call(table, type)) {
    const spec = table.unknown_owner_transfer;
    return {
      terminal: 'escalate',
      type: 'unknown_owner_transfer',
      spec,
      reason: entityAxis === 'sole_trader' ? 'sole_trader_type_unavailable' : 'ltd_type_unavailable',
      mistyped_as: type,
      missing_evidence: [],
      question_en: entityAxis === 'sole_trader'
        ? `'${type}' isn't available to a sole trader — there's no company to pay a salary, dividend or director's loan. Is this transfer drawings, capital you put in, or a business expense you paid personally?`
        : `'${type}' is a sole-trader movement and this is a limited company. Is this transfer salary, a dividend, an expense reimbursement, or a director's loan movement?`
    };
  }
  const resolvedType = isOwnerTransactionType(type, { entityAxis }) ? type : 'unknown_owner_transfer';
  const spec = table[resolvedType];
  const present = new Set(
    Array.isArray(evidence)
      ? evidence.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim())
      : evidence && typeof evidence === 'object'
        ? Object.keys(evidence).filter((k) => evidence[k])
        : []
  );
  const missing = (spec.required_evidence || []).filter((kind) => !present.has(kind));

  if (spec.auto_postable && missing.length === 0) {
    return { terminal: 'proposal', type: resolvedType, spec, suggested_accounts: spec.suggested_accounts, missing_evidence: [] };
  }
  return {
    terminal: 'escalate',
    type: resolvedType,
    spec,
    reason: missing.length ? 'missing_required_evidence' : spec.escalation_reason || 'owner_transfer_requires_review',
    missing_evidence: missing,
    question_en: buildOwnerTransactionQuestion(spec, missing, entityAxis)
  };
};

const buildOwnerTransactionQuestion = (spec, missing, entityAxis = 'ltd') => {
  if (spec.type === 'unknown_owner_transfer') {
    return entityAxis === 'sole_trader'
      ? "This transfer between you and the business isn't identified. What is it — drawings, capital you put in, a business expense you paid personally…? I won't post it until it's resolved."
      : "This transfer between the company and its director isn't identified. What is it — salary, dividend, expense reimbursement, a director's loan…? I won't post it until it's resolved.";
  }
  if (spec.type === 'goods_own_use') {
    return 'Taking business goods for your own use can mean accounting for VAT on them (a deemed supply) if you are VAT registered. What was taken, and roughly what did it cost the business?';
  }
  if (missing.length) return `This looks like ${spec.name_en}, but I need: ${missing.join(', ')}.`;
  return `A '${spec.name_en}' transaction needs review before posting.`;
};

export const directorsLoanAccountWatch = ({ balance = 0, currency = 'GBP' } = {}) => {
  const overdrawn = balance > 0;
  const beneficialLoanAttention = balance > GB_OWNER_TRANSACTION_PROVENANCE.rules.beneficial_loan_threshold_gbp.value;
  const watches = [];
  if (overdrawn) watches.push({ code: 'GB_DLA_S455_ATTENTION', note: GB_OWNER_TRANSACTION_PROVENANCE.rules.s455_rate.note });
  if (beneficialLoanAttention) watches.push({ code: 'GB_DLA_BENEFICIAL_LOAN_ATTENTION', note: GB_OWNER_TRANSACTION_PROVENANCE.rules.beneficial_loan_threshold_gbp.note });
  return { overdrawn, balance, currency, s455_attention: overdrawn, beneficial_loan_attention: beneficialLoanAttention, watches };
};

// The sole-trader sibling of the DLA watch — and DELIBERATELY weaker, because
// the law is weaker: drawings exceeding capital + accumulated profits carry NO
// s455 charge, no benefit-in-kind, no statutory consequence at all for an
// unincorporated owner. Negative owner equity is a solvency/sustainability
// signal (the business is being drawn faster than it earns), so this watch is
// ADVISORY: it renders an attention row, never a blocker and never an ask.
// `equityBalance` uses the equity NORMAL sign: positive = capital + profits
// exceed drawings; negative = overdrawn.
export const soleTraderOwnerEquityWatch = ({ equityBalance = 0, currency = 'GBP' } = {}) => {
  const overdrawn = equityBalance < 0;
  const watches = [];
  if (overdrawn) {
    watches.push({
      code: 'GB_ST_NEGATIVE_OWNER_EQUITY_ATTENTION',
      note: 'Advisory, not statutory: drawings exceed capital introduced plus accumulated profits. No tax charge arises (unlike an overdrawn DLA), but the pattern is the leading solvency signal on an unincorporated book.'
    });
  }
  return { overdrawn, equityBalance, currency, watches };
};
