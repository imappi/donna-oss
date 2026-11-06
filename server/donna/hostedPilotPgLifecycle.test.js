import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Readable } from 'node:stream';
import donnaRouter from '../../api/donna-router.js';
import { prepareFinnishHostedPilotInDb } from './hostedPilot.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { getClientBillingContext } from './clientSubscriptionDb.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, assertFirmAccess,
  getFinancialReportFromDb, getLedgerAuditTrailFromDb, postLedgerAdjustmentInDb,
  __sendClientAskBatchWithClient } from './firmDb.js';
import { getFinlandAlvReturnFromDb } from './finland/statutoryDb.js';
import { auditHostedPilotParity } from '../../scripts/audit_hosted_pilot_parity.js';
import { setClientFlagStage } from './clientConfig.js';
import { INTERNAL_PILOT_ACCESS_FLAG, HOSTED_PILOT_VERSION } from './internalPilotAccess.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: isolated Finnish pilot setup, scoped owners, review access and persistent two-period journals',
  { skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required; this is not hosted/live-model evidence' }, async t => {
    const name = `donna_fi_pilot_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect(); await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    const previousFirm = process.env.DONNA_DEFAULT_FIRM_ID;
    const previousBlob = process.env.DONNA_DESKTOP_BLOB_DIR;
    process.env.DONNA_DEFAULT_FIRM_ID = 'fi-pilot-proof'; delete process.env.DONNA_DESKTOP_BLOB_DIR;
    t.after(async () => {
      if (previousFirm === undefined) delete process.env.DONNA_DEFAULT_FIRM_ID; else process.env.DONNA_DEFAULT_FIRM_ID = previousFirm;
      if (previousBlob === undefined) delete process.env.DONNA_DESKTOP_BLOB_DIR; else process.env.DONNA_DESKTOP_BLOB_DIR = previousBlob;
      __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await seed.end();
      await admin.query(`drop database "${name}"`); await admin.end();
    });
    await seed.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
    const root = new URL('../../db/migrations/', import.meta.url);
    const files = (await readdir(root)).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      await seed.query(await readFile(new URL(file, root), 'utf8'));
      await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
    }
    const parity = await auditHostedPilotParity({ client: seed });
    assert.equal(parity.identity.read_only, 'on');
    assert.equal(parity.schema.status, 'PASS', JSON.stringify(parity.schema));
    const firmId = 'fi-pilot-proof', actorId = 'fi-pilot-operator';
    await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Isolated pilot proof',$1,'FI','EUR')", [firmId]);
    await seed.query("insert into firm_members(id,firm_id,email,name,role,status) values($1,$2,'operator@pilot.invalid','Operator','admin','active')", [actorId, firmId]);
    const ownerA = { userId: 'pilot-owner-a', email: 'a@pilot.invalid' };
    const ownerB = { userId: 'pilot-owner-b', email: 'b@pilot.invalid' };
    const ownerC = { userId: 'pilot-owner-c', email: 'c@pilot.invalid' };
    const operator = { userId: 'pilot-operator-user', email: 'operator@pilot.invalid' };
    // Only the external identity provider is simulated here. Real API routing,
    // principal lookup, assignment gates and readers/writers use PostgreSQL.
    const savedEnv = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'DONNA_SELF_SERVE_PROVISIONING'].map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    Object.assign(process.env, { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-tester-token',
      SUPABASE_URL: 'https://pilot-auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', DONNA_AUTH_ALLOWED_EMAILS: '' });
    globalThis.fetch = async (address, init) => {
      assert.equal(address, 'https://pilot-auth.invalid/auth/v1/user', 'no unrelated/provider network call in this proof');
      const owner = init.headers.Authorization === 'Bearer owner-a' ? ownerA : init.headers.Authorization === 'Bearer owner-b' ? ownerB : init.headers.Authorization === 'Bearer operator' ? operator : init.headers.Authorization === 'Bearer owner-c' ? ownerC : null;
      return new Response(JSON.stringify(owner ? { id: owner.userId, email: owner.email } : {}), { status: owner ? 200 : 401 });
    };
    t.after(() => { globalThis.fetch = originalFetch; for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } });
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
    const a = await selfProvisionClientWorkspace({ auth: ownerA, companyName: 'Synthetic A Oy', jurisdiction: 'FI', entityType: 'fi-oy' });
    const b = await selfProvisionClientWorkspace({ auth: ownerB, companyName: 'Synthetic B Oy', jurisdiction: 'FI', entityType: 'fi-oy' });
    // A fresh browser has no local owner hint. The real authenticated snapshot
    // identifies the current surface without inventing firm membership.
    const ownerSnapshot = await request('owner-a', `/snapshot?firm_id=${firmId}`);
    assert.equal(ownerSnapshot.status, 200, JSON.stringify(ownerSnapshot));
    assert.deepEqual(ownerSnapshot.body.workspaceAccess, { surface: 'owner', clientIds: [a.clientId] });
    assert.deepEqual(ownerSnapshot.body.clients.map(row => row.id), [a.clientId]);
    assert.deepEqual(ownerSnapshot.body.members, []);
    const memberSnapshot = await request('operator', `/snapshot?firm_id=${firmId}`);
    assert.equal(memberSnapshot.status, 200);
    assert.deepEqual(memberSnapshot.body.workspaceAccess, { surface: 'firm', clientIds: null });
    assert.equal(memberSnapshot.body.clients.length, 2);
    assert.equal((await seed.query('select count(*)::int as n from firm_members where email=$1', [ownerA.email])).rows[0].n, 0);
    for (const role of ['', 'unrecognized', 'viewer', 'senior_bookkeeper']) {
      await seed.query('update firm_collaborators set role=$1 where user_id=$2', [role, ownerA.userId]);
      const classified = await request('owner-a', `/snapshot?firm_id=${firmId}`);
      assert.equal(classified.status, 200);
      assert.deepEqual(classified.body.workspaceAccess, {
        surface: ['viewer', 'senior_bookkeeper'].includes(role) ? 'firm' : null, clientIds: [a.clientId]
      });
    }
    await seed.query("update firm_collaborators set role='owner' where user_id=$1", [ownerA.userId]);
    const fiFacts = { businessId: '9999999-2', incorporation_date: '2026-01-01',
      alv_registration: { status: 'registered', registered_from: '2026-01-01', tax_period: 'month' }, verokausi: 'month' };
    const fiProfilePath = `/clients/${a.clientId}/profile`;
    assert.equal((await request('operator', fiProfilePath, { firm_id: firmId, profile_patch: fiFacts })).status, 200);
    const fiRead = await request('owner-a', `${fiProfilePath}?firm_id=${firmId}`);
    assert.equal(fiRead.status, 200); assert.equal(fiRead.body.editable, true); assert.deepEqual(fiRead.body.fields, fiFacts);
    assert.equal((await request('owner-b', `${fiProfilePath}?firm_id=${firmId}`)).status, 403);
    assert.equal((await request('owner-b', fiProfilePath, { firm_id: firmId, profile_patch: fiFacts })).status, 403);
    assert.equal((await request('operator', fiProfilePath, { firm_id: firmId, profile_patch: { incorporation_date: '2026-02-30' } })).status, 400);
    assert.equal((await seed.query('select count(*)::int n from ledger_journals')).rows[0].n, 0);
    const profilePatch = { companyName: 'Synthetic A Oy', jurisdiction: 'FI', entityType: 'fi-oy',
      accountingCurrency: 'EUR', accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' };
    const args = { firmId, clientId: a.clientId, actorId, profilePatch };
    await assert.rejects(prepareFinnishHostedPilotInDb({ ...args, actorId: ownerA.userId }), { code: 'PILOT_OPERATOR_REQUIRED' });
    await seed.query('delete from schema_migrations where version=$1', [files.at(-1).slice(0, -4)]);
    await assert.rejects(prepareFinnishHostedPilotInDb(args), { code: 'PILOT_MIGRATIONS_REQUIRED' });
    await seed.query('insert into schema_migrations(version) values($1)', [files.at(-1).slice(0, -4)]);
    const setupPath = `/clients/${a.clientId}/finnish-pilot-setup`;
    const reviewPath = `${setupPath}?firm_id=${firmId}`;
    for (const token of ['owner-a', 'owner-b', 'not-a-tester-token', 'unknown']) {
      const denied = await request(token, reviewPath);
      assert.ok([401, 403].includes(denied.status), JSON.stringify(denied));
      assert.equal(denied.body.client_version, undefined);
    }
    const review = await request('operator', reviewPath);
    assert.equal(review.status, 200, JSON.stringify(review));
    assert.equal(review.body.actor_id, actorId);
    assert.equal(review.body.profile.companyName, 'Synthetic A Oy');
    assert.equal(review.body.pipeline.ledger_auto_post, false);
    assert.equal(review.body.pipeline.parser_router_readiness, 'INCOMPLETE');
    assert.equal(review.body.processing_readiness, 'INCOMPLETE');
    const setupBody = { firm_id: firmId, profile_patch: profilePatch, confirmed: true, client_version: review.body.client_version };
    for (const token of ['owner-a', 'owner-b', 'not-a-tester-token', 'unknown']) {
      assert.ok([401, 403].includes((await request(token, setupPath, setupBody)).status));
    }
    assert.equal((await request('operator', setupPath, { ...setupBody, actor_id: ownerA.userId })).status, 400);
    assert.equal((await request('operator', setupPath, { ...setupBody, confirmed: false })).status, 400);
    assert.equal((await request('operator', setupPath, { ...setupBody, firm_id: 'other-firm' })).status, 403);
    const wrongClient = await request('operator', '/clients/not-in-this-firm/finnish-pilot-setup', setupBody);
    assert.equal(wrongClient.status, 409);
    assert.equal(wrongClient.body.code, 'PILOT_CLIENT_REQUIRED');
    await seed.query("update clients set company_name='Changed after review' where id=$1", [a.clientId]);
    const stale = await request('operator', setupPath, setupBody);
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'PILOT_CLIENT_CHANGED');
    assert.equal((await seed.query("select count(*)::int n from audit_events where action='pilot.prepared'")).rows[0].n, 0);
    await seed.query("update firm_members set status='inactive' where id=$1", [actorId]);
    assert.equal((await request('operator', setupPath, setupBody)).status, 403);
    await seed.query("update firm_members set status='active' where id=$1", [actorId]);
    await seed.query("update firm_collaborators set status='inactive' where user_id=$1", [ownerA.userId]);
    const current = await request('operator', reviewPath);
    const noOwner = await request('operator', setupPath, { ...setupBody, client_version: current.body.client_version });
    assert.equal(noOwner.body.code, 'PILOT_OWNER_REQUIRED');
    await seed.query("update firm_collaborators set status='active' where user_id=$1", [ownerA.userId]);
    // Pause the real preparation inside its transaction after it owns the
    // client. A previously loaded form must wait, then refuse after commit.
    await seed.query('begin'); await seed.query('lock table audit_events in share mode');
    const pendingPreparation = request('operator', setupPath, { ...setupBody, client_version: current.body.client_version });
    const waitFor = async predicate => { const deadline = Date.now()+4000;
      while (!await predicate()) { assert.ok(Date.now()<deadline, 'bounded real lock wait'); await new Promise(resolve=>setTimeout(resolve,10)); } };
    await waitFor(async()=> (await admin.query("select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query ilike '%insert into audit_events%'",[name])).rows[0].n>0);
    const staleSave = request('operator', fiProfilePath, { firm_id: firmId, profile_patch: { businessId: '1234567-1' } });
    await waitFor(async()=> (await admin.query("select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query ilike '%select jurisdiction,entity_type,incorporation_date,profile from clients%'",[name])).rows[0].n>0);
    await seed.query('commit');
    const prepared = await pendingPreparation;
    assert.equal((await staleSave).body.code, 'FI_PROFILE_PILOT_PREPARED');
    assert.equal((await request('owner-a', `${fiProfilePath}?firm_id=${firmId}`)).body.editable, false);
    assert.deepEqual((await request('owner-a', `${fiProfilePath}?firm_id=${firmId}`)).body.locked_fields,
      ['businessId', 'incorporation_date', 'alv_registration', 'verokausi'], 'facts bound before operator preparation stay locked');
    assert.deepEqual((await request('owner-a', `${fiProfilePath}?firm_id=${firmId}`)).body.fields, fiFacts);
    assert.equal((await request('operator', fiProfilePath, { firm_id: firmId, profile_patch: fiFacts })).status, 200, 'canonical same-value replay remains supported');
    const fiscalPath = `/clients/${a.clientId}/fiscal-periods`;
    assert.equal((await request('owner-a', `${fiscalPath}?firm_id=${firmId}`)).body.intake_acts, true);
    assert.equal((await request('owner-b', `/clients/${b.clientId}/fiscal-periods?firm_id=${firmId}`)).body.intake_acts, false);
    const fiscalBody = { firm_id: firmId, starts_on: '2026-01-01', ends_on: '2026-12-31' };
    const profileBeforeYear = (await seed.query('select profile from clients where id=$1',[a.clientId])).rows[0].profile;
    assert.equal((await request('operator', fiscalPath, fiscalBody)).status, 201);
    assert.equal((await request('operator', fiscalPath, fiscalBody)).body.created, false);
    assert.equal((await request('operator', fiscalPath, {...fiscalBody, starts_on:'2026-06-01'})).status, 409);
    assert.deepEqual((await seed.query('select profile from clients where id=$1',[a.clientId])).rows[0].profile, profileBeforeYear);
    assert.equal((await seed.query('select count(*)::int n from ledger_journals')).rows[0].n, 0);

    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    const receipt = prepared.body;
    assert.equal(receipt.actor_id, actorId);
    assert.deepEqual(receipt.profile, profilePatch);
    const persisted = (await seed.query("select actor_id,metadata from audit_events where action='pilot.prepared' and client_id=$1", [a.clientId])).rows;
    assert.equal(persisted.length, 1); assert.equal(persisted[0].actor_id, actorId);
    assert.deepEqual(persisted[0].metadata, receipt);
    const reread = await request('operator', reviewPath);
    assert.deepEqual(reread.body.receipt.metadata, receipt);
    assert.equal(reread.body.pipeline.ledger_auto_post, false);
    assert.equal(reread.body.pipeline.coding_auto_post, false);
    const repeat = await request('operator', setupPath, { ...setupBody, client_version: reread.body.client_version });
    assert.equal(repeat.status, 200); assert.equal(repeat.body.already_prepared, true);
    assert.equal((await seed.query("select count(*)::int n from audit_events where action='pilot.prepared'")).rows[0].n, 1);

    assert.equal(receipt.processing_readiness, 'INCOMPLETE');
    assert.ok(receipt.chart.inserted.length > 10);
    assert.equal((await prepareFinnishHostedPilotInDb(args)).already_prepared, true);
    assert.equal((await seed.query('select count(*)::int n from runtime_host_readiness')).rows[0].n, 0);
    assert.equal((await seed.query('select count(*)::int n from entity_readiness_sagas')).rows[0].n, 0);
    assert.equal((await seed.query('select count(*)::int n from client_capability_config where client_id=$1', [b.clientId])).rows[0].n, 0);
    const accessA = await assertFirmAccess({ firmId, auth: ownerA, clientIds: [a.clientId] });
    assert.equal(accessA.principal.unrestricted, false);
    assert.deepEqual(accessA.allowedClientIds, [a.clientId]);
    await assert.rejects(assertFirmAccess({ firmId, auth: ownerA, clientIds: [b.clientId] }), { code: 'FIRM_ACCESS_DENIED' });
    await assert.rejects(assertFirmAccess({ firmId, auth: ownerB, clientIds: [a.clientId] }), { code: 'FIRM_ACCESS_DENIED' });
    assert.equal((await getClientBillingContext({ firmId, clientId: a.clientId })).entitlementBasis, 'internal_pilot');
    assert.equal((await getClientBillingContext({ firmId, clientId: b.clientId })).entitled, false);
    assert.equal((await getClientBillingContext({ firmId, clientId: a.clientId })).status, null);
    for (const route of ['/ledger/audit-trail', '/reports/financial-statements', '/reports/finland-alv-return']) {
      const path = `${route}?firm_id=${firmId}&client_id=${a.clientId}&period=2026-01&period_start=2026-01-01&period_end=2026-01-31`;
      const own = await request('owner-a', path);
      assert.equal(own.status, 200, JSON.stringify(own));
      assert.equal((await request('owner-b', path)).status, 403);
    }
    assert.equal((await request('owner-b', `/clients/${a.clientId}/profile`, { firm_id: firmId, profile_patch: { companyName: 'Wrong owner' } })).status, 403);
    assert.equal((await request('owner-a', `/clients/${b.clientId}/profile`, { firm_id: firmId, profile_patch: { companyName: 'Wrong owner' } })).status, 403);
    await seed.query("insert into client_ask_batches(id,firm_id,client_id,status,payload) values('pilot-draft',$1,$2,'draft','{}')", [firmId, a.clientId]);
    await assert.rejects(__sendClientAskBatchWithClient({ client: seed, firmId, clientId: a.clientId, batchId: 'pilot-draft', actorId }), { code: 'INTERNAL_PILOT_SEND_DISABLED' });
    assert.equal((await seed.query("select status from client_ask_batches where id='pilot-draft'")).rows[0].status, 'draft');
    assert.equal((await seed.query('select count(*)::int n from client_evidence_requests')).rows[0].n, 0);
    // Accounting fixtures enter through the existing adjustment writer. This
    // proves report/correction persistence, NOT upload, model or worker quality.
    const lines = amount => [
      { account_name: 'Pilot bank', account_type: 'asset', canonical_role: 'asset.bank', debit: amount, credit: 0, currency: 'EUR' },
      { account_name: 'Pilot revenue', account_type: 'revenue', canonical_role: 'revenue.sales', debit: 0, credit: amount, currency: 'EUR', tax_type: 'ALV_0' }
    ];
    await postLedgerAdjustmentInDb({ firmId, clientId: a.clientId, actorId, journalDate: '2026-01-15', reason: 'Synthetic January source entry', lines: lines(100), reverseOriginal: false });
    await postLedgerAdjustmentInDb({ firmId, clientId: a.clientId, actorId, journalDate: '2026-02-15', reason: 'Synthetic February source entry', lines: lines(200), reverseOriginal: false });
    const readJanuary = () => getLedgerAuditTrailFromDb({ firmId, clientId: a.clientId, periodStart: '2026-01-01', periodEnd: '2026-01-31' });
    const january = await readJanuary();
    assert.equal(january.native_ledger.journals.length, 1);
    await postLedgerAdjustmentInDb({ firmId, clientId: a.clientId, actorId,
      originalJournalId: january.native_ledger.journals[0].id, journalDate: '2026-01-15', reason: 'Synthetic correction to original source amount', lines: lines(120) });
    const corrected = await readJanuary();
    assert.ok(corrected.native_ledger.correction_history.length > 0);
    for (const [month, expected] of [['01', 120], ['02', 200]]) {
      const report = await getFinancialReportFromDb({ firmId, clientId: a.clientId, periodStart: `2026-${month}-01`, periodEnd: `2026-${month}-${month === '01' ? '31' : '28'}` });
      assert.equal(report.profit_and_loss.net_income, expected);
      assert.equal(report.trial_balance.balanced, true);
      const vat = await getFinlandAlvReturnFromDb({ firmId, clientId: a.clientId, period: `2026-${month}` });
      assert.equal(vat.alvReturn.payable, 0);
    }
    assert.equal((await selfProvisionClientWorkspace({ auth: ownerA })).clientId, a.clientId);
    assert.deepEqual((await readJanuary()).native_ledger.journals, corrected.native_ledger.journals);
    // Ordinary/emergency revocation rewrites current reason/source. The real
    // config writer closes the enrollment row; its retained receipt must still
    // hold manual and automated sends, with no need to preserve magic wording.
    for (const [source, reason] of [['manual', 'Pilot revoked'], ['emergency_override', 'Emergency disable']]) {
      await setClientFlagStage(seed, { firmId, clientId: a.clientId, flagKey: INTERNAL_PILOT_ACCESS_FLAG, stage: 'canary', source: 'manual', reason: HOSTED_PILOT_VERSION, actorId });
      assert.equal((await getClientBillingContext({ firmId, clientId: a.clientId })).entitled, true);
      for (const autoSend of [false, true]) {
        await assert.rejects(__sendClientAskBatchWithClient({ client: seed, firmId, clientId: a.clientId, batchId: 'pilot-draft', actorId, autoSend }), { code: 'INTERNAL_PILOT_SEND_DISABLED' });
      }
      await setClientFlagStage(seed, { firmId, clientId: a.clientId, flagKey: INTERNAL_PILOT_ACCESS_FLAG, stage: 'off', source, reason, actorId });
      assert.equal((await getClientBillingContext({ firmId, clientId: a.clientId })).entitled, false);
      for (const autoSend of [false, true]) {
        await assert.rejects(__sendClientAskBatchWithClient({ client: seed, firmId, clientId: a.clientId, batchId: 'pilot-draft', actorId, autoSend }), { code: 'INTERNAL_PILOT_SEND_DISABLED' });
      }
      assert.equal((await seed.query("select status from client_ask_batches where id='pilot-draft'")).rows[0].status, 'draft');
      assert.equal((await seed.query('select count(*)::int n from client_evidence_requests')).rows[0].n, 0);
    }
    await assert.rejects(prepareFinnishHostedPilotInDb(args), { code: 'PILOT_EMPTY_CLIENT_REQUIRED' });
    // A truly new identity receives the exact denial consumed by the mounted
    // first-login fallback. The existing provisioning switch still owns birth.
    const fresh = await request('owner-c', `/snapshot?firm_id=${firmId}`);
    assert.equal(fresh.status, 403);
    assert.equal(fresh.body.code, 'FIRM_ACCESS_DENIED');
    delete process.env.DONNA_SELF_SERVE_PROVISIONING;
    const disabled = await request('owner-c', '/provision-workspace', {});
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.code, 'SELF_SERVE_PROVISIONING_DISABLED');
    process.env.DONNA_SELF_SERVE_PROVISIONING = 'true';
    const created = await request('owner-c', '/provision-workspace', {});
    assert.equal(created.status, 200, JSON.stringify(created));
    assert.equal(created.body.provisioned, true);
    const afterBirth = await request('owner-c', `/snapshot?firm_id=${firmId}`);
    assert.equal(afterBirth.status, 200);
    assert.deepEqual(afterBirth.body.workspaceAccess, { surface: 'owner', clientIds: [created.body.client_id] });
    assert.deepEqual(afterBirth.body.clients.map(row => row.id), [created.body.client_id]);
    assert.equal((await seed.query('select count(*)::int as n from firm_members where email=$1', [ownerC.email])).rows[0].n, 0);
    await assert.rejects(assertFirmAccess({ firmId, auth: ownerC, requireMember: true }), { code: 'FIRM_ACCESS_DENIED' });
  });
