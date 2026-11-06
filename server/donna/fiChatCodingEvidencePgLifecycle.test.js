import { __writeLedgerJournalRows } from './db/ledger.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { handleDonnaApiRequest } from './api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, postLedgerTransactionInDb } from './firmDb.js';
import { ensureTransactionReviewItemInDb, updateTransactionReviewItemInDb } from './db/coding.js';
import { updateReconciliationMatchInDb } from './db/reconcile.js';
import { currentCodingEvidence, codingEvidenceDigest } from './db/codingEvidence.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { DEFAULT_FIRM_ID } from './db/clients.js';

for (const browserDefaultScope of [false, true]) {
test(`FI real HTTP and PG (${browserDefaultScope ? 'browser omitted firm_id' : 'explicit firm_id'}): chat correction binds generation evidence, heals applied unposted, and fences stale authority`, {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL required'
}, async t => {
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `donna_chat_evidence_${Date.now().toString(36)}_${process.pid}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const env = {
    DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-the-owner-token',
    SUPABASE_URL: 'https://currency-auth.invalid', SUPABASE_ANON_KEY: 'test-key',
    DONNA_AUTH_ALLOWED_EMAILS: 'owner@currency.example,seat@currency.example', OPENAI_API_KEY: 'test-only-no-network', ANTHROPIC_API_KEY: 'test-only-no-network'
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await pool.end();
    await Promise.all(closed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((name) => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, root), 'utf8'));
  }

  installConvergenceSettleOnPool(pool);
  const firmId=browserDefaultScope ? DEFAULT_FIRM_ID : 'fi-chat-proof', clientId='salon';
  await pool.query("insert into firms(id,name,slug) values($1,'FI chat proof','fi-chat-proof')",[firmId]);
  await pool.query(`insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level)
    values('owner',$1,'owner-user','owner@currency.example','Owner','owner','active','staff')`,[firmId]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
    values($1,$2,'Salong Test Oy','fi','fi-oy',$3)`,[clientId,firmId,{jurisdiction:'fi',accounting_system:'none',accounting_basis:'accrual'}]);
  for (const flag of ['FINLAND_ALV_CODING','JURISDICTION_ACCOUNT_PALETTE','CODING_AUTO_POST','LEDGER_AUTO_POST']) {
    await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
      values($1,$2,$3,$4,'auto','manual')`,[flag,firmId,clientId,flag]);
  }
  const server=createServer((req,res)=>Promise.resolve(handleDonnaApiRequest(req,res)).catch(error=>{
    res.statusCode=error.statusCode||500;res.end(JSON.stringify({error:error.message,code:error.code}));
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(route,body,method='POST')=>new Promise((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port:server.address().port,path:'/api/donna/firms'+route,
      method,headers:{authorization:'Bearer owner-jwt','content-type':'application/json'}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)});}catch(error){reject(error);}});
    });req.on('error',reject);req.end(JSON.stringify(body));
  });
  let mutateDuringModel=null;
  const contexts=[];
  t.mock.method(globalThis,'fetch',async(endpoint,init)=>{
    if(endpoint==='https://currency-auth.invalid/auth/v1/user')return{ok:true,json:async()=>({id:'owner-user',email:'owner@currency.example'})};
    const body=JSON.parse(init.body);
    if(endpoint==='https://api.openai.com/v1/responses'){
      const input=JSON.parse(body.input);
      const suggestions=(input.transactions||[input.transaction]).map(row=>({transaction_id:row.id,proposed_account:'Rent',
        tax_treatment:'ALV-tarkistus',confidence:'high',evidence_required:true,auto_explain_limit:0,
        reasoning:'Synthetic rent needs its bill.',posting_requirement:'single_account',document_allocations:[],ask_client_question:''}));
      return{ok:true,status:200,json:async()=>({output_text:JSON.stringify({suggestions,group_summary:[]})})};
    }
    assert.equal(endpoint,'https://api.anthropic.com/v1/messages','all providers stubbed at wire; no network');
    const content=body.messages[0].content;
    const context=JSON.parse(content.slice(content.indexOf('\n')+1));contexts.push(context);
    if(mutateDuringModel){const mutate=mutateDuringModel;mutateDuringModel=null;await mutate();}
    const decided=['accepted','posted'].includes(context.transaction.review_state);
    return{ok:true,status:200,json:async()=>({content:[{type:'tool_use',name:body.tools[0].name,input:{text:'Code the current rent evidence.',actions:[{
      type:decided?'recode_decided':'apply_category',account_name:Number(context.transaction.money_in)>0?'Sales':'Rent',tax_treatment:[25.5,510].includes(context.current_coding_evidence?.tax_amount)?'ALV 25,5 %':'Ei ALV-käsittelyä',
      ...(decided?{targets_decided:true}:{}),reason:'Current rental invoice.',coding_evidence:{evidence_digest:'forged-provider-receipt'}
    }]}}],stop_reason:'tool_use'})};
  });
  const tx=async(id)=>pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
    values($1,$2,$3,'2025-01-31','Premises rent',600,0,'EUR','needs_review','{}')`,[id,firmId,clientId]);
  const bill=async(id)=>{
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload)
      values($1,$2,$3,'Vuokralasku.pdf','supplier_bill','completed',600,0,'EUR','2025-01-31','{}')`,['doc-'+id,firmId,clientId]);
    await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
      values($1,$2,$3,$4,1,'Tammikuun vuokra',600,'{}')`,['line-'+id,firmId,clientId,'doc-'+id]);
    await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload)
      values($1,$2,$3,$4,'supplier_bill',$5,600,.95,'suggested','fixture','{}')`,['match-'+id,firmId,clientId,id,'doc-'+id]);
  };
  const confirm=id=>updateReconciliationMatchInDb({firmId,matchId:'match-'+id,patch:{status:'confirmed'},actorId:'owner@currency.example',returnSnapshot:false});
  const scope=id=>({...(browserDefaultScope ? {} : {firm_id:firmId}),client_id:clientId,transaction_id:id});
  const chat=async id=>{
    const response=await request('/transaction-chat/messages',{...scope(id),message:'Recode this rent from the current matched bill.',transaction_context:{id,category:'Fake browser category'}});
    assert.equal(response.status,201,JSON.stringify(response));
    const message=response.body.assistant_message;
    const stored=(await pool.query('select payload from transaction_chat_messages where id=$1',[message.id])).rows[0];
    const receipt=stored.payload.actions[0].coding_evidence;
    assert.ok(receipt,'the actual browser request must persist server-captured coding evidence');
    assert.equal(receipt.firm_id,firmId);assert.equal(receipt.client_id,clientId);
    assert.equal(receipt.transaction_id,id);assert.equal(receipt.message_id,message.id);assert.equal(receipt.action_index,0);
    assert.deepEqual(message.payload.actions[0].coding_evidence,receipt);
    return message;
  };
  const apply=(id,message)=>request(`/transaction-chat/messages/${message.id}/actions/0/apply`,scope(id));
  const row=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
  const journals=async id=>Number((await pool.query('select count(*) n from ledger_journals where source_id=$1',[id])).rows[0].n);
  const ask=async id=>pool.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,evidence_type,status,question,created_by)
    values($1,$2,$3,$4,'supporting_document','draft','Please provide the rent bill.','coding_auto_post')`,['ask-'+id,firmId,clientId,id]);
  await tx('rent');await tx('legacy');await tx('race');
  await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
  const original=(await row('rent')).payload.ai_suggestion;
  assert.equal(original.evidence_digest,codingEvidenceDigest(null));
  await bill('rent');await ask('rent');
  const old=await chat('rent');
  assert.equal(contexts.at(-1).current_coding_evidence.handle,'matched_document');
  assert.equal(contexts.at(-1).current_coding_evidence.lines[0].handle,'line_1');
  assert.ok(!JSON.stringify(contexts.at(-1).current_coding_evidence).includes('doc-rent'));
  assert.ok(!JSON.stringify(contexts.at(-1).current_coding_evidence).includes('line-rent'));
  assert.equal(contexts.at(-1).current_coding_evidence.lines[0].description,'Tammikuun vuokra');
  assert.notEqual(old.payload.actions[0].coding_evidence.evidence_digest,'forged-provider-receipt');
  await confirm('rent');
  const before=await row('rent');
  const refused=await apply('rent',old);assert.equal(refused.status,409,JSON.stringify(refused));
  assert.match(refused.body.error,/matched evidence changed/,JSON.stringify(refused));
  assert.deepEqual(await row('rent'),before,'preflight changes no category, tax, or transaction receipt');assert.equal(await journals('rent'),0);
  const fresh=await chat('rent');assert.equal(fresh.payload.actions[0].type,'apply_category');const applied=await apply('rent',fresh);
  assert.equal(applied.status,201,JSON.stringify(applied));
  assert.equal(await journals('rent'),1,JSON.stringify(applied));
  const posted=await row('rent');assert.equal(posted.coding_state,'posted');
  assert.deepEqual(posted.payload.ai_suggestion,original,'original machine suggestion remains historical');
  assert.equal(posted.payload.accepted_coding_evidence.actor_id,'owner@currency.example');
  assert.equal(posted.payload.accepted_coding_evidence.message_id,fresh.id);
  assert.equal(posted.payload.accepted_coding_evidence.model,fresh.model);
  const rentLines=(await pool.query(`select l.debit,l.credit,a.name from ledger_lines l join ledger_accounts a on a.id=l.account_id
    join ledger_journals j on j.id=l.journal_id where j.source_id='rent' order by l.line_no`)).rows;
  assert.equal(rentLines.length,2);
  assert.ok(rentLines.some(line=>Number(line.debit)===600 && /rent/i.test(line.name)),JSON.stringify(rentLines));
  assert.ok(rentLines.some(line=>Number(line.credit)===600 && /bank|checking/i.test(line.name)),JSON.stringify(rentLines));
  assert.equal((await pool.query("select status from client_evidence_requests where id='ask-rent'")).rows[0].status,'resolved');
  await apply('rent',fresh);assert.equal(await journals('rent'),1,'replay cannot duplicate journal');
  assert.equal(Number((await pool.query("select count(*) n from audit_events where action='evidence_request.superseded_by_coding' and resource_id='rent'")).rows[0].n),1);

  // Exact live state: the old category saved, posting failed, null suggestion status.
  await bill('legacy');await confirm('legacy');await ask('legacy');
  const review=await ensureTransactionReviewItemInDb({firmId,clientId,transactionId:'legacy',source:'fixture-prior-chat'});
  await updateTransactionReviewItemInDb({firmId,reviewItemId:review,actorId:'owner@currency.example',returnSnapshot:false,
    patch:{status:'accepted',review_state:'accepted',category:'Rent',account_name:'Rent',xero_tax_type:'Ei ALV-käsittelyä'}});
  assert.equal((await row('legacy')).coding_state,'applied');assert.equal((await row('legacy')).payload.ai_suggestion_status,undefined);
  await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:'legacy',dryRun:false}),{code:'TRANSACTION_CODING_EVIDENCE_STALE'});
  const recode=await chat('legacy');assert.equal(recode.payload.actions[0].type,'recode_decided');
  const repaired=await apply('legacy',recode);assert.equal(repaired.status,201,JSON.stringify(repaired));
  assert.equal(await journals('legacy'),1,JSON.stringify(repaired));
  assert.equal((await row('legacy')).coding_state,'posted');
  assert.deepEqual((await pool.query(`select l.debit,l.credit,a.name from ledger_lines l join ledger_accounts a on a.id=l.account_id
    join ledger_journals j on j.id=l.journal_id where j.source_id='legacy' order by l.line_no`)).rows,rentLines);
  // A directly posted row has no review sidecar. Its actual old account,
  // not the new empty case file, must reach the delta writer.
  await tx('bare-posted');
  const bareClient=await pool.connect();let originalBare;
  try {
    await bareClient.query('begin');
    const debit={name:'Accounting fees',account_type:'expense'},bank={name:'Bank',account_type:'bank'};
    originalBare=await __writeLedgerJournalRows({client:bareClient,firmId,clientId,actorId:'fixture',journal:{source_type:'transaction',source_id:'bare-posted',journal_date:'2025-01-31',currency:'EUR',memo:'Synthetic bare posting',accounts:[debit,bank],lines:[
      {account:debit,direction:'debit',debit:600,credit:0,amount:600,currency:'EUR'},
      {account:bank,direction:'credit',debit:0,credit:600,amount:600,currency:'EUR'}]}});
    await bareClient.query("update transactions set coding_state='posted',account_code='Accounting fees',payload=$1 where id='bare-posted'",[{ledger_journal_id:originalBare.ledger_journal_id,account_name:'Accounting fees',tax_treatment:'Ei ALV-käsittelyä'}]);
    await bareClient.query('commit');
  } finally {bareClient.release();}
  const originalBareLines=(await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[originalBare.ledger_journal_id])).rows;
  const bareProposal=await chat('bare-posted');
  const bareApplied=await apply('bare-posted',bareProposal);
  assert.equal(bareApplied.status,201,JSON.stringify(bareApplied));
  assert.equal(bareApplied.body.assistant_message.payload.actions[0].result.posting.status,'posted',JSON.stringify(bareApplied.body));
  assert.deepEqual((await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[originalBare.ledger_journal_id])).rows,originalBareLines);
  const bareNet=(await pool.query(`select l.account_name,sum(l.debit-l.credit)::numeric as net from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='bare-posted' or j.correction_of_journal_id=$1 group by l.account_name`,[originalBare.ledger_journal_id])).rows;
  assert.equal(Number(bareNet.find(r=>r.account_name==='Accounting fees').net),0);
  assert.equal(Number(bareNet.find(r=>r.account_name==='Rent').net),600);
  assert.equal(Number(bareNet.find(r=>r.account_name==='Bank').net),-600);
  const countAfter=(await pool.query('select count(*)::int n from ledger_journals')).rows[0].n;
  await apply('bare-posted',bareProposal);
  assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,countAfter);
  // A summary account must not masquerade as every posted component's account.
  await tx('split'); await bill('split'); await confirm('split');
  const accounts=[{name:'Operating supplies',account_type:'expense'},
    {name:'Accounting fees',account_type:'expense'}, {name:'Bank',account_type:'bank'}];
  const ledgerClient=await pool.connect();
  try {
    await ledgerClient.query('begin');
    await __writeLedgerJournalRows({client:ledgerClient,firmId,clientId,actorId:'owner@currency.example',journal:{
      source_type:'transaction',source_id:'split',journal_date:'2025-01-31',currency:'EUR',memo:'Synthetic component journal',
      accounts,lines:accounts.map((account,index)=>({account,direction:index===2?'credit':'debit',
        debit:index===0?400:index===1?200:0,credit:index===2?600:0,amount:index===0?400:index===1?200:600,
        currency:'EUR',memo:['Supplies component','Reference-book component','Bank settlement'][index]}))
    }});
    await ledgerClient.query(`update transactions set coding_state='posted',payload=payload||
      '{"ai_suggestion":{"proposed_account":"Operating supplies","tax_treatment":"Ei ALV-käsittelyä"}}'::jsonb where id='split'`);
    await ledgerClient.query('commit');
  } catch(error) { await ledgerClient.query('rollback'); throw error; }
  finally { ledgerClient.release(); }
  await chat('split');
  const observed=contexts.at(-1).current_posted_accounting;
  assert.equal(observed.provenance,'persisted_ledger_observation');
  assert.equal(observed.journals.length,1,'focal journal only; other transaction journals are excluded');
  assert.equal(contexts.at(-1).transaction.coding_verdict.proposed_account,'Operating supplies');
  assert.deepEqual(observed.journals[0].lines.map(line=>[line.account_name,Number(line.debit),Number(line.credit)]),
    [['Operating supplies',400,0],['Accounting fees',200,0],['Bank',0,600]]);
  assert.equal(await journals('split'),1,'read-only review cannot replace or add a journal');

  // An explicit foreign scope must never fall back to the default owner's book.
  await pool.query("insert into firms(id,name,slug) values('foreign-chat-firm','Foreign','foreign-chat-firm')");
  const messageCount=Number((await pool.query('select count(*) n from transaction_chat_messages')).rows[0].n);
  const contextCount=contexts.length;
  const foreignBody={...scope('legacy'),firm_id:'foreign-chat-firm',message:'Recode this line.'};
  assert.equal((await request('/transaction-chat/messages',foreignBody)).status,403);
  assert.equal((await request(`/transaction-chat/messages/${recode.id}/actions/0/apply`,foreignBody)).status,403);
  assert.equal(contexts.length,contextCount,'foreign scope is refused before model work');
  assert.equal(Number((await pool.query('select count(*) n from transaction_chat_messages')).rows[0].n),messageCount);
  assert.equal(await journals('legacy'),1);
  assert.equal((await pool.query("select status from client_evidence_requests where id='ask-legacy'")).rows[0].status,'resolved');

  await bill('race');await confirm('race');
  mutateDuringModel=()=>pool.query("update document_lines set description='Changed during reasoning' where id='line-race'");
  const raced=await chat('race');const raceBefore=await row('race');
  assert.equal((await apply('race',raced)).status,409);
  assert.deepEqual(await row('race'),raceBefore);assert.equal(await journals('race'),0);
  const missing=await chat('race');
  await pool.query(`update transaction_chat_messages set payload=jsonb_set(payload,'{actions,0}',(payload#>'{actions,0}')-'coding_evidence') where id=$1`,[missing.id]);
  const legacyRefusal=await apply('race',missing);assert.equal(legacyRefusal.status,409);assert.match(legacyRefusal.body.error,/fresh correction/);
  // Public review PATCH cannot mint the separately trusted authority parameter.
  const raceReview=await ensureTransactionReviewItemInDb({firmId,clientId,transactionId:'race',source:'fixture'});
  const forged=await request(`/transaction-review/${raceReview}`,{firm_id:firmId,actorId:'forged',
    codingEvidenceAuthority:{receipt:recode.payload.actions[0].coding_evidence},patch:{status:'open',
      accepted_coding_evidence:recode.payload.actions[0].coding_evidence,
      codingEvidenceAuthority:{receipt:recode.payload.actions[0].coding_evidence}}},'PATCH');
  assert.equal(forged.status,200,JSON.stringify(forged));
  assert.equal((await row('race')).payload.accepted_coding_evidence,undefined);

  // Bank input changes during reasoning invalidate exactly the captured source.
  for (const [field,value] of [['money_out',601],['currency','USD'],['transaction_date','2025-02-01'],['raw_description','Different source reference']]) {
    const id='bank-'+field;await tx(id);await bill(id);await confirm(id);
    mutateDuringModel=()=>pool.query(`update transactions set ${field}=$2 where id=$1`,[id,value]);
    const proposed=await chat(id);const changed=await row(id);
    assert.equal(contexts.at(-1).transaction.money_out,600);
    assert.equal((await apply(id,proposed)).status,409,field);
    assert.deepEqual(await row(id),changed,field);assert.equal(await journals(id),0);
  }

  await tx('vat');await bill('vat');await confirm('vat');
  await pool.query("update transactions set money_out=125.5 where id='vat'");
  await pool.query("update documents set total_amount=125.5,tax_amount=25.5 where id='doc-vat'");
  await pool.query("update document_lines set amount=100 where id='line-vat'");
  await pool.query("update reconciliation_matches set match_amount=125.5 where id='match-vat'");
  const vatProposal=await chat('vat');const vatResult=await apply('vat',vatProposal);
  assert.equal(vatResult.status,201,JSON.stringify(vatResult));assert.equal(await journals('vat'),1,JSON.stringify(vatResult));
  const vatLines=(await pool.query(`select l.debit,l.credit,l.tax_type,a.name from ledger_lines l join ledger_accounts a on a.id=l.account_id
    join ledger_journals j on j.id=l.journal_id where j.source_id='vat' order by l.line_no`)).rows;
  assert.ok(vatLines.some(line=>Number(line.debit)===100),JSON.stringify(vatLines));
  assert.ok(vatLines.some(line=>Number(line.debit)===25.5),JSON.stringify(vatLines));
  assert.ok(vatLines.some(line=>Number(line.credit)===125.5),JSON.stringify(vatLines));

  await tx('contact-race');await bill('contact-race');await confirm('contact-race');
  mutateDuringModel=()=>pool.query("update transactions set payload=payload||'{\"contact\":\"Another counterparty\"}'::jsonb where id='contact-race'");
  const contactRace=await chat('contact-race');
  assert.equal((await apply('contact-race',contactRace)).status,409);assert.equal(await journals('contact-race'),0);

  // Both selectors are individually valid, but use different tie-breakers.
  // Two distinct documents for one bank line is a reachable candidate set.
  await tx('two-suggestions');await bill('two-suggestions');
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload)
    select 'doc-two-candidate-b',firm_id,client_id,'Alternative rent.pdf',document_type,parse_status,total_amount,tax_amount,currency,document_date,payload
    from documents where id='doc-two-suggestions'`);
  await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status)
    values('zz-match-two',$1,$2,'two-suggestions','supplier_bill','doc-two-candidate-b',600,1,'suggested')`,[firmId,clientId]);
  const {fetchActiveTransactionMatch}=await import('./transactionChat.js');
  assert.equal((await fetchActiveTransactionMatch({client:pool,firmId,bankTransactionId:'two-suggestions'})).matched_object_id,'doc-two-candidate-b');
  assert.equal((await currentCodingEvidence({client:pool,firmId,clientId,transactionId:'two-suggestions'})).document_id,'doc-two-suggestions');
  const twoCandidates=await chat('two-suggestions');
  assert.equal(contexts.at(-1).existing_match.document_id,'doc-two-suggestions','focused match uses the same source as coding evidence');
  assert.equal(contexts.at(-1).current_coding_evidence.filename,'Vuokralasku.pdf');
  assert.ok(contexts.at(-1).collision_group.matches.some(match=>match.document_id==='doc-two-candidate-b'),'competing sibling remains available');
  assert.equal(twoCandidates.payload.actions[0].coding_evidence.evidence_digest,
    codingEvidenceDigest(await currentCodingEvidence({client:pool,firmId,clientId,transactionId:'two-suggestions'})));
  await confirm('two-suggestions');
  assert.equal((await apply('two-suggestions',twoCandidates)).status,409,'a genuine selected status change still invalidates the proposal');
  // Intercept real SQL only to schedule competing sessions at the final boundary.
  let queryHook=null;
  const wrapped=new WeakSet();
  pool.on('acquire',connection=>{
    if(wrapped.has(connection))return;wrapped.add(connection);
    const originalQuery=connection.query;
    connection.query=function(query,...args){
      const text=typeof query==='string'?query:query.text;
      if(queryHook && typeof args.at(-1)!=='function')return Promise.resolve(queryHook(text,args[0])).then(()=>originalQuery.call(this,query,...args));
      return originalQuery.call(this,query,...args);
    };
  });
  // Earlier candidate/collision reads may not contradict the receipt capture.
  await tx('snapshot-race');await bill('snapshot-race');await confirm('snapshot-race');
  const callsBefore=contexts.length;
  let captureCount=0;
  queryHook=async text=>{
    if(text==='select jurisdiction from clients where firm_id=$1 and id=$2' && ++captureCount===2){
      queryHook=null;await pool.query("update documents set total_amount=601 where id='doc-snapshot-race'");
    }
  };
  const incoherent=await request('/transaction-chat/messages',{...scope('snapshot-race'),message:'Code this rent.',candidate_documents:[{id:'doc-snapshot-race'}]});
  queryHook=null;assert.equal(incoherent.status,409,JSON.stringify(incoherent));
  assert.equal(incoherent.body.code,'TRANSACTION_CHAT_CONTEXT_CHANGED');assert.equal(contexts.length,callsBefore,'no model called on contradictory source snapshots');
  for(const [field,value] of [['money_out',601],['currency','USD'],['transaction_date','2025-02-01'],['raw_description','Changed after acceptance']]){
    const id='accepted-'+field;await tx(id);await bill(id);await confirm(id);const proposal=await chat(id);
    let changedAfterAccept=false;
    queryHook=async(text,params)=>{
      if(!changedAfterAccept && text==='select * from transactions where firm_id = $1 and client_id = $2 and id = $3 for update' && params?.[2]===id){
        changedAfterAccept=true;queryHook=null;
        assert.ok((await row(id)).payload.accepted_coding_evidence,'coding committed before this source mutation');
        await pool.query(`update transactions set ${field}=$2 where id=$1`,[id,value]);
      }
    };
    const result=await apply(id,proposal);queryHook=null;
    assert.equal(changedAfterAccept,true);assert.equal(result.status,201,JSON.stringify(result));
    assert.equal(result.body.assistant_message.payload.actions[0].result.posting.status,'error');
    assert.equal(await journals(id),0);assert.equal((await row(id)).coding_state,'applied');
  }
  await tx('post-race');await bill('post-race');await confirm('post-race');
  const postRace=await chat('post-race');let changedBeforeJournal=false;
  queryHook=async text=>{
    if(!changedBeforeJournal && /select payload\s+from transaction_review_queue/.test(text)){
      changedBeforeJournal=true;queryHook=null;
      await pool.query("update documents set filename='Changed after prepare.pdf' where id='doc-post-race'");
    }
  };
  const postRefusal=await apply('post-race',postRace);queryHook=null;
  assert.equal(changedBeforeJournal,true);assert.equal(postRefusal.status,201,JSON.stringify(postRefusal));
  assert.equal(postRefusal.body.assistant_message.payload.actions[0].result.posting.status,'error');
  assert.equal(await journals('post-race'),0,'source mutation after preparation is rechecked before journal');
  const ready=await chat('race');const preWriter=await row('race');
  let writerRace=false;
  queryHook=async text=>{
    if(!writerRace && text==='select * from transactions where firm_id = $1 and id = $2 for update'){
      writerRace=true;queryHook=null;
      await pool.query("update document_lines set amount=599 where id='line-race'");
    }
  };
  const writerRefusal=await apply('race',ready);queryHook=null;
  assert.equal(writerRace,true);assert.equal(writerRefusal.status,409,JSON.stringify(writerRefusal));
  assert.equal((await row('race')).category,preWriter.category);
  assert.equal((await row('race')).payload.tax_treatment,preWriter.payload.tax_treatment);
  assert.equal((await row('race')).payload.accepted_coding_evidence,undefined);
  assert.equal(await journals('race'),0);

  // A source writer cannot sneak past the final journal-boundary reread.
  await pool.query("update document_lines set amount=600 where id='line-race'");
  const lockedProposal=await chat('race');
  const attacker=await pool.connect();
  let sawFinalJournal=false;
  queryHook=async text=>{
    if(!sawFinalJournal && /insert into ledger_journals/i.test(text)){
      sawFinalJournal=true;queryHook=null;
      for(const sql of [
        "update documents set tax_amount=1 where id='doc-race'",
        "update document_lines set amount=599 where id='line-race'",
        "update reconciliation_matches set status='rejected' where id='match-race'",
        {text:"insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount) values('phantom',$1,$2,'doc-race',2,'Late line',1)",values:[firmId,clientId]},
        {text:"insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status) values('phantom-match',$1,$2,'race','supplier_bill','doc-legacy','confirmed')",values:[firmId,clientId]}
      ]){
        await attacker.query('begin');await attacker.query("set local lock_timeout='100ms'");
        try { await assert.rejects(attacker.query(sql),{code:'55P03'},typeof sql==='string'?sql:sql.text); } finally { await attacker.query('rollback'); }
      }
    }
  };
  const lockedResult=await apply('race',lockedProposal);queryHook=null;attacker.release();
  assert.equal(sawFinalJournal,true,JSON.stringify(lockedResult));
  assert.equal(lockedResult.status,201,JSON.stringify(lockedResult));assert.equal(await journals('race'),1);

  // Later unrelated coding cannot borrow this accepted decision's source authority.
  const accepted=(await row('race')).payload.accepted_coding_evidence;
  await pool.query("update transactions set category='Travel' where id='race'");
  const {assertCurrentCodingEvidence}=await import('./db/codingEvidence.js');
  const {rowToTransactionPayload}=await import('./db/transactions.js');
  await assert.rejects(assertCurrentCodingEvidence({client:pool,firmId,clientId,transaction:rowToTransactionPayload(await row('race'))}),{code:'TRANSACTION_CODING_EVIDENCE_STALE'});
  await pool.query("update transactions set category='Rent',money_out=601 where id='race'");
  await assert.rejects(assertCurrentCodingEvidence({client:pool,firmId,clientId,transaction:rowToTransactionPayload(await row('race'))}),{code:'TRANSACTION_CODING_EVIDENCE_STALE'});
  const {postingSourceReceipt}=await import('./db/postingPolicyContext.js');
  const beforeReceipt=rowToTransactionPayload(await row('legacy'));
  assert.notEqual(postingSourceReceipt(beforeReceipt),postingSourceReceipt({...beforeReceipt,accepted_coding_evidence:{...accepted,message_id:'another-message'}}));

  await tx('allocation');await bill('allocation');await confirm('allocation');
  await pool.query(`update transactions set payload=$2 where id=$1`,['allocation',{ai_suggestion:{posting_requirement:'document_allocation',document_allocations:[{line_handle:'line_1',account:'Rent'}]}}]);
  const allocation=await chat('allocation');const allocationBefore=await row('allocation');
  const allocationResult=await apply('allocation',allocation);assert.equal(allocationResult.status,409,JSON.stringify(allocationResult));
  assert.equal((await row('allocation')).category,allocationBefore.category);assert.equal(await journals('allocation'),0);
  for(const requirement of ['owner_fact','payroll_package','document_discrepancy']){
    const id='requirement-'+requirement;await tx(id);await bill(id);await confirm(id);
    await pool.query('update transactions set payload=$2 where id=$1',[id,{ai_suggestion:{posting_requirement:requirement}}]);
    const proposal=await chat(id);const unchanged=await row(id);const refusal=await apply(id,proposal);
    assert.equal(refusal.status,409);assert.equal(refusal.body.code,'TRANSACTION_CODING_REQUIREMENT_UNRESOLVED',JSON.stringify(refusal));
    assert.deepEqual(await row(id),unchanged,'unsupported requirement remains on its existing consumer');assert.equal(await journals(id),0);

    const blocked={...beforeReceipt,ai_suggestion:{...beforeReceipt.ai_suggestion,posting_requirement:requirement}};
    await assert.rejects(assertCurrentCodingEvidence({client:pool,firmId,clientId,transaction:blocked}),{code:'TRANSACTION_CODING_REQUIREMENT_UNRESOLVED'});
  }

  // Hosted pilot parity: incoming sales on an accrual FI company, not only cash expenses.
  assert.equal((await pool.query('select profile from clients where id=$1',[clientId])).rows[0].profile.accounting_basis,'accrual');
  await tx('sales-accrual');await bill('sales-accrual');
  await pool.query("update transactions set description='Customer payment INV-2025-01',money_in=2510,money_out=0 where id='sales-accrual'");
  await pool.query("update documents set document_type='sales_invoice',filename='Myyntilasku.pdf',vendor_name=null,customer_name='Synthetic Customer Oy',total_amount=2510,tax_amount=510 where id='doc-sales-accrual'");
  await pool.query("update document_lines set description='Services',amount=2000 where id='line-sales-accrual'");
  await pool.query("update reconciliation_matches set matched_object_type='sales_invoice',match_amount=2510 where id='match-sales-accrual'");
  await confirm('sales-accrual');await ask('sales-accrual');
  const salesProposal=await chat('sales-accrual');const salesResult=await apply('sales-accrual',salesProposal);
  assert.equal(salesResult.status,201,JSON.stringify(salesResult));assert.equal(await journals('sales-accrual'),1,JSON.stringify(salesResult));
  const salesLines=(await pool.query(`select l.debit,l.credit,l.tax_type,a.name from ledger_lines l join ledger_accounts a on a.id=l.account_id
    join ledger_journals j on j.id=l.journal_id where j.source_id='sales-accrual' order by l.line_no`)).rows;
  assert.equal(salesLines.length,3,JSON.stringify(salesLines));
  assert.ok(salesLines.some(line=>Number(line.debit)===2510 && /bank|checking/i.test(line.name)),JSON.stringify(salesLines));
  assert.ok(salesLines.some(line=>Number(line.credit)===2000 && /sales/i.test(line.name)),JSON.stringify(salesLines));
  assert.ok(salesLines.some(line=>Number(line.credit)===510 && /vat|alv|arvonlisävero/i.test(line.name)),JSON.stringify(salesLines));
  assert.equal((await row('sales-accrual')).coding_state,'posted');
  assert.equal((await pool.query("select status from client_evidence_requests where id='ask-sales-accrual'")).rows[0].status,'resolved');
  await apply('sales-accrual',salesProposal);assert.equal(await journals('sales-accrual'),1);

});
}
