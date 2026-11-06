import assert from 'node:assert/strict';
import { __writeLedgerJournalRows, upsertLedgerAccountForJournal, ledgerRecordId } from '../../db/ledger.js';
import { withFirmDbClient } from '../../db/pool.js';
import { getFinancialReportFromDb, lockClosePeriodInDb } from '../../db/close.js';
import { nativeBirthAccounts, readNativeChartLineage } from '../../nativeChartLineage.js';
import { setClientFlagStage } from '../../clientConfig.js';

// Shared report arithmetic only. Native reservations stay refused. The second,
// independently created book is unmarked and cannot persist statutory groups.
export async function proveNativeAndReservedReports({ t, seed, firmId, nativeClientId, createLegacy, admit }) {
  const period = { firmId, periodStart: '2026-02-01', periodEnd: '2026-02-28' };
  const report = (clientId, basis = 'accrual') => getFinancialReportFromDb({ ...period, clientId, basis });
  const metadata = new Map(nativeBirthAccounts({ contractId: 'sg_pte_native.v1', firmId, clientId: nativeClientId }).map(row => [row.code, row]));
  const postingAccount = code => {
    const row = metadata.get(code); assert.ok(row, code);
    return { code, name: row.name, type: row.account_type, normal_balance: row.normal_balance,
      tax_type: 'NONE' };
  };
  const post = (clientId, source, entries) => withFirmDbClient(async client => {
    await client.query('begin');
    try {
      const lines = entries.map(([code, debit, credit]) => ({ account: postingAccount(code),
        debit, credit, direction: debit ? 'debit' : 'credit', amount: debit || credit, currency: 'SGD' }));
      assert.equal(lines.reduce((n,l) => n+l.debit-l.credit,0),0);
      const result = await __writeLedgerJournalRows({ client, firmId, clientId, actorId: 'member-a',
        journal: { source_type: 'manual', source_id: `sg-c3-report-${source}`, journal_date: '2026-02-15',
          memo: 'Synthetic report arithmetic proof; no statutory posting authority', currency: 'SGD',
          amount: lines.reduce((n,l) => n+l.debit,0), lines, accounts: lines.map(l => l.account) },
        payload: { authority_basis: 'synthetic_report_arithmetic_fixture' } });
      await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; }
  });
  const foots = r => {
    assert.equal(r.trial_balance.imbalance, 0); assert.equal(r.balance_sheet.imbalance, 0);
    assert.equal(r.trial_balance.balanced, true); assert.equal(r.balance_sheet.balanced, true);
  };
  const row = (rows, code) => { const result = rows.find(r => r.code === code); assert.ok(result, code); return result; };
  const earnings = r => r.balance_sheet.equity.accounts.filter(r => r.synthetic).reduce((n,r) => n+r.amount,0);
  await t.test('independent unmarked book → named writer → ordinary investment, contra, cash and FX arithmetic (native posting unqualified)', async () => {
    const clientId = 'sg-c4-unmarked-ordinary-report';
    await createLegacy(clientId);
    await setClientFlagStage(seed,{firmId,clientId,flagKey:'ENTITY_READINESS_ADMISSION',stage:'off',source:'manual',
      reason:'Independent shared arithmetic, native posting remains unqualified',actorType:'firm_member',actorId:'member-a'});
    assert.equal(await readNativeChartLineage({query:seed.query.bind(seed),firmId,clientId}),null);
    const before = (await seed.query('select * from ledger_accounts where client_id=$1 order by id', [nativeClientId])).rows;
    await post(clientId, 'capital', [['1910',3000,0],['2000',0,3000]]);
    await post(clientId, 'investment', [['1400',500,0],['1910',0,500]]);
    await post(clientId, 'ppe', [['1120',1000,0],['1910',0,1000]]);
    await post(clientId, 'depreciation', [['6800',200,0],['1180',0,200]]);
    await post(clientId, 'cash-transfer', [['1900',100,0],['1910',0,100]]);
    await post(clientId, 'cash-only-sale', [['1900',50,0],['3100',0,50]]);
    await post(clientId, 'fx-loss', [['9280',20,0],['1910',0,20]]);
    assert.equal(row((await report(clientId)).profit_and_loss.accounts,'9280').expense,20);
    await post(clientId, 'fx-gain', [['1910',10,0],['9280',0,10]]);
    assert.equal(row((await report(clientId)).profit_and_loss.accounts,'9280').expense,10);
    await post(clientId, 'fx-loss-reversal', [['1910',20,0],['9280',0,20]]);
    const r = await report(clientId); foots(r);
    for (const a of r.trial_balance.accounts) {
      const authored = metadata.get(a.code); assert.ok(authored);
      assert.equal(a.id, ledgerRecordId('account',firmId,clientId,a.code)); assert.equal(a.account_type, authored.account_type);
      assert.equal(a.normal_balance, authored.normal_balance); assert.equal(a.statutory_group, undefined, 'unmarked writer has no group-authoring contract');
    }
    const assets = r.balance_sheet.assets.accounts;
    assert.equal(row(assets,'1400').amount,500); assert.equal(row(assets,'1400').account_type,'investment');
    assert.equal(row(assets,'1120').amount+row(assets,'1180').amount,800);
    assert.equal(row(assets,'1180').amount,-200);
    assert.deepEqual(r.cash.accounts.map(r => [r.code,r.balance]), [['1900',150],['1910',1410]]);
    assert.equal(r.cash.total,1560); assert.equal(r.profit_and_loss.net_income,-140);
    assert.equal(row(r.profit_and_loss.accounts,'9280').expense,-10);
    const cash = await report(clientId,'cash'); foots(cash);
    assert.equal(row(cash.profit_and_loss.accounts,'3100').revenue,50,'cash-only journal is admitted');
    assert.equal(cash.profit_and_loss.net_income,60,'noncash depreciation stays outside cash basis');
    assert.deepEqual((await seed.query('select * from ledger_accounts where client_id=$1 order by id', [nativeClientId])).rows,before);
  });
  await t.test('native ordinary/reserved/forced-close commands refuse without ledger, chart or close mutation', async () => {
    const snapshot = async () => ({
      ledger_accounts: (await seed.query('select * from ledger_accounts where client_id=$1 order by id', [nativeClientId])).rows,
      ledger_journals: (await seed.query('select * from ledger_journals where client_id=$1 order by id', [nativeClientId])).rows,
      ledger_lines: (await seed.query('select * from ledger_lines where client_id=$1 order by id', [nativeClientId])).rows,
      close_periods: (await seed.query('select * from close_periods where client_id=$1 order by id', [nativeClientId])).rows,
      close_checks: (await seed.query('select * from close_checks where client_id=$1 order by id', [nativeClientId])).rows
    });
    const before = await snapshot();
    assert.equal(before.ledger_accounts.length,58);
    assert.equal(before.ledger_journals.length,0);
    for (const code of ['1400','1180','9280','2950','2951','2371']) {
      await assert.rejects(() => post(nativeClientId, `refused-${code}`, [['1910',1,0],[code,0,1]]),
        error => error.code==='PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE' && error.details.reason_code==='processing_review_only' && error.retryable===false);
      assert.deepEqual(await snapshot(),before);
    }
    for (const force of [false,true]) {
      await assert.rejects(() => lockClosePeriodInDb({...period,clientId:nativeClientId,actorId:'member-a',force}),
        error => error.code==='PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE' && error.retryable===false);
      assert.deepEqual(await snapshot(),before);
    }
    const refusals=(await seed.query("select actor_id,metadata from audit_events where client_id=$1 and action='runtime.readiness_admission_blocked' order by id",[nativeClientId])).rows;
    assert.ok(refusals.some(r=>r.actor_id==='member-a' && r.metadata.boundary==='close_lock' && r.metadata.retryable===false));
    const r=await report(nativeClientId);foots(r);
    assert.equal(r.profit_and_loss.net_income,0);
    assert.equal((await readNativeChartLineage({query:seed.query.bind(seed),firmId,clientId:nativeClientId})).accounts.length,58);
  });
  await t.test('independent unmarked book: reserved GST signs, actual closing, residual earnings and close reversal through shared writer/report', async () => {
    const clientId = 'sg-c3-unmarked-report';
    await createLegacy(clientId);
    await setClientFlagStage(seed,{firmId,clientId,flagKey:'ENTITY_READINESS_ADMISSION',stage:'off',source:'manual',
      reason:'Independent synthetic shared-report fixture, no native posting authority',actorType:'firm_member',actorId:'member-a'});
    assert.equal(await readNativeChartLineage({query:seed.query.bind(seed),firmId,clientId}),null);
    for (const code of ['1910','2371','2950','2951','3100','7000']) {
      const id = await upsertLedgerAccountForJournal({client:seed,firmId,clientId,account:postingAccount(code),currency:'SGD'});
      assert.equal(id,ledgerRecordId('account',firmId,clientId,code));
      const stored = (await seed.query('select * from ledger_accounts where id=$1',[id])).rows[0];
      assert.equal(stored.account_type,metadata.get(code).account_type);
      assert.equal(stored.normal_balance,metadata.get(code).normal_balance);
      assert.equal(stored.payload.statutory_group,undefined,'supported unmarked owner does not author groups');
    }
    await post(clientId,'opening-profit-row',[['1910',100,0],['2371',0,100]]);
    await post(clientId,'output-gst',[['1910',1090,0],['3100',0,1000],['2950',0,90]]);
    await post(clientId,'input-gst',[['7000',300,0],['2951',30,0],['1910',0,330]]);
    const unclosed = await report(clientId); foots(unclosed);
    assert.deepEqual(unclosed.balance_sheet.liabilities.accounts.map(r=>[r.code,r.amount]),[['2950',90],['2951',-30]]);
    assert.equal(unclosed.balance_sheet.total_liabilities,60);
    assert.equal(earnings(unclosed),700,'2371 presence never suppresses actual unclosed profit');
    for (const a of unclosed.trial_balance.accounts) {
      assert.equal(a.id,ledgerRecordId('account',firmId,clientId,a.code));
      assert.equal(a.name,metadata.get(a.code).name); assert.equal(a.statutory_group,undefined);
    }
    const close = [['3100',1000,0],['7000',0,300],['2371',0,700]];
    await post(clientId,'actual-close',close);
    const closed = await report(clientId); foots(closed);
    assert.equal(earnings(closed),0); assert.equal(row(closed.balance_sheet.equity.accounts,'2371').amount,800);
    await post(clientId,'residual-profit',[['1910',40,0],['3100',0,40]]);
    const residual = await report(clientId); foots(residual);
    assert.equal(earnings(residual),40); assert.equal(residual.balance_sheet.total_equity,840);
    await post(clientId,'actual-close-reversal',close.map(([code,debit,credit])=>[code,credit,debit]));
    const reversed = await report(clientId); foots(reversed);
    assert.equal(earnings(reversed),740); assert.equal(row(reversed.balance_sheet.equity.accounts,'2371').amount,100);
    assert.equal(reversed.balance_sheet.total_equity,840);
  });
}
