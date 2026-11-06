// localBlobStore — the desktop content-addressed evidence store (plan §6).
// Real filesystem (temp dir) + a stateful in-memory index client. What must
// hold: content hash IS identity (dedupe on identical bytes), atomic-write
// layout, verify-on-read makes corruption loud, GC unlinks a blob only when
// its LAST reference goes, listing matches the Supabase shape, and the HMAC
// token scheme rejects tamper/expiry/method confusion.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  blobPathForHash, deleteLocalEvidenceObjects, deriveLocalEvidenceSecret,
  getLocalEvidenceObject, hashEvidenceBytes, listLocalEvidenceObjects,
  putLocalEvidenceObject, signLocalEvidenceToken, verifyLocalEvidenceToken
} from './localBlobStore.js';

const makeIndexClient = () => {
  const rows = new Map();
  return {
    rows,
    query: async (sql, params) => {
      const text = String(sql).toLowerCase().replace(/\s+/g, ' ').trim();
      if (text.startsWith('insert into local_evidence_objects')) {
        const [bucket, key, hash, len, ct, fn] = params;
        rows.set(`${bucket}\n${key}`, {
          bucket, key, content_hash: hash, byte_length: len,
          content_type: ct, original_filename: fn, created_at: new Date()
        });
        return { rows: [] };
      }
      if (text.startsWith('select content_hash, byte_length')) {
        const row = rows.get(`${params[0]}\n${params[1]}`);
        return { rows: row ? [row] : [] };
      }
      if (text.startsWith('select key, byte_length')) {
        const [bucket, prefix, limit] = params;
        const out = [...rows.values()]
          .filter((r) => r.bucket === bucket && r.key.startsWith(prefix))
          .sort((a, b) => (a.key < b.key ? -1 : 1))
          .slice(0, limit)
          .map((r) => ({ key: r.key, byte_length: r.byte_length, created_at: r.created_at }));
        return { rows: out };
      }
      if (text.startsWith('delete from local_evidence_objects')) {
        const [bucket, keys] = params;
        const out = [];
        for (const k of keys) {
          const id = `${bucket}\n${k}`;
          const r = rows.get(id);
          if (r) { rows.delete(id); out.push({ key: k, content_hash: r.content_hash }); }
        }
        return { rows: out };
      }
      if (text.startsWith('select distinct content_hash')) {
        const [hashes] = params;
        const present = new Set(
          [...rows.values()].map((r) => r.content_hash).filter((h) => hashes.includes(h))
        );
        return { rows: [...present].map((h) => ({ content_hash: h })) };
      }
      throw new Error(`unexpected sql: ${text}`);
    }
  };
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'donna-blob-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const BYTES = Buffer.from('the same receipt bytes');
const BUCKET = 'donna-evidence';

test('put → get round-trips with hash identity, metadata, and no temp-file litter', async () => {
  const client = makeIndexClient();
  const put = await putLocalEvidenceObject({
    client, rootDir: tmp, bucket: BUCKET, key: 'firm/client/evidence/2026-08/a.pdf',
    bytes: BYTES, contentType: 'application/pdf', originalFilename: 'a.pdf'
  });
  assert.equal(put.content_hash, hashEvidenceBytes(BYTES));
  assert.equal(put.deduplicated, false);
  assert.ok(existsSync(blobPathForHash(tmp, put.content_hash)));
  const dir = path.dirname(blobPathForHash(tmp, put.content_hash));
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), 'atomic write leaves no temp files');

  const got = await getLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'firm/client/evidence/2026-08/a.pdf' });
  assert.deepEqual(got.bytes, BYTES);
  assert.equal(got.content_type, 'application/pdf');
  assert.equal(got.original_filename, 'a.pdf');
});

test('identical bytes under a second key deduplicate to one blob file', async () => {
  const client = makeIndexClient();
  const first = await putLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'k1', bytes: BYTES });
  const second = await putLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'k2', bytes: BYTES });
  assert.equal(second.content_hash, first.content_hash);
  assert.equal(second.deduplicated, true);
});

test('missing index row → 404; blob gone from disk → 500 MISSING; tamper → 500 CORRUPT', async () => {
  const client = makeIndexClient();
  await assert.rejects(
    () => getLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'nope' }),
    (e) => e.code === 'EVIDENCE_BLOB_NOT_FOUND' && e.statusCode === 404
  );

  const gone = Buffer.from('will vanish from disk');
  await putLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'gone', bytes: gone });
  rmSync(blobPathForHash(tmp, hashEvidenceBytes(gone)));
  await assert.rejects(
    () => getLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'gone' }),
    (e) => e.code === 'EVIDENCE_BLOB_MISSING'
  );

  const tampered = Buffer.from('original honest bytes');
  await putLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'tampered', bytes: tampered });
  writeFileSync(blobPathForHash(tmp, hashEvidenceBytes(tampered)), Buffer.from('quietly swapped bytes'));
  await assert.rejects(
    () => getLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'tampered' }),
    (e) => e.code === 'EVIDENCE_BLOB_CORRUPT',
    'verify-on-read makes silent swap a loud error'
  );
});

