// Local-demo helpers; the database-backed workspace reads persisted verdicts.
const BANK_TRANSACTION_TEMPLATES = [
  {
    description: 'Stripe payout',
    money_in: 9500,
    money_out: 0,
    proposed_account: 'Sales',
    contact: 'Stripe Singapore',
    tax_treatment: 'GST check',
    confidence: 'medium',
    status: 'needs_review',
    reason: 'Platform payout should be matched to invoices or sales report before coding.'
  },
  {
    description: 'AWS Singapore services',
    money_in: 0,
    money_out: 384.2,
    proposed_account: 'Software subscriptions',
    contact: 'Amazon Web Services',
    tax_treatment: 'GST 9%',
    confidence: 'high',
    status: 'ready',
    reason: 'Recurring cloud vendor mapped from client rule candidate.'
  },
  {
    description: 'Wise transfer',
    money_in: 0,
    money_out: 2500,
    proposed_account: 'Intercompany transfer',
    contact: 'Wise',
    tax_treatment: 'Out of scope',
    confidence: 'medium',
    status: 'needs_review',
    reason: 'Likely bank movement, but counterparty account should be confirmed.'
  },
  {
    description: 'Founder card reimbursement',
    money_in: 0,
    money_out: 712.45,
    proposed_account: 'Director loan',
    contact: 'Director',
    tax_treatment: 'GST check',
    confidence: 'low',
    status: 'needs_client',
    reason: 'Needs receipt or business purpose before Xero coding.'
  }
];

const BILL_TRANSACTION_TEMPLATES = [
  {
    description: 'Supplier bill',
    money_in: 0,
    money_out: 1280,
    proposed_account: 'Professional fees',
    contact: 'Supplier from document',
    tax_treatment: 'GST check',
    confidence: 'medium',
    status: 'needs_review',
    reason: 'Supplier/contact was inferred from filename and needs firm confirmation.'
  }
];

const RECEIPT_TRANSACTION_TEMPLATES = [
  {
    description: 'Receipt reimbursement',
    money_in: 0,
    money_out: 86.3,
    proposed_account: 'Office expenses',
    contact: 'Receipt vendor',
    tax_treatment: 'GST check',
    confidence: 'low',
    status: 'needs_client',
    reason: 'Receipt needs business purpose before coding.'
  }
];

const normalizeFilenameStem = (filename = '') =>
  String(filename)
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeForMatch = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isClientGstRegistered = (client = {}) =>
  client.gstRegistered === true || client.taxProfile?.gstRegistered === true;

const taxTreatmentForClient = (client, preferred = 'No GST') =>
  isClientGstRegistered(client) ? preferred : 'No GST';

const ledgerCurrencyForClient = (client = {}) =>
  client.ledger_currency ||
  client.accountingCurrency ||
  client.baseCurrency ||
  client.taxProfile?.ledgerCurrency ||
  client.taxProfile?.baseCurrency ||
  '';

const moneyNearlyEqual = (left, right) =>
  Math.abs(Number(left || 0) - Number(right || 0)) < 0.01;

const TRUSTED_PARSER_FLAGS = new Set(['airwallex_table']);

const hasOutflowWords = (value = '') =>
  /\b(debit|payment|payout|withdrawal|fee|charge|transfer out|giro|fast payment|card|supplier)\b/i.test(value);

const hasInflowWords = (value = '') =>
  /\b(credit|deposit|receipt|incoming|refund|capital|investment|investor)\b/i.test(value);

const isLowInfoTransactionDescription = (description = '') =>
  /^(?:payout|deposit|transfer|payment|receipt)(?:\s+(?:eur|sgd|usd|gbp))?$/i.test(String(description).replace(/\s+/g, ' ').trim());

const extractWiseDetailDescription = (value = '') => {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  const payMatch = normalized.match(
    /\bpay\s+(?:[A-Z]{3}\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?\s+(?:[A-Z]{3}\s+)?to\s+(.+?)(?=\s+(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})|\s*$)/i
  );
  if (payMatch?.[1]) return `Pay to ${payMatch[1].trim()}`;

  const receiveMatch = normalized.match(
    /\b(?:receive|received)\s+(?:[A-Z]{3}\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?\s+(?:[A-Z]{3}\s+)?from\s+(.+?)(?=\s+(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})|\s*$)/i
  );
  if (receiveMatch?.[1]) return `Receive from ${receiveMatch[1].trim()}`;

  return '';
};

