import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { hash, prepareEvidencePacket } from './jev_evidence_action_contract.js';
import { ROOT, ARMS, ALL_ARMS, OPTIONAL_ARMS, ESCALATING_ARMS, CODE_FILES, buildDecisionPlan, verifyPlan, verifyBudget, costTable, loadCorpus, stateWithFacts, buildReport, validateAtomicResponse, consequenceOf, attributeError, attributeDirectError, needsEscalation, armEscalates, ATTRIBUTED_TO } from './jev_decision_plane_protocol.js';
import { runDecisionPlane, publicSummary } from './jev_decision_plane.js';
import { ARM, ABSTAIN, PRINCIPAL_QUESTION, MAX_MENU_PLANS, MAX_COMBINATION_CANDIDATES, ACTION_VOCABULARY, EXCLUSION_REASONS, EXAMPLE_SHAPES, DIRECT_SCORING_VERSION, LEGACY_SCORING_VERSION, generateMenu, candidateFacts, allocationsFor, directQuestions, projectPlan, planConsequences, expectedConsequences, compareConsequences, planMatches, representability, validatePlan, decideDirectAction, scoreDirectDecision, planText, describePlanShape, nonStructuralSources, abstainPlan } from './jev_direct_action.js';
import { diagnose, NAMED_CASES } from './jev_refusal_diagnosis.js';
import { renderExamples } from './jev_direct_action_examples.js';
import { coverageReport, renderCoverage } from './jev_direct_action_coverage.js';

const databaseUrl = process.env.DONNA_PG_TEST_URL;
if (!databaseUrl) throw new Error('INCOMPLETE: DONNA_PG_TEST_URL must provide disposable PostgreSQL for actual eligibility SQL');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
test.after(async () => { await client.end(); });
const model = 'test-provider-model';
const corpus = loadCorpus('jev-plane-fresh'), directCorpus = loadCorpus('jev-plane-direct');
const fixture = id => corpus.find(f => f.id === id);
// The fresh set is development material since its one live run (brief §6): it
// is used here for regression only, never presented as held-out evidence. The
// direct corpus holds the paired fee/FX regressions (review finding 2).
const plan = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: [ARM], jevModel: model, strongModel: model });
const directPlan = await buildDecisionPlan({ client, corpus: 'jev-plane-direct', arms: [ARM], jevModel: model, strongModel: model });
const planCase = id => (id.startsWith('direct-') ? directPlan : plan).cases.find(c => c.id === id);
const jobFor = id => plan.jobs.find(j => j.case_id === id && j.arm === ARM);
const menuOf = id => generateMenu(planCase(id).prepared);
const planNamed = (id, predicate) => { const m = menuOf(id); const found = m.plans.find(predicate); assert.ok(found, `${id}: no plan matches`); return { menu: m, plan: found }; };
const budget = { approved: true, max_calls: 500, max_input_tokens: 5_000_000, max_output_tokens: 1_000_000, max_usd: 50, prices: { typesafe: { input_per_million: 1, output_per_million: 2 }, anthropic: { input_per_million: 15, output_per_million: 75 } } };
const answerFor = (planId, probability = 0.9) => ({ [PRINCIPAL_QUESTION]: { type: 'choice', choice: planId, probability, probabilities: { [planId]: probability }, provider_confidence: probability } });
const withGrounding = (prepared, planId, answers, handles, p = 0.9) => { for (const h of handles) answers[`${planId}__cites__${h}`] = { type: 'noul', noul: p }; return answers; };
const decideOn = (id, predicate, { grounded = [] } = {}) => { const c = planCase(id), { plan: pl, menu } = planNamed(id, predicate); const answers = withGrounding(c.prepared, pl.id, answerFor(pl.id), grounded);
  const d = decideDirectAction(c.prepared, menu, answers); const ps = scoreDirectDecision(c.prepared, menu, d, c.expected, c.direct_action.representation);
  const o = { arm: ARM, case_id: id, initial: d, final: d, escalated_flag: false, common_route: false, representation: c.direct_action.representation, plan_score: ps }; o.consequence = consequenceOf(c, ARM, o); o.error_attribution = attributeDirectError(c, o); return { c, d, ps, o, plan: pl, menu }; };

// Scripted replies verify mechanics only; they are never capability observations.
// The default script selects the plan the expectation is representable by
// (abstain for a reasoning label) and grounds every non-structural source.
const script = { choose: (c) => c.direct_action.representation.plan_id ?? ABSTAIN, ground: (c, key) => 0.9 };
const reply = (activePlan, request) => {
  const job = activePlan.jobs.find(j => j.request_sha256 === hash(request));
  assert.ok(job, 'every request is a frozen job');
  const c = activePlan.cases.find(c => c.id === job.case_id), menu = generateMenu(c.prepared);
  const options = Object.keys(request.questions[PRINCIPAL_QUESTION].criteria), choice = script.choose(c, menu);
  assert.ok(options.includes(choice));
  const low = 0.01, probabilities = Object.fromEntries(options.map(o => [o, o === choice ? Math.round((1 - low * (options.length - 1)) * 100) / 100 : low]));
  const answers = { [PRINCIPAL_QUESTION]: { type: 'choice', choice, confidence: 0.9, probabilities } };
  for (const key of Object.keys(request.questions)) if (key !== PRINCIPAL_QUESTION) answers[key] = { type: 'noul', noul: script.ground(c, key) };
  return { model, usage: { input_tokens: 100, output_tokens: 20 }, answers };
};
let networkCalls = 0;
const fetchFor = activePlan => async (_url, init) => { networkCalls++; return new Response(JSON.stringify(reply(activePlan, JSON.parse(init.body))), { status: 200 }); };
const scripted = (activePlan = plan, extra = {}) => runDecisionPlane(activePlan, { mode: 'live', typesafeKey: 'test-key', anthropicKey: 'test-key', fetchImpl: fetchFor(activePlan), budget, ranAt: '2026-09-18T00:00:00Z', ...extra });
const reset = () => { script.choose = (c) => c.direct_action.representation.plan_id ?? ABSTAIN; script.ground = () => 0.9; networkCalls = 0; };
const stripped = f => { const { expected, semantic_statuses, adjudication, ...rest } = f; return rest; };
const allocationPlan = (candidate, predicate = () => true) => p => p.terminal === 'resolve' && p.allocations.length === 1 && p.allocations[0].candidate === candidate && !p.requests.length && !p.exclusions.some(e => e.reason === 'duplicate_payment') && predicate(p);

test('the arm joins the harness as an opt-in, non-escalating arm; every frozen plan carries the menu digest, the scoring version and the code file is bound', async () => {
  assert.ok(OPTIONAL_ARMS.includes(ARM) && ALL_ARMS.includes(ARM) && !ARMS.includes(ARM), 'opt-in: the default selection and every existing frozen plan are unchanged');
  assert.ok(!ESCALATING_ARMS.includes(ARM) && !armEscalates(ARM, plan), 'no fallback during primary measurement');
  assert.ok(CODE_FILES.includes('scripts/jev_direct_action.js'), 'the plan hashes the arm');
  verifyPlan(plan); verifyPlan(directPlan);
  assert.throws(() => verifyPlan({ ...plan, code_hashes: { ...plan.code_hashes, 'scripts/jev_direct_action.js': hash('edited') } }), /frozen_plan_mismatch/);
  assert.equal(plan.cases.length, 36); assert.equal(plan.jobs.length, 36, 'one typed call per case, nothing else');
  assert.ok(plan.jobs.every(j => j.provider === 'typesafe' && j.arm === ARM));
  assert.ok(plan.cases.every(c => !c.escalation), 'a plan with only the direct arm freezes no escalation');
  for (const c of plan.cases) { assert.equal(c.direct_action.menu_sha256, menuOf(c.id).menu_sha256); assert.equal(typeof c.direct_action.representation.representable, 'boolean'); assert.deepEqual(c.direct_action.scoring, { version: DIRECT_SCORING_VERSION, legacy: LEGACY_SCORING_VERSION, expectation_source: 'legacy_label', unspecified: c.direct_action.representation.unspecified }); }
  assert.ok(directPlan.cases.every(c => c.direct_action.scoring.expectation_source === 'direct_plan' && c.direct_action.scoring.unspecified.length === 0));
  // An explicit case subset freezes a smaller plan and records its filter; an unknown id refuses.
  const subset = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: [ARM], jevModel: model, strongModel: model, cases: ['fresh-017', 'fresh-008'] });
  assert.deepEqual(subset.cases.map(c => c.id), ['fresh-008', 'fresh-017']); assert.deepEqual(subset.case_filter, ['fresh-008', 'fresh-017']); assert.equal(subset.jobs.length, 2); verifyPlan(subset);
  await assert.rejects(buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: [ARM], jevModel: model, strongModel: model, cases: ['fresh-999'] }), /unknown_case/);
  const table = costTable(plan, verifyBudget(budget));
  assert.equal(table.arms[ARM].initial_calls, 36); assert.equal(table.arms[ARM].max_escalation_calls, 0);
  const again = await buildDecisionPlan({ client, corpus: 'jev-plane-fresh', arms: [ARM], jevModel: model, strongModel: model });
  assert.equal(again.plan_sha256, plan.plan_sha256, 'the menu generator is deterministic');
});

