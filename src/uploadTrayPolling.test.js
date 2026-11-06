import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

let dom, directory, createRoot, root, UploadTray, LocaleProvider, tray;
let timers, requests, responder, invalidations, registrationResponder, retryResponder;
const realTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const originals = new Map(['window', 'document', 'navigator', 'localStorage', 'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'setTimeout', 'clearTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const response = documents => new Response(JSON.stringify({ documents }), { status: 200 });
const remote = (status = 'processing', id = 'doc-a') => ({ id, parse_status: status, parse_stage: 'extracting' });
const flush = async () => act(async () => { await new Promise(resolve => realTimeout(resolve, 5)); });
const runTimers = async () => {
  const due = [...timers];
  await act(async () => { for (const [id, fn] of due) { if (timers.delete(id)) fn(); } });
  await flush();
};
const addRow = (name = 'a') => {
  tray.startTrayBatch({ batchId: `batch-${name}`, clientId: 'client-a', files: [{ name: `${name}.pdf` }] });
  tray.setRowUploaded({ rowId: `batch-${name}-0`, storageBucket: 'synthetic', storageObjectKey: name });
  tray.setRowRegistered({ rowId: `batch-${name}-0`, document: remote('processing', `doc-${name}`) });
};
const render = async (callback = async () => { invalidations += 1; }) => {
  await act(async () => root.render(React.createElement(LocaleProvider, null,
    React.createElement(UploadTray, { inline: true, onSnapshotInvalidated: callback }))));
  await flush();
};
const mount = async callback => {
  timers = new Map(); requests = []; invalidations = 0; registrationResponder = null;
  localStorage.clear();
  localStorage.setItem('donna.auth_session.v1', JSON.stringify({ access_token: 'synthetic-a', user: { id: 'a' } }));
  addRow();
  root = createRoot(document.getElementById('root'));
  await render(callback);
};
before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/client/client-a' });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import('react-dom/client'));
  // Control only the tray's cadence; React/Intl retain ordinary microtasks.
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (![1000, 2000, 6000, 15000].includes(ms)) return realTimeout(fn, ms, ...args);
    const id = {}; timers.set(id, () => fn(...args)); return id;
  };
  globalThis.clearTimeout = id => { if (!timers?.delete(id)) realClearTimeout(id); };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/documents/register')) {
      requests.push({ url: String(url), signal: options.signal, documents: JSON.parse(options.body).documents });
      assert.ok(registrationResponder, 'unexpected registration');
      return registrationResponder(options);
    }
    if (String(url).endsWith('/documents/retry-parse')) {
      requests.push({ url: String(url), method: options.method });
      assert.ok(retryResponder, 'unexpected retry');
      return retryResponder(options);
    }
    assert.match(String(url), /documents\/parse-status/, 'only existing document APIs may be called');
    requests.push({ url: String(url), signal: options.signal });
    return responder();
  };
  directory = await mkdtemp(resolve('.tray-polling-test-'));
  await build({ stdin: { contents: "export { default as UploadTray } from './src/components/UploadTray.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx'; export * as tray from './src/lib/uploadTray.js';", resolveDir: process.cwd() },
    outfile: `${directory}/mounted.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
  ({ UploadTray, LocaleProvider, tray } = await import(pathToFileURL(`${directory}/mounted.mjs`)));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; timers?.clear(); document.body.innerHTML = '<div id="root"></div>'; });
after(async () => { dom?.window.close(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } if (directory) await rm(directory, { recursive: true, force: true }); });

test('mounted tray polls one loop through state changes and stops refetching completed documents', async () => {
  responder = () => response([remote()]);
  await mount();
  assert.equal(requests.length, 1, 'mount revalidation');
  await runTimers();
  assert.equal(requests.length, 2, 'one ordinary poll');
  assert.equal(timers.size, 1, 'state update must not leave two polling generations alive');
  responder = () => response([remote('completed')]);
  await runTimers();
  assert.equal(invalidations, 1, 'one persisted completion causes one snapshot refresh');
  const completedRequests = requests.length;
  for (let i = 0; i < 5; i += 1) await runTimers();
  assert.equal(requests.length, completedRequests, 'completed files never re-enter polling through a stale closure');
  assert.equal(invalidations, 1);
});

test('a slow snapshot refresh cannot spawn another poll when progress updates or a new upload arrives', async () => {
  responder = () => response([remote()]);
  let finishSnapshot;
  await mount(() => { invalidations += 1; return new Promise(resolve => { finishSnapshot = resolve; }); });
  responder = () => response([remote('completed')]);
  await runTimers();
  assert.equal(invalidations, 1);
  await act(async () => addRow('b'));
  responder = () => response([remote('completed', 'doc-b')]);
  await runTimers();
  assert.equal(invalidations, 1, 'the existing tick still owns its awaited refresh');
  await act(async () => finishSnapshot());
  await runTimers();
  assert.equal(invalidations, 2, 'new work is picked up by the same loop after the first refresh');
  await act(async () => finishSnapshot());
  assert.equal(timers.size, 1);
});

test('a completion held behind a slow snapshot cannot be replayed by an abandoned polling closure', async () => {
  responder = () => response([remote()]);
  let finishSnapshot;
  await mount(() => {
    invalidations += 1;
    return invalidations === 1 ? new Promise(resolve => { finishSnapshot = resolve; }) : Promise.resolve();
  });
  responder = () => response([remote('completed')]);
  await runTimers();
  assert.equal(invalidations, 1);
  await runTimers();
  await act(async () => finishSnapshot());
  const terminalRequests = requests.length;
  for (let i = 0; i < 5; i += 1) await runTimers();
  assert.equal(requests.length, terminalRequests, 'the settled row is not fetched again after the slow snapshot completes');
  assert.equal(invalidations, 1);
  assert.equal(timers.size, 1);
});

test('a transient status error retries on the same cadence and a real completion still refreshes', async () => {
  responder = () => response([remote()]);
  await mount();
  responder = () => Promise.reject(new Error('synthetic network outage'));
  await runTimers();
  assert.equal(invalidations, 0);
  assert.equal(timers.size, 1);
  responder = () => response([remote('completed')]);
  await runTimers();
  assert.equal(invalidations, 1);
  assert.equal(tray.loadTrayState().batches[0].rows[0].parse_status, 'completed');
});

test('unmount during a parse response retires its effects and timer', async () => {
  responder = () => response([remote()]);
  await mount();
  let finish;
  responder = () => new Promise(resolve => { finish = resolve; });
  await runTimers();
  await act(async () => root.unmount()); root = null;
  await act(async () => finish(response([remote('completed')])));
  assert.equal(invalidations, 0);
  assert.equal(timers.size, 0, 'an obsolete async tick cannot resurrect itself');
  assert.equal(tray.loadTrayState().batches[0].rows[0].parse_status, 'processing');
});

test('an old principal response cannot mutate a new principal tray with the same row identity', async () => {
  responder = () => response([remote()]);
  await mount();
  let finish;
  responder = () => new Promise(resolve => { finish = resolve; });
  await runTimers();
  await act(async () => {
    localStorage.setItem('donna.auth_session.v1', JSON.stringify({ access_token: 'synthetic-b', user: { id: 'b' } }));
    addRow();
  });
  await act(async () => finish(response([remote('completed')])));
  assert.equal(invalidations, 0);
  assert.equal(tray.loadTrayState().batches[0].rows[0].parse_status, 'processing');
});

const addOrphan = (name = 'orphan') => {
  tray.startTrayBatch({ batchId: `batch-${name}`, clientId:'client-a', files:[{filename:`${name}.pdf`,document_type:'supplier_bill'}] });
  tray.setRowUploaded({rowId:`batch-${name}-0`,storageBucket:'synthetic',storageObjectKey:name,checksum:'a'.repeat(64),storedSize:3,mimeType:'application/pdf'});
  return `batch-${name}-0`;
};
const registeredOrphan = name => ({id:`doc-${name}`,client_id:'client-a',storage_bucket:'synthetic',storage_object_key:name,parse_status:'pending'});
const registrationRequests = () => requests.filter(item=>item.documents);

test('new registration failure recovers on the mounted page once, using the same key and no byte upload', async () => {
  responder=()=>response([remote()]); await mount();
  registrationResponder=()=>response([registeredOrphan('orphan')]);
  await act(async()=>{addOrphan();});
  assert.equal(registrationRequests().length,0,'do not race initial batch registration while a PUT just finished');
  await act(async()=>tray.setRowRegisterFailed({rowId:'batch-orphan-0',message:'Checking bytes timed out.'}));
  await flush();
  assert.equal(registrationRequests().length,1);
  assert.equal(registrationRequests()[0].documents[0].storage_object_key,'orphan');
  const row=tray.loadTrayState().batches.find(batch=>batch.id==='batch-orphan').rows[0];
  assert.equal(row.document_id,'doc-orphan');assert.equal(row.register_warning,null);
  await render(); await flush();
  assert.equal(registrationRequests().length,1,'ordinary renders never restart successful registration');
});

test('failed automatic registration stays actionable, explicit Retry coalesces clicks and succeeds without remount', async()=>{
  responder=()=>response([remote()]);await mount();
  registrationResponder=()=>new Response(JSON.stringify({error:'Checking bytes timed out.',code:'PILOT_UPLOAD_VERIFICATION_TIMEOUT'}),{status:503});
  await act(async()=>{addOrphan();tray.setRowRegisterFailed({rowId:'batch-orphan-0',message:'Checking bytes timed out.'});});await flush();
  assert.equal(registrationRequests().length,1);
  await render();await flush();assert.equal(registrationRequests().length,1,'failure notification cannot cause an infinite retry loop');
  assert.doesNotMatch(document.body.textContent,/will retry/i,'no promise of a nonexistent automatic attempt');
  let finish; registrationResponder=()=>new Promise(resolve=>{finish=resolve;});
  const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='Retry');
  assert.ok(button,'orphan has a real Retry consumer');
  await act(async()=>{button.click();button.click();});await flush();
  assert.equal(registrationRequests().length,2,'one current request despite repeated clicks');
  await act(async()=>finish(response([registeredOrphan('orphan')])));await flush();
  assert.equal(tray.loadTrayState().batches.find(batch=>batch.id==='batch-orphan').rows[0].document_id,'doc-orphan');
});

test('hanging registration has a bounded abort and does not automatically loop',async()=>{
  responder=()=>response([remote()]);await mount();
  registrationResponder=options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  await act(async()=>{addOrphan();tray.setRowRegisterFailed({rowId:'batch-orphan-0',message:'Retry required.'});});await flush();
  assert.equal(registrationRequests().length,1);
  await runTimers();
  assert.equal(registrationRequests()[0].signal.aborted,true);
  assert.ok(tray.loadTrayState().batches.find(batch=>batch.id==='batch-orphan').rows[0].register_warning);
  await runTimers();assert.equal(registrationRequests().length,1);
});

test('unmount or changed principal retires a delayed registration response',async()=>{
  responder=()=>response([remote()]);await mount();
  let finish;registrationResponder=()=>new Promise(resolve=>{finish=resolve;});
  await act(async()=>{addOrphan();tray.setRowRegisterFailed({rowId:'batch-orphan-0',message:'Retry required.'});});await flush();
  const pending=registrationRequests()[0];
  await act(async()=>root.unmount());root=null;
  assert.equal(pending.signal.aborted,true);
  localStorage.setItem('donna.auth_session.v1',JSON.stringify({access_token:'synthetic-b',user:{id:'b'}}));
  await act(async()=>finish(response([registeredOrphan('orphan')])));await flush();
  assert.equal(tray.loadTrayState().batches.length,0,'late response cannot populate the next principal tray');
  localStorage.setItem('donna.auth_session.v1',JSON.stringify({access_token:'synthetic-a',user:{id:'a'}}));
  assert.equal(tray.loadTrayState().batches.find(batch=>batch.id==='batch-orphan').rows[0].document_id,null,'unmounted response does not mutate original tray either');
});

// FI-05: injected storage, provider and database failures in the mounted
// client tray. Files stay listed, nothing technical reaches the customer, a
// held file is never re-requested, and a successful retry clears the state.
test('mounted tray shows customer states for storage, provider and database failures; a successful retry clears them', async () => {
  const LEAKS = /401|x-api-key|sk-live|API key|StorageApiError|row-level security|connection terminated|DOCUMENT_EXTRACTION|PROVIDER_|re-upload|Upload a/;
  responder = () => response([{ id: 'doc-a', parse_status: 'failed', parse_stage: null, parse_error: {
    code: 'DOCUMENT_EXTRACTION_UNAUTHORIZED', message: 'Error: 401 invalid x-api-key sk-live-123',
    safe_user_message: "The model provider rejected Donna's API key, so this document could not be read.", retryable: false, retry_owner: 'manual' } }]);
  await mount();
  tray.startTrayBatch({ batchId: 'batch-s', clientId: 'client-a', files: [{ name: 's.pdf' }] });
  tray.setRowUploadFailed({ rowId: 'batch-s-0', message: 'StorageApiError: new row violates row-level security policy' });
  await flush();
  const text = () => document.body.textContent;
  assert.match(text(), /a\.pdf.*Saved — taking longer than usual\. Nothing is needed from you\. Reference DOCA/s, 'provider failure: saved, with a reference');
  assert.match(text(), /s\.pdf.*Not uploaded — the file didn’t reach storage/s, 'storage failure: the file stays listed and is not claimed as saved');
  assert.doesNotMatch(text(), LEAKS);

  const retry = () => [...document.querySelectorAll('button')].find(node => node.textContent === 'Retry'
    && node.closest('li')?.textContent.includes('a.pdf'));
  retryResponder = () => new Response(JSON.stringify({ error: 'connection terminated unexpectedly', code: 'DB_CONNECTION_LOST' }), { status: 503 });
  await act(async () => retry().click()); await flush();
  assert.match(text(), /Something went wrong\. Try again or wait for it to refresh\./, 'database failure on retry: generic copy only');
  assert.doesNotMatch(text(), LEAKS);

  retryResponder = () => new Response(JSON.stringify({ ok: true, retried: ['doc-a'] }), { status: 200 });
  await act(async () => retry().click()); await flush();
  assert.doesNotMatch(text(), /taking longer|Something went wrong/, 'a successful retry clears the failure state');
  assert.equal(tray.loadTrayState().batches.flatMap(batch => batch.rows).find(row => row.row_id === 'batch-a-0').parse_status, 'pending');
});
