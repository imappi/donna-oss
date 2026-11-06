// providerTransport.js + executionBudget.js — the shared provider contract.
// What must hold (docs/finding-2026-09-13-fi-provider-failure-recovery.md):
//   - every failure class maps to ONE typed code with the right owner;
//   - headers that never arrive AND a body that never arrives both time out
//     at the deadline, and a response arriving after it is dropped;
//   - the ambient execution budget caps the per-attempt timeout, refuses an
//     attempt the budget cannot hold, and its abort rejects an in-flight call;
//   - a raw network error and an unreadable body get the same treatment
//     (typed, retryable, queue-owned) as a 5xx.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';

import {
  PROVIDER_FAILURE_CODES,
  ProviderFailureError,
  budgetAllowsRetry,
  callProviderJson,
  classifyProviderStatus,
  classifyProviderThrow,
  fetchProviderJson,
  isProviderFailure,
  providerFailureReceipt,
  providerFetchWithDeadline,
  providerInvalidOutput,
  providerKeyMissing,
  resolveProviderDeadline
} from './providerTransport.js';
import { createExecutionBudget, currentExecutionBudget, remainingExecutionBudgetMs, runWithExecutionBudget } from './executionBudget.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const okResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('classification: status → one typed code, owner and retryability', () => {
  const table = [
    [401, PROVIDER_FAILURE_CODES.UNAUTHORIZED, 'operator', false],
    [403, PROVIDER_FAILURE_CODES.UNAUTHORIZED, 'operator', false],
    [429, PROVIDER_FAILURE_CODES.RATE_LIMITED, 'queue', true],
    [500, PROVIDER_FAILURE_CODES.UNAVAILABLE, 'queue', true],
    [503, PROVIDER_FAILURE_CODES.UNAVAILABLE, 'queue', true],
    [529, PROVIDER_FAILURE_CODES.UNAVAILABLE, 'queue', true],
    [400, PROVIDER_FAILURE_CODES.REJECTED_REQUEST, 'operator', false],
    [404, PROVIDER_FAILURE_CODES.REJECTED_REQUEST, 'operator', false]
  ];
  for (const [status, code, owner, retryable] of table) {
    const error = classifyProviderStatus({ provider: 'openai', status, payload: { error: { message: 'm', code: 'c' } } });
    assert.ok(error instanceof ProviderFailureError);
    assert.equal(error.code, code, `status ${status}`);
    assert.equal(error.owner, owner, `status ${status} owner`);
    assert.equal(error.retryable, retryable, `status ${status} retryable`);
    assert.equal(error.status, status);
    assert.equal(error.reason, 'c', 'the provider error code rides as the reason');
    assert.ok(isProviderFailure(error));
  }
  const exhausted = classifyProviderStatus({ provider: 'anthropic', status: 529, attempts: 3, payload: { error: { message: 'Overloaded' } } });
  assert.match(exhausted.message, /overloaded after 3 attempts \(last status 529\)/i);
  const missing = providerKeyMissing('anthropic', { keyName: 'ANTHROPIC_API_KEY' });
  assert.equal(missing.code, PROVIDER_FAILURE_CODES.KEY_MISSING);
  assert.equal(missing.owner, 'operator');
  assert.equal(missing.reason, 'no_api_key');
  const unreadable = providerInvalidOutput('openai', { detail: 'not JSON', model: 'gpt-5.4' });
  assert.equal(unreadable.code, PROVIDER_FAILURE_CODES.INVALID_OUTPUT);
  assert.equal(unreadable.retryable, true);
  assert.equal(unreadable.owner, 'queue');
  assert.match(unreadable.message, /gpt-5\.4 returned an unreadable response \(not JSON\)/);
});

test('absolute deadline refuses late bytes even when the event loop has not delivered the timer', async () => {
  for (const compatible of [false, true]) {
    let clock = 1000;
    let signal;
    const options = { provider: 'openai', url: 'fixture', now: () => clock, timeoutMs: 100,
      fetchImpl: async (_url, init) => { signal = init.signal; return { ok: true, status: 200, json: async () => { clock = 1100; return { late: true }; } }; } };
    await assert.rejects(compatible
      ? providerFetchWithDeadline(options)('fixture').then((response) => response.json())
      : fetchProviderJson(options),
    (error) => error.code === 'PROVIDER_TIMEOUT' && error.reason === 'request_timeout');
    assert.ok(signal.aborted, 'absolute expiry cancels the underlying socket too');
  }
});

