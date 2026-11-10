// FI provider-failure pass (2026-09-13) — the acceptance contract on real
// PostgreSQL through the actual writers and workers, every model lane
// answered (or refused) at the HTTP boundary with synthetic Finnish material
// (testSupport/fiReliabilitySources.js). Provider-stubbed LIFECYCLE evidence:
// it proves what the tree PERSISTS when the provider fails and how work
// resumes when it answers again; it says nothing about live-model quality.
//
// The contract (docs/finding-2026-09-13-fi-provider-failure-recovery.md §3):
//   1. A provider failure never becomes a fabricated coding, a no-match
//      verdict, a weighted (heuristic) replacement match, or a request for
//      evidence the book already holds.
//   2. The whole provider operation — headers, body, retries — is bounded by
//      the worker's budget; a late response is dropped and never written.
//   3. The cause is typed and persisted; a credential problem rests on the
//      OPERATOR; the existing recovery workers re-drive the work.
//   4. Once the provider answers, existing work resumes without another
//      upload and without duplicate matches, journals or questions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, suggestTransactionCodingInDb } from './firmDb.js';
import { runCodingConvergenceInDb } from './codingConvergence.js';
import { runBillReconciliationForDocument } from './billReconciliation.js';
import { runSalesInvoiceReconciliationForDocument } from './salesInvoiceReconciliation.js';
import { runDocumentDispositionForClient, DOCUMENT_NO_LINE_DISPOSITION_FAMILY } from './documentDispositionLlm.js';
import { runDocumentTerminalDrain } from './loopsShadowProducers.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
import { DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL, RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES } from './reconciliationProviderFailure.js';
import { runAskDraftRequest } from './askAutoDraftConsumer.js';
import { enqueueOutbox } from './loopEventOutbox.js';
import { draftClientAskMessage } from './askPipeline.js';
import { DISCOVER_ASK_DRAFT_OUTAGE_RECOVERY_SQL } from './codingConvergence.js';
import { fiMatchingResponder, fiCodingResponder, fiSource } from './testSupport/fiReliabilitySources.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const anthropic401 = () => jsonResponse(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } });
const anthropic529 = () => jsonResponse(529, { error: { type: 'overloaded_error', message: 'Overloaded' } });
const openAiBody = (payload) => jsonResponse(200, { id: 'fixture-response', model: 'gpt-5.4', output_text: JSON.stringify(payload) });
const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const never = () => new Promise(() => {});

