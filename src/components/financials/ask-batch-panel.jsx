import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ledgerAdjustmentAskMessages } from '../../lib/ledgerAdjustmentAskView.js';
import ProviderFailurePanel from './provider-failure-panel.jsx';

import { draftFirmAskBatch, fetchFirmAskBatches, fetchMentionNotifications, formatFirmError, markMentionNotificationsRead } from '../../lib/firmApi.js';
import {
  askBatchStaleness,
  evidenceRequestListItem,
  openClientEvidenceRequests
} from '../../lib/askBatchView.js';
import { T, D } from '../shared/design-tokens.js';
import {
  BANK_FEED_DATE_STYLE,
  BANK_FEED_LIST_MEASURE,
  BANK_FEED_PRIMARY_STYLE,
  BANK_FEED_ROW_STYLE,
  BANK_FEED_SECTION_STYLE,
  BANK_FEED_SECTION_COUNT_STYLE,
  BANK_FEED_SECTION_HEADING_STYLE,
  BANK_FEED_TRAILING_CELL_STYLE,
  bankFeedPillStyle
} from '../shared/bank-feed-list-style.js';
import { btnChip } from '../shared/buttons.js';
import {
  FEED_BUCKET_ORDER,
  FEED_ROW_HOVER_CSS,
  FeedRow,
  isPeriodOwnedDecision,
  presentFeedBuckets,
  shortDate
} from '../shared/feed-list.jsx';

// Actions — an INBOX, not a report (the 2026-08-09 external review, Kari
// accepted). The mental model: every item has exactly ONE owner and one
// state — the firm's actionable decisions occupy the daily list; client-
// owned work names every outstanding request in place; Donna's work and
// completed history never pad the page.
//
// The owner scopes are a PROJECTION of the same five feed buckets the Inbox
// renders (shared/feed-list.jsx OWNER_SCOPE_OF_BUCKET) — the classifier,
// the close-engine dispositions, and two-terminal-states accounting are all
// untouched. Counts reconcile because both the toolbar and this panel use
// that same presentation partition of distinct real blockers.
//
// Firms-first (Probe #1): the person reading this is the FIRM; the
// questions are for the firm's CLIENT.
//
// Ask-lane contracts surfaced here, matching the server:
// - ONE live draft per client; drafting again supersedes the old draft.
// - Drafting can 503 (ASK_PIPELINE_LLM_UNAVAILABLE) — there is NO
//   fallback drafter by design; the surface says retry, never renders
//   a hand-templated message.
// - Staleness off verdicts_as_of: verdict movement after the draft means
//   the message describes books that have moved. As of Kari's 2026-09-01
//   list-view call the list carries NO staleness banner — this panel
//   auto-refreshes a stale draft itself (once per verdict stamp, silent);
//   the artifact keeps the honest note + manual Refresh as the fallback.
// - The draft resting on a send-click is a two-terminal-states violation
//   by doctrine; it stays surfaced in the Inbox as the user's move until
//   autonomous send lands (the ask-volume/bundling call is open).
//
// The drafted client message has NO row in the entity view (Kari,
// 2026-09-01, second call: it was noise — every question in the draft is
// already a per-item Needs-input row in the month stream). Its review
// surface is the Inbox: the server-minted ask_batch_draft feed item
// (firmFeed.js) routes to the ask_batch artifact (ask-batch-artifact.jsx),
// which owns the full message, the audit disclosure, Send, and refresh.
// This panel keeps the silent stale-draft auto-refresh — healing is
// independent of the row that used to render here. Still open (recorded,
// not smuggled): server-side re-draft on verdict movement, so a stale
// draft heals even with no surface mounted — NARROWED by §19 at the one
// place it lost the draft outright rather than leaving it stale (a stale
// MANUAL send commits the supersede, so the route now requests a fresh
// draft through the same ask_draft.requested seam the auto-send path
// uses); what remains is the no-send, no-reconcile case. And batch
// "Confirm all" needs a batch-confirm writer (a mutation, not a render
// change). Out-of-band reply capture belongs in the existing item
// artifact/chat if it returns; Actions never grows another inline form.

