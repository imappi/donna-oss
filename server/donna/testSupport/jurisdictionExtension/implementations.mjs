// Synthetic test-only policy. These are deliberately not New Zealand tax rules.
// Tests register a seventh country without changing any shared runtime algorithm.
let generation = 1;
export const setFixtureGeneration = (value) => { generation = value; };
export const fixtureCoding = () => generation === null ? null : ({
  id: 'nz_extension_fixture', version: generation, jurisdiction: 'nz',
  accountOptions: ['Fixture operations', 'Fixture corrected cost', 'Fixture suspense'],
  suspenseAccountName: 'Fixture suspense', taxTreatmentOptions: ['Fixture no tax', 'Fixture uncertain'],
  defaultTaxTreatment: 'Fixture uncertain', outOfScopeTaxTreatment: 'Fixture no tax',
  taxInstructions: 'Synthetic fixture only. Use the supplied evidence and declared options.'
});
export const fixturePosting = Object.freeze({
  jurisdiction: 'nz', policyId: 'nz_fixture_posting', policyVersion: 1,
  postingTaxCodingFlagKey: null, supplierBillAdmissionFlagKey: null, supplierBillNeedsChart: false,
  nativeTaxCodePrefixes: [], nativeTaxCodes: [], salesInvoiceChannels: [], salesTaxControlRole: null,
  arSettlementFlagKey: null,
  capabilities: { prepareLedgerAccounts: true, enrichCoding: true, transactionSplit: true,
    salesInvoiceTaxPosting: false, supplierBillTaxPosting: false, sourceTaxPosting: false,
    planArSettlement: false, arSettlementReceivableCoding: false,
    // RT-23: every registered policy declares the post-path tax invariant by name.
    assertPostableTaxCoding: false },
  prepareLedgerAccounts: ({ ledgerAccounts = [] }) => ledgerAccounts,
  enrichCoding: ({ coding }) => coding,
  transactionSplit: () => null
});
export const fixtureProfile = Object.freeze({ fixture_registration: (value) => {
  if (!value || typeof value.identifier !== 'string' || !value.identifier.trim()) throw new Error('Fixture registration invalid');
  return { identifier: value.identifier.trim() };
} });
export const fixtureSeller = ({ profile }) => ({
  taxRegistered: profile.fixture_registration ? true : null,
  taxRegistrationId: profile.fixture_registration?.identifier || null,
  regime: 'extension_fixture', confirmedAgainstPrimary: false,
  reason: profile.fixture_registration ? 'fixture_recorded' : 'fixture_missing'
});

export const fixtureClose = Object.freeze({
  resolveFiscalYear: () => ({ label: 'fixture-2026', starts_on: '2026-02-01', ends_on: '2027-01-31' })
});
export const fixtureLifecycle = Object.freeze({ entityAxis: () => 'fixture-entity' });
export const fixtureProvisioning = Object.freeze({
  requiredRoles: () => ({ roles: [], evidence: { fixture_registration: true } })
});
