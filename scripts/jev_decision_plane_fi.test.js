// FIK-3: the Finnish coding lane of the Jev decision-plane harness. Pure tests
// pin the corpus, split, labels, pre-registration, holdout ledger and scorer;
// the real-PostgreSQL tests run the actual coder, auto-post writer and ask
// sweep on disposable books under a FIXTURE provider (scripted answers verify
// mechanics only; they are never capability observations). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash } from '../server/donna/jevEvidenceContract.js';
import { __setFiReviewedGuidanceEntriesForTests, FI_POLICY_CLAUSES } from '../server/donna/finland/decisionGuidance.js';
import { FI_VERSION, FI_ARMS, ARM_SPEC, loadFiCorpus, validateFiCase, checkSplit, goldOf, verifyPreregistration, verifyBaselineSummary, PREREG_VERSION, TARGETS,
  emptyHoldoutLedger, consumeHoldout, assertHoldoutUnread, assertHoldoutReadBy, verifyFiPlan, assertArmsDifferOnlyInPolicy, scoreFiOutcome, journalDifferences,
  armSummary, fiOutcome, verifyFiBudget, buildFiReport, fiCorpusDigest, FI_PROVISIONAL_ARM, provisionalRecord, loadFiProvisionalGuidance } from './jev_decision_plane_fi.js';
import { buildFiPlan, makeFiLane, seedOf, armFlags } from './jev_decision_plane_fi_run.js';
import { runDecisionPlane, publicSummary } from './jev_decision_plane.js';
import { verifyBudget } from './jev_decision_plane_protocol.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const PG = { skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — FIK-3 lane not exercised against a real book' };
const corpus = loadFiCorpus();
const byId = id => corpus.find(c => c.id === id);
// The bank leg as the real writer posts it on a Finnish book: the chart's 1910.
const B = '1910';
const L = (role, account, direction, amount, tax_code = 'NONE') => ({ role, account, direction, amount, tax_code });

// ── Pure: corpus, labels, split ─────────────────────────────────────────────
test('the synthetic corpus validates, keeps original and adjudicated labels, and seeds no label into a book', () => {
  assert.equal(corpus.length, 8);
  for (const c of corpus) {
    validateFiCase(c);
    assert.ok('original' in c.labels && 'adjudicated' in c.labels, `${c.id} keeps both label slots`);
    const seed = JSON.stringify(seedOf(c));
    for (const leak of [c.id, c.family, c.decision_class, 'labels', 'expressible', 'journal']) assert.ok(!seed.includes(leak), `${c.id}: the seed carries no ${leak}`);
  }
  assert.ok(checkSplit(corpus));
  assert.deepEqual([...new Set(corpus.map(c => c.split))].sort(), ['development', 'holdout']);
  // An adjudication keeps the original beside it; a disputed label has no gold.
  const adjudicated = { ...byId('fik3-dev-001'), labels: { original: byId('fik3-dev-001').labels.original, adjudicated: byId('fik3-dev-003').labels.original, adjudication: { status: 'adjudicated', reviewer: 'Fixture Reviewer', date: '2026-09-24' } } };
  validateFiCase(adjudicated);
  assert.equal(goldOf(adjudicated).terminal, 'ask_owner');
  assert.equal(goldOf({ ...adjudicated, labels: { ...adjudicated.labels, adjudicated: null, adjudication: { status: 'disputed' } } }), null);
  assert.throws(() => validateFiCase({ ...adjudicated, labels: { ...adjudicated.labels, adjudication: { status: 'adjudicated' } } }), /adjudication_receipt/);
  assert.throws(() => validateFiCase({ ...byId('fik3-dev-001'), period: '2026-04' }), /period_is_not_the_business_month/);
});

test('the split checker refuses a holdout sharing a case family, entity, sibling entity or period with development', () => {
  const dev = byId('fik3-dev-001'), hold = byId('fik3-hold-001');
  const cases = mut => [dev, byId('fik3-dev-002'), { ...hold, ...mut }];
  assert.ok(checkSplit(cases({})));
  assert.throws(() => checkSplit(cases({ family: dev.family })), /^Error: split_leakage:family:fi-oy-software-licence$/);
  assert.throws(() => checkSplit(cases({ entity: dev.entity })), /^Error: split_leakage:entity:synthetic-oy-a$/);
  assert.throws(() => checkSplit(cases({ sibling_entities: ['synthetic-oy-b'] })), /^Error: split_leakage:entity:synthetic-oy-b$/);
  assert.throws(() => checkSplit(cases({ period: dev.period, transaction: { ...hold.transaction, date: '2026-03-14' } })), /^Error: split_leakage:period:2026-03$/);
});

// ── Pure: the consequence scorer ────────────────────────────────────────────
const planCaseOf = id => ({ ...structuredClone(byId(id)) });
const snap = (over = {}) => ({ provider_failure: null, decision: { engine: 'jev', selected: 'resolved', tax_treatment: 'ALV 25,5 %', deciding_probability: 0.9 }, refusal: null, journals: [], asks: [],
  reconciliation: [{ matched_object_id: 'doc-1', status: 'auto_matched', seeded: true }], convergence: { state: 'auto_reconciled', reason: 'coding_state:posted', drift: false }, request_refs: [{ id: 'x', provider: 'typesafe', request_sha256: 'a' }], ...over });
const dev1Lines = [L('counterparty', 'Software subscriptions', 'debit', 100, 'ALV_25_5_INPUT'), L('alv_input_deductible', '2940', 'debit', 25.5), L('bank', B, 'credit', 125.5)];

test('scorer: the complete journal with its tax leg is correct; a wrong-VAT-side journal is a material wrong autonomous action', () => {
  const pc = planCaseOf('fik3-dev-001');
  const right = scoreFiOutcome(pc, snap({ journals: [{ status: 'posted', lines: dev1Lines }] }));
  assert.equal(right.correct_complete, true);
  assert.equal(right.material_wrong_autonomous_action, false);
  // The same purchase booked on the OUTPUT side: a credit to 2939 and a sales code.
  const wrongSide = [L('counterparty', 'Software subscriptions', 'debit', 125.5, 'ALV_25_5_OUTPUT'), L('alv_output', '2939', 'credit', 25.5), L('bank', B, 'credit', 100)];
  const s = scoreFiOutcome(pc, snap({ journals: [{ status: 'posted', lines: wrongSide }] }));
  assert.equal(s.material_wrong_autonomous_action, true);
  assert.deepEqual(s.material_kinds, ['tax']);
  for (const d of ['tax_leg', 'alv_code', 'alv_box', 'amount']) assert.ok(s.journal_differences.includes(d), `difference ${d}`);
  assert.equal(s.correct_complete, false);
  // Right account, right amount, wrong rate code: still material, still tax.
  assert.deepEqual(journalDifferences([{ ...dev1Lines[0], tax_code: 'ALV_14_INPUT' }, ...dev1Lines.slice(1)], dev1Lines), ['alv_code']);
  // Right tax, wrong expense account: material, a journal (not tax) error.
  const account = scoreFiOutcome(pc, snap({ journals: [{ status: 'posted', lines: [{ ...dev1Lines[0], account: 'Office expenses' }, ...dev1Lines.slice(1)] }] }));
  assert.deepEqual(account.material_kinds, ['journal']);
  assert.deepEqual(account.journal_differences, ['account']);
});

