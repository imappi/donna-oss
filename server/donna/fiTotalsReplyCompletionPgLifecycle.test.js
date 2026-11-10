// Finnish reliability pass (2026-09-12), row 5 — register item FI-03: an
// owner's reply on a totals-mismatch ask is PROCESSED, never left resting
// `replied` (two-terminal-states, CLAUDE.md). Flipped from the registered
// expected-failure fixture (FI-S5/L1, FI-S5/L2) in the slice that added the
// lane's reply consumer (server/donna/totalsMismatchReply.js, registered in the
// statutory registry's lane adapters and run by the shared owner-reply worker).
//
// The scenario: a misprinted Finnish receipt opens the RT-10 totals lane (one
// `amount_mismatch` review row, one document-anchored `supporting_document`
// ask) and the statement line posts on the printed header. Then the owner
// answers through the real HTTP resolve route:
// - a corrected copy of the same receipt that foots closes the ask and the
//   review row from the evidence alone (no model call), checked again at commit;
// - a text reply the strong model cannot turn into a confirmation becomes
//   exactly one bounded clarification; past the bound the question rests on
//   the owner as a fixed request for the corrected source, receipted on the
//   review row, and further text is not re-interpreted;
// - a text reply that confirms the printed total closes the question only
//   because a live bank match settles that exact amount.
// Across all of them: the posted journal is untouched, the corrected copy is
// preserved as its own document (never collapsed onto the original), no
// evidence link is invented, and no second ask about the receipt is minted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { FI_PROFILE, FI_SOURCES, fiSource, fiDocumentBytes, fiBankCsv, fiRoutingFixture, fiExtractionFixture,
  fiMatchingResponder, fiCodingResponder, fiDocumentDispositionFixture, fiBankDispositionResponder, fiAskDraftResponder, fiBornAccount } from './testSupport/fiReliabilitySources.js';

const CODING = 'parse-cron:coding_convergence';
const LOOPS = 'parse-cron:loops_inbox';
const PARSE = 'parse-document';
const RECEIPT_JOURNAL = [[fiBornAccount('Meals and entertainment').name, 29.34, 0, 'ALV_13_5_INPUT'], ['Vähennettävä arvonlisävero', 3.96, 0, 'NONE'], ['Business Checking · EUR', 0, 33.30, 'NONE']];

const bootFi = (runToken) => bootApplianceForTest({ runToken, firm: { jurisdiction: 'FI', currency: 'EUR' }, env: { DATABASE_POOL_MAX: '3' } });
const scriptSteadyLanes = (app) => {
  app.providers.script('document_disposition', [{ ...fiDocumentDispositionFixture(), times: Infinity }]);
  app.providers.script('bank_line_disposition', [{ respond: fiBankDispositionResponder, times: Infinity }]);
  app.providers.script('reconciliation_reasoning', [{ respond: fiMatchingResponder, times: Infinity }]);
  app.providers.script('transaction_coding', [{ respond: (request) => fiCodingResponder(request), times: Infinity }]);
  app.providers.script('ask_drafting', [{ respond: fiAskDraftResponder, times: Infinity }]);
};
const uploadReceipt = async (app, clientId, source, options = {}) => {
  app.providers.script('document_routing', [fiRoutingFixture(source.type)]);
  app.providers.script('unified_extraction', [fiExtractionFixture(source, options)]);
  return app.uploadDocument({ clientId, bytes: await fiDocumentBytes(source, options), filename: `${source.reference}${options.variant ? `-${options.variant}` : ''}.pdf`,
    mimeType: 'application/pdf', documentType: source.type });
};
const settle = async (app) => {
  for (let i = 0; i < 3; i += 1) {
    await app.tick({ functions: [PARSE] });
    await app.tick({ functions: [CODING], advanceMs: 300_000 });
    await app.tick({ functions: [LOOPS] });
  }
};
const api = async (app, path, body) => {
  const response = await app.api.request({ method: 'POST', path, auth: true, body: { firm_id: app.firmId, ...body } });
  assert.ok(response.status >= 200 && response.status < 300, `${path} → ${response.status}: ${response.text.slice(0, 400)}`);
  return response.json;
};
const askDocument = (a) => a.document_id || a.request_payload?.document_id || null;
const totalsAsks = async (app, clientId, originalId) => (await app.read.asks(clientId)).filter((a) => askDocument(a) === originalId && a.request_payload?.lane === 'totals_mismatch');
const journalOf = async (app, clientId, transactionId) => {
  const journals = (await app.query('select id from ledger_journals where client_id=$1 and source_id=$2', [clientId, transactionId])).rows;
  const lines = journals.length ? (await app.query('select a.name, l.debit, l.credit, l.tax_type from ledger_lines l join ledger_accounts a on a.id=l.account_id where l.journal_id=$1 order by l.line_no', [journals[0].id])).rows : [];
  return { count: journals.length, lines: lines.map((l) => [l.name, Number(l.debit), Number(l.credit), l.tax_type]) };
};

