// A close lock (POST /close/lock → lockClosePeriodInDb) flips every posted journal
// in the period to status 'closed'. The statutory readers filtered on
// status = 'posted' alone, so locking a period made its ledger VANISH from the
// return / watch / opening-balance reads (the SG F5 read a payable quarter as a
// ready nil return). Each case: seed → read → REAL lock → read again → the read
// must not change. Draft/voided journals stay excluded (one neighbour per case).
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { prepareCiHostPostgres } from '../../scripts/prepare_ci_host_postgres.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { lockClosePeriodInDb } from './db/close.js';
import { getFinlandAlvReturnFromDb, getFinlandAlvThresholdWatchFromDb, getFinlandCutoverPackFromDb,
  getFinlandScopeDriftFromDb, getFinlandOyBalanceSheetWatchesFromDb, getFinlandEnnakkoveroStatusFromDb } from './finland/statutoryDb.js';
import { prepareGbVatReturnFromDb } from './gb/vatReturnRoute.js';
import { drainGbVatThresholdEscalations } from './gb/statutoryDb.js';
import { drainAeVatThresholdEscalations } from './ae/statutoryDb.js';

import { PERSONNEL_ACCOUNT_CODES } from './finland/scopeDrift.js';
const PERSONNEL_CODE = [...PERSONNEL_ACCOUNT_CODES][0];
const PERIOD = { start: '2026-06-01', end: '2026-06-30' };

