// Kultalanka February 2025: the automated evaluation (plan §8.7). Pure tests
// pin the labels (verbatim originals, Ilkka's adjudications, disputes, the
// crosswalk, balance and section-C arithmetic) and the scorer on synthetic
// book snapshots; real-PostgreSQL tests pin the read-only book reader, and the
// whole month on the appliance path under a FIXTURE provider, recorded and
// replayed with no network. Fixture answers verify mechanics only; they are
// never capability observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { hash } from '../server/donna/jevEvidenceContract.js';
import { classifyProviderRequest, loadRecording } from '../server/donna/testSupport/recordedProviders.js';
import { OPERATOR_REVIEWER, KULTALANKA_DIR, loadKultalankaLabels, validateLabels, computeSectionC, goldOfLine, goldRole, scoreMonth, mapToKeySpace, netLines, identify } from './fi_kultalanka_eval.js';
import { decisionOf, readMonthSnapshot, scoreBookReadOnly, buildMonthPlan, makeMonthLane, mainScore, sourceFiles } from './fi_kultalanka_eval_run.js';
import { createTemplate } from './jev_decision_plane_fi_run.js';
import { runDecisionPlane, publicSummary } from './jev_decision_plane.js';
import { verifyBudget } from './jev_decision_plane_protocol.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const PG = { skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — the Kultalanka book reader and month are not exercised on real PG' };
const labels = loadKultalankaLabels();
const line = id => labels.lines.find(l => l.id === id);
const clone = x => structuredClone(x);

// ── Labels ──────────────────────────────────────────────────────────────────
test('labels: 36 bank lines plus the cash purchase, verbatim originals, every journal balanced, sources pinned by digest', () => {
  const v = validateLabels(labels, { sourceDir: join(KULTALANKA_DIR, 'sources') });
  assert.equal(v.lines, 37); assert.equal(v.bank_lines, 36);
  assert.deepEqual(v.by_status.adjudicated, ['B01', 'B04', 'B08', 'B17', 'B21', 'B22', 'B25', 'B27', 'B28', 'B31']);
  assert.deepEqual(v.by_status.disputed, ['B02', 'B10', 'B11', 'B12', 'B29', 'B34', 'K01']);
  assert.equal(v.by_status.agreed.length, 20);
  assert.equal(sourceFiles(labels).length, 27);
  // The original is the key verbatim, including where the key is wrong.
  assert.equal(line('B17').verbatim.debit, '7090 Yksityisotot 52,10');
  assert.equal(line('B25').original.journal.find(l => l.account === '1760').amount, 2.60);
  assert.equal(line('B28').original.journal.find(l => l.account === '3580').amount, 20);
  assert.equal(line('B08').verbatim.debit, '1910 Pankki 2 625,72... ks. kaava');
  assert.equal(line('B08').original.journal, null);
});

