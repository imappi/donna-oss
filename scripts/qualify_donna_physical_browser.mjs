#!/usr/bin/env node
// Explicit browser qualification, separate from jsdom tests and real-device
// acceptance. The shipping Settings → Data child and HTTP handlers are real;
// identity and external blob storage are synthetic boundary fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { physicalQualificationFixture } from '../server/donna/testSupport/physicalQualificationFixture.js';
import { handleDonnaApiRequest } from '../server/donna/api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../server/donna/firmDb.js';
import { exportPhysicalQualification } from '../server/donna/inventory/physicalQualificationDb.js';

if (!process.env.DONNA_PLAYWRIGHT_MODULE) throw new Error('Set DONNA_PLAYWRIGHT_MODULE to an installed playwright module path; this exercise requires a real browser.');
const { chromium } = await import(pathToFileURL(process.env.DONNA_PLAYWRIGHT_MODULE));
const fixture=await physicalQualificationFixture();
const directory=await mkdtemp(join(tmpdir(),'donna-qualification-browser-'));
const saved={...process.env}, realFetch=globalThis.fetch;
const env={SUPABASE_URL:'https://qualification.invalid',SUPABASE_ANON_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture',
  SUPABASE_PUBLISHABLE_KEY:'',SUPABASE_SERVICE_KEY:'',SUPABASE_SECRET_KEY:'',DONNA_DESKTOP_BLOB_DIR:'',DONNA_AUTH_ALLOWED_EMAILS:'',
  DONNA_ACCESS_TOKEN:'fixture-infrastructure-only',DATABASE_URL:fixture.pool.options.connectionString,
  DONNA_EVIDENCE_BUCKET:'donna-evidence',SUPABASE_EVIDENCE_BUCKET:''};