test('env knobs: a zero reserve is honoured, a zero or bad timeout falls back', async () => {
  const { providerBudgetReserveMs, providerRequestTimeoutMs } = await import('./providerTransport.js');
  const prior = { r: process.env.PROVIDER_BUDGET_RESERVE_MS, t: process.env.PROVIDER_REQUEST_TIMEOUT_MS };
  try {
    process.env.PROVIDER_BUDGET_RESERVE_MS = '0'; assert.equal(providerBudgetReserveMs(), 0);
    process.env.PROVIDER_BUDGET_RESERVE_MS = '-5'; assert.equal(providerBudgetReserveMs(), 15_000);
    process.env.PROVIDER_REQUEST_TIMEOUT_MS = '0'; assert.equal(providerRequestTimeoutMs(), 90_000);
    process.env.PROVIDER_REQUEST_TIMEOUT_MS = '2500'; assert.equal(providerRequestTimeoutMs(), 2_500);
  } finally {
    if (prior.r === undefined) delete process.env.PROVIDER_BUDGET_RESERVE_MS; else process.env.PROVIDER_BUDGET_RESERVE_MS = prior.r;
    if (prior.t === undefined) delete process.env.PROVIDER_REQUEST_TIMEOUT_MS; else process.env.PROVIDER_REQUEST_TIMEOUT_MS = prior.t;
  }
});

