import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests} from './firmDb.js';
import {batchSuggestTransactionCodingInDb} from './db/coding.js';
import {seedPackPaletteChartWithClient} from './db/ledger.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';

// A coded account resolves to the account it names on Donna's own ledger.
// Before: the account matcher's external-chart fallback ran on this chart too,
// so "Other income" (interest, a grant, compensation) landed on an existing
// Sales row (after the operating-revenue evidence check had passed it as
// other income), and an expense name with no row landed on a neighbour
// expense. Proven through the real coding and posting writers with a
// scripted model provider, on an uncoded palette book and a coded Oy book.
test('real PG: a coded account posts to the account it names, never to a neighbour of the same type', {skip:!process.env.DONNA_PG_TEST_URL && 'DONNA_PG_TEST_URL required'}, async t => {
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`coded_account_resolution_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','coded-account-resolution');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 // 'plain': the uncoded palette book. 'oy': born with the coded statutory chart.
 for(const[clientId,entityType]of[['plain',null],['oy','fi-oy']]){
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,'f',$2,'fi',$3,'{\"jurisdiction\":\"fi\",\"accounting_system\":\"none\",\"accounting_basis\":\"cash\",\"alv_registration\":{\"status\":\"registered\",\"registered_from\":\"2020-01-01\"}}')",[clientId,`Synthetic ${clientId} company`,entityType]);
  for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST','FINLAND_ALV_CODING'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f',$2,$3,'auto','manual')",[`${clientId}-${flag}`,clientId,flag]);
  const c=await pool.connect();
  try{
   if(entityType){const seeded=await seedPackPaletteChartWithClient(c,{firmId:'f',clientId,newBook:true});assert.equal(seeded.seeded,true,JSON.stringify(seeded));}
   await enrollJevExperiment({client:c,firmId:'f',clientId,actorId:'member',authorityBasis:'Synthetic lifecycle proof',trialId:`coded-${clientId}`,expiresAt:'2100-01-01',model:'fixture-provider'});
  }finally{c.release();}
 }

 // Scripted provider: resolve to (account, tax).
 let plan={};
 globalThis.fetch=async(endpoint,init)=>{
  assert.match(String(endpoint),/api\.typesafe\.ai/);
  const request=JSON.parse(init.body);
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria);
   const choice=key==='materiality'?'low'
     :key==='decision'&&q.criteria.resolved?'resolved'
     :entries.find(([,label])=>label.includes(`to ${plan.account}, tax treatment ${plan.tax};`))?.[0]
     ||entries.find(([,label])=>label===plan.account||label===plan.tax)?.[0]||entries[0][0];
   return [key,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.9:.1/(entries.length-1)]))}];
  }));
  return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 const tx=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
 const counterLegs=async(id,side)=>(await pool.query(`select l.account_code,l.account_name,l.${side} amount from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id=$1 and l.${side}>0 and l.payload->>'role' is distinct from 'bank' order by l.line_no`,[id])).rows
   .map(l=>[l.account_code||null,l.account_name,l.amount]);
 const line=(clientId,id,description,moneyIn,moneyOut)=>pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'f',$2,'2025-06-02',$3,$4,$5,'EUR','needs_review','{}')",[id,clientId,description,moneyIn,moneyOut]);
 const salesSource=async(clientId,id,total,tax,txId)=>{
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary) values($1,'f',$2,$1,'sales_invoice','completed','2025-06-01','EUR',$3,$4,'{\"line_amounts_include_tax\":true,\"totals_validation\":{\"matches\":true}}')",[id,clientId,total,tax]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload) values($1,'f',$2,$3,1,'Synthetic goods',$4,0.255,$5)",[`${id}-line`,clientId,id,total,{raw_extraction:{amount:total,tax_rate:.255}}]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload) values($1,'f',$2,$3,'sales_invoice',$4,'auto_matched',$5,.9,'{}')",[`${id}-match`,clientId,txId,id,total]);
 };
 const code=async(clientId,p)=>{plan=p;await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:[clientId],limit:1,autoApply:true});};
 const posted=async id=>assert.equal((await tx(id)).coding_state,'posted',JSON.stringify((await tx(id)).payload.ledger_post_refusal));
 const accounts=async clientId=>(await pool.query("select coalesce(code,'') code,name from ledger_accounts where client_id=$1 and status='active' order by name",[clientId])).rows.map(r=>`${r.code}|${r.name}`);

 // 1. Uncoded book. A real sale makes the Sales row; an office purchase makes
 //    the Office expenses row (the neighbours a fallback would land on).
 await line('plain','sale','Synthetic customer payment',124,0);
 await salesSource('plain','sales-invoice',124,25.2,'sale');
 await code('plain',{account:'Sales',tax:'ALV 25,5 %'});
 await posted('sale');
 await line('plain','office','Synthetic stationery',0,20);
 await code('plain',{account:'Office expenses',tax:'Ei ALV-käsittelyä'});
 await posted('office');
 assert.ok((await accounts('plain')).includes('|Sales'));assert.ok((await accounts('plain')).includes('|Office expenses'));

 // Other income with Sales present lands on Other income, minted by name with
 // its receipt; Sales is untouched by it.
 await line('plain','interest','Synthetic bank interest',3.1,0);
 await code('plain',{account:'Other income',tax:'Ei ALV-käsittelyä'});
 await posted('interest');
 assert.deepEqual(await counterLegs('interest','credit'),[[null,'Other income','3.10']]);
 assert.equal((await pool.query("select count(*)::int n from audit_events where client_id='plain' and action='ledger.account.created_at_posting' and metadata->>'name'='Other income'")).rows[0].n,1);
 // Interest income is its own account too, not Sales.
 await line('plain','interest-2','Synthetic deposit interest',1.4,0);
 await code('plain',{account:'Interest income',tax:'Ei ALV-käsittelyä'});
 await posted('interest-2');
 assert.deepEqual(await counterLegs('interest-2','credit'),[[null,'Interest income','1.40']]);
 // The same rule on the expense side: an expense name with no row is minted,
 // never folded into Office expenses.
 await line('plain','software','Synthetic software seat',0,12);
 await code('plain',{account:'Software subscriptions',tax:'Ei ALV-käsittelyä'});
 await posted('software');
 assert.deepEqual(await counterLegs('software','debit'),[[null,'Software subscriptions','12.00']]);
 assert.deepEqual((await pool.query("select coalesce(sum(credit),0)::text c from ledger_lines where client_id='plain' and account_name='Sales'")).rows[0].c,'98.80');

 // 2. Coded Oy book: both accounts exist under statutory names, the palette
 //    names are their aliases. Each coded name resolves to its own coded row.
 await line('oy','oy-sale','Synthetic customer payment',124,0);
 await salesSource('oy','oy-sales-invoice',124,25.2,'oy-sale');
 await code('oy',{account:'Sales',tax:'ALV 25,5 %'});
 await posted('oy-sale');
 assert.deepEqual((await counterLegs('oy-sale','credit'))[0],['3000','Myynti','98.80']);
 await line('oy','oy-other','Synthetic compensation received',3.1,0);
 await code('oy',{account:'Other income',tax:'Ei ALV-käsittelyä'});
 await posted('oy-other');
 assert.deepEqual(await counterLegs('oy-other','credit'),[['3900','Liiketoiminnan muut tuotot','3.10']]);
 await line('oy','oy-interest','Synthetic bank interest',1.4,0);
 await code('oy',{account:'Interest income',tax:'Ei ALV-käsittelyä'});
 await posted('oy-interest');
 assert.deepEqual(await counterLegs('oy-interest','credit'),[['9300','Korkotuotot','1.40']]);
 await line('oy','oy-software','Synthetic software seat',0,12);
 await code('oy',{account:'Software subscriptions',tax:'Ei ALV-käsittelyä'});
 await posted('oy-software');
 assert.deepEqual(await counterLegs('oy-software','debit'),[['7680','ATK-ohjelmistot ja -lisenssit','12.00']]);
});
