// SG-CS — the curated high-trust knowledge registry + the FACT-vs-KNOWLEDGE
// eval seed: provenance discipline, topic routing, the self-service fork.
// node --test server/donna/singapore/csKnowledge.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SINGAPORE_CS_KNOWLEDGE_FLAG_KEY,
  SG_KNOWLEDGE_TOPICS,
  SG_KNOWLEDGE_SOURCES,
  resolveKnowledgeSource,
  knowledgeSourcesForTopic,
  SG_CS_EVAL_SEED
} from './csKnowledge.js';

test('every source carries the high-trust-and-current contract: authority, jurisdiction, as_of, trust, honesty bit', () => {
  assert.equal(SINGAPORE_CS_KNOWLEDGE_FLAG_KEY, 'SINGAPORE_CS_KNOWLEDGE');
  assert.ok(SG_KNOWLEDGE_SOURCES.length >= 8, 'the SG spine covers the core lanes');
  const ids = SG_KNOWLEDGE_SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'source ids unique');
  for (const source of SG_KNOWLEDGE_SOURCES) {
    assert.ok(source.quote && source.title, `${source.id} carries the retrieved title and verbatim excerpt`);
    assert.equal(source.as_of, '2026-09-24');
    assert.ok(source.authority, `${source.id} names its authority`);
    assert.equal(source.jurisdiction, 'sg');
    assert.equal(source.trust, 'primary', `${source.id} is first-party material only`);
    assert.match(source.as_of, /^\d{4}-\d{2}-\d{2}$/, `${source.id} carries an as-of date`);
    assert.match(source.url, /^https:\/\/www\.(iras|acra|pdpc)\.gov\.sg|^https:\/\/www\.cpf\.gov\.sg/, `${source.id} points at the authority's own domain`);
    assert.ok(SG_KNOWLEDGE_TOPICS.includes(source.topic), `${source.id} topic registered`);
    assert.equal(source.confirmed_content, true, `${source.id} page read live in SG-2`);
  }
});

test('topic routing returns the lane sources; unknown topics return nothing', () => {
  const gst = knowledgeSourcesForTopic('gst');
  assert.ok(gst.length >= 2);
  assert.ok(gst.every((s) => s.topic === 'gst'));
  assert.deepEqual(knowledgeSourcesForTopic('nope'), []);
  assert.equal(resolveKnowledgeSource('iras_gst_overview').authority, 'IRAS');
  assert.equal(resolveKnowledgeSource('missing'), null);
});

test('the eval seed guards the FACT-vs-KNOWLEDGE fork: knowledge grounds, facts never do', () => {
  const kinds = new Set(SG_CS_EVAL_SEED.map((item) => item.kind));
  assert.deepEqual([...kinds].sort(), ['fact', 'knowledge'], 'both forks represented');
  for (const item of SG_CS_EVAL_SEED) {
    if (item.kind === 'knowledge') {
      assert.ok(item.expected_sources.length >= 1, `${item.id} must ground in the registry`);
      for (const id of item.expected_sources) {
        assert.ok(resolveKnowledgeSource(id), `${item.id} expected source ${id} exists in the registry`);
      }
      assert.ok(item.must_mention.length >= 1, `${item.id} carries must-mention markers`);
    } else {
      assert.equal(item.expected_sources.length, 0, `${item.id} is an owner FACT — it must never be answered from the registry`);
    }
  }
  const ids = SG_CS_EVAL_SEED.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'eval ids unique');
});
