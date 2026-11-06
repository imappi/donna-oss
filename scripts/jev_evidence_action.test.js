import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { prepareEvidencePacket, composeEvidenceAction, validateSemanticAnswers, discoveryContext, hash } from './jev_evidence_action_contract.js';
import { ROOT, loadContractCorpus, injectedAnswers, runContract } from './jev_evidence_action.js';

const databaseUrl = process.env.DONNA_PG_TEST_URL;
if (!databaseUrl) throw new Error('INCOMPLETE: DONNA_PG_TEST_URL required for real offline preparation');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
test.after(async () => { await client.end(); });
const corpus = loadContractCorpus();
const fixture = n => structuredClone(corpus.find(f => f.id === `contract-${String(n).padStart(3, '0')}`));
const prepare = f => prepareEvidencePacket(f.packet, client);
async function solve(f, editAnswers = a => a) {
  const p = await prepare(f);
  return { p, decision: composeEvidenceAction(p, p.error ? [] : editAnswers(injectedAnswers(p, f.semantic_statuses))) };
}
function addSource(p, id, content) {
  const s = { ...p.sources[0], id, kind: 'test_evidence', content };
  p.sources.push(s); p.retrieval.required_source_ids.push(id); p.retrieval.covered_source_ids.push(id);
  return id;
}
function removeRemittance(f) {
  f.packet.links = [];
  f.packet.sources = f.packet.sources.filter(s => s.kind !== 'remittance');
  f.packet.retrieval.required_source_ids = f.packet.sources.map(s => s.id);
  f.packet.retrieval.covered_source_ids = [...f.packet.retrieval.required_source_ids];
}
function withCustomerAllocationFact(f) {
  const p = f.packet;
  const sid = addSource(p, 'customer-allocation-source', 'The customer states that only they know which of the two indistinguishable transfers was intended for this invoice. That intention was not recorded in the local documents.');
  p.missing_fact = {
    work_item_id: p.work_item.id, fact: 'Which of these transfers was intended to pay this invoice.',
    question: 'Which transfer was intended to pay this invoice?', customer_id: 'fixture-customer',
    why_customer_only: 'Only the customer knows the unrecorded allocation intention.',
    why_local_cannot_supply: 'The complete declared inventory has no record of that intention.',
    basis_source_ids: [sid, ...p.transactions.map(t => t.source_id)], retrieval_scope_id: p.retrieval.scope_id
  };
  f.semantic_statuses.ask_fact = 'supported';
  return f;
}
function withSiblingExclusion() {
  const f = fixture(9), sibling = f.packet.transactions[0];
  const sid = addSource(f.packet, 'other-obligation-source', 'The first transfer exclusively pays a separate invoice OTHER-1; it does not pay this invoice.');
  f.packet.related_invoices.push({ id: 'other-invoice', source_id: sid, date: '2026-08-03', reference: 'OTHER-1' });
  f.packet.collision.invoice_ids.push('other-invoice');
  f.packet.links.push({ id: 'exclusive-other', kind: 'different_obligation', source_id: sid, transaction_id: sibling.id, invoice_id: 'other-invoice' });
  f.semantic_statuses[sibling.id].exclusion = 'supported';
  return f;
}
const ids = d => d.proposals.map(p => p.transaction_id).sort();

test('all 34 source-annotated development contracts traverse real PostgreSQL and the shared harness', async () => {
  const report = await runContract({ client });
  assert.equal(report.evaluation.totals.fixtures, 34);
  assert.equal(report.evaluation.totals.passed, 34);
  assert.equal(report.evaluation.totals.errored, 0);
  assert.equal(report.provider_calls, 0);
  assert.equal(report.capability_verdict, 'not_measured');
  assert.equal(report.independently_reviewed_labels, 0);
  assert.deepEqual(report.routes, { supported_proposal: 13, strong_reasoning: 10, not_admitted: 3, unresolved_research: 6, retrieve_local: 1, customer_question: 1 });
  for (const c of report.evaluation.cases) {
    for (const key of ['writer_authority', 'production_terminal', 'proposal_applied', 'question_delivered']) assert.equal(c.actual.decision[key], false);
    assert.ok(c.actual.decision.remaining_work.length > 0);
  }
  assert.equal((await client.query("select to_regclass('pg_temp.transactions') as rel")).rows[0].rel, null);
  assert.equal((await client.query("select to_regclass('pg_temp.reconciliation_matches') as rel")).rows[0].rel, null);
});

