import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Readable } from 'node:stream';
import donnaRouter from '../../api/donna-router.js';
import { prepareFinnishHostedPilotInDb } from './hostedPilot.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { getClientBillingContext } from './clientSubscriptionDb.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, __sendClientAskBatchWithClient } from './firmDb.js';
import { setClientFlagStage } from './clientConfig.js';
import { INTERNAL_PILOT_ACCESS_FLAG, HOSTED_PILOT_VERSION, PILOT_SEND_RELEASE_ACTION,
  readInternalPilotSendContainmentWithClient, readInternalPilotSendRestrictionWithClient } from './internalPilotAccess.js';
import { releaseInternalPilotSendContainment } from './internalPilotSendRelease.js';
import { inviteSeatInDb } from './seatsDb.js';

// Real PostgreSQL, the real router, preparation, release and ask-batch send
// writers. Only the external identity provider is simulated.
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: pilot send containment refuses, a member release is receipted, released batches use the real send writer',
  { skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required' }, async t => {
    const name = `donna_pilot_send_release_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect(); await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    const firmId = 'pilot-send-proof', actorId = 'pilot-send-operator';
    const saved = Object.fromEntries(['DONNA_DEFAULT_FIRM_ID', 'DONNA_DESKTOP_BLOB_DIR', 'DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL',
      'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS'].map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    t.after(async () => {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await seed.end();
      await admin.query(`drop database "${name}"`); await admin.end();
    });
    process.env.DONNA_DEFAULT_FIRM_ID = firmId; delete process.env.DONNA_DESKTOP_BLOB_DIR;
    await seed.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
    const root = new URL('../../db/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) {
      await seed.query(await readFile(new URL(file, root), 'utf8'));
      await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
    }
    await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Pilot send proof',$1,'FI','EUR')", [firmId]);
    await seed.query("insert into firm_members(id,firm_id,email,name,role,status) values($1,$2,'operator@send.invalid','Operator','admin','active')", [actorId, firmId]);
    const owner = { userId: 'send-owner', email: 'owner@send.invalid' };
    const operator = { userId: 'send-operator-user', email: 'operator@send.invalid' };
    const seatUsers = {};
    Object.assign(process.env, { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-tester-token',
      SUPABASE_URL: 'https://pilot-auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', DONNA_AUTH_ALLOWED_EMAILS: '' });
    globalThis.fetch = async (address, init) => {
      assert.equal(address, 'https://pilot-auth.invalid/auth/v1/user', 'no provider or channel network call in this proof');
      const who = { 'Bearer owner': owner, 'Bearer operator': operator, ...seatUsers }[init.headers.Authorization] || null;
      return new Response(JSON.stringify(who ? { id: who.userId, email: who.email } : {}), { status: who ? 200 : 401 });
    };
    const request = async (token, path, body) => {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      req.method = body ? 'POST' : 'GET';
      const route = new URL(path, 'http://localhost');
      req.url = `/api/donna-router?path=${encodeURIComponent(`firms${route.pathname}`)}${route.search ? `&${route.search.slice(1)}` : ''}`;
      req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      return new Promise((resolve, reject) => {
        const res = { statusCode: 200, setHeader() {}, end(value) { resolve({ status: this.statusCode, body: JSON.parse(String(value)) }); } };
        Promise.resolve(donnaRouter(req, res)).catch(reject);
      });
    };
    const withClient = async fn => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } };
    const { clientId } = await selfProvisionClientWorkspace({ auth: owner, companyName: 'Synthetic Send Oy', jurisdiction: 'FI', entityType: 'fi-oy' });
    await prepareFinnishHostedPilotInDb({ firmId, clientId, actorId, profilePatch: { companyName: 'Synthetic Send Oy', jurisdiction: 'FI',
      entityType: 'fi-oy', accountingCurrency: 'EUR', accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' } });
    const draftBatch = async (batchId, transactionId) => {
      await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
        values($1,$2,$3,'2026-02-15','Synthetic card payment',42.10,0,'EUR','needs_review','{}')`, [transactionId, firmId, clientId]);
      await seed.query(`insert into client_ask_batches(id,firm_id,client_id,status,subject,message_markdown,payload)
        values($1,$2,$3,'draft','Questions about February','Synthetic question message',$4::jsonb)`, [batchId, firmId, clientId,
        JSON.stringify({ draft: { items: [{ transaction_id: transactionId, disposition: 'ask',
          question: 'What was this card payment for?', evidence_type: 'business_purpose' }] } })]);
    };
    const sendPath = batchId => `/ask-batches/${batchId}/send`;
    const containment = () => withClient(c => readInternalPilotSendContainmentWithClient(c, { firmId, clientId }));

    // 1. Born contained: the manual route and the writer the auto-send
    //    producer uses both refuse, and nothing is minted.
    await draftBatch('batch-held', 'tx-held');
    assert.equal((await containment()).contained, true);
    const refused = await request('operator', sendPath('batch-held'), { firm_id: firmId, client_id: clientId });
    assert.equal(refused.status, 409, JSON.stringify(refused));
    await assert.rejects(withClient(c => __sendClientAskBatchWithClient({ client: c, firmId, clientId, batchId: 'batch-held', actorId })),
      { code: 'INTERNAL_PILOT_SEND_DISABLED' });
    assert.equal((await seed.query("select status from client_ask_batches where id='batch-held'")).rows[0].status, 'draft');
    assert.equal((await seed.query('select count(*)::int n from client_evidence_requests')).rows[0].n, 0);

    // 2. Only an active firm member can review or release.
    const reviewPath = `/clients/${clientId}/cloud-pilot/send-review?firm_id=${firmId}`;
    const releasePath = `/clients/${clientId}/cloud-pilot/send-release`;
    for (const token of ['owner', 'unknown']) {
      assert.ok([401, 403].includes((await request(token, reviewPath)).status), token);
      assert.ok([401, 403].includes((await request(token, releasePath, { firm_id: firmId, review_digest: 'a'.repeat(64), confirmed: true })).status), token);
    }
    const ownerPrincipal = { principalType: 'firm_collaborator', principalId: 'any' };
    await assert.rejects(releaseInternalPilotSendContainment({ firmId, clientId, principal: ownerPrincipal },
      { reviewDigest: 'a'.repeat(64), confirmed: true }), { code: 'PILOT_OPERATOR_REQUIRED' });
    await seed.query("update firm_members set status='inactive' where id=$1", [actorId]);
    assert.equal((await request('operator', reviewPath)).status, 403, 'an inactive member cannot release');
    await seed.query("update firm_members set status='active' where id=$1", [actorId]);

    // 3. Review names the held work and what release does NOT turn on.
    const review = await request('operator', reviewPath);
    assert.equal(review.status, 200, JSON.stringify(review));
    assert.equal(review.body.contained, true);
    assert.equal(review.body.actor_id, actorId);
    assert.deepEqual(review.body.draft_batches.map(b => [b.id, b.item_count]), [['batch-held', 1]]);
    assert.deepEqual(review.body.after_release, { send_path: 'existing_ask_batch_send_writer', firm_auto_send_client_asks: false,
      owner_email_asks: false, delivery_channels_changed: false });
    assert.equal((await request('operator', releasePath, { firm_id: firmId, review_digest: review.body.review_digest, confirmed: false })).status, 400);
    await seed.query("update client_ask_batches set subject='Questions about February (redrafted)' where id='batch-held'");
    const stale = await request('operator', releasePath, { firm_id: firmId, review_digest: review.body.review_digest, confirmed: true });
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'PILOT_SEND_RELEASE_REVIEW_STALE');
    assert.equal((await seed.query('select count(*)::int n from audit_events where action=$1', [PILOT_SEND_RELEASE_ACTION])).rows[0].n, 0);

    // 4. Release: one attributed receipt, nothing sent or approved.
    const current = await request('operator', reviewPath);
    const released = await request('operator', releasePath, { firm_id: firmId, review_digest: current.body.review_digest, confirmed: true });
    assert.equal(released.status, 200, JSON.stringify(released));
    assert.equal(released.body.contained, false); assert.equal(released.body.sends_performed, false);
    const receipts = (await seed.query('select actor_type, actor_id, metadata from audit_events where action=$1', [PILOT_SEND_RELEASE_ACTION])).rows;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].actor_type, 'firm_member'); assert.equal(receipts[0].actor_id, actorId);
    assert.deepEqual(receipts[0].metadata.retained_draft_batch_ids, ['batch-held']);
    assert.equal(receipts[0].metadata.review_digest, current.body.review_digest);
    assert.deepEqual((await seed.query("select id from client_ask_batches where status <> 'draft'")).rows, [], 'release sends nothing');
    assert.equal((await seed.query('select count(*)::int n from client_evidence_requests')).rows[0].n, 0);
    const again = await request('operator', releasePath, { firm_id: firmId, review_digest: (await request('operator', reviewPath)).body.review_digest, confirmed: true });
    assert.equal(again.body.code, 'PILOT_SEND_NOT_CONTAINED');
    assert.equal((await request('operator', reviewPath)).body.release.actor_id, actorId);
    // Cloud evidence intake keys on enrollment history, not on sending.
    assert.equal(await withClient(c => readInternalPilotSendRestrictionWithClient(c, { firmId, clientId })), true);

    // 5. The released batch goes through the real send writer and its gates.
    const sent = await request('operator', sendPath('batch-held'), { firm_id: firmId, client_id: clientId });
    assert.equal(sent.status, 200, JSON.stringify(sent));
    assert.equal(sent.body.batch.status, 'sent');
    const ask = (await seed.query("select id, status, audience, send_count from client_evidence_requests where transaction_id='tx-held'")).rows;
    assert.equal(ask.length, 1); assert.equal(ask[0].audience, 'client');
    assert.equal(ask[0].send_count, 0, 'no delivery channel is enabled by release');
    const sendReceipt = (await seed.query("select metadata from audit_events where action='ask_batch.send' and resource_id='batch-held'")).rows;
    assert.equal(sendReceipt.length, 1); assert.equal(sendReceipt[0].metadata.evidence_request_count, 1);

    // 6. Revoking review access afterwards (ordinary and emergency) does not
    //    re-contain and never touches the owner's open question.
    await withClient(c => setClientFlagStage(c, { firmId, clientId, flagKey: INTERNAL_PILOT_ACCESS_FLAG, stage: 'off', source: 'manual',
      reason: HOSTED_PILOT_VERSION, actorType: 'firm_member', actorId }));
    await withClient(c => setClientFlagStage(c, { firmId, clientId, flagKey: INTERNAL_PILOT_ACCESS_FLAG, stage: 'off',
      source: 'emergency_override', reason: 'synthetic revocation', actorType: 'firm_member', actorId }));
    assert.equal((await containment()).contained, false);
    assert.notEqual((await getClientBillingContext({ firmId, clientId }))?.entitlementBasis, 'internal_pilot', 'access itself is revoked');
    await draftBatch('batch-late', 'tx-late');
    assert.equal((await request('operator', sendPath('batch-late'), { firm_id: firmId, client_id: clientId })).status, 200);
    assert.deepEqual((await seed.query("select id, status from client_evidence_requests where transaction_id='tx-held'")).rows,
      [{ id: ask[0].id, status: ask[0].status }], 'the already-sent question stays with the owner');

    // 7. An explicit re-grant of pilot access is new containment.
    await withClient(c => setClientFlagStage(c, { firmId, clientId, flagKey: INTERNAL_PILOT_ACCESS_FLAG, stage: 'canary', source: 'manual',
      reason: HOSTED_PILOT_VERSION, actorType: 'firm_member', actorId }));
    assert.equal((await containment()).contained, true);
    await draftBatch('batch-regrant', 'tx-regrant');
    await assert.rejects(withClient(c => __sendClientAskBatchWithClient({ client: c, firmId, clientId, batchId: 'batch-regrant', actorId })),
      { code: 'INTERNAL_PILOT_SEND_DISABLED' });

    // 8. Staff seats (Kari, 2026-09-23: the operator team acts through seats).
    //    Release is policy_change → partner and up, through the one capability
    //    resolver; a shortfall routes (receipted) and a seat outside the entity
    //    is refused. Real invite writer; seats activate on first sign-in.
    const memberPrincipal = { principalType: 'firm_member', principalId: actorId, unrestricted: true };
    const seat = async (name, seatRole, clientIds, extra = {}) => {
      const email = `${name}@send.invalid`;
      seatUsers[`Bearer ${name}`] = { userId: `${name}-user`, email };
      await inviteSeatInDb({ firmId, actorPrincipal: memberPrincipal, invite: { name, email, seatRole, clientIds, ...extra } });
    };
    await seat('senior-seat', 'senior', [clientId]);
    await seat('partner-elsewhere', 'partner', []);
    await seat('partner-seat', 'partner', [clientId]);
    const routed = await request('senior-seat', reviewPath);
    assert.equal(routed.status, 403, JSON.stringify(routed));
    assert.equal(routed.body.code, 'SEAT_AUTHORITY_ROUTED');
    assert.equal((await seed.query("select count(*)::int n from audit_events where action='seat.approval_routed' and resource_id='release_pilot_send_containment' and metadata->>'route_to_role'='partner'")).rows[0].n, 1,
      'the shortfall is receipted, never a bare deny');
    assert.equal((await request('senior-seat', releasePath, { firm_id: firmId, review_digest: 'a'.repeat(64), confirmed: true })).status, 403);
    assert.equal((await request('partner-elsewhere', reviewPath)).status, 403, 'a seat outside this entity cannot see or release it');
    // White label (Kari, 2026-09-23): opening an entity's question channel is
    // the firm's internal call. An external partner seat (e.g. an operator on
    // the firm's engagement) is routed to an internal seat, receipted, unless
    // the firm's existing EXTERNAL_SEAT_CHASE_RELEASE toggle acts.
    await seat('external-partner', 'partner', [clientId], { affiliation: 'external',
      endsAt: new Date(Date.now() + 30 * 86400000).toISOString() });
    const fenced = await request('external-partner', reviewPath);
    assert.equal(fenced.status, 403, JSON.stringify(fenced)); assert.equal(fenced.body.code, 'SEAT_AUTHORITY_ROUTED');
    assert.equal((await seed.query(`select count(*)::int n from audit_events where action='seat.approval_routed'
      and resource_id='release_pilot_send_containment' and metadata->>'reason'='external_chase_release_disabled'`)).rows[0].n, 1);
    await withClient(c => setClientFlagStage(c, { firmId, flagKey: 'EXTERNAL_SEAT_CHASE_RELEASE', stage: 'auto', source: 'manual',
      reason: 'synthetic firm toggle', actorType: 'firm_member', actorId }));
    assert.equal((await request('external-partner', reviewPath)).status, 200, 'the firm can let external seats release');
    await withClient(c => setClientFlagStage(c, { firmId, flagKey: 'EXTERNAL_SEAT_CHASE_RELEASE', stage: 'off', source: 'manual',
      reason: 'synthetic firm toggle off', actorType: 'firm_member', actorId }));
    assert.equal((await request('external-partner', reviewPath)).status, 403);
    const seatReview = await request('partner-seat', reviewPath);
    assert.equal(seatReview.status, 200, JSON.stringify(seatReview));
    assert.equal(seatReview.body.contained, true); assert.equal(seatReview.body.actor_type, 'seat');
    assert.deepEqual(seatReview.body.draft_batches.map(b => b.id), ['batch-regrant']);
    const seatRelease = await request('partner-seat', releasePath, { firm_id: firmId, review_digest: seatReview.body.review_digest, confirmed: true });
    assert.equal(seatRelease.status, 200, JSON.stringify(seatRelease));
    const seatReceipt = (await seed.query('select actor_type, actor_id, metadata from audit_events where action=$1 order by id desc limit 1', [PILOT_SEND_RELEASE_ACTION])).rows[0];
    assert.equal(seatReceipt.actor_type, 'seat'); assert.equal(seatReceipt.actor_id, seatReview.body.actor_id);
    assert.equal(seatReceipt.metadata.seat_role, 'partner');
    assert.equal(seatReceipt.metadata.authority_basis, 'partner_seat_confirmed_pilot_send_release');
    assert.equal((await containment()).release.actor_id, seatReview.body.actor_id);
    assert.equal((await request('operator', sendPath('batch-regrant'), { firm_id: firmId, client_id: clientId })).status, 200,
      'a seat release reaches the same real send writer');
    // The portal owner is a plain collaborator: never a releaser, whatever its role resolves to.
    assert.equal((await request('owner', reviewPath)).status, 403);
  });
