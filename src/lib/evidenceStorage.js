import { createFirmDocumentUploadUrl } from './firmApi.js';

const bytesFromBase64 = (base64 = '') => {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const hexFromBuffer = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

export const uploadEvidenceObject = async ({
  firmId,
  clientId,
  evidenceRequestId,
  transactionId,
  filename,
  base64,
  mimeType = 'application/octet-stream'
} = {}) => {
  const bytes = bytesFromBase64(base64);
  if (!bytes.length) throw new Error('Uploaded evidence file is empty.');
  const checksum = hexFromBuffer(await crypto.subtle.digest('SHA-256', bytes));
  const signed = await createFirmDocumentUploadUrl({
    firmId,
    clientId,
    filename,
    mimeType,
    size: bytes.byteLength,
    evidenceRequestId,
    transactionId,
    checksumSha256: checksum
  });
  const response = await fetch(signed.signed_url, {
    method: 'PUT',
    headers: {
      'Content-Type': signed.content_type || mimeType,
      'x-upsert': 'false'
    },
    body: bytes
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Error bodies from the desktop proxy/runtime are JSON ({error, code});
    // the raw body rendered verbatim on tray rows during the 2026-08-31
    // runtime outage. Surface the human message, keep the raw text as the
    // fallback for non-JSON upstreams (Supabase storage errors are XML/text).
    let message = '';
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.error === 'string') message = parsed.error.trim();
    } catch { /* not JSON — use the raw body */ }
    throw new Error(message || body || `Evidence storage upload failed with ${response.status}.`);
  }
  return {
    provider: signed.provider || 'supabase_storage',
    bucket: signed.bucket,
    key: signed.key,
    checksum_sha256: checksum,
    size: bytes.byteLength,
    content_type: signed.content_type || mimeType
  };
};

