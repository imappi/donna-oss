import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertGate2bLivePreflight,
  captureRepliedCheckpoint,
  driveGate2bProductionEpoch,
  mapTransactionsToWorldEvents,
  parseArgs,
} from './eval_world_birth_to_quiescence.js';

const budget = {
  status: 'APPROVED', first_live_call_allowed: true, k: 3,
  lanes: [{ provider: 'openai' }],
};
const readyEnv = {
  EAW_GATE2B_ISOLATED_DB: '1', DONNA_DESKTOP_BLOB_DIR: '/tmp/eaw-store',
  DONNA_ACCESS_TOKEN: 'present', OPENAI_API_KEY: 'present',
};

test('Gate 2B preflight refuses before live work when authority or dependencies are absent', () => {
  const ops = { isFirmDatabaseConfigured: () => false };
  assert.throws(
    () => assertGate2bLivePreflight({ budget: null, env: {}, ops }),
    (error) => error.code === 'EAW_GATE2B_INCOMPLETE'
      && /approved measured hard cap/.test(error.message)
      && /configured PostgreSQL/.test(error.message),
  );
  assert.deepEqual(
    assertGate2bLivePreflight({ budget, env: readyEnv, ops: { isFirmDatabaseConfigured: () => true } }),
    { status: 'READY', k: 3, providers: ['openai'] },
  );
});

test('one Gate 2B epoch composes the real scoped workers in the declared order', async () => {
  const calls = [];
  const named = (name) => async () => { calls.push(name); return { name }; };
  const ops = {
    runReconciliationForBankStatementInDb: named('reconciliation'),
    runCodingConvergenceInDb: named('coding'),
    withFirmDbClient: async (work) => work({ query: async () => ({ rows: [] }) }),
    drainAskDraftRequests: named('draft'),
    drainAutoSendAskBatches: named('send'),
    drainLoopInbox: named('inbox'),
    dispatchLoopOutbox: named('outbox'),
  };
  const receipt = await driveGate2bProductionEpoch({ ops, firmId: 'eaw-run', clientId: 'eaw-run-client-1', env: {}, asOf: 10 });
  assert.deepEqual(calls, ['reconciliation', 'coding', 'draft', 'send', 'inbox', 'outbox', 'coding']);
  assert.equal(receipt.resumed_coding.name, 'coding');
});

test('reply observer captures durable replied before named processing resolves it', async () => {
  let status = 'open';
  const result = await captureRepliedCheckpoint({
    askId: 'ask-1',
    startReply: async () => {
      await tick();
      status = 'replied';
      await tick();
      await tick();
      status = 'resolved';
      return { applied: true };
    },
    readAskStatus: async () => status,
    readInventory: async () => ({
      asks: [{ id: 'ask-1', status }],
      obligations: [{ id: 'obligation-1', state: 'hanging', reason: 'owner_answered_processing' }],
    }),
  });
  assert.equal(result.checkpoint.asks[0].status, 'replied');
  assert.equal(result.checkpoint.obligations[0].state, 'hanging');
  assert.deepEqual(result.result, { applied: true });
});

test('reply observer fails rather than inventing an unobserved checkpoint', async () => {
  await assert.rejects(
    captureRepliedCheckpoint({
      askId: 'ask-1',
      startReply: async () => ({ applied: true }),
      readAskStatus: async () => 'resolved',
      readInventory: async () => ({}),
    }),
    (error) => error.code === 'EAW_GATE2B_REPLIED_NOT_OBSERVED',
  );
});

test('Gate 2B CLI requires explicit budget and keeps the real authority actor class', () => {
  assert.deepEqual(parseArgs([
    '--run-token', 'lane', '--actor-id', 'kari', '--budget', '/tmp/budget.json', '--output', '/tmp/out.json',
  ]), {
    runToken: 'lane', actorType: 'firm_operator', actorId: 'kari', budgetPath: '/tmp/budget.json', output: '/tmp/out.json',
  });
});

test('world-event mapping consumes the normalized production snapshot date and retains the raw-row fallback', () => {
  const world = {
    events: [{
      id: 'event/director-charge', occurredAt: '2026-08-04',
      monetaryEffects: { amount: 24, currency: 'GBP' },
    }],
  };
  const mounted = mapTransactionsToWorldEvents({
    world,
    transactions: [{ id: 'tx-mounted', date: '2026-08-04', money_out: 24 }],
  });
  assert.equal(mounted.get('tx-mounted'), 'event/director-charge');

  const raw = mapTransactionsToWorldEvents({
    world,
    transactions: [{ id: 'tx-raw', transaction_date: '2026-08-04', money_out: 24 }],
  });
  assert.equal(raw.get('tx-raw'), 'event/director-charge');
});

function tick() { return new Promise((resolve) => setImmediate(resolve)); }
