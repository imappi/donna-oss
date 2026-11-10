// Upload tray state — localStorage-backed persistence + label logic.
//
// PR 2 of docs/async-parsing-plan.md → "Frontend — upload tray with live
// progress". The tray is a flat list of rows; each row is a single file
// the user dropped. Tray state survives reload across the same browser
// tab via localStorage so a mid-parse refresh resurrects the rows.
//
// TTL: terminal rows drop after 24h; whole batches expire after 7d.

import { trayDocumentTypeLabel } from './interfaceValueLabels.js';
import { getBookPrincipalId, getBookSessionIdentity } from './bookSessionIdentity.js';
import { hasDesktopRuntimeAccess } from './desktopShell.js';
import { customerReference, documentFactFallback, documentFactMessageId } from './customerFailure.js';

const STORAGE_KEY = 'donna.uploadTray.v1';
// Legacy desktop custody stays on its original key. Authenticated web books
// never import that unscoped cache: every consumer (including the dock's poller
// and mount-time registration retry) reads the current principal's tray only.
const trayStorageKey = () => {
  const path = typeof window !== 'undefined' ? window.location?.pathname || '' : '';
  const realWebRoute = ['/firms', '/client', '/portal'].some((prefix) => path.toLowerCase().startsWith(prefix))
    && !hasDesktopRuntimeAccess();
  if (!realWebRoute) return STORAGE_KEY;
  const principal = getBookPrincipalId();
  return principal ? `${STORAGE_KEY}.user.${encodeURIComponent(principal)}` : null;
};

// Opaque operator keys can still upload, but without a durable user identity
// their progress stays in memory. Never copy bearer credentials into cache keys.
let transientIdentity = null;
let transientTray = { batches: [] };
const currentTransientTray = () => {
  const identity = getBookSessionIdentity();
  if (identity !== transientIdentity) {
    transientIdentity = identity;
    transientTray = { batches: [] };
  }
  return transientTray;
};

const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const BATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
// Register orphans (rows that never got a document_id) can't be
// revalidated against /parse-status — with the client gone their
// mount-time register retry fails forever, so without a TTL they show
// "Queued" until the 7d batch TTL. One day is plenty for the genuine
// resume-after-refresh case.
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const TERMINAL_PARSE_STATUSES = new Set(['completed', 'failed', 'skipped', 'duplicate_pending']);

const safeStorage = () => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
};

const readPersistedTray = () => {
  const key = trayStorageKey();
  if (!key) return currentTransientTray();
  const storage = safeStorage();
  if (!storage) return { batches: [] };
  try {
    const raw = storage.getItem(key);
    if (!raw) return { batches: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.batches)) return { batches: [] };
    return parsed;
  } catch {
    return { batches: [] };
  }
};

const writePersistedTray = (state) => {
  const key = trayStorageKey();
  if (!key) {
    currentTransientTray();
    transientTray = state;
    return;
  }
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Quota / private-mode failures shouldn't crash the tray.
  }
};

const now = () => Date.now();

const isTerminalRow = (row = {}) => TERMINAL_PARSE_STATUSES.has(row?.parse_status);

// Drop terminal rows that have aged out (24h), register orphans that
// have aged out (24h), and entire batches that have aged out (7d).
// Returns the pruned state.
export const pruneTrayState = (state = { batches: [] }) => {
  const t = now();
  const batches = (state.batches || [])
    .map((batch) => {
      const survivingRows = (batch.rows || []).filter((row) => {
        if (isTerminalRow(row)) {
          const reachedTerminalAt = row.terminal_at || row.completed_at || row.last_seen_at || batch.created_at || t;
          return t - reachedTerminalAt < TERMINAL_TTL_MS;
        }
        if (!row.document_id) {
          const lastSeen = row.last_seen_at || batch.created_at || t;
          return t - lastSeen < ORPHAN_TTL_MS;
        }
        return true;
      });
      return { ...batch, rows: survivingRows };
    })
    .filter((batch) => {
      const batchAge = t - (batch.created_at || t);
      const stillFresh = batchAge < BATCH_TTL_MS;
      return stillFresh && (batch.rows?.length || 0) > 0;
    });
  return { batches };
};

export const loadTrayState = () => pruneTrayState(readPersistedTray());

export const saveTrayState = (state) => {
  const pruned = pruneTrayState(state);
  writePersistedTray(pruned);
  return pruned;
};

let trayChangeListeners = [];

export const subscribeToTrayChanges = (listener) => {
  trayChangeListeners.push(listener);
  return () => {
    trayChangeListeners = trayChangeListeners.filter((entry) => entry !== listener);
  };
};

const notifyTrayChanged = (state) => {
  trayChangeListeners.forEach((listener) => {
    try { listener(state); } catch { /* listener errors are non-fatal */ }
  });
};

const stampRow = (row, extra = {}) => {
  const next = { ...row, ...extra, last_seen_at: now() };
  if (isTerminalRow(next) && !next.terminal_at) next.terminal_at = now();
  return next;
};

// Public mutation API. Each call reads → mutates → writes → notifies.
const mutate = (mutator) => {
  const state = loadTrayState();
  const next = mutator(state) || state;
  const saved = saveTrayState(next);
  notifyTrayChanged(saved);
  return saved;
};

export const startTrayBatch = ({ batchId, clientId, files = [] }) => {
  return mutate((state) => {
    const batch = {
      id: batchId,
      client_id: clientId,
      created_at: now(),
      rows: files.map((file, index) => ({
        // Tray-local id — distinct from the document_id we'll get from
        // /register, because at this point the file is still uploading
        // and may yet fail.
        row_id: `${batchId}-${index}`,
        filename: file?.filename || file?.name || 'file',
        size: Number(file?.size || 0),
        document_type: file?.document_type || null,
        document_id: null,
        parse_run_id: null,
        storage_bucket: null,
        storage_object_key: null,
        upload_progress: 0,
        upload_state: 'uploading',
        parse_status: null,
        parse_stage: null,
        parse_progress_current: null,
        parse_progress_total: null,
        parse_summary: null,
        parse_error: null,
        last_seen_at: now()
      }))
    };
    return { ...state, batches: [batch, ...(state.batches || [])] };
  });
};

