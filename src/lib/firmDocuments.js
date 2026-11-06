export const DOCUMENT_REQUIREMENTS = [
  {
    id: 'bank_statements',
    label: 'Bank statements',
    detail: 'All operating accounts for the bookkeeping period',
    documentTypes: ['bank_statement']
  },
  {
    id: 'sales_invoices',
    label: 'Sales invoices',
    detail: 'Issued invoices and customer receipts',
    documentTypes: ['sales_invoice', 'issued_receipt']
  },
  {
    id: 'supplier_bills',
    label: 'Supplier bills',
    detail: 'Vendor bills, expense claims, and receipts',
    documentTypes: ['supplier_bill', 'receipt']
  },
  {
    id: 'payroll_cpf',
    label: 'Payroll and CPF',
    detail: 'Payroll files, CPF statements, and payslips',
    documentTypes: ['payroll_cpf']
  },
  {
    id: 'financing',
    label: 'Loans and financing',
    detail: 'Loan, lease, and facility statements',
    documentTypes: ['financing']
  },
  {
    id: 'xero_setup',
    label: 'Xero setup',
    detail: 'Existing Xero access, CoA, contacts, and tax settings',
    documentTypes: ['xero_setup', 'chart_of_accounts']
  }
];

export const DOCUMENT_TYPE_LABELS = {
  bank_statement: 'Bank statement',
  sales_invoice: 'Sales invoice',
  issued_receipt: 'Issued receipt',
  supplier_bill: 'Supplier bill',
  receipt: 'Receipt',
  payroll_cpf: 'Payroll / CPF',
  financing: 'Loan / financing',
  payment_account_statement: 'Payment account statement',
  payout_statement: 'Payout statement',
  deposit_slip: 'Deposit slip',
  xero_setup: 'Xero setup',
  chart_of_accounts: 'Chart of accounts',
  statutory_record: 'Statutory record',
  unknown: 'Needs sorting'
};

const DOCUMENT_STATUS_LABELS = {
  ready: 'Ready',
  received: 'Received',
  needs_info: 'Needs client',
  needs_review: 'Review',
  unknown: 'Needs sorting'
};

const MONTH_NAMES = {
  jan: 'Jan',
  january: 'Jan',
  feb: 'Feb',
  february: 'Feb',
  mar: 'Mar',
  march: 'Mar',
  apr: 'Apr',
  april: 'Apr',
  may: 'May',
  jun: 'Jun',
  june: 'Jun',
  jul: 'Jul',
  july: 'Jul',
  aug: 'Aug',
  august: 'Aug',
  sep: 'Sep',
  sept: 'Sep',
  september: 'Sep',
  oct: 'Oct',
  october: 'Oct',
  nov: 'Nov',
  november: 'Nov',
  dec: 'Dec',
  december: 'Dec'
};
const MONTH_BY_NUMBER = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
];

const fileNameFor = (file = {}) =>
  String(file.name || file.filename || 'Uploaded document').trim();

const normalizedNameFor = (file = {}) =>
  fileNameFor(file).toLowerCase().replace(/[_-]+/g, ' ');

const confidenceFor = (type) => {
  if (type === 'unknown') return 'low';
  if (type === 'receipt' || type === 'supplier_bill') return 'medium';
  return 'high';
};

export const getDocumentStatusLabel = (status) =>
  DOCUMENT_STATUS_LABELS[status] || status || 'Received';

export const getDocumentStatusVariant = (status) => {
  if (status === 'ready' || status === 'received') return 'green';
  if (status === 'needs_info') return 'amber';
  if (status === 'needs_review') return 'blue';
  if (status === 'unknown') return 'red';
  return 'muted';
};

// Async parse status pill — see docs/async-parsing-plan.md.
// PR 1 ships the labels + variants; until PR 2 the worker writes the
// intermediate states, every doc reads 'completed' / "Ready".
const PARSE_STATUS_LABELS = {
  pending: 'Queued',
  processing: 'Reading',
  completed: 'Ready',
  failed: 'Failed',
  skipped: 'Saved',
  duplicate_pending: 'Duplicate'
};

export const getParseStatusLabel = (parseStatus) =>
  PARSE_STATUS_LABELS[parseStatus] || PARSE_STATUS_LABELS.completed;

