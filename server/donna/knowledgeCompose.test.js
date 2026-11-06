import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeKnowledgeAnswerWithModel,
  knowledgeComposeConfigured,
  knowledgeComposeModelId,
  __KNOWLEDGE_COMPOSE_DEFAULT_MODEL
} from './knowledgeCompose.js';

const okResponse = (input) => ({
  ok: true,
  status: 200,
  json: async () => ({ model: 'served-model', content: [{ type: 'tool_use', name: 'submit_knowledge_answer', input }] })
});

const COMPOSED = {
  outcome: 'grounded',
  answer_text: 'Yes — standard rate.',
  cited_passage_ids: ['kpsg-1'],
  named_variables: []
};

const RETRIEVAL = { receipt: { retrieval_id: 'kret-test-1', config_snapshot_id: 'cfg-9' } };

test('model id: strong default, env knob overrides', () => {
  assert.equal(knowledgeComposeModelId({}), __KNOWLEDGE_COMPOSE_DEFAULT_MODEL);
  assert.equal(knowledgeComposeModelId({ KNOWLEDGE_COMPOSE_MODEL: 'claude-test-1' }), 'claude-test-1');
});

test('unconfigured (no ANTHROPIC_API_KEY) → null, and the transport is never called', async () => {
  let calls = 0;
  const result = await composeKnowledgeAnswerWithModel({
    grounding_block: 'block', floor: 'grounded', retrieval: RETRIEVAL, questionText: 'Is this deductible?',
    env: {}, fetchImpl: async () => { calls += 1; return okResponse(COMPOSED); }
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
  assert.equal(knowledgeComposeConfigured({}), false);
});

test('empty question → null, no call (a blank query is not a knowledge question)', async () => {
  let calls = 0;
  const result = await composeKnowledgeAnswerWithModel({
    grounding_block: 'block', floor: 'grounded', retrieval: RETRIEVAL, questionText: '   ',
    env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: async () => { calls += 1; return okResponse(COMPOSED); }
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('happy path through llmCall: forced tool, floor + question + grounding block in the request, input returned verbatim', async () => {
  const seen = [];
  const result = await composeKnowledgeAnswerWithModel({
    grounding_block: '=== SOURCED KNOWLEDGE ===\npassage_id: kpsg-1',
    floor: 'grounded_with_caveat',
    retrieval: RETRIEVAL,
    questionText: 'Can I claim mileage?',
    env: { ANTHROPIC_API_KEY: 'secret-key', KNOWLEDGE_COMPOSE_MODEL: 'claude-test-2' },
    fetchImpl: async (url, options) => { seen.push({ url, options }); return okResponse(COMPOSED); }
  });
  assert.deepEqual(result, COMPOSED);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].options.headers['x-api-key'], 'secret-key');
  const body = JSON.parse(seen[0].options.body);
  assert.equal(body.model, 'claude-test-2');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_knowledge_answer' });
  assert.deepEqual(body.tools[0].input_schema.required, ['outcome', 'answer_text', 'cited_passage_ids', 'named_variables']);
  assert.match(body.system, /never upgrade|Never stronger/i);
  assert.match(body.messages[0].content, /OWNER QUESTION:\nCan I claim mileage\?/);
  assert.match(body.messages[0].content, /passage_id: kpsg-1/);
  assert.match(body.messages[0].content, /Strongest permitted outcome: grounded_with_caveat/);
});

test('failure paths all return null (the answer contract owns degradation): non-ok, no tool_use, throw, bad json', async () => {
  const env = { ANTHROPIC_API_KEY: 'k' };
  const base = { grounding_block: 'b', floor: 'grounded', retrieval: RETRIEVAL, questionText: 'q', env };
  assert.equal(await composeKnowledgeAnswerWithModel({ ...base, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), null);
  assert.equal(await composeKnowledgeAnswerWithModel({ ...base, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'prose' }] }) }) }), null);
  assert.equal(await composeKnowledgeAnswerWithModel({ ...base, fetchImpl: async () => { throw new Error('network'); } }), null);
  assert.equal(await composeKnowledgeAnswerWithModel({ ...base, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) }), null);
});

test('a missing retrieval id falls back to an anchored-but-named execution ref rather than refusing the call', async () => {
  const result = await composeKnowledgeAnswerWithModel({
    grounding_block: 'b', floor: 'grounded', retrieval: null, questionText: 'q',
    env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: async () => okResponse(COMPOSED)
  });
  assert.deepEqual(result, COMPOSED);
});