const extractWiseDetail = (value = '') => {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  const amountSource = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{2})?';
  const parseDetailAmount = (amount = '') => Number(String(amount).replace(/[^\d.]/g, ''));
  const payMatch = normalized.match(
    new RegExp(`\\bpay\\s+(?:([A-Z]{3})\\s+)?(${amountSource})(?:\\s+([A-Z]{3}))?\\s+to\\s+(.+?)(?=\\s+${amountSource}|\\s*$)`, 'i')
  );
  if (payMatch?.[2] && payMatch?.[4]) {
    return {
      description: `Pay to ${payMatch[4].trim()}`,
      amount: parseDetailAmount(payMatch[2]),
      currency: (payMatch[1] || payMatch[3] || '').toUpperCase(),
      direction: 'out'
    };
  }

  const receiveMatch = normalized.match(
    new RegExp(`\\b(?:receive|received)\\s+(?:([A-Z]{3})\\s+)?(${amountSource})(?:\\s+([A-Z]{3}))?\\s+from\\s+(.+?)(?=\\s+${amountSource}|\\s*$)`, 'i')
  );
  if (receiveMatch?.[2] && receiveMatch?.[4]) {
    return {
      description: `Receive from ${receiveMatch[4].trim()}`,
      amount: parseDetailAmount(receiveMatch[2]),
      currency: (receiveMatch[1] || receiveMatch[3] || '').toUpperCase(),
      direction: 'in'
    };
  }

  return null;
};

const findCurrencyAmount = (value = '', currency = '') => {
  if (!currency) return null;
  const amountSource = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{2})?';
  const escapedCurrency = currency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = Array.from(
    String(value).replace(/\s+/g, ' ').trim().matchAll(
      new RegExp(`(?:\\b${escapedCurrency}\\s+(${amountSource})|(${amountSource})\\s+${escapedCurrency}\\b)`, 'gi')
    )
  );
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  return Number(String(last[1] || last[2] || '').replace(/[^\d.]/g, ''));
};

const GENERIC_RULE_TRIGGERS = new Set([
  'director',
  'supplier',
  'supplier bill',
  'receipt',
  'receipt vendor',
  'transfer',
  'wise',
  'bank',
  'card'
]);

const buildId = (prefix, parts = []) => {
  const slug = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
  const entropy =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Date.now().toString(36);
  return `${prefix}-${slug || 'rule'}-${entropy}`;
};

const dateForRow = (uploadedAt, index) => {
  const base = uploadedAt ? new Date(uploadedAt) : new Date();
  base.setDate(Math.max(1, base.getDate() - index * 3));
  return base.toISOString().slice(0, 10);
};

const confidenceRank = {
  high: 3,
  medium: 2,
  low: 1
};

const statusCountsSeed = {
  total: 0,
  ready: 0,
  needs_review: 0,
  needs_client: 0,
  approved: 0
};

const templatesForDocument = (document) => {
  if (document.document_type === 'bank_statement') return BANK_TRANSACTION_TEMPLATES;
  if (
    document.document_type === 'supplier_bill' ||
    document.document_type === 'sales_invoice' ||
    document.document_type === 'issued_receipt'
  ) {
    return BILL_TRANSACTION_TEMPLATES;
  }
  if (document.document_type === 'receipt') return RECEIPT_TRANSACTION_TEMPLATES;
  return [];
};

