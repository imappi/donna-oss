import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import { BidiText } from '../i18n/BidiText.jsx';
import { T, D } from './shared/design-tokens.js';
import { fetchFirmFeed } from '../lib/firmApi.js';
import {
  BUCKET_META,
  COLLAPSED_BY_DEFAULT,
  FEED_BUCKET_ORDER,
  FEED_ROW_HOVER_CSS,
  FeedRow,
  clientTag,
  presentFeedBuckets
} from './shared/feed-list.jsx';
import {
  BANK_FEED_LIST_MEASURE,
  BANK_FEED_SECTION_COUNT_STYLE,
  BANK_FEED_SECTION_HEADING_STYLE,
  BANK_FEED_SECTION_STYLE
} from './shared/bank-feed-list-style.js';

// The bucket/row grammar (BUCKET_META, FeedRow) lives in
// shared/feed-list.jsx — the entity Actions tab renders the same feed
// scoped to one venture, so the anatomy is a shared primitive, not a
// per-surface copy.

const FeedShell = ({ children }) => (
  <section
    style={{
      background: D.paper,
      // EXACTLY the workspace PANEL's viewport: 100vh minus the shell
      // gutters (panels-on-ground, 2026-08-05) minus this view's own top
      // margin (--shell-pad-top via .firm-console__main). Exact height, not
      // minHeight: the list region below is the scroller (pane-scroll), so
      // the section itself must never overflow the panel. The list keeps
      // that native pane behavior while its content measure and type follow
      // Bank Feed's shared pixel contract.
      height: 'calc(100vh - var(--shell-top-gutter, 10px) - var(--shell-gutter, 10px) - var(--shell-pad-top, 28px))',
      fontFamily: D.ui,
      color: T.ink,
      fontSize: 13,
      lineHeight: 'normal',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }}
  >
    <style>{FEED_ROW_HOVER_CSS}</style>
    {children}
  </section>
);

const resetBtnStyle = {
  marginTop: 24,
  background: 'none',
  border: 'none',
  color: T.mutedSoft,
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: D.ui,
  padding: 0
};

// Home Inbox sits outside the entity pane's 32px inset, so its measure owns
// the same gutter explicitly. At wide viewports the outer 64px is added to
// Bank Feed's 1080px content cap; at narrower widths the fluid result lands
// on the same x-coordinate and width as every entity list.
const inboxMeasureStyle = {
  width: '100%',
  maxWidth: BANK_FEED_LIST_MEASURE + 64,
  marginInline: 'auto',
  padding: '0 32px',
  boxSizing: 'border-box'
};

const InboxSectionHeading = ({ meta, count, collapsible, expanded, onToggle }) => {
  const intl = useIntl();
  const HeadingTag = collapsible ? 'button' : 'div';
  return (
    <HeadingTag
      type={collapsible ? 'button' : undefined}
      onClick={collapsible ? onToggle : undefined}
      aria-expanded={collapsible ? expanded : undefined}
      style={{
        ...BANK_FEED_SECTION_HEADING_STYLE,
        position: 'sticky',
        top: 0,
        zIndex: 1,
        width: '100%',
        background: D.paper,
        border: 'none',
        textAlign: 'start',
        cursor: collapsible ? 'pointer' : 'default'
      }}
    >
      <span>{intl.formatMessage({ id: meta.labelId, defaultMessage: meta.label })}</span>
      <span style={BANK_FEED_SECTION_COUNT_STYLE}>{count}</span>
      {collapsible && (
        <span style={{ ...BANK_FEED_SECTION_COUNT_STYLE, marginInlineStart: 'auto' }}>
          {intl.formatMessage({ id: expanded ? 'common.hide' : 'common.show' })}
        </span>
      )}
    </HeadingTag>
  );
};

const InboxMessage = ({ children, color = T.muted }) => {
  const intl = useIntl();
  return (
    <div style={inboxMeasureStyle}>
      <div style={BANK_FEED_SECTION_HEADING_STYLE}>
        <span>{intl.formatMessage({ id: 'firm.inbox.title' })}</span>
        <span style={BANK_FEED_SECTION_COUNT_STYLE}>0</span>
      </div>
      <div style={{ padding: '10px 16px', color, fontSize: 13 }}>{children}</div>
    </div>
  );
};

