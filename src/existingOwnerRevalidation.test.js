import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
let dom, directory, createRoot, WorkspaceProvisioner, LocaleProvider, root, saveAuthSession, clearAuthSession;
let calls, responder, deadlines;
const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const originals = new Map(['window','document','navigator','localStorage','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT','fetch','setTimeout','clearTimeout']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const review = (actor = 'owner') => ({firm_id:'f',client_id:'c',actor_id:actor,owner_email:`${actor}@example.invalid`,company_name:'Existing Oy',
  jurisdiction:'FI',entity_type:'fi-oy',review_digest:'a'.repeat(64),processing_readiness:'INCOMPLETE',purpose:'existing_empty_owner_revalidation'});
const receipt = () => ({...review(),receipt_id:123,expires_at:'2099-01-01T12:00:00.000Z'});
const flush = async () => act(async () => { await new Promise(resolve => realTimeout(resolve, 15)); });
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const click = async label => { assert.ok(button(label)); await act(async () => button(label).click()); await flush(); };
const consent = async () => act(async () => document.querySelector('[type="checkbox"]').click());
const mount = async ({signedIn=true,strict=false,locale='en'}={}) => {
  calls=[]; deadlines=new Map(); window.localStorage.clear();
  if (signedIn) saveAuthSession({access_token:'owner-token',user:{id:'owner'}});
  if (locale==='ar-AE') window.localStorage.setItem('donna.interface_preferences.v1', JSON.stringify({locale:'ar-AE',numberStyle:'latn'}));
  // A pending offer must survive without redemption or billing navigation.
  window.localStorage.setItem('donna.pending_offer.v1', JSON.stringify({bandId:'paid',companyName:'Other Company'}));
  responder ||= async (_,init) => response(JSON.parse(init.body).owner_revalidation.action==='review' ? review() : receipt());
  root=createRoot(document.getElementById('root'));
  const content=React.createElement(LocaleProvider,null,React.createElement(WorkspaceProvisioner));
  await act(async () => root.render(strict ? React.createElement(React.StrictMode,null,content) : content)); await flush();
};
before(async () => {
  dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/start?revalidate=pilot',pretendToBeVisual:true});
  for (const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,
    localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})) {
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  ({createRoot}=await import('react-dom/client'));
  globalThis.setTimeout=(fn,ms,...args)=> {if(ms!==20_000)return realTimeout(fn,ms,...args);const key={};deadlines.set(key,fn);return key;};
  globalThis.clearTimeout=key=>{if(!deadlines?.delete(key))realClear(key);};
  globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),...init});return responder(String(url),init);};
  directory=await mkdtemp(resolve('.owner-confirm-test-'));
  await build({stdin:{contents:"export { default as WorkspaceProvisioner } from './src/components/WorkspaceProvisioner.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx'; export { saveAuthSession, clearAuthSession } from './src/lib/accessToken.js';",resolveDir:process.cwd()},
    outfile:`${directory}/mounted.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env':'{}','window.location.replace':'window.__testReplace'},logLevel:'silent'});
  ({WorkspaceProvisioner,LocaleProvider,saveAuthSession,clearAuthSession}=await import(pathToFileURL(`${directory}/mounted.mjs`)));
});
afterEach(async()=>{if(root)await act(async()=>root.unmount());root=null;document.body.innerHTML='<div id="root"></div>';responder=null;deadlines?.clear();dom.reconfigure({url:'http://localhost/start?revalidate=pilot'});});
after(async()=>{dom?.window.close();for(const[key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}if(directory)await rm(directory,{recursive:true,force:true});});
test('owner signup landing opens an existing empty firm without provisioning or adopting an owner persona',async()=>{
  dom.reconfigure({url:'http://localhost/start'});
  const navigations=[];window.__testReplace=url=>navigations.push(url);
  responder=async()=>response({source:'database',firm:{id:'separate-firm'},workspaceAccess:{surface:'firm',clientIds:null},clients:[]});
  await mount();
  assert.deepEqual(navigations,['/firms']);
  assert.equal(calls.length,1);assert.match(calls[0].url,/\/firms\/snapshot$/);
  assert.equal(calls[0].method,'GET');
  assert.equal(window.localStorage.getItem('donna.owner_client_id.v1'),null);
  assert.ok(window.localStorage.getItem('donna.pending_offer.v1'));
});
test('new owner still provisions after the snapshot denies a missing workspace',async()=>{
  dom.reconfigure({url:'http://localhost/start'});
  const navigations=[];window.__testReplace=url=>navigations.push(url);
  responder=async url=>url.endsWith('/snapshot')?response({code:'FIRM_ACCESS_DENIED'},403):response({client_id:'new-owner',created:true});
  await mount();
  assert.deepEqual(navigations,['/client/new-owner']);
  assert.equal(calls.length,2);assert.match(calls[1].url,/\/self-provision$/);
  assert.equal(JSON.parse(calls[1].body).firm_id,undefined);
});
test('an unavailable snapshot cannot create a replacement workspace',async()=>{
  dom.reconfigure({url:'http://localhost/start'});
  const navigations=[];window.__testReplace=url=>navigations.push(url);
  responder=async()=>response({error:'Books temporarily unavailable'},503);
  await mount();
  assert.deepEqual(navigations,[]);assert.equal(calls.length,1);
  assert.match(document.body.textContent,/Books temporarily unavailable/);
});
test('real WorkspaceProvisioner explicit mode reviews only, requires consent, sends exact envelope and stays on persisted receipt',async()=>{
  await mount();assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].body),{owner_revalidation:{action:'review'}});
  assert.equal(button('Confirm workspace ownership').disabled,true);assert.match(document.body.textContent,/Existing Oy/);
  await consent();await click('Confirm workspace ownership');
  assert.deepEqual(JSON.parse(calls[1].body),{owner_revalidation:{action:'confirm',confirmed:true,review_digest:'a'.repeat(64)}});
  assert.equal(calls[1].headers.Authorization,'Bearer owner-token');
  assert.match(document.body.textContent,/Owner confirmation recorded/);assert.match(document.body.textContent,/separate readiness checks/);
  assert.equal(window.location.pathname,'/start');assert.equal(calls.length,2);assert.ok(window.localStorage.getItem('donna.pending_offer.v1'));
});
test('unknown identity offers sign in without provisioning',async()=>{await mount({signedIn:false});assert.equal(calls.length,0);assert.ok(document.querySelector('a[href="/?auth=signin"]'));});
test('StrictMode cancelled first review cannot overwrite second review',async()=>{await mount({strict:true});assert.ok(button('Confirm workspace ownership'));assert.equal(button('Confirm workspace ownership').disabled,true);});
test('wrong authenticated actor response exposes no confirmation',async()=>{responder=async()=>response(review('different'));await mount();assert.match(document.body.textContent,/could not be verified/);assert.equal(document.querySelector('[type="checkbox"]'),null);});
test('stale refusal clears consent and requires new review',async()=>{
  responder=async(_,init)=>JSON.parse(init.body).owner_revalidation.action==='review'?response(review()):response({error:'Owner assignment changed'},409);
  await mount();await consent();await click('Confirm workspace ownership');assert.match(document.body.textContent,/Owner assignment changed/);
  assert.equal(document.querySelector('[type="checkbox"]'),null);await click('Review workspace again');assert.equal(button('Confirm workspace ownership').disabled,true);
});
test('invalid receipt expiry cannot render success',async()=>{responder=async(_,init)=>response(JSON.parse(init.body).owner_revalidation.action==='review'?review():{...receipt(),expires_at:'bad'});
  await mount();await consent();await click('Confirm workspace ownership');assert.match(document.body.textContent,/could not be verified/);assert.doesNotMatch(document.body.textContent,/Owner confirmation recorded/);});
test('request timeout is visible and permits fresh review',async()=>{
  responder=async(_,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
  await mount();await act(async()=>{for(const expire of [...deadlines.values()])expire();});await flush();assert.match(document.body.textContent,/request timed out/);assert.equal(button('Review workspace again').disabled,false);
});
test('logout during apply suppresses an old owner receipt even when transport ignores abort',async()=>{
  let finish;responder=async(_,init)=>JSON.parse(init.body).owner_revalidation.action==='review'?response(review()):new Promise(resolve=>{finish=resolve;});
  await mount();await consent();await click('Confirm workspace ownership');
  await act(async()=>{clearAuthSession();window.dispatchEvent(new window.Event('focus'));});await flush();
  await act(async()=>finish(response(receipt())));await flush();assert.doesNotMatch(document.body.textContent,/Owner confirmation recorded/);assert.ok(document.querySelector('a'));
});

test('same-owner credential refresh during apply retains one persisted confirmation',async()=>{
  let finish;responder=async(_,init)=>JSON.parse(init.body).owner_revalidation.action==='review'?response(review()):new Promise(resolve=>{finish=resolve;});
  await mount();await consent();await click('Confirm workspace ownership');
  await act(async()=>saveAuthSession({access_token:'refreshed-owner-token',user:{id:'owner'}},{refresh:true}));
  await act(async()=>finish(response(receipt())));await flush();assert.match(document.body.textContent,/Owner confirmation recorded/);
  assert.equal(calls.filter(call=>JSON.parse(call.body).owner_revalidation.action==='confirm').length,1);
});
test('same-owner logout and new login cannot reuse a previous session confirmation',async()=>{
  let finish;responder=async(_,init)=>JSON.parse(init.body).owner_revalidation.action==='review'?response(review()):new Promise(resolve=>{finish=resolve;});
  await mount();await consent();await click('Confirm workspace ownership');
  await act(async()=>{clearAuthSession();saveAuthSession({access_token:'new-login',user:{id:'owner'}});});
  await act(async()=>finish(response(receipt())));await flush();assert.doesNotMatch(document.body.textContent,/Owner confirmation recorded/);
  assert.equal(button('Confirm workspace ownership').disabled,true);
});

const recoveryReview=()=>({...review(),purpose:'deleted_owner_recovery'});
const recoveryPending=()=>({...recoveryReview(),pending:true,receipt_id:77,expires_at:'2099-01-01T12:00:00.000Z'});
const recoveryResponder=async(_,init)=>{
  const action=JSON.parse(init.body).owner_revalidation.action;
  if(action==='review')return response({code:'OWNER_REVALIDATION_IDENTITY_REQUIRED',error:'Your active owner assignment could not be verified.'},409);
  if(action==='recovery_review')return response(recoveryReview());
  if(action==='recovery_cancel')return response({...recoveryReview(),cancelled:true,receipt_id:78});
  return response(recoveryPending());
};
test('recovery is explicit: initial refusal writes nothing; reviewed consent requests approval and can be withdrawn',async()=>{
  responder=recoveryResponder;await mount();assert.equal(calls.length,1);
  await click('Review sign-in recovery');assert.equal(button('Request sign-in recovery').disabled,true);
  assert.doesNotMatch(document.body.textContent,/owner-[0-9a-f]|old_user_id|new_user_id/);
  await consent();await click('Request sign-in recovery');
  assert.deepEqual(JSON.parse(calls.at(-1).body),{owner_revalidation:{action:'recovery_request',confirmed:true,review_digest:'a'.repeat(64)}});
  assert.match(document.body.textContent,/Waiting for operator approval/);assert.doesNotMatch(document.body.textContent,/Owner confirmation recorded/);
  await click('Withdraw recovery request');assert.match(document.body.textContent,/Recovery request withdrawn/);
  assert.deepEqual(JSON.parse(calls.at(-1).body),{owner_revalidation:{action:'recovery_cancel',confirmed:true,review_digest:'a'.repeat(64)}});
});
test('a pending recovery read is displayed as waiting without another request',async()=>{
  responder=async(_,init)=>JSON.parse(init.body).owner_revalidation.action==='review'?recoveryResponder(_,init):response(recoveryPending());
  await mount();await click('Review sign-in recovery');assert.match(document.body.textContent,/Waiting for operator approval/);
  assert.equal(document.querySelector('[type="checkbox"]'),null);assert.equal(calls.length,2);
});
test('logout during recovery suppresses the old request receipt and clears consent',async()=>{
  let finish;responder=async(_,init)=>JSON.parse(init.body).owner_revalidation.action==='recovery_request'?new Promise(resolve=>{finish=resolve;}):recoveryResponder(_,init);
  await mount();await click('Review sign-in recovery');await consent();await click('Request sign-in recovery');
  await act(async()=>{clearAuthSession();window.dispatchEvent(new window.Event('focus'));});await flush();
  await act(async()=>finish(response(recoveryPending())));await flush();assert.doesNotMatch(document.body.textContent,/Waiting for operator approval/);
});
test('an unpersisted recovery response cannot claim owner confirmation or a pending request',async()=>{
  responder=async(_,init)=>JSON.parse(init.body).owner_revalidation.action==='recovery_request'?response(recoveryReview()):recoveryResponder(_,init);
  await mount();await click('Review sign-in recovery');await consent();await click('Request sign-in recovery');
  assert.match(document.body.textContent,/recovery response could not be verified/);assert.doesNotMatch(document.body.textContent,/Owner confirmation recorded|Waiting for operator approval/);
});
test('Arabic recovery uses the actual locale preference and preserves the explicit consent step',async()=>{
  responder=recoveryResponder;await mount({locale:'ar-AE'});assert.equal(document.documentElement.dir,'rtl');
  await click('مراجعة استعادة تسجيل الدخول');assert.equal(button('طلب استعادة تسجيل الدخول').disabled,true);
  assert.match(document.body.textContent,/يجب أن يوافق المشغّل/);assert.match(document.body.textContent,/Existing Oy/);
});