// House tokens (Kari, 2026-08-07: this screen carried its own beige/indigo
// palette — a parallel design system; the old ui map now reads the SHARED
// tokens so Actions matches the other list views. Keys kept so the render
// code stays diff-small).
const ui = {
  page: 'transparent',
  card: T.card,
  ink: D.ink,
  inkSoft: D.inkSoft,
  muted: D.inkMute,
  mutedSoft: D.inkMute,
  rule: D.rule,
  ruleSoft: D.ruleSoft,
  accent: D.ink,
  accentSoft: 'oklch(0.08 0 0 / 0.04)',
  amber: T.amber,
  amberSoft: 'oklch(0.08 0 0 / 0.04)',
  alert: D.alert,
  ok: T.ok,
  sans: 'inherit',
  mono: D.mono
};

// Width: 1080 — the Bank Feed's shared centered workspace measure. This
// root's cap is belt-and-suspenders under the console's
// own wrapper. Inner reading measures (draft text, empty states) keep
// their own narrower caps below.

// Section heading inside an owner tab — sentence case, system face (the
// two-voice doctrine; the old mono tracked caps were "operator console").
const SectionHeading = ({ label, count }) => (
  <div
    style={BANK_FEED_SECTION_HEADING_STYLE}
  >
    <span>{label}</span>
    {count != null && (
      <span style={BANK_FEED_SECTION_COUNT_STYLE}>{count}</span>
    )}
  </div>
);

