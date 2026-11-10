// The first-line lane is dark without its provider (2026-11-10). A local
// book seeds every company with JEV_RECONCILIATION on (hostPlaneSeed.js).
// Before this release, a host with OpenAI and Anthropic and no Typesafe
// configuration left every bank line uncoded: the bank-line producer threw
// `jev_model_not_configured`, the loops runner swallowed it, and the lines
// rested `hanging / reconciliation_status:pending` ("Stalled") until the
// operator added CLIENT_CONFIG_FORCE_DISABLE=JEV_RECONCILIATION.
//
// The one rule (firstLineLane.js): the first-line lane decides for a client
// only when the client's flag acts AND this host has the lane's provider
// (TYPESAFE_API_KEY and TYPESAFE_MODEL). Driven on the real appliance path
// (createDonnaRuntimeServer, the local scheduler, the parse job and its batch
// coder) against real PostgreSQL, providers scripted:
//
//   1. OpenAI + Anthropic, no Typesafe, no kill switch: the lines are coded
//      exactly as under the kill switch; the boot banner and the host's lane
//      inventory say typesafe is DARK and name the missing rows; one audit
//      receipt per client records the dark lane and which lane decided.
//   2. The kill switch: unchanged — coded, and no dark receipt (the flag does
//      not act, so nothing was taken from it).
//   3. Typesafe configured, its call refused: unchanged — the named provider
//      failure rides the line, and no other model decides in its place.

import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { computeConvergenceForTransactions } from './reconcileConvergenceState.js';
import { buildModelLaneReceipt } from './desktop/capabilityReceipt.js';
import { FIRST_LINE_LANE_DARK_ACTION } from './firstLineLane.js';
import { loadRecording } from './testSupport/recordedProviders.js';

const NOW = new Date('2026-08-31T09:00:00.000Z');

const scriptStatement = (appliance) => {
  appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
  appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
  appliance.providers.script('bank_line_disposition', [
    'bank_line_disposition/kestrel-ochre-debit-chase-receipt',
    'bank_line_disposition/kestrel-paylink-credit-chase-evidence'
  ]);
  appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
};

// The committed recording names the lines by placeholder; the run's ids are
// `<document>-tx-<idx>` (codingStateAppliancePgLifecycle.test.js).
const codingRecordingFor = (documentId) => {
  const recording = loadRecording('transaction_coding/kestrel-two-lines-coded');
  const body = JSON.parse(JSON.stringify(recording.body));
  body.output[0].content[0].text = body.output[0].content[0].text
    .split('__TX_PAYOUT__').join(`${documentId}-tx-0`)
    .split('__TX_OCHRE__').join(`${documentId}-tx-1`);
  return { status: recording.status, body };
};

// Upload the two-line statement, run the tick, and read back where each line
// rests: the coding column and the persisted convergence verdict.
const runStatement = async (appliance, clientId) => {
  scriptStatement(appliance);
  const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
  appliance.providers.script('transaction_coding', [codingRecordingFor(statement.documentId)]);
  const tick = await appliance.tick();
  const doc = await appliance.read.document(statement.documentId);
  assert.equal(doc.parse_status, 'completed', JSON.stringify({ parse: doc.parse_error, jobs: tick.jobs.map((j) => [j.function_id, j.status, j.last_error]) }));
  const lines = await appliance.read.transactions(clientId);
  assert.equal(lines.length, 2, 'both statement lines landed');
  const computed = await computeConvergenceForTransactions({ query: appliance.query }, { firmId: appliance.firmId, transactionIds: lines.map((tx) => tx.id) });
  return lines.map((tx) => {
    const verdict = computed.find((c) => c.target_id === tx.id)?.persisted || {};
    return { id: tx.id, coding_state: tx.coding_state, account: tx.payload?.ai_suggestion?.proposed_account || null,
      provider_failure: tx.payload?.coding_provider_failure || null, state: verdict.state, reason: verdict.reason };
  });
};

const assertCodedLikeKillSwitch = (rows, label) => {
  for (const row of rows) {
    assert.equal(row.coding_state, 'proposed', `${label}: ${row.id} coded by the coder (${JSON.stringify(row)})`);
    assert.ok(row.account, `${label}: ${row.id} carries the coder's account`);
    assert.equal(row.provider_failure, null, `${label}: ${row.id} carries no provider failure`);
    assert.deepEqual({ state: row.state, reason: row.reason }, { state: 'hanging', reason: 'coding_state:proposed' },
      `${label}: ${row.id} rests on its coding proposal, not on an undecided line`);
  }
  assert.deepEqual(rows.map((row) => row.account).sort(), ['Repairs and maintenance', 'Sales']);
};

