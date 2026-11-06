// Real PostgreSQL locks, current schema and the production family matcher.
// Synthetic provider output only; no live provider or hosted certification.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { runBillReconciliationForDocument } from './billReconciliation.js';
import { recordReconciliationEvaluation } from './reconciliationLlmCore.js';
import { fiSource, fiMatchingResponder } from './testSupport/fiReliabilitySources.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('real PG: late match and evaluation lock waits cannot autocommit a verdict', {
  skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required', timeout: 30_000
}, async (t) => {
  const databaseName = `donna_reconciliation_budget_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${databaseName}"`);
  const databaseUrl = new URL(pgUrl); databaseUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  installConvergenceSettleOnPool(pool);
  const closed = [];
  pool.on('connect', (client) => closed.push(new Promise((resolve) => client.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const env = {
    NODE_ENV: 'test', INNGEST_DEV: '1', INNGEST_EVENT_KEY: '', INNGEST_SIGNING_KEY: '',
    OPENAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only',
    LOOPS_TIER: 'canary', LOOPS_SHADOW: 'true', BILL_MATCHER_ENABLED: '1',
    RECONCILIATION_AUTO_MATCH_POLICY: '1', RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING: '1000000',
    PROVIDER_REQUEST_TIMEOUT_MS: '30000', PROVIDER_BUDGET_RESERVE_MS: '100', AUTO_AI_CODING_ENABLED: '1'
  };
  const priorEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    __resetFirmDbPoolForTests();
    await pool.end();
    await Promise.all(closed);
    await admin.query(`drop database "${databaseName}"`);
    await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((name) => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const firmId = 'fi-inngest-firm', clientId = 'fi-inngest-lumo', transactionId = 'fi-inngest-supplies';
  const documentId = 'fi-inngest-statement', parseRunId = '10000000-0000-4000-8000-000000000001';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,'Synthetic hosted proof',$1,$2)", [firmId, { loops: { tier: 'canary' } }]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
    values($1,$2,'Lumo Kahvila Oy','fi','fi-oy',$3)`, [clientId, firmId, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'accrual' }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) {
    await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
      values($1,$2,$3,$1,'auto','manual')`, [flag, firmId, clientId]);
  }
  const supplies = fiSource('supplies');
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,parse_run_id,payload)
    values($1,$2,$3,'synthetic-statement.csv','bank_statement','completed',$4,'{}')`, [documentId, firmId, clientId, parseRunId]);
  await pool.query(`insert into transactions(id,firm_id,client_id,document_id,transaction_date,description,money_out,currency,status,payload)
    values($1,$2,$3,$4,$5,$6,$7,'EUR','needs_review','{}')`, [transactionId, firmId, clientId, documentId, supplies.date, supplies.bankText, supplies.total]);
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,vendor_name,reference_number,payment_status,payload)
    values('fi-inngest-bill',$1,$2,'TT-88213.pdf','supplier_bill','completed',$3,$4,'EUR',$5,$6,$7,'paid','{}')`,
  [firmId, clientId, supplies.total, supplies.vat, supplies.date, supplies.counterparty, supplies.reference]);


  let providerCalls = 0;
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://api.anthropic.com/'), 'only the synthetic matcher provider may run');
    providerCalls += 1;
    const response = fiMatchingResponder(JSON.parse(options.body));
    return { ok: true, status: response.status, json: async () => response.body };
  };
  const count = async (table) => Number((await pool.query(`select count(*) n from ${table}`)).rows[0].n);
  for (const target of ['match', 'evaluation']) {
    for (const outerTransaction of [false, true]) {
      await t.test(`${target}: ${outerTransaction ? 'caller-owned transaction' : 'autocommit caller'}`, async () => {
        const writer = await pool.connect();
        const blocker = await pool.connect();
        let work;
        try {
          if (outerTransaction) await writer.query('begin');
          await blocker.query('begin');
          const blockerPid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
          const table = target === 'match' ? 'reconciliation_matches' : 'reconciliation_evaluations';
          // SHARE permits production reads, but blocks INSERT/UPSERT. A real
          // PostgreSQL wait proves the answer has crossed the provider boundary.
          await blocker.query(`lock table ${table} in share mode`);
          const budget = createExecutionBudget({ timeoutMs: 2800, label: 'reconciliation-lock-proof' });
          const evaluate = () => recordReconciliationEvaluation({ client: writer, firmId, clientId,
            targetId: 'fi-inngest-bill', matcherFamily: 'supplier_bill', verdict: 'no_match',
            unmatchableReason: 'no_plausible_match', recordDecision: true });
          const match = () => runBillReconciliationForDocument({ client: writer, firmId, clientId, documentId: 'fi-inngest-bill' });
          const beforeCalls = providerCalls;
          work = runWithExecutionBudget(budget, target === 'match' ? match : evaluate)
            .then((result) => ({ result }), (error) => ({ error }));
          const until = Date.now() + 1800;
          let blocked = false;
          while (Date.now() < until) {
            blocked = (await pool.query(`select exists(select 1 from pg_stat_activity
              where datname=current_database() and $1::int=any(pg_blocking_pids(pid))) blocked`, [blockerPid])).rows[0].blocked;
            if (blocked) break;
            await pause(15);
          }
          assert.equal(blocked, true, 'the production verdict statement reaches a real database lock wait');
          if (target === 'match') assert.equal(providerCalls, beforeCalls + 1, 'valid provider answer arrived before the lock wait');
          if (target === 'match' && !outerTransaction) {
            await pause(Math.max(0, budget.deadlineAt - Date.now()) + 25);
          } else {
            budget.abort('synthetic-host-deadline');
          }
          await blocker.query('rollback');
          const outcome = await work;
          if (target === 'evaluation') {
            assert.equal(outcome.error?.code, 'PROVIDER_TIMEOUT');
            assert.equal(outcome.error?.reason, 'execution_budget_exhausted');
          } else {
            assert.equal(outcome.error, undefined, 'ordinary matcher retains its failure-receipt envelope');
            const failure = (await writer.query("select payload->'reconciliation_provider_failure' failure from documents where id='fi-inngest-bill'")).rows[0].failure;
            assert.equal(failure?.code, 'PROVIDER_TIMEOUT', JSON.stringify({ outcome, failure }));
          }
          if (outerTransaction) {
            // The savepoint preserves ownership and a usable outer transaction.
            assert.equal((await writer.query('select 1 n')).rows[0].n, 1);
            await writer.query('commit');
          }
          assert.equal(await count('reconciliation_matches'), 0, 'no weighted fallback or late match');
          assert.equal(await count('reconciliation_evaluations'), 0, 'no late evaluation verdict');
          assert.equal(await count('ledger_journals'), 0);
          assert.equal(await count('client_evidence_requests'), 0);
          assert.equal(Number((await pool.query("select count(*) n from audit_events where action like 'reconciliation.candidate.%'")).rows[0].n), 0);
        } finally {
          await blocker.query('rollback'); blocker.release();
          if (work) await work;
          await writer.query('rollback'); writer.release();
        }
      });
    }
  }
  const writer = await pool.connect();
  try {
    await writer.query('begin');
    await runWithExecutionBudget(createExecutionBudget({ timeoutMs: 10_000 }), () =>
      recordReconciliationEvaluation({ client: writer, firmId, clientId,
        targetId: 'fi-inngest-bill', matcherFamily: 'supplier_bill', verdict: 'no_match' }));
    assert.equal(await count('reconciliation_evaluations'), 0, 'healthy nested writer cannot commit its caller transaction');
    await writer.query('rollback');
    const healthy = () => runWithExecutionBudget(createExecutionBudget({ timeoutMs: 10_000 }),
      () => runBillReconciliationForDocument({ client: writer, firmId, clientId, documentId: 'fi-inngest-bill' }));
    await healthy(); await healthy();
    assert.equal(await count('reconciliation_matches'), 1, 'healthy recovery and replay have one match');
    assert.equal(await count('reconciliation_evaluations'), 1);
    assert.equal((await writer.query("select payload->'reconciliation_provider_failure' failure from documents where id='fi-inngest-bill'")).rows[0].failure, null);
  } finally { writer.release(); }
});
