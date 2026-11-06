// ToastHost — renders queued toasts from src/lib/toastBus.js.
//
// Mounted as a sibling of <ArtifactPanel> in FirmOpsConsole so it
// sits above all firm panels regardless of which tab is active.
// Subscribes to the bus in a useEffect; each emit pushes a toast
// onto a local queue and schedules its dismissal.
//
// Tones map to the D palette (paper + ink + warm). D carries no purple and no
// green, so the four-tone vocabulary collapses the way StatusChip's does:
//   - 'info'   → ink       — neutral notice
//   - 'intel'  → ink       — client-bound traffic (was purple)
//   - 'pos'    → ink       — confirmation (was green)
//   - 'neg'    → D.alert   — genuine failure, the one coloured toast
//
// Stacking: newest at the bottom; cap at 3 visible to avoid hiding
// the artifact panel. Older toasts time out via durationMs (default
// 5000) and roll off naturally.

import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

import { D } from './design-tokens.js';
import { subscribeToToasts } from '../../lib/toastBus.js';
import { BidiText } from '../../i18n/BidiText.jsx';

const DEFAULT_DURATION_MS = 5000;
const MAX_VISIBLE = 3;

const ON_INK_MUTE = 'oklch(0.98 0 0 / 0.66)';
const TONE_STYLES = {
  info: { bg: D.ink, fg: D.paper, accent: ON_INK_MUTE },
  intel: { bg: D.ink, fg: D.paper, accent: ON_INK_MUTE },
  pos: { bg: D.ink, fg: D.paper, accent: ON_INK_MUTE },
  neg: { bg: D.alert, fg: D.paper, accent: ON_INK_MUTE }
};

// Call sites emit a wider tone vocabulary than the four canonical styles
// (e.g. document-artifact emits `warn` on a parse/save FAILURE). Without a
// mapping these fell through to the neutral `info` grey, so a failure toast
// looked like an ordinary notice. Resolve the common synonyms onto intent.
const TONE_ALIASES = {
  warn: 'neg', warning: 'neg', error: 'neg', alert: 'neg', danger: 'neg',
  success: 'pos', ok: 'pos'
};
const resolveTone = (tone) => TONE_STYLES[tone] || TONE_STYLES[TONE_ALIASES[tone]] || TONE_STYLES.info;

const ToastHost = () => {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const unsubscribe = subscribeToToasts((toast) => {
      setToasts((prev) => {
        // Deduplicate by id — defensive against subscribers receiving
        // an emit twice during a React Fast Refresh cycle.
        if (prev.some((t) => t.id === toast.id)) return prev;
        const next = [...prev, toast];
        // Hold at MAX_VISIBLE; drop the oldest.
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return undefined;
    const timers = toasts.map((toast) => {
      const duration = typeof toast.durationMs === 'number' ? toast.durationMs : DEFAULT_DURATION_MS;
      return setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, duration);
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts]);

  const handleDismiss = (id) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        insetBlockEnd: 24,
        insetInlineEnd: 24,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
        maxWidth: 360
      }}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={() => handleDismiss(toast.id)} />
      ))}
    </div>
  );
};

export const Toast = ({ toast, onDismiss }) => {
  const intl = useIntl();
  const tone = resolveTone(toast.tone);
  const interactive = toast.onClick || toast.href;
  const handleActivate = () => {
    if (toast.onClick) toast.onClick();
    if (toast.href && typeof window !== 'undefined') {
      window.location.href = toast.href;
    }
    onDismiss();
  };
  return (
    <div
      style={{
        background: tone.bg,
        color: tone.fg,
        padding: '12px 14px',
        borderRadius: 10,
        boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        pointerEvents: 'auto',
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 13.5,
        lineHeight: 1.45,
        cursor: 'default'
      }}
    >
      {interactive ? (
        <button
          type="button"
          onClick={handleActivate}
          style={{
            flex: 1,
            minWidth: 0,
            padding: 0,
            border: 0,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            lineHeight: 'inherit',
            textAlign: 'start',
            wordBreak: 'break-word',
            cursor: 'pointer'
          }}
        >
          <BidiText direction="auto">{toast.message}</BidiText>
        </button>
      ) : (
        <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
          <BidiText direction="auto">{toast.message}</BidiText>
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        aria-label={intl.formatMessage({ id: 'toast.dismiss' })}
        style={{
          background: 'transparent',
          border: 'none',
          color: tone.accent,
          fontSize: 16,
          lineHeight: 1,
          cursor: 'pointer',
          padding: 2,
          flexShrink: 0
        }}
      >
        ×
      </button>
    </div>
  );
};

export default ToastHost;