test("labels: Ilkka's adjudications and disputes carry their receipts; new disputes cite the tree", () => {
  for (const id of ['B01', 'B04', 'B08', 'B17', 'B21', 'B22', 'B25', 'B27', 'B28', 'B31']) {
    const l = line(id);
    assert.equal(l.adjudication.reviewer, OPERATOR_REVIEWER); assert.equal(l.adjudication.date, '2026-09-24'); assert.ok(l.adjudication.reason);
    assert.ok(l.original.terminal === 'posted');
    assert.equal(l.adjudicated.terminal, ['B01', 'B04', 'B08', 'B21', 'B27'].includes(id) ? 'posted' : 'ask_owner');
  }
  for (const id of ['B22', 'B25', 'B31']) {
    assert.equal(line(id).adjudicated.ask.evidence_type, 'document_discrepancy');
    assert.match(line(id).adjudication.source_url, /^https:\/\/www\.vero\.fi\//); assert.match(line(id).adjudication.source_snapshot, /owed/);
  }
  assert.deepEqual(line('B28').adjudicated.ask, { evidence_type: 'document_discrepancy', kinds: ['ask_component_split'] });
  assert.equal(line('B17').adjudicated.ask.evidence_type, 'business_purpose');
  for (const id of ['B34', 'K01']) { assert.equal(line(id).adjudication.raised_by, 'ilkka'); assert.equal(line(id).adjudication.reviewer, OPERATOR_REVIEWER); }
  for (const id of ['B02', 'B10', 'B11', 'B12', 'B29']) {
    assert.equal(line(id).adjudication.raised_by, 'claude_for_ilkka');
    assert.ok(line(id).adjudication.tree_position.citations.length > 0);
    assert.equal(goldOfLine(labels, line(id)), null, `${id} has no gold`);
  }
  // Ilkka adopted the Nets gross-up (the tree's own, settlementRowSplitPgLifecycle.test.js)
  // and the receipt's K-Supermarket split; the key's printed rows stay as originals.
  assert.deepEqual(line('B01').adjudicated.journal.map(l => [l.account, l.direction, l.amount]), [['1910', 'debit', 2452.72], ['NETS-PALKKIO', 'debit', 27.28], ['3000', 'credit', 1976.10], ['2939', 'credit', 503.90]]);
  assert.equal(line('B01').original.journal.find(l => l.account === '2939').amount, 503.54);
  assert.equal(line('B08').adjudicated.journal.find(l => l.account === '1910').amount, 2625.79);
  assert.deepEqual(line('B04').adjudicated.journal.filter(l => l.direction === 'debit').map(l => l.amount), [15.89, 2.23, 0.62]);
  assert.equal(line('B04').original.journal[0].amount, 15.90);
  for (const id of ['B01', 'B04', 'B08', 'B21', 'B27']) assert.equal(line(id).proposed_gold, undefined);
});

test('labels: validation refuses an unbalanced journal, an unmapped account, a receipt-less adjudication and drifted section-C arithmetic', () => {
  const tamper = fn => { const x = clone(labels); fn(x); return () => validateLabels(x); };
  assert.throws(tamper(x => { x.lines.find(l => l.id === 'B05').original.journal[0].amount = 286.40; }), /journal_does_not_balance|original:B05/);
  assert.throws(tamper(x => { x.lines.find(l => l.id === 'B03').original.journal[0].account = '4011'; }), /crosswalk_coverage/);
  assert.throws(tamper(x => { delete x.lines.find(l => l.id === 'B25').adjudication.reviewer; }), /adjudicated:B25/);
  assert.throws(tamper(x => { x.lines.find(l => l.id === 'B02').adjudication.tree_position = {}; }), /dispute_without_tree_citation:B02/);
  assert.throws(tamper(x => { x.section_c.adjudicated.vat_due.at_rest = 2595.08; }), /section_c_arithmetic/);
  assert.throws(tamper(x => { x.section_c.contributions.find(c => c.lines[0] === 'B24').amount = 124; }), /section_c_contributions|section_c_line_amount/);
  assert.throws(tamper(x => { x.section_c.capability_gaps[0].amount_output_vat = 183.5; }), /capability_gap_amount:CG-1:output_vat/);
  assert.throws(tamper(x => { x.section_c.contributions.find(c => c.capability_gap).c_dispute = 'DC-1'; }), /capability_gap:CG-1/);
  assert.throws(tamper(x => { x.lines.find(l => l.id === 'B36').bank.amount = 6.01; }), /bank_rows_do_not_reach_closing_balance|original:B36/);
});

test('section C: the adjudicated expectations follow from the adjudicated labels, with the arithmetic shown', () => {
  const c = computeSectionC(labels);
  assert.deepEqual(c, labels.section_c.adjudicated);
  assert.equal(c.input_vat_deductible.original, 239.40);
  assert.equal(c.input_vat_deductible.pending_owner, 11.33); // B22 7,14 + B25 2,60 + B31 1,59
  assert.equal(c.input_vat_deductible.at_rest, 223.61); // + the adopted 2,23 on B04
  assert.equal(c.input_vat_deductible.with_key_disputes, 228.08);
  assert.equal(c.reverse_charge_vat.at_rest, 123.32);
  assert.equal(c.vat_due.original, 2595.08);
  // Lumikki invoice 1002 is decided gold under accrual (Ilkka, 2026-09-24): no
  // longer a dispute, but CG-1, a capability gap the tree cannot yet produce.
  assert.equal(c.sales_net.at_rest, 10243.11); // Aroma 1 300,00 + Lumikki 720,00 + the adopted Nets 8 223,11
  assert.equal(c.output_vat.at_rest, 2611.99); // 2 428,39 + 183,60
  assert.deepEqual(c.sales_net.capability_gap_items, [{ id: 'CG-1', kind: 'uploaded_sales_invoice_recognition', amount: 720 }]);
  assert.deepEqual(c.output_vat.capability_gap_items, [{ id: 'CG-1', kind: 'uploaded_sales_invoice_recognition', amount: 183.6 }]);
  assert.deepEqual(c.sales_net.undecided_items.map(i => i.id), ['B02', 'B29']);
  assert.deepEqual(labels.section_c.c_disputes.map(d => d.id), ['DC-2']);
  assert.match(c.sales_net.arithmetic, /11115,62 − 0,00 pending owner \(—\) − 872,51 undecided \(B02, B29\) = 10243,11 at rest, of which 720,00 is CG-1/);
  assert.equal(c.nets_fees.at_rest, 113.52);
  assert.equal(c.vat_due.at_rest, 2388.38); // 2 611,99 − 223,61
  assert.equal(c.vat_due.with_key_disputes, 2606.40);
  assert.equal(c.sales_net.with_key_disputes, 11115.62);
  assert.match(c.input_vat_deductible.arithmetic, /239,40 − 11,33 pending owner \(B22, B25, B31\) − 4,47 undecided \(K01\) \+ 0,01 adjudicated \(B04\) = 223,61 at rest/);
});

// ── A synthetic book: every decided gold as the tree posts it ───────────────
// The disputed lines take the tree's position (Nets grossed up, the rest on
// the owner). Amounts come from the labels; mutations make specific errors.
const cross = new Map(labels.crosswalk.map(x => [x.key_account, x]));
const donnaLine = (l, tax) => {
  const x = cross.get(l.account);
  return { account_code: x.accept.account_codes?.[0] ?? (l.account === '1910' ? null : null), account_name: l.account === '1910' ? 'Business Checking · EUR' : (x.accept.roles?.[0] ?? x.accept.account_codes[0]),
    canonical_role: x.accept.roles?.[0] ?? null, role: goldRole(l) === 'counterparty' ? 'counterparty' : goldRole(l), direction: l.direction, amount: l.amount, tax_type: tax ?? labels.alv_classes[l.alv][0], account_type: /^3/.test(l.account) ? 'revenue' : /^[4-8]|NETS|KULU/.test(l.account) ? 'expense' : 'asset' };
};
const toDonna = journal => journal.filter(l => !cross.get(l.account).accept.represented_by_alv_code).map(l => donnaLine(l));
function treeBook() {
  const transactions = [], journals = [], asks = [], matches = [];
  const documents = labels.sources.map((s, i) => ({ id: `doc-${i + 1}`, filename: s.file, checksum_sha256: s.sha256, document_type: 'receipt', convergence_state: 'auto_reconciled' }));
  const docOf = f => documents.find(d => d.filename === f);
  const ask = (id, txId, evidence_type, extra = {}) => asks.push({ id: `ask-${id}`, transaction_id: txId, document_id: null, evidence_type, status: 'open', question: 'Fixture question', ...extra });
  for (const l of labels.lines.filter(x => x.bank)) {
    const id = `tx-${String(l.bank.statement_row).padStart(2, '0')}`;
    const gold = goldOfLine(labels, l);
    const tx = { id, date: l.bank.date, money_in: l.bank.direction === 'in' ? l.bank.amount : 0, money_out: l.bank.direction === 'out' ? l.bank.amount : 0, description: l.bank.counterparty, coding_state: 'posted', convergence_state: 'auto_reconciled', convergence_reason: null, payload: { ai_suggestion: { decision_engine: 'jev', jev_decision: { selected: 'post_journal' } } } };
    transactions.push(tx);
    for (const f of l.source_files) matches.push({ bank_transaction_id: id, matched_object_id: docOf(f).id, matched_object_type: 'document', status: 'auto_matched' });
    const post = journal => journals.push({ id: `j-${id}`, source_type: 'transaction', source_id: id, status: 'posted', reversed_at: null, journal_date: l.bank.date, lines: toDonna(journal) });
    const owner = (type, kind) => { tx.coding_state = 'asked'; tx.convergence_state = 'on_owner'; tx.payload.ai_suggestion.jev_decision.selected = kind; ask(l.id, id, type); };
    if (gold?.group) { if (l.id === labels.groups[0].members[0]) post(gold.journal); continue; }
    if (gold?.terminal === 'posted') post(gold.alternatives[0] ?? gold.journal);
    else if (gold?.terminal === 'ask_owner') owner(gold.ask.evidence_type, gold.ask.kinds?.[0] ?? 'ask_source_document');
    else if (l.decision_class === 'processor_settlement' || l.id === 'B04') post(l.proposed_gold);
    else if (l.id === 'B34') owner('payroll_package', 'ask_payroll_package');
    else owner('supporting_document', l.decision_class === 'cash_sales_deposit' ? 'ask_sales_source' : 'ask_statutory_source');
  }
  const k01 = docOf(line('K01').cash_document.file);
  k01.convergence_state = 'on_owner';
  ask('K01', null, 'payment_method', { document_id: k01.id });
  return { transactions, documents, matches, journals, asks, models: { coding_payload: ['fixture-model'] } };
}
const score = book => scoreMonth(labels, book, { decisionOf, source: 'fixture' });
const lineOf = (report, id) => report.lines.find(l => l.id === id);

// The same book with the accrual recognition the tree cannot yet produce:
// the sales invoices and the credit note journaled when issued, so Aroma's
// payment clears the receivable (its bank-line representation then no longer
// applies) and Lumikki's 720,00 + 183,60 is February revenue (CG-1 closed).
function accrualBook() {
  const book = treeBook();
  const doc = (id, type, date, journal) => book.journals.push({ id, source_type: type, source_id: id, status: 'posted', reversed_at: null, journal_date: date, lines: toDonna(journal) });
  doc('inv-1001', 'sales_invoice', '2025-02-03', [{ account: '1700', direction: 'debit', amount: 2008, alv: 'none' }, { account: '3000', direction: 'credit', amount: 1600, alv: 'out_25_5' }, { account: '2939', direction: 'credit', amount: 408, alv: 'none' }]);
  doc('inv-1002', 'sales_invoice', '2025-02-12', [{ account: '1700', direction: 'debit', amount: 903.6, alv: 'none' }, { account: '3000', direction: 'credit', amount: 720, alv: 'out_25_5' }, { account: '2939', direction: 'credit', amount: 183.6, alv: 'none' }]);
  doc('cn-1003', 'credit_note', '2025-02-14', [{ account: '3000', direction: 'debit', amount: 300, alv: 'out_25_5' }, { account: '2939', direction: 'debit', amount: 76.5, alv: 'none' }, { account: '1700', direction: 'credit', amount: 376.5, alv: 'none' }]);
  book.journals.find(j => j.source_id === 'tx-20').lines = toDonna(line('B20').original.journal);
  return book;
}

test('scorer: a book taking the tree position on every line scores every decided line correct and no material error; its economics fail on CG-1 alone', () => {
  const report = score(treeBook());
  assert.deepEqual(report.identification.missing_bank_rows, []);
  assert.equal(report.summary.cases, 37);
  assert.equal(report.summary.correct_complete, 30, JSON.stringify(report.lines.filter(l => !l.correct_complete && l.status !== 'disputed').map(l => [l.id, l.material, l.journal_differences, l.mapped, l.gold])));
  assert.equal(report.summary.material_wrong_autonomous_actions, 0);
  // Disputed lines stay in the operational denominator as incomplete work.
  assert.equal(report.summary.excluded_from_gold.disputed_label, 7);
  assert.equal(report.summary.incomplete_work, 7);
  assert.equal(report.summary.terminal_coverage.terminal, 37);
  // The tree never journals the uploaded Lumikki invoice and B28 rests on the
  // owner, so its sales and output ALV are short by exactly CG-1: the figures
  // FAIL (an omission is never a passing alternative) and the gap is named.
  const check = n => report.economics.checks.find(c => c.name === n);
  assert.equal(report.economics.status, 'INCOMPLETE');
  for (const [n, shortfall] of [['sales_net', 720], ['output_vat', 183.6], ['vat_due', 183.6]]) {
    assert.equal(check(n).pass, false, n); assert.deepEqual(check(n).capability_gaps, ['CG-1'], n); assert.equal(check(n).shortfall, shortfall, n);
  }
  assert.equal(check('sales_net').actual, 9523.12); assert.equal(check('sales_net').expected_with_gap_closed, 10243.11);
  assert.equal(check('vat_due').expected_with_gap_closed, 2388.38);
  for (const n of ['input_vat_deductible', 'reverse_charge_vat', 'nets_fees']) { assert.equal(check(n).pass, true, n); assert.deepEqual(check(n).capability_gaps, [], n); }
  const [cg1] = report.economics.capability_gaps;
  assert.equal(report.economics.capability_gaps.length, 1);
  assert.deepEqual([cg1.id, cg1.kind, cg1.amount_sales, cg1.amount_output_vat, cg1.tree, cg1.observed, cg1.failing_checks],
    ['CG-1', 'uploaded_sales_invoice_recognition', 720, 183.6, 'server/donna/creditNoteApplications.js', true, ['sales_net', 'output_vat', 'vat_due']]);
  // B28's own adjudication is unchanged: the owner is asked for the 20,00 split.
  assert.equal(lineOf(report, 'B28').correct_complete, true); assert.equal(lineOf(report, 'B28').gold_terminal, 'ask_owner');
  assert.equal(check('input_vat_deductible').actual, 223.61); assert.deepEqual(check('input_vat_deductible').proposals_taken, []);
  assert.equal(check('reverse_charge_vat').actual, 123.32);
  assert.deepEqual(report.models, { coding_payload: ['fixture-model'] });
});

test('scorer: a book recognising the invoices when issued passes the economics with CG-1 closed, and Aroma clears its receivable', () => {
  const report = score(accrualBook());
  assert.equal(report.economics.status, 'PASS', JSON.stringify(report.economics.checks));
  const check = n => report.economics.checks.find(c => c.name === n);
  assert.equal(check('sales_net').actual, 10243.12); assert.deepEqual(check('sales_net').key_positions_taken, []); // the cash deposits stay on the owner
  assert.equal(check('output_vat').actual, 2612);
  assert.ok(report.economics.checks.every(c => c.capability_gaps.length === 0));
  assert.equal(report.economics.capability_gaps[0].observed, false);
  for (const id of ['B20', 'B28']) assert.equal(lineOf(report, id).correct_complete, true, id);
  assert.equal(report.summary.correct_complete, 30);
  assert.equal(report.summary.material_wrong_autonomous_actions, 0);
  // Aroma's bank-line representation is refused once invoices are journaled:
  // revenue would count twice.
  const twice = accrualBook();
  twice.journals.find(j => j.source_id === 'tx-20').lines = toDonna(line('B20').representation_alternatives[0].journal);
  const r = score(twice);
  assert.equal(lineOf(r, 'B20').correct_complete, false);
  assert.equal(r.economics.status, 'INCOMPLETE');
  assert.deepEqual(r.economics.checks.find(c => c.name === 'sales_net').capability_gaps, []);
});

test('scorer: the key\'s own wrong answers and ordinary coding errors are material; asks are checked by type and kind', () => {
  const book = treeBook();
  const tx = n => book.transactions.find(t => t.id === `tx-${n}`);
  const journal = n => book.journals.find(j => j.source_id === `tx-${n}`);
  // B25 VR: the key's 10 % deduction posted where Ilkka adjudicated a question.
  book.asks = book.asks.filter(a => a.transaction_id !== 'tx-25');
  book.journals.push({ id: 'j-tx-25', source_type: 'transaction', source_id: 'tx-25', status: 'posted', reversed_at: null, journal_date: '2025-02-21', lines: toDonna(line('B25').original.journal) });
  // B24 Hius-Tukku: right total, wrong rate.
  journal(24).lines = journal(24).lines.map(l => l.canonical_role ? { ...l, tax_type: 'ALV_14_INPUT' } : l);
  // B05 Energia: the bill journaled twice against the bank.
  book.journals.push({ ...clone(journal('05')), id: 'j-dup-05', source_type: 'supplier_bill', source_id: 'doc-dup' });
  book.matches.push({ bank_transaction_id: 'tx-05', matched_object_id: 'doc-dup', matched_object_type: 'document', status: 'auto_matched' });
  // B03 rent matched to the insurance bill as well.
  book.matches.push({ bank_transaction_id: 'tx-03', matched_object_id: book.documents.find(d => d.filename.startsWith('24 ')).id, matched_object_type: 'document', status: 'auto_matched' });
  // B28 Lumikki: a generic purpose question instead of the component split.
  const lumikki = book.asks.find(a => a.transaction_id === 'tx-28'); lumikki.evidence_type = 'business_purpose'; tx(28).payload.ai_suggestion.jev_decision.selected = 'ask_business_purpose';
  // B30 Shell: no question at all.
  book.asks = book.asks.filter(a => a.transaction_id !== 'tx-30');
  const report = score(book);
  assert.deepEqual(lineOf(report, 'B25').material, ['posted_where_label_asks']);
  assert.deepEqual(lineOf(report, 'B24').material, ['tax']);
  assert.ok(lineOf(report, 'B24').journal_differences.includes('alv_code'));
  assert.ok(lineOf(report, 'B05').material.includes('duplicate_journal'), JSON.stringify(lineOf(report, 'B05')));
  assert.ok(lineOf(report, 'B03').material.includes('false_reconciliation'));
  assert.equal(lineOf(report, 'B28').wrong_owner_ask, true);
  assert.equal(lineOf(report, 'B30').missing_owner_ask, true);
  assert.equal(report.summary.material_wrong_autonomous_actions, 4);
  assert.equal(report.summary.wrong_vat_journals, 2); // B24, and B05's doubled ALV leg
  assert.equal(report.economics.status, 'INCOMPLETE');
});

test('scorer: refund groups, interim receipt postings, reverse-charge legs and an accepted representation', () => {
  // Tokmanni booked as two purchases and a reversing refund nets to the gold.
  const book = treeBook();
  const tok = line('B15').original.journal;
  book.journals = book.journals.filter(j => j.source_id !== 'tx-15');
  book.journals.push({ id: 'j-15', source_type: 'transaction', source_id: 'tx-15', status: 'posted', journal_date: '2025-02-14', lines: toDonna(tok) },
    { id: 'j-16', source_type: 'transaction', source_id: 'tx-16', status: 'posted', journal_date: '2025-02-14', lines: toDonna(tok) },
    { id: 'j-19', source_type: 'transaction', source_id: 'tx-19', status: 'posted', journal_date: '2025-02-17', lines: toDonna(line('B19').original.journal) });
  // Shell: an A.3 temporary VAT-free posting beside the receipt question.
  book.journals.push({ id: 'j-30', source_type: 'transaction', source_id: 'tx-30', status: 'posted', journal_date: '2025-02-26', lines: [donnaLine({ account: '4080', direction: 'debit', amount: 40, alv: 'exempt' }, 'NONE'), donnaLine({ account: '1910', direction: 'credit', amount: 40, alv: 'none' })] });
  let report = score(book);
  for (const id of ['B15', 'B16', 'B19', 'B30', 'B06', 'B20']) assert.equal(lineOf(report, id).correct_complete, true, `${id}: ${JSON.stringify(lineOf(report, id))}`);
  assert.equal(lineOf(report, 'B30').interim_posting, true);
  // …but a temporary posting that deducts input VAT is not an interim posting.
  book.journals.find(j => j.id === 'j-30').lines = toDonna([{ account: '4080', direction: 'debit', amount: 31.87, alv: 'in_25_5' }, { account: '1760', direction: 'debit', amount: 8.13, alv: 'none' }, { account: '1910', direction: 'credit', amount: 40, alv: 'none' }]);
  report = score(book);
  assert.deepEqual(lineOf(report, 'B30').material, ['posted_where_label_asks']);
  // Reverse charge has one representation: posted self-assessed legs would
  // count twice in the return, so they are a tax error, and economics fail.
  const rc = treeBook();
  for (const [n, amount] of [['06', 3.47], ['07', 81.60], ['14', 38.25]]) rc.journals.find(j => j.source_id === `tx-${n}`).lines.push(
    { account_code: '2940', account_name: 'Vähennettävä arvonlisävero', canonical_role: null, role: 'alv_input_deductible', direction: 'debit', amount, tax_type: 'NONE', account_type: 'liability' },
    { account_code: '2939', account_name: 'Suoritettava arvonlisävero', canonical_role: null, role: 'alv_output', direction: 'credit', amount, tax_type: 'NONE', account_type: 'liability' });
  report = score(rc);
  for (const id of ['B06', 'B07', 'B14']) assert.deepEqual(lineOf(report, id).material, ['tax'], id);
  assert.equal(report.economics.status, 'INCOMPLETE');
  // The Aroma alternative holds only while no sales-invoice journal exists.
  const ar = treeBook();
  ar.journals.push({ id: 'j-inv-1001', source_type: 'sales_invoice', source_id: '1001', status: 'posted', journal_date: '2025-02-03', lines: toDonna([{ account: '1700', direction: 'debit', amount: 2008, alv: 'none' }, { account: '3000', direction: 'credit', amount: 1600, alv: 'out_25_5' }, { account: '2939', direction: 'credit', amount: 408, alv: 'none' }]) });
  assert.equal(lineOf(score(ar), 'B20').correct_complete, false);
  // A missing bank row stays in the denominator as incomplete work.
  const gone = treeBook(); gone.transactions = gone.transactions.filter(t => t.id !== 'tx-33');
  report = score(gone);
  assert.deepEqual(report.identification.missing_bank_rows, ['B33']);
  assert.equal(lineOf(report, 'B33').missing, 'bank_row_not_in_book');
  assert.equal(report.summary.correct_complete, 29);
  assert.equal(report.summary.incomplete_work, 8);
});

test('scorer: objective safety still runs on disputed lines, and an open question beside a correct posting is an interruption', () => {
  // A disputed cash deposit posted as sales twice over: no accuracy grade, but material.
  const book = treeBook();
  book.journals.push({ id: 'j-tx-02', source_type: 'transaction', source_id: 'tx-02', status: 'posted', reversed_at: null, journal_date: '2025-02-03',
    lines: toDonna([{ account: '1910', direction: 'debit', amount: 1280, alv: 'none' }, { account: '3010', direction: 'credit', amount: 1019.92, alv: 'out_25_5' }, { account: '2939', direction: 'credit', amount: 260.08, alv: 'none' }]) });
  let report = score(book);
  assert.deepEqual(lineOf(report, 'B02').material, ['duplicate_journal']);
  assert.equal(lineOf(report, 'B02').status, 'disputed');
  assert.equal(report.summary.material_wrong_autonomous_actions, 1);
  // A disputed cash deposit reconciled to an unrelated bill.
  const recon = treeBook();
  recon.matches.push({ bank_transaction_id: 'tx-02', matched_object_id: recon.documents.find(d => d.filename.startsWith('23 ')).id, matched_object_type: 'document', status: 'auto_matched' });
  report = score(recon);
  assert.deepEqual(lineOf(report, 'B02').material, ['false_reconciliation']);
  // The rent posted correctly, with a stale open request for the invoice it already holds.
  const stale = treeBook();
  stale.asks.push({ id: 'ask-stale-03', transaction_id: 'tx-03', document_id: null, evidence_type: 'supporting_document', status: 'open', question: 'Please send the rent invoice.' });
  report = score(stale);
  assert.equal(lineOf(report, 'B03').correct_complete, false);
  assert.equal(lineOf(report, 'B03').redundant_open_asks, 1);
  assert.equal(lineOf(report, 'B03').avoidable_interruption, 'missing_fact');
  assert.equal(report.summary.avoidable_interruptions.total, 1);
  assert.equal(report.summary.correct_complete, 29);
});

test('scorer helpers: netting clears a paid bill\'s payable; mapping keeps unmatched lines visible', () => {
  const lines = netLines([{ account_code: null, account_name: 'Rent', canonical_role: 'expense.rent', direction: 'debit', amount: 1450, tax_type: 'ALV_EXEMPT' },
    { account_code: '2870', account_name: 'Ostovelat', canonical_role: 'liability.accounts_payable', direction: 'credit', amount: 1450, tax_type: 'NONE' },
    { account_code: '2870', account_name: 'Ostovelat', canonical_role: 'liability.accounts_payable', direction: 'debit', amount: 1450, tax_type: 'NONE' },
    { account_code: null, account_name: 'Business Checking · EUR', canonical_role: 'asset.cash', role: 'bank', direction: 'credit', amount: 1450, tax_type: 'NONE' }]);
  assert.equal(lines.length, 2);
  const { mapped, gold } = mapToKeySpace(labels, [...lines, { account_name: 'Suspense', canonical_role: 'control.suspense', direction: 'debit', amount: 5, tax_type: 'NONE' }], line('B03').original.journal);
  assert.deepEqual(gold.map(l => l.account), ['4010', '1910']);
  assert.ok(mapped.some(l => l.account === 'donna:control.suspense'));
  assert.equal(identify(labels, { transactions: [], documents: [], matches: [], journals: [], asks: [] }).missing_bank_rows.length, 36);
});

// ── Real PG: the read-only book reader ──────────────────────────────────────
async function seedBook(pool, book) {
  const q = (t, p) => pool.query(t, p);
  await q("insert into firms (id, name, slug) values ('firm-k', 'Fixture firm', 'fixture-k')");
  await q("insert into clients (id, firm_id, company_name, jurisdiction, entity_type, profile) values ('client-k', 'firm-k', 'Kampaamo Kultalanka Oy', 'fi', 'fi-oy', '{}'::jsonb)");
  for (const d of book.documents) await q(`insert into documents (id, firm_id, client_id, filename, document_type, parse_status, checksum_sha256, parse_summary) values ($1, 'firm-k', 'client-k', $2, $3, 'completed', $4, $5::jsonb)`,
    [d.id, d.filename, d.document_type, d.checksum_sha256, JSON.stringify({ extraction: { model: 'fixture-extractor' } })]);
  for (const t of book.transactions) await q(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status, payload) values ($1, 'firm-k', 'client-k', $2, $3, $4, $5, 'EUR', 'needs_review', $6::jsonb)`,
    [t.id, t.date, t.description, t.money_in, t.money_out, JSON.stringify({ ...t.payload, ai_suggestion: { ...t.payload.ai_suggestion, model: 'fixture-coder' } })]);
  for (const [i, m] of book.matches.entries()) await q(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, match_confidence, payload) values ($1, 'firm-k', 'client-k', $2, 'document', $3, $4, 1, 0.99, '{}'::jsonb)`, [`m-${i}`, m.bank_transaction_id, m.matched_object_id, m.status]);
  const accounts = new Map();
  for (const j of book.journals) {
    await q(`insert into ledger_journals (id, firm_id, client_id, source_type, source_id, journal_date, currency, status) values ($1, 'firm-k', 'client-k', $2, $3, $4, 'EUR', 'posted')`, [j.id, j.source_type, j.source_id, j.journal_date]);
    for (const [n, l] of j.lines.entries()) {
      const key = `${l.account_code}|${l.account_name}`;
      if (!accounts.has(key)) { accounts.set(key, `acct-${accounts.size + 1}`); await q(`insert into ledger_accounts (id, firm_id, client_id, code, name, account_type, normal_balance, canonical_role) values ($1, 'firm-k', 'client-k', $2, $3, $4, 'debit', $5)`, [accounts.get(key), l.account_code, l.account_name, l.account_type, l.canonical_role]); }
      await q(`insert into ledger_lines (id, journal_id, firm_id, client_id, account_id, account_code, account_name, line_no, direction, debit, credit, amount, currency, tax_type, payload) values ($1, $2, 'firm-k', 'client-k', $3, $4, $5, $6, $7, $8, $9, $10, 'EUR', $11, $12::jsonb)`,
        [`${j.id}-${n}`, j.id, accounts.get(key), l.account_code, l.account_name, n + 1, l.direction, l.direction === 'debit' ? l.amount : 0, l.direction === 'credit' ? l.amount : 0, l.amount, l.tax_type, JSON.stringify(l.role ? { role: l.role } : {})]);
    }
  }
  for (const a of book.asks) await q(`insert into client_evidence_requests (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload) values ($1, 'firm-k', 'client-k', $2, $3, $4, $5, $6::jsonb)`,
    [a.id, a.transaction_id, a.status, a.evidence_type, a.question, JSON.stringify(a.document_id ? { document_id: a.document_id } : {})]);
  await q("update transactions t set coding_state = x.coding_state, convergence_state = x.convergence_state from (select * from jsonb_to_recordset($1::jsonb) as x(id text, coding_state text, convergence_state text)) x where t.id = x.id", [JSON.stringify(book.transactions)]);
  await q("update documents d set convergence_state = x.convergence_state from (select * from jsonb_to_recordset($1::jsonb) as x(id text, convergence_state text)) x where d.id = x.id", [JSON.stringify(book.documents)]);
}

