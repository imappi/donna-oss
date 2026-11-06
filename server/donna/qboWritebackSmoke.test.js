// Pure-core tests for the QBO writeback smoke classifier (INT-2). Mirrors
// xeroWritebackSmoke.test.js: hand-built dry-run shapes and thrown blockers,
// no DB, no network.

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyQboWritebackDryRun, formatQboWritebackReadiness } from './qboWritebackSmoke.js';

const readyResult = (overrides = {}) => ({
  xero_writeback: {
    source: 'qbo_writeback_preview',
    dry_run: true,
    realm_id: 'realm-123',
    journal_id: 'journal-1',
    journal_entry: {
      TxnDate: '2026-06-30',
      DocNumber: 'W-abc123',
      Line: [
        { Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '42' } } },
        { Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '7' } } }
      ]
    },
    summary: { lines: 2, debit_total: 100, credit_total: 100, doc_number: 'W-abc123', update: false },
    update: false,
    already_synced: false,
    ...overrides
  }
});

const codedError = (code, message, extra = {}) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  Object.assign(error, extra);
  return error;
};

test('ready: a clean dry-run preview classifies READY with a posting summary', () => {
  const verdict = classifyQboWritebackDryRun({ result: readyResult() });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.blocker, null);
  assert.equal(verdict.summary.realm, 'realm-123');
  assert.equal(verdict.summary.lines, 2);
  assert.equal(verdict.summary.debit_total, 100);
  assert.equal(verdict.summary.update, false);
  const text = formatQboWritebackReadiness(verdict, { transactionId: 'tx-1' });
  assert.match(text, /READY/);
  assert.match(text, /realm-123/);
  assert.match(text, /debits 100 \/ credits 100/);
});

test('ready + already_synced: surfaces the idempotency note', () => {
  const verdict = classifyQboWritebackDryRun({ result: readyResult({ already_synced: true, summary: { lines: 2, debit_total: 100, credit_total: 100, doc_number: 'W-abc123', update: true } }) });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.summary.already_synced, true);
  assert.equal(verdict.summary.update, true);
  const text = formatQboWritebackReadiness(verdict, { transactionId: 'tx-1' });
  assert.match(text, /already synced/);
  assert.match(text, /UPDATE/);
});

test('blocker: not configured maps to env-var hint', () => {
  const verdict = classifyQboWritebackDryRun({ error: new Error('QuickBooks Online is not configured. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI.') });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.blocker.code, 'not_configured');
  assert.match(verdict.blocker.hint, /QBO_CLIENT_ID/);
});

test('blocker: missing connection row maps to connect hint', () => {
  const verdict = classifyQboWritebackDryRun({ error: new Error('QuickBooks Online connection not found.') });
  assert.equal(verdict.blocker.code, 'not_connected');
  assert.match(verdict.blocker.hint, /qbo_connections/);
});

test('blocker: QBO_CONNECTION_EXPIRED (INT-1) maps to reconnect hint', () => {
  const verdict = classifyQboWritebackDryRun({
    error: codedError('QBO_CONNECTION_EXPIRED', 'QuickBooks Online token refresh failed — reconnect QuickBooks to continue.')
  });
  assert.equal(verdict.blocker.code, 'connection_expired');
  assert.match(verdict.blocker.hint, /Reconnect/i);
});

test('blocker: unposted journal maps to post-first hint', () => {
  const verdict = classifyQboWritebackDryRun({ error: new Error('No posted ledger journal found for QuickBooks writeback.') });
  assert.equal(verdict.blocker.code, 'journal_not_posted');
  assert.match(verdict.blocker.hint, /post-transaction/i);
});

test('blocker: unmapped account carries the offending lines into the report', () => {
  const verdict = classifyQboWritebackDryRun({
    error: codedError(
      'QBO_WRITEBACK_UNMAPPED_ACCOUNT',
      'No QuickBooks account matches 1 ledger line(s). Sync QuickBooks or align the account code/name.',
      { unmapped: [{ account_code: '405', account_name: 'Software subscriptions' }] }
    )
  });
  assert.equal(verdict.blocker.code, 'unmapped_account');
  assert.equal(verdict.blocker.unmapped.length, 1);
  const text = formatQboWritebackReadiness(verdict, { transactionId: 'tx-1' });
  assert.match(text, /NOT READY/);
  assert.match(text, /405 · Software subscriptions/);
  assert.match(text, /resolve-at-writeback/);
});

test('blocker: no synced accounts / no lines / unbalanced map to their codes', () => {
  assert.equal(classifyQboWritebackDryRun({ error: codedError('QBO_WRITEBACK_NO_ACCOUNTS', 'No QuickBooks accounts are synced for this client — run Sync before writeback.') }).blocker.code, 'no_accounts');
  assert.equal(classifyQboWritebackDryRun({ error: codedError('QBO_WRITEBACK_NO_LINES', 'Ledger journal has no postable lines.') }).blocker.code, 'no_lines');
  assert.equal(classifyQboWritebackDryRun({ error: codedError('QBO_WRITEBACK_UNBALANCED', 'Ledger journal does not balance (debits 100 vs credits 90).') }).blocker.code, 'unbalanced');
});

test('blocker: unknown error passes through with its code and no hint', () => {
  const verdict = classifyQboWritebackDryRun({ error: codedError('SOMETHING_ELSE', 'weird failure') });
  assert.equal(verdict.blocker.code, 'SOMETHING_ELSE');
  assert.equal(verdict.blocker.hint, null);
});

test('no preview: a dry-run result without journal_entry is NOT READY', () => {
  const verdict = classifyQboWritebackDryRun({ result: { xero_writeback: { dry_run: true } } });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.blocker.code, 'no_preview');
});
