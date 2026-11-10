import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import pg from 'pg';
import { handleDonnaApiRequest } from './api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { readProviderFailuresWithClient } from './providerFailureReadModel.js';
import { recordReconciliationProviderFailureWithClient, clearReconciliationProviderFailureWithClient } from './reconciliationProviderFailure.js';
import { recordCodingProviderFailureWithClient } from './db/coding.js';
import { providerKeyMissing, ProviderFailureError } from './providerTransport.js';
import { enqueueOutbox, claimOutboxRow, failOutboxRow, dropOutboxRow, markOutboxDispatched } from './loopEventOutbox.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: operator projection retains exact causes through retry, dead letter and recovery without accounting effects',
  { skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required' }, async (t) => {
    const name = `donna_provider_surface_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: url.toString() }); await client.connect();
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = []; pool.on('connect', (c) => closed.push(new Promise((resolve) => c.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    const savedEnv = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN'].map((key) => [key, process.env[key]]));
    process.env.DATABASE_URL = url.toString(); process.env.DONNA_ACCESS_TOKEN = 'synthetic-operator-only';
    t.after(async () => {
      for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed);
      await client.end(); await admin.query(`drop database "${name}"`); await admin.end();
    });
    await client.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
    const root = new URL('../../db/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(file, root), 'utf8'));
    const firmId = 'provider-surface-firm', clientId = 'provider-surface-client';
    await client.query("insert into firms(id,name,slug) values($1,'Synthetic Firm',$1)", [firmId]);
    await client.query("insert into clients(id,firm_id,company_name) values($1,$2,'Synthetic FI Book'),('other-client',$2,'Other Book')", [clientId, firmId]);
    await client.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,payload) values('bill',$1,$2,'Synthetic bill.pdf','supplier_bill','completed','{}')", [firmId, clientId]);
    await client.query("insert into transactions(id,firm_id,client_id,description,status,payload) values('line',$1,$2,'Synthetic supplies','needs_review','{}')", [firmId, clientId]);
    const read = () => readProviderFailuresWithClient({ client, firmId, clientId });
    const credentialFailure = providerKeyMissing('anthropic');
    for (let i = 0; i < 2; i += 1) await recordReconciliationProviderFailureWithClient({ client, firmId, clientId, documentId: 'bill', family: 'supplier_bill', failure: credentialFailure });
    const timeout = new ProviderFailureError({ code: 'PROVIDER_TIMEOUT', provider: 'openai', reason: 'execution_budget_aborted' });
    await recordCodingProviderFailureWithClient({ client, firmId, clientId, transactionIds: ['line'], failure: timeout.receipt() });
    let rows = await read();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.lane === 'matching').owner, 'operator');
    assert.equal(rows.find((r) => r.lane === 'matching').attempts, 2);
    assert.equal(rows.find((r) => r.lane === 'coding').reason, 'execution_budget_aborted');
    assert.equal(rows.find((r) => r.lane === 'coding').owner, 'queue');
    assert.deepEqual(await readProviderFailuresWithClient({ client, firmId, clientId: 'other-client' }), []);
    assert.deepEqual(await readProviderFailuresWithClient({ client, firmId: 'other-firm', clientId }), []);
    // The current mounted view reads this authenticated route, not a separate
    // diagnostic endpoint. Exercise its actual pool reader and serialized shape.
    const req = Readable.from([]);
    req.method = 'GET'; req.url = `/api/donna/firms/ask-batches?firm_id=${firmId}&client_id=${clientId}`;
    req.headers = { authorization: 'Bearer synthetic-operator-only' };
    const apiResult = await new Promise((resolve, reject) => {
      const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); } };
      Promise.resolve(handleDonnaApiRequest(req, res)).catch(reject);
    });
    assert.equal(apiResult.status, 200, JSON.stringify(apiResult));
    assert.equal(apiResult.body.client_id, clientId);
    assert.deepEqual(apiResult.body.provider_failures, rows);

    const request = await enqueueOutbox({ client, firmId, clientId, eventType: 'ask_draft.requested' });
    await claimOutboxRow({ client, id: request.id, expectedStatus: 'pending', expectedAttempts: 0 });
    const error = Object.assign(new Error('Sensitive provider text must not reach the surface'), {
      code: 'ASK_PIPELINE_LLM_UNAVAILABLE', details: { provider_failure: credentialFailure.receipt() }
    });
    await failOutboxRow({ client, id: request.id, error });
    const ask = () => read().then((all) => all.find((r) => r.lane === 'ask_draft'));
    assert.equal((await ask()).code, 'PROVIDER_KEY_MISSING');
    assert.doesNotMatch(JSON.stringify(await read()), /Sensitive|API key is not configured/);
    await claimOutboxRow({ client, id: request.id, expectedStatus: 'failed', expectedAttempts: 1 });
    assert.equal((await ask()).recovery_status, 'retry_in_progress');
    assert.equal((await ask()).code, 'PROVIDER_KEY_MISSING');
    // An abandoned retry can itself be reclaimed: retain one cause, no nested history.
    await claimOutboxRow({ client, id: request.id, expectedStatus: 'dispatching', expectedAttempts: 2 });
    assert.equal((await ask()).code, 'PROVIDER_KEY_MISSING');
    await dropOutboxRow({ client, id: request.id, reason: 'max_attempts', expectedStatus: 'dispatching' });
    assert.equal((await ask()).recovery_status, 'recovery_wait');
    assert.equal((await ask()).code, 'PROVIDER_KEY_MISSING');
    const retry = await enqueueOutbox({ client, firmId, clientId, eventType: 'ask_draft.requested' });
    assert.equal((await ask()).recovery_status, 'retry_pending');
    assert.equal((await ask()).recovery_request_id, retry.id);
    await claimOutboxRow({ client, id: retry.id, expectedStatus: 'pending', expectedAttempts: 0 });
    assert.equal((await ask()).recovery_status, 'retry_in_progress');
    await failOutboxRow({ client, id: retry.id, error: Object.assign(new Error('A readable but invalid draft'), { code: 'ASK_PIPELINE_BAD_DRAFT' }) });
    assert.equal((await ask()).recovery_status, 'recovery_failed');
    assert.equal((await ask()).code, 'PROVIDER_KEY_MISSING', 'an unrelated later failure does not silently erase the original receipt');
    assert.equal((await ask()).recovery_error_code, 'ASK_PIPELINE_BAD_DRAFT');
    await claimOutboxRow({ client, id: retry.id, expectedStatus: 'failed', expectedAttempts: 1 });
    assert.equal(await markOutboxDispatched({ client, id: retry.id }), true);
    assert.equal(await markOutboxDispatched({ client, id: retry.id }), false);
    assert.equal(await ask(), undefined, 'a completed draft job does not resurrect its old dead-letter cause');

    await clearReconciliationProviderFailureWithClient({ client, firmId, clientId, documentId: 'bill' });
    assert.equal(await clearReconciliationProviderFailureWithClient({ client, firmId, clientId, documentId: 'bill' }), false);
    assert.equal((await read()).length, 1, 'only the independently unresolved coding failure remains');
    assert.deepEqual(await read(), await read(), 'repeated reads are idempotent');
    // A batch the job's budget could not hold is not sent: its receipt keeps
    // request_attempts 0 through the writer and the read model, and stays a
    // recorded, retryable failure on the queue (0 is a count, not "no failure").
    await client.query("insert into transactions(id,firm_id,client_id,description,status,payload) values('line-floor',$1,$2,'Synthetic fuel','needs_review','{}')", [firmId, clientId]);
    const notStarted = new ProviderFailureError({ code: 'PROVIDER_TIMEOUT', provider: 'anthropic', reason: 'execution_budget_insufficient', retryable: true, owner: 'queue' });
    await recordCodingProviderFailureWithClient({ client, firmId, clientId, transactionIds: ['line-floor'], failure: { ...notStarted.receipt(), request_attempts: 0 } });
    const floor = (await read()).find((r) => r.source_id === 'line-floor');
    assert.deepEqual([floor.code, floor.reason, floor.owner, floor.retryable, floor.attempts, floor.request_attempts],
      ['PROVIDER_TIMEOUT', 'execution_budget_insufficient', 'queue', true, 1, 0]);
    assert.equal((await read()).length, 2, 'the not-started line is a recorded failure');
    assert.equal(rows.find((r) => r.lane === 'coding').request_attempts, 1, 'a call that was made still counts its request');
    for (const table of ['ledger_journals', 'client_evidence_requests', 'reconciliation_matches']) {
      assert.equal(Number((await client.query(`select count(*) from ${table} where client_id=$1`, [clientId])).rows[0].count), 0);
    }
    assert.equal(Number((await client.query("select count(*) from audit_events where action='document.reconciliation_provider_failed'")).rows[0].count), 1);
  });
