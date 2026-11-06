// Donna ledger audit / correction workbench.
//
// A drill-in panel for an accountant to inspect the local-ledger state of a
// single transaction. Read-only on this surface — corrections are still
// initiated upstream (Reconcile workbench / Close panel) so this drawer is
// purely diagnostic.
//
// Data sources (prefer /ledger/audit-trail, with /firms/snapshot fallback):
//   - transaction          → source row context (date, description, amount,
//                            review_state, ledger_journal_id, xero_*)
//   - ledgerJournals[]     → posting metadata, posted_at, status, correction
//                            references (correction_of_journal_id,
//                            reversal_of_journal_id, correction_reason)
//   - ledgerLines[]        → per-line debit/credit/account splits
//   - ledgerAccounts[]     → for resolving account_label when a line did not
//                            cache it
//
// The drawer is intentionally honest about gaps: missing actor metadata,
// missing journal lines, no correction history — all rendered as muted
// empty states rather than fabricated content. "Donna ledger" is the
// primary lifecycle vocabulary; Xero appears only as the mirror chip.

import { useEffect, useMemo, useRef } from 'react';
import { T, D } from '../shared/design-tokens.js';

// ── helpers ─────────────────────────────────────────────────────────────────

const fmtMoney = (value, currency) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const ccy = currency || 'EUR';
  return `${ccy} ${n.toLocaleString('en-US', {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2
  })}`;
};

const fmtSignedMoney = (value, currency) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  const ccy = currency || 'EUR';
  return `${sign}${ccy} ${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2
  })}`;
};

const fmtDateTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const microLabel = {
  fontFamily: T.mono,
  fontSize: 10.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: T.muted
};

// Donna lifecycle status pill — never says "synced". Mirror state is rendered
// separately as a secondary chip.
const LEDGER_POSTED_META = {
  posted: { label: 'Posted to Donna ledger', fg: T.ok, bg: T.okSoft },
  pending: { label: 'Not yet posted', fg: T.amber, bg: T.amberSoft },
  voided: { label: 'Voided', fg: T.muted, bg: 'rgba(46,42,34,0.06)' }
};

const ledgerStatusFor = (transaction = {}, journal = null) => {
  if (journal?.status === 'voided') return 'voided';
  if (transaction?.ledger_journal_id || journal?.id) return 'posted';
  return 'pending';
};

// ── public component ────────────────────────────────────────────────────────

