import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { queryFirmDb } from './firmDb.js';
import {
  deleteLocalEvidenceObjects, deriveLocalEvidenceSecret, getLocalEvidenceObject,
  listLocalEvidenceObjects, putLocalEvidenceObject, signLocalEvidenceToken,
  verifyLocalEvidenceToken
} from './desktop/localBlobStore.js';

const cleanEnv = (value = '') => String(value || '').trim().replace(/^['"]|['"]$/g, '');

// --- Desktop host gate (technical plan §6) ---------------------------------
// When DONNA_DESKTOP_BLOB_DIR is set, evidence bytes live in the local
// content-addressed blob store instead of Supabase Storage, and "signed
// URLs" are HMAC-token URLs served by the local router. This is HOST
// configuration (which machine class the runtime is on), not a client
// rollout flag — the config-control-plane rail does not apply. Callers of
// this module are unchanged in either mode; that one-module seam is exactly
// what the M0a findings (§4) promised the desktop build.
//
// A local signed URL is ORIGIN-RELATIVE (`/api/donna/evidence-local?token=…`)
// by contract. The appliance runtime listens on a private Unix socket and has
// no origin of its own; the SPA reaches it through whichever Donna origin
// served the page — `donna://app` in the Electron renderer, the loopback
// portal-preview server in the system browser — and each of those proxies
// `/api/` to the socket with the access token. An absolute base could satisfy
// only one of them: with the pre-2026-09-04 `DONNA_DESKTOP_BASE_URL='donna://app'`
// every file reply and evidence view in the client portal preview failed in
// Safari with WebKit's "Load failed" before a request was made, because an
// http origin cannot fetch a `donna://` URL. Node-side callers that fetch a
// signed URL for real resolve it against the base THEY know
// (`new URL(signed_url, baseUrl)` — the appliance harness); the host
// certificate's local branch writes through the store directly.
export const LOCAL_EVIDENCE_PATH = '/api/donna/evidence-local';

const localEvidenceConfig = () => {
  const rootDir = cleanEnv(process.env.DONNA_DESKTOP_BLOB_DIR || '');
  if (!rootDir) return null;
  return {
    rootDir,
    accessToken: cleanEnv(process.env.DONNA_ACCESS_TOKEN || '')
  };
};

export const isLocalEvidenceStorage = () => Boolean(localEvidenceConfig());

const localDbClient = () => ({ query: (text, params) => queryFirmDb(text, params) });

const localSignedUrl = (config, { method, bucket, key, expiresIn, readinessClaim = null }) => {
  const token = signLocalEvidenceToken({
    secret: deriveLocalEvidenceSecret(config.accessToken),
    method,
    bucket,
    key,
    expiresAtMs: Date.now() + Math.max(1, Number(expiresIn) || 300) * 1000,
    readinessClaim
  });
  return `${LOCAL_EVIDENCE_PATH}?token=${encodeURIComponent(token)}`;
};

// The router's PUT handler calls this; exported here so the route logic
// stays a thin verify-and-delegate.
//
// `client` is the caller's OWN pooled connection and any caller already
// holding one MUST pass it. The `localDbClient()` fallback acquires a fresh
// connection from the shared pool, and asking the pool for a second
// connection while holding a first self-deadlocks once concurrent callers
// outnumber the pool (DATABASE_POOL_MAX defaults to 2): the 2026-08-31
// 40-file drop froze every upload at "Uploading 0%" exactly this way — each
// blob PUT held its admission-transaction connection and waited forever for
// this insert's second one. The fallback exists for standalone callers with
// no transaction of their own (e.g. the host certificate's storage drill).
export const storeLocalEvidenceBytes = async ({ bucket, key, bytes, contentType, client = null } = {}) => {
  const config = localEvidenceConfig();
  if (!config) {
    const error = new Error('Local evidence storage is not enabled.');
    error.statusCode = 503;
    error.code = 'EVIDENCE_LOCAL_MODE_OFF';
    throw error;
  }
  return putLocalEvidenceObject({
    client: client || localDbClient(),
    rootDir: config.rootDir,
    bucket,
    key,
    bytes,
    contentType: contentType || null,
    originalFilename: String(key || '').split('/').pop() || null
  });
};

export const loadLocalEvidenceObject = async ({ bucket, key } = {}) => {
  const config = localEvidenceConfig();
  if (!config) {
    const error = new Error('Local evidence storage is not enabled.');
    error.statusCode = 503;
    error.code = 'EVIDENCE_LOCAL_MODE_OFF';
    throw error;
  }
  return getLocalEvidenceObject({ client: localDbClient(), rootDir: config.rootDir, bucket, key });
};

// Route-side token check: {enabled:false} when the host is not in local
// mode (the route 404s), {enabled:true, claim:null} on a bad/expired token
// (the route 403s), and the {bucket, key} claim on success.
export const verifyLocalEvidenceAccess = ({ token, method } = {}) => {
  const config = localEvidenceConfig();
  if (!config) return { enabled: false, claim: null };
  const claim = verifyLocalEvidenceToken({
    secret: deriveLocalEvidenceSecret(config.accessToken),
    token,
    method
  });
  return { enabled: true, claim };
};

let dotEnvCache = null;
const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim();
      }
    }
  } catch { /* best-effort */ }
  dotEnvCache = vars;
  return vars;
};

