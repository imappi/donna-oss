// Real PG (Finland, synthetic data): a person corrects a posted line with a
// dated adjustment through the authenticated /ledger/adjustment route.
//
// - The line's journal sits in a filed ALV return and the adjustment changes
//   its tax codes: the writer refuses with LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN
//   and says what would move (the original period, the filed return, the
//   amounts by tax code). With the person's acknowledgement of exactly that
//   movement it posts; the ledger.adjustment_posted receipt records the
//   period, the return, the lock state, the amounts and who acknowledged.
// - A pending registration case on that line (blocked with
//   CODING_CORRECTION_TAX_PERIOD_CLOSED) closes with the adjustment as its
//   receipt.
// - Neighbours unchanged: an open period, a locked period with no VAT change
//   (its receipt now says it corrects a locked period), and a filed return
//   whose reversal and replacement leave every tax code unchanged.
// - The adjustment's own date inside a filed return refuses
//   (LEDGER_ADJUSTMENT_DATE_IN_FILED_RETURN).
// - Donna's own late-bank-line reversal gets the refusal, records it once on
//   the document, the card target and an audit row, and does not post again;
//   a person's reversal through the route then self-heals the marker.
//   DONNA_PG_TEST_URL=... node --test server/donna/ledgerAdjustmentClosedPeriodPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import donnaRouter from '../../api/donna-router.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { recoverPostedCodingCorrectionsInDb } from './db/codingCorrection.js';
import { updateClientProfileInDb } from './db/clients.js';
import { postLedgerAdjustmentInDb } from './db/ledger.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { runDocumentSettlementReversalsForClient, documentSettlementReversalProposalId } from './documentSettlementReversal.js';
import { getFinlandAlvReturnFromDb } from './finland/statutoryDb.js';
import { DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY } from './documentDispositionShape.js';
import { TAX_REGISTRATION_RECHECK_FLAG } from './db/taxRegistrationChange.js';
import { correctionTaxMovement } from './ledgerCorrectionLines.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const skip = !pgUrl && 'DONNA_PG_TEST_URL required';
const firmId = 'adjustment-closed-period-proof';
const MEMBER_ID = 'member';
const ACCESS_TOKEN = 'synthetic-shared-access-token';
const GROSS = 125.5;
const NOT_REGISTERED = { status: 'not_registered' };
const REGISTERED_2026 = { status: 'registered', registered_from: '2026-01-01' };
const VERDICT = { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' };

async function harness(t) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_adj_closed_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 6 }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID: firmId, VERCEL: '1', VERCEL_PROJECT_ID: 'fixture',
    VERCEL_ENV: 'preview', VERCEL_DEPLOYMENT_ID: 'fixture', VERCEL_GIT_COMMIT_SHA: 'fixture',
    SUPABASE_URL: 'https://auth.invalid', SUPABASE_ANON_KEY: 'fixture', DONNA_ACCESS_TOKEN: ACCESS_TOKEN,
    OPENAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-no-network', RECONCILIATION_MATCHER_LLM_MODEL: '',
    UNIFIED_EXTRACTOR_MODEL: '', DONNA_AUTH_ALLOWED_EMAILS: 'member@auth.invalid', DONNA_DESKTOP_BLOB_DIR: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const realFetch = globalThis.fetch;
  // The only outbound calls: the auth lookup of the bearer, and the coder
  // that posts the fixture lines (it follows its input: no VAT on a date the
  // record says not registered).
  globalThis.fetch = async (endpoint, init) => {
    if (String(endpoint) === 'https://auth.invalid/auth/v1/user') {
      const token = init.headers.Authorization.replace('Bearer ', '');
      return new Response(JSON.stringify({ id: `user-${token}`, email: `${token}@auth.invalid` }));
    }
    assert.equal(String(endpoint), 'https://api.openai.com/v1/responses');
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => {
      const told = row.tax_registration?.status === 'not_registered' && row.tax_registration.treatments;
      return { transaction_id: row.id, ...VERDICT, tax_treatment: told ? told.purchase : VERDICT.tax_treatment,
        confidence: 'high', evidence_required: false, auto_explain_limit: 5000, reasoning: 'The settled source supports the account and the treatment.',
        posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
    });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  };
  const rewrites = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8')).rewrites;
  const server = http.createServer((req, res) => {
    const source = new URL(req.url, 'http://fixture');
    const rule = rewrites.find(row => row.source === source.pathname);
    if (!rule) { res.statusCode = 404; res.end('{}'); return; }
    req.url = new URL(rule.destination, 'http://fixture').pathname + new URL(rule.destination, 'http://fixture').search;
    donnaRouter(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const adjust = (body, token = MEMBER_ID) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/donna/firms/ledger/adjustment', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('HTTP fixture timed out')));
    req.on('error', reject); req.end(JSON.stringify({ firm_id: firmId, ...body }));
  });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    await pool.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic adjustment firm',$1)", [firmId]);
  await pool.query(`insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level)
    values($1,$2,'user-member','member@auth.invalid','Synthetic Member','admin','active','owner')`, [MEMBER_ID, firmId]);
  return { pool, adjust };
}

