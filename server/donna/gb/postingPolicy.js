// Country-owned VAT posting composition; the UK control accounts come from the entity chart.
import {
  GB_VAT_CODES, GB_VAT_INPUT_ROLE, GB_VAT_OUTPUT_ROLE, applyGbVatCodingToCoding,
  gbVatControlAccountFromChart, gbVatDirectionForTransaction, gbVatOutputCodeForRate, resolveGbVatCodeForCoding,
  resolveGbVatSplitForPosting, splitGbVatGross
} from './vatCodes.js';
import { ledgerAccountTypeFor } from '../ledger.js';

const salesTaxRole = 'liability.sales_tax_payable';
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const refuse = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };

export const GB_POSTING_POLICY = Object.freeze({
  jurisdiction: 'gb', policyId: 'gb_posting', policyVersion: 1,
  postingTaxCodingFlagKey: 'JURISDICTION_TAX_CODING',
  supplierBillAdmissionFlagKey: 'JURISDICTION_TAX_CODING', supplierBillNeedsChart: true,
  nativeTaxCodePrefixes: Object.freeze(['VAT_']), nativeTaxCodes: Object.freeze(GB_VAT_CODES.map(({ code }) => code)),
  salesInvoiceChannels: Object.freeze(['outbound']), salesTaxControlRole: salesTaxRole,
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
  // 'VAT check' (the unsure marker) or unknown prose refuses by name.
  assertPostableTaxCoding: ({ coding = {}, transaction = {}, taxCodingEnabled = false } = {}) => {
    if (!taxCodingEnabled) return coding;
    if (!['revenue', 'expense'].includes(ledgerAccountTypeFor(coding))) return coding;
    const stamped = String(coding.xero_tax_type || coding.tax_type || '').trim().toUpperCase();
    if (stamped === 'NONE' || GB_VAT_CODES.some((entry) => entry.code === stamped)) return coding;
    // Resolvability, not stamping (the FI twin's posture).
    const code = resolveGbVatCodeForCoding({ taxType: stamped, taxTreatment: coding.tax_treatment || '', direction: gbVatDirectionForTransaction(transaction) });
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
  supplierBillTaxPosting: ({ verdict = {}, document = {}, ledgerAccounts = [], taxCodingEnabled = false } = {}) => {
    let expenseTaxType = verdict.tax_type || verdict.xero_tax_type;
    if (!taxCodingEnabled) return { expenseTaxType, alvSplit: null, payablesAccount: null };
    const code = resolveGbVatCodeForCoding({ taxType: expenseTaxType || '', taxTreatment: verdict.tax_treatment || '', direction: 'in' });
    if (!code) refuse('SUPPLIER_BILL_GB_VAT_SPLIT_UNSUPPORTED', "A GB VAT-coding client's AP post requires a resolvable VAT treatment on the coding verdict — posting gross would forfeit the input-VAT reclaim.");
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
