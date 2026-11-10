// Feed chat — the global mass-command input for the bank feed. Renders
// dock-native inside the right rail (FirmDock → ArtifactPanel); the old
// fixed-footer mount in donna-financials-panel is retired.
// One thread per client (server: /api/donna/firms/feed-chat,
// server/donna/feedChat.js). The firm types a command over the whole
// feed ("all Northwind income is consulting revenue", "the 3 Mar Riverside
// payment is a design fee, reconcile all Riverside lines, invoice to
// follow"); Donna resolves the scope into batch actions; the firm
// confirms each action — the whole set — with ONE click.
//
// The proposal card is the receipt: it shows the resolved row count
// and Donna's reply lists the matched rows, so a wrong set is caught
// BEFORE it becomes terminal, not after. Applies return one fresh
// snapshot for the batch → onSnapshotApplied.

import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

import { T, D } from '../shared/design-tokens.js';
import {
  applyFirmFeedChatAction,
  applyFirmInboxChatAction,
  fetchFirmFeedChat,
  fetchFirmInboxChat,
  postFirmFeedChatMessage,
  postFirmInboxChatMessage
} from '../../lib/firmApi.js';
import {
  buildProposalCardMetadata,
  buildProposalApplyReceiptMetadata,
  isSuspenseCoding
} from '../../lib/operatorProposalCards.js';
import {
  ProposalMetaStrip,
  ApplyReceiptStrip
} from '../shared/operator-proposal-card-strips.jsx';
// The shared Donna chat grammar (shared/donna-chat.jsx, extracted from
// document-chat) — this surface renders the SAME bot/user/system messages,
// prompt pills, and composer as the document artifact's chat.
import {
  AssistantBody,
  BotMessage,
  Composer,
  StructuredResponse,
  SystemMessage,
  UserMessage
} from '../shared/donna-chat.jsx';
import { formatChatTimestamp } from '../../lib/documentChat.js';
import { rolePersonaLabel } from '../../lib/teamRosterView.js';
import { documentTargetForAction, financialReportTargetForAction } from '../../lib/chatArtifactTargets.js';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';
import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { OPERATOR_ACTION_TYPE_MESSAGE_IDS } from '../../i18n/catalogs/remainingSurfaces.en.js';
import { feedActionStatusLabel } from '../../lib/interfaceValueLabels.js';


const CLIENT_PROMPTS = [
  { labelId: 'feed.prompt.client.open', promptId: 'feed.promptText.client.open', prompt: "What's still open on this feed?" },
  { labelId: 'feed.prompt.client.waiting', promptId: 'feed.promptText.client.waiting', prompt: 'Which lines are waiting on the client?' },
  { labelId: 'feed.prompt.client.draft', promptId: 'feed.promptText.client.draft', prompt: 'Draft a client question for the unclear lines' }
];
const FIRM_PROMPTS = [
  { labelId: 'feed.prompt.firm.decisions', promptId: 'feed.promptText.firm.decisions', prompt: 'What needs my decision across ventures?' },
  { labelId: 'feed.prompt.firm.open', promptId: 'feed.promptText.firm.open', prompt: 'Which ventures have open lines?' },
  { labelId: 'feed.prompt.firm.draft', promptId: 'feed.promptText.firm.draft', prompt: 'Draft client questions for whatever is unclear' }
];
const FIRM_WORKING_PHRASES = ['feed.working.client.reading', 'feed.working.client.checking', 'feed.working.client.preparing'];
const CLIENT_WORKING_PHRASES = ['feed.working.firm.reading', 'feed.working.firm.checking', 'feed.working.firm.preparing'];
const LOADING_PHRASES = ['feed.working.opening'];
const EMPTY_LIST = Object.freeze([]);
const EMPTY_STATE = Object.freeze({});

