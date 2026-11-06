import OwnerCompanySetup from './OwnerCompanySetup.jsx';
// Subscription gate for the client portal.
//
// Wraps <ClientPortal>. On mount it reads /api/donna/billing/status for the
// client and decides whether to render the portal or a paywall:
//
//   - entitled (active/trialing, OR billing disabled) → render the portal.
//   - billing enabled AND not entitled            → render the paywall.
//   - status still loading                        → a quiet placeholder.
//   - status fetch ERRORED                        → FAIL OPEN (render the
//     portal). Locking a paying owner out over a transient status blip is
//     worse than letting one unpaid session through; the paywall is a UX gate,
//     not the security boundary. The boundary is server-side: the portal's
//     value/write endpoints (documents/register, evidence resolve, profile,
//     xero/connect) 402 a non-entitled client-scoped caller via
//     assertClientEntitled (clientSubscriptionDb.js), so a direct API call
//     can't bypass this gate. That enforcement is a no-op until billing is
//     enabled, exactly like this gate's fail-open default.
//
// After a successful Checkout, Stripe redirects back with ?billing=success and
// the webhook writes the mirror asynchronously, so we briefly poll status so
// the portal opens without a manual refresh.
//
// The owner checkout is retired (Kari, 2026-10-21: "take the owner checkout
// down"). Donna sells only to accounting firms, so a business never buys a
// plan here: a non-entitled client is told its accounting firm gives it
// access, and an earlier customer can still open the billing portal to manage
// or cancel. The server refuses /billing/checkout with 410.

import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import { D } from './shared/design-tokens.js';
import { fetchBillingStatus, openBillingPortal } from '../lib/billingApi.js';
import { clearPendingOffer } from '../lib/pendingOffer.js';
import { trackEvent } from '../lib/analytics.js';
import { BidiText } from '../i18n/BidiText.jsx';
import { getAuthSessionEpoch } from '../lib/accessToken.js';
import { getBookSessionIdentity } from '../lib/bookSessionIdentity.js';

const sessionKey = () => `${getAuthSessionEpoch()}:${getBookSessionIdentity()}`;

const readBillingReturnFlag = () => {
  if (typeof window === 'undefined') return null;
  const flag = new URLSearchParams(window.location.search).get('billing');
  return flag === 'success' || flag === 'cancelled' ? flag : null;
};

