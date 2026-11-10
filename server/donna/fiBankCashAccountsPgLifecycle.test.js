// A Finnish book's bank and cash legs land on the chart's own accounts, proven
// on real PostgreSQL through the appliance harness (real client-create route,
// real batch coder with a scripted provider reply, real posting route):
//   - a EUR bank line: bank leg on tilikartta 1910 Pankkitili (code, Finnish
//     name, cash/bank role, KPA group cash_and_bank), minted at first posting;
//   - a USD bank line: its own row in the same group, never the EUR row;
//   - a cash-box withdrawal the coder books to 1900 Käteinen raha: the menu
//     offers it before it exists, the posting mints it from the chart, and a
//     later bank line still never takes 1900 as its bank leg;
//   - the balance-sheet read model shows all three under the asset side, and
//     each row carries its statutory group;
//   - a Finnish book that already posted to the engine default
//     "Business Checking · EUR" keeps posting EUR there (no mid-book move);
//   - neighbours: a UK book's bank leg stays on its born 1400 Bank account,
//     and a book in a market that declares nothing keeps the default account.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { FI_PROFILE, openAiFixture } from './testSupport/fiReliabilitySources.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { STATUTORY_GROUPS } from './finland/tilikartta.js';

const ACCOUNT_BY_TEXT = Object.freeze({ VUOKRA: 'Rent', ADOBE: 'Software subscriptions', NOSTO: 'Käteinen raha', PAPER: 'Office expenses', STATIONERY: 'Office supplies' });
const menus = [];
const coder = (request) => {
  const input = JSON.parse(request.input);
  const base = JSON.parse(loadRecording('transaction_coding/kestrel-two-lines-coded').body.output[0].content[0].text).suggestions[1];
  const rows = input.transactions || [input.transaction];
  menus.push(request.text?.format?.schema?.properties?.suggestions?.items?.properties?.proposed_account?.enum || []);
  const suggestions = rows.map((row) => {
    const key = Object.keys(ACCOUNT_BY_TEXT).find((k) => String(row.description || '').toUpperCase().includes(k));
    return { ...base, transaction_id: row.id, proposed_account: ACCOUNT_BY_TEXT[key] || 'Suspense', contact: '',
      tax_treatment: row.description.includes('STATIONERY') ? base.tax_treatment : 'Ei ALV-käsittelyä', support_note: '', ask_client_question: '',
      evidence_required: false, merchant_pattern: '', confidence: 'high', materiality: 'normal', posting_requirement: 'single_account',
      document_allocations: [], reasoning: 'Synthetic strong-coder verdict for the bank text.', warnings: [], alternatives: [] };
  });
  return openAiFixture(input.transactions ? { suggestions, group_summary: [] } : suggestions[0]);
};

