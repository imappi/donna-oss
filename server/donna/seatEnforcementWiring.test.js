// Seat enforcement wiring — assertActionCapability's seat lane (build spec
// §2.3 born-enforced + §3.4 routing receipts), exercised through an injected
// fake dbClient so the whole converged gate runs without Postgres.
//
// The load-bearing wiring properties:
//   1. BORN ENFORCED: a seat principal's verdict never consults the
//      OPERATOR_CAPABILITY_ENFORCE stage — allowed applies return
//      enforced:true with zero config-plane reads, and shortfalls throw 403
//      even though no flag row exists anywhere.
//   2. ROUTING, NEVER HIDDEN: a shortfall throws with code
//      SEAT_AUTHORITY_ROUTED + a routing payload, and writes the
//      seat.approval_routed receipt with provenance.
//   3. AMOUNT FROM TARGETS: the materiality amount resolves from the
//      referenced transaction rows (largest absolute), and an unresolvable
//      amount routes fail-closed.
//   4. LEGACY UNCHANGED: a non-seat collaborator still rides the staged path
//      (no throw at stage off — the day-one dormant behavior, byte-identical).

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertActionCapability } from './firmDb.js';

// A pattern-matching fake pg client. Records every query; answers by shape.
const fakeDbClient = ({ assignmentRole = null, specialistRole = null, transactionAmounts = [], documentAmounts = [] } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/from client_assignments/i.test(text) && /assignment_kind = 'capability'/i.test(text)) {
        return { rows: assignmentRole ? [{ role: assignmentRole }] : [] };
      }
      if (/from client_assignments/i.test(text) && /assignment_kind = 'specialist_role'/i.test(text)) {
        return { rows: specialistRole ? [{ role: specialistRole }] : [] };
      }
      if (/from transactions/i.test(text)) {
        return { rows: transactionAmounts.map((amount) => ({ amount })) };
      }
      if (/from documents/i.test(text)) {
        return { rows: documentAmounts.map((total_amount) => ({ total_amount })) };
      }
      // config plane / cohort reads and anything else default to empty
      return { rows: [] };
    }
  };
};

const SEAT = { principalType: 'firm_collaborator', principalId: 'collab-seat-1', email: 'maya@example.com', unrestricted: false, seatRole: 'junior', affiliation: 'internal' };
const LEGACY = { principalType: 'firm_collaborator', principalId: 'collab-old-1', email: 'pod@example.com', unrestricted: false };

test('seat lane: an in-authority routine apply is allowed, enforced, with ZERO config-plane reads', async () => {
  const db = fakeDbClient({ assignmentRole: 'junior', transactionAmounts: [42.5] });
  const verdict = await assertActionCapability({
    firmId: 'firm-1', clientId: 'client-1', principal: SEAT,
    actionType: 'apply_category', action: { type: 'apply_category', transaction_ids: ['tx-1'] },
    dbClient: db
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.enforced, true, 'seat allows are enforced allows, not observed ones');
  assert.equal(verdict.seat_decision.outcome, 'allow');
  assert.ok(!db.queries.some((q) => /client_capability_config/i.test(q.sql)), 'no flag stage consulted for a seat');
});

test('seat lane: a class shortfall throws SEAT_AUTHORITY_ROUTED with routing + writes the receipt', async () => {
  const db = fakeDbClient({ assignmentRole: 'junior' });
  await assert.rejects(
    assertActionCapability({
      firmId: 'firm-1', clientId: 'client-1', principal: SEAT,
      actionType: 'reject_match', action: { type: 'reject_match', transaction_id: 'tx-1' },
      dbClient: db
    }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'SEAT_AUTHORITY_ROUTED');
      assert.equal(error.routing.route_to_role, 'senior');
      assert.equal(error.routing.reason, 'requires_reviewer_capability');
      assert.equal(error.routing.escalated_by, 'maya@example.com');
      return true;
    }
  );
  const receipt = db.queries.find((q) => /insert into audit_events/i.test(q.sql));
  assert.ok(receipt, 'seat.approval_routed receipt was written');
  assert.equal(receipt.params[2], 'maya@example.com'); // actor_id
  const metadata = JSON.parse(receipt.params[4]);
  assert.equal(metadata.route_to_role, 'senior');
  assert.equal(metadata.seat_role, 'junior');
  assert.equal(receipt.params[3], 'reject_match'); // resource_id = the verb
});

