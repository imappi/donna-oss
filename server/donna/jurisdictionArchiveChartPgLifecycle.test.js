import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import {
  __setFirmDbPoolForTests, __resetFirmDbPoolForTests, createClientInDb,
  updateClientProfileInDb, withFirmDbClient, seedPackPaletteChartWithClient,
  createCloseArchiveInDb, getCloseArchiveExportFromDb
} from './firmDb.js';
import { backfillDesktopRuntimePlane, seedDesktopClientPlaneRowsWithClient } from './desktop/hostPlaneSeed.js';
import { fallbackAccountsForPack, loadOutboundPack } from './outbound/packs.js';
import { buildCloseArchivePackage, sha256Object } from './closeArchive.js';

const firmId = 'country-artifact-fixture';
const actorId = 'country-artifact-owner';
const countries = [['fi', 'fi-toiminimi'], ['gb', 'gb-ltd'], ['sg', 'sg-pte'],
  ['ae', 'ae-llc'], ['us', 'us-llc'], ['au', 'au-pty-ltd']];

test('physical charts and new archive evidence require canonical country through PostgreSQL callers', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL not set — country artifact proof INCOMPLETE'
}, async t => {
  const database = `donna_country_artifact_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const ended = [];
  pool.on('connect', client => ended.push(new Promise(resolve => client.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const previousDesktopDir = process.env.DONNA_DESKTOP_BLOB_DIR;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No provider request is authorized by this offline fixture'); });
  t.after(async () => {
    if (previousDesktopDir === undefined) delete process.env.DONNA_DESKTOP_BLOB_DIR;
    else process.env.DONNA_DESKTOP_BLOB_DIR = previousDesktopDir;
    __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(ended);
    await admin.query(`drop database "${database}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  await pool.query("insert into firms(id,name,slug) values($1,'Country artifact fixture','country-artifact-fixture')", [firmId]);
  const accounts = async clientId => (await pool.query('select * from ledger_accounts where firm_id=$1 and client_id=$2 order by id', [firmId, clientId])).rows;
  const seedReceipts = async clientId => (await pool.query("select * from audit_events where firm_id=$1 and client_id=$2 and action='ledger.chart.palette_seeded' order by id", [firmId, clientId])).rows;
  const legacy = async (id, jurisdiction, profile = {}, entityType = null) => pool.query(
    'insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,$1,$3,$4,$5::jsonb)',
    [id, firmId, jurisdiction, entityType, JSON.stringify({ accounting_system: 'none', ...profile })]);
  const archiveArgs = clientId => ({ firmId, clientId, periodStart: '2026-01-01', periodEnd: '2026-01-31', actorId });
  const archiveRows = async clientId => (await pool.query('select * from close_archives where firm_id=$1 and client_id=$2 order by id', [firmId, clientId])).rows;

  await t.test('desktop create seeds explicit AE, remains idempotent and leaves unknown identity unseeded', async () => {
    process.env.DONNA_DESKTOP_BLOB_DIR = '/offline-country-artifact-fixture';
    const profile = { id: 'created-ae', companyName: 'Created AE', jurisdiction: 'ae', entityType: 'ae-llc' };
    const create = profile => createClientInDb({ firmId, profile,
      creationPrincipal: { principalId: actorId, principalType: 'owner', authoritySource: 'fixture_owner' } });
    await create(profile);
    const chart = await accounts(profile.id);
    assert.equal(chart.length, fallbackAccountsForPack(loadOutboundPack('ae')).length);
    assert.ok(chart.every(row => row.payload.palette_pack_id === 'ae'));
    const receipts = await seedReceipts(profile.id); assert.equal(receipts.length, 1);
    await create(profile);
    assert.deepEqual(await accounts(profile.id), chart);
    assert.deepEqual(await seedReceipts(profile.id), receipts);
    await create({ id: 'created-unknown', companyName: 'Unknown country' });
    assert.deepEqual(await accounts('created-unknown'), []);
    assert.deepEqual(await seedReceipts('created-unknown'), []);
    delete process.env.DONNA_DESKTOP_BLOB_DIR;
  });

  await t.test('desktop boot uses the named seed and never revives stale profile or foreign legal form', async () => {
    await legacy('boot-null', null, { jurisdiction: 'ae' });
    await legacy('boot-conflict', 'US', { jurisdiction: 'ae' });
    await legacy('boot-form-conflict', 'AE', {}, 'us-llc');
    await legacy('boot-healthy', 'AE', {}, 'ae-llc');
    const runBootBackfill = () => backfillDesktopRuntimePlane({ withFirmDbClientFn: withFirmDbClient,
      seedChartFn: seedPackPaletteChartWithClient, logger: { log() {} } });
    const result = await runBootBackfill();
    const chart = await accounts('boot-healthy');
    assert.equal(chart.length, fallbackAccountsForPack(loadOutboundPack('ae')).length);
    assert.equal(result.chartAccounts, chart.length);
    for (const id of ['boot-null', 'boot-conflict', 'boot-form-conflict', 'created-unknown']) {
      assert.deepEqual(await accounts(id), [], id);
      assert.deepEqual(await seedReceipts(id), [], id);
    }
    const receipts = await seedReceipts('boot-healthy'); assert.equal(receipts.length, 1);
    assert.equal((await runBootBackfill()).chartAccounts, 0);
    assert.deepEqual(await accounts('boot-healthy'), chart);
    assert.deepEqual(await seedReceipts('boot-healthy'), receipts);
    // Preserve the actual runtime boot composition, as well as executing its
    // transaction owner with the real named writer above.
    const runtime = await readFile(new URL('./desktop/runtimeServer.js', import.meta.url), 'utf8');
    assert.match(runtime, /backfillDesktopRuntimePlane\(\{\s*withFirmDbClientFn: withFirmDbClient,\s*logger,\s*seedChartFn: seedPackPaletteChartWithClient/);
  });

  await t.test('boot aborts a contended country without lock inversion and retries the committed identity', async () => {
    const clientId = 'boot-contended';
    const controlId = 'boot-rollback-flags';
    await legacy(clientId, 'AE', {}, 'ae-llc');
    // Existing plane rows avoid making the later identity writer wait at an
    // unrelated flag-insert foreign key before the guarded chart boundary.
    await withFirmDbClient(async client => {
      await client.query('begin');
      await seedDesktopClientPlaneRowsWithClient(client, { firmId, clientId });
      await client.query('commit');
    });
    await legacy(controlId, null);
    const updater = await pool.connect();
    const pid = (await updater.query('select pg_backend_pid() as pid')).rows[0].pid;
    const beforeReadiness = (await pool.query('select * from entity_readiness_sagas order by saga_id')).rows;
    let update;
    let sawFlagWrites = false;
    try {
      await assert.rejects(backfillDesktopRuntimePlane({ withFirmDbClientFn: withFirmDbClient,
        logger: { log() {} }, seedChartFn: async (client, args) => {
          if (args.clientId === clientId) {
            await seedDesktopClientPlaneRowsWithClient(client, { firmId, clientId: controlId });
            sawFlagWrites = (await client.query('select 1 from client_capability_config where client_id=$1', [controlId])).rows.length > 0;
            // Reproduce the existing readiness-key -> client-row ordering.
            await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`entity-readiness:${firmId}:${clientId}`]);
            update = updateClientProfileInDb({ firmId, clientId, actorId, dbClient: updater,
              profilePatch: { jurisdiction: 'us', entity_type: 'us-llc' } });
            let waiting = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              waiting = (await pool.query("select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted", [pid])).rows.length > 0;
              if (waiting) break;
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true, 'the real profile writer holds identity and waits for the seed readiness key');
          }
          return seedPackPaletteChartWithClient(client, args);
        }
      }), { code: '55P03' });
      await update;
    } finally {
      if (update) await update;
      updater.release();
    }
    assert.equal(sawFlagWrites, true);
    assert.deepEqual((await pool.query('select * from client_capability_config where client_id=$1', [controlId])).rows, []);
    assert.deepEqual(await accounts(clientId), []);
    assert.deepEqual(await seedReceipts(clientId), []);
    assert.deepEqual((await pool.query('select * from entity_readiness_sagas order by saga_id')).rows, beforeReadiness);
    await backfillDesktopRuntimePlane({ withFirmDbClientFn: withFirmDbClient,
      seedChartFn: seedPackPaletteChartWithClient, logger: { log() {} } });
    const chart = await accounts(clientId);
    assert.equal(chart.length, fallbackAccountsForPack(loadOutboundPack('us')).length);
    assert.ok(chart.every(row => row.payload.palette_pack_id === 'us'));
    assert.equal((await seedReceipts(clientId)).length, 1);
  });

  await t.test('all six canonical-only countries survive persisted archive creation and export checksums', async () => {
    for (const [country, entityType] of countries) {
      const clientId = `archive-${country}`;
      await legacy(clientId, country.toUpperCase(), {}, entityType);
      const { close_archive: archive } = await createCloseArchiveInDb(archiveArgs(clientId));
      const [stored] = await archiveRows(clientId);
      assert.equal(stored.payload.sections.entity.jurisdiction, country.toUpperCase());
      const bundle = await getCloseArchiveExportFromDb({ firmId, clientId, archiveId: archive.archive_id, actorId });
      assert.equal(bundle.files['entity.json'].jurisdiction, country.toUpperCase());
      assert.equal(bundle.manifest_checksum_sha256, stored.manifest_checksum);
      assert.equal(bundle.files['manifest.json'].files.find(file => file.path === 'entity.json').checksum_sha256,
        sha256Object(bundle.files['entity.json']));
      assert.equal(bundle.bundle_checksum_sha256, sha256Object(bundle.files));
    }
  });

  await t.test('missing and conflicting country refuse new create/export; named profile repair recovers', async () => {
    for (const [clientId, jurisdiction, profile, entityType] of [
      ['archive-null', null, { jurisdiction: 'ae', country: 'SG' }, null],
      ['archive-conflict', 'GB', { jurisdiction: 'ae' }, null],
      ['archive-form-conflict', 'GB', {}, 'ae-llc']
    ]) {
      await legacy(clientId, jurisdiction, profile, entityType);
      for (const call of [createCloseArchiveInDb, getCloseArchiveExportFromDb]) {
        await assert.rejects(call(archiveArgs(clientId)), { code: 'CLOSE_ARCHIVE_JURISDICTION_REQUIRED', statusCode: 409 });
      }
      assert.deepEqual(await archiveRows(clientId), []);
      assert.deepEqual((await pool.query("select * from audit_events where client_id=$1 and action='close.archive_generated'", [clientId])).rows, []);
      await updateClientProfileInDb({ firmId, clientId, actorId, profilePatch: { jurisdiction: 'gb', entity_type: 'gb-ltd' } });
      await createCloseArchiveInDb(archiveArgs(clientId));
      assert.equal((await archiveRows(clientId))[0].payload.sections.entity.jurisdiction, 'GB');
    }
  });

  await t.test('retained archive sections and checksums remain original after current country is cleared or changed', async () => {
    const clientId = 'archive-gb';
    const [before] = await archiveRows(clientId);
    for (const jurisdiction of [null, 'ae']) {
      await updateClientProfileInDb({ firmId, clientId, actorId, profilePatch: { jurisdiction, entity_type: jurisdiction ? 'ae-llc' : null } });
      const bundle = await getCloseArchiveExportFromDb({ firmId, clientId, archiveId: before.id, actorId });
      const [after] = await archiveRows(clientId);
      assert.equal(bundle.files['entity.json'].jurisdiction, 'GB');
      assert.deepEqual(after.payload.sections, before.payload.sections);
      assert.deepEqual(after.manifest, before.manifest);
      assert.equal(after.manifest_checksum, before.manifest_checksum);
    }
  });

  await t.test('regeneration retains a historical wrong-country package under its original identity', async () => {
    const clientId = 'archive-historical-wrong';
    await legacy(clientId, 'GB', {}, 'gb-ltd');
    // Historical fixture models the old builder's SG fallback. Repair means a
    // separately identified generated package, never an in-place rewrite.
    const original = buildCloseArchivePackage({ ...archiveArgs(clientId),
      client: { id: clientId, jurisdiction: 'SG' }, generatedAt: '2026-09-01T00:00:00.000Z', generatedBy: actorId });
    await pool.query(`insert into close_archives(id,firm_id,client_id,period_start,period_end,status,schema_version,
      manifest_checksum,manifest,generated_by,generated_at,payload)
      values($1,$2,$3,$4,$5,'generated',$6,$7,$8::jsonb,$9,$10,$11::jsonb)`,
    [original.archive_id, firmId, clientId, original.period_start, original.period_end, original.schema_version,
      original.manifest_checksum_sha256, JSON.stringify(original.manifest), actorId, original.generated_at,
      JSON.stringify({ sections: original.sections })]);
    const { close_archive: corrected } = await createCloseArchiveInDb(archiveArgs(clientId));
    assert.notEqual(corrected.archive_id, original.archive_id);
    assert.equal(corrected.sections.entity.jurisdiction, 'GB');
    const historical = await getCloseArchiveExportFromDb({ firmId, clientId, archiveId: original.archive_id, actorId });
    assert.equal(historical.files['entity.json'].jurisdiction, 'SG');
    assert.equal(historical.manifest_checksum_sha256, original.manifest_checksum_sha256);
    const rows = await archiveRows(clientId); assert.equal(rows.length, 2);
    const retained = rows.find(row => row.id === original.archive_id);
    assert.deepEqual(retained.payload.sections, original.sections);
    assert.deepEqual(retained.manifest, original.manifest);
  });

  await t.test('a committed profile repair between preview and persistence refuses the stale archive', async () => {
    const clientId = 'archive-race';
    await legacy(clientId, 'GB', {}, 'gb-ltd');
    let repaired = false;
    __setFirmDbPoolForTests({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const originalQuery = client.query;
        const originalRelease = client.release;
        const query = originalQuery.bind(client);
        client.query = async (sql, params) => {
          if (!repaired && String(sql).includes('select jurisdiction, entity_type, profile from clients') && String(sql).includes('for share')) {
            repaired = true;
            await updateClientProfileInDb({ firmId, clientId, actorId,
              profilePatch: { jurisdiction: 'ae', entity_type: 'ae-llc' } });
          }
          return query(sql, params);
        };
        client.release = (...args) => {
          client.query = originalQuery;
          client.release = originalRelease;
          return originalRelease.apply(client, args);
        };
        return client;
      }
    });
    try {
      await assert.rejects(createCloseArchiveInDb(archiveArgs(clientId)), { code: 'CLOSE_ARCHIVE_CONTEXT_CHANGED' });
      assert.equal(repaired, true);
      assert.deepEqual(await archiveRows(clientId), []);
    } finally { __setFirmDbPoolForTests(pool); }
    await createCloseArchiveInDb(archiveArgs(clientId));
    assert.equal((await archiveRows(clientId))[0].payload.sections.entity.jurisdiction, 'AE');
  });
});
