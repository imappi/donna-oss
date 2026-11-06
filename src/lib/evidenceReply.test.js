// A reply that carries files goes out only when every file landed.
//
// node --test src/lib/evidenceReply.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { requireEveryEvidenceFile, requireEveryRegistration } from './evidenceReply.js';

test('every file landed → the documents, in order', () => {
  const docs = requireEveryEvidenceFile([
    { document: { id: 'doc-1' } },
    { document: { id: 'doc-2' } }
  ]);
  assert.deepEqual(docs.map((d) => d.id), ['doc-1', 'doc-2']);
});

test('one failed file fails the whole send with THAT file\'s message — never an empty reply', () => {
  assert.throws(
    () => requireEveryEvidenceFile([
      { document: { id: 'doc-1' } },
      { error: new Error('Unsupported evidence file type.') },
      { error: new Error('Load failed') }
    ]),
    (error) => error.code === 'EVIDENCE_UPLOAD_INCOMPLETE'
      && error.message === 'Unsupported evidence file type.'
      && error.failed_count === 2
      && error.landed_count === 1
  );
});

test('a failure without a message still fails loudly with the fallback', () => {
  assert.throws(
    () => requireEveryEvidenceFile([{ error: {} }], { fallbackMessage: 'Upload failed.' }),
    (error) => error.code === 'EVIDENCE_UPLOAD_INCOMPLETE' && error.message === 'Upload failed.'
  );
  assert.throws(
    () => requireEveryEvidenceFile([{ error: null, document: null }, { error: 'plain string reason' }]),
    (error) => error.message === 'plain string reason'
  );
});

test('no files → nothing to require, nothing to send', () => {
  assert.deepEqual(requireEveryEvidenceFile([]), []);
  assert.deepEqual(requireEveryEvidenceFile(undefined), []);
});

test('registration must return one registered document per document sent', () => {
  const sent = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(requireEveryRegistration(sent, [{ id: 'a' }, { id: 'b' }]).map((d) => d.id), ['a', 'b']);
  assert.throws(
    () => requireEveryRegistration(sent, [{ id: 'a' }]),
    (error) => error.code === 'EVIDENCE_REGISTER_INCOMPLETE' && error.failed_count === 1 && error.landed_count === 1
  );
  assert.throws(
    () => requireEveryRegistration(sent, undefined, { fallbackMessage: 'queue failed' }),
    (error) => error.message === 'queue failed' && error.failed_count === 2
  );
});
