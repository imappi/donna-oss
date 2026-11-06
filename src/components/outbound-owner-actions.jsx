// G15/D12 — the owner Actions surface: the workspace tab section the digest
// email deep-links into (/firms?entity=<id>&tab=actions). Renders THE SAME
// persisted state the digest gathers — the server read reuses
// gatherOwnerDigest + the digest's own display copy; this component displays
// and routes verbs, it never re-derives anything (render the persisted
// verdict).
//
// Sections mirror the digest: needs-approval (approve / don't send / edit —
// through the existing audited writers), must-review (failed / stale /
// escalated, with pause + dispute on cases), needs-info, sent-FYI
// (decide-and-notify — read-only except the ONE quiet corrective verb,
// "this was wrong" (the D1 reply_if_wrong recorder): an FYI must never
// become a click queue, and a correction record is not an approval flow —
// the send happened, nothing needs deciding), and the EARNED FYI.
//
// Quiet by design: a dark pipeline has no rows, and an all-empty surface
// renders nothing — the tab looks exactly as before for every client the
// outbound pipeline doesn't serve yet.

import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { T, D } from './shared/design-tokens.js';
import { BANK_FEED_SECTION_HEADING_STYLE } from './shared/bank-feed-list-style.js';
import {
  fetchOutboundOwnerActions, decideOutboundOwnerAction,
  editOutboundOwnerDraft, actOnOutboundOwnerCase,
  markOutboundOwnerActionWrong, reverseOutboundOwnerActionPost,
  setOutboundOwnerPartyLanguage, formatFirmError
} from '../lib/firmApi.js';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';
import { BidiText } from '../i18n/BidiText.jsx';

const EDIT_KEY_LABELS = {
  payment_instructions: 'mounted.ownerActions.edit.payment',
  owner_business_name: 'mounted.ownerActions.edit.business'
};

const sectionTitleStyle = BANK_FEED_SECTION_HEADING_STYLE;

const cardStyle = {
  background: 'transparent',
  border: 'none',
  borderBottom: `1px solid ${T.ruleSoft}`,
  borderRadius: 0,
  padding: '10px 16px',
  marginBottom: 0,
  fontFamily: D.ui,
  fontSize: 13,
  color: D.ink,
  lineHeight: 1.5
};

const buttonStyle = (variant) => ({
  font: 'inherit',
  fontFamily: D.ui,
  fontSize: 12,
  padding: '4px 12px',
  borderRadius: 999,
  cursor: 'pointer',
  border: `1px solid ${variant === 'primary' ? T.ink : T.rule}`,
  background: variant === 'primary' ? T.ink : 'transparent',
  color: variant === 'primary' ? T.paper : variant === 'danger' ? T.alert : T.inkSoft
});

const isEmptySurface = (surface) =>
  !surface
  || (!surface.pending.length && !surface.failed.length && !surface.stale.length
    && !surface.escalated.length && !surface.needs_input.length
    && !surface.auto_sent.length && !surface.earned.length
    && !(surface.blocked_recurrences || []).length
    && !(surface.blocked_invoices || []).length
    && !(surface.owner_replies || []).length);

