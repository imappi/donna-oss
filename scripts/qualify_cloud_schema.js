#!/usr/bin/env node
// Operator-local qualification. Both databases are newly created and owned by
// this invocation. The hosted input contains schema only; never customer rows.
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { prepareCiHostPostgres } from './prepare_ci_host_postgres.js';
import { cloudSchemaCatalogDigest, compareCloudSchemaCatalogs, CLOUD_SCHEMA_QUALIFICATION_VERSION } from '../server/donna/cloudSchemaQualification.js';
import { hostDigest } from '../server/donna/hostCertificateA.js';
const qi = value => '"' + String(value).replaceAll('"', '""') + '"';
const qs = value => "'" + String(value).replaceAll("'", "''") + "'";
const root = new URL('../', import.meta.url);
export const readCloudSchemaCatalog = async client => (await client.query(await readFile(new URL('scripts/sql/cloud_schema_catalog.sql', root), 'utf8'))).rows[0].cloud_schema_catalog;
const objects = (c, kind) => c.objects.filter(o => o.kind === kind);

export const restoreCloudPublicCatalog = async (client, catalog) => {
  if (objects(catalog, 'relation').some(o => !['r', 'S', 'v'].includes(o.definition.kind))
    || objects(catalog, 'column').some(o => o.definition.generated)) throw new Error('Unsupported catalog shape; restore requires review.');
  if (objects(catalog, 'public_extension_member').length) throw new Error('Public extension membership requires review.');
  await client.query('set check_function_bodies = off');
  const identitySequences = new Set(objects(catalog, 'column').filter(o => o.definition.identity).map(o => o.name.replace('.', '_') + '_seq'));
  for (const o of objects(catalog, 'sequence')) {
    if (identitySequences.has(o.name)) continue;
    const d = o.definition;
    await client.query(`create sequence public.${qi(o.name)} as ${d.type} increment by ${d.increment} minvalue ${d.min} maxvalue ${d.max} start with ${d.start} cache ${d.cache} ${d.cycle ? '' : 'no '}cycle`);
  }
  for (const o of objects(catalog, 'enum')) await client.query(`create type public.${qi(o.name)} as enum (${o.definition.labels.map(qs).join(',')})`);
  for (const o of objects(catalog, 'domain')) throw new Error(`Domain restore needs explicit support: ${o.name}`);
  for (const o of objects(catalog, 'relation').filter(o => o.definition.kind === 'r')) {
    const columns = objects(catalog, 'column').filter(c => c.name.startsWith(o.name + '.')).sort((a,b) => a.definition.position-b.definition.position);
    const definitions = columns.map(c => {
      const d = c.definition, name = c.name.slice(o.name.length + 1);
      return `${qi(name)} ${d.type}${d.collation ? ` collate ${d.collation}` : ''}${d.identity ? ` generated ${d.identity === 'a' ? 'always' : 'by default'} as identity` : d.default ? ` default ${d.default}` : ''}${d.not_null ? ' not null' : ''}`;
    });
    await client.query(`create ${o.definition.persistence === 'u' ? 'unlogged ' : ''}table public.${qi(o.name)} (${definitions.join(',')})`);
    if (o.definition.options?.length) await client.query(`alter table public.${qi(o.name)} set (${o.definition.options.join(',')})`);
    if (o.definition.rls) await client.query(`alter table public.${qi(o.name)} enable row level security`);
    if (o.definition.force_rls) await client.query(`alter table public.${qi(o.name)} force row level security`);
  }
  for (const o of objects(catalog, 'function')) await client.query(o.definition.definition);
  // Keys before foreign keys; pg_get_constraintdef retains deferred/validation semantics.
  for (const o of objects(catalog, 'constraint').filter(o => o.definition.type !== 't').sort((a,b) => Number(a.definition.type === 'f')-Number(b.definition.type === 'f'))) {
    const [table, name] = o.name.split('.');
    await client.query(`alter table public.${qi(table)} add constraint ${qi(name)} ${o.definition.definition}`);
  }
  for (const o of objects(catalog, 'index')) {
    const name = o.name.split('.')[1];
    if (!(await client.query('select to_regclass($1) as name', [`public.${qi(name)}`])).rows[0].name) await client.query(o.definition.definition);
  }
  for (const o of objects(catalog, 'relation').filter(o => o.definition.kind === 'v')) {
    await client.query(`create view public.${qi(o.name)}${o.definition.options?.length ? ` with (${o.definition.options.join(',')})` : ''} as ${o.definition.view}`);
  }
  for (const o of objects(catalog, 'rule')) {
    await client.query(o.definition.definition);
    const [table, name] = o.name.split('.');
    if (o.definition.enabled !== 'O') await client.query(`alter table public.${qi(table)} ${o.definition.enabled === 'D' ? 'disable' : o.definition.enabled === 'A' ? 'enable always' : 'enable replica'} rule ${qi(name)}`);
  }
  for (const o of objects(catalog, 'trigger')) {
    await client.query(o.definition.definition);
    const [table, name] = o.name.split('.');
    if (o.definition.enabled !== 'O') await client.query(`alter table public.${qi(table)} ${o.definition.enabled === 'D' ? 'disable' : o.definition.enabled === 'A' ? 'enable always' : 'enable replica'} trigger ${qi(name)}`);
  }
  if (objects(catalog, 'policy').length) throw new Error('Policy restore needs explicit support.');
  for (const o of objects(catalog, 'event_trigger')) {
    const d = o.definition;
    await client.query(`create event trigger ${qi(o.name)} on ${d.event}${d.tags ? ` when tag in (${d.tags.map(qs).join(',')})` : ''} execute function ${d.function}`);
    if (d.enabled !== 'O') await client.query(`alter event trigger ${qi(o.name)} ${d.enabled === 'D' ? 'disable' : d.enabled === 'A' ? 'enable always' : 'enable replica'}`);
  }
  // Restore the separately qualified managed storage access posture too.
  for (const table of catalog.storage_security || []) {
    if (!['objects', 'buckets'].includes(table.name) || table.rls !== true || table.policies?.length) throw new Error('Unreviewed storage security posture.');
    await client.query(`alter table storage.${qi(table.name)} enable row level security`);
    if (table.force_rls) await client.query(`alter table storage.${qi(table.name)} force row level security`);
  }
  for (const migration of catalog.migrations) await client.query('insert into schema_migrations(version) values($1)', [migration]);
  for (const bucket of catalog.private_storage) await client.query('insert into storage.buckets(id,name,public) values($1,$1,$2)', [bucket.id,bucket.public]);
  await client.query('set check_function_bodies = on');
};

