// Donna — K1-5 answer-contract tests (docs/design-donna-knowledge-base.md §6).
//
// The design is explicit that outcomes 3 and 4 are FIRST-CLASS OUTCOMES, "not
// error handling" — so they are tested here as behaviours with their own
// required properties (they say WHY, they name what exists, they cost no model
// call), not as the absence of a happy path.
//
// The properties, in the order the module's header states them:
//
//   1. the floor is a CEILING — the model may downgrade, never upgrade
//   2. a citation that was not retrieved voids the answer
//   3. an answer claiming grounding with no citation voids the answer
//   4. provenance markers are ATTACHED deterministically, never requested
//   5. withheld rows are namable but never quotable
//   6. resolve-before-asking suppresses the ask, and records that it did
//   7. every rejection lands in the deterministic fallback — never in degraded
//      model prose reaching the owner

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWLEDGE_ANSWER_OUTCOMES,
  KNOWLEDGE_ANSWER_CONTRACT_VERSION,
  outcomeRank,
  knowledgeAnswerIdFor,
  knowledgeOutcomeFloor,
  renderCitation,
  renderCitations,
  buildKnowledgeGroundingBlock,
  validateComposedKnowledgeAnswer,
  renderDeterministicKnowledgeAnswer,
  buildKnowledgeAnswerReceipt,
  answerKnowledgeQuestion
} from './knowledgeAnswer.js';

// ─── Fixtures — the exact shape knowledgeRetrieval.js returns ────────────────

const citation = (overrides = {}) => ({
  authority: 'Verohallinto',
  authority_class: 'tax_authority_guidance',
  citation: 'VH/1234/00.01.00/2026',
  title: 'Arvonlisäverotus',
  source_url: 'https://www.vero.fi/example',
  language: 'fi',
  translation_status: 'original',
  published_at: '2025-12-01T00:00:00.000Z',
  as_of: '2026-07-01T00:00:00.000Z',
  review_due_at: '2027-01-01T00:00:00.000Z',
  confirmed_against_primary: true,
  verification_note: null,
  snapshot_ref: 'snap://fi/vat/2026',
  content_hash: 'sha256:abc',
  ...overrides
});

const passage = (overrides = {}) => ({
  passage_id: 'kpsg-fi-vat-1',
  source_id: 'ksrc-fi-vat',
  rank: 0,
  lexical_score: 0.75,
  topic: 'vat_deduction',
  answer_shape: 'rule',
  jurisdiction: 'FI',
  source_excerpt: 'Vahennysoikeus koskee liiketoimintaa varten hankittuja tavaroita.',
  source_anchor: 'AVL 102 §',
  curated_proposition: 'VAT on purchases made for business use is deductible.',
  caveats: 'Does not settle mixed private/business use.',
  truncated: false,
  effective_from: '2026-01-01T00:00:00.000Z',
  effective_until: null,
  staleness: 'fresh',
  citation: citation(),
  ...overrides
});

const retrieval = ({
  status = 'ok',
  failure = null,
  coverage = 'covered',
  passages = [passage()],
  withheld = [],
  conflicts = []
} = {}) => ({
  status,
  failure,
  grounding: { jurisdiction: 'FI', decision_date: '2026-07-29T00:00:00.000Z', coverage, passages, conflicts },
  receipt: {
    retrieval_id: 'kretr-abc',
    capability: 'knowledge.retrieve.v1',
    service_version: 'knowret.svc.v1',
    policy_version: 'knowret.policy.v1',
    ranker_version: 'knowret.rank.v1',
    model_id: 'claude-opus-x',
    evaluated_at: '2026-07-29T09:00:00.000Z',
    coverage,
    failure,
    included: passages.map((p) => ({ passage_id: p.passage_id })),
    withheld,
    conflicts
  }
});

const goodComposed = (overrides = {}) => ({
  outcome: 'grounded',
  answer_text: 'VAT on business purchases is deductible.',
  cited_passage_ids: ['kpsg-fi-vat-1'],
  named_variables: [],
  ...overrides
});

// ─── 1. The floor ───────────────────────────────────────────────────────────

test('the outcome ladder is ordered weakest to strongest', () => {
  assert.deepEqual([...KNOWLEDGE_ANSWER_OUTCOMES],
    ['refusal', 'honest_partial', 'grounded_with_caveat', 'grounded']);
  assert.ok(outcomeRank('grounded') > outcomeRank('grounded_with_caveat'));
  assert.ok(outcomeRank('grounded_with_caveat') > outcomeRank('honest_partial'));
  assert.ok(outcomeRank('honest_partial') > outcomeRank('refusal'));
});

