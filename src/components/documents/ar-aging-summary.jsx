// AR aging summary — scannable strip above the sales-invoice
// sub-table. Renders one row of bucket chips per currency.
//
// PR 17 — chips are click-to-filter. When the parent supplies
// `onSelectBucket`, a click on a populated chip filters the
// sub-table below to just the invoices in that bucket; clicking
// the active chip clears the filter. Empty buckets stay
// non-clickable — filtering to an empty list has no value.

import { T } from '../shared/design-tokens.js';
import {
  AR_AGING_BUCKETS,
  AR_AGING_BUCKET_LABELS,
  AR_AGING_BUCKET_TONES,
  hasOutstandingAr
} from '../../lib/arAging.js';

const TONE_STYLES = {
  ok: { background: T.okSoft, color: T.ok, border: `1px solid ${T.ok}` },
  amber: { background: T.amberSoft, color: T.amber, border: `1px solid ${T.amber}` },
  alert: { background: T.alertSoft, color: T.alert, border: `1px solid ${T.alert}` },
  muted: { background: T.ruleSoft, color: T.muted, border: `1px solid ${T.rule}` }
};

const chipStyleFor = (tone, { isClickable, isActive }) => ({
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 4,
  padding: '8px 12px',
  borderRadius: 8,
  minWidth: 96,
  cursor: isClickable ? 'pointer' : 'default',
  // Reset native button styling when the chip renders as a button.
  font: 'inherit',
  textAlign: 'left',
  // Active selection — thicker border + subtle inset shadow halo so
  // the active bucket reads as "selected" without changing tone hue.
  boxShadow: isActive ? `inset 0 0 0 2px ${T.ink}` : 'none',
  outline: 'none',
  ...(TONE_STYLES[tone] || TONE_STYLES.muted)
});

const formatAmount = (amount, currency) => {
  if (!Number.isFinite(amount)) return '—';
  const code = currency && currency !== 'UNKNOWN' ? currency : null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code || 'USD',
      currencyDisplay: code ? 'code' : 'symbol',
      maximumFractionDigits: 0
    }).format(Number(amount));
  } catch {
    return `${code ? `${code} ` : ''}${Number(amount).toFixed(0)}`;
  }
};

const BucketChip = ({ bucket, slot, currency, activeBucket, onSelectBucket }) => {
  const label = AR_AGING_BUCKET_LABELS[bucket];
  const tone = AR_AGING_BUCKET_TONES[bucket];
  const isEmpty = slot.count === 0;
  const isClickable = !isEmpty && typeof onSelectBucket === 'function';
  const isActive = isClickable && activeBucket === bucket;
  const effectiveTone = isEmpty ? 'muted' : tone;
  const style = chipStyleFor(effectiveTone, { isClickable, isActive });

  const children = (
    <>
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 9,
          fontWeight: 800,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          opacity: isEmpty ? 0.6 : 1
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 16,
          fontWeight: 800,
          color: isEmpty ? T.muted : 'currentColor'
        }}
      >
        {slot.count}
      </span>
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          color: isEmpty ? T.muted : 'currentColor',
          opacity: isEmpty ? 0.7 : 0.85
        }}
      >
        {isEmpty ? '—' : formatAmount(slot.outstandingAmount, currency)}
      </span>
    </>
  );

  if (isClickable) {
    return (
      <button
        type="button"
        style={style}
        aria-label={`Filter by ${label}: ${slot.count} invoices`}
        aria-pressed={isActive}
        onClick={() => onSelectBucket(isActive ? null : bucket)}
      >
        {children}
      </button>
    );
  }
  return (
    <div style={style} aria-label={`${label}: ${slot.count} invoices`}>
      {children}
    </div>
  );
};

const CurrencyStrip = ({ currency, slice, activeBucket, onSelectBucket }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: '14px 24px',
      borderBottom: `1px solid ${T.ruleSoft}`
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 16
      }}
    >
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          fontWeight: 800,
          color: T.muted,
          textTransform: 'uppercase',
          letterSpacing: '0.06em'
        }}
      >
        Outstanding · {currency === 'UNKNOWN' ? 'No currency' : currency}
      </span>
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 12,
          fontWeight: 700,
          color: T.ink
        }}
      >
        {slice.totals.count} invoice{slice.totals.count === 1 ? '' : 's'}
        {' · '}
        {formatAmount(slice.totals.outstandingAmount, currency)}
      </span>
    </div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {AR_AGING_BUCKETS.map((bucket) => (
        <BucketChip
          key={bucket}
          bucket={bucket}
          slot={slice.buckets[bucket]}
          currency={currency}
          activeBucket={activeBucket}
          onSelectBucket={onSelectBucket}
        />
      ))}
    </div>
  </div>
);

const ActiveFilterBar = ({ activeBucket, onClear }) => {
  if (!activeBucket || typeof onClear !== 'function') return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 24px',
        background: T.accentSoft,
        borderBottom: `1px solid ${T.rule}`,
        fontFamily: T.mono,
        fontSize: 11,
        color: T.ink
      }}
    >
      <span style={{ fontWeight: 700 }}>
        Filtering invoices: {AR_AGING_BUCKET_LABELS[activeBucket]}
      </span>
      <button
        type="button"
        onClick={() => onClear()}
        style={{
          marginLeft: 'auto',
          padding: '4px 10px',
          borderRadius: 6,
          border: `1px solid ${T.rule}`,
          background: T.paper,
          color: T.ink,
          fontFamily: T.mono,
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          cursor: 'pointer'
        }}
      >
        Clear
      </button>
    </div>
  );
};

const ArAgingSummary = ({ aging, activeBucket = null, onSelectBucket = null }) => {
  if (!hasOutstandingAr(aging)) return null;

  return (
    <section
      aria-label="Sales invoices — aging"
      style={{
        background: T.paper,
        borderBottom: `1px solid ${T.rule}`
      }}
    >
      <div
        style={{
          padding: '16px 24px 4px',
          fontFamily: T.serif,
          fontSize: 16,
          color: T.ink
        }}
      >
        Aging
        <span
          style={{
            marginLeft: 10,
            fontFamily: T.mono,
            fontSize: 10,
            fontWeight: 700,
            color: T.muted,
            textTransform: 'uppercase',
            letterSpacing: '0.06em'
          }}
        >
          as of {aging.today}
        </span>
      </div>
      {aging.currencies.map((currency) => (
        <CurrencyStrip
          key={currency}
          currency={currency}
          slice={aging.byCurrency[currency]}
          activeBucket={activeBucket}
          onSelectBucket={onSelectBucket}
        />
      ))}
      <ActiveFilterBar
        activeBucket={activeBucket}
        onClear={onSelectBucket ? () => onSelectBucket(null) : null}
      />
    </section>
  );
};

export default ArAgingSummary;