const inferDraftForExtractedRow = (row = {}, client = {}) => {
  const description = String(row.description || '').toLowerCase();

  if (/stripe|shopify|payout|sales|customer receipt/.test(description)) {
    return {
      proposed_account: 'Sales',
      contact: description.includes('stripe') ? 'Stripe Singapore' : 'Customer',
      tax_treatment: taxTreatmentForClient(client, 'GST check'),
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Sales or payout row extracted from bank statement; match to invoice or payout report before sync.'
    };
  }
  if (/aws|amazon web services|software|subscription|saas|xero|openai|github|slack|zoom|notion|vercel|google cloud|microsoft|azure/.test(description)) {
    return {
      proposed_account: 'Software subscriptions',
      contact: description.includes('aws') || description.includes('amazon') ? 'Amazon Web Services' : 'Software vendor',
      tax_treatment: taxTreatmentForClient(client, 'GST 9%'),
      confidence: 'high',
      status: 'ready',
      reason: 'Recurring software vendor extracted from bank statement.'
    };
  }
  if (/salary|payroll|wages/.test(description)) {
    return {
      proposed_account: 'Payroll',
      contact: 'Employee payroll',
      tax_treatment: 'No GST',
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Payroll-like payment extracted from bank statement.'
    };
  }
  if (/cpf/.test(description)) {
    return {
      proposed_account: 'CPF payable',
      contact: 'CPF Board',
      tax_treatment: 'No GST',
      confidence: 'high',
      status: 'ready',
      reason: 'CPF contribution/payment extracted from bank statement.'
    };
  }
  if (/iras|income tax|corporate tax|withholding tax/.test(description)) {
    return {
      proposed_account: 'Tax payable',
      contact: 'IRAS',
      tax_treatment: 'No GST',
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Tax authority payment extracted from bank statement.'
    };
  }
  if (/acra|bizfile|annual return|filing/.test(description)) {
    return {
      proposed_account: 'Statutory filing fees',
      contact: 'ACRA',
      tax_treatment: 'No GST',
      confidence: 'high',
      status: 'ready',
      reason: 'Statutory filing fee extracted from bank statement.'
    };
  }
  if (/accounting|audit|bookkeeping|secretarial|corpsec|corporate secretary/.test(description)) {
    return {
      proposed_account: 'Accounting fees',
      contact: 'Professional services vendor',
      tax_treatment: taxTreatmentForClient(client, 'GST check'),
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Professional services vendor extracted from bank statement.'
    };
  }
  if (/rent|lease|wework|office lease/.test(description)) {
    return {
      proposed_account: 'Rent',
      contact: 'Landlord',
      tax_treatment: taxTreatmentForClient(client, 'GST check'),
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Office or rent-like payment extracted from bank statement.'
    };
  }
  if (/singtel|starhub|m1|telecom|mobile|internet|broadband/.test(description)) {
    return {
      proposed_account: 'Telecommunications',
      contact: 'Telecom vendor',
      tax_treatment: taxTreatmentForClient(client, 'GST check'),
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Telecommunications vendor extracted from bank statement.'
    };
  }
  if (/insurance|premium/.test(description)) {
    return {
      proposed_account: 'Insurance',
      contact: 'Insurance vendor',
      tax_treatment: taxTreatmentForClient(client, 'GST check'),
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Insurance payment extracted from bank statement.'
    };
  }
  if (/facebook|meta|google ads|linkedin|ads|advertising|marketing/.test(description)) {
    return {
      proposed_account: 'Marketing',
      contact: 'Marketing vendor',
      tax_treatment: taxTreatmentForClient(client, 'GST check'),
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Marketing or ads vendor extracted from bank statement.'
    };
  }
  if (/interest/.test(description) && row.money_in) {
    return {
      proposed_account: 'Interest income',
      contact: 'Bank',
      tax_treatment: 'No GST',
      confidence: 'high',
      status: 'ready',
      reason: 'Bank interest extracted from statement.'
    };
  }
  if (/fx|foreign exchange|currency conversion|exchange difference/.test(description)) {
    return {
      proposed_account: 'Foreign exchange gain/loss',
      contact: 'Bank',
      tax_treatment: 'Out of scope',
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Foreign exchange movement extracted from bank statement.'
    };
  }
  if (/wise|transfer|fast|paynow|giro|loan/.test(description)) {
    return {
      proposed_account: /loan/.test(description) ? 'Loan payable' : 'Intercompany transfer',
      contact: description.includes('wise') ? 'Wise' : 'Bank transfer',
      tax_treatment: 'Out of scope',
      confidence: 'medium',
      status: 'needs_review',
      reason: 'Transfer-like bank row; confirm counterparty account before Xero sync.'
    };
  }
  if (/fee|charge|bank charges|service fee/.test(description)) {
    return {
      proposed_account: 'Bank fees',
      contact: 'Bank',
      tax_treatment: 'No GST',
      confidence: 'high',
      status: 'ready',
      reason: 'Bank charge extracted from statement.'
    };
  }
  if (/grab|uber|taxi|restaurant|coffee|meal|travel/.test(description)) {
    return {
      proposed_account: /restaurant|coffee|meal/.test(description) ? 'Meals and entertainment' : 'Travel',
      contact: 'Card vendor',
      tax_treatment: taxTreatmentForClient(client, 'GST check'),
      confidence: 'low',
      status: 'needs_client',
      reason: 'Expense row needs business purpose or receipt before coding.'
    };
  }
  if (/director|founder|reimbursement|personal/.test(description)) {
    return {
      proposed_account: 'Director loan',
      contact: 'Director',
      tax_treatment: 'No GST',
      confidence: 'low',
      status: 'needs_client',
      reason: 'Director/founder movement needs evidence before coding.'
    };
  }

  return {
    proposed_account: 'Suspense',
    contact: row.money_in ? 'Customer' : 'Vendor',
    tax_treatment: taxTreatmentForClient(client, 'GST check'),
    confidence: row.confidence === 'high' ? 'medium' : 'low',
    status: 'needs_review',
    reason: 'Extracted from statement; Donna needs firm review before Xero sync.'
  };
};

