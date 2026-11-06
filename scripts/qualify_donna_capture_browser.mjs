#!/usr/bin/env node
// Explicit real-browser qualification, following qualify_donna_physical_browser.
// Synthetic identity/storage providers; actual React, deployed rewrite entrypoint,
// HTTPS cookie jar, HTTP authorization/CSRF and fully migrated PostgreSQL writers.
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import router from '../api/donna-router.js';
import { handleDonnaApiRequest } from '../server/donna/api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../server/donna/firmDb.js';
import { captureQualificationFixture } from '../server/donna/testSupport/captureQualificationFixture.js';
import { captureBrowserContract } from './capture_browser_contract.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if (!process.env.DONNA_PLAYWRIGHT_MODULE) throw new Error('DONNA_PLAYWRIGHT_MODULE required: this proof needs a real browser.');
const { chromium }=await import(pathToFileURL(process.env.DONNA_PLAYWRIGHT_MODULE));
const fixture=await captureQualificationFixture();
const directory=await mkdtemp(join(tmpdir(),'donna-capture-browser-'));
const deployment=JSON.parse(await readFile(join(root,'vercel.json'),'utf8'));
const deployedHeaders=captureBrowserContract(deployment);
const saved={...process.env}, realFetch=globalThis.fetch, objects=new Map();
const identity='https://capture-qualification.supabase.co';
const env={SUPABASE_URL:identity,SUPABASE_ANON_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture',
  SUPABASE_PUBLISHABLE_KEY:'',SUPABASE_SERVICE_KEY:'',SUPABASE_SECRET_KEY:'',DONNA_DESKTOP_BLOB_DIR:'',DONNA_AUTH_ALLOWED_EMAILS:'',
  DONNA_ACCESS_TOKEN:'fixture-infrastructure-only',DATABASE_URL:fixture.pool.options.connectionString,
  DONNA_EVIDENCE_BUCKET:'donna-evidence',SUPABASE_EVIDENCE_BUCKET:'',PUBLIC_APP_URL:'',APP_BASE_URL:''};
