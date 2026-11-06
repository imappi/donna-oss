// FirmDock — Donna's scoped command surface. One rail, scope follows
// selection: a venture gets its feed chat and upload activity; Inbox gets the
// cross-venture thread and firm-wide activity. An item artifact owns the rail
// while it is open because it carries its own contextual chat.
//
// The collapsed state is FirmDockPill — a fixed bottom-right pill (the old
// UploadTray corner). The pill subscribes to the upload-tray store directly
// so it can carry the live upload count without mounting the tray UI.

import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

import { V, D } from './shared/design-tokens.js';
import FeedChat from './financials/feed-chat.jsx';
import UploadTray from './UploadTray.jsx';
import {
  applyParseStatusUpdate,
  collectPollableDocumentIds,
  countTrayRowsBeingRead,
  dismissTrayRowsByDocumentIds,
  loadTrayState,
  subscribeToTrayChanges
} from '../lib/uploadTray.js';
import { fetchFirmDocumentsParseStatus } from '../lib/firmApi.js';
import { BidiText } from '../i18n/BidiText.jsx';

// The collapse affordance — a panel-toggle glyph (rounded frame with the
// rail's divider), the standard "hide the side panel" icon, replacing the
// earlier "Hide" text pill (Kari, 2026-08-05).
const PanelCollapseIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <line x1="15" y1="3" x2="15" y2="21" />
  </svg>
);

