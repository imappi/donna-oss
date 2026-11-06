import test from 'node:test';
import assert from 'node:assert/strict';
import { jevDispositionEnabled, jevDispositionPlans, loadJevDispositionEvidence } from './jevDisposition.js';
import { proposeBankLineDisposition, runBankLineDispositionForTransaction } from './bankLineDispositionLlm.js';
import { proposeDocumentDisposition, runOwnerReplyRedisposition } from './documentDispositionLlm.js';

const document = { id: 'doc-1', document_type: 'receipt', total_amount: 30, currency: 'USD', vendor_name: 'Business Supplies', document_date: '2026-09-01', parse_summary: { payment_method: 'cash' } };
const transaction = { id: 'tx-1', money_out: 30, money_in: 0, currency: 'USD', description: 'Business Supplies', transaction_date: '2026-09-01' };
const firmContext = { localEvidence: { bounded: false, incomplete: false, documents: [] } };
function configure(t) {
  for (const [key, value] of Object.entries({ TYPESAFE_API_KEY: 'test-only', TYPESAFE_MODEL: 'jev-test', DISPOSITION_MATERIALITY_CEILING: '500' })) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}
function fetchChoice(choice, calls, { malformed = false, strong } = {}) {
  return async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (!url.includes('typesafe')) return { ok: true, status: 200, json: async () => ({ model: 'strong-served', content: [{ text: JSON.stringify(strong) }] }) };
    const criteria = body.questions.disposition.criteria;
    assert.ok(choice in criteria, `${choice} must be executable`);
    const probabilities = Object.fromEntries(Object.keys(criteria).map(k => [k, k === choice ? 0.36 : 0.64 / (Object.keys(criteria).length - 1)]));
    return { ok: true, status: 200, json: async () => malformed ? {} : ({ model: 'jev-served', usage: { input_tokens: 10, output_tokens: 5 }, answers: { disposition: { type: 'choice', choice, probabilities, confidence: 0.99 } } }) };
  };
}
function mockClient(responses = []) {
  const calls = []; const reserved = [...responses];
  return { calls, async query(sql, params) {
    calls.push({ sql: String(sql), params });
    const index = reserved.findIndex(r => String(sql).includes(r.match));
    if (index < 0) {
      if(String(sql).includes('from clients'))return {rows:[{id:'client',company_name:'Test Company'}]};
      if(String(sql).includes('to_regclass'))return {rows:[{present:true}]};
      if(String(sql).includes('from firm_members'))return {rows:[{id:'member'}]};
      if(String(sql).includes('from model_lane_policy'))return {rows:[{id:'policy',client_id:'client',lane:'jev_reconciliation',deciding_model:'jev-test',basis:'experiment',reason:JSON.stringify({version:'jev-local-experiment-v1',firm_id:'firm',client_id:'client',actor_id:'member',authority_basis:'test',expires_at:'2099-01-01',outbound_sends:false,probability_floor:null})}]};
      if(String(sql).includes('select * from transactions'))return {rows:[{...transaction,firm_id:'firm',client_id:'client'}]};
      if(String(sql).includes('from documents where') && String(sql).includes('id=$3'))return {rows:[{...document,firm_id:'firm',client_id:'client'}]};
      return {rows:[],rowCount:0};
    }
    const [found] = reserved.splice(index, 1);
    return { rows: found.rows, rowCount: found.rows.length };
  } };
}

test('routing failure is loud; inventory incompleteness is explicit; material actions respect authority', async () => {
  await assert.rejects(jevDispositionEnabled({ query: async () => { throw new Error('config unavailable'); } }, 'firm', 'client'), /config unavailable/);
  const inventory = await loadJevDispositionEvidence({query:async sql=>({rows:sql.includes('from clients')?[{id:'client'}]:sql.includes('from documents')?[{id:'d',parse_status:'processing',parse_summary:{text:'x'.repeat(1900)}}]:[]})},'firm','client');
  assert.equal(inventory.coverage.unread_sources.length,1);
  assert.equal(inventory.documents[0].parse_summary.text.length,1900,'source accounting text is no longer clipped at 1800 characters');
  const plans = jevDispositionPlans({ kind: 'document', amount: 1000, materialityCeiling: 500 });
  assert.equal(plans.resolve_cash, undefined);
  assert.equal(plans.resolve_immaterial, undefined);
  assert.ok(jevDispositionPlans({ kind: 'document', amount: 1000, materialityCeiling: 500, ownerReply: { answeredEvidenceType: 'payment_method' } }).resolve_cash);
});

