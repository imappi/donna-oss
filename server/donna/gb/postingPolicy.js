// Country-owned VAT posting composition; the UK control accounts come from the entity chart.
import {
  GB_VAT_CODES, GB_VAT_INPUT_ROLE, GB_VAT_OUTPUT_ROLE, applyGbVatCodingToCoding,
  gbVatControlAccountFromChart, gbVatDirectionForTransaction, gbVatOutputCodeForRate, resolveGbVatCode, resolveGbVatCodeForCoding,
  resolveGbVatSplitForPosting, splitGbVatGross
} from './vatCodes.js';
import { resolveGbVatRegistrationOnDate } from './vatRegistration.js';
import { ledgerAccountTypeFor } from '../ledger.js';
import { assertTaxSourceEvidence } from '../taxSourceEvidence.js';
import { toIsoDay } from '../dates.js';

const salesTaxRole = 'liability.sales_tax_payable';
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const refuse = (code, message, details) => { throw Object.assign(new Error(message), { code, statusCode: 409, ...(details ? { details } : {}) }); };

// VAT registration, not the rollout flag, decides whether a VAT code may post.
// JURISDICTION_TAX_CODING only switches the UK coding lane on; a business that
// is not registered charges no VAT and reclaims none, so a VAT code on its
// books misstates the expense and a return it does not file. The record is the
// one GB already keeps and reads (clients.profile.vat_registration through
// vatRegistration.js, as the outbound seller and the VAT return route do), on
// the line's own date. Tri-state, as that module requires: only `true` posts;
// a recorded `false` and an unknown (`null`, no usable record) both refuse.
// The line is never posted with its code dropped: it stays unposted with this
// named refusal until the record is corrected or the coding changes.
const assertGbVatRegistered = ({ profile = null, onDate, code, refusalCode, subject }) => {
  const at = toIsoDay(onDate);
  const resolution = at ? resolveGbVatRegistrationOnDate({ registration: profile?.vat_registration ?? null, onDate: at })
    : { registered: null, reason: 'no_as_of_date' };
  if (resolution.registered === true) return;
  refuse(refusalCode, `${subject} would post the VAT code ${code}, but the business is ${resolution.registered === false ? 'not VAT-registered' : 'not recorded as VAT-registered'} on ${at || 'an unknown date'} (${resolution.reason}). A business that is not registered charges and reclaims no VAT, so nothing was posted; record the VAT registration (or correct the coding) and post again.`,
    { vat_code: code, as_of: at || null, registered: resolution.registered, registration_reason: resolution.reason });
};

// The registration declaration the shared coder contract reads
// (postingPolicy.js taxRegistration; transactionLlm.js): a bank line refused
// with TRANSACTION_GB_VAT_REGISTRATION_REQUIRED becomes a question to the
// owner for the fact only they know — whether, and from when, the business is
// VAT-registered. It asks no tax judgement and names no rule.
const GB_TAX_REGISTRATION = Object.freeze({
  refusalCodes: Object.freeze(['TRANSACTION_GB_VAT_REGISTRATION_REQUIRED']),
  onDate: ({ profile = null, onDate = null } = {}) => {
    const at = toIsoDay(onDate);
    if (!at) return { registered: null, reason: 'no_as_of_date' };
    const { registered, reason } = resolveGbVatRegistrationOnDate({ registration: profile?.vat_registration ?? null, onDate: at });
    return { registered, reason };
  },
  ownerQuestion: ({ language = 'en', lineLabel = '', onDate = null, registered = null } = {}) => {
    const at = toIsoDay(onDate) || '';
    const line = lineLabel ? `${lineLabel}: ` : '';
    if (language === 'fi') return registered === false
      ? `${line}tietojemme mukaan yritys ei ollut ${at} rekisteröity arvonlisäverovelvolliseksi (VAT) Yhdistyneessä kuningaskunnassa. Onko yritys rekisteröitynyt sen jälkeen? Jos on, mistä päivästä alkaen rekisteröinti on voimassa?`
      : `${line}meillä ei ole tietoa siitä, onko yritys rekisteröity arvonlisäverovelvolliseksi (VAT) Yhdistyneessä kuningaskunnassa. Onko yritys rekisteröity? Jos on, mistä päivästä alkaen rekisteröinti on voimassa?`;
    return registered === false
      ? `${line}our records say the business was not VAT-registered on ${at}. Has the business registered for VAT since then? If so, from what date is the registration effective?`
      : `${line}we have no record of whether the business is VAT-registered. Is the business registered for VAT? If so, from what date is the registration effective?`;
  }
});

