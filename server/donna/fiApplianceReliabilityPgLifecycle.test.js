// Finnish reliability pass (2026-09-12) — the real desktop assembly on a real
// PostgreSQL: routes → local job queue → parse worker → matchers → coder →
// posting → asks, with every model lane answered at the HTTP boundary by
// synthetic transcriptions (testSupport/fiReliabilitySources.js). This is a
// provider-stubbed LIFECYCLE proof (wiring, ownership, idempotency, recovery);
// it says nothing about live-model quality, and live-model evidence says
// nothing about this. Expected outcomes are derived from the source
// definitions, never from anything a model was shown.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { claimNextLocalJob } from './desktop/localJobQueue.js';
import { enqueueParseDocumentJob, PARSE_DOCUMENT_FUNCTION_ID } from './desktop/parseDocumentJob.js';
import { claimParseRunInDb } from './parseDocumentsDb.js';
import { FI_PROFILE, FI_SOURCES, fiSource, fiDocumentBytes, fiBankCsv, fiRoutingFixture, fiExtractionFixture,
  fiMatchingResponder, fiCodingResponder, fiDocumentDispositionFixture, fiBankDispositionResponder, fiAskDraftResponder } from './testSupport/fiReliabilitySources.js';

const CODING = 'parse-cron:coding_convergence';
const LOOPS = 'parse-cron:loops_inbox';
const STUCK = 'parse-cron:stuck';
const PARSE = 'parse-document';

const bootFi = (runToken) => bootApplianceForTest({ runToken, firm: { jurisdiction: 'FI', currency: 'EUR' }, env: { DATABASE_POOL_MAX: '3' } });

const scriptSteadyLanes = (app) => {
  app.providers.script('document_disposition', [{ ...fiDocumentDispositionFixture(), times: Infinity }]);
  app.providers.script('bank_line_disposition', [{ respond: fiBankDispositionResponder, times: Infinity }]);
  app.providers.script('reconciliation_reasoning', [{ respond: fiMatchingResponder, times: Infinity }]);
  app.providers.script('transaction_coding', [{ respond: (request) => fiCodingResponder(request), times: Infinity }]);
  app.providers.script('ask_drafting', [{ respond: fiAskDraftResponder, times: Infinity }]);
};

const uploadSource = async (app, clientId, source, options = {}) => {
  app.providers.script('document_routing', [fiRoutingFixture(source.type)]);
  app.providers.script('unified_extraction', [fiExtractionFixture(source, options)]);
  const suffix = options.variant ? `-${options.variant}` : options.corrected ? '-korjattu' : '';
  const upload = await app.uploadDocument({ clientId, bytes: await fiDocumentBytes(source, options),
    filename: `${source.reference}${suffix}.pdf`, mimeType: 'application/pdf', documentType: source.type, ...(options.upload || {}) });
  return upload;
};

const uploadBank = async (app, clientId, sources = FI_SOURCES) => {
  app.providers.script('document_routing', [fiRoutingFixture('bank')]);
  return app.uploadDocument({ clientId, bytes: fiBankCsv(sources), filename: 'Tiliote-2026-03.csv', mimeType: 'text/csv', documentType: 'bank_statement' });
};

const settle = async (app) => {
  for (let i = 0; i < 3; i += 1) {
    await app.tick({ functions: [PARSE] });
    await app.tick({ functions: [CODING], advanceMs: 300_000 });
    await app.tick({ functions: [LOOPS] });
  }
};

