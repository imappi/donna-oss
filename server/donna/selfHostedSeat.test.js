// The self-hosted, unqualified seat — its rails, pinned without a database
// (2026-11-10, modelLanes.js SELF_HOSTED_DECISION). The real-PG half is
// selfHostedSeatPgLifecycle.test.js; the stub-server half (routing, typed
// failures, the wire) is selfHostedStubServer.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import { SELF_HOSTED_BASIS, MODEL_LANES, getLane, isQualifiedAnywhere, selfHostedLanes } from './modelLanes.js';
import { MODEL_LANE_POLICY_SET_ACTION, isUnqualifiedSeat, setLaneDecidingPolicy } from './modelLanePolicy.js';
import { isLoopbackBaseUrl, resolveOpenAiCompatibleEndpoint, resolveSeatTransport } from './providerEndpoints.js';
import { evaluateLaneGate } from './modelLaneGate.js';
import { CURRENT_MODEL_POLICY, resolveLitBackends, resolveQualifiedBackends } from './desktop/modelPolicy.js';
import { GRADUATION_CAPABILITIES } from './desktop/graduationBar.js';
import { makeBankLineDispositionChallengerHook } from './bankLineDispositionChallenger.js';
import { makeReconciliationReasoningChallengerHook } from './reconciliationReasoningChallenger.js';
import { buildModelLaneReceipt, selfHostedSeatLine } from './desktop/capabilityReceipt.js';
import { buildSelfHostedLanePlan } from './selfHostedPlan.js';
import { buildLocalSeatRequest, run as runSeatCommand } from '../../scripts/seat_local_model.js';

const MODEL = 'local-test-model-q4';
const SEAT = { deciding_model: MODEL, basis: SELF_HOSTED_BASIS, client_id: 'c1' };

const mockClient = ({ authority = true } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (/from firm_members m/.test(sql)) return { rows: authority ? [{ id: 'm1' }] : [] };
      return { rows: [] };
    }
  };
};
const seat = (overrides = {}) => ({
  firmId: 'f1', clientId: 'c1', laneId: 'transaction_coding', decidingModel: MODEL, basis: SELF_HOSTED_BASIS,
  reason: 'own server', actorType: 'firm_member', actorId: 'm1', ...overrides
});

test('the lanes that can take a local model are exactly the agreed four', () => {
  assert.deepEqual(selfHostedLanes().map((lane) => lane.id).sort(),
    ['ask_drafting', 'bank_line_disposition', 'reconciliation_reasoning', 'transaction_coding']);
  for (const id of ['louis_qa', 'marketing_drafting', 'unified_extraction', 'document_routing', 'chat_engine', 'bank_statement_vision']) {
    assert.equal(getLane(id).selfHosted, null, `${id} stays as it is`);
  }
});

test('writer: a self-hosted seat is written with its receipt, labelled unqualified', async () => {
  const client = mockClient();
  const result = await setLaneDecidingPolicy({ client, ...seat() });
  assert.equal(result.basis, SELF_HOSTED_BASIS);
  const audit = client.calls.find((call) => /insert into audit_events/.test(call.sql));
  assert.equal(audit.params[4], MODEL_LANE_POLICY_SET_ACTION);
  const metadata = JSON.parse(audit.params[7]);
  assert.equal(metadata.globally_qualified, false);
  assert.equal(metadata.qualified, false);
  assert.equal(metadata.eligibility, 'self_hosted_operator_choice');
  assert.ok(client.calls.some((call) => /from firm_members m/.test(call.sql)), 'the member authority is checked inside the transaction');
});

test('writer: every refusal of a self-hosted seat', async () => {
  const refuse = (overrides, code) => assert.rejects(setLaneDecidingPolicy({ client: mockClient(), ...seat(overrides) }), (error) => error.code === code, code);
  await refuse({ laneId: 'louis_qa' }, 'LANE_NOT_SELF_HOSTABLE');
  await refuse({ laneId: 'unified_extraction' }, 'LANE_NOT_SELF_HOSTABLE');
  await refuse({ decidingModel: 'qwen/qwen3.8-27b' }, 'SELF_HOSTED_MODEL_IS_QUALIFIED');
  await refuse({ decidingModel: 'claude-opus-4-8', laneId: 'ask_drafting' }, 'SELF_HOSTED_MODEL_IS_QUALIFIED');
  await refuse({ decidingModel: 'claude-local-finetune' }, 'SELF_HOSTED_MODEL_NAMES_CLOUD');
  await refuse({ decidingModel: 'gpt-oss-20b' }, 'SELF_HOSTED_MODEL_NAMES_CLOUD');
  await refuse({ decidingModel: '' }, 'MODEL_REQUIRED');
  await refuse({ clientId: null }, 'SELF_HOSTED_AUTHORITY_REQUIRED');
  await refuse({ actorType: 'system' }, 'SELF_HOSTED_AUTHORITY_REQUIRED');
  await refuse({ reason: '  ' }, 'SELF_HOSTED_AUTHORITY_REQUIRED');
  await assert.rejects(setLaneDecidingPolicy({ client: mockClient({ authority: false }), ...seat() }), (error) => error.code === 'SELF_HOSTED_AUTHORITY_REQUIRED');
});

