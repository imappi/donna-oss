// K1-7 — the GB gold set (corpus spec §7 B5), run in CI against
// FIXTURE-ACTIVATED worksheet entries. Until the curation session activates
// the real corpus, every excerpt here is synthetic and LABELLED ([fixture]),
// and every fixture source stays confirmed_against_primary: false with a
// verification note — the honesty markers must flow even in tests, so no
// fixture can masquerade as a verified source.
//
// The five gold properties (design §12 K1-7):
//   1. the correct passage is retrieved for each of the 32 questions
//   2. no cross-jurisdiction leakage — FI/SG/unresolved contexts refuse
//   3. decision-date correctness — a pre-window decision date excludes
//   4. the citation carries the claim's provenance (authority, as-of,
//      unconfirmed marker) all the way to the projection
//   5. refusal fires where it should — an empty corpus refuses, free

import test from 'node:test';
import assert from 'node:assert/strict';

import { GB_CORPUS_V1 } from './gbCorpusV1.js';
import { reviewDueForSource } from '../../../scripts/load_knowledge_corpus.mjs';
import { retrieveKnowledge, KNOWLEDGE_BASE_RETRIEVAL_FLAG_KEY } from '../knowledgeRetrieval.js';
import { answerKnowledgeQuestion } from '../knowledgeAnswer.js';
import { knowledgeSourceId, knowledgePassageId } from '../knowledgeBase.js';

const ON = { [KNOWLEDGE_BASE_RETRIEVAL_FLAG_KEY]: { stage: 'canary' } };
const EFFECTIVE_FROM = '2026-04-06T00:00:00.000Z';

// Fixture-activate the whole worksheet: synthetic labelled excerpts, active
// status, full provenance fields — unconfirmed, honestly.
const fixtures = (() => {
  const sourceById = {};
  const sourceIdByKey = {};
  for (const ws of GB_CORPUS_V1.sources) {
    const record = {
      authority: ws.authority,
      authority_class: ws.authority_class,
      jurisdiction: 'GB',
      title: ws.title,
      citation: ws.citation ?? null,
      source_url: ws.source_url,
      language: 'en',
      translation_status: 'original',
      content_hash: 'sha256:fixture',
      snapshot_ref: `snap://fixture/${ws.key}`,
      published_at: null,
      effective_from: EFFECTIVE_FROM,
      effective_until: null,
      as_of: '2026-08-01T00:00:00.000Z',
      review_due_at: reviewDueForSource(ws.key, GB_CORPUS_V1.passages),
      confirmed_against_primary: false,
      verification_note: 'gold-set fixture — synthetic excerpt, never a verified source',
      status: 'active'
    };
    const id = knowledgeSourceId(record);
    sourceIdByKey[ws.key] = id;
    sourceById[id] = { ...record, id };
  }
  const entries = GB_CORPUS_V1.passages.map((ws) => {
    const sourceId = sourceIdByKey[ws.source_key];
    const passage = {
      source_id: sourceId,
      jurisdiction: 'GB',
      topic: ws.topic,
      question_forms: [...ws.question_forms],
      source_excerpt: `[fixture] ${ws.draft_proposition}`,
      source_anchor: ws.source_anchor,
      curated_proposition: ws.draft_proposition,
      answer_shape: ws.answer_shape,
      caveats: ws.caveats ?? null,
      effective_from: EFFECTIVE_FROM,
      effective_until: null,
      status: 'active'
    };
    const id = knowledgePassageId({ source_id: sourceId, topic: ws.topic, source_anchor: ws.source_anchor });
    return { spec_question: ws.spec_question, passage: { ...passage, id }, source: sourceById[sourceId] };
  });
  return { entries, candidates: entries.map((e) => ({ passage: e.passage, source: e.source })) };
})();

const ctx = (overrides = {}) => ({
  legal_entity: { client_id: 'gold-gb-entity', jurisdiction: 'GB' },
  resolved_audience: { audience_class: 'owner' },
  consumer_capability_id: 'clientPortalChatContext',
  source_event_id: 'gold-evt',
  occurred_at: '2026-08-01T12:00:00.000Z',
  model_id: null,
  config_snapshot: ON,
  config_snapshot_id: 'gold-cfg',
  ...overrides
});

