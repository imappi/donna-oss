import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, resolveClientEvidenceRequestInDb } from './firmDb.js';
import { recoverOwnerRepliesInDb, DISCOVER_OWNER_REPLIES_SQL } from './ownerReplyRecovery.js';
import { listStructuredOwnerReplyEvidenceTypes } from './statutoryRegistry.js';

// A document-anchored owner question (transaction_id null, the document id in
// request_payload) answered through the real reply route while the document
// re-disposition provider is down. The answer must not rest 'replied' with
// nothing left to process it: the existing owner-reply clock re-drives the
// SAME re-disposition until the ask ends in a consequence.
const pgUrl = process.env.DONNA_PG_TEST_URL;
const VERDICT = { disposition: 'auto_explain', materiality: 'material', expense_kind: 'office_supplies',
  settlement_channel: 'personal_card', funding_source: 'owner', confidence: 0.92,
  reasoning: 'The owner paid the bill with a personal card.' };

test('document owner reply: transient provider failure is re-driven by the owner-reply clock, once', { skip: !pgUrl && 'DONNA_PG_TEST_URL not set' }, async (t) => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_doc_reply_recovery_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const priorKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test-doc-reply';
  t.after(async () => {
    __resetFirmDbPoolForTests();
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
    await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const firmId = 'doc-reply-firm', clientId = 'doc-reply-client';
  await pool.query("insert into firms(id,name,slug) values($1,'Doc reply firm','doc-reply-firm')", [firmId]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Studio Oy','fi','{"jurisdiction":"fi","accounting_system":"none"}')`, [clientId, firmId]);
  await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason)
    values('doc-reply-flag',$1,$2,'DOCUMENT_NO_LINE_DISPOSITION','auto','manual','Synthetic document reply test')`, [firmId, clientId]);
  const seed = async (id, evidenceType = 'payment_method') => {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,status,vendor_name,total_amount,currency,document_date,parse_status)
      values($1,$2,$3,$4,'supplier_bill','parsed','Example Supplies Oy',240,'EUR','2026-06-10','completed')`, [`doc-${id}`, firmId, clientId, `bill-${id}.pdf`]);
    await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,status,evidence_type,question,request_payload)
      values($1,$2,$3,'open',$4,'How was this bill paid?',$5::jsonb)`,
    [`ask-${id}`, firmId, clientId, evidenceType, JSON.stringify({ document_id: `doc-${id}` })]);
  };
  const reply = id => resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: `ask-${id}`,
    reply: 'I paid it with my personal card.', actorId: 'owner@example.test', actorType: 'client' });
  const ask = async id => (await pool.query('select * from client_evidence_requests where id=$1', [`ask-${id}`])).rows[0];

  let calls = 0, fail = true;
  t.mock.method(globalThis, 'fetch', async (endpoint) => {
    assert.equal(endpoint, 'https://api.anthropic.com/v1/messages'); calls++;
    if (fail) throw new Error('simulated provider outage');
    return { ok: true, status: 200, json: async () => ({ id: `msg-${calls}`, type: 'message', role: 'assistant', model: 'fixture-model',
      content: [{ type: 'text', text: JSON.stringify(VERDICT) }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }) };
  });

  // 1. The real reply route commits the answer, then the provider fails.
  await seed('outage');
  const initial = await reply('outage');
  assert.equal(initial.evidence_request.status, 'replied');
  assert.equal(calls, 1, 'the inline answer leg tried once');
  let saved = await ask('outage');
  assert.equal(saved.response_payload.reply_processing.state, 'retry_pending', 'the failure is receipted for the clock');
  assert.equal(saved.response_payload.reply_processing.code, 'OWNER_REPLY_PROVIDER_UNAVAILABLE');
  assert.equal((await pool.query(DISCOVER_OWNER_REPLIES_SQL, [firmId, 10, listStructuredOwnerReplyEvidenceTypes()])).rows.map(r => r.id).includes('ask-outage'), true,
    'the recovery sweep discovers the replied document ask');

  // 2. Provider back: the existing sweep re-drives the same re-disposition.
  fail = false;
  const recovered = await recoverOwnerRepliesInDb({ firmId });
  assert.equal(recovered.find(r => r.evidence_request_id === 'ask-outage')?.applied, true, JSON.stringify(recovered));
  saved = await ask('outage');
  assert.equal(saved.status, 'resolved');
  assert.equal(saved.response_payload.resolved_by_disposition, 'owner_reply_redisposition');
  assert.equal(saved.response_payload.reply_processing.state, 'completed');
  const verdict = (await pool.query(`select verdict, payload from reconciliation_evaluations where firm_id=$1 and target_id='doc-outage'`, [firmId])).rows[0];
  assert.ok(verdict, 'the document carries the owner-reply verdict');
  assert.equal(verdict.payload?.verdict_source, 'owner_reply');
  const recoveredFailure = (await pool.query(`select metadata from audit_events where resource_id='ask-outage' and action='evidence_request.reply_processed'`)).rows;
  assert.equal(recoveredFailure.length, 1);
  assert.ok(recoveredFailure[0].metadata.recovered_failure_id, 'the completion names the failure it recovered');

  // 3. A second sweep does not process it twice.
  const afterCalls = calls;
  const again = await recoverOwnerRepliesInDb({ firmId });
  assert.equal(again.some(r => r.evidence_request_id === 'ask-outage'), false);
  assert.equal(calls, afterCalls);

  // 4. A reply processed inline is not re-driven; the same evidence type the
  //    unpaid-supplier-bill question uses rides the same path.
  await seed('inline');
  const inline = await reply('inline');
  assert.equal(inline.evidence_request.status, 'resolved');
  assert.equal((await ask('inline')).response_payload.reply_processing.state, 'completed');
  const inlineCalls = calls;
  assert.equal((await recoverOwnerRepliesInDb({ firmId })).some(r => r.evidence_request_id === 'ask-inline'), false);
  assert.equal(calls, inlineCalls);
  assert.equal((await pool.query(`select count(*)::int as n from audit_events where resource_id='ask-inline' and action='evidence_request.reply_processed'`)).rows[0].n, 1);

  // 5. A permanent refusal (the document is gone) does not loop: it exhausts
  //    at the existing bound without a model call and rests as a runtime
  //    repair incident for a named workspace maintainer.
  await seed('gone');
  await pool.query("delete from documents where id='doc-gone'");
  const goneCalls = calls;
  await reply('gone');
  for (let i = 0; i < 4; i++) await recoverOwnerRepliesInDb({ firmId });
  const gone = (await ask('gone')).response_payload.reply_processing;
  assert.equal(gone.state, 'exhausted'); assert.equal(gone.attempts, 3);
  assert.equal(gone.code, 'OWNER_REPLY_SOURCE_INVALID');
  assert.equal(calls, goneCalls, 'no model call for a missing document');
  assert.equal((await pool.query(DISCOVER_OWNER_REPLIES_SQL, [firmId, 10, listStructuredOwnerReplyEvidenceTypes()])).rows.some(r => r.id === 'ask-gone'), false);
  const { listRuntimePolicyIncidents } = await import('./runtimePolicyIncidentDb.js');
  const client = await pool.connect();
  try {
    const incidents = await listRuntimePolicyIncidents({ client, firmId });
    assert.equal(incidents.some(i => i.evidence_request_id === 'ask-gone'), true, JSON.stringify(incidents));
  } finally { client.release(); }
});
