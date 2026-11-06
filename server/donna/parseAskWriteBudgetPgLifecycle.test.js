import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
import { __draftClientAskBatchWithClient } from './db/asks.js';
import { __writeParsedDocumentExtractionWithClient, __upsertParsedTransactionsWithClient,
  markParseCompletedInDb, __markParseFailedWithClient } from './parseDocumentsDb.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { categorizeError } from './inngest/parseErrors.js';
import { hookPooledClient, withConvergenceSettle } from './reconcileConvergenceState.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: parse and draft results roll back when their database lock waits outlive the owning attempt',
  { skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required' }, async (t) => {
    const name = `donna_parse_budget_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = []; pool.on('connect', (c) => closed.push(new Promise((resolve) => c.once('end', resolve))));
    const seed = await pool.connect(), worker = await pool.connect(), locker = await pool.connect();
    __setFirmDbPoolForTests(pool);
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('No external network in lock-wait proof'); };
    t.after(async () => {
      globalThis.fetch = priorFetch; __resetFirmDbPoolForTests();
      seed.release(); worker.release(); locker.release(); await pool.end(); await Promise.all(closed);
      await admin.query(`drop database "${name}"`); await admin.end();
    });
    await seed.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
    const root = new URL('../../db/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) await seed.query(await readFile(new URL(file, root), 'utf8'));
    const firmId = 'parse-budget-firm', clientId = 'parse-budget-client', documentId = 'parse-budget-doc';
    const parseRunId = '10000000-0000-4000-8000-000000000001';
    await seed.query("insert into firms(id,name,slug) values($1,'Synthetic Firm',$1)", [firmId]);
    await seed.query("insert into clients(id,firm_id,company_name) values($1,$2,'Synthetic Book')", [clientId, firmId]);
    await seed.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,parse_run_id,payload) values($1,$2,$3,'Source.pdf','unknown','processing',$4,'{}')", [documentId, firmId, clientId, parseRunId]);
    const context = { firmId, clientId, documentId, parseRunId };
    const parsed = (client = worker) => __writeParsedDocumentExtractionWithClient({ client, ...context,
      header: { vendor_name: 'Synthetic provider result', total_amount: 10, currency: 'EUR', tax_amount: 0 }, summary: {}, lines: [], documentType: 'unknown' });
    const doc = () => seed.query('select parse_status,vendor_name,total_amount,parse_summary from documents where id=$1', [documentId]).then((r) => r.rows[0]);
    const waitForLock = async (queryFragment) => {
      for (let i = 0; i < 300; i += 1) {
        const waiting = await seed.query("select pid from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query ilike $2", [name, `%${queryFragment}%`]);
        if (waiting.rows.length) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`writer never reached actual PostgreSQL lock wait: ${queryFragment}`);
    };
    const expireWhileLocked = async ({ lock, query, run }) => {
      await locker.query('begin'); await locker.query(lock);
      const budget = createExecutionBudget({ timeoutMs: 30_000, label: 'real-pg-write-proof' });
      const outcome = runWithExecutionBudget(budget, run).then((result) => ({ result }), (error) => ({ error }));
      try {
        await waitForLock(query);
        budget.abort('test_job_expired_after_provider_answer');
      } finally { await locker.query('rollback'); }
      const { error, result } = await outcome;
      assert.equal(error?.code, 'EXECUTION_BUDGET_EXHAUSTED', JSON.stringify(result));
      assert.equal(error.retryable, true);
      assert.equal(categorizeError(error).retryable, true, 'the actual parse error boundary preserves scheduler retry semantics');
    };

    await t.test('document header UPDATE waited: no parsed header or completion survives', async () => {
      const before = await doc();
      await expireWhileLocked({ lock: `select id from documents where id='${documentId}' for update`, query: 'set vendor_name=', run: parsed });
      assert.deepEqual(await doc(), before);
      assert.equal((await seed.query('select count(*)::int n from document_lines')).rows[0].n, 0);
    });
    await t.test('final parse audit INSERT waited: preceding extraction updates roll back before commit', async () => {
      const before = await doc();
      await expireWhileLocked({ lock: 'lock table audit_events in share mode', query: 'insert into audit_events', run: parsed });
      assert.deepEqual(await doc(), before);
      assert.equal((await seed.query("select count(*)::int n from audit_events where action='document.parse.completed'")).rows[0].n, 0);
    });
    await t.test('statement row upsert waited: extracted transactions roll back', async () => {
      await seed.query("insert into transactions(id,firm_id,client_id,document_id,description,status,payload) values('statement-line',$1,$2,$3,'Original','needs_review','{}')", [firmId, clientId, documentId]);
      await expireWhileLocked({ lock: "select id from transactions where id='statement-line' for update", query: 'insert into transactions',
        run: () => __upsertParsedTransactionsWithClient({ client: worker, ...context, transactions: [{ id: 'statement-line', description: 'Late model line', money_out: 10, currency: 'EUR' }] }) });
      assert.equal((await seed.query("select description from transactions where id='statement-line'")).rows[0].description, 'Original');
    });
    await t.test('statement completion audit waited: no late completed verdict', async () => {
      const before = await doc();
      await expireWhileLocked({ lock: 'lock table audit_events in share mode', query: 'insert into audit_events',
        run: () => markParseCompletedInDb({ ...context, summary: { transaction_count: 1 } }) });
      assert.deepEqual(await doc(), before);
    });
    for (const hook of ['callback', 'pooled']) {
      await t.test(`${hook} COMMIT hook waits after writer checks: result rolls back and next failure receipt commits`, async () => {
        const client = hook === 'pooled' ? hookPooledClient(await pool.connect()) : worker;
        const before = await doc();
        try {
          await expireWhileLocked({ lock: 'lock table reconciliation_evaluations in access exclusive mode',
            query: 'select d.id, d.client_id, d.document_type',
            run: () => hook === 'callback' ? withConvergenceSettle(client, () => parsed(client)) : parsed(client) });
          assert.deepEqual(await doc(), before, 'the model header and completion roll back even after the writer reached COMMIT');
          const expired = createExecutionBudget({ timeoutMs: 30_000 }); expired.abort();
          const fail = () => __markParseFailedWithClient({ client, ...context,
            parseError: { code: 'PROVIDER_TIMEOUT', retryable: true, retry_owner: 'queue', safe_user_message: 'Retry queued.' } });
          await runWithExecutionBudget(expired, () => hook === 'callback' ? withConvergenceSettle(client, fail) : fail());
          assert.equal((await doc()).parse_status, 'failed', 'rollback clears the verdict marker so operational failure evidence can commit');
        } finally {
          if (hook === 'pooled') await client.release();
          await seed.query("update documents set parse_status='processing',parse_error=null where id=$1", [documentId]);
        }
      });
    }

    await seed.query("insert into transactions(id,firm_id,client_id,description,money_out,currency,coding_state,payload) values('ask-line',$1,$2,'Unexplained expense',7,'EUR','proposed',$3)",
      [firmId, clientId, { ai_suggestion_status: 'suggested', ai_suggestion: { evidence_required: true, confidence: 'medium', proposed_account: 'Supplies', suggested_at: 1 } }]);
    await seed.query("insert into client_ask_batches(id,firm_id,client_id,status,payload) values('prior-draft',$1,$2,'draft','{}')", [firmId, clientId]);
    let draftCalls = 0;
    const draft = () => __draftClientAskBatchWithClient({ client: worker, firmId, clientId, actorId: 'fixture-operator',
      draftFn: async ({ codingItems }) => {
        draftCalls += 1;
        return { draft: { subject: 'One question', message_markdown: 'What was the expense for?',
          items: codingItems.map((row) => ({ transaction_id: row.id, disposition: 'ask', question: 'What was the expense for?', evidence_type: 'business_purpose' })),
          statement_requests: [], document_asks: [], counts: { ask: codingItems.length, notify: 0, skip: 0, statement_requests: 0 } } };
      }
    });
    const drafts = () => seed.query('select id,status from client_ask_batches order by id').then((r) => r.rows);
    await t.test('ask supersede UPDATE waited after model answer: prior draft survives and late draft does not exist', async () => {
      await expireWhileLocked({ lock: "select id from client_ask_batches where id='prior-draft' for update", query: 'update client_ask_batches', run: draft });
      assert.deepEqual(await drafts(), [{ id: 'prior-draft', status: 'draft' }]);
      assert.equal(draftCalls, 1, 'valid draft returned before the real row lock wait');
    });
    await t.test('ask audit INSERT waited: supersession and new draft both roll back', async () => {
      await expireWhileLocked({ lock: 'lock table audit_events in share mode', query: 'insert into audit_events', run: draft });
      assert.deepEqual(await drafts(), [{ id: 'prior-draft', status: 'draft' }]);
      assert.equal((await seed.query("select count(*)::int n from audit_events where action='ask_batch.draft'")).rows[0].n, 0);
    });
    await t.test('a healthy retry writes one draft and parse result; expired error receipts remain permitted', async () => {
      await runWithExecutionBudget(createExecutionBudget({ timeoutMs: 30_000 }), draft);
      assert.equal((await drafts()).filter((r) => r.status === 'draft').length, 1);
      assert.equal((await parsed()).handled, true);
      assert.equal((await doc()).vendor_name, 'Synthetic provider result');
      const budget = createExecutionBudget({ timeoutMs: 30_000 }); budget.abort();
      await seed.query("update documents set parse_status='processing' where id=$1", [documentId]);
      await runWithExecutionBudget(budget, () => __markParseFailedWithClient({ client: worker, ...context,
        parseError: { code: 'PROVIDER_TIMEOUT', retryable: true, retry_owner: 'queue', safe_user_message: 'Retry queued.' } }));
      assert.equal((await doc()).parse_status, 'failed');
      assert.equal((await seed.query('select parse_error from documents where id=$1', [documentId])).rows[0].parse_error.retry_owner, 'queue');
      for (const table of ['ledger_journals', 'client_evidence_requests']) assert.equal((await seed.query(`select count(*)::int n from ${table}`)).rows[0].n, 0);
    });
  });
