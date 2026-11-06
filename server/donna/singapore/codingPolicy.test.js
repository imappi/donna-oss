import assert from 'node:assert/strict';
import test from 'node:test';

import { SG_CODING_POLICY } from './codingPolicy.js';
import {
  makeDeterministicTransactionSuggestion,
  suggestTransactionCoding,
  suggestTransactionCodingBatch
} from '../transactionLlm.js';

// Characterize the inherited policy rather than silently upgrading Singapore
// to gstCodes.js's richer vocabulary during an ownership-only extraction.
test('Singapore owns the unchanged legacy policy without shared default exports', () => {
  assert.equal(SG_CODING_POLICY.id, 'sg_legacy_coding');
  assert.equal(SG_CODING_POLICY.version, 1);
  assert.equal(SG_CODING_POLICY.jurisdiction, 'sg');
  assert.deepEqual(SG_CODING_POLICY.accountOptions, [
    'Sales', 'Bank fees', 'Software subscriptions', 'Travel',
    'Meals and entertainment', 'Marketing', 'Professional fees',
    'Accounting fees', 'Statutory filing fees', 'Payroll', 'CPF payable',
    'Rent', 'Telecommunications', 'Insurance', 'Office expenses',
    'Director loan', 'Owner drawings', 'Share capital', 'Share premium',
    'Retained earnings', 'Loan payable', 'Intercompany transfer',
    'Interest income', 'Tax payable', 'Foreign exchange gain/loss', 'Suspense'
  ]);
  assert.deepEqual(SG_CODING_POLICY.taxTreatmentOptions, ['GST 9%', 'No GST', 'Out of scope', 'GST check']);
  assert.equal(SG_CODING_POLICY.taxInstructions, "Tax treatment is a bookkeeping suggestion only: use GST options only when the client's jurisdiction/tax profile indicates a GST or VAT regime; otherwise prefer No GST, and Out of scope for internal transfers/equity/capital movements.");
  assert.ok(Object.isFrozen(SG_CODING_POLICY));
  assert.ok(Object.isFrozen(SG_CODING_POLICY.accountOptions));
  assert.ok(Object.isFrozen(SG_CODING_POLICY.taxTreatmentOptions));

  const ordinary = makeDeterministicTransactionSuggestion({ clientProfile: { jurisdiction: 'sg' }, transaction: { description: 'BANK FEE' } });
  const transfer = makeDeterministicTransactionSuggestion({ clientProfile: { jurisdiction: 'sg' }, transaction: { description: 'INTERNAL TRANSFER' } });
  assert.equal(ordinary.tax_treatment, SG_CODING_POLICY.defaultTaxTreatment);
  assert.equal(transfer.tax_treatment, SG_CODING_POLICY.outOfScopeTaxTreatment);
});

test('real single and batch coding requests consume the Singapore-owned schema and instructions', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  const calls = [];
  const suggestion = {
    proposed_account: 'Sales', contact: 'Example customer', tax_treatment: 'GST 9%',
    support_note: '', ask_client_question: '', evidence_required: false,
    remember_candidate: false, merchant_pattern: '', missing_account_name: '',
    missing_account_type: '', missing_account_reason: '', auto_explain_limit: 0,
    confidence: 'high', materiality: 'normal', reasoning: 'Sales invoice settlement.',
    warnings: [], alternatives: []
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses', 'no real provider or merchant call');
    const body = JSON.parse(init.body);
    calls.push(body);
    const output = body.text.format.name === 'transaction_coding_batch_suggestion'
      ? { suggestions: [{ transaction_id: 'tx-sg-policy', ...suggestion }], group_summary: [] }
      : suggestion;
    return { ok: true, json: async () => ({ id: 'test-response', output_text: JSON.stringify(output) }) };
  });

  const clientProfile = { id: 'sg-policy-client', jurisdiction: 'sg', companyName: 'Example Pte Ltd' };
  const transaction = {
    id: 'tx-sg-policy', date: '2026-06-01', description: 'SALES INVOICE PAYMENT',
    money_in: 109, money_out: 0, account_currency: 'SGD'
  };
  const single = await suggestTransactionCoding({ clientProfile, transaction });
  const batch = await suggestTransactionCodingBatch({ clientProfile, transactions: [transaction] });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const schema = call.text.format.schema;
    const properties = schema.properties.suggestions?.items.properties || schema.properties;
    assert.deepEqual(properties.proposed_account.enum, SG_CODING_POLICY.accountOptions);
    assert.deepEqual(properties.tax_treatment.enum, SG_CODING_POLICY.taxTreatmentOptions);
    assert.equal(call.instructions.split(SG_CODING_POLICY.taxInstructions).length, 2, 'inherited paragraph appears exactly once');
  }
  assert.equal(single.proposed_account, 'Sales');
  assert.equal(single.tax_treatment, 'GST 9%');
  assert.equal(batch.suggestions[0].proposed_account, 'Sales');
  assert.equal(batch.suggestions[0].tax_treatment, 'GST 9%');
});