const updateRow = (state, rowId, patch) => {
  return {
    ...state,
    batches: (state.batches || []).map((batch) => ({
      ...batch,
      rows: (batch.rows || []).map((row) =>
        row.row_id === rowId ? stampRow(row, patch) : row
      )
    }))
  };
};

export const setRowUploadProgress = ({ rowId, progress }) =>
  mutate((state) => updateRow(state, rowId, { upload_progress: Math.max(0, Math.min(1, progress)) }));

export const setRowUploaded = ({ rowId, storageBucket, storageObjectKey, checksum, storedSize, mimeType }) =>
  mutate((state) =>
    updateRow(state, rowId, {
      upload_state: 'uploaded',
      upload_progress: 1,
      storage_bucket: storageBucket,
      storage_object_key: storageObjectKey,
      checksum_sha256: checksum,
      stored_size: storedSize,
      mime_type: mimeType
    })
  );

export const setRowRegistered = ({ rowId, document }) =>
  mutate((state) =>
    updateRow(state, rowId, {
      document_id: document?.id || null,
      parse_run_id: document?.parse_run_id || null,
      parse_status: document?.parse_status || 'pending',
      parse_stage: document?.parse_stage || null,
      duplicate_of: document?.duplicate_of || null,
      // /register's byte-hash branch inserts a `duplicate_pending`
      // placeholder with a populated `parse_summary` (reason +
      // existing_filename + replace_blocked). Stash it on the row so
      // the tray renders the duplicate prompt + resolver immediately,
      // without waiting for the first poll tick.
      parse_summary: document?.parse_summary || null,
      register_warning: null,
      register_error_code: null,
      already_exists: Boolean(document?.already_exists),
      duplicate_reason: document?.duplicate_reason || null
    })
  );

export const registrationRequiresFreshUpload = code => [
  'PILOT_UPLOAD_GENERATION_CHANGED', 'PILOT_UPLOAD_INTENT_MISMATCH', 'PILOT_UPLOAD_BYTES_MISMATCH'
].includes(code);
export const canRetryRegistration = row => !registrationRequiresFreshUpload(row?.register_error_code)
  && !['PILOT_UPLOAD_PRINCIPAL_REVOKED', 'PILOT_UPLOAD_PRINCIPAL_REQUIRED'].includes(row?.register_error_code);

export const setRowRegisterFailed = ({ rowId, message, code = null }) =>
  mutate((state) => updateRow(state, rowId, {
    register_warning: message || 'Could not register upload.', register_error_code: code
  }));

// Coerce arbitrary error payloads to a non-empty single-line string.
// Defends rendering against the BE (or a caller) accidentally
// passing an object — `String({...})` would otherwise produce
// "[object Object]" on screen.
const stringifyActionErrorMessage = (raw) => {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (raw instanceof Error) return String(raw.message || '').trim();
  if (typeof raw === 'object') {
    try {
      const json = JSON.stringify(raw);
      // Fall back to empty (caller treats as no-error) rather than
      // rendering the literal "{}" or "null".
      return json && json !== '{}' && json !== 'null' ? json : '';
    } catch {
      return '';
    }
  }
  return String(raw).trim();
};

// Surface a transient inline error on a tray row — used by the
// resolve-duplicate and retry buttons so a 409 (e.g.
// REPLACE_BLOCKED_REVIEWED_TX, REPLACE_CANONICAL_MISSING) doesn't
// silently disappear into a catch {}. Auto-cleared the next time the
// row's state flips via applyParseStatusUpdate or by an explicit
// clearRowActionError call. Tray rendering picks the latest message
// off `row.action_error`.
export const setRowActionError = ({ rowId, message, code = null }) =>
  mutate((state) => {
    const text = stringifyActionErrorMessage(message);
    return updateRow(state, rowId, {
      action_error: text
        ? { message: text.slice(0, 200), code: code || null, set_at: now() }
        : null
    });
  });

export const clearRowActionError = ({ rowId }) =>
  mutate((state) => updateRow(state, rowId, { action_error: null }));

// `kind` names WHY bytes never reached storage, so the label can say what the
// owner can do: 'not_accepted' (Donna refused new files while readiness was
// not ready; the page still holds the file, so Retry works) or 'not_sent' (the
// page that held the file closed or reloaded; the bytes are gone, add it
// again). With neither, the label is the customer copy from the taxonomy
// (FI-05); `message` stays on the row for diagnosis and `code` (when the error
// carries one) lets a file fact such as too-large ask for a new copy.
export const setRowUploadFailed = ({ rowId, message, kind = null, code = null }) =>
  mutate((state) =>
    updateRow(state, rowId, {
      upload_state: 'failed',
      upload_progress: 0,
      upload_error: message || 'Upload failed.',
      upload_error_kind: kind,
      upload_error_code: code || null,
      held_retry_at: null
    })
  );

// Stability lane 2026-09-23: an upload refused at admission (entity readiness
// not ready) no longer rests as a dead 'failed' row. The file waits in this
// page's memory, the row says so, and the uploader retries it on a bounded
// clock (documentUploadSession.js) — it ends uploaded, or as an explicit
// 'not_accepted' failure with a working Retry.
export const setRowUploadHeld = ({ rowId, retryAt = null }) =>
  mutate((state) =>
    updateRow(state, rowId, {
      upload_state: 'held',
      upload_progress: 0,
      upload_error: null,
      upload_error_kind: null,
      held_retry_at: retryAt
    })
  );

export const setRowUploadRetrying = ({ rowId }) =>
  mutate((state) =>
    updateRow(state, rowId, {
      upload_state: 'uploading',
      upload_progress: 0,
      upload_error: null,
      upload_error_kind: null,
      held_retry_at: null
    })
  );

// Each page load that uploads stamps its rows with its own session id. A row
// still 'uploading' or 'held' under a different session (or one this page no
// longer holds bytes for) has no uploader left: the tab that held the file
// closed or reloaded. Say so explicitly instead of resting at "Uploading 0%"
// until the orphan TTL (sighted 2026-09-23, Kampaamo, two receipts).
export const stampRowsUploaderSession = ({ rowIds = [], session }) =>
  mutate((state) => ({
    ...state,
    batches: (state.batches || []).map((batch) => ({
      ...batch,
      rows: (batch.rows || []).map((row) => (rowIds.includes(row.row_id) ? { ...row, uploader_session: session } : row))
    }))
  }));