export default function LedgerAuditDrawer({
  open,
  transaction,
  ledgerAccounts = [],
  ledgerJournals = [],
  ledgerLines = [],
  status = 'ready', // 'loading' | 'ready' | 'error'
  errorMessage,
  onClose
} = {}) {
  // Esc-to-close + body scroll lock.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const closeButtonRef = useRef(null);
  useEffect(() => {
    if (open) closeButtonRef.current?.focus?.();
  }, [open]);

  // Derive the source journal — prefer the explicit ledger_journal_id, fall
  // back to a source_id match for unposted-but-known cases.
  const sourceJournal = useMemo(() => {
    if (!transaction) return null;
    if (transaction.ledger_journal_id) {
      return ledgerJournals.find((j) => j.id === transaction.ledger_journal_id) || null;
    }
    return ledgerJournals.find(
      (j) => j.source_type === 'transaction' && j.source_id === transaction.id
    ) || null;
  }, [transaction, ledgerJournals]);

  // All journals related to this transaction — the source journal plus any
  // corrections / reversals that point at it. Sorted by journal_date so the
  // accountant reads chronologically.
  const relatedJournals = useMemo(() => {
    if (!transaction) return [];
    const sourceIds = new Set();
    if (sourceJournal?.id) sourceIds.add(sourceJournal.id);
    const set = new Map();
    if (sourceJournal) set.set(sourceJournal.id, sourceJournal);
    for (const journal of ledgerJournals) {
      const refs = [journal.correction_of_journal_id, journal.reversal_of_journal_id].filter(Boolean);
      const isCorrection = refs.some((id) => sourceIds.has(id));
      const sharesSource =
        sourceJournal?.source_type &&
        journal.source_type === sourceJournal.source_type &&
        journal.source_id === sourceJournal.source_id;
      if (isCorrection || sharesSource) set.set(journal.id, journal);
    }
    return Array.from(set.values()).sort((a, b) => {
      const ad = a.journal_date || a.posted_at || '';
      const bd = b.journal_date || b.posted_at || '';
      return String(ad).localeCompare(String(bd)) || String(a.id || '').localeCompare(String(b.id || ''));
    });
  }, [transaction, ledgerJournals, sourceJournal]);

  const accountsById = useMemo(() => new Map(ledgerAccounts.map((a) => [a.id, a])), [ledgerAccounts]);

  if (!open) return null;

  const ledgerStatus = ledgerStatusFor(transaction || {}, sourceJournal);
  const ledgerMeta = LEDGER_POSTED_META[ledgerStatus] || LEDGER_POSTED_META.pending;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Donna ledger audit trail"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 950,
        display: 'flex',
        justifyContent: 'flex-end',
        background: 'rgba(46,42,34,0.34)'
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <aside
        style={{
          width: 'min(720px, 100vw)',
          height: '100%',
          background: D.paper,
          color: T.ink,
          fontFamily: T.sans,
          boxShadow: '-8px 0 32px rgba(46,42,34,0.18)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* Header */}
        <header
          style={{
            position: 'sticky',
            top: 0,
            background: D.paper,
            borderBottom: `1px solid ${T.ruleSoft}`,
            padding: '20px 24px 14px',
            zIndex: 1
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={microLabel}>Donna ledger · audit trail</div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => onClose?.()}
              aria-label="Close audit trail"
              style={{
                font: 'inherit',
                fontSize: 13,
                padding: '4px 12px',
                borderRadius: 6,
                border: `1px solid ${T.rule}`,
                background: T.card,
                color: T.inkSoft,
                cursor: 'pointer'
              }}
            >
              Close
            </button>
          </div>
          {transaction && (
            <div style={{ marginTop: 6, fontSize: 16, color: T.ink, fontWeight: 600, lineHeight: 1.35 }}>
              {transaction.description || transaction.desc || 'Transaction'}
            </div>
          )}
          {transaction && (
            <div
              style={{
                marginTop: 4,
                fontFamily: T.mono,
                fontSize: 12,
                color: T.muted,
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap'
              }}
            >
              <span>{transaction.transaction_date || transaction.date || '—'}</span>
              <span>
                {fmtSignedMoney(
                  transaction.amount ?? transaction.signed_amount,
                  transaction.account_currency || transaction.currency || 'EUR'
                )}
              </span>
              {transaction.id && <span>tx {String(transaction.id).slice(0, 10)}</span>}
            </div>
          )}
        </header>

        <div style={{ padding: '18px 24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {status === 'loading' && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: T.muted, fontSize: 13 }}>
              Loading ledger detail…
            </div>
          )}
          {status === 'error' && (
            <div
              style={{
                padding: '12px 14px',
                background: T.alertSoft,
                color: T.alert,
                borderRadius: 8,
                fontSize: 12.5
              }}
            >
              {errorMessage || 'Could not load ledger detail for this transaction.'}
            </div>
          )}

          {/* Source / posting context */}
          <Section label="Donna ledger status">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 11,
                  padding: '3px 9px',
                  borderRadius: 999,
                  background: ledgerMeta.bg,
                  color: ledgerMeta.fg,
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em'
                }}
              >
                {ledgerMeta.label}
              </span>
              {sourceJournal?.id && (
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.mutedSoft }}>
                  journal {String(sourceJournal.id).slice(0, 12)}
                </span>
              )}
            </div>
            <KvGrid>
              <Kv k="Posted at" v={fmtDateTime(sourceJournal?.posted_at) || '—'} />
              <Kv k="Journal date" v={sourceJournal?.journal_date || '—'} />
              <Kv k="Period" v={(transaction?.transaction_date || transaction?.date) ? String(transaction.transaction_date || transaction.date).slice(0, 7) : '—'} />
              <Kv k="Currency" v={sourceJournal?.currency || transaction?.account_currency || transaction?.currency || '—'} />
              <Kv k="Source type" v={sourceJournal?.source_type || (transaction ? 'transaction' : '—')} />
              <Kv k="Reviewer" v={sourceJournal?.posted_by || sourceJournal?.created_by || sourceJournal?.payload?.actor_id || '—'} />
            </KvGrid>
            {/* Xero rendered explicitly as mirror, never as primary state. */}
            {(transaction?.xero_bank_transaction_id || sourceJournal?.payload?.xero_mirror_status) && (
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(46,42,34,0.04)',
                  fontSize: 12,
                  color: T.muted,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap'
                }}
              >
                <span style={microLabel}>Xero mirror</span>
                {transaction?.xero_bank_transaction_id && (
                  <span style={{ fontFamily: T.mono, fontSize: 11 }}>
                    {String(transaction.xero_bank_transaction_id).slice(0, 12)}
                  </span>
                )}
                {sourceJournal?.payload?.xero_mirror_status && (
                  <span style={{ fontFamily: T.mono, fontSize: 11 }}>
                    status {sourceJournal.payload.xero_mirror_status}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>mirror copy only</span>
              </div>
            )}
          </Section>

          {/* Journal lines for the source posting */}
          <Section label="Journal lines">
            {!sourceJournal && (
              <EmptyHint>
                No Donna ledger posting found for this transaction yet.
              </EmptyHint>
            )}
            {sourceJournal && (
              <JournalLinesTable
                journal={sourceJournal}
                lines={ledgerLines.filter((line) => line.journal_id === sourceJournal.id)}
                accountsById={accountsById}
              />
            )}
          </Section>

          {/* Correction / reversal history */}
          <Section
            label="Correction history"
            sub="Immutable trail · adjustments and reversals targeting this posting"
          >
            <CorrectionList
              sourceJournal={sourceJournal}
              relatedJournals={relatedJournals}
              ledgerLines={ledgerLines}
              accountsById={accountsById}
            />
          </Section>
        </div>
      </aside>
    </div>
  );
}

