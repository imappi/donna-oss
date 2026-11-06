import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
let dom, directory, createRoot, CloudPilotReadinessCard, LocaleProvider, root;
let calls, responder, deadlines;
const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const originals = new Map(['window','document','navigator','localStorage','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT','fetch','setTimeout','clearTimeout']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const unusedReview = (id = 'a') => ({ firm_id: 'f', client_id: id, actor_id: 'member', client_version: id.repeat(64),
  profile: { companyName: `Synthetic ${id} Oy`, accountingBasis: '' }, configuration: [], processing_readiness: 'INCOMPLETE' });
const receipt = (id = 'a') => ({ firm_id: 'f', client_id: id, actor_id: 'member', processing_readiness: 'INCOMPLETE',
  authority_basis: 'explicit_internal_pilot_setup', profile: { companyName: `Synthetic ${id} Oy`, accountingBasis: 'accrual' } });
const flush = async () => act(async () => { await new Promise(resolve => realTimeout(resolve, 15)); });
const panel = () => document.querySelector('section[aria-label="Hosted pilot readiness"]');
const review = (id='a') => ({firm_id:'f',client_id:id,actor_id:'member',review_digest:'review-'+id,host_ready:true,entity_ready:false,checks:[],changes:[]});
const button = label => [...panel().querySelectorAll('button')].find(node => node.textContent === label);
const click = async label => { assert.ok(button(label)); await act(async () => button(label).click()); await flush(); };
const change = async (node, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(node instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new window.Event(node instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
};
const selectClient = async id => change(document.querySelector('select[aria-label="Hosted pilot readiness"]'), id);
const mount = async (props = {}) => {
  calls = []; deadlines = new Map();
  responder ||= async (url, init) => response(init.method === 'POST' ? receipt() : review());
  window.localStorage.clear();window.localStorage.setItem('donna.auth_session.v1',JSON.stringify({access_token:'token-one',user:{id:'one'}}));
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(LocaleProvider, null, React.createElement(CloudPilotReadinessCard, {
    firm: { id: 'f' }, clients: [{ id: 'a', companyName: 'Synthetic a Oy', jurisdiction: 'FI' }, { id: 'b', companyName: 'Synthetic b Oy', jurisdiction: 'FI' }], dataSource: 'database', ...props
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
    if (!String(url).includes('/cloud-pilot/')) return response({ database_configured: true, enabled: false, clients: [], items: [] });
    calls.push({ url: String(url), ...init });
    return responder(String(url), init);
  };
  directory = await mkdtemp(resolve('.pilot-settings-test-'));
  await build({ stdin: { contents: "export { default as CloudPilotReadinessCard } from './src/components/settings/CloudPilotReadinessCard.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx';", resolveDir: process.cwd() },
    outfile: `${directory}/mounted.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
    loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
  ({ CloudPilotReadinessCard, LocaleProvider } = await import(pathToFileURL(`${directory}/mounted.mjs`)));
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


test('mounted processing review requires scoped confirmation and validates apply receipt',async()=>{
 await mount();await selectClient('a');await click('Refresh readiness review');
 assert.equal(button('Apply reviewed processing settings').disabled,true);
 await act(async()=>panel().querySelector('[type="checkbox"]').click());
 responder=async()=>response({...review(),entity_state:'INCOMPLETE',configuration_staged:true});
 await click('Apply reviewed processing settings');
 assert.deepEqual(JSON.parse(calls.find(c=>c.method==='POST').body),{firm_id:'f',review_digest:'review-a',confirmed:true});
 assert.match(panel().textContent,/Entity readiness: INCOMPLETE/);
 assert.equal(button('Apply reviewed processing settings'),undefined);
});
test('switching client aborts pending review and never mounts its late result',async()=>{
 let finish;responder=()=>new Promise(r=>finish=r);
 await mount();await selectClient('a');await click('Refresh readiness review');
 const signal=calls[0].signal;await selectClient('b');assert.equal(signal.aborted,true);
 await act(async()=>finish(response(review('a'))));await flush();
 assert.equal(button('Apply reviewed processing settings'),undefined);
});
for (const changeKind of ['different user','token loss']) test(`same firm/client clears review and consent on ${changeKind}`,async()=>{
 await mount();await selectClient('a');await click('Refresh readiness review');
 await act(async()=>panel().querySelector('[type="checkbox"]').click());
 await act(async()=>{
  if(changeKind==='token loss')window.localStorage.removeItem('donna.auth_session.v1');
  else window.localStorage.setItem('donna.auth_session.v1',JSON.stringify({access_token:'token-two',user:{id:'two'}}));
  window.dispatchEvent(new window.Event('storage'));
 });await flush();
 assert.equal(button('Apply reviewed processing settings'),undefined);
 assert.equal(panel().querySelector('[type="checkbox"]'),null);
 assert.equal(calls.filter(c=>c.method==='POST').length,0);
});
test('session change while review is pending aborts and discards the old operator response',async()=>{
 let finish;responder=()=>new Promise(r=>finish=r);
 await mount();await selectClient('a');await click('Refresh readiness review');const signal=calls[0].signal;
 await act(async()=>{window.localStorage.removeItem('donna.auth_session.v1');window.dispatchEvent(new window.Event('focus'));});
 assert.equal(signal.aborted,true);await act(async()=>finish(response(review())));await flush();
 assert.equal(button('Apply reviewed processing settings'),undefined);
});
test('a mismatched response cannot expose processing action',async()=>{
 responder=async()=>response(review('foreign'));await mount();await selectClient('a');await click('Refresh readiness review');
 assert.ok(panel().querySelector('[role="alert"]'));assert.equal(button('Apply reviewed processing settings'),undefined);
});

// Kari, 2026-09-23: hosted readiness is runtime operation, not owner work. It
// is mounted only at the operator route, never in owner Settings.
test('hosted readiness is mounted at /firms/operator and not in owner Settings',async()=>{
 const settings=await readFile(resolve('src/components/settings/SettingsPanel.jsx'),'utf8');
 const app=await readFile(resolve('src/App.jsx'),'utf8');
 assert.doesNotMatch(settings,/CloudPilotReadinessCard/);
 assert.match(app,/getCurrentPath\(\)\.startsWith\('\/firms\/operator'\)[\s\S]{0,400}<CloudPilotReadinessCard/);
});

// Receipted exit from pilot send containment: review, explicit consent, one
// POST bound to the reviewed digest; a release never renders as a send.
const sendPanel = () => document.querySelector('section[aria-label="Owner question sending"]');
const sendButton = label => [...sendPanel().querySelectorAll('button')].find(node => node.textContent === label);
const sendReview = (id='a', extra={}) => ({firm_id:'f',client_id:id,actor_id:'member',review_digest:'d'.repeat(64),enrolled:true,contained:true,release:null,
  draft_batches:[{id:'batch-1',subject:'Questions about February',created_at:'2026-09-20T10:00:00.000Z',item_count:2,document_ask_count:1}],
  draft_batches_truncated:false,draft_owner_questions:4,after_release:{owner_email_asks:false,firm_auto_send_client_asks:false,delivery_channels_changed:false},...extra});
test('mounted send release shows held drafts, requires consent and validates the receipt',async()=>{
 responder=async(url,init)=>response(url.includes('/send-release')
   ? {firm_id:'f',client_id:'a',actor_id:'member',receipt_id:41,contained:false,sends_performed:false}
   : sendReview());
 await mount();await selectClient('a');
 await act(async()=>sendButton('Review question sending').click());await flush();
 assert.match(sendPanel().textContent,/held as drafts/);
 assert.match(sendPanel().textContent,/Drafted question messages: 1\. Owner questions not yet sent: 4\./);
 assert.match(sendPanel().textContent,/Questions about February · 3 questions/);
 assert.match(sendPanel().textContent,/Email questions to the owner: off/);
 assert.equal(sendButton('Release question sending').disabled,true);
 await act(async()=>sendPanel().querySelector('[type="checkbox"]').click());
 await act(async()=>sendButton('Release question sending').click());await flush();
 const post=calls.find(c=>c.method==='POST');
 assert.match(post.url,/\/cloud-pilot\/send-release\?/);
 assert.deepEqual(JSON.parse(post.body),{firm_id:'f',review_digest:'d'.repeat(64),confirmed:true});
 assert.match(sendPanel().textContent,/Question sending released\. Receipt 41\./);
 assert.equal(sendButton('Release question sending'),undefined);
});
test('mounted send release rejects a receipt that does not prove release',async()=>{
 responder=async(url)=>response(url.includes('/send-release')?{firm_id:'f',client_id:'a',actor_id:'member',contained:true}:sendReview());
 await mount();await selectClient('a');
 await act(async()=>sendButton('Review question sending').click());await flush();
 await act(async()=>sendPanel().querySelector('[type="checkbox"]').click());
 await act(async()=>sendButton('Release question sending').click());await flush();
 assert.ok(sendPanel().querySelector('[role="alert"]'));
 assert.doesNotMatch(sendPanel().textContent,/released\. Receipt/);
});
test('a released client shows who released it and offers no release action',async()=>{
 responder=async()=>response(sendReview('a',{contained:false,release:{receipt_id:9,actor_id:'member',released_at:'2026-09-23T08:00:00.000Z'}}));
 await mount();await selectClient('a');
 await act(async()=>sendButton('Review question sending').click());await flush();
 assert.match(sendPanel().textContent,/released by member/);
 assert.equal(sendButton('Release question sending'),undefined);
 assert.equal(sendPanel().querySelector('[type="checkbox"]'),null);
});

test('a US hosted pilot client can reach the send release; the Finnish processing review stays Finnish (2026-10-01)',async()=>{
 await mount({clients:[{id:'a',companyName:'Synthetic a Oy',jurisdiction:'FI'},{id:'us',companyName:'Synthetic US LLC',jurisdiction:'US'},{id:'sg',companyName:'Synthetic SG',jurisdiction:'SG'}]});
 const options=[...document.querySelectorAll('select[aria-label="Hosted pilot readiness"] option')].map(o=>o.value).filter(Boolean);
 assert.deepEqual(options,['a','us'],'SG review clients are not offered');
 await selectClient('us');
 assert.equal(panel(),null,'no Finnish processing review for a US client');
 await selectClient('a');
 assert.ok(panel()&&button('Refresh readiness review'));
});
