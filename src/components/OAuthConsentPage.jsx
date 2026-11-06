import { useEffect, useState } from 'react';

import { D } from './shared/design-tokens.js';
import { clearFirmAccess, getAuthSession, hasStoredAuth } from '../lib/accessToken.js';
import {
  decideOAuthAuthorization,
  fetchOAuthAuthorization,
  hydrateAuthUser,
  isSupabaseAuthConfigured,
  refreshAuthSession,
  signInWithPassword,
  startGoogleSignIn
} from '../lib/supabaseAuth.js';

// The OAuth consent page for the hosted chat surface
// (docs/design-donna-chatgpt-app-build-brief.md §4.2, §8 F3).
//
// Supabase's OAuth 2.1 server renders NO consent screen of its own: after it
// validates a chat host's authorization request it redirects the owner's
// browser to this path with ?authorization_id=…, and the page asks Supabase
// what is being requested, shows it, and posts the owner's approve/deny back.
// The token the chat host then receives is an ordinary Supabase session for
// this owner — exactly the bearer requireDonnaAccess already accepts — so no
// parallel identity store exists anywhere on this path.
//
// Register: bridge copy. Say plainly what the host will be able to read and
// that tool results reach the host's model provider; no custody slogans, no
// prices. Same design language as the sign-in gate (D — the owner journey),
// never the operator workspace look.

const CONSENT_PATH = '/oauth/consent';

const inkA = (alpha) => `oklch(0.08 0 0 / ${alpha})`;
const serif = "'Instrument Serif', 'Source Serif 4', Georgia, serif";
const okGreen = 'oklch(0.52 0.11 150)';

const page = {
  minHeight: '100vh',
  background: D.paper,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem 1rem',
  boxSizing: 'border-box'
};
const card = {
  width: '100%',
  maxWidth: 440,
  background: '#fff',
  borderRadius: 12,
  padding: '2rem',
  boxSizing: 'border-box',
  boxShadow: '0 1px 2px oklch(0.08 0 0 / 0.06), 0 12px 40px oklch(0.08 0 0 / 0.08)'
};
const wordmark = {
  fontFamily: D.display,
  fontWeight: 400,
  letterSpacing: '0.03em',
  lineHeight: 1,
  textTransform: 'uppercase',
  color: D.ink,
  fontSize: '1.1rem',
  marginBottom: '1.4rem'
};
const h1 = {
  fontFamily: serif,
  fontWeight: 400,
  fontSize: 'clamp(1.6rem, 3vw, 2rem)',
  lineHeight: 1.1,
  letterSpacing: '-0.01em',
  margin: '0 0 0.6rem'
};
const p = { fontFamily: D.body, fontSize: '0.95rem', lineHeight: 1.55, color: inkA(0.7), margin: '0 0 1rem' };
const small = { fontFamily: D.body, fontSize: '0.82rem', lineHeight: 1.5, color: inkA(0.55), margin: '1.2rem 0 0' };
const list = { fontFamily: D.body, fontSize: '0.95rem', lineHeight: 1.55, color: inkA(0.8), margin: '0 0 1.2rem', paddingLeft: '1.1rem' };
const field = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: D.body,
  fontSize: '0.95rem',
  padding: '0.85rem 1rem',
  border: `1px solid ${inkA(0.28)}`,
  borderRadius: 6,
  background: '#fff',
  color: D.ink,
  outline: 'none'
};
const primaryBtn = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: D.body,
  fontSize: '0.95rem',
  fontWeight: 600,
  padding: '0.95rem 1.4rem',
  border: 'none',
  borderRadius: 6,
  background: D.ink,
  color: '#fff',
  cursor: 'pointer'
};
const secondaryBtn = { ...primaryBtn, background: '#fff', color: D.ink, border: `1px solid ${inkA(0.28)}` };
const errorText = { fontFamily: D.body, fontSize: '0.88rem', color: D.alert, margin: '0.6rem 0 0' };

const readAuthorizationId = () => {
  if (typeof window === 'undefined') return '';
  return String(new URLSearchParams(window.location.search).get('authorization_id') || '').trim();
};

export const isOAuthConsentPath = (pathname) => {
  const clean = String(pathname || '').toLowerCase().replace(/\/+$/, '');
  return clean === CONSENT_PATH;
};

const describeScope = (scope) => {
  const scopes = String(scope || '').split(/\s+/).filter(Boolean);
  return scopes.length ? scopes.join(', ') : 'your Donna account';
};

const SignInCard = ({ onSignedIn }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signInWithPassword({ email, password });
      onSignedIn();
    } catch (err) {
      setError(err?.message || 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 style={h1}>Sign in to connect Donna</h1>
      <p style={p}>A chat app is asking to read your Donna books. Sign in first, then decide whether to allow it.</p>
      <button type="button" onClick={() => startGoogleSignIn()} disabled={busy} style={{ ...secondaryBtn, marginBottom: '0.8rem', opacity: busy ? 0.6 : 1 }}>
        Continue with Google
      </button>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <input style={field} type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input style={field} type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="submit" style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {error ? <p style={errorText}>{error}</p> : null}
    </>
  );
};