export const getRuleStatusLabel = (status) => {
  if (status === 'approved') return 'Approved';
  if (status === 'dismissed') return 'Dismissed';
  if (status === 'suggested') return 'Suggested';
  return status || 'Suggested';
};

export const getRuleStatusVariant = (status) => {
  if (status === 'approved') return 'green';
  if (status === 'dismissed') return 'muted';
  if (status === 'suggested') return 'blue';
  return 'muted';
};

export const getRuleRiskVariant = (risk) => {
  if (risk === 'low') return 'green';
  if (risk === 'medium') return 'amber';
  return 'red';
};

export const deriveRuleTrigger = (transaction = {}) => {
  const contact = normalizeForMatch(transaction.contact);
  if (contact && !GENERIC_RULE_TRIGGERS.has(contact)) return contact;

  const description = normalizeForMatch(transaction.description);
  const words = description.split(' ').filter(Boolean);
  if (words.length <= 2) return description;
  return words.slice(0, 3).join(' ');
};

export const evaluateRuleRisk = (rule = {}) => {
  const flags = [];
  const matchText = normalizeForMatch(rule.match_text);
  const account = String(rule.proposed_account || '').toLowerCase();
  const taxTreatment = String(rule.tax_treatment || '').toLowerCase();

  if (!matchText || matchText.length < 5 || GENERIC_RULE_TRIGGERS.has(matchText)) {
    flags.push('Trigger is broad');
  }
  if (taxTreatment === 'gst 9%' && /(meals|travel|director|loan|reimbursement)/i.test(account)) {
    flags.push('Tax treatment needs review');
  }
  if (/(director loan|reimbursement)/i.test(`${account} ${matchText}`)) {
    flags.push('Evidence should stay required');
  }

  const risk = flags.length === 0 ? 'low' : flags.length === 1 ? 'medium' : 'high';
  return {
    risk,
    flags,
    louis_note:
      flags.length === 0
        ? 'Louis sees a narrow, repeatable rule.'
        : `Louis flags: ${flags.join('; ')}.`
  };
};