function ClientPortalGateContent({ clientId, children, identity, onSessionChanged }) {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  // null = still loading; otherwise the status payload.
  const [status, setStatus] = useState(null);
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const returnFlag = useRef(readBillingReturnFlag());
  const pollRef = useRef({ attempts: 0 });
  // An offer an older funnel stashed before account creation has nothing to
  // redeem into any more; drop it so it never resurfaces.
  useEffect(() => { clearPendingOffer(); }, []);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const isCurrent = () => alive.current && identity === sessionKey();

  // Funnel terminal: Stripe redirects back with ?billing=success after a paid
  // checkout. Fire once (guarded against StrictMode's double-mount) so the
  // started -> succeeded conversion is measurable. Coarse event, no PII.
  const succeededTrackedRef = useRef(false);
  useEffect(() => {
    if (returnFlag.current === 'success' && !succeededTrackedRef.current) {
      succeededTrackedRef.current = true;
      trackEvent('checkout_succeeded');
    }
  }, []);

  useEffect(() => {
    if (!clientId) return undefined;
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      try {
        const next = await fetchBillingStatus(clientId, { signal: controller.signal });
        if (cancelled || !isCurrent()) { if (!cancelled) onSessionChanged(); return; }
        setStatus(next);
        setLoadError(false);
        // Returned from a successful checkout but the webhook mirror hasn't
        // landed yet — poll a few times before giving up and showing the paywall.
        if (returnFlag.current === 'success' && next.billing_enabled && !next.entitled && pollRef.current.attempts < 5) {
          pollRef.current.attempts += 1;
          setTimeout(() => { if (!cancelled) load(); }, 2000);
        }
      } catch (err) {
        if (!cancelled && err.code === 'AUTH_SESSION_CHANGED') { onSessionChanged(); return; }
        if (cancelled || err.name === 'AbortError') return;
        // Fail open.
        setLoadError(true);
      }
    };

    load();
    return () => { cancelled = true; controller.abort(); };
  }, [clientId, revision]);

  // Fail open: errored status, or no client id to check.
  if (loadError || !clientId) return children;

  // Still loading — quiet placeholder rather than a flash of either surface.
  if (!status) {
    return (
      <div
        style={{
          minHeight: '100vh',
          backgroundColor: D.paper,
          color: D.inkSoft,
          fontFamily: D.mono,
          fontSize: 11,
          letterSpacing: D.tracking.mono,
          textTransform: 'uppercase',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {message('mounted.billing.loading')}
      </div>
    );
  }

  // A firm member / admin (unrestricted) viewing a client's portal is never
  // paywalled — they service unpaid clients (e.g. feeding docs for a brand-new
  // client). Only a client-scoped owner sees the paywall. Mirrors the
  // server-side assertClientEntitled exemption.
  if (status.viewer_unrestricted) return children;

  // Company facts precede billing. A Finnish invitation is not a paid plan:
  // the operator's existing client-scoped grant still controls all uploads.
  if (status.company_setup_required || status.pilot_pending) {
    return <OwnerCompanySetup key={clientId} clientId={clientId} status={status}
      onSessionChanged={onSessionChanged} isCurrent={isCurrent}
      onRefresh={() => { setStatus(null); setRevision(value => value + 1); }} />;
  }
  if (status.entitled) return children;

  // Billing enabled and not entitled → paywall.
  const isReturningCustomer = Boolean(status.has_customer);

  const handleManage = async () => {
    if (!isCurrent()) { onSessionChanged(); return; }
    setActionBusy(true);
    setActionError('');
    try {
      const url = await openBillingPortal(clientId);
      if (!isCurrent()) return;
      if (url) window.location.href = url;
      else throw new Error('Billing portal did not return a URL.');
    } catch (err) {
      if (!isCurrent()) { if (alive.current) onSessionChanged(); return; }
      setActionError(err.message || message('mounted.billing.portalError'));
      setActionBusy(false);
    }
  };

  const primaryButtonStyle = {
    appearance: 'none',
    width: '100%',
    border: 'none',
    borderRadius: 0,
    padding: '0.9rem 1.25rem',
    backgroundColor: D.accentWarmFlat,
    color: D.ink,
    fontFamily: D.mono,
    fontSize: 12,
    letterSpacing: D.tracking.mono,
    textTransform: 'uppercase',
    fontWeight: 600,
    cursor: actionBusy ? 'wait' : 'pointer',
    opacity: actionBusy ? 0.7 : 1
  };
  return (
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
      <main style={{ width: '100%', maxWidth: 460 }}>
        <span
          style={{
            fontFamily: D.display,
            fontWeight: 400,
            fontSize: 30,
            letterSpacing: '-0.05em',
            lineHeight: 0.85,
            textTransform: 'uppercase',
            color: D.ink,
            display: 'block'
          }}
        >
          Donna
        </span>

        <h1
          style={{
            fontFamily: D.body,
            fontSize: 'clamp(1.4rem, 4vw, 1.85rem)',
            lineHeight: 1.2,
            fontWeight: 600,
            margin: '1.5rem 0 0.75rem'
          }}
        >
          {message(isReturningCustomer ? 'mounted.billing.inactive' : 'mounted.billing.start')}
        </h1>

        <p style={{ fontSize: '0.95rem', lineHeight: 1.55, color: D.inkSoft, margin: 0 }}>
          {message(isReturningCustomer ? 'mounted.billing.returningBody' : 'mounted.billing.startBody')}
        </p>

        <div style={{ height: '1.5rem' }} />

        {/* Earlier customer with a Stripe customer on file → manage or cancel
            their existing billing. Nothing new can be bought here. */}
        {isReturningCustomer && (
          <button type="button" onClick={handleManage} disabled={actionBusy} style={primaryButtonStyle}>
            {message(actionBusy ? 'mounted.billing.opening' : 'mounted.billing.manage')}
          </button>
        )}

        {actionError && (
          <p style={{ marginTop: '0.9rem', fontSize: '0.85rem', color: D.accent || D.ink }}>
            <BidiText direction="auto">{actionError}</BidiText>
          </p>
        )}
      </main>
    </div>
  );
}

export default function ClientPortalGate(props) {
  const [identity, setIdentity] = useState(sessionKey);
  const changed = () => setIdentity(sessionKey());
  useEffect(() => {
    const storage = event => { if (!event.key || ['donna.auth_session.v1', 'donna.access_token.v1'].includes(event.key)) changed(); };
    window.addEventListener('storage', storage);
    window.addEventListener('focus', changed);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('focus', changed); };
  }, []);
  return <ClientPortalGateContent key={`${props.clientId}:${identity}`} {...props} identity={identity} onSessionChanged={changed} />;
}
