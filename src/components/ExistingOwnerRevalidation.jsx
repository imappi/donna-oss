import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { getAuthSessionEpoch, hasStoredAuth } from '../lib/accessToken.js';
import { getBookPrincipalId, getBookSessionIdentity } from '../lib/bookSessionIdentity.js';
import { revalidateExistingOwnerWorkspace } from '../lib/selfProvision.js';
import { IdentifierText } from '../i18n/BidiText.jsx';
import { D } from './shared/design-tokens.js';
import { btnChip, btnPrimary } from './shared/buttons.js';

const sessionKey = () => JSON.stringify([getBookSessionIdentity(), getAuthSessionEpoch()]);

function OwnerConfirmation({ identity, onSessionChanged }) {
  const intl = useIntl();
  const m = key => intl.formatMessage({ id: `mounted.ownerRevalidation.${key}` });
  const [review, setReview] = useState(null), [receipt, setReceipt] = useState(null);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), pending = useRef(null), generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; pending.current?.abort(); }; }, []);
  const run = async action => {
    if (sessionKey() !== identity) { onSessionChanged(); return; }
    if (busy || !getBookPrincipalId() || (['confirm','recovery_request'].includes(action) && (!review || !confirmed))) return;
    const controller = new AbortController(), attempt = ++generation.current; pending.current = controller;
    const current = () => alive.current && generation.current === attempt && !controller.signal.aborted && sessionKey() === identity;
    const timer = setTimeout(() => controller.abort(), 20_000);
    setBusy(true); setError(''); setReceipt(null);
    try {
      const result = await revalidateExistingOwnerWorkspace({ action, confirmed: action === 'recovery_cancel' || confirmed, reviewDigest: review?.review_digest || receipt?.review_digest, signal: controller.signal });
      if (!current()) { if (alive.current && sessionKey() !== identity) onSessionChanged(); return; }
      if (result?.actor_id !== getBookPrincipalId() || !result?.firm_id || !result?.client_id
        || result.purpose !== (action.startsWith('recovery_') ? 'deleted_owner_recovery' : 'existing_empty_owner_revalidation') || result.jurisdiction !== 'FI' || result.entity_type !== 'fi-oy'
        || !/^[a-f0-9]{64}$/.test(result.review_digest || '') || !result.company_name
        || (action === 'confirm' && (result.client_id !== review.client_id || result.firm_id !== review.firm_id
          || result.review_digest !== review.review_digest || !(result.receipt_id > 0)
          || !Number.isFinite(Date.parse(result.expires_at))))) {
        throw new Error(intl.formatMessage({ id: 'mounted.pilot.invalidResponse' }));
      }
      if ((action === 'recovery_request' && (result.pending !== true || result.review_digest !== review.review_digest))
        || (action === 'recovery_cancel' && result.cancelled !== true)) throw new Error(m('invalidRecovery'));
      if (result.pending && (!(result.receipt_id > 0) || !Number.isFinite(Date.parse(result.expires_at)))) throw new Error(m('invalidRecovery'));
      setRecoveryAvailable(false);
      if (['review','recovery_review'].includes(action) && !result.pending) { setReview(result); setConfirmed(false); }
      else { setReceipt(result); setReview(null); setConfirmed(false); }
    } catch (failure) {
      if (alive.current && generation.current === attempt && sessionKey() === identity) {
        setReview(null); setConfirmed(false);
        setRecoveryAvailable(failure.code === 'OWNER_REVALIDATION_IDENTITY_REQUIRED' || action.startsWith('recovery_'));
        setError(failure.name === 'AbortError' ? intl.formatMessage({ id: 'mounted.pilot.timeout' }) : failure.message);
      }
    } finally {
      clearTimeout(timer); if (pending.current === controller) pending.current = null;
      if (alive.current && generation.current === attempt) {
        if (sessionKey() !== identity) onSessionChanged();
        else setBusy(false);
      }
    }
  };
  useEffect(() => { if (hasStoredAuth()) void run('review'); }, []);
  return <section aria-label={m('title')} aria-busy={busy}>
    <h1 style={{ fontSize: 24 }}>{m('title')}</h1><p>{m('intro')}</p>
    {!getBookPrincipalId() && <p><a href="/?auth=signin">{m('signIn')}</a></p>}
    {busy && <p role="status">{m('working')}</p>}
    {error && <p role="alert" style={{ color: D.alert }}>{error}</p>}
    {recoveryAvailable && <button type="button" style={btnChip} disabled={busy} onClick={() => run('recovery_review')}>{m('recoveryReview')}</button>}
    {review && <>
      <h2 style={{ fontSize: 20 }}><IdentifierText>{review.company_name}</IdentifierText></h2>
      <p><IdentifierText>{review.owner_email}</IdentifierText></p><p>{m('scope')}</p>
      {review.purpose === 'deleted_owner_recovery' && <p>{m('recoveryIntro')}</p>}
      <label style={{ display: 'flex', gap: 10, alignItems: 'start', marginBlock: 20 }}>
        <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{m(review.purpose === 'deleted_owner_recovery' ? 'recoveryConsent' : 'confirm')}
      </label>
      <button type="button" style={btnPrimary} disabled={busy || !confirmed} onClick={() => run(review.purpose === 'deleted_owner_recovery' ? 'recovery_request' : 'confirm')}>{m(review.purpose === 'deleted_owner_recovery' ? 'recoveryRequest' : 'apply')}</button>
    </>}
    {receipt && <div role="status"><h2>{m(receipt.cancelled ? 'recoveryCancelled' : receipt.pending ? 'recoveryPending' : 'recorded')}</h2>
      <p><IdentifierText>{receipt.company_name}</IdentifierText>{' · '}<IdentifierText>{receipt.owner_email}</IdentifierText></p>
      <p>{m(receipt.pending ? 'recoveryNext' : receipt.cancelled ? 'recoveryCancelledNext' : 'next')}</p>
      {receipt.pending && <button type="button" disabled={busy} style={btnChip} onClick={() => run('recovery_cancel')}>{m('recoveryCancel')}</button>}
      {receipt.expires_at && <p>{m('expires')} <time dateTime={receipt.expires_at}>{intl.formatDate(receipt.expires_at, { dateStyle: 'medium', timeStyle: 'short' })}</time></p>}
    </div>}
    {getBookPrincipalId() && <button type="button" style={{ ...btnChip, marginBlock: 20 }} disabled={busy} onClick={() => run('review')}>{m('review')}</button>}
  </section>;
}

export default function ExistingOwnerRevalidation() {
  const [identity, setIdentity] = useState(sessionKey), [revision, setRevision] = useState(0);
  const changed = () => { setIdentity(sessionKey()); setRevision(value => value + 1); };
  useEffect(() => {
    const storage = event => { if (!event.key || event.key === 'donna.auth_session.v1' || event.key === 'donna.access_token.v1') changed(); };
    const focus = () => { if (sessionKey() !== identity) changed(); };
    window.addEventListener('storage', storage); window.addEventListener('focus', focus);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('focus', focus); };
  }, [identity]);
  return <main style={{ maxWidth: 560, marginInline: 'auto', padding: 'clamp(20px, 5vw, 48px)', color: D.ink,
    fontFamily: D.body, overflowWrap: 'anywhere' }}>
    <OwnerConfirmation key={`${identity}:${revision}`} identity={identity} onSessionChanged={changed} />
  </main>;
}
