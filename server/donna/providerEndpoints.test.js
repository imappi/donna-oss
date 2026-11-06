import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENDPOINT_CLASSES,
  MODEL_PROVENANCE,
  KNOWN_PROVIDER_HOSTS,
  OPENAI_COMPATIBLE_ENV_KEYS,
  providerUrlLintPattern,
  classifyModelProvenance,
  resolveOpenAiCompatibleEndpoint,
  shapeOpenAiCompatibleRequest
} from './providerEndpoints.js';
import { llmCall } from './llmCall.js';
// Tests are exempt from the world boundary scan (worldBoundary.test.js only
// walks non-test files), which is exactly why the vocabulary sync can be
// pinned HERE while the production module restates the values (see the
// providerEndpoints.js header).
import { MODEL_PROVENANCE_CLASSIFICATIONS } from './world/traceReceipts.js';

// ── vocabulary sync with the EAW receipt shape ──────────────────────────
await test('MODEL_PROVENANCE values are identical to world/traceReceipts.js — one vocabulary, no fork', () => {
  assert.deepEqual(
    { ...MODEL_PROVENANCE },
    { ...MODEL_PROVENANCE_CLASSIFICATIONS },
    'providerEndpoints restates the world vocabulary (the boundary forbids importing it); a drift here is a fork'
  );
});

// ── endpoint classes ────────────────────────────────────────────────────
await test('the endpoint classes include the explicit typed preview, frozen', () => {
  assert.deepEqual(
    [...ENDPOINT_CLASSES],
    ['typesafe', 'anthropic', 'openai', 'openai_compatible', 'local']
  );
  assert.ok(Object.isFrozen(ENDPOINT_CLASSES));
});

// ── the lint-pattern mechanism ──────────────────────────────────────────
await test('providerUrlLintPattern matches the registered hosts and nothing else', () => {
  const pattern = providerUrlLintPattern();
  assert.ok(pattern.test('https://api.openai.com/v1/chat/completions'));
  assert.ok(pattern.test('https://api.anthropic.com/v1/messages'));
  // §9.5 (Kari, 2026-08-12): the Together AI challenger host is registered,
  // so the ratchet covers a bare Together URL from the day it exists.
  assert.ok(pattern.test('https://api.together.xyz/v1/chat/completions'));
  assert.ok(!pattern.test('https://api.example.com/v1/chat'));
  // A lookalike host must not slip past because of an unescaped dot.
  assert.ok(!pattern.test('https://apixopenai.com/v1'));
});

await test('adding a host to the registry extends the pattern — the ratchet mechanism', () => {
  const extended = providerUrlLintPattern([
    ...KNOWN_PROVIDER_HOSTS,
    { host: 'dashscope-intl.aliyuncs.com', endpointClass: 'openai_compatible' }
  ]);
  assert.ok(extended.test('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'));
  assert.ok(extended.test('https://api.openai.com/v1/chat/completions'), 'existing hosts still covered');
});

await test('every known host carries a registered endpoint class', () => {
  for (const entry of KNOWN_PROVIDER_HOSTS) {
    assert.ok(ENDPOINT_CLASSES.includes(entry.endpointClass), `${entry.host}: unknown class ${entry.endpointClass}`);
    assert.ok(Object.isFrozen(entry));
  }
  assert.ok(Object.isFrozen(KNOWN_PROVIDER_HOSTS));
});

// ── classifyModelProvenance ─────────────────────────────────────────────
await test('response model present → response_proven with the served id', () => {
  assert.deepEqual(
    classifyModelProvenance({ responseModel: 'claude-opus-4-8-served', requestedModel: 'claude-opus-4-8' }),
    { model: 'claude-opus-4-8-served', model_source: MODEL_PROVENANCE.RESPONSE_PROVEN }
  );
});

await test('response model absent/empty/non-string → configured_fallback with the requested id', () => {
  for (const responseModel of [undefined, null, '', 42, {}]) {
    assert.deepEqual(
      classifyModelProvenance({ responseModel, requestedModel: 'claude-opus-4-8' }),
      { model: 'claude-opus-4-8', model_source: MODEL_PROVENANCE.CONFIGURED_FALLBACK },
      `responseModel=${JSON.stringify(responseModel)}`
    );
  }
});

