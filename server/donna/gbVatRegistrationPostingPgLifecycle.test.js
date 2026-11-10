// Real PG (GB, synthetic data): the UK posting path through
// postLedgerTransactionInDb → gb/postingPolicy.js. Two rules:
//  1. VAT registration, not the rollout flag, decides whether a VAT code may
//     post. A business recorded as not registered (or with no usable record)
//     gets no VAT-coded journal; the line stays unposted with a named refusal
//     until the registration record says otherwise.
//  2. An explicit VAT code on the wrong side of a P&L account refuses (the
//     Finnish TRANSACTION_ALV_ACCOUNT_INCOMPATIBLE twin).
//   DONNA_PG_TEST_URL=... node --test server/donna/gbVatRegistrationPostingPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb } from './firmDb.js';
import { GB_DEFAULT_CHART } from './gb/defaultChart.js';
import { ledgerRecordId } from './db/shared.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'gb-vat-registration-proof';

test('real PG (GB): VAT registration gates VAT-coded posting; a wrong-side VAT code refuses', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_gb_vat_registration_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic UK firm',$1)", [firmId]);

  const book = async (clientId, vatRegistration) => {
    const profile = { jurisdiction: 'gb', accounting_system: 'none', accounting_basis: 'cash', ...(vatRegistration ? { vat_registration: vatRegistration } : {}) };
    await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,$3,'gb',$4)", [clientId, firmId, `Synthetic ${clientId} Ltd`, profile]);
    await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,'JURISDICTION_TAX_CODING','auto','manual')", [`${clientId}-tax-coding`, firmId, clientId]);
    for (const a of GB_DEFAULT_CHART) await pool.query("insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,canonical_role,status) values($1,$2,$3,$4,$5,$6,$7,'GBP',$8,'active')",
      [ledgerRecordId('account', firmId, clientId, a.code), firmId, clientId, a.code, a.name_en, a.account_type, a.normal_balance, a.canonical_role || null]);
  };
  const line = async (clientId, id, { moneyIn = 0, moneyOut = 0, coding }) => {
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values($1,$2,$3,'2026-06-02',$4,$5,$6,'GBP','needs_review','applied',$7)",
      [id, firmId, clientId, `Synthetic ${id}`, moneyIn, moneyOut, { category: coding.account_name, account_code: coding.account_name, ...coding }]);
  };
  const journal = async id => (await pool.query("select l.account_name,l.debit,l.credit,l.tax_type from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.source_type='transaction' and j.source_id=$2 order by l.line_no", [firmId, id])).rows
    .map(r => [r.account_name, Number(r.debit), Number(r.credit), r.tax_type || null]);
  const post = (clientId, id, dryRun = false) => postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun, skipSnapshot: true });
  const refusesBoth = async (clientId, id, code) => {
    for (const dryRun of [true, false]) await assert.rejects(post(clientId, id, dryRun), { code }, `${id} dryRun=${dryRun}`);
    assert.deepEqual(await journal(id), [], `${id} has no journal`);
  };
  const purchase = { account_name: 'Software subscriptions', xero_tax_type: 'VAT_SR_20_INPUT', tax_treatment: 'VAT 20%' };

  // 1. Recorded as not registered, flag on: the purchase would have posted net
  //    + reclaimable input VAT. It refuses by name; nothing reaches the ledger.
  await book('unregistered', { status: 'not_registered' });
  await line('unregistered', 'u-purchase', { moneyOut: 120, coding: purchase });
  await refusesBoth('unregistered', 'u-purchase', 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED');
  // A treatment alone (no stamped code) is refused the same way: enrichment
  // would have stamped the code, so dropping it silently is not an option.
  await line('unregistered', 'u-treatment', { moneyOut: 60, coding: { account_name: 'Software subscriptions', tax_treatment: 'VAT 20%' } });
  await refusesBoth('unregistered', 'u-treatment', 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED');
  // A balance-sheet movement with no VAT code posts exactly as before.
  await line('unregistered', 'u-loan', { moneyIn: 500, coding: { account_name: "Director's loan account" } });
  await post('unregistered', 'u-loan');
  assert.ok((await journal('u-loan')).length >= 2);
  assert.ok((await journal('u-loan')).every(([, , , tax]) => !String(tax || '').startsWith('VAT_')));

  // 2. No registration record at all: unknown is not "registered".
  await book('unrecorded', null);
  await line('unrecorded', 'n-purchase', { moneyOut: 120, coding: purchase });
  await refusesBoth('unrecorded', 'n-purchase', 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED');

  // 3. Registered: the same purchase posts its net, input VAT and gross bank.
  await book('registered', { status: 'registered', registered_from: '2020-01-01' });
  await line('registered', 'r-purchase', { moneyOut: 120, coding: purchase });
  await post('registered', 'r-purchase');
  assert.deepEqual((await journal('r-purchase')).filter(([, debit]) => debit > 0).sort(),
    [['Software subscriptions', 100, 0, 'VAT_SR_20_INPUT'], ['VAT control', 20, 0, 'NONE']].sort());

  // 4. Recording the registration is the recovery: the refused line now posts.
  await pool.query("update clients set profile = profile || $2::jsonb where id=$1", ['unregistered', { vat_registration: { status: 'registered', registered_from: '2026-01-01' } }]);
  await post('unregistered', 'u-purchase');
  assert.deepEqual((await journal('u-purchase')).filter(([, debit]) => debit > 0).sort(),
    [['Software subscriptions', 100, 0, 'VAT_SR_20_INPUT'], ['VAT control', 20, 0, 'NONE']].sort());

  // 5. An explicit output (sales) VAT code on an expense account refuses —
  //    both a payment and money in — and an input code on revenue refuses.
  await line('registered', 'r-wrong-out', { moneyOut: 120, coding: { account_name: 'Software subscriptions', xero_tax_type: 'VAT_SR_20_OUTPUT', tax_treatment: 'VAT_SR_20_OUTPUT' } });
  await refusesBoth('registered', 'r-wrong-out', 'TRANSACTION_GB_VAT_ACCOUNT_INCOMPATIBLE');
  await line('registered', 'r-wrong-out-in', { moneyIn: 120, coding: { account_name: 'Software subscriptions', xero_tax_type: 'VAT_SR_20_OUTPUT', tax_treatment: 'VAT_SR_20_OUTPUT' } });
  await refusesBoth('registered', 'r-wrong-out-in', 'TRANSACTION_GB_VAT_ACCOUNT_INCOMPATIBLE');
  await line('registered', 'r-wrong-in', { moneyIn: 120, coding: { account_name: 'Sales', xero_tax_type: 'VAT_SR_20_INPUT', tax_treatment: 'VAT_SR_20_INPUT' } });
  await refusesBoth('registered', 'r-wrong-in', 'TRANSACTION_GB_VAT_ACCOUNT_INCOMPATIBLE');
  // A supplier refund on its expense with the input code still reverses input VAT.
  await line('registered', 'r-refund', { moneyIn: 120, coding: purchase });
  await post('registered', 'r-refund');
  assert.deepEqual((await journal('r-refund')).filter(([, , credit]) => credit > 0).sort(),
    [['Software subscriptions', 0, 100, 'VAT_SR_20_INPUT'], ['VAT control', 0, 20, 'NONE']].sort());
});
