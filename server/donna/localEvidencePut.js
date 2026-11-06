// The local evidence PUT, as ONE function with two transports.
//
// A local signed evidence URL (`/api/donna/evidence-local?token=…`,
// evidenceStorage.js) is origin-relative by contract: the appliance runtime
// listens on a private Unix socket and the SPA reaches it through whichever
// Donna origin served the page. A NODE-SIDE caller inside the runtime —
// inbound owner media from Telegram / WhatsApp / SMS (channels/inboundCore.js)
// — has no such origin: `fetch()` cannot speak to a unix socket, and before
// 2026-09-04 it fetched `donna://app/...`, a scheme Node does not know either.
// So the PUT's substance lives here, transport-free — verify the token for
// PUT, run the readiness admission on the token's generation claim inside
// ONE pooled connection, store the bytes on that same connection — and both
// transports call it:
//
//   - the HTTP route `handleLocalEvidenceBlob` (api.js): read the raw body
//     first (never hold a connection across network time), then this;
//   - `localEvidenceFetch`, a fetch-shaped in-process transport a Node-side
//     caller uses in local mode instead of `globalThis.fetch`.
//
// The verdicts are the route's, byte for byte: 404 EVIDENCE_LOCAL_MODE_OFF,
// 403 EVIDENCE_LOCAL_TOKEN_INVALID, the admission's own status + code, 200
// with { Key, content_hash, byte_length }. One-connection contract
// (2026-08-31 deadlock): the store gets the held client, never the pool.

import { Buffer } from 'node:buffer';

import { withFirmDbClient } from './firmDb.js';
import { checkEntityReadinessAdmissionWithClient, EntityReadinessAdmissionError } from './runtimeReadinessAdmission.js';
import { LOCAL_EVIDENCE_PATH, storeLocalEvidenceBytes, verifyLocalEvidenceAccess } from './evidenceStorage.js';

export const putLocalEvidenceForToken = async ({ token = '', bytes, contentType = null } = {}) => {
  const { enabled, claim } = verifyLocalEvidenceAccess({ token, method: 'PUT' });
  if (!enabled) {
    return { statusCode: 404, payload: { error: 'Local evidence storage is not enabled on this host.', code: 'EVIDENCE_LOCAL_MODE_OFF' } };
  }
  if (!claim) {
    return { statusCode: 403, payload: { error: 'Invalid or expired evidence token.', code: 'EVIDENCE_LOCAL_TOKEN_INVALID' } };
  }
  try {
    const stored = claim.firmId
      ? await withFirmDbClient(async (client) => {
          await client.query('begin');
          try {
            const admission = await checkEntityReadinessAdmissionWithClient({
              client,
              firmId: claim.firmId,
              clientId: claim.clientId,
              boundary: 'local_blob_put',
              expectedDependencyDigest: claim.entityDependencyDigest,
              resourceType: 'evidence_blob',
              resourceId: claim.key
            });
            if (!admission.allowed) {
              await client.query('commit');
              throw new EntityReadinessAdmissionError(admission);
            }
            const result = await storeLocalEvidenceBytes({
              bucket: claim.bucket,
              key: claim.key,
              bytes,
              contentType,
              client
            });
            await client.query('commit');
            return result;
          } catch (error) {
            await client.query('rollback').catch(() => {});
            throw error;
          }
        })
      : await storeLocalEvidenceBytes({
          bucket: claim.bucket,
          key: claim.key,
          bytes,
          contentType
        });
    return {
      statusCode: 200,
      payload: {
        Key: `${claim.bucket}/${claim.key}`,
        content_hash: stored.content_hash,
        byte_length: stored.byte_length
      }
    };
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      payload: {
        error: error.message || 'Local evidence request failed.',
        code: error.code || 'EVIDENCE_LOCAL_FAILED'
      }
    };
  }
};

const headerValue = (headers = {}, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return null;
};

const bodyBytes = (body) => {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(String(body));
};

// fetch-shaped: (url, { method, headers, body }) → Response. Serves exactly
// one thing, PUT to the local evidence route; anything else is a programming
// error, thrown loudly rather than silently proxied somewhere.
export const localEvidenceFetch = async (url, { method = 'GET', headers = {}, body } = {}) => {
  const target = new URL(url, 'http://127.0.0.1');
  if (target.pathname !== LOCAL_EVIDENCE_PATH || String(method).toUpperCase() !== 'PUT') {
    throw Object.assign(
      new Error(`localEvidenceFetch serves only PUT ${LOCAL_EVIDENCE_PATH}, got ${method} ${target.pathname}`),
      { code: 'EVIDENCE_LOCAL_TRANSPORT_UNSUPPORTED' }
    );
  }
  const result = await putLocalEvidenceForToken({
    token: target.searchParams.get('token') || '',
    bytes: bodyBytes(body),
    contentType: headerValue(headers, 'content-type')
  });
  return new Response(JSON.stringify(result.payload), {
    status: result.statusCode,
    headers: { 'Content-Type': 'application/json' }
  });
};
