import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Readable } from 'node:stream';
import donnaRouter from '../../api/donna-router.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { inviteSeatInDb } from './seatsDb.js';
import { computeConvergenceForTarget } from './reconcileConvergenceState.js';
import { HOSTED_PILOT_VERSION, readInternalPilotSendContainmentWithClient } from './internalPilotAccess.js';
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';

// Real PostgreSQL, the real router and every real writer. Only the identity
// provider (GoTrue /auth/v1/user) and the email provider (Resend) are
// simulated, at the fetch boundary. All people and companies are synthetic.
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: a firm invites its client owner into that client portal and into nothing else',
  { skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required' }, async t => {
    const name = `donna_owner_invite_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect(); await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    const saved = Object.fromEntries(['DONNA_DEFAULT_FIRM_ID', 'DONNA_DESKTOP_BLOB_DIR', 'DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL',
      'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'RESEND_API_KEY', 'PUBLIC_APP_URL'].map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    t.after(async () => {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await seed.end();
      await admin.query(`drop database "${name}"`); await admin.end();
    });

    // Firm A is NOT the deployment default: an invited owner must still reach
    // exactly A's client through the ordinary request firm resolution.
    const deploymentFirm = 'owner-invite-deployment', firmA = 'owner-invite-firm-a', firmB = 'owner-invite-firm-b';
    process.env.DONNA_DEFAULT_FIRM_ID = deploymentFirm; delete process.env.DONNA_DESKTOP_BLOB_DIR;
    await seed.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
    const root = new URL('../../db/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) {
      await seed.query(await readFile(new URL(file, root), 'utf8'));
      await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
    }
    for (const [id, firmName] of [[deploymentFirm, 'Deployment Firm'], [firmA, 'Tilitoimisto Esimerkki'], [firmB, 'Other Books Ltd']]) {
      await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,$2,$1,'FI','EUR')", [id, firmName]);
    }
    await seed.query("insert into firm_members(id,firm_id,email,name,role,status) values('member-a',$1,'op-a@firm-a.invalid','Operator A','admin','active')", [firmA]);
    await seed.query("insert into firm_members(id,firm_id,email,name,role,status) values('member-b',$1,'op-b@firm-b.invalid','Operator B','admin','active')", [firmB]);
    for (const [id, firmId, company] of [['client-a1', firmA, 'Esimerkki Oy'], ['client-a2', firmA, 'Toinen Oy'], ['client-b1', firmB, 'Other Client Ltd']]) {
      await seed.query("insert into clients(id,firm_id,company_name,profile) values($1,$2,$3,$4::jsonb)",
        [id, firmId, company, JSON.stringify({ companyName: company, jurisdiction: 'FI' })]);
    }
    // client-a1 is born send-contained (internal pilot), so its draft
    // questions count as deliverable only with an owner or seat assignment.
    await seed.query(`insert into client_capability_config (id, firm_id, client_id, flag_key, stage, source, reason, set_by_actor_type, set_by_actor_id)
      values ('cfg-a1', $1, 'client-a1', 'INTERNAL_PILOT_ACCESS', 'canary', 'manual', $2, 'firm_member', 'member-a')`, [firmA, HOSTED_PILOT_VERSION]);
    await seed.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_out, currency, reconciliation_status, payload)
      values ('tx-a1', $1, 'client-a1', '2026-08-20', 'Synthetic card payment', 42.10, 'EUR', 'pending', '{}'::jsonb)`, [firmA]);
    await seed.query(`insert into client_evidence_requests (id, firm_id, client_id, transaction_id, status, evidence_type, question, created_by, audience, send_count)
      values ('ask-a1', $1, 'client-a1', 'tx-a1', 'draft', 'business_purpose', 'What was this card payment for?', 'ask_batch', 'client', 0)`, [firmA]);

    const users = {
      opA: { id: 'user-op-a', email: 'op-a@firm-a.invalid', verified: true },
      opB: { id: 'user-op-b', email: 'op-b@firm-b.invalid', verified: true },
      owner: { id: 'user-owner', email: 'owner@esimerkki.invalid', verified: true },
      ownerUnverified: { id: 'user-owner-unverified', email: 'owner@esimerkki.invalid', verified: false },
      stranger: { id: 'user-stranger', email: 'someone@elsewhere.invalid', verified: true },
      partner: { id: 'user-partner', email: 'partner@firm-a.invalid', verified: true }
    };
    const sent = [];
    Object.assign(process.env, { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-tester-token',
      SUPABASE_URL: 'https://owner-auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
      DONNA_AUTH_ALLOWED_EMAILS: 'op-a@firm-a.invalid,op-b@firm-b.invalid',
      RESEND_API_KEY: 'synthetic-resend-key', PUBLIC_APP_URL: 'https://app.donna.invalid' });
    globalThis.fetch = async (address, init) => {
      if (address === 'https://api.resend.com/emails') {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: `email-${sent.length}` }), { status: 200 });
      }
      assert.equal(address, 'https://owner-auth.invalid/auth/v1/user', 'no other network call in this proof');
      const who = users[String(init.headers.Authorization || '').replace(/^Bearer /, '')];
      return new Response(JSON.stringify(who ? { id: who.id, email: who.email, email_confirmed_at: who.verified ? '2026-11-01T00:00:00Z' : null } : {}),
        { status: who ? 200 : 401 });
    };
    const request = async (token, path, body) => {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      req.method = body ? 'POST' : 'GET';
      const route = new URL(path, 'http://localhost');
      req.url = `/api/donna-router?path=${encodeURIComponent(`firms${route.pathname}`)}${route.search ? `&${route.search.slice(1)}` : ''}`;
      req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' };
      return new Promise((resolve, reject) => {
        const res = { statusCode: 200, setHeader() {}, end(value) { resolve({ status: this.statusCode, body: JSON.parse(String(value || '{}')) }); } };
        Promise.resolve(donnaRouter(req, res)).catch(reject);
      });
    };
    const withClient = async fn => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } };
    const verdict = async () => {
      const c = await withClient(db => computeConvergenceForTarget(db, { firmId: firmA, transactionId: 'tx-a1' }));
      return `${c.derived.state}/${c.derived.reason}`;
    };
    const audits = async (action) => (await seed.query('select * from audit_events where action = $1 order by id', [action])).rows;
    const lastLinkToken = () => {
      const match = String(sent.at(-1)?.html || '').match(/owner-invite\?token=([A-Za-z0-9_-]+)/);
      assert.ok(match, 'the email carries the sign-in link');
      return match[1];
    };
    const state = async (clientId, firmId = firmA, as = 'opA') => request(as, `/owner-access?firm_id=${firmId}&client_id=${clientId}`);
    const invite = (body, as = 'opA') => request(as, '/owner-access/invite', { firm_id: firmA, ...body });
    const accept = (as, token) => request(as, '/owner-invites/accept', { token });

    // A staff seat of firm A on the OTHER client (so client-a1 has no seat).
    await inviteSeatInDb({ firmId: firmA, actorPrincipal: { principalType: 'firm_member', principalId: 'member-a', unrestricted: true, email: users.opA.email },
      invite: { name: 'Synthetic Partner', email: users.partner.email, seatRole: 'partner', clientIds: ['client-a2'] } });

    // ── 0. Nothing yet: not invited, and the contained draft has nobody to receive it.
    const initial = await state('client-a1');
    assert.equal(initial.status, 200, JSON.stringify(initial));
    assert.equal(initial.body.state, 'not_invited');
    assert.equal(await verdict(), 'hanging/owner_ask_undeliverable');
    assert.equal((await withClient(c => readInternalPilotSendContainmentWithClient(c, { firmId: firmA, clientId: 'client-a1' }))).contained, true);

    // ── 1. Who may invite: firm A's owner only. A staff seat, a member of
    //       another firm (naming A, or naming A's client under its own firm)
    //       and an anonymous caller are refused, and nothing is written.
    const ownerBody = { client_id: 'client-a1', name: 'Synthetic Owner', email: 'Owner@Esimerkki.invalid', language: 'fi' };
    assert.equal((await invite(ownerBody, 'partner')).status, 403, 'a partner seat cannot invite an owner');
    assert.equal((await invite(ownerBody, 'opB')).status, 403, 'another firm cannot invite into this firm');
    assert.equal((await request('opB', '/owner-access/invite', { ...ownerBody, firm_id: firmB })).status, 404, 'never across firms');
    assert.equal((await state('client-a1', firmB, 'opB')).status, 404);
    assert.equal((await invite(ownerBody, null)).status, 401);
    assert.equal((await seed.query('select count(*)::int n from client_owner_invites')).rows[0].n, 0);

    // ── 2. Same-firm conflicts are the firm's own data and refuse clearly.
    const staffConflict = await invite({ ...ownerBody, email: users.partner.email });
    assert.equal(staffConflict.status, 409); assert.equal(staffConflict.body.code, 'CLIENT_OWNER_EMAIL_IS_FIRM_STAFF');
    assert.equal((await invite({ ...ownerBody, email: users.opA.email })).body.code, 'CLIENT_OWNER_EMAIL_IS_FIRM_STAFF');
    assert.equal((await invite({ ...ownerBody, language: 'sv' })).status, 400);

    // ── 3. The invite: one pending row, one Finnish email in the firm's name.
    const invited = await invite(ownerBody);
    assert.equal(invited.status, 200, JSON.stringify(invited));
    assert.equal(invited.body.state, 'invited');
    assert.equal(invited.body.invite.email, 'owner@esimerkki.invalid');
    assert.equal(invited.body.invite_email.status, 'sent');
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].to].flat(), ['owner@esimerkki.invalid']);
    assert.equal(sent[0].subject, 'Tilitoimisto Esimerkki kutsuu sinut Donnaan');
    assert.match(sent[0].html, /Hei Synthetic Owner/);
    assert.match(sent[0].html, /Esimerkki Oy/);
    const firstToken = lastLinkToken();
    const profile = (await seed.query("select profile from clients where id='client-a1'")).rows[0].profile;
    assert.equal(profile.locale, 'fi'); assert.equal(preferredOwnerTemplateLanguage(profile), 'fi');
    assert.equal((await invite(ownerBody)).body.code, 'CLIENT_OWNER_INVITE_PENDING', 'one pending invite per client');
    const [invitedReceipt] = await audits('client_owner.invited');
    assert.equal(invitedReceipt.actor_type, 'firm_member'); assert.equal(invitedReceipt.actor_id, 'member-a');
    assert.equal(invitedReceipt.client_id, 'client-a1');
    assert.equal((await audits('client_owner.invite_email'))[0].metadata.status, 'sent');

    // ── 4. Storage: a database read yields no usable token.
    const stored = (await seed.query('select * from client_owner_invites')).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].token_hash, createHash('sha256').update(firstToken).digest('hex'));
    const everything = JSON.stringify([stored, (await seed.query('select * from audit_events')).rows]);
    assert.ok(!everything.includes(firstToken), 'the raw token is stored nowhere');
    assert.ok(new Date(stored[0].expires_at).getTime() > Date.now());

    // ── 5. Acceptance refusals: wrong person, unverified email, bad link,
    //       no sign-in. The invite stays pending; refusals are receipted.
    const mismatch = await accept('stranger', firstToken);
    assert.equal(mismatch.status, 403); assert.equal(mismatch.body.code, 'CLIENT_OWNER_INVITE_EMAIL_MISMATCH');
    assert.ok(!JSON.stringify(mismatch.body).includes('owner@esimerkki.invalid'), 'the refusal never names the invited address');
    assert.equal((await accept('ownerUnverified', firstToken)).body.code, 'CLIENT_OWNER_INVITE_EMAIL_UNVERIFIED');
    const unknownLink = await accept('owner', 'A'.repeat(43));
    assert.equal(unknownLink.status, 410);
    assert.equal((await accept(null, firstToken)).status, 401);
    assert.equal((await seed.query('select status from client_owner_invites')).rows[0].status, 'pending');
    assert.deepEqual((await audits('client_owner.accept_refused')).map(r => r.metadata.reason),
      ['CLIENT_OWNER_INVITE_EMAIL_MISMATCH', 'CLIENT_OWNER_INVITE_EMAIL_UNVERIFIED']);
    assert.equal((await seed.query("select count(*)::int n from firm_collaborators where lower(email)='owner@esimerkki.invalid'")).rows[0].n, 0);

    // ── 6. The invited person accepts and lands on exactly that client.
    const accepted = await accept('owner', firstToken);
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.deepEqual(accepted.body, { firm_id: firmA, client_id: 'client-a1' });
    const usedAgain = await accept('owner', firstToken);
    assert.equal(usedAgain.status, 410, 'single use');
    assert.equal(usedAgain.body.error, unknownLink.body.error, 'a used link reads exactly like an unknown one');
    const collaborator = (await seed.query("select * from firm_collaborators where lower(email)='owner@esimerkki.invalid'")).rows;
    assert.equal(collaborator.length, 1);
    assert.equal(collaborator[0].firm_id, firmA); assert.equal(collaborator[0].role, 'owner');
    assert.equal(collaborator[0].seat_role, null); assert.equal(collaborator[0].user_id, 'user-owner');
    const [acceptedReceipt] = await audits('client_owner.accepted');
    assert.equal(acceptedReceipt.actor_type, 'client'); assert.equal(acceptedReceipt.actor_id, collaborator[0].id);

    // The existing delivery predicate now sees an owner: the contained
    // draft question is deliverable, with no change to the projection.
    assert.equal(await verdict(), 'on_owner/open_owner_ask');

    // ── 7. The access is exactly that one client, checked on real routes.
    const ownerSnapshot = await request('owner', '/snapshot');
    assert.equal(ownerSnapshot.status, 200, JSON.stringify(ownerSnapshot).slice(0, 300));
    assert.equal(ownerSnapshot.body.firm?.id, firmA);
    assert.deepEqual(ownerSnapshot.body.clients.map(c => c.id), ['client-a1']);
    assert.deepEqual(ownerSnapshot.body.workspaceAccess, { surface: 'owner', clientIds: ['client-a1'] });
    assert.equal((await request('owner', `/snapshot?firm_id=${firmB}`)).status, 403, 'no other firm');
    assert.equal((await request('owner', `/snapshot?firm_id=${deploymentFirm}`)).status, 403, 'not the deployment firm either');
    assert.equal((await state('client-a2', firmA, 'owner')).status, 403, 'no other client of the firm');
    assert.equal((await state('client-a1', firmA, 'owner')).status, 403, 'the owner does not administer owner access');
    assert.equal((await request('owner', '/owner-access/invite', { client_id: 'client-a1', name: 'Co Owner', email: 'co@esimerkki.invalid' })).status, 403);
    const roster = await request('owner', '/seats');
    assert.equal(roster.status, 403); assert.equal(roster.body.code, 'CLIENT_OWNER_PORTAL_ONLY');
    assert.equal((await request('owner', '/seats/invite', { name: 'X', email: 'x@esimerkki.invalid', seat_role: 'partner', client_ids: ['client-a1'] })).status, 403);
    assert.ok([401, 403].includes((await request('owner', '/clients', { company_name: 'Sneaky Oy' })).status), 'no client creation');
    assert.equal((await seed.query("select count(*)::int n from clients where firm_id=$1", [firmA])).rows[0].n, 2);
    const firmView = await state('client-a1');
    assert.equal(firmView.body.state, 'active');
    assert.deepEqual(firmView.body.owners.map(o => o.email), ['owner@esimerkki.invalid']);
    assert.equal((await invite(ownerBody)).body.code, 'CLIENT_OWNER_ALREADY_ACTIVE');

    // ── 8. Remove access: the assignment ends; nothing is deleted.
    const auditCountBefore = (await seed.query('select count(*)::int n from audit_events')).rows[0].n;
    await seed.query("update client_evidence_requests set status='open', send_count=1, response_payload=jsonb_build_object('answer', 'It was printer paper.') where id='ask-a1'");
    const removed = await request('opA', '/owner-access/remove', { firm_id: firmA, client_id: 'client-a1' });
    assert.equal(removed.status, 200, JSON.stringify(removed));
    assert.equal(removed.body.state, 'access_removed');
    const assignment = (await seed.query("select status, ends_at from client_assignments where client_id='client-a1' and principal_id=$1", [collaborator[0].id])).rows[0];
    assert.equal(assignment.status, 'ended'); assert.ok(assignment.ends_at);
    assert.equal((await seed.query('select count(*)::int n from audit_events')).rows[0].n, auditCountBefore + 1, 'one receipt, no history lost');
    assert.equal((await audits('client_owner.access_removed'))[0].actor_id, 'member-a');
    assert.equal((await seed.query("select response_payload from client_evidence_requests where id='ask-a1'")).rows[0].response_payload.answer, 'It was printer paper.');
    assert.equal((await seed.query('select count(*)::int n from firm_collaborators where id=$1', [collaborator[0].id])).rows[0].n, 1);
    const afterRemoval = await request('owner', '/snapshot');
    assert.deepEqual((afterRemoval.body.clients || []).map(c => c.id), [], 'the removed owner sees no client');
    assert.equal((await request('opA', '/owner-access/remove', { firm_id: firmA, client_id: 'client-a1' })).status, 409);
    await seed.query("update client_evidence_requests set status='draft', send_count=0, response_payload='{}'::jsonb where id='ask-a1'");
    assert.equal(await verdict(), 'hanging/owner_ask_undeliverable');

    // ── 9. Re-invite, resend rotates the link, the new link restores access.
    const reinvited = await invite({ client_id: 'client-a1', name: 'Synthetic Owner', email: 'owner@esimerkki.invalid' });
    assert.equal(reinvited.status, 200, JSON.stringify(reinvited));
    const staleToken = lastLinkToken();
    const resent = await request('opA', '/owner-access/resend', { firm_id: firmA, client_id: 'client-a1' });
    assert.equal(resent.status, 200, JSON.stringify(resent));
    assert.equal(resent.body.invite_email.status, 'sent');
    const freshToken = lastLinkToken();
    assert.notEqual(freshToken, staleToken);
    assert.equal(sent.at(-1).subject, 'Tilitoimisto Esimerkki kutsuu sinut Donnaan', 'the stored language still applies');
    assert.equal((await accept('owner', staleToken)).status, 410, 'a resend retires the earlier link');
    assert.equal((await accept('owner', freshToken)).status, 200);
    assert.equal((await state('client-a1')).body.state, 'active');
    assert.equal(await verdict(), 'on_owner/open_owner_ask');
    assert.equal((await audits('client_owner.invite_resent')).length, 1);

    // ── 10. Revoke: the pending link dies, the client is not invited.
    await invite({ client_id: 'client-a2', name: 'Synthetic Owner', email: 'owner@esimerkki.invalid', language: 'en' });
    assert.equal(sent.at(-1).subject, 'Tilitoimisto Esimerkki has invited you to Donna');
    const revokedToken = lastLinkToken();
    const revoked = await request('opA', '/owner-access/revoke', { firm_id: firmA, client_id: 'client-a2' });
    assert.equal(revoked.status, 200); assert.equal(revoked.body.state, 'not_invited');
    assert.equal((await accept('owner', revokedToken)).status, 410);
    assert.equal((await audits('client_owner.invite_revoked')).length, 1);

    // ── 11. Expiry, then the supported multi-client case: the same firm's
    //        owner of client-a1 accepts an invite to client-a2 as well.
    await invite({ client_id: 'client-a2', name: 'Synthetic Owner', email: 'owner@esimerkki.invalid' });
    const expiringToken = lastLinkToken();
    await seed.query("update client_owner_invites set expires_at = now() - interval '1 minute' where client_id='client-a2' and status='pending'");
    assert.equal((await accept('owner', expiringToken)).status, 410, 'an expired link is refused');
    assert.equal((await state('client-a2')).body.invite.expired, true);
    await request('opA', '/owner-access/resend', { firm_id: firmA, client_id: 'client-a2' });
    assert.equal((await accept('owner', lastLinkToken())).status, 200);
    const both = await request('owner', '/snapshot');
    assert.deepEqual(both.body.clients.map(c => c.id).sort(), ['client-a1', 'client-a2']);
    assert.equal((await seed.query("select count(*)::int n from firm_collaborators where lower(email)='owner@esimerkki.invalid'")).rows[0].n, 1,
      'one owner principal, two assignments');
    assert.equal((await state('client-b1', firmB, 'owner')).status, 403);

    // ── 12. Other firms: firm B's invite screen behaves the same for an
    //        email firm A knows as for an unknown one; acceptance refuses an
    //        identity that already holds a principal elsewhere.
    const forKnown = await request('opB', '/owner-access/invite', { firm_id: firmB, client_id: 'client-b1', name: 'Synthetic Owner', email: 'owner@esimerkki.invalid' });
    assert.equal(forKnown.status, 200, JSON.stringify(forKnown)); assert.equal(forKnown.body.state, 'invited');
    const crossFirm = await accept('owner', lastLinkToken());
    assert.equal(crossFirm.status, 403); assert.equal(crossFirm.body.code, 'CLIENT_OWNER_INVITE_ACCOUNT_IN_USE');
    await request('opB', '/owner-access/revoke', { firm_id: firmB, client_id: 'client-b1' });
    const forUnknown = await request('opB', '/owner-access/invite', { firm_id: firmB, client_id: 'client-b1', name: 'Synthetic Person', email: 'unknown@nowhere.invalid' });
    assert.equal(forUnknown.status, forKnown.status);
    assert.deepEqual(Object.keys(forUnknown.body).sort(), Object.keys(forKnown.body).sort());
    await request('opB', '/owner-access/revoke', { firm_id: firmB, client_id: 'client-b1' });
    await request('opB', '/owner-access/invite', { firm_id: firmB, client_id: 'client-b1', name: 'Synthetic Partner', email: users.partner.email });
    assert.equal((await accept('partner', lastLinkToken())).body.code, 'CLIENT_OWNER_INVITE_ACCOUNT_IN_USE', 'a staff seat elsewhere is refused');
    await request('opB', '/owner-access/revoke', { firm_id: firmB, client_id: 'client-b1' });
    await request('opB', '/owner-access/invite', { firm_id: firmB, client_id: 'client-b1', name: 'Operator A', email: users.opA.email });
    assert.equal((await accept('opA', lastLinkToken())).body.code, 'CLIENT_OWNER_INVITE_ACCOUNT_IN_USE', 'a member of another firm is refused');
    assert.equal((await seed.query('select count(*)::int n from firm_collaborators where firm_id=$1', [firmB])).rows[0].n, 0, 'nothing bound in firm B');
    // The refusals left firm A's owner exactly where they were.
    assert.deepEqual((await request('owner', '/snapshot')).body.clients.map(c => c.id).sort(), ['client-a1', 'client-a2']);
  });
