// Expressibility gate and partition invariants for the Jev decision-plane corpus.
// Real PostgreSQL is required: preparation runs the production eligibility SQL on
// temporary tables. Missing DONNA_PG_TEST_URL is INCOMPLETE, never a skipped green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadFixtures } from '../server/donna/evalHarness.js';
import { prepareEvidencePacket, composeEvidenceAction, instrumentReversal, evidenceSufficiency } from './jev_evidence_action_contract.js';
import { ROOT, loadContractCorpus, injectedAnswers, runContract } from './jev_evidence_action.js';
import { hash } from './jev_evidence_action_contract.js';
import { buildCorpus, authorChecks, DIRECTORIES, PREFIXES, ROUTES, TERMINALS, FRESH_FAMILIES, REVERSAL_FAMILIES, DIRECT_FAMILIES } from './jev_decision_plane_corpus_author.js';

const databaseUrl = process.env.DONNA_PG_TEST_URL;
if (!databaseUrl) throw new Error('INCOMPLETE: DONNA_PG_TEST_URL required for real offline preparation');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
test.after(async () => { await client.end(); });

// Declared sizes (the protocol doc pre-registers these; the test pins them).
export const DECLARED = { development_min: 40, holdout_min: 80, holdout_families_min: 20, holdout_model_dependent_share_min: 0.7 };
// The legacy corpus and its committed report must stay byte-identical.
const LEGACY_REPORT = 'data/evals/experiments/jev-evidence-action-2026-09-17.json';
const LEGACY_REPORT_SHA256 = '9b8f5a67ff7686c569852a36163cb8e69c8134154f6a0305cb90e8344843afc4';
const LEGACY_CORPUS_SHA256 = '27f65e73a1cfcb6f3d2a64f3a1790cc2af6d70a64d213baaa8355d3118cac699';

const fixturesRoot = resolve(ROOT, 'data/evals/fixtures');
const load = split => loadFixtures(DIRECTORIES[split].split('/').pop(), { root: fixturesRoot })
  .filter(f => f.__file.startsWith(`${PREFIXES[split]}-`)); // other workstreams may add review-0NN.json beside ours
const corpus = { development: load('development'), holdout: load('holdout'), reversal: load('reversal'), fresh: load('fresh'), direct: load('direct') };
const all = [...corpus.development, ...corpus.holdout];
const routeWords = new RegExp(`${ROUTES.join('|')}|label_reason|expected_route|model_dependent`, 'i');
const SPLIT_OF_PREFIX = { dev: 'development', holdout: 'holdout', reversal: 'development', fresh: 'fresh', direct: 'development' };

async function decide(f, unknown = false, policy = 'conjunction') {
  const prepared = await prepareEvidencePacket(f.packet, client);
  const answers = prepared.error ? [] : injectedAnswers(prepared, f.semantic_statuses, { unknown });
  return { prepared, decision: composeEvidenceAction(prepared, answers, { policy }) };
}
const proposalKey = ps => hash(ps.map(p => ({ transaction_id: p.transaction_id, invoice_id: p.invoice_id, amount_minor: p.amount_minor })).sort((a, b) => a.transaction_id.localeCompare(b.transaction_id)));

test('the committed fixtures are exactly what the deterministic author produces from its hand-written specs', () => {
  const built = buildCorpus();
  for (const split of Object.keys(DIRECTORIES)) {
    assert.deepEqual(corpus[split].map(f => f.id), built[split].map(f => f.id), `${split} ids`);
    for (const [i, f] of corpus[split].entries()) {
      const { __file, ...committed } = f;
      assert.equal(hash(committed), hash(built[split][i]), `${f.id} differs from the author output`);
      assert.deepEqual(authorChecks(f), [], `${f.id} author checks`);
    }
  }
});

