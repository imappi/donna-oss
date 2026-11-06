import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

import { D } from './shared/design-tokens.js';
import { isSupabaseAuthConfigured } from '../lib/supabaseAuth.js';
import { BidiText, IdentifierText } from '../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';

// Firm sign-in / sign-up gate, in the CLIENT/marketing design language (D) so
// the onboarding journey — marketing landing → this gate → client portal —
// reads as one app. It deliberately does NOT use the operator (T) workspace
// look: a customer/owner onboarding should never feel like they dropped into an
// admin tool. The App.jsx status machine that drives this is unchanged; only
// the presentation moved from T to D.
//
// The legacy access key remains Kari's operational fallback (cron, curl) — a
// quiet footer link, not a peer of the primary buttons.

const CONTACT_EMAIL = 'support@books.example';

const inkA = (alpha) => `oklch(0.08 0 0 / ${alpha})`;
const serif = "'Instrument Serif', 'Source Serif 4', Georgia, serif";
const monoCaps = { fontFamily: D.mono, textTransform: 'uppercase' };
const okGreen = 'oklch(0.52 0.11 150)';
const errRed = 'oklch(0.55 0.20 25)';

const wordmark = {
  fontFamily: D.display,
  fontWeight: 400,
  letterSpacing: '0.03em',
  lineHeight: 1,
  textTransform: 'uppercase',
  color: D.ink
};

const labelStyle = { ...monoCaps, fontSize: 10, letterSpacing: '0.2em', color: inkA(0.6) };
const h1Style = {
  fontFamily: serif,
  fontWeight: 400,
  fontSize: 'clamp(2rem, 3.4vw, 2.6rem)',
  lineHeight: 1.05,
  letterSpacing: '-0.01em',
  margin: '0 0 0.5rem'
};
const subStyle = {
  fontFamily: D.body,
  fontSize: '0.95rem',
  lineHeight: 1.5,
  color: inkA(0.6),
  margin: '0 0 1.5rem'
};
const field = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: D.body,
  fontSize: '0.95rem',
  padding: '0.9rem 1.1rem',
  border: `1px solid ${inkA(0.28)}`,
  borderRadius: '6px',
  background: '#fff',
  color: D.ink,
  outline: 'none'
};
const googleBtn = {
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.75rem',
  fontFamily: D.body,
  fontSize: '0.95rem',
  fontWeight: 600,
  padding: '0.95rem 1.4rem',
  border: `1px solid ${inkA(0.28)}`,
  borderRadius: '6px',
  background: '#fff',
  color: D.ink,
  cursor: 'pointer'
};
const textLink = {
  color: D.ink,
  fontWeight: 600,
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer'
};
const arrow = { fontSize: '1.05rem', lineHeight: 1 };

const STYLES = `
  @keyframes fagPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .fag-pulse { animation: fagPulse 1.6s ease-in-out infinite; }
  .fag-cta { transition: background 160ms ${D.ease}, transform 120ms ${D.ease}; }
  .fag-cta:not(:disabled):hover { background: #2b2723; transform: translateY(-1px); }
  .fag-cta:not(:disabled):active { transform: translateY(0); }
  .fag-google { transition: background 160ms ${D.ease}; }
  .fag-google:not(:disabled):hover { background: ${inkA(0.04)}; }
  .fag-field { transition: border-color 160ms ${D.ease}; }
  .fag-field:focus { border-color: ${D.ink}; }
  .fag-link:hover { opacity: 0.65; }
  @media (max-width: 900px) {
    .fag-root { grid-template-columns: 1fr !important; height: auto !important; }
    .fag-panel { display: none !important; }
  }
  @media (prefers-reduced-motion: reduce) {
    .fag-pulse { animation: none !important; }
    .fag-cta { transition: none !important; }
  }
`;

const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style={{ flex: 'none' }}>
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const DarkButton = ({ onClick, type = 'button', disabled = false, children }) => (
  <button
    type={type}
    onClick={onClick}
    disabled={disabled}
    className="fag-cta"
    style={{
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '1rem',
      ...monoCaps,
      fontSize: 12,
      letterSpacing: '0.16em',
      padding: '1.05rem 1.4rem',
      border: `1px solid ${D.ink}`,
      borderRadius: '6px',
      background: D.ink,
      color: D.paper,
      opacity: disabled ? 0.55 : 1,
      cursor: disabled ? 'default' : 'pointer'
    }}
  >
    {children}
  </button>
);

