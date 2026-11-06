import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { readReconcileActivityWithClient } from './db/reconcileActivity.js';
import { streamEntryState } from '../../src/lib/periodOverview.js';

// H-7(a): an answer is attributed to every row its question anchors — the
// rows the convergence law routes it to (collectOwnerAskSets) — not only to
// transaction_id. The reply-recovery worker's eligible IDs own the cycle.
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PostgreSQL: a reply without transaction_id starts the display cycle on the rows it anchors', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const name = `donna_reply_display_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  t.after(async () => { await client.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await client.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(file, root), 'utf8'));
  await client.query("insert into firms(id,name,slug) values('firm','Firm','firm')");
  await client.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type) values
    ('salon','firm','Salong Oy','fi','fi-oy'),('dune','firm','Dune LLC','ae','ae-llc')`);
  // Every source arrived yesterday, so its upload allowance is long spent.
  await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,created_at,convergence_state,convergence_reason) values
    ('statement','firm','salon','OP 02-2025.pdf','bank_statement','completed',now()-interval '1 day',null,null),
    ('dune-statement','firm','dune','ENBD 02-2025.pdf','bank_statement','completed',now()-interval '1 day',null,null),
    ('cash','firm','dune','Cash receipt.pdf','receipt','completed',now()-interval '1 day','hanging','owner_answered_processing')`);
  await client.query(`insert into transactions(id,firm_id,client_id,document_id,transaction_date,money_out,currency,status,coding_state,convergence_state,convergence_reason,created_at) values
    ('first','firm','salon','statement','2025-02-03',40,'EUR','needs_review','asked','hanging','owner_answered_processing',now()-interval '1 day'),
    ('sibling','firm','salon','statement','2025-02-04',55,'EUR','needs_review','asked','hanging','owner_answered_processing',now()-interval '1 day'),
    ('ordinary','firm','salon','statement','2025-02-05',12,'EUR','needs_review','asked','hanging','owner_answered_processing',now()-interval '1 day'),
    ('open-line','firm','salon','statement','2025-02-07',9,'EUR','needs_review','asked','on_owner','open_owner_ask',now()-interval '1 day'),
    ('vat-line','firm','dune','dune-statement','2025-02-06',525,'AED','needs_review','asked','hanging','owner_answered_processing',now()-interval '1 day')`);
  const reply = `'{"reply":"It was the business account ending 4411.","responded_at":"${new Date().toISOString()}"}'`;
  await client.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,audience,evidence_type,question,responded_at,response_payload,request_payload) values
    ('statement-ask','firm','salon','first','replied','client','bank_statement','Which account paid these?',now(),${reply},'{"anchor_transaction_ids":["first","sibling"]}'),
    ('ordinary-ask','firm','salon','ordinary','replied','client','business_purpose','What was this for?',now(),${reply},'{}'),
    ('open-ask','firm','salon','open-line','open','client','business_purpose','What was this for?',null,'{}','{}'),
    ('vat-ask','firm','dune',null,'replied','client','ae_vat_business_use','What was the invoice used for?',now(),${reply},'{"anchor_transaction_ids":["vat-line"],"vat_document_id":"dune-invoice"}'),
    ('cash-ask','firm','dune',null,'replied','client','ct_registration_status','Is the company registered?',now(),${reply},'{"document_id":"cash"}')`);

  const state = async () => {
    const transactions = (await client.query('select * from transactions order by id')).rows;
    const documents = (await client.query('select * from documents order by id')).rows;
    const activity = await readReconcileActivityWithClient(client, { firmId: 'firm', transactions, documents, observedAt: new Date().toISOString() });
    const row = id => { const tx = transactions.find(r => r.id === id); return { ...tx, processing_activity: activity.get(id) || null }; };
    const cash = documents.find(d => d.id === 'cash');
    return { activity, first: streamEntryState('open', row('first')), sibling: streamEntryState('open', row('sibling')),
      ordinary: streamEntryState('open', row('ordinary')), open: streamEntryState('owner', row('open-line')), vat: streamEntryState('open', row('vat-line')),
      cash: streamEntryState('document', { document: { ...cash, processing_activity: activity.get('document:cash') || null } }) };
  };

  let seen = await state();
  assert.equal(seen.first, 'processing', 'the minting line already joined the reply owner set');
  assert.equal(seen.sibling, 'processing', 'every line the statement request anchors waits on the same reply');
  assert.equal(seen.vat, 'processing', 'a document-only structured reply starts the cycle on its anchored bank line');
  assert.equal(seen.cash, 'processing', 'a document-anchored reply starts the cycle on that document');
  assert.equal(seen.activity.get('vat-line').phase, 'applying_reply');
  assert.equal(seen.activity.get('document:cash').phase, 'applying_reply');
  assert.equal(seen.activity.get('sibling').batch_id, seen.activity.get('first').batch_id, 'one reply, one publication boundary');
  assert.equal(seen.ordinary, 'processing', 'an ordinary coding reply keeps its existing cycle');
  assert.equal(seen.open, 'needs_input', 'an unrelated open question keeps its verdict');

  // Exhaustion leaves no worker owner: the persisted hanging verdict speaks.
  await client.query(`update client_evidence_requests set response_payload=response_payload || '{"reply_processing":{"state":"exhausted","attempts":3}}'::jsonb
    where id in ('vat-ask','cash-ask','statement-ask')`);
  seen = await state();
  for (const key of ['first', 'sibling', 'vat', 'cash']) assert.equal(seen[key], 'stalled', `${key}: an exhausted reply is not processing`);

  // Once the consumer settles, the persisted verdict renders at once with no
  // lingering cycle — for the structured reply and the ordinary coding reply.
  await client.query(`update client_evidence_requests set status='resolved',resolved_at=now(),response_payload=${reply} where id in ('vat-ask','ordinary-ask')`);
  await client.query(`update transactions set coding_state='posted',status='posted',convergence_state='auto_reconciled',convergence_reason='posted' where id in ('vat-line','ordinary')`);
  seen = await state();
  assert.equal(seen.vat, 'reconciled');
  assert.equal(seen.ordinary, 'reconciled');
  assert.equal(seen.activity.get('vat-line'), undefined);
  assert.equal(seen.activity.get('ordinary'), undefined);
  assert.equal(seen.open, 'needs_input');
});