// A row counts as orphaned only when no uploader can still be holding it:
// tagged by another page session (or this page no longer holds its bytes), or
// — for uploaders that do not tag a session (the portal reply, chat intake) —
// its heartbeat is stale (UPLOAD_HEARTBEAT_STALE_MS, the same rule
// isRowBeingRead uses), so a genuinely live upload is never flipped.
const isOrphanedUploadRow = (row, { session, holdsFile, at }) => {
  if (!['uploading', 'held'].includes(row?.upload_state) || row.storage_object_key) return false;
  if (row.uploader_session) return row.uploader_session !== session || !holdsFile(row.row_id);
  return at - (row.last_seen_at || 0) > UPLOAD_HEARTBEAT_STALE_MS;
};

export const reconcileOrphanedUploadRows = ({ session, holdsFile = () => false, at = now() } = {}) => {
  const current = loadTrayState();
  const context = { session, holdsFile, at };
  if (!(current.batches || []).some((batch) => (batch.rows || []).some((row) => isOrphanedUploadRow(row, context)))) {
    return current;
  }
  return mutate((state) => ({
    ...state,
    batches: (state.batches || []).map((batch) => ({
      ...batch,
      rows: (batch.rows || []).map((row) => (isOrphanedUploadRow(row, context)
        ? stampRow(row, { upload_state: 'failed', upload_progress: 0, upload_error: 'Not uploaded.', upload_error_kind: 'not_sent', held_retry_at: null })
        : row))
    }))
  }));
};

export const applyParseStatusUpdate = ({ rowId, parseStatus }) =>
  mutate((state) =>
    updateRow(state, rowId, {
      parse_status: parseStatus?.parse_status || null,
      parse_stage: parseStatus?.parse_stage || null,
      parse_progress_current: parseStatus?.parse_progress_current ?? null,
      parse_progress_total: parseStatus?.parse_progress_total ?? null,
      parse_summary: parseStatus?.parse_summary || null,
      parse_error: parseStatus?.parse_error || null,
      duplicate_of: parseStatus?.duplicate_of || null,
      completed_at: parseStatus?.parse_completed_at || null,
      // Poll-driven state refresh implies the BE has caught up — drop
      // any transient action error so a stale 409 doesn't linger
      // alongside the new state.
      action_error: null
    })
  );

export const dismissTrayRow = ({ rowId }) =>
  mutate((state) => ({
    ...state,
    batches: (state.batches || []).map((batch) => ({
      ...batch,
      rows: (batch.rows || []).filter((row) => row.row_id !== rowId)
    }))
  }));

// Drop tray rows whose document_id is in `documentIds` — used by the
// poll loop when /parse-status came back without them, which means
// the BE document row is gone (entity deleted, cancel-resolved
// duplicate, manual prune, etc.). Without this, the tray would keep
// polling deleted docs and showing "Queued" forever.
export const dismissTrayRowsByDocumentIds = ({ documentIds = [] }) => {
  if (!documentIds?.length) return;
  const targets = new Set(documentIds);
  mutate((state) => ({
    ...state,
    batches: (state.batches || []).map((batch) => ({
      ...batch,
      rows: (batch.rows || []).filter(
        (row) => !row.document_id || !targets.has(row.document_id)
      )
    }))
  }));
};

export const dismissAllTerminalRows = () =>
  mutate((state) => ({
    ...state,
    batches: (state.batches || [])
      .map((batch) => ({
        ...batch,
        rows: (batch.rows || []).filter((row) => !isTerminalRow(row))
      }))
      .filter((batch) => (batch.rows?.length || 0) > 0)
  }));

// Drop every tray batch belonging to a client — called when the firm
// deletes the entity. The tray is localStorage-backed and survives BE
// snapshots (same class as firmMessages, which the delete flow already
// wipes): without this, the deleted client's rows linger — terminal
// ones until the 24h TTL, register orphans showing "Queued" until
// theirs — and confuse the next incarnation of the same UEN.
// Pure core exported for tests; the mutate wrapper touches storage.
export const removeClientBatches = (state = { batches: [] }, clientId) => ({
  ...state,
  batches: (state.batches || []).filter((batch) => batch.client_id !== clientId)
});

export const clearTrayForClient = (clientId) => {
  if (!clientId) return;
  mutate((state) => removeClientBatches(state, clientId));
};

// Scoped variants of the Clear buttons — with the tray filtered to the
// active client workspace, a global Clear would silently nuke OTHER
// clients' in-flight rows the user can't even see. Both take row ids
// (not document ids) because rows can exist pre-registration.
export const dismissTrayRowsByRowIds = ({ rowIds = [] }) => {
  if (!rowIds?.length) return;
  const targets = new Set(rowIds);
  mutate((state) => ({
    ...state,
    batches: (state.batches || [])
      .map((batch) => ({
        ...batch,
        rows: (batch.rows || []).filter((row) => !targets.has(row.row_id))
      }))
      .filter((batch) => (batch.rows?.length || 0) > 0)
  }));
};

// Partition the tray rows by the active client workspace. Each row
// inherits its batch's client_id (rows themselves don't carry one).
// Rows with NO client id stay visible everywhere — hiding work the
// user can't find again is worse than a little noise. No
// activeClientId → everything visible (firm home, legacy callers).
export const partitionTrayRowsForClient = (state = { batches: [] }, activeClientId = '') => {
  const all = (state.batches || []).flatMap((batch) =>
    (batch.rows || []).map((row) => ({ ...row, client_id: row.client_id || batch.client_id || null }))
  );
  if (!activeClientId) return { visible: all, otherCount: 0 };
  const visible = all.filter((row) => !row.client_id || row.client_id === activeClientId);
  return { visible, otherCount: all.length - visible.length };
};

// Wipe every tray row, terminal or not. Local-only — the BE document
// rows behind any non-terminal entries are untouched, so a fresh
// re-upload of the same file will trip the /register duplicate check
// against whatever's still in the DB and surface the dup resolver.
export const dismissAllRows = () =>
  mutate((state) => ({ ...state, batches: [] }));

