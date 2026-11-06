// Firm-side upload session — guard-rail tests. Only the IO-free paths are
// unit-testable here (the storage PUT and register call are integration
// territory); the caps must refuse BEFORE any tray row or upload starts, so
// a rejected batch leaves no orphan rows behind.
// node --test src/lib/documentUploadSession.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_UPLOAD_BATCH_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  uploadFirmDocuments
} from './documentUploadSession.js';

const fakeFile = (name, size) => ({ name, size, type: 'application/pdf' });

test('no client or no files resolves empty without touching anything', async () => {
  assert.deepEqual(await uploadFirmDocuments({ files: [], clientId: 'c1' }), { registered: [], failed: [], held: [] });
  assert.deepEqual(await uploadFirmDocuments({ files: [fakeFile('a.pdf', 10)], clientId: '' }), { registered: [], failed: [], held: [] });
  assert.deepEqual(await uploadFirmDocuments({}), { registered: [], failed: [], held: [] });
});

test('a batch over the total cap refuses up front', async () => {
  const files = [
    fakeFile('a.pdf', MAX_UPLOAD_BATCH_BYTES - 1024),
    fakeFile('b.pdf', 2048)
  ];
  await assert.rejects(
    uploadFirmDocuments({ files, clientId: 'c1' }),
    /larger than/
  );
});

test('a single file over the per-file cap refuses up front and names the file', async () => {
  const files = [fakeFile('ok.pdf', 1024), fakeFile('huge.pdf', MAX_UPLOAD_FILE_BYTES + 1)];
  await assert.rejects(
    uploadFirmDocuments({ files, clientId: 'c1' }),
    /huge\.pdf/
  );
});

test('the caps match the portal contract (6 MB file inside a 7 MB batch)', () => {
  assert.equal(MAX_UPLOAD_FILE_BYTES, 6 * 1024 * 1024);
  assert.equal(MAX_UPLOAD_BATCH_BYTES, 7 * 1024 * 1024);
  assert.ok(MAX_UPLOAD_FILE_BYTES < MAX_UPLOAD_BATCH_BYTES);
});