const storageConfig = () => {
  const dotEnv = readDotEnv();
  const supabaseUrl = cleanEnv(
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    dotEnv.SUPABASE_URL ||
    dotEnv.VITE_SUPABASE_URL ||
    ''
  ).replace(/\/+$/, '');
  const serviceKey = cleanEnv(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    dotEnv.SUPABASE_SERVICE_ROLE_KEY ||
    dotEnv.SUPABASE_SERVICE_KEY ||
    dotEnv.SUPABASE_SECRET_KEY ||
    ''
  );
  return {
    supabaseUrl,
    key: serviceKey,
    credentialMode: serviceKey ? 'service_role' : 'missing'
  };
};

const encodeStoragePath = (path = '') =>
  String(path)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

export const createEvidenceSignedUrl = async ({ bucket, key, expiresIn = 300 } = {}) => {
  const local = localEvidenceConfig();
  if (local) {
    if (!bucket || !key) {
      const error = new Error('Evidence signed URL needs bucket and key.');
      error.statusCode = 400;
      error.code = 'EVIDENCE_STORAGE_SIGN_FAILED';
      throw error;
    }
    return localSignedUrl(local, { method: 'GET', bucket, key, expiresIn });
  }
  const config = storageConfig();
  if (!config.supabaseUrl || !config.key || !bucket || !key) {
    const error = new Error('Evidence object storage is not configured.');
    error.statusCode = 503;
    error.code = 'EVIDENCE_STORAGE_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeStoragePath(key)}`,
    {
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn })
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || `Evidence signed URL failed with ${response.status}.`);
    error.statusCode = response.status;
    error.code = 'EVIDENCE_STORAGE_SIGN_FAILED';
    error.details = { body, credential_mode: config.credentialMode };
    throw error;
  }
  const signedUrl = body.signedURL || body.signedUrl || '';
  return signedUrl.startsWith('http')
    ? signedUrl
    : `${config.supabaseUrl}/storage/v1${signedUrl.startsWith('/') ? signedUrl : `/${signedUrl}`}`;
};

const safeName = (value = 'evidence') =>
  String(value || 'evidence')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'evidence';

const refuseUploadReference = () => {
  throw Object.assign(new Error('This upload reference does not belong to this company and storage configuration. Upload the file again; older or moved references require a trusted storage migration.'), {
    code: 'EVIDENCE_UPLOAD_REFERENCE_INVALID', statusCode: 403
  });
};

// Generic paths predate signed intent receipts. Their identity components must
// be lossless: sanitized aliases (including truncation) cannot confer ownership.
// This governs new capabilities/registrations, never historical document reads.
export const assertGenericEvidenceUploadIdentity = ({ firmId, clientId } = {}) => {
  for (const id of [firmId, clientId]) {
    if (typeof id !== 'string' || !id || safeName(id) !== id || id === '.' || id === '..') refuseUploadReference();
  }
};

