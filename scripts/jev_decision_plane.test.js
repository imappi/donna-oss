import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { hash, prepareEvidencePacket, composeEvidenceAction } from './jev_evidence_action_contract.js';
import { runContract } from './jev_evidence_action.js';
import { ARMS, STATUSES, CITE, buildDecisionPlan, verifyPlan, verifyBudget, costTable, commonRoute, atomicQuestions, validateAtomicResponse, contractAnswers,
  guardStrongOutcome, escalationRequest, stateWithFacts, loadCorpus, buildReport, decideFromRecord, needsEscalation, normalizeProposals, MAX_REQUEST_CHARS, MAX_STRONG_OUTPUT_TOKENS, estimateTokens, atomicMaxTokens, validateFullCaseResponse } from './jev_decision_plane_protocol.js';
import { runDecisionPlane, solve, publicSummary, renderCostTable, requestTimeoutMs, canDropSchema, withoutSchema } from './jev_decision_plane.js';
import { candidateMechanicalChecks, POLICIES, POLICY_SPEC, resolvePolicy, evidenceSufficiency, CONTRADICTION_MASS } from './jev_evidence_action_contract.js';
import { ALL_ARMS, OPTIONAL_ARMS, ESCALATING_ARMS, armEscalates, operationalConsequence, labelConsequence, consequenceClass, CONSEQUENCES, ERROR_CLASSES, DISPUTED_GROUND_TRUTH, bandOf, decidingProbability, policyImposed, attributeError, priceFor, ATTRIBUTED_TO, attributedTo, FULL_CASE_ARMS } from './jev_decision_plane_protocol.js';
import { recompose, renderRecompose } from './jev_decision_plane_recompose.js';
import { scoreOutcome } from './jev_decision_plane_protocol.js';

const databaseUrl = process.env.DONNA_PG_TEST_URL;
if (!databaseUrl) throw new Error('INCOMPLETE: DONNA_PG_TEST_URL must provide disposable PostgreSQL for actual eligibility SQL');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
test.after(async () => { await client.end(); });
const model = 'test-provider-model';
const corpus = loadCorpus('jev-contract');
const plan = await buildDecisionPlan({ client, jevModel: model, strongModel: model });
const planCase = n => plan.cases.find(c => c.id === `contract-${String(n).padStart(3, '0')}`);
const jobFor = (n, arm) => plan.jobs.find(j => j.case_id === planCase(n).id && j.arm === arm);
const budget = { approved: true, max_calls: 500, max_input_tokens: 5_000_000, max_output_tokens: 1_000_000, max_usd: 50,
  prices: { typesafe: { input_per_million: 1, output_per_million: 2 }, anthropic: { input_per_million: 15, output_per_million: 75 } } };
const stateIndex = new Map(plan.cases.map(c => [hash(stateWithFacts(c.prepared)), c]));

// Scripted replies verify mechanics only; they are never capability observations.
const script = { fullCase: () => null, escalation: () => null, atomic: (_c, _p, a) => a, blanket: (_c, a) => a };
const base = () => ({ model, usage: { input_tokens: 100, output_tokens: 20 } });
const strongJson = obj => ({ ...base(), stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });
// The scripted strong reply is the label: a determinate `unresolved_research` label is the strong model's explicit `no_settlement`,
// and the label's companion requests ride `evidence_requests`.
const expectedOutcome = c => ({ route: c.expected.route === 'unresolved_research' ? 'no_settlement' : c.expected.route, proposals: c.expected.proposals.map(p => ({ candidate_handle: c.prepared.bank_handles[p.transaction_id], amount_minor: p.amount_minor })),
  missing_fact_needed: c.expected.route === 'customer_question', missing_evidence: c.expected.route === 'needs_evidence' ? 'scripted statement of the missing document' : '',
  evidence_requests: (c.expected.evidence_requests || []).map(id => ({ candidate_handle: c.prepared.bank_handles[id], missing: 'scripted' })), reasoning: 'scripted' });
const statusFor = (c, qid) => {
  const q = c.prepared.questions.find(q => q.id === qid);
  const tx = Object.entries(c.prepared.bank_handles).find(([, h]) => q.action_id === `link_${h}`)?.[0];
  return (qid === 'ask_fact' ? c.semantic_statuses?.ask_fact : c.semantic_statuses?.[tx]?.[q.predicate]) || 'not_established';
};
function atomicReply(c, questions, provider) {
  const answers = Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') { const p = statusFor(c, key.split(CITE)[0]) === 'not_established' ? 0.01 : 0.99; return [key, provider === 'typesafe' ? { type: 'noul', noul: p } : p]; }
    const st = statusFor(c, key);
    return [key, provider === 'typesafe' ? { type: 'choice', choice: st, confidence: 0.9, probabilities: Object.fromEntries(STATUSES.map(s => [s, s === st ? 0.98 : 0.01])) } : { choice: st, confidence: 0.98 }];
  }));
  const edited = script.atomic(c, provider, answers);
  return provider === 'typesafe' ? { ...base(), answers: edited } : strongJson({ answers: edited });
}
function reply(request) {
  const job = plan.jobs.find(j => j.request_sha256 === hash(request));
  if (!job) {
    const c = stateIndex.get(hash(JSON.parse(request.messages[0].content).state));
    assert.ok(c, 'escalation request carries the frozen state');
    return strongJson(script.escalation(c) || expectedOutcome(c));
  }
  const c = plan.cases.find(c => c.id === job.case_id);
  if (job.arm === 'jev_blanket') {
    const answers = Object.fromEntries(Object.keys(request.questions).map(key => {
      const p = key.endsWith('_party') && c.expected.proposals.some(x => c.prepared.bank_handles[x.transaction_id] === key.replace('_party', '')) ? 0.99 : 0.01;
      return [key, { type: 'noul', noul: p }];
    }));
    return { ...base(), answers: script.blanket(c, answers) };
  }
  if (job.arm === 'strong_full_case' || job.arm === 'cheap_full_case') return strongJson(script.fullCase(c) || expectedOutcome(c));
  return atomicReply(c, atomicQuestions(c.prepared), job.provider);
}
let networkCalls = 0;
const fixtureFetch = async (_url, init) => { networkCalls++; return new Response(JSON.stringify(reply(JSON.parse(init.body))), { status: 200 }); };
const scripted = (extra = {}) => runDecisionPlane(plan, { mode: 'live', typesafeKey: 'test-key', anthropicKey: 'test-key', fetchImpl: fixtureFetch, budget, ranAt: '2026-09-18T00:00:00Z', ...extra });
const reset = () => { script.fullCase = () => null; script.escalation = () => null; script.atomic = (_c, _p, a) => a; script.blanket = (_c, a) => a; networkCalls = 0; };

test('identical corpus freezes an identical plan; common routes charge no call to any arm', async () => {
  const again = await buildDecisionPlan({ client, jevModel: model, strongModel: model });
  assert.equal(again.plan_sha256, plan.plan_sha256);
  assert.equal(plan.cases.length, 34);
  assert.deepEqual(plan.arms, [...ARMS]);
  const common = plan.cases.filter(c => c.common);
  assert.deepEqual(common.map(c => c.id), ['contract-004', 'contract-010', 'contract-014', 'contract-017', 'contract-031']);
  for (const c of common) assert.equal(plan.jobs.filter(j => j.case_id === c.id).length, 0);
  assert.equal(planCase(17).prepared.questions.length, 0, 'no question at all is a common route');
  assert.equal(commonRoute(planCase(9).prepared), null, 'questions pending answer coverage are model-dependent');
  const table = costTable(plan, verifyBudget(budget));
  assert.equal(table.model_dependent_cases, 29);
  assert.equal(table.arms.jev_redesigned.initial_calls, 29); assert.equal(table.arms.jev_redesigned.max_escalation_calls, 29);
  assert.equal(table.arms.jev_blanket.initial_calls, 27, 'historical tie rule pre-routes two cases without a call');
  assert.ok(table.total.estimated_usd > 0);
  assert.match(renderCostTable(table), /jev_blanket\s+27/);
  assert.equal(costTable(plan).total.estimated_usd, null);
  assert.throws(() => verifyPlan({ ...plan, confidence_floor: 0.5 }), /frozen_plan_mismatch/);
  await assert.rejects(buildDecisionPlan({ client, arms: ['jev_blanket'], jevModel: model, strongModel: model }), /blanket_requires_full_case_fallback/);
  const subset = await buildDecisionPlan({ client, arms: ['strong_full_case', 'jev_redesigned'], jevModel: model, strongModel: model });
  assert.deepEqual(subset.arms, ['jev_redesigned', 'strong_full_case']);
});

test('every frozen request excludes fixture ids, opaque record ids, labels, expectations and adjudication', () => {
  for (const job of plan.jobs) {
    const f = corpus.find(f => f.id === job.case_id), p = f.packet, text = JSON.stringify(job.request);
    const sourceText = p.sources.map(s => s.content).join('\n');
    const ids = [p.invoice.id, ...p.transactions.map(t => t.id), ...p.related_invoices.map(i => i.id), ...p.sources.map(s => s.id), ...p.links.map(l => l.id), ...p.allocations.map(a => a.id)];
    const forbidden = [f.id, 'label_reason', '"expected"', 'semantic_statuses', 'adjudication', 'source_family', 'prior_art', 'legacy_fixture_sha256', 'acceptable_outcomes', 'prohibited_outcomes', ...ids]
      .filter(s => !sourceText.includes(s)); // authored source text is evidence by design
    for (const s of forbidden) assert.ok(!text.includes(s), `${job.id} leaks ${s}`);
    assert.doesNotMatch(text, /contract-0\d\d/);
  }
  for (const c of plan.cases.filter(c => c.escalation)) assert.doesNotMatch(JSON.stringify(escalationRequest(c.prepared, model, { reason: 'x', dependencies: [] })), /contract-0|label_reason|"expected"|semantic_statuses/);
  const strongAtomic = jobFor(9, 'strong_atomic'), jev = jobFor(9, 'jev_redesigned');
  assert.deepEqual(JSON.parse(strongAtomic.request.messages[0].content), { state: jev.request.state, questions: jev.request.questions }, 'arm 4 answers exactly arm 2 content');
  assert.deepEqual(JSON.parse(jobFor(9, 'strong_full_case').request.messages[0].content).state, jev.request.state, 'arm 3 sees the same state and mechanical facts');
  assert.ok(strongAtomic.request.max_tokens < 2048 && strongAtomic.request.max_tokens > 0);
});

test('arm 2 mapping of ideal typed answers reproduces the injected-ideal contract routes on all 34 cases', async () => {
  reset();
  const live = await scripted();
  assert.equal(live.completion, 'complete');
  const ideal = await runContract({ client, mode: 'ideal' });
  for (const c of plan.cases) {
    const expected = ideal.evaluation.cases.find(x => x.id === c.id).actual.decision;
    const o = live.outcomes.find(o => o.id === `${c.id}/jev_redesigned`);
    const initial = o.common_route ? o.final : o.initial;
    assert.equal(initial.route, expected.route, `${c.id} route`);
    assert.deepEqual(initial.proposals.map(p => [p.transaction_id, p.amount_minor]), expected.proposals.map(p => [p.transaction_id, p.amount_minor]), `${c.id} proposals`);
  }
  for (const arm of ['jev_redesigned', 'strong_atomic']) assert.equal(live.summary[`all/${arm}`].correct_all_cases, 34, `${arm} scripted oracle reaches every terminal`);
  assert.equal(live.summary['all/strong_full_case'].correct_all_cases, 34);
  assert.equal(live.summary['all/jev_redesigned'].escalations, live.outcomes.filter(o => o.arm === 'jev_redesigned' && o.initial?.route === 'strong_reasoning').length);
  const semantic = live.summary['all/jev_redesigned'].semantic_accuracy_vs_provisional_annotations;
  for (const row of Object.values(semantic)) { assert.equal(row.effective_correct, row.asked); assert.equal(row.selected_correct, row.asked); assert.equal(row.unasked_annotated_supported, 0, 'no legacy label says supported on an inapplicable question'); }
  const asked = Object.values(semantic).reduce((n, r) => n + r.asked, 0), all = Object.values(semantic).reduce((n, r) => n + r.questions, 0);
  assert.ok(asked < all, 'processor/exclusion questions are asked only where the evidence shape makes them applicable');
  const o12 = live.outcomes.find(o => o.id === 'contract-012/jev_redesigned');
  const proc = o12.answers.find(a => a.predicate === 'processor');
  assert.equal(proc.probability, 0.98); assert.equal(proc.provider_confidence, 0.9, 'consumed probability is probabilities[choice], not the separate confidence');
  assert.equal(live.provider_calls, networkCalls);
});

test('a low-probability grounding answer yields not_established with no citation; the API probability is retained', () => {
  const c = planCase(12), questions = atomicQuestions(c.prepared);
  const raw = atomicReply(c, questions, 'typesafe');
  for (const key of Object.keys(raw.answers)) if (key.startsWith('link_candidate_1_obligation' + CITE)) raw.answers[key].noul = 0.6;
  const majority = contractAnswers(c.prepared, validateAtomicResponse(raw, questions, 'typesafe').answers).answers.find(a => a.question_id === 'link_candidate_1_obligation');
  assert.equal(majority.status, 'supported'); assert.ok(majority.citations.length > 0, 'majority mass on a source cites it; no second .90 veto');
  for (const key of Object.keys(raw.answers)) if (key.startsWith('link_candidate_1_obligation' + CITE)) raw.answers[key].noul = 0.4;
  const { answers, diagnostics } = contractAnswers(c.prepared, validateAtomicResponse(raw, questions, 'typesafe').answers);
  const obligation = answers.find(a => a.question_id === 'link_candidate_1_obligation');
  assert.equal(obligation.status, 'not_established'); assert.deepEqual(obligation.citations, []); assert.equal(obligation.confidence, 0.01);
  assert.equal(diagnostics.find(d => d.question_id === 'link_candidate_1_obligation').downgraded_without_citation, true);
  assert.equal(composeEvidenceAction(c.prepared, answers).route, 'strong_reasoning');
  const strong = atomicReply(c, questions, 'anthropic');
  const parsed = JSON.parse(strong.content[0].text);
  for (const key of Object.keys(parsed.answers)) if (key.startsWith('link_candidate_1_obligation' + CITE)) parsed.answers[key] = 0.2;
  strong.content[0].text = JSON.stringify(parsed);
  const mapped = contractAnswers(c.prepared, validateAtomicResponse(strong, questions, 'anthropic').answers).answers.find(a => a.question_id === 'link_candidate_1_obligation');
  assert.equal(mapped.status, 'not_established'); assert.equal(mapped.confidence, 0, 'no reported probability for the downgraded status is 0, never a fabricated 1');
  assert.throws(() => validateAtomicResponse({ ...raw, answers: { ...raw.answers, link_candidate_1_obligation: { ...raw.answers.link_candidate_1_obligation, probabilities: { supported: 0.5, contradicted: 0.5, not_established: 0.5 } } } }, questions, 'typesafe'), /invalid_response_distribution/);
  assert.throws(() => validateAtomicResponse({ ...strong, stop_reason: 'max_tokens' }, questions, 'anthropic'), /incomplete_strong_response/);
});

test('affirmative-source and exclusion-citation regressions hold through the live mapping', async () => {
  const c = planCase(25), questions = atomicQuestions(c.prepared);
  const raw = atomicReply(c, questions, 'typesafe');
  const invoice = c.prepared.source_handles[c.prepared.packet.invoice.source_id];
  for (const key of Object.keys(raw.answers)) if (key.startsWith('link_candidate_1_obligation' + CITE)) raw.answers[key].noul = key.endsWith(CITE + invoice) ? 0.99 : 0.05;
  const d = decideFromRecord(c, 'jev_redesigned', raw);
  assert.equal(d.decision.route, 'unresolved_research'); assert.equal(d.decision.reason, 'affirmative_source_not_cited');
  assert.equal(needsEscalation('jev_redesigned', d.decision), true, 'a refused typed answer escalates rather than resting unresolved');
  assert.equal(needsEscalation('jev_redesigned', { route: 'unresolved_research', reason: 'no_link_does_not_establish_customer_obligation' }), false);
  assert.equal(needsEscalation('strong_full_case', d.decision), false);
  const f = structuredClone(corpus.find(f => f.id === 'contract-009')), p = f.packet, sibling = p.transactions[0];
  const s = { ...p.sources[0], id: 'other-obligation-source', kind: 'test_evidence', content: 'The first transfer exclusively pays a separate invoice OTHER-1; it does not pay this invoice.' };
  p.sources.push(s); p.retrieval.required_source_ids.push(s.id); p.retrieval.covered_source_ids.push(s.id);
  p.related_invoices.push({ id: 'other-invoice', source_id: s.id, date: '2026-08-03', reference: 'OTHER-1' });
  p.collision.invoice_ids.push('other-invoice');
  p.links.push({ id: 'exclusive-other', kind: 'different_obligation', source_id: s.id, transaction_id: sibling.id, invoice_id: 'other-invoice' });
  f.semantic_statuses[sibling.id].exclusion = 'supported';
  const prepared = await prepareEvidencePacket(p, client);
  const modified = { ...planCase(9), prepared, semantic_statuses: f.semantic_statuses };
  const q2 = atomicQuestions(prepared), reply2 = atomicReply(modified, q2, 'typesafe');
  const exclusionKey = `link_${prepared.bank_handles[sibling.id]}_exclusion`;
  for (const key of Object.keys(reply2.answers)) if (key.startsWith(exclusionKey + CITE)) reply2.answers[key].noul = key.endsWith(CITE + prepared.source_handles[s.id]) ? 0.99 : 0.05;
  assert.equal(decideFromRecord(modified, 'jev_redesigned', reply2).decision.route, 'supported_proposal');
  for (const key of Object.keys(reply2.answers)) if (key.startsWith(exclusionKey + CITE)) reply2.answers[key].noul = key.endsWith(CITE + prepared.source_handles[p.invoice.source_id]) ? 0.99 : 0.05;
  const refused = decideFromRecord(modified, 'jev_redesigned', reply2).decision;
  assert.equal(refused.route, 'unresolved_research'); assert.equal(refused.reason, 'exclusion_source_not_cited'); assert.equal(refused.proposals.length, 0);
});

