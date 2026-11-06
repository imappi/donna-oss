import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';

import { BidiText } from '../i18n/BidiText.jsx';
import ArtifactPanel, { ARTIFACT_TYPES_WITH_OWN_CHAT } from './financials/artifact-panel.jsx';
import FirmDock, { FirmDockPill } from './firm-dock.jsx';
import { buildDocumentArtifactData } from './financials/financials-view.jsx';
import DonnaActionsPanel from './donna-actions-panel.jsx';
import OutboundOwnerActions from './outbound-owner-actions.jsx';
import AskBatchPanel from './financials/ask-batch-panel.jsx';
import DonnaFirmFeedPanel from './donna-firm-feed-panel.jsx';
import ToastHost from './shared/toast-host.jsx';
import { STACKED_STRIP_TOP } from './shared/FilterPills.jsx';
import { OverflowMenu } from './shared/OverflowMenu.jsx';
import { D } from './shared/design-tokens.js';
import { QUEUE_LABELS } from '../lib/constants.js';
import { fetchFirmSnapshot, formatFirmError, retryFirmClientReadiness } from '../lib/firmApi.js';
import { bestMatchForTransaction } from '../lib/transactionMatchHero.js';
import { buildConvergenceMetricsView } from '../lib/convergenceMetricsView.js';
import { openClientPortal } from '../lib/clientPortalOpen.js';
import { emitToast } from '../lib/toastBus.js';
import { periodOwnedDecisionItems } from './shared/entity-owner-inventory.js';
import FinancialReportWorkspace from './financials/financial-report-workspace.jsx';

const FirmClientWorkspace = lazy(() => import('./FirmClientWorkspace.jsx'));

import {
  applyApprovedRuleToTransaction,
  upsertSuggestedRule
} from '../lib/firmAccounting.js';

const actionLabel = (item) => QUEUE_LABELS[item.queue_label] || item.queue_label || 'Review';

// Daily work stays in the bar; admin/occasional screens live behind the
// toolbar's ⋯ menu (Kari, 2026-08-07: "not full of links to screens that
// are rarely used" — clarity, simplicity, speed, daily work).
// Single-lifecycle IA (Kari, 2026-08-29): the Actions / Material split is
// gone. The default overview stacks owner work, client-owned work, unfinished
// material, and reconciled history in one scroll. Profile/governance reads stay
// occasional views behind the one overflow menu below.

// The entity pane's own insets. Named because the toolbar has to CANCEL them
// to reach the panel's corner (below) — a bare -32 next to a padding: 32 is
// two numbers that drift apart on the first spacing tweak.
const PANE_PAD_X = 32;
const PANE_PAD_TOP = 20;

const ENTITY_MENU_TABS = [
  { key: 'profile', labelId: 'firm.menu.profile' },
  { key: 'people', labelId: 'firm.menu.people' }
];

