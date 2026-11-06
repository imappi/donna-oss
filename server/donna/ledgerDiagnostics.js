import { ledgerDateOnly } from './ledger.js';
import { normalizeLedgerPeriod } from './ledgerReadModel.js';
import { buildSourceImportCompleteness } from './sourceImportCompleteness.js';

export { buildSourceImportCompleteness } from './sourceImportCompleteness.js';

const numberValue = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const roundedMoney = (value) => Math.round(numberValue(value) * 100) / 100;

const amountFor = (transaction = {}) => roundedMoney(transaction.money_in || transaction.money_out || transaction.amount || 0);

const dateFor = (item = {}) => ledgerDateOnly(item.date || item.transaction_date || item.document_date || item.uploaded_at || item.created_at);

const isLedgerPosted = (transaction = {}) =>
  Boolean(
    transaction.ledger_journal_id ||
      transaction.ledger_status === 'posted' ||
      transaction.ledger_status === 'closed' ||
      transaction.review_state === 'posted' ||
      transaction.review_state === 'closed'
  );

const isXeroExported = (transaction = {}) =>
  Boolean(
    transaction.xero_bank_transaction_id ||
      transaction.xero_sync_status === 'synced' ||
      transaction.xero_writeback_status === 'synced' ||
      transaction.xero_synced_at ||
      transaction.synced_at
  );

const hasXeroError = (transaction = {}) =>
  Boolean(transaction.xero_writeback_error || transaction.xero_sync_error || transaction.xero_error);

const accountCodeFor = (transaction = {}) =>
  String(transaction.account_code || transaction.xero_account_code || transaction.proposed_account || '').trim();

const xeroAccountCodeFor = (transaction = {}) =>
  String(transaction.xero_account_code || transaction.payload?.xero_account_code || '').trim();

const REVIEW_STATE_ALIASES = new Map([
  ['asked client', 'asked_client'],
  ['asked-client', 'asked_client'],
  ['ask_client', 'asked_client'],
  ['client_asked', 'asked_client'],
  ['client_requested', 'asked_client'],
  ['needs_client', 'waiting'],
  ['waiting_client', 'waiting'],
  ['waiting_for_client', 'waiting'],
  ['posted_to_ledger', 'posted'],
  ['ledger_posted', 'posted']
]);

const normalizeReviewState = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return REVIEW_STATE_ALIASES.get(normalized) || normalized;
};

const transactionIdFromReview = (review = {}) =>
  review.transaction_id || review.transactionId || review.item_id || review.payload?.transaction_id || review.payload?.transactionId || '';

const latestReviewByTransactionId = (reviewItems = []) => {
  const byId = new Map();
  for (const review of reviewItems) {
    const transactionId = transactionIdFromReview(review);
    if (transactionId && !byId.has(transactionId)) byId.set(transactionId, review);
  }
  return byId;
};

const latestEvidenceRequestByTransactionId = (requests = []) => {
  const byId = new Map();
  for (const request of requests) {
    const transactionId = request.transaction_id || request.request_payload?.transaction_id || '';
    if (!transactionId) continue;
    if (!byId.has(transactionId)) byId.set(transactionId, request);
  }
  return byId;
};

const reviewStateFor = ({ transaction = {}, review = {} } = {}) =>
  normalizeReviewState(
    review.review_state ||
      review.reviewState ||
      review.payload?.review_state ||
      review.payload?.reviewState ||
      transaction.review_state ||
      transaction.reviewState ||
      transaction.payload?.review_state ||
      transaction.payload?.reviewState ||
      transaction.status
  );

const mirrorIssueFor = (transaction = {}) => {
  if (hasXeroError(transaction)) return 'error';
  if (isLedgerPosted(transaction) && !isXeroExported(transaction)) return 'missing_in_xero';
  if (!isLedgerPosted(transaction) && isXeroExported(transaction)) return 'exported_before_ledger';
  if (!isLedgerPosted(transaction)) return 'not_posted';

  const ledgerAccount = accountCodeFor(transaction);
  const xeroAccount = xeroAccountCodeFor(transaction);
  if (ledgerAccount && xeroAccount && ledgerAccount !== xeroAccount) return 'account_drift';
  const ledgerAmount = roundedMoney(transaction.ledger_amount || amountFor(transaction));
  const xeroAmount = roundedMoney(transaction.xero_amount || transaction.xero_total || ledgerAmount);
  if (Math.abs(ledgerAmount - xeroAmount) >= 0.01) return 'amount_drift';
  return 'exported';
};