// The misprinted receipt, its ask and review row, and the statement line posted
// on the printed header — the state every reply starts from.
const bootTotalsScenario = async (runToken) => {
  const app = await bootFi(runToken);
  const { clientId } = await app.createClient({ profile: FI_PROFILE });
  scriptSteadyLanes(app);
  const receipt = fiSource('receipt');
  app.providers.script('unified_extraction', [fiExtractionFixture(receipt)]); // the machine re-read, still misprinted
  const original = await uploadReceipt(app, clientId, receipt);
  await app.tick({ functions: [PARSE] });
  const parsed = await app.read.document(original.documentId);
  assert.equal(parsed.parse_status, 'completed', JSON.stringify(parsed.parse_error));
  assert.equal(parsed.parse_summary?.totals_validation?.matches, false);
  const [ask] = await totalsAsks(app, clientId, original.documentId);
  assert.ok(ask, JSON.stringify(await app.read.asks(clientId)));
  assert.equal(ask.evidence_type, 'supporting_document'); assert.ok(['draft', 'open'].includes(ask.status));
  const review = (await app.read.reviewQueue(clientId)).find((r) => r.reason === 'amount_mismatch');
  assert.equal(review.status, 'open'); assert.equal(review.payload?.lane?.evidence_request_id, ask.id);
  app.providers.script('document_routing', [fiRoutingFixture('bank')]);
  await app.uploadDocument({ clientId, bytes: fiBankCsv(FI_SOURCES), filename: 'Tiliote-2026-03.csv', mimeType: 'text/csv', documentType: 'bank_statement' });
  await app.tick({ functions: [PARSE] });
  await settle(app);
  const line = (await app.read.transactions(clientId)).find((t) => t.description.includes('KAHVILA HELMI'));
  assert.equal(line.coding_state, 'posted', JSON.stringify({ coding_state: line.coding_state, refusal: line.payload?.ledger_post_refusal }));
  assert.deepEqual(await journalOf(app, clientId, line.id), { count: 1, lines: RECEIPT_JOURNAL }, 'the line posts on the printed header: net, 13,5 % input VAT, bank');
  const reply = (text, documentIds = []) => api(app, `/api/donna/firms/evidence/requests/${ask.id}/resolve`, { reply: text, document_ids: documentIds });
  return { app, clientId, receipt, original, ask, review, line, reply };
};

