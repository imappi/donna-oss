import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests} from './firmDb.js';
import {__writeLedgerJournalRows,postLedgerAdjustmentInDb} from './db/ledger.js';
import {recoverChangedCodingEvidenceInDb} from './db/codingEvidence.js';
import {recoverPostedCodingCorrectionsInDb,correctionDeltaLines,CODING_CORRECTION_FLAG} from './db/codingCorrection.js';
import {resolveClientEvidenceRequestInDb,__createClientEvidenceRequestWithClient} from './db/asks.js';
import {setClientFlagStage} from './clientConfig.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';
import {resolveCodingPolicy,codingPolicyReceipt} from './codingPolicy.js';
import {runCodingConvergenceInDb} from './codingConvergence.js';
import {readJevCase} from './jevPreview.js';
import {hash} from './jevEvidenceContract.js';
import {convergenceForTransaction} from './reconcileConvergenceState.js';

const envKeys=['TYPESAFE_API_KEY','TYPESAFE_MODEL','OPENAI_API_KEY'];
const tax='ALV 25,5 %',none='Ei ALV-käsittelyä',exempt='Veroton toiminta (ALV-vapaa)';
const scope={firmId:'f',clientId:'c'};

test('delta preserves unchanged principal, VAT and cash while moving only the erroneous component',()=>{
 const old=[{account_name:'Sales',credit:720,currency:'EUR'},{account_name:'VAT',credit:183.6,role:'alv_output',currency:'EUR'},
  {account_name:'Interest expense',credit:20,currency:'EUR'},{account_name:'Bank',debit:923.6,role:'bank',currency:'EUR'}];
 const target=old.map(l=>l.account_name==='Interest expense'?{...l,account_name:'Interest income'}:l);
 const delta=correctionDeltaLines(old,target);
 assert.deepEqual(delta.map(l=>[l.account_name,l.debit,l.credit]),[['Interest expense',20,0],['Interest income',0,20]]);
});