test('scorer: an excluded (vocabulary-gap) case stays in the operational denominator as incomplete work and is never credited', () => {
  const pc = planCaseOf('fik3-dev-004');
  assert.equal(pc.expressible.status, 'gap');
  const ask = snap({ decision: { engine: 'jev', selected: 'ask_business_use' }, asks: [{ evidence_type: 'business_purpose', status: 'draft' }], convergence: { state: 'on_owner', reason: 'open_owner_ask' } });
  const s = scoreFiOutcome(pc, ask);
  assert.equal(s.gold_scored, false);
  assert.equal(s.excluded_from_gold, 'gap:vocabulary');
  assert.equal(s.correct_complete, false);
  // Even a posting identical to the (unexpressible) gold is not credited.
  const perfect = scoreFiOutcome(pc, snap({ journals: [{ status: 'posted', lines: goldOf(pc).journal }] }));
  assert.equal(perfect.correct_complete, false);
  // ...and a posting that differs from it is still a material wrong action.
  const posted = scoreFiOutcome(pc, snap({ journals: [{ status: 'posted', lines: [L('counterparty', 'Telecommunications', 'debit', 50, 'ALV_25_5_INPUT'), L('alv_input_deductible', '2940', 'debit', 12.75), L('bank', B, 'credit', 62.75)] }] }));
  assert.equal(posted.material_wrong_autonomous_action, true);
  const plan = { cases: [pc], jobs: [{ id: 'fik3-dev-004/fi_v7', case_id: pc.id, arm: 'fi_v7', split: 'development' }] };
  const row = fiOutcome(plan, plan.jobs[0], ask, new Map([['x', { id: 'x', provider: 'typesafe', latency_ms: 5, raw: { usage: { input_tokens: 3, output_tokens: 1 } }, budget: { actual: { usd: 0.01 } } }]]));
  const summary = armSummary([row]);
  assert.equal(summary.cases, 1);
  assert.equal(summary.gold_scored, 0);
  assert.equal(summary.excluded_from_gold.vocabulary_gap, 1);
  assert.equal(summary.incomplete_work, 1, 'the excluded case is incomplete work, not removed');
  assert.equal(summary.correct_complete_rate, 0);
});

test('scorer: asks, handoffs, duplicates, false reconciliation, forbidden codes, refusals and terminal coverage', () => {
  const ask = planCaseOf('fik3-hold-003');
  const asked = over => snap({ decision: { engine: 'jev', selected: 'ask_recipient' }, asks: [{ evidence_type: 'business_purpose', status: 'draft' }], convergence: { state: 'on_owner', reason: 'open_owner_ask' }, ...over });
  assert.equal(scoreFiOutcome(ask, asked()).correct_complete, true);
  assert.equal(scoreFiOutcome(ask, asked({ decision: { engine: 'jev', selected: 'ask_business_purpose' } })).wrong_owner_ask, true, 'same request type, wrong owner question');
  assert.equal(scoreFiOutcome(ask, snap({ convergence: { state: 'hanging', reason: 'coding_state:proposed' } })).missing_owner_ask, true);
  assert.equal(scoreFiOutcome(ask, asked({ convergence: { state: 'hanging', reason: 'coding_state:proposed' } })).correct_complete, false, 'an ask resting hanging is not terminal');
  const posted = planCaseOf('fik3-dev-001');
  const avoidable = scoreFiOutcome(posted, asked({ decision: { engine: 'jev', selected: 'ask_business_purpose' } }));
  assert.equal(avoidable.avoidable_interruption, 'missing_fact');
  assert.equal(scoreFiOutcome(posted, asked({ decision: { engine: 'jev', selected: 'resolved', posting_requirement: 'document_discrepancy' }, asks: [{ evidence_type: 'document_discrepancy', status: 'draft' }] })).avoidable_interruption, 'unresolved_judgment');
  const handoff = scoreFiOutcome(posted, snap({ decision: { engine: 'strong_after_jev', strong_handoff: true, handoff_cause: 'reasoning_work' }, journals: [{ status: 'posted', lines: dev1Lines }] }));
  assert.equal(handoff.correct_complete, true);
  assert.equal(handoff.avoidable_handoff, 'unresolved_judgment');
  const dup = scoreFiOutcome(posted, snap({ journals: [{ status: 'posted', lines: dev1Lines }, { status: 'posted', lines: dev1Lines }] }));
  assert.equal(dup.duplicate_journals, 1);
  assert.ok(dup.material_kinds.includes('duplicate_journal'));
  const recon = scoreFiOutcome(posted, snap({ journals: [{ status: 'posted', lines: dev1Lines }], reconciliation: [{ matched_object_id: 'doc-1', status: 'auto_matched', seeded: true }, { matched_object_id: 'doc-9', status: 'auto_matched', seeded: false }] }));
  assert.equal(recon.false_reconciliations, 1);
  assert.ok(recon.material_kinds.includes('false_reconciliation'));
  // Sentinels: the refused deduction must be refused; a forbidden code must never post.
  const fee = planCaseOf('fik3-dev-002');
  const fired = scoreFiOutcome(fee, snap({ decision: { engine: 'jev', selected: 'resolved', tax_treatment: 'ALV 25,5 %' }, refusal: 'TRANSACTION_ALV_EVIDENCE_REQUIRED', convergence: { state: 'hanging', reason: 'ledger_post_refused:TRANSACTION_ALV_EVIDENCE_REQUIRED' } }));
  assert.deepEqual(fired.refusal, { expected: 'TRANSACTION_ALV_EVIDENCE_REQUIRED', tried: true, fired: true, missing: false });
  assert.equal(fired.terminal_reached, false);
  const missing = scoreFiOutcome(fee, snap({ decision: { engine: 'jev', selected: 'resolved', tax_treatment: 'ALV 25,5 %' }, journals: [{ status: 'posted', lines: [L('counterparty', 'Bank fees', 'debit', 4.78, 'ALV_25_5_INPUT'), L('alv_input_deductible', '2940', 'debit', 1.22), L('bank', B, 'credit', 6)] }] }));
  assert.equal(missing.refusal.missing, true);
  assert.ok(missing.material_kinds.includes('forbidden_code_posted'));
  assert.equal(scoreFiOutcome(fee, snap({ provider_failure: 'JEV_CODING_FAILED', decision: null, convergence: { state: 'hanging', reason: 'reconciliation_status:pending' } })).terminal, 'failed');
});

