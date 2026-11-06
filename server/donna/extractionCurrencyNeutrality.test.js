import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { extractionContextFromClient } from './extractionContextDb.js';
import { __test__extractDocument } from './inngest/parseDocument.js';
import { extractBankStatementFromBase64 } from './bankStatement.js';
import { extractReceiptFromBase64 } from './receipt.js';
import { extractUnified } from './unifiedExtractor.js';
import { buildTransactionsFromExtractedRows, refreshTransactionDraftForClient } from '../../src/lib/firmAccounting.js';

const csv = (currency = '') => `Date,Description,Amount,Currency\n2026-01-01,Shop,-10.00,${currency}\n2026-01-02,Customer,20.00,${currency}`;
const worker = (currency, ledgerCurrency = '') => __test__extractDocument({
  document: { id: 'neutral-statement', client_id: 'neutral-client', document_type: 'bank_statement', filename: 'statement_SGD.csv', payload: { mime_type: 'text/csv' } },
  bytes: Buffer.from(csv(currency)), ledgerCurrency
});

for (const [jurisdiction, currency] of [['SG','SGD'],['FI','EUR'],['GB','GBP'],['AE','AED'],['US','USD'],['AU','AUD'],['CA','CAD']]) {
  test(`${jurisdiction}: mounted statement dispatch preserves printed currency independently of entity and filename`, async () => {
    const context = extractionContextFromClient({ jurisdiction, profile: { currency: 'CHF' } });
    const result = await worker(currency, context.ledger_currency);
    assert.equal(result.kind, 'completed');
    assert.equal(result.summary.statement_currency, currency);
    assert.equal(result.summary.ledger_currency, 'CHF');
    assert.equal(result.transactions.length, 2);
    assert.ok(result.transactions.every((tx) => tx.account_currency === currency && tx.ledger_currency === 'CHF' && tx.ledger_conversion_status === 'needs_fx_rate'));
    assert.deepEqual(result.summary.currency_resolution.filename_candidates, ['SGD']);
    assert.equal(context.jurisdiction, jurisdiction.toLowerCase());
  });
}

test('missing/conflicting entity facts stay explicit; currency never supplies a jurisdiction', () => {
  const missing = extractionContextFromClient({ profile: { currency: 'SGD' } });
  assert.equal(missing.jurisdiction, null);
  assert.equal(missing.jurisdiction_status, 'jurisdiction_unresolved');
  assert.equal(missing.ledger_currency, 'SGD');
  const conflict = extractionContextFromClient({ jurisdiction: 'FI', profile: { jurisdiction: 'SG', currency: 'EUR', accountingCurrency: 'SGD' } });
  assert.equal(conflict.jurisdiction, null);
  assert.equal(conflict.ledger_currency, '');
  assert.equal(conflict.jurisdiction_status, 'jurisdiction_context_conflict');
});

test('unknown currencies survive worker and current extracted-row normalization', async () => {
  const result = await worker('');
  assert.equal(result.kind, 'completed');
  assert.equal(result.summary.statement_currency, null);
  assert.equal(result.summary.ledger_currency, null);
  const [row] = result.transactions;
  assert.equal(row.ledger_conversion_status, '');
  const [built] = buildTransactionsFromExtractedRows({ id:'client', defaultCurrency:'SGD' }, { id:'doc', filename:'statement_SGD.csv' }, [row]);
  assert.equal(built.account_currency, '');
  assert.equal(built.ledger_currency, '');
  assert.equal(built.ledger_conversion_status, '');
  const refreshed = refreshTransactionDraftForClient(built, { defaultCurrency:'SGD' });
  assert.equal(refreshed.account_currency, '');
  assert.equal(refreshed.ledger_currency, '');
  assert.equal(refreshed.ledger_conversion_status, '');
});

test('conflicting delimited currencies retain exact movements and unresolved source candidates', async () => {
  const text = csv('EUR').replace('20.00,EUR', '20.00,USD');
  const result = await extractBankStatementFromBase64({ base64:Buffer.from(text).toString('base64'), filename:'statement_SGD.csv', mimeType:'text/csv', ledgerCurrency:'GBP' });
  assert.equal(result.statement_currency, '');
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].money_out, 10);
  assert.equal(result.transactions[1].money_in, 20);
  assert.deepEqual(result.currency_resolution.candidates, ['EUR','USD']);
  assert.ok(result.transactions.every((row) => row.ledger_conversion_status === '' && row.currency_resolution.currency === null));
});

