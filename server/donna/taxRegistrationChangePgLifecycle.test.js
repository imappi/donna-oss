// Real PG (FI and GB, synthetic data): the VAT/ALV registration record
// changes after lines have posted. A posted line whose registration status on
// its date is now the opposite of the status it was posted under opens the
// existing correction case (codingEvidence.js) with the old and new status;
// its journal is unchanged; the persisted convergence state says not finished
// under a key that names the registration change; and the change's own
// receipt names the lines it touched. A locked period opens the case and
// posts nothing. A line outside the changed dates, a record change that moves
// no line's status, the gate off, and a Singapore line are untouched.
//   DONNA_PG_TEST_URL=... node --test server/donna/taxRegistrationChangePgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { recoverPostedCodingCorrectionsInDb } from './db/codingCorrection.js';
import { updateClientProfileInDb } from './db/clients.js';
import { applyTaxRegistrationAnswer, TAX_REGISTRATION_LANE } from './taxRegistrationReply.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { GB_DEFAULT_CHART } from './gb/defaultChart.js';
import { ledgerRecordId } from './db/shared.js';
import { TAX_REGISTRATION_RECHECK_FLAG } from './db/taxRegistrationChange.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'tax-registration-change-proof';
const skip = !pgUrl && 'DONNA_PG_TEST_URL required';

async function freshDb(t) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_tax_reg_change_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  const priorKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-only';
  t.after(async () => { if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic registration change firm',$1)", [firmId]);
  await pool.query("insert into firm_members(id,firm_id,name,email,role,status) values('member-firm',$1,'Synthetic Member','member@example.test','admin','active')", [firmId]);
  return pool;
}

const OWNER = 'owner@example.test';
const MEMBER = { actorId: 'member-firm', principal: { principalType: 'firm_member', principalId: 'member-firm' } };
const AUTO = { CODING_AUTO_POST: { stage: 'auto' } };
const flag = (pool, clientId, key, stage = 'auto') => pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,$5,'manual')", [`${clientId}-${key}`, firmId, clientId, key, stage]);