const EditForm = ({ action, clientId, onDone, onError }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [values, setValues] = useState(() => ({ ...action.editable_values }));
  const [busy, setBusy] = useState(false);
  const keys = Object.keys(EDIT_KEY_LABELS).filter(
    (key) => key in action.editable_values || key === 'payment_instructions'
  );
  const save = async () => {
    const patch = {};
    for (const key of keys) {
      if ((values[key] ?? '') !== (action.editable_values[key] ?? '')) patch[key] = values[key] ?? '';
    }
    if (!Object.keys(patch).length) {
      onDone(false);
      return;
    }
    setBusy(true);
    try {
      await editOutboundOwnerDraft({ clientId, actionId: action.id, renderValues: patch });
      onDone(true);
    } catch (error) {
      onError(formatFirmError(error, message('mounted.ownerActions.editFailed')));
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.ruleSoft}` }}>
      {keys.map((key) => (
        <label key={key} style={{ display: 'block', marginBottom: 8 }}>
          <span style={{ display: 'block', fontSize: 11.5, color: T.muted, marginBottom: 2 }}>
            {message(EDIT_KEY_LABELS[key])}
          </span>
          <textarea
            value={values[key] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
            rows={key === 'payment_instructions' ? 3 : 1}
            style={{
              width: '100%', font: 'inherit', fontSize: 13, color: T.ink,
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 6,
              padding: '6px 8px', resize: 'vertical'
            }}
          />
        </label>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={buttonStyle('primary')} disabled={busy} onClick={save}>
          {message(busy ? 'mounted.ownerActions.saving' : 'mounted.ownerActions.save')}
        </button>
        <button type="button" style={buttonStyle()} disabled={busy} onClick={() => onDone(false)}>
          {message('mounted.ownerActions.cancel')}
        </button>
      </div>
    </div>
  );
};

const OutboundOwnerActions = ({ clientId, enabled = true }) => {
  const intl = useIntl();
  const { formatAmount } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [surface, setSurface] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [editingId, setEditingId] = useState(null);

  const reload = useCallback(async () => {
    if (!clientId || !enabled) return;
    try {
      const { surface: next } = await fetchOutboundOwnerActions({ clientId });
      setSurface(next);
      setError('');
    } catch (fetchError) {
      // A pre-outbound deploy (404) or unconfigured DB (503) leaves the tab
      // exactly as before — this surface is additive, never noisy.
      if (fetchError?.status === 404 || fetchError?.status === 503) {
        setSurface(null);
      } else {
        setError(formatFirmError(fetchError, intl.formatMessage({ id: 'mounted.ownerActions.loadFailed' })));
      }
    }
  }, [clientId, enabled, intl]);

  useEffect(() => {
    setSurface(null);
    setError('');
    setEditingId(null);
    void reload();
  }, [reload]);

  const decide = async (actionId, decision) => {
    setBusyId(actionId);
    try {
      await decideOutboundOwnerAction({ clientId, actionId, decision });
      await reload();
    } catch (decideError) {
      setError(formatFirmError(decideError, message('mounted.ownerActions.actionFailed')));
    } finally {
      setBusyId(null);
    }
  };

  const caseVerb = async (caseId, verb) => {
    setBusyId(caseId);
    try {
      await actOnOutboundOwnerCase({ clientId, caseId, verb });
      await reload();
    } catch (caseError) {
      setError(formatFirmError(caseError, message('mounted.ownerActions.actionFailed')));
    } finally {
      setBusyId(null);
    }
  };

  const markWrong = async (actionId) => {
    setBusyId(actionId);
    try {
      await markOutboundOwnerActionWrong({ clientId, actionId });
      await reload();
    } catch (markError) {
      setError(formatFirmError(markError, message('mounted.ownerActions.recordFailed')));
    } finally {
      setBusyId(null);
    }
  };

  const reversePost = async (actionId) => {
    setBusyId(actionId);
    try {
      await reverseOutboundOwnerActionPost({ clientId, actionId });
      await reload();
    } catch (reverseError) {
      setError(formatFirmError(reverseError, message('mounted.ownerActions.undoFailed')));
    } finally {
      setBusyId(null);
    }
  };

  const setPartyLanguage = async (actionId, attribute, language) => {
    setBusyId(actionId);
    try {
      await setOutboundOwnerPartyLanguage({ clientId, actionId, attribute, language });
      await reload();
    } catch (languageError) {
      setError(formatFirmError(languageError, message('mounted.ownerActions.languageFailed')));
    } finally {
      setBusyId(null);
    }
  };

  if (!enabled || !clientId) return null;
  if (isEmptySurface(surface) && !error) return null;

  const caseButtons = (caseRow) => (
    <span style={{ display: 'inline-flex', gap: 6, marginInlineStart: 10 }}>
      {['open', 'escalated'].includes(caseRow.status) && (
        <button
          type="button" style={buttonStyle()} disabled={busyId === caseRow.id}
          onClick={() => caseVerb(caseRow.id, 'pause')}
        >
          {message('mounted.ownerActions.pause')}
        </button>
      )}
      {['open', 'escalated', 'paused'].includes(caseRow.status) && (
        <button
          type="button" style={buttonStyle('danger')} disabled={busyId === caseRow.id}
          onClick={() => caseVerb(caseRow.id, 'dispute')}
        >
          {message('mounted.ownerActions.dispute')}
        </button>
      )}
    </span>
  );

  return (
    <section aria-label={message('mounted.ownerActions.aria')} style={{ maxWidth: 1080, margin: '0 auto', fontFamily: D.ui }}>
      {error && (
        <div style={{ ...cardStyle, borderColor: T.alert, color: T.alert }}>{error}</div>
      )}

      {surface?.pending.length > 0 && (
        <>
          <div style={sectionTitleStyle}>{message('mounted.ownerActions.needsApproval', { count: surface.pending.length })}</div>
          {surface.pending.map((action) => (
            <div key={action.id} style={cardStyle}>
              <div><BidiText direction="auto">{action.description}</BidiText></div>
              <div style={{ fontSize: 12, color: T.muted, margin: '2px 0 8px' }}><BidiText direction="auto">{action.hold_copy}</BidiText></div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button" style={buttonStyle('primary')}
                  disabled={busyId === action.id || action.approval_blocked}
                  onClick={() => decide(action.id, 'approve')}
                >
                  {message('mounted.ownerActions.approve')}
                </button>
                {action.approval_blocked && action.language?.fallback_options?.map((language) => (
                  <span key={language} style={{ display: 'contents' }}>
                    <button
                      type="button" style={buttonStyle()}
                      disabled={busyId === action.id}
                      onClick={() => setPartyLanguage(action.id, 'preferred_language', language)}
                    >
                      {message('mounted.ownerActions.changeLanguage', { language: String(language).toUpperCase() })}
                    </button>
                    <button
                      type="button" style={buttonStyle()}
                      disabled={busyId === action.id}
                      onClick={() => setPartyLanguage(action.id, 'fallback_language', language)}
                    >
                      {message('mounted.ownerActions.allowFallback', { language: String(language).toUpperCase() })}
                    </button>
                  </span>
                ))}
                <button
                  type="button" style={buttonStyle('danger')} disabled={busyId === action.id}
                  onClick={() => decide(action.id, 'decline')}
                >
                  {message('mounted.ownerActions.dontSend')}
                </button>
                <button
                  type="button" style={buttonStyle()} disabled={busyId === action.id}
                  onClick={() => setEditingId(editingId === action.id ? null : action.id)}
                >
                  {message(editingId === action.id ? 'mounted.ownerActions.closeEdit' : 'mounted.ownerActions.editDraft')}
                </button>
              </div>
              {editingId === action.id && (
                <EditForm
                  action={action}
                  clientId={clientId}
                  onDone={async (saved) => {
                    setEditingId(null);
                    if (saved) await reload();
                  }}
                  onError={setError}
                />
              )}
            </div>
          ))}
        </>
      )}

      {(surface?.blocked_invoices || []).length > 0 && (
        <>
          <div style={sectionTitleStyle}>{surface.blocked_invoices[0].heading}</div>
          {surface.blocked_invoices.map((action) => (
            <div key={action.id} style={cardStyle}>
              <div><BidiText direction="auto">{action.description}</BidiText></div>
              <div style={{ fontSize: 12, color: T.muted, margin: '2px 0 8px' }}>
                <BidiText direction="auto">{action.explanation}</BidiText>
              </div>
              <button type="button" style={buttonStyle('danger')} disabled={busyId === action.id}
                onClick={() => decide(action.id, 'decline')}>
                {action.stop_label}
              </button>
            </div>
          ))}
        </>
      )}

      {(surface?.blocked_recurrences || []).length > 0 && (
        <>
          <div style={sectionTitleStyle}>{surface.blocked_recurrences[0].heading}</div>
          {surface.blocked_recurrences.map((action) => (
            <div key={action.id} style={cardStyle}>
              <div><BidiText direction="auto">{action.description}</BidiText></div>
              <div style={{ fontSize: 12, color: T.muted, margin: '2px 0 8px' }}>
                <BidiText direction="auto">{action.explanation}</BidiText>
              </div>
              <button type="button" style={buttonStyle('danger')} disabled={busyId === action.id}
                onClick={() => decide(action.id, 'decline')}>
                {action.stop_label}
              </button>
            </div>
          ))}
        </>
      )}

      {(surface?.failed.length > 0 || surface?.stale.length > 0 || surface?.escalated.length > 0) && (
        <>
          <div style={sectionTitleStyle}>
            {message('mounted.ownerActions.mustReview', { count: surface.failed.length + surface.stale.length + surface.escalated.length })}
          </div>
          {surface.failed.map((action) => (
            <div key={action.id} style={cardStyle}>
              {message('mounted.ownerActions.failed', {
                description: action.description,
                error: action.send_error ? ` (${action.send_error})` : ''
              })}
            </div>
          ))}
          {surface.stale.map((action) => (
            <div key={action.id} style={cardStyle}>
              {message('mounted.ownerActions.stale', { party: action.party_name || message('mounted.ownerActions.customer') })}
            </div>
          ))}
          {surface.escalated.map((caseRow) => (
            <div key={caseRow.id} style={cardStyle}>
              {message('mounted.ownerActions.escalated', { invoice: caseRow.invoice_number || caseRow.anchor_id, count: caseRow.current_step })}
              {caseButtons(caseRow)}
            </div>
          ))}
        </>
      )}

      {surface?.needs_input.length > 0 && (
        <>
          <div style={sectionTitleStyle}>{message('mounted.ownerActions.needsInfo', { count: surface.needs_input.length })}</div>
          {surface.needs_input.map((caseRow) => (
            <div key={caseRow.id} style={cardStyle}>
              {message('mounted.ownerActions.invoiceGaps', {
                invoice: caseRow.invoice_number || caseRow.anchor_id,
                amount: caseRow.amount != null ? ` (${formatAmount(caseRow.amount, { currency: caseRow.currency || undefined })})` : '',
                gaps: caseRow.gaps.map((g) => g.copy).join('; ')
              })}
              {caseButtons(caseRow)}
            </div>
          ))}
        </>
      )}

      {(surface?.owner_replies?.length || 0) > 0 && (
        <>
          <div style={sectionTitleStyle}>{message('mounted.ownerActions.aboutReplies', { count: surface.owner_replies.length })}</div>
          <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 6 }}>
            {message('mounted.ownerActions.aboutRepliesDesc')}
          </div>
          {surface.owner_replies.map((reply) => (
            <div key={reply.id} style={{ ...cardStyle, color: T.inkSoft }}>
              <BidiText direction="auto">{reply.description}</BidiText>
            </div>
          ))}
        </>
      )}

      {surface?.auto_sent.length > 0 && (
        <>
          <div style={sectionTitleStyle}>{message('mounted.ownerActions.sentForYou', { count: surface.auto_sent.length })}</div>
          <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 6 }}>
            {message('mounted.ownerActions.sentForYouDesc')}
          </div>
          {surface.auto_sent.map((action) => (
            <div key={action.id} style={{ ...cardStyle, color: T.inkSoft }}>
              <BidiText direction="auto">{action.description}</BidiText>
              {action.marked_wrong_at ? (
                <span style={{ fontSize: 12, color: T.muted, marginInlineStart: 10 }}>
                  {message('mounted.ownerActions.markedWrong')}
                </span>
              ) : (
                <button
                  type="button" style={{ ...buttonStyle(), marginInlineStart: 10 }}
                  disabled={busyId === action.id}
                  onClick={() => markWrong(action.id)}
                >
                  {message('mounted.ownerActions.thisWasWrong')}
                </button>
              )}
              {action.ar_journal_id && (action.ar_post_reversed_at ? (
                <span style={{ fontSize: 12, color: T.muted, marginInlineStart: 10 }}>
                  {message('mounted.ownerActions.booksUndone')}
                </span>
              ) : (
                <button
                  type="button" style={{ ...buttonStyle(), marginInlineStart: 10 }}
                  disabled={busyId === action.id}
                  onClick={() => reversePost(action.id)}
                >
                  {message('mounted.ownerActions.undoBooks')}
                </button>
              ))}
            </div>
          ))}
        </>
      )}

      {surface?.earned.length > 0 && (
        <>
          <div style={sectionTitleStyle}>{message('mounted.ownerActions.fyi')}</div>
          {surface.earned.map((row) => (
            <div key={row.id} style={{ ...cardStyle, color: T.inkSoft }}>
              {message('mounted.ownerActions.earned', { label: row.label, count: row.clean_streak })}
            </div>
          ))}
        </>
      )}
    </section>
  );
};

export default OutboundOwnerActions;
