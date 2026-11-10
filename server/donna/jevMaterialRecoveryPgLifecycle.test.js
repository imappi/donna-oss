import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests} from './firmDb.js';
import {recoverJevMaterialExceptionsInDb} from './jevMaterialException.js';

// The first-line lane decides only on a host with its provider configured
// (firstLineLane.js, 2026-11-10); these cases are about the lane deciding.
process.env.TYPESAFE_API_KEY ||= 'fixture-first-line-key';
process.env.TYPESAFE_MODEL ||= 'fixture-first-line';

const pgUrl=process.env.DONNA_PG_TEST_URL;
test('real PG: renewed material decisions dispatch grounded authoring and reject changed full evidence before asking', {skip:!pgUrl&&'DONNA_PG_TEST_URL required'},async t=>{
  const admin=new pg.Client({connectionString:pgUrl});await admin.connect();
  const name=`jev_material_recovery_${process.pid}_${Date.now().toString(36)}`;await admin.query(`create database "${name}"`);
  const url=new URL(pgUrl);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.toString()});
  const closed=[];pool.on('connect',client=>closed.push(new Promise(resolve=>client.once('end',resolve))));__setFirmDbPoolForTests(pool);
  t.after(async()=>{__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations=new URL('../../db/migrations/',import.meta.url);
  for(const file of(await readdir(migrations)).filter(file=>file.endsWith('.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
  await pool.query(`insert into firms(id,name,slug) values('material-firm','Synthetic material proof','material-proof');
    insert into clients(id,firm_id,company_name,jurisdiction,profile) values('material-client','material-firm','Synthetic company','fi','{"jurisdiction":"fi","accounting_system":"none"}');
    insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('material-jev','material-firm','material-client','JEV_RECONCILIATION','auto','manual');
    insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload) values('bank','material-firm','material-client','2025-02-14','Supporting movement',100,'EUR','needs_review','{}');`);
  const seed=async id=>{
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,parse_run_id,document_date,total_amount,tax_amount,currency,parse_summary)
      values($1,'material-firm','material-client',$2,'receipt','completed','00000000-0000-4000-8000-000000000001','2025-02-14',100,0,'EUR',$3)`,[id,id+'.pdf',{line_amounts_include_tax:true,warnings:['amount_mismatch'],jev_exception:{selected:null,execution:'provider_or_configuration_unavailable'}}]);
    await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount) values($1,'material-firm','material-client',$2,1,'Printed component',90)`,['line-'+id,id]);
  };
  const first=selected=>({decision_engine:'jev',model:'fixture-jev',selected,probability:.38,execution:selected==='ask_owner'?'owner_ask_authorized':'reasoning_pending'});
  const author=async evidence=>({selected:'ask_owner',question:`For ${evidence.case.documents.find(d=>d.id===evidence.case.focal.id).filename}, which separately purchased item accounts for the stated ten-euro addition?`,reason:'A specific unlisted purchase fact is absent.',model:'fixture-reasoner'});
  const recover=options=>recoverJevMaterialExceptionsInDb({firmId:'material-firm',...options});
  await seed('retry');
  let firstCalls=0,authorCalls=0;
  const failed=await recover({firstDecideFn:async()=>{firstCalls++;return first('needs_reasoning');},decideFn:async()=>{authorCalls++;throw Object.assign(new Error('Synthetic temporary outage'),{code:'FIXTURE_OUTAGE'});}});
  assert.equal(failed[0].code,'FIXTURE_OUTAGE');
  let summary=(await pool.query("select parse_summary from documents where id='retry'")).rows[0].parse_summary;
  assert.equal(summary.jev_exception.selected,'needs_reasoning','renewed first decision survives authoring failure');
  assert.equal(summary.jev_exception.model,'fixture-jev');
  await pool.query("update documents set parse_summary=jsonb_set(parse_summary,'{jev_exception,recovery,attempted_at}','\"2000-01-01\"') where id='retry'");
  const resumed=await recover({firstDecideFn:async()=>{throw new Error('A current first decision must not run again');},decideFn:async evidence=>{authorCalls++;return author(evidence);}});
  assert.equal(resumed[0].outcome,'waiting_on_owner');assert.equal(firstCalls,1);assert.equal(authorCalls,2);
  const ask=(await pool.query("select question,request_payload from client_evidence_requests where request_payload->>'document_id'='retry'")).rows[0];
  assert.match(ask.question,/retry\.pdf/);assert.equal(ask.request_payload.jev_first.selected,'needs_reasoning');
  assert.ok(ask.request_payload.reasoning_recovery.evidence_packet_sha256);
  await seed('renewed-owner');
  const owner=await recover({firstDecideFn:async()=>first('ask_owner'),decideFn:async evidence=>{
    assert.equal(evidence.jev_first.selected,'ask_owner');assert.match(evidence.task,/Author the precise/);return author(evidence);
  }});
  assert.equal(owner[0].outcome,'waiting_on_owner','choice-only owner authority dispatches actual question authoring');

  for(const race of ['bank','reply','new-source']){
    await seed('race-'+race);
    const before=Number((await pool.query('select count(*) n from client_evidence_requests')).rows[0].n);
    const outcome=await recover({firstDecideFn:async()=>first('ask_owner'),decideFn:async evidence=>{
      if(race==='bank')await pool.query("update transactions set description='New contradictory reference' where id='bank'");
      if(race==='reply')await pool.query("update client_evidence_requests set response_payload='{\"answer\":\"The missing item is now explained\"}' where request_payload->>'document_id'='retry'");
      if(race==='new-source')await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency) values('new-local-source','material-firm','material-client','explanation.pdf','receipt','completed','2025-02-14',10,'EUR')");
      return author(evidence);
    }});
    assert.equal(outcome[0].code,'JEV_MATERIAL_SOURCE_CHANGED',race);
    assert.equal(Number((await pool.query('select count(*) n from client_evidence_requests')).rows[0].n),before,'changed evidence never creates an owner question');
  }
});
