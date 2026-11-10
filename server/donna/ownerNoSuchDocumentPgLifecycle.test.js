// "There is no such document" is an answer every document-requesting line
// question can take (ownerDocumentUnavailable.js), proved on the appliance
// harness (real PostgreSQL, the real runtime, the real reply route and
// workers; providers scripted at the HTTP boundary).
//
// Measured on the Kultalanka month (data/evals/fixtures/fi-kultalanka-2025-02):
// owners answered truthfully that there was no corrected receipt (B22, B25,
// B31: 2025 receipts printing the retired 10 % rate), no payroll journal
// (B34) and no Z-report (B02, B29). Before this change the first two rested
// at `replied` with no reader (convergence owner_answered_processing), and the
// cash deposit was asked for the same report again. Each scenario here uses
// the pack's own shapes (amounts, filenames, the payslip's components).
//
// What every scenario proves from stored state: the reader's outcome and its
// receipt, the fact on the question and the line (who, when, their words),
// the end (booked with its basis and one line to the owner, or one open
// request on the owner saying what cannot be booked), and — after two more
// clock ticks — no new question for the same document.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { claudeRequestInput } from './testSupport/claudeMessage.js';
import { FI_PROFILE, openAiFixture, anthropicFixture } from './testSupport/fiReliabilitySources.js';

const CODING = 'parse-cron:coding_convergence';
const LOOPS = 'parse-cron:loops_inbox';

const codingBase = () => JSON.parse(loadRecording('transaction_coding/kestrel-two-lines-coded').body.output[0].content[0].text).suggestions[1];
const GB_PROFILE = Object.freeze({ companyName: 'Harbour Lane Studio Ltd', jurisdiction: 'GB', entityType: 'gb-ltd', currency: 'GBP', accounting_system: 'none',
  accounting_basis: 'management_books', vat_registration: { status: 'registered', registered_from: '2020-01-01' } });