test('menu generation reads packet facts only: identical menus with every label, annotation and adjudication stripped; requests leak no label; position is a content hash', async () => {
  for (const f of [...corpus, ...directCorpus]) {
    const blind = await prepareEvidencePacket(stripped(f).packet, client);
    const menu = generateMenu(blind);
    assert.equal(menu.menu_sha256, menuOf(f.id).menu_sha256, `${f.id}: the menu differs with labels stripped`);
    for (let i = 0; i < menu.plans.length; i++) {
      const { id, key, text, ...content } = menu.plans[i];
      assert.equal(id, `plan_${i + 1}`); assert.equal(key, hash({ packet: blind.packet_sha256, plan: content }));
      if (i) assert.ok(menu.plans[i - 1].key < key);
      assert.equal(text, planText(content, menu.remaining_minor, menu.currency));
    }
    const request = (f.id.startsWith('direct-') ? directPlan : plan).jobs.find(j => j.case_id === f.id).request, textOf = JSON.stringify(request);
    assert.deepEqual(Object.keys(request.questions[PRINCIPAL_QUESTION].criteria).at(-1), ABSTAIN);
    const sourceText = f.packet.sources.map(s => s.content).join('\n');
    const ids = [f.packet.invoice.id, ...f.packet.transactions.map(t => t.id), ...f.packet.sources.map(s => s.id), ...f.packet.links.map(l => l.id)];
    for (const s of [f.id, 'label_reason', '"expected"', 'direct_plan', 'semantic_statuses', 'adjudication', 'source_family', 'authored_relationships', 'representab', 'RESOLVED', 'NEEDS_', ...ids].filter(s => !sourceText.includes(s))) assert.ok(!textOf.includes(s), `${f.id} leaks ${s}`);
    assert.doesNotMatch(textOf, /fresh-0\d\d|direct-0\d\d/);
    assert.deepEqual(request.state.mechanical_facts, stateWithFacts(planCase(f.id).prepared).mechanical_facts, 'the direct arm sees the typed arm\'s state and mechanical facts');
  }
  for (const fn of [generateMenu, candidateFacts, allocationsFor, planText, directQuestions]) assert.doesNotMatch(fn.toString(), /expected|adjudication|semantic_statuses|label|family/);
  assert.deepEqual(Object.keys(ACTION_VOCABULARY), ['allocate', 'retain_balance', 'surplus', 'exclude', 'request_document', 'request_fact', 'no_settlement', 'abstain']);
  assert.ok(Object.values(EXCLUSION_REASONS).every(v => ['observed', 'asserted'].includes(v)));
});

test('plan-consequence-v2: plans compare as accounting consequences (ids, order, basis and wording never matter); a legacy label derives an expectation with its unspecified components named; an explicit direct_plan compares every component', () => {
  const c = planCase('fresh-026'), menu = menuOf('fresh-026');
  // Two plans with the same consequences are equivalent whatever their id or basis.
  const a = menu.plans.find(allocationPlan('candidate_1')), b = { ...a, id: 'plan_zz', basis: 'renamed', text: 'other wording', allocations: [...a.allocations].reverse(), exclusions: [...a.exclusions].reverse() };
  assert.equal(hash(planConsequences(c.prepared, a)), hash(planConsequences(c.prepared, b)));
  // The legacy label derives an expectation; surplus and exclusions are unspecified and never compared; the fee is read from the authored link.
  const legacy = expectedConsequences(c.prepared, c.expected);
  assert.equal(legacy.source, 'legacy_label'); assert.deepEqual(legacy.unspecified, ['surplus', 'exclusions']);
  assert.deepEqual(legacy.allocations, [{ transaction_id: 'tx-t1', amount_minor: 87200, fee_minor: 0 }]); assert.deepEqual(legacy.requests, [{ transaction_id: 'tx-t2', missing: 'payment_specific_source' }]);
  const c7 = planCase('fresh-007');
  assert.deepEqual(expectedConsequences(c7.prepared, c7.expected).allocations, [{ transaction_id: 'tx-t1', amount_minor: 218000, fee_minor: 7774 }], 'the fee rides the derived expectation from the authored link');
  assert.deepEqual(expectedConsequences(c7.prepared, { route: 'supported_proposal', proposals: [{ transaction_id: 'tx-t1', invoice_id: 'invoice-focal', amount_minor: 1 }] }).unspecified, ['surplus', 'exclusions', 'fee'], 'no link carries that amount: the fee is unspecified');
  // An explicit direct_plan compares every component: the same expectation in candidate handles or transaction ids.
  const explicit = expectedConsequences(c.prepared, { direct_plan: { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 87200 }], requests: [{ candidate: 'candidate_2' }], exclusions: {} } });
  assert.equal(explicit.source, 'direct_plan'); assert.deepEqual(explicit.unspecified, []); assert.deepEqual(explicit.allocations, [{ transaction_id: 'tx-t1', amount_minor: 87200, fee_minor: 0 }]); assert.equal(explicit.retained_balance_minor, 0);
  const full = menu.plans.find(p => p.allocations.length === 1 && p.allocations[0].candidate === 'candidate_1' && p.requests.length === 1);
  assert.deepEqual(compareConsequences(planConsequences(c.prepared, full), explicit), []);
  // Each regression the review asked for, as a difference the comparison names.
  const differs = (plan, expectation) => compareConsequences(planConsequences(c.prepared, plan), expectedConsequences(c.prepared, { direct_plan: expectation }));
  const askT2 = menu.plans.find(p => p.terminal === 'ask_owner' && p.requests[0].candidate === 'candidate_2');
  assert.deepEqual(differs(askT2, { terminal: 'ask_owner', requests: [{ candidate: 'candidate_1' }] }), ['requests'], 'a standalone request must name the right candidate');
  assert.deepEqual(differs(askT2, { terminal: 'ask_owner', requests: [{ candidate: 'candidate_2', missing: 'contract' }] }), ['requests'], '…and the right missing item');
  const dup = menu.plans.find(p => p.exclusions.some(e => e.reason === 'duplicate_payment'));
  assert.deepEqual(differs(dup, { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 87200 }], surplus: [{ candidate: 'candidate_2', surplus_minor: 87200, disposition: 'competing_invoice' }], exclusions: { candidate_2: 'duplicate_payment' } }), ['surplus'], 'wrong surplus disposition');
  assert.deepEqual(differs(dup, { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 87200 }], surplus: [{ candidate: 'candidate_2', surplus_minor: 87200, disposition: 'overpayment' }], exclusions: { candidate_2: 'unrelated' } }), ['exclusions'], 'incorrect exclusion');
  assert.deepEqual(differs(dup, { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 87200 }], surplus: [], exclusions: { candidate_2: 'duplicate_payment' } }), ['surplus'], 'omitted required remaining work (the surplus)');
  assert.deepEqual(differs(a, { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 80000 }], exclusions: { candidate_2: 'unrelated' } }), ['allocations', 'retained_balance'], 'a different amount also changes the retained balance');
  assert.deepEqual(differs(a, { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 87200, fee_minor: 500 }], exclusions: { candidate_2: 'unrelated' } }), ['fee']);
  assert.deepEqual(differs(abstainPlan(), { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 87200 }] }), ['terminal']);
  // An explicit expectation may declare a component unspecified, and the comparison honours the declaration.
  assert.deepEqual(differs(dup, { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 87200, fee_minor: 500 }], surplus: [], exclusions: { candidate_2: 'unrelated' }, unspecified: ['fee', 'surplus', 'exclusions'] }), []);
  assert.deepEqual(expectedConsequences(c.prepared, { direct_plan: { terminal: 'resolve', allocations: [], unspecified: ['fee', 'surplus', 'exclusions', 'nonsense'] } }).unspecified, ['fee', 'surplus', 'exclusions']);
  // The reviewer's reproduction: a request for candidate 2 against an expectation requesting candidate 1 is neither representable nor correct.
  const wrongTarget = { direct_plan: { terminal: 'ask_owner', requests: [{ candidate: 'candidate_1' }] } };
  const rep = representability(c.prepared, menu, wrongTarget);
  assert.equal(rep.representable, false); assert.equal(rep.reason, 'not_offered:requests');
  const d = decideDirectAction(c.prepared, menu, answerFor(askT2.id));
  const ps = scoreDirectDecision(c.prepared, menu, d, wrongTarget, rep);
  assert.equal(ps.selection_correct, false); assert.equal(ps.correct, false); assert.deepEqual(ps.selection_differences, ['requests']); assert.equal(ps.cause, 'representation');
  // The same semantics decide representability, selection correctness and validated correctness.
  const right = { direct_plan: { terminal: 'ask_owner', requests: [{ candidate: 'candidate_2' }] } };
  const rep2 = representability(c.prepared, menu, right), ps2 = scoreDirectDecision(c.prepared, menu, d, right, rep2);
  assert.ok(rep2.representable && rep2.plan_id === askT2.id && ps2.selection_correct && ps2.accepted && ps2.correct && ps2.cause === null);
  assert.equal(ps2.version, DIRECT_SCORING_VERSION);
});

