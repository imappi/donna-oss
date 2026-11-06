// Procountor writeback builder — pure (no DB, no network). Mirrors a Donna
// ledger journal (double-entry: ledger_journals + ledger_lines) to a Procountor
// ledger receipt of type JOURNAL (POST /api/ledgerreceipts), line-for-line.
// firmDb loads the journal/lines/accounts and persists what these return.
//
// THE SIGN CONVENTION IS VALIDATED, NOT GUESSED. Procountor represents each
// accounting row as ONE signed `accountingValue` (not a QBO-style
// PostingType:Debit/Credit). A live probe against the pilot client's test company on
// 2026-07-09 confirmed: DEBIT = POSITIVE accountingValue, CREDIT = NEGATIVE,
// and a balanced pair (signed sum == 0) is accepted. See
// docs/procountor-live-writeback-runbook.md §"Step 0e — LIVE SAMPLE".
//
// A JOURNAL receipt also requires VAT fields the probe surfaced: receipt-level
// vatType (PURCHASE|SALES) + vatStatus (int), and per-row vatPercent. For a
// pure internal journal we send vatType PURCHASE + vatStatus 1 + vatPercent 0,
// which computes zero VAT regardless. Account mapping is resolve-at-writeback
// (match each line's account code against the synced procountor_accounts) —
// an unmapped line is a hard error, exactly like the QBO builder.

import { DONNA_TO_PROCOUNTOR_LEDGER } from './procountorCoaMapping.js';
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

// A VAT-free internal journal: PURCHASE + vatStatus 1 + per-row vatPercent 0
// (validated). vatType is required and only takes PURCHASE|SALES; with
// vatPercent 0 the receipt is VAT-neutral either way.
export const PROCOUNTOR_JOURNAL_VAT_TYPE = 'PURCHASE';
export const PROCOUNTOR_JOURNAL_VAT_STATUS = 1;
// Procountor's receipt `name` is free text; cap it so a long memo can't be
// rejected. 100 is comfortably within the field limit.
export const PROCOUNTOR_RECEIPT_NAME_MAX = 100;

const writebackError = (message, code = 'PROCOUNTOR_WRITEBACK_INVALID_PAYLOAD', details) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  if (details) error.details = details;
  return error;
};

// Drop undefined keys so optional fields (description, partnerId, …) don't ride
// along as nulls. JSON round-trip drops object undefined values cleanly.
const prune = (object) => JSON.parse(JSON.stringify(object));

// Build a ledger-account → Procountor-account resolver from synced
// procountor_accounts rows (accepts snake_case DB rows or normalized
// camelCase). Procountor's account identifier IS the ledger account CODE.
// Resolve order:
//   1. Finnish-model correspondence — map the Donna ledger code into the
//      standard Finnish chart (DONNA_TO_PROCOUNTOR_LEDGER) and resolve THAT
//      against the synced chart. This is the load-bearing path for Procountor:
//      its Finnish statutory codes never coincide with Donna's, and its chart is
//      read-only over the API so we can't provision Donna's chart in (the Xero
//      move). See procountorCoaMapping.js.
//   2. Direct code match — a Donna code that already IS a Finnish code.
//   3. Case-folded name match (fi/en/sv) — last resort.
export const buildProcountorLedgerAccountResolver = (procountorAccounts = []) => {
  const byCode = new Map();
  const byName = new Map();
  for (const account of Array.isArray(procountorAccounts) ? procountorAccounts : []) {
    const code = trim(account.ledger_account_code || account.ledgerAccountCode);
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, { code, account });
    for (const nameField of [account.name, account.name_en, account.nameEn, account.name_sv, account.nameSv]) {
      const name = trim(nameField).toLowerCase();
      if (name && !byName.has(name)) byName.set(name, { code, account });
    }
  }
  return {
    accountCount: byCode.size,
    resolve: (line = {}) => {
      const code = trim(line.account_code || line.accountCode);
      const name = trim(line.account_name || line.accountName).toLowerCase();
      const mappedCode = code ? DONNA_TO_PROCOUNTOR_LEDGER[code] : '';
      if (mappedCode && byCode.has(mappedCode)) return { ...byCode.get(mappedCode), mappedFrom: code };
      if (code && byCode.has(code)) return byCode.get(code);
      if (name && byName.has(name)) return byName.get(name);
      return null;
    }
  };
};