// The lines. `coding` is what the scripted strong coder answers on its first
// read; `withoutDocument` is what it answers once the owner's fact is in its
// input (owner_stated_no_such_document); `withDocument` when a reply carries
// a document. The coder is the decider; the runtime decides everything else.
const LINES = Object.freeze({
  vr: { date: '2025-02-21', description: 'VR MATKUSTAJALIIKENNE VR.FI', amount: 28.60,
    coding: { proposed_account: 'Travel', tax_treatment: 'ALV 10 %', contact: 'VR' },
    withoutDocument: { proposed_account: 'Travel', tax_treatment: 'Vähennyskelvoton ALV (osto)', contact: 'VR' },
    withDocument: { proposed_account: 'Travel', tax_treatment: 'ALV 14 %', contact: 'VR' },
    document: { id: 'vr-ticket', filename: '47 Kuitti 21.02 - VR lippu.pdf', total: 28.60, tax: 2.60, lines: [['Junalippu Tampere-Helsinki 21.2.2025', 28.60]] } },
  salary: { date: '2025-02-28', description: 'KORHONEN SAARA PALKKA 2/2025', amount: 1926.24,
    coding: { proposed_account: 'Payroll', tax_treatment: 'Ei ALV-käsittelyä', contact: 'Saara Korhonen', posting_requirement: 'payroll_package', evidence_required: true,
      ask_client_question: 'We have the payslip for February 2025. Please provide the balanced external payroll journal, including employer contributions and liability accounts.' },
    document: { id: 'payslip', filename: '30 Palkkalaskelma 02-2025 - Korhonen Saara.pdf', total: 1926.24, tax: null,
      lines: [['Bruttopalkka', 2400], ['Ennakonpidätys', -288], ['TyEL', -171.60], ['Työttömyysvakuutus', -14.16]] } },
  deposit: { date: '2025-02-03', description: 'KASSATALLETUS 28.2.-2.3. OP TAMPERE', amount: 640, moneyIn: true,
    coding: { proposed_account: 'Sales', tax_treatment: 'ALV 25,5 %', contact: '' } },
  vero: { date: '2025-02-12', description: 'VEROHALLINTO ENNAKONPIDATYS+SAVA 1/2025', amount: 332.88,
    coding: { proposed_account: 'Payroll withholding and employer health-insurance payable', tax_treatment: 'Ei ALV-käsittelyä', contact: 'Verohallinto' } },
  stationery: { date: '2026-03-04', description: 'CARD PAYMENT RYMAN STATIONERY LONDON', amount: 48.00,
    coding: { proposed_account: 'Office expenses', tax_treatment: 'VAT 20%', contact: 'Ryman', evidence_required: true,
      ask_client_question: 'Please send the receipt for the Ryman purchase of GBP 48.00 on 4 March 2026.' },
    withDocument: { proposed_account: 'Office expenses', tax_treatment: 'VAT 20%', contact: 'Ryman', evidence_required: false, ask_client_question: '' } }
});
const lineKeyFor = (row) => Object.keys(LINES).find((key) => String(row.description || '').startsWith(LINES[key].description.split(' ')[0]));
const codingResponder = (request) => {
  // The coder runs on Claude on a host with both keys (2026-11-10): its input
  // is the Messages user turn; the stub serves this OpenAI-shaped answer in
  // the Messages shape.
  const input = JSON.parse(request.input ?? claudeRequestInput(request));
  const rows = input.transactions || [input.transaction];
  const suggestions = rows.map((row) => {
    const line = LINES[lineKeyFor(row)] || {};
    const chosen = row.client_reply_context?.reply_documents?.length && line.withDocument ? line.withDocument
      : row.owner_stated_no_such_document && line.withoutDocument ? line.withoutDocument : line.coding || {};
    return { ...codingBase(), transaction_id: row.id, proposed_account: 'Suspense', contact: '', tax_treatment: 'ALV-tarkistus', support_note: '',
      ask_client_question: '', evidence_required: false, merchant_pattern: '', confidence: 'high', materiality: 'normal', posting_requirement: 'single_account',
      document_allocations: [], historical_rate_basis: '', reasoning: 'Synthetic strong-coder verdict.', warnings: [], alternatives: [], ...chosen };
  });
  return openAiFixture(input.transactions ? { suggestions, group_summary: [] } : suggestions[0]);
};
// The strong owner-reply interpretation, served at the HTTP boundary.
const interpretation = (input) => {
  const body = structuredClone(loadRecording('unified_extraction/ochre-discount-line').body);
  body.content = [{ type: 'tool_use', id: 'synthetic-tool', name: 'interpret_owner_reply', input }]; body.stop_reason = 'tool_use';
  return { status: 200, body };
};
const readsNoSuchDocument = () => interpretation({ answer: { outcome: 'no_such_document' }, confidence: 0.97, clarification: null });

const settle = async (app, rounds = 2) => {
  for (let i = 0; i < rounds; i += 1) {
    await app.tick({ functions: [CODING], advanceMs: 300_000 });
    await app.tick({ functions: [LOOPS] });
  }
};

