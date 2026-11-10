import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests,postLedgerTransactionInDb} from './firmDb.js';
import {batchSuggestTransactionCodingInDb} from './db/coding.js';
import {recoverChangedCodingEvidenceInDb} from './db/codingEvidence.js';
import {recordRefusalViaDb} from './ledgerAutoPost.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';
import {runCodingAutoPostForTransaction} from './codingAutoPost.js';
import {__createHeldMatchPortalAsksWithClient,resolveClientEvidenceRequestInDb} from './db/asks.js';
import {codingStatutoryEvidenceGap} from './codingStatutoryEvidence.js';

test('canonical statutory roles require a current source, while ordinary loan and expense roles remain unchanged',()=>{
 const transaction={money_out:1245,money_in:0};
 const suggestion={proposed_account:'Suoritettava arvonlisävero',coding_policy:{jurisdiction:'fi'}};
 assert.equal(codingStatutoryEvidenceGap({transaction,suggestion}),true);
 assert.equal(codingStatutoryEvidenceGap({transaction,suggestion,matchedDocument:{document_type:'bank_statement',match_status:'confirmed'}}),true);
 assert.equal(codingStatutoryEvidenceGap({transaction,suggestion,matchedDocument:{document_type:'supplier_bill',match_status:'suggested'}}),true);
 assert.equal(codingStatutoryEvidenceGap({transaction,suggestion,matchedDocument:{document_type:'payment_confirmation',match_status:'confirmed'}}),false);
 assert.equal(codingStatutoryEvidenceGap({transaction,suggestion,accountRole:'liability.loan'}),false);
 assert.equal(codingStatutoryEvidenceGap({transaction,suggestion,accountRole:'expense.operating_supplies'}),false);
 assert.equal(codingStatutoryEvidenceGap({transaction:{money_in:1245,money_out:0},suggestion}),false);
});