test('statutory readers see the same ledger before and after a close lock — real PostgreSQL', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable DONNA_PG_TEST_URL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const database = `cjr_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${database}`;
  const prior = { DATABASE_URL: process.env.DATABASE_URL, CLIENT_CONFIG_FORCE_DISABLE: process.env.CLIENT_CONFIG_FORCE_DISABLE };
  let seed, pool;
  await admin.query(`create database "${database}"`);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    if (pool) await pool.end();
    if (seed) await seed.end();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await admin.query(`drop database "${database}"`);
    await admin.end();
  });
  await prepareCiHostPostgres({ databaseUrl: url.toString() });
  seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter(f => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, migrationRoot), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  process.env.DATABASE_URL = url.toString(); delete process.env.CLIENT_CONFIG_FORCE_DISABLE;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  __setFirmDbPoolForTests(pool);

  let seq = 0;
  const newClient = async ({ jurisdiction, entityType = null, profile = {}, flags = [], firm = null }) => {
    const firmId = firm || `cjr-firm-${++seq}`;
    await seed.query('insert into firms(id,name,slug) values($1,$1,$1) on conflict do nothing', [firmId]);
    const clientId = `cjr-client-${++seq}`;
    await seed.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
      values($1,$2,$1,$3,$4,$5)`, [clientId, firmId, jurisdiction, entityType, profile]);
    for (const flag of flags) {
      await seed.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
        values($1,$2,$3,$4,'canary','manual')`, [`flag-${clientId}-${flag}`, firmId, clientId, flag]);
    }
    return { firmId, clientId };
  };
  // lines: [accountCode, accountType, debit, credit, taxType, role]
  const post = async ({ firmId, clientId }, { id, date = '2026-06-10', status = 'posted', sourceType = 'cjr_fixture', currency = 'EUR', lines }) => {
    await seed.query(`insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status)
      values($1,$2,$3,$4,$1,$5,$6,$7)`, [id, firmId, clientId, sourceType, date, currency, status]);
    for (const [n, [code, type, debit, credit, taxType, role]] of lines.entries()) {
      const account = `${clientId}-${code}`;
      await seed.query(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,currency)
        values($1,$2,$3,$4,$4,$5,$6) on conflict do nothing`, [account, firmId, clientId, code, type, currency]);
      await seed.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,account_code,line_no,
        direction,debit,credit,amount,currency,tax_type,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`${id}-${n + 1}`, id, firmId, clientId, account, code, n + 1, debit ? 'debit' : 'credit', debit, credit,
        debit || credit, currency, taxType || null, role ? { role } : {}]);
    }
  };
  const lock = ({ firmId, clientId }) => lockClosePeriodInDb({ firmId, clientId, periodStart: PERIOD.start,
    periodEnd: PERIOD.end, actorId: 'cjr-actor', force: true });
  const statusOf = async id => (await seed.query('select status from ledger_journals where id=$1', [id])).rows[0].status;
  // The proof shape: read, lock for real, read again — identical, and the read was not trivially empty.
  const unchangedByLock = async (scope, journalId, read, meaningful) => {
    const before = await read();
    assert.ok(meaningful(before), `fixture must be visible before the lock: ${JSON.stringify(before)}`);
    await lock(scope);
    assert.equal(await statusOf(journalId), 'closed', 'the real lock flips posted → closed');
    assert.deepEqual(await read(), before, 'reading the same ledger after the lock');
  };

  const fi = await newClient({ jurisdiction: 'FI', entityType: 'fi-oy', flags: ['FINLAND_ALV_RETURN',
    'FINLAND_ALV_THRESHOLD_WATCH', 'FINLAND_SCOPE_DRIFT_WATCH', 'FINLAND_OY_BALANCE_SHEET_WATCHES',
    'FINLAND_ENNAKKOVERO_WATCH', 'FINLAND_OPENING_BALANCES', 'FINLAND_TILIKAUSI'] });
  await seed.query(`insert into fiscal_years(id,firm_id,client_id,label,starts_on,ends_on)
    values('cjr-fy',$1,$2,'2026','2026-01-01','2026-12-31')`, [fi.firmId, fi.clientId]);
  await post(fi, { id: 'fi-sale', lines: [['3000', 'revenue', 0, 1000, 'ALV_25_5_OUTPUT'], ['2939', 'liability', 0, 255, null, 'alv_output'], ['1910', 'asset', 1255, 0]] });
  await post(fi, { id: 'fi-draft', status: 'draft', lines: [['3000', 'revenue', 0, 9000, 'ALV_25_5_OUTPUT'], ['1910', 'asset', 9000, 0]] });
  await post(fi, { id: 'fi-void', status: 'voided', lines: [['3000', 'revenue', 0, 8000, 'ALV_25_5_OUTPUT'], ['1910', 'asset', 8000, 0]] });
  await post(fi, { id: 'fi-open', date: '2026-06-01', sourceType: 'opening_balance', lines: [['1910', 'asset', 500, 0], ['2000', 'equity', 0, 500]] });
  await post(fi, { id: 'fi-payroll', lines: [[PERSONNEL_CODE, 'expense', 700, 0], ['1760', 'asset', 5000, 0], ['1910', 'asset', 0, 5700]] });
  const fiEmpty = await newClient({ jurisdiction: 'FI', entityType: 'fi-oy', flags: ['FINLAND_SCOPE_DRIFT_WATCH', 'FINLAND_OY_BALANCE_SHEET_WATCHES'] });
  const fiArgs = { ...fi, readAt: '2026-06-30T12:00:00.000Z' };

  await t.test('FI ALV return, ALV threshold watch, cutover opening balances, scope-drift, Oy watches, ennakkovero', async () => {
    const reads = {
      alvReturn: [() => getFinlandAlvReturnFromDb({ ...fiArgs, period: '2026-06' }), r => r.alvReturn.boxes['301'] === 255 && r.review.status === 'ready'],
      threshold: [() => getFinlandAlvThresholdWatchFromDb({ ...fiArgs, year: 2026 }), r => JSON.stringify(r.watch).includes('1000')],
      cutover: [() => getFinlandCutoverPackFromDb(fiArgs), r => JSON.stringify(r).includes('500')],
      scopeDrift: [() => getFinlandScopeDriftFromDb(fiArgs), async r => JSON.stringify(r) !== JSON.stringify(await getFinlandScopeDriftFromDb({ ...fiEmpty, readAt: fiArgs.readAt }))],
      oyWatches: [() => getFinlandOyBalanceSheetWatchesFromDb(fiArgs), async r => JSON.stringify(r) !== JSON.stringify(await getFinlandOyBalanceSheetWatchesFromDb({ ...fiEmpty, readAt: fiArgs.readAt }))],
      ennakkovero: [() => getFinlandEnnakkoveroStatusFromDb(fiArgs), r => JSON.stringify(r.ennakkovero).includes('1000')]
    };
    const before = {};
    for (const [name, [read, meaningful]] of Object.entries(reads)) {
      before[name] = await read();
      assert.ok(await meaningful(before[name]), `${name}: fixture visible before the lock: ${JSON.stringify(before[name]).slice(0, 400)}`);
    }
    await lock(fi);
    assert.equal(await statusOf('fi-sale'), 'closed');
    assert.equal(await statusOf('fi-open'), 'closed');
    assert.equal(await statusOf('fi-draft'), 'draft');
    assert.equal(await statusOf('fi-void'), 'voided');
    const changed = [];
    for (const [name, [read]] of Object.entries(reads)) {
      if (JSON.stringify(await read()) !== JSON.stringify(before[name])) changed.push(name);
    }
    assert.deepEqual(changed, [], 'readers whose answer changed when the period was locked');
  });

  await t.test('GB VAT return reads the same ledger after the lock', async () => {
    const gb = await newClient({ jurisdiction: 'GB', profile: { vat_registration: { status: 'registered',
      registered_from: '2025-01-01', vat_registration_number: 'GB123456789' } } });
    await seed.query(`insert into vat_periods(id,firm_id,client_id,vrn,period_key,start_date,end_date,due_date,status,
      hmrc_obligation_payload,synced_at) values('cjr-vp',$1,$2,'123456789','26A2',$3,$4,'2026-08-07','open','{}',now())`,
    [gb.firmId, gb.clientId, PERIOD.start, PERIOD.end]);
    await post(gb, { id: 'gb-sale', currency: 'GBP', lines: [['3000', 'revenue', 0, 1000, 'VAT_SR_20_OUTPUT'], ['2200', 'liability', 0, 200, null, 'vat_output'], ['1200', 'asset', 1200, 0]] });
    await unchangedByLock(gb, 'gb-sale', () => prepareGbVatReturnFromDb({ ...gb, periodKey: '26A2', asOf: '2026-07-01' }),
      r => JSON.stringify(r).includes('1000'));
  });

  await t.test('GB and AE registration-threshold watches count closed turnover', async () => {
    const gb = await newClient({ jurisdiction: 'GB', flags: ['GB_VAT_THRESHOLD_WATCH'] });
    await post(gb, { id: 'gbw-sale', currency: 'GBP', lines: [['3000', 'revenue', 0, 200000, null], ['1200', 'asset', 200000, 0]] });
    const ae = await newClient({ jurisdiction: 'AE' });
    await post(ae, { id: 'aew-sale', currency: 'AED', lines: [['3000', 'revenue', 0, 900000, null], ['1200', 'asset', 900000, 0]] });
    const deliverAsksImpl = async () => ({ delivered: 0 });
    const drains = async () => ({
      gb: (await drainGbVatThresholdEscalations({ client: seed, firmId: gb.firmId, asOf: '2026-07-01', deliverAsksImpl })).exceeded,
      ae: (await drainAeVatThresholdEscalations({ client: seed, firmId: ae.firmId, asOf: '2026-07-01', deliverAsksImpl })).exceeded
    });
    assert.deepEqual(await drains(), { gb: 1, ae: 1 }, 'exceeded before the lock');
    await seed.query('delete from client_evidence_requests');
    await lock(gb); await lock(ae);
    assert.equal(await statusOf('gbw-sale'), 'closed'); assert.equal(await statusOf('aew-sale'), 'closed');
    assert.deepEqual(await drains(), { gb: 1, ae: 1 }, 'still exceeded after the lock');
  });
});