const retrieve = ({ question, topics = [], context = {}, decisionDate = null, candidates = fixtures.candidates }) =>
  retrieveKnowledge({
    trustedContext: ctx(context),
    request: { purpose_id: 'owner_knowledge_answer', question_text: question, topics, decision_date: decisionDate },
    deps: { loadKnowledgeCandidates: async () => candidates, env: {} }
  });

test('gold 1: every one of the 32 questions retrieves its own passage at rank 0', async () => {
  const misses = [];
  for (const entry of fixtures.entries) {
    const ws = GB_CORPUS_V1.passages.find((p) => p.spec_question === entry.spec_question);
    const out = await retrieve({ question: ws.question_forms[0], topics: [ws.topic] });
    const top = out.grounding.passages[0];
    if (!top || top.passage_id !== entry.passage.id) {
      misses.push(`${entry.spec_question} (“${ws.question_forms[0]}”) got ${top ? top.passage_id : 'nothing'}`);
    }
  }
  assert.deepEqual(misses, [], `retrieval must put each question's own passage first:\n${misses.join('\n')}`);
});

test('gold 2: no cross-jurisdiction leakage — FI, SG and unresolved entities refuse over a GB corpus', async () => {
  for (const [jurisdiction, failure] of [['FI', 'no match'], ['SG', 'jurisdiction_out_of_scope'], [null, 'jurisdiction_unresolved']]) {
    const out = await retrieve({
      question: 'Do I need to register for VAT?',
      topics: ['vat_registration'],
      context: { legal_entity: { client_id: 'other-entity', jurisdiction } }
    });
    assert.deepEqual(out.grounding.passages, [], `${jurisdiction}: no GB passage may ground`);
    if (failure !== 'no match') assert.equal(out.failure, failure);
  }
});

test('gold 3: a decision date before the rule’s window excludes the passage — a 2024 question never gets 2026’s rule', async () => {
  const out = await retrieve({
    question: 'Do I need to register for VAT?',
    topics: ['vat_registration'],
    decisionDate: '2024-06-01T00:00:00.000Z'
  });
  assert.deepEqual(out.grounding.passages, [], 'nothing effective at the decision date');
  // The excluded rule stays VISIBLE as withheld — so the deterministic answer
  // is the honest partial naming the nearest source, never 2026's rule
  // presented as 2024's and never a bare unexplained refusal.
  assert.ok(out.receipt.withheld.some((w) => w.reason === 'outside_effective_window'),
    `withheld must name the window exclusion: ${JSON.stringify(out.receipt.withheld)}`);
  const answer = await answerKnowledgeQuestion({ retrieval: out, compose: null });
  assert.equal(answer.outcome, 'honest_partial');
  assert.ok((answer.receipt.cited ?? []).length === 0, 'nothing outside its window may be cited as current');
});

test('gold 4: the citation carries the claim’s provenance — authority, as-of, and the unconfirmed marker survive to the projection and the answer', async () => {
  const out = await retrieve({ question: 'Can I claim mileage?', topics: ['vehicle_costs'] });
  const top = out.grounding.passages[0];
  assert.equal(top.citation.authority, 'HM Revenue & Customs');
  assert.equal(top.citation.confirmed_against_primary, false, 'a fixture may never read as verified');
  assert.ok(top.citation.as_of, 'as-of rides the citation');
  assert.match(top.source_excerpt, /^\[fixture\]/, 'the synthetic excerpt stays labelled');
  const answer = await answerKnowledgeQuestion({ retrieval: out, compose: null });
  assert.match(answer.grounding_block, /HM Revenue & Customs/);
  assert.ok(out.receipt.included.every((i) => i.content_hash), 'the receipt names each grounding row’s content hash');
});

test('gold 5: an empty corpus refuses — deterministically, with no model call and a complete receipt', async () => {
  const out = await retrieve({ question: 'Do I need to register for VAT?', topics: ['vat_registration'], candidates: [] });
  assert.deepEqual(out.grounding.passages, []);
  let composeCalls = 0;
  const answer = await answerKnowledgeQuestion({ retrieval: out, compose: async () => { composeCalls += 1; return null; } });
  assert.equal(answer.outcome, 'refusal');
  assert.equal(composeCalls, 0, 'nothing to read ⇒ nothing to compose');
  assert.ok(answer.receipt, 'refusal still carries its receipt');
});
