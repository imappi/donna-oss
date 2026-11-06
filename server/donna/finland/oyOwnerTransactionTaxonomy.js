// FI-13 slice 13.2 — the CLOSED owner↔company transaction taxonomy for an
// osakeyhtiö (D-FI13-9 v2). Pure DATA + pure classification. No I/O, no ledger
// touch. This module is a KEEP-layer classifier that names the ONLY kinds of
// money movement that can pass between an Oy and its shareholder(s), and — for
// each — states the evidence required and whether Donna may PROPOSE a posting or
// must ESCALATE to a named human. It never posts: a proposal still passes through
// the accounting-aware ledger writer's invariants (INV-1 — the grammar is a
// router, never a second accounting backend).
//
// Doctrine (CLAUDE.md):
//   • Two-terminal-states (FIRST principle). Every owner transfer ends in exactly
//     one of two states: a PROPOSAL ready to post (confident + evidenced) or an
//     OWNER/REVIEWER escalation (unsure). There is no third state — nothing rests
//     at "suggested, waiting for a firm click".
//   • unknown_owner_transfer NEVER auto-posts. An owner transfer could be a
//     reimbursement, salary, benefit, unlawful distribution, hidden dividend, or a
//     loan — the safe state is UNRESOLVED on a named reviewer, never a guess
//     (D-FI13-9).
//   • Donna never infers "salary" from a bank transfer (D-FI13-16). Owner salary
//     requires an external payroll package; without it, a transfer that looks like
//     pay escalates, it does not post.
//   • The catalog is CLOSED (the closed-action-type-enum discipline the whole
//     admin chat rests on). A movement that matches no type is unknown_owner_transfer,
//     not a new silent category.
//
// OPEN DECISIONS this module encodes conservatively (they gate auto-posting until
// Kari records a dated call — docs/design-donna-finland-fi13-osakeyhtio.md §4):
//   • D-FI13-D1 owner salary (rec A, books-only payroll) — salary stays escalate.
//   • D-FI13-D2 dividends (rec B, detect-and-escalate) — dividend stays escalate.
// Flipping either to auto-postable is a code change gated on the dated decision;
// the spec row carries `gated_decision` so the wiring is one edit when it lands.
//
// Design: docs/design-donna-finland-fi13-osakeyhtio.md (D-FI13-9, D-FI13-16,
// D-FI13-18, §4 open decisions).

// The CLOSED catalog — exactly these owner↔company transaction types exist. The
// design (D-FI13-9 v2) enumerates these fifteen; a sixteenth is NOT defined
// (the handoff's "16-type" label is a miscount — the authoritative list is here
// and in the design). Adding a type is a deliberate design change, never an
// ad-hoc string at a call site.
export const OY_OWNER_TRANSACTION_TYPES = Object.freeze([
  'salary',
  'expense_reimbursement',
  'travel_reimbursement',
  'dividend',
  'capital_contribution',
  'share_subscription',
  'svop_contribution',
  'shareholder_loan_to_owner',
  'shareholder_loan_to_company',
  'loan_repayment',
  'interest',
  'return_of_capital',
  'related_party_purchase',
  'related_party_sale',
  'unknown_owner_transfer'
]);

