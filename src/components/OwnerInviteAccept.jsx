// /owner-invite — where a firm's invitation email lands the business owner
// (server/donna/clientOwnerInvitesDb.js). Signs in through the existing
// Supabase auth (password or Google), then asks the server to accept: the
// server binds the owner only when the signed-in VERIFIED email is the invited
// one, and only into that client's portal. On success → /client/:id.
//
// The link token is moved out of the address bar into this tab's
// sessionStorage at once, so it survives a Google round trip or a reload
// without sitting in history. Nothing on this page says whether an email is
// known: it shows no invite details before acceptance, and every unusable
// link reads the same.
//
// Copy is local (Finnish sinä / English by the browser language) on purpose:
// the AR-3B mounted catalog is closed with Arabic parity, untouched here.

import { useEffect, useRef, useState } from 'react';

import { D } from './shared/design-tokens.js';
import { clearFirmAccess, hasStoredAuth } from '../lib/accessToken.js';
import { signInWithPassword, signUp, startGoogleSignIn } from '../lib/supabaseAuth.js';
import { acceptClientOwnerInvite } from '../lib/firmApi.js';
import { rememberOwnerClientId } from '../lib/ownerPersona.js';

export const OWNER_INVITE_ROUTE = '/owner-invite';
const TOKEN_KEY = 'donna.owner_invite_token.v1';

const COPY = {
  en: {
    title: 'Your invitation to Donna',
    lead: 'Sign in or create an account with the email address the invitation was sent to.',
    email: 'Email', password: 'Password',
    signIn: 'Sign in', signUp: 'Create account', google: 'Continue with Google',
    toSignUp: 'No account yet? Create one', toSignIn: 'Already have an account? Sign in',
    confirm: 'Confirm your email address from the message we just sent you, then open the invitation link again.',
    accepting: 'Opening your company’s portal…',
    signOut: 'Sign out', retry: 'Try again',
    errors: {
      CLIENT_OWNER_INVITE_INVALID: 'This invitation link is no longer valid. Ask your accounting firm to send you a new one.',
      CLIENT_OWNER_INVITE_EMAIL_MISMATCH: 'This invitation was sent to a different email address. Sign out and sign in with the address the invitation was sent to.',
      CLIENT_OWNER_INVITE_EMAIL_UNVERIFIED: 'Confirm your email address first, then open the invitation link again.',
      CLIENT_OWNER_INVITE_ACCOUNT_IN_USE: 'This sign-in is already used for another Donna workspace, so it can’t be added to this company’s portal. Sign in with a different email address, or ask your accounting firm.',
      generic: 'Something went wrong. Try again in a moment.'
    }
  },
  fi: {
    title: 'Kutsu Donnaan',
    lead: 'Kirjaudu sisään tai luo tunnus sillä sähköpostiosoitteella, johon kutsu lähetettiin.',
    email: 'Sähköposti', password: 'Salasana',
    signIn: 'Kirjaudu sisään', signUp: 'Luo tunnus', google: 'Jatka Google-tilillä',
    toSignUp: 'Eikö sinulla ole vielä tunnusta? Luo tunnus', toSignIn: 'Onko sinulla jo tunnus? Kirjaudu sisään',
    confirm: 'Vahvista sähköpostiosoitteesi viestistä, jonka lähetimme sinulle. Avaa sen jälkeen kutsulinkki uudelleen.',
    accepting: 'Avataan yrityksesi näkymää…',
    signOut: 'Kirjaudu ulos', retry: 'Yritä uudelleen',
    errors: {
      CLIENT_OWNER_INVITE_INVALID: 'Tämä kutsulinkki ei ole enää voimassa. Pyydä kirjanpitäjältäsi uusi kutsu.',
      CLIENT_OWNER_INVITE_EMAIL_MISMATCH: 'Kutsu lähetettiin toiseen sähköpostiosoitteeseen. Kirjaudu ulos ja kirjaudu sisään sillä osoitteella, johon kutsu tuli.',
      CLIENT_OWNER_INVITE_EMAIL_UNVERIFIED: 'Vahvista ensin sähköpostiosoitteesi ja avaa sitten kutsulinkki uudelleen.',
      CLIENT_OWNER_INVITE_ACCOUNT_IN_USE: 'Tämä tunnus on jo käytössä toisessa Donna-työtilassa, joten sitä ei voi liittää tämän yrityksen näkymään. Kirjaudu toisella sähköpostiosoitteella tai kysy kirjanpitäjältäsi.',
      generic: 'Jokin meni pieleen. Yritä hetken päästä uudelleen.'
    }
  }
};

const pickLanguage = () => {
  try {
    return String(navigator.language || '').toLowerCase().startsWith('fi') ? 'fi' : 'en';
  } catch {
    return 'en';
  }
};

// Read the token once: from the link (then strip it), else from this tab.
const captureToken = () => {
  if (typeof window === 'undefined') return '';
  try {
    const params = new URLSearchParams(window.location.search);
    const fromLink = String(params.get('token') || '').trim();
    if (fromLink) {
      window.sessionStorage.setItem(TOKEN_KEY, fromLink);
      params.delete('token');
      const rest = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
      return fromLink;
    }
    return String(window.sessionStorage.getItem(TOKEN_KEY) || '').trim();
  } catch {
    return '';
  }
};
const forgetToken = () => { try { window.sessionStorage.removeItem(TOKEN_KEY); } catch { /* non-fatal */ } };

