// Venture intake → the intake document becomes the client's FIRST
// pipeline document. The same file the strong model read to draft the
// profile carries real bookkeeping evidence (a bank statement carries
// the whole feed), so after Create the file goes through the standard
// upload path — storage PUT + /documents/register — and the existing
// UploadTray surfaces parse progress. Onboarding ends with
// reconciliation already started, not with an empty workspace asking
// for the document it was just shown.
//
// Failures here are NEVER fatal to entity creation: the client row
// already exists, the tray row carries the error state, and the
// tray's mount-time orphan retry re-issues /register when the storage
// PUT succeeded but registration didn't.

import { buildDocumentRecord, classifyDocumentFile } from './firmDocuments.js';
import {
  setRowRegistered,
  setRowRegisterFailed,
  setRowUploaded,
  setRowUploadFailed,
  startTrayBatch
} from './uploadTray.js';

// Mirror of /documents/upload-url's mime allowlist (server/donna/api.js).
const PIPELINE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/csv'
]);

const EXTENSION_MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  // Windows/Excel declares .csv as application/vnd.ms-excel (not
  // allowlisted, on purpose — a true .xls must stay out), so a CSV
  // normalizes here via the extension fallback, matching the server
  // gate's normalization (design-donna-csv-statement-intake.md §3).
  csv: 'text/csv'
};

// Bytes over metadata: a base64 PDF starts with 'JVBERi' ('%PDF').
// Dropzone files can arrive with an empty or octet-stream mime, and a
// PDF sent under an image mime fails the upload-url allowlist — sniff
// the bytes first, then trust a declared allowlisted mime, then fall
// back to the extension. Returns null when the file can't go through
// the pipeline at all (pasted-text intake sources have no storage path).
export const resolvePipelineMimeType = ({ base64 = '', mimeType = '', filename = '' } = {}) => {
  if (String(base64).startsWith('JVBERi')) return 'application/pdf';
  const declared = String(mimeType || '').toLowerCase();
  if (PIPELINE_MIME_TYPES.has(declared)) return declared;
  const extension = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return EXTENSION_MIME[extension] || null;
};

const AR_AP_TYPES = new Set(['sales_invoice', 'supplier_bill', 'receipt', 'issued_receipt']);

// document_type for the register call. The strong model READ the
// document at intake — its document_kind outranks the filename regex
// for the unambiguous kinds. invoice_or_bill carries no direction, so
// the filename classifier breaks the AR/AP tie and supplier_bill is
// the default (the unified extractor holds type authority downstream
// and flips a wrong direction on parse). Everything else falls back to
// the same filename classification a normal upload gets; 'unknown'
// stays honest — the generic extractor reads it.
export const pipelineDocumentTypeForIntake = ({ documentKind, filename } = {}) => {
  const fromFilename = classifyDocumentFile({ filename: filename || '' }) || 'unknown';
  if (documentKind === 'bank_statement') return 'bank_statement';
  if (documentKind === 'registry_extract') return 'statutory_record';
  if (documentKind === 'contract') return 'contract';
  if (documentKind === 'utility_bill') return 'supplier_bill';
  if (documentKind === 'invoice_or_bill') {
    return AR_AP_TYPES.has(fromFilename) ? fromFilename : 'supplier_bill';
  }
  return fromFilename;
};

const approximateByteSize = (base64 = '') => {
  const raw = String(base64);
  if (!raw.length) return 0;
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - padding);
};

const mintBatchId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Upload the intake document for the freshly created client and
// register it for async parsing. Resolves with `{ routed, reason }` —
// callers fire-and-forget; the tray row is the user-facing surface
// for both progress and failure.
export const routeIntakeDocumentToPipeline = async (
  { clientId, filename, base64, mimeType, documentKind } = {},
  deps = {}
) => {
  const {
    tray = { startTrayBatch, setRowUploaded, setRowUploadFailed, setRowRegistered, setRowRegisterFailed }
  } = deps;

  if (!clientId || !base64) return { routed: false, reason: 'missing_input' };
  const resolvedMime = resolvePipelineMimeType({ base64, mimeType, filename });
  if (!resolvedMime) return { routed: false, reason: 'unsupported_file_type' };

  // The network deps load lazily: firmApi pulls supabaseAuth, which
  // reads import.meta.env and only exists under vite. Tests inject
  // both; the lazy path is the browser default.
  let { upload, register } = deps;
  if (!upload || !register) {
    const [storageModule, apiModule] = await Promise.all([
      import('./evidenceStorage.js'),
      import('./firmApi.js')
    ]);
    upload = upload || storageModule.uploadEvidenceObject;
    register = register || apiModule.registerFirmDocuments;
  }

  const documentType = pipelineDocumentTypeForIntake({ documentKind, filename });
  const size = approximateByteSize(base64);
  const record = buildDocumentRecord({ name: filename, type: resolvedMime, size }, clientId, {
    uploadedAt: Date.now()
  });

  const batchId = mintBatchId();
  const batchState = tray.startTrayBatch({
    batchId,
    clientId,
    files: [{ filename, size, document_type: documentType }]
  });
  const rowId =
    batchState?.batches?.find((batch) => batch.id === batchId)?.rows?.[0]?.row_id || `${batchId}-0`;

  let stored;
  try {
    stored = await upload({ clientId, filename, base64, mimeType: resolvedMime });
  } catch (err) {
    tray.setRowUploadFailed({ rowId, message: err?.message || 'Upload failed.' });
    return { routed: false, reason: 'upload_failed', error: err };
  }
  tray.setRowUploaded({
    rowId,
    storageBucket: stored.bucket,
    storageObjectKey: stored.key,
    checksum: stored.checksum_sha256
  });

  const documentPayload = {
    id: record.id,
    client_id: clientId,
    filename: record.filename,
    document_type: documentType,
    uploaded_at: record.uploaded_at,
    source: 'firm_intake',
    storage_bucket: stored.bucket,
    storage_object_key: stored.key,
    checksum_sha256: stored.checksum_sha256,
    file_storage: {
      mode: 'object_storage',
      provider: stored.provider,
      bucket: stored.bucket,
      key: stored.key,
      checksum_sha256: stored.checksum_sha256,
      filename: record.filename,
      mime_type: stored.content_type || resolvedMime,
      size: stored.size ?? size,
      note: 'Intake document — the file that drafted this client profile, routed into the document pipeline at creation.'
    },
    batch_id: batchId
  };

  try {
    const response = await register({ documents: [documentPayload] });
    const registered = response?.documents?.[0];
    if (!registered) {
      tray.setRowRegisterFailed({ rowId, message: 'Could not queue parse.' });
      return { routed: false, reason: 'register_failed' };
    }
    tray.setRowRegistered({ rowId, document: registered });
    return { routed: true, document: registered };
  } catch (err) {
    // Storage PUT succeeded; the tray's mount-time orphan retry
    // re-issues /register from the persisted storage key.
    tray.setRowRegisterFailed({ rowId, message: err?.message || 'Could not queue parse.' });
    return { routed: false, reason: 'register_failed', error: err };
  }
};