const bootScenario = async (runToken, keys, { gb = false } = {}) => {
  const app = await bootApplianceForTest({ runToken, firm: gb ? {} : { jurisdiction: 'FI', currency: 'EUR' }, env: { DATABASE_POOL_MAX: '3' } });
  try {
    const { clientId } = await app.createClient({ profile: gb ? GB_PROFILE : FI_PROFILE });
    app.providers.script('transaction_coding', [{ respond: codingResponder, times: Infinity }]);
    app.providers.script('bank_line_disposition', [{ respond: () => anthropicFixture({ disposition: 'chase_receipt', materiality: 'material', expense_kind: 'bank_transfer', confidence: 0.98, reasoning: 'Synthetic.' }), times: Infinity }]);
    app.providers.script('ask_drafting', [{ respond: () => openAiFixture({ subject: 's', message_markdown: 'm', summary: 's', items: [], statement_requests: [], document_asks: [] }), times: Infinity }]);
    app.providers.script('memory_extraction', [{ respond: () => openAiFixture({ facts: [] }), times: Infinity }]);
    const currency = gb ? 'GBP' : 'EUR';
    for (const key of keys) {
      const line = LINES[key];
      await app.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,'needs_review','{}')`, [key, app.firmId, clientId, line.date, line.description, line.moneyIn ? 0 : line.amount, line.moneyIn ? line.amount : 0, currency]);
      if (!line.document) continue;
      const doc = line.document;
      await app.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload)
        values($1,$2,$3,$4,'receipt','completed',$5,$6,$7,$8,'{}')`, [doc.id, app.firmId, clientId, doc.filename, doc.total, doc.tax, currency, line.date]);
      for (const [i, [description, amount]] of doc.lines.entries()) {
        await app.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,$5,$6,$7,'{}')`,
          [`${doc.id}-${i}`, app.firmId, clientId, doc.id, i + 1, description, amount]);
      }
      await app.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload)
        values($1,$2,$3,$4,'receipt',$5,$6,1,'auto_matched','fixture','{}')`, [`match-${key}`, app.firmId, clientId, key, doc.id, doc.total]);
    }
    await settle(app);
    const ask = async (key) => (await app.read.asks(clientId)).filter((a) => a.transaction_id === key);
    const line = async (key) => (await app.read.transactions(clientId)).find((t) => t.id === key);
    const reply = async (key, text, documentIds = []) => {
      const [question] = await ask(key);
      const response = await app.api.request({ method: 'POST', path: `/api/donna/firms/evidence/requests/${question.id}/resolve`, auth: true,
        body: { firm_id: app.firmId, reply: text, document_ids: documentIds } });
      assert.ok(response.ok, `${response.status}: ${response.text.slice(0, 300)}`);
      return response.json;
    };
    const audits = async (action, resourceId = null) => (await app.read.audit({ clientId, action })).filter((a) => !resourceId || a.resource_id === resourceId);
    const journal = async (key) => {
      const journals = (await app.query('select id from ledger_journals where client_id=$1 and source_id=$2', [clientId, key])).rows;
      const lines = journals.length ? (await app.query(`select a.name, l.debit, l.credit, l.tax_type from ledger_lines l join ledger_accounts a on a.id=l.account_id
        where l.journal_id=$1 order by l.line_no`, [journals[0].id])).rows : [];
      return { count: journals.length, lines: lines.map((l) => [l.name, Number(l.debit), Number(l.credit), l.tax_type]) };
    };
    // Two more clock ticks of every worker the line is touched by: no new
    // question for the same document, in any wording.
    const assertNeverAskedAgain = async (key, { questionId, question }) => {
      const createsBefore = (await audits('evidence_request.create')).filter((a) => a.metadata?.transaction_id === key).length;
      const restsBefore = (await audits('evidence_request.document_unavailable_rest', questionId)).length;
      await settle(app, 2);
      const asks = await ask(key);
      assert.equal(asks.length, 1, `one question on the line: ${JSON.stringify(asks.map((a) => [a.id, a.status, a.question]))}`);
      assert.equal(asks[0].id, questionId);
      assert.equal(asks[0].question, question, 'the question is not re-worded into a new ask');
      assert.equal((await audits('evidence_request.create')).filter((a) => a.metadata?.transaction_id === key).length, createsBefore, 'no producer minted a new question');
      assert.equal((await audits('evidence_request.document_unavailable_rest', questionId)).length, restsBefore, 'the rest is not re-written');
    };
    return { app, clientId, ask, line, reply, audits, journal, assertNeverAskedAgain };
  } catch (error) { await app.stop(); throw error; }
};

