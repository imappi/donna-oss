import { useCallback, useEffect, useMemo, useState } from 'react';

import { draftFirmAskBatch, fetchFirmAskBatches, formatFirmError, sendFirmAskBatch } from '../../lib/firmApi.js';
import { askBatchCountsLabel, askBatchCoveredSpanLabel, askBatchStaleness, parseAskMessageMarkdown } from '../../lib/askBatchView.js';
import { T, D } from '../shared/design-tokens.js';
import { btnPrimary, btnChip, btnDisabled } from '../shared/buttons.js';
import { UnqualifiedModelMarker } from '../shared/UnqualifiedModelMarker.jsx';

// The drafted client message as an ARTIFACT (Kari, 2026-09-01: the list view
// carries only a row + pill; the details — full message, audit trail, Send —
// open on the right like every other row's artifact). The list-side banner
// ("Verdicts have moved…") is gone: the overview auto-refreshes a stale
// draft itself, and this artifact keeps the honest fallback note + manual
// Refresh for hosts where no panel is mounted (the home-feed Inbox) or when
// the auto-refresh failed.
//
// Ask-lane contracts, unchanged from the panel this view was folded out of:
// - ONE live draft per client; drafting again supersedes the old draft.
// - Drafting can 503 (ASK_PIPELINE_LLM_UNAVAILABLE) — no fallback writer by
//   design; say retry, never render a hand-templated message.
// - Staleness off verdicts_as_of: warn to re-draft, don't block sending.
// - The draft resting on a send-click is a two-terminal-states violation by
//   doctrine; it stays rendered as the user's move until autonomous send
//   lands (the ask-volume/bundling call is open).

const buttonStyle = (kind = 'primary', busy = false) => ({
  ...(kind === 'primary' ? (busy ? btnDisabled : btnPrimary) : btnChip),
  ...(busy ? { cursor: 'wait' } : {})
});

// Disposition chips keep the machine voice (enum words are bug-report
// material — the two-voice doctrine); they live inside the audit disclosure.
const chipStyle = () => ({
  display: 'inline-block',
  padding: '2px 7px',
  borderRadius: 3,
  fontFamily: D.mono,
  fontSize: 10.5,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  background: 'oklch(0.08 0 0 / 0.04)',
  color: D.ink
});

const stampLabel = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const MessageBody = ({ markdown }) => (
  <div style={{ color: D.inkSoft, fontSize: 13.5, lineHeight: 1.55 }}>
    {parseAskMessageMarkdown(markdown).map((block, index) => {
      const spans = block.spans.map((span, spanIndex) =>
        span.code ? (
          <span key={spanIndex} style={{ fontFamily: D.mono, fontSize: 12, background: D.ruleSoft, padding: '0 4px', borderRadius: 4 }}>
            {span.text}
          </span>
        ) : span.bold ? (
          <strong key={spanIndex} style={{ color: D.ink }}>{span.text}</strong>
        ) : (
          <span key={spanIndex}>{span.text}</span>
        )
      );
      if (block.type === 'heading') {
        return (
          <div key={index} style={{ fontSize: 12.5, fontWeight: 600, color: D.inkMute, margin: '18px 0 8px' }}>
            {spans}
          </div>
        );
      }
      if (block.type === 'numbered') {
        return (
          <div key={index} style={{ display: 'flex', gap: 8, margin: '6px 0 6px 4px' }}>
            <span style={{ fontSize: 12.5, color: D.inkMute, minWidth: 16, ...D.tabular }}>{block.marker}.</span>
            <span style={{ minWidth: 0 }}>{spans}</span>
          </div>
        );
      }
      if (block.type === 'bullet') {
        return (
          <div key={index} style={{ display: 'flex', gap: 8, margin: `4px 0 4px ${block.nested ? 26 : 4}px` }}>
            <span style={{ color: D.inkMute }}>•</span>
            <span style={{ minWidth: 0 }}>{spans}</span>
          </div>
        );
      }
      return (
        <p key={index} style={{ margin: '6px 0' }}>{spans}</p>
      );
    })}
  </div>
);