// The persisted books, keyed by what the sources SAY so two arrival orders
// compare structurally (document ids differ by construction).
const observe = async (app, clientId) => {
  const q = app.query;
  const documents = (await app.read.documents(clientId)).map((d) => ({ filename: d.filename, type: d.document_type, parse_status: d.parse_status,
    total: d.total_amount == null ? null : Number(d.total_amount), tax: d.tax_amount == null ? null : Number(d.tax_amount), duplicate_of: d.duplicate_of,
    error: d.parse_error?.code || null, totals: d.parse_summary?.totals_validation?.matches ?? null }));
  const byDocId = new Map((await app.read.documents(clientId)).map((d) => [d.id, d.filename]));
  const transactions = (await app.read.transactions(clientId)).map((t) => ({ description: t.description, out: Number(t.money_out || 0), in: Number(t.money_in || 0),
    status: t.status, reconciliation_status: t.reconciliation_status, coding_state: t.coding_state, account: t.account_code,
    tax_treatment: t.payload?.ai_suggestion?.tax_treatment || null, suggestion_source: t.payload?.ai_suggestion?.source || null,
    convergence: t.convergence_state, refusal: t.payload?.ledger_post_refusal?.code || null }));
  const matches = (await app.read.matches(clientId)).map((m) => ({ document: byDocId.get(m.matched_object_id) || m.matched_object_id, type: m.matched_object_type,
    amount: Number(m.match_amount), status: m.status, line: (m.bank_transaction_id || '').split('-tx-')[1] })).sort((a, b) => `${a.document}${a.status}`.localeCompare(`${b.document}${b.status}`));
  const journals = (await q(`select t.description, j.status, j.id from ledger_journals j join transactions t on t.id=j.source_id where j.client_id=$1 order by t.transaction_date, t.id`, [clientId])).rows;
  const journalLines = [];
  for (const journal of journals) {
    const lines = (await q(`select a.name, l.debit, l.credit, l.tax_type from ledger_lines l join ledger_accounts a on a.id=l.account_id where l.journal_id=$1 order by l.line_no`, [journal.id])).rows;
    journalLines.push({ description: journal.description, status: journal.status, lines: lines.map((l) => [l.name, Number(l.debit), Number(l.credit), l.tax_type]) });
  }
  const asks = (await app.read.asks(clientId)).map((a) => ({ evidence_type: a.evidence_type, status: a.status, document: byDocId.get(a.document_id) || null,
    line: (a.transaction_id || '').split('-tx-')[1] || null, question: a.question })).sort((a, b) => `${a.evidence_type}${a.document}${a.line}`.localeCompare(`${b.evidence_type}${b.document}${b.line}`));
  const review = (await app.read.reviewQueue(clientId)).map((r) => ({ reason: r.reason, status: r.status, item_type: r.item_type }));
  const jobs = await app.read.jobs();
  return { documents, transactions, matches, journals: journalLines, asks, review, jobs };
};

const comparable = (observation) => ({
  documents: observation.documents.map(({ filename, type, parse_status, total, tax, error, totals }) => ({ filename, type, parse_status, total, tax, error, totals })).sort((a, b) => a.filename.localeCompare(b.filename)),
  transactions: observation.transactions,
  matches: observation.matches,
  journals: observation.journals,
  asks: observation.asks.map(({ evidence_type, status, document, line }) => ({ evidence_type, status, document, line }))
  // Review-queue rows are case files, never state (RT-16): the bank-first
  // order mints transient cases for lines that arrive before their documents.
  // They must all be closed, but their existence is not a book difference.
});

