// Firm-side document upload session — the portal's staged-batch upload
// (donna-client-portal.jsx: persistEvidenceFiles + buildEvidenceDocument)
// extracted for surfaces that have no evidence-question context: tray batch →
// per-file storage PUT (via the host-gated evidenceStorage, so the same call
// lands in Supabase on web and the local blob store on desktop) → one
// /documents/register call → tray rows stamped registered. The tray's own
// polling then carries parse progress and snapshot refresh.
//
// This module is the shared home for upload-session logic going forward.
// The portal still carries its original inline copy (it is the live client
// surface and adds evidence-request/reply context); converging it onto this
// module is recorded follow-up, not done here.

import {
  buildDocumentRecord,
  classifyDocumentFile,
  DOCUMENT_TYPE_LABELS,
  formatDocumentSize
} from './firmDocuments.js';
import { uploadEvidenceObject } from './evidenceStorage.js';
import { registerFirmDocuments } from './firmApi.js';
import { mapWithConcurrency, UPLOAD_CONCURRENCY } from './uploadConcurrency.js';
import { recordUploadFailure, releaseRetainedUpload, retainUpload } from './retainedUploads.js';
import {
  setRowRegistered,
  setRowRegisterFailed,
  setRowUploaded,
  setRowUploadFailed,
  startTrayBatch
} from './uploadTray.js';

// Same caps as the portal (MAX_EVIDENCE_FILE_BYTES / MAX_EVIDENCE_UPLOAD_BYTES).
export const MAX_UPLOAD_FILE_BYTES = 6 * 1024 * 1024;
export const MAX_UPLOAD_BATCH_BYTES = 7 * 1024 * 1024;

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });

const makeBatchId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Stores one file's bytes and stamps its tray row uploaded. Throws on a
// storage or admission failure; the caller decides hold vs fail.
const storeFirmDocument = async ({ file, clientId, firmId, index, trayRowId }) => {
  const base = buildDocumentRecord(file, clientId, { index, uploadedAt: Date.now() });
  const filename = file.name || base.filename;
  const mimeType = file.type || base.mime_type || 'application/octet-stream';
  const stored = await uploadEvidenceObject({
    firmId,
    clientId,
    filename,
    base64: await fileToBase64(file),
    mimeType
  });
  if (trayRowId) {
    // Bytes are stored: the tray's register/parse path owns the row now.
    releaseRetainedUpload(trayRowId);
    setRowUploaded({
      rowId: trayRowId,
      storageBucket: stored.bucket,
      storageObjectKey: stored.key,
      checksum: stored.checksum_sha256,
      storedSize: stored.size,
      mimeType: stored.content_type
    });
  }
  return {
    ...base,
    document_label:
      DOCUMENT_TYPE_LABELS[base.document_type] || base.document_label || DOCUMENT_TYPE_LABELS.unknown,
    status: 'needs_review',
    source: 'firm_upload',
    evidence_request_id: null,
    transaction_id: null,
    client_reply: '',
    evidence_context: null,
    file_url: null,
    file_storage: {
      mode: 'object_storage',
      provider: stored.provider,
      bucket: stored.bucket,
      key: stored.key,
      checksum_sha256: stored.checksum_sha256,
      filename,
      mime_type: stored.content_type,
      size: stored.size,
      note: 'Firm-uploaded document; only metadata and checksum recorded on the row.'
    },
    storage_provider: stored.provider,
    storage_bucket: stored.bucket,
    storage_object_key: stored.key,
    storage_key: stored.key,
    checksum_sha256: stored.checksum_sha256,
    file_size: stored.size,
    mime_type: stored.content_type,
    __trayRowId: trayRowId
  };
};

// One /documents/register call for stored documents; stamps each tray row.
// A register failure leaves rows register-failed for the tray's own retry.
const registerStoredDocuments = async ({ firmId, documents, batchId }) => {
  if (!documents.length) return [];
  let registeredDocs = [];
  try {
    const response = await registerFirmDocuments({
      firmId,
      documents: documents.map((doc) => ({
        id: doc.id,
        client_id: doc.client_id,
        filename: doc.filename,
        document_type: doc.document_type,
        uploaded_at: doc.uploaded_at,
        source: doc.source,
        storage_bucket: doc.storage_bucket,
        storage_object_key: doc.storage_object_key,
        checksum_sha256: doc.checksum_sha256,
        evidence_request_id: doc.evidence_request_id,
        transaction_id: doc.transaction_id,
        client_reply: doc.client_reply,
        evidence_context: doc.evidence_context,
        file_storage: doc.file_storage,
        batch_id: batchId
      }))
    });
    registeredDocs = response?.documents || [];
  } catch (error) {
    // Storage PUTs succeeded; register failed. Mark every row so the tray's
    // pre-register retry path picks them up — same recovery as the portal.
    documents.forEach((doc) => {
      if (doc.__trayRowId) {
        setRowRegisterFailed({ rowId: doc.__trayRowId, message: error?.message || 'Could not queue parse.' });
      }
    });
    return [];
  }
  documents.forEach((doc, index) => {
    const registered = registeredDocs[index];
    if (doc.__trayRowId && registered) {
      setRowRegistered({ rowId: doc.__trayRowId, document: registered });
    } else if (doc.__trayRowId) {
      setRowRegisterFailed({ rowId: doc.__trayRowId, message: 'Could not queue parse.' });
    }
  });
  return registeredDocs;
};

