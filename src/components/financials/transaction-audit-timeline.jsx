// Live audit card for one bank line. It renders the same persisted
// case-snapshot timeline as the former Audit tab, but keeps that evidence in
// the transaction's natural reading order: summary → activity → conversation.
// In-flight UI work is shown as a temporary shimmering row; completed rows
// still come only from persisted receipts. No fresh model call narrates this
// card, and the existing case-snapshot remains the single read assembler.

import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

import { D } from '../shared/design-tokens.js';
import { fetchFirmCaseSnapshot } from '../../lib/firmApi.js';
import { buildAuditTimelineView } from '../../lib/auditTimelineView.js';
import { buildCaseHealthView } from '../../lib/caseHealthView.js';
import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';
import { formatAccountingTimestamp } from '../../i18n/localeFormatting.js';

const IDLE_POLL_MS = 12_000;
const ACTIVE_POLL_MS = 1_500;

const TERMINAL_LABEL_IDS = {
  settled: 'transaction.audit.status.reconciled',
  owner: 'transaction.audit.status.waitingOnYou',
  violation: 'transaction.audit.status.needsAttention',
  unknown: 'transaction.audit.status.inProgress'
};

const TERMINAL_COLORS = {
  settled: D.inkSoft,
  owner: D.accentWarmFlat,
  violation: D.alert,
  unknown: D.inkSoft
};

export const auditTimestampLabel = (at, formatTimestamp = formatAccountingTimestamp) => {
  if (!at) return null;
  const dt = new Date(at);
  if (Number.isNaN(dt.getTime())) return null;
  return formatTimestamp(dt);
};

const textButton = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: D.inkSoft,
  fontFamily: D.ui,
  fontSize: 11.5,
  cursor: 'pointer'
};

const EventRow = ({ view, debug, formatTimestamp, message }) => (
  <div style={{
    display: 'grid',
    gridTemplateColumns: '14px minmax(0, 1fr)',
    columnGap: 9,
    alignItems: 'start',
    padding: '9px 0',
    borderTop: `1px solid ${D.ruleSoft}`
  }}>
    <span aria-hidden="true" style={{
      width: 14,
      height: 14,
      marginTop: 1,
      borderRadius: 999,
      background: D.ink,
      color: D.card,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 9,
      lineHeight: 1
    }}>
      ✓
    </span>
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.4, color: D.ink }}>
        <BidiText direction="auto">{view.headline}</BidiText>
      </div>
      <div style={{ marginTop: 2, color: D.inkSoft, fontSize: 10.5, lineHeight: 1.4 }}>
        <BidiText direction="auto">{view.actorLabel}</BidiText>
        <span aria-hidden="true"> · </span>
        {view.at ? (
          <FormattedValue>
            <time dateTime={view.at} title={view.at} style={D.tabular}>
              {auditTimestampLabel(view.at, formatTimestamp) || message('transaction.audit.timestampMissing')}
            </time>
          </FormattedValue>
        ) : (
          <span>{message('transaction.audit.timestampMissing')}</span>
        )}
      </div>
      {view.detail && (
        <div style={{ marginTop: 2, fontSize: 11.5, lineHeight: 1.45, color: D.inkSoft }}>
          <BidiText direction="auto">{view.detail}</BidiText>
        </div>
      )}
      {(view.chips.length > 0 || debug) && (
        <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 5, color: D.inkSoft, fontSize: 10.5 }}>
          {view.chips.map((chip) => <BidiText key={chip} direction="auto">{chip}</BidiText>)}
          {debug && <IdentifierText>{view.kind}</IdentifierText>}
        </div>
      )}
      {debug && (
        <pre dir="ltr" style={{
          margin: '7px 0 0',
          padding: '8px 10px',
          borderRadius: 7,
          background: D.paperDeep,
          color: D.inkSoft,
          fontFamily: D.mono,
          fontSize: 10,
          lineHeight: 1.45,
          overflowX: 'auto'
        }}>
          {JSON.stringify({
            actor: { type: view.actor, id: view.actorId, name: view.actorName },
            receipt_ref: view.receiptRef,
            fields: view.fields
          }, null, 2)}
        </pre>
      )}
    </div>
  </div>
);

