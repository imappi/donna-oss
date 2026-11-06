import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import FirmOpsConsole from './components/FirmOpsConsole.jsx';
import FirmSidebar from './components/FirmSidebar.jsx';
import TeamPanel from './components/TeamPanel.jsx';
import FeedbackModal from './components/FeedbackModal.jsx';
import FirmDropOverlay from './components/FirmDropOverlay.jsx';
import FirmNewEntity from './components/FirmNewEntity.jsx';
import FirmAuthGate from './components/FirmAuthGate.jsx';
import DonnaLanding from './components/marketing/DonnaLanding.jsx';
import WorkspaceProvisioner from './components/WorkspaceProvisioner.jsx';
import OAuthConsentPage, { isOAuthConsentPath } from './components/OAuthConsentPage.jsx';
import MarketingPage, { resolveMarketingPageKey } from './components/marketing/MarketingPage.jsx';
import MarketingDrafts from './components/marketing/MarketingDrafts.jsx';
import CloudPilotReadinessCard from './components/settings/CloudPilotReadinessCard.jsx';
import OperatorProviderFailures from './components/financials/OperatorProviderFailures.jsx';
// Donna redesign — UI-first port of the Client Portal HTML mock. (The legacy
// components/ClientPortal.jsx ghost — mounted nowhere, the last caller of the
// deleted /documents/sync and /bank-statement/extract routes — was removed
// in RT-14.)
import ClientPortal from './components/donna-client-portal.jsx';
import ClientPortalGate from './components/ClientPortalGate.jsx';
import { FirmShellNavControls } from './components/DesktopTitlebar.jsx';
import UploadTray from './components/UploadTray.jsx';
import SettingsSidebar from './components/settings/SettingsSidebar.jsx';
import SettingsPanel from './components/settings/SettingsPanel.jsx';
import { STORAGE_KEYS } from './lib/constants.js';
import { loadFromStorage, removeFromStorage, saveToStorage, readStoredValue } from './lib/storage.js';
import { firmClientProfiles, firmMockHistory, firmMockQueue, mockQueue, mockHistory } from './lib/mockData.js';
import { DOCUMENT_QUEUE_SOURCE, buildDocumentQueueItems } from './lib/firmDocuments.js';
import { clearTrayForClient } from './lib/uploadTray.js';
import {
  archiveFirmClient,
  batchSuggestFirmTransactionCoding,
  coerceErrorMessage,
  createFirmClient,
  fetchFirmFeed,
  fetchFirmSnapshot,
  refreshFirmTransactionIntel,
  suggestFirmTransactionCoding,
  updateFirmAutoSendSetting,
  updateFirmClientRule,
  createFirmManualLink,
  deleteFirmDocument,
  updateFirmDocument,
  updateFirmReconciliationMatch,
  updateFirmTransactionReviewItem,
  updateFirmTransaction
} from './lib/firmApi.js';
import { clearFirmAccess, getAuthSession, getAuthSessionRevision, hasStoredAuth, isAccessRequiredError, saveAccessToken } from './lib/accessToken.js';
import { hasDesktopRuntimeAccess, isDesktopShell, resolveFirmSnapshotOutcome, resolveFirstRunRequired } from './lib/desktopShell.js';
import { getBookSessionIdentity } from './lib/bookSessionIdentity.js';
import DesktopBooksUnreachable from './components/DesktopBooksUnreachable.jsx';
import WebBooksUnavailable from './components/WebBooksUnavailable.jsx';
import FirstRunOnboarding from './components/FirstRunOnboarding.jsx';
import { createDocumentDeleteQueue } from './lib/documentDeleteQueue.js';
import { rememberOwnerClientId } from './lib/ownerPersona.js';
import { clearPendingOffer } from './lib/pendingOffer.js';
import { clearConfirmEmail } from './lib/pendingConfirm.js';
import {
  consumeOAuthRedirect,
  hydrateAuthUser,
  refreshAuthSession,
  signInWithPassword,
  signUp,
  startGoogleSignIn
} from './lib/supabaseAuth.js';
import { readPendingOffer } from './lib/pendingOffer.js';
import { D } from './components/shared/design-tokens.js';
import { emitToast } from './lib/toastBus.js';
import {
  isLocaleSettingsPreview,
  isLocaleShellPreview,
  isLocaleMountedPreview,
  isLocaleWorkspacePreview
} from './i18n/localeRegistry.js';
import { useInterfaceLocale } from './i18n/LocaleProvider.jsx';
import { INTERFACE_CATALOG_VERSION } from './i18n/localeCatalog.js';

import './styles.css';


const FIRM_STORAGE_KEYS = {
  clients: 'donna.firms.created_clients.v1',
  deletedClientIds: 'donna.firms.deleted_client_ids.v1',
  documents: 'donna.firms.documents.v1',
  transactions: 'donna.firms.transactions.v1',
  accountingRules: 'donna.firms.accounting_rules.v1',
  queue: 'donna.firms.queue.v8',
  history: 'donna.firms.history.v8',
  // Outbound firm-to-client messages. Kept separate from `history` because
  // BE snapshots (applyFirmSnapshotState) overwrite history with the
  // server's view, which doesn't yet store these client-facing messages.
  // Splitting them out means snapshots leave them alone.
  messages: 'donna.firms.messages.v1'
};
const FIRM_DEMO_VERSION_KEY = 'donna.firms.demo_seed_version';
const FIRM_DEMO_VERSION = 'donna-review-questions-v1';
const FIRM_LEGACY_STORAGE_KEYS = [
  'donna.firms.queue',
  'donna.firms.history',
  'donna.firms.queue.v4',
  'donna.firms.history.v4',
  'donna.firms.queue.v5',
  'donna.firms.history.v5',
  'donna.firms.queue.v6',
  'donna.firms.history.v6',
  'donna.firms.queue.v7',
  'donna.firms.history.v7',
  'donna.firms.accountantDesk.v1'
];
const DEFAULT_DONNA_ROUTE = '/firms';

// The public marketing landing now owns '/'. Signed-out visitors stay on '/'
// (App renders <DonnaLanding/> below); only visitors who already have a stored
// session are bounced straight into the app, preserving the old "land in the
// workspace" behavior for people who are signed in. hasStoredAuth() is the
// same synchronous signal the firm auth gate trusts on refresh.
//
// Route authenticated root visits to the snapshot gate. The server's current
// workspace scope decides owner versus member; an old device-local owner hint
// must not select a different account's destination.
const normalizeDefaultDonnaRoute = () => {
  if (typeof window === 'undefined') return;
  // Standalone locale review screens own the root route in development.
  // Importing App must not erase their query string before main.jsx chooses
  // which tree to mount.
  if (isLocaleSettingsPreview() || isLocaleShellPreview() || isLocaleWorkspacePreview() || isLocaleMountedPreview()) return;
  if (!hasStoredAuth()) return;
  const path = window.location.pathname;
  // Member persona (or not-yet-provisioned): legacy default — only the bare root
  // is redirected into the firm console.
  if (path !== '/') return;
  window.history.replaceState(null, '', DEFAULT_DONNA_ROUTE);
};

normalizeDefaultDonnaRoute();

const getCurrentPath = () =>
  typeof window === 'undefined' ? '' : window.location.pathname.toLowerCase();
const usesFirmDataMode = () => {
  const path = getCurrentPath();
  return path.startsWith('/firms') || path.startsWith('/client') || path.startsWith('/portal');
};
// '/' is the public marketing landing for signed-out visitors — signed-in
// visitors are redirected to /firms by normalizeDefaultDonnaRoute above, so by
// the time the tree renders a '/' path means "show the landing". '/welcome' is
// the ALWAYS-landing path: it is never auth-redirected, so signed-in users
// (and marketing domains) have a stable URL that always shows the page.
const isLandingRoute = () => {
  const path = getCurrentPath();
  return (
    path === '' ||
    path === '/' ||
    path === '/welcome' ||
    path === '/welcome/' ||
    // /onboarding is a never-redirected deep-link into the signup + checkout
    // screen of the landing funnel (DonnaLanding reads the path and opens on
    // the detail view). One-click access for testing/feedback.
    path === '/onboarding' ||
    path === '/onboarding/' ||
    // /reset-password is where a GoTrue recovery link lands (DonnaLanding shows
    // the set-new-password form from the recovery session, or an "expired link"
    // message). Owned by the marketing funnel, never auth-redirected.
    path === '/reset-password' ||
    path === '/reset-password/'
  );
};
// /fi is the public Finnish landing (invite-only pilot; DonnaLandingFi). Public
// and never auth-redirected (normalizeDefaultDonnaRoute only touches '/' and
// /firms), so a signed-out visitor sees the page and a signed-in one is not
// bounced away from it.
const isFinlandLandingRoute = () => {
  const path = getCurrentPath().toLowerCase();
  return path === '/fi' || path === '/fi/';
};
// /start is the signup funnel's post-auth landing: an authenticated OWNER is
// provisioned a client workspace here, then forwarded to /client/:id. It is
// deliberately NOT a firmDataMode path (owners aren't firm members, so the firm
// console would 401 them) and never auth-redirected.
const isWorkspaceStartRoute = () => {
  const path = getCurrentPath();
  return path === '/start' || path === '/start/';
};
// /oauth/consent is where Supabase's OAuth 2.1 server sends an owner so a chat
// app (ChatGPT app / Claude connector) can be allowed or declined
// (docs/design-donna-chatgpt-app-build-brief.md §4.2). Owner-journey page, not
// firmDataMode, never auth-redirected: it hosts its own sign-in when needed and
// the Google leg lands back on this exact path with ?authorization_id intact.
const isOAuthConsentRoute = () => isOAuthConsentPath(getCurrentPath());
// Public marketing info/legal routes (/faq /terms /privacy /security). These
// are signed-out, app-shell-free pages backing the landing footer links.
const getMarketingPageKey = () =>
  typeof window === 'undefined' ? null : resolveMarketingPageKey(window.location.pathname);

