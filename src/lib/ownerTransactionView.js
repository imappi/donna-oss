// View model for the persisted owner-transaction verdict
// (payload.ai_suggestion.owner_transaction, written by the row-3 coding-lane
// mount). Render-the-persisted-verdict rail: this reads ONLY what the
// pipeline persisted — no re-derivation, no second opinion. Returns null when
// no verdict exists (unstamped client, ordinary third-party line, or the
// pre-mount suggestion shape), so every surface stays byte-identical for
// those.
//
// Labels mirror the closed spec tables' name_en in
// server/donna/gb/ownerTransactionTaxonomy.js — a display map for a CLOSED
// enum, not a vocabulary of its own. An unknown type renders its raw enum
// value rather than being hidden: a persisted verdict this map cannot label
// is a drift to surface, not to swallow.
const TYPE_LABELS = {
  director_salary: ['transaction.owner.type.directorSalary', "Director's salary"],
  expense_reimbursement: ['transaction.owner.type.expenseReimbursement', 'Expense reimbursement'],
  mileage_reimbursement: ['transaction.owner.type.mileageReimbursement', 'Mileage reimbursement'],
  dividend: ['transaction.owner.type.dividend', 'Dividend'],
  directors_loan_advance: ['transaction.owner.type.loanAdvance', "Director's loan — advance to director"],
  directors_loan_from_director: ['transaction.owner.type.loanFromDirector', "Director's loan — from director"],
  directors_loan_repayment_by_director: ['transaction.owner.type.loanRepaidByDirector', "Director's loan — repayment by director"],
  loan_repayment_to_director: ['transaction.owner.type.loanRepaymentToDirector', 'Loan repayment to director'],
  interest_to_director: ['transaction.owner.type.interestToDirector', 'Interest to director'],
  share_subscription: ['transaction.owner.type.shareSubscription', 'Share subscription'],
  capital_reduction_return: ['transaction.owner.type.capitalReduction', 'Capital reduction return'],
  related_party_purchase: ['transaction.owner.type.relatedPurchase', 'Related-party purchase'],
  related_party_sale: ['transaction.owner.type.relatedSale', 'Related-party sale'],
  owner_drawings: ['transaction.owner.type.drawings', 'Owner drawings'],
  owner_capital_introduced: ['transaction.owner.type.capitalIntroduced', 'Owner capital introduced'],
  business_expense_paid_personally: ['transaction.owner.type.businessExpensePersonal', 'Business expense paid personally'],
  mileage_claim: ['transaction.owner.type.mileageClaim', 'Mileage claim (simplified expenses)'],
  goods_own_use: ['transaction.owner.type.goodsOwnUse', 'Goods taken for own use'],
  unknown_owner_transfer: ['transaction.owner.type.unknown', 'Unidentified owner transfer']
};

export const buildOwnerTransactionView = (tx, formatMessage = null) => {
  const suggestion = tx?.payload?.ai_suggestion || tx?.ai_suggestion || null;
  const verdict = suggestion?.owner_transaction;
  if (!verdict || typeof verdict !== 'object' || !verdict.type) return null;
  const escalated = verdict.terminal === 'escalate';
  const knownType = TYPE_LABELS[verdict.type];
  return {
    typeLabel: knownType
      ? (typeof formatMessage === 'function'
          ? formatMessage({ id: knownType[0], defaultMessage: knownType[1] })
          : knownType[1])
      : String(verdict.type),
    terminal: escalated ? 'escalate' : 'proposal',
    reasonCode: escalated ? String(verdict.reason || 'owner_transfer_requires_review') : null,
    missingEvidence: escalated && Array.isArray(verdict.missing_evidence)
      ? verdict.missing_evidence.map((kind) => String(kind).replace(/_/g, ' '))
      : [],
    question: escalated ? String(verdict.question_en || '') : '',
    suggestedAccounts: !escalated && verdict.suggested_accounts
      && verdict.suggested_accounts.debit && verdict.suggested_accounts.credit
      ? { debit: String(verdict.suggested_accounts.debit), credit: String(verdict.suggested_accounts.credit) }
      : null
  };
};