test('FI appliance: statement-first and documents-first converge on the same persisted books', { skip: applianceHarnessSkipReason() }, async (t) => {
  const outcomes = {};
  for (const order of ['documents_first', 'bank_first']) {
    await t.test(order, async () => {
      const app = await bootFi(`fi-order-${order.replace('_', '-')}-${process.pid}`);
      try {
        const { clientId } = await app.createClient({ profile: FI_PROFILE });
        scriptSteadyLanes(app);
        const footing = FI_SOURCES.filter((source) => !source.misprint);
        const documents = async () => { for (const source of footing) { await uploadSource(app, clientId, source); await app.tick({ functions: [PARSE] }); } };
        const banking = async () => { await uploadBank(app, clientId, footing); await app.tick({ functions: [PARSE] }); };
        if (order === 'bank_first') { await banking(); await documents(); } else { await documents(); await banking(); }
        await settle(app);
        const observation = await observe(app, clientId);
        outcomes[order] = observation;
        assert.deepEqual(app.providers.unscripted, [], 'every lane that was hit was scripted');
        assert.equal(observation.documents.length, footing.length + 1);
        assert.ok(observation.documents.every((d) => d.parse_status === 'completed'), JSON.stringify(observation.documents));
        assert.equal(observation.transactions.length, footing.length);
        assert.equal(observation.matches.filter((m) => m.status === 'auto_matched').length, footing.length, JSON.stringify({ matches: observation.matches, jobs: observation.jobs }));
        for (const source of footing) {
          const tx = observation.transactions.find((row) => row.description.toUpperCase().includes(source.counterparty.toUpperCase()) || Math.abs(row.out + row.in - source.total) < 0.005);
          assert.ok(tx, `bank line for ${source.key}`);
          assert.equal(tx.coding_state, 'posted', JSON.stringify({ source: source.key, tx, jobs: observation.jobs.filter((j) => j.status !== 'succeeded') }));
          assert.equal(tx.account, source.account);
          assert.equal(tx.tax_treatment, source.treatment);
          assert.equal(tx.convergence, 'auto_reconciled', JSON.stringify(tx));
        }
        assert.equal(observation.journals.length, footing.length, JSON.stringify(observation.journals));
        const supplies = observation.journals.find((j) => j.description.includes('TARVIKETUKKU'));
        assert.deepEqual(supplies.lines.map((l) => l.slice(0, 3)), [['Operating supplies', 200, 0], ['Vähennettävä arvonlisävero', 51, 0], ['Business Checking · EUR', 0, 251]].map((l) => l), JSON.stringify(supplies));
        assert.equal(observation.asks.filter((a) => ['draft', 'open'].includes(a.status)).length, 0, JSON.stringify(observation.asks));
        assert.deepEqual(observation.jobs.filter((j) => j.status === 'dead'), [], 'no dead-lettered job');
        assert.deepEqual(observation.review.filter((r) => r.status === 'open'), [], JSON.stringify(observation.review));
      } finally { await app.stop(); }
    });
  }
  assert.deepEqual(comparable(outcomes.bank_first), comparable(outcomes.documents_first), 'arrival order must not change the books');
});


const api = async (app, path, body) => {
  const response = await app.api.request({ method: 'POST', path, auth: true, body: { firm_id: app.firmId, ...body } });
  assert.ok(response.status >= 200 && response.status < 300, `${path} → ${response.status}: ${response.text.slice(0, 400)}`);
  return response.json;
};
const counts = async (app, clientId) => {
  const q = app.query;
  const one = async (sql) => (await q(sql, [clientId])).rows[0].n;
  return {
    documents: await one('select count(*)::int n from documents where client_id=$1'),
    transactions: await one('select count(*)::int n from transactions where client_id=$1'),
    matches: await one("select count(*)::int n from reconciliation_matches where client_id=$1 and status in ('auto_matched','confirmed','suggested')"),
    journals: await one('select count(*)::int n from ledger_journals where client_id=$1'),
    asks: await one("select count(*)::int n from client_evidence_requests where client_id=$1 and status in ('draft','open','replied')")
  };
};