export const buildRuleFromTransaction = (transaction = {}) => {
  const matchText = deriveRuleTrigger(transaction);
  if (!transaction.client_id || !matchText) return null;

  const baseRule = {
    id: buildId('rule', [transaction.client_id, matchText]),
    client_id: transaction.client_id,
    status: 'suggested',
    match_text: matchText,
    label: `${matchText} -> ${transaction.proposed_account}`,
    proposed_account: transaction.proposed_account,
    contact: transaction.contact,
    tax_treatment: transaction.tax_treatment,
    source_transaction_id: transaction.id,
    source_description: transaction.description,
    created_at: Date.now(),
    updated_at: Date.now(),
    times_applied: 0
  };
  const risk = evaluateRuleRisk(baseRule);
  return { ...baseRule, ...risk };
};

const sameRule = (a = {}, b = {}) =>
  a.client_id === b.client_id &&
  normalizeForMatch(a.match_text) === normalizeForMatch(b.match_text) &&
  a.proposed_account === b.proposed_account &&
  a.tax_treatment === b.tax_treatment;

export const upsertSuggestedRule = (rules = [], transaction = {}) => {
  const nextRule = buildRuleFromTransaction(transaction);
  if (!nextRule) return rules;

  const existing = rules.find((rule) => sameRule(rule, nextRule) && rule.status !== 'dismissed');
  if (existing) return rules;

  return [nextRule, ...rules];
};

export const ruleMatchesTransaction = (rule = {}, transaction = {}) => {
  if (rule.status !== 'approved') return false;
  if (rule.client_id !== transaction.client_id) return false;
  const haystack = normalizeForMatch(`${transaction.description} ${transaction.contact}`);
  const needle = normalizeForMatch(rule.match_text);
  return needle.length >= 3 && haystack.includes(needle);
};

export const applyApprovedRuleToTransaction = (transaction = {}, rules = []) => {
  if (transaction.status === 'approved') return transaction;
  const matchedRule = rules.find((rule) => ruleMatchesTransaction(rule, transaction));
  if (!matchedRule) return transaction;

  const keepClientQuestion =
    matchedRule.flags?.includes('Evidence should stay required') && transaction.status === 'needs_client';
  const keepFxReview = transaction.ledger_conversion_status === 'needs_fx_rate';

  return {
    ...transaction,
    proposed_account: matchedRule.proposed_account,
    contact: matchedRule.contact,
    tax_treatment: matchedRule.tax_treatment,
    confidence: keepClientQuestion ? 'medium' : 'high',
    status: keepClientQuestion ? 'needs_client' : keepFxReview ? 'needs_review' : 'ready',
    matched_rule_id: matchedRule.id,
    reason: keepFxReview
      ? `Matched client rule: ${matchedRule.label}. Convert ${transaction.account_currency} to ${transaction.ledger_currency} before Xero sync.`
      : `Matched client rule: ${matchedRule.label}`,
    updated_at: Date.now()
  };
};

export const applyApprovedRulesToTransactions = (transactions = [], rules = []) =>
  transactions.map((transaction) => applyApprovedRuleToTransaction(transaction, rules));

export const summarizeRules = (rules = []) =>
  rules.reduce(
    (summary, rule) => {
      summary.total += 1;
      summary[rule.status] = (summary[rule.status] || 0) + 1;
      summary.highRisk += rule.risk === 'high' ? 1 : 0;
      return summary;
    },
    { total: 0, suggested: 0, approved: 0, dismissed: 0, highRisk: 0 }
  );

export const buildTransactionsForDocument = (client, document, rules = []) => {
  const templates = templatesForDocument(document);
  const stem = normalizeFilenameStem(document.filename);

  return templates.map((template, index) =>
    applyApprovedRuleToTransaction(
      {
        id: `txn-${document.id}-${index + 1}`,
        client_id: client.id,
        document_id: document.id,
        source_filename: document.filename,
        source_document_type: document.document_type,
        date: dateForRow(document.uploaded_at, index),
        description:
          document.document_type === 'bank_statement'
            ? template.description
            : `${template.description}: ${stem}`,
        money_in: template.money_in,
        money_out: template.money_out,
        proposed_account: template.proposed_account,
        contact: template.contact,
        tax_treatment: template.tax_treatment,
        confidence: template.confidence,
        status: template.status,
        reason: template.reason,
        client_question:
          template.status === 'needs_client'
            ? 'Please upload the receipt or confirm the business purpose.'
            : '',
        created_at: document.uploaded_at || Date.now(),
        updated_at: Date.now()
      },
      rules
    )
  );
};

