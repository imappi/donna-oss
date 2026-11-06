import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';

const migrationRoot = new URL('../../db/migrations/', import.meta.url);
const repairName = '153_inventory_posting_heads_browser_grants.sql';
const observedSequenceNames = [
  'convergence_marks_id_seq', 'inventory_allocations_id_seq', 'inventory_anomalies_id_seq',
  'inventory_backorders_id_seq', 'inventory_command_receipts_id_seq', 'inventory_count_lines_id_seq',
  'inventory_count_sessions_id_seq', 'inventory_journal_allocations_id_seq', 'inventory_operations_id_seq',
  'inventory_posting_attempts_id_seq', 'inventory_posting_incidents_id_seq', 'inventory_posting_journals_id_seq',
  'inventory_purchase_order_lines_id_seq', 'inventory_purchase_orders_id_seq', 'inventory_reservations_id_seq',
  'inventory_sales_order_lines_id_seq', 'inventory_sales_orders_id_seq', 'inventory_supplier_acknowledgements_id_seq',
  'inventory_valuation_allowances_id_seq', 'local_jobs_id_seq', 'memory_candidate_events_id_seq',
  'memory_dependencies_id_seq', 'memory_evidence_links_id_seq', 'runtime_host_readiness_attempts_id_seq',
  'statutory_blocker_events_id_seq'
];

// Roles are cluster-global. Never create/drop/alter Supabase role names on the
// caller's DONNA_PG_TEST_URL server, even when using a disposable database there.
// This test owns a separate cluster, including every role and every test row.
function postgresBin() {
  const configured = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  const candidates = [configured.status === 0 && configured.stdout.trim(),
    '/usr/lib/postgresql/16/bin', '/opt/homebrew/opt/postgresql@16/bin'];
  const found = candidates.find((dir) => dir && ['initdb', 'pg_ctl', 'postgres'].every((name) => existsSync(path.join(dir, name))));
  assert.ok(found, 'INCOMPLETE: PostgreSQL server binaries required for the isolated role-security proof');
  return found;
}