test('a refused retrieval floors at refusal, carrying the failure as the reason', () => {
  const r = knowledgeOutcomeFloor(retrieval({ status: 'refused', failure: 'jurisdiction_out_of_scope', passages: [] }));
  assert.equal(r.floor, 'refusal');
  assert.equal(r.reason, 'retrieval_jurisdiction_out_of_scope');
});

test('no passages and nothing withheld is a refusal — there is genuinely nothing to say', () => {
  assert.equal(knowledgeOutcomeFloor(retrieval({ coverage: 'none', passages: [] })).floor, 'refusal');
});

test('no passages but WITHHELD rows is an honest partial, not a refusal', () => {
  // The distinction that makes outcome 3 real: a stale rate we refuse to quote
  // is still something honest to say. Collapsing this to a refusal throws away
  // the one useful thing Donna knows.
  const r = knowledgeOutcomeFloor(retrieval({
    coverage: 'none',
    passages: [],
    withheld: [{ passage_id: 'kpsg-fi-rate-1', topic: 'vat_rates', answer_shape: 'rate', reason: 'stale_exact_value', source_as_of: '2026-03-01T00:00:00.000Z' }]
  }));
  assert.equal(r.floor, 'honest_partial');
  assert.equal(r.reason, 'withheld_only');
});

test('adjacent coverage floors at honest partial even though passages exist', () => {
  assert.equal(knowledgeOutcomeFloor(retrieval({ coverage: 'adjacent' })).floor, 'honest_partial');
});

test('covered coverage floors at grounded', () => {
  assert.equal(knowledgeOutcomeFloor(retrieval({ coverage: 'covered' })).floor, 'grounded');
});

// ─── 2. Downgrade-only ──────────────────────────────────────────────────────

test('the model may DOWNGRADE below the floor', async () => {
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval({ coverage: 'covered' }),
    compose: async () => goodComposed({ outcome: 'honest_partial' })
  });
  assert.equal(out.outcome, 'honest_partial');
  assert.equal(out.receipt.outcome_floor, 'grounded');
  assert.equal(out.receipt.downgraded_from, 'grounded');
  assert.deepEqual(out.receipt.contract_violations, []);
});

test('the model may NOT upgrade above the floor — the answer is rejected, not clamped', async () => {
  // Clamping only the label would leave prose written to justify the stronger
  // claim sitting under a weaker one. §6's anti-goal: never relax the bar.
  const compose = async () => goodComposed({ outcome: 'grounded' });
  const out = await answerKnowledgeQuestion({ retrieval: retrieval({ coverage: 'adjacent' }), compose });
  assert.equal(out.receipt.contract_violations.includes('outcome_above_floor'), true);
  assert.equal(out.outcome, 'honest_partial');
  assert.equal(out.answer_text.includes('VAT on business purchases is deductible'), false,
    'the rejected model prose must not reach the owner in any form');
});

test('an unknown outcome string is rejected', () => {
  const v = validateComposedKnowledgeAnswer({
    composed: goodComposed({ outcome: 'probably_fine' }),
    retrieval: retrieval()
  });
  assert.equal(v.valid, false);
  assert.ok(v.violations.includes('invalid_outcome'));
});

// ─── 3. Citations that were not retrieved ───────────────────────────────────

test('citing a passage id that was not retrieved voids the answer', () => {
  const v = validateComposedKnowledgeAnswer({
    composed: goodComposed({ cited_passage_ids: ['kpsg-invented'] }),
    retrieval: retrieval()
  });
  assert.equal(v.valid, false);
  assert.ok(v.violations.includes('citation_not_retrieved'));
});

test('citing a WITHHELD passage is caught by the same rule — a stale rate is unquotable', async () => {
  const r = retrieval({
    coverage: 'covered',
    passages: [passage()],
    withheld: [{ passage_id: 'kpsg-fi-rate-1', topic: 'vat_rates', answer_shape: 'rate', reason: 'stale_exact_value', source_as_of: '2026-03-01T00:00:00.000Z' }]
  });
  const out = await answerKnowledgeQuestion({
    retrieval: r,
    compose: async () => goodComposed({ cited_passage_ids: ['kpsg-fi-vat-1', 'kpsg-fi-rate-1'] })
  });
  assert.ok(out.receipt.contract_violations.includes('citation_not_retrieved'));
  assert.equal(out.outcome, 'honest_partial');
});

