// Transaction artifact — chat-first case-file surface for a bank
// transaction. Mirrors the document chat introduced in the prior
// chat-first redesign (DocumentChat). Same visual language —
// title bar, avatar-led bot messages, dark user bubbles on the
// right, action cards inside bot messages, polished composer at
// the bottom — so the firm sees the same surface whether they
// arrive from a document or a bank-feed row.
//
// Server side: persistence + LLM call live behind
// /api/donna/firms/transaction-chat (migration 016 +
// server/donna/transactionChat.js). v1 wires the apply_category
// action; the rest of the action vocabulary renders proposed-only
// until each writer lands.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

import { T, V, D } from '../shared/design-tokens.js';
import { btnPrimary, btnChip } from '../shared/buttons.js';
import HeldMatchAuthority from './HeldMatchAuthority.jsx';
import {
  applyFirmTransactionChatAction,
  askFirmTransactionClient,
  fetchFirmTransactionChat,
  postChatComment,
  postFirmTransactionChatMessage,
  writebackXeroTransaction
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
  deriveActionCardState,
  describeTransactionActionDetails,
  findNewClientReplies,
  formatChatTimestamp,
  isNearBottom,
  MATCH_REJECTION_CHOICES,
  matchRejectionPrompt,
  mergeChatMessages,
  transactionChatActionTargetIds
} from '../../lib/transactionChat.js';
import { transactionStatusChip } from '../../lib/documentsInbox.js';
import {
  buildProposalCardMetadata,
  buildProposalApplyReceiptMetadata,
  isSuspenseCoding
} from '../../lib/operatorProposalCards.js';
import {
  ProposalMetaStrip,
  ApplyReceiptStrip
} from '../shared/operator-proposal-card-strips.jsx';
import {
  isMeaningfulMatch,
  matchHeroFields,
  matchHeroReasoning,
  shouldSuppressProactiveAskClient
} from '../../lib/transactionMatchHero.js';
import { buildTransactionCandidatePickerData } from '../../lib/manualLinkPicker.js';
import { buildOwnerTransactionView } from '../../lib/ownerTransactionView.js';
import TransactionAuditTimeline from './transaction-audit-timeline.jsx';
import { vendorDisplayFor } from '../../lib/documentsInbox.js';
import { emitToast } from '../../lib/toastBus.js';
import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';
import {
  OPERATOR_ACTION_TYPE_MESSAGE_IDS,
  TRANSACTION_REJECTION_MESSAGE_IDS
} from '../../i18n/catalogs/remainingSurfaces.en.js';
import {
  buildOptimisticUserMessage,
  removeOptimisticChatTurn,
  settleOptimisticChatTurn
} from '../../lib/chatOptimistic.js';

// Auto-poll cadence for refreshing the chat against the server. Tuned
// for "feels almost immediate when the client replies" without
// burning bandwidth on a panel left open in the background. Paused
// entirely while the document is hidden and while submitting === true.
// One module-top constant so tuning later is a single-line change.
const POLL_INTERVAL_MS = 20_000;

// Distance from the bottom of the scroll area (in px) within which we
// still treat the firm as "following live" and auto-pin to the bottom
// on a new message. Beyond it, they're reading older messages — leave
// their scroll position alone.
const SCROLL_PIN_THRESHOLD_PX = 80;

