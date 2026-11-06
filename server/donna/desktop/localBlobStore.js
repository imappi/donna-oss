// Desktop content-addressed blob store (technical plan §6) — the local
// backend behind evidenceStorage.js's host gate. Layout under the data dir:
//
//   <root>/sha256/ab/<full-hash>.bin      ← immutable source bytes
//
// Per the plan: content hash AS identity · immutable bytes (nothing in the
// store is ever mutated; a re-upload of identical bytes deduplicates to the
// same file) · original filename as metadata only · MIME + byte length in
// the index (migration 113) · atomic write (temp file + rename) · hash
// verification on read, so corruption is a loud error rather than quiet rot.
//
// The (bucket, key) namespace is the EXISTING pipeline contract — callers of
// evidenceStorage.js don't change; the index maps their keys onto hashes.
//
// Local "signed URLs" replace Supabase's: an HMAC token over
// (method, bucket, key, expiry, optional readiness generation) with a secret derived from the runtime's
// access token. The router's /api/donna/evidence-local route verifies the
// token and serves or accepts bytes — same call shapes the SPA already uses
// (plain GET; plain PUT of raw bytes). The token is the control, the same
// posture as the OAuth signed-callback paths.

import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const hashEvidenceBytes = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');

export const blobPathForHash = (rootDir, contentHash) =>
  path.join(rootDir, 'sha256', contentHash.slice(0, 2), `${contentHash}.bin`);