const getInitialTab = () => 'queue';
const isFirmMode = () => getCurrentPath().startsWith('/firms');
const getFirmRouteParams = () => {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  return {
    entityId: params.get('entity') || null,
    entityTab: params.get('tab') || null
  };
};
// The marketing landing deep-links the auth gate via ?auth=signup|signin and an
// optional ?email=… prefill, so "Get started" lands on Create account and
// "Sign in" on Sign in, carrying any email the visitor typed on the page.
const getFirmAuthIntent = () => {
  if (typeof window === 'undefined') return { initialMode: null, initialEmail: '' };
  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  return {
    initialMode: auth === 'signup' ? 'signup' : auth === 'signin' ? 'signin' : null,
    initialEmail: params.get('email') || ''
  };
};
const isClientPortalMode = () => {
  const path = getCurrentPath();
  return path.startsWith('/client') || path.startsWith('/portal');
};
const getClientPortalEntityId = () => {
  if (typeof window === 'undefined') return null;
  const [, route, entityId] = window.location.pathname.split('/');
  if (route?.toLowerCase() !== 'client' && route?.toLowerCase() !== 'portal') return null;
  return entityId ? decodeURIComponent(entityId) : null;
};
const getInitialFirmLane = () =>
  getCurrentPath().startsWith('/firms/accountant') || getCurrentPath().startsWith('/firms/compliance')
    ? 'expert_review'
    : 'all';
const firmClientSeeds = firmClientProfiles;
const firmQueueSeed = firmMockQueue;
const firmHistorySeed = firmMockHistory;
const applyDonnaTokens = () => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const vars = {
    // Surface-level CSS variables resolve to the D palette (paper + ink +
    // warm) as of the 2026-07-28 design alignment. This map is the ONLY
    // bridge between the token module and the 5,546-line legacy styles.css:
    // .firm-shell, .firm-console, body, and every rule referencing var(--bg) /
    // var(--text) / var(--red) is *laid out* by that stylesheet but *coloured*
    // from here. Retargeting these ~24 values re-grounds the whole legacy CSS
    // layer without rewriting a single rule — which is why the palette
    // migration does not need a CSS rewrite to stop looking half-done.
    //
    // Semantic mapping, not a mechanical swap. D has no green, amber, or
    // blue, so the status hues collapse the same way StatusChip's do:
    // settled/positive reads as INK, attention as the WARM accent, genuine
    // failure as D.alert. --blue was V.intel (client-bound traffic), which is
    // information rather than alarm, so it lands on ink too.
    '--bg': D.paper,
    // Off-white page, PURE WHITE containers, so cards pop off the ground
    // rather than being merely outlined on it (Kari, 2026-07-28). An earlier
    // pass set these equal and separated by rule only — that was wrong.
    '--bg-card': D.card,
    '--bg-muted': D.paperDeep,
    '--surface-hover': D.ruleSoft,
    '--border': D.rule,
    '--border-light': D.ruleSoft,
    '--borderSubtle': D.ruleSoft,
    '--text': D.ink,
    '--text-secondary': D.inkSoft,
    '--text-muted': D.inkMute,
    '--text-tertiary': D.inkMute,
    '--accent-hover': D.accentWarmFlat,
    '--green': D.ink,
    '--green-bg': D.ruleSoft,
    '--amber': D.accentWarmFlat,
    '--amber-bg': D.accentWash,
    '--red': D.alert,
    '--red-bg': D.alertWash,
    '--blue': D.inkSoft,
    '--blue-bg': D.ruleSoft,
    // Panels-on-ground shell (Kari, 2026-08-05): the window ground is the
    // whisper-sunset gradient + grain, the workspace floats on it as a
    // rounded paper panel. Values live in design-tokens.js (D.ground*);
    // styles.css carries byte-synced fallbacks so there is no flash before
    // this bridge runs.
    '--shell-ground-color': D.groundColor,
    '--shell-ground-image': D.groundImage,
    '--shell-ground-size': D.groundSize,
    '--shell-ground-repeat': D.groundRepeat,
    '--shell-gutter': D.shellGutter,
    '--panel-radius': D.panelRadius,
    '--panel-shadow': D.panelShadow
  };
  Object.entries(vars).forEach(([key, value]) => root.style.setProperty(key, value));
};
const getInitialFirmClientId = () => getFirmRouteParams().entityId || null;
const getInitialFirmHomeSelected = () => {
  const { entityId } = getFirmRouteParams();
  return !entityId;
};
const getInitialFirmEntityTab = () => {
  const tab = getFirmRouteParams().entityTab;
  return ['actions', 'profile', 'people', 'compliance', 'close', 'accounting', 'documents'].includes(tab)
    ? tab
    : 'actions';
};
const getInitialQueue = () =>
  usesFirmDataMode() ? [] : loadFromStorage(STORAGE_KEYS.queue, mockQueue);
const getInitialHistory = () =>
  usesFirmDataMode() ? [] : loadFromStorage(STORAGE_KEYS.history, mockHistory);
const getInitialCreatedFirmClients = () => {
  if (usesFirmDataMode()) return [];
  const stored = loadFromStorage(FIRM_STORAGE_KEYS.clients, []);
  return Array.isArray(stored) ? stored : [];
};
const getInitialDeletedFirmClientIds = () => {
  if (usesFirmDataMode()) return [];
  const stored = loadFromStorage(FIRM_STORAGE_KEYS.deletedClientIds, []);
  return Array.isArray(stored) ? stored : [];
};
const getInitialFirmDocuments = () => {
  if (usesFirmDataMode()) return [];
  const stored = loadFromStorage(FIRM_STORAGE_KEYS.documents, []);
  return Array.isArray(stored) ? stored : [];
};
const getInitialFirmTransactions = () => {
  if (usesFirmDataMode()) return [];
  const stored = loadFromStorage(FIRM_STORAGE_KEYS.transactions, []);
  return Array.isArray(stored) ? stored : [];
};
const getInitialFirmAccountingRules = () => {
  if (usesFirmDataMode()) return [];
  const stored = loadFromStorage(FIRM_STORAGE_KEYS.accountingRules, []);
  return Array.isArray(stored) ? stored : [];
};
const cloneDemoData = (items) =>
  items.map((item) =>
    typeof structuredClone === 'function'
      ? structuredClone(item)
      : JSON.parse(JSON.stringify(item))
  );

const applyFirmSnapshotState = (snapshot, setters = {}) => {
  setters.setFirmDataSource?.('database');
  setters.setCreatedFirmClients?.(Array.isArray(snapshot.clients) ? snapshot.clients : []);
  setters.setDeletedFirmClientIds?.([]);
  setters.setQueue?.(Array.isArray(snapshot.queue) ? snapshot.queue : []);
  setters.setHistory?.(Array.isArray(snapshot.history) ? snapshot.history : []);
  setters.setFirmDocuments?.(Array.isArray(snapshot.documents) ? snapshot.documents : []);
  setters.setFirmTransactions?.(Array.isArray(snapshot.transactions) ? snapshot.transactions : []);
  setters.setFirmAccountingRules?.(Array.isArray(snapshot.accountingRules) ? snapshot.accountingRules : []);
  setters.setFirmReconciliationMatches?.(Array.isArray(snapshot.reconciliationMatches) ? snapshot.reconciliationMatches : []);
  setters.setFirmClientRules?.(Array.isArray(snapshot.clientRules) ? snapshot.clientRules : []);
  setters.setFirmTransactionReviewQueue?.(Array.isArray(snapshot.transactionReviewQueue) ? snapshot.transactionReviewQueue : []);
  setters.setFirmClientEvidenceRequests?.(Array.isArray(snapshot.clientEvidenceRequests) ? snapshot.clientEvidenceRequests : []);
  // Donna ledger read-side state — accounts, journals, lines, and the
  // close-archive index. The audit/correction workbench and the Close
  // archive card derive their views from these snapshots.
  setters.setFirmLedgerAccounts?.(Array.isArray(snapshot.ledgerAccounts) ? snapshot.ledgerAccounts : []);
  setters.setFirmLedgerJournals?.(Array.isArray(snapshot.ledgerJournals) ? snapshot.ledgerJournals : []);
  setters.setFirmLedgerLines?.(Array.isArray(snapshot.ledgerLines) ? snapshot.ledgerLines : []);
  setters.setFirmCloseArchives?.(Array.isArray(snapshot.closeArchives) ? snapshot.closeArchives : []);
  setters.setFirmClosePeriods?.(Array.isArray(snapshot.closePeriods) ? snapshot.closePeriods : []);
  setters.setFirmRecentUploadBatches?.(Array.isArray(snapshot.recentUploadBatches) ? snapshot.recentUploadBatches : []);
  setters.setFirmTransactionAiBatch?.(snapshot.transaction_ai_batch || null);
};

// Initial-mount loading screen used when a stored session is present.
// Reuses the firm-access shell so the page doesn't visually shift if
// the session turns out to be dead (the sign-in form lands in the same
// frame). Intentionally minimal — no inputs, no spinner-mongering.
const FirmAccessRestoring = () => {
  const intl = useIntl();
  return (
  <div
    aria-busy="true"
    style={{
      minHeight: '100vh',
      backgroundColor: D.paper,
      color: D.ink,
      fontFamily: D.body,
      WebkitFontSmoothing: 'antialiased',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'clamp(1.5rem, 5vw, 3rem)'
    }}
  >
    {/* Scoped keyframe — safe, does not touch global CSS. */}
    <style>{`@keyframes donnaRestorePulse{0%,100%{opacity:.22;transform:translateY(0)}50%{opacity:.9;transform:translateY(-1px)}}`}</style>
    <main style={{ width: '100%', maxWidth: 380, textAlign: 'center' }}>
      {/* Brand anchor — the Donna wordmark, centered. */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', marginBottom: '1.6rem' }}>
        <span style={{
          fontFamily: D.display,
          fontWeight: 400,
          letterSpacing: '0.03em',
          lineHeight: 1,
          textTransform: 'uppercase',
          fontSize: 'clamp(22px, 2.4vw, 27px)',
          color: D.ink
        }}>Donna</span>
      </div>
      <h1 style={{
        fontFamily: "'Instrument Serif', 'Source Serif 4', Georgia, serif",
        fontWeight: 400,
        fontSize: 'clamp(1.6rem, 3vw, 2.1rem)',
        lineHeight: 1.1,
        letterSpacing: '-0.01em',
        margin: '0 0 0.6rem'
      }}>{intl.formatMessage({ id: 'shell.client.loading' })}</h1>
      <p style={{
        fontFamily: D.body,
        fontSize: '0.95rem',
        lineHeight: 1.5,
        color: D.inkSoft,
        margin: '0 0 1.5rem'
      }}>{intl.formatMessage({ id: 'shell.restoring.body' })}</p>
      {/* Subtle activity indicator. */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 6 }} aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              backgroundColor: D.ink,
              animation: `donnaRestorePulse 1.2s ease-in-out ${i * 0.16}s infinite`
            }}
          />
        ))}
      </div>
    </main>
  </div>
  );
};

