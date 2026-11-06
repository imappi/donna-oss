import assert from 'node:assert/strict';
import test from 'node:test';

import { WRITER_BOUNDARIES, resumeCrashedWorld, runCrashResume } from './eval_world_crash_resume.js';

const world = {
  worldId: 'slice2/crash-resume', effectiveDate: '2026-08-05',
  artifacts: [{ id: 'artifact/a', kind: 'bank_line' }],
  events: [{ id: 'event/a', type: 'cash_movement', occurredAt: '2026-08-05', monetaryEffects: { amount: 10, currency: 'GBP' } }]
};

function fakeOps({ duplicate = false, secondCrash = null } = {}) {
  const state = { calls: [], journals: [], locked: false, archive: null, exported: false, retired: false, secondCrash };
  const call = (name) => state.calls.push(name);
  const maybeCrash = (name) => { if (state.secondCrash === name) { state.secondCrash = null; throw Object.assign(new Error('double crash'), { code: 'INJECTED_SECOND_CRASH' }); } };
  return {
    state,
    isFirmDatabaseConfigured: () => true,
    createFirmInDb: async () => { call('createFirmInDb'); state.retired = false; return {}; },
    createClientInDb: async () => { call('createClientInDb'); return {}; },
    syncDocumentsAndTransactionsInDb: async () => { call('syncDocumentsAndTransactionsInDb'); return {}; },
    postLedgerPeriodInDb: async () => {
      call('postLedgerPeriodInDb'); maybeCrash('postLedgerPeriodInDb');
      if (!state.journals.length) state.journals.push('journal/event-a');
      return { ledger_period_posting: { results: state.journals.length === 1 && state.calls.filter((x) => x === 'postLedgerPeriodInDb').length === 1 ? [{ status: 'posted', ledger_journal_id: state.journals[0] }] : [{ status: 'skipped', reason: 'already_posted' }] } };
    },
    getLedgerPeriodPreviewFromDb: async () => ({ ...(state.locked ? { ledger_period: { status: 'locked' } } : { close_preview: { lockable: true, period_start: '2026-08-01', period_end: '2026-08-31' } }) }),
    getCloseExceptionsFromDb: async () => ({ exceptions: [] }),
    getClientEvidenceRequestsFromDb: async () => ({ requests: [] }),
    getCloseDiagnosticsFromDb: async () => ({ status: 'passed' }),
    lockClosePeriodInDb: async () => { call('lockClosePeriodInDb'); maybeCrash('lockClosePeriodInDb'); state.locked = true; return { close_lock: { id: 'lock-1', status: 'locked' } }; },
    createCloseArchiveInDb: async () => { call('createCloseArchiveInDb'); maybeCrash('createCloseArchiveInDb'); state.archive = 'archive-1'; return { close_archive: { archive_id: state.archive, status: 'generated' } }; },
    getCloseArchiveExportFromDb: async () => { call('getCloseArchiveExportFromDb'); maybeCrash('getCloseArchiveExportFromDb'); state.exported = true; return { bundle_checksum_sha256: 'a'.repeat(64) }; },
    deleteFirmInDb: async () => { call('deleteFirmInDb'); maybeCrash('deleteFirmInDb'); state.retired = true; return { residue_verified: true, retired: true }; },
    countFirmResidueInDb: async () => ({ residue_rows: 0 }),
    countPersistedJournalsInDb: async () => ({ count: state.journals.length }),
    readTerminalInventoryInDb: async () => {
      const ids = duplicate ? [...state.journals, ...state.journals] : [...state.journals];
      return { counts: { journals: ids.length, t1: 1, t2: 0, limbo: 0 }, journal_ids: ids, terminal: { t1: [{ source: 'close_period_status', status: 'locked' }], locked: true, t2: [], limbo: [] }, limbo: [] };
    }
  };
}

test('enumerated matrix covers post, lock, archive, export, and retire exactly', () => {
  assert.deepEqual(WRITER_BOUNDARIES.map((row) => row.boundary), ['post', 'lock', 'archive', 'export', 'retire']);
  assert.equal(new Set(WRITER_BOUNDARIES.map((row) => row.operation)).size, 5);
});

for (const { boundary, operation } of WRITER_BOUNDARIES) {
  for (const crashMode of ['before', 'inside']) {
    test(`${boundary}: ${crashMode} writer crash resumes with identical terminal ids and no replay journals`, async () => {
      const ops = fakeOps();
      const result = await runCrashResume({ world, runToken: `${boundary}-${crashMode}`, ops, boundary, crashMode });
      assert.deepEqual(result.terminal_inventory.counts, { journals: 1, t1: 1, t2: 0, limbo: 0 });
      assert.deepEqual(result.terminal_inventory.journal_ids, ['journal/event-a']);
      assert.equal(result.replay_new_journals, 0);
      assert.equal(ops.state.retired, true);
      if (['archive', 'export', 'retire'].includes(boundary) && crashMode === 'inside') {
        assert.equal(ops.state.calls.filter((name) => name === 'lockClosePeriodInDb').length, 1, 'resume must never re-lock');
      }
      if (['export', 'retire'].includes(boundary) && crashMode === 'inside') {
        assert.equal(ops.state.calls.filter((name) => name === 'createCloseArchiveInDb').length, 1, 'resume must never re-archive');
      }
      assert.ok(ops.state.calls.indexOf(operation) >= 0);
      assert.ok(ops.state.calls.indexOf('deleteFirmInDb') > ops.state.calls.indexOf('getCloseArchiveExportFromDb'), 'cleanup remains last');
    });
  }
}

test('seeded persisted duplicate journal is detected, not caller-attested away', async () => {
  await assert.rejects(() => runCrashResume({ world, runToken: 'duplicate', ops: fakeOps({ duplicate: true }), boundary: 'archive' }), (error) => error.code === 'EAW_RESUME_DIVERGED' && /count|duplicate/.test(error.message));
});

test('a second crash during resume stays failed and can be retried from the same checkpoint', async () => {
  const ops = fakeOps({ secondCrash: 'createCloseArchiveInDb' });
  let checkpoint;
  await assert.rejects(() => runCrashResume({ world, runToken: 'double', ops, boundary: 'lock', crashMode: 'inside' }), (error) => {
    checkpoint = error.checkpoint;
    return error.code === 'INJECTED_SECOND_CRASH';
  });
  const resumed = await resumeCrashedWorld({ world, runToken: 'double', ops, checkpoint });
  assert.equal(resumed.replay_new_journals, 0);
  assert.equal(ops.state.retired, true);
});

test('resume refuses a wrong run token before invoking a writer', async () => {
  const ops = fakeOps();
  const before = ops.state.calls.length;
  await assert.rejects(() => resumeCrashedWorld({ world, runToken: 'wrong', ops, checkpoint: { run_token: 'right' } }), { code: 'EAW_RESUME_TOKEN_MISMATCH' });
  assert.equal(ops.state.calls.length, before);
});

test('crash after retirement persisted but before its receipt does not rerun any terminal writer', async () => {
  const ops = fakeOps();
  const result = await runCrashResume({ world, runToken: 'after-last', ops, boundary: 'retire', crashMode: 'inside' });
  assert.equal(result.receipt.recovered_retire_receipt.retired, true);
  assert.equal(ops.state.calls.filter((name) => name === 'deleteFirmInDb').length, 1);
  assert.equal(ops.state.calls.filter((name) => name === 'lockClosePeriodInDb').length, 1);
  assert.equal(ops.state.calls.filter((name) => name === 'createCloseArchiveInDb').length, 1);
});
