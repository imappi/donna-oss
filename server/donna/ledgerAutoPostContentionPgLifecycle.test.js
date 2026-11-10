import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { sweepLedgerAutoPost, recordRefusalViaDb } from './ledgerAutoPost.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { settleCommittedConvergenceMarks } from './reconcileConvergenceState.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const FIRM = 'contention-firm';
const CLIENT = 'gb';

const boot = async (t) => {
  const name = `donna_post_contention_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', (connection) => { closed.push(new Promise((resolve) => connection.once('end', resolve))); });
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end();
    await Promise.all(closed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
  await pool.query("insert into firms (id, name, slug) values ($1, 'Contention test', 'contention-test')", [FIRM]);
  await pool.query(`insert into clients (id, firm_id, company_name, jurisdiction, profile) values ($1,$2,'Synthetic Ltd','gb',$3)`,
    [CLIENT, FIRM, { jurisdiction: 'gb', accounting_system: 'none' }]);
  await pool.query(`insert into client_capability_config (id,firm_id,client_id,flag_key,stage) values ('posting-flag',$1,$2,'LEDGER_AUTO_POST','auto')`, [FIRM, CLIENT]);
  return pool;
};

const addLine = async (pool, id) => {
  const policy = resolveCodingPolicy({ jurisdiction: 'gb', businessDate: '2026-09-05', accountingSystem: 'none' });
  const suggestion = { proposed_account: 'Sales', tax_treatment: policy.outOfScopeTaxTreatment, confidence: 'high', coding_policy: codingPolicyReceipt(policy) };
  await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
    values ($1,$2,$3,'2026-09-05','Service sale',100,0,'GBP','needs_review','applied',$4)`, [id, FIRM, CLIENT, { ai_suggestion: suggestion }]);
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload)
    values($1,$2,$3,$1,'receipt','completed',100,0,'GBP','2026-09-05','{}')`, [`doc-${id}`, FIRM, CLIENT]);
  await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload)
    values($1,$2,$3,$4,'receipt',$5,100,.98,'confirmed','fixture','{}')`, [`match-${id}`, FIRM, CLIENT, id, `doc-${id}`]);
};

// What the line, its audit trail and the convergence projection record.
const recorded = async (pool, id) => {
  const settle = await pool.connect();
  try { await settleCommittedConvergenceMarks(settle); } finally { settle.release(); }
  const row = (await pool.query(`select coding_state, convergence_state, convergence_reason,
    payload->'ledger_post_refusal' as refusal, payload->>'ledger_journal_id' as journal from transactions where id=$1`, [id])).rows[0];
  const audits = (await pool.query(`select action, metadata->>'code' as code, metadata->>'reason_code' as reason_code from audit_events
    where resource_id=$1 and action <> 'ledger.post_transaction' order by id`, [id])).rows;
  return { ...row, audits };
};