// Client-portal equivalent of the firm restoring/lock screen. An owner is a
// client, not a firm member, so the "Donna firm access / verify your sign-in"
// copy is the wrong persona on a /client route — it's what flashed before the
// portal loaded. It must also wear the right CANVAS: this loader sits in the
// signup funnel between WorkspaceProvisioner ("Setting up your workspace…") and
// the portal, both of which use the D (dossier) palette. Rendering it on the old
// `.firm-access` oatmeal canvas made an old-styled screen flash between the new
// branded loaders — so it mirrors the WorkspaceProvisioner loader exactly (D.paper
// shell, small mono caps) for a continuous transition.
const ClientPortalRestoring = () => {
  const intl = useIntl();
  return (
  <div
    aria-busy="true"
    style={{
      minHeight: '100vh',
      backgroundColor: D.paper,
      color: D.ink,
      fontFamily: D.body,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'clamp(1.5rem, 5vw, 3rem)'
    }}
  >
    <main style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
      <div
        style={{
          fontFamily: D.mono,
          fontSize: 11,
          letterSpacing: D.tracking.mono,
          textTransform: 'uppercase',
          color: D.inkSoft
        }}
      >
        {intl.formatMessage({ id: 'shell.client.loading' })}
      </div>
    </main>
  </div>
  );
};

// No valid session on a /client route → send the owner to the funnel's sign-in
// door (which, after auth, routes back through /start → their own workspace),
// never the firm console auth gate.
const ClientPortalSignInRedirect = () => {
  useEffect(() => {
    window.location.replace('/?auth=signin');
  }, []);
  return <ClientPortalRestoring />;
};

// ── Storage helpers ────────────────────────────────────────────────────────────

// ── App ────────────────────────────────────────────────────────────────────────

