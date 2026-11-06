// Donna Inventory I4·posting — P7 §12 incident records, real-Postgres integration (design §19).
// The fake-pg tests prove query shape + lifecycle logic; this proves the writer against the real
// schema — the 084 natural-key partial-unique dedupe under ON CONFLICT, the resolved-frees-the-key
// recurrence, the status CHECK + resolved-carries-actor CHECK, and the end-to-end drain-and-record
// over real waiter heads. SKIPS unless DATABASE_URL is set, and skips if 084 isn't migrated. Runs
// in ONE rolled-back transaction — no trace left.
//   DATABASE_URL=postgres://… node --test server/donna/inventory/postingIncidentDbIntegration.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordInventoryWaiterDrainIncidents,
  recordInventoryPostingIncidents,
  acknowledgeInventoryPostingIncident,
  resolveInventoryPostingIncident,
  listOpenInventoryPostingIncidents
} from './postingIncidentDb.js';

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const opts = { skip: HAVE_DB ? false : 'DATABASE_URL not set — real-Postgres suite skipped' };

const withRolledBackFixture = async (fn) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const firmId = 'itest-firm-inv-incident';
  const clientId = 'itest-client-inv-incident';
  try {
    await client.query('begin');
    if (!(await client.query("select to_regclass('public.inventory_posting_incidents') as t")).rows[0]?.t) { await client.query('rollback'); return { skipped: '084 not migrated' }; }
    await client.query(`insert into firms (id, name, slug) values ($1, 'ITest Firm', $2) on conflict (id) do nothing`, [firmId, `itest-inv-incident-${firmId}`]);
    await client.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'ITest Client') on conflict (id) do nothing`, [clientId, firmId]);
    const result = await fn({ client, firmId, clientId });
    return { result };
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
};

const insertAttempt = (client, { firmId, clientId, operationId, postingKind, outcome, waiterType = null, reasonCode = null, nextAction = null }) =>
  client.query(
    `insert into inventory_posting_attempts
       (firm_id, client_id, operation_id, posting_kind, posting_basis_version, valuation_run_id, outcome, waiter_type, reason_code, next_action, actor_id)
     values ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,'itest') returning id`,
    [firmId, clientId, operationId, postingKind, `vrun-${operationId}`, outcome, waiterType, reasonCode, nextAction]
  );

test('P7 §12: drain-and-record opens durable incidents, dedupes on re-drain, recurs after resolve (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    // op1: an engineering-incident waiter → open_incident. op2: a human-owned waiter → nothing.
    const a1 = await insertAttempt(client, { firmId, clientId, operationId: 'op1', postingKind: 'write_down', outcome: 'refused', waiterType: 'engineering_incident', reasonCode: 'conservation_residual', nextAction: 'investigate_residual' });
    await insertAttempt(client, { firmId, clientId, operationId: 'op2', postingKind: 'shipment_cogs', outcome: 'refused', waiterType: 'owner' });

    const first = await recordInventoryWaiterDrainIncidents({ client, firmId, clientId, actorId: 'itest-drain', now: new Date('2026-07-12T00:00:00Z') });
    // Re-drain: the head is still open, the incident already recorded — dedupe, no dup row.
    const second = await recordInventoryWaiterDrainIncidents({ client, firmId, clientId, actorId: 'itest-drain', now: new Date('2026-07-12T01:00:00Z') });

    const incident = first.opened[0];
    // Lifecycle on the real CHECKs: acknowledge, then resolve (with actor + timestamp).
    const acked = await acknowledgeInventoryPostingIncident({ client, firmId, clientId, incidentId: incident.id, actorId: 'itest-op' });
    const resolved = await resolveInventoryPostingIncident({ client, firmId, clientId, incidentId: incident.id, actorId: 'itest-op', note: 'residual explained' });
    const openAfterResolve = await listOpenInventoryPostingIncidents(client, firmId, clientId);
    // The natural key is freed — a recurrence opens a NEW incident row.
    const third = await recordInventoryWaiterDrainIncidents({ client, firmId, clientId, actorId: 'itest-drain', now: new Date('2026-07-12T02:00:00Z') });

    return {
      firstOpened: first.opened.length, firstIgnored: first.ignored,
      sourceAttemptId: Number(incident.source_attempt_id), headAttemptId: Number(a1.rows[0].id),
      targetQueue: incident.target_queue,
      secondOpened: second.opened.length, secondDeduped: second.deduped,
      ackedStatus: acked?.status, resolvedStatus: resolved?.status, resolvedBy: resolved?.resolved_by_actor_id,
      openAfterResolve: openAfterResolve.length,
      thirdOpened: third.opened.length, thirdNewId: third.opened[0]?.id !== incident.id
    };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.firstOpened, 1, 'the engineering incident is recorded');
  assert.equal(result.firstIgnored, 1, 'the human-owned waiter opens nothing');
  assert.equal(result.sourceAttemptId, result.headAttemptId, 'incident traces to the head attempt');
  assert.equal(result.targetQueue, 'engineering');
  assert.equal(result.secondOpened, 0, 're-drain opens nothing new');
  assert.equal(result.secondDeduped, 1, 're-drain dedupes against the natural key');
  assert.equal(result.ackedStatus, 'acknowledged');
  assert.equal(result.resolvedStatus, 'resolved');
  assert.equal(result.resolvedBy, 'itest-op');
  assert.equal(result.openAfterResolve, 0, 'resolved leaves the open queue');
  assert.equal(result.thirdOpened, 1, 'a recurrence after resolve opens a NEW incident');
  assert.ok(result.thirdNewId);
});

test('P7 §12: an exhausted integration retry escalates into a retry_exhausted incident (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    // Six retry attempts (> the 5-step default backoff) → the planner escalates.
    for (let i = 0; i < 6; i += 1) {
      await insertAttempt(client, { firmId, clientId, operationId: 'op-fx', postingKind: 'grni_retranslation', outcome: 'refused', waiterType: 'integration_system_retry', reasonCode: 'missing_close_fx_rate', nextAction: 'await_fx_fact' });
    }
    const res = await recordInventoryWaiterDrainIncidents({ client, firmId, clientId, actorId: 'itest-drain', now: new Date('2026-07-12T00:00:00Z') });
    const incident = res.opened[0];
    return {
      opened: res.opened.length,
      kind: incident?.incident_kind, queue: incident?.target_queue,
      retriesUsed: incident?.retries_used, retriesMax: incident?.retries_max,
      reason: incident?.reason_code, condition: incident?.condition
    };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.opened, 1);
  assert.equal(result.kind, 'retry_exhausted');
  assert.equal(result.queue, 'integration_operator');
  assert.equal(result.retriesUsed, 6);
  assert.equal(result.retriesMax, 5);
  assert.equal(result.reason, 'missing_close_fx_rate');
  assert.equal(result.condition, 'await_fx_fact');
});