// Registration-time contract: every storage home a registration carries must
// agree on one bucket/key/provider, so nothing contradictory is persisted. The
// persisted documents columns are the canonical reference for the parser AND
// the download route (which never reads payload-derived fields; see
// assertEvidenceDownloadReference). Pilot callers use this metadata check before their persisted intent check;
// only a nonpilot registration additionally uses the generic path contract.
export const assertEvidenceUploadReference = ({ firmId, document, generic = true, env = process.env } = {}) => {
  const bucket = env.DONNA_EVIDENCE_BUCKET || env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence';
  const provider = cleanEnv(env.DONNA_DESKTOP_BLOB_DIR || '') ? 'local_blob' : 'supabase_storage';
  const key = document?.storage_object_key;
  if (document?.storage_bucket !== bucket || typeof key !== 'string' || !key
    || key.includes('\\') || key.includes('%') || /[\u0000-\u0020\u007f]/.test(key)
    || key.split('/').some(part => !part || part === '.' || part === '..')) refuseUploadReference();
  for (const [home, nested] of [[document, false], [document?.file_storage, true], [document?.payload, false], [document?.payload?.file_storage, true]]) {
    if (home == null) continue;
    if (typeof home !== 'object' || Array.isArray(home)) refuseUploadReference();
    for (const field of nested ? ['bucket'] : ['storage_bucket']) {
      if (home[field] != null && home[field] !== bucket) refuseUploadReference();
    }
    for (const field of nested ? ['key'] : ['storage_object_key', 'storage_key']) {
      if (home[field] != null && home[field] !== key) refuseUploadReference();
    }
    for (const field of nested ? ['provider'] : ['storage_provider']) {
      if (home[field] != null && home[field] !== provider) refuseUploadReference();
    }
  }
  if (generic) {
    assertGenericEvidenceUploadIdentity({ firmId, clientId: document.client_id });
    if (!key.startsWith(`${firmId}/${document.client_id}/evidence/`)) refuseUploadReference();
  }
  return { provider };
};

// The download/read-side sibling of assertEvidenceUploadReference: the same
// bucket/key shape contract (one owner), then a tenancy prefix. `bucket`/`key`
// MUST be the persisted documents.storage_bucket/storage_object_key columns,
// never payload-derived. Unlike a registration it does NOT require the generic
// `/evidence/` segment or lossless ids, so historical pilot keys
// (`${firm}/${client}/__quarantine__/...`) still read; it only refuses a key
// outside this exact firm/client prefix.
export const assertEvidenceDownloadReference = ({ firmId, clientId, bucket, key, env = process.env } = {}) => {
  try {
    assertEvidenceUploadReference({ firmId, document: { storage_bucket: bucket, storage_object_key: key }, generic: false, env });
    if (typeof firmId !== 'string' || !firmId || typeof clientId !== 'string' || !clientId
      || firmId.includes('/') || clientId.includes('/')
      || !key.startsWith(`${firmId}/${clientId}/`)) refuseUploadReference();
  } catch (error) {
    if (error?.code !== 'EVIDENCE_UPLOAD_REFERENCE_INVALID') throw error;
    throw Object.assign(new Error('This document\'s stored file reference does not belong to this company and storage configuration.'), {
      code: 'EVIDENCE_DOWNLOAD_REFERENCE_INVALID', statusCode: 403
    });
  }
};

export const buildEvidenceStorageKey = ({
  firmId,
  clientId,
  evidenceRequestId,
  transactionId,
  checksum,
  filename
} = {}) => {
  assertGenericEvidenceUploadIdentity({ firmId, clientId });
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const idPart = evidenceRequestId || transactionId || crypto.randomUUID();
  return [
    safeName(firmId || 'firm'),
    safeName(clientId || 'client'),
    'evidence',
    period,
    `${safeName(idPart)}-${String(checksum || crypto.randomUUID()).slice(0, 16)}-${safeName(filename)}`
  ].join('/');
};