export const getParseStatusVariant = (parseStatus) => {
  if (parseStatus === 'completed') return 'green';
  if (parseStatus === 'processing') return 'blue';
  if (parseStatus === 'pending') return 'muted';
  if (parseStatus === 'failed') return 'red';
  if (parseStatus === 'duplicate_pending') return 'amber';
  if (parseStatus === 'skipped') return 'muted';
  return 'muted';
};

// Client-portal-facing copy + tone for the persisted parse_status verdict
// (the "Your uploads" status chip in donna-client-portal.jsx). Distinct
// from getParseStatusLabel / getParseStatusVariant above, which speak the
// firm's pipeline vocabulary ("Queued / Reading / Ready / Failed / Saved /
// Duplicate"): the client reads plain language about THEIR own document.
// `tone` names match the dossier palette buckets the portal maps to D
// tokens (pending / progress / success / error / warning / muted). This
// renders the PERSISTED verdict only — never a fresh re-inference. A
// null / unknown status falls back to "Filed" (completed), matching the
// snapshot's null→completed convention.
const CLIENT_UPLOAD_STATUS = {
  pending: { label: 'Received', tone: 'pending' },
  processing: { label: 'Reading', tone: 'progress' },
  completed: { label: 'Filed', tone: 'success' },
  failed: { label: "Couldn't read", tone: 'error' },
  skipped: { label: 'On file', tone: 'muted' },
  duplicate_pending: { label: 'Duplicate', tone: 'warning' }
};

export const getClientUploadStatus = (parseStatus) =>
  CLIENT_UPLOAD_STATUS[parseStatus] || CLIENT_UPLOAD_STATUS.completed;

export const getDocumentRequirementForType = (documentType) =>
  DOCUMENT_REQUIREMENTS.find((requirement) =>
    requirement.documentTypes.includes(documentType)
  ) || null;

