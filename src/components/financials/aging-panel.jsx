// AR/AP aging — the ⋯ read view on Material (two-surface IA stage D; Kari's
// pick, 2026-08-26: a small glanceable read view on the feed, not chat-only).
// This re-homes the ONE read surface the Documents tab uniquely carried
// (design record §3): the same ArAgingSummary/ApAgingSummary strips over the
// same persisted inbox derivation — render-the-persisted-verdict, no new
// arithmetic, no inference. Bucket chips stay click-to-filter; a selected
// bucket lists its documents below and a row click opens the same right-side
// document artifact every other surface opens.

import { useMemo, useState } from 'react';

import { T } from '../shared/design-tokens.js';
import { buildDocumentInbox } from '../../lib/documentsInbox.js';
import { buildArAging, invoiceIdsInBucket, hasOutstandingAr } from '../../lib/arAging.js';
import { buildApAging, billIdsInBucket, hasOutstandingAp } from '../../lib/apAging.js';
import ArAgingSummary from '../documents/ar-aging-summary.jsx';
import ApAgingSummary from '../documents/ap-aging-summary.jsx';

const formatAmount = (amount, currency) => {
  if (!Number.isFinite(amount)) return '—';
  const code = currency && currency !== 'UNKNOWN' ? currency : null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code || 'USD',
      currencyDisplay: code ? 'code' : 'symbol',
      maximumFractionDigits: 2
    }).format(Number(amount));
  } catch {
    return `${code ? `${code} ` : ''}${Number(amount).toFixed(2)}`;
  }
};

const BucketDocList = ({ rows, onOpenDocument }) => (
  <div role="list" aria-label="Documents in this aging bucket">
    {rows.map((row) => {
      const doc = row.document;
      const label = row.vendorDisplay || doc?.filename || 'Document';
      return (
        <button
          key={row.id}
          type="button"
          role="listitem"
          onClick={onOpenDocument ? () => onOpenDocument(doc) : undefined}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 14,
            width: '100%',
            padding: '10px 24px',
            border: 'none',
            borderBottom: `1px solid ${T.ruleSoft}`,
            background: 'transparent',
            color: T.ink,
            font: 'inherit',
            textAlign: 'left',
            cursor: onOpenDocument ? 'pointer' : 'default'
          }}
        >
          <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted, whiteSpace: 'nowrap' }}>
            {row.documentDate || '—'}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 12.5, whiteSpace: 'nowrap' }}>
            {formatAmount(row.totalAmount, row.currency)}
          </span>
        </button>
      );
    })}
  </div>
);

export default function AgingPanel({
  documents = [],
  reconciliationMatches = [],
  reviewItems = [],
  onOpenDocument = null
}) {
  const inbox = useMemo(
    () => buildDocumentInbox({ documents, reconciliationMatches, reviewItems }),
    [documents, reconciliationMatches, reviewItems]
  );
  const arAging = useMemo(() => buildArAging({ inboxRows: inbox }), [inbox]);
  const apAging = useMemo(() => buildApAging({ inboxRows: inbox }), [inbox]);
  const [activeArBucket, setActiveArBucket] = useState(null);
  const [activeApBucket, setActiveApBucket] = useState(null);

  const allRows = inbox.rows || [];
  const arBucketRows = useMemo(() => {
    if (!activeArBucket) return [];
    const ids = new Set(invoiceIdsInBucket(arAging, activeArBucket));
    return allRows.filter((row) => ids.has(row.id));
  }, [allRows, arAging, activeArBucket]);
  const apBucketRows = useMemo(() => {
    if (!activeApBucket) return [];
    const ids = new Set(billIdsInBucket(apAging, activeApBucket));
    return allRows.filter((row) => ids.has(row.id));
  }, [allRows, apAging, activeApBucket]);

  if (!hasOutstandingAr(arAging) && !hasOutstandingAp(apAging)) {
    return (
      <div style={{ padding: '28px 24px', color: T.muted, fontSize: 13.5 }}>
        Nothing outstanding — no open invoices or bills are aging right now.
      </div>
    );
  }

  return (
    <div>
      <ArAgingSummary
        aging={arAging}
        activeBucket={activeArBucket}
        onSelectBucket={setActiveArBucket}
      />
      {activeArBucket && arBucketRows.length > 0 && (
        <BucketDocList rows={arBucketRows} onOpenDocument={onOpenDocument} />
      )}
      <ApAgingSummary
        aging={apAging}
        activeBucket={activeApBucket}
        onSelectBucket={setActiveApBucket}
      />
      {activeApBucket && apBucketRows.length > 0 && (
        <BucketDocList rows={apBucketRows} onOpenDocument={onOpenDocument} />
      )}
    </div>
  );
}
