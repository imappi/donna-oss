// The named client-profile writer (db/clients.js updateClientProfileInDb)
// through the real firm route POST /clients/:id/profile on real PostgreSQL.
// Only the identity provider is simulated. Proves:
//   1. its `client.profile.update` audit row names the acting principal (type
//      and id) and records what each written key held before, so a wrong
//      change can be undone from the record alone;
//   2. clients.legal_names follows a confirmed or corrected legal name in the
//      same transaction, through the create path's own derivation;
//   3. the phone business register's keys (legalName, business_register,
//      business_setup) are known keys: no "unknown key" warning on a valid
//      write, and a malformed value is refused without writing anything.
// All firms, people, companies and Business IDs are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import pg from 'pg';
import donnaRouter from '../../api/donna-router.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, deriveClientIdentityColumns } from './firmDb.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('real PG: the profile writer records who acted and what was there, and keeps legal_names in step', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — disposable-PG profile writer record not exercised', timeout: 300_000
}, async (t) => {
  const name = `donna_profile_record_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect(); await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = []; pool.on('connect', (c) => closed.push(new Promise((resolve) => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const firmId = 'profile-record-firm';
  const savedEnv = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'DONNA_DEFAULT_FIRM_ID', 'DONNA_DESKTOP_BLOB_DIR',
    'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'STRIPE_SECRET_KEY'].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await seed.end();
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await seed.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, root), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Profile record firm',$1,'FI','EUR')", [firmId]);
  const memberId = 'member-profile-record';
  const member = { userId: 'user-profile-record-member', email: 'member@profile-record.invalid' };
  const owner = { userId: 'user-profile-record-owner', email: 'owner@profile-record.invalid' };
  await seed.query("insert into firm_members(id,firm_id,user_id,email,name,role,status) values($1,$2,$3,$4,'Fixture member','admin','active')",
    [memberId, firmId, member.userId, member.email]);

  Object.assign(process.env, { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-tester-token', DONNA_DEFAULT_FIRM_ID: firmId,
    SUPABASE_URL: 'https://profile-record-auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', DONNA_AUTH_ALLOWED_EMAILS: '' });
  delete process.env.DONNA_DESKTOP_BLOB_DIR; delete process.env.STRIPE_SECRET_KEY;
  globalThis.fetch = async (address, init) => {
    assert.equal(address, 'https://profile-record-auth.invalid/auth/v1/user', 'no provider call in this proof');
    const who = { 'Bearer member': member, 'Bearer owner': owner }[init.headers.Authorization] || null;
    return new Response(JSON.stringify(who ? { id: who.userId, email: who.email } : {}), { status: who ? 200 : 401 });
  };
  const request = async (token, path, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    req.url = `/api/donna-router?path=${encodeURIComponent(`firms${path}`)}`;
    req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, setHeader() {}, end(value) { resolve({ status: this.statusCode, body: value ? JSON.parse(String(value)) : null }); } };
      Promise.resolve(donnaRouter(req, res)).catch(reject);
    });
  };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); realWarn(...args); };
  t.after(() => { console.warn = realWarn; });

  const { clientId } = await selfProvisionClientWorkspace({ auth: owner, companyName: 'Harmaa Kettle Works', jurisdiction: 'FI', entityType: 'fi-toiminimi' });
  const ownerPrincipalId = (await seed.query('select id from firm_collaborators where firm_id=$1 and user_id=$2', [firmId, owner.userId])).rows[0].id;
  const save = (token, profilePatch) => request(token, `/clients/${clientId}/profile`, { firm_id: firmId, profile_patch: profilePatch });
  const row = async () => (await seed.query('select company_name, legal_names, profile from clients where id=$1', [clientId])).rows[0];
  const audits = async () => (await seed.query(`select actor_type, actor_id, metadata from audit_events
    where client_id=$1 and action='client.profile.update' order by id`, [clientId])).rows;
  const born = await row();
  assert.deepEqual(born.legal_names, ['Harmaa Kettle Works'], 'born with the create derivation');

  // ── 1. A firm member renames the business ──────────────────────────────
  const renamed = await save('member', { companyName: 'Harmaa Kettle Works Tmi' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const [memberAudit] = (await audits()).slice(-1);
  assert.equal(memberAudit.actor_type, 'firm_member', 'the acting principal type, not "system"');
  assert.equal(memberAudit.actor_id, memberId);
  assert.deepEqual(memberAudit.metadata.keys, ['companyName']);
  assert.deepEqual(memberAudit.metadata.previous_values, { companyName: born.profile.companyName ?? null });
  assert.deepEqual((await row()).legal_names, ['Harmaa Kettle Works Tmi'], 'a rename reaches the router anchor');
  assert.deepEqual(memberAudit.metadata.legal_names, { before: ['Harmaa Kettle Works'], after: ['Harmaa Kettle Works Tmi'] });

  // ── 2/3. The owner confirms register details, exactly as the phone writes them
  const register = {
    business_id: '0000001-9', legal_form: 'sole_trader', legal_form_code: null, registered_address: '',
    source: 'owner', fetched_at: null, authority_verified: false,
    confirmed_by: ownerPrincipalId, confirmed_at: '2026-11-10T09:00:00.000Z', terminal: 'mobile'
  };
  const setup = { business_stage: null, suggestion_dismissed: false };
  warnings.length = 0;
  const confirmed = await save('owner', { businessId: '0000001-9', legalName: 'Harmaa Kettle Works Oy-to-be', business_register: register, business_setup: setup });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.deepEqual(warnings.filter((line) => line.includes('Unknown profile key')), [], 'the register keys are known keys');
  const [ownerAudit] = (await audits()).slice(-1);
  assert.equal(ownerAudit.actor_type, 'firm_collaborator', 'the business owner is named as such');
  assert.equal(ownerAudit.actor_id, ownerPrincipalId);
  assert.deepEqual(ownerAudit.metadata.previous_values, {}, 'none of these keys existed before');
  const afterConfirm = await row();
  assert.deepEqual(afterConfirm.profile.business_register, register);
  assert.deepEqual(afterConfirm.profile.business_setup, setup);
  assert.deepEqual(afterConfirm.legal_names, ['Harmaa Kettle Works Tmi', 'Harmaa Kettle Works Oy-to-be'], 'the confirmed legal name reaches legal_names');
  assert.deepEqual(afterConfirm.legal_names, deriveClientIdentityColumns(afterConfirm.profile).legalNames, 'one derivation');

  // A corrected legal name replaces the wrong one; the record can undo it.
  const corrected = await save('owner', { legalName: 'Harmaa Kettle Works Toiminimi' });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const [correctionAudit] = (await audits()).slice(-1);
  assert.deepEqual(correctionAudit.metadata.previous_values, { legalName: 'Harmaa Kettle Works Oy-to-be' });
  assert.deepEqual((await row()).legal_names, ['Harmaa Kettle Works Tmi', 'Harmaa Kettle Works Toiminimi']);
  assert.deepEqual(correctionAudit.metadata.legal_names.before, ['Harmaa Kettle Works Tmi', 'Harmaa Kettle Works Oy-to-be']);

  // A write that does not touch a name leaves legal_names alone and says nothing about it.
  const staged = await save('owner', { business_setup: { business_stage: 'existing', suggestion_dismissed: false } });
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  const [stageAudit] = (await audits()).slice(-1);
  assert.deepEqual(stageAudit.metadata.previous_values, { business_setup: setup });
  assert.equal(stageAudit.metadata.legal_names, undefined);

  // ── 3. Malformed register values are refused and write nothing ─────────
  const beforeRefusals = await row();
  const auditsBeforeRefusals = await audits();
  const malformed = [
    { legalName: '' }, { legalName: '   ' }, { legalName: 42 }, { legalName: 'x'.repeat(1001) },
    { business_register: { ...register, legal_form: 'oy' } },
    { business_register: { ...register, source: 'register_scrape' } },
    { business_register: { ...register, authority_verified: true } },
    { business_register: { ...register, confirmed_at: 'yesterday' } },
    { business_register: { ...register, surprise: 1 } },
    { business_register: (({ terminal, ...rest }) => rest)(register) },
    { business_register: [register] },
    { business_register: 'confirmed' },
    { business_setup: { business_stage: 'old', suggestion_dismissed: false } },
    { business_setup: { business_stage: 'new', suggestion_dismissed: 'yes' } },
    { business_setup: { business_stage: 'new', suggestion_dismissed: false, extra: true } }
  ];
  for (const patch of malformed) {
    const refused = await save('owner', patch);
    assert.equal(refused.status, 400, `${JSON.stringify(patch).slice(0, 120)} → ${JSON.stringify(refused.body)}`);
  }
  assert.deepEqual(await row(), beforeRefusals, 'no refusal changed the client');
  assert.deepEqual(await audits(), auditsBeforeRefusals, 'no refusal minted a receipt');

  // A clear is a value too: it is recorded with what it removed.
  const cleared = await save('member', { legalName: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const [clearAudit] = (await audits()).slice(-1);
  assert.equal(clearAudit.actor_type, 'firm_member');
  assert.deepEqual(clearAudit.metadata.previous_values, { legalName: 'Harmaa Kettle Works Toiminimi' });
  assert.deepEqual((await row()).legal_names, ['Harmaa Kettle Works Tmi']);
});