export const buildXeroMirrorDiff = ({
  clientId,
  periodStart,
  periodEnd,
  transactions = []
} = {}) => {
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const rows = transactions
    .filter((transaction) => {
      const date = dateFor(transaction);
      return transaction.client_id === clientId && date >= period.period_start && date <= period.period_end;
    })
    .map((transaction) => {
      const issue = mirrorIssueFor(transaction);
      return {
        transaction_id: transaction.id,
        date: dateFor(transaction),
        description: transaction.description || '',
        amount: amountFor(transaction),
        currency: transaction.account_currency || transaction.currency || transaction.ledger_currency || null,
        ledger_status: isLedgerPosted(transaction) ? 'posted' : 'pending',
        xero_status: hasXeroError(transaction) ? 'error' : isXeroExported(transaction) ? 'exported' : 'pending',
        issue,
        ledger_journal_id: transaction.ledger_journal_id || null,
        xero_bank_transaction_id: transaction.xero_bank_transaction_id || null,
        ledger_account_code: accountCodeFor(transaction) || null,
        xero_account_code: xeroAccountCodeFor(transaction) || null,
        error: transaction.xero_writeback_error || transaction.xero_sync_error || transaction.xero_error || null
      };
    });
  const counts = rows.reduce(
    (summary, row) => {
      summary.total += 1;
      summary[row.issue] = (summary[row.issue] || 0) + 1;
      return summary;
    },
    {
      total: 0,
      exported: 0,
      missing_in_xero: 0,
      exported_before_ledger: 0,
      not_posted: 0,
      account_drift: 0,
      amount_drift: 0,
      error: 0
    }
  );
  const status = counts.error || counts.account_drift || counts.amount_drift
    ? 'warning'
    : counts.missing_in_xero || counts.exported_before_ledger
      ? 'warning'
      : counts.not_posted
        ? 'pending'
        : 'passed';
  return {
    status,
    period_start: period.period_start,
    period_end: period.period_end,
    counts,
    rows,
    summary: status === 'passed'
      ? `${counts.exported}/${counts.total} period transaction${counts.total === 1 ? '' : 's'} exported to Xero mirror.`
      : `${counts.exported}/${counts.total} exported · ${counts.not_posted} not posted · ${counts.missing_in_xero} missing in Xero · ${counts.error} errors.`
  };
};

export const buildCloseDiagnostics = ({
  clientId,
  periodStart,
  periodEnd,
  documents = [],
  transactions = []
} = {}) => {
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const sourceImport = buildSourceImportCompleteness({
    clientId,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    documents,
    transactions
  });
  const xeroMirrorDiff = buildXeroMirrorDiff({
    clientId,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    transactions
  });
  const status = sourceImport.status === 'blocked'
    ? 'blocked'
    : sourceImport.status === 'warning' || xeroMirrorDiff.status === 'warning'
      ? 'warning'
      : xeroMirrorDiff.status === 'pending'
        ? 'pending'
        : 'passed';
  return {
    source: 'close_diagnostics',
    generated_at: new Date().toISOString(),
    client_id: clientId,
    period_start: period.period_start,
    period_end: period.period_end,
    status,
    source_import: sourceImport,
    xero_mirror_diff: xeroMirrorDiff
  };
};

const collectEvidenceDocumentIds = (...lists) => {
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const id = typeof value === 'string' ? value : value?.id;
      if (id) seen.add(id);
    }
  }
  return Array.from(seen);
};

