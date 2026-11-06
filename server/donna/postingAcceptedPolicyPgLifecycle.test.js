// The named human review writer can replace a stale AI coding under today's
// persisted policy, and the named posting writer consumes its accepted receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, updateClientProfileInDb,
  updateTransactionReviewItemInDb, postLedgerTransactionInDb, upsertLedgerAccountForJournal } from './firmDb.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: named human correction stamps current posting authority while stale AI adoption refuses', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — accepted posting policy lifecycle not exercised'
}, async (t) => {
  const name = `donna_jn_accepted_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', (connection) => connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const firmId = 'accepted-policy-firm'; const clientId = 'accepted-policy-client'; const actorId = 'fixture-owner';
  await pool.query("insert into firms (id,name,slug) values ($1,'Accepted policy fixture','accepted-policy-fixture')", [firmId]);
  await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
    values ($1,$2,'Fixture company','GB','{"jurisdiction":"gb","accounting_system":"none"}')`, [clientId, firmId]);
  const suggestion = {
    proposed_account: 'Office expenses', tax_treatment: 'Outside scope', confidence: 'high',
    coding_policy: codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: 'gb', businessDate: '2026-09-04', accountingSystem: 'none' }))
  };
  for (const id of ['corrected', 'stale', 'later-date']) {
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state,payload)
      values ($1,$2,$3,'2026-09-04','Fixture expense',100,'AED','needs_review','proposed',$4::jsonb)`,
    [id, firmId, clientId, JSON.stringify({ ai_suggestion: suggestion })]);
    await pool.query(`insert into transaction_review_queue (id,firm_id,client_id,item_type,item_id,reason,priority,status,payload)
      values ($1,$2,$3,'transaction',$4,'fixture','normal','open',$5::jsonb)`,
    [`review-${id}`, firmId, clientId, id, JSON.stringify({ transaction_id: id })]);
  }
  await updateClientProfileInDb({ firmId, clientId, profilePatch: { jurisdiction: 'ae' }, actorId });
  // Model an already committed source-date correction; the AI receipt remains
  // the historical date and country that actually informed the old judgment.
  await pool.query("update transactions set transaction_date='2026-09-05' where firm_id=$1", [firmId]);
  for (const account of [
    { code: '1000', name: 'Bank', type: 'bank', normal_balance: 'debit' },
    { code: '6100', name: 'Professional fees', type: 'expense', normal_balance: 'debit' }
  ]) await upsertLedgerAccountForJournal({ client: pool, firmId, clientId, account, currency: 'AED' });
  const read = async (id) => (await pool.query('select * from transactions where id=$1', [id])).rows[0];
  const apply = (id, patch) => updateTransactionReviewItemInDb({ firmId, reviewItemId: `review-${id}`,
    patch: { status: 'resolved', review_state: 'accepted', ...patch }, actorId, returnSnapshot: false, distillFactsFn: async () => [] });
  const post = (id) => postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun: false, skipSnapshot: true, actorId });

  const before = await read('stale');
  await assert.rejects(apply('stale', {}), (error) => error.code === 'jurisdiction_context_conflict');
  assert.deepEqual(await read('stale'), before, 'stale adoption has no transaction mutation');
  await assert.rejects(post('stale'), (error) => error.code === 'jurisdiction_context_conflict');
  assert.equal(Number((await pool.query('select count(*)::int as n from ledger_journals')).rows[0].n), 0);

  for (const id of ['corrected', 'later-date']) {
    await apply(id, { proposed_account: 'Professional fees', account_name: 'Professional fees', account_code: '6100',
      tax_treatment: 'Out of scope of UAE VAT', reviewer_note: 'Owner supplied the current business purpose.' });
    const accepted = await read(id);
    assert.equal(accepted.payload.accepted_coding_policy.jurisdiction, 'ae');
    assert.equal(accepted.payload.accepted_coding_policy.businessDate, '2026-09-05');
    assert.deepEqual(accepted.payload.ai_suggestion, suggestion, 'human correction preserves historical AI receipt');
  }
  await pool.query("update transactions set transaction_date='2026-09-06' where id='later-date'");
  const afterDateChange = await read('later-date');
  await assert.rejects(post('later-date'), (error) => error.code === 'jurisdiction_context_conflict');
  assert.deepEqual(await read('later-date'), afterDateChange, 'an accepted receipt still binds the source date');

  // A stale derived review payload cannot replace the coding just accepted on
  // the source transaction; its case information is context, never authority.
  await pool.query(`update transaction_review_queue set payload=payload || $1::jsonb where id='review-corrected'`,
    [JSON.stringify({ proposed_account: 'Stale queue account', account_name: 'Stale queue account', account_code: '9999' })]);
  const result = await post('corrected');
  assert.equal(result.ledger_posting.posting_policy.coding_policy.jurisdiction, 'ae');
  const posted = await read('corrected');
  assert.equal(posted.coding_state, 'posted');
  assert.deepEqual(posted.payload.ai_suggestion, suggestion);
  const journals = (await pool.query('select * from ledger_journals order by id')).rows;
  assert.equal(journals.length, 1);
  assert.equal(journals[0].payload.posting_policy.coding_policy.jurisdiction, 'ae');
  const lines = (await pool.query('select account_code,debit,credit from ledger_lines order by account_code')).rows;
  assert.deepEqual(lines.map((line) => [line.account_code, Number(line.debit), Number(line.credit)]), [['1000', 0, 100], ['6100', 100, 0]]);
  const audits = (await pool.query("select actor_id from audit_events where action in ('review.overridden','ledger.post_transaction')")).rows;
  assert.equal(audits.length, 3);
  assert.ok(audits.every((row) => row.actor_id === actorId), 'named correction and posting retain the human actor');
});
