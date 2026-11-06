// The real canonical ask/delivery/case lifecycle, including process-independent
// review-clock retries. Own a fresh complete-schema database, never erase audits.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { setClientFlagStage } from '../clientConfig.js';
import { applyInventoryOperation } from './db.js';
import { openPhysicalReconciliation, observePhysicalReconciliation, resolvePhysicalReconciliation, getPhysicalReconciliation } from './physicalReconciliationDb.js';
import { acknowledgePhysicalAsk, sweepPhysicalReviewAsks } from './physicalReconciliationAsks.js';

let admin, databaseName, testUrl;
before(async () => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL required for physical ask PostgreSQL proof');
  admin = new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL}); await admin.connect();
  databaseName = `physical_asks_${randomUUID().replaceAll('-','')}`;
  await admin.query(`create database "${databaseName}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname=`/${databaseName}`; testUrl=url.toString();
  const db=new pg.Client({connectionString:testUrl});await db.connect();
  try {
    await db.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
    const root=new URL('../../../db/migrations/',import.meta.url);
    for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort()) await db.query(await readFile(new URL(f,root),'utf8'));
  }finally{await db.end();}
});
after(async()=>{if(admin)try{if(databaseName)await admin.query(`drop database if exists "${databaseName}" with (force)`);}finally{await admin.end();}});

async function fixture(fn){
  const client=new pg.Client({connectionString:testUrl});await client.connect();
  const id=`asks-${randomUUID()}`, firmId=`${id}-firm`,clientId=`${id}-client`;
  const seats=Object.fromEntries(['counter','reviewer','senior','viewer','founder'].map(name=>[name,`${id}-${name}`]));
  const a={client,firmId,clientId,actorId:seats.counter,actorType:'firm_collaborator'};
  const principal=key=>({principalType:'firm_collaborator',principalId:seats[key]});
  const calendar={timeZone:'Europe/London',workingDays:[1,2,3,4,5],holidays:[]};
  const coverage={reviewer:principal('reviewer'),senior:principal('senior'),calendar};
  const itemId=`${id}-item`,uomId=`${id}-each`,locationId=`${id}-loc`,documentId=`${id}-photo`,checksum='c'.repeat(64);
  let n=0;const command=()=>`${id}-${++n}`;
  const tx=async fn=>{await client.query('begin');try{const result=await fn();await client.query('commit');return result;}catch(e){await client.query('rollback');throw e;}};
  try{
    await client.query('insert into firms(id,name,slug) values($1,$1,$1)',[firmId]);
    await client.query('insert into clients(id,firm_id,company_name,profile) values($1,$2,$1,$3::jsonb)',[clientId,firmId,JSON.stringify({physical_reconciliation:coverage})]);
    await client.query("insert into firm_members(id,firm_id,email,name,status,access_level) values($1,$2,$3,$1,'active','owner')",[seats.founder,firmId,`${seats.founder}@example.invalid`]);
    for(const[key,actorId]of Object.entries(seats).filter(([key])=>key!=='founder')){
      await client.query("insert into firm_collaborators(id,firm_id,email,name,status) values($1,$2,$3,$1,'active')",[actorId,firmId,`${actorId}@example.invalid`]);
      await client.query("insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role) values($1,$2,$3,'firm_collaborator',$4,$5)",[`${actorId}-assignment`,firmId,clientId,actorId,key==='viewer'?'viewer':key==='counter'?'owner':'senior']);
    }
    for(const flagKey of ['INVENTORY_CORE','PHYSICAL_RECONCILIATION','PHYSICAL_INVENTORY_APPLY'])await setClientFlagStage(client,{...a,flagKey,stage:'canary'});
    await client.query("insert into inventory_units_of_measure(id,firm_id,client_id,code,name,kind) values($1,$2,$3,'EA','Each','count')",[uomId,firmId,clientId]);
    await client.query("insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values($1,$2,$3,'SKU','Known item',$4)",[itemId,firmId,clientId,uomId]);
    await client.query("insert into inventory_locations(id,firm_id,client_id,code,name) values($1,$2,$3,'A','Shelf A')",[locationId,firmId,clientId]);
    await client.query("insert into documents(id,firm_id,client_id,filename,checksum_sha256,storage_object_key,payload) values($1,$2,$3,'photo.jpg',$4,$5,'{\"mime_type\":\"image/jpeg\"}'::jsonb)",[documentId,firmId,clientId,checksum,`${clientId}/photo.jpg`]);
    assert.equal((await applyInventoryOperation({...a,itemId,locationId,uomId,idempotencyKey:command(),operationType:'opening_balance',quantity:10,unitCostAmount:5,unitCostCurrency:'GBP',occurredAt:'2026-01-01'})).applied,true);
    const open=async()=>{const out=await openPhysicalReconciliation({...a,locationId,itemIds:[itemId],idempotencyKey:command()});assert.equal(out.applied,true,JSON.stringify(out));return out;};
    const ask=async id=>(await client.query('select * from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3',[firmId,clientId,id])).rows[0];
    const latest=async session=>(await client.query("select * from client_evidence_requests where firm_id=$1 and client_id=$2 and evidence_type='physical_inventory' and status in ('draft','open','replied') and request_payload->>'physical_session_id'=$3 order by created_at desc",[firmId,clientId,String(session.session.id)])).rows[0];
    const ack=(session,row,seat='counter')=>tx(()=>acknowledgePhysicalAsk({...a,actorId:seats[seat],sessionId:session.session.id,lineId:session.lines[0].id,askId:row.id}));
    const observe=(session,quantity=10)=>observePhysicalReconciliation({...a,sessionId:session.session.id,lineId:session.lines[0].id,idempotencyKey:command(),observedQuantity:quantity,evidenceRefs:[{documentId,checksum}],observedAt:new Date().toISOString(),humanConfirmed:true,confidence:1});
    const sweep=()=>sweepPhysicalReviewAsks(a);
    const overdue=row=>client.query("update client_evidence_requests set due_at=clock_timestamp()-interval '1 minute' where id=$1",[row.id]);
    await fn({a,client,seats,calendar,coverage,principal,open,ask,latest,ack,observe,sweep,overdue,tx,command,itemId,uomId,locationId});
  }finally{await client.query('rollback');await client.end();}
}

test('physical asks: named count draft is not delivered; rightful acknowledgement is idempotent',async()=>fixture(async f=>{
  const session=await f.open(),row=await f.latest(session);
  assert.equal(row.status,'draft');assert.equal(Number(row.send_count),0);
  assert.equal(row.addressee_principal_id,f.seats.counter);
  assert.equal(session.lines[0].payload.owner.ask.deliveryStatus,'not_delivered');
  const acknowledged=await f.ack(session,row);assert.equal(acknowledged.status,'open');assert.equal(acknowledged.deliveryStatus,'acknowledged');
  assert.equal((await f.ack(session,row)).deliveryStatus,'acknowledged');
  assert.equal(Number((await f.ask(row.id)).send_count),1);
  const receipts=await f.client.query("select count(*)::int n from audit_events where client_id=$1 and action='physical.ask_acknowledged'",[f.a.clientId]);
  assert.equal(receipts.rows[0].n,1);
}));

test('physical asks: wrong named seat, viewer, tenant and revoked recipient cannot acknowledge',async()=>fixture(async f=>{
  const session=await f.open(),row=await f.latest(session);
  await assert.rejects(f.ack(session,row,'senior'),e=>e.code==='PHYSICAL_ASK_RECIPIENT_MISMATCH');
  await assert.rejects(f.ack(session,row,'viewer'),e=>e.code==='PHYSICAL_ASK_RECIPIENT_INELIGIBLE');
  await assert.rejects(f.tx(()=>acknowledgePhysicalAsk({...f.a,clientId:'foreign-client',sessionId:session.session.id,lineId:session.lines[0].id,askId:row.id})),e=>e.code==='PHYSICAL_ASK_TARGET_INVALID');
  await f.client.query("update client_assignments set ends_at=now()-interval '1 second' where principal_id=$1",[f.seats.counter]);
  await assert.rejects(f.ack(session,row));
  assert.equal(Number((await f.ask(row.id)).send_count),0);
}));

test('physical asks: overdue acknowledged request transfers once to senior, requiring fresh delivery',async()=>fixture(async f=>{
  const session=await f.open(),row=await f.latest(session);await f.ack(session,row);await f.overdue(row);
  const result=await f.sweep();assert.equal(result.escalated,1);
  const after=await f.ask(row.id);assert.equal(after.id,row.id);assert.equal(after.status,'draft');assert.equal(after.addressee_principal_id,f.seats.senior);
  assert.equal(after.request_payload.delivery_status,'not_delivered');assert.equal(after.request_payload.physical_escalation.prior_recipient.principalId,f.seats.counter);
  const pendingView=await getPhysicalReconciliation({...f.a,sessionId:session.session.id});
  assert.equal(pendingView.lines[0].payload.owner.ask.deliveryStatus,'not_delivered');
  assert.equal(pendingView.lines[0].payload.owner.ask.recipient.principalId,f.seats.senior);
  await assert.rejects(f.ack(session,after),e=>e.code==='PHYSICAL_ASK_RECIPIENT_MISMATCH');
  assert.equal((await f.ack(session,after,'senior')).deliveryStatus,'acknowledged');
  assert.equal(Number((await f.ask(row.id)).send_count),2);
  const acknowledgedView=await getPhysicalReconciliation({...f.a,sessionId:session.session.id});
  assert.equal(acknowledgedView.lines[0].payload.owner.ask.deliveryStatus,'acknowledged');
  await f.overdue(after);
  // A new physical connection represents a restarted worker, with no memory of the sweep.
  const restarted=new pg.Client({connectionString:testUrl});await restarted.connect();
  try{assert.equal((await sweepPhysicalReviewAsks({...f.a,client:restarted})).escalated,0);}finally{await restarted.end();}
  const events=await f.client.query("select count(*)::int n from audit_events where client_id=$1 and action='physical.ask_escalated'",[f.a.clientId]);
  assert.equal(events.rows[0].n,1);
  assert.equal((await f.client.query("select count(*)::int n from bookkeeping_case_events where client_id=$1 and event_type='physical.review_escalated'",[f.a.clientId])).rows[0].n,1);
  const blockers=await f.client.query("select count(*)::int n from bookkeeping_case_blockers where client_id=$1 and object_type='client_evidence_request' and status='open'",[f.a.clientId]);
  assert.equal(blockers.rows[0].n,1,'restart dedupes the visible senior obligation');
}));

test('physical asks: revoked recipient escalates before deadline; revoked senior leaves a visible blocker',async()=>fixture(async f=>{
  const session=await f.open(),row=await f.latest(session);
  await f.client.query("update client_assignments set ends_at=now()-interval '1 second' where principal_id=$1",[f.seats.counter]);
  assert.equal((await f.sweep()).escalated,1);
  assert.equal((await f.ask(row.id)).addressee_principal_id,f.seats.senior);
  await f.client.query("update client_assignments set ends_at=now()-interval '1 second' where principal_id=$1",[f.seats.senior]);
  assert.equal((await f.sweep()).blocked,1);
  assert.equal((await f.ask(row.id)).status,'draft');
  const blocker=(await f.client.query("select reason from bookkeeping_case_blockers where client_id=$1 and object_type='client_evidence_request' and status='open'",[f.a.clientId])).rows;
  assert.equal(blocker.length,1);assert.match(blocker[0].reason,/review coverage must be restored/);
  const countEvents=async()=>(await f.client.query('select count(*)::int n from bookkeeping_case_events where client_id=$1',[f.a.clientId])).rows[0].n;
  const eventCount=await countEvents();await f.sweep();assert.equal(await countEvents(),eventCount,'unchanged retries do not spam case wait events');
}));

test('physical asks: absent, same-person, invalid-calendar and ineligible coverage refuse admission',async()=>fixture(async f=>{
  for(const coverage of [null,{...f.coverage,senior:f.coverage.reviewer},{...f.coverage,calendar:null},{...f.coverage,reviewer:f.principal('viewer')}]){
    await f.client.query('update clients set profile=$2::jsonb where id=$1',[f.a.clientId,JSON.stringify({physical_reconciliation:coverage})]);
    await assert.rejects(openPhysicalReconciliation({...f.a,locationId:f.locationId,itemIds:[f.itemId],idempotencyKey:f.command()}));
  }
  assert.equal((await f.client.query('select count(*)::int n from inventory_count_sessions where client_id=$1',[f.a.clientId])).rows[0].n,0);
  assert.equal((await f.client.query('select count(*)::int n from client_evidence_requests where client_id=$1',[f.a.clientId])).rows[0].n,0);
}));

test('physical asks: feature pause preserves ownership and visible obligation without claiming delivery',async()=>fixture(async f=>{
  const session=await f.open(),row=await f.latest(session);
  await setClientFlagStage(f.client,{...f.a,flagKey:'PHYSICAL_RECONCILIATION',stage:'off'});
  const result=await f.sweep();assert.equal(result.blocked,1);assert.equal(result.escalated,0);
  const after=await f.ask(row.id);assert.equal(after.status,'draft');assert.equal(after.addressee_principal_id,f.seats.counter);assert.equal(Number(after.send_count),0);
  await assert.rejects(f.ack(session,after),e=>e.code==='PHYSICAL_RECONCILIATION_DISABLED');
  const caseRow=(await f.client.query('select status from bookkeeping_cases where id=$1',[session.lines[0].case_id])).rows[0];assert.notEqual(caseRow.status,'resolved');
  assert.equal((await f.sweep()).blocked,1);
  const pauseEvents=(await f.client.query("select payload from bookkeeping_case_events where client_id=$1 and event_type='physical.review_paused'",[f.a.clientId])).rows;
  assert.equal(pauseEvents.length,1);assert.equal(pauseEvents[0].payload.paused,true);
  await setClientFlagStage(f.client,{...f.a,flagKey:'PHYSICAL_RECONCILIATION',stage:'canary'});
  assert.equal((await f.sweep()).blocked,0);await f.sweep();
  assert.equal((await f.client.query("select count(*)::int n from bookkeeping_case_events where client_id=$1 and event_type='physical.review_resumed'",[f.a.clientId])).rows[0].n,1);
  assert.equal((await f.client.query("select count(*)::int n from bookkeeping_case_blockers where client_id=$1 and object_type='client_evidence_request' and status='open'",[f.a.clientId])).rows[0].n,0,'re-enable clears obsolete pause blocker');
  assert.equal((await f.ask(row.id)).status,'draft');assert.equal(Number((await f.ask(row.id)).send_count),0);
}));

test('physical asks: answered match closes its asks; deadline retries never reopen terminal work',async()=>fixture(async f=>{
  const session=await f.open(),row=await f.latest(session);await f.overdue(row);
  const observed=await f.observe(session);assert.equal(observed.applied,true,JSON.stringify(observed));
  assert.equal((await f.ask(row.id)).status,'resolved');
  assert.equal((await f.sweep()).examined,0);
  assert.equal((await f.client.query('select status from bookkeeping_cases where id=$1',[session.lines[0].case_id])).rows[0].status,'resolved');
  await assert.rejects(f.ack(session,row),e=>e.code==='PHYSICAL_ASK_NOT_ACTIVE');
}));

test('physical asks: accepted stock with pending accounting review keeps its case owned and open',async()=>fixture(async f=>{
  const session=await f.open();const observed=await f.observe(session,8);assert.equal(observed.applied,true,JSON.stringify(observed));
  const out=await resolvePhysicalReconciliation({...f.a,actorId:f.seats.founder,actorType:'firm_member',sessionId:session.session.id,lineId:session.lines[0].id,idempotencyKey:f.command(),
    expectedObservationDigest:observed.lines[0].physical_observation.inputDigest,action:'confirmed_shortage',reason:'Independent recount confirms shortage.'});
  assert.equal(out.applied,true,JSON.stringify(out));assert.equal(out.receipt.accounting.status,'disabled');
  const pending=await f.latest(session);assert.ok(pending);assert.equal(pending.addressee_principal_id,f.seats.reviewer);assert.equal(pending.request_payload.review_required,true);
  assert.notEqual((await f.client.query('select status from bookkeeping_cases where id=$1',[session.lines[0].case_id])).rows[0].status,'resolved');
  await f.overdue(pending);assert.equal((await f.sweep()).escalated,1);
  const reloaded=await getPhysicalReconciliation({...f.a,sessionId:session.session.id});assert.equal(reloaded.lines[0].physical_status,'applied');
}));


test('physical asks: bounded review sweeps fairly reach the 101st obligation after restart',async()=>fixture(async f=>{
  const items=[];
  for(let i=0;i<101;i++){
    const id=`${f.a.clientId}-page-${i}`;items.push(id);
    await f.client.query("insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values($1,$2,$3,$1,'Paged count item',$4)",[id,f.a.firmId,f.a.clientId,f.uomId]);
  }
  for(let i=0;i<items.length;i+=20){
    const out=await openPhysicalReconciliation({...f.a,locationId:f.locationId,itemIds:items.slice(i,i+20),idempotencyKey:f.command()});
    assert.equal(out.applied,true,JSON.stringify(out));
  }
  await f.client.query("update client_evidence_requests set due_at=clock_timestamp()-interval '1 minute' where firm_id=$1 and client_id=$2",[f.a.firmId,f.a.clientId]);
  const first=await f.sweep();assert.equal(first.examined,100);assert.equal(first.escalated,100);
  const unseen=(await f.client.query("select id from client_evidence_requests where client_id=$1 and not(request_payload ? 'physical_clock_checked_at')",[f.a.clientId])).rows;
  assert.equal(unseen.length,1);
  const restarted=new pg.Client({connectionString:testUrl});await restarted.connect();
  try{const next=await sweepPhysicalReviewAsks({...f.a,client:restarted});assert.equal(next.examined,100);assert.equal(next.escalated,1);}finally{await restarted.end();}
  const reached=await f.ask(unseen[0].id);assert.ok(reached.request_payload.physical_clock_checked_at);
  assert.equal(reached.addressee_principal_id,f.seats.senior);assert.equal(reached.status,'draft');assert.equal(Number(reached.send_count),0);
}));
