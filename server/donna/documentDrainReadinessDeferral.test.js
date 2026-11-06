import assert from 'node:assert/strict';
import test from 'node:test';
import { documentDrainReadinessDeferral } from './inngest/documentTerminalDrain.js';
import { EntityReadinessAdmissionError } from './runtimeReadinessAdmission.js';

const decision = { enforced: true, allowed: false, boundary: 'worker_discovery',
  reason_code: 'host_readiness_not_ready', responsible_system: 'donna_runtime', retryable: true,
  saga_id: 'synthetic-saga', entity_receipt_ref: { store: 'audit_events', id: 1 },
  root_cause_receipt_ref: { store: 'audit_events', id: 2 },
  host_receipt_ref: { store: 'runtime_host_readiness_attempts', id: 3 } };
const classify = (error, workStarted = false) => documentDrainReadinessDeferral({
  error, workStarted, firmId: 'synthetic-firm', clientId: 'synthetic-client' });

test('only typed pre-work discovery admission defers, with its real cause and receipt references', () => {
  const error = new EntityReadinessAdmissionError(decision);
  const deferred = classify(error);
  assert.equal(deferred.reason_code, decision.reason_code);
  assert.equal(deferred.saga_id, decision.saga_id);
  for (const key of ['entity_receipt_ref', 'root_cause_receipt_ref', 'host_receipt_ref']) assert.deepEqual(deferred[key], decision[key]);
  assert.equal(classify(error, true), null, 'already-started work cannot become successful transport by hiding its failure');
  for (const boundary of ['ledger_write', 'action_authority', 'ask_send']) {
    assert.equal(classify(new EntityReadinessAdmissionError({ ...decision, boundary })), null);
  }
  for (const mutation of [{ allowed: true }, { enforced: false }, { boundary: null }]) {
    assert.equal(classify(new EntityReadinessAdmissionError({ ...decision, ...mutation })), null);
  }
  for (const code of ['ENTITY_READINESS_ADMISSION_BLOCKED', 'INTERNAL_PILOT_ACCESS_REQUIRED', 'ECONNRESET', 'PROVIDER_TIMEOUT']) {
    assert.equal(classify(Object.assign(new Error(error.message), { code, details: decision })), null, 'code or prose alone never marks a deferral');
  }
});