export const FirmDock = ({
  clientId = null,
  clientName = '',
  dataSource = 'database',
  onSnapshotApplied,
  onApplyLifecycle,
  onUploadsSnapshotInvalidated,
  onOpenDocument = null,
  onOpenFinancials = null,
  onClose,
  // Embedded: the dock renders INSIDE an open artifact's rail as the
  // continuation of that one work surface (Kari's standing UI rail,
  // 2026-08-26 canary round 2: a single chat stream/session — never a
  // second stacked panel). Only the conversation renders: no dock header
  // (the artifact header owns the rail), no upload tray strip.
  embedded = false
}) => {
  const intl = useIntl();
  // Upload activity starts COLLAPSED to a one-line strip (Kari, 2026-09-01:
  // the tray's 40%-of-rail block split the rail in the middle — the rail is
  // ONE continuous chat). Expanding is on demand; the strip disappears
  // entirely when the tray is empty.
  const [uploadsOpen, setUploadsOpen] = useState(false);
  const chat = (
    <FeedChat
      clientId={clientId}
      firmScope={!clientId}
      onSnapshotApplied={onSnapshotApplied}
      onApplyLifecycle={onApplyLifecycle}
      onOpenDocument={onOpenDocument}
      onOpenFinancials={onOpenFinancials}
    />
  );
  return (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      // Transparent — the rail (artifact-panel's aside) paints the paper
      // ground, same as the document chat renders over it.
      background: 'transparent',
      fontFamily: D.ui
    }}
  >
    {/* Header — Donna first, scope second. The previous "Command every
        venture" line explained the product instead of orienting the user. */}
    {!embedded && (
    <div style={{ borderBottom: `1px solid ${V.borderSubtle}`, flexShrink: 0 }}>
      <div style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              lineHeight: 'normal',
              fontWeight: 600,
              color: D.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
            title="Donna"
          >
            Donna
          </div>
          <div
            style={{ fontSize: 12, lineHeight: 1.35, color: D.inkMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={clientId
              ? clientName || intl.formatMessage({ id: 'mounted.dock.thisVenture' })
              : intl.formatMessage({ id: 'mounted.dock.allVentures' })}
          >
            <BidiText direction="auto">
              {clientId
                ? clientName || intl.formatMessage({ id: 'mounted.dock.thisVenture' })
                : intl.formatMessage({ id: 'mounted.dock.allVentures' })}
            </BidiText>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={intl.formatMessage({ id: 'mounted.dock.collapse' })}
          aria-label={intl.formatMessage({ id: 'mounted.dock.collapse' })}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: V.t3,
            cursor: 'pointer',
            transition: 'all 0.15s',
            flexShrink: 0
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = V.t1;
            e.currentTarget.style.background = 'rgba(15,15,15,0.06)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = V.t3;
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <PanelCollapseIcon />
        </button>
      </div>
    </div>
    )}

    {/* Live work belongs to Donna's surface, but uses a dock-native compact
        treatment rather than the client portal's dossier renderer. The tray
        component stays MOUNTED in both states — it owns the parse-status
        poller and snapshot refresh (see FirmDockPill's headless-poll note);
        collapsed only changes what it renders.

        Expanded, the tray shows the WHOLE batch (Kari, 2026-09-01: no
        forced in-component scroll behind an arbitrary 40% cap) — it takes
        its natural height and only scrolls when it would otherwise crush
        the chat below the chat's floor, which keeps the composer reachable
        for any batch size. */}
    {!embedded && (
    <div style={uploadsOpen
      ? { flex: '0 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 14px 0' }
      : { flex: '0 0 auto', padding: '12px 14px 0' }}>
      <UploadTray
        inline
        inlineVariant="dock"
        collapsed={!uploadsOpen}
        onToggleCollapsed={() => setUploadsOpen((open) => !open)}
        dataSource={dataSource}
        activeClientId={clientId || ''}
        hideSettledFromPreviousSessions
        onSnapshotInvalidated={onUploadsSnapshotInvalidated}
      />
    </div>
    )}

    {/* Venture selected → that venture's thread; Inbox → the firm-scope
        cross-venture thread (every action carries the venture it writes to).
        The wrapper's zero flex-basis is what lets the expanded tray take its
        natural height first; minHeight is the chat's floor (composer + a few
        turns) that the tray can never shrink past. Embedded mode renders the
        chat bare — the artifact rail owns its sizing there. */}
    {embedded ? chat : (
      <div style={{ flex: '1 1 0', minHeight: 280, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {chat}
      </div>
    )}
  </div>
  );
};

// Collapsed dock — the little fella (Kari's 2026-08-05 mascot), bottom-right,
// replacing the text pill. Click opens the dock; his VISOR carries the live
// number so collapsing the dock never hides a running upload: the count of
// tray rows still in flight while uploads/parses run, the total tray count
// otherwise, blank when there is nothing to say (an idle robot shows a dark
// visor, not a zero). Subscribes to the tray store directly, rendering none
// of the tray UI.
//
// Art: if public/donna-buddy.png exists (Kari's 3D render — export a TIGHT
// square crop, transparent background, VISOR EMPTY so the live number can
// render on it), it is used with the number overlaid on the visor box below.
// Until that file lands (or if it 404s) a built-in SVG rendition of the same
// fella draws instead, so the launcher works out of the box.

// Visor box as fractions of the (tight-cropped, square) PNG — measured from
// the shipped 512² asset (alpha-bbox crop of Kari's render, 2026-08-05).
// Re-measure if the asset is re-exported: the dark-glass pixel cluster's
// p1/p99 bounds over the square crop.
const BUDDY_VISOR_BOX = { left: '29.6%', top: '23.4%', width: '51.1%', height: '25.4%' };

const visorGold = 'oklch(0.85 0.13 85)';
const visorGlow = { color: visorGold, textShadow: `0 0 6px ${visorGold}` };

// The SVG fella's visor rect (x34 y30 w56 h28 of the 120 viewBox) as
// fractions, so the SAME digit overlay serves both renderers — the PNG and
// the fallback can't drift apart.
const SVG_VISOR_BOX = { left: '28.3%', top: '25%', width: '46.7%', height: '23.3%' };

// Per-digit tick (Kari, 2026-08-11): when the count changes, only the digits
// that changed animate — 17→16 rolls the 6 in while the 1 stays solid. Keyed
// remount per (slot, glyph) does this with NO timers and NO kept state: the
// number shown is ALWAYS the store's truth, the slide is decoration on
// arrival. That also means non-unit steps render honestly (two docs settling
// inside one poll tick shows 17→15; a mid-run upload shows the count going
// UP) — the visor never fakes a −1 cadence it didn't observe.
const VISOR_DIGIT_CSS = `
@keyframes visorDigitIn { from { transform: translateY(0.42em); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .visor-digit { animation: none !important; } }
`;

const VisorCount = ({ value, box }) => (
  <span
    aria-hidden="true"
    style={{
      position: 'absolute',
      ...box,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 16,
      fontWeight: 700,
      ...visorGlow
    }}
  >
    {String(value).split('').map((digit, slot) => (
      <span
        key={`${slot}:${digit}`}
        className="visor-digit"
        style={{
          display: 'inline-block',
          width: '1ch',
          textAlign: 'center',
          animation: 'visorDigitIn 0.18s ease-out'
        }}
      >
        {digit}
      </span>
    ))}
  </span>
);

// The built-in fella: cloud head, dark visor with the gold power-dot, gold
// ear ring, cream body with the >- chest prompt, mitten arms and feet.
const BuddySvg = () => (
  <svg viewBox="0 0 120 120" width="100%" height="100%" aria-hidden="true">
    <defs>
      <filter id="buddy-soft" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#1a1815" floodOpacity="0.18" />
      </filter>
    </defs>
    {/* arms */}
    <circle cx="22" cy="82" r="10" fill="#4a4a4c" />
    <circle cx="98" cy="82" r="10" fill="#4a4a4c" />
    {/* feet */}
    <rect x="38" y="96" width="18" height="18" rx="9" fill="#4a4a4c" />
    <rect x="64" y="96" width="18" height="18" rx="9" fill="#4a4a4c" />
    {/* body */}
    <path d="M30 66 q30 -10 60 0 l-4 34 q-26 8 -52 0 z" fill="#F4F1EA" filter="url(#buddy-soft)" />
    {/* chest prompt */}
    <text x="60" y="88" textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontSize="10" fontWeight="700" fill={visorGold}>&gt;-</text>
    {/* cloud head */}
    <g filter="url(#buddy-soft)">
      <circle cx="38" cy="30" r="18" fill="#F4F1EA" />
      <circle cx="62" cy="22" r="20" fill="#F4F1EA" />
      <circle cx="84" cy="32" r="16" fill="#F4F1EA" />
      <rect x="22" y="28" width="76" height="36" rx="17" fill="#F4F1EA" />
    </g>
    {/* ear ring */}
    <circle cx="21" cy="44" r="7" fill="none" stroke={visorGold} strokeWidth="3" />
    {/* visor */}
    <rect x="34" y="30" width="56" height="28" rx="12" fill="#1E1D1B" />
    <circle cx="81" cy="37" r="2.5" fill={visorGold} />
  </svg>
);

// activeClientId is accepted but deliberately unused since the 2026-08-11
// visor contract: the count is FIRM-WIDE work in flight — a running upload
// for another venture must never vanish because of where you're looking.
export const FirmDockPill = ({ onOpen }) => {
  const intl = useIntl();
  const [trayState, setTrayState] = useState(() => loadTrayState());
  const [pngOk, setPngOk] = useState(true);
  useEffect(() => subscribeToTrayChanges(setTrayState), []);

  // Headless parse-status poll. The tray store only advances when something
  // fetches /parse-status and applies the result — and that poller lived
  // solely in the UploadTray COMPONENT, which unmounts with the dock. So
  // with the dock collapsed the visor froze at the upload-time count
  // (Kari's 2026-08-05 report). While the pill is mounted it runs the same
  // loop headless: fetch statuses for pollable rows, apply, drop rows the
  // server no longer knows. No double-poll in practice — the pill renders
  // only while the dock (and its UploadTray) is closed — and a transient
  // overlap would merely duplicate an idempotent status read. Snapshot
  // refresh on completion stays the mounted tray's job.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      const current = loadTrayState();
      const ids = collectPollableDocumentIds(current);
      if (ids.length) {
        try {
          const response = await fetchFirmDocumentsParseStatus({ ids });
          const remoteRows = response?.documents || [];
          const returnedIds = new Set(remoteRows.map((row) => row.id));
          const missingIds = ids.filter((id) => !returnedIds.has(id));
          if (missingIds.length) dismissTrayRowsByDocumentIds({ documentIds: missingIds });
          for (const remote of remoteRows) {
            for (const batch of current.batches || []) {
              const localRow = (batch.rows || []).find((row) => row.document_id === remote.id);
              if (localRow) applyParseStatusUpdate({ rowId: localRow.row_id, parseStatus: remote });
            }
          }
        } catch { /* non-fatal — the next tick retries */ }
      }
      if (!cancelled) timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  // The visor contract (Kari, 2026-08-11): the number is how many documents
  // Donna is reading RIGHT NOW — counting down as each settles — and the
  // visor CLEARS when the work is done. No fallback to the settled tray
  // total (that number lives in the tray itself); an idle robot shows a
  // dark visor, not a zero. countTrayRowsBeingRead owns the definition of
  // "being read" (store-side, tested) — do not re-derive it here.
  const readingCount = useMemo(() => countTrayRowsBeingRead(trayState), [trayState]);
  // Two digits max — the visor is small.
  const visorCount = readingCount > 0 ? Math.min(readingCount, 99) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={intl.formatMessage({ id: 'mounted.dock.open' })}
      aria-label={intl.formatMessage(
        { id: readingCount > 0 ? 'mounted.dock.openReading' : 'mounted.dock.open' },
        { count: readingCount }
      )}
      style={{
        position: 'fixed',
        insetInlineEnd: 18,
        insetBlockEnd: 12,
        zIndex: 50,
        // 104, up from the pill-era 86 — the real render can afford the
        // presence (2026-08-05, the asset-landing pass).
        width: 104,
        height: 104,
        padding: 0,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        transition: 'transform 0.15s ease'
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
    >
      <style>{VISOR_DIGIT_CSS}</style>
      {pngOk ? (
        <span style={{ position: 'relative', display: 'block', width: '100%', height: '100%' }}>
          <img
            src="/donna-buddy.png"
            alt=""
            onError={() => setPngOk(false)}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
          {visorCount != null && <VisorCount value={visorCount} box={BUDDY_VISOR_BOX} />}
        </span>
      ) : (
        <span style={{ position: 'relative', display: 'block', width: '100%', height: '100%' }}>
          <BuddySvg />
          {visorCount != null && <VisorCount value={visorCount} box={SVG_VISOR_BOX} />}
        </span>
      )}
    </button>
  );
};

export default FirmDock;
