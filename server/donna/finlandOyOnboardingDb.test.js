import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFinlandOyOnboardingStateFromDb
} from './statutoryRegistry.js';

const err = (code) => Object.assign(new Error(code), { code });

// The pilot cap table + authority structure, as the joined store rows.
const soleOwnerHoldings = [
  { shareholder_id: 'h1', display_name: 'Alex', party_type: 'natural_person', is_finnish_resident: true, share_class_id: 'c1', class_name: 'ordinary', votes_per_share: 1, share_count: 100 }
];
const soleDecisionMakerRoles = [
  { id: 'r1', holder_ref: 'ref-alex', holder_display_name: 'Alex', role: 'board_membership', authority_basis: 'trade_register', status: 'active' },
  { id: 'r2', holder_ref: 'ref-alex', holder_display_name: 'Alex', role: 'company_representation', authority_basis: 'trade_register', status: 'active' }
];

const fakeClient = ({
  entityType = 'fi-oy',
  flags = {},
  holdings = [],
  authorityRows = [],
  holdingsThrow = null,
  authorityThrow = null
} = {}) => ({
  async query(sql) {
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('select entity_type, profile from clients')) {
      return { rows: [{ entity_type: entityType, profile: {} }] };
    }
    if (sql.includes('from finland_shareholdings')) {
      if (holdingsThrow) throw holdingsThrow;
      return { rows: holdings };
    }
    if (sql.includes('from finland_authority_roles')) {
      if (authorityThrow) throw authorityThrow;
      return { rows: authorityRows };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const call = (opts = {}, callerArgs = {}) => getFinlandOyOnboardingStateFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  readAt: '2026-07-12T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(fakeClient(opts)),
  ...callerArgs
});

test('greenfield fi-oy with nothing recorded: unknowns rest on the owner, never a disqualification from absence', async () => {
  const state = await call();
  assert.equal(state.entity_type, 'fi-oy');
  // The entity gate is derived from the client row and passes.
  assert.ok(!state.envelope.failures.some((f) => f.id === 'finnish_private_limited'));
  // Ownership/authority are not yet recorded → unconfirmed on the owner, and
  // the overall verdict is review_required — NOT out_of_segment.
  const ownershipFiring = state.envelope.failures.find((f) => f.id === 'single_resident_natural_shareholder');
  assert.equal(ownershipFiring?.reason, 'unconfirmed');
  assert.equal(ownershipFiring?.escalates_to, 'owner');
  assert.equal(state.envelope.verdict, 'review_required');
  // Dark client: the capability contract renders every lane not_enabled.
  assert.equal(state.capabilities.master_enabled, false);
  assert.ok(state.capabilities.lanes.every((l) => l.state === 'not_enabled'));
  // Recorded-but-empty authority: visible as recorded with no roles.
  assert.equal(state.authority.recorded, true);
  assert.deepEqual(state.authority.roles, []);
  assert.deepEqual(state.authority.basis_gaps, []);
});

test('the fully-recorded pilot client clears the derived gates; declared attributes carry it to accepted', async () => {
  const opts = {
    flags: { FINLAND_OY: 'auto', FINLAND_OY_BOOKKEEPING: 'auto' },
    holdings: soleOwnerHoldings,
    authorityRows: soleDecisionMakerRoles
  };
  const state = await call(opts);
  for (const derivedGate of ['finnish_private_limited', 'single_resident_natural_shareholder', 'single_share_class', 'single_decision_maker_authority']) {
    assert.ok(!state.envelope.failures.some((f) => f.id === derivedGate), `${derivedGate} cleared from the persisted models`);
  }
  // The remaining declared gates still rest on the owner…
  assert.equal(state.envelope.verdict, 'review_required');
  // …and the capability contract shows exactly the flipped lane.
  assert.equal(state.capabilities.master_enabled, true);
  assert.equal(state.capabilities.lanes.find((l) => l.id === 'bookkeeping').state, 'supported');
  assert.equal(state.capabilities.lanes.find((l) => l.id === 'dividend').state, 'not_enabled');

  // With the intake's declared answers merged in, the envelope accepts.
  const declared = {
    taxResidentFinland: true, businessKind: 'service', hasSubsidiariesOrGroup: false,
    hasForeignPermanentEstablishment: false, hasInventoryOrCogs: false,
    hasPropertySecuritiesOrCrypto: false, hasShareholderLoans: false,
    wantsAutomatedDividends: false, employeesBeyondOwner: false, alvStatus: 'standard',
    auditRequired: false, fiscalPeriodChangeInProgress: false,
    openingBalancesCleanWithEvidence: true, modestVolume: true,
    tilikausiCrossesRateBoundary: false, ownershipChangeInProgress: false
  };
  const accepted = await call(opts, { attributes: declared });
  assert.equal(accepted.envelope.verdict, 'accepted');
  assert.equal(accepted.envelope.accepted, true);
});

test('render-the-persisted-verdict: a stored two-owner cap table outranks a declared single-owner claim', async () => {
  const state = await call(
    { holdings: [
      { ...soleOwnerHoldings[0], share_count: 60 },
      { shareholder_id: 'h2', display_name: 'Anna', party_type: 'natural_person', is_finnish_resident: true, share_class_id: 'c1', class_name: 'ordinary', votes_per_share: 1, share_count: 40 }
    ] },
    { attributes: { singleShareholderFullOwnership: true } }
  );
  const firing = state.envelope.failures.find((f) => f.id === 'single_resident_natural_shareholder');
  assert.equal(firing?.reason, 'disqualified');
  assert.equal(state.envelope.verdict, 'out_of_segment');
  assert.equal(state.attributes.singleShareholderFullOwnership, false, 'derived overrode declared');
});

test('an insufficient authority basis surfaces as a visible gap without blocking the read', async () => {
  const state = await call({
    holdings: soleOwnerHoldings,
    authorityRows: [
      ...soleDecisionMakerRoles,
      { id: 'r3', holder_ref: 'ref-alex', holder_display_name: 'Alex', role: 'tax_filing', authority_basis: 'owner_attestation', status: 'active' }
    ]
  });
  assert.deepEqual(state.authority.basis_gaps.map((g) => [g.role, g.authority_basis]), [['tax_filing', 'owner_attestation']]);
  // The gap does not touch the decision-maker gate — that structure is intact.
  assert.ok(!state.envelope.failures.some((f) => f.id === 'single_decision_maker_authority'));
});

test('pre-migration stores soft-fail: the read degrades to unknowns, never a crash', async () => {
  const state = await call({ holdingsThrow: err('42P01'), authorityThrow: err('42P01') });
  assert.equal(state.cap_table, null);
  assert.equal(state.authority.recorded, false);
  assert.deepEqual(state.authority.roles, []);
  // The envelope still evaluates — ownership/authority gates are unconfirmed.
  assert.equal(state.envelope.verdict, 'review_required');
  assert.equal(state.envelope.failures.find((f) => f.id === 'single_resident_natural_shareholder')?.reason, 'unconfirmed');
});

test('a non-Oy entity type is a recorded disqualification (out_of_segment), and clientId is required', async () => {
  const state = await call({ entityType: 'fi-toiminimi' });
  assert.equal(state.envelope.failures.find((f) => f.id === 'finnish_private_limited')?.reason, 'disqualified');
  assert.equal(state.envelope.verdict, 'out_of_segment');
  await assert.rejects(() => getFinlandOyOnboardingStateFromDb({ firmId: 'firm-1' }), /Client id is required/);
});