const FirmOpsConsole = ({
  clients,
  selectedClientId,
  showHome,
  feed = null,
  onSelectClient,
  queue,
  setQueue,
  history,
  setHistory,
  firmMessages = [],
  setFirmMessages,
  documents = [],
  setDocuments,
  transactions = [],
  setTransactions,
  accountingRules = [],
  setAccountingRules,
  reconciliationMatches = [],
  clientRules = [],
  transactionReviewQueue = [],
  clientEvidenceRequests = [],
  transactionAiBatch = null,
  ledgerAccounts = [],
  ledgerJournals = [],
  ledgerLines = [],
  closeArchives = [],
  closePeriods = [],
  recentUploadBatches = [],
  firmId = null,
  firmDataSource = 'local',
  onDatabaseSnapshot,
  onUploadsSnapshotInvalidated,
  onRefreshTransactionIntel,
  onSuggestTransactionCoding,
  onBatchSuggestTransactionCoding,
  onPersistReconciliationMatch,
  onPersistManualLink,
  onChatActionSnapshotApplied,
  onPersistClientRule,
  onPersistTransactionReviewItem,
  onPersistDocumentPatch,
  onDeleteDocument,
  onPersistTransactionPatch,
  initialFirmLane,
  activeEntityTab = 'actions',
  onEntityTabChange,
  onResetDemo,
  onDeleteClient,
  onAddVenture
}) => {
  const intl = useIntl();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [readinessRetryPending, setReadinessRetryPending] = useState(false);
  const [artifact, setArtifact] = useState(null);
  // The accounting panel registers the few alternate reads that still earn a
  // destination (Aging and live statutory returns) so the entity toolbar's
  // single ⋯ carries them.
  const [feedViewMenu, setFeedViewMenu] = useState(null);
  // The action stack unmounts for an occasional read. Keep the last successful
  // ask snapshot at the console level so returning to the overview paints
  // immediately while the panel refreshes in the background. The cache dies
  // with this signed-in workspace; no ask data lives in module/browser storage.
  const [askBatchesByClient, setAskBatchesByClient] = useState({});
  const cacheAskBatches = useCallback((clientId, batches) => {
    if (!clientId) return;
    setAskBatchesByClient((previous) => ({
      ...previous,
      [clientId]: Array.isArray(batches) ? batches : []
    }));
  }, []);
  // The right dock (chat + uploads) — open by default, collapse persisted.
  const [dockOpen, setDockOpen] = useState(() => {
    try { return window.localStorage.getItem('donna_dock_open') !== '0'; } catch { return true; }
  });
  const setDockOpenPersist = useCallback((next) => {
    setDockOpen(next);
    try { window.localStorage.setItem('donna_dock_open', next ? '1' : '0'); } catch { /* private mode */ }
  }, []);
  // The financials panel registers its apply-lifecycle handler here so the
  // dock's FeedChat (mounted at console level, above the panel) can still
  // shimmer the targeted feed rows and fold settle receipts. Null whenever
  // the Bank feed tab isn't mounted — events are simply dropped then.
  const feedApplyLifecycleRef = useRef(null);
  const emitFeedApplyLifecycle = useCallback((event) => {
    feedApplyLifecycleRef.current?.(event);
  }, []);
  const selectedClient = showHome
    ? null
    : clients.find((client) => client.id === selectedClientId) || clients[0] || null;
  const selectedReadiness = selectedClient?.runtime_readiness || null;
  const readinessTone = selectedReadiness?.effective_state === 'ready'
    ? { color: D.inkSoft, background: D.ruleSoft }
    : selectedReadiness?.effective_state === 'legacy_uncertified'
      ? { color: D.inkMute, background: D.ruleSoft }
      : { color: D.alert, background: D.alertWash };
  // An exhausted saga's exit is the explicit reopen (a fresh bounded recovery
  // episode with its own receipt) — the same button, honestly relabeled.
  const readinessReopen = Boolean(selectedReadiness?.can_reopen && !selectedReadiness?.can_retry_now);
  const retryReadiness = useCallback(async () => {
    if (!selectedClient?.id || readinessRetryPending) return;
    if (!selectedReadiness?.can_retry_now && !readinessReopen) return;
    setReadinessRetryPending(true);
    try {
      const snapshot = await retryFirmClientReadiness(selectedClient.id, { reopenExhausted: readinessReopen });
      onDatabaseSnapshot?.(snapshot);
      emitToast({ message: intl.formatMessage({ id: 'firm.readiness.retryRecorded' }), tone: 'pos' });
    } catch (error) {
      emitToast({
        message: formatFirmError(error, intl.formatMessage({ id: 'firm.readiness.retryError' })),
        tone: 'neg'
      });
    } finally {
      setReadinessRetryPending(false);
    }
  }, [intl, onDatabaseSnapshot, readinessReopen, readinessRetryPending, selectedClient?.id, selectedReadiness?.can_retry_now]);
  useEffect(() => {
    const hostRecoveryVisible = firmDataSource === 'database'
      && Boolean(selectedClient?.id)
      && (selectedReadiness?.reason_code === 'host_certificate_not_pass'
        || selectedReadiness?.waiting_for_host
        || selectedReadiness?.effective_state === 'host_unavailable');
    if (!hostRecoveryVisible) return undefined;

    let cancelled = false;
    let timer = null;
    let attempts = 0;
    const pollReadiness = async () => {
      try {
        const snapshot = await fetchFirmSnapshot();
        if (cancelled) return;
        onDatabaseSnapshot?.(snapshot);
        const refreshed = snapshot.clients?.find(({ id }) => id === selectedClient.id)?.runtime_readiness;
        if (refreshed?.effective_state === 'ready') return;
      } catch {
        // The ordinary snapshot/error surfaces remain authoritative. This
        // bounded recovery poll is only responsible for replacing stale UI.
      }
      attempts += 1;
      if (!cancelled && attempts < 30) timer = setTimeout(pollReadiness, 1000);
    };
    timer = setTimeout(pollReadiness, 1000);
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [
    firmDataSource,
    onDatabaseSnapshot,
    selectedClient?.id,
    selectedReadiness?.effective_state,
    selectedReadiness?.reason_code,
    selectedReadiness?.waiting_for_host
  ]);
  // Actions, Material and the retired Documents/Close routes all name the one
  // overview now. Keeping the aliases makes old email/OAuth/deep links land on
  // the live screen instead of a ghost pane.
  const entityTab = ENTITY_MENU_TABS.some((tab) => tab.key === activeEntityTab)
    ? activeEntityTab
    : 'overview';
  const selectedQueue = selectedClient
    ? queue.filter((item) => item.client_id === selectedClient.id)
    : queue;
  const selectedHistory = selectedClient
    ? history.filter((item) => !item.client_id || item.client_id === selectedClient.id)
    : history;
  const selectedClientHistory = selectedClient
    ? history.filter((item) => item.client_id === selectedClient.id)
    : [];
  const selectedDocuments = selectedClient
    ? documents.filter((document) => document.client_id === selectedClient.id)
    : [];
  const selectedTransactions = selectedClient
    ? transactions.filter((transaction) => transaction.client_id === selectedClient.id)
    : [];
  const selectedAccountingRules = selectedClient
    ? accountingRules.filter((rule) => rule.client_id === selectedClient.id && rule.status !== 'dismissed')
    : [];
  const selectedReconciliationMatches = selectedClient
    ? reconciliationMatches.filter((match) => match.client_id === selectedClient.id)
    : reconciliationMatches;
  const selectedClientRules = selectedClient
    ? clientRules.filter((rule) => rule.client_id === selectedClient.id)
    : clientRules;
  const selectedTransactionReviewQueue = selectedClient
    ? transactionReviewQueue.filter((item) => item.client_id === selectedClient.id)
    : transactionReviewQueue;
  const selectedClientEvidenceRequests = selectedClient
    ? clientEvidenceRequests.filter((item) => item.client_id === selectedClient.id)
    : clientEvidenceRequests;
  // Slice J consumer — the per-client convergence metrics for the Reconcile
  // workbench, tallied from the PERSISTED per-row convergence_state the backend
  // already attached (never re-derived in the FE). Computed off the already
  // client-scoped slices, so it inherits the snapshot's access scoping.
  const selectedConvergenceMetrics = buildConvergenceMetricsView({
    transactions: selectedTransactions,
    reviewItems: selectedTransactionReviewQueue,
  });
  const selectedRecentUploadBatches = selectedClient
    ? (recentUploadBatches || []).filter((batch) => batch.client_id === selectedClient.id)
    : (recentUploadBatches || []);
  // Donna ledger views — filtered by selected client. Pass-through only;
  // these are read-only references for the audit/correction workbench
  // and the Close archive card.
  const selectedLedgerAccounts = selectedClient
    ? ledgerAccounts.filter((account) => account.client_id === selectedClient.id)
    : [];
  const selectedLedgerJournals = selectedClient
    ? ledgerJournals.filter((journal) => journal.client_id === selectedClient.id)
    : [];
  const selectedLedgerLines = selectedClient
    ? ledgerLines.filter((line) => line.client_id === selectedClient.id)
    : [];
  const selectedCloseArchives = selectedClient
    ? closeArchives.filter((archive) => archive.client_id === selectedClient.id)
    : [];
  const selectedClosePeriods = selectedClient
    ? closePeriods.filter((period) => period.client_id === selectedClient.id)
    : [];
  const selectedPeriodOwnerDecisions = periodOwnedDecisionItems(feed, selectedClient?.id || null);
  useEffect(() => {
    setDeleteConfirmOpen(false);
    setDeletePending(false);
    setDeleteError('');
    setArtifact(null);
  }, [selectedClientId]);

  // Home-feed → artifact. Replaces the #217/#218 hint plumbing: the All
  // ventures feed stays in the canvas and the artifact opens on the
  // right next to it, instead of navigating into the entity workspace.
  // "explicit" means click/Enter — always opens or replaces the
  // artifact. "implicit" means j/k navigation — only updates the
  // artifact if one is already open, so keyboard exploration without
  // an open artifact doesn't suddenly surface one.
  const handleHomeFeedActivate = (item, { explicit } = { explicit: false }) => {
    if (!item) return;
    if (!explicit && !artifact) return;

    // A drafted ask batch opens its own artifact (read the full message,
    // audit detail, send) — the same surface the overview's draft row opens,
    // so the Inbox and the venture list cannot drift. The artifact fetches
    // the live batch itself and writes what it learns back into the console
    // cache.
    if (item.kind === 'ask_batch_draft') {
      if (!explicit) return;
      setArtifact({
        type: 'ask_batch',
        title: intl.formatMessage({ id: 'mounted.console.messageClient' }),
        data: {
          clientId: item.client_id,
          transactions: transactions.filter((t) => t.client_id === item.client_id),
          onBatchesChanged: cacheAskBatches
        }
      });
      return;
    }

    const txId = item.transaction_id
      || (item.kind === 'review_item' && item.item_type === 'transaction' ? item.item_id : null);
    if (txId) {
      const tx = transactions.find((t) => t.id === txId);
      if (tx) {
        // Thread persisted reconciliation state into the artifact the
        // same way the workspace call sites do — otherwise a matched
        // line opened from the home feed renders as unmatched. Scoped
        // to the tx's client: the home feed is firm-wide and the
        // artifact's candidate pool / chat context must never see
        // another client's documents.
        const txClientId = tx.client_id || item.client_id || null;
        const clientDocuments = documents.filter((d) => d.client_id === txClientId);
        const clientTransactions = transactions.filter((t) => t.client_id === txClientId);
        const clientMatches = reconciliationMatches.filter((m) => m.client_id === txClientId);
        const txMatch = bestMatchForTransaction(clientMatches, txId);
        const matchedDocument = txMatch?.matched_object_id
          ? clientDocuments.find((d) => d.id === txMatch.matched_object_id) || null
          : null;
        const openDocumentArtifact = (doc) => {
          if (!doc) return;
          const docData = buildDocumentArtifactData(doc, clientTransactions);
          docData.firmDocument = doc;
          setArtifact({
            type: 'document',
            title: docData.document?.title || doc.filename || intl.formatMessage({ id: 'mounted.console.document' }),
            data: docData
          });
        };
        setArtifact({
          type: 'transaction',
          title: tx.description || tx.counterparty || intl.formatMessage({ id: 'mounted.console.transaction' }),
          data: {
            transaction: tx,
            clientId: txClientId,
            match: txMatch,
            matchedDocument,
            documents: clientDocuments,
            transactions: clientTransactions,
            reconciliationMatches: clientMatches,
            onOpenMatchedDocument: matchedDocument ? () => openDocumentArtifact(matchedDocument) : null,
            onOpenDocument: openDocumentArtifact
          }
        });
        return;
      }
    }

    // A reconciliation action can carry both transaction_id and the matched
    // document id. The bank line owns that case: try it first so Actions opens
    // the same transaction case-file artifact as Bank feed, rather than the
    // retired document-first detail view. Document-only asks and parse failures
    // still open their document artifact here.
    const docId = item.matched_object_id || item.document_id;
    if (docId) {
      const doc = documents.find((d) => d.id === docId);
      if (doc) {
        const data = buildDocumentArtifactData(doc, transactions);
        data.firmDocument = doc;
        setArtifact({
          type: 'document',
          title: data.document?.title || doc.filename || intl.formatMessage({ id: 'mounted.console.document' }),
          data
        });
        return;
      }
    }

    // No matched artifact — on explicit activation, drop any stale
    // artifact so the right side reflects the user's last click.
    if (explicit) setArtifact(null);
  };

  // The confirm dialog is position:fixed at top:72px, so when the trigger is
  // the Danger zone pill (right column of the Profile tab, often below the
  // fold) the dialog opens off-screen and the click looks like a no-op.
  // Scroll the page to the top whenever the dialog opens so the user
  // actually sees it.
  useEffect(() => {
    if (!deleteConfirmOpen) return;
    if (typeof window === 'undefined') return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [deleteConfirmOpen]);

  const handleConfirmDelete = async () => {
    if (!selectedClient || !onDeleteClient || deletePending) return;

    setDeletePending(true);
    setDeleteError('');
    try {
      await onDeleteClient(selectedClient.id);
      setDeleteConfirmOpen(false);
    } catch (error) {
      setDeleteError(formatFirmError(error, intl.formatMessage({ id: 'mounted.console.deleteError' })));
    } finally {
      setDeletePending(false);
    }
  };

  // URL sync moved to App.jsx — App now owns firmEntityTab so it
  // can write URL from the same render where the tab changes,
  // without the closure-vs-setter race that hit feed-row opens.

  // open_document (two-surface IA P4) — the dock chat's retrieval affordance:
  // Donna resolves "find that PDF" against the persisted document_index
  // server-side; the Open button lands here with the sanitized document_id
  // and opens the same read-only artifact a feed-row activation opens. The
  // rail's ownership rule means the artifact replaces the chat in the rail —
  // the same behaviour as opening it from a row.
  const openDocumentFromChat = useCallback((target) => {
    const documentId = typeof target === 'string' ? target : target?.documentId;
    const targetClientId = typeof target === 'object' ? target?.clientId : selectedClient?.id;
    if (!documentId || !targetClientId) return;
    const doc = documents.find((d) => d.id === documentId && d.client_id === targetClientId);
    if (!doc) return;
    const clientTransactions = transactions.filter((transaction) => transaction.client_id === targetClientId);
    const data = buildDocumentArtifactData(doc, clientTransactions);
    data.firmDocument = doc;
    setArtifact({
      type: 'document',
      title: data.document?.title || doc.filename || intl.formatMessage({ id: 'mounted.console.document' }),
      data
    });
  }, [documents, intl, selectedClient?.id, transactions]);

  // open_financials (two-surface IA stage C, Kari's pick 2026-08-26:
  // Financial-report answers carry their own venture + server-resolved posted
  // ledger month. This remains target-bearing on the firm Inbox, where there
  // is intentionally no selectedClient.
  const openFinancialsFromChat = useCallback((target) => {
    const clientId = target?.clientId || selectedClient?.id;
    if (!clientId) return;
    const clientTransactions = transactions.filter((transaction) => transaction.client_id === clientId);
    let resolved = typeof target?.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(target.period)
      ? target.period
      : null;
    // Legacy persisted actions predate §13 and may still carry period=null.
    // Keep them openable, but all newly minted actions arrive concrete from
    // getLatestPostedLedgerPeriodFromDb.
    if (!resolved) {
      let bestTs = -Infinity;
      for (const tx of clientTransactions) {
        const ts = Date.parse(tx?.date || tx?.created_at || '');
        if (Number.isFinite(ts) && ts > bestTs) bestTs = ts;
      }
      const anchor = Number.isFinite(bestTs) && bestTs > 0 ? new Date(bestTs) : new Date();
      resolved = `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    setArtifact({
      type: 'financials',
      title: target?.clientName
        ? intl.formatMessage({ id: 'mounted.console.financialsNamed' }, { ventureName: target.clientName })
        : intl.formatMessage({ id: 'mounted.console.financials' }),
      data: { clientId, period: resolved }
    });
  }, [intl, selectedClient?.id, transactions]);

  // The dock node the rail stacks beneath an open artifact. Database mode
  // only — the demo lane has no persisted feed chat and no upload pipeline.
  const dockNode = firmDataSource === 'database' ? (
    <FirmDock
      clientId={selectedClient?.id || null}
      clientName={selectedClient?.companyName || ''}
      dataSource={firmDataSource}
      onSnapshotApplied={onDatabaseSnapshot}
      onApplyLifecycle={emitFeedApplyLifecycle}
      onUploadsSnapshotInvalidated={onUploadsSnapshotInvalidated}
      onOpenDocument={openDocumentFromChat}
      onOpenFinancials={openFinancialsFromChat}
      onClose={() => setDockOpenPersist(false)}
    />
  ) : null;
  const dockPill = dockNode && !dockOpen ? (
    <FirmDockPill
      activeClientId={selectedClient?.id || ''}
      onOpen={() => setDockOpenPersist(true)}
    />
  ) : null;
  // The dock stacks beneath any artifact WITHOUT its own item chat (the
  // rail is ONE work surface with chat at the bottom — Kari's standing UI
  // rail, 2026-08-26), so the collapsed-dock pill stays reachable there
  // too; only the two own-chat artifact types still suppress it.
  const dockCanShare = !artifact || !ARTIFACT_TYPES_WITH_OWN_CHAT.has(artifact.type);

  // Empty-firm guard. The entity workspace shell and the all-ventures action
  // dashboard both become noise before the first venture exists, especially
  // after a destructive reset leaves stale entity params in the URL. Give the
  // canvas to one onboarding CTA instead.
  if (clients.length === 0) {
    return <EmptyFirmState onAddVenture={onAddVenture} />;
  }

  const reportClient = artifact?.type === 'financials'
    ? clients.find((client) => client.id === artifact.data?.clientId) || null
    : null;
  if (artifact?.type === 'financials' && reportClient) {
    return (
      <section
        className="firm-console firm-console--financial-report"
        style={{
          background: D.paper,
          minHeight: '100%',
          fontFamily: D.ui,
          color: D.ink,
          fontSize: 15,
          lineHeight: 1.55,
          display: 'flex',
          alignItems: 'stretch'
        }}
      >
        <main className="firm-console__main" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          <FinancialReportWorkspace
            artifact={artifact}
            ventureLabel={reportClient.companyName}
            returnLabel={intl.formatMessage({ id: showHome ? 'mounted.console.backInbox' : 'mounted.console.backOverview' })}
            onClose={() => setArtifact(null)}
          />
        </main>
        <ArtifactPanel
          artifact={null}
          setArtifact={setArtifact}
          onSuggestTransactionCoding={onSuggestTransactionCoding}
          onApplyLifecycle={emitFeedApplyLifecycle}
          dock={dockNode}
          dockOpen={dockOpen}
        />
        {dockPill}
        <ToastHost />
      </section>
    );
  }

  if (showHome) {
    // Same flex shell as the entity workspace below — feed on the
    // left, ArtifactPanel sticky on the right. The panel collapses to
    // width 0 when artifact is null, so a fresh home view still reads
    // as a full-width feed; clicking a row pops the artifact in
    // alongside the feed instead of navigating away.
    return (
      <section
        className="firm-console"
        style={{
          background: D.paper,
          // 100% of the workspace PANEL, not 100vh — the panel is inset from the
          // window by the shell gutters (panels-on-ground, 2026-08-05) and 100vh
          // here forced a permanent gutter-height scroll.
          minHeight: '100%',
          fontFamily: D.ui,
          color: D.ink,
          fontSize: 15,
          lineHeight: 1.55,
          display: 'flex',
          alignItems: 'stretch'
        }}
      >
        <div className="firm-console__main" style={{ flex: 1, minWidth: 0 }}>
          <DonnaFirmFeedPanel
            clients={clients}
            feed={feed}
            onActivateItem={handleHomeFeedActivate}
            onResetDemo={onResetDemo}
            firmDataSource={firmDataSource}
          />
        </div>
        <ArtifactPanel artifact={artifact} setArtifact={setArtifact} onSuggestTransactionCoding={onSuggestTransactionCoding} onApplyLifecycle={emitFeedApplyLifecycle} dock={dockNode} dockOpen={dockOpen} />
        {dockCanShare && dockPill}
        <ToastHost />
      </section>
    );
  }

  return (
    <section
      className="firm-console"
      style={{
        background: D.paper,
        // 100% of the workspace PANEL, not 100vh — the panel is inset from the
        // window by the shell gutters (panels-on-ground, 2026-08-05) and 100vh
        // here forced a permanent gutter-height scroll.
        minHeight: '100%',
        fontFamily: D.ui,
        color: D.ink,
        fontSize: 15,
        lineHeight: 1.55,
        display: 'flex',
        alignItems: 'stretch'
      }}
    >
      <div className="firm-console__main" style={{ flex: 1, minWidth: 0, padding: `${PANE_PAD_TOP}px ${PANE_PAD_X}px 80px` }}>
      <div className={`firm-console__workspace${
        ['overview', 'profile', 'people'].includes(entityTab)
          ? ' firm-console__workspace--financials'
          : ''
      }`}>
      {/* Entity toolbar — one quiet row. The daily lifecycle no longer needs a
          view switch; only occasional reads remain behind the overflow menu.
          Anything sticky inside the overview stacks beneath this bar via
          STACKED_STRIP_TOP, which is this bar's own height. */}
      <div
        className="firm-console__entity-chrome"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          height: STACKED_STRIP_TOP,
          background: D.paper,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 6,
          minWidth: 0,
          // FULL-BLEED: cancel the pane's insets so the bar spans the panel and
          // the entity name lands in the panel's own top-left corner (Kari,
          // 2026-08-08) rather than where the LIST happens to start. The
          // vertical cancel reads --shell-pad-top because that value changes at
          // the small-screen breakpoint; hardcoding 28 here would leave a gap
          // on a narrow window. The panel's radius clips the bar's corners,
          // which is what rounds the top of the bar against the ground.
          marginTop: `calc(-1 * var(--shell-pad-top, 28px) - ${PANE_PAD_TOP}px)`,
          marginInlineStart: -PANE_PAD_X,
          marginInlineEnd: -PANE_PAD_X,
          // This element starts inside the pane's padded content box. Negative
          // margins move it to the full-bleed edge but do not enlarge a
          // width:100% child, which left the centred view switch 32px left of
          // the centred list. Grow by both cancelled insets so the switch and
          // every measured tab below share one horizontal centre line.
          width: `calc(100% + ${PANE_PAD_X * 2}px)`,
          maxWidth: 'none',
          padding: '0 16px 6px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          {selectedClient && (
            <span
              title={selectedClient.companyName}
              style={{
                minWidth: 0,
                fontSize: 13,
                fontWeight: 500,
                color: D.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              <BidiText direction="auto">{selectedClient.companyName}</BidiText>
            </span>
          )}
          {selectedReadiness && (
            <span
              title={[
                selectedReadiness.detail,
                selectedReadiness.reason_code
                  ? intl.formatMessage({ id: 'firm.readiness.reason' }, { code: selectedReadiness.reason_code })
                  : null,
                selectedReadiness.receipt_ref?.id
                  ? intl.formatMessage(
                      { id: 'firm.readiness.receipt' },
                      { store: selectedReadiness.receipt_ref.store, id: selectedReadiness.receipt_ref.id }
                    )
                  : null,
                selectedReadiness.next_retry_at
                  ? intl.formatMessage({ id: 'firm.readiness.nextRetry' }, { date: selectedReadiness.next_retry_at })
                  : null,
                // RT-09: a host wait has no clock and no click — the Host A
                // PASS renewal heals it, and the budget is untouched.
                selectedReadiness.waiting_for_host
                  ? intl.formatMessage({ id: 'firm.readiness.waitingForHost' })
                  : null
              ].filter(Boolean).join('\n')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                flexShrink: 0,
                maxWidth: 'min(44vw, 440px)',
                padding: '3px 7px',
                borderRadius: 999,
                fontFamily: D.ui,
                fontSize: 11,
                lineHeight: 1.2,
                color: readinessTone.color,
                background: readinessTone.background
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {/* The reason code is a diagnostic, not owner copy: it stays in
                    the tooltip above with the receipt, never in the chip. */}
                <BidiText direction="auto">{selectedReadiness.label}</BidiText>
              </span>
              {(selectedReadiness.can_retry_now || selectedReadiness.can_reopen) && firmDataSource === 'database' && (
                <button
                  type="button"
                  disabled={readinessRetryPending}
                  onClick={retryReadiness}
                  style={{
                    border: 0,
                    padding: 0,
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    fontWeight: 650,
                    cursor: readinessRetryPending ? 'wait' : 'pointer',
                    textDecoration: 'underline',
                    textUnderlineOffset: 2
                  }}
                >
                  {intl.formatMessage({
                    id: readinessRetryPending
                      ? 'common.retrying'
                      : readinessReopen ? 'firm.readiness.reopen' : 'common.retry'
                  })}
                </button>
              )}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ flexShrink: 0 }}>
          <OverflowMenu
            label={intl.formatMessage({ id: 'firm.menu.moreViews' })}
            items={[
              {
                id: 'overview',
                label: intl.formatMessage({ id: 'firm.menu.overview' }),
                active: entityTab === 'overview' && (!feedViewMenu?.active || feedViewMenu.active === 'feed'),
                onSelect: () => {
                  if (entityTab !== 'overview') onEntityTabChange?.('actions');
                  feedViewMenu?.select?.('feed');
                }
              },
              // Only real read destinations remain: Aging plus any live
              // jurisdiction-specific statutory return registered below.
              ...(entityTab === 'overview' && feedViewMenu?.items?.length
                ? feedViewMenu.items.map((it) => ({
                    id: `feedview-${it.id}`,
                    label: it.label,
                    active: feedViewMenu.active === it.id,
                    onSelect: () => feedViewMenu.select?.(it.id)
                  }))
                : []),
              ...ENTITY_MENU_TABS.map((t, i) => ({
                id: t.key,
                label: intl.formatMessage({ id: t.labelId }),
                active: entityTab === t.key,
                separatorBefore:
                  i === 0 && (
                    entityTab === 'overview'
                    && !!feedViewMenu?.items?.length
                  ),
                onSelect: () => onEntityTabChange?.(t.key)
              })),
              ...(selectedClient
                ? [{
                    id: 'portal',
                    label: intl.formatMessage({ id: 'firm.menu.openPortal' }),
                    separatorBefore: true,
                    onSelect: () => {
                      openClientPortal({ clientId: selectedClient.id }).catch((error) => {
                        emitToast({
                          message: error.message || intl.formatMessage({ id: 'firm.portal.openError' }),
                          tone: 'error'
                        });
                      });
                    }
                  }]
                : [])
            ]}
          />
          </span>
        </div>
      </div>

      {deleteConfirmOpen && selectedClient && typeof document !== 'undefined' && createPortal(
        <>
          <div
            className="firm-delete-confirm__scrim"
            aria-hidden="true"
            onClick={() => {
              if (!deletePending) setDeleteConfirmOpen(false);
            }}
          />
          <section className="firm-delete-confirm" role="alertdialog" aria-labelledby="delete-entity-title">
            <div>
              <h2 id="delete-entity-title">
                {intl.formatMessage(
                  { id: 'firm.delete.title' },
                  { companyName: <BidiText direction="auto">{selectedClient.companyName}</BidiText> }
                )}
              </h2>
              <p>
                {intl.formatMessage(
                  { id: 'firm.delete.body' },
                  { openCount: selectedQueue.length, historyCount: selectedClientHistory.length }
                )}
              </p>
            </div>
            <div className="firm-delete-confirm__actions">
              <button
                className="btn btn-outline"
                type="button"
                disabled={deletePending}
                onClick={() => setDeleteConfirmOpen(false)}
              >
                {intl.formatMessage({ id: 'firm.delete.keep' })}
              </button>
              <button
                className="btn btn-outline-red"
                type="button"
                disabled={deletePending}
                onClick={handleConfirmDelete}
              >
                {intl.formatMessage({ id: deletePending ? 'firm.delete.deleting' : 'firm.delete.action' })}
              </button>
            </div>
            {deleteError && <p className="firm-delete-confirm__error">{deleteError}</p>}
          </section>
        </>,
        document.body
      )}

      {/* ONE measure for every tab and subtab (Kari, 2026-08-10): the cap
          lives HERE, once, below the full-bleed toolbar — never per-panel,
          so a new tab gets it for free and no tab can drift wide. */}
      <div style={{ width: '100%', maxWidth: D.measure, marginInline: 'auto' }}>
      {entityTab === 'overview' && (
        // Owner and client work lead the one lifecycle overview. The original
        // ReviewQueue is still available at /firms home and /queue; this
        // entity-scoped stack is followed immediately by unfinished material
        // and reconciled history below.
        <>
        <OutboundOwnerActions
          clientId={selectedClient?.id}
          enabled={firmDataSource === 'database'}
        />
        {firmDataSource === 'database' ? (
          // Database-backed Actions is the entity-scoped convergence surface — the
          // Inbox's feed filtered to this venture (same bucket/row grammar,
          // shared/feed-list.jsx), woven with the ask-lane detail this tab
          // owns (record answers, sent receipts, the silent stale-draft
          // refresh). The drafted client message has no row here (Kari,
          // 2026-09-01, second call) — its review surface is the Inbox's
          // ask_batch_draft item, which routes to the ask_batch artifact.
          // Row activation reuses the home feed's artifact opener, so a
          // match row opens the same right-side artifact here as from the
          // Inbox. The mock-era triage stack does not render against a real
          // book on either host.
          <AskBatchPanel
            clientId={selectedClient?.id}
            transactions={selectedTransactions}
            evidenceRequests={selectedClientEvidenceRequests}
            feed={feed}
            onActivateItem={handleHomeFeedActivate}
            cachedBatches={selectedClient?.id ? askBatchesByClient[selectedClient.id] ?? null : null}
            onCacheBatches={cacheAskBatches}
            showWaitingRows={false}
            embedded
          />
        ) : (
          <DonnaActionsPanel
            queue={selectedQueue}
            setQueue={setQueue}
            history={selectedHistory}
            setHistory={setHistory}
            firmMessages={firmMessages}
            setFirmMessages={setFirmMessages}
            initialFirmLane={initialFirmLane}
            client={selectedClient}
            recentUploadBatches={selectedRecentUploadBatches}
            embedded
          />
        )}
        </>
      )}
      <Suspense fallback={null}>
          <FirmClientWorkspace
            profile={selectedClient}
            firmId={firmId}
            firmDataSource={firmDataSource}
            queue={selectedQueue}
            documents={selectedDocuments}
            transactions={selectedTransactions}
            accountingRules={selectedAccountingRules}
            reconciliationMatches={selectedReconciliationMatches}
            clientRules={selectedClientRules}
            transactionReviewQueue={selectedTransactionReviewQueue}
            clientEvidenceRequests={selectedClientEvidenceRequests}
            periodOwnerDecisions={selectedPeriodOwnerDecisions}
            onActivatePeriodOwnerDecision={handleHomeFeedActivate}
            convergenceMetrics={selectedConvergenceMetrics}
            // Per-doc actions for the feed's doc-anchored Open rows (two-surface
            // IA §3: the old Documents tab's affordances live on the row and
            // the artifact, so the fold lost nothing).
            baseCurrency={selectedClient?.default_currency || selectedClient?.currency || ''}
            onCreateManualLink={
              onPersistManualLink && selectedClient?.id
                ? async ({ documentId, bankTransactionId, reviewerNote }) =>
                    onPersistManualLink({
                      documentId,
                      bankTransactionId,
                      reviewerNote,
                      clientId: selectedClient.id
                    })
                : undefined
            }
            onChatActionSnapshotApplied={onChatActionSnapshotApplied}
            onDeleteDocument={onDeleteDocument}
            closePeriods={selectedClosePeriods}
            closeArchives={selectedCloseArchives}
            transactionAiBatch={transactionAiBatch}
            ledgerAccounts={selectedLedgerAccounts}
            ledgerJournals={selectedLedgerJournals}
            ledgerLines={selectedLedgerLines}
            onRefreshTransactionIntel={
            onRefreshTransactionIntel && selectedClient
              ? () => onRefreshTransactionIntel([selectedClient.id])
              : undefined
          }
          onSuggestTransactionCoding={onSuggestTransactionCoding}
          onBatchSuggestTransactionCoding={
            onBatchSuggestTransactionCoding && selectedClient
              ? () => onBatchSuggestTransactionCoding([selectedClient.id])
              : undefined
          }
          onUpdateReconciliationMatch={onPersistReconciliationMatch}
            onUpdateClientRule={onPersistClientRule}
            onUpdateTransactionReviewItem={onPersistTransactionReviewItem}
            onDatabaseSnapshot={onDatabaseSnapshot}
            onRegisterFeedApplyLifecycle={(handler) => { feedApplyLifecycleRef.current = handler; }}
            onRegisterFeedViewMenu={setFeedViewMenu}
            onRequestDelete={
              onDeleteClient && selectedClient
                ? () => {
                    setDeleteError('');
                    setDeleteConfirmOpen(true);
                  }
                : undefined
            }
            onUpdateDocument={
            setDocuments
              ? async (documentId, patch) => {
                  if (firmDataSource === 'database' && onPersistDocumentPatch) {
                    await onPersistDocumentPatch(documentId, { ...patch, reviewed_at: Date.now() });
                    return;
                  }
                  setDocuments((prev) =>
                    prev.map((document) =>
                      document.id === documentId
                        ? {
                            ...document,
                            ...patch,
                            reviewed_at: Date.now()
                          }
                        : document
                    )
                  );
                }
              : undefined
          }
          onUpdateTransaction={
            setTransactions
              ? async (transactionId, patch) => {
                if (firmDataSource === 'database' && onPersistTransactionPatch) {
                    return onPersistTransactionPatch(transactionId, { ...patch, updated_at: Date.now() });
                  }
                  setTransactions((prev) =>
                    prev.map((transaction) =>
                      transaction.id === transactionId
                        ? {
                            ...transaction,
                            ...patch,
                            updated_at: Date.now()
                          }
                        : transaction
                    )
                  );
                }
              : undefined
          }
          onApproveTransaction={
            setTransactions
              ? async (transaction) => {
                  const approvedTransaction = {
                    ...transaction,
                    status: 'approved',
                    confidence: 'high',
                    updated_at: Date.now()
                  };
                  if (firmDataSource === 'database' && onPersistTransactionPatch) {
                    await onPersistTransactionPatch(transaction.id, approvedTransaction);
                    return;
                  }
                  setTransactions((prev) =>
                    prev.map((current) =>
                      current.id === transaction.id ? approvedTransaction : current
                    )
                  );
                  if (setAccountingRules) {
                    setAccountingRules((prev) => upsertSuggestedRule(prev, approvedTransaction));
                  }
                }
              : undefined
          }
          onUpdateAccountingRule={
            setAccountingRules
              ? (ruleId, patch) => {
                  const existingRule = accountingRules.find((rule) => rule.id === ruleId);
                  const nextRule = existingRule
                    ? { ...existingRule, ...patch, updated_at: Date.now() }
                    : null;

                  setAccountingRules((prev) =>
                    prev.map((rule) => (rule.id === ruleId ? { ...rule, ...patch, updated_at: Date.now() } : rule))
                  );

                  if (nextRule?.status === 'approved' && setTransactions) {
                    setTransactions((prev) =>
                      prev.map((transaction) => applyApprovedRuleToTransaction(transaction, [nextRule]))
                    );
                  }
                }
              : undefined
          }
          activeTab={entityTab === 'overview' ? 'accounting' : entityTab}
          onArtifact={setArtifact}
            hideHeader
          />
        </Suspense>

      {entityTab === 'profile' && onDeleteClient && selectedClient && !deleteConfirmOpen && (
        <div style={{ marginTop: 48, paddingTop: 16, borderTop: `1px solid ${D.ruleSoft}`, textAlign: 'center' }}>
          <button
            type="button"
            onClick={() => setDeleteConfirmOpen(true)}
            style={{ background: 'none', border: 'none', color: D.inkMute, fontSize: 12, cursor: 'pointer', fontFamily: D.ui, padding: 0, transition: 'color 0.12s' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = D.alert; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = D.inkMute; }}
          >
            {intl.formatMessage({ id: 'firm.delete.action' })}
          </button>
        </div>
      )}
      </div>
      </div>
      </div>
      <ArtifactPanel artifact={artifact} setArtifact={setArtifact} onSuggestTransactionCoding={onSuggestTransactionCoding} onApplyLifecycle={emitFeedApplyLifecycle} dock={dockNode} dockOpen={dockOpen} />
      {dockCanShare && dockPill}
      <ToastHost />
    </section>
  );
};

// ── Empty firm state ────────────────────────────────────────────────────────
//
// Rendered when the firm has zero ventures. Replaces the orphaned tab strip
// (header gated on selectedClient, panels each return null when clientId is
// missing) with a single welcoming card. One primary CTA — "Add venture" —
// matches the rail's same call so the operator has two equally obvious doors
// in, not one. Keep it quiet: no marketing, no Xero, no lifecycle language.

const EmptyFirmState = ({ onAddVenture }) => {
  const intl = useIntl();
  return (
  <section
    className="firm-console firm-console--empty"
    aria-label={intl.formatMessage({ id: 'firm.empty.aria' })}
    style={{
      background: D.paper,
      // 100% of the workspace PANEL, not 100vh — the panel is inset from the
      // window by the shell gutters (panels-on-ground, 2026-08-05) and 100vh
      // here forced a permanent gutter-height scroll.
      minHeight: '100%',
      fontFamily: D.ui,
      color: D.ink,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '48px 24px'
    }}
  >
    <div
      style={{
        maxWidth: 520,
        width: '100%',
        background: D.card,
        border: `1px solid ${D.rule}`,
        borderRadius: 16,
        padding: '40px 36px',
        textAlign: 'center'
      }}
    >
      {/* Quiet dashed glyph — reads as "open envelope" not a marketing image */}
      <div
        aria-hidden="true"
        style={{
          width: 64,
          height: 64,
          margin: '0 auto 22px',
          borderRadius: 12,
          border: `1.5px dashed ${D.rule}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: D.inkMute,
          fontFamily: D.ui,
          fontSize: 28,
          fontWeight: 300,
          lineHeight: 1
        }}
      >
        +
      </div>
      {/* The mono eyebrow is gone with the entity masthead's (2026-08-08):
          the headline below already says what this screen is. */}
      <h1
        style={{
          fontFamily: D.ui,
          fontWeight: 600,
          fontSize: 22,
          letterSpacing: '-0.01em',
          color: D.ink,
          margin: '0 0 10px',
          lineHeight: 1.15
        }}
      >
        {intl.formatMessage({ id: 'firm.empty.title' })}
      </h1>
      <p
        style={{
          margin: '0 auto 24px',
          maxWidth: 420,
          fontSize: 13.5,
          color: D.inkMute,
          lineHeight: 1.6
        }}
      >
        {intl.formatMessage({ id: 'firm.empty.body' })}
      </p>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          type="button"
          onClick={onAddVenture}
          disabled={!onAddVenture}
          style={{
            font: 'inherit',
            fontSize: 13.5,
            fontWeight: 500,
            padding: '10px 18px',
            borderRadius: 999,
            border: 'none',
            background: D.ink,
            color: D.paper,
            cursor: onAddVenture ? 'pointer' : 'not-allowed',
            opacity: onAddVenture ? 1 : 0.6
          }}
        >
          {intl.formatMessage({ id: 'firm.empty.add' })}
        </button>
        <span
          style={{
            fontSize: 13,
            color: D.inkMute
          }}
        >
          {intl.formatMessage({ id: 'firm.empty.tip' })}
        </span>
      </div>
    </div>
  </section>
  );
};

export default FirmOpsConsole;