const flag = (pool, clientId, key, stage = 'auto') => pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,set_by_actor_type,set_by_actor_id,reason) values($1,$2,$3,$4,$5,'manual','firm_member',$6,'Synthetic proof') on conflict do nothing",
  [`${clientId}-${key}`, firmId, clientId, key, stage, MEMBER_ID]);
const seedFi = async (pool, clientId, registration) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Oikaisu Oy','FI','fi-oy',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash', alv_registration: registration }]);
  for (const key of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST', 'FINLAND_ALV_RETURN', TAX_REGISTRATION_RECHECK_FLAG]) await flag(pool, clientId, key);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
};
const postLine = async (pool, clientId, id, date) => {
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,$4,'Synthetic office supplies',0,$5,'EUR','needs_review','{}')",
    [id, firmId, clientId, date, GROSS]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,'Synthetic receipt.pdf','receipt','completed',$4,25.5,'EUR',$5,'{}')",
    [`doc-${id}`, firmId, clientId, GROSS, date]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'receipt',$5,$6,.98,'auto_matched','fixture','{}')",
    [`match-${id}`, firmId, clientId, id, `doc-${id}`, GROSS]);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } } });
  const journalId = (await row(pool, id)).payload.ledger_journal_id;
  assert.ok(journalId, `${id} posted: ${JSON.stringify((await row(pool, id)).payload.ledger_post_refusal || null)}`);
  return journalId;
};
const row = async (pool, id) => (await pool.query('select convergence_state,convergence_reason,payload from transactions where id=$1', [id])).rows[0];
const linesOf = async (pool, journalId) => (await pool.query(`select l.account_code,l.account_name,a.account_type,l.tax_type,l.payload->>'role' as role,l.debit::float8 as debit,l.credit::float8 as credit,l.currency
  from ledger_lines l join ledger_accounts a on a.id=l.account_id where l.journal_id=$1 order by l.line_no`, [journalId])).rows;
const journalsCorrecting = async (pool, journalId) => (await pool.query(`select id,journal_date::text,correction_type,correction_of_journal_id,reversal_of_journal_id,
  (select sum(debit)::float8 from ledger_lines where journal_id=j.id) as debit,(select sum(credit)::float8 from ledger_lines where journal_id=j.id) as credit
  from ledger_journals j where correction_of_journal_id=$1 order by correction_type desc, id`, [journalId])).rows;
const adjustmentAudits = async (pool, clientId) => (await pool.query("select actor_id,metadata from audit_events where client_id=$1 and action='ledger.adjustment_posted' order by id", [clientId])).rows;
const fileReturn = (pool, clientId, id, periodKey, startsOn, endsOn) => pool.query(`insert into alv_returns(id,firm_id,client_id,period_key,period_type,starts_on,ends_on,status,filed_at,filed_by)
  values($1,$2,$3,$4,'quarter',$5,$6,'filed',now(),$7)`, [id, firmId, clientId, periodKey, startsOn, endsOn, MEMBER_ID]);