// ── Auto-clear settled rows from the client portal landing ──────────
// The portal's "Previous uploads" tab already lists every document the
// BE knows about, so a tray row that SETTLED (completed / skipped —
// nothing left for the user to do) in an EARLIER page session is pure
// duplication on the landing — it used to sit there until the 24h
// terminal TTL. These rows are hidden at RENDER time, no storage
// mutation: the floating firm tray and the TTL pruning are untouched.
// Session semantics: settled before this page load → hidden; settled
// while the user watches (or discovered settled by the mount-time
// revalidation, which stamps terminal_at fresh) → stays visible for
// the rest of the session so the "N transactions imported" feedback
// isn't yanked away mid-look. Rows that still need the user (failed →
// retry, duplicate_pending → resolve) and in-flight rows always show.
const PAGE_SESSION_STARTED_AT = now();

export const isSettledRow = (row = {}) =>
  row?.parse_status === 'completed' || row?.parse_status === 'skipped';

// terminal_at first on purpose: it is when THIS browser first saw the
// row settle (stampRow), so a doc that finished while the tab was
// closed still gets one session of visibility after the revalidation
// pass flips it. completed_at (BE ISO timestamp) and last_seen_at are
// fallbacks for rows persisted before terminal_at existed.
const rowSettledAt = (row = {}) => {
  for (const value of [row.terminal_at, row.completed_at, row.last_seen_at]) {
    if (!value) continue;
    const ms = typeof value === 'number' ? value : new Date(value).getTime();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return 0;
};

// Pure core (cutoff injected) — exported for tests.
export const filterSettledRowsBeforeCutoff = (rows = [], cutoff = 0) =>
  rows.filter((row) => !isSettledRow(row) || rowSettledAt(row) >= cutoff);

export const hideSettledRowsFromPreviousSessions = (rows = []) =>
  filterSettledRowsBeforeCutoff(rows, PAGE_SESSION_STARTED_AT);

// All rows that should be polled — i.e. document_id is set and the row
// is not in a terminal state. Capped at 100 to match /parse-status.
export const collectPollableDocumentIds = (state = { batches: [] }) => {
  const ids = [];
  for (const batch of state.batches || []) {
    for (const row of batch.rows || []) {
      if (!row.document_id) continue;
      if (isTerminalRow(row)) continue;
      ids.push(row.document_id);
      if (ids.length >= 100) return ids;
    }
  }
  return ids;
};

// Every tray row that has a BE document_id, terminal or not. Used by
// the mount-time revalidation pass: terminal rows aren't polled in the
// steady-state loop, so an entity wipe between sessions leaves stale
// "completed" / "skipped" rows visible. One pass through /parse-status
// at mount lets us dismiss anything the BE no longer knows about.
export const collectAllDocumentIds = (state = { batches: [] }) => {
  const ids = [];
  for (const batch of state.batches || []) {
    for (const row of batch.rows || []) {
      if (!row.document_id) continue;
      ids.push(row.document_id);
      if (ids.length >= 100) return ids;
    }
  }
  return ids;
};

// Rows for which the storage PUT succeeded but /register hasn't — used
// for the pre-register retry on next mount (plan §"Pre-register
// failure (orphan storage objects)").
export const collectPreRegisterRetryRows = (state = { batches: [] }) => {
  const rows = [];
  for (const batch of state.batches || []) {
    for (const row of batch.rows || []) {
      if (row.upload_state !== 'uploaded') continue;
      if (row.document_id) continue;
      if (!row.storage_bucket || !row.storage_object_key) continue;
      rows.push({ ...row, client_id: batch.client_id, batch_id: batch.id });
    }
  }
  return rows;
};

// PR 2 of docs/invoice-receipt-parsing-plan.md → §"Frontend → Tray".
// Returns "{N} lines · {C} coded · {R} need review" when the document
// has any line items, or null when line_count is 0 / absent. Coded
// count is 0 in PR 2 (coding lands in PR 4/5); review count tracks
// PR 2's amount_mismatch path and PR 3's review-queue rows. Lives
// next to labelForTrayRow so the tray + the detail sub-line stay in
// one place.
const trayMessage = (formatMessage, id, defaultMessage, values = undefined) => (
  typeof formatMessage === 'function'
    ? formatMessage({ id, defaultMessage }, values)
    : defaultMessage
);

const lineCountDetailForSummary = (summary = {}, formatMessage = null) => {
  const lineCount = Number(summary.line_count || 0);
  if (!Number.isFinite(lineCount) || lineCount <= 0) return null;
  const codedCount = Number(summary.coded_line_count || 0);
  const reviewCount = Number(summary.review_line_count || 0);
  return trayMessage(
    formatMessage,
    'upload.row.lineDetail',
    `${lineCount} line${lineCount === 1 ? '' : 's'} · ${codedCount} coded · ${reviewCount} need review`,
    { lineCount, codedCount, reviewCount }
  );
};

const localizedSummaryAmount = (total, currency, formatAmount) => {
  if (typeof formatAmount !== 'function') return null;
  const amount = Number(total);
  if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency)) return null;
  try {
    return formatAmount(amount, { currency });
  } catch {
    return null;
  }
};

// FI-05: a technical failure reads "saved, taking longer" with a reference the
// user can quote; the row never shows a raw message, provider or code, and it
// never asks for a file Donna already holds (customerFailure.js).
const takingLongerLabel = (formatMessage, row) => {
  const reference = customerReference(row.document_id || row.row_id);
  return trayMessage(
    formatMessage,
    'upload.failure.takingLonger',
    `Saved — taking longer than usual. Nothing is needed from you.${reference ? ` Reference ${reference}` : ''}`,
    { hasReference: reference ? 'yes' : 'no', reference: reference || '' }
  );
};

const actionNeededLabel = (formatMessage, code) => {
  const reason = trayMessage(formatMessage, documentFactMessageId(code), documentFactFallback(code));
  return trayMessage(formatMessage, 'upload.failure.actionNeeded', `Action needed · ${reason}`, { reason });
};