const Divider = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', margin: '1.4rem 0' }}>
    <div style={{ flex: 1, height: 1, background: inkA(0.16) }} />
    <span style={{ ...monoCaps, fontSize: 10, letterSpacing: '0.3em', color: inkA(0.6) }}>
      <FormattedMessage id="auth.divider.or" />
    </span>
    <div style={{ flex: 1, height: 1, background: inkA(0.16) }} />
  </div>
);

const ErrorMsg = ({ children }) => (
  <p style={{ margin: '0.85rem 0 0', fontFamily: D.body, fontSize: 13, lineHeight: 1.45, color: errRed }}>
    <BidiText direction="auto">{children}</BidiText>
  </p>
);

// Static D brand panel — gradient grain, hairline grid, an oversized cropped
// Anton wordmark, and a live "firm access" status dot. Same vocabulary as the
// marketing landing's animated panel, kept static here (no typewriter) because
// an auth gate shouldn't compete with the form for attention.
const BrandPanel = () => {
  const intl = useIntl();
  const grid = inkA(0.09);
  const gridImage =
    `repeating-linear-gradient(90deg, ${grid} 0, ${grid} 1px, transparent 1px, transparent 120px), ` +
    `repeating-linear-gradient(0deg, ${grid} 0, ${grid} 1px, transparent 1px, transparent 120px)`;
  return (
    <div className="fag-panel" style={{ position: 'relative', overflow: 'hidden', ...D.gradientGrain() }}>
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, backgroundImage: gridImage }} />
      <div
        aria-hidden="true"
        style={{ position: 'absolute', top: 0, bottom: 0, left: '34%', width: 1, background: inkA(0.16) }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-2vw',
          bottom: '-6vh',
          fontFamily: D.display,
          fontSize: '26vw',
          lineHeight: 0.78,
          letterSpacing: '-0.02em',
          color: inkA(0.1),
          whiteSpace: 'pre-line',
          textTransform: 'uppercase',
          userSelect: 'none'
        }}
      >
        {'D'}
      </div>
      <div
        style={{
          position: 'absolute',
          top: 'clamp(2rem, 4vh, 3rem)',
          insetInlineStart: 'clamp(2rem, 4vw, 3.5rem)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.7rem'
        }}
      >
        <span className="fag-pulse" style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: inkA(0.4) }} />
        <span style={{ ...monoCaps, fontSize: 11, letterSpacing: '0.18em', color: inkA(0.82) }}>
          {intl.formatMessage({ id: 'auth.brand.firmAccess' })}
        </span>
      </div>
    </div>
  );
};

