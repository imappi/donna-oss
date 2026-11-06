import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
let dom, directory, createRoot, SettingsPanel, LocaleProvider, saveAuthSession, clearAuthSession, root;
let calls, responder, deadlines;
const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const originals = new Map(['window','document','navigator','localStorage','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT','fetch','setTimeout','clearTimeout']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const review = (id = 'a') => ({ firm_id: 'f', client_id: id, actor_id: 'member', client_version: id.repeat(64),
  profile: { companyName: `Synthetic ${id} Oy`, accountingBasis: '' }, configuration: [], processing_readiness: 'INCOMPLETE' });
const receipt = (id = 'a') => ({ firm_id: 'f', client_id: id, actor_id: 'member', processing_readiness: 'INCOMPLETE',
  authority_basis: 'explicit_internal_pilot_setup', profile: { companyName: `Synthetic ${id} Oy`, accountingBasis: 'accrual' } });
const flush = async () => act(async () => { await new Promise(resolve => realTimeout(resolve, 15)); });
const panel = () => document.querySelector('section[aria-label="Finnish internal pilot setup"]');
const button = label => [...panel().querySelectorAll('button')].find(node => node.textContent === label);
const click = async label => { assert.ok(button(label)); await act(async () => button(label).click()); await flush(); };
const change = async (node, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(node instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new window.Event(node instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
};
const selectClient = async id => change(panel().querySelector('select'), id);
const confirm = async () => {
  await change(panel().querySelectorAll('select')[1], 'accrual');
  await act(async () => panel().querySelector('[type="checkbox"]').click());
};
const mount = async (props = {}) => {
  calls = []; deadlines = new Map();
  responder ||= async (url, init) => response(init.method === 'POST' ? receipt() : review());
  window.localStorage.clear();
  saveAuthSession({access_token:'operator-token',user:{id:'operator-auth'}});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(LocaleProvider, null, React.createElement(SettingsPanel, {
    section: 'data', firm: { id: 'f' }, clients: [{ id: 'a', companyName: 'Synthetic a Oy', jurisdiction: 'FI' }, { id: 'b', companyName: 'Synthetic b Oy', jurisdiction: 'FI' }], dataSource: 'database', ...props
  }))));
  await flush();
};
before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/firms', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import('react-dom/client'));
  globalThis.setTimeout = (fn, ms, ...args) => { if (ms !== 20_000) return realTimeout(fn, ms, ...args); const key = {}; deadlines.set(key, fn); return key; };
  globalThis.clearTimeout = key => { if (!deadlines?.delete(key)) realClear(key); };
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).includes('finnish-pilot-setup')) return response({ database_configured: true, enabled: false, clients: [], items: [] });
    calls.push({ url: String(url), ...init });
    return responder(String(url), init);
  };
  directory = await mkdtemp(resolve('.pilot-settings-test-'));
  await build({ stdin: { contents: "export { default as SettingsPanel } from './src/components/settings/SettingsPanel.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx'; export { saveAuthSession, clearAuthSession } from './src/lib/accessToken.js';", resolveDir: process.cwd() },
    outfile: `${directory}/mounted.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
    loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
  ({ SettingsPanel, LocaleProvider, saveAuthSession, clearAuthSession } = await import(pathToFileURL(`${directory}/mounted.mjs`)));
});
afterEach(async () => {
  if (root) await act(async () => root.unmount()); root = null;
  if (dom) { delete window.donnaDesktop; document.body.innerHTML = '<div id="root"></div>'; }
  responder = null; deadlines?.clear();
});
after(async () => {
  try { dom?.window.close(); } finally {
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('real Settings Data mounts the reviewed setup and requires explicit method and confirmation before its real API request', async () => {
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');
  assert.match(app, /import SettingsPanel from/); assert.match(app, /<SettingsPanel[\s\S]*clients=\{firmClients\}/);
  let finish;
  responder = async (url, init) => init.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : response(review());
  await mount(); assert.ok(panel()); assert.equal(calls.length, 0);
  await selectClient('a');
  assert.equal(button('Prepare internal pilot').disabled, true);
  assert.equal(panel().querySelectorAll('select')[1].value, '', 'no accounting method inferred');
  await confirm(); await click('Prepare internal pilot');
  assert.equal(button('Prepare internal pilot').disabled, true);
  const sent = JSON.parse(calls.find(call => call.method === 'POST').body);
  assert.deepEqual(sent, { firm_id: 'f', profile_patch: { companyName: 'Synthetic a Oy', jurisdiction: 'FI', entityType: 'fi-oy', accountingCurrency: 'EUR',
    accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' }, client_version: 'a'.repeat(64), confirmed: true });
  await act(async () => finish(response(receipt()))); await flush();
  assert.match(panel().textContent, /Internal pilot preparation recorded/);
  assert.match(panel().textContent, /Processing: INCOMPLETE/);
  assert.match(panel().textContent, /explicit_internal_pilot_setup/);
  assert.equal(button('Prepare internal pilot'), undefined);
});
test('editing reviewed profile clears consent', async () => {
  await mount(); await selectClient('a'); await confirm();
  assert.equal(button('Prepare internal pilot').disabled, false);
  await change(panel().querySelector('input:not([type="checkbox"])'), 'Changed Oy');
  assert.equal(panel().querySelector('[type="checkbox"]').checked, false);
  assert.equal(button('Prepare internal pilot').disabled, true);
});
test('owner/member refusal exposes no apply controls and permits a fresh review', async () => {
  responder = async () => response({ error: 'Firm member access is required.', code: 'FIRM_ACCESS_DENIED' }, 403);
  await mount(); await selectClient('a');
  assert.match(panel().querySelector('[role="alert"]').textContent, /Firm member/);
  assert.equal(button('Prepare internal pilot'), undefined);
  assert.equal(panel().querySelector('[type="checkbox"]'), null);
  responder = async () => response(review()); await click('Review current setup');
  assert.ok(button('Prepare internal pilot')); assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});
test('stale apply error requires a new review; no optimistic preparation receipt', async () => {
  responder = async (url, init) => init.method === 'POST' ? response({ error: 'This client changed after review.', code: 'PILOT_CLIENT_CHANGED' }, 409) : response(review());
  await mount(); await selectClient('a'); await confirm(); await click('Prepare internal pilot');
  assert.match(panel().textContent, /client changed after review/);
  assert.doesNotMatch(panel().textContent, /Internal pilot preparation recorded/);
  assert.equal(button('Prepare internal pilot'), undefined);
  await click('Review current setup'); assert.equal(button('Prepare internal pilot').disabled, true);
});
test('client switch ignores an old review even when the transport responds after cancellation', async () => {
  let finish;
  responder = async url => url.includes('/a/') ? new Promise(resolve => { finish = resolve; }) : response(review('b'));
  await mount(); await selectClient('a'); await selectClient('b');
  await act(async () => finish(response(review('a')))); await flush();
  assert.equal(panel().querySelector('input:not([type="checkbox"])').value, 'Synthetic b Oy');
});
test('client switch ignores a completed prior-client mutation receipt', async () => {
  let finish;
  responder = async (url, init) => init.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : response(review(url.includes('/b/') ? 'b' : 'a'));
  await mount(); await selectClient('a'); await confirm(); await click('Prepare internal pilot'); await selectClient('b');
  await act(async () => finish(response(receipt('a')))); await flush();
  assert.doesNotMatch(panel().textContent, /Internal pilot preparation recorded/);
  assert.equal(panel().querySelector('input:not([type="checkbox"])').value, 'Synthetic b Oy');
});
test('bounded read timeout is visible and never claims preparation', async () => {
  responder = async (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  await mount(); await selectClient('a');
  await act(async () => { for (const expire of [...deadlines.values()]) expire(); }); await flush();
  assert.match(panel().textContent, /request timed out/); assert.equal(button('Prepare internal pilot'), undefined);
  assert.equal(button('Review current setup').disabled, false);
});
test('response from another client cannot admit setup', async () => {
  responder = async () => response(review('b')); await mount(); await selectClient('a');
  assert.match(panel().textContent, /could not be verified/); assert.equal(button('Prepare internal pilot'), undefined);
});
test('a persisted receipt is readable after refresh without a new apply', async () => {
  responder = async () => response({ ...review(), receipt: { metadata: receipt() } });
  await mount(); await selectClient('a');
  assert.match(panel().textContent, /Internal pilot preparation recorded/);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});
for (const mode of ['desktop', 'seed']) test(`${mode} does not expose hosted pilot setup`, async () => {
  if (mode === 'desktop') window.donnaDesktop = { shell: 'test' };
  await mount({ dataSource: mode === 'seed' ? 'seed' : 'database' });
  assert.equal(Boolean(panel()), false); assert.equal(calls.length, 0);
});

const recoveryReview=(id='a')=>({firm_id:'f',client_id:id,actor_id:'member',actor_user_id:'operator-auth',company_name:`Synthetic ${id} Oy`,
  owner_email:'owner@proof.invalid',purpose:'deleted_owner_recovery_operator',review_digest:id.repeat(64),expires_at:'2099-01-01T12:00:00Z',processing_readiness:'INCOMPLETE'});
const recoveryApplied=()=>({...recoveryReview(),purpose:'deleted_owner_recovery_applied',receipt_id:88});
const openRecovery=async()=>{await mount();await selectClient('a');await click('Review sign-in recovery');};
test('operator mounted recovery displays exact pending company/email and sends only consent/digest, then directs owner back',async()=>{
  responder=async(url,init)=>response(init.method==='POST'?recoveryApplied():url.includes('recovery=owner')?recoveryReview():review());
  await openRecovery();assert.equal(button('Approve sign-in recovery').disabled,true);assert.match(panel().textContent,/owner@proof.invalid/);
  await act(async()=>panel().querySelector('[type="checkbox"]').click());await click('Approve sign-in recovery');
  const sent=JSON.parse(calls.at(-1).body);assert.deepEqual(sent,{firm_id:'f',owner_recovery:{action:'approve',confirmed:true,review_digest:'a'.repeat(64)}});
  assert.match(panel().textContent,/Sign-in recovery recorded/);assert.match(panel().textContent,/owner must now return/);
  assert.doesNotMatch(panel().textContent,/Internal pilot preparation recorded/);
});
test('operator recovery rejects a wrong session actor and has no approval control',async()=>{
  responder=async(url)=>response(url.includes('recovery=owner')?{...recoveryReview(),actor_user_id:'other-auth'}:review());
  await openRecovery();assert.match(panel().textContent,/recovery response could not be verified/);assert.equal(button('Approve sign-in recovery'),undefined);
});
test('operator logout/login clears recovery consent and ignores an in-flight approval receipt',async()=>{
  let finish;responder=async(url,init)=>init.method==='POST'?new Promise(resolve=>{finish=resolve;}):response(url.includes('recovery=owner')?recoveryReview():review());
  await openRecovery();await act(async()=>panel().querySelector('[type="checkbox"]').click());await click('Approve sign-in recovery');
  await act(async()=>{clearAuthSession();saveAuthSession({access_token:'new-operator-token',user:{id:'operator-auth'}});window.dispatchEvent(new window.Event('focus'));});await flush();
  await act(async()=>finish(response(recoveryApplied())));await flush();
  assert.doesNotMatch(panel().textContent,/Sign-in recovery recorded/);assert.equal(button('Approve sign-in recovery').disabled,true);
});
test('operator recovery client switch discards a delayed prior-client review',async()=>{
  let finish;responder=async(url)=>url.includes('recovery=owner')?new Promise(resolve=>{finish=resolve;}):response(review(url.includes('/b/')?'b':'a'));
  await openRecovery();await selectClient('b');await act(async()=>finish(response(recoveryReview())));await flush();
  assert.equal(button('Approve sign-in recovery'),undefined);assert.doesNotMatch(panel().textContent,/owner@proof.invalid/);
});

// FI-06: no section may sell fictitious credits, invent an allowance, or offer
// a preference that resets on reload. Every remaining active control has a
// durable consumer (the desktop keychain for own keys).
test('settings billing, notifications and AI show no control without a durable consumer', async () => {
  for (const section of ['billing', 'notifications']) {
    await mount({ section });
    const text = document.body.textContent;
    assert.match(text, /Not available yet/, section);
    assert.doesNotMatch(text, /Buy credits|1,284|62%|\$40|Per client file|Desktop alerts|Needs your decision/, section);
    assert.equal(document.querySelectorAll('button, input, select, [role="switch"]').length, 0, `${section} renders no inert control`);
    await act(async () => root.unmount()); root = null;
  }
  await mount({ section: 'ai' });
  assert.doesNotMatch(document.body.textContent, /Model policy|Economy — trim bulk work only/);
  assert.equal([...document.querySelectorAll('select')].filter(node => node.getAttribute('aria-label') === 'Harness').length, 0,
    'web session: the harness is a fact, not a choice that nothing consumes');
  assert.match(document.body.textContent, /Donna managed/);
  await act(async () => root.unmount()); root = null;
  window.donnaDesktop = { providerKeys: { status: async () => ({ providers: [] }), save: async () => ({ ok: true }), clear: async () => ({ ok: true }) } };
  await mount({ section: 'ai' });
  assert.equal([...document.querySelectorAll('select')].filter(node => node.getAttribute('aria-label') === 'Harness').length, 1,
    'desktop keychain present: own keys are a real choice');
});
