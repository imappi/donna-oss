// The local-Swift-OCR host gate (findings §4b-vii). The Apple-Vision OCR
// tier preempts cloud structured vision whenever its output "looks like a
// statement", which on the desktop host (a Mac, by definition) shipped a
// corrupted statement extraction. The gate turns the tier OFF when the
// desktop host signal (DONNA_DESKTOP_BLOB_DIR) is present, with
// BANK_STATEMENT_LOCAL_OCR as the explicit override in both directions.
// Pure predicate tests — the Swift exec path itself is not run here.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isLocalOcrEnabled } from './bankStatement.js';

test('default host (no desktop signal, no override) → local OCR enabled', () => {
  assert.equal(isLocalOcrEnabled({}), true);
});

test('desktop host (DONNA_DESKTOP_BLOB_DIR set) → local OCR disabled', () => {
  assert.equal(isLocalOcrEnabled({ DONNA_DESKTOP_BLOB_DIR: '/tmp/blobs' }), false);
});

test('explicit BANK_STATEMENT_LOCAL_OCR=off kills the tier on any host', () => {
  assert.equal(isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: 'off' }), false);
  assert.equal(isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: 'false' }), false);
  assert.equal(isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: '0' }), false);
  assert.equal(
    isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: 'no', DONNA_DESKTOP_BLOB_DIR: '' }),
    false
  );
});

test('explicit BANK_STATEMENT_LOCAL_OCR=on restores the tier on desktop', () => {
  assert.equal(
    isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: 'on', DONNA_DESKTOP_BLOB_DIR: '/tmp/blobs' }),
    true
  );
  assert.equal(
    isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: 'true', DONNA_DESKTOP_BLOB_DIR: '/tmp/blobs' }),
    true
  );
});

test('unrecognised or blank override falls back to the host default', () => {
  assert.equal(isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: 'maybe' }), true);
  assert.equal(
    isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: 'maybe', DONNA_DESKTOP_BLOB_DIR: '/tmp/blobs' }),
    false
  );
  assert.equal(
    isLocalOcrEnabled({ BANK_STATEMENT_LOCAL_OCR: '   ', DONNA_DESKTOP_BLOB_DIR: '/tmp/blobs' }),
    false
  );
});