test('split and family partition invariants hold', () => {
  const fam = split => new Set(corpus[split].map(f => f.adjudication.source_family));
  for (const f of [...all, ...corpus.reversal, ...corpus.fresh, ...corpus.direct]) {
    assert.ok(['development', 'holdout', 'fresh'].includes(f.adjudication.split), `${f.id} has a split`);
    assert.equal(f.adjudication.split, SPLIT_OF_PREFIX[f.__file.split('-')[0]], `${f.id} split matches its directory`);
    assert.ok(f.adjudication.source_family && f.adjudication.family_description && f.adjudication.error_mode, `${f.id} names its family`);
    assert.ok(['GB', 'FI', 'SG', 'other'].includes(f.adjudication.market));
    assert.equal(f.adjudication.status, 'provisional'); assert.equal(f.adjudication.reviewer, null);
    assert.equal(typeof f.adjudication.model_dependent, 'boolean');
    for (const key of ['label_reason', 'positive_evidence', 'contradictions', 'acceptable_outcomes', 'prohibited_outcomes', 'limitations']) assert.ok(f.adjudication[key], `${f.id} ${key}`);
    assert.ok(Object.hasOwn(f.adjudication, 'missing_fact'));
    assert.ok(f.adjudication.limitations.some(l => /not independently adjudicated/i.test(l)), `${f.id} states it is not independently adjudicated`);
    assert.ok(ROUTES.includes(f.expected.route), `${f.id} route`);
    assert.ok(Array.isArray(f.expected.proposals));
  }
  const shared = [...fam('development')].filter(x => fam('holdout').has(x));
  assert.deepEqual(shared, [], 'no family appears in both splits');
  assert.ok(corpus.development.length >= DECLARED.development_min, `development ${corpus.development.length}`);
  assert.ok(corpus.holdout.length >= DECLARED.holdout_min, `holdout ${corpus.holdout.length}`);
  assert.ok(fam('holdout').size >= DECLARED.holdout_families_min, `holdout families ${fam('holdout').size}`);
  const mdShare = corpus.holdout.filter(f => f.adjudication.model_dependent).length / corpus.holdout.length;
  assert.ok(mdShare >= DECLARED.holdout_model_dependent_share_min, `holdout model-dependent share ${mdShare}`);
  // Holdout families must not be legacy scenarios: no prior_art pointers, no legacy digests.
  for (const f of corpus.holdout) { assert.equal(f.adjudication.prior_art, undefined); assert.equal(f.adjudication.legacy_fixture_sha256, undefined); }
  // Every holdout market appears, and no market dominates.
  const markets = corpus.holdout.reduce((m, f) => ({ ...m, [f.adjudication.market]: (m[f.adjudication.market] || 0) + 1 }), {});
  for (const m of ['GB', 'FI', 'SG']) assert.ok(markets[m] >= 15, `holdout ${m} ${markets[m]}`);
});

test('no source text names its label, route or fixture identity, and no model id is committed', () => {
  for (const f of [...all, ...corpus.reversal, ...corpus.fresh, ...corpus.direct]) {
    for (const s of f.packet.sources) {
      assert.doesNotMatch(s.content, routeWords, `${f.id} ${s.id} mentions a label word`);
      assert.doesNotMatch(s.content, new RegExp(`${f.id}|tx-t\\d|invoice-focal|invoice-r\\d|opaque-`), `${f.id} ${s.id} leaks a fixture id`);
      assert.equal(s.provenance, 'assumed_synthetic');
    }
    assert.doesNotMatch(JSON.stringify(f), /gpt-\d|claude-\d|o\d-mini|sonnet|opus|haiku/i, `${f.id} names a model`);
  }
});