export const classifyDocumentFile = (file = {}) => {
  const name = normalizedNameFor(file);
  const mimeType = String(file.type || file.mime_type || '').toLowerCase();

  // PR 18 — contracts. Specific contract-language patterns matched
  // BEFORE the bank-statement and bill/invoice branches:
  //   - "Statement of Work — Phase 2.pdf" contains "statement", which
  //     the bank_statement pattern below catches greedily. Putting
  //     contracts first lets "statement of work" / "SOW" win cleanly.
  //   - "Vendor agreement.pdf" would otherwise be caught by the bill
  //     side's bare "vendor" qualifier.
  // The financing branch below still catches bare loan / lease
  // filenames (no agreement word); contract-version words like
  // "loan agreement" / "lease agreement" win here first.
  if (/\b(contract|agreement|msa|sow|nda|non[- ]disclosure|engagement letter|service agreement|subscription agreement|license agreement|lease agreement|loan agreement|credit agreement|facility agreement|employment agreement|employment contract|master services|statement of work)\b/.test(name)) {
    return 'contract';
  }
  // "Bank Fee" / "Bank Charge" / "Bank Service Charge" are fee
  // assessment notices from a bank, NOT multi-transaction account
  // statements. Route to supplier_bill so the bill extractor reads
  // the single charge; the bare `\bbank\b` in the bank_statement
  // branch below would otherwise swallow them greedily and the
  // bank-statement extractor would produce garbled transaction rows
  // (confirmed: Honeybee Hills `25-06-30_Bank_Fee_25.pdf` generated
  // phantom SGD transactions with OCR garbage).
  if (/\bbank\b/.test(name) && /\b(fee|charge|service charge)\b/.test(name)) {
    return 'supplier_bill';
  }
  // Payment-processor PAYOUTS / SETTLEMENTS are the processor remitting
  // the firm's OWN sales revenue to the firm — money flows IN. They
  // classify as `payout_statement` (RT-18, its own family: the payout
  // extractor reads the gross → fees → net breakdown and the payout
  // matcher scans money_in); before the family existed they rode
  // `issued_receipt`, and a misroute to the money_out `receipt` matcher
  // leaves a deposit stuck forever in "awaiting a bank line" (CLAUDE.md
  // Failure A/B — wrong-DIRECTION classification is the worst failure mode).
  //
  // Require BOTH a processor brand AND a payout/settlement signal: a
  // genuine purchase FROM one of these brands (a "Stripe Bill", a Square
  // card-reader receipt, a PayPal subscription invoice) is still money-OUT
  // and must keep routing to supplier_bill/receipt via the branches below.
  // Placed BEFORE the bank_statement branch because `wise`/`revolut` live
  // in that keyword list — a bare "Wise Statement" still falls through to
  // bank_statement (no payout signal), but "Wise Payout" wins here.
  //
  // This is a HINT, not the classifier: the brand list is deliberately not
  // grown (a hand-maintained brand list is a country corner by
  // construction — firmDocuments.test.js pins that boundary); the router
  // reads the document and carries every payout and deposit slip the
  // filename layer cannot name.
  if (
    /\b(shopify|stripe|square|paypal|adyen|gocardless|sumup|toast|payoneer|braintree|worldpay|klarna|mollie|wise|revolut)\b/.test(name) &&
    /\b(payout|settlement|remittance|disbursement|net deposit)\b/.test(name)
  ) {
    return 'payout_statement';
  }
  if (/\b(bank|statement|account statement|account statement report|accountstmt|asr|acct|dbs|posb|ocbc|uob|wise|revolut|hsbc|citi|citibank|maybank|standard chartered|scb)\b/.test(name)) {
    return 'bank_statement';
  }
  // Order matters here. AP-direction qualifiers must be matched
  // BEFORE the sales-invoice fallback below so "vendor invoice" or
  // "purchase invoice" don't accidentally land in the AR bucket via
  // the bare-`invoice` catch-all.
  if (/\b(supplier|vendor|bill|ap invoice|purchase invoice|supplier invoice|vendor invoice)\b/.test(name)) {
    return 'supplier_bill';
  }
  // Specific AR-direction qualifiers followed by a bare-`invoice`
  // fallback. Real-world filenames generated by billing systems
  // (Stripe, Xero, QuickBooks) are typically `Invoice-NNNN.pdf` or
  // `INV-2026-001.pdf` — no qualifier, but overwhelmingly outgoing
  // sales invoices. A bare `\binvoice\b` here catches them and routes
  // to the AR extractor; the supplier_bill branch above protects
  // against misroutes of AP-qualified filenames.
  if (/\b(sales invoice|customer invoice|tax invoice|ar invoice|invoice|inv)\b/.test(name)) {
    return 'sales_invoice';
  }
  if (/\b(receipt|expense|claim|reimbursement)\b/.test(name)) {
    return 'receipt';
  }
  if (/\b(payroll|cpf|payslip|salary|iras|form ir8a)\b/.test(name)) {
    return 'payroll_cpf';
  }
  // Outgoing-payment confirmations. Filenames like
  // `25-06-16_IRS_Tax_Payment_3683.67.pdf` or
  // `25-08-18_Amex_Payment_941.42.pdf` are records of YOU paying a
  // counterparty (credit card, tax authority, lender) — they have a
  // date and an amount but no vendor selling goods/services, no line
  // items, no invoice number. Routing them to the supplier-bill
  // extractor returns DOCUMENT_EXTRACTION_UNREADABLE because the
  // LLM correctly notices the schema doesn't fit. Give them their
  // own bucket so they're stored cleanly (no LLM call, no error) and
  // can be reconciled against the bank-statement debit.
  //
  // Placed AFTER receipt/payroll (so "Payment receipt" still routes
  // to the receipt extractor) and BEFORE the amount-in-filename
  // supplier_bill fallback below.
  if (/\bpayment\b/.test(name) && /(?<!\d)\d+\.\d{2}(?!\d)/.test(name)) {
    return 'payment_confirmation';
  }
  // Amount-in-filename heuristic. US-style AP filenames often follow
  // `YY-MM-DD_Vendor_Amount.pdf` (e.g. `25-06-04_Dadant_120.77.pdf`)
  // where the vendor word doesn't match any of the SG-flavoured
  // keywords above. A decimal amount in the filename is a strong
  // signal this is a transactional document — route it to the
  // supplier-bill extractor instead of falling through to `unknown`
  // (which the worker marks `skipped` → "no parsing for this type"
  // in the upload tray). Placed BEFORE the financing branch so
  // `Land_Lease_831.35.pdf` (a recurring lease payment, not the
  // lease contract itself) routes to the bill extractor; bare
  // `lease`/`loan` filenames without an amount still hit financing.
  if (/(?<!\d)\d+\.\d{2}(?!\d)/.test(name)) {
    return 'supplier_bill';
  }
  if (/\b(loan|lease|facility|financing|interest|principal)\b/.test(name)) {
    return 'financing';
  }
  if (/\b(xero|quickbooks|coa|chart of accounts|contacts export)\b/.test(name)) {
    return name.includes('coa') || name.includes('chart of accounts')
      ? 'chart_of_accounts'
      : 'xero_setup';
  }
  if (/\b(bizfile|acra|business profile|constitution|resolution)\b/.test(name)) {
    return 'statutory_record';
  }
  // CSV terminal fallback → bank_statement: the delimited bank-statement
  // lane is the only CSV-capable extractor in the tree, so a keyword-less
  // CSV routes there rather than to the supplier-bill LLM extractor
  // (design-donna-csv-statement-intake.md §3). Filename keywords above
  // still win first. Matches by mime OR extension because Windows/Excel
  // declares .csv as application/vnd.ms-excel (neither 'csv' nor
  // 'spreadsheet'). True spreadsheet mimes (XLSX) keep the prior fallback.
  if (mimeType.includes('csv') || /\.csv$/.test(name)) {
    return 'bank_statement';
  }
  if (mimeType.includes('spreadsheet')) {
    return 'supplier_bill';
  }

  return 'unknown';
};