test('real receipt request supplies resolved entity context and permits ambiguous currency', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'offline-test';
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok:true, json:async () => ({ output_text:JSON.stringify({ extraction_status:'partial', extraction_confidence:0.9, header:{ counterparty_name:'Shop', counterparty_role:'vendor', currency:null, total_amount:10 }, lines:[], warnings:['currency_unresolved'] }) }) };
  };
  try {
    for (const jurisdiction of ['SG','FI','GB','AE','US','AU','CA',null]) {
      const result = await extractReceiptFromBase64({ base64:'eA==', filename:'receipt.pdf', clientIdentity:extractionContextFromClient({ jurisdiction, company_name:'Our Entity', profile:{currency:'CHF'} }) });
      assert.equal(result.header.currency, null);
      assert.equal(result.summary.currency_resolution.source, 'unresolved');
      assert.match(request.instructions, /ENTITY CONTEXT/);
      assert.match(request.instructions, /bare dollar sign/);
      assert.doesNotMatch(request.instructions, /Singapore bookkeeping firm|infer from the symbol\/locale/);
      assert.match(request.instructions, new RegExp(`jurisdiction: ${jurisdiction?.toLowerCase() || 'unresolved'}`));
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('real unified request uses the same neutral evidence/context currency contract', async () => {
  let request;
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/recordings/unified_extraction/screwfix-receipt.json', import.meta.url), 'utf8'));
  const parsed = JSON.parse(fixture.body.content[0].text);
  parsed.header.currency = null;
  parsed.warnings = ['currency_unresolved'];
  const result = await extractUnified({ base64:'eA==', filename:'receipt.pdf', documentType:'receipt', provider:'openai', keys:{openai:'offline-test'}, clientIdentity:extractionContextFromClient({jurisdiction:'AU',profile:{currency:'AUD'}}), fetchImpl:async (_url,options) => {
    request = JSON.parse(options.body);
    return { ok:true, json:async () => ({ output_text:JSON.stringify(parsed) }) };
  } });
  assert.match(request.instructions, /bare dollar sign/);
  assert.match(JSON.stringify(request), /jurisdiction: au/);
  assert.equal(result.header?.currency, null);
});

test('currency-looking merchant words cannot select or conflict with the account currency', async () => {
  for (const prose of ['ALL SERVICES', 'TRY SHOP', 'PAYROLL SVC', 'TRANSFER TO USD ACCOUNT']) {
    const text = csv('GBP').replace('Shop', prose);
    const result = await extractBankStatementFromBase64({base64:Buffer.from(text).toString('base64'),filename:'statement.csv',mimeType:'text/csv',ledgerCurrency:'GBP'});
    assert.equal(result.statement_currency, 'GBP', prose);
    assert.equal(result.transactions.length, 2, prose);
    assert.ok(result.transactions.every((row) => row.ledger_conversion_status === 'native'));
  }
});

test('structured row currency remains candidate evidence when the account header conflicts or is absent', async () => {
  const previousFetch = globalThis.fetch;
  const saved = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_VISION_CACHE_DISABLED'].map((key) => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = 'offline-test';
  process.env.OPENAI_VISION_CACHE_DISABLED = 'true';
  try {
    for (const mode of ['conflict', 'absent']) {
      const payload = {
        transactions: [{date:'2026-09-01',counterparty:'Shop',payment_method:'CARD',description:'Shop',direction:'out',amount:10,currency:'EUR',balance:90}],
        statement_summary: {currency:mode === 'conflict' ? 'EUR' : null,opening_balance:100,closing_balance:90,total_deposits:0,total_payouts:10}
      };
      globalThis.fetch = async () => ({ok:true,json:async () => ({output_text:JSON.stringify(payload)})});
      const text = `${mode === 'conflict' ? 'Account currency GBP\n' : ''}Statement\n2026-09-01 Shop -10.00 90.00`;
      const result = await extractBankStatementFromBase64({base64:Buffer.from(text).toString('base64'),filename:`structured-${mode}.txt`,mimeType:'text/plain',ledgerCurrency:'GBP',llmFirst:true});
      assert.equal(result.extraction_source, 'openai_text_structured');
      assert.equal(result.transactions.length, 1);
      const [row] = result.transactions;
      assert.equal(row.currency, '');
      assert.equal(row.account_currency, '');
      assert.equal(row.currency_resolution.currency, null);
      assert.equal(row.currency_resolution.row_candidate, 'EUR');
      assert.equal(row.ledger_conversion_status, '');
    }
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key,value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