for (const split of ['development', 'holdout']) {
  test(`${split}: every case lands on its expected route and proposals under ideal answers through the shared harness`, async () => {
    const report = await runContract({ client, fixtures: corpus[split], mode: 'ideal', ranAt: '2026-09-18T00:00:00.000Z' });
    assert.equal(report.evaluation.totals.fixtures, corpus[split].length);
    assert.equal(report.evaluation.totals.errored, 0);
    const failed = report.evaluation.cases.filter(c => c.status !== 'pass').map(c => `${c.id}: ${c.actual?.decision?.route} ${c.actual?.decision?.reason}`);
    assert.deepEqual(failed, [], 'ideal-answer expressibility');
    assert.equal(report.provider_calls, 0); assert.equal(report.capability_verdict, 'not_measured');
    assert.equal(report.independently_reviewed_labels, 0);
    for (const c of report.evaluation.cases) for (const key of ['writer_authority', 'production_terminal', 'proposal_applied', 'question_delivered']) assert.equal(c.actual.decision[key], false);
  });

  test(`${split}: unknown answers never produce a proposal or a customer question, and model dependence is what the compiler actually consumed`, async () => {
    for (const f of corpus[split]) {
      const ideal = await decide(f), unknown = await decide(f, true);
      assert.equal(ideal.decision.route, f.expected.route, f.id);
      assert.equal(proposalKey(ideal.decision.proposals), proposalKey(f.expected.proposals), f.id);
      assert.equal(unknown.decision.proposals.length, 0, `${f.id} unknown proposals`);
      assert.notEqual(unknown.decision.route, 'customer_question', `${f.id} unknown question`);
      assert.equal(ideal.decision.consumed_answers.length > 0, f.adjudication.model_dependent, `${f.id} declared model dependence`);
      // Neither the label nor the fixture identity reaches the semantic state.
      assert.doesNotMatch(JSON.stringify({ state: ideal.prepared.state, questions: ideal.prepared.questions }), /label_reason|expected_route|source_family|adjudication|model_dependent|"proposals"/);
      if (f.expected.route === 'customer_question') {
        assert.ok(f.packet.missing_fact && f.semantic_statuses.ask_fact === 'supported', f.id);
        assert.equal(ideal.decision.question_delivered, false);
      }
    }
  });
}

test('the legacy 34-case corpus and its committed report are untouched', async () => {
  const legacy = loadContractCorpus();
  assert.equal(legacy.length, 34);
  assert.equal(hash(legacy.map(({ __file, ...f }) => f)), LEGACY_CORPUS_SHA256);
  assert.equal(createHash('sha256').update(readFileSync(resolve(ROOT, LEGACY_REPORT))).digest('hex'), LEGACY_REPORT_SHA256);
  assert.equal(JSON.parse(readFileSync(resolve(ROOT, LEGACY_REPORT), 'utf8')).corpus_sha256, LEGACY_CORPUS_SHA256);
});

test('the recorded route mix and model-dependent counts match the protocol document', () => {
  const mix = split => corpus[split].reduce((m, f) => ({ ...m, [f.expected.route]: (m[f.expected.route] || 0) + 1 }), {});
  const md = split => corpus[split].filter(f => f.adjudication.model_dependent).length;
  const doc = readFileSync(resolve(ROOT, 'docs/experiments/jev-decision-plane-protocol.md'), 'utf8');
  // The protocol document predates the `needs_evidence` route (capability-boundary session); its frozen lines carry the original six.
  const expectLine = (split, m) => `${split}: ${corpus[split].length} cases, ${new Set(corpus[split].map(f => f.adjudication.source_family)).size} families, ${md(split)} model-dependent; `
    + ROUTES.filter(r => r !== 'needs_evidence').map(r => `${r} ${m[r] || 0}`).join(', ');
  for (const split of ['development', 'holdout']) assert.ok(doc.includes(expectLine(split, mix(split))), `protocol doc carries the line "${expectLine(split, mix(split))}"`);
  assert.ok(doc.includes('Trust-the-strong-LLM principle — still in force'));
});

