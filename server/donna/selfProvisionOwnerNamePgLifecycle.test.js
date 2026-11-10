// A business owner's own name is never the company's name.
//
// Real PostgreSQL, the real /self-provision route and the real bearer
// resolution; only the identity provider (GoTrue's /auth/v1/user) is simulated.
//   1. An email + password owner: the sign-up knows no person name, so the
//      owner principal is stored with no name, and every reader falls back to
//      the email address (mention roster, phone-app principal).
//   2. A Google owner: GoTrue returns the person's name in user_metadata, and
//      that name, not the company, is the owner principal's name.
// In both cases the company keeps the name the funnel collected.
// Skips without DONNA_PG_TEST_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import pg from 'pg';

import donnaRouter from '../../api/donna-router.js';
import { DEFAULT_FIRM_ID, __setFirmDbPoolForTests, __resetFirmDbPoolForTests, assertFirmAccess } from './firmDb.js';
import { buildMentionRosterForClient } from './mentions/mentionRosterDb.js';
import { projectPrincipal } from './mobile/mobileProjection.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('real PG + real route: a signed-up owner is named after themselves or not at all, never after their company',
  { skip: !pgUrl && 'DONNA_PG_TEST_URL required', timeout: 300_000 }, async (t) => {
    const name = `donna_owner_name_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const seed = new pg.Client({ connectionString: url.toString() });
    await seed.connect();
    const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    __setFirmDbPoolForTests(pool);
    const savedEnv = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY',
      'DONNA_AUTH_ALLOWED_EMAILS', 'DONNA_DEFAULT_FIRM_ID', 'DONNA_DESKTOP_BLOB_DIR'].map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    t.after(async () => {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      __resetFirmDbPoolForTests();
      await pool.end();
      await seed.end();
      await admin.query(`drop database "${name}" with (force)`);
      await admin.end();
    });

    await seed.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
    const root = new URL('../../db/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) {
      await seed.query(await readFile(new URL(file, root), 'utf8'));
      await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
    }
    const firmId = DEFAULT_FIRM_ID;
    await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Synthetic firm',$1,'FI','EUR')", [firmId]);

    // Synthetic identities, shaped as GoTrue returns them.
    const identities = {
      'password-owner': { id: 'owner-password', email: 'aino@sauna-synthetic.invalid', user_metadata: {} },
      'google-owner': { id: 'owner-google', email: 'eero@kahvila-synthetic.invalid',
        user_metadata: { full_name: 'Eero Esimerkki', name: 'Eero Esimerkki', email: 'eero@kahvila-synthetic.invalid' } }
    };
    Object.assign(process.env, {
      DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-tester-token', DONNA_DEFAULT_FIRM_ID: firmId,
      SUPABASE_URL: 'https://owner-name-auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', DONNA_AUTH_ALLOWED_EMAILS: ''
    });
    delete process.env.DONNA_DESKTOP_BLOB_DIR;
    globalThis.fetch = async (address, init) => {
      assert.equal(address, 'https://owner-name-auth.invalid/auth/v1/user', 'no other network call in this proof');
      const user = identities[String(init.headers.Authorization).replace(/^Bearer /, '')];
      return new Response(JSON.stringify(user || {}), { status: user ? 200 : 401 });
    };
    const post = (token, body) => new Promise((resolve, reject) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      req.method = 'POST';
      req.url = `/api/donna-router?path=${encodeURIComponent('firms/self-provision')}`;
      req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const res = { statusCode: 200, setHeader() {}, end(value) { resolve({ status: this.statusCode, body: JSON.parse(String(value)) }); } };
      Promise.resolve(donnaRouter(req, res)).catch(reject);
    });
    const ownerRow = async (email) => (await seed.query(
      "select id, name, role, status, access_level from firm_collaborators where firm_id=$1 and lower(email)=$2", [firmId, email])).rows[0];
    const companyName = async (clientId) => (await seed.query('select company_name from clients where id=$1', [clientId])).rows[0]?.company_name;

    // ── 1. Email + password: the sign-up knows no person name ────────────────
    const a = await post('password-owner', { company_name: 'Synthetic Sauna Oy', jurisdiction: 'FI', entity_type: 'fi-oy' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(await companyName(a.body.client_id), 'Synthetic Sauna Oy', 'the company keeps the name the funnel collected');
    const aRow = await ownerRow(identities['password-owner'].email);
    assert.equal(aRow.role, 'owner');
    assert.notEqual(aRow.name, 'Synthetic Sauna Oy', 'the owner is not named after the company');
    assert.equal(aRow.name, null, 'no person name is known, so none is stored');
    const rosterA = await buildMentionRosterForClient({ firmId, clientId: a.body.client_id });
    const entryA = rosterA.find((e) => e.principal_id === aRow.id);
    assert.equal(entryA.display, 'aino', 'the mention roster falls back to the email address');
    const accessA = await assertFirmAccess({ firmId, auth: { type: 'supabase_user', userId: 'owner-password', email: identities['password-owner'].email } });
    assert.equal(projectPrincipal({ principal: accessA.principal, identity: { email: identities['password-owner'].email } }).display_name,
      identities['password-owner'].email, 'the phone app names the principal by email');

    // ── 2. Google: the identity provider returns the person's name ───────────
    const b = await post('google-owner', { company_name: 'Synthetic Kahvila Oy', jurisdiction: 'FI', entity_type: 'fi-oy' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(await companyName(b.body.client_id), 'Synthetic Kahvila Oy');
    const bRow = await ownerRow(identities['google-owner'].email);
    assert.equal(bRow.name, 'Eero Esimerkki', 'the owner carries their own name');
    const rosterB = await buildMentionRosterForClient({ firmId, clientId: b.body.client_id });
    assert.equal(rosterB.find((e) => e.principal_id === bRow.id).display, 'Eero Esimerkki');

    // A returning sign-up is navigation: it never rewrites the owner row.
    const again = await post('google-owner', { company_name: 'Synthetic Kahvila Oy' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(await ownerRow(identities['google-owner'].email), bRow);
  });