const lockPeriod = (pool, clientId, id, start, end) => pool.query("insert into close_periods(id,firm_id,client_id,period_start,period_end,status,locked_at) values($1,$2,$3,$4,$5,'locked',now())", [id, firmId, clientId, start, end]);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
// The same posting with the expense on another account: every tax code nets to zero.
const otherExpense = async (pool, clientId, name) => (await pool.query("select code,name from ledger_accounts where client_id=$1 and account_type='expense' and name<>$2 order by name limit 1", [clientId, name])).rows[0];
const restated = (lines, expense) => lines.map(line => (line.account_type === 'expense' ? { ...line, account_code: expense.code, account_name: expense.name } : line));
// The registered treatment of the same gross: expense net with the input ALV code, the ALV leg, the bank.
const withInputAlv = (lines) => {
  const expense = lines.find(line => line.account_type === 'expense');
  const bank = lines.find(line => Number(line.credit) === GROSS);
  return [{ ...expense, tax_type: 'ALV_25_5_INPUT', debit: 100, credit: 0 },
    { account_code: '2940', account_name: 'Vähennettävä arvonlisävero', account_type: 'asset', role: 'alv_input', tax_type: null, debit: 25.5, credit: 0, currency: 'EUR' },
    { ...bank }];
};
const balanced = (journals) => { for (const journal of journals) assert.equal(journal.debit, journal.credit, `${journal.id} balances`); };

test('correctionTaxMovement: nets the reversal and the replacement by tax code and currency; no code and NONE move nothing', () => {
  const line = (tax_type, debit, credit, currency = 'EUR') => ({ account: { tax_type }, debit, credit, currency });
  assert.deepEqual(correctionTaxMovement([line('ALV_25_5_INPUT', 0, 100), line(null, 125.5, 0), line('ALV_25_5_INPUT', 100, 0), line('NONE', 0, 125.5)]), []);
  assert.deepEqual(correctionTaxMovement([line('B', 0, 10), line('A', 0, 100.1), line('A', 0.1, 0), line('A', 5, 0, 'SEK')]),
    [{ tax_type: 'A', currency: 'EUR', amount: -100 }, { tax_type: 'A', currency: 'SEK', amount: 5 }, { tax_type: 'B', currency: 'EUR', amount: -10 }]);
  assert.deepEqual(correctionTaxMovement([{ tax_type: 'ALV_24', debit: 3, credit: 0, currency: 'eur' }]), [{ tax_type: 'ALV_24', currency: 'EUR', amount: 3 }]);
});

