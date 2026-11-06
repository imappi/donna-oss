// Desktop failure screen: never substitute invented clients for an unreadable book.

import { D } from './shared/design-tokens.js';

const DesktopBooksUnreachable = ({ error = '', onRetry }) => (
  <div
    role="alert"
    style={{
      minHeight: '100vh',
      backgroundColor: D.paper,
      color: D.ink,
      fontFamily: D.body,
      WebkitFontSmoothing: 'antialiased',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'clamp(1.5rem, 5vw, 3rem)'
    }}
  >
    <main style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', marginBottom: '1.6rem' }}>
        <span style={{
          fontFamily: D.display,
          fontWeight: 400,
          letterSpacing: '0.03em',
          lineHeight: 1,
          textTransform: 'uppercase',
          fontSize: 'clamp(22px, 2.4vw, 27px)',
          color: D.ink
        }}>Donna</span>
      </div>
      <h1 style={{
        fontFamily: "'Instrument Serif', 'Source Serif 4', Georgia, serif",
        fontWeight: 400,
        fontSize: 'clamp(1.6rem, 3vw, 2.1rem)',
        lineHeight: 1.1,
        letterSpacing: '-0.01em',
        margin: '0 0 0.6rem'
      }}>Can&rsquo;t reach your books.</h1>
      <p style={{
        fontFamily: D.body,
        fontSize: '0.95rem',
        lineHeight: 1.5,
        color: D.inkSoft,
        margin: '0 0 1.5rem'
      }}>
        Donna is running, but the local database didn&rsquo;t answer in time. Your
        books are on this machine and untouched — nothing has been changed or
        lost. Retrying is safe.
      </p>
      {error ? (
        <p style={{
          fontFamily: D.mono,
          fontSize: '0.78rem',
          lineHeight: 1.45,
          color: D.inkMute,
          margin: '0 0 1.5rem',
          wordBreak: 'break-word'
        }}>{error}</p>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            fontFamily: D.body,
            fontSize: '0.9rem',
            fontWeight: 500,
            color: D.paper,
            backgroundColor: D.ink,
            border: 'none',
            borderRadius: 8,
            padding: '0.65rem 1.4rem',
            cursor: 'pointer'
          }}
        >Try again</button>
      ) : null}
    </main>
  </div>
);

export default DesktopBooksUnreachable;
