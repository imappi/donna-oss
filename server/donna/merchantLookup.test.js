import assert from 'node:assert/strict';
import test from 'node:test';

import { deduplicateMerchants, lookupMerchants } from './merchantLookup.js';

test('deduplicateMerchants: groups identical canonical patterns', () => {
  const rows = [
    { description: 'CHEVRON GAS STA #1234', raw_description: '', money_out: 45.00, review_id: 'r1', transaction_id: 't1' },
    { description: 'CHEVRON GAS STA #5678', raw_description: '', money_out: 52.00, review_id: 'r2', transaction_id: 't2' },
    { description: 'CHEVRON GAS STA #9012', raw_description: '', money_out: 38.00, review_id: 'r3', transaction_id: 't3' }
  ];
  const result = deduplicateMerchants(rows);
  assert.equal(result.length, 1, 'three chevron charges should deduplicate to one');
  assert.ok(result[0].canonicalPattern.includes('chevron'));
});

test('deduplicateMerchants: keeps distinct merchants separate', () => {
  const rows = [
    { description: 'FERGUSON ENTERPRISES ACH 45892', raw_description: '', money_out: 2847.33, review_id: 'r1', transaction_id: 't1' },
    { description: 'SYSCO FOODS 1234', raw_description: '', money_out: 1234.56, review_id: 'r2', transaction_id: 't2' },
    { description: 'HOME DEPOT 0531', raw_description: '', money_out: 156.78, review_id: 'r3', transaction_id: 't3' }
  ];
  const result = deduplicateMerchants(rows);
  assert.equal(result.length, 3, 'three different merchants should stay separate');
});

test('deduplicateMerchants: skips empty descriptions', () => {
  const rows = [
    { description: '', raw_description: '', money_out: 10, review_id: 'r1', transaction_id: 't1' },
    { description: 'FERGUSON ENTERPRISES', raw_description: '', money_out: 100, review_id: 'r2', transaction_id: 't2' }
  ];
  const result = deduplicateMerchants(rows);
  assert.equal(result.length, 1);
});

test('deduplicateMerchants: includes direction and amount', () => {
  const rows = [
    { description: 'STRIPE PAYOUT', raw_description: '', money_in: 5000, money_out: 0, currency: 'USD', review_id: 'r1', transaction_id: 't1' }
  ];
  const result = deduplicateMerchants(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].direction, 'credit');
  assert.equal(result[0].amount, '5000.00');
  assert.equal(result[0].currency, 'USD');
});

test('deduplicateMerchants: uses raw_description as fallback', () => {
  const rows = [
    { description: '', raw_description: 'ACH DEBIT DADANT SONS INC', money_out: 500, review_id: 'r1', transaction_id: 't1' }
  ];
  const result = deduplicateMerchants(rows);
  assert.equal(result.length, 1);
  assert.ok(result[0].canonicalPattern.includes('dadant'));
});

test('deduplicateMerchants: canonical unknown currency cannot revive payload or extraction candidates', () => {
  const receipt = {
    version: 1, currency: null, source: 'conflicting_document_evidence',
    candidates: ['EUR', 'USD'], filename_candidates: ['SGD'], ledger_currency: 'GBP',
    row_candidate: 'EUR'
  };
  for (const currency of [null, undefined, '']) {
    const row = {
      description: 'UNKNOWN SHOP', currency, money_out: 10,
      review_id: 'review-original', transaction_id: 'transaction-original',
      transaction_payload: { currency: 'USD', currency_resolution: receipt }
    };
    const before = structuredClone(row);
    const [merchant] = deduplicateMerchants([row]);
    assert.equal(merchant.currency, null);
    assert.deepEqual(merchant.currencyResolution, receipt);
    assert.equal(merchant.reviewId, row.review_id);
    assert.equal(merchant.transactionId, row.transaction_id);
    assert.deepEqual(row, before, 'prompt preparation leaves source evidence intact');
  }
});

test('lookupMerchants: actual request keeps unknown denomination separate from provenance and preserves healthy results', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'offline-merchant-test';
  const receipt = {
    version: 1, currency: 'USD', source: 'model_document_evidence',
    row_candidate: 'USD', filename_candidates: ['SGD'], ledger_currency: 'GBP'
  };
  const merchants = deduplicateMerchants([
    { description: 'UNKNOWN SHOP', currency: null, money_out: 10, transaction_payload: { currency: 'USD', currency_resolution: receipt } },
    { description: 'MISSING SHOP', money_out: 20 },
    { description: 'FOREIGN SHOP', currency: 'GBP', money_out: 30 },
    { description: 'DOLLAR SHOP', currency: 'USD', money_in: 40 },
    { description: 'FOREIGN SHOP', currency: 'AED', money_out: 50 }
  ]);
  const accounts = [{ code: '5000', name: 'Operating supplies', account_type: 'expense' }];
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ content: [{ text: JSON.stringify({ merchants: [
      { index: 3, merchant_name: 'Foreign Shop', merchant_category: 'supplies', suggested_account_code: '5000', suggested_account_name: 'Operating supplies', confidence: 'high', reasoning: 'Supplies merchant' },
      { index: 2, merchant_name: 'Uncertain Shop', suggested_account_code: '5000', confidence: 'low' }
    ] }) }] }) };
  };
  try {
    const results = await lookupMerchants({ merchants, accounts, clientName: 'Our Entity' });
    assert.equal(requests.length, 1, 'one mocked request for the deduplicated batch');
    const request = requests[0];
    assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(request.method, 'POST');
    const prompt = request.body.messages[0].content;
    assert.match(prompt, /1\. "UNKNOWN SHOP" \(debit, amount: 10\.00, currency: unknown\)/);
    assert.match(prompt, /2\. "MISSING SHOP" \(debit, amount: 20\.00, currency: unknown\)/);
    assert.match(prompt, /3\. "FOREIGN SHOP" \(debit, amount: 30\.00, currency: GBP\)/);
    assert.match(prompt, /4\. "DOLLAR SHOP" \(credit, amount: 40\.00, currency: USD\)/);
    assert.ok(prompt.includes(`Currency evidence (provenance only): ${JSON.stringify(receipt)}`));
    assert.doesNotMatch(prompt, /currency: (SGD|AED)/);
    assert.match(request.body.system, /do not replace an unknown currency/);
    assert.match(prompt, /5000 \| Operating supplies \(expense\)/);
    assert.deepEqual(results, [{
      canonicalPattern: merchants[2].canonicalPattern,
      bankDescription: 'FOREIGN SHOP', merchantName: 'Foreign Shop', merchantCategory: 'supplies',
      accountCode: '5000', accountName: 'Operating supplies', confidence: 0.88,
      confidenceLabel: 'high', reasoning: 'Supplies merchant'
    }]);
    assert.equal(merchants[0].currency, null);
    assert.deepEqual(merchants[0].currencyResolution, receipt);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});