const seedGb = async (pool, clientId, profile = {}, { gate = true } = {}) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Registration Ltd','gb',$3)", [clientId, firmId, { jurisdiction: 'gb', accounting_system: 'none', accounting_basis: 'cash', ...profile }]);
  for (const key of ['JURISDICTION_TAX_CODING', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST', ...(gate ? [TAX_REGISTRATION_RECHECK_FLAG] : [])]) await flag(pool, clientId, key);
  for (const a of GB_DEFAULT_CHART) await pool.query("insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,canonical_role,status) values($1,$2,$3,$4,$5,$6,$7,'GBP',$8,'active')",
    [ledgerRecordId('account', firmId, clientId, a.code), firmId, clientId, a.code, a.name_en, a.account_type, a.normal_balance, a.canonical_role || null]);
};
const seedFi = async (pool, clientId, profile = {}, { gate = true } = {}) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Rekisteröinti Oy','FI','fi-oy',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash', ...profile }]);
  for (const key of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST', ...(gate ? [TAX_REGISTRATION_RECHECK_FLAG] : [])]) await flag(pool, clientId, key);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
};
const FI = { label: 'FI', seed: seedFi, currency: 'EUR', gross: 125.5, tax: 25.5, field: 'alv_registration',
  verdict: { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' }, sale: { proposed_account: 'Sales', tax_treatment: 'ALV 25,5 %' } };
const GB = { label: 'GB', seed: seedGb, currency: 'GBP', gross: 120, tax: 20, field: 'vat_registration',
  verdict: { proposed_account: 'Software subscriptions', tax_treatment: 'VAT 20%' }, sale: { proposed_account: 'Sales', tax_treatment: 'VAT 20%' } };
const NOT_REGISTERED = { status: 'not_registered' };
const REGISTERED_2026 = { status: 'registered', registered_from: '2026-01-01' };

// The coder follows its input: on a date the record says not registered it
// picks the no-VAT treatment it is offered, otherwise the rated one.
const mockCoder = (t, country) => {
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(String(endpoint), 'https://api.openai.com/v1/responses');
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => {
      const sale = Number(row.money_in) > 0;
      const verdict = sale ? country.sale : country.verdict;
      const told = row.tax_registration?.status === 'not_registered' && row.tax_registration.treatments;
      return { transaction_id: row.id, ...verdict, tax_treatment: told ? told[sale ? 'sale' : 'purchase'] : verdict.tax_treatment,
        confidence: 'high', evidence_required: false, auto_explain_limit: 5000, reasoning: 'The settled source supports the account and the treatment.',
        posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
    });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
};

const addLine = async (pool, clientId, country, id, date, { sale = false } = {}) => {
  const family = sale ? 'sales_invoice' : 'receipt';
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,$4,$5,$6,$7,$8,'needs_review','{}')",
    [id, firmId, clientId, date, `Synthetic ${sale ? 'customer payment' : 'office supplies'}`, sale ? country.gross : 0, sale ? 0 : country.gross, country.currency]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,'{}')",
    [`doc-${id}`, firmId, clientId, sale ? 'Synthetic sales invoice.pdf' : 'Synthetic receipt.pdf', family, country.gross, country.tax, country.currency, date]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,$5,$6,$7,.98,'auto_matched','fixture','{}')",
    [`match-${id}`, firmId, clientId, id, family, `doc-${id}`, country.gross]);
};
const postAll = async (pool, clientId, ids) => {
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  for (const id of ids) await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: AUTO });
  for (const id of ids) assert.ok((await row(pool, id)).payload.ledger_journal_id, `${id} posted: ${JSON.stringify((await row(pool, id)).payload.ledger_post_refusal || null)}`);
};
const row = async (pool, id) => (await pool.query('select coding_state,convergence_state,convergence_reason,payload from transactions where id=$1', [id])).rows[0];
// Every journal and line a source ever posted, byte for byte.
const ledgerOf = async (pool, ids) => (await pool.query(`select j.id, j.source_id, j.journal_date::text, j.status, l.account_code, l.tax_type, l.debit::text, l.credit::text
    from ledger_journals j left join ledger_lines l on l.journal_id = j.id
   where j.firm_id = $1 and (j.source_id = any($2::text[]) or j.payload->>'transaction_id' = any($2::text[]) or j.correction_of_journal_id in
     (select id from ledger_journals where source_id = any($2::text[]))) order by j.id, l.line_no`, [firmId, ids])).rows;
const vatLegs = (ledger) => ledger.filter(line => Number(line.debit) === FI.tax || Number(line.credit) === FI.tax || Number(line.debit) === GB.tax || Number(line.credit) === GB.tax);
const profileAudit = async (pool, clientId) => (await pool.query("select metadata from audit_events where client_id=$1 and action='client.profile.update' order by id desc limit 1", [clientId])).rows[0].metadata;