test('listing matches the Supabase shape and respects prefix', async () => {
  const client = makeIndexClient();
  await putLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'firmA/x.pdf', bytes: Buffer.from('x') });
  await putLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'firmB/y.pdf', bytes: Buffer.from('y') });
  const listed = await listLocalEvidenceObjects({ client, bucket: BUCKET, prefix: 'firmA/' });
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['created_at', 'name', 'size', 'updated_at']);
  assert.equal(listed[0].name, 'firmA/x.pdf');
  assert.equal(listed[0].size, 1);
});

test('delete GCs a blob only when its LAST reference goes', async () => {
  const client = makeIndexClient();
  const shared = Buffer.from('shared across two keys');
  await putLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'ref1', bytes: shared });
  await putLocalEvidenceObject({ client, rootDir: tmp, bucket: BUCKET, key: 'ref2', bytes: shared });
  const blobFile = blobPathForHash(tmp, hashEvidenceBytes(shared));

  const first = await deleteLocalEvidenceObjects({ client, rootDir: tmp, bucket: BUCKET, keys: ['ref1'] });
  assert.equal(first.deleted, 1);
  assert.ok(existsSync(blobFile), 'still referenced by ref2 — file stays');

  const second = await deleteLocalEvidenceObjects({ client, rootDir: tmp, bucket: BUCKET, keys: ['ref2'] });
  assert.equal(second.deleted, 1);
  assert.ok(!existsSync(blobFile), 'last reference gone — blob unlinked');
});

test('tokens: round-trip, method scope, expiry, tamper, garbage', () => {
  const secret = deriveLocalEvidenceSecret('access-token-abc');
  const token = signLocalEvidenceToken({
    secret, method: 'GET', bucket: BUCKET, key: 'firm/doc.pdf', expiresAtMs: Date.now() + 60_000
  });
  const claim = verifyLocalEvidenceToken({ secret, token, method: 'GET' });
  assert.deepEqual({ bucket: claim.bucket, key: claim.key }, { bucket: BUCKET, key: 'firm/doc.pdf' });

  assert.equal(verifyLocalEvidenceToken({ secret, token, method: 'PUT' }), null, 'a GET token cannot PUT');
  const expired = signLocalEvidenceToken({
    secret, method: 'GET', bucket: BUCKET, key: 'k', expiresAtMs: Date.now() - 1000
  });
  assert.equal(verifyLocalEvidenceToken({ secret, token: expired, method: 'GET' }), null);
  const otherSecret = deriveLocalEvidenceSecret('different-token');
  assert.equal(verifyLocalEvidenceToken({ secret: otherSecret, token, method: 'GET' }), null);
  const [payload] = token.split('.');
  assert.equal(verifyLocalEvidenceToken({ secret, token: `${payload}.forged`, method: 'GET' }), null);
  assert.equal(verifyLocalEvidenceToken({ secret, token: 'garbage', method: 'GET' }), null);
  assert.equal(verifyLocalEvidenceToken({ secret, token: '', method: 'GET' }), null);
});

test('PUT token binds an all-or-none firm/client/entity readiness generation claim', () => {
  const secret = deriveLocalEvidenceSecret('runtime-token');
  const token = signLocalEvidenceToken({
    secret,
    method: 'PUT',
    bucket: 'evidence',
    key: 'firm/client/file.pdf',
    expiresAtMs: 5_000,
    readinessClaim: {
      firm_id: 'firm-1',
      client_id: 'client-1',
      entity_dependency_digest: 'generation-1'
    }
  });
  assert.deepEqual(verifyLocalEvidenceToken({ secret, token, method: 'PUT', nowMs: 1_000 }), {
    bucket: 'evidence',
    key: 'firm/client/file.pdf',
    expiresAtMs: 5_000,
    firmId: 'firm-1',
    clientId: 'client-1',
    entityDependencyDigest: 'generation-1'
  });
  assert.throws(() => signLocalEvidenceToken({
    secret,
    method: 'PUT',
    bucket: 'evidence',
    key: 'file.pdf',
    expiresAtMs: 5_000,
    readinessClaim: { firm_id: 'firm-1' }
  }), /firm_id, client_id and entity_dependency_digest/);
});

test('derive refuses an empty access token', () => {
  assert.throws(() => deriveLocalEvidenceSecret(''), (e) => e.code === 'EVIDENCE_LOCAL_SECRET_MISSING');
});