test('every development case records admission, evidence limitations, obligations and provisional review status', () => {
  assert.equal(corpus.length, 34);
  for (const f of corpus) {
    const a = f.adjudication;
    assert.equal(a.status, 'provisional'); assert.equal(a.reviewer, null);
    for (const key of ['work_item', 'limitations', 'acceptable_outcomes', 'prohibited_outcomes', 'positive_evidence', 'contradictions', 'label_reason', 'source_family']) assert.ok(a[key]);
    assert.ok(Object.hasOwn(a, 'missing_fact'));
    assert.equal(f.packet.version, 'jev-evidence-action-v1');
    if (a.legacy_fixture_sha256) {
      // The corpus can name historical inputs, but cannot rewrite them.
      assert.match(a.legacy_fixture_sha256, /^[a-f0-9]{64}$/);
    }
  }
});

test('labels, old expected decisions and fixture ids do not enter semantic question state', async () => {
  const f = fixture(12), before = await prepare(f);
  f.adjudication = { status: 'ORACLE', label_reason: 'SECRET-LABEL' };
  f.expected = { route: 'ORACLE' }; f.semantic_statuses = { SECRET: 'LABEL' }; f.id = 'ORACLE';
  const after = await prepare(f);
  assert.deepEqual(after, before);
  assert.doesNotMatch(JSON.stringify({ state: before.state, questions: before.questions }), /opaque-|contract-012|SECRET-LABEL|label_reason|expected/);
  for (const q of before.questions) {
    assert.equal(q.packet_sha256, before.packet_sha256);
    assert.ok(q.source_handles.length > 0); assert.ok(q.action_id);
  }
});

test('reference-free affirmative source can propose; same party, amount and date cannot', async () => {
  const positive = await solve(fixture(25));
  assert.equal(positive.decision.route, 'supported_proposal');
  const control = await solve(fixture(26), answers => answers.map(a => ({ ...a,
    status: a.question_id.endsWith('_obligation') ? 'supported' : a.status,
    citations: a.citations.length ? a.citations : positive.p.state.sources.slice(0, 1).map(s => ({ source_handle: s.handle, version: s.version })) })));
  assert.notEqual(control.decision.route, 'supported_proposal');
  const original = await solve(fixture(16));
  assert.equal(original.decision.route, 'strong_reasoning');
  assert.match(original.decision.dependencies[0].reason, /affirmative_payment/);
});

for (const n of [7, 18, 20, 24]) test(`legacy ${n}: rejected candidate does not invent customer work`, async () => {
  const { decision } = await solve(fixture(n));
  assert.equal(decision.route, 'unresolved_research');
  assert.equal(decision.reason, 'no_link_does_not_establish_customer_obligation');
  assert.equal(decision.question_specification, undefined);
});

test('customer fact binds admission, named customer, exact missing fact and retrieval scope without pretending delivery', async () => {
  const { decision } = await solve(fixture(32));
  assert.equal(decision.route, 'customer_question');
  assert.equal(decision.question_specification.customer_id, 'fixture-customer');
  assert.ok(decision.question_specification.why_local_cannot_supply);
  assert.equal(decision.question_delivered, false);
  const unbound = fixture(32); unbound.packet.missing_fact.work_item_id = 'other';
  assert.equal((await solve(unbound)).decision.reason, 'unbound_customer_fact');
  const unknown = await solve(fixture(32), answers => answers.map(a => a.question_id === 'ask_fact' ? { ...a, status: 'not_established', citations: [] } : a));
  assert.equal(unknown.decision.route, 'strong_reasoning');
});

