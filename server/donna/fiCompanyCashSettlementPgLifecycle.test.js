// A receipt paid from the company's own cash box posts through the existing
// settlement writer, proved on the appliance harness (real PostgreSQL, the
// real runtime, the real reply route and workers; providers scripted at the
// HTTP boundary). The shape is the Kultalanka month's K01
// (data/evals/fixtures/fi-kultalanka-2025-02): a 22,00 € florist receipt
// printing KÄTEINEN, no bank line, booked by the key as expense + input ALV
// against 1900 Käteinen raha.
//
// Before this change the owner was asked whose cash paid it, answered "from
// the till", the answer was stored as company cash, nothing posted (the
// settlement lane took owner-funded cash only), and the next full sweep
// re-asked the model without the owner's answer and minted the same question
// again: its incremental guard dropped every verdict without a lane (SQL
// NULL), the owner-confirmed settle among them.
//
// Scripted replies stand in for the readers: they prove the route from a
// reading to the books, not how well a model reads Finnish.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { FI_PROFILE, fiPdf, fiRoutingFixture, anthropicFixture, openAiFixture, fiBankDispositionResponder,
  fiMatchingResponder, fiAskDraftResponder, fiBornAccount } from './testSupport/fiReliabilitySources.js';
import { FI_POSTING_ACCOUNTS } from './finland/provisioningPolicy.js';
import { convergenceForUnmatchedDocument } from './reconcileConvergenceState.js';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, upsertLedgerAccountForJournal, postDocumentSettlementJournalWithClient } from './firmDb.js';
import { runDocumentSettlementEntriesForClient } from './documentSettlementEntry.js';

const CODING = 'parse-cron:coding_convergence';
const LOOPS = 'parse-cron:loops_inbox';
const PARSE = 'parse-document';
const DRAIN = 'document-terminal-drain';

const K01 = Object.freeze({ date: '2025-02-25', counterparty: 'Kukkakauppa Kukka-Aho', total: 22.00, vat: 4.47, net: 17.53, rate: 0.255,
  filename: '49 Kuitti 25.02 - Kukkakauppa Kukka-Aho (KÄTEINEN).pdf', bankText: 'KORTTIOSTO KUKKAKAUPPA KUKKA-AHO TAMPERE' });
const GB_PROFILE = Object.freeze({ companyName: 'Harbour Lane Studio Ltd', jurisdiction: 'GB', entityType: 'gb-ltd', currency: 'GBP', accounting_system: 'none',
  accounting_basis: 'management_books', vat_registration: { status: 'registered', registered_from: '2020-01-01' } });
const FI_CASH = FI_POSTING_ACCOUNTS.cashAccount();
const EXPENSE = fiBornAccount('Office expenses');

const extraction = (currency) => {
  const t = JSON.parse(loadRecording('unified_extraction/ochre-discount-line').body.content[0].text);
  t.document_type = 'receipt';
  Object.assign(t.header, { counterparty_name: K01.counterparty, counterparty_role: 'vendor', counterparty_tax_id: null,
    own_name: currency === 'EUR' ? FI_PROFILE.companyName : GB_PROFILE.companyName, own_tax_id: currency === 'EUR' ? FI_PROFILE.businessId : null,
    document_date: K01.date, due_date: K01.date, currency, subtotal_amount: K01.net, tax_amount: K01.vat, shipping_amount: 0, discount_amount: 0,
    rounding_amount: 0, total_amount: K01.total, line_amounts_include_tax: false, payment_status: 'paid', payment_terms: 'KÄTEINEN',
    references: [{ type: 'receipt_number', value: 'KA-2502' }] });
  t.lines = [{ description: 'Kukkakimppu', quantity: 1, unit_price: K01.net, amount: K01.net, tax_rate: K01.rate }];
  t.warnings = [];
  return anthropicFixture(t);
};
const bankCsv = (rows) => Buffer.from(`Date,Description,Money In,Money Out,Balance,Currency\n${rows.map(([d, text, out, cur]) => `${d},${text},,${out.toFixed(2)},0.00,${cur}`).join('\n')}\n`);
const systemOf = (request) => (typeof request?.system === 'string' ? request.system : (request?.system || []).map((b) => b.text || '').join(''));