const OAuthConsentPage = () => {
  const authorizationId = readAuthorizationId();
  const [signedIn, setSignedIn] = useState(() => hasStoredAuth());
  const [state, setState] = useState({ status: authorizationId ? 'loading' : 'missing', details: null, error: '' });
  const [deciding, setDeciding] = useState('');
  const [user, setUser] = useState(() => getAuthSession()?.user || null);

  useEffect(() => {
    if (!signedIn || !authorizationId) return undefined;
    let cancelled = false;
    (async () => {
      const hydrated = await hydrateAuthUser();
      if (!cancelled && hydrated) setUser(hydrated);
      const load = () => fetchOAuthAuthorization({ authorizationId });
      let result;
      try {
        result = await load();
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) {
          const refreshed = await refreshAuthSession();
          if (!refreshed) {
            if (!cancelled) setSignedIn(false);
            return;
          }
          try {
            result = await load();
          } catch (again) {
            if (!cancelled) setState({ status: 'error', details: null, error: again?.message || 'Could not load the request.' });
            return;
          }
        } else {
          if (!cancelled) {
            setState({
              status: err?.status === 404 ? 'expired' : 'error',
              details: null,
              error: err?.message || 'Could not load the request.'
            });
          }
          return;
        }
      }
      if (cancelled) return;
      if (result?.redirect_url) {
        // Already consented for this client: Supabase auto-approved.
        window.location.assign(result.redirect_url);
        return;
      }
      setState({ status: 'ready', details: result, error: '' });
    })();
    return () => { cancelled = true; };
  }, [signedIn, authorizationId]);

  const decide = async (action) => {
    setDeciding(action);
    try {
      const result = await decideOAuthAuthorization({ authorizationId, action });
      if (result?.redirect_url) {
        window.location.assign(result.redirect_url);
        return;
      }
      setState((prev) => ({ ...prev, error: 'Donna did not get a redirect back from the sign-in server. Try again from the chat app.' }));
    } catch (err) {
      setState((prev) => ({ ...prev, error: err?.message || 'Could not record your decision.' }));
    } finally {
      setDeciding('');
    }
  };

  const signOut = () => {
    clearFirmAccess();
    setSignedIn(false);
    setUser(null);
  };

  let body;
  if (!isSupabaseAuthConfigured()) {
    body = (
      <>
        <h1 style={h1}>Sign-in is not configured here</h1>
        <p style={p}>This deployment has no sign-in provider, so chat apps cannot connect to it.</p>
      </>
    );
  } else if (state.status === 'missing') {
    body = (
      <>
        <h1 style={h1}>Nothing to approve</h1>
        <p style={p}>This page is where a chat app asks for access to your Donna books. Start from the chat app: add Donna there and it will bring you here.</p>
      </>
    );
  } else if (!signedIn) {
    body = <SignInCard onSignedIn={() => { setSignedIn(true); setState({ status: 'loading', details: null, error: '' }); }} />;
  } else if (state.status === 'loading') {
    body = (
      <>
        <h1 style={h1}>One moment</h1>
        <p style={p}>Checking what the chat app is asking for…</p>
      </>
    );
  } else if (state.status === 'expired') {
    body = (
      <>
        <h1 style={h1}>This request has expired</h1>
        <p style={p}>Sign-in requests are only valid for a few minutes. Go back to the chat app and connect Donna again.</p>
      </>
    );
  } else if (state.status === 'error') {
    body = (
      <>
        <h1 style={h1}>Something went wrong</h1>
        <p style={p}>{state.error}</p>
        <p style={p}>Go back to the chat app and try connecting Donna again.</p>
      </>
    );
  } else {
    const client = state.details?.client || {};
    const clientName = client.name || 'A chat app';
    body = (
      <>
        <h1 style={h1}>{clientName} wants to talk to Donna about your books</h1>
        <p style={p}>If you allow it, {clientName} will be able to do this for the businesses you have exposed under Settings → AI chat access in Donna:</p>
        <ul style={list}>
          <li>see close status and what is blocking the close</li>
          <li>see unresolved transactions and documents</li>
          <li>see outstanding document requests</li>
          <li>see Donna’s recent activity from the audit trail</li>
          <li>ask Donna about the books, in your words, and show you her reply</li>
          <li>confirm an answer she proposed, only when you say so, through the same tracked path as the Confirm button in your Donna portal</li>
        </ul>
        <p style={p}>It cannot post, approve, file or send anything else. Every call is written to Donna’s audit trail, naming {clientName} as the door. What Donna returns is sent to {clientName}’s model provider, the same way your questions there are.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          <button type="button" style={{ ...primaryBtn, opacity: deciding ? 0.6 : 1 }} disabled={Boolean(deciding)} onClick={() => decide('approve')}>
            {deciding === 'approve' ? 'Allowing…' : `Allow ${clientName}`}
          </button>
          <button type="button" style={{ ...secondaryBtn, opacity: deciding ? 0.6 : 1 }} disabled={Boolean(deciding)} onClick={() => decide('deny')}>
            {deciding === 'deny' ? 'Declining…' : 'Not now'}
          </button>
        </div>
        {state.error ? <p style={errorText}>{state.error}</p> : null}
        <p style={small}>
          Signed in as <span style={{ color: D.ink }}>{user?.email || state.details?.user?.email || 'your Donna account'}</span>.{' '}
          <button type="button" onClick={signOut} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: inkA(0.55), textDecoration: 'underline', cursor: 'pointer' }}>Not you?</button>
          {client.uri ? <> · Requested scope: {describeScope(state.details?.scope)}</> : null}
        </p>
      </>
    );
  }

  return (
    <div style={page}>
      <div style={card}>
        <div style={wordmark}>Donna</div>
        {body}
        {signedIn && state.status === 'ready' ? (
          <p style={{ ...small, color: okGreen }}>To stop sharing later, remove Donna from the chat app or switch the business off under Settings → AI chat access in Donna.</p>
        ) : null}
      </div>
    </div>
  );
};

export default OAuthConsentPage;