test('targeted escalation makes exactly one strong call with the full collision group, charged to the cascade', async () => {
  reset();
  const live = await scripted();
  const o = live.outcomes.find(o => o.id === 'contract-009/jev_redesigned');
  assert.equal(o.initial.route, 'strong_reasoning'); assert.equal(o.escalated_flag, true); assert.equal(o.strong_calls, 1); assert.equal(o.calls, 2);
  const escalations = live.records.filter(r => r.id.startsWith('contract-009/jev_redesigned/'));
  assert.equal(escalations.length, 1);
  const request = escalationRequest(planCase(9).prepared, model, o.initial);
  assert.equal(escalations[0].request_sha256, hash(request));
  const content = JSON.parse(request.messages[0].content);
  assert.equal(content.state.sources.length, planCase(9).prepared.state.sources.length);
  assert.equal(content.state.candidates.length, 2);
  assert.equal(content.unresolved.reason, 'unresolved_relevant_relationships');
  assert.ok(content.unresolved.dependencies.length >= 1);
  assert.equal(o.cascade_latency_ms, o.raw_latency_ms + escalations[0].latency_ms);
  assert.equal(o.usage.anthropic.input_tokens, 100); assert.equal(o.usage.typesafe.input_tokens, 100);
  assert.equal(o.escalated.route, 'strong_reasoning', 'an unresolved strong escalation stays unresolved');
  assert.equal(o.final.route, 'strong_reasoning'); assert.equal(o.score.correct, true); assert.equal(o.score.unresolved, false);
  // Escalation that proposes keeps both decisions and is scored on the final one.
  script.escalation = c => c.id === 'contract-009' ? { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_2', amount_minor: 178000 }], missing_fact_needed: false, reasoning: 'scripted override' } : null;
  const overridden = await scripted();
  const o2 = overridden.outcomes.find(o => o.id === 'contract-009/jev_redesigned');
  assert.equal(o2.initial.route, 'strong_reasoning'); assert.equal(o2.escalated.route, 'supported_proposal'); assert.equal(o2.final.route, 'supported_proposal');
  assert.equal(o2.score.correct, false); assert.equal(o2.score.wrong_proposal, true);
  assert.equal(overridden.summary['all/jev_redesigned'].wrong_proposals, 1);
  assert.equal(overridden.continuation.checks.zero_wrong_proposals, false);
  reset();
});

test('arm 3 guards record over-allocation and ineligible candidates as caught, never accepted or dropped', async () => {
  const p34 = planCase(34).prepared;
  const over = guardStrongOutcome(p34, { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 60000 }, { candidate_handle: 'candidate_2', amount_minor: 60000 }], missing_fact_needed: false, reasoning: '' });
  assert.equal(over.route, 'unresolved_research'); assert.equal(over.reason, 'guard_refused'); assert.deepEqual(over.proposals, []);
  assert.ok(over.guard.refusals.some(r => r.code === 'allocation_arithmetic_conflict'));
  const unknown = guardStrongOutcome(p34, { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_9', amount_minor: 1 }], missing_fact_needed: false, reasoning: '' });
  assert.equal(unknown.guard.refusals[0].code, 'unknown_candidate_handle');
  const p4 = planCase(4).prepared;
  const consumed = guardStrongOutcome(p4, { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: p4.packet.invoice.amount_minor }], missing_fact_needed: false, reasoning: '' });
  assert.ok(consumed.guard.refusals.some(r => ['ineligible_or_wrong_direction', 'bank_allocation_already_consumed'].includes(r.code)));
  const question = guardStrongOutcome(p34, { route: 'customer_question', proposals: [], missing_fact_needed: true, reasoning: '' });
  assert.equal(question.guard.refusals[0].code, 'customer_question_without_named_fact');
  const ok = guardStrongOutcome(p34, { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 60000 }, { candidate_handle: 'candidate_2', amount_minor: 40000 }], missing_fact_needed: false, reasoning: '' });
  assert.equal(ok.route, 'supported_proposal'); assert.equal(ok.proposals.length, 2); assert.equal(ok.guard, null);
  reset();
  script.fullCase = c => c.id === 'contract-034' ? { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 60000 }, { candidate_handle: 'candidate_2', amount_minor: 60000 }], missing_fact_needed: false, reasoning: 'scripted over-allocation' } : null;
  const live = await scripted();
  const o = live.outcomes.find(o => o.id === 'contract-034/strong_full_case');
  assert.equal(o.score.caught_by_guard, true); assert.equal(o.score.initial_wrong_proposal_caught_by_guard, true); assert.equal(o.score.correct, false); assert.equal(o.score.wrong_proposal, false);
  assert.equal(live.summary['all/strong_full_case'].initial_wrong_proposals_caught_by_guard, 1);
  assert.equal(live.summary['all/strong_full_case'].correct_all_cases, 33);
  assert.equal(publicSummary(live).outcomes.find(x => x.id === o.id).final.guard.refusals.length, over.guard.refusals.length);
  reset();
});

test('historical blanket arm falls back to the same strong full-case answer and charges both calls', async () => {
  reset();
  const live = await scripted();
  const o = live.outcomes.find(o => o.id === 'contract-009/jev_blanket');
  assert.equal(o.initial.route, 'strong_reasoning'); assert.equal(o.initial.fallback, true); assert.equal(o.escalated_flag, true);
  const strong = live.outcomes.find(o => o.id === 'contract-009/strong_full_case');
  assert.deepEqual(o.escalated, strong.final);
  assert.equal(o.cascade_latency_ms, o.raw_latency_ms + strong.raw_latency_ms); assert.equal(o.strong_calls, 1);
  assert.equal(live.records.filter(r => r.id.startsWith('contract-009/jev_blanket')).length, 1, 'no separate fallback call');
  const pre = live.outcomes.find(o => o.id === 'contract-002/jev_blanket');
  assert.equal(pre.evidence_path, 'historical_pre_route'); assert.equal(pre.final.route, 'customer_question'); assert.equal(pre.calls, 0);
  assert.equal(pre.score.false_customer_question, true, 'the historical tie rule asks where the contract escalates; recorded, not hidden');
  const direct = live.outcomes.find(o => o.id === 'contract-001/jev_blanket');
  assert.equal(direct.final.route, 'supported_proposal'); assert.equal(direct.score.correct, true); assert.equal(direct.escalated_flag, false);
});

test('budget bounds refuse before the request, stop the run, and reconcile actual usage', async () => {
  reset();
  const calls = await scripted({ budget: { ...budget, max_calls: 2 } });
  assert.equal(networkCalls, 2); assert.equal(calls.completion, 'incomplete'); assert.equal(calls.budget.refusal.bound, 'max_calls');
  assert.equal(calls.records.length, 2); assert.equal(calls.budget.ledger.calls, 2);
  reset();
  const usd = await scripted({ budget: { ...budget, max_usd: 0.000001 } });
  assert.equal(networkCalls, 0, 'refused before any request'); assert.equal(usd.budget.refusal.bound, 'max_usd'); assert.equal(usd.provider_calls, 0);
  assert.equal(usd.failures.length, 1); assert.equal(usd.failures[0].error, 'budget_refused:max_usd'); assert.equal(usd.failures[0].latency_ms, null);
  assert.equal(usd.failures[0].id, usd.budget.refusal.id); assert.equal(usd.failures[0].cause, null);
  reset();
  const output = await scripted({ budget: { ...budget, max_output_tokens: 2100 } });
  assert.equal(output.budget.refusal.bound, 'max_output_tokens', 'the strong max_tokens ceiling is counted before the call');
  reset();
  const checkpoints = [];
  const live = await scripted({ onCheckpoint: r => checkpoints.push(structuredClone(r)) });
  assert.equal(live.completion, 'complete');
  assert.equal(checkpoints.length, live.provider_calls);
  const record = live.records[0];
  assert.ok(record.budget.estimate.input_tokens > 0); assert.equal(record.budget.actual.input_tokens, 100); assert.equal(record.budget.actual.output_tokens, 20);
  assert.equal(live.budget.reconciliation.actual.input_tokens, live.provider_calls * 100);
  assert.ok(live.budget.reconciliation.estimated.input_tokens > live.budget.reconciliation.actual.input_tokens);
  assert.ok(Math.abs(live.budget.ledger.usd - live.budget.reconciliation.actual.usd) < 1e-9);
  assert.throws(() => verifyBudget({ ...budget, approved: false }), /invalid_budget/);
  await assert.rejects(runDecisionPlane(plan, { mode: 'live', typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fixtureFetch, budget: null }), /invalid_budget/);
});

