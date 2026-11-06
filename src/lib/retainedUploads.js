// Uploads the server refused before any byte was stored — the file is kept in
// this page's memory so the row can finish without the owner re-selecting it.
//
// Stability lane, 2026-09-23 (docs/finding-2026-09-23-delete-recreate-stability.md,
// G14): an upload refused at `upload_sign` because entity readiness was not
// ready used to become a `failed` tray row with no storage key, so the tray
// offered no Retry, the bytes were dropped, and the row sat until the 24 h
// orphan TTL — 25 Kampaamo receipts on 2026-09-23. Now:
//
//   - an ADMISSION refusal (ENTITY_READINESS_ADMISSION_BLOCKED) holds the row
//     ("Waiting for Donna to be ready — will upload automatically") and
//     re-sends it on a bounded backoff; when the window ends it becomes an
//     explicit `not_accepted` failure with a working Retry;
//   - any other failure is `failed` with the server's message, and Retry
//     re-sends from memory while this page lives;
//   - a row whose page closed or reloaded before its bytes were stored has no
//     uploader left: reconcileOrphanedUploads() turns it into an explicit
//     `not_sent` failure ("add it again") instead of "Uploading 0%".
//
// Two terminals per row: it is stored (then the tray's own register/parse
// path owns it), or it rests as an explicit failure the owner can act on.
// Nothing here writes to the server beyond re-running the same admitted
// upload route; admission is still decided server-side on every attempt.

import { getBookSessionIdentity } from './bookSessionIdentity.js';
import {
  reconcileOrphanedUploadRows,
  setRowUploadFailed,
  setRowUploadHeld,
  setRowUploadRetrying,
  stampRowsUploaderSession
} from './uploadTray.js';

export const ADMISSION_REFUSED_CODE = 'ENTITY_READINESS_ADMISSION_BLOCKED';
export const isAdmissionRefusal = (error) => error?.code === ADMISSION_REFUSED_CODE;

// Host renewal runs every ~5 minutes; the backoff reaches that cadence quickly
// and the window covers several renewals without holding a file forever.
export const HELD_RETRY_DELAYS_MS = Object.freeze([30_000, 60_000, 120_000, 240_000, 300_000]);
export const HELD_RETRY_WINDOW_MS = 30 * 60_000;

const newSessionId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `uploader-${Date.now()}-${Math.random().toString(16).slice(2)}`);

let session = newSessionId();
let clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
const retained = new Map();

export const uploaderSession = () => session;
export const holdsRetainedUpload = (rowId) => Boolean(rowId) && retained.has(rowId);

// `resend` re-runs the one-file store (and register) for this row. It must
// throw on a store failure and release the row itself once bytes are stored.
export const retainUpload = ({ rowId, resend }) => {
  if (!rowId || typeof resend !== 'function') return;
  retained.set(rowId, { resend, identity: getBookSessionIdentity(), attempt: 0, heldSince: null, timer: null });
  stampRowsUploaderSession({ rowIds: [rowId], session });
};

export const releaseRetainedUpload = (rowId) => {
  const entry = retained.get(rowId);
  if (entry?.timer) clock.clearTimeout(entry.timer);
  retained.delete(rowId);
};

// Returns 'held' | 'not_accepted' | 'failed'.
export const recordUploadFailure = ({ rowId, error }) => {
  const message = error?.message || 'Upload failed.';
  const entry = retained.get(rowId);
  if (!entry || !isAdmissionRefusal(error)) {
    setRowUploadFailed({ rowId, message, code: error?.code || null });
    return 'failed';
  }
  const at = clock.now();
  if (entry.heldSince == null) entry.heldSince = at;
  if (at - entry.heldSince >= HELD_RETRY_WINDOW_MS) {
    // A manual Retry after this starts a fresh bounded window.
    entry.heldSince = null;
    entry.attempt = 0;
    setRowUploadFailed({ rowId, message, kind: 'not_accepted' });
    return 'not_accepted';
  }
  const delay = HELD_RETRY_DELAYS_MS[Math.min(entry.attempt, HELD_RETRY_DELAYS_MS.length - 1)];
  entry.attempt += 1;
  setRowUploadHeld({ rowId, retryAt: at + delay });
  entry.timer = clock.setTimeout(() => {
    entry.timer = null;
    void retryRetainedUpload(rowId);
  }, delay);
  return 'held';
};

export const retryRetainedUpload = async (rowId) => {
  const entry = retained.get(rowId);
  if (!entry) return false;
  // A file retained under one signed-in session is never re-sent under
  // another: the row lives in the previous account's tray, which this page
  // can no longer write to or speak for.
  if (entry.identity !== getBookSessionIdentity()) {
    releaseRetainedUpload(rowId);
    return false;
  }
  if (entry.timer) {
    clock.clearTimeout(entry.timer);
    entry.timer = null;
  }
  setRowUploadRetrying({ rowId });
  try {
    await entry.resend();
    return true;
  } catch (error) {
    recordUploadFailure({ rowId, error });
    return false;
  }
};

export const reconcileOrphanedUploads = () =>
  reconcileOrphanedUploadRows({ session, holdsFile: holdsRetainedUpload });

export const __resetRetainedUploadsForTests = ({ now, setTimeout: set, clearTimeout: clear } = {}) => {
  for (const entry of retained.values()) if (entry.timer) clock.clearTimeout(entry.timer);
  retained.clear();
  session = newSessionId();
  clock = {
    now: now || (() => Date.now()),
    setTimeout: set || ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: clear || ((id) => clearTimeout(id))
  };
};