// Uploads a set of File objects for a client and registers them for the
// async-parse pipeline. Throws on size-cap violations (nothing uploaded).
// Per-file outcomes never block siblings:
//   - stored → registered in one call (a register failure leaves the rows
//     register-failed for the tray's retry);
//   - refused at admission (entity readiness not ready) → HELD: the file stays
//     in this page's memory and re-sends on a bounded clock (retainedUploads.js);
//   - any other storage failure → failed, with Retry from memory while the
//     page lives.
// Returns { registered, failed, held } — failed and held are filenames.
// `firmId` is optional and forwarded to both server calls when the caller
// has it (RT-03); the server scopes to its live default firm otherwise.
export const uploadFirmDocuments = async ({ files = [], clientId, firmId } = {}) => {
  const list = Array.from(files || []).filter(Boolean);
  if (!clientId || !list.length) return { registered: [], failed: [], held: [] };

  const total = list.reduce((sum, file) => sum + Number(file?.size || 0), 0);
  if (total > MAX_UPLOAD_BATCH_BYTES) {
    throw new Error(
      `Upload is larger than ${formatDocumentSize(MAX_UPLOAD_BATCH_BYTES)}. Drop fewer files at a time.`
    );
  }
  const oversized = list.find((file) => Number(file?.size || 0) > MAX_UPLOAD_FILE_BYTES);
  if (oversized) {
    throw new Error(
      `${oversized.name || 'A file'} is larger than ${formatDocumentSize(MAX_UPLOAD_FILE_BYTES)}.`
    );
  }

  const batchId = makeBatchId();
  const batchState = startTrayBatch({
    batchId,
    clientId,
    // Seed each row with the FE classifier's type — same reasoning as the
    // portal: a null seed left orphan rows retrying as `unknown` after a
    // network blip (the pilot client's Airwallex case).
    files: list.map((file) => ({
      filename: file?.name || 'file',
      size: Number(file?.size || 0),
      document_type: classifyDocumentFile({ filename: file?.name || 'file', type: file?.type }) || null
    }))
  });
  const batchRows = batchState.batches?.find((batch) => batch.id === batchId)?.rows || [];

  // Every row is retained before its first attempt, so a refusal can hold it
  // and a failure can be retried without the owner re-selecting the file.
  list.forEach((file, index) => {
    const trayRowId = batchRows[index]?.row_id || null;
    retainUpload({
      rowId: trayRowId,
      resend: async () => {
        const document = await storeFirmDocument({ file, clientId, firmId, index, trayRowId });
        await registerStoredDocuments({ firmId, documents: [document], batchId });
      }
    });
  });

  // Bounded concurrency, not Promise.all: a whole-batch burst of PUTs is
  // what pushed the desktop runtime over on the 2026-08-31 40-file drop.
  const outcomes = await mapWithConcurrency(list, UPLOAD_CONCURRENCY, async (file, index) => {
    const trayRowId = batchRows[index]?.row_id || null;
    try {
      return { document: await storeFirmDocument({ file, clientId, firmId, index, trayRowId }) };
    } catch (error) {
      if (!trayRowId) return { outcome: 'failed' };
      return { outcome: recordUploadFailure({ rowId: trayRowId, error }) };
    }
  });

  const clean = outcomes.map((entry) => entry.document).filter(Boolean);
  const nameAt = (index) => list[index]?.name || 'file';
  const failed = outcomes.map((entry, index) => (!entry.document && entry.outcome !== 'held' ? nameAt(index) : null)).filter(Boolean);
  const held = outcomes.map((entry, index) => (entry.outcome === 'held' ? nameAt(index) : null)).filter(Boolean);
  const registered = await registerStoredDocuments({ firmId, documents: clean, batchId });
  return { registered, failed, held };
};