const baseTransactionException = ({ transaction = {}, review = {}, evidenceRequest = null } = {}) => {
  const evidenceDocumentIds = collectEvidenceDocumentIds(
    evidenceRequest?.response_payload?.document_ids,
    evidenceRequest?.response_payload?.documents,
    review.payload?.evidence_document_ids,
    transaction.evidence_document_ids,
    transaction.payload?.evidence_document_ids
  );
  return {
    transaction_id: transaction.id,
    date: dateFor(transaction),
    description: transaction.description || '',
    amount: amountFor(transaction),
    currency: transaction.account_currency || transaction.currency || transaction.ledger_currency || null,
    review_state: reviewStateFor({ transaction, review }) || null,
    ledger_status: isLedgerPosted(transaction) ? 'posted' : 'pending',
    ledger_journal_id: transaction.ledger_journal_id || null,
    xero_bank_transaction_id: transaction.xero_bank_transaction_id || null,
    evidence_request_id: evidenceRequest?.id || review.payload?.evidence_request?.id || transaction.evidence_request?.id || null,
    evidence_request_status: evidenceRequest?.status || review.payload?.evidence_request?.status || transaction.evidence_request?.status || null,
    evidence_question: evidenceRequest?.question || review.payload?.client_question || transaction.client_question || null,
    evidence_due_at: evidenceRequest?.due_at || review.payload?.evidence_request?.due_at || transaction.evidence_request?.due_at || null,
    evidence_responded_at: evidenceRequest?.responded_at || transaction.payload?.evidence_responded_at || null,
    evidence_resolved_at: evidenceRequest?.resolved_at || transaction.payload?.evidence_resolved_at || null,
    evidence_document_ids: evidenceDocumentIds,
    evidence_document_count: evidenceDocumentIds.length
  };
};

const createException = ({
  type,
  severity = 'warning',
  source = 'close',
  id,
  summary,
  action = null,
  payload = {}
} = {}) => ({
  id: id || `${type}:${payload.transaction_id || payload.document_id || payload.group_key || payload.issue || 'period'}`,
  type,
  severity,
  source,
  summary,
  action,
  ...payload
});

const sourceImportExceptions = (sourceImport = {}) => {
  const exceptions = [];
  if (sourceImport.status && sourceImport.status !== 'passed') {
    exceptions.push(createException({
      type: 'source_import_warning',
      severity: sourceImport.status === 'blocked' ? 'blocker' : 'warning',
      source: 'source_import',
      summary: sourceImport.summary || 'Source import needs review before close.',
      action: 'Review source import diagnostics before locking the period.',
      payload: {
        status: sourceImport.status,
        bank_statement_count: sourceImport.bank_statement_count || 0,
        transaction_count: sourceImport.transaction_count || 0
      }
    }));
  }

  for (const document of sourceImport.bank_documents_without_rows || []) {
    exceptions.push(createException({
      type: 'orphan_missing_source_data',
      severity: 'blocker',
      source: 'source_import',
      id: `orphan_missing_source_data:document:${document.document_id}`,
      summary: `${document.filename || 'Bank statement'} has no imported period rows.`,
      action: 'Re-import or reconcile this statement before close.',
      payload: {
        document_id: document.document_id,
        filename: document.filename || null,
        document_status: document.status || null
      }
    }));
  }

  for (const transaction of sourceImport.transactions_without_document || []) {
    exceptions.push(createException({
      type: 'orphan_missing_source_data',
      severity: 'blocker',
      source: 'source_import',
      id: `orphan_missing_source_data:transaction:${transaction.transaction_id}`,
      summary: `${transaction.description || 'Transaction'} is missing source document linkage.`,
      action: 'Attach or confirm the source row for this transaction.',
      payload: transaction
    }));
  }

  for (const documentId of sourceImport.orphan_document_ids || []) {
    exceptions.push(createException({
      type: 'orphan_missing_source_data',
      severity: 'blocker',
      source: 'source_import',
      id: `orphan_missing_source_data:orphan-document:${documentId}`,
      summary: `Transaction rows reference missing source document ${documentId}.`,
      action: 'Restore the source document or remap the imported rows.',
      payload: { document_id: documentId }
    }));
  }

  for (const group of sourceImport.duplicate_groups || []) {
    exceptions.push(createException({
      type: 'duplicate_source_row',
      severity: 'blocker',
      source: 'source_import',
      id: `duplicate_source_row:${group.key}`,
      summary: `${group.count} duplicate source rows match ${group.description || group.date || 'this transaction'}.`,
      action: 'Remove the duplicate import or document why both rows are genuine before close.',
      payload: {
        group_key: group.key,
        transaction_ids: group.transaction_ids || [],
        duplicate_count: group.count,
        date: group.date,
        description: group.description || '',
        amount: group.amount,
        currency: group.currency || null
      }
    }));
  }

  for (const item of sourceImport.statement_proof?.issues || []) {
    exceptions.push(createException({
      type: 'source_import_warning',
      severity: item.severity === 'blocker' ? 'blocker' : 'warning',
      source: 'source_import',
      id: `source_import_warning:${item.document_id || 'period'}:${item.code}`,
      summary: item.summary || 'Statement proof needs review before close.',
      action: item.action || 'Review source import diagnostics before locking the period.',
      payload: {
        document_id: item.document_id || null,
        filename: item.filename || null,
        issue_code: item.code || null
      }
    }));
  }

  return exceptions;
};

