// Refused uploads never rest in the browser (stability lane, 2026-09-23;
// docs/finding-2026-09-23-delete-recreate-stability.md G14). On 2026-09-23 a
// re-created Kampaamo refused 27 uploads at upload_sign while Host A was not
// ready: 25 became dead "runtime readiness recovery" rows with no Retry and no
// bytes kept, 2 sat at "Uploading 0%" after the page moved on.
//
// These tests hold the new contract: an admission refusal holds the row and
// re-sends the retained file on a bounded clock; the window ends in an
// explicit `not_accepted` with a working Retry; a row whose page is gone
// becomes an explicit `not_sent`; a live upload is never flipped.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
const originals = new Map(['window', 'fetch', 'FileReader'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    location: { pathname: '/' },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    }
  }
});

const tray = await import('./uploadTray.js');
const retained = await import('./retainedUploads.js');
const { uploadFirmDocuments } = await import('./documentUploadSession.js');

// A deterministic clock: timers fire only when the test advances time.
let nowMs = 0;
let timers = [];
const advance = async (ms) => {
  nowMs += ms;
  const due = timers.filter((timer) => timer.at <= nowMs);
  timers = timers.filter((timer) => timer.at > nowMs);
  for (const timer of due) await timer.fn();
};

beforeEach(() => {
  storage.clear();
  nowMs = 1_000_000;
  timers = [];
  retained.__resetRetainedUploadsForTests({
    now: () => nowMs,
    setTimeout: (fn, ms) => { const timer = { fn, at: nowMs + ms }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timers = timers.filter((entry) => entry !== timer); }
  });
});