// Fetch raw object bytes via the service-role key. Used by the async-parse
// worker: pre-signed URLs are short-lived (≤10min) and would expire on
// Inngest's retry backoff, so the worker always re-fetches via the API
// rather than trusting a signed URL stored on the document row.
// `freshRead` asks the storage edge for the object as stored right now, not
// a cached copy: the CI attestation read-back verifies an upsert it just made
// (2026-09-21: the first live run read the previous artifact back and failed).
export const fetchEvidenceObjectBytes = async ({ bucket, key, signal, maxBytes = null, freshRead = false } = {}) => {
  if (isLocalEvidenceStorage()) {
    return (await loadLocalEvidenceObject({ bucket, key })).bytes;
  }
  const config = storageConfig();
  if (!config.supabaseUrl || !config.key || !bucket || !key) {
    const error = new Error('Evidence object storage is not configured with a service-role key.');
    error.statusCode = 503;
    error.code = 'EVIDENCE_STORAGE_SERVICE_KEY_REQUIRED';
    throw error;
  }
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(key)}`,
    {
      ...(signal ? { signal } : {}),
      method: 'GET',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        ...(freshRead ? { 'cache-control': 'no-cache', pragma: 'no-cache' } : {})
      }
    }
  );
  if (!response.ok) {
    const detailText = await response.text().catch(() => '');
    const error = new Error(`Evidence storage download failed with ${response.status}: ${detailText.slice(0, 200)}`);
    error.statusCode = response.status;
    error.code = 'EVIDENCE_STORAGE_DOWNLOAD_FAILED';
    throw error;
  }
  if (maxBytes != null) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Positive byte limit required.');
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw Object.assign(new Error('Evidence object exceeds its declared limit.'), { code: 'EVIDENCE_OBJECT_TOO_LARGE' });
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

// Recursively list objects under a prefix in a Supabase Storage bucket.
// Supabase's POST /storage/v1/object/list/{bucket} is a flat listing that
// does NOT recurse into subdirectories — so the orphan-cleanup cron
// (PR 4) drives recursion itself by following `name`s that look like a
// folder boundary. Returns flat {name, size, updated_at, created_at}
// entries with keys joined relative to the bucket root.
//
// `pageSize`/`maxItems` cap response volume so a runaway bucket can't
// pin the cron's memory. `olderThanMs` filters in-process so the cron
// can also pass it to the SQL cross-reference query.
export const listEvidenceObjects = async ({
  bucket,
  prefix = '',
  pageSize = 200,
  maxItems = 5000,
  signal
} = {}) => {
  const local = localEvidenceConfig();
  if (local) {
    return listLocalEvidenceObjects({ client: localDbClient(), bucket, prefix, maxItems });
  }
  const config = storageConfig();
  if (!config.supabaseUrl || !config.key || !bucket) {
    const error = new Error('Evidence object storage is not configured with a service-role key.');
    error.statusCode = 503;
    error.code = 'EVIDENCE_STORAGE_SERVICE_KEY_REQUIRED';
    throw error;
  }
  const collected = [];
  // BFS so each directory is explored level by level. Supabase
  // distinguishes folder entries (id == null) from object entries
  // (id != null) — folders push back into the queue, objects collect.
  const queue = [String(prefix || '')];
  while (queue.length && collected.length < maxItems) {
    const cursor = queue.shift();
    let offset = 0;
    while (collected.length < maxItems) {
      const body = {
        prefix: cursor,
        limit: Math.min(1000, Math.max(1, Number(pageSize) || 200)),
        offset,
        sortBy: { column: 'name', order: 'asc' }
      };
      const response = await fetch(
        `${config.supabaseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
        {
          ...(signal ? { signal } : {}),
          method: 'POST',
          headers: {
            apikey: config.key,
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }
      );
      if (!response.ok) {
        const detailText = await response.text().catch(() => '');
        const error = new Error(`Evidence storage list failed with ${response.status}: ${detailText.slice(0, 200)}`);
        error.statusCode = response.status;
        error.code = 'EVIDENCE_STORAGE_LIST_FAILED';
        throw error;
      }
      const page = await response.json().catch(() => []);
      signal?.throwIfAborted();
      if (!Array.isArray(page) || page.length === 0) break;
      for (const entry of page) {
        const name = String(entry?.name || '').trim();
        if (!name) continue;
        const joined = cursor ? `${cursor.replace(/\/+$/, '')}/${name}` : name;
        // Supabase encodes "folders" as rows where `id` is null and
        // metadata is empty. Objects have an `id` and a real size.
        if (entry?.id == null) {
          queue.push(joined);
          continue;
        }
        collected.push({
          name: joined,
          size: Number(entry?.metadata?.size ?? entry?.size ?? 0) || 0,
          updated_at: entry?.updated_at || null,
          created_at: entry?.created_at || null
        });
        if (collected.length >= maxItems) break;
      }
      if (page.length < body.limit) break;
      offset += page.length;
    }
  }
  return collected;
};