const harnessOps = (app, batchSuggestTransactionCodingInDb) => {
  const q = async (sql, params) => (await app.query(sql, params)).rows;
  const book = async (clientId, id, text, out, currency, date = '2026-03-05') => {
    await q(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
      values($1,$2,$3,$7,$4,$5,0,$6,'needs_review','{}')`, [id, app.firmId, clientId, text, out, currency, date]);
    await batchSuggestTransactionCodingInDb({ firmId: app.firmId, clientIds: [clientId] });
    const posted = await app.api.request({ method: 'POST', path: '/api/donna/firms/ledger/post-transaction', auth: true,
      body: { firm_id: app.firmId, client_id: clientId, transaction_id: id, dry_run: false } });
    assert.equal(posted.status, 200, `${id}: ${posted.text.slice(0, 600)}`);
    const lines = await q(`select l.direction,l.debit,l.credit,l.currency,a.id as account_id,a.code,a.name,a.account_type,a.canonical_role,a.currency as account_currency,a.payload
      from ledger_journals j join ledger_lines l on l.journal_id=j.id join ledger_accounts a on a.id=l.account_id
      where j.client_id=$1 and j.source_id=$2 order by l.line_no`, [clientId, id]);
    assert.equal(lines.reduce((sum, l) => sum + Math.round(Number(l.debit) * 100) - Math.round(Number(l.credit) * 100), 0), 0, `${id} balances`);
    return lines;
  };
  const legOf = (lines, direction) => lines.find((l) => l.direction === direction);
  const shape = (l) => ({ code: l.code, name: l.name, account_type: l.account_type, canonical_role: l.canonical_role,
    currency: l.account_currency, statutory_group: l.payload.statutory_group ?? null });

  return { q, book, legOf, shape };
};

const boot = (firm = { jurisdiction: 'FI', currency: 'EUR' }) => bootApplianceForTest({ runToken: `fibank-${Date.now().toString(36)}`, firm, env: { DATABASE_POOL_MAX: '3' } });

test('real PG: a Finnish book posts its bank and cash legs to the chart\'s own 1910 / 1900; a second currency gets its own row; an existing book keeps its account',
  { skip: applianceHarnessSkipReason() }, async () => {
    const app = await boot();
    try {
      const { batchSuggestTransactionCodingInDb, getLedgerPeriodPreviewFromDb } = await import('./firmDb.js');
      app.providers.script('transaction_coding', [{ respond: coder, times: Infinity }]);
      const { q, book, legOf, shape } = harnessOps(app, batchSuggestTransactionCodingInDb);
      // ── A new Finnish Oy ──
      const { clientId } = await app.createClient({ profile: FI_PROFILE });
      assert.deepEqual(await q("select code from ledger_accounts where client_id=$1 and code in ('1900','1910')", [clientId]), [],
        'bank and cash rows are minted at first posting, not born');

      const rent = await book(clientId, 'fi-rent', 'TILISIIRTO VUOKRA MAALISKUU', 1200, 'EUR');
      assert.deepEqual(shape(legOf(rent, 'credit')), { code: '1910', name: 'Pankkitili', account_type: 'bank', canonical_role: 'asset.cash',
        currency: 'EUR', statutory_group: 'cash_and_bank' }, 'the EUR bank leg is the chart\'s 1910');
      assert.equal(STATUTORY_GROUPS[legOf(rent, 'credit').payload.statutory_group].name_fi, 'Rahat ja pankkisaamiset');
      const bankId = legOf(rent, 'credit').account_id;
      const mintReceipt = await q("select metadata from audit_events where client_id=$1 and action='ledger.account.created_at_posting' and resource_id=$2", [clientId, bankId]);
      assert.equal(mintReceipt.length, 1, 'the mint leaves its receipt in the posting transaction');
      assert.deepEqual([mintReceipt[0].metadata.code, mintReceipt[0].metadata.canonical_role], ['1910', 'asset.cash']);

      const usd = await book(clientId, 'fi-usd', 'CARD ADOBE SYSTEMS', 59.99, 'USD');
      const usdBank = legOf(usd, 'credit');
      assert.deepEqual(shape(usdBank), { code: null, name: 'Pankkitili · USD', account_type: 'bank', canonical_role: 'asset.cash',
        currency: 'USD', statutory_group: 'cash_and_bank' }, 'a second currency gets its own row in the chart\'s bank group');
      assert.notEqual(usdBank.account_id, bankId);
      assert.equal((await q('select currency from ledger_accounts where id=$1', [bankId]))[0].currency, 'EUR', 'the EUR row is not re-denominated');

      const atm = await book(clientId, 'fi-atm', 'KATEISNOSTO NOSTO AUTOMAATTI', 200, 'EUR');
      assert.ok(menus.some((names) => names.includes('Käteinen raha')), 'the coder is offered the chart\'s cash account before it exists');
      assert.deepEqual(shape(legOf(atm, 'debit')), { code: '1900', name: 'Käteinen raha', account_type: 'cash', canonical_role: 'asset.cash',
        currency: 'EUR', statutory_group: 'cash_and_bank' }, 'the cash box is the chart\'s 1900');
      assert.equal(legOf(atm, 'credit').account_id, bankId, 'the withdrawal leaves the EUR bank account');

      const rent2 = await book(clientId, 'fi-rent-2', 'TILISIIRTO VUOKRA HUHTIKUU', 1200, 'EUR', '2026-03-20');
      assert.equal(legOf(rent2, 'credit').account_id, bankId, 'with 1900 in the chart, a bank line still never takes it as its bank leg');
      const codeless = await q('select name from ledger_accounts where client_id=$1 and code is null order by name', [clientId]);
      assert.deepEqual(codeless.map((r) => r.name), ['Pankkitili · USD'], 'no engine default bank row on a new Finnish book');

      const preview = await getLedgerPeriodPreviewFromDb({ firmId: app.firmId, clientId, periodStart: '2026-03-01', periodEnd: '2026-03-31' });
      const assets = preview.balance_sheet.assets.accounts;
      const asset = (name) => assets.find((a) => a.name === name);
      for (const [name, amount] of [['Pankkitili', -2600], ['Pankkitili · USD', -59.99], ['Käteinen raha', 200]]) {
        assert.ok(asset(name), `${name} is on the asset side: ${JSON.stringify(assets.map((a) => a.name))}`);
        assert.equal(asset(name).amount, amount, name);
        assert.equal(asset(name).statutory_group, 'cash_and_bank', `${name} carries its KPA group`);
      }
      assert.deepEqual(preview.balance_sheet.unclassified.accounts, []);

      // ── A Finnish book that already posted to the engine default ──
      const legacy = await app.createClient({ profile: { ...FI_PROFILE, companyName: 'Vanha Kirja Oy', businessId: '3312255-1' } });
      await q(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,canonical_role,status,payload)
        values($1,$2,$3,null,'Business Checking · EUR','bank','debit','EUR',null,'active','{"role":"bank","label":"Business Checking · EUR"}')`,
      [`legacy-bank-${legacy.clientId}`, app.firmId, legacy.clientId]);
      // The row is written as the pre-declaration mint wrote it; the fixture
      // write is not a readiness event, so admission is paused for this book.
      const { setClientFlagStage } = await import('./clientConfig.js');
      const memberId = (await q('select id from firm_members where firm_id=$1 limit 1', [app.firmId]))[0].id;
      await setClientFlagStage({ query: app.query }, { firmId: app.firmId, clientId: legacy.clientId, flagKey: 'ENTITY_READINESS_ADMISSION', stage: 'off',
        source: 'manual', reason: 'fixture_legacy_bank_row', actorType: 'firm_member', actorId: memberId });
      const legacyRent = await book(legacy.clientId, 'fi-legacy-rent', 'TILISIIRTO VUOKRA MAALISKUU', 1200, 'EUR');
      assert.equal(legOf(legacyRent, 'credit').name, 'Business Checking · EUR', 'an existing book keeps its bank account: no mid-book move');
      const legacyUsd = await book(legacy.clientId, 'fi-legacy-usd', 'CARD ADOBE SYSTEMS', 59.99, 'USD');
      assert.equal(legOf(legacyUsd, 'credit').name, 'Pankkitili · USD', 'its second currency no longer lands on (and is refused by) the EUR row');

    } finally { await app.stop(); }
  });

