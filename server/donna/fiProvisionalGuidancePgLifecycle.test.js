// FIK-3 provisional arm on a real database: draft (provisional) Finnish guidance
// is inert everywhere in production. With FI_JEV_DECISION_GUIDANCE at canary and
// the draft entries even misplaced in the reviewed set, every resolve owner
// selects v8 with the v7 bytes and the real coder sends no draft claim. A
// suggestion decided inside the harness scope (a provisional receipt) refuses
// at apply and at posting lineage under both v7 and v8. Only provider HTTP is
// replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb,
  updateTransactionReviewItemInDb, __resolveClientCodingPolicyWithClientForTests } from './firmDb.js';
import { resolvePostingContextWithClient, assertPostingSuggestionLineage } from './db/postingPolicyContext.js';
import { codingPolicyReceipt } from './codingPolicy.js';
import { setClientFlagStage } from './clientConfig.js';
import { FI_JEV_DECISION_GUIDANCE_FLAG } from './codingGuidanceVariant.js';
import { FI_POLICY_CLAUSES, __setFiReviewedGuidanceEntriesForTests, __runWithFiProvisionalGuidanceForHarness } from './finland/decisionGuidance.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const CLAIM = 'TEST-ONLY PROVISIONAL FIK-3 CLAIM FOR PASSENGER TRANSPORT.';
const DRAFT = { id: 'FIK-P-TEST-PG', status: 'provisional', author: 'Fixture Author', drafted_on: '2026-09-24', rationale: 'Fixture.',
  claim: CLAIM, covers: ['FI-POST-16'], sources: [{ url: 'https://www.vero.fi/fik3-provisional-fixture', captured_on: null, snapshot_owed: true, effective_from: null, effective_to: null }] };