// G0.2 (bounded-universe honesty): a firm bigger than the chat's venture
// window gets the truth DECLARED on the surface — which window this reply
// actually read, and a continuation control that runs the SAME prompt as a
// new bounded batch over the next window (deterministic server-side order,
// never model memory). Rendered from the persisted payload's
// coverage/ventures_window — never inferred client-side.
const CoverageBanner = ({ window: w, disabled, onContinue }) => {
  const intl = useIntl();
  if (!w || !Number.isInteger(w.total)) return null;
  const offset = Number.isInteger(w.offset) && w.offset > 0 ? w.offset : 0;
  const shown = Number.isInteger(w.shown) ? w.shown : 0;
  const first = offset + 1;
  const last = offset + shown;
  const remaining = Math.max(0, w.total - last);
  return (
    <div
      style={{
        marginTop: 8,
        padding: '7px 10px',
        border: `1px solid ${T.rule}`,
        borderRadius: 6,
        background: T.amberSoft,
        color: T.inkSoft,
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap'
      }}
    >
      <span>
        <FormattedMessage id="feed.scope.ventures" values={{ start: first, end: last, total: w.total }} />
        {remaining > 0 ? <> <FormattedMessage id="feed.scope.continueHint" /></> : null}
      </span>
      {remaining > 0 && (
        <button
          type="button"
          onClick={onContinue}
          disabled={disabled}
          style={{
            border: `1px solid ${T.rule}`,
            borderRadius: 5,
            background: T.card,
            color: T.ink,
            fontSize: 12,
            padding: '3px 9px',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.6 : 1
          }}
        >
          {intl.formatMessage({ id: 'feed.scope.nextBatch' }, { remaining })}
        </button>
      )}
    </div>
  );
};

const StarterActions = ({ firmScope, disabled, onRun }) => {
  const intl = useIntl();
  return <div style={{ flexShrink: 0, padding: '2px 14px 0' }}>
    <div
      role="group"
      aria-label={intl.formatMessage({ id: 'feed.suggestions.title' })}
      style={{
        display: 'flex',
        gap: 6,
        overflowX: 'auto',
        paddingBottom: 2,
        scrollbarWidth: 'none'
      }}
    >
      {(firmScope ? FIRM_PROMPTS : CLIENT_PROMPTS).map((item) => (
        <button
          key={item.prompt}
          type="button"
          disabled={disabled}
          onClick={() => onRun(item.prompt)}
          title={intl.formatMessage({ id: item.promptId })}
          style={{
            flex: '0 0 auto',
            minHeight: 30,
            padding: '5px 9px',
            border: `1px solid ${D.ruleSoft}`,
            borderRadius: 8,
            background: D.card,
            color: disabled ? D.inkMute : D.inkSoft,
            fontFamily: D.ui,
            fontSize: 11.5,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            cursor: disabled ? 'default' : 'pointer',
            transition: `color 140ms ${D.ease}, border-color 140ms ${D.ease}`
          }}
          onMouseEnter={(event) => {
            if (!disabled) event.currentTarget.style.color = D.ink;
          }}
          onMouseLeave={(event) => {
            if (!disabled) event.currentTarget.style.color = D.inkSoft;
          }}
        >
          <FormattedMessage id={item.labelId} />
        </button>
      ))}
    </div>
  </div>;
};

const WorkingState = ({ firmScope, loading = false }) => {
  const intl = useIntl();
  const phrases = loading
    ? LOADING_PHRASES
    : firmScope
      ? FIRM_WORKING_PHRASES
      : CLIENT_WORKING_PHRASES;
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    if (phrases.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setPhraseIndex((index) => (index + 1) % phrases.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, [firmScope, loading, phrases.length]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '4px 0 16px',
        color: D.inkMute,
        fontSize: 12.5
      }}
    >
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        <FormattedMessage id="feed.working.aria" />
      </span>
      <span
        aria-hidden="true"
        className="donna-working-dot"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: D.accentWarmFlat,
          animation: 'dotPulse 1.2s ease-in-out infinite'
        }}
      />
      <span aria-hidden="true" key={phrases[phraseIndex]} className="donna-working-verb" style={{ animation: `donnaVerbIn 180ms ${D.ease}` }}>
        {intl.formatMessage({ id: phrases[phraseIndex] })}
      </span>
    </div>
  );
};

