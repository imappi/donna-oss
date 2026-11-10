import assert from 'node:assert/strict';
import test from 'node:test';
import { ledgerAdjustmentAskMessages } from './ledgerAdjustmentAskView.js';
import en from '../i18n/catalogs/en.js';

const subject = {
  kind: 'settlement_reversal', refusal_code: 'LEDGER_ADJUSTMENT_DATE_IN_FILED_RETURN',
  document_id: 'doc-1', document_label: 'Synthetic Fuel', amount: 12.4, currency: 'EUR',
  bank_transaction_id: 'bank-1', bank_line_date: '2026-05-15', bank_line_description: 'Synthetic card payment',
  settlement_journal_id: 'lj-1', filed_return_id: 'alv-q2', filed_return_period: null,
  tax_moved: [{ key: 'tax_code:ALV_25_5_INPUT', amount: -12.4, currency: 'EUR' }, { key: 'alv_control', amount: 3, currency: 'EUR' }]
};

test('a ledger adjustment ask renders its stored facts through catalog messages', () => {
  const messages = ledgerAdjustmentAskMessages({ evidence_type: 'ledger_adjustment', ledger_adjustment: subject });
  assert.deepEqual(messages, [
    { id: 'mounted.financial.ledgerAdjustmentAsk.settlementReversal', values: { journal: 'lj-1', document: 'Synthetic Fuel', amount: '12.40', currency: 'EUR', date: '2026-05-15', transaction: 'Synthetic card payment' } },
    { id: 'mounted.financial.ledgerAdjustmentAsk.dateInFiledReturn', values: { period: 'alv-q2', detail: 'ALV_25_5_INPUT -12.40 EUR, alv_control 3.00 EUR' } },
    { id: 'mounted.financial.ledgerAdjustmentAsk.todo', values: { journal: 'lj-1' } }
  ]);
  for (const message of messages) assert.ok(en[message.id], message.id);
});

test('any other ask, or an unknown refusal, keeps its stored question', () => {
  assert.equal(ledgerAdjustmentAskMessages({ evidence_type: 'colleague_answer', question: 'Is this right?' }), null);
  assert.equal(ledgerAdjustmentAskMessages({ evidence_type: 'ledger_adjustment', ledger_adjustment: { ...subject, refusal_code: 'OTHER' } }), null);
  assert.equal(ledgerAdjustmentAskMessages({ evidence_type: 'ledger_adjustment', ledger_adjustment: null }), null);
});
