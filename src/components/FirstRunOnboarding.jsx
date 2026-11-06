// Gate 3 — the first-run onboarding pane. Rendered (App.jsx) only when
// resolveFirstRunRequired says so: desktop shell, a genuine database
// snapshot, and no firm row — a virgin appliance. One job: mint the firm +
// the owner member (POST /api/donna/firms/first-run), then hand back to the
// normal flow ("Add venture" now has a firm to land on). Visual language
// follows EmptyFirmState (FirmOpsConsole.jsx): quiet card, one primary CTA,
// no marketing.
//
// `web` mode (2026-09-16): the SAME pane serves the hosted accounting-firm
// signup — a verified Supabase identity with no workspace names its firm and
// itself, and /self-provision {workspace:'firm'} mints its own firm with that
// identity as administrator (server: firmSelfProvision.js). Email comes from
// the session (never typed), the jurisdiction is the hosted pilot's supported
// scope (FI), and a repeat submit returns the same firm.

import { useState } from 'react';
import { useIntl } from 'react-intl';
import { D } from './shared/design-tokens.js';
import { createFirstRunFirm } from '../lib/firmApi.js';
import { provisionFirmWorkspace } from '../lib/selfProvision.js';
import { BidiText } from '../i18n/BidiText.jsx';

// Kept in lockstep with FIRST_RUN_JURISDICTIONS (server/donna/desktop/
// firstRunFirmMint.js) — the server is the authority; this list only feeds
// the select. Currency derives server-side when omitted.
const JURISDICTIONS = [
  { code: 'GB', currency: 'GBP' },
  { code: 'SG', currency: 'SGD' },
  { code: 'FI', currency: 'EUR' },
  { code: 'US', currency: 'USD' }
];

const fieldStyle = {
  width: '100%',
  font: 'inherit',
  fontSize: 13.5,
  padding: '9px 12px',
  borderRadius: 8,
  border: `1px solid ${D.rule}`,
  background: D.paper,
  color: D.ink,
  boxSizing: 'border-box'
};

const labelStyle = {
  display: 'block',
  textAlign: 'start',
  fontSize: 12,
  fontWeight: 500,
  color: D.inkMute,
  margin: '0 0 5px'
};

export default function FirstRunOnboarding({ onProvisioned, web = false, sessionEmail = '', onSignOut = null }) {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [firmName, setFirmName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState(web ? sessionEmail : '');
  const [jurisdiction, setJurisdiction] = useState(web ? 'FI' : 'GB');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const currency = JURISDICTIONS.find((j) => j.code === jurisdiction)?.currency || '';
  const ready = firmName.trim() && ownerName.trim() && (web || /@/.test(ownerEmail)) && !submitting;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = web
        ? await provisionFirmWorkspace({ firmName: firmName.trim(), ownerName: ownerName.trim() })
        : await createFirstRunFirm({
          firmName: firmName.trim(),
          ownerName: ownerName.trim(),
          ownerEmail: ownerEmail.trim(),
          jurisdiction
        });
      if (onProvisioned) await onProvisioned(result);
    } catch (e) {
      // A 409 means a firm appeared since the snapshot (e.g. a second
      // window finished onboarding) — that is success for the user's
      // purpose, so refetch rather than scold. On the web a 409 is a typed
      // refusal (owner-portal identity, ambiguous membership): show it.
      if (e?.status === 409 && !web) {
        if (onProvisioned) await onProvisioned(null);
      } else {
        setError(e?.message || message('onboarding.error.setup'));
        setSubmitting(false);
      }
    }
  };

  return (
    <section
      aria-label={message('onboarding.aria')}
      style={{
        background: D.paper,
        minHeight: '100%',
        fontFamily: D.ui,
        color: D.ink,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px'
      }}
    >
      <form
        onSubmit={submit}
        style={{
          maxWidth: 440,
          width: '100%',
          background: D.card,
          border: `1px solid ${D.rule}`,
          borderRadius: 16,
          padding: '40px 36px',
          textAlign: 'center'
        }}
      >
        <h1
          style={{
            fontFamily: D.ui,
            fontWeight: 600,
            fontSize: 22,
            letterSpacing: '-0.01em',
            color: D.ink,
            margin: '0 0 10px',
            lineHeight: 1.15
          }}
        >
          {message('onboarding.title')}
        </h1>
        <p style={{ margin: '0 auto 26px', maxWidth: 360, fontSize: 13.5, color: D.inkMute, lineHeight: 1.6 }}>
          {message(web ? 'onboarding.web.body' : 'onboarding.body')}
        </p>

        <div style={{ display: 'grid', gap: 14, textAlign: 'start', marginBottom: 22 }}>
          <div>
            <label htmlFor="fr-firm" style={labelStyle}>{message('onboarding.firm.label')}</label>
            <input
              id="fr-firm"
              dir="auto"
              style={fieldStyle}
              value={firmName}
              onChange={(e) => setFirmName(e.target.value)}
              placeholder={message('onboarding.firm.placeholder')}
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="fr-name" style={labelStyle}>{message('onboarding.owner.label')}</label>
            <input
              id="fr-name"
              dir="auto"
              style={fieldStyle}
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
            />
          </div>
          {web ? (
            <p style={{ margin: 0, fontSize: 12.5, color: D.inkMute }} dir="ltr">
              {message('onboarding.web.signedInAs', { email: sessionEmail })}
              {onSignOut ? (
                <>
                  {' · '}
                  <button type="button" onClick={onSignOut} style={{ font: 'inherit', background: 'none', border: 'none', padding: 0, color: D.ink, cursor: 'pointer', textDecoration: 'underline' }}>
                    {message('auth.pending.otherEmail')}
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          <div style={web ? { display: 'none' } : undefined}>
            <label htmlFor="fr-email" style={labelStyle}>{message('onboarding.email.label')}</label>
            <input
              id="fr-email"
              type="email"
              dir="ltr"
              style={fieldStyle}
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
          </div>
          <div style={web ? { display: 'none' } : undefined}>
            <label htmlFor="fr-jur" style={labelStyle}>
              {message('onboarding.jurisdiction.label', { currency })}
            </label>
            <select
              id="fr-jur"
              style={fieldStyle}
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
            >
              {JURISDICTIONS.map((j) => (
                <option key={j.code} value={j.code}>
                  {message(`onboarding.jurisdiction.${j.code}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error ? (
          <p role="alert" style={{ margin: '0 0 16px', fontSize: 12.5, color: D.bad || '#b3261e', lineHeight: 1.5 }}>
            <BidiText direction="auto">{error}</BidiText>
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!ready}
          style={{
            font: 'inherit',
            fontSize: 13.5,
            fontWeight: 500,
            padding: '10px 22px',
            borderRadius: 999,
            border: 'none',
            background: D.ink,
            color: D.paper,
            cursor: ready ? 'pointer' : 'not-allowed',
            opacity: ready ? 1 : 0.6
          }}
        >
          {submitting ? message('onboarding.submit.busy') : message('onboarding.submit.idle')}
        </button>
      </form>
    </section>
  );
}