test('an answer claiming grounding with no citation at all is rejected', () => {
  for (const outcome of ['grounded', 'grounded_with_caveat']) {
    const v = validateComposedKnowledgeAnswer({
      composed: goodComposed({ outcome, cited_passage_ids: [], named_variables: [{ variable: 'x', is_business_fact: true }] }),
      retrieval: retrieval()
    });
    assert.equal(v.valid, false, `${outcome} with no citation must be rejected`);
    assert.ok(v.violations.includes('ungrounded_claim'));
  }
});

test('outcome 2 without a named variable is just outcome 1 wearing a hedge — rejected', () => {
  const v = validateComposedKnowledgeAnswer({
    composed: goodComposed({ outcome: 'grounded_with_caveat', named_variables: [] }),
    retrieval: retrieval()
  });
  assert.ok(v.violations.includes('caveat_without_variable'));
});

test('empty or whitespace answer text is rejected', () => {
  for (const text of ['', '   ', '\u0000\u0001']) {
    const v = validateComposedKnowledgeAnswer({
      composed: goodComposed({ answer_text: text }),
      retrieval: retrieval()
    });
    assert.ok(v.violations.includes('empty_answer_text'), `"${text}" must be rejected`);
  }
});

// ─── 4. Provenance is attached, never requested ─────────────────────────────

test('a compact citation is authority · effective date · verified date', () => {
  const c = renderCitation(passage(), { style: 'compact' });
  assert.equal(c.text, 'Verohallinto · effective 2026-01-01 · verified 2026-07-01');
  assert.deepEqual(c.markers, []);
});

test('an unconfirmed source says so in the citation, without being asked to', () => {
  const c = renderCitation(passage({ citation: citation({ confirmed_against_primary: false }) }), { style: 'compact' });
  assert.match(c.text, /not confirmed against the primary source/);
});

test('a stale source states when it was last verified', () => {
  const c = renderCitation(passage({ staleness: 'stale' }), { style: 'compact' });
  assert.match(c.text, /not re-verified since 2026-07-01/);
});

test('a curator translation is disclosed', () => {
  const c = renderCitation(passage({ citation: citation({ translation_status: 'curator_translated' }) }), { style: 'compact' });
  assert.match(c.text, /curator translation/);
});

test('a truncated excerpt is disclosed', () => {
  const c = renderCitation(passage({ truncated: true }), { style: 'compact' });
  assert.match(c.text, /excerpt shortened/);
});

test('the full citation carries the snapshot and the content hash', () => {
  const c = renderCitation(passage(), { style: 'full' });
  assert.match(c.text, /snap:\/\/fi\/vat\/2026/);
  assert.match(c.text, /sha256:abc/);
  assert.match(c.text, /AVL 102 §/);
  assert.match(c.text, /Verified by us: 2026-07-01/);
});

test('dates render locale-free — 2026-01-01 is unambiguous in both markets, 01/02 is not', () => {
  const c = renderCitation(passage(), { style: 'compact' });
  assert.equal(c.text.includes('/'), false);
});

test('renderCitations maps every passage', () => {
  const cs = renderCitations([passage(), passage({ passage_id: 'kpsg-2' })], { style: 'compact' });
  assert.deepEqual(cs.map((c) => c.passage_id), ['kpsg-fi-vat-1', 'kpsg-2']);
});

// ─── 5. The grounding block ─────────────────────────────────────────────────

test('the grounding block states the floor and the outcomes the model may use', () => {
  const block = buildKnowledgeGroundingBlock({ retrieval: retrieval({ coverage: 'adjacent' }) });
  assert.match(block, /strongest outcome the sources permit: honest_partial/);
  assert.match(block, /you may answer with: refusal, honest_partial — and with nothing stronger/);
});

test('the excerpt and the curated proposition stay SEPARATE in the prompt', () => {
  const block = buildKnowledgeGroundingBlock({ retrieval: retrieval() });
  assert.match(block, /SOURCE EXCERPT/);
  assert.match(block, /CURATED PROPOSITION/);
  assert.match(block, /Vahennysoikeus koskee/);
  assert.match(block, /VAT on purchases made for business use is deductible/);
});

test('withheld rows reach the prompt as topic and dates — never as text to quote', () => {
  const block = buildKnowledgeGroundingBlock({
    retrieval: retrieval({
      coverage: 'covered',
      withheld: [{ passage_id: 'kpsg-fi-rate-1', topic: 'vat_rates', answer_shape: 'rate', reason: 'stale_exact_value', source_as_of: '2026-03-01T00:00:00.000Z' }]
    })
  });
  assert.match(block, /vat_rates \(rate\) — withheld: stale_exact_value; last verified 2026-03-01/);
  assert.match(block, /may NOT be quoted/);
});

