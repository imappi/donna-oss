// Finnish reliability pass (2026-09-12) — provider failures on the named
// writers, real PostgreSQL, the provider stubbed at fetch. Each lane must keep
// the technical CAUSE on the persisted row, keep a usable recovery path, and
// finish once the provider is healthy again — never disguised as missing
// evidence, endless processing, or a completed coding. Provider-stubbed
// lifecycle evidence only; live-model quality is a separate question.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, resolveClientEvidenceRequestInDb } from './firmDb.js';
import { runCodingConvergence, runCodingConvergenceInDb, DISCOVER_CODER_CLIENTS_SQL, DISCOVER_ASK_DRAFT_OUTAGE_RECOVERY_SQL, recoverAskDraftOutageDeadLetters } from './codingConvergence.js';
import { recoverRefusedCodingEvidenceInDb, hasPendingPostingRecoveryWithClient } from './db/codingRefusalRecovery.js';
import { recordRefusalViaDb } from './ledgerAutoPost.js';
import { recoverOwnerRepliesInDb, retryOwnerReplyProcessingInDb, DISCOVER_OWNER_REPLIES_SQL, OWNER_REPLY_OUTAGE_COOLDOWN_MS } from './ownerReplyRecovery.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { currentCodingEvidence, codingEvidenceDigest } from './db/codingEvidence.js';
import { listStructuredOwnerReplyEvidenceTypes } from './statutoryRegistry.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

const openAiBody = (payload) => ({ ok: true, status: 200, json: async () => ({ id: 'fixture-response', output_text: JSON.stringify(payload) }) });
const verdict = (row, account, treatment, extra = {}) => ({ transaction_id: row.id, proposed_account: account, tax_treatment: treatment, confidence: 'high',
  evidence_required: false, auto_explain_limit: 0, reasoning: 'fixture verdict grounded in the matched Finnish document', posting_requirement: 'single_account',
  document_allocations: [], ask_client_question: '', contact: '', support_note: '', remember_candidate: false, merchant_pattern: '', missing_account_name: '',
  missing_account_type: '', missing_account_reason: '', materiality: 'normal', warnings: [], alternatives: [], ...extra });

