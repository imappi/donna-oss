// Guards the workstream-A label review of the Jev evidence-action development corpus.
// The review is an independent agent review, not expert accounting validation; this
// test only checks that it is complete, honestly labelled, in sync with the corpus,
// and that every new review-* example is expressible through the real compiler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadFixtures } from '../server/donna/evalHarness.js';
import { prepareEvidencePacket, composeEvidenceAction } from './jev_evidence_action_contract.js';
import { ROOT, loadContractCorpus, injectedAnswers, runContract } from './jev_evidence_action.js';

const databaseUrl = process.env.DONNA_PG_TEST_URL;
if (!databaseUrl) throw new Error('INCOMPLETE: DONNA_PG_TEST_URL required for real offline preparation');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
test.after(async () => { await client.end(); });

const REVIEWER = 'workstream-a-agent-review-2026-09-18';
const PROVENANCE = 'independent_agent_review_not_expert_validation';
const REVIEW_PATH = resolve(ROOT, 'data/evals/adjudication/jev-contract-review-2026-09-18.json');
const REVIEW_DIR = resolve(ROOT, 'data/evals/fixtures/jev-plane-dev');
const VERDICTS = ['agree', 'disagree', 'partial'];
const KINDS = ['label', 'source', 'contract', 'none'];
const ACTIONS = ['keep', 'add_distinct_example', 'flag_for_human'];
const ROUTES = ['retrieve_local', 'strong_reasoning', 'customer_question', 'supported_proposal', 'unresolved_research', 'not_admitted'];

const corpus = loadContractCorpus();
const review = JSON.parse(readFileSync(REVIEW_PATH, 'utf8'));
// The directory is shared with the fresh development corpus (`dev-NNN.json`,
// workstream C); only the review examples are this suite's responsibility.
const reviewFixtures = existsSync(REVIEW_DIR) ? loadFixtures('jev-plane-dev', { root: resolve(ROOT, 'data/evals/fixtures') }).filter(f => f.__file.startsWith('review-')) : [];

test('review covers exactly the 34 development cases with valid enums and honest provenance', () => {
  assert.ok(Array.isArray(review));
  assert.equal(review.length, 34);
  assert.deepEqual(review.map(e => e.case_id), corpus.map(f => f.id));
  for (const e of review) {
    assert.equal(e.reviewer, REVIEWER);
    assert.equal(e.provenance, PROVENANCE);
    assert.ok(VERDICTS.includes(e.reconciliation.verdict), `${e.case_id} verdict`);
    assert.ok(KINDS.includes(e.reconciliation.kind), `${e.case_id} kind`);
    assert.ok(ACTIONS.includes(e.reconciliation.recommended_action), `${e.case_id} action`);
    assert.ok(typeof e.reconciliation.reason === 'string' && e.reconciliation.reason.length > 20);
    // An agreement carries no disagreement kind; a disagreement names one.
    if (e.reconciliation.verdict === 'agree') assert.equal(e.reconciliation.kind, 'none', `${e.case_id} agree/kind`);
    else assert.notEqual(e.reconciliation.kind, 'none', `${e.case_id} partial-or-disagree/kind`);
    const j = e.initial_judgment;
    assert.ok(typeof j.admitted_work === 'string' && j.admitted_work.length);
    assert.ok(Array.isArray(j.supported_relationships) && j.supported_relationships.length);
    for (const r of j.supported_relationships) {
      assert.ok(['supported', 'contradicted', 'not_established'].includes(r.verdict), `${e.case_id} relationship verdict`);
      for (const key of ['relationship', 'candidate', 'source_id', 'why']) assert.ok(typeof r[key] === 'string' && r[key].length);
    }
    assert.ok(Array.isArray(j.acceptable_actions) && Array.isArray(j.prohibited_actions));
    assert.equal(typeof j.missing_customer_fact.present, 'boolean');
    assert.equal(typeof j.missing_customer_fact.customer_only_proven, 'boolean');
    assert.ok(typeof j.must_remain_unresolved === 'string');
  }
});