export const buildTransactionsFromExtractedRows = (client, document, rows = [], rules = []) =>
  rows.map((row, index) => {
    const draft = inferDraftForExtractedRow(row, client);
    const currencyResolution = row.currency_resolution || document.currency_resolution || null;
    const accountCurrency = currencyResolution ? currencyResolution.currency || '' : row.account_currency || document.statement_currency || '';
    const ledgerCurrency = currencyResolution ? currencyResolution.ledger_currency || '' : row.ledger_currency || document.ledger_currency || ledgerCurrencyForClient(client);
    const conversionStatus = accountCurrency && ledgerCurrency ? (accountCurrency !== ledgerCurrency ? 'needs_fx_rate' : 'native') : '';
    const needsLedgerConversion = Boolean(accountCurrency && ledgerCurrency && accountCurrency !== ledgerCurrency);
    const convertedDraft = needsLedgerConversion && draft.status === 'ready'
      ? {
          ...draft,
          status: 'needs_review',
          reason: `${draft.reason} Convert ${accountCurrency} to ${ledgerCurrency} before Xero sync.`
        }
      : draft;
    return applyApprovedRuleToTransaction(
      {
        id: `txn-${document.id}-extracted-${index + 1}`,
        client_id: client.id,
        document_id: document.id,
        source_filename: document.filename,
        source_document_type: 'bank_statement',
        date: row.date || '',
        description: row.description || `Statement row ${index + 1}`,
        money_in: Number(row.money_in || 0),
        money_out: Number(row.money_out || 0),
        balance: row.balance ?? null,
        account_currency: accountCurrency,
        ledger_currency: ledgerCurrency,
        ledger_conversion_status: currencyResolution ? conversionStatus : needsLedgerConversion ? 'needs_fx_rate' : 'native',
        ...(currencyResolution ? { currency_resolution: currencyResolution } : {}),
        ledger_money_in: null,
        ledger_money_out: null,
        proposed_account: convertedDraft.proposed_account,
        contact: convertedDraft.contact,
        tax_treatment: convertedDraft.tax_treatment,
        confidence: convertedDraft.confidence,
        status: convertedDraft.status,
        reason: convertedDraft.reason,
        client_question:
          convertedDraft.status === 'needs_client'
            ? 'Please upload the receipt or confirm the business purpose for this transaction.'
            : '',
        extracted: true,
        source_line: row.source_line || '',
        parser_flags: row.parser_flags || [],
        created_at: document.uploaded_at || Date.now(),
        updated_at: Date.now()
      },
      rules
    );
  });

