import assert from 'node:assert/strict';
import test from 'node:test';
import { codingPolicyFailureDisposition, codingPolicyFailuresForTransaction, recordCodingPolicyFailure, CODING_POLICY_FAILED_ACTION, CODING_POLICY_RECOVERED_ACTION } from './codingPolicyRecovery.js';
import { buildCaseHealth } from './caseHealth.js';
import { runCodingConvergence } from './codingConvergence.js';

const transaction = { id: 'tx-policy', firm_id: 'firm', client_id: 'client' };
const failure = (metadata = {}) => ({
  id: '9007199254740993', action: CODING_POLICY_FAILED_ACTION,
  resource_type: 'transaction', resource_id: transaction.id,
  firm_id: 'firm', client_id: 'client',
  metadata: { operation: 'coding', reason_code: 'coding_policy_unavailable', retry_safe: true, recovery_route: 'coding_convergence', recovery_path: 'coding_convergence', failure_kind: 'system_failure', attempts: 1, ...metadata }
});

test('only persisted identity conflicts ask the owner; stale decisions require recoding', () => {
  for (const reason of ['profile_jurisdiction_conflict', 'entity_jurisdiction_conflict', 'profile_entity_conflict']) {
    const disposition = codingPolicyFailureDisposition({ code: 'jurisdiction_context_conflict', details: { reason } });
    assert.equal(disposition.ownerFact, true, reason);
    assert.equal(disposition.recode, false);
  }
  for (const reason of ['coding_policy_receipt_conflict', 'stamped_policy_context_conflict']) {
    const disposition = codingPolicyFailureDisposition({ code: 'jurisdiction_context_conflict', details: { reason } });
    assert.equal(disposition.ownerFact, false, reason);
    assert.equal(disposition.recode, true);
    assert.equal(disposition.retrySafe, true);
  }
  assert.equal(codingPolicyFailureDisposition({ code: 'coding_policy_invalid', details: { reason: 'tax_code_not_in_policy' } }).recode, true);
  assert.equal(codingPolicyFailureDisposition({ code: 'jurisdiction_context_conflict' }).ownerFact, false, 'unknown subtype must not fabricate a business fact');
});

test('policy failure projects existing retrying/incident surfaces and exact recovery removes it', () => {
  const event = failure();
  const retrying = buildCaseHealth({ transaction, auditEvents: [event] });
  assert.equal(retrying.phase, 'processing');
  assert.equal(retrying.recovery.class, 'retrying');
  assert.equal(retrying.blocker.kind, 'integration_failure');
  assert.equal(retrying.convergence.state, 'hanging');
  const exhausted = buildCaseHealth({ transaction, auditEvents: [failure({ attempts: 3, escalation_required: true, recovery_route: 'runtime_policy_incident' })] });
  assert.equal(exhausted.phase, 'stuck');
  assert.equal(exhausted.recovery.class, null);
  assert.equal(exhausted.blocker.detail.escalation_required, true);

  const recovered = { ...event, id: '9007199254740994', action: CODING_POLICY_RECOVERED_ACTION };
  assert.deepEqual(codingPolicyFailuresForTransaction({ transaction, auditEvents: [recovered, event] }), []);
  assert.equal(codingPolicyFailuresForTransaction({ transaction, auditEvents: [event, { ...recovered, resource_id: 'other' }] }).length, 1);
  assert.equal(codingPolicyFailuresForTransaction({ transaction, auditEvents: [event, { ...recovered, client_id: 'other' }] }).length, 1);
  assert.equal(codingPolicyFailuresForTransaction({ transaction, auditEvents: [event, { ...recovered, metadata: { operation: 'other' } }] }).length, 1);
  assert.deepEqual(codingPolicyFailuresForTransaction({ transaction: { ...transaction, coding_state: 'posted' }, auditEvents: [event] }), []);
});

test('missing jurisdiction projects the persisted setup question without fabricating a terminal ask', () => {
  const health = buildCaseHealth({ transaction, auditEvents: [failure({
    reason_code: 'jurisdiction_unresolved', failure_kind: 'missing_owner_fact',
    retry_safe: false, recovery_route: 'client_profile',
    owner_question: 'Which country is this business registered in?',
    unlock_condition: 'Confirm jurisdiction in business setup.'
  })] });
  assert.equal(health.phase, 'needs_owner');
  assert.equal(health.recovery.class, 'owner_action_required');
  assert.equal(health.blocker.detail.owner_question, 'Which country is this business registered in?');
  assert.equal(health.blocker.detail.recovery_route, 'client_profile');
  assert.equal(health.convergence.state, 'hanging');
  assert.equal(health.owner_question, null, 'no evidence request was fabricated');
});

