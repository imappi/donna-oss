// Disposable PG + SDK protocol proof. Provider/platform responses are explicitly
// synthetic; this cannot certify a production deployment or live provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createHmac,generateKeyPairSync,sign } from 'node:crypto';
import { createServer,request } from 'node:http';
import { readdir,readFile } from 'node:fs/promises';
import pg from 'pg';
// H-3b: the held match comes from Jev's real writer path with a synthetic
// decision. A hold is recorded as a settled proposal, and the recovery sweep
// buys no further decision for it; the owner confirmation is its terminal.
const proveJevHeldMatch = async ({pool, firmId, clientId, documentId, transactionId, withClient}) => {
  const {runJevReconciliationForDocument, __jevReconciliation} = await import('./jevReconciliation.js');
  const {readJevCase} = await import('./jevPreview.js');
  const {readClientConfigSnapshot} = await import('./clientConfig.js');
  const {recoverReconciliationProviderFailures} = await import('./reconciliationProviderFailure.js');
  const priorDecide = __jevReconciliation.decide;
  let decisions = 0;
  __jevReconciliation.decide = async args => {
    decisions += 1;
    assert.equal(args.documentId, documentId, 'only the held document reaches the synthetic decision');
    const mapped = await readJevCase(args);
    return {document:mapped.sourceDocument, candidates:mapped.candidates, evidence_packet_sha256:mapped.prepared.packet_sha256,
      decision:{terminal:'resolve', probability:.95, refusals:[], plan:{allocations:[{transaction_id:transactionId, amount_minor:59640, currency:'EUR'}],
        retained_balance_minor:0, requests:[]}}, model:'fixture-jev-model', usage:{input_tokens:1, output_tokens:1}};
  };
  try {
    const stats = await withClient(async client => runJevReconciliationForDocument({client, firmId, clientId, documentId, family:'supplier_bill',
      configSnapshot:await readClientConfigSnapshot(client, {firmId, clientId, strict:true})}));
    assert.equal(stats.jev_reason, 'jev_match_held_for_authority', JSON.stringify(stats));
    const match = (await pool.query('select status,payload from reconciliation_matches where matched_object_id=$1', [documentId])).rows;
    assert.equal(match.length, 1); assert.equal(match[0].status, 'suggested');
    assert.ok(match[0].payload.authorization.reasons.some(reason => ['above_materiality_ceiling','materiality_ceiling_unset'].includes(reason)), JSON.stringify(match[0].payload.authorization));
    const evaluation = (await pool.query(`select verdict,payload from reconciliation_evaluations where target_id=$1 and matcher_family='supplier_bill'`, [documentId])).rows[0];
    assert.equal(evaluation.verdict, 'proposed');
    assert.equal(evaluation.payload.next_action, null);
    assert.equal(evaluation.payload.execution, 'held_for_authority');
    await pool.query(`update reconciliation_evaluations set evaluated_at=now()-interval '10 minutes' where target_id=$1`, [documentId]);
    const swept = await recoverReconciliationProviderFailures({firmId, withClient, onRunCompletedFn:null});
    assert.deepEqual(swept.filter(row => row.document_id === documentId), []);
    assert.equal(decisions, 1, 'a held match costs no further decision');
  } finally { __jevReconciliation.decide = priorDecide; }
};

// HELMIKUU S5: three multi-member Jev plans whose first write is held for
// authority. The trace behind the decision to keep their retry: the held row's
// owner ask confirms that one bank line only. The match stays suggested and the
// other members (statement rows, refund-group members, the reminder's
// settlement of the original invoice) are never written. A held verdict would
// strand them, so the evaluation stays retry_writer. This pins the gap.
const proveJevHeldPlanGaps = async ({pool, firmId, clientId, actorId, withClient}) => {
  const {runJevReconciliationForDocument, __jevReconciliation} = await import('./jevReconciliation.js');
  const {decideJevReconciliation} = await import('./jevRuntimeDecision.js');
  const {readClientConfigSnapshot} = await import('./clientConfig.js');
  const {__createHeldMatchPortalAsksWithClient, resolveClientEvidenceRequestInDb} = await import('./db/asks.js');
  const priorDecide = __jevReconciliation.decide, priorFetch = globalThis.fetch;
  let replies = 0;
  globalThis.fetch = async target => {
    assert.equal(String(target),'https://api.openai.com/v1/responses','only the synthetic reply coder may call a provider');
    replies += 1;
    return {ok:true,json:async()=>({id:'fixture-held-plan-reply',output_text:JSON.stringify({
      proposed_account:'Sales',contact:'Synthetic counterparty',tax_treatment:'Ei ALV-käsittelyä',
      support_note:'The customer confirms the matched document.',ask_client_question:'',
      evidence_required:false,remember_candidate:false,merchant_pattern:'',missing_account_name:'',missing_account_type:'',
      missing_account_reason:'',auto_explain_limit:0,confidence:'high',materiality:'material',
      reasoning:'The customer confirmed the held match.',warnings:[],alternatives:[]})})};
  };
  const rows = (sql, params) => pool.query(sql, params).then(result => result.rows);
  const insertLines = (documentId, lines) => Promise.all(lines.map(([id, description, amount, payload], index) =>
    pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, firmId, clientId, documentId, index + 1, description, amount, payload])));
  const insertBank = lines => Promise.all(lines.map(([id, date, description, moneyIn, moneyOut]) =>
    pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
      values($1,$2,$3,$4,$5,$6,$7,'EUR','needs_review','proposed','{}')`, [id, firmId, clientId, date, description, moneyIn, moneyOut])));
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,parse_summary,payload)
    values('plan-payout',$1,$2,'plan-payout.pdf','payout_statement','completed','2025-02-10',1792,'EUR','{}','{}')`, [firmId, clientId]);
  await insertLines('plan-payout', [['plan-payout-row-1','Settlement 1',597,{raw_extraction:{settlement_row:{gross:600,fees:3,net:597}}}],
    ['plan-payout-row-2','Settlement 2',1195,{raw_extraction:{settlement_row:{gross:1200,fees:5,net:1195}}}]]);
  await insertBank([['plan-payout-bank-1','2025-02-11','Processor settlement 1',597,0], ['plan-payout-bank-2','2025-02-12','Processor settlement 2',1195,0]]);
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency,parse_summary,payload)
    values('plan-purchase',$1,$2,'plan-purchase.pdf','receipt','completed','2025-02-10',1990,404.26,'EUR','{"line_amounts_include_tax":true}','{}')`, [firmId, clientId]);
  await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload)
    values('plan-purchase-line',$1,$2,'plan-purchase',1,'Equipment',1990,0.255,'{}')`, [firmId, clientId]);
  await insertBank([['plan-group-a','2025-02-10','Equipment shop',0,1990], ['plan-group-b','2025-02-10','Equipment shop',0,1990],
    ['plan-group-refund','2025-02-12','Equipment shop refund',1990,0]]);
  for (const d of [{id:'plan-original',ref:'INV-7002',date:'2025-02-03',total:903.60,tax:183.60,summary:{line_amounts_include_tax:false},
      lines:[['plan-original-line','Service',720,{raw_extraction:{tax_rate:.255}}]]},
    {id:'plan-reminder',ref:'REM-7002',date:'2025-02-12',total:923.60,tax:null,summary:{line_amounts_include_tax:true,references:[{type:'invoice_number',value:'INV-7002'}]},
      lines:[['plan-reminder-principal','Original invoice',903.60,{raw_extraction:{tax_rate:.255}}],['plan-reminder-charge','Reminder charge',20,{raw_extraction:{tax_rate:0}}]]}]) {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,customer_name,reference_number,document_date,currency,total_amount,tax_amount,parse_summary,payment_status,payload)
      values($1,$2,$3,$4,'sales_invoice','completed','Synthetic customer Oy',$5,$6,'EUR',$7,$8,$9,'unpaid','{}')`, [d.id, firmId, clientId, `${d.id}.pdf`, d.ref, d.date, d.total, d.tax, d.summary]);
    await insertLines(d.id, d.lines);
  }
  await insertBank([['plan-reminder-bank','2025-02-14','Invoice and reminder',923.60,0]]);
  const plans = [
    {id:'plan-payout', family:'payout_statement', first:'plan-payout-bank-1', rest:['plan-payout-bank-2'], choose:key => key.startsWith('candidate_')},
    {id:'plan-purchase', family:'receipt', first:'plan-group-a', rest:['plan-group-b','plan-group-refund'], choose:key => key.startsWith('refund_group_')},
    {id:'plan-reminder', family:'sales_invoice', first:'plan-reminder-bank', rest:[], choose:key => key.endsWith('_via_reminder')}];
  const assertIncomplete = async (plan, stage) => {
    const evaluation = (await rows(`select verdict,payload from reconciliation_evaluations where target_id=$1 and matcher_family=$2`, [plan.id, plan.family]))[0];
    assert.equal(evaluation.payload.next_action, 'retry_writer', `${plan.id} ${stage}: no held verdict for a multi-member plan`);
    assert.equal(evaluation.payload.execution, 'not_applied', `${plan.id} ${stage}`);
    const matches = await rows(`select bank_transaction_id,status,payload from reconciliation_matches where matched_object_id=$1 or bank_transaction_id=any($2::text[])`,
      [plan.id, [plan.first, ...plan.rest]]);
    assert.deepEqual(matches.map(match => [match.bank_transaction_id, match.status]), [[plan.first, 'suggested']],
      `${plan.id} ${stage}: the held row stays suggested and the other members stay unwritten`);
    assert.equal(matches[0].payload.reminder_obligation, undefined, `${plan.id} ${stage}`);
    assert.equal((await rows(`select id from transactions where id=any($1::text[]) and payload ? 'jev_refund_group'`, [[plan.first, ...plan.rest]])).length, 0, `${plan.id} ${stage}`);
  };
  try {
    __jevReconciliation.decide = args => decideJevReconciliation({...args, provider:async request => ({model:'fixture-jev-model',
      answers:Object.fromEntries(Object.entries(request.questions).map(([key, question]) =>
        [key, {choice:Object.keys(question.criteria).find(plans.find(plan => plan.id === args.documentId).choose), probability:.95}]))})});
    for (const plan of plans) {
      const stats = await withClient(async client => runJevReconciliationForDocument({client, firmId, clientId, documentId:plan.id, family:plan.family,
        configSnapshot:await readClientConfigSnapshot(client, {firmId, clientId, strict:true})}));
      assert.equal(stats.jev_reason, 'jev_writer_did_not_auto_reconcile', `${plan.id}: ${JSON.stringify(stats)}`);
      await assertIncomplete(plan, 'held');
    }
    // The existing held-match ask gives the held line its owner question: one
    // per plan, on the first member only.
    const minted = await withClient(client => __createHeldMatchPortalAsksWithClient({client, firmId, clientId}));
    const asks = await rows(`select id,transaction_id from client_evidence_requests where id=any($1::text[]) order by transaction_id`, [minted]);
    assert.deepEqual(asks.map(ask => ask.transaction_id), plans.map(plan => plan.first).sort());
    for (const ask of asks) await resolveClientEvidenceRequestInDb({firmId, evidenceRequestId:ask.id,
      reply:'Yes, this payment settles that document.', actorId, actorType:'firm_member', answerSource:'phone'});
    assert.equal(replies, asks.length, 'one reply model call per answered question');
    assert.deepEqual((await rows(`select status from client_evidence_requests where id=any($1::text[]) and status not in ('replied','resolved')`, [minted])), []);
    // The owner's answer settles nothing beyond that line.
    for (const plan of plans) await assertIncomplete(plan, 'after the owner reply');
    const payout = (await rows(`select convergence_state,convergence_reason from documents where id='plan-payout'`))[0];
    assert.deepEqual(payout, {convergence_state:'hanging', convergence_reason:'settlement_row:2:unsettled'});
    assert.deepEqual((await rows(`select id,convergence_state from transactions where id=any($1::text[]) order by id`, [['plan-group-b','plan-group-refund','plan-payout-bank-2']]))
      .map(row => row.convergence_state), ['hanging','hanging','hanging'], 'the unwritten members still hang');
    const original = (await rows(`select payment_status,payload->'reminder_obligation' receipt,convergence_state from documents where id='plan-original'`))[0];
    assert.equal(original.receipt, null); assert.notEqual(original.payment_status, 'paid'); assert.equal(original.convergence_state, 'hanging');
  } finally { __jevReconciliation.decide = priorDecide; globalThis.fetch = priorFetch; }
};

// HELMIKUU S7: with JEV_HELD_PLAN_COMPLETION on, the same three plan shapes
// complete through the real owner question and reply. Every held statement row
// gets its own question; the owner's yes on each settles it, and the first
// member's yes completes the refund group and the reminder settlement.
const proveJevHeldPlanCompletion = async ({pool, firmId, clientId, actorId, withClient}) => {
  const {runJevReconciliationForDocument, __jevReconciliation} = await import('./jevReconciliation.js');
  const {decideJevReconciliation} = await import('./jevRuntimeDecision.js');
  const {readClientConfigSnapshot} = await import('./clientConfig.js');
  const {__createHeldMatchPortalAsksWithClient, resolveClientEvidenceRequestInDb} = await import('./db/asks.js');
  const priorDecide = __jevReconciliation.decide, priorFetch = globalThis.fetch;
  let replies = 0, decisions = 0;
  globalThis.fetch = async target => {
    assert.equal(String(target),'https://api.openai.com/v1/responses','only the synthetic reply coder may call a provider');
    replies += 1;
    return {ok:true,json:async()=>({id:'fixture-held-plan-completion-reply',output_text:JSON.stringify({
      proposed_account:'Sales',contact:'Synthetic counterparty',tax_treatment:'Ei ALV-käsittelyä',
      support_note:'The customer confirms the matched document.',ask_client_question:'',
      evidence_required:false,remember_candidate:false,merchant_pattern:'',missing_account_name:'',missing_account_type:'',
      missing_account_reason:'',auto_explain_limit:0,confidence:'high',materiality:'material',
      reasoning:'The customer confirmed the held match.',warnings:[],alternatives:[]})})};
  };
  const rows = (sql, params) => pool.query(sql, params).then(result => result.rows);
  const {setClientFlagStage} = await import('./clientConfig.js');
  const {healTargetedEntityReadiness, readCurrentHostCertificateWithClient} = await import('./runtimeReadiness.js');
  // A config change is a certified entity dependency: stage the flag through
  // its writer, then heal readiness the way an operator's change would.
  const stageFlag = async stage => {
    await setClientFlagStage(pool, {firmId, clientId, flagKey:'JEV_HELD_PLAN_COMPLETION', stage, reason:'HELMIKUU S7 lifecycle proof', actorId});
    const healed = await healTargetedEntityReadiness({withFirmDbClientFn:withClient,
      renewedCloudHostCompatibilityDigest:(await readCurrentHostCertificateWithClient(pool)).compatibility_digest});
    assert.deepEqual(healed.results.filter(result => result.client_id === clientId).map(result => result.status), ['ready'],
      `staging ${stage} keeps the entity admitted (the flag is a declared, admitted extension)`);
  };
  await stageFlag('canary');
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,parse_summary,payload)
    values('done-payout',$1,$2,'done-payout.pdf','payout_statement','completed','2025-02-10',1812,'EUR','{}','{}')`, [firmId, clientId]);
  for (const [id, n, amount, row] of [['done-payout-row-1',1,607,{gross:610,fees:3,net:607}],['done-payout-row-2',2,1205,{gross:1210,fees:5,net:1205}]])
    await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,'done-payout',$4,$5,$6,$7)`,
      [id, firmId, clientId, n, `Settlement ${n}`, amount, {raw_extraction:{settlement_row:row}}]);
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency,parse_summary,payload)
    values('done-purchase',$1,$2,'done-purchase.pdf','receipt','completed','2025-02-10',1890,383.90,'EUR','{"line_amounts_include_tax":true}','{}')`, [firmId, clientId]);
  await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload)
    values('done-purchase-line',$1,$2,'done-purchase',1,'Equipment',1890,0.255,'{}')`, [firmId, clientId]);
  for (const d of [{id:'done-original',ref:'INV-9002',date:'2025-02-03',total:1004,tax:204,summary:{line_amounts_include_tax:false},lines:[['done-original-line','Service',800,.255]]},
    {id:'done-reminder',ref:'REM-9002',date:'2025-02-12',total:1019,tax:null,summary:{line_amounts_include_tax:true,references:[{type:'invoice_number',value:'INV-9002'}]},
      lines:[['done-reminder-principal','Original invoice',1004,.255],['done-reminder-charge','Reminder charge',15,0]]}]) {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,customer_name,reference_number,document_date,currency,total_amount,tax_amount,parse_summary,payment_status,payload)
      values($1,$2,$3,$4,'sales_invoice','completed','Synthetic customer Oy',$5,$6,'EUR',$7,$8,$9,'unpaid','{}')`, [d.id, firmId, clientId, `${d.id}.pdf`, d.ref, d.date, d.total, d.tax, d.summary]);
    for (const [i, [id, description, amount, rate]] of d.lines.entries()) await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, [id, firmId, clientId, d.id, i + 1, description, amount, {raw_extraction:{tax_rate:rate}}]);
  }
  for (const [id, date, description, moneyIn, moneyOut] of [['done-payout-bank-1','2025-02-11','Processor settlement 1',607,0],['done-payout-bank-2','2025-02-12','Processor settlement 2',1205,0],
    ['done-group-a','2025-02-10','Equipment store',0,1890],['done-group-b','2025-02-10','Equipment store',0,1890],['done-group-refund','2025-02-12','Equipment store refund',1890,0],
    ['done-reminder-bank','2025-02-14','Invoice and reminder',1019,0]])
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
      values($1,$2,$3,$4,$5,$6,$7,'EUR','needs_review','proposed','{}')`, [id, firmId, clientId, date, description, moneyIn, moneyOut]);
  const plans = [
    {id:'done-payout', family:'payout_statement', members:['done-payout-bank-1','done-payout-bank-2'], choose:key => key.startsWith('candidate_')},
    {id:'done-purchase', family:'receipt', members:['done-group-a','done-group-b','done-group-refund'], choose:key => key.startsWith('refund_group_')},
    {id:'done-reminder', family:'sales_invoice', members:['done-reminder-bank'], choose:key => key.endsWith('_via_reminder')}];
  const evaluation = async plan => (await rows(`select verdict,payload from reconciliation_evaluations where target_id=$1 and matcher_family=$2`, [plan.id, plan.family]))[0];
  const states = plan => rows(`select bank_transaction_id,status from reconciliation_matches where matched_object_id=$1 order by bank_transaction_id`, [plan.id])
    .then(result => result.map(match => [match.bank_transaction_id, match.status]));
  try {
    __jevReconciliation.decide = args => { decisions += 1; return decideJevReconciliation({...args, provider:async request => ({model:'fixture-jev-model',
      answers:Object.fromEntries(Object.entries(request.questions).map(([key, question]) =>
        [key, {choice:Object.keys(question.criteria).find(plans.find(plan => plan.id === args.documentId).choose), probability:.95}]))})}); };
    for (const plan of plans) {
      const stats = await withClient(async client => runJevReconciliationForDocument({client, firmId, clientId, documentId:plan.id, family:plan.family,
        configSnapshot:await readClientConfigSnapshot(client, {firmId, clientId, strict:true})}));
      assert.equal(stats.jev_reason, 'jev_match_held_for_authority', `${plan.id}: ${JSON.stringify(stats)}`);
      const held = await evaluation(plan);
      assert.equal(held.payload.execution, 'held_for_authority', plan.id); assert.equal(held.payload.next_action, null, plan.id);
    }
    assert.deepEqual(await states(plans[0]), [['done-payout-bank-1','suggested'],['done-payout-bank-2','suggested']], 'each held row is written and held on its own');
    // One owner question per held bank line: each statement row, the group's first debit, the reminder payment.
    const minted = await withClient(client => __createHeldMatchPortalAsksWithClient({client, firmId, clientId}));
    const asks = await rows(`select id,transaction_id from client_evidence_requests where id=any($1::text[]) order by transaction_id`, [minted]);
    assert.deepEqual(asks.map(ask => ask.transaction_id), ['done-group-a','done-payout-bank-1','done-payout-bank-2','done-reminder-bank']);
    for (const ask of asks) await resolveClientEvidenceRequestInDb({firmId, evidenceRequestId:ask.id,
      reply:'Yes, this payment settles that document.', actorId, actorType:'firm_member', answerSource:'phone'});
    assert.equal(replies, asks.length, 'one reply model call per answered question');
    assert.equal(decisions, plans.length, 'completion buys no further Jev decision');
    for (const plan of plans) {
      assert.deepEqual(await states(plan), plan.members.map(id => [id, 'auto_matched']).sort(), `${plan.id}: the owner's confirmation completes the whole plan`);
      const done = await evaluation(plan);
      assert.equal(done.verdict, 'proposed'); assert.equal(done.payload.execution, 'existing_reconciliation_writer', plan.id);
      assert.equal(done.payload.next_action, null);
    }
    const confirmedRows = await rows(`select payload from reconciliation_matches where bank_transaction_id=any($1::text[])`, [asks.map(ask => ask.transaction_id)]);
    assert.ok(confirmedRows.every(row => row.payload.authorization.reasons.includes('owner_confirmed_held_match') && row.payload.owner_confirmation.actor_id === actorId));
    assert.equal((await rows(`select id from transactions where id like 'done-group-%' and payload->'jev_refund_group'->>'status'='selected'`)).length, 3);
    const original = (await rows(`select payment_status,payload->'reminder_obligation'->>'status' receipt from documents where id='done-original'`))[0];
    assert.deepEqual(original, {payment_status:'paid', receipt:'applied'});
    assert.deepEqual(await rows(`select id from documents where id=any($1::text[]) and convergence_state='hanging'`, [['done-payout','done-purchase','done-reminder','done-original']]), [],
      'no plan document is left hanging');
    // A retry of the owner questions or the recovery duplicates nothing.
    const before = await rows(`select id,status,match_amount from reconciliation_matches where matched_object_id like 'done-%' order by id`);
    assert.deepEqual(await withClient(client => __createHeldMatchPortalAsksWithClient({client, firmId, clientId})), []);
    assert.deepEqual(await rows(`select id,status,match_amount from reconciliation_matches where matched_object_id like 'done-%' order by id`), before);
    assert.equal((await rows(`select id from reconciliation_authority_grants where client_id=$1`, [clientId])).length, 0, 'an owner confirmation mints no standing grant');
  } finally { __jevReconciliation.decide = priorDecide; globalThis.fetch = priorFetch;
    await stageFlag('off'); }
};

