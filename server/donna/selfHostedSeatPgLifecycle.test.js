// The self-hosted, unqualified seat on real PostgreSQL (2026-11-10,
// modelLanes.js SELF_HOSTED_DECISION). A scratch database with every
// migration (207 included), one firm, an active and an inactive member, and
// two companies: one seated on a local model through the seat command, one
// not. A local stub server speaks the OpenAI-compatible protocol; no real
// local server or model runs, so quality on any real local model is
// unmeasured here.
//
// Pinned: the seat command writes through the one policy writer with its
// audit receipt; the database refuses a firm-wide self-hosted row; the seated
// company resolves its coding, ask drafting, disposition and matching seats
// to the compatible endpoint and is decided there with the served model id
// and the unqualified basis on the receipt; the company that is not seated is
// untouched; the endpoint variables alone change no deciding model; the
// banner, Host A's model_routes detail and the lane report name the seat;
// --clear closes it with its own receipt.

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-self-hosted-pg';
const MEMBER = 'member-self-hosted-pg';
const INACTIVE = 'member-self-hosted-inactive-pg';
const SEATED = 'client-self-hosted-seated-pg';
const UNSEATED = 'client-self-hosted-unseated-pg';
const SEAT_MODEL = 'local-test-model-q4';

test('real PG: seat a local model for one company, decide over the stub, clear it', { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set' }, async () => {
  const dbName = `donna_selfhosted_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const url = new URL(PG_URL);
  url.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();

  const stubRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      stubRequests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: SEAT_MODEL }] })); return; }
      const content = JSON.stringify({ proposals: [], unmatchable_reason: 'no_candidate_fits' });
      res.end(JSON.stringify({ id: 'chatcmpl-pg', model: SEAT_MODEL, choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stubHost = `127.0.0.1:${server.address().port}`;
  const prior = { base: process.env.OPENAI_COMPATIBLE_BASE_URL, key: process.env.OPENAI_COMPATIBLE_API_KEY };
  const withClient = async (fn) => fn(db);

  try {
    await db.query(`create schema if not exists storage;
      create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table if not exists storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
    const migrations = (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
    for (const file of migrations) await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
    await db.query(`insert into firms (id, name, slug) values ($1, 'Self-Hosted Test Firm', 'self-hosted-test-firm')`, [FIRM]);
    await db.query(`insert into firm_members (id, firm_id, email, name, role, status) values
      ($1, $3, 'owner@self-hosted.test', 'Test Owner', 'admin', 'active'),
      ($2, $3, 'former@self-hosted.test', 'Former Member', 'admin', 'inactive')`, [MEMBER, INACTIVE, FIRM]);
    await db.query(`insert into clients (id, firm_id, company_name) values ($1, $3, 'Esimerkki Oy'), ($2, $3, 'Toinen Esimerkki Oy')`, [SEATED, UNSEATED, FIRM]);

    const { run } = await import('../../scripts/seat_local_model.js');
    const policy = await import('./modelLanePolicy.js');
    const { SELF_HOSTED_BASIS } = await import('./modelLanes.js');
    const { resolveCodingTransport } = await import('./db/coding.js');
    const { resolveSeatTransport } = await import('./providerEndpoints.js');
    const { proposeMatchesViaAnthropic } = await import('./reconciliationLlmCore.js');
    const { selfHostedSeatLine } = await import('./desktop/capabilityReceipt.js');
    const { modelRouteCheck } = await import('./hostCertificateA.js');
    const { computeModelLaneReport } = await import('./modelLaneReport.js');

    // 0. The endpoint variables alone change no deciding model.
    process.env.OPENAI_COMPATIBLE_BASE_URL = `http://${stubHost}/v1`;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    assert.equal(await resolveCodingTransport(db, { firmId: FIRM, clientId: SEATED }), null, 'env alone: coding keeps its default');
    for (const laneId of ['transaction_coding', 'ask_drafting', 'bank_line_disposition', 'reconciliation_reasoning']) {
      assert.equal(await policy.readLaneDecidingPolicy({ client: db, firmId: FIRM, clientId: SEATED, laneId }), null);
    }

    // 1. The database itself refuses a firm-wide self-hosted row.
    await assert.rejects(
      db.query(`insert into model_lane_policy (id, firm_id, client_id, lane, deciding_model, basis) values ('raw-1', $1, null, 'transaction_coding', $2, $3)`, [FIRM, SEAT_MODEL, SELF_HOSTED_BASIS]),
      /model_lane_policy_self_hosted_client_scoped/
    );

    // 2. The writer refuses an inactive member and leaves no row, no receipt.
    await assert.rejects(
      policy.setLaneDecidingPolicy({ client: db, firmId: FIRM, clientId: SEATED, laneId: 'transaction_coding', decidingModel: SEAT_MODEL,
        basis: SELF_HOSTED_BASIS, reason: 'own server', actorType: 'firm_member', actorId: INACTIVE }),
      (error) => error.code === 'SELF_HOSTED_AUTHORITY_REQUIRED'
    );
    assert.equal((await db.query(`select count(*)::int as n from model_lane_policy`)).rows[0].n, 0);

    // 3. The seat command: dry-run writes nothing; --apply seats every lane that can take one.
    const opts = { firmId: FIRM, clientId: SEATED, memberId: MEMBER, model: SEAT_MODEL, all: true, lanes: [], reason: 'own llama server on this laptop', clear: false };
    const dry = await run({ ...opts, apply: false }, { env: process.env, withClient });
    assert.equal(dry.applied, false);
    assert.equal((await db.query(`select count(*)::int as n from model_lane_policy`)).rows[0].n, 0);
    const refused = await run({ ...opts, model: 'not-served-model', apply: true }, { env: process.env, withClient });
    assert.deepEqual(refused.refused, ['model_not_served'], 'the endpoint does not serve that id: refused before any write');
    const applied = await run({ ...opts, apply: true }, { env: process.env, withClient });
    assert.equal(applied.applied, true);
    const rows = (await db.query(`select lane, client_id, deciding_model, basis, set_by_actor_type, set_by_actor_id from model_lane_policy where valid_to is null order by lane`)).rows;
    assert.deepEqual(rows.map((r) => r.lane), ['ask_drafting', 'bank_line_disposition', 'reconciliation_reasoning', 'transaction_coding']);
    for (const row of rows) {
      assert.equal(row.client_id, SEATED);
      assert.equal(row.basis, SELF_HOSTED_BASIS);
      assert.equal(row.set_by_actor_id, MEMBER);
    }
    const receipts = (await db.query(`select metadata from audit_events where action = $1`, [policy.MODEL_LANE_POLICY_SET_ACTION])).rows;
    assert.equal(receipts.length, 4);
    for (const { metadata } of receipts) {
      assert.equal(metadata.basis, SELF_HOSTED_BASIS);
      assert.equal(metadata.globally_qualified, false);
      assert.equal(metadata.eligibility, 'self_hosted_operator_choice');
    }
    // The plan the command printed: what still leaves the machine for this company.
    assert.deepEqual(applied.plan.self_hosted.sort(), ['ask_drafting', 'bank_line_disposition', 'reconciliation_reasoning', 'transaction_coding']);

    // 4. The seated company resolves to the compatible endpoint; the other does not.
    const coding = await resolveCodingTransport(db, { firmId: FIRM, clientId: SEATED });
    assert.equal(coding.provider, 'openai_compatible');
    assert.equal(coding.model, SEAT_MODEL);
    assert.equal(coding.policy_basis, SELF_HOSTED_BASIS);
    assert.equal(await resolveCodingTransport(db, { firmId: FIRM, clientId: UNSEATED }), null, 'the unseated company is untouched');
    const askSeat = resolveSeatTransport({ policy: await policy.readLaneDecidingPolicy({ client: db, firmId: FIRM, clientId: SEATED, laneId: 'ask_drafting' }), onlyBasis: SELF_HOSTED_BASIS });
    assert.equal(askSeat.model, SEAT_MODEL);
    assert.equal(resolveSeatTransport({ policy: await policy.readLaneDecidingPolicy({ client: db, firmId: FIRM, clientId: UNSEATED, laneId: 'ask_drafting' }), onlyBasis: SELF_HOSTED_BASIS }), null);

    // 5. A matching decision for the seated company rides the stub; the receipt is the response's model.
    const matchSeat = await policy.readLaneDecidingPolicy({ client: db, firmId: FIRM, clientId: SEATED, laneId: 'reconciliation_reasoning' });
    const matchTransport = { ...resolveSeatTransport({ policy: matchSeat }), execution: { root: { type: 'reconciliation_reasoning', id: 'doc-pg-1' } } };
    const before = stubRequests.filter((r) => r.url.endsWith('/chat/completions')).length;
    const decided = await proposeMatchesViaAnthropic({ systemPrompt: 'Match.', userPrompt: 'Document.', candidateBankLines: [], transport: matchTransport });
    assert.equal(decided.model, SEAT_MODEL);
    assert.equal(decided.model_source, 'response_proven');
    assert.equal(stubRequests.filter((r) => r.url.endsWith('/chat/completions')).length, before + 1);

    // 6. The banner, Host A and the lane report name the seat.
    const seats = await policy.listSelfHostedSeats({ client: db });
    assert.equal(seats.length, 4);
    const line = selfHostedSeatLine(seats, process.env);
    assert.match(line, /UNQUALIFIED self-hosted model "local-test-model-q4" decides ask_drafting, bank_line_disposition, reconciliation_reasoning, transaction_coding for 1 company/);
    assert.match(line, new RegExp(stubHost.replace(/\./g, '\\.')));
    const routes = modelRouteCheck(process.env, undefined, { unqualifiedSeats: seats });
    assert.equal(routes.status, 'PASS', 'the predicate is unchanged');
    assert.equal(routes.detail.unqualified_seats.length, 4);
    assert.ok(routes.detail.unqualified_seats.every((seat) => seat.qualified === false && seat.client_id === SEATED));
    const report = await computeModelLaneReport({ client: db, firmId: FIRM });
    const codingLane = report.lanes.find((lane) => lane.id === 'transaction_coding');
    assert.equal(codingLane.policies.find((p) => p.client_id === SEATED).unqualified, true);
    assert.ok(!codingLane.qualified.includes(SEAT_MODEL), 'a seat never enters the qualified set');

    // 7. --clear closes every self-hosted seat of the company, each with its receipt.
    const cleared = await run({ ...opts, model: null, all: false, clear: true, apply: true }, { env: process.env, withClient });
    assert.equal(cleared.applied, true);
    assert.equal((await db.query(`select count(*)::int as n from model_lane_policy where valid_to is null`)).rows[0].n, 0);
    assert.equal((await db.query(`select count(*)::int as n from audit_events where action = $1`, [policy.MODEL_LANE_POLICY_CLEARED_ACTION])).rows[0].n, 4);
    assert.equal(await resolveCodingTransport(db, { firmId: FIRM, clientId: SEATED }), null, 'cleared: back to the default');
  } finally {
    if (prior.base === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL; else process.env.OPENAI_COMPATIBLE_BASE_URL = prior.base;
    if (prior.key === undefined) delete process.env.OPENAI_COMPATIBLE_API_KEY; else process.env.OPENAI_COMPATIBLE_API_KEY = prior.key;
    server.close();
    await db.end();
    await admin.query(`drop database if exists "${dbName}"`);
    await admin.end();
  }
});
