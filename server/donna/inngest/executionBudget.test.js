import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
  InngestExecutionBudgetMiddleware, INNGEST_INVOCATION_TIMEOUT_MS,
  runInngestRequestWithBudget
} from './executionBudget.js';
import { inngest } from './client.js';
import {
  createExecutionBudget, currentExecutionBudget, runWithExecutionBudget
} from '../executionBudget.js';
import { fetchProviderJson, waitForProviderRetry } from '../providerTransport.js';

const surfaces = () => ({ req: new EventEmitter(), res: new EventEmitter() });
const middleware = new InngestExecutionBudgetMiddleware({ client: inngest });

test('cloud budget is wired at the actual serve/client and below the platform hard cap', async () => {
  const serve = await readFile(new URL('./serve.js', import.meta.url), 'utf8');
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../../../api/inngest.js', import.meta.url), 'utf8');
  assert.match(serve, /return runInngestRequestWithBudget\(req, res, \(\) => cachedHandler\(req, res\)\)/);
  assert.match(client, /middleware:\s*\[[^\]]*\bInngestExecutionBudgetMiddleware\b/);
  assert.ok(INNGEST_INVOCATION_TIMEOUT_MS < Number(route.match(/maxDuration: (\d+)/)[1]) * 1000);
});

test('HTTP timeout aborts headers/body, refuses late step success and keeps a fresh retry independent', async () => {
  for (const phase of ['headers', 'body']) {
    const { req, res } = surfaces();
    let release, signal, budget;
    const promise = runInngestRequestWithBudget(req, res, () => middleware.wrapStepHandler({ next: async () => {
      budget = currentExecutionBudget();
      try {
        await fetchProviderJson({ provider: 'openai', url: 'fixture', timeoutMs: 10000, reserveMs: 0, minAttemptMs: 1,
          fetchImpl: async (_url, init) => {
            signal = init.signal;
            const held = new Promise((resolve) => { release = resolve; });
            return phase === 'headers' ? held : { ok: true, status: 200, json: () => held };
          } });
      } catch (error) {
        assert.equal(error.code, 'PROVIDER_TIMEOUT');
        // Existing coder/matcher workers receipt the failure and return.
        return { recorded_failure: true };
      }
      assert.fail('a late provider result reached the worker');
    } }), { timeoutMs: 40 });
    await assert.rejects(promise, { code: 'INNGEST_EXECUTION_BUDGET_EXHAUSTED' });
    assert.ok(signal.aborted);
    assert.ok(budget.signal.aborted);
    release({ ok: true, status: 200, json: async () => ({ late: true }) });
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
    const retry = surfaces();
    assert.deepEqual(await runInngestRequestWithBudget(retry.req, retry.res,
      () => middleware.wrapStepHandler({ next: async () => ({ recovered: true }) })), { recovered: true });
  }
});

test('normal request body close does not abort; disconnected response aborts retry backoff', async () => {
  const { req, res } = surfaces();
  let budget;
  await assert.rejects(runInngestRequestWithBudget(req, res, async () => {
    budget = currentExecutionBudget();
    req.emit('close');
    assert.equal(budget.signal.aborted, false);
    const pending = waitForProviderRetry({ provider: 'anthropic', delayMs: 60000 });
    res.emit('close');
    await pending;
  }), (error) => error.code === 'PROVIDER_TIMEOUT' && error.reason === 'execution_budget_aborted');
  assert.equal(budget.signal.reason, 'inngest_response_closed');
});

test('provider receipt reserve does not turn an exhausted invocation into cached SDK success', async () => {
  for (const compatible of [false, true]) {
    const { providerFetchWithDeadline } = await import('../providerTransport.js');
    const { req, res } = surfaces();
    await assert.rejects(runInngestRequestWithBudget(req, res,
      () => middleware.wrapStepHandler({ next: async () => {
        try {
          const options = { provider: 'openai', url: 'fixture', timeoutMs: 5000, reserveMs: 80, minAttemptMs: 1,
            fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) };
          if (compatible) await (await providerFetchWithDeadline(options)('fixture')).json();
          else await fetchProviderJson(options);
        } catch (error) {
          assert.equal(error.reason, 'execution_budget_exhausted');
          assert.ok(currentExecutionBudget().deadlineAt > Date.now(), 'failure receipt still has reserved wall time');
          return { recorded_failure: true };
        }
      } }), { timeoutMs: 120 }), { code: 'INNGEST_EXECUTION_BUDGET_EXHAUSTED' });
  }
});

test('HTTP completion and request abort invalidate detached continuations', async () => {
  for (const event of ['aborted', 'finish']) {
    const { req, res } = surfaces();
    await runInngestRequestWithBudget(req, res, async () => {
      if (event === 'finish') { res.writableFinished = true; res.emit(event); }
      else req.emit(event);
      await assert.rejects(middleware.wrapStepHandler({ next: async () => assert.fail('must refuse before work') }),
        { code: 'INNGEST_EXECUTION_BUDGET_EXHAUSTED' });
    });
  }
});

test('an inherited budget cannot be extended and cancellation keeps the original worker error', async () => {
  const parent = createExecutionBudget({ timeoutMs: 10000 });
  const { req, res } = surfaces();
  const original = new Error('retry this step');
  await runWithExecutionBudget(parent, async () => {
    await assert.rejects(runInngestRequestWithBudget(req, res, async () => {
      assert.equal(currentExecutionBudget().deadlineAt, parent.deadlineAt);
      parent.abort('cancel');
      assert.ok(currentExecutionBudget().signal.aborted);
      return middleware.wrapStepHandler({ next: async () => { throw original; } });
    }), { code: 'INNGEST_EXECUTION_BUDGET_EXHAUSTED' });
  });
  const next = surfaces();
  await assert.rejects(runInngestRequestWithBudget(next.req, next.res,
    () => middleware.wrapStepHandler({ next: async () => { throw original; } })), (error) => error === original);
});
