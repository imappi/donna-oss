// The settlement-entry lane records the coding policy its prompt was built
// under and re-checks it before a persisted card posts (FIK-2 follow-up, plan
// §8.5 finding 2). A card decided under the other guidance variant is
// superseded and re-proposed, never posted from. Real PostgreSQL; only the
// provider HTTP is replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, upsertLedgerAccountForJournal } from './firmDb.js';
import { runDocumentSettlementEntriesForClient } from './documentSettlementEntry.js';
import { FI_JEV_DECISION_GUIDANCE_FLAG } from './codingGuidanceVariant.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: a settlement card carries its coding-policy receipt; a variant switch supersedes it, a current card posts', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — settlement policy-receipt lifecycle not exercised'
}, async (t) => {
  const name = `donna_settle_policy_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const firmId = 'settle-policy-firm'; const clientId = 'settle-policy-client';
  await pool.query("insert into firms (id,name,slug) values ($1,'Settlement policy fixture','settle-policy')", [firmId]);
  await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
    values ($1,$2,'Fixture Oy','FI','{"jurisdiction":"fi","accounting_system":"none"}')`, [clientId, firmId]);
  await pool.query(`insert into documents (id,firm_id,client_id,filename,document_type,document_date,total_amount,currency,payment_status,payload)
    values ('settle-doc',$1,$2,'receipt.pdf','receipt','2026-09-05',10,'EUR','unpaid',$3::jsonb)`,
  [firmId, clientId, JSON.stringify({ no_line_disposition: { disposition: 'auto_explain', materiality: 'immaterial',
    settlement_channel: 'personal_card', confidence: 0.95, verdict_source: 'owner_reply', owner_notified: true } })]);
  await upsertLedgerAccountForJournal({ client: pool, firmId, clientId,
    account: { code: 'SET-EXP', name: 'Office supplies', type: 'expense' }, currency: 'EUR' });
  const stage = (flagKey, value) => pool.query(`insert into client_capability_config (id,firm_id,client_id,flag_key,stage)
    values ($1,$2,$3,$4,$5) on conflict (id) do update set stage = excluded.stage`,
  [`${clientId}-${flagKey}`, firmId, clientId, flagKey, value]);

  const requests = [];
  const fetchImpl = async (endpoint, options) => {
    assert.equal(endpoint, 'https://api.anthropic.com/v1/messages', 'no unplanned external request');
    requests.push(options.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({
      account: 'Office supplies', confidence: 0.95, reasoning: 'Owner-paid supplies.' }) }] }) };
  };
  const run = async () => {
    const connection = await pool.connect();
    try {
      return await runDocumentSettlementEntriesForClient({ client: connection, firmId, clientId,
        documentIds: ['settle-doc'], apiKeyOverride: 'offline-settlement-policy', fetchImpl, accountOptionsFn: async () => ['Office supplies'] });
    } finally { connection.release(); }
  };
  const cards = async () => (await pool.query('select * from proposal_cards where client_id=$1 order by created_at, id', [clientId])).rows;
  const journals = async () => (await pool.query('select * from ledger_journals where client_id=$1', [clientId])).rows;

  // 1. Shadow, guidance flag off: the card records today's receipt, no guidance key.
  await stage('DOCUMENT_SETTLEMENT_LEDGER_ENTRY', 'shadow');
  const first = await run();
  assert.equal(first.cards_minted, 1, JSON.stringify(first));
  const [cardV7] = await cards();
  assert.equal(cardV7.detail.coding_policy.policyId, 'fi_alv_coding');
  assert.equal(cardV7.detail.coding_policy.businessDate, '2026-09-05');
  assert.ok(!('guidanceDigest' in cardV7.detail.coding_policy), 'flag off: no guidance key');
  assert.equal(requests.length, 1);

  // 2. Guidance flag on: the v7 card is superseded and re-proposed under v8.
  // With the empty reviewed set the provider request is byte-identical.
  await stage(FI_JEV_DECISION_GUIDANCE_FLAG, 'canary');
  const second = await run();
  assert.equal(second.cards_minted, 1, JSON.stringify(second));
  assert.equal(requests.length, 2);
  assert.equal(requests[1], requests[0], 'same prompt bytes under an empty reviewed set');
  const afterSwitch = await cards();
  assert.equal(afterSwitch.length, 2);
  const priorV7 = afterSwitch.find((card) => card.id === cardV7.id);
  const cardV8 = afterSwitch.find((card) => card.id !== cardV7.id);
  assert.equal(priorV7.status, 'superseded');
  assert.deepEqual(priorV7.detail, cardV7.detail, 'the superseded card keeps its historical receipt');
  assert.equal(cardV8.supersedes_proposal_id, cardV7.id);
  assert.equal(cardV8.detail.coding_policy.guidanceVariant, 'reviewed');
  assert.match(cardV8.detail.coding_policy.guidanceDigest, /^[0-9a-f]{64}$/);

  // 3. A current card is not re-proposed.
  const steady = await run();
  assert.equal(steady.cards_minted, 0);
  assert.equal(requests.length, 2);

  // 4. Guidance flag off again: the v8 card is superseded back to v7.
  await stage(FI_JEV_DECISION_GUIDANCE_FLAG, 'off');
  await run();
  assert.equal(requests.length, 3);
  const afterRevert = await cards();
  assert.equal(afterRevert.find((card) => card.id === cardV8.id).status, 'superseded');
  const cardBack = afterRevert.find((card) => card.status === 'proposed');
  assert.equal(cardBack.supersedes_proposal_id, cardV8.id);
  assert.ok(!('guidanceDigest' in cardBack.detail.coding_policy));
  assert.equal((await journals()).length, 0, 'shadow never posts');

  // 5. A card minted before receipts existed was decided under the authored
  // guidance: it stands while no reviewed variant is selected, and is
  // re-proposed once one is.
  await pool.query("update proposal_cards set detail = detail - 'coding_policy' where id=$1", [cardBack.id]);
  await run();
  assert.equal(requests.length, 3, 'a legacy card stands under v7');
  await stage(FI_JEV_DECISION_GUIDANCE_FLAG, 'canary');
  await run();
  assert.equal(requests.length, 4, 'a legacy card is re-proposed under v8');
  assert.equal((await cards()).find((card) => card.id === cardBack.id).status, 'superseded');
  await stage(FI_JEV_DECISION_GUIDANCE_FLAG, 'off');
  await run();
  assert.equal(requests.length, 5);

  // 6. Act: the current card posts from its persisted detail, without a new model call.
  await stage('DOCUMENT_SETTLEMENT_LEDGER_ENTRY', 'canary');
  const act = await run();
  assert.equal(requests.length, 5, 'no re-ask for a current card');
  assert.equal(act.posted, 1, JSON.stringify(act));
  assert.equal((await journals()).length, 1);
});