// The disposition lane, read from the prompt it was given: the sweep sees the
// receipt only (cash, whose funds not stated — the parser turns that into the
// whose-cash question); the answer leg reads the owner's answer, which this
// scenario's `answer` maps to a funding fact.
const dispositionLane = (calls, funding) => (request) => {
  const reply = systemOf(request).includes('the owner has now ANSWERED');
  calls.push(reply ? 'reply' : 'sweep');
  return anthropicFixture(reply
    ? { disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'flowers', settlement_channel: 'cash', funding_source: funding,
      confidence: 0.95, reasoning: 'The owner says whose cash paid it.' }
    : { disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'flowers', settlement_channel: 'cash', funding_source: 'unknown',
      confidence: 0.9, reasoning: 'A cash receipt; whose cash is not stated.' });
};

const boot = async (runToken, { gb = false, funding = 'company_cash', bankRows = null } = {}) => {
  const app = await bootApplianceForTest({ runToken, firm: gb ? {} : { jurisdiction: 'FI', currency: 'EUR' }, env: { DATABASE_POOL_MAX: '3' } });
  try {
    const currency = gb ? 'GBP' : 'EUR';
    const { clientId } = await app.createClient({ profile: gb ? GB_PROFILE : { ...FI_PROFILE, alv_registration: { status: 'registered', registered_from: '2024-10-01' } } });
    const dispositionCalls = [];
    const draftRequests = [];
    app.providers.script('document_disposition', [{ times: Infinity, respond: dispositionLane(dispositionCalls, funding) }]);
    app.providers.script('settlement_account', [{ times: Infinity, respond: () => anthropicFixture({ account: 'Office expenses',
      tax_treatment: gb ? 'VAT 20%' : 'ALV 25,5 %', confidence: 0.95, reasoning: 'Flowers for the salon.' }) }]);
    app.providers.script('bank_line_disposition', [{ respond: fiBankDispositionResponder, times: Infinity }]);
    app.providers.script('reconciliation_reasoning', [{ respond: fiMatchingResponder, times: Infinity }]);
    app.providers.script('transaction_coding', [{ times: Infinity, respond: (request) => {
      const input = JSON.parse(request.input);
      const base = JSON.parse(loadRecording('transaction_coding/kestrel-two-lines-coded').body.output[0].content[0].text).suggestions[1];
      const suggestions = (input.transactions || [input.transaction]).map((row) => ({ ...base, transaction_id: row.id, proposed_account: 'Office expenses',
        contact: K01.counterparty, tax_treatment: gb ? 'VAT 20%' : 'ALV 25,5 %', support_note: '', ask_client_question: '', evidence_required: false,
        merchant_pattern: '', confidence: 'high', materiality: 'normal', posting_requirement: 'single_account', document_allocations: [],
        reasoning: 'Synthetic strong-coder verdict.', warnings: [], alternatives: [] }));
      return openAiFixture(input.transactions ? { suggestions, group_summary: [] } : suggestions[0]);
    } }]);
    app.providers.script('ask_drafting', [{ times: Infinity, respond: (request) => { draftRequests.push(request); return fiAskDraftResponder(request); } }]);
    app.providers.script('memory_extraction', [{ respond: () => openAiFixture({ facts: [] }), times: Infinity }]);

    const uploadBank = async (rows, name) => {
      app.providers.script('document_routing', [fiRoutingFixture('bank')]);
      return app.uploadDocument({ clientId, bytes: bankCsv(rows), filename: name, mimeType: 'text/csv', documentType: 'bank_statement' });
    };
    // Coverage spans the receipt's date; the receipt's own line is absent
    // unless a scenario says otherwise.
    await uploadBank(bankRows || [['03.02.2025', 'TILISIIRTO VUOKRA HELMIKUU', 1200, currency], ['27.02.2025', 'TILISIIRTO SAHKO', 80, currency]], 'Tiliote-02.csv');
    app.providers.script('document_routing', [fiRoutingFixture('receipt')]);
    app.providers.script('unified_extraction', [extraction(currency)]);
    const receipt = await app.uploadDocument({ clientId, mimeType: 'application/pdf', documentType: 'receipt', filename: K01.filename,
      bytes: await fiPdf(['KUITTI KA-2502', `Myyja: ${K01.counterparty}`, `Paivays: ${K01.date}`, 'Kukkakimppu 17,53', 'ALV 25,5 % 4,47', 'Yhteensa 22,00', 'KATEINEN 22,00']) });
    const documentId = receipt.documentId;

    const settle = async (rounds = 3) => {
      for (let i = 0; i < rounds; i += 1) {
        await app.tick({ functions: [PARSE] });
        await app.tick({ functions: [CODING], advanceMs: 300_000 });
        await app.tick({ functions: [LOOPS] });
      }
      // The hourly document drain (handlerManifest 'document-terminal-drain',
      // :15): the disposition sweep and, after it, the settlement entry.
      await app.tick({ functions: [DRAIN], advanceMs: 3_600_000 });
    };
    // Every worker on the clock for some hours: the full drain sweep is the
    // producer that re-asked an answered question.
    const clock = async (ticks = 3) => { for (let i = 0; i < ticks; i += 1) await app.tick({ advanceMs: 3_600_000 }); };
    const asks = async () => (await app.query(`select id, status, question, evidence_type, request_payload->>'lane' as lane from client_evidence_requests
      where client_id = $1 and request_payload->>'document_id' = $2 order by created_at, id`, [clientId, documentId])).rows;
    const document = async () => (await app.query('select * from documents where id = $1', [documentId])).rows[0];
    const audits = async (action) => (await app.query('select * from audit_events where client_id = $1 and action = $2 and resource_id = $3 order by id',
      [clientId, action, documentId])).rows;
    const asksMinted = async () => (await app.query(`select count(*)::int as n from audit_events where client_id = $1 and action = 'evidence_request.create'
      and resource_id in (select id from client_evidence_requests where request_payload->>'document_id' = $2)`, [clientId, documentId])).rows[0].n;
    const journalLines = async (sourceId = documentId, sourceType = 'document_settlement') => (await app.query(`select j.id as journal_id, a.code, a.name,
      a.account_type, a.canonical_role, a.payload->>'statutory_group' as statutory_group, l.debit::float as debit, l.credit::float as credit, l.tax_type
      from ledger_journals j join ledger_lines l on l.journal_id = j.id join ledger_accounts a on a.id = l.account_id
      where j.client_id = $1 and j.source_id = $2 and j.source_type = $3 order by l.line_no`, [clientId, sourceId, sourceType])).rows;
    const reply = async (text) => {
      const [question] = (await asks()).filter((a) => ['draft', 'open'].includes(a.status));
      assert.ok(question, 'an open question to answer');
      const response = await app.api.request({ method: 'POST', path: `/api/donna/firms/evidence/requests/${question.id}/resolve`, auth: true,
        body: { firm_id: app.firmId, reply: text, document_ids: [] } });
      assert.ok(response.ok, `${response.status}: ${response.text.slice(0, 300)}`);
      return question;
    };
    const draftNotice = async () => {
      const { draftClientAskBatchInDb } = await import('./firmDb.js');
      const before = draftRequests.length;
      await draftClientAskBatchInDb({ firmId: app.firmId, clientId });
      const request = draftRequests[before];
      return request ? { input: JSON.parse(request.input), instructions: String(request.instructions || '') } : null;
    };
    return { app, clientId, documentId, dispositionCalls, uploadBank, settle, clock, asks, document, audits, asksMinted, journalLines, reply, draftNotice };
  } catch (error) { await app.stop(); throw error; }
};

