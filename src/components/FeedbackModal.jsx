// The Feedback modal — the app's "tell the maker" surface (Kari, 2026-08-05).
// Reference geometry is Slack's browse-channels modal: one centered white
// card on a dimmed scrim, generous radius, no chrome beyond a title row and
// a close ×. Content follows the house voice: three kinds spoken as a human
// would ("Something broke / An idea / Just a thought"), one textarea whose
// placeholder answers "what do I write here", and a context line that makes
// bug notes reproducible without interrogating the user.
//
// Chip-law compliant: the segmented kind control speaks in INK (selected =
// ink fill, unselected = hairline), no hued pills; the one D.alert use is a
// genuine failure (the send failed).
//
// The submission lands in user_feedback (migration 115) via
// POST /api/donna/firms/feedback — resting state 'new' is ON KARI
// (two-terminal-states, applied to the meta-product lane).

import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import { formatFirmError, submitFeedback } from '../lib/firmApi.js';
import { isDesktopShell } from '../lib/desktopShell.js';
import { D } from './shared/design-tokens.js';
import { BidiText } from '../i18n/BidiText.jsx';

const KINDS = [
  { value: 'bug', labelId: 'feedback.kind.bug', placeholderId: 'feedback.placeholder.bug' },
  { value: 'idea', labelId: 'feedback.kind.idea', placeholderId: 'feedback.placeholder.idea' },
  { value: 'note', labelId: 'feedback.kind.note', placeholderId: 'feedback.placeholder.note' }
];

// Closing the modal with text in it must not eat the draft — held at module
// scope so an accidental scrim click or Esc restores on reopen. Cleared on a
// successful send.
let heldDraft = '';
let heldKind = 'note';

const FeedbackModal = ({ context = {}, onClose }) => {
  const intl = useIntl();
  const messageFor = (id) => intl.formatMessage({ id });
  const [kind, setKind] = useState(heldKind);
  const [message, setMessage] = useState(heldDraft);
  const [attachContext, setAttachContext] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useRef(null);
  const dialogRef = useRef(null);
  const returnFocusRef = useRef(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    textareaRef.current?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  useEffect(() => {
    heldDraft = sent ? '' : message;
    heldKind = sent ? 'note' : kind;
  }, [message, kind, sent]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]'
      ) || []).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The thank-you beat: long enough to land, short enough to stay out of
  // the way.
  useEffect(() => {
    if (!sent) return undefined;
    const timer = setTimeout(onClose, 1600);
    return () => clearTimeout(timer);
  }, [sent, onClose]);

  const canSend = Boolean(message.trim()) && !sending;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      await submitFeedback({
        kind,
        message,
        context: attachContext
          ? {
              ...context,
              shell: isDesktopShell() ? 'desktop' : 'web',
              viewport: `${window.innerWidth}x${window.innerHeight}`,
              user_agent: navigator.userAgent
            }
          : undefined
      });
      setSent(true);
    } catch (err) {
      setError(formatFirmError(err, messageFor('feedback.error.send')));
    } finally {
      setSending(false);
    }
  };

  const activeKind = KINDS.find((entry) => entry.value === kind) || KINDS[2];

  return (
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'oklch(0.08 0 0 / 0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={messageFor('feedback.dialog.aria')}
        style={{
          width: 'min(560px, 100%)',
          background: D.card,
          borderRadius: D.panelRadius,
          boxShadow: '0 2px 8px oklch(0.08 0 0 / 0.08), 0 24px 64px oklch(0.08 0 0 / 0.22)',
          padding: '24px 26px',
          fontFamily: D.ui,
          color: D.ink
        }}
      >
        {sent ? (
          <div style={{ padding: '28px 0 32px', textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{messageFor('feedback.sent.title')}</div>
            <div style={{ fontSize: 13.5, color: D.inkSoft, marginTop: 8 }}>
              {messageFor('feedback.sent.body')}
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>
                  {messageFor('feedback.title')}
                </div>
                <div style={{ fontSize: 13, color: D.inkSoft, marginTop: 5, lineHeight: 1.5 }}>
                  {messageFor('feedback.subtitle')}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={messageFor('feedback.close')}
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: D.inkMute,
                  cursor: 'pointer',
                  fontSize: 18,
                  lineHeight: 1,
                  flex: '0 0 auto'
                }}
              >
                ×
              </button>
            </div>

            <div role="radiogroup" aria-label={messageFor('feedback.kind.aria')} style={{ display: 'flex', gap: 6, marginTop: 18, flexWrap: 'wrap' }}>
              {KINDS.map((entry) => {
                const selected = entry.value === kind;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setKind(entry.value)}
                    style={{
                      font: 'inherit',
                      fontSize: 12.5,
                      fontWeight: 500,
                      padding: '6px 13px',
                      borderRadius: 999,
                      cursor: 'pointer',
                      border: `1px solid ${selected ? D.ink : D.ruleSoft}`,
                      background: selected ? D.ink : 'transparent',
                      color: selected ? D.paper : D.inkSoft
                    }}
                  >
                    {messageFor(entry.labelId)}
                  </button>
                );
              })}
            </div>

            <textarea
              ref={textareaRef}
              dir="auto"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder={messageFor(activeKind.placeholderId)}
              rows={5}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                marginTop: 14,
                padding: '11px 13px',
                fontFamily: 'inherit',
                fontSize: 14,
                lineHeight: 1.5,
                color: D.ink,
                background: D.card,
                border: `1px solid ${D.rule}`,
                borderRadius: 10,
                resize: 'none',
                outline: 'none'
              }}
            />

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 10,
                fontSize: 12.5,
                color: D.inkMute,
                cursor: 'pointer',
                userSelect: 'none'
              }}
            >
              <input
                type="checkbox"
                checked={attachContext}
                onChange={(event) => setAttachContext(event.target.checked)}
                style={{ margin: 0, accentColor: 'oklch(0.08 0 0)' }}
              />
              {messageFor('feedback.attachContext')}
            </label>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
              <div style={{ flex: 1, fontSize: 12.5, color: D.alert }}>
                {error ? <BidiText direction="auto">{error}</BidiText> : null}
              </div>
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                title={messageFor('feedback.sendShortcut')}
                style={{
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: 500,
                  padding: '8px 20px',
                  borderRadius: 999,
                  border: 'none',
                  cursor: canSend ? 'pointer' : 'default',
                  background: D.ink,
                  color: D.paper,
                  opacity: canSend ? 1 : 0.4,
                  letterSpacing: '0.02em'
                }}
              >
                {sending ? messageFor('feedback.sending') : messageFor('feedback.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default FeedbackModal;
