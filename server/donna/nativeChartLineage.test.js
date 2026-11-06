import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeBirthDefinition, validateNativeBirthInput, verifyNativeChartObservation,
  readNativeChartReceipts } from './nativeChartLineage.js';

const input = { id: 'sg_pte_native.v1', bookkeeping_start_date: '2026-01-01',
  registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } };
const row = { jurisdiction: 'SG', entity_type: 'sg-pte', profile: {
  accounting_system: 'none', accounting_view: 'management_books', defaultCurrency: 'SGD'
} };
const actor = { actorType: 'firm_member', actorId: 'active-member', authorityBasis: {
  source: 'authenticated_firm_create_route', principal_id: 'active-member'
} };
const refuses = (fn, reason) => assert.throws(fn, error => error.code === 'NATIVE_CHART_LINEAGE_INVALID' && error.details.reason === reason);

test('birth input cannot infer date, registration, accounting posture or authority', () => {
  assert.equal(validateNativeBirthInput(input, row, actor).selection.accounts.length, 58);
  for (const date of [null, '', '2026-02-30', '2026-01-01T00:00:00Z']) {
    refuses(() => validateNativeBirthInput({ ...input, bookkeeping_start_date: date }, row, actor), 'bookkeeping_start_date_invalid');
  }
  for (const key of ['accounting_system', 'accounting_view', 'defaultCurrency']) {
    const profile = { ...row.profile }; delete profile[key];
    refuses(() => validateNativeBirthInput(input, { ...row, profile }, actor), 'birth_accounting_posture_invalid');
  }
  refuses(() => validateNativeBirthInput({ ...input, native: true }, row, actor), 'birth_input_invalid');
  refuses(() => validateNativeBirthInput(input, { ...row, profile: { ...row.profile, gst_registration: { registered: true } } }, actor), 'registration_observation_mismatch');
  refuses(() => validateNativeBirthInput(input, row, { ...actor, actorId: 'system' }), 'birth_actor_required');
  refuses(() => validateNativeBirthInput(input, { ...row, jurisdiction: 'GB' }, actor), 'birth_identity_invalid');
});

test('a forged profile is not lineage; a marked incomplete book cannot fall back', () => {
  const observation = { firmId: 'f', clientId: 'c', client: { ...row, id: 'c', firm_id: 'f',
    profile: { ...row.profile, birthContract: input, native_chart_birth: true } }, accounts: [], receipts: [] };
  assert.equal(verifyNativeChartObservation(observation), null);
  refuses(() => verifyNativeChartObservation(observation, { expectedContract: input.id }), 'seed_receipt_count');
  refuses(() => verifyNativeChartObservation({ ...observation, accounts: [{ payload: { birth_contract: input.id } }] }), 'seed_receipt_count');
  refuses(() => nativeBirthDefinition('sg_pte_native.v999'), 'contract_unsupported');
  const definition = nativeBirthDefinition(input.id);
  definition.selection.accounts[0].name_en = 'mutated caller copy';
  assert.notEqual(nativeBirthDefinition(input.id).selection.accounts[0].name_en, 'mutated caller copy');
});

test('receipt I/O scopes immutable events and orders numeric ids before textual projection', async () => {
  const receipts = [{ id: '9' }, { id: '10' }];
  const actual = await readNativeChartReceipts({ firmId: 'firm', clientId: 'client', query: async (sql, args) => {
    assert.match(sql, /firm_id=\$1 and resource_id=\$2/);
    assert.match(sql, /order by audit_events\.id/);
    assert.deepEqual(args, ['firm', 'client', ['client.create', 'client.delete', 'ledger.chart.palette_seeded']]);
    return { rows: receipts };
  } });
  assert.equal(actual, receipts);
});
