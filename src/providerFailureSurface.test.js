import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

let dom, root, directory, FirmOpsConsole, OperatorProviderFailures, createRoot, LocaleProvider, askResponse;
const requests = [], polls = new Map(), deadlines = new Map();
const realTimeout = setTimeout, realClearTimeout = clearTimeout;
const originals = new Map(['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'MutationObserver',
  'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (clientId = 'a', extra = {}) => ({ id: 'matching:bill', source_id: 'bill', client_id: clientId,
  lane: 'matching', label: `${clientId} invoice.pdf`, code: 'PROVIDER_UNAUTHORIZED', provider: 'anthropic', status: 401,
  reason: 'http_401', owner: 'operator', attempts: 2, recovery_status: 'awaiting_retry', ...extra });
const payload = (clientId, failures = [failure(clientId)]) => ({ client_id: clientId, batches: [], provider_failures: failures });
const flush = () => act(async () => { await new Promise((resolve) => realTimeout(resolve, 20)); });
const text = () => document.body.textContent;
const render = async (id = 'a', locale = 'en', activeEntityTab = 'overview') => {
  if (!root) root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(LocaleProvider, { initialPreferences: { locale } },
    React.createElement(FirmOpsConsole, { clients: [{ id: 'a', companyName: 'Synthetic A' }, { id: 'b', companyName: 'Synthetic B' }],
      selectedClientId: id, queue: [], history: [], firmId: 'fixture-firm', firmDataSource: 'database', activeEntityTab }))));
  await flush();
};
// The operator surface (/firms/operator) mounts the same read model with its
// full diagnostics; the firm's Actions view is a customer surface (FI-05).
const renderOperator = async (id = 'a', locale = 'en') => {
  if (!root) root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(LocaleProvider, { initialPreferences: { locale } },
    React.createElement(OperatorProviderFailures, { clientId: id }))));
  await flush();
};
const CUSTOMER_LEAKS = /PROVIDER_|anthropic|openai|401|http_|credential|Operator action required|Queue recovery|execution_budget_aborted|Failed runs|Queue attempts|Read unavailable/;
const clickRefresh = async (label = 'Refresh status') => {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === label);
  assert.ok(button);
  await act(async () => button.click()); await flush();
};
before(async () => {
  dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost/firms', pretendToBeVisual: true });
  const values = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    setInterval: (fn, ms) => { const handle = {}; polls.set(handle, { fn, ms }); return handle; },
    clearInterval: (handle) => polls.delete(handle),
    setTimeout: (fn, ms, ...args) => { if (ms !== 20_000) return realTimeout(fn, ms, ...args); const handle = {}; deadlines.set(handle, fn); return handle; },
    clearTimeout: (handle) => { if (!deadlines.delete(handle)) realClearTimeout(handle); },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('/ask-batches?')) return askResponse(new URL(url, 'http://localhost').searchParams.get('client_id'), options);
      return response({ items: [], open_asks: [], notifications: [], buckets: {}, transactions: [], messages: [] });
    }
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.localStorage.setItem('donna_dock_open', '0');
  ({ createRoot } = await import('react-dom/client'));
  directory = await mkdtemp(resolve('.provider-surface-test-'));
  await build({ stdin: { contents: `export { default as FirmOpsConsole } from './src/components/FirmOpsConsole.jsx'; export { default as OperatorProviderFailures } from './src/components/financials/OperatorProviderFailures.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx';`, resolveDir: process.cwd() }, outfile: `${directory}/mounted.mjs`, bundle: true,
    format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty', '.woff2': 'empty', '.svg': 'empty' },
    banner: { js: 'const __testGlob = () => ({});' }, define: { 'import.meta.glob': '__testGlob', 'import.meta.env': '{}', __DONNA_UI_BUILD__: '"test"', __DONNA_UI_SOURCE__: '"test"' }, logLevel: 'silent' });
  ({ FirmOpsConsole, OperatorProviderFailures, LocaleProvider } = await import(pathToFileURL(`${directory}/mounted.mjs`)));
});
afterEach(async () => {
  if (root) await act(async () => root.unmount()); root = null;
  assert.equal(polls.size, 0, 'mounted observation timers are removed');
  assert.equal(deadlines.size, 0, 'request deadlines are removed');
  document.body.innerHTML = '<div id="root"></div>'; requests.length = 0;
});
after(async () => {
  dom?.window.close();
  for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('actual firm Actions mounts persisted receipts as the customer projection; refresh observes recovery without writes', async () => {
  askResponse = (id) => response(payload(id, [failure(id), failure(id, { id: 'coding:line', source_id: 'line-42', lane: 'coding', label: 'Bank line', owner: 'queue',
    code: 'PROVIDER_TIMEOUT', reason: 'execution_budget_aborted', provider: 'openai', status: null })]));
  await render();
  assert.match(text(), /Taking longer.*2.*a invoice.pdf.*Saved — this step is taking longer than usual.*Reference BILL/s);
  assert.match(text(), /Bank line.*nothing is needed from you.*Reference LINE42/s);
  assert.doesNotMatch(text(), CUSTOMER_LEAKS, 'no provider, status, code, credential wording or retry bookkeeping reaches the firm');
  assert.equal(document.querySelectorAll('[data-provider-failure]').length, 2);
  assert.ok([...polls.values()].some(({ ms }) => ms === 15_000), 'current mounted surface refreshes persisted state');
  askResponse = (id) => response(payload(id, []));
  await act(async () => { [...polls.values()].find(({ ms }) => ms === 15_000).fn(); }); await flush();
  assert.doesNotMatch(text(), /Taking longer|Provider failures|No active provider failure/, 'no receipt, no panel');
  assert.doesNotMatch(text(), /a invoice.pdf|Operator action required|Auto-reconciled/);
  assert.equal(requests.filter(({ options }) => options.method && options.method !== 'GET').length, 0, 'observation never retries jobs, writes journals or sends asks');
});

test('same mount switches clients, aborts the previous request, and refuses its late success', async () => {
  let release, priorSignal;
  askResponse = (id, options) => id === 'a'
    ? new Promise((resolve) => { release = resolve; priorSignal = options.signal; })
    : response(payload(id));
  await render('a');
  await render('b');
  assert.equal(priorSignal.aborted, true);
  assert.match(text(), /b invoice.pdf/);
  await act(async () => release(response(payload('a')))); await flush();
  assert.match(text(), /b invoice.pdf/);
  assert.doesNotMatch(text(), /a invoice.pdf/);
});

test('overview remount during a pending read loads fresh status and rejects the abandoned response', async () => {
  let release, priorSignal;
  askResponse = (_id, options) => new Promise((resolve) => { release = resolve; priorSignal = options.signal; });
  await render();
  assert.match(text(), /Loading client asks/);
  await render('a', 'en', 'profile');
  assert.equal(priorSignal.aborted, true, 'leaving overview cancels the old mounted request');
  assert.equal(deadlines.size, 0);
  askResponse = (id) => response(payload(id, []));
  await render();
  assert.doesNotMatch(text(), /Taking longer|Provider failures|No active provider failure/, 'no receipt, no panel');
  assert.doesNotMatch(text(), /Loading client asks|Status refresh failed/);
  await act(async () => release(response(payload('a')))); await flush();
  assert.doesNotMatch(text(), /Taking longer|Provider failures|No active provider failure/, 'no receipt, no panel');
  assert.doesNotMatch(text(), /a invoice.pdf|Operator action required|Loading client asks/);

  // A successful empty ask snapshot belongs to the console. On the next
  // remount it remains usable while fresh provider status is still pending.
  await render('a', 'en', 'profile');
  askResponse = (_id, options) => new Promise((resolve) => { release = resolve; priorSignal = options.signal; });
  await render();
  assert.doesNotMatch(text(), /Loading client asks/, 'the console-owned successful ask snapshot survives remount');
  await act(async () => release(response(payload('a', [])))); await flush();
  assert.doesNotMatch(text(), /Taking longer|Provider failures|No active provider failure/, 'no receipt, no panel');
  assert.equal(requests.filter(({ url }) => url.includes('/ask-batches?')).length, 3, 'every mount issues one current read');
});

test('failed refresh preserves receipts as stale; retry resolves them only from a successful current read', async () => {
  askResponse = (id) => response(payload(id)); await render();
  askResponse = () => response({ error: 'Read unavailable', code: 'DB_POOL_TIMEOUT' }, 503); await clickRefresh();
  assert.match(text(), /The latest status could not be loaded/); assert.match(text(), /a invoice.pdf/);
  assert.doesNotMatch(text(), CUSTOMER_LEAKS, 'an injected database failure keeps its text off the firm surface');
  assert.doesNotMatch(text(), /No active provider failure/);
  askResponse = (id) => response(payload(id, [])); await clickRefresh();
  assert.doesNotMatch(text(), /The latest status could not be loaded|a invoice.pdf/);
  assert.doesNotMatch(text(), /Taking longer|Provider failures|No active provider failure/, 'no receipt, no panel');
});

test('operator surface keeps the full diagnostics and exhausted retries the firm view omits', async () => {
  askResponse = (id) => response(payload(id, [failure(id), failure(id, { id: 'coding:line', lane: 'coding', label: 'Bank line', owner: 'queue',
    code: 'PROVIDER_TIMEOUT', reason: 'execution_budget_aborted', provider: 'openai', status: null })]));
  await renderOperator();
  assert.match(text(), /Provider failures.*2.*a invoice.pdf.*Operator action required/s);
  assert.match(text(), /rejected the configured credentials/);
  assert.match(text(), /Bank line.*Queue recovery.*exceeded its deadline/s);
  assert.match(text(), /execution_budget_aborted/);
  askResponse = (id) => response(payload(id, []));
  await clickRefresh();
  assert.match(text(), /No active provider failure receipts/, 'a successful retry clears the operator item');
  assert.equal(requests.filter(({ options }) => options.method && options.method !== 'GET').length, 0, 'observation never writes');
});

test('request rejection is an operator problem without inventing a credential failure; draft recovery names later failure', async () => {
  askResponse = (id) => response(payload(id, [failure(id, { code: 'PROVIDER_REJECTED_REQUEST', status: 400, reason: 'http_400' })]));
  await renderOperator();
  assert.match(text(), /Review the provider configuration and rejected request/);
  assert.doesNotMatch(text(), /Correct the configured provider credentials/);
  askResponse = (id) => response(payload(id, [failure(id, { id: 'ask_draft:request', lane: 'ask_draft', label: null,
    recovery_status: 'retry_in_progress', queue_attempts: 3 })]));
  await clickRefresh();
  assert.match(text(), /Client question draft.*A retry is in progress; recovery is not yet confirmed/s);
  askResponse = (id) => response(payload(id, [failure(id, { id: 'ask_draft:request', lane: 'ask_draft', label: null,
    recovery_status: 'recovery_failed', recovery_error_code: 'ASK_PIPELINE_BAD_DRAFT' })]));
  await clickRefresh();
  assert.match(text(), /A later recovery attempt failed for another reason/);
  assert.match(text(), /ASK_PIPELINE_BAD_DRAFT/);
  assert.doesNotMatch(text(), /Correct the configured provider credentials/);
});

for (const phase of ['headers', 'body']) {
  test(`hung status ${phase} expires, enables refresh, and cannot publish its late result`, async () => {
    let release, signal;
    askResponse = (id, options) => {
      signal = options.signal;
      const pending = new Promise((resolve) => { release = resolve; });
      return phase === 'headers' ? pending : { ok: true, status: 200, json: () => pending };
    };
    await render();
    assert.equal(deadlines.size, 1);
    await act(async () => {
      const [handle, expire] = [...deadlines.entries()][0]; deadlines.delete(handle); expire();
    }); await flush();
    assert.equal(signal.aborted, true);
    // No receipt is known, so there is nothing to mark stale: the panel
    // stays absent and the background poll retries.
    assert.doesNotMatch(text(), /Taking longer|Provider failures|Status refresh failed/);
    askResponse = (id) => response(payload(id, []));
    await act(async () => { [...polls.values()].find(({ ms }) => ms === 15_000).fn(); }); await flush();
    assert.doesNotMatch(text(), /Taking longer|Provider failures|No active provider failure/, 'no receipt, no panel');
    await act(async () => release(phase === 'headers' ? response(payload('a')) : payload('a'))); await flush();
    assert.doesNotMatch(text(), /a invoice.pdf|Taking longer|Status refresh failed/);
  });
}

test('Arabic firm surface renders the customer projection; Arabic operator surface keeps translated causes and identifier islands', async () => {
  askResponse = (id) => response(payload(id)); await render('a', 'ar-AE');
  assert.match(text(), /يستغرق وقتًا أطول/); assert.match(text(), /المرجع/);
  assert.doesNotMatch(text(), CUSTOMER_LEAKS);
  assert.doesNotMatch(text(), /أعطال مزوّد الخدمة|رفض مزوّد الخدمة بيانات الاعتماد/);
  askResponse = () => new Promise(() => {});
  await clickRefresh('تحديث الحالة');
  await act(async () => {
    const [handle, expire] = [...deadlines.entries()][0]; deadlines.delete(handle); expire();
  }); await flush();
  assert.match(text(), /تعذّر تحميل أحدث حالة/);
  assert.doesNotMatch(text(), /Status request timed out|Status refresh failed|The latest status/);
  await act(async () => root.unmount()); root = null; document.body.innerHTML = '<div id="root"></div>';
  askResponse = (id) => response(payload(id)); await renderOperator('a', 'ar-AE');
  assert.match(text(), /أعطال مزوّد الخدمة/); assert.match(text(), /رفض مزوّد الخدمة بيانات الاعتماد/);
  assert.doesNotMatch(text(), /Provider failures|Operator action required/);
  assert.ok([...document.querySelectorAll('bdi')].some((node) => node.textContent.includes('PROVIDER_UNAUTHORIZED')));
});
