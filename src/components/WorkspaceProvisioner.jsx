// Post-auth landing for the signup funnel (/start). The funnel sends an
// authenticated business owner here instead of the firm console; this provisions
// their client workspace and forwards to /client/:id, where ClientPortalGate
// redeems the stashed offer into Checkout. It is the bridge that makes the flow
// choose product → auth → [provision] → card → checkout → portal actually close.
//
// Owners are NOT firm members, so the firm console (/firms) only ever 401'd them
// ("session expired"). This route is the correct destination for that persona.

import { useEffect, useRef, useState } from 'react';

import { D } from './shared/design-tokens.js';
import { hasStoredAuth } from '../lib/accessToken.js';
import { rememberOwnerClientId } from '../lib/ownerPersona.js';
import { provisionWorkspace } from '../lib/selfProvision.js';
import { fetchFirmSnapshot } from '../lib/firmApi.js';
import ExistingOwnerRevalidation from './ExistingOwnerRevalidation.jsx';

// Where to send a visitor who reached /start with no session (e.g. a Google
// sign-in that bounced) — back to the funnel's sign-in door.
const SIGN_IN_ROUTE = '/?auth=signin';

const shell = (children) => (
  <div
    style={{
      minHeight: '100vh',
      backgroundColor: D.paper,
      color: D.ink,
      fontFamily: D.body,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'clamp(1.5rem, 5vw, 3rem)'
    }}
  >
    <main style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>{children}</main>
  </div>
);

export default function WorkspaceProvisioner(props = {}) {
  if (new URLSearchParams(window.location.search).get('revalidate') === 'pilot') return <ExistingOwnerRevalidation />;
  return <StandardWorkspaceProvisioner {...props} />;
}

function StandardWorkspaceProvisioner({ oauthRedirect } = {}) {
  const [error, setError] = useState(oauthRedirect?.error || '');
  const [attempt, setAttempt] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    // A bounced OAuth sign-in left an error and no session — don't try to
    // provision; offer the way back to sign-in.
    if (oauthRedirect?.error) return undefined;
    if (!hasStoredAuth()) {
      window.location.replace(SIGN_IN_ROUTE);
      return undefined;
    }
    if (startedRef.current) return undefined;
    startedRef.current = true;

    let cancelled = false;
    const controller = new AbortController();
    const openWorkspace = async () => {
      // Existing firm members can arrive through the owner signup link too.
      // Use the authorized snapshot, never a stored persona or a caller firm id.
      const snapshot = await fetchFirmSnapshot({ signal: controller.signal }).catch((err) => {
        if (err.status === 401 || err.status === 403) return null;
        throw err;
      });
      if (cancelled) return {};
      if (snapshot?.source === 'database' && snapshot.workspaceAccess?.surface === 'firm' && snapshot.firm?.id) {
        return { firm: true };
      }
      return provisionWorkspace({ signal: controller.signal });
    };
    openWorkspace()
      .then(({ clientId, firm }) => {
        if (cancelled) return;
        if (firm) {
          window.location.replace('/firms');
          return;
        }
        if (!clientId) throw new Error('Workspace setup did not return an id.');
        // Record the owner persona so persona-aware routing keeps this owner in
        // their portal (and out of the firm/admin shell) on every later load.
        rememberOwnerClientId(clientId);
        // replace() so the back button doesn't return to this transient route.
        window.location.replace(`/client/${encodeURIComponent(clientId)}`);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        startedRef.current = false; // allow an explicit retry
        setError(err.message || 'Could not set up your workspace.');
      });

    return () => { cancelled = true; controller.abort(); };
  }, [attempt, oauthRedirect]);

  if (error) {
    return shell(
      <>
        <h1 style={{ fontFamily: D.body, fontSize: '1.3rem', fontWeight: 600, margin: '0 0 0.6rem' }}>
          We couldn’t finish setting up
        </h1>
        <p style={{ fontSize: '0.95rem', lineHeight: 1.55, color: D.inkSoft, margin: '0 0 1.25rem' }}>
          {error}
        </p>
        <button
          type="button"
          onClick={() => { setError(''); setAttempt((n) => n + 1); }}
          style={{
            appearance: 'none',
            border: 'none',
            borderRadius: 0,
            padding: '0.8rem 1.5rem',
            backgroundColor: D.accentWarmFlat,
            color: D.ink,
            fontFamily: D.mono,
            fontSize: 12,
            letterSpacing: D.tracking.mono,
            textTransform: 'uppercase',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Try again
        </button>
        <p style={{ marginTop: '1rem', fontSize: '0.8rem', color: D.inkSoft }}>
          Still stuck? <a href="mailto:support@books.example" style={{ color: D.ink }}>kari@books.example</a>
        </p>
      </>
    );
  }

  return shell(
    <div
      style={{
        fontFamily: D.mono,
        fontSize: 11,
        letterSpacing: D.tracking.mono,
        textTransform: 'uppercase',
        color: D.inkSoft
      }}
    >
      Setting up your workspace…
    </div>
  );
}
