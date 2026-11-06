const toNumber = (value) => Math.round(Number(value || 0) * 100) / 100;

const lineTotals = (lines = []) => ({
  debit: toNumber(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0)),
  credit: toNumber(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0))
});

const mirrorIdFor = (transaction = {}) =>
  transaction.xero_bank_transaction_id ||
  transaction.xeroBankTransactionId ||
  transaction.payload?.xero_bank_transaction_id ||
  null;

const mirrorErrorFor = (transaction = {}) =>
  transaction.xero_writeback_error ||
  transaction.xero_sync_error ||
  transaction.xero_error ||
  transaction.payload?.xero_writeback_error ||
  null;

const mirrorStatusFor = (transaction = {}) => {
  if (!transaction?.id) return 'not_applicable';
  if (mirrorErrorFor(transaction)) return 'mirror_error';
  if (mirrorIdFor(transaction)) return 'mirror_exported';
  if (transaction.ledger_journal_id || transaction.ledger_status === 'posted' || transaction.review_state === 'posted') {
    return 'mirror_pending';
  }
  return 'not_ready_for_mirror';
};

export const buildLedgerAuditTrail = ({
  clientId,
  periodStart = null,
  periodEnd = null,
  transaction = null,
  transactions = [],
  reviewItem = null,
  ledgerJournals = [],
  ledgerLines = [],
  auditEvents = []
} = {}) => {
  const linesByJournal = new Map();
  for (const line of ledgerLines) {
    const journalId = line.journal_id;
    if (!journalId) continue;
    if (!linesByJournal.has(journalId)) linesByJournal.set(journalId, []);
    linesByJournal.get(journalId).push(line);
  }

  const journals = ledgerJournals.map((journal) => {
    const lines = (linesByJournal.get(journal.id) || []).sort((a, b) => Number(a.line_no || 0) - Number(b.line_no || 0));
    const totals = lineTotals(lines);
    return {
      ...journal,
      lines,
      line_count: lines.length,
      totals: {
        ...totals,
        balanced: Math.abs(totals.debit - totals.credit) < 0.01
      }
    };
  });

  const primaryJournals = journals.filter((journal) => !journal.correction_type);
  const correctionJournals = journals.filter((journal) => Boolean(journal.correction_type));
  const journalIds = new Set(journals.map((journal) => journal.id));
  const correctionHistory = correctionJournals.map((journal) => ({
    journal_id: journal.id,
    correction_type: journal.correction_type,
    correction_of_journal_id: journal.correction_of_journal_id,
    reversal_of_journal_id: journal.reversal_of_journal_id,
    correction_reason: journal.correction_reason,
    journal_date: journal.journal_date,
    posted_at: journal.posted_at,
    line_count: journal.line_count,
    totals: journal.totals
  }));
  const totalLines = journals.reduce((sum, journal) => sum + journal.line_count, 0);
  const ledgerStatus = !journals.length
    ? 'unposted'
    : correctionJournals.length
      ? 'corrected'
      : journals.every((journal) => journal.status === 'closed')
        ? 'closed'
        : 'posted';

  return {
    source: 'ledger_audit_trail',
    generated_at: new Date().toISOString(),
    client_id: clientId,
    period_start: periodStart,
    period_end: periodEnd,
    transaction_id: transaction?.id || null,
    scope: transaction?.id ? 'transaction' : 'period',
    source_transaction: transaction,
    period_transactions: transaction?.id ? [] : transactions,
    review_item: reviewItem,
    native_ledger: {
      source_of_truth: true,
      status: ledgerStatus,
      journal_count: journals.length,
      primary_journal_count: primaryJournals.length,
      correction_journal_count: correctionJournals.length,
      line_count: totalLines,
      posted_at: journals.map((journal) => journal.posted_at).filter(Boolean).sort()[0] || null,
      closed_at: journals.map((journal) => journal.closed_at).filter(Boolean).sort().at(-1) || null,
      journals,
      correction_history: correctionHistory,
      immutable_note: 'Posted Donna ledger rows are corrected with reversal/replacement journals, not edited in place.'
    },
    xero_mirror: {
      source_of_truth: false,
      status: mirrorStatusFor(transaction || {}),
      xero_bank_transaction_id: mirrorIdFor(transaction || {}),
      error: mirrorErrorFor(transaction || {}),
      note: 'Xero is mirror/output evidence only. Donna ledger data is the source of accounting truth.'
    },
    audit_events: auditEvents.filter((event) => {
      if (!event) return false;
      if (transaction?.id && event.resource_id === transaction.id) return true;
      if (event.resource_id && journalIds.has(event.resource_id)) return true;
      return true;
    })
  };
};
