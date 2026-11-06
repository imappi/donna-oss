import assert from 'node:assert/strict';

import { buildXeroMirrorVerificationResult } from './xeroMirrorVerification.js';

const expected = {
  BankTransactionID: 'xero-1',
  Type: 'SPEND',
  Date: '2024-10-08',
  BankAccount: { Code: 'AWX779' },
  LineItems: [{ AccountCode: '485', TaxType: 'INPUTY24', UnitAmount: 120, Quantity: 1 }]
};

const ok = buildXeroMirrorVerificationResult({
  transaction: { id: 'tx-1', xero_bank_transaction_id: 'xero-1' },
  expectedBankTransaction: expected,
  xeroResponse: {
    BankTransactions: [{
      BankTransactionID: 'xero-1',
      Type: 'SPEND',
      DateString: '2024-10-08T00:00:00',
      Status: 'AUTHORISED',
      Total: 120,
      BankAccount: { Code: 'AWX779' },
      LineItems: [{ AccountCode: '485', TaxType: 'INPUTY24', UnitAmount: 120 }]
    }]
  }
});

assert.equal(ok.status, 'mirror_ok');
assert.equal(ok.severity, 'warning');
assert.equal(ok.checks.date, true);
assert.equal(ok.checks.amount, true);
assert.equal(ok.checks.account, true);
assert.equal(ok.checks.tax_type, true);

const missing = buildXeroMirrorVerificationResult({
  transaction: { id: 'tx-2', xero_bank_transaction_id: 'xero-missing' },
  expectedBankTransaction: expected,
  xeroResponse: { BankTransactions: [] }
});

assert.equal(missing.status, 'mirror_missing');
assert.equal(missing.checks.exists, false);

const drift = buildXeroMirrorVerificationResult({
  transaction: { id: 'tx-3', xero_bank_transaction_id: 'xero-drift' },
  expectedBankTransaction: expected,
  xeroResponse: {
    BankTransactions: [{
      BankTransactionID: 'xero-drift',
      DateString: '2024-10-09',
      Status: 'AUTHORISED',
      Total: 130,
      BankAccount: { Code: 'OTHER' },
      LineItems: [{ TaxType: 'NONE', UnitAmount: 130 }]
    }]
  }
});

assert.equal(drift.status, 'mirror_drift');
assert.equal(drift.checks.date, false);
assert.equal(drift.checks.amount, false);
assert.equal(drift.checks.account, false);
assert.equal(drift.checks.tax_type, false);

const error = buildXeroMirrorVerificationResult({
  transaction: { id: 'tx-4', xero_bank_transaction_id: 'xero-error' },
  error: new Error('Xero unavailable')
});

assert.equal(error.status, 'mirror_error');
assert.equal(error.error, 'Xero unavailable');

console.log('Xero mirror verification tests passed');