test('real PG (FI): provider failures keep their cause and every lane finishes once the provider is healthy', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async (t) => {
  const name = `donna_fi_provider_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  installConvergenceSettleOnPool(pool);
  const closed = []; pool.on('connect', (c) => closed.push(new Promise((resolve) => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const priorEnv = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, LOOPS_TIER: process.env.LOOPS_TIER, LOOPS_SHADOW: process.env.LOOPS_SHADOW };
  const priorFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'fixture-only'; process.env.LOOPS_TIER = 'canary'; process.env.LOOPS_SHADOW = 'true';
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

  const firmId = 'fi-outage-firm', clientId = 'lumo';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,'FI Outage Firm','fi-outage-firm',$2)", [firmId, { loops: { tier: 'canary' } }]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Lumo Kahvila Oy','fi','fi-oy',$3)`,
    [clientId, firmId, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'accrual', alv_registration: { status: 'registered', registered_from: '2020-01-01' } }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST'])
    await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')`, [flag, firmId, clientId, flag]);
  const tx = (id, amount, description, date = '2026-03-05') => pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload) values($1,$2,$3,$4,$5,$6,0,'EUR','needs_review','{}')`, [id, firmId, clientId, date, description, amount]);
  const doc = async (id, filename, total, tax, components) => {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload,checksum_sha256) values($1,$2,$3,$4,'supplier_bill','completed',$5,$6,'EUR','2026-03-05','{}',$7)`, [id, firmId, clientId, filename, total, tax, `sha-${id}`]);
    for (const [i, line] of components.entries()) await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,$5,$6,$7,'{}')`, [`${id}-${i}`, firmId, clientId, id, i + 1, line[0], line[1]]);
  };
  const match = (id, documentId, amount) => pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'supplier_bill',$5,$6,1,'auto_matched','fixture','{}')`, [`match-${id}`, firmId, clientId, id, documentId, amount]);
  const row = async (id, columns = 'coding_state, account_code, payload') => (await pool.query(`select ${columns} from transactions where id=$1`, [id])).rows[0];
  const journals = async (id) => (await pool.query('select id from ledger_journals where source_id=$1', [id])).rows.length;
  const calls = { coding: 0, mode: 'ok' };
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://api.openai.com/v1/responses') throw new Error('Network disabled in proof');
    const request = JSON.parse(init.body); const input = JSON.parse(request.input);
    if (request.text?.format?.name?.startsWith('transaction_coding')) {
      calls.coding += 1;
      if (calls.mode === '429') return { ok: false, status: 429, json: async () => ({ error: { message: 'Rate limit reached for gpt-5.4', type: 'requests', code: 'rate_limit_exceeded' } }) };
      if (calls.mode === '401') return { ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }) };
      if (calls.mode === 'network') throw Object.assign(new Error('fetch failed: ECONNRESET'), { code: 'ECONNRESET' });
      const rows = input.transactions || [input.transaction];
      const suggestions = rows.map((r) => {
        if (r.id.startsWith('supplies')) return verdict(r, 'Operating supplies', 'ALV 25,5 %');
        if (r.id.startsWith('rent')) return verdict(r, 'Rent', 'Veroton toiminta (ALV-vapaa)');
        if (r.id === 'fuel') {
          if (r.client_reply_context) {
            assert.equal(r.matched_document?.filename,'Fuel-receipt.pdf','the business-use reply supplements the held VAT receipt');
            assert.equal(r.matched_document?.tax_amount,10.59);
            return verdict(r, 'Motor expenses', 'ALV 25,5 %');
          }
          return verdict(r, 'Motor expenses', 'ALV 25,5 %', { posting_requirement: 'owner_fact', evidence_required: true, ask_client_question: 'Was this fuel used for business driving or personal driving?' });
        }
        if (r.id === 'ticket') {
          // 2026 line: 14 % is a historical rate, so the coder states the basis it
          // read from the re-read source (the December 2025 journey) or it would
          // be the document_discrepancy question, not a posting.
          if (r.posting_recovery?.source_verified) {
            assert.match(r.posting_recovery.printed_lines[0].description, /28\.12\.2025/);
            return verdict(r, 'Travel', 'ALV 14 %', { historical_rate_basis: 'supply_before_rate_change' });
          }
          return verdict(r, 'Travel', 'ALV 25,5 %');
        }
        return verdict(r, 'Suspense', 'ALV-tarkistus');
      });
      return openAiBody(input.transactions ? { suggestions, group_summary: [] } : suggestions[0]);
    }
    throw new Error(`unexpected lane ${request.text?.format?.name}`);
  };
  const admission = { runWorkerAdmissionFn: async ({ work }) => work() };
  const tick = () => runCodingConvergenceInDb({ firmId, discoverSweepClientsFn: async () => [], recoverAskDraftFn: async () => [],
    requestAskDraftFn: async () => ({ enqueued: 0 }), ...admission, recoverOwnerRepliesFn: (args) => recoverOwnerRepliesInDb({ ...args, ...admission }) });

  // ── Coder lane: a rate-limited, a rejected and an unreachable provider ──
  await tx('supplies-a', 251, 'KORTTIOSTO TARVIKETUKKU OY TT-88213'); await tx('supplies-b', 125.5, 'KORTTIOSTO TARVIKETUKKU OY TT-88214');
  await doc('bill-a', 'TT-88213.pdf', 251, 51, [['Kahvilatarvikkeet', 200]]); await doc('bill-b', 'TT-88214.pdf', 125.5, 25.5, [['Kahvilatarvikkeet', 100]]);
  await match('supplies-a', 'bill-a', 251); await match('supplies-b', 'bill-b', 125.5);
  for (const mode of ['429', '401', 'network']) {
    calls.mode = mode;
    const before = calls.coding;
    // 2026-09-13 (the shared provider transport): a reset socket is the SAME
    // typed provider failure as a 429 or a 401 — receipted, never thrown raw.
    await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
    assert.ok(calls.coding > before, `${mode}: the provider was called`);
    for (const id of ['supplies-a', 'supplies-b']) {
      const r = await row(id);
      assert.equal(r.payload.ai_suggestion ?? null, null, `${mode}: a provider failure is never persisted as a coding verdict`);
      assert.equal(r.coding_state ?? null, null);
      const expected = { '429': ['PROVIDER_RATE_LIMITED', 429, 'queue'], '401': ['PROVIDER_UNAUTHORIZED', 401, 'operator'], network: ['PROVIDER_NETWORK', 0, 'queue'] }[mode];
      assert.equal(r.payload.coding_provider_failure?.code, expected[0], `${mode}: the typed cause rides the line`);
      assert.equal(r.payload.coding_provider_failure?.status, expected[1]);
      assert.equal(r.payload.coding_provider_failure?.owner, expected[2], `${mode}: a credential failure rests on the operator`);
      assert.equal(r.payload.coding_provider_failure?.provider, 'openai');
      assert.equal(await journals(id), 0);
    }
    const discovered = await pool.query(DISCOVER_CODER_CLIENTS_SQL, [firmId, 5]);
    assert.deepEqual(discovered.rows.map((d) => [d.client_id, Number(d.unseen_lines)]), [[clientId, 2]], `${mode}: the clock still owes the lines`);
  }
  assert.equal((await pool.query("select count(*)::int n from audit_events where action='transaction.coding_provider_failed' and client_id=$1", [clientId])).rows[0].n, 3, 'one receipt per distinct failure (429, 401, network), not per tick');
  // The key is fixed / the provider recovers: the existing clock finishes the work.
  calls.mode = 'ok';
  const healed = await tick();
  assert.equal(healed.coder[0]?.suggested, 2, JSON.stringify(healed.coder));
  for (const id of ['supplies-a', 'supplies-b']) {
    const r = await row(id);
    assert.equal(r.coding_state, 'posted', JSON.stringify({ id, coding_state: r.coding_state, refusal: r.payload.ledger_post_refusal, status: r.payload.ai_suggestion_status, healed }));
    assert.equal(r.payload.ai_suggestion.source, 'openai_batch');
    assert.equal(r.payload.coding_provider_failure, undefined, 'a completed coding clears the failure receipt');
    assert.equal(await journals(id), 1);
  }
  assert.equal((await pool.query(DISCOVER_CODER_CLIENTS_SQL, [firmId, 5])).rows.length, 0);

  // ── Posting-source re-read lane: the cause is retained, exhaustion is not final ──
  const trainRow = (await pool.query("select payload from transactions where id='supplies-a'")).rows[0].payload;
  await tx('ticket', 28.60, 'VR MATKALIPPU', '2026-03-09');
  await doc('ticket-doc', 'Matkalippu.pdf', 28.60, 2.60, [['Journey', 28.60]]);
  await match('ticket', 'ticket-doc', 28.60);
  const evidence = await currentCodingEvidence({ client: pool, firmId, clientId, transactionId: 'ticket' });
  await pool.query("update documents set parse_run_id=gen_random_uuid() where id='ticket-doc'");
  await pool.query("update transactions set coding_state='applied',payload=$1 where id='ticket'", [{ ai_suggestion_status: 'auto_applied', tax_treatment: 'ALV 25,5 %',
    ai_suggestion: { ...trainRow.ai_suggestion, transaction_id: 'ticket', proposed_account: 'Travel', tax_treatment: 'ALV 25,5 %', evidence_digest: codingEvidenceDigest(evidence) } }]);
  await recordRefusalViaDb({ firmId, clientId, transactionId: 'ticket', error: { code: 'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH', message: 'Printed VAT 2.60 differs from coding' } });
  let rereads = 0;
  const outage = async () => { rereads += 1; return { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'anthropic_529', http_status: 529, provider: 'anthropic', retryable: true, model: null }; };
  for (let i = 0; i < 4; i += 1) await recoverRefusedCodingEvidenceInDb({ firmId, rereadFn: outage });
  assert.equal(rereads, 3, 'three attempts per episode');
  let recovery = (await row('ticket')).payload.posting_recovery;
  assert.equal(recovery.state, 'exhausted');
  assert.equal(recovery.code, 'POSTING_SOURCE_RECHECK_FAILED');
  assert.deepEqual({ code: recovery.cause?.code, reason: recovery.cause?.reason, http_status: recovery.cause?.http_status, retryable: recovery.cause?.retryable },
    { code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'anthropic_529', http_status: 529, retryable: true }, 'the provider cause survives exhaustion');
  assert.equal(await hasPendingPostingRecoveryWithClient(pool, firmId, 'ticket'), false, 'an exhausted episode is not shown as processing');
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='ticket'")).rows[0].n, 0, 'an outage is never a client question');
  // Within the cooldown the exhausted episode rests; once it elapses and the
  // provider answers, a new episode reads the source and the coder reconsiders.
  // The healthy re-read shows the first extraction misread the printed VAT
  // (3.51 at 14 %, not 2.60): the named parse writer repairs the header, the
  // coder reconsiders, and the line posts — no owner question.
  const healthy = async ({ context }) => ({ kind: 'completed', model: 'fixture-source-reader', header: { total_amount: Number(context.source.total_amount), currency: 'EUR', document_date: '2026-03-05' },
    summary: { tax_amount: 3.51, subtotal_amount: 25.09, warnings: [] }, lines: [{ description: 'Journey 28.12.2025, printed at 14%', amount: 28.60, tax_rate: 0.14 }] });
  assert.equal((await recoverRefusedCodingEvidenceInDb({ firmId, rereadFn: healthy })).length, 0, 'the cooldown holds');
  await pool.query(`update transactions set payload = jsonb_set(payload, '{posting_recovery,failed_at}', to_jsonb((now() - interval '3 hours')::text)) where id='ticket'`);
  assert.equal(await hasPendingPostingRecoveryWithClient(pool, firmId, 'ticket'), true, 'after the cooldown the episode is owed again');
  const reopened = await recoverRefusedCodingEvidenceInDb({ firmId, rereadFn: healthy });
  assert.equal(reopened[0]?.state, 'reconsidered', JSON.stringify(reopened));
  recovery = (await row('ticket')).payload.posting_recovery;
  assert.equal(recovery.episode, 2); assert.equal(recovery.attempts, 1);
  assert.equal(Number((await pool.query("select tax_amount from documents where id='ticket-doc'")).rows[0].tax_amount), 3.51, 'the extraction header was repaired through the parse writer');
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.equal((await row('ticket')).coding_state, 'posted', JSON.stringify({ row: await row('ticket', 'coding_state, payload->\'ledger_post_refusal\' as refusal') }));
  assert.equal(await journals('ticket'), 1);
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='ticket'")).rows[0].n, 0);

  // ── Owner reply lane: an outage-exhausted answer re-enters after the cooldown ──
  await tx('fuel', 52.10, 'KORTTIOSTO NESTE OULU', '2026-03-12');
  // The owner supplies business use, not missing purchase-tax evidence.
  await doc('fuel-doc','Fuel-receipt.pdf',52.10,10.59,[['Fuel',41.51]]);
  await pool.query("update documents set document_date='2026-03-12' where id='fuel-doc'");
  await match('fuel','fuel-doc',52.10);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.equal((await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: 'fuel', configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } } })).owner_asked, 1);
  const ask = (await pool.query("select * from client_evidence_requests where transaction_id='fuel' and status in ('draft','open')")).rows[0];
  assert.equal(ask.evidence_type, 'business_purpose');
  await pool.query("update client_evidence_requests set status='open' where id=$1", [ask.id]);
  calls.mode = '429';
  const replied = await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: ask.id, reply: 'Business driving to the wholesale market, no private use.', actorId: 'owner@lumo.test', actorType: 'client' });
  assert.equal(replied.evidence_request.status, 'replied'); assert.equal(replied.recode.applied, false);
  for (let i = 0; i < 4; i += 1) await recoverOwnerRepliesInDb({ firmId, ...admission });
  let processing = (await pool.query('select response_payload from client_evidence_requests where id=$1', [ask.id])).rows[0].response_payload.reply_processing;
  assert.equal(processing.state, 'exhausted'); assert.equal(processing.attempts, 3); assert.equal(processing.code, 'OWNER_REPLY_PROVIDER_UNAVAILABLE');
  assert.equal((await pool.query(DISCOVER_OWNER_REPLIES_SQL, [firmId, 10, listStructuredOwnerReplyEvidenceTypes()])).rows.length, 0, 'inside the cooldown the answer rests');
  calls.mode = 'ok';
  const codingCalls = calls.coding;
  await recoverOwnerRepliesInDb({ firmId, ...admission });
  assert.equal(calls.coding, codingCalls, 'no call inside the cooldown');
  await pool.query(`update client_evidence_requests set updated_at = now() - ($2 || ' milliseconds')::interval where id=$1`, [ask.id, String(OWNER_REPLY_OUTAGE_COOLDOWN_MS + 60_000)]);
  assert.equal((await pool.query(DISCOVER_OWNER_REPLIES_SQL, [firmId, 10, listStructuredOwnerReplyEvidenceTypes()])).rows.length, 1, 'after the cooldown the clock owes the answer again');
  const recovered = await tick();
  assert.equal(recovered.owner_reply_recovery?.[0]?.applied, true, JSON.stringify(recovered.owner_reply_recovery));
  assert.equal((await pool.query('select status from client_evidence_requests where id=$1', [ask.id])).rows[0].status, 'resolved');
  processing = (await pool.query('select response_payload from client_evidence_requests where id=$1', [ask.id])).rows[0].response_payload.reply_processing;
  assert.equal(processing.state, 'completed'); assert.equal(processing.episode, 2);
  assert.equal((await row('fuel')).coding_state, 'posted', JSON.stringify(await row('fuel')));
  assert.equal(await journals('fuel'), 1);
  assert.equal(Number((await pool.query("select sum(l.debit) as vat from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='fuel' and l.account_code='2940'")).rows[0].vat),10.59,'deduction is the held receipt VAT, not created by the owner reply');
  // ── S6: retry, restart and replay after the answer was applied ──
  const settledCalls = calls.coding;
  await recoverOwnerRepliesInDb({ firmId, ...admission });
  assert.equal((await retryOwnerReplyProcessingInDb({ firmId, clientId, transactionId: 'fuel' })).eligible_replies, 0);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  await tick(); await tick();
  assert.equal(calls.coding, settledCalls, 'a replayed answer spends no model call');
  assert.equal(await journals('fuel'), 1, 'exactly one journal after retry/restart replays');
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='fuel'")).rows[0].n, 1, 'the answered question was neither duplicated nor re-asked');
  assert.equal((await pool.query("select count(*)::int n from audit_events where action='evidence_request.reply_processed' and resource_id=$1", [ask.id])).rows[0].n, 1);

  // ── Ask-draft lane: a draft dead-lettered on a provider outage is re-requested once the outage is over ──
  await tx('bare', 19.90, 'KORTTIOSTO K-MARKET', '2026-03-20');
  const deadAt = new Date(Date.now() - 20 * 60_000).toISOString();
  await pool.query(`insert into loop_event_outbox(id,firm_id,client_id,event_type,object_type,object_id,payload,status,attempts,last_error,created_at)
    values('dead-draft',$1,$2,'ask_draft.requested','client',$2,$3::jsonb,'cancelled',5,$4::jsonb,$5::timestamptz)`,
    [firmId, clientId, JSON.stringify({ source: 'coding_convergence', identity_contract: 'call_local_handles_v1' }),
      JSON.stringify({ at: deadAt, reason: 'max_attempts', previous_error: { at: deadAt, code: 'ASK_PIPELINE_LLM_UNAVAILABLE', message: 'OpenAI draft request failed with 429.' } }), deadAt]);
  assert.equal((await pool.query(DISCOVER_ASK_DRAFT_OUTAGE_RECOVERY_SQL, [firmId, 10])).rows.length, 1, 'the dead letter names the outage');
  const requests = [];
  const recovery1 = await runCodingConvergence({ firmId, discoverCoderClientsFn: async () => [], discoverSweepClientsFn: async () => [], discoverLedgerPostClientsFn: async () => [], releaseWaitingFn: async () => [],
    recoverAskDraftFn: (args) => recoverAskDraftOutageDeadLetters({ ...args, client: pool, requestAskDraftFn: async (req) => { requests.push(req); await pool.query(`insert into loop_event_outbox(id,firm_id,client_id,event_type,object_type,object_id,payload,status) values($1,$2,$3,'ask_draft.requested','client',$3,$4::jsonb,'pending')`, [`req-${requests.length}`, firmId, clientId, JSON.stringify({ source: req.source })]); return { enqueued: 1 }; } }) });
  assert.deepEqual(recovery1.ask_draft_recovery.map((r) => [r.client_id, r.enqueued, r.reason]), [[clientId, 1, undefined]], JSON.stringify(recovery1.ask_draft_recovery));
  assert.equal(requests[0].source, 'provider_outage_recovery');
  assert.equal((await pool.query(DISCOVER_ASK_DRAFT_OUTAGE_RECOVERY_SQL, [firmId, 10])).rows.length, 0, 'a later request settles the dead letter');
  const recovery2 = await runCodingConvergence({ firmId, discoverCoderClientsFn: async () => [], discoverSweepClientsFn: async () => [], discoverLedgerPostClientsFn: async () => [], releaseWaitingFn: async () => [],
    recoverAskDraftFn: (args) => recoverAskDraftOutageDeadLetters({ ...args, client: pool, requestAskDraftFn: async (req) => { requests.push(req); return { enqueued: 1 }; } }) });
  assert.deepEqual(recovery2.ask_draft_recovery, []); assert.equal(requests.length, 1);
});
