import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { prepareFinnishHostedPilotInDb, reviewFinnishHostedPilotInDb } from './hostedPilot.js';
import { handleDonnaApiRequest, runParseCronTask } from './api.js';
import { __endFirmDbPoolForTests, deleteClientInDb } from './firmDb.js';
import { readClientConfigSnapshot, setClientFlagStage } from './clientConfig.js';
import { clientAllowedToAutoMatch } from './reconciliationLlmCore.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIRM_ID = 'firm-bf4';
const MEMBER_ID = 'member-bf4';
const MEMBER_USER_ID = 'user-bf4-member';
const MEMBER_EMAIL = 'member@bf4.example';
const OWNER_USER_ID = 'user-bf4-owner';
const OWNER_EMAIL = 'owner@bf4.example';
const MEMBER_CLIENT_ID = 'client-bf4-member';

const restoreEnv = (key, prior) => {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
};

const requestJson = async ({ url, token, body, method = 'POST' }) => {
  const encoded = JSON.stringify(body || {});
  const req = Readable.from([Buffer.from(encoded)]);
  req.method = method;
  req.url = url;
  req.headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(encoded))
  };

  let responseBody = '';
  let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (value = '') => {
      responseBody = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      resolveEnded();
    }
  };

  await handleDonnaApiRequest(req, res);
  await ended;
  return {
    statusCode: res.statusCode,
    body: responseBody ? JSON.parse(responseBody) : null
  };
};

const readCreateAudit = async (client, clientId) => {
  const result = await client.query(
    `select firm_id, client_id, actor_type, actor_id, metadata
       from audit_events
      where action = 'client.create' and client_id = $1
      order by created_at asc, id asc
      limit 1`,
    [clientId]
  );
  return result.rows[0] || null;
};

