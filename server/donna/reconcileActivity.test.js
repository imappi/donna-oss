import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReconcileActivity } from './db/reconcileActivity.js';
import { expireProcessingActivity, streamEntryState, streamEntryPhase, buildPeriodOverview, activityBatchSummaries, activityBatchSummaryLabel } from '../../src/lib/periodOverview.js';

const now = '2026-09-21T12:03:00Z';
const tx = { id:'line', firm_id:'firm', client_id:'fi', document_id:'statement', status:'needs_review', created_at:'2026-09-21T12:01:00Z',
  convergence_state:'hanging', convergence_reason:'coding_state:proposed', coding_state:'proposed', payload:{} };
const statement = { id:'statement', firm_id:'firm', client_id:'fi', batch_id:'upload', created_at:'2026-09-21T12:00:00Z' };
const doc = { id:'source', firm_id:'firm', client_id:'fi', batch_id:'upload', parse_run_id:'run', created_at:'2026-09-21T12:00:10Z' };
const job = { id:7, function_id:'parse-document', status:'running', attempt_count:1, max_attempts:4,
  created_at:'2026-09-21T12:00:00Z', run_at:'2026-09-21T12:00:00Z', locked_at:'2026-09-21T12:01:00Z',
  lease_expires_at:'2026-09-21T12:11:00Z', payload:{firm_id:'firm',client_id:'fi',document_id:'source',parse_run_id:'run'} };
const clock = { last_enqueued_tick:'2026-09-21T12:00:00Z' };
const project = (overrides={}) => projectReconcileActivity({transactions:[tx],documents:[statement,doc],jobs:[job],observedAt:now,
  codingIds:overrides.clock ? new Set((overrides.transactions || [tx]).filter(row=>row.convergence_state==='hanging' && !row.payload?.ai_suggestion).map(row=>row.id)) : new Set(),...overrides});
const state = (options={}, row=tx, lane='open') => streamEntryState(lane,{...row,processing_activity:project({...options,transactions:[row]}).get(row.id)});

// 2026-09-23 reversal: a persisted terminal no longer waits for its batch.
test('FI: inside the upload cycle only owed work is Processing; persisted terminals render at once',()=>{
  for(const [convergence_state,lane,expected] of [['hanging','open','processing'],['on_owner','owner','needs_input'],['auto_reconciled','reconciled','reconciled']]) {
    assert.equal(state({}, {...tx,convergence_state},lane),expected,convergence_state);
  }
  const activity=project();
  assert.equal(activity.get('document:source').state,'running');
  assert.equal(streamEntryState('document',{matchStatus:'awaiting_owner',document:{processing_activity:activity.get('document:source')}}),'processing');
});

test('FI: completed parse hands unfinished work to the registered coding clock without a pill change',()=>{
  assert.equal(state({jobs:[{...job,status:'succeeded'}],clock}),'processing');
  assert.equal(state({jobs:[],clock}),'processing');
  assert.equal(state({jobs:[{...job,function_id:'parse-cron:coding_convergence',status:'succeeded'}],clock}),'processing');
  assert.equal(state({jobs:[],clock:null}),'stalled');
  assert.equal(state({jobs:[{...job,function_id:'parse-cron:coding_convergence',status:'dead'}],clock}),'processing','a global job failure is not a per-client refusal');
  assert.equal(state({jobs:[],clock:{last_enqueued_tick:'2026-09-21T12:30:00Z'},observedAt:'2026-09-21T12:32:00Z'}),'stalled','later ticks never extend the original cycle deadline');
});

test('FI: no unrelated upload, duplicate, foreign firm, replaced run reopens a settled case',()=>{
  const settled={...tx,convergence_state:'auto_reconciled'};
  for(const options of [
    {documents:[statement,{...doc,batch_id:'unrelated'}]},
    {documents:[statement,{...doc,duplicate_of:'original'}]},
    {documents:[statement,{...doc,parse_run_id:'replacement'}]},
    {jobs:[{...job,payload:{...job.payload,firm_id:'other'}}]},
    {jobs:[{...job,status:'succeeded'}]}
  ]) assert.equal(state(options,settled,'reconciled'),'reconciled');
});

