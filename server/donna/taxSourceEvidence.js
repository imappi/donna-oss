// The one owner of the source-evidence rules a rated tax posting on a bank line
// must meet. Market-neutral: each country's posting policy passes its own
// vocabulary entry and declares, as data on its policy, which entries claim a
// deduction, which charge output tax, its refusal code, and whether a person's
// accepted decision carries the input claim. Nothing here knows a country.
import { settledSalesEvidence } from './codingRevenueEvidence.js';
import { ledgerAccountTypeFor } from './ledger.js';
import { roleForSeedName, roleMeta } from './accountRoles.js';

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