export const refreshTransactionDraftForClient = (transaction = {}, client = {}) => {
  if (!transaction.extracted || transaction.status === 'approved' || transaction.matched_rule_id) return transaction;

  const currencyResolution = transaction.currency_resolution;
  const accountCurrency = currencyResolution ? currencyResolution.currency || '' :
    transaction.account_currency || '';
  const ledgerCurrency = currencyResolution ? currencyResolution.ledger_currency || '' : transaction.ledger_currency || ledgerCurrencyForClient(client);
  const conversionStatus = !accountCurrency || !ledgerCurrency ? '' : accountCurrency !== ledgerCurrency ? 'needs_fx_rate' : 'native';
  const needsLedgerConversion = Boolean(accountCurrency && ledgerCurrency && accountCurrency !== ledgerCurrency);
  const wiseDetail = extractWiseDetail(transaction.source_line);
  const transactionAmount = Number(transaction.money_in || transaction.money_out || 0);
  const repairedDescription = (
    isLowInfoTransactionDescription(transaction.description) ||
    /^(?:payout|deposit|transfer|payment|receipt)\b/i.test(String(transaction.description || '').trim())
  )
    ? wiseDetail && moneyNearlyEqual(wiseDetail.amount, transactionAmount)
      ? wiseDetail.description
      : ''
    : '';
  const nonGstTaxPatch =
    !isClientGstRegistered(client) && transaction.tax_treatment !== 'No GST'
      ? { tax_treatment: 'No GST' }
      : null;
  const shouldRefreshAccount = transaction.proposed_account === 'Suspense';
  const currencyPatch =
    (accountCurrency && transaction.account_currency !== accountCurrency) ||
    transaction.ledger_currency !== ledgerCurrency ||
    transaction.ledger_conversion_status !== conversionStatus
      ? {
          account_currency: accountCurrency,
          ledger_currency: ledgerCurrency,
          ledger_conversion_status: conversionStatus
        }
      : null;
  const shouldHoldForFx = needsLedgerConversion && transaction.status === 'ready';
  const hasOpenEvidenceRequest = transaction.evidence_request?.status === 'open';
  const hasOpenClientAsk =
    transaction.status === 'needs_client' || hasOpenEvidenceRequest;
  const shouldRestoreClientAsk =
    hasOpenEvidenceRequest && transaction.status !== 'needs_client' && !transaction.client_reply;

  if (
    !shouldRefreshAccount &&
    !nonGstTaxPatch &&
    !repairedDescription &&
    !currencyPatch &&
    !shouldHoldForFx &&
    !shouldRestoreClientAsk
  ) {
    return transaction;
  }

  const draft = shouldRefreshAccount ? inferDraftForExtractedRow(transaction, client) : {};
  const draftPatch = shouldRefreshAccount
    ? {
        proposed_account: draft.proposed_account,
        contact: draft.contact,
        tax_treatment: draft.tax_treatment,
        confidence: hasOpenClientAsk ? transaction.confidence : draft.confidence,
        reason: hasOpenClientAsk ? transaction.reason : draft.reason,
        ...(hasOpenClientAsk ? {} : { status: draft.status })
      }
    : {};

  return {
    ...transaction,
    ...draftPatch,
    ...(repairedDescription ? { description: repairedDescription } : {}),
    ...(currencyPatch || {}),
    ...(shouldHoldForFx
      ? {
          status: 'needs_review',
          reason: `${transaction.reason || 'Extracted from statement.'} Convert ${accountCurrency} to ${ledgerCurrency} before Xero sync.`
        }
      : {}),
    ...(shouldRestoreClientAsk ? { status: 'needs_client' } : {}),
    ...nonGstTaxPatch,
    updated_at: Date.now()
  };
};

export const shouldKeepTransactionForClient = (transaction = {}) => {
  if (!transaction.extracted) return true;
  const text = normalizeForMatch(`${transaction.description} ${transaction.source_line}`);
  if (
    isLowInfoTransactionDescription(transaction.description) &&
    (
      !extractWiseDetail(transaction.source_line) ||
      !moneyNearlyEqual(extractWiseDetail(transaction.source_line)?.amount, Number(transaction.money_in || transaction.money_out || 0))
    )
  ) {
    return false;
  }
  return !/\b(opening balance|closing balance|balance brought forward|balance b f|b f balance|brought forward|brought fwd|available balance|ledger balance|account balance|current balance|previous balance|new balance|total balance)\b/.test(text);
};

export const ensureTransactionsForDocuments = (clients = [], documents = [], transactions = [], rules = []) => {
  const existingDocumentIds = new Set(transactions.map((transaction) => transaction.document_id));
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const additions = documents
    .filter((document) =>
      !existingDocumentIds.has(document.id) &&
      document.extraction_status !== 'extracting' &&
      document.extraction_status !== 'extracted' &&
      document.extraction_status !== 'failed'
    )
    .flatMap((document) => {
      const client = clientsById.get(document.client_id);
      if (!client) return [];
      return buildTransactionsForDocument(client, document, rules);
    });

  return additions.length > 0 ? [...additions, ...transactions] : transactions;
};