test('FI: late related evidence on a settled line keeps its verdict; the recovery owner changes it or nothing does',()=>{
  const settled={...tx,convergence_state:'auto_reconciled'};
  const options={jobs:[],clock,recoveryIds:new Set([tx.id])};
  assert.equal(state(options,settled,'reconciled'),'reconciled');
  assert.equal(state({...options,recoveryIds:new Set()},settled,'reconciled'),'reconciled');
  const expired={...options,observedAt:'2026-09-21T12:32:00Z',clock:{last_enqueued_tick:'2026-09-21T12:30:00Z'}};
  assert.equal(state(expired,settled,'reconciled'),'reconciled','a settled line never expires into Stalled');
  assert.equal(state(expired,{...tx,convergence_state:'hanging'}),'stalled','an owed line in the same recovery still expires honestly');
});

test('FI: the upload quiet window holds owed rows only; a persisted terminal publishes at once',()=>{
  const owner={...tx,convergence_state:'on_owner'};
  assert.equal(state({jobs:[],clock,observedAt:'2026-09-21T12:00:30Z'},owner,'owner'),'needs_input');
  assert.equal(state({jobs:[],clock,observedAt:'2026-09-21T12:00:30Z'}),'processing','a hanging line in the quiet window never flashes Stalled');
  assert.equal(state({jobs:[],clock},owner,'owner'),'needs_input');
  const posted={...tx,convergence_state:'auto_reconciled'};
  assert.equal(state({jobs:[],clock},posted,'reconciled'),'reconciled');
});

test('FI: draft work is Processing and both counts and pill expire together',()=>{
  const row={...tx,date:'2025-02-26',payload:{ai_suggestion:{evidence_required:true}}};
  const options={jobs:[],asks:[{id:'draft-work',client_id:'fi',status:'pending',created_at:now}]};
  row.processing_activity=project({...options,transactions:[row]}).get(tx.id);
  assert.equal(streamEntryState('open',row),'processing');
  assert.equal(buildPeriodOverview({transactions:[row],openRows:[row]})[0].counts.processing,1);
  const expired=expireProcessingActivity([row],Date.parse('2026-09-21T12:31:00Z'))[0];
  assert.equal(streamEntryState('open',expired),'stalled');
  assert.equal(buildPeriodOverview({transactions:[expired],openRows:[expired]})[0].counts.stalled,1);
});


test('FI: two capped ticks and expired inner leases never flash Stalled for queued work',()=>{
  for(const at of ['2026-09-21T12:12:00Z','2026-09-21T12:17:00Z']) {
    assert.equal(state({clock,observedAt:at,jobs:[{...job,function_id:'parse-cron:coding_convergence',status:'succeeded',result:{coding_convergence:{coder:[{client_id:'another-fi-company',scanned:25,suggested:25}]}}}]}),'processing');
    assert.equal(state({clock,observedAt:at}),'processing','a parse lease may expire while its durable retry remains owned');
  }
  assert.equal(state({clock,blockedClients:new Map([['fi',{code:'entity_not_ready',receipt_id:'readiness'}]])}),'stalled');
  assert.equal(state({clock,failureIds:new Map([['line',{code:'coding_policy_failed',receipt_id:'failure'}]])}),'stalled');
  const ownFailure={...job,function_id:'parse-cron:coding_convergence',status:'succeeded',completed_at:now,result:{coding_convergence:{coder:[{client_id:'fi',code:'ENTITY_READINESS_ADMISSION_BLOCKED',error:'not admitted'}]}}};
  assert.equal(state({clock,jobs:[ownFailure]}),'stalled');
});

