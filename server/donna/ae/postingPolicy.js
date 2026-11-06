// Exact persisted VAT semantics and the bounded native standard-rate contract.
// No tax judgment or accounting writer lives here.
import { aeNativeStandardSplit } from './nativeVatPosting.js';
import { AE_VAT_CODES, resolveAeVatCode } from './vatCodes.js';
import { ledgerAccountTypeFor, ledgerTransactionDirection } from '../ledger.js';

const refuse = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409, jurisdiction: 'ae' }); };
const labels = Object.freeze({
  'VAT 5% (standard rated)': 'SR_5',
  'Zero-rated supply': 'ZR',
  'Exempt supply': 'EXEMPT',
  'Out of scope of UAE VAT': 'OUTSIDE_SCOPE'
});
const resolve = ({ coding = {}, sourceCoding = coding, transaction = {} } = {}) => {
  const treatment = String(sourceCoding.tax_treatment || '').trim();
  const direction = ledgerTransactionDirection(transaction) === 'receive' ? 'out' : 'in';
  const stamped = [sourceCoding.xero_tax_type, sourceCoding.tax_type].map(value => String(value || '').trim().toUpperCase()).filter(value => resolveAeVatCode(value));
  if (new Set(stamped).size > 1) refuse('TRANSACTION_AE_VAT_CODING_CONFLICT', 'The authoritative UAE VAT posting codes disagree. Resolve the coding before posting.');
  const native = resolveAeVatCode(stamped[0]);
  const fromLabel = labels[treatment] ? `AE_VAT_${labels[treatment]}_${direction === 'out' ? 'OUTPUT' : 'INPUT'}`
    : treatment === 'Reverse charge (RCM)' && direction === 'in' ? 'AE_VAT_RCM_5_INPUT'
    : resolveAeVatCode(treatment)?.code || null;
  // An unsure or unknown explicit verdict is never laundered through a chart
  // default, a previous posting code, or a generic connector NONE label.
  if (treatment && !fromLabel) {
    if (treatment === 'Reverse charge (RCM)') refuse('TRANSACTION_AE_VAT_DIRECTION_MISMATCH', 'The UAE reverse-charge purchase treatment cannot code an incoming receipt.');
    return null;
  }
  if (native && fromLabel && native.code !== fromLabel) refuse('TRANSACTION_AE_VAT_CODING_CONFLICT', 'The authoritative UAE VAT treatment and posting code disagree. Resolve the coding before posting.');
  const entry = native || resolveAeVatCode(fromLabel);
  if (entry && entry.direction !== direction) refuse('TRANSACTION_AE_VAT_DIRECTION_MISMATCH', 'The UAE VAT code disagrees with the persisted cash direction.');
  return entry;
};
const knownBalanceSheet = coding => ['asset', 'liability', 'equity', 'bank'].includes(ledgerAccountTypeFor(coding));
const assertPostable = (input = {}) => {
  const { coding = {}, sourceCoding = coding } = input;
  const entry = resolve(input);
  // A name-only account can acquire its P&L class at the minting writer.
  // Only a positively known balance-sheet class may bypass VAT resolution.
  const requiresTreatment = !knownBalanceSheet(coding);
  // Known taxable coding cannot become gross-only accounting by disabling the
  // vocabulary flag, nor by assigning it to a balance-sheet account.
  if (input.sourceCoding && entry
    && [coding.xero_tax_type, coding.tax_type].filter(value => resolveAeVatCode(value)).some(value => String(value).trim().toUpperCase() !== entry.code)) {
    refuse('TRANSACTION_AE_VAT_CODING_CONFLICT', 'The prepared UAE VAT code differs from the authoritative transaction coding. Prepare this transaction again.');
  }
  const effectiveTaxable = [coding.tax_type, coding.xero_tax_type].some(value =>
    ['standard', 'reverse_charge'].includes(resolveAeVatCode(value)?.kind));
  if (entry?.kind === 'reverse_charge' || (effectiveTaxable && entry?.kind !== 'standard')) {
    refuse('TRANSACTION_AE_VAT_POSTING_UNSUPPORTED', 'Donna cannot yet post the required UAE VAT journal legs for this treatment. Nothing was posted. Native VAT posting support must be implemented before retrying this unchanged coding.');
  }
  if (entry?.kind !== 'standard' && coding.ae_vat_split) refuse('TRANSACTION_AE_VAT_FACTS_STALE',
    'A non-standard treatment cannot carry a prepared standard VAT split. Prepare again.');
  if (entry?.kind === 'standard') {
    // A native split never establishes a connector mapping (including NONE).
    if (input.connectorTaxCoding) refuse('TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED',
      'Standard UAE VAT has no verified external connector contract. Nothing was sent.');
    const split = aeNativeStandardSplit({ ...input, entry });
    if (JSON.stringify(coding.ae_vat_split) !== JSON.stringify(split)) refuse('TRANSACTION_AE_VAT_FACTS_STALE',
      'The prepared UAE split differs from the current source, facts or chart. Prepare again.');
  }
  if (!entry && (requiresTreatment
    || resolveAeVatCode(sourceCoding.tax_type) || resolveAeVatCode(sourceCoding.xero_tax_type)
    || resolveAeVatCode(coding.tax_type) || resolveAeVatCode(coding.xero_tax_type))) {
    refuse('TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED', 'This UAE income or expense line has no resolved VAT treatment. Nothing was posted. Resolve the authoritative coding from the evidence already held; ask the owner only for an actual missing business fact.');
  }
  if (input.sourceCoding && requiresTreatment && entry) {
    const actual = String(coding.xero_tax_type || coding.tax_type || '').trim().toUpperCase();
    if (actual !== entry.code) refuse('TRANSACTION_AE_VAT_CODING_CONFLICT', 'The prepared UAE VAT code differs from the authoritative transaction coding. Prepare this transaction again.');
  }
  if (input.connectorTaxCoding) {
    const { provider, lineAmountTypes, taxTypes } = input.connectorTaxCoding;
    // Xero NoTax + explicit NONE requests no tax calculation. It can preserve
    // these gross-only economics, while Donna retains the native classification.
    // No UAE connector map exists for any other provider tax identifier.
    if (provider !== 'xero' || lineAmountTypes !== 'NoTax' || !taxTypes?.length
      || taxTypes.some(code => code !== 'NONE')) {
      refuse('TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED', 'The Xero tax code has no supported mapping for this UAE treatment. Nothing was sent. Restore an authoritative supported connector mapping; do not relabel the transaction to bypass this refusal.');
    }
  }
  return coding;
};