const AppSession = ({ oauthRedirect }) => {
  const intl = useIntl();
  const { locale: interfaceLocale, direction: interfaceDirection } = useInterfaceLocale();
  const interfaceMessageRef = useRef(intl.formatMessage);
  interfaceMessageRef.current = intl.formatMessage;
  const [queue, setQueue] = useState(getInitialQueue);
  const [history, setHistory] = useState(getInitialHistory);
  // Legacy demo messages are never read into a real-book session.
  const [firmMessages, setFirmMessages] = useState(() => {
    if (usesFirmDataMode()) return [];
    const stored = loadFromStorage(FIRM_STORAGE_KEYS.messages, []);
    return Array.isArray(stored) ? stored : [];
  });
  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [firmHomeSelected, setFirmHomeSelected] = useState(getInitialFirmHomeSelected);
  const [createdFirmClients, setCreatedFirmClients] = useState(getInitialCreatedFirmClients);
  const [deletedFirmClientIds, setDeletedFirmClientIds] = useState(getInitialDeletedFirmClientIds);
  const [firmDocuments, setFirmDocuments] = useState(getInitialFirmDocuments);
  const [firmTransactions, setFirmTransactions] = useState(getInitialFirmTransactions);
  const [firmAccountingRules, setFirmAccountingRules] = useState(getInitialFirmAccountingRules);
  const [firmReconciliationMatches, setFirmReconciliationMatches] = useState([]);
  const [firmClientRules, setFirmClientRules] = useState([]);
  const [firmTransactionReviewQueue, setFirmTransactionReviewQueue] = useState([]);
  const [firmClientEvidenceRequests, setFirmClientEvidenceRequests] = useState([]);
  // Inbox feed — the bucketed cross-venture worklist from /firms/feed.
  // Refreshed after every database snapshot application (the tick), so the
  // sidebar counts and the Inbox rows track the same mutations the
  // workspace surfaces just applied. null = not loaded (mock mode, or the
  // first fetch is still in flight).
  const [firmFeed, setFirmFeed] = useState(null);
  const [firmFeedTick, setFirmFeedTick] = useState(0);
  const [firmTransactionAiBatch, setFirmTransactionAiBatch] = useState(null);
  // Donna ledger read-model — sourced from /firms/snapshot. The audit
  // workbench reads journals + lines from here; the Close archive card
  // reads the close_archives index. None of these are persisted to local
  // storage — the snapshot is always the source of truth.
  const [firmLedgerAccounts, setFirmLedgerAccounts] = useState([]);
  const [firmLedgerJournals, setFirmLedgerJournals] = useState([]);
  const [firmLedgerLines, setFirmLedgerLines] = useState([]);
  const [firmCloseArchives, setFirmCloseArchives] = useState([]);
  const [firmClosePeriods, setFirmClosePeriods] = useState([]);
  const [firmRecentUploadBatches, setFirmRecentUploadBatches] = useState([]);
  // The firm row from the active database snapshot (snapshot.firm) — the real
  // firm scope for firm-scoped reads/writes (e.g. the Facts panel's firm_facts
  // list/dismiss, which otherwise fall back to the backend DEFAULT_FIRM_ID and
  // miss rows under the real firm). Null in local/demo mode (no backend firm).
  const [firmRecord, setFirmRecord] = useState(null);
  // Gate 3 — true only after a DATABASE snapshot applied with no firm row on
  // the desktop shell (a virgin appliance). Never inferred from absence of
  // data before a snapshot lands (render-the-persisted-verdict).
  const [firstRunRequired, setFirstRunRequired] = useState(false);
  const [selectedFirmClientId, setSelectedFirmClientId] = useState(getInitialFirmClientId);
  // Workspace entity-tab is hoisted here so the URL sync below has a
  // single source of truth. FirmOpsConsole used to own this locally
  // and write URL from a render-time closure, which raced against
  // initialEntityTab being recomputed from the just-rewritten URL on
  // the next render. See #218.
  const [firmEntityTab, setFirmEntityTab] = useState(getInitialFirmEntityTab);
  // The rail collapse (the titlebar band's panel toggle — Kari's 2026-08-05
  // sidebar pass), persisted like the dock's donna_dock_open.
  const [firmRailCollapsed, setFirmRailCollapsed] = useState(() => {
    try { return window.localStorage.getItem('donna_rail_collapsed') === '1'; } catch { return false; }
  });
  const setFirmRailCollapsedPersist = (next) => {
    setFirmRailCollapsed(next);
    try { window.localStorage.setItem('donna_rail_collapsed', next ? '1' : '0'); } catch { /* private mode */ }
  };
  // The Feedback modal (the sidebar's "tell the maker" entry, 2026-08-05).
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Which Settings section is open — the settings rail (firm shell) swaps in
  // for the venture rail while activeTab === 'settings'.
  const [settingsSection, setSettingsSection] = useState('profile');
  // A workbook dropped onto a venture belongs to the separate Import data
  // preview, not evidence upload. This transient handoff carries the browser
  // File only until the mounted Settings card has started its inspection.
  const [accountingImportRequest, setAccountingImportRequest] = useState(null);
  // In-app view history for the titlebar back/forward arrows. The SPA syncs
  // its URL with replaceState ONLY (no pushed entries), so window.history has
  // nothing to navigate — the stack of view snapshots lives here instead.
  // A ref (not state) because recording must not re-render; navVersion bumps
  // when the position changes so canBack/canForward stay reactive.
  const firmNavRef = useRef({ stack: [], index: -1 });
  const firmNavApplyingRef = useRef(false);
  const [, setFirmNavVersion] = useState(0);
  useEffect(() => {
    if (!isFirmMode()) return;
    const entry = {
      home: firmHomeSelected,
      clientId: selectedFirmClientId,
      tab: activeTab,
      entityTab: firmEntityTab
    };
    const nav = firmNavRef.current;
    if (firmNavApplyingRef.current) {
      // This change IS a back/forward application — don't re-record it.
      firmNavApplyingRef.current = false;
      return;
    }
    const top = nav.stack[nav.index];
    if (top && top.home === entry.home && top.clientId === entry.clientId
      && top.tab === entry.tab && top.entityTab === entry.entityTab) return;
    // A fresh navigation truncates the forward tail, like a browser.
    nav.stack = nav.stack.slice(0, nav.index + 1).concat([entry]).slice(-100);
    nav.index = nav.stack.length - 1;
    setFirmNavVersion((v) => v + 1);
  }, [firmHomeSelected, selectedFirmClientId, activeTab, firmEntityTab]);
  const applyFirmNavEntry = (entry) => {
    firmNavApplyingRef.current = true;
    setFirmHomeSelected(entry.home);
    setSelectedFirmClientId(entry.clientId);
    setActiveTab(entry.tab);
    setFirmEntityTab(entry.entityTab);
  };
  const firmNavBack = () => {
    const nav = firmNavRef.current;
    if (nav.index <= 0) return;
    nav.index -= 1;
    applyFirmNavEntry(nav.stack[nav.index]);
    setFirmNavVersion((v) => v + 1);
  };
  const firmNavForward = () => {
    const nav = firmNavRef.current;
    if (nav.index >= nav.stack.length - 1) return;
    nav.index += 1;
    applyFirmNavEntry(nav.stack[nav.index]);
    setFirmNavVersion((v) => v + 1);
  };
  const [firmDataSource, setFirmDataSource] = useState(() => usesFirmDataMode() ? 'unavailable' : 'local');
  // Three states gate the firm shell:
  //   - 'ready'     — snapshot fetched, app can render
  //   - 'checking'  — user just submitted the form, show disabled inputs
  //   - 'restoring' — initial mount, stored session present, render the
  //                   minimal loading screen (NOT the sign-in form) while
  //                   we verify against the server. Prevents the form
  //                   from flashing on every refresh.
  //   - 'locked'    — no session, or refresh failed; show the form
  const [firmAccessStatus, setFirmAccessStatus] = useState(() => {
    if (!usesFirmDataMode()) return 'ready';
    // Desktop shell: credentials are injected by the main process's proxy
    // (never present in the renderer), so there is nothing stored to check —
    // go verify against the server like a stored session would.
    return hasStoredAuth() || hasDesktopRuntimeAccess() ? 'restoring' : 'locked';
  });
  const [firmAccessError, setFirmAccessError] = useState(() =>
    usesFirmDataMode() && oauthRedirect?.error
      ? interfaceMessageRef.current({ id: 'auth.error.googleReason' }, { reason: oauthRedirect.error })
      : ''
  );
  // Distinct from firmAccessError: the user authenticated successfully but their
  // email isn't attached to a workspace yet. During the open-signup beta there
  // is no self-provisioning, so this is an honest "we'll set you up" state with
  // a contact CTA — NOT a red "session expired" / "ask your admin" error.
  const [firmNoWorkspace, setFirmNoWorkspace] = useState(false);
  const [firmAccessRetryKey, setFirmAccessRetryKey] = useState(0);
  // Distinguishes "auth just succeeded at GoTrue but the API rejected the
  // email" (new signup / OAuth account not yet granted access) from a
  // genuinely expired stored session, so the lock message doesn't read
  // "session expired" to someone who signed in two seconds ago.
  const authJustEstablishedRef = useRef(Boolean(oauthRedirect?.session));
  // One-shot: keeps the boot-time OAuth error from being clobbered by the
  // credential-less snapshot fetch 401ing on mount.
  const oauthBootErrorRef = useRef(oauthRedirect?.error || '');

  const firmMode = isFirmMode();
  const clientPortalMode = isClientPortalMode();
  const landingMode = isLandingRoute();
  const finlandLandingMode = isFinlandLandingRoute();
  // Resilience for the signup funnel's OAuth leg. GoTrue redirects a successful
  // Google sign-in to its allow-listed match of `redirect_to`, and SILENTLY
  // falls back to the Site URL (the bare landing) when `<origin>/start` isn't in
  // Supabase Auth → Redirect URLs. That strands an authenticated owner — session
  // captured, offer stashed — on the funnel instead of advancing to provision →
  // Checkout (the exact "OAuth bounced me to the landing page" symptom). When we
  // boot having just captured an OAuth session on the bare landing root with a
  // pending offer waiting, forward to /start ourselves so the purchase completes
  // even if the redirect allow-list lags. Keyed on persisted signals (captured
  // session + stashed offer), not an inference; /start is not a landing route, so
  // this can't loop, and the bare-root guard leaves /reset-password + /onboarding
  // (also landingMode) untouched.
  useEffect(() => {
    if (!oauthRedirect?.session) return;
    const path = getCurrentPath();
    const onBareLandingRoot =
      path === '' || path === '/' || path === '/welcome' || path === '/welcome/';
    if (!onBareLandingRoot) return;
    if (!hasStoredAuth()) return;
    if (!readPendingOffer()) return;
    window.location.replace('/start');
  }, [oauthRedirect]);
  const marketingPageKey = getMarketingPageKey();
  const firmDataMode = firmMode || clientPortalMode;
  // Serialized optimistic document deletion (the 2026-07-21 multi-delete
  // bug): rows leave the list on click, one DELETE is in flight at a time,
  // and every incoming snapshot is filtered below so a snapshot built
  // before a pending delete committed cannot resurrect the row. Created
  // once; the applier is reached through a ref because the queue outlives
  // any single render.
  const applyDatabaseSnapshotRef = useRef(null);
  const snapshotGenerationRef = useRef(0);
  const documentDeleteQueueRef = useRef(null);
  if (!documentDeleteQueueRef.current) {
    documentDeleteQueueRef.current = createDocumentDeleteQueue({
      deleteDocument: (documentId) => deleteFirmDocument(documentId),
      applySnapshot: (snapshot) => applyDatabaseSnapshotRef.current?.(snapshot),
      removeDocument: (documentId) => setFirmDocuments((prev) => prev.filter((doc) => doc.id !== documentId)),
      restoreDocument: (documentId, row) => {
        if (!row) return;
        setFirmDocuments((prev) => (prev.some((doc) => doc.id === documentId) ? prev : [row, ...prev]));
      },
      onError: (error, documentId) => {
        const fiscalYear = error?.details?.fiscal_year;
        const retainUntil = error?.details?.retain_until;
        const message = error?.code === 'FINLAND_RETENTION_DOCUMENT_HELD'
          ? `This document belongs to${fiscalYear ? ` fiscal year ${fiscalYear}` : ' a closed fiscal year'} and must be kept${retainUntil ? ` until ${retainUntil}` : ''}. Reopen that fiscal year if the document needs correcting.`
          : coerceErrorMessage(error?.message, 'Could not delete this document. Try again.');
        emitToast({ message, tone: 'neg', durationMs: 8000 });
        console.warn('Document delete failed; the row was restored.', documentId, error);
      }
    });
  }
  const applyDatabaseSnapshot = useCallback((snapshot) => {
    if (resolveFirmSnapshotOutcome({ source: snapshot?.source }) !== 'database') {
      setFirmAccessStatus('unreachable');
      setFirmAccessError('');
      return;
    }
    const deleteQueue = documentDeleteQueueRef.current;
    if (deleteQueue && Array.isArray(snapshot.documents)) {
      snapshot = { ...snapshot, documents: deleteQueue.filterSnapshotDocuments(snapshot.documents) };
    }
    applyFirmSnapshotState(snapshot, {
      setFirmDataSource,
      setCreatedFirmClients,
      setDeletedFirmClientIds,
      setQueue,
      setHistory,
      setFirmDocuments,
      setFirmTransactions,
      setFirmAccountingRules,
      setFirmReconciliationMatches,
      setFirmClientRules,
      setFirmTransactionReviewQueue,
      setFirmClientEvidenceRequests,
      setFirmTransactionAiBatch,
      setFirmLedgerAccounts,
      setFirmLedgerJournals,
      setFirmLedgerLines,
      setFirmCloseArchives,
      setFirmClosePeriods,
      setFirmRecentUploadBatches
    });
    setFirmRecord(snapshot.firm || null);
    // Callers only route database-source snapshots here, but read the source
    // off the payload rather than assert it — a seed snapshot must never
    // read as "virgin book, run onboarding" (the §4b-iii shape).
    setFirstRunRequired(resolveFirstRunRequired({
      desktop: hasDesktopRuntimeAccess(), source: snapshot?.source || null, firm: snapshot.firm || null
    }));
    // Every applied database snapshot re-syncs the Inbox feed (burst
    // applications coalesce through the effect's abort).
    setFirmFeedTick((tick) => tick + 1);
    // Stuck-route guard: when a snapshot lands with zero ventures, drop any
    // stale `?entity=…&tab=…` URL params and force the rail back to the
    // "All ventures" home view so the empty firm-state can take the canvas
    // instead of an orphaned entity workspace.
    const clientCount = Array.isArray(snapshot.clients) ? snapshot.clients.length : 0;
    if (clientCount === 0) {
      setFirmHomeSelected(true);
      setSelectedFirmClientId(null);
      if (typeof window !== 'undefined' && window.location.pathname.toLowerCase().startsWith('/firms')) {
        const url = new URL(window.location.href);
        url.searchParams.delete('entity');
        url.searchParams.delete('tab');
        const next = `${url.pathname}${url.search}${url.hash}`;
        const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (next !== current) window.history.replaceState(null, '', next);
      }
    }
  }, []);
  applyDatabaseSnapshotRef.current = applyDatabaseSnapshot;
  useEffect(() => {
    if (firmFeedTick === 0) return undefined;
    const controller = new AbortController();
    fetchFirmFeed({ signal: controller.signal })
      .then((data) => setFirmFeed(data))
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        // A failed feed refresh keeps the previous feed — the Inbox is a
        // read model; stale beats blank.
      });
    return () => controller.abort();
  }, [firmFeedTick]);
  const admitWorkspaceSnapshot = useCallback((snapshot) => {
    if (!hasDesktopRuntimeAccess() && firmMode) {
      const scope = snapshot.workspaceAccess;
      if (!scope || !['owner', 'firm'].includes(scope.surface)) {
        setFirmAccessStatus('unreachable');
        return false;
      }
      if (scope.surface === 'owner') {
        const allowed = new Set(Array.isArray(scope.clientIds) ? scope.clientIds : []);
        const clients = (snapshot.clients || []).filter((client) => allowed.has(client.id));
        const requested = getFirmRouteParams().entityId;
        const target = clients.find((client) => client.id === requested) || clients[0];
        if (!target) {
          setFirmAccessStatus('unreachable');
          return false;
        }
        setFirmAccessStatus('restoring');
        rememberOwnerClientId(target.id);
        // Navigate before admitting children: no global inbox, Team or Add
        // venture request may start under this client-scoped owner identity.
        window.location.replace(`/client/${encodeURIComponent(target.id)}`);
        return false;
      }
    }
    return true;
  }, [firmMode]);
  const refreshDatabaseSnapshot = useCallback(async () => {
    const generation = snapshotGenerationRef.current;
    const credential = getBookSessionIdentity();
    const controller = new AbortController();
    let active = true;
    const isActive = () => active && generation === snapshotGenerationRef.current;
    const fail = () => {
      if (!isActive() || credential !== getBookSessionIdentity()) return;
      active = false;
      snapshotGenerationRef.current += 1;
      controller.abort();
      setFirmAccessStatus('unreachable');
      setFirmAccessError('');
    };
    const timeout = setTimeout(fail, 20_000);
    try {
      const snapshot = await fetchFirmSnapshot({ signal: controller.signal });
      if (isActive() && credential === getBookSessionIdentity() && admitWorkspaceSnapshot(snapshot)) applyDatabaseSnapshot(snapshot);
    } catch (error) {
      if (!isActive() || (hasStoredAuth() && credential !== getBookSessionIdentity())) return;
      if (isAccessRequiredError(error)) {
        // Re-enter ordinary restore so token refresh and sign-in keep one owner.
        snapshotGenerationRef.current += 1;
        setFirmAccessStatus('restoring');
        setFirmAccessRetryKey((value) => value + 1);
      } else fail();
    } finally {
      active = false;
      clearTimeout(timeout);
    }
  }, [applyDatabaseSnapshot, admitWorkspaceSnapshot]);
  // Persist the firm-level auto-send autonomy toggle, then apply the refreshed
  // snapshot so firmRecord.metadata.loops reflects the new value. Errors bubble to
  // the Settings toggle, which reverts its optimistic state.
  const handleSaveFirmAutoSend = useCallback(async (next) => {
    const snapshot = await updateFirmAutoSendSetting({ autoSendClientAsks: next });
    applyDatabaseSnapshot(snapshot);
    return snapshot;
  }, [applyDatabaseSnapshot]);
  // ⌘,/Ctrl+, opens Settings — the standard desktop accelerator. Firm shell
  // only; the legacy header has its own Settings tab button.
  useEffect(() => {
    if (!firmMode) return undefined;
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setActiveTab('settings');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [firmMode]);
  const firmClients = useMemo(() => {
    if (firmDataSource === 'database') return createdFirmClients;
    if (firmDataMode) return [];

    const deletedIds = new Set(deletedFirmClientIds);
    const createdById = new Map(
      createdFirmClients
        .filter((client) => client?.id)
        .map((client) => [client.id, client])
    );
    const visibleSeeds = firmClientSeeds.filter(
      (client) => !deletedIds.has(client.id) && !createdById.has(client.id)
    );
    return [...visibleSeeds, ...createdById.values()];
  }, [createdFirmClients, deletedFirmClientIds, firmDataSource, firmDataMode]);

  useEffect(() => {
    applyDonnaTokens();
  }, []);

  useEffect(() => {
    if (!firmDataMode) return;
    if (!hasStoredAuth() && !hasDesktopRuntimeAccess()) {
      setFirmAccessStatus('locked');
      return;
    }

    if (firmAccessRetryKey > 0) {
      setFirmAccessStatus((status) => status === 'checking' ? 'checking' : 'restoring');
      setFirmAccessError('');
      setFirmNoWorkspace(false);
    }
    const controller = new AbortController();
    let active = true;
    const generation = ++snapshotGenerationRef.current;
    let requestCredential = getBookSessionIdentity();
    const isActive = () => active && generation === snapshotGenerationRef.current;
    const isCurrent = () => isActive() && requestCredential === getBookSessionIdentity();
    // Bound the entire restore even on browsers without AbortSignal.timeout/any.
    // Invalidate the attempt before aborting so late results cannot admit books.
    const restoreTimeout = setTimeout(() => {
      if (!isActive() || (hasStoredAuth() && !isCurrent())) return;
      active = false;
      controller.abort();
      setFirmAccessStatus(hasStoredAuth() || hasDesktopRuntimeAccess() ? 'unreachable' : 'locked');
      setFirmAccessError('');
    }, 20_000);
    const restoreSignal = controller.signal;
    let refreshAttempted = false;

    const handleSuccess = async (snapshot) => {
      if (!isCurrent()) return;
      authJustEstablishedRef.current = false;
      oauthBootErrorRef.current = '';
      if (resolveFirmSnapshotOutcome({ source: snapshot?.source }) !== 'database') {
        setFirmAccessStatus('unreachable');
        setFirmAccessError('');
        return;
      }

      if (!admitWorkspaceSnapshot(snapshot)) return;

      // (The pre-database "import localStorage financials through
      // /documents/sync" bootstrap was deleted in RT-14 with that route: the
      // database is the only book, and every document enters it as a
      // registered parse run.)
      const nextSnapshot = snapshot;
      applyDatabaseSnapshot(nextSnapshot);
      setFirmAccessStatus('ready');

      const routeClientId = getFirmRouteParams().entityId;
      const nextClientId = routeClientId || nextSnapshot.clients?.[0]?.id || null;
      if (nextClientId) setSelectedFirmClientId(nextClientId);
    };

    const attemptFetch = () => fetchFirmSnapshot({ signal: restoreSignal })
      .then(handleSuccess)
      .catch(async (error) => {
        // A rejected token refresh can clear storage before this catch runs.
        // That is still this attempt's auth failure, not a successful load.
        if (!isActive() || (hasStoredAuth() && !isCurrent()) || error.name === 'AbortError') return;
        // A verified web identity with no membership in this firm: the
        // accounting-firm signup sets up its OWN firm (below), so this is a
        // setup entry, not a dead session — fresh or on a later reload.
        const workspaceDenied = !hasDesktopRuntimeAccess() && hasStoredAuth()
          && error.status === 403 && error.code === 'FIRM_ACCESS_DENIED';
        const freshWorkspaceDenied = authJustEstablishedRef.current && workspaceDenied;
        if (isAccessRequiredError(error) || workspaceDenied) {
          // Desktop: there is no sign-in, no Supabase session to refresh, and
          // no workspace to provision — a 401 through the shell proxy means
          // the runtime rejected the shell's own injected token (a stale
          // second instance, a token mismatch), never an expired user
          // session. The web branches below would render a sign-in form that
          // is a dead end in this shell (observed on the 2026-08-03 launch);
          // render the honest unreachable state instead. Web is unchanged.
          if (hasDesktopRuntimeAccess()) {
            setFirmAccessStatus('unreachable');
            setFirmAccessError(coerceErrorMessage(error?.message, ''));
            console.error('Desktop runtime rejected the shell access token.', error);
            return;
          }
          // Stored Supabase access tokens are short-lived. Before
          // declaring the session dead, try the refresh token once.
          // Successful refresh persists the new access token, so a
          // retry of the snapshot fetch will pick it up via
          // withAccessHeaders.
          // A typed 403 is a definitive answer about membership, not a token
          // problem: never spend the refresh (which clears storage on reject).
          if (!refreshAttempted && !workspaceDenied) {
            refreshAttempted = true;
            const refreshed = await refreshAuthSession().catch(() => null);
            if (!isActive()) return;
            if (refreshed) {
              requestCredential = getBookSessionIdentity();
              return attemptFetch();
            }
          }
          // GoTrue accepted the credentials moments ago (or the firm refused a
          // stored verified identity outright), so this is the API's "verified
          // identity, no workspace/membership yet" answer, not a stale session.
          // On the firm shell that identity sets up its OWN firm workspace
          // through FirstRunOnboarding (web mode) → /self-provision
          // {workspace:'firm'} — explicit input, never a silent membership
          // mint; the bearer stays stored so the setup call can authenticate.
          // Business owners keep their /start funnel; they never land here.
          if (workspaceDenied || (authJustEstablishedRef.current && !oauthBootErrorRef.current)) {
            authJustEstablishedRef.current = false;
            setFirmAccessStatus('locked');
            setFirmNoWorkspace(true);
            setFirmAccessError('');
            return;
          }

          clearFirmAccess();
          setFirmAccessStatus('locked');
          if (oauthBootErrorRef.current) {
            setFirmAccessError(interfaceMessageRef.current(
              { id: 'auth.error.googleReason' },
              { reason: oauthBootErrorRef.current }
            ));
            oauthBootErrorRef.current = '';
          } else {
            setFirmAccessError(interfaceMessageRef.current({ id: 'auth.error.sessionExpired' }));
          }
          authJustEstablishedRef.current = false;
          return;
        }
        authJustEstablishedRef.current = false;
        setFirmAccessStatus('unreachable');
        setFirmAccessError(coerceErrorMessage(error?.message, ''));
      });

    attemptFetch().finally(() => clearTimeout(restoreTimeout));
    return () => {
      active = false;
      clearTimeout(restoreTimeout);
      controller.abort();
    };
  }, [applyDatabaseSnapshot, admitWorkspaceSnapshot, firmAccessRetryKey, firmDataMode]);

  // Persist state
  useEffect(() => {
    if (firmDataMode) return;
    saveToStorage(firmDataMode ? FIRM_STORAGE_KEYS.queue : STORAGE_KEYS.queue, queue);
  }, [firmDataMode, firmDataSource, queue]);
  useEffect(() => {
    if (firmDataMode) return;
    saveToStorage(firmDataMode ? FIRM_STORAGE_KEYS.history : STORAGE_KEYS.history, history);
  }, [firmDataMode, firmDataSource, history]);
  useEffect(() => {
    if (firmDataMode) return;
    saveToStorage(FIRM_STORAGE_KEYS.messages, firmMessages);
  }, [firmMessages, firmDataMode]);
  useEffect(() => {
    if (firmDataMode || firmDataSource === 'database') return;
    saveToStorage(FIRM_STORAGE_KEYS.clients, createdFirmClients);
  }, [createdFirmClients, firmDataSource, firmDataMode]);
  useEffect(() => {
    if (firmDataMode || firmDataSource === 'database') return;
    saveToStorage(FIRM_STORAGE_KEYS.deletedClientIds, deletedFirmClientIds);
  }, [deletedFirmClientIds, firmDataSource, firmDataMode]);
  useEffect(() => {
    if (firmDataMode || firmDataSource === 'database') return;
    saveToStorage(FIRM_STORAGE_KEYS.documents, firmDocuments);
  }, [firmDocuments, firmDataSource, firmDataMode]);
  useEffect(() => {
    if (firmDataMode || firmDataSource === 'database') return;
    saveToStorage(FIRM_STORAGE_KEYS.transactions, firmTransactions);
  }, [firmTransactions, firmDataSource, firmDataMode]);
  useEffect(() => {
    if (firmDataMode || firmDataSource === 'database') return;
    saveToStorage(FIRM_STORAGE_KEYS.accountingRules, firmAccountingRules);
  }, [firmAccountingRules, firmDataSource, firmDataMode]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = finlandLandingMode
      ? 'Donna tekee työt. Sinä johdat.'
      : landingMode
        ? 'Donna — done-for-you books that stay clean'
        : clientPortalMode
          ? intl.formatMessage({ id: 'mounted.app.title.portal' })
          : firmMode
            ? intl.formatMessage({ id: 'mounted.app.title.firm' })
            : 'Donna';
  }, [firmMode, clientPortalMode, landingMode, finlandLandingMode, intl]);
  // Per-route <meta> + <html lang> for the public Finnish landing (/fi). The SPA
  // ships a single static index.html (English, no description); a crawler or a
  // link unfurler on /fi would otherwise see the English lang attribute and a
  // bare "Donna" title. We manage the tags only for /fi and restore the English
  // defaults on any other route, so the root/English path stays byte-identical.
  // Copy mirrors the page's own honest promise: Donna runs the work and asks
  // when the owner's decision is needed; no hidden human reviewer is asserted.
  // ALV/tilinpäätös are NOT asserted here.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const upsertMeta = (selector, attrs) => {
      let el = document.head.querySelector(selector);
      if (!el) {
        el = document.createElement('meta');
        Object.entries(attrs).forEach(([k, v]) => {
          if (k !== 'content') el.setAttribute(k, v);
        });
        el.setAttribute('data-fi-meta', '1');
        document.head.appendChild(el);
      }
      el.setAttribute('content', attrs.content);
      return el;
    };
    if (finlandLandingMode) {
      const desc =
        'Donna on yrityksesi tekoälytyöntekijä. Anna tehtävät WhatsAppissa. Hän ' +
        'hoitaa kirjanpidon, laskutuksen, tarjoukset ja toimittaja-asiat ja kysyy ' +
        'sinulta vain, kun päätöstäsi tarvitaan. ' +
        '29 € / kk + alv.';
      const title = 'Donna tekee työt. Sinä johdat.';
      html.setAttribute('lang', 'fi');
      upsertMeta('meta[name="description"]', { name: 'description', content: desc });
      upsertMeta('meta[property="og:title"]', { property: 'og:title', content: title });
      upsertMeta('meta[property="og:description"]', { property: 'og:description', content: desc });
      upsertMeta('meta[property="og:locale"]', { property: 'og:locale', content: 'fi_FI' });
      return () => {
        // On leaving /fi (client-side nav), restore English defaults and drop
        // the tags we injected so no Finnish metadata leaks onto other routes.
        html.setAttribute('lang', 'en');
        document.head.querySelectorAll('meta[data-fi-meta="1"]').forEach((el) => el.remove());
      };
    }
    return undefined;
  }, [finlandLandingMode]);
  useEffect(() => {
    if (!firmMode) return;
    if (readStoredValue(FIRM_DEMO_VERSION_KEY) === FIRM_DEMO_VERSION) return;
    if (firmDataMode) return;
    saveToStorage(FIRM_DEMO_VERSION_KEY, FIRM_DEMO_VERSION);
  }, [firmDataMode, firmMode]);

  // Firm URL sync. Moved here from FirmOpsConsole so App owns the
  // single source of truth for the entity tab (firmEntityTab). The
  // previous inside-FirmOpsConsole sync wrote URL from a render-time
  // closure of activeEntityTab, which raced against the reset effect
  // that snapped activeEntityTab back to initialEntityTab (read from
  // the just-written URL). The two writers fought each other; the
  // visible symptom was feed-row clicks landing on Actions instead
  // of Documents. With state hoisted, both writes here read the
  // same source and converge.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.pathname.toLowerCase().startsWith('/firms')) return;
    if (activeTab !== 'queue') return;
    const url = new URL(window.location.href);
    if (firmHomeSelected || !selectedFirmClientId) {
      url.searchParams.delete('entity');
      url.searchParams.delete('tab');
    } else {
      url.searchParams.set('entity', selectedFirmClientId);
      url.searchParams.set('tab', firmEntityTab);
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, '', next);
  }, [firmHomeSelected, selectedFirmClientId, firmEntityTab, activeTab]);
  useEffect(() => {
    if (!firmDataMode) return;

    setQueue((prev) => {
      const documentQueueItems = firmClients.flatMap((client) =>
        buildDocumentQueueItems(
          client,
          firmDocuments.filter((document) => document.client_id === client.id)
        )
      );
      const retainedQueue = prev.filter((item) => item.generated_from !== DOCUMENT_QUEUE_SOURCE);
      const nextQueue = [...documentQueueItems, ...retainedQueue];
      const sameShape =
        nextQueue.length === prev.length &&
        nextQueue.every((item, index) => {
          const previous = prev[index];
          return (
            previous?.id === item.id &&
            previous?.created_at === item.created_at &&
            previous?.problem_summary === item.problem_summary &&
            previous?.user_stuck_on === item.user_stuck_on
          );
        });
      return sameShape ? prev : nextQueue;
    });
  }, [firmDataMode, firmClients, firmDocuments]);

  const resetFirmDemo = () => {
    if (firmDataMode) return;
    FIRM_LEGACY_STORAGE_KEYS.forEach(removeFromStorage);
    setFirmDataSource('local');
    setFirmRecord(null);
    setQueue(cloneDemoData(firmQueueSeed));
    setHistory(cloneDemoData(firmHistorySeed));
    setCreatedFirmClients([]);
    setDeletedFirmClientIds([]);
    setFirmDocuments([]);
    setFirmTransactions([]);
    setFirmAccountingRules([]);
    setSelectedFirmClientId(firmClientSeeds[0]?.id || null);
    setFirmHomeSelected(true);
    setActiveTab('queue');
    saveToStorage(FIRM_DEMO_VERSION_KEY, FIRM_DEMO_VERSION);
  };

  const handleCreateFirmEntity = async (profile, initialQueue, processingReview = null) => {
    if (firmDataSource === 'database') {
      const snapshot = await createFirmClient({ profile, queue: initialQueue, processingReview });
      applyDatabaseSnapshot(snapshot);
      const clientId = snapshot.created_client_id || profile.id;
      setSelectedFirmClientId(clientId);
      setFirmHomeSelected(false);
      setActiveTab('queue');
      return clientId;
    }

    setCreatedFirmClients((prev) => [
      profile,
      ...prev.filter((client) => client.id !== profile.id)
    ]);
    setDeletedFirmClientIds((prev) => prev.filter((clientId) => clientId !== profile.id));
    setQueue((prev) => [
      ...initialQueue,
      ...prev.filter((item) => item.client_id !== profile.id)
    ]);
    setSelectedFirmClientId(profile.id);
    setFirmHomeSelected(false);
    setActiveTab('queue');
    return profile.id;
  };

  const handleDeleteFirmEntity = async (clientId) => {
    if (firmDataSource === 'database') {
      const snapshot = await archiveFirmClient(clientId);
      applyDatabaseSnapshot(snapshot);
      const nextClient = snapshot.clients?.find((client) => client.id !== clientId);
      setSelectedFirmClientId(nextClient?.id || null);
      setFirmHomeSelected(true);
      setActiveTab('queue');
      // Session messages survive BE snapshots, so
      // wipe this client's messages here. Otherwise re-intaking the same
      // UEN (which yields the same deterministic client id) would surface
      // welcome / outreach messages from the previous incarnation.
      setFirmMessages((prev) => prev.filter((message) => message.client_id !== clientId));
      // The upload tray is the OTHER localStorage survivor: without this
      // the deleted entity's rows linger (register orphans as "Queued",
      // terminal rows until their TTL) next to the new incarnation's
      // uploads.
      clearTrayForClient(clientId);
      return;
    }

    const nextClient = firmClients.find((client) => client.id !== clientId);
    const isSeedClient = firmClientSeeds.some((client) => client.id === clientId);

    setCreatedFirmClients((prev) => prev.filter((client) => client.id !== clientId));
    setDeletedFirmClientIds((prev) => (
      isSeedClient && !prev.includes(clientId) ? [...prev, clientId] : prev
    ));
    setQueue((prev) => prev.filter((item) => item.client_id !== clientId));
    setHistory((prev) => prev.filter((item) => item.client_id !== clientId));
    setFirmDocuments((prev) => prev.filter((document) => document.client_id !== clientId));
    setFirmTransactions((prev) => prev.filter((transaction) => transaction.client_id !== clientId));
    setFirmAccountingRules((prev) => prev.filter((rule) => rule.client_id !== clientId));
    setFirmMessages((prev) => prev.filter((message) => message.client_id !== clientId));
    setSelectedFirmClientId(nextClient?.id || null);
    setFirmHomeSelected(true);
    setActiveTab('queue');
  };


  // Public marketing landing owns '/' for signed-out visitors — render it
  // before any firm/portal/app shell so the SPA serves a real homepage
  // instead of the legacy '/'→/firms redirect.
  if (landingMode) {
    return <DonnaLanding oauthRedirect={oauthRedirect} />;
  }

  // Public Finnish landing (/fi) — the SAME landing component/funnel as root,
  // localized to Finnish (lang="fi": Finnish copy + euro prices). Rendered like
  // the root landing, before any firm/portal/app shell or auth gate.
  if (finlandLandingMode) {
    return <DonnaLanding oauthRedirect={oauthRedirect} lang="fi" />;
  }

  // Public legal/info pages (/faq /terms /privacy /security) — rendered like
  // the landing, before any firm/portal/app shell or auth gate.
  if (marketingPageKey) {
    return <MarketingPage pageKey={marketingPageKey} />;
  }

  // Staff marketing console (sales & marketing track, slice 1): the outbound
  // drafts approval queue. Must precede the firm shell so /firms/marketing
  // doesn't parse as a firm entity route; the API behind it is staff-only, so
  // a non-staff session only sees 403s. Ordinary owners enter through the
  // authenticated snapshot gate and are routed to their scoped portal.
  if (getCurrentPath().startsWith('/firms/marketing') && firmAccessStatus === 'ready') {
    return <MarketingDrafts />;
  }

  // Operator-only hosted readiness (host checks, dependency probe, pilot
  // processing enablement). It is runtime operation, not owner work, so it is
  // not mounted in Settings (Kari, 2026-09-23); the API behind it keeps its
  // own firm-member authorization.
  if (getCurrentPath().startsWith('/firms/operator') && firmAccessStatus === 'ready') {
    return (
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
        <CloudPilotReadinessCard
          firm={firmRecord}
          clients={firmClients}
          selectedClientId={selectedFirmClientId}
          dataSource={firmDataSource}
        />
        {/* FI-05: provider diagnostics and exhausted retries are operator
            work; the firm's Actions view shows the customer projection. */}
        {firmDataSource === 'database' && <OperatorProviderFailures clientId={selectedFirmClientId} />}
      </main>
    );
  }

  // Signup funnel's post-auth step: provision the owner's workspace, then
  // forward to /client/:id (where ClientPortalGate redeems the offer into
  // Checkout). Intercepted before the firm gate / landing fallback.
  if (isWorkspaceStartRoute()) {
    return <WorkspaceProvisioner oauthRedirect={oauthRedirect} />;
  }

  // The chat-surface consent page: intercepted before the firm gate / landing
  // fallback for the same reason /start is (an owner, mid-OAuth, must never
  // land in the firm console or on the marketing page).
  if (isOAuthConsentRoute()) {
    return <OAuthConsentPage />;
  }

  // Both authenticated entry points fail closed, before either portal or firm
  // children can mount their uploads, reports, cached messages or mutations.
  if (firmDataMode && firmAccessStatus === 'unreachable') {
    const Unavailable = hasDesktopRuntimeAccess() ? DesktopBooksUnreachable : WebBooksUnavailable;
    return <Unavailable error={firmAccessError} onRetry={() => {
      setFirmAccessStatus('restoring');
      setFirmAccessError('');
      setFirmAccessRetryKey((value) => value + 1);
    }} />;
  }

  // Client portal session handling — portal-branded, NEVER the firm shell. An
  // owner is a client, not a firm member; the firm restoring/auth screens are
  // the wrong persona. While the stored session verifies, show a neutral portal
  // loader; with no valid session, bounce to the funnel sign-in. Checked before
  // the firm gates so a /client route never falls into them.
  if (clientPortalMode && firmAccessStatus !== 'ready') {
    return firmAccessStatus === 'locked'
      ? <ClientPortalSignInRedirect />
      : <ClientPortalRestoring />;
  }

  if (firmMode && firmAccessStatus === 'restoring') {
    return <FirmAccessRestoring />;
  }

  // Web firm shell, verified identity, no workspace: set up the identity's own
  // firm. The desktop keeps its sole-firm first-run pane further below.
  if (firmMode && firmNoWorkspace && !isDesktopShell() && hasStoredAuth()) {
    return (
      <FirstRunOnboarding
        web
        sessionEmail={getAuthSession()?.user?.email || ''}
        onProvisioned={async () => {
          setFirmNoWorkspace(false);
          setFirmAccessError('');
          setFirmAccessStatus('checking');
          setFirmAccessRetryKey((value) => value + 1);
        }}
        onSignOut={() => {
          clearFirmAccess();
          clearPendingOffer();
          clearConfirmEmail();
          setFirmNoWorkspace(false);
          window.location.replace('/firms');
        }}
      />
    );
  }

  if (firmMode && firmAccessStatus !== 'ready') {
    const firmAuthIntent = getFirmAuthIntent();
    return (
      <FirmAuthGate
        status={firmAccessStatus}
        error={firmAccessError}
        pendingAccess={firmNoWorkspace}
        onBackToSignIn={() => {
          setFirmNoWorkspace(false);
          setFirmAccessError('');
        }}
        initialMode={firmAuthIntent.initialMode}
        initialEmail={firmAuthIntent.initialEmail}
        onAccessKeySubmit={(token) => {
          saveAccessToken(token);
          setFirmAccessRetryKey((value) => value + 1);
        }}
        onPasswordSubmit={async (credentials) => {
          const revision = getAuthSessionRevision();
          setFirmAccessStatus('checking');
          setFirmAccessError('');
          try {
            await signInWithPassword(credentials);
            authJustEstablishedRef.current = true;
            setFirmAccessRetryKey((value) => value + 1);
          } catch (error) {
            if (getAuthSessionRevision() !== revision) return;
            clearFirmAccess();
            setFirmAccessStatus('locked');
            setFirmAccessError(error.message || intl.formatMessage({ id: 'auth.error.signIn' }));
          }
        }}
        onSignUpSubmit={async (credentials) => {
          const revision = getAuthSessionRevision();
          setFirmAccessStatus('checking');
          setFirmAccessError('');
          try {
            const result = await signUp(credentials);
            if (result.confirmationRequired) {
              // Account exists but can't sign in until the emailed link
              // is clicked — back to the gate, which renders the
              // "confirmation sent" notice off this return value.
              setFirmAccessStatus('locked');
              return result;
            }
            authJustEstablishedRef.current = true;
            setFirmAccessRetryKey((value) => value + 1);
            return result;
          } catch (error) {
            if (getAuthSessionRevision() !== revision) return null;
            setFirmAccessStatus('locked');
            setFirmAccessError(error.message || intl.formatMessage({ id: 'auth.error.signUp' }));
            return null;
          }
        }}
        onGoogleSignIn={() => {
          setFirmAccessError('');
          try {
            startGoogleSignIn();
          } catch (error) {
            setFirmAccessError(error.message || intl.formatMessage({ id: 'auth.error.google' }));
          }
        }}
      />
    );
  }

  // Gate 3 — a ready desktop snapshot with no firm row: a virgin appliance.
  // The onboarding pane replaces the whole workspace until the mint lands;
  // the refetch below flips firstRunRequired off via applyDatabaseSnapshot.
  if (firmMode && firstRunRequired) {
    return (
      <FirstRunOnboarding
        onProvisioned={async () => {
          const snapshot = await fetchFirmSnapshot();
          applyDatabaseSnapshot(snapshot);
        }}
      />
    );
  }

  if (clientPortalMode && (!firmClients.length || (getClientPortalEntityId() &&
    !firmClients.some((client) => client.id === getClientPortalEntityId())))) {
    return <WebBooksUnavailable missingWorkspace onRetry={refreshDatabaseSnapshot} onSignOut={() => {
      clearFirmAccess();
      window.location.replace('/?auth=signin');
    }} />;
  }

  if (clientPortalMode) {
    // Upload tray renders inline inside the portal (below the drop
    // box) instead of as a bottom-right floating panel — the portal
    // is a single-purpose document-intake surface, so the upload
    // list belongs in the same surface as the upload affordance.
    // The subscription gate wraps the portal: it renders a paywall when
    // billing is enabled and this client isn't entitled, and otherwise renders
    // the portal unchanged. It fails OPEN (renders the portal) when billing is
    // disabled or its status check errors, so nothing is walled off until the
    // Stripe env is configured.
    return (
      <ClientPortalGate clientId={getClientPortalEntityId()}>
        <ClientPortal
          clients={firmClients}
          clientId={getClientPortalEntityId()}
          documents={firmDocuments}
          setDocuments={setFirmDocuments}
          transactions={firmTransactions}
          setTransactions={setFirmTransactions}
          clientEvidenceRequests={firmClientEvidenceRequests}
          firmMessages={firmMessages}
          firmDataSource={firmDataSource}
          onDatabaseSnapshot={applyDatabaseSnapshot}
          onSnapshotInvalidated={refreshDatabaseSnapshot}
        />
      </ClientPortalGate>
    );
  }

  if (firmMode) {
    return (
      <div className={`firm-shell${firmRailCollapsed ? ' firm-shell--rail-collapsed' : ''}`}>
        {isDesktopShell() && (
          // Titlebar band controls (rail toggle + in-app back/forward),
          // fixed so they survive the rail collapsing away beneath them.
          <FirmShellNavControls
            railCollapsed={firmRailCollapsed}
            onToggleRail={() => setFirmRailCollapsedPersist(!firmRailCollapsed)}
            onBack={firmNavBack}
            onForward={firmNavForward}
            canBack={firmNavRef.current.index > 0}
            canForward={firmNavRef.current.index < firmNavRef.current.stack.length - 1}
          />
        )}
        {!firmRailCollapsed && (activeTab === 'settings' ? (
          // Settings mode: the rail becomes the settings nav with a
          // "← Back to app" exit (the native pattern, Kari 2026-08-07).
          <SettingsSidebar
            section={settingsSection}
            onSection={setSettingsSection}
            onBack={() => setActiveTab('queue')}
          />
        ) : <FirmSidebar
          clients={firmClients}
          selectedClientId={selectedFirmClientId}
          queue={queue}
          feed={firmDataSource === 'database' ? firmFeed : null}
          isHomeSelected={activeTab === 'queue' && firmHomeSelected}
          activeTab={activeTab}
          onSelectClient={(clientId) => {
            setSelectedFirmClientId(clientId);
            setFirmHomeSelected(false);
            setActiveTab('queue');
          }}
          onHome={() => {
            setFirmHomeSelected(true);
            setActiveTab('queue');
          }}
          onTeam={() => setActiveTab('team')}
          onNewEntity={() => {
            setFirmHomeSelected(false);
            setActiveTab('newEntity');
          }}
          onSettings={(section) => {
            setSettingsSection(section || 'profile');
            setActiveTab('settings');
          }}
          onFeedback={() => setFeedbackOpen(true)}
          firmName={firmRecord?.name || ''}
          onLogout={
            // Web sessions only: the desktop shell has no sign-in (the proxy
            // injects credentials main-side), so there is nothing to log out.
            !isDesktopShell() && hasStoredAuth()
              ? () => {
                  // Account switch on a shared device: drop the stashed funnel
                  // offer/confirm too, so nothing from this account is redeemed
                  // into the next one.
                  clearFirmAccess();
                  clearPendingOffer();
                  clearConfirmEmail();
                  window.location.reload();
                }
              : null
          }
        />)}
        <main className="firm-shell__main">
          {activeTab === 'queue' && (
            <FirmOpsConsole
              clients={firmClients}
              selectedClientId={selectedFirmClientId}
              showHome={firmHomeSelected}
              feed={firmDataSource === 'database' ? firmFeed : null}
              onSelectClient={(clientId) => {
                setSelectedFirmClientId(clientId);
                setFirmHomeSelected(false);
                setActiveTab('queue');
              }}
              queue={queue}
              setQueue={setQueue}
              history={history}
              setHistory={setHistory}
              firmMessages={firmMessages}
              setFirmMessages={setFirmMessages}
              documents={firmDocuments}
              setDocuments={setFirmDocuments}
              transactions={firmTransactions}
              setTransactions={setFirmTransactions}
              accountingRules={firmAccountingRules}
              setAccountingRules={setFirmAccountingRules}
              reconciliationMatches={firmReconciliationMatches}
              clientRules={firmClientRules}
              transactionReviewQueue={firmTransactionReviewQueue}
              clientEvidenceRequests={firmClientEvidenceRequests}
              transactionAiBatch={firmTransactionAiBatch}
              ledgerAccounts={firmLedgerAccounts}
              ledgerJournals={firmLedgerJournals}
              ledgerLines={firmLedgerLines}
              closeArchives={firmCloseArchives}
              closePeriods={firmClosePeriods}
              recentUploadBatches={firmRecentUploadBatches}
              firmId={firmRecord?.id || null}
              firmDataSource={firmDataSource}
              onDatabaseSnapshot={applyDatabaseSnapshot}
              onUploadsSnapshotInvalidated={refreshDatabaseSnapshot}
              onRefreshTransactionIntel={
                firmDataSource === 'database'
                  ? async (clientIds) => applyDatabaseSnapshot(await refreshFirmTransactionIntel({ clientIds }))
                  : undefined
              }
              onSuggestTransactionCoding={
                firmDataSource === 'database'
                  ? async (transactionId) => applyDatabaseSnapshot(await suggestFirmTransactionCoding(transactionId))
                  : undefined
              }
              onBatchSuggestTransactionCoding={
                firmDataSource === 'database'
                  ? async (clientIds) => {
                      const snapshot = await batchSuggestFirmTransactionCoding({ clientIds });
                      applyDatabaseSnapshot(snapshot);
                      return snapshot.transaction_ai_batch || null;
                    }
                  : undefined
              }
              onPersistReconciliationMatch={
                firmDataSource === 'database'
                  ? async (matchId, patch) => {
                      const snapshot = await updateFirmReconciliationMatch(matchId, patch);
                      applyDatabaseSnapshot(snapshot);
                      return snapshot;
                    }
                  : undefined
              }
              onPersistManualLink={
                firmDataSource === 'database'
                  ? async ({ documentId, bankTransactionId, reviewerNote, clientId }) => {
                      const result = await createFirmManualLink({
                        documentId,
                        bankTransactionId,
                        reviewerNote,
                        clientId
                      });
                      if (result?.snapshot) applyDatabaseSnapshot(result.snapshot);
                      return result;
                    }
                  : undefined
              }
              // PR 28 — when the document-chat surface applies a
              // proposed action (link_transaction in PR 28), the
              // server returns a refreshed snapshot. Plumb it
              // through to applyDatabaseSnapshot so the artifact +
              // suggestions view re-render against the new state
              // without a manual reload. Same pattern as
              // onPersistManualLink, just for the chat-applied
              // variant (the writer ran server-side, we only need
              // to apply the snapshot).
              onChatActionSnapshotApplied={
                firmDataSource === 'database'
                  ? (snapshot) => {
                      if (snapshot) applyDatabaseSnapshot(snapshot);
                    }
                  : undefined
              }
              onPersistClientRule={
                firmDataSource === 'database'
                  ? async (ruleId, patch) => {
                      const snapshot = await updateFirmClientRule(ruleId, patch);
                      applyDatabaseSnapshot(snapshot);
                      return snapshot;
                    }
                  : undefined
              }
              onPersistTransactionReviewItem={
                firmDataSource === 'database'
                  ? async (reviewItemId, patch) => {
                      const snapshot = await updateFirmTransactionReviewItem(reviewItemId, patch);
                      applyDatabaseSnapshot(snapshot);
                      return snapshot;
                    }
                  : undefined
              }
              onPersistDocumentPatch={
                firmDataSource === 'database'
                  ? async (documentId, patch) => applyDatabaseSnapshot(await updateFirmDocument(documentId, patch))
                  : undefined
              }
              onDeleteDocument={
                firmDataSource === 'database'
                  ? (documentId, options = {}) => documentDeleteQueueRef.current.request(
                      documentId,
                      firmDocuments.find((doc) => doc.id === documentId) || null,
                      { reportError: options.reportError !== false }
                    )
                  : undefined
              }
              onPersistTransactionPatch={
                firmDataSource === 'database'
                  ? async (transactionId, patch) => {
                      const snapshot = await updateFirmTransaction(transactionId, patch);
                      applyDatabaseSnapshot(snapshot);
                      return snapshot;
                    }
                  : undefined
              }
              initialFirmLane={getInitialFirmLane()}
              activeEntityTab={firmEntityTab}
              onEntityTabChange={setFirmEntityTab}
              onResetDemo={firmDataMode ? undefined : resetFirmDemo}
              onDeleteClient={handleDeleteFirmEntity}
              onAddVenture={() => {
                setFirmHomeSelected(false);
                setActiveTab('newEntity');
              }}
            />
          )}
          {activeTab === 'team' && (
            <TeamPanel
              clients={firmClients}
              feed={firmDataSource === 'database' ? firmFeed : null}
              selectedClientId={selectedFirmClientId}
              dataSource={firmDataSource}
              onSnapshotApplied={firmDataSource === 'database' ? applyDatabaseSnapshot : undefined}
            />
          )}
          {activeTab === 'newEntity' && (
            <FirmNewEntity
              onCreateEntity={handleCreateFirmEntity}
              dataSource={firmDataSource}
              onCancel={() => {
                setFirmHomeSelected(true);
                setActiveTab('queue');
              }}
            />
          )}
          {activeTab === 'settings' && (
            <SettingsPanel
              section={settingsSection}
              firm={firmRecord}
              clients={firmClients}
              selectedClientId={firmHomeSelected ? '' : selectedFirmClientId}
              clientCount={firmClients.length}
              dataSource={firmDataSource}
              firmAutoSend={firmRecord ? Boolean(firmRecord?.metadata?.loops?.auto_send_client_asks) : null}
              onSaveFirmAutoSend={firmRecord ? handleSaveFirmAutoSend : null}
              authEmail={getAuthSession()?.user?.email || ''}
              onFeedback={() => setFeedbackOpen(true)}
              accountingImportRequest={accountingImportRequest}
              onAccountingImportRequestConsumed={() => setAccountingImportRequest(null)}
            />
          )}
        </main>
        {isDesktopShell() && firmDataSource === 'database' && !firmHomeSelected && selectedFirmClientId && (
          // Desktop-only intake: dragging files over the window turns the
          // content area into the drop target for the selected client. No
          // idle chrome; web keeps the portal as its intake surface.
          <FirmDropOverlay
            clientId={selectedFirmClientId}
            clientName={firmClients.find((client) => client.id === selectedFirmClientId)?.companyName || ''}
            onAccountingImport={({ file, clientId }) => {
              setAccountingImportRequest({ file, clientId });
              setSettingsSection('data');
              setActiveTab('settings');
            }}
          />
        )}
        {/* The console (queue tab) hosts uploads in the right dock now; the
            floating tray only covers the tabs without a dock (new entity,
            settings) so a running upload stays visible there too. */}
        {activeTab !== 'queue' && (
          <UploadTray
            dataSource={firmDataSource}
            activeClientId={firmHomeSelected ? '' : selectedFirmClientId}
            autoDismissCompleted
            onSnapshotInvalidated={refreshDatabaseSnapshot}
          />
        )}
        {feedbackOpen && (
          <FeedbackModal
            context={{
              view: activeTab === 'queue' && firmHomeSelected ? 'inbox' : activeTab,
              interface_locale: interfaceLocale,
              interface_direction: interfaceDirection,
              catalog_version: INTERFACE_CATALOG_VERSION,
              ...(selectedFirmClientId && !firmHomeSelected ? { client_id: selectedFirmClientId } : {})
            }}
            onClose={() => setFeedbackOpen(false)}
          />
        )}
      </div>
    );
  }

  // Any other path: the retired support console used to render here (removed
  // on 2026-11-05). The public landing offers sign-in.
  return <DonnaLanding oauthRedirect={oauthRedirect} />;
};

