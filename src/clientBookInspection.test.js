import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { deriveClientPortalPeriod } from './lib/clientPortalPeriod.js';
import { defaultAlvPeriodKey } from './lib/alvReturnView.js';
let dom, directory, root, createRoot, Inspection, LocaleProvider, requests;
let cadence = 'month';
const savedTimezone = process.env.TZ;
const originals = new Map(['window','document','navigator','localStorage','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
const flush = () => act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
before(async()=>{
  dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/client/synthetic-fi',pretendToBeVisual:true});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  ({createRoot}=await import('react-dom/client'));
  globalThis.fetch=async address=>{
    const url=new URL(String(address),'http://localhost');requests.push(url);
    if(url.pathname.endsWith('/ledger/audit-trail'))return new Response(JSON.stringify({client_id:'synthetic-fi',native_ledger:{journals:[]}}));
    assert.ok(url.pathname.endsWith('/finland-alv-return'),'only existing read APIs are called');
    return new Response(JSON.stringify({verokausi:cadence,period:{key:url.searchParams.get('period')},review:{status:'ready'},alvReturn:{nilReturn:true,boxes:{}}}));
  };
  directory=await mkdtemp(resolve('.book-inspection-test-'));
  await build({stdin:{contents:"export {default as Inspection} from './src/components/client-book-inspection.jsx'; export {LocaleProvider} from './src/i18n/LocaleProvider.jsx';",resolveDir:process.cwd()},outfile:`${directory}/mounted.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env':'{}'},logLevel:'silent'});
  ({Inspection,LocaleProvider}=await import(pathToFileURL(`${directory}/mounted.mjs`)));
});
afterEach(async()=>{if(root)await act(async()=>root.unmount());root=null;cadence='month';document.body.innerHTML='<div id="root"></div>';if(savedTimezone===undefined)delete process.env.TZ;else process.env.TZ=savedTimezone;});
after(async()=>{dom?.window.close();for(const[key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}if(directory)await rm(directory,{recursive:true,force:true});});
const mount=async defaultDate=>{
  requests=[];root=createRoot(document.getElementById('root'));
  await act(async()=>root.render(React.createElement(LocaleProvider,null,React.createElement(Inspection,{clientId:'synthetic-fi',databaseMode:true,jurisdiction:'FI',defaultDate}))));await flush();
};
const assertReads=(month,lastDay)=>{
  assert.equal(document.querySelector('input[type="month"]').value,month);
  const ledger=requests.filter(url=>url.pathname.endsWith('/ledger/audit-trail')).at(-1);
  const alv=requests.filter(url=>url.pathname.endsWith('/finland-alv-return')).at(-1);
  assert.ok(ledger,'journal reader must actually run');assert.ok(alv,'ALV reader must actually run');
  assert.equal(ledger.searchParams.get('period_start'),`${month}-01`);
  assert.equal(ledger.searchParams.get('period_end'),`${month}-${lastDay}`);
  assert.equal(alv.searchParams.get('period'),month);
  assert.equal(document.querySelector('[role="alert"]'),null);
};
for(const zone of ['UTC','Asia/Dubai','America/Los_Angeles']) {
  test(`actual portal Date initializes valid journal and ALV requests in ${zone}`,async()=>{
    process.env.TZ=zone;
    const portal=deriveClientPortalPeriod({now:new Date(2026,8,13,12)});assert.ok(portal.date instanceof Date);
    await mount(portal.date);assertReads('2026-09','30');
  });
  test(`local New Year Date never shifts to the UTC month in ${zone}`,async()=>{
    process.env.TZ=zone;
    await mount(deriveClientPortalPeriod({now:new Date(2026,0,1,0,30)}).date);assertReads('2026-01','31');
  });
}
test('ISO day remains supported and changing the month updates both real read requests',async()=>{
  await mount('2025-02-01');assertReads('2025-02','28');
  await act(async()=>{const input=document.querySelector('input[type="month"]');Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'2024-02');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await flush();assertReads('2024-02','29');
});
for(const [label,value] of [['missing',undefined],['invalid Date',new Date(NaN)],['invalid month','2026-99-01']])test(`${label} uses the existing valid completed-month fallback`,async()=>{
  const month=defaultAlvPeriodKey(new Date());await mount(value);
  const[year,m]=month.split('-').map(Number);assertReads(month,String(new Date(Date.UTC(year,m,0)).getUTCDate()));
});

for (const [value, expected] of [['quarter','2025-Q1'],['year','2025']]) test(`owner inspection follows persisted ${value} cadence for the historical journal month`, async()=>{
  cadence=value;await mount('2025-02-01');await flush();
  assert.equal(document.querySelector('input[type="month"]').value,'2025-02');
  assert.equal(requests.filter(url=>url.pathname.endsWith('/finland-alv-return')).at(-1).searchParams.get('period'),expected);
  assert.equal(document.querySelector('select').value,expected);
  assert.equal(requests.filter(url=>url.pathname.endsWith('/ledger/audit-trail')).at(-1).searchParams.get('period_start'),'2025-02-01');
});

test('explicit VAT period survives refresh; changing journal month resumes its stored cadence',async()=>{
  cadence='quarter';await mount('2025-02-01');await flush();
  const select=document.querySelector('select');
  const alternative=[...select.options].find(o=>o.value!==select.value).value;
  await act(async()=>{select.value=alternative;select.dispatchEvent(new window.Event('change',{bubbles:true}));});await flush();
  await act(async()=>document.querySelector('button').click());await flush();
  assert.equal(document.querySelector('select').value,alternative);
  await act(async()=>{const input=document.querySelector('input[type="month"]');Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'2025-04');input.dispatchEvent(new window.Event('input',{bubbles:true}));});await flush();
  assert.equal(requests.filter(url=>url.pathname.endsWith('/finland-alv-return')).at(-1).searchParams.get('period'),'2025-Q2');
});