export const proveCloudSchemaInvariants = async client => {
  const results = [];
  const reject = async (name, sql, params, expectedCode) => {
    await client.query('savepoint invariant_probe');
    try { await client.query(sql, params); throw new Error(`Invariant accepted forbidden mutation: ${name}`); }
    catch (error) { if (error.code !== expectedCode) throw error; results.push({ name, expected_code: expectedCode, observed_code: error.code }); }
    finally { await client.query('rollback to savepoint invariant_probe'); }
  };
  await client.query('begin');
  try {
    // The same readiness receipt substrate used by real runtime producers.
    await client.query("insert into runtime_host_readiness_attempts(host_id,attempt_sequence,event_type,status,reason_code,certificate_version,compatibility_digest,receipt_digest,responsible_system,observed_at,certificate) values('schema-proof',1,'boot','INCOMPLETE','schema_proof','schema-proof','schema-proof','schema-proof','schema-qualifier',now(),'{}')");
    await reject('host_attempt_append_only', "delete from runtime_host_readiness_attempts where host_id='schema-proof'", [], '23001');
    await reject('host_attempt_unique_sequence', "insert into runtime_host_readiness_attempts select * from runtime_host_readiness_attempts where host_id='schema-proof'", [], '23505');
    await reject('client_orphan_refused', "insert into clients(id,firm_id,company_name,jurisdiction) values('schema-proof-client','schema-proof-missing-firm','Schema proof','FI')", [], '23503');
    await reject('invalid_capability_stage_refused', "insert into client_capability_config(id,firm_id,flag_key,stage,source) values('schema-proof','schema-proof','DOCUMENT_ROUTER_ENABLED','caller_pass','manual')", [], '23514');
    await client.query('rollback'); return results;
  } catch (error) { await client.query('rollback'); throw error; }
};

