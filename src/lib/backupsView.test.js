import test from 'node:test';
import assert from 'node:assert/strict';

import { describeLastBackup, formatBackupTime, humanizeBackupCron } from './backupsView.js';

test('humanizeBackupCron reads daily shapes and refuses to guess the rest', () => {
  assert.equal(humanizeBackupCron('30 1 * * *'), 'Daily, 01:30');
  assert.equal(humanizeBackupCron('0 3 * * *'), 'Daily, 03:00');
  assert.equal(humanizeBackupCron('15 4 * * 0'), '15 4 * * 0');
  assert.equal(humanizeBackupCron(''), '');
  assert.equal(humanizeBackupCron(null), '');
});

test('describeLastBackup skips packages whose manifest does not checksum', () => {
  assert.deepEqual(describeLastBackup([]), { label: 'None yet', detail: '', ok: false });
  assert.deepEqual(describeLastBackup(null), { label: 'None yet', detail: '', ok: false });

  const described = describeLastBackup([
    { name: 'broken', created_at: '2026-08-08T09:00:00Z', manifest_ok: false },
    { name: 'good', created_at: '2026-08-06T01:30:00Z', reason: 'daily', blob_count: 1, manifest_ok: true }
  ]);
  assert.equal(described.ok, true);
  assert.equal(described.label, formatBackupTime('2026-08-06T01:30:00Z'));
  assert.equal(described.detail, 'scheduled · 1 document');
});

test('formatBackupTime degrades to empty on junk', () => {
  assert.equal(formatBackupTime(null), '');
  assert.equal(formatBackupTime('not a date'), '');
  assert.ok(formatBackupTime(new Date().toISOString()).startsWith('Today '));
});
