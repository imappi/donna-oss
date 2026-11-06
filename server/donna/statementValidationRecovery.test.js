import assert from 'node:assert/strict';
import test from 'node:test';
import { __test__extractDocument } from './inngest/parseDocument.js';
import { categorizeError, withRetryOwner } from './inngest/parseErrors.js';
import { extractStructuredFromStatementText } from './bankStatementVision.js';
import { buildClientPortalChatContext } from './clientPortalChat.js';
import { fiPdf } from './testSupport/fiReliabilitySources.js';

const row = (amount, description = 'Synthetic service') => ({ date: '2026-05-04',
  description, counterparty: description, direction: 'out', amount, currency: 'EUR', balance: null });
const summary = { opening_balance: 1000, closing_balance: 372.6, total_deposits: 0,
  total_payouts: 627.4, currency: 'EUR', period_start: '2026-05-04', period_end: '2026-05-04' };
const correct = { transactions: [row(27.4, 'Synthetic cafe'), row(300), row(300)], statement_summary: summary };
const bad = { transactions: [row(127.4, 'Synthetic cafe'), row(300)], statement_summary: summary };
const response = (payload) => ({ ok: true, json: async () => ({ output: [{ content: [{ text: JSON.stringify(payload) }] }] }) });
const source = () => fiPdf(['TILIOTE EUR', 'Alkusaldo 1000,00',
  '04.05.2026 Synthetic cafe 1 27,40-', '04.05.2026 Synthetic service 2 300,00-',
  '04.05.2026 Synthetic service 3 300,00-', 'Loppusaldo 372,60']);
const extract = async () => __test__extractDocument({
  document: { id: 'source-document', client_id: 'synthetic-client', document_type: 'bank_statement',
    filename: 'statement.pdf', payload: { mime_type: 'application/pdf' } },
  bytes: await source(), ledgerCurrency: 'EUR', log: console,
  configSnapshot: { BANK_STATEMENT_LLM_EXTRACTION: { stage: 'auto' } }
});
const mockProvider = async (fn, run) => {
  const priorFetch = globalThis.fetch; const priorEnv = { ...process.env };
  process.env.OPENAI_API_KEY = 'test-key'; process.env.OPENAI_VISION_CACHE_DISABLED = 'true';
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = priorFetch; process.env = priorEnv; }
};

test('real worker extraction recovers bad text from original PDF and retains equal payments', async () => {
  const requests = [];
  await mockProvider(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    return response(request.input[0].content.some(part => part.type === 'input_file') ? correct : bad);
  }, async () => {
    const result = await extract();
    assert.equal(result.kind, 'completed');
    assert.equal(result.transactions.length, 3);
    assert.deepEqual(result.transactions.map(tx => tx.money_out), [27.4, 300, 300]);
    assert.equal(new Set(result.transactions.map(tx => tx.id)).size, 3);
    assert.equal(result.summary.extraction_source, 'openai_vision_structured');
    assert.equal(result.summary.extraction_status, 'validated');
    assert.equal(requests.length, 2, 'one bounded PDF recovery');
  });
});

test('validated text avoids PDF spend and never collapses equal source rows', async () => {
  let calls = 0;
  await mockProvider(async () => { calls++; return response(correct); }, async () => {
    const result = await extract();
    assert.equal(result.transactions.length, 3);
    assert.equal(calls, 1);
    assert.equal(result.summary.extraction_source, 'openai_text_structured');
  });
});

test('rejected PDF recovery remains a typed retryable failure with no imported lines', async () => {
  let calls = 0;
  await mockProvider(async () => { calls++; return response(bad); }, async () => {
    await assert.rejects(extract(), error => {
      const receipt = categorizeError(error);
      assert.equal(receipt.code, 'STATEMENT_VALIDATION_FAILED');
      assert.equal(receipt.retryable, true);
      assert.match(receipt.safe_user_message, /did not match its balances/);
      assert.doesNotMatch(receipt.safe_user_message, /Retrying shortly/);
      assert.match(withRetryOwner(receipt, 'queue').safe_user_message, /Retrying shortly/);
      return true;
    });
    assert.equal(calls, 2);
  });
});

test('new extraction reads cannot replay old lossy cache entries', async () => {
  const requests = [];
  await mockProvider(async (url, init) => {
    requests.push(String(url));
    if (init.method === 'GET') return { ok: false, status: 404 };
    if (String(url).includes('/storage/')) return { ok: true };
    return response(correct);
  }, async () => {
    delete process.env.OPENAI_VISION_CACHE_DISABLED;
    process.env.SUPABASE_URL = 'https://example.invalid'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    const result = await extractStructuredFromStatementText({ text: 'Synthetic statement source' });
    assert.equal(result.transactions.length, 3);
    const storage = requests.filter(url => url.includes('/storage/'));
    assert.equal(storage.length, 2);
    assert.ok(storage.every(url => url.includes('/source-rows-v2/')));
  });
});

test('owner chat receives validation and duplicate reasons, not only skipped status', () => {
  const context = buildClientPortalChatContext({ documents: [
    { id: 'original', parse_status: 'skipped', parse_summary: { reason: 'no_transactions_detected',
      extraction_status: 'needs_review', candidate_transaction_count: 35 } },
    { id: 'duplicate', parse_status: 'skipped', duplicate_of: 'original',
      parse_summary: { reason: 'duplicate_auto_collapsed' } },
    { id: 'failed', parse_status: 'failed', parse_error: { code: 'STATEMENT_VALIDATION_FAILED', retry_owner: 'manual' } }
  ] });
  assert.equal(context.documents[0].parse_issue.extraction_status, 'needs_review');
  assert.equal(context.documents[0].parse_issue.candidate_transaction_count, 35);
  assert.equal(context.documents[1].parse_issue.duplicate_of, 'original');
  assert.equal(context.documents[2].parse_issue.retry_owner, 'manual');
});


test('empty PDF recovery cannot turn a balance failure into a successful skip', async () => {
  let calls = 0;
  await mockProvider(async () => response(++calls === 1 ? bad : { transactions: [], statement_summary: null }), async () => {
    await assert.rejects(extract(), error => error.parseErrorCode === 'STATEMENT_VALIDATION_FAILED');
    assert.equal(calls, 2);
  });
});