test(
  'real HTTP + PG: firm members land in their own empty firm and cannot cross its boundary',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — BF-4 real route lifecycle not exercised' },
  async () => {
    const dbName = `donna_firm_route_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const envKeys = [
      'DATABASE_URL',
      'DATABASE_POOL_MAX',
      'DONNA_DESKTOP_BLOB_DIR',
      'DONNA_ACCESS_TOKEN',
      'DONNA_DEFAULT_FIRM_ID',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_PUBLISHABLE_KEY',
      'DONNA_AUTH_ALLOWED_EMAILS',
      'STRIPE_SECRET_KEY',
      'VERCEL', 'VERCEL_PROJECT_ID', 'VERCEL_ENV', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_GIT_COMMIT_SHA',
      'ANTHROPIC_API_KEY'
    ];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const realFetch = globalThis.fetch;

    try {
      await seed.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);');
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      for (const file of migrations) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing',[file.slice(0,-4)]);
      }

      await seed.query(
        `insert into firms (id, name, slug)
         values ($1, 'BF-4 Route Firm', 'bf4-route-firm')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level)
         values ($1, $2, $3, $4, 'BF-4 Member', 'owner', 'active', 'staff')`,
        [MEMBER_ID, FIRM_ID, MEMBER_USER_ID, MEMBER_EMAIL]
      );

      await seed.query("insert into firms(id,name,slug) values('firm-other','Other firm','other-firm')");
      await seed.query("insert into clients(id,firm_id,company_name) values('other-client','firm-other','Private other client')");
      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '2';
      delete process.env.DONNA_DESKTOP_BLOB_DIR;
      process.env.DONNA_ACCESS_TOKEN = 'bf4-shared-token-not-used-by-these-routes';
      process.env.DONNA_DEFAULT_FIRM_ID = 'firm-other';
      process.env.SUPABASE_URL = 'https://auth.bf4.invalid';
      process.env.SUPABASE_ANON_KEY = 'bf4-anon';
      delete process.env.SUPABASE_PUBLISHABLE_KEY;
      process.env.DONNA_AUTH_ALLOWED_EMAILS = MEMBER_EMAIL;
      delete process.env.STRIPE_SECRET_KEY;

      globalThis.fetch = async (url, options = {}) => {
        assert.equal(url, 'https://auth.bf4.invalid/auth/v1/user');
        const token = String(options.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
        if (token === 'bf4-member-jwt') {
          return { ok: true, json: async () => ({ id: MEMBER_USER_ID, email: MEMBER_EMAIL }) };
        }
        if (token === 'bf4-owner-jwt') {
          return { ok: true, json: async () => ({ id: OWNER_USER_ID, email: OWNER_EMAIL }) };
        }
        return { ok: false, json: async () => null };
      };

      const api = (url, body, token = 'bf4-member-jwt') => requestJson({url, body, token, method: body ? 'POST' : 'GET'});
      const empty = await api('/api/donna/firms/snapshot');
      assert.equal(empty.statusCode, 200, JSON.stringify(empty.body));
      assert.equal(empty.body.firm.id, FIRM_ID);
      assert.deepEqual(empty.body.clients, []);
      assert.equal(empty.body.workspaceAccess.surface, 'firm');
      const deniedRead = await api('/api/donna/firms/snapshot?firm_id=firm-other');
      assert.equal(deniedRead.statusCode, 403);
      const deniedWrite = await api('/api/donna/firms/clients', {firm_id:'firm-other', profile:{id:'wrong-target',companyName:'Forbidden'}});
      assert.equal(deniedWrite.statusCode, 403);
      assert.equal((await seed.query("select count(*)::int n from clients where id='wrong-target'")).rows[0].n, 0);
      const memberCreate = await requestJson({
        url: '/api/donna/firms/clients',
        token: 'bf4-member-jwt',
        body: {
          profile: {
            id: MEMBER_CLIENT_ID,
            companyName: 'BF-4 Member Client Ltd',
            jurisdiction: 'FI',
            entityType: 'fi-oy'
          }
        }
      });
      assert.equal(memberCreate.statusCode, 200, memberCreate.body?.error);

      const memberAudit = await readCreateAudit(seed, MEMBER_CLIENT_ID);
      assert.ok(memberAudit, 'the member route persisted its client.create receipt');
      assert.equal(memberAudit.firm_id, FIRM_ID);
      assert.equal(memberAudit.client_id, MEMBER_CLIENT_ID);
      assert.equal(memberAudit.actor_type, 'firm_member');
      assert.equal(memberAudit.actor_id, MEMBER_ID);
      assert.notEqual(memberAudit.actor_id, 'system');
      assert.deepEqual(memberAudit.metadata.authority_basis, {
        source: 'authenticated_firm_create_route',
        principal_type: 'firm_member',
        principal_id: MEMBER_ID
      });
      assert.deepEqual(memberAudit.metadata.executor, {
        actor_type: 'system',
        actor_id: 'createClientInDb'
      });

      const pilotProfile = {companyName:'BF-4 Member Client Ltd',jurisdiction:'FI',entityType:'fi-oy',
        accountingCurrency:'EUR',accounting_system:'none',accounting_view:'management_books',accountingBasis:'accrual'};
      const setupScope={firmId:FIRM_ID,clientId:MEMBER_CLIENT_ID,actorId:MEMBER_ID};
      const review=await reviewFinnishHostedPilotInDb(setupScope);
      assert.equal(review.owner_provenance.kind,'authenticated_firm_creation');
      const prepared=await prepareFinnishHostedPilotInDb({...setupScope,profilePatch:pilotProfile,expectedClientVersion:review.client_version});
      assert.equal(prepared.owner_count,0);
      assert.equal(prepared.owner_provenance.actor_id,MEMBER_ID);
      assert.equal(prepared.chart.seeded,true);
      assert.equal((await seed.query('select count(*)::int n from ledger_journals')).rows[0].n,0);
      assert.equal((await seed.query('select count(*)::int n from firm_collaborators where firm_id=$1',[FIRM_ID])).rows[0].n,0);
      const tick=await runParseCronTask({task:'coding_convergence'});
      assert.deepEqual(tick.coding_convergence.firms.map(f=>f.firm_id).sort(), [FIRM_ID,'firm-other'].sort());
      assert.equal(tick.coding_convergence.errors,0);
      const portalGate = await api(`/api/donna/billing/status?client_id=${MEMBER_CLIENT_ID}`);
      assert.equal(portalGate.statusCode, 200, JSON.stringify(portalGate.body));
      assert.equal(portalGate.body.viewer_unrestricted, true);
      assert.equal((await api('/api/donna/billing/status?client_id=other-client')).statusCode, 404);
      const reopened = await api('/api/donna/firms/snapshot');
      assert.equal(reopened.statusCode, 200);
      assert.deepEqual(reopened.body.clients.map(c=>c.id), [MEMBER_CLIENT_ID]);
      assert.equal(process.env.DONNA_DEFAULT_FIRM_ID, 'firm-other');
      // First Google login binds only this invited membership.
      await seed.query('update firm_members set user_id=null where id=$1',[MEMBER_ID]);
      assert.equal((await api('/api/donna/firms/snapshot')).statusCode, 200);
      assert.equal((await seed.query('select user_id from firm_members where id=$1',[MEMBER_ID])).rows[0].user_id, MEMBER_USER_ID);
      // A bound membership cannot be selected by a different user id with the same email.
      await seed.query("update firm_members set user_id='different-user' where id=$1",[MEMBER_ID]);
      assert.equal((await api('/api/donna/firms/snapshot')).statusCode, 403);
      await seed.query('update firm_members set user_id=$2 where id=$1',[MEMBER_ID,MEMBER_USER_ID]);
      await seed.query("insert into firm_members(id,firm_id,user_id,email,name) values('duplicate','firm-other',$1,$2,'Ambiguous member')",[MEMBER_USER_ID,MEMBER_EMAIL]);
      assert.equal((await api('/api/donna/firms/snapshot')).statusCode, 401);
      await seed.query("delete from firm_members where id='duplicate'");
      await seed.query("update firm_members set status='inactive' where id=$1",[MEMBER_ID]);
      assert.equal((await api('/api/donna/firms/snapshot')).statusCode, 403);
      await seed.query("update firm_members set status='active' where id=$1",[MEMBER_ID]);
      // Database membership is the authority: a member left off the staff
      // allowlist still reaches exactly their own firm (2026-09-16 — a
      // self-provisioned firm administrator is never on an allowlist).
      process.env.DONNA_AUTH_ALLOWED_EMAILS = 'someone-else@example.test';
      const unlisted = await api('/api/donna/firms/snapshot');
      assert.equal(unlisted.statusCode, 200, JSON.stringify(unlisted.body));
      assert.equal(unlisted.body.firm.id, FIRM_ID);
      assert.equal((await api('/api/donna/firms/snapshot?firm_id=firm-other')).statusCode, 403);
      process.env.DONNA_AUTH_ALLOWED_EMAILS = MEMBER_EMAIL;

      // Real hosted creation from ordinary bank-derived identities: no
      // per-company enrollment, known company name, or hand-written flag SQL.
      Object.assign(process.env,{VERCEL:'1',VERCEL_PROJECT_ID:'fixture-project',VERCEL_ENV:'preview',
        VERCEL_DEPLOYMENT_ID:'fixture-deployment',VERCEL_GIT_COMMIT_SHA:'fixture-source',ANTHROPIC_API_KEY:'fixture-only'});
      for (const bank of ['op','nordea','s-pankki']) {
        const id=`bank-created-${bank}`;
        const profile={id,companyName:`New ${bank} Oy`,jurisdiction:'FI',entityType:'fi-oy',defaultCurrency:'EUR'};
        const created=await api('/api/donna/firms/clients',{profile});
        assert.equal(created.statusCode,200,JSON.stringify(created.body));
        const flags=await readClientConfigSnapshot(seed,{firmId:FIRM_ID,clientId:id,strict:true});
        assert.equal(clientAllowedToAutoMatch(id,{clientAllowlist:['some-previous-test-company']},{configSnapshot:flags}),true);
        for (const key of ['FINLAND_ALV_CODING','CODING_AUTO_POST','LEDGER_AUTO_POST','DOCUMENT_EXTRACTORS_ENABLED','BANK_LINE_DISPOSITION']) assert.ok(['auto','canary'].includes(flags[key]?.stage),key);
        assert.equal(flags.FINLAND_ALV_FILING.stage,'off');
        assert.ok((await seed.query('select count(*)::int n from ledger_accounts where firm_id=$1 and client_id=$2',[FIRM_ID,id])).rows[0].n>0);
        assert.equal((await seed.query('select count(*)::int n from ledger_journals where firm_id=$1 and client_id=$2',[FIRM_ID,id])).rows[0].n,0);
        const stored=(await seed.query('select profile from clients where firm_id=$1 and id=$2',[FIRM_ID,id])).rows[0].profile;
        assert.equal(stored.accountingBasis,undefined,'birth does not invent accounting facts');
        assert.equal(stored.incorporationDate,undefined);
        const admission=await evaluateEntityReadinessAdmissionWithClient({client:seed,firmId:FIRM_ID,clientId:id,boundary:'document_register'});
        assert.equal(admission.enforced,true,'a new web company must not bypass failed readiness');
        assert.equal(admission.allowed,false,'the fixture has no verified cloud host');
        const receipt=(await seed.query("select actor_id,metadata from audit_events where firm_id=$1 and client_id=$2 and action='pilot.prepared'",[FIRM_ID,id])).rows;
        assert.equal(receipt.length,1);assert.equal(receipt[0].actor_id,MEMBER_ID);
        assert.equal(receipt[0].metadata.authority_basis,'authenticated_finnish_firm_creation');
        assert.equal((await seed.query("select count(*)::int n from model_lane_policy where firm_id=$1 and client_id=$2 and lane='reconciliation_reasoning' and valid_to is null",[FIRM_ID,id])).rows[0].n,1,'governed matcher owns the lane from birth');
        await setClientFlagStage(seed,{firmId:FIRM_ID,clientId:id,flagKey:'RECONCILIATION_AUTO_MATCH',stage:'off',source:'manual',reason:'operator_pause',actorType:'firm_member',actorId:MEMBER_ID});
        assert.equal((await api('/api/donna/firms/clients',{profile})).statusCode,200);
        const repeated=await readClientConfigSnapshot(seed,{firmId:FIRM_ID,clientId:id,strict:true});
        assert.equal(repeated.RECONCILIATION_AUTO_MATCH.stage,'off','repeat uploads cannot overwrite an explicit pause');
        assert.equal((await seed.query("select count(*)::int n from audit_events where firm_id=$1 and client_id=$2 and action='pilot.prepared'",[FIRM_ID,id])).rows[0].n,1);
        if (bank==='op') {
          await deleteClientInDb({firmId:FIRM_ID,clientId:id});
          assert.equal((await api('/api/donna/firms/clients',{profile})).statusCode,200);
          const reborn=await readClientConfigSnapshot(seed,{firmId:FIRM_ID,clientId:id,strict:true});
          assert.equal(reborn.RECONCILIATION_AUTO_MATCH.stage,'canary','delete/recreate restores the normal baseline');
        }
      }
      const unsupported=await api('/api/donna/firms/clients',{profile:{id:'unsupported-fi-form',companyName:'Sole Trader',jurisdiction:'FI',entityType:'fi-toiminimi'}});
      assert.equal(unsupported.statusCode,422);
      assert.equal((await seed.query("select count(*)::int n from clients where id='unsupported-fi-form'")).rows[0].n,0);
      // A seed error cannot commit a company that then processes partially.
      await seed.query(`create function reject_fi_birth_seed() returns trigger language plpgsql as $$ begin
        if new.client_id='broken-fi-birth' then raise exception 'synthetic seed outage'; end if; return new; end $$;
        create trigger reject_fi_birth_seed before insert on client_capability_config for each row execute function reject_fi_birth_seed()`);
      const broken=await api('/api/donna/firms/clients',{profile:{id:'broken-fi-birth',companyName:'Broken Oy',jurisdiction:'FI',entityType:'fi-oy',defaultCurrency:'EUR'}});
      assert.ok(broken.statusCode>=400);
      assert.equal((await seed.query("select count(*)::int n from clients where id='broken-fi-birth'")).rows[0].n,0);
      assert.equal((await seed.query("select count(*)::int n from audit_events where client_id='broken-fi-birth'")).rows[0].n,0);
    } finally {
      globalThis.fetch = realFetch;
      await __endFirmDbPoolForTests();
      for (const key of envKeys) restoreEnv(key, priorEnv[key]);
      await seed.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
