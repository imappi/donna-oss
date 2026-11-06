import { getAuthSessionEpoch, getAuthSessionRevision, hasStoredAuth, withAccessHeaders } from './accessToken.js';
import { getBookSessionIdentity } from './bookSessionIdentity.js';
import { refreshAuthSession } from './supabaseAuth.js';

// An old operation cannot retry its URL/body under a newly signed-in account.
// Token refresh preserves this epoch; explicit sign-in and logout replace it.
export const firmFetch = async (url, init = {}) => {
  const epoch = getAuthSessionEpoch();
  const revision = getAuthSessionRevision();
  const principal = getBookSessionIdentity();
  const isCurrent = () => epoch === getAuthSessionEpoch() && principal === getBookSessionIdentity();
  const stale = () => Object.assign(new Error('The signed-in account changed. Please try again.'), { name: 'AbortError', code: 'AUTH_SESSION_CHANGED' });
  const doFetch = () => {
    if (!isCurrent()) throw stale();
    return fetch(url, { ...init, headers: withAccessHeaders(init.headers || {}) });
  };
  const response = await doFetch();
  if (!isCurrent()) throw stale();
  if (response.status !== 401) return response;
  // The auth helper owns per-session coalescing; a global promise can cross accounts.
  const refreshed = await refreshAuthSession();
  if (!refreshed) {
    // Rejection may clear this session. Never return an old 401 to a new account.
    if (hasStoredAuth() && (!isCurrent() || revision !== getAuthSessionRevision())) throw stale();
    return response;
  }
  if (!isCurrent()) throw stale();
  const retried = await doFetch();
  if (!isCurrent()) throw stale();
  return retried;
};

const FIRM_ERROR_MESSAGES = {
  CLOSE_PERIOD_NOT_LOCKABLE: 'Close period is not lockable yet. Clear the blocking checks first.',
  CLOSE_PERIOD_LOCKED: 'Close period is already locked.',
  LEDGER_ALREADY_POSTED: 'Transaction is already posted to the Donna ledger.',
  LEDGER_LOCKED_PERIOD_IMMUTABLE: 'This period is locked. Post an adjustment journal instead of changing the locked ledger.',
  LEDGER_LOCKED_TRANSACTION_IMMUTABLE: 'This transaction is in a locked period. Use a correction or adjustment instead.',
  XERO_WRITEBACK_AMBIGUOUS_MATCH: 'Multiple matching Xero mirror rows need manual review.',
  XERO_SCOPE_REQUIRED: 'Xero mirror maintenance needs additional Xero permissions.',
  EVIDENCE_REQUEST_NOT_REPLIED: 'Client evidence has not been replied to yet.',
  EVIDENCE_REQUEST_REJECT_REASON_REQUIRED: 'Add a short reason before rejecting client evidence.',
  REQUEST_BODY_TOO_LARGE: 'Request is too large. Narrow the selection and try again.'
};

// Coerces an arbitrary error payload — string, object, undefined — into
// a printable string. Without this, `new Error(body.error)` where
// body.error is an object renders as the useless `[object Object]` in
// toast / dialog surfaces.
//
// When the payload is an object, prefer human-readable string fields
// (.message, .error). JSON.stringify is NOT used as a fallback: edge /
// CDN 404 bodies of the shape `{ error: { code: "404", message: "..." } }`
// would otherwise dump as raw JSON onto the user (e.g. the chat surface
// rendering the literal `{"code":"404","message":"…"}` under
// "Ask about this document"). When neither field is a usable string,
// the caller's fallback wins — it carries the request context the user
// actually needs ("Firm data request failed with 404"), not raw bytes.
export const coerceErrorMessage = (value, fallback) => {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string' && value.message.trim()) return value.message;
    if (typeof value.error === 'string' && value.error.trim()) return value.error;
  }
  return fallback;
};

export const formatFirmError = (errorOrResult, fallback = 'Action failed.') => {
  if (!errorOrResult) return fallback;
  const code = errorOrResult.code || errorOrResult.error_code || errorOrResult.status;
  if (FIRM_ERROR_MESSAGES[code]) return FIRM_ERROR_MESSAGES[code];
  if (code === 'ALREADY_SYNCED') return 'Already posted to Xero mirror.';
  return coerceErrorMessage(errorOrResult.message, null)
    || coerceErrorMessage(errorOrResult.error, null)
    || fallback;
};

export const fetchFirmSnapshot = async ({ signal } = {}) => {
  const response = await firmFetch('/api/donna/firms/snapshot', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = coerceErrorMessage(body.error, `Firm data request failed with ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.code = body.code;
    error.details = body.details || null;
    error.body = body;
    throw error;
  }

  return response.json();
};

// Deploy-vintage receipt (public route, no token): database_configured +
// commit_sha + vercel_env. Settings' About / Data screens render it so
// "what is actually running" is readable without a terminal.
export const fetchFirmHealth = async ({ signal } = {}) => {
  const response = await firmFetch('/api/donna/firms/health', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  if (!response.ok) throw new Error(`Health request failed with ${response.status}`);
  return response.json();
};

export const fetchFirmFeed = async ({ firmId, bucket, clientId, signal } = {}) => {
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  if (bucket) params.set('bucket', bucket);
  if (clientId) params.set('client_id', clientId);
  const qs = params.toString();
  const response = await firmFetch(`/api/donna/firms/feed${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = coerceErrorMessage(body.error, `Firm feed request failed with ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.code = body.code;
    error.body = body;
    throw error;
  }

  return response.json();
};

const parseJsonResponse = async (response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = coerceErrorMessage(body.error, `Firm data request failed with ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.code = body.code;
    // Surface the structured error payload so call sites can render
    // backend-supplied detail (e.g. CLOSE_PERIOD_NOT_LOCKABLE.details.checks)
    // instead of a generic failure message.
    error.details = body.details || null;
    error.body = body;
    throw error;
  }
  return body;
};

// Gate 3 — the first-run firm mint (desktop only; the server 403s off the
// desktop host and 409s once any firm exists).
export const createFirstRunFirm = async ({ firmName, ownerName, ownerEmail, jurisdiction, currency }) => {
  const response = await firmFetch('/api/donna/firms/first-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      firm_name: firmName,
      owner_name: ownerName,
      owner_email: ownerEmail,
      jurisdiction,
      ...(currency ? { currency } : {})
    })
  });
  return parseJsonResponse(response);
};

export const createFirmClient = async ({ profile, queue = [], processingReview = null }) => {
  const response = await firmFetch('/api/donna/firms/clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ profile, queue, id_scope: 'firm', ...(processingReview ? { processing_review: processingReview } : {}) })
  });
  return parseJsonResponse(response);
};

// reopenExhausted is the explicit operator exit from an exhausted saga: it
// starts a fresh bounded recovery episode and writes its own reopen receipt.
export const retryFirmClientReadiness = async (clientId, { reopenExhausted = false } = {}) => {
  const response = await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/readiness/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(reopenExhausted ? { reopen_exhausted: true } : {})
  });
  return parseJsonResponse(response);
};

export const archiveFirmClient = async (clientId) => {
  const response = await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' }
  });
  return parseJsonResponse(response);
};

// Partial-merge update to clients.profile jsonb. `profilePatch` is the
// set of top-level keys to overwrite (shallow merge on the server via
// jsonb `||`). Used by the client portal to persist dismissed-tile
// state per period; the BE returns the refreshed firm snapshot so the
// caller can reconcile against the authoritative client row.
export const updateFirmClientProfile = async ({ clientId, profilePatch, signal, ownerSetup = false } = {}) => {
  const response = await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal, body: JSON.stringify({ profile_patch: profilePatch, ...(ownerSetup ? { owner_setup: true } : {}) })
  });
  return parseJsonResponse(response);
};

// Row 17's fiscal-period step. GET reports { intake_acts, periods } — the
// server owns the FISCAL_PERIOD_INTAKE flag verdict, the FE never guesses it
// (the binding-state pattern). POST registers owner-stated bounds; the label
// is derived server-side from the end year.
export const fetchFiscalPeriods = async ({ clientId, signal } = {}) => {
  const response = await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/fiscal-periods`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Owner VAT-return envelope: { surface_acts, prepared, refusal }. The server
// owns the whole verdict (flag stage, jurisdiction, prep refusals folded as
// data) — the portal renders it and never guesses a flag.
export const fetchOwnerVatReturn = async ({ clientId, signal } = {}) => {
  const response = await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/vat-return`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const registerFiscalPeriod = async ({ clientId, startsOn, endsOn } = {}) => {
  const response = await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/fiscal-periods`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ starts_on: startsOn, ends_on: endsOn })
  });
  return parseJsonResponse(response);
};

export const fetchWhatsAppBindingState = async ({ clientId, signal } = {}) => {
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/whatsapp/binding-state?${params}`, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  return parseJsonResponse(response);
};

export const createWhatsAppConnectToken = async ({ clientId } = {}) => {
  const response = await firmFetch('/api/donna/firms/whatsapp/connect-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: clientId }) });
  return parseJsonResponse(response);
};

export const revokeWhatsAppBinding = async ({ clientId, bindingId } = {}) => {
  const response = await firmFetch('/api/donna/firms/whatsapp/bindings/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: clientId, binding_id: bindingId }) });
  return parseJsonResponse(response);
};

// Telegram self-serve connect — the WhatsApp trio mirrored (row 17). The
// connect token yields a t.me deep link when TELEGRAM_BOT_USERNAME is set,
// plus the manual /start command as the always-available fallback.
export const fetchTelegramBindingState = async ({ clientId, signal } = {}) => {
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/telegram/binding-state?${params}`, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  return parseJsonResponse(response);
};

export const createTelegramConnectToken = async ({ clientId } = {}) => {
  const response = await firmFetch('/api/donna/firms/telegram/connect-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: clientId }) });
  return parseJsonResponse(response);
};

export const revokeTelegramBinding = async ({ clientId, bindingId } = {}) => {
  const response = await firmFetch('/api/donna/firms/telegram/bindings/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: clientId, binding_id: bindingId }) });
  return parseJsonResponse(response);
};

// Firm-level autonomy setting: turn auto-send of drafted client questions on/off
// (firms.metadata.loops.auto_send_client_asks). Authority-only on the server
// (requireMember). Returns the refreshed firm snapshot so the caller can apply it.
export const updateFirmAutoSendSetting = async ({ autoSendClientAsks } = {}) => {
  const response = await firmFetch('/api/donna/firms/settings/auto-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ auto_send_client_asks: autoSendClientAsks })
  });
  return parseJsonResponse(response);
};

// Read-only accounting-data inspection. The file body is sent verbatim so a
// six-megabyte workbook does not become an eight-megabyte base64 JSON payload.
// The server verifies the container bytes independently of this filename/MIME
// metadata and returns a normalized preview; this call never writes the book.
export const inspectFirmAccountingImport = async ({
  file,
  firmId = null,
  clientId,
  importKind = null,
  sheetHandle = null,
  mapping = null,
  dateConvention = 'safe',
  numberConvention = 'safe',
  signal
} = {}) => {
  if (!file) throw new Error('Choose a CSV, TSV, XLSX or XLS file.');
  if (!clientId) throw new Error('Choose a venture before inspecting accounting data.');
  const params = new URLSearchParams({
    client_id: clientId,
    filename: file.name || 'accounting-data'
  });
  if (firmId) params.set('firm_id', firmId);
  if (importKind) params.set('import_kind', importKind);
  if (sheetHandle) params.set('sheet_handle', sheetHandle);
  if (mapping && typeof mapping === 'object') params.set('mapping', JSON.stringify(mapping));
  params.set('date_convention', dateConvention);
  params.set('number_convention', numberConvention);
  const response = await firmFetch(`/api/donna/firms/imports/inspect?${params}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      Accept: 'application/json'
    },
    body: file,
    signal
  });
  return parseJsonResponse(response);
};