test('FI rate discrepancy: "there is no corrected receipt" is booked without the deduction, with its basis and one line to the owner, and never asked again',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await bootScenario(`nsd-vr-${process.pid}`, ['vr']);
    const { app } = s;
    try {
      const [asked] = await s.ask('vr');
      assert.equal(asked.evidence_type, 'document_discrepancy', 'the pack\'s 10 % ticket is the corrected-document question');
      assert.match(asked.question, /47 Kuitti 21\.02 - VR lippu\.pdf/);
      app.providers.script('owner_reply', [readsNoSuchDocument()]);
      const words = 'Kuitin päivämäärä on oikea, matka tehtiin 21.2.2025. Korjattua kuittia ei ole.';
      const result = await s.reply('vr', words);
      assert.equal(result.recode?.applied, true, JSON.stringify(result.recode));
      assert.equal(result.recode?.posted, true, JSON.stringify(result.recode));
      await settle(app);

      // The reader: one strong reading, its outcome receipted.
      assert.equal(app.providers.callsFor('owner_reply').length, 1);
      const [question] = await s.ask('vr');
      const processing = question.response_payload.reply_processing;
      assert.deepEqual([question.status, processing.state, processing.driven_action, processing.document_reading?.outcome, processing.document_reading?.model],
        ['resolved', 'completed', 'owner_has_no_such_document_posted', 'no_such_document', 'claude-opus-4-8'], JSON.stringify(processing));
      // The fact: who said it, when, in their words.
      const fact = question.response_payload.document_unavailable;
      assert.deepEqual([fact.basis, fact.stated_by, fact.words, fact.evidence_type, fact.stated_at], ['owner_stated_no_such_document', app.memberId, words, 'document_discrepancy', question.response_payload.responded_at]);
      assert.equal((await s.audits('evidence_request.document_unavailable_recorded', question.id)).length, 1);
      // The end: posted by the existing writer, gross to Travel, no input VAT; the coding carries its basis.
      const line = await s.line('vr');
      assert.deepEqual([line.coding_state, line.convergence_state], ['posted', 'auto_reconciled']);
      assert.deepEqual(line.payload.owner_document_unavailable, fact);
      assert.equal(line.payload.ai_suggestion.document_unavailable_basis.basis, 'owner_stated_no_such_document');
      assert.equal(line.payload.ai_suggestion.document_unavailable_basis.evidence_request_id, question.id);
      assert.deepEqual(await s.journal('vr'), { count: 1, lines: [['Matkakulut', 28.60, 0, 'ALV_NONDEDUCTIBLE_INPUT'], ['Pankkitili', 0, 28.60, 'NONE']] });
      const recode = (await s.audits('transaction.reply_recode')).find((a) => a.resource_id === 'vr');
      assert.equal(recode.metadata.document_unavailable.action, 'owner_has_no_such_document_posted');
      assert.equal(recode.metadata.document_unavailable.basis.basis, 'owner_stated_no_such_document');
      // One line to the owner, in their language, kept on the answered question.
      assert.match(question.response_payload.owner_notice_statement, /^Kirjasin tapahtuman “VR MATKUSTAJALIIKENNE VR\.FI” 2025-02-21 \(28,60 EUR\) tilille .*Vähennyskelvoton ALV \(osto\).* ilman pyytämääni asiakirjaa \(korjattu tosite\), koska kerroit, ettei sitä ole\.$/);
      assert.equal(question.response_payload.owner_notice_reply_key, processing.reply_key);
      await s.assertNeverAskedAgain('vr', { questionId: question.id, question: question.question });
      assert.equal((await s.line('vr')).coding_state, 'posted');
    } finally { await app.stop(); }
  });

test('FI payroll: "there is no payroll journal" rests as one open request on the owner; a failed reading is retried, never left at replied',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await bootScenario(`nsd-pay-${process.pid}`, ['salary']);
    const { app } = s;
    try {
      const [asked] = await s.ask('salary');
      assert.equal(asked.evidence_type, 'payroll_package');
      // The reader's provider fails first: a named, bounded failure on the
      // existing clock, never a question resting at `replied` unread.
      app.providers.script('owner_reply', [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } } }]);
      const words = 'Palkkajournaalia ei ole. Meillä on vain palkkalaskelma.';
      await s.reply('salary', words);
      let [question] = await s.ask('salary');
      assert.equal(question.status, 'replied');
      assert.deepEqual([question.response_payload.reply_processing.state, question.response_payload.reply_processing.code],
        ['retry_pending', 'OWNER_REPLY_PROVIDER_UNAVAILABLE'], JSON.stringify(question.response_payload.reply_processing));
      assert.equal((await s.line('salary')).convergence_reason, 'owner_answered_processing');
      app.providers.script('owner_reply', [readsNoSuchDocument()]);
      await settle(app); // the owner-reply clock retries the same answer

      [question] = await s.ask('salary');
      const processing = question.response_payload.reply_processing;
      assert.deepEqual([question.status, processing.state, processing.driven_action, processing.document_reading?.outcome],
        ['open', 'completed', 'owner_has_no_such_document_cannot_book', 'no_such_document'], JSON.stringify(processing));
      assert.ok((await s.audits('evidence_request.reply_processed', question.id)).some((a) => a.metadata.recovered_failure_id), 'the completed reading names the failure it recovered');
      // One open request saying what cannot be booked and what would unblock it.
      assert.match(question.question, /^Tapahtumaa “KORHONEN SAARA PALKKA 2\/2025” 2025-02-28 \(1926,24 EUR\) ei voi kirjata kirjanpitoon ilman asiakirjaa: palkkakirjanpidon tosite \(palkkajournaali/);
      assert.match(question.question, /Kirjasin, että sinulla ei ole sitä\. Kirjaan tapahtuman heti, kun asiakirja on saatavilla/);
      const rest = question.request_payload.document_unavailable_rest;
      assert.deepEqual([rest.kind, rest.reason, rest.prior_question], ['cannot_book_without_document', 'decider_requires_document', asked.question]);
      const fact = question.request_payload.document_unavailable;
      assert.deepEqual([fact.stated_by, fact.words, fact.evidence_type], [app.memberId, words, 'payroll_package']);
      const line = await s.line('salary');
      assert.deepEqual([line.coding_state, line.convergence_state, line.convergence_reason], ['asked', 'on_owner', 'open_owner_ask']);
      assert.equal(line.payload.ai_suggestion.posting_requirement, 'payroll_package', 'the decider still requires the package; nothing was booked around it');
      assert.deepEqual(await s.journal('salary'), { count: 0, lines: [] });
      assert.equal((await s.audits('evidence_request.document_unavailable_rest', question.id)).length, 1);
      await s.assertNeverAskedAgain('salary', { questionId: question.id, question: question.question });
      assert.equal(app.providers.callsFor('owner_reply').length, 2, 'the clock reads the answer once more after the failure, and nothing after');
    } finally { await app.stop(); }
  });

