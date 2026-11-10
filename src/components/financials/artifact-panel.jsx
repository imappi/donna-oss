import { cloneElement, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import { T, D } from '../shared/design-tokens.js';
import DocumentArtifact from './document-artifact.jsx';
import TransactionArtifact from './transaction-artifact.jsx';
import FinancialsReportArtifact from './financials-report-artifact.jsx';
import CloseReceiptArtifact from './close-receipt-artifact.jsx';
import ClosePeriodArtifact from './close-period-artifact.jsx';
import AskBatchArtifact from './ask-batch-artifact.jsx';
import { BidiText } from '../../i18n/BidiText.jsx';

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const ArtifactToggleIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="2.5" width="18" height="19" rx="4" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

const computeDefaultArtifactWidth = () => {
  if (typeof window === 'undefined') return 520;
  const sidebar = 200;
  const minWorkspace = 480;
  const max = Math.min(900, window.innerWidth - sidebar - minWorkspace);
  return Math.max(360, Math.min(520, max));
};

// The rail owner. `artifact` renders as before; `dock` (a node — FirmDock)
// shares the same rail when no artifact is open. Document and transaction
// artifacts carry their OWN item-scoped chat, so the general dock never
// stacks beneath those two; every other artifact type is a chat-less work
// surface, so the dock stacks beneath it — the rail stays ONE work area
// with chat at the bottom (Kari's standing UI rail, 2026-08-26: artifact
// rail = chat + in-chat components, one surface — never a chat-less panel).
// Closing the artifact restores the dock to the full rail.
export const ARTIFACT_TYPES_WITH_OWN_CHAT = new Set(['document', 'transaction']);

const ArtifactPanel = ({
  artifact,
  setArtifact,
  onSuggestTransactionCoding,
  onApplyLifecycle = null,
  dock = null,
  dockOpen = false,
  // The firm snapshot's clients: a transaction artifact writes a question to
  // its client's owner in that owner's language, read from this record.
  clients = []
}) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const [artifactWidth, setArtifactWidth] = useState(computeDefaultArtifactWidth);
  const [isDragging, setDragging] = useState(false);
  const [keptArtifact, setKeptArtifact] = useState(artifact);
  // True while an async refresh handler (the per-item AI coding re-run)
  // is in flight — spins the icon and blocks double-fires.
  const [refreshBusy, setRefreshBusy] = useState(false);
  const dragRef = useRef(false);
  const refreshRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    setRefreshBusy(false);
  }, [artifact]);

  // The artifact is a collapsible contextual panel. Escape and the split-panel
  // control both hide it; selecting a row shows it again at the current rail
  // width. There is deliberately no second, wider artifact mode.
  useEffect(() => {
    if (!artifact) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setArtifact(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [artifact, setArtifact]);

  useEffect(() => {
    if (artifact) {
      setKeptArtifact(artifact);
      return undefined;
    }
    const timer = setTimeout(() => setKeptArtifact(null), 240);
    return () => clearTimeout(timer);
  }, [artifact]);

  useEffect(() => {
    const onMouseMove = (event) => {
      if (!dragRef.current) return;
      const panelBounds = panelRef.current?.parentElement?.getBoundingClientRect();
      const rtl = document.documentElement.dir === 'rtl';
      const width = rtl
        ? event.clientX - (panelBounds?.left || 0)
        : (panelBounds?.right || window.innerWidth) - event.clientX;
      const sidebar = 200;
      const minWorkspace = 480;
      const maxByViewport = window.innerWidth - sidebar - minWorkspace;
      setArtifactWidth(Math.max(360, Math.min(width, Math.min(900, maxByViewport))));
    };
    const onMouseUp = () => {
      if (!dragRef.current) return;
      dragRef.current = false;
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const isOpen = !!artifact;
  const visible = keptArtifact;
  const showDock = dockOpen && !!dock
    && (!artifact || !ARTIFACT_TYPES_WITH_OWN_CHAT.has(artifact.type));
  const railOpen = isOpen || showDock;
  // Donna and item artifacts are two contents of this one rail, so they use
  // the same responsive width state and the same resize affordance.
  const railWidth = artifactWidth;
  const refreshTitle =
    visible?.type === 'transaction' && onSuggestTransactionCoding
      ? message('artifact.refresh.transaction')
      : message('artifact.refresh');

  return (
    <aside
      ref={panelRef}
      className={`firm-artifact${railOpen ? ' firm-artifact--open' : ''}`}
      data-dragging={isDragging ? 'true' : 'false'}
      style={{
        '--artifact-width': `${railWidth}px`,
        // Transparent, NOT T.paper (which is card-white): the rail is a
        // region of the workspace panel, and painting it white left the
        // panel visibly two-toned — paper left, white right (Kari,
        // 2026-08-05). One surface; the borderLeft is the divider, and
        // cards inside (composer, proposal cards, artifacts' own strips)
        // keep popping off the shared paper.
        background: 'transparent',
        // ruleSoft, not rule — at 15% ink the divider read fat against the
        // shared paper (Kari, 2026-08-05); 8% is a true hairline.
        borderInlineStart: railOpen ? `1px solid ${T.ruleSoft}` : 'none'
      }}
    >
      <div style={{ width: railWidth, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {railOpen && (
          <div
            aria-hidden="true"
            data-artifact-resize-handle="true"
            onMouseDown={(event) => {
              event.preventDefault();
              dragRef.current = true;
              setDragging(true);
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
            }}
            style={{ position: 'absolute', insetBlock: 0, insetInlineStart: 0, width: 6, cursor: 'col-resize', zIndex: 1 }}
          />
        )}
        {visible && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: D.ui }}>
              <span style={{ fontSize: 13.5, lineHeight: 'normal', fontWeight: 500, color: T.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingInlineEnd: 8, flex: 1, minWidth: 0 }}>
                <BidiText direction="auto">{visible.title}</BidiText>
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => {
                    if (refreshBusy) return;
                    const result = refreshRef.current?.();
                    if (result && typeof result.then === 'function') {
                      setRefreshBusy(true);
                      result.finally(() => setRefreshBusy(false));
                    }
                  }}
                  title={refreshTitle}
                  aria-label={refreshTitle}
                  disabled={refreshBusy}
                  style={{ background: 'none', border: 'none', cursor: refreshBusy ? 'default' : 'pointer', color: refreshBusy ? T.ink : T.muted, padding: '4px 6px', borderRadius: 4, display: 'flex', alignItems: 'center' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = T.ink; }}
                  onMouseLeave={(e) => { if (!refreshBusy) e.currentTarget.style.color = T.muted; }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', animation: refreshBusy ? 'eval-spin 0.9s linear infinite' : 'none' }}>
                    <RefreshIcon />
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setArtifact(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, lineHeight: 1, fontFamily: D.ui, padding: '4px 8px', borderRadius: 4, display: 'flex', alignItems: 'center' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = T.ink; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = T.muted; }}
                  title={message('artifact.hide')}
                  aria-label={message('artifact.hide')}
                >
                  <ArtifactToggleIcon />
                </button>
              </div>
            </div>
            {/* With the chat sharing the rail (chat-less artifact types),
                the artifact block takes its NATURAL height and the
                conversation fills the remainder — one surface, a work
                component above the stream, never a fixed 58/42 split with
                dead space between (Kari's canary round 2, 2026-08-26). */}
            <div style={{ flex: showDock ? '0 1 auto' : 1, overflowY: 'auto', padding: 0, minHeight: 0 }}>
              {visible.type === 'document' && visible.data && (
                <DocumentArtifact artifact={visible} setArtifact={setArtifact} onRefreshRef={refreshRef} />
              )}
              {visible.type === 'transaction' && visible.data && (
                <TransactionArtifact
                  artifact={visible}
                  setArtifact={setArtifact}
                  client={(Array.isArray(clients) ? clients : []).find((entry) => entry?.id && entry.id === (visible.data.transaction?.client_id || visible.data.clientId)) || null}
                  onRefreshRef={refreshRef}
                  onSuggestTransactionCoding={onSuggestTransactionCoding}
                  onApplyLifecycle={onApplyLifecycle}
                />
              )}
              {visible.type === 'financials' && visible.data && (
                <FinancialsReportArtifact artifact={visible} onRefreshRef={refreshRef} />
              )}
              {visible.type === 'close_receipt' && visible.data && (
                <CloseReceiptArtifact artifact={visible} onRefreshRef={refreshRef} />
              )}
              {visible.type === 'close_period' && visible.data && (
                <ClosePeriodArtifact artifact={visible} onRefreshRef={refreshRef} />
              )}
              {visible.type === 'ask_batch' && visible.data && (
                <AskBatchArtifact artifact={visible} onRefreshRef={refreshRef} />
              )}
            </div>
          </>
        )}
        {showDock && (
          <div
            style={{
              // Beneath an artifact the conversation takes ALL remaining
              // height (no hard divider, no fixed split) — the rail reads
              // as one chat stream with the artifact block above it. The
              // dock renders EMBEDDED there: conversation + composer only,
              // its own header/tray chrome suppressed.
              flex: visible ? '1 1 0' : '1 1 auto',
              minHeight: visible ? 220 : 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }}
          >
            {visible ? cloneElement(dock, { embedded: true }) : dock}
          </div>
        )}
      </div>
    </aside>
  );
};

export default ArtifactPanel;
