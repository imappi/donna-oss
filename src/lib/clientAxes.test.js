// Tests for the shared client-axes module — service ↔ tile mapping,
// reads off the client snapshot, and the legacy-fallback ordering of
// readPortalTileFilter.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SERVICES,
  SERVICE_IDS,
  SERVICE_TO_TILE,
  TILE_TO_SERVICE,
  readServicesEngaged,
  readApplicableIntakeCategoriesLegacy,
  readPortalTileFilter,
  readPortalTileState,
  readJurisdiction,
  readJurisdictionSubdivision,
  readEntityType,
  readJurisdictionDetected,
  readJurisdictionDetectedConfidence,
  readLatestJurisdictionSignal,
  jurisdictionDisplayLabel,
  jurisdictionLongLabel,
  entityTypeLabel,
  entityNumberLabel,
  ENTITY_TYPES_BY_JURISDICTION,
  COMPLIANCE_CARD_ELIGIBLE,
  registrySourceFor,
  taxLabelFor,
  payrollTileCopy,
  shouldRenderComplianceCard,
  ACCOUNTING_SYSTEMS,
  DEFAULT_ACCOUNTING_SYSTEM,
  readAccountingSystem,
  readAccountingSystemConnection,
  isAccountingSystemConnected,
  accountingSystemLabel,
  accountingConnectorTile,
  readJurisdictionConfirmation,
  readAccountingSystemProvenance,
  readServicesEngagedProvenance,
  readIncorporationDate,
  entityTypeRequiresIncorporationDate,
  entityTypeRequiresExplicitFiscalPeriod,
  entityTypeCaptureState
} from './clientAxes.js';

await test('SERVICES has the canonical nine ids in display order', () => {
  assert.deepEqual(SERVICE_IDS, [
    'bank_reconciliation',
    'sales_invoicing',
    'bills_and_expenses',
    'payroll',
    'loan_tracking',
    'tax_filing',
    'compliance_filings',
    'secretarial',
    'management_accounts'
  ]);
  assert.equal(SERVICES.length, 9);
});

await test('SERVICE_TO_TILE covers the five tile-mapped services', () => {
  assert.deepEqual(SERVICE_TO_TILE, {
    bank_reconciliation: 'bank',
    sales_invoicing: 'sales',
    bills_and_expenses: 'bills',
    payroll: 'payroll',
    loan_tracking: 'loans'
  });
  assert.deepEqual(TILE_TO_SERVICE, {
    bank: 'bank_reconciliation',
    sales: 'sales_invoicing',
    bills: 'bills_and_expenses',
    payroll: 'payroll',
    loans: 'loan_tracking'
  });
});

await test('readServicesEngaged: top-level wins, nested honoured, junk filtered', () => {
  assert.equal(readServicesEngaged({}), null);
  assert.equal(readServicesEngaged({ services_engaged: null }), null);
  assert.equal(readServicesEngaged({ services_engaged: 'bank_reconciliation' }), null);

  assert.deepEqual(
    readServicesEngaged({ services_engaged: ['bank_reconciliation', 'payroll'] }),
    ['bank_reconciliation', 'payroll']
  );
  // Nested path for local-demo fixtures
  assert.deepEqual(
    readServicesEngaged({ profile: { services_engaged: ['sales_invoicing'] } }),
    ['sales_invoicing']
  );
  // Top-level wins over nested when both are present
  assert.deepEqual(
    readServicesEngaged({
      services_engaged: ['payroll'],
      profile: { services_engaged: ['secretarial'] }
    }),
    ['payroll']
  );
  // Unknown service ids are filtered out — protects the portal from
  // a future service that the FE doesn't know how to render yet.
  assert.deepEqual(
    readServicesEngaged({ services_engaged: ['bank_reconciliation', 'made_up_service'] }),
    ['bank_reconciliation']
  );
});

