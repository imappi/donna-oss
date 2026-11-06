// FIK-0a: a Jev decision's receipt proves which request bytes were sent, which
// firm facts the projection delivered, whether the fact read succeeded and the
// resolved Jev basis. Receipt-only: no request, answer or decision changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeJevTrialProvider } from './jevTrialProvider.js';
import { jevWireBody } from './jevProvider.js';
import { decideJevCoding } from './jevCoding.js';
import { suggestTransactionCoding, suggestTransactionCodingBatch, knownFactsDeliveryReceipt } from './transactionLlm.js';

const sha = body => createHash('sha256').update(body).digest('hex');
const MODEL = 'fixture-jev';
const desktop = { snapshot: { JEV_RECONCILIATION: { stage: 'auto', source: 'default' } },
  env: { DONNA_DESKTOP_BLOB_DIR: '/tmp/fixture-desktop', TYPESAFE_MODEL: MODEL } };
// The shadow hook is fire-and-forget and swallows failures; no DB is needed.
const wrap = provider => makeJevTrialProvider({ firmId: 'f', clientId: 'c', resourceType: 'transaction',
  resourceId: 't', decisionKind: 'coding', ...desktop, provider,
  withClient: async () => { throw new Error('no database in this unit test'); } });
const answer = (request, choose = () => null) => ({ model: 'served', usage: { input_tokens: 1, output_tokens: 1 },
  answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
    const keys = Object.keys(q.criteria);
    const choice = choose(key, q) || (key === 'materiality' ? keys.find(k => k === 'low') || keys[0] : keys[0]);
    return [key, { type: 'choice', choice, confidence: 0.9, probability: 0.9, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 0.9 : 0.1 / Math.max(keys.length - 1, 1)])) }];
  })) });
const request = (criteria = { settle: 'Settle it', needs_reasoning: 'Hand off' }, state = { amount: 1 }) =>
  ({ model: MODEL, state, questions: { plan: { type: 'choice', criteria, instructions: 'Choose.' } } });

