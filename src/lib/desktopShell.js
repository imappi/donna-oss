// Detection of the Donna Desktop shell (desktop/main.mjs serves the built
// SPA from the donna://app origin). Inside the shell the runtime access
// token is attached by the MAIN process's proxy — the renderer holds no
// credential at all (the plan's no-bearer-token-in-renderer rail), so the
// auth gate must not demand one: App.jsx initializes the firm access status
// to 'restoring' here and lets the snapshot fetch verify through the proxy.

export const isDesktopShell = () =>
  typeof window !== 'undefined' &&
  (window.location.protocol === 'donna:' || Boolean(window.donnaDesktop?.shell));

// The desktop main process serves client-portal previews to the system browser
// on a token-gated loopback origin. The injected meta marker carries no
// authority; it only tells the SPA to verify through the main-process proxy
// instead of demanding a Supabase browser session. The separate HttpOnly
// session cookie is what the loopback server actually authorizes. A meta tag
// is origin-local, unlike a readable 127.0.0.1 cookie shared across dev ports.
export const isDesktopPortalPreview = (doc = typeof document !== 'undefined' ? document : null) =>
  Boolean(doc?.querySelector?.('meta[name="donna-portal-preview"][content="desktop"]'));

export const hasDesktopRuntimeAccess = () => isDesktopShell() || isDesktopPortalPreview();

// A real-book session in either shell requires the database. Missing, seed,
// failed and timed-out snapshots never authorize a demo/local fallback.
export const resolveFirmSnapshotOutcome = ({ failed = false, source = null } = {}) => {
  if (!failed && source === 'database') return 'database';
  return 'unreachable';
};

// Gate 3 — first-run detection. A DESKTOP snapshot that genuinely came from
// the database but carries no firm row means a virgin appliance: nothing is
// broken, nothing is seeded, the book simply hasn't been born. Render the
// first-run onboarding pane (firm + owner mint) instead of an empty state
// whose only CTA (client-create) would FK-fail. Web never sees this: the
// cloud is provisioned out-of-band and a firm-less cloud DB is a config
// error surfaced elsewhere, so this stays a desktop-only surface.
export const resolveFirstRunRequired = ({ desktop = false, source = null, firm = null } = {}) =>
  Boolean(desktop) && source === 'database' && !firm;