test('real PG: statutory liability requires its source through batch and writer; later notice closes the ask and missing notice reopens immutable correction', {skip:!process.env.DONNA_PG_TEST_URL},async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`coding_statutory_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','coding-statutory');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Current company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash","alv_registration":{"status":"registered","registered_from":"2020-01-01"}}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 const enrollment=await pool.connect();try{await enrollJevExperiment({client:enrollment,firmId:'f',clientId:'c',actorId:'member',authorityBasis:'Synthetic lifecycle proof',trialId:'statutory-source',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollment.release();}
 for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST','FINLAND_ALV_CODING'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')",[flag]);

 await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('cash','f','c','2025-06-02','VAT settlement Q4',0,1245,'EUR','needs_review','{}')");
 globalThis.fetch=async(endpoint,init)=>{
  assert.match(String(endpoint),/api\.typesafe\.ai/);const request=JSON.parse(init.body);
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria),choice=key==='materiality'?'low':entries.find(([,label])=>label.includes('to Suoritettava arvonlisävero, tax treatment Ei ALV-käsittelyä'))?.[0]||entries.find(([,label])=>label==='Suoritettava arvonlisävero'||label==='Ei ALV-käsittelyä')?.[0]||entries[0][0];
   return [key,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.9:.1/(entries.length-1)]))}];
  }));return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 const tx=async()=>(await pool.query("select * from transactions where id='cash'")).rows[0];
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.equal((await tx()).coding_state,'proposed');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='cash'")).rows[0].n,0);
 // An unsafe legacy accepted verdict cannot bypass the named writer.
 await pool.query("update transactions set coding_state='applied',payload=payload || '{\"ai_suggestion_status\":\"auto_applied\"}'::jsonb where id='cash'");
 let refusal;try{await postLedgerTransactionInDb({firmId:'f',clientId:'c',transactionId:'cash',dryRun:false,skipSnapshot:true});}catch(error){refusal=error;}
 assert.equal(refusal?.code,'TRANSACTION_STATUTORY_SOURCE_REQUIRED');
 await recordRefusalViaDb({firmId:'f',clientId:'c',transactionId:'cash',error:refusal});
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx()).coding_state,'proposed');
 const sweep=await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'cash'});
 assert.equal(sweep.owner_asked,1,JSON.stringify(sweep));
 const ask=(await pool.query("select * from client_evidence_requests where transaction_id='cash' and status in ('draft','open')")).rows[0];
 assert.equal(ask.evidence_type,'supporting_document');assert.match(ask.question,/filing or notice/);
 await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'cash'});
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='cash' and status in ('draft','open')")).rows[0].n,1);
 await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary) values('sales','f','c','tax-notice.pdf','supplier_bill','completed','2025-06-02','EUR',1245,0,'{\"line_amounts_include_tax\":true}')");
 await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload) values('sales-line','f','c','sales',1,'Assessed VAT Q4',1245,0,'{}')");
 await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload) values('sales-match','f','c','cash','supplier_bill','sales','auto_matched',1245,.9,'{}')");
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.equal((await tx()).coding_state,'posted');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='cash'")).rows[0].n,1);
 assert.equal((await pool.query("select status from client_evidence_requests where id=$1",[ask.id])).rows[0].status,'resolved');
 const lines=(await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='cash' order by l.line_no")).rows;
 assert.equal(lines.find(line=>Number(line.debit)>0).debit,'1245.00');
 await pool.query("update reconciliation_matches set status='rejected' where id='sales-match'");
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx()).payload.coding_correction_required.reason,'posted_statutory_source_required');
 assert.equal((await pool.query("select status from transaction_review_queue where item_id='cash' and reason='posted_evidence_changed'")).rows[0].status,'open');
 assert.deepEqual((await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='cash' order by l.line_no")).rows,lines);

 // The existing held-source consumer may settle a factual, attributable reply
 // without manufacturing material approval or confirming the held match.
 await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason) values('pilot','f','c','INTERNAL_PILOT_ACCESS','canary','manual','donna.fi-hosted-pilot.v1')");
 await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values('held','f','c','2025-02-15','Pension liability',0,596.4,'EUR','needs_review','proposed','{}')");
 await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,payload) values('pension','f','c','pension-notice.pdf','supplier_bill','completed','2025-02-10','EUR',596.4,0,'{}')");
 await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload)
 values('pension-match','f','c','held','supplier_bill','pension','suggested',596.4,.95,'{"authorization":{"reasons":["above_materiality_ceiling"]}}')`);
 const grantCount=async()=>(await pool.query("select count(*)::int n from reconciliation_authority_grants where firm_id='f' and client_id='c'")).rows[0].n;
 const grantsBefore=await grantCount();
 const client=await pool.connect();let heldAsks;try{heldAsks=await __createHeldMatchPortalAsksWithClient({client,firmId:'f',clientId:'c'});}finally{client.release();}
 assert.equal(heldAsks.length,1);
 globalThis.fetch=async(endpoint)=>{
  assert.match(String(endpoint),/openai.com/);
  return {ok:true,status:200,json:async()=>({output_text:JSON.stringify({proposed_account:'TyEL and payroll contributions payable',tax_treatment:'Ei ALV-käsittelyä',evidence_required:false,confidence:'high',support_note:'The owner confirms the cited pension bill is paid in full.'})})};
 };
 const resolved=await resolveClientEvidenceRequestInDb({firmId:'f',evidenceRequestId:heldAsks[0],reply:'Yes, this payment settles pension-notice.pdf in full.',actorId:'member',actorType:'firm_member',answerSource:'phone'});
 assert.equal(resolved.recode?.posted,true,JSON.stringify(resolved.recode));
 assert.equal((await pool.query("select status from reconciliation_matches where id='pension-match'")).rows[0].status,'suggested');
 assert.equal(await grantCount(),grantsBefore);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await pool.query("select payload->'coding_correction_required' correction from transactions where id='held'")).rows[0].correction,null);
 // A stale or substituted answer cannot keep overriding the source hold.
 await pool.query("update client_evidence_requests set response_payload=jsonb_set(response_payload,'{reply}',to_jsonb('No, that was a different payment.'::text)) where id=$1",[heldAsks[0]]);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await pool.query("select payload->'coding_correction_required' correction from transactions where id='held'")).rows[0].correction.reason,'posted_statutory_source_required');

});