test('FI: one batch publishes each case as itself; only owed work is Processing, and it expires alone',()=>{
  const owner={...tx,id:'owner',date:'2025-02-26',convergence_state:'on_owner'}, unfinished={...tx,date:'2025-02-26'};
  const activity=project({transactions:[owner,unfinished],jobs:[],clock});
  const rows=[owner,unfinished].map(row=>({...row,processing_activity:activity.get(row.id)}));
  const overview=buildPeriodOverview({transactions:rows,ownerRows:[rows[0]],openRows:[rows[1]]})[0];
  assert.equal(overview.counts.processing,1);assert.equal(overview.counts.needsInput,1);assert.equal(overview.counts.stalled,0);
  assert.equal(activity.has(owner.id),false,'the owner question carries no batch receipt to expire');
  assert.equal(streamEntryState('owner',expireProcessingActivity([rows[0]],Date.parse('2026-09-21T12:31:00Z'))[0]),'needs_input');
  assert.equal(streamEntryState('open',expireProcessingActivity([rows[1]],Date.parse('2026-09-21T12:31:00Z'))[0]),'stalled');
  const complete={...unfinished,convergence_state:'auto_reconciled'};
  const closed=project({transactions:[owner,complete],jobs:[],clock});
  assert.equal(closed.has(owner.id),false);assert.equal(closed.has(complete.id),false);
  assert.equal(streamEntryState('owner',{...owner,processing_activity:null}),'needs_input');
});

test('FI: amount resemblance cannot reopen a settled row; an exact new match reads the new source beside it',()=>{
  const old={...tx,created_at:'2026-09-20T10:00:00Z',money_out:22,currency:'EUR',transaction_date:'2025-02-26',convergence_state:'auto_reconciled'};
  const oldStatement={...statement,created_at:'2026-09-20T10:00:00Z'};
  const fresh={...doc,batch_id:'new-upload',document_type:'receipt',document_date:'2025-02-26',currency:'EUR',total_amount:22,parse_status:'processing'};
  const options={documents:[oldStatement,fresh],jobs:[job],clock};
  assert.equal(state(options,old,'reconciled'),'reconciled');
  const matched={...options,matches:[{bank_transaction_id:old.id,matched_object_id:fresh.id,status:'auto_matched'}]};
  assert.equal(state(matched,old,'reconciled'),'reconciled','the posted line keeps its verdict while the new source is read');
  assert.equal(project({...matched,transactions:[old]}).get(`document:${fresh.id}`).phase,'reading','the new source carries its own work');
});

test('FI: an owner reply opens its own bounded cycle on an older bank line',()=>{
  const old={...tx,created_at:'2026-09-20T10:00:00Z',convergence_reason:'owner_answered_processing'};
  const reply={id:'answer',transaction_id:old.id,status:'replied',responded_at:'2026-09-21T12:01:00Z'};
  const options={jobs:[],documents:[{...statement,created_at:old.created_at}],ownerQuestions:[reply],replyIds:new Set(['answer'])};
  assert.equal(state(options,old),'processing');
  assert.equal(state({...options,observedAt:'2026-09-21T12:32:00Z'},old),'stalled');
  assert.equal(state({...options,replyIds:new Set()},old),'stalled','an exhausted reply does not borrow the old source clock');
});

test('FI: host boot wait and the proposed-to-post sweep are actual owners',()=>{
  assert.equal(state({jobs:[],hostWaitClients:new Set(['fi'])}),'processing');
  assert.equal(state({jobs:[],hostWaitClients:new Set(['fi']),observedAt:'2026-09-21T12:32:00Z'}),'stalled');
  const proposed={...tx,payload:{ai_suggestion:{evidence_required:false}}};
  assert.equal(state({jobs:[],postingIds:new Set([tx.id])},proposed),'processing');
  assert.equal(streamEntryState('document',{document:{convergence_state:'hanging',convergence_reason:'settlement_entry_missing',payload:{no_line_disposition:{disposition:'auto_explain'}}}}),'stalled');
  const working={...proposed,processing_activity:project({jobs:[],postingIds:new Set([tx.id])}).get(tx.id)};
  assert.equal(streamEntryState('open',expireProcessingActivity([working],Date.parse('2026-09-21T12:32:00Z'),{awaitingRefresh:true})[0]),'processing','wake from sleep requests current truth before announcing a failure');
});

