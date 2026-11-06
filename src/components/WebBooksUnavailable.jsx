import { useIntl } from 'react-intl';
import { D } from './shared/design-tokens.js';

// Mounted instead of the whole workspace: no stale upload/action controls remain.
export default function WebBooksUnavailable({ onRetry, onSignOut, missingWorkspace = false }) {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  return (
    <div role="alert" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 'clamp(1.5rem, 5vw, 3rem)', background: D.paper, color: D.ink, fontFamily: D.body }}>
      <main style={{ width: '100%', maxWidth: 440, textAlign: 'center' }}>
        <div style={{ fontFamily: D.display, fontSize: 27, letterSpacing: '.03em', marginBottom: 26, textTransform: 'uppercase' }}>{message('portal.chat.title')}</div>
        <h1 style={{ fontFamily: D.display, fontSize: 'clamp(1.6rem, 3vw, 2.1rem)', fontWeight: 400, lineHeight: 1.15 }}>
          {message(missingWorkspace ? 'shell.workspaceMissing.title' : 'shell.booksUnavailable.title')}
        </h1>
        <p style={{ color: D.inkSoft, fontSize: 15, lineHeight: 1.6, margin: '16px 0 24px' }}>
          {message(missingWorkspace ? 'shell.workspaceMissing.body' : 'shell.booksUnavailable.body')}
        </p>
        <button type="button" onClick={onRetry} style={{ background: D.ink, color: D.paper, border: 0,
          borderRadius: 8, padding: '12px 24px', font: 'inherit', cursor: 'pointer' }}>
          {message('shell.booksUnavailable.retry')}
        </button>
        {onSignOut && <button type="button" onClick={onSignOut} style={{ display: 'block', margin: '20px auto 0',
          background: 'none', color: D.inkSoft, border: 0, textDecoration: 'underline', font: 'inherit', cursor: 'pointer' }}>
          {message('portal.logOut')}
        </button>}
      </main>
    </div>
  );
}