test('real PG: the reader reads a book read-only, names the models from the data and scores it as the pure scorer does', PG, async () => {
  const template = await createTemplate(pgUrl);
  const { pool, drop } = await template.clone();
  try {
    const book = treeBook();
    await seedBook(pool, book);
    const snapshot = await readMonthSnapshot(pool, { firmId: 'firm-k', clientId: 'client-k' });
    assert.equal(snapshot.transactions.length, 36);
    assert.deepEqual(snapshot.models.coding_payload, ['fixture-coder']);
    assert.deepEqual(snapshot.models.document_parse, ['fixture-extractor']);
    const pure = score(book), fromDb = scoreMonth(labels, snapshot, { decisionOf, source: 'fixture' });
    assert.deepEqual(fromDb.lines.map(l => [l.id, l.correct_complete, l.material]), pure.lines.map(l => [l.id, l.correct_complete, l.material]));
    assert.deepEqual(fromDb.economics, pure.economics);
    assert.deepEqual(fromDb.economics.capability_gaps.filter(g => g.observed).map(g => g.id), ['CG-1']);
    // By company name, in a read-only transaction: nothing is written.
    const url = new URL(pgUrl); url.pathname = `/${template.name}_1`;
    const before = (await pool.query('select (select count(*) from audit_events) a, (select count(*) from ledger_journals) j, (select count(*) from client_evidence_requests) r')).rows[0];
    const { report } = await scoreBookReadOnly({ databaseUrl: url.toString(), companyName: 'Kampaamo Kultalanka Oy' });
    assert.equal(report.summary.correct_complete, 30);
    assert.deepEqual((await pool.query('select (select count(*) from audit_events) a, (select count(*) from ledger_journals) j, (select count(*) from client_evidence_requests) r')).rows[0], before);
    await assert.rejects(scoreBookReadOnly({ databaseUrl: url.toString(), companyName: 'Nobody Oy' }), /client_not_found/);
    // The CLI prints the human report.
    const out = mkdtempSync(join(tmpdir(), 'kultalanka-score-'));
    const write = process.stdout.write; let printed = '';
    process.stdout.write = chunk => { printed += chunk; return true; };
    try { assert.equal(await mainScore([`--database-url=${url}`, '--company-name=Kampaamo Kultalanka Oy', `--output=${join(out, 'report.json')}`]), 0); } finally { process.stdout.write = write; }
    assert.match(printed, /correct complete 30\/37 · material wrong autonomous 0/);
    assert.ok(existsSync(join(out, 'report.json')));
    rmSync(out, { recursive: true, force: true });
  } finally { await drop(); await template.drop(); }
});