test('FI appliance: duplicate uploads and repeated job delivery add no transactions, matches, journals or asks', { skip: applianceHarnessSkipReason() }, async () => {
  const app = await bootFi(`fi-dup-${process.pid}`);
  try {
    const { clientId } = await app.createClient({ profile: FI_PROFILE });
    scriptSteadyLanes(app);
    const footing = FI_SOURCES.filter((source) => !source.misprint);
    await uploadBank(app, clientId, footing); await app.tick({ functions: [PARSE] });
    const supplies = await uploadSource(app, clientId, fiSource('supplies')); await app.tick({ functions: [PARSE] });
    await settle(app);
    const before = await counts(app, clientId);
    assert.equal(before.transactions, footing.length); assert.equal(before.journals, 1); assert.equal(before.matches, 1);
    // Same bytes again, both families: the register route collapses them
    // terminal without a parse run, so nothing downstream can double.
    app.providers.script('document_routing', [fiRoutingFixture('supplier_bill')]);
    const again = await app.uploadDocument({ clientId, bytes: await fiDocumentBytes(fiSource('supplies')), filename: 'TT-88213 (1).pdf', mimeType: 'application/pdf', documentType: 'supplier_bill' });
    app.providers.script('document_routing', [fiRoutingFixture('bank')]);
    const bankAgain = await app.uploadDocument({ clientId, bytes: fiBankCsv(footing), filename: 'Tiliote-2026-03 (1).csv', mimeType: 'text/csv', documentType: 'bank_statement' });
    await settle(app);
    for (const [id, original] of [[again.documentId, supplies.documentId], [bankAgain.documentId, null]]) {
      const row = await app.read.document(id);
      assert.equal(row.parse_status, 'skipped', JSON.stringify(row));
      assert.equal(row.parse_summary?.reason, 'duplicate_auto_collapsed');
      if (original) assert.equal(row.duplicate_of, original);
      assert.equal(row.parse_run_id, null, 'a collapsed duplicate owns no parse run');
    }
    const after = await counts(app, clientId);
    assert.deepEqual({ ...after, documents: before.documents }, before, 'only the two collapsed rows were added');
    assert.equal(after.documents, before.documents + 2);
    assert.deepEqual((await app.read.jobs({ functionId: PARSE_DOCUMENT_FUNCTION_ID })).filter((j) => j.status !== 'succeeded'), []);
    // Repeated delivery of a run the worker already finished: the queue
    // dedupes an ACTIVE run, and a late second job for a finished run reads
    // the terminal row and completes without touching anything.
    const document = await app.read.document(supplies.documentId);
    const delivered = await enqueueParseDocumentJob({ firmId: app.firmId, documentId: supplies.documentId, parseRunId: document.parse_run_id, clientId, documentType: 'supplier_bill' });
    assert.equal(delivered.enqueued, true, 'a finished run is not ACTIVE, so the queue accepts the redelivery');
    const twice = await enqueueParseDocumentJob({ firmId: app.firmId, documentId: supplies.documentId, parseRunId: document.parse_run_id, clientId, documentType: 'supplier_bill' });
    assert.equal(twice.deduped, true, 'one ACTIVE job per parse run');
    const callsBefore = app.providers.calls.length;
    await app.tick({ functions: [PARSE] });
    const redelivered = (await app.read.jobs({ functionId: PARSE_DOCUMENT_FUNCTION_ID })).find((j) => String(j.id) === String(delivered.job.id));
    assert.equal(redelivered.status, 'succeeded', JSON.stringify(redelivered));
    assert.equal(redelivered.result?.handled, false); assert.equal(redelivered.result?.parse_status, 'completed');
    assert.equal(app.providers.calls.length, callsBefore, 'a redelivered finished run spends no model call');
    await settle(app);
    assert.deepEqual(await counts(app, clientId), after);
    assert.equal((await app.read.document(supplies.documentId)).parse_run_id, document.parse_run_id);
    assert.deepEqual(app.providers.unscripted, []);
  } finally { await app.stop(); }
});

