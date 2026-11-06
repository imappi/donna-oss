import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';
import { useIntl } from 'react-intl';

// The desktop shell's drag region for the hidden macOS title bar.
//
// desktop/main.mjs sets titleBarStyle:'hidden', which removes the native bar
// (and its "Donna — Firm console" text) so the window background runs to the
// top edge as one surface. Two consequences land here.
//
// 1. A frameless window cannot be moved until something declares
//    -webkit-app-region: drag. This is that handle.
//
// 2. It must NOT displace the app. The first version rendered in flow above
//    App, which pushed the whole UI down by its height — and since the firm
//    sidebar is inline-styled height:100vh, the sidebar then overhung its
//    shrunken shell: its right border started below the band instead of at the
//    window's top edge, and its footer (the user card) was clipped off the
//    bottom. Overlaying instead of displacing means the sidebar runs the full
//    height of the window, so the divider is continuous from top to bottom by
//    construction rather than by drawing a second line in the band.
//
// The firm workspace now reserves this full-height band across the whole
// window (`--shell-top-gutter` reads `--donna-titlebar-h`), so the drag surface
// can span the entire orange shell header without covering application
// content. Interactive titlebar controls sit above it and explicitly opt out
// with `no-drag`.

export const DESKTOP_TITLEBAR_HEIGHT = 52;

const DesktopTitlebar = () => (
  <div
    className="desktop-titlebar"
    aria-hidden="true"
    style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      height: DESKTOP_TITLEBAR_HEIGHT,
      // Transparent: whatever is beneath shows through, so this never becomes
      // a coloured strip that has to be kept in sync with the surface below.
      background: 'transparent',
      zIndex: 50,
      WebkitAppRegion: 'drag'
    }}
  />
);

// ── Firm-shell nav controls (Kari's 2026-08-05 sidebar pass) ────────────────
// The titlebar band's control cluster, right of the macOS traffic lights:
// collapse/expand the rail + back/forward through the app's own view history
// (App keeps an in-app stack — the SPA syncs URLs with replaceState only, so
// window.history has nothing to navigate). Rendered by App in firm mode on
// the desktop shell only; fixed so it survives the rail collapsing, stacked
// above the drag overlay (z 50) and marked no-drag so the clicks land.

const NAV_BTN = (enabled) => ({
  width: 26,
  height: 26,
  padding: 0,
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: enabled ? 'oklch(0.08 0 0 / 0.55)' : 'oklch(0.08 0 0 / 0.22)',
  cursor: enabled ? 'pointer' : 'default',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.15s',
  WebkitAppRegion: 'no-drag'
});

const hoverable = (enabled) => ({
  onMouseEnter: (e) => {
    if (!enabled) return;
    e.currentTarget.style.color = 'oklch(0.08 0 0)';
    e.currentTarget.style.background = 'oklch(0.08 0 0 / 0.06)';
  },
  onMouseLeave: (e) => {
    e.currentTarget.style.color = enabled ? 'oklch(0.08 0 0 / 0.55)' : 'oklch(0.08 0 0 / 0.22)';
    e.currentTarget.style.background = 'transparent';
  }
});

export const FirmShellNavControls = ({
  railCollapsed,
  onToggleRail,
  onBack,
  onForward,
  canBack = false,
  canForward = false
}) => {
  const intl = useIntl();
  const { direction } = useInterfaceLocale();
  const mirror = direction === 'rtl' ? 'scaleX(-1)' : undefined;
  const sidebarLabel = intl.formatMessage({
    id: railCollapsed ? 'mounted.desktop.sidebar.show' : 'mounted.desktop.sidebar.hide'
  });
  const backLabel = intl.formatMessage({ id: 'mounted.desktop.back' });
  const forwardLabel = intl.formatMessage({ id: 'mounted.desktop.forward' });
  return (
  <div
    style={{
      position: 'fixed',
      // Centered on the traffic LIGHTS, not the band: main.mjs places the
      // lights at y:18 and macOS draws them 12px tall → center y=24, so the
      // 26px buttons sit at 24 − 13 = 11. The naive band-center
      // ((52 − 26) / 2 = 13) rendered them 2px low (Kari's 2026-08-05 paste).
      top: 11,
      // Past the traffic lights (native, x:20, ~52px wide).
      left: 84,
      zIndex: 60,
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      WebkitAppRegion: 'no-drag'
    }}
  >
    <button
      type="button"
      onClick={onToggleRail}
      title={sidebarLabel}
      aria-label={sidebarLabel}
      style={NAV_BTN(true)}
      {...hoverable(true)}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: mirror }}>
        <rect x="3" y="3" width="18" height="18" rx="4" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    </button>
    <button
      type="button"
      onClick={canBack ? onBack : undefined}
      disabled={!canBack}
      title={backLabel}
      aria-label={backLabel}
      style={NAV_BTN(canBack)}
      {...hoverable(canBack)}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: mirror }}>
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    <button
      type="button"
      onClick={canForward ? onForward : undefined}
      disabled={!canForward}
      title={forwardLabel}
      aria-label={forwardLabel}
      style={NAV_BTN(canForward)}
      {...hoverable(canForward)}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: mirror }}>
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  </div>
  );
};

export default DesktopTitlebar;