const withKeys = async fn => {
  const saved = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, TYPESAFE_MODEL: process.env.TYPESAFE_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  Object.assign(process.env, { TYPESAFE_API_KEY: 'synthetic-key', TYPESAFE_MODEL: MODEL, OPENAI_API_KEY: 'synthetic-strong-key' });
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('the wrapper digests the exact body sent, for every answer, and leaves the answer untouched', async () => {
  const bodies = [];
  const inner = async (req, { fetchImpl } = {}) => {
    // What the real transport would put on the wire for this request.
    bodies.push(jevWireBody(req));
    return answer(req, key => key === 'plan' ? 'needs_reasoning' : null);
  };
  const provider = await wrap(inner);
  const first = await provider(request());
  assert.equal(first.request_sha256, sha(bodies[0]));
  assert.equal(first.jev_basis, 'desktop_default');
  assert.equal(first.answers.plan.choice, 'needs_reasoning', 'an unresolved answer is receipted too');
  assert.deepEqual(first.answers, answer(request(), key => key === 'plan' ? 'needs_reasoning' : null).answers);
  const again = await provider(request());
  assert.equal(again.request_sha256, first.request_sha256, 'deterministic for identical bytes');
  const criteriaChanged = await provider(request({ settle: 'Settle the supplied payment', needs_reasoning: 'Hand off' }));
  assert.notEqual(criteriaChanged.request_sha256, first.request_sha256, 'criteria are inside the digest, not only state');
  const stateChanged = await provider(request(undefined, { amount: 2 }));
  assert.notEqual(stateChanged.request_sha256, first.request_sha256);
});

test('the digest covers the compacted wire representation the transport actually sends', async () => {
  const large = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: `row-${i}`, text: 'x'.repeat(30) })) };
  const req = request(undefined, large);
  const wire = jevWireBody(req);
  assert.equal(typeof JSON.parse(wire).state, 'string', 'over 60 KB the state is sent as text');
  let sent;
  const provider = await wrap(async (r, { fetchImpl } = {}) => {
    // Drive the real transport so the body under test is the posted body.
    const { callJevTyped } = await import('./jevProvider.js');
    return callJevTyped(r, { apiKey: 'fixture-key', fetchImpl: async (_url, init) => {
      sent = init.body;
      return new Response(JSON.stringify(answer(r)), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  });
  const result = await provider(req);
  assert.equal(sent, wire);
  assert.equal(result.request_sha256, sha(sent));
});

test('component-question coding receipts one digest per request sent, in send order', () => withKeys(async () => {
  const lines = Array.from({ length: 7 }, (_, i) => ({ id: `l${i}`, description: `Item ${i}`, amount: 11, tax_rate: 10 }));
  const source = { document_id: 'source', document_type: 'supplier_bill', match_status: 'auto_matched', total_amount: 77, tax_amount: 7,
    parse_summary: { line_amounts_include_tax: true }, lines };
  const input = { client: { jurisdiction: 'fi' }, transaction: { money_out: 77, matched_document: source } };
  const taxes = ['ALV 14 %', 'ALV 10 %', 'Ei ALV-käsittelyä'];
  const sent = [];
  const provider = await wrap(async req => {
    sent.push(sha(jevWireBody(req)));
    return answer(req, (key) => key === 'decision' ? 'document_allocation' : key.endsWith('_decision') ? 'resolved' : key.endsWith('_tax') ? 'tax_1' : null);
  });
  const decided = await decideJevCoding({ input, transaction: input.transaction, accountOptions: ['Travel', 'Suspense'], taxOptions: taxes,
    instructions: 'Use source facts.', suspenseAccountName: 'Suspense', defaultTaxTreatment: 'Ei ALV-käsittelyä', provider });
  assert.equal(decided.receipt.action, 'document_allocation');
  assert.equal(sent.length, 3, 'one decision request and two six-component batches');
  assert.equal(decided.receipt.composition.length, 2);
  assert.deepEqual(decided.receipt.request_sha256s, sent);
  assert.equal(decided.receipt.jev_basis, 'desktop_default');
  assert.equal(decided.suggestion.jev_decision.request_sha256s, decided.receipt.request_sha256s);
}));

test('the fact receipt names delivered ids, scope and legacy label, capped like the projection', () => {
  const facts = [
    { id: 'm1', scope: 'merchant', subject: 'm', fact: 'Merchant fact', legacy_firm_scope: true },
    { id: 'm2', scope: 'merchant', subject: 'm', fact: 'Entity fact', legacy_firm_scope: false },
    { id: 'j1', scope: 'jurisdiction', subject: 'fi', fact: 'Jurisdiction fact' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, scope: 'firm', subject: 'f', fact: 'Firm fact' }))
  ];
  const receipt = knownFactsDeliveryReceipt(facts);
  assert.equal(receipt.delivered_facts.length, 24);
  assert.deepEqual(receipt.delivered_facts.slice(0, 3), [
    { id: 'm1', scope: 'merchant', legacy_firm_scope: true },
    { id: 'm2', scope: 'merchant', legacy_firm_scope: false },
    { id: 'j1', scope: 'jurisdiction', legacy_firm_scope: false }]);
  assert.equal(receipt.fact_read_status, 'ok');
  assert.deepEqual(knownFactsDeliveryReceipt([]), { delivered_facts: [], fact_read_status: 'empty' });
  assert.deepEqual(knownFactsDeliveryReceipt([], { status: 'read_failed', error: { code: '57014' } }),
    { delivered_facts: [], fact_read_status: 'read_failed', fact_read_error: { code: '57014' } });
});

const args = { clientProfile: { jurisdiction: 'sg', companyName: 'Synthetic business' },
  transaction: { id: 'coding-line', description: 'Campaign services', money_out: 80, date: '2026-09-19', account_currency: 'SGD' },
  xeroAccounts: [{ name: 'Rent' }, { name: 'Marketing' }], clientRules: [], jevEnabled: true,
  firmFacts: [{ id: 'fact-1', scope: 'merchant', subject: 'campaign services', fact: 'Campaign services is advertising.', confidence: 'high', status: 'active', legacy_firm_scope: true }] };