test('FI: a later source retains its own arrival allowance inside the shared batch',()=>{
  const later={...doc,created_at:'2026-09-21T12:20:00Z',parse_status:'pending'};
  assert.equal(state({documents:[statement,later],jobs:[],observedAt:'2026-09-21T12:35:00Z'}),'processing');
  assert.equal(state({documents:[statement,later],jobs:[],observedAt:'2026-09-21T12:51:00Z'}),'stalled');
});

// 2026-09-21 (hosted Kampaamo): one shared host refusal used to stamp every
// row of a batch Stalled — 36 rows, 26 of them auto-reconciled or on the
// owner. A refusal is the receipt of the work it stops; settled outcomes and
// open owner questions keep their persisted terminal, and a host outage is a
// bounded shared wait, not a per-line failure.
test('FI: a shared refusal never stamps settled rows or open owner questions; unfinished work carries it',()=>{
  const settled={...tx,id:'settled',convergence_state:'auto_reconciled',convergence_reason:'coding_state:posted',coding_state:'posted',payload:{ledger_journal_id:'j1'}};
  const asked={...tx,id:'asked',convergence_state:'on_owner',convergence_reason:'client_evidence_request:open',coding_state:'asked'};
  const pendingDoc={...doc,id:'unread',parse_status:'pending'};
  const refusal=new Map([['fi',{code:'entity_not_ready',receipt_id:'readiness'}]]);
  const projectAll=(observedAt)=>projectReconcileActivity({transactions:[tx,settled,asked],documents:[statement,doc,pendingDoc],jobs:[],observedAt,
    codingIds:new Set([tx.id]),blockedClients:refusal});
  for (const at of [now,'2026-09-21T12:32:00Z']) {
    const activity=projectAll(at);
    assert.equal(activity.get('document:unread').state,'failed',at); assert.equal(activity.get('document:unread').reason_code,'entity_not_ready');
    assert.equal(activity.get(tx.id).state,'failed'); assert.equal(activity.get(tx.id).reason_code,'entity_not_ready');
    assert.equal(streamEntryState('open',{...tx,processing_activity:activity.get(tx.id)}),'stalled');
    assert.notEqual(activity.get('settled')?.state,'failed','a settled line never inherits a client refusal');
    assert.notEqual(activity.get('asked')?.state,'failed','an open owner question never inherits a client refusal');
    assert.notEqual(activity.get('document:source')?.state,'failed','a completed source never inherits a client refusal');
  }
  const published=projectAll('2026-09-21T12:32:00Z');
  assert.equal(streamEntryState('reconciled',{...settled,processing_activity:published.get('settled')}),'reconciled');
  assert.equal(streamEntryState('owner',{...asked,processing_activity:published.get('asked')}),'needs_input');
  const counts=buildPeriodOverview({openRows:[{...tx,transaction_date:'2026-09-21'}],ownerRows:[{...asked,transaction_date:'2026-09-21'}],reconciledRows:[{...settled,transaction_date:'2026-09-21'}],
    transactions:[tx,settled,asked].map(row=>({...row,processing_activity:published.get(row.id)}))})[0].counts;
  assert.deepEqual(counts,{needsInput:1,processing:0,stalled:1,reconciled:1,remaining:2});
  // The coder's own admission refusal is the same shape: a receipt on owed work only.
  const refusedTick={...job,function_id:'parse-cron:coding_convergence',status:'succeeded',completed_at:now,result:{coding_convergence:{coder:[{client_id:'fi',code:'ENTITY_READINESS_ADMISSION_BLOCKED',error:'not admitted'}]}}};
  const ticked=projectReconcileActivity({transactions:[tx,settled,asked],documents:[statement,doc],jobs:[refusedTick],observedAt:now,codingIds:new Set([tx.id])});
  assert.equal(ticked.get(tx.id).reason_code,'ENTITY_READINESS_ADMISSION_BLOCKED');
  assert.notEqual(ticked.get('settled')?.state,'failed'); assert.notEqual(ticked.get('asked')?.state,'failed');
});

