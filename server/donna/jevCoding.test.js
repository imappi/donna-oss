import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suggestTransactionCoding, suggestTransactionCodingBatch } from './transactionLlm.js';
import { buildJevCodingRequest } from './jevCoding.js';
import { jevCasePrompt, codingCaseRevision } from './jevPreview.js';
import { resolveCodingPolicy } from './codingPolicy.js';
import { __shouldAutoApplyBatchSuggestion } from './db/coding.js';
import { buildOwnerAsk } from './codingAutoPost.js';

const args = { clientProfile: { jurisdiction: 'sg', companyName: 'Synthetic business' },
  transaction: { id: 'coding-line', description: 'Campaign services', money_out: 80, date: '2026-09-19', account_currency: 'SGD',
    matched_document: { match_status: 'auto_matched', filename: 'campaign.pdf', lines: [{ description: 'Marketing campaign', amount: 80 }] } },
  xeroAccounts: [{ name: 'Rent' }, { name: 'Marketing' }],
  clientRules: [{ status: 'active', pattern_text: 'Campaign services', notes: 'Business marketing' }],
  firmFacts: [{ scope: 'client', fact: 'Campaign services is advertising for the business.', status: 'active' }], jevEnabled: true };
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
const typedResponse = (request, choose) => ({ model: 'test-jev-served', usage: { input_tokens: 10, output_tokens: 5 },
  answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
    const keys = Object.keys(question.criteria);
    const selected = key === 'decision' ? choose(question.criteria) : key === 'materiality' ? 'normal' : keys[0];
    const probability = key === 'decision' ? 0.42 : 0.8;
    return [key, { type: 'choice', choice: selected, confidence: probability,
      probabilities: Object.fromEntries(keys.map(k => [k, k === selected ? probability : (1 - probability) / (keys.length - 1)])) }];
  })) });