export const AE_POSTING_POLICY = Object.freeze({
  jurisdiction: 'ae', policyId: 'ae_posting', policyVersion: 3,
  taxFactAutomation: async () => (await import('./taxFactAutomation.js')).AE_TAX_FACT_AUTOMATION,
  postingTaxCodingFlagKey: 'JURISDICTION_TAX_CODING',
  supplierBillAdmissionFlagKey: null, supplierBillNeedsChart: false,
  nativeTaxCodePrefixes: Object.freeze(['AE_VAT_']),
  nativeTaxCodes: Object.freeze(AE_VAT_CODES.map(({ code }) => code)),
  salesInvoiceChannels: Object.freeze([]), salesTaxControlRole: null,
  capabilities: Object.freeze({ prepareLedgerAccounts: true, enrichCoding: true, transactionSplit: true,
    salesInvoiceTaxPosting: false, supplierBillTaxPosting: false,
    planArSettlement: false, arSettlementReceivableCoding: false, assertPostableTaxCoding: true, sourceTaxPosting: false }),
  arSettlementFlagKey: null,
  prepareLedgerAccounts: ({ ledgerAccounts = [] } = {}) => ledgerAccounts,
  enrichCoding: (input = {}) => {
    const { coding = {} } = input;
    const { ae_vat_split: previousSplit, ...baseCoding } = coding;
    const entry = resolve(input);
    if (!entry && knownBalanceSheet(coding)) return baseCoding;
    return { ...baseCoding, tax_treatment: (input.sourceCoding || coding).tax_treatment || '',
      tax_type: entry?.code || '', xero_tax_type: entry?.code || '',
      ...(entry?.kind === 'standard' && input.taxPostingContext ? { ae_vat_split: aeNativeStandardSplit({ ...input, entry }) } : {}) };
  },
  transactionSplit: ({ coding = {} } = {}) => resolveAeVatCode(coding.tax_type || coding.xero_tax_type)?.kind === 'standard' ? coding.ae_vat_split || null : null,
  assertPostableTaxCoding: assertPostable
});