await test('readApplicableIntakeCategoriesLegacy: dual-path, empty → null', () => {
  assert.equal(readApplicableIntakeCategoriesLegacy({}), null);
  assert.equal(readApplicableIntakeCategoriesLegacy({ applicable_intake_categories: [] }), null);
  assert.deepEqual(
    readApplicableIntakeCategoriesLegacy({ applicable_intake_categories: ['bank', 'sales'] }),
    ['bank', 'sales']
  );
  assert.deepEqual(
    readApplicableIntakeCategoriesLegacy({ profile: { applicable_intake_categories: ['payroll'] } }),
    ['payroll']
  );
});

await test('readPortalTileFilter: services_engaged maps to tile ids', () => {
  const filter = readPortalTileFilter({
    services_engaged: ['bank_reconciliation', 'sales_invoicing', 'payroll']
  });
  assert.deepEqual([...filter].sort(), ['bank', 'payroll', 'sales']);
});

await test('readPortalTileFilter: services without a tile drop out', () => {
  // tax_filing, compliance_filings, secretarial, management_accounts
  // have no portal tile — they shouldn't break the filter.
  const filter = readPortalTileFilter({
    services_engaged: ['bank_reconciliation', 'tax_filing', 'secretarial']
  });
  assert.deepEqual([...filter], ['bank']);
});

await test('readPortalTileFilter: legacy fallback when services_engaged is unset', () => {
  const filter = readPortalTileFilter({
    applicable_intake_categories: ['bank', 'sales', 'bills', 'payroll', 'xero']
  });
  assert.deepEqual([...filter].sort(), ['bank', 'bills', 'payroll', 'sales', 'xero']);
});

await test('readPortalTileFilter: services_engaged wins over legacy', () => {
  // Both fields present → new field wins, legacy ignored.
  const filter = readPortalTileFilter({
    services_engaged: ['bank_reconciliation'],
    applicable_intake_categories: ['bank', 'sales', 'bills', 'payroll', 'loans', 'xero']
  });
  assert.deepEqual([...filter], ['bank']);
});

await test('readPortalTileFilter: null when neither field is set', () => {
  // null = "no filter set" = render every tile (backward-compat shim).
  assert.equal(readPortalTileFilter({}), null);
  assert.equal(readPortalTileFilter({ services_engaged: [] }), null);
  assert.equal(readPortalTileFilter({ applicable_intake_categories: [] }), null);
});

// ── Phase 1.5 — cohort-aware readPortalTileState ─────────────────────────────

await test('readPortalTileState: absent services_engaged → all (legacy shim)', () => {
  const state = readPortalTileState({});
  assert.equal(state.mode, 'all');
  assert.equal(state.tiles, null);
});

await test('readPortalTileState: explicit empty array → unscoped (new-client state)', () => {
  const state = readPortalTileState({ services_engaged: [] });
  assert.equal(state.mode, 'unscoped');
  assert.ok(state.tiles instanceof Set);
  assert.equal(state.tiles.size, 0);
  // Nested path honoured for local-demo fixtures.
  assert.equal(readPortalTileState({ profile: { services_engaged: [] } }).mode, 'unscoped');
});

await test('readPortalTileState: non-empty services_engaged → scoped, mapped tiles', () => {
  const state = readPortalTileState({ services_engaged: ['bank_reconciliation', 'payroll'] });
  assert.equal(state.mode, 'scoped');
  assert.deepEqual([...state.tiles].sort(), ['bank', 'payroll']);
});

await test('readPortalTileState: services with no tile (e.g. secretarial) → scoped, dropped', () => {
  // secretarial / tax_filing have no portal tile — they map to nothing,
  // so the client is scoped but shows no document tiles from them.
  const state = readPortalTileState({ services_engaged: ['secretarial'] });
  assert.equal(state.mode, 'scoped');
  assert.equal(state.tiles.size, 0);
});

await test('readPortalTileState: legacy applicable_intake_categories → scoped (transitional)', () => {
  const state = readPortalTileState({ applicable_intake_categories: ['bank', 'sales'] });
  assert.equal(state.mode, 'scoped');
  assert.deepEqual([...state.tiles].sort(), ['bank', 'sales']);
});

