import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
let dom, directory, createRoot, Panel, root, responder, calls;
const originals = new Map(['window','document','navigator','localStorage','HTMLElement','MutationObserver','FileReader','IS_REACT_ACT_ENVIRONMENT','fetch']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]));
const flush = async () => act(async () => { await new Promise(r => setTimeout(r,20)); });
const response = (body,status=200) => new Response(JSON.stringify(body),{status});
const catalog = { applied:true, items:Array.from({length:5},(_,i)=>({id:`i${i}`,name:`Item ${i}`,sku:`SKU${i}`,base_uom_id:'each'})),locations:[{id:'loc',name:'Warehouse'}],sessions:[] };
const session = {id:'s',firm_id:'f',client_id:'c'};
const lines = () => catalog.items.map(item=>({id:`line-${item.id}`,item_id:item.id,physical_status:'awaiting_observation'}));
const btn = text => [...document.querySelectorAll('button')].find(b=>b.textContent===text);
const click = async text => {assert.ok(btn(text),text);await act(async()=>btn(text).click());await flush();};
const mount = async () => {root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Panel,{firmId:'f',clientId:'c'})));await flush();};
before(async()=>{
 dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,FileReader:dom.window.FileReader,IS_REACT_ACT_ENVIRONMENT:true})) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 ({createRoot}=await import('react-dom/client'));
 globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),...init});return responder(String(url),init);};
 directory=await mkdtemp(resolve('.physical-mounted-'));
 await build({entryPoints:['src/components/inventory/PhysicalReconciliationPanel.jsx'],outfile:`${directory}/mounted.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env':'{}'},logLevel:'silent'});
 Panel=(await import(pathToFileURL(`${directory}/mounted.mjs`))).default;
});
afterEach(async()=>{if(root)await act(async()=>root.unmount());root=null;document.body.innerHTML='<div id="root"></div>';calls=[];responder=null;});
after(async()=>{dom?.window.close();for(const[key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}if(directory)await rm(directory,{recursive:true,force:true});});
test('mounted count journey uploads existing storage evidence, keeps first count blind and removes matches from attention',async()=>{
 calls=[];let current=lines(), observationBody;
 responder=async(url,init)=>{
  if(url.includes('/documents/upload-url')) return response({signed_url:'https://storage.invalid/photo',provider:'supabase_storage',bucket:'donna-evidence',key:'f/c/evidence/photo.png',content_type:'image/png'});
  if(url.startsWith('https://storage.invalid/')) return new Response('',{status:200});
  if(url.includes('/physical-reconciliation/evidence')){const doc=JSON.parse(init.body).document;assert.equal(doc.mime_type,'image/png');return response({document:{id:'photo',checksum_sha256:doc.checksum_sha256}});}
  if(url.includes('/observations')){observationBody=JSON.parse(init.body);assert.equal(observationBody.observed_quantity,3);assert.equal(observationBody.human_confirmed,true);assert.equal(observationBody.notes.blind_count,true);current[0]={...current[0],expected_quantity:3,counted_quantity:3,physical_observation:{observedQuantity:3,evidenceRefs:observationBody.evidence_refs},physical_status:'matched'};return response({applied:true,session,lines:current});}
  if(init.method==='POST')return response({applied:true,session,lines:current});
  return response(catalog);
 };
 await mount();assert.equal(btn('Start physical check').disabled,true);
 await act(async()=>{for(const cb of document.querySelectorAll('fieldset input'))cb.click();});
 await click('Start physical check');assert.equal(document.querySelectorAll('article').length,5);assert.doesNotMatch(document.body.textContent,/Expected3/);
 const qty=document.querySelector('[aria-label="Counted quantity for SKU0"]');assert.equal(qty.value,'');
 await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(qty,'3');qty.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const photo=document.querySelector('[aria-label="Photo for SKU0"]');
 await act(async()=>{Object.defineProperty(photo,'files',{configurable:true,value:[new dom.window.File([new Uint8Array([137,80,78,71,13,10,26,10])],'count.png',{type:'image/png'})]});photo.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 await act(async()=>photo.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await flush();await flush();
 assert.ok(observationBody,document.body.textContent);assert.equal(document.querySelectorAll('article').length,4);assert.match(document.body.textContent,/1 of 5 selected items resolved/);
 assert.equal(calls.filter(c=>c.url.includes('/documents/register')).length,0,'physical photos use supporting evidence admission');
});
test('flag off mounts no inventory controls',async()=>{calls=[];responder=async()=>response({code:'PHYSICAL_RECONCILIATION_DISABLED',error:'Not enabled'},403);await mount();assert.equal(document.querySelector('section'),null);});
test('initial catalog failure has an actionable retry through the same mounted reader',async()=>{
 calls=[];let first=true;
 responder=async()=>{if(first){first=false;throw new Error('Connection lost');}return response(catalog);};
 await mount();assert.match(document.querySelector('[role=alert]').textContent,/Connection lost/);
 await click('Retry loading checks');assert.equal(document.querySelector('[role=alert]'),null);
 assert.ok(btn('Start physical check'));assert.equal(calls.length,2);
});
test('variance and stale refusal remain visible without a success claim',async()=>{
 calls=[];const uncertain={...lines()[0],expected_quantity:3,counted_quantity:2,physical_status:'uncertain',physical_observation:{observedQuantity:2,uncertain:false},case_id:'owned-case'};
 responder=async(url,init)=>init.method==='POST'?response({error:'Inventory changed. Request a fresh count.',code:'PHYSICAL_STALE'},409):url.includes('/s?')?response({applied:true,session,lines:[uncertain]}):response({...catalog,sessions:[session]});
 await mount();await click('s · Not recorded');assert.match(document.body.textContent,/owned-case/);
 const reason=document.querySelector('textarea');await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(reason,'Physical recount reviewed');reason.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 await click('Accept reviewed result');assert.match(document.querySelector('[role=alert]').textContent,/fresh count/);assert.match(document.body.textContent,/0 of 1 selected items resolved/);
});

test('saved requests, histories, and unresolved accounting remain visible after stock application',async()=>{
 calls=[];let acked=false;
 const applied={...lines()[0],physical_status:'applied',expected_quantity:3,counted_quantity:2,
  physical_observation:{quantity:2,actorId:'counter',inputDigest:'saved-digest'},
  physical_basis:{valuation:{status:'priced',currency:'GBP',unitCost:5,carryingValue:15}},
  physical_resolution:{operationId:42,accounting:{status:'disabled'}},
  payload:{owner:{actorId:'reviewer',dueAt:'2026-10-10',ask:{id:'ask',question:'Review the accounting consequence',deliveryStatus:'not_delivered',recipient:{principalId:'reviewer'}}},versions:[{kind:'observation',observation:{quantity:2,observedAt:'2026-10-07'}}]}};
 responder=async(url,init)=>{
  if(url.includes('/acknowledgements')){assert.deepEqual(JSON.parse(init.body).ask_id,'ask');acked=true;applied.payload.owner.ask.deliveryStatus='acknowledged';return response({id:'ask',deliveryStatus:'acknowledged'});}
  return response(url.includes('/s?')?{applied:true,session,lines:[applied]}:{...catalog,sessions:[session]});
 };
 await mount();await click('s · Not recorded');assert.equal(document.querySelectorAll('article').length,1,'accounting obligation stays in attention');
 assert.match(document.body.textContent,/reviewer/);assert.match(document.body.textContent,/Inventory operation: 42/);assert.match(document.body.textContent,/Attempt 1: 2/);
 await click('Acknowledge count request');assert.equal(acked,true);assert.equal(btn('Acknowledge count request'),undefined);
});

test('ambiguous resolution retry sends the same observation digest, duration and idempotency key',async()=>{
 calls=[];const row={...lines()[0],physical_status:'variance',expected_quantity:3,counted_quantity:2,physical_observation:{quantity:2,actorId:'other',inputDigest:'reviewed-version'}};
 let first=true;
 responder=async(url,init)=>{
  if(url.includes('/resolutions')){if(first){first=false;throw new Error('Connection lost');}return response({applied:true,session,lines:[{...row,physical_status:'dismissed'}]});}
  return response(url.includes('/s?')?{applied:true,session,lines:[row]}:{...catalog,sessions:[session]});
 };
 await mount();await click('s · Not recorded');const textarea=document.querySelector('textarea');
 await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(textarea,'Reviewed photo and stock');textarea.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 await click('Dismiss with reason');await new Promise(r=>setTimeout(r,1100));await click('Dismiss with reason');
 const attempts=calls.filter(c=>c.url.includes('/resolutions')).map(c=>JSON.parse(c.body));assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);assert.equal(attempts[0].expected_observation_digest,'reviewed-version');
});

test('switching client while an old result loads cannot place it in the new client',async()=>{
 calls=[];let finishOld;
 responder=async(url)=>{
  if(url.includes('/s?'))return new Promise(resolve=>{finishOld=()=>resolve(response({applied:true,session,lines:[{...lines()[0],case_id:'old-client-private-case'}]}));});
  if(url.includes('client_id=new'))return response({...catalog,sessions:[],items:catalog.items.map(i=>({...i,name:'New client item'}))});
  return response({...catalog,sessions:[session]});
 };
 await mount();await act(async()=>btn('s · Not recorded').click());await flush();
 await act(async()=>root.render(React.createElement(Panel,{firmId:'f',clientId:'new'})));await flush();
 await act(async()=>finishOld());await flush();assert.match(document.body.textContent,/New client item/);assert.doesNotMatch(document.body.textContent,/old-client-private-case/);assert.equal(document.querySelector('article'),null);
});

test('chat summary comes from saved results and keeps scope and accounting limits explicit',async()=>{
 calls=[];let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copied=value;}}});
 const row={...lines()[0],physical_status:'applied',expected_quantity:10,physical_observation:{quantity:8,variance:-2,observedAt:'2026-10-07'},physical_resolution:{accounting:{status:'disabled'}},payload:{owner:{actorId:'reviewer'}}};
 responder=async url=>response(url.includes('/s?')?{applied:true,session,lines:[row]}:{...catalog,sessions:[session]});
 await mount();await click('s · Not recorded');await click('Copy check summary');assert.match(copied,/Counted 8; expected 10; difference -2/);assert.match(copied,/Accounting: disabled/);assert.match(copied,/1 still need attention/);assert.match(copied,/Unselected stock has not been checked/);assert.match(copied,/No service sign-off/);
});
