import React, { useEffect, useState } from 'react';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';

// The replay demo's notice (`npm run demo:fi`, scripts/demo_fi.mjs). Shown on
// every screen while the book holds the stored record that it was given
// recorded model outputs (provider_replay_sessions, migration 205), which
// the public health route returns as `provider_replay`. A normal book has no
// such record and this renders nothing. Mounted from src/main.jsx beside
// <App />, so it is above the sign-in screen, the firm view and the portal.
// Its own two-language text, not the interface catalog: the notice belongs to
// a demo command, not to the product's release-gated surfaces (whose catalogs
// are frozen per release), and it must read the same in every language the
// demo runs in.
export const DEMO_REPLAY_TEXT = Object.freeze({
  en: Object.freeze({
    title: 'Demo: recorded model outputs',
    body: (models, recordedAt) => `This book was read, coded and matched from answers recorded earlier (${models}, recorded ${recordedAt}). No model is called and no key is used.`
  }),
  fi: Object.freeze({
    title: 'Demo: recorded model outputs · tallennetut mallivastaukset',
    body: (models, recordedAt) => `Tämä kirjanpito on luettu, kirjattu ja täsmäytetty aiemmin tallennetuista vastauksista (${models}, tallennettu ${recordedAt}). Mallia ei kutsuta eikä avainta käytetä.`
  })
});

export const describeRecordedModels = (models) =>
  Object.values(models || {}).flat().filter(Boolean).join(', ');

const DemoReplayNotice = ({ fetchImpl = (...args) => fetch(...args) }) => {
  const { locale } = useInterfaceLocale();
  const [session, setSession] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchImpl('/api/donna/firms/health')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (!cancelled) setSession(body?.provider_replay || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fetchImpl]);
  if (!session) return null;
  const models = describeRecordedModels(session.recorded_models) || '—';
  const text = String(locale || '').startsWith('fi') ? DEMO_REPLAY_TEXT.fi : DEMO_REPLAY_TEXT.en;
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
      <strong style={{ display: 'block' }}>{text.title}</strong>
      <span style={{ opacity: 0.85 }}>{text.body(models, session.recorded_at || '—')}</span>
    </div>
  );
};

export default DemoReplayNotice;
