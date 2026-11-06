import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProcountorExportPackage } from './procountorExportPackage.js';

const base = {
  clientId: 'client_1',
  periodStart: '2026-06-01',
  periodEnd: '2026-06-30',
  generatedAt: '2026-07-06T00:00:00.000Z',
  accounts: [
    { id: 'a_bank', code: '1910', name: 'Bank' },
    { id: 'a_sales', code: '3000', name: 'Sales' },
    { id: 'a_expense', code: '4000', name: 'Expense' }
  ],
  documents: [{ id: 'doc_1', filename: 'receipt.pdf', document_type: 'receipt' }],
  transactions: [
    { id: 'tx_1', transaction_date: '2026-06-02', description: 'Sale', money_in: 100, money_out: 0, currency: 'EUR', status: 'posted', document_id: 'doc_1', payload: { coding: { model: 'persisted-model', confidence: 0.91, proposed_by: 'donna' } } }
  ],
  evidenceRequests: [],
  closeBlockers: []
};

test('balanced batch renders with evidence, coding, and summary totals', () => {
  const result = buildProcountorExportPackage({
    ...base,
    journals: [{ id: 'j_1', source_type: 'transaction', source_id: 'tx_1', journal_date: '2026-06-02', currency: 'EUR', memo: 'Posted sale' }],
    ledgerLines: [
      { journal_id: 'j_1', account_id: 'a_bank', account_code: '1910', account_name: 'Bank', line_no: 1, debit: 100, credit: 0, currency: 'EUR' },
      { journal_id: 'j_1', account_id: 'a_sales', account_code: '3000', account_name: 'Sales', line_no: 2, debit: 0, credit: 100, currency: 'EUR' }
    ]
  });
  assert.equal(result.package.summary.balanced, true);
  assert.equal(result.package.summary.total_debits, 100);
  assert.equal(result.package.summary.total_credits, 100);
  assert.deepEqual(result.package.posting_batch[0].evidence, [{ document_id: 'doc_1', filename: 'receipt.pdf', kind: 'receipt' }]);
  assert.equal(result.package.posting_batch[0].coding.model, 'persisted-model');
  assert.match(result.rendered_summary, /Journals: 1/);
});

test('unbalanced journal is flagged instead of dropped', () => {
  const result = buildProcountorExportPackage({
    ...base,
    journals: [{ id: 'j_bad', source_type: 'transaction', source_id: 'tx_1', journal_date: '2026-06-03', currency: 'EUR' }],
    ledgerLines: [
      { journal_id: 'j_bad', account_id: 'a_bank', line_no: 1, debit: 100, credit: 0, currency: 'EUR' },
      { journal_id: 'j_bad', account_id: 'a_sales', line_no: 2, debit: 0, credit: 99, currency: 'EUR' }
    ]
  });
  assert.equal(result.package.posting_batch.length, 1);
  assert.equal(result.package.posting_batch[0].balanced, false);
  assert.equal(result.package.summary.balanced, false);
  assert.match(result.rendered_summary, /Unbalanced journals: j_bad/);
});

test('missing evidence renders as an empty array and appears in summary', () => {
  const result = buildProcountorExportPackage({
    ...base,
    transactions: [{ ...base.transactions[0], document_id: null }],
    documents: [],
    journals: [{ id: 'j_no_doc', source_type: 'transaction', source_id: 'tx_1', journal_date: '2026-06-04', currency: 'EUR' }],
    ledgerLines: [
      { journal_id: 'j_no_doc', account_id: 'a_expense', line_no: 1, debit: 10, credit: 0, currency: 'EUR' },
      { journal_id: 'j_no_doc', account_id: 'a_bank', line_no: 2, debit: 0, credit: 10, currency: 'EUR' }
    ]
  });
  assert.deepEqual(result.package.posting_batch[0].evidence, []);
  assert.deepEqual(result.package.summary.journals_without_evidence, ['j_no_doc']);
  assert.match(result.rendered_summary, /Journals without evidence links: 1/);
});

test('unresolved sections are populated from fixtures', () => {
  const result = buildProcountorExportPackage({
    ...base,
    transactions: [...base.transactions, { id: 'tx_open', transaction_date: '2026-06-05', description: 'Unposted', money_in: 0, money_out: 25, currency: 'EUR', status: 'needs_review' }],
    evidenceRequests: [{ id: 'cer_1', transaction_id: 'tx_open', status: 'open', evidence_type: 'receipt', question: 'Please add receipt', due_at: '2026-07-01T00:00:00Z' }],
    closeBlockers: [{ id: 'case_1', case_type: 'sync', blockers: [{ id: 'b_1', status: 'open' }] }],
    journals: [],
    ledgerLines: []
  });
  assert.equal(result.package.unresolved.unposted_transactions.length, 2);
  assert.equal(result.package.unresolved.open_owner_questions.length, 1);
  assert.equal(result.package.unresolved.open_cases.length, 1);
});

test('empty period returns an empty but valid package', () => {
  const result = buildProcountorExportPackage({ clientId: 'client_empty', periodStart: '2026-06-01', periodEnd: '2026-06-30', generatedAt: '2026-07-06T00:00:00.000Z' });
  assert.equal(result.package.summary.journals, 0);
  assert.equal(result.package.summary.lines, 0);
  assert.equal(result.package.summary.balanced, true);
  assert.deepEqual(result.package.posting_batch, []);
  assert.match(result.rendered_summary, /Journals: 0/);
});
