// Unit tests for the business register adapter (no database): Business ID
// parsing, the closed action shapes, the pure projection against the pinned
// contract, and the patch each action writes, including its refusals.
// Synthetic data only: the Business IDs are low-numbered, check-digit-valid
// values outside any issued range.
import assert from 'node:assert/strict';
import test from 'node:test';

import { componentSchema, validateAgainst } from './contractSchema.js';
import { mobileRouteState } from './mobileApi.js';
import {
  canonicalBusinessId,
  parseSetupAction,
  projectBusinessIdentity,
  projectBusinessSetup,
  setupPatchFor
} from './mobileBusinessSetup.js';

const NOW = new Date('2026-11-10T09:00:00.000Z');
const row = (overrides = {}) => ({
  id: 'c1', company_name: 'Aurora Kettle Works', entity_type: 'fi-toiminimi', jurisdiction: 'FI', firm_jurisdiction: 'FI',
  profile_currency: null, firm_currency: 'EUR', business_id: null, legal_name: null, business_register: null,
  business_setup: null, has_documents: false, ...overrides
});
const confirmedRow = (overrides = {}) => row({
  business_id: '0000001-9', legal_name: 'Aurora Kettle Works Tmi',
  business_register: { business_id: '0000001-9', legal_form: 'sole_trader', legal_form_code: null, registered_address: '', source: 'owner', fetched_at: null },
  ...overrides
});
const conformsTo = (name, value) => assert.deepEqual(validateAgainst(value, componentSchema(name)), [], `${name} conforms`);
const refusal = (fn, status, code) => assert.throws(fn, (error) => error.statusCode === status && error.code === code);

test('the business-setup routes are served; lookup stays an honest 501', () => {
  assert.equal(mobileRouteState('GET', '/entities/c1/business-setup'), 'implemented');
  assert.equal(mobileRouteState('POST', '/entities/c1/business-setup'), 'implemented');
  assert.equal(mobileRouteState('POST', '/entities/c1/business-setup/lookup'), 'not_implemented');
});

test('Business IDs: the typed forms the owner may use, checked by Donna’s own validator', () => {
  assert.equal(canonicalBusinessId('0000001-9'), '0000001-9');
  assert.equal(canonicalBusinessId(' 00000019 '), '0000001-9');
  assert.equal(canonicalBusinessId('FI00000019'), '0000001-9');
  assert.equal(canonicalBusinessId('0000001-8'), null, 'wrong check digit');
  assert.equal(canonicalBusinessId('0000005-?'), null);
  assert.equal(canonicalBusinessId('123456-7'), null);
  assert.equal(canonicalBusinessId(12345678), null);
});

test('actions: the closed shapes only', () => {
  refusal(() => parseSetupAction({}), 400, 'SETUP_ACTION_INVALID');
  refusal(() => parseSetupAction({ type: 'replace' }), 400, 'SETUP_ACTION_INVALID');
  refusal(() => parseSetupAction({ type: 'confirm_registry', candidate_id: '' }), 400, 'CANDIDATE_ID_REQUIRED');
  refusal(() => parseSetupAction({ type: 'confirm_manual', business_id: '0000001-8', legal_name: 'X', legal_form: 'other' }), 400, 'BUSINESS_ID_INVALID');
  refusal(() => parseSetupAction({ type: 'confirm_manual', business_id: '0000001-9', legal_name: 'x'.repeat(1001), legal_form: 'other' }), 400, 'BUSINESS_DETAILS_INVALID');
  refusal(() => parseSetupAction({ type: 'confirm_manual', business_id: '0000001-9', legal_name: 'X', legal_form: 'oy' }), 400, 'BUSINESS_DETAILS_INVALID');
  refusal(() => parseSetupAction({ type: 'set_stage', business_stage: 'later' }), 400, 'BUSINESS_STAGE_INVALID');
  assert.deepEqual(parseSetupAction({ type: 'confirm_manual', business_id: '00000019', legal_name: ' Aurora Oy ', legal_form: 'limited_company' }),
    { type: 'confirm_manual', businessId: '0000001-9', legalName: 'Aurora Oy', legalForm: 'limited_company' });
  assert.deepEqual(parseSetupAction({ type: 'defer', extra: true }), { type: 'defer' });
});

