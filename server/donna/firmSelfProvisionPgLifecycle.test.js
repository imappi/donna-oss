// Ordinary self-service onboarding for the hosted Finnish pilot, proven on
// real PostgreSQL through the real HTTP handler (2026-09-16):
//   two fresh identities → two isolated empty firm workspaces (retry/relogin
//   return the same one) → both create the SAME synthetic company without
//   collision, each initialized with the Finnish processing configuration →
//   the first statement upload is bound to the right book → complimentary
//   access is explicit config, never a paid subscription → existing members
//   and invitees keep their access → removing the original creator does not
//   strand the book while another administrator remains.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { handleDonnaApiRequest } from './api.js';
import { __endFirmDbPoolForTests } from './firmDb.js';
import { readClientConfigSnapshot, setClientFlagStage } from './clientConfig.js';
import { getClientBillingContext } from './clientSubscriptionDb.js';
import { observeEntityCertificateB } from './entityCertificateB.js';
import { COMPLIMENTARY_ACCESS_FLAG, COMPLIMENTARY_ACCESS_VERSION } from './complimentaryAccess.js';
import { INTERNAL_PILOT_ACCESS_FLAG } from './internalPilotAccess.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOSTED_FI_PROFILE = 'fi-oy.firm-intake.vercel.none.management-books.fi-cloud-pilot-v1';
const IDENTITIES = {
  alpha: { id: 'user-alpha-9f1', email: 'alpha@fresh-signup.example', jwt: 'alpha-jwt' },
  beta: { id: 'user-beta-2c7', email: 'beta@fresh-signup.example', jwt: 'beta-jwt' },
  invitee: { id: 'user-invitee-4d2', email: 'junior@fresh-signup.example', jwt: 'invitee-jwt' },
  legacy: { id: 'user-legacy-8a0', email: 'legacy@existing-firm.example', jwt: 'legacy-jwt' }
};

const restoreEnv = (key, prior) => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; };

const requestJson = async ({ url, token, body, method = body ? 'POST' : 'GET' }) => {
  const encoded = body ? JSON.stringify(body) : '';
  const req = Readable.from([Buffer.from(encoded)]);
  req.method = method; req.url = url;
  req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) };
  let responseBody = ''; let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  const res = { statusCode: 200, setHeader: () => {}, end: (value = '') => { responseBody = Buffer.isBuffer(value) ? value.toString('utf8') : String(value); resolveEnded(); } };
  await handleDonnaApiRequest(req, res);
  await ended;
  return { statusCode: res.statusCode, body: responseBody ? JSON.parse(responseBody) : null };
};