// ── Pure: pre-registration and the one-shot holdout ledger ──────────────────
const corpusSha = fiCorpusDigest(corpus);
// Fixture calls take milliseconds of wall time, so a p95 latency ratio between arms is runner noise
// (as `untimed` below says of summaries): the fixture bounds latency loosely and the holdout gate is
// pinned on outcomes. CI failed on it at 1.62 and 2.52 against 1.5 on 2026-10-22.
const targets = Object.fromEntries(Object.keys(TARGETS).map(k => [k, k === 'max_p95_latency_ratio' ? 100
  : k.startsWith('min') ? 0 : k.endsWith('delta') ? 0 : 1.5]));
const preregFor = (summary, over = {}) => ({ version: PREREG_VERSION, recorded_by: 'Fixture Operator', recorded_at: '2026-09-24T09:00:00Z', corpus: 'fik3-fi-coding', corpus_sha256: corpusSha,
  baseline: { development_summary_sha256: hash(summary), development_plan_sha256: summary.plan_sha256 }, comparison: { baseline: 'fi_v7', candidate: 'fi_v8' },
  safety_gate: { max_new_material_wrong_autonomous_actions: 0, existing_refusals_must_fire: true }, targets, ...over });
test('pre-registration: complete numeric targets, a safety gate that cannot be loosened, bound to the corpus and to a development-only baseline', () => {
  const summary = { version: FI_VERSION, plan_sha256: 'b'.repeat(64), completion: 'complete', outcomes: [{ split: 'development' }] };
  const p = verifyPreregistration(preregFor(summary), { corpusSha256: corpusSha });
  assert.ok(verifyBaselineSummary(summary, p));
  const bad = (over, code) => assert.throws(() => verifyPreregistration(preregFor(summary, over), { corpusSha256: corpusSha }), new RegExp(`invalid_preregistration:${code}`));
  bad({ safety_gate: { max_new_material_wrong_autonomous_actions: 1, existing_refusals_must_fire: true } }, 'safety_gate');
  bad({ safety_gate: { max_new_material_wrong_autonomous_actions: 0, existing_refusals_must_fire: false } }, 'safety_gate');
  bad({ targets: { ...targets, max_usd_ratio: undefined } }, 'targets');
  bad({ targets: { ...targets, extra: 1 } }, 'targets');
  bad({ corpus_sha256: 'c'.repeat(64) }, 'corpus');
  bad({ comparison: { baseline: 'fi_v8', candidate: 'fi_v7' } }, 'comparison');
  // The provisional development arm can never be pre-registered, on either side.
  bad({ comparison: { baseline: 'fi_v7', candidate: 'fi_v8p' } }, 'provisional_arm_not_allowed');
  bad({ comparison: { baseline: 'fi_v8p', candidate: 'fi_v8' } }, 'provisional_arm_not_allowed');
  assert.throws(() => verifyBaselineSummary({ ...summary, completion: 'incomplete' }, p), /baseline_summary_mismatch/);
  const leaky = { ...summary, outcomes: [{ split: 'holdout' }] };
  assert.throws(() => verifyBaselineSummary(leaky, verifyPreregistration(preregFor(leaky), { corpusSha256: corpusSha })), /baseline_not_development/);
});

test('holdout ledger: one read per case ever; only the interrupted run resumes; a replay re-reads only what its plan recorded', () => {
  const plan = { corpus: 'fik3-fi-coding', plan_sha256: 'p1', cases: [{ id: 'fik3-hold-001', split: 'holdout' }, { id: 'fik3-dev-001', split: 'development' }] };
  const other = { ...plan, plan_sha256: 'p2' };
  let ledger = emptyHoldoutLedger();
  assert.throws(() => assertHoldoutReadBy(ledger, plan), /holdout_read_not_recorded/);
  assert.throws(() => consumeHoldout(ledger, plan, { at: 't0', resuming: true }), /holdout_resume_without_read/);
  ledger = consumeHoldout(ledger, plan, { at: 't0' });
  assert.deepEqual(ledger.reads, [{ corpus: 'fik3-fi-coding', case_id: 'fik3-hold-001', plan_sha256: 'p1', read_at: 't0' }], 'development cases are never ledgered');
  assert.throws(() => consumeHoldout(ledger, plan, { at: 't1' }), /^Error: holdout_already_read:fik3-hold-001$/, 'a fresh second run of the same plan');
  assert.deepEqual(consumeHoldout(ledger, plan, { at: 't1', resuming: true }), ledger, 'the interrupted run resumes, the read is not re-dated');
  assert.throws(() => consumeHoldout(ledger, other, { at: 't1', resuming: true }), /holdout_already_read/);
  assert.throws(() => assertHoldoutUnread(ledger, 'fik3-fi-coding', ['fik3-hold-001']), /holdout_already_read/);
  assertHoldoutReadBy(ledger, plan);
  assert.throws(() => assertHoldoutReadBy(ledger, other), /holdout_read_not_recorded/);
});

test('arms differ only in the policy: any other difference in the captured request, receipt or facts refuses', () => {
  const policyA = 'AUTHORED FINNISH POLICY', policyD = 'REVIEWED FINNISH POLICY';
  const request = policy => ({ model: 'm', state: { transaction: { description: 'X' }, known_facts: [{ scope: 'client' }], accounting_policy: `base\n\n${policy}\n\nowner` }, questions: { decision: { criteria: { a: 'A' } } } });
  const receipt = { policyId: 'fi_alv_coding', policyVersion: 9, taxProfileDigest: 'd' };
  const captured = () => ({ fi_v7: { request: request(policyA), policy: { taxInstructions: policyA, receipt }, delivered_facts: [{ scope: 'client' }] },
    fi_v8: { request: request(policyD), policy: { taxInstructions: policyD, receipt: { ...receipt, guidanceVariant: 'reviewed', guidanceDigest: 'g' } }, delivered_facts: [{ scope: 'client' }] } });
  const ok = assertArmsDifferOnlyInPolicy('c', captured());
  assert.equal(ok.policy_text_identical, false);
  const refuse = (mutate, code) => { const c = captured(); mutate(c); assert.throws(() => assertArmsDifferOnlyInPolicy('c', c), new RegExp(code)); };
  refuse(c => { c.fi_v8.request.state.known_facts.push({ scope: 'jurisdiction' }); }, 'arms_differ_beyond_policy:c:request');
  refuse(c => { c.fi_v8.request.questions.decision.criteria.b = 'B'; }, 'arms_differ_beyond_policy:c:request');
  refuse(c => { c.fi_v8.policy.receipt.taxProfileDigest = 'other'; }, 'arms_differ_beyond_policy:c:receipt');
  refuse(c => { c.fi_v8.delivered_facts = []; }, 'arms_differ_beyond_policy:c:facts');
  refuse(c => { delete c.fi_v8.policy.receipt.guidanceVariant; }, 'arms_differ_beyond_policy:c:receipt|arm_variant_not_selected');
  refuse(c => { c.fi_v8.policy.taxInstructions = 'NOT IN THE REQUEST'; }, 'policy_text_not_located');
  // With the provisional arm, A vs P (and so D vs P) is held to the same rule.
  const policyP = 'PROVISIONAL FINNISH POLICY';
  const withP = () => ({ ...captured(), fi_v8p: { request: request(policyP), policy: { taxInstructions: policyP, receipt: { ...receipt, guidanceVariant: 'provisional', guidanceDigest: 'p' } }, delivered_facts: [{ scope: 'client' }] } });
  assert.equal(assertArmsDifferOnlyInPolicy('c', withP()).provisional_text_identical, false);
  const refuseP = (mutate, code) => { const c = withP(); mutate(c); assert.throws(() => assertArmsDifferOnlyInPolicy('c', c), new RegExp(code)); };
  refuseP(c => { c.fi_v8p.request.questions.decision.criteria.b = 'B'; }, 'arms_differ_beyond_policy:c:request:fi_v8p');
  refuseP(c => { c.fi_v8p.policy.receipt.taxProfileDigest = 'other'; }, 'arms_differ_beyond_policy:c:receipt:fi_v8p');
  refuseP(c => { c.fi_v8p.delivered_facts = []; }, 'arms_differ_beyond_policy:c:facts:fi_v8p');
  refuseP(c => { c.fi_v8p.policy.receipt.guidanceVariant = 'reviewed'; }, 'arm_variant_not_selected:c:fi_v8p');
});

