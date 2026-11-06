import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { handleDonnaApiRequest } from './api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { recordDocumentCorrectionInDb } from './documentCorrections.js';
import { postLedgerJournalForTransaction } from './db/ledger.js';
import { rowToTransactionPayload } from './db/transactions.js';

const request = async (route, body, token = 'owner-jwt') => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = `/api/donna/firms${route}`;
  req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let result;
  let finish;
  const ended = new Promise((resolve) => { finish = resolve; });
  const res = { statusCode: 200, setHeader() {}, end(value) { result = JSON.parse(String(value)); finish(); } };
  await handleDonnaApiRequest(req, res);
  await ended;
  return { status: res.statusCode, body: result };
};

test('real document chat: canonical unknown currency, attributed correction, replay, clear and posted-source refusal', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL not set — real document currency repair not exercised'
}, async (t) => {
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `donna_doc_currency_${Date.now().toString(36)}_${process.pid}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL);
  url.pathname = `/${name}`;
  // A missing NOWAIT must fail this race proof instead of hanging the CI shard.
  const pool = new pg.Pool({ connectionString: url.toString(), statement_timeout: 5000 });
  const closed = [];
  pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const env = {
    DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-the-owner-token',
    SUPABASE_URL: 'https://currency-auth.invalid', SUPABASE_ANON_KEY: 'test-key',
    DONNA_AUTH_ALLOWED_EMAILS: 'owner@currency.example,seat@currency.example', OPENAI_API_KEY: 'test-only-no-network'
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await pool.end();
    await Promise.all(closed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((name) => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, root), 'utf8'));
  }
  await pool.query("insert into firms (id,name,slug) values ('currency-firm','Currency firm','currency-firm')");
  await pool.query(`insert into firm_members (id,firm_id,user_id,email,name,role,status,access_level)
    values ('currency-owner','currency-firm','owner-user','owner@currency.example','Owner','owner','active','staff')`);
  await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
    values ('currency-client','currency-firm','Currency Ltd','gb','{"accounting_system":"none"}'),
           ('other-client','currency-firm','Other Ltd','gb','{"accounting_system":"none"}')`);
  await pool.query(`insert into firm_collaborators (id,firm_id,user_id,email,name,role,seat_role,status)
    values ('currency-seat','currency-firm','seat-user','seat@currency.example','Senior','senior','senior','active')`);
  await pool.query(`insert into client_assignments (id,firm_id,client_id,principal_type,principal_id,role,assignment_kind)
    values ('currency-seat-assignment','currency-firm','currency-client','firm_collaborator','currency-seat','senior','capability')`);
  await pool.query(`insert into documents (id,firm_id,client_id,document_type,filename,total_amount,currency,document_date,parse_status,payload)
    values ('currency-doc','currency-firm','currency-client','receipt','receipt.pdf',10,null,'2026-09-05','completed','{"currency":"USD"}'),
           ('linked-doc','currency-firm','currency-client','receipt','linked.pdf',10,'GBP','2026-09-05','completed','{}')`);
  await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status)
    values ('currency-tx','currency-firm','currency-client','2026-09-05','Payment',10,'GBP','needs_review')`);
  await pool.query(`insert into reconciliation_matches (id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status)
    values ('currency-match','currency-firm','currency-client','currency-tx','receipt','currency-doc','suggested'),
           ('linked-match','currency-firm','currency-client','currency-tx','receipt','linked-doc','confirmed')`);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    if (endpoint === 'https://currency-auth.invalid/auth/v1/user') {
      if (init.headers.Authorization === 'Bearer seat-jwt') return { ok: true, json: async () => ({ id: 'seat-user', email: 'seat@currency.example' }) };
      return { ok: true, json: async () => ({ id: 'owner-user', email: 'owner@currency.example' }) };
    }
    assert.equal(endpoint, 'https://api.openai.com/v1/responses', 'only authenticated route and mocked provider HTTP');
    const body = JSON.parse(init.body);
    requests.push(body);
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ text: 'Confirm GBP for this receipt.', actions: [
      { type: 'correct_document_field', field_path: 'currency', corrected_value: 'GBP', reason: 'You confirmed GBP.' }
    ] }) }) };
  });
  const scope = { firm_id: 'currency-firm', client_id: 'currency-client', document_id: 'currency-doc' };
  const chat = await request('/document-chat/messages', {
    ...scope, message: 'The receipt is in GBP.',
    document_context: { id: 'forged-doc', currency: 'USD', total_amount: 9000 }
  });
  assert.equal(chat.status, 201, JSON.stringify(chat));
  const input = requests[0].input[0].content[0].text;
  const context = JSON.parse(input.slice(input.indexOf('\n') + 1));
  assert.equal(context.document.id, 'currency-doc');
  assert.equal(context.document.currency, null, 'neither browser currency nor legacy payload revives unknown denomination');
  assert.equal(context.document.total_amount, 10);
  assert.equal(context.document.document_date, '2026-09-05');
  assert.equal(context.document.reconciliation_match.linked_transaction.id, 'currency-tx');
  assert.equal(context.document.reconciliation_match.linked_transaction.date, '2026-09-05');
  assert.ok(requests[0].text.format.schema.properties.actions.items.properties.type.enum.includes('correct_document_field'));
  const messageId = chat.body.assistant_message.id;
  const applyRoute = `/document-chat/messages/${messageId}/actions/0/apply`;
  const wrongClient = await request(applyRoute, { ...scope, client_id: 'other-client' });
  assert.equal(wrongClient.status, 404, 'another client cannot consume this proposal');
  const applied = await request(applyRoute, { ...scope, corrected_value: 'USD', corrected_by: 'forged-actor' });
  assert.equal(applied.status, 201, JSON.stringify(applied));
  assert.equal((await pool.query("select currency from documents where id='currency-doc'")).rows[0].currency, 'GBP');
  // A bounded senior seat must resolve this focused document's persisted
  // amount; the model does not choose the capability target.
  const seatChat = await request('/document-chat/messages', { ...scope, message: 'Confirm this receipt is GBP.' }, 'seat-jwt');
  assert.equal(seatChat.status, 201, JSON.stringify(seatChat));
  const seatApply = await request(`/document-chat/messages/${seatChat.body.assistant_message.id}/actions/0/apply`, scope, 'seat-jwt');
  assert.equal(seatApply.status, 201, JSON.stringify(seatApply));
  const corrections = (await pool.query('select * from document_corrections')).rows;
  assert.equal(corrections.length, 2);
  assert.equal(corrections[0].prior_value, null);
  assert.equal(corrections[0].corrected_value, 'GBP');
  assert.equal(corrections[0].corrected_by, 'owner@currency.example');
  const receipt = (await pool.query("select * from audit_events where action='document.correction'")).rows[0];
  assert.equal(receipt.actor_id, 'owner@currency.example');
  assert.equal(receipt.metadata.authority_basis, 'human_source_currency_confirmation');
  assert.equal(receipt.metadata.model, chat.body.assistant_message.model);
  assert.equal((await request(applyRoute, scope)).body.idempotent_replay, true);
  assert.equal((await pool.query('select count(*)::int n from document_corrections')).rows[0].n, 2);
  const direct = { firmId: 'currency-firm', clientId: 'currency-client', documentId: 'currency-doc', fieldPath: 'currency', correctedBy: 'owner@currency.example' };
  for (const value of ['$', 'XYZ', 'unknown']) {
    await assert.rejects(recordDocumentCorrectionInDb({ ...direct, correctedValue: value }), { code: 'INVALID_FIELD_VALUE' });
  }
  await assert.rejects(recordDocumentCorrectionInDb(direct), { code: 'INVALID_FIELD_VALUE' });
  const absentValue = await request('/documents/currency-doc/corrections', { firm_id: scope.firm_id, field_path: 'currency', corrected_by: 'forged' });
  assert.equal(absentValue.status, 400);
  assert.equal(absentValue.body.code, 'INVALID_FIELD_VALUE');
  await assert.rejects(recordDocumentCorrectionInDb({ ...direct, correctedBy: 'system', correctedValue: 'GBP' }), { code: 'CORRECTION_ACTOR_REQUIRED' });
  const cleared = await request('/documents/currency-doc/corrections', { firm_id: scope.firm_id, field_path: 'currency', corrected_value: null, corrected_by: 'forged' });
  assert.equal(cleared.status, 201, JSON.stringify(cleared));
  assert.equal(cleared.body.correction.corrected_by, 'owner@currency.example');
  assert.equal((await pool.query("select currency from documents where id='currency-doc'")).rows[0].currency, null);
  await recordDocumentCorrectionInDb({ ...direct, correctedValue: 'gbp' });
  // The direct endpoint cannot bypass the same bound with a forged actor.
  await pool.query("update documents set total_amount=6000 where id='currency-doc'");
  const oversizedDirect = await request('/documents/currency-doc/corrections', {
    firm_id: scope.firm_id, field_path: 'currency', corrected_value: 'GBP', corrected_by: 'owner@currency.example'
  }, 'seat-jwt');
  assert.equal(oversizedDirect.status, 403, JSON.stringify(oversizedDirect));
  await pool.query("update documents set total_amount=10 where id='currency-doc'");
  await pool.query(`insert into ledger_journals (id,firm_id,client_id,source_type,source_id,journal_date,currency,status)
    values ('currency-journal','currency-firm','currency-client','document_settlement','currency-doc','2026-09-05','GBP','posted')`);
  const retained = (await pool.query("select * from ledger_journals where id='currency-journal'")).rows[0];
  const countBeforeRefusal = (await pool.query('select count(*)::int n from document_corrections')).rows[0].n;
  await assert.rejects(recordDocumentCorrectionInDb({ ...direct, correctedValue: 'EUR' }), { code: 'DOCUMENT_POSTED_CURRENCY_IMMUTABLE' });
  assert.equal((await pool.query('select count(*)::int n from document_corrections')).rows[0].n, countBeforeRefusal);
  assert.deepEqual((await pool.query("select * from ledger_journals where id='currency-journal'")).rows[0], retained);
  assert.equal((await pool.query("select currency from documents where id='currency-doc'")).rows[0].currency, 'GBP');
  const posting = await pool.connect();
  try {
    await posting.query('begin');
    const transaction = rowToTransactionPayload((await posting.query("select * from transactions where id='currency-tx'")).rows[0]);
    await postLedgerJournalForTransaction({
      client: posting, firmId: 'currency-firm', clientId: 'currency-client', transaction,
      coding: { account_code: '400', account_name: 'Office expenses', account_type: 'expense' },
      bankAccount: { code: '100', name: 'Bank', currency: 'GBP' }, actorId: 'owner@currency.example'
    });
    const beforeRace = (await pool.query("select * from audit_events where action='document.correction' order by id")).rows;
    await assert.rejects(recordDocumentCorrectionInDb({ ...direct, documentId: 'linked-doc', correctedValue: 'EUR' }), { code: '55P03' });
    assert.deepEqual((await pool.query("select * from audit_events where action='document.correction' order by id")).rows, beforeRace);
    await posting.query('commit');
  } catch (error) {
    await posting.query('rollback');
    throw error;
  } finally { posting.release(); }
  await assert.rejects(recordDocumentCorrectionInDb({ ...direct, documentId: 'linked-doc', correctedValue: 'EUR' }), { code: 'DOCUMENT_POSTED_CURRENCY_IMMUTABLE' });
  assert.equal((await pool.query("select currency from documents where id='linked-doc'")).rows[0].currency, 'GBP');
  await pool.query(`insert into documents (id,firm_id,client_id,document_type,filename,currency)
    values ('statement-doc','currency-firm','currency-client','bank_statement','statement.pdf',null)`);
  await assert.rejects(recordDocumentCorrectionInDb({ ...direct, documentId: 'statement-doc', correctedValue: 'GBP' }), { code: 'DOCUMENT_CURRENCY_CORRECTION_UNSUPPORTED' });
});