// The owner's answer through the registration lane's writer, in one transaction.
const ownerAnswers = async (pool, clientId, answer) => {
  const request = (await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,audience,status,evidence_type,question,request_payload)
    values($1,$2,$3,'client','open','business_purpose','Synthetic registration question',$4) returning *`,
  [`ask-${clientId}`, firmId, clientId, { lane: TAX_REGISTRATION_LANE, tax_registration: { client_id: clientId } }])).rows[0];
  const client = await pool.connect();
  try {
    await client.query('begin');
    const outcome = await applyTaxRegistrationAnswer({ client, firmId, request, actorId: OWNER, actorType: 'client', answer, interpretation: { model: 'fixture-reader' } });
    await client.query('commit');
    return outcome;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};
const firmCorrects = (clientId, record) => updateClientProfileInDb({ firmId, clientId, profilePatch: { [record.field]: record.value }, ...MEMBER });

const assertCaseOpened = async (pool, id, { posted, current, basis, journalId }) => {
  const line = await row(pool, id);
  const requirement = line.payload.coding_correction_required;
  assert.equal(requirement?.status, 'pending', `${id}: ${JSON.stringify(requirement)}`);
  assert.equal(requirement.reason, 'posted_tax_registration_changed');
  assert.equal(requirement.tax_registration.posted.status, posted);
  assert.equal(requirement.tax_registration.posted.basis, basis);
  assert.equal(requirement.tax_registration.current.status, current);
  assert.equal(requirement.tax_registration.on_date, '2026-06-02');
  assert.equal(requirement.original_journal_id, journalId);
  assert.equal(line.convergence_state, 'hanging', 'a line with an open correction case is not finished');
  assert.equal(line.convergence_reason, 'posted_tax_registration_changed');
  const review = (await pool.query("select status,payload from transaction_review_queue where item_id=$1 and reason='posted_evidence_changed'", [id])).rows[0];
  assert.equal(review?.status, 'open', 'the firm sees the case in its review queue');
  return requirement;
};

for (const country of [FI, GB]) {
  for (const writer of ['owner answer', 'profile writer']) {
    test(`real PG (${country.label}): a purchase and a sale posted without VAT; the ${writer} records registration from an earlier date; the correction case opens, the journals are unchanged`, { skip }, async t => {
      const pool = await freshDb(t);
      const clientId = `${country.label.toLowerCase()}-${writer === 'owner answer' ? 'answer' : 'firm'}`;
      await country.seed(pool, clientId, { [country.field]: NOT_REGISTERED });
      mockCoder(t, country);
      const purchase = `${clientId}-purchase`, sale = `${clientId}-sale`, earlier = `${clientId}-2025`;
      await addLine(pool, clientId, country, purchase, '2026-06-02');
      await addLine(pool, clientId, country, sale, '2026-06-02', { sale: true });
      await addLine(pool, clientId, country, earlier, '2025-11-03');
      await postAll(pool, clientId, [purchase, sale, earlier]);
      const before = await ledgerOf(pool, [purchase, sale, earlier]);
      assert.equal(vatLegs(before).length, 0, 'posted without VAT');
      for (const id of [purchase, sale]) assert.equal((await row(pool, id)).payload.ai_suggestion.tax_registration_fact.status, 'not_registered');

      if (writer === 'owner answer') {
        const outcome = await ownerAnswers(pool, clientId, { registered: 'yes', registered_from: '2026-01-01', registered_until: null });
        assert.equal(outcome.recorded, true, JSON.stringify(outcome));
        const receipt = (await pool.query("select metadata from audit_events where client_id=$1 and action='tax_registration.owner_answer_recorded'", [clientId])).rows[0].metadata;
        assert.deepEqual(receipt.posted_lines_affected.lines.map(line => line.transaction_id).sort(), [purchase, sale].sort(), 'the answer\'s receipt names the lines it touched');
      } else {
        await firmCorrects(clientId, { field: country.field, value: REGISTERED_2026 });
      }
      // The change's receipt, in the profile writer's transaction.
      const change = (await profileAudit(pool, clientId)).tax_registration_change;
      assert.equal(change.count, 2);
      assert.equal(change.correction_cases_enabled, true);
      assert.deepEqual(change.lines.map(line => [line.transaction_id, line.posted, line.current, line.correction_case]).sort(),
        [[purchase, 'not_registered', 'registered', true], [sale, 'not_registered', 'registered', true]].sort());

      await recoverChangedCodingEvidenceInDb({ firmId });
      for (const id of [purchase, sale]) {
        const requirement = await assertCaseOpened(pool, id, { posted: 'not_registered', current: 'registered', basis: 'coding_receipt',
          journalId: (await row(pool, id)).payload.ledger_journal_id });
        assert.equal(requirement.tax_registration.direction, 'became_registered');
        assert.equal(requirement.tax_registration.period.locked, false);
        assert.equal(requirement.next_action, 'recode_decided');
      }
      // Outside the changed dates (2025 stays not registered): untouched.
      const outside = await row(pool, earlier);
      assert.equal(outside.payload.coding_correction_required, undefined);
      assert.equal(outside.convergence_state, 'auto_reconciled');
      // A second tick opens nothing new.
      const events = async () => (await pool.query("select count(*)::int n from audit_events where client_id=$1 and action='coding.posted_evidence_reconsideration'", [clientId])).rows[0].n;
      assert.equal(await events(), 2);
      await recoverChangedCodingEvidenceInDb({ firmId });
      assert.equal(await events(), 2);
      // The existing consumer: with no correction grant it waits for a person,
      // and the state still names the registration change.
      await recoverPostedCodingCorrectionsInDb({ firmId, limit: 10 });
      for (const id of [purchase, sale]) {
        const line = await row(pool, id);
        assert.equal(line.payload.coding_correction_required.recovery?.code, 'CODING_CORRECTION_AUTHORITY_REQUIRED');
        assert.equal(line.convergence_reason, 'posted_tax_registration_correction_blocked:CODING_CORRECTION_AUTHORITY_REQUIRED');
      }
      assert.deepEqual(await ledgerOf(pool, [purchase, sale, earlier]), before, 'the posted journals are unchanged');
    });
  }

  test(`real PG (${country.label}): posted with VAT while registered; the firm records not registered; the case opens on both lines`, { skip }, async t => {
    const pool = await freshDb(t);
    const clientId = `${country.label.toLowerCase()}-deregistered`;
    await country.seed(pool, clientId, { [country.field]: REGISTERED_2026 });
    mockCoder(t, country);
    const purchase = `${clientId}-purchase`, sale = `${clientId}-sale`;
    await addLine(pool, clientId, country, purchase, '2026-06-02');
    await addLine(pool, clientId, country, sale, '2026-06-02', { sale: true });
    await postAll(pool, clientId, [purchase, sale]);
    const before = await ledgerOf(pool, [purchase, sale]);
    assert.equal(vatLegs(before).length, 2, `posted with VAT: ${JSON.stringify(before)}`);
    await firmCorrects(clientId, { field: country.field, value: NOT_REGISTERED });
    const change = (await profileAudit(pool, clientId)).tax_registration_change;
    assert.deepEqual(change.lines.map(line => [line.transaction_id, line.posted, line.current]).sort(),
      [[purchase, 'registered', 'not_registered'], [sale, 'registered', 'not_registered']].sort());
    await recoverChangedCodingEvidenceInDb({ firmId });
    for (const id of [purchase, sale]) {
      const requirement = await assertCaseOpened(pool, id, { posted: 'registered', current: 'not_registered', basis: 'posted_vat_code',
        journalId: (await row(pool, id)).payload.ledger_journal_id });
      assert.equal(requirement.tax_registration.direction, 'became_not_registered');
      assert.ok(requirement.tax_registration.posted.vat_codes.length >= 1);
    }
    assert.deepEqual(await ledgerOf(pool, [purchase, sale]), before);
  });

  test(`real PG (${country.label}): a locked period: the case opens and says so, and nothing is posted`, { skip }, async t => {
    const pool = await freshDb(t);
    const clientId = `${country.label.toLowerCase()}-locked`;
    await country.seed(pool, clientId, { [country.field]: NOT_REGISTERED });
    mockCoder(t, country);
    const purchase = `${clientId}-purchase`;
    await addLine(pool, clientId, country, purchase, '2026-06-02');
    await postAll(pool, clientId, [purchase]);
    await pool.query("insert into close_periods(id,firm_id,client_id,period_start,period_end,status,locked_at) values($1,$2,$3,'2026-06-01','2026-06-30','locked',now())", [`${clientId}-june`, firmId, clientId]);
    // The correction grant exists: the consumer would act if the period were open.
    await flag(pool, clientId, 'CODING_CORRECTION_AUTO_APPLY');
    const before = await ledgerOf(pool, [purchase]);
    await firmCorrects(clientId, { field: country.field, value: REGISTERED_2026 });
    await recoverChangedCodingEvidenceInDb({ firmId });
    const requirement = await assertCaseOpened(pool, purchase, { posted: 'not_registered', current: 'registered', basis: 'coding_receipt',
      journalId: (await row(pool, purchase)).payload.ledger_journal_id });
    assert.equal(requirement.tax_registration.period.locked, true);
    assert.equal(requirement.tax_registration.period.close_period_id, `${clientId}-june`);
    assert.equal(requirement.next_action, 'person_corrects_closed_period');
    assert.match(requirement.message, /close period is locked, so nothing is posted into it and Donna posts no adjustment/);
    await recoverPostedCodingCorrectionsInDb({ firmId, limit: 10 });
    const line = await row(pool, purchase);
    assert.equal(line.payload.coding_correction_required.recovery?.code, 'CODING_CORRECTION_TAX_PERIOD_CLOSED');
    assert.equal(line.payload.coding_correction_required.recovery.details.reason, 'close_period_locked');
    assert.equal(line.convergence_reason, 'posted_tax_registration_correction_blocked:CODING_CORRECTION_TAX_PERIOD_CLOSED');
    assert.deepEqual(await ledgerOf(pool, [purchase]), before, 'nothing posted');
  });

  test(`real PG (${country.label}): a record change that moves no line's status, and the gate off, open nothing`, { skip }, async t => {
    const pool = await freshDb(t);
    const clientId = `${country.label.toLowerCase()}-neighbours`;
    await country.seed(pool, clientId, { [country.field]: REGISTERED_2026 });
    const offId = `${clientId}-gate-off`;
    await country.seed(pool, offId, { [country.field]: NOT_REGISTERED }, { gate: false });
    mockCoder(t, country);
    const vat = `${clientId}-purchase`, off = `${offId}-purchase`;
    await addLine(pool, clientId, country, vat, '2026-06-02');
    await addLine(pool, offId, country, off, '2026-06-02');
    await postAll(pool, clientId, [vat]);
    await postAll(pool, offId, [off]);
    // Another fact of the record changes (a filing period or a VAT number); the status on 2026-06-02 does not.
    const restated = country.label === 'FI' ? { ...REGISTERED_2026, tax_period: 'quarter' } : { ...REGISTERED_2026, vat_registration_number: 'GB123456789' };
    await firmCorrects(clientId, { field: country.field, value: restated });
    assert.equal((await profileAudit(pool, clientId)).tax_registration_change.count, 0);
    // Gate off: the receipt still names the line; no case opens.
    await firmCorrects(offId, { field: country.field, value: REGISTERED_2026 });
    const change = (await profileAudit(pool, offId)).tax_registration_change;
    assert.equal(change.count, 1);
    assert.equal(change.correction_cases_enabled, false);
    await recoverChangedCodingEvidenceInDb({ firmId });
    for (const id of [vat, off]) {
      const line = await row(pool, id);
      assert.equal(line.payload.coding_correction_required, undefined, id);
      assert.equal(line.convergence_state, 'auto_reconciled', `${id}: ${line.convergence_reason}`);
    }
  });
}