// Register one or more uploaded documents for async parsing. The
// matching server-side endpoint (/documents/register) returns the
// idempotent row(s) — either an existing row (network replay / byte
// match) or a freshly inserted pending row with parse_run_id set.
// See docs/async-parsing-plan.md → /documents/register.
// `firmId` is forwarded when the caller has it (RT-03); absent, the server
// scopes the request to its live default firm.
export const registerFirmDocuments = async ({ firmId, documents = [], signal } = {}) => {
  const response = await firmFetch('/api/donna/firms/documents/register', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...(firmId ? { firm_id: firmId } : {}), documents })
  });
  // No drain kick (RT-08): the register route enqueues the parse as a
  // `parse-document` local job on the appliance (or the Inngest event in the
  // cloud), and the scheduler polls the queue every second — the row has an
  // owner the moment this call returns. The old fire-and-forget
  // `parse-cron?task=drain` GET woke a per-minute backstop that must no
  // longer race the queue for a fresh row.
  return parseJsonResponse(response);
};

// Poll the parse status for up to 100 document ids. Used by the upload
// tray to drive live state for in-flight rows.
export const fetchFirmDocumentsParseStatus = async ({ ids = [], signal } = {}) => {
  if (!ids.length) return { documents: [] };
  const params = new URLSearchParams();
  params.set('ids', ids.join(','));
  const response = await firmFetch(`/api/donna/firms/documents/parse-status?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Firm-only manual retry. Mints a new parse_run_id server-side and
// fires a fresh Inngest event with that id.
export const retryFirmDocumentParse = async ({ documentIds = [] } = {}) => {
  const response = await firmFetch('/api/donna/firms/documents/retry-parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ document_ids: documentIds })
  });
  return parseJsonResponse(response);
};

// Resolve a `duplicate_pending` document via the 3-way resolver. Action
// is one of `create` | `replace` | `cancel`. On a non-idempotent
// success the response carries the next state of the doc (pending for
// create/replace, document=null for cancel). REPLACE_BLOCKED_REVIEWED_TX
// surfaces as a 409 — the caller should disable the Replace button and
// show the inline block reason. See docs/async-parsing-plan.md →
// `/documents/<id>/resolve-duplicate`.
export const resolveDocumentDuplicate = async ({ documentId, action } = {}) => {
  if (!documentId) throw new Error('resolveDocumentDuplicate: documentId is required');
  if (!action) throw new Error('resolveDocumentDuplicate: action is required');
  const response = await firmFetch(
    `/api/donna/firms/documents/${encodeURIComponent(documentId)}/resolve-duplicate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action })
    }
  );
  return parseJsonResponse(response);
};

export const updateFirmDocument = async (documentId, patch) => {
  const response = await firmFetch(`/api/donna/firms/documents/${encodeURIComponent(documentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ patch })
  });
  return parseJsonResponse(response);
};

export const deleteFirmDocument = async (documentId) => {
  if (!documentId) throw new Error('deleteFirmDocument: documentId is required');
  const response = await firmFetch(`/api/donna/firms/documents/${encodeURIComponent(documentId)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' }
  });
  return parseJsonResponse(response);
};