// Direction of the money movement, for the escalation copy and the watches.
//   company_to_owner — the Oy pays the shareholder (salary, reimbursement, dividend, loan out, return of capital, a purchase from the owner)
//   owner_to_company — the shareholder pays the Oy (capital/SVOP contribution, share subscription, loan in, a sale to the owner)
//   either           — direction does not disambiguate (interest, loan repayment, unknown)
export const OY_OWNER_TRANSACTION_SPECS = Object.freeze({
  salary: {
    type: 'salary', direction: 'company_to_owner',
    name_fi: 'Palkka', name_en: 'Owner salary',
    // D-FI13-16: salary is a payroll DATA CONTRACT, never inferred from a transfer.
    required_evidence: ['payroll_package'],
    suggested_accounts: { debit: '5000', credit: '1910' },
    auto_postable: false,
    escalation_reason: 'owner_salary_requires_payroll_package',
    gated_decision: 'D-FI13-D1'
  },
  expense_reimbursement: {
    type: 'expense_reimbursement', direction: 'company_to_owner',
    name_fi: 'Kulukorvaus', name_en: 'Expense reimbursement',
    required_evidence: ['expense_receipt'],
    suggested_accounts: { debit: '7800', credit: '2766' },
    auto_postable: true
  },
  travel_reimbursement: {
    type: 'travel_reimbursement', direction: 'company_to_owner',
    name_fi: 'Matkakulukorvaus', name_en: 'Travel reimbursement',
    // Kilometrikorvaus / päiväraha need a travel claim (mileageAndPerDiem.js is the
    // computation surface); a bare transfer is not evidence of a tax-free allowance.
    required_evidence: ['travel_claim'],
    suggested_accounts: { debit: '7300', credit: '2766' },
    auto_postable: true
  },
  dividend: {
    type: 'dividend', direction: 'company_to_owner',
    name_fi: 'Osinko', name_en: 'Dividend',
    // D-FI13-D2 rec B (detect-and-escalate): a dividend needs a distribution
    // decision, distributable unrestricted equity, the latest confirmed FS, and a
    // documented solvency assessment (OYL). Donna DETECTS and escalates; it does
    // not post until the dated decision lands.
    required_evidence: ['distribution_decision', 'confirmed_financial_statements', 'solvency_assessment'],
    suggested_accounts: { debit: '2251', credit: '2764' },
    auto_postable: false,
    escalation_reason: 'dividend_detect_and_escalate',
    gated_decision: 'D-FI13-D2'
  },
  capital_contribution: {
    type: 'capital_contribution', direction: 'owner_to_company',
    name_fi: 'Pääomansijoitus', name_en: 'Capital contribution',
    required_evidence: ['contribution_document'],
    suggested_accounts: { debit: '1910', credit: '2110' },
    auto_postable: true
  },
  share_subscription: {
    type: 'share_subscription', direction: 'owner_to_company',
    name_fi: 'Osakemerkintä', name_en: 'Share subscription',
    // Share capital moves only against a registered subscription/PRH filing.
    required_evidence: ['subscription_document'],
    suggested_accounts: { debit: '1910', credit: '2000' },
    auto_postable: false,
    escalation_reason: 'share_capital_change_requires_registration'
  },
  svop_contribution: {
    type: 'svop_contribution', direction: 'owner_to_company',
    name_fi: 'SVOP-sijoitus', name_en: 'SVOP contribution',
    required_evidence: ['contribution_document'],
    suggested_accounts: { debit: '1910', credit: '2110' },
    auto_postable: true
  },
  shareholder_loan_to_owner: {
    type: 'shareholder_loan_to_owner', direction: 'company_to_owner',
    name_fi: 'Laina osakkaalle (osakaslaina)', name_en: 'Loan to shareholder',
    // D-FI13-18: a debit balance on the shareholder is a dual-clock watch, not a
    // tax conclusion. Booking the loan itself needs a loan agreement; the tax
    // treatment stays reviewer-resolved.
    required_evidence: ['loan_agreement'],
    suggested_accounts: { debit: '1760', credit: '1910' },
    auto_postable: false,
    escalation_reason: 'shareholder_loan_out_requires_review'
  },
  shareholder_loan_to_company: {
    type: 'shareholder_loan_to_company', direction: 'owner_to_company',
    name_fi: 'Laina osakkaalta', name_en: 'Loan from shareholder',
    required_evidence: ['loan_agreement'],
    suggested_accounts: { debit: '1910', credit: '2762' },
    auto_postable: true
  },
  loan_repayment: {
    type: 'loan_repayment', direction: 'either',
    name_fi: 'Lainan takaisinmaksu', name_en: 'Loan repayment',
    // Which loan (to or from the owner) it repays determines the accounts, so a
    // repayment always names its principal.
    required_evidence: ['loan_reference'],
    suggested_accounts: null,
    auto_postable: false,
    escalation_reason: 'loan_repayment_needs_principal_reference'
  },
  interest: {
    type: 'interest', direction: 'either',
    name_fi: 'Korko', name_en: 'Interest',
    required_evidence: ['interest_basis'],
    suggested_accounts: null,
    auto_postable: false,
    escalation_reason: 'related_party_interest_requires_review'
  },
  return_of_capital: {
    type: 'return_of_capital', direction: 'company_to_owner',
    name_fi: 'Pääoman palautus', name_en: 'Return of capital',
    // A SVOP / equity return is a distribution decision like a dividend — evidenced
    // and reviewer-resolved, never auto-posted.
    required_evidence: ['distribution_decision', 'confirmed_financial_statements'],
    suggested_accounts: { debit: '2110', credit: '1910' },
    auto_postable: false,
    escalation_reason: 'return_of_capital_requires_decision'
  },
  related_party_purchase: {
    type: 'related_party_purchase', direction: 'company_to_owner',
    name_fi: 'Lähipiiriosto', name_en: 'Related-party purchase',
    // The Oy buys from the owner. Needs an invoice/contract; arm's-length pricing
    // is a related-party judgment surfaced for review.
    required_evidence: ['related_party_invoice'],
    suggested_accounts: { debit: '7800', credit: '1910' },
    auto_postable: false,
    escalation_reason: 'related_party_pricing_requires_review'
  },
  related_party_sale: {
    type: 'related_party_sale', direction: 'owner_to_company',
    name_fi: 'Lähipiirimyynti', name_en: 'Related-party sale',
    required_evidence: ['related_party_invoice'],
    suggested_accounts: { debit: '1910', credit: '3000' },
    auto_postable: false,
    escalation_reason: 'related_party_pricing_requires_review'
  },
  unknown_owner_transfer: {
    type: 'unknown_owner_transfer', direction: 'either',
    name_fi: 'Tunnistamaton osakastapahtuma', name_en: 'Unidentified owner transfer',
    // The safe state. NEVER auto-posts — rests unresolved on a named reviewer.
    required_evidence: [],
    suggested_accounts: null,
    auto_postable: false,
    escalation_reason: 'owner_transfer_unresolved'
  }
});

