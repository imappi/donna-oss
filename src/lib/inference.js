import { HOLD_REASON_FRIENDLY } from './constants.js';

// Consolidates the 17+ separate infer* functions from the old monolith into one
// unified triage function. The bookkeeper sees a plain-English summary, not
// internal classification codes.

const text = (item) =>
  `${item.problem_summary || ''} ${item.user_stuck_on || ''} ${
    item.conversation?.map((e) => e.text).join(' ') || ''
  }`.toLowerCase();

const amount = (item) => {
  const combined = `${item.problem_summary} ${item.user_stuck_on} ${
    item.conversation?.map((e) => e.text).join(' ') || ''
  }`;
  const m = combined.match(/\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

export const inferHoldReason = (item) => {
  if (item.hold_reason && HOLD_REASON_FRIENDLY[item.hold_reason]) return item.hold_reason;
  if (item.trigger_id === 'missing_document') return 'missing_document';
  const t = text(item);
  if (t.includes('duplicate')) return 'possible_duplicate';
  if (t.includes('vendor')) return 'new_vendor';
  if (t.includes('hold') || t.includes('payout') || t.includes('deposit')) return 'platform_deposit';
  return 'confidence_low';
};

export const getQueueAgeBucket = (createdAt) => {
  const hours = (Date.now() - createdAt) / 3600000;
  if (hours > 72) return '>72h';
  if (hours > 48) return '>48h';
  if (hours >= 24) return '24-48h';
  return '<24h';
};

// Returns a single triage object with bookkeeper-friendly language.
export const triageCase = (item) => {
  const t = text(item);
  const holdReasonCode = inferHoldReason(item);
  const ageBucket = getQueueAgeBucket(item.created_at);
  const isOld = ageBucket === '>72h' || ageBucket === '>48h';
  const isEscalated = item.escalation_flag || item.confidence === 'low' || isOld;

  // Detect category
  let category = 'general';
  let summary = HOLD_REASON_FRIENDLY[holdReasonCode]?.reason || 'Needs your review.';
  let suggestedAction = HOLD_REASON_FRIENDLY[holdReasonCode]?.action || '';
  let risk = isEscalated ? 'high' : item.confidence === 'high' ? 'low' : 'medium';

  if (t.includes('categor') || t.includes('should be') || t.includes('wrong')) {
    category = 'categorisation';
    summary = 'The customer disagrees with how a transaction was categorised.';
    suggestedAction = 'Check the business purpose and recategorise if needed.';
  } else if (t.includes('reconcil') || t.includes("won't balance") || t.includes('does not match')) {
    category = 'reconciliation';
    const amt = amount(item);
    summary = amt
      ? `Reconciliation is off by $${amt.toLocaleString()}. Likely timing or missing transactions.`
      : 'Bank and book balances do not match.';
    suggestedAction = 'Trace the difference to specific transactions and resolve.';
  } else if (t.includes('duplicate') || t.includes('entered twice') || t.includes('same charge twice')) {
    category = 'duplicate';
    summary = 'A transaction may have been recorded twice.';
    suggestedAction = 'Confirm which record is correct and remove the duplicate.';
  } else if (t.includes('missing') || t.includes('not in books') || t.includes('not showing')) {
    category = 'missing-transaction';
    summary = 'A transaction is in the bank but not in the books (or vice versa).';
    suggestedAction = 'Check sync status and add or recover the transaction.';
  } else if (t.includes('fraud') || t.includes('unauthorized') || t.includes("didn't authorize")) {
    category = 'fraud';
    summary = 'Customer reports an unauthorised transaction.';
    suggestedAction = 'Direct customer to contact their bank immediately.';
    risk = 'high';
  } else if (t.includes('sync') || t.includes('integration') || t.includes('bank feed')) {
    category = 'integration';
    summary = 'Bank feed or integration sync issue reported.';
    suggestedAction = 'Check connection health and sync status.';
  } else if (t.includes('opening balance')) {
    category = 'opening-balance';
    summary = 'Persistent difference likely caused by incorrect opening balance.';
    suggestedAction = 'Validate opening balance against the first bank statement.';
    risk = 'high';
  } else if (t.includes('owner') || t.includes('personal') || t.includes('draw')) {
    category = 'owner-transaction';
    summary = 'Owner/personal transaction mixed with business funds.';
    suggestedAction = 'Classify as draw, contribution, or reimbursement.';
  } else if (t.includes('prepay') || t.includes('deposit') || t.includes('retainer')) {
    category = 'prepayment';
    summary = 'Prepayment or deposit timing question.';
    suggestedAction = 'Check accounting method and apply correct recognition timing.';
  } else if (t.includes('chargeback') || t.includes('refund') || t.includes('reversal')) {
    category = 'reversal';
    summary = 'Refund, chargeback, or reversal needs to be linked to the original transaction.';
    suggestedAction = 'Find the original transaction and link the reversal.';
  } else if (t.includes('payroll') || t.includes('salary') || t.includes('contractor') || t.includes('1099')) {
    category = 'payroll';
    summary = 'Payroll or worker classification question.';
    suggestedAction = 'Route for specialist review — do not give tax/legal advice.';
    risk = 'high';
  } else if (t.includes('period') || t.includes('close') || t.includes('cutoff')) {
    category = 'period-close';
    summary = 'Period-close or cutoff timing question.';
    suggestedAction = 'Verify close status and route period adjustments for review.';
  }

  return {
    category,
    holdReasonCode,
    ageBucket,
    risk,
    needsEscalation: isEscalated,
    summary,
    suggestedAction
  };
};