const chooseMarketing = (key, q) => key === 'decision' ? Object.keys(q.criteria).find(k => q.criteria[k].includes('to Marketing, tax treatment No GST;')) : null;

test('single-line coding: the prompt is unchanged, the Jev receipt carries facts, read status, digests and basis', () => withKeys(async () => {
  const states = [];
  const run = async (extra) => {
    const provider = await wrap(async req => { states.push(jevWireBody(req)); return answer(req, chooseMarketing); });
    return suggestTransactionCoding({ ...args, ...extra, transaction: { ...args.transaction, _jevProvider: provider } });
  };
  const ok = await run({});
  const failed = await run({ firmFacts: [], firmFactRead: { status: 'read_failed', error: { code: 'ECONNRESET' } } });
  const empty = await run({ firmFacts: [] });
  assert.equal(ok.proposed_account, 'Marketing');
  assert.deepEqual(JSON.parse(states[0]).state.known_facts, [{ scope: 'merchant', subject: 'campaign services',
    fact: 'Campaign services is advertising.', confidence: 'high', status: 'active' }], 'ids and labels stay out of the prompt');
  assert.deepEqual(ok.jev_decision.delivered_facts, [{ id: 'fact-1', scope: 'merchant', legacy_firm_scope: true }]);
  assert.equal(ok.jev_decision.fact_read_status, 'ok');
  assert.deepEqual(ok.jev_decision.request_sha256s, [sha(states[0])]);
  assert.equal(ok.jev_decision.jev_basis, 'desktop_default');
  // A failed read and a genuinely empty read send identical bytes and decide
  // identically; only the receipt tells them apart.
  assert.equal(states[1], states[2]);
  for (const key of ['proposed_account', 'tax_treatment', 'posting_requirement', 'evidence_required', 'confidence'])
    assert.equal(failed[key], empty[key]);
  assert.equal(failed.jev_decision.fact_read_status, 'read_failed');
  assert.deepEqual(failed.jev_decision.fact_read_error, { code: 'ECONNRESET' });
  assert.equal(empty.jev_decision.fact_read_status, 'empty');
  assert.equal(empty.jev_decision.fact_read_error, undefined);
}));

test('strong-after-Jev: the handoff receipt names the facts the strong coder was also given', () => withKeys(async () => {
  let strongInput;
  const provider = await wrap(async req => answer(req, key => key === 'decision' ? 'reasoning_judgment' : null));
  const coding = await suggestTransactionCoding({ ...args, transaction: { ...args.transaction, _jevProvider: provider },
    fetchImpl: async (_url, init) => {
      strongInput = JSON.parse(JSON.parse(init.body).input);
      return new Response(JSON.stringify({ model: 'strong', output: [{ content: [{ text: JSON.stringify({ proposed_account: 'Marketing', tax_treatment: 'No GST', confidence: 'high', evidence_required: false, posting_requirement: 'single_account', remember_candidate: false, merchant_pattern: '', auto_explain_limit: 0 }) }] }] }), { status: 200 });
    } });
  assert.equal(coding.decision_engine, 'strong_after_jev');
  assert.equal(strongInput.known_facts.length, coding.jev_handoff.delivered_facts.length);
  assert.deepEqual(coding.jev_handoff.delivered_facts, [{ id: 'fact-1', scope: 'merchant', legacy_firm_scope: true }]);
  assert.equal(coding.jev_handoff.request_sha256s.length, 1);
}));

test('batch coding forwards the pool read status to each Jev decision', () => withKeys(async () => {
  const provider = await wrap(async req => answer(req, chooseMarketing));
  const result = await suggestTransactionCodingBatch({ ...args, firmFacts: [], firmFactRead: { status: 'read_failed', error: { code: '53300' } },
    transactions: [{ ...args.transaction, _jevProvider: provider }, { ...args.transaction, id: 'second', _jevProvider: provider }] });
  assert.equal(result.suggestions.length, 2);
  assert.ok(result.suggestions.every(s => s.jev_decision.fact_read_status === 'read_failed' && s.jev_decision.request_sha256s.length === 1));
}));