export const putLocalEvidenceObject = async ({
  client, rootDir, bucket, key, bytes, contentType = null, originalFilename = null
} = {}) => {
  if (!client || !rootDir || !bucket || !key || !Buffer.isBuffer(bytes) || bytes.length === 0) {
    const error = new Error('putLocalEvidenceObject requires client, rootDir, bucket, key, and non-empty bytes.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_BLOB_PUT_INVALID';
    throw error;
  }
  const contentHash = hashEvidenceBytes(bytes);
  const finalPath = blobPathForHash(rootDir, contentHash);
  let deduplicated = true;
  if (!existsSync(finalPath)) {
    deduplicated = false;
    mkdirSync(path.dirname(finalPath), { recursive: true });
    // Atomic: a crash mid-write leaves a temp file, never a torn blob.
    const tempPath = `${finalPath}.tmp-${crypto.randomUUID()}`;
    writeFileSync(tempPath, bytes);
    renameSync(tempPath, finalPath);
  }
  await client.query(
    `insert into local_evidence_objects (bucket, key, content_hash, byte_length, content_type, original_filename)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (bucket, key)
       do update set content_hash = excluded.content_hash,
                     byte_length = excluded.byte_length,
                     content_type = excluded.content_type,
                     original_filename = excluded.original_filename,
                     created_at = now()`,
    [bucket, key, contentHash, bytes.length, contentType, originalFilename]
  );
  return { content_hash: contentHash, byte_length: bytes.length, deduplicated };
};

export const getLocalEvidenceObject = async ({ client, rootDir, bucket, key } = {}) => {
  if (!client || !rootDir || !bucket || !key) {
    const error = new Error('getLocalEvidenceObject requires client, rootDir, bucket, and key.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_BLOB_GET_INVALID';
    throw error;
  }
  const result = await client.query(
    'select content_hash, byte_length, content_type, original_filename from local_evidence_objects where bucket = $1 and key = $2',
    [bucket, key]
  );
  const row = result.rows?.[0];
  if (!row) {
    const error = new Error(`Evidence object not found: ${bucket}/${key}`);
    error.statusCode = 404;
    error.code = 'EVIDENCE_BLOB_NOT_FOUND';
    throw error;
  }
  const filePath = blobPathForHash(rootDir, row.content_hash);
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch {
    const error = new Error(`Evidence blob missing on disk for ${bucket}/${key} (${row.content_hash}).`);
    error.statusCode = 500;
    error.code = 'EVIDENCE_BLOB_MISSING';
    throw error;
  }
  // Verify-on-read (plan §6 asks it on restore/export; blobs are ≤10MB, so
  // paying it on every read makes corruption loud at first touch).
  if (hashEvidenceBytes(bytes) !== row.content_hash) {
    const error = new Error(`Evidence blob corrupt for ${bucket}/${key}: hash mismatch.`);
    error.statusCode = 500;
    error.code = 'EVIDENCE_BLOB_CORRUPT';
    throw error;
  }
  return {
    bytes,
    content_hash: row.content_hash,
    byte_length: Number(row.byte_length),
    content_type: row.content_type || 'application/octet-stream',
    original_filename: row.original_filename || null
  };
};

// Matches the Supabase listing shape ({name, size, updated_at, created_at})
// so the orphan-cleanup cron reads either backend identically.
export const listLocalEvidenceObjects = async ({ client, bucket, prefix = '', maxItems = 5000 } = {}) => {
  if (!client || !bucket) return [];
  const result = await client.query(
    `select key, byte_length, created_at from local_evidence_objects
     where bucket = $1 and key like $2 || '%'
     order by key
     limit $3`,
    [bucket, String(prefix || ''), maxItems]
  );
  return (result.rows || []).map((row) => ({
    name: row.key,
    size: Number(row.byte_length) || 0,
    updated_at: row.created_at || null,
    created_at: row.created_at || null
  }));
};

export const deleteLocalEvidenceObjects = async ({ client, rootDir, bucket, keys = [] } = {}) => {
  if (!client || !rootDir || !bucket || !Array.isArray(keys) || keys.length === 0) {
    return { deleted: 0, errors: [] };
  }
  const removed = await client.query(
    'delete from local_evidence_objects where bucket = $1 and key = any($2::text[]) returning key, content_hash',
    [bucket, keys.filter(Boolean)]
  );
  const rows = removed.rows || [];
  const candidateHashes = [...new Set(rows.map((r) => r.content_hash))];
  if (candidateHashes.length) {
    // GC: unlink blobs no key (in ANY bucket) references anymore.
    const still = await client.query(
      'select distinct content_hash from local_evidence_objects where content_hash = any($1::text[])',
      [candidateHashes]
    );
    const referenced = new Set((still.rows || []).map((r) => r.content_hash));
    for (const hash of candidateHashes) {
      if (referenced.has(hash)) continue;
      try {
        unlinkSync(blobPathForHash(rootDir, hash));
      } catch { /* already gone — deletion is idempotent */ }
    }
  }
  return { deleted: rows.length, errors: [] };
};

// --- Local signed-URL tokens -----------------------------------------------

export const deriveLocalEvidenceSecret = (accessToken) => {
  if (!accessToken) {
    const error = new Error('Local evidence tokens need DONNA_ACCESS_TOKEN to derive their secret.');
    error.statusCode = 503;
    error.code = 'EVIDENCE_LOCAL_SECRET_MISSING';
    throw error;
  }
  return crypto.createHash('sha256').update(`donna-local-evidence:${accessToken}`).digest();
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const tokenSignature = (secret, payloadB64) =>
  crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

export const signLocalEvidenceToken = ({
  secret,
  method,
  bucket,
  key,
  expiresAtMs,
  readinessClaim = null
} = {}) => {
  const firmId = String(readinessClaim?.firm_id || '').trim();
  const clientId = String(readinessClaim?.client_id || '').trim();
  const entityDependencyDigest = String(readinessClaim?.entity_dependency_digest || '').trim();
  const hasReadinessClaim = Boolean(firmId || clientId || entityDependencyDigest);
  if (hasReadinessClaim && (!firmId || !clientId || !entityDependencyDigest)) {
    throw new Error('Local evidence readiness claim needs firm_id, client_id and entity_dependency_digest.');
  }
  const payload = b64url(JSON.stringify({
    m: String(method).toUpperCase(),
    b: bucket,
    k: key,
    e: expiresAtMs,
    ...(hasReadinessClaim ? { f: firmId, c: clientId, g: entityDependencyDigest } : {})
  }));
  return `${payload}.${tokenSignature(secret, payload)}`;
};

export const verifyLocalEvidenceToken = ({ secret, token, method, nowMs = Date.now() } = {}) => {
  const [payloadB64, signature] = String(token || '').split('.');
  if (!payloadB64 || !signature) return null;
  const expected = tokenSignature(secret, payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.m !== String(method).toUpperCase()) return null;
  if (!payload.b || !payload.k) return null;
  if (!Number.isFinite(payload.e) || payload.e < nowMs) return null;
  const hasReadinessClaim = Boolean(payload.f || payload.c || payload.g);
  if (hasReadinessClaim && (!payload.f || !payload.c || !payload.g)) return null;
  return {
    bucket: payload.b,
    key: payload.k,
    expiresAtMs: payload.e,
    ...(hasReadinessClaim ? {
      firmId: payload.f,
      clientId: payload.c,
      entityDependencyDigest: payload.g
    } : {})
  };
};