test('menu coverage review on the development material: every fresh expectation is representable, reasoning labels only through abstain, degenerate menus named, requests only where a document is absent', () => {
  const failures = plan.cases.filter(c => !c.direct_action.representation.representable);
  assert.deepEqual(failures.map(c => c.id), [], 'coverage reviewed before any answer is observed');
  for (const c of plan.cases) {
    const rep = c.direct_action.representation;
    if (c.expected.route === 'strong_reasoning') assert.equal(rep.plan_id, ABSTAIN, `${c.id}: a reasoning label is representable only by abstaining`);
    else assert.match(rep.plan_id, /^plan_\d+$/);
    assert.ok(c.direct_action.menu_size <= MAX_MENU_PLANS && !c.direct_action.truncated && !c.direct_action.provenance_omitted, `${c.id}: bounded without truncation`);
  }
  assert.deepEqual(plan.cases.filter(c => c.direct_action.allocation_plans === 0).map(c => c.id), ['fresh-002', 'fresh-005', 'fresh-017', 'fresh-029', 'fresh-035'], 'degenerate menus: every candidate excluded on an observed fact, or a cross-currency credit with no source that could ground a conversion');
  // The contract-gap reasoning labels ARE expressible as concrete plans in this vocabulary.
  assert.ok(menuOf('fresh-015').plans.some(p => p.allocations.length === 1 && p.allocations[0].candidate === 'candidate_2' && p.allocations[0].kind === 'overpayment' && p.allocations[0].surplus_minor === 10000));
  assert.ok(menuOf('fresh-025').plans.some(p => p.allocations.length === 1 && p.exclusions.some(e => e.reason === 'duplicate_payment' && e.surplus_minor === 87200)));
  const shapes = Object.fromEntries(Object.entries(EXAMPLE_SHAPES).map(([shape, [, id]]) => [shape, menuOf(id).plans.map(describePlanShape)]));
  assert.deepEqual(shapes.simple_match.map(p => p.terminal).sort(), ['no_settlement', 'resolve']);
  assert.deepEqual(shapes.reversal.map(p => p.terminal), ['no_settlement'], 'a reversed instrument is an observed fact: no allocation of it is offered');
  assert.ok(menuOf('fresh-005').plans[0].exclusions.some(e => e.reason === 'reversed_instrument' && e.observed && e.reversed_by === 'candidate_2'));
  assert.deepEqual(shapes.missing_settlement_statement.map(p => p.terminal).sort(), ['ask_owner', 'no_settlement', 'resolve']);
  assert.ok(shapes.resolution_plus_owner_request.some(p => p.terminal === 'resolve' && p.allocations.length === 1 && p.requests.length === 1));
  assert.ok(!menuOf('fresh-027').plans.some(p => p.terminal === 'ask_owner'), 'no request for a candidate an authored relationship explains');
  assert.ok(menuOf('fresh-010').plans.some(p => p.fact_request), 'the declared owner fact is a plan');
  const p26 = planCase('fresh-026');
  assert.equal(representability(p26.prepared, menuOf('fresh-026'), { route: 'supported_proposal', proposals: [{ transaction_id: 'tx-t1', invoice_id: 'invoice-focal', amount_minor: 1 }] }).reason, 'not_offered:allocations+retained_balance');
  assert.equal(representability(p26.prepared, menuOf('fresh-026'), { route: 'supported_proposal', proposals: p26.expected.proposals, evidence_requests: ['tx-t1'] }).reason, 'not_offered:requests');
  assert.equal(representability(planCase('fresh-005').prepared, menuOf('fresh-005'), { route: 'customer_question', proposals: [] }).reason, 'no_plan_with_terminal:ask_owner');
});

