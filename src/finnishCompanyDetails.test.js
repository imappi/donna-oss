import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
let dom, directory, root, createRoot, Component, Workspace, LocaleProvider, calls, states, responder;
const original = new Map(['window','document','navigator','localStorage','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
const profile=id=>({id,companyName:`Synthetic ${id} Oy`,jurisdiction:'FI',entityType:'fi-oy',profile:{jurisdiction:'FI',entity_type:'fi-oy'}});
const fields={businessId:'9999999-2',incorporation_date:'2025-01-01',alv_registration:{status:'registered',registered_from:'2025-01-01',tax_period:'month'},verokausi:'month'};
const flush=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
const panel=()=>document.querySelector('section[aria-label="Finnish company details"]');
const button=label=>[...panel().querySelectorAll('button')].find(node=>node.textContent===label);
const click=async label=>{await act(async()=>button(label).click());await flush();};
const change=async(node,value)=>{await act(async()=>{Object.getOwnPropertyDescriptor(node instanceof window.HTMLSelectElement?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new window.Event(node instanceof window.HTMLSelectElement?'change':'input',{bubbles:true}));});await flush();};
const render=async(id='a',full=false)=>{await act(async()=>root.render(React.createElement(LocaleProvider,null,React.createElement(full?Workspace:Component,{profile:profile(id),queue:[],onDatabaseSnapshot:s=>calls.push({snapshot:s})}))));await flush();};
const mount=async(full=false)=>{
 states={a:{client_id:'a',fields:structuredClone(fields),editable:true,locked_fields:[]},b:{client_id:'b',fields:{businessId:'2222222-2'},editable:true,locked_fields:[]}};calls=[];
 responder ||= async(url,init)=>{const id=url.includes('/b/')?'b':'a'; if(url.includes('/fiscal-periods'))return response({intake_acts:true,periods:[{starts_on:'2025-01-01',ends_on:'2025-12-31'}]});
   if(!url.includes('/profile'))return response({});
   if(init.method==='POST'){states[id].fields=JSON.parse(init.body).profile_patch;return response({source:'database',clients:[profile(id)]});}return response(states[id]);};
 root=createRoot(document.getElementById('root'));await render('a',full);
};
before(async()=>{
 dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/firms',pretendToBeVisual:true});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 ({createRoot}=await import('react-dom/client'));
 globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),...init});return responder(String(url),init);};
 directory=await mkdtemp(resolve('.fi-profile-test-'));
 await build({stdin:{contents:"export {default as Component} from './src/components/FinnishCompanyDetails.jsx'; export {default as Workspace} from './src/components/FirmClientWorkspace.jsx'; export {LocaleProvider} from './src/i18n/LocaleProvider.jsx';",resolveDir:process.cwd()},outfile:`${directory}/mounted.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env':'{}'},logLevel:'silent'});
 ({Component,Workspace,LocaleProvider}=await import(pathToFileURL(`${directory}/mounted.mjs`)));
});
afterEach(async()=>{if(root)await act(async()=>root.unmount());root=null;responder=null;document.body.innerHTML='<div id="root"></div>';});
after(async()=>{dom?.window.close();for(const[key,descriptor]of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}if(directory)await rm(directory,{recursive:true,force:true});});
test('actual firm Profile mounts the FI form, saves through profile API and reloads persisted facts',async()=>{
 await mount(true);states.a.fields.alv_registration.verified_from='registry';states.a.fields.alv_registration.verified_at='2026-01-01';await click('Refresh company details');assert.ok(panel());assert.match(panel().textContent,/does not confirm that the opening balances are zero/);
 await change(panel().querySelector('input[type="text"]'),'1234567-1');await click('Save company details');
 const sent=JSON.parse(calls.find(call=>call.method==='POST'&&call.url.includes('/profile')).body).profile_patch;
 assert.deepEqual(sent,{...fields,businessId:'1234567-1'});assert.match(panel().textContent,/Saved and reloaded/);assert.ok(calls.some(call=>call.snapshot?.source==='database'));
 await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await render();assert.equal(panel().querySelector('input[type="text"]').value,'1234567-1');
});
test('missing registration and conflicting cadences never default a tax fact',async()=>{
 responder=async(url)=>response(url.includes('/fiscal-periods')?{periods:[]}:{client_id:'a',editable:true,locked_fields:[],fields:{businessId:'9999999-2',alv_registration:{tax_period:'quarter'},verokausi:'month'}});
 await mount();assert.equal(panel().querySelectorAll('select')[0].value,'');assert.equal(panel().querySelectorAll('select')[1].value,'');assert.match(panel().textContent,/opening position still needs review/);assert.equal(calls.some(call=>call.method==='POST'),false);
});
test('save error remains visible and retry succeeds without an optimistic success',async()=>{
 await mount();const normal=responder;let fail=true;responder=async(url,init)=>init.method==='POST'&&fail?response({error:'Temporary save failure'},503):normal(url,init);
 await click('Save company details');assert.match(panel().textContent,/Temporary save failure/);assert.doesNotMatch(panel().textContent,/Saved and reloaded/);
 fail=false;await click('Save company details');assert.match(panel().textContent,/Saved and reloaded/);
});
test('prepared context is read-only and exposes no Save action',async()=>{
 responder=async(url)=>response(url.includes('/fiscal-periods')?{periods:[]}:{client_id:'a',editable:false,locked_fields:['businessId','incorporation_date','alv_registration','verokausi'],fields,reason:'pilot_prepared'});
 await mount();assert.equal(button('Save company details'),undefined);assert.equal(panel().querySelector('fieldset').disabled,true);assert.match(panel().textContent,/reapproval workflow/);
});
test('late prior-client response cannot populate the next client',async()=>{
 let finish;responder=async(url)=>url.includes('/fiscal-periods')?response({periods:[]}):url.includes('/a/')?new Promise(resolve=>{finish=resolve;}):response({client_id:'b',editable:true,locked_fields:[],fields:{businessId:'2222222-2'}});
 await mount();await render('b');assert.equal(panel().querySelector('input[type="text"]').value,'2222222-2');
 await act(async()=>finish(response({client_id:'a',editable:true,locked_fields:[],fields})));await flush();assert.equal(panel().querySelector('input[type="text"]').value,'2222222-2');
});
test('unavailable reads expose refresh and do not display previous editable facts',async()=>{
 await mount();responder=async()=>response({error:'Read unavailable'},503);await click('Refresh company details');assert.equal(panel().querySelector('form'),null);assert.match(panel().textContent,/Read unavailable/);
});
test('birth-prepared company records still-empty facts once and never re-sends recorded ones',async()=>{
 const born={client_id:'a',editable:true,locked_fields:['incorporation_date'],reason:'pilot_prepared',
   fields:{businessId:null,incorporation_date:'2025-01-01',alv_registration:null,verokausi:null}};let posted=null;
 responder=async(url,init)=>url.includes('/fiscal-periods')?response({periods:[]}):init.method==='POST'
   ?(posted=JSON.parse(init.body).profile_patch,response({source:'database',clients:[profile('a')]})):response(born);
 await mount();
 assert.match(panel().textContent,/still empty/);
 assert.equal(panel().querySelector('input[type="date"]').disabled,true,'recorded incorporation date stays locked');
 await change(panel().querySelector('input[type="text"]'),'1234567-1');
 await change(panel().querySelectorAll('select')[0],'registered');
 await change(panel().querySelectorAll('input[type="date"]')[1],'2025-02-01');
 await change(panel().querySelectorAll('select')[1],'quarter');
 await click('Save company details');
 assert.deepEqual(posted,{businessId:'1234567-1',alv_registration:{status:'registered',registered_from:'2025-02-01',tax_period:'quarter'},verokausi:'quarter'});
});
test('unknown lock contract is not rendered as editable',async()=>{
 responder=async(url)=>response(url.includes('/fiscal-periods')?{periods:[]}:{client_id:'a',editable:true,fields});
 await mount();assert.equal(panel().querySelector('form'),null);
});