const chooseMarketing = criteria => Object.keys(criteria).find(k => criteria[k].includes('to Marketing, tax treatment No GST;'));
const withKeys = async fn => {
  const saved = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, TYPESAFE_MODEL: process.env.TYPESAFE_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  Object.assign(process.env, { TYPESAFE_API_KEY: 'synthetic-test-key', TYPESAFE_MODEL: 'test-jev-requested', OPENAI_API_KEY: 'synthetic-strong-key' });
  try { await fn(); } finally { for (const [k,v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('actual coding entry selects Jev account/tax with raw low probability, full context and no strong call', () => withKeys(async () => {
  const calls = [];
  const coding = await suggestTransactionCoding({ ...args, fetchImpl: async (url, init) => {
    calls.push(String(url)); const request = JSON.parse(init.body);
    assert.match(JSON.stringify(request.state), /Campaign services is advertising/);
    assert.equal(request.state.transaction.matched_document.lines[0].description, 'Marketing campaign');
    assert.equal(request.state.activeClientRules.length, 1);
    return response(typedResponse(request, chooseMarketing));
  } });
  assert.equal(calls.length, 1); assert.match(calls[0], /typesafe/);
  assert.equal(coding.source, 'jev'); assert.equal(coding.model, 'test-jev-served');
  assert.equal(coding.proposed_account, 'Marketing'); assert.equal(coding.tax_treatment, 'No GST');
  assert.equal(coding.jev_decision.probability, 0.42); assert.equal(coding.confidence, 'low');
  assert.equal(__shouldAutoApplyBatchSuggestion(args.transaction, coding), true);
  assert.equal(__shouldAutoApplyBatchSuggestion({ money_out: 999999 }, coding), false, 'material amount boundary remains');
}));

test('specific missing owner fact terminates on Jev without a reasoning call', () => withKeys(async () => {
  let calls = 0;
  const coding = await suggestTransactionCoding({ ...args, fetchImpl: async (_, init) => { calls++; return response(typedResponse(JSON.parse(init.body), () => 'ask_business_use')); } });
  assert.equal(calls, 1); assert.equal(coding.jev_decision.terminal, 'ask_owner');
  assert.equal(coding.posting_requirement, 'owner_fact'); assert.match(coding.ask_client_question, /Campaign services:.*business use/);
  assert.equal(__shouldAutoApplyBatchSuggestion(args.transaction, coding), false);
}));

test('Jev preserves the existing payroll requirement and reuses its owner question', () => withKeys(async () => {
  const coding = await suggestTransactionCoding({ ...args,
    transaction: {...args.transaction, matched_document:{...args.transaction.matched_document, source_family:'payroll'}},
    clientProfile: { jurisdiction: 'fi', companyName: 'Synthetic Oy' },
    fetchImpl: async (_, init) => response(typedResponse(JSON.parse(init.body), () => 'ask_payroll_package')) });
  assert.equal(coding.posting_requirement, 'payroll_package');
  assert.equal(coding.evidence_required, true);
  assert.equal(__shouldAutoApplyBatchSuggestion(args.transaction, coding), false);
  const ask = buildOwnerAsk({ reason: 'coding_payroll_package', suggestion: coding, line: args.transaction });
  assert.equal(ask.evidence_type, 'payroll_package');
  assert.match(ask.question, /balanced external payroll journal/);
  assert.match(ask.question, /payslip alone/);
}));

test('only an explicit Jev reasoning choice invokes the existing strong coder and persists the handoff', () => withKeys(async () => {
  const calls = [];
  const coding = await suggestTransactionCoding({ ...args, fetchImpl: async (url, init) => {
    calls.push(String(url)); const request = JSON.parse(init.body);
    if (String(url).includes('typesafe')) return response(typedResponse(request, () => 'reasoning_judgment'));
    assert.equal(JSON.parse(request.input).jev_handoff.reason, 'reasoning_judgment');
    return response({ model: 'test-strong-served', output: [{ content: [{ text: JSON.stringify({ proposed_account: 'Marketing', tax_treatment: 'No GST', confidence: 'high', evidence_required: false, posting_requirement: 'single_account', remember_candidate: true, merchant_pattern: 'Campaign services', auto_explain_limit: 100 }) }] }] });
  } });
  assert.equal(calls.length, 2); assert.match(calls[0], /typesafe/); assert.match(calls[1], /openai/);
  assert.equal(coding.source, 'openai'); assert.equal(coding.model, 'test-strong-served');
  assert.equal(coding.decision_engine, 'strong_after_jev'); assert.equal(coding.jev_handoff.selected, 'reasoning_judgment');
  assert.equal(coding.remember_candidate, false); assert.equal(coding.merchant_pattern, '');
  assert.equal(coding.auto_explain_limit, 0, 'one-case reasoning grants no future merchant authority');
}));

test('Jev provider failure cannot become a strong-model fallback', () => withKeys(async () => {
  let calls = 0;
  const coding = await suggestTransactionCoding({ ...args, fetchImpl: async () => { calls++; return new Response('{}', { status: 503 }); } });
  assert.equal(calls, 1); assert.equal(coding.provider_failure.provider, 'typesafe'); assert.equal(coding.proposed_account, undefined);
}));

test('actual batch entry retains Jev provenance for every item and DB caller passes strict flag routing', () => withKeys(async () => {
  let calls = 0;
  const result = await suggestTransactionCodingBatch({ ...args, transactions: [args.transaction, { ...args.transaction, id: 'second' }],
    fetchImpl: async (_, init) => { calls++; return response(typedResponse(JSON.parse(init.body), chooseMarketing)); } });
  assert.equal(calls, 2); assert.equal(result.suggestions.length, 2);
  assert.ok(result.suggestions.every(s => s.source === 'jev' && s.jev_decision.probability === 0.42));
  const code = readFileSync(new URL('./db/coding.js', import.meta.url), 'utf8');
  // Both DB callers ask the one first-line question (firstLineLane.js) over the strict snapshot.
  assert.equal((code.match(/firstLineLaneDecidesWithClient\(client, \{[\s\S]{0,240}strict: true/g) || []).length, 2);
  assert.ok(!/flagKey: 'JEV_RECONCILIATION'/.test(code), 'no DB caller re-derives the rule from the flag alone');
}));

test('large vocabulary remains offered via component choices instead of hidden pruning or escalation', () => {
  const accounts = Array.from({ length: 120 }, (_, i) => `Account ${i} ${'description '.repeat(10)}`);
  const taxes = Array.from({ length: 15 }, (_, i) => `Tax ${i}`);
  const built = buildJevCodingRequest({ input: {}, accountOptions: accounts, taxOptions: taxes, instructions: 'Use supplied policy.' });
  assert.equal(built.choiceMode, 'account_tax_components');
  assert.equal(Object.keys(built.request.questions.account.criteria).length, accounts.length);
  assert.equal(Object.keys(built.request.questions.tax.criteria).length, taxes.length);
});

test('real PG: Jev-enabled coding writer applies a low-probability small spend and retains the actual receipt',
  { skip: !process.env.DONNA_PG_TEST_URL }, () => withKeys(async () => {
    const { default: pg } = await import('pg');
    const { readdir, readFile } = await import('node:fs/promises');
    const { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } = await import('./firmDb.js');
    const { batchSuggestTransactionCodingInDb } = await import('./db/coding.js');
    const name = `donna_jev_coding_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = [];
    pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    const savedFetch = globalThis.fetch;
    __setFirmDbPoolForTests(pool);
    try {
      await pool.query(`create schema storage;
        create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects (id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
      const root = new URL('../../db/migrations/', import.meta.url);
      for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
      await pool.query("insert into firms(id,name,slug) values('jev-firm','Jev Coding Test','jev-coding-test')");
      await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile)
        values('jev-company','jev-firm','Synthetic business','sg','{"jurisdiction":"sg","accounting_system":"none"}')`);
      await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('jev-enabled','jev-firm','jev-company','JEV_RECONCILIATION','auto','manual')");
      await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('trial-member','jev-firm','fixture@example.invalid','Fixture','admin','active')");
      const {enrollJevExperiment}=await import('./jevExperimentPolicy.js');
      const enrollment=await pool.connect();
      try {await enrollJevExperiment({client:enrollment,firmId:'jev-firm',clientId:'jev-company',actorId:'trial-member',authorityBasis:'Synthetic scoped coding proof',trialId:'coding-proof',expiresAt:'2100-01-01',model:process.env.TYPESAFE_MODEL});}
      finally {enrollment.release();}
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload)
        values('jev-small-spend','jev-firm','jev-company','2026-09-19','Campaign services',12,'SGD','needs_review','{"payment_method":"BANK SERVICE CHARGE","message":"Monthly service","reference":"FEE-7","counterparty":"Fixture bank"}')`);
      const calls = [];
      globalThis.fetch = async (endpoint, init) => {
        calls.push(String(endpoint));
        assert.match(String(endpoint), /api\.typesafe\.ai/, 'No legacy provider may decide this resolved case');
        const input=JSON.parse(init.body).state;
        assert.equal(input.transaction.payment_method,'BANK SERVICE CHARGE');
        assert.equal(input.transaction.case_evidence.transactions[0].payment_method,'BANK SERVICE CHARGE');
        assert.equal(input.transaction.case_evidence.transactions[0].message,'Monthly service');
        assert.equal(input.transaction.case_evidence.transactions[0].reference,'FEE-7');
        assert.equal(input.transaction.case_evidence.transactions[0].counterparty,'Fixture bank');
        return response(typedResponse(JSON.parse(init.body), chooseMarketing));
      };
      const result = await batchSuggestTransactionCodingInDb({ firmId: 'jev-firm', clientIds: ['jev-company'], limit: 1, autoApply: true });
      const row = (await pool.query("select account_code,coding_state,payload from transactions where id='jev-small-spend'")).rows[0];
      assert.ok(['applied', 'posted'].includes(row.coding_state), JSON.stringify({ state: row.coding_state, result }));
      assert.equal(row.account_code, 'Marketing');
      assert.equal(row.payload.ai_suggestion_status, 'auto_applied');
      assert.equal(row.payload.ai_suggestion.source, 'jev');
      assert.equal(row.payload.ai_suggestion.model, 'test-jev-served');
      assert.equal(row.payload.ai_suggestion.jev_decision.model, 'test-jev-served');
      assert.equal(row.payload.ai_suggestion.jev_decision.probability, 0.42);
      assert.equal(row.payload.ai_suggestion.confidence, 'low');
      assert.equal(row.payload.ai_suggestion.jev_decision.terminal, 'resolved');
      assert.equal(calls.length, 1, 'Exactly one Jev call; no GPT call');
    } finally {
      globalThis.fetch = savedFetch;
      __resetFirmDbPoolForTests();
      await pool.end(); await Promise.all(closed);
      await admin.query(`drop database "${name}"`); await admin.end();
    }
  }));


test('actual Finnish palette uses complete component choices within the provider limit; US stays joint', () => {
  for (const jurisdiction of ['fi', 'us']) {
    const policy = resolveCodingPolicy({ jurisdiction, businessDate: '2025-06-01', accountingSystem: 'none' });
    const built = buildJevCodingRequest({ input: {}, accountOptions: policy.accountOptions,
      taxOptions: policy.taxTreatmentOptions, instructions: policy.taxInstructions, model: 'synthetic-test' });
    assert.ok(Object.values(built.request.questions).every(q => Object.keys(q.criteria).length <= 255));
    if (jurisdiction === 'fi') {
      assert.ok(Object.keys(built.plans).length > 255, 'the Finnish joint question exceeds the provider limit');
      assert.equal(built.choiceMode, 'account_tax_components');
      assert.deepEqual(Object.values(built.request.questions.account.criteria), policy.accountOptions.filter(a => a !== 'Suspense'));
      assert.deepEqual(Object.values(built.request.questions.tax.criteria), policy.taxTreatmentOptions);
    } else {
      assert.equal(built.choiceMode, 'account_tax_plan');
      // 140 account/tax pairs + 9 owner questions (statement-only lines may ask
      // for the payroll package or the source document) + 3 reasoning choices.
      assert.equal(Object.keys(built.request.questions.decision.criteria).length, 149);
    }
  }
});

test('an oversized individual chart is refused before dispatch rather than silently pruned', () => {
  assert.throws(() => buildJevCodingRequest({ input: {}, accountOptions: Array.from({ length: 256 }, (_, i) => `Account ${i}`),
    taxOptions: ['No tax'], instructions: 'Use the supplied evidence.', model: 'synthetic-test' }),
  error => error.code === 'JEV_CHOICE_LIMIT' && /no choices were removed and no request was sent/.test(error.message));
});


test('large-chart coding carries full policy once across the actual request', () => {
  const policy = 'A unique complete jurisdiction policy with source authority. '.repeat(300);
  const accounts = Array.from({length:40}, (_,i)=>`Account ${i}`);
  const taxes = Array.from({length:15}, (_,i)=>`Tax ${i}`);
  const built = buildJevCodingRequest({input:{transaction:{id:'bounded-case'}},accountOptions:accounts,taxOptions:taxes,instructions:policy});
  assert.ok(built.request.state.accounting_policy.startsWith(policy));
  const requestText=JSON.stringify(built.request);
  assert.equal(requestText.split(policy).length-1,1,'no repeated policy per account/tax question');
  assert.deepEqual(Object.values(built.request.questions.account.criteria),accounts);
  assert.deepEqual(Object.values(built.request.questions.tax.criteria),taxes);
  for(const key of ['decision','account','tax']) assert.match(built.request.questions[key].instructions,/accounting_policy/);
});


test('matched processor source appears once with exact focal document and component handles', () => {
  const full={filename:'processor.pdf',document_type:'payout_statement',total_amount:120,currency:'EUR',
    parse_summary:{warnings:['Gross sales includes source VAT; financial fee exempt']},
    matched_line_id:'opaque-source-line',matched_line:{settlement_row:{gross:125,fee:5,net:120}},
    lines:[{id:'opaque-source-line',amount:120,description:'Settlement',settlement_row:{gross:125,fee:5,net:120}}]};
  const evidence={focal:{id:'candidate_2'},documents:[{id:'document_1',...full,lines:[{...full.lines[0],id:'document_1_line_1'}]}],
    matches:[{id:'match_1',bank_transaction_id:'candidate_1',matched_object_id:'wrong_document',status:'confirmed'},
      {id:'match_2',bank_transaction_id:'candidate_2',matched_object_id:'document_1',matched_line_id:'document_1_line_1',status:'auto_matched'}]};
  const input={transaction:{matched_document:full,case_evidence:evidence}};
  const built=buildJevCodingRequest({input,accountOptions:['Sales'],taxOptions:['Tax'],instructions:'Source policy'});
  assert.ok(built.actionChoices.settlement_gross,'trusted full source still builds the action');
  const projected=built.request.state.transaction.matched_document;
  assert.equal(projected.document_handle,'document_1');assert.equal(projected.matched_line_handle,'document_1_line_1');
  assert.deepEqual(projected.line_handles,[{handle:'line_1',source_line_handle:'document_1_line_1'}]);
  assert.equal(projected.lines,undefined);assert.equal(projected.parse_summary,undefined);
  assert.equal(built.request.state.transaction.case_evidence.documents[0].parse_summary.warnings[0],full.parse_summary.warnings[0]);
  assert.equal(input.transaction.matched_document,full,'trusted menu/source remains untouched');
});


test('local coding exceptions retain their cause without inventing a provider response', () => withKeys(async () => {
  let calls=0;
  const result=await suggestTransactionCoding({...args,transaction:{...args.transaction,
    case_evidence:{focal:{id:'source'},transactions:{invalid:'shape'}},
    _jevProvider:async()=>{calls++;throw Error('provider must not run');}}});
  assert.equal(calls,0);
  assert.equal(result.provider_failure.code,'JEV_CODING_FAILED');
  assert.equal(result.provider_failure.reason,'local_coding_failed');
  assert.equal(result.provider_failure.status,null);
  assert.match(result.provider_failure.message,/find is not a function/);
  assert.equal(result.proposed_account,undefined);
}));


test('a matched payment confirmation with no lines reaches the actual coding entry after case compaction', () => withKeys(async () => {
  const document={id:'source-confirmation-987654',document_type:'payment_confirmation',parse_status:'completed',total_amount:80,currency:'SGD',lines:[]};
  const evidence=jevCasePrompt({scope:{firm_id:'firm',client_id:'client'},focal:{id:'payment'},documents:[document],
    transactions:[{id:'payment',money_out:80}],matches:[{id:'match',bank_transaction_id:'payment',matched_object_id:'source-confirmation-987654',status:'suggested'}],
    owner_replies:[],obligations:[],postings:[]});
  assert.equal(evidence.documents[0].lines,undefined,'empty-container compaction is the real source shape');
  let calls=0;
  const result=await suggestTransactionCoding({...args,transaction:{...args.transaction,matched_document:{...document,match_status:'suggested'},case_evidence:evidence},
    fetchImpl:async(_,init)=>{calls++;const request=JSON.parse(init.body);
      assert.deepEqual(request.state.transaction.matched_document.line_handles,[]);
      assert.equal(request.state.transaction.case_evidence.documents[0].document_type,'payment_confirmation');
      return response(typedResponse(request,()=> 'ask_obligation'));}});
  assert.equal(calls,1);
  assert.equal(result.provider_failure,undefined);
  assert.equal(result.jev_decision.terminal,'ask_owner');
  assert.equal(result.posting_requirement,'owner_fact');
}));


for(const [choice,question] of [['ask_statutory_source',/filing, assessment or contribution notice/],['ask_sales_source',/till\/cashbook reconciliation/]])
  test(`specific missing source ${choice} uses the ordinary owner-question consumer`,()=>withKeys(async()=>{
    let calls=0;
    const result=await suggestTransactionCoding({...args,fetchImpl:async(_,init)=>{calls++;return response(typedResponse(JSON.parse(init.body),()=>choice));}});
    assert.equal(calls,1);
    assert.equal(result.jev_decision.terminal,'ask_owner');
    assert.equal(result.jev_decision.selected,choice);
    assert.equal(result.posting_requirement,'owner_fact');
    assert.equal(result.evidence_required,true);
    assert.match(result.ask_client_question,question);
    assert.equal(__shouldAutoApplyBatchSuggestion(args.transaction,result),false);
  }));


test('a complete selected duplicate/refund group shares one resolved decision; missing members do not inherit it', () => withKeys(async () => {
  const group={status:'selected',source_digest:'source-fixture',transaction_ids:['purchase','duplicate','refund'],purchase_transaction_id:'purchase'};
  const transactions=group.transaction_ids.map(id=>({...args.transaction,id,jev_refund_group:group,...(id==='refund'?{money_in:80,money_out:0}:{})}));
  for (const rows of [transactions,transactions.slice(0,2)]) {
    let calls=0;
    const result=await suggestTransactionCodingBatch({...args,transactions:rows,fetchImpl:async(_url,init)=>{
      calls++;return response(typedResponse(JSON.parse(init.body),chooseMarketing));
    }});
    assert.equal(calls,rows.length===3?1:2);
    assert.equal(result.suggestions.length,rows.length);
    assert.ok(result.suggestions.every(s=>s.proposed_account==='Marketing'&&s.tax_treatment==='No GST'));
    assert.ok(result.suggestions.every(s=>rows.length===3?s.coding_group.decision_transaction_id==='purchase':!s.coding_group));
  }
}));

test('every group member revision includes sibling source facts without operational question churn',()=>{
  const transactions=['purchase','duplicate','refund'].map(id=>({id,description:id,refund_group:{transaction_ids:['purchase','duplicate','refund']}}));
  const evidence={focal:{id:'purchase'},company:{},transactions,matches:[],documents:[],owner_replies:[],obligations:[],coverage:{status:'complete',unread_sources:[]}};
  const original=codingCaseRevision(evidence);
  assert.notEqual(codingCaseRevision({...evidence,transactions:transactions.map(t=>t.id==='refund'?{...t,description:'Changed refund source'}:t)}),original);
  assert.equal(codingCaseRevision({...evidence,owner_replies:[{transaction_id:'duplicate',question:'An unanswered machine question',response_payload:{}}]}),original);
  assert.notEqual(codingCaseRevision({...evidence,owner_replies:[{transaction_id:'duplicate',question:'Use?',response_payload:{reply:'Business supplies'}}]}),original);
});

// ── Statement-only Finnish lines (Kampaamo, 2026-09-21) ────────────────────
// Nine applied codings rested on TRANSACTION_ALV_TREATMENT_UNRESOLVED because a
// resolved pair carrying the policy's unsure marker was accepted as complete.
import { decideJevCoding } from './jevCoding.js';
import { hasJevResolvedCoding } from './jevDecisionReceipt.js';
import { evaluateCodingAutoPost } from './codingAutoPost.js';

const chooseValues = (request, wanted) => Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
  const keys = Object.keys(question.criteria);
  const selected = keys.find(k => question.criteria[k] === wanted[key])
    || (keys.includes(wanted[key]) ? wanted[key] : key === 'decision' ? wanted.decision : key === 'materiality' ? 'normal' : keys[0]);
  const probability = key === 'decision' ? 0.48 : key === 'tax' ? 0.55 : 0.61;
  return [key, { type: 'choice', choice: selected, confidence: probability,
    probabilities: Object.fromEntries(keys.map(k => [k, k === selected ? probability : (1 - probability) / (keys.length - 1)])) }];
}));
const fiTyped = (request, wanted) => ({ model: 'test-jev-served', usage: { input_tokens: 10, output_tokens: 5 }, answers: chooseValues(request, wanted) });
const fiArgs = { clientProfile: { jurisdiction: 'fi', companyName: 'Synthetic Oy', entityType: 'fi-oy' },
  transaction: { id: 'fi-line', description: 'TAMPERE ENERGIA OY SÄHKÖ 1/2025', money_out: 359.42, date: '2025-02-05', account_currency: 'EUR' },
  xeroAccounts: [], clientRules: [], firmFacts: [], jevEnabled: true };

test('FI statement-only line: a resolved account with the unsure tax marker is a source-document ask, never an applied coding', () => withKeys(async () => {
  let calls = 0;
  const coding = await suggestTransactionCoding({ ...fiArgs, fetchImpl: async (_, init) => { calls++;
    return response(fiTyped(JSON.parse(init.body), { decision: 'resolved', account: 'Utilities', tax: 'ALV-tarkistus' })); } });
  assert.equal(calls, 1, 'the source document is missing, not judgment: no strong call');
  assert.equal(coding.proposed_account, 'Utilities');
  assert.equal(coding.evidence_required, true);
  assert.equal(coding.posting_requirement, 'single_account');
  assert.equal(coding.jev_decision.terminal, 'ask_owner');
  assert.equal(coding.jev_decision.selected, 'resolved');
  assert.equal(coding.jev_decision.tax_evidence_required, true);
  assert.doesNotMatch(coding.reasoning, /complete account and tax treatment/);
  assert.match(coding.ask_client_question, /invoice, receipt or notice/);
  assert.equal(hasJevResolvedCoding(coding), false);
  assert.equal(__shouldAutoApplyBatchSuggestion(fiArgs.transaction, coding), false);
  const verdict = evaluateCodingAutoPost({ suggestion: coding, amount: 359.42, unevidencedCap: 50 });
  assert.equal(verdict.action, 'owner_ask'); assert.equal(verdict.reason, 'evidence_required');
  const ask = buildOwnerAsk({ reason: verdict.reason, suggestion: coding, line: fiArgs.transaction });
  assert.equal(ask.evidence_type, 'supporting_document');
  assert.match(ask.question, /invoice, receipt or notice/);
}));

test('FI matched source with the unsure tax marker is judgment work: an explicit reasoning handoff, not an applied coding', async () => {
  const policy = resolveCodingPolicy({ jurisdiction: 'fi', businessDate: '2025-02-05', accountingSystem: 'none' });
  const tx = { ...fiArgs.transaction, matched_document: { match_status: 'auto_matched', document_type: 'receipt', filename: 'sahko.pdf', lines: [{ description: 'Sähkö', amount: 359.42 }] } };
  const jev = await decideJevCoding({ input: { client: { jurisdiction: 'fi' }, transaction: tx }, transaction: tx,
    accountOptions: policy.accountOptions, taxOptions: policy.taxTreatmentOptions, instructions: policy.taxInstructions,
    suspenseAccountName: policy.suspenseAccountName, defaultTaxTreatment: policy.defaultTaxTreatment, uncertainTaxTreatment: policy.uncertainTaxTreatment,
    provider: async request => fiTyped(request, { decision: 'resolved', account: 'Utilities', tax: 'ALV-tarkistus' }) });
  assert.equal(jev.terminal, 'needs_reasoning');
  assert.equal(jev.receipt.cause, 'reasoning_work');
  assert.equal(jev.receipt.tax_unresolved, 'ALV-tarkistus');
});

test('an explicit Jev source-document choice keeps the classified account and asks for the document', () => withKeys(async () => {
  const transaction = { ...fiArgs.transaction, description: 'OP YRITYSLAINA 6100123456 LYHENNYS+KORKO 2/2025', money_out: 412.35 };
  const coding = await suggestTransactionCoding({ ...fiArgs, transaction,
    fetchImpl: async (_, init) => response(fiTyped(JSON.parse(init.body), { decision: 'ask_source_document', account: 'Loan payable', tax: 'Ei ALV-käsittelyä' })) });
  assert.equal(coding.jev_decision.terminal, 'ask_owner');
  assert.equal(coding.proposed_account, 'Loan payable');
  assert.equal(coding.posting_requirement, 'single_account');
  assert.equal(coding.evidence_required, true);
  assert.equal(__shouldAutoApplyBatchSuggestion(transaction, coding), false);
  const ask = buildOwnerAsk({ reason: 'evidence_required', suggestion: coding, line: transaction });
  assert.equal(ask.fact, 'document');
  assert.match(ask.question, /LYHENNYS\+KORKO.*invoice, receipt or notice/);
}));

test('statement-only salary may ask for the payroll package; a matched non-payroll source excludes it and the document ask', () => {
  const policy = resolveCodingPolicy({ jurisdiction: 'fi', businessDate: '2025-02-05', accountingSystem: 'none' });
  const criteria = matched_document => Object.keys(buildJevCodingRequest({ input: { client: { jurisdiction: 'fi' },
    transaction: { description: 'KORHONEN SAARA PALKKA 2/2025', money_out: 1926.24, matched_document } },
    accountOptions: policy.accountOptions, taxOptions: policy.taxTreatmentOptions, instructions: policy.taxInstructions, model: 'synthetic-test' }).request.questions.decision.criteria);
  assert.ok(criteria(undefined).includes('ask_payroll_package'));
  assert.ok(criteria(undefined).includes('ask_source_document'));
  const receipt = { match_status: 'auto_matched', source_family: 'receipt' };
  assert.ok(!criteria(receipt).includes('ask_payroll_package'));
  assert.ok(!criteria(receipt).includes('ask_source_document'));
  assert.ok(criteria({ match_status: 'auto_matched', source_family: 'payroll' }).includes('ask_payroll_package'));
});

test('real PG: a statement-only Finnish line with the unsure marker rests on the owner as a document draft, with no journal',
  { skip: !process.env.DONNA_PG_TEST_URL }, () => withKeys(async () => {
    const { default: pg } = await import('pg');
    const { readdir, readFile } = await import('node:fs/promises');
    const { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } = await import('./firmDb.js');
    const { batchSuggestTransactionCodingInDb } = await import('./db/coding.js');
    const { sweepCodingAutoPost } = await import('./codingAutoPost.js');
    const name = `donna_jev_fi_statement_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = [];
    pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    const savedFetch = globalThis.fetch;
    __setFirmDbPoolForTests(pool);
    try {
      await pool.query(`create schema storage;
        create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects (id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
      const root = new URL('../../db/migrations/', import.meta.url);
      for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
      await pool.query("insert into firms(id,name,slug) values('jev-firm','Jev FI Statement Test','jev-fi-statement')");
      await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
        values('jev-company','jev-firm','Kampaamo Oy','FI','fi-oy','{"jurisdiction":"fi","accounting_system":"none"}')`);
      await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values
        ('jev-enabled','jev-firm','jev-company','JEV_RECONCILIATION','auto','manual'),
        ('auto-post','jev-firm','jev-company','CODING_AUTO_POST','auto','manual')`);
      await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('trial-member','jev-firm','fixture@example.invalid','Fixture','admin','active')");
      const { enrollJevExperiment } = await import('./jevExperimentPolicy.js');
      const enrollment = await pool.connect();
      try { await enrollJevExperiment({ client: enrollment, firmId: 'jev-firm', clientId: 'jev-company', actorId: 'trial-member', authorityBasis: 'Synthetic statement-only proof', trialId: 'statement-proof', expiresAt: '2100-01-01', model: process.env.TYPESAFE_MODEL }); }
      finally { enrollment.release(); }
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload)
        values('fi-utility','jev-firm','jev-company','2025-02-05','TAMPERE ENERGIA OY SÄHKÖ 1/2025',359.42,'EUR','needs_review','{}')`);
      const calls = [];
      globalThis.fetch = async (endpoint, init) => {
        calls.push(String(endpoint));
        assert.match(String(endpoint), /api\.typesafe\.ai/, 'the source document is missing; no strong call');
        return response(fiTyped(JSON.parse(init.body), { decision: 'resolved', account: 'Utilities', tax: 'ALV-tarkistus' }));
      };
      await batchSuggestTransactionCodingInDb({ firmId: 'jev-firm', clientIds: ['jev-company'], limit: 1, autoApply: true });
      const coded = (await pool.query("select coding_state,payload from transactions where id='fi-utility'")).rows[0];
      assert.equal(coded.coding_state, 'proposed', JSON.stringify(coded.payload.ai_suggestion));
      assert.equal(coded.payload.ai_suggestion.proposed_account, 'Utilities');
      assert.equal(coded.payload.ai_suggestion.evidence_required, true);
      assert.equal(coded.payload.ai_suggestion.jev_decision.tax_evidence_required, true);
      const sweep = await sweepCodingAutoPost({ firmId: 'jev-firm', clientId: 'jev-company' });
      const asked = (await pool.query("select coding_state,payload from transactions where id='fi-utility'")).rows[0];
      assert.equal(asked.coding_state, 'asked', JSON.stringify(sweep));
      const asks = (await pool.query("select status,evidence_type,question,send_count from client_evidence_requests where transaction_id='fi-utility'")).rows;
      assert.equal(asks.length, 1);
      assert.equal(asks[0].status, 'draft'); assert.equal(Number(asks[0].send_count), 0);
      assert.equal(asks[0].evidence_type, 'supporting_document');
      assert.match(asks[0].question, /invoice, receipt or notice/);
      assert.equal((await pool.query("select count(*)::int as n from ledger_journals")).rows[0].n, 0);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = savedFetch;
      __resetFirmDbPoolForTests();
      await pool.end(); await Promise.all(closed);
      await admin.query(`drop database "${name}"`); await admin.end();
    }
  }));

test('both ask writers treat a Jev source-document choice as a document ask', async () => {
  const { JEV_DOCUMENT_ASK_SELECTIONS } = await import('./jevDecisionReceipt.js');
  assert.ok(JEV_DOCUMENT_ASK_SELECTIONS.includes('ask_source_document'));
  const ask = buildOwnerAsk({ reason: 'coding_owner_fact', suggestion: { jev_decision: { selected: 'ask_source_document' }, ask_client_question: 'Please send the invoice.' }, line: args.transaction });
  assert.equal(ask.evidence_type, 'supporting_document');
  const correction = readFileSync(new URL('./db/codingCorrection.js', import.meta.url), 'utf8');
  assert.match(correction, /JEV_DOCUMENT_ASK_SELECTIONS\.includes\(suggestion\.jev_decision\?\.selected\)\?'supporting_document'/, 'the correction lane reads the shared list');
});

// Frozen replay 2026-09-21 (web-replay, runtime head 248951d2): the Shell and
// taxi statement-only lines asked for the purpose only, and the receipt was
// requested a second time after the answer. One question carries both facts.
test('FI statement-only fact question also names the missing receipt; a settled source does not', () => withKeys(async () => {
  const fuel = { ...fiArgs, transaction: { id: 'fuel', description: 'SHELL TAMPERE', money_out: 40, date: '2025-02-10', account_currency: 'EUR' } };
  const asked = await suggestTransactionCoding({ ...fuel, fetchImpl: async (_, init) => response(fiTyped(JSON.parse(init.body), { decision: 'ask_business_purpose' })) });
  assert.equal(asked.jev_decision.terminal, 'ask_owner');
  assert.equal(asked.posting_requirement, 'owner_fact');
  assert.match(asked.ask_client_question, /What was this payment for in the business\?/);
  assert.match(asked.ask_client_question, /attach the receipt or invoice for this payment; tax cannot be recorded from the bank line alone/);
  assert.equal(asked.jev_decision.source_document_requested, true);
  const ask = buildOwnerAsk({ reason: 'coding_owner_fact', suggestion: asked, line: fuel.transaction });
  assert.equal(ask.evidence_type, 'business_purpose', 'the fact stays the fact; the receipt rides the same question');
  assert.match(ask.question, /attach the receipt/);
  const sourced = { ...fuel, transaction: { ...fuel.transaction, matched_document: { document_id: 'shell-receipt', filename: 'shell.pdf', match_status: 'auto_matched',
    document_type: 'receipt', total_amount: 40, tax_amount: 8.13, lines: [{ id: 'l1', description: 'Diesel', amount: 40, tax_rate: 25.5 }], parse_summary: { line_amounts_include_tax: true } } } };
  const held = await suggestTransactionCoding({ ...sourced, fetchImpl: async (_, init) => response(fiTyped(JSON.parse(init.body), { decision: 'ask_business_use' })) });
  assert.doesNotMatch(held.ask_client_question, /attach the receipt/);
  assert.equal(held.jev_decision.source_document_requested, undefined);
}));

// The VR (row 25) and book (row 22) postings printed 10 % on 2025 lines. The
// FI policy names 10 % historical for 2025 dates; without a stated basis the
// coding is the existing document_discrepancy question against the held
// source, never a posting — for a Jev decision as for a strong one.
const vrTransaction = { id: 'vr', description: 'VR-YHTYMA OYJ', money_out: 28.6, date: '2025-02-25', account_currency: 'EUR',
  matched_document: { document_id: 'vr-ticket', filename: 'vr-ticket.pdf', match_status: 'auto_matched', document_type: 'supplier_bill',
    total_amount: 28.6, tax_amount: 2.6, lines: [{ id: 'l1', description: 'TAMPERE-HELSINKI EKO', amount: 28.6, tax_rate: 10 }], parse_summary: { line_amounts_include_tax: true } } };
test('FI held source printing a historical rate: Jev may ask for the timing, and a resolved historical rate becomes that question, never a posting', () => withKeys(async () => {
  let request;
  const timing = await suggestTransactionCoding({ ...fiArgs, transaction: vrTransaction, fetchImpl: async (_, init) => { request = JSON.parse(init.body);
    return response(fiTyped(request, { decision: 'ask_supply_timing' })); } });
  assert.ok(request.questions.decision.criteria.ask_supply_timing, 'a held source with complete printed components offers the timing question');
  assert.ok(request.questions.decision.criteria.ask_component_split);
  assert.doesNotMatch(request.questions.tax.instructions, /including historical rates/);
  assert.equal(timing.posting_requirement, 'document_discrepancy');
  assert.equal(timing.evidence_required, true);
  assert.match(timing.ask_client_question, /vr-ticket\.pdf/);
  assert.equal(hasJevResolvedCoding(timing), false);
  const verdict = evaluateCodingAutoPost({ suggestion: timing, amount: 28.6, hasDocMatch: true });
  assert.equal(verdict.action, 'owner_ask'); assert.equal(verdict.reason, 'coding_document_discrepancy');
  const ask = buildOwnerAsk({ reason: verdict.reason, suggestion: timing, line: vrTransaction });
  assert.equal(ask.evidence_type, 'document_discrepancy'); assert.match(ask.question, /vr-ticket\.pdf/);
  // The demonstrated failure: Jev declares 10 % resolved because the source prints it.
  const printed = await suggestTransactionCoding({ ...fiArgs, transaction: vrTransaction, fetchImpl: async (_, init) => response(fiTyped(JSON.parse(init.body), { decision: 'resolved', account: 'Travel', tax: 'ALV 10 %' })) });
  assert.equal(printed.proposed_account, 'Travel'); assert.equal(printed.tax_treatment, 'ALV 10 %');
  assert.equal(printed.posting_requirement, 'document_discrepancy');
  assert.deepEqual(printed.historical_rate_guard.treatments, ['ALV 10 %']);
  assert.equal(printed.historical_rate_guard.verified_source, true);
  assert.equal(printed.evidence_required, true);
  assert.equal(hasJevResolvedCoding(printed), false);
  assert.equal(__shouldAutoApplyBatchSuggestion(vrTransaction, printed), false);
  assert.match(printed.ask_client_question, /vr-ticket\.pdf.*ALV 10 %.*2025-02-25/);
  // Neighbouring valid case: the current reduced rate is a complete action.
  const current = await suggestTransactionCoding({ ...fiArgs, transaction: vrTransaction, fetchImpl: async (_, init) => response(fiTyped(JSON.parse(init.body), { decision: 'resolved', account: 'Travel', tax: 'ALV 14 %' })) });
  assert.equal(current.posting_requirement, 'single_account'); assert.equal(current.historical_rate_guard, undefined);
  assert.equal(hasJevResolvedCoding(current), true);
  // A statement-only line offers neither discrepancy question: nothing is held to cite.
  let bare;
  await suggestTransactionCoding({ ...fiArgs, fetchImpl: async (_, init) => { bare = JSON.parse(init.body); return response(fiTyped(bare, { decision: 'ask_source_document' })); } });
  assert.equal(bare.questions.decision.criteria.ask_supply_timing, undefined);
  assert.equal(bare.questions.decision.criteria.ask_component_split, undefined);
}));

// Lumikki (frozen replay): one printed reminder line combines late interest and
// a reminder fee without each amount. The whole line must not post to one
// income account and no split is invented: the component answer is the ask.
test('FI combined source line: a component split question holds the whole allocation as a document_discrepancy ask', () => withKeys(async () => {
  const reminder = { id: 'lumikki', description: 'LUMIKKI OY', money_in: 923.6, money_out: 0, date: '2025-02-24', account_currency: 'EUR',
    matched_document: { document_id: 'reminder', filename: 'muistutus-1001.pdf', match_status: 'auto_matched', document_type: 'sales_invoice',
      total_amount: 923.6, tax_amount: 183.6, parse_summary: { line_amounts_include_tax: true },
      lines: [{ id: 'l1', description: 'Kampaamopalvelut', amount: 903.6, tax_rate: 25.5 }, { id: 'l2', description: 'Viivästyskorko 19.2.–20.2.2025 sekä muistutuskulu (arvonlisäverottomia)', amount: 20, tax_rate: 0 }] } };
  const calls = [];
  const coding = await suggestTransactionCoding({ ...fiArgs, transaction: reminder, fetchImpl: async (_, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    const wanted = request.questions.decision ? { decision: 'document_allocation' } : { line_1_decision: 'resolved', line_1_account: 'Sales', line_1_tax: 'ALV 25,5 %', line_2_decision: 'ask_component_split' };
    return response(fiTyped(request, wanted)); } });
  assert.equal(calls.length, 2, 'the component call carries the split question');
  assert.ok(calls[1].questions.line_2_decision.criteria.ask_component_split);
  assert.equal(coding.jev_decision.terminal, 'ask_owner');
  assert.equal(coding.jev_decision.selected, 'ask_component_split');
  assert.equal(coding.jev_decision.component_handle, 'line_2');
  assert.equal(coding.posting_requirement, 'document_discrepancy');
  assert.deepEqual(coding.document_allocations, []);
  assert.equal(coding.evidence_required, true);
  assert.match(coding.ask_client_question, /muistutus-1001\.pdf.*combines two different charges/);
  assert.equal(hasJevResolvedCoding(coding), false);
}));

// Kampaamo card purchases (2026-09-21, production at PR #2187): ten
// statement-only lines rested applied at 'ALV-tarkistus' although Jev's own
// resolved terminal already asked for the document. The strong coder — alone,
// or after a Jev reasoning handoff — went through a contract with no such rule,
// so the auto-post sweep applied its unsure treatment, the posting policy
// refused it, and three reconsiderations spent the same shape. The rule now
// lives in the shared contract for every engine.
const strongResponse = body => response({ model: 'test-strong-served', output: [{ content: [{ text: JSON.stringify(body) }] }] });
test('FI statement-only line after a Jev reasoning handoff: the strong coder\'s unsure treatment is a source-document ask, never an applied coding', () => withKeys(async () => {
  const calls = [];
  const coding = await suggestTransactionCoding({ ...fiArgs, fetchImpl: async (url, init) => {
    calls.push(String(url)); const request = JSON.parse(init.body);
    if (String(url).includes('typesafe')) return response(fiTyped(request, { decision: 'reasoning_judgment' }));
    return strongResponse({ proposed_account: 'Utilities', tax_treatment: 'ALV-tarkistus', confidence: 'high', evidence_required: false,
      posting_requirement: 'single_account', remember_candidate: true, merchant_pattern: 'TAMPERE ENERGIA', auto_explain_limit: 400, support_note: 'Electricity for the salon.' });
  } });
  assert.equal(calls.length, 2); assert.match(calls[1], /openai/);
  assert.equal(coding.decision_engine, 'strong_after_jev');
  assert.equal(coding.proposed_account, 'Utilities', 'the account stays classified');
  assert.equal(coding.tax_treatment, 'ALV-tarkistus', 'the unsure marker is never laundered into a rate');
  assert.equal(coding.evidence_required, true);
  assert.equal(coding.posting_requirement, 'single_account');
  assert.equal(coding.remember_candidate, false); assert.equal(coding.auto_explain_limit, 0);
  assert.deepEqual(coding.tax_unresolved_guard, { treatment: 'ALV-tarkistus', constraint: 'unsure_treatment_statement_only', model_asked: false });
  assert.match(coding.ask_client_question, /^TAMPERE ENERGIA OY SÄHKÖ 1\/2025: Please send the invoice, receipt or notice/);
  assert.match(coding.support_note, /unsure marker/);
  assert.equal(hasJevResolvedCoding(coding), false);
  assert.equal(__shouldAutoApplyBatchSuggestion(fiArgs.transaction, coding), false);
  for (const amount of [13.6, 359.42]) {
    const verdict = evaluateCodingAutoPost({ suggestion: coding, amount, unevidencedCap: 50 });
    assert.equal(verdict.action, 'owner_ask', `an unsure treatment below the description-only ceiling (${amount}) is asked, never posted`);
    assert.equal(verdict.reason, 'evidence_required');
  }
  const ask = buildOwnerAsk({ reason: 'evidence_required', suggestion: coding, line: fiArgs.transaction });
  assert.equal(ask.evidence_type, 'supporting_document');
  assert.match(ask.question, /invoice, receipt or notice/);
}));

test('the shared unsure-treatment rule keeps a model\'s own question, leaves a settled source to the recheck lane, and leaves a real rate alone', () => withKeys(async () => {
  const strong = body => async (url, init) => String(url).includes('typesafe')
    ? response(fiTyped(JSON.parse(init.body), { decision: 'reasoning_judgment' })) : strongResponse(body);
  // A model that already asked: the guard records the unresolved treatment and keeps the question.
  const asked = await suggestTransactionCoding({ ...fiArgs, fetchImpl: strong({ proposed_account: 'Utilities', tax_treatment: 'ALV-tarkistus', confidence: 'medium',
    evidence_required: true, posting_requirement: 'single_account', ask_client_question: 'Which premises does this electricity bill cover?' }) });
  assert.equal(asked.evidence_required, true);
  assert.equal(asked.ask_client_question, 'Which premises does this electricity bill cover?');
  assert.equal(asked.tax_unresolved_guard.model_asked, true);
  // A settled source: the treatment stays as answered; the posting policy refuses it and the
  // source-recheck lane (codingRefusalRecovery.js) owns the re-read — no owner ask for a held document.
  const sourced = { ...fiArgs.transaction, matched_document: { match_status: 'auto_matched', document_type: 'receipt', filename: 'sahko.pdf', lines: [{ description: 'Sähkö', amount: 359.42 }] } };
  const held = await suggestTransactionCoding({ ...fiArgs, transaction: sourced, fetchImpl: strong({ proposed_account: 'Utilities', tax_treatment: 'ALV-tarkistus', confidence: 'high',
    evidence_required: false, posting_requirement: 'single_account' }) });
  assert.equal(held.evidence_required, false); assert.equal(held.tax_unresolved_guard, undefined);
  assert.equal(held.tax_treatment, 'ALV-tarkistus');
  // A resolved rate on a statement-only line is untouched by this rule (the posting policy's
  // evidence requirement for deductible input VAT stays that lane's own contract).
  const rated = await suggestTransactionCoding({ ...fiArgs, fetchImpl: strong({ proposed_account: 'Utilities', tax_treatment: 'ALV 25,5 %', confidence: 'high',
    evidence_required: false, posting_requirement: 'single_account' }) });
  assert.equal(rated.evidence_required, false); assert.equal(rated.tax_unresolved_guard, undefined);
  assert.equal(rated.tax_treatment, 'ALV 25,5 %');
  // Jev's own resolved-with-unsure terminal already asks; the shared rule adds only its receipt.
  const jevAsk = await suggestTransactionCoding({ ...fiArgs, fetchImpl: async (_, init) => response(fiTyped(JSON.parse(init.body), { decision: 'resolved', account: 'Utilities', tax: 'ALV-tarkistus' })) });
  assert.equal(jevAsk.jev_decision.tax_evidence_required, true);
  assert.equal(jevAsk.tax_unresolved_guard.model_asked, true);
  assert.match(jevAsk.ask_client_question, /invoice, receipt or notice/);
  // A jurisdiction that does not post tax from the source document (SG here) keeps its
  // unsure marker as before: the treatment is not what blocks the line there.
  const sgStatementOnly = { ...args, transaction: { ...args.transaction, matched_document: undefined }, fetchImpl: async (url, init) => String(url).includes('typesafe')
    ? response(typedResponse(JSON.parse(init.body), () => 'reasoning_judgment'))
    : strongResponse({ proposed_account: 'Marketing', tax_treatment: 'GST check', confidence: 'high', evidence_required: false, posting_requirement: 'single_account' }) };
  const sg = await suggestTransactionCoding(sgStatementOnly);
  assert.equal(sg.tax_treatment, 'GST check'); assert.equal(sg.evidence_required, false); assert.equal(sg.tax_unresolved_guard, undefined);
}));

test('the shared unsure-treatment rule on a VERIFIED held source splits on its printed tax: clear printed VAT keeps the coding with a named-cause receipt and no owner ask; incomplete or inconsistent printed VAT is one document_discrepancy question; an unverified source stays with the recheck lane; other packs are untouched', () => withKeys(async () => {
  const strong = body => async (url, init) => String(url).includes('typesafe')
    ? response(fiTyped(JSON.parse(init.body), { decision: 'reasoning_judgment' })) : strongResponse(body);
  const marker = { proposed_account: 'Telecommunications', tax_treatment: 'ALV-tarkistus', confidence: 'high', evidence_required: false, posting_requirement: 'single_account' };
  const held = { match_status: 'auto_matched', document_type: 'supplier_bill', filename: 'teleyhtyma.pdf', total_amount: 59.32, tax_amount: 12.05, currency: 'EUR', lines: [] };
  const line = { ...fiArgs.transaction, description: 'SUOMEN TELEYHTYMA OY', money_out: 59.32 };
  const recheck = (summary, lines = [{ description: 'Liittymä 02/2025', amount: 47.27, tax_rate: 25.5 }]) => ({ state: 'reconsidered',
    review: { source_verified: true, printed_header: { total_amount: 59.32 }, printed_summary: summary, printed_lines: lines } });
  // The source-recheck lane re-read the file: 12.05 EUR is exactly 25.5 % on 47.27. Clear printed tax.
  const rechecked = { ...line, matched_document: held, posting_recovery: recheck({ tax_amount: 12.05, subtotal_amount: 47.27 }) };
  const clear = await suggestTransactionCoding({ ...fiArgs, transaction: rechecked, fetchImpl: strong(marker) });
  assert.equal(clear.tax_treatment, 'ALV-tarkistus', 'never laundered into a rate');
  assert.equal(clear.posting_requirement, 'single_account', 'no owner question: the marker is Donna\'s failure');
  assert.equal(clear.evidence_required, false); assert.equal(clear.ask_client_question ?? '', '');
  assert.equal(clear.remember_candidate, false);
  assert.deepEqual(clear.tax_unresolved_guard, { treatment: 'ALV-tarkistus', constraint: 'unsure_treatment_clear_source', model_asked: false,
    source_tax: { clear: true, total: 59.32, tax: 12.05, rates: [25.5] }, cause: 'coder_left_printed_treatment_unsettled' });
  assert.notEqual(evaluateCodingAutoPost({ suggestion: clear, amount: 59.32, unevidencedCap: 50, hasDocMatch: true }).reason, 'coding_document_discrepancy');
  // A question the model wrote itself on a clear source is not sent either: it rides the receipt.
  const ownAsk = await suggestTransactionCoding({ ...fiArgs, transaction: rechecked, fetchImpl: strong({ ...marker, evidence_required: true,
    ask_client_question: 'Which VAT rate applies to the SUOMEN TELEYHTYMA OY subscription?' }) });
  assert.equal(ownAsk.posting_requirement, 'single_account'); assert.equal(ownAsk.evidence_required, false);
  assert.equal(ownAsk.ask_client_question, '');
  assert.equal(ownAsk.tax_unresolved_guard.cause, 'coder_left_printed_treatment_unsettled');
  assert.equal(ownAsk.tax_unresolved_guard.model_asked, true);
  assert.equal(ownAsk.tax_unresolved_guard.suppressed_question, 'Which VAT rate applies to the SUOMEN TELEYHTYMA OY subscription?');
  assert.equal(__shouldAutoApplyBatchSuggestion(rechecked, ownAsk), true, 'applied, so the posting policy refuses it and it rests named');
  assert.notEqual(evaluateCodingAutoPost({ suggestion: ownAsk, amount: 59.32, unevidencedCap: 50, hasDocMatch: true }).reason, 'coding_evidence_required');
  // Header-only re-read: the printed net and VAT imply exactly one rate in force.
  const headerOnly = await suggestTransactionCoding({ ...fiArgs, transaction: { ...rechecked, posting_recovery: recheck({ tax_amount: 12.05 }, []) }, fetchImpl: strong(marker) });
  assert.equal(headerOnly.tax_unresolved_guard.constraint, 'unsure_treatment_clear_source'); assert.equal(headerOnly.posting_requirement, 'single_account');
  // Printed components already complete on the held source: verified without a re-read, and clear.
  const components = await suggestTransactionCoding({ ...fiArgs, transaction: { ...line, matched_document: { ...held, lines: [{ description: 'Liittymä', amount: 59.32, tax_rate: 25.5 }] } }, fetchImpl: strong(marker) });
  assert.equal(components.tax_unresolved_guard.constraint, 'unsure_treatment_clear_source'); assert.equal(components.posting_requirement, 'single_account');
  // Printed VAT that implies no rate in force on the date (10.00 on 59.32): a genuine source discrepancy.
  const inconsistent = { ...line, matched_document: { ...held, tax_amount: 10 }, posting_recovery: recheck({ tax_amount: 10 }, []) };
  const coding = await suggestTransactionCoding({ ...fiArgs, transaction: inconsistent, fetchImpl: strong(marker) });
  assert.equal(coding.tax_treatment, 'ALV-tarkistus');
  assert.equal(coding.posting_requirement, 'document_discrepancy');
  assert.equal(coding.evidence_required, true); assert.equal(coding.remember_candidate, false); assert.equal(coding.auto_explain_limit, 0);
  assert.deepEqual(coding.tax_unresolved_guard, { treatment: 'ALV-tarkistus', constraint: 'unsure_treatment_unclear_source', model_asked: false,
    source_tax: { clear: false, reason: 'source_vat_implies_no_rate_in_force' } });
  assert.equal(coding.ask_client_question, 'SUOMEN TELEYHTYMA OY: the held document teleyhtyma.pdf (total 59.32 EUR, printed VAT 10.00 EUR) does not establish which VAT treatment applies. Please send a corrected invoice or receipt that states the VAT rate and VAT amount for each item, or its note on why no VAT is charged (for example reverse charge).');
  assert.equal(__shouldAutoApplyBatchSuggestion(inconsistent, coding), false);
  assert.equal(evaluateCodingAutoPost({ suggestion: coding, amount: 59.32, unevidencedCap: 50, hasDocMatch: true }).reason, 'coding_document_discrepancy');
  assert.equal(buildOwnerAsk({ reason: 'coding_document_discrepancy', suggestion: coding }).evidence_type, 'document_discrepancy');
  // Incomplete: the source prints no VAT at all, and nothing says why.
  const noVat = await suggestTransactionCoding({ ...fiArgs, transaction: { ...line, matched_document: { ...held, tax_amount: 0 }, posting_recovery: recheck({ tax_amount: 0 }, []) }, fetchImpl: strong(marker) });
  assert.equal(noVat.posting_requirement, 'document_discrepancy'); assert.equal(noVat.tax_unresolved_guard.source_tax.reason, 'source_prints_no_vat');
  // A printed rate not in force on the date (13.5 % on a February 2025 line).
  const offEra = await suggestTransactionCoding({ ...fiArgs, transaction: { ...rechecked, posting_recovery: recheck({ tax_amount: 12.05 }, [{ description: 'Liittymä', amount: 47.27, tax_rate: 13.5 }]) }, fetchImpl: strong(marker) });
  assert.equal(offEra.posting_requirement, 'document_discrepancy'); assert.equal(offEra.tax_unresolved_guard.source_tax.reason, 'source_rate_not_in_force');
  // A model that asked its own precise question keeps it.
  const asked = await suggestTransactionCoding({ ...fiArgs, transaction: inconsistent, fetchImpl: strong({ ...marker, evidence_required: true,
    ask_client_question: 'teleyhtyma.pdf prints 10.00 EUR VAT with no rate. Please send the corrected invoice.' }) });
  assert.equal(asked.ask_client_question, 'teleyhtyma.pdf prints 10.00 EUR VAT with no rate. Please send the corrected invoice.');
  assert.equal(asked.tax_unresolved_guard.model_asked, true); assert.equal(asked.posting_requirement, 'document_discrepancy');
  // Settled but unverified (no complete components, no re-read yet): unchanged — the recheck lane owns it.
  const unverified = await suggestTransactionCoding({ ...fiArgs, transaction: { ...line, matched_document: held }, fetchImpl: strong(marker) });
  assert.equal(unverified.tax_unresolved_guard, undefined); assert.equal(unverified.evidence_required, false);
  assert.equal(unverified.posting_requirement, 'single_account');
  // A real rate on the verified source is a coding, not a question.
  const rated = await suggestTransactionCoding({ ...fiArgs, transaction: rechecked, fetchImpl: strong({ ...marker, tax_treatment: 'ALV 25,5 %' }) });
  assert.equal(rated.tax_unresolved_guard, undefined); assert.equal(rated.posting_requirement, 'single_account'); assert.equal(rated.evidence_required, false);
  // A pack that does not post tax from the source (SG) keeps its unsure marker on a verified source.
  const sg = await suggestTransactionCoding({ ...args, transaction: { ...args.transaction, posting_recovery: { state: 'reconsidered', review: { source_verified: true } } },
    fetchImpl: async (url, init) => String(url).includes('typesafe')
      ? response(typedResponse(JSON.parse(init.body), () => 'reasoning_judgment'))
      : strongResponse({ proposed_account: 'Marketing', tax_treatment: 'GST check', confidence: 'high', evidence_required: false, posting_requirement: 'single_account' }) });
  assert.equal(sg.tax_treatment, 'GST check'); assert.equal(sg.tax_unresolved_guard, undefined); assert.equal(sg.posting_requirement, 'single_account');
}));

test('real PG: a strong-coder unsure treatment on a statement-only Finnish line rests on the owner as a document draft; a matched line coded from its source is not asked',
  { skip: !process.env.DONNA_PG_TEST_URL }, () => withKeys(async () => {
    const { default: pg } = await import('pg');
    const { readdir, readFile } = await import('node:fs/promises');
    const { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } = await import('./firmDb.js');
    const { batchSuggestTransactionCodingInDb } = await import('./db/coding.js');
    const { sweepCodingAutoPost } = await import('./codingAutoPost.js');
    const name = `donna_jev_fi_strong_unsure_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = [];
    pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    const savedFetch = globalThis.fetch;
    __setFirmDbPoolForTests(pool);
    try {
      await pool.query(`create schema storage;
        create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects (id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
      const root = new URL('../../db/migrations/', import.meta.url);
      for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
      await pool.query("insert into firms(id,name,slug) values('jev-firm','Jev FI Strong Unsure Test','jev-fi-strong-unsure')");
      await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
        values('jev-company','jev-firm','Kampaamo Oy','FI','fi-oy','{"jurisdiction":"fi","accounting_system":"none"}')`);
      await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values
        ('jev-enabled','jev-firm','jev-company','JEV_RECONCILIATION','auto','manual'),
        ('auto-post','jev-firm','jev-company','CODING_AUTO_POST','auto','manual')`);
      await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('trial-member','jev-firm','fixture@example.invalid','Fixture','admin','active')");
      const { enrollJevExperiment } = await import('./jevExperimentPolicy.js');
      const enrollment = await pool.connect();
      try { await enrollJevExperiment({ client: enrollment, firmId: 'jev-firm', clientId: 'jev-company', actorId: 'trial-member', authorityBasis: 'Synthetic strong-unsure proof', trialId: 'strong-unsure-proof', expiresAt: '2100-01-01', model: process.env.TYPESAFE_MODEL }); }
      finally { enrollment.release(); }
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload) values
        ('google','jev-firm','jev-company','2025-02-06','GOOGLE *WORKSPACE GOOGLE.COM IE',13.60,'EUR','needs_review','{}'),
        ('hesburger','jev-firm','jev-company','2025-02-14','HESBURGER TAMPERE KOSKIK.',12.90,'EUR','needs_review','{}')`);
      await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency)
        values('receipt','jev-firm','jev-company','hesburger.pdf','receipt','completed','2025-02-14',12.90,1.59,'EUR')`);
      await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence)
        values('match','jev-firm','jev-company','hesburger','receipt','receipt','auto_matched',12.90,1)`);
      const calls = [];
      globalThis.fetch = async (endpoint, init) => {
        const request = JSON.parse(init.body);
        const jev = String(endpoint).includes('typesafe');
        // The focal line: Jev's state.transaction, or the strong coder's input JSON. Peers ride
        // along in both requests, so a substring of the whole body cannot identify the line.
        const focal = String(jev ? request.state?.transaction?.description : JSON.parse(request.input)?.transaction?.description || '');
        const line = focal.includes('GOOGLE') ? 'google' : focal.includes('HESBURGER') ? 'hesburger' : `unknown:${focal}`;
        calls.push(`${jev ? 'jev' : 'strong'}:${line}`);
        if (jev) {
          return response(fiTyped(request, line === 'google' ? { decision: 'reasoning_judgment' } : { decision: 'resolved', account: 'Utilities', tax: 'ALV 14 %' }));
        }
        assert.equal(line, 'google', 'only the reasoning handoff reaches the strong coder');
        return strongResponse({ proposed_account: 'Utilities', tax_treatment: 'ALV-tarkistus', confidence: 'high', evidence_required: false,
          posting_requirement: 'single_account', support_note: 'Google Workspace subscription.' });
      };
      await batchSuggestTransactionCodingInDb({ firmId: 'jev-firm', clientIds: ['jev-company'], limit: 5, autoApply: true });
      assert.deepEqual([...calls].sort(), ['jev:google', 'jev:hesburger', 'strong:google']);
      const google = (await pool.query("select coding_state,payload from transactions where id='google'")).rows[0];
      assert.equal(google.coding_state, 'proposed', JSON.stringify(google.payload.ai_suggestion));
      assert.equal(google.payload.ai_suggestion.decision_engine, 'strong_after_jev');
      assert.equal(google.payload.ai_suggestion.tax_treatment, 'ALV-tarkistus');
      assert.equal(google.payload.ai_suggestion.evidence_required, true);
      assert.equal(google.payload.ai_suggestion.tax_unresolved_guard.constraint, 'unsure_treatment_statement_only');
      const matched = (await pool.query("select coding_state,payload from transactions where id='hesburger'")).rows[0];
      assert.equal(matched.coding_state, 'posted', 'the matched line keeps the treatment its source supports and posts');
      assert.equal(matched.payload.ai_suggestion.tax_treatment, 'ALV 14 %');
      assert.equal(matched.payload.ai_suggestion.evidence_required, false);
      assert.deepEqual((await pool.query("select source_id from ledger_journals")).rows, [{ source_id: 'hesburger' }]);
      const sweep = await sweepCodingAutoPost({ firmId: 'jev-firm', clientId: 'jev-company' });
      const asked = (await pool.query("select coding_state,payload from transactions where id='google'")).rows[0];
      assert.equal(asked.coding_state, 'asked', JSON.stringify(sweep));
      const asks = (await pool.query("select transaction_id,status,evidence_type,question,send_count from client_evidence_requests order by transaction_id")).rows;
      assert.equal(asks.length, 1, 'exactly one owner ask, for the statement-only line');
      assert.equal(asks[0].transaction_id, 'google');
      assert.equal(asks[0].status, 'draft'); assert.equal(Number(asks[0].send_count), 0);
      assert.equal(asks[0].evidence_type, 'supporting_document');
      assert.match(asks[0].question, /invoice, receipt or notice/);
      assert.equal((await pool.query("select coding_state from transactions where id='hesburger'")).rows[0].coding_state, 'posted');
      assert.deepEqual((await pool.query("select source_id from ledger_journals")).rows, [{ source_id: 'hesburger' }], 'the statement-only line never posts');
      assert.equal((await pool.query("select count(*)::int as n from transactions where payload ? 'ledger_post_refusal'")).rows[0].n, 0, 'nothing reached the posting policy with the unsure marker');
    } finally {
      globalThis.fetch = savedFetch;
      __resetFirmDbPoolForTests();
      await pool.end(); await Promise.all(closed);
      await admin.query(`drop database "${name}"`); await admin.end();
    }
  }));