test('the provisional arm is development-only: a holdout plan refuses it before any book or request exists', async () => {
  const record = loadFiProvisionalGuidance(fileURLToPath(new URL('../data/evals/fik-provisional-guidance/fi.json', import.meta.url)));
  assert.deepEqual(record.index.map(e => [e.id, e.covers, e.status]), [['FIK-P-001-PASSENGER-TRANSPORT-2025', ['FI-POST-16'], 'provisional'],
    ['FIK-P-002-OY-PRIVATE-EXPENDITURE', ['FI-POST-08', 'FI-POST-09'], 'provisional'], ['FIK-P-003-REDUCED-RATE-SCOPE-2025', ['FI-ALV-09'], 'provisional']]);
  record.index.forEach((e, i) => assert.equal(e.text_sha256, hash(record.entries[i].claim)));
  await assert.rejects(buildFiPlan({ adminUrl: 'postgres://localhost:1/unused', split: 'holdout', models: MODELS, provisional: record }), /^Error: provisional_arm_not_allowed_on_holdout$/);
  assert.throws(() => provisionalRecord([{ ...record.entries[0], status: 'reviewed' }], record.file_sha256), /provisional_status_required/);
  assert.equal(ARM_SPEC[FI_PROVISIONAL_ARM].guidanceVariant, 'provisional');
  assert.deepEqual(armFlags(FI_PROVISIONAL_ARM), armFlags('fi_v7'), 'no flag selects provisional content: P stages exactly A\'s flags');
});

test('the budget must price every model the lane may pay for', () => {
  const bounds = verifyBudget({ approved: true, max_calls: 5, max_input_tokens: 10, max_output_tokens: 10, max_usd: 1, prices: { typesafe: { input_per_million: 1, output_per_million: 1 }, anthropic: { input_per_million: 1, output_per_million: 1 } } });
  assert.throws(() => verifyFiBudget(bounds, { models: { jev: 'j', strong: 's' } }), /invalid_budget/);
  assert.doesNotThrow(() => verifyFiBudget({ ...bounds, prices: { ...bounds.prices, models: { j: {}, s: {} } } }, { models: { jev: 'j', strong: 's' } }));
});

test('the Kultalanka budget template passes the runner\'s budget checks once its FILL_IN blanks are filled', () => {
  const template = JSON.parse(readFileSync(new URL('../data/evals/fik-provisional-guidance/kultalanka-budget.template.json', import.meta.url), 'utf8'));
  assert.throws(() => verifyBudget(template), /invalid_budget/, 'unfilled, it never runs');
  assert.equal(template.max_usd, 20, 'Kari\'s cap, 2026-09-24');
  // Every blank is a price or a model-id key; nothing else is left to fill.
  const blanks = [];
  const walk = (v, path) => { if (typeof v === 'string' && /FILL_IN/.test(v)) blanks.push(path); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/FILL_IN/.test(k)) blanks.push(`${path}.<${k}>`); walk(x, `${path}.${k}`); } };
  walk({ ...template, _note: null }, '$');
  assert.ok(blanks.length && blanks.every(p => p.startsWith('$.prices.')), blanks.join(','));
  const modelKeys = Object.keys(template.prices.models);
  assert.deepEqual(modelKeys.map(k => /FILL_IN/.test(k)), [true, true], 'the two frozen models are priced by name');
  const dummy = { input_per_million: 1, output_per_million: 2 };
  const plan = { models: { jev: 'dummy-jev', strong: 'dummy-strong' } };
  const filled = { ...template, prices: { typesafe: dummy, anthropic: dummy, models: { [plan.models.jev]: dummy, [plan.models.strong]: dummy } } };
  const bounds = verifyBudget(filled);
  assert.doesNotThrow(() => verifyFiBudget(bounds, plan));
  // The caps hold at least the plan's 108 first requests (36 lines x A, D, P).
  assert.ok(bounds.max_calls >= 108 && bounds.max_usd === 20);
});

// ── Real PostgreSQL: the actual coder, writer and sweep ─────────────────────
const MODELS = { jev: 'fixture-jev', strong: 'fixture-strong' };
const CLAIM = 'TEST-ONLY REVIEWED FIK-3 CLAIM: printed ALV on business entertainment (edustus) meals and on gifts is never deductible; select \'Vähennyskelvoton ALV (osto)\' for them.';
const ENTRY = { id: 'FIK3-TEST-EDUSTUS', status: 'reviewed', reviewer: 'Fixture Reviewer', reviewed_on: '2026-09-24', claim: CLAIM, covers: ['FI-ALV-15'],
  sources: [{ url: 'https://www.vero.fi/fik3-test-fixture', captured_on: '2026-09-24', effective_from: '2026-01-01', effective_to: null }] };
