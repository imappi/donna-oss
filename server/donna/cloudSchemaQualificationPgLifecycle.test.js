import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { prepareCiHostPostgres } from '../../scripts/prepare_ci_host_postgres.js';
import { readCloudSchemaCatalog, restoreCloudPublicCatalog, proveCloudSchemaInvariants, qualifyCloudSchema } from '../../scripts/qualify_cloud_schema.js';
import { readAttestationSourceIdentity } from '../../scripts/attest_cloud_deployment.js';
import { cloudSchemaCatalogDigest, compareCloudSchemaCatalogs } from './cloudSchemaQualification.js';
import { hostDigest } from './hostCertificateA.js';

const qi = s => '"' + String(s).replaceAll('"', '""') + '"';
const pgUrl = process.env.DONNA_SCHEMA_PROOF_PG17_URL || process.env.DONNA_PG_TEST_URL;
const migrations = new URL('../../db/migrations/', import.meta.url);
const migrate = async c => {
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await c.query(await readFile(new URL(file, migrations), 'utf8'));
    await c.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
};

test('attestation source identity follows its module checkout, never an unrelated caller checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'donna-source-cwd-'));
  const oldCwd = process.cwd();
  try {
    execFileSync('git', ['init', '-q', directory]);
    execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'Unrelated source fixture']);
    const unrelated = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const expected = await readAttestationSourceIdentity();
    process.chdir(directory);
    assert.deepEqual(await readAttestationSourceIdentity(), expected);
    assert.notEqual(expected.head, unrelated);
  } finally { process.chdir(oldCwd); await rm(directory, { recursive: true, force: true }); }
});

