// SG GST F5 engine regressions on REAL PostgreSQL (the mocked seam proves nothing
// for a status filter or a Date column). One disposable database, the complete
// migration chain, the production readers/writers. Incident-shaped fixtures live
// here; the general contract lives in gstReturn.js / statutoryDb.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { prepareCiHostPostgres } from '../../../scripts/prepare_ci_host_postgres.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../db/pool.js';
import { lockClosePeriodInDb } from '../db/close.js';
import { getSingaporeGstReturnFromDb, createGstReturnDraftInDb, getGstReturnByIdInDb,
  startSingaporeGstReturnFilingInDb } from './statutoryDb.js';
import { gstReviewQuestion } from './gstReturnRoute.js';
import { getSingaporeGstDraftArtifactFromDb } from './gstReturnArtifact.js';
import { resolveGstPeriod } from './gstReturn.js';
import { renderGstF5Submission } from './iras/submitGstF5.js';

const firmId = 'sg2a-firm';
const readAt = '2026-09-29T12:00:00.000Z';
const period = resolveGstPeriod('2026-Q2');

test('SG GST engine fixes — real PostgreSQL', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable DONNA_PG_TEST_URL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const database = `sg2a_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${database}`;
  const envKeys = { DATABASE_URL: url.toString(), SINGAPORE_GST_RETURN: 'true', SINGAPORE_GST_RETURN_CLIENTS: '*',
    CLIENT_CONFIG_FORCE_DISABLE: undefined };
  const prior = Object.fromEntries(Object.keys(envKeys).map(key => [key, process.env[key]]));
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
  const migrationRoot = new URL('../../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter(f => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, migrationRoot), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  for (const [key, value] of Object.entries(envKeys)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  __setFirmDbPoolForTests(pool);
  await seed.query('insert into firms(id,name,slug) values($1,$1,$1)', [firmId]);

  let clientSeq = 0;
  const newClient = async () => {
    const id = `sg2a-client-${++clientSeq}`;
    await seed.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile)
      values($1,$2,$1,'SG',$3)`, [id, firmId, { accountingCurrency: 'SGD', gst_period: 'quarter' }]);
    await seed.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
      values($1,$2,$3,'SINGAPORE_GST_RETURN','canary','manual')`, [`flag-${id}`, firmId, id]);
    return id;
  };
  // A posted journal: lines are [accountCode, accountType, debit, credit, taxType, role, currency].
  const post = async ({ clientId, id, date = '2026-04-15', status = 'posted', currency = 'SGD', lines }) => {
    await seed.query(`insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status)
      values($1,$2,$3,'sg2a_fixture',$1,$4,$5,$6)`, [id, firmId, clientId, date, currency, status]);
    for (const [n, [code, type, debit, credit, taxType, role, lineCurrency]] of lines.entries()) {
      const account = `${clientId}-${code}`;
      await seed.query(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,currency)
        values($1,$2,$3,$4,$4,$5,'SGD') on conflict do nothing`, [account, firmId, clientId, code, type]);
      await seed.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,account_code,line_no,
        direction,debit,credit,amount,currency,tax_type,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`${id}-${n + 1}`, id, firmId, clientId, account, code, n + 1, debit ? 'debit' : 'credit', debit, credit,
        debit || credit, lineCurrency || currency, taxType || null, role ? { role } : {}]);
    }
  };
  // The reviewed fixture: sale 1000 (+90 output GST) and a 1000 purchase's 90 input GST is NOT
  // modelled here — the quarter owes exactly the output tax.
  const saleLines = (amount = 1000, gst = amount * 0.09) => [
    ['3000', 'revenue', 0, amount, 'GST_SR_9_OUTPUT'],
    ['2950', 'liability', 0, gst, null, 'gst_output'],
    ['1910', 'asset', amount + gst, 0]
  ];
  const compute = clientId => getSingaporeGstReturnFromDb({ firmId, clientId, period: period.key, readAt });

  await t.test('F-1: locking the close period does not turn a payable quarter into a ready nil return', async () => {
    const clientId = await newClient();
    await post({ clientId, id: 'f1-sale', lines: saleLines() });
    await post({ clientId, id: 'f1-draft', status: 'draft', lines: saleLines(5000) });
    await post({ clientId, id: 'f1-void', status: 'voided', lines: saleLines(7000) });
    // A bank transaction whose posting is the sale journal: the source-readiness
    // census must keep seeing it as posted once the lock seals the journal.
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,currency,coding_state)
      values('f1-tx',$1,$2,'2026-04-15','f1-tx',1090,'SGD','posted')`, [firmId, clientId]);
    await seed.query("update ledger_journals set source_type='transaction', source_id='f1-tx' where id='f1-sale'");
    const before = await compute(clientId);
    assert.equal(before.review.status, 'ready');
    assert.equal(before.gstReturn.boxes['1'], 1000);
    assert.equal(before.gstReturn.boxes['6'], 90);

    await lockClosePeriodInDb({ firmId, clientId, periodStart: period.starts_on, periodEnd: period.ends_on,
      actorId: 'sg2a-actor', force: true });
    const locked = (await seed.query("select status from ledger_journals where id='f1-sale'")).rows[0].status;
    assert.equal(locked, 'closed', 'the real lock flips posted journals to closed');

    const after = await compute(clientId);
    assert.deepEqual(after.gstReturn, before.gstReturn, 'identical boxes after the lock');
    assert.equal(after.review.status, 'ready');
    assert.equal(after.gstReturn.nilReturn, false);
    // Neighbours: draft and voided journals stay excluded, before and after the lock.
    assert.equal(after.gstReturn.boxes['1'], 1000);

    await seed.query(`update client_capability_config set stage='canary' where client_id=$1`, [clientId]);
    const artifact = await getSingaporeGstDraftArtifactFromDb({ firmId, clientId, period: period.key, readAt });
    assert.equal(artifact.gstReturn.boxes['6'], 90, 'the artifact identity guard also reads closed journals');
    const tx = artifact.source_readiness.transactions.find(row => row.id === 'f1-tx');
    assert.deepEqual(tx.posted_journal_ids, ['f1-sale'], 'the posted-journal census reads closed journals');
    assert.ok(!tx.reasons.includes('transaction_unposted'));
  });

  await t.test('F-6: a non-SGD line is refused by the reader itself, before a draft can be minted', async () => {
    const clientId = await newClient();
    await post({ clientId, id: 'f6-usd', currency: 'USD', lines: saleLines(5000) });
    await post({ clientId, id: 'f6-sgd', lines: [
      ['3000', 'revenue', 0, 700, 'GST_SR_9_OUTPUT', null, 'USD'],
      ['2950', 'liability', 0, 63, null, 'gst_output', 'USD'],
      ['1910', 'asset', 763, 0, null, null, 'USD']
    ] });
    await assert.rejects(compute(clientId), { code: 'SINGAPORE_GST_DRAFT_LEDGER_IDENTITY_INVALID' });
    const before = Number((await seed.query('select count(*) from gst_returns')).rows[0].count);
    await assert.rejects(startSingaporeGstReturnFilingInDb({ firmId, clientId, period: period.key,
      flagActsImpl: async () => true }), { code: 'SINGAPORE_GST_DRAFT_LEDGER_IDENTITY_INVALID' });
    assert.equal(Number((await seed.query('select count(*) from gst_returns')).rows[0].count), before, 'no draft row minted');
    // Neighbour: an all-SGD client still computes.
    const sgd = await newClient();
    await post({ clientId: sgd, id: 'f6-ok', lines: saleLines() });
    assert.equal((await compute(sgd)).review.status, 'ready');
  });

  await t.test('F-9: the persisted draft row is a valid IRAS submission (period dates are ISO days)', async () => {
    const clientId = await newClient();
    await post({ clientId, id: 'f9-sale', lines: saleLines() });
    const computed = await compute(clientId);
    const draft = await createGstReturnDraftInDb({ firmId, clientId, period: computed.period,
      verdict: { gstReturn: computed.gstReturn, review: computed.review, provenance: computed.provenance } });
    const row = await getGstReturnByIdInDb({ firmId, clientId, gstReturnId: draft.id });
    assert.equal(row.starts_on, '2026-04-01');
    assert.equal(row.ends_on, '2026-06-30');
    const rendered = renderGstF5Submission({ ...row.verdict.gstReturn,
      period: { key: row.period_key, type: row.period_type, starts_on: row.starts_on, ends_on: row.ends_on },
      filer: { uen: '201912345K', gstRegistrationNumber: 'M12345678X' } });
    assert.equal(rendered.ok, true, JSON.stringify(rendered));
  });

  await t.test('F-8/F-16: a needs_review NIL return never reaches the confirm summary; every blocker asks the owner something answerable', async () => {
    const clientId = await newClient();
    // Gross-only book: one uncoded expense, nothing coded — nilReturn true but needs_review.
    await post({ clientId, id: 'f8-gross', lines: [['7000', 'expense', 109, 0], ['1910', 'asset', 0, 109]] });
    const computed = await compute(clientId);
    assert.equal(computed.gstReturn.nilReturn, true);
    assert.equal(computed.review.status, 'needs_review');
    await assert.rejects(createGstReturnDraftInDb({ firmId, clientId, period: computed.period,
      verdict: { gstReturn: computed.gstReturn, review: computed.review, provenance: computed.provenance } }),
    { code: 'GST_RETURN_NEEDS_REVIEW' });
    const asks = [];
    const started = await startSingaporeGstReturnFilingInDb({ firmId, clientId, period: period.key,
      flagActsImpl: async () => true, deliverAsksImpl: async () => {},
      createAskImpl: async args => { asks.push(args); return { id: 'ask-1' }; } });
    assert.equal(started.action, 'escalated', 'the nil summary is unreachable for a needs_review verdict');
    assert.equal(asks[0].evidenceType, 'gst_return_review');
    assert.match(asks[0].question, /booked without a GST treatment/);
    assert.equal(Number((await seed.query('select count(*) from gst_returns where client_id=$1', [clientId])).rows[0].count), 0);

    const header = `The GST F5 for ${period.key} isn't ready to file yet.`;
    for (const blocker of ['uncoded_revenue_lines', 'incompatible_tax_lines', 'reverse_charge_input_tax_assessment_required',
      'gst_not_coded_at_posting', 'control_account_mismatch', 'negative_return_box']) {
      const question = gstReviewQuestion({ period, review: { blockers: [blocker], uncodedRevenueLines: [1], incompatibleLines: [1],
        inputTaxAssessmentLines: [1], negativeBoxes: ['1'], controlCheck: { outputTax: { expected: 90, actual: 80 } } } });
      assert.ok(question.length > header.length + 20 && question.startsWith(header), `${blocker}: ${question}`);
    }
  });
});