test('the paired fee and FX regressions: identical evidence with and without the authored relationship, the same complete expectation, representable on both menus or unrepresentable on both with the same named components', () => {
  const rep = id => planCase(id).direct_action.representation;
  for (const id of ['direct-001', 'direct-002', 'direct-005', 'direct-006', 'direct-007', 'direct-009', 'direct-010']) assert.ok(rep(id).representable, `${id} ${rep(id).reason}`);
  // Every pair shares one expectation, every component compared; the two members read identically.
  for (const [withId, withoutId] of [['direct-001', 'direct-002'], ['direct-003', 'direct-004'], ['direct-005', 'direct-006'], ['direct-007', 'direct-008'], ['direct-009', 'direct-010']]) {
    const a = planCase(withId), b = planCase(withoutId);
    assert.equal(hash(a.expected.direct_plan), hash(b.expected.direct_plan)); assert.deepEqual(rep(withId).unspecified, []); assert.deepEqual(rep(withoutId).unspecified, []);
    assert.equal(hash(expectedConsequences(a.prepared, a.expected)), hash(expectedConsequences(b.prepared, b.expected)), `${withId}/${withoutId}: the same consequences expected`);
  }
  // The bundled payout: the invoice settled net of its OWN fee with the rest of the credit as other receipts is on neither menu
  // (the relationship carries the payout's combined fee; without it the fee is not packet arithmetic): the same limit, both members.
  for (const id of ['direct-003', 'direct-004']) { assert.equal(rep(id).representable, false); assert.equal(rep(id).reason, 'not_offered:fee+surplus'); assert.deepEqual(rep(id).nearest.differences, ['fee', 'surplus']); }
  const swapped = (id, other) => representability(planCase(id).prepared, menuOf(id), planCase(other).expected).representable;
  assert.equal(swapped('direct-003', 'direct-004'), false); assert.equal(swapped('direct-004', 'direct-003'), false);
  assert.deepEqual(planCase('direct-003').expected.direct_plan.allocations, [{ transaction_id: 'tx-t1', amount_minor: 218000, fee_minor: 7774 }]);
  assert.deepEqual(planCase('direct-004').expected.direct_plan.surplus, [{ transaction_id: 'tx-t1', surplus_minor: 44226, disposition: 'other_receipts' }]);
  // The corrected statement's arithmetic closes: nets 210226 + 44226 = the 254452 credited.
  assert.equal(planCase('direct-004').prepared.packet.transactions[0].money_in_minor, 254452);
  assert.match(planCase('direct-004').prepared.packet.sources.find(s => s.kind === 'processor_payout_report').content, /2,544\.52/);
  assert.equal(rep('direct-008').representable, false); assert.equal(rep('direct-008').reason, 'not_offered:allocations+retained_balance');
  // A partial cross-currency amount stated only in the advice is not derivable: the only allocation offered is the FULL conversion (a wrong plan the model may select), never the 500000 the advice states.
  assert.deepEqual(menuOf('direct-008').plans.filter(p => p.allocations.length).map(describePlanShape), [{ terminal: 'resolve', allocations: ['candidate_1:550000@source_grounded_conversion'], requests: [], fact_request: false }]);
  // Without the relationship the expected plan is the source-grounded inference; with it, the authored link.
  const basisOf = id => { const r = rep(id); return r.plan_id === ABSTAIN ? null : menuOf(id).plans.find(p => p.id === r.plan_id).allocations.map(a => a.basis); };
  assert.deepEqual(basisOf('direct-001'), ['authored_link']); assert.deepEqual(basisOf('direct-002'), ['source_grounded_fee']);
  assert.deepEqual(basisOf('direct-005'), ['authored_link']); assert.deepEqual(basisOf('direct-006'), ['source_grounded_conversion']);
  assert.deepEqual(basisOf('direct-009'), ['authored_link']); assert.deepEqual(basisOf('direct-010'), ['source_grounded_fee']);
  const nearestOf = id => { const r = rep(id); return menuOf(id).plans.find(p => p.id === r.nearest.plan_id).allocations.map(a => [a.basis, a.fee_minor, a.surplus_minor]); };
  assert.deepEqual(nearestOf('direct-003'), [['authored_link', 9548, 0]], 'with the relationship: the combined fee, no surplus');
  assert.deepEqual(nearestOf('direct-004'), [['bank_amount', 0, 36452]], 'without it: no fee, the credit\'s excess over the balance');
  // The consequences the two members represent are the same accounting (fee 7774 on 218000; 550000 in full; 264 on 24000).
  for (const [withId, withoutId] of [['direct-001', 'direct-002'], ['direct-005', 'direct-006'], ['direct-009', 'direct-010']]) {
    const cons = id => { const r = rep(id); return planConsequences(planCase(id).prepared, menuOf(id).plans.find(p => p.id === r.plan_id)); };
    assert.equal(hash(cons(withId)), hash(cons(withoutId)), `${withId}/${withoutId} represent the same accounting`);
  }
  // Fee and conversion inferences are offered only when a non-structural source exists to ground them.
  assert.ok(nonStructuralSources(planCase('direct-002').prepared).length === 1 && nonStructuralSources(planCase('fresh-017').prepared).length === 0);
  assert.ok(!menuOf('fresh-017').plans.some(p => p.allocations.length), 'no source could ground a conversion: no allocation is offered, the request plan is');
  assert.ok(!menuOf('fresh-008').plans.some(p => p.allocations.some(a => a.basis === 'source_grounded_fee')));
  const f2 = candidateFacts(planCase('direct-002').prepared)[0];
  assert.deepEqual(allocationsFor(f2, 218000, { groundable: true }).map(a => [a.basis, a.amount_minor, a.fee_minor]), [['bank_amount', 210226, 0], ['source_grounded_fee', 218000, 7774]]);
  assert.deepEqual(allocationsFor(f2, 218000).map(a => a.basis), ['bank_amount']);
});

test('multiple and mixed foreign-currency candidates: an unlinked FX candidate has no packet-fact basis, is named as excluded from combinations, and the menu still generates', async () => {
  const base = planCase('direct-006').prepared.packet;
  const clone = (extraTx, extraLink = null) => { const f = structuredClone(base);
    for (const t of extraTx) { const src = structuredClone(f.sources.find(s => s.id === 'bank-t1')); src.id = `bank-${t.id.slice(3)}`; src.content = src.content.replace('7315.00', String(t.money_in_minor / 100).replace(/(\d)(?=(\d{3})+\.)/g, '$1,') + '.00'); f.sources.push(src);
      f.transactions.push({ ...structuredClone(f.transactions[0]), id: t.id, source_id: src.id, money_in_minor: t.money_in_minor, currency: t.currency ?? 'SGD', description: t.description ?? 'INWARD TELEGRAPHIC TRANSFER' });
      f.collision.transaction_ids.push(t.id); f.retrieval.required_source_ids.push(src.id); f.retrieval.covered_source_ids.push(src.id); }
    if (extraLink) f.links.push(extraLink);
    return f; };
  // Two unlinked FX candidates: each gets its own grounded full-settlement plan; neither combines.
  const two = await prepareEvidencePacket(clone([{ id: 'tx-t2', money_in_minor: 731500 }]), client);
  assert.equal(two.error, undefined);
  const menuTwo = generateMenu(two);
  assert.deepEqual(menuTwo.settlement_capable, ['candidate_1', 'candidate_2']);
  assert.deepEqual(menuTwo.combination_excluded, [{ candidate: 'candidate_1', reason: 'no_packet_fact_basis' }, { candidate: 'candidate_2', reason: 'no_packet_fact_basis' }]);
  assert.ok(menuTwo.plans.every(p => p.allocations.length <= 1));
  const conversions = menuTwo.plans.filter(p => p.allocations[0]?.basis === 'source_grounded_conversion');
  assert.equal(conversions.filter(p => !p.requests.length).length, 2, 'one grounded full-settlement plan per FX candidate'); assert.equal(conversions.filter(p => p.requests.length).length, 2, 'each with its companion-request variant on the unexplained sibling');
  assert.ok(menuTwo.plans.some(p => p.terminal === 'no_settlement'));
  // Mixed: one same-currency (USD) candidate beside the FX one: the USD candidate combines with nothing (a group of one), the FX one is excluded.
  const mixed = await prepareEvidencePacket(clone([{ id: 'tx-t2', money_in_minor: 200000, currency: 'USD', description: 'USD CREDIT' }]), client);
  const menuMixed = generateMenu(mixed);
  assert.deepEqual(menuMixed.combination_excluded, [{ candidate: 'candidate_1', reason: 'no_packet_fact_basis' }]);
  assert.ok(menuMixed.plans.some(p => p.allocations.length === 1 && p.allocations[0].candidate === 'candidate_2' && p.allocations[0].basis === 'bank_amount' && p.allocations[0].kind === 'partial'));
  assert.ok(menuMixed.plans.every(p => p.allocations.length <= 1));
  // Two FX candidates each with a consistent authored relationship DO combine (both carry a packet-fact basis).
  const linked = clone([{ id: 'tx-t2', money_in_minor: 266000 }], { id: 'link-1-t1', kind: 'remittance', source_id: 'advice-1', transaction_id: 'tx-t1', invoice_id: 'invoice-focal', invoice_amount_minor: 350000, invoice_currency: 'USD', bank_amount_minor: 731500, bank_currency: 'SGD', gross_minor: 731500, fee_minor: 0 });
  linked.links.push({ id: 'link-2-t2', kind: 'remittance', source_id: 'advice-1', transaction_id: 'tx-t2', invoice_id: 'invoice-focal', invoice_amount_minor: 200000, invoice_currency: 'USD', bank_amount_minor: 266000, bank_currency: 'SGD', gross_minor: 266000, fee_minor: 0 });
  const menuLinked = generateMenu(await prepareEvidencePacket(linked, client));
  assert.deepEqual(menuLinked.combination_excluded, []);
  assert.ok(menuLinked.plans.some(p => p.allocations.length === 2 && p.allocations.every(a => a.basis === 'authored_link') && p.retained_balance_minor === 0));
  // The menus are label-blind and bounded as before; every plan validates structurally.
  for (const menu of [menuTwo, menuMixed, menuLinked]) assert.ok(menu.plans.length <= MAX_MENU_PLANS && !menu.truncated);
});

