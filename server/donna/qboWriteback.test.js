import assert from 'node:assert/strict';

import {
  buildQboAccountResolver,
  buildQboJournalEntry,
  buildQboMirrorVerificationResult,
  QBO_DOC_NUMBER_MAX
} from './qboWriteback.js';

// Synced QBO accounts (DB-row shape) → resolver. Match by account number first,
// then case-folded name.
const resolver = buildQboAccountResolver([
  { qbo_account_id: '40', account_number: '6000', name: 'Office Supplies' },
  { qbo_account_id: '12', account_number: '1001', name: 'Business Checking' }
]);
assert.equal(resolver.accountCount, 2);
assert.equal(resolver.resolve({ account_code: '6000' }).id, '40');
assert.equal(resolver.resolve({ account_name: 'business checking' }).id, '12');
assert.equal(resolver.resolve({ account_code: '9999', account_name: 'Nope' }), null);

const journal = { id: 'j1', journal_date: '2026-05-31', memo: 'Office supplies run', currency: 'USD' };
const balancedLines = [
  { line_no: 1, direction: 'debit', debit: 80, credit: 0, account_code: '6000', account_name: 'Office Supplies', memo: 'Paper' },
  { line_no: 2, direction: 'credit', debit: 0, credit: 80, account_code: '1001', account_name: 'Business Checking' }
];

// Happy path: balanced double-entry maps to a two-line JournalEntry with
// PostingType + AccountRef, TxnDate, DocNumber, PrivateNote.
const built = buildQboJournalEntry({ journal, lines: balancedLines, resolver, docNumber: 'W-abc123' });
assert.equal(built.summary.lines, 2);
assert.equal(built.summary.debit_total, 80);
assert.equal(built.summary.credit_total, 80);
assert.equal(built.summary.update, false);
assert.equal(built.journal_entry.TxnDate, '2026-05-31');
assert.equal(built.journal_entry.DocNumber, 'W-abc123');
assert.equal(built.journal_entry.PrivateNote, 'Office supplies run');
assert.equal(built.journal_entry.Line.length, 2);
assert.deepEqual(built.journal_entry.Line[0].JournalEntryLineDetail, { PostingType: 'Debit', AccountRef: { value: '40' } });
assert.deepEqual(built.journal_entry.Line[1].JournalEntryLineDetail, { PostingType: 'Credit', AccountRef: { value: '12' } });
assert.equal(built.journal_entry.Line[0].Description, 'Paper');
// Line 2 has no memo → Description pruned (not present, not null).
assert.equal('Description' in built.journal_entry.Line[1], false);
// Create body carries no Id/SyncToken.
assert.equal('Id' in built.journal_entry, false);

// Update mode: existing mirror id + sync token shapes a sparse:false update.
const updated = buildQboJournalEntry({
  journal,
  lines: balancedLines,
  resolver,
  docNumber: 'W-abc123',
  existing: { qboJournalEntryId: '777', syncToken: '3' }
});
assert.equal(updated.journal_entry.Id, '777');
assert.equal(updated.journal_entry.SyncToken, '3');
assert.equal(updated.journal_entry.sparse, false);
assert.equal(updated.summary.update, true);

// DocNumber is capped at QBO's 21-char limit.
const longDoc = buildQboJournalEntry({ journal, lines: balancedLines, resolver, docNumber: 'W-0123456789012345678901234567890' });
assert.equal(longDoc.journal_entry.DocNumber.length, QBO_DOC_NUMBER_MAX);

// Unmapped account → hard error (never post a half-mapped entry).
assert.throws(
  () => buildQboJournalEntry({
    journal,
    lines: [
      { direction: 'debit', debit: 10, account_code: '6000', account_name: 'Office Supplies' },
      { direction: 'credit', credit: 10, account_code: '9999', account_name: 'Unknown' }
    ],
    resolver
  }),
  (err) => {
    assert.equal(err.code, 'QBO_WRITEBACK_UNMAPPED_ACCOUNT');
    assert.equal(err.statusCode, 400);
    assert.equal(err.details.unmapped.length, 1);
    return true;
  }
);

// Unbalanced journal → error.
assert.throws(
  () => buildQboJournalEntry({
    journal,
    lines: [
      { direction: 'debit', debit: 80, account_code: '6000', account_name: 'Office Supplies' },
      { direction: 'credit', credit: 70, account_code: '1001', account_name: 'Business Checking' }
    ],
    resolver
  }),
  (err) => err.code === 'QBO_WRITEBACK_UNBALANCED'
);

// No postable lines → error.
assert.throws(() => buildQboJournalEntry({ journal, lines: [], resolver }), (err) => err.code === 'QBO_WRITEBACK_NO_LINES');

// No synced accounts → error (sync is a prerequisite for writeback).
assert.throws(
  () => buildQboJournalEntry({ journal, lines: balancedLines, resolver: buildQboAccountResolver([]) }),
  (err) => err.code === 'QBO_WRITEBACK_NO_ACCOUNTS'
);

// Verification: exact match → mirror_ok.
const okVerify = buildQboMirrorVerificationResult({
  journalId: 'j1',
  expected: { qboJournalEntryId: '777', lineCount: 2, total: 80, txnDate: '2026-05-31' },
  fetched: { id: '777', lineCount: 2, total: 80, txnDate: '2026-05-31' }
});
assert.equal(okVerify.status, 'mirror_ok');
assert.equal(okVerify.checks.amount, true);

// Verification: amount drift → mirror_drift.
const driftVerify = buildQboMirrorVerificationResult({
  journalId: 'j1',
  expected: { qboJournalEntryId: '777', lineCount: 2, total: 80, txnDate: '2026-05-31' },
  fetched: { id: '777', lineCount: 2, total: 70, txnDate: '2026-05-31' }
});
assert.equal(driftVerify.status, 'mirror_drift');
assert.equal(driftVerify.checks.amount, false);

// Verification: nothing fetched → mirror_missing; thrown error → mirror_error.
assert.equal(buildQboMirrorVerificationResult({ journalId: 'j1', expected: { qboJournalEntryId: '777' }, fetched: null }).status, 'mirror_missing');
assert.equal(buildQboMirrorVerificationResult({ journalId: 'j1', error: new Error('boom') }).status, 'mirror_error');

console.log('qboWriteback tests passed');
