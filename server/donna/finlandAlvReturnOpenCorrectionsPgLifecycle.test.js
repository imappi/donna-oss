// A VAT return over a period is not ready while a posting inside that period
// has an open correction case (postedCorrectionGap.js), against PostgreSQL
// through the real functions: the period read, the draft writer, the filing
// start, the owner question, the confirm path, the firm's view, and the UK
// nine-box preparation. The figures never change; only readiness does.
//
// The correction case is the stored record transactions.payload
// .coding_correction_required, seeded here in the shape
// recoverChangedCodingEvidenceInDb writes ('pending') and moved to the shape
// completeCodingEvidenceCorrectionWithClient writes ('corrected'), so the
// return's read is proven against the record, not a mock.
// Transmission never leaves the test: the filing channel is an injected fake.
// node --test server/donna/finlandAlvReturnOpenCorrectionsPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import * as registry from './statutoryRegistry.js';
import { createAlvReturnDraftInDb, getFinlandAlvReturnFromDb } from './finland/statutoryDb.js';
import { ALV_RETURN_ASK_KIND, resolveAlvReturnInbound } from './finland/alvReturnRoute.js';
import { SUOMIFI_MANDATE_SCOPE_TAX } from './finland/suomifiMandate.js';
import { prepareGbVatReturnFromDb } from './gb/vatReturnRoute.js';
import { ownerVatReturnFromDb } from './ownerVatReturnSurface.js';
import { buildAlvReturnViewModel } from '../../src/lib/alvReturnView.js';
import { ownerVatReturnCardState } from '../../src/lib/gbVatReturnView.js';

const { cancelAlvReturnInDb, getAlvReturnByIdInDb, getAlvReturnForPeriodInDb, markAlvReturnFiledInDb, startFinlandAlvReturnFilingInDb } = registry;

const pgUrl = process.env.DONNA_PG_TEST_URL;
const skip = !pgUrl && 'DONNA_PG_TEST_URL required';
const firmId = 'alv-open-corrections';
const clientId = 'fi-open-corrections';
const gbClientId = 'gb-open-corrections';
const migrationsDir = new URL('../../db/migrations/', import.meta.url);

async function freshBook(t) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_alvoc_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() });
  __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  for (const file of (await readdir(migrationsDir)).filter(n => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationsDir), 'utf8'));
  }
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic correction proof',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Korjaus Oy','FI','fi-oy','{}')", [clientId, firmId]);
  await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
    values('flag-alv-oc',$1,$2,'FINLAND_ALV_RETURN','canary','manual')`, [firmId, clientId]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Correction Ltd','GB',$3)`,
    [gbClientId, firmId, { vat_registration: { status: 'registered', registered_from: '2025-01-01', vat_registration_number: 'GB123456789' } }]);
  return pool;
}

// A bank line posted to its own journal: [code, type, debit, credit, taxType, role].
async function postLine(pool, { client = clientId, tx, date, currency = 'EUR', lines }) {
  const journal = `j-${tx}`;
  await pool.query(`insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status)
    values($1,$2,$3,'transaction',$4,$5,$6,'posted')`, [journal, firmId, client, tx, date, currency]);
  for (const [n, [code, type, debit, credit, taxType, role]] of lines.entries()) {
    const account = `${client}-${code}`;
    await pool.query(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,currency)
      values($1,$2,$3,$4,$4,$5,$6) on conflict do nothing`, [account, firmId, client, code, type, currency]);
    await pool.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,account_code,line_no,direction,debit,credit,amount,currency,tax_type,payload)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [`${journal}-${n + 1}`, journal, firmId, client, account, code, n + 1, debit ? 'debit' : 'credit', debit, credit, debit || credit, currency, taxType || null, role ? { role } : {}]);
  }
  await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
    values($1,$2,$3,$4,'Synthetic sale',1255,0,$5,'posted',$6)`, [tx, firmId, client, date, currency, { ledger_journal_id: journal }]);
  return journal;
}
const sale = (pool, date, tx, client) => postLine(pool, { client, tx, date,
  lines: [['3000', 'revenue', 0, 1000, 'ALV_25_5_OUTPUT'], ['2939', 'liability', 0, 255, null, 'alv_output'], ['1910', 'asset', 1255, 0]] });