const FirmAuthGate = ({ status, error, pendingAccess, onBackToSignIn, onPasswordSubmit, onSignUpSubmit, onAccessKeySubmit, onGoogleSignIn, initialMode, initialEmail, authConfiguredOverride }) => {
  const intl = useIntl();
  const { direction } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const supabaseConfigured = typeof authConfiguredOverride === 'boolean'
    ? authConfiguredOverride
    : isSupabaseAuthConfigured();
  // 'signin' | 'signup' | 'key' — without Supabase config only the legacy
  // access key can work, so the form opens (and stays) there. initialMode lets
  // the marketing landing deep-link straight into 'signup' vs 'signin'.
  const [mode, setMode] = useState(supabaseConfigured ? (initialMode || 'signin') : 'key');
  const [email, setEmail] = useState(initialEmail || '');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [confirmationSentTo, setConfirmationSentTo] = useState('');
  const checking = status === 'checking';

  const submit = async (event) => {
    event.preventDefault();
    if (checking) return;
    if (mode === 'key') {
      onAccessKeySubmit(token);
      setToken('');
      return;
    }
    if (mode === 'signin') {
      onPasswordSubmit({ email, password });
      setPassword('');
      return;
    }
    const result = await onSignUpSubmit({ email, password });
    if (result) setPassword('');
    if (result?.confirmationRequired) setConfirmationSentTo(email);
  };

  const submitDisabled =
    checking || (mode === 'key' ? !token.trim() : !email.trim() || !password);
  const submitLabel = checking
    ? mode === 'signup'
      ? message('auth.submit.creating')
      : message('auth.submit.checking')
    : mode === 'signup'
      ? message('auth.submit.create')
      : mode === 'key'
        ? message('auth.submit.unlock')
        : message('auth.submit.continueEmail');

  // Header (eyebrow + headline + optional sub) is computed from the current
  // state so the form/notice bodies below stay focused on their controls.
  let head;
  if (confirmationSentTo) {
    head = { eyebrow: message('auth.head.confirm.eyebrow'), tone: okGreen, title: message('auth.head.confirm.title') };
  } else if (pendingAccess) {
    head = { eyebrow: message('auth.head.pending.eyebrow'), tone: D.accentWarmFlat, title: message('auth.head.pending.title') };
  } else if (mode === 'key') {
    head = { eyebrow: message('auth.head.key.eyebrow'), tone: inkA(0.6), title: message('auth.head.key.title') };
  } else if (mode === 'signup') {
    head = {
      eyebrow: message('auth.brand.firmAccess'),
      tone: inkA(0.6),
      title: message('auth.head.signup.title'),
      sub: message('auth.head.signup.subtitle')
    };
  } else {
    head = {
      eyebrow: message('auth.brand.firmAccess'),
      tone: inkA(0.6),
      title: message('auth.head.signin.title'),
      sub: message('auth.head.signin.subtitle')
    };
  }

  const emailForm = (
    <>
      <button type="button" className="fag-google" onClick={onGoogleSignIn} disabled={checking} style={{ ...googleBtn, opacity: checking ? 0.6 : 1 }}>
        <GoogleMark />
        <span>{message('auth.google.continue')}</span>
      </button>

      <Divider />

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <label htmlFor="firm-auth-email" style={labelStyle}>{message('auth.email.label')}</label>
        <input
          id="firm-auth-email"
          className="fag-field"
          type="email"
          dir="ltr"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={message('auth.email.placeholder')}
          aria-label={message('auth.email.label')}
          autoComplete="email"
          disabled={checking}
          style={field}
          autoFocus
        />
        <label htmlFor="firm-auth-password" style={labelStyle}>{message('auth.password.label')}</label>
        <input
          id="firm-auth-password"
          className="fag-field"
          type="password"
          dir="ltr"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={mode === 'signup' ? message('auth.password.placeholder.new') : message('auth.password.placeholder.current')}
          aria-label={message('auth.password.label')}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          disabled={checking}
          style={field}
        />
        <DarkButton type="submit" disabled={submitDisabled}>
          <span>{submitLabel}</span>
          <span aria-hidden="true" style={arrow}>{direction === 'rtl' ? '←' : '→'}</span>
        </DarkButton>
      </form>
      {error && <ErrorMsg>{error}</ErrorMsg>}

      <p style={{ margin: '1.5rem 0 0', fontFamily: D.body, fontSize: '0.95rem', color: inkA(0.6) }}>
        {mode === 'signup' ? (
          <>
            {message('auth.account.existing')}{' '}
            <button type="button" className="fag-link" onClick={() => setMode('signin')} style={textLink}>
              {message('auth.account.signIn')}
            </button>
          </>
        ) : (
          <>
            {message('auth.account.new')}{' '}
            <button type="button" className="fag-link" onClick={() => setMode('signup')} style={textLink}>
              {message('auth.account.create')}
            </button>
          </>
        )}
      </p>
      {mode === 'signup' && (
        <p style={{ margin: '0.85rem 0 0', fontFamily: D.body, fontSize: '0.85rem', lineHeight: 1.5, color: inkA(0.6) }}>
          {message('auth.beta.note')}
        </p>
      )}
    </>
  );

  const keyForm = (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      <label htmlFor="firm-access-key" style={labelStyle}>{message('auth.accessKey.label')}</label>
      <input
        id="firm-access-key"
        className="fag-field"
        type="password"
        dir="ltr"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder={message('auth.accessKey.placeholder')}
        aria-label={message('auth.accessKey.label')}
        disabled={checking}
        style={field}
        autoFocus
      />
      <DarkButton type="submit" disabled={submitDisabled}>
        <span>{submitLabel}</span>
        <span aria-hidden="true" style={arrow}>{direction === 'rtl' ? '←' : '→'}</span>
      </DarkButton>
      {error && <ErrorMsg>{error}</ErrorMsg>}
      {supabaseConfigured && (
        <p style={{ margin: '0.85rem 0 0', fontFamily: D.body, fontSize: '0.95rem', color: inkA(0.6) }}>
          <button type="button" className="fag-link" onClick={() => setMode('signin')} style={textLink}>
            {message('auth.key.back')}
          </button>
        </p>
      )}
    </form>
  );

  const pendingBody = (
    <>
      <p style={{ ...subStyle, margin: '0 0 1.5rem', maxWidth: '34ch' }}>
        {message('auth.pending.body')}
      </p>
      <a
        className="fag-cta"
        href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(message('auth.pending.mailSubject'))}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          ...monoCaps,
          fontSize: 12,
          letterSpacing: '0.16em',
          padding: '1.05rem 1.4rem',
          border: `1px solid ${D.ink}`,
          borderRadius: '6px',
          background: D.ink,
          color: D.paper,
          textDecoration: 'none'
        }}
      >
        <span>{message('auth.pending.request')}</span>
        <span aria-hidden="true" style={arrow}>{direction === 'rtl' ? '←' : '→'}</span>
      </a>
      <p style={{ margin: '1.5rem 0 0', fontFamily: D.body, fontSize: '0.95rem', color: inkA(0.6) }}>
        {message('auth.pending.wrongAccount')}{' '}
        <button type="button" className="fag-link" onClick={onBackToSignIn} style={textLink}>
          {message('auth.pending.otherEmail')}
        </button>
      </p>
    </>
  );

  const confirmationBody = (
    <>
      <p style={{ ...subStyle, margin: '0 0 1.5rem' }}>
        <FormattedMessage
          id="auth.confirmation.body"
          values={{
            email: <IdentifierText style={{ color: D.ink, fontWeight: 700 }}>{confirmationSentTo}</IdentifierText>
          }}
        />
      </p>
      <DarkButton
        onClick={() => {
          setConfirmationSentTo('');
          setMode('signin');
        }}
      >
        <span>{message('auth.key.back')}</span>
        <span aria-hidden="true" style={arrow}>{direction === 'rtl' ? '←' : '→'}</span>
      </DarkButton>
    </>
  );

  return (
    <main
      className="fag-root"
      style={{
        display: 'grid',
        gridTemplateColumns: 'clamp(380px, 42%, 560px) 1fr',
        minHeight: '100vh',
        background: D.paper,
        color: D.ink,
        fontFamily: D.body,
        WebkitFontSmoothing: 'antialiased'
      }}
    >
      <style>{STYLES}</style>

      {/* LEFT — the auth funnel */}
      <div
        style={{
          position: 'relative',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 'clamp(2rem, 4vh, 3rem)',
          padding: 'clamp(2.5rem, 4vh, 3.75rem) clamp(2rem, 3.5vw, 3.5rem)',
          overflowY: 'auto'
        }}
      >
        {/* brand anchor */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span style={{ ...wordmark, fontSize: 'clamp(22px, 2.4vw, 27px)' }}>Donna</span>
          <span style={{ ...monoCaps, fontSize: 10, letterSpacing: '0.18em', color: inkA(0.6) }}>· {message('auth.brand.firmAccess')}</span>
        </div>

        {/* funnel state */}
        <div style={{ width: '100%', maxWidth: '26rem' }}>
          <p style={{ ...monoCaps, fontSize: 11, letterSpacing: '0.18em', color: head.tone, margin: '0 0 0.85rem' }}>
            {head.eyebrow}
          </p>
          <h1 style={h1Style}>{head.title}</h1>
          {head.sub && <p style={subStyle}>{head.sub}</p>}

          {confirmationSentTo
            ? confirmationBody
            : pendingAccess
              ? pendingBody
              : mode === 'key'
                ? keyForm
                : emailForm}

          {supabaseConfigured && mode !== 'key' && !confirmationSentTo && !pendingAccess && (
            <p style={{ margin: '1.6rem 0 0', fontFamily: D.body, fontSize: 12 }}>
              <button
                type="button"
                className="fag-link"
                onClick={() => setMode('key')}
                style={{ ...textLink, fontWeight: 400, color: inkA(0.6), textDecoration: 'none' }}
              >
                {message('auth.key.useInstead')}
              </button>
            </p>
          )}
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', ...monoCaps, fontSize: 10.5, letterSpacing: '0.18em' }}>
          <a className="fag-link" href={`mailto:${CONTACT_EMAIL}`} style={{ color: inkA(0.6), textDecoration: 'none' }}>
            <IdentifierText>{CONTACT_EMAIL}</IdentifierText>
          </a>
          <span style={{ color: inkA(0.6) }}>{message('auth.language.englishShort')}</span>
        </div>
      </div>

      {/* RIGHT — brand panel (hidden < 900px) */}
      <BrandPanel />
    </main>
  );
};

export default FirmAuthGate;
