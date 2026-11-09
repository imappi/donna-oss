// FI-21 on the desktop / self-hosted host, proven on real PostgreSQL through
// the real /firms/clients route: a Finnish Oy born on the desktop host gets
// the same coded statutory chart (with its palette-name aliases) that the
// hosted birth gives it (fiStatutoryChartBirthPgLifecycle.test.js). A re-save
// of that client and the boot backfill leave the chart exactly as born, and a
// Finnish toiminimi born on the same host keeps the code-less pack palette.
//
// OPT-IN like the other real-PG lifecycle suites: DONNA_PG_TEST_URL must name
// a scratch PostgreSQL role that may CREATE DATABASE.

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { handleDonnaApiRequest } from '../api.js';
import { __endFirmDbPoolForTests, seedPackPaletteChartWithClient } from '../firmDb.js';
import { ensureLedgerAccountFromVerdict } from '../db/ledger.js';
import { fallbackAccountsForPack, loadOutboundPack } from '../outbound/packs.js';
import { FI_CODING_POLICY } from '../finland/codingPolicy.js';
import { FI_OY_BIRTH_CHART } from '../finland/provisioningPolicy.js';
import { backfillDesktopRuntimePlane } from './hostPlaneSeed.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FIRM_ID = 'firm-fi21-desktop';
const ACCESS_TOKEN = 'fi21-desktop-token';
const BLOB_DIR = '/tmp/donna-fi21-desktop-test-blobs';

const createClient = async (profile) => {
  const body = JSON.stringify({ firm_id: FIRM_ID, profile });
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/api/donna/firms/clients';
  req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-donna-access-token': ACCESS_TOKEN };
  let responseBody = ''; let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  const res = { statusCode: 200, setHeader: () => {}, end: (value = '') => { responseBody = Buffer.isBuffer(value) ? value.toString('utf8') : String(value); resolveEnded(); } };
  await handleDonnaApiRequest(req, res);
  await ended;
  return { statusCode: res.statusCode, body: responseBody ? JSON.parse(responseBody) : null };
};