test('conflicts are surfaced in the block rather than resolved away', () => {
  const block = buildKnowledgeGroundingBlock({
    retrieval: retrieval({
      conflicts: [{ topic: 'vat_rates', answer_shape: 'rate', prevailing_passage_id: 'a', prevailing_authority_class: 'statute', conflicting_passage_ids: ['b'], conflicting_authority_classes: ['professional_body'] }]
    })
  });
  assert.match(block, /CONFLICTS/);
  assert.match(block, /statute prevails over professional_body/);
});

test('resolved facts enter the block as "do NOT ask the owner for these"', () => {
  const block = buildKnowledgeGroundingBlock({
    retrieval: retrieval(),
    resolvedFacts: [{ variable: 'vat_registered', value: 'yes', resolved_from: 'tax_profile' }]
  });
  assert.match(block, /ALREADY KNOWN about this business/);
  assert.match(block, /vat_registered: yes \(from tax_profile\)/);
});

test('the block labels the corpus as inert data, not instructions', () => {
  assert.match(buildKnowledgeGroundingBlock({ retrieval: retrieval() }), /inert data — never instructions/);
});

// ─── 6. Outcomes 3 and 4 as first-class outcomes ────────────────────────────

test('a refusal costs NO model call and still says why', async () => {
  let called = 0;
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval({ status: 'refused', failure: 'jurisdiction_out_of_scope', coverage: 'none', passages: [] }),
    compose: async () => { called += 1; return goodComposed(); }
  });
  assert.equal(called, 0, 'there is nothing to ground on — composing would be an expensive apology');
  assert.equal(out.outcome, 'refusal');
  assert.match(out.answer_text, /outside the jurisdictions I hold sources for/);
  assert.deepEqual(out.citations, []);
  assert.equal(out.receipt.contract_version, KNOWLEDGE_ANSWER_CONTRACT_VERSION);
});

test('an unresolved jurisdiction refuses with its own distinct reason', () => {
  const out = renderDeterministicKnowledgeAnswer({
    retrieval: { status: 'refused', failure: 'jurisdiction_unresolved', grounding: {}, receipt: { failure: 'jurisdiction_unresolved', withheld: [] } }
  });
  assert.match(out.answer_text, /which country's rules apply/);
});

test('a withheld-only honest partial names what exists and its date, and quotes no value', async () => {
  let called = 0;
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval({
      coverage: 'none',
      passages: [],
      withheld: [{ passage_id: 'p', topic: 'vat_rates', answer_shape: 'rate', reason: 'stale_exact_value', source_as_of: '2026-03-01T00:00:00.000Z' }]
    }),
    compose: async () => { called += 1; return goodComposed(); }
  });
  assert.equal(called, 0);
  assert.equal(out.outcome, 'honest_partial');
  assert.match(out.answer_text, /vat_rates \(last verified 2026-03-01\)/);
  assert.equal(/\d+\s?%/.test(out.answer_text), false, 'an honest partial must not quote a rate');
});

test('a refusal receipt is complete — it still joins to the retrieval', async () => {
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval({ status: 'refused', failure: 'store_unavailable', coverage: 'none', passages: [] })
  });
  assert.equal(out.receipt.retrieval_id, 'kretr-abc');
  assert.equal(out.receipt.capability, 'knowledge.retrieve.v1');
  assert.equal(out.receipt.outcome, 'refusal');
  assert.deepEqual(out.receipt.grounded_on, []);
});

// ─── 7. Rejections land in the deterministic fallback ───────────────────────

test('a compose() that throws degrades to the rows — never to an ungrounded answer', async () => {
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval({ coverage: 'covered' }),
    compose: async () => { throw new Error('model timeout'); }
  });
  assert.ok(['honest_partial', 'refusal'].includes(out.outcome));
  assert.deepEqual(out.citations, []);
  assert.ok(out.receipt.contract_violations.length > 0);
});

test('a rejected answer records which model produced it', async () => {
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval({ coverage: 'adjacent' }),
    compose: async () => goodComposed({ outcome: 'grounded' }),
    composedBy: 'claude-opus-5'
  });
  assert.equal(out.receipt.composed_by_model_id, 'claude-opus-5');
});

// ─── 8. The receipt ─────────────────────────────────────────────────────────

test('the receipt names the passages the answer was grounded on', async () => {
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval(),
    compose: async () => goodComposed(),
    composedBy: 'claude-opus-5'
  });
  assert.deepEqual(out.receipt.grounded_on, ['kpsg-fi-vat-1']);
  assert.equal(out.receipt.retrieval_id, 'kretr-abc');
  assert.equal(out.receipt.composed_by_model_id, 'claude-opus-5');
  assert.equal(out.receipt.retrieval_model_id, 'claude-opus-x');
});