test('supported customer-only allocation fact is reachable with two indistinguishable transfers', async () => {
  const f = withCustomerAllocationFact(fixture(2));
  const { decision } = await solve(f);
  assert.equal(decision.route, 'customer_question');
  assert.equal(decision.question_specification.fact, f.packet.missing_fact.fact);
  assert.equal(decision.question_specification.customer_id, 'fixture-customer');
  assert.equal(decision.question_delivered, false);
  assert.equal(decision.writer_authority, false);
  assert.equal(decision.proposals.length, 0);
  assert.equal(decision.remaining_work.length, 2);
  assert.ok(decision.consumed_answers.some(a => a.question_id === 'ask_fact'));
  assert.equal(decision.dependencies.length, 2);
  assert.ok(decision.dependencies.every(d => d.kind === 'customer_fact' && d.question_ids.includes('ask_fact')));
});

test('allocation fact must be supported and retrieved; interpretation and mechanical conflicts still escalate', async () => {
  for (const status of ['not_established', 'contradicted']) {
    const f = withCustomerAllocationFact(fixture(2));
    f.semantic_statuses.ask_fact = status;
    assert.equal((await solve(f)).decision.route, 'strong_reasoning');
  }
  const f = withCustomerAllocationFact(fixture(2));
  assert.equal((await solve(f, answers => answers.map(a => a.question_id === 'ask_fact' ? { ...a, confidence: 0.5 } : a))).decision.route, 'strong_reasoning');
  for (const status of ['truncated', 'failed', 'pending', 'not_performed']) {
    const incomplete = structuredClone(f); incomplete.packet.retrieval.status = status;
    assert.equal((await solve(incomplete)).decision.route, 'retrieve_local');
  }
  const conflict = withCustomerAllocationFact(fixture(29));
  assert.equal((await solve(conflict)).decision.dependencies[0].reason, 'conflicting_allocations');
  const amounts = withCustomerAllocationFact(fixture(12)); amounts.packet.links[0].fee_minor += 100;
  assert.equal((await solve(amounts)).decision.dependencies[0].reason, 'relationship_amount_conflict');
  const interpretation = withCustomerAllocationFact(fixture(25));
  interpretation.semantic_statuses[interpretation.packet.transactions[0].id].obligation = 'not_established';
  assert.equal((await solve(interpretation)).decision.dependencies[0].reason, 'semantic_relationship_not_established');
  assert.equal((await solve(withCustomerAllocationFact(fixture(25)))).decision.route, 'supported_proposal');
});

test('sibling exclusion requires its own payment-specific source, not the focal invoice citation', async () => {
  const f = withSiblingExclusion(), p = await prepare(f);
  const answers = injectedAnswers(p, f.semantic_statuses);
  const exclusion = answers.find(a => a.question_id === `link_${p.bank_handles[f.packet.transactions[0].id]}_exclusion`);
  exclusion.citations = [{ source_handle: p.source_handles['other-obligation-source'], version: '1' }];
  assert.equal(composeEvidenceAction(p, answers).route, 'supported_proposal');
  exclusion.citations = [{ source_handle: p.source_handles[f.packet.invoice.source_id], version: '1' }];
  assert.throws(() => validateSemanticAnswers(p, answers), /exclusion_source_not_cited/);
  const refused = composeEvidenceAction(p, answers);
  assert.equal(refused.route, 'unresolved_research');
  assert.equal(refused.reason, 'exclusion_source_not_cited');
  assert.equal(refused.proposals.length, 0);
});

test('exclusion cannot borrow another payment allocation citation or an unestablished judgment', async () => {
  const f = withSiblingExclusion();
  const sid = addSource(f.packet, 'unrelated-allocation-source', 'A different payment exclusively pays invoice OTHER-2.');
  f.packet.related_invoices.push({ id: 'other-invoice-2', source_id: sid, date: '2026-08-03', reference: 'OTHER-2' });
  f.packet.collision.invoice_ids.push('other-invoice-2');
  f.packet.links.push({ id: 'unrelated-allocation', kind: 'different_obligation', source_id: sid,
    transaction_id: f.packet.transactions[1].id, invoice_id: 'other-invoice-2' });
  const p = await prepare(f), answers = injectedAnswers(p, f.semantic_statuses);
  const exclusion = answers.find(a => a.question_id === `link_${p.bank_handles[f.packet.transactions[0].id]}_exclusion`);
  // Related-invoice sources are permitted question context, but still belong
  // to the wrong payment. Membership alone must not validate the exclusion.
  exclusion.citations = [{ source_handle: p.source_handles[sid], version: '1' }];
  assert.throws(() => validateSemanticAnswers(p, answers), /exclusion_source_not_cited/);
  for (const change of [{ status: 'not_established', citations: [] }, { confidence: 0.5 }]) {
    const unresolved = await solve(withSiblingExclusion(), a => a.map(answer => answer.question_id === exclusion.question_id ? { ...answer, ...change } : answer));
    assert.equal(unresolved.decision.route, 'strong_reasoning');
    assert.equal(unresolved.decision.proposals.length, 0);
  }
});