// HELMIKUU S8: a statement with several held rows. Each row keeps its own
// question, which names the other held rows; one answer that the typed scope
// reader takes as "all the remaining rows" settles every named row, one owner
// receipt each, and answers their questions. Real question, real reply.
const proveJevHeldRowsConfirmedTogether = async ({pool, firmId, clientId, actorId, withClient}) => {
  const {__jevReconciliation, runJevReconciliationForDocument} = await import('./jevReconciliation.js');
  const {decideJevReconciliation} = await import('./jevRuntimeDecision.js');
  const {readClientConfigSnapshot, setClientFlagStage} = await import('./clientConfig.js');
  const {__createHeldMatchPortalAsksWithClient, resolveClientEvidenceRequestInDb} = await import('./db/asks.js');
  const {healTargetedEntityReadiness, readCurrentHostCertificateWithClient} = await import('./runtimeReadiness.js');
  const priorDecide = __jevReconciliation.decide, priorFetch = globalThis.fetch, priorKey = process.env.ANTHROPIC_API_KEY;
  const stageFlag = async stage => {
    await setClientFlagStage(pool, {firmId, clientId, flagKey:'JEV_HELD_PLAN_COMPLETION', stage, reason:'HELMIKUU S8 lifecycle proof', actorId});
    const healed = await healTargetedEntityReadiness({withFirmDbClientFn:withClient,
      renewedCloudHostCompatibilityDigest:(await readCurrentHostCertificateWithClient(pool)).compatibility_digest});
    assert.deepEqual(healed.results.filter(result => result.client_id === clientId).map(result => result.status), ['ready']);
  };
  const rows = (sql, params) => pool.query(sql, params).then(result => result.rows);
  const calls = {coder:0, scope:0};
  await stageFlag('canary');
  process.env.ANTHROPIC_API_KEY = 'fixture';
  try {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,parse_summary,payload)
      values('rows-payout',$1,$2,'rows-payout.pdf','payout_statement','completed','2025-02-17',2166,'EUR','{}','{}')`, [firmId, clientId]);
    for (const [n, amount] of [[1,611],[2,722],[3,833]]) {
      await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,'rows-payout',$4,$5,$6,$7)`,
        [`rows-payout-row-${n}`, firmId, clientId, n, `Settlement ${n}`, amount, {raw_extraction:{settlement_row:{gross:amount + 4, fees:4, net:amount}}}]);
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
        values($1,$2,$3,$4,$5,$6,0,'EUR','needs_review','proposed','{}')`, [`rows-bank-${n}`, firmId, clientId, `2025-02-${17 + n}`, `Processor settlement ${n}`, amount]);
    }
    __jevReconciliation.decide = args => decideJevReconciliation({...args, provider:async request => ({model:'fixture-jev-model',
      answers:Object.fromEntries(Object.entries(request.questions).map(([key, question]) =>
        [key, {choice:Object.keys(question.criteria).find(k => k.startsWith('candidate_')), probability:.95}]))})});
    const stats = await withClient(async client => runJevReconciliationForDocument({client, firmId, clientId, documentId:'rows-payout', family:'payout_statement',
      configSnapshot:await readClientConfigSnapshot(client, {firmId, clientId, strict:true})}));
    assert.equal(stats.jev_reason, 'jev_match_held_for_authority', JSON.stringify(stats));
    const states = () => rows(`select bank_transaction_id,status from reconciliation_matches where matched_object_id='rows-payout' order by bank_transaction_id`)
      .then(result => result.map(match => [match.bank_transaction_id, match.status]));
    assert.deepEqual(await states(), [['rows-bank-1','suggested'],['rows-bank-2','suggested'],['rows-bank-3','suggested']]);
    const minted = await withClient(client => __createHeldMatchPortalAsksWithClient({client, firmId, clientId}));
    const asks = await rows(`select id,transaction_id,question,request_payload from client_evidence_requests where id=any($1::text[]) and transaction_id like 'rows-bank-%' order by transaction_id`, [minted]);
    assert.deepEqual(asks.map(ask => ask.transaction_id), ['rows-bank-1','rows-bank-2','rows-bank-3'], 'each held row keeps its own question');
    assert.match(asks[0].question, /Myös 2 muuta saman tiliotteen riviä odottaa vahvistustasi: rivi 2 ”Settlement 2”, 722,00 EUR saatu 19\.2\.2025; rivi 3 ”Settlement 3”, 833,00 EUR saatu 20\.2\.2025\. Voit vahvistaa kaikki jäljellä olevat rivit kerralla vastauksessasi tai vastata rivi kerrallaan\.$/);
    assert.deepEqual(asks[0].request_payload.held_match_siblings.map(row => row.transaction_id), ['rows-bank-2','rows-bank-3']);
    globalThis.fetch = async (target, init) => {
      if (String(target) === 'https://api.openai.com/v1/responses') {
        calls.coder += 1;
        return {ok:true,json:async()=>({id:'fixture-held-rows-reply',output_text:JSON.stringify({
          proposed_account:'Sales',contact:'Synthetic processor',tax_treatment:'Ei ALV-käsittelyä',
          support_note:'The owner confirms the statement rows.',ask_client_question:'',
          evidence_required:false,remember_candidate:false,merchant_pattern:'',missing_account_name:'',missing_account_type:'',
          missing_account_reason:'',auto_explain_limit:0,confidence:'high',materiality:'material',
          reasoning:'The owner confirmed the held rows.',warnings:[],alternatives:[]})})};
      }
      assert.equal(String(target), 'https://api.anthropic.com/v1/messages', 'only the synthetic coder and scope reader may be called');
      calls.scope += 1;
      return new Response(JSON.stringify({model:'fixture-strong-scope-model', stop_reason:'tool_use', usage:{input_tokens:1, output_tokens:1},
        content:[{type:'tool_use', name:'interpret_owner_reply', input:{answer:'all_remaining_rows', confidence:.97, clarification:null}}]}), {status:200});
    };
    await resolveClientEvidenceRequestInDb({firmId, evidenceRequestId:asks[0].id,
      reply:'Yes, all three are settlements from this statement.', actorId, actorType:'firm_member', answerSource:'phone'});
    assert.deepEqual(calls, {coder:1, scope:1}, 'the other rows buy no model call');
    assert.deepEqual(await states(), [['rows-bank-1','auto_matched'],['rows-bank-2','auto_matched'],['rows-bank-3','auto_matched']]);
    for (const match of await rows(`select payload from reconciliation_matches where matched_object_id='rows-payout'`)) {
      assert.equal(match.payload.owner_confirmation.actor_id, actorId);
      assert.equal(match.payload.owner_confirmation.evidence_request_id, asks[0].id, 'one receipt per row, all carrying the answer');
      assert.equal(match.payload.owner_confirmation.scope_decision.model, 'fixture-strong-scope-model');
    }
    assert.deepEqual((await rows(`select transaction_id,status from client_evidence_requests where id=any($1::text[]) order by transaction_id`, [asks.map(ask => ask.id)]))
      .map(ask => ask.status), ['resolved','resolved','resolved'], 'every row question is answered');
    const done = (await rows(`select verdict,payload from reconciliation_evaluations where target_id='rows-payout' and matcher_family='payout_statement'`))[0];
    assert.deepEqual([done.verdict, done.payload.execution, done.payload.next_action], ['proposed','existing_reconciliation_writer',null]);
    assert.deepEqual(await rows(`select id from transactions where id like 'rows-bank-%' and convergence_state='on_owner'`), [], 'no answered row rests on the owner');
    assert.deepEqual(await rows(`select id from documents where id='rows-payout' and convergence_state='hanging'`), [], 'the statement is not left hanging');
    const before = await rows(`select id,status,match_amount from reconciliation_matches where matched_object_id='rows-payout' order by id`);
    assert.deepEqual((await withClient(client => __createHeldMatchPortalAsksWithClient({client, firmId, clientId}))).filter(Boolean), []);
    assert.deepEqual(await rows(`select id,status,match_amount from reconciliation_matches where matched_object_id='rows-payout' order by id`), before, 'a retry duplicates nothing');
  } finally {
    __jevReconciliation.decide = priorDecide; globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
    await stageFlag('off');
  }
};

// Called only after the PG17 fixture's real signed host and entity admission.
const proveHeldMatchPortalReply = async ({pool, firmId, clientId, actorId, withClient, hostCertificate}) => {
  const {__createHeldMatchPortalAsksWithClient, resolveClientEvidenceRequestInDb} = await import('./db/asks.js');
  const {runCodingConvergenceInDb} = await import('./codingConvergence.js');
  const {buildHostOperationalFailureCertificate, persistHostReadinessAttempt, healTargetedEntityReadiness} = await import('./runtimeReadiness.js');
  const {buildHostCertificateFreshness, hostDigest} = await import('./hostCertificateA.js');
  const priorFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (target,init) => {
    assert.equal(String(target),'https://api.openai.com/v1/responses','only the synthetic reply coder may call a provider');
    requests.push(JSON.parse(init.body));
    return {ok:true,json:async()=>({id:'fixture-held-reply',output_text:JSON.stringify({
      proposed_account:'TyEL and payroll contributions payable',contact:'Synthetic pension provider',tax_treatment:'Ei ALV-käsittelyä',
      support_note:'The customer confirms the named pension bill was paid in full.',ask_client_question:'',
      evidence_required:false,remember_candidate:false,merchant_pattern:'',missing_account_name:'',missing_account_type:'',
      missing_account_reason:'',auto_explain_limit:0,confidence:'high',materiality:'material',
      reasoning:'The customer confirmed settlement of the evidenced pension liability.',warnings:[],alternatives:[]})})};
  };
  const journalRows = id => pool.query(`select l.account_name,l.debit::float8,l.credit::float8,l.tax_type
    from ledger_journals j join ledger_lines l on l.journal_id=j.id
    where j.firm_id=$1 and j.client_id=$2 and j.source_type='transaction' and j.source_id=$3 order by l.line_no`,[firmId,clientId,id]);
  const clock = () => runCodingConvergenceInDb({firmId,
    recoverOwnerRepliesFn:null,recoverReconciliationProviderFailuresFn:null,hostedPilotTerminalConvergenceFn:null,
    recoverChangedEvidenceFn:null,recoverRefusedEvidenceFn:null,recoverAeVatLegacyCodingFn:null,
    recoverAskDraftFn:async()=>[],releaseWaitingFn:async()=>[],discoverCoderClientsFn:async()=>[],discoverSweepClientsFn:async()=>[]});
  try {
    const grantsBefore = (await pool.query('select count(*)::int n from reconciliation_authority_grants where firm_id=$1 and client_id=$2',[firmId,clientId])).rows[0].n;
    for (const outage of [false,true]) {
      const id = outage ? 'held-reply-host-recovery' : 'held-reply-pension';
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,coding_state,payload)
        values($1,$2,$3,'2025-02-15','Synthetic pension payment',596.4,0,'EUR','needs_review','proposed','{}')`,[id,firmId,clientId]);
      await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,
        document_date,vendor_name,payment_status,payload) values($1,$2,$3,$4,'supplier_bill','completed',596.4,0,'EUR','2025-02-10',
        'Synthetic pension provider','unpaid','{}')`,[`doc-${id}`,firmId,clientId,`${id}.pdf`]);
      if (outage) await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,
        matched_object_id,match_amount,match_confidence,status,payload) values($1,$2,$3,$4,'supplier_bill',$5,596.4,.95,'suggested',
        '{"authorization":{"reasons":["above_materiality_ceiling"]},"match_reason":{"reasoning":"Synthetic model identified the pension bill."}}')`,
      [`match-${id}`,firmId,clientId,id,`doc-${id}`]);
      else await proveJevHeldMatch({pool,firmId,clientId,documentId:`doc-${id}`,transactionId:id,withClient});
      const minted = await withClient(client => __createHeldMatchPortalAsksWithClient({client,firmId,clientId}));
      assert.equal(minted.length,1);
      const askId = minted[0];
      const mintedAsk = (await pool.query('select question from client_evidence_requests where id=$1',[askId])).rows[0];
      assert.match(mintedAsk.question,new RegExp(`Meillä on tästä jo tiedosto ”${id}\\.pdf”\\. Vahvistathan, että tämä maksu koskee tätä tositetta`),mintedAsk.question);
      assert.doesNotMatch(mintedAsk.question,/mitä näistä tositteista/,'one held document is a confirmation, not a choice (H-3a)');
      if (outage) await persistHostReadinessAttempt({withFirmDbClientFn:withClient,
        certificate:buildHostOperationalFailureCertificate({certificate:hostCertificate,checkId:'evidence_storage',reasonCode:'fixture_reply_storage_unavailable'})});
      const result = await resolveClientEvidenceRequestInDb({firmId,evidenceRequestId:askId,
        reply:`Yes, this payment settles ${id}.pdf in full.`,actorId,actorType:'firm_member',answerSource:'phone'});
      assert.equal(result.recode?.applied,true,JSON.stringify(result.recode));
      assert.equal((await pool.query('select status from client_evidence_requests where id=$1',[askId])).rows[0].status,'resolved');
      if (outage) {
        assert.equal(result.recode.posted,false); assert.match(result.recode.post_error,/readiness/);
        assert.equal((await journalRows(id)).rowCount,0);
        const deferred = await clock();
        assert.ok(deferred.ledger_posted.some(row => row.client_id===clientId && row.error),JSON.stringify(deferred));
        const host = (await pool.query('select status,latest_attempt_id from runtime_host_readiness order by updated_at desc limit 1')).rows[0];
        assert.notEqual(host.status,'PASS','the blocking host receipt is durable even if the entity saga remains ready');
        assert.ok(host.latest_attempt_id);
        const {receipt_digest:oldDigest,...healthy} = hostCertificate;
        healthy.observed_at = new Date().toISOString(); healthy.freshness = buildHostCertificateFreshness({mintedAt:healthy.observed_at});
        await persistHostReadinessAttempt({withFirmDbClientFn:withClient,certificate:{...healthy,receipt_digest:hostDigest(healthy)}});
        await healTargetedEntityReadiness({withFirmDbClientFn:withClient,renewedCloudHostCompatibilityDigest:healthy.compatibility_digest});
        const recovered = await clock();
        assert.ok(recovered.ledger_posted.some(row => row.client_id===clientId && row.posted===1),JSON.stringify(recovered));
      } else assert.equal(result.recode.posted,true,JSON.stringify(result.recode));
      const lines = (await journalRows(id)).rows;
      assert.equal(lines.length,2,JSON.stringify(lines));
      assert.equal(lines.reduce((sum,row)=>sum+row.debit,0),596.4);
      assert.equal(lines.reduce((sum,row)=>sum+row.credit,0),596.4);
      // FI-21: the hosted Oy is born with the coded tilikartta, so the coder's
      // palette name lands on its coded statutory row (2950).
      assert.ok(lines.some(row=>row.account_name==='Työeläke- ja sivukuluvelat' && row.debit===596.4),JSON.stringify(lines));
      assert.ok(lines.some(row=>row.account_name==='Työeläke- ja sivukuluvelat' && row.tax_type==='ALV_OUT_OF_SCOPE'),JSON.stringify(lines));
      assert.ok(lines.every(row=>['ALV_OUT_OF_SCOPE','NONE'].includes(row.tax_type)),JSON.stringify(lines));
      const state = (await pool.query('select coding_state,convergence_state from transactions where id=$1',[id])).rows[0];
      assert.equal(state.convergence_state,'auto_reconciled',JSON.stringify(state));
      await clock();
      assert.deepEqual((await journalRows(id)).rows,lines,'retry creates no duplicate journal or tax line');
      assert.deepEqual(await withClient(client => __createHeldMatchPortalAsksWithClient({client,firmId,clientId})),[]);
    }
    assert.equal(requests.length,2,'one reply model call per answered question');
    assert.equal((await pool.query('select count(*)::int n from reconciliation_authority_grants where firm_id=$1 and client_id=$2',[firmId,clientId])).rows[0].n,grantsBefore,
      'a generic factual reply does not mint material approval');
  } finally {globalThis.fetch=priorFetch;}
};

