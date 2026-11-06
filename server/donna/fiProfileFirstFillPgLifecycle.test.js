import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { handleDonnaApiRequest } from './api.js';
import { __endFirmDbPoolForTests } from './firmDb.js';

// Real HTTP + PostgreSQL: a web-created Finnish Oy is prepared at birth, before
// any form could be saved. Its still-empty facts can be recorded once, with a
// receipt; recorded facts stay locked. Only the identity provider is simulated.
const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-fi-first-fill', MEMBER_ID = 'member-fi-first-fill';
const MEMBER = { id: 'user-fi-first-fill', email: 'member@first-fill.example' };

const requestJson = async ({ url, body, method }) => {
  const encoded = JSON.stringify(body || {});
  const req = Readable.from([Buffer.from(encoded)]);
  Object.assign(req, { method, url, headers: { authorization: 'Bearer member-jwt', 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(encoded)) } });
  let text = '', done;
  const ended = new Promise(resolve => { done = resolve; });
  const res = { statusCode: 200, setHeader() {}, end(value = '') { text = String(value); done(); } };
  await handleDonnaApiRequest(req, res); await ended;
  return { status: res.statusCode, body: text ? JSON.parse(text) : null };
};

test('real HTTP + PG: a birth-prepared FI Oy records empty company facts once; recorded facts stay locked',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set' }, async () => {
    const dbName = `donna_fi_first_fill_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL }); await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const url = new URL(PG_URL); url.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
    const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DESKTOP_BLOB_DIR', 'DONNA_ACCESS_TOKEN', 'DONNA_DEFAULT_FIRM_ID', 'SUPABASE_URL',
      'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'STRIPE_SECRET_KEY',
      'VERCEL', 'VERCEL_PROJECT_ID', 'VERCEL_ENV', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_GIT_COMMIT_SHA', 'ANTHROPIC_API_KEY'];
    const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const realFetch = globalThis.fetch;
    try {
      await seed.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);');
      for (const file of (await readdir(path.join(ROOT, 'db', 'migrations'))).filter(f => f.endsWith('.sql')).sort()) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
      }
      await seed.query("insert into firms (id, name, slug) values ($1, 'First fill firm', 'first-fill-firm')", [FIRM_ID]);
      await seed.query(`insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level)
        values ($1, $2, $3, $4, 'Member', 'owner', 'active', 'staff')`, [MEMBER_ID, FIRM_ID, MEMBER.id, MEMBER.email]);
      Object.assign(process.env, { DATABASE_URL: url.toString(), DATABASE_POOL_MAX: '2', DONNA_ACCESS_TOKEN: 'unused-shared-token',
        DONNA_DEFAULT_FIRM_ID: FIRM_ID, SUPABASE_URL: 'https://auth.first-fill.invalid', SUPABASE_ANON_KEY: 'anon',
        DONNA_AUTH_ALLOWED_EMAILS: MEMBER.email, VERCEL: '1', VERCEL_PROJECT_ID: 'fixture-project', VERCEL_ENV: 'preview',
        VERCEL_DEPLOYMENT_ID: 'fixture-deployment', VERCEL_GIT_COMMIT_SHA: 'fixture-source', ANTHROPIC_API_KEY: 'fixture-only' });
      delete process.env.DONNA_DESKTOP_BLOB_DIR; delete process.env.SUPABASE_PUBLISHABLE_KEY; delete process.env.STRIPE_SECRET_KEY;
      globalThis.fetch = async (address, options = {}) => {
        assert.equal(address, 'https://auth.first-fill.invalid/auth/v1/user', 'no provider call in this proof');
        return String(options.headers?.Authorization) === 'Bearer member-jwt'
          ? { ok: true, json: async () => MEMBER } : { ok: false, json: async () => null };
      };
      const api = (route, body) => requestJson({ url: `/api/donna/firms${route}`, body, method: body ? 'POST' : 'GET' });
      const facts = { businessId: '1234567-1', incorporation_date: '2025-03-01',
        alv_registration: { status: 'registered', registered_from: '2025-03-01', tax_period: 'quarter' }, verokausi: 'quarter' };

      // Real web creation: birth equipment writes pilot.prepared in the creation transaction.
      const create = async id => {
        const created = await api('/clients', { profile: { id, companyName: `${id} Oy`, jurisdiction: 'FI', entityType: 'fi-oy', defaultCurrency: 'EUR' } });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        const prepared = (await seed.query("select id, metadata from audit_events where client_id=$1 and action='pilot.prepared'", [id])).rows;
        assert.equal(prepared.length, 1); assert.equal(prepared[0].metadata.authority_basis, 'authenticated_finnish_firm_creation');
        return Number(prepared[0].id);
      };
      const read = async id => { const r = await api(`/clients/${id}/profile?firm_id=${FIRM_ID}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
      const save = (id, patch) => api(`/clients/${id}/profile`, { firm_id: FIRM_ID, profile_patch: patch });
      const lastProfileAudit = async id => (await seed.query(`select metadata from audit_events where client_id=$1
        and action='client.profile.update' order by id desc limit 1`, [id])).rows[0]?.metadata;

      // 1. Born with the facts empty: prepared, yet every empty fact is fillable.
      const bornReceipt = await create('born-oy');
      const born = await read('born-oy');
      assert.deepEqual(born.fields, { businessId: null, incorporation_date: null, alv_registration: null, verokausi: null });
      assert.equal(born.editable, true); assert.deepEqual(born.locked_fields, []); assert.equal(born.reason, null);

      // 2. The first fill goes through the existing writer, with a receipt.
      const filled = await save('born-oy', facts);
      assert.equal(filled.status, 200, JSON.stringify(filled.body));
      const receipt = await lastProfileAudit('born-oy');
      assert.deepEqual(receipt.fi_intake_first_fill, { keys: ['businessId', 'incorporation_date', 'alv_registration', 'verokausi'],
        preparation_receipt_id: bornReceipt, basis: 'empty_fact_after_birth_preparation',
        prior: { businessId: null, incorporation_date: null, alv_registration: null, verokausi: null } });
      const after = await read('born-oy');
      assert.deepEqual(after.fields, facts);
      assert.equal(after.editable, false); assert.deepEqual(after.locked_fields, ['businessId', 'incorporation_date', 'alv_registration', 'verokausi']);
      assert.equal((await seed.query("select incorporation_date::text d from clients where id='born-oy'")).rows[0].d, '2025-03-01');

      // 3. Recorded facts stay locked; a canonical replay is still accepted and receipts no fill.
      for (const patch of [{ businessId: '7654321-8' }, { verokausi: 'month' },
        { alv_registration: { status: 'not_registered' } }, { incorporation_date: '2025-01-01' }]) {
        const refused = await save('born-oy', patch);
        assert.equal(refused.status, 409, JSON.stringify(patch)); assert.equal(refused.body.code, 'FI_PROFILE_PILOT_PREPARED');
      }
      assert.deepEqual((await read('born-oy')).fields, facts);
      assert.equal((await save('born-oy', facts)).status, 200);
      assert.equal((await lastProfileAudit('born-oy')).fi_intake_first_fill, undefined);

      // 4. Partial fills: each empty fact once, in any order; recorded ones then lock.
      await create('partial-oy');
      assert.equal((await save('partial-oy', { businessId: '2345678-9' })).status, 200);
      assert.deepEqual((await read('partial-oy')).locked_fields, ['businessId']);
      const mixed = await save('partial-oy', { businessId: '9999999-2', alv_registration: facts.alv_registration });
      assert.equal(mixed.body.code, 'FI_PROFILE_PILOT_PREPARED', 'one locked change refuses the whole patch');
      assert.equal((await read('partial-oy')).fields.alv_registration, null, 'nothing partial is written');
      assert.equal((await save('partial-oy', { businessId: '2345678-9', alv_registration: facts.alv_registration, verokausi: 'quarter' })).status, 200);
      assert.deepEqual((await lastProfileAudit('partial-oy')).fi_intake_first_fill.keys, ['alv_registration', 'verokausi']);
      assert.deepEqual((await read('partial-oy')).locked_fields, ['businessId', 'alv_registration', 'verokausi']);
      // Clearing an empty fact to empty is a no-op, never a "fill".
      assert.equal((await save('partial-oy', { incorporation_date: null })).status, 200);
      assert.equal((await lastProfileAudit('partial-oy')).fi_intake_first_fill, undefined);

      // 5. An existing-owner adoption binds the whole profile by digest: an empty
      //    fact there stays locked (no reapproval workflow exists).
      await create('adopted-oy');
      //    (Synthetic receipt shape only; the real adoption chain is proven in
      //    cloudProducerPgLifecycle.test.js through the same guard.)
      await seed.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
        values($1,'adopted-oy','firm_member',$2,'pilot.prepared','client','adopted-oy',
          '{"owner_provenance":{"kind":"existing_owner_revalidated"},"adopted_profile_digest":"synthetic"}'::jsonb)`, [FIRM_ID, MEMBER_ID]);
      assert.deepEqual((await read('adopted-oy')).locked_fields, ['businessId', 'incorporation_date', 'alv_registration', 'verokausi']);
      assert.equal((await save('adopted-oy', { businessId: '3456789-0' })).body.code, 'FI_PROFILE_PILOT_PREPARED');
    } finally {
      globalThis.fetch = realFetch;
      await __endFirmDbPoolForTests();
      for (const key of envKeys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
      await seed.end().catch(() => {});
      await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [dbName]).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