export default function DonnaFirmFeedPanel({
  clients = [],
  feed = null,
  onActivateItem,
  onResetDemo,
  firmDataSource = 'local'
}) {
  const intl = useIntl();
  // Two activation modes: "explicit" (click / Enter) means the operator
  // is asking to open the artifact for this item; "implicit" (j/k nav)
  // is just a selection change, useful for the artifact to follow along
  // when it's already open. Parent decides what to do with each.
  const activate = (item, opts = {}) => {
    if (!item) return;
    onActivateItem?.(item, { explicit: !!opts.explicit });
  };
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [activeIdx, setActiveIdx] = useState(0);
  // Per-bucket expanded flag. Every heading is a toggle (Kari, 2026-09-01 —
  // with decision-grain grouping retired, a long bucket folds at its
  // heading, not row by row); buckets in COLLAPSED_BY_DEFAULT start
  // collapsed so the active queue isn't padded with Donna's own work or
  // already-cleared items.
  const [expanded, setExpanded] = useState(() => {
    const out = {};
    for (const key of Object.keys(BUCKET_META)) {
      out[key] = !COLLAPSED_BY_DEFAULT.has(key);
    }
    return out;
  });
  const toggleBucket = (key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  const rowRefs = useRef([]);

  // Database mode: App owns the feed fetch (it re-syncs after every applied
  // snapshot, and the sidebar counts read the same object). Self-fetch only
  // in mock/demo mode, where App never loads one.
  useEffect(() => {
    if (firmDataSource === 'database') return undefined;
    const ctrl = new AbortController();
    fetchFirmFeed({ signal: ctrl.signal })
      .then((data) => setState({ status: 'ok', data, error: null }))
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setState({ status: 'error', data: null, error: err });
      });
    return () => ctrl.abort();
  }, [firmDataSource]);

  const feedData = firmDataSource === 'database' ? feed : state.data;
  const feedLoading = firmDataSource === 'database' ? !feed : state.status === 'loading';
  const feedError = firmDataSource === 'database' ? null : (state.status === 'error' ? state.error : null);

  // Presentation buckets: Donna's own unfinished work leaves "Needs your
  // decision" for the collapsed donna_working bucket. Same persisted
  // verdicts, honest actor (see presentFeedBuckets in shared/feed-list).
  const presented = useMemo(() => presentFeedBuckets(feedData?.buckets), [feedData]);

  const flat = useMemo(() => {
    if (!feedData?.buckets) return [];
    const out = [];
    const tagCache = new Map();
    for (const key of FEED_BUCKET_ORDER) {
      const items = presented[key] || [];
      if (items.length === 0) continue;
      const isExpanded = expanded[key] !== false;
      out.push({ type: 'header', bucket: key, count: items.length, expanded: isExpanded });
      if (!isExpanded) {
        out.push({ type: 'section_end', bucket: key });
        continue;
      }
      for (const item of items) {
        const cname = item.verdict?.context?.client_name || '';
        let tag = tagCache.get(cname);
        if (!tag) {
          tag = clientTag(cname || item.client_id);
          tagCache.set(cname, tag);
        }
        // The presented bucket rides the entry so the row's state pill can
        // never disagree with the section heading it renders under.
        out.push({ type: 'row', item: { ...item, _clientTag: tag }, bucket: key });
      }
      out.push({ type: 'section_end', bucket: key });
    }
    return out;
  }, [feedData, presented, expanded]);

  // j/k walks rows; Enter opens the active row's artifact.
  const rowIndices = useMemo(
    () => flat.reduce((acc, entry, i) => {
      if (entry.type === 'row') acc.push(i);
      return acc;
    }, []),
    [flat]
  );

  useEffect(() => {
    setActiveIdx(rowIndices[0] ?? 0);
  }, [rowIndices]);

  useEffect(() => {
    const handler = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
      const key = event.key;
      const idx = rowIndices.indexOf(activeIdx);
      if (key === 'j' || key === 'ArrowDown') {
        event.preventDefault();
        const next = rowIndices[Math.min(idx + 1, rowIndices.length - 1)];
        if (next != null) {
          setActiveIdx(next);
          if (flat[next]?.type === 'row') activate(flat[next].item, { explicit: false });
        }
      } else if (key === 'k' || key === 'ArrowUp') {
        event.preventDefault();
        const prev = rowIndices[Math.max(idx - 1, 0)];
        if (prev != null) {
          setActiveIdx(prev);
          if (flat[prev]?.type === 'row') activate(flat[prev].item, { explicit: false });
        }
      } else if (key === 'Enter') {
        const entry = flat[activeIdx];
        if (entry?.type === 'row') {
          event.preventDefault();
          activate(entry.item, { explicit: true });
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [flat, rowIndices, activeIdx, onActivateItem]);

  useEffect(() => {
    rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (feedLoading) {
    return (
      <FeedShell>
        <InboxMessage>{intl.formatMessage({ id: 'firm.inbox.loading' })}</InboxMessage>
      </FeedShell>
    );
  }

  if (feedError) {
    return (
      <FeedShell>
        <InboxMessage color={D.alert}>
          {intl.formatMessage(
            { id: 'firm.inbox.error' },
            {
              reason: <BidiText direction="auto">
                {feedError?.message || intl.formatMessage({ id: 'firm.inbox.error.unknown' })}
              </BidiText>
            }
          )}
        </InboxMessage>
      </FeedShell>
    );
  }

  const total = FEED_BUCKET_ORDER.reduce((sum, key) => sum + (presented[key]?.length || 0), 0);

  if (total === 0) {
    return (
      <FeedShell>
        <InboxMessage>
          {feedData?.warning
            ? <BidiText direction="auto">{feedData.warning}</BidiText>
            : intl.formatMessage({ id: 'firm.inbox.empty' })}
        </InboxMessage>
        {onResetDemo && firmDataSource !== 'database' && (
          <div style={inboxMeasureStyle}>
            <div style={{ padding: '8px 16px 0' }}>
              <button type="button" onClick={onResetDemo} style={resetBtnStyle}>
                {intl.formatMessage({ id: 'firm.inbox.reset' })}
              </button>
            </div>
          </div>
        )}
      </FeedShell>
    );
  }

  return (
    <FeedShell>
      {/* The list IS the surface — no card wrapper. The panel (panels-on-
          ground) is the one frame; a bordered rounded card around a table
          inside it was the web-dashboard read. This div is the pane's
          scroller: bucket headings stick to ITS top. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingBottom: 48
        }}
      >
        <div style={inboxMeasureStyle}>
          {flat.map((entry, i) => {
            if (entry.type === 'header') {
              const meta = BUCKET_META[entry.bucket] || BUCKET_META.auto_cleared;
              return (
                <InboxSectionHeading
                  key={`h-${entry.bucket}`}
                  meta={meta}
                  count={entry.count}
                  collapsible
                  expanded={entry.expanded}
                  onToggle={() => toggleBucket(entry.bucket)}
                />
              );
            }
            if (entry.type === 'section_end') {
              return <div key={`e-${entry.bucket}`} style={BANK_FEED_SECTION_STYLE} />;
            }
            const item = entry.item;
            return (
              <FeedRow
                key={`r-${item.source_id}`}
                item={item}
                isActive={activeIdx === i}
                onActivate={() => {
                  setActiveIdx(i);
                  activate(item, { explicit: true });
                }}
                onOpen={() => activate(item, { explicit: true })}
                rowRef={(el) => {
                  rowRefs.current[i] = el;
                }}
                layout="bank-feed"
                stateBucket={entry.bucket}
              />
            );
          })}
          {onResetDemo && firmDataSource !== 'database' && (
            <div style={{ padding: '0 16px' }}>
              <button type="button" onClick={onResetDemo} style={resetBtnStyle}>
                {intl.formatMessage({ id: 'firm.inbox.reset' })}
              </button>
            </div>
          )}
        </div>
      </div>
    </FeedShell>
  );
}