test('not-due admission never closes or hides an admitted bank item', async () => {
  const { decision } = await solve(fixture(31));
  assert.equal(decision.route, 'not_admitted');
  assert.equal(decision.remaining_work[0].disposition, 'not_completed_by_offline_contract');
  const f = fixture(31); f.packet.work_item.kind = 'explain_bank_transaction'; f.packet.work_item.target_id = f.packet.transactions[0].id;
  assert.equal((await solve(f)).decision.reason, 'invalid_not_due_admission');
  f.packet.work_item.admission = 'unknown';
  assert.equal((await solve(f)).decision.reason, 'work_admission_not_established');
});

test('processor representation is separate from direct counterparty and exact remittance arithmetic is retained', async () => {
  const { decision } = await solve(fixture(12));
  assert.equal(decision.route, 'supported_proposal');
  assert.ok(decision.consumed_answers.some(a => a.question_id.endsWith('_processor') && a.status === 'supported'));
  assert.ok(decision.consumed_answers.some(a => a.question_id.endsWith('_counterparty') && a.status === 'contradicted'));
  const f = fixture(12); f.packet.links[0].fee_minor += 100;
  assert.equal((await solve(f)).decision.dependencies[0].reason, 'relationship_amount_conflict');
});

test('removed, conflicting, duplicate and repeated-reference evidence cannot be laundered by ideal answers', async () => {
  assert.equal((await solve(fixture(27))).decision.proposals.length, 1);
  assert.equal((await solve(fixture(28))).decision.route, 'strong_reasoning');
  assert.equal((await solve(fixture(29))).decision.dependencies[0].reason, 'conflicting_allocations');
  assert.equal((await solve(fixture(30))).decision.dependencies[0].reason, 'repeated_reference_requires_specific_evidence');
  const f = fixture(12); f.packet.links.push({ ...f.packet.links[0], bank_amount_minor: 2 });
  assert.equal((await solve(f)).decision.reason, 'conflicting_link_identity');
  const removed = fixture(12); removeRemittance(removed);
  assert.notEqual((await solve(removed)).decision.route, 'supported_proposal');
});

test('full-group uncertainty survives an explicit selected remittance until sibling irrelevance is established', async () => {
  assert.equal((await solve(fixture(9))).decision.route, 'strong_reasoning');
  const f = withSiblingExclusion();
  const { decision } = await solve(f);
  assert.equal(decision.route, 'supported_proposal');
  assert.deepEqual(ids(decision), [f.packet.transactions[1].id]);
  assert.equal(decision.remaining_work.length, 2);
});

test('candidate reordering retains stable handles, exact targets and source-bound answers', async () => {
  const f = fixture(34), before = await solve(f);
  f.packet.transactions.reverse(); f.packet.sources.reverse(); f.packet.links.reverse(); f.packet.allocations.reverse();
  const after = await solve(f);
  assert.deepEqual(before.p.state, after.p.state);
  assert.deepEqual(ids(before.decision), ids(after.decision));
  assert.deepEqual(before.p.bank_handles, after.p.bank_handles);
});

