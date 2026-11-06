import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProcountorWritebackSmoke } from './procountorWritebackSmoke.js';

await test('classifies a dry-run/execute/verify Procountor smoke as passed', () => {
  assert.equal(classifyProcountorWritebackSmoke({
    dryRun: { xero_writeback: { status: 'preview' } },
    execute: { xero_writeback: { status: 'synced', procountor_journal_entry_id: 'jr-1' } },
    verify: { procountor_mirror_verification: { counts: { ok: 1, drift: 0, missing: 0 } } }
  }).status, 'passed');
});
