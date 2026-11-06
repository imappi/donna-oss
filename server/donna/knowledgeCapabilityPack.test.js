// Donna — K1-4: the knowledge.*.v1 pack.
//
// The pack declares its capability id and eval scenario ids as LITERALS because
// importing the strategy from a registry pack would put a K1 module on the
// import graph of every registry consumer — including the accounting-system
// adapters, which reach the ledger writers (see knowledgeCapabilityPack.js's
// header and knowledgeRetrievalBoundary.test.js). This file is where the
// literals are pinned back to the constants they mirror: a test may import both
// without creating a runtime edge, so the drift risk that duplication buys is
// paid for here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { knowledgeCapabilityPack } from './knowledgeCapabilityPack.js';
import { buildCapabilityRegistry, findCapability, CAPABILITY_REGISTRY } from './capabilityRegistry.js';
import {
  KNOWLEDGE_RETRIEVAL_CAPABILITY_ID,
  listKnowledgeRetrievalPurposeIds,
  retrieveKnowledge
} from './knowledgeRetrieval.js';

const entry = () => knowledgeCapabilityPack()[0];

test('the declared literals match the strategy\'s constants', () => {
  assert.equal(entry().capability, KNOWLEDGE_RETRIEVAL_CAPABILITY_ID,
    'the pack literal and the strategy constant have drifted — that is the cost this test exists to pay');
  assert.deepEqual(
    [...entry().eval_scenarios].sort(),
    listKnowledgeRetrievalPurposeIds().map((p) => `knowledge_${p}`).sort(),
    'the eval scenario ids are derived from the purposes; a new purpose needs one here too'
  );
});

test('the named executor exists and is the strategy\'s entry point', () => {
  assert.equal(entry().executor, 'retrieveKnowledge');
  assert.equal(typeof retrieveKnowledge, 'function');
});

test('the pack passes the registry lint and joins the assembled registry', () => {
  assert.doesNotThrow(() => buildCapabilityRegistry([knowledgeCapabilityPack()]));
  const registered = findCapability('knowledge.retrieve.v1', CAPABILITY_REGISTRY);
  assert.ok(registered, 'knowledge.retrieve.v1 is not in the assembled registry');
  assert.equal(registered.access, 'read');
  assert.equal(registered.side_effect_class, 'none');
});

test('the capability declares no authority and no write', () => {
  const e = entry();
  // §2, GROUND vs GOVERN: a knowledge answer is never an authorization.
  assert.equal(e.access, 'read');
  assert.equal(e.side_effect_class, 'none');
  assert.equal(e.reversibility, null);
  assert.equal(e.authority_requirements.grant_required, 'none');
  assert.equal(e.authority_requirements.required_capability_class, 'viewer');
});

test('there is deliberately no knowledge WRITE capability', () => {
  // Curation is a human act run against a reviewed corpus (§8), not something
  // the runtime may invoke — "a model-generated knowledge base is a laundering
  // machine". Registering the curation writers would make them look callable.
  assert.deepEqual(knowledgeCapabilityPack().map((c) => c.capability), ['knowledge.retrieve.v1']);
  assert.equal(knowledgeCapabilityPack().filter((c) => c.access === 'write').length, 0);
});

test('data access is public — the divergence from memory.retrieve.v2 is deliberate', () => {
  const knowledge = entry();
  const memory = findCapability('memory.retrieve.v2', CAPABILITY_REGISTRY);
  assert.equal(knowledge.data_access_class, 'public');
  assert.equal(memory.data_access_class, 'restricted');
  assert.equal(memory.risk_class, 'high');
  assert.equal(knowledge.risk_class, 'medium',
    'K1 reads no tenant data, so the confidentiality risk is absent — but grounding a tax '
    + 'answer someone acts on is not low risk either');
});

test('the capability is uncalled — K1-4 ships without wiring', () => {
  assert.deepEqual(entry().legacy_entrypoint_bindings.surfaces, [],
    'the four-outcome answer contract that calls this is K1-5');
});