// P1 "fix deployment readiness" (Host Certificate A v7), on a NEW deployment
// generation that has no worker execution and no provider response of its
// own. The worker and provider proofs are receipts; configuration and every
// correctness gate still decide admission. Fixture: the same real PG17,
// attestation key, storage server, SDK serve and writers as the scenario.
const proveDeploymentReadinessV7 = async ({pool,scope,clientId,files,attested,pair,withTestClient,registeredInngestFunctions,originalFetch}) => {
  const {renewCloudHostReadinessIfDue,collectProbeFailures}=await import('./cloudRuntimeReadiness.js');
  const {observeCloudHostCertificateA}=await import('./cloudHostCertificateA.js');
  const {readCurrentHostCertificateWithClient,persistHostReadinessAttempt,hostReadinessIsMutationReady}=await import('./runtimeReadiness.js');
  const {evaluateEntityReadinessAdmissionWithClient}=await import('./runtimeReadinessAdmission.js');
  const {observeEntityCertificateB}=await import('./entityCertificateB.js');
  const {makeDependencyFact,persistCloudDependencyEvidence}=await import('./cloudDependencyEvidence.js');
  const {cloudWorkerManifest,CLOUD_REQUIRED_WORKERS}=await import('./inngest/cloudProvenance.js');
  const {hostDigest,buildHostCertificateFreshness}=await import('./hostCertificateA.js');
  const {resolveRuntimeHostIdentity}=await import('./runtimeHostIdentity.js');
  const {createEvidenceSignedUploadUrl,fetchEvidenceObjectBytes}=await import('./evidenceStorage.js');
  const {CLOUD_ATTESTATION_KEY,attestationBytes}=await import('./cloudDeploymentAttestation.js');
  const {MODEL_LANES}=await import('./modelLanes.js');
  const {getFirmSnapshotFromDb}=await import('./firmDb.js');
  const storageOps={createUpload:createEvidenceSignedUploadUrl,read:fetchEvidenceObjectBytes,
    list:async({bucket,prefix})=>[...files.keys()].filter(k=>k.startsWith(bucket+'/'+prefix)).map(k=>({name:k.slice(bucket.length+1)})),
    delete:async({bucket,keys})=>({deleted:keys.filter(k=>files.delete(bucket+'/'+k)).length,errors:[]})};
  const observe=(extra={})=>observeCloudHostCertificateA({manifest:registeredInngestFunctions,query:pool.query.bind(pool),storageOps,...extra});
  const signAttestation=payload=>Buffer.from(JSON.stringify({payload,signature:sign(null,attestationBytes(payload),pair.privateKey).toString('base64')}));
  const deploy=(deploymentId,projectId=process.env.VERCEL_PROJECT_ID)=>{
    process.env.VERCEL_DEPLOYMENT_ID=deploymentId;process.env.VERCEL_PROJECT_ID=projectId;
    Object.assign(attested,{deployment_id:deploymentId,project_id:projectId,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+300000).toISOString()});
    files.set('donna-evidence/'+CLOUD_ATTESTATION_KEY,signAttestation(attested));
  };
  const check=(certificate,id)=>certificate.checks.find(c=>c.id===id);
  const receipts=certificate=>[check(certificate,'scheduler_worker_manifest').detail.execution_proof.workers.map(w=>[w.function_id,w.status,w.reason]),
    check(certificate,'provider_capability').detail.response_proof.providers.map(p=>[p.kind,p.status,p.reason])];
  const monitoring=certificate=>collectProbeFailures(certificate).filter(f=>f.probe==='execution'||f.probe==='response').map(f=>[f.probe,f.status,f.code]);
  const admission=boundary=>evaluateEntityReadinessAdmissionWithClient({client:pool,firmId:scope.firmId,clientId,boundary,lock:false});

  // Proof 1 — admission. A fresh deployment identity: the only worker and
  // provider evidence in the store belongs to the previous deployment.
  deploy('dpl_p1_fresh');
  const warnings=[],events=[];
  const renewal=await renewCloudHostReadinessIfDue({logger:{warn:(message,detail)=>warnings.push({message,detail}),error:(message,detail)=>warnings.push({message,detail})},
    sendWorkerEvent:async event=>{events.push(event);return {status:'requested',event_ids:['p1-fixture-event']};}});
  assert.equal(renewal.status,'PASS',JSON.stringify(renewal));
  const freshHost=await readCurrentHostCertificateWithClient(pool);
  assert.equal(freshHost.version,'donna.host-certificate-a.v9');
  assert.deepEqual(receipts(freshHost),[
    [['convergence-metrics-daily','unverified','execution_evidence_from_previous_deployment'],['document-terminal-drain','unverified','execution_evidence_from_previous_deployment']],
    [['openai','unverified','evidence_from_previous_deployment'],['anthropic','unverified','evidence_from_previous_deployment']]]);
  assert.equal(hostReadinessIsMutationReady({certificate:freshHost}),true);
  for (const boundary of ['upload_sign','document_register','parse_claim']) assert.equal((await admission(boundary)).allowed,true,boundary);
  // Monitoring, once, at workspace level: one receipt per proof kind on the
  // renewal, one warn line each, and nothing on the company row.
  assert.deepEqual(renewal.probe_failures.filter(f=>f.probe==='execution'||f.probe==='response').map(f=>[f.check,f.probe,f.status]),
    [['scheduler_worker_manifest','execution','UNVERIFIED'],['provider_capability','response','UNVERIFIED']]);
  assert.deepEqual(warnings.map(w=>w.message),['[cloud-readiness] worker execution unverified on this deployment','[cloud-readiness] provider response unverified on this deployment']);
  const snapshot=await getFirmSnapshotFromDb({firmId:scope.firmId});
  assert.equal(snapshot.runtimeReadinessHost.mutation_ready,true);
  const row=snapshot.clients.find(c=>c.id===clientId).runtime_readiness;
  assert.equal(row.mutation_ready,true,JSON.stringify(row));
  assert.doesNotMatch(JSON.stringify(row),/execution|unverified|response_proof/,'proof state never reaches the company row');
  // The renewal is the producer for the missing execution receipt: the
  // existing readiness event, once per deployment generation (dedup id).
  assert.deepEqual(events.map(e=>[e.id,e.name,e.data.firm_id]),[[`donna-host-readiness:${resolveRuntimeHostIdentity().generation_digest}`,'donna/host.readiness.requested',scope.firmId]]);
  assert.deepEqual(renewal.worker_event,{status:'requested',event_ids:['p1-fixture-event']});

  // Proof 2 — monitoring states on this generation. Proof arrival, failure
  // and recovery never touch the status or the compatibility digest.
  const manifestDigest=hostDigest(cloudWorkerManifest(registeredInngestFunctions));
  for (const function_id of CLOUD_REQUIRED_WORKERS) for (const outcome of ['step_completed','run_completed'])
    await persistCloudDependencyEvidence(makeDependencyFact({kind:'inngest',detail:{outcome,function_id,run_id:'p1-'+function_id,manifest_digest:manifestDigest,output_digest:'p1-output'}}));
  for (const kind of ['openai','anthropic'])
    await persistCloudDependencyEvidence(makeDependencyFact({kind,detail:{outcome:'response_received',response_id:'p1-response',response_model:'fixture',input_tokens:1,output_tokens:1}}));
  const proven=await observe();
  assert.equal(proven.status,'PASS');
  assert.deepEqual(receipts(proven).flat().map(r=>r[1]),['verified','verified','verified','verified']);
  assert.equal(proven.compatibility_digest,freshHost.compatibility_digest,'an unproven host has the proven host digest');
  assert.deepEqual(monitoring(proven),[]);
  await persistCloudDependencyEvidence(makeDependencyFact({kind:'anthropic',detail:{outcome:'provider_failed',error_code:'PROVIDER_OVERLOADED',response_status:529}}));
  const providerDown=await observe();
  assert.equal(providerDown.status,'PASS');assert.equal(hostReadinessIsMutationReady({certificate:providerDown}),true);
  assert.equal(providerDown.compatibility_digest,freshHost.compatibility_digest);
  assert.deepEqual(monitoring(providerDown),[['response','FAILED','PROVIDER_OVERLOADED']]);
  await persistCloudDependencyEvidence(makeDependencyFact({kind:'inngest',detail:{outcome:'worker_failed',function_id:'document-terminal-drain',run_id:'p1-outage',error_code:'CLOUD_WORKER_EXECUTION_FAILED'}}));
  const workerDown=await observe();
  assert.equal(workerDown.status,'PASS');assert.equal(hostReadinessIsMutationReady({certificate:workerDown}),true);
  assert.equal(workerDown.compatibility_digest,freshHost.compatibility_digest);
  assert.deepEqual(monitoring(workerDown),[['execution','FAILED','CLOUD_WORKER_EXECUTION_FAILED'],['response','FAILED','PROVIDER_OVERLOADED']]);
  // Absent and expired evidence: a separate project (its own host id) with
  // no evidence, then signed facts minted past each proof's validity.
  const projectId=process.env.VERCEL_PROJECT_ID;
  deploy('dpl_p1_absent','prj_p1_absent');
  const absent=await observe();
  assert.equal(absent.status,'PASS',JSON.stringify(absent.checks.filter(c=>c.status!=='PASS')));
  assert.equal(hostReadinessIsMutationReady({certificate:absent}),true);
  assert.deepEqual(receipts(absent),[
    [['convergence-metrics-daily','unverified','no_execution_evidence'],['document-terminal-drain','unverified','no_execution_evidence']],
    [['openai','unverified','no_response_evidence'],['anthropic','unverified','no_response_evidence']]]);
  const identity=resolveRuntimeHostIdentity();
  const plantExpired=async(kind,detail,ageMs)=>{
    const observedAt=new Date(Date.now()-ageMs).toISOString();
    const body={version:'donna.cloud-dependency-evidence.v1',certificate:'cloud_dependency_evidence',status:'INCOMPLETE',runtime_host:'vercel',
      host_identity:identity,observed_at:observedAt,freshness:buildHostCertificateFreshness({mintedAt:observedAt}),
      checks:[{id:'dependency_fact',status:'INCOMPLETE',detail:{reason:'dependency_evidence_is_not_host_readiness'}}],
      dependency_evidence:makeDependencyFact({kind,detail,observedAt})};
    await persistHostReadinessAttempt({withFirmDbClientFn:withTestClient,hostId:identity.host_id,certificate:{...body,receipt_digest:hostDigest(body)},eventType:'retry',evidenceOnly:true});
  };
  for (const function_id of CLOUD_REQUIRED_WORKERS) for (const outcome of ['step_completed','run_completed'])
    await plantExpired('inngest',{outcome,function_id,run_id:'p1-expired-'+function_id,manifest_digest:manifestDigest,output_digest:'p1-output'},27*60*60*1000);
  for (const kind of ['openai','anthropic'])
    await plantExpired(kind,{outcome:'response_received',response_id:'p1-expired',response_model:'fixture',input_tokens:1,output_tokens:1},8*24*60*60*1000);
  const expired=await observe();
  assert.equal(expired.status,'PASS');assert.equal(hostReadinessIsMutationReady({certificate:expired}),true);
  assert.equal(expired.compatibility_digest,absent.compatibility_digest);
  assert.deepEqual(receipts(expired),[
    [['convergence-metrics-daily','unverified','execution_evidence_expired_or_rotated'],['document-terminal-drain','unverified','execution_evidence_expired_or_rotated']],
    [['openai','unverified','evidence_expired_or_rotated'],['anthropic','unverified','evidence_expired_or_rotated']]]);
  assert.deepEqual(monitoring(expired),[['execution','UNVERIFIED','execution_evidence_expired_or_rotated'],['response','UNVERIFIED','evidence_expired_or_rotated']]);
  deploy('dpl_p1_fresh',projectId);

  // Proof 3 — configuration still gates.
  const anthropicLane=lane=>lane.endpointClass==='anthropic'||(lane.providers||[]).includes('anthropic');
  for (const [override,id,reason] of [
    [{env:{...process.env,INNGEST_SIGNING_KEY:''}},'scheduler_worker_manifest','cloud_inngest_signing_key_missing'],
    [{env:{...process.env,ANTHROPIC_API_KEY:''}},'provider_capability','cloud_provider_credential_missing'],
    [{env:{...process.env,OPENAI_API_KEY:''}},'provider_capability','cloud_provider_credential_missing'],
    [{modelLanes:MODEL_LANES.filter(lane=>!anthropicLane(lane))},'provider_capability','cloud_provider_route_missing'],
    [{manifest:registeredInngestFunctions.filter(fn=>fn.opts?.id!=='convergence-metrics-daily')},'scheduler_worker_manifest','cloud_required_worker_unregistered']
  ]) {
    const certificate=await observe(override);
    assert.equal(certificate.status,'INCOMPLETE',reason);
    assert.deepEqual([check(certificate,id).status,check(certificate,id).detail.reason],['INCOMPLETE',reason]);
    assert.equal(hostReadinessIsMutationReady({certificate}),false,reason);
  }

  // Proof 4 — correctness gates unchanged.
  const attestationKey='donna-evidence/'+CLOUD_ATTESTATION_KEY,goodAttestation=files.get(attestationKey);
  files.set(attestationKey,signAttestation({...attested,deployment_id:'dpl_another_deployment'}));
  const mismatched=await observe();
  files.set(attestationKey,goodAttestation);
  assert.equal(mismatched.status,'INCOMPLETE');assert.notEqual(check(mismatched,'source_build').status,'PASS');
  assert.equal(hostReadinessIsMutationReady({certificate:mismatched}),false);
  const drift=await pool.connect();
  try {
    await drift.query('begin');await drift.query('alter table documents rename column parse_stage to missing_parse_stage');
    const schema=await observe({query:drift.query.bind(drift)});
    assert.equal(schema.status,'INCOMPLETE');assert.equal(check(schema,'database_schema').detail.reason,'cloud_schema_inventory_mismatch');
    assert.equal(hostReadinessIsMutationReady({certificate:schema}),false);
  } finally {await drift.query('rollback');drift.release();}
  const unconfigured=await observe({env:{...process.env,SUPABASE_SERVICE_ROLE_KEY:''}});
  assert.equal(unconfigured.status,'INCOMPLETE');assert.equal(check(unconfigured,'evidence_storage').status,'INCOMPLETE');
  assert.equal(hostReadinessIsMutationReady({certificate:unconfigured}),false);
  const profileId=(await pool.query('select admitted_profile_id from entity_readiness_sagas where client_id=$1',[clientId])).rows[0].admitted_profile_id;
  const entityB=hostCertificate=>observeEntityCertificateB({query:pool.query.bind(pool),firmId:scope.firmId,clientId,profileId,hostCertificate,
    compatibilityScope:'current_generation_compatibility',observedAt:new Date().toISOString()});
  assert.equal((await entityB(freshHost)).status,'PASS','proofs are not an entity input');
  const {receipt_digest:_freshDigest,...narrowBody}=structuredClone(freshHost);
  check(narrowBody,'provider_capability').detail.required_provider_classes=['openai'];
  const narrowed=await entityB({...narrowBody,receipt_digest:hostDigest(narrowBody)});
  assert.notEqual(narrowed.status,'PASS');
  assert.ok(check(narrowed,'host_compatibility').detail.failures.includes('host_certificate_not_pass'),JSON.stringify(check(narrowed,'host_compatibility')));
  const storageless=await entityB(unconfigured);
  assert.ok(check(storageless,'host_compatibility').detail.failures.includes('host_certificate_not_pass'));

  // Proofs 5 and 6 — the per-call outcome is what must be safe once
  // admission stops asking for historical liveness. This host still carries
  // FAILED worker and provider receipts (above) and admits work. Inngest
  // accepts every parse event and no worker ever runs it (the outage); the
  // existing Vercel parse cron (outbox → drain → stuck) is the only recovery
  // clock, with the real claim, parse writers and recorded provider stub.
  const {createCloudPilotUpload}=await import('./cloudEvidenceIntake.js');
  const {registerDocumentInDb,retryParseRunsInDb,__claimParseRunWithClient}=await import('./parseDocumentsDb.js');
  const {runParseCronTask}=await import('./api.js');
  const {runParseInline}=await import('./inngest/parseDocument.js');
  const {installRecordedProviders,classifyProviderRequest}=await import('./testSupport/recordedProviders.js');
  const {fiSource,fiDocumentBytes,fiRoutingFixture,openAiFixture,fiDocumentDispositionFixture}=await import('./testSupport/fiReliabilitySources.js');
  // Hosted parses supplier bills on the per-type lane (cloud_per_type_release).
  const billExtraction=source=>openAiFixture({extraction_status:'validated',extraction_confidence:0.97,warnings:[],
    header:{counterparty_name:source.counterparty,counterparty_role:'vendor',document_date:source.date,due_date:null,currency:'EUR',
      subtotal_amount:source.net,tax_amount:source.vat,shipping_amount:0,discount_amount:0,rounding_amount:0,total_amount:source.total,
      line_amounts_include_tax:false,reference_number:source.reference,references:[],payment_status:'paid',payment_terms_phrase:null},
    lines:[{description:source.description,amount:source.net,quantity:1,unit_price:source.net,tax_rate:source.exempt?0:source.vatRate}]});
  const scriptHealthy=source=>providers.script('document_routing',[fiRoutingFixture('supplier_bill')])
    .script('supplier_bill_extraction',[billExtraction(source)]).script('document_disposition',[{...fiDocumentDispositionFixture(),times:Infinity}]);
  const upload=async(id,source)=>{
    const bytes=await fiDocumentBytes(source),checksum=createHash('sha256').update(bytes).digest('hex'),filename=`${id}.pdf`;
    const signed=await createCloudPilotUpload({...scope,bucket:'donna-evidence',filename,checksum,size:bytes.length,mimeType:'application/pdf'});
    assert.equal((await originalFetch(signed.signed_url,{method:'PUT',body:bytes})).status,200);
    const registered=await registerDocumentInDb({firmId:scope.firmId,uploadPrincipal:scope.principal,document:{id,client_id:clientId,filename,
      document_type:'supplier_bill',storage_provider:'supabase_storage',storage_bucket:'donna-evidence',storage_object_key:signed.key,
      checksum_sha256:checksum,file_storage:{size:bytes.length,mime_type:'application/pdf'}}});
    assert.equal(registered.created,true,JSON.stringify(registered));
    return registered;
  };
  const documentState=async id=>(await pool.query(`select d.parse_status,d.parse_run_id::text,d.parse_attempts,d.parse_error->>'code' as code,
      d.parse_error->>'retry_owner' as retry_owner,d.total_amount::text,d.vendor_name,
      (select count(*)::int from document_lines l where l.document_id=d.id) as lines,
      (select count(*)::int from ledger_journals j where j.source_id=d.id) as journals
    from documents d where d.id=$1`,[id])).rows[0];
  const bookCounts=async()=>(await pool.query(`select (select count(*)::int from transactions where client_id=$1) transactions,
    (select count(*)::int from ledger_journals where client_id=$1) journals,(select count(*)::int from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.client_id=$1) ledger_lines`,[clientId])).rows[0];
  const unfinished=async ids=>(await pool.query("select id from documents where id=any($1::text[]) and parse_status in ('pending','processing')",[ids])).rows.map(r=>r.id);
  const drainUntilSettled=async(ids,label)=>{
    for (let tick=1;tick<=8;tick++) {
      await runParseCronTask({task:'drain',authorizedAs:'isolated_test'});
      if (!(await unfinished(ids)).length) return tick;
    }
    assert.fail(`${label}: ${JSON.stringify(await unfinished(ids))} still unfinished after 8 drain ticks`);
  };
  const priorThreshold=process.env.PARSE_DRAIN_THRESHOLD_SECONDS;
  process.env.PARSE_DRAIN_THRESHOLD_SECONDS='0';
  const beneath=globalThis.fetch;
  const providers=installRecordedProviders();
  const scripted=globalThis.fetch;let resets=0;
  // A transport interruption: the extraction call's connection drops mid-call.
  globalThis.fetch=async(target,init)=>{
    if (resets>0 && classifyProviderRequest({url:target,init})?.lane==='supplier_bill_extraction') {
      resets-=1;throw Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('socket hang up'),{code:'ECONNRESET'})});
    }
    return scripted(target,init);
  };
  try {
    // Earlier scenario uploads still pending on this generation settle first,
    // each to a named terminal or a named hold — never an unnamed pending.
    const leftovers=(await pool.query("select id from documents where parse_status in ('pending','processing')")).rows.map(r=>r.id);
    for (let tick=0;tick<8;tick++) {
      const drain=(await runParseCronTask({task:'drain',authorizedAs:'isolated_test'})).drain;
      if (!drain.claimed && !drain.retry_pending && !drain.succeeded && !drain.worker_failed && !drain.failed) break;
    }
    for (const row of (await pool.query(`select id,parse_status,parse_error->>'code' code,parse_summary->>'reason' skipped,
      payload->'parse_hold'->>'reason_code' hold from documents where id=any($1::text[])`,[leftovers])).rows) {
      assert.ok(row.parse_status==='completed' || (row.parse_status==='failed' && row.code) || (row.parse_status==='skipped' && row.skipped)
        || (row.parse_status==='pending' && row.hold),JSON.stringify(row));
    }
    providers.reset();

    // A sibling that parses cleanly while no worker runs: the drain clock alone
    // carries accepted work to its terminal.
    scriptHealthy(fiSource('supplies'));
    const sibling=await upload('p1-sibling-bill',fiSource('supplies'));
    assert.equal((await documentState('p1-sibling-bill')).parse_status,'pending');
    await drainUntilSettled(['p1-sibling-bill'],'sibling');
    const siblingDone=await documentState('p1-sibling-bill');
    assert.equal(siblingDone.parse_status,'completed',JSON.stringify(siblingDone));
    assert.equal(siblingDone.parse_run_id,sibling.parse_run_id);
    assert.ok(siblingDone.lines>=1,JSON.stringify(siblingDone));
    const siblingRow=async()=>(await pool.query("select row_to_json(d)::jsonb - 'updated_at' as row from documents d where id='p1-sibling-bill'")).rows[0].row;
    const siblingLines=async()=>(await pool.query("select row_to_json(l)::text as row from document_lines l where document_id='p1-sibling-bill' order by 1")).rows;
    const siblingBefore={row:await siblingRow(),lines:await siblingLines()};
    const booksBefore=await bookCounts();

    // Provider interrupted, then failing, mid-parse: bounded attempts, one
    // named failure on that document, nothing partial, sibling untouched.
    providers.reset();
    providers.script('document_routing',[{status:500,times:Infinity}]).script('supplier_bill_extraction',[{status:500,times:Infinity}]);
    resets=1;
    const failing=await upload('p1-provider-failure',fiSource('rent'));
    const failTicks=await drainUntilSettled(['p1-provider-failure'],'provider failure');
    const failed=await documentState('p1-provider-failure');
    assert.equal(failed.parse_status,'failed',JSON.stringify(failed));
    assert.ok(failed.code,JSON.stringify(failed));
    assert.equal(failed.parse_run_id,failing.parse_run_id);
    assert.ok(failed.parse_attempts>=1 && failed.parse_attempts<=4 && failTicks<=4,JSON.stringify({failed,failTicks}));
    assert.equal(resets,0,'the interruption was exercised');
    assert.deepEqual([failed.lines,failed.journals,failed.total_amount],[0,0,null],'no partial document or posting');
    assert.deepEqual(await bookCounts(),booksBefore);
    assert.deepEqual({row:await siblingRow(),lines:await siblingLines()},siblingBefore,'the sibling is untouched');
    console.info('P1 provider failure receipt',{code:failed.code,attempts:failed.parse_attempts,ticks:failTicks,
      parse_error:(await pool.query("select parse_error from documents where id='p1-provider-failure'")).rows[0].parse_error});

    // Recovery: the existing retry, then exactly one result — replays of the
    // failed and the recovered run (a late Inngest delivery) change nothing.
    providers.reset();
    scriptHealthy(fiSource('rent'));
    await retryParseRunsInDb({firmId:scope.firmId,documentIds:['p1-provider-failure']});
    const retried=await documentState('p1-provider-failure');
    assert.equal(retried.parse_status,'pending');assert.notEqual(retried.parse_run_id,failing.parse_run_id);
    await drainUntilSettled(['p1-provider-failure'],'recovery');
    const recovered=await documentState('p1-provider-failure');
    assert.equal(recovered.parse_status,'completed',JSON.stringify(recovered));
    assert.equal(recovered.lines,1,JSON.stringify(recovered));
    const booksRecovered=await bookCounts();
    for (const parseRunId of [failing.parse_run_id,retried.parse_run_id]) {
      const replay=await runParseInline({firmId:scope.firmId,documentId:'p1-provider-failure',parseRunId,logger:{info(){},warn(){},error(){},log(){}}});
      assert.notEqual(replay?.outcome,'completed',JSON.stringify(replay));
    }
    await runParseCronTask({task:'drain',authorizedAs:'isolated_test'});
    await runParseCronTask({task:'stuck',authorizedAs:'isolated_test'});
    assert.deepEqual(await documentState('p1-provider-failure'),recovered,'exactly one result after retry and replay');
    assert.deepEqual(await bookCounts(),booksRecovered);
    assert.deepEqual({row:await siblingRow(),lines:await siblingLines()},siblingBefore,'the sibling is still untouched');
    assert.equal(providers.callsFor('supplier_bill_extraction').length,1,'replays spend no extraction call');

    // A worker that claimed the run and died: the existing stuck clock turns
    // it into a visible, named, retryable failure — never indefinite.
    providers.reset();
    const orphan=await upload('p1-orphaned-claim',fiSource('receipt'));
    const client=await pool.connect();
    try {assert.ok(await __claimParseRunWithClient({client,firmId:scope.firmId,documentId:'p1-orphaned-claim',parseRunId:orphan.parse_run_id}));}
    finally {client.release();}
    await pool.query("update documents set parse_heartbeat_at=now()-interval '10 minutes' where id='p1-orphaned-claim'");
    await runParseCronTask({task:'stuck',authorizedAs:'isolated_test'});
    const stuck=await documentState('p1-orphaned-claim');
    assert.deepEqual([stuck.parse_status,stuck.code,stuck.lines,stuck.journals],['failed','STUCK',0,0],JSON.stringify(stuck));
  } finally {
    providers.restore();globalThis.fetch=beneath;
    if (priorThreshold===undefined) delete process.env.PARSE_DRAIN_THRESHOLD_SECONDS; else process.env.PARSE_DRAIN_THRESHOLD_SECONDS=priorThreshold;
  }
  return {freshHost};
};