test('the composing model is recorded, never inferred from a code default', async () => {
  const out = await answerKnowledgeQuestion({ retrieval: retrieval(), compose: async () => goodComposed() });
  assert.equal(out.receipt.composed_by_model_id, null,
    'a caller that did not state its model gets null, not a guess');
});

test('the answer id is idempotent for the same retrieval', () => {
  assert.equal(knowledgeAnswerIdFor({ retrievalId: 'kretr-abc' }), knowledgeAnswerIdFor({ retrievalId: 'kretr-abc' }));
  assert.notEqual(knowledgeAnswerIdFor({ retrievalId: 'kretr-abc' }), knowledgeAnswerIdFor({ retrievalId: 'kretr-xyz' }));
});

test('the receipt carries conflicts and withheld ids for the curator', () => {
  const r = buildKnowledgeAnswerReceipt({
    retrieval: retrieval({
      withheld: [{ passage_id: 'w1', topic: 'vat_rates', reason: 'stale_exact_value' }],
      conflicts: [{ topic: 'vat_rates', prevailing_passage_id: 'a', conflicting_passage_ids: ['b'] }]
    }),
    outcome: 'grounded',
    floor: 'grounded'
  });
  assert.deepEqual(r.withheld_named, [{ passage_id: 'w1', topic: 'vat_rates', reason: 'stale_exact_value' }]);
  assert.deepEqual(r.conflicts_surfaced, [{ topic: 'vat_rates', prevailing_passage_id: 'a', conflicting_passage_ids: ['b'] }]);
});

// ─── 9. Resolve before asking ───────────────────────────────────────────────

test('an ask for a variable we already resolved is suppressed and the suppression recorded', async () => {
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval(),
    compose: async () => goodComposed({
      outcome: 'grounded_with_caveat',
      named_variables: [{ variable: 'vat_registered', is_business_fact: true, question: 'Are you VAT registered?' }]
    }),
    resolution: {
      attempted: [{ variable: 'vat_registered', source: 'tax_profile', hit: true }],
      resolved: [{ variable: 'vat_registered', value: 'yes', resolved_from: 'tax_profile' }],
      unresolved: [],
      suppressed_asks: []
    }
  });
  assert.deepEqual(out.asks, [], 'the data already answered it — asking is an interruption the metric counts');
  assert.deepEqual(out.receipt.fact_resolution.suppressed_asks, ['vat_registered']);
});

test('an ask for a genuinely unresolved variable goes through', async () => {
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval(),
    compose: async () => goodComposed({
      outcome: 'grounded_with_caveat',
      named_variables: [{ variable: 'trip_purpose', is_business_fact: true, question: 'Was this trip for business?' }]
    }),
    resolution: { attempted: [{ variable: 'trip_purpose', source: 'none', hit: false }], resolved: [], unresolved: [{ variable: 'trip_purpose', reason: 'no_probe' }], suppressed_asks: [] }
  });
  assert.deepEqual(out.asks, [{ variable: 'trip_purpose', question: 'Was this trip for business?' }]);
});

test('a variable whose ask is ALREADY OPEN is not asked a second time', async () => {
  // Unresolved but un-askable: the owner has the question in front of them.
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval(),
    compose: async () => goodComposed({
      outcome: 'grounded_with_caveat',
      named_variables: [{ variable: 'trip_purpose', is_business_fact: true, question: 'Was this trip for business?' }]
    }),
    resolution: { attempted: [], resolved: [], unresolved: [{ variable: 'trip_purpose', reason: 'ask_already_open' }], suppressed_asks: ['trip_purpose'] }
  });
  assert.deepEqual(out.asks, []);
});

test('a named variable that is NOT a business fact is never turned into an owner ask', async () => {
  // The FACT/KNOWLEDGE fork: a knowledge variable is Donna's to answer, not the
  // owner's to be quizzed on.
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval(),
    compose: async () => goodComposed({
      outcome: 'grounded_with_caveat',
      named_variables: [{ variable: 'capitalisation_threshold', is_business_fact: false, question: 'n/a' }]
    })
  });
  assert.deepEqual(out.asks, []);
});

test('with no resolution pass at all, a business fact is still askable (fail open to asking)', async () => {
  const out = await answerKnowledgeQuestion({
    retrieval: retrieval(),
    compose: async () => goodComposed({
      outcome: 'grounded_with_caveat',
      named_variables: [{ variable: 'trip_purpose', is_business_fact: true, question: 'Business trip?' }]
    })
  });
  assert.deepEqual(out.asks, [{ variable: 'trip_purpose', question: 'Business trip?' }]);
});
