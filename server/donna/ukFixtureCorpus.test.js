import assert from 'node:assert/strict'; import test from 'node:test'; import { readFileSync } from 'node:fs';
import { extractBankStatementFromBase64 } from './bankStatement.js';
import { normalizeIsoOrDayFirstDate } from './parsePrimitives.js';
import { extractUnified } from './unifiedExtractor.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/uk/${name}`, import.meta.url));
test('synthetic Barclays-shaped statement stamps native GBP for a GB book', async () => {
  const csv = fixture('barclays-statement.csv');
  const out = await extractBankStatementFromBase64({ base64: csv.toString('base64'), filename: 'barclays-2026.csv', mimeType: 'text/csv', ledgerCurrency: 'GBP' });
  // The L2 pin is dates + amounts + directions, not just the currency stamp —
  // an amount-less parse once passed this test while pinning nothing.
  assert.equal(out.transactions.length, 2);
  const [rent, receipt] = out.transactions;
  assert.equal(rent.date, '2026-07-31');
  assert.equal(rent.money_out, 1250);
  assert.equal(rent.money_in, 0);
  assert.equal(rent.balance, 8750);
  assert.equal(receipt.date, '2026-08-01');
  assert.equal(receipt.money_in, 2000);
  assert.equal(receipt.money_out, 0);
  assert.equal(receipt.balance, 10750);
  for (const tx of out.transactions) { assert.equal(tx.account_currency, 'GBP'); assert.equal(tx.ledger_currency, 'GBP'); assert.equal(tx.ledger_conversion_status, 'native'); }
});
test('UK fixture corpus carries pound glyphs, negative amounts and DD/MM dates', () => { const monzo = fixture('monzo-statement.csv').toString(); assert.match(monzo, /-£42\.50/); assert.match(monzo, /30\/07\/2026/); assert.equal(normalizeIsoOrDayFirstDate('31/07/2026'), '2026-07-31'); for (const name of ['receipt-gbp.json', 'supplier-invoice-gbp.json']) assert.equal(JSON.parse(fixture(name)).currency, 'GBP'); });
test('synthetic Monzo-shaped statement behaviorally pins dates, directions, amounts, and GBP stamps', async () => {
  const csv = fixture('monzo-statement.csv');
  const out = await extractBankStatementFromBase64({ base64: csv.toString('base64'), filename: 'monzo-2026.csv', mimeType: 'text/csv', ledgerCurrency: 'GBP' });
  assert.equal(out.transactions.length, 2);
  assert.deepEqual(out.transactions.map(({ date, money_in, money_out }) => ({ date, money_in, money_out })), [
    { date: '2026-07-30', money_in: 0, money_out: 42.5 },
    { date: '2026-07-31', money_in: 500, money_out: 0 }
  ]);
  for (const transaction of out.transactions) {
    assert.equal(transaction.account_currency, 'GBP');
    assert.equal(transaction.ledger_currency, 'GBP');
    assert.equal(transaction.ledger_conversion_status, 'native');
  }
});
test('textual month dates remain honestly unsupported by the consolidated primitive', () => {
  assert.equal(normalizeIsoOrDayFirstDate('31 July 2026'), null);
  assert.equal(normalizeIsoOrDayFirstDate('31 Jul 2026'), null);
});
test('unified extractor prompt carries GB context and preserves the model GBP verdict', async () => { let body; const raw = { document_type: 'supplier_bill', extraction_status: 'validated', extraction_confidence: 0.9, warnings: [], source_business_use: { classification: 'not_stated', source_quote: null, business_use_percent: null }, header: { counterparty_name: 'Synthetic Hosting Ltd', counterparty_role: 'vendor', counterparty_tax_id: null, own_name: null, own_tax_id: null, document_date: '2026-07-30', due_date: null, currency: 'GBP', subtotal_amount: 42.5, tax_amount: 0, shipping_amount: 0, discount_amount: 0, rounding_amount: 0, total_amount: 42.5, line_amounts_include_tax: false, payment_status: 'unpaid', payment_terms: null, references: [] }, lines: [], settlement: { period_start: null, period_end: null, payout_date: null, gross_sales: null, gross_components: [], refunds: null, fees: [], adjustments: [], net_payout: null, transaction_count: null, payout_reference: null, deposit_reference: null, bank_last4: null, rows: [] }, contract: { contract_type: 'not_a_contract', effective_start_date: null, effective_end_date: null, auto_renew: null, notice_period_days: null, recurring_amount: null, recurring_frequency: 'none', obligations: [] } }; const out = await extractUnified({ base64: 'WA==', filename: 'synthetic-gbp.pdf', mimeType: 'application/pdf', apiKey: 'test', dateFormatHint: 'GB context: GBP book using DD/MM/YYYY dates.', clientIdentity: { display_name: 'Synthetic UK Ltd' }, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ model: 'test-model', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: body.tools?.[0]?.name, input: raw }] }) }; } }); const prompt = body.messages[0].content[1].text; assert.match(prompt, /GB context: GBP/); assert.match(prompt, /Synthetic UK Ltd/); assert.equal(out.header.currency, 'GBP'); });