await test('readPortalTileState: services_engaged wins over legacy', () => {
  // Explicit empty services_engaged beats a legacy list → unscoped, not
  // a legacy-driven scope.
  const state = readPortalTileState({
    services_engaged: [],
    applicable_intake_categories: ['bank', 'sales']
  });
  assert.equal(state.mode, 'unscoped');
});

// ── Phase 2a — jurisdiction + entity_type ───────────────────────────────────

await test('readJurisdiction: dual-path, lowercased, uk → gb alias', () => {
  assert.equal(readJurisdiction({}), null);
  assert.equal(readJurisdiction({ jurisdiction: null }), null);
  assert.equal(readJurisdiction({ jurisdiction: 'unknown' }), null);
  assert.equal(readJurisdiction({ jurisdiction: 'SG' }), 'sg');
  assert.equal(readJurisdiction({ jurisdiction: 'UK' }), 'gb');
  assert.equal(readJurisdiction({ jurisdiction: 'uk' }), 'gb');
  assert.equal(readJurisdiction({ profile: { jurisdiction: 'gb' } }), 'gb');
  // Top-level wins
  assert.equal(
    readJurisdiction({ jurisdiction: 'us', profile: { jurisdiction: 'sg' } }),
    'us'
  );
});

await test('readEntityType: dual-path, lowercased', () => {
  assert.equal(readEntityType({}), null);
  assert.equal(readEntityType({ entity_type: 'SG-PTE' }), 'sg-pte');
  assert.equal(readEntityType({ profile: { entity_type: 'us-llc' } }), 'us-llc');
});

await test('readJurisdictionSubdivision: lowercased', () => {
  assert.equal(readJurisdictionSubdivision({}), null);
  assert.equal(readJurisdictionSubdivision({ jurisdiction_subdivision: 'US-CA' }), 'us-ca');
});

await test('jurisdictionDisplayLabel: short form for gb, full for others', () => {
  assert.equal(jurisdictionDisplayLabel('gb'), 'UK');
  assert.equal(jurisdictionDisplayLabel('sg'), 'Singapore');
  assert.equal(jurisdictionDisplayLabel('us'), 'United States');
  // Unknown code → uppercased fallback so the UI never goes blank.
  assert.equal(jurisdictionDisplayLabel('xx'), 'XX');
  assert.equal(jurisdictionDisplayLabel(null), null);
});

await test('jurisdictionLongLabel: always full label, never short form', () => {
  assert.equal(jurisdictionLongLabel('gb'), 'United Kingdom');
  assert.equal(jurisdictionLongLabel('sg'), 'Singapore');
});

await test('entityTypeLabel: friendly form, unknown falls through', () => {
  assert.equal(entityTypeLabel('sg-pte'), 'Private Limited (Pte Ltd)');
  assert.equal(entityTypeLabel('us-llc'), 'LLC');
  assert.equal(entityTypeLabel('gb-ltd'), 'Limited Company');
  // Unknown stays as-is so the UI surfaces the storage form rather than blanks.
  assert.equal(entityTypeLabel('us-made-up'), 'us-made-up');
  assert.equal(entityTypeLabel(null), null);
});

await test('entityNumberLabel: derived from entity_type, neutral fallback', () => {
  assert.equal(entityNumberLabel('sg-pte'), 'UEN');
  assert.equal(entityNumberLabel('us-llc'), 'EIN');
  // The fix called out in the v2 plan — US sole prop is not EIN-only.
  assert.equal(entityNumberLabel('us-sole-prop'), 'Tax ID');
  // UK sole trader uses HMRC UTR, not Companies House CRN.
  assert.equal(entityNumberLabel('gb-sole-trader'), 'UTR');
  assert.equal(entityNumberLabel('gb-ltd'), 'CRN');
  // Unknown / null → neutral label.
  assert.equal(entityNumberLabel(null), 'Entity number');
  assert.equal(entityNumberLabel('made-up'), 'Entity number');
});

