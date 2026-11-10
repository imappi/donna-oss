import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIRST_LINE_FLAG, FIRST_LINE_LANE_DARK_ACTION, FIRST_LINE_PROVIDER_ENV,
  firstLineLaneDecides, firstLineLaneDecidesWithClient, firstLineLanePosture, firstLineProviderMissing
} from './firstLineLane.js';
import { getLane } from './modelLanes.js';

const ON = { JEV_RECONCILIATION: { stage: 'auto', source: 'default' } };
const OFF = { JEV_RECONCILIATION: { stage: 'off', source: 'manual' } };
const CONFIGURED = { TYPESAFE_API_KEY: 'fixture-key', TYPESAFE_MODEL: 'fixture-first-line' };

test('the rule reads the lane registry: the flag and the model row are the jev_reconciliation lane\'s', () => {
  const lane = getLane('jev_reconciliation');
  assert.equal(FIRST_LINE_FLAG, lane.desktopDefault.flagKey);
  assert.deepEqual(FIRST_LINE_PROVIDER_ENV, ['TYPESAFE_API_KEY', lane.desktopDefault.modelEnvironmentKey]);
});

test('the first-line lane decides only when the flag acts AND the provider is configured', () => {
  const cases = [
    ['flag on, configured', ON, CONFIGURED, { decides: true, flag_acts: true, dark: false, missing_env: [] }],
    ['flag on, nothing configured', ON, {}, { decides: false, flag_acts: true, dark: true, missing_env: ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL'] }],
    ['flag on, key without model', ON, { TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: '  ' }, { decides: false, flag_acts: true, dark: true, missing_env: ['TYPESAFE_MODEL'] }],
    ['flag on, configured, kill switch', ON, { ...CONFIGURED, CLIENT_CONFIG_FORCE_DISABLE: 'JEV_RECONCILIATION' }, { decides: false, flag_acts: false, dark: false, missing_env: [] }],
    ['flag on, not configured, kill switch', ON, { CLIENT_CONFIG_FORCE_DISABLE: 'all' }, { decides: false, flag_acts: false, dark: false, missing_env: ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL'] }],
    ['flag off, configured', OFF, CONFIGURED, { decides: false, flag_acts: false, dark: false, missing_env: [] }],
    ['no row, configured: a key never switches the lane on', {}, CONFIGURED, { decides: false, flag_acts: false, dark: false, missing_env: [] }]
  ];
  for (const [label, snapshot, env, expected] of cases) {
    assert.deepEqual(firstLineLanePosture({ snapshot, env }), expected, label);
    assert.equal(firstLineLaneDecides({ snapshot, env }), expected.decides, label);
  }
  assert.deepEqual(firstLineProviderMissing({}), ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL']);
});

const fakeClient = () => {
  const rows = [];
  return {
    rows,
    async query(text, params) {
      if (/^select 1 from audit_events/.test(text)) {
        return { rowCount: rows.filter((row) => row.firm_id === params[0] && row.client_id === params[1] && row.action === params[2]).length };
      }
      if (/^insert into audit_events/.test(text)) {
        assert.match(text, /on conflict \(firm_id, client_id\) where action = 'model_lane\.first_line_dark' do nothing/);
        rows.push({ id: rows.length + 1, firm_id: params[0], client_id: params[1], action: params[2], metadata: JSON.parse(params[3]) });
        return { rows: [{ id: rows.length }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    }
  };
};

test('the writer form receipts a dark lane once per client, naming the lane, why and who decided', async () => {
  const client = fakeClient();
  const ask = (clientId, decidedBy, env = {}) => firstLineLaneDecidesWithClient(client, { firmId: 'firm-1', clientId, snapshot: ON, decidedBy, env });
  assert.equal(await ask('client-1', 'transaction_coding'), false);
  assert.equal(await ask('client-1', 'bank_line_disposition'), false);
  assert.equal(await ask('client-2', 'bank_line_disposition'), false);
  assert.deepEqual(client.rows.map(({ client_id, action, metadata }) => [client_id, action, metadata]), [
    ['client-1', FIRST_LINE_LANE_DARK_ACTION, { lane_id: 'jev_reconciliation', flag_key: 'JEV_RECONCILIATION', provider: 'typesafe',
      reason: 'provider_not_configured', missing_env: ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL'], decided_by: 'transaction_coding' }],
    ['client-2', FIRST_LINE_LANE_DARK_ACTION, { lane_id: 'jev_reconciliation', flag_key: 'JEV_RECONCILIATION', provider: 'typesafe',
      reason: 'provider_not_configured', missing_env: ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL'], decided_by: 'bank_line_disposition' }]
  ]);
  // Configured, killed, or flag off: nothing is dark, nothing is written.
  assert.equal(await ask('client-3', 'transaction_coding', CONFIGURED), true);
  assert.equal(await ask('client-4', 'transaction_coding', { CLIENT_CONFIG_FORCE_DISABLE: 'JEV_RECONCILIATION' }), false);
  assert.equal(await firstLineLaneDecidesWithClient(client, { firmId: 'firm-1', clientId: 'client-5', snapshot: OFF, env: {} }), false);
  assert.equal(client.rows.length, 2);
});
