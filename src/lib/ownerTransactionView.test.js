import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOwnerTransactionView } from './ownerTransactionView.js';

test('no verdict — unstamped client or ordinary line — renders nothing', () => {
  assert.equal(buildOwnerTransactionView(null), null);
  assert.equal(buildOwnerTransactionView({}), null);
  assert.equal(buildOwnerTransactionView({ ai_suggestion: { proposed_account: 'Sales' } }), null);
  assert.equal(buildOwnerTransactionView({ payload: { ai_suggestion: { owner_transaction: null } } }), null);
});

test('a proposal verdict carries the label and suggested accounts', () => {
  const view = buildOwnerTransactionView({ payload: { ai_suggestion: { owner_transaction: {
    axis: 'sole_trader', type: 'owner_drawings', terminal: 'proposal',
    suggested_accounts: { debit: '2010', credit: '1400' }
  } } } });
  assert.deepEqual(view, {
    typeLabel: 'Owner drawings', terminal: 'proposal', reasonCode: null,
    missingEvidence: [], question: '', suggestedAccounts: { debit: '2010', credit: '1400' }
  });
});

test('an escalate verdict carries reason, humanised missing evidence, and the question', () => {
  const view = buildOwnerTransactionView({ ai_suggestion: { owner_transaction: {
    axis: 'ltd', type: 'dividend', terminal: 'escalate', reason: 'missing_required_evidence',
    missing_evidence: ['board_minute', 'dividend_voucher'],
    question_en: 'Was the £500 on 1 Aug a dividend? If so, please send the voucher.'
  } } });
  assert.deepEqual(view, {
    typeLabel: 'Dividend', terminal: 'escalate', reasonCode: 'missing_required_evidence',
    missingEvidence: ['board minute', 'dividend voucher'],
    question: 'Was the £500 on 1 Aug a dividend? If so, please send the voucher.',
    suggestedAccounts: null
  });
});

test('payload.ai_suggestion outranks the flattened tx.ai_suggestion (verdict home first)', () => {
  const view = buildOwnerTransactionView({
    payload: { ai_suggestion: { owner_transaction: { type: 'owner_capital_introduced', terminal: 'proposal', suggested_accounts: { debit: '1400', credit: '2000' } } } },
    ai_suggestion: { owner_transaction: { type: 'dividend', terminal: 'escalate' } }
  });
  assert.equal(view.typeLabel, 'Owner capital introduced');
});

test('a persisted type this map cannot label surfaces raw instead of hiding', () => {
  const view = buildOwnerTransactionView({ ai_suggestion: { owner_transaction: { type: 'new_future_type', terminal: 'escalate' } } });
  assert.equal(view.typeLabel, 'new_future_type');
  assert.equal(view.reasonCode, 'owner_transfer_requires_review');
});