export const fetchFirmDocumentDownload = async ({ documentId, signal } = {}) => {
  if (!documentId) throw new Error('fetchFirmDocumentDownload: documentId is required');
  const response = await firmFetch(`/api/donna/firms/documents/${encodeURIComponent(documentId)}/download`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Triggers a browser download of a source document's ORIGINAL file. The
// download endpoint issues a short-lived (300s) signed URL to object
// storage — never a permanent link — and audits the access server-side.
// The signed URL is a Supabase storage object URL; appending `download`
// makes storage serve it as Content-Disposition: attachment so the browser
// SAVES the original under its stored filename rather than previewing it
// inline. No bytes pass through our origin (so no cross-origin blob fetch
// is needed); same "fetch a link, anchor-click it" spirit as
// downloadFinancialReport. Note: `document` here is the global DOM object —
// the API result is bound to `result`, never shadowing it.
export const downloadFirmDocument = async ({ documentId, signal } = {}) => {
  if (!documentId) throw new Error('downloadFirmDocument: documentId is required');
  const result = await fetchFirmDocumentDownload({ documentId, signal });
  const signedUrl = result?.signed_url || '';
  if (!signedUrl) {
    throw new Error('Could not get a download link for this document. Please try again.');
  }
  const filename = String(result?.document?.filename || 'document').trim() || 'document';
  const separator = signedUrl.includes('?') ? '&' : '?';
  const downloadUrl = `${signedUrl}${separator}download=${encodeURIComponent(filename)}`;
  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return { filename };
};

// PR 2 of docs/invoice-receipt-parsing-plan.md.
// Lazy-fetched when the firm opens a document artifact — the snapshot
// doesn't carry document_lines. Returns { document, lines, review_items }.
// PR 3 populates review_items from transaction_review_queue rows where
// item_type='document_line'.
// PR 27 — document chat persistence + LLM call.
//
// GET loads the thread for a document; POST sends a user message,
// the server persists both user and assistant turns and returns the
// pair plus the (currently empty) set of action types whose Apply
// path is wired. PR 28+ extends `appliable_action_types` as each
// writer lands; the FE reads it to enable/disable Apply buttons.
export const fetchFirmDocumentChat = async ({ clientId, documentId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFirmDocumentChat: clientId is required');
  if (!documentId) throw new Error('fetchFirmDocumentChat: documentId is required');
  const params = new URLSearchParams({ client_id: clientId, document_id: documentId });
  const response = await firmFetch(`/api/donna/firms/document-chat?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const postFirmDocumentChatMessage = async ({
  clientId,
  documentId,
  message,
  documentContext = null,
  candidateTransactions = [],
  addressedAgent = null,
  signal
} = {}) => {
  if (!clientId) throw new Error('postFirmDocumentChatMessage: clientId is required');
  if (!documentId) throw new Error('postFirmDocumentChatMessage: documentId is required');
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('postFirmDocumentChatMessage: message is required');
  }
  const response = await firmFetch('/api/donna/firms/document-chat/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      document_id: documentId,
      message: message.trim(),
      document_context: documentContext,
      candidate_transactions: candidateTransactions,
      ...(addressedAgent ? { addressed_agent: addressedAgent } : {})
    })
  });
  return parseJsonResponse(response);
};

// PR 28 — apply a proposed action from a persisted chat message.
// Server reads action params from the persisted payload (not from
// this body) and routes to the matching writer. Returns the
// updated assistant message + a fresh snapshot when the writer
// changes firm state (e.g. link_transaction creates a confirmed
// reconciliation match). Idempotent — re-clicking Apply on an
// already-applied action returns the current state instead of
// 500-ing.
export const applyFirmDocumentChatAction = async ({
  clientId,
  documentId,
  messageId,
  actionIndex,
  reviewerNote,
  signal
} = {}) => {
  if (!clientId) throw new Error('applyFirmDocumentChatAction: clientId is required');
  if (!documentId) throw new Error('applyFirmDocumentChatAction: documentId is required');
  if (!messageId) throw new Error('applyFirmDocumentChatAction: messageId is required');
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    throw new Error('applyFirmDocumentChatAction: actionIndex must be a non-negative integer');
  }
  const url = `/api/donna/firms/document-chat/messages/${encodeURIComponent(messageId)}/actions/${actionIndex}/apply`;
  const response = await firmFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      document_id: documentId,
      reviewer_note: reviewerNote || null
    })
  });
  return parseJsonResponse(response);
};

// Transaction chat — bank-feed case-file conversation. Mirrors the
// document-chat trio above but keyed on a transaction.

export const fetchFirmTransactionChat = async ({ clientId, transactionId, signal, explanation = true } = {}) => {
  if (!clientId) throw new Error('fetchFirmTransactionChat: clientId is required');
  if (!transactionId) throw new Error('fetchFirmTransactionChat: transactionId is required');
  const params = new URLSearchParams({ client_id: clientId, transaction_id: transactionId });
  // The poll path uses only `messages` — passing explanation:false skips the
  // server-side snapshot/explanation build (a match + document query and a
  // signed-URL network call) on every tick. The mount fetch keeps the default.
  if (explanation === false) params.set('explanation', '0');
  const response = await firmFetch(`/api/donna/firms/transaction-chat?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Per-client rollup of the latest `client_reply_received` timestamp
// per transaction. The bank-feed compares this against a localStorage
// last-seen map to decide which rows to badge as "new client reply".
export const fetchFirmTransactionChatUnreadSummary = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFirmTransactionChatUnreadSummary: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/transaction-chat/unread-summary?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// ── Case snapshot (the operatorCaseSnapshot read model) ────────────────
//
// GET /case-snapshot — the ONE compressed per-case read (contract §1).
// `include` is the server's budget control: pass only the blocks the
// surface renders (the Audit tab passes ['timeline'] so nothing else
// pays for the timeline queries).
export const fetchFirmCaseSnapshot = async ({ clientId, focusType = 'transaction', focusId, include = [], firmId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFirmCaseSnapshot: clientId is required');
  if (!focusId) throw new Error('fetchFirmCaseSnapshot: focusId is required');
  const params = new URLSearchParams({ client_id: clientId, focus_type: focusType, focus_id: focusId });
  if (firmId) params.set('firm_id', firmId);
  if (Array.isArray(include) && include.length) params.set('include', include.join(','));
  const response = await firmFetch(`/api/donna/firms/case-snapshot?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// ── Operator reverse (pod-safety #2, G2 PR-15) ─────────────────────────
//
// Founder-only. A bare call (execute omitted) is a DRY RUN: the server
// re-reads every captured target and returns the plan with no write. Only
// execute: true applies, and the panel only sends it from an armed confirm
// (canExecuteReverse — the wiring test pins that guard). Passing no
// proposalIds plans every reversible apply for the client.
export const reverseOperatorApplies = async ({ clientId, firmId, proposalIds, execute = false, signal } = {}) => {
  if (!clientId) throw new Error('reverseOperatorApplies: clientId is required');
  const response = await firmFetch('/api/donna/firms/operator/reverse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      ...(firmId ? { firm_id: firmId } : {}),
      ...(Array.isArray(proposalIds) && proposalIds.length ? { proposal_ids: proposalIds.map(String) } : {}),
      ...(execute === true ? { execute: true } : {})
    }),
    signal
  });
  return parseJsonResponse(response);
};

// ── Ask-pipeline batches (firm-side "Client asks" surface) ─────────────
//
// One drafted client message per (client, period); the strong model
// drafts it FROM the persisted coding verdicts (server askPipeline.js).
// Drafting can 503 with ASK_PIPELINE_LLM_UNAVAILABLE — there is NO
// fallback drafter by design, the surface tells the firm to retry.
// Sending is draft-only and 409s (ASK_BATCH_NOT_DRAFT) on a stale or
// double-clicked draft.

export const fetchFirmAskBatches = async ({ clientId, status, signal } = {}) => {
  if (!clientId) throw new Error('fetchFirmAskBatches: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  if (status) params.set('status', status);
  const response = await firmFetch(`/api/donna/firms/ask-batches?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const draftFirmAskBatch = async ({ clientId, periodStart = null, periodEnd = null } = {}) => {
  if (!clientId) throw new Error('draftFirmAskBatch: clientId is required');
  const response = await firmFetch('/api/donna/firms/ask-batches/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, period_start: periodStart, period_end: periodEnd })
  });
  return parseJsonResponse(response);
};

export const sendFirmAskBatch = async ({ batchId, clientId } = {}) => {
  if (!batchId) throw new Error('sendFirmAskBatch: batchId is required');
  if (!clientId) throw new Error('sendFirmAskBatch: clientId is required');
  const response = await firmFetch(`/api/donna/firms/ask-batches/${encodeURIComponent(batchId)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId })
  });
  return parseJsonResponse(response);
};

export const postFirmTransactionChatMessage = async ({
  clientId,
  transactionId,
  message,
  transactionContext = null,
  candidateDocuments = [],
  addressedAgent = null,
  signal
} = {}) => {
  if (!clientId) throw new Error('postFirmTransactionChatMessage: clientId is required');
  if (!transactionId) throw new Error('postFirmTransactionChatMessage: transactionId is required');
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('postFirmTransactionChatMessage: message is required');
  }
  const response = await firmFetch('/api/donna/firms/transaction-chat/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      transaction_id: transactionId,
      message: message.trim(),
      transaction_context: transactionContext,
      candidate_documents: candidateDocuments,
      ...(addressedAgent ? { addressed_agent: addressedAgent } : {})
    })
  });
  return parseJsonResponse(response);
};

export const applyFirmTransactionChatAction = async ({
  clientId,
  transactionId,
  messageId,
  actionIndex,
  signal
} = {}) => {
  if (!clientId) throw new Error('applyFirmTransactionChatAction: clientId is required');
  if (!transactionId) throw new Error('applyFirmTransactionChatAction: transactionId is required');
  if (!messageId) throw new Error('applyFirmTransactionChatAction: messageId is required');
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    throw new Error('applyFirmTransactionChatAction: actionIndex must be a non-negative integer');
  }
  const url = `/api/donna/firms/transaction-chat/messages/${encodeURIComponent(messageId)}/actions/${actionIndex}/apply`;
  const response = await firmFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      transaction_id: transactionId
    })
  });
  return parseJsonResponse(response);
};

// ── Feed chat (client-level mass-command surface) ──────────────────────
//
// One thread per client; actions carry explicit transaction_ids sets
// resolved server-side against the persisted feed. Apply responses
// return ONE fresh snapshot for the whole batch.

// roleId (S3 role threads) switches all three calls onto that role's thread
// sentinel server-side — same store, same grammar, same apply spine.

export const fetchFirmFeedChat = async ({ clientId, roleId = null, signal } = {}) => {
  if (!clientId) throw new Error('fetchFirmFeedChat: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  if (roleId) params.set('role_id', roleId);
  const response = await firmFetch(`/api/donna/firms/feed-chat?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const postFirmFeedChatMessage = async ({ clientId, roleId = null, message, documentIds = [], signal } = {}) => {
  if (!clientId) throw new Error('postFirmFeedChatMessage: clientId is required');
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('postFirmFeedChatMessage: message is required');
  }
  const response = await firmFetch('/api/donna/firms/feed-chat/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      ...(roleId ? { role_id: roleId } : {}),
      message: message.trim(),
      document_ids: Array.from(new Set(
        (Array.isArray(documentIds) ? documentIds : [])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      ))
    })
  });
  return parseJsonResponse(response);
};

export const applyFirmFeedChatAction = async ({ clientId, roleId = null, messageId, actionIndex, signal } = {}) => {
  if (!clientId) throw new Error('applyFirmFeedChatAction: clientId is required');
  if (!messageId) throw new Error('applyFirmFeedChatAction: messageId is required');
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    throw new Error('applyFirmFeedChatAction: actionIndex must be a non-negative integer');
  }
  const url = `/api/donna/firms/feed-chat/messages/${encodeURIComponent(messageId)}/actions/${actionIndex}/apply`;
  const response = await firmFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({ client_id: clientId, ...(roleId ? { role_id: roleId } : {}) })
  });
  return parseJsonResponse(response);
};

// ── Team roster (S3, specialist-roles doc §5) ───────────────────────────
//
// One roster read per venture; the four mutations land on the S2 employment
// writers server-side (hire/end/approve/revoke, owner-actor, receipted).
// Mutations 403 until the bench UI flag ACTS for the venture.

export const fetchRoleRoster = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchRoleRoster: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/roles/roster?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

const postRoleEmployment = async (path, payload) => {
  const response = await firmFetch(`/api/donna/firms/roles/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseJsonResponse(response);
};

export const hireFirmRole = async ({ clientId, roleId, reason = null } = {}) => {
  if (!clientId || !roleId) throw new Error('hireFirmRole: clientId and roleId are required');
  return postRoleEmployment('hire', { client_id: clientId, role_id: roleId, reason });
};

export const endFirmRole = async ({ clientId, roleId, reason = null } = {}) => {
  if (!clientId || !roleId) throw new Error('endFirmRole: clientId and roleId are required');
  return postRoleEmployment('end', { client_id: clientId, role_id: roleId, reason });
};

export const approveFirmRoleGrant = async ({
  clientId, roleId, grantShape, actionType, scopeKind = 'counterparty', scopeKey,
  amountCeiling, currency, expiresAt = null, reviewAfter = null, reason = null
} = {}) => {
  if (!clientId || !roleId) throw new Error('approveFirmRoleGrant: clientId and roleId are required');
  return postRoleEmployment('grants/approve', {
    client_id: clientId,
    role_id: roleId,
    grant_shape: grantShape,
    action_type: actionType,
    scope_kind: scopeKind,
    scope_key: scopeKey,
    amount_ceiling: amountCeiling,
    currency,
    expires_at: expiresAt,
    review_after: reviewAfter,
    reason
  });
};

export const revokeFirmRoleGrant = async ({ clientId, grantId, reason = null } = {}) => {
  if (!clientId || !grantId) throw new Error('revokeFirmRoleGrant: clientId and grantId are required');
  return postRoleEmployment('grants/revoke', { client_id: clientId, grant_id: grantId, reason });
};

// ── Human seats (docs/design-donna-seats-roles-access.md) ────────────────
//
// The roster is FIRM-level (seats span ventures); writes are owner-gated
// server-side (partner may manage entity assignments), with every lifecycle
// transition audited in-transaction. External seats are denied the roster
// read (no portfolio views), so a 403 here is a fence, not a fault.

export const fetchFirmSeats = async ({ signal } = {}) => {
  const response = await firmFetch('/api/donna/firms/seats', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

const postSeats = async (path, payload) => {
  const response = await firmFetch(`/api/donna/firms/seats/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseJsonResponse(response);
};

export const inviteFirmSeat = async ({
  name, email, seatRole, affiliation = 'internal', clientIds = [], endsAt = null, firmName = null
} = {}) => {
  if (!name || !email || !seatRole) throw new Error('inviteFirmSeat: name, email and seatRole are required');
  return postSeats('invite', {
    name,
    email,
    seat_role: seatRole,
    affiliation,
    client_ids: clientIds,
    ends_at: endsAt,
    firm_name: firmName
  });
};

export const resendFirmSeatInvite = async ({ seatId, firmName = null } = {}) => {
  if (!seatId) throw new Error('resendFirmSeatInvite: seatId is required');
  return postSeats('invite-email', { seat_id: seatId, firm_name: firmName });
};

export const updateFirmSeat = async ({ seatId, op, seatRole = null, endsAt = null } = {}) => {
  if (!seatId || !op) throw new Error('updateFirmSeat: seatId and op are required');
  return postSeats('update', { seat_id: seatId, op, seat_role: seatRole, ends_at: endsAt });
};

export const setFirmSeatEntities = async ({ seatId, clientIds = [] } = {}) => {
  if (!seatId) throw new Error('setFirmSeatEntities: seatId is required');
  return postSeats('entities', { seat_id: seatId, client_ids: clientIds });
};

// ── Firm feed chat (the Inbox cross-venture mass-command surface) ───────
//
// One thread per FIRM; every action carries the client_id it compiles to
// and the apply dispatches through the same per-client writers server-side.
// Firm members only (the server enforces requireMember).

export const fetchFirmInboxChat = async ({ signal } = {}) => {
  const response = await firmFetch('/api/donna/firms/feed-chat/firm', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const postFirmInboxChatMessage = async ({ message, venturesOffset, signal } = {}) => {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('postFirmInboxChatMessage: message is required');
  }
  const response = await firmFetch('/api/donna/firms/feed-chat/firm/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      message: message.trim(),
      // G0.2 continuation batch: a NEW bounded run over the next window of
      // the firm's name-ordered venture list.
      ...(Number.isInteger(venturesOffset) && venturesOffset > 0
        ? { ventures_offset: venturesOffset }
        : {})
    })
  });
  return parseJsonResponse(response);
};

export const applyFirmInboxChatAction = async ({ messageId, actionIndex, signal } = {}) => {
  if (!messageId) throw new Error('applyFirmInboxChatAction: messageId is required');
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    throw new Error('applyFirmInboxChatAction: actionIndex must be a non-negative integer');
  }
  const url = `/api/donna/firms/feed-chat/firm/messages/${encodeURIComponent(messageId)}/actions/${actionIndex}/apply`;
  const response = await firmFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({})
  });
  return parseJsonResponse(response);
};