test('projection: conforms to BusinessSetup in every state and never claims authority', () => {
  const states = [
    row(),
    confirmedRow(),
    confirmedRow({ business_setup: { business_stage: 'new', suggestion_dismissed: true } }),
    confirmedRow({ business_setup: { business_stage: 'existing' }, has_documents: true }),
    confirmedRow({ business_register: { business_id: '0000001-9', legal_form: 'limited_company', legal_form_code: 'OY', registered_address: 'Testikatu 1, 00100 HELSINKI', source: 'prh_ytj', fetched_at: '2026-11-10T08:00:00Z' } })
  ];
  for (const state of states) conformsTo('BusinessSetup', projectBusinessSetup(state));
  assert.equal(projectBusinessSetup(row()).next_step, 'identify_business');
  assert.equal(projectBusinessSetup(confirmedRow()).next_step, 'business_stage');
  assert.equal(projectBusinessSetup(confirmedRow({ business_setup: { business_stage: 'existing' } })).next_step, 'first_receipt');
  assert.equal(projectBusinessSetup(confirmedRow({ business_setup: { business_stage: 'new' }, has_documents: true })).next_step, 'done');
  for (const state of states) {
    const setup = projectBusinessSetup(state);
    assert.deepEqual(setup.prior_record_ids, []);
    if (setup.identity) assert.equal(setup.identity.authority_verified, false);
  }
  assert.equal(projectBusinessIdentity(states[4]).fetched_at, '2026-11-10T08:00:00.000Z');
});

test('projection: an ID recorded some other way, or since corrected by the firm, is not served as confirmed', () => {
  assert.equal(projectBusinessIdentity(row({ business_id: '0000001-9' })), null);
  assert.equal(projectBusinessIdentity(confirmedRow({ business_id: '0000002-7' })), null);
  assert.equal(projectBusinessIdentity(confirmedRow({ business_id: '00000019' }))?.business_id, '0000001-9', 'stored without the hyphen');
  assert.equal(projectBusinessIdentity(confirmedRow({ business_register: { business_id: '0000001-9', legal_form: 'oy', source: 'owner' } })), null);
});

test('confirm_manual: writes the existing homes, never the statutory legal form, and never replaces an ID', () => {
  const action = parseSetupAction({ type: 'confirm_manual', business_id: '0000001-9', legal_name: 'Aurora Kettle Works Tmi', legal_form: 'sole_trader' });
  const patch = setupPatchFor({ action, row: row({ business_setup: { business_stage: 'new', suggestion_dismissed: true } }), actorId: 'collab-1', now: NOW });
  assert.equal(patch.businessId, '0000001-9');
  assert.equal(patch.legalName, 'Aurora Kettle Works Tmi');
  assert.equal('companyName' in patch, false, 'the owner-edited name stays');
  assert.equal('entity_type' in patch, false);
  assert.equal('entityType' in patch, false);
  assert.deepEqual(patch.business_setup, { business_stage: 'new', suggestion_dismissed: false });
  assert.equal(patch.business_register.source, 'owner');
  assert.equal(patch.business_register.confirmed_by, 'collab-1');
  assert.equal(patch.business_register.confirmed_at, NOW.toISOString());
  assert.equal(setupPatchFor({ action, row: row({ company_name: '' }), actorId: 'collab-1', now: NOW }).companyName,
    'Aurora Kettle Works Tmi', 'an empty business name takes the legal name');
  assert.doesNotThrow(() => setupPatchFor({ action, row: confirmedRow(), actorId: 'collab-1', now: NOW }), 'the same ID is a confirmation');
  refusal(() => setupPatchFor({ action, row: row({ business_id: '0000002-7' }), actorId: 'collab-1' }), 409, 'BUSINESS_ID_LOCKED');
  refusal(() => setupPatchFor({ action, row: row({ business_id: 'not-a-y-tunnus' }), actorId: 'collab-1' }), 409, 'BUSINESS_ID_LOCKED');
  refusal(() => setupPatchFor({ action, row: row({ jurisdiction: 'GB', firm_jurisdiction: 'GB' }), actorId: 'collab-1' }), 400, 'BUSINESS_REGISTER_FINLAND_ONLY');
  refusal(() => setupPatchFor({ action, row: row({ jurisdiction: null, firm_jurisdiction: null }), actorId: 'collab-1' }), 400, 'BUSINESS_REGISTER_FINLAND_ONLY');
});

test('confirm_registry: no candidate is current on this server; stage and defer keep the other answers', () => {
  refusal(() => setupPatchFor({ action: { type: 'confirm_registry', candidateId: 'x' }, row: row(), actorId: 'collab-1' }), 409, 'REGISTRY_CANDIDATE_EXPIRED');
  assert.deepEqual(setupPatchFor({ action: { type: 'set_stage', businessStage: 'existing' }, row: row({ business_setup: { suggestion_dismissed: true } }) }),
    { business_setup: { business_stage: 'existing', suggestion_dismissed: false } });
  assert.deepEqual(setupPatchFor({ action: { type: 'defer' }, row: row({ business_setup: { business_stage: 'new' } }) }),
    { business_setup: { business_stage: 'new', suggestion_dismissed: true } });
});