Object.assign(process.env,env);__setFirmDbPoolForTests(fixture.pool);
const stored=new Map();
globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url));
  if(u.origin!=='https://qualification.invalid') throw new Error('Unexpected external request during synthetic browser qualification');
  if(u.pathname==='/auth/v1/user')return new Response(JSON.stringify({id:'qualification-user',email:'qualification@example.invalid'}));
  if(u.pathname.startsWith('/storage/v1/object/upload/sign/'))return new Response(JSON.stringify({url:`/object/upload/sign/${u.pathname.slice('/storage/v1/object/upload/sign/'.length)}?token=fixture`}));
  if(u.pathname.startsWith('/storage/v1/object/')){
    const key=u.pathname.slice('/storage/v1/object/'.length).replace(/^authenticated\//,'');
    return new Response(stored.get(key) || fixture.photo);
  }
  throw new Error(`Unexpected synthetic provider path ${u.pathname}`);
};
let browser, server, page;
try{
  await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './src/components/inventory/PhysicalReconciliationPanel.jsx';
    localStorage.setItem('donna.auth_session.v1',JSON.stringify({access_token:'fixture-user'}));
    createRoot(document.getElementById('root')).render(React.createElement(Panel,{firmId:'qualification-firm',clientId:'qualification-client'}));`,resolveDir:process.cwd(),loader:'jsx'},
    outfile:join(directory,'panel.js'),bundle:true,format:'esm',platform:'browser',jsx:'automatic',define:{'import.meta.env':'{}'},logLevel:'silent'});
  const js=await readFile(join(directory,'panel.js')),css=await readFile(join(directory,'panel.css'));
  server=http.createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/panel.css"><div id="root"></div><script type="module" src="/panel.js"></script></html>');return;}
    if(req.url==='/panel.js'){res.setHeader('content-type','text/javascript');res.end(js);return;}
    if(req.url==='/panel.css'){res.setHeader('content-type','text/css');res.end(css);return;}
    Promise.resolve(handleDonnaApiRequest(req,res)).catch(()=>{res.statusCode=500;res.end('{"error":"Synthetic server error"}');});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({channel:process.env.DONNA_BROWSER_CHANNEL || 'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:[]});
  page=await context.newPage();page.setDefaultTimeout(10000);
  let failStorage=true;
  await context.route('https://qualification.invalid/storage/v1/object/upload/sign/**',async route=>{
    if(failStorage){failStorage=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Upload interrupted; retry the photo."}'});}
    const path=new URL(route.request().url()).pathname;
    stored.set(path.slice('/storage/v1/object/upload/sign/'.length),route.request().postDataBuffer());
    await route.fulfill({status:200,body:''});
  });
  let firstCatalog=true;
  await page.route('**/physical-reconciliation?*',route=>{
    if(firstCatalog&&route.request().method()==='GET'){firstCatalog=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Temporary catalog failure"}'});}
    return route.continue();
  });
  await page.goto(url);await page.getByRole('alert').filter({hasText:'Temporary catalog failure'}).waitFor();
  await page.getByRole('button',{name:'Retry loading checks'}).click();
  await page.getByRole('group',{name:'Choose 5–20 known items'}).waitFor().catch(async e=>{console.error(await page.locator('body').innerText());throw e;});
  for(const cb of await page.locator('fieldset input').all())await cb.check();
  await page.getByRole('button',{name:'Start physical check',exact:true}).click();
  await page.getByRole('spinbutton',{name:'Counted quantity for SKU0'}).waitFor();
  assert.equal(await page.locator('dt').filter({hasText:'Expected'}).count(),0,'initial count remains blind');
  const photo={name:'count.png',mimeType:'image/png',buffer:fixture.photo};
  await page.getByRole('spinbutton',{name:'Counted quantity for SKU0'}).fill('10');
  await page.getByLabel('Photo for SKU0',{exact:true}).setInputFiles(photo);
  await page.locator('article').first().getByRole('button',{name:'Confirm count and compare'}).click();
  await page.getByRole('alert').filter({hasText:'Upload interrupted'}).waitFor();
  assert.equal((await fixture.pool.query("select count(*)::int n from inventory_count_lines where physical_observation is not null")).rows[0].n,0);
  assert.equal(await page.getByRole('spinbutton',{name:'Counted quantity for SKU0'}).inputValue(),'10');
  await page.locator('article').first().getByRole('button',{name:'Confirm count and compare'}).click();
  await page.getByRole('status').filter({hasText:'1 of 5'}).waitFor();
  await page.reload();await page.getByRole('heading',{name:'Previous checks'}).waitFor();
  await page.getByRole('button',{name:/ · open$/}).click();
  await page.getByRole('status').filter({hasText:'1 of 5'}).waitFor();
  assert.equal(await page.getByRole('spinbutton',{name:'Counted quantity for SKU1'}).inputValue(),'');
  await page.getByRole('spinbutton',{name:'Counted quantity for SKU1'}).fill('8');
  await page.getByLabel('Photo for SKU1',{exact:true}).setInputFiles(photo);
  await context.setOffline(true);
  await page.getByRole('article',{name:'Item 1'}).getByRole('button',{name:'Confirm count and compare'}).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('spinbutton',{name:'Counted quantity for SKU1'}).inputValue(),'8');
  await context.setOffline(false);
  // Simulate a lost HTTP reply AFTER the actual observation commits. The retry
  // must reuse its original idempotency key and create one observation version.
  let loseReply=true;
  await page.route('**/observations?*',async route=>{
    if(!loseReply)return route.continue();loseReply=false;
    const response=await route.fetch();assert.equal(response.status(),200);await route.abort('connectionreset');
  });
  const submit=()=>page.getByRole('article',{name:'Item 1'}).getByRole('button',{name:'Confirm count and compare'}).click();
  await submit();await page.getByRole('alert').waitFor();await submit();
  await page.getByRole('article',{name:'Item 1'}).getByText('variance · Case',{exact:false}).waitFor();
  const row=(await fixture.pool.query("select * from inventory_count_lines where item_id='item-1'")).rows[0];
  assert.equal(row.payload.versions.filter(v=>v.kind==='observation').length,1);
  assert.equal(Number(row.counted_quantity),8);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  assert.equal(overflow,false,'390px mobile viewport must not overflow horizontally');
  const touches=await page.locator('button').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().height<44).length);
  assert.equal(touches,0,'all buttons retain 44px touch height');
  const client=await fixture.pool.connect();let snapshot;
  try{snapshot=await exportPhysicalQualification({...fixture.a,client});}finally{client.release();}
  const operations=await fixture.pool.query("select count(*)::int n from inventory_operations where operation_type='count_correction'");assert.equal(operations.rows[0].n,0);
  const receipt={kind:'automated_chromium_browser',viewport:{width:390,height:844},browserVersion:browser.version(),
    sourceDigest:snapshot.sourceDigest,passed:['catalog_retry','blind_count','upload_failure_preserves_input','upload_retry','reload_persisted_progress','offline_failure_recovery','lost_response_idempotency','mobile_layout','touch_height'],
    cameraDenial:'not_run: file input uses the OS camera/gallery chooser; no getUserMedia consumer',
    realDevices:'not_run: iOS Safari and Android Chrome require operator device exercise',
    lowBandwidth:'not_run: offline interruption is not a measured bandwidth profile',
    backgrounding:'not_run: tab visibility is not native mobile lifecycle evidence',serviceSignoff:'not_issued',customerEnrollment:'none'};
  if(process.env.DONNA_BROWSER_RECEIPT)await writeFile(process.env.DONNA_BROWSER_RECEIPT,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(receipt,null,2));
}catch(error){
  if(page)console.error(await page.locator("body").innerText());
  throw error;
}finally{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  globalThis.fetch=realFetch;__resetFirmDbPoolForTests();
  for(const key of Object.keys(env))if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
  await fixture.dispose();await rm(directory,{recursive:true,force:true});
}
