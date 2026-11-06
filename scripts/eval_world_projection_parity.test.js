import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProjectionParity } from './eval_world_projection_parity.js';

const clean = () => ({
  dbRows: [
    { canonical_identity: 'review_item:auto', is_auto_reconciled: true, is_on_owner: false },
    { canonical_identity: 'client_evidence_request:ask', is_auto_reconciled: false, is_on_owner: true },
  ],
  convergenceRows: [
    { canonical_identity: 'review_item:auto', persisted: { reconciliationStatus: 'explained' } },
    { canonical_identity: 'client_evidence_request:ask', persisted: { hasOpenOwnerAsk: true } },
  ],
  ownerFeed: { buckets: {
    auto_cleared: [{ kind: 'review_item', source_id: 'auto', verdict: { disposition: 'auto_cleared' } }],
    client_info_needed: [{ kind: 'client_evidence_request', source_id: 'ask', verdict: { disposition: 'client_info_needed' } }],
  } },
});

test('builds one normalized inventory through all three production-backed surfaces', () => {
  const result = validateProjectionParity(clean());
  assert.equal(result.ok, true);
  assert.deepEqual(result.terminal_inventory, [
    { canonical_identity: 'client_evidence_request:ask', terminal_state: 'on_owner' },
    { canonical_identity: 'review_item:auto', terminal_state: 'auto_reconciled' },
  ]);
  assert.deepEqual(result.convergence, { auto_reconciled: 1, on_owner: 1, hanging: 0, total: 2, converged: true });
  assert.deepEqual(result.owner_counts, { for_you: 0, waiting: 1, donna: 0, done: 1 });
  assert.deepEqual(result.projection_receipt, {
    status: 'contract_proven',
    projector: 'reconcileConvergenceState',
    compared_surfaces: ['DB', 'convergence', 'owner'],
    historical_db_close_authority: 'legacy_unproven',
  });
});

for (const surface of ['DB', 'convergence', 'owner']) {
  for (const direction of ['auto_to_owner', 'owner_to_auto']) {
    test(`fails when ${surface} alone drifts ${direction}`, () => {
      const fixture = clean();
      const auto = direction === 'auto_to_owner';
      if (surface === 'DB') {
        const row = fixture.dbRows[auto ? 0 : 1];
        row.is_auto_reconciled = !auto;
        row.is_on_owner = auto;
      } else if (surface === 'convergence') {
        fixture.convergenceRows[auto ? 0 : 1].persisted = auto
          ? { hasOpenOwnerAsk: true }
          : { reconciliationStatus: 'explained' };
      } else {
        const from = auto ? 'auto_cleared' : 'client_info_needed';
        const to = auto ? 'client_info_needed' : 'auto_cleared';
        const item = fixture.ownerFeed.buckets[from].pop();
        item.verdict.disposition = to;
        fixture.ownerFeed.buckets[to].push(item);
      }
      assert.throws(() => validateProjectionParity(fixture), /projection parity: .* disagrees/);
    });
  }
}

for (const disposition of ['needs_human', 'chase_receipt']) {
  test(`refuses ${disposition} as settled even when the other surfaces claim clean`, () => {
    const fixture = clean();
    fixture.convergenceRows[0].persisted = { disposition };
    assert.throws(() => validateProjectionParity(fixture), /convergence=hanging/);
  });
}

test('does not accept caller terminal labels or ambiguous DB predicates', () => {
  const fixture = clean();
  fixture.dbRows[0] = { canonical_identity: 'review_item:auto', terminal_state: 'auto_reconciled' };
  assert.throws(() => validateProjectionParity(fixture), /DB predicates must be booleans/);
  fixture.dbRows[0] = { canonical_identity: 'review_item:auto', is_auto_reconciled: true, is_on_owner: true };
  assert.throws(() => validateProjectionParity(fixture), /both DB terminals/);
});