// ── Product feedback (the sidebar Feedback modal) ───────────────────────
//
// Meta-product lane: a note ABOUT Donna, landing in user_feedback
// (migration 115) where Kari reads it. Never joined into books surfaces.

export const submitFeedback = async ({ kind, message, context, signal } = {}) => {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('submitFeedback: message is required');
  }
  const response = await firmFetch('/api/donna/firms/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({ kind, message: message.trim(), ...(context ? { context } : {}) })
  });
  return parseJsonResponse(response);
};

// ── Client-portal chat (owner ↔ Donna) ──────────────────────────────────
// The business owner's read-only Q&A thread with Donna in the client
// portal. One thread per client; the server derives every read from the
// caller's auth scope (a client-scoped collaborator only reaches their
// own client). No apply helper exists on purpose — Slice 1 proposes
// nothing (docs/design-donna-client-portal-chat.md).

export const fetchClientPortalChat = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchClientPortalChat: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/client-chat?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const postClientPortalChatMessage = async ({ clientId, message, signal } = {}) => {
  if (!clientId) throw new Error('postClientPortalChatMessage: clientId is required');
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('postClientPortalChatMessage: message is required');
  }
  const response = await firmFetch('/api/donna/firms/client-chat/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      message: message.trim()
    })
  });
  return parseJsonResponse(response);
};

// The owner CONFIRMS a proposed answer card (Slice 2's one verb).
export const applyClientPortalChatAction = async ({ clientId, messageId, actionIndex, signal } = {}) => {
  if (!clientId) throw new Error('applyClientPortalChatAction: clientId is required');
  if (!messageId) throw new Error('applyClientPortalChatAction: messageId is required');
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    throw new Error('applyClientPortalChatAction: actionIndex must be a non-negative integer');
  }
  const url = `/api/donna/firms/client-chat/messages/${encodeURIComponent(messageId)}/actions/${actionIndex}/apply`;
  const response = await firmFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({ client_id: clientId })
  });
  return parseJsonResponse(response);
};

export const preflightClientPortalOwnerIntent = async ({ clientId, proposalId, signal } = {}) => {
  if (!clientId) throw new Error('preflightClientPortalOwnerIntent: clientId is required');
  if (!proposalId) throw new Error('preflightClientPortalOwnerIntent: proposalId is required');
  const response = await firmFetch(`/api/donna/firms/client-chat/owner-intent-proposals/${encodeURIComponent(proposalId)}/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({ client_id: clientId })
  });
  return parseJsonResponse(response);
};

export const acceptClientPortalOwnerIntent = async ({ clientId, proposalId, signal } = {}) => {
  if (!clientId) throw new Error('acceptClientPortalOwnerIntent: clientId is required');
  if (!proposalId) throw new Error('acceptClientPortalOwnerIntent: proposalId is required');
  const response = await firmFetch(`/api/donna/firms/client-chat/owner-intent-proposals/${encodeURIComponent(proposalId)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({ client_id: clientId })
  });
  return parseJsonResponse(response);
};

export const withdrawClientPortalOwnerIntent = async ({ clientId, proposalId, reason = 'owner_skipped', signal } = {}) => {
  if (!clientId) throw new Error('withdrawClientPortalOwnerIntent: clientId is required');
  if (!proposalId) throw new Error('withdrawClientPortalOwnerIntent: proposalId is required');
  const response = await firmFetch(`/api/donna/firms/client-chat/owner-intent-proposals/${encodeURIComponent(proposalId)}/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({ client_id: clientId, reason })
  });
  return parseJsonResponse(response);
};

// Direct send to the client portal — bypasses the LLM. The transaction
// chat persists the firm's question + a system confirmation message
// alongside creating the actual evidence request in the client portal.
// Used by the "Ask client about this" composer flow.
export const askFirmTransactionClient = async ({
  clientId,
  transactionId,
  question,
  evidenceType = 'business_purpose',
  signal
} = {}) => {
  if (!clientId) throw new Error('askFirmTransactionClient: clientId is required');
  if (!transactionId) throw new Error('askFirmTransactionClient: transactionId is required');
  if (typeof question !== 'string' || !question.trim()) {
    throw new Error('askFirmTransactionClient: question is required');
  }
  const response = await firmFetch('/api/donna/firms/transaction-chat/ask-client', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      transaction_id: transactionId,
      question: question.trim(),
      evidence_type: evidenceType
    })
  });
  return parseJsonResponse(response);
};

export const fetchFirmDocumentLines = async ({ documentId, signal } = {}) => {
  if (!documentId) throw new Error('fetchFirmDocumentLines: documentId is required');
  const response = await firmFetch(`/api/donna/firms/documents/${encodeURIComponent(documentId)}/lines`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// PR 3 of docs/invoice-receipt-parsing-plan.md.
// Per-line edit. Body accepts any subset of:
//   { description, quantity, unit_price, amount, tax_rate,
//     category, account_code, review_status, notes, make_rule }
// PR 4: `make_rule: true` upserts a `client_rules` row for the parent
// receipt's vendor + the patch's account_code, atomically with the
// line UPDATE. Requires both account_code AND category in the body
// and the parent document to have a non-empty `vendor_name`.
// Returns { line, closed_review_item_ids, created_rule_id,
// rule_existed_before }. The handler runs the patch + queue-row close
// + (optional) rule upsert in one transaction — see
// server/donna/documentLinePatch.js.
export const patchFirmDocumentLine = async ({ documentId, lineId, patch, signal } = {}) => {
  if (!documentId) throw new Error('patchFirmDocumentLine: documentId is required');
  if (!lineId) throw new Error('patchFirmDocumentLine: lineId is required');
  const response = await firmFetch(
    `/api/donna/firms/documents/${encodeURIComponent(documentId)}/lines/${encodeURIComponent(lineId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ patch: patch || {} }),
      signal
    }
  );
  return parseJsonResponse(response);
};

// Slice C — record one human correction on a document field.
// Returns `{ correction, allowed_fields }`. The endpoint validates
// `field_path` against the allowlist on the server (mirrors
// documentCorrections.ALLOWED_CORRECTION_FIELDS); when the field
// has a writeback target, the documents row is also updated in the
// same transaction so the next snapshot read reflects the
// corrected value.
export const recordFirmDocumentCorrection = async ({
  documentId,
  fieldPath,
  correctedValue,
  correctedBy,
  firmId,
  signal
} = {}) => {
  if (!documentId) throw new Error('recordFirmDocumentCorrection: documentId is required');
  if (!fieldPath) throw new Error('recordFirmDocumentCorrection: fieldPath is required');
  const response = await firmFetch(
    `/api/donna/firms/documents/${encodeURIComponent(documentId)}/corrections`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        field_path: fieldPath,
        corrected_value: correctedValue,
        ...(correctedBy ? { corrected_by: correctedBy } : {}),
        ...(firmId ? { firm_id: firmId } : {})
      }),
      signal
    }
  );
  return parseJsonResponse(response);
};

export const listFirmDocumentCorrections = async ({ documentId, firmId, signal } = {}) => {
  if (!documentId) throw new Error('listFirmDocumentCorrections: documentId is required');
  const qs = firmId ? `?firm_id=${encodeURIComponent(firmId)}` : '';
  const response = await firmFetch(
    `/api/donna/firms/documents/${encodeURIComponent(documentId)}/corrections${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }
  );
  return parseJsonResponse(response);
};

// Governance: list the firm's memory (firm_facts) for the Facts panel — both
// active and dismissed, with provenance + the distiller model. GETs the
// firm-member-gated list endpoint. Returns { facts: [...] }.
export const fetchFirmFacts = async ({ firmId, status, signal } = {}) => {
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  if (status) params.set('status', status);
  const qs = params.toString();
  const response = await firmFetch(
    `/api/donna/firms/firm-facts${qs ? `?${qs}` : ''}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }
  );
  return parseJsonResponse(response);
};

// MCP consent screen (design-donna-mcp-surface.md §8 item 1): every venture
// the principal may see, each with its Claude-exposure state. Returns
// { flag_key, force_disabled, entities: [{ id, name, status, stage, exposed }] }.
export const fetchMcpExposure = async ({ firmId, signal } = {}) => {
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  const qs = params.toString();
  const response = await firmFetch(
    `/api/donna/firms/mcp-exposure${qs ? `?${qs}` : ''}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }
  );
  return parseJsonResponse(response);
};

// The consent write: expose (true → canary) or revoke (false → off) one
// venture on the MCP surface, through the audited config-plane writer.
// Returns the fresh persisted state { entity, stage, exposed, config_row_id }.
export const setMcpEntityExposure = async ({ firmId, clientId, expose, reason = null } = {}) => {
  const response = await firmFetch('/api/donna/firms/mcp-exposure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      firm_id: firmId || undefined,
      client_id: clientId,
      expose,
      reason: reason || null
    })
  });
  return parseJsonResponse(response);
};

// Descent ladder (Q5): the read-only model-lane report for the AI runtime
// settings surface — the lane registry + aggregated challenger receipts.
// GETs the firm-member-gated endpoint. Returns { table_present, lanes }.
export const fetchModelLanes = async ({ firmId, signal } = {}) => {
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  const qs = params.toString();
  const response = await firmFetch(
    `/api/donna/firms/model-lanes${qs ? `?${qs}` : ''}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }
  );
  return parseJsonResponse(response);
};