const RunningRow = ({ activity, message }) => (
  <div
    aria-live="polite"
    style={{
      display: 'grid',
      gridTemplateColumns: '14px minmax(0, 1fr)',
      columnGap: 9,
      alignItems: 'start',
      padding: '10px 0 3px',
      borderTop: `1px solid ${D.ruleSoft}`
    }}
  >
    <span aria-hidden="true" style={{
      width: 8,
      height: 8,
      marginBlockStart: 5,
      marginInlineStart: 3,
      borderRadius: 999,
      background: D.accentWarmFlat,
      boxShadow: `0 0 0 3px ${D.accentWash}`
    }} />
    <div className="transaction-audit-shimmer" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
      <strong style={{ fontWeight: 600 }}><BidiText direction="auto">{activity.verb}</BidiText></strong>
      {activity.text ? <><span aria-hidden="true"> · </span><BidiText direction="auto">{activity.text}</BidiText></> : ''}
      <div style={{ marginTop: 2, fontSize: 10.5 }}>{message('transaction.audit.happeningNow')}</div>
    </div>
  </div>
);

const TransactionAuditTimeline = ({
  clientId,
  transactionId,
  activity = null,
  previewSnapshot = null,
  onRetryCoding = null,
  retryingCoding = false,
  retryCodingError = null
}) => {
  const intl = useIntl();
  const { formatTimestamp } = useInterfaceLocale();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  const viewFromSnapshot = (snapshot) => ({
    status: 'ready',
    view: buildAuditTimelineView(snapshot?.timeline, intl.formatMessage),
    health: buildCaseHealthView(snapshot?.case_health, intl.formatMessage)
  });
  const [state, setState] = useState(() => (
    previewSnapshot ? viewFromSnapshot(previewSnapshot) : { status: 'loading' }
  ));
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    if (previewSnapshot) {
      setState(viewFromSnapshot(previewSnapshot));
      return undefined;
    }
    if (!clientId || !transactionId) return undefined;
    let cancelled = false;
    let controller = null;
    let inFlight = false;

    const load = ({ initial = false } = {}) => {
      if (inFlight) return;
      controller = new AbortController();
      const request = controller;
      inFlight = true;
      if (initial) {
        setState((current) => current.status === 'ready' ? current : { status: 'loading' });
      }
      fetchFirmCaseSnapshot({
        clientId,
        focusType: 'transaction',
        focusId: transactionId,
        include: ['timeline', 'case_health'],
        signal: request.signal
      })
        .then((snapshot) => {
          if (cancelled || request.signal.aborted) return;
          setState({
            status: 'ready',
            view: buildAuditTimelineView(snapshot?.timeline, intl.formatMessage),
            health: buildCaseHealthView(snapshot?.case_health, intl.formatMessage)
          });
        })
        .catch((error) => {
          if (cancelled || request.signal.aborted) return;
          if (initial) setState({
            status: 'error',
            message: error?.message || message('transaction.audit.error.load')
          });
        })
        .finally(() => {
          if (request === controller) inFlight = false;
        });
    };

    load({ initial: true });
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      load();
    }, activity ? ACTIVE_POLL_MS : IDLE_POLL_MS);

    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(interval);
    };
  }, [clientId, transactionId, activity?.verb, activity?.text, intl.locale, previewSnapshot]);

  useEffect(() => {
    setDebug(false);
  }, [transactionId]);

  const renderBody = () => {
    if (state.status === 'loading') {
      return <RunningRow activity={activity || {
        verb: message('transaction.audit.loading.verb'),
        text: message('transaction.audit.loading.detail')
      }} message={message} />;
    }
    if (state.status === 'error') {
      return <div style={{ paddingTop: 9, borderTop: `1px solid ${D.ruleSoft}`, color: D.alert, fontSize: 12 }}>{state.message}</div>;
    }
    if (!state.view.present) {
      return <div style={{ paddingTop: 9, borderTop: `1px solid ${D.ruleSoft}`, color: D.inkSoft, fontSize: 12 }}>{message('transaction.audit.empty')}</div>;
    }

    const events = state.view.events;
    const health = state.health?.present ? state.health : null;

    return (
      <>
        <div style={{ marginTop: 2, marginBottom: 8, color: D.inkSoft, fontSize: 11.5, lineHeight: 1.4 }}>
          <BidiText direction="auto">{state.view.terminal.headline}</BidiText>
        </div>
        {health?.blocker && health.phase.tone !== 'settled' && (
          <div
            data-testid="transaction-case-health"
            style={{
              marginBottom: 8,
              padding: '8px 10px',
              borderRadius: 8,
              background: D.paperDeep,
              fontSize: 11.5,
              lineHeight: 1.45
            }}
          >
            <div style={{ color: D.ink, fontWeight: 600 }}><BidiText direction="auto">{health.blocker.headline}</BidiText></div>
            {health.blocker.detail && (
              <div style={{ marginTop: 2, color: D.inkSoft }}><BidiText direction="auto">{health.blocker.detail}</BidiText></div>
            )}
            {health.ownerQuestion && health.blocker.kind !== 'awaiting_owner_answer' && (
              <div style={{ marginTop: 2, color: D.inkSoft }}>
                {message('transaction.audit.askedLabel')}: “<BidiText direction="auto">{health.ownerQuestion.question}</BidiText>”
              </div>
            )}
            {health.recovery && (
              <div style={{ marginTop: 3, color: health.recovery.class ? D.inkSoft : D.alert, fontSize: 10.5 }}>
                <BidiText direction="auto">{health.recovery.label}</BidiText>
              </div>
            )}
            {health.blocker.canRetryCoding && onRetryCoding && !previewSnapshot && (
              <div style={{ marginTop: 5 }}>
                <button
                  type="button"
                  onClick={onRetryCoding}
                  disabled={retryingCoding}
                  style={{ ...textButton, color: D.ink, textDecoration: 'underline', opacity: retryingCoding ? 0.6 : 1 }}
                >
                  {message(retryingCoding ? 'common.retrying' : 'artifact.refresh.transaction')}
                </button>
                {retryCodingError && <div role="alert" style={{ color: D.alert, marginTop: 3 }}><BidiText direction="auto">{retryCodingError}</BidiText></div>}
              </div>
            )}
          </div>
        )}
        <div>
          {events.map((eventView, index) => (
            <EventRow
              key={`${eventView.kind}-${eventView.at || 'untimed'}-${index}`}
              view={eventView}
              debug={debug}
              formatTimestamp={formatTimestamp}
              message={message}
            />
          ))}
          {events.length === 0 && !activity && (
            <div style={{ padding: '9px 0 2px', borderTop: `1px solid ${D.ruleSoft}`, color: D.inkSoft, fontSize: 12 }}>
              {message('transaction.audit.noCompletedSteps')}
            </div>
          )}
          {activity && <RunningRow activity={activity} message={message} />}
        </div>
        {(state.view.gaps.length > 0 || (health?.gaps?.length ?? 0) > 0) && (
          <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${D.ruleSoft}`, color: D.alert, fontSize: 10.5, lineHeight: 1.5 }}>
            <div style={{ marginBottom: 2, fontWeight: 600 }}>{message('transaction.audit.gaps')}</div>
            {[...state.view.gaps, ...(health?.gaps || [])].map((gap, index) => (
              <div key={`${gap}-${index}`}><BidiText direction="auto">{gap}</BidiText></div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
          <button
            type="button"
            onClick={() => setDebug((value) => !value)}
            style={textButton}
          >
            {message(debug ? 'transaction.audit.technical.hide' : 'transaction.audit.technical.show')}
          </button>
        </div>
      </>
    );
  };

  const terminalTone = state.status === 'ready' && state.view?.present
    ? state.view.terminal.tone
    : 'unknown';
  const terminalLabel = activity
    ? message('transaction.audit.status.live')
    : message(TERMINAL_LABEL_IDS[terminalTone] || TERMINAL_LABEL_IDS.unknown);

  return (
    <section
      data-testid="transaction-live-audit"
      aria-label={message('transaction.audit.aria')}
      style={{
        border: `1px solid ${D.rule}`,
        borderRadius: 12,
        background: D.card,
        padding: '13px 14px 12px',
        fontFamily: D.ui
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 7 }}>
        <span style={{ color: D.ink, fontSize: 12.5, fontWeight: 600 }}>{message('transaction.audit.title')}</span>
        <span style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          color: activity ? D.accentWarmFlat : TERMINAL_COLORS[terminalTone],
          fontSize: 10.5
        }}>
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }} />
          {terminalLabel}
        </span>
      </div>
      {renderBody()}
      <style>{`
        @keyframes transaction-audit-shimmer {
          0% { background-position: 120% 0; }
          100% { background-position: -120% 0; }
        }
        .transaction-audit-shimmer {
          color: transparent;
          background-image: linear-gradient(90deg, ${D.inkMute} 20%, ${D.ink} 46%, ${D.inkMute} 72%);
          background-size: 240% 100%;
          background-position: 120% 0;
          background-clip: text;
          -webkit-background-clip: text;
          animation: transaction-audit-shimmer 1.65s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .transaction-audit-shimmer { color: ${D.inkSoft}; background: none; animation: none; }
        }
      `}</style>
    </section>
  );
};

export default TransactionAuditTimeline;