test('FI: a host outage on a ready entity is a bounded shared wait, then an honest expiry — never mass Stalled',()=>{
  const settled={...tx,id:'settled',convergence_state:'auto_reconciled',convergence_reason:'coding_state:posted',coding_state:'posted',payload:{ledger_journal_id:'j1'}};
  const rows=[tx,settled];
  const during=projectReconcileActivity({transactions:rows,documents:[statement,doc],jobs:[],observedAt:now,codingIds:new Set([tx.id]),hostWaitClients:new Set(['fi'])});
  assert.equal(streamEntryState('open',{...tx,processing_activity:during.get(tx.id)}),'processing');
  assert.equal(streamEntryState('reconciled',{...settled,processing_activity:during.get('settled')}),'reconciled','a settled row never waits for its batch');
  assert.equal(during.get(tx.id).phase,'waiting_for_host','the coder cannot run while the host is out, so the line says so');
  const after=projectReconcileActivity({transactions:rows,documents:[statement,doc],jobs:[],observedAt:'2026-09-21T12:32:00Z',codingIds:new Set([tx.id]),hostWaitClients:new Set(['fi'])});
  assert.equal(after.get(tx.id).reason_code,'processing_cycle_expired');
  assert.equal(streamEntryState('open',{...tx,processing_activity:after.get(tx.id)}),'stalled');
  assert.equal(streamEntryState('reconciled',{...settled,processing_activity:after.get('settled')}),'reconciled');
});

// 2026-09-23 (hosted Kampaamo, re-created): "all these items are processing
// pills … never ending". The batch stamped EVERY row Processing while any work
// was owed — 7 posted lines and 17 open owner questions included — and each new
// owner receipt pushed the deadline out. A persisted terminal now renders its
// verdict at once; only rows that still owe work carry activity, each with its
// own working phase, and one batch summary rides those rows.
test('FI: a mixed batch renders posted, on-owner, evidence-pending and coding rows as themselves plus one summary',()=>{
  const posted={...tx,id:'posted',convergence_state:'auto_reconciled',convergence_reason:'coding_state:posted',coding_state:'posted',payload:{ledger_journal_id:'j1'}};
  const owner={...tx,id:'owner',convergence_state:'on_owner',convergence_reason:'client_evidence_request:open',coding_state:'asked'};
  const evidence={...tx,id:'evidence',convergence_reason:'coding_state:applied',coding_state:'applied',
    payload:{ai_suggestion:{proposed_account:'6800'},ledger_post_refusal:{code:'TRANSACTION_CODING_EVIDENCE_PENDING'}}};
  const coding={...tx,id:'coding'};
  const reading={...doc,id:'reading',filename:'01 OP Tiliote.pdf',parse_status:'processing'};
  const rows=[posted,owner,evidence,coding];
  const projectAt=observedAt=>projectReconcileActivity({transactions:rows,documents:[statement,reading],jobs:[],observedAt,
    codingIds:new Set(['coding'])});
  const render=activity=>{
    const lane={auto_reconciled:'reconciled',on_owner:'owner',hanging:'open'};
    return Object.fromEntries(rows.map(row=>{
      const entry={...row,processing_activity:activity.get(row.id) || null};
      return [row.id,[streamEntryState(lane[row.convergence_state],entry),streamEntryPhase(lane[row.convergence_state],entry)]];
    }));
  };
  const during=projectAt(now);
  assert.deepEqual(render(during),{posted:['reconciled',null],owner:['needs_input',null],evidence:['processing','awaiting_evidence'],coding:['processing','coding']});
  assert.equal(during.has('posted'),false,'a settled row carries no activity whatever its batch is doing');
  assert.equal(during.has('owner'),false,'an open owner question carries no activity whatever its batch is doing');
  assert.equal(during.get('document:reading').phase,'reading');
  const summaries=activityBatchSummaries([...rows.map(row=>({...row,processing_activity:during.get(row.id) || null})),
    {...reading,processing_activity:during.get('document:reading')}]);
  assert.equal(summaries.length,1,'one summary per batch, never one per row');
  assert.deepEqual({...summaries[0],batch_id:undefined,valid_until:undefined},
    {batch_id:undefined,valid_until:undefined,reading:['01 OP Tiliote.pdf'],done:1,on_owner:1,in_progress:2});
  assert.equal(activityBatchSummaryLabel(summaries[0]),'Reading 01 OP Tiliote.pdf · 1 done · 1 waiting on you · 2 in progress');
  const period=buildPeriodOverview({openRows:[evidence,coding].map(r=>({...r,transaction_date:'2025-02-26',processing_activity:during.get(r.id)})),
    ownerRows:[{...owner,transaction_date:'2025-02-26'}],reconciledRows:[{...posted,transaction_date:'2025-02-26'}],
    transactions:rows.map(row=>({...row,transaction_date:'2025-02-26',processing_activity:during.get(row.id) || null}))})[0];
  assert.deepEqual(period.counts,{needsInput:1,processing:2,stalled:0,reconciled:1,remaining:3});
  // After the window only the unexplained owed rows expire; settled rows and
  // the owner question never turn Processing or Stalled.
  const after=projectAt('2026-09-21T12:31:00Z');
  assert.deepEqual(render(after),{posted:['reconciled',null],owner:['needs_input',null],evidence:['stalled',null],coding:['stalled',null]});
  assert.equal(after.get('evidence').reason_code,'processing_cycle_expired');
  assert.equal(after.get('coding').reason_code,'processing_cycle_expired');
  assert.equal(after.get('document:reading').reason_code,'processing_cycle_expired');
  assert.deepEqual(activityBatchSummaries(rows.map(row=>({...row,processing_activity:after.get(row.id) || null}))),[]);
});

