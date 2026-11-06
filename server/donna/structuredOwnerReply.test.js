import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStructuredOwnerReplyAdapter, listStructuredOwnerReplyEvidenceTypes, supportsStructuredOwnerReply } from './statutoryRegistry.js';
import { interpretOwnerReply, validateOwnerReplyInterpretation, OWNER_REPLY_CONFIDENCE_FLOOR } from './ownerReplyInterpreter.js';
const adapter = resolveStructuredOwnerReplyAdapter({ jurisdiction: 'ae', evidenceType: 'vat_registration_status' });
const input = { answer: { registered: false }, confidence: 0.99, clarification: null };
test('country registration owns its answer contract without a fallback country', () => {
  const evidenceTypes = ['vat_registration_status', 'ct_registration_status',
    'ct_registration_deadline', 'vat_return_period_intake', 'ae_vat_business_use'];
  // The one market-neutral lane (FI-03) lists under its lane-qualified key.
  assert.deepEqual(listStructuredOwnerReplyEvidenceTypes(), [...evidenceTypes, 'supporting_document#totals_mismatch']);
  for (const evidenceType of evidenceTypes) {
    assert.ok(resolveStructuredOwnerReplyAdapter({ jurisdiction: 'ae', evidenceType }));
    assert.equal(resolveStructuredOwnerReplyAdapter({ evidenceType }), null);
    assert.equal(resolveStructuredOwnerReplyAdapter({ jurisdiction: 'gb', evidenceType }), null);
  }
  assert.equal(resolveStructuredOwnerReplyAdapter({ jurisdiction: 'ae', evidenceType: 'statement_overlap' }), null);
});
test('a lane adapter claims only its own lane, never its generic evidence type, in every jurisdiction', () => {
  const totals = { evidence_type: 'supporting_document', transaction_id: null, request_payload: { lane: 'totals_mismatch', document_id: 'doc-1' } };
  for (const jurisdiction of ['fi', 'gb', 'ae', 'sg', 'us']) {
    assert.equal(resolveStructuredOwnerReplyAdapter({ jurisdiction, evidenceType: 'supporting_document', request: totals })?.lane, 'totals_mismatch');
  }
  assert.equal(supportsStructuredOwnerReply(totals), true);
  for (const other of [{ ...totals, request_payload: {} }, { ...totals, request_payload: { lane: 'owner_reply_clarification' } },
    { ...totals, transaction_id: 'tx-1' }, { ...totals, evidence_type: 'payment_method' }]) {
    assert.equal(supportsStructuredOwnerReply(other), false);
    assert.equal(resolveStructuredOwnerReplyAdapter({ jurisdiction: 'fi', evidenceType: other.evidence_type, request: other }), null);
  }
  const lane = resolveStructuredOwnerReplyAdapter({ jurisdiction: 'fi', evidenceType: 'supporting_document', request: totals });
  assert.equal(lane.validateAnswer({ printed_total_confirmed: true, explanation: 'The coffee line is misprinted.' }), true);
  for (const bad of [{ printed_total_confirmed: false, explanation: 'x' }, { printed_total_confirmed: true, explanation: '' },
    { printed_total_confirmed: true, explanation: 'x', total: 35.3 }, null]) assert.equal(lane.validateAnswer(bad), false);
});
test('strict envelope and country schema refuse unknown keys, fabricated authority and impossible dates', () => {
  assert.equal(validateOwnerReplyInterpretation(input, adapter).needsClarification, false);
  for (const bad of [{ ...input, post: true }, { ...input, confidence: '0.99' }, { ...input, confidence: 2 },
    { ...input, answer: { registered: false, authority: 'file' } }, { ...input, answer: { registered: true } },
    { ...input, answer: { registered: true, trn: '100123456789012', registered_from: '2026-02-30', periods: [] } },
    { ...input, confidence: 0.2 }, { ...input, confidence: 0.2, clarification: 'What is the effective date?' }]) {
    assert.throws(() => validateOwnerReplyInterpretation(bad, adapter), { code: 'OWNER_REPLY_INTERPRETATION_INVALID' });
  }
  assert.equal(validateOwnerReplyInterpretation({ answer: null, confidence: OWNER_REPLY_CONFIDENCE_FLOOR - 0.01,
    clarification: 'What is the effective registration date?' }, adapter).needsClarification, true);
});
test('shared envelope requires actual served strong model and completed exact tool; no configured-model receipt fallback', async () => {
  const request = { id: 'request' };
  const call = payload => interpretOwnerReply({ request, adapter, context: { reply: 'Not registered' },
    env: { ANTHROPIC_API_KEY: 'fixture' }, fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }) });
  const payload = { model: 'recorded-strong-response', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'interpret_owner_reply', input }] };
  assert.equal((await call(payload)).model, payload.model);
  for (const bad of [{ ...payload, model: undefined }, { ...payload, model: 'recorded-nano-response' },
    { ...payload, stop_reason: 'max_tokens' }, { ...payload, content: [...payload.content, ...payload.content] },
    { ...payload, content: [{ ...payload.content[0], name: 'post_journal' }] }]) {
    await assert.rejects(call(bad), { code: 'OWNER_REPLY_INTERPRETATION_INVALID' });
  }
  let calls = 0;
  await assert.rejects(interpretOwnerReply({ request, adapter, context: {}, env: { ANTHROPIC_API_KEY: 'fixture', TRANSACTION_CHAT_MODEL: 'recorded-nano' },
    fetchImpl: async () => { calls++; } }), { code: 'OWNER_REPLY_INTERPRETATION_INVALID' });
  assert.equal(calls, 0);
});
