// The Mentions-lane wording of a firm member's ledger adjustment question
// (a seat ask with evidence_type 'ledger_adjustment', minted by
// server/donna/documentSettlementReversal.js). Pure: it maps the stored
// request_payload.ledger_adjustment facts onto catalog messages
// (mounted.financial.ledgerAdjustmentAsk.*) and infers nothing; any other ask
// renders its stored question.

const REFUSAL_MESSAGE = Object.freeze({
  LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN: 'mounted.financial.ledgerAdjustmentAsk.restatesFiledReturn',
  LEDGER_ADJUSTMENT_DATE_IN_FILED_RETURN: 'mounted.financial.ledgerAdjustmentAsk.dateInFiledReturn'
});

const money = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '');
// A movement key is the return line it moves ('tax_code:ALV_25_5_INPUT'): its code is shown.
const movementText = (rows = []) => (Array.isArray(rows) ? rows : [])
  .map((row) => [String(row?.key || '').split(':').pop(), money(row?.amount), row?.currency || ''].filter(Boolean).join(' '))
  .filter(Boolean)
  .join(', ');

export const ledgerAdjustmentAskMessages = (ask = {}) => {
  const subject = ask?.ledger_adjustment;
  if (ask?.evidence_type !== 'ledger_adjustment' || !subject || subject.kind !== 'settlement_reversal') return null;
  const why = REFUSAL_MESSAGE[subject.refusal_code];
  if (!why) return null;
  const journal = subject.settlement_journal_id || '';
  return [
    // The entry is named by whose money it said paid (an older ask without
    // the fact was an owner-funds entry: the only kind there was).
    { id: subject.funding_source === 'company_cash'
      ? 'mounted.financial.ledgerAdjustmentAsk.settlementReversalCompanyCash'
      : 'mounted.financial.ledgerAdjustmentAsk.settlementReversal', values: {
      journal,
      document: subject.document_label || subject.document_id || '',
      amount: money(subject.amount),
      currency: subject.currency || '',
      date: subject.bank_line_date || '',
      transaction: subject.bank_line_description || subject.bank_transaction_id || ''
    } },
    { id: why, values: { period: subject.filed_return_period || subject.filed_return_id || '', detail: movementText(subject.tax_moved) } },
    { id: 'mounted.financial.ledgerAdjustmentAsk.todo', values: { journal } }
  ];
};
