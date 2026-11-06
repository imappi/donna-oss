// Recode-of-a-posted-row → ledger reclass adjustment (the 2026-07-03 Dadant
// fix). When a chat recode targets a row that already POSTED to the Donna
// ledger, the fresh-post path 409s (LEDGER_ALREADY_POSTED) and the review
// layer splits from the ledger — the firm-side limbo the two-terminal-states
// rail forbids. This module completes the firm's instruction instead: it
// posts a RECLASS adjustment (debit the new account, credit the prior one —
// mirrored for money-in) through the existing audited correction writer,
// postLedgerAdjustmentInDb. No new accounting backend: one delta journal,
// balanced by construction, actor-attributed, lineage recorded against the
// original journal.
//
// Why a delta reclass and not reverse-and-replace: the transaction row keeps
// pointing at its ORIGINAL journal across corrections, so anchoring a
// reversal there is only correct the first time — a second recode would
// reverse the original again and corrupt the net. The reclass composes:
// each one moves the balance from the CURRENT coding (the review layer's
// before_state, captured by the writer in the same apply) to the new one,
// no matter how many recodes preceded it.
//
// It auto-posts ONLY when unambiguous:
//   - the transaction is posted to the local ledger (has ledger_journal_id),
//   - the original journal has exactly TWO lines (single coding line + bank
//     line — a split/tax journal can't be reclassed by account swap),
//   - the prior coding is known (before_state) and differs from the target,
//   - the row has a one-sided amount (money_in xor money_out).
// Anything else returns { status: 'pending' } and the caller surfaces the
// honest ledger_adjustment_required state instead of guessing.

// Pure lines builder — exported for tests. money_out: the expense/asset side
// moves, so debit NEW / credit OLD. money_in mirrors (credit side moves).
export const __reclassAdjustmentLines = ({
  moneyOut = 0,
  moneyIn = 0,
  amount,
  previousAccount = {},
  nextAccount = {},
  currency
} = {}) => {
  const value = Math.round(Number(amount) * 100) / 100;
  const isOutflow = Number(moneyOut) > 0;
  const next = {
    account_code: nextAccount.code || null,
    account_name: nextAccount.name,
    currency,
    ...(isOutflow ? { debit: value } : { credit: value })
  };
  const previous = {
    account_code: previousAccount.code || null,
    account_name: previousAccount.name,
    currency,
    ...(isOutflow ? { credit: value } : { debit: value })
  };
  return [next, previous];
};

export const attemptLedgerReclass = async ({
  firmId,
  clientId,
  transactionId,
  newAccount = {},
  previousAccountName = null,
  reason,
  actorId,
  d = {}
} = {}) => {
  const { queryFirmDb, postLedgerAdjustmentInDb } = d;
  if (typeof queryFirmDb !== 'function' || typeof postLedgerAdjustmentInDb !== 'function') {
    throw new Error('attemptLedgerReclass requires queryFirmDb and postLedgerAdjustmentInDb.');
  }
  const newName = String(newAccount.name || '').trim();
  if (!newName) return { status: 'pending', reason: 'missing_target_account' };

  const txResult = await queryFirmDb(
    `select money_in, money_out, currency,
            payload->>'ledger_journal_id' as ledger_journal_id
       from transactions
      where firm_id = $1 and client_id = $2 and id = $3
      limit 1`,
    [firmId, clientId, transactionId]
  );
  const tx = txResult.rows[0];
  // Unknown row / not posted → the caller's normal fresh-post path owns it
  // (and reports its own 404 if the row is genuinely missing).
  if (!tx || !tx.ledger_journal_id) return { status: 'not_posted' };
  const originalJournalId = tx.ledger_journal_id;

  const prevName = String(previousAccountName || '').trim();
  if (!prevName) {
    return { status: 'pending', reason: 'unknown_prior_coding', original_journal_id: originalJournalId };
  }
  if (prevName.toLowerCase() === newName.toLowerCase()) {
    return { status: 'noop', original_journal_id: originalJournalId };
  }

  const moneyOut = Number(tx.money_out) || 0;
  const moneyIn = Number(tx.money_in) || 0;
  const amount = moneyOut > 0 ? moneyOut : moneyIn;
  if (!(amount > 0) || (moneyOut > 0 && moneyIn > 0)) {
    return { status: 'pending', reason: 'ambiguous_amount', original_journal_id: originalJournalId };
  }

  const linesResult = await queryFirmDb(
    `select account_code, account_name, currency
       from ledger_lines
      where firm_id = $1 and client_id = $2 and journal_id = $3
      order by line_no`,
    [firmId, clientId, originalJournalId]
  );
  const originalLines = linesResult.rows || [];
  if (originalLines.length !== 2) {
    return { status: 'pending', reason: 'multi_line_journal', original_journal_id: originalJournalId };
  }
  // Reuse the prior coding line's account_code so the reclass credits the
  // SAME account row (accounts are keyed on code||name at the writer).
  const prevLine = originalLines.find(
    (line) => String(line.account_name || '').trim().toLowerCase() === prevName.toLowerCase()
  );

  const currency = String(tx.currency || originalLines[0].currency || '').trim().toUpperCase();
  const lines = __reclassAdjustmentLines({
    moneyOut,
    moneyIn,
    amount,
    previousAccount: { name: prevName, code: prevLine?.account_code || null },
    nextAccount: { name: newName, code: newAccount.code || null },
    currency
  });

  const adjustment = await postLedgerAdjustmentInDb({
    firmId,
    clientId,
    transactionId,
    reason: String(reason || '').trim() || `Recode to ${newName} via chat`,
    lines,
    // Delta reclass, never a reversal — see the module header.
    reverseOriginal: false,
    actorId
  });
  return {
    status: 'reclassed',
    original_journal_id: originalJournalId,
    ledger_adjustment: adjustment?.ledger_adjustment || null
  };
};