test('classification: thrown errors — abort/timeout, network, and everything else untouched', () => {
  const aborted = classifyProviderThrow({ provider: 'openai', error: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
  assert.equal(aborted.code, PROVIDER_FAILURE_CODES.TIMEOUT);
  const reset = classifyProviderThrow({ provider: 'openai', error: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) });
  assert.equal(reset.code, PROVIDER_FAILURE_CODES.NETWORK);
  assert.equal(reset.reason, 'ECONNRESET');
  assert.equal(reset.retryable, true);
  assert.equal(reset.owner, 'queue');
  const dns = classifyProviderThrow({ provider: 'anthropic', error: Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' }) });
  assert.equal(dns.code, PROVIDER_FAILURE_CODES.NETWORK);
  const undici = classifyProviderThrow({ provider: 'anthropic', error: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(undici.code, PROVIDER_FAILURE_CODES.NETWORK);
  assert.equal(classifyProviderThrow({ provider: 'openai', error: new Error('a bug in our code') }), null, 'a non-transport error is not laundered');
  const typed = new ProviderFailureError({ code: 'PROVIDER_UNAVAILABLE', provider: 'openai', status: 503 });
  assert.equal(classifyProviderThrow({ provider: 'openai', error: typed }), typed, 'an already-typed failure passes through');
  const receipt = providerFailureReceipt(typed);
  assert.deepEqual(Object.keys(receipt).sort(), ['attempts', 'code', 'message', 'owner', 'provider', 'reason', 'retryable', 'status']);
  assert.equal(providerFailureReceipt(new Error('x')), null);
});

test('fetchProviderJson: hung headers time out at the deadline; a late response is dropped', async () => {
  let resolveLate = null;
  let receivedSignal = null;
  const fetchImpl = (url, init) => new Promise((resolve) => {
    receivedSignal = init.signal;
    resolveLate = () => resolve(okResponse({ late: true }));
  });
  const startedAt = Date.now();
  let error = null;
  try {
    await fetchProviderJson({ provider: 'openai', url: 'https://api.openai.com/v1/responses', fetchImpl, timeoutMs: 40 });
  } catch (err) { error = err; }
  assert.ok(error, 'rejected');
  assert.equal(error.code, PROVIDER_FAILURE_CODES.TIMEOUT);
  assert.equal(error.reason, 'request_timeout');
  assert.ok(Date.now() - startedAt < 2_000, 'rejected at the deadline, not later');
  assert.equal(receivedSignal?.aborted, true, 'the fetch received the abort signal');
  // The provider answers late: nothing surfaces (the promise already settled).
  resolveLate();
  await sleep(5);
});

test('fetchProviderJson: hung BODY times out too — the deadline covers headers and body', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  await assert.rejects(
    fetchProviderJson({ provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages', fetchImpl, timeoutMs: 30 }),
    (error) => error.code === PROVIDER_FAILURE_CODES.TIMEOUT && /headers or body never arrived/.test(error.message)
  );
});

test('fetchProviderJson: a network rejection is typed; a non-JSON body reads as no payload; other throws propagate', async () => {
  await assert.rejects(
    fetchProviderJson({ provider: 'openai', url: 'u', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, timeoutMs: 1000 }),
    (error) => error.code === PROVIDER_FAILURE_CODES.NETWORK && error.reason === 'ECONNREFUSED'
  );
  const html = await fetchProviderJson({ provider: 'openai', url: 'u', fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('<html>'); } }), timeoutMs: 1000 });
  assert.equal(html.ok, false); assert.equal(html.status, 502); assert.equal(html.payload, null);
  await assert.rejects(
    fetchProviderJson({ provider: 'openai', url: 'u', fetchImpl: async () => { throw new Error('a bug'); }, timeoutMs: 1000 }),
    (error) => error.message === 'a bug' && !isProviderFailure(error)
  );
});

test('callProviderJson: OK returns the payload; non-OK throws the typed status failure', async () => {
  const ok = await callProviderJson({ provider: 'openai', url: 'u', fetchImpl: async () => okResponse({ id: 'r' }), timeoutMs: 1000 });
  assert.deepEqual(ok.payload, { id: 'r' });
  await assert.rejects(
    callProviderJson({ provider: 'openai', url: 'u', fetchImpl: async () => okResponse({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }, 401), timeoutMs: 1000 }),
    (error) => error.code === PROVIDER_FAILURE_CODES.UNAUTHORIZED && error.owner === 'operator' && error.reason === 'invalid_api_key'
  );
});

test('body disconnects preserve the network cause; rejected HTTP status remains authoritative', async () => {
  for (const socketCode of ['ECONNRESET', 'UND_ERR_SOCKET']) {
    for (const [status, code, owner] of [
      [200, PROVIDER_FAILURE_CODES.NETWORK, 'queue'],
      [401, PROVIDER_FAILURE_CODES.UNAUTHORIZED, 'operator'],
      [429, PROVIDER_FAILURE_CODES.RATE_LIMITED, 'queue'],
      [503, PROVIDER_FAILURE_CODES.UNAVAILABLE, 'queue']
    ]) {
      await assert.rejects(callProviderJson({ provider: 'openai', url: 'fixture', attempts: 2,
        fetchImpl: async () => ({ ok: status === 200, status, json: async () => {
          throw Object.assign(new TypeError('terminated'), { cause: { code: socketCode } });
        } }) }), (error) => {
        const receipt = providerFailureReceipt(error);
        assert.equal(receipt.code, code);
        assert.equal(receipt.owner, owner);
        assert.equal(receipt.attempts, 2);
        if (status === 200) {
          assert.equal(receipt.reason, socketCode);
          assert.equal(receipt.retryable, true);
        } else assert.equal(receipt.status, status);
        return true;
      });
    }
  }
  for (const status of [200, 401, 503]) {
    const result = await fetchProviderJson({ provider: 'openai', url: 'fixture',
      fetchImpl: async () => ({ ok: status === 200, status, json: async () => { throw new SyntaxError('not JSON'); } }) });
    assert.equal(result.status, status);
    assert.equal(result.payload, null, 'non-JSON bodies keep the established caller-owned interpretation');
  }
  await assert.rejects(callProviderJson({ provider: 'openai', url: 'fixture',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }) }),
  (error) => error.code === PROVIDER_FAILURE_CODES.TIMEOUT, 'an aborted body cannot hide operation cancellation behind a status');
});

test('native fetch: a socket closed after successful headers is receipted as a body network failure', async (t) => {
  let serverResponse;
  const server = createServer((_req, response) => {
    serverResponse = response;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"partial":');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  let headersRead = false;
  await assert.rejects(callProviderJson({ provider: 'openai', url: `http://127.0.0.1:${server.address().port}`,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      headersRead = true;
      const readJson = response.json.bind(response);
      response.json = () => {
        const body = readJson();
        serverResponse.destroy();
        return body;
      };
      return response;
    } }), (error) => {
    assert.equal(headersRead, true);
    assert.equal(error.code, PROVIDER_FAILURE_CODES.NETWORK);
    assert.equal(error.reason, 'UND_ERR_SOCKET');
    assert.equal(error.retryable, true);
    assert.match(error.message, /during transport/);
    return true;
  });
});

test('execution budget: caps the attempt, refuses an attempt it cannot hold, and its abort rejects an in-flight call', async () => {
  assert.equal(currentExecutionBudget(), null);
  assert.equal(remainingExecutionBudgetMs(), null);
  assert.deepEqual(resolveProviderDeadline({ timeoutMs: 5_000 }).timeoutMs, 5_000, 'no budget ⇒ the request timeout alone');

  // 1. The per-attempt timeout is capped by the remaining budget minus the reserve.
  const budget = createExecutionBudget({ timeoutMs: 10_000, label: 'test#1' });
  await runWithExecutionBudget(budget, async () => {
    assert.equal(currentExecutionBudget(), budget);
    const deadline = resolveProviderDeadline({ timeoutMs: 90_000, reserveMs: 4_000 });
    assert.ok(deadline.timeoutMs <= 6_000 && deadline.timeoutMs > 5_000, `capped to remaining − reserve, got ${deadline.timeoutMs}`);
    assert.equal(budgetAllowsRetry({ delayMs: 1_000, reserveMs: 4_000, minAttemptMs: 2_000 }), true);
    assert.equal(budgetAllowsRetry({ delayMs: 5_000, reserveMs: 4_000, minAttemptMs: 2_000 }), false, 'a backoff the budget cannot hold is refused');
  });

  // 2. A spent budget refuses to start a call at all — typed, no fetch.
  const spent = createExecutionBudget({ timeoutMs: 1_000, label: 'test#2' });
  let fetched = 0;
  await runWithExecutionBudget(spent, async () => {
    await assert.rejects(
      fetchProviderJson({ provider: 'openai', url: 'u', fetchImpl: async () => { fetched += 1; return okResponse({}); }, timeoutMs: 90_000, reserveMs: 5_000 }),
      (error) => error.code === PROVIDER_FAILURE_CODES.TIMEOUT && error.reason === 'execution_budget_exhausted' && error.budget?.label === 'test#2'
    );
  });
  assert.equal(fetched, 0, 'no request was started');

  // 3. The scheduler aborts the budget mid-call: the in-flight request rejects at once.
  const live = createExecutionBudget({ timeoutMs: 60_000, label: 'test#3' });
  let abortedSignal = null;
  const pending = runWithExecutionBudget(live, () => fetchProviderJson({
    provider: 'anthropic', url: 'u', timeoutMs: 30_000, reserveMs: 0,
    fetchImpl: (url, init) => new Promise(() => { abortedSignal = init.signal; })
  }));
  await sleep(5);
  live.abort('execution_budget_aborted');
  await assert.rejects(pending, (error) => error.code === PROVIDER_FAILURE_CODES.TIMEOUT && error.reason === 'execution_budget_aborted');
  assert.equal(abortedSignal?.aborted, true);
  assert.equal(remainingExecutionBudgetMs.call(null), null, 'outside the run, no budget');
  await runWithExecutionBudget(live, async () => assert.equal(remainingExecutionBudgetMs(), 0, 'an aborted budget reads as spent'));
});

test('providerFetchWithDeadline: the wrapped fetch bounds headers and the body read a caller performs itself', async () => {
  const wrapped = providerFetchWithDeadline({ provider: 'openai_compatible', timeoutMs: 40, fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: () => new Promise(() => {}) }) });
  const response = await wrapped('https://api.together.xyz/v1/chat/completions', { method: 'POST' });
  assert.equal(response.ok, true);
  await assert.rejects(response.json(), (error) => error.code === PROVIDER_FAILURE_CODES.TIMEOUT);
  const hung = providerFetchWithDeadline({ provider: 'openai_compatible', timeoutMs: 30, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(hung('u', {}), (error) => error.code === PROVIDER_FAILURE_CODES.TIMEOUT);
  const fine = providerFetchWithDeadline({ provider: 'openai_compatible', timeoutMs: 1000, fetchImpl: async () => okResponse({ choices: [] }) });
  assert.deepEqual(await (await fine('u', {})).json(), { choices: [] });
});
