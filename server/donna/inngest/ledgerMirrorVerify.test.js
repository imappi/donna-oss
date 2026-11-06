// INT-4c — scheduled mirror-verify sweep tests. Load-bearing properties:
//   - per-client flag gate: only clients where LEDGER_SYNC_CASES observes get a
//     remote verify call (off/dry_run clients cost zero calls)
//   - the client's chosen accounting system picks the connector verify
//   - per-client failures are recorded and never break the batch
//   - the cron function is exported for serve.js registration (pinned there)
//
// CI-only: imports the Inngest function module, which requires the `inngest`
// package — same constraint as serve.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runLedgerMirrorVerifySweep, ledgerMirrorVerifyFunctions } from './ledgerMirrorVerify.js';

const quietLogger = { warn: () => {}, error: () => {} };

test('sweep verifies only flag-observing clients, via the chosen connector', async () => {
  const verifyCalls = [];
  const summary = await runLedgerMirrorVerifySweep({
    logger: quietLogger,
    deps: {
      listClients: async () => [
        { firm_id: 'f1', client_id: 'xero-on', accounting_system: 'xero' },
        { firm_id: 'f1', client_id: 'qbo-on', accounting_system: 'qbo' },
        { firm_id: 'f1', client_id: 'flag-off', accounting_system: 'xero' }
      ],
      observes: async ({ clientId }) => clientId !== 'flag-off',
      verifyXero: async ({ clientId }) => {
        verifyCalls.push(['xero', clientId]);
        return { xero_mirror_verification: { counts: { mirror_ok: 3, mirror_missing: 1, mirror_drift: 0, mirror_error: 0 } } };
      },
      verifyQbo: async ({ clientId }) => {
        verifyCalls.push(['qbo', clientId]);
        return { qbo_mirror_verification: { counts: { ok: 2, missing: 0, drift: 1, errors: 0 } } };
      }
    }
  });
  assert.deepEqual(verifyCalls, [['xero', 'xero-on'], ['qbo', 'qbo-on']]);
  assert.equal(summary.clients_scanned, 3);
  assert.equal(summary.clients_skipped_flag_off, 1);
  assert.equal(summary.clients_verified, 2);
  assert.equal(summary.mirror_ok, 5);
  assert.equal(summary.mirror_missing, 1);
  assert.equal(summary.mirror_drift, 1);
  assert.deepEqual(summary.errors, []);
});

test('a per-client verify failure is recorded and the batch continues', async () => {
  const summary = await runLedgerMirrorVerifySweep({
    logger: quietLogger,
    deps: {
      listClients: async () => [
        { firm_id: 'f1', client_id: 'dead-token', accounting_system: 'xero' },
        { firm_id: 'f1', client_id: 'healthy', accounting_system: 'xero' }
      ],
      observes: async () => true,
      verifyXero: async ({ clientId }) => {
        if (clientId === 'dead-token') {
          const err = new Error('Xero connection expired');
          err.code = 'XERO_CONNECTION_EXPIRED';
          throw err;
        }
        return { xero_mirror_verification: { counts: { mirror_ok: 1, mirror_missing: 0, mirror_drift: 0, mirror_error: 0 } } };
      },
      verifyQbo: async () => { throw new Error('should not be called'); }
    }
  });
  assert.equal(summary.clients_verified, 1);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].client_id, 'dead-token');
  assert.match(summary.errors[0].message, /expired/);
});

test('enumeration failure returns a summary with the error, never throws', async () => {
  const summary = await runLedgerMirrorVerifySweep({
    logger: quietLogger,
    deps: { listClients: async () => { throw new Error('no db'); } }
  });
  assert.equal(summary.clients_scanned, 0);
  assert.equal(summary.errors[0].stage, 'enumeration');
});

test('the cron function set exists for serve.js registration', () => {
  assert.ok(Array.isArray(ledgerMirrorVerifyFunctions));
  assert.ok(ledgerMirrorVerifyFunctions.length >= 1);
});