// Scripted Jev answers by the line's description; `reviewed` says whether the
// request carried the reviewed claim (arm D). The A/D differences are authored
// so the scorer has something to count; they are not a measurement.
const JEV = {
  'SYNTH SOFTWARE OY': () => ({ account: 'Software subscriptions', tax: 'ALV 25,5 %' }),
  'PALVELUMAKSU / BANK SERVICE CHARGE': r => ({ account: 'Bank fees', tax: r ? 'Ei ALV-käsittelyä' : 'ALV 25,5 %' }),
  'SYNTH CONSULTING OY': () => ({ decision: 'ask_source_document' }),
  'SYNTH PUHELIN OY': () => ({ decision: 'ask_business_use' }),
  'SYNTH RAVINTOLA OY': r => ({ account: 'Meals and entertainment', tax: r ? 'Vähennyskelvoton ALV (osto)' : 'ALV 13,5 %' }),
  'SYNTH CLOUD GMBH': () => ({ account: 'Software subscriptions', tax: 'EU-palveluosto' }),
  'TILISIIRTO MATTI MEIKALAINEN': () => ({ decision: 'ask_recipient' }),
  'SYNTH ASIAKAS OY': () => ({ account: 'Sales', tax: 'ALV 25,5 %' })
};
const STRONG = {
  'SYNTH SOFTWARE OY': { account: 'Software subscriptions', tax: 'ALV 25,5 %' }, 'SYNTH CONSULTING OY': { account: 'Professional fees', tax: 'Ei ALV-käsittelyä' },
  'SYNTH RAVINTOLA OY': { account: 'Meals and entertainment', tax: 'Vähennyskelvoton ALV (osto)' }, 'SYNTH CLOUD GMBH': { account: 'Software subscriptions', tax: 'EU-palveluosto' }
};
const describe = text => Object.keys(JEV).find(d => text.includes(d)) || assert.fail('scripted provider: unknown line');
let network = 0;
const fixtureFetch = async (url, init) => {
  network++;
  const body = JSON.parse(init.body);
  if (String(url).includes('api.typesafe.ai')) {
    const spec = JEV[describe(JSON.stringify(body.state))](body.state.accounting_policy.includes(CLAIM));
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
      const e = Object.entries(q.criteria);
      const choice = key === 'materiality' ? 'low' : key === 'decision' ? (spec.decision && q.criteria[spec.decision] ? spec.decision : e.find(([, v]) => v.includes(`to ${spec.account}, tax treatment ${spec.tax};`))?.[0] || 'resolved')
        : key === 'account' ? (e.find(([, v]) => v === spec.account)?.[0] ?? e[0][0]) : key === 'tax' ? (e.find(([, v]) => v === spec.tax)?.[0] ?? e[0][0]) : e[0][0];
      return [key, { type: 'choice', choice, confidence: 0.9, probabilities: Object.fromEntries(e.map(([k]) => [k, k === choice ? 0.9 : 0.1 / (e.length - 1)])) }];
    }));
    return new Response(JSON.stringify({ model: MODELS.jev, answers, usage: { input_tokens: 1200, output_tokens: 40 } }), { status: 200 });
  }
  const input = JSON.parse(body.input);
  const suggestions = (input.transactions || [input.transaction]).map(t => { const s = STRONG[describe(t.description)] || assert.fail('scripted strong: unknown line');
    return { transaction_id: t.id, proposed_account: s.account, contact: 'Fixture supplier', tax_treatment: s.tax, support_note: '', ask_client_question: '', evidence_required: false, remember_candidate: false,
      merchant_pattern: '', missing_account_name: '', missing_account_type: '', missing_account_reason: '', auto_explain_limit: 0, confidence: 'high', materiality: 'normal', reasoning: 'Scripted.', warnings: [], alternatives: [] }; });
  return new Response(JSON.stringify({ id: `strong-${network}`, model: MODELS.strong, output_text: JSON.stringify(input.transactions ? { suggestions, group_summary: [] } : suggestions[0]), usage: { input_tokens: 3000, output_tokens: 400 } }), { status: 200 });
};
const BUDGET = { approved: true, max_calls: 200, max_input_tokens: 20_000_000, max_output_tokens: 4_000_000, max_usd: 100,
  prices: { typesafe: { input_per_million: 1, output_per_million: 5 }, anthropic: { input_per_million: 5, output_per_million: 25 }, models: { [MODELS.jev]: { input_per_million: 1, output_per_million: 5 }, [MODELS.strong]: { input_per_million: 2, output_per_million: 10 } } } };
const memoryLedger = () => { let l = emptyHoldoutLedger(); return { read: () => structuredClone(l), write: x => { l = structuredClone(x); }, get: () => l }; };
const live = (plan, lane, extra = {}) => runDecisionPlane(plan, { mode: 'live', lane, fetchImpl: fixtureFetch, budget: BUDGET, ranAt: '2026-09-24T00:00:00Z', ...extra });
const row = (report, id, arm) => report.outcomes.find(o => o.case_id === id && o.arm === arm);
// One frozen development plan (with the comparator) serves the development,
// holdout-baseline and CLI tests; each test installs the same reviewed entry.
let devPlanPromise = null;
const devPlan = () => (devPlanPromise ||= buildFiPlan({ adminUrl: pgUrl, split: 'development', comparator: true, models: MODELS }));
const untimed = summary => JSON.parse(JSON.stringify(summary, (k, v) => (k === 'latency' ? undefined : v)));

