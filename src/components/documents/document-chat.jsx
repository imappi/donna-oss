// Document chat — chat-first artifact surface.
//
// Owns the entire artifact view for chat-applicable docs: header
// with the document name, scrollable conversation, optional quick-
// prompt pills on first open, and a polished composer at the bottom.
// Talks to the server-side thread via fetchFirmDocumentChat /
// postFirmDocumentChatMessage; messages and proposed actions persist
// in document_chat_messages so reopening the artifact resumes the
// conversation.
//
// Apply paths are gated by the server's appliable_action_types
// allowlist (PR 28 wires link_transaction). Every action card reads
// its enabled/disabled state from deriveActionCardState so the FE
// never offers a button for a writer that doesn't exist yet.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import { V } from '../shared/design-tokens.js';
import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';
import { documentNeedsCurrencyConfirmation } from '../../lib/documentChat.js';
// The shared Donna chat grammar (extracted from this file, 2026-08-05) —
// bot/user/system messages, prompt pills, and the composer render
// byte-identically from shared/donna-chat.jsx; the feed chat uses the
// same vocabulary.
import {
  BotMessage,
  Composer,
  FormattedText,
  PromptPills,
  SystemMessage,
  UserMessage
} from '../shared/donna-chat.jsx';
import {
  applyFirmDocumentChatAction,
  fetchFirmDocumentChat,
  postChatComment,
  postFirmDocumentChatMessage
} from '../../lib/firmApi.js';
import {
  useMentionComposer,
  MentionChipsRow,
  MentionTypeaheadOverlay,
  AgentMentionActivity,
  CommentMessage,
  isCommentMessage,
  filterSupersededComments
} from '../shared/mention-composer.jsx';
import {
  ACTION_TYPE_MESSAGE_IDS,
  deriveActionCardState,
  describeAction,
  formatChatTimestamp,
  isNearBottom,
  mergeChatMessages
} from '../../lib/documentChat.js';
import {
  buildOptimisticUserMessage,
  removeOptimisticChatTurn,
  settleOptimisticChatTurn
} from '../../lib/chatOptimistic.js';
import {
  buildManualLinkPickerData,
  hintLabel
} from '../../lib/manualLinkPicker.js';

// Auto-poll cadence for refreshing the chat against the server.
// Mirrors transaction-chat (PR #144) — same 20s tick, paused while
// document.hidden, paused while submitting === true. One module-top
// constant so tuning is a single-line change. Document-chat is less
// "live" than transaction-chat (no client-portal bridge in either
// direction today), but the same refresh primitives apply: action
// status flips, system messages from background workers, future
// client-document replies.
const POLL_INTERVAL_MS = 20_000;

// Distance from the bottom of the scroll area (in px) within which we
// still treat the firm as "following live" and auto-pin to the bottom
// on a new message. Beyond it, they're reading older messages — leave
// their scroll position alone.
const SCROLL_PIN_THRESHOLD_PX = 80;
const EMPTY_LIST = Object.freeze([]);

const UNMATCHED_PROMPT_IDS = [
  'document.prompt.unmatched.why',
  'document.prompt.unmatched.search',
  'document.prompt.unmatched.signals'
];

const MATCHED_PROMPT_IDS = [
  'document.prompt.matched.explain',
  'document.prompt.matched.category',
  'document.prompt.matched.details'
];