test('the seated model is never read as qualified: not by the writer, the gate, or the graduation policy', async () => {
  const before = JSON.stringify(MODEL_LANES.map((lane) => lane.qualified));
  await setLaneDecidingPolicy({ client: mockClient(), ...seat() });
  assert.equal(JSON.stringify(MODEL_LANES.map((lane) => lane.qualified)), before, 'a seat never touches a qualified set');
  assert.equal(isQualifiedAnywhere(MODEL), false);
  // Promotion basis is the qualified set or nothing.
  await assert.rejects(setLaneDecidingPolicy({ client: mockClient(), ...seat({ basis: 'promotion' }) }), (error) => error.code === 'MODEL_NOT_QUALIFIED');
  // The gate reads a receipt naming it as drift, never as a qualified decider.
  const gate = evaluateLaneGate({
    gapTable: { lane: 'bank_line_disposition', table_present: true, runs: 0, deciding_models: [MODEL], challenger_models: [], rates: {} },
    qualified: getLane('bank_line_disposition').qualified
  });
  assert.equal(gate.verdict, 'red');
  assert.ok(gate.reasons.some((reason) => reason.code === 'deciding_model_outside_qualified_set'));
  // Graduation: the local slot is experimental on every capability, never qualified or lit.
  const env = { ANTHROPIC_API_KEY: 'present', OPENAI_API_KEY: 'present', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1/v1' };
  for (const capability of GRADUATION_CAPABILITIES) {
    assert.ok(!resolveQualifiedBackends(CURRENT_MODEL_POLICY, capability).some((b) => b.provider === 'local_openai_compatible'));
    assert.ok(!resolveLitBackends(CURRENT_MODEL_POLICY, capability, env).some((b) => b.provider === 'local_openai_compatible'));
  }
});

test('the endpoint variables alone change no deciding model', () => {
  const env = { OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:8080/v1', OPENAI_COMPATIBLE_API_KEY: 'x', OPENAI_COMPATIBLE_MODEL: MODEL };
  assert.equal(resolveSeatTransport({ policy: null, env }), null);
  assert.equal(resolveSeatTransport({ policy: { deciding_model: 'claude-opus-4-8', basis: 'experiment' }, env }), null);
  // A lane that read no policy before honours only the self-hosted basis.
  assert.equal(resolveSeatTransport({ policy: { deciding_model: 'qwen/qwen3.8-27b', basis: 'experiment' }, onlyBasis: SELF_HOSTED_BASIS, env }), null);
  assert.equal(resolveSeatTransport({ policy: SEAT, onlyBasis: SELF_HOSTED_BASIS, env }).model, MODEL);
  // An active seat with no endpoint fails loud — never quietly another model.
  assert.throws(() => resolveSeatTransport({ policy: SEAT, env: {} }), (error) => error.code === 'OPENAI_COMPATIBLE_NOT_CONFIGURED');
});

test('the key: a loopback server needs none; any other host still does', () => {
  assert.equal(isLoopbackBaseUrl('http://localhost:11434/v1'), true);
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:8080/v1'), true);
  assert.equal(isLoopbackBaseUrl('http://[::1]:8000/v1'), true);
  assert.equal(isLoopbackBaseUrl('http://localhost.example.test/v1'), false);
  assert.equal(isLoopbackBaseUrl('http://192.168.1.20:8080/v1'), false);
  const local = resolveOpenAiCompatibleEndpoint({ env: { OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1' } });
  assert.equal(local.headers.authorization, undefined);
  assert.throws(() => resolveOpenAiCompatibleEndpoint({ env: { OPENAI_COMPATIBLE_BASE_URL: 'http://192.168.1.20:8080/v1' } }),
    (error) => error.code === 'OPENAI_COMPATIBLE_NOT_CONFIGURED');
  const keyed = resolveOpenAiCompatibleEndpoint({ env: { OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1', OPENAI_COMPATIBLE_API_KEY: 'k' } });
  assert.equal(keyed.headers.authorization, 'Bearer k');
});

test('no reverse shadow and no challenger about a self-hosted seat, even with every key and cap present', () => {
  const env = { ANTHROPIC_API_KEY: 'present', MODEL_CHALLENGER_CAP_TOKENS: '100000', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1/v1', OPENAI_COMPATIBLE_API_KEY: 'k', OPENAI_COMPATIBLE_MODEL: 'x' };
  const common = { firmId: 'f1', clientId: 'c1', withClient: async () => null, env, anthropicApiKey: 'present' };
  assert.equal(makeBankLineDispositionChallengerHook({ ...common, decidingPolicy: SEAT }), null);
  assert.equal(makeReconciliationReasoningChallengerHook({ ...common, family: 'supplier_bill', decidingPolicy: SEAT }), null);
  // Unchanged for a lab experiment seat: the reverse shadow is still built.
  assert.equal(typeof makeBankLineDispositionChallengerHook({ ...common, decidingPolicy: { deciding_model: 'qwen/qwen3.8-27b', basis: 'experiment' } }), 'function');
  assert.equal(typeof makeReconciliationReasoningChallengerHook({ ...common, family: 'supplier_bill', decidingPolicy: { deciding_model: 'qwen/qwen3.8-27b', basis: 'experiment' } }), 'function');
  assert.equal(isUnqualifiedSeat(SEAT), true);
  assert.equal(isUnqualifiedSeat('experiment'), false);
});

test('the plan and the banner name every lane that stays on a cloud provider or dark', () => {
  const env = { ANTHROPIC_API_KEY: 'present', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:8080/v1' };
  const plan = buildSelfHostedLanePlan({ seatedLanes: ['transaction_coding', 'ask_drafting'], env });
  assert.deepEqual(plan.self_hosted.sort(), ['ask_drafting', 'transaction_coding']);
  const named = new Set([...plan.self_hosted, ...plan.cloud.map((c) => c.lane), ...plan.dark.map((d) => d.lane), 'host_provider_probe']);
  for (const lane of MODEL_LANES) assert.ok(named.has(lane.id), `${lane.id} is named`);
  assert.ok(plan.cloud.some((c) => c.lane === 'chat_engine' && c.provider === 'anthropic'), 'owner-reply interpretation stays on Anthropic');
  assert.ok(plan.cloud.some((c) => c.lane === 'reconciliation_reasoning'), 'a self-hostable lane not seated is named too');
  const line = selfHostedSeatLine([{ firm_id: 'f1', client_id: 'c1', lane: 'transaction_coding', deciding_model: MODEL }], env);
  assert.match(line, /UNQUALIFIED self-hosted model "local-test-model-q4" decides transaction_coding for 1 company/);
  assert.match(line, /stays on anthropic: .*unified_extraction/);
  assert.match(selfHostedSeatLine([], env), /decides NOTHING/);
  assert.equal(buildModelLaneReceipt(env).line.includes('DECIDING'), false, 'no seats read ⇒ the boot line is unchanged');
  const jevPlan = buildSelfHostedLanePlan({ seatedLanes: ['bank_line_disposition', 'transaction_coding'], env, jevOn: true });
  assert.match(jevPlan.rows.find((row) => row.lane === 'bank_line_disposition').warning, /JEV_RECONCILIATION/);
  assert.equal(jevPlan.rows.find((row) => row.lane === 'transaction_coding').warning, null);
});

test('the seat command refuses before writing: bad requests, an endpoint that does not serve the id', async () => {
  const bad = buildLocalSeatRequest({ opts: { firmId: 'f1', clientId: null, memberId: null, model: 'gpt-5.4', lanes: ['louis_qa'], reason: '' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /--client/.test(e)));
  assert.ok(bad.errors.some((e) => /louis_qa/.test(e)));
  assert.ok(bad.errors.some((e) => /qualified/.test(e)));
  let wrote = false;
  // The command reads the company's Typesafe flag (read-only) before it plans;
  // only a policy INSERT counts as a write.
  const readOnlyClient = { query: async (sql) => { if (/insert into model_lane_policy/i.test(String(sql))) wrote = true; return { rows: [] }; } };
  const withClient = async (fn) => fn(readOnlyClient);
  const opts = { firmId: 'f1', clientId: 'c1', memberId: 'm1', model: MODEL, all: true, lanes: [], reason: 'own server', apply: true, clear: false };
  const env = { OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:9/v1' };
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ id: 'another-model' }] }), { status: 200 });
  const result = await runSeatCommand(opts, { env, fetchImpl, withClient });
  assert.deepEqual(result.refused, ['model_not_served']);
  assert.equal(wrote, false);
  const down = await runSeatCommand(opts, { env, fetchImpl: async () => { throw new Error('connection refused'); }, withClient });
  assert.deepEqual(down.refused, ['endpoint_unreachable']);
  assert.equal(wrote, false);
});