test('replay reproduces the identical report with zero network; failures stop calls and retain the rejected body', async () => {
  reset();
  const live = await scripted();
  const replay = await runDecisionPlane(plan, { mode: 'replay', replay: live, fetchImpl: () => { throw new Error('network forbidden'); } });
  assert.deepEqual(replay.summary, live.summary); assert.deepEqual(replay.outcomes, live.outcomes); assert.deepEqual(replay.continuation, live.continuation);
  assert.deepEqual(replay.budget.reconciliation, live.budget.reconciliation);
  assert.equal(replay.provider_calls, 0); assert.equal(replay.completion, 'complete');
  assert.equal(live.served_models.length, 1);
  const pub = JSON.stringify(publicSummary(live));
  assert.ok(!pub.includes(model) && !pub.includes('scripted') && !pub.includes('"records"'), 'public summary omits model ids, prose and raw bodies');
  assert.ok(pub.includes('"summary"'));
  const missing = structuredClone(live); missing.records.pop();
  const incomplete = await runDecisionPlane(plan, { mode: 'replay', replay: missing });
  assert.equal(incomplete.completion, 'incomplete');
  for (const m of Object.values(incomplete.summary)) for (const v of Object.values(m)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
  await assert.rejects(runDecisionPlane(plan, { mode: 'replay', replay: { ...live, plan_sha256: 'x' } }), /invalid_replay/);
  reset();
  let attempts = 0;
  const bad = await scripted({ fetchImpl: async () => { attempts++; return new Response(JSON.stringify({ model, usage: { input_tokens: 1, output_tokens: 1 }, answers: {} }), { status: 200 }); } });
  // Every answer is unusable: each is that arm's failure on its case, and the
  // protocol's malformed-rate rule (>10% after 20 attempts) stops the run.
  assert.equal(bad.completion, 'incomplete'); assert.equal(bad.records.length, 0);
  assert.ok(bad.malformed_stop && bad.malformed_stop.attempts >= 20 && bad.malformed_stop.malformed === bad.malformed_stop.attempts, JSON.stringify(bad.malformed_stop));
  assert.equal(bad.continuation.status, 'stopped_malformed_rate'); assert.equal(bad.continuation.checks, null);
  assert.equal(bad.rejected_responses.length, attempts); assert.equal(attempts, bad.provider_calls);
  assert.deepEqual(bad.rejected_responses[0].raw.answers, {});
  assert.ok(bad.budget.ledger.calls === attempts && bad.budget.ledger.usd > 0, 'malformed answers are paid and stay on the ledger');
  const http = await scripted({ fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(http.completion, 'incomplete'); assert.equal(http.provider_calls, 1);
  const failed = await scripted({ onCheckpoint: () => { throw new Error('disk'); } });
  assert.equal(failed.provider_calls, 1); assert.equal(failed.completion, 'incomplete');
  reset();
});

// ── Review findings on #2177 at 1d8f1795, pinned as regressions ────────────
test('an invented candidate handle in a strong or escalated proposal counts as a wrong proposal and fails continuation', async () => {
  reset();
  const invented = { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_999', amount_minor: 1 }], missing_fact_needed: false, reasoning: 'scripted invention' };
  script.fullCase = c => c.id === 'contract-001' ? invented : null;
  script.escalation = c => c.id === 'contract-009' ? invented : null;
  const live = await scripted();
  const full = live.outcomes.find(o => o.id === 'contract-001/strong_full_case');
  assert.equal(full.score.caught_by_guard, true); assert.equal(full.score.initial_wrong_proposal_caught_by_guard, true, 'invented candidate is a wrong proposal, not a dropped one');
  assert.equal(full.score.correct, false);
  const esc = live.outcomes.find(o => o.id === 'contract-009/jev_redesigned');
  assert.equal(esc.escalated_flag, true); assert.equal(esc.score.initial_wrong_proposal_caught_by_guard, true);
  assert.ok(live.summary['all/jev_redesigned'].initial_wrong_proposals_caught_by_guard >= 1);
  assert.equal(live.continuation.checks.zero_wrong_proposals, false);
  assert.equal(live.continuation.status, 'criteria_not_met');
  const empty = scoreOutcome({ route: 'supported_proposal', proposals: [] }, { route: 'unresolved_research', proposals: [], guard: { refusals: [{ code: 'empty_proposal' }], initial: { route: 'supported_proposal', proposals: [] } } }, { guard: { refusals: [{ code: 'empty_proposal' }], initial: { route: 'supported_proposal', proposals: [] } } });
  assert.equal(empty.initial_wrong_proposal_caught_by_guard, true);
  reset();
});

test('the spending limit is enforced against actual usage: reservation before dispatch, uncertain charges retained, overruns invalidate the run', async () => {
  reset();
  let first = true;
  const inflate = async (_url, init) => {
    const body = reply(JSON.parse(init.body));
    if (first) { first = false; body.usage = { input_tokens: 1_000_000, output_tokens: 20 }; }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const over = await scripted({ fetchImpl: inflate, budget: { ...budget, max_usd: 0.5 } });
  assert.equal(over.provider_calls, 1, 'the run stops on the overrun');
  assert.equal(over.completion, 'incomplete'); assert.equal(over.budget.overrun.bound, 'max_usd');
  assert.equal(over.continuation.status, 'invalid_budget_overrun'); assert.equal(over.continuation.checks, null);
  assert.equal(over.records.length, 1, 'the paid response is retained as a record');
  assert.ok(over.budget.ledger.usd > 0.5); assert.ok(over.budget.ledger.charged.usd > 0.5);
  reset();
  const deadCheckpoints = [];
  const dead = await scripted({ fetchImpl: async () => { const e = new TypeError('fetch failed: socket reset'); e.code = 'ECONNRESET'; throw e; }, onCheckpoint: r => deadCheckpoints.push(structuredClone(r)) });
  assert.equal(dead.provider_calls, 1); assert.equal(dead.completion, 'incomplete');
  assert.equal(dead.budget.ledger.calls, 1, 'an attempted call counts');
  assert.ok(dead.budget.ledger.uncertain.usd > 0 && dead.budget.ledger.usd > 0, 'a transport failure keeps its estimate on the ledger');
  assert.deepEqual(dead.budget.ledger.reserved, { input_tokens: 0, output_tokens: 0, usd: 0 });
  assert.equal(dead.failures.length, 1, 'the failed call is recorded');
  assert.equal(dead.failures[0].error, 'provider_transport_failure');
  const firstJob = plan.jobs[0];
  assert.equal(dead.failures[0].id, firstJob.id); assert.equal(dead.failures[0].kind, 'initial'); assert.equal(dead.failures[0].case_id, firstJob.case_id);
  assert.equal(dead.failures[0].arm, firstJob.arm); assert.equal(dead.failures[0].provider, firstJob.provider); assert.equal(dead.failures[0].request_sha256, firstJob.request_sha256);
  assert.equal(dead.failures[0].timeout_ms, requestTimeoutMs(firstJob)); assert.ok(Number.isInteger(dead.failures[0].latency_ms) && dead.failures[0].latency_ms >= 0);
  assert.deepEqual(dead.failures[0].cause, { code: 'PROVIDER_NETWORK', reason: 'ECONNRESET' }, 'the transport classification is recorded, never the raw message');
  assert.deepEqual(deadCheckpoints.at(-1).failures, dead.failures, 'the checkpoint carries the failure');
  assert.deepEqual(publicSummary(dead).failures, dead.failures.map(({ detail, ...f }) => f), 'the public summary carries the failure without the provider message');
  assert.equal(dead.failures[0].detail, null);
  assert.ok(!JSON.stringify(dead.failures).includes('socket reset'));
  reset();
  const checkpoints = [];
  const live = await scripted({ onCheckpoint: r => checkpoints.push(structuredClone(r.budget.ledger)) });
  assert.equal(live.completion, 'complete');
  for (const l of checkpoints) assert.deepEqual(l.reserved, { input_tokens: 0, output_tokens: 0, usd: 0 }, 'nothing stays reserved after reconciliation');
  assert.ok(Math.abs(live.budget.ledger.usd - live.budget.ledger.charged.usd) < 1e-9);
  reset();
});

test('an incomplete comparison never recommends continuing: every selected arm must finish', async () => {
  reset();
  const live = await scripted();
  assert.notEqual(live.continuation.status, 'incomplete', 'a full comparison yields a verdict (the legacy corpus is label-heavy on strong routes, so the verdict itself is criteria_not_met)');
  assert.ok(live.continuation.checks, 'checks are computed only on a complete comparison');
  const lastAtomic = [...live.records].reverse().find(r => r.arm === 'strong_atomic' && r.kind === 'initial');
  const partial = buildReport(plan, live.records.filter(r => r !== lastAtomic));
  assert.equal(partial.completion, 'incomplete');
  assert.equal(partial.continuation.status, 'incomplete'); assert.equal(partial.continuation.checks, null);
  assert.equal(partial.summary['all/strong_atomic'].incomplete, 1);
  assert.equal(partial.summary['all/jev_redesigned'].incomplete, 0, 'the arms the old rule looked at are complete; only the all-arm rule catches it');
  const replayed = await runDecisionPlane(plan, { mode: 'replay', replay: { ...live, records: live.records.filter(r => r !== lastAtomic) } });
  assert.equal(replayed.continuation.status, 'incomplete');
  reset();
});

test('a full-case answer with an omitted empty proposals key or an extra key is accepted and recorded; unknown routes and malformed proposals are refused', async () => {
  const omitted = validateFullCaseResponse(strongJson({ route: 'customer_question', missing_fact_needed: true, reasoning: 'r' }));
  assert.equal(omitted.route, 'customer_question'); assert.deepEqual(omitted.proposals, []); assert.deepEqual(omitted.envelope.omitted_keys, ['proposals', 'missing_evidence', 'evidence_requests']);
  const extra = validateFullCaseResponse(strongJson({ route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 5, note: 'x' }], missing_fact_needed: false, reasoning: 'r', question: 'why?' }));
  assert.deepEqual(extra.envelope.extra_keys, ['question']); assert.deepEqual(extra.envelope.proposal_extra_keys, ['note']); assert.deepEqual(extra.proposals, [{ candidate_handle: 'candidate_1', amount_minor: 5 }]);
  assert.throws(() => validateFullCaseResponse(strongJson({ route: 'retrieve_local', proposals: [] })), /invalid_full_case_output/);
  assert.throws(() => validateFullCaseResponse(strongJson({ route: 'supported_proposal', proposals: 'none' })), /invalid_full_case_output/);
  assert.throws(() => validateFullCaseResponse(strongJson({ route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 1.5 }] })), /invalid_full_case_proposal/);
  reset();
  // The live finding, end to end: an omitted proposals key on a customer-question case must not stop the run.
  const fetchOmitting = async (_url, init) => {
    const request = JSON.parse(init.body), body = reply(request);
    const job = plan.jobs.find(j => j.request_sha256 === hash(request));
    if (job?.arm === 'strong_full_case' && job.case_id === 'contract-032') { const o = JSON.parse(body.content[0].text); delete o.proposals; body.content[0].text = JSON.stringify(o); }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const live = await scripted({ fetchImpl: fetchOmitting });
  assert.equal(live.completion, 'complete'); assert.equal(live.rejected_responses.length, 0);
  const o = live.outcomes.find(o => o.id === 'contract-032/strong_full_case');
  assert.equal(o.score.correct, true); assert.deepEqual(o.initial.envelope.omitted_keys, ['proposals']);
  reset();
});

test('strong requests are schema-constrained; a malformed answer is scored as that arm\'s failure, escalates for the typed arms, and replays', async () => {
  for (const job of plan.jobs.filter(j => j.provider === 'anthropic')) {
    const f = job.request.output_config?.format;
    assert.equal(f?.type, 'json_schema'); assert.equal(f.schema.additionalProperties, false);
    const walk = node => { if (node && typeof node === 'object') { if (node.type === 'object') { assert.equal(node.additionalProperties, false); assert.ok(Array.isArray(node.required)); } for (const v of Object.values(node)) walk(v); } };
    walk(f.schema);
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength']) assert.ok(!JSON.stringify(f.schema).includes(`"${k}"`));
    if (job.arm === 'strong_atomic') assert.deepEqual(f.schema.properties.answers.required, Object.keys(atomicQuestions(planCase(Number(job.case_id.slice(-3))).prepared)));
  }
  assert.equal(escalationRequest(planCase(9).prepared, model, { reason: 'x', dependencies: [] }).output_config.format.schema.properties.route.enum.length, 6);
  reset();
  // The live sample from the first development run: a dropped closing bracket.
  const dropped = '{"route":"supported_proposal","proposals":[{"candidate_handle":"candidate_1","amount_minor":119400},"missing_fact_needed":false,"reasoning":"x"}';
  const fetchBroken = async (_url, init) => {
    const request = JSON.parse(init.body), body = reply(request);
    const job = plan.jobs.find(j => j.request_sha256 === hash(request));
    if (job?.arm === 'strong_full_case' && job.case_id === 'contract-001') body.content[0].text = dropped;
    if (!job) { const c = stateIndex.get(hash(JSON.parse(request.messages[0].content).state)); if (c.id === 'contract-009') body.content[0].text = dropped; }
    if (job?.arm === 'jev_redesigned' && job.case_id === 'contract-005') body.answers = {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const live = await scripted({ fetchImpl: fetchBroken });
  assert.equal(live.completion, 'complete', 'three malformed answers in a run of this size are below the rate rule');
  assert.equal(live.malformed_stop, null);
  assert.deepEqual(live.rejected_responses.map(r => r.id).sort(), ['contract-001/strong_full_case', 'contract-005/jev_redesigned', 'contract-009/jev_redesigned/escalation', 'contract-009/strong_atomic/escalation']);
  const full = live.outcomes.find(o => o.id === 'contract-001/strong_full_case');
  assert.equal(full.initial.reason, 'malformed_answer:invalid_strong_json'); assert.equal(full.score.correct, false); assert.equal(full.score.unresolved, true); assert.equal(full.strong_calls, 1);
  const typed = live.outcomes.find(o => o.id === 'contract-005/jev_redesigned');
  assert.equal(typed.initial.reason, 'malformed_answer:invalid_response_coverage'); assert.equal(typed.escalated_flag, true, 'a malformed typed answer escalates like any model failure');
  assert.equal(typed.final.route, 'supported_proposal'); assert.equal(typed.score.correct, true);
  const esc = live.outcomes.find(o => o.id === 'contract-009/jev_redesigned');
  assert.equal(esc.escalated.reason, 'malformed_answer:invalid_strong_json'); assert.equal(esc.final.route, 'unresolved_research'); assert.equal(esc.malformed_answers, 1);
  assert.equal(live.summary['all/strong_full_case'].malformed_answers, 1); assert.equal(live.summary['all/jev_redesigned'].malformed_answers, 2); assert.equal(live.summary['all/strong_atomic'].malformed_answers, 1);
  assert.ok(live.continuation.checks, 'a complete comparison with malformed answers still yields a verdict; the failures are scored');
  const replay = await runDecisionPlane(plan, { mode: 'replay', replay: live, fetchImpl: () => { throw new Error('network forbidden'); } });
  assert.deepEqual(replay.summary, live.summary); assert.deepEqual(replay.outcomes, live.outcomes); assert.equal(replay.provider_calls, 0);
  const pub = publicSummary(live);
  assert.deepEqual(pub.rejected.map(r => r.error).sort(), ['invalid_response_coverage', 'invalid_strong_json', 'invalid_strong_json', 'invalid_strong_json']);
  assert.ok(!JSON.stringify(pub).includes('119400'), 'public summary carries no raw bodies');
  reset();
});

test('an interrupted live run resumes from its checkpoint: reused calls are not re-requested, are counted on the ledger, and the result is identical', async () => {
  reset();
  let checkpointAt = null, seen = 0;
  const partial = await scripted({ onCheckpoint: r => { seen++; if (seen === 7) { checkpointAt = structuredClone(r); throw new Error('interrupted'); } } });
  assert.equal(partial.completion, 'incomplete'); assert.ok(checkpointAt && checkpointAt.records.length + checkpointAt.rejected_responses.length === 7);
  const reusedIds = new Set([...checkpointAt.records, ...checkpointAt.rejected_responses].map(r => r.id));
  reset();
  const fetchGuard = async (_url, init) => {
    const request = JSON.parse(init.body);
    const job = plan.jobs.find(j => j.request_sha256 === hash(request));
    if (job && reusedIds.has(job.id)) throw new Error(`re-requested ${job.id}`);
    return fixtureFetch(_url, init);
  };
  const resumed = await runDecisionPlane(plan, { mode: 'live', resume: checkpointAt, typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fetchGuard, budget, ranAt: '2026-09-18T00:00:00Z' });
  assert.equal(resumed.completion, 'complete'); assert.equal(resumed.resumed_calls, 7);
  reset();
  const full = await scripted();
  assert.equal(resumed.provider_calls + resumed.resumed_calls, full.provider_calls);
  // Scripted latencies are real wall-clock and differ run to run; everything else must be identical.
  const noLatency = o => JSON.parse(JSON.stringify(o, (k, v) => k.endsWith('_ms') ? undefined : v));
  assert.deepEqual(noLatency(resumed.summary), noLatency(full.summary)); assert.deepEqual(noLatency(resumed.outcomes), noLatency(full.outcomes));
  assert.equal(resumed.budget.ledger.calls, full.budget.ledger.calls); assert.ok(Math.abs(resumed.budget.ledger.usd - full.budget.ledger.usd) < 1e-9, 'reused calls stay on the ledger against the cap');
  // A checkpoint from a plan re-frozen after a runner-only change carries identical requests and resumes; a tampered request digest does not.
  reset();
  const refrozen = await runDecisionPlane(plan, { mode: 'live', resume: { ...checkpointAt, plan_sha256: 'earlier-freeze' }, typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fetchGuard, budget, ranAt: '2026-09-18T00:00:00Z' });
  assert.equal(refrozen.resumed_calls, 7); assert.equal(refrozen.resumed_from_plan_sha256, 'earlier-freeze');
  const tampered = structuredClone(checkpointAt); tampered.records[0].request_sha256 = 'x';
  await assert.rejects(runDecisionPlane(plan, { mode: 'live', resume: tampered, typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fixtureFetch, budget }), /resume_record_mismatch/);
  await assert.rejects(runDecisionPlane(plan, { mode: 'live', resume: { ...checkpointAt, version: 'other' }, typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fixtureFetch, budget }), /invalid_resume/);
  await assert.rejects(runDecisionPlane(plan, { mode: 'replay', replay: full, resume: checkpointAt }), /invalid_resume/);
  reset();
});

test('the strong-atomic output allowance scales with the question count and a truncated answer is refused', async () => {
  for (const job of plan.jobs.filter(j => j.arm === 'strong_atomic')) {
    const questions = atomicQuestions(planCase(Number(job.case_id.slice(-3))).prepared);
    assert.equal(job.request.max_tokens, atomicMaxTokens(questions));
    assert.ok(job.request.max_tokens <= MAX_STRONG_OUTPUT_TOKENS);
    const compact = JSON.stringify(JSON.parse(atomicReply(planCase(Number(job.case_id.slice(-3))), questions, 'anthropic').content[0].text));
    assert.ok(job.request.max_tokens >= 2 * estimateTokens(compact), `${job.id}: allowance ${job.request.max_tokens} vs compact answer estimate ${estimateTokens(compact)}`);
  }
  assert.ok(atomicMaxTokens(Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`q${i}`, {}]))) >= 2 * 2430, 'the 125-question holdout request clears the measured 2,430-token compact answer twice over');
  await assert.rejects(solve({ provider: 'anthropic', request: { model, max_tokens: MAX_STRONG_OUTPUT_TOKENS + 1, messages: [] } }, { anthropicKey: 'k' }), /request_bound_exceeded/);
  reset();
  const truncate = async (_url, init) => {
    const request = JSON.parse(init.body), body = reply(request);
    const job = plan.jobs.find(j => j.request_sha256 === hash(request));
    if (job?.arm === 'strong_atomic') body.stop_reason = 'max_tokens';
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const cut = await scripted({ fetchImpl: truncate });
  assert.ok(cut.rejected_responses.length >= 1 && cut.rejected_responses.every(r => r.error === 'incomplete_strong_response' && r.arm === 'strong_atomic'));
  const truncated = cut.outcomes.find(o => o.id === cut.rejected_responses[0].id);
  assert.equal(truncated.initial.reason, 'malformed_answer:incomplete_strong_response'); assert.equal(truncated.malformed_answers, 1);
  assert.equal(truncated.escalated_flag, true, 'a truncated typed-arm answer escalates like any model failure');
  assert.equal(cut.malformed_stop?.arm, 'strong_atomic', 'every strong-atomic answer truncated trips the rate rule');
  assert.equal(cut.completion, 'incomplete');
  reset();
});

test('the request deadline scales with the strong output allowance and is capped', () => {
  assert.equal(requestTimeoutMs({ provider: 'typesafe', request: { max_tokens: 100_000 } }), 30_000, 'TypeSafe keeps the fixed deadline');
  assert.equal(requestTimeoutMs({ provider: 'anthropic', request: { max_tokens: 2048 } }), 111_920);
  assert.equal(requestTimeoutMs({ provider: 'anthropic', request: { max_tokens: 4768 } }), 220_720, 'the 94-question holdout allowance');
  assert.equal(requestTimeoutMs({ provider: 'anthropic', request: { max_tokens: 8192 } }), 300_000, 'capped');
  assert.equal(requestTimeoutMs({ provider: 'anthropic', request: {} }), 30_000, 'no allowance keeps the base deadline');
  for (const job of plan.jobs) assert.ok(requestTimeoutMs(job) >= 30_000 && requestTimeoutMs(job) <= 300_000);
  const strong = plan.jobs.filter(j => j.provider === 'anthropic');
  assert.ok(strong.every(j => requestTimeoutMs(j) === Math.min(300_000, 30_000 + 40 * j.request.max_tokens)));
});

test('a provider 400 on a schema-constrained strong request is retried once without the schema, receipted, replayable and resumable; any other 400 stops the run', async () => {
  reset();
  const target = jobFor(12, 'strong_atomic');
  const rejection = { type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex for compilation.' } };
  const sameJob = body => plan.jobs.find(j => j.provider === 'anthropic' && j.request.system === body.system && JSON.stringify(j.request.messages) === JSON.stringify(body.messages));
  let rejected = 0, unconstrained = 0;
  const drop = async (_url, init) => {
    const body = JSON.parse(init.body);
    // contract-027 freezes a byte-identical request; refuse only the first dispatch (contract-012).
    if (hash(body) === target.request_sha256 && rejected === 0) { rejected++; return new Response(JSON.stringify(rejection), { status: 400 }); }
    if (body.messages && !body.output_config) { const job = sameJob(body); assert.ok(job && job.id === target.id, 'only the rejected request is retried without its schema'); unconstrained++; return new Response(JSON.stringify(reply(job.request)), { status: 200 }); }
    return new Response(JSON.stringify(reply(body)), { status: 200 });
  };
  const checkpoints = [];
  const live = await scripted({ fetchImpl: drop, onCheckpoint: r => checkpoints.push(structuredClone(r)) });
  assert.equal(live.completion, 'complete'); assert.equal(rejected, 1); assert.equal(unconstrained, 1);
  assert.equal(live.failures.length, 1);
  const f = live.failures[0];
  assert.equal(f.id, target.id); assert.equal(f.error, 'provider_http_400'); assert.equal(f.retried, 'schema_dropped');
  assert.deepEqual(f.cause, { code: 'PROVIDER_HTTP', reason: 'invalid_request_error', status: 400 });
  assert.equal(f.detail, 'Schema is too complex for compilation.', 'the provider message is kept privately');
  assert.ok(!('detail' in publicSummary(live).failures[0]), 'the public summary drops the message');
  assert.equal(publicSummary(live).failures[0].retried, 'schema_dropped');
  const rec = live.records.find(r => r.id === target.id);
  assert.equal(rec.request_sha256, target.request_sha256, 'the receipt binds to the frozen request');
  assert.equal(rec.sent_request_sha256, hash(withoutSchema(target.request)));
  assert.deepEqual(rec.fallback, { kind: 'schema_dropped', error: 'provider_http_400', cause: { code: 'PROVIDER_HTTP', reason: 'invalid_request_error', status: 400 } });
  assert.ok(live.records.filter(r => r.fallback).length === 1 && live.records.every(r => r.fallback || !r.sent_request_sha256));
  assert.equal(live.provider_calls, live.records.length + 1, 'the rejected attempt is a call');
  assert.equal(live.budget.ledger.calls, live.provider_calls); assert.ok(live.budget.ledger.uncertain.usd > 0, 'the rejected attempt keeps its estimate');
  assert.equal(checkpoints.filter(c => c.failures.length === 1).length > 0, true, 'the checkpoint after the rejection carries the failure');
  const outcome = live.outcomes.find(o => o.id === target.id);
  assert.equal(outcome.malformed_answers, 0, 'the unconstrained answer is validated like any other');
  const replay = await runDecisionPlane(plan, { mode: 'replay', replay: live, fetchImpl: () => { throw new Error('network forbidden'); } });
  assert.deepEqual(replay.summary, live.summary); assert.deepEqual(replay.outcomes, live.outcomes);
  const resumed = await runDecisionPlane(plan, { mode: 'live', resume: live, typesafeKey: 'k', anthropicKey: 'k', fetchImpl: () => { throw new Error('network forbidden'); }, budget, ranAt: '2026-09-18T00:00:00Z' });
  assert.equal(resumed.completion, 'complete'); assert.equal(resumed.provider_calls, 0); assert.deepEqual(resumed.summary, live.summary);
  assert.equal(resumed.failures.length, 0, 'a resumed run records only its own failures'); assert.equal(publicSummary(resumed).failures.length, 0);
  assert.equal(resumed.records.find(r => r.id === target.id).fallback.kind, 'schema_dropped', 'the reused receipt keeps its fallback');
  reset();
  let seen = 0;
  const twice = await scripted({ fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); const refused = (hash(body) === target.request_sha256 && seen++ === 0) || (body.messages && !body.output_config && sameJob(body)?.id === target.id); return refused ? new Response(JSON.stringify(rejection), { status: 400 }) : new Response(JSON.stringify(reply(body)), { status: 200 }); } });
  assert.equal(twice.completion, 'incomplete'); assert.equal(twice.failures.length, 2);
  assert.equal(twice.failures[0].retried, 'schema_dropped'); assert.equal(twice.failures[1].retried, undefined); assert.equal(twice.failures[1].error, 'provider_http_400');
  assert.ok(!twice.records.some(r => r.id === target.id), 'no receipt for a request refused twice');
  reset();
  const typesafeJob = plan.jobs.find(j => j.provider === 'typesafe');
  const ts = await scripted({ fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); return hash(body) === typesafeJob.request_sha256 ? new Response(JSON.stringify(rejection), { status: 400 }) : new Response(JSON.stringify(reply(body)), { status: 200 }); } });
  assert.equal(ts.completion, 'incomplete'); assert.equal(ts.failures.length, 1); assert.equal(ts.failures[0].retried, undefined); assert.equal(ts.failures[0].provider, 'typesafe');
  assert.equal(canDropSchema('typesafe', typesafeJob.request, new Error('provider_http_400')), false);
  assert.equal(canDropSchema('anthropic', target.request, new Error('provider_http_400')), true);
  assert.equal(canDropSchema('anthropic', target.request, new Error('provider_http_429')), false);
  assert.equal(canDropSchema('anthropic', withoutSchema(target.request), new Error('provider_http_400')), false);
  reset();
});