test('FI: a later owner receipt never re-stamps settled rows, and the renderer reads a terminal verdict over stale activity',()=>{
  const posted={...tx,id:'posted',convergence_state:'auto_reconciled',coding_state:'posted',payload:{ledger_journal_id:'j1'}};
  const answered={id:'answer',transaction_id:'posted',status:'replied',responded_at:'2026-09-21T12:02:00Z'};
  const activity=projectReconcileActivity({transactions:[posted,tx],documents:[statement],jobs:[],observedAt:now,
    codingIds:new Set([tx.id]),ownerQuestions:[answered],replyIds:new Set(['answer'])});
  assert.equal(activity.has('posted'),false);
  assert.equal(activity.get(tx.id).phase,'coding');
  const stale={state:'queued',valid_until:'2026-09-21T12:30:00Z',batch_id:'old'};
  assert.equal(streamEntryState('reconciled',{...posted,processing_activity:stale}),'reconciled');
  assert.equal(streamEntryState('owner',{...tx,convergence_state:'on_owner',processing_activity:stale}),'needs_input');
  assert.equal(streamEntryState('open',{...tx,processing_activity:stale}),'processing');
});

test('FI: each owed line names its own working phase from persisted inputs',()=>{
  const phase=(options,row=tx)=>projectReconcileActivity({transactions:[row],documents:[statement,doc],jobs:[job],observedAt:now,...options}).get(row.id)?.phase;
  assert.equal(phase({codingIds:new Set([tx.id])}),'coding');
  assert.equal(phase({postingIds:new Set([tx.id])}),'posting');
  assert.equal(phase({recoveryIds:new Set([tx.id])}),'rechecking');
  assert.equal(phase({asks:[{id:'draft',client_id:'fi',status:'pending',created_at:now}]}),'drafting_question');
  assert.equal(phase({hostWaitClients:new Set(['fi'])}),'waiting_for_host');
  assert.equal(phase({hostWaitClients:new Set(['fi']),codingIds:new Set([tx.id])}),'waiting_for_host','a host wait outranks the owner it stops');
  assert.equal(phase({},{...tx,payload:{ledger_post_refusal:{code:'TRANSACTION_CODING_EVIDENCE_PENDING'}}}),'awaiting_evidence');
  assert.equal(phase({}),'in_progress');
  const reply={id:'answer',transaction_id:tx.id,status:'replied',responded_at:'2026-09-21T12:02:00Z'};
  assert.equal(phase({jobs:[],documents:[statement],ownerQuestions:[reply],replyIds:new Set(['answer'])}),'applying_reply');
});


