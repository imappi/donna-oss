// The one owner of the source-evidence rules a rated tax posting on a bank line
// must meet. Market-neutral: each country's posting policy passes its own
// vocabulary entry and declares, as data on its policy, which entries claim a
// deduction, which charge output tax, its refusal code, and whether a person's
// accepted decision carries the input claim. Nothing here knows a country.
import { settledSalesEvidence } from './codingRevenueEvidence.js';
import { ledgerAccountTypeFor } from './ledger.js';
import { roleForSeedName, roleMeta } from './accountRoles.js';
import { salesSourcePrintedTax } from './documentAllocationComponents.js';
import { toIsoDay } from './dates.js';

// The tax side follows the resolved account's class: an expense gives the
// purchase (input) side, revenue the supply (output) side. The cash direction
// decides only for an account of unknown class, so a refund coded to its
// expense account reverses input tax and never creates output tax.
export const taxSideForCoding = (transaction = {}, coding = {}) => {
  const stored = ledgerAccountTypeFor(coding);
  const type = stored !== 'unknown' ? stored : roleMeta(roleForSeedName(
    coding.xero_account_name || coding.account_name || coding.proposed_account))?.class;
  if (type === 'expense') return 'in';
  if (type === 'revenue') return 'out';
  if (Number(transaction?.money_in || 0) > 0) return 'out';
  if (Number(transaction?.money_out || 0) > 0) return 'in';
  return '';
};

const settledSource = document => Boolean(document && ['confirmed', 'auto_matched'].includes(document.match_status));

// What the declared rule asks of one vocabulary entry. The menu constraint the
// coder sees after a refusal reads this, so it cannot drift from the writer.
export const taxEvidenceRequirement = (rule, entry) => ({
  inputSource: Boolean(entry && rule.deductibleInput(entry)),
  salesSource: Boolean(entry && rule.taxedOutput(entry))
});

// Refuses only: the line stays proposed and the evidence clock asks for the source.
export const assertTaxSourceEvidence = ({ rule, entry, transaction = {}, document = null, autonomousCoding = false } = {}) => {
  const required = taxEvidenceRequirement(rule, entry);
  const refuse = message => { throw Object.assign(new Error(message), { code: rule.refusalCode, statusCode: 409 }); };
  // A bank descriptor is not purchase-tax evidence, even on an immaterial line.
  if (required.inputSource && (rule.inputRuleCoversAcceptedCoding || autonomousCoding) && !settledSource(document)) {
    refuse('A deductible VAT posting needs the usable source document and its current settled relationship.');
  }
  // The output twin: a receipt is not a sale. Money in from a supplier is
  // normally a purchase refund, so the machine's output VAT on a bank line
  // needs the settled sales source; a person's accepted decision carries its own.
  if (autonomousCoding && required.salesSource && Number(transaction.money_in || 0) > 0 && !settledSalesEvidence(document)) {
    refuse('An output VAT posting on money received needs the settled sales source. The bank movement alone does not establish a sale; a supplier refund reverses its purchase instead.');
  }
};

// The sale-side twin of the rule above, for a business the registration record
// says is NOT registered. On such a date a sale posts gross to revenue with no
// VAT leg (#64). That is right only when the business's own sales document
// prints no VAT. When the sales invoice or issued receipt this money in
// settles prints VAT, either the record is wrong (the business is registered
// and owes the output VAT) or the business issued a document showing VAT it
// was not entitled to charge, and the document needs correcting. Neither is
// Donna's to decide: whether VAT shown by an unregistered seller is payable,
// and how it is reported, is a country's statutory rule, and none is encoded
// here. So the line does not post, whatever the coding says; it refuses with
// the country's named code (taxRegistration.salesSourceShowsTax.refusalCode),
// and the coder's contract turns that into the owner's registration question
// (transactionLlm.js).
// Only a sale: money in, coded to revenue or to an account whose class is not
// known (taxSideForCoding 'out'); a balance-sheet coding (a receivable the
// invoice already put on the books, a loan) is not this line's revenue.
// The date: the record must say not registered on the line's date (the date
// the posting policy reads registration on) and, when the document carries
// one, on the document's date. Registered or unknown on the document's date is
// not this conflict (an invoice issued while registered, or an unknown record,
// which the registration rule already asks about), and the line is left to it.
// `registration` is the country's taxRegistration declaration (its onDate
// reader and salesSourceShowsTax); nothing here knows a country.
export const assertSalesSourceTaxRegistration = ({ registration, profile = null, transaction = {}, coding = {}, document = null } = {}) => {
  const rule = registration?.salesSourceShowsTax;
  if (!rule) return;
  if (!(Number(transaction.money_in || 0) > 0) || Number(transaction.money_out || 0) > 0) return;
  if (['asset', 'liability', 'equity'].includes(ledgerAccountTypeFor(coding)) || taxSideForCoding(transaction, coding) !== 'out') return;
  const printed = salesSourcePrintedTax(document);
  if (!printed) return;
  const onDate = toIsoDay(transaction.date || transaction.transaction_date);
  const read = (at) => { try { return registration.onDate({ profile, onDate: at }) || {}; } catch { return { registered: null }; } };
  const status = onDate ? read(onDate) : { registered: null };
  if (status.registered !== false) return;
  const documentDate = toIsoDay(printed.document_date);
  if (documentDate && documentDate !== onDate && read(documentDate).registered !== false) return;
  throw Object.assign(new Error(`This bank line settles the business's own ${printed.document_type === 'issued_receipt' ? 'receipt' : 'sales invoice'}${printed.filename ? ` ${printed.filename}` : ''}, which shows VAT${printed.tax_amount != null ? ` of ${printed.tax_amount}${printed.currency ? ` ${printed.currency}` : ''}` : ''}, but the business is not registered for VAT on ${onDate} (${status.reason || 'not_registered'}). Nothing was posted: either the registration record is wrong or the document needs correcting, and only the owner knows which.`),
  { code: rule.refusalCode, statusCode: 409, details: { as_of: onDate, registered: false, registration_reason: status.reason || null,
    sales_source: { ...printed, document_date: documentDate } } });
};