test('the menu is bounded: many settlement-capable candidates cap the combinations and the menu, and every truncation is recorded', async () => {
  const f = structuredClone(fixture('fresh-026').packet);
  for (let i = 3; i <= 8; i++) {
    const src = structuredClone(f.sources.find(s => s.id === 'bank-t2')); src.id = `bank-t${i}`;
    const tx = structuredClone(f.transactions.find(t => t.id === 'tx-t2')); tx.id = `tx-t${i}`; tx.source_id = src.id;
    f.sources.push(src); f.transactions.push(tx); f.collision.transaction_ids.push(tx.id); f.retrieval.required_source_ids.push(src.id); f.retrieval.covered_source_ids.push(src.id);
  }
  const prepared = await prepareEvidencePacket(f, client);
  assert.equal(prepared.error, undefined);
  const menu = generateMenu(prepared);
  assert.equal(menu.settlement_capable.length, 8);
  assert.equal(menu.plans.length, MAX_MENU_PLANS);
  assert.match(menu.truncated.reason, /combination_candidates_capped\+menu_capped/);
  assert.equal(menu.truncated.capped_to, MAX_MENU_PLANS); assert.ok(menu.truncated.dropped.length > 0 && menu.truncated.generated > MAX_MENU_PLANS);
  assert.ok(menu.plans.every(p => p.allocations.length <= MAX_COMBINATION_CANDIDATES));
  assert.ok(menu.plans.some(p => p.terminal === 'no_settlement') && menu.plans.filter(p => p.terminal === 'resolve' && p.allocations.length === 1 && !p.requests.length).length === 8, 'singles and the negative are never dropped');
  assert.equal(Object.keys(directQuestions(prepared, menu)).length, 1 + (menu.provenance_omitted ? 0 : menu.plans.length * prepared.state.sources.length));
});

test('the validator: unsupported actions are refused with codes; an arithmetically valid but unevidenced allocation is accepted and scored as the model\'s; a source-grounded fee or conversion is accepted only when grounded and the selection is retained either way', () => {
  const p6 = planCase('fresh-006').prepared, remaining = 98500;
  const refusal = (prepared, plan, opts) => validatePlan(prepared, plan, opts).refusals.map(r => r.code);
  const alloc = (candidate, amount_minor, extra = {}) => ({ terminal: 'resolve', allocations: [{ candidate, amount_minor, currency: 'EUR', ...extra }], requests: [], fact_request: false, exclusions: [] });
  assert.deepEqual(refusal(p6, alloc('candidate_1', remaining)), ['instrument_reversed']);
  assert.deepEqual(refusal(p6, alloc('candidate_2', remaining)), ['ineligible_or_wrong_direction']);
  assert.deepEqual(refusal(p6, alloc('candidate_3', remaining + 1)), ['allocation_exceeds_remaining']);
  assert.deepEqual(refusal(p6, alloc('candidate_3', 0)), ['invalid_amount']);
  assert.deepEqual(refusal(p6, alloc('candidate_9', 1)), ['unknown_candidate_handle']);
  assert.deepEqual(refusal(p6, { ...alloc('candidate_3', remaining), allocations: [alloc('candidate_3', 50000).allocations[0], alloc('candidate_3', 48500).allocations[0]] }), ['duplicate_candidate']);
  assert.deepEqual(refusal(p6, { ...alloc('candidate_3', remaining), requests: [{ candidate: 'candidate_3', missing: 'x' }] }), ['request_on_proposed_candidate']);
  assert.deepEqual(refusal(p6, { terminal: 'ask_owner', allocations: [], requests: [], fact_request: true, exclusions: [] }), ['customer_question_without_named_fact']);
  assert.deepEqual(refusal(p6, { terminal: 'resolve', allocations: [], requests: [], fact_request: false, exclusions: [] }), ['empty_proposal']);
  assert.deepEqual(refusal(p6, alloc('candidate_3', remaining, { currency: 'USD' })), ['invoice_currency_mismatch']);
  assert.deepEqual(refusal(p6, { terminal: 'nonsense' }), ['unknown_plan']);
  const p25 = planCase('fresh-025').prepared;
  assert.deepEqual(refusal(p25, { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 87200, currency: 'SGD' }, { candidate: 'candidate_2', amount_minor: 87200, currency: 'SGD' }], requests: [], fact_request: false, exclusions: [] }), ['group_overallocation']);
  const partial = validatePlan(p6, alloc('candidate_3', 40000));
  assert.ok(partial.accepted); assert.equal(partial.allocations[0].link_backed, false); assert.equal(partial.grounding.required, false);
  // The negative control: fresh-011's unlinked director transfer equals the bill exactly. Code cannot refuse it; the scorer charges the model.
  const r11 = decideOn('fresh-011', allocationPlan('candidate_1'));
  assert.ok(r11.d.direct.validation.accepted && !r11.d.direct.validation.link_backed[0].link_backed);
  assert.equal(r11.ps.cause, 'model'); assert.deepEqual(r11.ps.selection_differences, ['terminal']);
  assert.deepEqual(r11.o.error_attribution, { class: 'accounting_policy_interpretation', basis: 'selection:terminal', attributed_to: 'model', authored_by: 'direct_plan_selection', cause: 'model' });
  // The source-grounded fee (direct-002): refused without grounding, the selection retained; accepted when the report is cited.
  const c2 = planCase('direct-002'), { plan: fee2, menu: menu2 } = planNamed('direct-002', p => p.allocations[0]?.basis === 'source_grounded_fee');
  const ungrounded = decideDirectAction(c2.prepared, menu2, answerFor(fee2.id));
  assert.equal(ungrounded.route, 'unresolved_research'); assert.equal(ungrounded.reason, 'guard_refused');
  assert.deepEqual(ungrounded.guard.refusals, [{ candidate: 'candidate_1', code: 'fee_not_grounded_in_source' }]);
  assert.deepEqual(ungrounded.guard.initial, { route: 'supported_proposal', proposals: [{ transaction_id: 'tx-t1', invoice_id: 'invoice-focal', amount_minor: 218000 }] });
  assert.equal(ungrounded.direct.selected, fee2.id); assert.deepEqual(ungrounded.direct.validation.grounding, { required: true, non_structural_cited: [], satisfied: false, interface_limit: false });
  const psUngrounded = scoreDirectDecision(c2.prepared, menu2, ungrounded, c2.expected, c2.direct_action.representation);
  assert.ok(psUngrounded.selection_correct && !psUngrounded.accepted && !psUngrounded.correct && psUngrounded.cause === 'rule_refusal');
  const report = nonStructuralSources(c2.prepared)[0];
  const grounded = decideDirectAction(c2.prepared, menu2, withGrounding(c2.prepared, fee2.id, answerFor(fee2.id), [report]));
  assert.equal(grounded.route, 'supported_proposal'); assert.deepEqual(grounded.proposals, [{ transaction_id: 'tx-t1', invoice_id: 'invoice-focal', amount_minor: 218000 }]);
  assert.deepEqual(grounded.direct.validation.link_backed, [{ transaction_id: 'tx-t1', link_backed: false, basis: 'source_grounded_fee' }]); assert.ok(grounded.direct.citation.non_structural_source_cited);
  assert.ok(scoreDirectDecision(c2.prepared, menu2, grounded, c2.expected, c2.direct_action.representation).correct);
  // Citing only structural sources (the invoice, the bank row) does not ground an inference.
  const structuralOnly = decideDirectAction(c2.prepared, menu2, withGrounding(c2.prepared, fee2.id, answerFor(fee2.id), c2.prepared.state.sources.filter(s => !nonStructuralSources(c2.prepared).includes(s.handle)).map(s => s.handle)));
  assert.equal(structuralOnly.reason, 'guard_refused'); assert.equal(structuralOnly.direct.citation.non_structural_source_cited, false);
  // The conversion (direct-006): the same rule; the fee arithmetic is checked on the packet (a wrong fee is arithmetic, not grounding).
  const c6 = planCase('direct-006'), { plan: fx6, menu: menu6 } = planNamed('direct-006', p => p.allocations[0]?.basis === 'source_grounded_conversion');
  assert.deepEqual(refusal(c6.prepared, fx6), ['conversion_not_grounded_in_source']);
  assert.ok(validatePlan(c6.prepared, fx6, { cited: nonStructuralSources(c6.prepared) }).accepted);
  assert.deepEqual(refusal(c2.prepared, { ...fee2, allocations: [{ ...fee2.allocations[0], fee_minor: 1 }] }, { cited: [report] }), ['allocation_arithmetic_conflict']);
  // When the request carried no grounding questions the refusal names the interface limit.
  assert.deepEqual(refusal(c2.prepared, fee2, { cited: [], provenanceOmitted: true }), ['grounding_unavailable_in_request']);
  // A hand-built cross-currency allocation with no consistent relationship and no grounded basis is refused as unverifiable.
  const c17 = planCase('fresh-017');
  assert.deepEqual(refusal(c17.prepared, { terminal: 'resolve', allocations: [{ candidate: 'candidate_1', amount_minor: 550000, currency: 'USD', basis: 'bank_amount' }], requests: [], fact_request: false, exclusions: [] }), ['currency_conversion_unverified']);
  // With a consistent cross-currency remittance (fresh-016) the shape is accepted on the link without grounding.
  const { plan: allocate16 } = planNamed('fresh-016', p => p.allocations.length === 1);
  assert.equal(allocate16.allocations[0].basis, 'authored_link'); assert.ok(validatePlan(planCase('fresh-016').prepared, allocate16).accepted);
  assert.throws(() => decideDirectAction(c17.prepared, menuOf('fresh-017'), answerFor('plan_99')), /selected_plan_not_on_menu/);
  assert.throws(() => validateAtomicResponse({ model, usage: { input_tokens: 1, output_tokens: 1 }, answers: { [PRINCIPAL_QUESTION]: { type: 'choice', choice: 'plan_99', confidence: 1, probabilities: { plan_99: 1 } } } }, { [PRINCIPAL_QUESTION]: directQuestions(c17.prepared, menuOf('fresh-017'))[PRINCIPAL_QUESTION] }, 'typesafe'), /invalid_response_distribution/);
});

