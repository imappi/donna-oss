import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGate2bLiveBudget } from '../server/donna/world/gate2bConvergenceProof.js';
import { createGate2bProviderCapture } from './eval_world_gate2b_provider_capture.js';

const DIGEST = 'a'.repeat(64);

const approvedBudget = () => buildGate2bLiveBudget({
  worldId: 'gate2b/world',
  lanes: [{
    lane: 'coding', provider: 'openai', model_id: 'gpt-gate2b',
    max_calls_per_run: 1, max_input_tokens_per_call: 2_000, max_output_tokens_per_call: 200,
    price_source: {
      id: 'official-pricing-2026-08-30', observed_at: '2026-08-30T08:00:00.000Z',
      input_usd_per_million: 2, output_usd_per_million: 8,
    },
  }],
  approved: {
    authority_id: 'kari', basis: 'approved measured Gate 2B hard cap',
    approved_at: '2026-08-30T09:00:00.000Z', world_id: 'gate2b/world',
    k: 3, max_cash_usd: 1, max_calls: 3,
  },
});

const response = ({ status = 200, payload } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  clone: () => ({ json: async () => structuredClone(payload) }),
  json: async () => structuredClone(payload),
});
const counted = (inputTokens = 100) => async () => ({
  input_tokens: inputTokens,
  http_status: 200,
  request_digest: DIGEST,
  endpoint_path: '/v1/test/input_tokens',
  cost: 'free_provider_token_count',
});

test('provider capture refuses unapproved spend and unknown egress before fetch', async () => {
  assert.throws(() => createGate2bProviderCapture({ budget: { status: 'AWAITING_APPROVAL' } }), /approved measured hard cap/);
  const forged = structuredClone(approvedBudget());
  forged.totals.calls += 1;
  assert.throws(
    () => createGate2bProviderCapture({ budget: forged }),
    (error) => error.code === 'EAW_GATE2B_BUDGET_INVALID',
  );
  let fetched = 0;
  const fakeFetch = async () => { fetched += 1; return response(); };
  const prior = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const capture = createGate2bProviderCapture({ budget: approvedBudget(), fetchImpl: fakeFetch, countTokensImpl: counted() });
    capture.install();
    capture.setRunToken('run-a');
    await assert.rejects(
      globalThis.fetch('https://example.com/model', { body: '{}' }),
      (error) => error.code === 'EAW_GATE2B_EGRESS_REFUSED',
    );
    assert.equal(fetched, 0);
    capture.restore();
  } finally {
    globalThis.fetch = prior;
  }
});

test('provider capture refuses over-cap usage and a served model outside the approved family', async () => {
  const run = async (payload, expectedCode) => {
    const fakeFetch = async () => response({ payload });
    const prior = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const capture = createGate2bProviderCapture({
        budget: approvedBudget(), fetchImpl: fakeFetch, countTokensImpl: counted(),
      });
      capture.install();
      capture.setRunToken('run-a');
      await assert.rejects(
        globalThis.fetch('https://api.openai.com/v1/responses', {
          body: JSON.stringify({ model: 'gpt-gate2b', input: 'bounded input' }),
        }),
        (error) => error.code === expectedCode,
      );
      capture.restore();
    } finally {
      globalThis.fetch = prior;
    }
  };

  await run({
    id: 'resp-output-over-cap', model: 'gpt-gate2b',
    usage: { input_tokens: 100, output_tokens: 201 },
  }, 'EAW_GATE2B_OUTPUT_CAP_BREACHED');
  await run({
    id: 'resp-wrong-model', model: 'different-priced-model',
    usage: { input_tokens: 100, output_tokens: 20 },
  }, 'EAW_GATE2B_SERVED_MODEL_UNAPPROVED');
});