const dateLabel = (date, formatDate) => {
  if (!date) return '—';
  try {
    return formatDate(date instanceof Date ? date : String(date).slice(0, 10), {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  } catch {
    return '—';
  }
};

const amountLabel = (tx, formatAmount) => {
  const inAmt = Number(tx.money_in || 0);
  const outAmt = Number(tx.money_out || 0);
  const currency = tx.account_currency || tx.currency || null;
  if (inAmt > 0) return formatAmount(inAmt, { currency, signDisplay: 'always', negativeStyle: 'minus' });
  if (outAmt > 0) return formatAmount(-outAmt, { currency, negativeStyle: 'minus' });
  return '—';
};

// Compose the toast text for a client_reply_received message that
// landed during a polling tick. Includes a short transaction hint so
// the firm — who may be looking elsewhere on the page — can tell
// which row the reply belongs to without reading the chat.
const replyToastMessage = (tx, reply, formatMessage) => {
  const hint = String(tx?.description || tx?.raw_description || '').trim().slice(0, 48);
  const replyText = String(reply?.content || '').trim().slice(0, 80);
  if (replyText && hint) {
    return formatMessage({ id: 'transaction.toast.clientReplyWithHintAndText' }, { hint, replyText });
  }
  if (hint) return formatMessage({ id: 'transaction.toast.clientReplyWithHint' }, { hint });
  if (replyText) return formatMessage({ id: 'transaction.toast.clientReplyWithText' }, { replyText });
  return formatMessage({ id: 'transaction.toast.clientReply' });
};

const TransactionArtifact = ({
  artifact,
  setArtifact,
  onRefreshRef,
  onSuggestTransactionCoding,
  onApplyLifecycle = null
}) => {
  const intl = useIntl();
  const { formatAmount, formatDate, formatTimestamp } = useInterfaceLocale();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  const data = artifact?.data || {};
  const detailPreview = data.previewMode === 'detail';
  const actionPreview = data.previewMode === 'action-cards';
  const tx = data.transaction || {};
  const match = data.match || null;
  const matchedDocument = data.matchedDocument || null;
  const onOpenMatchedDocument = data.onOpenMatchedDocument || null;
  const onOpenDocument = data.onOpenDocument || null;
  const clientId = tx.client_id || data.clientId || null;
  const transactionId = tx.id || null;
  const onSnapshotApplied = data.onSnapshotApplied;

  // Manual-search candidate pool — heuristic nearby-document retrieval
  // (amount/date/vendor-token proximity via manualLinkPicker scoring).
  // These are raw weighted-score neighbors, NOT pipeline match
  // proposals; the LLM matchers' persisted verdicts are the only thing
  // this artifact renders as a match. The pool feeds (a) the collapsed
  // "Search nearby documents" affordance below and (b) the chat call's
  // candidate_documents context, where more context is never a gate.
  const candidateDocs = useMemo(() => {
    if (!transactionId) return [];
    if (isMeaningfulMatch(match)) return [];
    const documents = Array.isArray(data.documents) ? data.documents : [];
    const transactions = Array.isArray(data.transactions) ? data.transactions : [tx];
    const reconciliationMatches = Array.isArray(data.reconciliationMatches) ? data.reconciliationMatches : [];
    if (!documents.length) return [];
    const picker = buildTransactionCandidatePickerData({
      transactionId,
      documents,
      transactions,
      reconciliationMatches
    });
    return picker.candidates
      .filter((c) => !c.blocked && c.score > 0.15)
      .slice(0, 5);
  }, [transactionId, match, data.documents, data.transactions, data.reconciliationMatches, tx]);

  const [messages, setMessages] = useState(() => (
    actionPreview && Array.isArray(data.previewMessages) ? data.previewMessages : []
  ));
  const [appliableActionTypes, setAppliableActionTypes] = useState(() => (
    actionPreview && Array.isArray(data.previewAppliableActionTypes) ? data.previewAppliableActionTypes : []
  ));
  const [explanation, setExplanation] = useState(() => (actionPreview ? data.previewExplanation || null : null));
  const [loading, setLoading] = useState(!actionPreview);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeMentionAgent, setActiveMentionAgent] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [applyState, setApplyState] = useState(() => (
    actionPreview && data.previewApplyState && typeof data.previewApplyState === 'object'
      ? data.previewApplyState
      : {}
  ));
  // Single-row write-back from the artifact: idle | posting | posted | error.
  // The post action lives HERE (and the global feed chat), not as a per-row
  // button in the feed — keeps the feed quiet while the case file you opened
  // carries the deliberate "post it" affordance.
  const [postState, setPostState] = useState({ status: 'idle', error: null });
  // 'chat'           — Send goes to Donna (LLM round-trip, proposes actions)
  // 'client_question' — Send goes directly to the client portal as an
  //                      evidence request, skipping the LLM. Set by the
  //                      "Ask client about this" pill; resets to 'chat'
  //                      after a successful send.
  const [sendMode, setSendMode] = useState('chat');
  // Manual search starts collapsed — heuristic neighbors are an escape
  // hatch the firm opts into, not the artifact's primary guidance on
  // an unmatched line.
  const [manualSearchOpen, setManualSearchOpen] = useState(false);
  // Guided composer state. Rejection is a conversation before it is a
  // mutation: the first click opens bounded reasons, a reason starts a Donna
  // turn, and only the structured proposal Donna returns can reach the
  // existing reject_match writer.
  const [composerFlow, setComposerFlow] = useState(null);
  // Per-item AI coding re-run (header refresh icon, database lane).
  // Goes through the persisted pipeline coder — onSuggestTransactionCoding
  // POSTs transaction-intel/suggest and applies the returned snapshot —
  // never a UI-layer second opinion.
  const [recoding, setRecoding] = useState(false);
  const [recodeError, setRecodeError] = useState(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const optimisticTurnSequenceRef = useRef(0);
  // Universal @mentions: '@' opens the eligible roster and picked actors
  // become structured refs. Humans use the comment lane; @Donna addresses
  // this existing synchronous Donna chat; specialists use the Ask runtime.
  const mentionComposer = useMentionComposer({ clientId, setDraft, textareaRef });
  // Refresh-handler indirection — the polling tick and the manual
  // refresh button both fire through this ref. Owned by the mount
  // effect so its closure carries the current (clientId, transactionId)
  // and the cleanup tears it down on unmount / artifact swap.
  const refreshRef = useRef(() => {});
  // Submitting captured as a ref so the polling tick can read the
  // current value without rebuilding the interval every time
  // submitting flips. Keeps the in-flight send race-free.
  const submittingRef = useRef(false);
  // Latest messages snapshot, mirrored into a ref so the polling tick
  // can diff prev → next outside the setState updater. Computing the
  // diff in the updater would either need side effects there
  // (discouraged) or run twice in StrictMode and double-toast.
  const messagesRef = useRef([]);
  // Opening an item must begin at its summary, not jump to the historical
  // conversation's live edge. Once the initial thread has painted, later
  // replies and sends may resume the normal near-bottom auto-follow behavior.
  const initialThreadPaintedRef = useRef(false);
  // Tracks whether the firm was near the bottom of the scroll area at
  // the last scroll event. Used to gate the auto-scroll-on-new-message
  // effect — see isNearBottom in src/lib/transactionChat.js.
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Chat load + auto-poll lifecycle.
  //
  // - One mount-time fetch shows the loading state and REPLACES
  //   messages (canonical initial render).
  // - A setInterval tick polls on POLL_INTERVAL_MS and MERGES the
  //   server snapshot into local state via mergeChatMessages.
  // - The visibilitychange listener pauses the timer (browser already
  //   throttles bg setInterval to ~1Hz but we'd still issue a fetch
  //   on each tick) and fires an immediate refresh on resume so a
  //   returning firm sees the latest without waiting a full cycle.
  // - submittingRef gates polling so an in-flight Donna send isn't
  //   raced by a stale merge.
  // - All controllers + the interval + the visibility listener are
  //   torn down on unmount / artifact swap, so a poll that lands
  //   after unmount is a no-op.
  //
  // The refresh path NEVER touches draft, sendMode, submitting,
  // sendError, or applyState — those are local to the firm's
  // composer / apply lifecycle and merging server state into them
  // would clobber in-progress work.
  useEffect(() => {
    if (detailPreview) {
      refreshRef.current = () => {};
      return undefined;
    }
    if (actionPreview) {
      refreshRef.current = () => {};
      initialThreadPaintedRef.current = false;
      setMessages(Array.isArray(data.previewMessages) ? data.previewMessages : []);
      setAppliableActionTypes(Array.isArray(data.previewAppliableActionTypes) ? data.previewAppliableActionTypes : []);
      setApplyState(data.previewApplyState && typeof data.previewApplyState === 'object' ? data.previewApplyState : {});
      setExplanation(data.previewExplanation || null);
      setLoadError(null);
      setLoading(false);
      return undefined;
    }
    if (!clientId || !transactionId) {
      refreshRef.current = () => {};
      return undefined;
    }
    const initialController = new AbortController();
    let cancelled = false;
    let pollController = null;
    initialThreadPaintedRef.current = false;
    setLoading(true);
    setLoadError(null);
    fetchFirmTransactionChat({ clientId, transactionId, signal: initialController.signal })
      .then((payload) => {
        if (cancelled) return;
        setMessages(payload?.messages || []);
        setAppliableActionTypes(payload?.appliable_action_types || []);
        if (payload?.explanation) setExplanation(payload.explanation);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setMessages([]);
        setLoadError(err?.message || message('transaction.error.chatLoad'));
        setLoading(false);
      });

    const tick = () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (submittingRef.current) return;
      pollController?.abort();
      pollController = new AbortController();
      const myController = pollController;
      // The tick deliberately never updates explanation (see the .then below
      // and handleRefreshClick) — skip the server-side snapshot build for it.
      fetchFirmTransactionChat({ clientId, transactionId, signal: myController.signal, explanation: false })
        .then((payload) => {
          if (cancelled || myController.signal.aborted) return;
          const incoming = payload?.messages || [];
          // findNewClientReplies dedupes by id, so re-running the same
          // snapshot (e.g. firm clicks refresh mid-poll) is idempotent.
          // Toast emission is gated to the polling path — the initial
          // mount fetch (which loads pre-existing replies) doesn't toast.
          const newReplies = findNewClientReplies(messagesRef.current, incoming);
          setMessages((prev) => mergeChatMessages(prev, incoming));
          if (Array.isArray(payload?.appliable_action_types)) {
            setAppliableActionTypes(payload.appliable_action_types);
          }
          for (const reply of newReplies) {
            emitToast({
              message: replyToastMessage(tx, reply, intl.formatMessage),
              tone: 'intel'
            });
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
  }, [clientId, transactionId, intl.locale, detailPreview, actionPreview]);

  // Auto-scroll to bottom on new messages, but only when the firm is
  // already following the live edge. If they're scrolled up reading
  // older context, leave their position alone — a polled reply
  // landing should not yank them away.
  useEffect(() => {
    if (loading || !initialThreadPaintedRef.current) {
      if (!loading) initialThreadPaintedRef.current = true;
      return;
    }
    if (!scrollRef.current) return;
    if (!wasNearBottomRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [loading, messages.length, submitting, mentionComposer.directDonna]);

  const handleScroll = () => {
    wasNearBottomRef.current = isNearBottom(scrollRef.current, SCROLL_PIN_THRESHOLD_PX);
  };

  const handleRefreshClick = async () => {
    // Database lane: the refresh icon re-runs the AI coder for THIS
    // transaction, then re-fetches the thread payload so the verdict
    // card (explanation) reflects the fresh ai_suggestion — the tick
    // path deliberately never updates explanation. Demo lane (no
    // handler): plain thread re-poll, the icon's original behavior.
    if (onSuggestTransactionCoding && transactionId && !recoding) {
      setRecoding(true);
      setRecodeError(null);
      try {
        await onSuggestTransactionCoding(transactionId);
        const payload = await fetchFirmTransactionChat({ clientId, transactionId });
        setMessages((prev) => mergeChatMessages(prev, payload?.messages || []));
        if (Array.isArray(payload?.appliable_action_types)) {
          setAppliableActionTypes(payload.appliable_action_types);
        }
        if (payload?.explanation) setExplanation(payload.explanation);
      } catch (err) {
        setRecodeError(err?.message || message('transaction.error.recode'));
      } finally {
        setRecoding(false);
      }
      return;
    }
    refreshRef.current();
  };

  useEffect(() => {
    if (onRefreshRef) onRefreshRef.current = handleRefreshClick;
    return () => { if (onRefreshRef) onRefreshRef.current = null; };
  });

  const sendMessage = async ({ text = draft, mode = sendMode } = {}) => {
    const userText = String(text || '').trim();
    if (!userText || submittingRef.current || !clientId || !transactionId) return;
    const selectedMentions = mentionComposer.mentions;
    const selectedFlavor = mentionComposer.flavor;
    const directDonna = mentionComposer.directDonna;
    const addressedAgent = directDonna ? selectedMentions[0] : null;
    // Close the same-frame double-click window before React commits the state
    // update. Guided reasons send immediately, so two fast taps must still
    // create exactly one Donna turn.
    submittingRef.current = true;
    setSubmitting(true);
    setSendError(null);
    setComposerFlow(null);
    setDraft('');
    setActiveMentionAgent(addressedAgent);
    if (selectedMentions.length > 0) mentionComposer.reset();
    const optimisticId = `local:transaction-chat:${transactionId}:${++optimisticTurnSequenceRef.current}`;
    const optimisticPayload = mode === 'client_question'
      ? { kind: 'client_question_sent' }
      : selectedMentions.length > 0 && !directDonna
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
    if (actionPreview) {
      const settled = buildOptimisticUserMessage({
        id: `preview:transaction-chat:${transactionId}:${optimisticTurnSequenceRef.current}`,
        content: userText,
        payload: optimisticPayload
      });
      const response = mode === 'client_question'
        ? {
            id: `preview:transaction-system:${transactionId}:${optimisticTurnSequenceRef.current}`,
            role: 'system',
            content: message('transaction.action.questionSent'),
            payload: { kind: 'client_question_sent' }
          }
        : {
            id: `preview:transaction-assistant:${transactionId}:${optimisticTurnSequenceRef.current}`,
            role: 'assistant',
            content: message('transaction.activity.thinkingDetail'),
            payload: { actions: [] }
          };
      setMessages((prev) => settleOptimisticChatTurn(prev, optimisticId, [settled, response]));
      setSendMode('chat');
      submittingRef.current = false;
      setSubmitting(false);
      setActiveMentionAgent(null);
      return;
    }
    try {
      if (mode === 'chat' && selectedMentions.length > 0 && !directDonna) {
        // A non-Donna mentioning draft is a COMMENT on the artifact. Human
        // coordination takes no LLM turn; a specialist 'ask' mints its
        // blocking runtime question. @Donna falls through to the existing
        // synchronous artifact-chat path below.
        const result = await postChatComment({
          clientId,
          surface: 'transaction_chat',
          transactionId,
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
      if (mode === 'client_question') {
        // Direct send — skip Donna, create the evidence request and
        // persist a record in the chat thread.
        const result = await askFirmTransactionClient({
          clientId,
          transactionId,
          question: userText
        });
        const additions = [];
        if (result?.user_message) additions.push(result.user_message);
        if (result?.system_message) additions.push(result.system_message);
        if (additions.length) {
          setMessages((prev) => settleOptimisticChatTurn(prev, optimisticId, additions));
        } else {
          setMessages((prev) => removeOptimisticChatTurn(prev, optimisticId));
        }
        if (result?.snapshot) {
          propagateSnapshot(result.snapshot);
        }
        setSendMode('chat');
        return;
      }
      const result = await postFirmTransactionChatMessage({
        clientId,
        transactionId,
        message: userText,
        transactionContext: tx,
        // Stage B follow-up: the artifact knows the matched document
        // up-front via `data.matchedDocument` (threaded in by
        // donna-financials-panel.jsx at openTx-time). Merge it into
        // candidateDocuments so the LLM has the doc's vendor / amount
        // / date in its `candidate_documents` context.
        //
        // Stage E: when no meaningful match exists, the ranked candidates
        // from buildTransactionCandidatePickerData go into the same
        // array — so the LLM can reason about which doc is the most
        // likely settle for the tx and propose link_document with the
        // right id, rather than guessing or asking "I don't have access
        // to candidate documents".
        candidateDocuments: [
          ...(matchedDocument ? [matchedDocument] : []),
          ...candidateDocs.map((c) => c.document),
          ...(data.candidateDocuments || [])
        ],
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
      setSendError(err?.message || (mode === 'client_question'
        ? message('transaction.error.sendClient')
        : message('transaction.error.sendMessage')));
      setDraft(userText);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      setActiveMentionAgent(null);
    }
  };

  const handleSend = () => sendMessage();

  // Keep the open case file in sync with the persisted verdict. The artifact's
  // `data.transaction` is captured when the row is opened (FirmOpsConsole builds
  // it from the snapshot at click-time, transaction-artifact's owner) and is NOT
  // reactive to later snapshot updates — so after an in-artifact "categorise &
  // post" the header chip and the Send-to-Xero gate would keep reading the row's
  // pre-apply state ("suggested") even though it's now accepted/synced. Re-derive
  // THIS transaction from the returned snapshot and splice it into the open
  // artifact, THEN propagate to the parent feed as before. Render the persisted
  // verdict, not the open-time legacy layer.
  const propagateSnapshot = (snapshot) => {
    if (!snapshot) return;
    const freshTx = transactionId && Array.isArray(snapshot.transactions)
      ? snapshot.transactions.find((t) => t && t.id === transactionId)
      : null;
    if (freshTx && typeof setArtifact === 'function') {
      setArtifact((prev) =>
        prev && prev.type === 'transaction' && prev.data?.transaction?.id === transactionId
          ? { ...prev, data: { ...prev.data, transaction: freshTx } }
          : prev
      );
    }
    if (typeof onSnapshotApplied === 'function') onSnapshotApplied(snapshot);
  };

  const handleApplyAction = async ({ messageId, actionIndex }) => {
    const key = `${messageId}:${actionIndex}`;
    const message = messages.find((candidate) => candidate?.id === messageId);
    const action = Array.isArray(message?.payload?.actions)
      ? message.payload.actions[actionIndex]
      : null;
    const transactionIds = transactionChatActionTargetIds({
      action,
      focusedTransactionId: transactionId
    });
    setApplyState((prev) => ({ ...prev, [key]: { status: 'applying', error: null } }));
    onApplyLifecycle?.({ phase: 'start', transactionIds });
    if (actionPreview) {
      const result = {
        applied: transactionIds.length || 1,
        failed: 0,
        results: transactionIds.map((id) => ({ transaction_id: id, status: 'applied' }))
      };
      setMessages((prev) => prev.map((candidate) => {
        if (candidate.id !== messageId) return candidate;
        const actions = Array.isArray(candidate?.payload?.actions) ? candidate.payload.actions : [];
        return {
          ...candidate,
          payload: {
            ...candidate.payload,
            actions: actions.map((candidateAction, candidateIndex) => (
              candidateIndex === actionIndex
                ? { ...candidateAction, status: 'applied', result }
                : candidateAction
            ))
          }
        };
      }));
      onApplyLifecycle?.({ phase: 'settle', transactionIds, results: result.results });
      setApplyState((prev) => ({ ...prev, [key]: { status: 'applied', error: null } }));
      return;
    }
    try {
      const result = await applyFirmTransactionChatAction({
        clientId,
        transactionId,
        messageId,
        actionIndex
      });
      // The 2xx response is the persisted apply receipt. Only now may the
      // affected rows show success; until here they carry the in-flight pulse.
      const applied = result?.applied !== false;
      const receiptError = applied
        ? null
        : (result?.skipped_reason || result?.reason || message('transaction.error.actionNotApplied'));
      onApplyLifecycle?.({
        phase: 'settle',
        transactionIds,
        results: transactionIds.map((id) => ({
          transaction_id: id,
          applied,
          ...(receiptError ? { error: receiptError } : {})
        }))
      });
      if (result?.assistant_message) {
        setMessages((prev) =>
          prev.map((m) => (m.id === result.assistant_message.id ? result.assistant_message : m))
        );
      }
      setApplyState((prev) => ({ ...prev, [key]: { status: 'applied', error: null } }));
      if (result?.snapshot) {
        propagateSnapshot(result.snapshot);
      }
    } catch (err) {
      onApplyLifecycle?.({
        phase: 'settle',
        transactionIds,
        results: transactionIds.map((id) => ({
          transaction_id: id,
          applied: false,
          error: err?.message || message('transaction.error.apply')
        }))
      });
      setApplyState((prev) => ({
        ...prev,
        [key]: { status: 'error', error: err?.message || message('transaction.error.apply') }
      }));
    }
  };

  // Post this single transaction to the accounting system (Xero/QBO) or the
  // Donna ledger — the artifact's one deliberate write-back, the same single-row
  // writer the feed used to expose per row. Rendered only for an accepted/
  // resolved, not-yet-synced row (the strip below gates it), so an unconfirmed
  // line is never posted from here — the firm accepts it first.
  const handleSendToXero = async () => {
    setPostState({ status: 'posting', error: null });
    try {
      const response = await writebackXeroTransaction({ clientId, transactionId, dryRun: false });
      setPostState({ status: 'posted', error: null });
      if (response) {
        propagateSnapshot(response.snapshot || response);
      } else if (typeof handleRefreshClick === 'function') {
        handleRefreshClick();
      }
    } catch (err) {
      setPostState({ status: 'error', error: err?.message || message('transaction.error.post') });
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

  const handlePillClick = ({ prompt, sendMode: pillMode = 'chat' }) => {
    // Resize lives in the useEffect below so it runs *after* React
    // commits the new value to the DOM. If we measured scrollHeight
    // here we'd be reading the textarea before its value updated,
    // sizing it to fit the old (empty) content — that's what
    // clipped the long pill-filled prompts on first render.
    setDraft(prompt);
    setSendMode(pillMode);
    setComposerFlow(null);
    setSendError(null);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleStartReject = () => {
    setComposerFlow('reject_reason');
    setSendMode('chat');
    setDraft('');
    setSendError(null);
  };

  const handleRejectionChoice = (choiceId) => {
    if (choiceId === 'other') {
      setComposerFlow('reject_other');
      setDraft('This match is wrong because ');
      setSendMode('chat');
      setSendError(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const prompt = matchRejectionPrompt(choiceId);
    if (!prompt) return;
    sendMessage({ text: prompt, mode: 'chat' });
  };

  const activeActivity = useMemo(() => {
    if (recoding) return {
      verb: message('transaction.activity.reviewing'),
      text: message('transaction.activity.reviewingDetail')
    };
    const applying = Object.values(applyState).some((value) => value?.status === 'applying');
    if (applying) return {
      verb: message('transaction.activity.applying'),
      text: message('transaction.activity.applyingDetail')
    };
    if (postState.status === 'posting') return {
      verb: message('transaction.activity.posting'),
      text: message('transaction.activity.postingDetail')
    };
    if (submitting) {
      return sendMode === 'client_question'
        ? {
            verb: message('transaction.activity.sending'),
            text: message('transaction.activity.sendingDetail')
          }
        : {
            verb: message('transaction.activity.thinking'),
            text: message('transaction.activity.thinkingDetail')
          };
    }
    return null;
  }, [applyState, postState.status, recoding, sendMode, submitting, intl.locale]);

  // Auto-resize the composer textarea whenever `draft` changes via any
  // path (typing, pill click, send-restore). Runs post-commit so
  // scrollHeight reflects the just-applied value.
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
  }, [draft]);

  if (!clientId || !transactionId) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: V.t3 }}>
        {message('transaction.unavailable')}
      </div>
    );
  }

  // Note: no in-chat title bar. The artifact panel's own header already
  // identifies the transaction. This body is one reading flow — summary,
  // persisted activity, conversation — with the next-step prompts anchored to
  // the composer.

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
        height: '100%',
        minHeight: 600,
        fontFamily: D.ui,
        fontSize: 13,
        lineHeight: 'normal'
      }}
    >
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            height: '100%',
            overflowY: 'auto',
            padding: '20px 0 26px'
          }}
        >
          <div style={{ maxWidth: 640, margin: '0 auto', padding: '0 24px' }}>
            {isMeaningfulMatch(match) && (
              <MatchHero
                match={match}
                matchedDocument={matchedDocument}
                transaction={tx}
                formatAmount={formatAmount}
                formatDate={formatDate}
              />
            )}
            {/* A match held only by the materiality ceiling: confirm it once, or
                separately authorise future matches like it. Renders nothing
                for any other match. */}
            <HeldMatchAuthority match={match} clientId={data.clientId || tx.client_id || null} onConfirmMatch={data.onConfirmMatch || null} />
            {!isMeaningfulMatch(match) && (
              <div style={{ paddingBottom: 16 }}>
                <MetaBar tx={tx} match={match} formatAmount={formatAmount} formatDate={formatDate} />
                {candidateDocs.length > 0 && (manualSearchOpen ? (
                  <CandidateDocumentsStrip
                    candidates={candidateDocs}
                    onOpenDocument={onOpenDocument}
                    onCollapse={() => setManualSearchOpen(false)}
                    formatAmount={formatAmount}
                    formatDate={formatDate}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setManualSearchOpen(true)}
                    style={{ ...btnChip, fontFamily: D.ui }}
                  >
                    {message('transaction.candidates.search', { count: candidateDocs.length })}
                  </button>
                ))}
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <TransactionAuditTimeline
                clientId={clientId}
                transactionId={transactionId}
                activity={activeActivity}
                previewSnapshot={data.previewAuditSnapshot || null}
                onRetryCoding={onSuggestTransactionCoding ? handleRefreshClick : null}
                retryingCoding={recoding}
                retryCodingError={recodeError}
              />
            </div>
            <OwnerTransactionVerdictCard view={buildOwnerTransactionView(tx, intl.formatMessage)} embedded />
            {!detailPreview && <div style={{ marginTop: 22 }}>
              {loading ? (
                <div style={{ fontSize: 13, color: V.t4 }}>{message('transaction.conversation.loading')}</div>
              ) : loadError ? (
                <div style={{ fontSize: 13, color: V.neg, fontFamily: "'JetBrains Mono', monospace" }}>
                  {loadError}
                </div>
              ) : (
                <>
                  {(() => {
                  // The artifact's single "post it" affordance (replaces the
                  // per-row Apply in the feed). Accepted-only: a suggested /
                  // awaiting-evidence row shows the button disabled with a hint,
                  // never silently posting an unconfirmed line.
                  const reviewState = String(tx.review_state || tx.payload?.review_state || '').toLowerCase();
                  const syncedSignal =
                    tx.xero_writeback_status === 'synced'
                    || tx.payload?.xero_writeback_status === 'synced'
                    || Boolean(tx.xero_bank_transaction_id || tx.payload?.xero_bank_transaction_id)
                    || reviewState === 'synced' || reviewState === 'posted';
                  const accountingSystem = String(data.accountingSystem || tx.accounting_system || '').toLowerCase();
                  const postLabel = accountingSystem === 'qbo'
                    ? message('transaction.post.quickBooks')
                    : accountingSystem === 'none'
                      ? message('transaction.post.ledger')
                      : message('transaction.post.xero');
                  const posted = syncedSignal || postState.status === 'posted';
                  const postable = (reviewState === 'accepted' || reviewState === 'resolved') && !syncedSignal;
                  const busy = postState.status === 'posting';
                  if (!posted && !postable && postState.status !== 'error') return null;
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                      {posted ? (
                        <span style={{ fontSize: 12.5, fontWeight: 500, color: D.inkSoft, fontFamily: D.ui }}>
                          {message('transaction.post.posted')}
                        </span>
                      ) : postable ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={handleSendToXero}
                          style={{
                            ...btnPrimary,
                            fontFamily: D.ui,
                            opacity: busy ? 0.6 : 1
                          }}
                        >
                          {busy ? message('transaction.post.posting') : postLabel}
                        </button>
                      ) : null}
                      {postState.status === 'error' && (
                        <span style={{ fontSize: 12, color: V.neg, fontFamily: "'JetBrains Mono', monospace" }}>
                          {postState.error}
                        </span>
                      )}
                    </div>
                  );
                  })()}
                  {recodeError && (
                    <div style={{ fontSize: 12.5, color: V.neg, fontFamily: "'JetBrains Mono', monospace", marginBottom: 12 }}>
                      {message('transaction.recode.error', { reason: recodeError })}
                    </div>
                  )}
                  {!isMeaningfulMatch(match) && (
                    <StreamingExplanation explanation={explanation} loading={loading} />
                  )}
                  <ProactiveAskClient
                    explanation={explanation}
                    messages={messages}
                    match={match}
                    onSend={(question) => {
                      setDraft(question);
                      setSendMode('client_question');
                      setSendError(null);
                      if (textareaRef.current) textareaRef.current.focus();
                    }}
                  />
                  {filterSupersededComments(messages).map((msg) => (
                    <ChatMessage
                      key={msg.id}
                      message={msg}
                      appliableActionTypes={appliableActionTypes}
                      applyState={applyState}
                      onApplyAction={handleApplyAction}
                      formatTimestamp={formatTimestamp}
                    />
                  ))}
                  <AgentMentionActivity
                    messages={messages}
                    activeAgent={submitting ? activeMentionAgent : null}
                  />
                </>
              )}
            </div>}
          </div>
        </div>
      </div>
      {!detailPreview && <Composer
        draft={draft}
        textareaRef={textareaRef}
        onInput={handleTextareaInput}
        onKeyDown={handleKeyDown}
        onSend={handleSend}
        onCancelClientMode={() => setSendMode('chat')}
        submitting={submitting}
        sendError={sendError}
        sendMode={sendMode}
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
        starters={(
          <QuickPrompts
            tx={tx}
            explanation={explanation}
            match={match}
            flow={composerFlow}
            submitting={submitting}
            formatAmount={formatAmount}
            formatDate={formatDate}
            onPickPill={handlePillClick}
            onStartReject={handleStartReject}
            onPickRejectReason={handleRejectionChoice}
            onCancelFlow={() => {
              setComposerFlow(null);
              setDraft('');
            }}
            onOpenMatchedDocument={onOpenMatchedDocument}
          />
        )}
      />}
    </div>
  );
};

// Heuristic "uncategorised" rationale — was hardcoded inside the
// bank-feed row's inline expand before that was dropped. We surface
// the same explanation here when the classifier punts (aiCat is
// "unknown" / "suspense" / empty) so the firm sees why no category
// was picked without having to ask. For confident suggestions, the
// rationale isn't useful — the welcome just states the suggestion.
const isLowConfidenceCategory = (aiCat) => {
  if (!aiCat) return true;
  const lower = String(aiCat).toLowerCase();
  return lower === 'unknown' || lower === 'suspense' || lower === 'uncategorised';
};

// First merchant-ish token in the description — used to seed the
// "Ask client" pill so the drafted question references the right
// merchant. Strips leading "Card "/"Wire " prefixes and stops at
// the first comma/colon/pipe.
const extractMerchantHint = (description) => {
  if (typeof description !== 'string') return '';
  const cleaned = description.trim()
    .replace(/^(card|wire|debit|credit|payment|transfer|sale)\s+/i, '')
    .split(/[|,:(]/)[0]
    .trim();
  return cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned;
};

const TRANSACTION_STATUS_MESSAGE_IDS = Object.freeze({
  'Matched · confirmed': 'transaction.status.matchedConfirmed',
  'Matched · auto': 'transaction.status.matchedAuto',
  'Matched by policy': 'transaction.status.matchedByPolicy',
  'Matched · suggested': 'transaction.status.matchedSuggested',
  Reconciled: 'transaction.status.reconciled',
  Explained: 'transaction.status.explained',
  'Waiting evidence': 'transaction.status.waitingEvidence',
  Memory: 'transaction.status.memory',
  'No match': 'transaction.status.noMatch'
});

const MetaBar = ({ tx, match = null, formatAmount, formatDate }) => {
  const intl = useIntl();
  const amount = amountLabel(tx, formatAmount);
  const date = dateLabel(tx.transaction_date || tx.date, formatDate);
  // When a meaningful match exists, append the row-style status chip
  // ("MATCHED · AUTO") to the meta so the artifact's eyebrow mirrors
  // the bank-feed row the firm clicked. Drops out cleanly when match
  // is null — no empty chip slot.
  const chip = isMeaningfulMatch(match) ? transactionStatusChip({ transaction: tx, match }) : null;
  const meta = [date, amount].filter((s) => s && s !== '—').join('  ·  ');
  if (!meta && !chip) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      marginBottom: 16
    }}>
      {meta && (
        <span style={{
          fontSize: 12, color: V.t4, fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.02em'
        }}>
          <FormattedValue>{meta}</FormattedValue>
        </span>
      )}
      {chip && (
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: V.pos,
          fontFamily: "'JetBrains Mono', monospace",
          padding: '2px 8px',
          borderRadius: 9999,
          background: V.posSurface,
          border: `1px solid ${V.pos}33`
        }}>
          {intl.formatMessage({ id: TRANSACTION_STATUS_MESSAGE_IDS[chip.label] || 'transaction.status.unknown' }, {
            status: chip.label
          })}
        </span>
      )}
    </div>
  );
};

// Manual-search strip — heuristic nearby documents for an unmatched
// transaction, shown only after the firm opens the search affordance.
// Labeled as proximity-sorted retrieval, never as match proposals:
// that judgment belongs to the matcher pipeline, whose persisted
// verdicts render via the MatchHero. Mirrors the doc-side
// CandidateTransactions component (DocumentChat) — same hint
// vocabulary, same row shape — so a (tx, doc) pair reads the same
// from either direction.
const CANDIDATE_HINT_BADGES = Object.freeze({
  amount_exact: { messageId: 'transaction.candidates.hint.exactAmount', color: V.pos },
  amount_close: { messageId: 'transaction.candidates.hint.amountClose', color: '#B8860B' },
  date_exact:   { messageId: 'transaction.candidates.hint.sameDay', color: V.pos },
  date_close:   { messageId: 'transaction.candidates.hint.nearDate', color: '#B8860B' },
  vendor_overlap: { messageId: 'transaction.candidates.hint.vendorMatch', color: V.intel }
});

const formatCandidateAmount = (doc, formatAmount) => {
  const n = Number(doc?.total_amount);
  if (!Number.isFinite(n)) return '—';
  return formatAmount(Math.abs(n), {
    currency: String(doc.currency || '').trim() || null,
    minimumFractionDigits: Math.abs(n) % 1 ? 2 : 0,
    maximumFractionDigits: 2,
    negativeStyle: 'minus'
  });
};

const formatCandidateDate = (raw, formatDate) => {
  if (!raw) return '';
  try {
    return formatDate(raw instanceof Date ? raw : String(raw).slice(0, 10), {
      day: '2-digit', month: 'short', year: undefined
    });
  } catch {
    return '';
  }
};

const CandidateDocumentsStrip = ({
  candidates = [],
  onOpenDocument = null,
  onCollapse = null,
  formatAmount,
  formatDate
}) => {
  const intl = useIntl();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  if (!candidates.length) return null;
  return (
    <div style={{
      border: `1px solid ${V.borderSubtle}`,
      borderRadius: 12,
      background: V.surface,
      padding: '14px 16px'
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: V.t4,
          fontFamily: "'JetBrains Mono', monospace"
        }}>
          {message('transaction.candidates.title')}
        </span>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            style={{
              marginInlineStart: 'auto',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: V.t4,
              fontSize: 11,
              fontFamily: D.ui,
              cursor: 'pointer',
              textDecoration: 'underline'
            }}
          >
            {message('common.hide')}
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: V.t4, marginBottom: 10 }}>
        {message('transaction.candidates.description')}
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 0
      }}>
        {candidates.map((c, i) => {
          const doc = c.document;
          const vendor = vendorDisplayFor(doc) || doc.filename || '(no vendor)';
          const last = i === candidates.length - 1;
          const clickable = typeof onOpenDocument === 'function';
          return (
            <div
              key={doc.id}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => onOpenDocument(doc) : undefined}
              onKeyDown={clickable ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenDocument(doc);
                }
              } : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0',
                borderBottom: last ? 'none' : `1px solid ${V.borderSubtle}`,
                cursor: clickable ? 'pointer' : 'default'
              }}
            >
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11, color: V.t4, flexShrink: 0, width: 48
              }}>
                <FormattedValue>{formatCandidateDate(doc.document_date, formatDate)}</FormattedValue>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, color: V.t1, fontWeight: 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>
                  <BidiText direction="auto">{vendor}</BidiText>
                </div>
                <div style={{
                  fontSize: 11.5, color: V.t3,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  marginTop: 1
                }}>
                  <BidiText direction="auto">{doc.filename}</BidiText>
                </div>
                {c.hints?.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    {c.hints.map((h) => {
                      const badge = CANDIDATE_HINT_BADGES[h];
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
                <FormattedValue>{formatCandidateAmount(doc, formatAmount)}</FormattedValue>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// One calm matched-document summary. The document artifact owns the full file
// review; this transaction surface keeps only the verdict, extracted essentials,
// reasoning, and the direct navigation/correction actions.
//
// Renders nothing when there's no meaningful match — keeps the
// unmatched/rejected path untouched. A meaningful match whose document
// object didn't resolve (stale matched_object_id, filtered collection)
// still renders, degraded to the persisted match receipt — the earlier
// `match && matchedDocument` guard made exactly that case a silent blank
// above the audit trail, which read as "reconciled with no evidence".
const MatchHero = ({
  match,
  matchedDocument,
  transaction = null,
  formatAmount,
  formatDate
}) => {
  const intl = useIntl();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  if (!isMeaningfulMatch(match)) return null;
  const fields = matchHeroFields(matchedDocument, match, transaction, {
    formatAmount,
    formatDate,
    formatMessage: intl.formatMessage
  });
  const reasoning = matchHeroReasoning(match);
  const chip = transactionStatusChip({ match });
  const documentTitle = matchedDocument
    ? (matchedDocument.filename || vendorDisplayFor(matchedDocument) || message('transaction.match.document'))
    : message('transaction.match.documentOnFile');
  const transactionMeta = [
    dateLabel(transaction?.transaction_date || transaction?.date, formatDate),
    amountLabel(transaction || {}, formatAmount)
  ].filter((value) => value && value !== '—').join(' · ');
  return (
    <section
      style={{
        paddingBottom: 18,
        borderBottom: `1px solid ${D.ruleSoft}`,
        fontFamily: D.ui
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: D.accentWarmFlat, flex: '0 0 auto' }} />
        <span style={{ fontSize: 13, lineHeight: 'normal', fontWeight: 600, color: D.ink }}>
          {message(TRANSACTION_STATUS_MESSAGE_IDS[chip.label] || 'transaction.status.unknown', { status: chip.label })}
        </span>
        {reasoning?.confidence != null && (
          <span style={{ fontSize: 12, color: D.inkMute, ...D.tabular }}>
            <FormattedValue>
              {formatAmount(Math.round(reasoning.confidence * 100), {
                currency: null,
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
                negativeStyle: 'minus'
              })}%
            </FormattedValue>
          </span>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.35, fontWeight: 500, color: D.ink, overflowWrap: 'anywhere' }}>
        <BidiText direction="auto">{documentTitle}</BidiText>
      </div>
      {transactionMeta && (
        <div style={{ marginTop: 3, fontSize: 12.5, color: D.inkMute, ...D.tabular }}>
          <FormattedValue>{transactionMeta}</FormattedValue>
        </div>
      )}
      {!matchedDocument && (
        <div style={{ marginTop: 6, fontSize: 12, color: D.inkMute, lineHeight: 1.4 }}>
          {message('transaction.match.fileUnavailable')}
        </div>
      )}
      {fields.length > 0 && (
        <div style={{
          marginTop: 14,
          display: 'grid',
          gridTemplateColumns: 'minmax(96px, 0.42fr) minmax(0, 1fr)',
          rowGap: 6,
          columnGap: 12,
          fontSize: 12.5
        }}>
          {fields.map((field) => (
            <Fragment key={field.label}>
              <span style={{ color: D.inkMute }}>{field.label}</span>
              <span style={{
                color: D.ink,
                textAlign: 'start',
                overflowWrap: 'anywhere',
                ...D.tabular
              }}>
                {field.kind === 'amount' || field.kind === 'date'
                  ? <FormattedValue>{field.value}</FormattedValue>
                  : <BidiText direction="auto">{field.value}</BidiText>}
              </span>
            </Fragment>
          ))}
        </div>
      )}
      {reasoning && (
        <div style={{
          marginTop: 16,
          paddingTop: 14,
          borderTop: `1px solid ${D.ruleSoft}`
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.ink }}>{message('transaction.match.why')}</div>
          {reasoning.reasoning && (
            <div style={{ marginTop: 6, fontSize: 13, color: D.inkSoft, lineHeight: 1.45 }}>
              <BidiText direction="auto">{reasoning.reasoning}</BidiText>
            </div>
          )}
          {reasoning.hops.length > 0 && (
            <details style={{ marginTop: 8, color: D.inkMute, fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', width: 'fit-content' }}>{message('transaction.match.signals')}</summary>
              <div style={{ marginTop: 5, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                <IdentifierText>{reasoning.hops.join(' · ')}</IdentifierText>
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
};

// The owner-transaction verdict, rendered from the persisted
// ai_suggestion.owner_transaction and nothing else (the
// render-the-persisted-verdict rail — no re-derivation, no second opinion).
// Escalate names what rests on the owner; proposal names the posting it is
// ready to make.
export const OwnerTransactionVerdictCard = ({ view, embedded = false }) => {
  const intl = useIntl();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  if (!view) return null;
  const escalated = view.terminal === 'escalate';
  return (
    <div style={{
      maxWidth: embedded ? 'none' : 640,
      margin: embedded ? 0 : '0 auto',
      padding: embedded ? '12px 0 0' : '12px 24px 0',
      width: '100%',
      boxSizing: 'border-box'
    }}>
      <div
        data-testid="owner-transaction-verdict"
        data-terminal={view.terminal}
        style={{
          border: `1px solid ${V.border}`,
          borderRadius: 10,
          padding: '10px 14px',
          fontSize: 12.5,
          background: V.surface,
          color: V.t2,
          fontFamily: D.ui
        }}
      >
        <strong>
          {message('transaction.owner.transfer')}: <BidiText direction="auto">{view.typeLabel}</BidiText>
        </strong>
        {escalated ? (
          <div style={{ marginTop: 4, color: V.t3 }}>
            {message('transaction.owner.onOwner')} · <IdentifierText>{view.reasonCode}</IdentifierText>
            {view.missingEvidence.length > 0 && (
              <>
                {' — '}{message('transaction.owner.missing')}: <IdentifierText>{view.missingEvidence.join(', ')}</IdentifierText>
              </>
            )}
            {view.question && <div style={{ marginTop: 4 }}><BidiText direction="auto">{view.question}</BidiText></div>}
          </div>
        ) : (
          <div style={{ marginTop: 4, color: V.t3 }}>
            {message('transaction.owner.readyToPost')}
            {view.suggestedAccounts && (
              <>
                {' · '}{message('transaction.owner.debit')} <IdentifierText>{view.suggestedAccounts.debit}</IdentifierText>
                {' / '}{message('transaction.owner.credit')} <IdentifierText>{view.suggestedAccounts.credit}</IdentifierText>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const StreamingExplanation = ({ explanation, loading: parentLoading }) => {
  const [visibleWords, setVisibleWords] = useState(0);
  const [done, setDone] = useState(false);
  const prevExplanationRef = useRef(null);

  const fullText = useMemo(() => {
    if (!explanation) return '';
    const parts = [explanation.headline];
    if (explanation.explanation) parts.push(explanation.explanation);
    if (explanation.categoryReason) parts.push(explanation.categoryReason);
    return parts.join('\n\n');
  }, [explanation]);

  const words = useMemo(() => fullText.split(/(\s+)/), [fullText]);

  useEffect(() => {
    if (!explanation || !fullText) return;
    if (prevExplanationRef.current === fullText) return;
    prevExplanationRef.current = fullText;
    setVisibleWords(0);
    setDone(false);
    let i = 0;
    const timer = setInterval(() => {
      i += 3;
      if (i >= words.length) {
        setVisibleWords(words.length);
        setDone(true);
        clearInterval(timer);
      } else {
        setVisibleWords(i);
      }
    }, 25);
    return () => clearInterval(timer);
  }, [fullText, words, explanation]);

  if (parentLoading || !explanation || !fullText) return null;

  const revealed = words.slice(0, visibleWords).join('');

  return (
    <BotMessage>
      <FormattedText text={revealed} />
      {!done && (
        <span style={{
          display: 'inline-block', width: 6, height: 14,
          background: V.t3, borderRadius: 1, marginInlineStart: 2,
          animation: 'blink 0.8s step-end infinite',
          verticalAlign: 'text-bottom'
        }} />
      )}
      {done && explanation.documentFile && (
        <div style={{ marginTop: 8 }}>
          {explanation.documentUrl ? (
            <a
              href={explanation.documentUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: V.intel, fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
                textDecoration: 'underline', textUnderlineOffset: 2
              }}
            >
              {explanation.documentFile}
            </a>
          ) : (
            <span style={{
              color: V.t4, fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace"
            }}>
              {explanation.documentFile}
            </span>
          )}
        </div>
      )}
      <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>
    </BotMessage>
  );
};

// Proactive ask-client card. Appears after the streaming explanation
// when the system determined the transaction needs client input (uncertain
// or low-confidence review). Shows the pre-built question and a one-click
// button to load it into the composer in client_question mode. Hidden
// once the firm has already sent a client question in this thread.
const ProactiveAskClient = ({ explanation, messages, match = null, onSend }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const askClient = explanation?.proactive_ask_client;
  if (!askClient) return null;
  // Stage B: when reconciliation has produced a meaningful match, the
  // categorisation pipeline's "no supporting document — ask the
  // client" verdict is wrong. Suppress the card so the firm isn't
  // pushed toward a redundant evidence request. (Server-side
  // suppression is the deeper fix; this FE guard ships the parity
  // jump without that round-trip.)
  if (shouldSuppressProactiveAskClient(match)) return null;
  const alreadySent = Array.isArray(messages) && messages.some(
    (m) => m?.payload?.kind === 'client_question_sent'
  );
  if (alreadySent) return null;
  return (
    // Calm card (Kari, 2026-08-05): white card + hairline instead of the
    // orange wash panel; the accent dot on the eyebrow is the card's one
    // warm moment. (Left indent dropped with the chat avatar — the thread
    // runs full-width now.)
    <div
      style={{
        margin: '0 0 18px 0',
        border: `1px solid ${V.borderSubtle}`,
        borderRadius: 10,
        background: V.surface,
        padding: '12px 14px',
        maxWidth: 520
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8
      }}>
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 999, background: D.accentWarmFlat, flex: '0 0 auto' }}
        />
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: V.t1,
          fontFamily: "'JetBrains Mono', monospace"
        }}>
          {message('transaction.action.suggestedAsk')}
        </span>
      </div>
      <div style={{
        fontSize: 13,
        color: V.t2,
        lineHeight: 1.5,
        marginBottom: 6
      }}>
        <BidiText direction="auto">{askClient.reason}</BidiText>
      </div>
      <div style={{
        fontSize: 12.5,
        color: V.t3,
        lineHeight: 1.5,
        fontStyle: 'italic',
        marginBottom: 10,
        padding: '8px 10px',
        background: V.bg,
        borderRadius: 6,
        border: `1px solid ${V.borderSubtle}`
      }}>
        <BidiText direction="auto">{askClient.question}</BidiText>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => onSend(askClient.question)}
          // House ink primary (the one-button-law): brick/orange fills were
          // doing alarm duty on a non-alarm (the three-voice law).
          style={{ ...btnPrimary, fontFamily: D.ui }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
        >
          {message('transaction.action.draftClientQuestion')}
        </button>
      </div>
    </div>
  );
};

// Contextual conversation starters live with the composer, where intent is
// expressed. A rejection starter swaps this row for a temporary guided tray;
// choosing a bounded reason starts a Donna turn and still changes nothing by
// itself. The tray disappears after selection instead of becoming a toolbar.
const QuickPrompts = ({
  tx,
  explanation,
  match,
  flow = null,
  submitting = false,
  onPickPill,
  onStartReject,
  onPickRejectReason,
  onCancelFlow,
  onOpenMatchedDocument,
  formatAmount,
  formatDate
}) => {
  const intl = useIntl();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  const aiCat = tx.proposed_account || tx.aiCat || null;
  const amount = amountLabel(tx, formatAmount);
  const date = dateLabel(tx.transaction_date || tx.date, formatDate);
  const merchantHint = extractMerchantHint(tx.description || tx.raw_description || '');
  const conf = explanation?.confidence || 'uncertain';
  const matchPresent = isMeaningfulMatch(match);
  // A missing-account verdict's terminal action is firm-side (create
  // the account in the chart) — the Ask-client pill is the wrong door
  // regardless of confidence.
  const missingAccount = explanation?.missing_account || null;
  const showAskClient = !matchPresent && !missingAccount
    && (explanation?.actions?.includes('ask_client') || conf !== 'confident');

  const askPromptParts = [];
  if (merchantHint) askPromptParts.push(`the ${merchantHint} transaction`);
  else askPromptParts.push('this transaction');
  const dateAmount = [date, amount].filter((value) => value && value !== '—').join(' for ');
  if (dateAmount) askPromptParts.push(`on ${dateAmount}`);
  const promptTransaction = askPromptParts.join(' ');
  const businessUse = Number(tx.money_in || 0) > 0 ? 'business income' : 'a business expense';
  const askClientPrompt = `Hi — quick check on ${promptTransaction}. Could you let me know what this was for and confirm whether it's ${businessUse}? Thanks!`;

  const prompts = [];

  if (matchPresent) {
    prompts.push({
      labelId: 'transaction.prompt.explainMatch.label',
      promptId: 'transaction.prompt.explainMatch.text',
      prompt: 'Explain why this document and bank transaction were matched. Use the recorded signals and call out anything uncertain.',
      sendMode: 'chat'
    });
    prompts.push({
      labelId: 'transaction.prompt.matchAlternatives.label',
      promptId: 'transaction.prompt.matchAlternatives.text',
      prompt: 'What other documents or transactions could fit here? Compare the strongest alternatives with the current match and explain the trade-offs.',
      sendMode: 'chat'
    });
  } else if (missingAccount) {
    // The verdict already knows what the line is — the chart can't
    // hold it. Useful actions: plan the new account, or check whether
    // an existing one could carry it. Not "help me categorize".
    prompts.push({
      labelId: 'transaction.prompt.planAccount.label',
      promptId: 'transaction.prompt.planAccount.text',
      values: { accountName: missingAccount.name },
      prompt: `The chart of accounts is missing "${missingAccount.name}"${missingAccount.account_type ? ` (${missingAccount.account_type})` : ''}. What exactly should we set up in the chart of accounts for this — account name, type, and tax setting — and what happens to the parked transaction once it exists?`,
      sendMode: 'chat'
    });
    prompts.push({
      labelId: 'transaction.prompt.existingAccount.label',
      promptId: 'transaction.prompt.existingAccount.text',
      prompt: 'Could an existing account in the chart hold this line correctly instead? Show the closest options and the trade-offs.',
      sendMode: 'chat'
    });
  } else if (conf === 'confident') {
    prompts.push({
      labelId: 'transaction.prompt.changeCategory.label',
      promptId: 'transaction.prompt.changeCategory.text',
      prompt: 'I want to assign a different category. What are my options given the chart of accounts?',
      sendMode: 'chat'
    });
  } else if (conf === 'review') {
    if (aiCat && !isLowConfidenceCategory(aiCat)) {
      prompts.push({
        labelId: 'transaction.prompt.whyCategory.label',
        promptId: 'transaction.prompt.whyCategory.text',
        values: { category: aiCat },
        prompt: `Why does this classify as ${aiCat}? Walk me through the signals.`,
        sendMode: 'chat'
      });
    }
    prompts.push({
      labelId: 'transaction.prompt.categoryAlternatives.label',
      promptId: 'transaction.prompt.categoryAlternatives.text',
      prompt: 'What other accounts could this map to? Show me the options with reasoning.',
      sendMode: 'chat'
    });
  } else {
    prompts.push({
      labelId: 'transaction.prompt.categorize.label',
      promptId: 'transaction.prompt.categorize.text',
      prompt: 'Suggest a category for this transaction based on the description and amount. If the signal is weak, say so.',
      sendMode: 'chat'
    });
  }

  if (showAskClient) {
    prompts.push({
      labelId: OPERATOR_ACTION_TYPE_MESSAGE_IDS.ask_client,
      promptId: 'transaction.question.example',
      values: { transaction: promptTransaction, businessUse },
      prompt: askClientPrompt,
      sendMode: 'client_question'
    });
  }

  if (flow === 'reject_reason' || flow === 'reject_other') {
    return (
      <div style={{ marginBottom: 9, fontFamily: D.ui }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: flow === 'reject_reason' ? 8 : 3 }}>
          <span style={{ color: D.ink, fontSize: 12.5, fontWeight: 600 }}>
            {message(flow === 'reject_reason' ? 'transaction.reject.title' : 'transaction.reject.instruction')}
          </span>
          <button type="button" onClick={onCancelFlow} disabled={submitting} style={{ ...textLinkButton, marginInlineStart: 'auto' }}>
            {message('transaction.reject.back')}
          </button>
        </div>
        {flow === 'reject_reason' ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {MATCH_REJECTION_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                disabled={submitting}
                onClick={() => onPickRejectReason(choice.id)}
                style={{ ...btnChip, fontFamily: D.ui, opacity: submitting ? 0.55 : 1 }}
              >
                {message(TRANSACTION_REJECTION_MESSAGE_IDS[choice.id].label)}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ color: D.inkMute, fontSize: 11.5 }}>
            {message('transaction.reject.addReason')}
          </div>
        )}
        <div style={{ marginTop: 7, color: D.inkMute, fontSize: 10.5 }}>
          {message('transaction.reject.notApplied')}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        margin: '0 0 9px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6
      }}
    >
      {prompts.map((pill) => (
        <button
          key={pill.labelId}
          type="button"
          onClick={() => onPickPill(pill)}
          title={message(pill.promptId, pill.values)}
          style={{ ...btnChip, fontFamily: D.ui, transition: 'all 0.15s' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = D.ink;
            e.currentTarget.style.borderColor = D.inkMute;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = btnChip.color;
            e.currentTarget.style.borderColor = D.rule;
          }}
        >
          <FormattedMessage
            id={pill.labelId}
            values={pill.values ? Object.fromEntries(
              Object.entries(pill.values).map(([key, value]) => [key, <BidiText key={key} direction="auto">{value}</BidiText>])
            ) : undefined}
          />
        </button>
      ))}
      {matchPresent && (
        <button
          type="button"
          onClick={onStartReject}
          disabled={submitting}
          style={{ ...btnChip, fontFamily: D.ui, opacity: submitting ? 0.55 : 1 }}
        >
          {message('transaction.action.reject')}
        </button>
      )}
      {matchPresent && onOpenMatchedDocument && (
        <button
          type="button"
          onClick={onOpenMatchedDocument}
          disabled={submitting}
          style={{ ...btnChip, fontFamily: D.ui, opacity: submitting ? 0.55 : 1 }}
        >
          {message('transaction.action.openDocument')}
        </button>
      )}
    </div>
  );
};

const textLinkButton = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: D.inkMute,
  fontFamily: D.ui,
  fontSize: 11,
  cursor: 'pointer'
};

const BotMessage = ({ children, timestamp, model }) => (
  <div
    className="donna-chat-message"
    style={{
      display: 'flex',
      gap: 10,
      marginBottom: 18,
      alignItems: 'flex-start',
      animation: `chatMessageIn 180ms ${D.ease}`
    }}
  >
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: '50%',
        background: V.t1,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 700,
        flexShrink: 0,
        marginTop: 2
      }}
    >
      D
    </div>
    <div style={{ minWidth: 0, flex: 1 }}>
      <div
        style={{
          fontSize: 14,
          color: V.t2,
          lineHeight: 1.6,
          maxWidth: 520,
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap'
        }}
      >
        {children}
      </div>
      {(timestamp || model) && (
        <div
          style={{
            fontSize: 11,
            color: V.t4,
            fontFamily: "'JetBrains Mono', monospace",
            marginTop: 4
          }}
        >
          {timestamp && <FormattedValue>{timestamp}</FormattedValue>}
          {timestamp && model && <span aria-hidden="true"> · </span>}
          {model && <IdentifierText>{model}</IdentifierText>}
        </div>
      )}
    </div>
  </div>
);

// Renders a user (firm-typed) message bubble.
// Variants:
//   - default: dark bubble, right-aligned — chat with Donna
//   - client-bound (payload.kind === 'client_question_sent'):
//     purple V.intel bubble with a "→ to client" eyebrow so the firm
//     can tell at a glance which messages went to the client portal
//     vs which went to Donna.
const UserMessage = ({ message, timestamp }) => {
  const intl = useIntl();
  const isClientBound = message?.payload?.kind === 'client_question_sent';
  const bubbleBg = isClientBound ? V.intel : V.t1;
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        marginBottom: 18,
        flexDirection: 'column',
        alignItems: 'flex-end',
        animation: `chatMessageIn 160ms ${D.ease}`
      }}
    >
      {isClientBound && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: V.intel,
            marginBottom: 4,
            fontFamily: "'JetBrains Mono', monospace"
          }}
        >
          {intl.formatMessage({ id: 'transaction.action.sentToClient' })}
        </div>
      )}
      <div
        style={{
          background: bubbleBg,
          color: V.bg,
          borderRadius: '14px 14px 4px 14px',
          padding: '10px 16px',
          fontSize: 14,
          maxWidth: 420,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        <BidiText direction="auto">{message.content}</BidiText>
      </div>
      {timestamp && (
        <div
          style={{
            fontSize: 11,
            color: V.t4,
            fontFamily: "'JetBrains Mono', monospace",
            marginTop: 4
          }}
        >
          <FormattedValue>{timestamp}</FormattedValue>
        </div>
      )}
    </div>
  );
};

// Renders a system (non-firm, non-Donna) message. Variants by
// payload.kind:
//   - ask_client_confirmation : purple — confirmation that a question
//                                shipped to the client portal
//   - client_reply_received    : green — client's response came back;
//                                centred as a left-aligned card so
//                                the firm reads it as inbound, not
//                                another firm/Donna turn
//   - default                  : amber/neg — generic system note
//                                (chat failures, etc.)
const SYSTEM_VARIANTS = {
  ask_client_confirmation: {
    bg: 'intelSurface',
    color: 'intel',
    labelId: 'transaction.action.questionSent',
    align: 'center'
  },
  client_reply_received: {
    bg: 'posSurface',
    color: 'pos',
    labelId: 'transaction.action.clientReplied',
    align: 'left'
  }
};

const SystemMessage = ({ message, timestamp }) => {
  const intl = useIntl();
  const kind = message?.payload?.kind;
  const variant = SYSTEM_VARIANTS[kind];
  const bgColor = variant ? V[variant.bg] : V.negSurface;
  const fgColor = variant ? V[variant.color] : V.neg;
  const borderColor = variant ? `${V[variant.color]}33` : `${V.neg}33`;
  const justify = variant?.align === 'left' ? 'flex-start' : 'center';
  return (
    <div style={{ display: 'flex', justifyContent: justify, marginBottom: 18 }}>
      <div
        style={{
          background: bgColor,
          color: fgColor,
          border: `1px solid ${borderColor}`,
          borderRadius: 10,
          padding: '10px 14px',
          fontSize: 13,
          maxWidth: 520,
          lineHeight: 1.55,
          fontFamily: D.ui
        }}
      >
        {variant?.labelId && (
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 6,
              fontFamily: "'JetBrains Mono', monospace"
            }}
          >
            {intl.formatMessage({ id: variant.labelId })}
          </div>
        )}
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: V.t1 }}>
          <BidiText direction="auto">{message.content}</BidiText>
        </div>
        {timestamp && (
          <div style={{ fontSize: 10, color: V.t4, marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>
            <FormattedValue>{timestamp}</FormattedValue>
          </div>
        )}
      </div>
    </div>
  );
};

// Bold-marker formatter — same as the document chat. Parses
// **double-asterisk** spans into <strong>; everything else is plain
// text. Keeps the rendered surface dependency-free.
const FormattedText = ({ text }) => {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <BidiText direction="auto">
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <strong key={index} style={{ fontWeight: 600, color: V.t1 }}>
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </BidiText>
  );
};

