// BF-4 — real HTTP routes + PostgreSQL lifecycle proof for client-creation
// actor attribution.
//
// OPT-IN like the other BF real-PG suites: DONNA_PG_TEST_URL must name a
// scratch PostgreSQL role that may CREATE DATABASE. The test applies the real
// migrations, authenticates a firm member and a self-provisioning owner through
// the production bearer path, and reads the persisted client.create receipts.

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { handleDonnaApiRequest } from './api.js';
import { __endFirmDbPoolForTests } from './firmDb.js';

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

const requestJson = async ({ url, token, body }) => {
  const encoded = JSON.stringify(body || {});
  const req = Readable.from([Buffer.from(encoded)]);
  req.method = 'POST';
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
  'real routes + PG: member and owner client creation preserve actor, authority basis, and owning firm',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — BF-4 real route lifecycle not exercised' },
  async () => {
    const dbName = `donna_bf4_${Date.now().toString(36)}_${process.pid}`;
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
      'STRIPE_SECRET_KEY'
    ];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const realFetch = globalThis.fetch;

    try {
      const supabaseOnly = new Set([
        '010_evidence_object_storage.sql',
        '032_lock_down_public_rls.sql',
        '060_procountor_api_key.sql'
      ]);
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
        .sort();
      for (const file of migrations) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
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

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '2';
      delete process.env.DONNA_DESKTOP_BLOB_DIR;
      process.env.DONNA_ACCESS_TOKEN = 'bf4-shared-token-not-used-by-these-routes';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
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

      const memberCreate = await requestJson({
        url: '/api/donna/firms/clients',
        token: 'bf4-member-jwt',
        body: {
          firm_id: FIRM_ID,
          profile: {
            id: MEMBER_CLIENT_ID,
            companyName: 'BF-4 Member Client Ltd',
            jurisdiction: 'GB',
            entityType: 'gb-ltd'
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

      const ownerCreate = await requestJson({
        url: '/api/donna/firms/self-provision',
        token: 'bf4-owner-jwt',
        body: { company_name: 'BF-4 Owner Client' }
      });
      assert.equal(ownerCreate.statusCode, 201, ownerCreate.body?.error);
      const ownerClientId = ownerCreate.body.client_id;

      const ownerAudit = await readCreateAudit(seed, ownerClientId);
      assert.ok(ownerAudit, 'the self-provision route persisted its client.create receipt');
      assert.equal(ownerAudit.firm_id, FIRM_ID);
      assert.equal(ownerAudit.client_id, ownerClientId);
      assert.equal(ownerAudit.actor_type, 'supabase_user');
      assert.equal(ownerAudit.actor_id, OWNER_USER_ID);
      assert.notEqual(ownerAudit.actor_id, 'system');
      assert.deepEqual(ownerAudit.metadata.authority_basis, {
        source: 'authenticated_self_provision_route',
        principal_type: 'supabase_user',
        principal_id: OWNER_USER_ID
      });
      assert.deepEqual(ownerAudit.metadata.executor, {
        actor_type: 'system',
        actor_id: 'createClientInDb'
      });

      const ownerScope = (await seed.query(
        `select c.firm_id, fc.user_id, fc.role, ca.client_id
           from clients c
           join client_assignments ca on ca.firm_id = c.firm_id and ca.client_id = c.id
           join firm_collaborators fc on fc.firm_id = ca.firm_id and fc.id = ca.principal_id
          where c.id = $1 and ca.principal_type = 'firm_collaborator'`,
        [ownerClientId]
      )).rows[0];
      assert.deepEqual(ownerScope, {
        firm_id: FIRM_ID,
        user_id: OWNER_USER_ID,
        role: 'owner',
        client_id: ownerClientId
      }, 'the actor receipt names the same authenticated owner bound into the owning firm');
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
