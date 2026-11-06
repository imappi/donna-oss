import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshTransactionDraftForClient } from './firmAccounting.js';

const transaction = { id: 'legacy', extracted: true, status: 'needs_review',
  proposed_account: 'Office expenses', tax_treatment: 'No GST',
  description: 'Recorded expense', money_out: 12, source_filename: 'statement_SGD_USD.pdf',
  source_line: 'ending balance SGD 500' };

test('legacy local refresh does not invent book currency or recover it from filename/text', () => {
  for (const jurisdiction of ['sg', 'fi', 'gb', 'ae', 'us', 'au', null]) {
    const result = refreshTransactionDraftForClient(transaction, { jurisdiction });
    assert.equal(result.account_currency, '');
    assert.equal(result.ledger_currency, '');
    assert.equal(result.ledger_conversion_status, '');
    assert.equal(result.source_line, transaction.source_line);
  }
});

test('explicit legacy currency and existing correction remain usable without a new receipt', () => {
  const result = refreshTransactionDraftForClient({ ...transaction, account_currency: 'EUR' }, { ledger_currency: 'GBP' });
  assert.equal(result.account_currency, 'EUR');
  assert.equal(result.ledger_currency, 'GBP');
  assert.equal(result.ledger_conversion_status, 'needs_fx_rate');
  assert.equal(result.currency_resolution, undefined);
  const corrected = { ...transaction, status: 'approved', account_currency: null };
  assert.equal(refreshTransactionDraftForClient(corrected, { ledger_currency: 'GBP' }), corrected);
});
