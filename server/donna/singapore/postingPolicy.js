import { KNOWN_SG_GST_CODES } from './gstCodes.js';

// Explicit existing gross-only posting capability. Coding support does not enable tax splitting.
export const SG_POSTING_POLICY = Object.freeze({
  jurisdiction: 'sg', policyId: 'sg_posting', policyVersion: 1,
  postingTaxCodingFlagKey: null,
  supplierBillAdmissionFlagKey: null, supplierBillNeedsChart: false,
  nativeTaxCodePrefixes: Object.freeze(['GST_']),
  nativeTaxCodes: Object.freeze([...KNOWN_SG_GST_CODES]),
  salesInvoiceChannels: Object.freeze([]), salesTaxControlRole: null,
  capabilities: Object.freeze({ prepareLedgerAccounts: true, enrichCoding: true, transactionSplit: true,
    salesInvoiceTaxPosting: false, supplierBillTaxPosting: false,
    planArSettlement: false, arSettlementReceivableCoding: false, assertPostableTaxCoding: false, sourceTaxPosting: false }),
  arSettlementFlagKey: null,
  prepareLedgerAccounts: ({ ledgerAccounts = [] } = {}) => ledgerAccounts,
  enrichCoding: ({ coding = {} } = {}) => coding,
  transactionSplit: () => null
});
