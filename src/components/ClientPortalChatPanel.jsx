// Client-portal chat panel — the business owner's conversation with
// Donna, rendered as a right-side slide-over inside the client portal
// (donna-client-portal.jsx mounts it; that component IS the live portal,
// per the wire-into-the-mounted-surface rail).
//
// The panel remains read-only for owner-intent candidates: it can render
// staged suggestions and existing evidence-answer cards, but it never
// promotes memory, materializes authority, or runs accounting mutations.
// Dossier (D) vocabulary throughout: paper/ink, hairline rules, mono caps, no
// rounded corners beyond the shared radius.

import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import { BidiText, FormattedValue } from '../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';
import { D } from './shared/design-tokens.js';
import {
  ownerIntentBlockerLabel,
  ownerIntentKindLabel,
  ownerIntentStatusLabel,
  portalChannelLabel
} from '../lib/interfaceValueLabels.js';
import { OPERATOR_ACTION_TYPE_MESSAGE_IDS } from '../i18n/catalogs/remainingSurfaces.en.js';
import {
  acceptClientPortalOwnerIntent,
  applyClientPortalChatAction,
  fetchClientPortalChat,
  postClientPortalChatMessage,
  preflightClientPortalOwnerIntent,
  withdrawClientPortalOwnerIntent
} from '../lib/firmApi.js';
import {
  portalChatActionCards,
  portalChatDisplayMessages,
  portalChatOwnerIntentCandidateCards,
  portalEvidenceTopicCards
} from '../lib/clientPortalChat.js';

const monoCaps = {
  fontFamily: D.mono,
  fontSize: 11,
  letterSpacing: D.tracking.mono,
  textTransform: 'uppercase'
};

