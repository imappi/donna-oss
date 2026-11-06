import { ledgerDateOnly } from './ledger.js';
import { normalizeIntelText } from './transactionIntel.js';

const numberValue = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const numberOrNull = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const roundedMoney = (value) => Math.round(numberValue(value) * 100) / 100;
const moneyVariance = (left, right) => roundedMoney(numberValue(left) - numberValue(right));

const amountFor = (transaction = {}) => roundedMoney(transaction.money_in || transaction.money_out || transaction.amount || 0);

const normalizePeriod = ({ periodStart, periodEnd } = {}) => {
  const end = ledgerDateOnly(periodEnd || new Date());
  const start = ledgerDateOnly(periodStart || `${String(end || '').slice(0, 7)}-01`);
  if (!start || !end || start > end) {
    const error = new Error('A valid source import period_start and period_end are required.');
    error.statusCode = 400;
    error.code = 'SOURCE_IMPORT_INVALID_PERIOD';
    throw error;
  }
  return { period_start: start, period_end: end };
};

const dateFor = (item = {}) => ledgerDateOnly(item.date || item.transaction_date || item.document_date || item.uploaded_at || item.created_at);

const isBankStatementDocument = (document = {}) =>
  /bank_statement|statement/.test(normalizeIntelText(`${document.document_type || ''} ${document.type || ''} ${document.filename || ''}`));

const sourceKeyForTransaction = (transaction = {}) =>
  [
    dateFor(transaction),
    roundedMoney(transaction.money_in),
    roundedMoney(transaction.money_out),
    String(transaction.account_currency || transaction.currency || '').trim().toUpperCase(),
    normalizeIntelText(transaction.description || transaction.cleaned_description || transaction.raw_description || transaction.source_line || '')
  ].join('|');

const groupDuplicates = (transactions = []) => {
  const groups = new Map();
  for (const transaction of transactions) {
    const key = sourceKeyForTransaction(transaction);
    if (!key.replace(/\|/g, '')) continue;
    const current = groups.get(key) || [];
    current.push(transaction);
    groups.set(key, current);
  }
  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => ({
      key: sourceKeyForTransaction(group[0]),
      count: group.length,
      transaction_ids: group.map((transaction) => transaction.id),
      date: dateFor(group[0]),
      description: group[0].description || '',
      amount: amountFor(group[0]),
      currency: group[0].account_currency || group[0].currency || null
    }));
};

const arrayValue = (value) => (Array.isArray(value) ? value : []);

const summaryFor = (document = {}) =>
  document.statement_summary ||
  document.statementSummary ||
  document.payload?.statement_summary ||
  document.payload?.statementSummary ||
  null;

const extractionStatusFor = (document = {}) =>
  String(document.extraction_status || document.extractionStatus || document.payload?.extraction_status || document.payload?.extractionStatus || '').trim();

const extractionWarningsFor = (document = {}) =>
  [
    ...arrayValue(document.warnings),
    ...arrayValue(document.extraction_warnings),
    ...arrayValue(document.payload?.warnings),
    ...arrayValue(document.payload?.extraction_warnings)
  ].filter(Boolean);

const expectedRowCountFor = (document = {}) => {
  const direct = numberOrNull(
    document.expected_row_count ??
      document.expectedRowCount ??
      document.extracted_transaction_count ??
      document.extractedTransactionCount ??
      document.candidate_transaction_count ??
      document.candidateTransactionCount ??
      document.payload?.expected_row_count ??
      document.payload?.expectedRowCount ??
      document.payload?.extracted_transaction_count ??
      document.payload?.extractedTransactionCount ??
      document.payload?.candidate_transaction_count ??
      document.payload?.candidateTransactionCount
  );
  if (direct != null) return direct;
  const payloadTransactions = document.transactions || document.payload?.transactions;
  return Array.isArray(payloadTransactions) ? payloadTransactions.length : null;
};

