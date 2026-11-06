import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEvidenceUploadReference, buildEvidenceStorageKey } from './evidenceStorage.js';

const firmId = 'firm-a', clientId = 'client-a';
const key = 'firm-a/client-a/evidence/2026-09/file.pdf';
const document = { client_id: clientId, storage_bucket: 'donna-evidence', storage_object_key: key };
const validate = (patch = {}, options = {}) => assertEvidenceUploadReference({ firmId, document: { ...document, ...patch }, env: {}, ...options });
const refused = fn => assert.throws(fn, { code: 'EVIDENCE_UPLOAD_REFERENCE_INVALID', statusCode: 403 });

test('generic references are losslessly scoped; bucket/provider aliases and absent provider retain host contract', () => {
  validate();
  for (const provider of ['supabase_storage', null]) validate({ storage_provider: provider });
  validate({ storage_provider: 'local_blob' }, { env: { DONNA_DESKTOP_BLOB_DIR: '/fixture' } });
  validate({ storage_bucket: 'custom' }, { env: { DONNA_EVIDENCE_BUCKET: 'custom' } });
  validate({ storage_bucket: 'custom' }, { env: { SUPABASE_EVIDENCE_BUCKET: 'custom' } });
  validate({ storage_key: key, file_storage: { bucket: 'donna-evidence', key, provider: 'supabase_storage' },
    payload: { storage_bucket: 'donna-evidence', storage_key: key, storage_provider: 'supabase_storage' } });
  const built = buildEvidenceStorageKey({ firmId, clientId, filename: 'fixture.pdf' });
  validate({ storage_object_key: built });
});

test('foreign references, traversal and every conflicting storage home refuse', () => {
  for (const storage_object_key of ['firm-b/client-a/evidence/file', 'firm-a/client-b/evidence/file',
    'firm-a/client-a/__quarantine__/file', 'firm-a/client-a/evidence/../client-b/file',
    'firm-a/client-a/evidence/%2e%2e/file', 'firm-a/client-a/evidence/a%2fb',
    'firm-a/client-a/evidence/a%252fb', 'firm-a/client-a/evidence/a\\b',
    '/firm-a/client-a/evidence/file', 'firm-a/client-a/evidence//file', 'firm-a/client-a/evidence/a\u0000b']) refused(() => validate({ storage_object_key }));
  refused(() => validate({ storage_bucket: 'foreign' }));
  for (const provider of ['supabase', 'unsupported', 'local_blob', '']) refused(() => validate({ storage_provider: provider }));
  for (const [field, value] of [['bucket','foreign'], ['key','foreign'], ['provider','local_blob']]) {
    refused(() => validate({ file_storage: { [field]: value } }));
    refused(() => validate({ payload: { file_storage: { [field]: value } } }));
  }
  for (const [field, value] of [['storage_bucket','foreign'], ['storage_key','foreign'],
    ['storage_object_key','foreign'], ['storage_provider','local_blob']]) {
    refused(() => validate({ [field]: value }));
    refused(() => validate({ payload: { [field]: value } }));
  }
});

test('sanitization collisions cannot grant a generic capability or register an alias', () => {
  for (const id of ['client:a', 'client a', 'café', 'a'.repeat(121), '..', '.', '', 'client/a', 'client%2fa']) {
    refused(() => buildEvidenceStorageKey({ firmId, clientId: id, filename: 'x.pdf' }));
    refused(() => validate({ client_id: id }));
    refused(() => buildEvidenceStorageKey({ firmId: id, clientId, filename: 'x.pdf' }));
  }
  for (const id of ['client-a', 'cafe', 'a'.repeat(120)]) {
    const ownKey = buildEvidenceStorageKey({ firmId, clientId: id, filename: 'x.pdf' });
    validate({ client_id: id, storage_object_key: ownKey });
  }
  // Exact pilot intent has its own authority; generic sanitization is irrelevant.
  validate({ client_id: 'pilot:one', storage_object_key: 'firm-a/pilot:one/__quarantine__/id/file' }, { generic: false });
});