// ── sub-components ──────────────────────────────────────────────────────────

function Section({ label, sub, children }) {
  return (
    <section
      style={{
        background: T.card,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: 18
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <div style={microLabel}>{label}</div>
        {sub && <div style={{ fontSize: 11.5, color: T.mutedSoft, marginTop: 3 }}>{sub}</div>}
      </div>
      {children}
    </section>
  );
}

function KvGrid({ children }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 10
      }}
    >
      {children}
    </div>
  );
}

function Kv({ k, v }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {k}
      </span>
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 12.5,
          color: T.inkSoft,
          fontVariantNumeric: 'tabular-nums',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
        title={typeof v === 'string' ? v : undefined}
      >
        {v}
      </span>
    </div>
  );
}

function EmptyHint({ children }) {
  return (
    <div style={{ padding: '8px 0', fontSize: 13, color: T.muted, lineHeight: 1.5 }}>{children}</div>
  );
}

function JournalLinesTable({ journal, lines, accountsById }) {
  if (!lines || lines.length === 0) {
    return (
      <EmptyHint>
        Journal {String(journal.id || '').slice(0, 12)} exists but its lines are not in the
        loaded snapshot. Reload the firm snapshot to pull line detail.
      </EmptyHint>
    );
  }
  // Stable ordering: by line_no, then by id.
  const ordered = [...lines].sort(
    (a, b) =>
      (Number(a.line_no || 0) - Number(b.line_no || 0)) ||
      String(a.id || '').localeCompare(String(b.id || ''))
  );
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of ordered) {
    totalDebit += Number(line.debit || 0);
    totalCredit += Number(line.credit || 0);
  }
  const balanced = Math.abs(totalDebit - totalCredit) < 0.005;
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 520, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            gap: 12,
            padding: '6px 0',
            borderBottom: `1px solid ${T.ruleSoft}`,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: T.mutedSoft
          }}
        >
          <span style={{ flex: '0 0 32px', textAlign: 'right' }}>#</span>
          <span style={{ flex: '1 1 220px', minWidth: 0 }}>Account</span>
          <span style={{ flex: '0 0 96px', textAlign: 'right' }}>Debit</span>
          <span style={{ flex: '0 0 96px', textAlign: 'right' }}>Credit</span>
        </div>
        {ordered.map((line, i) => {
          const account = line.account_id ? accountsById.get(line.account_id) : null;
          const label =
            line.account_label ||
            account?.account_label ||
            (line.account_code && line.account_name
              ? `${line.account_code} · ${line.account_name}`
              : line.account_name || line.account_code || account?.name || '—');
          return (
            <div
              key={line.id || `${journal.id}-${i}`}
              style={{
                display: 'flex',
                gap: 12,
                padding: '8px 0',
                borderBottom: i === ordered.length - 1 ? 'none' : `1px solid ${T.ruleMicro}`,
                alignItems: 'center',
                fontSize: 12.5,
                color: T.inkSoft
              }}
            >
              <span style={{ flex: '0 0 32px', textAlign: 'right', fontFamily: T.mono, color: T.muted }}>
                {line.line_no ?? i + 1}
              </span>
              <span
                style={{
                  flex: '1 1 220px',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                title={label}
              >
                <span style={{ color: T.ink }}>{label}</span>
                {line.memo && (
                  <span style={{ marginLeft: 8, fontFamily: T.mono, fontSize: 11, color: T.mutedSoft }}>
                    {line.memo}
                  </span>
                )}
              </span>
              <span style={{ flex: '0 0 96px', textAlign: 'right', fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' }}>
                {Number(line.debit || 0) === 0 ? '—' : fmtMoney(line.debit, line.currency || journal.currency)}
              </span>
              <span style={{ flex: '0 0 96px', textAlign: 'right', fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' }}>
                {Number(line.credit || 0) === 0 ? '—' : fmtMoney(line.credit, line.currency || journal.currency)}
              </span>
            </div>
          );
        })}
        <div
          style={{
            display: 'flex',
            gap: 12,
            padding: '8px 0 0',
            borderTop: `1px solid ${T.ruleSoft}`,
            marginTop: 4,
            fontFamily: T.mono,
            fontSize: 12,
            color: balanced ? T.muted : T.alert
          }}
        >
          <span style={{ flex: '0 0 32px' }} />
          <span style={{ flex: '1 1 220px' }}>{balanced ? 'Balanced' : 'Imbalance'}</span>
          <span style={{ flex: '0 0 96px', textAlign: 'right' }}>{fmtMoney(totalDebit, journal.currency)}</span>
          <span style={{ flex: '0 0 96px', textAlign: 'right' }}>{fmtMoney(totalCredit, journal.currency)}</span>
        </div>
      </div>
    </div>
  );
}

function CorrectionList({ sourceJournal, relatedJournals, ledgerLines, accountsById }) {
  if (!sourceJournal) {
    return <EmptyHint>No corrections — this transaction has no Donna ledger posting yet.</EmptyHint>;
  }
  // Filter out the source journal itself; only show subsequent corrections
  // / reversals.
  const corrections = relatedJournals.filter((journal) => journal.id !== sourceJournal.id);
  if (corrections.length === 0) {
    return (
      <EmptyHint>
        No corrections recorded. The original posting from {fmtDateTime(sourceJournal.posted_at) || sourceJournal.journal_date || 'unknown date'}{' '}
        is the latest entry on the Donna ledger for this transaction.
      </EmptyHint>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {corrections.map((journal) => (
        <CorrectionEntry
          key={journal.id}
          journal={journal}
          lines={ledgerLines.filter((line) => line.journal_id === journal.id)}
          accountsById={accountsById}
        />
      ))}
    </div>
  );
}

function CorrectionEntry({ journal, lines, accountsById }) {
  const isReversal =
    journal.correction_type === 'reversal' || journal.reversal_of_journal_id;
  const tint = isReversal ? T.alert : T.amber;
  const tintBg = isReversal ? T.alertSoft : T.amberSoft;
  const label = isReversal
    ? 'Reversal'
    : journal.correction_type === 'replacement'
      ? 'Replacement'
      : 'Adjustment';
  return (
    <div
      style={{
        borderLeft: `3px solid ${tint}`,
        background: 'rgba(255,254,249,0.6)',
        borderRadius: 8,
        padding: '12px 14px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 10.5,
            padding: '2px 8px',
            borderRadius: 999,
            background: tintBg,
            color: tint,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em'
          }}
        >
          {label}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>
          {fmtDateTime(journal.posted_at) || journal.journal_date || '—'}
        </span>
        {journal.id && (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.mutedSoft }}>
            journal {String(journal.id).slice(0, 12)}
          </span>
        )}
        {(journal.correction_of_journal_id || journal.reversal_of_journal_id) && (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.mutedSoft }}>
            → {String(journal.reversal_of_journal_id || journal.correction_of_journal_id).slice(0, 12)}
          </span>
        )}
      </div>
      {journal.correction_reason && (
        <div style={{ fontSize: 13, color: T.ink, marginBottom: 8, lineHeight: 1.5 }}>
          {journal.correction_reason}
        </div>
      )}
      {!journal.correction_reason && (
        <div style={{ fontSize: 12.5, color: T.mutedSoft, marginBottom: 8, fontStyle: 'italic' }}>
          No reason recorded for this correction.
        </div>
      )}
      <JournalLinesTable journal={journal} lines={lines} accountsById={accountsById} />
    </div>
  );
}