const shell = (children) => (
  <div style={{ minHeight: '100vh', backgroundColor: D.paper, color: D.ink, fontFamily: D.body, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'clamp(1.5rem, 5vw, 3rem)' }}>
    <main style={{ width: '100%', maxWidth: 420 }}>{children}</main>
  </div>
);

const fieldStyle = { width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: 15, padding: '0.7rem 0.8rem', border: `1px solid ${D.rule}`, borderRadius: 0, background: D.card, color: D.ink };
const primary = (busy) => ({ appearance: 'none', width: '100%', border: 'none', borderRadius: 0, padding: '0.85rem 1.25rem', backgroundColor: D.accentWarmFlat, color: D.ink, fontFamily: D.mono, fontSize: 12, letterSpacing: D.tracking?.mono, textTransform: 'uppercase', fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1 });
const linkButton = { appearance: 'none', background: 'none', border: 'none', padding: 0, color: D.ink, textDecoration: 'underline', cursor: 'pointer', font: 'inherit', fontSize: 14 };

export default function OwnerInviteAccept({ oauthRedirect = null }) {
  const copy = COPY[pickLanguage()];
  const [token] = useState(captureToken);
  const [signedIn, setSignedIn] = useState(() => hasStoredAuth());
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorCode, setErrorCode] = useState(token ? (oauthRedirect?.error ? 'generic' : '') : 'CLIENT_OWNER_INVITE_INVALID');
  const [attempt, setAttempt] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!token || !signedIn || startedRef.current) return undefined;
    startedRef.current = true;
    let cancelled = false;
    const controller = new AbortController();
    acceptClientOwnerInvite({ token, signal: controller.signal })
      .then(({ client_id: clientId }) => {
        if (cancelled) return;
        if (!clientId) throw new Error('missing client');
        forgetToken();
        rememberOwnerClientId(clientId);
        window.location.replace(`/client/${encodeURIComponent(clientId)}`);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        startedRef.current = false;
        if (err?.code === 'CLIENT_OWNER_INVITE_INVALID') forgetToken();
        setErrorCode(copy.errors[err?.code] ? err.code : 'generic');
      });
    return () => { cancelled = true; controller.abort(); };
  }, [token, signedIn, attempt]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setNotice(''); setErrorCode('');
    try {
      if (mode === 'signup') {
        const result = await signUp({ email, password, redirectPath: OWNER_INVITE_ROUTE });
        if (result?.confirmationRequired) { setNotice(copy.confirm); return; }
      } else {
        await signInWithPassword({ email, password });
      }
      setSignedIn(hasStoredAuth());
    } catch (err) {
      setNotice(err?.message || copy.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  if (errorCode) {
    return shell(
      <>
        <h1 style={{ fontSize: '1.3rem', fontWeight: 600, margin: '0 0 0.75rem' }}>{copy.title}</h1>
        <p role="alert" data-testid="owner-invite-error" style={{ fontSize: '0.95rem', lineHeight: 1.55, color: D.inkSoft, margin: '0 0 1.25rem' }}>
          {copy.errors[errorCode] || copy.errors.generic}
        </p>
        <div style={{ display: 'flex', gap: 16 }}>
          {token && errorCode !== 'CLIENT_OWNER_INVITE_INVALID' && signedIn && (
            <button type="button" style={linkButton} onClick={() => { setErrorCode(''); setAttempt((n) => n + 1); }}>{copy.retry}</button>
          )}
          {signedIn && (
            <button type="button" style={linkButton} onClick={() => { clearFirmAccess(); setSignedIn(false); setErrorCode(token ? '' : 'CLIENT_OWNER_INVITE_INVALID'); }}>
              {copy.signOut}
            </button>
          )}
        </div>
      </>
    );
  }

  if (signedIn) {
    return shell(
      <div style={{ textAlign: 'center', fontFamily: D.mono, fontSize: 11, letterSpacing: D.tracking?.mono, textTransform: 'uppercase', color: D.inkSoft }}>
        {copy.accepting}
      </div>
    );
  }

  return shell(
    <>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 600, margin: '0 0 0.6rem' }}>{copy.title}</h1>
      <p style={{ fontSize: '0.95rem', lineHeight: 1.55, color: D.inkSoft, margin: '0 0 1.25rem' }}>{copy.lead}</p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          {copy.email}
          <input style={fieldStyle} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          {copy.password}
          <input style={fieldStyle} type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" disabled={busy} style={primary(busy)}>{mode === 'signup' ? copy.signUp : copy.signIn}</button>
      </form>
      <button type="button" disabled={busy} style={{ ...primary(busy), backgroundColor: D.card, border: `1px solid ${D.rule}`, marginBlockStart: 10 }}
        onClick={() => { try { startGoogleSignIn(OWNER_INVITE_ROUTE); } catch (err) { setNotice(err?.message || copy.errors.generic); } }}>
        {copy.google}
      </button>
      <p style={{ marginBlockStart: 14 }}>
        <button type="button" style={linkButton} onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setNotice(''); }}>
          {mode === 'signup' ? copy.toSignIn : copy.toSignUp}
        </button>
      </p>
      {notice && <p role="status" style={{ fontSize: '0.9rem', lineHeight: 1.5, color: D.inkSoft }}>{notice}</p>}
    </>
  );
}