test(
  'real HTTP + PG: ordinary signup mints isolated firm workspaces; both hold the same Finnish company; authority survives the creator leaving',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — self-service firm onboarding lifecycle not exercised' },
  async () => {
    const dbName = `donna_firm_signup_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL); scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();
    const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DESKTOP_BLOB_DIR', 'DONNA_ACCESS_TOKEN', 'DONNA_DEFAULT_FIRM_ID',
      'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'STRIPE_SECRET_KEY',
      'VERCEL', 'VERCEL_PROJECT_ID', 'VERCEL_ENV', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_GIT_COMMIT_SHA', 'ANTHROPIC_API_KEY'];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const realFetch = globalThis.fetch;
    try {
      await seed.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);');
      for (const file of (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
      }
      // The deployment default is an unrelated legacy firm with an operator-
      // inserted member: it must neither receive the signups nor lose access.
      await seed.query("insert into firms(id,name,slug) values('firm-legacy','Legacy Firm','legacy-firm')");
      await seed.query("insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level) values('member-legacy','firm-legacy',$1,$2,'Legacy Member','member','active','staff')", [IDENTITIES.legacy.id, IDENTITIES.legacy.email]);
      Object.assign(process.env, {
        DATABASE_URL: scratchUrl.toString(), DATABASE_POOL_MAX: '2', DONNA_ACCESS_TOKEN: 'shared-token-unused',
        DONNA_DEFAULT_FIRM_ID: 'firm-legacy', SUPABASE_URL: 'https://auth.signup.invalid', SUPABASE_ANON_KEY: 'anon',
        // A staff allowlist that names NONE of the fresh identities: signup
        // needs no special email address and no per-user activation.
        DONNA_AUTH_ALLOWED_EMAILS: 'kari@example.test',
        VERCEL: '1', VERCEL_PROJECT_ID: 'fixture-project', VERCEL_ENV: 'preview', VERCEL_DEPLOYMENT_ID: 'fixture-deployment',
        VERCEL_GIT_COMMIT_SHA: 'fixture-source', ANTHROPIC_API_KEY: 'fixture-only'
      });
      delete process.env.DONNA_DESKTOP_BLOB_DIR; delete process.env.SUPABASE_PUBLISHABLE_KEY; delete process.env.STRIPE_SECRET_KEY;
      globalThis.fetch = async (url, options = {}) => {
        assert.equal(url, 'https://auth.signup.invalid/auth/v1/user');
        const token = String(options.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
        const identity = Object.values(IDENTITIES).find((entry) => entry.jwt === token);
        return identity ? { ok: true, json: async () => ({ id: identity.id, email: identity.email }) } : { ok: false, json: async () => null };
      };
      const api = (token) => (url, body) => requestJson({ url, body, token });
      const alpha = api(IDENTITIES.alpha.jwt); const beta = api(IDENTITIES.beta.jwt);

      // 1. A fresh verified identity has no workspace: the firm refuses it and
      //    nothing is minted by the refusal.
      //    The refusal is "verified, no workspace" (403 FIRM_ACCESS_DENIED),
      //    never "bad credentials": a reload before setup keeps its session.
      for (const attempt of ['fresh signup', 'reload before setup completes']) {
        const denied = await alpha('/api/donna/firms/snapshot');
        assert.equal(denied.statusCode, 403, `${attempt}: ${JSON.stringify(denied.body)}`);
        assert.equal(denied.body.code, 'FIRM_ACCESS_DENIED');
        assert.equal(denied.body.reason, 'workspace_required');
      }
      assert.equal((await requestJson({ url: '/api/donna/firms/snapshot', token: 'not-a-session' })).statusCode, 401, 'invalid credentials stay 401');
      assert.equal((await seed.query('select count(*)::int n from firms')).rows[0].n, 1);

      // 2. Ordinary signup → own empty firm, as administrator. Deterministic
      //    and idempotent per identity: a retry and a relogin return it.
      const bad = await alpha('/api/donna/firms/self-provision', { workspace: 'firm', firm_name: '', owner_name: 'A' });
      assert.equal(bad.statusCode, 400);
      const alphaFirm = await alpha('/api/donna/firms/self-provision', { workspace: 'firm', firm_name: 'Alpha Tilit Oy', owner_name: 'Aino Alpha' });
      assert.equal(alphaFirm.statusCode, 201, JSON.stringify(alphaFirm.body));
      assert.equal(alphaFirm.body.created, true);
      const retry = await alpha('/api/donna/firms/self-provision', { workspace: 'firm', firm_name: 'Alpha Tilit Oy', owner_name: 'Aino Alpha' });
      assert.equal(retry.statusCode, 200); assert.equal(retry.body.created, false); assert.equal(retry.body.firm_id, alphaFirm.body.firm_id);
      const betaFirm = await beta('/api/donna/firms/self-provision', { workspace: 'firm', firm_name: 'Beta Books', owner_name: 'Bo Beta' });
      assert.equal(betaFirm.statusCode, 201); assert.notEqual(betaFirm.body.firm_id, alphaFirm.body.firm_id);
      assert.equal((await seed.query('select count(*)::int n from firms')).rows[0].n, 3, 'exactly one firm per identity, no duplicates');
      const member = (await seed.query('select id,user_id,email,role,status,access_level from firm_members where firm_id=$1', [alphaFirm.body.firm_id])).rows;
      assert.deepEqual(member, [{ id: alphaFirm.body.member_id, user_id: IDENTITIES.alpha.id, email: IDENTITIES.alpha.email, role: 'admin', status: 'active', access_level: 'owner' }]);
      const receipt = (await seed.query("select actor_type,actor_id,metadata from audit_events where firm_id=$1 and action='firm.self_provisioned'", [alphaFirm.body.firm_id])).rows;
      assert.equal(receipt.length, 1); assert.equal(receipt[0].actor_id, alphaFirm.body.member_id);
      assert.equal(receipt[0].metadata.authority_basis.source, 'authenticated_firm_self_provision_route');
      // Complimentary access is an explicit, audited firm-default config row.
      const comp = (await seed.query('select stage,source,reason,client_id from client_capability_config where firm_id=$1 and flag_key=$2 and valid_to is null', [alphaFirm.body.firm_id, COMPLIMENTARY_ACCESS_FLAG])).rows;
      assert.deepEqual(comp, [{ stage: 'canary', source: 'default', reason: COMPLIMENTARY_ACCESS_VERSION, client_id: null }]);

      // 3. Each identity lands in exactly its own, empty firm workspace.
      for (const [call, firm] of [[alpha, alphaFirm.body.firm_id], [beta, betaFirm.body.firm_id]]) {
        const snapshot = await call('/api/donna/firms/snapshot');
        assert.equal(snapshot.statusCode, 200, JSON.stringify(snapshot.body));
        assert.equal(snapshot.body.firm.id, firm); assert.deepEqual(snapshot.body.clients, []);
        assert.deepEqual(snapshot.body.workspaceAccess, { surface: 'firm', clientIds: null });
      }
      assert.equal((await alpha(`/api/donna/firms/snapshot?firm_id=${betaFirm.body.firm_id}`)).statusCode, 403, 'no cross-firm read');
      assert.equal((await alpha('/api/donna/firms/snapshot?firm_id=firm-legacy')).statusCode, 403);

      // 4. Both create the SAME synthetic company (bank-derived identity, firm
      //    scoped per PR #2165) — no collision, each initialized for Finnish
      //    hosted processing without any operator step.
      const profile = { id: 'kampaamo-kultalanka-3224455-8', companyName: 'Kampaamo Kultalanka Oy', uen: '3224455-8', jurisdiction: 'FI', entityType: 'fi-oy', defaultCurrency: 'EUR' };
      const created = {};
      for (const [name, call, firm] of [['alpha', alpha, alphaFirm.body.firm_id], ['beta', beta, betaFirm.body.firm_id]]) {
        const response = await call('/api/donna/firms/clients', { id_scope: 'firm', profile });
        assert.equal(response.statusCode, 200, JSON.stringify(response.body));
        created[name] = response.body.created_client_id;
        assert.ok(created[name]);
        assert.equal((await seed.query('select uen from clients where id=$1', [created[name]])).rows[0].uen, profile.uen, 'the real persisted identity participates in readiness');
        assert.equal((await seed.query('select firm_id from clients where id=$1', [created[name]])).rows[0].firm_id, firm);
        const flags = await readClientConfigSnapshot(seed, { firmId: firm, clientId: created[name], strict: true });
        for (const key of ['FINLAND_ALV_CODING', 'JURISDICTION_TAX_CODING', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST', 'DOCUMENT_EXTRACTORS_ENABLED', 'ENTITY_READINESS_ADMISSION', INTERNAL_PILOT_ACCESS_FLAG]) {
          assert.ok(['auto', 'canary'].includes(flags[key]?.stage), `${name}: ${key} initialized`);
        }
        for (const key of ['FINLAND_ALV_FILING', 'OUTBOUND_INVOICING', 'OUTBOUND_DUNNING', 'RECONCILE_RETRACTION_AUTOSEND']) assert.equal(flags[key]?.stage, 'off', `${name}: ${key} stays dark`);
        assert.equal(flags[COMPLIMENTARY_ACCESS_FLAG]?.stage, 'canary', 'the firm-default row reaches every company');
        assert.ok((await seed.query('select count(*)::int n from ledger_accounts where firm_id=$1 and client_id=$2', [firm, created[name]])).rows[0].n > 0, 'Finnish chart seeded');
        const birth = (await seed.query("select actor_type,actor_id from audit_events where firm_id=$1 and client_id=$2 and action='client.create'", [firm, created[name]])).rows[0];
        assert.deepEqual(birth, { actor_type: 'firm_member', actor_id: (await seed.query('select id from firm_members where firm_id=$1', [firm])).rows[0].id });
        // A repeat creation of the same company is stable, not a second book.
        const again = await call('/api/donna/firms/clients', { id_scope: 'firm', profile });
        assert.equal(again.body.created_client_id, created[name]);
      }
      assert.notEqual(created.alpha, created.beta);
      assert.equal((await seed.query('select count(*)::int n from clients')).rows[0].n, 2);

      // Separate books for the same legal company must also pass readiness.
      // Creation alone passed before while the live certificate still refused.
      for (const [name, firm] of [['alpha', alphaFirm.body.firm_id], ['beta', betaFirm.body.firm_id]]) {
        for (const compatibilityScope of ['birth_residue_proof', 'current_generation_compatibility']) {
          const certificate = await observeEntityCertificateB({ query: (sql, params) => seed.query(sql, params), rootDir: ROOT,
            profileId: HOSTED_FI_PROFILE, firmId: firm, clientId: created[name], hostCertificate: null,
            compatibilityScope, lifecycle: compatibilityScope === 'birth_residue_proof' ? 'cold_create' : 'retry' });
          const isolation = certificate.checks.find(({ id }) => id === 'firm_isolation');
          assert.equal(isolation.status, 'PASS', `${name}/${compatibilityScope}: ${JSON.stringify(isolation.detail)}`);
        }
      }


      // 5. The first statement upload is bound to the caller's own book: the
      //    other firm's book is unreachable, the own book reaches readiness
      //    admission (no verified cloud host in this fixture → a typed 503,
      //    never a silent signer for a foreign or unready book).
      const bytes = Buffer.from('synthetic statement bytes');
      const upload = { filename: 'tiliote.csv', mime_type: 'text/csv', size: bytes.length, checksum_sha256: createHash('sha256').update(bytes).digest('hex') };
      const foreign = await alpha('/api/donna/firms/documents/upload-url', { client_id: created.beta, ...upload });
      assert.ok(foreign.statusCode >= 400 && !foreign.body?.signed_url, JSON.stringify(foreign.body));
      assert.equal((await seed.query('select count(*)::int n from audit_events where client_id=$1 and firm_id<>$2', [created.beta, betaFirm.body.firm_id])).rows[0].n, 0, 'nothing from another firm lands on the other book');
      const own = await alpha('/api/donna/firms/documents/upload-url', { client_id: created.alpha, ...upload });
      assert.equal(own.statusCode, 503, JSON.stringify(own.body));
      assert.equal(own.body.code, 'ENTITY_READINESS_ADMISSION_BLOCKED');
      assert.equal((await seed.query("select count(*)::int n from audit_events where action='runtime.readiness_admission_blocked' and client_id=$1", [created.alpha])).rows[0].n, 1, 'the refusal is receipted on the right book');

      // 6. No payment, no false subscription: Stripe mirror columns stay null;
      //    entitlement resolves from the explicit complimentary grant once the
      //    per-client pilot row is not the basis, and revoking it revokes.
      assert.deepEqual((await seed.query('select distinct subscription_status, stripe_customer_id, stripe_subscription_id from clients')).rows, [{ subscription_status: null, stripe_customer_id: null, stripe_subscription_id: null }]);
      process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_never_called';
      await setClientFlagStage(seed, { firmId: alphaFirm.body.firm_id, clientId: created.alpha, flagKey: INTERNAL_PILOT_ACCESS_FLAG, stage: 'off', source: 'manual', reason: 'fixture', actorType: 'firm_member', actorId: alphaFirm.body.member_id });
      const context = await getClientBillingContext({ firmId: alphaFirm.body.firm_id, clientId: created.alpha });
      assert.equal(context.entitled, true); assert.equal(context.entitlementBasis, 'complimentary'); assert.equal(context.status, null);
      const status = await alpha(`/api/donna/billing/status?client_id=${created.alpha}`);
      assert.equal(status.statusCode, 200, JSON.stringify(status.body));
      assert.equal(status.body.entitled, true); assert.equal(status.body.entitlement_basis, 'complimentary'); assert.equal(status.body.has_customer, false);
      // The owner checkout is retired (Kari, 2026-10-21): refused even with billing enabled.
      const checkout = await alpha('/api/donna/billing/checkout', { client_id: created.alpha, offer: { kind: 'recurring', bandId: 'starter' } });
      assert.equal(checkout.statusCode, 410, JSON.stringify(checkout.body)); assert.equal(checkout.body.code, 'OWNER_CHECKOUT_RETIRED');
      await setClientFlagStage(seed, { firmId: alphaFirm.body.firm_id, clientId: created.alpha, flagKey: COMPLIMENTARY_ACCESS_FLAG, stage: 'off', source: 'manual', reason: 'fixture_revoke', actorType: 'firm_member', actorId: alphaFirm.body.member_id });
      assert.equal((await getClientBillingContext({ firmId: alphaFirm.body.firm_id, clientId: created.alpha })).entitled, false, 'a client-specific off row revokes without touching Stripe');
      delete process.env.STRIPE_SECRET_KEY;

      // 7. Existing members and invitees keep the right access. The legacy
      //    member is not allowlisted either and still reaches its own firm; an
      //    invited junior seat activates into the firm that invited it and can
      //    never mint a firm of its own; a business-owner identity is refused.
      const legacy = await api(IDENTITIES.legacy.jwt)('/api/donna/firms/snapshot');
      assert.equal(legacy.statusCode, 200); assert.equal(legacy.body.firm.id, 'firm-legacy');
      await seed.query("insert into firm_collaborators(id,firm_id,email,name,role,status,access_level,seat_role,affiliation,invited_at) values('seat-junior',$1,$2,'Junior Seat','junior','invited','client_scoped','junior','internal',now())", [alphaFirm.body.firm_id, IDENTITIES.invitee.email]);
      await seed.query("insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role,access_level,status) values('assign-junior',$1,$2,'firm_collaborator','seat-junior','junior','client_scoped','active')", [alphaFirm.body.firm_id, created.alpha]);
      const invitee = api(IDENTITIES.invitee.jwt);
      const seat = await invitee('/api/donna/firms/snapshot');
      assert.equal(seat.statusCode, 200, JSON.stringify(seat.body));
      assert.equal(seat.body.firm.id, alphaFirm.body.firm_id); assert.equal(seat.body.workspaceAccess.surface, 'firm');
      assert.deepEqual(seat.body.workspaceAccess.clientIds, [created.alpha]);
      assert.equal((await seed.query("select status from firm_collaborators where id='seat-junior'")).rows[0].status, 'active', 'first authenticated match activates the seat');
      const seatMint = await invitee('/api/donna/firms/self-provision', { workspace: 'firm', firm_name: 'Rogue', owner_name: 'Junior' });
      assert.equal(seatMint.statusCode, 409); assert.equal(seatMint.body.code, 'WORKSPACE_ALREADY_AUTHORIZED');
      assert.equal((await seed.query('select count(*)::int n from firms')).rows[0].n, 3);

      // 8. Ownership survives staff changes. The creator's membership ends
      //    while another administrator remains: the historical client.create
      //    receipt is untouched, the book's current-generation certificate
      //    still passes ownership, and only a firm with NO active member fails.
      await seed.query("insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level) values('member-alpha-partner',$1,'user-partner','partner@fresh-signup.example','Pekka Partner','admin','active','owner')", [alphaFirm.body.firm_id]);
      await seed.query("update firm_members set status='inactive' where id=$1", [alphaFirm.body.member_id]);
      const removed = await alpha('/api/donna/firms/snapshot');
      assert.equal(removed.statusCode, 403, 'the removed creator has no access to the firm');
      assert.equal((await alpha(`/api/donna/firms/snapshot?firm_id=${alphaFirm.body.firm_id}`)).statusCode, 403, 'nor by naming it explicitly');
      const certify = (compatibilityScope) => observeEntityCertificateB({ query: (sql, params) => seed.query(sql, params), rootDir: ROOT, profileId: HOSTED_FI_PROFILE,
        firmId: alphaFirm.body.firm_id, clientId: created.alpha, hostCertificate: null, compatibilityScope, lifecycle: compatibilityScope === 'birth_residue_proof' ? 'cold_create' : 'retry' });
      const ownership = (certificate) => certificate.checks.find(({ id }) => id === 'ownership_actor');
      const survived = ownership(await certify('current_generation_compatibility'));
      assert.equal(survived.status, 'PASS', JSON.stringify(survived.detail));
      assert.deepEqual(survived.detail.current_firm_authority.active_member_ids, ['member-alpha-partner']);
      assert.deepEqual(survived.detail.initiating_principal, { actor_type: 'firm_member', actor_id: alphaFirm.body.member_id });
      assert.equal(ownership(await certify('birth_residue_proof')).status, 'FAIL', 'birth still needs the creator active at birth');
      assert.equal((await seed.query("select actor_id from audit_events where action='client.create' and client_id=$1", [created.alpha])).rows[0].actor_id, alphaFirm.body.member_id, 'history is never rewritten');
      await seed.query("update firm_members set status='inactive' where id='member-alpha-partner'");
      const orphaned = ownership(await certify('current_generation_compatibility'));
      assert.equal(orphaned.status, 'FAIL'); assert.deepEqual(orphaned.detail.failures, ['firm_authority_absent']);
      await seed.query("update firm_members set status='active' where id='member-alpha-partner'");
      // The creator's own retry after removal returns nothing new: no firm is
      // minted for an identity whose workspace exists, even inactive.
      assert.equal((await seed.query('select count(*)::int n from firms')).rows[0].n, 3);
    } finally {
      globalThis.fetch = realFetch;
      await __endFirmDbPoolForTests();
      for (const key of envKeys) restoreEnv(key, priorEnv[key]);
      await seed.end().catch(() => {});
      await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [dbName]).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