test('irrelevant candidate addition is ignored only with affirmative exclusion; relevant addition blocks the group', async () => {
  const f = fixture(25), original = await solve(f);
  const t = { ...f.packet.transactions[0], id: 'other-bank', source_id: addSource(f.packet, 'other-bank-source', 'Another equal-sized outgoing payment.') };
  f.packet.transactions.push(t); f.packet.collision.transaction_ids.push(t.id);
  f.semantic_statuses[t.id] = { counterparty: 'supported', obligation: 'not_established' };
  assert.equal((await solve(f)).decision.route, 'strong_reasoning');
  const sid = addSource(f.packet, 'other-invoice-source', 'Explicit statement: the other bank payment exclusively settles the distinct invoice OTHER-2.');
  f.packet.related_invoices.push({ id: 'other-invoice', source_id: sid, date: '2026-08-04', reference: 'OTHER-2' });
  f.packet.collision.invoice_ids.push('other-invoice');
  f.packet.links.push({ id: 'exclude-other', kind: 'different_obligation', source_id: sid, transaction_id: t.id, invoice_id: 'other-invoice' });
  f.semantic_statuses[t.id].exclusion = 'supported';
  assert.deepEqual(ids((await solve(f)).decision), ids(original.decision));
});

for (const status of ['truncated', 'failed', 'pending', 'not_performed']) test(`${status} retrieval prevents proposal and customer question`, async () => {
  for (const n of [25, 32]) {
    const f = fixture(n); f.packet.retrieval.status = status;
    const { decision } = await solve(f);
    assert.equal(decision.route, 'retrieve_local');
    assert.equal(decision.dependencies[0].status, status);
    assert.equal(decision.production_terminal, false);
  }
});

test('bounded discovery and unexamined sources never prove completeness or absence', async () => {
  const f = fixture(25); f.packet.retrieval.method = 'bounded_discovery';
  assert.equal((await solve(f)).decision.route, 'retrieve_local');
  f.packet.retrieval.method = 'fixture_manifest'; f.packet.retrieval.required_source_ids.push('unretrieved-source');
  assert.equal((await solve(f)).decision.route, 'retrieve_local');
  const c = fixture(25); c.packet.collision.status = 'truncated';
  assert.equal((await solve(c)).decision.route, 'retrieve_local');
  c.packet.collision.transaction_ids = [];
  assert.equal((await solve(c)).decision.reason, 'incomplete_collision_membership');
  const context = discoveryContext();
  assert.equal(context.absence_proven, false); assert.equal(context.purpose, 'discovery_only');
  assert.equal(context.action, 'retrieve_local');
  assert.ok(context.limitations.includes('schema_errors_may_look_empty'));
});

test('actual production discovery helper retains eight of nine plausible candidates without asserting settlement', () => {
  const transaction = { id: 't', money_out: 100, currency: 'EUR', transaction_date: '2026-08-10', description: 'Alder repair' };
  const documents = Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, filename: `Alder-repair-${i}.pdf`, document_type: 'supplier_bill', parse_status: 'completed', vendor_name: 'Alder Repair', total_amount: 100, currency: 'EUR', document_date: '2026-08-10' }));
  const context = discoveryContext({ transactions: [transaction], documents });
  assert.equal(context.candidates.t.length, 8);
  assert.equal(context.absence_proven, false);
  assert.equal(context.retrieval_status, 'truncated');
});

test('stale and foreign source scope fail closed; foreign supplemental allocations do not settle local work', async () => {
  for (const [key, value, reason] of [['current_version', '2', 'stale_source_version'], ['firm_id', 'other', 'foreign_source_scope'], ['client_id', 'other', 'foreign_source_scope'], ['generation', 'old', 'foreign_source_scope']]) {
    const f = fixture(25); f.packet.sources[0][key] = value;
    assert.equal((await solve(f)).decision.reason, reason);
  }
  const { p, decision } = await solve(fixture(21));
  assert.equal(p.packet.excluded_allocations.length, 1);
  assert.equal(decision.route, 'supported_proposal');
});

