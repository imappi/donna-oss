import assert from 'node:assert/strict';
import test from 'node:test';
import { llmCall } from './llmCall.js';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
import { providerFetchWithDeadline } from './providerTransport.js';

const args = { provider: 'openai', url: 'https://fixture.invalid', body: {},
  execution: { root: { type: 'document_extraction', id: 'synthetic-budget' } } };

test('ordinary llmCall callers inherit job cancellation through headers and body, without retrying late bytes', async () => {
  for (const phase of ['headers', 'body']) {
    const budget = createExecutionBudget({ timeoutMs: 60000 });
    let signal, release, calls = 0, parsed = false;
    const result = runWithExecutionBudget(budget, () => llmCall({ ...args, maxAttempts: 4,
      parseResponse: () => { parsed = true; },
      fetchImpl: async (_url, init) => {
        calls += 1;
        signal = init.signal;
        const waiting = new Promise((resolve) => { release = resolve; });
        queueMicrotask(() => budget.abort('cancelled-host'));
        return phase === 'headers' ? waiting : { ok: true, status: 200, json: () => waiting };
      } }));
    await assert.rejects(result, (error) => error.code === 'PROVIDER_TIMEOUT' && error.reason === 'execution_budget_aborted');
    assert.ok(signal.aborted);
    assert.equal(calls, 1);
    release({ ok: true, status: 200, json: async () => ({ late: true }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parsed, false);
  }
});

test('deadline-bearing adapters preserve a caller cancellation as well as the worker signal', async () => {
  const caller = new AbortController();
  let fetches = 0;
  const wrapped = providerFetchWithDeadline({ provider: 'openai', fetchImpl: async (_url, init) => {
    fetches += 1;
    const body = new Promise(() => {});
    queueMicrotask(() => caller.abort());
    assert.ok(init.signal);
    return { ok: true, status: 200, json: () => body };
  } });
  await assert.rejects(wrapped('fixture', { signal: caller.signal }).then((response) => response.json()),
    (error) => error.code === 'PROVIDER_TIMEOUT' && error.reason === 'request_aborted');
  await assert.rejects(wrapped('fixture', { signal: caller.signal }), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(fetches, 1, 'an already cancelled caller cannot start another socket');
});

test('200 headers followed by a cancelled body never report successful provider telemetry', async () => {
  const budget = createExecutionBudget({ timeoutMs: 60000 });
  await assert.rejects(runWithExecutionBudget(budget, () => llmCall({ ...args,
    fetchImpl: async () => ({ ok: true, status: 200, json: () => {
      queueMicrotask(() => budget.abort('cancelled-host'));
      return new Promise(() => {});
    } }) })), (error) => {
    assert.equal(error.code, 'PROVIDER_TIMEOUT');
    assert.equal(error.telemetry.ok, false);
    assert.equal(error.telemetry.status, 200, 'observed header status is retained as context');
    return true;
  });
});
