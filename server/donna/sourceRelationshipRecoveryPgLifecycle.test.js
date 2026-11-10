import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb } from './firmDb.js';
import { currentCodingEvidence, codingEvidenceDigest, recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { CANDIDATE_TX_STATUS_SQL } from './reconciliationLlmCore.js';
import { readJevCase, matchedAllocationHandles } from './jevPreview.js';
import { jevDispositionPlans } from './jevDisposition.js';
import { runJevReconciliationForDocument } from './jevReconciliation.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL, RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES } from './reconciliationProviderFailure.js';

// Frozen shape of the 2026-09-22 FI hosted replay (Kampaamo): receipts held
// but never linked, recovery hiding their bank lines, and a loan notice with
// only a due date whose principal was posted as interest.
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: one persisted source relationship governs matching, coding, posting and recovery', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_source_relationship_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const savedFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = savedFetch; __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  globalThis.fetch = async () => { throw new Error('No provider call is expected in this proof'); };
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const firmId = 'rel-firm', clientId = 'rel-client';
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic relationship proof',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic salon','fi',$3)", [clientId, firmId, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'cash', alv_registration: { status: 'registered', registered_from: '2020-01-01' } }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$1,'auto','manual')", [flag, firmId, clientId]);
  const tx = (id, date, out, payload = {}, extra = {}) => pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,reconciliation_status,payload)
    values($1,$2,$3,$4,$1,0,$5,'EUR',$6,$7,$8,$9)`, [id, firmId, clientId, date, out, extra.status || 'ready', extra.coding_state ?? 'applied', extra.reconciliation_status || 'explained', payload]);
  const doc = async (id, type, total, tax, date, lines, extra = {}) => {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,due_date,parse_summary,payload)
      values($1,$2,$3,$1,$4,'completed',$5,$6,'EUR',$7,$8,$9,'{}')`, [id, firmId, clientId, type, total, tax, date, extra.due_date || null, { line_amounts_include_tax: true, totals_validation: { matches: true } }]);
    for (const [i, line] of lines.entries()) await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [`${id}-line-${i + 1}`, firmId, clientId, id, i + 1, line.description || 'Synthetic component', line.amount, { raw_extraction: { amount: line.amount, tax_rate: line.rate } }]);
  };
  const eligible = async id => (await pool.query(`select coalesce(${CANDIDATE_TX_STATUS_SQL}, false) as ok from transactions where id=$1`, [id])).rows[0].ok;
  const journals = async id => (await pool.query('select count(*)::int n from ledger_journals where source_id=$1 and firm_id=$2', [id, firmId])).rows[0].n;
  const match = (id, txId, type, docId, amount) => pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload)
    values($1,$2,$3,$4,$5,$6,$7,.9,'auto_matched','fixture','{}')`, [id, firmId, clientId, txId, type, docId, amount]);

  // A mixed-VAT receipt (Prisma) and a single-line parking receipt, both coded
  // before any relationship existed: evidence_digest is the digest of nothing.
  const mixed = [2.49, 4.99, 3.79, 2.95, 7.99, 8.95, 1.99], rates = [.255, .255, .255, .255, .255, .14, .14];
  await doc('doc-prisma', 'receipt', 33.15, 5.85, '2025-02-21', mixed.map((amount, i) => ({ amount, rate: rates[i] })));
  await doc('doc-parking', 'receipt', 4.20, 0.85, '2025-02-19', [{ amount: 4.20, rate: .255 }]);
  await doc('doc-unrelated', 'receipt', 33.15, 6.74, '2025-02-20', [{ amount: 33.15, rate: .255 }]);
  const unlinkedCoding = { proposed_account: 'Operating supplies', tax_treatment: 'ALV 25,5 %', posting_requirement: 'document_allocation',
    evidence_digest: codingEvidenceDigest(null), model: 'fixture-provider',
    document_allocations: mixed.map((_, i) => ({ line_handle: `document_1_line_${i + 1}`, account: 'Operating supplies', tax_treatment: rates[i] === .14 ? 'ALV 14 %' : 'ALV 25,5 %' })) };
  await tx('prisma', '2025-02-21', 33.15, { ai_suggestion: unlinkedCoding, ai_suggestion_status: 'auto_applied', proposed_account: 'Operating supplies', tax_treatment: 'ALV 25,5 %' });
  await tx('parking', '2025-02-19', 4.20, { ai_suggestion: { proposed_account: 'Operating supplies', tax_treatment: 'ALV 25,5 %', posting_requirement: 'single_account', evidence_digest: codingEvidenceDigest(null), model: 'fixture-provider' },
    ai_suggestion_status: 'auto_applied', proposed_account: 'Operating supplies', tax_treatment: 'ALV 25,5 %' });

  // (2) A held but unlinked receipt is never a completed source-backed posting.
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'prisma', dryRun: false }), { code: 'TRANSACTION_DOCUMENT_ALLOCATION_INVALID' });
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'parking', dryRun: false }), { code: 'TRANSACTION_ALV_EVIDENCE_REQUIRED' });
  assert.equal(await journals('prisma') + await journals('parking'), 0);

  // (1) Recovery re-opens the refused machine coding; the bank line stays
  // discoverable for its receipt instead of hiding behind 'explained'.
  for (const id of ['prisma', 'parking']) await pool.query("update transactions set payload=payload||jsonb_build_object('ledger_post_refusal',jsonb_build_object('code','TRANSACTION_ALV_EVIDENCE_REQUIRED')) where id=$1", [id]);
  const recovered = await recoverChangedCodingEvidenceInDb({ firmId });
  assert.deepEqual(recovered.map(r => r.transaction_id).sort(), ['parking', 'prisma']);
  for (const id of ['prisma', 'parking']) {
    const row = (await pool.query('select coding_state,reconciliation_status,payload from transactions where id=$1', [id])).rows[0];
    assert.equal(row.coding_state, 'proposed'); assert.equal(row.reconciliation_status, 'explained');
    assert.equal(row.payload.ai_suggestion_status, undefined);
    assert.equal(await eligible(id), true, `${id} must remain a matching candidate after recovery`);
  }
  // (4) Human decisions and settled relationships remain protected.
  await tx('human', '2025-02-10', 12, { reviewed_by: 'fixture-member', support_status: 'explained' }, { coding_state: 'proposed' });
  await tx('settled', '2025-02-11', 13, {}, { coding_state: 'proposed' });
  await doc('doc-settled', 'receipt', 13, 2.64, '2025-02-11', [{ amount: 13, rate: .255 }]);
  await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload)
    values('m-settled',$1,$2,'settled','receipt','doc-settled',13,.9,'confirmed','fixture','{}')`, [firmId, clientId]);
  assert.equal(await eligible('human'), false);
  assert.equal(await eligible('settled'), false);

  // (3) Once the relationship is persisted, both receipts reach the existing
  // writer with no further recoding. The coder's case-evidence handles are
  // bound to the matched source's line handles; another document's are not.
  await match('m-prisma', 'prisma', 'receipt', 'doc-prisma', 33.15);
  await match('m-parking', 'parking', 'receipt', 'doc-parking', 4.20);
  const prismaCase = await readJevCase({ client: pool, firmId, clientId, transactionId: 'prisma', evidenceOnly: true });
  const prismaHandle = prismaCase.caseEvidence.documents.findIndex(d => d.id === 'doc-prisma') + 1;
  const otherHandle = prismaCase.caseEvidence.documents.findIndex(d => d.id === 'doc-unrelated') + 1;
  const bound = matchedAllocationHandles(prismaCase.caseEvidence, prismaCase.matchedDocument,
    unlinkedCoding.document_allocations.map((a, i) => ({ ...a, line_handle: `document_${prismaHandle}_line_${i + 1}` })));
  assert.deepEqual(bound.map(a => a.line_handle), mixed.map((_, i) => `line_${i + 1}`));
  const foreign = matchedAllocationHandles(prismaCase.caseEvidence, prismaCase.matchedDocument, [{ line_handle: `document_${otherHandle}_line_1`, account: 'Operating supplies' }]);
  assert.equal(foreign[0].line_handle, `document_${otherHandle}_line_1`, 'an unrelated receipt never binds to the matched source');
  const settle = async (id, suggestion) => {
    const document = await currentCodingEvidence({ client: pool, firmId, clientId, transactionId: id });
    await pool.query("update transactions set coding_state='applied',payload=payload-'coding_evidence_reconsideration'-'posting_recovery'||$2::jsonb where id=$1",
      [id, { ai_suggestion: { ...suggestion, evidence_digest: codingEvidenceDigest(document) }, ai_suggestion_status: 'auto_applied', proposed_account: suggestion.proposed_account, tax_treatment: suggestion.tax_treatment }]);
  };
  // (4) The unrelated receipt's handle cannot acquire posting authority.
  await settle('prisma', { ...unlinkedCoding, document_allocations: [...bound.slice(0, -1), foreign[0]] });
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'prisma', dryRun: false }), { code: 'TRANSACTION_DOCUMENT_ALLOCATION_INVALID' });
  await settle('prisma', { ...unlinkedCoding, document_allocations: bound });
  await settle('parking', { proposed_account: 'Operating supplies', tax_treatment: 'ALV 25,5 %', posting_requirement: 'single_account', model: 'fixture-provider' });
  for (const id of ['prisma', 'parking']) {
    await postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun: false });
    assert.equal(await journals(id), 1);
  }
  const vat = (await pool.query("select sum(l.debit)::numeric v from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='prisma' and l.account_name ~ 'arvonlisävero'")).rows[0].v;
  assert.equal(Math.round(Number(vat) * 100), 585, 'mixed components keep their exact source VAT');
  assert.deepEqual((await recoverChangedCodingEvidenceInDb({ firmId })).filter(r => ['prisma', 'parking'].includes(r.transaction_id)), [], 'no repeated recoding');

  // (7) A document the retired document-side "immaterial" terminal closed
  // without a relationship re-enters its family matcher once through the
  // existing recovery pool; a fresh family evaluation takes it out again.
  assert.equal(jevDispositionPlans({ kind: 'document', amount: 4.2, materialityCeiling: 500 }).resolve_immaterial, undefined);
  assert.ok(jevDispositionPlans({ kind: 'bank', amount: 4.2, materialityCeiling: 500 }).resolve_immaterial);
  await doc('doc-book', 'receipt', 43.45, 4.00, '2025-02-18', [{ amount: 43.45, rate: .10 }]);
  await pool.query("update documents set payload=jsonb_build_object('no_line_disposition',jsonb_build_object('disposition','auto_explain','decision_engine','jev','settlement_channel','unknown','evaluated_at','2026-09-01T00:00:00Z')) where id='doc-book'");
  const pool0 = async () => (await pool.query(DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL, [firmId, 50, [...RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES]])).rows;
  assert.deepEqual((await pool0()).filter(r => r.document_id === 'doc-book').map(r => r.receipt.code), ['DOCUMENT_DISPOSITION_UNSETTLED']);
  await pool.query(`insert into reconciliation_evaluations(id,firm_id,client_id,target_type,target_id,matcher_family,verdict,payload,evaluated_at)
    values('e-book',$1,$2,'document','doc-book','receipt','no_match',$3,now())`, [firmId, clientId, { decision_engine: 'jev', next_action: null, preparation_contract: 'jev-preparation-v2' }]);
  assert.equal((await pool0()).some(r => r.document_id === 'doc-book'), false);

  // (5) A loan notice printing only its due date is prepared with that date and
  // its stated basis; a source with no date at all is a deterministic
  // incomplete source, not a retried technical failure.
  await doc('doc-loan', 'supplier_bill', 412.35, 0, null, [{ description: 'Korko', amount: 67.98, rate: 0 }, { description: 'Lyhennys', amount: 344.37, rate: 0 }], { due_date: '2025-02-28' });
  const loanCase = await readJevCase({ client: pool, firmId, clientId, documentId: 'doc-loan', asOf: '2026-09-22' });
  assert.equal(loanCase.prepared.state.invoice.date, '2025-02-28');
  assert.equal(loanCase.prepared.state.invoice.date_basis, 'due_date');
  await doc('doc-undated', 'supplier_bill', 99, 0, null, [{ amount: 99, rate: 0 }]);
  const snapshot = await readClientConfigSnapshot(pool, { firmId, clientId, strict: true });
  const undated = await runJevReconciliationForDocument({ client: pool, firmId, clientId, documentId: 'doc-undated', configSnapshot: snapshot });
  assert.equal(undated.jev_reason, 'jev_source_incomplete');
  const undatedEval = (await pool.query("select payload from reconciliation_evaluations where target_id='doc-undated' and payload->>'decision_engine'='jev'")).rows[0].payload;
  assert.equal(undatedEval.next_action, null); assert.equal(undatedEval.failure_class, 'source_incomplete');
  // An evaluation exhausted under the earlier preparation re-enters once.
  await pool.query(`insert into reconciliation_evaluations(id,firm_id,client_id,target_type,target_id,matcher_family,verdict,unmatchable_reason,payload,evaluated_at)
    values('e-loan',$1,$2,'document','doc-loan','supplier_bill','no_match','jev_runtime_failed',$3,now()-interval '1 hour')`,
  [firmId, clientId, { decision_engine: 'jev', next_action: 'retry_writer', failure_class: 'technical_failure', attempt_count: 3, runtime_error: 'incomplete_document' }]);
  assert.ok((await pool0()).some(r => r.document_id === 'doc-loan'));

  // (6) While the loan notice's matching is unfinished, a description-only
  // interest coding of the whole payment waits instead of posting.
  const interestOnly = { proposed_account: 'Interest expense', tax_treatment: 'Ei ALV-käsittelyä', posting_requirement: 'single_account', evidence_digest: codingEvidenceDigest(null), model: 'fixture-provider' };
  await tx('loan', '2025-02-28', 412.35, { ai_suggestion: interestOnly, ai_suggestion_status: 'auto_applied', proposed_account: 'Interest expense', tax_treatment: 'Ei ALV-käsittelyä' });
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'loan', dryRun: false }),
    e => e.code === 'TRANSACTION_CODING_EVIDENCE_PENDING' && e.details?.document_ids?.includes('doc-loan'));
  assert.equal(await journals('loan'), 0);
  // The already-posted production shape: the interest-only journal exists.
  // Once the relationship is persisted, recovery raises the established
  // correction requirement; the original journal stays and nothing reposts.
  await pool.query("update reconciliation_evaluations set verdict='superseded' where id='e-loan'");
  await postLedgerTransactionInDb({ firmId, clientId, transactionId: 'loan', dryRun: false });
  assert.equal(await journals('loan'), 1);
  assert.equal(await eligible('loan'), true, 'a Donna-posted, unmatched line can still receive its source');
  await match('m-loan', 'loan', 'supplier_bill', 'doc-loan', 412.35);
  await recoverChangedCodingEvidenceInDb({ firmId });
  const loan = (await pool.query("select payload from transactions where id='loan'")).rows[0].payload;
  assert.equal(loan.coding_correction_required.status, 'pending');
  assert.equal(loan.coding_correction_required.document_id, 'doc-loan');
  assert.equal(loan.coding_correction_required.next_action, 'recode_decided');
  assert.equal(await journals('loan'), 1, 'no silent replacement or duplicate recognition');
  assert.equal((await pool.query("select count(*)::int n from audit_events where action='coding.posted_evidence_reconsideration' and resource_id='loan'")).rows[0].n, 1);
  await recoverChangedCodingEvidenceInDb({ firmId });
  assert.equal((await pool.query("select count(*)::int n from audit_events where action='coding.posted_evidence_reconsideration' and resource_id='loan'")).rows[0].n, 1, 'one correction requirement per changed source');
});
