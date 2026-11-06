import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedXeroMirrorPreview } from './xeroMirrorReplay.js';

const recorded = { Type: 'SPEND', Date: '2026-07-01', CurrencyCode: 'GBP',
  BankAccount: { Code: '1200' }, Contact: { Name: 'Recorded supplier' },
  LineItems: [{ Description: 'Original purpose', AccountCode: '7500', TaxType: 'INPUT2', UnitAmount: 120, Quantity: 1 }],
  LineAmountTypes: 'Inclusive', Reference: 'original-reference' };

test('historical provider payload replays exactly without current country/chart/prose interpretation', () => {
  const transaction = { xero_writeback_payload: recorded, jurisdiction: 'sg', tax_treatment: 'GST 9%',
    account_code: 'changed', money_out: 500 };
  const result = retainedXeroMirrorPreview(transaction);
  assert.deepEqual(result.bank_transaction, recorded);
  assert.notEqual(result.bank_transaction, recorded);
  assert.equal(result.coding.xero_tax_type, 'INPUT2');
  assert.equal(result.coding.account_code, '7500');
  result.bank_transaction.LineItems[0].UnitAmount = 0;
  assert.equal(recorded.LineItems[0].UnitAmount, 120);
});

test('missing historical payload is distinct from a malformed receipt and cannot silently fall through', () => {
  assert.equal(retainedXeroMirrorPreview({}), null);
  for (const payload of [{}, { ...recorded, LineItems: [] }, { ...recorded, BankAccount: {} }]) {
    assert.throws(() => retainedXeroMirrorPreview({ xero_writeback_payload: payload }), { code: 'XERO_MIRROR_RETRY_PAYLOAD_INVALID' });
  }
  assert.deepEqual(retainedXeroMirrorPreview({ xero_mirror_retry_payload: recorded }).bank_transaction, recorded);
});