export const fetchRuntimePolicyIncidents = async ({ firmId, signal, after } = {}) => {
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  if (after) params.set('after', after);
  return parseJsonResponse(await firmFetch(`/api/donna/firms/runtime-policy-incidents?${params}`, {
    method: 'GET', headers: { Accept: 'application/json' }, signal
  }));
};

export const actOnRuntimePolicyIncident = async ({ firmId, failureId, action, idempotencyKey, repairNote } = {}) => {
  if (!['claim', 'retry'].includes(action)) throw new Error('Unknown runtime repair action.');
  return parseJsonResponse(await firmFetch(`/api/donna/firms/runtime-policy-incidents/${encodeURIComponent(failureId)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ firm_id: firmId, idempotency_key: idempotencyKey, repair_note: repairNote })
  }));
};

// Descent ladder Q6c (the model lab): set or clear a lane's deciding-model
// policy. `model` must come from the lane's qualified set (the server
// refuses anything else); null/'' clears back to the strong default. Every
// flip is receipted server-side.
export const setModelLanePolicy = async ({ firmId, lane, model = null, clientId = null, reason = null } = {}) => {
  const response = await firmFetch('/api/donna/firms/model-lanes/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      firm_id: firmId || undefined,
      lane,
      model: model || null,
      client_id: clientId || null,
      reason: reason || null
    })
  });
  return parseJsonResponse(response);
};

// Donna Loops Phase 4: list the client's open close blockers for the read-only
// dashboard. GETs the firm-access-gated endpoint. Returns { enabled, cases }.
// When LOOPS_SHADOW is off (prod default) — or the spine migration is absent —
// the server returns enabled:false with an empty list, so the dashboard stays
// hidden and prod is unchanged until the flag is validated in dev.
export const fetchCloseBlockers = async ({ firmId, clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchCloseBlockers: clientId is required');
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  params.set('client_id', clientId);
  const response = await firmFetch(
    `/api/donna/firms/close-blockers?${params.toString()}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }
  );
  return parseJsonResponse(response);
};

// Donna Loops Step 8: list the client's RESOLVED goals (terminal cases whose latest
// goal report is met/waived) for the read-only "resolved" dashboard — the complement
// of fetchCloseBlockers. Same firm-access-gated, double-gated endpoint: when
// LOOPS_SHADOW is off (prod default) or the spine/goal migration is absent the server
// returns enabled:false with an empty list, so the dashboard stays hidden until the
// flag is validated. Returns { enabled, cases }.
export const fetchResolvedGoals = async ({ firmId, clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchResolvedGoals: clientId is required');
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  params.set('client_id', clientId);
  const response = await firmFetch(
    `/api/donna/firms/resolved-goals?${params.toString()}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }
  );
  return parseJsonResponse(response);
};

// Slice 2 (realtime-truthful-feedback arc): the polled changes-cursor read.
// Bootstrap by omitting `cursor` — the server answers with its current
// high-water marks and no rows (the page just rendered a fresh snapshot; the
// tick only carries what happens after it). Subsequent polls pass the cursor
// back whole. Returns the unwrapped projection:
// { client_id, events, documents, transactions, cursor }.
export const fetchFeedEvents = async ({ firmId, clientId, cursor = null, signal } = {}) => {
  if (!clientId) throw new Error('fetchFeedEvents: clientId is required');
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  params.set('client_id', clientId);
  if (cursor && cursor.event_id !== null && cursor.event_id !== undefined && cursor.ts) {
    params.set('since_event_id', String(cursor.event_id));
    params.set('since_ts', cursor.ts);
  }
  const response = await firmFetch(
    `/api/donna/firms/feed-events?${params.toString()}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }
  );
  const body = await parseJsonResponse(response);
  return body?.feed_events || body || {};
};

// Governance: dismiss a firm fact by its stable id (the #422 id rail). POSTs to
// the firm-member-gated dismiss endpoint; the server flips firm_facts.status to
// 'dismissed' via the single writer. Returns { dismissed, fact_id }.
export const dismissFirmFact = async ({ factId, firmId, signal } = {}) => {
  if (!factId) throw new Error('dismissFirmFact: factId is required');
  const response = await firmFetch(
    `/api/donna/firms/firm-facts/${encodeURIComponent(factId)}/dismiss`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ firm_id: firmId }),
      signal
    }
  );
  return parseJsonResponse(response);
};

// Desktop backups (settings Data & storage card). GET lists the verified
// packages on this appliance ({enabled, backups, cron}); on a cloud host the
// server answers {enabled:false} rather than erroring. POST runs one now
// through the same machinery as the daily cron.
export const fetchDesktopBackups = async ({ firmId, signal } = {}) => {
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  const response = await firmFetch(
    `/api/donna/firms/desktop-backups${params.size ? `?${params}` : ''}`,
    { method: 'GET', headers: { Accept: 'application/json' }, signal }
  );
  return parseJsonResponse(response);
};

export const runDesktopBackup = async ({ firmId, signal } = {}) => {
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  const response = await firmFetch(
    `/api/donna/firms/desktop-backups${params.size ? `?${params}` : ''}`,
    { method: 'POST', headers: { Accept: 'application/json' }, signal }
  );
  return parseJsonResponse(response);
};

// Donna Loops Phase 6.2: list a client's memory candidates (the governance
// front-gate to firm_facts) for the resolve surface. GETs the firm-access-gated,
// client-scoped endpoint. Returns { enabled, candidates }. When LOOPS_SHADOW is
// off (prod default) — or migration 036 is absent — the server returns
// enabled:false with an empty list, so the panel/tab stays hidden until the flag
// is validated in dev. 'conflicted' candidates carry conflicts_with (the
// contradicting active facts) for the resolve UI.
export const fetchMemoryCandidates = async ({ firmId, clientId, status, signal } = {}) => {
  if (!clientId) throw new Error('fetchMemoryCandidates: clientId is required');
  const params = new URLSearchParams();
  if (firmId) params.set('firm_id', firmId);
  params.set('client_id', clientId);
  if (status) params.set('status', status);
  const response = await firmFetch(
    `/api/donna/firms/memory-candidates?${params.toString()}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }
  );
  return parseJsonResponse(response);
};

// Donna Loops Phase 6.2: the human "yes" — promote a memory candidate into
// firm_facts. POSTs the flag-gated, client-scoped write endpoint; the server
// mints the fact via the single saveFirmFact writer and marks the candidate
// promoted. Returns { enabled, promoted, factId, candidate_id }.
// DMEM-R1 W1: the governance write fails closed without the legal entity AND the
// `expected_version` the list returned for the candidate (its `version` field) —
// a candidate that changed since the human read it is refused, never acted on.
export const promoteMemoryCandidate = async ({ candidateId, firmId, clientId, expectedVersion, signal } = {}) => {
  if (!candidateId) throw new Error('promoteMemoryCandidate: candidateId is required');
  const response = await firmFetch(
    `/api/donna/firms/memory-candidates/${encodeURIComponent(candidateId)}/promote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ firm_id: firmId, client_id: clientId, expected_version: expectedVersion || null }),
      signal
    }
  );
  return parseJsonResponse(response);
};

// Donna Loops Phase 6.2: the human "no" — dismiss a memory candidate. POSTs the
// flag-gated, client-scoped write endpoint; the server flips the candidate to
// dismissed and cascades to retire any firm_fact it minted so the rejected
// learning stops influencing context. Returns { enabled, dismissed, candidate_id }.
export const dismissMemoryCandidate = async ({ candidateId, firmId, clientId, expectedVersion, signal } = {}) => {
  if (!candidateId) throw new Error('dismissMemoryCandidate: candidateId is required');
  const response = await firmFetch(
    `/api/donna/firms/memory-candidates/${encodeURIComponent(candidateId)}/dismiss`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ firm_id: firmId, client_id: clientId, expected_version: expectedVersion || null }),
      signal
    }
  );
  return parseJsonResponse(response);
};

// `firmId` is forwarded when the caller has it (RT-03): the server keys the
// evidence and checks readiness under the firm the request names, else under
// its live default firm — never a demo-tenant literal.
export const createFirmDocumentUploadUrl = async ({
  firmId,
  clientId,
  filename,
  mimeType,
  size,
  evidenceRequestId,
  transactionId,
  checksumSha256,
  signal
} = {}) => {
  if (!clientId) throw new Error('createFirmDocumentUploadUrl: clientId is required');
  const response = await firmFetch('/api/donna/firms/documents/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      ...(firmId ? { firm_id: firmId } : {}),
      client_id: clientId,
      filename,
      mime_type: mimeType,
      size,
      evidence_request_id: evidenceRequestId,
      transaction_id: transactionId,
      checksum_sha256: checksumSha256
    }),
    signal
  });
  return parseJsonResponse(response);
};

export const updateFirmTransaction = async (transactionId, patch) => {
  const response = await firmFetch(`/api/donna/firms/transactions/${encodeURIComponent(transactionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ patch })
  });
  return parseJsonResponse(response);
};

export const refreshFirmTransactionIntel = async ({ clientIds = [] } = {}) => {
  const response = await firmFetch('/api/donna/firms/transaction-intel/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_ids: clientIds })
  });
  return parseJsonResponse(response);
};

export const suggestFirmTransactionCoding = async (transactionId) => {
  const response = await firmFetch('/api/donna/firms/transaction-intel/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ transaction_id: transactionId })
  });
  return parseJsonResponse(response);
};

export const batchSuggestFirmTransactionCoding = async ({ clientIds = [], limit = 80, autoApply = true } = {}) => {
  const response = await firmFetch('/api/donna/firms/transaction-intel/batch-suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_ids: clientIds,
      limit,
      auto_apply: autoApply
    })
  });
  return parseJsonResponse(response);
};

export const updateFirmReconciliationMatch = async (matchId, patch) => {
  const response = await firmFetch(`/api/donna/firms/reconciliation-matches/${encodeURIComponent(matchId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ patch })
  });
  return parseJsonResponse(response);
};

