// SG-only continuation of hostedIntakePgLifecycle.test.js. The client, chart,
// principal and readiness generation come from that test's real create route.
// Storage and provider services are synthetic. This is not deployed/live QA.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { installRecordedProviders, loadRecording } from '../../testSupport/recordedProviders.js';
import { handleParseEvent } from '../../inngest/parseDocument.js';
import { rowToTransactionPayload } from '../../db/transactions.js';
import { setClientFlagStage } from '../../clientConfig.js';
import { buildGstF5FromLedgerLines } from '../gstReturn.js';
import { GST_F5_BOX_PROVENANCE } from '../gstCodes.js';

const response = payload => {
  const fixture = structuredClone(loadRecording('document_routing/ochre-supplier-bill').body);
  fixture.output[0].content[0].text = JSON.stringify(payload);
  return { status: 200, body: fixture };
};
const bankBytes = Buffer.from('Date,Description,Debit,Credit,Balance,Currency\n'
  + '01/09/2026,PAYNOW 201812345K,100,,900,SGD\n'
  + '02/09/2026,GIRO-IRAS,20,,880,SGD\n'
  + '03/09/2026,FAST TRANSFER,30,,850,SGD\n');
const billExtraction = {
  extraction_status: 'validated', extraction_confidence: 0.98,
  header: { counterparty_name: 'Synthetic Office Supplier', counterparty_role: 'vendor',
    document_date: '2026-09-01', due_date: null, currency: 'SGD', subtotal_amount: 100,
    tax_amount: 0, shipping_amount: 0, discount_amount: 0, rounding_amount: 0, total_amount: 100,
    line_amounts_include_tax: true, reference_number: 'SYNTHETIC-SG-001', references: [],
    payment_status: 'unpaid', payment_terms_phrase: null },
  lines: [{ description: 'Office supplies', amount: 100, quantity: 1, unit_price: 100, tax_rate: null }], warnings: []
};
const syntheticPdf = async lines => {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2026-09-01T00:00:00Z')); pdf.setModificationDate(new Date('2026-09-01T00:00:00Z'));
  const page = pdf.addPage(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((text, index) =>
    page.drawText(text, { x: 40, y: 780 - index * 24, size: 11, font }));
  return Buffer.from(await pdf.save());
};

export const sgIntakePdf = draft => syntheticPdf([
  'SYNTHETIC ACRA BUSINESS PROFILE - TEST TRANSCRIPTION', `Name: ${draft.company_name}`,
  `UEN: ${draft.registration_number}`, `Entity type: ${draft.entity_type}`,
  `Incorporated: ${draft.incorporation_date}`, 'Jurisdiction: Singapore; currency: SGD',
  'Registered office: 1 Fixture Road, Singapore 000001', 'Entity status: Live company (synthetic fixture)',
  ...draft.officers.map(row => `${row.role}: ${row.name}; appointed ${row.appointed_on}`),
  ...draft.shareholders.map(row => `Shareholder: ${row.name}; ${row.holding}`)
]);
const pdfBytes = companyName => syntheticPdf([
  'SYNTHETIC TEST INVOICE - NOT CUSTOMER MATERIAL', 'Supplier: Synthetic Office Supplier',
  `Buyer: ${companyName}`, 'Date: 2026-09-01', 'Reference: SYNTHETIC-SG-001',
  'Office supplies SGD 100.00', 'No GST charged. Total SGD 100.00'
]);

export async function proveSgReviewFlow({ t, seed, request, firmId, clientId, profile, originalChart, realFetch }) {
  const files = new Map(); const events = []; const exchanges = [];
  // Same small storage-provider HTTP contract as cloudProducerPgLifecycle;
  // real signed PUT, subsequent server GET, checksum admission and persistence.
  const storage = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const key = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\/object\/(upload\/sign\/)?|^\/put\//, ''));
    exchanges.push({ method: req.method, key });
    if (req.method === 'POST' && url.pathname.startsWith('/storage/v1/object/upload/sign/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: `http://127.0.0.1:${storage.address().port}/put/${encodeURIComponent(key)}` })); return;
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/put/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (files.has(key)) { res.statusCode = 409; res.end('{}'); return; }
      files.set(key, Buffer.concat(chunks)); res.end('{}'); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/storage/v1/object/')) {
      res.statusCode = files.has(key) ? 200 : 404; res.end(files.get(key) || 'missing'); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));
  const priorFetch = globalThis.fetch;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-only-no-network';
  globalThis.fetch = (address, options) => {
    const url = new URL(String(address));
    if (url.origin === 'https://sg-intake.invalid' && url.pathname.startsWith('/storage/v1/')) {
      return realFetch(`http://127.0.0.1:${storage.address().port}${url.pathname}${url.search}`, options);
    }
    if (url.hostname === 'inn.gs' || (url.origin === 'http://localhost:8288' && url.pathname === '/e/NO_EVENT_KEY_SET')) {
      events.push(JSON.parse(options.body));
      return Promise.resolve(new Response(JSON.stringify({ ids: ['synthetic-event'], status: 200 })));
    }
    return priorFetch(address, options);
  };
  const providers = installRecordedProviders();
  const count = async table => {
    // Fixed SQL keeps these fixture reads inside the existing closed writer scan.
    let result;
    switch (table) {
      case 'documents': result = await seed.query('select count(*)::int n from documents where client_id=$1', [clientId]); break;
      case 'ledger_journals': result = await seed.query('select count(*)::int n from ledger_journals where client_id=$1', [clientId]); break;
      case 'gst_returns': result = await seed.query('select count(*)::int n from gst_returns where client_id=$1', [clientId]); break;
      case 'client_evidence_requests': result = await seed.query('select count(*)::int n from client_evidence_requests where client_id=$1', [clientId]); break;
      case 'audit_events': result = await seed.query('select count(*)::int n from audit_events where client_id=$1', [clientId]); break;
      default: throw new Error(`Unsupported SG fixture count: ${table}`);
    }
    return result.rows[0].n;
  };
  const sources = () => seed.query('select id,filename,document_type,parse_status,document_date,convergence_state,convergence_reason,checksum_sha256,storage_object_key from documents where client_id=$1 order by filename', [clientId]).then(r => r.rows);
  const exportDraft = (token = 'a', period = '2026-Q3', id = clientId) => request(token,
    `/api/donna/firms/reports/singapore-gst-f5-draft?firm_id=${firmId}&client_id=${id}&period=${period}`);
  const sign = (filename, bytes, extra = {}) => request('a', '/api/donna/firms/documents/upload-url', {
    firm_id: firmId, client_id: clientId, filename, mime_type: filename.endsWith('.csv') ? 'text/csv' : 'application/pdf',
    size: bytes.length, checksum_sha256: createHash('sha256').update(bytes).digest('hex'), ...extra
  });
  const upload = async (filename, bytes) => {
    const signed = await sign(filename, bytes);
    assert.equal(signed.status, 200, JSON.stringify(signed));
    assert.equal(signed.body.intake_state, 'quarantined');
    assert.equal((await realFetch(signed.body.signed_url, { method: 'PUT', body: bytes })).status, 200);
    const document = { id: `${clientId}-${filename}`, client_id: clientId, filename, document_type: 'unknown',
      storage_bucket: signed.body.bucket, storage_object_key: signed.body.key,
      checksum_sha256: signed.body.checksum_sha256, file_size: bytes.length, mime_type: signed.body.content_type,
      file_storage: { provider: 'supabase_storage', bucket: signed.body.bucket, key: signed.body.key,
        mime_type: signed.body.content_type, size: bytes.length } };
    const registered = await request('a', '/api/donna/firms/documents/register', { firm_id: firmId, documents: [document] });
    assert.equal(registered.status, 200, JSON.stringify(registered));
    const row = registered.body.documents[0];
    assert.equal(row.client_id, clientId); assert.equal(row.parse_status, 'pending');
    assert.ok(row.parse_run_id); assert.equal(row.checksum_sha256, document.checksum_sha256);
    assert.deepEqual(files.get(`${signed.body.bucket}/${signed.body.key}`), bytes);
    return { row, document };
  };
  const run = uploaded => handleParseEvent({ event: { data: { firm_id: firmId, document_id: uploaded.row.id,
    parse_run_id: uploaded.row.parse_run_id } }, step: { run: async (_name, fn) => fn() },
    logger: { info() {}, warn() {}, error() {} } });
  try {
    assert.equal((await exportDraft()).body.code, 'SINGAPORE_GST_RETURN_DISABLED', 'birth grants no statutory export');
    assert.equal((await exportDraft('b')).status, 403);
    const bytes = await pdfBytes(profile.companyName);
    const foreignClient = (await seed.query('select id from clients where firm_id=$1 limit 1', ['sg-fixture-b'])).rows[0].id;
    const ordinaryClient = (await seed.query("select id from clients where firm_id=$1 and entity_type='sg-llp'", [firmId])).rows[0].id;
    const identityObservations = [];
    const uploadConsequences = async () => ({
      ...(await seed.query(`select (select count(*)::int from documents) documents,
        (select count(*)::int from audit_events) audits, (select count(*)::int from local_jobs) jobs`)).rows[0],
      events: events.length, exchanges: exchanges.length, storedObjects: files.size
    });
    for (const [kind, id] of [['missing', 'missing-client'], ['foreign', foreignClient], ['nonpilot', ordinaryClient]]) {
      const before = await uploadConsequences();
      const signed = await sign(`${kind}.pdf`, bytes, { client_id: id });
      const body = signed.body;
      assert.ok(!body.key || body.key.startsWith(`${firmId}/${id}/`), 'capability stays under requesting firm prefix');
      // Exercise registration independently after a refused sign with a complete
      // synthetic reference. An absent key would stop at shape validation (400)
      // and never prove the writer's ownership refusal. No probe performs a PUT.
      const bucket = body.bucket || 'donna-evidence';
      const key = body.key || `${firmId}/${id}/evidence/${kind}.pdf`;
      const registered = await request('a', '/api/donna/firms/documents/register', { firm_id: firmId, documents: [{
        id: `sg-e2e-${kind}-probe`, client_id: id, filename: `${kind}.pdf`, document_type: 'unknown',
        storage_bucket: bucket, storage_object_key: key, checksum_sha256: createHash('sha256').update(bytes).digest('hex'),
        file_size: bytes.length, mime_type: 'application/pdf', file_storage: { provider: 'supabase_storage',
          bucket, key, size: bytes.length, mime_type: 'application/pdf' }
      }] });
      if (kind === 'nonpilot') {
        assert.equal(signed.status, 200, JSON.stringify(signed));
        assert.equal(registered.status, 200, JSON.stringify(registered));
        assert.equal(registered.body.documents[0].firm_id, firmId);
        assert.equal(registered.body.documents[0].client_id, id);
        assert.equal(registered.body.documents[0].parse_status, 'pending');
      } else {
        assert.equal(signed.status, 404, JSON.stringify(signed));
        assert.equal(body.signed_url, undefined);
        assert.equal(registered.status, 404, JSON.stringify(registered));
        assert.equal(registered.body.documents, undefined);
        assert.deepEqual(await uploadConsequences(), before, `${kind} client cannot sign, register or enqueue`);
      }
      identityObservations.push({ kind, sign_status: signed.status, sign_keys: Object.keys(body).sort(),
        key: body.key, register_status: registered.status, register_code: registered.body.code || null,
        registered: (registered.body.documents || []).map(row => ({ id: row.id, firm_id: row.firm_id,
          client_id: row.client_id, parse_status: row.parse_status })) });
    }
    t.diagnostic(`SG-E2E upload identity isolation: ${JSON.stringify(identityObservations)}`);
    assert.equal(await count('documents'), 0, 'negative probes never contaminate the coherent client');
    assert.equal((await exportDraft('a', '2026-Q3', foreignClient)).status, 404, 'draft reader independently requires firm/client identity');
    const bill = await upload('source-01.pdf', bytes);
    const bank = await upload('source-02.csv', bankBytes);
    const pending = await sources(); assert.ok(pending.every(row => row.parse_status === 'pending'));
    const poll = await request('a', `/api/donna/firms/documents/parse-status?firm_id=${firmId}&ids=${bill.row.id},${bank.row.id}`);
    assert.equal(poll.status, 200); assert.equal(poll.body.documents.length, 2);
    assert.ok(poll.body.documents.every(row => row.parse_status === 'pending'));
    const repeat = await request('a', '/api/donna/firms/documents/register', { firm_id: firmId, documents: [bill.document] });
    assert.equal(repeat.status, 200); assert.equal(repeat.body.documents[0].id, bill.row.id);
    assert.equal(await count('documents'), 2);
    // Provider fixture selects the family and transcription; real router,
    // cloud specialist, generic CSV parser and writers own every later field.
    providers.script('document_routing', [response({ document_family: 'invoice_or_bill', confidence: 0.98,
      direction_hint: 'ap', candidate_families: [{ family: 'invoice_or_bill', confidence: 0.98 }],
      language_hint: 'en', reason: 'Synthetic supplier invoice names the client as buyer.' })]);
    providers.script('supplier_bill_extraction', [response(billExtraction)]);
    providers.script('document_routing', [response({ document_family: 'bank_statement', confidence: 0.98,
      direction_hint: 'neutral', candidate_families: [{ family: 'bank_statement', confidence: 0.98 }],
      language_hint: 'en', reason: 'Synthetic dated CSV account movements.' })]);
    let codingRequest;
    providers.script('transaction_coding', [{ respond: input => {
      codingRequest = JSON.parse(input.input);
      return response({ suggestions: codingRequest.transactions.map(row => ({ transaction_id: row.id,
        proposed_account: 'Office expenses', tax_treatment: 'No GST', contact: '', confidence: 'low', materiality: 'normal',
        evidence_required: true, posting_requirement: 'single_account', ask_client_question: 'What did this synthetic payment cover?',
        support_note: '', reasoning: 'Synthetic context-only response.', warnings: [], alternatives: [], remember_candidate: false,
        merchant_pattern: '', auto_explain_limit: 0 })), group_summary: [] });
    } }]);

    assert.equal((await run(bill)).outcome, 'completed');
    assert.equal((await run(bank)).outcome, 'completed');
    providers.assertNoUnscripted();
    const completed = await sources();
    assert.ok(completed.every(row => row.parse_status === 'completed'));
    assert.equal(completed.find(row => row.id === bill.row.id).document_type, 'supplier_bill');
    assert.equal(completed.find(row => row.id === bank.row.id).document_type, 'bank_statement');
    const detail = (await seed.query('select * from documents where id=$1', [bill.row.id])).rows[0];
    assert.equal(detail.currency, 'SGD'); assert.equal(Number(detail.total_amount), 100);
    assert.equal(detail.vendor_name, 'Synthetic Office Supplier');
    assert.equal(detail.parse_summary.totals_validation.matches, true);
    assert.equal((await seed.query('select count(*)::int n from document_lines where document_id=$1', [bill.row.id])).rows[0].n, 1);
    const persisted = (await seed.query('select * from transactions where client_id=$1 order by transaction_date,id', [clientId])).rows;
    assert.equal(persisted.length, 3);
    const transactions = persisted.map(rowToTransactionPayload);
    assert.deepEqual(transactions.map(row => row.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.ok(persisted.every(row => row.document_id === bank.row.id));
    assert.deepEqual(codingRequest.transactions.map(row => row.bank_rail_evidence.hints.sg_rail), ['paynow', 'giro', 'fast']);
    assert.deepEqual((await seed.query('select * from transactions where client_id=$1 order by transaction_date,id', [clientId])).rows, persisted,
      'read-only assertions do not mutate persisted coding or source');
    assert.equal(await count('ledger_journals'), 0);
    assert.deepEqual((await seed.query('select code,name,account_type,normal_balance,canonical_role,status,payload from ledger_accounts where firm_id=$1 and client_id=$2 order by name', [firmId, clientId])).rows, originalChart);

    const snapshot = await request('a', `/api/donna/firms/snapshot?firm_id=${firmId}`);
    assert.equal(snapshot.status, 200);
    const visibleClient = snapshot.body.clients.find(row => row.id === clientId);
    assert.deepEqual(visibleClient.bizfile, profile.bizfile);
    assert.equal(visibleClient.runtime_readiness.accounting_ready, false);
    const visibleTransactions = snapshot.body.transactions.filter(row => row.client_id === clientId);
    assert.equal(visibleTransactions.length, 3);
    assert.deepEqual(visibleTransactions.map(row => row.date).sort(), transactions.map(row => row.date));
    assert.ok(visibleTransactions.every(row => row.document_id === bank.row.id));
    assert.equal(snapshot.body.documents.filter(row => row.client_id === clientId).length, 2);
    assert.equal(snapshot.body.documents.find(row => row.id === bill.row.id).document_date, '2026-09-01');
    assert.equal(await count('client_evidence_requests'), 0, 'processing fixture never sends owner questions');
    // F-2 (SEV-1): the scripted coding above is low-confidence + evidence-required, so it can
    // never auto-apply and the "zero journals" claim above was vacuous. Same real intake, real
    // batch coder, a CONFIDENT recorded coding: the review-only book still posts nothing, the
    // refusal is the existing policy_failed receipt, and the line stays proposed.
    const confidentBytes = Buffer.from('Date,Description,Debit,Credit,Balance,Currency\n04/09/2026,CONFIDENT SYNTHETIC TRAVEL,12,,788,SGD\n');
    const confident = await upload('source-04.csv', confidentBytes);
    providers.script('document_routing', [response({ document_family: 'bank_statement', confidence: 0.98,
      direction_hint: 'neutral', candidate_families: [{ family: 'bank_statement', confidence: 0.98 }],
      language_hint: 'en', reason: 'Synthetic dated CSV account movements.' })]);
    providers.script('transaction_coding', [{ respond: input => response({ suggestions: JSON.parse(input.input).transactions.map(row => ({
      transaction_id: row.id, proposed_account: 'Office expenses', tax_treatment: 'No GST', contact: '', confidence: /CONFIDENT/.test(row.description) ? 'high' : 'low',
      materiality: 'normal', evidence_required: !/CONFIDENT/.test(row.description), posting_requirement: 'single_account', ask_client_question: 'What did this synthetic payment cover?',
      support_note: '', reasoning: 'Synthetic confident response.', warnings: [], alternatives: [], remember_candidate: false,
      merchant_pattern: '', auto_explain_limit: 0 })), group_summary: [] }) }]);
    assert.equal((await run(confident)).outcome, 'completed');
    const confidentRows = (await seed.query('select id,coding_state,payload from transactions where client_id=$1 and document_id=$2', [clientId, confident.row.id])).rows;
    assert.equal(confidentRows.length, 1);
    assert.equal(confidentRows[0].payload.ai_suggestion?.confidence, 'high', 'the confident coding really reached the batch coder');
    assert.notEqual(confidentRows[0].coding_state, 'posted');
    assert.equal(await count('ledger_journals'), 0, 'review-only birth scope: a confident line never posts');
    const refused = (await seed.query(`select metadata from audit_events where client_id=$1 and action in ('transaction.coding.policy_failed','runtime.readiness_admission_blocked')
      and metadata::text like '%processing_review_only%'`, [clientId])).rows;
    assert.ok(refused.length >= 1, 'the refusal is receipted with the existing reason code');
    // Remove the probe so the later source-readiness/export assertions keep their exact fixture.
    const probeIds = confidentRows.map(row => row.id);
    await seed.query('delete from convergence_marks where client_id=$1 and target_id = any($2::text[])', [clientId, [...probeIds, confident.row.id]]);
    await seed.query('delete from transaction_review_queue where client_id=$1 and item_id = any($2::text[])', [clientId, probeIds]);
    await seed.query('delete from transactions where client_id=$1 and id = any($2::text[])', [clientId, probeIds]);
    await seed.query('delete from documents where client_id=$1 and id=$2', [clientId, confident.row.id]);

    const pendingOctober = await upload('source-03.csv', Buffer.from('Date,Description,Debit,Credit,Balance,Currency\n01/10/2026,Pending synthetic source,40,,810,SGD\n'));
    assert.equal(pendingOctober.row.parse_status, 'pending');

    // Explicit local test grant AFTER processing; this is not the supported
    // SG birth profile and must not be mistaken for production enrollment.
    await setClientFlagStage(seed, { firmId, clientId, flagKey: 'SINGAPORE_GST_RETURN', stage: 'canary',
      source: 'manual', reason: 'Synthetic read-only SG-E2E export probe', actorType: 'firm_member', actorId: 'member-a' });
    // Fixed read statements preserve the complete rows, not just counts: an
    // export may neither mutate an existing source nor create downstream work.
    const exportEffects = async () => ({
      database: (await seed.query(`select
        (select jsonb_agg(to_jsonb(r) order by id) from documents r) documents,
        (select jsonb_agg(to_jsonb(r) order by id) from transactions r) transactions,
        (select jsonb_agg(to_jsonb(r) order by id) from ledger_journals r) journals,
        (select jsonb_agg(to_jsonb(r) order by id) from ledger_lines r) lines,
        (select jsonb_agg(to_jsonb(r) order by id) from gst_returns r) returns,
        (select jsonb_agg(to_jsonb(r) order by id) from client_evidence_requests r) asks,
        (select jsonb_agg(to_jsonb(r) order by id) from audit_events r) audits,
        (select jsonb_agg(to_jsonb(r) order by id) from client_capability_config r) config,
        (select jsonb_agg(to_jsonb(r) order by id) from reconciliation_matches r) matches,
        (select jsonb_agg(to_jsonb(r) order by id) from local_jobs r) jobs`)).rows[0],
      events: structuredClone(events), exchanges: structuredClone(exchanges),
      files: [...files].map(([key, bytes]) => [key, createHash('sha256').update(bytes).digest('hex')]),
      providerCalls: providers.calls.length
    });
    const before = await exportEffects();
    const bankSource = (await seed.query('select parse_summary,payload from documents where id=$1', [bank.row.id])).rows[0];
    assert.equal(bankSource.parse_summary.statement_period, '2026-09', 'actual parser inferred a display month');
    assert.ok(!bankSource.payload.statement_summary?.period_start, 'CSV has no persisted printed period');
    const liveMatches = (await seed.query(`select bank_transaction_id,matched_object_id,status from reconciliation_matches
      where firm_id=$1 and client_id=$2 and status in ('suggested','auto_matched','confirmed') order by id`, [firmId, clientId])).rows;
    assert.equal(liveMatches.length, 1, 'real post-parse matching links this invoice once');
    assert.equal(liveMatches[0].matched_object_id, bill.row.id);
    assert.equal(liveMatches[0].bank_transaction_id, persisted[0].id);
    const txIds = persisted.map(row => row.id).sort();
    const csvIds = [bank.row.id, pendingOctober.row.id].sort();
    const observations = [];
    for (const key of ['2026-Q2', '2026-Q3', '2026-Q4']) {
      const response = await exportDraft('a', key);
      assert.equal(response.status, 200, JSON.stringify(response));
      const artifact = response.body;
      const calculation = buildGstF5FromLedgerLines({ period: key, lines: [] });
      assert.equal(artifact.firm_id, firmId); assert.equal(artifact.client_id, clientId);
      assert.equal(artifact.jurisdiction, 'SG'); assert.equal(artifact.currency, 'SGD');
      assert.equal(artifact.scope, 'draft_for_firm_review');
      assert.deepEqual(artifact.filing, { submitted: false, channel: null });
      assert.deepEqual(artifact.provenance.boxMap, GST_F5_BOX_PROVENANCE,
        'draft carries the current dated box-map evidence without granting filing or clearing source blockers');
      assert.deepEqual(artifact.gstReturn, calculation.gstReturn, 'posted-ledger nil arithmetic is unchanged');
      assert.deepEqual(artifact.calculation_review, calculation.review);
      assert.equal(artifact.gstReturn.nilReturn, true);
      assert.equal(artifact.review.status, 'needs_review');
      const sources = artifact.source_readiness;
      assert.equal(sources.scope, 'persisted_client_local_sources_only');
      assert.deepEqual(sources.period, calculation.period);
      assert.equal(sources.as_of, artifact.as_of);
      assert.equal(sources.status, 'needs_review');
      assert.equal(sources.observation, 'local_sources_observed', 'Q2 is not a genuinely source-empty neighbor');
      assert.deepEqual(sources.documents.map(row => row.id).sort(),
        key === '2026-Q3' ? [...csvIds, bill.row.id].sort() : csvIds);
      for (const id of csvIds) {
        const item = sources.documents.find(row => row.id === id);
        assert.equal(item.period_scope, 'period_unknown'); assert.equal(item.dates, null);
        assert.deepEqual(item.reasons, id === bank.row.id ? ['period_unknown'] : ['period_unknown', 'source_processing']);
        assert.deepEqual(item.posted_journal_ids, []);
      }
      const bankItem = sources.documents.find(row => row.id === bank.row.id);
      assert.equal(bankItem.parse_status, 'completed');
      assert.deepEqual(bankItem.imported_transaction_ids.slice().sort(), txIds);
      assert.deepEqual(bankItem.observed_activity_dates, {
        starts_on: '2026-09-01', ends_on: '2026-09-03', basis: 'imported_transaction_dates_not_coverage'
      });
      assert.deepEqual(bankItem.parsed_activity_dates, {
        starts_on: '2026-09-01', ends_on: '2026-09-03', basis: 'parser_transaction_bounds_not_coverage'
      });
      const pending = sources.documents.find(row => row.id === pendingOctober.row.id);
      assert.equal(pending.parse_status, 'pending'); assert.deepEqual(pending.imported_transaction_ids, []);
      assert.equal(pending.observed_activity_dates, null);
      assert.deepEqual(sources.transactions.map(row => row.id).sort(), key === '2026-Q3' ? txIds : []);
      assert.deepEqual(sources.excluded_transaction_ids.slice().sort(), key === '2026-Q3' ? [] : txIds);
      assert.deepEqual(sources.excluded_documents.map(row => [row.id, row.reason]),
        key === '2026-Q3' ? [] : [[bill.row.id, 'out_of_period']]);
      if (key === '2026-Q3') {
        const invoice = sources.documents.find(row => row.id === bill.row.id);
        assert.equal(invoice.period_scope, 'in_period'); assert.equal(invoice.dates.starts_on, '2026-09-01');
        assert.deepEqual(invoice.reasons, ['linked_transactions_unfinished']);
        assert.deepEqual(invoice.matched_transaction_ids, [persisted[0].id]);
        assert.deepEqual(invoice.posted_journal_ids, []);
        for (const item of sources.transactions) {
          assert.equal(item.document_id, bank.row.id); assert.equal(item.period_scope, 'in_period');
          assert.equal(item.coding_state, 'proposed'); assert.deepEqual(item.posted_journal_ids, []);
          assert.deepEqual(item.matched_document_ids, item.id === persisted[0].id ? [bill.row.id] : []);
          assert.deepEqual(item.reasons, ['transaction_unposted', 'transaction_unfinished']);
          assert.equal(item.dates.starts_on, transactions.find(row => row.id === item.id).date);
        }
      }
      assert.deepEqual(sources.concerns.map(row => [row.target_type, row.target_id]).sort(),
        [...csvIds.map(id => ['document', id]), ...(key === '2026-Q3'
          ? txIds.map(id => ['transaction', id]) : [])].sort());
      for (const concern of sources.concerns) {
        const item = (concern.target_type === 'document' ? sources.documents : sources.transactions)
          .find(row => row.id === concern.target_id);
        assert.deepEqual(concern.reasons, item.reasons);
        assert.equal(concern.period_scope, item.period_scope);
      }
      assert.deepEqual(artifact.review.blockers.slice().sort(), [...new Set(sources.concerns
        .flatMap(row => row.reasons).map(reason => `local_source:${reason}`))].sort());
      observations.push({ period: key, review: artifact.review.status,
        nilReturn: artifact.gstReturn.nilReturn, documents: sources.documents, concerns: sources.concerns });
    }
    assert.deepEqual(await exportEffects(), before, 'all three exports have zero database, storage, event or model effects');
    // Original ready/nil diagnostic evidence remains in the historical report.
    t.diagnostic(`SG-E2E source-readiness corrected: ${JSON.stringify(observations)}`);
    providers.assertNoUnscripted();
    assert.ok(exchanges.some(row => row.method === 'PUT')); assert.ok(exchanges.some(row => row.method === 'GET'));
  } finally {
    providers.restore(); globalThis.fetch = priorFetch;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
    storage.closeAllConnections(); await new Promise(resolve => storage.close(resolve));
  }
}