test('attribution: an omitted or extra companion request, a wrong allocation and a wrong determinate negative are the model\'s; a refused correct selection is the rule\'s; a wrong selection that is also refused stays the model\'s with the refusal on the basis; an unrepresentable expectation is the menu\'s', () => {
  assert.deepEqual([...ATTRIBUTED_TO], ['contract_rule', 'routing_policy', 'model'], 'the legacy attribution vocabulary is unchanged');
  const both = decideOn('fresh-026', p => p.allocations.length === 1 && p.allocations[0].candidate === 'candidate_1' && p.requests.length === 1);
  assert.ok(both.ps.correct && both.o.consequence.correct && both.o.error_attribution === null);
  const bare = decideOn('fresh-026', allocationPlan('candidate_1'));
  assert.deepEqual(bare.ps.selection_differences, ['requests']); assert.equal(bare.ps.cause, 'model');
  assert.deepEqual(bare.o.error_attribution, { class: 'missing_evidence', basis: 'selection:requests', attributed_to: 'model', authored_by: 'direct_plan_selection', cause: 'model' }, 'the omitted companion is the model\'s selection error, never routing policy');
  assert.equal(attributeError(bare.c, bare.o).attributed_to, 'routing_policy', 'the LEGACY attribution of the same outcome is untouched (it still reads companions as the typed composition\'s policy) and is not what the direct arm reports');
  const extra = decideOn('fresh-028', p => p.allocations.length === 1 && p.requests.length === 1);
  assert.equal(extra.ps.cause, 'model'); assert.deepEqual(extra.o.error_attribution, { class: 'missing_evidence', basis: 'selection:requests', attributed_to: 'model', authored_by: 'direct_plan_selection', cause: 'model' });
  const wrongAmount = decideOn('fresh-013', p => p.terminal === 'no_settlement');
  assert.deepEqual(wrongAmount.o.error_attribution, { class: 'accounting_policy_interpretation', basis: 'selection:terminal', attributed_to: 'model', authored_by: 'direct_plan_selection', cause: 'model' }, 'a wrong determinate negative');
  const wrongCandidate = decideOn('fresh-027', allocationPlan('candidate_2'));
  assert.equal(wrongCandidate.ps.cause, 'model'); assert.deepEqual(wrongCandidate.ps.selection_differences, ['allocations']); assert.equal(wrongCandidate.o.error_attribution.class, 'duplicate_reversal_handling'); assert.equal(wrongCandidate.o.error_attribution.attributed_to, 'model');
  // A refused CORRECT selection (direct-002 ungrounded) is the rule's; a refused WRONG selection stays the model's with the refusal on the basis.
  const refusedRight = decideOn('direct-002', p => p.allocations[0]?.basis === 'source_grounded_fee');
  assert.deepEqual(refusedRight.o.error_attribution, { class: 'processor_settlement_decomposition', basis: 'guard:fee_not_grounded_in_source', attributed_to: 'contract_rule', authored_by: 'direct_plan_selection', cause: 'rule_refusal' });
  const refusedWrong = decideOn('direct-006', p => p.allocations[0]?.basis === 'source_grounded_conversion');
  const relabelled = { ...refusedWrong.c, expected: { route: 'unresolved_research', proposals: [], terminal: 'RESOLVED' } };
  const rep = representability(relabelled.prepared, refusedWrong.menu, relabelled.expected), ps = scoreDirectDecision(relabelled.prepared, refusedWrong.menu, refusedWrong.d, relabelled.expected, rep);
  const o = { ...refusedWrong.o, representation: rep, plan_score: ps }; o.error_attribution = attributeDirectError(relabelled, o);
  assert.equal(ps.cause, 'model'); assert.ok(!ps.accepted);
  assert.deepEqual(o.error_attribution, { class: 'processor_settlement_decomposition', basis: 'selection:terminal;guard:conversion_not_grounded_in_source', attributed_to: 'model', authored_by: 'direct_plan_selection', cause: 'model' });
  // An unrepresentable expectation (direct-008): the menu's, whatever the model selected.
  const unrep = decideOn('direct-008', p => p.terminal === 'no_settlement');
  assert.equal(unrep.ps.cause, 'representation'); assert.deepEqual(unrep.o.error_attribution, { class: 'other', basis: 'representation:not_offered:allocations+retained_balance', attributed_to: 'contract_rule', authored_by: 'direct_plan_selection', cause: 'representation' });
  // An owner request plan and an abstention are different outcomes; the no-settlement plan is a determinate negative.
  const ask = decideOn('fresh-008', p => p.terminal === 'ask_owner');
  assert.equal(ask.d.route, 'needs_evidence'); assert.ok(ask.ps.correct); assert.deepEqual(ask.d.dependencies.map(x => x.kind), ['evidence_request']);
  const fact = decideOn('fresh-010', p => p.fact_request);
  assert.equal(fact.d.route, 'customer_question'); assert.ok(fact.ps.correct); assert.equal(fact.d.question_specification.delivery_required, true);
  const c8 = planCase('fresh-008'), abstain = decideDirectAction(c8.prepared, menuOf('fresh-008'), answerFor(ABSTAIN, 0.6));
  assert.equal(abstain.route, 'strong_reasoning'); assert.equal(abstain.reason, 'direct_abstain');
  const psA = scoreDirectDecision(c8.prepared, menuOf('fresh-008'), abstain, c8.expected, c8.direct_action.representation);
  assert.ok(!psA.correct && psA.cause === 'model' && psA.selected_terminal === 'abstain', 'an abstention on an ask label is a wrong selection, not an owner request');
  assert.equal(needsEscalation(ARM, abstain, { escape: true }), false, 'the arm never escalates, even on an abstention');
  const none = decideOn('fresh-012', p => p.terminal === 'no_settlement');
  assert.equal(none.d.route, 'no_settlement'); assert.ok(none.ps.correct); assert.equal(none.o.consequence.ontology_debt, 'unresolved_research→no_settlement');
});