// ── The capability-boundary corpora (2026-09-18) ────────────────────────────
// `jev-plane-reversal`: development-authored regression fixtures for the
// reversal fact. `jev-plane-fresh`: the frozen fresh family set. Their labels
// carry the three-terminal ground truth beside the route and are expressed
// under the `max_authority` policy (the label's policy); `safe` is the
// production-shaped reference and is NOT expected to reach `needs_evidence`.
const BRIEF_FAMILIES = ['fresh-gb-cheque-deposit-returned-then-cleared', 'fresh-fi-supplier-transfer-bounced-and-resent', 'fresh-sg-stripe-payout-settlement-present-or-missing',
  'fresh-gb-director-transfer-salary-loan-or-dividend', 'fresh-fi-instalment-payments-with-viite', 'fresh-sg-usd-invoice-sgd-inward-remittance', 'fresh-gb-two-open-invoices-one-customer',
  'fresh-fi-mobilepay-fee-netted-settlement', 'fresh-sg-two-same-amount-credits-same-day', 'fresh-gb-cash-direction-refund-beside-payment', 'fresh-fi-alv-net-or-gross-payment',
  'fresh-sg-remittance-and-bank-reference-disagree'];

test('the fresh set carries the brief\'s families with three-terminal labels, shares no family with the frozen corpora, and never touched them', () => {
  assert.deepEqual(FRESH_FAMILIES.map(f => f.family), BRIEF_FAMILIES);
  assert.ok(corpus.fresh.length >= 30 && new Set(corpus.fresh.map(f => f.adjudication.source_family)).size >= 10, `fresh ${corpus.fresh.length}`);
  const frozen = new Set(all.map(f => f.adjudication.source_family));
  for (const f of [...corpus.fresh, ...corpus.reversal, ...corpus.direct]) {
    assert.ok(!frozen.has(f.adjudication.source_family), `${f.id} reuses a frozen family`);
    assert.ok(TERMINALS.includes(f.expected.terminal), `${f.id} terminal`);
    assert.ok(f.adjudication.terminal_reason, `${f.id} terminal reason`);
    assert.equal(f.expected.route === 'needs_evidence', f.expected.terminal === 'NEEDS_EVIDENCE' && f.expected.route !== 'customer_question', `${f.id} needs_evidence route ↔ terminal`);
    if (f.expected.terminal === 'RESOLVED') assert.ok(['supported_proposal', 'unresolved_research', 'not_admitted'].includes(f.expected.route), f.id);
    if (f.expected.terminal === 'NEEDS_REASONING') assert.equal(f.expected.route, 'strong_reasoning', f.id);
  }
  const terminals = corpus.fresh.reduce((m, f) => ({ ...m, [f.expected.terminal]: (m[f.expected.terminal] || 0) + 1 }), {});
  assert.ok(terminals.RESOLVED >= 15 && terminals.NEEDS_EVIDENCE >= 3 && terminals.NEEDS_REASONING >= 3, JSON.stringify(terminals));
  // Reasoning labels that measure a contract restriction are declared as such (`contract_gap`); reasoning labels a mechanical check
  // decides before any semantic answer is consulted are declared `rule_blocked` (second review, finding 4). Under this contract a
  // NEEDS_REASONING label a semantic answer could change would have to assert that the ideal obligation answer is `not_established`
  // on a mechanically clean link — a label about our assumptions, not the evidence — so the fresh set carries NONE: it bounds the
  // reasoning boundary from below only, and the record says so plainly.
  const reasoning = corpus.fresh.filter(f => f.expected.terminal === 'NEEDS_REASONING');
  assert.deepEqual(reasoning.filter(f => f.adjudication.contract_gap).map(f => f.id), ['fresh-015', 'fresh-025']);
  assert.deepEqual(reasoning.filter(f => f.adjudication.rule_blocked).map(f => [f.id, f.adjudication.rule_blocked]), [['fresh-023', 'relationship_amount_conflict'], ['fresh-035', 'conflicting_allocations']]);
  assert.equal(reasoning.filter(f => !f.adjudication.contract_gap && !f.adjudication.rule_blocked).length, 0, 'no reasoning label a semantic answer can change; the set bounds the boundary from below only');
  for (const f of reasoning) assert.ok(!(f.adjudication.contract_gap && f.adjudication.rule_blocked), `${f.id} carries one marker`);
  // Companion owner requests are labelled where a resolution leaves an unevidenced sibling.
  assert.deepEqual(corpus.fresh.filter(f => f.expected.evidence_requests).map(f => [f.id, f.expected.evidence_requests]), [['fresh-026', ['tx-t2']]]);
  // fresh-032 follows the corpus's own partial-allocation convention (review finding 3).
  assert.equal(corpus.fresh.find(f => f.id === 'fresh-032').expected.route, 'supported_proposal');
  for (const m of ['GB', 'FI', 'SG']) assert.ok(corpus.fresh.filter(f => f.adjudication.market === m).length >= 9, m);
  assert.equal(corpus.reversal.length, 8); assert.equal(REVERSAL_FAMILIES.length, 3);
  assert.ok(corpus.reversal.every(f => f.adjudication.split === 'development'));
  // The frozen corpora are what they were: the author's development/holdout output has not moved.
  assert.equal(corpus.development.length, 44); assert.equal(corpus.holdout.length, 84);
  assert.ok(all.every(f => f.packet.transactions.every(t => t.instrument === undefined)), 'no frozen fixture carries the new instrument field');
});