const ledgerPostingExceptions = ({ transactions = [], reviewItems = [], clientEvidenceRequests = [], periodStart, periodEnd, clientId } = {}) => {
  const reviewsByTransactionId = latestReviewByTransactionId(reviewItems);
  const evidenceByTransactionId = latestEvidenceRequestByTransactionId(clientEvidenceRequests);
  return transactions
    .filter((transaction) => {
      const date = dateFor(transaction);
      return transaction.client_id === clientId && date >= periodStart && date <= periodEnd;
    })
    .filter((transaction) => !isLedgerPosted(transaction))
    .map((transaction) => {
      const review = reviewsByTransactionId.get(transaction.id) || {};
      const reviewState = reviewStateFor({ transaction, review });
      const evidenceRequest = evidenceByTransactionId.get(transaction.id) || null;
      const base = baseTransactionException({ transaction, review, evidenceRequest });
      if (reviewState === 'accepted') {
        return createException({
          type: 'accepted_not_posted',
          severity: 'blocker',
          source: 'native_ledger',
          summary: `${transaction.description || 'Transaction'} is accepted but not posted to the Donna ledger.`,
          action: 'Post the accepted transaction to the Donna ledger.',
          payload: base
        });
      }
      if (reviewState === 'waiting') {
        const clientReplied = evidenceRequest?.status === 'replied';
        return createException({
          type: 'waiting_for_client',
          severity: 'blocker',
          source: 'client_evidence',
          summary: clientReplied
            ? `${transaction.description || 'Transaction'} has client evidence ready for firm review.`
            : `${transaction.description || 'Transaction'} is waiting for client evidence.`,
          action: clientReplied
            ? 'Review and accept the client evidence before posting.'
            : 'Resolve the client evidence request before close.',
          payload: base
        });
      }
      if (reviewState === 'asked_client') {
        return createException({
          type: 'asked_client',
          severity: 'blocker',
          source: 'client_evidence',
          summary: `${transaction.description || 'Transaction'} has an open client question.`,
          action: 'Send or resolve the client question before close.',
          payload: base
        });
      }
      if (reviewState === 'held') {
        return createException({
          type: 'held_by_reviewer',
          severity: 'blocker',
          source: 'review',
          summary: `${transaction.description || 'Transaction'} is held by reviewer.`,
          action: 'Clear the reviewer hold or document the close exception.',
          payload: base
        });
      }
      return createException({
        type: 'unposted_transaction',
        severity: 'blocker',
        source: 'native_ledger',
        summary: `${transaction.description || 'Transaction'} is not posted to the Donna ledger.`,
        action: 'Accept and post this transaction before close.',
        payload: base
      });
    });
};