// Asked once; answered; posted against 1900 with its receipt and a true
// notice; never asked again; the persisted state reads settled.
const companyCashLifecycle = (wording) => async () => {
  const s = await boot(`ccash-${wording.key}-${process.pid}`);
  const { app } = s;
  try {
    await s.settle();
    const [asked, ...more] = await s.asks();
    assert.equal(more.length, 0, 'one question');
    assert.deepEqual([asked.evidence_type, asked.lane], ['payment_method', 'needs_human_disposition']);
    assert.match(asked.question, /Maksettiinko se yrityksen kassasta vai omista rahoistasi\?$/, 'the whose-cash question, in the owner\'s language');

    await s.reply(wording.text);
    await s.settle();

    // The reader stored the fact: company cash, by the owner's word.
    const doc = await s.document();
    const disposition = doc.payload.no_line_disposition;
    assert.deepEqual([disposition.disposition, disposition.settlement_channel, disposition.funding_source, disposition.verdict_source],
      ['auto_explain', 'cash', 'company_cash', 'owner_reply']);
    // The existing writer posted: expense net, input ALV, the gross against the market's cash account.
    const lines = await s.journalLines();
    assert.deepEqual(lines.map((l) => [l.code, l.name, l.debit, l.credit, l.tax_type]), [
      [EXPENSE.code, EXPENSE.name, K01.net, 0, 'ALV_25_5_INPUT'],
      [lines[1].code, lines[1].name, K01.vat, 0, 'NONE'],
      [FI_CASH.code, FI_CASH.name, 0, K01.total, 'NONE']
    ], JSON.stringify(lines));
    assert.equal(lines[1].statutory_group, 'vat_liability', 'the ALV leg is the input-VAT control account');
    assert.deepEqual([lines[2].canonical_role, lines[2].statutory_group], [FI_CASH.canonical_role, FI_CASH.statutory_group]);
    assert.equal((await app.query("select count(*)::int as n from ledger_accounts where client_id = $1 and code = '901'", [s.clientId])).rows[0].n, 0,
      'no owner\'s-funds account is involved');
    // Its receipts: the document's entry, the audit row, the card and its apply receipt.
    const entry = doc.payload.settlement_entry;
    assert.equal(entry.journal_id, lines[0].journal_id);
    assert.deepEqual([entry.funding_source, entry.settlement_account, entry.owner_funds_account, entry.authority_basis, entry.evidence_request_id],
      ['company_cash', `${FI_CASH.code} · ${FI_CASH.name}`, undefined, 'owner_reply', asked.id]);
    assert.deepEqual([entry.cash_balance_after, entry.cash_account_negative], [-K01.total, true],
      'a book with no cash recorded goes below zero, and the receipt says so');
    assert.equal(doc.payment_status, 'paid');
    // What the books show for it: the balance sheet carries the cash box as a
    // negative asset (nothing in the read model or the close flags that on
    // its own; the entry's receipt above is what names it).
    const { getLedgerPeriodPreviewFromDb } = await import('./firmDb.js');
    const preview = await getLedgerPeriodPreviewFromDb({ firmId: app.firmId, clientId: s.clientId, periodStart: '2025-02-01', periodEnd: '2025-02-28' });
    const cashRow = preview.balance_sheet.assets.accounts.find((a) => a.name === FI_CASH.name);
    assert.deepEqual([cashRow?.amount, cashRow?.statutory_group], [-K01.total, FI_CASH.statutory_group], JSON.stringify(preview.balance_sheet.assets.accounts));
    const [posted, ...twice] = await s.audits('ledger.post_document_settlement');
    assert.equal(twice.length, 0);
    assert.deepEqual([posted.metadata.journal_id, posted.metadata.funding_source, posted.metadata.settlement_account, posted.metadata.cash_account_negative],
      [entry.journal_id, 'company_cash', entry.settlement_account, true]);
    const card = (await app.query(`select pc.*, (select count(*)::int from apply_receipts r where r.proposal_id = pc.id) as receipts
      from proposal_cards pc where pc.client_id = $1 and pc.proposal_type = 'document_settlement_entry'`, [s.clientId])).rows;
    assert.equal(card.length, 1);
    assert.deepEqual([card[0].status, card[0].check_status, card[0].detail.settlement_account, card[0].detail.funding_source, card[0].receipts],
      ['applied', 'pass', entry.settlement_account, 'company_cash', 1]);

    // The notice to the owner says what happened, in their language.
    const notice = await s.draftNotice();
    assert.ok(notice, 'the ask batch drafted the recorded-settlement notice');
    assert.equal(notice.input.client.language, 'fi');
    const [recorded] = notice.input.recorded_settlements;
    assert.deepEqual([recorded.funding_source, recorded.expense_account, recorded.amount], ['company_cash', entry.expense_account, K01.total]);
    assert.match(notice.instructions, /"company_cash" — paid from the company's own cash/);
    assert.match(notice.instructions, /Recorded as paid from the company's cash/);

    // Later sweeps: no producer mints the question again.
    const minted = await s.asksMinted();
    const sweeps = s.dispositionCalls.length;
    await s.clock();
    await s.settle(2);
    assert.equal(await s.asksMinted(), minted, 'no new question');
    assert.deepEqual((await s.asks()).map((a) => [a.id, a.status]), [[asked.id, 'resolved']]);
    assert.equal(s.dispositionCalls.length, sweeps, 'the answered document is not re-disposed');
    const after = await s.document();
    assert.equal(after.payload.no_line_disposition.funding_source, 'company_cash', 'the owner\'s answer stands');
    assert.equal((await s.journalLines()).length, 3, 'one entry');
    assert.equal(after.convergence_state, 'auto_reconciled');
    assert.equal(convergenceForUnmatchedDocument(after).state, 'auto_reconciled', 'the projection reads it settled, not settlement_entry_missing');
  } finally { await app.stop(); }
};

test('FI K01: a receipt paid from the till ("Maksettiin käteisellä kassasta.") posts against 1900 and is never asked again',
  { skip: applianceHarnessSkipReason() }, companyCashLifecycle({ key: 'fi', text: 'Maksettiin käteisellä kassasta.' }));

test('FI K01: a second wording ("We paid it in cash from the till.") reaches the same entry',
  { skip: applianceHarnessSkipReason() }, companyCashLifecycle({ key: 'en', text: 'We paid it in cash from the till.' }));

test('FI late bank line: the company-cash entry is reversed when the receipt turns out to be on the statement, with true wording',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await boot(`ccash-late-${process.pid}`);
    const { app } = s;
    try {
      await s.settle();
      await s.reply('Maksettiin käteisellä kassasta.');
      await s.settle();
      const [original] = await s.journalLines();
      assert.ok(original, 'the company-cash entry posted');
      await s.draftNotice(); // the recorded notice goes out first, as it would

      // It was paid by card after all: the line arrives on a later statement.
      await s.uploadBank([['25.02.2025', K01.bankText, K01.total, 'EUR']], 'Tiliote-02-b.csv');
      await s.settle();
      const doc = await s.document();
      const reversal = doc.payload.settlement_entry.reversal;
      assert.ok(reversal?.journal_id, JSON.stringify(doc.payload.settlement_entry));
      const reversed = (await app.query(`select j.reversal_of_journal_id, a.code, l.debit::float as debit, l.credit::float as credit
        from ledger_journals j join ledger_lines l on l.journal_id = j.id join ledger_accounts a on a.id = l.account_id
        where j.id = $1 order by l.line_no`, [reversal.journal_id])).rows;
      assert.equal(reversed[0].reversal_of_journal_id, original.journal_id);
      assert.deepEqual(reversed.find((l) => l.code === FI_CASH.code), { reversal_of_journal_id: original.journal_id, code: FI_CASH.code, debit: K01.total, credit: 0 },
        'the cash box gets its 22,00 back');
      const [audit] = await s.audits('ledger.reverse_document_settlement');
      assert.ok(audit, 'the reversal audit row');
      const card = (await app.query(`select * from proposal_cards where client_id = $1 and proposal_type = 'document_settlement_reversal'`, [s.clientId])).rows[0];
      assert.match(card.detail.reason, /Reversing the company-cash settlement entry/);
      assert.doesNotMatch(JSON.stringify(card.before_after ?? card.detail), /owner funds|owner-funds/);
      assert.deepEqual([card.detail.funding_source, card.detail.settlement_account, card.detail.owner_funds_account],
        ['company_cash', `${FI_CASH.code} · ${FI_CASH.name}`, undefined]);
      // The correction notice says which entry was reversed.
      const notice = await s.draftNotice();
      const [corrected] = notice.input.settlement_reversals;
      assert.equal(corrected.funding_source, 'company_cash');
      assert.match(notice.instructions, /for company_cash say "the paid-from-the-company's-cash entry"/);
    } finally { await app.stop(); }
  });

test('neighbour FI: an owner-funded cash receipt posts against 901 Director loan with its entry shape unchanged, and is not asked again',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await boot(`ccash-owner-${process.pid}`, { funding: 'owner' });
    const { app } = s;
    try {
      await s.settle();
      await s.reply('Maksoin sen käteisellä omista rahoistani.');
      await s.settle();
      const lines = await s.journalLines();
      assert.deepEqual(lines.map((l) => [l.code, l.debit, l.credit]), [[EXPENSE.code, K01.net, 0], [lines[1].code, K01.vat, 0], ['901', 0, K01.total]]);
      const entry = (await s.document()).payload.settlement_entry;
      assert.deepEqual([entry.funding_source, entry.owner_funds_account, entry.settlement_account, entry.cash_balance_after],
        ['owner', '901 · Director loan', undefined, undefined]);
      const notice = await s.draftNotice();
      assert.equal(notice.input.recorded_settlements[0].funding_source, 'owner');
      await s.clock();
      assert.equal((await s.asks()).length, 1, 'answered once, never asked again');
      assert.equal((await app.query("select count(*)::int as n from ledger_accounts where client_id = $1 and code = '1900'", [s.clientId])).rows[0].n, 0);
    } finally { await app.stop(); }
  });

