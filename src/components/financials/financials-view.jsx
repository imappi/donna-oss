import { useEffect, useMemo, useRef, useState } from 'react';

import { Pill } from '../shared/pill.jsx';
import { UnqualifiedModelMarker } from '../shared/UnqualifiedModelMarker.jsx';
import { V } from '../shared/design-tokens.js';
import { buildEvidenceRequestForTransaction } from '../../lib/firmAccounting.js';
import {
  autoExplainHintFor,
  buildActionTelemetry,
  buildReviewBuckets,
  classifierSummaryFor,
  evidenceIndicatorFor,
  formatClassifierChip,
  requiresConfirmPrompt
} from '../../lib/receiptReview.js';
import {
  buildProposedRuleRows,
  buildRulePatchForAction,
  buildRuleTelemetry,
  formatRuleChip,
  requiresRuleConfirmPrompt
} from '../../lib/ruleProposals.js';
import { transactionStatusChip } from '../../lib/documentsInbox.js';
import { bestMatchForTransaction } from '../../lib/transactionMatchHero.js';

const CAT_COLORS = {
  income: '#3A7D54',
  founder_draws: '#8B6914',
  investor_inflows: '#2D5F8A',
  team_payroll: '#6B4FA0',
  contractors: '#6B4FA0',
  saas_tools: '#A0522D',
  meals_entertainment: '#8B6914',
  travel: '#2A7D5F',
  office_ops: '#716D63',
  family_personal: '#716D63',
  groceries_personal: '#716D63',
  loan_repayments: '#A0522D',
  intercompany: '#716D63',
  taxes_fees: '#A0522D',
  other: '#716D63',
  unknown: '#999'
};

function formatAmount(value, currency) {
  if (value == null) return '—';
  const num = Number(value);
  const hasCents = num % 1 !== 0;
  const formatted = Math.abs(num).toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2
  });
  return currency ? `${currency} ${formatted}` : formatted;
}

const toMonthLabel = (month) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

