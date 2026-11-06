// Donna Inventory I4·posting — P7 §12 waiter drain, real-Postgres integration (design §19). The
// fake-pg tests prove query shape + fail-closed logic; this proves the reader against the real
// schema — the inventory_posting_heads projection (latest attempt per operation/kind hides a
// resolved waiter) and the integration-retry GROUP BY. SKIPS unless DATABASE_URL is set, and skips
// if 080 isn't migrated. Runs in ONE rolled-back transaction — no trace left.
//   DATABASE_URL=postgres://… node --test server/donna/inventory/postingWaiterDbIntegration.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { planInventoryWaiterDrain, gatherWaiterState } from './postingWaiterDb.js';

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const opts = { skip: HAVE_DB ? false : 'DATABASE_URL not set — real-Postgres suite skipped' };

const withRolledBackFixture = async (fn) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const firmId = 'itest-firm-inv-waiter';
  const clientId = 'itest-client-inv-waiter';
  try {
    await client.query('begin');
    if (!(await client.query("select to_regclass('public.inventory_posting_attempts') as t")).rows[0]?.t) { await client.query('rollback'); return { skipped: '080 not migrated' }; }
    await client.query(`insert into firms (id, name, slug) values ($1, 'ITest Firm', $2) on conflict (id) do nothing`, [firmId, `itest-inv-waiter-${firmId}`]);
    await client.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'ITest Client') on conflict (id) do nothing`, [clientId, firmId]);
    const result = await fn({ client, firmId, clientId });
    return { result };
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
};

const insertAttempt = (client, { firmId, clientId, operationId, postingKind, basis = 1, outcome, waiterType = null, reasonCode = null, nextAction = null }) =>
  client.query(
    `insert into inventory_posting_attempts
       (firm_id, client_id, operation_id, posting_kind, posting_basis_version, valuation_run_id, outcome, waiter_type, reason_code, next_action, actor_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'itest') returning id, created_at`,
    [firmId, clientId, operationId, postingKind, basis, `vrun-${operationId}-${basis}`, outcome, waiterType, reasonCode, nextAction]
  );

test('P7 §12: the driver plans open waiter heads; a resolved (posted) head is excluded (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    // op1: an integration_system_retry waiter (open) — two refusals → retry_count 2.
    await insertAttempt(client, { firmId, clientId, operationId: 'op1', postingKind: 'receipt', outcome: 'refused', waiterType: 'integration_system_retry', reasonCode: 'missing_close_fx_rate', nextAction: 'await_fx_fact' });
    await insertAttempt(client, { firmId, clientId, operationId: 'op1', postingKind: 'receipt', outcome: 'refused', waiterType: 'integration_system_retry', reasonCode: 'missing_close_fx_rate', nextAction: 'await_fx_fact' });
    // op2: an engineering incident waiter (open).
    await insertAttempt(client, { firmId, clientId, operationId: 'op2', postingKind: 'write_down', outcome: 'refused', waiterType: 'engineering_incident', reasonCode: 'conservation_residual' });
    // op3: was refused, then POSTED — the head is 'posted', so it is NOT drainable (resolved).
    await insertAttempt(client, { firmId, clientId, operationId: 'op3', postingKind: 'shipment_cogs', outcome: 'refused', waiterType: 'accountant_operator' });
    await insertAttempt(client, { firmId, clientId, operationId: 'op3', postingKind: 'shipment_cogs', outcome: 'posted' });

    const state = await gatherWaiterState({ client, firmId, clientId });
    const plan = await planInventoryWaiterDrain({ client, firmId, clientId, now: new Date('2027-01-01T00:00:00Z') });
    return {
      opsPlanned: state.map((s) => s.attempt.operation_id).sort(),
      op1Retry: state.find((s) => s.attempt.operation_id === 'op1')?.retryCount,
      summary: plan.summary, total: plan.total,
      op2Disposition: plan.plans.find((p) => p.operation_id === 'op2')?.disposition
    };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  // op3 (posted head) excluded; op1 + op2 remain.
  assert.deepEqual(result.opsPlanned, ['op1', 'op2']);
  assert.equal(result.op1Retry, 2, 'two integration-retry attempts counted for op1');
  assert.equal(result.total, 2);
  assert.equal(result.op2Disposition, 'open_incident');
  // A far-future clock makes op1's retry due (or escalated once exhausted) — never a silent stall.
  assert.ok(result.summary.retry + result.summary.escalate >= 1, 'op1 is retried or escalated, not stuck');
});