// Manual link-to-transaction — firm pairs a receipt with a bank
// transaction. POSTs to `/reconciliation-matches`; the writer creates
// a confirmed match row with `created_by='firm'` and cascades the
// usual confirmed-branch updates (transactions → reconciled,
// documents → paid, review queue → resolved). On success the response
// envelope is `{ match_id, matched_object_type, snapshot }`.
export const createFirmManualLink = async ({ documentId, bankTransactionId, reviewerNote = null, firmId = undefined, clientId }) => {
  const body = {
    document_id: documentId,
    bank_transaction_id: bankTransactionId,
    reviewer_note: reviewerNote
  };
  if (firmId) body.firm_id = firmId;
  if (clientId) body.client_id = clientId;
  const response = await firmFetch('/api/donna/firms/reconciliation-matches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  return parseJsonResponse(response);
};

// Reconciliation PR 5 — firm commit/discard for proposed learned rules.
// Routes both Commit (`status: 'active'`) and Discard (`status:
// 'retired'`) through the same endpoint. The writer enforces the
// prior-state guard (only `proposed` is a legal source).
export const updateFirmClientRule = async (ruleId, patch) => {
  const response = await firmFetch(`/api/donna/firms/client-rules/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ patch })
  });
  return parseJsonResponse(response);
};

export const updateFirmTransactionReviewItem = async (reviewItemId, patch) => {
  const response = await firmFetch(`/api/donna/firms/transaction-review/${encodeURIComponent(reviewItemId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ patch })
  });
  return parseJsonResponse(response);
};

// Convenience wrapper for the canonical workflow contract. Always sends
// snake_case `review_state` (backend accepts either, snake_case is the
// canonical form we standardise on). Combine with extra patch fields when
// the same call needs to record more — e.g. category override on Apply.
export const setTransactionReviewItemState = async (reviewItemId, reviewState, extraPatch = {}) =>
  updateFirmTransactionReviewItem(reviewItemId, { ...extraPatch, review_state: reviewState });

export const fetchClientEvidenceRequests = async ({ clientId, periodStart, periodEnd, status, signal } = {}) => {
  if (!clientId) throw new Error('fetchClientEvidenceRequests: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  if (status) params.set('status', status);
  const response = await firmFetch(`/api/donna/firms/evidence/requests?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const createClientEvidenceRequest = async ({
  clientId,
  transactionId,
  reviewItemId,
  question,
  evidenceType,
  dueAt,
  signal
} = {}) => {
  if (!clientId) throw new Error('createClientEvidenceRequest: clientId is required');
  const response = await firmFetch('/api/donna/firms/evidence/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      transaction_id: transactionId,
      review_item_id: reviewItemId,
      question,
      evidence_type: evidenceType,
      due_at: dueAt
    }),
    signal
  });
  return parseJsonResponse(response);
};

export const resolveClientEvidenceRequest = async ({
  evidenceRequestId,
  reply,
  documentIds = [],
  reviewState,
  resolutionNote,
  // A1: set when a FIRM principal records the client's out-of-band answer
  // ('phone' | 'email' | 'in_person' | 'other'). Presence switches the server
  // to the firm-attributed lane (actor_type 'firm', source on the audit row).
  answerSource,
  signal
} = {}) => {
  if (!evidenceRequestId) throw new Error('resolveClientEvidenceRequest: evidenceRequestId is required');
  const response = await firmFetch(`/api/donna/firms/evidence/requests/${encodeURIComponent(evidenceRequestId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      reply,
      document_ids: documentIds,
      review_state: reviewState,
      resolution_note: resolutionNote,
      ...(answerSource ? { answer_source: answerSource } : {})
    }),
    signal
  });
  return parseJsonResponse(response);
};

export const acceptClientEvidenceRequest = async ({
  evidenceRequestId,
  reviewState = 'accepted',
  resolutionNote,
  signal
} = {}) => {
  if (!evidenceRequestId) throw new Error('acceptClientEvidenceRequest: evidenceRequestId is required');
  const response = await firmFetch(`/api/donna/firms/evidence/requests/${encodeURIComponent(evidenceRequestId)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      review_state: reviewState,
      resolution_note: resolutionNote
    }),
    signal
  });
  return parseJsonResponse(response);
};

export const rejectClientEvidenceRequest = async ({
  evidenceRequestId,
  rejectionReason,
  followUpQuestion,
  dueAt,
  signal
} = {}) => {
  if (!evidenceRequestId) throw new Error('rejectClientEvidenceRequest: evidenceRequestId is required');
  const response = await firmFetch(`/api/donna/firms/evidence/requests/${encodeURIComponent(evidenceRequestId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      rejection_reason: rejectionReason,
      follow_up_question: followUpQuestion,
      due_at: dueAt
    }),
    signal
  });
  return parseJsonResponse(response);
};

// ── Xero connection ──────────────────────────────────────────────────────────
// Backend is source of truth. These helpers mirror the contract documented at
// /api/donna/firms/xero/{connect,status,sync-reference-data,callback}.