const ChatMessage = ({
  message,
  appliableActionTypes,
  applyState = {},
  onApplyAction,
  formatTimestamp
}) => {
  const intl = useIntl();
  const role = message.role;
  const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
  const timestamp = formatChatTimestamp(message.created_at, (value) => formatTimestamp(value, {
    day: null,
    month: null,
    year: null,
    second: null,
    timeZoneName: null
  }));

  // Universal @mentions: a comment-lane row (human speech, or an agent's
  // answer) renders as the shared attributed card — one look on every
  // surface, whatever role the row was stored under.
  if (isCommentMessage(message)) {
    return <CommentMessage message={message} timestamp={timestamp} />;
  }
  if (role === 'user') {
    const rejectionPromptId = Object.entries(TRANSACTION_REJECTION_MESSAGE_IDS)
      .find(([choiceId, ids]) => ids.prompt && matchRejectionPrompt(choiceId) === message.content)?.[1]?.prompt;
    const presentedMessage = rejectionPromptId
      ? { ...message, content: intl.formatMessage({ id: rejectionPromptId }) }
      : message;
    return <UserMessage message={presentedMessage} timestamp={timestamp} />;
  }
  if (role === 'system') {
    return <SystemMessage message={message} timestamp={timestamp} />;
  }
  return (
    <BotMessage timestamp={timestamp} model={message.model || null}>
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

// ProposalCard v2 tone map — feeds the transaction artifact's palette +
// typography to the shared operator proposal/receipt strips
// (src/components/shared/operator-proposal-card-strips.jsx) so this card
// matches the feed card's grammar without duplicating its markup.
const TX_PROPOSAL_TONE = {
  mono: "'JetBrains Mono', monospace",
  bodyFont: 'inherit',
  border: V.borderSubtle,
  chip: { reversibility: V.t4, guarded: V.neg, clientVisible: V.intel },
  metaLine: { color: V.t3, size: 12, lineHeight: 1.45 },
  diff: { color: V.t2, noteColor: V.t4 },
  warning: { color: V.neg, lineHeight: 1.4 },
  receipt: {
    summaryColor: V.t2,
    summarySize: 12,
    writerColor: V.t4,
    rowColor: V.t2,
    noteColor: V.t4,
    status: { applied: V.pos, partial: V.neg, skipped: V.t4, failed: V.accent }
  }
};

const TransactionActionDetailValue = ({ detail, formatDate, message }) => {
  if (detail.kind === 'message') return message(detail.messageId);
  if (detail.kind === 'identifier') return <IdentifierText>{detail.value}</IdentifierText>;
  if (detail.kind === 'identifier_pair') return (
    <><IdentifierText>{detail.value.transactionId}</IdentifierText><span aria-hidden="true"> → </span><IdentifierText>{detail.value.documentId}</IdentifierText></>
  );
  if (detail.kind === 'date') {
    try {
      return <FormattedValue>{formatDate(detail.value, { day: '2-digit', month: 'short', year: 'numeric' })}</FormattedValue>;
    } catch {
      return <IdentifierText>{detail.value}</IdentifierText>;
    }
  }
  return <BidiText direction="auto">{detail.value}</BidiText>;
};

const ActionCard = ({ action, appliableActionTypes, applyState, onApply }) => {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  const card = deriveActionCardState({
    action,
    appliableTypes: appliableActionTypes,
    applyState,
    hasOnApply: typeof onApply === 'function'
  });
  const meta = buildProposalCardMetadata(action);
  const receipt = buildProposalApplyReceiptMetadata(action);
  const details = describeTransactionActionDetails(action);
  const buttonTitle = card.phase === 'applied'
    ? message('document.action.title.alreadyApplied')
    : card.phase === 'unsupported'
      ? message('transaction.action.unsupported')
      : '';
  const actionMessageId = isSuspenseCoding(action)
    ? 'operator.action.type.suspense'
    : OPERATOR_ACTION_TYPE_MESSAGE_IDS[action.type];
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
              : message('operator.action.type.fallback')}
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
        <div style={{ fontSize: 13, color: V.t2, lineHeight: 1.5 }}><BidiText direction="auto">{action.reason}</BidiText></div>
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
              key={`${detail.labelId || detail.messageId}:${index}`}
              style={{
                fontSize: 12,
                color: V.t3,
                fontFamily: "'JetBrains Mono', monospace"
              }}
            >
              {detail.labelId && <><span>{message(detail.labelId, detail.labelValues)}</span><span aria-hidden="true">: </span></>}
              <TransactionActionDetailValue detail={detail} formatDate={formatDate} message={message} />
            </div>
          ))}
        </div>
      )}
      {receipt
        ? <ApplyReceiptStrip action={action} receipt={receipt} tone={TX_PROPOSAL_TONE} />
        : <ProposalMetaStrip action={action} meta={meta} tone={TX_PROPOSAL_TONE} />}
      {card.error && (
        <div
          style={{
            fontSize: 11,
            color: V.neg,
            fontFamily: "'JetBrains Mono', monospace"
          }}
        >
          <BidiText direction="auto">{card.error}</BidiText>
        </div>
      )}
      {!card.statusIsApplied && !card.statusIsSuperseded && card.phase !== 'unsupported' && (
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
              fontFamily: D.ui,
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

const Composer = ({
  draft,
  textareaRef,
  onInput,
  onKeyDown,
  onSend,
  onCancelClientMode,
  submitting,
  sendError,
  sendMode = 'chat',
  starters = null,
  // Universal @mentions: staged-mention chips (rendered above the card) and
  // the typeahead dropdown (floats over the card, which is why the card
  // wrapper below is position:relative).
  mentionChips = null,
  mentionOverlay = null
}) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const canSend = !!draft.trim() && !submitting;
  const isClientMode = sendMode === 'client_question';
  const placeholder = isClientMode
    ? message('transaction.composer.clientPlaceholder')
    : message('transaction.composer.donnaPlaceholder');
  const sendLabel = message(isClientMode ? 'transaction.composer.sendClient' : 'transaction.composer.send');
  // T.accent (indigo) is the workspace action/"client-bound" accent — the same
  // one the global feed-chat Apply button uses. Use it as the send button bg in
  // client mode so the destination is unmistakable; normal mode uses T.ink, to
  // match the global composer's Send.
  const sendBg = canSend ? (isClientMode ? T.accent : T.ink) : T.mutedSoft;
  const sendBgHover = isClientMode ? T.accent : T.ink;
  return (
    <div
      style={{
        padding: '14px 24px 20px',
        flexShrink: 0,
        background: 'transparent'
      }}
    >
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        {starters}
        {isClientMode && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              marginBottom: 6,
              borderRadius: 8,
              background: T.accentSoft,
              border: `1px solid ${T.accent}33`,
              fontSize: 12,
              color: T.accent,
              fontFamily: D.ui
            }}
          >
            <span style={{ fontWeight: 600 }}>{message('transaction.composer.clientMode')}</span>
            <span style={{ color: T.muted }}>{message('transaction.composer.clientModeBody')}</span>
            <button
              type="button"
              onClick={onCancelClientMode}
              style={{
                marginInlineStart: 'auto',
                padding: '2px 8px',
                border: 'none',
                background: 'transparent',
                color: T.muted,
                fontSize: 11,
                fontFamily: D.ui,
                cursor: 'pointer',
                textDecoration: 'underline'
              }}
            >
              {message('transaction.composer.switchDonna')}
            </button>
          </div>
        )}
        {mentionChips}
        <div
          style={{
            position: 'relative',
            border: `0.5px solid ${T.rule}`,
            borderRadius: 18,
            background: T.card,
            transition: 'all 0.25s',
            boxShadow: '0px 4px 14px rgba(46,42,34,0.05)'
          }}
          onFocusCapture={(e) => {
            e.currentTarget.style.borderColor = T.mutedSoft;
            e.currentTarget.style.boxShadow = '0px 4px 20px rgba(46,42,34,0.08)';
          }}
          onBlurCapture={(e) => {
            e.currentTarget.style.borderColor = T.rule;
            e.currentTarget.style.boxShadow = '0px 4px 14px rgba(46,42,34,0.05)';
          }}
        >
          {mentionOverlay}
          <textarea
            ref={textareaRef}
            value={draft}
            onInput={onInput}
            onChange={() => {}}
            onKeyDown={onKeyDown}
            disabled={submitting}
            rows={1}
            placeholder={placeholder}
            dir="auto"
            style={{
              width: '100%',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontFamily: D.ui,
              fontSize: 14,
              color: T.ink,
              padding: '14px 20px 6px',
              resize: 'none',
              lineHeight: 1.55,
              minHeight: 44,
              boxSizing: 'border-box'
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              padding: '4px 10px 8px'
            }}
          >
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              aria-label={sendLabel}
              title={sendLabel}
              style={{
                width: 28,
                height: 28,
                background: sendBg,
                color: canSend ? T.paper : T.muted,
                border: 'none',
                borderRadius: '50%',
                cursor: canSend ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 0.15s',
                flexShrink: 0
              }}
              onMouseEnter={(e) => {
                if (canSend) e.currentTarget.style.background = sendBgHover;
              }}
              onMouseLeave={(e) => {
                if (canSend) e.currentTarget.style.background = isClientMode ? T.accent : T.ink;
              }}
            >
              {submitting ? (
                <span style={{ fontSize: 11, fontWeight: 700 }}>…</span>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              )}
            </button>
          </div>
        </div>
        {isClientMode && (
          <div
            style={{
              textAlign: 'center',
              fontSize: 11,
              color: T.muted,
              marginTop: 8
            }}
          >
            This message will be sent to the client portal as an evidence request.
          </div>
        )}
        {sendError && (
          <div
            style={{
              fontSize: 11,
              color: T.alert,
              fontFamily: "'JetBrains Mono', monospace",
              textAlign: 'center',
              marginTop: 4
            }}
          >
            {sendError}
          </div>
        )}
      </div>
    </div>
  );
};

export default TransactionArtifact;