test('real PG: provisional guidance is inert at every production owner and refuses at apply and posting', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — provisional-guidance lifecycle not exercised'
}, async (t) => {
  const name = `donna_fik3p_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', (connection) => connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-fik3p-key';
  const restoreEntries = __setFiReviewedGuidanceEntriesForTests([DRAFT]);
  t.after(async () => {
    restoreEntries();
    __resetFirmDbPoolForTests();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await pool.end(); await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const firmId = 'fik3p-firm'; const clientId = 'fik3p-client'; const actorId = 'fixture-owner';
  const businessDate = '2025-06-10';
  await pool.query("insert into firms (id,name,slug) values ($1,'FIK-3P fixture','fik3p-fixture')", [firmId]);
  await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
    values ($1,$2,'Fixture Oy','FI','{"jurisdiction":"fi","accounting_system":"none"}')`, [clientId, firmId]);
  const stage = async (value) => {
    const connection = await pool.connect();
    try { await setClientFlagStage(connection, { firmId, clientId, flagKey: FI_JEV_DECISION_GUIDANCE_FLAG, stage: value, reason: 'FIK-3P fixture', actorId }); }
    finally { connection.release(); }
  };
  const codingPolicyNow = () => __resolveClientCodingPolicyWithClientForTests({ client: pool, firmId, clientId, businessDate });
  const postingNow = async () => { const c = await pool.connect(); try { return await resolvePostingContextWithClient({ client: c, firmId, clientId, businessDate }); } finally { c.release(); } };
  const clause = FI_POLICY_CLAUSES['FI-POST-16'].text;

  // 1. The harness scope (and only it) selects the draft at the same owners.
  const v7 = await codingPolicyNow();
  const r7 = codingPolicyReceipt(v7);
  const { result: inside } = await __runWithFiProvisionalGuidanceForHarness([DRAFT], async () => ({ coding: await codingPolicyNow(), posting: await postingNow() }));
  assert.equal(inside.coding.guidanceVariant, 'provisional');
  assert.equal(inside.coding.taxInstructions, v7.taxInstructions.replace(clause, CLAIM));
  const rp = codingPolicyReceipt(inside.coding);
  assert.deepEqual(inside.posting.receipt.coding_policy, rp, 'inside the scope posting re-checks under the same draft lineage');

  // 2. Flag at canary, draft entries misplaced in the reviewed set: v8 with v7 bytes.
  await stage('canary');
  const v8 = await codingPolicyNow();
  assert.equal(v8.guidanceVariant, 'reviewed');
  assert.equal(v8.taxInstructions, v7.taxInstructions, 'a draft entry never renders from the reviewed set');
  const r8 = codingPolicyReceipt(v8);
  const posting8 = await postingNow();
  assert.deepEqual(posting8.receipt.coding_policy, r8);
  assert.throws(() => assertPostingSuggestionLineage(posting8, { ai_suggestion: { coding_policy: rp } }), { code: 'jurisdiction_context_conflict' });

  // 3. Apply refuses a provisional suggestion under v8 and under v7, mutating nothing.
  const seed = async (id, receipt) => {
    const suggestion = { proposed_account: 'Travel', tax_treatment: 'ALV 14 %', confidence: 'high', coding_policy: receipt };
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state,payload)
      values ($1,$2,$3,$4,'Fixture taxi',30,'EUR','needs_review','proposed',$5::jsonb)`, [id, firmId, clientId, businessDate, JSON.stringify({ ai_suggestion: suggestion })]);
    await pool.query(`insert into transaction_review_queue (id,firm_id,client_id,item_type,item_id,reason,priority,status,payload)
      values ($1,$2,$3,'transaction',$4,'fixture','normal','open',$5::jsonb)`, [`review-${id}`, firmId, clientId, id, JSON.stringify({ transaction_id: id })]);
  };
  const read = async (id) => (await pool.query('select * from transactions where id=$1', [id])).rows[0];
  const adopt = (id) => updateTransactionReviewItemInDb({ firmId, reviewItemId: `review-${id}`,
    patch: { status: 'resolved', review_state: 'accepted' }, actorId, returnSnapshot: false, distillFactsFn: async () => [] });
  await seed('tx-provisional', rp);
  const before = await read('tx-provisional');
  await assert.rejects(adopt('tx-provisional'), (error) => error.code === 'jurisdiction_context_conflict');
  assert.deepEqual(await read('tx-provisional'), before);
  await stage('off');
  const posting7 = await postingNow();
  assert.deepEqual(posting7.receipt.coding_policy, r7);
  assert.throws(() => assertPostingSuggestionLineage(posting7, { ai_suggestion: { coding_policy: rp } }), { code: 'jurisdiction_context_conflict' });
  await assert.rejects(adopt('tx-provisional'), (error) => error.code === 'jurisdiction_context_conflict');
  assert.deepEqual(await read('tx-provisional'), before, 'a refused provisional suggestion mutates nothing');

  // 4. The real batch coder at canary: no draft claim in the request, a v8 receipt.
  await stage('canary');
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://api.openai.com/v1/responses', 'no unplanned external request');
    bodies.push(init.body);
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = (input.transactions || [input.transaction]).map((transaction) => ({
      transaction_id: transaction.id, proposed_account: 'Travel', contact: 'Fixture taxi', tax_treatment: 'ALV 14 %',
      support_note: '', ask_client_question: 'Receipt?', evidence_required: true, remember_candidate: false,
      merchant_pattern: '', missing_account_name: '', missing_account_type: '', missing_account_reason: '',
      auto_explain_limit: 0, confidence: 'high', materiality: 'normal', reasoning: 'Fixture.', warnings: [], alternatives: []
    }));
    const output = input.transactions ? { suggestions, group_summary: [] } : suggestions[0];
    return { ok: true, json: async () => ({ id: `fik3p-${bodies.length}`, output_text: JSON.stringify(output) }) };
  });
  await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status)
    values ('tx-code',$1,$2,$3,'FIXTURE TAXI OY',30,'EUR','needs_review')`, [firmId, clientId, businessDate]);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.equal(bodies.length, 1);
  assert.ok(!bodies[0].includes(CLAIM), 'the draft claim never reaches a production request');
  assert.ok(bodies[0].includes(JSON.stringify(clause).slice(1, -1)), 'the v7 clause is sent');
  assert.deepEqual((await read('tx-code')).payload.ai_suggestion.coding_policy, r8);
});