test('native current review has no quiet/expiry debt; exact current row identity and real work retain precedence',()=>{
  const reviewed={...tx,coding_state:'applied',convergence_reason:'processing_review_only',
    processing_scope:{enforced:true,review_current:true},projection_freshness:{status:'current'},
    accounting_ready:false,payload:{review_scope:{review_outcome:'saved'}}};
  const base={transactions:[reviewed],documents:[statement],jobs:[],currentNativeReviewRows:new Set([reviewed])};
  const at='2026-09-21T12:00:30Z', later='2026-09-21T12:32:00Z';
  for(const observedAt of [at,now,later]) {
    const activity=projectReconcileActivity({...base,observedAt});
    assert.equal(activity.has(reviewed.id),false);
    assert.equal(streamEntryState('open',{...reviewed,processing_activity:activity.get(reviewed.id)}),'review_only');
    assert.equal(reviewed.convergence_state,'hanging'); assert.equal(reviewed.accounting_ready,false);
  }
  for(const extra of [{currentNativeReviewRows:new Set()}, {transactions:[{...reviewed}]}]) {
    assert.equal(projectReconcileActivity({...base,...extra,observedAt:at}).get(tx.id).state,'queued','payload or same-id clone is no exemption');
    assert.equal(projectReconcileActivity({...base,...extra,observedAt:later,recoveryIds:new Set([tx.id])}).get(tx.id).reason_code,'processing_cycle_expired');
  }
  for(const [phase,extra] of [
    ['coding',{codingIds:new Set([tx.id])}],['posting',{postingIds:new Set([tx.id])}],
    ['rechecking',{recoveryIds:new Set([tx.id])}],['waiting_for_host',{hostWaitClients:new Set([tx.client_id])}],
    ['drafting_question',{asks:[{id:'ask',client_id:tx.client_id,status:'pending',attempts:0,created_at:at}]}],
    ['applying_reply',{replyIds:new Set(['reply']),ownerQuestions:[{id:'reply',transaction_id:tx.id,status:'replied',responded_at:at}]}]
  ]) {
    const activity=projectReconcileActivity({...base,...extra,observedAt:now}).get(tx.id);
    assert.equal(activity.phase,phase); assert.equal(activity.state,'queued');
    assert.equal(streamEntryState('open',{...reviewed,processing_activity:activity}),'processing');
    assert.equal(projectReconcileActivity({...base,...extra,observedAt:later}).get(tx.id).reason_code,'processing_cycle_expired');
  }
  for(const extra of [
    {failureIds:new Map([[tx.id,{code:'named_failure',receipt_id:'r'}]])},
    {blockedClients:new Map([[tx.client_id,{code:'named_failure',receipt_id:'r'}]])}
  ]) for(const observedAt of [at,later]) {
    const activity=projectReconcileActivity({...base,...extra,observedAt}).get(tx.id);
    assert.equal(activity.reason_code,'named_failure');
    assert.equal(streamEntryState('open',{...reviewed,processing_activity:activity}),'stalled');
  }
  const pendingSource={...doc,parse_status:'pending'};
  const sourceActivity=projectReconcileActivity({...base,documents:[statement,pendingSource],observedAt:at});
  assert.equal(sourceActivity.get('document:source').phase,'reading');
  assert.equal(sourceActivity.get('document:source').batch.done,0,'saved reviews do not become accounting terminals');
  assert.equal(sourceActivity.get('document:source').batch.in_progress,0,'current review creates no synthetic work');
  const failedSource=projectReconcileActivity({...base,documents:[statement,{...doc,parse_status:'failed'}],observedAt:later});
  assert.equal(failedSource.get('document:source').reason_code,'source_processing_failed');
});