// Singapore keeps its native-registration detector only: a posted Singapore
// line is not read by the country registration recheck, gate on or off.
test('real PG (SG): a posted Singapore line under the existing detector opens no registration case', { skip }, async t => {
  const pool = await freshDb(t);
  const clientId = 'sg-neighbour';
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Neighbour Pte Ltd','SG',$3)", [clientId, firmId, { jurisdiction: 'SG', accounting_system: 'none', gst_registration: { status: 'not_registered' } }]);
  await flag(pool, clientId, TAX_REGISTRATION_RECHECK_FLAG);
  for (const [code, type, balance] of [['6000', 'expense', 'debit'], ['1000', 'asset', 'debit']]) await pool.query("insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,status) values($1,$2,$3,$4,$4,$5,$6,'SGD','active')", [`${clientId}-${code}`, firmId, clientId, code, type, balance]);
  const id = `${clientId}-purchase`, journal = `${clientId}-journal`;
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values($1,$2,$3,'2026-06-02','Synthetic supplies',0,109,'SGD','posted','posted',$4)",
    [id, firmId, clientId, { ledger_journal_id: journal, ai_suggestion_status: 'auto_applied', ai_suggestion: { proposed_account: '6000', tax_treatment: 'TX9', evidence_digest: null } }]);
  await pool.query("insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status,posted_at) values($1,$2,$3,'transaction',$4,'2026-06-02','SGD','posted',now())", [journal, firmId, clientId, id]);
  for (const [n, code, dir, amount, tax] of [[1, '6000', 'debit', 109, 'TX9'], [2, '1000', 'credit', 109, null]]) await pool.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,account_code,account_name,line_no,direction,debit,credit,amount,currency,tax_type)
    values($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,'SGD',$12)`, [`${journal}-${n}`, journal, firmId, clientId, `${clientId}-${code}`, code, n, dir, dir === 'debit' ? amount : 0, dir === 'credit' ? amount : 0, amount, tax]);
  await recoverChangedCodingEvidenceInDb({ firmId });
  assert.equal((await row(pool, id)).payload.coding_correction_required, undefined);
});

// A filed ALV return over the line's date: the same as a locked period. The
// UK keeps no filed-return record, so only Finland reads one.
test('real PG (FI): a filed ALV return over the line\'s date: the case opens and says so, and nothing is posted', { skip }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-filed';
  await seedFi(pool, clientId, { alv_registration: NOT_REGISTERED });
  mockCoder(t, FI);
  const purchase = `${clientId}-purchase`;
  await addLine(pool, clientId, FI, purchase, '2026-06-02');
  await postAll(pool, clientId, [purchase]);
  await pool.query(`insert into alv_returns(id,firm_id,client_id,period_key,period_type,starts_on,ends_on,status,filed_at,filed_by)
    values('alv-2026-q2',$1,$2,'2026-Q2','quarter','2026-04-01','2026-06-30','filed',now(),'member-firm')`, [firmId, clientId]);
  const before = await ledgerOf(pool, [purchase]);
  await firmCorrects(clientId, { field: FI.field, value: REGISTERED_2026 });
  await recoverChangedCodingEvidenceInDb({ firmId });
  const requirement = await assertCaseOpened(pool, purchase, { posted: 'not_registered', current: 'registered', basis: 'coding_receipt',
    journalId: (await row(pool, purchase)).payload.ledger_journal_id });
  assert.equal(requirement.tax_registration.period.return_filed, true);
  assert.equal(requirement.tax_registration.period.filed_return_id, 'alv-2026-q2');
  assert.equal(requirement.tax_registration.period.locked, false);
  assert.equal(requirement.next_action, 'person_corrects_closed_period');
  assert.match(requirement.message, /VAT return for that date is filed/);
  await recoverPostedCodingCorrectionsInDb({ firmId, limit: 10 });
  const line = await row(pool, purchase);
  assert.equal(line.payload.coding_correction_required.recovery?.code, 'CODING_CORRECTION_TAX_PERIOD_CLOSED');
  assert.equal(line.payload.coding_correction_required.recovery.details.reason, 'vat_return_filed');
  assert.equal(line.convergence_reason, 'posted_tax_registration_correction_blocked:CODING_CORRECTION_TAX_PERIOD_CLOSED');
  assert.deepEqual(await ledgerOf(pool, [purchase]), before, 'nothing posted');
});
