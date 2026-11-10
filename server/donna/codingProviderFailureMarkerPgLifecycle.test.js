// The coder's provider-failure marker rides only a line still waiting for a
// coding (2026-11-10). A coding round can pool a line that already has one (a
// proposed line with an open review row is re-coded by the next round); when
// that round stops at the job's budget floor, the lines of the unsent chunk
// that already have a coding are not stamped, a stale marker on them is
// removed, and any move into a coding state removes the marker too. A line
// still waiting carries exactly one marker, saying no request was sent.
// Synthetic book, scripted Anthropic coder, real PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { batchSuggestTransactionCodingInDb } from './db/coding.js';
import { applyCodingTransition } from './codingState.js';
import { readProviderFailuresWithClient } from './providerFailureReadModel.js';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
import { claudeMessageResponse, claudeRequestInput, claudeRequestSystem } from './testSupport/claudeMessage.js';

// A value for every property of the coder's batch schema: the first allowed
// value of an enum, a neutral value otherwise.
const sample = (schema) => {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.anyOf)) return sample(schema.anyOf.find((option) => option.type !== 'null') || schema.anyOf[0]);
  if (Array.isArray(schema.enum)) return schema.enum.find((value) => value !== null) ?? null;
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, sample(value)]));
  if (type === 'array') return [];
  if (type === 'string') return 'Synthetic';
  if (type === 'number') return 0.9;
  if (type === 'integer') return 0;
  if (type === 'boolean') return false;
  return null;
};

