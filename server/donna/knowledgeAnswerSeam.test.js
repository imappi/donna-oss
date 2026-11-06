import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeGrounding, knowledgeAnswerSeamSurfaces } from './knowledgeAnswerSeam.js';

// The flag snapshot that makes KNOWLEDGE_BASE_RETRIEVAL act. Born off: with no
// snapshot the seam is a no-op, which is the whole default.
const FLAG_ON = { KNOWLEDGE_BASE_RETRIEVAL: { stage: 'auto' } };
const GB_PROFILE = { jurisdiction: 'GB', entity_type: 'gb-ltd' };
const emptyLoader = async () => [];

test('flag OFF (no snapshot) returns null — the owner turn is byte-identical', async () => {
  const result = await buildKnowledgeGrounding({
    client: {},
    clientId: 'c1',
    clientProfile: GB_PROFILE,
    questionText: 'is a client lunch deductible?',
    surface: 'client_portal',
    deps: { loadKnowledgeCandidates: emptyLoader }
  });
  assert.equal(result, null);
});

test('an unknown surface never grounds', async () => {
  const result = await buildKnowledgeGrounding({
    client: {},
    clientProfile: GB_PROFILE,
    questionText: 'anything',
    surface: 'ledger_posting',
    configSnapshot: FLAG_ON,
    deps: { loadKnowledgeCandidates: emptyLoader }
  });
  assert.equal(result, null);
});

test('an empty question is skipped, even with the flag on', async () => {
  const result = await buildKnowledgeGrounding({
    client: {},
    clientProfile: GB_PROFILE,
    questionText: '   ',
    surface: 'client_portal',
    configSnapshot: FLAG_ON,
    deps: { loadKnowledgeCandidates: emptyLoader }
  });
  assert.equal(result, null);
});

test('flag ON with an EMPTY corpus is the deterministic refusal (outcome 4), not a break', async () => {
  const result = await buildKnowledgeGrounding({
    client: {},
    clientId: 'c1',
    clientProfile: GB_PROFILE,
    questionText: 'is a client lunch deductible?',
    surface: 'client_portal',
    configSnapshot: FLAG_ON,
    deps: { loadKnowledgeCandidates: emptyLoader }
  });
  assert.ok(result, 'flag on must return a grounding object, never null');
  assert.equal(result.outcome, 'refusal', 'an empty corpus can only honestly refuse');
  assert.equal(result.surface, 'client_portal');
  assert.equal(result.capability, 'knowledge.retrieve.v1');
  assert.ok(result.receipt, 'the answer must carry a receipt');
});

test('an unresolved jurisdiction refuses rather than answering across markets', async () => {
  const result = await buildKnowledgeGrounding({
    client: {},
    clientId: 'c1',
    clientProfile: { entity_type: 'gb-ltd' }, // no jurisdiction
    questionText: 'is a client lunch deductible?',
    surface: 'client_portal',
    configSnapshot: FLAG_ON,
    deps: { loadKnowledgeCandidates: emptyLoader }
  });
  assert.ok(result);
  assert.equal(result.outcome, 'refusal');
});

test('a loader failure fails safe to a refusal, never a thrown owner turn', async () => {
  const throwingLoader = async () => { throw new Error('store down'); };
  const result = await buildKnowledgeGrounding({
    client: {},
    clientId: 'c1',
    clientProfile: GB_PROFILE,
    questionText: 'is a client lunch deductible?',
    surface: 'client_portal',
    configSnapshot: FLAG_ON,
    deps: { loadKnowledgeCandidates: throwingLoader }
  });
  // retrieveKnowledge catches the store failure and refuses; the seam renders it.
  assert.ok(result);
  assert.equal(result.outcome, 'refusal');
});

test('both owner surfaces are enumerated (a surface not listed cannot ground)', () => {
  const surfaces = knowledgeAnswerSeamSurfaces();
  assert.deepEqual([...surfaces].sort(), ['client_portal', 'owner_channel']);
});

test('the answering model id is recorded, not inferred — null when no model composed', async () => {
  const result = await buildKnowledgeGrounding({
    client: {},
    clientId: 'c1',
    clientProfile: GB_PROFILE,
    questionText: 'is a client lunch deductible?',
    surface: 'client_portal',
    configSnapshot: FLAG_ON,
    modelId: null,
    deps: { loadKnowledgeCandidates: emptyLoader }
  });
  assert.ok(result);
  // model_id travels on the retrieval receipt; here no model answered, so it is
  // null rather than a code-default guess (CLAUDE.md: the model id is a receipt).
  assert.equal(result.receipt?.model_id ?? null, null);
});
