// Values that code inserts into an interface sentence: a document type in the
// upload tray, the ask-client prompt's phrases, stored status codes. Each one
// reads through a catalog label so it follows the interface language; an
// unknown code reads as its kind's fallback, never as itself. Spread into
// en.js so every key reaches the translation pipeline.
export default Object.freeze({
  // Document types inside a tray sentence ("Saved · {documentType}"),
  // written in mid-sentence (lower) case.
  'upload.documentType.receipt': 'receipt',
  'upload.documentType.supplierBill': 'supplier bill',
  'upload.documentType.salesInvoice': 'sales invoice',
  'upload.documentType.issuedReceipt': 'issued receipt',
  'upload.documentType.paymentConfirmation': 'payment confirmation',
  'upload.documentType.paymentAccountStatement': 'payment account statement',
  'upload.documentType.contract': 'contract',
  'upload.documentType.payoutStatement': 'payout statement',
  'upload.documentType.depositSlip': 'deposit slip',
  'upload.documentType.bankStatement': 'bank statement',
  'upload.documentType.statutoryRecord': 'registry document',
  'upload.documentType.taxNotice': 'tax notice',
  'upload.documentType.governmentLetter': 'letter from an authority',
  'upload.documentType.insurancePolicy': 'insurance policy',
  'upload.documentType.utilityBill': 'utility bill',
  'upload.documentType.rentalAgreement': 'rental agreement',
  'upload.documentType.safetyCertificate': 'safety certificate',
  'upload.documentType.other': 'other document',

  // The ask-client prompt's inserted phrases (transaction.question.example).
  'transaction.question.businessIncome': 'business income',
  'transaction.question.businessExpense': 'a business expense',
  'transaction.question.subjectNamed': 'the {vendor} transaction',
  'transaction.question.subjectUnnamed': 'this transaction',
  'transaction.question.subjectWhen': '{transaction} on {detail}',
  'transaction.question.dateAmount': '{date} for {amount}',

  // A ledger journal's stored status in the owner's book view.
  'portal.inspection.journalStatus.draft': 'Draft',
  'portal.inspection.journalStatus.posted': 'Posted',
  'portal.inspection.journalStatus.voided': 'Voided',
  'portal.inspection.journalStatus.closed': 'Period closed',
  'portal.inspection.journalStatus.unknown': 'Status not recognised',

  // A chat action's stored status in the firm feed, when it can no longer be
  // applied.
  'feed.action.status.superseded': 'Superseded by a later reply',
  'feed.action.status.unknown': 'Not applied'
});