// Hard-deletes one or more storage objects in a single bucket. Supabase
// accepts a DELETE with a JSON body listing keys; we cap the request
// size to keep error reporting tractable.
export const deleteEvidenceObjects = async ({ bucket, keys = [], signal } = {}) => {
  if (!Array.isArray(keys) || keys.length === 0) return { deleted: 0, errors: [] };
  const local = localEvidenceConfig();
  if (local) {
    return deleteLocalEvidenceObjects({ client: localDbClient(), rootDir: local.rootDir, bucket, keys });
  }
  const config = storageConfig();
  if (!config.supabaseUrl || !config.key || !bucket) {
    const error = new Error('Evidence object storage is not configured with a service-role key.');
    error.statusCode = 503;
    error.code = 'EVIDENCE_STORAGE_SERVICE_KEY_REQUIRED';
    throw error;
  }
  const errors = [];
  let deleted = 0;
  const chunkSize = 200;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize).filter(Boolean);
    if (!chunk.length) continue;
    const response = await fetch(
      `${config.supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`,
      {
        ...(signal ? { signal } : {}),
        method: 'DELETE',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prefixes: chunk })
      }
    );
    if (!response.ok) {
      const detailText = await response.text().catch(() => '');
      errors.push({
        keys: chunk,
        status: response.status,
        detail: detailText.slice(0, 200)
      });
      continue;
    }
    const result = await response.json().catch(() => []);
    signal?.throwIfAborted();
    if (Array.isArray(result)) deleted += result.length;
    else deleted += chunk.length;
  }
  return { deleted, errors };
};

export const createEvidenceSignedUploadUrl = async ({
  bucket = process.env.DONNA_EVIDENCE_BUCKET || process.env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence',
  key,
  expiresIn = 600,
  readinessClaim = null,
  signal
} = {}) => {
  const local = localEvidenceConfig();
  if (local) {
    if (!bucket || !key) {
      const error = new Error('Evidence signed upload URL needs bucket and key.');
      error.statusCode = 400;
      error.code = 'EVIDENCE_STORAGE_UPLOAD_SIGN_FAILED';
      throw error;
    }
    return {
      provider: 'local_blob',
      bucket,
      key,
      signed_url: localSignedUrl(local, { method: 'PUT', bucket, key, expiresIn, readinessClaim }),
      token: null,
      expires_in: expiresIn
    };
  }
  const config = storageConfig();
  if (!config.supabaseUrl || !config.key || !bucket || !key) {
    const error = new Error('Evidence object storage is not configured with a service-role key.');
    error.statusCode = 503;
    error.code = 'EVIDENCE_STORAGE_SERVICE_KEY_REQUIRED';
    throw error;
  }
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/upload/sign/${encodeURIComponent(bucket)}/${encodeStoragePath(key)}`,
    {
      ...(signal ? { signal } : {}),
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn })
    }
  );
  const body = await response.json().catch(() => ({}));
  signal?.throwIfAborted();
  if (!response.ok) {
    const error = new Error(body?.message || `Evidence signed upload URL failed with ${response.status}.`);
    error.statusCode = response.status;
    error.code = 'EVIDENCE_STORAGE_UPLOAD_SIGN_FAILED';
    error.details = { body, credential_mode: config.credentialMode };
    throw error;
  }
  const signedPath = body.url || body.signedURL || body.signedUrl || '';
  const signed_url = signedPath.startsWith('http')
    ? signedPath
    : `${config.supabaseUrl}/storage/v1${signedPath.startsWith('/') ? signedPath : `/${signedPath}`}`;
  return {
    provider: 'supabase_storage',
    bucket,
    key,
    signed_url,
    token: body.token || null,
    expires_in: expiresIn
  };
};
