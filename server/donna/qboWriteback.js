// QBO writeback builder — pure (no DB, no network). Mirrors a Donna ledger
// journal (double-entry: ledger_journals + ledger_lines) to a QBO JournalEntry,
// line-for-line: each ledger line becomes a QBO Line with PostingType
// Debit/Credit + an AccountRef resolved from the synced qbo_accounts. firmDb
// loads the journal/lines/accounts and persists what these return.
//
// Account mapping is resolve-at-writeback (decision: no persisted qbo_account_id
// on ledger_accounts) — match each line's account code (AcctNum) first, then its
// name, against the latest sync. An unmatched line is a hard error: writeback
// fails loudly rather than posting a half-mapped entry.
import { toIsoDay, toLocalIsoDay } from './dates.js';

const trim = (value = '') => String(value ?? '').trim();

const money = (value = 0) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
};

const dateOnly = (value) => {
  if (!value) return '';
  if (value instanceof Date) return toIsoDay(value); // a pg `date`: local midnight
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  // Free text parses to host-local midnight, so the host-local day is the
  // day the text named (audit F-11).
  return toLocalIsoDay(new Date(text));
};

// QBO DocNumber caps at 21 chars.
export const QBO_DOC_NUMBER_MAX = 21;

const writebackError = (message, code = 'QBO_WRITEBACK_INVALID_PAYLOAD', details) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  if (details) error.details = details;
  return error;
};

// Drop undefined keys so optional fields (Description, DocNumber, …) don't ride
// along as nulls. JSON round-trip drops object undefined values cleanly.
const prune = (object) => JSON.parse(JSON.stringify(object));

// Build a ledger-account → QBO-account resolver from synced qbo_accounts rows
// (accepts either snake_case DB rows or normalized camelCase). Matches by
// account number (AcctNum) first — most stable — then case-folded name.
export const buildQboAccountResolver = (qboAccounts = []) => {
  const byNumber = new Map();
  const byName = new Map();
  for (const account of Array.isArray(qboAccounts) ? qboAccounts : []) {
    const id = trim(account.qbo_account_id || account.qboAccountId || account.Id || account.id);
    if (!id) continue;
    const number = trim(account.account_number || account.accountNumber || account.AcctNum);
    const name = trim(account.name || account.Name).toLowerCase();
    if (number && !byNumber.has(number)) byNumber.set(number, { id, account });
    if (name && !byName.has(name)) byName.set(name, { id, account });
  }
  return {
    accountCount: Array.isArray(qboAccounts) ? qboAccounts.length : 0,
    resolve: (line = {}) => {
      const code = trim(line.account_code || line.accountCode);
      const name = trim(line.account_name || line.accountName).toLowerCase();
      if (code && byNumber.has(code)) return byNumber.get(code);
      if (name && byName.has(name)) return byName.get(name);
      return null;
    }
  };
};

// Map a posted ledger journal to a QBO JournalEntry. Throws on: no postable
// lines, any unmapped account, or an unbalanced journal (debits != credits).
// When `existing` carries a QBO id + sync token, the body is shaped as an
// UPDATE (Id + SyncToken + sparse:false) — QBO replaces the entity.
export const buildQboJournalEntry = ({ journal = {}, lines = [], resolver, docNumber, existing = null } = {}) => {
  const postable = (Array.isArray(lines) ? lines : []).filter(
    (line) => line && (Number(line.debit) || Number(line.credit))
  );
  if (!postable.length) {
    throw writebackError('Ledger journal has no postable lines.', 'QBO_WRITEBACK_NO_LINES');
  }
  if (!resolver || !resolver.accountCount) {
    throw writebackError(
      'No QuickBooks accounts are synced for this client — run Sync before writeback.',
      'QBO_WRITEBACK_NO_ACCOUNTS'
    );
  }

  let debitTotal = 0;
  let creditTotal = 0;
  const unmapped = [];
  const qboLines = postable.map((line) => {
    const direction = trim(line.direction).toLowerCase() === 'credit' ? 'Credit' : 'Debit';
    const amount = money(direction === 'Debit' ? line.debit || line.amount : line.credit || line.amount);
    if (direction === 'Debit') debitTotal += amount;
    else creditTotal += amount;
    const match = resolver.resolve(line);
    if (!match) {
      unmapped.push({ account_code: line.account_code || null, account_name: line.account_name || null });
    }
    return {
      Description: trim(line.memo) || undefined,
      Amount: amount,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: direction,
        AccountRef: match ? { value: match.id } : undefined
      }
    };
  });

  if (unmapped.length) {
    throw writebackError(
      `No QuickBooks account matches ${unmapped.length} ledger line(s). Sync QuickBooks or align the account code/name.`,
      'QBO_WRITEBACK_UNMAPPED_ACCOUNT',
      { unmapped }
    );
  }
  if (Math.abs(money(debitTotal) - money(creditTotal)) >= 0.01) {
    throw writebackError(
      `Ledger journal does not balance (debits ${money(debitTotal)} vs credits ${money(creditTotal)}).`,
      'QBO_WRITEBACK_UNBALANCED'
    );
  }

  const journalEntry = {
    TxnDate: dateOnly(journal.journal_date) || undefined,
    DocNumber: docNumber ? String(docNumber).slice(0, QBO_DOC_NUMBER_MAX) : undefined,
    PrivateNote: trim(journal.memo) || undefined,
    Line: qboLines
  };
  const isUpdate = Boolean(existing?.qboJournalEntryId && existing?.syncToken != null);
  if (isUpdate) {
    journalEntry.Id = String(existing.qboJournalEntryId);
    journalEntry.SyncToken = String(existing.syncToken);
    journalEntry.sparse = false;
  }

  return {
    journal_entry: prune(journalEntry),
    summary: {
      lines: qboLines.length,
      debit_total: money(debitTotal),
      credit_total: money(creditTotal),
      doc_number: journalEntry.DocNumber || null,
      update: isUpdate
    }
  };
};

// Compare what we sent (expected) against what QBO currently holds (fetched).
// Mirrors buildXeroMirrorVerificationResult's shape: a per-journal result with a
// checks map and an ok/drift/missing/error status.
export const buildQboMirrorVerificationResult = ({ journalId = null, expected = {}, fetched = null, error = null } = {}) => {
  const qboJournalEntryId = expected.qboJournalEntryId || (fetched && fetched.id) || null;
  if (error) {
    return {
      journal_id: journalId,
      qbo_journal_entry_id: qboJournalEntryId,
      status: 'mirror_error',
      severity: 'warning',
      error: error.message || String(error),
      checks: {}
    };
  }
  if (!fetched || !fetched.id) {
    return {
      journal_id: journalId,
      qbo_journal_entry_id: qboJournalEntryId,
      status: 'mirror_missing',
      severity: 'warning',
      checks: { exists: false },
      expected
    };
  }
  const checks = {
    exists: true,
    line_count: !expected.lineCount || expected.lineCount === fetched.lineCount,
    amount: Math.abs((expected.total || 0) - (fetched.total || 0)) < 0.01,
    date: !expected.txnDate || expected.txnDate === fetched.txnDate
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    journal_id: journalId,
    qbo_journal_entry_id: fetched.id,
    status: ok ? 'mirror_ok' : 'mirror_drift',
    severity: 'warning',
    checks,
    expected,
    actual: { line_count: fetched.lineCount, total: fetched.total, date: fetched.txnDate }
  };
};
