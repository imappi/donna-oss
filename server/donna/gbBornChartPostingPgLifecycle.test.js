// Real PG (GB, synthetic data): a UK book born through self-provision posts to
// the accounts it was born with. The birth seeder (seedGbDefaultChartIfEmpty)
// gives each born row its own id (selfProvisionId 'gb-account-…'); the
// journal account mint (upsertLedgerAccountForJournal) derives ledgerRecordId
// ids. Before the mint looked the code up, every posting to a born code
// inserted a second row for that code and failed on
// ledger_accounts_firm_id_client_id_code_key. Now an opening balance, a bank
// line, a supplier bill and a sales invoice all land on the born rows, the
// chart keeps one row per code, and the born values are untouched. Neighbours:
// a code-less name that the book has by code lands on the coded row, a new
// code-less name and a book with no born chart mint exactly as before.
//   DONNA_PG_TEST_URL=... node --test server/donna/gbBornChartPostingPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb, postGbOpeningBalanceJournalFromDb,
  postSupplierBillJournalFromDb, postOutboundArJournalWithClient, upsertLedgerAccountForJournal, withFirmDbClient
} from './firmDb.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { GB_DEFAULT_CHART } from './gb/defaultChart.js';
import { ledgerRecordId } from './db/shared.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'gb-born-chart-proof';