const noticeColors = {
  ok: { background: 'oklch(0.08 0 0 / 0.04)', color: T.ok },
  alert: { background: 'oklch(0.08 0 0 / 0.04)', color: D.alert },
  muted: { background: 'oklch(0.08 0 0 / 0.04)', color: D.inkMute }
};

const AskBatchArtifact = ({ artifact, onRefreshRef = null }) => {
  const { clientId, batch: initialBatch = null, transactions = [], onBatchesChanged = null } = artifact?.data || {};
  const [batches, setBatches] = useState(() => (initialBatch ? [initialBatch] : null));
  const [working, setWorking] = useState('');
  const [notice, setNotice] = useState(null);
  const [auditOpen, setAuditOpen] = useState(false);

  // Fresh truth on open and after every action — the artifact never trusts a
  // stale snapshot it was handed, and it pushes what it learns back into the
  // list's cache so the row and this view cannot drift.
  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const payload = await fetchFirmAskBatches({ clientId });
      const nextBatches = Array.isArray(payload?.batches) ? payload.batches : [];
      setBatches(nextBatches);
      onBatchesChanged?.(clientId, nextBatches);
    } catch (error) {
      setNotice({ tone: 'alert', text: formatFirmError(error, 'Could not load the client message.') });
    }
  }, [clientId, onBatchesChanged]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!onRefreshRef) return undefined;
    onRefreshRef.current = () => load();
    return () => { onRefreshRef.current = null; };
  }, [onRefreshRef, load]);

  const liveDraft = useMemo(
    () => (batches || []).find((batch) => batch.status === 'draft') || null,
    [batches]
  );
  const staleness = askBatchStaleness({ batch: liveDraft, transactions });

  const runSend = async () => {
    if (!liveDraft) return;
    const counts = liveDraft.draft?.counts || {};
    const confirmed = window.confirm(
      `Send to client?\n\n${askBatchCountsLabel(counts)}\n\nQuestions and statement requests become open evidence requests the client replies to.`
    );
    if (!confirmed) return;
    setWorking('send');
    setNotice(null);
    try {
      const result = await sendFirmAskBatch({ batchId: liveDraft.id, clientId });
      const requestCount = result?.batch?.sent?.evidence_request_ids?.length || 0;
      // The consequence, stated after the action: what changed and where it
      // now lives.
      setNotice({ tone: 'ok', text: `Sent — ${requestCount} evidence request${requestCount === 1 ? '' : 's'} opened for the client. They now sit under Waiting until the client replies.` });
      await load();
    } catch (error) {
      // ASK_BATCH_STALE is not a plain failure: the send writer committed the
      // supersede before refusing, so this draft is gone either way. The route
      // reports whether it managed to request a fresh one (the gate can decline
      // — tier below canary, parse quiescence), so say which of the two actually
      // happened rather than promising a draft that may not be coming. Refresh
      // draft stays on screen as the user's own move in both cases.
      const staleSend = error?.code === 'ASK_BATCH_STALE';
      setNotice({
        tone: 'alert',
        text:
          error?.code === 'ASK_BATCH_NOT_DRAFT'
            ? 'This draft was already sent or superseded — refreshing.'
            : staleSend
              ? `${formatFirmError(error, 'Send failed.')} ${
                error?.body?.redraft_requested
                  ? 'Donna is writing a fresh one — refresh in a moment.'
                  : 'Use Refresh draft to write a fresh one.'
              }`
              : formatFirmError(error, 'Send failed.')
      });
      await load();
    } finally {
      setWorking('');
    }
  };

  const runRefreshDraft = async () => {
    setWorking('draft');
    setNotice(null);
    try {
      const result = await draftFirmAskBatch({ clientId });
      if (!result?.batch) {
        setNotice({ tone: 'muted', text: 'Nothing left to ask — the previous draft’s items have all moved on.' });
      }
      await load();
    } catch (error) {
      setNotice({
        tone: 'alert',
        text:
          error?.code === 'ASK_PIPELINE_LLM_UNAVAILABLE'
            ? 'Drafting model is unavailable right now. There is no fallback writer by design — retry in a minute.'
            : formatFirmError(error, 'Refresh failed.')
      });
    } finally {
      setWorking('');
    }
  };

  return (
    <div style={{ padding: '16px 18px 24px', fontFamily: D.ui, color: D.ink }}>
      {notice && (
        <div style={{ ...noticeColors[notice.tone], borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 500, marginBottom: 12 }}>
          {notice.text}
        </div>
      )}

      {batches === null && (
        <div style={{ color: D.inkMute, fontSize: 13 }}>Loading the client message…</div>
      )}

      {batches !== null && !liveDraft && (
        <div style={{ color: D.inkMute, fontSize: 13, lineHeight: 1.55 }}>
          No open message draft. Sent questions sit with the client as open
          evidence requests; Donna drafts a new message when the books raise
          something only they can answer.
        </div>
      )}

      {liveDraft && (
        <>
          <div style={{ fontSize: 12.5, color: D.inkMute, marginBottom: 4 }}>
            {askBatchCountsLabel(liveDraft.draft?.counts)}
            {(() => {
              const coveredSpan = askBatchCoveredSpanLabel({ batch: liveDraft, transactions });
              return coveredSpan ? <span style={{ color: T.mutedSoft }}> · about {coveredSpan} activity</span> : null;
            })()}
            <span style={{ color: T.mutedSoft }}> · drafted {stampLabel(liveDraft.created_at)}</span>
          </div>

          {staleness.stale && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'oklch(0.08 0 0 / 0.04)', color: T.amber, padding: '10px 14px', fontSize: 13, fontWeight: 500, borderRadius: 8, margin: '8px 0' }}>
              <span style={{ flex: 1 }}>Verdicts have moved since this draft was written. Refresh it so the message matches the books.</span>
              <button
                type="button"
                style={{ ...buttonStyle('ghost'), padding: '5px 10px' }}
                disabled={Boolean(working)}
                onClick={runRefreshDraft}
              >
                {working === 'draft' ? 'Refreshing…' : 'Refresh draft'}
              </button>
            </div>
          )}

          <div style={{ paddingTop: 8 }}>
            <MessageBody markdown={liveDraft.message_markdown || ''} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${D.ruleSoft}`, marginTop: 16, paddingTop: 12 }}>
            <button
              type="button"
              style={{ ...buttonStyle('primary', working === 'send') }}
              disabled={Boolean(working)}
              onClick={runSend}
            >
              {working === 'send' ? 'Sending…' : 'Send to client'}
            </button>
            {!staleness.stale && (
              <button
                type="button"
                style={{ ...buttonStyle('ghost'), padding: '6px 12px' }}
                disabled={Boolean(working)}
                onClick={runRefreshDraft}
              >
                {working === 'draft' ? 'Refreshing…' : 'Refresh draft'}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => setAuditOpen((v) => !v)}
              style={{ ...buttonStyle('ghost'), padding: '4px 10px', fontSize: 11.5 }}
            >
              {auditOpen ? 'Hide audit details' : 'Audit details'}
            </button>
          </div>

          {auditOpen && (
            <div style={{ marginTop: 10 }}>
              <div style={{ color: D.inkMute, fontFamily: D.mono, fontSize: 11 }}>
                drafted {stampLabel(liveDraft.created_at)} · model {liveDraft.model || '—'}<UnqualifiedModelMarker decision={liveDraft} /> · verdicts as of {stampLabel(liveDraft.verdicts_as_of)}
              </div>
              {Array.isArray(liveDraft.draft?.items) && liveDraft.draft.items.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {liveDraft.draft.items.map((item) => (
                    <div key={item.transaction_id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', fontSize: 12.5, color: D.inkSoft }}>
                      <span style={chipStyle(item.disposition)}>{item.disposition}</span>
                      <span style={{ minWidth: 0 }}>
                        {item.question || item.fyi_note || item.skip_reason || '—'}
                        <span style={{ color: T.mutedSoft, fontFamily: D.mono, fontSize: 10 }}> · {String(item.transaction_id).slice(-8)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AskBatchArtifact;