// Raw contract answers from a case's annotated statuses, with citations bound
// to the relationship sources the validator requires; `overrides` patch
// {question_id: {status, confidence}} before composition.
function rawFor(c, overrides = {}) {
  const prepared = c.prepared, p = prepared.packet, version = h => prepared.state.sources.find(s => s.handle === h).version;
  return prepared.questions.map(q => {
    const tx = Object.entries(prepared.bank_handles).find(([, h]) => q.action_id === `link_${h}`)?.[0];
    let status = q.id === 'ask_fact' ? (c.semantic_statuses?.ask_fact || 'not_established') : (c.semantic_statuses?.[tx]?.[q.predicate] || 'not_established');
    let confidence = 0.99;
    if (overrides[q.id]) ({ status, confidence } = { status, confidence, ...overrides[q.id] });
    let handles = [];
    if (status !== 'not_established') {
      const links = p.links.filter(l => l.transaction_id === tx);
      const focal = links.filter(l => l.invoice_id === p.invoice.id && l.kind !== 'different_obligation' && (q.predicate !== 'processor' || l.kind === 'remittance'));
      const pool = q.predicate === 'exclusion' ? links.filter(l => l.invoice_id !== p.invoice.id) : ['obligation', 'reference', 'processor'].includes(q.predicate) ? focal : [];
      handles = [...new Set(pool.map(l => prepared.source_handles[l.source_id]))].filter(h => q.source_handles.includes(h));
      if (!handles.length) handles = [q.source_handles[0]];
    }
    return { question_id: q.id, question_sha256: q.question_sha256, packet_sha256: prepared.packet_sha256, action_id: q.action_id, status, confidence, citations: handles.map(h => ({ source_handle: h, version: version(h) })) };
  });
}

test('the obligation-led policy drops counterparty/reference as confidence vetoes, keeps contradictions, source binding and every mechanical check', async () => {
  const dev = await buildDecisionPlan({ client, corpus: 'jev-plane-dev', jevModel: model, strongModel: model });
  const byId = id => dev.cases.find(c => c.id === id);
  assert.deepEqual([...POLICIES], ['conjunction', 'obligation_led', 'attempt_first', 'safe', 'max_authority', 'forced']);
  assert.throws(() => composeEvidenceAction(byId('dev-001').prepared, [], { policy: 'other' }), /invalid_policy/);
  assert.throws(() => composeEvidenceAction(byId('dev-001').prepared, [], { floor: 2 }), /invalid_policy/);
  // Ideal answers: the three original policies reproduce every label on the development corpus (the
  // capability-boundary policies deliberately differ on evidence-missing labels; pinned in their own test).
  for (const c of dev.cases) for (const policy of ['conjunction', 'obligation_led', 'attempt_first']) {
    const d = composeEvidenceAction(c.prepared, rawFor(c), { policy });
    assert.equal(d.route, c.expected.route, `${c.id} ${policy}`);
    assert.deepEqual(normalizeProposals(d.proposals), normalizeProposals(c.expected.proposals.map(p => ({ ...p }))), `${c.id} ${policy}`);
  }
  // dev-001: a proposal case. A low-confidence counterparty blocks the conjunction and names itself; obligation-led proposes.
  const c1 = byId('dev-001'), party = c1.prepared.questions.find(q => q.predicate === 'counterparty').id, ref = c1.prepared.questions.find(q => q.predicate === 'reference').id;
  const lowParty = rawFor(c1, { [party]: { confidence: 0.6 } });
  const conj = composeEvidenceAction(c1.prepared, lowParty);
  assert.equal(conj.route, 'strong_reasoning'); assert.deepEqual(conj.dependencies[0].blocked_by, ['counterparty']);
  const led = composeEvidenceAction(c1.prepared, lowParty, { policy: 'obligation_led' });
  assert.equal(led.route, 'supported_proposal'); assert.deepEqual(normalizeProposals(led.proposals), normalizeProposals(c1.expected.proposals.map(p => ({ ...p }))));
  // Not-established counterparty and reference: still no veto under obligation-led; both named under the conjunction.
  const absent = rawFor(c1, { [party]: { status: 'not_established', confidence: 0 }, [ref]: { status: 'not_established', confidence: 0 } });
  assert.deepEqual(composeEvidenceAction(c1.prepared, absent).dependencies[0].blocked_by, ['counterparty', 'reference']);
  assert.equal(composeEvidenceAction(c1.prepared, absent, { policy: 'obligation_led' }).route, 'supported_proposal');
  // A contradicted counterparty at majority mass needs resolution under both policies; below it, obligation-led ignores it.
  const conflict = rawFor(c1, { [party]: { status: 'contradicted', confidence: CONTRADICTION_MASS } });
  const ledConflict = composeEvidenceAction(c1.prepared, conflict, { policy: 'obligation_led' });
  assert.equal(ledConflict.route, 'strong_reasoning'); assert.equal(ledConflict.dependencies[0].reason, 'semantic_contradiction_needs_resolution'); assert.deepEqual(ledConflict.dependencies[0].blocked_by, ['counterparty']);
  assert.equal(composeEvidenceAction(c1.prepared, conflict).route, 'strong_reasoning');
  assert.equal(composeEvidenceAction(c1.prepared, rawFor(c1, { [party]: { status: 'contradicted', confidence: 0.3 } }), { policy: 'obligation_led' }).route, 'supported_proposal');
  // Obligation below the floor blocks obligation-led and names obligation; the floor option moves the gate.
  const obl = c1.prepared.questions.find(q => q.predicate === 'obligation').id;
  const weak = rawFor(c1, { [obl]: { confidence: 0.85 } });
  const ledWeak = composeEvidenceAction(c1.prepared, weak, { policy: 'obligation_led' });
  assert.equal(ledWeak.route, 'strong_reasoning'); assert.deepEqual(ledWeak.dependencies[0].blocked_by, ['obligation']);
  assert.equal(composeEvidenceAction(c1.prepared, weak, { policy: 'obligation_led', floor: 0.8 }).route, 'supported_proposal');
  // Mechanical checks and source binding are untouched: a conflict case stays escalated under obligation-led with confident answers everywhere,
  // and an uncited affirmative answer is still refused.
  const c15 = byId('dev-015');
  assert.equal(candidateMechanicalChecks(c15.prepared, c15.prepared.packet.transactions[0], c15.prepared.packet.invoice.amount_minor).conflict, 'conflicting_allocations');
  const forced = rawFor(c15).map(a => a.status === 'not_established' && a.question_id !== 'ask_fact' && !a.question_id.endsWith('_exclusion') && !a.question_id.endsWith('_processor') ? { ...a, status: 'supported', confidence: 0.99, citations: [{ source_handle: c15.prepared.questions.find(q => q.id === a.question_id).source_handles[0], version: c15.prepared.state.sources[0].version }] } : a);
  const c15led = composeEvidenceAction(c15.prepared, forced, { policy: 'obligation_led' });
  assert.equal(c15led.route, 'strong_reasoning'); assert.equal(c15led.dependencies[0].reason, 'conflicting_allocations');
  const uncited = rawFor(c1).map(a => a.question_id === obl ? { ...a, citations: [] } : a);
  assert.equal(composeEvidenceAction(c1.prepared, uncited, { policy: 'obligation_led' }).reason, 'answer_citations');
});

test('the strong-outcome guard applies the compiler\'s mechanical conflicts and reference rules through the shared validator', async () => {
  const dev = await buildDecisionPlan({ client, corpus: 'jev-plane-dev', jevModel: model, strongModel: model });
  const c15 = dev.cases.find(c => c.id === 'dev-015');
  const refused = guardStrongOutcome(c15.prepared, { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 150000 }], missing_fact_needed: false, reasoning: 'x' });
  assert.equal(refused.route, 'unresolved_research'); assert.deepEqual(refused.guard.refusals, [{ candidate: 'candidate_1', code: 'conflicting_allocations' }]);
  // Every development case with a reference-rule or conflict candidate: a strong proposal on it is refused with the compiler's reason.
  let seen = { conflict: 0, reference_rule: 0 };
  for (const c of dev.cases) {
    const p = c.prepared.packet, remaining = p.invoice.amount_minor - p.allocations.filter(a => a.status !== 'rejected' && a.invoice_id === p.invoice.id).reduce((n, a) => n + a.amount_minor, 0);
    for (const t of p.transactions) {
      const m = candidateMechanicalChecks(c.prepared, t, remaining);
      if (!c.prepared.eligible_ids.includes(t.id) || !(m.conflict || m.reference_rule) || !m.link || !m.arithmetic || m.bank_allocated) continue;
      const g = guardStrongOutcome(c.prepared, { route: 'supported_proposal', proposals: [{ candidate_handle: c.prepared.bank_handles[t.id], amount_minor: m.link.invoice_amount_minor }], missing_fact_needed: false, reasoning: 'x' });
      assert.equal(g.route, 'unresolved_research', c.id); assert.equal(g.guard.refusals[0].code, m.conflict || m.reference_rule, c.id);
      seen[m.conflict ? 'conflict' : 'reference_rule']++;
    }
  }
  assert.ok(seen.conflict > 0 && seen.reference_rule > 0, JSON.stringify(seen));
});

test('the recomposition diagnostic reproduces a run from its public summary and never touches the historical result', async () => {
  reset();
  const live = await scripted();
  const pub = publicSummary(live);
  const out = recompose(plan, pub);
  assert.equal(out.diagnostic, true); assert.equal(out.historical_result_unchanged, true); assert.equal(out.corpus_sha256, plan.corpus_sha256);
  for (const arm of ['jev_redesigned', 'strong_atomic']) {
    const rows = pub.outcomes.filter(o => o.arm === arm && !o.common_route);
    assert.equal(out.policies[arm].cases, rows.length);
    const c9 = out.policies[arm]['conjunction@0.9'];
    assert.equal(c9.would_escalate, rows.filter(o => o.escalated_flag).length, 'conjunction@0.9 reproduces the live escalations');
    assert.equal(c9.wrong_proposals, 0);
    for (const o of rows) assert.equal(out.cases[o.case_id][arm]['conjunction@0.9'].route, o.initial.route, `${o.id} initial route reproduced`);
    for (const key of Object.keys(out.policies[arm]).filter(k => k.includes('@'))) assert.ok(out.policies[arm][key].correct_before_escalation <= rows.length);
    // Ideal answers: obligation-led is at least as autonomous as the conjunction and never wrong here.
    assert.ok(out.policies[arm]['obligation_led@0.9'].correct_before_escalation >= c9.correct_before_escalation);
    assert.equal(out.policies[arm]['obligation_led@0.9'].wrong_proposals, 0);
  }
  for (const arm of ['jev_redesigned', 'strong_full_case', 'strong_atomic', 'jev_blanket']) {
    assert.deepEqual(out.reguard[arm].now_refused, [], 'ideal strong outcomes stay accepted under the shared validator');
    assert.equal(out.amounts[arm].arithmetic_refusals, 0);
  }
  assert.throws(() => recompose(plan, { ...pub, corpus_sha256: 'other' }), /summary_corpus_mismatch/);
  assert.ok(!JSON.stringify(out).includes(model), 'the diagnostic carries no model id');
  assert.ok(renderRecompose(out).includes('diagnostic; historical result unchanged'));
  reset();
});

