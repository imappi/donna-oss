// Explicit Singapore legacy coding policy; selection requires resolved SG.
// The richer dated GST posting vocabulary remains independently owned.
import { buildSgRailContext } from './paynowGiro.js';

export const SG_CODING_POLICY = Object.freeze({
  id: 'sg_legacy_coding',
  version: 1,
  jurisdiction: 'sg',
  bankLineContextFor: buildSgRailContext,
  taxVocabulary: 'sg_legacy',
  accountOptions: Object.freeze([
    'Sales',
    'Bank fees',
    'Software subscriptions',
    'Travel',
    'Meals and entertainment',
    'Marketing',
    'Professional fees',
    'Accounting fees',
    'Statutory filing fees',
    'Payroll',
    'CPF payable',
    'Rent',
    'Telecommunications',
    'Insurance',
    'Office expenses',
    'Director loan',
    'Owner drawings',
    'Share capital',
    'Share premium',
    'Retained earnings',
    'Loan payable',
    'Intercompany transfer',
    'Interest income',
    'Tax payable',
    'Foreign exchange gain/loss',
    'Suspense'
  ]),
  suspenseAccountName: 'Suspense',
  taxTreatmentOptions: Object.freeze(['GST 9%', 'No GST', 'Out of scope', 'GST check']),
  defaultTaxTreatment: 'No GST',
  uncertainTaxTreatment: 'GST check',
  outOfScopeTaxTreatment: 'Out of scope',
  taxInstructions: "Tax treatment is a bookkeeping suggestion only: use GST options only when the client's jurisdiction/tax profile indicates a GST or VAT regime; otherwise prefer No GST, and Out of scope for internal transfers/equity/capital movements."
});

// The persisted lineage reader, not jurisdiction/profile/flags, supplies this
// contract. Keep the tax vocabulary and SG rail evidence owner unchanged.
export const resolveSgCodingPolicy = ({ nativeMenu = null } = {}) => nativeMenu ? {
  ...SG_CODING_POLICY, id: 'sg_native_coding', version: 2,
  defaultTaxTreatment: 'GST check',
  taxInstructions: "Use the supplied dated native_registration evidence and actual supply facts. Unknown, unverified or outside-interval registration never establishes No GST, exemption or zero-rating. GST check preserves uncertainty; this processing-only policy grants no GST posting authority.",
  accountOptions: nativeMenu.choices.map(choice => choice.name),
  suspenseAccountName: nativeMenu.choices.find(choice => choice.kind === 'unresolved').name,
  nativeMenu
} : SG_CODING_POLICY;