const statementPeriodFor = (document = {}) => {
  const explicitStart = ledgerDateOnly(
    document.statement_period_start ||
      document.statementPeriodStart ||
      document.period_start ||
      document.periodStart ||
      document.payload?.statement_period_start ||
      document.payload?.statementPeriodStart ||
      document.payload?.period_start ||
      document.payload?.periodStart
  );
  const explicitEnd = ledgerDateOnly(
    document.statement_period_end ||
      document.statementPeriodEnd ||
      document.period_end ||
      document.periodEnd ||
      document.payload?.statement_period_end ||
      document.payload?.statementPeriodEnd ||
      document.payload?.period_end ||
      document.payload?.periodEnd
  );
  if (explicitStart && explicitEnd) return { period_start: explicitStart, period_end: explicitEnd };

  const label = String(document.period_label || document.periodLabel || document.payload?.period_label || document.payload?.periodLabel || '');
  const matches = [...label.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((match) => match[1]);
  if (matches.length >= 2) return { period_start: matches[0], period_end: matches[1] };
  return null;
};

const periodOverlaps = (left = {}, right = {}) =>
  Boolean(left.period_start && left.period_end && right.period_start && right.period_end && left.period_start <= right.period_end && left.period_end >= right.period_start);

const periodCovers = (statementPeriod = {}, closePeriod = {}) =>
  Boolean(
    statementPeriod.period_start &&
      statementPeriod.period_end &&
      closePeriod.period_start &&
      closePeriod.period_end &&
      statementPeriod.period_start <= closePeriod.period_start &&
      statementPeriod.period_end >= closePeriod.period_end
  );

const transactionMovementTotals = (transactions = []) =>
  transactions.reduce(
    (totals, transaction) => {
      totals.deposits = roundedMoney(totals.deposits + numberValue(transaction.money_in));
      totals.payouts = roundedMoney(totals.payouts + numberValue(transaction.money_out));
      return totals;
    },
    { deposits: 0, payouts: 0 }
  );

const fullStatementSummary = (summary = {}) =>
  summary &&
  summary.starting_balance != null &&
  summary.ending_balance != null &&
  summary.deposits != null &&
  summary.payouts != null;

const proof = ({ status = 'skipped', summary = '', payload = {} } = {}) => ({
  status,
  summary,
  ...payload
});

const issue = ({ code, severity = 'warning', summary, action = null } = {}) => ({
  code,
  severity,
  summary,
  action
});

const buildBalanceProof = (summary = {}) => {
  if (!fullStatementSummary(summary)) {
    return proof({
      status: 'skipped',
      summary: 'Statement summary is incomplete; balance trail could not be proven.'
    });
  }
  const expectedEnding = roundedMoney(numberValue(summary.starting_balance) + numberValue(summary.deposits) - numberValue(summary.payouts));
  const variance = moneyVariance(summary.ending_balance, expectedEnding);
  return proof({
    status: Math.abs(variance) <= 0.01 ? 'passed' : 'blocked',
    summary: Math.abs(variance) <= 0.01
      ? 'Opening balance plus statement movement equals closing balance.'
      : `Statement balance trail is off by ${variance.toFixed(2)}.`,
    payload: {
      opening_balance: roundedMoney(summary.starting_balance),
      deposits: roundedMoney(summary.deposits),
      payouts: roundedMoney(summary.payouts),
      expected_closing_balance: expectedEnding,
      closing_balance: roundedMoney(summary.ending_balance),
      variance
    }
  });
};

const buildMovementProof = ({ summary = {}, linkedTransactions = [], canCompare = false } = {}) => {
  if (summary?.deposits == null || summary?.payouts == null) {
    return proof({
      status: 'skipped',
      summary: 'Statement movement totals are unavailable.'
    });
  }
  if (!canCompare) {
    return proof({
      status: 'skipped',
      summary: 'Statement period is broader or unknown; movement proof is skipped for this close period.'
    });
  }
  const totals = transactionMovementTotals(linkedTransactions);
  const depositVariance = moneyVariance(totals.deposits, summary.deposits);
  const payoutVariance = moneyVariance(totals.payouts, summary.payouts);
  const passed = Math.abs(depositVariance) <= 1 && Math.abs(payoutVariance) <= 1;
  return proof({
    status: passed ? 'passed' : 'blocked',
    summary: passed
      ? 'Imported row movement matches the statement movement totals.'
      : 'Imported row movement does not match statement totals.',
    payload: {
      imported_deposits: totals.deposits,
      imported_payouts: totals.payouts,
      statement_deposits: roundedMoney(summary.deposits),
      statement_payouts: roundedMoney(summary.payouts),
      deposit_variance: depositVariance,
      payout_variance: payoutVariance
    }
  });
};

const buildRowCountProof = ({ expectedRowCount, linkedTransactionCount, canCompare = false } = {}) => {
  if (expectedRowCount == null) {
    return proof({
      status: 'skipped',
      summary: 'Expected statement row count is unavailable.'
    });
  }
  if (!canCompare) {
    return proof({
      status: 'skipped',
      summary: 'Statement period is broader or unknown; row-count proof is skipped for this close period.',
      payload: { expected_row_count: expectedRowCount, linked_transaction_count: linkedTransactionCount }
    });
  }
  const variance = linkedTransactionCount - expectedRowCount;
  return proof({
    status: variance === 0 ? 'passed' : 'blocked',
    summary: variance === 0
      ? 'Imported row count matches the expected statement row count.'
      : `Imported row count differs from the statement by ${variance}.`,
    payload: { expected_row_count: expectedRowCount, linked_transaction_count: linkedTransactionCount, variance }
  });
};

const buildDocumentProof = ({ document = {}, linkedTransactions = [], closePeriod = {} } = {}) => {
  const statementSummary = summaryFor(document);
  const statementPeriod = statementPeriodFor(document);
  const exactClosePeriod = statementPeriod
    ? statementPeriod.period_start === closePeriod.period_start && statementPeriod.period_end === closePeriod.period_end
    : false;
  const coversClosePeriod = statementPeriod ? periodCovers(statementPeriod, closePeriod) : false;
  const canCompareFullStatement = exactClosePeriod || (!statementPeriod && linkedTransactions.length > 0);
  const expectedRowCount = expectedRowCountFor(document);
  const extractionStatus = extractionStatusFor(document);
  const extractionWarnings = extractionWarningsFor(document);
  const balanceProof = buildBalanceProof(statementSummary || {});
  const movementProof = buildMovementProof({ summary: statementSummary || {}, linkedTransactions, canCompare: canCompareFullStatement });
  const rowCountProof = buildRowCountProof({
    expectedRowCount,
    linkedTransactionCount: linkedTransactions.length,
    canCompare: canCompareFullStatement
  });
  const issues = [];

  if (linkedTransactions.length === 0 && (!statementPeriod || periodOverlaps(statementPeriod, closePeriod))) {
    issues.push(issue({
      code: 'statement_without_rows',
      severity: 'blocker',
      summary: `${document.filename || 'Bank statement'} has no imported period rows.`,
      action: 'Re-import or reconcile this statement before close.'
    }));
  }
  if (['failed', 'needs_review', 'extracting'].includes(extractionStatus)) {
    issues.push(issue({
      code: 'statement_extraction_not_validated',
      severity: 'blocker',
      summary: `${document.filename || 'Bank statement'} extraction is ${extractionStatus}.`,
      action: 'Re-run extraction or review the statement before close.'
    }));
  }
  if (balanceProof.status === 'blocked') {
    issues.push(issue({
      code: 'statement_balance_mismatch',
      severity: 'blocker',
      summary: balanceProof.summary,
      action: 'Reconcile statement totals before closing the period.'
    }));
  }
  if (movementProof.status === 'blocked') {
    issues.push(issue({
      code: 'statement_movement_mismatch',
      severity: 'blocker',
      summary: movementProof.summary,
      action: 'Find the missing or duplicated imported rows before close.'
    }));
  }
  if (rowCountProof.status === 'blocked') {
    issues.push(issue({
      code: 'statement_row_count_mismatch',
      severity: 'blocker',
      summary: rowCountProof.summary,
      action: 'Find the missing or extra imported statement rows before close.'
    }));
  }
  if (!statementSummary) {
    issues.push(issue({
      code: 'statement_summary_missing',
      severity: 'warning',
      summary: `${document.filename || 'Bank statement'} has no statement balance summary.`,
      action: 'Capture opening balance, closing balance, deposits, and payouts when available.'
    }));
  }
  for (const warning of extractionWarnings) {
    issues.push(issue({
      code: 'statement_extraction_warning',
      severity: 'warning',
      summary: String(warning),
      action: 'Review the extraction warning before relying on imported totals.'
    }));
  }
  if (statementPeriod && !coversClosePeriod && periodOverlaps(statementPeriod, closePeriod)) {
    issues.push(issue({
      code: 'statement_period_partial',
      severity: 'warning',
      summary: `${document.filename || 'Bank statement'} covers ${statementPeriod.period_start} to ${statementPeriod.period_end}, not exactly this close period.`,
      action: 'Confirm the close period has complete statement coverage.'
    }));
  }

  const blockerCount = issues.filter((item) => item.severity === 'blocker').length;
  const warningCount = issues.filter((item) => item.severity === 'warning').length;
  return {
    document_id: document.id,
    filename: document.filename,
    status: document.status,
    extraction_status: extractionStatus || null,
    extraction_warnings: extractionWarnings,
    period_label: document.period_label || document.periodLabel || document.payload?.period_label || document.payload?.periodLabel || null,
    statement_period_start: statementPeriod?.period_start || null,
    statement_period_end: statementPeriod?.period_end || null,
    statement_currency: document.statement_currency || document.statementCurrency || document.currency || document.payload?.statement_currency || document.payload?.statementCurrency || null,
    statement_summary: statementSummary,
    expected_row_count: expectedRowCount,
    transaction_count: linkedTransactions.length,
    first_transaction_date: linkedTransactions.map(dateFor).filter(Boolean).sort()[0] || null,
    last_transaction_date: linkedTransactions.map(dateFor).filter(Boolean).sort().at(-1) || null,
    movement_totals: transactionMovementTotals(linkedTransactions),
    balance_proof: balanceProof,
    movement_proof: movementProof,
    row_count_proof: rowCountProof,
    completeness_status: blockerCount > 0 ? 'blocked' : warningCount > 0 ? 'warning' : 'passed',
    completeness_issues: issues
  };
};

// G-13 (FI-15) — the Finland close-behavior flag that arms the statement-
// coverage BLOCKER below (docs/design-donna-finland-fi15-g10-g14-p2-batch.md,
// D-P2-6). Config-plane, envFallback () => false, dark by default: a
// close-blocking change must canary per client, never blanket an existing
// book. The OPTION (`requireCoverageToPeriodEnd`) is jurisdiction-agnostic;
// the FLAG is the Finland rollout that turns it on.
export const FINLAND_STATEMENT_COVERAGE_GATE_FLAG_KEY = 'FINLAND_STATEMENT_COVERAGE_GATE';

export const buildSourceImportCompleteness = ({
  clientId,
  periodStart,
  periodEnd,
  documents = [],
  transactions = [],
  // D-P2-6: when true, a PROVEN statement-coverage gap at the period tail is a
  // blocker (the stale-feed close gate). Default false — byte-identical.
  requireCoverageToPeriodEnd = false
} = {}) => {
  const period = normalizePeriod({ periodStart, periodEnd });
  const periodTransactions = transactions.filter((transaction) => {
    const date = dateFor(transaction);
    return transaction.client_id === clientId && date >= period.period_start && date <= period.period_end;
  });
  const transactionDocumentIds = new Set(periodTransactions.map((transaction) => transaction.document_id).filter(Boolean));
  const bankDocuments = documents
    .filter((document) => document.client_id === clientId)
    .filter(isBankStatementDocument);
  const bankDocumentSummaries = bankDocuments
    .map((document) => buildDocumentProof({
      document,
      linkedTransactions: periodTransactions.filter((transaction) => transaction.document_id === document.id),
      closePeriod: period
    }))
    .filter((document) => (
      document.transaction_count > 0 ||
      (document.statement_period_start && document.statement_period_end && periodOverlaps(
        { period_start: document.statement_period_start, period_end: document.statement_period_end },
        period
      ))
    ));
  const duplicateGroups = groupDuplicates(periodTransactions);
  const transactionsWithoutDocument = periodTransactions.filter((transaction) => !transaction.document_id);
  const bankDocumentsWithoutRows = bankDocumentSummaries.filter((document) => document.transaction_count === 0);
  const orphanDocumentIds = Array.from(transactionDocumentIds).filter((documentId) => !documents.some((document) => document.id === documentId));
  // G-13 (D-P2-6): the period-level statement-coverage gate. Evidence-positive
  // by design — it fires ONLY when at least one statement carries dated period
  // metadata overlapping the close period AND the latest such coverage end
  // provably stops short of the close period end (the tail is unproven). No
  // dated metadata ⇒ no new issue (absence already surfaces as
  // statement_summary_missing); an EMPTY period already hard-blocks above.
  const coverageEnds = bankDocumentSummaries
    .filter((document) => document.statement_period_start && document.statement_period_end)
    .filter((document) => periodOverlaps(
      { period_start: document.statement_period_start, period_end: document.statement_period_end },
      period
    ))
    .map((document) => document.statement_period_end);
  const latestCoverageEnd = coverageEnds.length ? coverageEnds.sort().at(-1) : null;
  const coverageGapIssues = requireCoverageToPeriodEnd && latestCoverageEnd && latestCoverageEnd < period.period_end
    ? [issue({
        code: 'statement_coverage_gap',
        severity: 'blocker',
        summary: `Statements cover through ${latestCoverageEnd}; the close period ends ${period.period_end} — the tail is unproven.`,
        action: 'Import the statement covering the rest of the period (or one proving no activity) before close.'
      })]
    : [];

  const proofBlockers = [
    ...coverageGapIssues,
    ...bankDocumentSummaries.flatMap((document) =>
      (document.completeness_issues || [])
        .filter((item) => item.severity === 'blocker')
        .map((item) => ({ ...item, document_id: document.document_id, filename: document.filename }))
    )
  ];
  const proofWarnings = bankDocumentSummaries.flatMap((document) =>
    (document.completeness_issues || [])
      .filter((item) => item.severity !== 'blocker')
      .map((item) => ({ ...item, document_id: document.document_id, filename: document.filename }))
  );
  const hardBlockerCount =
    (periodTransactions.length === 0 ? 1 : 0) +
    proofBlockers.length +
    duplicateGroups.length +
    transactionsWithoutDocument.length +
    orphanDocumentIds.length;
  const warningCount = proofWarnings.length;
  const status = hardBlockerCount > 0 ? 'blocked' : warningCount > 0 ? 'warning' : 'passed';

  return {
    status,
    period_start: period.period_start,
    period_end: period.period_end,
    bank_statement_count: bankDocumentSummaries.length,
    transaction_count: periodTransactions.length,
    first_transaction_date: periodTransactions.map(dateFor).filter(Boolean).sort()[0] || null,
    last_transaction_date: periodTransactions.map(dateFor).filter(Boolean).sort().at(-1) || null,
    bank_documents: bankDocumentSummaries,
    bank_documents_without_rows: bankDocumentsWithoutRows,
    transactions_without_document: transactionsWithoutDocument.map((transaction) => ({
      transaction_id: transaction.id,
      date: dateFor(transaction),
      description: transaction.description || '',
      amount: amountFor(transaction),
      currency: transaction.account_currency || transaction.currency || null
    })),
    orphan_document_ids: orphanDocumentIds,
    duplicate_groups: duplicateGroups,
    // Present ONLY when the coverage gate is armed (flag-off byte-identical).
    ...(requireCoverageToPeriodEnd ? { statement_coverage_end: latestCoverageEnd } : {}),
    statement_proof: {
      status,
      blockers: proofBlockers.length,
      warnings: proofWarnings.length,
      checked_documents: bankDocumentSummaries.length,
      passed_documents: bankDocumentSummaries.filter((document) => document.completeness_status === 'passed').length,
      issues: [...proofBlockers, ...proofWarnings]
    },
    summary: status === 'passed'
      ? `${periodTransactions.length} statement transaction${periodTransactions.length === 1 ? '' : 's'} imported and proven for the period.`
      : status === 'blocked'
        ? 'Statement import completeness must be fixed before close.'
        : 'Statement import has warnings to review before close.'
  };
};