test('real PG: development freeze, live fixture run through the real writer, and replay', PG, async t => {
  t.after(__setFiReviewedGuidanceEntriesForTests([ENTRY]));
  const plan = await devPlan();
  verifyFiPlan(plan);
  assert.deepEqual(plan.arms, ['fi_v7', 'fi_v8', 'fi_strong']);
  // Arms A and D: same case, admission, vocabulary, source and writer path; only the policy.
  for (const c of plan.cases) {
    assert.equal(c.arms.fi_v7.guidance_variant, null);
    assert.equal(c.arms.fi_v8.guidance_variant, 'reviewed');
    assert.equal(c.arms.fi_v7.guidance_digest, null, 'A carries no guidance key (receipt compatibility)');
    assert.match(c.arms.fi_v8.guidance_digest, /^[0-9a-f]{64}$/);
    assert.equal(c.arm_check.policy_text_identical, false, `${c.id}: the reviewed entry renders on D only`);
    assert.deepEqual(c.arms.fi_v7.delivered_facts, c.arms.fi_v8.delivered_facts);
    assert.equal(Boolean(c.arms.fi_strong), c.strong_is_alternative, 'the comparator runs only where it is a real alternative');
  }
  const jobs = arm => plan.jobs.filter(j => j.arm === arm);
  for (const j of jobs('fi_v8')) assert.ok(j.request.state.accounting_policy.includes(CLAIM));
  for (const j of jobs('fi_v7')) assert.ok(!j.request.state.accounting_policy.includes(CLAIM) && j.request.state.accounting_policy.includes(FI_POLICY_CLAUSES['FI-ALV-15'].text));
  assert.deepEqual(armFlags('fi_v8').filter(f => !armFlags('fi_v7').includes(f)), ['FI_JEV_DECISION_GUIDANCE']);
  // FIK-0b admission on both arms: the entity's client fact only; the jurisdiction
  // row and the sibling's legacy merchant row never reach a request.
  const dev1 = plan.cases.find(c => c.id === 'fik3-dev-001');
  assert.deepEqual(dev1.arms.fi_v7.delivered_facts.map(f => f.scope), ['client']);
  for (const j of plan.jobs) {
    const text = JSON.stringify(j.request);
    for (const leak of [j.case_id, 'fik3', 'Unreviewed: software licences', 'Legacy: this supplier', 'synthetic-oy']) assert.ok(!text.includes(leak), `${j.id} request carries no ${leak}`);
  }
  // Deterministic: the same corpus and code freeze the same plan.
  assert.equal((await buildFiPlan({ adminUrl: pgUrl, split: 'development', comparator: true, models: MODELS })).plan_sha256, plan.plan_sha256);

  network = 0;
  const result = await live(plan, makeFiLane({ adminUrl: pgUrl, offline: true }));
  assert.equal(result.completion, 'complete');
  assert.equal(result.version, FI_VERSION);
  assert.equal(result.provider_calls, network, 'every provider request went through the shared ledger');
  assert.equal(result.budget.ledger.calls, result.provider_calls);
  assert.equal(result.budget.cumulative.calls, result.provider_calls);
  assert.ok(result.budget.ledger.usd > 0 && result.budget.reconciliation.actual.usd === result.budget.ledger.usd);
  const lane = result.lane_outcomes;
  // The real writer's journals, asks and convergence decide the score.
  assert.deepEqual(lane['fik3-dev-001/fi_v7'].journals[0].lines, goldOf(dev1).journal);
  for (const arm of ['fi_v7', 'fi_v8', 'fi_strong']) assert.equal(row(result, 'fik3-dev-001', arm).score.correct_complete, true, arm);
  assert.equal(lane['fik3-dev-001/fi_v7'].request_receipt_consistent, true, 'FIK-0a receipt digests equal the bytes the harness saw');
  // Sentinel: A tries the unevidenced deduction; the writer refusal fires and the line hangs.
  assert.deepEqual(row(result, 'fik3-dev-002', 'fi_v7').score.refusal, { expected: 'TRANSACTION_ALV_EVIDENCE_REQUIRED', tried: true, fired: true, missing: false });
  assert.equal(row(result, 'fik3-dev-002', 'fi_v7').score.terminal_reached, false);
  assert.equal(row(result, 'fik3-dev-002', 'fi_v8').score.correct_complete, true);
  assert.equal(row(result, 'fik3-dev-003', 'fi_v7').score.correct_complete, true, 'the source-document ask');
  // The comparator proposed a posting; the shared coding contract turned the
  // unevidenced material line into the source-document ask (same writer path).
  assert.equal(row(result, 'fik3-dev-003', 'fi_strong').score.correct_complete, true);
  assert.equal(lane['fik3-dev-003/fi_strong'].decision.engine, 'strong');
  assert.equal(row(result, 'fik3-dev-003', 'fi_strong').strong_calls, 1);
  const gap = row(result, 'fik3-dev-004', 'fi_v8');
  assert.equal(gap.score.excluded_from_gold, 'gap:vocabulary');
  const dev = result.summary['development/fi_v7'];
  assert.equal(dev.cases, 4);
  assert.equal(dev.incomplete_work, 2, 'the refused sentinel and the vocabulary gap');
  assert.equal(dev.excluded_from_gold.vocabulary_gap, 1);
  assert.equal(dev.refusals.fired, 1);
  assert.equal(result.summary['development/fi_v8'].correct_complete, 3);
  assert.equal(result.continuation.status, 'not_preregistered');
  assert.ok(dev.calibration.input_vat_rate['0.80-0.89'] || dev.calibration.input_vat_rate['0.90-1.00']);
  assert.ok(dev.latency.p95_wall_ms >= dev.latency.p50_wall_ms);
  // Replay: the same report from the records, with no network and no database.
  network = 0;
  const replay = await runDecisionPlane(plan, { mode: 'replay', lane: makeFiLane({}), replay: result });
  assert.equal(network, 0);
  assert.deepEqual(replay.summary, result.summary);
  assert.deepEqual(replay.outcomes, result.outcomes);
  // A frozen request that no longer matches (another reviewed set) refuses the run.
  const restore = __setFiReviewedGuidanceEntriesForTests([]);
  try {
    const drifted = await live(plan, makeFiLane({ adminUrl: pgUrl, offline: true }));
    assert.equal(drifted.completion, 'incomplete');
    const firstD = plan.jobs.findIndex(j => j.arm === 'fi_v8');
    assert.equal(drifted.provider_calls, plan.jobs.slice(0, firstD).reduce((n, j) => n + result.lane_outcomes[j.id].request_refs.length, 0), 'the run stops at the first unfrozen request; nothing after it is paid');
    assert.equal(Object.keys(drifted.lane_outcomes).length, firstD);
  } finally { restore(); __setFiReviewedGuidanceEntriesForTests([ENTRY]); }
  t.diagnostic(`FIK-3 development fixture run: ${result.provider_calls} provider calls, $${result.budget.ledger.usd.toFixed(4)} on fixture prices`);
});