test('real PG: current evidence -> Jev -> adjustment/ask -> reply -> verified terminal, with races and restarts',
 async t=>{
 assert.ok(process.env.DONNA_PG_TEST_URL,'INCOMPLETE: DONNA_PG_TEST_URL is required for the correction lifecycle; never a green skip.');
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const db=`coding_correction_${process.pid}_${Date.now()}`;await admin.query(`create database "${db}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${db}`;
 const pool=new pg.Pool({connectionString:url.toString(),max:4}),closed=[];
 pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,savedEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(savedEnv)){if(v==null)delete process.env[k];else process.env[k]=v;}
  __resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${db}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);
 for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','correction-test');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Synthetic company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash"}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 const withClient=async fn=>{const client=await pool.connect();try{return await fn(client);}finally{client.release();}};
 await withClient(client=>enrollJevExperiment({client,...scope,actorId:'member',authorityBasis:'Synthetic regression only',trialId:'correction',expiresAt:'2100-01-01',model:'fixture-provider'}));
 const flags=['JURISDICTION_ACCOUNT_PALETTE','FINLAND_ALV_CODING','JEV_RECONCILIATION','CODING_AUTO_POST','LEDGER_AUTO_POST'];
 for(const flagKey of flags)await withClient(client=>setClientFlagStage(client,{...scope,flagKey,stage:'canary',actorId:'member',actorType:'firm_member',reason:'Synthetic regression'}));
 const policy=codingPolicyReceipt(resolveCodingPolicy({jurisdiction:'fi',businessDate:'2025-02-24',accountingSystem:'none'}));
 const tx=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
 const seed=async(id,{amount=923.6,incoming=true,document=true,privateUse=false}={})=>{
  if(document){
   await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary)
    values($1,'f','c',$1,'sales_invoice','completed','2025-02-24','EUR',923.6,183.6,'{"line_amounts_include_tax":true}')`,[`${id}-doc`]);
   for(const [i,amount,rate]of [[1,903.6,.255],[2,20,0]])await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
    values($1,'f','c',$2,$3,$4,$5,$6)`,[`${id}-line-${i}`,`${id}-doc`,i,i===1?'Original invoice':'Exempt reminder charge',amount,{raw_extraction:{tax_rate:rate}}]);
  }
  const suggestion={source:'jev',decision_engine:'jev',model:'fixture-provider',proposed_account:incoming?'Sales':'Suoritettava arvonlisävero',tax_treatment:incoming?tax:none,
   coding_policy:policy,posting_requirement:document?'document_allocation':'single_account',evidence_digest:'historical-source',
   document_allocations:document?[{line_handle:'line_1',account:'Sales',tax_treatment:tax},{line_handle:'line_2',account:'Interest expense',tax_treatment:exempt}]:[]};
  await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
   values($1,'f','c','2025-02-24',$1,$2,$3,'EUR','posted','posted',$4)`,[id,incoming?amount:0,incoming?0:amount,{ai_suggestion:suggestion,ai_suggestion_status:'auto_applied'}]);
  if(document)await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status)
   values($1,'f','c',$2,'sales_invoice',$3,923.6,1,'auto_matched')`,[`${id}-match`,id,`${id}-doc`]);
  const line=(name,role,debit,credit,taxType='NONE')=>({account:{name,code:role==='alv_output'?'2939':'',type:name==='Bank'?'bank':name==='Interest expense'?'expense':name==='Sales'?'revenue':'unknown',role,tax_type:taxType},
   direction:debit?'debit':'credit',debit,credit,amount:debit||credit,currency:'EUR'});
  const lines=privateUse?[line('Bank','bank',0,52.1),line(privateUse==='equity'?'Owner drawings':'Travel','counterparty',41.51,0,'ALV_25_5_INPUT'),
   {...line('Vähennettävä arvonlisävero','alv_input',10.59,0),account:{name:'Vähennettävä arvonlisävero',code:'2940',type:'asset',role:'alv_input',tax_type:'NONE'}}]:document?[line('Bank','bank',923.6,0),line('Sales','counterparty',0,720,'ALV_25_5_OUTPUT'),
   line('Suoritettava arvonlisävero','alv_output',0,183.6,'NONE'),line('Interest expense','counterparty',0,20,'ALV_EXEMPT')]
   :incoming?[line('Bank','bank',amount,0),line('Sales','counterparty',0,362.55,'ALV_25_5_OUTPUT'),line('Suoritettava arvonlisävero','alv_output',0,92.45)]:[line('Suoritettava arvonlisävero','counterparty',amount,0),line('Bank','bank',0,amount)];
  const out=await withClient(async client=>{await client.query('begin');try{const result=await __writeLedgerJournalRows({client,...scope,
   journal:{source_type:'transaction',source_id:id,journal_date:'2025-02-24',currency:'EUR',memo:id,lines,accounts:lines.map(l=>l.account),amount},actorId:'coding_auto_post'});await client.query('commit');return result;}catch(e){await client.query('rollback');throw e;}});
  await pool.query("update transactions set payload=payload || jsonb_build_object('ledger_journal_id',$2::text) where id=$1",[id,out.ledger_journal_id]);
  return out.ledger_journal_id;
 };
 await pool.query("insert into ledger_accounts(id,firm_id,client_id,name,account_type,normal_balance,status) values('interest-income','f','c','Interest income','revenue','credit','active')");
 const originalId=await seed('reminder');
 const original=await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[originalId]);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('reminder')).payload.coding_correction_required.status,'pending');
 let calls=0,phase='allocation',race=null,lastRequest=null;
 globalThis.fetch=async(endpoint,init)=>{
  assert.match(String(endpoint),/api\.typesafe\.ai/,'Jev remains first; no paid transport');calls++;
  const request=JSON.parse(init.body);
  lastRequest=request;
  if(race){const fn=race;race=null;await fn();}
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria);
   let choice=key==='decision'?(phase==='ask'?'ask_statutory_source':phase==='identity_ask'?'ask_source_relationship':phase==='sales_ask'?'ask_sales_source':phase==='allocation'?'document_allocation':'resolved'):key==='materiality'?'low':key==='source_identity_resolution'?(phase==='identity_reply'?'owner_explained_relationship':'relationship_unresolved'):null;
   if(choice==='resolved' && !q.criteria.resolved){const account=['personal','bad_personal_tax'].includes(phase)?'Owner drawings':phase.startsWith('identity_')?'Travel':phase==='cash'?'Cash':phase==='statutory'?'Suoritettava arvonlisävero':'Sales';const selectedTax=['bad_tax','bad_personal_tax'].includes(phase)?tax:none;choice=entries.find(([,label])=>label.includes(`to ${account}, tax treatment ${selectedTax};`))?.[0];}
   if(!choice)choice=entries.find(([,label])=>label===(key.endsWith('_tax')?(key.startsWith('line_2')?exempt:tax):key==='tax'?(['bad_tax','bad_personal_tax'].includes(phase)?tax:none):key.startsWith('line_2')?'Interest income':phase==='statutory'?'Suoritettava arvonlisävero':(phase==='bad_personal'||phase.startsWith('identity_'))?'Travel':['personal','bad_personal_tax'].includes(phase)?'Owner drawings':phase==='cash'?'Cash':'Sales'))?.[0]||entries[0][0];
   return[key,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.9:.1/(entries.length-1)]))}];
  }));return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 let result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].code,'CODING_CORRECTION_AUTHORITY_REQUIRED');assert.equal(calls,0);
 const blocked=(await tx('reminder')).payload.coding_correction_required;
 assert.equal(blocked.recovery.state,'blocked');
 assert.equal(blocked.recovery.attempts,undefined,'a missing grant does not consume accounting reconsiderations');
 assert.equal(convergenceForTransaction(await tx('reminder')).reason,'posted_evidence_correction_blocked:CODING_CORRECTION_AUTHORITY_REQUIRED');
 const failureCount=async id=>(await pool.query("select count(*)::int n from audit_events where resource_id=$1 and action='coding.correction_failed'",[id])).rows[0].n;
 assert.equal(await failureCount('reminder'),1);
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].code,'CODING_CORRECTION_AUTHORITY_REQUIRED');
 assert.equal(await failureCount('reminder'),1,'the unchanged blocked dependency is probed without another failure event');
 await withClient(client=>setClientFlagStage(client,{...scope,flagKey:CODING_CORRECTION_FLAG,stage:'canary',actorId:'member',actorType:'firm_member',reason:'Correct source-proven autonomous journals in this synthetic book'}));
 phase='bad_tax';
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].code,'TRANSACTION_ALV_CODING_SOURCE_CONFLICT',JSON.stringify(result));
 const rejectedCalls=calls;
 assert.deepEqual((await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[originalId])).rows,original.rows);
 phase='allocation';
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].state,'completed',JSON.stringify(result));
 assert.ok(calls>rejectedCalls,'a rejected treatment is reconsidered, not endlessly replayed');
 assert.equal(lastRequest.state.transaction.correction_context.previous_refusal.code,'TRANSACTION_ALV_CODING_SOURCE_CONFLICT');
 assert.equal(lastRequest.state.execution_constraints[0].scope,'whole_document_single_account');
 const requirement=(await tx('reminder')).payload.coding_correction_required;
 assert.equal(requirement.status,'corrected');assert.equal(requirement.correction_journal_ids.length,1);
 assert.deepEqual((await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[originalId])).rows,original.rows);
 const delta=(await pool.query('select account_code,account_name,debit,credit,tax_type,payload from ledger_lines where journal_id=$1 order by line_no',[requirement.correction_journal_ids[0]])).rows;
 assert.deepEqual(delta.map(l=>[l.account_name,Number(l.debit),Number(l.credit)]),[['Interest expense',20,0],['Interest income',0,20]],JSON.stringify(delta));
 const spent=calls;
 assert.deepEqual(await recoverPostedCodingCorrectionsInDb({firmId:'f'}),[]);assert.equal(calls,spent);
 const retry=await postLedgerAdjustmentInDb({...scope,transactionId:'reminder',reason:'Retry same receipt',codingCorrection:{decision_digest:requirement.recovery.decision_digest}});
 assert.equal(retry.coding_correction.status,'corrected');
 assert.equal((await pool.query('select count(*)::int n from ledger_journals where correction_of_journal_id=$1',[originalId])).rows[0].n,1);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('reminder')).payload.coding_correction_required.status,'corrected');
 // A genuine missing filing produces one persisted unsent question, never a
 // tax-account choice for the owner. Reply is saved through the real writer.
 await seed('statutory',{amount:1245,incoming:false,document:false});phase='ask';
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 phase='statutory';
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].code,'CODING_CORRECTION_EXECUTION_REFUSED');
 assert.equal((await tx('statutory')).payload.coding_correction_required.recovery.details.reason,'statutory_evidence_required');
 phase='ask';
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].state,'owner_question',JSON.stringify(result));
 assert.equal(lastRequest.state.transaction.correction_context.previous_refusal.details.reason,'statutory_evidence_required');
 const ask=(await pool.query("select * from client_evidence_requests where transaction_id='statutory'")).rows[0];
 assert.equal(ask.status,'draft');assert.match(ask.question,/liability and period/);assert.equal(ask.send_count,0);
 const beforeWait=calls;await recoverPostedCodingCorrectionsInDb({firmId:'f'});assert.equal(calls,beforeWait);
 await resolveClientEvidenceRequestInDb({firmId:'f',evidenceRequestId:ask.id,reply:'The filed return covers Q4. The notice is attached.',actorId:'member',actorType:'firm_member',answerSource:'in_person'});
 assert.equal((await pool.query('select status from client_evidence_requests where id=$1',[ask.id])).rows[0].status,'replied');
 assert.equal(convergenceForTransaction(await tx('statutory'),{hasAnsweredOwnerAsk:true}).state,'hanging');
 await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary)
 values('notice','f','c','notice.pdf','payment_confirmation','completed','2025-02-24','EUR',1245,0,'{"period":"Q4"}');
 insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status)
 values('notice-match','f','c','statutory','payment_confirmation','notice',1245,1,'auto_matched');`);
 phase='statutory';result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].state,'completed',JSON.stringify(result));
 assert.equal((await pool.query('select status from client_evidence_requests where id=$1',[ask.id])).rows[0].status,'resolved');
 assert.equal((await tx('statutory')).coding_state,'posted');
 // A source change during generation cannot reach the adjustment writer.
 await seed('race');await recoverChangedCodingEvidenceInDb({firmId:'f'});phase='allocation';
 race=()=>pool.query("update document_lines set description='Changed source component' where id='race-line-2'");
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].code,'CODING_CORRECTION_STALE',JSON.stringify(result));
 assert.equal((await tx('race')).payload.coding_correction_required.status,'pending');
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].state,'completed',JSON.stringify(result));
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='race'")).rows[0].n,0);
 const tick=()=>runCodingConvergenceInDb({firmId:'f',
  discoverCoderClientsFn:async()=>[],discoverSweepClientsFn:async()=>[],discoverLedgerPostClientsFn:async()=>[],
  releaseWaitingFn:async()=>[],recoverAskDraftFn:async()=>[],recoverOwnerRepliesFn:null,
  recoverReconciliationProviderFailuresFn:null,recoverMaterialExceptionsFn:null,hostedPilotTerminalConvergenceFn:null,
  recoverAeVatLegacyCodingFn:null,recoverRefusedEvidenceFn:null});
 // The same existing clock consumes a changed source after completion without
 // duplicating the first correction. Shared case context includes both journals.
 const packet=await withClient(client=>readJevCase({client,...scope,transactionId:'reminder',evidenceOnly:true,includePostingLines:true}));
 assert.equal(packet.caseEvidence.postings.filter(p=>p.correction_of_journal_id===originalId).length,1);
 await pool.query("update document_lines set description='Additional clarification, same amounts' where id='reminder-line-2'");
 phase='allocation';let clockResult=await tick();
 assert.equal(clockResult.posted_correction_recovery.find(r=>r.transactionId==='reminder')?.state,'completed',JSON.stringify(clockResult));
 assert.equal((await tx('reminder')).payload.coding_correction_required.verified_no_change,true);
 assert.equal((await pool.query('select count(*)::int n from ledger_journals where correction_of_journal_id=$1',[originalId])).rows[0].n,1);
 // A cash deposit is not a second sale. Preserve the owner reply and move the
 // original unsupported revenue/VAT to already-recorded cash through adjustment.
 await seed('cash',{amount:455,document:false});phase='sales_ask';
 clockResult=await tick();assert.equal(clockResult.posted_correction_recovery[0].state,'owner_question',JSON.stringify(clockResult));
 const cashAsk=(await pool.query("select * from client_evidence_requests where transaction_id='cash'")).rows[0];
 assert.match(cashAsk.question,/already recorded/);assert.equal(cashAsk.evidence_type,'supporting_document');
 await resolveClientEvidenceRequestInDb({firmId:'f',evidenceRequestId:cashAsk.id,reply:'These sales were recorded in the cashbook already. This is cash transferred to the bank.',actorId:'member',actorType:'firm_member',answerSource:'in_person'});
 await pool.query("insert into ledger_accounts(id,firm_id,client_id,name,account_type,normal_balance,status) values('cash-account','f','c','Cash','asset','debit','active')");
 phase='cash';clockResult=await tick();
 assert.equal(clockResult.posted_correction_recovery[0].state,'completed',JSON.stringify(clockResult));
 const cashReq=(await tx('cash')).payload.coding_correction_required;
 const cashDelta=(await pool.query('select account_name,debit,credit from ledger_lines where journal_id=any($1::text[])',[cashReq.correction_journal_ids])).rows;
 assert.deepEqual(cashDelta.map(l=>[l.account_name,Number(l.debit),Number(l.credit)]),[['Sales',362.55,0],['Suoritettava arvonlisävero',92.45,0],['Cash',0,455]]);
 assert.equal((await pool.query('select status from client_evidence_requests where id=$1',[cashAsk.id])).rows[0].status,'resolved');
 // Explicit personal source removes both business expense and input VAT. The
 // matched receipt does not erase the separate owner-transfer authority gate.
 await seed('personal',{amount:52.1,incoming:false,document:false,privateUse:true});
 await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary)
 values('private-doc','f','c','private.pdf','receipt','completed','2025-02-24','EUR',52.1,10.59,
 '{"source_business_use":{"classification":"personal","source_quote":"YKSITYISAJO 14.2. / M.L."}}');
 insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status)
 values('private-match','f','c','personal','receipt','private-doc',52.1,1,'auto_matched');`);
 phase='bad_personal_tax';clockResult=await tick();
 assert.equal(clockResult.posted_correction_recovery[0].code,'CODING_CORRECTION_SOURCE_USE_CONFLICT',JSON.stringify(clockResult));
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='personal'")).rows[0].n,0,'a known personal-use source conflict must not manufacture a redundant question');
 assert.equal((await tx('personal')).payload.coding_correction_required.recovery.details.constraint,'personal_source_cannot_claim_input_tax');
 const refusedSource=(await tx('personal')).payload.coding_correction_required.recovery;
 const transportFailure=await recoverPostedCodingCorrectionsInDb({firmId:'f',suggestFn:async()=>({provider_failure:{code:'PROVIDER_REJECTED_REQUEST',reason:'synthetic_request_failure'}})});
 assert.equal(transportFailure[0].code,'PROVIDER_REJECTED_REQUEST');
 assert.deepEqual((await tx('personal')).payload.coding_correction_required.recovery.previous_refusal,{code:refusedSource.code,details:refusedSource.details});
 assert.equal((await tx('personal')).payload.coding_correction_required.recovery.attempts,refusedSource.attempts,'a provider failure does not consume an accounting reconsideration');
 const providerFailures=await failureCount('personal');
 const repeatedTransport=await recoverPostedCodingCorrectionsInDb({firmId:'f',suggestFn:async()=>({provider_failure:{code:'PROVIDER_REJECTED_REQUEST',reason:'synthetic_request_failure'}})});
 assert.equal(repeatedTransport[0].state,'blocked');
 assert.equal(await failureCount('personal'),providerFailures,'an unchanged transport blocker has one failure receipt');
 assert.equal((await tx('personal')).payload.coding_correction_required.recovery.attempts,refusedSource.attempts);

 phase='personal';clockResult=await tick();
 assert.equal(lastRequest.state.transaction.correction_context.previous_refusal.code,'CODING_CORRECTION_SOURCE_USE_CONFLICT');
 assert.equal(clockResult.posted_correction_recovery[0].state,'blocked',JSON.stringify(clockResult));
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='personal'")).rows[0].n,0,'missing execution authority must not manufacture a question');
 const beforeRetry=calls;await tick();assert.equal(calls,beforeRetry,'saved semantic decision is reused after writer refusal');
 await withClient(client=>setClientFlagStage(client,{...scope,flagKey:'CODING_OWNER_TRANSFER_POST',stage:'canary',actorId:'member',actorType:'firm_member',reason:'Synthetic owner-transfer authority'}));
 clockResult=await tick();assert.equal(clockResult.posted_correction_recovery[0].state,'completed',JSON.stringify(clockResult));
 const privateReq=(await tx('personal')).payload.coding_correction_required;
 const privateDelta=(await pool.query('select account_name,debit,credit from ledger_lines where journal_id=any($1::text[])',[privateReq.correction_journal_ids])).rows;
 assert.deepEqual(privateDelta.map(l=>[l.account_name,Number(l.debit),Number(l.credit)]),[['Travel',0,41.51],['Vähennettävä arvonlisävero',0,10.59],['Owner drawings',52.1,0]]);
 assert.equal((await tx('personal')).category,'Owner drawings');
 assert.equal((await tx('personal')).payload.coding_auto_post.owner_notified,false);
 assert.equal((await tx('personal')).payload.coding_auto_post.flag_key,'CODING_OWNER_TRANSFER_POST');
 assert.deepEqual((await tx('personal')).payload.coding_auto_post.correction_journal_ids,privateReq.correction_journal_ids);
 assert.equal((await pool.query("select parse_summary->'source_business_use'->>'source_quote' quote from documents where id='private-doc'")).rows[0].quote,'YKSITYISAJO 14.2. / M.L.');
 const final=await tick();assert.deepEqual(final.posted_correction_recovery,[],'all four workflows remain terminal on the next clock');
 // Heal the observed older false completion: expense was moved to equity,
 // while its input VAT survived. No new upload or manual receipt reset is needed.
 const residualJournal=await seed('residual-tax',{amount:52.1,incoming:false,document:false,privateUse:'equity'});
 await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status)
 values('residual-match','f','c','residual-tax','receipt','private-doc',52.1,1,'auto_matched')`);
 const residualCase=await readJevCase({client:pool,...scope,transactionId:'residual-tax',evidenceOnly:true});
 const {codingEvidenceDigest}=await import('./db/codingEvidence.js');
 const residualDigest=codingEvidenceDigest(residualCase.matchedDocument);
 await pool.query("update transactions set payload=payload || $1::jsonb where id='residual-tax'",[{
  ai_suggestion:{...(await tx('residual-tax')).payload.ai_suggestion,proposed_account:'Owner drawings',tax_treatment:tax,evidence_digest:residualDigest},
  coding_correction_required:{status:'corrected',original_journal_id:residualJournal,current_evidence_digest:residualDigest,source_business_use_digest:hash([]),correction_journal_ids:[]}
 }]);
 const residualOriginal=(await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[residualJournal])).rows;
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('residual-tax')).payload.coding_correction_required.status,'pending');
 assert.equal((await tx('residual-tax')).payload.coding_correction_required.reason,'posted_source_business_use_conflict');
 phase='personal';clockResult=await tick();
 assert.equal(clockResult.posted_correction_recovery[0].state,'completed',JSON.stringify(clockResult));
 const residualReq=(await tx('residual-tax')).payload.coding_correction_required;
 const residualDelta=(await pool.query('select account_name,debit,credit from ledger_lines where journal_id=any($1::text[])',[residualReq.correction_journal_ids])).rows;
 assert.deepEqual(residualDelta.map(l=>[l.account_name,Number(l.debit),Number(l.credit)]),[['Owner drawings',0,41.51],['Vähennettävä arvonlisävero',0,10.59],['Owner drawings',52.1,0]]);
 const net=account=>Math.round([...residualOriginal,...residualDelta].filter(l=>l.account_name===account).reduce((sum,l)=>sum+Number(l.debit)-Number(l.credit),0)*100)/100;
 assert.equal(net('Owner drawings'),52.1);assert.equal(net('Vähennettävä arvonlisävero'),0);assert.equal(net('Bank'),-52.1);
 assert.deepEqual((await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[residualJournal])).rows,residualOriginal);
 assert.deepEqual((await tick()).posted_correction_recovery,[]);


 // Two deliveries share the durable claim. Only one reasons and writes.
 await seed('concurrent');await recoverChangedCodingEvidenceInDb({firmId:'f'});phase='allocation';
 let nested;
 race=async()=>{nested=await recoverPostedCodingCorrectionsInDb({firmId:'f'});};
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});
 assert.equal(result[0].state,'completed',JSON.stringify(result));assert.equal(nested[0].state,'busy');
 // Revoke after the saved decision commits but before the adjustment obtains
 // its checkout. The actual adjustment writer must refuse; no owner ask.
 await seed('revoked');await recoverChangedCodingEvidenceInDb({firmId:'f'});
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f',runWorkerAdmissionFn:async({work})=>{
  const staged=await work();
  await withClient(client=>setClientFlagStage(client,{...scope,flagKey:CODING_CORRECTION_FLAG,stage:'off',actorId:'member',actorType:'firm_member',reason:'Synthetic revocation race'}));
  return staged;
 }});
 assert.equal(result[0].code,'CODING_CORRECTION_AUTHORITY_REQUIRED',JSON.stringify(result));
 const revoked=(await tx('revoked')).payload.coding_correction_required;
 assert.equal(revoked.status,'pending');assert.equal(revoked.recovery.state,'blocked');
 assert.equal((await pool.query('select count(*)::int n from ledger_journals where correction_of_journal_id=$1',[revoked.original_journal_id])).rows[0].n,0);
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='revoked'")).rows[0].n,0);
 await withClient(client=>setClientFlagStage(client,{...scope,flagKey:CODING_CORRECTION_FLAG,stage:'canary',actorId:'member',actorType:'firm_member',reason:'Fresh synthetic correction authority'}));
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f'});assert.equal(result[0].state,'completed',JSON.stringify(result));

 // A waiting owner case cannot consume the bounded clock's only slot forever.
 await seed('a-waiting',{amount:1245,incoming:false,document:false});
 await recoverChangedCodingEvidenceInDb({firmId:'f'});phase='ask';
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});assert.equal(result[0].state,'owner_question');
 await seed('z-later');await recoverChangedCodingEvidenceInDb({firmId:'f'});phase='allocation';
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
 assert.equal(result[0].transactionId,'z-later');assert.equal(result[0].state,'completed',JSON.stringify(result));

 // Bank roster context is loaded from statement payload, outside the display
 // packet. Bind it too, so an unchanged parse summary cannot hide a new input.
 await seed('roster');await recoverChangedCodingEvidenceInDb({firmId:'f'});
 await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,payload)
  values('roster-statement','f','c','statement.pdf','bank_statement','completed','2025-02-24','EUR',
  '{"statement_summary":{"bank_name":"Fixture bank","account_number":"1111"}}')`);
 phase='allocation';race=()=>pool.query(`update documents set payload=jsonb_set(payload,
  '{statement_summary,account_number}','"2222"'::jsonb) where id='roster-statement'`);
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
 assert.equal(result[0].transactionId,'roster');assert.equal(result[0].code,'CODING_CORRECTION_STALE',JSON.stringify(result));

 // Other coder-only source fields (not in the display projection) receive
 // the same protection. Preserve the actual error and do not mint a question.
 await seed('parser-context');await recoverChangedCodingEvidenceInDb({firmId:'f'});
 race=()=>pool.query(`update transactions set payload=payload ||
  '{"parser_flags":["source_direction_requires_review"]}'::jsonb where id='parser-context'`);
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
 assert.equal(result[0].transactionId,'parser-context');assert.equal(result[0].code,'CODING_CORRECTION_STALE',JSON.stringify(result));
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='parser-context'")).rows[0].n,0);

 // A reply can predate this consumer. Close the exact answered request whose
 // reply the fresh correction consumed, without closing unrelated live asks.
 await seed('legacy-reply',{amount:455,document:false});
 const legacyAsk=await withClient(async client=>{
  await client.query('begin');
  const ask=await __createClientEvidenceRequestWithClient({client,...scope,transactionId:'legacy-reply',
   question:'Were the deposited sales already recorded?',evidenceType:'business_purpose',
   actorId:'coding_auto_post',markTransactionNeedsClient:false});
  await client.query('commit');return ask;
 });
 await resolveClientEvidenceRequestInDb({firmId:'f',evidenceRequestId:legacyAsk.id,
  reply:'This cash was already recorded in the cashbook and is being moved to the bank.',
  actorId:'member',actorType:'firm_member',answerSource:'in_person'});
 await recoverChangedCodingEvidenceInDb({firmId:'f'});phase='cash';
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
 assert.equal(result[0].transactionId,'legacy-reply');assert.equal(result[0].state,'completed',JSON.stringify(result));
 assert.equal((await pool.query('select status from client_evidence_requests where id=$1',[legacyAsk.id])).rows[0].status,'resolved');

 // Early refusals must rotate too: readiness fails before the scan timestamp,
 // while missing correction authority rolls that timestamp back with its read.
 // Drive both real gates, then restore synthetic authority and prove later work
 // reaches the actual journal writer without retrying the denied head first.
 for(const [label,flagKey,blockedStage,allowedStage,code] of [
  ['authority',CODING_CORRECTION_FLAG,'off','canary','CODING_CORRECTION_AUTHORITY_REQUIRED'],
  ['readiness','ENTITY_READINESS_ADMISSION','canary','off','ENTITY_READINESS_ADMISSION_BLOCKED']
 ]) {
  const denied=`a-${label}-refused`,later=`z-${label}-later`;
  await seed(denied);await seed(later);
  await recoverChangedCodingEvidenceInDb({firmId:'f'});phase='allocation';
  await withClient(client=>setClientFlagStage(client,{...scope,flagKey,stage:blockedStage,
   actorId:'member',actorType:'firm_member',reason:'Synthetic early-refusal rotation proof'}));
  const callsBefore=calls;
  const journalsBefore=(await pool.query('select * from ledger_journals order by id')).rows;
  const linesBefore=(await pool.query('select * from ledger_lines order by id')).rows;
  result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
  assert.equal(result[0].transactionId,denied);assert.equal(result[0].code,code);
  assert.equal(calls,callsBefore);
  const refusal=(await tx(denied)).payload.coding_correction_required;
  assert.equal(refusal.status,'pending');assert.equal(refusal.recovery.state,'blocked');
  assert.equal(refusal.recovery.code,code);assert.ok(refusal.last_checked_at);
  assert.equal(convergenceForTransaction(await tx(denied)).reason,`posted_evidence_correction_blocked:${code}`);
  if(label==='readiness')assert.ok(refusal.recovery.details.reason_code);
  if(label==='readiness'){
   const countBefore=await failureCount(denied);
   await pool.query(`update transactions set payload=jsonb_set(jsonb_set(payload,
     '{coding_correction_required,recovery,details,host_receipt_ref}',
     '{"store":"runtime_host_readiness_attempts","id":999}'::jsonb,true),
     '{coding_correction_required,last_checked_at}','"2000-01-01T00:00:00Z"'::jsonb)
     where id=$1`,[denied]);
   await pool.query(`update transactions set payload=jsonb_set(payload,
     '{coding_correction_required,last_checked_at}','"2100-01-01T00:00:00Z"'::jsonb)
     where id=$1`,[later]);
   result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
   assert.equal(result[0].transactionId,denied);
   assert.equal(result[0].state,'blocked');
   assert.equal(await failureCount(denied),countBefore,'a newer host receipt with the same cause is one blocker, not another failure');
   await pool.query("update transactions set payload=payload #- '{coding_correction_required,last_checked_at}' where id=$1",[later]);
  }
  assert.deepEqual((await pool.query('select * from ledger_journals order by id')).rows,journalsBefore);
  assert.deepEqual((await pool.query('select * from ledger_lines order by id')).rows,linesBefore);
  assert.equal((await pool.query('select count(*)::int n from client_evidence_requests where transaction_id=$1',[denied])).rows[0].n,0);
  await withClient(client=>setClientFlagStage(client,{...scope,flagKey,stage:allowedStage,
   actorId:'member',actorType:'firm_member',reason:'Restore synthetic fixture after refusal proof'}));
  result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
  assert.equal(result[0].transactionId,later);assert.equal(result[0].state,'completed',JSON.stringify(result));
  assert.equal((await tx(later)).payload.coding_correction_required.status,'corrected');
 }

 // Reuse the live source-identity conflict in admission and retry context.
 // A held foreign source must not degrade to a generic materiality refusal.
 await seed('identity-refusal',{amount:52.1,incoming:false,document:false,privateUse:'equity'});
 await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary)
 values('identity-doc','f','c','identity.pdf','receipt','completed','2025-02-24','EUR',52.1,0,'{}');
 insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,payload)
 values('identity-match','f','c','identity-refusal','receipt','identity-doc',52.1,1,'suggested','{"cross_entity":{"detected":true,"own_side":"Another synthetic company"}}')`);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});phase='identity_initial';
 const identityPass=()=>recoverPostedCodingCorrectionsInDb({firmId:'f',limit:100,
  runWorkerAdmissionFn:({transactionId,work})=>transactionId==='identity-refusal'?work():{state:'busy'}});
 result=await identityPass();
 assert.equal(result.find(r=>r.transactionId==='identity-refusal').code,'CODING_CORRECTION_EXECUTION_REFUSED');
 assert.equal((await tx('identity-refusal')).payload.coding_correction_required.recovery.details.reason,'cross_entity_relation');
 phase='identity_ask';result=await identityPass();
 assert.equal(result.find(r=>r.transactionId==='identity-refusal').state,'owner_question',JSON.stringify(result));
 assert.equal(lastRequest.state.transaction.correction_context.previous_refusal.details.reason,'cross_entity_relation');
 assert.match(JSON.stringify(lastRequest.state.transaction.correction_context.unresolved_source_relationships),/Another synthetic company/);
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='identity-refusal' and status='draft'")).rows[0].n,1);
 const identityAsk=(await pool.query("select * from client_evidence_requests where transaction_id='identity-refusal' and status='draft'")).rows[0];
 assert.match(identityAsk.question,/Another synthetic company/);assert.match(identityAsk.question,/whose purchase or obligation/);
 assert.doesNotMatch(identityAsk.question,/provide.*receipt|upload.*receipt/i);
 assert.equal(lastRequest.questions.decision.criteria.resolved,undefined);
 assert.equal(lastRequest.questions.decision.criteria.document_allocation,undefined);
 const identitySource=(await pool.query("select * from reconciliation_matches where bank_transaction_id='identity-refusal'")).rows;
 const identityProfile=(await pool.query("select profile from clients where id='c'")).rows;
 await resolveClientEvidenceRequestInDb({firmId:'f',evidenceRequestId:identityAsk.id,reply:'Another synthetic company bought these supplies on our behalf and billed this purchase to us. These supplies belong to our business.',actorId:'member',actorType:'firm_member',answerSource:'in_person'});
 phase='identity_reply';result=await identityPass();
 assert.equal(result.find(r=>r.transactionId==='identity-refusal').state,'completed',JSON.stringify({result,receipt:(await tx('identity-refusal')).payload.coding_correction_required}));
 assert.equal((await pool.query('select status from client_evidence_requests where id=$1',[identityAsk.id])).rows[0].status,'resolved');
 assert.equal((await tx('identity-refusal')).payload.ai_suggestion.source_identity_reply.actor_id,'member');
 assert.deepEqual((await pool.query("select * from reconciliation_matches where bank_transaction_id='identity-refusal'")).rows,identitySource);
 assert.deepEqual((await pool.query("select profile from clients where id='c'")).rows,identityProfile,'a scoped answer cannot teach a client alias');
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('identity-refusal')).payload.coding_correction_required.status,'corrected');
 // The same receipt cannot authorize a different source or a replaced answer.
 await pool.query("update client_evidence_requests set response_payload=jsonb_set(response_payload,'{reply}','\"The earlier explanation was wrong.\"') where id=$1",[identityAsk.id]);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('identity-refusal')).payload.coding_correction_required.status,'pending');
 phase='identity_ask';await identityPass();


 // PostgreSQL's offset timestamp and the JS failure receipt's UTC timestamp
 // must sort by instant. Lexical order starved earlier successful scans.
 await seed('offset-earlier');await seed('utc-later');
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 for(const [id,at] of [['offset-earlier','2000-01-01T12:00:00+02:00'],['utc-later','2000-01-01T10:01:00Z']])
  await pool.query("update transactions set payload=jsonb_set(payload,'{coding_correction_required,last_checked_at}',to_jsonb($2::text)) where id=$1",[id,at]);
 await withClient(client=>setClientFlagStage(client,{...scope,flagKey:CODING_CORRECTION_FLAG,stage:'off',
  actorId:'member',actorType:'firm_member',reason:'Synthetic timestamp-order refusal proof'}));
 const beforeOffset=calls;
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
 assert.equal(result[0].transactionId,'offset-earlier');assert.equal(result[0].code,'CODING_CORRECTION_AUTHORITY_REQUIRED');
 result=await recoverPostedCodingCorrectionsInDb({firmId:'f',limit:1});
 assert.equal(result[0].transactionId,'utc-later');assert.equal(calls,beforeOffset);

 // A generated output-VAT leg on a misclassified purchase is not a tax filing payment.
 const purchaseJournal=await seed('receipt-sales',{incoming:false});
 await pool.query("update documents set document_type='receipt' where id='receipt-sales-doc'");
 await withClient(async client=>{
  await client.query('begin');
  try {
   const lines=[
    {account:{name:'Sales',type:'revenue',role:'counterparty'},debit:740,credit:0,amount:740,direction:'debit',currency:'EUR'},
    {account:{name:'Suoritettava arvonlisävero',code:'2939',type:'liability',role:'alv_output'},debit:183.6,credit:0,amount:183.6,direction:'debit',currency:'EUR'},
    {account:{name:'Bank',type:'bank',role:'bank'},debit:0,credit:923.6,amount:923.6,direction:'credit',currency:'EUR'}
   ];
   await __writeLedgerJournalRows({client,...scope,actorId:'fixture',existingJournalId:purchaseJournal,
    journal:{source_type:'transaction',source_id:'receipt-sales',journal_date:'2025-02-24',currency:'EUR',memo:'Historical wrong receipt classification',lines,accounts:lines.map(line=>line.account),amount:923.6}});
   await client.query('commit');
  } catch(error) {await client.query('rollback');throw error;}
 });
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('receipt-sales')).payload.coding_correction_required.reason,'posted_allocation_account_conflict');
 assert.equal((await tx('receipt-sales')).payload.coding_correction_required.statutory_source_required,false);

});