afterEach(() => {
  for (const key of ['fetch', 'FileReader']) {
    const descriptor = originals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

const refused = () => Object.assign(new Error('Donna is completing a runtime readiness recovery before accepting new automated work.'), {
  code: 'ENTITY_READINESS_ADMISSION_BLOCKED', status: 503
});
const rowOf = (rowId) => tray.loadTrayState().batches.flatMap((batch) => batch.rows).find((row) => row.row_id === rowId);
const oneRow = () => {
  const state = tray.startTrayBatch({ batchId: 'b1', clientId: 'c1', files: [{ filename: 'receipt.pdf', size: 10 }] });
  return state.batches[0].rows[0].row_id;
};

test('an admission refusal holds the row and re-sends the retained file until it is admitted', async () => {
  const rowId = oneRow();
  let calls = 0;
  retained.retainUpload({ rowId, resend: async () => { calls += 1; if (calls < 3) throw refused(); retained.releaseRetainedUpload(rowId); tray.setRowUploaded({ rowId, storageBucket: 'b', storageObjectKey: 'k', checksum: 'x', storedSize: 10, mimeType: 'application/pdf' }); } });

  assert.equal(retained.recordUploadFailure({ rowId, error: refused() }), 'held');
  assert.equal(rowOf(rowId).upload_state, 'held');
  const held = tray.labelForTrayRow(rowOf(rowId));
  assert.equal(held.tone, 'pending');
  assert.match(held.label, /will upload automatically/);
  assert.equal(held.retryable, true);

  await advance(retained.HELD_RETRY_DELAYS_MS[0]);
  assert.equal(calls, 1, 'the first backoff re-sent the file');
  assert.equal(rowOf(rowId).upload_state, 'held', 'still refused → held again');

  await advance(retained.HELD_RETRY_DELAYS_MS[1]);
  assert.equal(calls, 2);
  await advance(retained.HELD_RETRY_DELAYS_MS[2]);
  assert.equal(calls, 3, 'admitted on the third re-send');
  assert.equal(rowOf(rowId).upload_state, 'uploaded');
  assert.equal(retained.holdsRetainedUpload(rowId), false, 'stored bytes release the retained file');
  assert.equal(timers.length, 0, 'no clock left running');
});

test('the hold is bounded: the window ends in an explicit not-accepted row whose Retry still works', async () => {
  const rowId = oneRow();
  let admit = false;
  retained.retainUpload({ rowId, resend: async () => { if (!admit) throw refused(); retained.releaseRetainedUpload(rowId); tray.setRowUploaded({ rowId, storageBucket: 'b', storageObjectKey: 'k', checksum: 'x', storedSize: 10, mimeType: 'application/pdf' }); } });
  retained.recordUploadFailure({ rowId, error: refused() });
  for (let i = 0; i < 40 && timers.length; i += 1) await advance(retained.HELD_RETRY_DELAYS_MS.at(-1));

  const row = rowOf(rowId);
  assert.equal(row.upload_state, 'failed');
  assert.equal(row.upload_error_kind, 'not_accepted');
  assert.equal(timers.length, 0, 'the clock stops at the bound');
  assert.ok(nowMs - 1_000_000 >= retained.HELD_RETRY_WINDOW_MS, 'held for the whole window');
  const label = tray.labelForTrayRow(row);
  assert.match(label.label, /Not accepted yet/);
  assert.equal(label.retryable, true);
  assert.equal(retained.holdsRetainedUpload(rowId), true, 'the file is still here for Retry');

  admit = true;
  assert.equal(await retained.retryRetainedUpload(rowId), true);
  assert.equal(rowOf(rowId).upload_state, 'uploaded');
});

test('a non-admission failure is a plain failed row with Retry, and never auto-retries', async () => {
  const rowId = oneRow();
  retained.retainUpload({ rowId, resend: async () => { throw new Error('boom'); } });
  assert.equal(retained.recordUploadFailure({ rowId, error: new Error('Evidence storage upload failed with 500.') }), 'failed');
  const row = rowOf(rowId);
  assert.equal(row.upload_state, 'failed');
  assert.equal(row.upload_error_kind, null);
  // FI-05: the storage error stays on the row for diagnosis; the label is the
  // customer copy, never the raw message.
  assert.equal(row.upload_error, 'Evidence storage upload failed with 500.');
  assert.equal(tray.labelForTrayRow(row).label, "Not uploaded — the file didn't reach storage. Retry, or add it again.");
  assert.equal(tray.labelForTrayRow(row).retryable, true);
  assert.equal(timers.length, 0);
});

test('a row whose page is gone becomes an explicit not-sent row; a live upload is never flipped', () => {
  const state = tray.startTrayBatch({ batchId: 'b2', clientId: 'c1', files: [
    { filename: 'tagged-other-page.pdf' }, { filename: 'untagged-stale.pdf' }, { filename: 'untagged-live.pdf' }, { filename: 'mine.pdf' }
  ] });
  const [otherPage, stale, live, mine] = state.batches[0].rows.map((row) => row.row_id);
  // Another page's session tagged this row, then that page reloaded.
  tray.stampRowsUploaderSession({ rowIds: [otherPage], session: 'a-previous-page' });
  // An untagged uploader's row whose heartbeat went stale (the two Kampaamo rows).
  const persisted = tray.loadTrayState();
  for (const row of persisted.batches[0].rows) if (row.row_id === stale) row.last_seen_at = Date.now() - 10 * 60_000;
  tray.saveTrayState(persisted);
  // This page is uploading `mine` right now.
  retained.retainUpload({ rowId: mine, resend: async () => {} });

  retained.reconcileOrphanedUploads();

  assert.equal(rowOf(otherPage).upload_error_kind, 'not_sent');
  assert.equal(rowOf(stale).upload_error_kind, 'not_sent');
  assert.equal(rowOf(live).upload_state, 'uploading', 'an untagged row with a fresh heartbeat may still be live');
  assert.equal(rowOf(mine).upload_state, 'uploading', 'this page holds the file');
  const label = tray.labelForTrayRow(rowOf(stale));
  assert.match(label.label, /Add it again/);
  assert.equal(label.retryable, false, 'no bytes, so no Retry — the copy says what to do');
});

test('uploadFirmDocuments: a refused file is held (not failed), then stored and registered on the backoff without re-selecting it', async () => {
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, writable: true, value: class {
    readAsDataURL(file) { file.arrayBuffer().then((buffer) => { this.result = `data:${file.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onload(); }); }
  } });
  let refusals = 1;
  const seen = [];
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (url, init = {}) => {
    const path = String(url);
    seen.push(path.includes('upload-url') ? 'upload-url' : path.includes('/register') ? 'register' : 'put');
    if (path.includes('/documents/upload-url')) {
      if (refusals > 0) {
        refusals -= 1;
        return new Response(JSON.stringify({ error: 'Donna is completing a runtime readiness recovery before accepting new automated work.', code: 'ENTITY_READINESS_ADMISSION_BLOCKED' }), { status: 503 });
      }
      return new Response(JSON.stringify({ signed_url: 'https://storage.test/put', bucket: 'donna-evidence', key: 'c1/receipt.pdf', provider: 'supabase_storage', content_type: 'application/pdf' }), { status: 200 });
    }
    if (path.includes('/documents/register')) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ documents: body.documents.map((doc) => ({ id: doc.id, parse_status: 'pending', parse_run_id: 'run-1' })) }), { status: 200 });
    }
    return new Response('', { status: 200 });
  } });

  const file = new File([Buffer.from('%PDF-1.4 receipt')], 'receipt.pdf', { type: 'application/pdf' });
  const result = await uploadFirmDocuments({ files: [file], clientId: 'c1' });
  assert.deepEqual(result.failed, [], 'a held file is not reported as failed');
  assert.deepEqual(result.held, ['receipt.pdf']);
  const rowId = tray.loadTrayState().batches[0].rows[0].row_id;
  assert.equal(rowOf(rowId).upload_state, 'held');

  await advance(retained.HELD_RETRY_DELAYS_MS[0]);
  // The timer starts the re-send and does not hand back its promise; the real
  // path (FileReader, fetch) settles asynchronously. Wait for the row's end
  // state — stored AND registered, or failed or held again — bounded in real
  // time rather than by a count of event-loop turns, which a loaded machine can
  // outrun. (`uploaded` is set when the bytes are stored, before register.)
  const settled = (row) => row.upload_state === 'failed' || row.upload_state === 'held' || (row.upload_state === 'uploaded' && row.document_id);
  const settleBy = Date.now() + 5_000;
  while (!settled(rowOf(rowId)) && Date.now() < settleBy) await new Promise((resolve) => setImmediate(resolve));
  const row = rowOf(rowId);
  assert.equal(row.upload_state, 'uploaded', JSON.stringify(row));
  assert.equal(row.storage_object_key, 'c1/receipt.pdf');
  assert.ok(row.document_id, 'registered after the re-send');
  assert.equal(row.parse_status, 'pending');
  assert.deepEqual(seen, ['upload-url', 'upload-url', 'put', 'register']);
});

test('a file retained under one signed-in session is never re-sent under another', async () => {
  const rowId = oneRow();
  let sent = 0;
  retained.retainUpload({ rowId, resend: async () => { sent += 1; } });
  retained.recordUploadFailure({ rowId, error: refused() });
  window.localStorage.setItem('donna.auth_session.v1', JSON.stringify({ access_token: 'token-two', user: { id: 'two' } }));
  await advance(retained.HELD_RETRY_DELAYS_MS[0]);
  assert.equal(sent, 0, 'the held file did not go out under the new session');
  assert.equal(retained.holdsRetainedUpload(rowId), false, 'and it was released');
  window.localStorage.removeItem('donna.auth_session.v1');
});
