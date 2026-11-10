import test from 'node:test';
import assert from 'node:assert/strict';
import { decideJevMaterialException, exceptionOwnerAskAllowed } from './jevMaterialException.js';
import { __writeParsedDocumentExtractionWithClient } from './parseDocumentsDb.js';

// The first-line lane decides only on a host with its provider configured
// (firstLineLane.js, 2026-11-10); these cases are about the lane deciding.
process.env.TYPESAFE_API_KEY ||= 'fixture-first-line-key';
process.env.TYPESAFE_MODEL ||= 'fixture-first-line';

const scopedClient = () => ({ query: async sql => ({ rows: sql.includes('select client_id, filename')
  ? [{ client_id: 'client-1', filename: 'receipt.pdf', document_type: 'receipt' }]
  : sql.includes('from client_capability_config') ? [{ flag_key: 'JEV_RECONCILIATION', stage: 'auto', source: 'test', client_id: 'client-1' }] : [] }) });
const base = { firmId: 'firm-1', documentId: 'doc-r', parseRunId: '00000000-0000-0000-0000-000000000101' };
const receipt = { decision_engine: 'jev', model: 'jev-served', selected: 'needs_reasoning', probability: 0.64, execution: 'reasoning_pending', representability_limit: 'corrected_extraction' };

test('exception choice distinguishes missing source from unavailable execution and preserves actual probability', async () => {
  for (const kind of ['totals_mismatch', 'statement_overlap']) {
    let request;
    const result = await decideJevMaterialException({ ...base, client: scopedClient(), kind, evidence: { printed_total: 100, extracted_sum: 90 },
      provider: async sent => { request = sent; return { model: 'jev-served', usage: {}, answers: { disposition: { choice: 'needs_reasoning', probability: 0.64, probabilities: { needs_reasoning: 0.64, ask_owner: 0.36 } } } }; } });
    assert.equal(result.execution, 'reasoning_pending');
    assert.equal(result.probability, 0.64);
    assert.equal(exceptionOwnerAskAllowed(result), false);
    assert.match(request.questions.disposition.criteria.needs_reasoning, /not represented/);
  }
});

test('provider/configuration failure cannot authorize an exception owner ask or retry with another model', async () => {
  let calls = 0;
  const result = await decideJevMaterialException({ ...base, client: scopedClient(), kind: 'totals_mismatch', provider: async () => { calls++; throw Object.assign(new Error('unavailable'), { code: 'PROVIDER_TIMEOUT' }); } });
  assert.equal(calls, 1);
  assert.equal(result.execution, 'provider_or_configuration_unavailable');
  assert.equal(exceptionOwnerAskAllowed(result), false);
  const configFailure = await decideJevMaterialException({ ...base, client: { query: async () => { throw new Error('database unavailable'); } }, kind: 'statement_overlap' });
  assert.equal(exceptionOwnerAskAllowed(configFailure), false);
});

test('totals writer stores facts and visible pending reasoning without minting an owner ask', async () => {
  const calls = []; let asks = 0; let decided = false;
  const client = { async query(sql, params) {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes('set vendor_name=$4')) return { rows: [{ id: 'doc-r', client_id: 'client-1', document_type: 'generic', parse_status: 'completed' }] };
    if (String(sql).includes('select id from document_lines')) return { rows: [{ id: 'line-1' }] };
    if (String(sql).includes('as line_count')) return { rows: [{ line_count: 1, coded_line_count: 0, review_line_count: 1 }] };
    return { rows: [] };
  } };
  const result = await __writeParsedDocumentExtractionWithClient({ ...base, client, header: { total_amount: 100, currency: 'USD' },
    summary: { warnings: ['amount_mismatch'], totals_validation: { expected: 100, line_sum: 90 } }, lines: [],
    totalsLaneDeps: { decideJevException: async () => { assert.ok(!calls.some(c => c.sql === 'begin')); decided = true; return receipt; }, mintOwnerAsk: async () => { asks++; } } });
  assert.equal(decided, true);
  assert.equal(result.handled, true);
  assert.equal(asks, 0);
  const queue = calls.find(c => c.sql.includes('insert into transaction_review_queue'));
  const payload = JSON.parse(queue.params[4]);
  assert.equal(payload.lane.reason, 'jev_needs_reasoning');
  assert.equal(payload.jev_first.model, 'jev-served');
  const final = calls.find(c => c.sql.includes('parse_summary=$3'));
  assert.equal(JSON.parse(final.params[2]).jev_exception.execution, 'reasoning_pending');
  assert.ok(calls.some(c => c.sql === 'commit'));
});