Object.assign(process.env,env);__setFirmDbPoolForTests(fixture.pool);
let browser,server,plainServer,page,failStorage=false,storageCalls=0,holdExchange=null,loseUploadResponse=false,loseCountResponse=false;
const wire=[], secrets=[], passed=[];
const record=(...checks)=>{passed.push(...checks);console.error(`Qualified: ${checks.join(', ')}`);};
globalThis.fetch=async(address,init={})=>{
  const url=new URL(String(address));assert.equal(url.origin,identity,'no unexpected external provider');
  if(url.pathname==='/auth/v1/user'){
    const token=init.headers.Authorization.replace('Bearer ','');
    const users={owner:['qualification-user','qualification@example.invalid'],worker:['worker-user','worker@qualification.invalid'],other:['other-user','other@qualification.invalid']};
    return users[token]?new Response(JSON.stringify({id:users[token][0],email:users[token][1]})):new Response('{}',{status:401});
  }
  storageCalls++;
  if(url.pathname.startsWith('/storage/v1/object/upload/sign/'))return new Response(JSON.stringify({url:`/object/upload/${url.pathname.slice('/storage/v1/object/upload/sign/'.length)}`}));
  const prefix=init.method==='PUT'?'/storage/v1/object/upload/':'/storage/v1/object/';
  const key=decodeURIComponent(url.pathname.slice(prefix.length));
  if(init.method==='PUT'){
    if(failStorage){failStorage=false;return new Response('{}',{status:503});}
    if(objects.has(key))return new Response('{}',{status:409});
    objects.set(key,Buffer.from(init.body));return new Response('{}');
  }
  return objects.has(key)?new Response(objects.get(key)):new Response('{}',{status:404});
};
try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=capture.test'],{stdio:'ignore'});
  await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';
    import Page from './src/components/inventory/CaptureTaskPage.jsx';import Assignment from './src/components/inventory/CaptureTaskAssignment.jsx';
    const assigning=window.location.pathname==='/assignment';
    createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,assigning?React.createElement(Assignment,{firmId:'qualification-firm',clientId:'qualification-client',sessionId:new URLSearchParams(location.search).get('session')}):React.createElement(Page)));`,resolveDir:root,loader:'jsx'},
    outfile:join(directory,'capture.js'),bundle:true,format:'esm',platform:'browser',jsx:'automatic',
    define:{'import.meta.env':JSON.stringify({VITE_SUPABASE_URL:identity,VITE_SUPABASE_PUBLISHABLE_KEY:'fixture'})},logLevel:'silent'});
  const js=await readFile(join(directory,'capture.js')),css=await readFile(join(directory,'capture.css'));
  const serve=(req,res)=>{
    const url=new URL(req.url,'https://capture.test');
    wire.push({path:url.pathname,cookie:req.headers.cookie||'',origin:req.headers.origin||'',referer:req.headers.referer||''});
    if(['/capture','/assignment'].includes(url.pathname)){
      for(const [key,value]of Object.entries(deployedHeaders))res.setHeader(key,value);
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/capture.css"><div id="root"></div><script type="module" src="/capture.js"></script></html>');return;
    }
    if(url.pathname==='/capture.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
    if(url.pathname==='/capture.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
    if(url.pathname.startsWith('/api/donna/physical/')){
      if((url.pathname.endsWith('/uploads')&&loseUploadResponse)||(url.pathname.endsWith('/responses')&&loseCountResponse)){
        if(url.pathname.endsWith('/uploads'))loseUploadResponse=false;else loseCountResponse=false;
        res.end=()=>{assert.equal(res.statusCode,200,'lose only a committed successful response');res.flushHeaders();res.write('{"lost_reply":');setTimeout(()=>res.destroy(),10);return res;};
      }
      if(url.pathname==='/api/donna/physical/capture/exchange'&&holdExchange){
        const held=holdExchange;holdExchange=null;const end=res.end.bind(res);
        res.once('close',held.closed);
        res.end=(...args)=>{assert.equal(res.statusCode,200);held.committed(()=>end(...args));return res;};
      }
      // Apply the verified deployed prefix rewrite, then run its actual entrypoint.
      req.url=`/api/donna-router?path=physical/${url.pathname.slice('/api/donna/physical/'.length)}${url.search?'&'+url.search.slice(1):''}`;
      router(req,res);return;
    }
    Promise.resolve(handleDonnaApiRequest(req,res)).catch(()=>{res.statusCode=500;res.end('{"code":"FIXTURE_SERVER_ERROR"}');});
  };
  server=https.createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},serve);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`https://capture.test:${server.address().port}`;process.env.PUBLIC_APP_URL=origin;
  plainServer=http.createServer((req,res)=>{wire.push({path:'/plain-probe',cookie:req.headers.cookie||''});res.end('plain');});
  await new Promise(resolve=>plainServer.listen(0,'127.0.0.1',resolve));
  const request=async(path,data,token='owner')=>{
    const result=await new Promise((resolve,reject)=>{
      const req=https.request(`${origin}${path}`,{lookup:(_hostname,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4),rejectUnauthorized:false,
        method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}},res=>{
          let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body||'{}')}));
        });req.on('error',reject);req.end(data?JSON.stringify(data):undefined);
    });return result;
  };
  const scope='?firm_id=qualification-firm&client_id=qualification-client';
  const physical=(data,suffix='')=>request(`/api/donna/firms/inventory/physical-reconciliation${suffix}${scope}`,data);
  const opened=await physical({location_id:'shelf',item_ids:Array.from({length:5},(_,i)=>`item-${i}`),idempotency_key:'browser-open'});
  assert.equal(opened.body.applied,true,JSON.stringify(opened));const sessionId=String(opened.body.session.id);
  browser=await chromium.launch({channel:process.env.DONNA_BROWSER_CHANNEL||'chrome',headless:true,
    args:['--host-resolver-rules=MAP capture.test 127.0.0.1, MAP outsider.test 127.0.0.1','--no-proxy-server']});
  // Self-signed disposable local TLS is accepted only by this browser context.
  // Secure cookies and the deployed CSP remain untouched.
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await context.route(`${identity}/auth/v1/token?*`,async route=>{
    assert.equal(new URL(page.url()).hash,'','fragment removed before external auth');
    assert.ok(!route.request().headers().referer,'no external referrer');
    const email=route.request().postDataJSON().email;const token=email.startsWith('other')?'other':'worker';
    await route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':origin},
      body:JSON.stringify({access_token:token,refresh_token:`${token}-refresh`,user:{id:`${token}-user`,email}})});
  });
  const session=token=>page.evaluate(token=>localStorage.setItem('donna.auth_session.v1',JSON.stringify({access_token:token,user:{email:`${token}@qualification.invalid`}})),token);
  // Actual owner Assignment UI -> real route -> task persistence -> fragment link.
  await page.goto(`${origin}/assignment?session=${sessionId}`);await session('owner');await page.reload();
  await page.getByRole('combobox').selectOption('firm_collaborator:capture-worker');
  await page.getByRole('button',{name:'Assign and create invitation'}).click();

  const field=page.getByLabel('Private invitation (expires in 15 minutes)');await field.waitFor();
  const invitationUrl=await field.inputValue();let invitation=new URL(invitationUrl).hash.slice('#invitation='.length);secrets.push(invitation);
  const task=(await fixture.pool.query('select id from inventory_capture_tasks')).rows[0].id;
  record('actual_assignment_and_invitation');
  const issue=async()=>{
    const result=await request(`/api/donna/physical/tasks/${task}/invitation${scope}`,{firm_id:fixture.a.firmId,client_id:fixture.a.clientId,idempotency_key:randomUUID()});
    assert.equal(result.status,200);secrets.push(result.body.invitation);return result.body.invitation;
  };
  const login=async(email)=>{
    const switchAccount=page.getByRole('button',{name:'Use a different account'});
    if(await switchAccount.count())await switchAccount.click();
    await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill('synthetic-password');
    await page.getByLabel('I understand the photos go to this entity’s authorized reviewers.').check();
    await page.getByRole('button',{name:'Open my assigned task'}).click();
  };
    const taskRequest=async(suffix='',data,options={})=>page.evaluate(async({task,suffix,data,options})=>{
    const response=await fetch(`/api/donna/physical/capture/tasks/${task}${suffix}`,{credentials:'same-origin',method:data?'POST':'GET',
      headers:{'Content-Type':'application/json',...(options.csrf?{'X-Donna-Capture-CSRF':options.csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json()};
  },{task,suffix,data,options});
  await page.goto(`${origin}/capture#invitation=${invitation}`);assert.equal(new URL(page.url()).hash,'');
  assert.equal((await fixture.pool.query('select invitation_used_at from inventory_capture_tasks')).rows[0].invitation_used_at,null);
  await login('other@qualification.invalid');await page.getByRole('alert').waitFor();
  assert.equal((await fixture.pool.query('select invitation_used_at from inventory_capture_tasks')).rows[0].invitation_used_at,null,'forwarded invitation unconsumed');
  await fixture.pool.query("update inventory_capture_tasks set invitation_expires_at=now()-interval '1 second' where id=$1",[task]);
  await login('worker@qualification.invalid');await page.getByRole('alert').filter({hasText:'invitation expired'}).waitFor();
  invitation=await issue();
  let failRead=true;
  await page.route(`**/capture/tasks/${task}`,route=>{
    if(failRead&&route.request().method()==='GET'){failRead=false;return route.fulfill({status:503,contentType:'application/json',body:'{}'});}
    return route.continue();
  });
  await page.goto(`${origin}/capture#invitation=${invitation}`);
  await page.getByLabel('I understand the photos go to this entity’s authorized reviewers.').check();
  await page.getByRole('button',{name:'Open my assigned task'}).click();
  await page.getByRole('button',{name:'Retry loading task'}).waitFor();
  assert.equal(new URL(page.url()).search,`?task=${task}`);await page.getByRole('button',{name:'Retry loading task'}).click();
  await page.getByRole('status').filter({hasText:'0 of 5'}).waitFor();
  assert.equal(await page.evaluate(()=>window.isSecureContext),true);
  const cookie=(await context.cookies(`${origin}/api/donna/physical/capture/tasks/${task}`)).find(row=>row.name==='__Secure-donna_capture');
  assert.ok(cookie);secrets.push(cookie.value);assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'Strict');assert.equal(cookie.path,'/api/donna/physical/capture');assert.ok(cookie.expires>Date.now()/1000+1700&&cookie.expires<=Date.now()/1000+1800,'30-minute cookie lifetime');
  assert.ok(!(await context.cookies(`${origin}/api/donna/firms/snapshot`)).some(row=>row.name===cookie.name));
  assert.ok(!(await page.evaluate(()=>document.cookie)).includes(cookie.name));
  const replay=await request('/api/donna/physical/capture/exchange',{invitation},'worker');assert.equal(replay.body.code,'CAPTURE_INVITATION_REFUSED');
  const valid=await taskRequest();assert.equal(valid.status,200);const csrf=valid.body.csrf;
  assert.doesNotMatch(JSON.stringify(valid.body),/"(?:expected|quantity|variance|cost|price|valuation|journal|ask|profile|physical_basis)/);
  assert.doesNotMatch(await page.locator('body').innerText(),/Expected|Valuation|Journal|Price|Financial conversation/);
  record('identity_bound_expired_forwarded_replayed_invitation','fragment_removed_before_external_auth','initial_task_read_retry','secure_httponly_strict_path_cookie');
  const csrfInput={line_id:valid.body.items[0].lineId,filename:'count.png',mime_type:'image/png',base64:fixture.photo.toString('base64'),idempotency_key:'csrf-neighbor'};
  const beforeStorage=storageCalls;
  assert.equal((await taskRequest('/uploads',csrfInput,{csrf:'wrong'})).body.code,'CAPTURE_CSRF_REFUSED');
  assert.equal((await taskRequest('/uploads',{...csrfInput,line_id:'999999999'},{csrf})).body.code,'CAPTURE_LINE_REFUSED');
  assert.equal(storageCalls,beforeStorage);assert.equal((await taskRequest('/uploads',csrfInput,{csrf})).status,200);
  // Real cross-site browser request: Strict cookie omitted; attacker Origin refused.
  const outsider=await context.newPage();await outsider.goto(`https://outsider.test:${server.address().port}/capture`);
  await outsider.evaluate(async origin=>{try{await fetch(`${origin}/api/donna/physical/capture/exchange`,{method:'POST',credentials:'include',body:'{}'});}catch{}},origin);
  assert.ok(wire.some(row=>row.origin.startsWith('https://outsider.test')&&!row.cookie));
  const crossNavigation=`${origin}/api/donna/physical/capture/tasks/${task}`;
  await Promise.all([outsider.waitForURL(crossNavigation),outsider.evaluate(url=>{location.href=url;},crossNavigation)]);
  await outsider.waitForLoadState('domcontentloaded');assert.match(await outsider.locator('body').innerText(),/CAPTURE_CREDENTIAL_REQUIRED/);
  assert.equal((await taskRequest()).status,200,'same-site authorized neighbor');await outsider.close();
  await page.goto(`http://capture.test:${plainServer.address().port}/api/donna/physical/capture/tasks/${task}`);
  assert.equal(wire.at(-1).cookie,'','Secure credential omitted on plain HTTP');
  await page.goto(`${origin}/capture?task=${task}`);await page.getByRole('status').filter({hasText:'0 of 5'}).waitFor();
  record('csrf_line_scope_and_cross_site_origin_refusal','strict_cross_site_navigation','secure_cookie_refuses_plain_http');
  const article=index=>page.getByRole('article').nth(index);
  const photo={name:'count.png',mimeType:'image/png',buffer:fixture.photo};
  await article(0).getByLabel('Counted quantity',{exact:true}).fill('8');
  const sizeStorage=storageCalls;
  await article(0).getByLabel('Item and label photo').setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(2*1024*1024+1)});
  await article(0).getByRole('alert').filter({hasText:'up to 2 MB'}).waitFor();assert.equal(await article(0).getByRole('button',{name:'Confirm count and send',exact:true}).isDisabled(),true);
  assert.equal(storageCalls,sizeStorage,'oversized photo never reaches storage');
  const uploadBodies=[],countBodies=[];
  page.on('request',req=>{if(req.url().endsWith('/uploads'))uploadBodies.push(req.postData());if(req.url().endsWith('/responses'))countBodies.push(req.postData());});
  await article(0).getByLabel('Item and label photo').setInputFiles(photo);
  await context.setOffline(true);await article(0).getByRole('button',{name:'Confirm count and send',exact:true}).click();await article(0).getByRole('alert').waitFor();await context.setOffline(false);
  loseUploadResponse=true;loseCountResponse=true;
  await article(0).getByRole('button',{name:'Confirm count and send',exact:true}).click();await article(0).getByRole('alert').waitFor();
  await article(0).getByRole('button',{name:'Confirm count and send',exact:true}).click();await article(0).getByRole('alert').waitFor();
  await article(0).getByRole('button',{name:'Confirm count and send',exact:true}).click();await page.getByRole('status').filter({hasText:'1 of 5'}).waitFor();
  assert.ok(uploadBodies.length>=2);assert.ok(uploadBodies.every(body=>body===uploadBodies[0]),'same upload identity across offline and lost-reply retry');
  assert.equal(countBodies.length,2);assert.equal(countBodies[0],countBodies[1]);
  let line=(await fixture.pool.query('select * from inventory_count_lines where id=$1',[valid.body.items[0].lineId])).rows[0];
  assert.doesNotMatch(JSON.stringify((await taskRequest()).body),/"(?:expected|quantity|variance|cost|price|valuation|journal|ask|profile|physical_basis)/);
  assert.doesNotMatch(await page.locator('body').innerText(),/Expected|Valuation|Journal|Price|Financial conversation/);
  assert.equal(line.payload.versions.filter(v=>v.kind==='observation').length,1);assert.equal(line.physical_observation.actorId,'capture-worker');assert.equal(line.physical_observation.quantity,8);
  const input=JSON.parse(countBodies[0]);const storageBeforeProbe=storageCalls;
  assert.equal((await taskRequest('/responses',{...input,observed_quantity:9,idempotency_key:'guess'},{csrf})).body.code,'CAPTURE_ALREADY_RECEIVED');
  assert.equal((await taskRequest('/uploads',{...csrfInput,idempotency_key:'guess-upload'},{csrf})).body.code,'CAPTURE_ALREADY_RECEIVED');
  assert.equal(storageCalls,storageBeforeProbe);assert.equal((await taskRequest('/responses',input,{csrf})).body.replayed,true);
  await page.reload();await page.getByRole('status').filter({hasText:'1 of 5'}).waitFor();assert.equal(await article(0).getByRole('spinbutton').count(),0);
  record('early_photo_size_refusal','offline_upload_and_lost_admission_retry','lost_committed_count_exact_retry','one_submission_blind_probe_refusal','reload_committed_progress');
  const recount=await physical({line_id:String(line.id),action:'recount_required',reason:'Synthetic independent review requests recount',expected_observation_digest:line.physical_observation.inputDigest,idempotency_key:'browser-recount'},`/${sessionId}/resolutions`);
  assert.equal(recount.body.applied,true,JSON.stringify(recount));await page.getByRole('button',{name:'Refresh task access'}).click();
  await article(0).getByRole('spinbutton').fill('10');await article(0).getByLabel('Item and label photo').setInputFiles(photo);await article(0).getByRole('button',{name:'Confirm count and send',exact:true}).click();
  await article(0).getByText('Count received. Any review stays with the assigned reviewers.').waitFor();line=(await fixture.pool.query('select * from inventory_count_lines where id=$1',[line.id])).rows[0];
  assert.equal(line.payload.versions.filter(v=>v.kind==='observation').length,2);record('reviewer_opened_blind_recount');
  // Fail an upload before admission, then expire/revoke current authority before
  // retry. The same retained page input cannot inherit authority on reconnect.
  failStorage=true;await article(1).getByRole('spinbutton').fill('10');await article(1).getByLabel('Item and label photo').setInputFiles(photo);await article(1).getByRole('button',{name:'Confirm count and send',exact:true}).click();await article(1).getByRole('alert').waitFor();
  await fixture.pool.query("update inventory_capture_tasks set credential_expires_at=now()-interval '1 second' where id=$1",[task]);
  const expiryStorage=storageCalls;await article(1).getByRole('button',{name:'Confirm count and send',exact:true}).click();await article(1).getByRole('alert').filter({hasText:'expired or was revoked'}).waitFor();assert.equal(storageCalls,expiryStorage);
  await page.getByRole('button',{name:'Refresh task access'}).click();await page.getByRole('button',{name:'Retry loading task'}).waitFor();assert.equal(await page.getByRole('article').count(),0);
  invitation=await issue();await page.goto(`${origin}/capture#invitation=${invitation}`);await page.getByLabel('I understand the photos go to this entity’s authorized reviewers.').check();await page.getByRole('button',{name:'Open my assigned task'}).click();await page.getByRole('status').filter({hasText:'1 of 5'}).waitFor();
  failStorage=true;await article(1).getByRole('spinbutton').fill('10');await article(1).getByLabel('Item and label photo').setInputFiles(photo);await article(1).getByRole('button',{name:'Confirm count and send',exact:true}).click();await article(1).getByRole('alert').waitFor();
  await fixture.pool.query("update client_assignments set status='suspended' where id='capture-assignment'");
  const revokedStorage=storageCalls;await article(1).getByRole('button',{name:'Confirm count and send',exact:true}).click();await article(1).getByRole('alert').waitFor();assert.equal(storageCalls,revokedStorage);
  await page.getByRole('button',{name:'Refresh task access'}).click();await page.getByRole('button',{name:'Retry loading task'}).waitFor();assert.equal(await page.getByRole('article').count(),0);
  await fixture.pool.query("update client_assignments set status='active' where id='capture-assignment'");await page.getByRole('button',{name:'Retry loading task'}).click();await page.getByRole('status').filter({hasText:'1 of 5'}).waitFor();
  record('credential_expiry_on_upload_retry_and_reconnect','assignment_revocation_on_upload_retry_and_reconnect');
  failStorage=false;
  for(let i=1;i<5;i++){await article(i).getByRole('spinbutton').fill('10');await article(i).getByLabel('Item and label photo').setInputFiles(photo);await article(i).getByRole('button',{name:'Confirm count and send',exact:true}).click();if(i<4)await page.getByRole('status').filter({hasText:`${i+1} of 5`}).waitFor();}
  await page.getByRole('status').filter({hasText:'This task is complete'}).waitFor();await page.reload();await page.getByRole('status').filter({hasText:'This task is complete'}).waitFor();
  assert.equal(await page.getByRole('article').count(),0);
  const endView=await taskRequest();assert.equal(endView.body.completed,true);
  assert.equal((await taskRequest('/uploads',{...csrfInput,idempotency_key:'after-complete'},{csrf:endView.body.csrf})).body.code,'CAPTURE_ALREADY_RECEIVED');
  const authless=await page.evaluate(async()=>{const r=await fetch('/api/donna/firms/snapshot');return r.status;});assert.equal(authless,401,'capture fetch carries no identity header and cookie path grants no firm authority');
  assert.ok(!wire.filter(row=>row.path==='/api/donna/firms/snapshot').some(row=>row.cookie.includes('__Secure-donna_capture')));
  await request(`/api/donna/physical/tasks/${task}/revoke${scope}`,{firm_id:fixture.a.firmId,client_id:fixture.a.clientId,idempotency_key:'browser-revoke'});
  assert.equal((await taskRequest()).body.code,'CAPTURE_CREDENTIAL_REFUSED');await page.getByRole('button',{name:'Refresh task access'}).click();await page.getByRole('button',{name:'Retry loading task'}).waitFor();
  record('completion_acknowledgment_and_upload_refusal','task_revocation_reconnect','no_financial_authority');
  // Delay a real exchange's response after its PostgreSQL commit. A same-tab
  // replacement must cancel the old browser request before issuing the next
  // credential, so late Set-Cookie cannot displace the newer cookie.
  const fresh=await physical({location_id:'shelf',item_ids:Array.from({length:5},(_,i)=>`item-${i}`),idempotency_key:'browser-replacement-open'});
  assert.equal(fresh.body.applied,true,JSON.stringify(fresh));
  const assigned=await request(`/api/donna/physical/tasks${scope}`,{firm_id:fixture.a.firmId,client_id:fixture.a.clientId,
    session_id:String(fresh.body.session.id),principal_type:'firm_collaborator',principal_id:'capture-worker',name:'Replacement race check',idempotency_key:'browser-replacement-task'});
  assert.equal(assigned.status,200);const nextTask=assigned.body.taskId;
  // The old cookie belongs to another actual valid task ID, and cannot read this task.
  const wrongTask=await page.evaluate(async id=>{const r=await fetch(`/api/donna/physical/capture/tasks/${id}`);return r.json();},nextTask);
  assert.equal(wrongTask.code,'CAPTURE_CREDENTIAL_REFUSED');
  const issueNext=async()=>{
    const result=await request(`/api/donna/physical/tasks/${nextTask}/invitation${scope}`,{firm_id:fixture.a.firmId,client_id:fixture.a.clientId,idempotency_key:randomUUID()});
    assert.equal(result.status,200);secrets.push(result.body.invitation);return result.body.invitation;
  };
  const firstSecret=await issueNext();let committed,closed,releaseExchange;
  const exchangeCommitted=new Promise(resolve=>{committed=resolve;}),exchangeClosed=new Promise(resolve=>{closed=resolve;});
  holdExchange={committed:release=>{releaseExchange=release;committed();},closed};
  await page.goto(`${origin}/capture#invitation=${firstSecret}`);
  await page.getByLabel('I understand the photos go to this entity’s authorized reviewers.').check();await page.getByRole('button',{name:'Open my assigned task'}).click();
  await exchangeCommitted;const secondSecret=await issueNext();
  await page.evaluate(secret=>{location.hash=`invitation=${secret}`;},secondSecret);
  await page.getByRole('button',{name:'Open my assigned task',exact:true}).waitFor();
  await exchangeClosed;assert.equal(new URL(page.url()).hash,'');
  await page.getByLabel('I understand the photos go to this entity’s authorized reviewers.').check();await page.getByRole('button',{name:'Open my assigned task'}).click();
  await page.getByRole('heading',{name:'Replacement race check'}).waitFor();
  const newCookie=(await context.cookies(`${origin}/api/donna/physical/capture/tasks/${nextTask}`)).find(row=>row.name==='__Secure-donna_capture');
  assert.ok(newCookie);secrets.push(newCookie.value);releaseExchange();
  const neighbor=await page.evaluate(async id=>{const r=await fetch(`/api/donna/physical/capture/tasks/${id}`);return {status:r.status,body:await r.json()};},nextTask);
  assert.equal(neighbor.status,200);assert.equal(neighbor.body.items.length,5);
  assert.equal((await context.cookies()).find(row=>row.name===newCookie.name).value,newCookie.value,'late old response cannot replace the new task cookie');
  record('actual_task_id_scope_refusal_and_valid_neighbor','replacement_invitation_cancels_committed_exchange_before_late_cookie');
  const persisted=(await fixture.pool.query("select (select count(*)::int from inventory_operations where operation_type='count_correction') corrections,(select count(*)::int from ledger_journals) journals")).rows[0];assert.deepEqual(persisted,{corrections:0,journals:0});
  const storage=await page.evaluate(()=>({local:JSON.stringify(localStorage),session:JSON.stringify(sessionStorage),url:location.href}));
  const audit=JSON.stringify((await fixture.pool.query('select metadata from audit_events')).rows);
  for(const secret of secrets){assert.ok(!audit.includes(secret),'no raw capture secret in persisted audit');assert.ok(!JSON.stringify(storage).includes(secret),'no invitation or task credential in browser storage or URL');assert.ok(!JSON.stringify(wire.map(({path,origin,referer})=>({path,origin,referer}))).includes(secret),'no secret in URL or referrer');}
  assert.doesNotMatch(await page.locator('body').innerText(),/Expected|Valuation|Journal|Price|Financial conversation/);
  assert.equal(errors.length,0,JSON.stringify(errors));record('no_capture_secrets_in_storage_urls_referrers','zero_stock_or_ledger_mutations');
  const receipt={kind:'automated_delegated_chromium_browser',browserVersion:browser.version(),postgres:(await fixture.pool.query('show server_version')).rows[0].server_version,
    transport:'disposable self-signed local HTTPS; certificate accepted only by test context; Secure cookies and deployed CSP unchanged',
    boundaries:{identity:'synthetic Supabase token/user fixture; real identity exchange handler',storage:'synthetic private object provider; real evidence registration and byte verification',routes:'real deployed physical rewrite and donna-router entrypoint',database:'disposable local, full migration chain'},passed,
    realDevices:'not_run: no iOS/Android hardware, OS camera or camera-denial exercise',backgrounding:'not_run: no native lifecycle exercise',lowBandwidth:'not_run: offline/lost replies are not measured bandwidth',durableOfflineMedia:'not_implemented',customerEnrollment:'none',serviceSignoff:'not_issued'};
  if(process.env.DONNA_BROWSER_RECEIPT)await writeFile(process.env.DONNA_BROWSER_RECEIPT,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(receipt,null,2));
}catch(error){console.error(error);if(page)console.error(await page.locator('body').innerText().catch(()=>''));throw error;}
finally{
  await browser?.close();for(const owned of [server,plainServer])if(owned){owned.closeAllConnections();await new Promise(resolve=>owned.close(resolve));}
  globalThis.fetch=realFetch;__resetFirmDbPoolForTests();for(const key of Object.keys(env))if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
  await fixture.dispose();await rm(directory,{recursive:true,force:true});
}
