// FI-5 UI — surface the persisted tositenumero (the gap-free Finnish statutory
// voucher number, ledger_journals.tosite_number) on the mounted close panel.
//
// Pure helpers so the display logic is unit-tested without JSX — this repo tests
// logic under src/lib, never components. render-the-persisted-verdict: we render
// the number the FI-5 pipeline PERSISTED (allocateTositeNumberTx), never a
// UI-inferred one. The number is null on flag-off / pre-FI-5 journals; callers
// fall back to the existing journal-id display, so behaviour is unchanged there.

// A positive-integer tositenumero, or null. Guards '', 0, negatives, NaN, floats.
export const asTositeNumber = (value) => (Number.isInteger(value) && value > 0 ? value : null);

// Build a ledger_journal_id -> tosite_number index over a ledgerJournals snapshot
// array (the shape the firm snapshot ships to the panels). Journals without a
// number (flag off / pre-FI-5) are simply absent from the index.
export const buildTositeIndex = (ledgerJournals = []) => {
  const index = new Map();
  if (!Array.isArray(ledgerJournals)) return index;
  for (const journal of ledgerJournals) {
    const n = asTositeNumber(journal?.tosite_number);
    if (journal?.id && n != null) index.set(journal.id, n);
  }
  return index;
};

// The tosite for a posted row, looked up by its ledger_journal_id. null when the
// journal has no number yet (or the index is missing) — never throws.
export const tositeForJournalId = (ledgerJournalId, tositeIndex) => {
  if (!ledgerJournalId || !(tositeIndex instanceof Map)) return null;
  return tositeIndex.get(ledgerJournalId) ?? null;
};

// 'Tosite #5', or null when there is no valid number.
export const formatTositeLabel = (tositeNumber) => {
  const n = asTositeNumber(tositeNumber);
  return n == null ? null : `Tosite #${n}`;
};

// The 'Posted to Donna ledger' step detail: prefer the statutory voucher number,
// else the existing journal-id / 'Posted' fallback (byte-identical when off).
export const postedLedgerDetail = ({ tositeNumber, ledgerJournalId } = {}) =>
  formatTositeLabel(tositeNumber) || ledgerJournalId || 'Posted';
