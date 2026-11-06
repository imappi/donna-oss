// FIK-2 on a real database: FI_JEV_DECISION_GUIDANCE (config plane) selects the
// reviewed Finnish guidance variant at the call owners that already read the
// client's config snapshot, and every writer downstream re-checks under it.
// Only provider HTTP is replaced. With the shipped (empty) reviewed set, the
// flag changes no request byte; it changes only the receipt, and apply and
// posting refuse a suggestion decided under the other variant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb,
  updateTransactionReviewItemInDb, __resolveClientCodingPolicyWithClientForTests } from './firmDb.js';
import { resolvePostingContextWithClient, assertPostingSuggestionLineage } from './db/postingPolicyContext.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { setClientFlagStage } from './clientConfig.js';
import { FI_JEV_DECISION_GUIDANCE_FLAG } from './codingGuidanceVariant.js';
import { FI_POLICY_CLAUSES, __setFiReviewedGuidanceEntriesForTests } from './finland/decisionGuidance.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: the guidance flag selects v7/v8 at every resolve owner; flag off and an empty v8 send identical bytes', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — reviewed-guidance lifecycle not exercised'
}, async (t) => {
  const name = `donna_fik2_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', (connection) => connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-fik2-key';
  t.after(async () => {
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
  const firmId = 'fik2-firm'; const clientId = 'fik2-client'; const actorId = 'fixture-owner';
  const businessDate = '2026-09-05';
  await pool.query("insert into firms (id,name,slug) values ($1,'FIK-2 fixture','fik2-fixture')", [firmId]);
  await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
    values ($1,$2,'Fixture Oy','FI','{"jurisdiction":"fi","accounting_system":"none"}')`, [clientId, firmId]);
  const stage = async (value) => {
    const connection = await pool.connect();
    try { await setClientFlagStage(connection, { firmId, clientId, flagKey: FI_JEV_DECISION_GUIDANCE_FLAG, stage: value, reason: 'FIK-2 fixture', actorId }); }
    finally { connection.release(); }
  };
  const withConnection = async (fn) => { const connection = await pool.connect(); try { return await fn(connection); } finally { connection.release(); } };
  const codingPolicyNow = () => __resolveClientCodingPolicyWithClientForTests({ client: pool, firmId, clientId, businessDate });
  const postingNow = () => withConnection((client) => resolvePostingContextWithClient({ client, firmId, clientId, businessDate }));

  // 1. No flag row: the call owners resolve exactly today's policy and receipt.
  const pure = resolveCodingPolicy({ jurisdiction: 'fi', profileJurisdiction: 'fi', businessDate, accountingSystem: 'none' });
  const v7 = await codingPolicyNow();
  assert.equal(v7.guidanceVariant, null);
  assert.equal(v7.taxInstructions, pure.taxInstructions);
  const r7 = codingPolicyReceipt(v7);
  assert.deepEqual(r7, codingPolicyReceipt(pure));
  assert.ok(!('guidanceDigest' in r7) && !('guidanceVariant' in r7), 'flag off: no new receipt key');
  assert.deepEqual((await postingNow()).receipt.coding_policy, r7);

  // 2. Flag staged for this book: the same bytes, the receipt names the selection.
  await stage('canary');
  const v8 = await codingPolicyNow();
  assert.equal(v8.guidanceVariant, 'reviewed');
  assert.equal(v8.taxInstructions, v7.taxInstructions, 'empty reviewed set: identical guidance bytes');
  assert.equal(v8.policyVersion, v7.policyVersion);
  const r8 = codingPolicyReceipt(v8);
  assert.deepEqual(r8, { ...r7, guidanceVariant: 'reviewed', guidanceDigest: v8.guidanceDigest });
  assert.match(r8.guidanceDigest, /^[0-9a-f]{64}$/);
  const postingV8 = await postingNow();
  assert.deepEqual(postingV8.receipt.coding_policy, r8, 'posting re-checks lineage under the same variant');
  assert.doesNotThrow(() => assertPostingSuggestionLineage(postingV8, { ai_suggestion: { coding_policy: r8 } }));
  assert.throws(() => assertPostingSuggestionLineage(postingV8, { ai_suggestion: { coding_policy: r7 } }),
    { code: 'jurisdiction_context_conflict' });

  // 3. Apply revalidates under the current variant: a v7 decision cannot be
  // adopted while v8 is selected, and a v8 one cannot after it is switched off.
  const seed = async (id, receipt) => {
    const suggestion = { proposed_account: 'Professional fees', tax_treatment: 'ALV 25,5 %', confidence: 'high', coding_policy: receipt };
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state,payload)
      values ($1,$2,$3,$4,'Fixture expense',100,'EUR','needs_review','proposed',$5::jsonb)`,
    [id, firmId, clientId, businessDate, JSON.stringify({ ai_suggestion: suggestion })]);
    await pool.query(`insert into transaction_review_queue (id,firm_id,client_id,item_type,item_id,reason,priority,status,payload)
      values ($1,$2,$3,'transaction',$4,'fixture','normal','open',$5::jsonb)`,
    [`review-${id}`, firmId, clientId, id, JSON.stringify({ transaction_id: id })]);
  };
  const read = async (id) => (await pool.query('select * from transactions where id=$1', [id])).rows[0];
  const adopt = (id) => updateTransactionReviewItemInDb({ firmId, reviewItemId: `review-${id}`,
    patch: { status: 'resolved', review_state: 'accepted' }, actorId, returnSnapshot: false, distillFactsFn: async () => [] });
  await seed('tx-v7', r7);
  await seed('tx-v8', r8);
  await seed('tx-v8-late', r8);
  const beforeStale = await read('tx-v7');
  await assert.rejects(adopt('tx-v7'), (error) => error.code === 'jurisdiction_context_conflict');
  assert.deepEqual(await read('tx-v7'), beforeStale, 'a refused variant mismatch mutates nothing');
  await adopt('tx-v8');
  assert.deepEqual((await read('tx-v8')).payload.accepted_coding_policy, r8);

  await stage('off');
  assert.equal((await codingPolicyNow()).guidanceVariant, null, 'disabling the flag returns to v7');
  const beforeLate = await read('tx-v8-late');
  await assert.rejects(adopt('tx-v8-late'), (error) => error.code === 'jurisdiction_context_conflict');
  assert.deepEqual(await read('tx-v8-late'), beforeLate);
  await adopt('tx-v7');
  assert.deepEqual((await read('tx-v7')).payload.accepted_coding_policy, r7, 'old receipt shape still applies under v7');

  // 4. The real batch coder: flag off and flag on (empty set) send byte-identical
  // provider requests; only the stored receipt differs.
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://api.openai.com/v1/responses', 'no unplanned external request');
    bodies.push(init.body);
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = (input.transactions || [input.transaction]).map((transaction) => ({
      transaction_id: transaction.id, proposed_account: 'Professional fees', contact: 'Fixture supplier', tax_treatment: 'ALV 25,5 %',
      support_note: '', ask_client_question: 'What was this service for?', evidence_required: true, remember_candidate: false,
      merchant_pattern: '', missing_account_name: '', missing_account_type: '', missing_account_reason: '',
      auto_explain_limit: 0, confidence: 'high', materiality: 'normal', reasoning: 'Fixture reasoning.', warnings: [], alternatives: []
    }));
    const output = input.transactions ? { suggestions, group_summary: [] } : suggestions[0];
    return { ok: true, json: async () => ({ id: `fik2-response-${bodies.length}`, output_text: JSON.stringify(output) }) };
  });
  await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status)
    values ('tx-code',$1,$2,$3,'FIXTURE CONSULTING OY',100,'EUR','needs_review')`, [firmId, clientId, businessDate]);
  const pristine = await read('tx-code');
  const codeOnce = async () => {
    const before = bodies.length;
    await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
    assert.equal(bodies.length, before + 1, 'exactly one provider request per run');
    return { body: bodies.at(-1), suggestion: (await read('tx-code')).payload.ai_suggestion };
  };
  const restore = () => pool.query(`update transactions set payload=$2::jsonb, coding_state=$3, status=$4 where id=$1`,
    ['tx-code', JSON.stringify(pristine.payload), pristine.coding_state, pristine.status]);

  const off = await codeOnce();
  assert.deepEqual(off.suggestion.coding_policy, r7);
  await restore();
  await stage('canary');
  const on = await codeOnce();
  assert.equal(on.body, off.body, 'flag on with no reviewed entry: the provider request is byte-identical');
  assert.equal(Buffer.byteLength(on.body) - Buffer.byteLength(off.body), 0, 'request-size delta');
  assert.deepEqual(on.suggestion.coding_policy, r8, 'the decision receipt carries the selected guidance digest');
  t.diagnostic(`FIK-2 provider request bytes: flag off ${Buffer.byteLength(off.body)}, flag on ${Buffer.byteLength(on.body)}`);

  // 5. A dated reviewed entry splits the round: lines on each side of its
  // effective date go in separate provider requests, each rendering its own
  // guidance, and both lines are coded (one shared request would refuse the
  // whole round as mixed_policy_batch).
  const claim = 'TEST-ONLY DATED REVIEWED RENT CLAIM.';
  const restoreEntries = __setFiReviewedGuidanceEntriesForTests([{ id: 'FIK-TEST-DATED', status: 'reviewed',
    reviewer: 'Fixture Reviewer', reviewed_on: '2026-09-23', claim, covers: ['FI-ALV-23'],
    sources: [{ url: 'https://www.vero.fi/example-fixture', captured_on: '2026-09-23', effective_from: '2026-09-10', effective_to: null }] }]);
  t.after(restoreEntries);
  for (const [id, date] of [['tx-early', '2026-09-05'], ['tx-late', '2026-09-15']]) {
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status)
      values ($1,$2,$3,$4,'FIXTURE PREMISES RENT',500,'EUR','needs_review')`, [id, firmId, clientId, date]);
  }
  const sent = bodies.length;
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  const round = bodies.slice(sent);
  const carrying = (id) => round.filter((body) => JSON.parse(JSON.parse(body).input).transactions?.some((tx) => tx.id === id));
  assert.equal(carrying('tx-early').length, 1);
  assert.equal(carrying('tx-late').length, 1);
  assert.notEqual(carrying('tx-early')[0], carrying('tx-late')[0], 'the two selections never share a request');
  assert.ok(carrying('tx-late')[0].includes(claim), 'the late line is coded under the reviewed entry');
  assert.ok(!carrying('tx-late')[0].includes(JSON.stringify(FI_POLICY_CLAUSES['FI-ALV-23'].text).slice(1, -1)), 'its covered clause is not sent');
  assert.ok(!carrying('tx-early')[0].includes(claim), 'the early line keeps the unreplaced guidance');
  const early = (await read('tx-early')).payload.ai_suggestion;
  const late = (await read('tx-late')).payload.ai_suggestion;
  assert.equal(early.coding_policy.guidanceDigest, r8.guidanceDigest, 'no entry applies before its effective date');
  assert.match(late.coding_policy.guidanceDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(late.coding_policy.guidanceDigest, early.coding_policy.guidanceDigest);
});
