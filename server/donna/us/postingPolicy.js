// Explicit existing gross-only posting capability. Coding support does not enable tax splitting.
export const US_POSTING_POLICY = Object.freeze({
  jurisdiction: 'us', policyId: 'us_posting', policyVersion: 1,
  postingTaxCodingFlagKey: null,
  supplierBillAdmissionFlagKey: null, supplierBillNeedsChart: false,
  nativeTaxCodePrefixes: Object.freeze([]),
  nativeTaxCodes: Object.freeze([]),
  salesInvoiceChannels: Object.freeze([]), salesTaxControlRole: null,
  capabilities: Object.freeze({ prepareLedgerAccounts: true, enrichCoding: true, transactionSplit: true,
    salesInvoiceTaxPosting: false, supplierBillTaxPosting: false,
    planArSettlement: false, arSettlementReceivableCoding: false, assertPostableTaxCoding: false, sourceTaxPosting: false }),
  arSettlementFlagKey: null,
  prepareLedgerAccounts: ({ ledgerAccounts = [] } = {}) => ledgerAccounts,
  enrichCoding: ({ coding = {} } = {}) => coding,
  transactionSplit: () => null
});