test('a scripted live run through the harness: one typed call per case, zero strong calls, the complete-plan score beside the legacy projection, receipts and counters agree, replay identical, public summary prose- and model-free', async () => {
  reset();
  const live = await scripted();
  assert.equal(live.completion, 'complete'); assert.equal(live.provider_calls, 36); assert.equal(networkCalls, 36);
  const row = live.summary[`fresh/${ARM}`], d = row.direct_action;
  assert.equal(row.strong_calls, 0); assert.equal(row.escalations, 0); assert.equal(row.malformed_answers, 0);
  assert.equal(d.scoring_version, DIRECT_SCORING_VERSION); assert.equal(d.legacy_scoring_version, LEGACY_SCORING_VERSION);
  assert.equal(d.cases, 36); assert.equal(d.correct, 36); assert.equal(d.incorrect, 0); assert.deepEqual(d.representation_failures, []); assert.equal(d.rule_refusals, 0); assert.equal(d.abstentions, 4); assert.equal(d.abstentions_on_reasoning_labels, 4);
  assert.equal(d.correct_resolutions + d.correct_owner_requests + d.abstentions, 36); assert.equal(d.wrong_resolutions, 0); assert.equal(d.false_owner_requests, 0);
  assert.deepEqual(d.incorrect_by_cause, { representation: 0, rule_refusal: 0, model: 0, malformed: 0 }); assert.deepEqual(d.expectation_sources, { legacy_label: 36 });
  assert.deepEqual(d.degenerate_menus, ['fresh-002', 'fresh-005', 'fresh-017', 'fresh-029', 'fresh-035']);
  assert.equal(d.legacy_projection.correct_by_consequence, 36); assert.deepEqual(d.legacy_projection.differs_from_plan_score, []);
  assert.equal(row.boundary.correct_final_by_consequence, 36); assert.equal(row.boundary.autonomous_coverage, 32);
  assert.ok(row.confidence_bands['0.90-1.00'].decisions + row.confidence_bands['0.80-0.89'].decisions === 36 && row.confidence_bands.policy_imposed.decisions === 0);
  const o = live.outcomes.find(o => o.id === `fresh-026/${ARM}`);
  assert.equal(o.deciding_probability, o.initial.direct.probability);
  for (const key of ['selected', 'probability', 'probabilities', 'citation', 'validation', 'selection', 'consequences', 'remaining_work', 'menu_sha256']) assert.ok(key in o.initial.direct, key);
  assert.equal(o.initial.direct.consequences.version, DIRECT_SCORING_VERSION);
  assert.ok(o.initial.direct.citation.cited.length > 0 && o.initial.direct.citation.provenance === 'per_plan_grounding_same_request');
  assert.ok(o.representation.representable && o.plan_score.correct && o.error_attribution === null && o.selection_consequence.correct);
  for (const x of live.outcomes.filter(o => o.arm === ARM)) assert.equal(x.error_attribution?.cause ?? null, x.plan_score.correct ? null : x.plan_score.cause, `${x.id}: the receipt and the score name one cause`);
  const replay = await runDecisionPlane(plan, { mode: 'replay', replay: live, fetchImpl: async () => { throw new Error('network'); }, ranAt: live.ranAt });
  const comparable = r => { const { summary, outcomes, continuation } = publicSummary(r); return { summary, outcomes, continuation }; };
  assert.deepEqual(comparable(replay), comparable(live), 'replay reproduces the identical report with zero network');
  const pub = JSON.stringify(publicSummary(live));
  assert.ok(!pub.includes(model) && !pub.includes('"records"') && !pub.includes('"text"') && !pub.includes('Allocate candidate'), 'no model id, no raw bodies, no menu prose');
  assert.ok(pub.includes('"direct"') && pub.includes('"consequences"'), 'the selection and its consequences ride the public summary');
});

test('the paired corpus through the harness: grounded selections resolve both members alike; ungrounded ones are rule refusals of a correct selection; the unrepresentable member is a representation failure; counters equal the receipts', async () => {
  reset();
  const grounded = await scripted(directPlan);
  const g = grounded.summary[`development/${ARM}`].direct_action;
  assert.equal(g.cases, 10); assert.equal(g.correct, 7); assert.equal(g.source_grounded_selections, 3);
  assert.deepEqual(g.incorrect_by_cause, { representation: 3, rule_refusal: 0, model: 0, malformed: 0 }); assert.deepEqual(g.expectation_sources, { direct_plan: 10 });
  assert.deepEqual(g.representation_failures, ['direct-003:not_offered:fee+surplus', 'direct-004:not_offered:fee+surplus', 'direct-008:not_offered:allocations+retained_balance']);
  assert.equal(g.rule_refusals, 0);
  // The same selections with no source grounded: the three inferred plans are refused, the selection matched, so the rule is charged.
  script.ground = () => 0.1;
  const ungrounded = await scripted(directPlan);
  const u = ungrounded.summary[`development/${ARM}`].direct_action;
  assert.equal(u.rule_refusals, 3); assert.deepEqual(u.rule_refusals_by_code, { fee_not_grounded_in_source: 2, conversion_not_grounded_in_source: 1 });
  assert.equal(u.rule_refusals_where_selection_matched_label, 3); assert.equal(u.rule_refusals_of_wrong_selections, 0); assert.equal(u.selection_correct_before_validation, 7);
  assert.deepEqual(u.incorrect_by_cause, { representation: 3, rule_refusal: 3, model: 0, malformed: 0 }); assert.equal(u.correct, 4);
  for (const id of ['direct-002', 'direct-006', 'direct-010']) {
    const o = ungrounded.outcomes.find(o => o.id === `${id}/${ARM}`);
    assert.equal(o.final.reason, 'guard_refused'); assert.equal(o.consequence.final, 'BLOCK'); assert.equal(o.plan_score.cause, 'rule_refusal'); assert.equal(o.error_attribution.attributed_to, 'contract_rule'); assert.match(o.error_attribution.basis, /^guard:/);
    assert.equal(o.initial.direct.selected, o.representation.plan_id, 'the selection is retained beside the refusal');
  }
  // A wrong selection everywhere (the negative when the expectation resolves): model errors, and on direct-008 still the menu's.
  script.choose = (c, menu) => menu.plans.find(p => p.terminal === 'no_settlement').id;
  const wrong = await scripted(directPlan);
  const w = wrong.summary[`development/${ARM}`].direct_action;
  assert.deepEqual(w.incorrect_by_cause, { representation: 3, rule_refusal: 0, model: 7, malformed: 0 }); assert.equal(w.wrong_resolutions, 7);
  for (const x of wrong.outcomes.filter(o => o.arm === ARM)) assert.equal(x.error_attribution.cause, x.plan_score.cause);
  assert.equal(Object.values(w.incorrect_by_cause).reduce((a, b) => a + b, 0), w.incorrect);
  // Wrong AND refused: pick the inferred plan against a relabelled expectation — the model's, with the refusal on the basis.
  reset(); script.ground = () => 0.1;
  const relabelled = structuredClone(directPlan);
  relabelled.cases.find(c => c.id === 'direct-002').expected = { route: 'unresolved_research', proposals: [], terminal: 'RESOLVED', direct_plan: { terminal: 'no_settlement', exclusions: { 'tx-t1': 'unrelated' } } };
  relabelled.cases.find(c => c.id === 'direct-002').direct_action.representation = representability(relabelled.cases.find(c => c.id === 'direct-002').prepared, generateMenu(relabelled.cases.find(c => c.id === 'direct-002').prepared), relabelled.cases.find(c => c.id === 'direct-002').expected);
  const report = buildReport(relabelled, ungrounded.records, [], { prices: budget.prices });
  const o2 = report.outcomes.find(o => o.id === `direct-002/${ARM}`);
  assert.equal(o2.plan_score.cause, 'model'); assert.equal(o2.error_attribution.attributed_to, 'model'); assert.equal(o2.error_attribution.basis, 'selection:terminal;guard:fee_not_grounded_in_source');
  assert.equal(report.summary[`development/${ARM}`].direct_action.rule_refusals_of_wrong_selections, 1);
  reset();
});

