import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { recordRefusalViaDb } from './ledgerAutoPost.js';
import { __endFirmDbPoolForTests } from './firmDb.js';
const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-rt26';
const CLIENT = 'client-rt26';

const bootScratchDatabase = async () => {
  const dbName = `donna_refusal_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const scratchUrl = new URL(PG_URL);
  scratchUrl.pathname = `/${dbName}`;
  const seed = new pg.Client({ connectionString: scratchUrl.toString() });
  await seed.connect();
  const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
  const files = (await readdir(path.join(ROOT, 'db', 'migrations')))
    .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
    .sort();
  for (const file of files) await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
  await seed.query(`insert into firms (id, name, slug, jurisdiction, default_currency) values ($1, 'RT-26 Firm', 'rt26-firm', 'FI', 'EUR')`, [FIRM]);
  await seed.query(
    `insert into clients (id, firm_id, company_name, jurisdiction, entity_type, status)
     values ($1, $2, 'Kampaamo Kultalanka Oy', 'FI', 'fi-oy', 'active')`,
    [CLIENT, FIRM]
  );
  const stop = async () => {
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
    await admin.end().catch(() => {});
  };
  return { seed, scratchUrl: scratchUrl.toString(), stop };
};


test('real PG: refusal audit and payload stamp commit together; write failure propagates and retry succeeds', { skip: !PG_URL && 'DONNA_PG_TEST_URL required' }, async () => {
  const { seed, scratchUrl, stop } = await bootScratchDatabase();
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = scratchUrl;
  try {
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,money_out,currency,payload)
      values('refusal-tx',$1,$2,'2025-02-03',1450,'EUR','{}')`, [FIRM, CLIENT]);
    await seed.query(`create function fail_refusal_stamp() returns trigger language plpgsql as $$ begin
      if new.payload ? 'ledger_post_refusal' then raise exception 'injected stamp write failure'; end if;
      return new; end $$;
      create trigger fail_refusal_stamp before update on transactions for each row execute function fail_refusal_stamp()`);
    const args = { firmId: FIRM, clientId: CLIENT, transactionId: 'refusal-tx', error: Object.assign(new Error('tax unresolved'), {code:'TRANSACTION_ALV_TREATMENT_UNRESOLVED'}) };
    await assert.rejects(recordRefusalViaDb(args), /injected stamp write failure/);
    assert.equal((await seed.query(`select count(*)::int as n from audit_events where action='ledger.auto_post_refused'`)).rows[0].n, 0, 'failed stamp must not leave an audit damping the retry');
    assert.equal((await seed.query(`select payload ? 'ledger_post_refusal' as stamped from transactions where id='refusal-tx'`)).rows[0].stamped, false);
    await seed.query('drop trigger fail_refusal_stamp on transactions');
    assert.equal(await recordRefusalViaDb(args), true);
    assert.equal((await seed.query(`select count(*)::int as n from audit_events where action='ledger.auto_post_refused'`)).rows[0].n, 1);
    assert.equal((await seed.query(`select payload->'ledger_post_refusal'->>'code' as code from transactions where id='refusal-tx'`)).rows[0].code, args.error.code);
    await assert.rejects(recordRefusalViaDb({...args,transactionId:'absent'}), /disappeared/);
    assert.equal((await seed.query(`select count(*)::int as n from audit_events where action='ledger.auto_post_refused'`)).rows[0].n, 1, 'absent source also rolls back its audit');
  } finally {
    await __endFirmDbPoolForTests();
    if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior;
    await stop();
  }
});