for (const name of ['reversal', 'fresh']) {
  test(`${name}: every case lands on its labelled route and proposals under ideal answers through max_authority, and never acts under unknown answers`, async () => {
    for (const f of corpus[name]) {
      const ideal = await decide(f, false, 'max_authority'), unknown = await decide(f, true, 'max_authority');
      assert.equal(ideal.decision.route, f.expected.route, `${f.id} ${ideal.decision.reason}`);
      assert.equal(proposalKey(ideal.decision.proposals), proposalKey(f.expected.proposals), f.id);
      assert.equal(ideal.decision.consumed_answers.length > 0, f.adjudication.model_dependent, `${f.id} declared model dependence`);
      assert.equal(unknown.decision.proposals.length, 0, `${f.id} unknown proposals`);
      // Under max_authority an owner ask or an evidence request under UNKNOWN answers is allowed only where the packet is
      // mechanically missing evidence (no unbound source at all): a declared owner fact is asked on the declaration, a
      // candidate with no source gets a request; present-but-unread evidence never becomes a request (review finding 2).
      if (['customer_question', 'needs_evidence'].includes(unknown.decision.route)) {
        assert.equal(evidenceSufficiency(unknown.prepared).status, 'missing', `${f.id} asks under unknown answers although evidence exists`);
        if (unknown.decision.route === 'customer_question') { assert.ok(f.packet.missing_fact); assert.equal(unknown.decision.reason, 'declared_customer_fact_unconfirmed'); }
      }
      assert.notEqual((await decide(f, true)).decision.route, 'customer_question', `${f.id} the conjunction never asks under unknown answers`);
      // A `rule_blocked` reasoning label is exactly one a mechanical check decides: ideal and unknown answers escalate on the marker's
      // code and no deciding answer exists, so the case measures the rule, not the model (second review, finding 4). Conversely a
      // reasoning label without a marker must be one a semantic answer can change (ideal and unknown answers differ).
      if (f.expected.terminal === 'NEEDS_REASONING') {
        const code = d => d.dependencies?.[0]?.blocked_by?.[0] ?? d.dependencies?.[0]?.reason ?? d.reason;
        if (f.adjudication.rule_blocked) {
          assert.equal(code(ideal.decision), f.adjudication.rule_blocked, `${f.id} rule-blocked on its marker`); assert.equal(code(unknown.decision), f.adjudication.rule_blocked, `${f.id} unknown answers hit the same rule`);
          assert.equal(ideal.decision.deciding_answers.length, 0, `${f.id} no semantic answer decided it`);
        } else if (!f.adjudication.contract_gap) assert.notEqual(`${ideal.decision.reason}:${code(ideal.decision)}`, `${unknown.decision.reason}:${code(unknown.decision)}`, `${f.id} a semantic answer must be able to change a genuine reasoning label`);
      }
      for (const key of ['writer_authority', 'production_terminal', 'proposal_applied', 'question_delivered']) assert.equal(ideal.decision[key], false);
      assert.doesNotMatch(JSON.stringify({ state: ideal.prepared.state, questions: ideal.prepared.questions }), /label_reason|expected_route|source_family|adjudication|model_dependent|terminal|"proposals"/);
      if (f.expected.route === 'customer_question') assert.ok(f.packet.missing_fact && f.semantic_statuses.ask_fact === 'supported', f.id);
      // The forced policy terminates every case from the typed answers: no strong_reasoning route exists under it.
      const forced = await decide(f, false, 'forced');
      assert.notEqual(forced.decision.route, 'strong_reasoning', `${f.id} forced never escapes`);
      if (f.expected.terminal !== 'NEEDS_REASONING') { assert.equal(forced.decision.route, f.expected.route, `${f.id} forced`); assert.equal(proposalKey(forced.decision.proposals), proposalKey(f.expected.proposals), f.id); }
      else assert.ok(forced.decision.route === 'unresolved_research' && forced.decision.proposals.length === 0, `${f.id} forced blocks or negatives a reasoning label under ideal answers`);
    }
  });
}