test('FI cash deposit and tax payment (B02/B29, B10/B11 "asked again"): the coder accepts the answer, the posting checks refuse it without the source, and the source is not asked for again',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await bootScenario(`nsd-dep-${process.pid}`, ['deposit', 'vero']);
    const { app } = s;
    try {
      const [asked] = await s.ask('deposit');
      assert.equal(asked.evidence_type, 'supporting_document');
      assert.match(asked.question, /sales or settlement record/);
      app.providers.script('owner_reply', [readsNoSuchDocument()]);
      const result = await s.reply('deposit', 'Meillä ei ole kassaraporttia eikä Z-raporttia tältä ajalta.');
      assert.equal(result.recode?.applied, false, JSON.stringify(result.recode));
      await settle(app);
      const [question] = await s.ask('deposit');
      assert.equal(question.status, 'open');
      const rest = question.request_payload.document_unavailable_rest;
      assert.deepEqual([rest?.reason, rest?.posting_refusal?.code], ['posting_checks_refused_without_document', 'TRANSACTION_REVENUE_SOURCE_REQUIRED'], JSON.stringify(rest));
      assert.match(question.question, /^Tapahtumaa “KASSATALLETUS 28\.2\.-2\.3\. OP TAMPERE” 2025-02-03 \(640,00 EUR\) ei voi kirjata kirjanpitoon ilman asiakirjaa: kuitti tai muu tosite\./);
      const line = await s.line('deposit');
      assert.deepEqual([line.coding_state, line.convergence_state], ['asked', 'on_owner']);
      assert.equal(line.payload.ai_suggestion.proposed_account, 'Sales', 'the decider\'s coding is kept; the writer refused it');
      assert.equal(line.payload.ai_suggestion.document_unavailable_basis, undefined, 'a refused posting carries no basis');
      assert.deepEqual(await s.journal('deposit'), { count: 0, lines: [] });
      await s.assertNeverAskedAgain('deposit', { questionId: question.id, question: question.question });

      // The path that minted the identical question on main: the line is
      // re-coded with no question pending (here the request was withdrawn),
      // and the coding sweep would ask for the report again. It reads the fact
      // and rests the line on the same request instead.
      const creates = (await s.audits('evidence_request.create')).filter((a) => a.metadata?.transaction_id === 'deposit').length;
      await app.query(`update client_evidence_requests set status = 'cancelled' where id = $1`, [question.id]);
      await app.query(`update transactions set coding_state = 'proposed' where id = 'deposit'`);
      await settle(app, 1);
      const asks = await s.ask('deposit');
      assert.deepEqual(asks.map((a) => [a.id, a.status, a.question]), [[question.id, 'open', question.question]]);
      assert.equal((await s.audits('evidence_request.create')).filter((a) => a.metadata?.transaction_id === 'deposit').length, creates);
      const rests = await s.audits('evidence_request.document_unavailable_rest', question.id);
      assert.deepEqual(rests.map((a) => a.metadata.rest.reason), ['posting_checks_refused_without_document', 'recoded_without_document']);
      assert.deepEqual([(await s.line('deposit')).coding_state, (await s.line('deposit')).convergence_state], ['asked', 'on_owner']);
      // The tax payment (B10 shape): the filing the owner says they do not have.
      const [taxAsk] = await s.ask('vero');
      assert.match(taxAsk.question, /filing or notice identifying the liability/);
      app.providers.script('owner_reply', [readsNoSuchDocument()]);
      await s.reply('vero', 'Minulla ei ole ilmoitusta tai päätöstä tästä maksusta.');
      await settle(app);
      const [taxQuestion] = await s.ask('vero');
      const taxRest = taxQuestion.request_payload.document_unavailable_rest;
      assert.deepEqual([taxQuestion.status, taxRest?.reason, Boolean(taxRest?.posting_refusal?.code)], ['open', 'posting_checks_refused_without_document', true], JSON.stringify(taxRest));
      assert.deepEqual(await s.journal('vero'), { count: 0, lines: [] });
      await s.assertNeverAskedAgain('vero', { questionId: taxQuestion.id, question: taxQuestion.question });
      // Any other producer is refused by the ask writer itself.
      const { createClientEvidenceRequestInDb } = await import('./firmDb.js');
      await assert.rejects(createClientEvidenceRequestInDb({ firmId: app.firmId, clientId: s.clientId, transactionId: 'deposit',
        question: 'Please send the Z-report for this deposit.', evidenceType: 'supporting_document', returnSnapshot: false }),
      { code: 'EVIDENCE_REQUEST_DOCUMENT_UNAVAILABLE' });
      // A fact question on the same line is still allowed: the fact is about the document only.
      await createClientEvidenceRequestInDb({ firmId: app.firmId, clientId: s.clientId, transactionId: 'deposit',
        question: 'Which weeks of cash sales does this deposit cover?', evidenceType: 'business_purpose', returnSnapshot: false });
    } finally { await app.stop(); }
  });