test('the existing clock retains typed failures, skips ask drafting, and continues other clients', async () => {
  const asked = [];
  const result = await runCodingConvergence({
    firmId: 'firm',
    discoverCoderClientsFn: async () => [{ client_id: 'failed' }, { client_id: 'healthy' }],
    batchSuggestFn: async ({ clientIds: [client_id] }) => ({ transaction_ai_batch: { summaries: [{
      client_id, suggested: client_id === 'healthy' ? 1 : 0,
      ...(client_id === 'failed' ? { policy_failure: true, error: 'jurisdiction_unresolved', policy_error: { code: 'jurisdiction_unresolved', receipt_ids: ['91'] } } : {})
    }] } }),
    releaseWaitingFn: async () => [], recoverAskDraftFn: async () => [],
    discoverSweepClientsFn: async () => [], discoverLedgerPostClientsFn: async () => [],
    requestAskDraftFn: async ({ clientId }) => { asked.push(clientId); return { enqueued: 0 }; }
  });
  assert.equal(result.errors, 1);
  assert.equal(result.coder[0].policy_error.code, 'jurisdiction_unresolved');
  assert.deepEqual(result.coder[0].policy_error.receipt_ids, ['91']);
  assert.equal(result.coder[1].suggested, 1);
  assert.deepEqual(asked, ['healthy']);
});


test('conflicting legal forms ask the owner to repair the existing legal-form card', () => {
  const disposition = codingPolicyFailureDisposition({ code: 'jurisdiction_context_conflict', details: { reason: 'profile_entity_conflict' } });
  assert.equal(disposition.ownerFact, true);
  assert.match(disposition.ownerQuestion, /legal form/);
  assert.match(disposition.unlockCondition, /About your business/);
});

for (const code of [
  'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED',
  'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED',
  'TRANSACTION_AE_VAT_CODING_CONFLICT',
  'TRANSACTION_AE_VAT_DIRECTION_MISMATCH',
  'TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED'
]) {
  test(`${code} immediately persists an accountable posting incident without inventing an owner fact`, async () => {
    const error = { code, jurisdiction: 'ae', details: { reason: 'authoritative_treatment' } };
    const disposition = codingPolicyFailureDisposition(error);
    assert.equal(disposition.ownerFact, false);
    assert.equal(disposition.ownerQuestion, null);
    assert.equal(disposition.recode, false, 'a blind recode must not hide a capability failure or infer a fact');
    assert.equal(disposition.retrySafe, false);
    if (code === 'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED') {
      assert.match(disposition.unlockCondition, /Implement supported native UAE VAT posting/);
      assert.match(disposition.unlockCondition, /unchanged authoritative coding/);
      assert.doesNotMatch(disposition.unlockCondition, /owner-ask/);
    } else if (code === 'TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED') {
      assert.match(disposition.unlockCondition, /authoritative supported UAE connector tax mapping/);
      assert.match(disposition.unlockCondition, /unchanged source treatment/);
      assert.doesNotMatch(disposition.unlockCondition, /owner-ask/);
    } else {
      assert.match(disposition.unlockCondition, /authoritative UAE VAT coding/);
      assert.match(disposition.unlockCondition, /held evidence/);
      assert.match(disposition.unlockCondition, /If an actual business fact is missing/);
      assert.match(disposition.unlockCondition, /do not ask the owner to choose a tax treatment/);
    }
    const client = { query: async (sql, values) => {
      if (/select id from transactions/.test(sql)) return { rows: [{ id: transaction.id }] };
      if (/select id, action, metadata from audit_events/.test(sql)) return { rows: [] };
      if (/insert into audit_events/.test(sql)) return { rows: [{
        ...failure(), id: '91', action: values[2], resource_id: values[3], metadata: JSON.parse(values[4])
      }] };
      if (/^(savepoint runtime_policy_incident|release savepoint runtime_policy_incident|select pg_advisory_xact_lock)/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const [receipt] = await recordCodingPolicyFailure({ client, firmId: 'firm', clientId: 'client',
      transactionIds: [transaction.id], operation: 'posting', error });
    assert.equal(receipt.metadata.failure_kind, 'system_failure', 'preserve the existing incident consumer contract');
    assert.equal(receipt.metadata.operation, 'posting');
    assert.equal(receipt.metadata.reason_code, code);
    assert.equal(receipt.metadata.attempts, 1);
    assert.equal(receipt.metadata.escalation_required, true);
    assert.equal(receipt.metadata.retry_safe, false);
    assert.equal(receipt.metadata.recovery_route, 'runtime_policy_incident');
    assert.equal(receipt.metadata.recovery_path, 'runtime_policy_incident');
    assert.equal(Object.hasOwn(receipt.metadata, 'owner_question'), false);
    assert.equal(receipt.metadata.unlock_condition, disposition.unlockCondition);

    const applied = { ...transaction, coding_state: 'applied', payload: { ledger_post_refusal: { code } } };
    const health = buildCaseHealth({ transaction: applied, auditEvents: [receipt] });
    assert.equal(health.phase, 'stuck');
    assert.equal(health.blocker.detail.failure, code);
    assert.equal(health.blocker.detail.escalation_required, true);
    assert.equal(health.blocker.detail.unlock_condition, disposition.unlockCondition);
    assert.equal(health.owner_question, null, 'an incident is not a terminal owner ask');
    assert.equal(health.convergence.state, 'hanging', 'never certify refused posting as completed');
    const recovered = { ...receipt, id: '92', action: CODING_POLICY_RECOVERED_ACTION };
    assert.deepEqual(codingPolicyFailuresForTransaction({ transaction: applied, auditEvents: [receipt, recovered] }), []);
  });
}
