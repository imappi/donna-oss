// Real registered sweep adapters, named ledger/profile writers, and persisted
// country changes. Every database in this fixture is disposable.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __writeLedgerJournalRows, updateClientProfileInDb } from './firmDb.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { resolveStatutoryHandler } from './statutoryRegistry.js';
import { STATUTORY_OBLIGATION_BINDINGS } from './statutoryObligationRegistry.js';
import { runStatutoryObligationSweep } from './outbound/statutoryObligations.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: registered statutory sweeps reject mis-staged countries and identity changes while healthy peers complete once', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — statutory lifecycle INCOMPLETE'
}, async (t) => {
  const name = `donna_jn_statutory_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', (connection) => connectionsClosed.push(new Promise(resolve => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end();
    await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter(name => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const firmId = 'statutory-fixture-firm';
  await pool.query("insert into firms (id, name, slug) values ($1, 'Statutory fixture', 'statutory-fixture')", [firmId]);
  const seed = async (id, jurisdiction, profile = {}) => {
    await pool.query(`insert into clients (id, firm_id, company_name, jurisdiction, profile)
      values ($1, $2, 'Statutory fixture', $3, $4::jsonb)`, [id, firmId, jurisdiction?.toUpperCase() || null,
      JSON.stringify({ ...(jurisdiction ? { jurisdiction } : {}), ...profile })]);
    const bank = { role: 'asset.bank', code: 'fixture-bank', name: 'Fixture bank', type: 'bank', normal_balance: 'debit' };
    const sales = { role: 'income.sales', code: 'fixture-sales', name: 'Fixture sales', type: 'revenue', normal_balance: 'credit' };
    const client = await pool.connect();
    try {
      await client.query('begin');
      await __writeLedgerJournalRows({ client, firmId, clientId: id, actorId: 'fixture-owner', journal: {
        source_type: 'transaction', source_id: `${id}-sales`, journal_date: '2026-05-01', currency: 'EUR',
        status: 'posted', memo: 'Statutory fixture sales', direction: 'receive', amount: 120000,
        accounts: [bank, sales], lines: [
          { account: bank, direction: 'debit', debit: 120000, credit: 0, amount: 120000, currency: 'EUR' },
          { account: sales, direction: 'credit', debit: 0, credit: 120000, amount: 120000, currency: 'EUR' }
        ]
      } });
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  };
  for (const country of ['ae', 'fi', 'gb', 'us', 'sg', 'au', 'zz']) await seed(country, country);
  await seed('missing', null);
  await seed('conflict', 'fi', { jurisdiction: 'gb' });
  for (const flag of ['FINLAND_ALV_THRESHOLD_WATCH', 'GB_VAT_THRESHOLD_WATCH']) {
    await pool.query(`insert into client_capability_config (id, firm_id, client_id, flag_key, stage, source)
      values ($2, $1, null, $2, 'auto', 'manual')`, [firmId, flag]);
  }
  const ledger = async () => ({
    journals: (await pool.query('select * from ledger_journals order by id')).rows,
    lines: (await pool.query('select * from ledger_lines order by id')).rows
  });
  const before = await ledger();
  const deliveries = [];
  const bindings = Object.fromEntries(Object.entries(STATUTORY_OBLIGATION_BINDINGS).map(([name, entry]) => [name, {
    ...entry, run: () => entry.run({ firmId, asOf: '2026-09-05', year: 2026, deliverAsksImpl: async (args) => { deliveries.push(args); } })
  }]));
  const result = await runStatutoryObligationSweep({ packIds: ['fi', 'gb'], bindings });
  assert.equal(result.errors, 0);
  assert.equal(result.ran, 3);
  for (const name of ['fi_alv_threshold_escalation', 'gb_vat_threshold_escalation']) {
    const summary = result.obligations.find(row => row.binding === name).summary;
    assert.equal(summary.minted, 1);
    assert.equal(summary.errors, 1, 'conflicting persisted identity remains a visible per-client error');
    assert.equal(summary.skipped, 7, 'other/missing countries never inherit a watch from firm flags');
  }
  const asks = (await pool.query('select * from client_evidence_requests order by client_id')).rows;
  assert.deepEqual(asks.map(row => row.client_id), ['fi', 'gb']);
  assert.ok(asks.every(row => row.status === 'open' && row.audience === 'client'));
  assert.deepEqual(deliveries.map(row => row.clientId).sort(), ['fi', 'gb']);
  assert.deepEqual(await ledger(), before, 'statutory discovery and escalation never rewrite posted evidence');
  const again = await runStatutoryObligationSweep({ packIds: ['fi', 'gb'], bindings });
  assert.equal(again.obligations.find(row => row.binding === 'fi_alv_threshold_escalation').summary.minted, 0);
  assert.equal(again.obligations.find(row => row.binding === 'gb_vat_threshold_escalation').summary.minted, 0);
  assert.equal(deliveries.length, 2, 'idempotent sweep never re-nags');

  // Change identity after the real turnover query but before the drain starts
  // its mint transaction. The named profile writer supplies the correction.
  await seed('race', 'fi');
  const client = await pool.connect();
  let changed = false;
  try {
    const result = await resolveStatutoryHandler({ jurisdiction: 'fi', operation: 'drainFinlandAlvThresholdEscalations' })({
      firmId, year: 2026, deliverAsksImpl: async () => assert.fail('a stale-country ask must not deliver'),
      client: { query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (!changed && sql.includes('from ledger_lines') && params?.[1] === 'race') {
          changed = true;
          await updateClientProfileInDb({ firmId, clientId: 'race', profilePatch: { jurisdiction: 'ae' }, actorId: 'fixture-owner' });
        }
        return result;
      } }
    });
    assert.equal(changed, true);
    assert.equal(result.minted, 0);
    assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where client_id = 'race'")).rows[0].n, 0);
    assert.equal((await pool.query("select jurisdiction from clients where id = 'race'")).rows[0].jurisdiction, 'AE');
  } finally { client.release(); }
  const audits = (await pool.query("select * from audit_events where action in ('alv_threshold.escalated','vat_threshold.escalated') order by client_id")).rows;
  assert.deepEqual(audits.map(row => row.client_id), ['fi', 'gb']);
  assert.ok(audits.every(row => row.metadata.authority_basis.startsWith('client_capability_config:')));
});