test('neighbour: an owner who sends the corrected receipt is read by the coder alone and booked from it',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await bootScenario(`nsd-copy-${process.pid}`, ['vr']);
    const { app, clientId } = s;
    try {
      await app.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload)
        values('vr-corrected',$1,$2,'47 Kuitti 21.02 - VR lippu (korjattu).pdf','receipt','completed',28.60,3.51,'EUR','2025-02-21','{}')`, [app.firmId, clientId]);
      await app.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
        values('vr-corrected-0',$1,$2,'vr-corrected',1,'Junalippu Tampere-Helsinki 21.2.2025',28.60,'{}')`, [app.firmId, clientId]);
      const result = await s.reply('vr', 'Ohessa korjattu kuitti.', ['vr-corrected']);
      assert.equal(result.recode?.applied, true, JSON.stringify(result.recode));
      await settle(app);
      assert.equal(app.providers.callsFor('owner_reply').length, 0, 'a reply that brings the document is not read as "there is none"');
      const [question] = await s.ask('vr');
      assert.equal(question.status, 'resolved');
      assert.equal(question.response_payload.document_unavailable, undefined);
      assert.equal(question.response_payload.reply_processing.driven_action, undefined);
      const line = await s.line('vr');
      assert.equal(line.payload.owner_document_unavailable, undefined);
      assert.equal(line.payload.ai_suggestion.document_unavailable_basis, undefined);
      assert.equal(line.payload.ai_suggestion.tax_treatment, 'ALV 14 %');
      assert.equal((await s.audits('evidence_request.document_unavailable_recorded')).length, 0);
    } finally { await app.stop(); }
  });