test('the recorded existing label mirrors the immutable corpus, so the review cannot drift from it', () => {
  const byId = new Map(corpus.map(f => [f.id, f]));
  for (const e of review) {
    const f = byId.get(e.case_id);
    assert.equal(e.existing_label.route, f.expected.route, `${e.case_id} route`);
    assert.deepEqual(e.existing_label.proposals, f.expected.proposals || [], `${e.case_id} proposals`);
    assert.ok(ROUTES.includes(e.existing_label.route));
  }
});

test('every case the review sends to a distinct example has one, and every example names what it demonstrates', () => {
  const wanted = review.filter(e => e.reconciliation.recommended_action === 'add_distinct_example');
  if (wanted.length) assert.ok(reviewFixtures.length > 0, 'add_distinct_example recommended but no review-* fixture exists');
  const contractIds = new Set(corpus.map(f => f.id));
  for (const f of reviewFixtures) {
    assert.match(f.__file, /^review-\d{2}\.json$/);
    assert.equal(f.id, f.__file.replace(/\.json$/, ''));
    assert.ok(!contractIds.has(f.id));
    const a = f.adjudication;
    assert.equal(a.status, 'agent_reviewed');
    assert.equal(a.reviewer, REVIEWER);
    assert.match(a.source_family, /^review-[a-z0-9-]+$/);
    assert.ok(a.limitations.some(l => /agent review/i.test(l) && /not expert/i.test(l)), `${f.id} must say it is an agent review, not expert validation`);
    assert.ok(typeof a.demonstrates === 'string' && /contract-0\d\d/.test(a.demonstrates), `${f.id} must name the historical case it is distinct from`);
    for (const key of ['work_item', 'acceptable_outcomes', 'prohibited_outcomes', 'positive_evidence', 'contradictions', 'label_reason']) assert.ok(a[key], `${f.id} ${key}`);
    assert.ok(Object.hasOwn(a, 'missing_fact'));
    assert.ok(ROUTES.includes(f.expected.route));
    assert.deepEqual(a.acceptable_outcomes, [f.expected.route]);
    for (const s of f.packet.sources) assert.equal(s.provenance, 'assumed_synthetic', `${f.id} authored sources stay assumed_synthetic`);
  }
});

for (const f of reviewFixtures) test(`${f.id} is expressible through the real compiler and never acts on unknown answers`, async () => {
  const p = await prepareEvidencePacket(f.packet, client);
  assert.equal(p.error, undefined, `${f.id} prepare: ${p.error}`);
  assert.ok(p.questions.length > 0);
  const ideal = composeEvidenceAction(p, injectedAnswers(p, f.semantic_statuses));
  assert.equal(ideal.route, f.expected.route);
  const proposals = ideal.proposals.map(x => ({ transaction_id: x.transaction_id, invoice_id: x.invoice_id, amount_minor: x.amount_minor }))
    .sort((x, y) => x.transaction_id.localeCompare(y.transaction_id));
  assert.deepEqual(proposals, [...(f.expected.proposals || [])].sort((x, y) => x.transaction_id.localeCompare(y.transaction_id)));
  for (const key of ['production_terminal', 'writer_authority', 'proposal_applied', 'question_delivered']) assert.equal(ideal[key], false);
  assert.ok(ideal.remaining_work.length > 0);
  const unknown = composeEvidenceAction(p, injectedAnswers(p, f.semantic_statuses, { unknown: true }));
  assert.equal(unknown.proposals.length, 0, `${f.id} unknown answers must not propose`);
  assert.notEqual(unknown.route, 'supported_proposal');
  assert.notEqual(unknown.route, 'customer_question');
  assert.equal(unknown.question_specification, undefined);
  for (const key of ['production_terminal', 'writer_authority', 'proposal_applied', 'question_delivered']) assert.equal(unknown[key], false);
});

test('review fixtures pass the shared harness with zero provider calls and zero independently reviewed labels', { skip: reviewFixtures.length === 0 && 'no review fixtures' }, async () => {
  const report = await runContract({ client, fixtures: reviewFixtures });
  assert.equal(report.evaluation.totals.fixtures, reviewFixtures.length);
  assert.equal(report.evaluation.totals.passed, reviewFixtures.length);
  assert.equal(report.evaluation.totals.errored, 0);
  assert.equal(report.provider_calls, 0);
  assert.equal(report.independently_reviewed_labels, 0, 'an agent review is not independent expert review');
  assert.equal(report.capability_verdict, 'not_measured');
});