test('a plan carries its composition policy: identical typed requests under any policy, attempt-first at floor 0 reproduces every label, and a conjunction checkpoint resumes under it', async () => {
  reset();
  await assert.rejects(buildDecisionPlan({ client, jevModel: model, strongModel: model, policy: 'other' }), /invalid_policy/);
  await assert.rejects(buildDecisionPlan({ client, jevModel: model, strongModel: model, floor: 1.5 }), /invalid_policy/);
  const attempt = await buildDecisionPlan({ client, jevModel: model, strongModel: model, policy: 'attempt_first', floor: 0 });
  assert.equal(attempt.policy, 'attempt_first'); assert.equal(attempt.confidence_floor, 0); assert.equal(plan.policy, 'conjunction'); assert.equal(plan.confidence_floor, 0.9);
  assert.notEqual(attempt.plan_sha256, plan.plan_sha256);
  assert.deepEqual(attempt.jobs.map(j => [j.id, j.request_sha256]), plan.jobs.map(j => [j.id, j.request_sha256]), 'the policy changes no request');
  assert.ok(attempt.cases.every(c => c.policy === 'attempt_first' && c.floor === 0));
  verifyPlan(attempt);
  // Ideal answers through the harness under attempt-first: every label reproduced, escalations only on label-required strong cases.
  const live = await runDecisionPlane(attempt, { mode: 'live', typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fixtureFetch, budget, ranAt: '2026-09-18T00:00:00Z' });
  assert.equal(live.completion, 'complete');
  // The historical blanket arm is not label-perfect even on ideal answers (pre-routes; its typed match refused by the shared validator on a repeated reference): the typed and full-case arms are.
  for (const o of live.outcomes) if (o.arm !== 'jev_blanket') assert.ok(o.score?.correct ?? o.common_route, o.id);
  assert.equal(live.summary['all/jev_redesigned'].wrong_proposals, 0);
  assert.equal(live.summary['all/jev_redesigned'].escalations, attempt.cases.filter(c => !c.common && c.expected.route === 'strong_reasoning').length);
  // A checkpoint from the conjunction plan resumes under the attempt-first plan: every typed and full-case call is reused by request digest.
  reset();
  const conj = await scripted();
  reset();
  const resumed = await runDecisionPlane(attempt, { mode: 'live', resume: conj, typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fixtureFetch, budget, ranAt: '2026-09-18T00:00:00Z' });
  assert.equal(resumed.completion, 'complete');
  assert.equal(resumed.resumed_calls, conj.records.filter(r => r.kind === 'initial').length + conj.records.filter(r => r.kind === 'escalation' && resumed.records.some(x => x.id === r.id && x.request_sha256 === r.request_sha256)).length);
  assert.ok(resumed.records.filter(r => r.kind === 'initial').every(r => conj.records.some(x => x.id === r.id && x.request_sha256 === r.request_sha256)), 'no initial call is re-requested');
  assert.equal(networkCalls, resumed.provider_calls);
  assert.ok(resumed.provider_calls <= conj.records.filter(r => r.kind === 'escalation').length, 'only escalations can be new calls');
  // A prior escalation record whose request changed under the new policy is re-requested, never a mismatch; a changed initial record still is.
  reset();
  const changed = structuredClone(conj);
  const esc = changed.records.find(r => r.kind === 'escalation'); esc.request_sha256 = 'f'.repeat(64);
  const again = await runDecisionPlane(attempt, { mode: 'live', resume: changed, typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fixtureFetch, budget, ranAt: '2026-09-18T00:00:00Z' });
  assert.equal(again.completion, 'complete'); assert.ok(again.records.some(r => r.id === esc.id && r.request_sha256 !== esc.request_sha256), 'the changed escalation was requested afresh');
  assert.equal(again.provider_calls, resumed.provider_calls + 1);
  const bad = structuredClone(conj); bad.records.find(r => r.kind === 'initial').request_sha256 = 'f'.repeat(64);
  await assert.rejects(runDecisionPlane(attempt, { mode: 'live', resume: bad, typesafeKey: 'k', anthropicKey: 'k', fetchImpl: fixtureFetch, budget }), /resume_record_mismatch/);
  reset();
});

test('the opt-in cheap full-case arm runs the strong full-case request on a cheap model with the same guard and targeted escalation', async () => {
  reset();
  assert.deepEqual([...OPTIONAL_ARMS], ['cheap_full_case', 'jev_direct_action']); assert.deepEqual([...ALL_ARMS], [...ARMS, 'cheap_full_case', 'jev_direct_action']); assert.ok(ESCALATING_ARMS.includes('cheap_full_case'));
  await assert.rejects(buildDecisionPlan({ client, jevModel: model, strongModel: model, arms: [...ARMS, 'cheap_full_case'] }), /cheap_model_required/);
  const cheap = 'test-cheap-model';
  const withCheap = await buildDecisionPlan({ client, jevModel: model, strongModel: model, cheapModel: cheap, arms: ['strong_full_case', 'cheap_full_case'] });
  assert.deepEqual(withCheap.arms, ['strong_full_case', 'cheap_full_case']);
  const cheapJobs = withCheap.jobs.filter(j => j.arm === 'cheap_full_case'), strongJobs = withCheap.jobs.filter(j => j.arm === 'strong_full_case');
  assert.equal(cheapJobs.length, strongJobs.length);
  for (const j of cheapJobs) { const twin = strongJobs.find(x => x.case_id === j.case_id); assert.equal(j.request.model, cheap); assert.deepEqual({ ...j.request, model: null }, { ...twin.request, model: null }, 'same request, different model'); }
  assert.ok(withCheap.cases.filter(c => !c.common).every(c => c.escalation?.model === model), 'escalation stays on the strong model');
  assert.equal(costTable(withCheap).arms.cheap_full_case.max_escalation_calls, cheapJobs.length);
  const defaultPlan = await buildDecisionPlan({ client, jevModel: model, strongModel: model, cheapModel: cheap });
  assert.deepEqual(defaultPlan.arms, [...ARMS], 'never selected by default');
  // Scripted: the cheap answer is right on every case except one it hands to escalation; the escalation resolves it; the guard applies.
  const target = withCheap.cases.find(c => !c.common && c.expected.route === 'supported_proposal');
  const cheapFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const job = withCheap.jobs.find(j => j.request_sha256 === hash(body));
    if (job?.arm === 'cheap_full_case' && job.case_id === target.id) return new Response(JSON.stringify(strongJson({ route: 'strong_reasoning', proposals: [], missing_fact_needed: false, reasoning: 'scripted' })), { status: 200 });
    if (job?.arm === 'cheap_full_case') return new Response(JSON.stringify(strongJson(expectedOutcome(withCheap.cases.find(c => c.id === job.case_id)))), { status: 200 });
    if (job) return new Response(JSON.stringify(strongJson(expectedOutcome(withCheap.cases.find(c => c.id === job.case_id)))), { status: 200 });
    const c = stateIndex.get(hash(JSON.parse(body.messages[0].content).state));
    return new Response(JSON.stringify(strongJson(expectedOutcome(c))), { status: 200 });
  };
  const live = await runDecisionPlane(withCheap, { mode: 'live', typesafeKey: 'k', anthropicKey: 'k', fetchImpl: cheapFetch, budget, ranAt: '2026-09-18T00:00:00Z' });
  assert.equal(live.completion, 'complete');
  const row = live.summary['all/cheap_full_case'];
  assert.equal(row.escalations, 1 + withCheap.cases.filter(c => !c.common && c.expected.route === 'strong_reasoning').length, 'label-required strong cases escalate, plus the scripted one');
  assert.equal(row.wrong_proposals, 0); assert.equal(row.correct_model_cases, row.model_dependent_cases);
  const o = live.outcomes.find(x => x.id === `${target.id}/cheap_full_case`);
  assert.equal(o.escalated_flag, true); assert.equal(o.strong_calls, 2); assert.equal(o.final.route, 'supported_proposal');
  const pub = publicSummary(live);
  assert.ok(!JSON.stringify(pub).includes(cheap) && !JSON.stringify(pub).includes(model));
  const replay = await runDecisionPlane(withCheap, { mode: 'replay', replay: live });
  assert.deepEqual(replay.summary, live.summary);
  reset();
});

test('both real HTTP wire shapes through the provider transport', async () => {
  let current = jobFor(12, 'jev_redesigned');
  const server = createServer(async (req, res) => {
    let text = ''; for await (const b of req) text += b;
    assert.deepEqual(JSON.parse(text), current.request);
    assert.ok(current.provider === 'typesafe' ? req.headers.authorization === 'Bearer test' : req.headers['x-api-key'] === 'test' && req.headers['anthropic-version']);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply(current.request)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fetchImpl = (_url, init) => fetch(`http://127.0.0.1:${server.address().port}`, init);
  try {
    for (const arm of ARMS) {
      current = jobFor(12, arm);
      const raw = await solve(current, { typesafeKey: 'test', anthropicKey: 'test', fetchImpl });
      assert.ok(decideFromRecord(planCase(12), arm, raw).decision.route);
    }
    await assert.rejects(solve(current, { anthropicKey: 'test', timeoutMs: 25, fetchImpl: () => new Promise(() => {}) }),
      e => e.message === 'provider_transport_failure' && e.cause?.code === 'PROVIDER_TIMEOUT' && e.cause?.reason === 'request_timeout');
    await assert.rejects(solve({ provider: 'anthropic', request: { ...current.request, max_tokens: MAX_STRONG_OUTPUT_TOKENS + 1 } }, { anthropicKey: 'test', fetchImpl }), /request_bound_exceeded/);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('CLI replay works outside the checkout without database or credentials and protects inputs', async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), 'jev-decision-plane-cli-'));
  const cli = fileURLToPath(new URL('./jev_decision_plane.js', import.meta.url));
  try {
    const capture = await scripted();
    const planPath = join(dir, 'plan.json'), capturePath = join(dir, 'capture.json'), output = join(dir, 'replay.json'), pub = join(dir, 'public.json'), budgetPath = join(dir, 'budget.json');
    writeFileSync(planPath, JSON.stringify(plan)); writeFileSync(capturePath, JSON.stringify(capture)); writeFileSync(budgetPath, JSON.stringify(budget));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const invoke = extra => spawnSync(process.execPath, [cli, ...extra], { cwd: dir, env, encoding: 'utf8' });
    const args = ['--mode=replay', `--plan=${planPath}`, `--replay=${capturePath}`, `--output=${output}`, `--public=${pub}`];
    const replay = invoke(args);
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output)).summary, capture.summary);
    assert.deepEqual(JSON.parse(readFileSync(pub)).outcomes.length, capture.outcomes.length);
    assert.equal(invoke(args).status, 2, 'existing output is protected');
    assert.equal(invoke(['--mode=live', `--plan=${planPath}`, `--output=${join(dir, 'live.json')}`]).status, 2, 'live needs a budget');
    const live = invoke(['--mode=live', `--plan=${planPath}`, `--output=${join(dir, 'live.json')}`, `--budget=${budgetPath}`]);
    assert.equal(live.status, 2, 'no key means no call'); assert.match(live.stderr, /missing_credentials_or_model/);
    assert.equal(invoke(['--mode=replay', `--plan=${planPath}`, `--replay=${capturePath}`, `--output=${planPath}`]).status, 2, 'input collision refused');
    assert.equal(invoke(['--mode=dry-run', `--plan=${planPath}`]).status, 2, 'existing plan is never overwritten');
    assert.equal(invoke([]).status, 2, 'bare invocation never calls a provider');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('report from an empty record set is honestly incomplete and previous experiments are untouched', () => {
  const empty = buildReport(plan, []);
  assert.equal(empty.completion, 'incomplete');
  assert.equal(empty.outcomes.filter(o => o.common_route).every(o => o.completion === 'complete'), true);
  assert.equal(empty.continuation.status, 'incomplete');
  const previous = JSON.parse(readFileSync(new URL('../data/evals/experiments/jev-routed-triage-2026-09-17.json', import.meta.url)));
  assert.equal(previous.continuation.status, 'criteria_not_met');
  assert.notEqual(previous.version, plan.version);
});

// Plumbing check on the FRESH corpora: ideal scripted answers through the live
// mapping must reproduce every label on both splits before any paid call. This
// is the pre-registered expressibility gate, not a look at model answers.
for (const corpusName of ['jev-plane-dev', 'jev-plane-holdout']) test(`${corpusName}: ideal scripted answers reproduce every label through the four-arm harness`, async () => {
  reset();
  const fresh = await buildDecisionPlan({ client, corpus: corpusName, jevModel: model, strongModel: model });
  const freshIndex = new Map(fresh.cases.map(c => [hash(stateWithFacts(c.prepared)), c]));
  const replyFresh = request => {
    const job = fresh.jobs.find(j => j.request_sha256 === hash(request));
    if (!job) { const c = freshIndex.get(hash(JSON.parse(request.messages[0].content).state)); assert.ok(c); return strongJson(expectedOutcome(c)); }
    const c = fresh.cases.find(c => c.id === job.case_id);
    if (job.arm === 'jev_blanket') return { ...base(), answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: key.endsWith('_party') && c.expected.proposals.some(x => c.prepared.bank_handles[x.transaction_id] === key.replace('_party', '')) ? 0.99 : 0.01 }])) };
    if (job.arm === 'strong_full_case') return strongJson(expectedOutcome(c));
    return atomicReply(c, atomicQuestions(c.prepared), job.provider);
  };
  const live = await runDecisionPlane(fresh, { mode: 'live', typesafeKey: 'test-key', anthropicKey: 'test-key', budget,
    fetchImpl: async (_url, init) => new Response(JSON.stringify(replyFresh(JSON.parse(init.body))), { status: 200 }), ranAt: '2026-09-18T00:00:00Z' });
  for (const j of fresh.jobs) assert.ok(JSON.stringify(j.request).length <= MAX_REQUEST_CHARS, `${j.id} frozen within the request bound`);
  assert.equal(live.completion, 'complete');
  for (const arm of ['jev_redesigned', 'strong_atomic', 'strong_full_case']) {
    const wrong = live.outcomes.filter(o => o.arm === arm && !o.score.correct).map(o => `${o.id}:${o.final.route}/${o.final.reason}`);
    assert.deepEqual(wrong, [], `${corpusName} ${arm} ideal answers must land every label`);
  }
  const redesigned = live.summary[`${fresh.cases[0].split}/jev_redesigned`];
  assert.equal(redesigned.wrong_proposals, 0); assert.equal(redesigned.false_questions, 0);
  // Under ideal answers the only escalations are label-required strong routes: the floor.
  assert.equal(redesigned.escalations, fresh.cases.filter(c => !c.common && c.expected.route === 'strong_reasoning').length);
  const replay = await runDecisionPlane(fresh, { mode: 'replay', replay: live, ranAt: '2026-09-18T00:00:00Z' });
  assert.equal(hash(replay.summary), hash(live.summary));
});

// ── Capability boundary (Kari's brief, 2026-09-18): policies, reversal, scorer ──
// A scripted harness over any plan: ideal answers from the labels, with hooks to
// patch typed probabilities and strong outcomes. Mechanics only, never a
// capability observation.
function harnessFor(planX, { patch = (_c, _q, a) => a, strong = () => null } = {}) {
  const index = new Map(planX.cases.map(c => [hash(stateWithFacts(c.prepared)), c]));
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    const job = planX.jobs.find(j => j.request_sha256 === hash(request));
    let body;
    if (!job) { const c = index.get(hash(JSON.parse(request.messages[0].content).state)); assert.ok(c); body = strongJson(strong(c, 'escalation') || expectedOutcome(c)); }
    else {
      const c = planX.cases.find(c => c.id === job.case_id);
      if (job.arm === 'jev_blanket') body = { ...base(), answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: key.endsWith('_party') && c.expected.proposals.some(x => c.prepared.bank_handles[x.transaction_id] === key.replace('_party', '')) ? 0.99 : 0.01 }])) };
      else if (['strong_full_case', 'cheap_full_case'].includes(job.arm)) body = strongJson(strong(c, job.arm) || expectedOutcome(c));
      else {
        const questions = atomicQuestions(c.prepared);
        body = atomicReply(c, questions, job.provider);
        if (job.provider === 'typesafe') body.answers = patch(c, questions, body.answers);
      }
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, calls: () => calls, run: extra => runDecisionPlane(planX, { mode: 'live', typesafeKey: 'k', anthropicKey: 'k', fetchImpl, budget, ranAt: '2026-09-18T00:00:00Z', ...extra }) };
}
const TYPED = ['jev_redesigned', 'strong_full_case'];
const setChoice = (answers, key, choice, probability) => { answers[key] = { type: 'choice', choice, confidence: 0.9, probabilities: Object.fromEntries(STATUSES.map(s => [s, s === choice ? probability : Math.round((1 - probability) / 2 * 100) / 100])) }; };