export const inferPeriodLabel = (filename = '') => {
  const normalized = String(filename).toLowerCase().replace(/[_-]+/g, ' ');
  const yearMonth = normalized.match(/\b(20\d{2})[ ./-]?(0[1-9]|1[0-2])\b/);
  if (yearMonth) {
    const month = MONTH_BY_NUMBER[Number(yearMonth[2]) - 1];
    return `${month} ${yearMonth[1]}`;
  }

  const monthYear = normalized.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(20\d{2})\b/
  );
  if (monthYear) {
    return `${MONTH_NAMES[monthYear[1]] || monthYear[1]} ${monthYear[2]}`;
  }

  const quarter = normalized.match(/\bq([1-4])\s*(20\d{2})\b/);
  if (quarter) return `Q${quarter[1]} ${quarter[2]}`;

  const year = normalized.match(/\b(20\d{2})\b/);
  return year ? year[1] : '';
};

const buildDocumentId = (clientId, filename, index = 0) => {
  const slug = `${clientId}-${filename}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  const entropy =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}-${index}`;
  return `doc-${slug || 'upload'}-${entropy}`;
};

export const buildDocumentRecord = (file, clientId, options = {}) => {
  const filename = fileNameFor(file);
  const documentType = classifyDocumentFile(file);
  const periodLabel = inferPeriodLabel(filename);
  const requirement = getDocumentRequirementForType(documentType);
  const missingFields = [];

  if (documentType === 'unknown') {
    missingFields.push('document type');
  }
  if (documentType === 'bank_statement' && !periodLabel) {
    missingFields.push('statement period');
  }
  if (
    documentType === 'sales_invoice' ||
    documentType === 'supplier_bill' ||
    documentType === 'issued_receipt'
  ) {
    missingFields.push('Xero contact');
  }

  const status =
    documentType === 'unknown'
      ? 'unknown'
      : missingFields.length > 0
        ? 'needs_info'
        : 'received';

  return {
    id: buildDocumentId(clientId, filename, options.index || 0),
    client_id: clientId,
    filename,
    uploaded_at: options.uploadedAt || Date.now(),
    size: Number(file?.size || 0),
    mime_type: file?.type || file?.mime_type || '',
    document_type: documentType,
    document_label: DOCUMENT_TYPE_LABELS[documentType] || DOCUMENT_TYPE_LABELS.unknown,
    requirement_id: requirement?.id || null,
    period_label: periodLabel,
    confidence: confidenceFor(documentType),
    status,
    missing_fields: missingFields,
    client_reply: '',
    donna_note: buildDonnaDocumentNote(documentType, missingFields)
  };
};

