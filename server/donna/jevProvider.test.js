import test from 'node:test';
import assert from 'node:assert/strict';
import { callJevDirect, callJevTyped, readJevAnswers } from './jevProvider.js';
import { prepareEvidencePacketFromEligibility } from '../../scripts/jev_evidence_action_contract.js';
import { loadCorpus, stateWithFacts, validateAtomicResponse } from '../../scripts/jev_decision_plane_protocol.js';
import { generateMenu, directRequest } from '../../scripts/jev_direct_action.js';

const packet = loadCorpus('jev-plane-direct')[0].packet;
const prepared = prepareEvidencePacketFromEligibility(packet, packet.transactions.map(t => t.id));

test('preview uses the tested complete-plan request, retains selection, and calls only once', async () => {
  const menu = generateMenu(prepared);
  const request = directRequest(prepared, 'test-model', stateWithFacts(prepared), menu);
  const selected = menu.plans.find(p => p.terminal === 'resolve');
  const answers = Object.fromEntries(Object.entries(request.questions).map(([key, q]) => [key, q.type === 'noul'
    ? { type: 'noul', noul: 0.8 }
    : { type: 'choice', choice: selected.id, confidence: 0.9,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(id => [id, id === selected.id ? 1 : 0])) }]));
  const raw = { model: 'served-test-model', usage: { input_tokens: 20, output_tokens: 10 }, answers };
  assert.deepEqual(readJevAnswers(raw, request.questions), validateAtomicResponse(raw, request.questions, 'typesafe').answers);
  let calls = 0;
  const result = await callJevDirect(prepared, { model: 'test-model', apiKey: 'test-key', fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(init.body), request);
    return new Response(JSON.stringify(raw), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.decision.direct.selected, selected.id);
  assert.equal(result.model, raw.model);
  assert.equal(result.decision.direct.validation.accepted, true);
  assert.doesNotMatch(JSON.stringify(result), /test-key/);
});

test('missing configuration and malformed responses never become decisions', async () => {
  let called = false;
  await assert.rejects(callJevDirect(prepared, { model: '', apiKey: '', fetchImpl: async () => { called = true; } }), /jev_not_configured/);
  assert.equal(called, false);
  assert.throws(() => readJevAnswers({ model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers: {} }, { plan: { type: 'choice', criteria: { a: '', b: '' } } }), /jev_invalid_response/);
  const body = { model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers: { plan: { type: 'choice', confidence: 1, choice: 'a', probabilities: { a: 0.1, b: 0.9 } } } };
  assert.throws(() => readJevAnswers(body, { plan: { type: 'choice', criteria: { a: '', b: '' } } }), /jev_invalid_response/);
});

test('live preparation rejects foreign eligibility and leaves the source packet untouched', () => {
  const before = JSON.stringify(packet);
  assert.equal(prepareEvidencePacketFromEligibility(packet, ['foreign-row']).error, 'invalid_eligible_members');
  assert.equal(JSON.stringify(packet), before);
  assert.equal(prepared.error, undefined);
});


test('typed provider failures cannot masquerade as a bookkeeping decision', async () => {
  const request = { model: 'test-model', questions: { plan: { type: 'choice', criteria: { a: '', b: '' } } } };
  await assert.rejects(callJevTyped(request, { apiKey: '' }), error => error.providerFailure === true && error.code === 'PROVIDER_KEY_MISSING');
  for (const [status, body, code] of [
    [400, { detail: { error_type: 'max_tokens_exceeded' } }, 'PROVIDER_REJECTED_REQUEST'],
    [200, {}, 'PROVIDER_INVALID_OUTPUT']
  ]) {
    let calls = 0;
    await assert.rejects(callJevTyped(request, { apiKey: 'test-key', fetchImpl: async () => {
      calls++; return new Response(JSON.stringify(body), { status });
    } }), error => error.providerFailure === true && error.code === code);
    assert.equal(calls, 1);
  }
});


test('TypeSafe string rejection detail survives the typed failure receipt', async () => {
  const request = {model:'test-model',questions:{plan:{type:'choice',criteria:{a:'a',b:'b'}}}};
  await assert.rejects(callJevTyped(request, {apiKey:'test-key',fetchImpl:async () => new Response(JSON.stringify({detail:'Too many choices. Must have at most 255 choices.'}),{status:400})}), error => error.code === 'PROVIDER_REJECTED_REQUEST' && error.message.includes('at most 255 choices'));
});
