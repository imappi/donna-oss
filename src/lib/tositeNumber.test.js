import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asTositeNumber,
  buildTositeIndex,
  tositeForJournalId,
  formatTositeLabel,
  postedLedgerDetail
} from './tositeNumber.js';

test('asTositeNumber accepts positive integers only', () => {
  assert.equal(asTositeNumber(1), 1);
  assert.equal(asTositeNumber(42), 42);
  assert.equal(asTositeNumber(0), null);
  assert.equal(asTositeNumber(-3), null);
  assert.equal(asTositeNumber(2.5), null);
  assert.equal(asTositeNumber(null), null);
  assert.equal(asTositeNumber(undefined), null);
  assert.equal(asTositeNumber('5'), null);
});

test('buildTositeIndex maps journal id -> tosite_number, skipping unnumbered', () => {
  const index = buildTositeIndex([
    { id: 'j1', tosite_number: 1 },
    { id: 'j2', tosite_number: 2 },
    { id: 'j3', tosite_number: null }, // flag-off / pre-FI-5 → absent
    { id: 'j4' }, // no column → absent
    { tosite_number: 9 } // no id → absent
  ]);
  assert.equal(index.get('j1'), 1);
  assert.equal(index.get('j2'), 2);
  assert.equal(index.has('j3'), false);
  assert.equal(index.has('j4'), false);
  assert.equal(index.size, 2);
});

test('buildTositeIndex tolerates non-array input', () => {
  assert.equal(buildTositeIndex(undefined).size, 0);
  assert.equal(buildTositeIndex(null).size, 0);
  assert.equal(buildTositeIndex('nope').size, 0);
});

test('tositeForJournalId looks up safely', () => {
  const index = buildTositeIndex([{ id: 'j1', tosite_number: 7 }]);
  assert.equal(tositeForJournalId('j1', index), 7);
  assert.equal(tositeForJournalId('missing', index), null);
  assert.equal(tositeForJournalId(null, index), null);
  assert.equal(tositeForJournalId('j1', null), null);
});

test('formatTositeLabel renders the voucher label or null', () => {
  assert.equal(formatTositeLabel(5), 'Tosite #5');
  assert.equal(formatTositeLabel(0), null);
  assert.equal(formatTositeLabel(null), null);
});

test('postedLedgerDetail prefers the voucher number, falls back unchanged', () => {
  assert.equal(postedLedgerDetail({ tositeNumber: 3, ledgerJournalId: 'abc' }), 'Tosite #3');
  // flag-off / pre-FI-5: fall back to the existing journal-id display, then 'Posted'
  assert.equal(postedLedgerDetail({ tositeNumber: null, ledgerJournalId: 'abc' }), 'abc');
  assert.equal(postedLedgerDetail({ tositeNumber: null, ledgerJournalId: null }), 'Posted');
  assert.equal(postedLedgerDetail({}), 'Posted');
});