test('the reversal fact is the instrument, opposite direction, same amount, not earlier; the frozen holdout shapes carry no instrument and stay as labelled', async () => {
  const byId = id => corpus.reversal.find(f => f.id === id);
  const returned = byId('reversal-002'), p = returned.packet;
  assert.deepEqual(instrumentReversal(p, p.transactions.find(t => t.id === 'tx-t1')), { transaction_id: 'tx-t2', date: '2026-09-11', instrument: 'cheque:UOB:004417', amount_minor: 436000 });
  assert.equal(instrumentReversal(p, p.transactions.find(t => t.id === 'tx-t2')), null, 'the return itself has no later opposite event');
  const represented = byId('reversal-003').packet;
  assert.equal(instrumentReversal(represented, represented.transactions.find(t => t.id === 'tx-t1'))?.transaction_id, 'tx-t2');
  assert.equal(instrumentReversal(represented, represented.transactions.find(t => t.id === 'tx-t3')), null, 'a re-presented cheque that clears is not reversed');
  const partial = byId('reversal-006').packet;
  assert.equal(instrumentReversal(partial, partial.transactions.find(t => t.id === 'tx-t1')), null, 'a partial refund on the same instrument is not a reversal');
  for (const f of corpus.reversal) for (const policy of ['safe', 'max_authority', 'forced']) {
    const d = (await decide(f, false, policy)).decision;
    assert.equal(d.route, f.expected.route, `${f.id} ${policy}`); assert.equal(proposalKey(d.proposals), proposalKey(f.expected.proposals), `${f.id} ${policy}`);
    if (f.expected.route === 'unresolved_research') { assert.equal(d.reason, 'instrument_reversed_no_settlement'); assert.equal(d.reversals.length, 1); }
  }
  // holdout-021 (the returned cheque) is untouched: no instrument, so the deposit still composes on the slip under attempt-first; the label stays strong_reasoning.
  const h21 = corpus.holdout.find(f => f.id === 'holdout-021');
  assert.equal(h21.expected.route, 'strong_reasoning');
  assert.ok(h21.packet.transactions.every(t => t.instrument === undefined));
});

