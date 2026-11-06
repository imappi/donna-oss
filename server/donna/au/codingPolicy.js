import { TAX_VOCABULARY } from './taxVocabulary.js';

export const AU_CODING_POLICY = Object.freeze({
  id: 'au_coding', version: 1, jurisdiction: 'au', taxVocabulary: TAX_VOCABULARY.marker,
  taxTreatmentOptions: TAX_VOCABULARY.options, defaultTaxTreatment: TAX_VOCABULARY.unsureMarker,
  outOfScopeTaxTreatment: TAX_VOCABULARY.outOfScope, taxInstructions: TAX_VOCABULARY.instructionsNote,
  // Newly authored AU fallback using established common-account names.
  // Tax/payroll-specific accounts require the entity chart; no SG CPF account.
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
  ]), suspenseAccountName: 'Suspense',
});
