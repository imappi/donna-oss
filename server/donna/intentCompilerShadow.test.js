// Tests for the intent-compiler shadow sidecar (BizOS Slice 1c) — mock connection, mock
// compile, no live API. Pins the safety contract: fully dormant without a config-plane
// stage row (env can never enable it), idempotent by compile_id, stamps the OWNER message,
// and NO-THROW when anything inside fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onOwnerMessagePersisted, intentCompilerShadowObserves } from './intentCompilerShadow.js';
import { INTENT_COMPILER_PROMPT_VERSION, intentCompilerModelId } from './intentCompiler.js';
import { intentCompileId } from './intentObjects.js';
import { capabilityRegistryFingerprint } from './capabilityRegistry.js';

const ENV = {}; // deliberately empty: the env fallback must never enable the sidecar

// A routing mock pg client: config-snapshot reads, the stamp lookup, and the payload update.
const mockClient = ({ stage = null, existingCompileId = null, ownerRowExists = true } = {}) => {
  const updates = [];
  const query = async (sql, params) => {
    if (/from client_capability_config/.test(sql)) {
      return {
        rows: stage
          ? [{ flag_key: 'INTENT_COMPILER_SHADOW', stage, source: 'manual', client_id: params[1] }]
          : []
      };
    }
    if (/from cohort_capability_config/.test(sql)) return { rows: [] };
    if (/insert into config_snapshots/.test(sql)) return { rows: [] };
    if (/select payload->'intent_compile'/.test(sql)) {
      return { rows: ownerRowExists ? [{ compile_id: existingCompileId, created_at: '2026-07-14T12:00:00.000Z' }] : [] };
    }
    if (/update client_chat_messages/.test(sql)) {
      updates.push({ sql, params });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL in mock: ${sql.slice(0, 60)}`);
  };
  return { query, updates };
};

const deps = (client, compileResult) => ({
  withFirmDbClient: async (fn) => fn(client),
  compile: async () => compileResult ?? ({
    kind: 'ok',
    raw: {
      objects: [{
        local_id: 'o1', kind: 'preference', summary: 'Call the owner Alex',
        payload: { statement: 'Address the owner as Alex' }, links: [],
        source_refs: [{ message_id: 'm1', verbatim_span: 'Call me Alex' }],
        parse_confidence: 'high'
      }],
      clarification_requests: [],
      unsupported_spans: []
    },
    model: 'claude-test-model',
    tokenUsage: { input: 10, output: 5 },
    latencyMs: 42
  })
});

const call = (client, overrides = {}) => onOwnerMessagePersisted({
  firmId: 'f1', clientId: 'c1', channel: 'client_chat',
  sourceMessageId: 'm1', ownerText: 'Call me Alex',
  env: ENV, deps: deps(client), warn: () => {},
  ...overrides
});

test('fully dormant: no config row + empty env ⇒ skipped, no model call, no write', async () => {
  const client = mockClient({ stage: null });
  const result = await call(client, {
    deps: { withFirmDbClient: async (fn) => fn(client), compile: async () => { throw new Error('must not be called'); } }
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'flag_off' });
  assert.equal(client.updates.length, 0);
  // The observe dual gates exactly like the config plane says.
  assert.equal(intentCompilerShadowObserves({ snapshot: null, env: ENV }), false);
  assert.equal(intentCompilerShadowObserves({ snapshot: { INTENT_COMPILER_SHADOW: { stage: 'dry_run' } }, env: ENV }), false);
  assert.equal(intentCompilerShadowObserves({ snapshot: { INTENT_COMPILER_SHADOW: { stage: 'shadow' } }, env: ENV }), true);
});

test('CLIENT_CONFIG_FORCE_DISABLE kills the sidecar even with a shadow stage row', async () => {
  const client = mockClient({ stage: 'shadow' });
  const result = await call(client, { env: { CLIENT_CONFIG_FORCE_DISABLE: 'INTENT_COMPILER_SHADOW' } });
  assert.deepEqual(result, { status: 'skipped', reason: 'flag_off' });
});

test('shadow stage: compiles and stamps intent_compile onto the OWNER message payload', async () => {
  const client = mockClient({ stage: 'shadow' });
  const result = await call(client);
  assert.equal(result.status, 'compiled');
  assert.equal(result.objectCount, 1);
  assert.equal(client.updates.length, 1);
  const [update] = client.updates;
  assert.deepEqual(update.params.slice(0, 3), ['f1', 'c1', 'm1']);
  const stamped = JSON.parse(update.params[3]);
  assert.equal(stamped.contract_version, 'intent_compile.v1');
  assert.equal(stamped.source_message_id, 'm1');
  assert.equal(stamped.channel, 'client_chat');
  assert.equal(stamped.model_id, 'claude-test-model');
  assert.equal(stamped.objects[0].kind, 'preference');
  assert.ok(stamped.config_snapshot_id.startsWith('cfg-'));
});

test('idempotent: an existing stamp with the SAME deterministic compile_id dedupes before the model call', async () => {
  const compileId = intentCompileId({
    sourceMessageId: 'm1',
    promptVersion: INTENT_COMPILER_PROMPT_VERSION,
    modelId: intentCompilerModelId(ENV),
    registryFingerprint: capabilityRegistryFingerprint()
  });
  const client = mockClient({ stage: 'shadow', existingCompileId: compileId });
  const result = await call(client, {
    deps: { withFirmDbClient: async (fn) => fn(client), compile: async () => { throw new Error('must not be called'); } }
  });
  assert.deepEqual(result, { status: 'deduped', compileId });
  assert.equal(client.updates.length, 0);
});

test('a stale stamp (different compile_id: model/prompt/registry moved) re-compiles and re-stamps', async () => {
  const client = mockClient({ stage: 'shadow', existingCompileId: 'ic-' + 'a'.repeat(64) });
  const result = await call(client);
  assert.equal(result.status, 'compiled');
  assert.equal(client.updates.length, 1);
});

test('a failed compile stamps a well-formed empty result (compiled_failed, never silence)', async () => {
  const client = mockClient({ stage: 'shadow' });
  const result = await call(client, {
    deps: {
      withFirmDbClient: async (fn) => fn(client),
      compile: async () => ({ kind: 'failed', code: 'anthropic_529', reason: 'overloaded', model: 'claude-test-model' })
    }
  });
  assert.equal(result.status, 'compiled_failed');
  const stamped = JSON.parse(client.updates[0].params[3]);
  assert.equal(stamped.failure_category, 'model_error');
  assert.deepEqual(stamped.objects, []);
});

test('no-throw contract: missing inputs, missing owner row, and a thrown error all return statuses', async () => {
  assert.deepEqual(
    await onOwnerMessagePersisted({ firmId: 'f1', clientId: 'c1', ownerText: '', sourceMessageId: 'm1', deps: {} }),
    { status: 'skipped', reason: 'missing_inputs' }
  );
  const noRow = mockClient({ stage: 'shadow', ownerRowExists: false });
  assert.deepEqual(await call(noRow), { status: 'skipped', reason: 'owner_message_not_found' });
  // A DB that is down at the config read degrades to flag-off (the snapshot reader
  // soft-fails to {} by design — fail-closed, never fail-open).
  const exploding = { query: async () => { throw new Error('db down'); } };
  const skipped = await call(exploding, { deps: { withFirmDbClient: async (fn) => fn(exploding) } });
  assert.deepEqual(skipped, { status: 'skipped', reason: 'flag_off' });
  // An error PAST the gate (the compile itself throwing) hits the no-throw catch.
  const gated = mockClient({ stage: 'shadow' });
  const failed = await call(gated, {
    deps: { withFirmDbClient: async (fn) => fn(gated), compile: async () => { throw new Error('compiler exploded'); } }
  });
  assert.equal(failed.status, 'failed');
  assert.equal(gated.updates.length, 0);
});


test('runtime staging receives owner actor and message timestamp from the shadow seam', async () => {
  const client = mockClient({ stage: 'canary' });
  let seen = null;
  const result = await call(client, {
    ownerActorId: 'owner@example.com',
    deps: {
      withFirmDbClient: async (fn) => fn(client),
      compile: deps(client).compile,
      stageIntentCompileResult: async (args) => { seen = args; return { status: 'skipped', reason: 'test' }; }
    }
  });
  assert.equal(result.status, 'compiled');
  assert.equal(seen.actorId, 'owner@example.com');
  assert.ok(seen.observedAt, 'message created_at is forwarded as the observed time');
});

// ── M3: the compile's telemetry reaches the PERSISTED stamp ──────────────────
//
// `compile` built a correct envelope-shaped telemetry object and returned it;
// `assembleIntentCompileResult` did not carry it, so it evaporated one frame
// later. Same failure as the owner-command lane's, and the same lesson: assert
// on what is WRITTEN, not on what a function returns.

test('M3: the envelope telemetry is carried onto the stamp, not dropped at assembly', async () => {
  const client = mockClient({ stage: 'shadow' });
  const telemetry = {
    provider: 'anthropic',
    model: 'claude-served-model',
    model_source: 'response',
    root_execution: { type: 'owner_message', id: 'm1' },
    parent_execution: null,
    usage: { input_tokens: 900, output_tokens: 300, total_tokens: 1200, provider: 'anthropic' },
    latency_ms: 412,
    attempt_count: 1,
    provider_attempt_id: 'msg_abc',
    prompt_sections: { system: { bytes: 5000, chars: 4990 } },
    ok: true,
    status: 200
  };
  const result = await call(client, {
    deps: {
      withFirmDbClient: async (fn) => fn(client),
      compile: async () => ({
        kind: 'ok',
        raw: { objects: [], clarification_requests: [], unsupported_spans: [] },
        model: 'claude-test-model',
        tokenUsage: { input: 900, output: 300 },
        latencyMs: 412,
        telemetry
      })
    }
  });
  assert.equal(result.status, 'compiled');

  const stamped = JSON.parse(client.updates[0].params[3]);
  assert.deepEqual(stamped.telemetry, telemetry, 'the telemetry is PERSISTED on the stamp');
  // The pre-existing capture is untouched — this slice is additive, and a
  // regression there would silently un-answer the one lane that already
  // reported tokens.
  assert.deepEqual(stamped.token_usage, { input: 900, output: 300 });
  assert.equal(stamped.latency_ms, 412);
  // `model_id` is the REQUESTED model; the telemetry carries the SERVED one.
  // A silent env downgrade is visible in the gap between them.
  assert.equal(stamped.model_id, 'claude-test-model');
  assert.equal(stamped.telemetry.model, 'claude-served-model');
  assert.equal(stamped.telemetry.model_source, 'response');
});

test('M3: RAIL 1 holds at the NEW persistence surface — sizes reach the stamp, never text', async () => {
  // The stamp lands in `client_chat_messages.payload`. That is a new home for
  // telemetry, so the sizes-not-contents rail is re-pinned HERE rather than
  // assumed from llmCall's own suite: the mitigation is only worth what it is
  // worth at the place the bytes actually come to rest. Structural on purpose —
  // the failure mode is a field nobody thought to look at.
  const secret = 'Remember Alex birthday is 14 July and remind me 18 hours before';
  const client = mockClient({ stage: 'shadow' });
  await call(client, {
    deps: {
      withFirmDbClient: async (fn) => fn(client),
      compile: async () => ({
        kind: 'ok',
        raw: { objects: [], clarification_requests: [], unsupported_spans: [] },
        model: 'claude-test-model',
        telemetry: {
          provider: 'anthropic',
          model: 'claude-test-model',
          root_execution: { type: 'owner_message', id: 'm1' },
          prompt_sections: { system: { bytes: secret.length, chars: secret.length } },
          ok: true
        }
      })
    }
  });
  const written = client.updates[0].params[3];
  assert.ok(!written.includes(secret), 'no section contents reach the persisted stamp');
  const stamped = JSON.parse(written);
  assert.equal(stamped.telemetry.prompt_sections.system.bytes, secret.length, 'the SIZE does');
});

test('M3: a failed compile stamps null telemetry — never a missing key, never a guess', async () => {
  const client = mockClient({ stage: 'shadow' });
  await call(client, {
    deps: {
      withFirmDbClient: async (fn) => fn(client),
      compile: async () => ({ kind: 'failed', code: 'anthropic_529', reason: 'overloaded', model: 'claude-test-model' })
    }
  });
  const stamped = JSON.parse(client.updates[0].params[3]);
  assert.equal(stamped.telemetry, null);
  assert.ok('telemetry' in stamped, 'the key is present and explicitly null');
});