// Map a posted ledger journal to a Procountor ledger receipt (type JOURNAL).
// Throws on: no postable lines, any unmapped account, or an unbalanced journal
// (debits != credits). When `existing` carries a receipt id + version, the
// body includes `version` so the caller can PUT it as an update (Procountor's
// optimistic-concurrency token).
export const buildProcountorLedgerReceipt = ({ journal = {}, lines = [], resolver, docNumber, existing = null } = {}) => {
  const postable = (Array.isArray(lines) ? lines : []).filter(
    (line) => line && (Number(line.debit) || Number(line.credit) || Number(line.amount))
  );
  if (!postable.length) {
    throw writebackError('Ledger journal has no postable lines.', 'PROCOUNTOR_WRITEBACK_NO_LINES');
  }
  if (!resolver || !resolver.accountCount) {
    throw writebackError(
      'No Procountor accounts are synced for this client — run Sync before writeback.',
      'PROCOUNTOR_WRITEBACK_NO_ACCOUNTS'
    );
  }

  let debitTotal = 0;
  let creditTotal = 0;
  const unmapped = [];
  const transactions = postable.map((line) => {
    const direction = trim(line.direction).toLowerCase() === 'credit' ? 'credit' : 'debit';
    const magnitude = money(direction === 'debit' ? (line.debit || line.amount) : (line.credit || line.amount));
    if (direction === 'debit') debitTotal += magnitude;
    else creditTotal += magnitude;
    // Validated sign map: debit → +magnitude, credit → −magnitude.
    const accountingValue = direction === 'debit' ? magnitude : -magnitude;
    const match = resolver.resolve(line);
    if (!match) {
      unmapped.push({ account_code: line.account_code || null, account_name: line.account_name || null });
    }
    return {
      transactionType: 'ENTRY',
      account: match ? match.code : undefined,
      accountingValue,
      vatPercent: 0,
      description: trim(line.memo) || undefined
    };
  });

  if (unmapped.length) {
    throw writebackError(
      `No Procountor account matches ${unmapped.length} ledger line(s). Sync Procountor or align the account code/name.`,
      'PROCOUNTOR_WRITEBACK_UNMAPPED_ACCOUNT',
      { unmapped }
    );
  }
  if (Math.abs(money(debitTotal) - money(creditTotal)) >= 0.01) {
    throw writebackError(
      `Ledger journal does not balance (debits ${money(debitTotal)} vs credits ${money(creditTotal)}).`,
      'PROCOUNTOR_WRITEBACK_UNBALANCED'
    );
  }

  const name = (trim(journal.memo) || `Donna export ${docNumber || ''}`.trim()).slice(0, PROCOUNTOR_RECEIPT_NAME_MAX);
  const ledgerReceipt = {
    type: 'JOURNAL',
    name: name || undefined,
    receiptDate: dateOnly(journal.journal_date) || undefined,
    vatType: PROCOUNTOR_JOURNAL_VAT_TYPE,
    vatStatus: PROCOUNTOR_JOURNAL_VAT_STATUS,
    transactionDescription: trim(journal.memo) || (docNumber ? `Donna export ${docNumber}` : undefined),
    transactions
  };
  // Update lane: echo the concurrency token so PUT /ledgerreceipts/{id} accepts
  // the write (a stale/absent version is rejected by Procountor).
  const isUpdate = Boolean(existing?.procountorReceiptId && existing?.version);
  if (isUpdate) ledgerReceipt.version = String(existing.version);

  return {
    ledger_receipt: prune(ledgerReceipt),
    summary: {
      lines: transactions.length,
      debit_total: money(debitTotal),
      credit_total: money(creditTotal),
      receipt_date: ledgerReceipt.receiptDate || null,
      name: ledgerReceipt.name || null,
      update: isUpdate
    }
  };
};

// Compare what we sent (expected) against what Procountor currently holds
// (fetched). Mirrors buildQboMirrorVerificationResult's shape: a per-journal
// result with a checks map and an ok/drift/missing/error status.
export const buildProcountorMirrorVerificationResult = ({ journalId = null, expected = {}, fetched = null, error = null } = {}) => {
  const procountorReceiptId = expected.procountorReceiptId || (fetched && fetched.id) || null;
  if (error) {
    return {
      journal_id: journalId,
      procountor_receipt_id: procountorReceiptId,
      status: 'mirror_error',
      severity: 'warning',
      error: error.message || String(error),
      checks: {}
    };
  }
  if (!fetched || !fetched.id) {
    return {
      journal_id: journalId,
      procountor_receipt_id: procountorReceiptId,
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
    date: !expected.receiptDate || expected.receiptDate === fetched.receiptDate
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    journal_id: journalId,
    procountor_receipt_id: fetched.id,
    status: ok ? 'mirror_ok' : 'mirror_drift',
    severity: 'warning',
    checks,
    expected,
    actual: { line_count: fetched.lineCount, total: fetched.total, date: fetched.receiptDate }
  };
};