await test('FI-13: Finnish legal-form vocabulary is enumerated', () => {
  assert.deepEqual(ENTITY_TYPES_BY_JURISDICTION.fi, ['fi-toiminimi', 'fi-oy']);
  assert.equal(entityTypeLabel('fi-oy'), 'Limited Company (Oy)');
  assert.equal(entityTypeLabel('fi-toiminimi'), 'Sole Trader (Toiminimi)');
  // Both Finnish forms carry a Y-tunnus.
  assert.equal(entityNumberLabel('fi-oy'), 'Y-tunnus');
  assert.equal(entityNumberLabel('fi-toiminimi'), 'Y-tunnus');
  // Finland is NOT compliance-card-eligible — the SG/UK-style annual-return
  // card is not built for FI (its statutory rituals differ).
  assert.equal(COMPLIANCE_CARD_ELIGIBLE.has('fi-oy'), false);
  assert.equal(COMPLIANCE_CARD_ELIGIBLE.has('fi-toiminimi'), false);
});

await test('registrySourceFor: per-jurisdiction source line, neutral fallback', () => {
  assert.equal(registrySourceFor('sg'), 'Bizfile · ACRA');
  assert.equal(registrySourceFor('gb'), 'Companies House');
  assert.equal(registrySourceFor('us'), 'Secretary of State');
  assert.equal(registrySourceFor(null), 'Manual entry');
});

await test('taxLabelFor: GST / VAT / Sales Tax / null', () => {
  assert.equal(taxLabelFor('sg'), 'GST');
  assert.equal(taxLabelFor('gb'), 'VAT');
  assert.equal(taxLabelFor('us'), 'Sales Tax');
  assert.equal(taxLabelFor('hk'), null);
  assert.equal(taxLabelFor(null), null);
});

await test('payrollTileCopy: per-jurisdiction with default fallback', () => {
  assert.equal(payrollTileCopy('sg').title, 'Payroll & CPF');
  assert.equal(payrollTileCopy('gb').title, 'Payroll & PAYE');
  assert.equal(payrollTileCopy('au').title, 'Payroll & STP');
  assert.equal(payrollTileCopy('us').title, 'Payroll & 941');
  assert.equal(payrollTileCopy('hk').title, 'Payroll & MPF');
  // Unknown jurisdiction → neutral "Payroll" label.
  assert.equal(payrollTileCopy(null).title, 'Payroll');
  assert.equal(payrollTileCopy('xx').title, 'Payroll');
});

await test('shouldRenderComplianceCard: requires all three clauses', () => {
  // Happy path — SG Pte Ltd with compliance_filings engaged.
  assert.equal(
    shouldRenderComplianceCard({
      services: ['bank_reconciliation', 'compliance_filings'],
      jurisdiction: 'sg',
      entityType: 'sg-pte'
    }),
    true
  );
  // Missing service → no card.
  assert.equal(
    shouldRenderComplianceCard({
      services: ['bank_reconciliation'],
      jurisdiction: 'sg',
      entityType: 'sg-pte'
    }),
    false
  );
  // Missing jurisdiction → no card.
  assert.equal(
    shouldRenderComplianceCard({
      services: ['compliance_filings'],
      jurisdiction: null,
      entityType: 'sg-pte'
    }),
    false
  );
  // Entity type not in eligible set (US LLC is state-dependent).
  assert.equal(
    shouldRenderComplianceCard({
      services: ['compliance_filings'],
      jurisdiction: 'us',
      entityType: 'us-llc'
    }),
    false
  );
  // UK Ltd is eligible.
  assert.equal(
    shouldRenderComplianceCard({
      services: ['compliance_filings'],
      jurisdiction: 'gb',
      entityType: 'gb-ltd'
    }),
    true
  );
  // UK sole trader is NOT eligible (no annual return ritual).
  assert.equal(
    shouldRenderComplianceCard({
      services: ['compliance_filings'],
      jurisdiction: 'gb',
      entityType: 'gb-sole-trader'
    }),
    false
  );
});