// A worker killed between the queue claim and the terminal write leaves the
// job `running` past its lease and the document `processing` under the same
// run. The restarted scheduler recovers the lease; the run must then finish
// on its remaining automatic budget — never rest on a manual retry click.
const crashMidParse = async (app, clientId, documentId) => {
  const document = await app.read.document(documentId);
  const job = await claimNextLocalJob({ client: { query: app.query }, workerId: 'crashed-worker', eligibleFunctionIds: [PARSE_DOCUMENT_FUNCTION_ID] });
  assert.ok(job, 'the parse job is claimable');
  const claim = await claimParseRunInDb({ firmId: app.firmId, documentId, parseRunId: document.parse_run_id });
  assert.equal(claim.outcome, 'claimed');
  // The process dies here. Time passes: the lease and the heartbeat go stale.
  await app.query("update local_jobs set lease_expires_at = now() - interval '1 minute', locked_at = now() - interval '11 minutes' where id = $1", [job.id]);
  await app.query("update documents set parse_heartbeat_at = now() - interval '11 minutes', parse_started_at = now() - interval '11 minutes' where id = $1", [documentId]);
  return { job, parseRunId: document.parse_run_id };
};

for (const sweepFirst of [false, true]) {
  test(`FI appliance: a worker crash mid-parse resumes on the job's remaining budget (${sweepFirst ? 'stuck sweep runs before the job' : 'job recovers first'})`, { skip: applianceHarnessSkipReason() }, async () => {
    const app = await bootFi(`fi-crash-${sweepFirst ? 'sweep' : 'job'}-${process.pid}`);
    try {
      const { clientId } = await app.createClient({ profile: FI_PROFILE });
      scriptSteadyLanes(app);
      const footing = FI_SOURCES.filter((source) => !source.misprint);
      await uploadBank(app, clientId, footing); await app.tick({ functions: [PARSE] });
      const upload = await uploadSource(app, clientId, fiSource('rent'));
      const crashed = await crashMidParse(app, clientId, upload.documentId);
      if (sweepFirst) await runStuckSweep(app, { documentId: upload.documentId, expectStuck: true });
      await app.tick({ functions: [PARSE] });
      await runStuckSweep(app);
      await app.tick({ functions: [PARSE] });
      const document = await app.read.document(upload.documentId);
      const job = (await app.read.jobs({ functionId: PARSE_DOCUMENT_FUNCTION_ID })).find((j) => String(j.id) === String(crashed.job.id));
      assert.equal(document.parse_status, 'completed', JSON.stringify({ document: { status: document.parse_status, error: document.parse_error, run: document.parse_run_id }, job }));
      assert.equal(document.parse_run_id, crashed.parseRunId, 'the same run finished — no manual retry minted a new one');
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      assert.ok(job.attempt_count >= 2 && job.attempt_count <= job.max_attempts, JSON.stringify(job));
      await settle(app);
      const state = await counts(app, clientId);
      assert.equal(state.matches, 1); assert.equal(state.journals, 1);
      // The two lines that genuinely have no document may be asked about; the
      // crashed document's line and the document itself must not be.
      const rentLine = (await app.read.transactions(clientId)).find((t) => t.description.includes('SINIKELLO'));
      const crashAsks = (await app.read.asks(clientId)).filter((a) => ['draft', 'open', 'replied'].includes(a.status)
        && (a.transaction_id === rentLine.id || a.request_payload?.document_id === upload.documentId || a.document_id === upload.documentId));
      assert.deepEqual(crashAsks, [], 'a crash is a technical event, never an owner question');
      assert.equal(rentLine.coding_state, 'posted');
      assert.deepEqual((await app.read.audit({ clientId, action: 'document.parse.retry' })), [], 'no manual retry was needed');
      assert.deepEqual(app.providers.unscripted, []);
    } finally { await app.stop(); }
  });
}

