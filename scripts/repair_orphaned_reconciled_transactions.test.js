// Unit tests for the pure helpers in
// scripts/repair_orphaned_reconciled_transactions.js. The DB-touching
// detection + apply paths run against the live DB in dry-run mode
// before any --apply.

import assert from 'node:assert/strict';
import {
  parseArgv,
  buildRepairAudit,
  buildDanglingMatchAudit,
  detectDanglingMatches,
  detectOrphans,
  payloadStripFragment,
  PAYLOAD_KEYS_STRIPPED
} from './repair_orphaned_reconciled_transactions.js';

// Minimal query-recording client for the detection helpers.
const makeMockClient = (rows = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows };
    }
  };
};

let passed = 0;
let failed = 0;

const test = (name, fn) =>
  Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  fail ${name}`);
      console.error(`       ${err?.stack || err?.message || err}`);
    });

const runTests = async () => {
  console.log('repair_orphaned_reconciled_transactions:');

  // ── parseArgv ──────────────────────────────────────────────────────

  await test('parseArgv: defaults to donna-demo-firm + dry-run + all clients', () => {
    assert.deepEqual(parseArgv([]), {
      apply: false,
      firmId: 'donna-demo-firm',
      clientId: null
    });
  });

  await test('parseArgv: --apply flips dry-run off', () => {
    assert.equal(parseArgv(['--apply']).apply, true);
  });

  await test('parseArgv: --firm overrides default firm', () => {
    assert.equal(parseArgv(['--firm', 'other-firm']).firmId, 'other-firm');
  });

  await test('parseArgv: --client narrows scope', () => {
    assert.equal(parseArgv(['--client', 'alex-morgan-personal']).clientId, 'alex-morgan-personal');
  });

  await test('parseArgv: all flags combined', () => {
    const out = parseArgv(['--firm', 'donna-demo-firm', '--client', 'honeybee-hills-apiary', '--apply']);
    assert.deepEqual(out, {
      apply: true,
      firmId: 'donna-demo-firm',
      clientId: 'honeybee-hills-apiary'
    });
  });

  // ── PAYLOAD_KEYS_STRIPPED matches the confirm path's writes ─────────

  await test('PAYLOAD_KEYS_STRIPPED: exactly the four keys firmDb confirm path writes', () => {
    // Symmetric inverse of the JSON.stringify({...}) object at
    // firmDb.js:2772-2776 (and the parallel block at :2894-2898).
    // If the confirm path ever adds / renames a key, this test should
    // fail so we know to update the strip list.
    assert.deepEqual([...PAYLOAD_KEYS_STRIPPED].sort(), [
      'reconciliation_match_id',
      'reconciliation_match_object_id',
      'reconciliation_match_type',
      'reconciliation_status'
    ]);
  });

  // ── payloadStripFragment ───────────────────────────────────────────

  await test('payloadStripFragment: emits one "- \'key\'" clause per stripped key', () => {
    const fragment = payloadStripFragment();
    for (const key of PAYLOAD_KEYS_STRIPPED) {
      assert.ok(
        fragment.includes(`- '${key}'`),
        `fragment must strip '${key}'`
      );
    }
  });

  // ── buildRepairAudit ───────────────────────────────────────────────

  await test('buildRepairAudit: captures the prior reconciliation state', () => {
    const row = {
      reconciliation_status: 'reconciled',
      reconciled_at: new Date('2026-05-24T10:37:46.953Z'),
      payload: {
        reconciliation_status: 'reconciled',
        reconciliation_match_id: 'match-abc',
        reconciliation_match_object_id: 'doc-xyz',
        support_status: 'rule_explained',
        auto_categorize_source: 'vendor_signal'
      }
    };
    const audit = buildRepairAudit(row);
    assert.equal(audit.source, 'orphaned_reconciled_transaction_repair_v1');
    assert.equal(audit.script, 'repair_orphaned_reconciled_transactions.js');
    assert.equal(audit.prior_state.reconciliation_status, 'reconciled');
    assert.equal(audit.prior_state.reconciled_at, '2026-05-24T10:37:46.953Z');
    assert.equal(audit.changed_by, 'system');
    // changed_at must be ISO-format-ish.
    assert.match(audit.changed_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  await test('buildRepairAudit: prior_state.payload_keys_stripped lists only keys actually present', () => {
    const row = {
      reconciliation_status: 'reconciled',
      reconciled_at: null,
      payload: {
        // Only 2 of the 4 confirm-path keys are present (the other
        // 2 came in via promote_matches.js which writes a leaner
        // payload). The audit must only record what was actually
        // present so the repair history is precise.
        reconciliation_status: 'reconciled',
        reconciliation_match_id: 'match-abc',
        support_status: 'rule_explained'
      }
    };
    const audit = buildRepairAudit(row);
    assert.deepEqual(
      [...audit.prior_state.payload_keys_stripped].sort(),
      ['reconciliation_match_id', 'reconciliation_status']
    );
  });

  await test('buildRepairAudit: handles missing payload + missing reconciled_at gracefully', () => {
    const audit = buildRepairAudit({
      reconciliation_status: 'auto_reconciled',
      reconciled_at: null,
      payload: null
    });
    assert.equal(audit.prior_state.reconciliation_status, 'auto_reconciled');
    assert.equal(audit.prior_state.reconciled_at, null);
    assert.deepEqual(audit.prior_state.payload_keys_stripped, []);
  });

  // ── orphan shape 3: dangling match rows (June 2026 Honeybee) ───────

  await test('buildDanglingMatchAudit: snapshots the match before deletion', () => {
    const audit = buildDanglingMatchAudit({
      id: 'recon-x',
      status: 'auto_matched',
      bank_transaction_id: 'tx-1',
      matched_object_type: 'supplier_bill',
      matched_object_id: 'doc-gone',
      match_amount: 12.38,
      match_confidence: 0.92
    });
    assert.equal(audit.prior_state.status, 'auto_matched');
    assert.equal(audit.prior_state.bank_transaction_id, 'tx-1');
    assert.equal(audit.prior_state.matched_object_id, 'doc-gone');
    assert.equal(audit.prior_state.match_amount, 12.38);
    assert.ok(audit.reason.includes('no longer exists'));
  });

  await test('detectDanglingMatches: selects match rows whose document is gone, scoped by firm + client', async () => {
    const client = makeMockClient([{ id: 'recon-x', status: 'auto_matched' }]);
    const rows = await detectDanglingMatches(client, {
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    assert.equal(rows.length, 1);
    const { sql, params } = client.calls[0];
    assert.ok(sql.includes('from reconciliation_matches'));
    assert.ok(/not exists\s*\(\s*select 1 from documents d where d\.id = rm\.matched_object_id/.test(sql),
      'detection keys on the document no longer existing');
    assert.deepEqual(params, ['firm-1', 'client-1']);
  });

  await test('detectDanglingMatches: client filter is optional', async () => {
    const client = makeMockClient([]);
    await detectDanglingMatches(client, { firmId: 'firm-1' });
    assert.deepEqual(client.calls[0].params, ['firm-1']);
    assert.ok(!client.calls[0].sql.includes('rm.client_id = $2'));
  });

  await test('detectOrphans: a confirmed/auto match row only shields its transaction when its document still exists', async () => {
    const client = makeMockClient([]);
    await detectOrphans(client, { firmId: 'firm-1', clientId: 'client-1' });
    const { sql, params } = client.calls[0];
    // The blind spot this closes: dangling auto_matched rows (deleted
    // doc) used to count as justification and hid the stuck
    // transaction from this script entirely.
    assert.ok(/status in \('confirmed', 'auto_matched'\)[\s\S]*exists\s*\(\s*select 1 from documents d where d\.id = rm\.matched_object_id/.test(sql),
      'shielding match rows must be anchored to a live document');
    assert.deepEqual(params, ['firm-1', 'client-1']);
  });
};

(async () => {
  await runTests();
  console.log(`\nTests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