const pgUrl=process.env.DONNA_SCHEMA_PROOF_PG17_URL||process.env.DONNA_PG_TEST_URL;
for (const adopted of [false,true]) test(`real PostgreSQL and authenticated SDK: ${adopted ? 'legacy owner adoption' : 'authenticated birth'} through readiness and byte admission`,{
  skip:!pgUrl&&'INCOMPLETE: DONNA_PG_TEST_URL required',timeout:180000
},async t=>{
  const admin=new pg.Client({connectionString:pgUrl});await admin.connect();
  const name=`donna_cloud_producers_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
  const url=new URL(pgUrl);url.pathname='/'+name;
  const pool=new pg.Pool({connectionString:url.toString(),connectionTimeoutMillis:2000});
  const closed=[];pool.on('connect',c=>closed.push(new Promise(resolve=>c.once('end',resolve))));
  const env={NODE_ENV:'production',INNGEST_DEV:'0',INNGEST_EVENT_KEY:'fixture-only',INNGEST_SIGNING_KEY:'signkey-prod-fixture-key',
    VERCEL:'1',VERCEL_PROJECT_ID:'prj_fixture',VERCEL_ENV:'preview',VERCEL_DEPLOYMENT_ID:'dpl_fixture',VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),
    SUPABASE_URL:'https://storage.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-storage',DONNA_DEFAULT_FIRM_ID:'cloud-probe-firm',DATABASE_URL:url.toString(),DONNA_DESKTOP_BLOB_DIR:'',OPENAI_API_KEY:'fixture-openai',ANTHROPIC_API_KEY:'fixture-anthropic'};
  const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  const originalFetch=globalThis.fetch;let server,storageServer;
  const {__setFirmDbPoolForTests,__resetFirmDbPoolForTests}=await import('./db/pool.js');__setFirmDbPoolForTests(pool);
  t.after(async()=>{globalThis.fetch=originalFetch;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    if(storageServer){storageServer.closeAllConnections();await new Promise(r=>storageServer.close(r));}
    __resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();
    for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const dir=new URL('../../db/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()){await pool.query(await readFile(new URL(file,dir),'utf8'));await pool.query('insert into schema_migrations(version) values($1) on conflict do nothing',[file.slice(0,-4)]);}
  await pool.query("insert into firms(id,name,slug) values('cloud-probe-firm','Synthetic cloud transport proof','cloud-probe-firm')");
  const {selfProvisionClientWorkspace}=await import('./selfProvisionDb.js');
  const {prepareFinnishHostedPilotInDb,reviewFinnishHostedPilotInDb}=await import('./hostedPilot.js');
  await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('probe-operator','cloud-probe-firm','operator@fixture.invalid','Operator','admin','active')");
  const ownerAuth={type:'supabase_user',userId:'probe-owner',email:'owner@fixture.invalid'};
  const {createClientInDb}=await import('./firmDb.js');
  const {clientId}=await selfProvisionClientWorkspace({auth:ownerAuth,companyName:'Cloud transport proof Oy',jurisdiction:'FI',entityType:'fi-oy',
    ...(adopted?{deps:{createClient:({creationPrincipal,...args})=>createClientInDb(args)}}:{})});
  const creationBefore=(await pool.query("select row_to_json(a)::text value from audit_events a where action='client.create' and client_id=$1",[clientId])).rows;
  if(adopted) {
    await pool.query("update client_assignments set ends_at=clock_timestamp()+interval '20 seconds' where client_id=$1",[clientId]);
    const review=await selfProvisionClientWorkspace({auth:ownerAuth,ownerRevalidation:{action:'review'}});
    await selfProvisionClientWorkspace({auth:ownerAuth,ownerRevalidation:{action:'confirm',confirmed:true,review_digest:review.review_digest}});
  }
  const setupReview=await reviewFinnishHostedPilotInDb({firmId:'cloud-probe-firm',clientId,actorId:'probe-operator'});
  await prepareFinnishHostedPilotInDb({firmId:'cloud-probe-firm',clientId,actorId:'probe-operator',expectedClientVersion:setupReview.client_version,
    profilePatch:{companyName:'Cloud transport proof Oy',jurisdiction:'FI',entityType:'fi-oy',accountingCurrency:'EUR',accounting_system:'none',accounting_view:'management_books',accountingBasis:'accrual'}});
  assert.deepEqual((await pool.query("select stage,source,reason from client_capability_config where client_id=$1 and flag_key='FISCAL_PERIOD_INTAKE' and valid_to is null",[clientId])).rows,[{stage:'canary',source:'manual',reason:'donna.fi-hosted-pilot.v1'}]);
  const {handleInngestServeRequest,registeredInngestFunctions}=await import('./inngest/serve.js');
  const {inngest}=await import('./inngest/client.js');
  const {cloudWorkerManifest,CLOUD_REQUIRED_WORKERS}=await import('./inngest/cloudProvenance.js');
  const {hostDigest,canonicalHostJson}=await import('./hostCertificateA.js');
  const {resolveRuntimeHostIdentity}=await import('./runtimeHostIdentity.js');
  const {readCloudDependencyEvidence,makeDependencyFact,persistCloudDependencyEvidence,verifyDependencyFact,cloudCredentialGeneration}=await import('./cloudDependencyEvidence.js');
  const streams=[];
  globalThis.fetch=async(target,init)=>{if(new URL(String(target)).pathname==='/v1/realtime/publish/tee'){streams.push(new Response(init.body).text());return new Response('{}');}throw new Error('Unexpected external network refused by isolated test');};
  server=createServer((req,res)=>handleInngestServeRequest(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const hash=s=>createHash('sha1').update(s).digest('hex');
  const invoke=(functionId,{runId='fixture-'+functionId,step='step',steps={},signed=true,clientId:eventClientId=clientId}={})=>new Promise((resolve,reject)=>{
    const fn=registeredInngestFunctions.find(f=>f.opts.id===functionId);
    const event={id:'probe-fixture',name:'donna/host.readiness.requested',data:{firm_id:'cloud-probe-firm',client_id:eventClientId}};
    const payload={version:2,event,events:[event],steps,ctx:{run_id:runId,attempt:0,max_attempts:1,disable_immediate_execution:true,stack:{stack:Object.keys(steps),current:0}}};
    const ts=String(Math.floor(Date.now()/1000));const signature=createHmac('sha256','fixture-key').update(canonicalHostJson(payload)).update(ts).digest('hex');
    const body=JSON.stringify(payload);const req=request({hostname:'127.0.0.1',port:server.address().port,path:`/api/inngest?fnId=${fn.id(inngest.id)}&stepId=${step==='step'?step:hash(step)}`,
      method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(signed?{'x-inngest-signature':`t=${ts}&s=${signature}`}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)});}catch(e){reject(e);}});});req.on('error',reject);req.end(body);
  });
  const count=async()=>Number((await pool.query("select count(*) n from runtime_host_readiness_attempts where certificate_version='donna.cloud-dependency-evidence.v1'")).rows[0].n);
  const read=()=>readCloudDependencyEvidence({query:pool.query.bind(pool),identity:resolveRuntimeHostIdentity(),observedAt:new Date().toISOString(),manifestDigest:hostDigest(cloudWorkerManifest(registeredInngestFunctions)),requiredWorkers:CLOUD_REQUIRED_WORKERS,handlers:cloudWorkerManifest(registeredInngestFunctions)});
  // Host A v7: both checks score configuration; the signed facts below are
  // receipts (execution_proof / response_proof), never the check status.
  const workerProof=async()=>(await read())[1].detail.execution_proof;
  const providerProof=async()=>(await read())[0].detail.response_proof;
  const absent=await read();
  assert.deepEqual(absent.map(c=>c.status),['PASS','PASS'],'v7: configured providers and registered workers pass before any execution');
  assert.deepEqual(absent[1].detail.execution_proof.workers.map(w=>[w.status,w.reason]),[['unverified','no_execution_evidence'],['unverified','no_execution_evidence']]);
  assert.deepEqual(absent[0].detail.response_proof.providers.map(p=>[p.status,p.reason]),[['unverified','no_response_evidence'],['unverified','no_response_evidence']]);
  const unsigned=await invoke('convergence-metrics-daily',{signed:false});assert.equal(unsigned.status,401,JSON.stringify(unsigned));assert.equal(await count(),0);
  const discovery=await invoke('convergence-metrics-daily');assert.equal(discovery.status,206,JSON.stringify(discovery));assert.equal(await count(),0,'discovery is not execution');
  // A valid signed cache-only completion has no locally executed step proof.
  const forged=await invoke('convergence-metrics-daily',{runId:'cache-only',step:'complete',steps:{[hash('sample')]:{type:'data',data:{firms:1,clients_recorded:0,errors:[]}}}});
  assert.equal(forged.status,200,JSON.stringify(forged));assert.equal((await workerProof()).status,'unverified');
  const unprepared=await invoke('document-terminal-drain',{step:'sweep',runId:'unprepared-scope',clientId:'not-prepared'});
  assert.equal(unprepared.status,206,JSON.stringify(unprepared));
  assert.equal(unprepared.body[0]?.data?.errors?.[0]?.code,'INTERNAL_PILOT_ACCESS_REQUIRED');
  assert.equal((await workerProof()).status,'failed','signed caller scope alone cannot certify a pilot drain');
  const refusedProofs=(await pool.query("select certificate #>> '{dependency_evidence,fact,detail,outcome}' as outcome,certificate #>> '{dependency_evidence,fact,detail,error_code}' as code from runtime_host_readiness_attempts where certificate #>> '{dependency_evidence,fact,detail,run_id}'='unprepared-scope'")).rows;
  assert.ok(refusedProofs.length>0,'refused scope leaves an actual signed failure fact');
  assert.ok(refusedProofs.every(row=>row.outcome==='worker_failed'&&row.code==='CLOUD_WORKER_REPORTED_ERRORS'),'no successful fact for the refused scope');
  for(const [functionId,step]of [['convergence-metrics-daily','sample'],['document-terminal-drain','sweep']]){
    const executed=await invoke(functionId,{step});assert.equal(executed.status,206,JSON.stringify(executed));assert.equal(executed.body[0]?.op,'StepRun',JSON.stringify(executed));
    assert.deepEqual(executed.body[0].data.errors,[]);
    const completed=await invoke(functionId,{step:'complete',steps:{[hash(step)]:{type:'data',data:executed.body[0].data}}});
    assert.equal(completed.status,200,JSON.stringify(completed));
  }
  const before=await read();assert.equal(before[1].detail.execution_proof.status,'verified',JSON.stringify({check:before[1],rows:(await pool.query('select certificate from runtime_host_readiness_attempts')).rows}));assert.equal(before[0].detail.response_proof.status,'unverified');
  // Shared host-volume proof runs once, in the first (birth) scenario,
  // before the next scenario starts its short-lived owner assignment. All
  // assertions remain: 2,003 serial receipt writes are unrelated to expiry.
  if (!adopted) {
    const drainProofs=(await pool.query("select certificate->'dependency_evidence' as e from runtime_host_readiness_attempts where certificate #>> '{dependency_evidence,fact,detail,function_id}'='document-terminal-drain' and certificate #>> '{dependency_evidence,fact,detail,run_id}'='fixture-document-terminal-drain' order by attempt_sequence")).rows;
    assert.equal(drainProofs.length,2,'volume replay uses the healthy step and completion, excluding the refused scope');
    for(let i=0;i<1002;i++) {
      const original=drainProofs[i%2].e.fact;
      await persistCloudDependencyEvidence(makeDependencyFact({kind:'inngest',detail:{...original.detail,run_id:'volume-'+Math.floor(i/2)}}));
    }
    assert.equal((await workerProof()).status,'verified','daily proof survives busy minute worker within its own validity');
    for(let i=0;i<1001;i++)await persistCloudDependencyEvidence(makeDependencyFact({kind:'inngest',detail:{outcome:'worker_failed',function_id:'parse-document',run_id:'unrelated-volume-'+i}}));
    assert.equal((await workerProof()).status,'verified','unrelated function failures cannot evict or taint required proofs');
  }
  await persistCloudDependencyEvidence(makeDependencyFact({kind:'inngest',detail:{outcome:'worker_failed',function_id:'convergence-metrics-daily',run_id:'required-worker-failure'}}));
  const failedWorker=(await read())[1];assert.equal(failedWorker.status,'PASS','v7: a worker failure is a receipt, never the check');
  assert.equal(failedWorker.detail.execution_proof.status,'failed');
  assert.deepEqual(failedWorker.detail.execution_proof.workers.map(w=>[w.function_id,w.status]),[['convergence-metrics-daily','failed'],['document-terminal-drain','verified']]);
  assert.deepEqual(failedWorker.detail.proofs.map(p=>p.function_id),['document-terminal-drain'],'latest failure suppresses only its own prior success');
  const recovery=await invoke('convergence-metrics-daily',{step:'sample',runId:'worker-recovery'});assert.equal(recovery.status,206);
  await invoke('convergence-metrics-daily',{step:'complete',runId:'worker-recovery',steps:{[hash('sample')]:{type:'data',data:recovery.body[0].data}}});
  assert.equal((await workerProof()).status,'verified','new authenticated execution closes its own failure');
  const facts=await pool.query("select certificate->'dependency_evidence' e from runtime_host_readiness_attempts where certificate_version='donna.cloud-dependency-evidence.v1'");
  assert.ok(facts.rows.every(r=>verifyDependencyFact('inngest',r.e,resolveRuntimeHostIdentity(),new Date().toISOString())),'HMAC survives JSONB ordering');
  assert.equal(Number((await pool.query('select count(*) n from runtime_host_readiness')).rows[0].n),0,'dependency facts never project readiness');
  for(const kind of ['openai','anthropic'])await persistCloudDependencyEvidence(makeDependencyFact({kind,detail:{outcome:'response_received',response_id:'fixture',response_model:'fixture',input_tokens:1,output_tokens:1}}));
  assert.equal((await providerProof()).status,'verified');
  await persistCloudDependencyEvidence(makeDependencyFact({kind:'openai',detail:{outcome:'provider_failed',error_code:'PROVIDER_UNAUTHORIZED'}}));
  const failedProvider=await providerProof();
  assert.equal(failedProvider.status,'failed','latest failure wins over older success');
  assert.equal(failedProvider.providers.find(p=>p.kind==='openai').error_code,'PROVIDER_UNAUTHORIZED');
  assert.equal((await read())[0].status,'PASS','v7: a provider failure is a receipt, never the check');
  const sequence=(await pool.query('select attempt_sequence from runtime_host_readiness_attempts order by attempt_sequence')).rows.map(r=>r.attempt_sequence);
  assert.equal(new Set(sequence).size,sequence.length);

  // The operator and byte-admission proof uses the real provisioning, config,
  // certificate, admission and document writers. Cloud storage is a local HTTP
  // fixture and platform attestation uses an ephemeral test key.
  const {reviewCloudPilotOperations,enableCloudPilotProcessing,runCloudPilotDependencyProbes}=await import('./cloudPilotOperations.js');
  const {observeCloudHostCertificateA}=await import('./cloudHostCertificateA.js');
  const {persistHostReadinessAttempt,hostReadinessIsMutationReady}=await import('./runtimeReadiness.js');
  const {createCloudPilotUpload}=await import('./cloudEvidenceIntake.js');
  const {registerDocumentInDb}=await import('./parseDocumentsDb.js');
  const {fetchEvidenceObjectBytes,createEvidenceSignedUploadUrl}=await import('./evidenceStorage.js');
  const {CLOUD_ATTESTATION_KEY,CLOUD_ATTESTATION_VERSION,attestationBytes}=await import('./cloudDeploymentAttestation.js');
  const {cloudSchemaCatalogDigest,CLOUD_SCHEMA_QUALIFICATION_VERSION}=await import('./cloudSchemaQualification.js');
  const {readCloudSchemaCatalog}=await import('../../scripts/qualify_cloud_schema.js');
  const scope={firmId:'cloud-probe-firm',clientId,principal:{principalType:'firm_member',principalId:'probe-operator'}};
  const firstReview=await reviewCloudPilotOperations(scope);assert.equal(firstReview.host_ready,false);assert.equal(firstReview.entity_ready,false);
  await assert.rejects(enableCloudPilotProcessing(scope,{confirmed:true,reviewDigest:firstReview.review_digest}),{code:'PILOT_HOST_NOT_READY'});
  await assert.rejects(reviewCloudPilotOperations({...scope,clientId:'missing'}),{code:'PILOT_OPERATOR_REQUIRED'});
  await assert.rejects(reviewCloudPilotOperations({...scope,principal:{principalType:'firm_collaborator',principalId:'probe-owner'}}),{code:'PILOT_OPERATOR_REQUIRED'});
  await assert.rejects(createCloudPilotUpload({...scope,filename:'fixture.csv',bucket:'donna-evidence',checksum:'a'.repeat(64),size:3,mimeType:'text/csv'}),{code:'PILOT_PROCESSING_NOT_ENROLLED'});
  const files=new Map();let pauseRead=null;
  storageServer=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://fixture').pathname;
    if(req.method==='POST'&&path.startsWith('/storage/v1/object/upload/sign/')){
      const key=decodeURIComponent(path.slice('/storage/v1/object/upload/sign/'.length));
      res.setHeader('content-type','application/json');res.end(JSON.stringify({url:`http://127.0.0.1:${storageServer.address().port}/put/${encodeURIComponent(key)}`}));return;
    }
    if(req.method==='PUT'&&path.startsWith('/put/')){
      const key=decodeURIComponent(path.slice(5)),chunks=[];for await(const chunk of req)chunks.push(chunk);
      if(files.has(key)){res.statusCode=409;res.end('immutable');return;}files.set(key,Buffer.concat(chunks));res.end('{}');return;
    }
    if(req.method==='GET'&&path.startsWith('/storage/v1/object/')){
      if(pauseRead&&decodeURIComponent(path).endsWith(pauseRead.key)){pauseRead.started();await pauseRead.wait;}
      const value=files.get(decodeURIComponent(path.slice('/storage/v1/object/'.length)));res.statusCode=value?200:404;res.end(value||'missing');return;
    }
    if(req.method==='POST'&&path==='/storage/v1/object/list/donna-evidence'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const {prefix}=JSON.parse(Buffer.concat(chunks));
      res.setHeader('content-type','application/json');res.end(JSON.stringify([...files.keys()].filter(k=>k.startsWith('donna-evidence/'+prefix)).map(k=>({id:k,name:k.slice(('donna-evidence/'+prefix).length),metadata:{size:files.get(k).length}}))));return;
    }
    if(req.method==='DELETE'&&path==='/storage/v1/object/donna-evidence'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const {prefixes}=JSON.parse(Buffer.concat(chunks));
      res.setHeader('content-type','application/json');res.end(JSON.stringify(prefixes.filter(k=>files.delete('donna-evidence/'+k)).map(name=>({name}))));return;
    }
    res.statusCode=404;res.end('unsupported fixture request');
  });await new Promise(r=>storageServer.listen(0,'127.0.0.1',r));
  const fixtureFetch=globalThis.fetch;
  globalThis.fetch=async(target,init)=>{
    const u=new URL(String(target));if(u.hostname==='storage.invalid')return originalFetch(`http://127.0.0.1:${storageServer.address().port}${u.pathname}${u.search}`,init);
    if(u.hostname==='127.0.0.1'&&Number(u.port)===storageServer.address().port)return originalFetch(target,init);
    return fixtureFetch(target,init);
  };
  // Actual llmCall -> provider provenance -> immutable PostgreSQL evidence.
  // The explicit fixture response has the real endpoint shape, never a caller
  // PASS. Old reservations expire without rotating the provider or deployment.
  const storageFetch=globalThis.fetch;const providerCalls=[];
  globalThis.fetch=async(target,init)=>{
    const u=new URL(String(target));
    if(u.hostname==='api.openai.com'){
      providerCalls.push(JSON.parse(init.body));const r=new Response(JSON.stringify({id:'fixture-provider-response',model:'fixture-provider-model',status:'completed',output:[],usage:{input_tokens:3,output_tokens:1}}));
      Object.defineProperty(r,'url',{value:String(target)});return r;
    }
    if(u.hostname==='inn.gs')return new Response(JSON.stringify({ids:['fixture-probe-event'],status:200}));
    return storageFetch(target,init);
  };
  for(let i=0;i<3;i++)await pool.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata,created_at)
    values($1,$2,'firm_member','probe-operator','pilot.provider_probe.started','provider_probe',$3,$4::jsonb,clock_timestamp()-interval '5 minutes'+interval '1 second')`,
    [scope.firmId,clientId,'historical-failed-'+i,JSON.stringify({host_generation:resolveRuntimeHostIdentity().generation_digest,credential_generation:cloudCredentialGeneration('openai'),provider:'openai'})]);
  const capped=await runCloudPilotDependencyProbes(scope);assert.equal(capped.providers.find(p=>p.provider==='openai').code,'PILOT_PROVIDER_PROBE_LIMIT');assert.equal(providerCalls.length,0);
  await new Promise(r=>setTimeout(r,1100));
  const recovered=await runCloudPilotDependencyProbes(scope);assert.equal(recovered.providers.find(p=>p.provider==='openai').status,'response_observed',JSON.stringify(recovered));
  assert.equal(providerCalls.length,1);assert.equal(providerCalls[0].max_output_tokens,128);
  assert.equal((await providerProof()).status,'verified');
  const pair=generateKeyPairSync('ed25519');process.env.DONNA_HOST_ATTESTATION_PUBLIC_KEY=pair.publicKey.export({type:'spki',format:'pem'});process.env.DONNA_HOST_ATTESTATION_TEAM_ID='team_fixture';
  t.after(()=>{delete process.env.DONNA_HOST_ATTESTATION_PUBLIC_KEY;delete process.env.DONNA_HOST_ATTESTATION_TEAM_ID;});
  const issued=new Date().toISOString();
  // This explicitly fixture-signed qualification tests runtime binding. The
  // separate qualifier lifecycle executes the real restore and invariants.
  const attested={version:CLOUD_ATTESTATION_VERSION,platform:'vercel',platform_state:'READY',deployment_id:env.VERCEL_DEPLOYMENT_ID,
    project_id:env.VERCEL_PROJECT_ID,team_id:'team_fixture',environment:'preview',source_commit:env.VERCEL_GIT_COMMIT_SHA,
    platform_response_digest:'synthetic-platform-response',issued_at:issued,expires_at:new Date(Date.now()+300000).toISOString(),
    schema_qualification:{version:CLOUD_SCHEMA_QUALIFICATION_VERSION,status:'PASS',catalog_digest:cloudSchemaCatalogDigest(await readCloudSchemaCatalog(pool))}};
  const artifact={payload:attested,signature:sign(null,attestationBytes(attested),pair.privateKey).toString('base64')};
  files.set('donna-evidence/'+CLOUD_ATTESTATION_KEY,Buffer.from(JSON.stringify(artifact)));
  await persistCloudDependencyEvidence(makeDependencyFact({kind:'openai',detail:{outcome:'response_received',response_id:'fixture',response_model:'fixture',input_tokens:1,output_tokens:1}}));
  // A prior enable can leave all reviewed flags committed before Entity B
  // succeeds. Signed transport must execute without admitting that entity.
  const {setClientFlagStage:stageBootFlag}=await import('./clientConfig.js');
  for(const change of firstReview.changes) await stageBootFlag(pool,{firmId:scope.firmId,clientId,
    flagKey:change.flag_key,stage:change.stage,source:change.source,reason:change.reason,actorType:'firm_member',actorId:'probe-operator'});
  assert.equal(firstReview.changes.length,15);
  assert.ok(firstReview.changes.some(change=>change.flag_key==='JEV_RECONCILIATION' && change.stage==='canary'));
  const held=await invoke('document-terminal-drain',{step:'sweep',runId:'staged-before-host'});
  const heldSummary=held.body[0].data;
  assert.deepEqual(heldSummary.errors,[],JSON.stringify(heldSummary));
  assert.equal(heldSummary.clients_enrolled,1);assert.equal(heldSummary.clients_deferred,1);
  assert.equal(heldSummary.clients_evaluated,0);assert.equal(heldSummary.documents_evaluated,0);
  assert.equal(heldSummary.readiness_deferrals[0].boundary,'worker_discovery');
  assert.ok(heldSummary.readiness_deferrals[0].reason_code);
  await invoke('document-terminal-drain',{step:'complete',runId:'staged-before-host',steps:{[hash('sweep')]:{type:'data',data:heldSummary}}});
  assert.equal((await workerProof()).status,'verified','held entity cannot poison healthy authenticated transport');
  assert.equal(Number((await pool.query('select count(*) n from documents')).rows[0].n),0);
  assert.equal(Number((await pool.query('select count(*) n from ledger_journals')).rows[0].n),0);
  const certificate=await observeCloudHostCertificateA({manifest:registeredInngestFunctions,query:pool.query.bind(pool),storageOps:{
    createUpload:createEvidenceSignedUploadUrl,read:fetchEvidenceObjectBytes,
    list:async({bucket,prefix})=>[...files.keys()].filter(k=>k.startsWith(bucket+'/'+prefix)).map(k=>({name:k.slice(bucket.length+1)})),
    delete:async({bucket,keys})=>({deleted:keys.filter(k=>files.delete(bucket+'/'+k)).length,errors:[]})}});
  // The cloud host certificate passes only on PostgreSQL 17, the hosted
  // database's major version (CLOUD_POSTGRES_MAJOR in cloudHostCertificateA.js;
  // restored-schema parity is qualified against 17). Everything below needs a
  // PASS certificate, so on any other major (CI and the desktop pin 16) it
  // cannot run. Prove the refusal, then skip visibly instead of passing silently.
  const serverMajor=Math.floor(Number((await pool.query("show server_version_num")).rows[0].server_version_num)/10000);
  if (serverMajor!==17) {
    assert.equal(certificate.status,'INCOMPLETE');assert.equal(certificate.checks.find(c=>c.id==='database_schema').detail.reason,'cloud_postgresql_17_compatibility_required');
    t.skip(`PostgreSQL ${serverMajor}: the post-certificate proofs (host PASS, pilot enablement, held-match portal reply, held rows confirmed together, deployment readiness v7) need PostgreSQL 17; set DONNA_SCHEMA_PROOF_PG17_URL to run them`);
    return;
  }
  assert.equal(certificate.status,'PASS',JSON.stringify(certificate.checks.filter(c=>c.status!=='PASS')));
  assert.equal(hostReadinessIsMutationReady({certificate}),true);
  assert.equal(certificate.effective_valid_until,attested.expires_at);
  assert.equal(hostReadinessIsMutationReady({certificate,asOf:attested.expires_at}),false);
  await persistHostReadinessAttempt({withFirmDbClientFn:async work=>{const c=await pool.connect();try{return await work(c);}finally{c.release();}},certificate});
  const review=await reviewCloudPilotOperations(scope);assert.equal(review.host_ready,true);
  assert.equal(review.reasoning_ownership.default_unchanged,true);
  assert.equal(review.reasoning_ownership.provider_proven,true);
  assert.equal(review.reasoning_ownership.proposed.lane,'reconciliation_reasoning');
  const priorMatcherOverride=process.env.RECONCILIATION_MATCHER_LLM_MODEL;
  try {
    process.env.RECONCILIATION_MATCHER_LLM_MODEL='unqualified-fixture';
    const changedDefault=await reviewCloudPilotOperations(scope);
    assert.equal(changedDefault.reasoning_ownership.eligible,false);
    await assert.rejects(enableCloudPilotProcessing(scope,{confirmed:true,reviewDigest:changedDefault.review_digest}),{code:'PILOT_RECONCILE_DEFAULT_UNPROVEN'});
  } finally {if(priorMatcherOverride===undefined)delete process.env.RECONCILIATION_MATCHER_LLM_MODEL;else process.env.RECONCILIATION_MATCHER_LLM_MODEL=priorMatcherOverride;}

  // The policy joins processing staging's transaction: a failed receipt must
  // leave neither a seat nor a partial configuration graduation behind.
  await pool.query(`create function fixture_policy_audit_fail() returns trigger language plpgsql as $$ begin
    if new.action='model_lane.policy_set' then raise exception 'fixture policy audit failure'; end if; return new; end $$;
    create trigger fixture_policy_audit_fail before insert on audit_events for each row execute function fixture_policy_audit_fail()`);
  await assert.rejects(enableCloudPilotProcessing(scope,{confirmed:true,reviewDigest:review.review_digest}),/fixture policy audit failure/);
  assert.equal((await pool.query('select count(*)::int n from model_lane_policy')).rows[0].n,0);
  assert.equal((await pool.query("select count(*)::int n from audit_events where action='pilot.processing.staged'")).rows[0].n,0);
  await pool.query('drop trigger fixture_policy_audit_fail on audit_events;drop function fixture_policy_audit_fail()');

  await assert.rejects(enableCloudPilotProcessing(scope,{confirmed:true,reviewDigest:'stale'}),{code:'PILOT_PROCESSING_REVIEW_STALE'});
  const enabled=await enableCloudPilotProcessing(scope,{confirmed:true,reviewDigest:review.review_digest});
  assert.equal(enabled.entity_state,'ready',JSON.stringify(enabled));
  const ready=await reviewCloudPilotOperations(scope);assert.equal(ready.entity_ready,true,JSON.stringify(ready));
  assert.equal(ready.reasoning_ownership.proposed,null);
  assert.equal(ready.reasoning_ownership.seats.length,1);
  assert.equal(ready.reasoning_ownership.seats[0].client_id,clientId);
  assert.equal(enabled.reconciliation_recovery.retired_matches,0);
  const {setLaneDecidingPolicy}=await import('./modelLanePolicy.js');
  const {DEFAULT_MODEL}=await import('./reconciliationLlmCore.js');
  const policyClient=await pool.connect();
  try {await setLaneDecidingPolicy({client:policyClient,firmId:scope.firmId,laneId:'bank_line_disposition',decidingModel:DEFAULT_MODEL,
    actorId:'probe-operator',actorType:'firm_member',reason:'Explicit inherited fixture policy'});}finally{policyClient.release();}
  const policies=async()=>(await pool.query('select row_to_json(p)::text value from model_lane_policy p order by id')).rows;
  const policiesBefore=await policies();
  await pool.query("insert into transactions(id,firm_id,client_id,description,money_out,currency) values('fixture-line',$1,$2,'Synthetic legacy residue',1,'EUR')",[scope.firmId,clientId]);
  await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,created_by,payload)
    values('fixture-retirable',$1,$2,'fixture-line','receipt','fixture-document','suggested','system','{"source":"transaction_intel"}')`,[scope.firmId,clientId]);
  const repeatReview=await reviewCloudPilotOperations(scope);
  assert.equal(repeatReview.reasoning_ownership.proposed,null);
  assert.equal(repeatReview.reasoning_ownership.seats.length,2,'preserve both client and inherited explicit policy');
  assert.equal(repeatReview.reasoning_ownership.residue_count,1);assert.equal(repeatReview.processing_staged,false);
  const repeatEnabled=await enableCloudPilotProcessing(scope,{confirmed:true,reviewDigest:repeatReview.review_digest});
  assert.equal(repeatEnabled.entity_state,'ready');assert.equal(repeatEnabled.reconciliation_recovery.retired_matches,1);
  const retirement=(await pool.query("select actor_type,actor_id,metadata from audit_events where action='transaction_intel.stepped_aside'")).rows[0];
  assert.equal(retirement.actor_type,'firm_member');assert.equal(retirement.actor_id,'probe-operator');
  assert.equal(retirement.metadata.processing_receipt_id,repeatEnabled.receipt_id);
  assert.equal(retirement.metadata.review_digest,repeatReview.review_digest);
  assert.equal(retirement.metadata.authority_basis,'active_member_confirmed_exact_client_configuration');
  assert.deepEqual(await policies(),policiesBefore,'re-enrollment never replaces or duplicates existing seats');
  await pool.query("delete from transactions where id='fixture-line'");


  if (adopted) {
    const ownerId=(await pool.query("select id from firm_collaborators where user_id='probe-owner'")).rows[0].id;
    const ownerUpload={firmId:scope.firmId,clientId,principal:{principalType:'firm_collaborator',principalId:ownerId},
      bucket:'donna-evidence',filename:'concurrent.pdf',checksum:'a'.repeat(64),size:1,mimeType:'application/pdf'};
    // Hold actual storage signing after admission. Three sibling requests must
    // pass the same locked owner check before the first transaction commits.
    let release,entered;const hold=new Promise(r=>release=r),started=new Promise(r=>entered=r);
    const wire=globalThis.fetch;let held=false,first;
    globalThis.fetch=async(target,init)=>{
      if(!held && String(target).includes('/storage/v1/object/upload/sign/')) {held=true;entered();await hold;}
      return wire(target,init);
    };
    try {
      first=createCloudPilotUpload(ownerUpload);
      first.catch(()=>entered());
      await started;
      const siblings=await Promise.all([1,2,3].map(n=>createCloudPilotUpload({...ownerUpload,filename:`concurrent-${n}.pdf`})));
      assert.equal(siblings.length,3);assert.ok(siblings.every(row=>row.intake_state==='quarantined'));
      // Read admission still fences real company edits while signing is in
      // flight. No lock is removed and no ownership predicate is weakened.
      const editor=await pool.connect();
      try {
        await editor.query('begin');await editor.query("set local lock_timeout='100ms'");
        await assert.rejects(editor.query("update clients set company_name='Racing correction' where id=$1",[clientId]),{code:'55P03'});
      } finally {await editor.query('rollback');editor.release();}
    } finally {release();globalThis.fetch=wire;}
    assert.equal((await first).intake_state,'quarantined');
    assert.equal(Number((await pool.query("select count(*) n from audit_events where action='pilot.evidence_upload.quarantined'")).rows[0].n),4);
    // A true competing authority write retains its root cause and rolls back
    // cleanly. Previously 55P03 was swallowed and the refusal audit threw25P02.
    for(const [sql,params] of [
      ['select id from clients where id=$1 for update',[clientId]],
      ['select id from firm_collaborators where id=$1 for update',[ownerId]],
      ['select id from client_assignments where client_id=$1 for update',[clientId]],
      ['select id from firm_members where id=$1 for update',['probe-operator']]
    ]) {
      const writer=await pool.connect();const auditBefore=(await pool.query('select count(*)::integer n from audit_events')).rows[0].n;
      try {
        await writer.query('begin');await writer.query(sql,params);
        await assert.rejects(createCloudPilotUpload(ownerUpload),{code:'55P03'},sql);
      } finally {await writer.query('rollback');writer.release();}
      assert.equal((await pool.query('select count(*)::integer n from audit_events')).rows[0].n,auditBefore,'no false invalid-adoption receipt or quarantined intent survives');
    }
    assert.equal((await createCloudPilotUpload({...ownerUpload,filename:'contention-retry.pdf'})).intake_state,'quarantined');
    assert.equal((await reviewCloudPilotOperations(scope)).entity_ready,true,'contention never revokes adoption');
  }
  // A new deployment retains all flags and the previously ready entity.
  // Transport can prove itself before renewed Host A permits any entity work.
  process.env.VERCEL_DEPLOYMENT_ID='dpl_redeployed';process.env.VERCEL_GIT_COMMIT_SHA='b'.repeat(40);
  attested.deployment_id=process.env.VERCEL_DEPLOYMENT_ID;attested.source_commit=process.env.VERCEL_GIT_COMMIT_SHA;
  files.set('donna-evidence/'+CLOUD_ATTESTATION_KEY,Buffer.from(JSON.stringify({payload:attested,signature:sign(null,attestationBytes(attested),pair.privateKey).toString('base64')})));
  const priorSaga=(await pool.query('select saga_id,host_compatibility_digest from entity_readiness_sagas where client_id=$1',[clientId])).rows[0];
  const flagsBefore=(await pool.query('select flag_key,stage,source,reason from client_capability_config where client_id=$1 and valid_to is null order by flag_key',[clientId])).rows;
  assert.equal((await reviewCloudPilotOperations(scope)).entity_ready,false);
  for(const [functionId,step]of [['convergence-metrics-daily','sample'],['document-terminal-drain','sweep']]) {
    const runId='redeploy-'+functionId;const executed=await invoke(functionId,{step,runId});const output=executed.body[0].data;
    assert.deepEqual(output.errors,[],JSON.stringify(output));
    if(functionId==='document-terminal-drain') {assert.equal(output.clients_deferred,1);assert.equal(output.clients_evaluated,0);assert.equal(output.documents_evaluated,0);assert.ok(output.readiness_deferrals[0].entity_receipt_ref);}
    await invoke(functionId,{step:'complete',runId,steps:{[hash(step)]:{type:'data',data:output}}});
  }
  // A real database failure at this same pre-work boundary remains negative.
  const originalQuery=pg.Client.prototype.query;
  pg.Client.prototype.query=function(sql,...rest){if(typeof sql==='string'&&sql.includes('select flag_key, stage, source, reason, client_id'))throw Object.assign(new Error('synthetic database connection failure'),{code:'08006'});return originalQuery.call(this,sql,...rest);};
  try {
    const failed=await invoke('document-terminal-drain',{step:'sweep',runId:'pre-work-db-failure'});
    // FI-01: the failed sweep is a failed step, not data that reads as done.
    assert.equal(failed.body[0].op,'StepFailed',JSON.stringify(failed.body));
    assert.match(failed.body[0].error.message,/Document terminal drain failed .*synthetic database connection failure/);
    assert.equal((await workerProof()).status,'failed','genuine database failure cannot certify transport');
  } finally {pg.Client.prototype.query=originalQuery;}
  const recoveredDrain=await invoke('document-terminal-drain',{step:'sweep',runId:'db-recovered-deferred'});
  assert.equal(recoveredDrain.body[0].data.clients_deferred,1);assert.deepEqual(recoveredDrain.body[0].data.errors,[]);
  await invoke('document-terminal-drain',{step:'complete',runId:'db-recovered-deferred',steps:{[hash('sweep')]:{type:'data',data:recoveredDrain.body[0].data}}});
  assert.equal((await workerProof()).status,'verified');assert.equal((await reviewCloudPilotOperations(scope)).entity_ready,false);
  for(const kind of ['openai','anthropic'])await persistCloudDependencyEvidence(makeDependencyFact({kind,detail:{outcome:'response_received',response_id:'redeploy-fixture',response_model:'fixture',input_tokens:1,output_tokens:1}}));
  const {renewCloudHostReadinessIfDue}=await import('./cloudRuntimeReadiness.js');
  // The real cloud has network latency on every SQL roundtrip. Preserve the
  // actual 15-second cancellation budget while observing the full schema.
  const latencyQuery=pg.Client.prototype.query;let renewalQueries=0;
  const renewalStarted=performance.now();let renewed;
  pg.Client.prototype.query=async function(...args){renewalQueries++;await new Promise(resolve=>setTimeout(resolve,90));return latencyQuery.apply(this,args);};
  try {renewed=await renewCloudHostReadinessIfDue();} finally {pg.Client.prototype.query=latencyQuery;}
  assert.equal(renewed.status,'PASS',JSON.stringify(renewed));
  assert.ok(renewalQueries<80, `full renewal used ${renewalQueries} SQL roundtrips`);
  console.info('cloud full-schema renewal latency proof', {queries:renewalQueries,latency_ms:90,elapsed_ms:Math.round(performance.now()-renewalStarted)});

  assert.equal((await reviewCloudPilotOperations(scope)).entity_ready,true,'host renewal heals the same staged entity after deployment replacement');
  const {healTargetedEntityReadiness,readCurrentHostCertificateWithClient,listTargetedEntityReadinessRecoveryCandidates}=await import('./runtimeReadiness.js');
  const withTestClient=async work=>{const c=await pool.connect();try{return await work(c);}finally{c.release();}};
  const attempts=async()=>Number((await pool.query("select count(*) n from audit_events where client_id=$1 and action='entity.provisioning.attempt'",[clientId])).rows[0].n);
  const attemptsAfterRenewal=await attempts();
  assert.equal((await renewCloudHostReadinessIfDue()).reason,'renewal_not_due');
  const renewedHost=await readCurrentHostCertificateWithClient(pool);
  // Compare the full certificate bytes with the former per-table count query
  // strategy against the same real persisted inventory, including its zeros.
  const {observeEntityCertificateB}=await import('./entityCertificateB.js');
  const countInventory=(await pool.query(`select c.table_name,exists(select 1 from information_schema.columns f where f.table_schema='public' and f.table_name=c.table_name and f.column_name='firm_id') has_firm_id from information_schema.columns c where c.table_schema='public' and c.column_name='client_id' order by c.table_name`)).rows;
  assert.ok(countInventory.length>=140,'full migrated schema is exercised');
  const legacyCounts=[];
  for(const table of countInventory){assert.match(table.table_name,/^[a-z_][a-z0-9_]*$/);const result=await pool.query(`select count(*)::integer as count from "${table.table_name}" where client_id=$1${table.has_firm_id?' and firm_id=$2':''}`,table.has_firm_id?[clientId,scope.firmId]:[clientId]);legacyCounts.push({table_name:table.table_name,count:result.rows[0].count});}
  const profileId=(await pool.query('select admitted_profile_id from entity_readiness_sagas where client_id=$1',[clientId])).rows[0].admitted_profile_id;
  const certificateArgs={firmId:scope.firmId,clientId,profileId,hostCertificate:renewedHost,compatibilityScope:'current_generation_compatibility',observedAt:new Date().toISOString()};
  const actualReceipt=await observeEntityCertificateB({...certificateArgs,query:pool.query.bind(pool)});
  const legacyReceipt=await observeEntityCertificateB({...certificateArgs,query:(sql,params)=>sql.includes('::text as table_name, count(*)::integer as count from')?Promise.resolve({rows:legacyCounts}):pool.query(sql,params)});
  assert.equal(actualReceipt.status,'PASS');assert.equal(JSON.stringify(actualReceipt),JSON.stringify(legacyReceipt),'batched counts preserve the full certificate and digest byte-for-byte');

  await healTargetedEntityReadiness({withFirmDbClientFn:withTestClient,renewedCloudHostCompatibilityDigest:renewedHost.compatibility_digest});
  assert.equal(await attempts(),attemptsAfterRenewal,'same-host recovery never mints another entity attempt');
  const discoveryArgs={withFirmDbClientFn:withTestClient,renewedCloudHostCompatibilityDigest:priorSaga.host_compatibility_digest};
  assert.equal((await listTargetedEntityReadinessRecoveryCandidates(discoveryArgs)).length,1);
  assert.equal((await listTargetedEntityReadinessRecoveryCandidates({withFirmDbClientFn:withTestClient})).length,0,'ordinary recovery does not select ready generations');
  const cloudEnv={VERCEL:process.env.VERCEL,VERCEL_PROJECT_ID:process.env.VERCEL_PROJECT_ID,VERCEL_ENV:process.env.VERCEL_ENV};
  try {for(const key of Object.keys(cloudEnv))delete process.env[key];assert.equal((await listTargetedEntityReadinessRecoveryCandidates(discoveryArgs)).length,0,'host digest cannot widen desktop recovery');}
  finally {Object.assign(process.env,cloudEnv);}

  const renewedSaga=(await pool.query('select saga_id,host_compatibility_digest from entity_readiness_sagas where client_id=$1',[clientId])).rows[0];
  assert.equal(renewedSaga.saga_id,priorSaga.saga_id);assert.notEqual(renewedSaga.host_compatibility_digest,priorSaga.host_compatibility_digest);
  assert.deepEqual((await pool.query('select flag_key,stage,source,reason from client_capability_config where client_id=$1 and valid_to is null order by flag_key',[clientId])).rows,flagsBefore);
  assert.equal(Number((await pool.query('select count(*) n from documents')).rows[0].n),0);
  assert.equal(Number((await pool.query('select count(*) n from ledger_journals')).rows[0].n),0);

  if (adopted) {
    // Regression: a real bank-statement post-parse observation is not an
    // owner/company correction. Exercise the actual leg, writer and admission.
    const {evaluateEntityReadinessAdmissionWithClient}=await import('./runtimeReadinessAdmission.js');
    const {readConsumedOwnerAdoptionWithClient,OWNER_ADOPTION_ADMISSION_DIGEST_VERSION}=await import('./existingOwnerRevalidation.js');
    const {updateClientProfileInDb}=await import('./db/clients.js');
    const admission=()=>evaluateEntityReadinessAdmissionWithClient({client:pool,firmId:scope.firmId,clientId,boundary:'worker_discovery',lock:false});
    assert.equal((await admission()).allowed,true);
    const readIdentity=async()=> (await pool.query('select company_name,jurisdiction,entity_type,profile from clients where id=$1',[clientId])).rows[0];
    const immutable=async()=> (await pool.query("select row_to_json(a)::text receipt from audit_events a where client_id=$1 and action in ('client.create','client.owner_revalidated','pilot.prepared') order by id",[clientId])).rows;
    const beforeProfile=await readIdentity(),beforeEvidence=await immutable();
    const prepared=(await pool.query("select metadata from audit_events where client_id=$1 and action='pilot.prepared'",[clientId])).rows[0].metadata;
    assert.equal(prepared.adopted_admission_digest_version,OWNER_ADOPTION_ADMISSION_DIGEST_VERSION);
    assert.match(prepared.adopted_profile_digest,/^[a-f0-9]{64}$/,'full original profile remains immutable evidence');
    const {__test__POST_PARSE_LEG_RUNNERS,buildPostParseLegPlan,buildJurisdictionSignalFromStatement}=await import('./inngest/parseDocument.js');
    assert.equal(buildJurisdictionSignalFromStatement({bankName:'OP',accountNumber:'FI2112345600000785',currency:'EUR'},'fi-statement'),null);
    const postParse={path:'statement',document_type:'bank_statement',client_id:clientId,transactions_written:0,
      detector_input:{bankName:'Barclays',accountNumber:'GB82WEST12345698765432',currency:'GBP'}};
    assert.ok(buildPostParseLegPlan(postParse).some(leg=>leg.name==='jurisdiction-signal'));
    const runSignal=documentId=>__test__POST_PARSE_LEG_RUNNERS['jurisdiction-signal']({firmId:scope.firmId,clientId,documentId,postParse});
    assert.equal((await runSignal('synthetic-foreign-account-statement')).recorded,true);
    const afterProfile=await readIdentity();
    for(const key of ['company_name','jurisdiction','entity_type'])assert.equal(afterProfile[key],beforeProfile[key]);
    const changed=Object.keys(afterProfile.profile).filter(k=>JSON.stringify(afterProfile.profile[k])!==JSON.stringify(beforeProfile.profile[k]));
    assert.deepEqual(changed.sort(),['jurisdiction_detected','jurisdiction_detected_confidence','jurisdiction_signals']);
    assert.deepEqual(await immutable(),beforeEvidence);
    assert.equal((await admission()).allowed,true,'derived statement evidence cannot revoke valid owner admission');
    await runSignal('synthetic-foreign-account-statement');
    assert.deepEqual(await readIdentity(),afterProfile,'same-document retry is still idempotent');
    await runSignal('synthetic-second-statement');
    assert.equal((await admission()).allowed,true,'a later distinct observation remains admissible');
    // Prepared form facts refuse changes before they can invalidate adoption.
    // Other business/accounting corrections still invalidate its digest.
    // Roll back each probe; never rewrite its receipt.
    for(const profilePatch of [
      {companyName:'Changed Oy'},{businessId:'9999999-2'},{incorporation_date:'2025-01-01'},
      {accountingBasis:'cash'},{accountingCurrency:'GBP'},
      {alv_registration:{status:'registered',registered_from:'2025-01-01',tax_period:'month'}},
      {verokausi:'month'},
      {cutover:{as_of:'2025-01-01'}},{opening_balances:{confirmed_zero:true}},
      {businessDescription:'Graphic design consultancy'},{future_business_fact:'changed'}
    ]) {
      const c=await pool.connect();await c.query('begin');
      try {
        const write=()=>updateClientProfileInDb({firmId:scope.firmId,clientId,actorId:'probe-operator',profilePatch,dbClient:c,manageTransaction:false});
        if (['businessId','incorporation_date','alv_registration','verokausi'].some(key=>Object.hasOwn(profilePatch,key))) {
          const profileBefore=(await c.query('select profile from clients where id=$1',[clientId])).rows[0].profile;
          await assert.rejects(write,{code:'FI_PROFILE_PILOT_PREPARED'},JSON.stringify(profilePatch));
          assert.deepEqual((await c.query('select profile from clients where id=$1',[clientId])).rows[0].profile,profileBefore);
          await readConsumedOwnerAdoptionWithClient(c,{firmId:scope.firmId,clientId});
        } else {
          await write();
          await assert.rejects(readConsumedOwnerAdoptionWithClient(c,{firmId:scope.firmId,clientId}),{code:'OWNER_REVALIDATION_CHANGED'},JSON.stringify(profilePatch));
        }
      } finally {await c.query('rollback');c.release();}
    }
    await assert.rejects(updateClientProfileInDb({firmId:scope.firmId,clientId,actorId:'probe-operator',profilePatch:{jurisdiction_detected:'gb'}}),{statusCode:400});
    assert.deepEqual(await immutable(),beforeEvidence);
    assert.equal((await admission()).allowed,true,'rolled-back corrections leave the real generation ready');
  }
  const bytes=Buffer.from('fixture-private-bytes'),checksum=createHash('sha256').update(bytes).digest('hex');
  const args={...scope,bucket:'donna-evidence',filename:'fixture.csv',checksum,size:bytes.length,mimeType:'text/csv'};
  const signedUpload=await createCloudPilotUpload(args);assert.equal(signedUpload.intake_state,'quarantined');
  assert.equal((await originalFetch(signedUpload.signed_url,{method:'PUT',body:bytes})).status,200);
  assert.equal((await originalFetch(signedUpload.signed_url,{method:'PUT',body:Buffer.from('different')})).status,409);
  const document={id:'cloud-byte-proof',client_id:clientId,filename:'fixture.csv',document_type:'bank_statement',storage_provider:'supabase_storage',
    storage_bucket:'donna-evidence',storage_object_key:signedUpload.key,checksum_sha256:checksum,file_size:bytes.length,mime_type:'text/csv'};
  await assert.rejects(registerDocumentInDb({firmId:scope.firmId,document,uploadPrincipal:{principalType:'firm_member',principalId:'another'}}),{code:'PILOT_UPLOAD_INTENT_MISMATCH'});
  const admittedDeploymentId=process.env.VERCEL_DEPLOYMENT_ID;
  process.env.VERCEL_DEPLOYMENT_ID='rotated';
  await assert.rejects(registerDocumentInDb({firmId:scope.firmId,document,uploadPrincipal:scope.principal}),{code:'PILOT_UPLOAD_GENERATION_CHANGED'});
  process.env.VERCEL_DEPLOYMENT_ID=admittedDeploymentId;
  assert.equal(Number((await pool.query("select count(*) n from documents where id='cloud-byte-proof'")).rows[0].n),0);
  await pool.query("update firm_members set status='inactive' where id='probe-operator'");
  await assert.rejects(registerDocumentInDb({firmId:scope.firmId,document,uploadPrincipal:scope.principal}),{code:adopted?'ENTITY_READINESS_ADMISSION_BLOCKED':'PILOT_UPLOAD_PRINCIPAL_REVOKED'});
  await pool.query("update firm_members set status='active' where id='probe-operator'");
  // Both mounted upload transports send metadata inside file_storage.
  document.file_storage={size:document.file_size,mime_type:document.mime_type};delete document.file_size;delete document.mime_type;
  // Revocation wins while bytes are still in flight; no source-created saga
  // invalidation is required to deny a different operator at the write.
  let startedRead,finishRead;
  const started=new Promise(r=>startedRead=r),wait=new Promise(r=>finishRead=r);
  pauseRead={key:signedUpload.key,started:startedRead,wait};
  const inFlight=registerDocumentInDb({firmId:scope.firmId,document,uploadPrincipal:scope.principal});
  const refused=assert.rejects(inFlight,{code:adopted?'ENTITY_READINESS_ADMISSION_BLOCKED':'PILOT_UPLOAD_PRINCIPAL_REVOKED'});
  await started;await pool.query("update firm_members set status='inactive' where id='probe-operator'");
  finishRead();await refused;pauseRead=null;
  await pool.query("update firm_members set status='active' where id='probe-operator'");
  const registered=await registerDocumentInDb({firmId:scope.firmId,document,uploadPrincipal:scope.principal});
  assert.equal(registered.created,true);assert.ok(registered.parse_run_id);
  assert.equal((await pool.query("select parse_status from documents where id='cloud-byte-proof'")).rows[0].parse_status,'pending');
  const runId=registered.parse_run_id;
  for (const id of [document.id,'never-created-replay-id']) {
    const replay=await registerDocumentInDb({firmId:scope.firmId,document:{...document,id},uploadPrincipal:scope.principal});
    assert.equal(replay.already_exists,true);assert.equal(replay.document.id,document.id);assert.equal(replay.parse_run_id,runId);
  }
  const actualNow=Date.now;Date.now=()=>actualNow()+11*60*1000;
  try {
    const replay=await registerDocumentInDb({firmId:scope.firmId,document:{...document,id:'expired-noop'},uploadPrincipal:scope.principal});
    assert.equal(replay.document.id,document.id);assert.equal(replay.already_exists,true);
  } finally {Date.now=actualNow;}
  assert.equal(Number((await pool.query("select count(*) n from documents where id='never-created-replay-id'")).rows[0].n),0);
  assert.equal(Number((await pool.query("select count(*) n from audit_events where action='pilot.evidence_upload.released'")).rows[0].n),1);
  assert.equal(Number((await pool.query("select count(*) n from audit_events where action='document.parse.queued' and resource_id=$1",[document.id])).rows[0].n),1);
  assert.equal(new Date((await pool.query('select valid_until from runtime_host_readiness')).rows[0].valid_until).toISOString(),attested.expires_at);
  if (!adopted) {
    const { provePartialUploadHttpRecovery } = await import('./testSupport/partialUploadHttpProof.js');
    await provePartialUploadHttpRecovery({ pool, clientId, firmId:scope.firmId,
      createUpload:createCloudPilotUpload, originalFetch, pause:value=>{pauseRead=value;} });
  }
  if(adopted) {
    // Actual portal persistence/build closures + actual tray + cloud signer,
    // private-byte verification and named PG registration writer. Only browser
    // compression and the HTTP boundary are adapted by this test harness.
    const {portalUploadSession}=await import('./testSupport/portalUploadSession.js');
    const tray=await import('../../src/lib/uploadTray.js');
    const previousWindow=globalThis.window;const browserStorage=new Map();
    globalThis.window={location:{pathname:'/client/synthetic'},localStorage:{getItem:key=>browserStorage.get(key)||null,setItem:(key,value)=>browserStorage.set(key,String(value)),removeItem:key=>browserStorage.delete(key)}};
    const ownerId=(await pool.query("select id from firm_collaborators where user_id='probe-owner'")).rows[0].id;
    const principal={principalType:'firm_collaborator',principalId:ownerId};
    let rejectOne=true;const sent=[],queued=[];
    const syntheticFiles=['failed-first.pdf','successful-rent.pdf'].map(name=>({name,type:'application/pdf',size:Buffer.byteLength(name),base64:Buffer.from(name).toString('base64')}));
    try {
      const {persistEvidenceFiles:persist,submitReply}=await portalUploadSession({clientId,
        resolveClientEvidenceRequest:async request=>{sent.push(request);return {};},
        uploadEvidenceObject:async({filename,base64,mimeType})=>{
          if(rejectOne && filename===syntheticFiles[0].name)throw new Error('Synthetic upload connection failure');
          const contents=Buffer.from(base64,'base64');const hash=createHash('sha256').update(contents).digest('hex');
          const signed=await createCloudPilotUpload({firmId:scope.firmId,clientId,principal,bucket:'donna-evidence',filename,checksum:hash,size:contents.length,mimeType});
          assert.equal((await originalFetch(signed.signed_url,{method:'PUT',body:contents})).status,200);
          return {provider:'supabase_storage',bucket:signed.bucket,key:signed.key,checksum_sha256:hash,size:contents.length,content_type:mimeType};
        },
        registerFirmDocuments:async({documents})=>{
          const rows=[];for(const doc of documents){const result=await registerDocumentInDb({firmId:scope.firmId,document:doc,uploadPrincipal:principal});rows.push({...result.document,parse_run_id:result.parse_run_id,parse_status:'pending'});queued.push(result);}
          return {documents:rows};
        }});
      const question={id:'synthetic-question',evidence_request_id:'synthetic-question',text:'Synthetic evidence question'};
      await assert.rejects(persist({files:syntheticFiles,question,reply:'Here are both files.'}),{code:'EVIDENCE_UPLOAD_INCOMPLETE'});
      await submitReply({files:syntheticFiles,question,reply:'Still incomplete.'});
      assert.equal(sent.length,0,'actual portal reply consumer cannot send partial evidence');
      const rows=tray.loadTrayState().batches.at(-1).rows;
      assert.equal(rows[0].upload_state,'failed');assert.match(rows[0].upload_error,/Synthetic upload connection failure/);
      assert.equal(rows[1].filename,'successful-rent.pdf');assert.ok(rows[1].document_id);assert.equal(rows[1].parse_status,'pending');
      assert.equal(rows[0].document_id,null,'the failed first row must never inherit the successful sibling identity');
      const rentId=rows[1].document_id;
      assert.equal(Number((await pool.query("select count(*) n from audit_events where action='document.parse.queued' and resource_id=$1",[rentId])).rows[0].n),1);
      rejectOne=false;await submitReply({files:syntheticFiles,question,reply:'Corrected current explanation.'});
      assert.equal(sent.length,1,'only the complete retry reaches the actual send boundary');
      assert.equal(sent[0].reply,'Corrected current explanation.','cached upload provenance never substitutes for current reply authority');
      assert.equal(sent[0].documentIds.length,2);assert.ok(sent[0].documentIds.includes(rentId));
      assert.equal(queued.length,4);assert.equal(queued.filter(row=>row.created).length,2);assert.equal(queued.at(-1).already_exists,true);
      assert.equal(Number((await pool.query("select count(*) n from audit_events where action='document.parse.queued' and resource_id=$1",[rentId])).rows[0].n),1,'retry queues no duplicate parse for the already landed sibling');
      assert.equal(Number((await pool.query("select count(*) n from documents where filename=any($1::text[])",[syntheticFiles.map(file=>file.name)])).rows[0].n),2);
    } finally {if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;}
  }
  if(adopted) {
    const {evaluateEntityReadinessAdmissionWithClient}=await import('./runtimeReadinessAdmission.js');
    const {observeEntityCertificateB}=await import('./entityCertificateB.js');
    const {readCurrentHostCertificateWithClient,healTargetedEntityReadiness}=await import('./runtimeReadiness.js');
    const {OWNER_ADOPTION_PROFILE_ID}=await import('./existingOwnerRevalidation.js');
    const saga=(await pool.query('select * from entity_readiness_sagas where firm_id=$1 and client_id=$2',[scope.firmId,clientId])).rows[0];
    assert.equal(saga.admitted_profile_id,OWNER_ADOPTION_PROFILE_ID);
    const host=await readCurrentHostCertificateWithClient(pool);
    const observe=()=>observeEntityCertificateB({query:pool.query.bind(pool),firmId:scope.firmId,clientId,profileId:OWNER_ADOPTION_PROFILE_ID,hostCertificate:host,compatibilityScope:'current_generation_compatibility'});
    const certificate=await observe();assert.equal(certificate.status,'PASS',JSON.stringify(certificate.checks));
    const birthClaim=await observeEntityCertificateB({query:pool.query.bind(pool),firmId:scope.firmId,clientId,profileId:OWNER_ADOPTION_PROFILE_ID,hostCertificate:host,compatibilityScope:'birth_residue_proof'});
    assert.ok(birthClaim.checks.find(c=>c.id==='ownership_actor').detail.failures.includes('adoption_is_not_birth_evidence'));
    const ownership=certificate.checks.find(c=>c.id==='ownership_actor');
    assert.equal(ownership.detail.initiating_principal.actor_id,'probe-owner');
    assert.equal(ownership.detail.authority_basis.operator_id,'probe-operator');
    assert.deepEqual((await pool.query("select row_to_json(a)::text value from audit_events a where action='client.create' and client_id=$1",[clientId])).rows,creationBefore);
    // The consumed proof remains valid after evidence arrives and across retry.
    const again=await enableCloudPilotProcessing(scope,{confirmed:true,reviewDigest:(await reviewCloudPilotOperations(scope)).review_digest});
    assert.equal(again.entity_state,'ready',JSON.stringify(again));
    await createCloudPilotUpload({...args,filename:'second.csv'});
    // Reproduce a crash after the reviewed configuration committed but before
    // the saga existed. The ordinary recovery clock must derive the same lane.
    const recoveryAuth={type:'supabase_user',userId:'recovery-owner',email:'recovery@fixture.invalid'};
    const recoveryClient=await selfProvisionClientWorkspace({auth:recoveryAuth,companyName:'Recovery Oy',jurisdiction:'FI',entityType:'fi-oy',deps:{createClient:({creationPrincipal,...args})=>createClientInDb(args)}});
    const recoveryReview=await selfProvisionClientWorkspace({auth:recoveryAuth,ownerRevalidation:{action:'review'}});
    await selfProvisionClientWorkspace({auth:recoveryAuth,ownerRevalidation:{action:'confirm',confirmed:true,review_digest:recoveryReview.review_digest}});
    const recoveryScope={...scope,clientId:recoveryClient.clientId};
    const preparation=await reviewFinnishHostedPilotInDb({...recoveryScope,actorId:'probe-operator'});
    await prepareFinnishHostedPilotInDb({...recoveryScope,actorId:'probe-operator',expectedClientVersion:preparation.client_version,
      profilePatch:{...setupReview.profile,companyName:'Recovery Oy',accountingCurrency:'EUR',accountingBasis:'accrual',accounting_system:'none',accounting_view:'management_books'}});
    const {setClientFlagStage}=await import('./clientConfig.js');
    for(const change of (await reviewCloudPilotOperations(recoveryScope)).changes) await setClientFlagStage(pool,{firmId:scope.firmId,clientId:recoveryClient.clientId,
      flagKey:change.flag_key,stage:change.stage,source:change.source,reason:change.reason,actorType:'firm_member',actorId:'probe-operator'});
    await healTargetedEntityReadiness({withFirmDbClientFn:async work=>{const c=await pool.connect();try{return await work(c);}finally{c.release();}}});
    const recovered=(await pool.query('select state,admitted_profile_id from entity_readiness_sagas where client_id=$1',[recoveryClient.clientId])).rows[0];
    assert.deepEqual(recovered,{state:'ready',admitted_profile_id:OWNER_ADOPTION_PROFILE_ID});
    const admissionClient=await pool.connect();
    let queryTail=Promise.resolve();
    const serialQuery=(text,params)=>{const result=queryTail.then(()=>admissionClient.query(text,params));queryTail=result.catch(()=>{});return result;};
    try {
      for(const mutation of [
        "update firm_collaborators set status='inactive' where user_id='probe-owner'",
        "update firm_collaborators set access_level='firm_wide' where user_id='probe-owner'",
        "update firm_collaborators set email='changed@fixture.invalid' where user_id='probe-owner'",
        "update client_assignments set ends_at=clock_timestamp()-interval '1 second' where client_id=$1",
        "update clients set company_name='Different company' where id=$1",
        "update clients set created_at=created_at-interval '1 day' where id=$1"
      ]) {
        await admissionClient.query('begin');
        await admissionClient.query(mutation,mutation.includes('$1')?[clientId]:[]);
        const decision=await evaluateEntityReadinessAdmissionWithClient({client:admissionClient,firmId:scope.firmId,clientId,boundary:'upload_sign'});
        assert.equal(decision.allowed,false,mutation);
        const mutated=await observeEntityCertificateB({query:serialQuery,firmId:scope.firmId,clientId,profileId:OWNER_ADOPTION_PROFILE_ID,hostCertificate:host,compatibilityScope:'current_generation_compatibility'});
        assert.equal(mutated.checks.find(c=>c.id==='ownership_actor').status,'FAIL',mutation);
        await admissionClient.query('rollback');
      }
      await admissionClient.query('begin');
      const healthy=await evaluateEntityReadinessAdmissionWithClient({client:admissionClient,firmId:scope.firmId,clientId,boundary:'document_register'});
      assert.equal(healthy.allowed,true,JSON.stringify(healthy));await admissionClient.query('commit');
    } finally {await admissionClient.query('rollback');admissionClient.release();}
    // The original certified assignment expires naturally: no row mutation,
    // no saga invalidation, but actual upload admission must refuse immediately.
    while(!(await pool.query('select ends_at<=clock_timestamp() expired from client_assignments where client_id=$1',[clientId])).rows[0].expired) await new Promise(resolve=>setTimeout(resolve,25));
    await assert.rejects(createCloudPilotUpload({...args,filename:'expired-owner.csv'}),{code:'ENTITY_READINESS_ADMISSION_BLOCKED'});
    // Revocation is visible at the real upload signer even when legacy birth
    // actor invalidation cannot identify this owner.
    await pool.query("update firm_collaborators set status='inactive' where user_id='probe-owner'");
    await assert.rejects(createCloudPilotUpload({...args,filename:'revoked.csv'}));
    const revoked=await observe();assert.equal(revoked.checks.find(c=>c.id==='ownership_actor').status,'FAIL');
    const {provisionEntityReadiness}=await import('./runtimeReadiness.js');
    const beforeRejectedRevalidation=await attempts();
    await assert.rejects(provisionEntityReadiness({withFirmDbClientFn:withTestClient,firmId:scope.firmId,clientId,
      profileId:OWNER_ADOPTION_PROFILE_ID,lifecycle:'host_generation_revalidation',compatibilityScope:'current_generation_compatibility',
      requiredEnrollmentKind:'manual_target',authorityBasis:{source:'synthetic_revalidation_defect_proof'}}),
      {code:'OWNER_REVALIDATION_IDENTITY_REQUIRED'});
    assert.equal(await attempts(),beforeRejectedRevalidation,'invalid owner cannot mint a successful revalidation');
    await assert.rejects(reviewCloudPilotOperations(scope),{code:'OWNER_REVALIDATION_IDENTITY_REQUIRED'});
    await Promise.all(streams);return;
  }
  // An engagement may expire without a database mutation or invalidation
  // trigger. The final write-time clock, not transaction-start now(), governs it.
  const assignment=(await pool.query("select principal_id from client_assignments where firm_id=$1 and client_id=$2 and principal_type='firm_collaborator' and assignment_kind='capability'",[scope.firmId,clientId])).rows[0];
  await pool.query("update client_assignments set ends_at=clock_timestamp()+interval '2 seconds' where firm_id=$1 and client_id=$2 and principal_id=$3",[scope.firmId,clientId,assignment.principal_id]);
  const retryReview=await reviewCloudPilotOperations(scope);
  const retried=await enableCloudPilotProcessing(scope,{confirmed:true,reviewDigest:retryReview.review_digest});
  assert.equal(retried.entity_state,'ready',JSON.stringify(retried));
  const ownerScope={...scope,principal:{principalType:'firm_collaborator',principalId:assignment.principal_id}};
  const ownerSigned=await createCloudPilotUpload({...args,...ownerScope});
  await originalFetch(ownerSigned.signed_url,{method:'PUT',body:bytes});
  let ownerStarted,ownerFinish;const ownerRead=new Promise(r=>ownerStarted=r),ownerWait=new Promise(r=>ownerFinish=r);
  pauseRead={key:ownerSigned.key,started:ownerStarted,wait:ownerWait};
  const expired=assert.rejects(registerDocumentInDb({firmId:scope.firmId,document:{...document,id:'expired-engagement',storage_object_key:ownerSigned.key},uploadPrincipal:ownerScope.principal}),{code:adopted?'ENTITY_READINESS_ADMISSION_BLOCKED':'PILOT_UPLOAD_PRINCIPAL_REVOKED'});
  await ownerRead;await new Promise(r=>setTimeout(r,2100));ownerFinish();await expired;pauseRead=null;
  assert.equal(Number((await pool.query("select count(*) n from documents where id='expired-engagement'")).rows[0].n),0);
  await Promise.all(streams);

  // No operator setup calls: ordinary firm creation must prepare the company.
  // This is real PG with the fixture's synthetic host/worker/storage proof.
  const freshId='fresh-finnish-firm-company';
  await createClientInDb({firmId:scope.firmId,
    profile:{id:freshId,companyName:'New Bank Statement Oy',jurisdiction:'FI',entityType:'fi-oy',defaultCurrency:'EUR'},
    creationPrincipal:{principalType:'firm_member',principalId:'probe-operator',authoritySource:'authenticated_firm_create_route'}});
  const {provisionEntityReadiness,buildHostOperationalFailureCertificate}=await import('./runtimeReadiness.js');
  const hostOutage=buildHostOperationalFailureCertificate({certificate:renewedHost,checkId:'evidence_storage',reasonCode:'fixture_storage_unavailable'});
  await persistHostReadinessAttempt({withFirmDbClientFn:withTestClient,certificate:hostOutage});
  const fresh=await provisionEntityReadiness({withFirmDbClientFn:withTestClient,firmId:scope.firmId,clientId:freshId,
    creationPath:'desktop_firm_intake',lifecycle:'cold_create',compatibilityScope:'birth_residue_proof',
    initiatingPrincipal:{actor_type:'firm_member',actor_id:'probe-operator'},
    authorityBasis:{source:'authenticated_firm_create_route',principal_id:'probe-operator'}});
  assert.equal(fresh.row.state,'failed',JSON.stringify(fresh));
  assert.equal(fresh.row.reason_code,'host_certificate_not_pass');
  // Host recovery must preserve the declared creation lane without the UI
  // supplying it again. Persist a fresh healthy host receipt through its writer.
  const {buildHostCertificateFreshness}=await import('./hostCertificateA.js');
  const {receipt_digest:priorHostDigest,...healthyHostBody}=renewedHost;
  healthyHostBody.observed_at=new Date().toISOString();
  healthyHostBody.freshness=buildHostCertificateFreshness({mintedAt:healthyHostBody.observed_at});
  await persistHostReadinessAttempt({withFirmDbClientFn:withTestClient,
    certificate:{...healthyHostBody,receipt_digest:hostDigest(healthyHostBody)}});
  await healTargetedEntityReadiness({withFirmDbClientFn:withTestClient,renewedCloudHostCompatibilityDigest:renewedHost.compatibility_digest});
  const retriedFresh=(await pool.query('select state,admitted_profile_id,reason_code from entity_readiness_sagas where firm_id=$1 and client_id=$2',[scope.firmId,freshId])).rows[0];
  assert.equal(retriedFresh.state,'ready',JSON.stringify(retriedFresh));
  assert.equal(retriedFresh.admitted_profile_id,fresh.row.admitted_profile_id);
  const freshBirth=()=>observeEntityCertificateB({query:pool.query.bind(pool),firmId:scope.firmId,clientId:freshId,
    profileId:fresh.row.admitted_profile_id,hostCertificate:renewedHost,compatibilityScope:'birth_residue_proof'});
  const policyBefore=(await pool.query('select id,reason,deciding_model from model_lane_policy where client_id=$1',[freshId])).rows[0];
  for (const field of ['reason','deciding_model']) {
    await pool.query(`update model_lane_policy set ${field}='unreceipted-policy' where id=$1`,[policyBefore.id]);
    try {
      const changed=await freshBirth();
      assert.equal(changed.checks.find(c=>c.id==='birth_residue_proof').status,'FAIL','only the exact receipted birth policy is allowed');
    } finally {await pool.query(`update model_lane_policy set ${field}=$2 where id=$1`,[policyBefore.id,policyBefore[field]]);}
  }
  const freshScope={firmId:scope.firmId,clientId:freshId,principal:scope.principal};
  const freshSigned=await createCloudPilotUpload({...args,...freshScope,filename:'fresh-company.csv'});
  assert.ok(freshSigned.signed_url);
  await originalFetch(freshSigned.signed_url,{method:'PUT',body:bytes});
  await registerDocumentInDb({firmId:scope.firmId,
    document:{...document,id:'fresh-company-evidence',client_id:freshId,storage_object_key:freshSigned.key},uploadPrincipal:scope.principal});
  assert.equal((await pool.query('select client_id from documents where id=$1',['fresh-company-evidence'])).rows[0].client_id,freshId);
  assert.equal((await pool.query('select count(*)::int n from ledger_journals where client_id=$1',[freshId])).rows[0].n,0);

  await proveHeldMatchPortalReply({pool, firmId:scope.firmId, clientId:freshId,
    actorId:'probe-operator', withClient:withTestClient, hostCertificate:renewedHost});
  await proveJevHeldPlanGaps({pool, firmId:scope.firmId, clientId:freshId, actorId:'probe-operator', withClient:withTestClient});
  await proveJevHeldPlanCompletion({pool, firmId:scope.firmId, clientId:freshId, actorId:'probe-operator', withClient:withTestClient});
  await proveJevHeldRowsConfirmedTogether({pool, firmId:scope.firmId, clientId:freshId, actorId:'probe-operator', withClient:withTestClient});

  await proveDeploymentReadinessV7({pool,scope,clientId,files,attested,pair,withTestClient,registeredInngestFunctions,
    originalFetch});
});