test('Jev terminal selections keep raw probability and bypass the old semantic floor without strong calls', async t => {
  configure(t);
  const calls = [];
  const doc = await proposeDocumentDisposition({ document, firmContext, jevEnabled: true, fetchImpl: fetchChoice('resolve_cash', calls) });
  assert.equal(doc.disposition, 'auto_explain');
  assert.equal(doc.confidence, 0.36);
  assert.equal(doc.model, 'jev-served');
  assert.equal(doc.jev_first.handed_off, false);
  const bank = await proposeBankLineDisposition({ transaction, firmContext, jevEnabled: true, fetchImpl: fetchChoice('ask_receipt', calls) });
  assert.equal(bank.disposition, 'chase_receipt');
  assert.equal(bank.confidence, 0.36);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.url.includes('typesafe')));
});

test('only explicit needs_reasoning dispatches strong; it receives the same local material and receipts both decisions', async t => {
  configure(t); const calls = [];
  const local = { bounded: false, documents: [{ filename: 'voucher.pdf', extracted_summary: 'Dividend voucher for this transfer' }] };
  const result = await proposeBankLineDisposition({ transaction, firmContext: { localEvidence: local }, jevEnabled: true, apiKey: 'test-strong',
    fetchImpl: fetchChoice('needs_reasoning', calls, { strong: { disposition: 'chase_receipt', materiality: 'material', expense_kind: 'business_expense', line_identified: true, confidence: 0.88, reasoning: 'Specific receipt is missing.' } }) });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('typesafe'));
  assert.ok(!calls[1].url.includes('typesafe'));
  assert.ok(JSON.stringify(calls[1].body).includes('voucher.pdf'));
  assert.equal(result.decision_engine, 'jev_then_reasoning');
  assert.equal(result.jev_first.selected, 'needs_reasoning');
  assert.equal(result.jev_first.probability, 0.36);
  assert.equal(result.model, 'strong-served');
});

test('malformed Jev output never calls strong or stamps a bank judgment', async t => {
  configure(t); const calls = [];
  const client = mockClient([{ match: 'select id, firm_id', rows: [transaction] }]);
  const result = await runBankLineDispositionForTransaction({ client, firmId: 'firm', clientId: 'client', transactionId: transaction.id, jevEnabled: true, apiKeyOverride: 'test-strong', fetchImpl: fetchChoice('ask_receipt', calls, { malformed: true }) });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'transport_failure');
  assert.equal(calls.length, 1);
  assert.ok(!client.calls.some(c => /insert into reconciliation_evaluations|update transactions|insert into client_evidence_requests/.test(c.sql)));
});

test('owner reply is first read by Jev; confirmed cash settles through existing writer and preserves its receipt', async t => {
  configure(t); const calls = [];
  const client = mockClient([
    { match: 'from documents d', rows: [{ ...document, total_amount: 1200 }] },
    { match: "payload->'no_line_disposition' as before_state", rows: [{ before_state: null }] },
    { match: 'update documents', rows: [{ id: document.id }] },
    { match: 'update client_evidence_requests', rows: [{ id: 'ask-1' }] }
  ]);
  const result = await runOwnerReplyRedisposition({ client, firmId: 'firm', clientId: 'client', documentId: document.id, evidenceRequestId: 'ask-1', answeredEvidenceType: 'payment_method', askedQuestion: 'How was this paid?', ownerReply: 'I paid cash personally.', jevEnabled: true, apiKeyOverride: '', fetchImpl: fetchChoice('resolve_cash', calls) });
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(calls[0].body).includes('I paid cash personally.'));
  assert.equal(result.disposition, 'auto_explain');
  assert.equal(result.stamped, true);
  assert.equal(result.request_resolved, true);
  const evaluation = client.calls.find(c => c.sql.includes('insert into reconciliation_evaluations'));
  assert.ok(evaluation);
  assert.ok(JSON.stringify(evaluation.params).includes('jev-served'));
  assert.ok(JSON.stringify(evaluation.params).includes('0.36'));
  assert.ok(JSON.stringify(evaluation.params).includes('jev_first'));
});
