// Donna Inventory I4·posting — P7 §12 incident records: the PURE builder + lifecycle (D-POST-14).
//   node --test server/donna/inventory/postingIncidents.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INVENTORY_INCIDENT_KINDS,
  INVENTORY_INCIDENT_STATUSES,
  INCIDENT_OPENING_DISPOSITIONS,
  canTransitionIncidentStatus,
  buildIncidentRecordFromPlan,
  buildIncidentRecordsFromPlans
} from './postingIncidents.js';
import { planWaiterDisposition, planWaiterDrainBatch, ENGINEERING_INCIDENT_QUEUE, RETRY_EXHAUSTION_QUEUE, DEFAULT_RETRY_BACKOFF_MS } from './postingWaiters.js';

const T0 = '2026-07-12T00:00:00.000Z';

test('vocabularies are the closed 084 sets', () => {
  assert.deepEqual([...INVENTORY_INCIDENT_KINDS], ['engineering_incident', 'retry_exhausted']);
  assert.deepEqual([...INVENTORY_INCIDENT_STATUSES], ['open', 'acknowledged', 'resolved']);
  assert.deepEqual([...INCIDENT_OPENING_DISPOSITIONS], ['open_incident', 'escalate']);
});

test('an open_incident plan maps to an engineering_incident record with the owning path', () => {
  const plan = planWaiterDisposition({
    attempt: { attempt_id: 41, operation_id: 'op1', posting_kind: 'write_down', waiter_type: 'engineering_incident', reason_code: 'conservation_residual', next_action: 'investigate_residual' }
  });
  assert.equal(plan.disposition, 'open_incident');
  const record = buildIncidentRecordFromPlan(plan);
  assert.deepEqual(record, {
    operation_id: 'op1',
    posting_kind: 'write_down',
    incident_kind: 'engineering_incident',
    reason_code: 'conservation_residual',
    condition: 'investigate_residual',
    waiter_type: 'engineering_incident',
    target_queue: ENGINEERING_INCIDENT_QUEUE,
    retries_used: null,
    retries_max: null,
    source_attempt_id: 41
  });
});

test('an escalate plan (exhausted retry) maps to a retry_exhausted record with the retry telemetry', () => {
  const plan = planWaiterDisposition({
    attempt: { attempt_id: 7, operation_id: 'op2', posting_kind: 'receipt', waiter_type: 'integration_system_retry', reason_code: 'missing_close_fx_rate', next_action: 'await_fx_fact', created_at: T0 },
    retryCount: DEFAULT_RETRY_BACKOFF_MS.length,
    now: T0
  });
  assert.equal(plan.disposition, 'escalate');
  const record = buildIncidentRecordFromPlan(plan);
  assert.equal(record.incident_kind, 'retry_exhausted');
  assert.equal(record.target_queue, RETRY_EXHAUSTION_QUEUE);
  assert.equal(record.retries_used, DEFAULT_RETRY_BACKOFF_MS.length);
  assert.equal(record.retries_max, DEFAULT_RETRY_BACKOFF_MS.length);
  assert.equal(record.reason_code, 'missing_close_fx_rate');
  assert.equal(record.source_attempt_id, 7);
});

test('retry / wait / human_owned plans open NOTHING (they rest elsewhere, correctly)', () => {
  for (const plan of [
    { disposition: 'retry', operation_id: 'op1', posting_kind: 'receipt', target_queue: null },
    { disposition: 'wait', operation_id: 'op1', posting_kind: 'receipt', target_queue: null },
    { disposition: 'human_owned', operation_id: 'op1', posting_kind: 'receipt', target_queue: 'owner' }
  ]) {
    assert.equal(buildIncidentRecordFromPlan(plan), null, plan.disposition);
  }
});

test('an incident-opening plan without identity or owner is a loud failure, never a guessed row', () => {
  assert.throws(() => buildIncidentRecordFromPlan({ disposition: 'open_incident', posting_kind: 'receipt', target_queue: 'engineering' }), /operation_id/);
  assert.throws(() => buildIncidentRecordFromPlan({ disposition: 'escalate', operation_id: 'op1', posting_kind: 'receipt', target_queue: null }), /target_queue/);
});

test('buildIncidentRecordsFromPlans maps a mixed drain batch, counting the non-opening plans', () => {
  const { plans } = planWaiterDrainBatch({
    waiters: [
      { attempt: { operation_id: 'op1', posting_kind: 'write_down', waiter_type: 'engineering_incident' } },
      { attempt: { operation_id: 'op2', posting_kind: 'receipt', waiter_type: 'integration_system_retry', created_at: T0 }, retryCount: DEFAULT_RETRY_BACKOFF_MS.length },
      { attempt: { operation_id: 'op3', posting_kind: 'receipt', waiter_type: 'integration_system_retry', created_at: T0 }, retryCount: 0 },
      { attempt: { operation_id: 'op4', posting_kind: 'shipment_cogs', waiter_type: 'owner' } }
    ],
    now: T0
  });
  const { records, ignored } = buildIncidentRecordsFromPlans(plans);
  assert.equal(records.length, 2);
  assert.equal(ignored, 2);
  assert.deepEqual(records.map((r) => r.incident_kind).sort(), ['engineering_incident', 'retry_exhausted']);
});

test('lifecycle edges: open → acknowledged → resolved, never backwards, resolved is terminal', () => {
  assert.equal(canTransitionIncidentStatus('open', 'acknowledged'), true);
  assert.equal(canTransitionIncidentStatus('open', 'resolved'), true);
  assert.equal(canTransitionIncidentStatus('acknowledged', 'resolved'), true);
  assert.equal(canTransitionIncidentStatus('acknowledged', 'open'), false);
  assert.equal(canTransitionIncidentStatus('resolved', 'open'), false);
  assert.equal(canTransitionIncidentStatus('resolved', 'acknowledged'), false);
  assert.equal(canTransitionIncidentStatus('nonsense', 'resolved'), false);
});