// What every reply must leave intact: no corruption, no invention.
const assertNoCorruption = async (ctx, { copyId = null, reviewStatus } = {}) => {
  const { app, clientId, original, review, line } = ctx;
  assert.deepEqual(await journalOf(app, clientId, line.id), { count: 1, lines: RECEIPT_JOURNAL }, 'the posted journal is untouched');
  const orig = await app.read.document(original.documentId);
  assert.deepEqual([orig.parse_status, orig.duplicate_of, Number(orig.total_amount), Number(orig.tax_amount), orig.payload?.corrections ?? null], ['completed', null, 33.30, 3.96, null], 'the original is preserved; no evidence link was invented');
  if (copyId) {
    const copy = await app.read.document(copyId);
    assert.deepEqual([copy.parse_status, copy.duplicate_of, copy.parse_summary?.totals_validation?.matches, copy.payload?.corrected_copy_of ?? null], ['completed', null, true, null], 'the corrected copy is its own document, never collapsed by amount');
  }
  assert.equal((await totalsAsks(app, clientId, original.documentId)).length, 1, 'no second ask about the receipt');
  assert.equal((await app.read.reviewQueue(clientId)).find((r) => r.id === review.id).status, reviewStatus);
  assert.deepEqual(app.providers.unscripted, []);
};
const askRow = async (ctx) => (await totalsAsks(ctx.app, ctx.clientId, ctx.original.documentId)).find((a) => a.id === ctx.ask.id);
const reviewRow = async (ctx) => (await ctx.app.read.reviewQueue(ctx.clientId)).find((r) => r.id === ctx.review.id);
// The strong owner-reply interpretation, served at the HTTP boundary.
const interpretation = (input) => {
  const body = structuredClone(loadRecording('unified_extraction/ochre-discount-line').body);
  body.content = [{ type: 'tool_use', id: 'synthetic-tool', name: 'interpret_owner_reply', input }]; body.stop_reason = 'tool_use';
  return { status: 200, body };
};
const clarification = (question) => interpretation({ answer: null, confidence: 0.4, clarification: question });

test('FI totals lane: a corrected copy that foots closes the ask and the review row from the evidence alone', { skip: applianceHarnessSkipReason() }, async () => {
  const ctx = await bootTotalsScenario(`fi-s5-copy-${process.pid}`);
  const { app, clientId, original } = ctx;
  try {
    const copy = await uploadReceipt(app, clientId, ctx.receipt, { variant: 'corrected' });
    await app.tick({ functions: [PARSE] });
    await ctx.reply('Kassakuitti oli repeytynyt; ohessa korjattu kuitti.', [copy.documentId]);
    await settle(app); // the owner-reply clock, twice over: nothing re-opens it
    const row = await askRow(ctx);
    assert.deepEqual(row.response_payload?.document_ids, [copy.documentId], 'the reply and its attachment are recorded');
    assert.equal(row.status, 'resolved', 'a corrected copy that foots at the figures the books carry closes the question');
    assert.deepEqual(row.response_payload?.totals_resolution, { kind: 'corrected_copy_foots', corrected_document_id: copy.documentId, total: 33.30, tax: 3.96,
      totals_validation: (await app.read.document(copy.documentId)).parse_summary.totals_validation });
    assert.deepEqual([row.response_payload?.reply_processing?.state, row.response_payload?.reply_processing?.settled_by, row.response_payload?.reply_processing?.model],
      ['completed', 'evidence', null], 'settled by the evidence, receipted without a model');
    assert.equal(app.providers.callsFor('owner_reply').length, 0, 'the evidence settled it; no interpretation was bought');
    assert.equal((await reviewRow(ctx)).payload?.lane?.resolution?.kind, 'corrected_copy_foots');
    const audit = (await app.query(`select metadata from audit_events where client_id=$1 and action='document.totals_mismatch.resolved' and resource_id=$2`, [clientId, original.documentId])).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].metadata.journal_changed, false);
    await assertNoCorruption(ctx, { copyId: copy.documentId, reviewStatus: 'resolved' });
  } finally { await app.stop(); }
});

