// HELMIKUU S8: one owner answer may confirm all the remaining held rows of a
// statement. The scope is the strong model's closed choice through the typed
// owner-reply interpreter; the proof runs the real question writer and the real
// reply consumer on PostgreSQL with synthetic transports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { decideHeldRowScope, heldRowScopeAdapter } from './heldRowScope.js';
import { __jevReconciliation } from './jevReconciliation.js';
import { decideJevReconciliation } from './jevRuntimeDecision.js';
import { runPayoutReconciliationLlmForDocument } from './payoutReconciliationLlm.js';
import { __createHeldMatchPortalAsksWithClient, resolveClientEvidenceRequestInDb } from './db/asks.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';

const SCOPE_TOOL = 'interpret_owner_reply';
const scopeResponse = input => new Response(JSON.stringify({ model: 'fixture-strong-scope-model', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: SCOPE_TOOL, input }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
const siblings = [{ line_no: 3, line_description: 'Settlement 3', date: '2026-09-04', amount: '2600.00', currency: 'EUR', direction: 'received' }];

test('the scope is a closed choice read by the typed owner-reply interpreter, and fails closed to this row', async () => {
  const request = { id: 'ask-scope', question: 'About EUR 1600.00 received … You can confirm all the remaining rows at once.' };
  const decide = (fetchImpl, env = { ANTHROPIC_API_KEY: 'fixture' }) => decideHeldRowScope({ request, reply: 'Yes', siblings, env, fetchImpl });
  let seen = null;
  const all = await decide(async (url, init) => { seen = JSON.parse(init.body); return scopeResponse({ answer: 'all_remaining_rows', confidence: 0.97, clarification: null }); });
  assert.deepEqual(all, { scope: 'all_remaining_rows', acts_on: 'all_remaining_rows', model: 'fixture-strong-scope-model',
    prompt_version: 'structured-owner-reply.v1', confidence: 0.97 });
  assert.deepEqual(seen.tools[0].input_schema.properties.answer.anyOf[0], heldRowScopeAdapter.answerSchema, 'the answer is the closed scope enum');
  assert.deepEqual(JSON.parse(seen.messages[0].content).other_held_rows, siblings, 'the model reads the rows the owner was shown');
  assert.equal((await decide(async () => scopeResponse({ answer: 'this_row_only', confidence: 0.95, clarification: null }))).acts_on, 'this_row_only');
  const unclear = await decide(async () => scopeResponse({ answer: null, confidence: 0.4, clarification: 'Does that include row 3?' }));
  assert.deepEqual([unclear.scope, unclear.acts_on, unclear.model], ['unclear', 'this_row_only', 'fixture-strong-scope-model']);
  assert.deepEqual([(await decide(async () => scopeResponse({ answer: 'unclear', confidence: 0.95, clarification: null }))).acts_on], ['this_row_only']);
  for (const [fetchImpl, env] of [[async () => new Response('{}', { status: 500 })], [async () => { throw new Error('network down'); }],
    [async () => scopeResponse({ answer: 'every_row_of_every_statement', confidence: 0.99, clarification: null })],
    [async () => { throw new Error('unreachable'); }, {}]]) {
    const failed = await decide(fetchImpl, env);
    assert.equal(failed.scope, 'unclear'); assert.equal(failed.acts_on, 'this_row_only'); assert.ok(failed.failure, JSON.stringify(failed));
  }
});

test('real PG: a held statement row question names its siblings, and one answer may confirm the rest', { skip: !process.env.DONNA_PG_TEST_URL }, async t => {
  const name = `donna_held_row_scope_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  __setFirmDbPoolForTests(pool);
  const saved = { decide: __jevReconciliation.decide, fetch: globalThis.fetch,
    env: Object.fromEntries(['RECONCILIATION_AUTO_MATCH_POLICY', 'RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
      .map(key => [key, process.env[key]])) };
  Object.assign(process.env, { RECONCILIATION_AUTO_MATCH_POLICY: '1', RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING: '1000',
    ANTHROPIC_API_KEY: 'fixture', OPENAI_API_KEY: 'fixture' });
  t.after(async () => {
    __jevReconciliation.decide = saved.decide; globalThis.fetch = saved.fetch;
    for (const [key, value] of Object.entries(saved.env)) { if (value == null) delete process.env[key]; else process.env[key] = value; }
    __resetFirmDbPoolForTests(); await pool.end();
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
  await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','held-row-scope');
    insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values('c','f','Synthetic company','fi','fi-oy','{"jurisdiction":"fi","accounting_system":"none"}');
    insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');
    insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason) values('pilot','f','c','INTERNAL_PILOT_ACCESS','canary','manual','donna.fi-hosted-pilot.v1')`);
  for (const flag of ['JEV_RECONCILIATION', 'RECONCILIATION_AUTO_MATCH', 'RECONCILIATION_EXACT_MATCH_BACKSTOP', 'CODING_AUTO_POST', 'JEV_HELD_PLAN_COMPLETION'])
    await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')", [flag]);

  // Five payout statements. Each row above the 1000 ceiling is held on its own.
  const statements = {
    all: [1600, 600, 2600, 1800], changed: [1700, 700, 2700, 1900],
    only: [1610, 610, 2610], unclear: [1620, 620, 2620], failure: [1630, 630, 2630] };
  for (const [key, amounts] of Object.entries(statements)) {
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,parse_summary,payload)
      values($1,'f','c',$2,'payout_statement','completed','2026-09-01',$3,'EUR','{}','{}')`, [`${key}-payout`, `${key}-payout.pdf`, total]);
    for (const [i, amount] of amounts.entries()) {
      await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,'f','c',$2,$3,$4,$5,$6)`,
        [`${key}-row-${i + 1}`, `${key}-payout`, i + 1, `Settlement ${i + 1}`, amount, { raw_extraction: { settlement_row: { gross: amount + 10, fees: 10, net: amount } } }]);
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
        values($1,'f','c',$2,$3,$4,0,'EUR','needs_review','proposed','{}')`, [`${key}-bank-${i + 1}`, `2026-09-0${i + 2}`, `Processor settlement ${i + 1}`, amount]);
    }
  }
  let jevDecisions = 0;
  __jevReconciliation.decide = args => { jevDecisions += 1; return decideJevReconciliation({ ...args, provider: async request => ({ model: 'fixture-jev-model',
    answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) =>
      [key, { choice: Object.keys(question.criteria).find(k => k.startsWith('candidate_')), probability: 0.95 }])) }) }); };
  const client = await pool.connect();
  try {
  for (const key of Object.keys(statements)) {
    const stats = await runPayoutReconciliationLlmForDocument({ client, firmId: 'f', clientId: 'c', documentId: `${key}-payout` });
    assert.equal(stats.jev_reason, 'jev_match_held_for_authority', `${key}: ${JSON.stringify(stats)}`);
  }
  const rows = (sql, params) => pool.query(sql, params).then(result => result.rows);
  const states = key => rows(`select bank_transaction_id,status from reconciliation_matches where matched_object_id=$1 order by bank_transaction_id`, [`${key}-payout`])
    .then(result => result.map(match => [match.bank_transaction_id, match.status]));
  assert.deepEqual(await states('all'), [['all-bank-1', 'suggested'], ['all-bank-2', 'auto_matched'], ['all-bank-3', 'suggested'], ['all-bank-4', 'suggested']]);

  // The real question writer, until every held row has its question.
  const mint = async () => { const minted = []; for (let round = 0, batch; (batch = await __createHeldMatchPortalAsksWithClient({ client, firmId: 'f', clientId: 'c' })).length; round++) { assert.ok(round < 5, `the question writer settles: ${batch}`); minted.push(...batch); } return minted; };
  await mint();
  const askFor = async transactionId => (await rows(`select * from client_evidence_requests where transaction_id=$1 and status in ('draft','open') order by id`, [transactionId]))[0];
  const first = await askFor('all-bank-1');
  assert.match(first.question, /Tämä maksu on tiliotteen rivi 1 ”Settlement 1”\. Myös 2 muuta saman tiliotteen riviä odottaa vahvistustasi: rivi 3 ”Settlement 3”, 2600,00 EUR saatu 4\.9\.2026; rivi 4 ”Settlement 4”, 1800,00 EUR saatu 5\.9\.2026\. Voit vahvistaa kaikki jäljellä olevat rivit kerralla vastauksessasi tai vastata rivi kerrallaan\.$/);
  assert.deepEqual(first.request_payload.held_match_siblings.map(row => [row.transaction_id, row.line_no, row.amount, row.date]),
    [['all-bank-3', 3, '2600.00', '2026-09-04'], ['all-bank-4', 4, '1800.00', '2026-09-05']]);
  assert.match((await askFor('all-bank-4')).question, /rivi 1 ”Settlement 1”, 1600,00 EUR saatu 2\.9\.2026; rivi 3 ”Settlement 3”/, 'every held row names its siblings');
  assert.equal((await askFor('all-bank-2')), undefined, 'a settled row has no question');

  // Synthetic transports: the reply coder (OpenAI) and the scope reader (Anthropic).
  const calls = { coder: 0, scope: 0 };
  globalThis.fetch = async (endpoint, init) => {
    if (/api\.openai\.com/.test(String(endpoint))) {
      calls.coder += 1;
      return { ok: true, status: 200, json: async () => ({ id: 'fixture-coder', output_text: JSON.stringify({
        proposed_account: 'Sales', contact: 'Synthetic processor', tax_treatment: 'Ei ALV-käsittelyä', support_note: 'The owner confirms the statement row.',
        ask_client_question: '', evidence_required: false, remember_candidate: false, merchant_pattern: '', missing_account_name: '', missing_account_type: '',
        missing_account_reason: '', auto_explain_limit: 0, confidence: 'high', materiality: 'material', reasoning: 'Confirmed by the owner.', warnings: [], alternatives: [] }) }) };
    }
    assert.match(String(endpoint), /api\.anthropic\.com/, 'only the synthetic coder and scope reader may be called');
    calls.scope += 1;
    const reply = JSON.parse(JSON.parse(init.body).messages[0].content).reply;
    if (/network/.test(reply)) return new Response('{}', { status: 503 });
    return scopeResponse(/all of them/.test(reply) ? { answer: 'all_remaining_rows', confidence: 0.97, clarification: null }
      : /only this/.test(reply) ? { answer: 'this_row_only', confidence: 0.96, clarification: null }
        : { answer: null, confidence: 0.3, clarification: 'Do you mean the other rows too?' });
  };
  const answer = async (transactionId, reply) => resolveClientEvidenceRequestInDb({ firmId: 'f', evidenceRequestId: (await askFor(transactionId)).id,
    reply, actorId: 'member', actorType: 'firm_member', answerSource: 'phone' });
  const evaluation = async key => (await rows(`select verdict,payload from reconciliation_evaluations where target_id=$1 and matcher_family='payout_statement'
    order by evaluated_at desc, id desc limit 1`, [`${key}-payout`]))[0];

  // 1. "All of them": every named held row settles, one owner receipt each.
  const firstAskId = first.id;
  await answer('all-bank-1', 'Yes, all of them are settlements from this statement.');
  assert.deepEqual(calls, { coder: 1, scope: 1 }, 'one coder call and one scope call; the siblings buy no model call');
  assert.deepEqual(await states('all'), [['all-bank-1', 'auto_matched'], ['all-bank-2', 'auto_matched'], ['all-bank-3', 'auto_matched'], ['all-bank-4', 'auto_matched']]);
  for (const id of ['all-bank-1', 'all-bank-3', 'all-bank-4']) {
    const { payload } = (await rows(`select payload from reconciliation_matches where bank_transaction_id=$1`, [id]))[0];
    assert.ok(payload.authorization.reasons.includes('owner_confirmed_held_match'), id);
    assert.equal(payload.owner_confirmation.actor_id, 'member', id);
    assert.equal(payload.owner_confirmation.evidence_request_id, firstAskId, `${id}: the answer's own question id`);
    assert.equal(payload.owner_confirmation.scope_decision.model, 'fixture-strong-scope-model', `${id}: the scope model id is in the receipt`);
    assert.equal(payload.owner_confirmation.scope_decision.scope, 'all_remaining_rows');
  }
  assert.equal((await rows(`select payload from reconciliation_matches where bank_transaction_id='all-bank-3'`))[0].payload.owner_confirmation.answered_bank_transaction_id, 'all-bank-1');
  assert.equal((await rows(`select count(*)::int n from audit_events where action='reconciliation_match.owner_confirmed' and metadata->>'evidence_request_id'=$1`, [firstAskId]))[0].n, 3);
  for (const id of ['all-bank-3', 'all-bank-4']) {
    const [ask] = await rows(`select status,resolved_by,response_payload from client_evidence_requests where transaction_id=$1`, [id]);
    assert.deepEqual([ask.status, ask.resolved_by, ask.response_payload.confirmed_by_evidence_request_id], ['resolved', 'member', firstAskId], `${id}: its own question is answered`);
  }
  // The answered rows no longer rest on the owner: their coding is Donna's
  // again, for the existing coding-evidence recovery and coder.
  assert.deepEqual(await rows(`select id,coding_state,convergence_state,convergence_reason from transactions where id in ('all-bank-3','all-bank-4') order by id`),
    ['all-bank-3', 'all-bank-4'].map(id => ({ id, coding_state: 'proposed', convergence_state: 'hanging', convergence_reason: 'coding_state:proposed' })));
  const allDone = await evaluation('all');
  assert.deepEqual([allDone.verdict, allDone.payload.execution, allDone.payload.next_action], ['proposed', 'existing_reconciliation_writer', null], 'the plan completes');
  const recode = (await rows(`select metadata from audit_events where action='transaction.reply_recode' and resource_id='all-bank-1'`))[0].metadata;
  assert.equal(recode.held_row_scope.model, 'fixture-strong-scope-model');
  assert.deepEqual(recode.remaining_rows.map(row => [row.transaction_id, row.reason]), [['all-bank-3', null], ['all-bank-4', null]]);
  // A retry duplicates nothing: no new question, no new match, no new receipt.
  const before = await rows(`select id,status,match_amount,payload->'owner_confirmation' c from reconciliation_matches where matched_object_id like 'all-%' order by id`);
  assert.deepEqual((await mint()).filter(id => id.includes('all')), []);
  assert.equal((await rows(`select count(*)::int n from client_evidence_requests where transaction_id like 'all-%' and status in ('draft','open')`))[0].n, 0);
  assert.deepEqual(await rows(`select id,status,match_amount,payload->'owner_confirmation' c from reconciliation_matches where matched_object_id like 'all-%' order by id`), before);

  // 2. "Only this one": one row settles; the other keeps its own question.
  await answer('only-bank-1', 'Yes, only this payment for now.');
  assert.deepEqual(await states('only'), [['only-bank-1', 'auto_matched'], ['only-bank-2', 'auto_matched'], ['only-bank-3', 'suggested']]);
  assert.equal((await askFor('only-bank-3')).status, 'draft', 'the other row keeps its own open question');
  assert.equal((await evaluation('only')).payload.execution, 'held_for_authority');
  await mint();
  assert.equal((await askFor('only-bank-3')).request_payload.held_match_siblings.length, 0, 'its refreshed draft no longer names a settled row');
  assert.doesNotMatch((await askFor('only-bank-3')).question, /saman tiliotteen rivi/);
  await answer('only-bank-3', 'Yes, this one too.');
  assert.deepEqual(await states('only'), [['only-bank-1', 'auto_matched'], ['only-bank-2', 'auto_matched'], ['only-bank-3', 'auto_matched']], 'row by row still completes');

  // 3. An unclear answer and 4. a scope-provider failure act on their own row only.
  const scopeCalls = calls.scope;
  await answer('unclear-bank-1', 'Yes, that one is right I think.');
  await answer('failure-bank-1', 'Yes (network test).');
  assert.equal(calls.scope, scopeCalls + 2);
  for (const key of ['unclear', 'failure']) {
    assert.deepEqual(await states(key), [[`${key}-bank-1`, 'auto_matched'], [`${key}-bank-2`, 'auto_matched'], [`${key}-bank-3`, 'suggested']], key);
    assert.equal((await askFor(`${key}-bank-3`)).status, 'draft', key);
    const scope = (await rows(`select payload from reconciliation_matches where bank_transaction_id=$1`, [`${key}-bank-1`]))[0].payload.owner_confirmation.scope_decision;
    assert.equal(scope.acts_on, 'this_row_only', key);
  }
  assert.ok((await rows(`select payload from reconciliation_matches where bank_transaction_id='failure-bank-1'`))[0].payload.owner_confirmation.scope_decision.failure, 'a provider failure is receipted');

  // 5. A named row whose facts changed after the question is handed back to
  // Jev and keeps its own question; it does not block the other rows.
  await pool.query(`update transactions set money_in=1950 where id='changed-bank-4'`);
  await answer('changed-bank-1', 'Yes, all of them are settlements from this statement.');
  assert.deepEqual(await states('changed'), [['changed-bank-1', 'auto_matched'], ['changed-bank-2', 'auto_matched'], ['changed-bank-3', 'auto_matched'], ['changed-bank-4', 'suggested']]);
  assert.equal((await askFor('changed-bank-4')).status, 'draft', 'the changed row keeps its own question');
  assert.equal((await rows(`select status from client_evidence_requests where transaction_id='changed-bank-3'`))[0].status, 'resolved');
  const handedBack = await evaluation('changed');
  assert.deepEqual([handedBack.verdict, handedBack.payload.next_action], ['no_match', 'reconsider_current_evidence'], 'Jev gets the plan back');
  assert.deepEqual(handedBack.payload.owner_confirmation.refused_rows.map(row => [row.transaction_id, row.refusal]), [['changed-bank-4', 'JEV_ROW_CHANGED_SINCE_QUESTION']]);
  assert.equal((await rows(`select count(*)::int n from audit_events where action='reconciliation_match.owner_confirmation_refused' and metadata->>'bank_transaction_id'='changed-bank-4'`))[0].n, 1);

  assert.equal(jevDecisions, Object.keys(statements).length, 'owner confirmations buy no further Jev decision');
  assert.equal((await rows(`select count(*)::int n from reconciliation_authority_grants`))[0].n, 0, 'an owner answer mints no standing grant');
  } finally { client.release(); }
});