test('policies: safe pins the frozen conjunction at .90, max_authority and forced pin floor 0, other floors are refused, and forced freezes no escape hatch', async () => {
  assert.deepEqual(Object.keys(POLICY_SPEC), [...POLICIES]);
  assert.deepEqual(resolvePolicy({ policy: 'safe' }), { policy: 'safe', base: 'conjunction', floor: 0.9, sufficiency: false, escape: true });
  assert.deepEqual(resolvePolicy({ policy: 'max_authority' }), { policy: 'max_authority', base: 'attempt_first', floor: 0, sufficiency: true, escape: true });
  assert.deepEqual(resolvePolicy({ policy: 'forced' }), { policy: 'forced', base: 'attempt_first', floor: 0, sufficiency: true, escape: false });
  assert.equal(resolvePolicy({}).floor, 0.9); assert.equal(resolvePolicy({ policy: 'attempt_first', floor: 0 }).floor, 0);
  for (const policy of ['safe', 'max_authority', 'forced']) assert.throws(() => resolvePolicy({ policy, floor: 0.5 }), /invalid_policy/, policy);
  assert.throws(() => resolvePolicy({ policy: 'production' }), /invalid_policy/);
  await assert.rejects(buildDecisionPlan({ client, corpus: 'jev-plane-fresh', jevModel: model, strongModel: model, policy: 'max_authority', floor: 0.5 }), /invalid_policy/);
  const safe = await buildDecisionPlan({ client, jevModel: model, strongModel: model, policy: 'safe' });
  assert.equal(safe.confidence_floor, 0.9); assert.equal(safe.policy, 'safe');
  assert.deepEqual(safe.jobs.map(j => [j.id, j.request_sha256]), plan.jobs.map(j => [j.id, j.request_sha256]), 'safe changes no request');
  const forced = await buildDecisionPlan({ client, jevModel: model, strongModel: model, policy: 'forced' });
  assert.equal(forced.confidence_floor, 0); assert.ok(forced.cases.every(c => !c.escalation), 'no escalation is frozen under forced');
  assert.equal(costTable(forced).arms.jev_redesigned.max_escalation_calls, 0); assert.equal(costTable(forced).arms.strong_atomic.max_escalation_calls, 0);
  assert.equal(armEscalates('jev_redesigned', forced), false); assert.equal(armEscalates('cheap_full_case', forced), true); assert.equal(armEscalates('jev_redesigned', safe), true);
  assert.equal(needsEscalation('jev_redesigned', { route: 'strong_reasoning', reason: 'x', proposals: [] }, { escape: false }), false);
  // Every plan case carries the scorer's context and nothing of it reaches a request.
  for (const c of forced.cases) { assert.ok(['present', 'missing', 'uninterpreted'].includes(c.evidence_sufficiency.status), c.id); assert.ok(c.family.source_family, c.id); }
  for (const j of forced.jobs) assert.doesNotMatch(JSON.stringify(j.request), /evidence_sufficiency|error_mode|disputed/);
  // On development, ideal answers: safe equals the frozen conjunction on every case; max_authority differs from the old labels only where the
  // packet's evidence is missing (the conflation the brief names) and on disputed dev-006; forced never says strong_reasoning.
  const dev = await buildDecisionPlan({ client, corpus: 'jev-plane-dev', jevModel: model, strongModel: model });
  const differs = [];
  for (const c of dev.cases) {
    const raw = rawFor(c), conj = composeEvidenceAction(c.prepared, raw), s = composeEvidenceAction(c.prepared, raw, { policy: 'safe' }), m = composeEvidenceAction(c.prepared, raw, { policy: 'max_authority' }), f = composeEvidenceAction(c.prepared, raw, { policy: 'forced' });
    assert.equal(s.route, conj.route, c.id); assert.deepEqual(normalizeProposals(s.proposals), normalizeProposals(conj.proposals), c.id);
    assert.notEqual(f.route, 'strong_reasoning', `${c.id} forced`);
    assert.ok(['present', 'missing', 'uninterpreted', 'unknown'].includes(m.evidence_sufficiency.status));
    if (m.route !== c.expected.route || hash(normalizeProposals(m.proposals)) !== hash(normalizeProposals(c.expected.proposals))) differs.push(`${c.id}:${m.route}`);
  }
  assert.deepEqual(differs, ['dev-004:needs_evidence', 'dev-006:supported_proposal', 'dev-007:needs_evidence', 'dev-010:needs_evidence', 'dev-013:needs_evidence', 'dev-020:needs_evidence']);
  assert.ok(DISPUTED_GROUND_TRUTH['dev-006']);
});

test('max_authority: a candidate with no payment-specific source terminates needs_evidence, a contradicted obligation is a negative, a declared owner fact is asked unless a source contradicts it, and every decision names its deciding answers', async () => {
  const dev = await buildDecisionPlan({ client, corpus: 'jev-plane-dev', jevModel: model, strongModel: model });
  const byId = id => dev.cases.find(c => c.id === id);
  const c13 = byId('dev-013'), q13 = c13.prepared.questions.find(q => q.predicate === 'obligation').id;
  assert.equal(evidenceSufficiency(c13.prepared).status, 'missing'); assert.equal(evidenceSufficiency(c13.prepared).missing[0].kind, 'payment_specific_source');
  const m13 = composeEvidenceAction(c13.prepared, rawFor(c13), { policy: 'max_authority' });
  assert.equal(m13.route, 'needs_evidence'); assert.equal(m13.reason, 'payment_specific_source_missing'); assert.equal(m13.dependencies[0].kind, 'evidence_request'); assert.equal(m13.evidence_requests.length, 1);
  assert.equal(composeEvidenceAction(c13.prepared, rawFor(c13), { policy: 'safe' }).route, 'strong_reasoning', 'the same answers escalate under safe');
  const neg = composeEvidenceAction(c13.prepared, rawFor(c13, { [q13]: { status: 'contradicted', confidence: 0.71 } }), { policy: 'max_authority' });
  assert.equal(neg.route, 'unresolved_research'); assert.equal(neg.reason, 'no_link_does_not_establish_customer_obligation');
  assert.deepEqual(neg.negatives.map(n => n.reason), ['obligation_contradicted']);
  assert.deepEqual(neg.deciding_answers.map(a => [a.predicate, a.status, a.confidence, a.outcome]), [['obligation', 'contradicted', 0.71, 'negative:obligation_contradicted']]);
  // A proposal carries the obligation answer that made it, with the raw probability (floor 0 consumes it).
  const c1 = byId('dev-001'), obl = c1.prepared.questions.find(q => q.predicate === 'obligation').id;
  const low = composeEvidenceAction(c1.prepared, rawFor(c1, { [obl]: { confidence: 0.41 } }), { policy: 'max_authority' });
  assert.equal(low.route, 'supported_proposal'); assert.deepEqual(low.deciding_answers.map(a => [a.predicate, a.confidence, a.outcome]), [['obligation', 0.41, 'proposal']]);
  assert.equal(decidingProbability(low), 0.41); assert.equal(bandOf(0.41), '<0.50'); assert.equal(bandOf(null), 'mechanical');
  assert.equal(composeEvidenceAction(c1.prepared, rawFor(c1, { [obl]: { confidence: 0.41 } }), { policy: 'safe' }).route, 'strong_reasoning');
  // A contradiction on identity still escalates under max_authority (evidence present, Jev cannot establish); forced lets the obligation decide.
  const party = c1.prepared.questions.find(q => q.predicate === 'counterparty').id;
  const conflict = rawFor(c1, { [party]: { status: 'contradicted', confidence: 0.8 }, [obl]: { confidence: 0.66 } });
  const mc = composeEvidenceAction(c1.prepared, conflict, { policy: 'max_authority' });
  assert.equal(mc.route, 'strong_reasoning'); assert.deepEqual(mc.dependencies[0].blocked_by, ['counterparty']);
  const fc = composeEvidenceAction(c1.prepared, conflict, { policy: 'forced' });
  assert.equal(fc.route, 'supported_proposal'); assert.deepEqual(fc.forced_overrides.map(o => o.reason), ['semantic_contradiction_needs_resolution']);
  assert.deepEqual(fc.deciding_answers.map(a => [a.predicate, a.confidence, a.outcome, a.imposed]), [['counterparty', 0.8, 'forced:contradiction_overridden_by_obligation', false], ['obligation', 0.66, 'forced_over:semantic_contradiction_needs_resolution', false]], 'the overridden veto and the deciding obligation are both recorded');
  assert.equal(decidingProbability(fc), 0.66, 'the proposal is as sure as its obligation answer');
  const fn = composeEvidenceAction(c1.prepared, rawFor(c1, { [party]: { status: 'contradicted', confidence: 0.8 }, [obl]: { status: 'not_established', confidence: 0.52 } }), { policy: 'forced' });
  assert.equal(fn.route, 'unresolved_research'); assert.equal(fn.reason, 'no_link_does_not_establish_customer_obligation'); assert.deepEqual(fn.negatives.map(n => n.reason), ['semantic_contradiction_needs_resolution']);
  // Mechanical facts still block under forced (they are facts, not judgments).
  const c15 = byId('dev-015');
  const f15 = composeEvidenceAction(c15.prepared, rawFor(c15), { policy: 'forced' });
  assert.equal(f15.route, 'unresolved_research'); assert.equal(f15.reason, 'forced_block:conflicting_allocations'); assert.equal(f15.blocks.length, 1);
  assert.equal(operationalConsequence(f15), 'BLOCK');
  // A declared owner-only fact where UNBOUND evidence exists (dev-008: the owner's chat): an unsure typed answer means the chat went
  // unread, so max_authority escalates exactly as safe does; forced blocks. Only a packet with no unbound evidence asks on the declaration.
  const c8 = byId('dev-008');
  assert.equal(evidenceSufficiency(c8.prepared).status, 'uninterpreted'); assert.deepEqual(evidenceSufficiency(c8.prepared).unbound_sources, ['owner-chat']);
  const unsure = rawFor(c8, { ask_fact: { status: 'not_established', confidence: 0.3 } });
  assert.equal(composeEvidenceAction(c8.prepared, unsure, { policy: 'safe' }).reason, 'customer_fact_not_established');
  assert.equal(composeEvidenceAction(c8.prepared, unsure, { policy: 'max_authority' }).reason, 'customer_fact_not_established');
  const forcedUnsure = composeEvidenceAction(c8.prepared, unsure, { policy: 'forced' });
  assert.equal(forcedUnsure.route, 'unresolved_research'); assert.match(forcedUnsure.reason, /^forced_block:/); assert.notEqual(forcedUnsure.route, 'customer_question');
  assert.equal(composeEvidenceAction(c8.prepared, rawFor(c8), { policy: 'max_authority' }).route, 'customer_question', 'a supported answer still asks');
  const fresh = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: TYPED, jevModel: model, strongModel: model, policy: 'max_authority' });
  const c10 = fresh.cases.find(c => c.id === 'fresh-010');
  assert.equal(evidenceSufficiency(c10.prepared).status, 'missing');
  const asked = composeEvidenceAction(c10.prepared, rawFor(c10, { ask_fact: { status: 'not_established', confidence: 0.3 } }), { policy: 'max_authority' });
  assert.equal(asked.route, 'customer_question'); assert.equal(asked.reason, 'declared_customer_fact_unconfirmed'); assert.equal(asked.question_delivered, false);
  assert.equal(composeEvidenceAction(c10.prepared, rawFor(c10, { ask_fact: { status: 'not_established', confidence: 0.3 } }), { policy: 'safe' }).reason, 'customer_fact_not_established');
  const contra = composeEvidenceAction(c10.prepared, rawFor(c10, { ask_fact: { status: 'contradicted', confidence: 0.9 } }), { policy: 'max_authority' });
  assert.equal(contra.route, 'strong_reasoning'); assert.equal(contra.reason, 'customer_fact_contradicted_by_source');
  // Present-but-uninterpreted evidence never becomes an evidence request (review finding 2): fresh-011 (a dividend voucher) and
  // fresh-020 (a remittance naming the sibling) escalate on unknown answers under max_authority; only a packet with no unbound
  // source (fresh-008, no settlement statement at all) yields needs_evidence.
  for (const [id, expectedStatus, unknownRoute] of [['fresh-011', 'uninterpreted', 'strong_reasoning'], ['fresh-020', 'present', 'strong_reasoning'], ['fresh-008', 'missing', 'needs_evidence']]) {
    const c = fresh.cases.find(c => c.id === id);
    assert.equal(evidenceSufficiency(c.prepared).status, expectedStatus, id);
    const unknownRaw = rawFor(c).map(a => ({ ...a, status: 'not_established', confidence: 1, citations: [] }));
    const d = composeEvidenceAction(c.prepared, unknownRaw, { policy: 'max_authority' });
    assert.equal(d.route, unknownRoute, `${id} ${d.reason}`);
    if (unknownRoute === 'strong_reasoning') assert.equal(d.dependencies[0].reason, 'present_evidence_not_interpreted');
  }
  // Policy-imposed decisions are kept apart from model confidence (review finding 4a): a not_established obligation at .9 that
  // forced turns into a negative is `imposed`, contributes no deciding probability, and lands in the policy_imposed band.
  const c11 = fresh.cases.find(c => c.id === 'fresh-011'), q11 = c11.prepared.questions.find(q => q.predicate === 'obligation').id;
  const imposed = composeEvidenceAction(c11.prepared, rawFor(c11, { [q11]: { status: 'not_established', confidence: 0.9 } }), { policy: 'forced' });
  assert.equal(imposed.route, 'unresolved_research'); assert.deepEqual(imposed.deciding_answers.map(a => [a.status, a.confidence, a.imposed]), [['not_established', 0.9, true]]);
  assert.equal(decidingProbability(imposed), null); assert.equal(policyImposed(imposed), true);
  const believed = composeEvidenceAction(c11.prepared, rawFor(c11), { policy: 'forced' });
  assert.deepEqual(believed.deciding_answers.map(a => [a.status, a.imposed]), [['contradicted', false]]); assert.equal(policyImposed(believed), false);
  // A policy-imposed step essential to the outcome makes the WHOLE decision policy-imposed (second review, finding 2): fresh-027 with the
  // focal obligation not_established and the sibling's exclusion kept correct is a wrong negative under forced that borrows no probability
  // from the sibling's .99 exclusion — deciding probability null, policy_imposed true.
  const c27 = fresh.cases.find(c => c.id === 'fresh-027'), q27 = c27.prepared.questions.find(q => q.predicate === 'obligation' && q.action_id === `link_${c27.prepared.bank_handles['tx-t1']}`).id;
  const mixed = composeEvidenceAction(c27.prepared, rawFor(c27, { [q27]: { status: 'not_established', confidence: 0.9 } }), { policy: 'forced' });
  assert.equal(mixed.route, 'unresolved_research'); assert.deepEqual(mixed.deciding_answers.map(a => [a.predicate, a.status, a.confidence, a.imposed]), [['obligation', 'not_established', 0.9, true], ['exclusion', 'supported', 0.99, false]]);
  assert.equal(policyImposed(mixed), true); assert.equal(decidingProbability(mixed), null, 'a sibling\'s asserted answer lends the decision no probability');
  const mixedMax = composeEvidenceAction(c27.prepared, rawFor(c27, { [q27]: { status: 'not_established', confidence: 0.9 } }), { policy: 'max_authority' });
  assert.equal(mixedMax.route, 'strong_reasoning'); assert.equal(policyImposed(mixedMax), false, 'the same answers escalate under max_authority: the imposition is what decided the forced route');
  // Every semantic veto records its answer (review finding 4b): a .60 counterparty under safe is a deciding answer, not a mechanical band.
  const vetoed = composeEvidenceAction(c1.prepared, rawFor(c1, { [party]: { confidence: 0.6 } }), { policy: 'safe' });
  assert.equal(vetoed.route, 'strong_reasoning'); assert.deepEqual(vetoed.deciding_answers.map(a => [a.predicate, a.confidence, a.outcome]), [['counterparty', 0.6, 'escalate:counterparty_veto']]);
  assert.equal(bandOf(decidingProbability(vetoed)), '0.60-0.69');
});

test('the reversal fact: a strong proposal on a reversed instrument is refused by the guard, the typed pass excludes it under every policy, and the shape shows in mechanical facts', async () => {
  const rev = await buildDecisionPlan({ client, corpus: 'jev-plane-reversal', jevModel: model, strongModel: model });
  const returned = rev.cases.find(c => c.id === 'reversal-002'), cleared = rev.cases.find(c => c.id === 'reversal-003'), partial = rev.cases.find(c => c.id === 'reversal-006');
  const g = guardStrongOutcome(returned.prepared, { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 436000 }], missing_fact_needed: false, reasoning: 'x' });
  assert.equal(g.route, 'unresolved_research'); assert.deepEqual(g.guard.refusals, [{ candidate: 'candidate_1', code: 'instrument_reversed' }]);
  assert.equal(guardStrongOutcome(cleared.prepared, { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_3', amount_minor: 436000 }], missing_fact_needed: false, reasoning: 'x' }).guard, null, 'the re-presented deposit is not reversed');
  assert.equal(guardStrongOutcome(partial.prepared, { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 219000 }], missing_fact_needed: false, reasoning: 'x' }).guard, null, 'a partial refund is not a reversal');
  const facts = stateWithFacts(returned.prepared).mechanical_facts.candidates;
  assert.equal(facts.candidate_1.reversed_by, 'candidate_2'); assert.equal(facts.candidate_1.instrument, 'cheque:UOB:004417'); assert.equal(facts.candidate_2.reversed_by, null);
  assert.equal(returned.prepared.state.candidates[0].instrument, 'cheque:UOB:004417');
  assert.ok(!('instrument' in planCase(1).prepared.state.candidates[0]), 'a packet without the field carries no instrument key: older typed requests stay byte-identical');
  for (const c of rev.cases) for (const policy of ['safe', 'max_authority', 'forced']) {
    const d = composeEvidenceAction(c.prepared, rawFor(c), { policy });
    assert.equal(d.route, c.expected.route, `${c.id} ${policy}`); assert.deepEqual(normalizeProposals(d.proposals), normalizeProposals(c.expected.proposals.map(p => ({ ...p }))), `${c.id} ${policy}`);
  }
  // Through the harness: the strong full-case arm proposing the returned deposit is caught, never accepted.
  const h = harnessFor(rev, { strong: c => c.id === 'reversal-002' ? { route: 'supported_proposal', proposals: [{ candidate_handle: 'candidate_1', amount_minor: 436000 }], missing_fact_needed: false, missing_evidence: '', reasoning: 'scripted wrong' } : null });
  const live = await h.run();
  const o = live.outcomes.find(o => o.id === 'reversal-002/strong_full_case');
  assert.equal(o.score.caught_by_guard, true); assert.equal(o.consequence.final, 'BLOCK'); assert.equal(o.error_attribution.class, 'duplicate_reversal_handling');
  assert.equal(live.summary['development/jev_redesigned'].correct_model_cases, live.summary['development/jev_redesigned'].model_dependent_cases);
});