test('real route + PG: a desktop-host Finnish Oy is born with the coded statutory chart; re-save and boot backfill keep it; a toiminimi keeps the palette',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — FI-21 desktop birth lifecycle not exercised' }, async () => {
    const dbName = `donna_fi21d_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL); scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();
    const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DESKTOP_BLOB_DIR', 'DONNA_ACCESS_TOKEN'];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
      for (const file of (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql') && !supabaseOnly.has(f)).sort()) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }
      await seed.query("insert into firms (id, name, slug) values ($1, 'FI-21 Desktop Firm', 'fi21-desktop-firm')", [FIRM_ID]);
      await seed.query(`insert into firm_members (id, firm_id, email, name, role, status, access_level)
        values ('fi21-desktop-owner', $1, 'owner@fi21-desktop.example.invalid', 'FI-21 Desktop Owner', 'admin', 'active', 'owner')`, [FIRM_ID]);
      Object.assign(process.env, { DATABASE_URL: scratchUrl.toString(), DATABASE_POOL_MAX: '2', DONNA_DESKTOP_BLOB_DIR: BLOB_DIR, DONNA_ACCESS_TOKEN: ACCESS_TOKEN });

      const chartOf = async (clientId) => (await seed.query(`select id, code, name, canonical_role, payload
        from ledger_accounts where firm_id = $1 and client_id = $2 order by code nulls last, name`, [FIRM_ID, clientId])).rows;
      const receiptsOf = async (clientId) => (await seed.query(`select metadata from audit_events
        where firm_id = $1 and client_id = $2 and action = 'ledger.chart.palette_seeded'`, [FIRM_ID, clientId])).rows;

      // 1. Desktop birth of a Finnish Oy: the coded chart, whole.
      const oy = { id: 'leipomo-fi21-desktop', companyName: 'Leipomo Desktop Testi Oy', uen: '3224455-8', jurisdiction: 'FI', entityType: 'fi-oy', defaultCurrency: 'EUR' };
      const born = await createClient(oy);
      assert.equal(born.statusCode, 200, JSON.stringify(born.body));
      const chart = await chartOf(oy.id);
      assert.equal(chart.length, FI_OY_BIRTH_CHART.accounts.length);
      assert.ok(chart.every((row) => /^\d{4}$/.test(row.code)), 'every born account carries a code');
      assert.ok(chart.every((row) => row.payload.source === 'market_birth_chart' && row.payload.birth_chart === 'fi_oy_tilikartta'));
      const byCode = Object.fromEntries(chart.map((row) => [row.code, row]));
      assert.equal(byCode['7000'].name, 'Vuokrakulut'); assert.equal(byCode['7000'].canonical_role, 'expense.rent');
      assert.equal(byCode['3000'].name, 'Myynti'); assert.equal(byCode['3000'].canonical_role, 'revenue.operating');
      // Every palette name an Oy codes against has exactly one coded home.
      const palette = fallbackAccountsForPack(loadOutboundPack('fi'))
        .filter(({ name }) => !FI_CODING_POLICY.loadAccountPalette({ entityType: 'fi-oy' }).excludedAccountNames.includes(name));
      for (const { name, role } of palette) {
        const homes = chart.filter((row) => row.payload.palette_name === name);
        assert.equal(homes.length, 1, name); assert.equal(homes[0].canonical_role, role, `${name} role`);
      }
      const receipts = await receiptsOf(oy.id);
      assert.equal(receipts.length, 1);
      assert.deepEqual(receipts[0].metadata.birth_chart, { id: 'fi_oy_tilikartta', version: 1 });
      // The palette-name alias resolves a palette-named verdict to its coded row.
      const rent = await ensureLedgerAccountFromVerdict({ client: seed, firmId: FIRM_ID, clientId: oy.id, missingAccount: { name: 'Rent' } });
      assert.deepEqual({ id: rent.accountId, name: rent.name, inserted: rent.inserted }, { id: byCode['7000'].id, name: 'Vuokrakulut', inserted: false });

      // 2. Re-save of the existing client and the desktop boot backfill (with
      //    its palette seed): no chart rewrite, no uncoded palette twins.
      const resaved = await createClient({ ...oy, companyName: 'Leipomo Desktop Testi Oy (renamed)' });
      assert.equal(resaved.statusCode, 200, JSON.stringify(resaved.body));
      await backfillDesktopRuntimePlane({ withFirmDbClientFn: async (fn) => fn(seed), logger: { log: () => {} }, seedChartFn: seedPackPaletteChartWithClient });
      assert.deepEqual(await chartOf(oy.id), chart, 're-save and backfill leave the born chart byte-identical');
      assert.equal((await receiptsOf(oy.id)).length, 1);

      // 3. Neighbouring birth on the same host: a toiminimi has no birth chart
      //    and is born with the code-less pack palette exactly as before.
      const tmi = { id: 'kahvila-fi21-desktop', companyName: 'Kahvila Desktop Testi', jurisdiction: 'FI', entityType: 'fi-toiminimi', defaultCurrency: 'EUR' };
      const tmiBorn = await createClient(tmi);
      assert.equal(tmiBorn.statusCode, 200, JSON.stringify(tmiBorn.body));
      const expected = fallbackAccountsForPack(loadOutboundPack('fi'))
        .map(({ name, role }) => ({ code: null, name, canonical_role: role, source: 'pack_palette_seed' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const tmiChart = (await chartOf(tmi.id))
        .map((row) => ({ code: row.code, name: row.name, canonical_role: row.canonical_role, source: row.payload.source }))
        .sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(tmiChart, expected);
    } finally {
      await __endFirmDbPoolForTests();
      for (const key of envKeys) { if (priorEnv[key] === undefined) delete process.env[key]; else process.env[key] = priorEnv[key]; }
      await seed.end().catch(() => {});
      await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [dbName]).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