// Per-row label (and detail) for the UI. Mirrors docs/async-parsing-plan.md
// → "Tray row states". Generic copy on purpose — extractors that chunk
// by image segment shouldn't surface "page 3 of 12".
export const labelForTrayRow = (row = {}, formatMessage = null, formatAmount = null) => {
  if (row.upload_state === 'failed') {
    if (row.upload_error_kind === 'not_sent') {
      return {
        label: trayMessage(formatMessage, 'upload.row.notSent', 'Not uploaded — the page was closed or reloaded before this file was sent. Add it again.'),
        tone: 'error',
        retryable: false
      };
    }
    if (row.upload_error_kind === 'not_accepted') {
      return {
        label: trayMessage(formatMessage, 'upload.row.notAccepted', "Not accepted yet — Donna isn't ready for new files. Retry, or try again shortly."),
        tone: 'error',
        retryable: true
      };
    }
    // The writer's message can be a raw storage/network error; render the
    // taxonomy instead. A file fact (too large) asks for a new copy; anything
    // else says the bytes never arrived, so Retry is the honest action.
    const factId = documentFactMessageId(row.upload_error_code);
    return {
      label: factId
        ? actionNeededLabel(formatMessage, row.upload_error_code)
        : trayMessage(formatMessage, 'upload.failure.notUploaded', "Not uploaded — the file didn't reach storage. Retry, or add it again."),
      tone: 'error',
      retryable: !factId
    };
  }
  if (row.upload_state === 'held') {
    return {
      label: trayMessage(formatMessage, 'upload.row.heldForReadiness', 'Waiting for Donna to be ready — will upload automatically'),
      tone: 'pending',
      retryable: true
    };
  }
  if (row.upload_state === 'uploading') {
    const pct = Math.round((row.upload_progress || 0) * 100);
    return {
      label: trayMessage(formatMessage, 'upload.row.uploading', `Uploading ${pct}%`, { percent: pct }),
      tone: 'progress'
    };
  }
  if (row.upload_state === 'uploaded' && !row.document_id) {
    if (!row.register_warning) {
      return { label: trayMessage(formatMessage, 'upload.row.waiting', 'Waiting to queue…'), tone: 'pending' };
    }
    const code = row.register_error_code;
    const label = registrationRequiresFreshUpload(code)
      ? trayMessage(formatMessage, 'upload.failure.addAgain', 'Add this file again to finish the upload.')
      : ['PILOT_UPLOAD_PRINCIPAL_REVOKED', 'PILOT_UPLOAD_PRINCIPAL_REQUIRED'].includes(code)
        ? trayMessage(formatMessage, 'upload.failure.signInAgain', 'Sign in again to finish this upload.')
        : trayMessage(formatMessage, 'upload.failure.notQueued', 'Uploaded, but not queued for reading yet. Retry.');
    return { label, tone: 'error', retryable: canRetryRegistration(row) };
  }
  const status = row.parse_status;
  if (!status || status === 'pending') {
    // RT-02: a pending row carrying payload.parse_hold was refused at
    // parse_claim by entity readiness. Render the persisted hold, not
    // "Queued" — the row is waiting on readiness, not on the drain.
    if (row.parse_hold && typeof row.parse_hold === 'object') {
      // A provider wait (boundary parse_extract: no key on this installation,
      // or the provider unreachable) rests on the operator, never on the
      // person uploading: FI-05's "saved, taking longer", no provider or key
      // wording. The firm's stream row names the stored reason.
      if (row.parse_hold.boundary === 'parse_extract') {
        return { label: takingLongerLabel(formatMessage, row), tone: 'pending' };
      }
      return { label: trayMessage(formatMessage, 'upload.row.waitingReadiness', 'Waiting for readiness…'), tone: 'pending' };
    }
    return { label: trayMessage(formatMessage, 'upload.row.queued', 'Queued'), tone: 'pending' };
  }
  if (status === 'processing') {
    const stage = row.parse_stage;
    if (stage === 'fetching') return { label: trayMessage(formatMessage, 'upload.row.fetching', 'Fetching file…'), tone: 'progress' };
    if (stage === 'extracting') {
      if (row.parse_progress_total) {
        return {
          label: trayMessage(
            formatMessage,
            'upload.row.readingProgress',
            `Reading · ${row.parse_progress_current || 0} of ${row.parse_progress_total}`,
            { current: row.parse_progress_current || 0, total: row.parse_progress_total }
          ),
          tone: 'progress'
        };
      }
      return { label: trayMessage(formatMessage, 'upload.row.reading', 'Reading…'), tone: 'progress' };
    }
    if (stage === 'writing') return { label: trayMessage(formatMessage, 'upload.row.importing', 'Importing transactions…'), tone: 'progress' };
    if (stage === 'enriching') return { label: trayMessage(formatMessage, 'upload.row.categorizing', 'Categorizing…'), tone: 'progress' };
    if (stage === 'finalizing') return { label: trayMessage(formatMessage, 'upload.row.finishing', 'Finishing up…'), tone: 'progress' };
    return { label: trayMessage(formatMessage, 'upload.row.reading', 'Reading…'), tone: 'progress' };
  }
  if (status === 'completed') {
    const summary = row.parse_summary || {};
    const count = Number(summary.transaction_count || 0);
    if (count > 0) {
      return {
        label: trayMessage(
          formatMessage,
          'upload.row.transactionsImported',
          `${count} transaction${count === 1 ? '' : 's'} imported`,
          { count }
        ),
        tone: 'success'
      };
    }
    // PR 1 of docs/invoice-receipt-parsing-plan.md: receipts now
    // surface as "Receipt · {vendor} · {currency} {total}" when the
    // extractor populated all three fields. We accept the
    // counterparty_name from parse_summary (set by the extractor)
    // and fall back to "Done" if any piece is missing — keeps a
    // partial extraction visible without lying about field counts.
    //
    // PR 2 adds an optional `detail` sub-line carrying line counts
    // (e.g. "3 lines · 0 coded · 3 need review") when the doc has
    // any. coded_line_count is 0 in PR 2 (coding lands in PR 4/5);
    // review_line_count tracks PR 2's amount_mismatch path and
    // PR 3's review-queue rows.
    if (summary.document_type === 'receipt') {
      const vendor = String(summary.counterparty_name || '').trim();
      const currency = String(summary.currency || '').trim();
      const total = summary.total_amount;
      const totalFormatted = total == null || total === '' ? '' : String(total);
      const localizedAmount = localizedSummaryAmount(total, currency, formatAmount);
      const detail = lineCountDetailForSummary(summary, formatMessage);
      if (vendor && currency && totalFormatted) {
        return {
          label: localizedAmount
            ? trayMessage(
                formatMessage,
                'upload.row.receiptAmount',
                `Receipt · ${vendor} · ${currency} ${totalFormatted}`,
                { vendor, amount: localizedAmount }
              )
            : trayMessage(
                formatMessage,
                'upload.row.receiptFull',
                `Receipt · ${vendor} · ${currency} ${totalFormatted}`,
                { vendor, currency, total: totalFormatted }
              ),
          tone: 'success',
          ...(detail ? { detail } : {})
        };
      }
      return {
        label: trayMessage(formatMessage, 'upload.row.done', 'Done'),
        tone: 'success',
        ...(detail ? { detail } : {})
      };
    }
    // PR 6 of docs/invoice-receipt-parsing-plan.md → supplier bills.
    // Tray copy: "Bill from {vendor} · {currency} {total}". Three-tier
    // fallback chain when the extractor only got partial fields:
    //   - vendor + currency + total → full label
    //   - vendor only                → "Bill from {vendor}"
    //   - nothing                    → "Bill"
    // Same `detail` sub-line as receipts when the doc carries lines.
    if (summary.document_type === 'supplier_bill') {
      const vendor = String(summary.counterparty_name || '').trim();
      const currency = String(summary.currency || '').trim();
      const total = summary.total_amount;
      const totalFormatted = total == null || total === '' ? '' : String(total);
      const localizedAmount = localizedSummaryAmount(total, currency, formatAmount);
      const detail = lineCountDetailForSummary(summary, formatMessage);
      const detailExtra = detail ? { detail } : {};
      if (vendor && currency && totalFormatted) {
        return {
          label: localizedAmount
            ? trayMessage(
                formatMessage,
                'upload.row.billAmount',
                `Bill from ${vendor} · ${currency} ${totalFormatted}`,
                { vendor, amount: localizedAmount }
              )
            : trayMessage(
                formatMessage,
                'upload.row.billFull',
                `Bill from ${vendor} · ${currency} ${totalFormatted}`,
                { vendor, currency, total: totalFormatted }
              ),
          tone: 'success',
          ...detailExtra
        };
      }
      if (vendor) {
        return {
          label: trayMessage(formatMessage, 'upload.row.billVendor', `Bill from ${vendor}`, { vendor }),
          tone: 'success',
          ...detailExtra
        };
      }
      return { label: trayMessage(formatMessage, 'upload.row.bill', 'Bill'), tone: 'success', ...detailExtra };
    }
    // PR 7 of docs/invoice-receipt-parsing-plan.md → sales invoices.
    // Tray copy: "Sales invoice to {customer} · {currency} {total}".
    // The preposition flips from "from" (supplier) to "to" (customer)
    // — direction matters here, the firm's mental model is "I sent
    // this invoice TO Globex" vs "I received this bill FROM Stripe".
    // Same three-tier fallback chain as bills:
    //   - customer + currency + total → full label
    //   - customer only                → "Sales invoice to {customer}"
    //   - nothing                       → "Sales invoice"
    // `counterparty_name` carries the customer because the extractor
    // writes the buyer to that field on sales invoices (the writer
    // contract is doc-type-neutral).
    if (summary.document_type === 'sales_invoice') {
      const customer = String(summary.counterparty_name || '').trim();
      const currency = String(summary.currency || '').trim();
      const total = summary.total_amount;
      const totalFormatted = total == null || total === '' ? '' : String(total);
      const localizedAmount = localizedSummaryAmount(total, currency, formatAmount);
      const detail = lineCountDetailForSummary(summary, formatMessage);
      const detailExtra = detail ? { detail } : {};
      if (customer && currency && totalFormatted) {
        return {
          label: localizedAmount
            ? trayMessage(
                formatMessage,
                'upload.row.salesInvoiceAmount',
                `Sales invoice to ${customer} · ${currency} ${totalFormatted}`,
                { customer, amount: localizedAmount }
              )
            : trayMessage(
                formatMessage,
                'upload.row.salesInvoiceFull',
                `Sales invoice to ${customer} · ${currency} ${totalFormatted}`,
                { customer, currency, total: totalFormatted }
              ),
          tone: 'success',
          ...detailExtra
        };
      }
      if (customer) {
        return {
          label: trayMessage(formatMessage, 'upload.row.salesInvoiceCustomer', `Sales invoice to ${customer}`, { customer }),
          tone: 'success',
          ...detailExtra
        };
      }
      return { label: trayMessage(formatMessage, 'upload.row.salesInvoice', 'Sales invoice'), tone: 'success', ...detailExtra };
    }
    // issued_receipt — a receipt the firm ISSUED to a customer (rent
    // receipt, paid-payment acknowledgement). Same shape as sales
    // invoice (customer, currency, total) but framed as "Receipt
    // issued to ..." so the firm reads it as evidence of money
    // already received rather than money still owed.
    if (summary.document_type === 'issued_receipt') {
      const customer = String(summary.counterparty_name || '').trim();
      const currency = String(summary.currency || '').trim();
      const total = summary.total_amount;
      const totalFormatted = total == null || total === '' ? '' : String(total);
      const localizedAmount = localizedSummaryAmount(total, currency, formatAmount);
      const detail = lineCountDetailForSummary(summary, formatMessage);
      const detailExtra = detail ? { detail } : {};
      if (customer && currency && totalFormatted) {
        return {
          label: localizedAmount
            ? trayMessage(
                formatMessage,
                'upload.row.issuedReceiptAmount',
                `Receipt issued to ${customer} · ${currency} ${totalFormatted}`,
                { customer, amount: localizedAmount }
              )
            : trayMessage(
                formatMessage,
                'upload.row.issuedReceiptFull',
                `Receipt issued to ${customer} · ${currency} ${totalFormatted}`,
                { customer, currency, total: totalFormatted }
              ),
          tone: 'success',
          ...detailExtra
        };
      }
      if (customer) {
        return {
          label: trayMessage(formatMessage, 'upload.row.issuedReceiptCustomer', `Receipt issued to ${customer}`, { customer }),
          tone: 'success',
          ...detailExtra
        };
      }
      return { label: trayMessage(formatMessage, 'upload.row.issuedReceipt', 'Receipt issued'), tone: 'success', ...detailExtra };
    }
    // Render the PERSISTED verdict (the documents.document_type column on
    // `row`), NOT the legacy parse_summary.document_type. A
    // payment_confirmation (IRS/Amex/loan payment) is deliberately routed
    // THROUGH the generic extractor so its PDF body is read for
    // reconciliation — so its parse_summary.document_type is the
    // extractor-internal 'generic_document'. Rendering that raw token
    // surfaced "Saved as generic_document" for a correctly-typed payment
    // (the column is 'payment_confirmation'). Key off the column instead.
    // (CLAUDE.md: render the persisted verdict, not the legacy layer.)
    if (row.document_type === 'payment_confirmation') {
      // Same firm-facing copy the skipped branch uses for payment
      // confirmations — these now COMPLETE (generic extractor) rather than
      // skip, but the label must read identically.
      return { label: trayMessage(formatMessage, 'upload.row.savedPayment', 'Saved · payment confirmation'), tone: 'success' };
    }
    // For any other completed doc that fell through to here (a true
    // generic document — tax notice, insurance policy, etc.), prefer the
    // generic extractor's human-readable guess over the internal
    // 'generic_document' token, and never surface that raw token to the
    // firm.
    const guess = String(summary.document_type_guess || '').trim().toLowerCase();
    if (guess && guess !== 'generic_document' && guess !== 'unknown') {
      // The guess is the generic extractor's free text: a known type reads as
      // its catalog label, anything else as "other document" — never as the
      // model's English.
      const documentType = trayDocumentTypeLabel(guess, formatMessage);
      return {
        label: trayMessage(formatMessage, 'upload.row.savedGuess', `Saved · ${documentType}`, { documentType }),
        tone: 'success'
      };
    }
    if (
      summary.document_type &&
      summary.document_type !== 'bank_statement' &&
      summary.document_type !== 'generic_document'
    ) {
      return {
        label: trayMessage(
          formatMessage,
          'upload.row.savedAs',
          `Saved as ${trayDocumentTypeLabel(summary.document_type)}`,
          { documentType: trayDocumentTypeLabel(summary.document_type, formatMessage) }
        ),
        tone: 'success'
      };
    }
    return { label: trayMessage(formatMessage, 'upload.row.saved', 'Saved'), tone: 'success' };
  }
  if (status === 'failed') {
    // RT-10 (F-13): a failed upload that a later upload of the SAME bytes
    // superseded (documents.duplicate_of points at the new canonical) is
    // not a row to retry — the later upload is its retry.
    if (row.duplicate_of) {
      return {
        label: trayMessage(formatMessage, 'upload.row.failedSuperseded', 'Superseded by a later upload of the same file'),
        tone: 'muted',
        retryable: false
      };
    }
    // RT-02 (audit F-02) decides who retries — `parse_error.retry_owner`:
    // `queue` ⇒ an automatic owner re-runs it (pending tone, no button);
    // `manual` or none ⇒ the button stays, so a row never rests with no human
    // action and never renders a promise nobody owns. FI-05 decides what the
    // user is TOLD: a fact about the file is "action needed"; any technical
    // failure is "saved, taking longer" — never the internal `message`, never
    // the provider or credential wording of `safe_user_message`.
    const err = row.parse_error || {};
    const factId = documentFactMessageId(err.code);
    if (factId) {
      // RT-02: no queue owns it, so the human keeps a button.
      return { label: actionNeededLabel(formatMessage, err.code), tone: 'error', retryable: true };
    }
    // A queue-owned retry is still in flight (pending, no button); without an
    // automatic owner the row stays visibly unfinished with its Retry.
    const queued = err.retry_owner === 'queue';
    return {
      label: takingLongerLabel(formatMessage, row),
      tone: queued ? 'pending' : 'warning',
      retryable: !queued
    };
  }
  if (status === 'skipped') {
    // Friendly labels for document types we deliberately don't parse
    // (vs. the generic "no parsing" muted label which signals to the
    // user that we didn't recognise the file). Payment confirmations
    // are stored as evidence and reconciled against bank-statement
    // debits — they don't need LLM extraction.
    const docType = row.parse_summary?.document_type || row.document_type || null;
    if (docType === 'payment_confirmation') {
      return { label: trayMessage(formatMessage, 'upload.row.savedPayment', 'Saved · payment confirmation'), tone: 'success' };
    }
    // Registry extracts (BizFile etc.) are parsed at INTAKE time via
    // /api/donna/bizfile/intake-draft, not by the document worker —
    // the muted "no parsing" label read as a failure to the firm when
    // the identity parse had in fact succeeded.
    if (docType === 'statutory_record') {
      return { label: trayMessage(formatMessage, 'upload.row.savedRegistry', 'Saved · registry document (identity parsed at intake)'), tone: 'success' };
    }
    // The real skip reason lives in parse_summary (the worker merges the
    // column-authoritative `reason` in, alongside skipped_reason /
    // vision_skipped / transaction_count / classification). One flattened
    // label for every reason hid genuinely different states — a classifier
    // crash, an open owner ask, an empty statement — behind "no parsing
    // for this type" (two-surface IA record, precondition P1).
    const summary = row.parse_summary || {};
    const reason = summary.reason || summary.skipped_reason || null;
    if (reason === 'duplicate_auto_collapsed') {
      // RT-10 (F-13): a byte-identical re-upload is collapsed onto the
      // earlier upload at register time — terminal, no resolver, no click.
      // Muted: nothing happened that needs the user, and nothing is owed.
      const existingFilename = summary.existing_filename
        || trayMessage(formatMessage, 'upload.row.earlierUpload', 'an earlier upload');
      return {
        label: trayMessage(
          formatMessage,
          'upload.row.duplicateCollapsed',
          `Same file as ${existingFilename} — kept the earlier upload`,
          { filename: existingFilename }
        ),
        tone: 'muted',
        duplicate_reason: 'byte_match',
        auto_collapsed: true
      };
    }
    if (reason === 'einvoice_escalated') {
      // Terminal 2: an owner ask exists for this document.
      return { label: trayMessage(formatMessage, 'upload.row.askedOwner', 'Saved · asked the owner (e-invoice could not be read)'), tone: 'warning' };
    }
    if (summary.classification?.fallback_reason === 'router_error') {
      // The classifier errored and the parse fell back to the upload-time
      // type before terminal-skipping — the skip verdict itself is
      // untrustworthy, so this must never render as a calm muted state.
      // Technical, and the file is held: never ask for it again (FI-05).
      return { label: takingLongerLabel(formatMessage, row), tone: 'warning' };
    }
    if (summary.vision_skipped === 'pdf_too_large') {
      return { label: trayMessage(formatMessage, 'upload.row.fileTooLarge', "Couldn't read page-by-page · file too large"), tone: 'error' };
    }
    if (summary.vision_skipped === 'timeout') {
      return { label: takingLongerLabel(formatMessage, row), tone: 'warning' };
    }
    if (reason === 'no_transactions_detected') {
      return { label: trayMessage(formatMessage, 'upload.row.noTransactions', 'Saved — no transaction lines found in this file'), tone: 'warning' };
    }
    if (reason === 'extraction_below_statement_threshold') {
      const count = Number(summary.transaction_count);
      return {
        label: Number.isFinite(count) && count > 0
          ? trayMessage(
              formatMessage,
              'upload.row.tooFewCount',
              `Saved — only ${count} transaction line${count === 1 ? '' : 's'} found, not treated as a statement`,
              { count }
            )
          : trayMessage(formatMessage, 'upload.row.tooFew', 'Saved — too few transaction lines to treat as a statement'),
        tone: 'warning'
      };
    }
    if (reason === 'extractor_unavailable') {
      if (!docType || docType === 'unknown') {
        return { label: trayMessage(formatMessage, 'upload.row.unknownDocument', "Saved — couldn't tell what this document is"), tone: 'warning' };
      }
      const documentType = trayDocumentTypeLabel(docType, formatMessage);
      return {
        label: trayMessage(formatMessage, 'upload.row.noParser', `Saved — no parser for ${documentType} yet`, { documentType }),
        tone: 'muted'
      };
    }
    return { label: trayMessage(formatMessage, 'upload.row.noParsing', 'Saved (no parsing for this type)'), tone: 'muted' };
  }
  if (status === 'duplicate_pending') {
    const summary = row.parse_summary || {};
    if (summary.reason === 'period_overlap') {
      const periodLabel =
        summary.existing_summary?.statement_period ||
        summary.existing_summary?.period_label ||
        null;
      // RT-10 (F-13): the replace-or-keep decision is the OWNER's — the
      // writer minted the ask in the same transaction (owner_ask_id is the
      // receipt). The row reads "asked the owner", never a firm tray state;
      // the resolver stays available to the firm as the executor.
      if (summary.owner_ask_id) {
        return {
          label: periodLabel
            ? trayMessage(
                formatMessage,
                'upload.row.periodOverlapAskedNamed',
                `Overlaps statement covering ${periodLabel} — asked the owner whether to replace or keep it`,
                { period: periodLabel }
              )
            : trayMessage(formatMessage, 'upload.row.periodOverlapAsked', 'Overlaps an existing statement period — asked the owner whether to replace or keep it'),
          tone: 'warning',
          duplicate_reason: 'period_overlap',
          owner_asked: true
        };
      }
      return {
        label: periodLabel
          ? trayMessage(
              formatMessage,
              'upload.row.periodOverlapNamed',
              `Overlaps with statement covering ${periodLabel} already parsed`,
              { period: periodLabel }
            )
          : trayMessage(formatMessage, 'upload.row.periodOverlap', 'Overlaps with an existing statement period'),
        tone: 'warning',
        duplicate_reason: 'period_overlap'
      };
    }
    const existingFilename = summary.existing_filename || trayMessage(formatMessage, 'upload.row.earlierUpload', 'an earlier upload');
    return {
      label: trayMessage(
        formatMessage,
        'upload.row.duplicate',
        `Looks like a duplicate of ${existingFilename}`,
        { filename: existingFilename }
      ),
      tone: 'warning',
      duplicate_reason: 'byte_match'
    };
  }
  return { label: status, tone: 'muted' };
};