// The final-attempt boundary. The queue increments attempt_count at CLAIM, so
// inside the runner `attempt.count` is the number of the attempt that is
// running now. After three crashes the fourth claim carries attempt_count 4 =
// max_attempts: it IS the last automatic attempt, and it must still reclaim
// the abandoned run and finish. A fourth crash exhausts the budget (decision
// D7 = 4): the job dead-letters, the document rests on a manual retry, and the
// manual retry route mints a fresh run — in either sweep/recovery order.
// The stuck sweep, driven until it has actually RUN (the harness clock runs
// ahead of the database clock after many one-minute ticks, so a cron job
// enqueued on one tick becomes claimable on the next). Asserts the sweep rested
// the abandoned run `failed`/STUCK when one was due.
const runStuckSweep = async (app, { documentId = null, expectStuck = false } = {}) => {
  for (let i = 0; i < 4; i += 1) {
    const receipt = await app.tick({ functions: [STUCK] });
    if (receipt.jobs.some((j) => j.function_id === STUCK && j.status === 'succeeded')) {
      if (expectStuck) {
        const document = await app.read.document(documentId);
        assert.deepEqual([document.parse_status, document.parse_error?.code, document.parse_error?.retry_owner], ['failed', 'STUCK', 'manual'], 'the sweep rested the abandoned run');
      }
      return receipt;
    }
  }
  throw new Error('the stuck sweep did not run');
};
const readJob = async (app, jobId) => (await app.read.jobs({ functionId: PARSE_DOCUMENT_FUNCTION_ID })).find((j) => String(j.id) === String(jobId));
const reclaims = (app, clientId, documentId) => app.read.audit({ clientId, action: 'document.parse.reclaimed' }).then((rows) => rows.filter((r) => r.resource_id === documentId));

// The real scheduler, one dispatch round at a time: it recovers the expired
// lease and runs the recovered attempt, which reclaims the abandoned run
// (receipted) and re-queues itself. Returns once the run is pending again
// under the same id with the job waiting — the state the next crash starts from.
const recoverUntilReclaimed = async (app, clientId, { documentId, parseRunId, jobId }, { sweepFirst, rounds = 4 }) => {
  if (sweepFirst) await runStuckSweep(app, { documentId, expectStuck: true });
  const seen = [];
  for (let i = 0; i < rounds; i += 1) {
    await app.tick({ functions: [PARSE], maxRounds: 1 });
    const document = await app.read.document(documentId);
    const job = await readJob(app, jobId);
    seen.push({ round: i + 1, parse_status: document.parse_status, run: document.parse_run_id, job: job.status, attempts: job.attempt_count, last_error: job.last_error });
    if (document.parse_status === 'pending' && document.parse_run_id === parseRunId && job.status === 'pending') return { document, job };
    if (job.status !== 'running' && job.status !== 'pending') break;
  }
  throw new assert.AssertionError({ message: `the recovered attempt did not reclaim the run: ${JSON.stringify(seen)}` });
};

const crashRepeatedly = async (app, clientId, documentId, { crashes, sweepFirst }) => {
  let crashed = await crashMidParse(app, clientId, documentId);
  assert.equal(crashed.job.attempt_count, 1);
  for (let n = 2; n <= crashes; n += 1) {
    await recoverUntilReclaimed(app, clientId, { documentId, parseRunId: crashed.parseRunId, jobId: crashed.job.id }, { sweepFirst });
    assert.equal((await reclaims(app, clientId, documentId)).length, n - 1, `attempt ${n} reclaimed the run its predecessor abandoned`);
    const again = await crashMidParse(app, clientId, documentId);
    assert.equal(String(again.job.id), String(crashed.job.id), 'the same job, no new one');
    assert.equal(again.job.attempt_count, n, `crash ${n} dies on attempt ${n}`);
    crashed = again;
  }
  return crashed;
};