test('neighbour FI: a receipt paid by card that matches its bank line is neither asked about nor settled outside the feed',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await boot(`ccash-card-${process.pid}`, { bankRows: [['03.02.2025', 'TILISIIRTO VUOKRA HELMIKUU', 1200, 'EUR'], ['25.02.2025', K01.bankText, K01.total, 'EUR']] });
    const { app } = s;
    try {
      await s.settle();
      await s.clock(2);
      assert.deepEqual(await s.asks(), [], 'no question');
      assert.deepEqual(await s.journalLines(), [], 'no settlement entry');
      assert.equal(s.dispositionCalls.length, 0, 'never dispositioned as a no-line document');
      const match = (await app.query(`select status from reconciliation_matches where client_id = $1 and matched_object_id = $2`, [s.clientId, s.documentId])).rows;
      assert.ok(match.some((m) => ['auto_matched', 'confirmed', 'suggested'].includes(m.status)), JSON.stringify(match));
    } finally { await app.stop(); }
  });

// The desktop admits the settlement lane for Finnish books only
// (hostPlaneSeed DESKTOP_FINLAND_FLAG_SEEDS; a GB book staging it is refused
// at parse_claim as an unexpected live capability), so on the appliance a GB
// book's answer is stored and nothing posts, as for an owner-funded receipt
// there. The lane's own refusal for a market with no cash account is proved
// on migrated PostgreSQL below.
test('neighbour GB appliance: the company-cash answer is stored, nothing is posted to a substitute account, and the question is not asked again',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await boot(`ccash-gb-${process.pid}`, { gb: true });
    const { app } = s;
    try {
      await s.settle();
      const [asked, ...more] = await s.asks();
      assert.equal(more.length, 0);
      assert.equal(asked?.evidence_type, 'payment_method');
      assert.match(asked.question, /Was it paid from company cash or from your personal funds\?$/);
      await s.reply('We paid it in cash from the till.');
      await s.settle();
      assert.equal((await s.document()).payload.no_line_disposition.funding_source, 'company_cash');
      assert.deepEqual(await s.journalLines(), [], 'nothing posted');
      const minted = await s.asksMinted();
      const sweeps = s.dispositionCalls.length;
      await s.clock();
      assert.equal(await s.asksMinted(), minted, 'the answered question is not asked again');
      assert.equal(s.dispositionCalls.length, sweeps);
      assert.deepEqual(await s.journalLines(), []);
    } finally { await app.stop(); }
  });