test(
  'real PG (appliance): OpenAI + Anthropic and no Typesafe — the first-line lane is dark, the lines are coded by the lit lanes, the banner and lane inventory name the missing rows, one receipt per client',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: NOW, keys: { typesafe: false },
      env: { CLIENT_CONFIG_FORCE_DISABLE: null, TYPESAFE_MODEL: null } });
    try {
      // The boot banner: the first-line provider DARK, each missing row named.
      const banner = buildModelLaneReceipt(process.env);
      assert.equal(banner.typesafe, false);
      assert.match(banner.line, /typesafe DARK — no TYPESAFE_API_KEY, no TYPESAFE_MODEL/);
      assert.match(banner.line, /openai LIT/);
      assert.match(banner.line, /anthropic LIT/);

      // The host's lane inventory: a dark lane is a receipt, never a failure.
      const host = await appliance.read.host();
      assert.equal(host?.status, 'PASS', JSON.stringify(host?.certificate?.checks?.map(({ id, status }) => [id, status])));
      const routes = host.certificate.checks.find(({ id }) => id === 'model_routes');
      assert.equal(routes.status, 'PASS');
      assert.deepEqual(routes.detail.dark_providers, ['typesafe']);
      assert.deepEqual(routes.detail.dark_lanes, ['jev_reconciliation']);
      const firstLine = routes.detail.lanes.find(({ lane_id }) => lane_id === 'jev_reconciliation');
      assert.equal(firstLine.credential_present, false);
      assert.deepEqual(firstLine.missing_env, ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL']);

      const { clientId } = await appliance.createClient();
      const flag = (await appliance.read.flags(clientId)).find((row) => row.flag_key === 'JEV_RECONCILIATION');
      assert.deepEqual({ stage: flag?.stage, source: flag?.source }, { stage: 'auto', source: 'default' }, 'the seed is unchanged: the flag is on');

      const rows = await runStatement(appliance, clientId);
      assertCodedLikeKillSwitch(rows, 'dark lane');
      assert.ok(!appliance.providers.calls.some((call) => call.endpoint_class === 'typesafe'), 'no first-line request was sent');

      const receipts = await appliance.read.audit({ clientId, action: FIRST_LINE_LANE_DARK_ACTION });
      assert.equal(receipts.length, 1, 'one dark-lane receipt for the client');
      assert.deepEqual({ ...receipts[0].metadata, decided_by: typeof receipts[0].metadata.decided_by }, {
        lane_id: 'jev_reconciliation', flag_key: 'JEV_RECONCILIATION', provider: 'typesafe',
        reason: 'provider_not_configured', missing_env: ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL'], decided_by: 'string'
      });
      assert.ok(['bank_line_disposition', 'transaction_coding'].includes(receipts[0].metadata.decided_by), receipts[0].metadata.decided_by);

      // More work on the same client writes no second receipt; a second
      // client gets its own.
      await appliance.tick({ advanceMs: 10 * 60_000 });
      assert.equal((await appliance.read.audit({ clientId, action: FIRST_LINE_LANE_DARK_ACTION })).length, 1, 'still one receipt for the client');
      const second = await appliance.createClient();
      assertCodedLikeKillSwitch(await runStatement(appliance, second.clientId), 'dark lane, second client');
      assert.equal((await appliance.read.audit({ clientId: second.clientId, action: FIRST_LINE_LANE_DARK_ACTION })).length, 1, 'the second client has its own receipt');
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (appliance): the kill switch is unchanged — coded, and no dark-lane receipt',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: NOW, keys: { typesafe: false },
      env: { CLIENT_CONFIG_FORCE_DISABLE: 'JEV_RECONCILIATION', TYPESAFE_MODEL: null } });
    try {
      const { clientId } = await appliance.createClient();
      assertCodedLikeKillSwitch(await runStatement(appliance, clientId), 'kill switch');
      assert.equal((await appliance.read.audit({ clientId, action: FIRST_LINE_LANE_DARK_ACTION })).length, 0,
        'the flag does not act under the kill switch: nothing was taken from it, nothing is receipted');
    } finally {
      await appliance.stop();
    }
  }
);

test(
  'real PG (appliance): Typesafe configured and its call refused — the named provider failure stays, no other model decides',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: NOW, keys: { typesafe: true },
      env: { CLIENT_CONFIG_FORCE_DISABLE: null, TYPESAFE_MODEL: 'fixture-first-line' } });
    try {
      assert.match(buildModelLaneReceipt(process.env).line, /typesafe LIT — TYPESAFE_MODEL: fixture-first-line/);
      const routes = (await appliance.read.host()).certificate.checks.find(({ id }) => id === 'model_routes');
      assert.ok(!routes.detail.dark_lanes.includes('jev_reconciliation'), JSON.stringify(routes.detail.dark_lanes));

      const { clientId } = await appliance.createClient();
      // Typesafe is left unscripted: every first-line request is refused at the wire.
      const rows = await runStatement(appliance, clientId);
      for (const row of rows) {
        assert.equal(row.coding_state, null, `${row.id}: not coded by another model (${JSON.stringify(row)})`);
        assert.equal(row.account, null, `${row.id}: no suggestion`);
        assert.equal(row.provider_failure?.provider, 'typesafe', `${row.id}: the failure names the first-line provider`);
        assert.match(row.provider_failure?.reason || '', /^typesafe_/, `${row.id}: the named failure`);
      }
      assert.ok(appliance.providers.unscripted.some((call) => call.endpoint_class === 'typesafe' && call.model_requested === 'fixture-first-line'),
        'the first-line provider was asked, with the configured model');
      assert.equal((await appliance.read.audit({ clientId, action: FIRST_LINE_LANE_DARK_ACTION })).length, 0, 'a configured lane is not dark');
    } finally {
      await appliance.stop();
    }
  }
);