export default function ClientPortalChatPanel({ clientId, onBooksChanged, onUploadFiles, previewState = null }) {
  const intl = useIntl();
  const { formatTimestamp } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const previewMode = Boolean(previewState);
  const [open, setOpen] = useState(() => Boolean(previewState?.open));
  const [messages, setMessages] = useState(() => previewState?.messages || []);
  const [ownerIntentCandidates, setOwnerIntentCandidates] = useState(() => previewState?.ownerIntentCandidates || []);
  const [evidenceTopics, setEvidenceTopics] = useState(() => previewState?.evidenceTopics || []);
  const [loading, setLoading] = useState(() => Boolean(previewState?.loading));
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [acceptingOwnerIntent, setAcceptingOwnerIntent] = useState(null);
  const [preflightingOwnerIntent, setPreflightingOwnerIntent] = useState(null);
  const [withdrawingOwnerIntent, setWithdrawingOwnerIntent] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [errorLine, setErrorLine] = useState(() => previewState?.errorLine || '');
  const [input, setInput] = useState('');
  const scrollRef = useRef(null);
  const dialogRef = useRef(null);
  const launcherRef = useRef(null);
  const composerRef = useRef(null);
  const returnFocusRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const loadedForClient = useRef(null);
  const optimisticSequenceRef = useRef(0);

  const localizedError = (error) => {
    const status = error?.status || error?.statusCode || null;
    if (status === 402) return message('portal.chat.error.planPaused');
    if (status === 401 || status === 403) return message('portal.chat.error.sessionExpired');
    return message('portal.chat.error.send');
  };

  const closePanel = () => {
    setOpen(false);
    setTimeout(() => returnFocusRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!previewMode) return;
    setOpen(Boolean(previewState?.open));
    setMessages(previewState?.messages || []);
    setOwnerIntentCandidates(previewState?.ownerIntentCandidates || []);
    setEvidenceTopics(previewState?.evidenceTopics || []);
    setLoading(Boolean(previewState?.loading));
    setErrorLine(previewState?.errorLine || '');
  }, [previewMode, previewState]);

  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      ) || []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Load the persisted thread on first open (and again if the client
  // changes under the panel — a portal URL swap).
  useEffect(() => {
    if (!open || !clientId || loadedForClient.current === clientId) return;
    if (previewMode) {
      loadedForClient.current = clientId;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorLine('');
    fetchClientPortalChat({ clientId })
      .then((data) => {
        if (cancelled) return;
        loadedForClient.current = clientId;
        setMessages(Array.isArray(data?.messages) ? data.messages : []);
        setOwnerIntentCandidates(Array.isArray(data?.owner_intent_candidates) ? data.owner_intent_candidates : []);
        setEvidenceTopics(Array.isArray(data?.evidence_topics) ? data.evidence_topics : []);
      })
      .catch((err) => {
        if (!cancelled) setErrorLine(localizedError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, clientId, previewMode]);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, loading, sending]);

  const send = async (rawText) => {
    const fromInput = rawText == null;
    const text = String(rawText ?? input).trim();
    if (!text || sending || !clientId) return;
    setSending(true);
    setErrorLine('');
    if (fromInput) setInput('');
    // Optimistic owner bubble; replaced by the persisted rows on success.
    optimisticSequenceRef.current += 1;
    const optimisticId = `optimistic-${clientId}-${optimisticSequenceRef.current}`;
    setMessages((prev) => [...prev, { id: optimisticId, role: 'user', content: text }]);
    try {
      if (previewMode) {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimisticId),
          { id: `${optimisticId}-user`, role: 'user', content: text },
          {
            id: `${optimisticId}-assistant`,
            role: 'assistant',
            content: previewState?.reply || 'I found the referenced item and kept this preview read-only.'
          }
        ]);
        return;
      }
      const data = await postClientPortalChatMessage({ clientId, message: text });
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticId),
        ...(data?.user_message ? [data.user_message] : []),
        ...(data?.assistant_message ? [data.assistant_message] : []),
        ...(data?.system_message ? [data.system_message] : [])
      ]);
      if (Array.isArray(data?.owner_intent_candidates)) {
        setOwnerIntentCandidates(data.owner_intent_candidates);
      }
    } catch (err) {
      // Keep the owner's words in the box so nothing they typed is lost
      // (auto-messages, e.g. upload notes, never overwrite the box).
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      if (fromInput) setInput(text);
      // A 502 still persisted the user turn + a system notice server-side;
      // the notice rides err.body when present.
      const persisted = err?.body;
      if (persisted?.user_message || persisted?.system_message) {
        setMessages((prev) => [
          ...prev,
          ...(persisted.user_message ? [persisted.user_message] : []),
          ...(persisted.system_message ? [persisted.system_message] : [])
        ]);
        if (fromInput) setInput('');
      }
      setErrorLine(localizedError(err));
    } finally {
      setSending(false);
    }
  };

  // Files dropped or picked in the chat go through the SAME upload
  // pipeline as the drop box (the portal's persistEvidenceFiles wrapper
  // rides in via onUploadFiles: tray batch, storage PUT, register,
  // parse). The chat is another door to the drop box, not a second
  // upload path. After registration an auto message tells Donna, so the
  // acknowledgment turn sees the fresh documents in its context.
  const uploadToBooks = async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || uploading || typeof onUploadFiles !== 'function') return;
    setUploading(true);
    setErrorLine('');
    try {
      const registered = await onUploadFiles(list);
      const names = (Array.isArray(registered) ? registered : [])
        .map((doc) => doc?.filename)
        .filter(Boolean);
      if (!names.length) {
        setErrorLine(message('portal.chat.error.upload'));
        return;
      }
      await send(`Uploaded: ${names.join(', ')}`);
    } catch (err) {
      setErrorLine(message('portal.chat.error.upload'));
    } finally {
      setUploading(false);
    }
  };

  const handleDragEnter = (event) => {
    event.preventDefault();
    if (uploading) return;
    dragDepthRef.current += 1;
    setDragOver(true);
  };
  const handleDragOver = (event) => {
    // Required for onDrop to fire on a non-input element.
    event.preventDefault();
    if (!uploading && event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (event) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };
  const handleDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    if (uploading) return;
    uploadToBooks(event.dataTransfer?.files);
  };

  // Confirm a proposed answer card: the ONLY write this panel can fire,
  // and only from the persisted proposal (the server re-reads the message
  // and re-authorizes — the button carries indexes, never content).
  const confirmAction = async (card) => {
    if (!clientId || confirming) return;
    setConfirming(`${card.messageId}:${card.actionIndex}`);
    setErrorLine('');
    try {
      if (previewMode) {
        setMessages((prev) => prev.map((entry) => {
          if (entry.id !== card.messageId) return entry;
          const actions = Array.isArray(entry.payload?.actions) ? [...entry.payload.actions] : [];
          actions[card.actionIndex] = { ...actions[card.actionIndex], status: 'applied' };
          return { ...entry, payload: { ...entry.payload, actions } };
        }));
        return;
      }
      const data = await applyClientPortalChatAction({
        clientId,
        messageId: card.messageId,
        actionIndex: card.actionIndex
      });
      if (data?.message) {
        setMessages((prev) => prev.map((m) => (m.id === data.message.id ? data.message : m)));
      }
      // The answered ask leaves "What I still need" — let the portal
      // refresh its snapshot-backed lists.
      if (typeof onBooksChanged === 'function') onBooksChanged();
    } catch (err) {
      setErrorLine(localizedError(err));
    } finally {
      setConfirming(null);
    }
  };

  const preflightOwnerIntent = async (card) => {
    if (!clientId || preflightingOwnerIntent) return;
    setPreflightingOwnerIntent(card.proposalId);
    setErrorLine('');
    try {
      if (previewMode) {
        setOwnerIntentCandidates((prev) => prev.map((candidate) => (
          candidate.proposal_id === card.proposalId
            ? { ...candidate, preflight: { ...candidate.preflight, status: 'prepared' } }
            : candidate
        )));
        return;
      }
      const data = await preflightClientPortalOwnerIntent({ clientId, proposalId: card.proposalId });
      if (Array.isArray(data?.owner_intent_candidates)) {
        setOwnerIntentCandidates(data.owner_intent_candidates);
      }
    } catch (err) {
      setErrorLine(localizedError(err));
    } finally {
      setPreflightingOwnerIntent(null);
    }
  };

  const acceptOwnerIntent = async (card) => {
    if (!clientId || acceptingOwnerIntent) return;
    setAcceptingOwnerIntent(card.proposalId);
    setErrorLine('');
    try {
      if (previewMode) {
        setOwnerIntentCandidates((prev) => prev.filter((candidate) => candidate.proposal_id !== card.proposalId));
        return;
      }
      const data = await acceptClientPortalOwnerIntent({ clientId, proposalId: card.proposalId });
      if (Array.isArray(data?.owner_intent_candidates)) {
        setOwnerIntentCandidates(data.owner_intent_candidates);
      }
    } catch (err) {
      if (Array.isArray(err?.body?.owner_intent_candidates)) {
        setOwnerIntentCandidates(err.body.owner_intent_candidates);
      }
      setErrorLine(localizedError(err));
    } finally {
      setAcceptingOwnerIntent(null);
    }
  };

  const withdrawOwnerIntent = async (card) => {
    if (!clientId || withdrawingOwnerIntent) return;
    setWithdrawingOwnerIntent(card.proposalId);
    setErrorLine('');
    try {
      if (previewMode) {
        setOwnerIntentCandidates((prev) => prev.filter((candidate) => candidate.proposal_id !== card.proposalId));
        return;
      }
      const data = await withdrawClientPortalOwnerIntent({
        clientId,
        proposalId: card.proposalId,
        reason: 'owner_skipped_in_portal'
      });
      if (Array.isArray(data?.owner_intent_candidates)) {
        setOwnerIntentCandidates(data.owner_intent_candidates);
      } else {
        setOwnerIntentCandidates((prev) => prev.filter((candidate) => candidate?.proposal_id !== card.proposalId));
      }
    } catch (err) {
      setErrorLine(localizedError(err));
    } finally {
      setWithdrawingOwnerIntent(null);
    }
  };

  const display = portalChatDisplayMessages(messages);
  const ownerIntentCards = portalChatOwnerIntentCandidateCards(ownerIntentCandidates);
  const evidenceTopicCards = portalEvidenceTopicCards(evidenceTopics);
  const cardsByMessageId = new Map(
    messages.map((m) => [m.id, portalChatActionCards(m)]).filter(([, cards]) => cards.length > 0)
  );

  return (
    <>
      {/* Launcher — fixed bottom-right, mono caps on the warm accent. */}
      {!open && (
        <button
          ref={launcherRef}
          type="button"
          onClick={(event) => {
            returnFocusRef.current = event.currentTarget;
            setOpen(true);
          }}
          style={{
            position: 'fixed',
            insetInlineEnd: '1.25rem',
            insetBlockEnd: '1.25rem',
            zIndex: 40,
            ...D.noiseGold(),
            color: D.ink,
            border: `1px solid ${D.ink}`,
            padding: '0.75rem 1.1rem',
            cursor: 'pointer',
            ...monoCaps,
            fontWeight: 600
          }}
        >
          {message('portal.chat.launch')}
        </button>
      )}

      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={message('portal.chat.dialogAria')}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            position: 'fixed',
            insetBlock: 0,
            insetInlineEnd: 0,
            zIndex: 50,
            width: 'min(26rem, 100vw)',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: D.paper,
            borderInlineStart: `1px solid ${dragOver ? D.accentWarmFlat : D.rule}`,
            boxShadow: '0 12px 32px oklch(0.08 0 0 / 0.12)'
          }}
        >
          {/* Header — just the name and the way out. */}
          <div
            style={{
              padding: '0.85rem 1.25rem',
              borderBottom: `1px solid ${D.rule}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.75rem'
            }}
          >
            <span style={{ ...monoCaps, color: D.ink, fontWeight: 600 }}>{message('portal.chat.title')}</span>
            <button
              type="button"
              onClick={closePanel}
              aria-label={message('portal.chat.close')}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: D.inkSoft,
                fontFamily: D.body,
                fontSize: 18,
                lineHeight: 1,
                padding: '0.15rem'
              }}
            >
              ×
            </button>
          </div>

          {/* Thread */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '1.1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {display.length === 0 && !loading && (
              <p style={{ fontFamily: D.body, fontSize: 14, lineHeight: D.leading.body, color: D.inkSoft, margin: 0 }}>
                {message('portal.chat.welcome')}
              </p>
            )}
            {evidenceTopicCards.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                <div style={{ ...monoCaps, color: D.inkMute }}>{message('portal.chat.open.title')}</div>
                {evidenceTopicCards.map((card) => (
                  <div
                    key={card.evidenceRequestId}
                    style={{
                      border: `1px solid ${D.rule}`,
                      backgroundColor: D.paperDeep,
                      padding: '0.65rem 0.75rem'
                    }}
                  >
                    <div style={{ ...monoCaps, color: D.inkMute, marginBottom: '0.35rem' }}>
                      {message('portal.chat.open.topic')}
                      {card.channel && <> · {portalChannelLabel(card.channel, intl.formatMessage)}</>}
                    </div>
                    <div style={{ fontFamily: D.body, fontSize: 14, lineHeight: D.leading.body, color: D.ink }}>
                      <BidiText direction="auto">{card.currentNeed || message('portal.chat.open.body')}</BidiText>
                    </div>
                    {card.lastReplyExcerpt && (
                      <div style={{ fontFamily: D.body, fontSize: 13, lineHeight: D.leading.body, color: D.inkSoft, marginTop: '0.4rem' }}>
                        {message('portal.chat.open.lastReply', {
                          reply: <BidiText direction="auto">{card.lastReplyExcerpt}</BidiText>
                        })}
                      </div>
                    )}
                    <div style={{ ...monoCaps, color: D.inkMute, marginTop: '0.45rem' }}>
                      {card.lastOwnerMessageAt
                        ? message('portal.question.stillOpen', {
                            date: <FormattedValue>{formatTimestamp(card.lastOwnerMessageAt)}</FormattedValue>
                          })
                        : message('portal.chat.open.waiting')}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {ownerIntentCards.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                <div style={{ ...monoCaps, color: D.inkMute }}>{message('portal.chat.intent.title')}</div>
                {ownerIntentCards.map((card) => (
                  <div
                    key={card.proposalId}
                    style={{
                      border: `1px solid ${D.rule}`,
                      backgroundColor: D.paperDeep,
                      padding: '0.65rem 0.75rem'
                    }}
                  >
                    <div style={{ ...monoCaps, color: D.inkMute, marginBottom: '0.35rem' }}>
                      {message('portal.chat.intent.suggestions', { count: 1 })}
                      {card.intentKind && <> · {ownerIntentKindLabel(card.intentKind, intl.formatMessage)}</>}
                    </div>
                    <div style={{ fontFamily: D.body, fontSize: 14, lineHeight: D.leading.body, color: D.ink }}>
                      <BidiText direction="auto">{card.summary}</BidiText>
                    </div>
                    <div style={{ ...monoCaps, color: D.inkMute, marginTop: '0.45rem' }}>
                      {message('portal.chat.intent.reviewOnly')}
                    </div>
                    {card.memoryCandidate && (
                      <div style={{ ...monoCaps, color: D.inkMute, marginTop: '0.25rem' }}>
                        {message('portal.chat.intent.memoryCandidate', {
                          status: ownerIntentStatusLabel(card.memoryCandidate.status || 'suggested', intl.formatMessage)
                        })}
                      </div>
                    )}
                    {card.preflight && (
                      <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <div style={{ ...monoCaps, color: D.inkMute }}>
                          {message('portal.chat.intent.preflight', {
                            status: ownerIntentStatusLabel(card.preflight.status || 'prepared', intl.formatMessage)
                          })}
                        </div>
                        {card.preflight.apply_plan?.selected_mutation && (
                          <div style={{ fontFamily: D.body, fontSize: 12, color: D.inkSoft }}>
                            {message('portal.chat.intent.route', {
                              // The planned change by name; the internal writer stays internal.
                              route: OPERATOR_ACTION_TYPE_MESSAGE_IDS[card.preflight.apply_plan.selected_mutation.verb]
                                ? message(OPERATOR_ACTION_TYPE_MESSAGE_IDS[card.preflight.apply_plan.selected_mutation.verb])
                                : message('portal.chat.intent.route.unknown')
                            })}
                          </div>
                        )}
                        {card.preflight.consequence_diff && (
                          <div style={{ fontFamily: D.body, fontSize: 12, color: D.inkSoft }}>
                            {message('portal.chat.intent.consequence', {
                              consequence: ownerIntentStatusLabel(card.preflight.consequence_diff.status || 'not_computed', intl.formatMessage)
                            })}
                          </div>
                        )}
                        {card.preflight.authority && (
                          <div style={{ fontFamily: D.body, fontSize: 12, color: D.inkSoft }}>
                            {message('portal.chat.intent.authority', {
                              status: ownerIntentStatusLabel(card.preflight.authority.status || 'blocked', intl.formatMessage)
                            })}
                          </div>
                        )}
                        {card.preflight.execution_gate && (
                          <div style={{ fontFamily: D.body, fontSize: 12, color: D.inkSoft }}>
                            {message('portal.chat.intent.execution', {
                              status: ownerIntentStatusLabel(card.preflight.execution_gate.status || 'blocked', intl.formatMessage)
                            })}
                            {card.preflight.execution_gate.writer_invoked === false && <> · {message('portal.chat.intent.noWriter')}</>}
                            {card.preflight.execution_gate.apply_receipt_required && <> · {message('portal.chat.intent.receiptRequired')}</>}
                          </div>
                        )}
                        {/* A blocker reads as its label (the server's detail is
                            English engineering text); repeated labels show once. */}
                        {[...new Set((card.preflight.blockers || []).slice(0, 3)
                          .map((blocker) => ownerIntentBlockerLabel(blocker?.code, intl.formatMessage)))].map((label) => (
                          <div key={`${card.proposalId}:${label}`} style={{ fontFamily: D.body, fontSize: 12, color: D.inkSoft }}>
                            • {label}
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: '0.55rem', display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => preflightOwnerIntent(card)}
                        disabled={preflightingOwnerIntent === card.proposalId || acceptingOwnerIntent === card.proposalId || withdrawingOwnerIntent === card.proposalId}
                        style={{
                          border: `1px solid ${D.ink}`,
                          backgroundColor: 'transparent',
                          color: D.ink,
                          padding: '0.4rem 0.55rem',
                          cursor: preflightingOwnerIntent === card.proposalId ? 'wait' : 'pointer',
                          ...monoCaps
                        }}
                      >
                        {message(preflightingOwnerIntent === card.proposalId
                          ? 'portal.chat.intent.preparing'
                          : 'portal.chat.intent.review')}
                      </button>
                      <button
                        type="button"
                        onClick={() => acceptOwnerIntent(card)}
                        disabled={acceptingOwnerIntent === card.proposalId || preflightingOwnerIntent === card.proposalId || withdrawingOwnerIntent === card.proposalId}
                        style={{
                          border: `1px solid ${D.ink}`,
                          backgroundColor: D.paper,
                          color: D.ink,
                          padding: '0.4rem 0.55rem',
                          cursor: acceptingOwnerIntent === card.proposalId ? 'wait' : 'pointer',
                          ...monoCaps
                        }}
                      >
                        {message(acceptingOwnerIntent === card.proposalId
                          ? 'portal.chat.intent.checking'
                          : 'portal.chat.intent.requestApply')}
                      </button>
                      <button
                        type="button"
                        onClick={() => withdrawOwnerIntent(card)}
                        disabled={withdrawingOwnerIntent === card.proposalId || acceptingOwnerIntent === card.proposalId || preflightingOwnerIntent === card.proposalId}
                        style={{
                          border: `1px solid ${D.rule}`,
                          backgroundColor: 'transparent',
                          color: D.inkSoft,
                          padding: '0.4rem 0.55rem',
                          cursor: withdrawingOwnerIntent === card.proposalId ? 'wait' : 'pointer',
                          ...monoCaps
                        }}
                      >
                        {message(withdrawingOwnerIntent === card.proposalId
                          ? 'portal.chat.intent.skipping'
                          : 'portal.chat.intent.skip')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {display.map((entry) => {
              if (entry.speaker === 'notice') {
                return (
                  <div key={entry.id} style={{ ...monoCaps, color: D.inkMute, textAlign: 'center', padding: '0.25rem 0' }}>
                    {entry.messageId
                      ? message(entry.messageId)
                      : <BidiText direction="auto">{entry.text}</BidiText>}
                  </div>
                );
              }
              const isOwner = entry.speaker === 'you';
              const uploadedFilenames = isOwner && entry.text.startsWith('Uploaded: ')
                ? entry.text.slice('Uploaded: '.length)
                : null;
              const cards = cardsByMessageId.get(entry.id) || [];
              return (
                <div key={entry.id} style={{ alignSelf: isOwner ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
                  <div style={{ ...monoCaps, color: D.inkMute, marginBottom: '0.25rem', textAlign: isOwner ? 'end' : 'start' }}>
                    {message(isOwner ? 'portal.chat.speaker.you' : 'portal.chat.speaker.donna')}
                  </div>
                  <div
                    style={{
                      fontFamily: D.body,
                      fontSize: 14,
                      lineHeight: D.leading.body,
                      color: D.ink,
                      whiteSpace: 'pre-wrap',
                      backgroundColor: isOwner ? D.paperDeep : D.paper,
                      border: `1px solid ${isOwner ? D.ruleSoft : D.rule}`,
                      padding: '0.6rem 0.75rem'
                    }}
                  >
                    {uploadedFilenames
                      ? message('portal.chat.uploaded', {
                          filenames: <BidiText direction="auto">{uploadedFilenames}</BidiText>
                        })
                      : <BidiText direction="auto">{entry.text}</BidiText>}
                  </div>
                  {cards.map((card) => (
                    <div
                      key={`${card.messageId}:${card.actionIndex}`}
                      style={{
                        marginTop: '0.5rem',
                        border: `1px solid ${D.rule}`,
                        backgroundColor: D.paperDeep,
                        padding: '0.6rem 0.75rem'
                      }}
                    >
                      <div style={{ ...monoCaps, color: D.inkMute, marginBottom: '0.35rem' }}>
                        {card.status === 'applied'
                          ? message('portal.chat.action.applied')
                          : card.status === 'proposed'
                            ? message('portal.chat.action.proposed')
                            : card.status === 'superseded'
                              ? message('portal.chat.action.superseded')
                              : message('portal.chat.action.unknown')}
                      </div>
                      <div style={{ fontFamily: D.body, fontSize: 14, lineHeight: D.leading.body, color: D.ink }}>
                        “<BidiText direction="auto">{card.replyText}</BidiText>”
                      </div>
                      {card.confirmable && (
                        <button
                          type="button"
                          onClick={() => confirmAction(card)}
                          disabled={Boolean(confirming)}
                          style={{
                            marginTop: '0.55rem',
                            ...D.noiseGold(),
                            color: D.ink,
                            border: `1px solid ${D.ink}`,
                            padding: '0.45rem 0.8rem',
                            cursor: confirming ? 'default' : 'pointer',
                            opacity: confirming ? 0.5 : 1,
                            ...monoCaps,
                            fontWeight: 600
                          }}
                        >
                          {message(confirming === `${card.messageId}:${card.actionIndex}`
                            ? 'portal.chat.action.filing'
                            : 'portal.chat.action.confirm')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
            {(loading || sending || uploading) && (
              <div style={{ ...monoCaps, color: D.inkMute }}>
                {message(loading
                  ? 'portal.chat.loading.thread'
                  : uploading
                    ? 'portal.chat.loading.files'
                    : 'portal.chat.loading.books')}
              </div>
            )}
            {dragOver && (
              <div
                style={{
                  ...monoCaps,
                  color: D.accentWarmFlat,
                  textAlign: 'center',
                  border: `1px dashed ${D.accentWarmFlat}`,
                  padding: '0.75rem'
                }}
              >
                {message('portal.chat.drop')}
              </div>
            )}
          </div>

          {/* Composer — one bordered row: attach · textarea · send. The
              controls live INSIDE the border so nothing mis-aligns; the
              buttons stretch to the row's height. */}
          <div style={{ borderTop: `1px solid ${D.rule}`, padding: '0.9rem 1.25rem' }}>
            {errorLine && (
              <div role="alert" style={{ ...monoCaps, color: D.alert, marginBottom: '0.5rem' }}>
                <BidiText direction="auto">{errorLine}</BidiText>
              </div>
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'stretch',
                border: `1px solid ${D.rule}`,
                backgroundColor: D.paper
              }}
            >
              {typeof onUploadFiles === 'function' && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.target.value = '';
                      uploadToBooks(files);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    aria-label={message('portal.chat.attach')}
                    title={message('portal.chat.attachAria')}
                    style={{
                      background: 'none',
                      border: 'none',
                      borderInlineEnd: `1px solid ${D.ruleSoft}`,
                      cursor: uploading ? 'default' : 'pointer',
                      opacity: uploading ? 0.5 : 1,
                      color: D.inkSoft,
                      fontFamily: D.body,
                      fontSize: 16,
                      padding: '0 0.75rem'
                    }}
                  >
                    +
                  </button>
                </>
              )}
              <textarea
                ref={composerRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                dir="auto"
                placeholder={message('portal.chat.placeholder')}
                disabled={sending}
                style={{
                  flex: 1,
                  resize: 'none',
                  fontFamily: D.body,
                  fontSize: 14,
                  lineHeight: D.leading.body,
                  color: D.ink,
                  backgroundColor: 'transparent',
                  border: 'none',
                  outline: 'none',
                  padding: '0.55rem 0.7rem'
                }}
              />
              <button
                type="button"
                onClick={() => send()}
                disabled={sending || !input.trim()}
                style={{
                  ...D.noiseGold(),
                  color: D.ink,
                  border: 'none',
                  borderInlineStart: `1px solid ${D.ink}`,
                  padding: '0 1rem',
                  cursor: sending || !input.trim() ? 'default' : 'pointer',
                  opacity: sending || !input.trim() ? 0.5 : 1,
                  ...monoCaps,
                  fontWeight: 600
                }}
              >
                {message('portal.chat.send')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
