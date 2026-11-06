// INT-6 — ledger auto-export drain executor tests. Load-bearing properties:
//   - the doctrine gate is LOAD-BEARING: the sweep routes every client through
//     the REAL decideExecution ('posted_journal_export', the GRANT_GATED carve);
//     no live grant → nothing exports at ANY flag stage;
//   - flag off → zero work; acts-but-no-case-surface (LEDGER_SYNC_CASES not
//     acting) → autonomy refused (the failure surface must exist first);
//   - shadow + grant → logs would-export, ZERO remote calls (no preflight, no
//     writeback, no verify);
//   - canary/auto + grant → drains via the adapter's writebackBatch with the
//     grant id as actorId, chains verifyMirror immediately, writes receipts;
//   - the optional ceiling excludes over-ceiling + unscoped journals (counted,
//     never silent) and only covered ids are handed to the writer;
//   - a named *_CONNECTION_EXPIRED pre-flight failure skips the client (INT-1's
//     surface) without exporting or minting anything;
//   - per-client failures are recorded and never break the batch.
//
// CI-only: imports the Inngest function module, which requires the `inngest`
// package — same constraint as serve.test.js / ledgerMirrorVerify.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runLedgerAutoExportSweep, ledgerAutoExportFunctions } from './ledgerAutoExport.js';

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

const GRANT = Object.freeze({
  id: 'sync-grant-honeybee-qbo-abc',
  accounting_system: 'qbo',
  action: 'export_posted_journal',
  status: 'active',
  correction_count: 0,
  amount_ceiling: null,
  currency: null
});

const flagsFor = (map) => async ({ clientId }) => map[clientId] || { stage: null, acts: false, observes: false, syncCasesAct: false };

const CANARY = { stage: 'canary', acts: true, observes: true, syncCasesAct: true };
const SHADOW = { stage: 'shadow', acts: false, observes: true, syncCasesAct: false };

const makeAdapter = (system, calls) => ({
  id: system,
  writebackBatch: async (args) => {
    calls.push(['writebackBatch', system, args]);
    const results = (args.transactionIds || []).map((id) => ({
      transaction_id: id, journal_id: `j-${id}`, status: 'synced'
    }));
    return system === 'qbo'
      ? { qbo_writeback_batch: { results } }
      : { xero_writeback_batch: { results } };
  },
  verifyMirror: async (args) => {
    calls.push(['verifyMirror', system, args]);
    return system === 'qbo'
      ? { qbo_mirror_verification: { counts: { ok: 2, drift: 0 } } }
      : { xero_mirror_verification: { counts: { ok: 2, drift: 0 } } };
  }
});