test('neighbour: an unclear reply is not a "there is none": no fact, one follow-up back on the owner (no longer resting at replied)',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await bootScenario(`nsd-unclear-${process.pid}`, ['vr']);
    const { app } = s;
    try {
      const clarify = 'Tiedätkö, milloin matka tehtiin, tai voitko pyytää VR:ltä korjatun kuitin?';
      app.providers.script('owner_reply', [interpretation({ answer: null, confidence: 0.4, clarification: clarify })]);
      // "en ole varma" is a keyword the route's topic assessment holds; a
      // document question's reply now reaches its strong reader instead.
      await s.reply('vr', 'Hmm, en ole varma, pitää tarkistaa.');
      await settle(app);
      assert.equal(app.providers.callsFor('owner_reply').length, 1);
      const [question] = await s.ask('vr');
      const processing = question.response_payload.reply_processing;
      assert.deepEqual([question.status, processing.state, processing.driven_action, processing.document_reading?.outcome],
        ['open', 'needs_clarification', 'owner_clarification', null], JSON.stringify(processing));
      assert.equal(question.response_payload.document_unavailable, undefined, 'an unclear reply records no fact');
      assert.match(question.question, /prints ALV 10 %/, 'the follow-up is the decider\'s');
      assert.equal(question.request_payload.evidence_topic.last_assessment.reason, 'document_reply_not_settled');
      const line = await s.line('vr');
      assert.equal(line.payload.owner_document_unavailable, undefined);
      assert.deepEqual([line.convergence_state, line.convergence_reason], ['on_owner', 'open_owner_ask']);
      assert.deepEqual(await s.journal('vr'), { count: 0, lines: [] });
    } finally { await app.stop(); }
  });

test('UK, same contract: "I lost the receipt and the shop cannot give me a copy" — the line rests as one request, in English, and is never asked again',
  { skip: applianceHarnessSkipReason() }, async () => {
    const s = await bootScenario(`nsd-gb-${process.pid}`, ['stationery'], { gb: true });
    const { app, clientId } = s;
    try {
      const [asked] = await s.ask('stationery');
      assert.equal(asked?.evidence_type, 'supporting_document', JSON.stringify(asked));
      app.providers.script('owner_reply', [readsNoSuchDocument()]);
      await s.reply('stationery', 'I lost the receipt and the shop cannot give me a copy.');
      await settle(app);
      const [question] = await s.ask('stationery');
      const processing = question.response_payload.reply_processing;
      assert.deepEqual([question.status, processing.driven_action, question.response_payload.document_unavailable?.evidence_type],
        ['open', 'owner_has_no_such_document_cannot_book', 'supporting_document'], JSON.stringify({ processing, rest: question.request_payload.document_unavailable_rest }));
      assert.match(question.question, /^“CARD PAYMENT RYMAN STATIONERY LONDON” 2026-03-04 \(48\.00 GBP\) cannot be booked without the receipt or source document\. I have recorded that you do not have it\./);
      const line = await s.line('stationery');
      assert.deepEqual([line.coding_state, line.convergence_state], ['asked', 'on_owner']);
      await s.assertNeverAskedAgain('stationery', { questionId: question.id, question: question.question });

      // The owner finds the receipt after all: a reply that brings it is read
      // by the coder without the earlier fact, and the fact no longer stands.
      await app.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload)
        values('ryman-receipt',$1,$2,'Ryman receipt 04-03-2026.pdf','receipt','completed',48.00,8.00,'GBP','2026-03-04','{}')`, [app.firmId, clientId]);
      await app.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
        values('ryman-receipt-0',$1,$2,'ryman-receipt',1,'Stationery',48.00,'{}')`, [app.firmId, clientId]);
      const calls = app.providers.callsFor('owner_reply').length;
      const found = await s.reply('stationery', 'Found it after all, here it is.', ['ryman-receipt']);
      assert.equal(found.recode?.applied, true, JSON.stringify(found.recode));
      assert.equal(app.providers.callsFor('owner_reply').length, calls, 'a reply that brings the document is not read as "there is none"');
      const [answered] = await s.ask('stationery');
      assert.equal(answered.status, 'resolved');
      const after = await s.line('stationery');
      assert.equal(after.payload.owner_document_unavailable, undefined, 'the document supersedes the owner\'s earlier "there is none"');
      assert.equal(after.payload.ai_suggestion.document_unavailable_basis, undefined);
      assert.equal(after.payload.ai_suggestion.tax_treatment, 'VAT 20%');
    } finally { await app.stop(); }
  });
