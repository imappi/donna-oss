import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_CHALLENGER_FLAG_KEY,
  modelChallengerObserves,
  CHALLENGER_OUTCOMES,
  CHALLENGER_FAILURE_CLASSES,
  challengerTablePresent,
  spendMonthKey,
  spendMonthRange,
  monthTokenSpend,
  buildChallengerModelArtifact,
  defaultComparator,
  dispatchChallengerRun
} from './modelChallenger.js';
// The artifact field vocabulary must stay in sync with the EAW receipt
// shape — but MODEL_ARTIFACT_FIELDS is module-private in traceReceipts.js
// and editing EAW-owned files is off-limits (lane discipline), so the sync
// is pinned at SOURCE level: parse the frozen list out of the world
// module's text.
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const worldSource = readFileSync(
  resolvePath(dirname(fileURLToPath(import.meta.url)), 'world', 'traceReceipts.js'),
  'utf8'
);
const artifactFieldsMatch = worldSource.match(/MODEL_ARTIFACT_FIELDS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
const WORLD_ARTIFACT_PROBE = [...(artifactFieldsMatch?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

// ── harness fixtures ────────────────────────────────────────────────────
// A mock pg client that answers to_regclass, the spend sum, and captures
// inserts.
const makeMockClient = ({ tablePresent = true, spent = 0 } = {}) => {
  const inserts = [];
  const queries = [];
  return {
    inserts,
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('to_regclass')) {
        return { rows: [{ present: tablePresent ? 'model_challenger_runs' : null }] };
      }
      if (sql.includes('coalesce(sum')) {
        return { rows: [{ spent }] };
      }
      if (sql.startsWith('insert into model_challenger_runs')) {
        inserts.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
};

const withMock = (client) => async (work) => work(client);

// A snapshot that stages the flag `shadow` (observes) for the client.
const observingSnapshot = { [MODEL_CHALLENGER_FLAG_KEY]: { stage: 'shadow', source: 'client' } };

// An eligible lane does not exist at Q2 (the registry pins every lane
// ineligible), so the dispatcher is exercised through a REAL lane id and
// expected to no-op — plus through a monkeypatched eligibility to reach the
// deep path. The lane registry itself must stay untouched: this test
// derives the deep path by injecting everything else and using the one Q2
// dispatch precondition that is data, not code — so the deep-path test
// stubs getLane indirectly via a laneId that exists but is ineligible, and
// asserts the no-op; the write path is covered through the exported pieces
// (comparator, artifact, cap, insert) plus an integration-shaped call once
// a lane flips in Q4. To still pin the WRITE path now, the test reaches it
// by staging the real lane id 'document_routing' and asserting the no-op is
// caused by eligibility alone (every other gate open).

const baseDispatchArgs = (client, overrides = {}) => ({
  firmId: 'firm-1',
  clientId: 'client-1',
  laneId: 'document_routing',
  snapshot: observingSnapshot,
  decidingResult: { verdict: 'receipt' },
  decidingModel: { model: 'gpt-5.4', model_source: 'response_proven' },
  execution: { root: { type: 'document_parse', id: 'doc-1' } },
  callChallenger: async () => ({
    result: { verdict: 'receipt' },
    telemetry: { model: 'qwen-3.8', model_source: 'response', provider: 'openai_compatible', usage: { total_tokens: 100 } }
  }),
  capTokensPerClientMonth: 100000,
  withClient: withMock(client),
  env: {},
  ...overrides
});

// ── vocabulary + artifact shape ─────────────────────────────────────────
await test('outcome and failure-class vocabularies are frozen and spec-shaped', () => {
  assert.deepEqual([...CHALLENGER_OUTCOMES], ['match', 'divergence', 'challenger_error', 'parse_failure']);
  assert.ok(CHALLENGER_FAILURE_CLASSES.includes('policy_mismatch'), 'the env-override tripwire is a first-class failure class');
  assert.ok(Object.isFrozen(CHALLENGER_OUTCOMES) && Object.isFrozen(CHALLENGER_FAILURE_CLASSES));
});

await test('challenger model_artifact carries exactly the world receipt field vocabulary — nulls, never fabrication', () => {
  const artifact = buildChallengerModelArtifact({
    provider: 'openai_compatible', model: 'qwen-3.8', modelSource: 'response_proven'
  });
  assert.deepEqual(Object.keys(artifact).sort(), [...WORLD_ARTIFACT_PROBE].sort(),
    'artifact fields must stay in sync with world/traceReceipts.js MODEL_ARTIFACT_FIELDS');
  assert.equal(artifact.base_model_id, 'qwen-3.8');
  assert.equal(artifact.base_model_digest, null, 'a hosted provider cannot attest a digest — explicitly null');
  assert.equal(artifact.model_id_source, 'response_proven');
  assert.equal(artifact.network_egress, 'external_api');
  assert.equal(artifact.fallback_occurred, false);
  assert.equal(buildChallengerModelArtifact({ modelSource: 'configured_fallback' }).fallback_occurred, true);
});

// ── flag gate ───────────────────────────────────────────────────────────
await test('flag: dark by default (env fallback false), observes on shadow/canary/auto stages', () => {
  assert.equal(modelChallengerObserves({ snapshot: null, env: {} }), false, 'no row + no env ⇒ dark');
  assert.equal(modelChallengerObserves({ snapshot: observingSnapshot, env: {} }), true, 'shadow stage observes');
  assert.equal(
    modelChallengerObserves({ snapshot: { [MODEL_CHALLENGER_FLAG_KEY]: { stage: 'off', source: 'client' } }, env: {} }),
    false,
    'off stage does not observe'
  );
});

// ── default comparator ──────────────────────────────────────────────────
await test('defaultComparator: match ignores provenance keys; divergence lists differing key NAMES only', () => {
  assert.deepEqual(
    defaultComparator({
      decidingResult: { verdict: 'a', model: 'x', model_source: 'response_proven' },
      challengerResult: { verdict: 'a', model: 'y', model_source: 'configured_fallback' }
    }),
    { outcome: 'match', failure_class: null, summary: null }
  );
  const divergent = defaultComparator({
    decidingResult: { verdict: 'a', amount: 10 },
    challengerResult: { verdict: 'b', amount: 10 }
  });
  assert.equal(divergent.outcome, 'divergence');
  assert.equal(divergent.failure_class, null, 'the default comparator never guesses a failure class');
  assert.deepEqual(divergent.summary, { differing_keys: ['verdict'] });
  assert.ok(!JSON.stringify(divergent.summary).includes('"a"'), 'summary carries key names, never values');
});

// ── dispatcher gates ────────────────────────────────────────────────────
await test('dispatch: no lane is challenger-eligible at Q2 — a fully-staged dispatch still no-ops on eligibility', async () => {
  const client = makeMockClient();
  const out = await dispatchChallengerRun(baseDispatchArgs(client));
  assert.equal(out, null);
  assert.equal(client.queries.length, 0, 'the connection is never touched — the eligibility gate is first');
});

await test('dispatch: unknown lane, missing execution ref, missing transport, missing cap — all no-op without touching the connection', async () => {
  const client = makeMockClient();
  for (const overrides of [
    { laneId: 'nope' },
    { execution: null },
    { execution: { root: { type: 'x' } } },
    { callChallenger: undefined },
    { capTokensPerClientMonth: null },
    { capTokensPerClientMonth: 0 },
    { capTokensPerClientMonth: -5 }
  ]) {
    assert.equal(await dispatchChallengerRun(baseDispatchArgs(client, overrides)), null, JSON.stringify(overrides));
  }
  assert.equal(client.inserts.length, 0);
});

await test('dispatch: never throws — a throwing withClient is swallowed to null', async () => {
  const out = await dispatchChallengerRun(baseDispatchArgs(null, {
    withClient: async () => { throw new Error('connection pool exploded'); }
  }));
  assert.equal(out, null);
});

// ── spend ledger ────────────────────────────────────────────────────────
await test('spendMonthKey is UTC YYYY-MM; monthTokenSpend sums over the half-open UTC month range', async () => {
  assert.equal(spendMonthKey(new Date('2026-08-11T23:59:00Z')), '2026-08');
  assert.deepEqual(spendMonthRange('2026-08'), {
    start: '2026-08-01T00:00:00.000Z',
    end: '2026-09-01T00:00:00.000Z'
  });
  assert.deepEqual(spendMonthRange('2026-12'), {
    start: '2026-12-01T00:00:00.000Z',
    end: '2027-01-01T00:00:00.000Z'
  }, 'year rollover');
  const client = makeMockClient({ spent: 4321 });
  assert.equal(await monthTokenSpend(client, { firmId: 'f', clientId: 'c', month: '2026-08' }), 4321);
  const spendQuery = client.queries.find((q) => q.sql.includes('coalesce(sum'));
  assert.deepEqual(spendQuery.params, ['f', 'c', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
});

await test('challengerTablePresent guards on to_regclass', async () => {
  assert.equal(await challengerTablePresent(makeMockClient({ tablePresent: true })), true);
  assert.equal(await challengerTablePresent(makeMockClient({ tablePresent: false })), false);
  assert.equal(await challengerTablePresent(null), false);
});

// ── the write path (deep path via injected lane resolver — production
// callers always take the registry default, so Q2's registry keeps every
// lane dark; these pin what happens WHEN a lane flips in Q4) ─────────────
const eligibleLane = { id: 'document_routing', challenger: { eligible: true } };
const deepArgs = (client, overrides = {}) =>
  baseDispatchArgs(client, { laneResolver: () => eligibleLane, ...overrides });

await test('write path: a matching challenger run persists one receipt row with provenance, artifact, and usage', async () => {
  const client = makeMockClient();
  const out = await dispatchChallengerRun(deepArgs(client));
  assert.ok(out?.run_id?.startsWith('mcr-'));
  assert.equal(client.inserts.length, 1);
  const [id, firmId, clientId, lane, rootType, rootId, deciding, challenger, outcome, failureClass, summary, usage] = client.inserts[0];
  assert.equal(id, out.run_id);
  assert.deepEqual([firmId, clientId, lane, rootType, rootId], ['firm-1', 'client-1', 'document_routing', 'document_parse', 'doc-1']);
  assert.deepEqual(JSON.parse(deciding), { model: 'gpt-5.4', model_source: 'response_proven' });
  const challengerRow = JSON.parse(challenger);
  assert.equal(challengerRow.model, 'qwen-3.8');
  assert.equal(challengerRow.model_source, 'response_proven', "llmCall telemetry 'response' normalizes to the receipt vocabulary");
  assert.equal(challengerRow.model_artifact.network_egress, 'external_api');
  assert.equal(outcome, 'match');
  assert.equal(failureClass, null);
  assert.equal(summary, null);
  assert.deepEqual(JSON.parse(usage), { total_tokens: 100 });
});

await test('write path: divergence persists the comparator verdict', async () => {
  const client = makeMockClient();
  const out = await dispatchChallengerRun(deepArgs(client, {
    callChallenger: async () => ({
      result: { verdict: 'invoice' },
      telemetry: { model: 'qwen-3.8', model_source: 'response', usage: { total_tokens: 60 } }
    })
  }));
  assert.ok(out?.run_id);
  const [, , , , , , , , outcome, , summary] = client.inserts[0];
  assert.equal(outcome, 'divergence');
  assert.deepEqual(JSON.parse(summary), { differing_keys: ['verdict'] });
});

await test('write path: a throwing challenger call is receipted as challenger_error — the failure is evidence', async () => {
  const client = makeMockClient();
  const out = await dispatchChallengerRun(deepArgs(client, {
    callChallenger: async () => { throw new Error('candidate timed out'); }
  }));
  assert.ok(out?.run_id, 'a challenger failure still writes a receipt');
  const [, , , , , , , challenger, outcome, , summary] = client.inserts[0];
  assert.equal(outcome, 'challenger_error');
  assert.match(JSON.parse(summary).error, /candidate timed out/);
  assert.equal(JSON.parse(challenger).model_source, 'configured_fallback', 'no telemetry ⇒ nothing response-proven');
});

await test('write path: cap already spent ⇒ no challenger call, no insert', async () => {
  const client = makeMockClient({ spent: 100000 });
  let called = false;
  const out = await dispatchChallengerRun(deepArgs(client, {
    callChallenger: async () => { called = true; return { result: {} }; }
  }));
  assert.equal(out, null);
  assert.equal(called, false, 'the cap gates the CALL, not just the write — capped tokens are never spent');
  assert.equal(client.inserts.length, 0);
});

await test('write path: missing migration table ⇒ silent no-op before any spend', async () => {
  const client = makeMockClient({ tablePresent: false });
  let called = false;
  const out = await dispatchChallengerRun(deepArgs(client, {
    callChallenger: async () => { called = true; return { result: {} }; }
  }));
  assert.equal(out, null);
  assert.equal(called, false);
  assert.equal(client.inserts.length, 0);
});

await test('write path: sampling skip ⇒ no-op', async () => {
  const client = makeMockClient();
  const out = await dispatchChallengerRun(deepArgs(client, { sample: () => false }));
  assert.equal(out, null);
  assert.equal(client.queries.length, 0);
});