test('real PG (FI): provider failures on the matcher, coder and ask drafter are typed, bounded, never verdicts, and resume without another upload', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async (t) => {
  const name = `donna_fi_transport_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  installConvergenceSettleOnPool(pool);
  const closed = []; pool.on('connect', (c) => closed.push(new Promise((resolve) => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'ANTHROPIC_API_KEY', 'LOOPS_TIER', 'LOOPS_SHADOW', 'BILL_MATCHER_ENABLED', 'SALES_INVOICE_MATCHER_ENABLED',
    'RECONCILIATION_AUTO_MATCH_POLICY', 'RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING', 'PROVIDER_REQUEST_TIMEOUT_MS', 'PROVIDER_BUDGET_RESERVE_MS'];
  const priorEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const priorFetch = globalThis.fetch;
  Object.assign(process.env, {
    OPENAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only', LOOPS_TIER: 'canary', LOOPS_SHADOW: 'true',
    // 2026-11-10: both keys now put the text lanes on Claude; this file
    // exercises the OpenAI coder transport, so it pins them to OpenAI.
    OPENAI_MODEL: 'gpt-5.4',
    BILL_MATCHER_ENABLED: '1', SALES_INVOICE_MATCHER_ENABLED: '1',
    RECONCILIATION_AUTO_MATCH_POLICY: '1', RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING: '1000000',
    PROVIDER_REQUEST_TIMEOUT_MS: '400', PROVIDER_BUDGET_RESERVE_MS: '0'
  });
  t.after(async () => {
    globalThis.fetch = priorFetch;
    for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((n) => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));

  const firmId = 'fi-transport-firm', clientId = 'lumo';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,'FI Transport Firm','fi-transport-firm',$2)", [firmId, { loops: { tier: 'canary' } }]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Lumo Kahvila Oy','fi','fi-oy',$3)`,
    [clientId, firmId, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'accrual', alv_registration: { status: 'registered', registered_from: '2020-01-01' } }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST', 'DOCUMENT_NO_LINE_DISPOSITION'])
    await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')`, [flag, firmId, clientId, flag]);

  const supplies = fiSource('supplies'); const sale = fiSource('sale');
  const tx = (id, { out = 0, inn = 0, description, date }) => pool.query(
    `insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload) values($1,$2,$3,$4,$5,$6,$7,'EUR','needs_review','{}')`,
    [id, firmId, clientId, date, description, out, inn]);
  const doc = (id, source) => pool.query(
    `insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,vendor_name,customer_name,reference_number,payment_status,payload,checksum_sha256)
     values($1,$2,$3,$4,$5,'completed',$6,$7,'EUR',$8,$9,$10,$11,$12,'{}',$13)`,
    [id, firmId, clientId, `${source.reference}.pdf`, source.type, source.total, source.vat, source.date,
      source.type === 'supplier_bill' ? source.counterparty : null, source.type === 'sales_invoice' ? source.counterparty : null,
      source.reference, source.type === 'sales_invoice' ? 'unpaid' : 'paid', `sha-${id}`]);
  await tx('supplies-line', { out: supplies.total, description: supplies.bankText, date: supplies.date });
  await tx('sale-line', { inn: sale.total, description: sale.bankText, date: sale.date });
  await doc('bill-supplies', supplies);
  await doc('invoice-sale', sale);

  const q = (sql, params = []) => pool.query(sql, params);
  const receiptOf = async (documentId) => (await q("select payload->'reconciliation_provider_failure' as receipt from documents where id=$1", [documentId])).rows[0].receipt;
  const matches = async () => (await q("select bank_transaction_id, matched_object_id, status, payload->>'source' as source from reconciliation_matches where client_id=$1 order by matched_object_id", [clientId])).rows;
  const evaluations = async () => (await q("select target_id, matcher_family, verdict, unmatchable_reason from reconciliation_evaluations where client_id=$1 order by target_id, matcher_family", [clientId])).rows;
  const audits = async (action) => (await q('select resource_id, metadata from audit_events where client_id=$1 and action=$2 order by id', [clientId, action])).rows;
  const journals = async () => (await q('select source_id from ledger_journals where client_id=$1 order by source_id', [clientId])).rows;
  const asks = async () => (await q("select id, transaction_id, evidence_type, status from client_evidence_requests where client_id=$1", [clientId])).rows;
  const withClient = async (fn) => { const client = await pool.connect(); try { return await fn(client); } finally { client.release(); } };
  const runBill = () => withClient((client) => runBillReconciliationForDocument({ client, firmId, clientId, documentId: 'bill-supplies' }));
  const runInvoice = () => withClient((client) => runSalesInvoiceReconciliationForDocument({ client, firmId, clientId, documentId: 'invoice-sale' }));

  const calls = { anthropic: 0, openai: 0, mode: 'ok', release: null };
  const stub = async (u, init) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.includes('api.anthropic.com')) {
      calls.anthropic += 1;
      switch (calls.mode) {
        case '401': return anthropic401();
        case '529': return anthropic529();
        case 'network': throw networkError();
        case 'hung_headers': return never();
        case 'hung_body': return { ok: true, status: 200, json: never };
        case 'late': return new Promise((resolve) => { calls.release = () => { const r = fiMatchingResponder(body); resolve(jsonResponse(r.status, r.body)); }; });
        default: { const r = fiMatchingResponder(body); return jsonResponse(r.status, r.body); }
      }
    }
    if (url.includes('api.openai.com')) {
      calls.openai += 1;
      if (body.text?.format?.name?.startsWith('transaction_coding')) {
        switch (calls.mode) {
          case 'openai_401': return jsonResponse(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
          case 'openai_garbage': return jsonResponse(200, { id: 'r', model: 'gpt-5.4', output_text: 'not json at all' });
          case 'openai_hung_body': return { ok: true, status: 200, json: () => new Promise((resolve) => { calls.release = () => resolve(fiCodingResponder(body).body); }) };
          default: { const r = fiCodingResponder(body); return jsonResponse(r.status, r.body); }
        }
      }
      if (body.text?.format?.name === 'client_ask_message_draft') {
        switch (calls.mode) {
          case 'ask_network': throw networkError();
          case 'ask_hung_body': return { ok: true, status: 200, json: never };
          case 'ask_garbage': return jsonResponse(200, { id: 'r', model: 'gpt-5.4', output_text: '<html>' });
          default: return openAiBody({ subject: 's', message_markdown: 'Hei', summary: 's', items: [], statement_requests: [], document_asks: [] });
        }
      }
    }
    throw new Error(`unexpected provider call ${url}`);
  };
  globalThis.fetch = stub;

  // ── 1. The matcher: every failure class is one typed receipt, no weighted row, no verdict ──
  // Transient classes (529, a reset socket, a hung request) are retried four
  // times with jittered backoff before the typed throw — bounded, but not
  // instant. A credential failure is thrown on the first attempt.
  const expectFailure = async (mode, expected, { run = runBill, documentId = 'bill-supplies', boundMs = 15_000 } = {}) => {
    calls.mode = mode;
    const before = calls.anthropic;
    const startedAt = Date.now();
    const stats = await run();
    assert.ok(calls.anthropic > before, `${mode}: the strong model's provider was called`);
    assert.ok(Date.now() - startedAt < boundMs, `${mode}: bounded (${Date.now() - startedAt}ms)`);
    assert.equal(stats.disabled, false, `${mode}: not a disabled run`);
    assert.equal(stats.provider_failure?.code, expected.code, `${mode}: ${JSON.stringify(stats.provider_failure)}`);
    assert.equal(stats.provider_failure?.owner, expected.owner, `${mode}: owner`);
    assert.equal(stats.suggested_inserted + stats.auto_match_inserted, 0, `${mode}: nothing inserted`);
    const receipt = await receiptOf(documentId);
    assert.equal(receipt?.code, expected.code, `${mode}: the typed cause rides the document`);
    assert.equal(receipt?.owner, expected.owner);
    assert.equal(receipt?.matcher_family, documentId === 'bill-supplies' ? 'supplier_bill' : 'sales_invoice');
    assert.ok(receipt.first_failed_at && receipt.last_failed_at, 'timestamps accumulate');
    assert.deepEqual(await matches(), [], `${mode}: no weighted replacement decision, no match row`);
    assert.deepEqual(await evaluations(), [], `${mode}: no no_match verdict`);
    return receipt;
  };
  await expectFailure('401', { code: 'PROVIDER_UNAUTHORIZED', owner: 'operator' }, { boundMs: 3_000 });
  assert.equal((await audits('document.reconciliation_provider_failed')).length, 1, 'one audit per distinct failure per document');
  const second = await expectFailure('401', { code: 'PROVIDER_UNAUTHORIZED', owner: 'operator' }, { boundMs: 3_000 });
  assert.equal(second.attempts, 2, 'a repeated identical failure counts attempts, not audits');
  assert.equal((await audits('document.reconciliation_provider_failed')).length, 1);
  // A persistent 529 is retried with backoff (4 attempts, ~3.5s of jittered
  // waits) and then thrown typed — still bounded, still no verdict.
  const overloaded = await expectFailure('529', { code: 'PROVIDER_UNAVAILABLE', owner: 'queue' });
  assert.equal(overloaded.status, 529);
  assert.equal(overloaded.request_attempts, 4, 'the retry budget was spent before the throw');
  assert.equal(overloaded.attempts, 1, 'a new failure class starts a new run count');
  await expectFailure('network', { code: 'PROVIDER_NETWORK', owner: 'queue' });
  const hungHeaders = await expectFailure('hung_headers', { code: 'PROVIDER_TIMEOUT', owner: 'queue' });
  assert.equal(hungHeaders.reason, 'request_timeout');
  assert.equal(hungHeaders.request_attempts, 4, 'a hung request is retried like any transient, each attempt under its own deadline');
  await expectFailure('hung_body', { code: 'PROVIDER_TIMEOUT', owner: 'queue' });
  // Missing key: the LLM matcher self-disables; the wrapper receipts it on the OPERATOR, never the weighted body.
  delete process.env.ANTHROPIC_API_KEY;
  calls.mode = 'ok';
  const noKey = await runInvoice();
  assert.equal(noKey.provider_failure?.code, 'PROVIDER_KEY_MISSING', JSON.stringify(noKey.provider_failure));
  assert.equal(noKey.provider_failure?.owner, 'operator');
  assert.equal((await receiptOf('invoice-sale'))?.code, 'PROVIDER_KEY_MISSING');
  assert.deepEqual(await matches(), [], 'no weighted row on a missing key');
  process.env.ANTHROPIC_API_KEY = 'fixture-only';
  // Late response: the deadline passes, the receipt lands; the answer arriving later is dropped, never written.
  calls.mode = 'late';
  const late = await runInvoice();
  assert.equal(late.provider_failure?.code, 'PROVIDER_TIMEOUT');
  assert.ok(calls.release, 'the provider is still holding the response');
  calls.release(); calls.release = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await matches(), [], 'the late response wrote nothing');
  assert.deepEqual(await evaluations(), []);
  assert.equal((await receiptOf('invoice-sale'))?.code, 'PROVIDER_TIMEOUT', 'the receipt reflects the timeout that actually happened');
  // The whole operation under a worker budget that cannot hold an attempt: refused before any call.
  const beforeBudget = calls.anthropic;
  calls.mode = 'ok';
  const budgetStats = await runWithExecutionBudget(createExecutionBudget({ timeoutMs: 100, label: 'proof#spent' }), () => runBill());
  assert.equal(budgetStats.provider_failure?.code, 'PROVIDER_TIMEOUT');
  assert.equal(budgetStats.provider_failure?.reason, 'execution_budget_exhausted');
  assert.equal(calls.anthropic, beforeBudget, 'no request is started when the budget cannot hold it');

  // ── 2. The drain never dispositions (and never asks about) a document whose matcher has not run ──
  const discovered = await q(DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL, [firmId, 10, [...RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES]]);
  assert.deepEqual(discovered.rows.map((r) => r.document_id).sort(), ['bill-supplies', 'invoice-sale'], 'both documents are owed a re-drive');
  const drain = await withClient((client) => runDocumentTerminalDrain({ client, firmId, clientId }));
  assert.equal(drain?.stats?.evaluated ?? 0, 0, JSON.stringify(drain?.stats));
  assert.equal((await q("select count(*)::int n from reconciliation_evaluations where client_id=$1 and matcher_family=$2", [clientId, DOCUMENT_NO_LINE_DISPOSITION_FAMILY])).rows[0].n, 0, 'no disposition verdict on a receipted document');
  assert.deepEqual(await asks(), [], 'no owner question was minted from a provider failure');
  // The keyed document-disposition producer on a genuinely bare document: a
  // provider failure is a TECHNICAL needs_human that RT-10 routes to a bounded
  // machine re-run (Donna's work in flight) — never an owner question. The
  // typed core throw lands in the same lane the pre-existing transport throw did.
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,document_date,vendor_name,payload,checksum_sha256)
    values('receipt-orphan',$1,$2,'KH-9001.pdf','receipt','completed',19.90,'EUR','2026-03-20','Kahvila Helmi','{}','sha-orphan')`, [firmId, clientId]);
  calls.mode = '401';
  const sweep = await withClient((client) => runDocumentDispositionForClient({ client, firmId, clientId, documentIds: ['receipt-orphan'], mode: 'act' }));
  assert.equal(sweep.needs_human, 1, JSON.stringify(sweep));
  assert.equal(sweep.reruns_scheduled, 1, 'RT-10: a technical needs_human schedules a machine re-run');
  assert.equal(sweep.owner_asks_minted, 0, 'a 401 never mints an owner question');
  const orphanVerdict = (await q("select unmatchable_reason, payload->'lane'->>'kind' as lane from reconciliation_evaluations where client_id=$1 and target_id='receipt-orphan'", [clientId])).rows[0];
  assert.deepEqual(orphanVerdict, { unmatchable_reason: 'transport_error', lane: 'machine_rerun' });
  assert.deepEqual(await asks(), []);
  await pool.query("delete from reconciliation_evaluations where target_id='receipt-orphan'");
  await pool.query("delete from documents where id='receipt-orphan'");

  // ── 3. Recovery: the existing convergence clock re-drives both documents; work resumes with no duplicate ──
  calls.mode = 'ok';
  const tick = () => runCodingConvergenceInDb({ firmId, discoverSweepClientsFn: async () => [], requestAskDraftFn: async () => ({ enqueued: 0 }) });
  const first = await tick();
  const recovery = first.reconciliation_provider_recovery || [];
  assert.deepEqual(recovery.map((r) => [r.document_id, r.outcome]).sort(), [['bill-supplies', 'recovered'], ['invoice-sale', 'recovered']], JSON.stringify(recovery));
  assert.equal(await receiptOf('bill-supplies'), null, 'a completed strong-model run clears the receipt');
  assert.equal(await receiptOf('invoice-sale'), null);
  assert.equal((await audits('document.reconciliation_provider_recovered')).length, 2);
  const afterMatches = await matches();
  assert.deepEqual(afterMatches.map((m) => [m.matched_object_id, m.status, m.source]), [
    ['bill-supplies', 'auto_matched', 'supplier_bill_reconciliation_llm'],
    ['invoice-sale', 'auto_matched', 'sales_invoice_reconciliation_llm']
  ], JSON.stringify(afterMatches));
  assert.deepEqual((await evaluations()).map((e) => [e.target_id, e.verdict]), [['bill-supplies', 'proposed'], ['invoice-sale', 'proposed']]);
  assert.equal((await q(DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL, [firmId, 10, [...RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES]])).rows.length, 0, 'nothing left to re-drive');
  // The same tick coded the now-matched lines and the ledger posted them.
  const lines = (await q("select id, coding_state, payload->'ai_suggestion'->>'source' as source, payload->'coding_provider_failure' as failure from transactions where client_id=$1 order by id", [clientId])).rows;
  for (const line of lines) assert.equal(line.coding_state, 'posted', JSON.stringify({ line, coder: first.coder }));
  assert.deepEqual((await journals()).map((j) => j.source_id), ['sale-line', 'supplies-line']);
  // Replay: another tick and another direct run spend no provider call and duplicate nothing.
  const settledCalls = { ...calls };
  await tick(); await tick();
  assert.equal(calls.anthropic, settledCalls.anthropic, 'no matcher call once recovered');
  assert.equal(calls.openai, settledCalls.openai, 'no coder call once posted');
  assert.equal((await matches()).length, 2, 'exactly one match per document');
  assert.equal((await journals()).length, 2, 'exactly one journal per line');
  assert.deepEqual(await asks(), [], 'no question was ever asked about a provider outage');

  // ── 4. The coder: an unreadable body and a hung body are typed and bounded; nothing late is written ──
  await tx('bare-line', { out: 19.90, description: 'KORTTIOSTO K-MARKET', date: '2026-03-20' });
  const bare = async () => (await q("select coding_state, payload->'ai_suggestion' as suggestion, payload->'coding_provider_failure' as failure from transactions where id='bare-line'")).rows[0];
  calls.mode = 'openai_garbage';
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  let row = await bare();
  assert.equal(row.suggestion, null, 'an unreadable body is never a coding verdict');
  assert.equal(row.failure?.code, 'PROVIDER_INVALID_OUTPUT', JSON.stringify(row.failure));
  assert.equal(row.failure?.owner, 'queue');
  calls.mode = 'openai_hung_body';
  // A worker budget that can hold the attempt (5s) with the per-request
  // deadline (400ms) inside it: the body never arrives, the request times
  // out under the deadline, and the coder returns typed — no zombie.
  const hung = runWithExecutionBudget(createExecutionBudget({ timeoutMs: 5_000, label: 'proof#coder' }), () => batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] }));
  const hungStartedAt = Date.now();
  await hung;
  assert.ok(Date.now() - hungStartedAt < 5_000, 'the coder returned within the worker budget');
  row = await bare();
  assert.equal(row.suggestion, null);
  assert.equal(row.failure?.code, 'PROVIDER_TIMEOUT', JSON.stringify(row.failure));
  assert.equal(row.failure?.reason, 'request_timeout', JSON.stringify({ failure: row.failure, elapsed_ms: Date.now() - hungStartedAt }));
  assert.ok(calls.release, 'the provider still holds the body');
  calls.release(); calls.release = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  row = await bare();
  assert.equal(row.suggestion, null, 'the late body wrote no coding');
  calls.mode = 'openai_401';
  await assert.rejects(suggestTransactionCodingInDb({ firmId, transactionId: 'bare-line' }), (error) => error.statusCode === 503 && error.code === 'PROVIDER_UNAUTHORIZED' && error.details?.provider_failure?.owner === 'operator');
  row = await bare();
  assert.equal(row.suggestion, null, 'a single-suggest click on a rejected key persists no template coding');
  assert.equal(row.failure?.code, 'PROVIDER_UNAUTHORIZED');
  calls.mode = 'ok';
  const healed = await tick();
  assert.ok((healed.coder || []).some((c) => Number(c.suggested || 0) >= 1), JSON.stringify(healed.coder));
  row = await bare();
  assert.equal(row.failure, null, 'a completed coding clears the failure receipt');
  assert.ok(row.suggestion, "the strong coder's verdict landed once the provider answered");

  // ── 5. The ask drafter: the outbox dead letter names the provider, whatever the failure class ──
  const draftBatchFn = () => draftClientAskMessage({ clientProfile: { id: clientId, companyName: 'Lumo Kahvila Oy' },
    codingItems: [{ id: 'bare-line', description: 'KORTTIOSTO K-MARKET', date: '2026-03-20', money_out: 19.90, ai_suggestion: { ask_client_question: 'Mihin tämä liittyi?' } }] });
  for (const [mode, expectedCode] of [['ask_network', 'PROVIDER_NETWORK'], ['ask_hung_body', 'PROVIDER_TIMEOUT'], ['ask_garbage', 'PROVIDER_INVALID_OUTPUT']]) {
    calls.mode = mode;
    const out = await withClient(async (client) => {
      const inserted = await enqueueOutbox({ client, firmId, clientId, eventType: 'ask_draft.requested', objectType: 'client', objectId: clientId, payload: { source: 'proof', identity_contract: 'call_local_handles_v1' } });
      const outboxRow = (await client.query('select * from loop_event_outbox where id=$1', [inserted.id])).rows[0];
      const result = await runAskDraftRequest({ client, row: outboxRow, draftBatchFn });
      const after = (await client.query('select status, last_error from loop_event_outbox where id=$1', [inserted.id])).rows[0];
      await client.query("update loop_event_outbox set status='cancelled', last_error = jsonb_build_object('at', (now() - interval '1 hour')::text, 'reason', 'max_attempts', 'previous_error', last_error) where id=$1", [inserted.id]);
      return { result, after, id: inserted.id };
    });
    assert.equal(out.result.status, 'failed', `${mode}: ${JSON.stringify(out.result)}`);
    assert.equal(out.after.status, 'failed');
    assert.equal(out.after.last_error?.code, 'ASK_PIPELINE_LLM_UNAVAILABLE', `${mode}: the dead letter carries the code the outage recovery keys on`);
    assert.equal(out.after.last_error?.details?.provider_failure?.code, expectedCode, `${mode}: ${JSON.stringify(out.after.last_error)}`);
    assert.equal((await q(DISCOVER_ASK_DRAFT_OUTAGE_RECOVERY_SQL, [firmId, 10])).rows.length, 1, `${mode}: the outage recovery discovers it`);
    await q('delete from loop_event_outbox where id=$1', [out.id]);
  }
});