test('real PG (GB): a self-provisioned UK book posts an opening balance, a bank line, a supplier bill and a sales invoice to its born accounts',
  { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
    const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
    const name = `donna_gb_born_chart_${process.pid}_${Date.now().toString(36)}`;
    await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
    const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
    pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    const previousFirm = process.env.DONNA_DEFAULT_FIRM_ID; process.env.DONNA_DEFAULT_FIRM_ID = firmId;
    t.after(async () => {
      if (previousFirm === undefined) delete process.env.DONNA_DEFAULT_FIRM_ID; else process.env.DONNA_DEFAULT_FIRM_ID = previousFirm;
      __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end();
    });
    await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
    const migrations = new URL('../../db/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    await pool.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Synthetic UK firm',$1,'GB','GBP')", [firmId]);

    // Born the way a new UK book is born: the self-provision route's writer.
    const { clientId } = await selfProvisionClientWorkspace({ auth: { userId: 'gb-born-owner', email: 'owner@gb-born.invalid' },
      companyName: 'Synthetic Born Ltd', jurisdiction: 'GB', entityType: 'gb-ltd', incorporationDate: '2020-01-01' });
    await pool.query("update clients set profile = profile || $3::jsonb where firm_id=$1 and id=$2",
      [firmId, clientId, { accounting_basis: 'accrual', vat_registration: { status: 'not_registered' } }]);
    for (const flag of ['JURISDICTION_TAX_CODING', 'OUTBOUND_INVOICING', 'GB_OPENING_BALANCES']) {
      await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
    }
    await pool.query("insert into fiscal_years(id,firm_id,client_id,label,starts_on,ends_on,status) values('gb-born-fy',$1,$2,'2026','2026-01-01','2026-12-31','open')", [firmId, clientId]);
    const chart = async () => (await pool.query('select id,code,name,account_type,normal_balance,canonical_role from ledger_accounts where firm_id=$1 and client_id=$2 order by code nulls last, name', [firmId, clientId])).rows;
    const bornRows = await chart();
    const born = new Map(bornRows.map(r => [r.code, r]));
    assert.equal(bornRows.length, GB_DEFAULT_CHART.length, 'the book was born with its whole chart');
    assert.ok(bornRows.every(r => r.id.startsWith('gb-account-')), 'born ids are the seeder\'s own scheme, not the mint\'s');
    const linesOf = async (sourceType, sourceId) => (await pool.query(
      `select l.account_id,l.account_code,l.debit::float8 as debit,l.credit::float8 as credit from ledger_journals j join ledger_lines l on l.journal_id=j.id
        where j.firm_id=$1 and j.client_id=$2 and j.source_type=$3 and j.source_id=$4 order by l.line_no`, [firmId, clientId, sourceType, sourceId])).rows;
    const onBorn = (rows, codes) => {
      assert.deepEqual(rows.map(r => r.account_code).sort(), [...codes].sort());
      for (const r of rows) assert.equal(r.account_id, born.get(r.account_code).id, `line on ${r.account_code} references the born row`);
    };

    // 1. Opening balance on born codes, before any other posting.
    await postGbOpeningBalanceJournalFromDb({ firmId, clientId, asOf: '2026-01-01', actorId: 'gb-born-operator',
      authorityBasis: { source: 'test_fixture' }, openingLines: [
        { account: { code: '1400', name: 'Bank account', type: 'bank', normal_balance: 'debit', canonical_role: 'asset.cash' }, debit: 1000, credit: 0 },
        { account: { code: '2100', name: 'Retained earnings', type: 'equity', normal_balance: 'credit', canonical_role: 'equity.retained_earnings' }, debit: 0, credit: 1000 }] });
    const opening = (await pool.query("select source_type,source_id from ledger_journals where firm_id=$1 and client_id=$2", [firmId, clientId])).rows;
    assert.equal(opening.length, 1);
    onBorn(await linesOf(opening[0].source_type, opening[0].source_id), ['1400', '2100']);

    // 2. A bank line coded to a born code, through the real writer.
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values('gb-born-fee',$1,$2,'2026-06-02','Synthetic bank fee',0,12,'GBP','needs_review','applied',$3)",
      [firmId, clientId, { category: 'Bank fees', account_code: '6200', account_name: 'Bank fees', tax_treatment: 'No VAT (not VAT-registered)' }]);
    await postLedgerTransactionInDb({ firmId, clientId, transactionId: 'gb-born-fee', dryRun: false, skipSnapshot: true });
    onBorn(await linesOf('transaction', 'gb-born-fee'), ['6200', '1400']);

    // 3. A supplier bill: expense on a born code, payables resolved from the born chart.
    await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,vendor_name,total_amount,tax_amount,document_date,currency,reference_number) values('gb-born-bill',$1,$2,'synthetic-bill.pdf','supplier_bill','completed','Synthetic Advisers LLP',300,0,'2026-06-03','GBP','SA-1')", [firmId, clientId]);
    await postSupplierBillJournalFromDb({ firmId, clientId, documentId: 'gb-born-bill', actorId: 'gb-born-operator',
      coding: { proposed_account: 'Professional fees', account_code: '6300', account_type: 'expense', tax_treatment: 'No VAT (not VAT-registered)', confidence: 'high', model: 'synthetic-coder' } });
    onBorn(await linesOf('supplier_bill', 'gb-born-bill'), ['6300', '2200']);

    // 4. A sales invoice: receivable and revenue resolved by role from the born chart.
    await withFirmDbClient(async client => {
      await client.query('begin');
      try {
        await postOutboundArJournalWithClient({ client, firmId, clientId, actorId: 'gb-born-operator', invoice: {
          invoiceNumber: 'GB-BORN-1', date: '2026-06-04', currency: 'GBP', subtotal: 500, taxTotal: 0, total: 500,
          seller: { taxRegistered: false }, buyer: { name: 'Synthetic Buyer Ltd' }, referenceNumber: null } });
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    });
    onBorn(await linesOf('sales_invoice', 'GB-BORN-1'), ['1200', '3000']);

    // 5. Neighbours at the mint: a code-less name the book has by code is that
    //    row; a new code-less name mints the derived row with its receipt.
    const mint = account => withFirmDbClient(client => upsertLedgerAccountForJournal({ client, firmId, clientId, account, currency: 'GBP' }));
    assert.equal(await mint({ name: 'Travel', type: 'expense' }), born.get('6400').id);
    assert.equal(await mint({ code: 'travel', name: 'Travel', type: 'expense' }), born.get('6400').id, 'a code that is only the name is a name');
    assert.equal(await mint({ name: 'Synthetic subscriptions', type: 'expense' }), ledgerRecordId('account', firmId, clientId, 'Synthetic subscriptions'));
    assert.equal((await pool.query("select count(*)::int as n from audit_events where firm_id=$1 and client_id=$2 and action='ledger.account.created_at_posting'", [firmId, clientId])).rows[0].n, 1,
      'only the genuinely new account leaves a mint receipt');

    // The chart: one row per code, every born row still there with its born values.
    const after = await chart();
    const codes = after.map(r => r.code).filter(Boolean);
    assert.equal(new Set(codes).size, codes.length, 'one row per code');
    assert.deepEqual(after.filter(r => r.code).map(r => r.id).sort(), bornRows.map(r => r.id).sort(), 'no coded row was added');
    assert.deepEqual(after.filter(r => !r.code).map(r => r.name), ['Synthetic subscriptions']);
    for (const r of after.filter(r => r.code)) {
      const b = born.get(r.code);
      assert.deepEqual([r.name, r.account_type, r.normal_balance, r.canonical_role], [b.name, b.account_type, b.normal_balance, b.canonical_role], `born ${r.code} keeps its values`);
    }

    // Neighbour: a GB book with no born chart mints coded accounts at the derived id, as before.
    await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values('gb-unborn',$1,'Synthetic Unborn Ltd','gb',$2)",
      [firmId, { jurisdiction: 'gb', accounting_system: 'none', accounting_basis: 'cash' }]);
    const unborn = await withFirmDbClient(client => upsertLedgerAccountForJournal({ client, firmId, clientId: 'gb-unborn', account: { code: '6200', name: 'Bank fees', type: 'expense' }, currency: 'GBP' }));
    assert.equal(unborn, ledgerRecordId('account', firmId, 'gb-unborn', '6200'));
  });
