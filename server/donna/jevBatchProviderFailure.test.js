import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { suggestTransactionCodingBatch } from './transactionLlm.js';
import { batchSuggestTransactionCodingInDb } from './db/coding.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { enrollJevExperiment } from './jevExperimentPolicy.js';
import { runCodingConvergence } from './codingConvergence.js';

const withKeys = async fn => {
  const saved = Object.fromEntries(['TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'OPENAI_API_KEY'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { TYPESAFE_API_KEY: 'synthetic-test-key', TYPESAFE_MODEL: 'test-jev-requested', OPENAI_API_KEY: 'synthetic-strong-key' });
  try { await fn(); } finally { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } }
};
const answer = request => new Response(JSON.stringify({ model: 'test-jev-served', usage: { input_tokens: 10, output_tokens: 5 }, answers:
  Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
    const choices = Object.keys(question.criteria);
    const selected = key === 'decision' ? choices.find(choice => question.criteria[choice].includes('to Marketing, tax treatment No GST;'))
      : key === 'materiality' ? 'normal' : choices[0];
    assert.ok(selected, `Complete test menu has ${key} choice`);
    const probability = key === 'decision' ? 0.42 : 0.8;
    return [key, { type: 'choice', choice: selected, confidence: probability,
      probabilities: Object.fromEntries(choices.map(choice => [choice, choice === selected ? probability : (1 - probability) / (choices.length - 1)])) }];
  })) }), { status: 200, headers: { 'content-type': 'application/json' } });

for (const failedIndex of [0, 10, 12]) test(`actual Jev batch preserves independent decisions when request ${failedIndex + 1} fails`, () => withKeys(async () => {
  const transactions = Array.from({ length: 13 }, (_, index) => ({ id: `line-${index}`, description: `Campaign ${index}`, money_out: 12,
    date: '2026-09-19', account_currency: 'SGD' }));
  const calls = [];
  const batch = await suggestTransactionCodingBatch({ clientProfile: { jurisdiction: 'sg', companyName: 'Synthetic business' }, transactions,
    xeroAccounts: [{ name: 'Marketing' }], jevEnabled: true, fetchImpl: async (endpoint, init) => {
      assert.match(String(endpoint), /typesafe/, 'No strong fallback on provider failure');
      const request = JSON.parse(init.body); calls.push(request.state.transaction.description);
      return calls.length - 1 === failedIndex ? new Response('{}', { status: 400 }) : answer(request);
    } });
  assert.deepEqual(calls, transactions.map(transaction => transaction.description), 'Failure does not stop later independent requests');
  assert.deepEqual(batch.suggestions.map(suggestion => suggestion.transaction_id), transactions.filter((_, index) => index !== failedIndex).map(transaction => transaction.id));
  assert.ok(batch.suggestions.every(suggestion => suggestion.source === 'jev' && suggestion.proposed_account === 'Marketing'));
  assert.equal(batch.provider_failure, undefined, 'One request failure is never promoted to a whole-batch failure');
  assert.deepEqual(batch.provider_failures.map(failure => failure.transaction_id), [`line-${failedIndex}`]);
  assert.equal(batch.provider_failures[0].failure.status, 400);
}));