for (const sweepFirst of [false, true]) {
  test(`FI appliance: three crashes mid-parse leave the fourth automatic attempt to finish the run (${sweepFirst ? 'stuck sweep runs before each recovery' : 'job recovers first'})`, { skip: applianceHarnessSkipReason() }, async () => {
    const app = await bootFi(`fi-crash3-${sweepFirst ? 'sweep' : 'job'}-${process.pid}`);
    try {
      const { clientId } = await app.createClient({ profile: FI_PROFILE });
      scriptSteadyLanes(app);
      await uploadBank(app, clientId, FI_SOURCES.filter((source) => !source.misprint)); await app.tick({ functions: [PARSE] });
      const upload = await uploadSource(app, clientId, fiSource('rent'));
      const crashed = await crashRepeatedly(app, clientId, upload.documentId, { crashes: 3, sweepFirst });
      assert.equal(crashed.job.max_attempts, 4, 'decision D7: four automatic attempts');
      // The fourth attempt: recovered, reclaims, re-claims and completes.
      if (sweepFirst) await runStuckSweep(app, { documentId: upload.documentId, expectStuck: true });
      await app.tick({ functions: [PARSE] }); await runStuckSweep(app); await app.tick({ functions: [PARSE] });
      const document = await app.read.document(upload.documentId);
      const job = await readJob(app, crashed.job.id);
      assert.equal(document.parse_status, 'completed', JSON.stringify({ document: { status: document.parse_status, error: document.parse_error, run: document.parse_run_id }, job }));
      assert.equal(document.parse_run_id, crashed.parseRunId, 'the same run finished — no manual retry minted a new one');
      assert.deepEqual([job.status, job.attempt_count, job.max_attempts], ['succeeded', 4, 4], JSON.stringify(job));
      assert.equal((await reclaims(app, clientId, upload.documentId)).length, 3, 'one reclaim per recovered attempt, the fourth included');
      assert.deepEqual((await app.read.audit({ clientId, action: 'document.parse.retry' })), [], 'no manual retry was needed');
      await settle(app);
      const state = await counts(app, clientId);
      assert.equal(state.matches, 1); assert.equal(state.journals, 1);
      const rentLine = (await app.read.transactions(clientId)).find((t) => t.description.includes('SINIKELLO'));
      assert.equal(rentLine.coding_state, 'posted');
      assert.deepEqual((await app.read.asks(clientId)).filter((a) => ['draft', 'open', 'replied'].includes(a.status)
        && (a.transaction_id === rentLine.id || a.request_payload?.document_id === upload.documentId || a.document_id === upload.documentId)), []);
      assert.deepEqual(app.providers.unscripted, []);
    } finally { await app.stop(); }
  });

  test(`FI appliance: a fourth crash exhausts the automatic budget — dead job, document on a manual retry, and the manual retry mints a fresh run (${sweepFirst ? 'stuck sweep runs before each recovery' : 'job recovers first'})`, { skip: applianceHarnessSkipReason() }, async () => {
    const app = await bootFi(`fi-crash4-${sweepFirst ? 'sweep' : 'job'}-${process.pid}`);
    try {
      const { clientId } = await app.createClient({ profile: FI_PROFILE });
      scriptSteadyLanes(app);
      await uploadBank(app, clientId, FI_SOURCES.filter((source) => !source.misprint)); await app.tick({ functions: [PARSE] });
      const upload = await uploadSource(app, clientId, fiSource('rent'));
      const crashed = await crashRepeatedly(app, clientId, upload.documentId, { crashes: 4, sweepFirst });
      // Lease recovery dead-letters the job (no fifth attempt); the sweep rests
      // the run it left behind — in either order.
      if (sweepFirst) await runStuckSweep(app, { documentId: upload.documentId, expectStuck: true });
      await app.tick({ functions: [PARSE] }); await runStuckSweep(app, { documentId: upload.documentId, expectStuck: true }); await app.tick({ functions: [PARSE] });
      const document = await app.read.document(upload.documentId);
      const job = await readJob(app, crashed.job.id);
      assert.deepEqual([job.status, job.attempt_count, job.max_attempts], ['dead', 4, 4], JSON.stringify(job));
      assert.deepEqual([document.parse_status, document.parse_error?.code, document.parse_error?.retry_owner, document.parse_run_id],
        ['failed', 'STUCK', 'manual', crashed.parseRunId], JSON.stringify(document.parse_error));
      assert.equal((await reclaims(app, clientId, upload.documentId)).length, 3, 'a dead job reclaims nothing');
      assert.deepEqual((await app.read.jobs({ functionId: PARSE_DOCUMENT_FUNCTION_ID })).filter((j) => j.dedupe_key === crashed.parseRunId && j.status !== 'dead'), [], 'no fifth automatic attempt');
      // The human's retry: a fresh run, its own job, completes (the upload's
      // scripted answers are still queued — no crashed attempt reached the provider).
      await api(app, '/api/donna/firms/documents/retry-parse', { document_ids: [upload.documentId] });
      await app.tick({ functions: [PARSE] });
      const retried = await app.read.document(upload.documentId);
      assert.equal(retried.parse_status, 'completed', JSON.stringify(retried.parse_error));
      assert.notEqual(retried.parse_run_id, crashed.parseRunId, 'the manual retry minted a new run');
      assert.equal((await app.read.audit({ clientId, action: 'document.parse.retry' })).length, 1);
      await settle(app);
      const state = await counts(app, clientId);
      assert.equal(state.matches, 1); assert.equal(state.journals, 1);
      assert.deepEqual(app.providers.unscripted, []);
    } finally { await app.stop(); }
  });
}