test('malformed and refused answers: a malformed typed answer is the arm\'s failure and never escalates; a rejected body replays; the receipt names the malformed cause', async () => {
  reset();
  let broke = 0;
  const breaking = async (_url, init) => { const request = JSON.parse(init.body); const body = reply(plan, request); networkCalls++;
    if (plan.cases.find(c => c.id === plan.jobs.find(j => j.request_sha256 === hash(request)).case_id).id === 'fresh-004' && !broke++) return new Response(JSON.stringify({ ...body, answers: { plan: { type: 'choice', choice: 'plan_1', confidence: 1, probabilities: { plan_1: 0.7, plan_2: 0.7 } } } }), { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 }); };
  const live = await scripted(plan, { fetchImpl: breaking });
  assert.equal(live.completion, 'complete'); assert.equal(live.rejected_responses.length, 1);
  const o4 = live.outcomes.find(o => o.id === `fresh-004/${ARM}`);
  assert.equal(o4.malformed_answers, 1); assert.equal(o4.consequence.final, 'BLOCK'); assert.equal(o4.strong_calls, 0); assert.ok(!o4.escalated_flag);
  assert.equal(o4.plan_score, null); assert.equal(o4.error_attribution.cause, 'malformed'); assert.equal(o4.error_attribution.attributed_to, 'model');
  assert.equal(live.summary[`fresh/${ARM}`].direct_action.incorrect_by_cause.malformed, 1);
  const replay = await runDecisionPlane(plan, { mode: 'replay', replay: live, ranAt: live.ranAt });
  assert.deepEqual(publicSummary(replay).outcomes, publicSummary(live).outcomes); assert.deepEqual(publicSummary(replay).summary, publicSummary(live).summary);
  assert.deepEqual(publicSummary(live).rejected.map(r => r.id), [`fresh-004/${ARM}`]);
});

test('the offline diagnosis of the eight named cases reproduces from the published summaries: which answer each refusal named, and what the recorded answers establish', async () => {
  const result = await diagnose(client);
  assert.deepEqual(result.cases.map(c => c.id), [...NAMED_CASES]);
  const byId = Object.fromEntries(result.cases.map(c => [c.id, c]));
  const refused = id => byId[id].refused_answers.map(r => r.question_id);
  assert.deepEqual(refused('fresh-005'), ['link_candidate_2_reference']);
  assert.deepEqual(refused('fresh-006'), ['link_candidate_2_reference', 'link_candidate_2_obligation']);
  assert.deepEqual(refused('fresh-017'), ['link_candidate_1_reference', 'link_candidate_1_obligation']);
  assert.deepEqual(refused('fresh-028'), ['link_candidate_2_reference']);
  assert.deepEqual(refused('fresh-029'), ['link_candidate_1_reference']);
  assert.deepEqual(refused('fresh-030'), ['link_candidate_2_reference']);
  assert.deepEqual(refused('fresh-011'), []); assert.deepEqual(refused('fresh-012'), []);
  for (const id of ['fresh-005', 'fresh-006', 'fresh-028', 'fresh-029', 'fresh-030']) for (const r of byId[id].refused_answers) assert.ok(!r.candidate_consumed_by_composition && r.candidate_direction_compatible === false, `${id} ${r.question_id}`);
  assert.ok(byId['fresh-017'].refused_answers.every(r => r.candidate_consumed_by_composition && !r.candidate_has_focal_link));
  for (const id of ['fresh-005', 'fresh-006', 'fresh-017', 'fresh-028', 'fresh-029', 'fresh-030']) for (const policy of ['max_authority', 'forced']) {
    const r = byId[id].recomposed_with_refused_answers_neutralised[policy];
    const legacy = planCase(id).expected;
    const cls = route => ['supported_proposal', 'no_settlement', 'unresolved_research', 'not_admitted'].includes(route) ? 'resolved' : ['needs_evidence', 'customer_question'].includes(route) ? 'ask_owner' : 'reasoning';
    assert.equal(cls(r.route), cls(legacy.route), `${id}/${policy}`);
    assert.equal(hash(r.proposals), hash(legacy.proposals), `${id}/${policy} proposals`);
  }
  for (const id of ['fresh-011', 'fresh-012']) {
    const c = byId[id];
    assert.deepEqual(c.unbound_sources, ['source_3']);
    for (const a of c.recorded_answers) assert.ok(!a.admissible_sources.includes('source_3'), `${id} ${a.question_id} admits the unbound source`);
    assert.ok(c.recorded_answers.filter(a => a.selected === 'contradicted').every(a => a.downgraded_without_citation));
    assert.ok(c.recorded_answers.some(a => a.question_id.endsWith('_counterparty') && a.selected === 'contradicted' && a.probability >= 0.8));
  }
  assert.doesNotMatch(JSON.stringify(result), /gpt-\d|claude-\d|sonnet|opus|haiku/i);
});

test('the committed example menus and the coverage report reproduce from the generator (never hand-edited)', async () => {
  const rendered = await renderExamples(client);
  const committed = readFileSync(resolve(ROOT, 'docs/experiments/jev-direct-action-examples-2026-09-18.md'), 'utf8');
  assert.equal(committed, rendered + '\n');
  for (const [, id] of Object.values(EXAMPLE_SHAPES)) assert.ok(committed.includes(`/${id}\``));
  assert.doesNotMatch(committed, /gpt-\d|claude-\d|sonnet|opus|haiku/i);
  assert.deepEqual(menuOf('fresh-005').plans.map(pl => projectPlan(planCase('fresh-005').prepared, pl).route), ['no_settlement']);
  const coverage = await coverageReport(client);
  const committedCoverage = readFileSync(resolve(ROOT, 'docs/experiments/jev-direct-action-coverage-2026-09-19.md'), 'utf8');
  assert.equal(committedCoverage, renderCoverage(coverage) + '\n');
  const direct = coverage.corpora['jev-plane-direct'];
  assert.deepEqual([direct.representable, direct.accepted_when_grounded, direct.accepted_without_grounding], [7, 7, 4]);
  assert.deepEqual(direct.grounding_required, ['direct-002', 'direct-006', 'direct-010']); assert.deepEqual(direct.representation_failures, ['direct-003:not_offered:fee+surplus', 'direct-004:not_offered:fee+surplus', 'direct-008:not_offered:allocations+retained_balance']);
  for (const name of ['jev-plane-fresh', 'jev-plane-dev', 'jev-plane-holdout']) { const c = coverage.corpora[name]; assert.equal(c.representable, c.model_dependent, name); assert.equal(c.accepted_without_grounding, c.model_dependent, `${name}: every legacy expectation is accepted without grounding`); }
});