// `jev-plane-direct` (2026-09-19, review finding 2): development-authored pairs
// with IDENTICAL source evidence and the SAME accounting expectation
// (`expected.direct_plan`), with and without the packet assembler's authored
// relationship. The gate pins the dependency the pairs exist to expose: the
// typed contract reaches the label only WITH the relationship (without it the
// present evidence goes uninterpreted and the case escalates), and it never
// acts under unknown answers on either member.
test('direct pairs: identical evidence with and without the authored relationship, the same expectation, and the typed contract reaches the label only with the relationship', async () => {
  assert.equal(corpus.direct.length, 10); assert.equal(DIRECT_FAMILIES.length, 3);
  assert.ok(corpus.direct.every(f => f.adjudication.split === 'development' && typeof f.adjudication.authored_relationships === 'boolean' && f.expected.direct_plan));
  const pairs = [['direct-001', 'direct-002'], ['direct-003', 'direct-004'], ['direct-005', 'direct-006'], ['direct-007', 'direct-008'], ['direct-009', 'direct-010']];
  const byId = Object.fromEntries(corpus.direct.map(f => [f.id, f]));
  for (const [withId, withoutId] of pairs) {
    const a = byId[withId], b = byId[withoutId];
    assert.equal(a.adjudication.authored_relationships, true); assert.equal(b.adjudication.authored_relationships, false);
    assert.ok(a.packet.links.length > 0 && b.packet.links.length === 0, `${withId}/${withoutId} links`);
    assert.equal(hash(a.packet.sources.map(s => [s.id, s.kind, s.content])), hash(b.packet.sources.map(s => [s.id, s.kind, s.content])), 'identical source evidence');
    assert.equal(hash(a.packet.transactions), hash(b.packet.transactions));
    assert.equal(a.expected.route, b.expected.route); assert.equal(proposalKey(a.expected.proposals), proposalKey(b.expected.proposals));
    assert.equal(hash(a.expected.direct_plan), hash(b.expected.direct_plan), 'the same complete accounting expectation, every component');
    assert.equal(a.expected.direct_plan.unspecified, undefined, 'the pairs state every component');
    const ideal = await decide(a, false, 'max_authority'), idealWithout = await decide(b, false, 'max_authority');
    assert.equal(ideal.decision.route, a.expected.route, `${withId} reaches its label with the relationship`);
    assert.equal(proposalKey(ideal.decision.proposals), proposalKey(a.expected.proposals));
    assert.notEqual(idealWithout.decision.route, b.expected.route, `${withoutId}: the typed contract cannot reach the label without the relationship`);
    assert.equal(idealWithout.decision.route, 'strong_reasoning'); assert.equal(idealWithout.decision.reason, 'unresolved_relevant_relationships');
    assert.equal(idealWithout.decision.dependencies[0].reason, 'present_evidence_not_interpreted');
    for (const f of [a, b]) { const unknown = await decide(f, true, 'max_authority'); assert.equal(unknown.decision.proposals.length, 0); assert.notEqual(unknown.decision.route, 'customer_question'); }
  }
});

test('the capability-boundary record carries the machine-checked fresh mix line', () => {
  const md = corpus.fresh.filter(f => f.adjudication.model_dependent).length;
  const terminals = corpus.fresh.reduce((m, f) => ({ ...m, [f.expected.terminal]: (m[f.expected.terminal] || 0) + 1 }), {});
  const routes = corpus.fresh.reduce((m, f) => ({ ...m, [f.expected.route]: (m[f.expected.route] || 0) + 1 }), {});
  const line = `fresh: ${corpus.fresh.length} cases, ${new Set(corpus.fresh.map(f => f.adjudication.source_family)).size} families, ${md} model-dependent by the fixture flag; `
    + `RESOLVED ${terminals.RESOLVED}, NEEDS_EVIDENCE ${terminals.NEEDS_EVIDENCE}, NEEDS_REASONING ${terminals.NEEDS_REASONING}; ` + ROUTES.map(r => `${r} ${routes[r] || 0}`).join(', ');
  const doc = readFileSync(resolve(ROOT, 'docs/experiments/jev-capability-boundary-2026-09-18.md'), 'utf8');
  assert.ok(doc.includes(line), `record carries the line "${line}"`);
  assert.ok(doc.includes('Trust-the-strong-LLM principle — still in force'));
});