test('seat lane: the materiality amount resolves from the referenced rows (largest absolute)', async () => {
  // 620.40 > the junior bound (500.00) → routed to senior, with the receipt
  const db = fakeDbClient({ assignmentRole: 'junior', transactionAmounts: [-12.5, 620.4] });
  await assert.rejects(
    assertActionCapability({
      firmId: 'firm-1', clientId: 'client-1', principal: SEAT,
      actionType: 'apply_category', action: { type: 'apply_category', transaction_ids: ['tx-1', 'tx-2'] },
      dbClient: db
    }),
    (error) => {
      assert.equal(error.routing.reason, 'amount_exceeds_bound');
      assert.equal(error.routing.route_to_role, 'senior');
      assert.equal(error.routing.amount_minor, 62040);
      assert.equal(error.routing.bound_minor, 50000);
      return true;
    }
  );
  assert.ok(db.queries.some((q) => /from transactions/i.test(q.sql)), 'the amount was read from the rows');
});

test('seat lane: an unresolvable amount routes fail-closed, never through', async () => {
  const db = fakeDbClient({ assignmentRole: 'junior', transactionAmounts: [] });
  await assert.rejects(
    assertActionCapability({
      firmId: 'firm-1', clientId: 'client-1', principal: SEAT,
      actionType: 'apply_category', action: { type: 'apply_category', transaction_ids: ['tx-ghost'] },
      dbClient: db
    }),
    (error) => {
      assert.equal(error.routing.reason, 'amount_unresolved');
      assert.equal(error.routing.route_to_role, 'senior');
      return true;
    }
  );
});

test('legacy lane unchanged: a non-seat collaborator shortfall does NOT throw at stage off', async () => {
  const db = fakeDbClient({ assignmentRole: 'reviewer' });
  const verdict = await assertActionCapability({
    firmId: 'firm-1', clientId: 'client-1', principal: LEGACY,
    actionType: 'sync_to_accounting', action: { type: 'sync_to_accounting', transaction_ids: ['tx-1'] },
    dbClient: db
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.enforced, false, 'dormant flag: observe-only, exactly the day-one behavior');
  assert.ok(db.queries.some((q) => /client_capability_config/i.test(q.sql)), 'the legacy path DOES read the stage');
});

test('unrestricted principals bypass everything, including the seat lane', async () => {
  const db = fakeDbClient({});
  const verdict = await assertActionCapability({
    firmId: 'firm-1', clientId: 'client-1',
    principal: { principalType: 'firm_member', unrestricted: true, seatRole: 'junior' },
    actionType: 'sync_to_accounting', dbClient: db
  });
  assert.equal(verdict.allowed, true);
  assert.deepEqual(db.queries, [], 'no reads at all on the unrestricted fast path');
});

test('per-entity extension point: a seat-ladder assignment row outranks the seat row', async () => {
  // Seat row says partner, but THIS entity's assignment says junior → junior law binds here.
  const db = fakeDbClient({ assignmentRole: 'junior' });
  const partnerSeat = { ...SEAT, seatRole: 'partner' };
  await assert.rejects(
    assertActionCapability({
      firmId: 'firm-1', clientId: 'client-1', principal: partnerSeat,
      actionType: 'remember_fact', action: { type: 'remember_fact' },
      dbClient: db
    }),
    (error) => {
      assert.equal(error.code, 'SEAT_AUTHORITY_ROUTED');
      assert.equal(error.routing.route_to_role, 'partner');
      return true;
    }
  );
});