// A market that declares no cash account (GB, SG: provisioningPolicyRegistry
// .resolveMarketPostingAccounts is null) gets no substitute account from the
// lane or the writer: the card rests proposed on a failing check that names
// what is missing, and the writer refuses with a named code. Real
// PostgreSQL (all migrations); only the provider HTTP is replaced.
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG, GB and SG: company cash with no declared cash account rests on a named refusal at the lane and the writer; FI posts',
  { skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set' }, async (t) => {
    const name = `donna_ccash_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    const closed = [];
    pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    t.after(async () => {
      __resetFirmDbPoolForTests();
      await pool.end(); await Promise.all(closed);
      await admin.query(`drop database "${name}"`); await admin.end();
    });
    await pool.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
    const migrations = new URL('../../db/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    const firmId = 'ccash-firm';
    await pool.query("insert into firms (id,name,slug) values ($1,'Company cash fixture','ccash')", [firmId]);
    const markets = [
      { clientId: 'ccash-gb', jurisdiction: 'GB', currency: 'GBP', profile: { jurisdiction: 'gb', accounting_system: 'none' } },
      { clientId: 'ccash-sg', jurisdiction: 'SG', currency: 'SGD', profile: { jurisdiction: 'sg', accounting_system: 'none' } },
      { clientId: 'ccash-fi', jurisdiction: 'FI', currency: 'EUR', profile: { jurisdiction: 'fi', accounting_system: 'none' } }
    ];
    const disposition = { disposition: 'auto_explain', materiality: 'immaterial', settlement_channel: 'cash', funding_source: 'company_cash',
      confidence: 0.95, verdict_source: 'owner_reply', owner_notified: true, evidence_request_id: 'ask-1' };
    for (const m of markets) {
      await pool.query('insert into clients (id,firm_id,company_name,jurisdiction,profile) values ($1,$2,$3,$4,$5::jsonb)',
        [m.clientId, firmId, `Fixture ${m.jurisdiction}`, m.jurisdiction, JSON.stringify(m.profile)]);
      await pool.query(`insert into documents (id,firm_id,client_id,filename,document_type,document_date,total_amount,currency,payment_status,payload)
        values ($1,$2,$3,'till-receipt.pdf','receipt','2026-09-05',10,$4,'unpaid',$5::jsonb)`,
      [`${m.clientId}-doc`, firmId, m.clientId, m.currency, JSON.stringify({ no_line_disposition: disposition })]);
      await upsertLedgerAccountForJournal({ client: pool, firmId, clientId: m.clientId, account: { code: 'SET-EXP', name: 'Office supplies', type: 'expense' }, currency: m.currency });
      await pool.query(`insert into client_capability_config (id,firm_id,client_id,flag_key,stage) values ($1,$2,$3,'DOCUMENT_SETTLEMENT_LEDGER_ENTRY','auto')`,
        [`${m.clientId}-settle`, firmId, m.clientId]);
    }
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({
      account: 'Office supplies', tax_treatment: 'No VAT', confidence: 0.95, reasoning: 'Office supplies paid from the till.' }) }] }) });
    const run = async (clientId) => {
      const connection = await pool.connect();
      try {
        return await runDocumentSettlementEntriesForClient({ client: connection, firmId, clientId, documentIds: [`${clientId}-doc`],
          apiKeyOverride: 'offline-company-cash', fetchImpl, accountOptionsFn: async () => ['Office supplies'] });
      } finally { connection.release(); }
    };
    for (const m of markets.filter((x) => x.jurisdiction !== 'FI')) {
      const stats = await run(m.clientId);
      assert.deepEqual([stats.gathered, stats.cards_minted, stats.posted], [1, 1, 0], JSON.stringify(stats));
      const [card] = (await pool.query('select * from proposal_cards where client_id = $1', [m.clientId])).rows;
      assert.deepEqual([card.status, card.check_status, card.detail.funding_source, card.detail.settlement_account], ['proposed', 'fail', 'company_cash', null]);
      const [report] = (await pool.query('select checks from check_reports where proposal_id = $1', [card.id])).rows;
      const check = report.checks.find((c) => c.name === 'settlement_funding_account');
      assert.equal(check?.status, 'fail', JSON.stringify(report.checks));
      assert.match(check.detail, /declares no cash account/);
      assert.equal((await pool.query('select count(*)::int as n from ledger_journals where client_id = $1', [m.clientId])).rows[0].n, 0);
      // The writer refuses on its own, whatever a caller hands it.
      const client = await pool.connect();
      try {
        await client.query('begin');
        await assert.rejects(postDocumentSettlementJournalWithClient({ client, firmId, clientId: m.clientId,
          document: { id: `${m.clientId}-doc`, currency: m.currency }, expenseAccount: { code: 'SET-EXP', name: 'Office supplies', type: 'expense' },
          settlement: { settlement_channel: 'cash' }, authorityBasis: 'owner_reply' }), { code: 'DOCUMENT_SETTLEMENT_CASH_ACCOUNT_UNDECLARED' });
        await client.query('rollback');
      } finally { client.release(); }
      assert.equal((await pool.query("select count(*)::int as n from ledger_accounts where client_id = $1 and canonical_role = 'asset.cash'", [m.clientId])).rows[0].n, 0,
        'no cash account minted in the engine\'s name');
      const again = await run(m.clientId);
      assert.deepEqual([again.cards_existing, again.posted, again.rested_proposed], [1, 0, 1], 'the refusal rests; it does not post on a later sweep');
    }
    // The same document in Finland posts against the declared 1900.
    const fi = await run('ccash-fi');
    assert.equal(fi.posted, 1, JSON.stringify(fi));
    const credit = (await pool.query(`select a.code, a.name, l.credit::float as credit from ledger_lines l join ledger_accounts a on a.id = l.account_id
      where l.client_id = 'ccash-fi' and l.direction = 'credit'`)).rows;
    assert.deepEqual(credit, [{ code: FI_CASH.code, name: FI_CASH.name, credit: 10 }]);
  });
