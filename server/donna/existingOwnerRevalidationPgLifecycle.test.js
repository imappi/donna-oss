import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Readable } from 'node:stream';
import donnaRouter from '../../api/donna-router.js';
import { prepareFinnishHostedPilotInDb } from './hostedPilot.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { getClientBillingContext } from './clientSubscriptionDb.js';
import { createClientInDb, __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { auditHostedPilotParity } from '../../scripts/audit_hosted_pilot_parity.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: existing owner confirmation and operator adoption preserve historical authority and refuse stale identity',
  { skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required; this is not hosted/live-model evidence' }, async t => {
    const name = `donna_owner_adopt_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect(); await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
    const pool = new pg.Pool({ connectionString: url.toString() });
    let locker;
    const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    const previousFirm = process.env.DONNA_DEFAULT_FIRM_ID;
    const previousBlob = process.env.DONNA_DESKTOP_BLOB_DIR;
    process.env.DONNA_DEFAULT_FIRM_ID = 'fi-pilot-proof'; delete process.env.DONNA_DESKTOP_BLOB_DIR;
    t.after(async () => {
      if (previousFirm === undefined) delete process.env.DONNA_DEFAULT_FIRM_ID; else process.env.DONNA_DEFAULT_FIRM_ID = previousFirm;
      if (previousBlob === undefined) delete process.env.DONNA_DESKTOP_BLOB_DIR; else process.env.DONNA_DESKTOP_BLOB_DIR = previousBlob;
      if (locker) { await locker.query('rollback'); await locker.end(); }
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
    const operator = { userId: 'pilot-operator-user', email: 'operator@pilot.invalid' };
    // Only the external identity provider is simulated here. Real API routing,
    // principal lookup, assignment gates and readers/writers use PostgreSQL.
    const savedEnv = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS'].map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    Object.assign(process.env, { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-tester-token',
      SUPABASE_URL: 'https://pilot-auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', DONNA_AUTH_ALLOWED_EMAILS: '' });
    globalThis.fetch = async (address, init) => {
      assert.equal(address, 'https://pilot-auth.invalid/auth/v1/user', 'no unrelated/provider network call in this proof');
      const owner = init.headers.Authorization === 'Bearer owner-a' ? ownerA : init.headers.Authorization === 'Bearer owner-b' ? ownerB : init.headers.Authorization === 'Bearer operator' ? operator : null;
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
    // Reproduce the historical writer shape at birth, never disable audit immutability.
    const legacyDeps = { createClient: ({creationPrincipal, ...args}) => createClientInDb(args) };
    const a = await selfProvisionClientWorkspace({ deps: legacyDeps, auth: ownerA, companyName: 'Legacy A Oy', jurisdiction: 'FI', entityType: 'fi-oy' });
    const b = await selfProvisionClientWorkspace({ deps: legacyDeps, auth: ownerB, companyName: 'Legacy B Oy', jurisdiction: 'FI', entityType: 'fi-oy' });
    const creation = (await seed.query("select row_to_json(a)::text value from audit_events a where action='client.create' order by id")).rows;
    const clientId = a.clientId;
    const ownerReview = () => request('owner-a', '/self-provision', { owner_revalidation: { action: 'review' } });
    const ownerConfirm = digest => request('owner-a', '/self-provision', { owner_revalidation: { action: 'confirm', confirmed: true, review_digest: digest } });
    const setupPath = `/clients/${clientId}/finnish-pilot-setup`;
    const reviewPath = `${setupPath}?firm_id=${firmId}`;
    const profilePatch = { companyName: 'Legacy A Oy', jurisdiction: 'FI', entityType: 'fi-oy', accountingCurrency: 'EUR',
      accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' };
    const prepare = review => request('operator', setupPath, { firm_id: firmId, profile_patch: profilePatch, confirmed: true, client_version: review.body.client_version });
    const inventory = async () => (await seed.query(`select
      (select count(*) from client_capability_config) as config,
      (select count(*) from entity_readiness_sagas) as readiness,
      (select count(*) from firm_members) as members,
      (select count(*) from firm_collaborators) as collaborators,
      (select count(*) from client_assignments) as assignments,
      (select jsonb_agg(to_jsonb(c) order by id) from clients c) as clients`)).rows[0];
    const before = await inventory();
    assert.equal((await request('operator', reviewPath)).body.code, 'PILOT_SELF_PROVISION_REQUIRED');
    const reviewed = await ownerReview();
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
    assert.equal(reviewed.body.actor_id, ownerA.userId);
    assert.equal(reviewed.body.client_id, clientId);
    assert.equal(reviewed.body.processing_readiness, 'INCOMPLETE');
    assert.deepEqual(await inventory(), before);
    for (const token of ['unknown','not-a-tester-token','operator']) {
      assert.notEqual((await request(token, '/self-provision', { owner_revalidation: { action: 'review' } })).status, 200);
    }
    for (const extra of [{firm_id: firmId}, {client_id: b.clientId}, {actor_id: ownerB.userId}, {company_name:'Forged'}, {band_id:'paid'}]) {
      assert.equal((await request('owner-a', '/self-provision', { owner_revalidation: { action:'review' }, ...extra })).status, 400);
    }
    assert.equal((await request('owner-a', '/self-provision', { owner_revalidation: { action:'confirm', confirmed:false, review_digest:reviewed.body.review_digest } })).body.code, 'OWNER_REVALIDATION_CONFIRMATION_REQUIRED');
    assert.equal((await request('owner-b', '/self-provision', { owner_revalidation: { action:'confirm', confirmed:true, review_digest:reviewed.body.review_digest } })).body.code, 'OWNER_REVALIDATION_CHANGED');
    const collaborator = (await seed.query('select id from firm_collaborators where user_id=$1', [ownerA.userId])).rows[0].id;
    // Same email alone is insufficient; require its bound authenticated user.
    await seed.query("update firm_collaborators set user_id='different-user' where id=$1", [collaborator]);
    assert.equal((await ownerReview()).body.code, 'OWNER_REVALIDATION_IDENTITY_REQUIRED');
    await seed.query('update firm_collaborators set user_id=$1 where id=$2', [ownerA.userId, collaborator]);
    for (const [column, value, reset] of [['status','inactive','active'],['access_level','firm_wide','client_scoped'],['role','bookkeeper','owner'],['ends_at','2000-01-01',null],['starts_at','2099-01-01',null]]) {
      // Closed test fixture columns only, never request-provided SQL.
      await seed.query(`update firm_collaborators set ${column}=$1 where id=$2`, [value, collaborator]);
      assert.equal((await ownerReview()).body.code, 'OWNER_REVALIDATION_IDENTITY_REQUIRED', column);
      await seed.query(`update firm_collaborators set ${column}=$1 where id=$2`, [reset, collaborator]);
    }
    for (const [column, value, reset] of [['status','suspended','active'],['access_level','firm_wide','client_scoped'],['role','bookkeeper','owner'],['ends_at','2000-01-01',null],['starts_at','2099-01-01',null]]) {
      await seed.query(`update client_assignments set ${column}=$1 where client_id=$2`, [value, clientId]);
      assert.equal((await ownerReview()).body.code, 'OWNER_REVALIDATION_IDENTITY_REQUIRED', column);
      await seed.query(`update client_assignments set ${column}=$1 where client_id=$2`, [reset, clientId]);
    }
    assert.equal((await ownerConfirm(reviewed.body.review_digest)).body.code, 'OWNER_REVALIDATION_CHANGED');
    const beforeFacts = await ownerReview();
    const factualSave = await request('operator', `/clients/${clientId}/profile`, { firm_id: firmId,
      profile_patch: { businessId: '9999999-2', incorporation_date: '2026-01-01',
        alv_registration: { status: 'registered', registered_from: '2026-01-01', tax_period: 'month' }, verokausi: 'month' } });
    assert.equal(factualSave.status, 200, JSON.stringify(factualSave));
    assert.equal((await ownerConfirm(beforeFacts.body.review_digest)).body.code, 'OWNER_REVALIDATION_CHANGED');
    // Legacy shape: incorporation lived only in its load-bearing column and
    // no top-level cadence home existed when the owner adopted the profile.
    await seed.query("update clients set profile=profile-'incorporation_date'-'verokausi', incorporation_date='2026-01-01' where id=$1",[clientId]);
    const fresh = await ownerReview();
    const confirmed = await ownerConfirm(fresh.body.review_digest);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed));
    const repeated = await ownerConfirm(fresh.body.review_digest);
    assert.equal(repeated.body.receipt_id, confirmed.body.receipt_id);
    assert.equal(repeated.body.already_confirmed, true);
    assert.deepEqual((await seed.query("select row_to_json(a)::text value from audit_events a where action='client.create' order by id")).rows, creation);
    const fact = (await seed.query("select * from audit_events where action='client.owner_revalidated'")).rows;
    assert.equal(fact.length, 1); assert.equal(fact[0].actor_id, ownerA.userId); assert.equal(fact[0].actor_type, 'supabase_user');
    assert.equal(fact[0].metadata.authority_basis, 'current_authenticated_owner_revalidation');
    assert.equal((await seed.query('select count(*)::int n from client_capability_config')).rows[0].n, 0);
    assert.equal((await seed.query('select count(*)::int n from entity_readiness_sagas')).rows[0].n, 0);
    const operatorReview = await request('operator', reviewPath);
    assert.equal(operatorReview.status, 200, JSON.stringify(operatorReview));
    assert.equal(operatorReview.body.owner_provenance.receipt_id, confirmed.body.receipt_id);
    await assert.rejects(prepareFinnishHostedPilotInDb({ firmId, clientId, actorId, profilePatch }), {code:'PILOT_CONFIRMATION_REQUIRED'});
    await seed.query("update clients set company_name='Changed Oy' where id=$1", [clientId]);
    assert.notEqual((await prepare(operatorReview)).status, 200);
    await seed.query("update clients set company_name='Legacy A Oy' where id=$1", [clientId]);
    await ownerConfirm((await ownerReview()).body.review_digest);
    // A document arriving after confirmation makes that proof stale at apply.
    await seed.query("insert into documents(id,firm_id,client_id,filename) values('adoption-document',$1,$2,'existing.pdf')", [firmId,clientId]);
    assert.equal((await ownerReview()).body.code, 'PILOT_EMPTY_CLIENT_REQUIRED');
    assert.equal((await prepare(operatorReview)).body.code, 'PILOT_EMPTY_CLIENT_REQUIRED');
    await seed.query("delete from documents where id='adoption-document'");
    const currentReview = await request('operator', reviewPath);
    const prepared = await prepare(currentReview);
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    assert.equal(prepared.body.owner_provenance.owner_id, ownerA.userId);
    assert.equal(prepared.body.processing_readiness, 'INCOMPLETE');
    assert.equal(prepared.body.stages.FINLAND_ALV_FILING, 'off');
    const beforePeriodProfile = (await seed.query('select profile from clients where id=$1',[clientId])).rows[0].profile;
    const replayFacts = await request('operator', `/clients/${clientId}/profile`, { firm_id: firmId, profile_patch: { incorporation_date:'2026-01-01', verokausi:null } });
    assert.equal(replayFacts.status,200,JSON.stringify(replayFacts));
    assert.deepEqual((await seed.query('select profile from clients where id=$1',[clientId])).rows[0].profile, beforePeriodProfile, 'semantic replay preserves absent JSON homes and adopted digest');
    const fiscal = await request('operator', `/clients/${clientId}/fiscal-periods`, { firm_id: firmId, starts_on:'2026-01-01', ends_on:'2026-12-31' });
    assert.equal(fiscal.status, 201, JSON.stringify(fiscal));
    assert.deepEqual((await seed.query('select profile from clients where id=$1',[clientId])).rows[0].profile, beforePeriodProfile);
    assert.equal((await request('operator', `/clients/${clientId}/profile`, {firm_id:firmId,profile_patch:{businessId:'1234567-1'}})).body.code,'FI_PROFILE_PILOT_PREPARED');

    assert.equal((await prepare(await request('operator', reviewPath))).body.already_prepared, true);
    assert.equal((await seed.query("select count(*)::int n from audit_events where action='pilot.prepared'")).rows[0].n, 1);
    assert.equal((await getClientBillingContext({firmId,clientId})).entitlementBasis, 'internal_pilot');
    assert.equal((await getClientBillingContext({firmId,clientId})).status, null);
    assert.equal((await seed.query('select count(*)::int n from entity_readiness_sagas')).rows[0].n, 0);
    assert.equal((await seed.query('select count(*)::int n from client_evidence_requests')).rows[0].n, 0);
    assert.deepEqual((await seed.query("select row_to_json(a)::text value from audit_events a where action='client.create' order by id")).rows, creation);
    // Synthetic append-only malformed receipts must never launder a late or
    // unknown-contract consumption into authority. Do not mutate old receipts.
    const genuine=(await seed.query("select actor_id,metadata,created_at from audit_events where client_id=$1 and action='pilot.prepared' order by id desc limit 1",[clientId])).rows[0];
    const appendPreparation = (metadata, createdAt) => seed.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata,created_at)
      values($1,$2,'firm_member',$3,'pilot.prepared','client',$2,$4,$5)`,[firmId,clientId,actorId,metadata,createdAt]);
    await appendPreparation({...genuine.metadata,version:'unknown-preparation-contract'},genuine.created_at);
    assert.equal((await request('operator',reviewPath)).body.code,'OWNER_REVALIDATION_PREPARATION_INVALID');
    await appendPreparation(genuine.metadata,genuine.metadata.owner_provenance.confirmation_expires_at);
    assert.equal((await request('operator',reviewPath)).body.code,'OWNER_REVALIDATION_CHANGED');
    await appendPreparation(genuine.metadata,genuine.created_at);
    assert.equal((await request('operator',reviewPath)).status,200);
    await seed.query("update client_assignments set ends_at='2000-01-01' where client_id=$1", [clientId]);
    assert.equal((await request('operator', reviewPath)).body.code, 'OWNER_REVALIDATION_IDENTITY_REQUIRED');

    // Real SQL waits: a calendar authority window can expire without any row
    // version changing. The post-write guard must roll back the whole action.
    locker = new pg.Client({connectionString:url.toString()}); await locker.connect();
    const bReview = () => request('owner-b','/self-provision',{owner_revalidation:{action:'review'}});
    const bConfirm = digest => request('owner-b','/self-provision',{owner_revalidation:{action:'confirm',confirmed:true,review_digest:digest}});
    const countBFacts = async () => (await seed.query("select count(*)::int n from audit_events where client_id=$1 and action='client.owner_revalidated'",[b.clientId])).rows[0].n;
    const waitFor = async predicate => {
      const deadline=Date.now()+4000;
      while(!await predicate()) {assert.ok(Date.now()<deadline,'bounded real database wait');await new Promise(resolve=>setTimeout(resolve,10));}
    };
    await seed.query("update client_assignments set ends_at=clock_timestamp()+interval '1 second' where client_id=$1",[b.clientId]);
    const timedReview=await bReview();assert.equal(timedReview.status,200);
    await locker.query('begin');await locker.query('lock table audit_events in share mode');
    const pendingConfirm=bConfirm(timedReview.body.review_digest);
    await waitFor(async()=> (await seed.query("select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query like 'insert into audit_events%'",[name])).rows[0].n>0);
    await waitFor(async()=> (await seed.query('select ends_at<=clock_timestamp() expired from client_assignments where client_id=$1',[b.clientId])).rows[0].expired);
    await locker.query('commit');
    assert.equal((await pendingConfirm).body.code,'OWNER_REVALIDATION_IDENTITY_REQUIRED');assert.equal(await countBFacts(),0);
    await seed.query('update client_assignments set ends_at=null where client_id=$1',[b.clientId]);
    await bConfirm((await bReview()).body.review_digest);
    // Expired proof remains an honest old audit fact; it does not authorize setup.
    const bFact=(await seed.query("select metadata from audit_events where client_id=$1 and action='client.owner_revalidated' order by id desc limit 1",[b.clientId])).rows[0].metadata;
    const expired={...bFact,observed_at:'2000-01-01T00:00:00.000Z',expires_at:'2000-01-01T00:30:00.000Z'};
    await seed.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata) values($1,$2,'supabase_user',$3,'client.owner_revalidated','client',$2,$4)",[firmId,b.clientId,ownerB.userId,expired]);
    const bPath=`/clients/${b.clientId}/finnish-pilot-setup`;
    assert.equal((await request('operator',`${bPath}?firm_id=${firmId}`)).body.code,'PILOT_SELF_PROVISION_REQUIRED');
    await seed.query("update client_assignments set ends_at=clock_timestamp()+interval '1 second' where client_id=$1",[b.clientId]);
    await bConfirm((await bReview()).body.review_digest);
    const bOperatorReview=await request('operator',`${bPath}?firm_id=${firmId}`);assert.equal(bOperatorReview.status,200);
    const bBefore=await inventory();
    await locker.query('begin');await locker.query('lock table audit_events in share mode');
    const pendingPrepare=request('operator',bPath,{firm_id:firmId,profile_patch:{...profilePatch,companyName:'Legacy B Oy'},confirmed:true,client_version:bOperatorReview.body.client_version});
    await waitFor(async()=> (await seed.query("select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query ilike '%insert into audit_events%'",[name])).rows[0].n>0);
    await waitFor(async()=> (await seed.query('select ends_at<=clock_timestamp() expired from client_assignments where client_id=$1',[b.clientId])).rows[0].expired);
    await locker.query('commit');
    assert.equal((await pendingPrepare).body.code,'OWNER_REVALIDATION_IDENTITY_REQUIRED');
    assert.deepEqual(await inventory(),bBefore,'failed preparation rolls back profile, config, chart and all receipts');
    assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and action='pilot.prepared'",[b.clientId])).rows[0].n,0);
  });