test('real PG neighbours: a UK book keeps its born bank account; a market that declares nothing keeps the engine default',
  { skip: applianceHarnessSkipReason() }, async () => {
    const app = await boot({});
    try {
      const { batchSuggestTransactionCodingInDb } = await import('./firmDb.js');
      app.providers.script('transaction_coding', [{ respond: coder, times: Infinity }]);
      const { q, book, legOf, shape } = harnessOps(app, batchSuggestTransactionCodingInDb);
      // ── Neighbours ──
      // Readiness admission is not this proof's subject (the harness host has
      // no admitted-profile certificate for these fixtures), so it is paused
      // per book with a reason, as fiStatutoryChartBirthPgLifecycle does.
      const { setClientFlagStage } = await import('./clientConfig.js');
      const memberId = (await q('select id from firm_members where firm_id=$1 limit 1', [app.firmId]))[0].id;
      const pauseAdmission = (clientId) => setClientFlagStage({ query: app.query }, { firmId: app.firmId, clientId, flagKey: 'ENTITY_READINESS_ADMISSION',
        stage: 'off', source: 'manual', reason: 'fixture_neighbour_posting', actorType: 'firm_member', actorId: memberId });
      // A UK book born with the UK default chart (the self-provision seed).
      const gb = await app.createClient(); // the harness's own UK company
      await pauseAdmission(gb.clientId);
      const { seedGbDefaultChartIfEmpty } = await import('./selfProvisionDb.js');
      assert.equal((await seedGbDefaultChartIfEmpty({ firmId: app.firmId, clientId: gb.clientId, entityType: 'gb-ltd' })).seeded, true);
      const gbBorn = await q("select id,code,name from ledger_accounts where client_id=$1 and canonical_role='asset.cash'", [gb.clientId]);
      assert.deepEqual(gbBorn.map((r) => [r.code, r.name]), [['1400', 'Bank account']]);
      // Read through the posting route's dry run: committing a born-chart UK
      // line fails today on main too (the seed keys rows by selfProvisionId,
      // the posting mint by ledgerRecordId, and ledger_accounts is unique on
      // code — reported in the pull request, not changed here).
      await q(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
        values('gb-paper',$1,$2,'2026-03-05','STATIONERY PAPER',30,0,'GBP','needs_review','{}')`, [app.firmId, gb.clientId]);
      await batchSuggestTransactionCodingInDb({ firmId: app.firmId, clientIds: [gb.clientId] });
      const gbPreview = await app.api.request({ method: 'POST', path: '/api/donna/firms/ledger/post-transaction', auth: true,
        body: { firm_id: app.firmId, client_id: gb.clientId, transaction_id: 'gb-paper', dry_run: true } });
      assert.equal(gbPreview.status, 200, gbPreview.text.slice(0, 400));
      const gbBank = gbPreview.json.ledger_posting.bank_account;
      assert.deepEqual([gbBank.code, gbBank.name, gbBank.source, gbBank.declared_account], ['1400', 'Bank account', 'native_ledger', undefined],
        'the UK bank leg is its born 1400 Bank account, with no declaration');
      const gbBankLine = gbPreview.json.ledger_posting.ledger_journal.lines.find((line) => line.account.role === 'bank');
      assert.deepEqual(Object.keys(gbBankLine.account).sort(), ['code', 'label', 'name', 'normal_balance', 'role', 'tax_type', 'type', 'xero_account_id'],
        'the UK bank line account is shaped exactly as before');
      // A UK book with no born chart keeps the engine default, as before.
      const gbBare = await app.createClient();
      await pauseAdmission(gbBare.clientId);
      const gbBareLine = await book(gbBare.clientId, 'gb-bare-paper', 'STATIONERY PAPER', 30, 'GBP');
      assert.deepEqual(shape(legOf(gbBareLine, 'credit')), { code: null, name: 'Business Checking · GBP', account_type: 'bank', canonical_role: null,
        currency: 'GBP', statutory_group: null });
      const sg = await app.createClient({ profile: { companyName: 'Kopi Test Pte Ltd', jurisdiction: 'SG', entityType: 'sg-pte', currency: 'SGD', accounting_system: 'none', accounting_view: 'management_books' } });
      await pauseAdmission(sg.clientId);
      const sgLine = await book(sg.clientId, 'sg-paper', 'STATIONERY PAPER', 30, 'SGD');
      assert.deepEqual([legOf(sgLine, 'credit').code, legOf(sgLine, 'credit').name, legOf(sgLine, 'credit').canonical_role],
        [null, 'Business Checking · SGD', null], 'a market that declares nothing keeps the engine default');
    } finally { await app.stop(); }
  });