// ── Real PG: the whole month on the appliance path, recorded and replayed ───
// A fixture provider: the router names each source's family from its file
// name, the bank statement extracts the 36 printed rows, and every other lane
// answers an empty object (the runtime refuses it by name). Mechanics only.
const openaiBody = payload => { const b = clone(loadRecording('document_routing/ochre-supplier-bill').body); b.output[0].content[0].text = JSON.stringify(payload); return b; };
const anthropicBody = payload => { const b = clone(loadRecording('unified_extraction/ochre-discount-line').body); b.content[0].text = JSON.stringify(payload); return b; };
const bankRows = () => labels.lines.filter(l => l.bank).map(l => l.bank);
function fixtureProvider() {
  const calls = [];
  let balance = labels.entity.bank.opening * 100;
  const rows = bankRows().map(b => { balance += (b.direction === 'in' ? 1 : -1) * Math.round(b.amount * 100);
    return { date: b.date, counterparty: b.counterparty, payment_method: 'bank_transfer', message: b.message, reference: null, description: `${b.kind} ${b.counterparty} ${b.message}`, direction: b.direction, amount: b.amount, currency: 'EUR', balance: balance / 100 }; });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), text = JSON.stringify(body);
    // The lane by what the request carries on either provider (an OpenAI
    // strict-schema name, or an Anthropic system prompt / user prompt
    // signature — the document lanes resolve Anthropic first since
    // 2026-11-10).
    const schema = body?.text?.format?.name || classifyProviderRequest({ url, init })?.lane || null;
    calls.push({ lane: schema || 'anthropic', provider: String(url).includes('openai') ? 'openai' : String(url).includes('anthropic') ? 'anthropic' : 'typesafe', max_output_tokens: body.max_output_tokens ?? null, max_tokens: body.max_tokens ?? null });
    let payload = {};
    if (schema === 'document_routing') {
      const family = text.includes('Tiliote') ? 'bank_statement' : 'invoice_or_bill';
      payload = { document_family: family, confidence: 0.98, direction_hint: 'unknown', candidate_families: [{ family, confidence: 0.98 }], language_hint: 'fi', reason: 'Fixture routing by file name.' };
    } else if (schema === 'bank_statement_extraction') {
      payload = { transactions: rows, statement_summary: { opening_balance: labels.entity.bank.opening, closing_balance: labels.entity.bank.closing, total_deposits: 14057.38, total_payouts: 8194.37, currency: 'EUR', period_start: '2025-02-01', period_end: '2025-02-28', account_identifier: 'FI0350009420001234' } };
    }
    const out = String(url).includes('openai') ? openaiBody(payload) : String(url).includes('anthropic') ? anthropicBody(payload) : { error: { type: 'fixture' } };
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}
const fixtureBudget = models => verifyBudget({ approved: true, max_calls: 4000, max_input_tokens: 500_000_000, max_output_tokens: 500_000_000, max_usd: 10_000,
  prices: { typesafe: { input_per_million: 1, output_per_million: 1 }, anthropic: { input_per_million: 1, output_per_million: 1 }, models: Object.fromEntries(models.map(m => [m, { input_per_million: 1, output_per_million: 1 }])) } });