test('prior settlements, duplicate receipts, partial coverage and human-posted exclusion use real SQL', async () => {
  for (const n of [4, 14]) assert.equal((await solve(fixture(n))).decision.reason, 'invoice_already_allocated');
  const f = fixture(15); f.packet.allocations.push(structuredClone(f.packet.allocations[0]));
  const { p, decision } = await solve(f);
  assert.equal(p.packet.allocations.length, 1); assert.equal(p.eligible_ids.length, 1);
  assert.equal(decision.proposals[0].amount_minor, 60000);
  assert.equal(decision.remaining_if_applied_minor, 0);
  assert.equal((await solve(fixture(17))).p.eligible_ids.length, 0);
  assert.equal((await solve(fixture(16))).p.eligible_ids.length, 1);
  const duplicate = fixture(15); duplicate.packet.allocations.push({ ...duplicate.packet.allocations[0], id: 'other-receipt' });
  assert.equal((await solve(duplicate)).decision.reason, 'duplicate_allocation_pair');
  const bank = fixture(14); bank.packet.work_item.kind = 'explain_bank_transaction'; bank.packet.work_item.target_id = bank.packet.transactions[0].id;
  assert.equal((await solve(bank)).decision.reason, 'admitted_bank_work_survives_invoice_settlement');
});

test('partial and split proposals preserve residual obligations; over-allocation is refused', async () => {
  const partial = (await solve(fixture(33))).decision;
  assert.equal(partial.proposals[0].amount_minor, 60000); assert.equal(partial.remaining_if_applied_minor, 40000);
  const group = fixture(34); group.packet.work_item.kind = 'allocate_collision_group'; group.packet.work_item.target_id = group.packet.collision.id;
  const all = (await solve(group)).decision;
  assert.equal(all.proposals.length, 2); assert.equal(all.remaining_if_applied_minor, 0);
  group.packet.invoice.amount_minor = 80000;
  assert.equal((await solve(group)).decision.reason, 'group_overallocation');
});

test('a prior allocation to another object type never settles this invoice even if ids collide', async () => {
  const f = fixture(14); f.packet.allocations[0].object_type = 'receipt';
  const { decision } = await solve(f);
  assert.notEqual(decision.reason, 'invoice_already_allocated');
  assert.notEqual(decision.route, 'not_admitted');
});

test('unknown and low-confidence evidence remain unknown, while irrelevant questions do not veto a supported path', async () => {
  const f = fixture(25), p = await prepare(f);
  assert.equal(composeEvidenceAction(p, injectedAnswers(p, {}, { unknown: true })).route, 'strong_reasoning');
  const answers = injectedAnswers(p, f.semantic_statuses);
  const obligation = answers.find(a => a.question_id.endsWith('_obligation')); obligation.confidence = 0.5;
  assert.equal(composeEvidenceAction(p, answers).route, 'strong_reasoning');
  // The reference-free receipt does not require a reference or processor verdict.
  assert.equal((await solve(f)).decision.route, 'supported_proposal');
});

test('missing, duplicate, malformed, foreign-action and stale-source answers are refused', async () => {
  const f = fixture(25), p = await prepare(f), good = injectedAnswers(p, f.semantic_statuses);
  const mutations = [
    a => a.slice(1), a => [...a.slice(1), a[1]], a => ({ answers: a }),
    a => { a[0].confidence = NaN; return a; }, a => { a[0].confidence = '1'; return a; },
    a => { a[0].status = 'yes'; return a; }, a => { a[0].action_id = 'another_action'; return a; },
    a => { a[0].question_sha256 = 'old'; return a; }, a => { a[0].packet_sha256 = 'old'; return a; },
    a => { a[0].citations = [{ source_handle: 'source_999', version: '1' }]; return a; },
    a => { a[0].citations[0].version = 'old'; return a; }, a => { a[0].citations = []; return a; },
    a => { a[0].citations.push(a[0].citations[0]); return a; }, a => { a[0].extra = 'hidden'; return a; }
  ];
  for (const mutate of mutations) {
    const bad = mutate(structuredClone(good));
    assert.throws(() => validateSemanticAnswers(p, bad));
    assert.equal(composeEvidenceAction(p, bad).route, 'unresolved_research');
  }
  const f2 = fixture(32), p2 = await prepare(f2), other = injectedAnswers(p2, f2.semantic_statuses);
  const ask = other.find(a => a.question_id === 'ask_fact');
  const unrelated = p2.state.sources.find(s => !p2.questions.find(q => q.id === 'ask_fact').source_handles.includes(s.handle));
  ask.citations = [{ source_handle: unrelated.handle, version: unrelated.version }];
  assert.equal(composeEvidenceAction(p2, other).reason, 'answer_citation_binding');
});

