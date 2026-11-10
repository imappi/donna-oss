// The phone business register's keys in the profile known-keys validator:
// exactly what mobile/mobileBusinessSetup.js setupPatchFor writes passes
// through without an "unknown key" warning; anything else is a 400.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormaliseProfilePatch, __SCHEMA__ } from './clientProfileSchema.js';
import { BUSINESS_STAGES, LEGAL_FORMS, setupPatchFor } from './mobile/mobileBusinessSetup.js';

const row = { company_name: '', jurisdiction: 'FI', entity_type: 'fi-toiminimi', business_id: null, business_setup: null };
const refused = (patch) => assert.throws(() => validateAndNormaliseProfilePatch(patch), (error) => error.statusCode === 400,
  JSON.stringify(patch).slice(0, 160));

test('the schema keeps the phone register vocabulary', () => {
  assert.deepEqual(__SCHEMA__.BUSINESS_REGISTER_LEGAL_FORMS, [...LEGAL_FORMS]);
  assert.deepEqual(__SCHEMA__.BUSINESS_SETUP_STAGES, [...BUSINESS_STAGES]);
});

test('every patch the phone register writes is known and stored unchanged', () => {
  const now = new Date('2026-11-10T09:00:00.000Z');
  const patches = [
    setupPatchFor({ action: { type: 'confirm_manual', businessId: '0000001-9', legalName: 'Fixture Kettle Tmi', legalForm: 'sole_trader' },
      row, actorId: 'collab-fixture', now }),
    setupPatchFor({ action: { type: 'confirm_manual', businessId: '0000001-9', legalName: 'Fixture Kettle Tmi', legalForm: 'other' },
      row: { ...row, company_name: 'Fixture Kettle' }, actorId: null, now }),
    setupPatchFor({ action: { type: 'set_stage', businessStage: 'new' }, row, actorId: 'collab-fixture', now }),
    setupPatchFor({ action: { type: 'defer' }, row: { ...row, business_setup: { business_stage: 'existing' } }, actorId: 'collab-fixture', now })
  ];
  for (const patch of patches) {
    const { patch: out, warnings } = validateAndNormaliseProfilePatch(patch, { jurisdiction: 'fi' });
    assert.deepEqual(warnings, [], JSON.stringify(patch));
    assert.deepEqual(out, patch);
  }
  const fetched = { ...patches[0].business_register, source: 'prh_ytj', fetched_at: '2026-11-10T08:59:00Z', legal_form_code: '26' };
  assert.deepEqual(validateAndNormaliseProfilePatch({ business_register: fetched }).patch.business_register, fetched);
  assert.equal(validateAndNormaliseProfilePatch({ legalName: '  Fixture Kettle Tmi ' }).patch.legalName, 'Fixture Kettle Tmi');
  for (const key of ['legalName', 'business_register', 'business_setup']) {
    assert.equal(validateAndNormaliseProfilePatch({ [key]: null }).patch[key], null, `${key}: null clears`);
  }
});

test('a malformed register value is refused, not preserved', () => {
  const [confirm] = [setupPatchFor({ action: { type: 'confirm_manual', businessId: '0000001-9', legalName: 'Fixture Kettle Tmi', legalForm: 'sole_trader' },
    row, actorId: 'collab-fixture', now: new Date('2026-11-10T09:00:00.000Z') })];
  const register = confirm.business_register;
  for (const legalName of ['', '  ', 7, ['Fixture'], { name: 'Fixture' }, 'x'.repeat(1001)]) refused({ legalName });
  for (const change of [
    { legal_form: 'oy' }, { legal_form: null }, { source: 'scrape' }, { authority_verified: true }, { authority_verified: 'false' },
    { business_id: '' }, { business_id: 12345678 }, { business_id: 'x'.repeat(41) }, { registered_address: null },
    { fetched_at: 'yesterday' }, { confirmed_at: null }, { confirmed_at: '2026-11-10' }, { confirmed_by: 5 },
    { terminal: '' }, { terminal: 'Mobile Phone' }, { legal_form_code: 26 }
  ]) refused({ business_register: { ...register, ...change } });
  const { terminal, ...missingTerminal } = register;
  refused({ business_register: missingTerminal });
  refused({ business_register: { ...register, extra: true } });
  for (const value of [[register], 'confirmed', 1, true]) refused({ business_register: value });
  for (const value of [
    { business_stage: 'old', suggestion_dismissed: false }, { business_stage: 'new', suggestion_dismissed: 'no' },
    { business_stage: 'new' }, { business_stage: 'new', suggestion_dismissed: false, extra: 1 }, [], 'new'
  ]) refused({ business_setup: value });
});

// The Finnish pilot preparation's camelCase keys (hostedPilot.js), validated to
// what it writes: entityType like entity_type, accountingCurrency an ISO code.
test('entityType and accountingCurrency are known keys, validated to what the pilot writes', () => {
  const pilot = { entityType: 'fi-oy', accountingCurrency: 'EUR' };
  const { patch, warnings } = validateAndNormaliseProfilePatch(pilot, { jurisdiction: 'fi' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(patch, pilot);
  assert.equal(validateAndNormaliseProfilePatch({ accountingCurrency: ' gbp ' }).patch.accountingCurrency, 'GBP');
  assert.deepEqual(validateAndNormaliseProfilePatch({ accountingCurrency: null, entityType: null }, { jurisdiction: 'fi' }).patch,
    { accountingCurrency: null, entityType: null });
  for (const value of ['EURO', 'E1R', '', 12, {}]) refused({ accountingCurrency: value });
  for (const patchValue of [{ entityType: 7 }, { entityType: 'fi-made-up-form' }]) {
    assert.throws(() => validateAndNormaliseProfilePatch(patchValue, { jurisdiction: 'fi' }), (error) => error.statusCode === 400, JSON.stringify(patchValue));
  }
});