const SETTLE_FAST = { advance_ms: 300_000, quiet_rounds: 2, max_rounds: 14 };

test('real PG: the whole month runs on a disposable book under the shared ledger, and its replay reproduces the score with no network', { ...PG, timeout: 1_800_000 }, async () => {
  const plan = { ...buildMonthPlan({ runToken: `kl-month-${process.pid}`, clockStart: '2025-03-03T08:00:00Z', settle: SETTLE_FAST }) };
  // An unpriced model stops the run before its first paid dispatch.
  const refused = await runDecisionPlane(plan, { mode: 'live', lane: makeMonthLane({ offline: true }), budget: fixtureBudget([]), fetchImpl: fixtureProvider().fetchImpl });
  assert.equal(refused.completion, 'incomplete');
  assert.match(refused.month_failure.error, /^unpriced_model:openai:/);
  assert.equal(refused.records.filter(r => r.provider === 'openai').length, 0);

  // The output ceiling is enforced on the wire: a budget that cannot hold one
  // capped answer refuses before any provider sees a request.
  const tight = fixtureProvider();
  const capped = await runDecisionPlane(plan, { mode: 'live', lane: makeMonthLane({ offline: true }), budget: { ...fixtureBudget(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']), max_output_tokens: 1000 }, fetchImpl: tight.fetchImpl });
  assert.equal(capped.completion, 'incomplete');
  assert.match(capped.budget.refusal.bound, /^max_output_tokens$/);
  assert.equal(tight.calls.length, 0);

  const provider = fixtureProvider();
  const live = await runDecisionPlane(plan, { mode: 'live', lane: makeMonthLane({ offline: true }), budget: fixtureBudget(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']), fetchImpl: provider.fetchImpl });
  assert.equal(live.month_failure, undefined, JSON.stringify(live.month_failure));
  assert.equal(live.month.run.source_jobs_settled, true, 'real source jobs must settle before evaluation sweeps');
  assert.equal(live.month.identification.missing_sources.length, 0);
  assert.deepEqual(live.month.identification.missing_bank_rows, [], JSON.stringify(live.month.run));
  assert.equal(live.records.length, live.provider_calls);
  assert.ok(live.records.length > 27 && live.records.every(r => /^month\/\d+$/.test(r.id) && r.budget?.actual));
  assert.equal(live.budget.ledger.calls, live.records.length);
  assert.ok(Object.keys(live.month.provider_lanes).length > 1);
  // Every OpenAI body that reached the provider carried the frozen ceiling, and
  // the reservation was made against that same request.
  const openaiCalls = provider.calls.filter(c => c.provider === 'openai');
  assert.ok(openaiCalls.length > 0 && openaiCalls.every(c => c.max_output_tokens === plan.max_output_tokens), JSON.stringify(openaiCalls.slice(0, 3)));
  assert.ok(live.records.filter(r => r.provider === 'openai').every(r => r.budget.estimate.output_tokens === plan.max_output_tokens));
  assert.equal(live.summary.cases, 37);
  assert.equal(live.summary.material_wrong_autonomous_actions, 0, JSON.stringify(live.lane_outcomes.month.report.lines.filter(l => l.material?.length)));
  assert.ok(Array.isArray(live.month.economics.checks));
  // The public projection carries no raw bodies.
  assert.ok(!JSON.stringify(publicSummary(live)).includes('output_text'));

  // Replay: the recorded answers, served by exact request digest to a fresh
  // disposable book, with any network access failing the test.
  const noNetwork = async () => { throw new Error('network_used_in_replay'); };
  const replay = await runDecisionPlane(plan, { mode: 'replay', lane: makeMonthLane({ offline: true }), replay: live, fetchImpl: noNetwork });
  assert.equal(replay.month_failure, undefined, JSON.stringify(replay.month_failure));
  assert.equal(replay.provider_calls, 0);
  assert.equal(replay.month.replay.unconsumed_records, 0);
  assert.equal(replay.month.replay.reproduced, true);
  assert.equal(replay.lane_outcomes.month.score_sha256, live.lane_outcomes.month.score_sha256);

  // A budget stop, then a resume: paid calls are reused by exact request
  // digest, never re-requested, and the cumulative ledger spans both attempts.
  const small = { ...fixtureBudget(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']), max_calls: 12 };
  const stopped = await runDecisionPlane(plan, { mode: 'live', lane: makeMonthLane({ offline: true }), budget: small, fetchImpl: fixtureProvider().fetchImpl });
  assert.equal(stopped.completion, 'incomplete');
  assert.equal(stopped.budget.refusal.bound, 'max_calls');
  assert.equal(stopped.records.length, 12);
  const resumeProvider = fixtureProvider();
  const resumed = await runDecisionPlane(plan, { mode: 'live', lane: makeMonthLane({ offline: true, resume: stopped }), resume: stopped,
    budget: fixtureBudget(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']), fetchImpl: resumeProvider.fetchImpl });
  assert.equal(resumed.month_failure, undefined, JSON.stringify(resumed.month_failure));
  assert.equal(resumed.resumed_calls, 12);
  assert.equal(resumeProvider.calls.length, live.records.length - 12, 'only the unpaid calls are requested');
  assert.equal(resumed.budget.cumulative.calls, live.records.length);
  assert.equal(resumed.lane_outcomes.month.score_sha256, live.lane_outcomes.month.score_sha256);

  // A replay whose recorded score differs fails the run (exit 2), with its diagnostics kept.
  const wrongScore = clone(live); wrongScore.lane_outcomes.month.score_sha256 = hash('another score');
  const unreproduced = await runDecisionPlane(plan, { mode: 'replay', lane: makeMonthLane({ offline: true }), replay: wrongScore, fetchImpl: noNetwork });
  assert.equal(unreproduced.month.replay.reproduced, false);
  assert.equal(unreproduced.completion, 'incomplete');

  // A replay whose records were edited cannot serve the changed request.
  const edited = clone(live); edited.records[0].request_sha256 = hash('edited');
  const drifted = await runDecisionPlane(plan, { mode: 'replay', lane: makeMonthLane({ offline: true }), replay: edited, fetchImpl: noNetwork });
  assert.equal(drifted.completion, 'incomplete');
  assert.match(drifted.month_failure.error, /replay_unrecorded_request|replay_record_mismatch/);
});

test('the month plan freezes the labels, the source bytes, the runtime and the code, and refuses any drift before a provider request', async () => {
  const plan = buildMonthPlan({ runToken: 'kl-freeze', clockStart: '2025-03-03T08:00:00Z' });
  const lane = makeMonthLane({ offline: true });
  assert.ok(lane.verifyPlan(plan));
  assert.equal(plan.max_output_tokens, 32768);
  assert.match(plan.runtime.tree_sha256, /^[0-9a-f]{64}$/);
  // A changed PDF: refused at verification, before the runner dispatches anything.
  const dir = mkdtempSync(join(tmpdir(), 'kultalanka-sources-'));
  try {
    for (const s of sourceFiles(labels)) writeFileSync(join(dir, s.file), readFileSync(join(KULTALANKA_DIR, 'sources', s.file)));
    assert.ok(makeMonthLane({ offline: true, sourcesDir: dir }).verifyPlan(plan));
    const f = join(dir, sourceFiles(labels)[3].file); writeFileSync(f, Buffer.concat([readFileSync(f), Buffer.from('\n%edited')]));
    const calls = [];
    await assert.rejects(runDecisionPlane(plan, { mode: 'replay', lane: makeMonthLane({ offline: true, sourcesDir: dir }), replay: { version: plan.version, plan_sha256: plan.plan_sha256, records: [] },
      fetchImpl: async () => { calls.push(1); throw new Error('network'); } }), /frozen_plan_mismatch:source_bytes/);
    assert.equal(calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // A changed runtime (another extractor, coder, writer or migration) refuses too.
  const other = makeMonthLane({ offline: true, identity: () => ({ ...plan.runtime, tree_sha256: hash('another runtime') }) });
  assert.throws(() => other.verifyPlan(plan), /frozen_plan_mismatch:runtime/);
  assert.throws(() => buildMonthPlan({ runToken: 'kl-freeze', maxOutputTokens: 10 }), /invalid_output_ceiling/);
  assert.equal(plan.jobs[0].request.sources.length, 27);
  assert.throws(() => lane.verifyPlan({ ...plan, labels_sha256: hash('x') }), /frozen_plan_mismatch/);
  assert.throws(() => lane.verifyPlan({ ...plan, run_token: 'kl-other' }), /frozen_plan_mismatch/);
  assert.throws(() => buildMonthPlan({ runToken: 'X' }), /run_token_required/);
  assert.equal(lane.jobOfRecord(plan, 'month/12').id, 'month');
  assert.equal(lane.jobOfRecord(plan, 'month'), null);
  assert.deepEqual(lane.estimateRequest({ model: 'm', max_tokens: 100 }, 'anthropic').output_tokens, 100);
});

// ── The coding-only view: the 36 lines through the FIK-3 lane ──────────────
test('coding view: the FIK-3 corpus is derived from the labels, in sync, development only, and keeps gaps and disputes unscored', async () => {
  const { buildCodingCases, checkCodingCorpus, CODING_VIEW_CORPUS } = await import('./fi_kultalanka_coding_view.js');
  const { loadFiCorpus, validateFiCase, checkSplit, goldOf } = await import('./jev_decision_plane_fi.js');
  assert.deepEqual(checkCodingCorpus(), []);
  const corpus = loadFiCorpus(CODING_VIEW_CORPUS);
  assert.equal(corpus.length, 36);
  corpus.forEach(validateFiCase); assert.ok(checkSplit(corpus));
  assert.ok(corpus.every(c => c.split === 'development' && c.entity === 'kampaamo-kultalanka-oy'), 'one entity, one month: never a holdout');
  const scored = corpus.filter(c => goldOf(c) && c.expressible.status === 'expressible').map(c => c.id);
  assert.equal(corpus.filter(c => c.expressible.status === 'expressible').length, 25);
  assert.equal(scored.length, 20); // five expressible lines are disputed
  for (const id of ['kl-b02', 'kl-b10', 'kl-b34']) assert.equal(goldOf(corpus.find(c => c.id === id)), null, `${id} is disputed`);
  assert.equal(corpus.find(c => c.id === 'kl-b01').expressible.status, 'gap', 'the Nets row settles by report row, a FIK-3 source gap');
  assert.equal(goldOf(corpus.find(c => c.id === 'kl-b04')).journal.find(l => l.account === '2940').amount, 2.23);
  assert.deepEqual(goldOf(corpus.find(c => c.id === 'kl-b25')).ask, { evidence_type: 'document_discrepancy', kind: 'ask_supply_timing' });
  assert.equal(corpus.find(c => c.id === 'kl-b25').labels.original.journal.find(l => l.account === '2940').amount, 2.60, 'the original keeps the key\'s 10 % deduction');
  // A label edit is corpus drift until the view is regenerated.
  const edited = clone(labels); edited.lines.find(l => l.id === 'B05').original.journal[0].amount = 286.39;
  assert.equal(JSON.stringify(buildCodingCases(edited)), JSON.stringify(buildCodingCases(labels)));
  edited.lines.find(l => l.id === 'B03').key_row = 'edited';
  assert.notEqual(JSON.stringify(buildCodingCases(edited)), JSON.stringify(buildCodingCases(labels)));
});

test('real PG: the FIK-3 lane freezes a development plan on the coding view; a holdout selection is refused', PG, async () => {
  const { buildFiPlan } = await import('./jev_decision_plane_fi_run.js');
  const { CODING_VIEW_CORPUS } = await import('./fi_kultalanka_coding_view.js');
  const plan = await buildFiPlan({ adminUrl: pgUrl, corpus: CODING_VIEW_CORPUS, split: 'development', models: { jev: 'fixture-jev', strong: 'fixture-strong' }, cases: ['kl-b03', 'kl-b25'] });
  assert.equal(plan.corpus, CODING_VIEW_CORPUS);
  assert.deepEqual(plan.jobs.map(j => j.id), ['kl-b03/fi_v7', 'kl-b03/fi_v8', 'kl-b25/fi_v7', 'kl-b25/fi_v8']);
  const requests = JSON.stringify(plan.jobs.map(j => j.request));
  for (const leak of ['kl-b25', 'kultalanka-dated_rate', 'dated_rate', 'labels', 'Ilkka']) assert.ok(!requests.includes(leak), `no ${leak} reaches a request`);
  await assert.rejects(buildFiPlan({ adminUrl: pgUrl, corpus: CODING_VIEW_CORPUS, split: 'holdout', models: { jev: 'a', strong: 'b' } }), /empty_selection/);
});