const AskBatchPanel = ({
  clientId,
  transactions = [],
  evidenceRequests = [],
  feed = null,
  onActivateItem = null,
  cachedBatches = null,
  onCacheBatches = null,
  showWaitingRows = true,
  embedded = false
}) => {
  const intl = useIntl();
  const [batchState, setBatchState] = useState(() => ({
    clientId,
    batches: cachedBatches,
    providerFailures: null
  }));
  const batches = batchState.clientId === clientId
    ? batchState.batches
    : cachedBatches;
  const loadRevisionRef = useRef(0);
  const loadControllerRef = useRef(null);
  const loadTimerRef = useRef(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [working, setWorking] = useState('');
  const [activeRowId, setActiveRowId] = useState('');

  const load = useCallback(async () => {
    if (!clientId) return;
    clearTimeout(loadTimerRef.current);
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const revision = ++loadRevisionRef.current;
    setRefreshing(true);
    const timeout = setTimeout(() => {
      if (revision !== loadRevisionRef.current) return;
      // Fence even a body/auth refresh that ignores abort. A late result may
      // settle its promise, but can never replace the current receipt view.
      loadRevisionRef.current += 1;
      loadControllerRef.current = null;
      loadTimerRef.current = null;
      controller.abort();
      setLoadError(true); // The provider panel renders the translated stale notice.
      setRefreshing(false);
    }, 20_000);
    loadTimerRef.current = timeout;
    try {
      const payload = await fetchFirmAskBatches({ clientId, signal: controller.signal });
      if (revision !== loadRevisionRef.current) return;
      if (payload?.client_id && payload.client_id !== clientId) {
        setLoadError(true);
        return;
      }
      const nextBatches = Array.isArray(payload?.batches) ? payload.batches : [];
      onCacheBatches?.(clientId, nextBatches);
      setBatchState({ clientId, batches: nextBatches,
        providerFailures: Array.isArray(payload?.provider_failures) ? payload.provider_failures.filter((row) => row.client_id === clientId) : null });
      setLoadError('');
    } catch (error) {
      if (revision !== loadRevisionRef.current) return;
      // FI-05: a storage/database/provider error's own text never reaches the
      // firm; only the code-mapped copy or the fixed line does.
      setLoadError(formatFirmError({ code: error?.code || error?.status }, 'Could not load client asks.'));
    } finally {
      clearTimeout(timeout);
      if (revision === loadRevisionRef.current) {
        loadControllerRef.current = null;
        loadTimerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [clientId, onCacheBatches]);

  // Universal @mentions (slice 4, D10): the caller's Mentions lane — their
  // open colleague asks (live from the store of record) + unread
  // mention/assign notifications, filtered to THIS entity. Best-effort: an
  // unavailable lane hides itself rather than degrading the Actions tab.
  const [mentionLane, setMentionLane] = useState(null);
  const loadMentionLane = useCallback(async () => {
    try {
      const payload = await fetchMentionNotifications({});
      setMentionLane(payload || null);
    } catch {
      setMentionLane(null);
    }
  }, []);
  useEffect(() => { loadMentionLane(); }, [clientId, loadMentionLane]);
  const laneAsks = (mentionLane?.open_asks || []).filter((ask) => ask.client_id === clientId);
  const laneUnread = (mentionLane?.notifications || []).filter(
    (row) => row.client_id === clientId && !row.read_at && (row.kind === 'mention' || row.kind === 'assign' || row.kind === 'ask_answered' || row.kind === 'agent_escalation')
  );
  const mentionCount = laneAsks.length + laneUnread.length;
  const handleMarkMentionsRead = async () => {
    try {
      await markMentionNotificationsRead({ ids: laneUnread.map((row) => row.id) });
      await loadMentionLane();
    } catch { /* the lane refresh will retry on next open */ }
  };

  useEffect(() => {
    setBatchState({ clientId, batches: cachedBatches, providerFailures: null });
    setLoadError('');
    load();
    // Refresh the persisted receipts while Actions is open. This observes the
    // existing workers; it never requests a model retry, draft, ask or posting.
    const timer = setInterval(() => { if (!loadControllerRef.current) load(); }, 15_000);
    return () => {
      clearInterval(timer);
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
      loadRevisionRef.current += 1;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
    };
  }, [clientId, load]);

  const liveDraft = (batches || []).find((batch) => batch.status === 'draft') || null;
  const staleness = askBatchStaleness({ batch: liveDraft, transactions });
  // A1 — the open asks this client is sitting on, newest first. 'open' only:
  // a 'draft' ask hasn't been put to the client yet, so there is no answer to
  // record; replied/resolved are already past this affordance.
  const openRequests = useMemo(
    () => openClientEvidenceRequests(evidenceRequests),
    [evidenceRequests]
  );
  const transactionById = useMemo(
    () => new Map((transactions || []).filter(Boolean).map((transaction) => [transaction.id, transaction])),
    [transactions]
  );
  const presentedBuckets = useMemo(
    () => (feed?.buckets ? presentFeedBuckets(feed.buckets) : null),
    [feed]
  );
  const requestFeedItemById = useMemo(() => {
    const out = new Map();
    for (const items of Object.values(presentedBuckets || {})) {
      for (const item of items || []) {
        if (item?.client_id === clientId && item?.kind === 'client_evidence_request') {
          out.set(item.source_id, item);
        }
      }
    }
    return out;
  }, [clientId, presentedBuckets]);

  // The entity's slice of the firm feed — the same object the Inbox renders
  // (App owns the fetch; one feed, two projections). Rows this surface
  // already renders in richer form are deduped out: the live draft is the
  // draft card, and each open evidence request is a compact waiting row.
  const entityRows = useMemo(() => {
    const out = {};
    for (const key of FEED_BUCKET_ORDER) out[key] = [];
    if (!presentedBuckets || !clientId) return out;
    const openRequestIds = new Set(openRequests.map((request) => request.id));
    // Same presentation partition as the Inbox: Donna's unfinished work
    // renders under donna_working, never as the firm's decisions.
    for (const key of Object.keys(presentedBuckets)) {
      if (!out[key]) continue;
      for (const item of presentedBuckets[key] || []) {
        if (item.client_id !== clientId) continue;
        if (item.kind === 'ask_batch_draft') continue;
        if (item.kind === 'client_evidence_request' && openRequestIds.has(item.source_id)) continue;
        // Transaction/document decisions render inside their accounting month.
        // Keeping them here as well produced the detached "Needs your decision"
        // block above the same bank line (the IRS tax-sensitive regression).
        if (key === 'operator_blocker' && isPeriodOwnedDecision(item)) continue;
        out[key].push(item);
      }
    }
    return out;
  }, [clientId, openRequests, presentedBuckets]);
  // One compact row per persisted open request. Prefer buildFirmFeed's
  // canonical item; the fallback only covers a transient snapshot skew and
  // preserves the same persisted transaction/document anchor. Extra waiting
  // feed rows (for example, a waiting review item) remain visible too.
  const waitingRows = useMemo(() => [
    ...openRequests
      .map((request) => requestFeedItemById.get(request.id) || evidenceRequestListItem({
        request,
        transaction: transactionById.get(request.transaction_id) || null
      }))
      .filter(Boolean),
    ...entityRows.client_info_needed
  ], [entityRows.client_info_needed, openRequests, requestFeedItemById, transactionById]);
  const clientOwnedCount = waitingRows.length;

  // Verdicts moved after the draft was written → Donna refreshes her own
  // draft (Kari, 2026-09-01: the "Refresh it before sending" banner is a
  // firm-side chore the product should do itself). One attempt per
  // (draft, verdict-stamp): success supersedes the draft with a current one;
  // failure leaves the stale draft honestly rendered and the artifact's
  // staleness note + manual Refresh as the fallback — a new verdict
  // movement re-arms the attempt.
  const runDraft = useCallback(async () => {
    setWorking('draft');
    try {
      await draftFirmAskBatch({ clientId });
      await load();
    } catch (error) {
      console.warn('[ask] draft auto-refresh failed', error?.code || error?.message || error);
    } finally {
      setWorking('');
    }
  }, [clientId, load]);

  const autoRefreshAttemptsRef = useRef(new Set());
  useEffect(() => {
    if (!liveDraft || !staleness.stale || working) return;
    const attemptKey = `${liveDraft.id}:${staleness.latestMovementMs}`;
    if (autoRefreshAttemptsRef.current.has(attemptKey)) return;
    autoRefreshAttemptsRef.current.add(attemptKey);
    runDraft();
  }, [liveDraft, staleness.stale, staleness.latestMovementMs, working, runDraft]);

  const noticeColors = {
    alert: { background: 'oklch(0.08 0 0 / 0.04)', color: ui.alert }
  };

  const activateRow = (item) => {
    setActiveRowId(item.source_id);
    onActivateItem?.(item, { explicit: true });
  };

  // Plain rows, no decision-grain group rows (retired 2026-09-01 — see
  // shared/feed-list.jsx): the same one-row-per-item grammar as the month
  // stream below.
  const bucketRows = (key) => entityRows[key].map((item) => (
    <FeedRow
      key={`r-${item.source_id}`}
      item={item}
      isActive={activeRowId === item.source_id}
      onActivate={() => activateRow(item)}
      onOpen={() => activateRow(item)}
      showClientTag={false}
      padX={16}
      layout="bank-feed"
      trailingContent={<span style={bankFeedPillStyle('warm')}>Needs input</span>}
    />
  ));

  const decisionCount = entityRows.operator_blocker.length;
  const waitingCount = showWaitingRows ? clientOwnedCount : 0;

  return (
    <div style={{ width: '100%', padding: embedded ? 0 : '0 0 40px', color: ui.ink, maxWidth: BANK_FEED_LIST_MEASURE, margin: '0 auto', fontFamily: D.ui }}>
      <style>{FEED_ROW_HOVER_CSS}</style>
      <ProviderFailurePanel
        failures={batchState.clientId === clientId ? batchState.providerFailures : null}
        refreshing={refreshing}
        stale={Boolean(loadError)}
        onRefresh={load}
      />
      {typeof loadError === 'string' && loadError && (
        <div style={{ ...noticeColors.alert, borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 500, margin: '10px 0' }}>
          {loadError}
        </div>
      )}
      {!embedded && decisionCount === 0 && waitingCount === 0 && (
        <SectionHeading label="Actions" count={batches === null ? null : 0} />
      )}

      {batches === null && !loadError && (
        <div style={{ color: ui.muted, fontSize: 13, lineHeight: 'normal', padding: '28px 16px' }}>Loading client asks…</div>
      )}

      {/* No "Needs your decision" section, heading, or banner (Kari,
          2026-09-01) — the venture-wide decisions are plain rows with state
          pills, riding the same list the months render below. The drafted
          client message renders NOWHERE here (second call, same day): its
          review surface is the Inbox's ask_batch_draft item → the ask_batch
          artifact. */}
      {decisionCount > 0 && (
        <div style={BANK_FEED_SECTION_STYLE}>
          {bucketRows('operator_blocker')}
        </div>
      )}

      {mentionCount > 0 && (
        <section style={BANK_FEED_SECTION_STYLE}>
          <SectionHeading label="Mentions" count={mentionCount} />
          {laneAsks.map((ask) => {
            // A ledger adjustment a firm member must post renders its stored
            // facts through the catalog, in full; any other ask its question.
            const adjustment = ledgerAdjustmentAskMessages(ask);
            const adjustmentText = adjustment
              ? adjustment.map((message) => intl.formatMessage({ id: message.id }, message.values)).join(' ')
              : null;
            return (
            <div key={ask.id} style={BANK_FEED_ROW_STYLE}>
              <span style={BANK_FEED_DATE_STYLE}>{shortDate(ask.created_at) || '—'}</span>
              <span
                style={adjustmentText
                  ? { ...BANK_FEED_PRIMARY_STYLE, whiteSpace: 'normal' }
                  : { ...BANK_FEED_PRIMARY_STYLE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                data-ask-kind={adjustmentText ? 'ledger_adjustment' : undefined}
              >
                {adjustmentText || ask.question || 'A colleague asked you a question.'}
              </span>
              <span aria-hidden="true" />
              <span style={{ ...BANK_FEED_TRAILING_CELL_STYLE, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                <span style={bankFeedPillStyle('warm')}>Waiting on you</span>
              </span>
            </div>
            );
          })}
          {laneUnread.map((row) => (
            <div key={row.id} style={BANK_FEED_ROW_STYLE}>
              <span style={BANK_FEED_DATE_STYLE}>{shortDate(row.created_at) || '—'}</span>
              <span style={{ ...BANK_FEED_PRIMARY_STYLE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(row.actor_display || row.actor_id || 'A colleague')}
                {row.kind === 'assign' ? ' assigned you'
                  : row.kind === 'ask_answered' ? ' answered your question'
                    : row.kind === 'agent_escalation' ? ' handed a question back'
                      : ' mentioned you'}
                {row.excerpt ? `: “${row.excerpt}”` : ''}
              </span>
              <span aria-hidden="true" />
              <span style={{ ...BANK_FEED_TRAILING_CELL_STYLE, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                <span style={bankFeedPillStyle('muted')}>{row.artifact_type === 'document' ? 'Document' : 'Transaction'}</span>
              </span>
            </div>
          ))}
          {laneUnread.length > 0 && (
            <div style={{ padding: '6px 16px 10px', textAlign: 'right' }}>
              <button
                type="button"
                onClick={handleMarkMentionsRead}
                style={{ ...btnChip, fontSize: 11 }}
              >
                Mark read
              </button>
            </div>
          )}
        </section>
      )}

      {waitingCount > 0 && (
        <section style={BANK_FEED_SECTION_STYLE}>
          <SectionHeading label="Waiting on client" count={waitingCount} />
          {waitingRows.map((item) => (
            <FeedRow
              key={`waiting-${item.kind}-${item.source_id}`}
              item={item}
              isActive={activeRowId === item.source_id}
              onActivate={() => activateRow(item)}
              onOpen={() => activateRow(item)}
              showClientTag={false}
              padX={16}
              layout="bank-feed"
              trailingContent={<span style={bankFeedPillStyle('muted')}>Awaiting reply</span>}
            />
          ))}
        </section>
      )}

      {!embedded && batches !== null && decisionCount === 0 && waitingCount === 0 && (
        <div style={{ padding: '28px 16px', color: ui.muted, fontSize: 13, lineHeight: 'normal' }}>
          Nothing needs attention for this venture.
        </div>
      )}
    </div>
  );
};

export default AskBatchPanel;