// The case as recoverChangedCodingEvidenceInDb stores it, and as
// completeCodingEvidenceCorrectionWithClient leaves it.
const openCase = (pool, tx, extra = {}) => pool.query(
  `update transactions set payload = jsonb_set(payload, '{coding_correction_required}', $2::jsonb) where id = $1`,
  [tx, JSON.stringify({ version: 1, status: 'pending', reason: 'posted_source_evidence_changed', original_journal_id: `j-${tx}`,
    message: 'Evidence changed after autonomous posting.', next_action: 'recode_decided', actor_id: 'coding_convergence', ...extra })]);
const correctCase = (pool, tx) => pool.query(
  `update transactions set payload = jsonb_set(payload, '{coding_correction_required}',
     (payload->'coding_correction_required') || jsonb_build_object('status','corrected','actor_id','member-fixture','correction_journal_ids',jsonb_build_array('j-fix-' || id)))
   where id = $1`, [tx]);

const read = (period) => getFinlandAlvReturnFromDb({ firmId, clientId, period, readAt: '2026-11-10T09:00:00.000Z' });

test('real PG: an open correction case holds the return of its own period, and only that one', { skip }, async t => {
  const pool = await freshBook(t);
  await sale(pool, '2026-05-12', 'tx-may');
  await sale(pool, '2026-06-10', 'tx-june');
  await sale(pool, '2026-07-08', 'tx-july');
  await sale(pool, '2026-08-04', 'tx-aug');

  const beforeJune = await read('2026-06');
  assert.equal(beforeJune.review.status, 'ready', JSON.stringify(beforeJune.review));
  assert.equal(beforeJune.alvReturn.boxes['301'], 255);

  // June: one posted line with a pending case. July: a case that cannot move
  // because its own period is closed. May: a case already corrected.
  await openCase(pool, 'tx-june');
  await openCase(pool, 'tx-july', { reason: 'posted_tax_registration_changed', next_action: 'person_corrects_closed_period',
    recovery: { state: 'blocked', code: 'CODING_CORRECTION_TAX_PERIOD_CLOSED' } });
  await openCase(pool, 'tx-may');
  await correctCase(pool, 'tx-may');

  await t.test('the review is not ready and names the line; the figures are what the ledger says', async () => {
    const june = await read('2026-06');
    assert.equal(june.review.status, 'needs_review');
    assert.deepEqual(june.review.blockers, ['open_coding_corrections']);
    assert.equal(june.review.openCodingCorrections.count, 1);
    assert.equal(june.review.openCodingCorrections.truncated, false);
    assert.deepEqual(june.review.openCodingCorrections.items, [{ transaction_id: 'tx-june', journal_id: 'j-tx-june',
      journal_date: '2026-06-10', reason: 'posted_source_evidence_changed', next_action: 'recode_decided', recovery: null }]);
    assert.deepEqual(june.alvReturn, beforeJune.alvReturn, 'no figure moved');
  });

  await t.test('neighbours: no case, a corrected case, a case in another period', async () => {
    const may = await read('2026-05');
    assert.equal(may.review.status, 'ready', 'a corrected case does not hold its period');
    assert.equal(may.review.openCodingCorrections, undefined);
    const august = await read('2026-08');
    assert.equal(august.review.status, 'ready', 'a period with no case is unchanged');
    const july = await read('2026-07');
    assert.equal(july.review.status, 'needs_review');
    assert.deepEqual(july.review.openCodingCorrections.items.map(i => i.transaction_id), ['tx-july'],
      'the closed-period case holds only the period its line belongs to');
    assert.equal(july.review.openCodingCorrections.items[0].recovery.code, 'CODING_CORRECTION_TAX_PERIOD_CLOSED');
    const q2 = await read('2026-Q2');
    assert.deepEqual(q2.review.openCodingCorrections.items.map(i => i.transaction_id), ['tx-june'], 'the quarter holding June shows the June line');
    const q3 = await read('2026-Q3');
    assert.deepEqual(q3.review.openCodingCorrections.items.map(i => i.transaction_id), ['tx-july']);
  });

  await t.test('the firm view lists the line; the draft writer refuses', async () => {
    const june = await read('2026-06');
    const view = buildAlvReturnViewModel(june);
    assert.equal(view.status, 'needs_review');
    const blocker = view.blockers.find(b => b.code === 'open_coding_corrections');
    assert.equal(blocker.label, 'Kauden kirjauksia korjataan');
    assert.match(blocker.hint, /^1 tämän kauden kirjauksella on avoin korjaus/);
    assert.match(blocker.hint, /10\.6\.2026 \(tapahtuma tx-june, kirjaus j-tx-june\): tosite muuttui kirjauksen jälkeen\./);
    assert.equal(view.payableDisplay, buildAlvReturnViewModel(beforeJune).payableDisplay);
    const julyView = buildAlvReturnViewModel(await read('2026-07'));
    assert.match(julyView.blockers[0].hint, /kausi on lukittu tai ilmoitettu, korjauksen tekee ihminen/);
    await assert.rejects(createAlvReturnDraftInDb({ firmId, clientId, period: june.period,
      verdict: { alvReturn: june.alvReturn, review: june.review }, actorId: 'member-fixture' }),
    (error) => error.code === 'ALV_RETURN_NEEDS_REVIEW' && /open_coding_corrections/.test(error.message));
    assert.equal((await pool.query('select count(*)::int as n from alv_returns')).rows[0].n, 0);
  });

  const delivered = [];
  const start = (period, language = 'fi') => startFinlandAlvReturnFilingInDb({
    firmId, clientId, period, actorId: 'member-fixture',
    flagActsImpl: async () => true,
    scopeDriftImpl: async () => null,
    ownerLanguageImpl: async () => language,
    deliverAsksImpl: async (args) => { delivered.push(args); return { delivered: 0 }; }
  });

  await t.test('starting the filing escalates with the named blocker; the owner question carries the sentence', async () => {
    const result = await start('2026-06');
    assert.equal(result.action, 'escalated');
    assert.deepEqual(result.blockers, ['open_coding_corrections']);
    const ask = (await pool.query('select question, request_payload from client_evidence_requests where id = $1', [result.ask.id])).rows[0];
    assert.equal(ask.question, 'ALV-ilmoitus (2026-06) ei ole vielä valmis lähetettäväksi. Yhtä tämän kauden kirjausta korjataan parhaillaan, ja ilmoitus odottaa, kunnes korjaus on tehty.');
    assert.deepEqual(ask.request_payload.blockers, ['open_coding_corrections']);
    assert.equal((await pool.query('select count(*)::int as n from alv_returns')).rows[0].n, 0, 'no draft row');
    const english = await start('2026-07', 'en');
    const question = (await pool.query('select question from client_evidence_requests where id = $1', [english.ask.id])).rows[0].question;
    assert.equal(question, 'The VAT return (2026-07) is not ready to file yet. 1 posting in this period is being corrected, and the return waits until that is done.');
  });

  await t.test('after the case is corrected the next computation is ready, with the same figures', async () => {
    await correctCase(pool, 'tx-june');
    const june = await read('2026-06');
    assert.equal(june.review.status, 'ready');
    assert.deepEqual(june.review.blockers, []);
    assert.deepEqual(june.alvReturn, beforeJune.alvReturn);
    const result = await start('2026-06');
    assert.equal(result.action, 'confirmation_requested');
    assert.equal(result.alvReturn.status, 'draft_pending_confirmation');
  });

  await t.test('a case opened after the draft holds the confirm; after the correction "kyllä" files', async () => {
    const row = await getAlvReturnForPeriodInDb({ firmId, clientId, periodKey: '2026-06' });
    const alvReturnId = row.lifecycle.id;
    await sale(pool, '2026-06-20', 'tx-june-late');
    await openCase(pool, 'tx-june-late', { reason: 'posted_allocation_account_conflict' });
    const transmitted = []; const sent = []; const resolved = [];
    const reply = (text, n) => resolveAlvReturnInbound({
      firmId, clientId,
      ask: { id: `ask-${alvReturnId}`, evidence_type: ALV_RETURN_ASK_KIND, request_payload: { kind: ALV_RETURN_ASK_KIND, alv_return: { phase: 'confirm_request', alv_return_id: alvReturnId } } },
      replyText: text, message: { id: `wamid.synthetic-oc-${n}`, timestamp: '2026-11-10T09:00:00Z' }, phoneHash: 'ph-synthetic', actorId: 'owner-fixture', flagActs: true,
      getAlvReturnImpl: getAlvReturnByIdInDb,
      getMandateImpl: async ({ scope }) => (scope === SUOMIFI_MANDATE_SCOPE_TAX ? { id: 'suomifi-mandate-synthetic', scope, status: 'active', granted_on: '2026-01-15', expires_on: null } : null),
      assertFileableImpl: registry.assertAlvReturnFileableInDb, markFiledImpl: markAlvReturnFiledInDb, cancelImpl: cancelAlvReturnInDb,
      submitReturn: async (payload) => { transmitted.push(payload.period.key); return { channel: 'omavero_test', submission_id: `SUB-${payload.period.key}` }; },
      resolveAsk: async ({ askId, resolutionNote }) => resolved.push(`${askId}:${resolutionNote}`),
      sendText: async ({ text }) => sent.push(text)
    });
    const held = await reply('kyllä', 1);
    assert.equal(held.action, 'file_failed');
    assert.equal(held.error, 'ALV_RETURN_OPEN_CODING_CORRECTIONS');
    assert.deepEqual(transmitted, [], 'nothing reached the filing channel');
    assert.deepEqual(resolved, [], 'the ask stays open');
    assert.match(sent.at(-1), /^ALV-ilmoitusta \(2026-06\) ei lähetetty: osaa tämän kauden kirjauksista korjataan parhaillaan/);
    assert.equal((await getAlvReturnByIdInDb({ firmId, clientId, alvReturnId })).status, 'draft_pending_confirmation');
    await assert.rejects(registry.assertAlvReturnFileableInDb({ firmId, clientId, alvReturnId }), (error) => {
      assert.equal(error.code, 'ALV_RETURN_OPEN_CODING_CORRECTIONS');
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details.open_coding_corrections.items.map(i => i.transaction_id), ['tx-june-late']);
      return true;
    });

    await correctCase(pool, 'tx-june-late');
    const filed = await reply('kyllä', 2);
    assert.equal(filed.action, 'confirm_and_file', JSON.stringify(filed));
    assert.deepEqual(transmitted, ['2026-06']);
  });

  await t.test('a filed period whose line gets a case that cannot move: the row stays filed, the recompute names the line', async () => {
    await openCase(pool, 'tx-june', { reason: 'posted_tax_registration_changed', next_action: 'person_corrects_closed_period',
      recovery: { state: 'blocked', code: 'CODING_CORRECTION_TAX_PERIOD_CLOSED' } });
    const lifecycle = await getAlvReturnForPeriodInDb({ firmId, clientId, periodKey: '2026-06' });
    assert.equal(lifecycle.lifecycle.status, 'filed', 'the filed return is history and stays as filed');
    assert.equal(lifecycle.lifecycle.verdict.review.status, 'ready', 'its stored verdict is not rewritten');
    const june = await read('2026-06');
    assert.equal(june.review.status, 'needs_review');
    assert.deepEqual(june.review.openCodingCorrections.items.map(i => i.transaction_id), ['tx-june']);
    await assert.rejects(start('2026-06'), { code: 'ALV_RETURN_ALREADY_LIVE' }, 'nothing new is prepared over a filed period');
    assert.equal((await read('2026-08')).review.status, 'ready', 'the next period is not held by the earlier one');
  });

  await t.test('UK: the nine-box preparation refuses with the named code; the owner card says why', async () => {
    await pool.query(`insert into vat_periods(id,firm_id,client_id,vrn,period_key,start_date,end_date,due_date,status,hmrc_obligation_payload,synced_at)
      values('oc-vp',$1,$2,'123456789','26A2','2026-04-01','2026-06-30','2026-08-07','open','{}',now())`, [firmId, gbClientId]);
    await postLine(pool, { client: gbClientId, tx: 'gb-tx', date: '2026-05-05', currency: 'GBP',
      lines: [['3000', 'revenue', 0, 1000, 'VAT_SR_20_OUTPUT'], ['2200', 'liability', 0, 200, null, 'vat_output'], ['1200', 'asset', 1200, 0]] });
    const args = { firmId, clientId: gbClientId, periodKey: '26A2', asOf: '2026-07-01' };
    const ready = await prepareGbVatReturnFromDb(args);
    assert.equal(ready.vatReturn.boxes['1'], 200);
    await openCase(pool, 'gb-tx');
    await assert.rejects(prepareGbVatReturnFromDb(args), (error) => {
      assert.equal(error.code, 'GB_VAT_RETURN_OPEN_CODING_CORRECTIONS');
      assert.deepEqual(error.details.items.map(i => i.transaction_id), ['gb-tx']);
      return true;
    });
    const envelope = await ownerVatReturnFromDb(args);
    assert.equal(envelope.refusal.code, 'GB_VAT_RETURN_OPEN_CODING_CORRECTIONS');
    assert.deepEqual(ownerVatReturnCardState(envelope), { kind: 'blocked', code: 'GB_VAT_RETURN_OPEN_CODING_CORRECTIONS',
      message: 'Some postings in this period are being corrected, and the return waits until that is done.' });
    await correctCase(pool, 'gb-tx');
    assert.deepEqual(await prepareGbVatReturnFromDb(args), ready, 'corrected: the same return, unchanged figures');
  });
});