test('FI appliance: an invalid provider key is named as a credential failure and the corrected key finishes the run', { skip: applianceHarnessSkipReason() }, async () => {
  const app = await bootFi(`fi-auth-${process.pid}`);
  try {
    const { clientId } = await app.createClient({ profile: FI_PROFILE });
    scriptSteadyLanes(app);
    const source = fiSource('supplies');
    app.providers.script('document_routing', [fiRoutingFixture(source.type)]);
    app.providers.script('unified_extraction', [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]);
    app.providers.script('supplier_bill_extraction', [{ status: 401, body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } } }]);
    const upload = await app.uploadDocument({ clientId, bytes: await fiDocumentBytes(source), filename: `${source.reference}.pdf`, mimeType: 'application/pdf', documentType: source.type });
    await app.tick({ functions: [PARSE] });
    const failed = await app.read.document(upload.documentId);
    assert.equal(failed.parse_status, 'failed', JSON.stringify(failed.parse_error));
    assert.equal(failed.parse_error?.code, 'DOCUMENT_EXTRACTION_UNAUTHORIZED', JSON.stringify(failed.parse_error));
    assert.match(failed.parse_error?.reason || '', /_401$/);
    assert.match(failed.parse_error?.safe_user_message || '', /key/i);
    assert.doesNotMatch(failed.parse_error?.safe_user_message || '', /rejected this file/i, 'a bad key is never blamed on the document');
    assert.equal(failed.parse_error?.retryable, false);
    assert.equal(failed.parse_error?.retry_owner, 'manual');
    assert.equal((await counts(app, clientId)).asks, 0, 'a credential failure never becomes a client question');
    const jobs = await app.read.jobs({ functionId: PARSE_DOCUMENT_FUNCTION_ID });
    assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'succeeded', 'a deterministic refusal spends one attempt, not four');
    // The key is corrected in Settings; the ordinary retry route re-runs the document.
    app.providers.script('document_routing', [fiRoutingFixture(source.type)]);
    app.providers.script('unified_extraction', [fiExtractionFixture(source)]);
    const retried = await api(app, '/api/donna/firms/documents/retry-parse', { document_ids: [upload.documentId] });
    assert.equal(retried.documents?.length, 1, JSON.stringify(retried));
    assert.equal(retried.documents[0].parse_status, 'pending');
    await app.tick({ functions: [PARSE] });
    const recovered = await app.read.document(upload.documentId);
    assert.equal(recovered.parse_status, 'completed', JSON.stringify(recovered.parse_error));
    assert.equal(Number(recovered.total_amount), source.total);
    assert.deepEqual(app.providers.unscripted, []);
  } finally { await app.stop(); }
});