test('conflicting answers and after-preparation mutations cannot silently change a proposal', async () => {
  const f = fixture(25), p = await prepare(f);
  const answers = injectedAnswers(p, f.semantic_statuses);
  answers.find(a => a.question_id.endsWith('_exclusion')).status = 'supported';
  assert.equal(composeEvidenceAction(p, answers).reason, 'exclusion_source_not_cited');
  for (const mutate of [x => { x.packet.invoice.amount_minor++; }, x => { x.eligible_ids = []; }, x => { x.state.sources[0].content = 'changed'; }, x => { x.questions[0].instructions = 'changed'; }]) {
    const changed = structuredClone(p); mutate(changed);
    assert.equal(composeEvidenceAction(changed, injectedAnswers(p, f.semantic_statuses)).reason, 'prepared_packet_changed');
  }
});

test('positive obligation answers must cite payment-specific evidence, not just allowed invoice context', async () => {
  const f = fixture(25), p = await prepare(f), answers = injectedAnswers(p, f.semantic_statuses);
  const q = answers.find(a => a.question_id.endsWith('_obligation'));
  q.citations = [{ source_handle: p.source_handles[f.packet.invoice.source_id], version: '1' }];
  assert.equal(composeEvidenceAction(p, answers).reason, 'affirmative_source_not_cited');
});

test('packet bounds, malformed dates and evidence from after the snapshot are explicit research failures', async () => {
  const large = fixture(25); large.packet.sources[0].content = 'x'.repeat(250001);
  assert.equal((await solve(large)).decision.reason, 'packet_bound_exceeded');
  const malformed = fixture(25); malformed.packet.transactions[0].date = '2026-99-99';
  assert.equal((await solve(malformed)).decision.reason, 'unbound_record');
  malformed.packet.transactions[0].date = '2027-01-01';
  assert.equal((await solve(malformed)).decision.reason, 'future_evidence_record');
  const duplicate = fixture(25);
  duplicate.packet.related_invoices.push({ ...duplicate.packet.invoice });
  duplicate.packet.collision.invoice_ids.push(duplicate.packet.invoice.id);
  assert.equal((await solve(duplicate)).decision.reason, 'duplicate_invoice_identity');
});

test('a confidently wrong semantic reading can still pass: binding and mechanics are not a truth oracle', async () => {
  const f = fixture(25);
  const linkSource = f.packet.sources.find(s => s.id === f.packet.links[0].source_id);
  linkSource.content = 'The actual receipt explicitly says this payment was for a different obligation; the extracted relationship is wrong.';
  const { decision } = await solve(f);
  assert.equal(decision.route, 'supported_proposal', 'This is the declared residual semantic risk, not a safety claim.');
  assert.equal(decision.writer_authority, false);
});

test('CLI is offline, independent of cwd, output-protecting, and rejects live/provider modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-contract-'));
  try {
    const script = resolve(ROOT, 'scripts/jev_evidence_action.js'), output = join(dir, 'result.json');
    const env = { ...process.env, DONNA_PG_TEST_URL: databaseUrl, TYPESAFE_API_KEY: 'must-not-be-used', ANTHROPIC_API_KEY: 'must-not-be-used' };
    const run = args => spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(run([`--output=${output}`]).status, 0);
    const saved = readFileSync(output, 'utf8');
    assert.equal(JSON.parse(saved).provider_calls, 0);
    assert.equal(run([`--output=${output}`]).status, 2);
    assert.equal(readFileSync(output, 'utf8'), saved);
    assert.equal(run(['--mode=live']).status, 2);
    const missing = spawnSync(process.execPath, [script], { cwd: dir, env: { ...env, DONNA_PG_TEST_URL: '' }, encoding: 'utf8' });
    assert.equal(missing.status, 2); assert.match(missing.stderr, /local_disposable_postgres_required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