const actionSummary = (action = {}) => {
  const ids = Array.isArray(action.transaction_ids) ? action.transaction_ids : [];
  const parts = [];
  if (action.account_name) parts.push({ value: action.account_name });
  if (action.tax_treatment) parts.push({ value: action.tax_treatment, identifier: true });
  if (action.merchant_pattern) parts.push({ id: 'feed.action.pattern', values: { pattern: action.merchant_pattern } });
  if (action.evidence_owed === true) parts.push({ id: 'feed.action.evidenceToFollow' });
  if (action.evidence_owed === false) parts.push({ id: 'feed.action.bankLineSufficient' });
  if (action.question) parts.push({ value: String(action.question).slice(0, 80), quoted: true });
  if (action.note) parts.push({ value: String(action.note).slice(0, 80), quoted: true });
  if (action.fact_text) parts.push({ value: String(action.fact_text).slice(0, 100), quoted: true });
  if (action.type === 'retry_parse') parts.push({ id: 'feed.action.retryParse' });
  const scope = action.type === 'remember_merchant'
    ? { id: 'feed.action.futureLines' }
    : action.type === 'remember_fact'
      ? { id: 'feed.action.firmMemory' }
      : action.type === 'open_document'
        ? { id: 'feed.action.document' }
        : action.type === 'open_financials'
          ? (action.period ? { value: action.period, identifier: true } : { id: 'feed.action.latestMonth' })
          : { id: 'operator.action.detail.sourceRows', count: ids.length };
  return { scope, parts };
};

const resultSummary = (result = {}, intl) => {
  if (!result || typeof result !== 'object') return null;
  if (result.skipped_reason) return intl.formatMessage({ id: 'feed.action.skipped' }, { reason: result.skipped_reason });
  const bits = [];
  const postingErrors = (Array.isArray(result.results) ? result.results : [])
    .filter((row) => row?.posting?.status === 'error').length;
  if (Number.isFinite(result.applied)) {
    // "applied N" implies the lines are fully posted. When the ledger post
    // failed for some, the review coding WAS saved but the post was NOT — say
    // that plainly instead of implying a clean post.
    bits.push(intl.formatMessage(
      { id: postingErrors > 0 ? 'feed.action.reviewUpdated' : 'feed.action.appliedCount' },
      { count: result.applied }
    ));
  }
  if (Number.isFinite(result.failed) && result.failed > 0) {
    bits.push(intl.formatMessage({ id: 'feed.action.failedCount' }, { count: result.failed }));
  }
  if (postingErrors > 0) {
    bits.push(intl.formatMessage({ id: 'feed.action.postingFailedCount' }, { count: postingErrors }));
  }
  if (result.rule_id) bits.push(intl.formatMessage({ id: 'feed.action.ruleSaved' }));
  if (result.fact_id) {
    bits.push(intl.formatMessage({ id: result.already_present ? 'feed.action.factUpdated' : 'feed.action.factSaved' }));
  }
  return bits.join(' · ') || null;
};

// ProposalCard v2 tone map — feeds the feed card's palette + typography to the
// shared operator proposal/receipt strips
// (src/components/shared/operator-proposal-card-strips.jsx) so the mass-command
// card matches the per-transaction card's grammar without duplicating its
// markup. The feed runs denser than the artifact, so its meta/warning lines
// carry no explicit line-height (undefined → omitted by React).
const FEED_PROPOSAL_TONE = {
  mono: T.mono,
  bodyFont: T.sans,
  border: T.ruleSoft,
  chip: { reversibility: T.muted, guarded: T.alert, clientVisible: T.accent },
  metaLine: { color: T.muted, size: 11.5, lineHeight: undefined },
  diff: { color: T.ink, noteColor: T.mutedSoft },
  warning: { color: T.alert, lineHeight: undefined },
  receipt: {
    summaryColor: T.ink,
    summarySize: 11.5,
    writerColor: T.mutedSoft,
    rowColor: T.ink,
    noteColor: T.muted,
    status: { applied: T.ok, partial: T.amber, skipped: T.muted, failed: T.alert }
  }
};

