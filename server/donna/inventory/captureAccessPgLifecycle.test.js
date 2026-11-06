import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { handleDonnaApiRequest } from '../api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../firmDb.js';
import { setClientFlagStage } from '../clientConfig.js';
import { applyInventoryOperation } from './db.js';

test('mounted delegated capture: persisted identity, one-use exchange, blind scope, private admission and current revocation', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
  const database = `capture_access_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${database}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 }); __setFirmDbPoolForTests(pool);
  const env = { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'infra', DONNA_DEFAULT_FIRM_ID: 'f', DONNA_DESKTOP_BLOB_DIR: '',
    PUBLIC_APP_URL: '', APP_BASE_URL: '', SUPABASE_URL: 'https://capture.invalid', SUPABASE_ANON_KEY: 'fixture',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SERVICE_KEY: '', SUPABASE_SECRET_KEY: '',
    DONNA_AUTH_ALLOWED_EMAILS: '', DONNA_EVIDENCE_BUCKET: 'donna-evidence', SUPABASE_EVIDENCE_BUCKET: '' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const realFetch = globalThis.fetch, objects = new Map();
  let storageCalls = 0, holdPut = null;
  globalThis.fetch = async (address, init = {}) => {
    const remote = new URL(String(address));
    if (remote.origin !== 'https://capture.invalid') throw new Error('Unexpected outbound provider');
    if (remote.pathname === '/auth/v1/user') {
      const actor = init.headers.Authorization.replace('Bearer ', '');
      if (!['owner','member','reviewer','junior','worker2','viewer'].includes(actor)) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ id: `user-${actor}`, email: `${actor}@capture.invalid` }));
    }
    storageCalls++;
    if (remote.pathname.startsWith('/storage/v1/object/upload/sign/')) {
      return new Response(JSON.stringify({ url: `/object/upload/${remote.pathname.slice('/storage/v1/object/upload/sign/'.length)}` }));
    }
    const prefix = init.method === 'PUT' ? '/storage/v1/object/upload/' : '/storage/v1/object/';
    const key = decodeURIComponent(remote.pathname.slice(prefix.length));
    if (init.method === 'PUT') {
      if (holdPut) await holdPut();
      if (objects.has(key)) return new Response('{}', { status: 409 });
      objects.set(key, Buffer.from(init.body)); return new Response('{}');
    }
    return objects.has(key) ? new Response(objects.get(key)) : new Response('{}', { status: 404 });
  };
  const server = http.createServer((req, res) => Promise.resolve(handleDonnaApiRequest(req, res)).catch(() => { res.statusCode=500; res.end('{}'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_APP_URL = origin;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = realFetch;
    __resetFirmDbPoolForTests(); await pool.end();
    for (const [key, value] of Object.entries(saved)) if (value == null) delete process.env[key]; else process.env[key] = value;
    await admin.query(`drop database "${database}"`); await admin.end();
  });
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const directory = new URL('../../../db/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, directory), 'utf8'));
  await pool.query(`insert into firms(id,name,slug) values('f','F','f'),('foreign-f','Foreign','foreign');
    insert into clients(id,firm_id,company_name,status) values('own','f','Own','active'),('neighbor','f','Neighbor','active'),('foreign','foreign-f','Foreign','active');
    insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level) values('member','f','user-member','member@capture.invalid','Member','admin','active','owner');
    insert into firm_collaborators(id,firm_id,user_id,email,name,status) values
      ('owner','f','user-owner','owner@capture.invalid','Owner','active'),('reviewer','f','user-reviewer','reviewer@capture.invalid','Reviewer','active'),
      ('junior','f','user-junior','junior@capture.invalid','Junior','active'),('worker2','f','user-worker2','worker2@capture.invalid','Worker 2','active'),('viewer','f','user-viewer','viewer@capture.invalid','Viewer','active');
    insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role) values
      ('oa','f','own','firm_collaborator','owner','owner'),('on','f','neighbor','firm_collaborator','owner','owner'),
      ('ra','f','own','firm_collaborator','reviewer','reviewer'),('rn','f','neighbor','firm_collaborator','reviewer','reviewer'),
      ('ja','f','own','firm_collaborator','junior','junior'),('wn','f','neighbor','firm_collaborator','worker2','junior'),('va','f','own','firm_collaborator','viewer','viewer');`);
  const call = (path, { token, data, cookie, csrf, method = data ? 'POST' : 'GET', requestOrigin = origin } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${origin}${path}`, { method, headers: { 'Content-Type':'application/json', Origin:requestOrigin,
      ...(token ? { Authorization:`Bearer ${token}` } : {}), ...(cookie ? { Cookie:cookie } : {}), ...(csrf ? { 'X-Donna-Capture-CSRF':csrf } : {}) } }, res => {
      let text=''; res.on('data',chunk=>text+=chunk); res.on('end',()=>resolve({ status:res.statusCode, body:JSON.parse(text||'{}'), headers:res.headers }));
    }); req.on('error',reject); req.end(data ? JSON.stringify(data) : undefined);
  });
  const base = '/api/donna/physical', scope = { firm_id:'f', client_id:'own' };
  const physical = (clientId, data, suffix='') => call(`/api/donna/firms/inventory/physical-reconciliation${suffix}?firm_id=f&client_id=${clientId}`, { token:'owner', data });
  const setFlag = async (clientId, flagKey, stage='canary') => {
    const connection=await pool.connect(); try { await setClientFlagStage(connection,{ firmId:'f',clientId,flagKey,stage,actorType:'firm_member',actorId:'member',reason:'Isolated synthetic qualification' }); } finally { connection.release(); }
  };
  for (const clientId of ['own','neighbor']) {
    for (const flag of ['INVENTORY_CORE','PHYSICAL_RECONCILIATION']) await setFlag(clientId,flag);
    await pool.query('update clients set profile=$1::jsonb where id=$2', [JSON.stringify({ physical_reconciliation:{ reviewer:{ principalType:'firm_member',principalId:'member' }, senior:{ principalType:'firm_collaborator',principalId:'reviewer' }, calendar:{ timeZone:'Europe/London',workingDays:[1,2,3,4,5],holidays:[] } } }),clientId]);
    await pool.query(`insert into inventory_units_of_measure(id,firm_id,client_id,code,name,kind) values($1,'f',$2,'EA','Each','count');
      `,[`${clientId}-each`,clientId]);
    await pool.query("insert into inventory_locations(id,firm_id,client_id,code,name) values($1,'f',$2,'A','Shelf A')",[`${clientId}-shelf`,clientId]);
    for(let i=0;i<5;i++) {
      const itemId=`${clientId}-item-${i}`;
      await pool.query("insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values($1,'f',$2,$1,$1,$3)",[itemId,clientId,`${clientId}-each`]);
      const connection=await pool.connect(); try { assert.equal((await applyInventoryOperation({ client:connection,firmId:'f',clientId,actorId:'member',itemId,locationId:`${clientId}-shelf`,uomId:`${clientId}-each`,operationType:'opening_balance',quantity:10,unitCostAmount:5,unitCostCurrency:'GBP',occurredAt:'2026-01-01',idempotencyKey:`opening-${itemId}` })).applied,true); } finally { connection.release(); }
    }
  }
  const disabledAssignment={...scope,session_id:'1',principal_type:'firm_collaborator',principal_id:'junior',name:'Disabled',idempotency_key:'disabled'};
  assert.equal((await call(`${base}/tasks`,{token:'owner',data:disabledAssignment})).body.code,'CAPTURE_DISABLED');
  for (const id of ['own','neighbor']) await setFlag(id,'PHYSICAL_CAPTURE_ACCESS');
  const opened = await physical('own',{ location_id:'own-shelf',item_ids:Array.from({length:5},(_,i)=>`own-item-${i}`),idempotency_key:'open' });
  assert.equal(opened.body.applied,true,JSON.stringify(opened));
  const neighbor = await physical('neighbor',{ location_id:'neighbor-shelf',item_ids:Array.from({length:5},(_,i)=>`neighbor-item-${i}`),idempotency_key:'open-neighbor' });
  assert.equal(neighbor.body.applied,true,JSON.stringify(neighbor));
  const assignment={ ...scope,session_id:String(opened.body.session.id),principal_type:'firm_collaborator',principal_id:'junior',name:'Count shelf A',idempotency_key:'assign' };
  assert.equal((await call(`${base}/tasks`,{token:'infra',data:assignment})).status,401);
  assert.equal((await call(`${base}/tasks`,{token:'junior',data:assignment})).status,403);
  assert.equal((await call(`${base}/tasks`,{token:'owner',data:{...assignment,principal_id:'viewer'}})).status,403);
  assert.equal((await call(`${base}/tasks`,{token:'owner',data:{...assignment,client_id:'neighbor'}})).status,403);
  assert.equal((await call(`${base}/tasks`,{token:'owner',data:{...assignment,firm_id:'foreign-f',client_id:'foreign'}})).status,403);
  const assigned=await call(`${base}/tasks`,{token:'owner',data:assignment}); assert.equal(assigned.status,200,JSON.stringify(assigned));
  const id=assigned.body.taskId;
  assert.equal((await call(`${base}/tasks`,{token:'owner',data:assignment})).body.taskId,id);
  assert.equal((await call(`${base}/tasks`,{token:'owner',data:{...assignment,name:'Changed'}})).body.code,'CAPTURE_IDEMPOTENCY_CONFLICT');
  const issue = (taskId, clientId='own', key='invitation') => call(`${base}/tasks/${taskId}/invitation`,{token:'owner',data:{firm_id:'f',client_id:clientId,idempotency_key:key}});
  const invitation=await issue(id); assert.equal(invitation.status,200,JSON.stringify(invitation));
  const raw=invitation.body.invitation;
  assert.equal((await issue(id)).body.invitation,undefined,'retries never regenerate/reveal secret');
  assert.equal((await call(`${base}/capture/exchange`,{token:'junior'})).status,405);
  assert.equal((await pool.query('select invitation_used_at from inventory_capture_tasks where id=$1',[id])).rows[0].invitation_used_at,null);
  assert.equal((await call(`${base}/capture/exchange`,{token:'worker2',data:{invitation:raw}})).status,403,'forwarding does not delegate');
  await pool.query("update inventory_capture_tasks set invitation_expires_at=now()-interval '1 second' where id=$1",[id]);
  assert.equal((await call(`${base}/capture/exchange`,{token:'junior',data:{invitation:raw}})).body.code,'CAPTURE_INVITATION_REFUSED');
  await pool.query("update inventory_capture_tasks set invitation_expires_at=now()+interval '15 minutes' where id=$1",[id]);
  const exchanged=await call(`${base}/capture/exchange`,{token:'junior',data:{invitation:raw}}); assert.equal(exchanged.status,200,JSON.stringify(exchanged));
  assert.match(exchanged.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict/);
  const credential=exchanged.headers['set-cookie'][0].split(';')[0], csrf=exchanged.body.csrf;
  const worker = (suffix='',data, extra={}) => call(`${base}/capture/tasks/${id}${suffix}`,{cookie:credential,csrf,data,...extra});
  assert.equal((await call(`${base}/capture/exchange`,{token:'junior',data:{invitation:raw}})).status,403);
  const view=await worker(); assert.equal(view.status,200); assert.equal(view.body.items.length,5);
  assert.equal(view.headers['cache-control'],'no-store'); assert.equal(view.headers['referrer-policy'],'no-referrer');
  assert.doesNotMatch(JSON.stringify(view.body),/"(?:expected|quantity|variance|cost|price|valuation|journal|ask|profile|physical_basis)/);
  assert.equal((await call('/api/donna/firms/snapshot',{cookie:credential})).status,401,'cookie grants no book access');
  assert.equal((await worker('/resolutions',{action:'confirmed_shortage'})).status,404);
  const neighborAssignment=await call(`${base}/tasks`,{token:'owner',data:{...assignment,client_id:'neighbor',session_id:String(neighbor.body.session.id),principal_id:'worker2',idempotency_key:'assign-neighbor'}});
  assert.equal(neighborAssignment.status,200,JSON.stringify(neighborAssignment)); const neighborId=neighborAssignment.body.taskId;
  assert.equal((await call(`${base}/capture/tasks/${neighborId}`,{cookie:credential})).status,403);
  const photo=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS8cAAAAASUVORK5CYII=','base64');
  const photoInput={line_id:String(opened.body.lines[0].id),filename:'count.png',mime_type:'image/png',base64:photo.toString('base64'),idempotency_key:'photo'};
  let before=storageCalls;
  assert.equal((await worker('/uploads',photoInput,{csrf:'bad'})).body.code,'CAPTURE_CSRF_REFUSED');
  assert.equal((await worker('/uploads',photoInput,{requestOrigin:'https://attacker.invalid'})).body.code,'CAPTURE_ORIGIN_REFUSED');
  assert.equal((await worker('/uploads',{...photoInput,line_id:String(neighbor.body.lines[0].id)})).body.code,'CAPTURE_LINE_REFUSED');
  assert.equal((await worker('/uploads',{...photoInput,mime_type:'image/jpeg'})).body.code,'CAPTURE_PHOTO_REQUIRED');
  assert.equal(storageCalls,before);
  const upload=await worker('/uploads',photoInput); assert.equal(upload.status,200,JSON.stringify(upload));
  const replayUpload=await worker('/uploads',photoInput); assert.deepEqual(replayUpload.body,upload.body);
  assert.equal((await worker('/uploads',{...photoInput,filename:'changed.png'})).body.code,'CAPTURE_IDEMPOTENCY_CONFLICT');
  const document=(await pool.query('select * from documents where id=$1',[upload.body.evidence.documentId])).rows[0];
  assert.equal(document.parse_status,'skipped'); assert.equal(document.parse_run_id,null); assert.equal(document.payload.physical_provenance.actor_id,'junior');
  const response={line_id:photoInput.line_id,observed_quantity:8,observed_at:new Date().toISOString(),uncertain:false,human_confirmed:true,evidence_refs:[upload.body.evidence],idempotency_key:'c'.repeat(200)};
  assert.equal((await worker('/responses',{...response,line_id:String(opened.body.lines[1].id)})).body.code,'CAPTURE_EVIDENCE_REFUSED');
  const submitted=await worker('/responses',response); assert.equal(submitted.status,200,JSON.stringify(submitted));
  assert.deepEqual(Object.keys(submitted.body).sort(),['lineId','received','replayed']);
  assert.equal((await worker('/responses',response)).body.replayed,true);
  assert.equal((await worker('/responses',{...response,observed_quantity:9})).body.code,'idempotency_conflict');
  const observation=(await pool.query('select physical_observation from inventory_count_lines where id=$1',[photoInput.line_id])).rows[0].physical_observation;
  assert.equal(observation.actorId,'junior'); assert.equal(observation.quantity,8); assert.equal(observation.variance,-2);
  assert.equal((await pool.query("select count(*) from inventory_operations where operation_type<>'opening_balance'")).rows[0].count,'0');
  assert.equal((await pool.query('select count(*) from ledger_journals')).rows[0].count,'0');
  // A task cannot discover the blind expectation by replacing a mismatch until
  // the writer becomes terminal. Upload probes must have the same behavior too.
  const attempts = [{ input: response, status: 'variance' }];
  for (const [index, quantity, uncertain, status] of [[1,null,true,'uncertain'],[2,10,false,'matched']]) {
    const uploadInput={...photoInput,line_id:String(opened.body.lines[index].id),idempotency_key:`blind-photo-${index}`};
    const uploaded=await worker('/uploads',uploadInput); assert.equal(uploaded.status,200,JSON.stringify(uploaded));
    const input={...response,line_id:uploadInput.line_id,observed_quantity:quantity,uncertain,evidence_refs:[uploaded.body.evidence],idempotency_key:`blind-count-${index}`};
    assert.equal((await worker('/responses',input)).status,200);
    attempts.push({input,status});
  }
  for (const {input,status} of attempts) {
    const beforeLine=(await pool.query('select physical_status,physical_observation,payload from inventory_count_lines where id=$1',[input.line_id])).rows[0];
    assert.equal(beforeLine.physical_status,status);
    const probe=await worker('/responses',{...input,observed_quantity:7,uncertain:false,idempotency_key:`probe-${status}`});
    assert.equal(probe.status,409); assert.equal(probe.body.code,'CAPTURE_ALREADY_RECEIVED',status);
    const beforeStorage=storageCalls;
    const uploadProbe=await worker('/uploads',{...photoInput,line_id:input.line_id,idempotency_key:`probe-photo-${status}`});
    assert.equal(uploadProbe.status,409); assert.equal(uploadProbe.body.code,'CAPTURE_ALREADY_RECEIVED',status);
    assert.equal(storageCalls,beforeStorage,'a received-count upload probe never reaches storage');
    const replay=await worker('/responses',input); assert.equal(replay.status,200); assert.equal(replay.body.replayed,true,status);
    assert.deepEqual((await pool.query('select physical_status,physical_observation,payload from inventory_count_lines where id=$1',[input.line_id])).rows[0],beforeLine,'probes and replay cannot supersede the observation');
  }
  const recount=await physical('own',{line_id:response.line_id,action:'recount_required',reason:'Independent review requests a fresh blind count',expected_observation_digest:observation.inputDigest,idempotency_key:'authorize-recount'},`/${opened.body.session.id}/resolutions`);
  assert.equal(recount.body.applied,true,JSON.stringify(recount));
  const recountUpload=await worker('/uploads',{...photoInput,idempotency_key:'recount-photo'}); assert.equal(recountUpload.status,200,JSON.stringify(recountUpload));
  const recountInput={...response,observed_quantity:7,evidence_refs:[recountUpload.body.evidence],observed_at:new Date().toISOString(),idempotency_key:'recount-response'};
  assert.equal((await worker('/responses',recountInput)).status,200,'reviewer recount opens one fresh capture attempt');
  assert.equal((await worker('/responses',{...recountInput,observed_quantity:6,idempotency_key:'another-recount-guess'})).body.code,'CAPTURE_ALREADY_RECEIVED');
  assert.equal((await worker('/responses',recountInput)).body.replayed,true);
  await pool.query("update inventory_capture_tasks set credential_expires_at=now()-interval '1 second' where id=$1",[id]);
  before=storageCalls; assert.equal((await worker('/uploads',photoInput)).body.code,'CAPTURE_CREDENTIAL_REFUSED'); assert.equal(storageCalls,before);
  await pool.query("update inventory_capture_tasks set credential_expires_at=now()+interval '30 minutes' where id=$1",[id]);
  await pool.query("update client_assignments set status='suspended' where id='ja'");
  assert.equal((await worker()).status,403,'current assignment revocation affects issued credential');
  await pool.query("update client_assignments set status='active' where id='ja'");
  // Revocation completes while a private upload is in flight; its bytes cannot
  // acquire an evidence document or be submitted using the old task credential.
  let releasePut, enteredPut;
  const entered=new Promise(resolve=>{enteredPut=resolve;}); const released=new Promise(resolve=>{releasePut=resolve;});
  holdPut=async()=>{enteredPut();await released;};
  const pending=worker('/uploads',{...photoInput,line_id:String(opened.body.lines[4].id),idempotency_key:'pending'});
  await entered;
  const revoked=await call(`${base}/tasks/${id}/revoke`,{token:'owner',data:{...scope,idempotency_key:'revoke'}}); assert.equal(revoked.status,200);
  releasePut(); holdPut=null;
  assert.equal((await pending).status,403);
  assert.equal((await worker('/responses',response)).status,403,'even a replay requires current authority');
  assert.equal((await pool.query("select count(*) from documents where client_id='own'")).rows[0].count,'4','revoked pending upload never admitted');
  assert.equal((await pool.query('select checksum_sha256 from documents where id=$1',[document.id])).rows[0].checksum_sha256,createHash('sha256').update(photo).digest('hex'),'retained evidence is preserved');
  const neighborInvite=await issue(neighborId,'neighbor'); const neighborExchange=await call(`${base}/capture/exchange`,{token:'worker2',data:{invitation:neighborInvite.body.invitation}});
  assert.equal(neighborExchange.status,200,JSON.stringify(neighborExchange));
  const neighborCookie=neighborExchange.headers['set-cookie'][0].split(';')[0];
  const neighborUpload=await call(`${base}/capture/tasks/${neighborId}/uploads`,{cookie:neighborCookie,csrf:neighborExchange.body.csrf,data:{...photoInput,line_id:String(neighbor.body.lines[0].id)}});
  assert.equal(neighborUpload.status,200,JSON.stringify(neighborUpload));
  assert.equal((await call(`${base}/capture/tasks/${neighborId}/responses`,{cookie:neighborCookie,csrf:neighborExchange.body.csrf,data:{...response,line_id:String(neighbor.body.lines[0].id),evidence_refs:[upload.body.evidence]}})).body.code,'CAPTURE_EVIDENCE_REFUSED');
  assert.equal((await call(`${base}/capture/tasks/${neighborId}/responses`,{cookie:neighborCookie,csrf:neighborExchange.body.csrf,data:{...response,line_id:String(neighbor.body.lines[0].id),observed_quantity:10,evidence_refs:[neighborUpload.body.evidence]}})).status,200,'neighbor remains authorized');
  assert.equal((await call(`${base}/capture/tasks/${neighborId}/uploads`,{cookie:neighborCookie,csrf:neighborExchange.body.csrf,data:{...photoInput,line_id:String(neighbor.body.lines[1].id),base64:'a'.repeat(2800001)}})).status,400,'oversized media refused');
  await pool.query("update firm_collaborators set user_id='recycled-user' where id='worker2'");
  assert.equal((await call(`${base}/capture/tasks/${neighborId}`,{cookie:neighborCookie})).status,403,'recycled seat id cannot inherit credential');
  await pool.query("update firm_collaborators set user_id='user-worker2' where id='worker2'");
  const replaced=await issue(neighborId,'neighbor','replace-invitation');
  assert.equal((await call(`${base}/capture/tasks/${neighborId}`,{cookie:neighborCookie})).status,403,'fresh invitation invalidates previously issued credential');
  assert.equal((await issue(neighborId,'neighbor','invitation')).body.invitation,undefined,'an older idempotency key cannot mint again');
  const exchanges=await Promise.all([1,2].map(()=>call(`${base}/capture/exchange`,{token:'worker2',data:{invitation:replaced.body.invitation}})));
  assert.deepEqual(exchanges.map(result=>result.status).sort(),[200,403],'concurrent POST exchange consumes once');
  const renewed=exchanges.find(result=>result.status===200), renewedCookie=renewed.headers['set-cookie'][0].split(';')[0];
  for (const line of neighbor.body.lines.slice(1)) {
    const uploaded=await call(`${base}/capture/tasks/${neighborId}/uploads`,{cookie:renewedCookie,csrf:renewed.body.csrf,data:{...photoInput,line_id:String(line.id),idempotency_key:`complete-photo-${line.id}`}});
    assert.equal(uploaded.status,200,JSON.stringify(uploaded));
    const counted=await call(`${base}/capture/tasks/${neighborId}/responses`,{cookie:renewedCookie,csrf:renewed.body.csrf,data:{...response,line_id:String(line.id),observed_quantity:10,evidence_refs:[uploaded.body.evidence],idempotency_key:`complete-count-${line.id}`}});
    assert.equal(counted.status,200,JSON.stringify(counted));
  }
  const completed=await call(`${base}/capture/tasks/${neighborId}`,{cookie:renewedCookie});
  assert.deepEqual(completed.body.items,[]); assert.equal(completed.body.completed,true);
  before=storageCalls;
  assert.equal((await call(`${base}/capture/tasks/${neighborId}/uploads`,{cookie:renewedCookie,csrf:renewed.body.csrf,data:{...photoInput,line_id:String(neighbor.body.lines[0].id),idempotency_key:'after-completion'}})).body.code,'CAPTURE_ALREADY_RECEIVED');
  assert.equal(storageCalls,before);
  assert.equal((await call(`${base}/capture/tasks/${neighborId}/responses`,{cookie:renewedCookie,csrf:renewed.body.csrf,data:{...response,line_id:String(neighbor.body.lines[0].id),observed_quantity:10,evidence_refs:[neighborUpload.body.evidence]}})).body.replayed,true,'completion preserves committed request acknowledgement');
  assert.equal((await pool.query(`select count(*) from audit_events a where a.action='inventory.capture.evidence_admitted'
    and not exists(select 1 from documents d where d.id=a.metadata->>'document_id' and d.firm_id=a.firm_id and d.client_id=a.client_id)`)).rows[0].count,'0','no evidence receipt without a canonical document');
  const persisted=JSON.stringify((await pool.query('select * from inventory_capture_tasks')).rows)+JSON.stringify((await pool.query("select * from audit_events where action like 'inventory.capture.%'")).rows);
  assert.ok(!persisted.includes(raw)); assert.ok(!persisted.includes(credential.split('=')[1]));
  await pool.query("delete from clients where id='own'");
  assert.equal((await pool.query('select count(*) from inventory_capture_tasks where id=$1',[id])).rows[0].count,'0');
  assert.equal((await worker()).status,403,'scope deletion cannot revive an issued credential');
});
