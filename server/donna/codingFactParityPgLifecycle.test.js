// FIK-0b single-vs-batch memory parity on a real database (plan §1.5 / §8.4).
// Flag off, a batch round reads ONE capped, merchant-first fact set for the
// whole pool and keys merchants on source_line as well, so a line can lose its
// client and firm facts to other lines' merchant facts, receive those facts,
// and differ from what the single-line coder reads for it. Under
// CODING_FACT_ADMISSION each line reads its own set through the single-line
// recipe. Only provider HTTP is replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { canonicalFactSubject } from './firmFacts.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { batchSuggestTransactionCodingInDb, suggestTransactionCodingInDb } from './db/coding.js';
import { enrollJevExperiment } from './jevExperimentPolicy.js';

const WORDS = ['alder', 'birch', 'cedar', 'elm', 'fir', 'hazel', 'juniper', 'larch', 'maple', 'oak', 'pine', 'rowan',
  'spruce', 'willow', 'aspen', 'beech', 'cherry', 'linden', 'poplar', 'yew', 'amber', 'coral', 'ivory', 'olive',
  'pearl', 'ruby', 'sage', 'teal', 'umber', 'violet'];

test('real PG: a line receives the same admitted facts on the single-line and batch paths under CODING_FACT_ADMISSION', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL not set — fact parity lifecycle not exercised'
}, async (t) => {
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `fact_parity_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const savedFetch = globalThis.fetch;
  const keys = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, TYPESAFE_MODEL: process.env.TYPESAFE_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  t.after(async () => {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(keys)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  Object.assign(process.env, { TYPESAFE_API_KEY: 'fixture', TYPESAFE_MODEL: 'fixture-provider', OPENAI_API_KEY: 'fixture' });
  await pool.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((file) => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
  await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','fact-parity');
    insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');
    insert into clients(id,firm_id,company_name,jurisdiction,profile) values
      ('c','f','Jev company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash"}'),
      ('s','f','Strong company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash"}'),
      ('r','f','Payout company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash"}');`);
  const stage = (clientId, flag, value = 'auto') => pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
    values($1,'f',$2,$3,$4,'manual')`, [`${flag}-${clientId}`, clientId, flag, value]);
  for (const clientId of ['c', 'r']) for (const flag of ['JURISDICTION_ACCOUNT_PALETTE', 'JEV_RECONCILIATION', 'FINLAND_ALV_CODING']) await stage(clientId, flag);
  for (const flag of ['JURISDICTION_ACCOUNT_PALETTE', 'FINLAND_ALV_CODING']) await stage('s', flag);
  const enrollment = await pool.connect();
  try {
    for (const clientId of ['c', 'r']) await enrollJevExperiment({ client: enrollment, firmId: 'f', clientId, actorId: 'member',
      authorityBasis: 'Synthetic parity proof', trialId: `parity-${clientId}`, expiresAt: '2100-01-01', model: 'fixture-provider' });
  } finally { enrollment.release(); }

  // Memory: per book, one client fact, one firm fact (shared), one old
  // entity-keyed merchant fact for the probe line, and a fresh merchant fact
  // for each of 30 other lines. A separate one-line book for source_line.
  const fact = (id, scope, value, text, provenance, age = '0 minutes') => pool.query(`insert into firm_facts
    (id,firm_id,scope,subject,fact,provenance,confidence,status,updated_at)
    values($1,'f',$2,$3,$4,$5,'high','active',now() - $6::interval)`,
  [id, scope, canonicalFactSubject({ scope, value }), text, JSON.stringify(provenance), age]);
  await fact('firm-fact', 'firm', 'f', 'This firm closes months on the fifth.', { client_id: 'c' }, '3 days');
  const line = (clientId, id, description, payload = {}) => pool.query(`insert into transactions
    (id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
    values($1,'f',$2,'2025-02-28',$3,0,12,'EUR','needs_review',$4)`, [id, clientId, description, JSON.stringify(payload)]);
  for (const clientId of ['c', 's']) {
    const company = clientId === 'c' ? 'Jev company' : 'Strong company';
    await fact(`client-${clientId}`, 'client', company, `${company} is a two-person design studio.`, { client_id: clientId }, '2 days');
    await fact(`probe-${clientId}`, 'merchant', 'Bank service charge', 'The bank service charge is the monthly account fee.',
      { client_id: clientId, entity_client_id: clientId }, '1 day');
    await line(clientId, `${clientId}-probe`, 'Bank service charge');
    for (const word of WORDS) {
      await fact(`${word}-${clientId}`, 'merchant', `Vendor ${word}`, `Vendor ${word} sells office supplies.`, { client_id: clientId, entity_client_id: clientId });
      await line(clientId, `${clientId}-${word}`, `Vendor ${word}`);
    }
  }
  // The statement parser's raw line for a Stripe payout mentions Bolt; the
  // writers key facts on the counterparty's name, so this line is Stripe's.
  await fact('stripe-r', 'merchant', 'Stripe', 'Stripe payouts are sales receipts net of fees.', { client_id: 'r', entity_client_id: 'r' });
  await fact('bolt-r', 'merchant', 'Bolt', 'Bolt rides are staff travel.', { client_id: 'r', entity_client_id: 'r' });
  await line('r', 'r-stripe', 'Payment Stripe', { source_line: '14.02.2026 Payment Stripe Payments Europe Bolt.eu reference 120,00' });

  const bodies = [];
  globalThis.fetch = async (endpoint, init) => {
    bodies.push({ endpoint: String(endpoint), body: init.body });
    if (/api\.typesafe\.ai/.test(String(endpoint))) {
      const request = JSON.parse(init.body);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        const entries = Object.entries(question.criteria);
        const choice = key === 'materiality' ? 'low' : key === 'decision' && question.criteria.resolved ? 'resolved' : entries[0][0];
        return [key, { type: 'choice', choice, confidence: 0.95,
          probabilities: Object.fromEntries(entries.map(([k]) => [k, k === choice ? 0.95 : 0.05 / Math.max(entries.length - 1, 1)])) }];
      }));
      return new Response(JSON.stringify({ model: 'fixture-provider', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    assert.equal(String(endpoint), 'https://api.openai.com/v1/responses', 'no unplanned external request');
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = (input.transactions || [input.transaction]).map((transaction) => ({
      transaction_id: transaction.id, proposed_account: 'Office supplies', contact: 'Fixture supplier', tax_treatment: 'ALV 25,5 %',
      support_note: '', ask_client_question: 'What was this for?', evidence_required: true, remember_candidate: false,
      merchant_pattern: '', missing_account_name: '', missing_account_type: '', missing_account_reason: '',
      auto_explain_limit: 0, confidence: 'high', materiality: 'normal', reasoning: 'Fixture reasoning.', warnings: [], alternatives: []
    }));
    return { ok: true, json: async () => ({ id: `parity-${bodies.length}`, output_text: JSON.stringify(input.transactions ? { suggestions, group_summary: [] } : suggestions[0]) }) };
  };

  const sha = (body) => createHash('sha256').update(body).digest('hex');
  const rows = async (clientId) => new Map((await pool.query('select * from transactions where client_id=$1', [clientId])).rows.map((row) => [row.id, row]));
  const pristine = { c: await rows('c'), s: await rows('s'), r: await rows('r') };
  const reset = async (clientId) => {
    await pool.query('delete from transaction_review_queue where client_id=$1', [clientId]);
    await pool.query("delete from client_evidence_requests where client_id=$1", [clientId]);
    for (const row of pristine[clientId].values()) {
      await pool.query('update transactions set payload=$2,coding_state=$3,status=$4 where id=$1', [row.id, row.payload, row.coding_state, row.status]);
    }
  };
  const deliveredIds = (row) => (row.payload.ai_suggestion?.jev_decision?.delivered_facts || []).map((entry) => entry.id).sort();
  const ownMerchantFact = (id) => (id === 'c-probe' ? 'probe-c' : `${id.slice(2)}-c`);
  const jevLines = [...pristine.c.keys()];

  // 1. Flag off (today): one pool read, capped at 24, merchant-first. The
  // probe line loses its client, firm and own merchant facts to other lines'
  // fresher merchant facts and receives those facts. The single-line read
  // differs. Separately, source_line keys the Stripe line to Bolt.
  await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['c'], limit: 40, autoApply: false });
  let coded = await rows('c');
  const offProbe = deliveredIds(coded.get('c-probe'));
  assert.equal(offProbe.length, 24);
  assert.ok(!offProbe.includes('client-c') && !offProbe.includes('firm-fact') && !offProbe.includes('probe-c'), 'crowd-out reproduces flag off');
  assert.ok(offProbe.some((id) => WORDS.some((word) => id === `${word}-c`)), 'other lines\' merchant facts reach the probe flag off');
  const offSha = sha(bodies.find((entry) => sha(entry.body) === coded.get('c-probe').payload.ai_suggestion.jev_decision.request_sha256s[0]).body);
  t.diagnostic(`flag-off Jev probe request sha256 ${offSha}`);
  await reset('c');
  await suggestTransactionCodingInDb({ firmId: 'f', transactionId: 'c-probe' });
  assert.deepEqual(deliveredIds((await rows('c')).get('c-probe')), ['client-c', 'firm-fact', 'probe-c'],
    'flag off, the single-line read differs from the batch read for the same line');
  await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['r'], limit: 40, autoApply: false });
  assert.deepEqual(deliveredIds((await rows('r')).get('r-stripe')), ['bolt-r', 'firm-fact'],
    'flag off, source_line keys the Stripe line to Bolt');

  // 2. Flag on: every line of the crowded pool receives exactly its own
  // merchant fact plus the client and firm facts, and nothing else.
  await reset('c');
  await stage('c', 'CODING_FACT_ADMISSION');
  await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['c'], limit: 40, autoApply: false });
  coded = await rows('c');
  const batchDelivered = new Map();
  for (const id of jevLines) {
    const delivered = deliveredIds(coded.get(id));
    batchDelivered.set(id, delivered);
    assert.deepEqual(delivered, [ownMerchantFact(id), 'client-c', 'firm-fact'].sort(), `${id}: own merchant, client and firm facts only`);
  }
  const probeBody = JSON.parse(bodies.find((entry) => sha(entry.body) === coded.get('c-probe').payload.ai_suggestion.jev_decision.request_sha256s[0]).body);
  const batchProbeFacts = probeBody.state.known_facts;
  assert.deepEqual(batchProbeFacts.map((entry) => entry.fact).sort(), [
    'Jev company is a two-person design studio.', 'The bank service charge is the monthly account fee.', 'This firm closes months on the fifth.'],
  'the probe request carries its own memory; no other line\'s merchant fact reaches it');

  // The source_line line: the batch now keys it on its counterparty, as the
  // single-line coder and the writers do.
  await reset('r');
  await stage('r', 'CODING_FACT_ADMISSION');
  await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['r'], limit: 40, autoApply: false });
  assert.deepEqual(deliveredIds((await rows('r')).get('r-stripe')), ['firm-fact', 'stripe-r']);
  await reset('r');
  await suggestTransactionCodingInDb({ firmId: 'f', transactionId: 'r-stripe' });
  assert.deepEqual(deliveredIds((await rows('r')).get('r-stripe')), ['firm-fact', 'stripe-r'], 'single-line reads the same Stripe fact');

  // 3. The single-line path for the same lines: the same admitted facts and
  // the same known_facts bytes in the Jev request.
  for (const id of ['c-probe', 'c-alder', 'c-violet']) {
    await reset('c');
    await suggestTransactionCodingInDb({ firmId: 'f', transactionId: id });
    const single = (await rows('c')).get(id);
    assert.deepEqual(deliveredIds(single), batchDelivered.get(id), `${id}: single-line and batch deliver the same facts`);
    if (id === 'c-probe') {
      const singleBody = JSON.parse(bodies.find((entry) => sha(entry.body) === single.payload.ai_suggestion.jev_decision.request_sha256s[0]).body);
      assert.deepEqual(singleBody.state.known_facts, batchProbeFacts, 'identical known_facts in the request');
    }
  }

  // 4. The strong coder (Jev off). Flag off the single-line coder reads no
  // memory at all and the batch request shares one pool block. Flag on each
  // transaction carries its own known_facts, the shared block is gone, and
  // the single-line request carries the same facts.
  const strongBatch = async () => {
    const before = bodies.length;
    await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['s'], limit: 40, autoApply: false });
    const sent = bodies.slice(before).filter((entry) => /openai/.test(entry.endpoint));
    assert.equal(sent.length, 2, 'the 31-line round is two chunks of at most 25');
    return sent.map((entry) => ({ bytes: Buffer.byteLength(entry.body), input: JSON.parse(JSON.parse(entry.body).input) }));
  };
  const strongSingle = async (id) => {
    await reset('s');
    const before = bodies.length;
    await suggestTransactionCodingInDb({ firmId: 'f', transactionId: id });
    return JSON.parse(JSON.parse(bodies.slice(before).find((entry) => /openai/.test(entry.endpoint)).body).input).known_facts;
  };
  const off = await strongBatch();
  for (const request of off) {
    assert.equal(request.input.known_facts.length, 24);
    assert.ok(request.input.transactions.every((transaction) => !('known_facts' in transaction)));
  }
  assert.ok(!off[0].input.known_facts.some((entry) => entry.scope === 'client'), 'flag off, the pool\'s merchant facts crowd out the client fact');
  assert.deepEqual(await strongSingle('s-probe'), [], 'flag off, the single-line strong coder reads no memory');
  await reset('s');
  await stage('s', 'CODING_FACT_ADMISSION');
  const on = await strongBatch();
  const perLine = new Map(on.flatMap((request) => request.input.transactions.map((transaction) => [transaction.id, transaction.known_facts])));
  assert.equal(perLine.size, 31);
  for (const request of on) assert.ok(!('known_facts' in request.input), 'no shared block under the admission');
  for (const [id, facts] of perLine) {
    const own = id === 's-probe' ? 'probe-s' : `${id.slice(2)}-s`;
    assert.deepEqual(facts.map((entry) => entry.id).sort(), [own, 'client-s', 'firm-fact'].sort(), `${id}: its own facts only`);
  }
  const singleProbe = await strongSingle('s-probe');
  assert.deepEqual(singleProbe, perLine.get('s-probe').map(({ id, ...entry }) => entry),
    'the single-line strong coder receives the same facts as the batch line');
  const offBytes = off.reduce((sum, request) => sum + request.bytes, 0);
  const onBytes = on.reduce((sum, request) => sum + request.bytes, 0);
  t.diagnostic(`strong batch request bytes (31 lines, 2 chunks): flag off ${offBytes}, flag on ${onBytes}, delta ${onBytes - offBytes}`);

  // 5. A failed per-line read still holds the whole round (no request, no verdict).
  await reset('s');
  await pool.query(`alter table firm_facts rename to firm_facts_held;
    create function parity_forced_fact_read_failure() returns boolean language plpgsql as $$begin raise exception 'forced' using errcode='XX001'; end$$;
    create view firm_facts as select * from firm_facts_held where parity_forced_fact_read_failure();`);
  const sentBefore = bodies.length;
  await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['s'], limit: 40, autoApply: false });
  assert.equal(bodies.length, sentBefore, 'no provider request against missing memory');
  const held = (await rows('s')).get('s-probe');
  assert.equal(held.payload.ai_suggestion, undefined);
  assert.equal(held.payload.coding_provider_failure.code, 'CODING_CONTEXT_READ_FAILED');
  await pool.query('drop view firm_facts; drop function parity_forced_fact_read_failure(); alter table firm_facts_held rename to firm_facts;');
  assert.equal((await pool.query("select count(*)::int n from firm_facts where status='active'")).rows[0].n, 67, 'the reads never rewrite memory');
});