test('provider capture enforces per-run caps and emits complete response-proven spend', async () => {
  let time = 100;
  const fakeFetch = async () => {
    time += 7;
    return response({
      payload: {
        id: 'resp-live-1', model: 'gpt-gate2b',
        usage: { input_tokens: 120, output_tokens: 30 },
      },
    });
  };
  const prior = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const capture = createGate2bProviderCapture({ budget: approvedBudget(), fetchImpl: fakeFetch, countTokensImpl: counted(125), now: () => time });
    capture.install();
    capture.setRunToken('run-a');
    const body = JSON.stringify({ model: 'gpt-gate2b', max_output_tokens: 100, input: 'classify this line' });
    const out = await globalThis.fetch('https://api.openai.com/v1/responses', { method: 'POST', body });
    assert.equal(out.ok, true);
    await assert.rejects(
      globalThis.fetch('https://api.openai.com/v1/responses', { method: 'POST', body }),
      (error) => error.code === 'EAW_GATE2B_CALL_CAP_REFUSED',
    );
    capture.restore();

    const receipt = capture.receipt({ runToken: 'run-a', configurationDigest: DIGEST, artifactDigests: [DIGEST] });
    assert.equal(receipt.status, 'counted');
    assert.equal(receipt.solveCalls, 1);
    assert.equal(receipt.calls[0].response_id, 'resp-live-1');
    assert.equal(receipt.calls[0].model_id, 'gpt-gate2b');
    assert.equal(receipt.calls[0].input_token_preflight.input_tokens, 125);
    assert.equal(receipt.cash.usd, 0.00048);
    assert.deepEqual(receipt.calls_by_run, { 'run-a': 1 });
  } finally {
    globalThis.fetch = prior;
  }
});

test('provider capture supplies the approved output cap and refuses request bodies above the conservative input ceiling', async () => {
  let fetched = 0;
  let transmittedBody = null;
  const fakeFetch = async (_input, init) => {
    fetched += 1;
    transmittedBody = JSON.parse(init.body);
    return response({ payload: {
      id: 'resp-live-2', model: 'gpt-gate2b',
      usage: { input_tokens: 20, output_tokens: 10 },
    } });
  };
  const prior = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const capture = createGate2bProviderCapture({
      budget: approvedBudget(),
      fetchImpl: fakeFetch,
      countTokensImpl: async ({ requestBody }) => counted(String(requestBody.input || '').length || 20)(),
    });
    capture.install();
    capture.setRunToken('run-a');
    await globalThis.fetch('https://api.openai.com/v1/responses', { body: JSON.stringify({ model: 'gpt-gate2b' }) });
    assert.equal(transmittedBody.max_output_tokens, 200);
    capture.setRunToken('run-b');
    await assert.rejects(
      globalThis.fetch('https://api.openai.com/v1/responses', { body: JSON.stringify({ model: 'gpt-gate2b', max_output_tokens: 100, input: 'x'.repeat(2_100) }) }),
      (error) => error.code === 'EAW_GATE2B_INPUT_CAP_REFUSED',
    );
    assert.equal(fetched, 1);
    capture.restore();
  } finally {
    globalThis.fetch = prior;
  }
});

test('provider capture counts the complete provider input before opening the solve request', async () => {
  const paths = [];
  const fakeFetch = async (input) => {
    const pathname = new URL(input).pathname;
    paths.push(pathname);
    if (pathname.endsWith('/input_tokens')) {
      return response({ payload: { input_tokens: 321 } });
    }
    return response({ payload: {
      id: 'resp-live-3', model: 'gpt-gate2b',
      usage: { input_tokens: 321, output_tokens: 12 },
    } });
  };
  const prior = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const capture = createGate2bProviderCapture({ budget: approvedBudget(), fetchImpl: fakeFetch });
    capture.install();
    capture.setRunToken('run-a');
    await globalThis.fetch('https://api.openai.com/v1/responses', {
      body: JSON.stringify({ model: 'gpt-gate2b', input: 'bounded input' }),
    });
    capture.restore();
    assert.deepEqual(paths, ['/v1/responses/input_tokens', '/v1/responses']);
    assert.equal(capture.calls()[0].input_token_preflight.input_tokens, 321);
  } finally {
    globalThis.fetch = prior;
  }
});