test('real PostgreSQL exported schema rejects access/rule/extension mutants and restores the clean baseline', {
  skip: !pgUrl && 'INCOMPLETE: a disposable local PostgreSQL URL is required', timeout: 180000
}, async t => {
  const address = new URL(pgUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname), 'local disposable host only');
  const admin = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const identity = (await admin.query("select current_user as owner,current_setting('server_version_num')::int as version")).rows[0];
  const major = Math.floor(identity.version / 10000);
  assert.ok([16, 17].includes(major), 'pinned desktop or cloud PostgreSQL only');
  const names = [], clients = [];
  const directory = await mkdtemp(join(tmpdir(), 'donna-schema-proof-'));
  t.after(async () => {
    for (const c of clients) { await c.query('rollback'); await c.end(); }
    for (const name of names.reverse()) await admin.query(`drop database ${qi(name)}`);
    await admin.end(); await rm(directory, { recursive: true, force: true });
  });
  const create = async suffix => {
    const name = `donna_schema_${randomUUID().replaceAll('-', '')}_${suffix}`;
    await admin.query(`create database ${qi(name)} template template0`); names.push(name);
    const url = new URL(pgUrl); url.pathname = '/' + name;
    await prepareCiHostPostgres({ databaseUrl: url.toString() });
    const c = new pg.Client({ connectionString: url.toString(), statement_timeout: 30000 });
    await c.connect(); clients.push(c); return c;
  };
  const referenceClient = await create('reference');
  await migrate(referenceClient);
  const reference = await readCloudSchemaCatalog(referenceClient);
  const actualClient = await create('export');
  // Role and membership DDL is transaction scoped. Even a failed assertion leaves
  // no cluster-wide roles/grants behind and cannot alter another proof's roles.
  await actualClient.query('begin');
  await actualClient.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='postgres') then create role postgres superuser nologin; end if;
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  end $$; set local role postgres`);
  await migrate(actualClient);
  await actualClient.query(`alter table storage.objects enable row level security;
    alter table storage.buckets enable row level security;
    grant usage on schema storage to anon, authenticated;
    grant select, insert, update, delete on storage.objects, storage.buckets to anon, authenticated;
    insert into storage.objects(bucket_id,name) values('donna-evidence','synthetic-proof.txt')`);
  for (const role of ['anon', 'authenticated']) {
    try {
      await actualClient.query(`set local role ${role}`);
      for (const table of ['objects', 'buckets']) assert.equal(Number((await actualClient.query(`select count(*) n from storage.${table}`)).rows[0].n), 0, 'default-deny hides synthetic private rows despite broad table grants');
    } finally { await actualClient.query('set local role postgres'); }
  }
  const baseline = await readCloudSchemaCatalog(actualClient);
  const compare = actual => compareCloudSchemaCatalogs({ actual, reference, referenceOwner: identity.owner });
  const clean = compare(baseline);
  assert.deepEqual(clean.failures, major === 17 ? [] : [
    { code: 'PG17_CATALOG_REQUIRED', object: 'actual' }, { code: 'PG17_CATALOG_REQUIRED', object: 'reference' }
  ], JSON.stringify(clean.failures));
  const baselineDigest = cloudSchemaCatalogDigest(baseline);
  const check = async (name, mutation, code, checkEffect) => {
    await t.test(name, async () => {
      await actualClient.query('savepoint schema_mutant');
      try {
        await actualClient.query(mutation);
        if (checkEffect) await checkEffect(actualClient);
        const exported = await readCloudSchemaCatalog(actualClient);
        assert.notEqual(cloudSchemaCatalogDigest(exported), baselineDigest, 'real exported catalog observes mutation');
        const result = compare(exported);
        assert.equal(result.status, 'FAIL');
        assert.ok(result.failures.some(f => f.code === code), JSON.stringify(result.failures));
      } finally { await actualClient.query('rollback to savepoint schema_mutant'); }
      assert.equal(cloudSchemaCatalogDigest(await readCloudSchemaCatalog(actualClient)), baselineDigest, 'rollback restores exact baseline');
    });
  };
  await check('column SELECT cannot hide behind revoked table ACLs',
    'grant select (payload) on public.transactions to authenticated', 'BROWSER_COLUMN_PRIVILEGE', async c => {
      const result = (await c.query("select has_column_privilege('authenticated','public.transactions','payload','SELECT') as column_allowed,has_table_privilege('authenticated','public.transactions','SELECT') as table_allowed")).rows[0];
      assert.equal(result.column_allowed, true); assert.equal(result.table_allowed, false);
    });
  await check('column UPDATE cannot hide behind revoked table ACLs',
    'grant update (payload) on public.transactions to anon', 'BROWSER_COLUMN_PRIVILEGE');
  for (const role of ['pg_read_all_data', 'pg_write_all_data']) {
    await check(`inherited ${role} is effective access, not a harmless role`,
      `grant ${role} to authenticated`, 'BROWSER_ROLE_ISOLATION_REQUIRED', async c => {
        const privilege = role === 'pg_read_all_data' ? 'SELECT' : 'UPDATE';
        assert.equal((await c.query("select has_table_privilege('authenticated','public.transactions',$1) as allowed", [privilege])).rows[0].allowed, true);
      });
  }
  await check('rewrite rule cannot disappear from physical parity',
    'create rule schema_mutant_delete as on delete to public.firms do instead nothing', 'PHYSICAL_SCHEMA_MISMATCH', async c => {
      assert.equal((await c.query("select count(*)::int n from pg_rewrite where rulename='schema_mutant_delete'")).rows[0].n, 1);
    });
  await check('extension attachment cannot hide a public security definer',
    `create function public.schema_mutant_extension() returns integer language sql security definer as 'select 1';
     alter extension plpgsql add function public.schema_mutant_extension()`, 'UNREVIEWED_PUBLIC_EXTENSION_MEMBER');
  await check('ordinary public function body remains exact',
    `create function public.schema_mutant_function() returns integer language sql as 'select 1'`, 'PHYSICAL_SCHEMA_MISMATCH');
  await check('ordinary browser table grants remain rejected',
    'grant select on public.transactions to anon', 'BROWSER_SCHEMA_OR_RELATION_PRIVILEGE');

  for (const table of ['objects', 'buckets']) {
    await check(`private storage ${table} rejects disabled RLS`,
      `alter table storage.${table} disable row level security`, 'PRIVATE_STORAGE_DEFAULT_DENY_REQUIRED');
    await check(`private storage ${table} rejects anonymous read policy`,
      `create policy schema_mutant_read on storage.${table} for select to anon using (true)`, 'PRIVATE_STORAGE_DEFAULT_DENY_REQUIRED', async c => {
        try {
          await c.query('set local role anon');
          assert.ok(Number((await c.query(`select count(*) n from storage.${table}`)).rows[0].n) > 0, 'real browser role can read the synthetic private row');
        } finally { await c.query('set local role postgres'); }
      });
  }
  await check('private storage rejects authenticated write policy',
    'create policy schema_mutant_write on storage.objects for insert to authenticated with check (true)', 'PRIVATE_STORAGE_DEFAULT_DENY_REQUIRED', async c => {
      try {
        await c.query('set local role authenticated');
        await c.query("insert into storage.objects(bucket_id,name) values('donna-evidence','synthetic-policy-write.txt')");
      } finally { await c.query('set local role postgres'); }
      assert.equal(Number((await c.query("select count(*) n from storage.objects where name='synthetic-policy-write.txt'")).rows[0].n), 1);
    });

  const restoredClient = await create('restored');
  await restoreCloudPublicCatalog(restoredClient, baseline);
  assert.deepEqual((await readCloudSchemaCatalog(restoredClient)).storage_security, baseline.storage_security);
  const physical = catalog => catalog.objects.filter(o => !['grant', 'column_grant', 'function_grant', 'schema_grant', 'extension'].includes(o.kind)).map(o => {
    const value = structuredClone(o);
    if (['function', 'event_trigger'].includes(value.kind)) value.definition.owner = 'postgres';
    return value;
  });
  assert.equal(hostDigest(physical(await readCloudSchemaCatalog(restoredClient))), hostDigest(physical(baseline)), 'restored authored definitions equal the exported baseline');
  assert.deepEqual(await proveCloudSchemaInvariants(restoredClient), await proveCloudSchemaInvariants(referenceClient));
  const catalogPath = join(directory, 'synthetic-hosted-export.json');
  await writeFile(catalogPath, JSON.stringify(baseline));
  if (major === 17) {
    const receipt = await qualifyCloudSchema({ catalogPath, adminUrl: pgUrl });
    assert.equal(receipt.status, 'PASS', JSON.stringify(receipt));
    assert.equal(receipt.catalog_digest, baselineDigest);
    assert.equal(receipt.invariants.length, 4);
    t.diagnostic('Actual PostgreSQL 17 full qualifier PASS: fresh migrations, exported restore, exact physical parity, four invariant gates.');
  } else {
    await assert.rejects(qualifyCloudSchema({ catalogPath, adminUrl: pgUrl }), /Actual PostgreSQL 17 required/);
    t.diagnostic('PostgreSQL 16 export/restore/mutant proof PASS; cloud qualification correctly refuses PostgreSQL 16. No PG17 compatibility claimed by this run.');
  }
});
