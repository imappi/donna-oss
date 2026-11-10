// Labels for values that code inserts into an interface sentence. The value
// itself (a stored code, a model's free-text guess) never changes and never
// reaches the screen as it is stored: a known code reads as its catalog label,
// anything else as its kind's catalog fallback. The messages live in
// src/i18n/catalogs/interfaceValues.*.js.

const message = (formatMessage, id, defaultMessage, values) => (
  typeof formatMessage === 'function'
    ? formatMessage({ id, defaultMessage }, values)
    : defaultMessage
);

// Stored document types (the documents.document_type vocabulary) and the
// generic extractor's example guesses (server/donna/genericDocument.js prompt),
// in snake case. Scope slugs (supplier-bill) and humanised guesses
// (tax notice) normalise to the same code.
const DOCUMENT_TYPE_MESSAGES = Object.freeze({
  receipt: ['upload.documentType.receipt', 'receipt'],
  supplier_bill: ['upload.documentType.supplierBill', 'supplier bill'],
  sales_invoice: ['upload.documentType.salesInvoice', 'sales invoice'],
  issued_receipt: ['upload.documentType.issuedReceipt', 'issued receipt'],
  payment_confirmation: ['upload.documentType.paymentConfirmation', 'payment confirmation'],
  payment_account_statement: ['upload.documentType.paymentAccountStatement', 'payment account statement'],
  contract: ['upload.documentType.contract', 'contract'],
  payout_statement: ['upload.documentType.payoutStatement', 'payout statement'],
  deposit_slip: ['upload.documentType.depositSlip', 'deposit slip'],
  bank_statement: ['upload.documentType.bankStatement', 'bank statement'],
  statutory_record: ['upload.documentType.statutoryRecord', 'registry document'],
  company_or_statutory_record: ['upload.documentType.statutoryRecord', 'registry document'],
  tax_notice: ['upload.documentType.taxNotice', 'tax notice'],
  government_letter: ['upload.documentType.governmentLetter', 'letter from an authority'],
  insurance_policy: ['upload.documentType.insurancePolicy', 'insurance policy'],
  utility_bill: ['upload.documentType.utilityBill', 'utility bill'],
  rental_agreement: ['upload.documentType.rentalAgreement', 'rental agreement'],
  safety_certificate: ['upload.documentType.safetyCertificate', 'safety certificate']
});
const OTHER_DOCUMENT = ['upload.documentType.other', 'other document'];

export const documentTypeCode = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');

// A document type in mid-sentence form ("Saved · {documentType}").
export const trayDocumentTypeLabel = (value, formatMessage = null) => {
  const [id, fallback] = DOCUMENT_TYPE_MESSAGES[documentTypeCode(value)] || OTHER_DOCUMENT;
  return message(formatMessage, id, fallback);
};

// The ask-client prompt's {businessUse} phrase.
export const askClientBusinessUse = (moneyIn, formatMessage = null) => (
  moneyIn
    ? message(formatMessage, 'transaction.question.businessIncome', 'business income')
    : message(formatMessage, 'transaction.question.businessExpense', 'a business expense')
);

// The ask-client prompt's {transaction} phrase: which line, and when / how
// much when known. `date` and `amount` arrive already formatted.
export const askClientTransactionPhrase = ({ vendor = null, date = null, amount = null } = {}, formatMessage = null) => {
  const subject = vendor
    ? message(formatMessage, 'transaction.question.subjectNamed', `the ${vendor} transaction`, { vendor })
    : message(formatMessage, 'transaction.question.subjectUnnamed', 'this transaction');
  const known = [date, amount].filter((value) => value && value !== '—');
  if (!known.length) return subject;
  const detail = known.length === 2
    ? message(formatMessage, 'transaction.question.dateAmount', `${date} for ${amount}`, { date, amount })
    : known[0];
  return message(formatMessage, 'transaction.question.subjectWhen', `${subject} on ${detail}`, { transaction: subject, detail });
};

const JOURNAL_STATUSES = new Set(['draft', 'posted', 'voided', 'closed']);
// A ledger journal's stored status (ledger_journals.status).
export const journalStatusLabel = (status, formatMessage = null) => {
  const code = String(status || '').trim().toLowerCase();
  return JOURNAL_STATUSES.has(code)
    ? message(formatMessage, `portal.inspection.journalStatus.${code}`, code)
    : message(formatMessage, 'portal.inspection.journalStatus.unknown', 'Status not recognised');
};

// A chat action's stored status once it can no longer be applied (proposed
// and applied have their own affordances in the feed card).
export const feedActionStatusLabel = (status, formatMessage = null) => (
  status === 'superseded'
    ? message(formatMessage, 'feed.action.status.superseded', 'Superseded by a later reply')
    : message(formatMessage, 'feed.action.status.unknown', 'Not applied')
);
