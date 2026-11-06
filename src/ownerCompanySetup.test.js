import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
let dom, directory, root, createRoot, Gate, LocaleProvider, calls, responder, states;
const saved = new Map(['window','document','navigator','localStorage','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
const response = (body,status=200) => new Response(JSON.stringify(body),{status});
const flush = () => act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
const unknown = () => ({billing_enabled:true,entitled:false,company_setup_required:true,pilot_pending:false,jurisdiction:null,owner_email:'a@fixture.invalid'});
const pending = () => ({...unknown(),company_setup_required:false,pilot_pending:true,jurisdiction:'FI',company_name:'Real Fixture Oy'});
const login = id => localStorage.setItem('donna.auth_session.v1',JSON.stringify({access_token:`token-${id}`,user:{id,email:`${id}@fixture.invalid`}}));
const button = label => [...document.querySelectorAll('button')].find(node=>node.textContent===label);
const click = async label => {await act(async()=>button(label).click());await flush();};
const change = async (node,value) => {await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new window.Event('input',{bubbles:true}));});await flush();};
const render = async(id='a') => {await act(async()=>root.render(React.createElement(LocaleProvider,null,React.createElement(Gate,{clientId:id},React.createElement('p',{'data-testid':'books'},`Books ${id}`)))));await flush();};
const mount = async({offer=false}={}) => {
  calls=[];states={a:unknown(),b:pending()};login('a');
  if(offer)localStorage.setItem('donna.pending_offer.v1',JSON.stringify({kind:'recurring',bandId:'small'}));
  responder ||= async(url,init)=>{
    if(url.includes('/billing/status'))return response(states[new URL(url,'http://localhost').searchParams.get('client_id')]);
    if(url.includes('/profile')){states.a=pending();return response({client_id:'a',company_setup_saved:true});}
    if(url.includes('/billing/checkout'))return response({error:'fixture checkout unavailable'},503);
    return response({});
  };
  root=createRoot(document.getElementById('root'));await render();
};
const fill = async()=>{await change(document.querySelector('input:not([type])'),'Real Fixture Oy');await change(document.querySelector('input[type="date"]'),'2010-05-12');await act(async()=>document.querySelector('input[type="checkbox"]').click());};
before(async()=>{
  dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/client/a',pretendToBeVisual:true});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  ({createRoot}=await import('react-dom/client'));
  globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),...init});return responder(String(url),init);};
  directory=await mkdtemp(resolve('.owner-setup-test-'));
  await build({stdin:{contents:"export {default as Gate} from './src/components/ClientPortalGate.jsx';export {LocaleProvider} from './src/i18n/LocaleProvider.jsx';",resolveDir:process.cwd()},outfile:`${directory}/mounted.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env':'{}'},logLevel:'silent'});
  ({Gate,LocaleProvider}=await import(pathToFileURL(`${directory}/mounted.mjs`)));
});
afterEach(async()=>{if(root)await act(async()=>root.unmount());root=null;responder=null;localStorage.clear();document.body.innerHTML='<div id="root"></div>';});
after(async()=>{dom?.window.close();for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}if(directory)await rm(directory,{recursive:true,force:true});});

test('fresh unknown owner saves confirmed real FI facts without checkout, then refreshes after operator activation',async()=>{
  await mount({offer:true});assert.match(document.body.textContent,/Set up your Finnish pilot company/);assert.equal(document.querySelector('input[type="date"]').value,'');
  assert.equal(button('Save company details').disabled,true);assert.equal(document.querySelector('[data-testid="books"]'),null);
  await fill();await click('Save company details');
  const write=calls.find(call=>call.url.includes('/profile'));
  assert.deepEqual(JSON.parse(write.body),{owner_setup:true,profile_patch:{companyName:'Real Fixture Oy',jurisdiction:'FI',entityType:'fi-oy',incorporation_date:'2010-05-12'}});
  assert.match(document.body.textContent,/waiting for activation/);assert.match(document.body.textContent,/Real Fixture Oy/);assert.equal(calls.some(call=>call.url.includes('/checkout')),false);
  states.a={...pending(),entitled:true,pilot_pending:false};await click('Check setup status');assert.match(document.body.textContent,/Books a/);
});
test('already identified FI pending owner sees activation guidance and no purchase, even with a stashed offer',async()=>{
  responder=async()=>response({...pending(),billing_enabled:false,entitled:true});await mount({offer:true});assert.match(document.body.textContent,/waiting for activation/);assert.equal(document.querySelector('form'),null);assert.equal(calls.some(call=>call.url.includes('/checkout')),false);
});
test('genuinely entitled legacy owner retains books despite incomplete company identity',async()=>{
  responder=async()=>response({...unknown(),entitled:true,company_setup_required:false});
  await mount({offer:true});
  assert.match(document.body.textContent,/Books a/);
  assert.equal(document.querySelector('form'),null);
  assert.equal(calls.some(call=>call.url.includes('/checkout')),false);
});
test('billing-disabled unknown company still needs actual identity, while known GB never starts checkout (owner checkout retired 2026-10-21)',async()=>{
  responder=async(url)=>response({...unknown(),billing_enabled:false,entitled:true});await mount();assert.ok(document.querySelector('form'));
  await act(async()=>root.unmount());root=null;localStorage.clear();responder=async(url)=>url.includes('/billing/status')?response({billing_enabled:true,entitled:false,jurisdiction:'GB',company_setup_required:false,pilot_pending:false}):response({error:'fixture checkout unavailable'},503);
  await mount({offer:true});assert.equal(calls.filter(call=>call.url.includes('/checkout')).length,0);assert.equal(document.querySelector('form'),null);
  assert.match(document.body.textContent,/Your accounting firm gives you access/);assert.equal(document.querySelectorAll('button').length,0,'no purchase button');
  assert.equal(localStorage.getItem('donna.pending_offer.v1'),null,'a stashed offer is dropped, never redeemed');
});
test('an earlier customer can still manage billing, and nothing can be bought',async()=>{
  responder=async(url)=>url.includes('/billing/status')?response({billing_enabled:true,entitled:false,jurisdiction:'GB',company_setup_required:false,pilot_pending:false,has_customer:true}):response({url:''});
  await mount();assert.match(document.body.textContent,/Your plan is inactive/);assert.ok(button('Manage billing'));
  assert.equal([...document.querySelectorAll('button')].length,1);assert.equal(calls.some(call=>call.url.includes('/checkout')),false);
});
test('late status from previous client cannot display its books or trigger checkout for the next company',async()=>{
  let finish;responder=async url=>url.includes('client_id=a')?new Promise(resolve=>{finish=resolve;}):response(pending());
  await mount({offer:true});await render('b');assert.match(document.body.textContent,/waiting for activation/);
  await act(async()=>finish(response({billing_enabled:true,entitled:false,jurisdiction:'GB'})));await flush();
  assert.match(document.body.textContent,/waiting for activation/);assert.equal(calls.some(call=>call.url.includes('/checkout')),false);
});
test('switching client during save drops old form completion and preserves the new client',async()=>{
  let finish;responder=async(url,init)=>url.includes('/profile')?new Promise(resolve=>{finish=resolve;}):response(url.includes('client_id=a')?unknown():pending());
  await mount();await fill();await act(async()=>document.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await flush();await render('b');
  const before=calls.filter(call=>call.url.includes('client_id=b')).length;
  await act(async()=>finish(response({company_setup_saved:true})));await flush();
  assert.equal(calls.filter(call=>call.url.includes('client_id=b')).length,before);assert.match(document.body.textContent,/waiting for activation/);
});
test('account switch aborts old save and resets entered identity without replaying it as the new user',async()=>{
  let finish;responder=async(url,init)=>url.includes('/profile')?new Promise(resolve=>{finish=resolve;}):response({...unknown(),owner_email:init.headers.Authorization==='Bearer token-b'?'b@fixture.invalid':'a@fixture.invalid'});
  await mount();await fill();await act(async()=>document.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await flush();
  await act(async()=>{login('b');window.dispatchEvent(new window.Event('focus'));});await flush();
  assert.equal(document.querySelector('input:not([type])').value,'');assert.match(document.body.textContent,/b@fixture.invalid/);
  await act(async()=>finish(response({company_setup_saved:true})));await flush();
  assert.equal(calls.filter(call=>call.url.includes('/profile')).length,1);assert.equal(document.querySelector('input:not([type])').value,'');
});
test('an account changed before submit cannot send the old form under the next identity',async()=>{
  await mount();await fill();login('b');await click('Save company details');
  assert.equal(calls.some(call=>call.url.includes('/profile')),false);assert.equal(document.querySelector('input:not([type])').value,'');
});
test('failed save stays unconfirmed and allows a deliberate retry',async()=>{
  let fail=true;responder=async(url)=>url.includes('/profile')?response(fail?{error:'Save unavailable'}:{company_setup_saved:true},fail?503:200):response(unknown());
  await mount();await fill();await click('Save company details');assert.match(document.body.textContent,/Save unavailable/);assert.equal(document.querySelector('[data-testid="books"]'),null);
  fail=false;await click('Save company details');assert.equal(calls.filter(call=>call.url.includes('/profile')).length,2);
});