await test('both absent → configured_fallback with model null, never a fabricated id', () => {
  assert.deepEqual(
    classifyModelProvenance({}),
    { model: null, model_source: MODEL_PROVENANCE.CONFIGURED_FALLBACK }
  );
  assert.deepEqual(
    classifyModelProvenance(),
    { model: null, model_source: MODEL_PROVENANCE.CONFIGURED_FALLBACK }
  );
});

// ── the openai_compatible endpoint (Q3, host-agnostic half) ─────────────
await test('resolveOpenAiCompatibleEndpoint: configured pair → chat/completions URL + bearer auth', () => {
  const resolved = resolveOpenAiCompatibleEndpoint({
    env: {
      [OPENAI_COMPATIBLE_ENV_KEYS.baseUrl]: 'https://example-host.test/compatible-mode/v1/',
      [OPENAI_COMPATIBLE_ENV_KEYS.apiKey]: 'sk-compat'
    }
  });
  assert.equal(resolved.endpointClass, 'openai_compatible');
  assert.equal(resolved.url, 'https://example-host.test/compatible-mode/v1/chat/completions',
    'trailing slashes normalized, path appended once');
  assert.equal(resolved.headers.authorization, 'Bearer sk-compat');
});

await test('resolveOpenAiCompatibleEndpoint: unconfigured ⇒ typed refusal, never a default host', () => {
  for (const env of [
    {},
    { [OPENAI_COMPATIBLE_ENV_KEYS.baseUrl]: 'https://example-host.test' },
    { [OPENAI_COMPATIBLE_ENV_KEYS.apiKey]: 'sk-compat' },
    { [OPENAI_COMPATIBLE_ENV_KEYS.baseUrl]: '   ', [OPENAI_COMPATIBLE_ENV_KEYS.apiKey]: 'sk' }
  ]) {
    assert.throws(
      () => resolveOpenAiCompatibleEndpoint({ env }),
      (error) => error.code === 'OPENAI_COMPATIBLE_NOT_CONFIGURED',
      JSON.stringify(env)
    );
  }
});

await test('shapeOpenAiCompatibleRequest: system rides as the first message; knobs only when finite', () => {
  const body = shapeOpenAiCompatibleRequest({
    model: 'qwen-test',
    system: 'SYS',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 512
  });
  assert.deepEqual(body, {
    model: 'qwen-test',
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' }
    ],
    max_tokens: 512
  });
  const bare = shapeOpenAiCompatibleRequest({ model: 'qwen-test', messages: [{ role: 'user', content: 'x' }] });
  assert.ok(!('max_tokens' in bare) && !('temperature' in bare) && bare.messages.length === 1);
});

await test('round trip: a compatible endpoint call through llmCall carries response-sourced model telemetry', async () => {
  const resolved = resolveOpenAiCompatibleEndpoint({
    env: {
      [OPENAI_COMPATIBLE_ENV_KEYS.baseUrl]: 'https://example-host.test/v1',
      [OPENAI_COMPATIBLE_ENV_KEYS.apiKey]: 'sk-compat'
    }
  });
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        model: 'qwen-3.8-served',
        choices: [{ message: { role: 'assistant', content: '{"verdict":"receipt"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      })
    };
  };
  const { result, telemetry } = await llmCall({
    provider: 'openai_compatible',
    url: resolved.url,
    headers: resolved.headers,
    body: shapeOpenAiCompatibleRequest({
      model: 'qwen-3.8-requested',
      system: 's',
      messages: [{ role: 'user', content: 'u' }]
    }),
    execution: { root: { type: 'test', id: 't-1' } },
    parseResponse: (payload) => JSON.parse(payload.choices[0].message.content),
    fetchImpl
  });
  assert.equal(captured.url, 'https://example-host.test/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer sk-compat');
  assert.equal(captured.body.model, 'qwen-3.8-requested');
  assert.deepEqual(result, { verdict: 'receipt' });
  assert.equal(telemetry.model, 'qwen-3.8-served', 'the RESPONSE model is the receipt');
  assert.equal(telemetry.model_source, 'response');
  assert.equal(telemetry.usage.total_tokens, 15, 'usage normalizes from the completion-token shape');
});

await test('legacy_unproven is never returned by the classifier — it marks pre-classification receipts only', () => {
  for (const args of [
    { responseModel: 'm', requestedModel: 'r' },
    { responseModel: null, requestedModel: 'r' },
    {}
  ]) {
    assert.notEqual(
      classifyModelProvenance(args).model_source,
      MODEL_PROVENANCE.LEGACY_UNPROVEN
    );
  }
});
