import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests,postLedgerTransactionInDb,postLedgerAdjustmentInDb} from './firmDb.js';
import {batchSuggestTransactionCodingInDb,ensureTransactionReviewItemInDb,updateTransactionReviewItemInDb} from './db/coding.js';
import {recoverChangedCodingEvidenceInDb,currentCodingEvidence,codingEvidenceDigest,captureFiChatCodingEvidence} from './db/codingEvidence.js';
import {recordRefusalViaDb} from './ledgerAutoPost.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';
import {runCodingAutoPostForTransaction} from './codingAutoPost.js';
import {convergenceForTransaction} from './reconcileConvergenceState.js';

test('real PG: unsupported operating revenue waits on a source; later source retires the ask and posts once', {skip:!process.env.DONNA_PG_TEST_URL},async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`coding_revenue_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','coding-revenue');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Current company','us','{"jurisdiction":"us","accounting_system":"none","accounting_basis":"cash"}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 const enrollment=await pool.connect();try{await enrollJevExperiment({client:enrollment,firmId:'f',clientId:'c',actorId:'member',authorityBasis:'Synthetic lifecycle proof',trialId:'source-identity',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollment.release();}
 for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')",[flag]);

 await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('cash','f','c','2025-06-02','Bank deposit',455,0,'USD','needs_review','{}')");
 globalThis.fetch=async(endpoint,init)=>{
  assert.match(String(endpoint),/api\.typesafe\.ai/);const request=JSON.parse(init.body);
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria),choice=key==='materiality'?'low':entries.find(([,label])=>label.includes('to Sales, tax treatment No sales tax'))?.[0]||entries.find(([,label])=>label==='Sales'||label==='No sales tax')?.[0]||entries[0][0];
   return [key,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.9:.1/(entries.length-1)]))}];
  }));return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 const tx=async()=>(await pool.query("select * from transactions where id='cash'")).rows[0];
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.equal((await tx()).coding_state,'proposed');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='cash'")).rows[0].n,0);
 const sweep=await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'cash'});
 assert.equal(sweep.owner_asked,1,JSON.stringify(sweep));
 const ask=(await pool.query("select * from client_evidence_requests where transaction_id='cash' and status in ('draft','open')")).rows[0];
 assert.equal(ask.evidence_type,'supporting_document');assert.match(ask.question,/cashbook or till reconciliation/);
 await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'cash'});
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='cash' and status in ('draft','open')")).rows[0].n,1);
 await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary) values('sales','f','c','daily-sales.pdf','issued_receipt','completed','2025-06-02','USD',455,0,'{\"line_amounts_include_tax\":true}')");
 await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload) values('sales-line','f','c','sales',1,'Daily sales',455,0,'{}')");
 await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload) values('sales-match','f','c','cash','issued_receipt','sales','auto_matched',455,.9,'{}')");
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.equal((await tx()).coding_state,'posted');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='cash'")).rows[0].n,1);
 assert.equal((await pool.query("select status from client_evidence_requests where id=$1",[ask.id])).rows[0].status,'resolved');
});
