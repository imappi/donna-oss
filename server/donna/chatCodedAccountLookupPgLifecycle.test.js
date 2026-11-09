// A chat correction on a book born with a coded chart (FI-21) names the
// account by its pack-palette name ("Rent"); the born row keeps that name only
// as payload.palette_name and stores the statutory name ("Vuokrakulut", 7000).
// Proven on real PostgreSQL: the transaction-chat apply, mark-personal and
// re-code routes (real HTTP) and the feed-chat batch apply all resolve the
// coded row's code through the one shared lookup (findLedgerAccountByNameOrAlias),
// an uncoded palette book keeps today's behaviour, and the name-vs-alias
// precedence is pinned. Before the shared lookup, re-code left the prior
// account's code on the row and mark-personal stored no code; the apply
// receipts reported no resolved code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { handleDonnaApiRequest } from './api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { ensureTransactionReviewItemInDb, resolveClientCodingPolicyWithClient, updateTransactionReviewItemInDb } from './db/coding.js';
import { findLedgerAccountByNameOrAlias, seedPackPaletteChartWithClient } from './db/ledger.js';
import { applyFeedChatAction } from './feedChatApply.js';
import { codingPolicyReceipt } from './codingPolicy.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';

test('real HTTP and PG: chat re-coding on a coded Finnish book stores the coded account code; an uncoded palette book is unchanged', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL required'
}, async t => {
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `donna_chat_coded_${Date.now().toString(36)}_${process.pid}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const env = {
    DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-the-owner-token',
    SUPABASE_URL: 'https://coded-auth.invalid', SUPABASE_ANON_KEY: 'test-key',
    DONNA_AUTH_ALLOWED_EMAILS: 'owner@coded.example', OPENAI_API_KEY: 'test-only-no-network', ANTHROPIC_API_KEY: 'test-only-no-network'
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
  for (const file of (await readdir(root)).filter((entry) => entry.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, root), 'utf8'));
  }
  installConvergenceSettleOnPool(pool);

  const firmId = 'coded-chat-proof';
  await pool.query("insert into firms(id,name,slug) values($1,'Coded chat proof','coded-chat-proof')", [firmId]);
  await pool.query(`insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level)
    values('owner',$1,'owner-user','owner@coded.example','Owner','owner','active','staff')`, [firmId]);
  // 'oy' is born with the coded statutory chart; 'palette' gets the code-less
  // pack palette (the existing-book path), the uncoded neighbour.
  for (const [clientId, companyName] of [['oy', 'Koodattu Testi Oy'], ['palette', 'Paletti Testi Oy'], ['ambiguous', 'Moniselitteinen Testi Oy']]) {
    await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
      values($1,$2,$3,'fi','fi-oy',$4)`, [clientId, firmId, companyName, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'accrual' }]);
    for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE']) {
      await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
        values($1,$2,$3,$4,'auto','manual')`, [`${clientId}-${flag}`, firmId, clientId, flag]);
    }
    const seedClient = await pool.connect();
    try {
      const seeded = await seedPackPaletteChartWithClient(seedClient, { firmId, clientId, newBook: clientId !== 'palette' });
      assert.equal(seeded.seeded, true, JSON.stringify(seeded));
    } finally { seedClient.release(); }
  }
  const account = async (clientId, code) => (await pool.query(
    "select code, name, payload->>'palette_name' as palette_name from ledger_accounts where client_id=$1 and code=$2", [clientId, code])).rows[0];
  assert.deepEqual(await account('oy', '7000'), { code: '7000', name: 'Vuokrakulut', palette_name: 'Rent' });
  assert.equal((await pool.query("select count(*)::int n from ledger_accounts where client_id='palette' and coalesce(code,'')<>''")).rows[0].n, 0,
    'the neighbour book is the code-less palette chart');

  const server = createServer((req, res) => Promise.resolve(handleDonnaApiRequest(req, res)).catch(error => {
    res.statusCode = error.statusCode || 500; res.end(JSON.stringify({ error: error.message, code: error.code }));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path: '/api/donna/firms' + route,
      method: 'POST', headers: { authorization: 'Bearer owner-jwt', 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  // The model is stubbed at the wire: each transaction gets the action the
  // proof wants, naming the account by its palette name only (no code).
  const proposals = new Map();
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    if (endpoint === 'https://coded-auth.invalid/auth/v1/user') return { ok: true, json: async () => ({ id: 'owner-user', email: 'owner@coded.example' }) };
    assert.equal(endpoint, 'https://api.anthropic.com/v1/messages', 'all providers stubbed at wire; no network');
    const body = JSON.parse(init.body);
    const content = body.messages[0].content;
    const context = JSON.parse(content.slice(content.indexOf('\n') + 1));
    const proposal = proposals.get(context.transaction.id);
    assert.ok(proposal, `no proposal staged for ${context.transaction.id}`);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: body.tools[0].name, input: {
      text: 'Synthetic correction.', actions: [{ tax_treatment: 'Ei ALV-käsittelyä', reason: 'Synthetic correction.', note: 'Synthetic correction.', ...proposal }]
    } }], stop_reason: 'tool_use' }) };
  });
  const tx = (clientId, id) => pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
    values($1,$2,$3,'2025-01-31','Synthetic premises payment',600,0,'EUR','needs_review','{}')`, [id, firmId, clientId]);
  const row = async id => (await pool.query('select account_code, category, payload from transactions where id=$1', [id])).rows[0];
  const chatAndApply = async (clientId, id, proposal) => {
    proposals.set(id, proposal);
    const chat = await request('/transaction-chat/messages', { firm_id: firmId, client_id: clientId, transaction_id: id, message: 'Correct this coding.' });
    assert.equal(chat.status, 201, JSON.stringify(chat));
    const message = chat.body.assistant_message;
    assert.equal(message.payload.actions[0].type, proposal.type, JSON.stringify(message.payload.actions));
    const applied = await request(`/transaction-chat/messages/${message.id}/actions/0/apply`, { firm_id: firmId, client_id: clientId, transaction_id: id });
    assert.equal(applied.status, 201, JSON.stringify(applied));
    return applied;
  };

  // 1. transaction chat apply_category on the coded book: "Rent" → 7000.
  await tx('oy', 'oy-apply');
  const applied = await chatAndApply('oy', 'oy-apply', { type: 'apply_category', account_name: 'Rent' });
  assert.equal(applied.body.assistant_message.payload.actions[0].result.account_code, '7000', 'the lookup itself resolved the alias');
  let coded = await row('oy-apply');
  assert.equal(coded.account_code, '7000');
  assert.equal(coded.payload.xero_account_code, '7000');

  // 2. transaction chat recode_decided of a decided row: its prior account is
  //    replaced by the coded row, never by the palette name in the code slot.
  await tx('oy', 'oy-recode');
  const review = await ensureTransactionReviewItemInDb({ firmId, clientId: 'oy', transactionId: 'oy-recode', source: 'fixture-prior-coding' });
  await updateTransactionReviewItemInDb({ firmId, reviewItemId: review, actorId: 'owner@coded.example', returnSnapshot: false,
    patch: { status: 'accepted', review_state: 'accepted', category: 'Utilities', account_name: 'Utilities', account_code: '7050', xero_account_code: '7050', xero_tax_type: 'Ei ALV-käsittelyä' } });
  assert.equal((await row('oy-recode')).account_code, '7050');
  await chatAndApply('oy', 'oy-recode', { type: 'recode_decided', account_name: 'Rent', targets_decided: true });
  coded = await row('oy-recode');
  assert.equal(coded.account_code, '7000', 'the miss branch no longer welds "Rent" into the code');
  assert.equal(coded.payload.xero_account_code, '7000');

  // 3. transaction chat mark_personal names the shareholder account by palette name.
  await tx('oy', 'oy-personal');
  await chatAndApply('oy', 'oy-personal', { type: 'mark_personal', account_name: 'Shareholder receivable' });
  coded = await row('oy-personal');
  assert.equal(coded.account_code, '1760');

  // 4. feed chat batch apply_category (the route's own applier, real deps).
  await tx('oy', 'oy-feed-1'); await tx('oy', 'oy-feed-2');
  // The receipt the feed-chat proposal binds (feedChat.withCodingPolicyReceipts).
  const policyClient = await pool.connect();
  let policy;
  try {
    policy = codingPolicyReceipt(await resolveClientCodingPolicyWithClient({ client: policyClient, firmId, clientId: 'oy', businessDate: '2025-01-31' }));
  } finally { policyClient.release(); }
  const feed = await applyFeedChatAction({ firmId, clientId: 'oy', actorId: 'owner@coded.example', action: {
    type: 'apply_category', account_name: 'Rent', tax_treatment: 'Ei ALV-käsittelyä', transaction_ids: ['oy-feed-1', 'oy-feed-2'],
    coding_policy_by_transaction: { 'oy-feed-1': policy, 'oy-feed-2': policy }
  } });
  assert.equal(feed.applied, true, JSON.stringify(feed));
  assert.equal(feed.result.account_code, '7000', 'the batch lookup itself resolved the alias');
  for (const id of ['oy-feed-1', 'oy-feed-2']) {
    assert.equal((await row(id)).account_code, '7000', id);
    assert.equal((await row(id)).payload.xero_account_code, '7000', id);
  }

  // Neighbour: the uncoded palette book has no coded row answering "Rent",
  // so apply_category keeps today's name-only transaction coding.
  await tx('palette', 'palette-apply');
  const neighbour = await chatAndApply('palette', 'palette-apply', { type: 'apply_category', account_name: 'Rent' });
  assert.equal(neighbour.body.assistant_message.payload.actions[0].result.account_code, null);
  const uncoded = await row('palette-apply');
  assert.equal(uncoded.account_code, 'Rent');
  assert.equal(uncoded.payload.xero_account_code ?? null, null);
  assert.equal(uncoded.category, 'Rent');

  // Precedence on the shared lookup: a coded row's own NAME beats another
  // coded row's palette alias; a code-less duplicate named like the alias
  // cannot shadow the coded row; a miss returns null, never a code.
  const query = (...args) => pool.query(...args);
  const lookup = (accountName) => findLedgerAccountByNameOrAlias({ query, firmId, clientId: 'ambiguous', name: accountName });
  await pool.query(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,status,payload)
    values('acct-legacy-rent',$1,'ambiguous',null,'Rent','expense','debit','active','{}')`, [firmId]);
  assert.equal((await lookup('rent'))?.code, '7000', 'code-less duplicate does not shadow the coded alias');
  await pool.query(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,status,payload)
    values('acct-named-rent',$1,'ambiguous','7010','Rent','expense','debit','active','{}')`, [firmId]);
  assert.equal((await lookup('Rent'))?.code, '7010', 'a row named "Rent" beats another row aliased "Rent"');
  assert.equal((await lookup('Vuokrakulut'))?.code, '7000', 'the statutory name still resolves');
  assert.equal(await lookup('No such account'), null);
});