test('real PG (FI): a filed ALV return, a person adjusts the line dated today and VAT moves: refused with the amounts, then posts on the acknowledgement; the pending case closes', { skip }, async t => {
  const { pool, adjust } = await harness(t);
  const clientId = 'fi-filed';
  await seedFi(pool, clientId, NOT_REGISTERED);
  await flag(pool, clientId, 'CODING_CORRECTION_AUTO_APPLY');
  const id = `${clientId}-purchase`;
  const journalId = await postLine(pool, clientId, id, '2026-06-02');
  const original = await linesOf(pool, journalId);
  assert.deepEqual(original.filter(line => line.tax_type && /ALV_25/.test(line.tax_type)), [], 'posted without input ALV');
  await fileReturn(pool, clientId, 'alv-2026-q2', '2026-Q2', '2026-04-01', '2026-06-30');
  // The registration record changes: Donna's correction case opens and is blocked on the filed return.
  await updateClientProfileInDb({ firmId, clientId, profilePatch: { alv_registration: REGISTERED_2026 }, actorId: MEMBER_ID, principal: { principalType: 'firm_member', principalId: MEMBER_ID } });
  await recoverChangedCodingEvidenceInDb({ firmId });
  await recoverPostedCodingCorrectionsInDb({ firmId, limit: 10 });
  const blocked = (await row(pool, id)).payload.coding_correction_required;
  assert.equal(blocked.status, 'pending');
  assert.equal(blocked.recovery.code, 'CODING_CORRECTION_TAX_PERIOD_CLOSED');
  assert.equal(blocked.next_action, 'person_corrects_closed_period');

  const draftBefore = (await getFinlandAlvReturnFromDb({ firmId, clientId, period: today() })).alvReturn;
  const body = { client_id: clientId, transaction_id: id, reason: 'Registered from 2026-01-01: claim the input ALV', lines: withInputAlv(original) };
  const refused = await adjust(body);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN');
  const details = refused.body.details;
  assert.equal(details.reason, 'acknowledgement_required');
  assert.equal(details.original_journal_id, journalId);
  assert.equal(details.original_journal_date, '2026-06-02');
  assert.equal(details.filed_return_id, 'alv-2026-q2');
  assert.equal(details.filed_return_period, '2026-Q2');
  assert.equal(details.close_period_locked, false);
  assert.equal(details.tax_moved.find(row => row.tax_type === 'ALV_25_5_INPUT').amount, 100);
  assert.match(refused.body.error, /filed VAT return 2026-Q2/);
  assert.deepEqual(await journalsCorrecting(pool, journalId), [], 'nothing posted');
  assert.deepEqual(await adjustmentAudits(pool, clientId), []);

  // A shared access token is not a person: it cannot acknowledge.
  const byToken = await adjust({ ...body, acknowledge_filed_return_digest: details.acknowledgement_digest }, ACCESS_TOKEN);
  assert.equal(byToken.status, 403, JSON.stringify(byToken.body));
  assert.equal(byToken.body.code, 'LEDGER_ADJUSTMENT_ACKNOWLEDGEMENT_PERSON_REQUIRED');
  // An acknowledgement of a different movement does not post.
  const stale = await adjust({ ...body, acknowledge_filed_return_digest: 'not-this-movement' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.reason, 'acknowledgement_does_not_match');
  // Donna never acknowledges for herself, whatever the call carries.
  await assert.rejects(postLedgerAdjustmentInDb({ firmId, clientId, transactionId: id, reason: 'Synthetic system call', lines: body.lines, actorId: 'system',
    filedReturnAcknowledgement: { digest: details.acknowledgement_digest, acknowledged_by: 'system', principal_type: 'firm_member' } }),
  error => error.code === 'LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN');

  const posted = await adjust({ ...body, acknowledge_filed_return_digest: details.acknowledgement_digest });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const journals = await journalsCorrecting(pool, journalId);
  assert.deepEqual(journals.map(j => [j.correction_type, j.correction_of_journal_id, j.reversal_of_journal_id]),
    [['reversal', journalId, journalId], ['replacement', journalId, null]]);
  balanced(journals);
  const [audit] = await adjustmentAudits(pool, clientId);
  assert.equal(audit.actor_id, MEMBER_ID);
  assert.deepEqual(audit.metadata.corrects_period, {
    journal_date: '2026-06-02', close_period_locked: false, close_period_id: null,
    return_filed: true, filed_return_id: 'alv-2026-q2', filed_return_period: '2026-Q2', tax_moved: details.tax_moved,
    filed_return_acknowledgement: { acknowledged_by: MEMBER_ID, principal_type: 'firm_member', digest: details.acknowledgement_digest,
      acknowledged_at: audit.metadata.corrects_period.filed_return_acknowledgement.acknowledged_at } });
  // The difference lands in the open period's return draft.
  const draftAfter = (await getFinlandAlvReturnFromDb({ firmId, clientId, period: today() })).alvReturn;
  assert.notDeepEqual(draftAfter, draftBefore, 'the open period now carries the correction');

  // The pending case closes with the adjustment as its receipt, and stays closed.
  const closed = await row(pool, id);
  assert.equal(closed.payload.coding_correction_required.status, 'corrected');
  assert.equal(closed.payload.coding_correction_required.authority_basis.basis, 'person_ledger_adjustment');
  assert.equal(closed.payload.coding_correction_required.authority_basis.actor_id, MEMBER_ID);
  assert.deepEqual(closed.payload.coding_correction_required.correction_journal_ids, audit.metadata.correction_journal_ids);
  assert.equal((await pool.query("select status from transaction_review_queue where item_id=$1 and reason='posted_evidence_changed'", [id])).rows[0]?.status ?? 'resolved', 'resolved');
  assert.doesNotMatch(String(closed.convergence_reason || ''), /TAX_PERIOD_CLOSED/);
  await recoverChangedCodingEvidenceInDb({ firmId });
  assert.equal((await row(pool, id)).payload.coding_correction_required.status, 'corrected');
});

test('real PG (FI): neighbours: an open period, a locked period with no VAT change, a filed return with every tax code unchanged; and a date inside a filed return', { skip }, async t => {
  const { pool, adjust } = await harness(t);
  // Open period: VAT moves, nothing is filed or locked: posts as today.
  const open = 'fi-open';
  await seedFi(pool, open, NOT_REGISTERED);
  const openJournal = await postLine(pool, open, `${open}-purchase`, '2026-06-02');
  const openPosted = await adjust({ client_id: open, transaction_id: `${open}-purchase`, reason: 'Synthetic open-period correction', lines: withInputAlv(await linesOf(pool, openJournal)) });
  assert.equal(openPosted.status, 200, JSON.stringify(openPosted.body));
  balanced(await journalsCorrecting(pool, openJournal));
  const openAudit = (await adjustmentAudits(pool, open))[0].metadata.corrects_period;
  assert.equal(openAudit.close_period_locked, false);
  assert.equal(openAudit.return_filed, false);
  assert.ok(openAudit.tax_moved.length > 0);
  assert.equal(openAudit.filed_return_acknowledgement, undefined);

  // Locked close period, no VAT change: allowed as today; the receipt says it corrects a locked period.
  const locked = 'fi-locked';
  await seedFi(pool, locked, NOT_REGISTERED);
  const lockedJournal = await postLine(pool, locked, `${locked}-purchase`, '2026-06-02');
  await lockPeriod(pool, locked, `${locked}-june`, '2026-06-01', '2026-06-30');
  const lockedLines = await linesOf(pool, lockedJournal);
  const lockedPosted = await adjust({ client_id: locked, transaction_id: `${locked}-purchase`, reason: 'Synthetic reclassification of a locked month',
    lines: restated(lockedLines, await otherExpense(pool, locked, lockedLines.find(l => l.account_type === 'expense').account_name)) });
  assert.equal(lockedPosted.status, 200, JSON.stringify(lockedPosted.body));
  balanced(await journalsCorrecting(pool, lockedJournal));
  const lockedAudit = (await adjustmentAudits(pool, locked))[0].metadata.corrects_period;
  assert.equal(lockedAudit.close_period_locked, true);
  assert.equal(lockedAudit.close_period_id, `${locked}-june`);
  assert.deepEqual(lockedAudit.tax_moved, []);

  // Filed return, every tax code unchanged: posts with no acknowledgement.
  const same = 'fi-filed-same';
  await seedFi(pool, same, REGISTERED_2026);
  const sameJournal = await postLine(pool, same, `${same}-purchase`, '2026-06-02');
  await fileReturn(pool, same, 'alv-same-q2', '2026-Q2', '2026-04-01', '2026-06-30');
  const sameLines = await linesOf(pool, sameJournal);
  assert.ok(sameLines.some(line => line.tax_type), `posted with a tax code: ${JSON.stringify(sameLines)}`);
  const samePosted = await adjust({ client_id: same, transaction_id: `${same}-purchase`, reason: 'Synthetic account-only restatement',
    lines: restated(sameLines, await otherExpense(pool, same, sameLines.find(l => l.account_type === 'expense').account_name)) });
  assert.equal(samePosted.status, 200, JSON.stringify(samePosted.body));
  const sameAudit = (await adjustmentAudits(pool, same))[0].metadata.corrects_period;
  assert.equal(sameAudit.return_filed, true);
  assert.deepEqual(sameAudit.tax_moved, []);

  // A date inside a filed return that is not locked: refused at the date.
  const inside = await adjust({ client_id: same, transaction_id: `${same}-purchase`, reason: 'Synthetic back-dated entry', journal_date: '2026-06-15', lines: [] });
  assert.equal(inside.status, 409, JSON.stringify(inside.body));
  assert.equal(inside.body.code, 'LEDGER_ADJUSTMENT_DATE_IN_FILED_RETURN');
  assert.equal(inside.body.details.filed_return_id, 'alv-same-q2');
});

test('real PG (FI): Donna\'s late-bank-line reversal of an entry in a filed return: refusal recorded once, no repost; a person\'s reversal self-heals it', { skip }, async t => {
  const { pool, adjust } = await harness(t);
  const clientId = 'fi-settlement';
  await seedFi(pool, clientId, REGISTERED_2026);
  await flag(pool, clientId, DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY);
  // A settlement entry (DR expense with its input ALV / CR owner funds) posted in Q2.
  const journal = 'lj-settlement-entry';
  await pool.query("insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status,posted_at) values($1,$2,$3,'document_settlement','doc-cash',  '2026-05-14','EUR','posted',now())", [journal, firmId, clientId]);
  const account = async (name) => (await pool.query('select id,code,name from ledger_accounts where client_id=$1 and name=$2', [clientId, name])).rows[0];
  const expense = await account('Travel'), funds = await account('Director loan');
  for (const [n, account, debit, credit, tax] of [[1, expense, GROSS, 0, 'ALV_25_5_INPUT'], [2, funds, 0, GROSS, null]]) {
    await pool.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,account_code,account_name,line_no,direction,debit,credit,amount,currency,tax_type)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'EUR',$13)`, [`${journal}-${n}`, journal, firmId, clientId, account.id, account.code, account.name, n, debit ? 'debit' : 'credit', debit, credit, GROSS, tax]);
  }
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,document_date,vendor_name,payload)
    values('doc-cash',$1,$2,'Synthetic fuel receipt.pdf','receipt','completed',$3,'EUR','2026-05-14','Synthetic Fuel',$4)`,
  [firmId, clientId, GROSS, { settlement_entry: { journal_id: journal, amount: GROSS, currency: 'EUR', expense_account: expense.name, owner_funds_account: funds.name } }]);
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('bank-late',$1,$2,'2026-05-15','Synthetic card payment',0,$3,'EUR','needs_review','{}')", [firmId, clientId, GROSS]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values('match-late',$1,$2,'bank-late','receipt','doc-cash',$3,.99,'confirmed','fixture','{}')", [firmId, clientId, GROSS]);
  await fileReturn(pool, clientId, 'alv-settle-q2', '2026-Q2', '2026-04-01', '2026-06-30');
  const sweep = async () => { const client = await pool.connect(); try { return await runDocumentSettlementReversalsForClient({ client, firmId, clientId }); } finally { client.release(); } };
  const refusalAudits = async () => (await pool.query("select metadata from audit_events where client_id=$1 and action='ledger.document_settlement_reversal_refused'", [clientId])).rows;

  const first = await sweep();
  assert.equal(first.needs_person, 1, JSON.stringify(first));
  assert.equal(first.reversed, 0);
  assert.equal(first.post_failures, 0);
  const doc = (await pool.query("select payload->'settlement_entry' as entry from documents where id='doc-cash'")).rows[0].entry;
  assert.equal(doc.reversal_refusal.code, 'LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN');
  assert.equal(doc.reversal_refusal.details.filed_return_id, 'alv-settle-q2');
  assert.deepEqual(doc.reversal_refusal.details.tax_moved, [{ tax_type: 'ALV_25_5_INPUT', currency: 'EUR', amount: -GROSS }]);
  assert.equal(doc.late_bank_line.needs_ledger_adjustment, true);
  assert.equal(doc.reversal, undefined);
  const target = (await pool.query('select apply_status,apply_error from proposal_targets where proposal_id=$1', [documentSettlementReversalProposalId('doc-cash')])).rows[0];
  assert.deepEqual(target, { apply_status: 'failed', apply_error: 'LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN' });
  assert.equal((await pool.query('select status from proposal_cards where id=$1', [documentSettlementReversalProposalId('doc-cash')])).rows[0].status, 'proposed');
  assert.equal((await refusalAudits()).length, 1);
  assert.deepEqual(await journalsCorrecting(pool, journal), []);

  // Later sweeps neither post nor record again.
  const second = await sweep();
  assert.equal(second.gathered, 0, JSON.stringify(second));
  assert.equal((await refusalAudits()).length, 1);

  // A person reverses it through the route with the acknowledgement; the next sweep self-heals the marker.
  const refused = await adjust({ client_id: clientId, original_journal_id: journal, reason: 'Late bank line: book the expense once, against the bank line' });
  assert.equal(refused.body.code, 'LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN');
  const posted = await adjust({ client_id: clientId, original_journal_id: journal, reason: 'Late bank line: book the expense once, against the bank line',
    acknowledge_filed_return_digest: refused.body.details.acknowledgement_digest });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const healed = await sweep();
  assert.equal(healed.self_healed, 1, JSON.stringify(healed));
  const after = (await pool.query("select payload->'settlement_entry' as entry from documents where id='doc-cash'")).rows[0].entry;
  assert.equal(after.reversal.journal_id, posted.body.ledger_adjustment.journals[0].ledger_journal_id);
});

