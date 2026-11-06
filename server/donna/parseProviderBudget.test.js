// Real router/default caller and unified extractor -> llmCall -> provider
// transport. Provider bodies are synthetic; no live calls or persisted books.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeDocument } from './documentRouter.js';
import { extractUnified } from './unifiedExtractor.js';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
import { fiSource, fiRoutingFixture, fiExtractionFixture, openAiFixture } from './testSupport/fiReliabilitySources.js';

const input = { base64: Buffer.from('synthetic document').toString('base64'), filename: 'synthetic.pdf', mimeType: 'application/pdf' };
const response = (fixture) => ({ ok: fixture.status === 200, status: fixture.status, json: async () => fixture.body });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

const withRouterKey = async (run) => {
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture-only';
  try { return await run(); }
  finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; }
};

test('actual router default caller: owner abort reaches headers/body and late routing is refused', { timeout: 5000 }, async () => withRouterKey(async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const phase of ['headers', 'body']) {
      const entered = deferred(), held = deferred();
      const budget = createExecutionBudget({ timeoutMs: 60_000, label: 'router-invocation' });
      let socketSignal;
      globalThis.fetch = async (_url, init) => {
        socketSignal = init.signal;
        if (phase === 'headers') { entered.resolve(); return held.promise; }
        return { ok: true, status: 200, json: () => { entered.resolve(); return held.promise; } };
      };
      const pending = runWithExecutionBudget(budget, () => routeDocument(input));
      await entered.promise;
      budget.abort('host-request-disconnected');
      const result = await pending;
      assert.equal(socketSignal.aborted, true, `${phase}: owning cancellation reaches the actual fetch`);
      assert.deepEqual(result, { routed: false, reason: 'llm_error' });
      const fixture = fiRoutingFixture('bill');
      held.resolve(phase === 'headers' ? response(fixture) : fixture.body);
      await Promise.resolve();
      assert.deepEqual(await pending, result, 'late provider success cannot become a router verdict');
    }
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return response(fiRoutingFixture('bill')); };
    const cancelled = createExecutionBudget({ timeoutMs: 60_000 }); cancelled.abort();
    assert.equal((await runWithExecutionBudget(cancelled, () => routeDocument(input))).routed, false);
    assert.equal(calls, 0, 'an already aborted invocation never starts the router');
    assert.equal((await routeDocument(input)).routed, true, 'no-budget default caller keeps its existing healthy contract');
    assert.equal((await runWithExecutionBudget(createExecutionBudget({ timeoutMs: 60_000 }), () => routeDocument(input))).routed, true,
      'a fresh invocation can route successfully');
  } finally { globalThis.fetch = originalFetch; }
}));

test('actual unified extraction: both providers preserve owning signal, refuse late headers/body and recover', { timeout: 5000 }, async () => {
  const fixture = fiExtractionFixture(fiSource('supplies'));
  for (const provider of ['openai', 'anthropic']) {
    const env = provider === 'openai' ? { OPENAI_API_KEY: 'fixture-only' } : { ANTHROPIC_API_KEY: 'fixture-only' };
    const healthy = provider === 'openai' ? openAiFixture(JSON.parse(fixture.body.content[0].text)) : fixture;
    for (const phase of ['headers', 'body']) {
      const entered = deferred(), held = deferred();
      const budget = createExecutionBudget({ timeoutMs: 60_000, label: 'extraction-invocation' });
      let socketSignal;
      const fetchImpl = async (_url, init) => {
        socketSignal = init.signal;
        if (phase === 'headers') { entered.resolve(); return held.promise; }
        return { ok: true, status: 200, json: () => { entered.resolve(); return held.promise; } };
      };
      const pending = runWithExecutionBudget(budget, () => extractUnified({ ...input, provider, env, fetchImpl }));
      await entered.promise;
      budget.abort('host-request-disconnected');
      const result = await pending;
      assert.equal(socketSignal.aborted, true, `${provider}/${phase}: adapter must not replace llmCall's signal`);
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
      assert.equal(result.reason, 'timeout');
      assert.equal(result.retryable, true);
      assert.equal(result.header, undefined);
      assert.equal(result.lines, undefined);
      held.resolve(phase === 'headers' ? response(healthy) : healthy.body);
      await Promise.resolve();
      assert.deepEqual(await pending, result, 'late extraction output remains refused');
    }
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return response(healthy); };
    const cancelled = createExecutionBudget({ timeoutMs: 60_000 }); cancelled.abort();
    assert.equal((await runWithExecutionBudget(cancelled, () => extractUnified({ ...input, provider, env, fetchImpl }))).kind, 'failed');
    assert.equal(calls, 0, 'an already aborted invocation never starts extraction');
    const recovered = await runWithExecutionBudget(createExecutionBudget({ timeoutMs: 60_000 }),
      () => extractUnified({ ...input, provider, env, fetchImpl }));
    assert.equal(recovered.kind, 'completed_header', JSON.stringify(recovered));
    assert.equal(recovered.header.total_amount, fiSource('supplies').total);
  }
});

test('budgeted default parser transports retain the existing credential-failure envelopes', async () => withRouterKey(async () => {
  const originalFetch = globalThis.fetch;
  const rejected = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'fixture rejected credential' } }) });
  try {
    globalThis.fetch = rejected;
    const routed = await runWithExecutionBudget(createExecutionBudget({ timeoutMs: 60_000 }), () => routeDocument(input));
    assert.deepEqual(routed, { routed: false, reason: 'llm_error' });
    for (const provider of ['openai', 'anthropic']) {
      const env = provider === 'openai' ? { OPENAI_API_KEY: 'fixture-only' } : { ANTHROPIC_API_KEY: 'fixture-only' };
      const extracted = await runWithExecutionBudget(createExecutionBudget({ timeoutMs: 60_000 }),
        () => extractUnified({ ...input, provider, env, fetchImpl: rejected }));
      assert.equal(extracted.kind, 'failed');
      assert.equal(extracted.code, 'DOCUMENT_EXTRACTION_UNAUTHORIZED');
      assert.equal(extracted.http_status, 401);
      assert.equal(extracted.retryable, false);
      assert.equal(extracted.header, undefined);
    }
  } finally { globalThis.fetch = originalFetch; }
}));

// One refusal at the real transport must never fall through to a second model
// or turn into retryable network failure.
test('spending refusal remains an operator pause through router and extraction', async () => withRouterKey(async () => {
  const { categorizeError } = await import('./inngest/parseErrors.js');
  const previous = globalThis.fetch;
  let calls = 0;
  const refused = async () => { calls += 1; throw Object.assign(new Error('private limit'), { code: 'trial_spend_cap_refused' }); };
  globalThis.fetch = refused;
  try {
    for (const run of [() => routeDocument(input), () => extractUnified({ ...input, provider: 'openai', env: { OPENAI_API_KEY: 'fixture-only' }, fetchImpl: refused })]) {
      await assert.rejects(run, error => {
        const receipt = categorizeError(error);
        assert.equal(receipt.code, 'DOCUMENT_SPEND_LIMIT');
        assert.equal(receipt.retryable, false);
        assert.equal(receipt.retry_owner, 'manual');
        assert.match(receipt.safe_user_message, /spending allowance/);
        return true;
      });
    }
    assert.equal(calls, 2, 'one attempt per operation, no automatic retries');
  } finally { globalThis.fetch = previous; }
}));