// The Finnish evidence rule as UK law and practice allow it (owner decision
// 2026-11-09; the PR records each rule and its source). Two UK differences:
//  - The input rule binds the machine only. A reclaim without a VAT invoice
//    is lawful for some small purchases (the parking, toll, phone and
//    vending concession) and where HMRC accepts alternative evidence; that is
//    a person's judgement, and no client or supply fact for it exists here.
//  - A deduction is a code that reports input tax (Box 4). Blocked input VAT
//    carries its rate only as documentation and claims nothing.
const GB_TAX_EVIDENCE = Object.freeze({
  refusalCode: 'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED', inputRuleCoversAcceptedCoding: false,
  resolveEntry: ({ taxType = '', taxTreatment = '', direction = '' } = {}) => resolveGbVatCode(resolveGbVatCodeForCoding({ taxType, taxTreatment, direction })),
  deductibleInput: entry => entry.direction === 'in' && Boolean(entry.return_boxes?.tax || entry.return_boxes?.input_tax),
  taxedOutput: entry => entry.direction === 'out' && entry.rate > 0
});

export const GB_POSTING_POLICY = Object.freeze({
  jurisdiction: 'gb', policyId: 'gb_posting', policyVersion: 1,
  postingTaxCodingFlagKey: 'JURISDICTION_TAX_CODING',
  supplierBillAdmissionFlagKey: 'JURISDICTION_TAX_CODING', supplierBillNeedsChart: true,
  nativeTaxCodePrefixes: Object.freeze(['VAT_']), nativeTaxCodes: Object.freeze(GB_VAT_CODES.map(({ code }) => code)),
  salesInvoiceChannels: Object.freeze(['outbound']), salesTaxControlRole: salesTaxRole,
  taxEvidence: GB_TAX_EVIDENCE,
  taxRegistration: GB_TAX_REGISTRATION,
  capabilities: Object.freeze({ prepareLedgerAccounts: true, enrichCoding: true, transactionSplit: true,
    salesInvoiceTaxPosting: true, supplierBillTaxPosting: true,
    planArSettlement: false, arSettlementReceivableCoding: false, assertPostableTaxCoding: true, sourceTaxPosting: false }),
  arSettlementFlagKey: null,
  prepareLedgerAccounts: ({ ledgerAccounts = [] } = {}) => ledgerAccounts,
  enrichCoding: ({ coding = {}, transaction = {}, ledgerAccounts = [], taxCodingEnabled = false } = {}) =>
    taxCodingEnabled ? applyGbVatCodingToCoding({ coding, transaction,
      controlAccount: gbVatControlAccountFromChart(ledgerAccounts, salesTaxRole) }) : coding,
  // RT-23 — the FI twin (TRANSACTION_ALV_TREATMENT_UNRESOLVED), same law: a
  // P&L leg for a VAT-coding client posts only with a resolved VAT_ code;
  // 'VAT check' (the unsure marker) or unknown prose refuses by name. Before
  // it, the shared source-evidence rule for the selected code.
  assertPostableTaxCoding: ({ coding = {}, transaction = {}, taxCodingEnabled = false, profile = null, matchedDocument: document = null, autonomousCoding = false } = {}) => {
    const stamped = String(coding.xero_tax_type || coding.tax_type || '').trim().toUpperCase();
    const onDate = transaction.date || transaction.transaction_date;
    const registration = (code) => assertGbVatRegistered({ profile, onDate, code,
      refusalCode: 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED', subject: 'This bank line' });
    // With the lane off nothing renders a treatment to a code, but an explicit
    // VAT code already on the coding still posts: registration binds it too.
    if (!taxCodingEnabled) {
      if (resolveGbVatCode(stamped)) registration(stamped);
      return coding;
    }
    const direction = gbVatDirectionForTransaction(transaction, coding);
    // The FI TRANSACTION_ALV_ACCOUNT_INCOMPATIBLE twin: an explicit VAT code
    // whose side differs from the resolved revenue or expense account is an
    // authored conflict (an output code on an expense, an input code on
    // revenue), never permission to change its side or post it as is.
    const explicit = resolveGbVatCode(stamped);
    if (['revenue', 'expense'].includes(ledgerAccountTypeFor(coding)) && explicit && explicit.direction !== direction) {
      refuse('TRANSACTION_GB_VAT_ACCOUNT_INCOMPATIBLE',
        'The explicit VAT code conflicts with the resolved expense or revenue account. Correct the coding before posting.');
    }
    // A control-account settlement is stamped NONE; never revive its treatment.
    const selected = stamped === 'NONE' ? null : GB_TAX_EVIDENCE.resolveEntry({ taxType: stamped, direction,
      taxTreatment: coding.tax_treatment || transaction.tax_treatment || transaction.ai_suggestion?.tax_treatment || '' });
    if (selected) registration(selected.code);
    if (stamped !== 'NONE') assertTaxSourceEvidence({ rule: GB_TAX_EVIDENCE, transaction, document, autonomousCoding, entry: selected });
    if (!['revenue', 'expense'].includes(ledgerAccountTypeFor(coding))) return coding;
    if (stamped === 'NONE' || explicit) return coding;
    // Resolvability, not stamping (the FI twin's posture).
    const code = resolveGbVatCodeForCoding({ taxType: stamped, taxTreatment: coding.tax_treatment || '', direction });
    if (code) return coding;
    const treatment = String(coding.tax_treatment || '').trim();
    refuse('TRANSACTION_GB_VAT_TREATMENT_UNRESOLVED',
      `A GB VAT-coding client's ${ledgerAccountTypeFor(coding)} post requires a resolved VAT treatment — the coding says ${treatment ? `'${treatment}'` : 'nothing'}, which maps to no VAT code. Posting uncoded would leave the VAT return blind to this line; the line stays proposed until the treatment is resolved.`);
  },
  transactionSplit: resolveGbVatSplitForPosting,
  salesInvoiceTaxPosting: ({ controlAccount = null, channel = 'outbound' } = {}) => channel === 'outbound' ? {
    outputCodeForRate: gbVatOutputCodeForRate,
    control: controlAccount ? { role: GB_VAT_OUTPUT_ROLE, account: {
      code: controlAccount.code, name: controlAccount.name,
      account_type: controlAccount.type || controlAccount.account_type,
      normal_balance: controlAccount.normal_balance
    } } : null
  } : null,
  supplierBillTaxPosting: ({ verdict = {}, document = {}, ledgerAccounts = [], taxCodingEnabled = false, profile = null } = {}) => {
    let expenseTaxType = verdict.tax_type || verdict.xero_tax_type;
    const registration = (code) => assertGbVatRegistered({ profile, onDate: document.document_date, code,
      refusalCode: 'SUPPLIER_BILL_GB_VAT_REGISTRATION_REQUIRED', subject: 'This supplier bill' });
    if (!taxCodingEnabled) {
      const explicit = resolveGbVatCode(expenseTaxType);
      if (explicit) registration(explicit.code);
      return { expenseTaxType, alvSplit: null, payablesAccount: null };
    }
    const code = resolveGbVatCodeForCoding({ taxType: expenseTaxType || '', taxTreatment: verdict.tax_treatment || '', direction: 'in' });
    if (!code) refuse('SUPPLIER_BILL_GB_VAT_SPLIT_UNSUPPORTED', "A GB VAT-coding client's AP post requires a resolvable VAT treatment on the coding verdict — posting gross would forfeit the input-VAT reclaim.");
    registration(code);
    expenseTaxType = code;
    const payablesAccount = gbVatControlAccountFromChart(ledgerAccounts, 'liability.accounts_payable');
    if (!payablesAccount?.code) refuse('SUPPLIER_BILL_GB_PAYABLES_UNRESOLVED',
      'No single active chart account carries the accounts-payable role (liability.accounts_payable) — resolve the chart before this bill can post AP.');
    let split = splitGbVatGross({ gross: document.total_amount, code });
    let alvSplit = null;
    if (split) {
      const controlAccount = gbVatControlAccountFromChart(ledgerAccounts, salesTaxRole);
      if (!controlAccount?.code) refuse('SUPPLIER_BILL_GB_VAT_CONTROL_UNRESOLVED',
        'No single active chart account carries the VAT control role (liability.sales_tax_payable) — resolve the chart before this bill can post its reclaim split.');
      const statedVat = round2(document.tax_amount);
      if (statedVat > 0) {
        if (Math.abs(statedVat - split.vat) > 0.02) refuse('SUPPLIER_BILL_GB_VAT_AMOUNT_MISMATCH',
          `The bill states ${statedVat} VAT but the ${split.rate}% coding computes ${split.vat} — refusing rather than guessing which is right.`);
        split = { ...split, vat: statedVat, net: round2(round2(document.total_amount) - statedVat) };
      }
      alvSplit = { net: split.net, vat: split.vat, role: GB_VAT_INPUT_ROLE, controlAccount };
    }
    return { expenseTaxType, alvSplit, payablesAccount };
  }
});