test('FI totals lane: a text-only reply becomes one bounded clarification, then rests on the owner as a fixed request for the corrected copy', { skip: applianceHarnessSkipReason() }, async () => {
  const ctx = await bootTotalsScenario(`fi-s5-text-${process.pid}`);
  const { app, clientId, original } = ctx;
  try {
    const firstQuestion = 'Tiedätkö, paljonko maksoit Kahvila Helmille 11.3.2026? Jos et, voisitko pyytää kahvilasta korjatun kuitin KH-4471?';
    app.providers.script('owner_reply', [clarification(firstQuestion)]);
    await ctx.reply('En tiedä.');
    await settle(app);
    let row = await askRow(ctx);
    assert.equal(row.response_payload?.reply, 'En tiedä.', 'the reply is recorded');
    assert.deepEqual([row.status, row.question], ['open', firstQuestion], 'one specific clarification, back on the owner');
    assert.deepEqual([row.response_payload?.reply_processing?.state, row.response_payload?.reply_processing?.model], ['needs_clarification', 'claude-opus-4-8'], 'the interpreting model is part of the receipt');
    assert.equal((await reviewRow(ctx)).payload?.lane?.clarification_exhausted, undefined);
    await assertNoCorruption(ctx, { reviewStatus: 'open' });

    // The bound: a second unclear answer does not buy a second clarification.
    app.providers.script('owner_reply', [clarification('Voisitko vielä tarkistaa summan?')]);
    await ctx.reply('En vieläkään tiedä.');
    await settle(app);
    row = await askRow(ctx);
    assert.equal(row.status, 'open', 'the discrepancy rests on the owner, never on an exhausted counter');
    assert.match(row.question, /corrected receipt/);
    assert.equal(row.response_payload?.reply_processing?.driven_action, 'owner_clarification_exhausted');
    assert.equal((await reviewRow(ctx)).payload?.lane?.clarification_exhausted, true, 'the exhaustion is surfaced on the review row');
    assert.equal((await app.query(`select count(*)::int n from audit_events where client_id=$1 and action='document.totals_mismatch.clarification_exhausted'`, [clientId])).rows[0].n, 1);
    const calls = app.providers.callsFor('owner_reply').length;
    await ctx.reply('Ei vieläkään tietoa.');
    await settle(app);
    row = await askRow(ctx);
    assert.equal(row.status, 'open'); assert.match(row.question, /corrected receipt/);
    assert.equal(app.providers.callsFor('owner_reply').length, calls, 'past the bound text is not re-interpreted');
    assert.equal((await app.query(`select count(*)::int n from audit_events where client_id=$1 and action='document.totals_mismatch.clarification_exhausted'`, [clientId])).rows[0].n, 1, 'exhaustion is receipted once');
    await assertNoCorruption(ctx, { reviewStatus: 'open' });
  } finally { await app.stop(); }
});

test('FI totals lane: a text reply confirming the printed total closes the question only on the matching bank settlement', { skip: applianceHarnessSkipReason() }, async () => {
  const ctx = await bootTotalsScenario(`fi-s5-confirm-${process.pid}`);
  const { app, clientId, line } = ctx;
  try {
    app.providers.script('owner_reply', [interpretation({ answer: { printed_total_confirmed: true, explanation: 'Paid 33,30 €; the coffee line is misprinted on the till slip.' }, confidence: 0.97, clarification: null })]);
    await ctx.reply('Maksoin 33,30 €, kahvirivi on tulostunut kuittiin väärin.');
    await settle(app);
    const row = await askRow(ctx);
    assert.equal(row.status, 'resolved', JSON.stringify(row.response_payload?.reply_processing));
    assert.deepEqual([row.response_payload?.totals_resolution?.kind, row.response_payload?.totals_resolution?.bank_transaction_id, row.response_payload?.totals_resolution?.total],
      ['owner_confirmed_printed_total', line.id, 33.30], 'confirmed against the bank settlement the books already carry');
    assert.equal(row.response_payload?.reply_processing?.model, 'claude-opus-4-8');
    await assertNoCorruption(ctx, { reviewStatus: 'resolved' });
  } finally { await app.stop(); }
});