test('real PG: partial Jev failure persists only its own receipt, applies both peers, and retries only the failed line',
  { skip: !process.env.DONNA_PG_TEST_URL }, () => withKeys(async () => {
    const name = `jev_partial_coding_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = []; pool.on('connect', client => closed.push(new Promise(resolve => client.once('end', resolve))));
    const savedFetch = globalThis.fetch; __setFirmDbPoolForTests(pool);
    try {
      await pool.query(`create schema storage;
        create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
      const migrations = new URL('../../db/migrations/', import.meta.url);
      for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','jev-partial-coding');
        insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Synthetic business','sg','{"jurisdiction":"sg","accounting_system":"none"}');
        insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('jev','f','c','JEV_RECONCILIATION','auto','manual');
        insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');
        insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload) values
        ('before','f','c','2026-09-19','Campaign before',13,'SGD','needs_review','{}'),
        ('failed','f','c','2026-09-18','Campaign failed',12,'SGD','needs_review','{}'),
        ('after','f','c','2026-09-17','Campaign after',11,'SGD','needs_review','{}');`);
      const enrollment = await pool.connect();
      try { await enrollJevExperiment({ client: enrollment, firmId: 'f', clientId: 'c', actorId: 'member', authorityBasis: 'Synthetic partial coding proof',
        trialId: 'partial-coding', expiresAt: '2100-01-01', model: process.env.TYPESAFE_MODEL }); } finally { enrollment.release(); }
      const calls = []; let fail = true;
      globalThis.fetch = async (endpoint, init) => {
        assert.match(String(endpoint), /api\.typesafe\.ai/);
        const request = JSON.parse(init.body); const description = request.state.transaction.description; calls.push(description);
        return fail && description === 'Campaign failed' ? new Response('{}', { status: 400 }) : answer(request);
      };
      const first = await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['c'], limit: 3, autoApply: true });
      assert.equal(calls.length, 3, 'All independent lines reach their own provider request');
      assert.equal(calls[1], 'Campaign failed', 'The real worker reaches a successful request both before and after the failure');
      const rows = (await pool.query('select id,account_code,coding_state,payload from transactions order by id')).rows;
      for (const row of rows.filter(row => row.id !== 'failed')) {
        assert.ok(['applied', 'posted'].includes(row.coding_state), JSON.stringify(row));
        assert.equal(row.account_code, 'Marketing'); assert.equal(row.payload.ai_suggestion_status, 'auto_applied');
        assert.equal(row.payload.ai_suggestion.source, 'jev'); assert.equal(row.payload.coding_provider_failure, undefined);
      }
      const failed = rows.find(row => row.id === 'failed');
      assert.equal(failed.coding_state, null); assert.equal(failed.payload.ai_suggestion, undefined);
      assert.equal(failed.payload.coding_provider_failure.status, 400);
      assert.deepEqual(first.transaction_ai_batch.summaries[0].provider_failures.map(item => item.transaction_id), ['failed']);
      assert.equal(first.transaction_ai_batch.summaries[0].auto_applied, 2);
      const receipts = (await pool.query("select metadata from audit_events where action='transaction.coding_provider_failed'")).rows;
      assert.equal(receipts.length, 1); assert.deepEqual(receipts[0].metadata.transaction_ids, ['failed']);
      const peersBeforeRetry = rows.filter(row => row.id !== 'failed');
      fail = false; calls.length = 0;
      await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['c'], limit: 3, autoApply: true });
      assert.deepEqual(calls, ['Campaign failed'], 'Successful peers are terminal and never resubmitted');
      const recovered = (await pool.query('select id,account_code,coding_state,payload from transactions order by id')).rows;
      assert.deepEqual(recovered.filter(row => row.id !== 'failed'), peersBeforeRetry, 'Retry leaves accepted peers byte-identical');
      const healed = recovered.find(row => row.id === 'failed');
      assert.ok(['applied', 'posted'].includes(healed.coding_state)); assert.equal(healed.account_code, 'Marketing');
      assert.equal(healed.payload.ai_suggestion_status, 'auto_applied'); assert.equal(healed.payload.coding_provider_failure, undefined);
    } finally {
      globalThis.fetch = savedFetch; __resetFirmDbPoolForTests();
      await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end();
    }
  }));

test('convergence preserves successful counters and exact per-line provider failure identities', async () => {
  const providerFailures = [{ transaction_id: 'failed', failure: { code: 'PROVIDER_INVALID_OUTPUT', status: 400 } }];
  const out = await runCodingConvergence({ firmId: 'f', env: {},
    discoverCoderClientsFn: async () => [{ client_id: 'c', unseen_lines: 3 }],
    releaseWaitingFn: async () => [], discoverSweepClientsFn: async () => [], discoverLedgerPostClientsFn: async () => [],
    requestAskDraftFn: async () => ({ enqueued: 0 }),
    batchSuggestFn: async () => ({ transaction_ai_batch: { summaries: [{ client_id: 'c', scanned: 3, suggested: 2,
      auto_applied: 2, provider_failures: providerFailures }] } }) });
  assert.equal(out.coder[0].scanned, 3); assert.equal(out.coder[0].suggested, 2); assert.equal(out.coder[0].auto_applied, 2);
  assert.deepEqual(out.coder[0].provider_failures, providerFailures); assert.equal(out.coder[0].provider_failure, undefined);
});