test('real PG: a round that stops at the budget floor stamps only waiting lines; coded lines carry no provider-failure marker at rest',
  { skip: !process.env.DONNA_PG_TEST_URL && 'INCOMPLETE: DONNA_PG_TEST_URL required' }, async (t) => {
    const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
    const name = `coding_failure_marker_${process.pid}_${Date.now()}`; await admin.query(`create database "${name}"`);
    const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() }), closed = [];
    pool.on('connect', (c) => closed.push(new Promise((resolve) => c.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    const saved = { fetch: globalThis.fetch, env: Object.fromEntries(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'PROVIDER_BUDGET_RESERVE_MS'].map((k) => [k, process.env[k]])) };
    t.after(async () => {
      globalThis.fetch = saved.fetch;
      for (const [k, v] of Object.entries(saved.env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed);
      await admin.query(`drop database "${name}"`); await admin.end();
    });
    process.env.ANTHROPIC_API_KEY = 'fixture'; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL;
    process.env.PROVIDER_BUDGET_RESERVE_MS = '0';
    await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
    const root = new URL('../../db/migrations/', import.meta.url);
    for (const f of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(f, root), 'utf8'));
    await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','coding-failure-marker');
      insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Synthetic company','us','{"jurisdiction":"us","accounting_system":"none","accounting_basis":"cash"}');`);
    // Fourteen bare lines, each with an open review row, queued in order.
    const ids = Array.from({ length: 14 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`);
    for (const [i, id] of ids.entries()) {
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
        values($1,'f','c','2025-06-02',$2,0,$3,'USD','needs_review','{}')`, [id, `Synthetic supplier ${id}`, 10 + i]);
      await pool.query(`insert into transaction_review_queue(id,firm_id,client_id,item_type,item_id,reason,priority,status,created_at)
        values($1,'f','c','transaction',$2,'needs_category','normal','open',now() - make_interval(mins => $3))`, [`q-${id}`, id, 100 - i]);
    }

    // The scripted coder answers every line of the chunk; after the first
    // chunk the job has 60 s left, under the 120 s floor of a Claude batch.
    let budget = null;
    const sent = [];
    globalThis.fetch = async (endpoint, init) => {
      const request = JSON.parse(init.body);
      assert.match(claudeRequestSystem(request), /^You code bank transactions/, 'only the coder is called');
      const input = JSON.parse(claudeRequestInput(request));
      sent.push(input.transactions.map((tx) => tx.id));
      const item = sample(request.output_config.format.schema.properties.suggestions.items);
      budget.deadlineAt = Date.now() + 60_000;
      return claudeMessageResponse({ suggestions: input.transactions.map((tx) => ({ ...item, transaction_id: tx.id })), group_summary: [] }, { request });
    };
    const job = (fn) => { budget = createExecutionBudget({ timeoutMs: 300_000, label: 'coding-convergence#test' }); return runWithExecutionBudget(budget, fn); };
    const lines = async () => Object.fromEntries((await pool.query(`select id, coding_state, payload->'ai_suggestion' is not null as suggested,
      payload->'coding_provider_failure' as marker from transactions order by id`)).rows.map((row) => [row.id, row]));
    const listed = async () => {
      const client = await pool.connect();
      try { return (await readProviderFailuresWithClient({ client, firmId: 'f', clientId: 'c' })).filter((row) => row.lane === 'coding'); } finally { client.release(); }
    };

    // Job 1: the first chunk (ten lines) is coded; the floor stops the round
    // before the second. The four waiting lines carry one truthful marker.
    await job(() => batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['c'], limit: 40, autoApply: false }));
    assert.deepEqual(sent, [ids.slice(0, 10)], 'one request, ten lines');
    let at = await lines();
    for (const id of ids.slice(0, 10)) assert.deepEqual([at[id].coding_state, at[id].suggested, at[id].marker], ['proposed', true, null], id);
    for (const id of ids.slice(10)) {
      assert.equal(at[id].coding_state, null, id);
      assert.deepEqual([at[id].marker?.code, at[id].marker?.reason, at[id].marker?.request_attempts, at[id].marker?.attempts],
        ['PROVIDER_TIMEOUT', 'execution_budget_insufficient', 0, 1], `${id}: waiting, no request sent`);
    }
    assert.deepEqual((await listed()).map((row) => [row.source_id, row.reason, row.request_attempts]),
      ids.slice(10).map((id) => [id, 'execution_budget_insufficient', 0]));

    // Job 2: the waiting lines are first in the queue now, so the round's
    // first chunk is them plus six coded lines, and the unsent chunk holds
    // four lines that already have a coding — one with a stale marker an
    // earlier tree left (the field case).
    await pool.query(`update transaction_review_queue set priority = 'urgent' where item_id = any($1::text[])`, [ids.slice(10)]);
    await pool.query(`update transactions set payload = payload || '{"coding_provider_failure":{"code":"PROVIDER_TIMEOUT","reason":"execution_budget_exhausted","attempts":1}}'::jsonb where id = 'L08'`);
    sent.length = 0;
    await job(() => batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['c'], limit: 40, autoApply: false }));
    assert.deepEqual(sent, [[...ids.slice(10), ...ids.slice(0, 6)]], 'one request: the waiting lines and six coded ones');
    at = await lines();
    for (const id of ids) {
      assert.equal(at[id].coding_state, 'proposed', id);
      assert.equal(at[id].marker, null, `${id}: coded, no provider-failure marker at rest`);
    }
    assert.deepEqual(await listed(), [], 'the operator read model lists nothing for coded lines');
    assert.equal(Number((await pool.query(`select count(*) from audit_events where action = 'transaction.coding_provider_failed'`)).rows[0].count), 1,
      'only job 1 recorded a failure; the unsent chunk of coded lines recorded none');

    // Any move into a coding state removes a marker in the same write.
    await pool.query(`update transactions set payload = payload || '{"coding_provider_failure":{"code":"PROVIDER_TIMEOUT","reason":"execution_budget_exhausted","attempts":1}}'::jsonb where id = 'L07'`);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await applyCodingTransition(client, { firmId: 'f', transactionId: 'L07', to: 'asked' });
      await client.query('commit');
    } finally { client.release(); }
    at = await lines();
    assert.deepEqual([at.L07.coding_state, at.L07.marker], ['asked', null]);
    // A stale marker an earlier tree left on a coded line is not listed.
    await pool.query(`update transactions set payload = payload || '{"coding_provider_failure":{"code":"PROVIDER_TIMEOUT","reason":"execution_budget_exhausted","attempts":1}}'::jsonb where id = 'L09'`);
    assert.deepEqual(await listed(), []);
  });