export const qualifyCloudSchema = async ({ catalogPath, adminUrl }) => {
  const url = new URL(adminUrl);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Qualification requires a local disposable PostgreSQL administrator.');
  const actual = JSON.parse(await readFile(catalogPath, 'utf8'));
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  await admin.connect();
  const created = [], clients = [];
  try {
    const identity = (await admin.query("select current_user as owner,current_setting('server_version_num')::int as version")).rows[0];
    if (Math.floor(identity.version / 10000) !== 17) throw new Error('Actual PostgreSQL 17 required.');
    for (const suffix of ['reference','restored']) {
      const name = `donna_cloud_${randomUUID().replaceAll('-','')}_${suffix}`;
      await admin.query(`create database ${qi(name)} template template0`); created.push(name);
      const target = new URL(adminUrl); target.pathname = '/' + name;
      await prepareCiHostPostgres({ databaseUrl: target.toString() });
      const c = new pg.Client({ connectionString: target.toString(), statement_timeout: 30000 }); await c.connect(); clients.push(c);
    }
    const [referenceClient, restoredClient] = clients;
    // Managed Supabase tables are represented by the existing local storage
    // fixture; bind its reviewed default-deny posture independently of app DDL.
    await referenceClient.query('alter table storage.objects enable row level security; alter table storage.buckets enable row level security');
    const dir = new URL('db/migrations/',root);
    for (const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) {
      await referenceClient.query(await readFile(new URL(file,dir),'utf8'));
      await referenceClient.query('insert into schema_migrations(version) values($1) on conflict do nothing',[file.slice(0,-4)]);
    }
    const reference = await readCloudSchemaCatalog(referenceClient);
    const comparison = compareCloudSchemaCatalogs({ actual, reference, referenceOwner: identity.owner });
    if (comparison.status !== 'PASS') return { version: CLOUD_SCHEMA_QUALIFICATION_VERSION, status: 'FAIL', comparison };
    await restoreCloudPublicCatalog(restoredClient, actual);
    const restored = await readCloudSchemaCatalog(restoredClient);
    if (hostDigest(actual.storage_security) !== hostDigest(restored.storage_security)) throw new Error('Restored storage access posture differs from hosted export.');
    // Restore assigns ownership to the isolated local role. Grants/extensions
    // remain the explicitly reviewed hosted infrastructure classifications above.
    const localActual = structuredClone(actual);
    localActual.objects = localActual.objects.filter(o=>!['grant','column_grant','function_grant','schema_grant','extension'].includes(o.kind));
    const localRestored = structuredClone(restored);
    localRestored.objects = localRestored.objects.filter(o=>!['grant','column_grant','function_grant','schema_grant','extension'].includes(o.kind));
    for (const o of localRestored.objects) if (['function','event_trigger'].includes(o.kind)) o.definition.owner = 'postgres';
    if (hostDigest(localActual.objects) !== hostDigest(localRestored.objects)) throw new Error('Restored physical catalog differs from exported hosted schema.');
    const referenceInvariants = await proveCloudSchemaInvariants(referenceClient);
    const restoredInvariants = await proveCloudSchemaInvariants(restoredClient);
    if (hostDigest(referenceInvariants) !== hostDigest(restoredInvariants)) throw new Error('Restored invariant behavior differs.');
    return { version: CLOUD_SCHEMA_QUALIFICATION_VERSION, status: 'PASS', catalog_digest: cloudSchemaCatalogDigest(actual),
      reference_catalog_digest: comparison.reference_catalog_digest, classification_digest: comparison.classification_digest,
      compared_objects: comparison.compared_objects, restored_catalog_digest: hostDigest(localRestored.objects), invariants: restoredInvariants };
  } finally {
    for (const c of clients) await c.end();
    for (const name of created.reverse()) await admin.query(`drop database ${qi(name)}`);
    await admin.end();
  }
};
