import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Readable } from 'node:stream';
import donnaRouter from '../../api/donna-router.js';
import { prepareFinnishHostedPilotInDb } from './hostedPilot.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { getClientBillingContext } from './clientSubscriptionDb.js';
import { DEFAULT_FIRM_ID, __setFirmDbPoolForTests, __resetFirmDbPoolForTests, assertFirmAccess,
  getFinancialReportFromDb, getLedgerAuditTrailFromDb, postLedgerAdjustmentInDb,
  __sendClientAskBatchWithClient } from './firmDb.js';
import { getFinlandAlvReturnFromDb } from './finland/statutoryDb.js';
import { auditHostedPilotParity } from '../../scripts/audit_hosted_pilot_parity.js';
import { setClientFlagStage } from './clientConfig.js';
import { INTERNAL_PILOT_ACCESS_FLAG, HOSTED_PILOT_VERSION } from './internalPilotAccess.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: fresh Google owner completes an empty FI company before pilot activation, without billing or access grants',
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
    process.env.DONNA_DEFAULT_FIRM_ID = DEFAULT_FIRM_ID; delete process.env.DONNA_DESKTOP_BLOB_DIR;
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
    const firmId = DEFAULT_FIRM_ID, actorId = 'fi-pilot-operator';
    await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Isolated pilot proof',$1,'FI','EUR')", [firmId]);
    await seed.query("insert into firm_members(id,firm_id,email,name,role,status) values($1,$2,'operator@pilot.invalid','Operator','admin','active')", [actorId, firmId]);
    const ownerA = { userId: 'pilot-owner-a', email: 'a@pilot.invalid' };
    const ownerB = { userId: 'pilot-owner-b', email: 'b@pilot.invalid' };
    const ownerC = { userId: 'pilot-owner-c', email: 'c@pilot.invalid' };
    const operator = { userId: 'pilot-operator-user', email: 'operator@pilot.invalid' };
    // Only the external identity provider is simulated here. Real API routing,
    // principal lookup, assignment gates and readers/writers use PostgreSQL.
    const savedEnv = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'DONNA_SELF_SERVE_PROVISIONING', 'STRIPE_SECRET_KEY'].map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    Object.assign(process.env, { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-tester-token',
      SUPABASE_URL: 'https://pilot-auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', DONNA_AUTH_ALLOWED_EMAILS: '', STRIPE_SECRET_KEY: 'sk_test_synthetic_no_network' });
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
      const routedPath = route.pathname.startsWith('/billing/') ? route.pathname.slice(1) : `firms${route.pathname}`;
      req.url = `/api/donna-router?path=${encodeURIComponent(routedPath)}${route.search ? `&${route.search.slice(1)}` : ''}`;
      req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      return new Promise((resolve, reject) => {
        const res = { statusCode: 200, setHeader() {}, end(value) { resolve({ status: this.statusCode, body: JSON.parse(String(value)) }); } };
        Promise.resolve(donnaRouter(req, res)).catch(reject);
      });
    };

    const a = await selfProvisionClientWorkspace({ auth: ownerA });
    const b = await selfProvisionClientWorkspace({ auth: ownerB });
    const path = `/clients/${a.clientId}/profile`;
    const patch = {companyName:'Northern Synthetic Oy', jurisdiction:'FI', entityType:'fi-oy', incorporation_date:'2025-01-01'};
    const body = {owner_setup:true,profile_patch:patch};
    const permissions = async id => {
      const inventory = {};
      for (const table of ['client_capability_config','client_assignments','reconciliation_authority_grants','action_authority_grants']) {
        inventory[table] = (await seed.query(`select * from ${table} where firm_id=$1 and client_id=$2 order by id`,[firmId,id])).rows;
      }
      return inventory;
    };
    const originalPermissions=await permissions(a.clientId);
    const statusPath = `/billing/status?client_id=${a.clientId}`;
    const initialStatus = await request('owner-a',statusPath);
    assert.equal(initialStatus.status,200,JSON.stringify(initialStatus));
    assert.equal(initialStatus.body.company_setup_required,true);
    assert.equal(initialStatus.body.owner_email,ownerA.email);
    assert.equal((await getClientBillingContext({firmId,clientId:a.clientId})).entitled,false);
    assert.equal((await request('owner-a',path,{profile_patch:patch})).status,402,'ordinary profile writes still require entitlement');
    assert.equal((await request('owner-b',path,body)).status,403,'cross-owner scope refused');
    assert.equal((await request('owner-a',path,{...body,actor_id:'forged'})).status,400);
    assert.equal((await request('owner-a',path,{...body,profile_patch:{...patch,accounting_system:'none'}})).status,409,'closed identity fields only');
    assert.equal((await request('owner-a',path,{...body,profile_patch:{...patch,incorporation_date:'2025-02-30'}})).status,409);
    const applied=await request('owner-a',path,body);
    assert.equal(applied.status,200,JSON.stringify(applied));
    const row=(await seed.query('select jurisdiction,entity_type,company_name,incorporation_date::text from clients where id=$1',[a.clientId])).rows[0];
    assert.deepEqual(row,{jurisdiction:'FI',entity_type:'fi-oy',company_name:patch.companyName,incorporation_date:'2025-01-01'});
    assert.equal((await getClientBillingContext({firmId,clientId:a.clientId})).entitled,false,'profile completion does not grant access');
    assert.deepEqual(await permissions(a.clientId),originalPermissions,'setup grants no permissions, config or accounting authority');
    const audit=(await seed.query("select actor_id,metadata from audit_events where client_id=$1 and action='client.profile.update' order by id desc limit 1",[a.clientId])).rows[0];
    assert.equal(audit?.actor_id,ownerA.userId,'named writer receipts real owner');
    const confirmation=(await seed.query("select actor_type,actor_id,metadata from audit_events where client_id=$1 and action='client.owner_company_setup'",[a.clientId])).rows;
    assert.equal(confirmation.length,1);assert.equal(confirmation[0].actor_type,'supabase_user');
    assert.equal(confirmation[0].actor_id,ownerA.userId);
    assert.equal(confirmation[0].metadata.authority_basis,'authenticated_initial_owner_company_confirmation');
    const savedStatus=(await request('owner-a',statusPath)).body;
    assert.equal(savedStatus.company_setup_required,false);assert.equal(savedStatus.pilot_pending,true);assert.equal(savedStatus.entitled,false);
    assert.equal((await request('owner-a',path,body)).status,409,'a second form cannot replace established identity');
    assert.equal((await seed.query('select count(*)::int n from ledger_journals')).rows[0].n,0);
    assert.equal((await seed.query("select count(*)::int n from client_capability_config where client_id=$1 and flag_key='INTERNAL_PILOT_ACCESS'",[a.clientId])).rows[0].n,0);
    assert.equal((await seed.query('select jurisdiction from clients where id=$1',[b.clientId])).rows[0].jurisdiction,null);
    // Foreign/suspended identities cannot use a previously opened form.
    await seed.query("update firm_collaborators set status='inactive' where user_id=$1",[ownerB.userId]);
    assert.ok([401,403].includes((await request('owner-b',`/clients/${b.clientId}/profile`,body)).status));
    await seed.query("update firm_collaborators set status='active' where user_id=$1",[ownerB.userId]);
    await seed.query("insert into clients(id,firm_id,company_name,status) values('legacy-empty',$1,'Legacy empty workspace','active')",[firmId]);
    await seed.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role,access_level)
      select 'legacy-empty-owner',firm_id,'legacy-empty',principal_type,principal_id,role,access_level
      from client_assignments where client_id=$1`,[b.clientId]);
    assert.equal((await request('owner-b','/clients/legacy-empty/profile',body)).status,409,'current ownership alone is not authenticated self-provision birth');
    // Hold the entity lock after ingress admits the owner, then change access
    // before the real setup writer obtains its lock. Each persisted predicate
    // must be revalidated under the write transaction, not trusted from ingress.
    const accessChanges = [
      ["client_assignments", "status='ended'"],
      ["client_assignments", "role='viewer'"],
      ["client_assignments", "access_level='none'"],
      ["client_assignments", "assignment_kind='specialist_role'"],
      ["firm_collaborators", "ends_at=clock_timestamp()-interval '1 second'"],
      ["firm_collaborators", "starts_at=clock_timestamp()+interval '1 day'"]
    ];
    for (const [table, change] of accessChanges) {
      await seed.query('begin');
      await seed.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`entity-readiness:${firmId}:${b.clientId}`]);
      const inFlight=request('owner-b',`/clients/${b.clientId}/profile`,body);
      let waiting=false;
      try {
        for(let attempt=0;attempt<100;attempt+=1) {
          waiting=(await admin.query("select exists(select 1 from pg_stat_activity where datname=$1 and wait_event='advisory' and query like '%pg_advisory_xact_lock%') waiting",[name])).rows[0].waiting;
          if(waiting)break;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.equal(waiting,true,'request passed real ingress and reached the held entity lock');
        if(table==='client_assignments') await seed.query(`update client_assignments set ${change} where client_id=$1`,[b.clientId]);
        else await seed.query(`update firm_collaborators set ${change} where user_id=$1`,[ownerB.userId]);
      } finally { await seed.query('commit'); }
      assert.equal((await inFlight).status,409,`write-time access change refused: ${table} ${change}`);
      assert.equal((await seed.query('select entity_type from clients where id=$1',[b.clientId])).rows[0].entity_type,null);
      assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and action='client.owner_company_setup'",[b.clientId])).rows[0].n,0);
      await seed.query("update client_assignments set status='active',role='owner',access_level='client_scoped',assignment_kind='capability' where client_id=$1",[b.clientId]);
      await seed.query("update firm_collaborators set starts_at=null,ends_at=null where user_id=$1",[ownerB.userId]);
    }
    // Real paid entitlement must keep an older incomplete company usable;
    // a billing-disabled convenience value must not suppress fresh intake.
    await seed.query("update clients set subscription_status='active' where id=$1",[b.clientId]);
    const legacyPaid=(await request('owner-b',`/billing/status?client_id=${b.clientId}`)).body;
    assert.equal(legacyPaid.entitled,true);
    assert.equal(legacyPaid.company_setup_required,false,'paid legacy identity is not forced into initial empty-book setup');
    await seed.query('update clients set subscription_status=null where id=$1',[b.clientId]);
    // An ordinary company identity or any existing material cannot be replaced
    // through this pre-entitlement completion route.
    const c = await selfProvisionClientWorkspace({auth:ownerC});
    const cPath=`/clients/${c.clientId}/profile`;
    await seed.query("update clients set jurisdiction='GB' where id=$1",[c.clientId]);
    assert.equal((await request('owner-c',cPath,body)).status,409);
    await seed.query('update clients set jurisdiction=null where id=$1',[c.clientId]);
    await seed.query("insert into documents(id,firm_id,client_id,filename,status) values('existing-material',$1,$2,'existing.pdf','received')",[firmId,c.clientId]);
    assert.equal((await request('owner-c',cPath,body)).status,409);
    await seed.query("delete from documents where id='existing-material'");
    const beforeIdentity=(await seed.query('select company_name,jurisdiction,entity_type,profile from clients where id=$1',[c.clientId])).rows[0];
    // The owner authority receipt is a commit precondition. Its failure must
    // roll back the existing profile writer, including canonical columns.
    await seed.query(`create function reject_owner_setup_receipt() returns trigger language plpgsql as $$ begin
      if new.action='client.owner_company_setup' then raise exception 'fixture audit rejection'; end if; return new; end $$;
      create trigger reject_owner_setup_receipt before insert on audit_events for each row execute function reject_owner_setup_receipt()`);
    assert.equal((await request('owner-c',cPath,body)).status,500);
    assert.deepEqual((await seed.query('select company_name,jurisdiction,entity_type,profile from clients where id=$1',[c.clientId])).rows[0],beforeIdentity);
    await seed.query('drop trigger reject_owner_setup_receipt on audit_events;drop function reject_owner_setup_receipt()');
    const race=await Promise.all([request('owner-c',cPath,body),request('owner-c',cPath,body)]);
    assert.deepEqual(race.map(result=>result.status).sort(),[200,409]);
    assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and action='client.owner_company_setup'",[c.clientId])).rows[0].n,1);
    assert.equal((await getClientBillingContext({firmId,clientId:c.clientId})).entitled,false);
    // Real operator preparation, after explicit owner-confirmed accounting facts,
    // still provides the only internal-pilot entitlement.
    await prepareFinnishHostedPilotInDb({firmId,clientId:a.clientId,actorId,profilePatch:{companyName:patch.companyName,jurisdiction:'FI',entityType:'fi-oy',accountingCurrency:'EUR',accounting_system:'none',accounting_view:'management_books',accountingBasis:'accrual'}});
    assert.equal((await getClientBillingContext({firmId,clientId:a.clientId})).entitlementBasis,'internal_pilot');
    const activatedStatus=(await request('owner-a',statusPath)).body;
    assert.equal(activatedStatus.entitled,true);assert.equal(activatedStatus.pilot_pending,false);
    assert.equal((await request('owner-a',path,body)).status,409,'activation does not reopen initial identity repair');
});