export const summarizeTransactions = (transactions = []) => {
  const summary = transactions.reduce(
    (counts, transaction) => {
      counts.total += 1;
      counts[transaction.status] = (counts[transaction.status] || 0) + 1;
      counts.moneyIn += Number(transaction.money_in || 0);
      counts.moneyOut += Number(transaction.money_out || 0);
      counts.lowConfidence += transaction.confidence === 'low' ? 1 : 0;
      counts.parserWarnings += (transaction.parser_flags || []).some((flag) => !TRUSTED_PARSER_FLAGS.has(flag)) ? 1 : 0;
      counts.fxPending += transaction.ledger_conversion_status === 'needs_fx_rate' ? 1 : 0;
      return counts;
    },
    { ...statusCountsSeed, moneyIn: 0, moneyOut: 0, lowConfidence: 0, parserWarnings: 0, fxPending: 0 }
  );
  summary.readyForXero = summary.ready + summary.approved;
  return summary;
};

export const getTransactionStatusLabel = (status) => {
  if (status === 'ready') return 'Ready';
  if (status === 'needs_review') return 'Review';
  if (status === 'needs_client') return 'Ask client';
  if (status === 'approved') return 'Approved';
  return status || 'Review';
};

export const getTransactionStatusVariant = (status) => {
  if (status === 'ready' || status === 'approved') return 'green';
  if (status === 'needs_review') return 'blue';
  if (status === 'needs_client') return 'amber';
  return 'muted';
};

export const getConfidenceVariant = (confidence) => {
  if (confidenceRank[confidence] >= 3) return 'green';
  if (confidenceRank[confidence] === 2) return 'amber';
  return 'red';
};

const evidenceTypeForTransaction = (transaction = {}) => {
  const description = normalizeForMatch(transaction.description);
  if (/restaurant|coffee|meal|travel|glovo|grab|taxi|hotel|flight/.test(description)) return 'Receipt and business purpose';
  if (/pay to|payout|transfer|wise|bank transfer/.test(description)) return 'Counterparty and purpose';
  if (/deposit|customer|sales|invoice|receipt/.test(description) || Number(transaction.money_in || 0) > 0) return 'Invoice or source of funds';
  if (transaction.ledger_conversion_status === 'needs_fx_rate') return 'FX rate confirmation';
  return 'Business purpose';
};

export const buildEvidenceRequestForTransaction = (transaction = {}, now = Date.now()) => {
  const existing = transaction.evidence_request || {};
  const sendCount = Number(existing.send_count || 0) + 1;
  const amount = Number(transaction.money_in || transaction.money_out || 0);
  const currency = transaction.account_currency || '';
  const direction = transaction.money_in ? 'money in' : 'money out';
  const text =
    transaction.client_question ||
    `Please confirm the business purpose and upload supporting evidence for this ${direction} transaction (${formatMoneyWithCurrency(amount, currency)} on ${transaction.date}).`;

  return {
    id: existing.id || `evidence-${transaction.id}`,
    status: 'open',
    evidence_type: existing.evidence_type || evidenceTypeForTransaction(transaction),
    question: text,
    sent_at: now,
    first_sent_at: existing.first_sent_at || now,
    send_count: sendCount,
    due_at: existing.due_at || now + 7 * 24 * 60 * 60 * 1000
  };
};

export const buildClientQuestionForTransaction = (transaction = {}) => {
  if (transaction.status !== 'needs_client' || transaction.client_reply) return null;
  const evidenceRequest = transaction.evidence_request || {};

  return {
    id: `txn-question-${transaction.id}`,
    transaction_id: transaction.id,
    evidence_request_id: evidenceRequest.id || null,
    filename: transaction.source_filename,
    text:
      evidenceRequest.question ||
      transaction.client_question ||
      `Please confirm the business purpose for ${transaction.description}.`,
    priority: transaction.confidence === 'low' ? 'high' : 'medium',
    source_label: transaction.description,
    evidence_type: evidenceRequest.evidence_type || evidenceTypeForTransaction(transaction),
    sent_at: evidenceRequest.sent_at,
    send_count: evidenceRequest.send_count || 0,
    amount_label: formatMoneyWithCurrency(
      Number(transaction.money_in || transaction.money_out || 0),
      transaction.account_currency || ''
    )
  };
};

export const formatMoney = (value = 0) =>
  Number(value || 0).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

export const formatMoneyWithCurrency = (value = 0, currency = '') =>
  `${formatMoney(value)}${currency ? ` ${currency}` : ''}`;
