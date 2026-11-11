import React, { useEffect, useState } from 'react';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';
import { demoReplayNoticeText } from '../lib/demoReplayNotice.js';

// The replay demo's notice (`npm run demo:fi`, scripts/demo_fi.mjs). Shown on
// every screen while the book holds the stored record that it was given
// recorded model outputs (provider_replay_sessions, migration 205), which
// the public health route returns as `provider_replay`. A normal book has no
// such record and this renders nothing. Mounted from src/main.jsx beside
// <App />, so it is above the sign-in screen, the firm view and the portal.
// Its text is its own (src/lib/demoReplayNotice.js), not the interface
// catalog: it belongs to a demo command, not to the release-gated surfaces.
const DemoReplayNotice = ({ fetchImpl = (...args) => fetch(...args) }) => {
  const { locale } = useInterfaceLocale();
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchImpl('/api/donna/firms/health')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (!cancelled) setHealth(body || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fetchImpl]);
  const notice = demoReplayNoticeText({ health, locale });
  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid="demo-replay-notice"
      style={{
        position: 'fixed',
        insetInlineStart: '50%',
        bottom: 12,
        transform: 'translateX(-50%)',
        zIndex: 1000,
        maxWidth: 'min(720px, calc(100vw - 32px))',
        background: '#1f2937',
        color: '#fff',
        borderRadius: 10,
        padding: '8px 14px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
        font: '500 13px/1.4 system-ui, sans-serif',
        pointerEvents: 'none'
      }}
    >
      <strong style={{ display: 'block' }}>{notice.title}</strong>
      <span style={{ opacity: 0.85 }}>{notice.body}</span>
    </div>
  );
};

export default DemoReplayNotice;