const DocumentChat = ({
  documentId,
  clientId,
  documentContext = null,
  documentTitle = '',
  documentMeta = '',
  fileUrl = '',
  candidateTransactions = [],
  linkable = null,
  onRefreshRef = null,
  focusComposerRequestId = null,
  previewMode = null,
  previewMessages = EMPTY_LIST,
  previewAppliableActionTypes = EMPTY_LIST,
  onActionApplied
}) => {
  const intl = useIntl();
  const { formatAmount, formatDate, formatTimestamp } = useInterfaceLocale();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  const detailPreview = previewMode === 'detail';
  const conversationPreview = previewMode === 'conversation';
  const previewOnly = detailPreview || conversationPreview;
  const resolvedDocumentTitle = documentTitle || message('document.title.fallback');
  const matchInfo = useMemo(() => {
    if (!documentId || !linkable?.reconciliationMatches) return null;
    const matches = (linkable.reconciliationMatches || []).filter(
      (m) => m.matched_object_id === documentId &&
        (m.status === 'confirmed' || m.status === 'auto_matched' || m.status === 'suggested')
    );
    if (!matches.length) return null;
    const match = matches[0];
    const allTx = linkable?.transactions || candidateTransactions || [];
    const linkedTx = allTx.find((t) => t.id === match.bank_transaction_id);
    return {
      status: match.status,
      confidence: match.match_confidence,
      transaction: linkedTx || null
    };
  }, [documentId, linkable?.reconciliationMatches, linkable?.transactions, candidateTransactions]);

  const isMatched = !!matchInfo;

  const enrichedDocumentContext = useMemo(() => {
    if (!documentContext || !matchInfo) return documentContext;
    const tx = matchInfo.transaction;
    return {
      ...documentContext,
      reconciliation_match: {
        status: matchInfo.status,
        bank_transaction_id: tx?.id || null,
        match_confidence: matchInfo.confidence,
        linked_transaction: tx ? {
          id: tx.id,
          date: tx.transaction_date || tx.date,
          description: tx.description || tx.raw_description,
          money_out: tx.money_out,
          money_in: tx.money_in
        } : null
      }
    };
  }, [documentContext, matchInfo]);

  const [messages, setMessages] = useState(() => (
    conversationPreview && Array.isArray(previewMessages) ? previewMessages : []
  ));
  const [appliableActionTypes, setAppliableActionTypes] = useState(() => (
    conversationPreview && Array.isArray(previewAppliableActionTypes)
      ? previewAppliableActionTypes
      : []
  ));
  const [loading, setLoading] = useState(!previewOnly);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeMentionAgent, setActiveMentionAgent] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [applyState, setApplyState] = useState({});
  const [linkBusy, setLinkBusy] = useState(null);
  const [linkDone, setLinkDone] = useState(new Set());
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const optimisticTurnSequenceRef = useRef(0);
  // Universal @mentions: same grammar as the transaction artifact. Human
  // mentions are comments; @Donna addresses this existing Donna chat turn.
  const mentionComposer = useMentionComposer({ clientId, setDraft, textareaRef });
  // Refresh-handler indirection — the polling tick and the manual
  // refresh button both fire through this ref. Owned by the mount
  // effect so its closure carries the current (clientId, documentId)
  // and the cleanup tears it down on unmount / artifact swap.
  const refreshRef = useRef(() => {});
  // Submitting captured as a ref so the polling tick can read the
  // current value without rebuilding the interval every time
  // submitting flips. Keeps the in-flight send race-free.
  const submittingRef = useRef(false);
  // Tracks whether the firm was near the bottom of the scroll area at
  // the last scroll event. Gates the auto-scroll-on-new-message
  // effect — see isNearBottom in src/lib/documentChat.js.
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    if (!focusComposerRequestId) return undefined;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusComposerRequestId]);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  // Chat load + auto-poll lifecycle. Mirrors transaction-artifact
  // (PR #144) — see that file for the longer rationale. Summary:
  // one mount-time fetch REPLACES messages (canonical initial render);
  // a setInterval tick on POLL_INTERVAL_MS MERGES the server snapshot
  // via mergeChatMessages; visibilitychange pauses + immediately
  // re-fires on resume; submittingRef gates polling so an in-flight
  // send isn't raced by a stale merge.
  //
  // The refresh path NEVER touches draft, submitting, sendError, or
  // applyState. Only messages and appliable_action_types are subject
  // to refresh.
  useEffect(() => {
    if (previewOnly) {
      refreshRef.current = () => {};
      return undefined;
    }
    if (!clientId || !documentId) {
      refreshRef.current = () => {};
      return undefined;
    }
    const initialController = new AbortController();
    let cancelled = false;
    let pollController = null;
    setLoading(true);
    setLoadError(null);
    fetchFirmDocumentChat({ clientId, documentId, signal: initialController.signal })
      .then((payload) => {
        if (cancelled) return;
        setMessages(payload?.messages || []);
        setAppliableActionTypes(payload?.appliable_action_types || []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setMessages([]);
        setLoadError(err?.message || message('document.error.chatLoad'));
        setLoading(false);
      });

    const tick = () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (submittingRef.current) return;
      pollController?.abort();
      pollController = new AbortController();
      const myController = pollController;
      fetchFirmDocumentChat({ clientId, documentId, signal: myController.signal })
        .then((payload) => {
          if (cancelled || myController.signal.aborted) return;
          setMessages((prev) => mergeChatMessages(prev, payload?.messages || []));
          if (Array.isArray(payload?.appliable_action_types)) {
            setAppliableActionTypes(payload.appliable_action_types);
          }
        })
        .catch((err) => {
          if (cancelled || err?.name === 'AbortError') return;
          // Soft-fail: don't surface poll errors as loadError — the
          // initial render already succeeded and a transient network
          // blip shouldn't blank the chat.
        });
    };

    refreshRef.current = tick;
    const intervalId = setInterval(tick, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        tick();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      cancelled = true;
      initialController.abort();
      pollController?.abort();
      clearInterval(intervalId);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      refreshRef.current = () => {};
    };
  }, [clientId, documentId, previewOnly, intl.locale]);

  // Auto-scroll to bottom on new messages, but only when the firm is
  // already following the live edge. If they're scrolled up reading
  // older context, leave their position alone — a polled message
  // landing should not yank them away.
  useEffect(() => {
    if (!scrollRef.current) return;
    if (!wasNearBottomRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, submitting, mentionComposer.directDonna]);

  const handleScroll = () => {
    wasNearBottomRef.current = isNearBottom(scrollRef.current, SCROLL_PIN_THRESHOLD_PX);
  };

  const handleRefreshClick = () => {
    refreshRef.current();
  };

  useEffect(() => {
    if (onRefreshRef) onRefreshRef.current = handleRefreshClick;
    return () => { if (onRefreshRef) onRefreshRef.current = null; };
  });

  const isSendable = useMemo(
    () => draft.trim().length > 0 && !submitting && clientId && documentId,
    [draft, submitting, clientId, documentId]
  );

  const handleSend = async () => {
    if (!isSendable) return;
    if (conversationPreview) {
      const userText = draft.trim();
      const optimisticId = `preview:document-chat:${documentId}:${++optimisticTurnSequenceRef.current}`;
      setMessages((prev) => [
        ...prev,
        buildOptimisticUserMessage({ id: optimisticId, content: userText })
      ]);
      setDraft('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      return;
    }
    const selectedMentions = mentionComposer.mentions;
    const selectedFlavor = mentionComposer.flavor;
    const directDonna = mentionComposer.directDonna;
    const addressedAgent = directDonna ? selectedMentions[0] : null;
    submittingRef.current = true;
    setSubmitting(true);
    setSendError(null);
    const userText = draft.trim();
    setDraft('');
    setActiveMentionAgent(addressedAgent);
    if (selectedMentions.length > 0) mentionComposer.reset();
    const optimisticId = `local:document-chat:${documentId}:${++optimisticTurnSequenceRef.current}`;
    const optimisticPayload = selectedMentions.length > 0 && !directDonna
      ? {
          kind: 'comment',
          flavor: selectedFlavor,
          mentions: selectedMentions
        }
      : directDonna
        ? { kind: 'agent_instruction', mentions: selectedMentions }
        : {};
    setMessages((prev) => [
      ...prev,
      buildOptimisticUserMessage({ id: optimisticId, content: userText, payload: optimisticPayload })
    ]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    try {
      if (selectedMentions.length > 0 && !directDonna) {
        // A non-Donna mentioning draft is a COMMENT on the artifact. Human
        // mentions coordinate without an LLM turn; a specialist 'ask' mints
        // the blocking agent question. @Donna falls through to the existing
        // synchronous artifact-chat path below.
        const result = await postChatComment({
          clientId,
          surface: 'document_chat',
          documentId,
          text: userText,
          flavor: selectedFlavor,
          mentions: selectedMentions
        });
        if (result?.message) {
          setMessages((prev) => settleOptimisticChatTurn(prev, optimisticId, [result.message]));
        } else {
          setMessages((prev) => removeOptimisticChatTurn(prev, optimisticId));
        }
        return;
      }
      const result = await postFirmDocumentChatMessage({
        clientId,
        documentId,
        message: userText,
        documentContext: enrichedDocumentContext,
        candidateTransactions,
        addressedAgent
      });
      const additions = [];
      if (result?.user_message) additions.push(result.user_message);
      if (result?.assistant_message) additions.push(result.assistant_message);
      if (result?.system_message) additions.push(result.system_message);
      if (additions.length) {
        setMessages((prev) => settleOptimisticChatTurn(prev, optimisticId, additions));
      } else {
        setMessages((prev) => removeOptimisticChatTurn(prev, optimisticId));
      }
      if (Array.isArray(result?.appliable_action_types)) {
        setAppliableActionTypes(result.appliable_action_types);
      }
    } catch (err) {
      setMessages((prev) => removeOptimisticChatTurn(prev, optimisticId));
      setSendError(err?.message || message('document.error.sendMessage'));
      setDraft(userText);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      setActiveMentionAgent(null);
    }
  };

  const handleApplyAction = async ({ messageId, actionIndex }) => {
    const key = `${messageId}:${actionIndex}`;
    setApplyState((prev) => ({ ...prev, [key]: { status: 'applying', error: null } }));
    if (conversationPreview) {
      setMessages((prev) => prev.map((chatMessage) => {
        if (chatMessage.id !== messageId) return chatMessage;
        const actions = Array.isArray(chatMessage?.payload?.actions)
          ? chatMessage.payload.actions.map((action, index) => (
              index === actionIndex ? { ...action, status: 'applied' } : action
            ))
          : [];
        return { ...chatMessage, payload: { ...chatMessage.payload, actions } };
      }));
      setApplyState((prev) => ({ ...prev, [key]: { status: 'applied', error: null } }));
      return;
    }
    try {
      const result = await applyFirmDocumentChatAction({
        clientId,
        documentId,
        messageId,
        actionIndex
      });
      if (result?.assistant_message) {
        setMessages((prev) =>
          prev.map((m) => (m.id === result.assistant_message.id ? result.assistant_message : m))
        );
      }
      setApplyState((prev) => ({ ...prev, [key]: { status: 'applied', error: null } }));
      if (typeof onActionApplied === 'function') {
        onActionApplied({ messageId, actionIndex, snapshot: result?.snapshot || null });
      }
    } catch (err) {
      setApplyState((prev) => ({
        ...prev,
        [key]: { status: 'error', error: err?.message || null }
      }));
    }
  };

  const handleLinkTransaction = async (bankTransactionId) => {
    if (!linkable?.onLink || linkBusy) return;
    setLinkBusy(bankTransactionId);
    try {
      const result = await linkable.onLink({ bankTransactionId });
      setLinkDone((prev) => new Set([...prev, bankTransactionId]));
      if (linkable.onSnapshotApplied && result?.snapshot) {
        linkable.onSnapshotApplied(result.snapshot);
      }
    } catch {
      // soft-fail — the row stays clickable
    } finally {
      setLinkBusy(null);
    }
  };

  const handleKeyDown = (event) => {
    // The mention typeahead consumes navigation/pick keys while open.
    if (mentionComposer.handleKeyDown(event)) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleTextareaInput = (event) => {
    setDraft(event.target.value);
    mentionComposer.handleInput(event.target);
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 200)}px`;
  };

  const handlePillClick = (text) => {
    setDraft(text);
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  if (!clientId || !documentId) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
        height: '100%',
        minHeight: 600,
        // Flex-item shrink guard: without this the chat refuses to shrink
        // below its content's min-content width inside the row-flex parent,
        // so a long bank-ref string forces horizontal overflow and the whole
        // column scrolls sideways (clipping the left edge). minWidth:0 +
        // width:100% lets it fill and shrink to the panel.
        minWidth: 0,
        width: '100%'
      }}
    >
      <ChatHeader title={resolvedDocumentTitle} meta={documentMeta} fileUrl={fileUrl} />

      <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            height: '100%',
            overflowY: 'auto',
            // Clip any residual horizontal overflow so the conversation can
            // never scroll sideways (overflowY:auto alone computes overflowX
            // to auto, which is what let it scroll left).
            overflowX: 'hidden',
            padding: '24px 0'
          }}
        >
          <div style={{ maxWidth: 640, margin: '0 auto', padding: '0 24px' }}>
            {loading ? (
              <div style={{ fontSize: 13, color: V.t4 }}>{message('document.conversation.loading')}</div>
            ) : loadError ? (
              <div style={{ fontSize: 13, color: V.neg, fontFamily: "'JetBrains Mono', monospace" }}>
                <BidiText direction="auto">{loadError}</BidiText>
              </div>
            ) : (
              <>
                {!isMatched && documentNeedsCurrencyConfirmation(documentContext) && (
                  <SystemMessage>{message('document.currency.confirmInChat')}</SystemMessage>
                )}
                <EmptyState
                  title={resolvedDocumentTitle}
                  isMatched={isMatched}
                  matchInfo={matchInfo}
                  hasCandidates={candidateTransactions.length > 0}
                  onPickPill={handlePillClick}
                  hasMessages={messages.length > 0}
                  showPrompts={!detailPreview}
                  formatAmount={formatAmount}
                  formatDate={formatDate}
                />
                {!isMatched && (
                  <CandidateTransactions
                    documentContext={documentContext}
                    transactions={candidateTransactions}
                    reconciliationMatches={linkable?.reconciliationMatches}
                    onLink={linkable?.onLink ? handleLinkTransaction : null}
                    linkBusy={linkBusy}
                    linkDone={linkDone}
                    formatAmount={formatAmount}
                    formatDate={formatDate}
                  />
                )}
                {!detailPreview && filterSupersededComments(messages).map((msg) => (
                  <ChatMessage
                    key={msg.id}
                    message={msg}
                    appliableActionTypes={appliableActionTypes}
                    applyState={applyState}
                    onApplyAction={handleApplyAction}
                    formatTimestamp={formatTimestamp}
                  />
                ))}
                {!detailPreview && <AgentMentionActivity
                  messages={messages}
                  activeAgent={submitting ? activeMentionAgent : null}
                />}
              </>
            )}
          </div>
        </div>
      </div>

      {!detailPreview && <Composer
        draft={draft}
        textareaRef={textareaRef}
        onInput={handleTextareaInput}
        onKeyDown={handleKeyDown}
        onSend={handleSend}
        submitting={submitting}
        sendError={sendError}
        mentionChips={(
          <MentionChipsRow
            mentions={mentionComposer.mentions}
            flavor={mentionComposer.flavor}
            onFlavorChange={mentionComposer.setFlavor}
            onRemove={mentionComposer.removeMention}
          />
        )}
        mentionOverlay={(
          <MentionTypeaheadOverlay
            state={mentionComposer.typeahead}
            onPick={mentionComposer.pick}
            onHover={mentionComposer.setTypeaheadActive}
          />
        )}
      />}
    </div>
  );
};

const ChatHeader = ({ title, meta, fileUrl }) => {
  const intl = useIntl();
  if (!meta && !fileUrl) return null;
  return (
  <div
    style={{
      borderBlockEnd: `1px solid ${V.borderSubtle}`,
      flexShrink: 0,
      background: 'transparent'
    }}
  >
    <div
      style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: '14px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 12
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: V.t1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={title}
        >
          <BidiText direction="auto">{title}</BidiText>
        </div>
        {meta && (
          <div style={{ fontSize: 12, color: V.t4 }}><BidiText direction="auto">{meta}</BidiText></div>
        )}
      </div>
      {fileUrl && (
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: V.t3,
            textDecoration: 'none',
            padding: '6px 12px',
            border: `1px solid ${V.border}`,
            borderRadius: 8,
            background: 'transparent',
            transition: 'all 0.15s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = V.t1;
            e.currentTarget.style.borderColor = V.t4;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = V.t3;
            e.currentTarget.style.borderColor = V.border;
          }}
        >
          {intl.formatMessage({ id: 'document.original.view' })}
        </a>
      )}
    </div>
  </div>
  );
};

const fmtDate = (raw, formatDate) => {
  if (!raw) return '—';
  try {
    return formatDate(raw instanceof Date ? raw : String(raw).slice(0, 10), {
      day: '2-digit',
      month: 'short',
      year: null
    });
  } catch {
    return String(raw).slice(0, 10) || '—';
  }
};
const fmtAmt = (tx, formatAmount) => {
  const ccy = tx.account_currency || tx.currency || '';
  const isIn = Number(tx.money_in) > 0;
  const val = Math.abs(Number(isIn ? tx.money_in : tx.money_out) || 0);
  return formatAmount(isIn ? val : -val, {
    currency: String(ccy).trim() || null,
    minimumFractionDigits: val % 1 ? 2 : 0,
    maximumFractionDigits: 2,
    negativeStyle: 'minus',
    signDisplay: 'always'
  });
};

const HINT_BADGES = {
  amount_exact: { messageId: 'document.matches.hint.exactAmount', color: V.pos },
  amount_close: { messageId: 'document.matches.hint.amountClose', color: '#B8860B' },
  date_exact: { messageId: 'document.matches.hint.sameDay', color: V.pos },
  date_close: { messageId: 'document.matches.hint.nearDate', color: '#B8860B' },
  vendor_overlap: { messageId: 'document.matches.hint.vendorMatch', color: V.intel }
};

const MAX_CANDIDATES = 5;

// Real-signal hints — amount or vendor overlap. Date proximity alone
// is not enough: the shared scorer gives any same-day tx a 0.30 score
// (above the 0.15 chat threshold), which let the chat suggest matches
// that just happened to land on the same calendar day with no
// amount/vendor connection. The manual-picker modal still shows all
// scored candidates; this filter only tightens the chat helper strip.
const STRONG_HINTS = new Set(['amount_exact', 'amount_close', 'vendor_overlap']);

const CandidateTransactions = ({
  documentContext,
  transactions,
  reconciliationMatches,
  onLink,
  linkBusy,
  linkDone,
  formatAmount,
  formatDate
}) => {
  const intl = useIntl();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  const candidates = useMemo(() => {
    if (!documentContext || !transactions?.length) return [];
    const data = buildManualLinkPickerData({
      documentId: documentContext.id,
      documents: [documentContext],
      transactions,
      reconciliationMatches: reconciliationMatches || []
    });
    return (data.candidates || [])
      .filter((c) => {
        if (c.blocked) return false;
        if (c.score <= 0.15) return false;
        // Cross-currency stays in the manual-picker modal (PR 20's
        // FX-realised-payment workflow), but the chat strip is a
        // suggestion surface — show only same-currency rows here.
        if ((c.warnings || []).includes('currency_mismatch')) return false;
        return (c.hints || []).some((h) => STRONG_HINTS.has(h));
      })
      .slice(0, MAX_CANDIDATES);
  }, [documentContext, transactions, reconciliationMatches]);

  if (!candidates.length) return null;

  return (
    <div style={{ margin: '12px 0 6px' }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: V.t4,
        fontFamily: "'JetBrains Mono', monospace",
        marginBlockEnd: 8
      }}>
        {message('document.matches.potential', { count: candidates.length })}
      </div>
      <div style={{
        border: `1px solid ${V.borderSubtle}`,
        borderRadius: 8,
        overflow: 'hidden'
      }}>
        {candidates.map((c, i) => {
          const tx = c.transaction;
          const id = tx.id;
          const done = linkDone.has(id);
          const busy = linkBusy === id;
          const hints = c.hints || [];
          return (
            <div
              key={id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                alignItems: 'center',
                columnGap: 10,
                rowGap: 5,
                padding: '8px 12px',
                borderBlockEnd: i < candidates.length - 1 ? `1px solid ${V.borderSubtle}` : 'none',
                background: done ? V.posSurface : 'transparent',
                transition: 'background 0.2s'
              }}
            >
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11, color: V.t4, whiteSpace: 'nowrap'
              }}>
                <FormattedValue>{fmtDate(tx.transaction_date || tx.date, formatDate)}</FormattedValue>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12.5, color: V.t2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>
                  <BidiText direction="auto">{tx.description || tx.raw_description || '—'}</BidiText>
                </div>
                {hints.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, marginBlockStart: 3, flexWrap: 'wrap' }}>
                    {hints.map((h) => {
                      const badge = HINT_BADGES[h];
                      if (!badge) return null;
                      return (
                        <span key={h} style={{
                          fontSize: 9, fontWeight: 600, padding: '1px 5px',
                          borderRadius: 3, color: badge.color,
                          background: `${badge.color}12`,
                          fontFamily: "'JetBrains Mono', monospace"
                        }}>
                          {message(badge.messageId)}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12, color: V.t1, fontWeight: 500,
                fontVariantNumeric: 'tabular-nums', flexShrink: 0
              }}>
                <FormattedValue>{fmtAmt(tx, formatAmount)}</FormattedValue>
              </span>
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', minWidth: 0 }}>
              {onLink && !done && (
                <button
                  type="button"
                  disabled={!!linkBusy}
                  onClick={(e) => { e.stopPropagation(); onLink(id); }}
                  style={{
                    padding: '4px 10px', borderRadius: 6,
                    fontSize: 11, fontWeight: 600,
                    fontFamily: "'DM Sans', sans-serif",
                    border: 'none', cursor: busy ? 'wait' : 'pointer',
                    background: V.t1, color: '#fff',
                    opacity: linkBusy && !busy ? 0.4 : 1,
                    flexShrink: 0,
                    marginInlineStart: 'auto'
                  }}
                >
                  {busy ? message('document.matches.linking') : message('document.matches.link')}
                </button>
              )}
              {done && (
                <span style={{
                  fontSize: 10, fontWeight: 600, color: V.pos,
                  fontFamily: "'JetBrains Mono', monospace", flexShrink: 0,
                  marginInlineStart: 'auto'
                }}>
                  {message('document.matches.linked')}
                </span>
              )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const MatchedTransactionCard = ({ matchInfo, formatAmount, formatDate }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  if (!matchInfo?.transaction) return null;
  const tx = matchInfo.transaction;
  const isConfirmed = matchInfo.status === 'auto_matched' || matchInfo.status === 'confirmed';
  const matchLabel = isConfirmed
    ? message('document.match.confirmed')
    : message('document.match.suggested');
  const paymentLabel = isConfirmed
    ? message('document.match.paid')
    : message('document.match.pending');
  const paymentColor = isConfirmed ? V.pos : '#B8860B';
  return (
    <div style={{
      margin: '8px 0 4px',
      border: `1px solid ${V.pos}33`,
      borderRadius: 8,
      background: V.posSurface,
      overflow: 'hidden'
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
        alignItems: 'center',
        columnGap: 10,
        rowGap: 6,
        padding: '8px 12px'
      }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, color: V.t4, whiteSpace: 'nowrap'
        }}>
          <FormattedValue>{fmtDate(tx.transaction_date || tx.date, formatDate)}</FormattedValue>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12.5, color: V.t2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            <BidiText direction="auto">{tx.description || tx.raw_description || '—'}</BidiText>
          </div>
        </div>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12, color: V.t1, fontWeight: 500,
          fontVariantNumeric: 'tabular-nums', flexShrink: 0
        }}>
          <FormattedValue>{fmtAmt(tx, formatAmount)}</FormattedValue>
        </span>
        <span style={{ gridColumn: '1 / -1', display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{
            fontSize: 10, fontWeight: 600, color: V.pos,
            fontFamily: "'JetBrains Mono', monospace",
            padding: '2px 7px', borderRadius: 999,
            background: '#fff', border: `1px solid ${V.pos}33`
          }}>
            {matchLabel}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 600, color: paymentColor,
            fontFamily: "'JetBrains Mono', monospace",
            padding: '2px 7px', borderRadius: 999,
            background: '#fff', border: `1px solid ${paymentColor}33`
          }}>
            {paymentLabel}
          </span>
        </span>
      </div>
    </div>
  );
};

const EmptyState = ({
  title,
  isMatched,
  matchInfo,
  hasCandidates,
  onPickPill,
  hasMessages = false,
  showPrompts = true,
  formatAmount,
  formatDate
}) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const welcomeId = isMatched
    ? 'document.welcome.matched'
    : hasCandidates
      ? 'document.welcome.candidates'
      : 'document.welcome.noCandidates';
  const promptIds = isMatched ? MATCHED_PROMPT_IDS : UNMATCHED_PROMPT_IDS;
  const prompts = promptIds.map((id) => message(id));
  return (
    <>
      <BotMessage>
        <strong style={{ display: 'block', fontWeight: 600, color: V.t1, marginBlockEnd: 4 }}>
          <BidiText direction="auto">{title}</BidiText>
        </strong>
        <span>{message(welcomeId)}</span>
        {isMatched && matchInfo && (
          <MatchedTransactionCard matchInfo={matchInfo} formatAmount={formatAmount} formatDate={formatDate} />
        )}
      </BotMessage>
      {showPrompts && !hasMessages && (
        <PromptPills prompts={prompts} onPick={onPickPill} />
      )}
    </>
  );
};

const ChatMessage = ({
  message,
  appliableActionTypes,
  applyState = {},
  onApplyAction,
  formatTimestamp
}) => {
  const role = message.role;
  const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
  const timestamp = formatChatTimestamp(message.created_at, (value) => formatTimestamp(value, {
    day: null,
    month: null,
    year: null,
    second: null,
    timeZoneName: null
  }));

  // Universal @mentions: comment-lane rows render as the shared attributed
  // card — same look as the transaction artifact's stream.
  if (isCommentMessage(message)) {
    return <CommentMessage message={message} timestamp={timestamp} />;
  }
  if (role === 'user') {
    return (
      <UserMessage timestamp={timestamp}>{message.content}</UserMessage>
    );
  }
  if (role === 'system') {
    return (
      <SystemMessage timestamp={timestamp}>{message.content}</SystemMessage>
    );
  }
  return (
    <BotMessage timestamp={timestamp}>
      <FormattedText text={message.content} />
      {actions.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginTop: 12
          }}
        >
          {actions.map((action, index) => (
            <ActionCard
              key={`${message.id}-action-${index}`}
              action={action}
              appliableActionTypes={appliableActionTypes}
              applyState={applyState[`${message.id}:${index}`] || null}
              onApply={
                onApplyAction
                  ? () => onApplyAction({ messageId: message.id, actionIndex: index })
                  : null
              }
            />
          ))}
        </div>
      )}
    </BotMessage>
  );
};

const formatActionDate = (raw, formatDate) => {
  if (!raw) return null;
  try {
    return formatDate(String(raw).slice(0, 10), {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  } catch {
    return String(raw).slice(0, 10) || null;
  }
};

const ActionDetailValue = ({ detail, formatAmount, formatDate, message }) => {
  if (detail.kind === 'amount') {
    try {
      return (
        <FormattedValue>
          {formatAmount(detail.value, {
            currency: detail.currency || null,
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
            negativeStyle: 'minus'
          })}
        </FormattedValue>
      );
    } catch {
      return <FormattedValue>{String(detail.value)}</FormattedValue>;
    }
  }
  if (detail.kind === 'date') {
    return <FormattedValue>{formatActionDate(detail.value, formatDate) || detail.value}</FormattedValue>;
  }
  if (detail.kind === 'date_range') {
    const from = formatActionDate(detail.value?.from, formatDate);
    const to = formatActionDate(detail.value?.to, formatDate);
    return <FormattedValue>{[from, to].filter(Boolean).join(' – ') || '—'}</FormattedValue>;
  }
  if (detail.kind === 'identifier_list') {
    return <IdentifierText>{(detail.value || []).join(', ')}</IdentifierText>;
  }
  if (detail.kind === 'identifier') {
    return <IdentifierText>{detail.value}</IdentifierText>;
  }
  if (detail.kind === 'direction') {
    const directionId = {
      money_in: 'document.action.direction.moneyIn',
      money_out: 'document.action.direction.moneyOut'
    }[detail.value];
    return directionId ? message(directionId) : <IdentifierText>{detail.value}</IdentifierText>;
  }
  if (detail.kind === 'recipient') {
    const recipientId = {
      customer: 'document.action.recipient.customer',
      vendor: 'document.action.recipient.vendor',
      client_owner: 'document.action.recipient.clientOwner'
    }[detail.value];
    return recipientId ? message(recipientId) : <BidiText direction="auto">{detail.value}</BidiText>;
  }
  return <BidiText direction="auto">{detail.value}</BidiText>;
};

const ActionCard = ({ action, appliableActionTypes, applyState, onApply }) => {
  const intl = useIntl();
  const { formatAmount, formatDate } = useInterfaceLocale();
  const message = (id) => intl.formatMessage({ id });
  const card = deriveActionCardState({
    action,
    appliableTypes: appliableActionTypes,
    applyState,
    hasOnApply: typeof onApply === 'function'
  });
  const details = describeAction(action);
  const buttonTitle = card.phase === 'applied'
    ? message('document.action.title.alreadyApplied')
    : card.phase === 'unsupported'
      ? message('document.action.title.unsupported')
      : '';
  const actionMessageId = ACTION_TYPE_MESSAGE_IDS[action.type] || null;
  return (
    <div
      style={{
        border: `1px solid ${card.statusIsApplied ? V.pos + '33' : V.border}`,
        borderRadius: 10,
        background: card.statusIsApplied ? V.posSurface : V.surface,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        opacity: card.statusIsSuperseded ? 0.55 : 1
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap'
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: V.t1
          }}
        >
          {actionMessageId
            ? message(actionMessageId)
            : action.type
              ? <IdentifierText>{action.type}</IdentifierText>
              : message('document.action.type.fallback')}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: card.statusIsApplied ? V.pos : V.t4,
            background: card.statusIsApplied ? V.posSurface : 'transparent',
            padding: card.statusIsApplied ? '2px 8px' : 0,
            borderRadius: card.statusIsApplied ? 9999 : 0,
            border: card.statusIsApplied ? `1px solid ${V.pos}33` : 'none',
            fontFamily: "'JetBrains Mono', monospace"
          }}
        >
          {message(card.statusMessageId)}
        </span>
      </div>
      {action.reason && (
        <div style={{ fontSize: 13, color: V.t2, lineHeight: 1.5 }}>
          <BidiText direction="auto">{action.reason}</BidiText>
        </div>
      )}
      {details.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            paddingBlockStart: 4,
            borderBlockStart: `1px solid ${V.borderSubtle}`
          }}
        >
          {details.map((detail, index) => (
            <div
              key={`${detail.labelId}:${index}`}
              style={{
                fontSize: 12,
                color: V.t3,
                fontFamily: "'JetBrains Mono', monospace"
              }}
            >
              <span>{message(detail.labelId)}</span>
              <span aria-hidden="true">: </span>
              <ActionDetailValue
                detail={detail}
                formatAmount={formatAmount}
                formatDate={formatDate}
                message={message}
              />
            </div>
          ))}
        </div>
      )}
      {(card.error || card.errorMessageId) && (
        <div
          style={{
            fontSize: 11,
            color: V.neg,
            fontFamily: "'JetBrains Mono', monospace"
          }}
        >
          {card.error
            ? <BidiText direction="auto">{card.error}</BidiText>
            : message(card.errorMessageId)}
        </div>
      )}
      {!card.statusIsApplied && !card.statusIsSuperseded && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            disabled={!card.enabled}
            onClick={card.enabled ? onApply : undefined}
            title={buttonTitle}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: card.enabled ? 'pointer' : 'not-allowed',
              fontFamily: "'DM Sans', sans-serif",
              border: card.enabled ? 'none' : `1px solid ${V.border}`,
              background: card.enabled ? V.t1 : V.bgDeep,
              color: card.enabled ? '#fff' : V.t4
            }}
          >
            {message(card.buttonMessageId)}
          </button>
        </div>
      )}
    </div>
  );
};

export default DocumentChat;