const toDayLabel = (date) =>
  date
    ? new Date(`${String(date).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    : '—';

const currentQuarterLabel = () => `Q${Math.floor(new Date().getMonth() / 3) + 1}`;

const compactDateLabel = (date) => toDayLabel(date).replace(' ', '  ');

const monthKeyFor = (date = '') => String(date).slice(0, 7);

const normalizeAccount = (value = '') => String(value || '').toLowerCase();

const categoryForTransaction = (transaction = {}) => {
  const account = normalizeAccount(transaction.proposed_account || transaction.account_code);
  const description = normalizeAccount(transaction.description);
  const moneyIn = Number(transaction.money_in || 0);
  if (moneyIn > 0) {
    if (/share|capital|investment|investor|founder/.test(description)) {
      return { category: 'investor_inflows', categoryLabel: 'Investor inflows' };
    }
    return { category: 'income', categoryLabel: 'Income' };
  }
  if (/director|draw/.test(account)) {
    return { category: 'founder_draws', categoryLabel: 'Founder draws' };
  }
  if (/payroll|salary|cpf/.test(account) || /payroll|salary/.test(description)) {
    return { category: 'team_payroll', categoryLabel: 'Team payroll' };
  }
  if (/contractor|professional|accounting|legal|consult/.test(account)) {
    return { category: 'contractors', categoryLabel: 'Contractors' };
  }
  if (/software|subscription|saas|aws|google|microsoft|openai|stripe/.test(account) || /subscription|aws|google|microsoft|openai|stripe/.test(description)) {
    return { category: 'saas_tools', categoryLabel: 'SaaS tools' };
  }
  if (/meal|entertainment|restaurant|cafe|coffee|bakery|bistro/.test(account) || /restaurant|cafe|coffee|bakery|bistro/.test(description)) {
    return { category: 'meals_entertainment', categoryLabel: 'Meals and entertainment' };
  }
  if (/travel|hotel|airline|transport|grab|flight/.test(account) || /travel|hotel|airline|transport|grab|flight/.test(description)) {
    return { category: 'travel', categoryLabel: 'Travel' };
  }
  if (/loan/.test(account)) return { category: 'loan_repayments', categoryLabel: 'Loan repayments' };
  if (/intercompany|transfer|conversion/.test(account) || /conversion|transfer/.test(description)) {
    return { category: 'intercompany', categoryLabel: 'Intercompany' };
  }
  if (/tax|fee|bank fee|filing/.test(account) || /fee|tax/.test(description)) {
    return { category: 'taxes_fees', categoryLabel: 'Taxes and fees' };
  }
  if (/office|rent|telecom|insurance/.test(account)) return { category: 'office_ops', categoryLabel: 'Office ops' };
  if (/suspense|unknown/.test(account)) return { category: 'unknown', categoryLabel: 'Unknown' };
  return { category: 'other', categoryLabel: 'Other' };
};

const counterpartyFor = (transaction = {}) =>
  transaction.contact && !['Customer', 'Vendor'].includes(transaction.contact)
    ? transaction.contact
    : String(transaction.description || '').split('|')[0].trim() || null;

const activityTimeForTransaction = (transaction = {}) =>
  Number(
    transaction.ai_suggestion_applied_at ||
    transaction.support_explained_at ||
    transaction.reviewed_at ||
    transaction.updated_at ||
    transaction.created_at ||
    0
  );

const suggestionForItem = (item = {}) =>
  item.payload?.ai_suggestion ||
  item.transaction?.ai_suggestion ||
  (item.payload?.matched_client_rule_id || item.transaction?.matched_client_rule_id
    ? {
        source: 'client_rule',
        proposed_account: item.payload?.proposed_account || item.transaction?.account_code || item.transaction?.proposed_account || 'Suspense',
        confidence: 'high',
        reasoning: item.payload?.matched_client_rule_label || item.transaction?.matched_client_rule_label || 'Matched client memory.',
        evidence_required: item.transaction?.support_status !== 'rule_explained',
        remember_candidate: false
      }
    : null);

const suggestionHasAlternatives = (suggestion = {}) =>
  Array.isArray(suggestion.alternatives) && suggestion.alternatives.length > 0;

const suggestionIsLowConfidence = (suggestion = {}) =>
  normalizeAccount(suggestion.confidence) === 'low';

const suggestionIsReviewOnly = (suggestion = {}) =>
  suggestion &&
  suggestion.source !== 'client_rule' &&
  suggestionIsLowConfidence(suggestion) &&
  !suggestionHasAlternatives(suggestion);

const categoryOptionsForSuggestion = (suggestion = {}, currentAccount = 'Suspense') => {
  const options = new Map();
  const add = (account, group = 'Xero account') => {
    if (!account) return;
    const key = normalizeAccount(account);
    if (!options.has(key)) options.set(key, { account, group });
  };

  add(currentAccount, 'Current');
  (suggestion?.alternatives || []).forEach((alternative) => add(alternative.account, 'AI option'));
  add(suggestion?.proposed_account, suggestion?.source === 'openai' ? 'AI suggestion' : 'Suggestion');
  // Render the recorded choices. The named server writer validates any correction.
  // An unrelated country menu must never filter an entity's own account names.
  return [...options.values()];
};

const bestCategoryMatch = (value = '', options = []) => {
  const query = normalizeAccount(value).trim();
  if (!query) return options[0] || null;
  return (
    options.find((option) => normalizeAccount(option.account) === query) ||
    options.find((option) => normalizeAccount(option.account).startsWith(query)) ||
    options.find((option) => normalizeAccount(option.account).includes(query)) ||
    null
  );
};

const isIntercompanyAccount = (accountCode = '') =>
  /intercompany|internal transfer|related party|treasury/.test(normalizeAccount(accountCode));

const openReviewCountForClient = (snapshot = {}, clientId = '') =>
  Array.isArray(snapshot?.transactionReviewQueue)
    ? snapshot.transactionReviewQueue.filter((item) => item.status === 'open' && (!clientId || item.client_id === clientId)).length
    : null;

const periodFromDocument = (document = {}) => {
  const match = String(document.period_label || '').match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/);
  return {
    period_start: match?.[1] || '',
    period_end: match?.[2] || ''
  };
};

// Receipt-shaped `domainData` derived from the parsed document row.
// Drives the "Receipt summary" block in document-artifact.jsx, which
// renders one key:value row per non-null entry. Keys land here in a
// shape that reads naturally once title-cased by fieldName().
// Postgres returns DATE columns as ISO strings like
// `2024-07-17T00:00:00.000Z` when fed through the JS client. The
// summary card renders raw string values, so trim to YYYY-MM-DD up
// front to keep the receipt summary readable.
const dateOnly = (value) => {
  if (!value) return null;
  const str = String(value);
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : str;
};

const buildReceiptDomainData = (document) => {
  const summary = (document.parse_summary && typeof document.parse_summary === 'object') ? document.parse_summary : {};
  const semantic = (summary.semantic && typeof summary.semantic === 'object') ? summary.semantic : {};
  const currency = document.currency || summary.currency || '';
  const totalAmount = document.total_amount != null
    ? `${currency ? `${currency} ` : ''}${Number(document.total_amount).toFixed(2)}`
    : null;
  const taxAmount = document.tax_amount != null
    ? `${currency ? `${currency} ` : ''}${Number(document.tax_amount).toFixed(2)}`
    : null;
  const confidence = typeof semantic.confidence === 'number'
    ? `${(semantic.confidence * 100).toFixed(0)}%`
    : null;
  return {
    vendor: document.vendor_name || semantic.merchant_display_name || null,
    document_date: dateOnly(document.document_date),
    total_amount: totalAmount,
    tax_amount: taxAmount,
    reference_number: document.reference_number || null,
    expense_kind: semantic.expense_kind || null,
    suggested_account: semantic.suggested_account_label || null,
    business_purpose: semantic.business_purpose_guess || null,
    classifier_confidence: confidence,
    payment_status: document.payment_status || null
  };
};

const CONTRACT_TYPE_LABELS = {
  service_subscription: 'Subscription',
  services_one_off: 'One-off services',
  goods_purchase: 'Goods purchase',
  employment: 'Employment',
  loan: 'Loan',
  lease: 'Lease',
  nda: 'NDA',
  other: 'Other'
};

const FREQUENCY_LABELS = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semi_annual: 'Semi-annual',
  annual: 'Annual',
  none: '—',
  one_time: 'One-time',
  on_demand: 'On demand'
};

// Invoice/bill-shaped `domainData` derived from the parsed document
// row. Used by both supplier_bill and sales_invoice — the chat artifact
// shows it as a sibling above the chat so the firm sees the headline
// fields (counterparty, dates, amount, ref, payment status) without
// having to open the file. Mirrors buildReceiptDomainData's flat
// key:value shape — document-artifact.jsx renders one row per non-null
// entry, in declaration order.
const buildInvoiceDomainData = (document) => {
  const summary = (document.parse_summary && typeof document.parse_summary === 'object') ? document.parse_summary : {};
  const currency = document.currency || summary.currency || '';
  const formatMoney = (value) =>
    value != null ? `${currency ? `${currency} ` : ''}${Number(value).toFixed(2)}` : null;
  // Sales invoices flip counterparty: the firm IS the vendor, so the
  // useful name is the customer. Bills keep the vendor side.
  const isAr = document.document_type === 'sales_invoice' || document.document_type === 'issued_receipt';
  const counterparty = isAr
    ? (document.customer_name || null)
    : (document.vendor_name || null);
  return {
    counterparty,
    direction: isAr ? 'AR (customer)' : 'AP (vendor)',
    document_date: dateOnly(document.document_date),
    due_date: dateOnly(document.due_date),
    total_amount: formatMoney(document.total_amount),
    tax_amount: formatMoney(document.tax_amount),
    reference_number: document.reference_number || null,
    payment_status: document.payment_status || null
  };
};

const buildContractDomainData = (document) => {
  const summary = (document.parse_summary && typeof document.parse_summary === 'object') ? document.parse_summary : {};
  const currency = document.currency || summary.currency || '';
  const totalAmount = document.total_amount != null
    ? `${currency ? `${currency} ` : ''}${Number(document.total_amount).toFixed(2)}`
    : null;
  const recurringAmount = summary.recurring_amount != null
    ? `${currency ? `${currency} ` : ''}${Number(summary.recurring_amount).toFixed(2)}`
    : null;

  const data = {
    counterparty: summary.counterparty_name || document.vendor_name || document.customer_name || null,
    direction: summary.counterparty_role === 'customer' ? 'AR (customer)' : summary.counterparty_role === 'vendor' ? 'AP (vendor)' : null,
    contract_type: CONTRACT_TYPE_LABELS[summary.contract_type] || summary.contract_type || null,
    effective_start: dateOnly(summary.effective_start_date) || null,
    effective_end: dateOnly(summary.effective_end_date) || 'Indefinite',
    auto_renew: summary.auto_renew === true ? 'Yes' : summary.auto_renew === false ? 'No' : null,
    notice_period: summary.notice_period_days != null ? `${summary.notice_period_days} days` : null
  };

  if (recurringAmount) {
    data.recurring_amount = recurringAmount;
    data.frequency = FREQUENCY_LABELS[summary.recurring_frequency] || summary.recurring_frequency || null;
  } else if (totalAmount) {
    data.total_amount = totalAmount;
  }

  if (document.reference_number) {
    data.reference = document.reference_number;
  }

  return data;
};

const buildDocumentArtifactData = (document, allTransactions = [], reconciliationMatches = []) => {
  const docTransactions = allTransactions.filter((transaction) => transaction.document_id === document.id);
  const period = periodFromDocument(document);
  const currency = document.statement_currency || docTransactions[0]?.account_currency || '';
  const isBankStatement = document.document_type === 'bank_statement';
  const isReceipt = document.document_type === 'receipt';

  // Receipts don't carry their match relationship via
  // `transaction.document_id` — they relate to bank transactions
  // through `reconciliation_matches`. The artifact panel renders the
  // transactions table from `statementLines`, so for receipts we
  // produce an empty list rather than leaking bank-statement-shaped
  // rows that confuse the layout.
  const statementLines = isBankStatement
    ? docTransactions.map((transaction) => ({
        id: transaction.id,
        transaction_date: transaction.date,
        description: transaction.description,
        counterparty_guess: counterpartyFor(transaction),
        direction: Number(transaction.money_in || 0) > 0 ? 'credit' : 'debit',
        amount: Number(transaction.money_in || transaction.money_out || 0),
        balance: transaction.balance ?? null
      }))
    : [];

  const isContract = document.document_type === 'contract';

  let domainData = null;
  if (isBankStatement) {
    domainData = {
      institution: document.institution || ((document.filename || '').includes('ASR') ? 'Wise EUR' : 'Bank statement'),
      currency,
      period_start: period.period_start,
      period_end: period.period_end,
      opening_balance: document.statement_summary?.starting_balance ?? null,
      closing_balance: document.statement_summary?.ending_balance ?? docTransactions.at(-1)?.balance ?? null
    };
  } else if (isReceipt) {
    domainData = buildReceiptDomainData(document);
  } else if (isContract) {
    domainData = buildContractDomainData(document);
  } else if (document.document_type === 'supplier_bill' || document.document_type === 'sales_invoice') {
    domainData = buildInvoiceDomainData(document);
  }

  return {
    // Canonical document-artifact identity. Every opener consumes this
    // builder; carrying the persisted row here makes it impossible for one
    // call site to fall through to the retired legacy artifact simply because
    // it forgot to assign data.firmDocument after the fact.
    firmDocument: document,
    document: {
      id: document.id,
      title: document.filename || document.document_label || 'Document',
      doc_type: document.document_type || 'unknown',
      status: document.status === 'ready' ? 'verified' : document.status === 'needs_review' ? 'review_needed' : 'parsed',
      mime_type: document.mime_type || document.type || '',
      file_size: document.size || 0
    },
    fileUrl: document.file_url || '',
    domainData,
    // Threaded through so the document artifact can render the
    // reconciliation verdict on the payment-status row (CLAUDE.md:
    // render the persisted verdict, not the raw parse-time
    // documents.payment_status). The artifact reads
    // data.reconciliationMatches; without this it had no match data
    // and the bill summary showed a stale "unpaid".
    reconciliationMatches,
    fields: [],
    statementLines,
    runs: [
      {
        model_name: document.extraction_source || 'parser',
        parser_version: document.extraction_status || 'local',
        field_count: isBankStatement ? docTransactions.length : (domainData ? Object.values(domainData).filter((v) => v != null).length : 0),
        // For receipts: the classifier confidence is already rendered
        // as its own row in the receipt summary block — surfacing
        // "1 low confidence" as a separate footer stat reads as if
        // 1 of the 9 extracted fields was low-confidence, which is
        // misleading (the signal is the classifier's overall score).
        // Drop it on the receipt path; bank statements keep per-row
        // counts.
        low_confidence_count: isBankStatement
          ? docTransactions.filter((transaction) => transaction.confidence === 'low').length
          : 0,
        started_at: document.uploaded_at ? new Date(document.uploaded_at).toISOString() : '',
        finished_at: document.reviewed_at ? new Date(document.reviewed_at).toISOString() : ''
      }
    ]
  };
};

const buildFinancials = ({ documents = [], transactions = [], profile = {}, reconciliationMatches = [], transactionReviewQueue = [], clientRules = [] }) => {
  const currency = transactions.find((transaction) => transaction.account_currency)?.account_currency ||
    documents.find((document) => document.statement_currency)?.statement_currency ||
    'EUR';
  const sortedTransactions = [...transactions].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const statementDocs = documents.filter((document) => document.document_type === 'bank_statement' || document.statement_summary);
  const latestTransactionWithBalance = [...sortedTransactions].reverse().find((transaction) => transaction.balance != null);
  const latestDocument = statementDocs.at(-1) || documents.at(-1) || null;
  const months = new Map();

  sortedTransactions.forEach((transaction) => {
    const month = monthKeyFor(transaction.date);
    if (!month) return;
    const existing = months.get(month) || { month, income: 0, expenses: 0, net: 0, closingBalance: null };
    existing.income += Number(transaction.money_in || 0);
    existing.expenses += Number(transaction.money_out || 0);
    existing.net = existing.income - existing.expenses;
    if (transaction.balance != null) existing.closingBalance = Number(transaction.balance);
    months.set(month, existing);
  });

  const monthlyCashFlow = Array.from(months.values()).sort((a, b) => b.month.localeCompare(a.month));
  const avgMonths = monthlyCashFlow.slice(0, 3);
  const trailingMonths = monthlyCashFlow.slice(0, 12);
  const trailingIncome = trailingMonths.reduce((sum, month) => sum + month.income, 0);
  const trailingExpenses = trailingMonths.reduce((sum, month) => sum + month.expenses, 0);
  const monthlyExpensesAvg3 = avgMonths.length
    ? avgMonths.reduce((sum, month) => sum + month.expenses, 0) / avgMonths.length
    : null;
  const monthlyIncomeAvg3 = avgMonths.length
    ? avgMonths.reduce((sum, month) => sum + month.income, 0) / avgMonths.length
    : null;
  const latestRecordedBalance = latestTransactionWithBalance
    ? {
        amount: Number(latestTransactionWithBalance.balance),
        currency: latestTransactionWithBalance.account_currency || currency,
        institution: latestDocument?.filename?.includes('ASR') ? 'Wise EUR' : latestDocument?.document_label || 'Bank statement',
        asOf: latestTransactionWithBalance.date
      }
    : latestDocument?.statement_summary?.ending_balance != null
      ? {
          amount: Number(latestDocument.statement_summary.ending_balance),
          currency: latestDocument.statement_currency || currency,
          institution: latestDocument.filename?.includes('ASR') ? 'Wise EUR' : latestDocument.document_label || 'Bank statement',
          asOf: periodFromDocument(latestDocument).period_end || ''
        }
      : null;

  const accountCurrencies = new Set(transactions.map((transaction) => transaction.account_currency).filter(Boolean));
  let runwayStatus = 'unknown';
  let runwayMonths = null;
  if (accountCurrencies.size > 1) {
    runwayStatus = 'multi_currency_not_comparable';
  } else if (monthlyExpensesAvg3 != null && monthlyIncomeAvg3 != null && monthlyIncomeAvg3 >= monthlyExpensesAvg3) {
    runwayStatus = 'cashflow_positive';
  } else if (latestRecordedBalance && monthlyExpensesAvg3 != null && monthlyIncomeAvg3 != null) {
    const netOutflow = monthlyExpensesAvg3 - monthlyIncomeAvg3;
    if (netOutflow > 0) {
      runwayStatus = 'finite';
      runwayMonths = Number((latestRecordedBalance.amount / netOutflow).toFixed(1));
    }
  }

  const expenseGroups = new Map();
  transactions
    .filter((transaction) => Number(transaction.money_out || 0) > 0)
    .forEach((transaction) => {
      const category = categoryForTransaction(transaction);
      const current = expenseGroups.get(category.category) || {
        category: category.category,
        label: category.categoryLabel,
        total: 0,
        count: 0
      };
      current.total += Number(transaction.money_out || 0);
      current.count += 1;
      expenseGroups.set(category.category, current);
    });
  const totalExpenses = Array.from(expenseGroups.values()).reduce((sum, group) => sum + group.total, 0);
  const expensesByCategory = Array.from(expenseGroups.values())
    .map((group) => ({
      ...group,
      pct: totalExpenses ? Math.round((group.total / totalExpenses) * 100) : 0
    }))
    .sort((a, b) => b.total - a.total);

  const recentTransactions = [...sortedTransactions]
    .reverse()
    .slice(0, 25)
    .map((transaction) => {
      const category = categoryForTransaction(transaction);
      return {
        id: transaction.id,
        date: transaction.date,
        counterparty: counterpartyFor(transaction),
        description: transaction.description,
        category: category.category,
        categoryLabel: category.categoryLabel,
        amount: Number(transaction.money_in || 0) - Number(transaction.money_out || 0),
        currency: transaction.account_currency || currency,
        statementId: transaction.document_id || null
      };
    });

  const categorizedCount = transactions.filter((transaction) => transaction.proposed_account && transaction.proposed_account !== 'Suspense').length;
  const txById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const matchById = new Map(reconciliationMatches.map((match) => [match.id, match]));
  const reviewBuckets = buildReviewBuckets({ reconciliationMatches, documents, transactions });
  const autoMatchedReviewRows = reviewBuckets.auto_matched_to_review;
  const proposedRuleRows = buildProposedRuleRows({ clientRules });
  const openReviewRows = transactionReviewQueue
    .filter((item) => item.status === 'open')
    .map((item) => {
      const match = item.item_type === 'reconciliation_match' ? matchById.get(item.item_id) : null;
      const tx = txById.get(item.payload?.transaction_id || match?.bank_transaction_id || item.item_id);
      return {
        ...item,
        transaction: tx,
        match,
        amount: tx ? Number(tx.money_in || 0) - Number(tx.money_out || 0) : Number(item.payload?.amount || 0),
        currency: tx?.account_currency || tx?.currency || currency,
        date: tx?.date,
        description: tx?.description || item.reason
      };
    });
  const handledRows = transactions
    .filter((transaction) =>
      transaction.status === 'approved' ||
      transaction.support_status === 'explained' ||
      transaction.support_status === 'rule_explained' ||
      ['explained', 'reconciled'].includes(transaction.reconciliation_status)
    )
    .sort((a, b) => activityTimeForTransaction(b) - activityTimeForTransaction(a))
    .map((transaction) => ({
      id: transaction.id,
      transaction,
      date: transaction.date,
      description: transaction.description,
      amount: Number(transaction.money_in || 0) - Number(transaction.money_out || 0),
      currency: transaction.account_currency || transaction.currency || currency,
      statusLabel:
        transaction.support_status === 'rule_explained'
          ? 'Memory'
          : transaction.support_status === 'explained'
          ? 'Explained'
          : transaction.reconciliation_status === 'reconciled'
            ? 'Reconciled'
            : 'Approved',
      note: transaction.support_note || transaction.reason || ''
    }));
  const autoMatchedCount = reconciliationMatches.filter((match) => match.status === 'auto_matched' || match.status === 'confirmed').length;
  const suggestedMatchCount = reconciliationMatches.filter((match) => match.status === 'suggested').length;
  const needsReviewCount = transactionReviewQueue.filter((item) => item.status === 'open').length;
  const handledCount = transactions.filter((transaction) =>
    transaction.status === 'approved' ||
    transaction.support_status === 'explained' ||
    transaction.support_status === 'rule_explained' ||
    ['explained', 'reconciled'].includes(transaction.reconciliation_status)
  ).length;

  return {
    kpis: {
      currency,
      latestRecordedBalance,
      monthlyExpensesAvg3,
      monthlyIncomeAvg3,
      trailingIncome,
      trailingExpenses,
      trailingNet: trailingIncome - trailingExpenses,
      importedMonths: monthlyCashFlow.length,
      accountCount: accountCurrencies.size || 1,
      runwayStatus,
      runwayMonths
    },
    monthlyCashFlow,
    expensesByCategory,
    recentTransactions,
    reconciliation: {
      autoMatchedCount,
      suggestedMatchCount,
      needsReviewCount,
      handledCount,
      openReviewRows,
      handledRows,
      autoMatchedReviewRows,
      proposedRuleRows
    },
    categorization: transactions.length ? { coveragePct: Math.round((categorizedCount / transactions.length) * 100) } : null,
    documentSupport: {
      overdueInvoices: [],
      payables: (profile.payables || []).slice(0, 8),
      receivables: (profile.receivables || []).slice(0, 8)
    }
  };
};

function FinSection({ title, emptyMsg, rows, summary, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: V.t4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {title}
        </span>
        {summary && (
          <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: V.t3 }}>
            {summary}
          </span>
        )}
      </div>
      {rows && rows.length > 0 ? children : (
        <div style={{ fontSize: 13, color: V.t4, padding: '16px 0', textAlign: 'center' }}>{emptyMsg}</div>
      )}
    </div>
  );
}

const tableShell = {
  border: `1px solid ${V.border}`,
  borderRadius: 8,
  overflowX: 'auto',
  overflowY: 'hidden'
};

const thStyle = {
  padding: '8px 10px',
  fontWeight: 600,
  color: V.t2,
  fontSize: 12
};

const tdMono = {
  padding: '7px 10px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11
};

const actionButtonStyle = (color, busy = false) => ({
  border: 'none',
  background: busy ? V.surfaceAlt : 'transparent',
  color: busy ? V.t4 : color,
  fontWeight: 600,
  cursor: busy ? 'wait' : 'pointer',
  borderRadius: 6,
  padding: '4px 6px',
  minWidth: 46
});

const accountingUi = {
  page: '#ECE5D6',
  paper: '#F5F0E6',
  card: '#FBF8F1',
  ink: '#1A1815',
  inkSoft: '#3D362C',
  muted: '#7A6F5F',
  mutedSoft: '#9E9485',
  rule: 'rgba(26,24,21,0.10)',
  ruleSoft: 'rgba(26,24,21,0.06)',
  accent: '#3F36B0',
  accentSoft: '#EDEBFA',
  amber: '#9A6B0E',
  amberSoft: '#F5E9CE',
  alert: '#A84A1F',
  ok: '#2F6B3F',
  sans: '"Inter", "DM Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
};

const accountingHeaderStyle = {
  padding: '10px 14px',
  fontFamily: accountingUi.mono,
  fontSize: 10,
  fontWeight: 500,
  color: accountingUi.mutedSoft,
  textTransform: 'uppercase',
  letterSpacing: 0
};

const accountingCellStyle = {
  padding: '12px 16px',
  fontFamily: accountingUi.sans,
  color: accountingUi.inkSoft,
  fontSize: 13,
  verticalAlign: 'top',
  borderBottom: `1px solid ${accountingUi.ruleSoft}`
};

const activeAccountingCellStyle = {
  ...accountingCellStyle,
  paddingTop: 24,
  paddingBottom: 24,
  background: accountingUi.card,
  borderTop: `1px solid ${accountingUi.rule}`,
  borderBottom: `1px solid ${accountingUi.rule}`
};

// Stage A — Bank Feed status chip. Mirrors the documents-inbox
// StatusChip's visual treatment (monospace / uppercase / pill) but
// using the accountingUi palette so it lives natively in the
// reconcile-table aesthetic. Tone map matches the documents-side
// TONE table (ok / amber / alert / muted) so the same {label, tone}
// shape returned by `transactionStatusChip` (and `receiptStatusChip`)
// can render in either surface. Stage C will fold the two into a
// single shared component.
const STATUS_CHIP_TONES = {
  ok:    { bg: 'rgba(47,107,63,0.10)',  fg: accountingUi.ok    },
  amber: { bg: accountingUi.amberSoft,  fg: accountingUi.amber },
  alert: { bg: 'rgba(168,74,31,0.12)',  fg: accountingUi.alert },
  muted: { bg: 'rgba(26,24,21,0.05)',   fg: accountingUi.muted }
};

const StatusChip = ({ label, tone = 'muted' }) => {
  const palette = STATUS_CHIP_TONES[tone] || STATUS_CHIP_TONES.muted;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 999,
      background: palette.bg, color: palette.fg,
      fontFamily: accountingUi.mono,
      fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.04em',
      whiteSpace: 'nowrap'
    }}>
      {label}
    </span>
  );
};

const accountingButtonStyle = (variant = 'apply', busy = false, disabled = false) => {
  const isAsk = variant === 'ask';
  return {
    border: isAsk ? `1px solid ${accountingUi.amber}` : `1px solid ${accountingUi.ink}`,
    background: isAsk ? 'transparent' : accountingUi.ink,
    color: isAsk ? accountingUi.amber : accountingUi.paper,
    borderRadius: 999,
    padding: '7px 14px',
    fontFamily: accountingUi.sans,
    fontSize: 13,
    fontWeight: 700,
    cursor: busy ? 'wait' : disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    whiteSpace: 'nowrap'
  };
};

const financeTabButtonStyle = (active = false) => ({
  border: 'none',
  borderBottom: active ? `2px solid ${accountingUi.ink}` : '2px solid transparent',
  background: 'transparent',
  color: active ? accountingUi.ink : accountingUi.muted,
  padding: '16px 0 14px',
  fontFamily: accountingUi.sans,
  fontSize: 15,
  fontWeight: active ? 800 : 700,
  cursor: 'pointer',
  letterSpacing: 0,
  whiteSpace: 'nowrap'
});

const financeCountStyle = (active = false) => ({
  marginLeft: 6,
  borderRadius: 999,
  padding: '1px 7px',
  background: active ? accountingUi.ink : 'rgba(26,24,21,0.07)',
  color: active ? accountingUi.paper : accountingUi.muted,
  fontFamily: accountingUi.mono,
  fontSize: 11,
  fontWeight: 700
});

const statusDotColor = (item = {}, suggestion = null) => {
  if (item.priority === 'high') return accountingUi.alert;
  if (normalizeAccount(suggestion?.confidence) === 'high') return accountingUi.ok;
  if (normalizeAccount(suggestion?.confidence) === 'medium') return accountingUi.amber;
  return '#B3572B';
};

const categoryChipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: '100%',
  borderRadius: 999,
  padding: '3px 9px',
  background: 'rgba(154,107,14,0.10)',
  color: accountingUi.inkSoft,
  fontFamily: accountingUi.sans,
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.2,
  whiteSpace: 'nowrap'
};

export const batchSummaryForClient = (batch = null, clientId = '') =>
  (batch?.summaries || []).find((summary) => summary.client_id === clientId) || null;

const aiGroupKeyForSuggestion = (suggestion = {}) =>
  [
    suggestion.merchant_pattern || suggestion.contact || 'unknown',
    suggestion.proposed_account || 'Suspense',
    suggestion.evidence_required ? 'needs-evidence' : 'safe'
  ].join('|');

const aiGroupKeyForItem = (item = {}) => {
  const suggestion = suggestionForItem(item);
  return suggestion ? aiGroupKeyForSuggestion(suggestion) : 'ungrouped';
};

const buildAiReviewGroups = (rows = [], currency = 'EUR') => {
  const groups = new Map();
  rows.forEach((item) => {
    const suggestion = suggestionForItem(item);
    if (!suggestion) return;
    const key = aiGroupKeyForSuggestion(suggestion);
    const existing = groups.get(key) || {
      id: key,
      merchant: suggestion.merchant_pattern || suggestion.contact || 'Unknown',
      account: suggestion.proposed_account || 'Suspense',
      confidence: suggestion.confidence || 'low',
      reasoning: suggestion.reasoning || '',
      ask: suggestion.ask_client_question || '',
      evidenceRequired: Boolean(suggestion.evidence_required),
      count: 0,
      total: 0,
      currency: item.currency || currency,
      rows: []
    };
    existing.count += 1;
    existing.total += Math.abs(Number(item.amount || 0));
    existing.rows.push(item);
    if (!existing.reasoning && suggestion.reasoning) existing.reasoning = suggestion.reasoning;
    if (!existing.ask && suggestion.ask_client_question) existing.ask = suggestion.ask_client_question;
    groups.set(key, existing);
  });
  return Array.from(groups.values()).sort((a, b) => {
    if (a.evidenceRequired !== b.evidenceRequired) return a.evidenceRequired ? -1 : 1;
    return b.count - a.count || b.total - a.total;
  });
};

function CategoryAutocomplete({ value, options, aiSource = false, busy = false, onChange, onCommit }) {
  const [open, setOpen] = useState(false);
  const query = normalizeAccount(value).trim();
  const filtered = (query
    ? options.filter((option) => normalizeAccount(option.account).includes(query))
    : options
  );
  const completion = bestCategoryMatch(value, options)?.account || '';
  const showGhost =
    value &&
    completion &&
    normalizeAccount(completion).startsWith(normalizeAccount(value)) &&
    normalizeAccount(completion) !== normalizeAccount(value);
  const inputTextStyle = {
    width: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    fontFamily: accountingUi.sans,
    fontSize: 15,
    fontWeight: 700,
    lineHeight: '21px',
    letterSpacing: 0,
    padding: '0 48px 8px 0'
  };

  const commitValue = (rawValue = value) => {
    const match = bestCategoryMatch(rawValue, options);
    onCommit(match?.account || rawValue || value || 'Suspense');
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <div
        style={{
          fontFamily: accountingUi.mono,
          fontSize: 10,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: 0,
          color: accountingUi.mutedSoft,
          marginBottom: 7
        }}
      >
        Category
      </div>
      <div style={{ position: 'relative', borderBottom: `1.5px solid ${open ? accountingUi.ink : accountingUi.rule}`, minHeight: 34 }}>
        {showGhost && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              ...inputTextStyle,
              color: 'transparent',
              pointerEvents: 'none',
              whiteSpace: 'pre'
            }}
          >
            <span>{value}</span>
            <span style={{ color: accountingUi.mutedSoft }}>{completion.slice(value.length)}</span>
          </div>
        )}
        <input
          value={value}
          disabled={busy}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitValue();
            }
            if (event.key === 'Tab' && showGhost) {
              event.preventDefault();
              onChange(completion);
            }
            if (event.key === 'Escape') setOpen(false);
          }}
          style={{
            position: 'relative',
            zIndex: 1,
            ...inputTextStyle,
            color: accountingUi.ink,
            caretColor: accountingUi.ink
          }}
        />
        {aiSource && (
          <span
            style={{
              position: 'absolute',
              right: 0,
              top: 2,
              borderRadius: 5,
              padding: '2px 7px',
              background: 'rgba(154,107,14,0.12)',
              color: accountingUi.amber,
              fontFamily: accountingUi.mono,
              fontSize: 10,
              fontWeight: 500
            }}
          >
            AI
          </span>
        )}
      </div>
      <div style={{ marginTop: 7, display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', color: accountingUi.muted, fontFamily: accountingUi.mono, fontSize: 10.5 }}>
        <span style={{ padding: '1px 6px', borderRadius: 3, background: 'rgba(26,24,21,0.08)' }}>↵</span>
        <span>accept</span>
        <span style={{ padding: '1px 6px', borderRadius: 3, background: 'rgba(26,24,21,0.08)' }}>tab</span>
        <span>complete or type to override</span>
      </div>
      {open && filtered.length > 0 && (
        <div
          style={{
            position: 'absolute',
            zIndex: 20,
            left: 0,
            right: 0,
            top: 'calc(100% + 6px)',
            border: `1px solid ${accountingUi.rule}`,
            borderRadius: 10,
            background: accountingUi.card,
            boxShadow: '0 16px 44px -22px rgba(26,24,21,0.32)',
            padding: 6,
            maxHeight: 360,
            overflowY: 'auto'
          }}
        >
          {filtered.map((option) => (
            <button
              key={`${option.group}-${option.account}`}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.account);
                onCommit(option.account);
                setOpen(false);
              }}
              style={{
                width: '100%',
                border: 'none',
                background: normalizeAccount(option.account) === normalizeAccount(value) ? accountingUi.accentSoft : 'transparent',
                color: accountingUi.inkSoft,
                borderRadius: 7,
                padding: '9px 10px',
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                cursor: 'pointer',
                fontFamily: accountingUi.sans,
                fontSize: 13.5,
                textAlign: 'left'
              }}
            >
              <span>{option.account}</span>
              <span style={{ fontFamily: accountingUi.mono, fontSize: 10, color: accountingUi.mutedSoft, textTransform: 'uppercase', letterSpacing: 0 }}>
                {option.group}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FinancialsView = ({
  profile = {},
  documents = [],
  transactions = [],
  reconciliationMatches = [],
  clientRules = [],
  transactionReviewQueue = [],
  transactionAiBatch = null,
  onArtifact,
  onRefreshTransactionIntel,
  onSuggestTransactionCoding,
  onBatchSuggestTransactionCoding,
  onUpdateReconciliationMatch,
  onUpdateClientRule,
  onUpdateTransactionReviewItem,
  onUpdateTransaction,
  onApproveTransaction
}) => {
  const [refreshKey, setRefreshKey] = useState(0);
  const [workingReviewId, setWorkingReviewId] = useState('');
  const [workingRuleId, setWorkingRuleId] = useState('');
  const [batchReviewStatus, setBatchReviewStatus] = useState('');
  const [financeTab, setFinanceTab] = useState('reconcile');
  const [activeAiGroupId, setActiveAiGroupId] = useState('all');
  const [visibleReviewCount, setVisibleReviewCount] = useState(12);
  const [visibleReconciledCount, setVisibleReconciledCount] = useState(12);
  const [activeReviewId, setActiveReviewId] = useState('');
  const [categoryDrafts, setCategoryDrafts] = useState({});
  const data = useMemo(
    () => buildFinancials({ profile, documents, transactions, reconciliationMatches, transactionReviewQueue, clientRules }),
    [profile, documents, transactions, reconciliationMatches, transactionReviewQueue, clientRules, refreshKey]
  );
  const kpis = data?.kpis || {};
  const cur = kpis.currency || 'EUR';
  const overdueInvoices = data?.documentSupport?.overdueInvoices || [];
  const payables = data?.documentSupport?.payables || [];
  const receivables = data?.documentSupport?.receivables || [];
  const today = new Date().toISOString().split('T')[0];
  const reconciliation = data?.reconciliation || {};
  const reviewOrderRef = useRef(new Map());
  const stableOpenReviewRows = useMemo(() => {
    const rows = reconciliation.openReviewRows || [];
    const order = reviewOrderRef.current;
    rows.forEach((row) => {
      if (!order.has(row.id)) order.set(row.id, order.size);
    });
    for (const id of [...order.keys()]) {
      if (!rows.some((row) => row.id === id)) order.delete(id);
    }
    return [...rows].sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  }, [reconciliation.openReviewRows]);
  const autoMatchedOrderRef = useRef(new Map());
  const stableAutoMatchedRows = useMemo(() => {
    const rows = reconciliation.autoMatchedReviewRows || [];
    const order = autoMatchedOrderRef.current;
    rows.forEach((row) => {
      if (!order.has(row.id)) order.set(row.id, order.size);
    });
    for (const id of [...order.keys()]) {
      if (!rows.some((row) => row.id === id)) order.delete(id);
    }
    return [...rows].sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  }, [reconciliation.autoMatchedReviewRows]);
  const proposedRuleOrderRef = useRef(new Map());
  const stableProposedRuleRows = useMemo(() => {
    const rows = reconciliation.proposedRuleRows || [];
    const order = proposedRuleOrderRef.current;
    rows.forEach((row) => {
      if (!order.has(row.id)) order.set(row.id, order.size);
    });
    for (const id of [...order.keys()]) {
      if (!rows.some((row) => row.id === id)) order.delete(id);
    }
    return [...rows].sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  }, [reconciliation.proposedRuleRows]);
  const filteredOpenReviewRows = useMemo(
    () => (
      activeAiGroupId === 'all'
        ? stableOpenReviewRows
        : stableOpenReviewRows.filter((row) => aiGroupKeyForItem(row) === activeAiGroupId)
    ),
    [activeAiGroupId, stableOpenReviewRows]
  );
  const visibleReviewRows = filteredOpenReviewRows.slice(0, visibleReviewCount);
  const handledRows = reconciliation.handledRows || [];
  const visibleHandledRows = handledRows.slice(0, visibleReconciledCount);
  const batchSummary = batchSummaryForClient(transactionAiBatch, profile.id);
  const aiReviewGroups = useMemo(
    () => buildAiReviewGroups(stableOpenReviewRows, cur).slice(0, 6),
    [stableOpenReviewRows, cur]
  );
  const activeGroupIsAvailable = activeAiGroupId === 'all' || aiReviewGroups.some((group) => group.id === activeAiGroupId);

  useEffect(() => {
    if (financeTab !== 'reconcile') return;
    if (activeReviewId && filteredOpenReviewRows.some((row) => row.id === activeReviewId)) return;
    setActiveReviewId(filteredOpenReviewRows[0]?.id || '');
  }, [activeReviewId, filteredOpenReviewRows, financeTab]);

  useEffect(() => {
    if (!activeGroupIsAvailable) setActiveAiGroupId('all');
  }, [activeGroupIsAvailable]);

  useEffect(() => {
    setVisibleReviewCount(12);
  }, [activeAiGroupId]);

  useEffect(() => {
    const onChange = () => setRefreshKey((value) => value + 1);
    window.addEventListener('donna-data-changed', onChange);
    return () => window.removeEventListener('donna-data-changed', onChange);
  }, []);

  const openDoc = (documentId) => {
    const document = documents.find((item) => item.id === documentId);
    if (!document || !onArtifact) return;
    const artifactData = buildDocumentArtifactData(document, transactions, reconciliationMatches);
    let title = artifactData.document?.title || 'Document';
    if (artifactData.document?.doc_type === 'bank_statement' && artifactData.domainData) {
      const dd = artifactData.domainData;
      const parts = [
        dd.institution,
        dd.currency,
        dd.period_start && dd.period_end ? `${dd.period_start} to ${dd.period_end}` : null
      ].filter(Boolean);
      if (parts.length) title = parts.join(' / ');
    }
    onArtifact({ type: 'document', title, data: artifactData });
  };

  const openTx = (transactionId) => {
    const tx = transactions.find((item) => item.id === transactionId);
    if (!tx || !onArtifact) return;
    const document = tx.document_id ? documents.find((item) => item.id === tx.document_id) : null;
    const summary = (tx.description || 'Transaction').slice(0, 60);
    const title = `${tx.date || ''} · ${summary}${(tx.description || '').length > 60 ? '…' : ''}`;
    // The artifact renders persisted reconciliation state (MatchHero,
    // matcher reasoning, status chip) — thread it in like the
    // donna-financials-panel openTx sites do. Without it a matched
    // line opened from this view renders as unmatched.
    const txMatch = bestMatchForTransaction(reconciliationMatches, transactionId);
    const matchedDocument = txMatch?.matched_object_id
      ? documents.find((item) => item.id === txMatch.matched_object_id) || null
      : null;
    onArtifact({
      type: 'transaction',
      title,
      data: {
        transaction: tx,
        document,
        match: txMatch,
        matchedDocument,
        documents,
        transactions,
        reconciliationMatches,
        onUpdate: onUpdateTransaction ? (patch) => onUpdateTransaction(tx.id, patch) : null,
        onApprove: onApproveTransaction ? (patch = {}) => onApproveTransaction({ ...tx, ...patch }) : null,
        onOpenMatchedDocument: matchedDocument ? () => openDoc(matchedDocument.id) : null,
        // One-arg contract — the artifact's manual-search rows call
        // onOpenDocument(doc) per candidate.
        onOpenDocument: (doc) => { if (doc?.id) openDoc(doc.id); },
        onRejectMatch: txMatch?.id ? () => rejectMatch(txMatch.id) : null
      }
    });
  };

  const confirmMatch = async (matchId, { row, action = 'confirm' } = {}) => {
    if (!matchId || !onUpdateReconciliationMatch) return;
    if (row) {
      // TODO(PR-5+): wire telemetry sink once one exists. Helper enforces the PII-safe shape.
      // buildActionTelemetry({ action, match: row.match, document: row.document });
      void buildActionTelemetry;
    }
    setWorkingReviewId(`${action}-${matchId}`);
    try {
      await onUpdateReconciliationMatch(matchId, { status: 'confirmed' });
    } finally {
      setWorkingReviewId('');
    }
  };

  const undoMatch = async (matchId, { row } = {}) => {
    if (!matchId || !onUpdateReconciliationMatch) return;
    if (row) {
      // TODO(PR-5+): wire telemetry sink once one exists.
      // buildActionTelemetry({ action: 'undo', match: row.match, document: row.document });
    }
    setWorkingReviewId(`undo-${matchId}`);
    try {
      await onUpdateReconciliationMatch(matchId, { status: 'suggested' });
    } finally {
      setWorkingReviewId('');
    }
  };

  const rejectMatch = async (matchId, { row } = {}) => {
    if (!matchId || !onUpdateReconciliationMatch) return;
    if (requiresConfirmPrompt('reject')) {
      const proceed =
        typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm('Reject this match? The transaction will need a fresh review and this receipt won’t match it again.')
          : true;
      if (!proceed) return;
    }
    if (row) {
      // TODO(PR-5+): wire telemetry sink once one exists.
      // buildActionTelemetry({ action: 'reject', match: row.match, document: row.document });
    }
    setWorkingReviewId(`reject-${matchId}`);
    try {
      await onUpdateReconciliationMatch(matchId, { status: 'rejected' });
    } finally {
      setWorkingReviewId('');
    }
  };

  // Reconciliation PR 5 — firm commit/discard on a proposed learned
  // rule. Both actions route through PATCH /client-rules/{id}; the
  // writer enforces the prior-state guard (only `proposed` is a legal
  // source). Q9 confirmed: both Commit and Discard prompt with native
  // confirm() so a misclick can't silently change durable accounting
  // policy.
  const commitRule = async (ruleId, { row } = {}) => {
    if (!ruleId || !onUpdateClientRule) return;
    if (requiresRuleConfirmPrompt('commit')) {
      const proceed =
        typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(
              'Commit this memory? Future matching transactions will be auto-coded to this account. PR 3 auto-explain guardrails still apply, but Donna will treat this rule as durable accounting policy until you retire it.'
            )
          : true;
      if (!proceed) return;
    }
    if (row) {
      // TODO(PR-5+): wire telemetry sink once one exists. Helper enforces the PII-safe shape.
      // buildRuleTelemetry({ action: 'commit', rule: row.rule });
      void buildRuleTelemetry;
    }
    setWorkingRuleId(`commit-${ruleId}`);
    try {
      const patch = buildRulePatchForAction({ action: 'commit', rule: row?.rule });
      if (patch) await onUpdateClientRule(ruleId, patch);
    } finally {
      setWorkingRuleId('');
    }
  };

  const discardRule = async (ruleId, { row } = {}) => {
    if (!ruleId || !onUpdateClientRule) return;
    if (requiresRuleConfirmPrompt('discard')) {
      const proceed =
        typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm('Discard this memory? Donna will stop proposing it until new firm-confirmed evidence builds up again.')
          : true;
      if (!proceed) return;
    }
    if (row) {
      // TODO(PR-5+): wire telemetry sink once one exists.
      // buildRuleTelemetry({ action: 'discard', rule: row.rule });
    }
    setWorkingRuleId(`discard-${ruleId}`);
    try {
      const patch = buildRulePatchForAction({ action: 'discard', rule: row?.rule });
      if (patch) await onUpdateClientRule(ruleId, patch);
    } finally {
      setWorkingRuleId('');
    }
  };

  const closeReviewItem = async (reviewItemId) => {
    if (!reviewItemId || !onUpdateTransactionReviewItem) return;
    setWorkingReviewId(`close-${reviewItemId}`);
    try {
      await onUpdateTransactionReviewItem(reviewItemId, { status: 'resolved' });
    } finally {
      setWorkingReviewId('');
    }
  };

  const requestCodingSuggestion = async (item) => {
    const tx = item?.transaction;
    if (!tx || !onSuggestTransactionCoding) return;
    setWorkingReviewId(`suggest-${item.id}`);
    try {
      await onSuggestTransactionCoding(tx.id);
    } finally {
      setWorkingReviewId('');
    }
  };

  const categoryValueForItem = (item = {}) => {
    const suggestion = suggestionForItem(item);
    if (Object.prototype.hasOwnProperty.call(categoryDrafts, item.id)) {
      return categoryDrafts[item.id];
    }
    return (
      suggestion?.proposed_account ||
      item.transaction?.account_code ||
      item.transaction?.proposed_account ||
      'Suspense'
    );
  };

  const setCategoryValueForItem = (itemId, value) => {
    setCategoryDrafts((drafts) => ({ ...drafts, [itemId]: value }));
  };

  const runBatchAiReview = async () => {
    if (!onBatchSuggestTransactionCoding) return;
    setWorkingReviewId('batch-ai');
    setBatchReviewStatus('Scanning open transactions…');
    try {
      const result = await onBatchSuggestTransactionCoding();
      const summary = batchSummaryForClient(result, profile.id);
      setBatchReviewStatus(
        summary
          ? `Scanned ${summary.scanned || 0}; auto-applied ${summary.auto_applied || 0}; suggested ${summary.suggested || 0}.`
          : 'Batch AI review applied.'
      );
      window.setTimeout(() => setBatchReviewStatus(''), 3500);
    } finally {
      setWorkingReviewId('');
    }
  };

  const applyCodingSuggestion = async (item, { remember = false, alternative = null } = {}) => {
    const tx = item?.transaction;
    const suggestion = suggestionForItem(item);
    if (!tx || !suggestion || !onUpdateTransaction) return;
    const selectedAccount = alternative?.account || suggestion.proposed_account;
    const selectedLabel = alternative?.label || '';
    const intercompanySuggestion = isIntercompanyAccount(selectedAccount);
    const canLearnMerchant = Boolean(
      (suggestion.merchant_pattern || suggestion.contact) &&
      selectedAccount &&
      normalizeAccount(selectedAccount) !== 'suspense'
    );
    const shouldRemember = Boolean(
      remember ||
      (canLearnMerchant && (suggestion.remember_candidate || suggestion.evidence_required === false || intercompanySuggestion))
    );
    const supportNote = String(suggestion.support_note || '').trim();
    const explainsSupport = Boolean(supportNote && !suggestion.evidence_required);
    setWorkingReviewId(`${alternative ? `alt-${normalizeAccount(selectedAccount).replace(/\s+/g, '-')}` : shouldRemember ? 'remember' : 'apply'}-${item.id}`);
    try {
      const beforeOpenCount = stableOpenReviewRows.length;
      const snapshot = await onUpdateTransaction(tx.id, {
        proposed_account: selectedAccount,
        account_code: selectedAccount,
        contact: suggestion.contact || tx.contact || '',
        tax_treatment: suggestion.tax_treatment || tx.tax_treatment || 'No GST',
        confidence: alternative?.confidence || suggestion.confidence || tx.confidence || 'medium',
        support_note: supportNote,
        support_status: explainsSupport ? 'explained' : tx.support_status || '',
        support_explained_at: explainsSupport ? tx.support_explained_at || Date.now() : tx.support_explained_at || null,
        reconciliation_status: explainsSupport && tx.reconciliation_status !== 'reconciled' ? 'explained' : tx.reconciliation_status,
        status: explainsSupport && tx.status === 'needs_review' ? 'ready' : tx.status,
        ai_suggestion: suggestion,
        ai_suggestion_status: alternative ? 'alternative_applied' : 'applied',
        ai_suggestion_applied_at: Date.now(),
        selected_ai_alternative: alternative ? { ...alternative, applied_at: Date.now() } : null,
        remember_merchant_rule: shouldRemember,
        merchant_pattern: shouldRemember ? suggestion.merchant_pattern || suggestion.contact || '' : '',
        merchant_rule_account: shouldRemember ? selectedAccount : '',
        merchant_rule_auto_explain_limit: shouldRemember ? (intercompanySuggestion ? 999999999 : suggestion.auto_explain_limit || null) : null
      });
      const afterOpenCount = openReviewCountForClient(snapshot, profile.id);
      const clearedCount = afterOpenCount == null ? null : Math.max(0, beforeOpenCount - afterOpenCount);
      setBatchReviewStatus(
        clearedCount == null
          ? shouldRemember
            ? `${selectedLabel || selectedAccount} applied and saved memory.`
            : `${selectedLabel || selectedAccount} applied.`
          : clearedCount > 0
            ? `${selectedLabel || selectedAccount} applied; cleared ${clearedCount} item${clearedCount === 1 ? '' : 's'}.`
            : `${selectedLabel || selectedAccount} applied; no similar rows cleared.`
      );
      window.setTimeout(() => setBatchReviewStatus(''), 3500);
      if (explainsSupport && onUpdateTransactionReviewItem) {
        await onUpdateTransactionReviewItem(item.id, {
          status: 'resolved',
          reviewer_note: shouldRemember ? 'AI suggestion applied and remembered.' : 'AI suggestion applied.'
        });
      }
    } finally {
      setWorkingReviewId('');
    }
  };

  const commitCategoryForItem = async (item, rawAccount) => {
    const account = bestCategoryMatch(rawAccount, categoryOptionsForSuggestion(suggestionForItem(item), rawAccount))?.account || rawAccount;
    if (!account || normalizeAccount(account) === 'suspense') return;
    const suggestion = suggestionForItem(item);
    if (suggestion) {
      await applyCodingSuggestion(item, {
        alternative:
          normalizeAccount(account) === normalizeAccount(suggestion.proposed_account)
            ? null
            : {
                account,
                label: account,
                confidence: 'medium',
                reasoning: 'Reviewer selected category from the inline accounting field.'
              }
      });
      return;
    }
    if (!item?.transaction || !onUpdateTransaction) return;
    setWorkingReviewId(`apply-${item.id}`);
    try {
      await onUpdateTransaction(item.transaction.id, {
        proposed_account: account,
        account_code: account,
        confidence: 'medium',
        ai_suggestion_status: 'reviewer_applied',
        ai_suggestion_applied_at: Date.now()
      });
    } finally {
      setWorkingReviewId('');
    }
  };

  const askClientForSupport = async (item) => {
    const tx = item?.transaction;
    if (!tx || !onUpdateTransaction) return;
    const suggestion = suggestionForItem(item);

    const evidenceRequest = buildEvidenceRequestForTransaction({
      ...tx,
      client_question:
        suggestion?.ask_client_question ||
        tx.client_question ||
        `Please upload the receipt or confirm the business purpose for ${tx.description || 'this bank transaction'}.`
    });
    setWorkingReviewId(`ask-${item.id}`);
    try {
      await onUpdateTransaction(tx.id, {
        status: 'needs_client',
        confidence: tx.confidence || 'low',
        client_question: evidenceRequest.question,
        evidence_request: evidenceRequest,
        client_reply: '',
        answered_at: null,
        updated_at: Date.now()
      });
      if (onUpdateTransactionReviewItem) {
        await onUpdateTransactionReviewItem(item.id, {
          status: 'resolved',
          reviewer_note: 'Client evidence request created.'
        });
      }
    } finally {
      setWorkingReviewId('');
    }
  };

  if (!data) {
    return <div style={{ textAlign: 'center', padding: 60, color: V.t4, fontSize: 14 }}>Failed to load financial data</div>;
  }

  let runwayValue = '—';
  let runwayColor = V.t3;
  if (kpis.runwayStatus === 'finite' && kpis.runwayMonths != null) {
    runwayValue = `${kpis.runwayMonths} months`;
    runwayColor = kpis.runwayMonths < 6 ? V.neg : kpis.runwayMonths < 12 ? '#B8860B' : V.pos;
  } else if (kpis.runwayStatus === 'cashflow_positive') {
    runwayValue = 'Cash-flow positive';
    runwayColor = V.pos;
  } else if (kpis.runwayStatus === 'multi_currency_not_comparable') {
    runwayValue = 'Multi-currency';
  }

  const financeTabs = [
    { key: 'reconcile', label: 'Reconcile', count: reconciliation.needsReviewCount || 0 },
    { key: 'reconciled', label: 'Reconciled', count: reconciliation.handledCount || 0 },
    { key: 'cashflow', label: 'Cash flow' },
    { key: 'categories', label: 'Categories' },
    { key: 'recent', label: 'Recent' }
  ];

  const kpiBand = [
    {
      label: 'Cash on hand',
      value: kpis.latestRecordedBalance ? formatAmount(kpis.latestRecordedBalance.amount, kpis.latestRecordedBalance.currency) : '—',
      sub: kpis.latestRecordedBalance
        ? `across ${kpis.accountCount || 1} account${kpis.accountCount === 1 ? '' : 's'} · as of ${kpis.latestRecordedBalance.asOf ? toDayLabel(kpis.latestRecordedBalance.asOf) : 'latest'}`
        : 'No statement imported'
    },
    {
      label: 'Net 12 mo.',
      value: `${Number(kpis.trailingNet || 0) >= 0 ? '+' : '−'}${formatAmount(kpis.trailingNet || 0, cur)}`,
      sub: `income ${formatAmount(kpis.trailingIncome || 0, cur)} · expenses ${formatAmount(kpis.trailingExpenses || 0, cur)}`
    },
    {
      label: 'Open to reconcile',
      value: reconciliation.needsReviewCount || 0,
      sub: `${data.categorization?.coveragePct || 0}% categorized · ${aiReviewGroups.length} AI group${aiReviewGroups.length === 1 ? '' : 's'}`
    },
    {
      label: 'Filing window',
      value: currentQuarterLabel(),
      sub: profile.nextDeadline || runwayValue
    }
  ];

  return (
    <div style={{ width: '100%', maxWidth: '100%', minWidth: 0, margin: 0, fontFamily: accountingUi.sans, color: accountingUi.ink, overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          borderTop: `1px solid ${accountingUi.rule}`,
          borderBottom: `1px solid ${accountingUi.rule}`,
          background: accountingUi.page
        }}
      >
        {kpiBand.map((item, index) => (
          <div
            key={item.label}
            style={{
              padding: '22px 24px 24px',
              borderLeft: index === 0 ? 'none' : `1px solid ${accountingUi.ruleSoft}`,
              minHeight: 96
            }}
          >
            <div style={{ color: accountingUi.muted, fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{item.label}</div>
            <div style={{ color: item.label === 'Open to reconcile' ? accountingUi.alert : accountingUi.ink, fontFamily: accountingUi.mono, fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}>
              {item.value}
            </div>
            <div style={{ color: accountingUi.muted, fontSize: 12, fontWeight: 600, marginTop: 3 }}>{item.sub}</div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'end',
          gap: 24,
          padding: '0 24px',
          borderBottom: `1px solid ${accountingUi.rule}`,
          background: accountingUi.page
        }}
      >
        <div style={{ display: 'flex', gap: 28, alignItems: 'end', overflowX: 'auto' }} role="tablist" aria-label="Financials tabs">
          {financeTabs.map((tab) => {
            const active = financeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFinanceTab(tab.key)}
                style={financeTabButtonStyle(active)}
                aria-pressed={active}
              >
                {tab.label}
                {tab.count != null && <span style={financeCountStyle(active)}>{tab.count}</span>}
              </button>
            );
          })}
        </div>
        <div style={{ paddingBottom: 16, color: accountingUi.muted, fontFamily: accountingUi.mono, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0 }}>
          Based on uploaded bank statements
        </div>
      </div>

      {financeTab === 'reconcile' && stableAutoMatchedRows.length > 0 && (
        <div style={{ borderBottom: `1px solid ${accountingUi.rule}`, marginBottom: 0, overflowX: 'hidden', background: accountingUi.page }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'center', padding: '30px 24px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                background: accountingUi.amberSoft,
                color: accountingUi.ok,
                fontFamily: accountingUi.mono,
                fontSize: 10,
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                border: `1px solid ${accountingUi.ok}`
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: accountingUi.ok }} />
                Auto-explained
              </span>
              <div>
                <div style={{ color: accountingUi.ink, fontSize: 15, fontWeight: 800 }}>
                  Awaiting review · {stableAutoMatchedRows.length}
                </div>
                <div style={{ color: accountingUi.muted, fontSize: 12, fontWeight: 600, marginTop: 2 }}>
                  Donna matched these receipts to bank lines. One click to confirm, or step in.
                </div>
              </div>
            </div>
          </div>
          <table style={{ width: '100%', minWidth: 0, tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, background: accountingUi.paper }}>
            <thead style={{ background: accountingUi.paper }}>
              <tr style={{ borderBottom: `1px solid ${V.border}` }}>
                <th style={{ ...accountingHeaderStyle, width: 128 }}>Status</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'left', width: 74 }}>Date</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'left' }}>Receipt → transaction</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'right', width: 118 }}>Amount</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'right', width: 260 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {stableAutoMatchedRows.map((row, index) => {
                const matchId = row.match.id;
                const tx = row.transaction;
                const doc = row.document;
                const amount = Number(tx.money_in || 0) - Number(tx.money_out || 0);
                const isConfirming = workingReviewId === `confirm-${matchId}`;
                const isUndoing = workingReviewId === `undo-${matchId}`;
                const isRejecting = workingReviewId === `reject-${matchId}`;
                const busy = isConfirming || isUndoing || isRejecting;
                const classifierChip = row.classifierSummary ? formatClassifierChip(row.classifierSummary) : '';
                const evidenceLabel = evidenceIndicatorFor(row.classifierSummary);
                const docTitle = doc.document_label || doc.filename || 'Receipt';
                return (
                  <tr
                    key={matchId}
                    aria-busy={busy ? 'true' : 'false'}
                    style={{
                      borderBottom: index < stableAutoMatchedRows.length - 1 ? `1px solid ${accountingUi.ruleSoft}` : 'none',
                      background: busy ? V.surfaceAlt : 'transparent'
                    }}
                  >
                    <td style={{ ...accountingCellStyle, paddingLeft: 24 }}>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 9px',
                        borderRadius: 999,
                        background: 'rgba(47,107,63,0.10)',
                        color: accountingUi.ok,
                        fontFamily: accountingUi.mono,
                        fontSize: 10,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em'
                      }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: accountingUi.ok }} />
                        {row.chipLabel}
                      </span>
                    </td>
                    <td style={{ ...accountingCellStyle, fontFamily: accountingUi.mono, fontSize: 13, fontWeight: 700, color: accountingUi.muted }}>
                      {compactDateLabel(tx.date)}
                    </td>
                    <td style={{ ...accountingCellStyle, color: accountingUi.ink, fontSize: 13, fontWeight: 800 }}>
                      <div title={tx.description || ''} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tx.description || '—'}
                      </div>
                      <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); openDoc(doc.id); }}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: accountingUi.accent,
                            fontFamily: accountingUi.sans,
                            fontSize: 12,
                            fontWeight: 700,
                            padding: 0,
                            cursor: 'pointer'
                          }}
                        >
                          {docTitle}
                        </button>
                        {classifierChip && (
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            padding: '2px 8px',
                            borderRadius: 6,
                            background: accountingUi.accentSoft,
                            color: accountingUi.accent,
                            fontFamily: accountingUi.mono,
                            fontSize: 10,
                            fontWeight: 700
                          }}>
                            {classifierChip}
                          </span>
                        )}
                        {evidenceLabel && (
                          <span style={{
                            color: accountingUi.muted,
                            fontFamily: accountingUi.mono,
                            fontSize: 10,
                            fontWeight: 700
                          }}>
                            {evidenceLabel}
                          </span>
                        )}
                      </div>
                      {row.autoExplainHint && (
                        <div style={{ marginTop: 6, color: accountingUi.muted, fontFamily: accountingUi.mono, fontSize: 10, fontWeight: 600 }}>
                          {row.autoExplainHint}
                        </div>
                      )}
                    </td>
                    <td style={{ ...accountingCellStyle, textAlign: 'right', fontFamily: accountingUi.mono, fontSize: 13, fontWeight: 800, color: amount > 0 ? V.pos : accountingUi.ink, whiteSpace: 'nowrap' }}>
                      {amount > 0 ? '+' : amount < 0 ? '−' : ''}{formatAmount(amount, tx.account_currency || tx.currency || cur)}
                    </td>
                    <td style={{ ...accountingCellStyle, textAlign: 'right', paddingRight: 24 }}>
                      <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(event) => { event.stopPropagation(); confirmMatch(matchId, { row, action: 'confirm' }); }}
                          style={accountingButtonStyle('apply', busy)}
                        >
                          {isConfirming ? 'Confirming…' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(event) => { event.stopPropagation(); undoMatch(matchId, { row }); }}
                          style={accountingButtonStyle('ask', busy)}
                          title="Send back to Suggested for a closer look."
                        >
                          {isUndoing ? 'Undoing…' : 'Undo'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(event) => { event.stopPropagation(); rejectMatch(matchId, { row }); }}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: accountingUi.alert,
                            fontFamily: accountingUi.sans,
                            fontSize: 12,
                            fontWeight: 800,
                            padding: '4px 6px',
                            cursor: busy ? 'wait' : 'pointer'
                          }}
                        >
                          {isRejecting ? 'Rejecting…' : 'Reject'}
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {financeTab === 'reconcile' && stableProposedRuleRows.length > 0 && (
        <div style={{ borderBottom: `1px solid ${accountingUi.rule}`, marginBottom: 0, overflowX: 'hidden', background: accountingUi.page }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'center', padding: '30px 24px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                background: accountingUi.accentSoft,
                color: accountingUi.accent,
                fontFamily: accountingUi.mono,
                fontSize: 10,
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                border: `1px solid ${accountingUi.accent}`
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: accountingUi.accent }} />
                Proposed memory
              </span>
              <div>
                <div style={{ color: accountingUi.ink, fontSize: 15, fontWeight: 800 }}>
                  Awaiting decision · {stableProposedRuleRows.length}
                </div>
                <div style={{ color: accountingUi.muted, fontSize: 12, fontWeight: 600, marginTop: 2 }}>
                  Donna noticed repeat coding for these vendors. Commit to make it a memory, or discard.
                </div>
              </div>
            </div>
          </div>
          <table style={{ width: '100%', minWidth: 0, tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, background: accountingUi.paper }}>
            <thead style={{ background: accountingUi.paper }}>
              <tr style={{ borderBottom: `1px solid ${V.border}` }}>
                <th style={{ ...accountingHeaderStyle, width: 152 }}>Status</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'left' }}>Pattern → account</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'left', width: 220 }}>Why this rule?</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'right', width: 220 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {stableProposedRuleRows.map((row, index) => {
                const ruleId = row.id;
                const summary = row.summary;
                const isCommitting = workingRuleId === `commit-${ruleId}`;
                const isDiscarding = workingRuleId === `discard-${ruleId}`;
                const busy = isCommitting || isDiscarding;
                const chipText = formatRuleChip(summary);
                const windowCopy = summary.window_days
                  ? `over the last ${summary.window_days} days`
                  : '';
                return (
                  <tr
                    key={ruleId}
                    aria-busy={busy ? 'true' : 'false'}
                    style={{
                      borderBottom: index < stableProposedRuleRows.length - 1 ? `1px solid ${accountingUi.ruleSoft}` : 'none',
                      background: busy ? V.surfaceAlt : 'transparent'
                    }}
                  >
                    <td style={{ ...accountingCellStyle, paddingLeft: 24 }}>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 9px',
                        borderRadius: 999,
                        background: accountingUi.accentSoft,
                        color: accountingUi.accent,
                        fontFamily: accountingUi.mono,
                        fontSize: 10,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em'
                      }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: accountingUi.accent }} />
                        {row.chipLabel}
                      </span>
                    </td>
                    <td style={{ ...accountingCellStyle, color: accountingUi.ink, fontSize: 13, fontWeight: 800 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {summary.pattern_display} → {summary.account_code}
                      </div>
                      <div style={{ marginTop: 6, color: accountingUi.muted, fontFamily: accountingUi.mono, fontSize: 10, fontWeight: 700 }}>
                        {summary.kind_display}
                        <UnqualifiedModelMarker decision={summary.proposed_by} messageId="mounted.model.proposedByUnqualifiedLocal" />
                      </div>
                    </td>
                    <td style={{ ...accountingCellStyle, color: accountingUi.muted, fontFamily: accountingUi.mono, fontSize: 11, fontWeight: 700 }}>
                      <div>{chipText}</div>
                      {windowCopy && (
                        <div style={{ marginTop: 4, fontSize: 10 }}>{windowCopy}</div>
                      )}
                      <div style={{ marginTop: 4, fontSize: 10 }}>{summary.confidence_band} confidence</div>
                    </td>
                    <td style={{ ...accountingCellStyle, textAlign: 'right', paddingRight: 24 }}>
                      <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(event) => { event.stopPropagation(); commitRule(ruleId, { row }); }}
                          style={accountingButtonStyle('apply', busy)}
                        >
                          {isCommitting ? 'Committing…' : 'Commit'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(event) => { event.stopPropagation(); discardRule(ruleId, { row }); }}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: accountingUi.alert,
                            fontFamily: accountingUi.sans,
                            fontSize: 12,
                            fontWeight: 800,
                            padding: '4px 6px',
                            cursor: busy ? 'wait' : 'pointer'
                          }}
                        >
                          {isDiscarding ? 'Discarding…' : 'Discard'}
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {financeTab === 'reconcile' && (stableOpenReviewRows.length > 0 ? (
        <div style={{ borderBottom: `1px solid ${accountingUi.rule}`, marginBottom: 34, overflowX: 'hidden', background: accountingUi.page }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'center', padding: '30px 24px 22px' }}>
            <div>
              <div style={{ color: accountingUi.muted, fontFamily: accountingUi.mono, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, marginBottom: 14 }}>
                AI review groups · {aiReviewGroups.length}
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', overflowX: 'auto', paddingBottom: 2 }}>
                <button
                  type="button"
                  onClick={() => setActiveAiGroupId('all')}
                  style={{
                    border: 'none',
                    borderRadius: 8,
                    background: activeAiGroupId === 'all' ? accountingUi.ink : accountingUi.card,
                    color: activeAiGroupId === 'all' ? accountingUi.paper : accountingUi.ink,
                    minWidth: 82,
                    padding: '13px 18px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: accountingUi.sans,
                    fontSize: 13,
                    fontWeight: 800,
                    boxShadow: activeAiGroupId === 'all' ? 'none' : '0 1px 0 rgba(26,24,21,0.05)'
                  }}
                >
                  All <span style={{ marginLeft: 6, color: activeAiGroupId === 'all' ? accountingUi.mutedSoft : accountingUi.muted }}>{stableOpenReviewRows.length}</span>
                </button>
                {aiReviewGroups.map((group) => {
                  const active = activeAiGroupId === group.id;
                  return (
                    <button
                      type="button"
                      key={group.id}
                      onClick={() => setActiveAiGroupId(group.id)}
                      style={{
                        border: `1px solid ${active ? accountingUi.ink : accountingUi.ruleSoft}`,
                        borderRadius: 8,
                        background: active ? accountingUi.ink : accountingUi.card,
                        color: active ? accountingUi.paper : accountingUi.ink,
                        minWidth: 190,
                        maxWidth: 270,
                        padding: '12px 16px',
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontFamily: accountingUi.sans,
                        boxShadow: active ? 'none' : '0 1px 0 rgba(26,24,21,0.05)'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, color: active ? accountingUi.paper : accountingUi.ink, fontSize: 13, fontWeight: 800, lineHeight: 1.2 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.merchant}</span>
                        <span style={{ color: active ? accountingUi.mutedSoft : accountingUi.muted }}>{group.count}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, color: active ? accountingUi.mutedSoft : accountingUi.muted, fontSize: 11, fontWeight: 700 }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: group.evidenceRequired ? accountingUi.alert : accountingUi.ok, flexShrink: 0 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.account} · {group.confidence}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', alignSelf: 'start', paddingTop: 28 }}>
              {batchReviewStatus && (
                <span style={{ fontSize: 12, color: workingReviewId === 'batch-ai' ? V.intel : V.pos }}>
                  {batchReviewStatus}
                </span>
              )}
              {onBatchSuggestTransactionCoding && (
                <button
                  type="button"
                  disabled={workingReviewId === 'batch-ai'}
                  onClick={runBatchAiReview}
                  style={{
                    border: `1px solid ${workingReviewId === 'batch-ai' ? V.border : V.intel}`,
                    background: workingReviewId === 'batch-ai' ? V.surfaceAlt : V.intelSurface,
                    color: workingReviewId === 'batch-ai' ? V.t4 : V.intel,
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '5px 8px',
                    cursor: workingReviewId === 'batch-ai' ? 'wait' : 'pointer'
                  }}
                >
                  {workingReviewId === 'batch-ai' ? 'AI scanning…' : 'AI scan open'}
                </button>
              )}
              {onRefreshTransactionIntel && (
                <button
                  type="button"
                  disabled={workingReviewId === 'batch-ai'}
                  onClick={onRefreshTransactionIntel}
                  style={{
                    border: `1px solid ${V.border}`,
                    background: V.surface,
                    color: V.t2,
                    borderRadius: 6,
                    fontSize: 12,
                    padding: '5px 8px',
                    cursor: workingReviewId === 'batch-ai' ? 'wait' : 'pointer'
                  }}
                >
                  Refresh
                </button>
              )}
            </span>
          </div>
          {batchSummary && (
            <div style={{ padding: '0 24px 18px' }}>
              {batchSummary && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: aiReviewGroups.length ? 10 : 0 }}>
                  {[
                    ['Scanned', batchSummary.scanned || 0],
                    ['Suggested', batchSummary.suggested || 0],
                    ['Auto-applied', batchSummary.auto_applied || 0],
                    ['Memories', batchSummary.remembered || 0]
                  ].map(([label, value]) => (
                    <div key={label} style={{ border: `1px solid ${V.borderSubtle}`, borderRadius: 6, padding: '7px 8px', background: V.surface }}>
                      <div style={{ fontSize: 10, color: V.t4, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
                        {label}
                      </div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: V.t1 }}>
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <table style={{ width: '100%', minWidth: 0, tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, background: accountingUi.paper }}>
            <thead style={{ background: accountingUi.paper }}>
              <tr style={{ borderBottom: `1px solid ${V.border}` }}>
                <th style={{ ...accountingHeaderStyle, width: 28 }} />
                <th style={{ ...accountingHeaderStyle, textAlign: 'left', width: 74 }}>Date</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'left' }}>Description</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'right', width: 118 }}>Amount</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'left', width: 238 }}>Category</th>
                <th style={{ ...accountingHeaderStyle, textAlign: 'right', width: 220 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleReviewRows.map((item, index) => {
                const match = item.match;
                const matchedDoc = match && match.matched_object_type === 'document'
                  ? documents.find((doc) => doc.id === match.matched_object_id) || null
                  : null;
                const isReceiptMatch = Boolean(match && match.payload?.source === 'receipt_reconciliation');
                const classifierSummary = isReceiptMatch ? classifierSummaryFor(matchedDoc) : null;
                const classifierChipText = classifierSummary ? formatClassifierChip(classifierSummary) : '';
                const autoExplainHint = isReceiptMatch ? autoExplainHintFor(match) : '';
                const suggestion = suggestionForItem(item);
                const busy =
                  workingReviewId.endsWith(`-${item.id}`) ||
                  Boolean(match?.id && (
                    workingReviewId === `confirm-${match.id}` ||
                    workingReviewId === `reject-${match.id}`
                  ));
                const isSuggesting = workingReviewId === `suggest-${item.id}`;
                const isApplying = workingReviewId === `apply-${item.id}`;
                const isRemembering = workingReviewId === `remember-${item.id}`;
                const isAsking = workingReviewId === `ask-${item.id}`;
                const isClosing = workingReviewId === `close-${item.id}`;
                const isConfirming = Boolean(match?.id && workingReviewId === `confirm-${match.id}`);
                const isRejecting = Boolean(match?.id && workingReviewId === `reject-${match.id}`);
                const suggestionNeedsReview = suggestionIsReviewOnly(suggestion);
                const canRequestAiReview = Boolean(
                  onSuggestTransactionCoding &&
                  item.transaction &&
                  (!suggestion || suggestionNeedsReview)
                );
                const isActive = activeReviewId === item.id;
                const categoryValue = categoryValueForItem(item);
                const categoryOptions = categoryOptionsForSuggestion(suggestion, categoryValue);
                const categoryCommitAccount = String(categoryValue || '').trim()
                  ? bestCategoryMatch(categoryValue, categoryOptions)?.account || ''
                  : '';
                const categoryApplyDisabled = !categoryCommitAccount || normalizeAccount(categoryCommitAccount) === 'suspense';
                const rowCellStyle = isActive ? activeAccountingCellStyle : accountingCellStyle;
                const rowChip = transactionStatusChip({ transaction: item.transaction, match });
                return (
                  <tr
                    key={item.id}
                    aria-busy={busy ? 'true' : 'false'}
                    onClick={() => {
                      // Stage A — primary row interaction now mirrors the
                      // documents inbox: a click opens the artifact panel
                      // for this tx. The inline "Review →" button stays
                      // as a secondary in-row quick-edit affordance for
                      // category/apply/ask without leaving the list.
                      // Falls back to inline expand only when there's no
                      // transaction to open (rare: bare review-queue
                      // items not bound to a tx).
                      if (item.transaction?.id) {
                        openTx(item.transaction.id);
                      } else {
                        setActiveReviewId(item.id);
                      }
                    }}
                    style={{
                      borderBottom: index < visibleReviewRows.length - 1 ? `1px solid ${accountingUi.ruleSoft}` : 'none',
                      background: busy ? V.surfaceAlt : isActive ? accountingUi.paper : 'transparent',
                      transition: 'background 120ms ease',
                      cursor: 'pointer'
                    }}
                  >
                    <td style={{ ...rowCellStyle, textAlign: 'center', paddingLeft: 24, paddingRight: 8 }} title={item.reason}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: statusDotColor(item, suggestion),
                          verticalAlign: 'middle'
                        }}
                      />
                    </td>
                    <td style={{ ...rowCellStyle, fontFamily: accountingUi.mono, fontSize: 13, fontWeight: 700, color: accountingUi.muted }}>
                      {compactDateLabel(item.date)}
                    </td>
                    <td style={{ ...rowCellStyle, color: accountingUi.ink, fontSize: isActive ? 14 : 13, fontWeight: 800, letterSpacing: 0 }}>
                      <div title={item.description || ''} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isActive ? 'normal' : 'nowrap' }}>
                        {item.description || '—'}
                      </div>
                      {isActive && item.reason && (
                        <div style={{ marginTop: 14, color: accountingUi.muted, fontSize: 12, fontWeight: 700 }}>
                          {item.reason.replace(/\.$/, '')}
                        </div>
                      )}
                      {isActive && suggestion && (
                        <div
                          style={{
                            marginTop: 12,
                            maxWidth: 720,
                            borderLeft: `2px solid ${accountingUi.amber}`,
                            borderRadius: 8,
                            background: 'rgba(26,24,21,0.025)',
                            padding: '10px 12px',
                            color: accountingUi.muted,
                            fontSize: 12,
                            fontWeight: 500,
                            lineHeight: 1.45
                          }}
                        >
                          <div style={{ fontFamily: accountingUi.mono, fontSize: 10, color: accountingUi.mutedSoft, textTransform: 'uppercase', letterSpacing: 0, marginBottom: 7 }}>
                            AI · {suggestion.model || 'model'} · {suggestion.confidence || 'low'} confidence
                            <UnqualifiedModelMarker decision={suggestion} />
                          </div>
                          {suggestion.reasoning || suggestion.ask_client_question || 'Review the category before applying.'}
                        </div>
                      )}
                    </td>
                    <td style={{ ...rowCellStyle, textAlign: 'right', fontFamily: accountingUi.mono, fontSize: 13, fontWeight: 800, color: item.amount > 0 ? V.pos : accountingUi.ink, whiteSpace: 'nowrap' }}>
                      {item.amount > 0 ? '+' : item.amount < 0 ? '−' : ''}{formatAmount(item.amount, item.currency)}
                    </td>
                    <td style={{ ...rowCellStyle, color: accountingUi.inkSoft, minWidth: 0 }}>
                      {match ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                          <StatusChip label={rowChip.label} tone={rowChip.tone} />
                          <span style={{ fontFamily: accountingUi.mono, fontSize: 10, color: accountingUi.muted, fontWeight: 600 }}>
                            {`${Math.round(Number(match.match_confidence || 0) * 100)}% · ${match.match_reason}`}
                          </span>
                          {classifierChipText && (
                            <span style={{
                              display: 'inline-flex',
                              padding: '2px 8px',
                              borderRadius: 6,
                              background: accountingUi.accentSoft,
                              color: accountingUi.accent,
                              fontFamily: accountingUi.mono,
                              fontSize: 10,
                              fontWeight: 700
                            }}>
                              {classifierChipText}
                            </span>
                          )}
                          {autoExplainHint && (
                            <span style={{
                              color: accountingUi.muted,
                              fontFamily: accountingUi.mono,
                              fontSize: 10,
                              fontWeight: 600
                            }}>
                              {autoExplainHint}
                            </span>
                          )}
                        </div>
                      ) : isActive ? (
                        <CategoryAutocomplete
                          value={categoryValue}
                          options={categoryOptions}
                          aiSource={suggestion?.source === 'openai'}
                          busy={busy}
                          onChange={(value) => setCategoryValueForItem(item.id, value)}
                          onCommit={(account) => commitCategoryForItem(item, account)}
                        />
                      ) : suggestion ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                          <StatusChip label={rowChip.label} tone={rowChip.tone} />
                          <span style={categoryChipStyle}>
                            {categoryValue}
                            {suggestion.source === 'openai' && (
                              <span style={{ color: accountingUi.amber, fontFamily: accountingUi.mono, fontSize: 9, fontWeight: 800 }}>
                                AI
                              </span>
                            )}
                          </span>
                        </div>
                      ) : (
                        <StatusChip label={rowChip.label} tone={rowChip.tone} />
                      )}
                    </td>
                    <td style={{ ...rowCellStyle, textAlign: 'right', whiteSpace: isActive ? 'normal' : 'nowrap', paddingRight: 24 }}>
                      {match && onUpdateReconciliationMatch ? (
                        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={(event) => { event.stopPropagation(); confirmMatch(match.id, { row: { match, document: matchedDoc }, action: 'confirm' }); }}
                            style={accountingButtonStyle('apply', busy)}
                          >
                            {isConfirming ? 'Confirming…' : 'Confirm'}
                          </button>
                          {isReceiptMatch && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(event) => { event.stopPropagation(); rejectMatch(match.id, { row: { match, document: matchedDoc } }); }}
                              style={{
                                border: 'none',
                                background: 'transparent',
                                color: accountingUi.alert,
                                fontFamily: accountingUi.sans,
                                fontSize: 12,
                                fontWeight: 800,
                                padding: '4px 6px',
                                cursor: busy ? 'wait' : 'pointer'
                              }}
                            >
                              {isRejecting ? 'Rejecting…' : 'Reject'}
                            </button>
                          )}
                        </span>
                      ) : item.transaction && onUpdateTransaction ? (
                        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
                          {isActive ? (
                            <span style={{ display: 'grid', gap: 12, justifyItems: 'end' }}>
                              <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
                                {/* Stage A — "See details" removed. The row click
                                    itself now opens the artifact panel, mirroring
                                    documents-inbox behaviour, so the inline button
                                    became a duplicate path. "Close" stays to
                                    collapse the inline quick-edit grid without
                                    leaving the list. */}
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setActiveReviewId('');
                                  }}
                                  style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color: accountingUi.ink,
                                    fontFamily: accountingUi.sans,
                                    fontSize: 12,
                                    fontWeight: 800,
                                    padding: 0,
                                    cursor: busy ? 'wait' : 'pointer'
                                  }}
                                >
                                  Close
                                </button>
                              </span>
                              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', maxWidth: 230 }}>
                              {canRequestAiReview && (
                                <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); requestCodingSuggestion(item); }} style={accountingButtonStyle('ask', busy)}>
                                  {isSuggesting ? 'Suggesting…' : 'Suggest'}
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={busy || categoryApplyDisabled}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  commitCategoryForItem(item, categoryValue);
                                }}
                                style={accountingButtonStyle('apply', busy, categoryApplyDisabled)}
                                title={categoryApplyDisabled ? 'Choose a category before applying.' : 'Apply this category.'}
                              >
                                {isApplying || isRemembering ? 'Applying…' : 'Apply'}
                              </button>
                              <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); askClientForSupport(item); }} style={accountingButtonStyle('ask', busy)}>
                                {isAsking ? 'Asking…' : '? Ask'}
                              </button>
                              </span>
                            </span>
                          ) : (
                            <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); setActiveReviewId(item.id); }} style={actionButtonStyle(accountingUi.inkSoft, busy)}>
                              Review {'->'}
                            </button>
                          )}
                        </span>
                      ) : onUpdateTransactionReviewItem ? (
                        <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); closeReviewItem(item.id); }} style={actionButtonStyle(V.t3, busy)}>
                          {isClosing ? 'Closing…' : 'Close'}
                        </button>
                      ) : (
                        <span style={{ color: V.t4 }}>Review</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibleReviewCount < filteredOpenReviewRows.length && (
            <div style={{ padding: '18px', textAlign: 'center', borderTop: `1px solid ${accountingUi.ruleSoft}`, background: accountingUi.page }}>
              <button
                type="button"
                onClick={() => setVisibleReviewCount((count) => count + 25)}
                style={{
                  border: `1px solid ${V.border}`,
                  background: accountingUi.card,
                  color: V.t2,
                  borderRadius: 8,
                  fontSize: 12,
                  padding: '8px 14px',
                  cursor: 'pointer'
                }}
              >
                Load more ({Math.min(25, filteredOpenReviewRows.length - visibleReviewCount)} of {filteredOpenReviewRows.length - visibleReviewCount})
              </button>
            </div>
          )}
        </div>
        ) : stableAutoMatchedRows.length === 0 ? (
          <div style={{ fontSize: 13, color: V.t4, padding: '16px 0 24px', textAlign: 'center' }}>
            No transactions to reconcile.
          </div>
        ) : null)}

        {financeTab === 'reconciled' && (handledRows.length > 0 ? (
          <div style={{ ...tableShell, margin: '30px 42px 34px' }}>
            <div style={{ padding: '9px 10px', borderBottom: `1px solid ${V.borderSubtle}`, fontSize: 12, color: V.t3 }}>
              Reconciled transactions
            </div>
            <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: V.surfaceAlt }}>
                <tr style={{ borderBottom: `1px solid ${V.border}` }}>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Status</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Transaction</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Amount</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Support</th>
                </tr>
              </thead>
              <tbody>
                {visibleHandledRows.map((item, index) => (
                  <tr
                    key={item.id}
                    onClick={() => item.transaction?.id && openTx(item.transaction.id)}
                    style={{
                      borderBottom: index < visibleHandledRows.length - 1 ? `1px solid ${V.borderSubtle}` : 'none',
                      cursor: item.transaction?.id ? 'pointer' : 'default'
                    }}
                  >
                    <td style={{ padding: '7px 10px' }}>
                      <Pill color={item.statusLabel === 'Explained' ? V.intel : V.pos} bg={item.statusLabel === 'Explained' ? V.intelSurface : V.posSurface}>
                        {item.statusLabel}
                      </Pill>
                    </td>
                    <td
                      style={{ padding: '7px 10px', color: V.t1 }}
                      title={item.description || ''}
                    >
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: V.t3, fontSize: 11, marginRight: 8 }}>
                        {toDayLabel(item.date)}
                      </span>
                      {item.description || '—'}
                    </td>
                    <td style={{ ...tdMono, textAlign: 'right', color: item.amount > 0 ? V.pos : V.t2 }}>
                      {item.amount > 0 ? '+' : item.amount < 0 ? '−' : ''}{formatAmount(item.amount, item.currency)}
                    </td>
                    <td style={{ padding: '7px 10px', color: V.t3, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.note}>
                      {item.note || 'Approved by reviewer'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleReconciledCount < handledRows.length && (
              <div style={{ padding: '10px', textAlign: 'center', borderTop: `1px solid ${V.borderSubtle}` }}>
                <button
                  type="button"
                  onClick={() => setVisibleReconciledCount((count) => count + 25)}
                  style={{
                    border: `1px solid ${V.border}`,
                    background: V.surface,
                    color: V.t2,
                    borderRadius: 6,
                    fontSize: 12,
                    padding: '6px 10px',
                    cursor: 'pointer'
                  }}
                >
                  Load more ({Math.min(25, handledRows.length - visibleReconciledCount)} of {handledRows.length - visibleReconciledCount})
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: V.t4, padding: '16px 0 24px', textAlign: 'center' }}>
            No reconciled transactions yet.
          </div>
        ))}
      {financeTab === 'reconcile' && overdueInvoices.length > 0 && (
        <div style={{ padding: '10px 16px', background: V.negSurface, borderRadius: 6, marginBottom: 24, fontSize: 13, color: V.neg, fontWeight: 500 }}>
          {overdueInvoices.length} overdue invoice{overdueInvoices.length !== 1 ? 's' : ''}: {overdueInvoices.map((invoice) =>
            `${formatAmount(invoice.total, invoice.currency)} (${invoice.counterparty || 'Unknown'})`
          ).join(', ')}
        </div>
      )}

      {financeTab === 'cashflow' && (
      <FinSection title="Cash flow" emptyMsg="No bank transactions" rows={data.monthlyCashFlow}>
        <div style={tableShell}>
          <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ background: V.surfaceAlt }}>
              <tr style={{ borderBottom: `1px solid ${V.border}` }}>
                <th style={{ ...thStyle, textAlign: 'left' }}>Month</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Income</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Expenses</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Net</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.monthlyCashFlow.map((month, index) => (
                <tr key={month.month} style={{ borderBottom: index < data.monthlyCashFlow.length - 1 ? `1px solid ${V.borderSubtle}` : 'none' }}>
                  <td style={{ padding: '7px 10px', color: V.t1, fontWeight: 500 }}>{toMonthLabel(month.month)}</td>
                  <td style={{ ...tdMono, textAlign: 'right', color: V.pos }}>{formatAmount(month.income, cur)}</td>
                  <td style={{ ...tdMono, textAlign: 'right', color: V.t2 }}>{formatAmount(month.expenses, cur)}</td>
                  <td style={{ ...tdMono, textAlign: 'right', fontWeight: 600, color: month.net >= 0 ? V.pos : V.neg }}>
                    {month.net >= 0 ? '+' : '−'}{formatAmount(month.net, cur)}
                  </td>
                  <td style={{ ...tdMono, textAlign: 'right', color: V.t3 }}>{month.closingBalance == null ? '—' : formatAmount(month.closingBalance, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinSection>
      )}

      {financeTab === 'categories' && (
      <FinSection
        title="Expenses by category"
        emptyMsg="No expense data"
        rows={data.expensesByCategory}
        summary={data.categorization ? `${data.categorization.coveragePct}% categorized` : ''}
      >
        <div style={tableShell}>
          <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ background: V.surfaceAlt }}>
              <tr style={{ borderBottom: `1px solid ${V.border}` }}>
                <th style={{ ...thStyle, textAlign: 'left' }}>Category</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                <th style={{ ...thStyle, textAlign: 'right', width: 50 }}>%</th>
                <th style={{ ...thStyle, textAlign: 'right', width: 50 }}>Txns</th>
              </tr>
            </thead>
            <tbody>
              {data.expensesByCategory.map((group, index) => {
                const color = CAT_COLORS[group.category] || V.t3;
                return (
                  <tr key={group.category} style={{ borderBottom: index < data.expensesByCategory.length - 1 ? `1px solid ${V.borderSubtle}` : 'none' }}>
                    <td style={{ padding: '7px 10px' }}>
                      <Pill color={color} bg={`${color}12`}>{group.label}</Pill>
                    </td>
                    <td style={{ ...tdMono, textAlign: 'right', color: V.t1, fontWeight: 600 }}>{formatAmount(group.total, cur)}</td>
                    <td style={{ ...tdMono, textAlign: 'right', color: V.t3 }}>{group.pct}%</td>
                    <td style={{ ...tdMono, textAlign: 'right', color: V.t4 }}>{group.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </FinSection>
      )}

      {financeTab === 'recent' && (
      <FinSection title="Recent transactions" emptyMsg="No transactions" rows={data.recentTransactions} summary={`last ${data.recentTransactions.length}`}>
        <div>
          {data.recentTransactions.map((tx, index) => {
            const color = CAT_COLORS[tx.category] || V.t4;
            return (
              <div
                key={tx.id}
                onClick={() => openTx(tx.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  cursor: 'pointer',
                  borderBottom: index < data.recentTransactions.length - 1 ? `1px solid ${V.borderSubtle}` : 'none'
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = V.surfaceHover;
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: V.t3, minWidth: 55 }}>{toDayLabel(tx.date)}</span>
                <span
                  style={{ fontSize: 12, color: V.t1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={tx.description || ''}
                >
                  {tx.counterparty || tx.description || '—'}
                </span>
                <Pill color={color} bg={`${color}12`}>{tx.categoryLabel}</Pill>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    fontWeight: 600,
                    minWidth: 85,
                    textAlign: 'right',
                    color: tx.amount > 0 ? V.pos : V.t2
                  }}
                >
                  {tx.amount > 0 ? '+' : '−'}{formatAmount(tx.amount, tx.currency)}
                </span>
              </div>
            );
          })}
        </div>
      </FinSection>
      )}

      {(payables.length > 0 || receivables.length > 0) && (
        <>
          <div style={{ fontSize: 11, color: V.t4, marginTop: 12, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
            Open items from uploaded invoices
          </div>
          {payables.length > 0 && (
            <OpenItemsSection title="Open payables" rows={payables} today={today} openDoc={openDoc} />
          )}
          {receivables.length > 0 && (
            <OpenItemsSection title="Open receivables" rows={receivables} today={today} openDoc={openDoc} receivable />
          )}
        </>
      )}
    </div>
  );
};

const OpenItemsSection = ({ title, rows, today, openDoc, receivable = false }) => (
  <FinSection title={title} emptyMsg="" rows={rows}>
    <div>
      {rows.map((row, index) => {
        const overdue = !receivable && row.due_date && row.due_date < today;
        return (
          <div
            key={row.document_id || index}
            onClick={() => row.document_id && openDoc(row.document_id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 0',
              cursor: row.document_id ? 'pointer' : 'default',
              borderBottom: index < rows.length - 1 ? `1px solid ${V.borderSubtle}` : 'none'
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = V.surfaceHover;
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
            }}
          >
            <span style={{ fontSize: 13, color: V.t1, fontWeight: 500, flex: 1 }}>{row.counterparty || row.issuer || 'Unknown'}</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: V.t3 }}>{row.invoice_number || '—'}</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: overdue ? V.neg : V.t4 }}>{row.due_date || '—'}</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: V.t1 }}>{formatAmount(row.total, row.currency)}</span>
            <Pill color={overdue ? V.neg : V.t3} bg={overdue ? V.negSurface : V.bgDeep}>
              {overdue ? 'overdue' : row.payment_status}
            </Pill>
          </div>
        );
      })}
    </div>
  </FinSection>
);

export default FinancialsView;
export { buildDocumentArtifactData, formatAmount };