export const connectXero = async ({ clientId, returnTo, signal } = {}) => {
  if (!clientId) throw new Error('connectXero: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  if (returnTo) params.set('return_to', returnTo);
  const response = await firmFetch(`/api/donna/firms/xero/connect?${params}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Marks the client's connection disconnected (DB-only — re-connecting re-runs
// OAuth). Rides /xero/disconnect, which dispatches by the client's
// accounting_system — a Xero client tears down its Xero connection, a QBO client
// its QBO connection — exactly like connectXero/syncXeroReferenceData. So this
// one call serves both systems; there is no separate connect/disconnect-Qbo.
export const disconnectAccounting = async ({ clientId, connectionId, signal } = {}) => {
  if (!clientId) throw new Error('disconnectAccounting: clientId is required');
  const body = { client_id: clientId };
  if (connectionId) body.connection_id = connectionId;
  const response = await firmFetch('/api/donna/firms/xero/disconnect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

export const fetchXeroStatus = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchXeroStatus: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/xero/status?${params}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const syncXeroReferenceData = async ({ clientId, connectionId, signal } = {}) => {
  if (!clientId) throw new Error('syncXeroReferenceData: clientId is required');
  const body = { client_id: clientId };
  if (connectionId) body.connection_id = connectionId;
  const response = await firmFetch('/api/donna/firms/xero/sync-reference-data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

// Procountor reference sync (verb 2.1b). Posts to /procountor/sync-reference-data,
// which dispatches by the client's accounting_system to procountorAdapter
// .syncReferenceData — pulls chart of accounts, dimensions, business partners +
// bank accounts. Returns the fresh source:'database' snapshot, same as Xero.
export const syncProcountorReferenceData = async ({ clientId, connectionId, signal } = {}) => {
  if (!clientId) throw new Error('syncProcountorReferenceData: clientId is required');
  const body = { client_id: clientId };
  if (connectionId) body.connection_id = connectionId;
  const response = await firmFetch('/api/donna/firms/procountor/sync-reference-data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

export const provisionXeroChartOfAccounts = async ({
  clientId,
  connectionId,
  dryRun = true,
  signal
} = {}) => {
  if (!clientId) throw new Error('provisionXeroChartOfAccounts: clientId is required');
  const body = {
    client_id: clientId,
    dry_run: dryRun
  };
  if (connectionId) body.connection_id = connectionId;
  const response = await firmFetch('/api/donna/firms/xero/provision-coa', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

export const writebackXeroTransaction = async ({
  clientId,
  transactionId,
  connectionId,
  dryRun = true,
  force = false,
  signal
} = {}) => {
  if (!clientId) throw new Error('writebackXeroTransaction: clientId is required');
  if (!transactionId) throw new Error('writebackXeroTransaction: transactionId is required');
  const body = {
    client_id: clientId,
    transaction_id: transactionId,
    dry_run: dryRun,
    force
  };
  if (connectionId) body.connection_id = connectionId;
  const response = await firmFetch('/api/donna/firms/xero/writeback-transaction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

export const postLedgerTransaction = async ({
  clientId,
  transactionId,
  dryRun = true,
  force = false,
  signal
} = {}) => {
  if (!clientId) throw new Error('postLedgerTransaction: clientId is required');
  if (!transactionId) throw new Error('postLedgerTransaction: transactionId is required');
  const response = await firmFetch('/api/donna/firms/ledger/post-transaction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      transaction_id: transactionId,
      dry_run: dryRun,
      force
    }),
    signal
  });
  return parseJsonResponse(response);
};

export const postLedgerPeriod = async ({
  clientId,
  periodStart,
  periodEnd,
  dryRun = true,
  force = false,
  reviewStates = ['accepted'],
  limit,
  signal
} = {}) => {
  if (!clientId) throw new Error('postLedgerPeriod: clientId is required');
  const body = {
    client_id: clientId,
    period_start: periodStart,
    period_end: periodEnd,
    dry_run: dryRun,
    force,
    review_states: reviewStates
  };
  if (limit != null) body.limit = limit;
  const response = await firmFetch('/api/donna/firms/ledger/post-period', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

export const postLedgerAdjustment = async ({
  clientId,
  originalJournalId,
  transactionId,
  journalDate,
  reason,
  lines = [],
  reverseOriginal = true,
  signal
} = {}) => {
  if (!clientId) throw new Error('postLedgerAdjustment: clientId is required');
  const response = await firmFetch('/api/donna/firms/ledger/adjustment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      original_journal_id: originalJournalId,
      transaction_id: transactionId,
      journal_date: journalDate,
      reason,
      lines,
      reverse_original: reverseOriginal
    }),
    signal
  });
  return parseJsonResponse(response);
};

const appendPeriodParams = (params, { clientId, periodStart, periodEnd } = {}) => {
  if (clientId) params.set('client_id', clientId);
  if (periodStart) params.set('period_start', periodStart);
  if (periodEnd) params.set('period_end', periodEnd);
  return params;
};

export const fetchLedgerPeriod = async ({ clientId, periodStart, periodEnd, signal } = {}) => {
  if (!clientId) throw new Error('fetchLedgerPeriod: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  const response = await firmFetch(`/api/donna/firms/ledger/period?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Read-only financial statements (P&L + Balance Sheet + Trial Balance) from
// Donna's posted ledger. `basis` is 'accrual' (default) or 'cash'.
export const fetchFinancialReport = async ({ clientId, periodStart, periodEnd, basis, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinancialReport: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  if (basis) params.set('basis', basis);
  const response = await firmFetch(`/api/donna/firms/reports/financial-statements?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// FI-12 read surface: the persisted Finland annual-return verdict (form 5),
// verbatim from the deterministic DB caller. 403 FINLAND_ANNUAL_RETURN_DISABLED
// when the client's flag is off — callers treat that as "surface hidden".
export const fetchFinlandAnnualReturn = async ({ clientId, taxYear, basis, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandAnnualReturn: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  if (taxYear) params.set('tax_year', String(taxYear));
  if (basis) params.set('basis', basis);
  const response = await firmFetch(`/api/donna/firms/reports/finland-annual-return?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// FI-3 read surface: the deterministic ALV-return envelope for a verokausi
// (period 'YYYY-MM' | 'YYYY-QN' | 'YYYY'), with the persisted alv_returns
// lifecycle row attached. 403 FINLAND_ALV_RETURN_DISABLED when the client's
// flag is off — callers treat that as "surface hidden".
export const fetchFinlandAlvReturn = async ({ clientId, period, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandAlvReturn: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  if (period) params.set('period', String(period));
  const response = await firmFetch(`/api/donna/firms/reports/finland-alv-return?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const fetchGbVatReturn = async ({ clientId, period, signal } = {}) => {
  if (!clientId) throw new Error('fetchGbVatReturn: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  if (period) params.set('period', String(period));
  const response = await firmFetch(`/api/donna/firms/reports/gb-vat-return?${params.toString()}`, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  return parseJsonResponse(response);
};
export const fetchGbStatutory = async ({ clientId, signal } = {}) => { const params = new URLSearchParams({ client_id: clientId }); const response = await firmFetch(`/api/donna/firms/reports/gb-statutory?${params.toString()}`, { method: 'GET', headers: { Accept: 'application/json' }, signal }); return parseJsonResponse(response); };
export const fetchGbLtdClose = async ({ clientId, signal } = {}) => { const params = new URLSearchParams({ client_id: clientId }); const response = await firmFetch(`/api/donna/firms/reports/gb-ltd-close?${params.toString()}`, { method: 'GET', headers: { Accept: 'application/json' }, signal }); return parseJsonResponse(response); };

// C-1c (FI-15): the quotes read surface — issued_quotes rows annotated at read
// time + the open/sent/converted funnel with its Finnish summary line. 403
// FINLAND_QUOTES_DISABLED when the client's flag is off — callers treat that
// as "surface hidden".
export const fetchFinlandQuotes = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandQuotes: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/reports/finland-quotes?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// G-3 follow-up (FI-15): the Suomi.fi mandate status envelope — the persisted
// grant + the dated validity evaluation the filing gate itself uses. Read-only
// and unflagged on the server; callers gate the fetch on the ALV surface being
// live so the strip never renders for a non-Finnish book.
export const fetchFinlandSuomifiMandate = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandSuomifiMandate: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/reports/finland-suomifi-mandate?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// FI production-readiness P0: the ALV registration-threshold watch envelope for
// a non-registered Finnish client (calendar-year turnover vs €20,000). 403
// FINLAND_ALV_THRESHOLD_WATCH_DISABLED when the client's flag is off — callers
// treat that as "surface hidden".
export const fetchFinlandAlvThresholdWatch = async ({ clientId, year, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandAlvThresholdWatch: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  if (year) params.set('year', String(year));
  const response = await firmFetch(`/api/donna/firms/reports/finland-alv-threshold?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// G-7 (FI-15): the scope-drift envelope — deterministic drift triggers + the
// closed verdict for a Finnish pilot book. 403
// FINLAND_SCOPE_DRIFT_WATCH_DISABLED when the client's flag is off — callers
// treat that as "surface hidden".
export const fetchFinlandScopeDrift = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandScopeDrift: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/reports/finland-scope-drift?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// G-4 (FI-15): the YEL watch envelope — profile + premium signals, closed
// status enum, never determines the income. 403 FINLAND_YEL_WATCH_DISABLED
// when the client's flag is off — callers treat that as "surface hidden".
export const fetchFinlandYelStatus = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandYelStatus: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/reports/finland-yel?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// G-5 (FI-15): the ennakkovero watch envelope — posted-ledger profit forecast
// + the owner-recorded Vero decision, closed status enum, never computes a
// tax amount. 403 FINLAND_ENNAKKOVERO_WATCH_DISABLED when the client's flag
// is off — callers treat that as "surface hidden".
export const fetchFinlandEnnakkoveroStatus = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandEnnakkoveroStatus: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/reports/finland-ennakkovero?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// G-8 (FI-15): the issued-invoice payment-awareness envelope — issued invoices
// + issued credit notes + viitenumero-matched bank lines onto closed payment
// states, evaluated at read time (deterministic, no LLM). 403
// FINLAND_INVOICING_DISABLED when the client's flag is off — callers treat
// that as "surface hidden".
export const fetchFinlandIssuedInvoices = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandIssuedInvoices: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/reports/finland-issued-invoices?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// G-6 (FI-15): the prepayment-register watch envelope — own status + supplier
// verdicts from persisted, dated registry checks; never calls the registry at
// render time. 403 FINLAND_PREPAYMENT_REGISTER_WATCH_DISABLED when the
// client's flag is off — callers treat that as "surface hidden".
export const fetchFinlandPrepaymentRegister = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchFinlandPrepaymentRegister: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  const response = await firmFetch(`/api/donna/firms/reports/finland-prepayment-register?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Triggers a browser download of the financial statements as PDF or CSV. The
// bytes are generated server-side from the same posted-ledger report (one source
// of truth), so a download can never diverge from what is on screen.
export const downloadFinancialReport = async ({ clientId, periodStart, periodEnd, basis, format = 'pdf' } = {}) => {
  if (!clientId) throw new Error('downloadFinancialReport: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  if (basis) params.set('basis', basis);
  params.set('format', format);
  const response = await firmFetch(`/api/donna/firms/reports/financial-statements?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: format === 'csv' ? 'text/csv' : 'application/pdf' }
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(formatFirmError(detail, `Could not download the ${format.toUpperCase()} report.`));
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : `donna-financial-statements.${format}`;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { filename };
};

export const fetchLedgerAuditTrail = async ({
  clientId,
  transactionId,
  ledgerJournalId,
  periodStart,
  periodEnd,
  signal
} = {}) => {
  if (!clientId) throw new Error('fetchLedgerAuditTrail: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  if (transactionId) params.set('transaction_id', transactionId);
  if (ledgerJournalId) params.set('ledger_journal_id', ledgerJournalId);
  const response = await firmFetch(`/api/donna/firms/ledger/audit-trail?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const fetchClosePeriodPreview = async ({ clientId, periodStart, periodEnd, signal } = {}) => {
  if (!clientId) throw new Error('fetchClosePeriodPreview: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  const response = await firmFetch(`/api/donna/firms/close/period-preview?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const fetchCloseDiagnostics = async ({ clientId, periodStart, periodEnd, signal } = {}) => {
  if (!clientId) throw new Error('fetchCloseDiagnostics: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  const response = await firmFetch(`/api/donna/firms/close/diagnostics?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const fetchCloseExceptions = async ({ clientId, periodStart, periodEnd, signal } = {}) => {
  if (!clientId) throw new Error('fetchCloseExceptions: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  const response = await firmFetch(`/api/donna/firms/close/exceptions?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const fetchCloseArchivePreview = async ({ clientId, periodStart, periodEnd, signal } = {}) => {
  if (!clientId) throw new Error('fetchCloseArchivePreview: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  const response = await firmFetch(`/api/donna/firms/close/archive-preview?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const createCloseArchive = async ({ clientId, periodStart, periodEnd, signal } = {}) => {
  if (!clientId) throw new Error('createCloseArchive: clientId is required');
  const response = await firmFetch('/api/donna/firms/close/archive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      period_start: periodStart,
      period_end: periodEnd
    }),
    signal
  });
  return parseJsonResponse(response);
};

export const fetchCloseArchiveExport = async ({ clientId, archiveId, periodStart, periodEnd, signal } = {}) => {
  if (!clientId && !archiveId) throw new Error('fetchCloseArchiveExport: clientId or archiveId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  if (archiveId) params.set('archive_id', archiveId);
  const response = await firmFetch(`/api/donna/firms/close/archive-export?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const fetchXeroMirrorDiff = async ({ clientId, periodStart, periodEnd, signal } = {}) => {
  if (!clientId) throw new Error('fetchXeroMirrorDiff: clientId is required');
  const params = appendPeriodParams(new URLSearchParams(), { clientId, periodStart, periodEnd });
  const response = await firmFetch(`/api/donna/firms/xero/mirror-diff?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

export const retryXeroMirror = async ({
  clientId,
  periodStart,
  periodEnd,
  transactionIds = [],
  dryRun = true,
  force = false,
  limit,
  signal
} = {}) => {
  if (!clientId) throw new Error('retryXeroMirror: clientId is required');
  const body = {
    client_id: clientId,
    period_start: periodStart,
    period_end: periodEnd,
    transaction_ids: transactionIds,
    dry_run: dryRun,
    force
  };
  if (limit != null) body.limit = limit;
  const response = await firmFetch('/api/donna/firms/xero/mirror-retry', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

export const verifyXeroMirror = async ({
  clientId,
  periodStart,
  periodEnd,
  transactionIds = [],
  connectionId,
  limit,
  signal
} = {}) => {
  if (!clientId) throw new Error('verifyXeroMirror: clientId is required');
  const body = {
    client_id: clientId,
    period_start: periodStart,
    period_end: periodEnd,
    transaction_ids: transactionIds
  };
  if (connectionId) body.connection_id = connectionId;
  if (limit != null) body.limit = limit;
  const response = await firmFetch('/api/donna/firms/xero/mirror-verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

const periodActionBody = ({ clientId, periodStart, periodEnd, force } = {}) => ({
  client_id: clientId,
  period_start: periodStart,
  period_end: periodEnd,
  force: force === true
});

export const runCloseChecks = async ({ clientId, periodStart, periodEnd, force = false, signal } = {}) => {
  if (!clientId) throw new Error('runCloseChecks: clientId is required');
  const response = await firmFetch('/api/donna/firms/close/checks/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(periodActionBody({ clientId, periodStart, periodEnd, force })),
    signal
  });
  return parseJsonResponse(response);
};

export const lockClosePeriod = async ({ clientId, periodStart, periodEnd, force = false, signal } = {}) => {
  if (!clientId) throw new Error('lockClosePeriod: clientId is required');
  const response = await firmFetch('/api/donna/firms/close/lock', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(periodActionBody({ clientId, periodStart, periodEnd, force })),
    signal
  });
  return parseJsonResponse(response);
};

export const writebackXeroTransactions = async ({
  clientId,
  transactionIds = [],
  connectionId,
  dryRun = true,
  force = false,
  limit,
  signal
} = {}) => {
  if (!clientId) throw new Error('writebackXeroTransactions: clientId is required');
  const body = {
    client_id: clientId,
    transaction_ids: transactionIds,
    dry_run: dryRun,
    force
  };
  if (connectionId) body.connection_id = connectionId;
  if (limit != null) body.limit = limit;
  const response = await firmFetch('/api/donna/firms/xero/writeback-transactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

// Mirror the posted Donna ledger to the client's accounting system. Rides the
// same /xero/writeback-transactions route, which dispatches by accounting_system
// — for a QBO client it posts JournalEntry rows. include_all + execute; for the
// Xero bank-transaction path include_all widens SCOPE ONLY (candidate cap 250) —
// the server applies the settled-verdict filter unconditionally, so parked /
// Suspense rows never export (idempotency doc §8.5). Returns the snapshot +
// xero_writeback_batch payload.
export const mirrorLedgerToAccounting = async ({ clientId, connectionId, limit, dryRun = false, signal } = {}) => {
  if (!clientId) throw new Error('mirrorLedgerToAccounting: clientId is required');
  const body = { client_id: clientId, include_all: true };
  if (dryRun) body.dry_run = true;
  else body.execute = true;
  if (connectionId) body.connection_id = connectionId;
  if (limit != null) body.limit = limit;
  const response = await firmFetch('/api/donna/firms/xero/writeback-transactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  return parseJsonResponse(response);
};

// Procountor M2M connect — Procountor provisions our client for the
// client_credentials grant, not the interactive OAuth flow, so there is no
// redirect: the operator pastes a Procountor API key (created in Procountor UI)
// and the server mints a token from it and stores the connection. Returns the
// snapshot + procountor_connection.
export const connectProcountorWithApiKey = async ({ clientId, apiKey, signal } = {}) => {
  if (!clientId) throw new Error('connectProcountorWithApiKey: clientId is required');
  if (!apiKey) throw new Error('connectProcountorWithApiKey: apiKey is required');
  const response = await firmFetch('/api/donna/firms/procountor/connect-apikey', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ client_id: clientId, api_key: apiKey }),
    signal
  });
  return parseJsonResponse(response);
};

// ── G15/D12 — the owner Actions surface (workspace tab) ─────────────────────
// One read + three writer-routed mutations; the server half lives in
// server/donna/outbound/ownerActionsSurface.js. The read renders the SAME
// persisted state the digest email gathers.

export const fetchOutboundOwnerActions = async ({ clientId, signal } = {}) => {
  if (!clientId) throw new Error('fetchOutboundOwnerActions: clientId is required');
  const response = await firmFetch(
    `/api/donna/firms/outbound/owner-actions?client_id=${encodeURIComponent(clientId)}`,
    { method: 'GET', headers: { Accept: 'application/json' }, signal }
  );
  return parseJsonResponse(response);
};

export const decideOutboundOwnerAction = async ({ clientId, actionId, decision, signal } = {}) => {
  if (!clientId || !actionId) throw new Error('decideOutboundOwnerAction: clientId and actionId are required');
  const response = await firmFetch('/api/donna/firms/outbound/owner-actions/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, action_id: actionId, decision }),
    signal
  });
  return parseJsonResponse(response);
};

export const editOutboundOwnerDraft = async ({ clientId, actionId, renderValues, signal } = {}) => {
  if (!clientId || !actionId) throw new Error('editOutboundOwnerDraft: clientId and actionId are required');
  const response = await firmFetch('/api/donna/firms/outbound/owner-actions/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, action_id: actionId, render_values: renderValues || {} }),
    signal
  });
  return parseJsonResponse(response);
};

export const setOutboundOwnerPartyLanguage = async ({
  clientId, actionId, attribute, language, signal
} = {}) => {
  if (!clientId || !actionId) throw new Error('setOutboundOwnerPartyLanguage: clientId and actionId are required');
  const response = await firmFetch('/api/donna/firms/outbound/owner-actions/party-language', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId, action_id: actionId, attribute, language
    }),
    signal
  });
  return parseJsonResponse(response);
};

export const markOutboundOwnerActionWrong = async ({ clientId, actionId, signal } = {}) => {
  if (!clientId || !actionId) throw new Error('markOutboundOwnerActionWrong: clientId and actionId are required');
  const response = await firmFetch('/api/donna/firms/outbound/owner-actions/mark-wrong', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, action_id: actionId }),
    signal
  });
  return parseJsonResponse(response);
};

export const reverseOutboundOwnerActionPost = async ({ clientId, actionId, signal } = {}) => {
  if (!clientId || !actionId) throw new Error('reverseOutboundOwnerActionPost: clientId and actionId are required');
  const response = await firmFetch('/api/donna/firms/outbound/owner-actions/reverse-post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, action_id: actionId }),
    signal
  });
  return parseJsonResponse(response);
};

export const actOnOutboundOwnerCase = async ({ clientId, caseId, verb, reason, signal } = {}) => {
  if (!clientId || !caseId) throw new Error('actOnOutboundOwnerCase: clientId and caseId are required');
  const response = await firmFetch('/api/donna/firms/outbound/owner-actions/case', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, case_id: caseId, verb, ...(reason ? { reason } : {}) }),
    signal
  });
  return parseJsonResponse(response);
};

// ── Universal @mentions (slice 3): the artifact comment lane ────────────────
// Typeahead roster: eligible actors on the client's artifacts (humans with
// entity access + the hired bench + the operator). Structured refs from this
// list are the ONLY way to mention — the server refuses anything else.
export const fetchMentionRoster = async ({ clientId, query = '', signal } = {}) => {
  if (!clientId) throw new Error('fetchMentionRoster: clientId is required');
  const params = new URLSearchParams({ client_id: clientId });
  if (query) params.set('query', query);
  const response = await firmFetch(`/api/donna/firms/mentions/roster?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Post a comment (or an edit-version, via supersedesMessageId) on an
// artifact's thread. flavor 'ask' with a single seat mention mints the
// blocking colleague question server-side; the response carries both the
// message row and the minted evidence_request.
export const postChatComment = async ({
  clientId,
  surface = 'transaction_chat',
  transactionId = null,
  documentId = null,
  text,
  flavor = 'mention',
  mentions = [],
  supersedesMessageId = null,
  signal
} = {}) => {
  if (!clientId) throw new Error('postChatComment: clientId is required');
  const response = await firmFetch('/api/donna/firms/chat-comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      surface,
      transaction_id: transactionId,
      document_id: documentId,
      kind: 'comment',
      text,
      flavor,
      mentions,
      supersedes_message_id: supersedesMessageId
    })
  });
  return parseJsonResponse(response);
};

export const resolveChatThread = async ({
  clientId,
  surface = 'transaction_chat',
  transactionId = null,
  documentId = null,
  outcomeNote = '',
  policyMemoryCandidate = false,
  signal
} = {}) => {
  if (!clientId) throw new Error('resolveChatThread: clientId is required');
  const response = await firmFetch('/api/donna/firms/chat-comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      surface,
      transaction_id: transactionId,
      document_id: documentId,
      kind: 'thread_resolution',
      text: outcomeNote,
      policy_memory_candidate: policyMemoryCandidate === true
    })
  });
  return parseJsonResponse(response);
};

// The caller's own Mentions lane (slice 4, D10): mention/assign notification
// rows + unread state, PLUS their open seat asks read live from the store of
// record, and the digest ("2 questions waiting on you · 3 mentions").
export const fetchMentionNotifications = async ({ unreadOnly = false, signal } = {}) => {
  const params = new URLSearchParams();
  if (unreadOnly) params.set('unread', '1');
  const qs = params.toString();
  const response = await firmFetch(`/api/donna/firms/mentions/notifications${qs ? `?${qs}` : ''}`, {
    headers: { Accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
};

// Mark the caller's own notification rows read (ids omitted = everything).
export const markMentionNotificationsRead = async ({ ids = null, signal } = {}) => {
  const response = await firmFetch('/api/donna/firms/mentions/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({ ...(Array.isArray(ids) ? { ids } : {}) })
  });
  return parseJsonResponse(response);
};

export const redactChatComment = async ({
  clientId,
  surface = 'transaction_chat',
  transactionId = null,
  documentId = null,
  messageId,
  reason = null,
  signal
} = {}) => {
  if (!clientId) throw new Error('redactChatComment: clientId is required');
  if (!messageId) throw new Error('redactChatComment: messageId is required');
  const response = await firmFetch('/api/donna/firms/chat-comments/redact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      surface,
      transaction_id: transactionId,
      document_id: documentId,
      message_id: messageId,
      reason
    })
  });
  return parseJsonResponse(response);
};

export const reviewFinnishPilotSetup = async ({ firmId, clientId, signal } = {}) => {
  const params = new URLSearchParams({ firm_id: firmId });
  return parseJsonResponse(await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/finnish-pilot-setup?${params}`, {
    method: 'GET', headers: { Accept: 'application/json' }, signal
  }));
};

export const prepareFinnishPilotSetup = async ({ firmId, clientId, profilePatch, clientVersion, signal } = {}) =>
  parseJsonResponse(await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/finnish-pilot-setup`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ firm_id: firmId, profile_patch: profilePatch, client_version: clientVersion, confirmed: true })
  }));
export const ownerRecoveryOperation = async ({ firmId, clientId, reviewDigest, signal } = {}) =>
  parseJsonResponse(await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/finnish-pilot-setup?${new URLSearchParams({firm_id:firmId,recovery:'owner'})}`, {
    method: reviewDigest ? 'POST' : 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal,
    ...(reviewDigest ? {body:JSON.stringify({firm_id:firmId,owner_recovery:{action:'approve',confirmed:true,review_digest:reviewDigest}})} : {})
  }));
export const cloudPilotOperation = async ({ firmId,clientId,action='review',reviewDigest,confirmed,signal }) => {
  const params = new URLSearchParams({firm_id:firmId});
  const read = ['review','send-review'].includes(action);
  const response = await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/cloud-pilot/${action}?${params}`,{
    method:read?'GET':'POST',signal,headers:{Accept:'application/json','Content-Type':'application/json'},
    ...(read?{}:{body:JSON.stringify({firm_id:firmId,review_digest:reviewDigest,confirmed})})
  });
  const payload=await response.json();
  if(!response.ok)throw Object.assign(new Error(coerceErrorMessage(payload.error,'Pilot action failed.')),{code:payload.code});
  return payload;
};

export const fetchFinnishProfileIntake = async ({ clientId, signal } = {}) => parseJsonResponse(await firmFetch(`/api/donna/firms/clients/${encodeURIComponent(clientId)}/profile`, { signal, headers: { Accept: 'application/json' } }));