// The adjustment writer passes the readiness admission every other journal
// writer passes (__writeLedgerJournalRows). A book enrolled in
// ENTITY_READINESS_ADMISSION with no certified readiness refuses a manual
// adjustment and a correction alike, writes nothing, and receipts the refusal.
// An unenrolled book (every other test here) posts as before.
test('real PG (FI): a book whose readiness is not certified refuses an adjustment through the route, as every other journal writer does', { skip }, async t => {
  const { pool, adjust } = await harness(t);
  const clientId = 'fi-not-ready';
  await seedFi(pool, clientId, NOT_REGISTERED);
  const journalId = await postLine(pool, clientId, `${clientId}-purchase`, '2026-06-02');
  await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,set_by_actor_type,set_by_actor_id,reason)
    values($1,$2,$3,'ENTITY_READINESS_ADMISSION','canary','manual','firm_member',$4,'Synthetic readiness target')`, [`${clientId}-readiness`, firmId, clientId, MEMBER_ID]);
  const journals = async () => (await pool.query('select count(*)::int n from ledger_journals where client_id=$1', [clientId])).rows[0].n;
  const before = await journals();
  const lines = (await linesOf(pool, journalId)).map(line => ({ ...line, debit: line.credit, credit: line.debit }));
  for (const body of [{ reason: 'Synthetic manual entry', lines, journal_date: '2026-11-02' },
    { transaction_id: `${clientId}-purchase`, reason: 'Synthetic correction' }]) {
    const refused = await adjust({ client_id: clientId, ...body });
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'ENTITY_READINESS_ADMISSION_BLOCKED');
  }
  assert.equal(await journals(), before, 'nothing written');
  const receipts = (await pool.query(`select resource_type, resource_id, metadata->>'boundary' as boundary from audit_events
    where client_id=$1 and action='runtime.readiness_admission_blocked' order by id`, [clientId])).rows;
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every(row => row.boundary === 'ledger_write' && row.resource_type === 'ledger_source' && row.resource_id.startsWith('adjustment:')), JSON.stringify(receipts));
  assert.deepEqual(await adjustmentAudits(pool, clientId), []);
});