function command(bin, name, args) {
  const result = spawnSync(path.join(bin, name), args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr || result.stdout}`);
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('posting-heads migration closes browser grants while preserving the real server projection', async (t) => {
  const bin = postgresBin();
  const directory = await mkdtemp(path.join(tmpdir(), 'donna-view-'));
  const data = path.join(directory, 'pg');
  let started = false;
  let client;
  t.after(async () => {
    try { if (client) await client.end(); }
    finally {
      try { if (started) command(bin, 'pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
  command(bin, 'initdb', ['-D', data, '--username=donna_view_owner', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  const port = await unusedPort();
  command(bin, 'pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k '' -F`, '-w', 'start']);
  started = true;
  client = new pg.Client({ host: '127.0.0.1', port, user: 'donna_view_owner', database: 'postgres' });
  await client.connect();
  await client.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  for (const file of (await readdir(migrationRoot)).filter((name) => name.endsWith('.sql')).sort()) {
    await client.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const repair = await readFile(new URL(repairName, migrationRoot), 'utf8');
  const sequenceRepair = await readFile(new URL('154_authored_sequence_browser_grants.sql', migrationRoot), 'utf8');
  assert.deepEqual((await client.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')")).rows, []);
  await client.query(repair); // missing roles and repeated migration both work
  await client.query(sequenceRepair);
  await client.query(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    grant all on public.inventory_posting_heads to anon, authenticated;
    grant select on public.inventory_posting_heads to public, service_role;
    alter table public.inventory_posting_attempts enable row level security;
    revoke all on public.inventory_posting_attempts from anon, authenticated, public;
    insert into firms(id,name,slug) values('view-proof-firm','Synthetic view proof','view-proof-firm');
    insert into clients(id,firm_id,company_name,jurisdiction,entity_type)
      values('view-proof-client','view-proof-firm','Synthetic Oy','fi','fi-oy');
    insert into inventory_posting_attempts(firm_id,client_id,operation_id,posting_kind,valuation_run_id,outcome,actor_id)
      values('view-proof-firm','view-proof-client','synthetic-op','value_neutral','synthetic-run','no_journal_required','synthetic-owner')`);

  const readHeads = async (role) => {
    await client.query(`set role ${role}`);
    try { return (await client.query('select operation_id, outcome from public.inventory_posting_heads')).rows; }
    finally { await client.query('reset role'); }
  };
  const expected = [{ operation_id: 'synthetic-op', outcome: 'no_journal_required' }];
  for (const role of ['anon', 'authenticated']) {
    assert.deepEqual(await readHeads(role), expected, `${role}: reproduces the definer-view bypass before repair`);
  }
  const before = (await client.query("select relowner, pg_get_viewdef(oid) as definition from pg_class where oid='public.inventory_posting_heads'::regclass")).rows[0];
  const triggersBefore = (await client.query('select evtname, evtenabled, evtfoid from pg_event_trigger order by evtname')).rows;
  await client.query(repair);
  await client.query(repair);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(readHeads(role), { code: '42501' }, `${role}: actual SELECT denied`);
    const privileges = (await client.query(`select privilege from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
      where has_table_privilege($1,'public.inventory_posting_heads',privilege)`, [role])).rows;
    assert.deepEqual(privileges, [], `${role}: all table privileges removed, including inherited PUBLIC SELECT`);
  }
  assert.deepEqual(await readHeads('service_role'), expected, 'existing explicit server-role grant is retained');
  assert.deepEqual(await readHeads('donna_view_owner'), expected, 'owner still reads the projection');
  assert.deepEqual((await client.query("select relowner, pg_get_viewdef(oid) as definition from pg_class where oid='public.inventory_posting_heads'::regclass")).rows[0], before);
  assert.deepEqual((await client.query('select evtname, evtenabled, evtfoid from pg_event_trigger order by evtname')).rows, triggersBefore);
  assert.deepEqual((await client.query("select relrowsecurity, relforcerowsecurity from pg_class where oid='public.inventory_posting_attempts'::regclass")).rows,
    [{ relrowsecurity: true, relforcerowsecurity: false }]);
  assert.equal((await client.query("select count(*)::int as n from pg_policies where schemaname='public' and tablename='inventory_posting_attempts'")).rows[0].n, 0);

  await t.test('all 25 observed authored sequences deny browser reads and counter mutations, preserving server grants and values', async () => {
    // Independent fixture inventory from the hosted observation. Migration
    // 001's audit sequence was already closed; later or external sequences
    // must not be swept up by this bounded repair.
    const sequences = (await client.query(`select c.relname as name, c.relowner, d.refobjid, d.refobjsubid, d.deptype
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_depend d on d.objid=c.oid and d.classid='pg_class'::regclass and d.deptype in ('a','i')
      where c.relkind='S' and n.nspname='public' and c.relname=any($1::text[]) order by c.relname`, [observedSequenceNames])).rows;
    assert.equal(sequences.length, 25, 'observed migration-owned sequence inventory');
    await client.query(`create sequence public.unrelated_browser_grant_proof;
      grant all on all sequences in schema public to anon, authenticated, service_role;
      grant select, usage, update on all sequences in schema public to public`);
    const asRole = async (role, sql, parameters = []) => {
      await client.query(`set role ${role}`);
      try { return (await client.query(sql, parameters)).rows; }
      finally { await client.query('reset role'); }
    };
    for (const { name } of sequences) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await asRole(role, 'select setval($1::regclass,100,false) as value', [`public.${name}`]))[0].value, '100');
        assert.equal((await asRole(role, 'select nextval($1::regclass) as value', [`public.${name}`]))[0].value, '100');
        assert.equal((await asRole(role, `select last_value from public.${name}`))[0].last_value, '100');
      }
    }
    const beforeSequenceValues = [];
    for (const { name } of sequences) beforeSequenceValues.push((await client.query(`select last_value,is_called from public.${name}`)).rows);
    const serverGrantsBefore = (await client.query(`select c.relname, a.privilege_type, a.is_grantable from pg_class c
      cross join lateral aclexplode(c.relacl) a where c.relnamespace='public'::regnamespace and c.relkind='S'
      and a.grantee='service_role'::regrole order by 1,2`)).rows;
    await client.query(sequenceRepair);
    await client.query(sequenceRepair);
    for (const [index, { name }] of sequences.entries()) {
      assert.deepEqual((await client.query(`select last_value,is_called from public.${name}`)).rows, beforeSequenceValues[index], `${name}: no sequence reset`);
      for (const role of ['anon', 'authenticated']) {
        await assert.rejects(asRole(role, 'select nextval($1::regclass)', [`public.${name}`]), { code: '42501' });
        await assert.rejects(asRole(role, 'select setval($1::regclass,999,false)', [`public.${name}`]), { code: '42501' });
        await assert.rejects(asRole(role, `select last_value from public.${name}`), { code: '42501' });
      }
      for (const role of ['service_role', 'donna_view_owner']) {
        assert.equal((await asRole(role, 'select setval($1::regclass,120,false) as value', [`public.${name}`]))[0].value, '120');
        assert.equal((await asRole(role, 'select nextval($1::regclass) as value', [`public.${name}`]))[0].value, '120');
        assert.equal((await asRole(role, `select last_value from public.${name}`))[0].last_value, '120');
      }
    }
    assert.deepEqual((await client.query(`select c.relname as name, c.relowner, d.refobjid, d.refobjsubid, d.deptype
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_depend d on d.objid=c.oid and d.classid='pg_class'::regclass and d.deptype in ('a','i')
      where c.relkind='S' and n.nspname='public' and c.relname=any($1::text[]) order by c.relname`, [observedSequenceNames])).rows, sequences);
    assert.deepEqual((await client.query(`select c.relname, a.privilege_type, a.is_grantable from pg_class c
      cross join lateral aclexplode(c.relacl) a where c.relnamespace='public'::regnamespace and c.relkind='S'
      and a.grantee='service_role'::regrole order by 1,2`)).rows, serverGrantsBefore);
    assert.equal((await asRole('anon', "select nextval('public.unrelated_browser_grant_proof') as value"))[0].value, '1', 'unrelated sequence grant was not changed');
  });
});
