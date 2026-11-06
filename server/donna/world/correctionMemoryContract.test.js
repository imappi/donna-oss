import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateCorrectionMemoryContract } from './correctionMemoryContract.js';

const fixtureUrl = new URL('../../../data/worlds/slice2-correction-memory.json', import.meta.url);
const load = async () => JSON.parse(await readFile(fixtureUrl, 'utf8'));

test('equivalent sibling inherits the production-persisted correction with both deltas receipted', async () => {
  const result = evaluateCorrectionMemoryContract(await load());
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.receipts.askDelta, {
    kind: 'ask_count_delta', case1Count: 1, case2Count: 0, delta: -1,
    repeatedFactClasses: [], evaluatorVersion: 'eaw.ask.v1', beforePassed: true, afterPassed: true,
  });
  assert.deepEqual(result.receipts.treatmentDelta, {
    kind: 'treatment_delta', initial: 'travel_expense', corrected: 'director_loan_account',
    case2: 'director_loan_account', equivalent: true, changed: true, inherited: true,
  });
  assert.equal(result.receipts.memory.store, 'firm_facts');
});

test('a repeated ask disguised by a new ask id is refused by fact_class', async () => {
  const input = await load();
  input.askEvaluation.world.hiddenFacts.push({ kind: 'business_purpose', askEvaluation: {} });
  const base = { version: 'eaw.ask.v1', case_id: 'case/director-charge-1', fact_class: 'business_purpose', affected_obligations: ['obligation/director-charge'], remaining_hypotheses: ['business', 'personal'], evidence_already_checked: [], expected_answer_type: 'enum', reliability_required: 'owner', next_state_if_answered: 'resumed', deferrable_until: null, bundle_id: null };
  input.case1.asks = [{ record: { ...base, ask_id: 'ask/original' }, asked_at: '2026-08-01' }];
  input.case2.asks = [{ record: { ...base, ask_id: 'ask/disguised', case_id: 'case/director-charge-2' }, asked_at: '2026-09-01' }];
  const result = evaluateCorrectionMemoryContract(input);
  assert.equal(result.ok, false);
  assert(result.errors.includes('equivalent_case_repeated_fact_class'));
  assert.deepEqual(result.receipts.askDelta.repeatedFactClasses, ['business_purpose']);
});

test('non-equivalent case must not inherit the correction', async () => {
  const input = await load();
  input.case2.equivalenceKey = 'client-1/unrelated-merchant-purpose';
  input.case2.memoryApplied = true;
  const result = evaluateCorrectionMemoryContract(input);
  assert.equal(result.ok, false);
  assert(result.errors.includes('non_equivalent_case_inherited_correction'));

  input.case2.memoryApplied = false;
  input.case2.treatment = 'office_expense';
  const control = evaluateCorrectionMemoryContract(input);
  assert.equal(control.ok, true, control.errors.join('\n'));
  assert.equal(control.receipts.treatmentDelta.inherited, false);
});

test('correction that never persisted cannot change future behaviour', async () => {
  const input = await load();
  input.runnerReceipt.memory.persisted = false;
  const result = evaluateCorrectionMemoryContract(input);
  assert.equal(result.ok, false);
  assert(result.errors.includes('memory_not_persisted_by_production_correction_path'));
});

test('eval-minted memory is refused even when its row shape looks production-like', async () => {
  const input = await load();
  input.runnerReceipt.evalMintedMemory = true;
  const result = evaluateCorrectionMemoryContract(input);
  assert.equal(result.ok, false);
  assert(result.errors.includes('eval_minted_memory_refused'));
});

test('wrong store, writer, operation, or correction provenance fails closed', async () => {
  for (const [field, value] of [['store', 'eval_memory'], ['writer', 'eval_fixture'], ['operation', 'insert'], ['sourceCorrectionEventId', 'event/other']]) {
    const input = await load();
    input.runnerReceipt.memory[field] = value;
    const result = evaluateCorrectionMemoryContract(input);
    assert.equal(result.ok, false, field);
    assert(result.errors.includes('memory_not_persisted_by_production_correction_path'), field);
  }
});

test('treatment claims without an actual delta or memory application receipt are refused', async () => {
  const unchanged = await load();
  unchanged.case1.initialTreatment = unchanged.case1.correctedTreatment;
  assert(evaluateCorrectionMemoryContract(unchanged).errors.includes('case1_treatment_did_not_change'));

  const unattested = await load();
  unattested.case2.memoryApplied = false;
  assert(evaluateCorrectionMemoryContract(unattested).errors.includes('equivalent_case_missing_memory_application_receipt'));
});

test('input validation refuses missing runner-seam attestation without throwing', () => {
  const result = evaluateCorrectionMemoryContract({});
  assert.equal(result.ok, false);
  assert.equal(result.receipts, null);
});