// Browser auth is shared across tabs; book state is not. Remount on a changed
// credential before loading the next session, without reading or deleting caches.
const App = () => {
  // Capture OAuth once before the child's auth initializer reads storage. A
  // later account remount must not inherit this account's just-signed-in hint.
  const [oauthRedirect] = useState(() => consumeOAuthRedirect());
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [, setIdentityRevision] = useState(0);
  useEffect(() => {
    let credential = getBookSessionIdentity();
    const hydrateIdentity = () => { if (!isDesktopShell()) void hydrateAuthUser(); };
    const showIdentity = () => setIdentityRevision((value) => value + 1);
    hydrateIdentity();
    const checkSession = () => {
      hydrateIdentity();
      const next = getBookSessionIdentity();
      if (next === credential || hasDesktopRuntimeAccess()) return;
      credential = next;
      setSessionGeneration((value) => value + 1);
    };
    window.addEventListener('donna:auth-user', showIdentity);
    window.addEventListener('storage', checkSession);
    window.addEventListener('focus', checkSession);
    return () => {
      window.removeEventListener('donna:auth-user', showIdentity);
      window.removeEventListener('storage', checkSession);
      window.removeEventListener('focus', checkSession);
    };
  }, []);
  return <AppSession key={sessionGeneration} oauthRedirect={sessionGeneration === 0 ? oauthRedirect : null} />;
};

export default App;
