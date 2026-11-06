import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import pg from 'pg';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { FI_PROFILE } from './testSupport/fiReliabilitySources.js';
import { handleDonnaApiRequest } from './api.js';
import { withFirmDbClient } from './firmDb.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { provisionEntityReadiness } from './runtimeReadiness.js';
import { loadPgPool } from './db/pool.js';
import { acquireEntityReadinessAdmissionLeaseWithClient } from './runtimeReadinessAdmission.js';

const post = (port, token, body = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = request({ hostname: '127.0.0.1', port, path: '/api/donna/firms/self-provision', method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
    let text = ''; res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
  });
  req.on('error', reject); req.end(data);
});

test('real HTTP/PG: ready returning owner logs in while an admitted worker holds its shared entity lease',
  { skip: applianceHarnessSkipReason(), timeout: 30000 }, async () => {
    const app = await bootApplianceForTest({ firm: { jurisdiction: 'FI', currency: 'EUR' },
      env: { SUPABASE_URL: 'https://login.fixture.invalid', SUPABASE_ANON_KEY: 'fixture-only' } });
    const providerFetch = globalThis.fetch;
    const identities = { owner: { id: 'login-owner', email: 'owner@login.fixture.invalid' }, foreign: { id: 'other-identity', email: 'owner@login.fixture.invalid' },
      newcomer: { id: 'new-owner', email: 'new@login.fixture.invalid' } };
    globalThis.fetch = async (url, init) => {
      if (String(url) === 'https://login.fixture.invalid/auth/v1/user') {
        const identity = identities[String(init.headers.Authorization || init.headers.authorization).replace('Bearer ', '')];
        return { ok: Boolean(identity), status: identity ? 200 : 401, json: async () => identity || {} };
      }
      return providerFetch(url, init);
    };
    const server = createServer((req, res) => handleDonnaApiRequest(req, res));
    const holder = new pg.Client({ connectionString: app.databaseUrl });
    let lease;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      assert.equal((await app.read.host()).status, 'PASS');
      process.env.DONNA_DEFAULT_FIRM_ID = app.firmId;
      const born = await selfProvisionClientWorkspace({ auth: { type: 'supabase_user', userId: 'login-owner', email: identities.owner.email }, companyName: FI_PROFILE.companyName, jurisdiction: 'FI', entityType: 'fi-oy' });
      const clientId = born.clientId;
      const certified = await provisionEntityReadiness({ withFirmDbClientFn: withFirmDbClient, firmId: app.firmId, clientId, creationPath: 'self_provision' });
      assert.equal(certified.row.state, 'ready', JSON.stringify(certified.certificate?.checks?.filter(c => c.status !== 'PASS')));
      // The fixture is certified on its actual local host. Mount the same web
      // handler without the appliance-only route exclusion; this is not a
      // production-cloud certificate or storage qualification.
      process.env.DONNA_DESKTOP_BLOB_DIR = '';
      const pool = await loadPgPool();
      const bounded = await Promise.all([pool.connect(), pool.connect()]);
      for (const client of bounded) { await client.query("set statement_timeout='800ms'"); client.release(); }
      await holder.connect();
      lease = await acquireEntityReadinessAdmissionLeaseWithClient({ client: holder, firmId: app.firmId, clientId, boundary: 'worker_discovery' });
      assert.equal(lease.decision.allowed, true);
      assert.equal(lease.decision.enforced, true);
      const inventory = async () => (await app.query(`select
        (select jsonb_agg(to_jsonb(s)) from entity_readiness_sagas s where firm_id=$1 and client_id=$2) sagas,
        (select to_jsonb(c) from clients c where firm_id=$1 and id=$2) company,
        (select jsonb_agg(to_jsonb(g)) from reconciliation_authority_grants g where firm_id=$1 and client_id=$2) reconciliation_grants,
        (select jsonb_agg(to_jsonb(g)) from action_authority_grants g where firm_id=$1 and client_id=$2) action_grants,
        (select count(*) from audit_events where firm_id=$1 and client_id=$2) audits,
        (select jsonb_agg(to_jsonb(c)) from client_capability_config c where firm_id=$1 and client_id=$2) flags,
        (select count(*) from ledger_journals where firm_id=$1 and client_id=$2) journals,
        (select jsonb_agg(to_jsonb(c)) from firm_collaborators c where user_id='login-owner') principal,
        (select jsonb_agg(to_jsonb(a)) from client_assignments a where client_id=$2) assignment`, [app.firmId, clientId])).rows[0];
      const before = await inventory();
      const returning = await post(server.address().port, 'owner');
      assert.equal(returning.status, 200, JSON.stringify(returning));
      assert.deepEqual(returning.body, { client_id: clientId, created: false });
      assert.equal((await app.query('select pg_try_advisory_xact_lock(hashtextextended($1, 0)) acquired', [`entity-readiness:${app.firmId}:${clientId}`])).rows[0].acquired, false, 'shared worker fence is still held after successful login');
      assert.deepEqual(await inventory(), before, 'navigation changes no readiness, authority or accounting rows');
      const wrongIdentity = await post(server.address().port, 'foreign');
      assert.equal(wrongIdentity.status, 409, JSON.stringify(wrongIdentity));
      assert.equal(wrongIdentity.body.code, 'PROVISION_PRINCIPAL_CONFLICT');
      assert.deepEqual(await inventory(), before);
      await lease.release(); lease = null;
      await app.query("update firm_collaborators set status='suspended' where user_id='login-owner'");
      const suspended = await post(server.address().port, 'owner');
      assert.equal(suspended.status, 409, JSON.stringify(suspended));
      assert.equal(suspended.body.code, 'PROVISION_PRINCIPAL_CONFLICT');
      assert.equal((await app.query("select status from firm_collaborators where user_id='login-owner'")).rows[0].status, 'suspended');
      // New owner still enters the real creation/readiness path.
      const fresh = await post(server.address().port, 'newcomer', { company_name: 'New Finnish Test Oy', jurisdiction: 'FI', entity_type: 'fi-oy' });
      assert.equal(fresh.status, 201, JSON.stringify(fresh));
      assert.equal(fresh.body.created, true);
      assert.notEqual(fresh.body.client_id, clientId);
      assert.equal((await app.query('select count(*)::int n from entity_readiness_sagas where firm_id=$1 and client_id=$2', [app.firmId, fresh.body.client_id])).rows[0].n, 1);
      const freshSaga = await app.read.readiness(fresh.body.client_id);
      assert.equal(freshSaga.state, 'failed', 'unprepared local web owner has not acquired runtime readiness');
      // A non-ready owner still enters the existing lifecycle path. A raw
      // fixture lock tests this branch; it is not an admitted worker lease.
      const rebounded = await Promise.all([pool.connect(), pool.connect()]);
      for (const client of rebounded) { await client.query("set statement_timeout='800ms'"); client.release(); }
      const unreadyKey = `entity-readiness:${app.firmId}:${fresh.body.client_id}`;
      await holder.query('select pg_advisory_lock_shared(hashtextextended($1, 0))', [unreadyKey]);
      try {
        const blockedRetry = await post(server.address().port, 'newcomer');
        assert.equal(blockedRetry.status, 500, JSON.stringify(blockedRetry));
        assert.equal(blockedRetry.body.code, '57014', 'non-ready navigation retains the lifecycle lock');
      } finally { await holder.query('select pg_advisory_unlock_shared(hashtextextended($1, 0))', [unreadyKey]); }
      const notReady = await post(server.address().port, 'newcomer');
      assert.equal(notReady.status, 200, JSON.stringify(notReady));
      assert.equal(notReady.body.created, false);
      assert.deepEqual(await app.read.readiness(fresh.body.client_id), freshSaga, 'failed create replay cannot bypass recovery or mint authority');
      app.providers.assertNoUnscripted();
    } finally {
      if (lease) await lease.release();
      await holder.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      globalThis.fetch = providerFetch; await app.stop();
    }
  });
