import { T, D } from '../shared/design-tokens.js';
import {
  BANK_FEED_DATE_STYLE,
  BANK_FEED_DOT_STYLE,
  BANK_FEED_LIST_MEASURE,
  BANK_FEED_PRIMARY_STYLE,
  BANK_FEED_ROW_STYLE,
  BANK_FEED_SECTION_COUNT_STYLE,
  BANK_FEED_SECTION_HEADING_STYLE,
  BANK_FEED_SECTION_STYLE,
  BANK_FEED_STATUS_STYLE,
  BANK_FEED_TRAILING_CELL_STYLE,
  bankFeedPillStyle
} from '../shared/bank-feed-list-style.js';
import { FEED_ROW_HOVER_CSS } from '../shared/feed-list.jsx';

// C2b (as amended by Kari's 2026-08-26 canary feedback): the Period close
// section on Actions is PURE list grammar — the same wff-row shape every
// other feed row uses, no inline controls, no expanding card. Activating a
// row (click, or Enter/Space — it is a native button) opens the
// close-period work artifact in the right rail; ALL work (checks, run /
// post / lock, evidence review) lives there. This module renders the
// console-derived persisted inventory and fetches nothing.

const STATUS_META = {
  ready: { label: 'Ready to lock', pill: 'ink' },
  review: { label: 'Review needed', pill: 'warm' },
  blocked: { label: 'Blocked', pill: 'warm' },
  unchecked: { label: 'Not checked', pill: 'muted' }
};


// The dot speaks the feed's language: warm = needs attention before close,
// ink = the owner's decision is available, outline = not yet engaged.
const dotStyleFor = (status) => {
  if (status === 'ready') return { background: T.ink, border: 'none' };
  if (status === 'unchecked') return { background: 'transparent', border: `1.5px solid ${T.mutedSoft}` };
  return { background: D.accentWarmFlat, border: 'none' };
};

const shortMonth = (period) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(period?.monthKey || ''));
  if (!m) return '';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const midColumnFor = (period) => {
  if (period.status === 'unchecked') {
    return period.transactionCount != null ? `${period.transactionCount} tx` : '';
  }
  const counts = period.counts || {};
  const unposted = Number(counts.unposted || 0);
  const waiting = Number(counts.waiting || 0) + Number(counts.asked_client || 0) + Number(counts.held || 0);
  if (unposted) return `${unposted} to post`;
  if (waiting) return `${waiting} waiting`;
  return '';
};

const CloseActionRows = ({ periods = [], onOpenPeriod }) => {
  if (!Array.isArray(periods) || periods.length === 0) return null;
  return (
    // Same measure/inset as the sibling Actions sections (AskBatchPanel,
    // OutboundOwnerActions each self-cap at the shared 1080 list measure
    // inside the console's wider wrapper) — Kari's 2026-08-26 walkthrough
    // caught these rows spanning the full workspace width.
    <section style={{ ...BANK_FEED_SECTION_STYLE, width: '100%', maxWidth: BANK_FEED_LIST_MEASURE, margin: '0 auto' }}>
      <style>{FEED_ROW_HOVER_CSS}</style>
      <div style={BANK_FEED_SECTION_HEADING_STYLE}>
        Period close
        <span style={BANK_FEED_SECTION_COUNT_STYLE}>{periods.length}</span>
      </div>
      {periods.map((period) => {
        const meta = STATUS_META[period.status] || STATUS_META.review;
        return (
          <button
            key={`${period.periodStart}:${period.periodEnd}`}
            type="button"
            className="wff-row"
            onClick={() => onOpenPeriod?.(period)}
            style={{
              border: 'none',
              ...BANK_FEED_ROW_STYLE,
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              width: '100%'
            }}
          >
            <span aria-hidden="true" style={{ ...BANK_FEED_DOT_STYLE, ...dotStyleFor(period.status) }} />
            <span style={BANK_FEED_DATE_STYLE}>{shortMonth(period)}</span>
            <span
              style={{
                ...BANK_FEED_PRIMARY_STYLE,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              Period close — {period.label}
            </span>
            <span style={{ ...BANK_FEED_STATUS_STYLE, textAlign: 'right', ...D.tabular }}>
              {midColumnFor(period)}
            </span>
            <span style={{ ...BANK_FEED_TRAILING_CELL_STYLE, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end' }}>
              <span style={bankFeedPillStyle(meta.pill)}>{meta.label}</span>
            </span>
          </button>
        );
      })}
    </section>
  );
};

export default CloseActionRows;