test('real PG: holdout — pre-registration before any read, one-shot ledger, the gate, and replay only of what was read', PG, async t => {
  t.after(__setFiReviewedGuidanceEntriesForTests([ENTRY]));
  const baseline = publicSummary(await live(await devPlan(), makeFiLane({ adminUrl: pgUrl, offline: true })));
  const ledger = memoryLedger();
  const freeze = over => buildFiPlan({ adminUrl: pgUrl, split: 'holdout', models: MODELS, comparator: true, preregistration: preregFor(baseline), baselineSummary: baseline, holdoutLedger: ledger.read(), ...over });
  await assert.rejects(freeze({ preregistration: null }), /preregistration_required/);
  await assert.rejects(freeze({ baselineSummary: { ...baseline, completion: 'incomplete' } }), /baseline_summary_mismatch/);
  await assert.rejects(freeze({ holdoutLedger: null }), /holdout_ledger_required/);
  await assert.rejects(buildFiPlan({ adminUrl: pgUrl, split: 'development', models: MODELS, preregistration: preregFor(baseline) }), /preregistration_is_for_holdout/);
  const plan = await freeze({});
  assert.equal(plan.preregistration_sha256, hash(plan.preregistration));
  // The pre-registration is inside the frozen digest: removing it breaks the plan.
  const { plan_sha256, preregistration, preregistration_sha256, ...stripped } = plan;
  assert.throws(() => verifyFiPlan({ ...stripped, plan_sha256: hash(stripped) }), /preregistration_required/);
  assert.throws(() => buildFiReport({ ...stripped }, [], [], new Map()), /preregistration_required/);
  // Without a ledger the holdout is not read at all.
  await assert.rejects(live(plan, makeFiLane({ adminUrl: pgUrl, offline: true })), /holdout_ledger_required/);

  network = 0;
  const result = await live(plan, makeFiLane({ adminUrl: pgUrl, offline: true, holdoutLedger: ledger }));
  assert.equal(result.completion, 'complete');
  assert.deepEqual(ledger.get().reads.map(r => r.case_id).sort(), ['fik3-hold-001', 'fik3-hold-002', 'fik3-hold-003', 'fik3-hold-004']);
  assert.ok(ledger.get().reads.every(r => r.plan_sha256 === plan.plan_sha256));
  // A (v7 fixture answer) deducts the entertainment meal's printed ALV: the real
  // writer posts it, and the scorer counts a material wrong-VAT journal. D does not.
  const a = row(result, 'fik3-hold-001', 'fi_v7'), d = row(result, 'fik3-hold-001', 'fi_v8');
  assert.deepEqual(result.lane_outcomes['fik3-hold-001/fi_v7'].journals[0].lines.map(l => l.tax_code), ['ALV_13_5_INPUT', 'NONE', 'NONE']);
  assert.deepEqual(a.score.material_kinds.sort(), ['forbidden_code_posted', 'tax']);
  assert.equal(a.error_attribution.class, 'tax_interpretation');
  assert.equal(d.score.correct_complete, true);
  assert.equal(result.summary['holdout/fi_v7'].wrong_vat_journals, 1);
  assert.deepEqual(result.summary.pairwise.holdout.d_correct_a_not, ['fik3-hold-001']);
  assert.deepEqual(result.summary.pairwise.holdout.new_material_in_d, []);
  const gate = result.continuation;
  assert.equal(gate.preregistration_sha256, plan.preregistration_sha256);
  assert.equal(gate.safety.pass, true);
  assert.equal(gate.targets.min_correct_complete_delta.value, 1);
  assert.equal(gate.status, 'meets_preregistered_gate', JSON.stringify({
    targets: gate.targets,
    safety: gate.safety,
    baseline_latency: result.summary['holdout/fi_v7'].latency,
    candidate_latency: result.summary['holdout/fi_v8'].latency,
    timings: result.outcomes.filter(outcome => outcome.split === 'holdout')
      .map(({ case_id, arm, wall_ms, provider_ms }) => ({ case_id, arm, wall_ms, provider_ms })),
  }));
  // A fresh second run of the same holdout plan, or any other plan naming these cases, is refused.
  await assert.rejects(live(plan, makeFiLane({ adminUrl: pgUrl, offline: true, holdoutLedger: ledger })), /holdout_already_read/);
  await assert.rejects(freeze({ comparator: false }), /holdout_already_read/);
  // Replay re-reads only what this plan recorded.
  const replay = await runDecisionPlane(plan, { mode: 'replay', lane: makeFiLane({ holdoutLedger: ledger }), replay: result });
  assert.deepEqual(replay.summary, result.summary);
  await assert.rejects(runDecisionPlane(plan, { mode: 'replay', lane: makeFiLane({ holdoutLedger: memoryLedger() }), replay: result }), /holdout_read_not_recorded/);
  // The safety gate reads new material errors in D against A, not totals.
  const flipped = structuredClone(result.summary);
  flipped.pairwise.holdout.new_material_in_d = ['fik3-hold-002'];
  const { preregisteredGate } = await import('./jev_decision_plane_fi.js');
  assert.equal(preregisteredGate(plan, flipped).status, 'fails_safety_gate');
});

test('real PG: spend-ledger continuity — a budget stop resumes, reuses paid calls without re-requesting them, and ends at the uninterrupted report', PG, async t => {
  t.after(__setFiReviewedGuidanceEntriesForTests([ENTRY]));
  const plan = await buildFiPlan({ adminUrl: pgUrl, split: 'development', cases: ['fik3-dev-001', 'fik3-dev-003'], comparator: true, models: MODELS });
  const whole = await live(plan, makeFiLane({ adminUrl: pgUrl, offline: true }));
  assert.equal(whole.completion, 'complete');
  let checkpoint = null;
  network = 0;
  const stopped = await live(plan, makeFiLane({ adminUrl: pgUrl, offline: true }), { budget: { ...BUDGET, max_calls: 3 }, onCheckpoint: r => { checkpoint = structuredClone(r); } });
  assert.equal(stopped.completion, 'incomplete');
  assert.equal(stopped.budget.refusal.bound, 'max_calls');
  assert.equal(network, 3, 'the refused call was never sent');
  assert.equal(checkpoint.records.length, 3);
  assert.ok(checkpoint.lane_outcomes, 'the checkpoint carries the lane outcomes so far');
  network = 0;
  const resumed = await live(plan, makeFiLane({ adminUrl: pgUrl, offline: true }), { resume: checkpoint });
  assert.equal(resumed.completion, 'complete');
  assert.equal(resumed.resumed_calls, 3);
  assert.equal(network, whole.provider_calls - 3, 'paid calls are reused, never re-requested');
  assert.equal(resumed.budget.cumulative.calls, whole.provider_calls, 'the cumulative ledger spans the resume chain');
  assert.equal(resumed.budget.cumulative.runs, 2);
  assert.deepEqual(untimed(resumed.summary), untimed(whole.summary), 'identical but for measured wall-clock latency');
  // A checkpoint cannot be resumed under another plan (a different arm set).
  const narrower = await buildFiPlan({ adminUrl: pgUrl, split: 'development', cases: ['fik3-dev-001'], models: MODELS });
  await assert.rejects(live(narrower, makeFiLane({ adminUrl: pgUrl, offline: true }), { resume: checkpoint }), /invalid_resume|resume_record_mismatch/);
});

// A draft entry whose claim is the scripted provider's marker: the fixture
// answers P as it answers D. Authored mechanics, never a measurement.
const DRAFT = { id: 'FIK-P-TEST-EDUSTUS', status: 'provisional', author: 'Fixture Author', drafted_on: '2026-09-24', rationale: 'Fixture draft.', claim: CLAIM, covers: ['FI-ALV-15'],
  sources: [{ url: 'https://www.vero.fi/fik3-provisional-fixture', captured_on: null, snapshot_owed: true, effective_from: null, effective_to: null }] };
