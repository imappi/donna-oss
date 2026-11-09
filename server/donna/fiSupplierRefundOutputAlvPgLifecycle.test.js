import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests} from './firmDb.js';
import {batchSuggestTransactionCodingInDb} from './db/coding.js';
import {recoverChangedCodingEvidenceInDb} from './db/codingEvidence.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';
import {sweepCodingAutoPost} from './codingAutoPost.js';

// Frozen shape of a Finnish replay: a shop paid money back to the business,
// the bank line was the only evidence, and the coder chose Other income at
// ALV 25,5 %, which posted output ALV on a purchase refund.
test('real PG: a bank-only supplier refund coded to income with output ALV ends as an owner question; evidenced neighbours still post', {skip:!process.env.DONNA_PG_TEST_URL && 'DONNA_PG_TEST_URL required'}, async t => {
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`fi_refund_output_alv_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','fi-refund-output-alv');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Synthetic company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash"}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 const enrollment=await pool.connect();try{await enrollJevExperiment({client:enrollment,firmId:'f',clientId:'c',actorId:'member',authorityBasis:'Synthetic lifecycle proof',trialId:'refund-output-alv',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollment.release();}
 for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST','FINLAND_ALV_CODING'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')",[flag]);

 // Scripted provider: resolve to (account, tax) or select one owner question.
 let plan={},constraints=[];
 globalThis.fetch=async(endpoint,init)=>{
  assert.match(String(endpoint),/api\.typesafe\.ai/);
  const request=JSON.parse(init.body),state=typeof request.state==='string'?JSON.parse(request.state):request.state;
  constraints.push(...(state.execution_constraints||[]));
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria);
   const choice=key==='materiality'?'low'
     :key==='decision'&&plan.ask?plan.ask
     :key==='decision'&&q.criteria.resolved?'resolved'
     :entries.find(([,label])=>label.includes(`to ${plan.account}, tax treatment ${plan.tax};`))?.[0]
     ||entries.find(([,label])=>label===plan.account||label===plan.tax)?.[0]||entries[0][0];
   return [key,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.9:.1/(entries.length-1)]))}];
  }));
  return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 const tx=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
 const lines=async id=>(await pool.query("select l.account_name,l.debit,l.credit,l.tax_type from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id=$1 order by l.line_no",[id])).rows;
 const journals=async id=>(await pool.query('select count(*)::int n from ledger_journals where source_id=$1',[id])).rows[0].n;
 const bankLine=(id,description,moneyIn)=>pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'f','c','2025-06-02',$2,$3,0,'EUR','needs_review','{}')",[id,description,moneyIn]);
 const source=async(id,type,total,tax,txId)=>{
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary) values($1,'f','c',$1,$2,'completed','2025-06-01','EUR',$3,$4,'{\"line_amounts_include_tax\":true,\"totals_validation\":{\"matches\":true}}')",[id,type,total,tax]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload) values($1,'f','c',$2,1,'Synthetic goods',$3,0.255,$4)",[`${id}-line`,id,total,{raw_extraction:{amount:total,tax_rate:.255}}]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload) values($1,'f','c',$2,$3,$4,'auto_matched',$5,.9,'{}')",[`${id}-match`,txId,type,id,total]);
 };
 const code=async p=>{plan=p;constraints=[];await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});};

 // 1. The reproduction: no document, Other income at ALV 25,5 %. The writer
 //    refuses output ALV on the bank descriptor alone; nothing reaches the ledger.
 await bankLine('refund','HYVITYS SYNTHETIC SHOP OY',49.9);
 await code({account:'Other income',tax:'ALV 25,5 %'});
 assert.equal((await tx('refund')).payload.ledger_post_refusal?.code,'TRANSACTION_ALV_EVIDENCE_REQUIRED');
 assert.equal(await journals('refund'),0);
 // The existing evidence clock reopens it; the coder now sees what failed and
 // may not repeat rated output tax without a sales source.
 assert.ok((await recoverChangedCodingEvidenceInDb({firmId:'f'})).some(r=>r.transaction_id==='refund'));
 await code({ask:'ask_source_document',account:'Other income',tax:'ALV-tarkistus'});
 const constraint=constraints.find(c=>c.scope==='missing_output_tax_evidence');
 assert.ok(constraint,'the refusal reaches the coder as an execution constraint');
 assert.deepEqual(constraint.excluded_tax_treatments,['ALV 25,5 %','ALV 13,5 %','ALV 14 %','ALV 10 %']);
 assert.equal((await tx('refund')).coding_state,'proposed');
 // The line ends as a question to the owner, never as a coder-'explained' post.
 const sweep=await sweepCodingAutoPost({firmId:'f',clientId:'c'});
 assert.equal(sweep.owner_asked,1,JSON.stringify(sweep));assert.equal(sweep.auto_posted,0);
 const asks=(await pool.query("select evidence_type,status,question from client_evidence_requests where transaction_id='refund'")).rows;
 assert.equal(asks.length,1);assert.equal(asks[0].evidence_type,'supporting_document');assert.match(asks[0].question,/receipt/);
 assert.equal((await tx('refund')).coding_state,'asked');
 assert.equal(await journals('refund'),0);
 await pool.query("update transactions set status='approved' where id='refund'");

 // 2. Other income with no ALV (interest, compensation, a grant) still posts.
 await bankLine('interest','Synthetic bank interest',3.1);
 await code({account:'Other income',tax:'Ei ALV-käsittelyä'});
 assert.equal((await tx('interest')).coding_state,'posted',JSON.stringify((await tx('interest')).payload.ledger_post_refusal));
 assert.deepEqual((await lines('interest')).filter(l=>Number(l.credit)>0).map(l=>[l.account_name,l.credit]),[['Other income','3.10']]);

 // 3. Operating revenue backed by a matched sales invoice still posts output ALV.
 await bankLine('sale','Synthetic customer payment',124);
 await source('sales-invoice','sales_invoice',124,25.2,'sale');
 await code({account:'Sales',tax:'ALV 25,5 %'});
 assert.equal((await tx('sale')).coding_state,'posted',JSON.stringify((await tx('sale')).payload.ledger_post_refusal));
 assert.deepEqual((await lines('sale')).filter(l=>Number(l.credit)>0).map(l=>[l.account_name,l.credit,l.tax_type]),
   [['Sales','98.80','ALV_25_5_OUTPUT'],['Suoritettava arvonlisävero','25.20','NONE']]);

 // 4. A supplier refund coded to its expense with its purchase source reverses
 //    the expense and its input ALV, governed by the existing input rule.
 await bankLine('refund-sourced','HYVITYS SYNTHETIC SHOP OY',49.9);
 await source('refund-receipt','receipt',49.9,10.14,'refund-sourced');
 await code({account:'Operating supplies',tax:'ALV 25,5 %'});
 assert.equal((await tx('refund-sourced')).coding_state,'posted',JSON.stringify((await tx('refund-sourced')).payload.ledger_post_refusal));
 const reversal=await lines('refund-sourced');
 assert.deepEqual(reversal.filter(l=>Number(l.credit)>0).map(l=>[l.account_name,l.credit]).sort(),
   [['Operating supplies','39.76'],['Vähennettävä arvonlisävero','10.14']].sort());
 assert.ok(!reversal.some(l=>/suoritettava/i.test(l.account_name)),'no output ALV on a purchase refund');
});