const withTimeout = (promise, ms, label) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} waited ${ms}ms on a held lock`)), ms).unref())]);

// Holds the posting writer's NOWAIT evidence fence (lockChatCodingEvidence:
// documents/matches FOR UPDATE NOWAIT) from a second connection while fn runs.
const holdingDocument = async (pool, documentId, fn) => {
  const holder = await pool.connect();
  try {
    await holder.query('begin');
    await holder.query('select id from documents where firm_id=$1 and id=$2 for share', [FIRM, documentId]);
    return await withTimeout(fn(), 20000, 'sweep');
  } finally { await holder.query('rollback'); holder.release(); }
};
const sweep = (configSnapshot, transactionId) => sweepLedgerAutoPost({ firmId: FIRM, clientId: CLIENT, configSnapshot, transactionId });

test('real PG: a transient database condition is never a posting refusal; named and unexpected failures stay truthful; stored raw codes heal', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set'
}, async (t) => {
  const pool = await boot(t);
  const configSnapshot = await readClientConfigSnapshot(pool, { firmId: FIRM, clientId: CLIENT });

  // 1. Lock not available at the posting writer: nothing is recorded.
  await addLine(pool, 'held');
  const contended = await holdingDocument(pool, 'doc-held', () => sweep(configSnapshot, 'held'));
  const during = await recorded(pool, 'held');
  console.log('[repro] posting sweep under a held document lock', JSON.stringify({ contended, during }));
  assert.equal(contended.contended, 1, JSON.stringify(contended));
  assert.equal(contended.refused, 0);
  assert.equal(during.refusal, null, 'no refusal stamp for lock contention');
  assert.deepEqual(during.audits, [], 'no refusal or policy-failure receipt for lock contention');
  assert.equal(during.coding_state, 'applied');
  assert.doesNotMatch(String(during.convergence_reason), /ledger_post_refused/);
  // The next free tick is not damped and produces the real outcome.
  const free = await sweep(configSnapshot, 'held');
  const after = await recorded(pool, 'held');
  console.log('[repro] next free tick', JSON.stringify({ free, after }));
  assert.equal(free.posted, 1, JSON.stringify(free));
  assert.equal(after.coding_state, 'posted');
  assert.ok(after.journal);

  // 2. A named refusal is still recorded as itself, with its receipt, even
  // when the same fence is held at the same time for another line.
  await addLine(pool, 'locked-period');
  await pool.query(`insert into close_periods (id, firm_id, client_id, period_start, period_end, status, payload)
    values ('locked-sept', $1, $2, '2026-09-01', '2026-09-30', 'locked', '{}')`, [FIRM, CLIENT]);
  const named = await sweep(configSnapshot, 'locked-period');
  const refused = await recorded(pool, 'locked-period');
  assert.equal(named.refused, 1, JSON.stringify(named));
  assert.equal(refused.refusal.code, 'LEDGER_LOCKED_PERIOD_IMMUTABLE');
  assert.deepEqual(refused.audits.map((a) => [a.action, a.code]), [['ledger.auto_post_refused', 'LEDGER_LOCKED_PERIOD_IMMUTABLE']]);
  assert.equal(refused.convergence_reason, 'ledger_post_refused:LEDGER_LOCKED_PERIOD_IMMUTABLE');
  await pool.query("delete from close_periods where id='locked-sept'");

  // 3. An unexpected database error is stored as an unexpected failure with
  // its message, never under its raw SQLSTATE.
  await addLine(pool, 'broken');
  await pool.query(`create function fixture_reject_journal() returns trigger language plpgsql as $$ begin
    if new.source_id = 'broken' then raise exception 'synthetic journal check failed' using errcode = '23514'; end if;
    return new; end $$;
    create trigger fixture_reject_journal before insert on ledger_journals for each row execute function fixture_reject_journal()`);
  const broken = await sweep(configSnapshot, 'broken');
  const failed = await recorded(pool, 'broken');
  console.log('[repro] unexpected failure', JSON.stringify({ broken, failed }));
  assert.equal(broken.unexpected, 1, JSON.stringify(broken));
  assert.equal(failed.refusal.code, 'LEDGER_POST_UNEXPECTED_FAILURE');
  assert.equal(failed.refusal.details.cause_code, '23514');
  assert.match(failed.refusal.error, /synthetic journal check failed/);
  assert.equal(failed.convergence_reason, 'ledger_post_refused:LEDGER_POST_UNEXPECTED_FAILURE');
  await pool.query('drop trigger fixture_reject_journal on ledger_journals');

  // 4. A line stored with a raw PostgreSQL code as its refusal (exactly what
  // the sweep wrote before this rule) heals with no migration: the next tick
  // does not damp it, withdraws the stamp with its own receipt, and posts. It
  // heals even when that tick is contended again.
  await addLine(pool, 'legacy');
  await recordRefusalViaDb({ firmId: FIRM, clientId: CLIENT, transactionId: 'legacy',
    error: Object.assign(new Error('could not obtain lock on row in relation "documents"'), { code: '55P03' }) });
  const legacy = await recorded(pool, 'legacy');
  assert.equal(legacy.convergence_reason, 'ledger_post_refused:55P03', 'the stored state this rule must heal');
  const healing = await holdingDocument(pool, 'doc-legacy', () => sweep(configSnapshot, 'legacy'));
  const healed = await recorded(pool, 'legacy');
  console.log('[repro] stored 55P03 on a contended tick', JSON.stringify({ healing, healed }));
  assert.equal(healing.eligible, 1, 'a stored raw code does not damp the line');
  assert.equal(healing.withdrawn, 1);
  assert.equal(healing.contended, 1);
  assert.equal(healed.refusal, null);
  assert.doesNotMatch(String(healed.convergence_reason), /ledger_post_refused/);
  assert.deepEqual(healed.audits.map((a) => a.action), ['ledger.auto_post_refused', 'ledger.auto_post_refusal_withdrawn'],
    'the withdrawn receipt stays in the trail; the withdrawal is its own audit row');
  const posted = await sweep(configSnapshot, 'legacy');
  assert.equal(posted.posted, 1, JSON.stringify(posted));
  assert.equal(posted.withdrawn, undefined, 'nothing left to withdraw');
  assert.equal((await recorded(pool, 'legacy')).coding_state, 'posted');
  // A named refusal stamp is never withdrawn by that rule.
  const stillRefused = await sweep(configSnapshot, 'locked-period');
  assert.equal(stillRefused.eligible, 0, 'a named refusal keeps its retry damping');
});