test('real PG: provisional development arm — frozen draft, arms differ only in policy, A vs P per entry through the scorer and spend ledger', PG, async t => {
  t.after(__setFiReviewedGuidanceEntriesForTests([ENTRY]));
  const draft = provisionalRecord([DRAFT], 'd'.repeat(64));
  const plan = await buildFiPlan({ adminUrl: pgUrl, split: 'development', models: MODELS, provisional: draft });
  verifyFiPlan(plan);
  assert.deepEqual(plan.arms, ['fi_v7', 'fi_v8', 'fi_v8p']);
  assert.deepEqual(plan.provisional_guidance.index, [{ id: DRAFT.id, covers: ['FI-ALV-15'], status: 'provisional', text_sha256: hash(CLAIM) }]);
  assert.deepEqual(plan.book_flags.fi_v8p, plan.book_flags.fi_v7);
  for (const c of plan.cases) {
    assert.equal(c.arms.fi_v8p.guidance_variant, 'provisional');
    assert.deepEqual(c.arms.fi_v8p.provisional_entry_ids, [DRAFT.id]);
    assert.notEqual(c.arms.fi_v8p.guidance_digest, c.arms.fi_v8.guidance_digest, 'the same text as D is still never a v8 receipt');
    assert.equal(c.arm_check.provisional_text_identical, false);
  }
  for (const j of plan.jobs.filter(j => j.arm === 'fi_v8p')) assert.ok(j.request.state.accounting_policy.includes(CLAIM) && !j.request.state.accounting_policy.includes(FI_POLICY_CLAUSES['FI-ALV-15'].text), 'replaced, never appended');
  // The frozen plan binds the draft: tampering, or a holdout case, refuses it.
  const rehash = ({ plan_sha256, ...body }) => ({ ...body, plan_sha256: hash(body) });
  const tampered = structuredClone(plan); tampered.provisional_guidance.entries[0].claim = 'OTHER';
  assert.throws(() => verifyFiPlan(rehash(tampered)), /provisional_guidance_record_mismatch/);
  const leaked = structuredClone(plan); leaked.cases[0].split = 'holdout';
  assert.throws(() => verifyFiPlan(rehash(leaked)), /provisional_arm_not_allowed_on_holdout/);
  const orphan = structuredClone(plan); orphan.arms = ['fi_v7', 'fi_v8'];
  assert.throws(() => verifyFiPlan(rehash(orphan)), /frozen_plan_mismatch/);

  network = 0;
  const result = await live(plan, makeFiLane({ adminUrl: pgUrl, offline: true }));
  assert.equal(result.completion, 'complete');
  assert.equal(result.provider_calls, network, 'the P arm is paid through the same shared ledger');
  assert.equal(result.budget.ledger.calls, result.provider_calls);
  assert.equal(result.lane_outcomes['fik3-dev-002/fi_v8p'].decision.coding_policy.guidanceVariant, 'provisional');
  assert.equal(row(result, 'fik3-dev-002', 'fi_v8p').score.correct_complete, true);
  assert.equal(row(result, 'fik3-dev-002', 'fi_v7').score.correct_complete, false);
  const p = result.summary.provisional;
  assert.equal(p.status, 'provisional');
  assert.deepEqual(p.p_correct_a_not, ['fik3-dev-002']);
  assert.deepEqual(p.new_material_in_p, []);
  assert.deepEqual(p.changed_without_entry, []);
  assert.deepEqual(p.entries[0].changed, [{ case_id: 'fik3-dev-002', direction: 'better' }]);
  assert.equal(p.entries[0].better, 1);
  assert.equal(p.entries[0].worse, 0);
  assert.deepEqual(p.entries[0].cases_rendered, plan.cases.map(c => c.id));
  assert.equal(result.summary['development/fi_v8p'].correct_complete, result.summary['development/fi_v8'].correct_complete);
  assert.equal(result.continuation.status, 'not_preregistered');
  const replay = await runDecisionPlane(plan, { mode: 'replay', lane: makeFiLane({}), replay: result });
  assert.deepEqual(replay.summary, result.summary);
  // Nothing lingers: after the arm the same process resolves v7 at the owners.
  const { resolveCodingPolicy } = await import('../server/donna/codingPolicy.js');
  assert.equal(resolveCodingPolicy({ jurisdiction: 'fi', businessDate: '2026-03-10' }).guidanceVariant, null);
});

test('real PG: CLI — the lane freezes a development plan, refuses a holdout without pre-registration, and replays offline', PG, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fik3-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./jev_decision_plane.js', import.meta.url)), ...args],
    { encoding: 'utf8', env: { ...process.env, TYPESAFE_MODEL: MODELS.jev, OPENAI_MODEL: MODELS.strong } });
  const planPath = join(dir, 'plan.json');
  const dry = cli('--lane=fi-coding', '--mode=dry-run', '--split=development', `--plan=${planPath}`, '--cases=fik3-dev-001');
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  assert.equal(plan.lane, 'fi-coding');
  assert.equal(cli('--lane=fi-coding', '--mode=dry-run', '--split=holdout', `--plan=${join(dir, 'h.json')}`).stderr.trim(), 'preregistration_required');
  // --provisional: only by explicit path, only on a development dry-run, frozen into the plan.
  const draftPath = fileURLToPath(new URL('../data/evals/fik-provisional-guidance/fi.json', import.meta.url));
  const provisionalPlanPath = join(dir, 'p.json');
  const withDraft = cli('--lane=fi-coding', '--mode=dry-run', '--split=development', `--plan=${provisionalPlanPath}`, '--cases=fik3-dev-001', `--provisional=${draftPath}`);
  assert.equal(withDraft.status, 0, withDraft.stderr);
  const provisionalPlan = JSON.parse(readFileSync(provisionalPlanPath, 'utf8'));
  assert.deepEqual(provisionalPlan.arms, ['fi_v7', 'fi_v8', 'fi_v8p']);
  assert.equal(provisionalPlan.provisional_guidance.file_sha256, hash(readFileSync(draftPath, 'utf8')));
  assert.equal(cli('--lane=fi-coding', '--mode=dry-run', '--split=holdout', `--plan=${join(dir, 'hp.json')}`, `--provisional=${draftPath}`).stderr.trim(), 'provisional_arm_not_allowed_on_holdout');
  assert.equal(cli('--lane=fi-coding', '--mode=replay', `--plan=${provisionalPlanPath}`, `--replay=${join(dir, 'none.json')}`, `--output=${join(dir, 'o.json')}`, `--provisional=${draftPath}`).stderr.trim(), 'fresh_output_required', 'the draft is read only at freeze time');
  assert.equal(cli('--mode=dry-run', `--provisional=${draftPath}`, `--plan=${join(dir, 'z.json')}`).stderr.trim(), 'invalid_argument', 'the reconciliation lane has no provisional arm');
  assert.equal(cli('--lane=other', '--mode=dry-run', `--plan=${join(dir, 'x.json')}`).stderr.trim(), 'invalid_argument');
  assert.equal(cli('--lane=fi-month', '--mode=dry-run', `--provisional=${draftPath}`, `--plan=${join(dir, 'w.json')}`).stderr.trim(), 'invalid_argument', 'the whole-month lane has no provisional arm');
  assert.equal(cli('--mode=dry-run', '--comparator=true', `--plan=${join(dir, 'y.json')}`).stderr.trim(), 'invalid_argument', 'lane arguments never reach the reconciliation lane');
  const result = await live(plan, makeFiLane({ adminUrl: pgUrl, offline: true }));
  const resultPath = join(dir, 'result.json');
  writeFileSync(resultPath, JSON.stringify(result));
  const out = join(dir, 'replay.json'), pub = join(dir, 'public.json');
  const replay = cli('--lane=fi-coding', '--mode=replay', `--plan=${planPath}`, `--replay=${resultPath}`, `--output=${out}`, `--public=${pub}`);
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).summary, result.summary);
  const summary = JSON.parse(readFileSync(pub, 'utf8'));
  assert.ok(!('records' in summary) && !('lane_outcomes' in summary) && !JSON.stringify(summary).includes(MODELS.jev), 'the public summary carries no records, bodies or model ids');
  assert.ok(existsSync(out));
});