export const buildDonnaDocumentNote = (documentType, missingFields = []) => {
  if (documentType === 'unknown') {
    return 'I received this and need one label before I can route it.';
  }
  if (missingFields.length > 0) {
    return `I received this as ${DOCUMENT_TYPE_LABELS[documentType]}. I need ${missingFields.join(' and ')} before Xero prep.`;
  }
  return `I received this as ${DOCUMENT_TYPE_LABELS[documentType]} and queued it for Xero prep.`;
};

export const buildClientQuestionForDocument = (document = {}) => {
  if (document.client_reply) return null;

  if (document.document_type === 'unknown') {
    return {
      id: `question-${document.id}`,
      document_id: document.id,
      filename: document.filename,
      text: 'What kind of document is this?',
      priority: 'high'
    };
  }

  if (document.missing_fields?.includes('statement period')) {
    return {
      id: `question-${document.id}`,
      document_id: document.id,
      filename: document.filename,
      text: 'Which month or period does this statement cover?',
      priority: 'medium'
    };
  }

  if (document.missing_fields?.includes('Xero contact')) {
    // Donna ledger framing: ask for the counterparty (customer or supplier)
    // for evidence/business-purpose context, not "Xero prep".
    return {
      id: `question-${document.id}`,
      document_id: document.id,
      filename: document.filename,
      text: 'Which customer or supplier is this with? Add a brief business-purpose note if you can.',
      priority: 'medium'
    };
  }

  return null;
};

export const summarizeDocumentReadiness = (documents = [], clientId = null) => {
  const scoped = clientId
    ? documents.filter((document) => document.client_id === clientId)
    : documents;

  return scoped.reduce(
    (summary, document) => {
      summary.total += 1;
      summary.byStatus[document.status] = (summary.byStatus[document.status] || 0) + 1;
      summary.byType[document.document_type] = (summary.byType[document.document_type] || 0) + 1;
      if (document.status === 'received' || document.status === 'ready') summary.ready += 1;
      if (document.status === 'needs_info' || document.status === 'unknown') summary.needsClient += 1;
      if (document.status === 'needs_review') summary.needsReview += 1;
      if (!summary.latestUpload || document.uploaded_at > summary.latestUpload) {
        summary.latestUpload = document.uploaded_at;
      }
      return summary;
    },
    {
      total: 0,
      ready: 0,
      needsClient: 0,
      needsReview: 0,
      latestUpload: null,
      byStatus: {},
      byType: {}
    }
  );
};