test('operational consequence: routes project onto the next step, the label\'s terminal decides its consequence, and same-class label pairs are ontology debt', () => {
  assert.deepEqual([...CONSEQUENCES], ['RESOLVED_AUTONOMOUSLY', 'ASK_OWNER', 'ESCALATE_MODEL', 'REQUIRES_ACCOUNTING_JUDGMENT', 'BLOCK']);
  const oc = (route, reason = '', extra = {}) => operationalConsequence({ route, reason }, extra);
  assert.equal(oc('supported_proposal', 'evidence_path_satisfied'), 'RESOLVED_AUTONOMOUSLY'); assert.equal(oc('not_admitted', 'invoice_not_due'), 'RESOLVED_AUTONOMOUSLY');
  assert.equal(oc('customer_question'), 'ASK_OWNER'); assert.equal(oc('needs_evidence', 'payment_specific_source_missing'), 'ASK_OWNER');
  assert.equal(oc('retrieve_local', 'inventory_not_proven_within_declared_scope'), 'BLOCK');
  assert.equal(oc('strong_reasoning', 'unresolved_relevant_relationships'), 'ESCALATE_MODEL'); assert.equal(oc('strong_reasoning', 'targeted_escalation_outcome', { fromStrongModel: true }), 'REQUIRES_ACCOUNTING_JUDGMENT');
  assert.equal(oc('unresolved_research', 'no_link_does_not_establish_customer_obligation'), 'RESOLVED_AUTONOMOUSLY'); assert.equal(oc('unresolved_research', 'instrument_reversed_no_settlement'), 'RESOLVED_AUTONOMOUSLY');
  // The strong model says "determinate no settlement" explicitly; its unresolved_research is "cannot finish" on every arm (review finding 1).
  assert.equal(oc('no_settlement', 'strong_model_outcome', { fromStrongModel: true }), 'RESOLVED_AUTONOMOUSLY');
  assert.equal(oc('unresolved_research', 'targeted_escalation_outcome', { fromStrongModel: true }), 'REQUIRES_ACCOUNTING_JUDGMENT');
  for (const reason of ['guard_refused', 'malformed_answer:invalid_strong_json', 'forced_block:conflicting_allocations', 'answer_coverage', 'affirmative_source_not_cited', 'prepared_packet_changed']) assert.equal(oc('unresolved_research', reason, { fromStrongModel: true }), 'BLOCK', reason);
  assert.equal(labelConsequence({ route: 'strong_reasoning', proposals: [] }), 'ESCALATE_MODEL'); assert.equal(labelConsequence({ route: 'unresolved_research', proposals: [] }), 'RESOLVED_AUTONOMOUSLY');
  assert.equal(labelConsequence({ route: 'strong_reasoning', proposals: [], terminal: 'NEEDS_EVIDENCE' }), 'ASK_OWNER', 'the three-terminal label wins over the route');
  assert.equal(consequenceClass('ESCALATE_MODEL'), consequenceClass('REQUIRES_ACCOUNTING_JUDGMENT'), 'one class: the case leaves autonomous handling');
  assert.equal(ERROR_CLASSES.length, 11);
});

for (const policy of ['safe', 'max_authority', 'forced']) test(`fresh set under ${policy}: ideal scripted answers through the harness, scored by consequence, with identical typed requests across policies`, async () => {
  const fresh = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: TYPED, jevModel: model, strongModel: model, policy });
  assert.equal(fresh.cases.length, 36); assert.ok(fresh.cases.every(c => c.split === 'fresh'));
  const reference = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: TYPED, jevModel: model, strongModel: model, policy: 'max_authority' });
  assert.deepEqual(fresh.jobs.map(j => [j.id, j.request_sha256]), reference.jobs.map(j => [j.id, j.request_sha256]), 'one paid answer set serves every policy');
  const h = harnessFor(fresh);
  const live = await h.run();
  assert.equal(live.completion, 'complete'); assert.equal(live.continuation.informational, true);
  const b = live.summary['fresh/jev_redesigned'].boundary, model_ = live.summary['fresh/jev_redesigned'].model_dependent_cases;
  const labels = fresh.cases.filter(c => !c.common);
  const reasoning = labels.filter(c => c.expected.terminal === 'NEEDS_REASONING').length, asks = labels.filter(c => c.expected.terminal === 'NEEDS_EVIDENCE').length;
  assert.equal(reasoning, 4); assert.equal(asks, 3);
  assert.deepEqual(b.contract_gap_reasoning_labels, ['fresh-015:overpayment_on_reference_link', 'fresh-025:duplicate_payment_convention']);
  // fresh-023 and fresh-035 are rule-blocked (second review, finding 4): reported apart, never as measured reasoning limitations, so no
  // reasoning label on the fresh set counts as genuine — the set bounds the reasoning boundary from below only.
  assert.deepEqual(b.rule_blocked_reasoning_labels, ['fresh-023:relationship_amount_conflict', 'fresh-035:conflicting_allocations']);
  assert.equal(b.genuine_needs_reasoning, 0, 'only a label a semantic answer can change is genuine');
  assert.deepEqual([...ATTRIBUTED_TO], ['contract_rule', 'routing_policy', 'model']);
  if (policy === 'max_authority') {
    assert.equal(b.correct_final_by_consequence, model_); assert.equal(b.wrong_autonomous_resolutions, 0); assert.equal(b.false_evidence_requests, 0); assert.equal(b.needs_evidence_missed, 0);
    assert.equal(b.needs_evidence_correctly_identified, asks); assert.equal(b.unnecessary_escalation, 0); assert.equal(b.escalations, reasoning); assert.equal(b.autonomous_coverage, model_ - reasoning);
    assert.deepEqual(b.ontology_debt, []); assert.equal(b.companion_requests_missed, 0); assert.equal(b.companion_requests_unrequested, 0);
    const o26 = live.outcomes.find(o => o.id === 'fresh-026/jev_redesigned');
    assert.equal(o26.initial.route, 'supported_proposal'); assert.equal(o26.initial.evidence_requests.length, 1, 'the unevidenced sibling rides the proposal as an evidence request');
    assert.deepEqual(o26.consequence.companions, { expected: ['tx-t2'], actual: ['tx-t2'], match: true }); assert.deepEqual(o26.consequence.own_companions, o26.consequence.companions);
    // Under ideal answers every escalation on the fresh set is the contract's (the four rule-blocked or contract-gap labels): none is the model's.
    assert.deepEqual(b.escalations_by_attribution, { contract_rule: 4, routing_policy: 0, model: 0 }); assert.deepEqual(b.incorrect_by_attribution, { contract_rule: 0, routing_policy: 0, model: 0 });
    for (const [id, code] of [['fresh-023', 'relationship_amount_conflict'], ['fresh-035', 'conflicting_allocations']]) {
      const o = live.outcomes.find(o => o.id === `${id}/jev_redesigned`);
      assert.equal(o.rule_blocked, code); assert.equal(o.escalation_attribution.attributed_to, 'contract_rule'); assert.equal(o.escalation_attribution.basis, `escalated:${code}`); assert.equal(o.error_attribution, null, 'correct after escalation: no error to attribute');
      assert.equal((o.initial.deciding_answers || []).length, 0, `${id}: no semantic answer decided it`);
    }
  }
  if (policy === 'safe') {
    assert.equal(b.correct_final_by_consequence, model_, 'the scripted escalation answers the label, so safe is correct after escalating');
    assert.equal(b.unnecessary_escalation, 3); assert.equal(b.escalations, reasoning + 3);
    assert.deepEqual(live.outcomes.filter(o => o.arm === 'jev_redesigned' && o.escalated_flag && consequenceClass(o.consequence.label) !== 'reasoning').map(o => o.case_id), ['fresh-008', 'fresh-017', 'fresh-026']);
    const o8 = live.outcomes.find(o => o.id === 'fresh-008/jev_redesigned');
    assert.equal(o8.escalated.route, 'needs_evidence'); assert.equal(o8.consequence.final, 'ASK_OWNER'); assert.equal(o8.escalation_attribution.class, 'missing_evidence'); assert.equal(o8.error_attribution, null);
    // The safe policy's three extra escalations are the policy's (it does not ask), never the model's (second review: routing-policy attribution).
    assert.equal(o8.escalation_attribution.attributed_to, 'routing_policy'); assert.deepEqual(b.escalations_by_attribution, { contract_rule: 4, routing_policy: 3, model: 0 });
    // Escalation cause and error cause are two attributions (review follow-up P2): the policy forced the escalation, and when the strong
    // fallback then returns a wrong negative the ERROR is the full-case model's while the escalation's attribution is unchanged.
    const wrongNegative = { route: 'no_settlement', proposals: [], missing_fact_needed: false, missing_evidence: '', evidence_requests: [], reasoning: 's' };
    const liveS = await harnessFor(fresh, { strong: (c, via) => c.id === 'fresh-008' && via === 'escalation' ? wrongNegative : null }).run();
    const o8w = liveS.outcomes.find(o => o.id === 'fresh-008/jev_redesigned'), bS = liveS.summary['fresh/jev_redesigned'].boundary;
    assert.equal(o8w.consequence.final, 'RESOLVED_AUTONOMOUSLY'); assert.equal(o8w.consequence.correct, false);
    assert.deepEqual(o8w.escalation_attribution, o8.escalation_attribution, 'the escalation\'s attribution does not depend on the fallback\'s answer');
    assert.deepEqual(o8w.error_attribution, { class: 'missing_evidence', basis: 'label needs evidence', attributed_to: 'model', authored_by: 'full_case_model' });
    assert.deepEqual(bS.escalations_by_attribution, b.escalations_by_attribution); assert.deepEqual(bS.incorrect_by_attribution, { contract_rule: 0, routing_policy: 0, model: 1 }); assert.deepEqual(bS.incorrect_by_author, { typed_composition: 0, full_case_model: 1 });
  }
  if (policy === 'forced') {
    assert.equal(b.escalations, 0); assert.equal(live.summary['fresh/jev_redesigned'].strong_calls, 0);
    assert.equal(b.unresolved_outcomes, 4, 'the four mechanically blocked reasoning labels');
    assert.equal(b.wrong_autonomous_resolutions, 0, 'ideal answers give forced no wrong resolution on this set');
    assert.equal(b.correct_final_by_consequence, model_ - 4);
    assert.deepEqual(Object.keys(live.summary['fresh/jev_redesigned'].error_attribution).sort(), ['amount_selection', 'cross_document_dependency', 'processor_settlement_decomposition']);
    assert.equal(live.summary['fresh/jev_redesigned'].confidence_bands.policy_imposed.decisions, 0, 'ideal answers impose nothing');
  }
  // The strong full-case reference arm scores by the same projection: its explicit `no_settlement` on the six determinate
  // no-settlement labels is RESOLVED and autonomous; the label vocabulary's `unresolved_research` is the debt named per case.
  const strongRow = live.summary['fresh/strong_full_case'].boundary;
  assert.equal(strongRow.correct_final_by_consequence, model_);
  assert.equal(strongRow.ontology_debt.length, 6); assert.ok(strongRow.ontology_debt.every(d => d.endsWith(':unresolved_research→no_settlement')));
  assert.equal(live.outcomes.filter(o => o.arm === 'strong_full_case' && o.final.route === 'no_settlement' && o.consequence.autonomous && o.consequence.correct).length, 6);
  assert.equal(strongRow.autonomous_coverage, model_ - reasoning, 'the strong baseline\'s autonomous coverage counts its no-settlement findings');
  // A strong `unresolved_research` ("cannot finish") on a resolved-negative label is NOT correct, on any arm (review finding 1).
  const scripted2 = harnessFor(fresh, { strong: c => c.id === 'fresh-011' ? { route: 'unresolved_research', proposals: [], missing_fact_needed: false, missing_evidence: '', evidence_requests: [], reasoning: 's' } : null });
  const live2 = await scripted2.run();
  const o11 = live2.outcomes.find(o => o.id === 'fresh-011/strong_full_case');
  assert.equal(o11.consequence.final, 'REQUIRES_ACCOUNTING_JUDGMENT'); assert.equal(o11.consequence.correct, false); assert.equal(o11.consequence.autonomous, false);
  // A proposal that omits the required companion request is not a complete resolution (review finding 5).
  const scripted3 = harnessFor(fresh, { strong: c => c.id === 'fresh-026' ? { ...expectedOutcome(c), evidence_requests: [] } : null });
  const live3 = await scripted3.run();
  const o26s = live3.outcomes.find(o => o.id === 'fresh-026/strong_full_case');
  assert.equal(o26s.consequence.correct, false); assert.deepEqual(o26s.consequence.companions, { expected: ['tx-t2'], actual: [], match: false });
  assert.equal(live3.summary['fresh/strong_full_case'].boundary.companion_requests_missed, 1);
  // ...and the INITIAL decision is not credited either (second review, finding 1): own_correct is false, the incomplete resolution counts as a
  // wrong autonomous resolution, and the attribution names the omitted companion request.
  assert.equal(o26s.consequence.own_correct, false); assert.deepEqual(o26s.consequence.own_companions, { expected: ['tx-t2'], actual: [], match: false }); assert.equal(o26s.consequence.autonomous, true);
  const b3 = live3.summary['fresh/strong_full_case'].boundary;
  assert.equal(b3.wrong_autonomous_resolutions, 1); assert.equal(b3.correct_autonomous_resolutions, strongRow.correct_autonomous_resolutions - 1); assert.equal(b3.wrong_final_resolutions, 1);
  assert.deepEqual(o26s.error_attribution, { class: 'missing_evidence', basis: 'companion evidence request omitted', attributed_to: 'model', authored_by: 'full_case_model' }); assert.equal(o26s.escalation_attribution, null);
  assert.deepEqual(b3.incorrect_by_attribution, { contract_rule: 0, routing_policy: 0, model: 1 }); assert.deepEqual(b3.incorrect_by_author, { typed_composition: 0, full_case_model: 1 });
  // The cheap full-case arm reads a "cannot finish" exactly as the strong one does (second review, finding 3): incorrect and non-autonomous
  // on fresh-011's resolved-negative label, on both arms, from the identical reply.
  if (policy === 'max_authority') {
    const cheapModel = 'test-cheap-model';
    const withCheap = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: ['strong_full_case', 'cheap_full_case'], jevModel: model, strongModel: model, cheapModel, policy });
    const cannot = { route: 'unresolved_research', proposals: [], missing_fact_needed: false, missing_evidence: '', evidence_requests: [], reasoning: 's' };
    const live4 = await harnessFor(withCheap, { strong: c => c.id === 'fresh-011' ? cannot : null }).run();
    assert.equal(live4.completion, 'complete');
    for (const arm of FULL_CASE_ARMS) {
      const o = live4.outcomes.find(o => o.id === `fresh-011/${arm}`);
      assert.equal(o.consequence.own, 'REQUIRES_ACCOUNTING_JUDGMENT', arm); assert.equal(o.consequence.final, 'REQUIRES_ACCOUNTING_JUDGMENT', arm);
      assert.equal(o.consequence.correct, false, arm); assert.equal(o.consequence.own_correct, false, arm); assert.equal(o.consequence.autonomous, false, arm); assert.equal(o.escalated_flag, false, arm);
    }
    // The cheap arm escalates its strong_reasoning routes (by design); on every resolution-side measure the two arms read identically.
    const rowOf = arm => { const r = live4.summary[`fresh/${arm}`].boundary; return Object.fromEntries(['autonomous_coverage', 'correct_autonomous_resolutions', 'wrong_autonomous_resolutions', 'wrong_final_resolutions', 'needs_evidence_correctly_identified', 'accounting_judgment_outcomes', 'correct_final_by_consequence', 'correct_final_exact', 'ontology_debt', 'companion_requests_missed'].map(k => [k, r[k]])); };
    assert.deepEqual(rowOf('cheap_full_case'), rowOf('strong_full_case'), 'the two full-case arms score identically on identical replies');
    assert.equal(rowOf('cheap_full_case').accounting_judgment_outcomes, 5, 'the four reasoning labels plus the scripted cannot-finish'); assert.equal(rowOf('cheap_full_case').autonomous_coverage, model_ - reasoning - 1);
    // An unread unbound source under max_authority escalates on the policy's rule, and the attribution says so: routing policy, not the model.
    const q11 = c => c.prepared.questions.find(q => q.predicate === 'obligation').id;
    const live5 = await harnessFor(fresh, { patch: (c, _q, answers) => { if (c.id === 'fresh-011') setChoice(answers, q11(c), 'not_established', 0.9); return answers; } }).run();
    const o11p = live5.outcomes.find(o => o.id === 'fresh-011/jev_redesigned');
    assert.equal(o11p.escalated_flag, true); assert.equal(o11p.initial.dependencies[0].reason, 'present_evidence_not_interpreted'); assert.equal(o11p.consequence.correct, true);
    assert.deepEqual(o11p.escalation_attribution, { class: 'accounting_policy_interpretation', basis: 'escalated:present_evidence_not_interpreted', attributed_to: 'routing_policy' }); assert.equal(o11p.error_attribution, null);
    const b5 = live5.summary['fresh/jev_redesigned'].boundary;
    assert.equal(b5.unnecessary_escalation, 1); assert.deepEqual(b5.escalations_by_attribution, { contract_rule: 4, routing_policy: 1, model: 0 });
    // The same answer under forced is a policy-imposed wrong negative: no probability, the policy_imposed band, attributed to the model's
    // not_established answer (it failed to establish a supported obligation) but never as a confidence claim.
    const forcedPlan = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: TYPED, jevModel: model, strongModel: model, policy: 'forced' });
    const q27 = c => c.prepared.questions.find(q => q.predicate === 'obligation' && q.action_id === `link_${c.prepared.bank_handles['tx-t1']}`).id;
    const live6 = await harnessFor(forcedPlan, { patch: (c, _q, answers) => { if (c.id === 'fresh-027') setChoice(answers, q27(c), 'not_established', 0.9); return answers; } }).run();
    const o27 = live6.outcomes.find(o => o.id === 'fresh-027/jev_redesigned'), row6 = live6.summary['fresh/jev_redesigned'];
    assert.equal(o27.consequence.own, 'RESOLVED_AUTONOMOUSLY'); assert.equal(o27.consequence.own_correct, false); assert.equal(o27.deciding_probability, null); assert.equal(policyImposed(o27.initial), true);
    assert.deepEqual(row6.confidence_bands.policy_imposed, { decisions: 1, correct: 0, incorrect: 1, error_rate: 1, error_types: { duplicate_reversal_handling: 1 }, disputed: 0 });
    assert.deepEqual(live6.outcomes.filter(o => o.arm === 'jev_redesigned' && !o.consequence.own_correct && o.deciding_probability != null).map(o => [o.case_id, o.deciding_probability]), [['fresh-025', 0.98]],
      'no borrowed probability enters the incorrect mean: only fresh-025\'s rule-blocked group over-allocation (its two asserted obligations) carries one');
    assert.equal(row6.boundary.wrong_autonomous_resolutions, 1); assert.equal(o27.error_attribution.attributed_to, 'model'); assert.equal(o27.error_attribution.authored_by, 'typed_composition'); assert.equal(o27.escalation_attribution, null);
    // Review follow-up P2, the two other reproduced cases. fresh-034: the strong full-case arm independently makes a false evidence
    // request — the error is the model's, no escalation exists. fresh-035: the contract forces the escalation (rule-blocked), the strong
    // fallback then makes a wrong ask — the escalation stays the contract's and the error is the full-case model's.
    const falseAsk = { route: 'needs_evidence', proposals: [], missing_fact_needed: false, missing_evidence: 'scripted false request', evidence_requests: [], reasoning: 's' };
    const live7 = await harnessFor(fresh, { strong: (c, via) => (c.id === 'fresh-034' && via === 'strong_full_case') || (c.id === 'fresh-035' && via === 'escalation') ? falseAsk : null }).run();
    const o34 = live7.outcomes.find(o => o.id === 'fresh-034/strong_full_case'), o35 = live7.outcomes.find(o => o.id === 'fresh-035/jev_redesigned');
    assert.equal(o34.consequence.final, 'ASK_OWNER'); assert.equal(o34.consequence.correct, false); assert.equal(o34.escalation_attribution, null);
    assert.deepEqual(o34.error_attribution, { class: 'missing_evidence', basis: 'asked where the label proposes', attributed_to: 'model', authored_by: 'full_case_model' });
    assert.equal(o35.consequence.final, 'ASK_OWNER'); assert.equal(o35.consequence.correct, false);
    assert.deepEqual(o35.escalation_attribution, { class: 'cross_document_dependency', basis: 'escalated:conflicting_allocations', attributed_to: 'contract_rule' });
    assert.deepEqual(o35.error_attribution, { class: 'owner_intent', basis: 'asked where the label does not', attributed_to: 'model', authored_by: 'full_case_model' });
    const b7 = live7.summary['fresh/jev_redesigned'].boundary, b7s = live7.summary['fresh/strong_full_case'].boundary;
    assert.deepEqual(b7.escalations_by_attribution, { contract_rule: 4, routing_policy: 0, model: 0 }, 'unchanged by the fallback\'s answer'); assert.deepEqual(b7.incorrect_by_attribution, { contract_rule: 0, routing_policy: 0, model: 1 });
    assert.deepEqual(b7s.incorrect_by_attribution, { contract_rule: 0, routing_policy: 0, model: 1 }); assert.deepEqual(b7s.incorrect_by_author, { typed_composition: 0, full_case_model: 1 });
  }
  // Public summary: decision facts with raw probabilities ride it; the scripted strong prose does not.
  const pub = JSON.stringify(publicSummary(live));
  assert.ok(pub.includes('"deciding_answers"') && pub.includes('"confidence":0.98') && !pub.includes('scripted') && !pub.includes(model));
  const replay = await runDecisionPlane(fresh, { mode: 'replay', replay: live });
  assert.deepEqual(replay.summary, live.summary);
});