const xeroMirrorExceptions = (xeroMirrorDiff = {}) =>
  (xeroMirrorDiff.rows || [])
    .map((row) => {
      if (row.issue === 'error') {
        return createException({
          type: 'xero_mirror_error',
          severity: 'warning',
          source: 'xero_mirror',
          summary: `${row.description || 'Transaction'} has a Xero mirror export error.`,
          action: 'Retry mirror export after the Donna ledger row is correct.',
          payload: { ...row, mirror_issue: row.issue }
        });
      }
      if (row.issue === 'account_drift' || row.issue === 'amount_drift') {
        return createException({
          type: 'xero_mirror_drift',
          severity: 'warning',
          source: 'xero_mirror',
          summary: `${row.description || 'Transaction'} differs between Donna ledger and the Xero mirror.`,
          action: 'Repair the Xero mirror from Donna ledger truth.',
          payload: { ...row, mirror_issue: row.issue }
        });
      }
      if (row.issue === 'exported_before_ledger') {
        return createException({
          type: 'exported_before_ledger',
          severity: 'warning',
          source: 'xero_mirror',
          summary: `${row.description || 'Transaction'} was exported to Xero before Donna ledger posting.`,
          action: 'Post or reverse the Donna ledger row, then repair the mirror if needed.',
          payload: { ...row, mirror_issue: row.issue }
        });
      }
      if (row.issue === 'missing_in_xero') {
        return createException({
          type: 'xero_mirror_missing',
          severity: 'warning',
          source: 'xero_mirror',
          summary: `${row.description || 'Transaction'} is posted in Donna but missing from the Xero mirror.`,
          action: 'Retry mirror export from the posted Donna ledger row.',
          payload: { ...row, mirror_issue: row.issue }
        });
      }
      return null;
    })
    .filter(Boolean);

const exceptionPriority = (exception = {}) => {
  const severityRank = exception.severity === 'blocker' ? 0 : 1;
  const typeRank = {
    accepted_not_posted: 0,
    unposted_transaction: 1,
    waiting_for_client: 2,
    asked_client: 3,
    held_by_reviewer: 4,
    source_import_warning: 5,
    orphan_missing_source_data: 6,
    duplicate_source_row: 7,
    xero_mirror_error: 8,
    xero_mirror_drift: 9,
    xero_mirror_missing: 10,
    exported_before_ledger: 11
  }[exception.type] ?? 50;
  return [severityRank, typeRank, exception.date || '', exception.description || exception.summary || ''];
};

const buildExceptionCounts = (exceptions = []) => {
  const byType = {};
  const bySeverity = { blocker: 0, warning: 0 };
  for (const exception of exceptions) {
    byType[exception.type] = (byType[exception.type] || 0) + 1;
    bySeverity[exception.severity] = (bySeverity[exception.severity] || 0) + 1;
  }
  return {
    total: exceptions.length,
    blockers: bySeverity.blocker || 0,
    warnings: bySeverity.warning || 0,
    by_type: byType,
    by_severity: bySeverity
  };
};

export const buildCloseExceptions = ({
  clientId,
  periodStart,
  periodEnd,
  documents = [],
  transactions = [],
  transactionReviewQueue = [],
  clientEvidenceRequests = []
} = {}) => {
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const sourceImport = buildSourceImportCompleteness({
    clientId,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    documents,
    transactions
  });
  const xeroMirrorDiff = buildXeroMirrorDiff({
    clientId,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    transactions
  });
  const exceptions = [
    ...ledgerPostingExceptions({
      transactions,
      reviewItems: transactionReviewQueue,
      clientEvidenceRequests,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      clientId
    }),
    ...sourceImportExceptions(sourceImport),
    ...xeroMirrorExceptions(xeroMirrorDiff)
  ].sort((a, b) => {
    const left = exceptionPriority(a);
    const right = exceptionPriority(b);
    return String(left[0]).localeCompare(String(right[0]), undefined, { numeric: true }) ||
      String(left[1]).localeCompare(String(right[1]), undefined, { numeric: true }) ||
      String(left[2]).localeCompare(String(right[2])) ||
      String(left[3]).localeCompare(String(right[3]));
  });
  const counts = buildExceptionCounts(exceptions);
  return {
    source: 'close_exceptions',
    generated_at: new Date().toISOString(),
    client_id: clientId,
    period_start: period.period_start,
    period_end: period.period_end,
    status: counts.blockers > 0 ? 'blocked' : counts.warnings > 0 ? 'warning' : 'passed',
    counts,
    exceptions
  };
};