// Per-row resolver hint used by the tray + firm console. Centralizes the
// `replace_blocked` flag so both surfaces share copy. Note: the BE
// re-checks the block inside the resolver transaction — this is just a
// UX pre-disable, not the source of truth.
export const duplicateResolveStateForRow = (row = {}, formatMessage = null) => {
  if (row?.parse_status !== 'duplicate_pending') return null;
  const summary = row.parse_summary || {};
  const replaceBlocked = Boolean(summary.replace_blocked);
  return {
    reason: summary.reason || 'byte_match',
    existing_filename: summary.existing_filename || null,
    existing_document_id: summary.existing_document_id || row.duplicate_of || null,
    replace_blocked: replaceBlocked,
    replace_blocked_tooltip: replaceBlocked
      ? trayMessage(
          formatMessage,
          'upload.row.replaceBlockedTooltip',
          'Existing transactions have been reviewed — only the firm can replace this. Contact the firm.'
        )
      : null
  };
};

export const isTerminalRowExport = isTerminalRow;

// ── The visor's counting contract (Kari, 2026-08-11) ─────────────────────────
// The mascot's visor shows exactly ONE thing: how many documents Donna is
// reading RIGHT NOW, firm-wide. Blank when idle or settled — never a total.
// The count is a pure projection of this store (which the parse-status poll
// keeps honest and self-heals); the visor's digit animation is decoration on
// arrival, never its own counter — the two must not be able to disagree.
//
// A row is "being read" while it is genuinely in flight: uploading with a
// live heartbeat, uploaded and waiting to register, or registered with parse
// pending/processing. It STOPS counting the moment it is done or needs a
// human: parse-terminal (completed / failed / skipped / duplicate_pending)
// or upload-failed — those surface as their own tray/Actions rows. The
// heartbeat guard exists because a killed session can restore an 'uploading'
// row that no live uploader is stamping (stampRow refreshes last_seen_at on
// every progress event); without it that zombie pins the visor for the 24h
// orphan TTL — and a counter that can stick is a counter the owner stops
// trusting.
const UPLOAD_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export const isRowBeingRead = (row = {}, at = now()) => {
  if (isTerminalRow(row)) return false;
  if (row.upload_state === 'failed') return false;
  if (row.upload_state === 'uploading') {
    return at - (row.last_seen_at || 0) <= UPLOAD_HEARTBEAT_STALE_MS;
  }
  return true;
};

export const countTrayRowsBeingRead = (state = { batches: [] }, at = now()) => {
  let count = 0;
  for (const batch of state.batches || []) {
    for (const row of batch.rows || []) {
      if (isRowBeingRead(row, at)) count += 1;
    }
  }
  return count;
};