test('real PG: a matched Finnish line whose strong coder still answers the unsure marker after its source recheck rests as a NAMED technical failure when the source prints clear VAT, and becomes one document_discrepancy draft only when the printed VAT is inconsistent; a clear receipt posts; a statement-only line keeps its document ask; legacy rows follow the same fork',
  { skip: !process.env.DONNA_PG_TEST_URL }, () => withKeys(async () => {
    const { default: pg } = await import('pg');
    const { readdir, readFile } = await import('node:fs/promises');
    const { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb } = await import('./firmDb.js');
    const { batchSuggestTransactionCodingInDb } = await import('./db/coding.js');
    const { sweepCodingAutoPost } = await import('./codingAutoPost.js');
    const { recoverRefusedCodingEvidenceInDb, hasPendingPostingRecoveryWithClient } = await import('./db/codingRefusalRecovery.js');
    const { recoverChangedCodingEvidenceInDb, currentCodingEvidence, codingEvidenceDigest } = await import('./db/codingEvidence.js');
    const { recordRefusalViaDb } = await import('./ledgerAutoPost.js');
    const { installConvergenceSettleOnPool } = await import('./reconcileConvergenceState.js');
    const { buildCaseHealth } = await import('./caseHealth.js');
    const { buildBlockerView } = await import('../../src/lib/caseHealthView.js');
    const { readReconcileActivityWithClient } = await import('./db/reconcileActivity.js');
    const { rowToTransactionPayload } = await import('./db/transactions.js');
    const { toIsoDay } = await import('./dates.js');
    const name = `donna_jev_fi_matched_unsure_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    installConvergenceSettleOnPool(pool);
    const closed = [];
    pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    const savedFetch = globalThis.fetch;
    __setFirmDbPoolForTests(pool);
    try {
      await pool.query(`create schema storage;
        create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects (id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
      const root = new URL('../../db/migrations/', import.meta.url);
      for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
      const firmId = 'jev-firm', clientId = 'jev-company';
      await pool.query("insert into firms(id,name,slug) values('jev-firm','Jev FI Matched Unsure Test','jev-fi-matched-unsure')");
      await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
        values('jev-company','jev-firm','Kampaamo Oy','FI','fi-oy','{"jurisdiction":"fi","accounting_system":"none","alv_registration":{"status":"registered","registered_from":"2020-01-01"}}')`);
      for (const flag of ['JEV_RECONCILIATION', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST', 'FINLAND_ALV_CODING']) {
        await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'jev-firm','jev-company',$1,'auto','manual')`, [flag]);
      }
      await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('trial-member','jev-firm','fixture@example.invalid','Fixture','admin','active')");
      const { enrollJevExperiment } = await import('./jevExperimentPolicy.js');
      const enrollment = await pool.connect();
      try { await enrollJevExperiment({ client: enrollment, firmId, clientId, actorId: 'trial-member', authorityBasis: 'Synthetic matched-unsure proof', trialId: 'matched-unsure-proof', expiresAt: '2100-01-01', model: process.env.TYPESAFE_MODEL }); }
      finally { enrollment.release(); }
      await pool.query(`insert into ledger_accounts(id,firm_id,client_id,name,account_type,tax_type,status,currency) values
        ('telecom-account','jev-firm','jev-company','Telecommunications','expense','ALV_25_5_INPUT','active','EUR'),
        ('meals-account','jev-firm','jev-company','Utilities','expense','ALV_25_5_INPUT','active','EUR')`);
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload) values
        ('telecom','jev-firm','jev-company','2025-02-10','SUOMEN TELEYHTYMA OY',59.32,'EUR','needs_review','{}'),
        ('kiosk','jev-firm','jev-company','2025-02-12','R-KIOSKI TAMPERE',20.00,'EUR','needs_review','{}'),
        ('google','jev-firm','jev-company','2025-02-06','GOOGLE *WORKSPACE GOOGLE.COM IE',13.60,'EUR','needs_review','{}'),
        ('hesburger','jev-firm','jev-company','2025-02-14','HESBURGER TAMPERE KOSKIK.',12.90,'EUR','needs_review','{}')`);
      await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency,storage_bucket,storage_object_key) values
        ('telecom-invoice','jev-firm','jev-company','teleyhtyma-02-2025.pdf','supplier_bill','completed','2025-02-10',59.32,12.05,'EUR','fixture','telecom'),
        ('kiosk-receipt','jev-firm','jev-company','r-kioski.pdf','receipt','completed','2025-02-12',20.00,3.00,'EUR','fixture','kiosk'),
        ('receipt','jev-firm','jev-company','hesburger.pdf','receipt','completed','2025-02-14',12.90,1.58,'EUR','fixture','hesburger')`);
      await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence) values
        ('match-telecom','jev-firm','jev-company','telecom','supplier_bill','telecom-invoice','auto_matched',59.32,1),
        ('match-kiosk','jev-firm','jev-company','kiosk','receipt','kiosk-receipt','auto_matched',20.00,1),
        ('match-hesburger','jev-firm','jev-company','hesburger','receipt','receipt','auto_matched',12.90,1)`);
      const calls = [];
      let sawVerifiedSource = false;
      globalThis.fetch = async (endpoint, init) => {
        const request = JSON.parse(init.body);
        const jev = String(endpoint).includes('typesafe');
        const focal = jev ? request.state?.transaction : JSON.parse(request.input)?.transaction;
        const line = /TELEYHTYMA|ELISA|DNA/.test(focal?.description) ? 'telecom' : /KIOSKI/.test(focal?.description) ? 'kiosk'
          : /GOOGLE/.test(focal?.description) ? 'google' : /HESBURGER/.test(focal?.description) ? 'hesburger' : `unknown:${focal?.description}`;
        calls.push(`${jev ? 'jev' : 'strong'}:${line}`);
        if (jev) return response(fiTyped(request, line === 'hesburger' ? { decision: 'resolved', account: 'Utilities', tax: 'ALV 14 %' } : { decision: 'reasoning_judgment' }));
        assert.notEqual(line, 'hesburger', 'only the reasoning handoff reaches the strong coder');
        if (focal?.posting_recovery?.source_verified === true) sawVerifiedSource = true;
        // Judgment work with the source in hand, and again after the source re-read: the strong coder still cannot settle it.
        // With the verified source in hand the telecom coder also writes its own owner question; it is never sent.
        const ownQuestion = focal?.posting_recovery?.source_verified === true && /TELEYHTYMA|ELISA/.test(focal?.description);
        return strongResponse({ proposed_account: line === 'telecom' ? 'Telecommunications' : 'Utilities', tax_treatment: 'ALV-tarkistus', confidence: 'high',
          evidence_required: ownQuestion, ...(ownQuestion ? { ask_client_question: `Which VAT rate applies to ${focal.description}?` } : {}),
          posting_requirement: 'single_account', support_note: 'Subscription charge.' });
      };
      // What each file prints on its independent re-read. The telecom invoice
      // and the Elisa invoice print a clear 25.5 % (12.05 on 47.27, 8.49 on
      // 33.31); the kiosk receipt and the DNA invoice print a VAT amount that
      // implies no Finnish rate in force (3.00 on 17.00, 5.00 on 25.00).
      const printedLines = { 'telecom-invoice': [{ description: 'Liittymä 02/2025', amount: 47.27, tax_rate: 25.5 }], 'kiosk-receipt': [],
        'legacy-clear-invoice': [{ description: 'Mobiililiittymä 02/2025', amount: 33.31, tax_rate: 25.5 }], 'legacy-unclear-invoice': [] };
      let rereads = 0;
      const rereadFn = async ({ context }) => { rereads += 1; return { kind: 'completed', model: 'fixture-source-reader',
        header: { total_amount: Number(context.source.total_amount), currency: 'EUR', document_date: toIsoDay(context.source.document_date) },
        summary: { tax_amount: Number(context.source.tax_amount), subtotal_amount: Number(context.source.total_amount) - Number(context.source.tax_amount), warnings: [] },
        lines: printedLines[context.source.id] }; };
      const row = async id => (await pool.query('select * from transactions where id=$1', [id])).rows[0];
      const journals = async () => (await pool.query('select source_id from ledger_journals order by source_id')).rows.map(r => r.source_id);
      const asksFor = async id => (await pool.query('select status,evidence_type,question,send_count from client_evidence_requests where transaction_id=$1', [id])).rows;
      // The named rest, as the display reads it: case health and the activity projection.
      const assertNamedRest = async (id) => {
        const rested = await row(id);
        assert.equal(rested.coding_state, 'applied');
        assert.equal(rested.convergence_state, 'hanging', 'never reconciled, never on the owner');
        assert.equal(rested.convergence_reason, 'ledger_post_refused:TRANSACTION_ALV_TREATMENT_UNRESOLVED');
        assert.equal(rested.payload.posting_recovery.state, 'reconsidered');
        assert.deepEqual(await asksFor(id), [], 'no owner question');
        const health = buildCaseHealth({ transaction: rowToTransactionPayload(rested) });
        assert.equal(health.phase, 'stuck', 'not "retrying": no worker owns it');
        assert.equal(health.blocker.detail.failure, 'TRANSACTION_ALV_TREATMENT_UNRESOLVED');
        assert.equal(health.blocker.detail.cause, 'coder_left_printed_treatment_unsettled');
        assert.equal(health.blocker.detail.source_tax.clear, true);
        assert.deepEqual(health.recovery, { class: null, basis: 'coder_left_printed_treatment_unsettled' });
        assert.match(buildBlockerView(health.blocker).detail, /^ledger_post — TRANSACTION_ALV_TREATMENT_UNRESOLVED · coder left printed treatment unsettled · /);
        const client = await pool.connect();
        try {
          const transactions = (await client.query('select * from transactions order by id')).rows;
          const documents = (await client.query('select * from documents order by id')).rows;
          const matches = (await client.query('select * from reconciliation_matches order by id')).rows;
          for (const observedAt of [new Date().toISOString(), new Date(Date.now() + 2 * 60 * 60_000).toISOString()]) {
            const activity = (await readReconcileActivityWithClient(client, { firmId, transactions, documents, matches, observedAt })).get(id);
            assert.equal(activity?.state, 'failed', `a named failure, not in progress (${observedAt})`);
            assert.equal(activity.reason_code, 'coder_left_printed_treatment_unsettled', 'the named cause, never processing_cycle_expired');
            assert.equal(activity.refusal_code, 'TRANSACTION_ALV_TREATMENT_UNRESOLVED');
          }
        } finally { client.release(); }
      };

      // First coding: the matched sources have no printed components yet, so the marker is applied and refused.
      await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId], limit: 10, autoApply: true });
      for (const id of ['telecom', 'kiosk']) {
        const refused = await row(id);
        assert.equal(refused.payload.ledger_post_refusal?.code, 'TRANSACTION_ALV_TREATMENT_UNRESOLVED', JSON.stringify(refused.payload.ai_suggestion));
      }
      const legacyShape = (await row('telecom')).payload.ai_suggestion;
      // The source-recheck lane re-reads each file once; its printed tax agrees, so the coder owns the lines again.
      assert.deepEqual((await recoverRefusedCodingEvidenceInDb({ firmId, rereadFn, limit: 10 })).map(r => [r.transaction_id, r.state]).sort(),
        [['kiosk', 'reconsidered'], ['telecom', 'reconsidered']]);
      await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId], limit: 10, autoApply: true });
      assert.equal(sawVerifiedSource, true, 'the recode sees the verified source');

      // Clear printed VAT: the coding keeps its answer with the named cause; the ledger refuses it; no ask.
      const clearCoding = (await row('telecom')).payload.ai_suggestion;
      assert.equal(clearCoding.tax_treatment, 'ALV-tarkistus', 'the treatment is never laundered into a rate');
      assert.equal(clearCoding.posting_requirement, 'single_account');
      assert.equal(clearCoding.tax_unresolved_guard.constraint, 'unsure_treatment_clear_source');
      assert.equal(clearCoding.tax_unresolved_guard.cause, 'coder_left_printed_treatment_unsettled');
      assert.deepEqual(clearCoding.tax_unresolved_guard.source_tax, { clear: true, total: 59.32, tax: 12.05, rates: [25.5] });
      assert.equal(clearCoding.tax_unresolved_guard.suppressed_question, 'Which VAT rate applies to SUOMEN TELEYHTYMA OY?', 'the model\'s own question is receipted, not sent');
      assert.equal(clearCoding.evidence_required, false);
      // Inconsistent printed VAT: the genuine source discrepancy.
      const discrepancy = await row('kiosk');
      assert.equal(discrepancy.coding_state, 'proposed');
      assert.equal(discrepancy.payload.ledger_post_refusal, undefined, 'the marker never reaches the posting policy a second time');
      assert.equal(discrepancy.payload.ai_suggestion.posting_requirement, 'document_discrepancy');
      assert.equal(discrepancy.payload.ai_suggestion.tax_unresolved_guard.constraint, 'unsure_treatment_unclear_source');
      assert.equal(discrepancy.payload.ai_suggestion.tax_unresolved_guard.source_tax.reason, 'source_vat_implies_no_rate_in_force');
      await sweepCodingAutoPost({ firmId, clientId });

      const kiosk = await row('kiosk');
      assert.equal(kiosk.coding_state, 'asked');
      assert.equal(kiosk.convergence_state, 'on_owner');
      const asks = (await pool.query("select transaction_id,status,evidence_type,question,send_count from client_evidence_requests order by transaction_id")).rows;
      assert.deepEqual(asks.map(a => [a.transaction_id, a.status, a.evidence_type, Number(a.send_count)]),
        [['google', 'draft', 'supporting_document', 0], ['kiosk', 'draft', 'document_discrepancy', 0]]);
      const kioskAsk = asks.find(a => a.transaction_id === 'kiosk').question;
      assert.match(kioskAsk, /r-kioski\.pdf/); assert.match(kioskAsk, /20\.00 EUR/); assert.match(kioskAsk, /3\.00 EUR/);
      assert.doesNotMatch(kioskAsk, /business purpose/i, 'a source-grounded question, never a generic purpose question');
      assert.match(asks.find(a => a.transaction_id === 'google').question, /invoice, receipt or notice/);
      assert.equal((await row('hesburger')).coding_state, 'posted', 'the matched receipt with a clear printed tax posts with no ask');
      assert.deepEqual(await journals(), ['hesburger']);
      const hesburgerLines = (await pool.query(`select a.name,l.debit,l.credit,l.tax_type from ledger_lines l join ledger_accounts a on a.id=l.account_id
        join ledger_journals j on j.id=l.journal_id where j.source_id='hesburger' order by l.line_no`)).rows;
      assert.deepEqual(hesburgerLines.map(l => [l.name, Number(l.debit), Number(l.credit)]), [['Utilities', 11.32, 0], [hesburgerLines[1].name, 1.58, 0], [hesburgerLines[2].name, 0, 12.90]]);
      assert.equal(hesburgerLines[0].tax_type, 'ALV_14_INPUT');

      await assertNamedRest('telecom');
      // A repeat sweep of every worker does not cycle the named row: no re-read, no recode, no ask.
      const strongCalls = calls.filter(c => c === 'strong:telecom').length;
      assert.equal((await recoverRefusedCodingEvidenceInDb({ firmId, rereadFn, limit: 10 })).length, 0);
      assert.equal((await recoverChangedCodingEvidenceInDb({ firmId })).length, 0, 'the clock never re-admits a clear-source row');
      await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId], limit: 10, autoApply: true });
      await sweepCodingAutoPost({ firmId, clientId });
      assert.equal(calls.filter(c => c === 'strong:telecom').length, strongCalls, 'no recode');
      assert.equal(rereads, 2, 'one source re-read per matched line');
      await assertNamedRest('telecom');

      // Rows already resting under the old contract: re-read settled, marker applied again, refused, no worker owns them.
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload) values
        ('legacy-clear','jev-firm','jev-company','2025-02-10','ELISA OYJ',41.80,'EUR','needs_review','{}'),
        ('legacy-unclear','jev-firm','jev-company','2025-02-10','DNA OYJ',30.00,'EUR','needs_review','{}')`);
      await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency,storage_bucket,storage_object_key) values
        ('legacy-clear-invoice','jev-firm','jev-company','elisa-02-2025.pdf','supplier_bill','completed','2025-02-10',41.80,8.49,'EUR','fixture','legacy-clear'),
        ('legacy-unclear-invoice','jev-firm','jev-company','dna-02-2025.pdf','supplier_bill','completed','2025-02-10',30.00,5.00,'EUR','fixture','legacy-unclear')`);
      await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence) values
        ('match-legacy-clear','jev-firm','jev-company','legacy-clear','supplier_bill','legacy-clear-invoice','auto_matched',41.80,1),
        ('match-legacy-unclear','jev-firm','jev-company','legacy-unclear','supplier_bill','legacy-unclear-invoice','auto_matched',30.00,1)`);
      const applyLegacyMarker = async (id) => {
        const evidence = await currentCodingEvidence({ client: pool, firmId, clientId, transactionId: id });
        await pool.query("update transactions set coding_state='applied',payload=payload || $2::jsonb where id=$1",
          [id, JSON.stringify({ ai_suggestion_status: 'auto_applied', ai_suggestion: { ...legacyShape, tax_unresolved_guard: undefined, case_evidence_digest: undefined, evidence_digest: codingEvidenceDigest(evidence) } })]);
        const refusal = await postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun: false }).then(() => null, error => error);
        assert.equal(refusal?.code, 'TRANSACTION_ALV_TREATMENT_UNRESOLVED', refusal?.message);
        await recordRefusalViaDb({ firmId, clientId, transactionId: id, error: refusal });
      };
      for (const id of ['legacy-clear', 'legacy-unclear']) await applyLegacyMarker(id);
      assert.deepEqual((await recoverRefusedCodingEvidenceInDb({ firmId, rereadFn, limit: 10 })).map(r => r.transaction_id).sort(), ['legacy-clear', 'legacy-unclear']);
      for (const id of ['legacy-clear', 'legacy-unclear']) {
        await applyLegacyMarker(id);
        assert.equal(await hasPendingPostingRecoveryWithClient(pool, firmId, id), false, 'the re-read lane is settled for this source');
        assert.equal((await row(id)).payload.posting_recovery.state, 'reconsidered');
      }
      // Neither legacy coding carries the fork's receipt, so the existing evidence clock re-admits each once,
      // carrying the verified re-read forward so the coder's contract decides it; no second re-read.
      assert.deepEqual((await recoverChangedCodingEvidenceInDb({ firmId })).map(r => r.transaction_id).sort(), ['legacy-clear', 'legacy-unclear']);
      for (const id of ['legacy-clear', 'legacy-unclear']) {
        const readmitted = await row(id);
        assert.equal(readmitted.coding_state, 'proposed');
        assert.equal(readmitted.payload.coding_evidence_reconsideration.attempts, 1);
        assert.equal(readmitted.payload.posting_recovery.review.source_verified, true);
      }
      await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId], limit: 10, autoApply: true });
      await sweepCodingAutoPost({ firmId, clientId });
      assert.equal(rereads, 4, 'the legacy rows spent no further source re-read');
      assert.equal((await row('legacy-unclear')).coding_state, 'asked');
      const legacyAsks = await asksFor('legacy-unclear');
      assert.equal(legacyAsks.length, 1); assert.equal(legacyAsks[0].evidence_type, 'document_discrepancy'); assert.equal(Number(legacyAsks[0].send_count), 0);
      assert.match(legacyAsks[0].question, /dna-02-2025\.pdf/);
      // The clear legacy row now carries the named cause, rests on it, visible as that cause, and is never re-admitted.
      assert.deepEqual((await row('legacy-clear')).payload.ai_suggestion.tax_unresolved_guard.source_tax, { clear: true, total: 41.8, tax: 8.49, rates: [25.5] });
      assert.equal((await row('legacy-clear')).payload.ai_suggestion.tax_unresolved_guard.suppressed_question, 'Which VAT rate applies to ELISA OYJ?');
      await assertNamedRest('legacy-clear');
      assert.equal((await recoverChangedCodingEvidenceInDb({ firmId })).length, 0, 'neither legacy row is re-admitted again');
      assert.deepEqual(await journals(), ['hesburger'], 'no line with the unsure marker ever posts');
      assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where status in ('draft','open')")).rows[0].n, 3, 'a normal retry does not duplicate a question');
    } finally {
      globalThis.fetch = savedFetch;
      __resetFirmDbPoolForTests();
      await pool.end(); await Promise.all(closed);
      await admin.query(`drop database "${name}"`); await admin.end();
    }
  }));