// ── Phase 2b — detector reads off the profile ───────────────────────────────

await test('readJurisdictionDetected: dual-path, lowercased, null fallback', () => {
  assert.equal(readJurisdictionDetected({}), null);
  assert.equal(readJurisdictionDetected({ jurisdiction_detected: 'SG' }), 'sg');
  assert.equal(readJurisdictionDetected({ profile: { jurisdiction_detected: 'gb' } }), 'gb');
});

await test('readJurisdictionDetectedConfidence: high/medium/low/conflicted strings', () => {
  assert.equal(readJurisdictionDetectedConfidence({}), null);
  assert.equal(readJurisdictionDetectedConfidence({ jurisdiction_detected_confidence: 'HIGH' }), 'high');
  assert.equal(
    readJurisdictionDetectedConfidence({ profile: { jurisdiction_detected_confidence: 'conflicted' } }),
    'conflicted'
  );
});

await test('readLatestJurisdictionSignal: last entry of the ring buffer or null', () => {
  assert.equal(readLatestJurisdictionSignal({}), null);
  assert.equal(readLatestJurisdictionSignal({ jurisdiction_signals: [] }), null);
  const latest = readLatestJurisdictionSignal({
    jurisdiction_signals: [
      { source: 'bank_statement', jurisdiction: 'sg', confidence: 'medium', evidence: 'SGD' },
      { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high', evidence: 'DBS Bank · SGD' }
    ]
  });
  assert.equal(latest.confidence, 'high');
  assert.equal(latest.evidence, 'DBS Bank · SGD');
});

// ── Accounting system (Phase 3a) ─────────────────────────────────────────────

await test('ACCOUNTING_SYSTEMS: xero + none available, qbo/procountor connectable but not fully wired', () => {
  assert.deepEqual(ACCOUNTING_SYSTEMS.map((a) => a.id), ['xero', 'qbo', 'procountor', 'none']);
  const byId = Object.fromEntries(ACCOUNTING_SYSTEMS.map((a) => [a.id, a]));
  assert.equal(byId.xero.available, true);
  assert.equal(byId.qbo.available, false);
  assert.equal(byId.procountor.available, false);
  assert.equal(byId.none.available, true);
  // QBO: OAuth connect is live (2.1a) so the operator can select + connect it,
  // but sync/writeback (available) are not wired yet.
  assert.equal(byId.qbo.connectable, true);
  assert.equal(byId.procountor.connectable, true);
  assert.equal(byId.none.connector, null);   // Donna ledger only → no tile
  assert.ok(byId.xero.connector && byId.xero.connector.cta);
  assert.equal(DEFAULT_ACCOUNTING_SYSTEM, 'xero');
});

await test('readAccountingSystem: dual-path, enum-gated, junk → null', () => {
  assert.equal(readAccountingSystem({}), null);
  assert.equal(readAccountingSystem({ accounting_system: 'xero' }), 'xero');
  assert.equal(readAccountingSystem({ accounting_system: 'QBO' }), 'qbo');     // lowercased
  assert.equal(readAccountingSystem({ accounting_system: 'Procountor' }), 'procountor');
  assert.equal(readAccountingSystem({ accounting_system: 'none' }), 'none');
  assert.equal(readAccountingSystem({ accounting_system: 'sage' }), null);     // not in enum
  assert.equal(readAccountingSystem({ profile: { accounting_system: 'xero' } }), 'xero');
  // Top-level wins over nested.
  assert.equal(
    readAccountingSystem({ accounting_system: 'none', profile: { accounting_system: 'xero' } }),
    'none'
  );
});

await test('readAccountingSystemConnection: server-derived shape, null when absent/shapeless', () => {
  assert.equal(readAccountingSystemConnection({}), null);
  assert.equal(readAccountingSystemConnection({ accounting_system_connection: {} }), null); // no status
  assert.equal(readAccountingSystemConnection({ accounting_system_connection: [] }), null); // not object
  const conn = {
    status: 'connected',
    connection_id: 'conn-1',
    tenant_name: 'BBVA EUR',
    last_synced_at: '2026-06-06T00:00:00.000Z',
    last_error: null
  };
  assert.deepEqual(readAccountingSystemConnection({ accounting_system_connection: conn }), conn);
  assert.deepEqual(readAccountingSystemConnection({ profile: { accounting_system_connection: conn } }), conn);
});

await test('isAccountingSystemConnected: only true on status connected', () => {
  assert.equal(isAccountingSystemConnected({}), false);
  assert.equal(isAccountingSystemConnected({ accounting_system_connection: { status: 'error' } }), false);
  assert.equal(isAccountingSystemConnected({ accounting_system_connection: { status: 'connected' } }), true);
});

await test('accountingSystemLabel: maps id → label, falls through unknown', () => {
  assert.equal(accountingSystemLabel('xero'), 'Xero');
  assert.equal(accountingSystemLabel('qbo'), 'QuickBooks Online');
  assert.equal(accountingSystemLabel('procountor'), 'Procountor');
  assert.equal(accountingSystemLabel('none'), 'None yet');
  assert.equal(accountingSystemLabel(null), null);
  assert.equal(accountingSystemLabel('sage'), 'sage');
});

await test('accountingConnectorTile: unset → neutral Xero-or-QuickBooks copy, keeps id xero', () => {
  const tile = accountingConnectorTile({});
  assert.ok(tile);
  assert.equal(tile.id, 'xero');          // stable dismissed_tiles key
  assert.equal(tile.system, 'xero');      // connect dispatches to the default system
  assert.equal(tile.title, 'Xero or QuickBooks access'); // does NOT presume Xero
  assert.ok(tile.cta);
});

await test('accountingConnectorTile: none → null (Donna ledger only)', () => {
  assert.equal(accountingConnectorTile({ accounting_system: 'none' }), null);
});

await test('accountingConnectorTile: connected → null (tile retires)', () => {
  assert.equal(
    accountingConnectorTile({
      accounting_system: 'xero',
      accounting_system_connection: { status: 'connected' }
    }),
    null
  );
});

await test('accountingConnectorTile: chosen-but-not-connected → tile with that system copy', () => {
  // QBO chosen (hypothetically) and not connected → QuickBooks copy.
  const tile = accountingConnectorTile({
    accounting_system: 'qbo',
    accounting_system_connection: { status: 'error' }
  });
  assert.ok(tile);
  assert.equal(tile.system, 'qbo');
  assert.equal(tile.title, 'QuickBooks access');
  // Non-connected Xero still surfaces the tile.
  const xeroTile = accountingConnectorTile({
    accounting_system: 'xero',
    accounting_system_connection: { status: 'expired' }
  });
  assert.ok(xeroTile);
  assert.equal(xeroTile.system, 'xero');
});

// ── Provenance reads (Phase 2.4) ─────────────────────────────────────────────
// Server-stamped on the snapshot when the operator confirms a jurisdiction or
// picks an accounting_system. FE reads them for display only (writes go
// straight back to 400 via clientProfileSchema's SERVER_OWNED_KEYS).

await test('readJurisdictionConfirmation: null when both keys absent', () => {
  assert.equal(readJurisdictionConfirmation({}), null);
  assert.equal(readJurisdictionConfirmation({ profile: {} }), null);
});

await test('readJurisdictionConfirmation: returns { by, at } from either top-level or nested', () => {
  assert.deepEqual(
    readJurisdictionConfirmation({
      jurisdiction_confirmed_by: 'kari@books.example',
      jurisdiction_confirmed_at: '2026-06-08T10:00:00.000Z'
    }),
    { by: 'kari@books.example', at: '2026-06-08T10:00:00.000Z' }
  );
  assert.deepEqual(
    readJurisdictionConfirmation({
      profile: {
        jurisdiction_confirmed_by: 'kari@books.example',
        jurisdiction_confirmed_at: '2026-06-08T10:00:00.000Z'
      }
    }),
    { by: 'kari@books.example', at: '2026-06-08T10:00:00.000Z' }
  );
});

await test('readJurisdictionConfirmation: keeps the pair when one side is null', () => {
  // System-initiated writes can stamp `at` without a known `by`.
  assert.deepEqual(
    readJurisdictionConfirmation({ jurisdiction_confirmed_at: '2026-06-08T10:00:00.000Z' }),
    { by: null, at: '2026-06-08T10:00:00.000Z' }
  );
  assert.deepEqual(
    readJurisdictionConfirmation({ jurisdiction_confirmed_by: 'kari@books.example' }),
    { by: 'kari@books.example', at: null }
  );
});

await test('readAccountingSystemProvenance: same shape as jurisdiction confirmation', () => {
  assert.equal(readAccountingSystemProvenance({}), null);
  assert.deepEqual(
    readAccountingSystemProvenance({
      accounting_system_set_by: 'kari@books.example',
      accounting_system_set_at: '2026-06-08T10:00:00.000Z'
    }),
    { by: 'kari@books.example', at: '2026-06-08T10:00:00.000Z' }
  );
  assert.deepEqual(
    readAccountingSystemProvenance({
      profile: {
        accounting_system_set_by: 'kari@books.example',
        accounting_system_set_at: '2026-06-08T10:00:00.000Z'
      }
    }),
    { by: 'kari@books.example', at: '2026-06-08T10:00:00.000Z' }
  );
});

await test('readServicesEngagedProvenance: same shape, dual-path, null when both absent', () => {
  assert.equal(readServicesEngagedProvenance({}), null);
  assert.deepEqual(
    readServicesEngagedProvenance({
      services_engaged_set_by: 'kari@books.example',
      services_engaged_set_at: '2026-06-08T10:00:00.000Z'
    }),
    { by: 'kari@books.example', at: '2026-06-08T10:00:00.000Z' }
  );
  assert.deepEqual(
    readServicesEngagedProvenance({
      profile: {
        services_engaged_set_by: 'kari@books.example',
        services_engaged_set_at: '2026-06-08T10:00:00.000Z'
      }
    }),
    { by: 'kari@books.example', at: '2026-06-08T10:00:00.000Z' }
  );
});

await test('readIncorporationDate: two homes, two spellings, ISO timestamp trimmed to date', () => {
  assert.equal(readIncorporationDate({}), null);
  assert.equal(readIncorporationDate({ incorporation_date: '2024-05-01' }), '2024-05-01');
  // pg DATE round-tripped through JSON arrives as a full ISO timestamp.
  assert.equal(readIncorporationDate({ incorporationDate: '2024-05-01T00:00:00.000Z' }), '2024-05-01');
  assert.equal(readIncorporationDate({ profile: { incorporation_date: '2023-11-30' } }), '2023-11-30');
  assert.equal(readIncorporationDate({ profile: { incorporationDate: '2023-11-30' } }), '2023-11-30');
  // Top-level wins over profile, snake over camel.
  assert.equal(readIncorporationDate({ incorporation_date: '2024-05-01', incorporationDate: '2020-01-01' }), '2024-05-01');
});

await test('entityTypeRequiresIncorporationDate: gb incorporated forms only', () => {
  assert.equal(entityTypeRequiresIncorporationDate('gb-ltd'), true);
  assert.equal(entityTypeRequiresIncorporationDate('gb-llp'), true);
  assert.equal(entityTypeRequiresIncorporationDate('gb-sole-trader'), false);
  assert.equal(entityTypeRequiresIncorporationDate('gb-partnership'), false);
  assert.equal(entityTypeRequiresIncorporationDate('fi-oy'), false);
  assert.equal(entityTypeRequiresIncorporationDate(''), false);
  assert.equal(entityTypeRequiresIncorporationDate(null), false);
});

await test('entityTypeCaptureState: shows for a GB client with no entity type', () => {
  const state = entityTypeCaptureState({ jurisdiction: 'gb' });
  assert.equal(state.show, true);
  assert.equal(state.jurisdiction, 'gb');
  assert.deepEqual(state.options, ['gb-ltd', 'gb-llp', 'gb-sole-trader', 'gb-partnership']);
  assert.equal(state.storedEntityType, null);
});

await test('entityTypeCaptureState: hides once a canonical form is stored', () => {
  assert.equal(entityTypeCaptureState({ jurisdiction: 'gb', entity_type: 'gb-ltd' }).show, false);
  assert.equal(entityTypeCaptureState({ jurisdiction: 'fi', entity_type: 'fi-toiminimi' }).show, false);
  // Profile-blob home honoured (the snapshot spreads profile keys top-level,
  // but a raw row shape still reads through).
  assert.equal(entityTypeCaptureState({ jurisdiction: 'gb', profile: { entity_type: 'gb-sole-trader' } }).show, false);
});

await test('entityTypeCaptureState: free-form and cross-jurisdiction forms re-ask', () => {
  // The pre-capture legacy state: a free-form string never validated.
  const legacyGb = entityTypeCaptureState({ jurisdiction: 'gb', entity_type: 'limited company' });
  assert.equal(legacyGb.show, true);
  assert.equal(legacyGb.compatibilityStatus, 'alias');
  assert.equal(legacyGb.suggestedEntityType, 'gb-ltd');
  // FI legacy non-prefixed form — the explicit fi-* backfill path.
  const legacyFi = entityTypeCaptureState({ jurisdiction: 'fi', entityType: 'toiminimi' });
  assert.equal(legacyFi.show, true);
  assert.equal(legacyFi.suggestedEntityType, 'fi-toiminimi');
  // A form canonical for ANOTHER jurisdiction is not canonical here.
  const mismatch = entityTypeCaptureState({ jurisdiction: 'gb', entity_type: 'fi-oy' });
  assert.equal(mismatch.show, true);
  assert.equal(mismatch.compatibilityStatus, 'jurisdiction_mismatch');
  assert.equal(mismatch.suggestedEntityType, null);
  const unsupportedLegacy = entityTypeCaptureState({ jurisdiction: 'sg', entity_type: 'sg-llc' });
  assert.equal(unsupportedLegacy.show, true);
  assert.equal(unsupportedLegacy.compatibilityStatus, 'unsupported');
  assert.ok(!unsupportedLegacy.options.includes('sg-llc'));
});

await test('entityTypeCaptureState: no vocabulary → never shows', () => {
  assert.equal(entityTypeCaptureState({}).show, false);
  assert.equal(entityTypeCaptureState({ jurisdiction: 'unknown' }).show, false);
  assert.equal(entityTypeCaptureState({ jurisdiction: 'de' }).show, false);
});

await test('entityTypeCaptureState: surfaces a known incorporation date for prefill', () => {
  const state = entityTypeCaptureState({ jurisdiction: 'gb', incorporationDate: '2024-05-01T00:00:00.000Z' });
  assert.equal(state.incorporationDate, '2024-05-01');
});

await test('entityTypeRequiresExplicitFiscalPeriod: registry-first forms only', () => {
  // fi-oy refuses calendar resolution without a persisted period; a UK
  // company's ARD is per-company and the opening-balance lane requires a
  // persisted row. Statute answers for everyone else — they are never asked.
  assert.equal(entityTypeRequiresExplicitFiscalPeriod('fi-oy'), true);
  assert.equal(entityTypeRequiresExplicitFiscalPeriod('gb-ltd'), true);
  assert.equal(entityTypeRequiresExplicitFiscalPeriod('gb-llp'), true);
  assert.equal(entityTypeRequiresExplicitFiscalPeriod('gb-sole-trader'), false);
  assert.equal(entityTypeRequiresExplicitFiscalPeriod('gb-partnership'), false);
  assert.equal(entityTypeRequiresExplicitFiscalPeriod('fi-toiminimi'), false);
  assert.equal(entityTypeRequiresExplicitFiscalPeriod('toiminimi'), false);
  assert.equal(entityTypeRequiresExplicitFiscalPeriod(null), false);
});
