// Provider-stubbed lifecycle evidence, not live-provider or hosted-readiness
// certification. Resume the registered production parse function through the
// real HTTP SDK protocol, with earlier durable steps supplied as replay data.
// The active ai-coding step uses the real coder, full schema and named writers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { runBillReconciliationForDocument } from './billReconciliation.js';
import { runCodingConvergenceInDb } from './codingConvergence.js';
import { fiSource, fiCodingResponder, fiMatchingResponder } from './testSupport/fiReliabilitySources.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const hashStep = (name) => createHash('sha1').update(name).digest('hex');
const jsonResponse = ({ status, body }) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('real PG + registered Inngest HTTP: hung providers and expired row-lock waits refuse late coding; retry and replay are idempotent', {
  skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required', timeout: 60_000
}, async (t) => {
  const databaseName = `donna_fi_inngest_${process.pid}_${Date.now().toString(36)}`;
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
    // 2026-11-10: both keys now put the text lanes on Claude; this file's stub
    // answers the OpenAI coder, so it pins the text lanes to OpenAI.
    OPENAI_MODEL: 'gpt-5.4',
    LOOPS_TIER: 'canary', LOOPS_SHADOW: 'true', BILL_MATCHER_ENABLED: '1',
    RECONCILIATION_AUTO_MATCH_POLICY: '1', RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING: '1000000',
    PROVIDER_REQUEST_TIMEOUT_MS: '30000', PROVIDER_BUDGET_RESERVE_MS: '100', AUTO_AI_CODING_ENABLED: '1'
  };
  const priorEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  let server;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
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
    values($1,$2,'Lumo Kahvila Oy','fi','fi-oy',$3)`, [clientId, firmId, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'accrual', alv_registration: { status: 'registered', registered_from: '2020-01-01' } }]);
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

  const calls = { coder: 0, matcher: 0, mode: 'ok', release: null, signal: null, unexpected: 0, completionStreams: [], onCoder: null };
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    // The SDK also tees the final function result to its completion-stream
    // endpoint. Contain that transport boundary too; this is not evidence
    // that a hosted Inngest control plane accepted or persisted the stream.
    if (target.pathname === '/v1/realtime/publish/tee' && target.searchParams.get('channel') === 'synthetic-hosted-run') {
      calls.completionStreams.push(new Response(options.body).text());
      return new Response('{}', { status: 200 });
    }
    if (!/^https:\/\/api\.(anthropic|openai)\.com\//.test(String(url))) {
      calls.unexpected += 1;
      throw new Error('Unexpected non-provider network request refused by the isolated fixture');
    }
    const body = JSON.parse(options?.body || '{}');
    if (String(url).startsWith('https://api.anthropic.com/')) {
      calls.matcher += 1;
      return jsonResponse(fiMatchingResponder(body));
    }
    assert.ok(String(url).startsWith('https://api.openai.com/'), 'all external traffic must be a stubbed provider');
    assert.ok(body.text?.format?.name?.startsWith('transaction_coding'), 'only the real coding lane may run');
    calls.coder += 1; calls.signal = options.signal;
    const healthy = fiCodingResponder(body);
    calls.onCoder?.();
    if (calls.mode === 'headers') return new Promise((resolve) => { calls.release = () => resolve(jsonResponse(healthy)); });
    if (calls.mode === 'body') return { ok: true, status: 200, json: () => new Promise((resolve) => { calls.release = () => resolve(healthy.body); }) };
    return jsonResponse(healthy);
  };
  // Establish the actual evidence match before resuming the coding step.
  const db = await pool.connect();
  try { await runBillReconciliationForDocument({ client: db, firmId, clientId, documentId: 'fi-inngest-bill' }); }
  finally { db.release(); }
  assert.equal((await pool.query('select count(*)::int n from reconciliation_matches')).rows[0].n, 1);

  const { handleInngestServeRequest } = await import('./inngest/serve.js');
  const { parseDocumentFunction } = await import('./inngest/parseDocument.js');
  const { inngest } = await import('./inngest/client.js');
  let invocationBudgetMs = 2600;
  server = createServer((req, res) => {
    // An enclosing host budget is deliberately shorter than the production
    // maximum. Production serve must inherit it, including its live timer.
    runWithExecutionBudget(createExecutionBudget({ timeoutMs: invocationBudgetMs, label: 'synthetic-host' }),
      () => handleInngestServeRequest(req, res));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const priorSteps = {
    'parse-and-write': { handled: true, post_parse: { path: 'statement', client_id: clientId, document_type: 'bank_statement', transactions_written: 1 } },
    'evidence-recode': { applied: false }, 'jurisdiction-signal': { recorded: false },
    'reconciliation-scan': { ran: true }, 'auto-categorize-matched': { ran: true }, 'auto-categorize-unmatched': { ran: true }
  };
  const event = { id: parseRunId, name: 'document/parse.requested', data: { firm_id: firmId, document_id: documentId, parse_run_id: parseRunId } };
  const invoke = (attempt, extraSteps = {}, target = 'ai-coding') => new Promise((resolve, reject) => {
    const steps = Object.fromEntries(Object.entries({ ...priorSteps, ...extraSteps }).map(([name, data]) => [hashStep(name), { type: 'data', data }]));
    const payload = JSON.stringify({ version: 2, event, events: [event], steps,
      ctx: { run_id: 'synthetic-hosted-run', attempt, max_attempts: 4, disable_immediate_execution: true, stack: { stack: Object.keys(steps), current: 0 } } });
    const req = request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/inngest?fnId=${parseDocumentFunction.id(inngest.id)}&stepId=${target === 'step' ? target : hashStep(target)}`,
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(payload);
  });
  const state = async () => (await pool.query(`select coding_state,payload->'ai_suggestion' suggestion,
    payload->'coding_provider_failure' failure from transactions where id=$1`, [transactionId])).rows[0];
  const counts = async () => (await pool.query(`select
    (select count(*)::int from ledger_journals) journals,
    (select count(*)::int from client_evidence_requests) asks,
    (select count(*)::int from reconciliation_matches) matches`)).rows[0];

  for (const [attempt, mode] of ['headers', 'body'].entries()) {
    calls.mode = mode; calls.release = null;
    const start = Date.now();
    const result = await invoke(attempt);
    assert.ok(Date.now() - start < 5000, `${mode}: the 30s provider timeout is capped by the hosted invocation`);
    assert.equal(result.status, 206, JSON.stringify(result));
    assert.equal(result.body[0]?.op, 'StepError', `the receipt reserve must not let a timed-out step cache success: ${JSON.stringify(result)}`);
    assert.equal(result.headers['x-inngest-no-retry'], 'false', 'the SDK still owns retry scheduling');
    assert.ok(calls.release, `${mode}: the real coder reached the provider`);
    assert.equal(calls.signal.aborted, true, `${mode}: transport cancellation reaches the HTTP signal`);
    const failed = await state();
    assert.equal(failed.suggestion, null);
    assert.equal(failed.failure?.code, 'PROVIDER_TIMEOUT', JSON.stringify(failed));
    assert.equal(failed.failure?.owner, 'queue');
    assert.match(failed.failure?.reason || '', /^execution_budget_/);
    assert.deepEqual(await counts(), { journals: 0, asks: 0, matches: 1 });
    calls.release(); await pause(50);
    assert.deepEqual(await state(), failed, 'a late released response cannot persist a verdict or erase its failure');
    assert.deepEqual(await counts(), { journals: 0, asks: 0, matches: 1 });
  }

  // A timely provider answer does not extend the owning invocation while
  // the named writer waits for a real PostgreSQL row lock.
  calls.mode = 'ok';
  const blocker = await pool.connect();
  let responseStarted;
  const answered = new Promise((resolve) => { responseStarted = resolve; });
  calls.onCoder = responseStarted;
  let blockedAttempt;
  try {
    await blocker.query('begin');
    const blockerPid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('select id from transactions where id=$1 for update', [transactionId]);
    blockedAttempt = invoke(2);
    await answered;
    const lockStartedAt = Date.now();
    let actuallyBlocked = false;
    while (Date.now() - lockStartedAt < 1500) {
      actuallyBlocked = (await pool.query(`select exists (
        select 1 from pg_stat_activity where datname=current_database()
          and $1::int=any(pg_blocking_pids(pid))
      ) blocked`, [blockerPid])).rows[0].blocked;
      if (actuallyBlocked) break;
      await pause(20);
    }
    assert.equal(actuallyBlocked, true, 'the live coding writer actually waits on the source row after the model answers');
    await pause(invocationBudgetMs + 50);
    assert.equal((await state()).suggestion, null, 'no verdict exists while the writer waits');
    await blocker.query('rollback');
    const expired = await blockedAttempt;
    assert.equal(expired.body[0]?.op, 'StepError', JSON.stringify(expired));
    assert.equal(expired.headers['x-inngest-no-retry'], 'false');
    assert.match(JSON.stringify(expired.body[0]), /EXECUTION_BUDGET_EXHAUSTED/);
    assert.equal((await state()).suggestion, null, 'unlock after expiry cannot commit the earlier model answer');
    assert.deepEqual(await counts(), { journals: 0, asks: 0, matches: 1 });
    assert.equal((await pool.query("select count(*)::int n from audit_events where action='transaction.ai_batch_review'")).rows[0].n, 0,
      'the expired write transaction leaves no successful coding audit');
  } finally {
    calls.onCoder = null;
    await blocker.query('rollback');
    blocker.release();
    if (blockedAttempt) await blockedAttempt;
  }

  invocationBudgetMs = 10_000;
  const healthy = await invoke(3);
  assert.equal(healthy.status, 206, JSON.stringify(healthy));
  assert.equal(healthy.body[0]?.op, 'StepRun', JSON.stringify(healthy));
  assert.deepEqual(healthy.body[0]?.data, { ran: true });
  assert.equal((await state()).failure, null, 'healthy retry clears the persisted provider failure');
  assert.ok((await state()).suggestion, 'the production ai-coding step finally persisted its verdict');
  const afterRecoveryCalls = calls.coder;
  const replay = await invoke(3);
  assert.equal(replay.body[0]?.op, 'StepRun', JSON.stringify(replay));
  assert.equal(calls.coder, afterRecoveryCalls, 'delivery replay does not spend another coding call');
  const terminal = await invoke(3, { 'ai-coding': { ran: true }, 'owner-media-summary': { sent: false } }, 'complete');
  assert.equal(terminal.status, 200, JSON.stringify(terminal));
  assert.deepEqual(terminal.body, { handled: true }, 'SDK observes the actual function terminal after durable leg completion');

  // The existing convergence clock remains the posting owner. It consumes the
  // recovered coding through its named writer; repeated ticks are idempotent.
  const tick = () => runCodingConvergenceInDb({ firmId, discoverSweepClientsFn: async () => [], requestAskDraftFn: async () => ({ enqueued: 0 }) });
  await tick(); await tick();
  assert.equal((await state()).coding_state, 'posted');
  assert.deepEqual(await counts(), { journals: 1, asks: 0, matches: 1 });
  assert.equal(calls.coder, afterRecoveryCalls);
  const completionStreams = await Promise.all(calls.completionStreams);
  assert.equal(completionStreams.length, 1, 'only the final SDK function completion publishes a terminal stream');
  assert.match(completionStreams[0], /handled/);
  assert.equal(calls.unexpected, 0, 'no scheduler, storage or external send call was needed');
});