export const formatDocumentSize = (bytes = 0) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const pluralize = (count, singular, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

const latestDocumentTime = (documents = []) =>
  documents.reduce((latest, document) => Math.max(latest, document.uploaded_at || 0), 0) || Date.now();

const filenamesFor = (documents = []) =>
  documents.map((document) => document.filename).filter(Boolean);

const documentQuestionsFor = (documents = []) =>
  documents.map(buildClientQuestionForDocument).filter(Boolean);

const buildConversation = (label, lines = []) => [
  { role: 'Client', text: label },
  ...lines.map((text) => ({ role: 'Donna', text }))
];

export const DOCUMENT_QUEUE_SOURCE = 'client_document_intake';

export const buildDocumentQueueItems = (client, documents = []) => {
  if (!client) return [];

  const pendingClientDocs = documents.filter((document) =>
    (document.status === 'needs_info' || document.status === 'unknown') && !document.client_reply
  );
  const reviewDocs = documents.filter((document) => document.status === 'needs_review');
  const xeroPrepDocs = documents.filter((document) => document.status === 'received');
  const items = [];

  if (pendingClientDocs.length > 0) {
    const questions = documentQuestionsFor(pendingClientDocs);
    const questionText = questions[0]?.text || 'Please confirm the missing bookkeeping details.';
    items.push({
      id: `firm-doc-client-ask-${client.id}`,
      client_id: client.id,
      client_name: client.companyName,
      trigger_type: 'firm_accounting_document_intake',
      trigger_id: 'client_document_questions',
      hold_reason: 'missing_document',
      created_at: latestDocumentTime(pendingClientDocs),
      confidence: 'high',
      queue_label: 'auto_send',
      pattern_category: 'bookkeeping_document_intake',
      queue_reason: 'Donna can chase missing bookkeeping metadata without accounting judgment.',
      problem_summary: `${client.companyName} has ${pluralize(pendingClientDocs.length, 'uploaded document')} missing classification or Xero metadata.`,
      user_stuck_on: questionText,
      donna_response:
        `Thanks for the upload. I need a little more detail before I can prepare this for Xero: ${questions.map((question) => question.text).join(' ')}`,
      conversation: buildConversation(
        `Uploaded ${pluralize(pendingClientDocs.length, 'document')}`,
        questions.map((question) => `${question.filename}: ${question.text}`)
      ),
      root_cause: {
        hypothesis: 'The client uploaded bookkeeping evidence but Donna needs metadata before Xero prep.',
        evidence: questions.map((question) => `${question.filename}: ${question.text}`),
        confidence: 'high'
      },
      proposed_fix: {
        owner: 'client_intake',
        steps: ['Ask client for missing metadata', 'Keep document in client follow-up state', 'Move to firm review after reply']
      },
      evidence_requested: questions.map((question) => question.text),
      escalation_flag: false,
      generated_from: DOCUMENT_QUEUE_SOURCE
    });
  }

  if (reviewDocs.length > 0) {
    items.push({
      id: `firm-doc-review-${client.id}`,
      client_id: client.id,
      client_name: client.companyName,
      trigger_type: 'firm_accounting_document_intake',
      trigger_id: 'document_reply_review',
      hold_reason: 'confidence_low',
      created_at: latestDocumentTime(reviewDocs),
      confidence: 'medium',
      queue_label: 'ops_review',
      pattern_category: 'bookkeeping_document_intake',
      queue_reason: 'Client supplied missing document context. Firm should review before marking it ready for Xero.',
      problem_summary: `${client.companyName} has ${pluralize(reviewDocs.length, 'bookkeeping document')} ready for firm review.`,
      user_stuck_on: 'Review client document context before Xero prep.',
      donna_response:
        'Thanks. I have the document context and will prepare this for Xero.',
      conversation: buildConversation(
        `Answered ${pluralize(reviewDocs.length, 'document question')}`,
        reviewDocs.map((document) => `${document.filename}: ${document.client_reply || 'Client reply received'}`)
      ),
      root_cause: {
        hypothesis: 'The client answered Donna follow-up questions and the firm needs to approve the mapping.',
        evidence: reviewDocs.map((document) => `${document.filename}: ${document.client_reply || 'reply received'}`),
        confidence: 'medium'
      },
      proposed_fix: {
        owner: 'bookkeeping_review',
        steps: ['Review supplied context', 'Set document period/contact/category', 'Mark ready for Xero prep']
      },
      evidence_requested: filenamesFor(reviewDocs),
      escalation_flag: false,
      generated_from: DOCUMENT_QUEUE_SOURCE
    });
  }

  if (xeroPrepDocs.length > 0) {
    items.push({
      id: `firm-doc-xero-prep-${client.id}`,
      client_id: client.id,
      client_name: client.companyName,
      trigger_type: 'firm_accounting_document_intake',
      trigger_id: 'document_xero_prep',
      hold_reason: 'confidence_low',
      created_at: latestDocumentTime(xeroPrepDocs),
      confidence: 'medium',
      queue_label: 'execution_queue',
      pattern_category: 'xero_handoff',
      queue_reason: 'Documents have enough metadata to begin Xero setup, coding, or reconciliation prep.',
      problem_summary: `${client.companyName} has ${pluralize(xeroPrepDocs.length, 'received document')} ready for Xero prep.`,
      user_stuck_on: 'Prepare received documents for Xero.',
      donna_response:
        'I have the documents and enough metadata to start the Xero prep queue.',
      conversation: buildConversation(
        `Uploaded ${pluralize(xeroPrepDocs.length, 'ready document')}`,
        xeroPrepDocs.map((document) => `${document.filename}: ${document.document_label}`)
      ),
      root_cause: {
        hypothesis: 'Bookkeeping documents are ready for coding, reconciliation, or Xero setup.',
        evidence: filenamesFor(xeroPrepDocs),
        confidence: 'medium'
      },
      proposed_fix: {
        owner: 'xero_handoff',
        steps: ['Map documents to Xero objects', 'Apply client-specific coding rules', 'Sync after firm approval']
      },
      evidence_requested: filenamesFor(xeroPrepDocs),
      escalation_flag: false,
      generated_from: DOCUMENT_QUEUE_SOURCE
    });
  }

  return items;
};