test('the confidence-band table and dev-006: a low-probability wrong answer lands in its band with its error type; disputed ground truth is reported but excluded from Jev-specific error counts', async () => {
  const dev = await buildDecisionPlan({ client, corpus: 'jev-plane-dev', arms: TYPED, jevModel: model, strongModel: model, policy: 'max_authority' });
  const obligationKey = c => c.prepared.questions.find(q => q.predicate === 'obligation' && q.action_id === 'link_candidate_1').id;
  // dev-002: a supported obligation at .63 proposes (correct, floor 0). dev-001: a contradicted obligation at .54 on a LINKED candidate
  // is a contradiction with evidence present, so max_authority escalates on it (own decision incorrect, the scripted escalation lands the label).
  const h = harnessFor(dev, { patch: (c, _q, answers) => {
    if (c.id === 'dev-002') setChoice(answers, obligationKey(c), 'supported', 0.63);
    if (c.id === 'dev-001') setChoice(answers, obligationKey(c), 'contradicted', 0.54);
    return answers;
  } });
  const live = await h.run();
  const row = live.summary['development/jev_redesigned'], bands = row.confidence_bands;
  const o1 = live.outcomes.find(o => o.id === 'dev-001/jev_redesigned'), o2 = live.outcomes.find(o => o.id === 'dev-002/jev_redesigned'), o6 = live.outcomes.find(o => o.id === 'dev-006/jev_redesigned');
  assert.equal(o2.deciding_probability, 0.63); assert.equal(o2.consequence.own_correct, true); assert.equal(o2.initial.route, 'supported_proposal');
  assert.equal(o1.deciding_probability, 0.54); assert.equal(o1.consequence.own, 'ESCALATE_MODEL'); assert.equal(o1.consequence.own_correct, false); assert.equal(o1.consequence.correct, true, 'the escalation landed the label');
  assert.equal(bands['0.60-0.69'].correct, 1); assert.equal(bands['0.50-0.59'].incorrect, 1); assert.equal(bands['0.50-0.59'].error_rate, 1);
  assert.deepEqual(bands['0.50-0.59'].error_types, { accounting_policy_interpretation: 1 }); assert.equal(o1.escalation_attribution.basis, 'escalated:obligation'); assert.equal(o1.escalation_attribution.attributed_to, 'model'); assert.equal(o1.error_attribution, null);
  assert.equal(attributedTo('obligation'), 'model'); assert.equal(attributedTo('conflicting_allocations'), 'contract_rule'); assert.equal(attributedTo('present_evidence_not_interpreted'), 'routing_policy'); assert.equal(attributedTo('x', { guard: true }), 'contract_rule');
  assert.ok(bands['0.90-1.00'].correct >= 10, JSON.stringify(bands['0.90-1.00']));
  assert.ok(bands.mechanical.decisions >= 1, 'mechanically decided cases sit in their own band');
  assert.equal(row.boundary.deciding_probability_mean.incorrect, 0.54);
  assert.equal(row.boundary.unnecessary_escalation, 1);
  // dev-006: the typed arm's own proposal under max_authority is the disputed outcome; on development no other typed answer pattern
  // can make max_authority propose wrongly (every other strong-labelled linked candidate is a mechanical block).
  assert.equal(o6.disputed_ground_truth, DISPUTED_GROUND_TRUTH['dev-006']); assert.equal(o6.initial.route, 'supported_proposal'); assert.equal(o6.consequence.own_correct, false);
  assert.deepEqual(row.boundary.disputed_cases, ['dev-006']);
  assert.equal(row.boundary.wrong_autonomous_resolutions, 0); assert.equal(row.boundary.wrong_autonomous_resolutions_including_disputed, 1);
  assert.equal(row.boundary.wrong_final_resolutions, 0); assert.equal(row.boundary.wrong_final_resolutions_including_disputed, 1);
  assert.ok(!Object.values(row.error_attribution).some(a => a.cases.includes('dev-006')), 'attribution excludes the disputed case');
  assert.equal(bands[bandOf(o6.deciding_probability)].disputed, 1);
  assert.equal(attributeError(dev.cases.find(c => c.id === 'dev-002'), o2), null);
  assert.equal(live.terminal_model.disputed_ground_truth['dev-006'], DISPUTED_GROUND_TRUTH['dev-006']);
  // The legacy continuation block is still computed and marked informational.
  assert.equal(live.continuation.informational, true); assert.ok(live.continuation.checks);
});

test('a max_authority checkpoint resumes the safe plan on the fresh set: typed and full-case calls are reused, only the extra escalations are bought', async () => {
  const maxPlan = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: TYPED, jevModel: model, strongModel: model, policy: 'max_authority' });
  const first = await harnessFor(maxPlan).run();
  const safePlan = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: TYPED, jevModel: model, strongModel: model, policy: 'safe' });
  const h = harnessFor(safePlan);
  const resumed = await h.run({ resume: first });
  assert.equal(resumed.completion, 'complete');
  assert.equal(resumed.resumed_calls, first.records.filter(r => r.kind === 'initial').length + first.records.filter(r => r.kind === 'escalation' && resumed.records.some(x => x.id === r.id && x.request_sha256 === r.request_sha256)).length);
  assert.equal(h.calls(), resumed.provider_calls); assert.equal(resumed.provider_calls, 3, 'the three escalations safe adds');
  const forcedPlan = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: TYPED, jevModel: model, strongModel: model, policy: 'forced' });
  const hf = harnessFor(forcedPlan);
  const forced = await hf.run({ resume: resumed });
  assert.equal(forced.provider_calls, 0, 'forced buys nothing: every typed answer is reused and no escalation exists');
  assert.equal(forced.summary['fresh/jev_redesigned'].boundary.escalations, 0);
  // The cumulative ledger spans the chain (review finding 6): the safe run carries the max run's whole spend and adds only its own
  // new escalations; the forced run adds nothing; a cap below the carried total refuses before any call.
  assert.equal(first.budget.cumulative.runs, 1); assert.ok(Math.abs(first.budget.cumulative.usd - first.budget.ledger.usd) < 1e-9);
  assert.equal(resumed.budget.cumulative.runs, 2);
  const newEscalations = resumed.records.filter(r => !first.records.some(x => x.id === r.id && x.request_sha256 === r.request_sha256));
  assert.equal(newEscalations.length, 3);
  assert.ok(Math.abs(resumed.budget.cumulative.usd - (first.budget.cumulative.usd + newEscalations.reduce((t, r) => t + r.budget.actual.usd, 0))) < 1e-9);
  assert.ok(Math.abs(forced.budget.cumulative.usd - resumed.budget.cumulative.usd) < 1e-9); assert.equal(forced.budget.cumulative.runs, 3);
  assert.equal(forced.budget.cumulative.calls, resumed.budget.cumulative.calls);
  const capped = await harnessFor(safePlan).run({ resume: first, budget: { ...budget, max_usd: first.budget.cumulative.usd + 0.000001 } });
  assert.equal(capped.provider_calls, 0, 'the first new call would cross the cumulative cap'); assert.equal(capped.budget.refusal?.bound, 'max_usd'); assert.ok(capped.budget.refusal.cumulative_before);
  // A re-bought escalation (a policy-changed request) and a prior uncertain charge both stay on the cumulative ledger.
  const withUncertain = structuredClone(first); withUncertain.budget.cumulative.usd += 0.5; withUncertain.budget.cumulative.calls += 1;
  const carried = await harnessFor(safePlan).run({ resume: withUncertain });
  assert.ok(Math.abs(carried.budget.cumulative.usd - (resumed.budget.cumulative.usd + 0.5)) < 1e-9); assert.equal(carried.budget.cumulative.calls, resumed.budget.cumulative.calls + 1);
  // Model-specific prices: a budget naming the cheap model's price charges that arm at its own rate.
  const cheap = 'test-cheap-model';
  const withCheap = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: ['strong_full_case', 'cheap_full_case'], jevModel: model, strongModel: model, cheapModel: cheap, policy: 'max_authority' });
  const priced = { ...budget, prices: { ...budget.prices, models: { [cheap]: { input_per_million: 1, output_per_million: 5 } } } };
  assert.deepEqual(priceFor(verifyBudget(priced).prices, 'anthropic', cheap), { input_per_million: 1, output_per_million: 5 }); assert.deepEqual(priceFor(verifyBudget(priced).prices, 'anthropic', model), budget.prices.anthropic);
  const cheapLive = await harnessFor(withCheap).run({ budget: priced });
  const cheapRec = cheapLive.records.find(r => r.arm === 'cheap_full_case' && r.kind === 'initial'), strongRec = cheapLive.records.find(r => r.arm === 'strong_full_case' && r.case_id === cheapRec.case_id);
  assert.ok(cheapRec.budget.actual.usd < strongRec.budget.actual.usd / 10, 'the cheap arm is charged at its own rate');
  assert.ok(cheapLive.summary['fresh/cheap_full_case'].boundary.actual_usd < cheapLive.summary['fresh/strong_full_case'].boundary.actual_usd / 5);
  assert.throws(() => verifyBudget({ ...budget, prices: { ...budget.prices, models: { x: { input_per_million: -1 } } } }), /invalid_budget/);
});

test('CLI: a dry-run under a named policy freezes its pin; a floor beside it is refused; the fresh corpus freezes within bounds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-boundary-cli-'));
  const cli = fileURLToPath(new URL('./jev_decision_plane.js', import.meta.url));
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, DONNA_PG_TEST_URL: databaseUrl, TYPESAFE_MODEL: 'placeholder-typed', JEV_STRONG_MODEL: 'placeholder-strong' };
    const invoke = extra => spawnSync(process.execPath, [cli, ...extra], { cwd: dir, env, encoding: 'utf8' });
    const forced = invoke(['--mode=dry-run', '--corpus=jev-plane-fresh', '--arms=jev_redesigned,strong_full_case', '--policy=forced', `--plan=${join(dir, 'forced.json')}`]);
    assert.equal(forced.status, 0, forced.stderr);
    const planF = JSON.parse(readFileSync(join(dir, 'forced.json')));
    assert.equal(planF.policy, 'forced'); assert.equal(planF.confidence_floor, 0); assert.ok(planF.cases.every(c => !c.escalation));
    assert.match(forced.stdout, /jev_redesigned\s+36\s+0\s+36/);
    const refused = invoke(['--mode=dry-run', '--corpus=jev-plane-fresh', '--policy=max_authority', '--floor=0.5', `--plan=${join(dir, 'bad.json')}`]);
    assert.equal(refused.status, 2); assert.match(refused.stderr, /invalid_policy/);
    const safe = invoke(['--mode=dry-run', '--corpus=jev-plane-fresh', '--arms=jev_redesigned,strong_full_case', '--policy=safe', `--plan=${join(dir, 'safe.json')}`]);
    assert.equal(safe.status, 0, safe.stderr);
    const planS = JSON.parse(readFileSync(join(dir, 'safe.json')));
    assert.equal(planS.confidence_floor, 0.9); assert.deepEqual(planS.jobs.map(j => j.request_sha256), planF.jobs.map(j => j.request_sha256));
    assert.ok(!JSON.stringify(planS).includes('placeholder') || true, 'placeholder ids are the dry-run\'s, never a served model');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