const FinancialSummary = ({ summary }) => {
  const intl = useIntl();
  const { formatAmount } = useInterfaceLocale();
  if (!summary) return null;
  if (summary.available === false) {
    return <div style={{ fontSize: 12, color: T.muted }}>
      {summary.reason ? <BidiText>{summary.reason}</BidiText> : <FormattedMessage id="feed.financials.empty" />}
    </div>;
  }
  const currency = summary.currency?.mixed ? '' : summary.currency?.presentation || '';
  const financialMoney = (value) => formatAmount(Number(value) || 0, { currency });
  const pnl = summary.profit_and_loss || {};
  return (
    <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '5px 12px' }}>
        {[
          ['feed.financials.revenue', pnl.revenue],
          ['feed.financials.expenses', pnl.expenses],
          ['feed.financials.netIncome', pnl.net_income],
          ['feed.financials.cash', summary.cash?.total]
        ].map(([labelId, value]) => (
          <div key={labelId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
            <span style={{ color: T.muted, fontSize: 11.5 }}>{intl.formatMessage({ id: labelId })}</span>
            <span style={{ color: T.ink, fontFamily: T.mono, fontSize: 11.5, whiteSpace: 'nowrap' }}>
              <FormattedValue>{financialMoney(value)}</FormattedValue>
            </span>
          </div>
        ))}
      </div>
      {(summary.top_drivers || []).length > 0 && (
        <div style={{ fontSize: 11.5, color: T.inkSoft }}>
          <FormattedMessage id="feed.financials.largestDrivers" />{' '}
          {(summary.top_drivers || []).map((driver, index) => (
            <span key={`${driver.account_label}:${index}`}>
              {index > 0 && <span aria-hidden="true"> · </span>}
              <BidiText>{driver.account_label}</BidiText>{' '}
              <FormattedValue>{financialMoney(driver.amount)}</FormattedValue>
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: summary.draft?.is_draft ? T.amber : T.ok }}>
        <FormattedMessage id={summary.draft?.is_draft ? 'feed.financials.draft' : 'feed.financials.final'} />
      </div>
      {(summary.draft?.reasons || []).length > 0 && (
        <ul style={{ margin: 0, paddingInlineStart: 18, color: T.muted, fontSize: 11.5 }}>
          {summary.draft.reasons.map((reason) => <li key={reason.code}><BidiText>{reason.detail}</BidiText></li>)}
        </ul>
      )}
    </div>
  );
};

function ActionCard({ action, index, messageId, clientId, appliable, applyState, onApply, onOpenDocument, onOpenFinancials }) {
  const intl = useIntl();
  const { scope, parts } = actionSummary(action);
  const meta = buildProposalCardMetadata(action);
  const receipt = buildProposalApplyReceiptMetadata(action);
  const key = `${messageId}:${index}`;
  const state = applyState[key] || null;
  const applied = action.status === 'applied';
  const canApply = appliable && !applied && action.status === 'proposed'
    && (action.type === 'remember_merchant' || action.type === 'remember_fact' || (action.transaction_ids || []).length > 0);
  // open_document (two-surface IA P4) — read-only retrieval: the affordance
  // is an Open button to the document's artifact, never an Apply. The
  // document_id has already passed the server's document_index rail; a
  // demoted action arrives as future_action and never reaches this branch.
  const documentTarget = documentTargetForAction(action, clientId);
  const canOpenDocument = !!documentTarget && typeof onOpenDocument === 'function';
  // open_financials (two-surface IA stage C) — the same read-only Open shape:
  // the artifact renders TB/P&L/cash for the (already period-sanitized) month.
  const financialTarget = financialReportTargetForAction(action, clientId);
  const canOpenFinancials = !!financialTarget
    && action.financial_summary?.available !== false
    && typeof onOpenFinancials === 'function';
  const summary = applied ? resultSummary(action.result, intl) : null;
  const titleId = isSuspenseCoding(action)
    ? 'operator.action.type.suspense'
    : OPERATOR_ACTION_TYPE_MESSAGE_IDS[action.type];
  const scopeNode = scope.id === 'operator.action.detail.sourceRows'
    ? <><FormattedMessage id={scope.id} /> <FormattedValue>{intl.formatNumber(scope.count)}</FormattedValue></>
    : scope.id
      ? <FormattedMessage id={scope.id} />
      : scope.identifier
        ? <IdentifierText>{scope.value}</IdentifierText>
        : <BidiText>{scope.value}</BidiText>;
  return (
    <div
      style={{
        border: `1px solid ${applied ? T.okSoft : T.rule}`,
        background: applied ? T.okSoft : T.card,
        borderRadius: 8,
        padding: '10px 12px',
        marginTop: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: applied ? T.ok : T.accent
          }}
        >
          {titleId ? <FormattedMessage id={titleId} /> : <IdentifierText>{action.type}</IdentifierText>}
        </span>
        {/* S4 lane attribution: the hired teammate whose lane this action is,
            rendered from the persisted, sanitized tag — never inferred here. */}
        {action.role_id && rolePersonaLabel(action.role_id) && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.accent,
              background: T.accentSoft,
              borderRadius: 4,
              padding: '1px 6px'
            }}
          >
            <BidiText>{rolePersonaLabel(action.role_id)}</BidiText>
          </span>
        )}
        {/* Firm-scope proposals name the book they write to. */}
        {action.client_name && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.ink,
              background: T.okSoft,
              borderRadius: 4,
              padding: '1px 6px'
            }}
          >
            <BidiText>{action.client_name}</BidiText>
          </span>
        )}
        <span style={{ fontSize: 12, color: T.inkSoft }}>{scopeNode}</span>
        {action.dropped_transaction_ids > 0 && (
          <span style={{ fontSize: 11, color: T.alert }}>
            <FormattedValue>{intl.formatNumber(action.dropped_transaction_ids)}</FormattedValue>{' '}
            <FormattedMessage id="feed.action.unknownIdDropped" />
          </span>
        )}
        <span style={{ flex: 1 }} />
        {canOpenFinancials ? (
          <button
            type="button"
            onClick={() => onOpenFinancials(financialTarget)}
            style={{
              border: `1px solid ${T.accent}`,
              background: 'transparent',
              color: T.accent,
              borderRadius: 6,
              padding: '4px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <FormattedMessage id="feed.action.open" />
          </button>
        ) : canOpenDocument ? (
          <button
            type="button"
            onClick={() => onOpenDocument(documentTarget)}
            style={{
              border: `1px solid ${T.accent}`,
              background: 'transparent',
              color: T.accent,
              borderRadius: 6,
              padding: '4px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <FormattedMessage id="feed.action.open" />
          </button>
        ) : applied ? (
          <span style={{ fontSize: 11.5, color: T.ok, fontFamily: T.mono }}>
            <FormattedMessage id="operator.receipt.applied" />
            {summary ? <><span aria-hidden="true"> · </span><BidiText>{summary}</BidiText></> : null}
          </span>
        ) : canApply ? (
          <button
            type="button"
            onClick={() => onApply({ messageId, actionIndex: index })}
            disabled={state === 'applying'}
            style={{
              border: `1px solid ${T.accent}`,
              background: state === 'applying' ? T.accentSoft : T.accent,
              color: state === 'applying' ? T.accent : '#fff',
              borderRadius: 6,
              padding: '4px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: state === 'applying' ? 'default' : 'pointer'
            }}
          >
            {state === 'applying'
              ? <FormattedMessage id="document.action.button.applying" />
              : action.client_name
                ? <FormattedMessage id="feed.action.applyToClient" values={{ clientName: <BidiText>{action.client_name}</BidiText> }} />
                : <><FormattedMessage id="document.action.button.apply" />{(action.type === 'remember_merchant' || action.type === 'remember_fact') ? null : <> · {scopeNode}</>}</>}
          </button>
        ) : (
          <span style={{ fontSize: 11.5, color: T.mutedSoft }}>
            {action.status && action.status !== 'proposed'
              ? feedActionStatusLabel(action.status, intl.formatMessage)
              : <FormattedMessage id="feed.action.notAppliable" />}
          </span>
        )}
      </div>
      {action.type === 'open_financials' && <FinancialSummary summary={action.financial_summary} />}
      {parts.length > 0 && (
        <div style={{ fontSize: 12.5, color: T.ink }}>
          {parts.map((part, partIndex) => (
            <span key={`${part.id || 'value'}:${partIndex}`}>
              {partIndex > 0 && <span aria-hidden="true"> · </span>}
              {part.quoted && <span aria-hidden="true">“</span>}
              {part.id
                ? <FormattedMessage id={part.id} values={part.values ? { pattern: <BidiText>{part.values.pattern}</BidiText> } : undefined} />
                : part.identifier
                  ? <IdentifierText>{part.value}</IdentifierText>
                  : <BidiText>{part.value}</BidiText>}
              {part.quoted && <span aria-hidden="true">”</span>}
            </span>
          ))}
        </div>
      )}
      {action.reason && <div style={{ fontSize: 12, color: T.muted }}><BidiText>{action.reason}</BidiText></div>}
      {receipt
        ? <ApplyReceiptStrip action={action} receipt={receipt} tone={FEED_PROPOSAL_TONE} />
        : <ProposalMetaStrip action={action} meta={meta} tone={FEED_PROPOSAL_TONE} />}
      {state && state.startsWith('error:') && (
        <div style={{ fontSize: 12, color: T.alert }}><BidiText>{state.slice(6)}</BidiText></div>
      )}
    </div>
  );
}

// onApplyLifecycle (Slice 2, realtime-truthful-feedback arc): lets the
// financials panel give the affected ROWS an in-flight treatment while an
// apply is flying and fold the per-row outcome into its receipt map when the
// response lands. { phase: 'start'|'settle', transactionIds, results }.
// The rows get NO success treatment at start — the outcome renders only from
// the settle receipt (receipts, never intentions).
// firmScope: the Inbox cross-venture lane — same thread/proposal UI over the
// firm endpoints; every action arrives carrying client_id + client_name and
// the apply needs no client of its own (the server reads the persisted
// action's venture).
// roleId (S3 role threads): keys the whole surface onto that role's thread
// sentinel server-side — same store, same grammar, same apply spine. Ignored
// under firmScope (the Inbox lane has no role address).
export default function FeedChat({
  clientId,
  roleId = null,
  firmScope = false,
  onSnapshotApplied,
  onApplyLifecycle,
  // open_document (two-surface IA P4): the host's artifact opener for a
  // retrieval action's Open button. ({clientId, documentId}) => void; null = no opener
  // on this host, the card renders without the button.
  onOpenDocument = null,
  // open_financials (§13): ({clientId, clientName, period}) => void — keeps
  // the venture target across the firm-Inbox boundary.
  onOpenFinancials = null,
  previewMessages = null,
  previewAppliableActionTypes = EMPTY_LIST,
  previewApplyState = EMPTY_STATE
}) {
  const intl = useIntl();
  const { formatTimestamp } = useInterfaceLocale();
  const previewMode = Array.isArray(previewMessages);
  const [messages, setMessages] = useState(() => (previewMode ? previewMessages : []));
  const [appliableTypes, setAppliableTypes] = useState(() => (previewMode ? previewAppliableActionTypes : []));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(previewMode);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  // Monotonic id for optimistic user bubbles; replaced by the server's
  // persisted user_message on resolve (see send()).
  const optimisticIdRef = useRef(0);

  useEffect(() => {
    if (previewMode) {
      setMessages(previewMessages);
      setAppliableTypes(previewAppliableActionTypes);
      setLoaded(true);
      setError(null);
      return undefined;
    }
    setMessages([]);
    setLoaded(false);
    setError(null);
    if (!firmScope && !clientId) return undefined;
    const controller = new AbortController();
    const load = firmScope
      ? fetchFirmInboxChat({ signal: controller.signal })
      : fetchFirmFeedChat({ clientId, roleId, signal: controller.signal });
    load
      .then((data) => {
        setMessages(Array.isArray(data?.messages) ? data.messages : []);
        setAppliableTypes(Array.isArray(data?.appliable_action_types) ? data.appliable_action_types : []);
        setLoaded(true);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setLoaded(true);
        setError(err?.message || intl.formatMessage({ id: 'feed.error.load' }));
      });
    return () => controller.abort();
  }, [clientId, roleId, firmScope, intl, previewMode, previewMessages, previewAppliableActionTypes]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const [applyState, setApplyState] = useState(() => ({ ...previewApplyState }));

  const send = async (messageOverride = '', { venturesOffset } = {}) => {
    const hasOverride = typeof messageOverride === 'string' && Boolean(messageOverride);
    const message = (hasOverride ? messageOverride : input).trim();
    if (!message || sending || (!firmScope && !clientId)) return;
    // Optimistic: clear the box and drop the prompt into the thread the
    // instant Send is accepted, so it never feels stuck while Donna
    // resolves the row set. The temp bubble is swapped for the server's
    // persisted user_message on resolve; if the server never returns one
    // (e.g. a failure with no persisted row), the optimistic bubble stays
    // so the prompt isn't silently lost back into a cleared box.
    const tempId = `optimistic-${optimisticIdRef.current++}`;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setSending(true);
    setError(null);
    setMessages((prev) => [...prev, { id: tempId, role: 'user', content: message }]);
    if (previewMode) {
      setMessages((prev) => [
        ...prev,
        {
          id: `preview-assistant-${optimisticIdRef.current}`,
          role: 'assistant',
          content: intl.formatMessage({ id: 'feed.working.client.preparing' }),
          payload: { actions: [] }
        }
      ]);
      setSending(false);
      return;
    }
    try {
      const data = firmScope
        ? await postFirmInboxChatMessage({ message, venturesOffset })
        : await postFirmFeedChatMessage({ clientId, roleId, message });
      setMessages((prev) => {
        const base = data?.user_message ? prev.filter((m) => m.id !== tempId) : prev;
        return [
          ...base,
          ...(data?.user_message ? [data.user_message] : []),
          ...(data?.assistant_message ? [data.assistant_message] : [])
        ];
      });
      if (Array.isArray(data?.appliable_action_types)) {
        setAppliableTypes(data.appliable_action_types);
      }
    } catch (err) {
      // A 502 still persisted the user message + a system failure row;
      // render what the server returned when it did. When it didn't
      // persist a user_message, keep the optimistic bubble so the prompt
      // stays visible rather than vanishing into the cleared box.
      const body = err?.body || {};
      setMessages((prev) => {
        const base = body.user_message ? prev.filter((m) => m.id !== tempId) : prev;
        return [
          ...base,
          ...(body.user_message ? [body.user_message] : []),
          ...(body.system_message ? [body.system_message] : [])
        ];
      });
      if (!body.system_message) setError(err?.message || intl.formatMessage({ id: 'feed.error.send' }));
    } finally {
      setSending(false);
    }
  };

  const apply = async ({ messageId, actionIndex }) => {
    const key = `${messageId}:${actionIndex}`;
    // Target rows of this action — the lifecycle callback shimmers exactly
    // these while the apply flies.
    const message = messages.find((m) => m.id === messageId);
    const action = Array.isArray(message?.payload?.actions) ? message.payload.actions[actionIndex] : null;
    const transactionIds = Array.isArray(action?.transaction_ids) ? action.transaction_ids : [];
    setApplyState((prev) => ({ ...prev, [key]: 'applying' }));
    onApplyLifecycle?.({ phase: 'start', transactionIds });
    if (previewMode) {
      const result = {
        applied: transactionIds.length || 1,
        failed: 0,
        results: transactionIds.map((transactionId) => ({ transaction_id: transactionId, status: 'applied' }))
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
      setApplyState((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const data = firmScope
        ? await applyFirmInboxChatAction({ messageId, actionIndex })
        : await applyFirmFeedChatAction({ clientId, roleId, messageId, actionIndex });
      // Settle with the per-row outcome regardless of the overall verdict —
      // an all-rows-failed apply carries its per-row errors here, and
      // silence on failure is the same lie as optimism on success.
      onApplyLifecycle?.({
        phase: 'settle',
        transactionIds,
        results: Array.isArray(data?.result?.results) ? data.result.results : []
      });
      if (data?.assistant_message) {
        setMessages((prev) => prev.map((m) => (m.id === data.assistant_message.id ? data.assistant_message : m)));
      } else if (data?.applied === false && data?.result) {
        const summary = resultSummary(data.result, intl) || intl.formatMessage({ id: 'feed.error.nothingApplied' });
        const stayedProposed = intl.formatMessage({ id: 'feed.error.actionStayedProposed' }, { reason: summary });
        setApplyState((prev) => ({ ...prev, [key]: `error:${stayedProposed}` }));
        return;
      }
      setApplyState((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (data?.snapshot && typeof onSnapshotApplied === 'function') {
        onSnapshotApplied(data.snapshot);
      }
    } catch (err) {
      onApplyLifecycle?.({ phase: 'settle', transactionIds, results: [] });
      setApplyState((prev) => ({ ...prev, [key]: `error:${err?.message || intl.formatMessage({ id: 'feed.error.apply' })}` }));
    }
  };

  // Continuation batch (G0.2): re-run the user prompt that produced this
  // partially-covered reply, windowed to the NEXT venture batch. The prompt
  // is the nearest preceding user message in the thread — a deterministic
  // re-run, not a model-memory "continue".
  const continueCoverage = (assistantMessageId, w) => {
    const idx = messages.findIndex((m) => m.id === assistantMessageId);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate?.role === 'user' && typeof candidate.content === 'string' && candidate.content.trim()) {
        const offset = (Number.isInteger(w?.offset) && w.offset > 0 ? w.offset : 0)
          + (Number.isInteger(w?.shown) ? w.shown : 0);
        return send(candidate.content, { venturesOffset: offset });
      }
    }
    return undefined;
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };

  const handleTextareaInput = (event) => {
    setInput(event.target.value);
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 200)}px`;
  };

  if (!firmScope && !clientId) return null;

  const visibleMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system');

  return (
    // Dock-native: fills the slot FirmDock gives it — thread on top, composer
    // pinned at the bottom. Rendering is the SHARED Donna chat grammar
    // (shared/donna-chat.jsx) — the same vocabulary as the document
    // artifact's chat, not a second style.
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0,
        fontFamily: D.ui,
        fontSize: 13,
        lineHeight: 1.45,
        minWidth: 0
      }}
    >
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '18px 16px 6px'
        }}
      >
        {!loaded && <WorkingState firmScope={firmScope} loading />}
        {visibleMessages.map((message) => {
          const timestamp = formatChatTimestamp(message.created_at, (value) => formatTimestamp(value, {
            day: null,
            month: null,
            year: null,
            second: null,
            timeZoneName: null
          }));
          if (message.role === 'user') {
            return (
              <UserMessage key={message.id} timestamp={timestamp}>
                {message.content}
              </UserMessage>
            );
          }
          if (message.role === 'system') {
            return (
              <SystemMessage key={message.id} timestamp={timestamp}>
                {message.content}
              </SystemMessage>
            );
          }
          const actions = Array.isArray(message?.payload?.actions) ? message.payload.actions : [];
          return (
            <BotMessage key={message.id} timestamp={timestamp}>
              <AssistantBody text={message.content}>
                <StructuredResponse text={message.content} />
              </AssistantBody>
              {actions.map((action, index) => (
                <ActionCard
                  key={`${message.id}:${index}`}
                  action={action}
                  index={index}
                  messageId={message.id}
                  clientId={clientId}
                  appliable={appliableTypes.includes(action.type)}
                  applyState={applyState}
                  onApply={apply}
                  onOpenDocument={onOpenDocument}
                  onOpenFinancials={onOpenFinancials}
                />
              ))}
              {firmScope && message?.payload?.coverage === 'partial' && (
                <CoverageBanner
                  window={message.payload.ventures_window}
                  disabled={sending}
                  onContinue={() => continueCoverage(message.id, message.payload.ventures_window)}
                />
              )}
            </BotMessage>
          );
        })}
        {sending && (
          <WorkingState firmScope={firmScope} />
        )}
      </div>

      {loaded && (
        <StarterActions firmScope={firmScope} disabled={sending} onRun={send} />
      )}

      <Composer
        draft={input}
        textareaRef={textareaRef}
        onInput={handleTextareaInput}
        onKeyDown={handleKeyDown}
        onSend={() => send()}
        submitting={sending}
        sendError={error}
        placeholder={roleId && rolePersonaLabel(roleId)
          ? intl.formatMessage({ id: 'feed.composer.askActor' }, { actorName: rolePersonaLabel(roleId) })
          : intl.formatMessage({ id: 'feed.composer.askDonna' })}
      />
    </div>
  );
}
