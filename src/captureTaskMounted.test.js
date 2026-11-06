import test, { before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

let dom, directory, root, createRoot, responder, calls, sequence=0;
const names=['window','document','navigator','localStorage','HTMLElement','MutationObserver','FileReader','IS_REACT_ACT_ENVIRONMENT','fetch'];
const originals=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
const flush=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent===text);
const click=async text=>{assert.ok(button(text),text);await act(async()=>button(text).click());await flush();};
const input=async (selector,value)=>act(async()=>{
  const node=document.querySelector(selector);assert.ok(node,selector);
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(node,value);
  node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
});
before(async()=>{
  directory=await mkdtemp(resolve('.capture-mounted-'));
  await writeFile(`${directory}/entry.jsx`, `export { default as Page } from '../src/components/inventory/CaptureTaskPage.jsx'; export { default as Assignment } from '../src/components/inventory/CaptureTaskAssignment.jsx';`);
  await build({entryPoints:[`${directory}/entry.jsx`],outfile:`${directory}/mounted.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',loader:{'.css':'empty'},
    define:{'import.meta.env':'{"VITE_SUPABASE_URL":"https://identity.invalid","VITE_SUPABASE_PUBLISHABLE_KEY":"fixture"}'},logLevel:'silent'});
});
beforeEach(async()=>{
  dom=new JSDOM('<div id="root"></div>',{url:'https://books.invalid/capture#invitation=one-use-secret',pretendToBeVisual:true});calls=[];
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,FileReader:dom.window.FileReader,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  ({createRoot}=await import('react-dom/client'));
  globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),...init});return responder(String(url),init);};
});
afterEach(async()=>{if(root)await act(async()=>root.unmount());root=null;dom.window.close();for(const[key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
after(async()=>rm(directory,{recursive:true,force:true}));
const mount=async(component='Page',props={},strict=false)=>{
  const exported=await import(`${pathToFileURL(`${directory}/mounted.mjs`)}?case=${sequence++}`);
  root=createRoot(document.getElementById('root'));await act(async()=>root.render(strict?React.createElement(React.StrictMode,null,React.createElement(exported[component],props)):React.createElement(exported[component],props)));await flush();
};
const saveSession=(token='worker',email='worker@books.invalid')=>localStorage.setItem('donna.auth_session.v1',JSON.stringify({access_token:token,refresh_token:'refresh',user:{id:'worker-user',email}}));
const view={taskId:'task',name:'Shelf count',csrf:'csrf',items:[{lineId:'1',sku:'SKU1',name:'Box',unit:'EA',location:'Shelf',received:false}],permissions:['upload_photo','submit_count']};

test('mounted capture strips secret immediately, refreshes existing expired identity, and hides the financial shell',async()=>{
  saveSession('expired'); let exchangeCalls=0;
  responder=async(url,init)=>{
    if(url.startsWith('https://identity.invalid/'))return response({access_token:'fresh',refresh_token:'next',user:{id:'worker-user',email:'worker@books.invalid'}});
    if(url.endsWith('/exchange')){exchangeCalls++;assert.equal(JSON.parse(init.body).invitation,'one-use-secret');return exchangeCalls===1?response({code:'CAPTURE_PERSON_REQUIRED'},401):response({taskId:'task',csrf:'csrf'});}
    return response(view);
  };
  await mount();assert.equal(window.location.hash,'');assert.equal(calls.length,0,'GET/preview never exchanges');
  await act(async()=>document.querySelector('input[type=checkbox]').click());await click('Open my assigned task');
  assert.equal(exchangeCalls,2);assert.equal(calls.filter(call=>call.url.startsWith('https://identity.invalid/')).length,1);
  assert.equal(calls.findLast(call=>call.url.endsWith('/exchange')).headers.Authorization,'Bearer fresh');
  assert.equal(window.location.search,'?task=task');assert.match(document.body.textContent,/Box/);
  assert.doesNotMatch(document.body.textContent,/Expected|Valuation|Ledger|Financial|Accounting/);
});
test('wrong stored account can switch before one-use exchange',async()=>{
  saveSession('wrong','wrong@books.invalid');
  responder=async(url,init)=>url.startsWith('https://identity.invalid/')
    ? response({access_token:'worker',refresh_token:'refresh',user:{email:'worker@books.invalid'}})
    : url.endsWith('/exchange') ? (assert.equal(init.headers.Authorization,'Bearer worker'),response({taskId:'task'})) : response(view);
  await mount();assert.match(document.body.textContent,/wrong@books.invalid/);
  await click('Use a different account');await input('input[type=email]','worker@books.invalid');await input('input[type=password]','fixture-password');
  await act(async()=>document.querySelector('input[type=checkbox]').click());await click('Open my assigned task');
  assert.match(document.body.textContent,/Box/);assert.equal(calls.filter(call=>call.url.endsWith('/exchange')).length,1);
});
test('mounted photo/count retry retains admitted evidence and exact request identity, with acknowledgment only',async()=>{
  window.history.replaceState(null,'','/capture?task=task');let countAttempts=0, received=false;
  responder=async(url,init)=>{
    if(url.endsWith('/uploads'))return response({received:true,evidence:{documentId:'photo',checksum:'digest'}});
    if(url.endsWith('/responses')){countAttempts++;if(countAttempts===1)throw new Error('Connection interrupted');received=true;return response({received:true,lineId:'1'});}
    return response({...view,items:[{...view.items[0],received}]});
  };
  await mount();await input('input[type=number]','8');
  const file=document.querySelector('input[type=file]');await act(async()=>{Object.defineProperty(file,'files',{configurable:true,value:[new dom.window.File(['photo'],'stock.png',{type:'image/png'})]});file.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  const send=async()=>{await act(async()=>file.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await flush();await flush();};
  await send();assert.match(document.body.textContent,/Connection interrupted/);await send();
  const counts=calls.filter(call=>call.url.endsWith('/responses'));assert.equal(counts.length,2);assert.equal(counts[0].body,counts[1].body);
  assert.equal(calls.filter(call=>call.url.endsWith('/uploads')).length,1);
  assert.equal(counts[0].headers['X-Donna-Capture-CSRF'],'csrf');assert.equal(counts[0].headers.Authorization,undefined);
  assert.match(document.body.textContent,/Count received/);assert.doesNotMatch(document.body.textContent,/expected|variance|journal|valuation/i);
});
test('revoked/expired reconnect clears task scope and names a new invitation; completed task exposes acknowledgment only',async()=>{
  window.history.replaceState(null,'','/capture?task=task');let expired=false;
  responder=async()=>expired?response({code:'CAPTURE_CREDENTIAL_REFUSED'},403):response(view);
  await mount();assert.match(document.body.textContent,/Box/);expired=true;await click('Refresh task access');
  assert.doesNotMatch(document.body.textContent,/Box|SKU1/);assert.match(document.body.textContent,/expired or was revoked/);
  await act(async()=>root.unmount());root=null;
  responder=async()=>response({taskId:'task',completed:true,items:[],permissions:[]});await mount();
  assert.match(document.body.textContent,/task is complete/);assert.equal(document.querySelector('input[type=file]'),null);
});
test('assignment mounts only for explicit enrollment and emits a fragment invitation without sending messages',async()=>{
  let assigned=false;
  responder=async(url,init)=>{
    if(url.includes('/invitation'))return response({taskId:'task',invitation:'secret'});
    if(init.method==='POST'){assigned=true;return response({taskId:'task'});}
    return response({workers:[{principalType:'firm_collaborator',principalId:'worker',name:'Worker'}],tasks:assigned?[{id:'task',name:'Inventory count',principal_id:'worker'}]:[]});
  };
  await mount('Assignment',{firmId:'f',clientId:'c',sessionId:'1'});
  const select=document.querySelector('select');await act(async()=>{select.value='firm_collaborator:worker';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  await act(async()=>document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await flush();await flush();
  assert.equal(document.querySelector('input[readonly]').value,'https://books.invalid/capture#invitation=secret');
  assert.ok(calls.every(call=>call.url.startsWith('/api/donna/physical/tasks')));
});

test('initial consumed-task read offers retry with progress and prevents overlapping clicks', async()=>{
  window.history.replaceState(null,'','/capture?task=task');let attempts=0, release;
  responder=async()=>{attempts++;if(attempts===1)return response({},503);await new Promise(resolve=>{release=resolve;});return response(view);};
  await mount();assert.ok(button('Retry loading task'));assert.match(document.body.textContent,/could not be completed/);
  await click('Retry loading task');assert.ok(button('Checking…').disabled);assert.match(document.body.textContent,/Checking task access/);
  await act(async()=>{release();});await flush();assert.match(document.body.textContent,/Box/);assert.equal(attempts,2);
});
test('transient progress read failure preserves form identity until access is checked again',async()=>{
  window.history.replaceState(null,'','/capture?task=task');let reads=0, counts=0;
  responder=async(url)=>{
    if(url.endsWith('/uploads'))return response({evidence:{documentId:'photo',checksum:'digest'}});
    if(url.endsWith('/responses')){counts++;throw new Error('Lost response');}
    reads++;return reads===2?response({},503):response(view);
  };
  await mount();await input('input[type=number]','8');
  const file=document.querySelector('input[type=file]');await act(async()=>{Object.defineProperty(file,'files',{value:[new dom.window.File(['photo'],'stock.png',{type:'image/png'})]});file.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  await act(async()=>file.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await flush();await flush();
  await click('Refresh task access');assert.equal(document.querySelector('input[type=file]'),file,'same form retains file and retry keys');
  assert.ok(button('Confirm count and send').disabled);assert.equal(document.querySelector('input[type=number]').value,'8');
  await click('Refresh task access');await act(async()=>file.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await flush();await flush();
  const requests=calls.filter(call=>call.url.endsWith('/responses'));assert.equal(counts,2);assert.equal(requests[0].body,requests[1].body);
  assert.equal(calls.filter(call=>call.url.endsWith('/uploads')).length,1);
});
test('oversized and unsupported photos are rejected on selection before encoding or upload; valid neighbor sends',async()=>{
  window.history.replaceState(null,'','/capture?task=task');
  responder=async(url)=>url.endsWith('/uploads')?response({evidence:{documentId:'photo',checksum:'digest'}}):url.endsWith('/responses')?response({received:true}):response(view);
  await mount();await input('input[type=number]','10');
  const file=document.querySelector('input[type=file]');
  const choose=async selected=>act(async()=>{Object.defineProperty(file,'files',{configurable:true,value:[selected]});file.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  for(const selected of [new dom.window.File([new Uint8Array(2*1024*1024+1)],'big.png',{type:'image/png'}),new dom.window.File(['pdf'],'file.pdf',{type:'application/pdf'})]){
    await choose(selected);assert.match(document.body.textContent,/up to 2 MB/);assert.ok(button('Confirm count and send').disabled);
    await act(async()=>file.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await flush();
    assert.equal(calls.filter(call=>call.method==='POST').length,0);
  }
  await choose(new dom.window.File(['photo'],'stock.png',{type:'image/png'}));assert.equal(button('Confirm count and send').disabled,false);
  await act(async()=>file.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await flush();await flush();assert.equal(calls.filter(call=>call.url.endsWith('/uploads')).length,1);
});
test('assignment catalog failure has a retry consumer; disabled access still stays absent',async()=>{
  let reads=0;responder=async()=>++reads===1?response({},503):response({workers:[],tasks:[]});
  await mount('Assignment',{firmId:'f',clientId:'c',sessionId:'1'});await click('Retry loading assignments');assert.ok(document.querySelector('aside[aria-label="Assign capture task"]'));assert.equal(reads,2);
  await act(async()=>root.unmount());root=null;responder=async()=>response({code:'CAPTURE_DISABLED'},403);
  await mount('Assignment',{firmId:'f',clientId:'c',sessionId:'1'});assert.equal(document.querySelector('aside'),null);
});
test('truncated successful task reply stays recoverable instead of mounting invalid progress',async()=>{
  window.history.replaceState(null,'','/capture?task=task');let reads=0;
  responder=async()=>++reads===1?new Response('{"taskId":', {status:200}):response(view);
  await mount();assert.match(document.body.textContent,/response could not be read/);assert.equal(document.querySelector('article'),null);
  await click('Retry loading task');assert.match(document.body.textContent,/Box/);assert.equal(reads,2);
});
test('replacement invitation in the same document is stripped and replaces consumed task access before exchange',async()=>{
  window.history.replaceState(null,'','/capture?task=task');saveSession();
  responder=async(url,init)=>url.endsWith('/exchange')?(assert.equal(JSON.parse(init.body).invitation,'replacement-secret'),response({taskId:'new-task'})):response(view);
  await mount();assert.match(document.body.textContent,/Box/);
  await act(async()=>{window.location.hash='invitation=replacement-secret';window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});await flush();
  assert.equal(window.location.hash,'');assert.equal(window.location.search,'');assert.equal(document.querySelector('article'),null);
  assert.equal(calls.filter(call=>call.url.endsWith('/exchange')).length,0);
  await act(async()=>document.querySelector('input[type=checkbox]').click());await click('Open my assigned task');
  assert.equal(window.location.search,'?task=new-task');assert.match(document.body.textContent,/Box/);
});
test('old submission completion cannot refresh access after a replacement invitation, including the same task',async()=>{
  window.history.replaceState(null,'','/capture?task=task');saveSession();let release, submitted;
  const entered=new Promise(resolve=>{submitted=resolve;});
  responder=async(url)=>url.endsWith('/exchange')?response({taskId:'task'}):url.endsWith('/uploads')?response({evidence:{documentId:'photo',checksum:'digest'}}):url.endsWith('/responses')?(submitted(),await new Promise(resolve=>{release=()=>resolve(response({received:true}));})):response(view);
  await mount();await input('input[type=number]','8');const file=document.querySelector('input[type=file]');
  await act(async()=>{Object.defineProperty(file,'files',{value:[new dom.window.File(['photo'],'stock.png',{type:'image/png'})]});file.dispatchEvent(new dom.window.Event('change',{bubbles:true}));file.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
  // Submit after selection state settles.
  await act(async()=>file.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await entered;
  await act(async()=>{window.location.hash='invitation=new-secret';window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});await flush();
  assert.equal(document.querySelector('article'),null);assert.ok(button('Open my assigned task'));
  await act(async()=>document.querySelector('input[type=checkbox]').click());await click('Open my assigned task');
  const reads=calls.filter(call=>call.url.endsWith('/tasks/task')).length;
  await act(async()=>release());await flush();assert.match(document.body.textContent,/Box/);
  assert.equal(calls.filter(call=>call.url.endsWith('/tasks/task')).length,reads,'stale submission cannot read even after the same task is reissued');
});
test('replacing an in-flight exchange aborts its transport and ignores its late result',async()=>{
  saveSession();let release;responder=async(url,init)=>url.endsWith('/exchange')&&JSON.parse(init.body).invitation==='one-use-secret'
    ?await new Promise(resolve=>{release=()=>resolve(response({taskId:'old-task'}));}):url.endsWith('/exchange')?response({taskId:'new-task'}):response(view);
  await mount();await act(async()=>document.querySelector('input[type=checkbox]').click());await click('Open my assigned task');
  const old=calls.find(call=>call.url.endsWith('/exchange'));assert.equal(old.signal.aborted,false);
  await act(async()=>{window.location.hash='invitation=new-secret';window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});await flush();assert.equal(old.signal.aborted,true);
  await act(async()=>document.querySelector('input[type=checkbox]').click());await click('Open my assigned task');
  await act(async()=>release());await flush();assert.equal(window.location.search,'?task=new-task');assert.match(document.body.textContent,/Box/);
});

test('Strict Mode effect replay reloads consumed task access without invalidating its generation',async()=>{
  window.history.replaceState(null,'','/capture?task=task');responder=async()=>response(view);
  await mount('Page',{},true);assert.match(document.body.textContent,/Box/);
  assert.equal(button('Confirm count and send').disabled,true);
  await click('Refresh task access');assert.match(document.body.textContent,/Box/);
  assert.equal(button('Refresh task access').disabled,false);
});