// isOwnerTransactionType(value) — is this a member of the closed catalog?
export const isOwnerTransactionType = (value) =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(OY_OWNER_TRANSACTION_SPECS, value);

// resolveOwnerTransactionSpec(type) — the spec for a type, or the
// unknown_owner_transfer spec for anything not in the catalog (fail-safe: an
// unrecognised classification collapses to the never-auto-post terminal, never
// throws, never invents a category).
export const resolveOwnerTransactionSpec = (type) =>
  OY_OWNER_TRANSACTION_SPECS[type] || OY_OWNER_TRANSACTION_SPECS.unknown_owner_transfer;

// classifyOwnerTransaction({ type, evidence }) — the two-terminal-states verdict.
//
//   type      — the classified owner-transaction type (from the strong model or a
//               reviewer). Anything outside the catalog is treated as
//               unknown_owner_transfer.
//   evidence  — an array of evidence-kind strings present for this transfer (e.g.
//               ['expense_receipt']), OR an object whose truthy keys are the kinds.
//
// Returns exactly one of:
//   { terminal: 'proposal',  type, spec, suggested_accounts, missing_evidence: [] }
//   { terminal: 'escalate',  type, spec, reason, missing_evidence, question_fi, question_en }
//
// A type is PROPOSAL-able only when its spec is auto_postable AND every required
// evidence kind is present. Everything else escalates — including every gated
// (D1/D2) type, every registration/decision-bound type, and unknown_owner_transfer
// unconditionally. Pure; never throws.
export const classifyOwnerTransaction = ({ type, evidence = [] } = {}) => {
  const resolvedType = isOwnerTransactionType(type) ? type : 'unknown_owner_transfer';
  const spec = OY_OWNER_TRANSACTION_SPECS[resolvedType];

  const present = new Set(
    Array.isArray(evidence)
      ? evidence.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim())
      : evidence && typeof evidence === 'object'
        ? Object.keys(evidence).filter((k) => evidence[k])
        : []
  );
  const missing = (spec.required_evidence || []).filter((k) => !present.has(k));

  if (spec.auto_postable && missing.length === 0) {
    return {
      terminal: 'proposal',
      type: resolvedType,
      spec,
      suggested_accounts: spec.suggested_accounts,
      missing_evidence: []
    };
  }

  const reason = missing.length
    ? 'missing_required_evidence'
    : spec.escalation_reason || 'owner_transfer_requires_review';
  return {
    terminal: 'escalate',
    type: resolvedType,
    spec,
    reason,
    missing_evidence: missing,
    question_fi: buildOwnerTransactionQuestion(spec, missing, 'fi'),
    question_en: buildOwnerTransactionQuestion(spec, missing, 'en')
  };
};

const buildOwnerTransactionQuestion = (spec, missing, lang) => {
  if (spec.type === 'unknown_owner_transfer') {
    return lang === 'fi'
      ? 'Osakkaan ja yhtiön välinen tapahtuma jää tunnistamatta. Mistä on kyse (palkka, kulukorvaus, osinko, laina, pääomansijoitus…)? En kirjaa sitä ennen kuin se on selvitetty.'
      : "This transfer between the company and its shareholder isn't identified. What is it (salary, reimbursement, dividend, loan, capital contribution…)? I won't post it until it's resolved.";
  }
  const label = lang === 'fi' ? spec.name_fi : spec.name_en;
  if (missing.length) {
    const kinds = missing.join(', ');
    return lang === 'fi'
      ? `Tapahtuma näyttää olevan “${label}”, mutta tarvitsen tositteet ennen kirjausta: ${kinds}.`
      : `This looks like “${label}”, but I need supporting evidence before posting: ${kinds}.`;
  }
  return lang === 'fi'
    ? `Tapahtuma “${label}” vaatii tarkastuksen ennen kirjausta.`
    : `A “${label}” transaction needs review before posting.`;
};