test('no live grant → nothing exports at any acting stage (requires_authority_grant)', async () => {
  const calls = [];
  const summary = await runLedgerAutoExportSweep({
    logger: quietLogger,
    deps: {
      listClients: async () => [{ firm_id: 'f1', client_id: 'c1', accounting_system: 'qbo' }],
      readFlags: flagsFor({ c1: CANARY }),
      findGrant: async () => null,
      drainQbo: async () => { throw new Error('must not drain without a grant'); },
      resolveAdapter: () => makeAdapter('qbo', calls),
      preflight: async () => { throw new Error('must not preflight without a grant'); },
      writeReceipts: async () => ({ receipts: 0 })
    }
  });
  assert.equal(summary.clients_no_grant, 1);
  assert.equal(summary.exported, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(summary.errors, []);
});

test('flag off → zero work; acting without the case surface → autonomy refused', async () => {
  const summary = await runLedgerAutoExportSweep({
    logger: quietLogger,
    deps: {
      listClients: async () => [
        { firm_id: 'f1', client_id: 'flag-off', accounting_system: 'xero' },
        { firm_id: 'f1', client_id: 'no-cases', accounting_system: 'xero' }
      ],
      readFlags: flagsFor({
        'no-cases': { stage: 'canary', acts: true, observes: true, syncCasesAct: false }
      }),
      findGrant: async () => { throw new Error('must not look up a grant for skipped clients'); }
    }
  });
  assert.equal(summary.clients_skipped_flag_off, 1);
  assert.equal(summary.clients_skipped_no_case_surface, 1);
  assert.equal(summary.exported, 0);
  assert.deepEqual(summary.errors, []);
});

test('shadow + grant logs would-export and makes ZERO remote calls', async () => {
  const calls = [];
  const shadowLogs = [];
  const summary = await runLedgerAutoExportSweep({
    logger: { ...quietLogger, info: (msg, meta) => shadowLogs.push([msg, meta]) },
    deps: {
      listClients: async () => [{ firm_id: 'f1', client_id: 'c1', accounting_system: 'qbo' }],
      readFlags: flagsFor({ c1: SHADOW }),
      findGrant: async () => GRANT,
      drainQbo: async () => [
        { transactionId: 't1', journalId: 'j1', amount: 100, currency: 'USD', exportable: true }
      ],
      resolveAdapter: () => makeAdapter('qbo', calls),
      preflight: async () => { throw new Error('shadow must not touch the connection'); },
      writeReceipts: async () => { throw new Error('shadow writes nothing'); }
    }
  });
  assert.equal(summary.clients_shadow, 1);
  assert.equal(summary.exported, 0);
  assert.deepEqual(calls, [], 'zero writeback/verify calls in shadow');
  const wouldExport = shadowLogs.find(([msg]) => String(msg).includes('shadow'));
  assert.ok(wouldExport, 'shadow logs what WOULD export');
  assert.deepEqual(wouldExport[1].would_export, ['t1']);
});

test('canary + grant exports via the adapter, chains mirror-verify, writes grant-actor receipts', async () => {
  const calls = [];
  const receiptCalls = [];
  const summary = await runLedgerAutoExportSweep({
    logger: quietLogger,
    deps: {
      listClients: async () => [{ firm_id: 'f1', client_id: 'honeybee', accounting_system: 'qbo' }],
      readFlags: flagsFor({ honeybee: CANARY }),
      findGrant: async () => GRANT,
      drainQbo: async () => [
        { transactionId: 't1', journalId: 'j1', amount: 100, currency: 'USD', exportable: true },
        { transactionId: 't2', journalId: 'j2', amount: 40, currency: 'USD', exportable: true }
      ],
      preflight: async () => ({ id: 'conn-1' }),
      resolveAdapter: () => makeAdapter('qbo', calls),
      writeReceipts: async (args) => { receiptCalls.push(args); return { receipts: args.items.length }; }
    }
  });
  assert.equal(summary.clients_exported, 1);
  assert.equal(summary.exported, 2);
  assert.equal(summary.export_errors, 0);
  assert.equal(summary.mirror_verify_ran, 1);
  assert.equal(summary.receipts_written, 2);
  assert.deepEqual(summary.errors, []);

  const writeback = calls.find(([verb]) => verb === 'writebackBatch');
  assert.deepEqual(writeback[2].transactionIds, ['t1', 't2']);
  assert.equal(writeback[2].actorId, GRANT.id, 'the grant id rides actorId into the writers');
  assert.equal(writeback[2].dryRun, false);

  const verifyIdx = calls.findIndex(([verb]) => verb === 'verifyMirror');
  assert.ok(verifyIdx > calls.findIndex(([verb]) => verb === 'writebackBatch'), 'verify chained AFTER export');

  assert.equal(receiptCalls.length, 1);
  assert.equal(receiptCalls[0].grant.id, GRANT.id);
  assert.equal(receiptCalls[0].flagStage, 'canary');
  assert.deepEqual(receiptCalls[0].mirrorVerifyCounts, { ok: 2, drift: 0 });
  assert.equal(receiptCalls[0].items.every((i) => i.status === 'synced'), true);
});

test('the ceiling excludes over-ceiling and unscoped journals — counted, never handed to the writer', async () => {
  const calls = [];
  const cappedGrant = { ...GRANT, amount_ceiling: 500, currency: 'USD' };
  const summary = await runLedgerAutoExportSweep({
    logger: quietLogger,
    deps: {
      listClients: async () => [{ firm_id: 'f1', client_id: 'c1', accounting_system: 'qbo' }],
      readFlags: flagsFor({ c1: CANARY }),
      findGrant: async () => cappedGrant,
      drainQbo: async () => [
        { transactionId: 't-ok', journalId: 'j1', amount: 499, currency: 'USD', exportable: true },
        { transactionId: 't-big', journalId: 'j2', amount: 501, currency: 'USD', exportable: true },
        { transactionId: null, journalId: 'j-adjustment', amount: 10, currency: 'USD', exportable: false }
      ],
      preflight: async () => ({ id: 'conn-1' }),
      resolveAdapter: () => makeAdapter('qbo', calls),
      writeReceipts: async (args) => ({ receipts: args.items.length })
    }
  });
  assert.equal(summary.skipped_over_ceiling, 1);
  assert.equal(summary.skipped_unscoped_journals, 1);
  assert.equal(summary.exported, 1);
  const writeback = calls.find(([verb]) => verb === 'writebackBatch');
  assert.deepEqual(writeback[2].transactionIds, ['t-ok'], 'only covered ids reach the writer');
});

test('a named CONNECTION_EXPIRED pre-flight skips the client — INT-1 surface, no export', async () => {
  const calls = [];
  const summary = await runLedgerAutoExportSweep({
    logger: quietLogger,
    deps: {
      listClients: async () => [{ firm_id: 'f1', client_id: 'c1', accounting_system: 'qbo' }],
      readFlags: flagsFor({ c1: CANARY }),
      findGrant: async () => GRANT,
      drainQbo: async () => [{ transactionId: 't1', journalId: 'j1', amount: 1, currency: 'USD', exportable: true }],
      preflight: async () => { const e = new Error('expired'); e.code = 'QBO_CONNECTION_EXPIRED'; throw e; },
      resolveAdapter: () => makeAdapter('qbo', calls)
    }
  });
  assert.equal(summary.connection_expired, 1);
  assert.equal(summary.exported, 0);
  assert.deepEqual(calls, [], 'no writeback on a dead connection');
  assert.deepEqual(summary.errors, []);
});

test('per-item writer errors are counted and receipted; a per-client throw never breaks the batch', async () => {
  const receiptCalls = [];
  const summary = await runLedgerAutoExportSweep({
    logger: quietLogger,
    deps: {
      listClients: async () => [
        { firm_id: 'f1', client_id: 'poisoned', accounting_system: 'xero' },
        { firm_id: 'f1', client_id: 'mixed', accounting_system: 'xero' }
      ],
      readFlags: flagsFor({ poisoned: CANARY, mixed: CANARY }),
      findGrant: async () => ({ ...GRANT, accounting_system: 'xero' }),
      drainXero: async ({ clientId }) => {
        if (clientId === 'poisoned') throw new Error('drain exploded');
        return [
          { transactionId: 't1', journalId: null, amount: 10, currency: 'GBP', exportable: true },
          { transactionId: 't2', journalId: null, amount: 20, currency: 'GBP', exportable: true }
        ];
      },
      preflight: async () => ({ id: 'conn-1' }),
      resolveAdapter: () => ({
        id: 'xero',
        writebackBatch: async () => ({
          xero_writeback_batch: {
            results: [
              { transaction_id: 't1', status: 'synced' },
              { transaction_id: 't2', status: 'error', error: 'Xero writeback failed.', error_code: 'E1' }
            ]
          }
        }),
        verifyMirror: async () => ({ xero_mirror_verification: { counts: { ok: 1, drift: 0 } } })
      }),
      writeReceipts: async (args) => { receiptCalls.push(args); return { receipts: args.items.length }; }
    }
  });
  assert.equal(summary.errors.length, 1, 'the poisoned client is recorded');
  assert.equal(summary.errors[0].client_id, 'poisoned');
  assert.equal(summary.exported, 1);
  assert.equal(summary.export_errors, 1);
  const failed = receiptCalls[0].items.find((i) => i.status === 'error');
  assert.equal(failed.errorCode, 'E1', 'the failed item is receipted too');
});

test('the cron function is exported for serve.js registration', () => {
  assert.ok(ledgerAutoExportFunctions.length >= 1);
});
