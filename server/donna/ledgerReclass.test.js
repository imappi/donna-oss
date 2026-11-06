// attemptLedgerReclass — unit tests (fully injected deps, no DB).
//
// Load-bearing properties (the 2026-07-03 Dadant fix):
//   - a recode of a POSTED row completes as a DELTA reclass adjustment
//     (debit new / credit old, mirrored for money-in) through the existing
//     correction writer with reverseOriginal: false — never a reversal of
//     the original journal (a second recode anchored there would corrupt
//     the net), never a blind re-post;
//   - it auto-posts ONLY when unambiguous: 2-line original journal, known
//     prior coding, one-sided amount. Everything else → status 'pending'
//     with a named reason, for the caller to surface honestly;
//   - not-posted rows pass through untouched (status 'not_posted') so the
//     caller's fresh-post path keeps owning them;
//   - same-account recodes are a 'noop' (no adjustment posted).

import assert from 'node:assert/strict';
import test from 'node:test';

import { attemptLedgerReclass, __reclassAdjustmentLines } from './ledgerReclass.js';

const makeDeps = ({
  tx = { money_in: 0, money_out: '150.23', currency: 'USD', ledger_journal_id: 'jrnl-1' },
  lines = [
    { account_code: 'Office expenses', account_name: 'Office expenses', currency: 'USD' },
    { account_code: null, account_name: 'Business Checking · USD', currency: 'USD' }
  ]
} = {}) => {
  const calls = { adjustments: [] };
  const d = {
    queryFirmDb: async (sql) => {
      if (/from transactions/.test(sql)) return { rows: tx ? [tx] : [] };
      if (/from ledger_lines/.test(sql)) return { rows: lines };
      return { rows: [] };
    },
    postLedgerAdjustmentInDb: async (args) => {
      calls.adjustments.push(args);
      return {
        ledger_adjustment: {
          original_journal_id: null,
          journals: [{ ledger_journal_id: 'jrnl-adj-1', correction_type: 'replacement' }]
        }
      };
    }
  };
  return { d, calls };
};

const baseArgs = {
  firmId: 'firm-1',
  clientId: 'client-1',
  transactionId: 'tx-7',
  newAccount: { name: 'Marketing', code: null },
  previousAccountName: 'Office expenses',
  reason: 'Firm recode',
  actorId: 'kari@books.example'
};

test('lines builder: money_out → debit new / credit old; money_in mirrors', () => {
  const out = __reclassAdjustmentLines({
    moneyOut: 150.23,
    amount: 150.23,
    previousAccount: { name: 'Office expenses', code: 'OFF' },
    nextAccount: { name: 'Marketing', code: null },
    currency: 'USD'
  });
  assert.deepEqual(out, [
    { account_code: null, account_name: 'Marketing', currency: 'USD', debit: 150.23 },
    { account_code: 'OFF', account_name: 'Office expenses', currency: 'USD', credit: 150.23 }
  ]);
  const inflow = __reclassAdjustmentLines({
    moneyIn: 99.5,
    amount: 99.5,
    previousAccount: { name: 'Sales' },
    nextAccount: { name: 'Other income' },
    currency: 'USD'
  });
  assert.equal(inflow[0].credit, 99.5);
  assert.equal(inflow[1].debit, 99.5);
});

test('posted 2-line row reclasses via the correction writer, no reversal', async () => {
  const { d, calls } = makeDeps();
  const out = await attemptLedgerReclass({ ...baseArgs, d });
  assert.equal(out.status, 'reclassed');
  assert.equal(out.original_journal_id, 'jrnl-1');
  assert.equal(calls.adjustments.length, 1);
  const adj = calls.adjustments[0];
  assert.equal(adj.reverseOriginal, false);
  assert.equal(adj.transactionId, 'tx-7');
  assert.equal(adj.actorId, 'kari@books.example');
  assert.deepEqual(adj.lines[0], { account_code: null, account_name: 'Marketing', currency: 'USD', debit: 150.23 });
  // The credit leg reuses the ORIGINAL line's account_code so it hits the
  // same account row (accounts key on code||name at the writer).
  assert.deepEqual(adj.lines[1], { account_code: 'Office expenses', account_name: 'Office expenses', currency: 'USD', credit: 150.23 });
});

test('not-posted (or unknown) rows pass through to the fresh-post path', async () => {
  const noJournal = makeDeps({ tx: { money_out: '10', currency: 'USD', ledger_journal_id: null } });
  assert.equal((await attemptLedgerReclass({ ...baseArgs, d: noJournal.d })).status, 'not_posted');
  assert.equal(noJournal.calls.adjustments.length, 0);
  const noRow = makeDeps({ tx: null });
  assert.equal((await attemptLedgerReclass({ ...baseArgs, d: noRow.d })).status, 'not_posted');
});

test('same-account recode is a noop — no adjustment posted', async () => {
  const { d, calls } = makeDeps();
  const out = await attemptLedgerReclass({ ...baseArgs, previousAccountName: 'marketing', newAccount: { name: 'Marketing' }, d });
  assert.equal(out.status, 'noop');
  assert.equal(calls.adjustments.length, 0);
});

test('ambiguity → pending with a named reason, never a guess', async () => {
  // Unknown prior coding.
  const a = makeDeps();
  const unknownPrior = await attemptLedgerReclass({ ...baseArgs, previousAccountName: null, d: a.d });
  assert.equal(unknownPrior.status, 'pending');
  assert.equal(unknownPrior.reason, 'unknown_prior_coding');
  assert.equal(unknownPrior.original_journal_id, 'jrnl-1');

  // Split / multi-line journal.
  const b = makeDeps({
    lines: [
      { account_name: 'Office expenses', currency: 'USD' },
      { account_name: 'GST', currency: 'USD' },
      { account_name: 'Business Checking · USD', currency: 'USD' }
    ]
  });
  const multi = await attemptLedgerReclass({ ...baseArgs, d: b.d });
  assert.equal(multi.status, 'pending');
  assert.equal(multi.reason, 'multi_line_journal');

  // Two-sided / zero amount.
  const c = makeDeps({ tx: { money_in: '5', money_out: '5', currency: 'USD', ledger_journal_id: 'jrnl-1' } });
  const ambiguous = await attemptLedgerReclass({ ...baseArgs, d: c.d });
  assert.equal(ambiguous.status, 'pending');
  assert.equal(ambiguous.reason, 'ambiguous_amount');

  assert.equal(a.calls.adjustments.length + b.calls.adjustments.length + c.calls.adjustments.length, 0);
});

test('writer errors propagate to the caller (who reports them honestly)', async () => {
  const { d } = makeDeps();
  d.postLedgerAdjustmentInDb = async () => {
    const error = new Error('Adjustment journal date falls inside a locked period.');
    error.statusCode = 409;
    throw error;
  };
  await assert.rejects(attemptLedgerReclass({ ...baseArgs, d }), /locked period/);
});
