// Async document parsing — DB layer.
//
// PR 2 of docs/async-parsing-plan.md. Everything that mutates documents'
// `parse_*` columns or transactions on parse-completion lives here.
// Worker writes are always gated by `parse_run_id` so stale Inngest
// retries can never clobber a row that a newer run claimed.

import { validateCloudPilotRegistration, releaseCloudPilotRegistration, lockUploadClientInFirm } from './cloudEvidenceIntake.js';
import { requireClientInFirm } from './db/clients.js';
import { assertEvidenceUploadReference, fetchEvidenceObjectBytes } from './evidenceStorage.js';
import { assertExecutionBudgetActive } from './executionBudget.js';
import { decideJevMaterialException, exceptionOwnerAskAllowed, exceptionPendingLane } from './jevMaterialException.js';
import { Buffer } from 'node:buffer';
import { getExtractionContextInDb } from './extractionContextDb.js';
import crypto from 'node:crypto';

import {
  DEFAULT_FIRM_ID,
  queryFirmDb,
  withFirmDbClient,
  ensureLedgerAccountFromVerdict,
  // RT-10 (F-08 / F-05 tail / F-13): the ONE evidence-request writer every
  // owner-ask lane in this file mints through (dedup on an open ask per
  // document, deterministic ids, audit) — never a second ask writer.
  __createClientEvidenceRequestWithClient,
} from './firmDb.js';
// RT-16 — the ONE coding state: parse-time categorisation writes the
// transaction's coding_state (applied / proposed), never a queue label.
import { applyCodingTransition, codingStateFromReviewState } from './codingState.js';
import { settleConvergenceForRead } from './reconcileConvergenceState.js';
import { validateReceiptTotals } from './totalsValidation.js';
import { extractReceiptFromBase64 } from './receipt.js';
import { extractSupplierBillFromBase64 } from './supplierBill.js';
import { extractSalesInvoiceFromBase64 } from './salesInvoice.js';
import { resolveClientCodingPolicyWithClient } from './db/coding.js';
import { assertCodingPolicyReceipt, isCodingPolicyError } from './codingPolicy.js';
import { recordCodingPolicyFailure, recordCodingPolicyRecovery } from './codingPolicyRecovery.js';
import { onDocumentParseFailed, onDocumentParseCompleted, onReconciliationRunCompleted, onReconcileCompleteRequestAskDraft, runReconciliationTerminalDrain } from './loopsShadowProducers.js';
import { codeDocumentLinesByRule } from './documentCoding.js';
import { lineFingerprint } from './lineFingerprint.js';
import { rowToReviewItemPayload } from './reviewItem.js';
import { runReceiptReconciliationForDocument } from './receiptReconciliation.js';
import { autoExplainReceiptForDocument } from './receiptAutoExplain.js';
import { runSalesInvoiceReconciliationForDocument } from './salesInvoiceReconciliation.js';
import { autoExplainSalesInvoiceForDocument } from './salesInvoiceAutoExplain.js';
import { runBillReconciliationForDocument } from './billReconciliation.js';
import { autoExplainBillForDocument } from './billAutoExplain.js';
import { runPaymentAccountStatementReconciliationForDocument } from './paymentAccountStatementReconciliation.js';
import { runPaymentConfirmationReconciliationForDocument } from './paymentConfirmationReconciliation.js';
import { runPayoutReconciliationForDocument } from './payoutReconciliation.js';
import { writeObligationsForContractSql } from './contractObligations.js';
import { suggestAccountForVendor } from './vendorAccountSuggestion.js';
import { clientRuleMatchFor, canonicalMerchantPattern } from './transactionIntel.js';
import { lookupMerchants, deduplicateMerchants, isMerchantLookupEnabled } from './merchantLookup.js';
import { classifyDocumentFile } from '../../src/lib/firmDocuments.js';
import { classifyLane } from './lanePolicy.js';
import { recordLlmDecision, recordLouisVerdict } from './llmDecisions.js';
import { evaluatePipelineDecision } from './louisPipeline.js';
import { readClientConfigSnapshot, clientFlagActs, persistConfigSnapshot } from './clientConfig.js';
import {
  checkEntityReadinessAdmissionWithClient,
  evaluateEntityReadinessAdmissionWithClient,
  recordEntityReadinessBlockedWithClient,
  EntityReadinessAdmissionError
} from './runtimeReadinessAdmission.js';

const DOC_THIN_COLUMNS = `
  id, firm_id, client_id, document_type, storage_bucket, storage_object_key,
  checksum_sha256, parse_status, parse_stage, parse_progress_current,
  parse_progress_total, parse_summary, parse_error, parse_run_id,
  parse_attempts, parse_enqueued_at, parse_event_sent_at, parse_started_at,
  parse_heartbeat_at, parse_completed_at, duplicate_of, filename, batch_id,
  payload
`;

const PARSE_RATE_LIMIT_PER_HOUR = 200;

const toIso = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

const sha256Hex = (bytes) =>
  crypto.createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '')).digest('hex');

const audit = async (client, { firmId, clientId, action, documentId, metadata, actorId = null, actorType = 'system' }) => {
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $6, $7, $3, 'document', $4, $5::jsonb)`,
    [firmId, clientId || null, action, documentId, JSON.stringify(metadata || {}), actorType, actorId]
  );
};

// Durable receipt for a post-parse leg that failed on the INLINE drain
// path (the desktop / degraded-mode worker). The parse itself completed —
// `parse_status` is already `completed`, so the drain never re-picks the
// document and the failed leg is never retried. Without this row the
// failure's only trace is a console warn, and the convergence panel can
// only render "Stuck for a reason that was not recorded" (2026-08-19
// side-lab finding). Typed (leg + retry_safe) so caseHealth Q3 surfaces
// it as a first-class integration failure instead of an untyped writer
// gap. Standalone insert — the leg's own transaction already failed, so
// there is nothing to co-commit with; callers treat a failed insert as
// log-and-continue (the drain must keep draining).
export const recordPostParseLegFailureInDb = async ({
  firmId,
  clientId,
  documentId,
  parseRunId,
  leg,
  retrySafe = null,
  error
}) => {
  if (!firmId || !documentId || !leg) {
    throw new Error('recordPostParseLegFailureInDb requires firmId, documentId, leg');
  }
  await queryFirmDb(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'document.parse.leg_failed', 'document', $3, $4::jsonb)`,
    [
      firmId,
      clientId || null,
      documentId,
      JSON.stringify({
        leg,
        parse_run_id: parseRunId || null,
        retry_safe: retrySafe === true ? true : retrySafe === false ? false : null,
        // Bounded: operator diagnostics, not document content. Leg errors
        // are system/transport errors, but a provider error body can echo
        // document text — the cap keeps the receipt useful without turning
        // audit metadata into a content sink.
        error: error == null ? null : String(error).slice(0, 300)
      })
    ]
  );
};

// True if any transaction belonging to the canonical doc has moved past
// `needs_review` — i.e. the firm has already accepted / posted /
// reconciled at least one row from it. The duplicate resolver's
// `replace` action is blocked in that state (we'd have to reverse firm
// decisions to safely replace the doc). The check is also embedded in
// the period-overlap placeholder's `parse_summary.replace_blocked` so the
// FE can pre-disable the button — but the BE re-checks it inside
// `resolveDuplicateInDb` under FOR UPDATE locks, which is the
// authoritative source of truth. (Byte-identical re-uploads no longer
// reach the resolver at all — RT-10 collapses them at register time.)
const isExistingReplaceBlocked = async (client, firmId, existingDocumentId) => {
  if (!firmId || !existingDocumentId) return false;
  const result = await client.query(
    `select 1 from transactions
     where firm_id=$1 and document_id=$2 and status <> 'needs_review'
     limit 1`,
    [firmId, existingDocumentId]
  );
  return result.rows.length > 0;
};

const countReviewedTransactionsForDoc = async (client, firmId, documentId) => {
  if (!firmId || !documentId) return { accepted_count: 0, posted_count: 0 };
  const result = await client.query(
    `select
       count(*) filter (where status <> 'needs_review')::int as accepted_count,
       count(*) filter (where status = 'posted')::int as posted_count
     from transactions
     where firm_id=$1 and document_id=$2`,
    [firmId, documentId]
  );
  return {
    accepted_count: Number(result.rows[0]?.accepted_count || 0),
    posted_count: Number(result.rows[0]?.posted_count || 0)
  };
};

const rowToThinParseStatus = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  parse_status: row.parse_status || 'completed',
  parse_stage: row.parse_stage || null,
  parse_progress_current: row.parse_progress_current ?? null,
  parse_progress_total: row.parse_progress_total ?? null,
  parse_summary: row.parse_summary || null,
  parse_error: row.parse_error || null,
  parse_run_id: row.parse_run_id || null,
  parse_attempts: row.parse_attempts ?? 0,
  parse_enqueued_at: toIso(row.parse_enqueued_at),
  parse_event_sent_at: toIso(row.parse_event_sent_at),
  parse_started_at: toIso(row.parse_started_at),
  parse_heartbeat_at: toIso(row.parse_heartbeat_at),
  parse_completed_at: toIso(row.parse_completed_at),
  duplicate_of: row.duplicate_of || null,
  filename: row.filename || null,
  document_type: row.document_type || null,
  storage_bucket: row.storage_bucket || null,
  storage_object_key: row.storage_object_key || null,
  checksum_sha256: row.checksum_sha256 || null,
  batch_id: row.batch_id || null
});

// Server-side filename recovery. The FE classifier (`classifyDocumentFile`
// in src/lib/firmDocuments.js) is the primary classifier and runs on the
// normal upload path. This helper is the safety net for the paths that
// bypass (or null out) FE classification: the upload-tray pre-register
// retry on orphaned rows, direct API uploads, an evidence/portal upload
// whose type was dropped, and any future ingest endpoint that hands us a
// raw filename without a type. Without it, an upload that reaches the
// server as `unknown` → the worker dispatches to the generic-document
// extractor instead of the dedicated one.
//
// It now DELEGATES to the same `classifyDocumentFile` the FE uses, rather
// than carrying its own narrower copy. The earlier copy only recognized
// `bank_statement` patterns, so it rescued the Airwallex ASR case
// (`...-ASR_EUR_2023-11-10_2025-03-16.pdf` → bank_statement) but NOT
// US-style AP filenames like `25-06-10_Dadant_150.23.pdf` /
// `25-06-13_Chevron_28.60.pdf` — the FE's amount-in-filename heuristic
// types those `supplier_bill`, but the server safety net dropped them to
// `unknown` → generic extractor. Two classifiers meant the fix on the FE
// side silently failed to cover the bypass paths the server net exists
// for. One shared classifier removes that drift permanently (CLAUDE.md:
// don't keep a second copy that can lag the first).
//
// Recovery is gated upstream by `isRecoverableDocumentType` — this only
// ever runs when the caller passed null/unknown/generic_document, i.e.
// stated NO opinion, so applying the FE classifier here can never override
// an explicit caller type. `unknown` from the classifier maps back to
// `null` so a no-signal filename leaves the caller's value untouched
// (preserves the "no spurious recovery" contract for genuinely
// unrecognizable names).
export const inferDocumentTypeFromFilename = (filename) => {
  if (!filename) return null;
  const recovered = classifyDocumentFile({ filename });
  return recovered && recovered !== 'unknown' ? recovered : null;
};

// Returns true when `current` is the kind of upload-time `document_type`
// value the filename-recovery path should override. Anything else is
// treated as an explicit caller intent we respect.
const isRecoverableDocumentType = (current) =>
  !current || current === 'unknown' || current === 'generic_document';

// ── the canonical-upload fence (migration 164) ─────────────────────────
//
// One canonical document per (firm, client, bytes). These are the pieces
// every writer that can make a row canonical shares: the read of the live
// canonical (the unique index's own predicate), the recognition of a lost
// race on that index, the byte-match collapse's summary and receipt, and the
// supersede of a failed upload of the same bytes. /documents/register,
// /documents/retry-parse and /resolve-duplicate all settle a lost race the
// same way: the row that lost becomes a harmless receipt pointing at the
// canonical that won.

const readLiveCanonicalWithClient = async (client, { firmId, clientId, checksum, excludeId }) => {
  if (!checksum) return null;
  const result = await client.query(
    `select ${DOC_THIN_COLUMNS}, uploaded_at from documents
     where firm_id=$1 and client_id=$2 and checksum_sha256=$3
       and id <> $4
       and duplicate_of is null
       and parse_status not in ('duplicate_pending', 'failed')
     order by created_at asc
     limit 1`,
    [firmId, clientId, checksum, excludeId]
  );
  return result.rows[0] || null;
};

const isCanonicalChecksumViolation = (error) =>
  error?.code === '23505' && error?.constraint === 'documents_firm_client_checksum_idx';

// A concurrent registration of the same stored object committed its row
// after this one's Layer 1 read (migration 011's per-object unique index).
const isStorageObjectViolation = (error) =>
  error?.code === '23505' && error?.constraint === 'documents_storage_object_unique';

const buildByteMatchCollapseSummary = ({ existing, documentType, collapsedAt }) => ({
  reason: 'duplicate_auto_collapsed',
  duplicate_reason: 'byte_match',
  document_type: documentType,
  existing_document_id: existing.id,
  existing_filename: existing.filename || null,
  existing_parse_status: existing.parse_status || null,
  existing_uploaded_at: toIso(existing.uploaded_at),
  collapsed_at: collapsedAt
});

const auditByteMatchCollapse = (client, { firmId, clientId, documentId, existing, batchId, via = null }) =>
  audit(client, {
    firmId,
    clientId,
    documentId,
    action: 'document.duplicate.auto_collapsed',
    metadata: {
      parse_run_id: null,
      duplicate_of: existing.id,
      reason: 'byte_match',
      canonical_parse_status: existing.parse_status || null,
      batch_id: batchId,
      ...(via ? { via } : {})
    }
  });

// RT-10: an unsuperseded FAILED upload of these bytes is retained as a
// receipt pointing at the canonical that now carries its retry. Receipted per
// row. Callers hold the canonical; the failed rows are locked by the update.
const supersedeFailedUploadsWithClient = async (client, { firmId, clientId, checksum, canonicalId, parseRunId = null }) => {
  if (!checksum || !canonicalId) return [];
  const superseded = await client.query(
    `update documents
        set duplicate_of=$4, updated_at=now()
      where firm_id=$1 and client_id=$2 and checksum_sha256=$3
        and id <> $4 and duplicate_of is null and parse_status='failed'
      returning id`,
    [firmId, clientId, checksum, canonicalId]
  );
  for (const row of superseded.rows) {
    await audit(client, {
      firmId,
      clientId,
      documentId: row.id,
      action: 'document.duplicate.failed_upload_superseded',
      metadata: {
        superseded_by: canonicalId,
        parse_run_id: parseRunId,
        reason: 'byte_match'
      }
    });
  }
  return superseded.rows.map((row) => row.id);
};

// ── /documents/register ────────────────────────────────────────────────

// Idempotent insert with two layers (see plan §"/documents/register"):
//   1. storage_object_key match → API-replay, return existing row.
//   2. checksum_sha256 match → byte-match duplicate: the row is inserted
//      TERMINAL (parse_status 'skipped', reason 'duplicate_auto_collapsed',
//      duplicate_of = the canonical, no parse run) with a
//      `document.duplicate.auto_collapsed` receipt (RT-10, audit F-13). No
//      tray state, no resolver click — the canonical already is the doc.
//   3. No match → fresh insert with parse_status='pending', new run_id,
//      parse_enqueued_at=now(). Caller is then responsible for firing
//      the Inngest event and stamping parse_event_sent_at on success.
//      A failed send leaves the row visible to the outbox sweeper.
export const registerDocumentInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  document = {},
  rateLimitPerHour = PARSE_RATE_LIMIT_PER_HOUR,
  uploadPrincipal = null,
  evidenceOnly = false,
  authorize = null,
  // 'mobile' when the phone adapter registered it (the route reads
  // req.donnaChannel only): attribution on the registration's audit row.
  channel = null
} = {}) => {
  // Match the default-fallback pattern used by every other helper in
  // firmDb.js (syncDocumentsAndTransactionsInDb, updateDocumentInDb,
  // etc.). The api handler reads `body?.firm_id` which is undefined
  // for portal callers; auth resolves against DEFAULT_FIRM_ID via
  // assertFirmAccess, but the resolved value isn't propagated back
  // to the handler. Defaulting here keeps the auth check and the
  // write op consistent — both operate against the same firm.
  if (!firmId) throw Object.assign(new Error('firm_id is required.'), { statusCode: 400 });
  if (!document.id) throw Object.assign(new Error('document.id is required.'), { statusCode: 400, code: 'DOCUMENT_ID_REQUIRED' });
  if (!document.client_id) throw Object.assign(new Error('document.client_id is required.'), { statusCode: 400, code: 'CLIENT_ID_REQUIRED' });

  // Filename-recovery safety net. If the caller passed no explicit
  // document_type (or one of the "wasn't classified" sentinels), try to
  // infer it from the filename. This catches the upload paths that
  // bypass the FE classifier — pre-register retry on an orphaned tray
  // row, the client portal's batch-uploader before its own classifier
  // patch landed, and any future API direct upload. The recovered type
  // is woven into both the duplicate check below AND the inserted
  // payload, so the worker sees the right type and dispatches to the
  // right extractor (rather than falling through to generic_document).
  if (!evidenceOnly && isRecoverableDocumentType(document.document_type)) {
    const recovered = inferDocumentTypeFromFilename(document.filename);
    if (recovered) {
      document = { ...document, document_type: recovered };
    }
  }
  if (!document.storage_bucket || !document.storage_object_key) {
    throw Object.assign(
      new Error('document.storage_bucket and document.storage_object_key are required.'),
      { statusCode: 400, code: 'STORAGE_REFERENCE_REQUIRED' }
    );
  }

  // Supporting physical photos share custody/intake but never become invoice parse jobs.
  // This is a server-only option, not copied from a submitted document payload.
  if (evidenceOnly) {
    if (document.evidence_purpose !== 'physical_inventory_count' || !uploadPrincipal?.principalId || typeof authorize !== 'function') {
      throw Object.assign(new Error('Physical evidence requires an authenticated scoped writer.'), { statusCode: 403, code: 'PHYSICAL_EVIDENCE_AUTHORITY' });
    }
    assertEvidenceUploadReference({ firmId, document, generic: false });
    const bytes = await fetchEvidenceObjectBytes({ bucket: document.storage_bucket, key: document.storage_object_key,
      maxBytes: 10 * 1024 * 1024, freshRead: true, signal: AbortSignal.timeout(10000) });
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : null;
    if (!mime || mime !== document.mime_type || bytes.length !== document.file_size || sha256Hex(bytes) !== document.checksum_sha256) {
      throw Object.assign(new Error('The stored photo does not match its size, type or checksum.'), { statusCode: 400, code: 'PHYSICAL_EVIDENCE_BYTES_MISMATCH' });
    }
  }

  // batch_id groups N files from a single upload session. The tray
  // mints it in the FE (src/lib/uploadTray.js → startTrayBatch); we
  // accept either snake_case or camelCase, and we accept null for
  // legacy callers (e.g. firm-side direct uploads outside the tray).
  const batchId = (() => {
    const raw = document.batch_id ?? document.batchId ?? null;
    if (raw == null) return null;
    const trimmed = String(raw).trim();
    return trimmed.length ? trimmed.slice(0, 128) : null;
  })();

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId: document.client_id });
      if (evidenceOnly) await authorize(client);
      const reference = assertEvidenceUploadReference({ firmId, document, generic: false });
      // Omitted legacy metadata cannot choose a different admission/parse lane
      // from the storage host that will actually read these bytes.
      if (document.storage_provider == null) document = { ...document, storage_provider: reference.provider };
      const intake = await validateCloudPilotRegistration({ client,firmId,document,principal:uploadPrincipal });
      if (!intake) assertEvidenceUploadReference({ firmId, document });
      const storageProvider = document.storage_provider
        || document.file_storage?.provider
        || document.payload?.storage_provider
        || null;
      if (storageProvider === 'local_blob') {
        const admission = await checkEntityReadinessAdmissionWithClient({
          client,
          firmId,
          clientId: document.client_id,
          boundary: 'document_register',
          resourceType: 'document',
          resourceId: document.id
        });
        if (!admission.allowed) {
          await client.query('commit');
          throw new EntityReadinessAdmissionError(admission);
        }
      }

      // Re-read ownership under a compatible lock after admission/remote reads,
      // including replays: caller ids and independent FKs do not prove scope.
      await lockUploadClientInFirm({ client, firmId, clientId: document.client_id });

      // Layer 1: storage_object_key idempotency. An API replay must
      // return the exact same row, not a phantom duplicate. The unique
      // index in 011 enforces this; the lookup is just so we can return
      // the row without thrashing the unique constraint.
      const existingByKey = await client.query(
        `select ${DOC_THIN_COLUMNS} from documents
         where firm_id=$1 and client_id=$2 and storage_object_key=$3`,
        [firmId, document.client_id, document.storage_object_key]
      );
      if (intake?.replay && existingByKey.rows[0]?.id !== intake.canonical_id) throw Object.assign(new Error('The original upload changed. Refresh its status.'), {code:'PILOT_UPLOAD_REPLAY_CHANGED',statusCode:409});
      if (existingByKey.rows.length) {
        await client.query('commit');
        return {
          document: rowToThinParseStatus(existingByKey.rows[0]),
          created: false,
          already_exists: true,
          duplicate_reason: 'storage_object_key_match',
          parse_run_id: existingByKey.rows[0].parse_run_id || null
        };
      }
      // A lost race on the stored object settles as the Layer 1 replay of the
      // row that won: its document and parse run, no receipt of this request's
      // own. Callers roll back to their savepoint first; null if no row is there.
      const replayStoredObjectWinner = async () => {
        const winner = await client.query(
          `select ${DOC_THIN_COLUMNS} from documents
           where firm_id=$1 and client_id=$2 and storage_object_key=$3`,
          [firmId, document.client_id, document.storage_object_key]
        );
        if (!winner.rows.length) return null;
        await client.query('commit');
        return {
          document: rowToThinParseStatus(winner.rows[0]),
          created: false,
          already_exists: true,
          duplicate_reason: 'storage_object_key_match',
          parse_run_id: winner.rows[0].parse_run_id || null
        };
      };

      // Layer 2: byte-hash duplicate — AUTO-COLLAPSED (RT-10, audit F-13).
      //
      // A checksum match against a canonical upload is not a decision the
      // owner or the firm needs to make: the bytes are the same bytes, so
      // the earlier row IS this document. The previous build parked the
      // re-upload as a `duplicate_pending` placeholder behind the 3-way
      // Create / Replace / Cancel resolver — a firm-side tray state with
      // no lane, the two-terminal violation F-08 names. The row is still
      // INSERTED (an upload must never be unfindable), but it lands
      // TERMINAL: parse_status 'skipped', `parse_summary.reason
      // 'duplicate_auto_collapsed'`, `duplicate_of` = the canonical, no
      // parse run, no event, one `document.duplicate.auto_collapsed`
      // receipt. The 3-way resolver survives ONLY for period-overlap
      // statements (markParseDuplicatePendingInDb) — and that decision is
      // routed to the owner as an ask, never a firm tray state.
      //
      // Which rows count as the canonical: any non-duplicate row with the
      // same bytes that is not itself a `duplicate_pending` placeholder
      // (never chain placeholder → placeholder) and did not FAIL. A failed
      // same-bytes row is exactly what a human re-uploads to retry, so it
      // is not a canonical: the fresh insert below parses normally and the
      // failed row is marked superseded by it (receipted). An in-flight
      // (pending/processing), completed or skipped canonical collapses the
      // re-upload — re-parsing identical bytes changes nothing.
      //
      // The pre-RT-05 `recoveredIsConfident` exclusion (a filename-recovered
      // bank_statement skipping an `unknown` canonical) is gone: the router
      // now fixes types (RT-05, decision D6), so a misclassified canonical is
      // re-typed by the parse, not by re-uploading the same bytes.
      //
      // The read alone cannot hold under concurrency, so migration 164 makes
      // `documents_firm_client_checksum_idx` unique over exactly this notion of
      // a canonical row; the fresh insert below turns a lost race on it into
      // this same collapse (collapseOnto).
      const readCanonical = () => readLiveCanonicalWithClient(client, {
        firmId, clientId: document.client_id, checksum: document.checksum_sha256, excludeId: document.id
      });
      const collapseOnto = async (existing) => {
        const documentType = document.document_type || 'unknown';
        const filename = document.filename || document.document_label || document.id;
        const collapsedAt = new Date().toISOString();
        const duplicateSummary = buildByteMatchCollapseSummary({ existing, documentType, collapsedAt });
        const payload = { ...document, parse_run_id: null };
        // A concurrent registration of the same stored object may have
        // committed its own collapsed row since the Layer 1 read.
        await client.query('savepoint register_collapse_insert');
        const collapsed = await client.query(
          `insert into documents (
             id, firm_id, client_id, filename, document_type, status, uploaded_at,
             source, file_url, vendor_name, customer_name, document_date, due_date,
             total_amount, currency, tax_amount, reference_number, payment_status, extraction_confidence,
             storage_bucket, storage_object_key, checksum_sha256,
             parse_status, parse_run_id, parse_attempts, parse_enqueued_at, parse_event_sent_at,
             parse_completed_at, duplicate_of, batch_id, parse_summary, payload
           )
           values (
             $1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()),
             $8, null, $9, $10, $11::date, $12::date,
             $13, $14, $15, $16, coalesce($17, 'unknown'), $18,
             $19, $20, $21,
             'skipped', null, 0, null, null,
             now(), $22, $23, $24::jsonb, $25::jsonb
           )
           on conflict (id) do nothing
           returning ${DOC_THIN_COLUMNS}`,
          [
            document.id,
            firmId,
            document.client_id,
            filename,
            documentType,
            document.status || 'received',
            document.uploaded_at ? new Date(Number(document.uploaded_at)).toISOString() : null,
            document.source || 'client_upload',
            document.vendor_name || null,
            document.customer_name || null,
            document.document_date || null,
            document.due_date || null,
            document.total_amount ?? null,
            document.currency || null,
            document.tax_amount ?? null,
            document.reference_number || null,
            document.payment_status || null,
            document.extraction_confidence ?? null,
            document.storage_bucket,
            document.storage_object_key,
            document.checksum_sha256 || null,
            existing.id,
            batchId,
            JSON.stringify(duplicateSummary),
            JSON.stringify(payload)
          ]
        ).catch((error) => error);
        if (collapsed instanceof Error) {
          if (!isStorageObjectViolation(collapsed)) throw collapsed;
          await client.query('rollback to savepoint register_collapse_insert');
          const replay = await replayStoredObjectWinner();
          if (replay) return replay;
          throw collapsed;
        }
        if (!collapsed.rows.length) {
          // id collision (concurrent register for the same doc id).
          // Re-read and return whatever is there.
          const fallback = await client.query(
            `select ${DOC_THIN_COLUMNS} from documents where firm_id=$1 and id=$2 and client_id=$3`,
            [firmId, document.id, document.client_id]
          );
          if (!fallback.rows.length) throw Object.assign(new Error('Document not found.'), { statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
          await client.query('commit');
          return {
            document: rowToThinParseStatus(fallback.rows[0] || {}),
            created: false,
            already_exists: true,
            duplicate_reason: 'id_conflict',
            parse_run_id: fallback.rows[0]?.parse_run_id || null
          };
        }
        await releaseCloudPilotRegistration({client,firmId,document,intake});
        await auditByteMatchCollapse(client, {
          firmId, clientId: document.client_id, documentId: document.id, existing, batchId
        });
        await client.query('commit');
        return {
          document: rowToThinParseStatus(collapsed.rows[0]),
          created: true,
          already_exists: false,
          duplicate_reason: 'byte_match',
          duplicate_of: existing.id,
          auto_collapsed: true,
          parse_run_id: null
        };
      };
      const canonical = await readCanonical();
      if (canonical) return collapseOnto(canonical);

      // Per-client rate limit (parse_enqueued_at within rolling hour).
      // File-size cap is already enforced upstream in /upload-url.
      const rateResult = await client.query(
        `select count(*)::int as count from documents
         where firm_id=$1 and client_id=$2
           and parse_enqueued_at > now() - interval '1 hour'`,
        [firmId, document.client_id]
      );
      const currentCount = Number(rateResult.rows[0]?.count || 0);
      if (!evidenceOnly && currentCount >= rateLimitPerHour) {
        const error = new Error('Too many parse jobs queued for this client in the last hour.');
        error.statusCode = 429;
        error.code = 'PARSE_RATE_LIMITED';
        error.details = { window: '1h', limit: rateLimitPerHour, count: currentCount };
        await client.query('rollback');
        throw error;
      }

      const parseRunId = evidenceOnly ? null : crypto.randomUUID();
      const documentType = document.document_type || 'unknown';
      const filename = document.filename || document.document_label || document.id;
      const payload = {
        ...document,
        parse_run_id: parseRunId
      };

      // Lock the failed same-bytes rows this insert will supersede BEFORE the
      // insert claims the unique index. A manual retry
      // (__retryParseRunsWithClient) locks the failed row first and then
      // claims the index, so taking these locks in the same order is what
      // keeps the two from deadlocking: whichever locks the failed row first
      // wins, and the other settles into the collapse / supersede below.
      if (document.checksum_sha256) {
        await client.query(
          `select id from documents
            where firm_id=$1 and client_id=$2 and checksum_sha256=$3
              and id <> $4 and duplicate_of is null and parse_status='failed'
            order by id
            for update`,
          [firmId, document.client_id, document.checksum_sha256, document.id]
        );
      }

      // A concurrent first upload of the same bytes (or a manual retry of a
      // failed upload of them) may have committed its canonical since the
      // Layer 2 read: the unique index refuses this insert, and the loser
      // becomes the ordinary byte-match collapse onto the winner. Any other
      // error is rethrown unchanged.
      await client.query('savepoint register_canonical_insert');
      let inserted;
      try {
        inserted = await client.query(
          `insert into documents (
             id, firm_id, client_id, filename, document_type, status, uploaded_at,
             source, file_url, vendor_name, customer_name, document_date, due_date,
             total_amount, currency, tax_amount, reference_number, payment_status, extraction_confidence,
             storage_bucket, storage_object_key, checksum_sha256,
             parse_status, parse_run_id, parse_attempts, parse_enqueued_at, parse_event_sent_at,
             batch_id, payload
           )
           values (
             $1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()),
             $8, null, $9, $10, $11::date, $12::date,
             $13, $14, $15, $16, coalesce($17, 'unknown'), $18,
             $19, $20, $21,
             case when $22::uuid is null then 'skipped' else 'pending' end, $22, 0,
             case when $22::uuid is null then null else now() end, null,
             $23, $24::jsonb
           )
           on conflict (id) do nothing
           returning ${DOC_THIN_COLUMNS}`,
          [
            document.id,
            firmId,
            document.client_id,
            filename,
            documentType,
            document.status || 'received',
            document.uploaded_at ? new Date(Number(document.uploaded_at)).toISOString() : null,
            document.source || 'client_upload',
            document.vendor_name || null,
            document.customer_name || null,
            document.document_date || null,
            document.due_date || null,
            document.total_amount ?? null,
            document.currency || null,
            document.tax_amount ?? null,
            document.reference_number || null,
            document.payment_status || null,
            document.extraction_confidence ?? null,
            document.storage_bucket,
            document.storage_object_key,
            document.checksum_sha256 || null,
            parseRunId,
            batchId,
            JSON.stringify(payload)
          ]
        );
      } catch (error) {
        if (!isCanonicalChecksumViolation(error) && !isStorageObjectViolation(error)) throw error;
        await client.query('rollback to savepoint register_canonical_insert');
        // Same stored object first: whichever of the two indexes reported the
        // lost race, a winner holding this object is this registration.
        const replay = await replayStoredObjectWinner();
        if (replay) return replay;
        if (!isCanonicalChecksumViolation(error)) throw error;
        const winner = await readCanonical();
        if (!winner) throw error;
        return collapseOnto(winner);
      }

      // The `on conflict (id) do nothing` falls through if a concurrent
      // request inserted the same id between Layer 1 and now. Re-read.
      if (!inserted.rows.length) {
        const fallback = await client.query(
          `select ${DOC_THIN_COLUMNS} from documents
           where firm_id=$1 and id=$2 and client_id=$3`,
          [firmId, document.id, document.client_id]
        );
        if (!fallback.rows.length) throw Object.assign(new Error('Document not found.'), { statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
        await client.query('commit');
        return {
          document: rowToThinParseStatus(fallback.rows[0] || {}),
          created: false,
          already_exists: true,
          duplicate_reason: 'id_conflict',
          parse_run_id: fallback.rows[0]?.parse_run_id || null
        };
      }

      await releaseCloudPilotRegistration({client,firmId,document,intake});
      await audit(client, {
        firmId,
        clientId: document.client_id,
        documentId: document.id,
        action: evidenceOnly ? 'document.physical_evidence.received' : 'document.parse.queued',
        actorId: evidenceOnly ? uploadPrincipal.principalId : null,
        actorType: evidenceOnly ? uploadPrincipal.principalType : 'system',
        metadata: {
          parse_run_id: parseRunId,
          actor_id: evidenceOnly ? uploadPrincipal.principalId : null,
          source_kind: evidenceOnly ? 'browser_photo_upload' : null,
          document_type: documentType,
          filename,
          batch_id: batchId,
          ...(channel === 'mobile' ? { channel } : {})
        }
      });

      // RT-10: a FAILED earlier upload of these same bytes is what this
      // fresh insert retries (Layer 2 deliberately does not treat it as
      // the canonical). Mark it superseded by the new canonical so it
      // stops reading as a live, retryable row of its own — the parse
      // that just queued is its retry. Receipted per row.
      if (document.checksum_sha256) {
        await supersedeFailedUploadsWithClient(client, {
          firmId,
          clientId: document.client_id,
          checksum: document.checksum_sha256,
          canonicalId: document.id,
          parseRunId
        });
      }

      await client.query('commit');
      return {
        document: rowToThinParseStatus(inserted.rows[0]),
        created: true,
        already_exists: false,
        duplicate_reason: null,
        parse_run_id: parseRunId
      };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {}
      throw error;
    }
  });
};

// Stamp `parse_event_sent_at` after a successful Inngest send. Outbox
// sweeper picks up rows where this is still NULL.
export const markParseEventSentInDb = async ({ firmId, documentId, parseRunId } = {}) => {
  if (!firmId || !documentId) return;
  await queryFirmDb(
    `update documents
     set parse_event_sent_at = now()
     where firm_id=$1 and id=$2
       and ($3::uuid is null or parse_run_id=$3::uuid)
       and parse_event_sent_at is null`,
    [firmId, documentId, parseRunId || null]
  );
};

// ── /documents/parse-status ────────────────────────────────────────────

// Thin projection that matches the plan's /parse-status contract
// (docs/async-parsing-plan.md → "GET /documents/parse-status"). We
// deliberately don't return `parse_run_id` — it's an internal
// correctness token gating worker writes and has no FE consumer.
// `client_id` survives because callers already know it (they scoped
// the request), and stripping it would force a join to map results
// back to documents for collaborator-allowed-client filtering.
// `parse_hold` (RT-02's row-level readiness receipt, RT-08 exposes it): a
// pending row refused at parse_claim carries payload.parse_hold; the tray
// renders "Waiting for readiness…" from it instead of "Queued".
const PARSE_STATUS_THIN_PROJECTION = `
  id, client_id, parse_status, parse_stage, parse_progress_current,
  parse_progress_total, parse_summary, parse_error, duplicate_of,
  parse_completed_at, payload->'parse_hold' as parse_hold
`;

export const getParseStatusForDocumentsInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientIds = null,
  documentIds = []
} = {}) => {
  if (!documentIds.length) return [];
  // Three caller-intent shapes (per assertFirmAccess contract):
  //   - clientIds === null      → firm member, no client filter.
  //   - clientIds === []        → collaborator with no assignments;
  //                               return empty rather than leak rows.
  //   - clientIds === ['…', …]  → collaborator with N assignments.
  if (Array.isArray(clientIds) && clientIds.length === 0) return [];
  const params = [firmId, documentIds];
  let scope = '';
  if (Array.isArray(clientIds) && clientIds.length) {
    params.push(clientIds);
    scope = ' and client_id = any($3::text[])';
  }
  const result = await queryFirmDb(
    `select ${PARSE_STATUS_THIN_PROJECTION}
     from documents
     where firm_id=$1 and id = any($2::text[])${scope}`,
    params
  );
  return result.rows.map((row) => ({
    id: row.id,
    client_id: row.client_id,
    parse_status: row.parse_status || 'completed',
    parse_stage: row.parse_stage || null,
    parse_progress_current: row.parse_progress_current ?? null,
    parse_progress_total: row.parse_progress_total ?? null,
    parse_summary: row.parse_summary || null,
    parse_error: row.parse_error || null,
    duplicate_of: row.duplicate_of || null,
    parse_completed_at: toIso(row.parse_completed_at),
    parse_hold: row.parse_hold && typeof row.parse_hold === 'object' ? row.parse_hold : null
  }));
};

// ── /documents/retry-parse ─────────────────────────────────────────────

// Retry is gated to terminal-but-recoverable states per plan
// §"/documents/retry-parse" (parse_status IN ('failed',
// 'duplicate_pending')). Replaying on a `completed` doc would
// silently re-OCR a finished parse and clobber its parse_summary;
// the worker's tx upsert guard (WHERE status='needs_review') keeps
// firm-reviewed transactions safe, but the document-level summary
// would still be lost. Replaying on a `pending` / `processing` row
// is also rejected — Inngest's own auto-retry handles in-flight
// failures, and a manual retry there would race the existing run.
export const RETRYABLE_PARSE_STATUSES = new Set(['failed', 'duplicate_pending']);

// Inner transactional logic. Exported so tests can drive it against
// an in-memory mock client without needing a Postgres pool. The
// public `retryParseRunsInDb` wraps this in `withFirmDbClient`.
// Historical balance refusals were incorrectly terminal-skipped. Reuse the
// retry writer only for that exact shape, never duplicates or imported books.
const LEGACY_STATEMENT_VALIDATION_RETRY = `parse_status = 'skipped'
  and parse_summary->>'reason' = 'no_transactions_detected'
  and parse_summary->>'extraction_status' = 'needs_review'
  and duplicate_of is null
  and not exists (select 1 from transactions t where t.document_id = documents.id
    and t.firm_id = documents.firm_id)`;

export const __retryParseRunsWithClient = async ({ client, firmId, documentIds = [] }) => {
  await client.query('begin');
  try {
    // Lock the rows before reading their state. A fresh upload of the same
    // bytes locks the failed rows it supersedes before it claims the
    // canonical index (registerDocumentInDb), so this lock is what orders a
    // retry against that upload instead of letting the two deadlock.
    const result = await client.query(
      `select id, client_id, parse_status, parse_run_id, duplicate_of, checksum_sha256,
              (${LEGACY_STATEMENT_VALIDATION_RETRY}) as legacy_validation_retry
       from documents
       where firm_id=$1 and id = any($2::text[])
       order by id
       for update`,
      [firmId, documentIds]
    );
    const rows = [];
    const skipped = [];
    for (const row of result.rows) {
      if (!RETRYABLE_PARSE_STATUSES.has(row.parse_status) && !row.legacy_validation_retry) {
        // Surface in the response so callers can render an inline
        // explanation rather than a silent no-op. The caller is
        // expected to filter the document list to retryable rows
        // before calling, but we double-check at the DB layer.
        skipped.push({
          id: row.id,
          client_id: row.client_id,
          parse_status: row.parse_status,
          reason: 'parse_status_not_retryable'
        });
        continue;
      }
      // A failed upload that a later upload of the same bytes superseded is a
      // retained receipt: the canonical it points at already carries its
      // retry. Re-queuing it would parse the same bytes twice.
      if (row.parse_status === 'failed' && row.duplicate_of) {
        skipped.push({
          id: row.id,
          client_id: row.client_id,
          parse_status: row.parse_status,
          reason: 'superseded_by_canonical',
          duplicate_of: row.duplicate_of
        });
        continue;
      }
      const parseRunId = crypto.randomUUID();
      const previousRunId = row.parse_run_id || null;
      // RT-08: a manual retry mints a NEW run, and each run owns its attempt
      // budget — on the appliance the local job carries the real one (four
      // attempts, decision D7) and `parse_attempts` is its row-side mirror.
      // Left un-reset, a re-tried exhausted row read as already spent to the
      // drain backstop and got exactly one attempt (RT-02 handoff §4.2).
      // Re-queuing an unsuperseded failed row makes it a canonical again
      // (migration 164). If another canonical of these bytes already holds
      // the index, the retry loses the race and the row is superseded by
      // that canonical, exactly as a fresh upload would have superseded it.
      await client.query('savepoint retry_parse_row');
      let update;
      try {
        update = await client.query(
          `update documents
           set parse_status='pending',
               parse_run_id=$3::uuid,
               parse_attempts=0,
               parse_stage=null,
               parse_progress_current=null,
               parse_progress_total=null,
               parse_error=null,
               parse_enqueued_at=now(),
               parse_event_sent_at=null,
               parse_started_at=null,
               parse_heartbeat_at=null,
               parse_completed_at=null,
               updated_at=now()
           where firm_id=$1 and id=$2
             and (parse_status = any($4::text[]) or (${LEGACY_STATEMENT_VALIDATION_RETRY}))
             and not (parse_status = 'failed' and duplicate_of is not null)
           returning ${DOC_THIN_COLUMNS}`,
          [firmId, row.id, parseRunId, Array.from(RETRYABLE_PARSE_STATUSES)]
        );
        await client.query('release savepoint retry_parse_row');
      } catch (error) {
        if (!isCanonicalChecksumViolation(error)) throw error;
        await client.query('rollback to savepoint retry_parse_row');
        const canonical = await readLiveCanonicalWithClient(client, {
          firmId, clientId: row.client_id, checksum: row.checksum_sha256, excludeId: row.id
        });
        const superseded = canonical
          ? await supersedeFailedUploadsWithClient(client, {
            firmId,
            clientId: row.client_id,
            checksum: row.checksum_sha256,
            canonicalId: canonical.id,
            parseRunId: canonical.parse_run_id || null
          })
          : [];
        if (!superseded.includes(row.id)) throw error;
        skipped.push({
          id: row.id,
          client_id: row.client_id,
          parse_status: row.parse_status,
          reason: 'superseded_by_canonical',
          duplicate_of: canonical.id
        });
        continue;
      }
      if (update.rows.length) {
        await audit(client, {
          firmId,
          clientId: update.rows[0].client_id,
          documentId: update.rows[0].id,
          action: 'document.parse.retry',
          metadata: {
            parse_run_id: parseRunId,
            previous_status: row.parse_status,
            previous_run_id: previousRunId
          }
        });
        rows.push({ ...rowToThinParseStatus(update.rows[0]), parse_run_id: parseRunId });
      } else {
        // The status flipped between SELECT and UPDATE (e.g. a
        // concurrent /retry-parse call already requeued the row).
        // Report as skipped rather than silently dropping it.
        skipped.push({
          id: row.id,
          client_id: row.client_id,
          parse_status: row.parse_status,
          reason: 'parse_status_changed_during_retry'
        });
      }
    }
    await client.query('commit');
    return { retried: rows, skipped };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  }
};

export const retryParseRunsInDb = async ({ firmId = DEFAULT_FIRM_ID, documentIds = [] } = {}) => {
  if (!documentIds.length) return { retried: [], skipped: [] };
  return withFirmDbClient((client) =>
    __retryParseRunsWithClient({ client, firmId, documentIds })
  );
};

// ── Worker: claim / stage / progress / heartbeat / mark ────────────────

// Atomic exclusive claim. `processing` is an OWNED lease, not a retryable
// queue state: accepting it here let an Inngest delivery and the desktop
// drain parse the same run concurrently. A retryable failure explicitly
// releases its own run back to `pending` below; stale processing rows remain
// the stuck-run sweeper's responsibility.
export const __claimParseRunWithClient = async ({ client, firmId, documentId, parseRunId } = {}) => {
  if (!firmId || !documentId || !parseRunId) return null;
  const result = await client.query(
    `update documents
     set parse_status='processing',
         parse_attempts=parse_attempts+1,
         parse_started_at=coalesce(parse_started_at, now()),
         parse_heartbeat_at=now(),
         parse_stage='fetching',
         parse_progress_current=null,
         parse_progress_total=null,
         parse_error=null,
         payload = payload - 'parse_hold',
         updated_at=now()
     where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
       and parse_status='pending'
     returning ${DOC_THIN_COLUMNS}`,
    [firmId, documentId, parseRunId]
  );
  return result.rows.length ? rowToThinParseStatus(result.rows[0]) : null;
};

// Typed claim outcomes (RT-02, audit F-07). A refused claim used to return
// the same `null` as a stale event, so the drain logged "benign skip" while
// the row sat pending with no visible reason and a fresh
// `runtime.readiness_admission_blocked` audit every minute.
//   claimed            — this run now owns the row (`claimed` is the thin row)
//   not_pending        — same run id, but the row is no longer pending
//                        (a terminal writer or a concurrent claim won)
//   stale_run          — a newer manual retry minted a different parse_run_id
//   admission_refused  — entity readiness refused parse_claim; `decision`
//                        carries the reason, `hold` what was persisted
export const PARSE_CLAIM_OUTCOMES = Object.freeze(['claimed', 'not_pending', 'admission_refused', 'stale_run']);

const readParseRunOwnershipOutcome = async (client, { firmId, documentId, parseRunId }) => {
  const result = await client.query(
    `select parse_status, parse_run_id from documents where firm_id=$1 and id=$2`,
    [firmId, documentId]
  );
  const row = result.rows?.[0] || null;
  if (!row) return 'not_pending';
  if (row.parse_run_id && String(row.parse_run_id) !== String(parseRunId)) return 'stale_run';
  return 'not_pending';
};

// documents.payload.parse_hold — the row-level receipt of an admission
// refusal, so the tray can say "Waiting for readiness" from the row and the
// drain can skip re-claiming (and re-auditing) a refused entity until the
// recheck window passes. Written for EVERY pending row of the entity in one
// statement (the refusal is an entity fact, not a row fact), so one blocked
// audit covers the entity instead of one per row per minute. `since` is the
// first refusal for this reason; `checked_at` is the latest re-check; the
// successful claim above strips the key.
const buildParseHold = ({ decision, receipt, existing, now }) => {
  const reasonCode = decision?.reason_code || 'entity_readiness_not_ready';
  const since = existing && existing.reason_code === reasonCode && existing.since ? existing.since : now;
  return {
    reason_code: reasonCode,
    responsible_system: decision?.responsible_system || null,
    boundary: 'parse_claim',
    since,
    checked_at: now,
    receipt_id: receipt?.id == null ? null : Number(receipt.id)
  };
};

const holdPendingParseRunsForEntity = async (client, { firmId, clientId, hold }) => {
  await client.query(
    `update documents
        set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('parse_hold', $3::jsonb),
            updated_at = now()
      where firm_id = $1 and client_id = $2
        and parse_status = 'pending' and parse_run_id is not null`,
    [firmId, clientId, JSON.stringify(hold)]
  );
};

export const __claimParseRunWithAdmissionWithClient = async ({
  client,
  firmId,
  documentId,
  parseRunId
} = {}) => {
  await client.query('begin');
  try {
    const pending = await client.query(
      `select client_id, payload
         from documents
        where firm_id = $1 and id = $2 and parse_run_id = $3::uuid
          and parse_status = 'pending'
        for update`,
      [firmId, documentId, parseRunId]
    );
    const row = pending.rows?.[0] || null;
    if (!row) {
      const outcome = await readParseRunOwnershipOutcome(client, { firmId, documentId, parseRunId });
      await client.query('commit');
      return { claimed: null, outcome, decision: null, hold: null };
    }
    const storageProvider = row.payload?.storage_provider
      || row.payload?.file_storage?.provider
      || null;
    let decision = null;
    if (storageProvider === 'local_blob') {
      decision = await evaluateEntityReadinessAdmissionWithClient({
        client,
        firmId,
        clientId: row.client_id,
        boundary: 'parse_claim',
        resourceType: 'document',
        resourceId: documentId
      });
      if (!decision.allowed) {
        const receipt = await recordEntityReadinessBlockedWithClient({
          client,
          firmId,
          clientId: row.client_id,
          boundary: 'parse_claim',
          decision,
          resourceType: 'document',
          resourceId: documentId
        });
        const hold = buildParseHold({
          decision,
          receipt,
          existing: row.payload?.parse_hold || null,
          now: new Date().toISOString()
        });
        await holdPendingParseRunsForEntity(client, { firmId, clientId: row.client_id, hold });
        await client.query('commit');
        return { claimed: null, outcome: 'admission_refused', decision, hold };
      }
    }
    const claimed = await __claimParseRunWithClient({ client, firmId, documentId, parseRunId });
    await client.query('commit');
    // `prior_hold`: the hold the claim just stripped. A provider wait that
    // recurs carries its `since` and wait count forward from it.
    const priorHold = row.payload?.parse_hold && typeof row.payload.parse_hold === 'object' ? row.payload.parse_hold : null;
    return claimed
      ? { claimed, outcome: 'claimed', decision, hold: null, prior_hold: priorHold }
      : { claimed: null, outcome: 'not_pending', decision, hold: null };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
};

// Returns the typed outcome `{ claimed, outcome, decision, hold }` — callers
// branch on `outcome`, never on nullness alone.
export const claimParseRunInDb = async (args = {}) =>
  withFirmDbClient((client) => __claimParseRunWithAdmissionWithClient({ client, ...args }));

// Retry hand-off for the SAME run id. The processing predicate makes this a
// compare-and-set release: a manual retry that already minted a new run, or a
// terminal writer that won the race, cannot be moved backwards to pending.
//
// `providerHold` (a provider wait — parseErrors.buildProviderWaitHold): the
// failure was the installation's (no key, provider unreachable), not the
// document's. The same release then writes the hold as the row's persisted
// reason (payload.parse_hold, the key the tray, the parse-status projection,
// the drain's recheck window and the convergence verdict already read) and
// hands back the attempt the claim counted, so a configuration wait never
// spends the document's automatic budget. The next claim strips the hold.
export const __releaseParseRunForRetryWithClient = async ({
  client,
  firmId,
  documentId,
  parseRunId,
  providerHold = null
} = {}) => {
  if (!firmId || !documentId || !parseRunId) return null;
  const hold = providerHold && typeof providerHold === 'object' ? JSON.stringify(providerHold) : null;
  const result = await client.query(
    `update documents
     set parse_status='pending',
         parse_stage=null,
         parse_progress_current=null,
         parse_progress_total=null,
         parse_heartbeat_at=now(),
         parse_attempts=case when $4::jsonb is null then parse_attempts else greatest(0, parse_attempts - 1) end,
         payload=case when $4::jsonb is null then payload
                      else coalesce(payload, '{}'::jsonb) || jsonb_build_object('parse_hold', $4::jsonb) end,
         updated_at=now()
     where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
       and parse_status='processing'
     returning ${DOC_THIN_COLUMNS}`,
    [firmId, documentId, parseRunId, hold]
  );
  if (!result.rows.length) return null;
  if (hold && (Number(providerHold.waits) || 0) <= 1) {
    // One audit per distinct wait (the first), never one per recheck.
    await audit(client, {
      firmId,
      clientId: result.rows[0].client_id,
      documentId,
      action: 'document.parse.provider_wait',
      metadata: {
        parse_run_id: parseRunId,
        reason_code: providerHold.reason_code,
        provider: providerHold.provider || null,
        key_name: providerHold.key_name || null,
        code: providerHold.code || null,
        reason: providerHold.reason || null
      }
    });
  }
  return rowToThinParseStatus(result.rows[0]);
};

// Crash recovery for the SAME run id (2026-09-12, FI reliability pass). A
// worker killed between the queue claim and the terminal write leaves the row
// `processing` with a dying heartbeat; the stuck sweep may already have rested
// it `failed`/STUCK on a manual click. Either way the desktop job that owned
// the run is recovered by the scheduler's lease sweep WITH automatic attempts
// left — so the run is reclaimed to `pending` for that job, receipted, and
// finishes on its own budget instead of waiting for a human retry that the
// budget was meant to make unnecessary. Compare-and-set on the exact run id
// and on the two abandoned shapes only: a live attempt (fresh heartbeat), a
// newer manual run, or any other terminal row cannot be moved. Returns the
// thin row when reclaimed, null otherwise.
export const __reclaimAbandonedParseRunWithClient = async ({
  client,
  firmId,
  documentId,
  parseRunId,
  staleAfterSeconds = 300,
  attempt = null
} = {}) => {
  if (!client || !firmId || !documentId || !parseRunId) return null;
  const result = await client.query(
    `update documents
     set parse_status='pending',
         parse_stage=null,
         parse_progress_current=null,
         parse_progress_total=null,
         parse_error=null,
         parse_heartbeat_at=now(),
         updated_at=now()
     where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
       and (
         (parse_status='processing' and parse_heartbeat_at < now() - ($4 || ' seconds')::interval)
         or (parse_status='failed' and parse_error->>'code'='STUCK')
       )
     returning ${DOC_THIN_COLUMNS}, (select parse_status from documents d2 where d2.id=documents.id) as previous_status`,
    [firmId, documentId, parseRunId, String(Math.max(60, Number(staleAfterSeconds) || 300))]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  await audit(client, {
    firmId,
    clientId: row.client_id,
    documentId: row.id,
    action: 'document.parse.reclaimed',
    metadata: {
      parse_run_id: parseRunId,
      previous_status: row.previous_status || null,
      source: 'local_job_lease_recovery',
      ...(attempt ? { attempts: Number(attempt.count) || 0, max_attempts: Number(attempt.max) || 0 } : {})
    }
  });
  return rowToThinParseStatus(row);
};

export const reclaimAbandonedParseRunInDb = async (args = {}) =>
  withFirmDbClient((client) => __reclaimAbandonedParseRunWithClient({ client, ...args }));

export const releaseParseRunForRetryInDb = async (args = {}) =>
  withFirmDbClient((client) => __releaseParseRunForRetryWithClient({ client, ...args }));

export const setParseStageInDb = async ({ firmId, documentId, parseRunId, stage } = {}) => {
  if (!firmId || !documentId || !parseRunId || !stage) return;
  await queryFirmDb(
    `update documents
     set parse_stage=$4,
         parse_heartbeat_at=now(),
         updated_at=now()
     where firm_id=$1 and id=$2 and parse_run_id=$3::uuid`,
    [firmId, documentId, parseRunId, stage]
  );
};

export const setParseProgressInDb = async ({ firmId, documentId, parseRunId, current, total } = {}) => {
  if (!firmId || !documentId || !parseRunId) return;
  const safeTotal = Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : null;
  const safeCurrent =
    safeTotal == null ? null : Math.min(Math.max(0, Number(current) || 0), safeTotal);
  await queryFirmDb(
    `update documents
     set parse_progress_current=$4,
         parse_progress_total=$5,
         parse_heartbeat_at=now(),
         updated_at=now()
     where firm_id=$1 and id=$2 and parse_run_id=$3::uuid`,
    [firmId, documentId, parseRunId, safeCurrent, safeTotal]
  );
};

// RT-12 (audit F-12) — the header the unified extractor DID return on a read
// it could not finish (below the confidence floor, self-reported failure, a
// schema the reply broke). Persisted on parse_summary.partial_header, gated
// by the run id, BEFORE the parse either falls through to a per-type
// extractor or rests failed — so a "vendor + total right, date unreadable"
// read is evidence on the row, not a replay from nothing. The terminal
// failure writer touches only parse_error, and the completed_header writer
// replaces parse_summary wholesale: this patch is the one place a partial
// read lands on a failed row.
export const persistPartialHeaderInDb = async ({ firmId, documentId, parseRunId, partial } = {}) => {
  if (!firmId || !documentId || !parseRunId || !partial || typeof partial !== 'object') return null;
  const value = { ...partial, parse_run_id: parseRunId };
  // `persisted_at` is the DATABASE clock (the RT-07 date discipline: no new
  // JS-side ISO formatting site).
  await queryFirmDb(
    `update documents
     set parse_summary = coalesce(parse_summary, '{}'::jsonb)
           || jsonb_build_object('partial_header', $4::jsonb || jsonb_build_object('persisted_at', to_jsonb(now()))),
         parse_heartbeat_at=now(),
         updated_at=now()
     where firm_id=$1 and id=$2 and parse_run_id=$3::uuid`,
    [firmId, documentId, parseRunId, JSON.stringify(value)]
  );
  return value;
};

export const touchParseHeartbeatInDb = async ({ firmId, documentId, parseRunId } = {}) => {
  if (!firmId || !documentId || !parseRunId) return;
  await queryFirmDb(
    `update documents
     set parse_heartbeat_at=now()
     where firm_id=$1 and id=$2 and parse_run_id=$3::uuid`,
    [firmId, documentId, parseRunId]
  );
};

// `payloadPatch` (optional) is merged into the documents `payload`
// jsonb at completion. The bank-statement worker passes the extracted
// statement header (statement_summary / period_label /
// statement_currency) so the payload-reading consumers — the
// ask-pipeline's statement-coverage gather, sourceImportCompleteness,
// transactionIntel — see the same keys the legacy /documents/sync
// writer used to provide. null leaves payload untouched.
export const markParseCompletedInDb = async ({ firmId, documentId, parseRunId, summary, accountFingerprint, payloadPatch, documentType = null } = {}) => {
  if (!firmId || !documentId || !parseRunId) return null;
  const cleanPayloadPatch =
    payloadPatch && typeof payloadPatch === 'object' && Object.keys(payloadPatch).length
      ? JSON.stringify(payloadPatch)
      : null;
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      assertExecutionBudgetActive({ client });
      const updated = await client.query(
        `update documents
         set parse_status='completed',
             document_type=coalesce($7::text, document_type),
             parse_stage=null,
             parse_progress_current=null,
             parse_progress_total=null,
             parse_summary=$4::jsonb,
             currency=case when $4::jsonb ? 'currency_resolution'
                           then $4::jsonb #>> '{currency_resolution,currency}'
                           else currency end,
             parse_error=null,
             parse_completed_at=now(),
             parse_heartbeat_at=now(),
             account_fingerprint=coalesce($5, account_fingerprint),
             payload=(case when $6::jsonb is null then coalesce(payload, '{}'::jsonb)
                          else coalesce(payload, '{}'::jsonb) || $6::jsonb end)
                       || case when $4::jsonb ? 'currency_resolution'
                               then jsonb_build_object('currency', $4::jsonb #> '{currency_resolution,currency}')
                          else '{}'::jsonb end,
             updated_at=now()
         where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
           and parse_status='processing'
         returning ${DOC_THIN_COLUMNS}`,
        [firmId, documentId, parseRunId, JSON.stringify(summary || {}), accountFingerprint || null, cleanPayloadPatch, documentType]
      );
      assertExecutionBudgetActive({ client });
      if (updated.rows.length) {
        await audit(client, {
          firmId,
          clientId: updated.rows[0].client_id,
          documentId,
          action: 'document.parse.completed',
          metadata: {
            parse_run_id: parseRunId,
            transaction_count: Number(summary?.transaction_count || 0),
            document_type: updated.rows[0].document_type || null
          }
        });
      }
      assertExecutionBudgetActive({ client });
      await client.query('commit');
      // Donna Loops shadow producer (post-commit, no-throw, LOOPS_SHADOW-gated):
      // a successful parse resolves the upload case's open parse blocker
      // (parse_failed / parse_stale / parse_pending) — the upload-triage
      // auto-resume. No-op unless a prior failure/stall opened that case.
      if (updated.rows.length) {
        await onDocumentParseCompleted({
          client, firmId, clientId: updated.rows[0].client_id,
          documentId, parseRunId, summary
        });
      }
      return updated.rows.length ? rowToThinParseStatus(updated.rows[0]) : null;
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    }
  });
};

// Terminal writer. Status-fenced (RT-02, audit F-02): the UPDATE accepts only
// `processing` (the run's own failure) or `pending` (a released run whose
// automatic budget is spent) — never `completed`/`failed`/`skipped`, so a late
// terminal write can no longer overwrite a newer or finished run. Callers
// that must not touch a released row narrow `allowedStatuses` to
// ['processing'] (the drain's release-did-not-happen guard). Inner
// transactional logic exported for the mock-client tests; the public
// `markParseFailedInDb` wraps it in `withFirmDbClient`.
const PARSE_FAILED_ALLOWED_STATUSES = Object.freeze(['processing', 'pending']);

export const __markParseFailedWithClient = async ({
  client, firmId, documentId, parseRunId, parseError,
  allowedStatuses = PARSE_FAILED_ALLOWED_STATUSES,
  requestAskDraftFn = onReconcileCompleteRequestAskDraft
} = {}) => {
  if (!firmId || !documentId || !parseRunId) return null;
  const statuses = (Array.isArray(allowedStatuses) ? allowedStatuses : PARSE_FAILED_ALLOWED_STATUSES)
    .filter((status) => PARSE_FAILED_ALLOWED_STATUSES.includes(status));
  if (!statuses.length) return null;
  await client.query('begin');
  try {
    const updated = await client.query(
      `update documents
       set parse_status='failed',
           parse_stage=null,
           parse_error=$4::jsonb,
           parse_heartbeat_at=now(),
           updated_at=now()
       where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
         and parse_status = any($5::text[])
       returning ${DOC_THIN_COLUMNS}`,
      [firmId, documentId, parseRunId, JSON.stringify(parseError || {}), statuses]
    );
    if (updated.rows.length) {
      await audit(client, {
        firmId,
        clientId: updated.rows[0].client_id,
        documentId,
        action: 'document.parse.failed',
        metadata: {
          parse_run_id: parseRunId,
          code: parseError?.code || 'INTERNAL',
          retryable: Boolean(parseError?.retryable),
          retry_owner: parseError?.retry_owner ?? null,
          provider: parseError?.provider || null,
          ...(parseError?.retry_exhausted ? { retry_exhausted: parseError.retry_exhausted } : {})
        }
      });
    }
    await client.query('commit');
    // Donna Loops shadow producer (post-commit, no-throw, LOOPS_SHADOW-gated):
    // open an upload case with a parse_failed blocker.
    if (updated.rows.length) {
      await onDocumentParseFailed({
        client, firmId, clientId: updated.rows[0].client_id,
        documentId, blockerType: 'parse_failed', parseError, parseRunId
      });
      // A failed document is terminal for this parse attempt. If an earlier
      // completion deferred owner questions while this row was in flight,
      // re-check quiescence now; otherwise the last failure can strand the
      // whole client's unresolved bank lines until another upload happens.
      await requestAskDraftFn({
        client, firmId, clientId: updated.rows[0].client_id,
        source: 'document_parse_failed'
      });
    }
    return updated.rows.length ? rowToThinParseStatus(updated.rows[0]) : null;
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  }
};

export const markParseFailedInDb = async ({
  firmId, documentId, parseRunId, parseError, allowedStatuses,
  requestAskDraftFn = onReconcileCompleteRequestAskDraft
} = {}) => {
  if (!firmId || !documentId || !parseRunId) return null;
  return withFirmDbClient((client) => __markParseFailedWithClient({
    client, firmId, documentId, parseRunId, parseError, allowedStatuses, requestAskDraftFn
  }));
};

export const markParseSkippedInDb = async ({
  firmId,
  documentId,
  parseRunId,
  reason,
  // Caller-supplied summary fields. The previous shape flattened the
  // skipped row's parse_summary to just `{reason, document_type}`,
  // which dropped genuinely useful context the extractor had already
  // computed (warnings, statement_period, statement_currency, the
  // `vision_skipped` reason after the new timeout-guardrail path).
  // Preserve them so the firm-side tray can render a meaningful triage
  // message instead of just "skipped". `reason` always wins over a
  // caller-supplied `reason` key inside the summary so the column-level
  // value stays authoritative.
  summary = null,
  requestAskDraftFn = onReconcileCompleteRequestAskDraft
} = {}) => {
  if (!firmId || !documentId || !parseRunId) return null;
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const mergedSummary = JSON.stringify({
        ...(summary && typeof summary === 'object' ? summary : {}),
        reason
        // document_type is merged in SQL below so the row's column value
        // wins regardless of what the caller passed.
      });
      const updated = await client.query(
        `update documents
         set parse_status='skipped',
             parse_stage=null,
             parse_summary=($4::jsonb || jsonb_build_object('document_type', document_type)),
             parse_completed_at=now(),
             parse_heartbeat_at=now(),
             updated_at=now()
         where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
         returning ${DOC_THIN_COLUMNS}`,
        [firmId, documentId, parseRunId, mergedSummary]
      );
      if (updated.rows.length) {
        await audit(client, {
          firmId,
          clientId: updated.rows[0].client_id,
          documentId,
          action: 'document.parse.skipped',
          metadata: { parse_run_id: parseRunId, reason }
        });
      }
      await client.query('commit');
      if (updated.rows.length) {
        // A skip has no downstream reconciliation leg to provide the normal
        // completion wake. Re-run the coalesced producer after the terminal
        // commit so a previously quiescence-deferred batch can proceed.
        await requestAskDraftFn({
          client, firmId, clientId: updated.rows[0].client_id,
          source: 'document_parse_skipped'
        });
      }
      return updated.rows.length ? rowToThinParseStatus(updated.rows[0]) : null;
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    }
  });
};

// ── PR 1 of docs/invoice-receipt-parsing-plan.md ───────────────────────
//
// Receipt / invoice / bill header writer. Mirrors markParseCompletedInDb
// but also writes the header-shape fields (vendor_name, document_date,
// total_amount, …) onto the documents row. Single transaction,
// parse_run_id-gated UPDATE — if the row has moved to a different
// parse_run_id since the worker started, the helper rolls back and
// returns `{ handled: false, reason: 'stale_parse_run' }`. No
// document_lines writes — those land in PR 2.
//
// `header` is the shape the receipt extractor returns:
//   { vendor_name, customer_name, document_date, total_amount,
//     currency, tax_amount, reference_number, payment_status,
//     extraction_confidence }
// `summary` is the parse_summary jsonb payload (already trimmed for
// PII by the extractor — no raw response bodies, no free-text fields
// beyond what we already store on the documents row).
//
// Audit metadata follows the plan §"Guardrails" rule: IDs and counts
// only, no extracted free-text. document_type is read from the
// updated row; extraction_confidence is a numeric band; vendor /
// customer / reference / description fields never appear.
// PR 2 of docs/invoice-receipt-parsing-plan.md.
//
// Short hash helper for stable, collision-safe new-line ids inside the
// merge. The full sha256 lives on the `fingerprint` column; the id only
// needs enough entropy to distinguish two rows with identical
// fingerprints from each other.
const shortFingerprint = (fp) => String(fp || '').slice(0, 12);

// Merge new extractor lines against the existing on-disk set, preserving
// firm decisions. Replaces PR 2's delete-then-insert. The caller owns
// the transaction — this helper assumes the documents UPDATE above it
// has just matched ≥1 row (so the parse_run_id gate covers the merge),
// and a rollback at that layer aborts the whole merge.
//
// Decision tree per new line (see plan §"Re-parse semantics"):
//   match found AND existing.review_status in ('accepted','deferred')
//       → KEEP every firm-owned column. ONLY refresh
//         `payload.raw_extraction` so PR 5's re-suggest sees the latest
//         LLM shape without touching the firm's edits. Invariant 3.
//   match found AND existing.review_status = 'needs_review'
//       → REFRESH structural columns (description, quantity, unit_price,
//         amount, tax_rate), recompute fingerprint (it'll mostly be a
//         no-op write — the algorithm is locked), reset
//         coding_confidence/source so PR 4/5 will re-derive, update
//         line_no to extractor order.
//   no match
//       → INSERT as needs_review.
//
// Orphans (existing rows whose fingerprint isn't matched by any new
// line):
//   review_status = 'needs_review' → DELETE (invariant 4 first half;
//     no human work to lose).
//   review_status in ('accepted','deferred') → KEEP, mark
//     `payload.warning='orphaned_by_reparse'`, enqueue a
//     `reparse_orphaned_accepted_line` review-queue row. Invariant 4
//     second half — this is the whole point of the merge contract.
//
// Same fingerprint can appear multiple times on disk (firm accepted a
// line, extractor returns it again, merge writes the refresh and a
// duplicate slips in via a separate flow). Match consumption uses
// (line_no asc nulls last, created_at asc) order — see Q7 in the PR 3
// handoff. The merge returns counts; the caller emits the
// `document.line.merged` audit and recomputes parse_summary.
export const mergeDocumentLinesForRun = async (client, {
  firmId,
  clientId,
  documentId,
  currency,
  lines
}) => {
  // Read every existing line for the doc, locked for update. The
  // FOR UPDATE prevents a concurrent PATCH from racing the merge —
  // any PATCH that grabs the same row blocks until the merge commits
  // or rolls back.
  const existingResult = await client.query(
    `select id, line_no, fingerprint, review_status, account_code,
            category, coding_source, coding_confidence,
            description, quantity, unit_price, amount, tax_rate,
            payload, created_at
       from document_lines
      where firm_id=$1 and document_id=$2
      order by line_no asc nulls last, created_at asc
      for update`,
    [firmId, documentId]
  );
  assertExecutionBudgetActive({ client });
  const existing = existingResult.rows;

  // Bucket existing rows by fingerprint, in (line_no, created_at)
  // order. Duplicate fingerprints on disk → multiple entries per
  // bucket; the merge consumes them first-come.
  const byFp = new Map();
  for (const row of existing) {
    const fp = row.fingerprint || '';
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(row);
  }
  const consumed = new Set();

  let kept = 0;
  let refreshed = 0;
  let inserted = 0;

  const newLines = Array.isArray(lines) ? lines : [];
  // Index for each `for` iteration so test mocks can assert ordering.
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i];
    const newLineNo = i + 1;
    const fp = lineFingerprint({
      description: line?.description,
      quantity: line?.quantity,
      unit_price: line?.unit_price,
      amount: line?.amount,
      currency: line?.currency || currency || null
    });

    const bucket = byFp.get(fp) || [];
    const match = bucket.find((row) => !consumed.has(row.id));

    if (match) {
      consumed.add(match.id);
      if (match.review_status === 'accepted' || match.review_status === 'deferred') {
        // INVARIANT 3 — firm decisions are sticky. Refresh ONLY the
        // raw_extraction blob so re-suggest sees the latest LLM text.
        // Every other column stays exactly as the firm left it.
        await client.query(
          `update document_lines
             set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{raw_extraction}', $3::jsonb),
                 updated_at = now()
           where firm_id=$1 and id=$2`,
          [firmId, match.id, JSON.stringify(line)]
        );
        kept += 1;
      } else {
        // needs_review match — safe to refresh structural columns. The
        // fingerprint is recomputed because line.amount (or any other
        // field that feeds the hash) could have shifted after a Retry;
        // the algorithm is locked, so this is a no-op write in the
        // common case but stays defensive.
        //
        // PR 4: when the input carries coding_source='client_rule'
        // (set by the coding pass — never trust raw extractor output)
        // and a non-empty account_code, stamp the rule's fields on top
        // of the structural refresh. The accepted/deferred branch above
        // already prevents this from overwriting a firm decision, so
        // by the time we're here we KNOW the row was needs_review on
        // disk — "no human work to lose". Non-rule inputs (extractor
        // raw, or a coding pass that didn't find a rule) take the
        // legacy path that resets coding_confidence/source to null.
        const inputIsRuleCoded =
          line?.coding_source === 'client_rule' && line?.account_code;
        if (inputIsRuleCoded) {
          await client.query(
            `update document_lines
               set description=$3, quantity=$4, unit_price=$5, amount=$6,
                   tax_rate=$7, line_no=$8, fingerprint=$9,
                   account_code=$11, category=$12,
                   coding_source='client_rule',
                   coding_confidence=1.00,
                   review_status='accepted',
                   payload = jsonb_set(
                     jsonb_set(coalesce(payload, '{}'::jsonb), '{raw_extraction}', $10::jsonb),
                     '{matched_client_rule_id}', to_jsonb($13::text)
                   ),
                   updated_at = now()
             where firm_id=$1 and id=$2`,
            [
              firmId,
              match.id,
              line?.description ?? null,
              line?.quantity ?? null,
              line?.unit_price ?? null,
              line?.amount ?? null,
              line?.tax_rate ?? null,
              newLineNo,
              fp,
              JSON.stringify(line),
              line.account_code,
              line.category ?? null,
              String(line.matched_client_rule_id || '')
            ]
          );
        } else {
          await client.query(
            `update document_lines
               set description=$3, quantity=$4, unit_price=$5, amount=$6,
                   tax_rate=$7, line_no=$8, fingerprint=$9,
                   coding_confidence=null, coding_source=null,
                   payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{raw_extraction}', $10::jsonb),
                   updated_at = now()
             where firm_id=$1 and id=$2`,
            [
              firmId,
              match.id,
              line?.description ?? null,
              line?.quantity ?? null,
              line?.unit_price ?? null,
              line?.amount ?? null,
              line?.tax_rate ?? null,
              newLineNo,
              fp,
              JSON.stringify(line)
            ]
          );
        }
        refreshed += 1;
      }
    } else {
      // No match available. Either a wholly new line, or the second
      // occurrence of a duplicate fingerprint whose existing match was
      // already consumed by an earlier new line. Either way: INSERT.
      // The id suffix mixes line index + fingerprint shortprefix so
      // collisions across re-parses (same fp twice in extract) get
      // distinct ids.
      const id = `${documentId}-ln-${newLineNo}-${shortFingerprint(fp)}`;
      // PR 4: rule-coded inputs (coding_source='client_rule' AND a
      // non-empty account_code, both stamped by the coding pass) land
      // straight as `accepted` with the rule's fields. Non-rule inputs
      // keep the legacy NULL / needs_review shape.
      const inputIsRuleCoded =
        line?.coding_source === 'client_rule' && line?.account_code;
      if (inputIsRuleCoded) {
        await client.query(
          `insert into document_lines (
             id, firm_id, client_id, document_id,
             description, quantity, unit_price, amount, tax_rate,
             line_no, fingerprint,
             coding_confidence, coding_source, account_code, category,
             review_status,
             payload
           ) values (
             $1, $2, $3, $4,
             $5, $6, $7, $8, $9,
             $10, $11,
             1.00, 'client_rule', $13, $14,
             'accepted',
             $12::jsonb
           )`,
          [
            id, firmId, clientId, documentId,
            line?.description ?? null,
            line?.quantity ?? null,
            line?.unit_price ?? null,
            line?.amount ?? null,
            line?.tax_rate ?? null,
            newLineNo, fp,
            JSON.stringify({
              raw_extraction: line,
              matched_client_rule_id: String(line.matched_client_rule_id || '')
            }),
            line.account_code,
            line.category ?? null
          ]
        );
      } else {
        await client.query(
          `insert into document_lines (
             id, firm_id, client_id, document_id,
             description, quantity, unit_price, amount, tax_rate,
             line_no, fingerprint,
             coding_confidence, coding_source, account_code, category,
             review_status,
             payload
           ) values (
             $1, $2, $3, $4,
             $5, $6, $7, $8, $9,
             $10, $11,
             null, null, null, null,
             'needs_review',
             $12::jsonb
           )`,
          [
            id, firmId, clientId, documentId,
            line?.description ?? null,
            line?.quantity ?? null,
            line?.unit_price ?? null,
            line?.amount ?? null,
            line?.tax_rate ?? null,
            newLineNo, fp,
            JSON.stringify({ raw_extraction: line })
          ]
        );
      }
      inserted += 1;
    }
  }

  // Orphans: every existing row not in `consumed`. Asymmetric handling
  // by review_status (invariant 4).
  let deletedOrphans = 0;
  let keptOrphans = 0;
  const keptOrphanIds = [];
  for (const row of existing) {
    if (consumed.has(row.id)) continue;
    if (row.review_status === 'needs_review') {
      await client.query(
        `delete from document_lines where firm_id=$1 and id=$2`,
        [firmId, row.id]
      );
      deletedOrphans += 1;
    } else {
      // accepted | deferred — never delete. Flag + enqueue.
      await client.query(
        `update document_lines
           set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{warning}', '"orphaned_by_reparse"'::jsonb),
               updated_at = now()
         where firm_id=$1 and id=$2`,
        [firmId, row.id]
      );
      await client.query(
        `insert into transaction_review_queue (
           id, firm_id, client_id, item_type, item_id, reason,
           priority, status, payload
         ) values (
           $1, $2, $3, 'document_line', $4, 'reparse_orphaned_accepted_line',
           'normal', 'open', $5::jsonb
         )
         on conflict (firm_id, client_id, item_type, item_id, reason) do nothing`,
        [
          `rvq-${row.id}-reparse-orphan`,
          firmId,
          clientId,
          row.id,
          JSON.stringify({
            previous_review_status: row.review_status,
            document_id: documentId
          })
        ]
      );
      keptOrphans += 1;
      keptOrphanIds.push(row.id);
    }
  }

  return {
    kept,
    refreshed,
    inserted,
    deletedOrphans,
    keptOrphans,
    keptOrphanIds
  };
};

// ── RT-10 — the amount_mismatch lane (audit F-05 tail, F-08) ──────────────
//
// A document whose extracted lines do not add up to its printed total used to
// open ONE firm-side `document_line` review row (`reason 'amount_mismatch'`)
// that nothing ever closed — the two-terminal violation the first principle
// forbids. The row now gets a lane, in order:
//
//   1. MACHINE lane — one strong re-read per parse run. The document's own
//      extractor is called again with the persisted totals receipt in the
//      prompt ("the printed total is X; your lines sum to Y; re-read") —
//      the trust-the-strong-LLM shape, not a rule. Runs BEFORE the writer's
//      transaction opens (no network call inside a txn, F5); receipted on
//      `parse_summary.totals_reread` immediately so a retried run never
//      re-reads. If the re-read FOOTS, its lines replace the first read's
//      and no review row is written. The header total is never replaced —
//      it is what the bank matcher sees; only the line split waited.
//   2. OWNER lane — if it still does not foot (or the re-read could not
//      run), the mismatch is a document FACT only the owner can settle: a
//      doc-anchored client_evidence_request (evidence_type
//      supporting_document) is minted through the ONE ask writer, in the
//      SAME transaction as the review row, anchored on the row
//      (review_item_id) so the resolve path flips the row when the ask
//      resolves. The writer dedups on an open ask per document.
//
// Never a firm click queue: at every commit point the row is either gone
// (footed) or on the owner. `payload.lane` names which.
// RT-12: the payout / deposit-slip family joins — the unified extractor
// re-reads a settlement's signed breakdown the same way it re-reads a
// bill's lines (the equation rides validateReceiptTotals either way).
export const TOTALS_REREAD_CAPABLE_TYPES = Object.freeze([
  'receipt', 'supplier_bill', 'sales_invoice', 'issued_receipt', 'payout_statement', 'deposit_slip'
]);

const TOTALS_LANE_LOG_TAG = 'totalsMismatchLane';

const roundMoney = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const fmtMoney = (value, currency) => {
  const n = roundMoney(value);
  if (n == null) return 'an unknown amount';
  return `${currency ? `${currency} ` : ''}${n.toFixed(2)}`;
};

// The prompt fragment the re-read rides in on. It travels through the
// extractors' existing free-text `dateFormatHint` seam (appended verbatim as
// an input_text part / "Date format hint:" line by every extractor, and only
// regex-inspected for the DD/MM convention) — no extractor is modified, and
// the locale note stays in front so the date convention still binds.
export const buildTotalsRereadHint = ({ validation = null, currency = null, documentType = 'document' } = {}) => {
  const v = validation || {};
  const kind = String(documentType || 'document').replace(/_/g, ' ');
  const parts = [
    `Re-read request: a previous extraction of this same ${kind} did not foot.`,
    `The document's printed total is ${fmtMoney(v.total, currency)}.`
  ];
  if (v.line_sum != null) {
    parts.push(`The previously extracted line items summed to ${fmtMoney(v.line_sum, currency)}` +
      (v.expected != null ? ` (expected ${fmtMoney(v.expected, currency)} under the ${v.strategy || 'declared'} roll-up; drift ${fmtMoney(v.drift, currency)})` : '') + '.');
  } else if (v.expected != null) {
    parts.push(`The previous header roll-up came to ${fmtMoney(v.expected, currency)} (drift ${fmtMoney(v.drift, currency)}).`);
  }
  parts.push(
    'Re-read every line item carefully so the lines reconcile to the printed total: include every discount, credit, shipping, delivery, fee, deposit, rounding and tax line the document prints, as printed; report subtotal_amount, discount_amount, shipping_amount, rounding_amount and tax_amount exactly as printed; set line_amounts_include_tax correctly for how the line amounts are shown.',
    'Do NOT invent or adjust a line to force the arithmetic: if the document genuinely does not add up, return the lines exactly as printed and add the warning "document_does_not_foot".'
  );
  return parts.join(' ');
};

// The owner-facing question for a document that still does not foot after
// the re-read. Cites the file and the two numbers; asks for the fact, and for
// a clearer copy if one exists (evidence_type supporting_document).
export const buildTotalsMismatchQuestion = ({
  documentType = 'document',
  counterparty = '',
  filename = '',
  currency = null,
  validation = null
} = {}) => {
  const v = validation || {};
  const kind = String(documentType || 'document').replace(/_/g, ' ');
  const who = String(counterparty || '').trim();
  const file = String(filename || '').trim();
  const label = [who ? `the ${kind} from ${who}` : `the ${kind}`, file ? `(${file})` : ''].filter(Boolean).join(' ');
  const printed = fmtMoney(v.total, currency);
  const lines = v.line_sum != null ? fmtMoney(v.line_sum, currency) : (v.expected != null ? fmtMoney(v.expected, currency) : null);
  const contrast = lines
    ? `shows a total of ${printed}, but its line items add up to ${lines}`
    : `shows a total of ${printed} that its line items do not add up to`;
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${contrast}. Which is right — is a line missing (a discount, fee or delivery charge), or is the printed total different? If you have a clearer copy of the document, please upload it.`;
};

const summaryWithoutMismatch = (summary = {}) => {
  const warnings = Array.isArray(summary.warnings) ? summary.warnings.filter((w) => w !== 'amount_mismatch') : [];
  return { ...summary, warnings };
};

// The real seams. `extractorFor` mirrors the worker's dispatch for the four
// line-bearing types (the same extractor the document used); the unified
// path re-reads through the unified extractor (its `dateFormatHint` seam is
// the same free-text line). Statement / contract / generic parses never
// carry a line-level mismatch and are not re-read.
const defaultTotalsLaneDeps = () => ({
  fetchBytes: async ({ bucket, key }) =>
    (await import('./evidenceStorage.js')).fetchEvidenceObjectBytes({ bucket, key }),
  extractorFor: async ({ documentType, extractorPath }) => {
    // RT-12: the document's own extractor. A unified-path document re-reads
    // through the provider-agnostic unified call (it resolves its own
    // provider from the keys present; the routed type rides as the hint);
    // the per-type modules serve the per-type path for one more release.
    if (extractorPath === 'unified') {
      const { extractUnified } = await import('./unifiedExtractor.js');
      return {
        type: 'unified',
        extract: (args) => extractUnified({ ...args, documentType })
      };
    }
    if (documentType === 'receipt') return { type: 'receipt', extract: extractReceiptFromBase64 };
    if (documentType === 'supplier_bill') return { type: 'supplier_bill', extract: extractSupplierBillFromBase64 };
    if (documentType === 'sales_invoice' || documentType === 'issued_receipt') {
      return { type: documentType, extract: extractSalesInvoiceFromBase64 };
    }
    if (documentType === 'payout_statement' || documentType === 'deposit_slip') {
      const { extractPayoutStatementFromBase64 } = await import('./payoutStatement.js');
      return { type: 'payout_statement', extract: (args) => extractPayoutStatementFromBase64({ ...args, documentType }) };
    }
    return null;
  },
  dateHintFor: async ({ firmId, clientId }) => {
    const context = await getExtractionContextInDb({ firmId, clientId });
    const { dateFormatHintFor } = await import('./jurisdictionDate.js');
    return dateFormatHintFor(context.jurisdiction);
  },
  identityFor: ({ firmId, clientId }) => getExtractionContextInDb({ firmId, clientId }),
  mintOwnerAsk: (args) => __createClientEvidenceRequestWithClient(args)
});

const resolveTotalsLaneDeps = (overrides) => ({ ...defaultTotalsLaneDeps(), ...(overrides || {}) });

// Machine lane. Returns `{ summary, lines, receipt }` — the summary always
// carries `totals_reread` afterwards (attempted or not, with the reason), and
// `lines` are the re-read's ONLY when it footed. NEVER throws: any failure
// is receipted and the first read stands.
export const runTotalsRereadLane = async ({
  client,
  firmId,
  documentId,
  parseRunId,
  header = {},
  summary = {},
  lines = [],
  deps = null
} = {}) => {
  const lane = resolveTotalsLaneDeps(deps);
  const validation = summary?.totals_validation && typeof summary.totals_validation === 'object'
    ? summary.totals_validation
    : null;
  const receipt = (fields) => ({
    parse_run_id: parseRunId,
    attempted: false,
    outcome: null,
    reason: null,
    extractor: null,
    model: null,
    requested_at: new Date().toISOString(),
    prior: validation ? { line_sum: validation.line_sum ?? null, expected: validation.expected ?? null, drift: validation.drift ?? null, strategy: validation.strategy ?? null } : null,
    ...fields
  });
  const keep = (fields) => ({ summary: { ...summary, totals_reread: receipt(fields) }, lines, receipt: receipt(fields) });

  if (!Array.isArray(lines) || lines.length === 0) {
    // A header-only mismatch (basis 'subtotal') has no line split to
    // re-derive; the header arithmetic stands as the warning it already is.
    return keep({ reason: 'header_only' });
  }
  const persistReceipt = async (fields) => {
    const value = receipt(fields);
    try {
      await client.query(
        `update documents
            set parse_summary = coalesce(parse_summary, '{}'::jsonb) || jsonb_build_object('totals_reread', $4::jsonb),
                parse_heartbeat_at = now(),
                updated_at = now()
          where firm_id=$1 and id=$2 and parse_run_id=$3::uuid`,
        [firmId, documentId, parseRunId, JSON.stringify(value)]
      );
    } catch (error) {
      console.warn(`[${TOTALS_LANE_LOG_TAG}] receipt persist failed (continuing)`, {
        document_id: documentId,
        error: error?.message || String(error)
      });
    }
    return value;
  };
  try {
    const docResult = await client.query(
      `select id, client_id, document_type, filename, storage_bucket, storage_object_key,
              payload, parse_summary
         from documents
        where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
        limit 1`,
      [firmId, documentId, parseRunId]
    );
    const doc = docResult.rows[0] || null;
    if (!doc) return keep({ reason: 'document_not_found' });
    // At most once per parse run: a retried write step after a crash finds
    // the receipt already persisted and does not spend a second call.
    const prior = doc.parse_summary?.totals_reread;
    if (prior && prior.parse_run_id === parseRunId && prior.attempted) {
      return { summary: { ...summary, totals_reread: prior }, lines, receipt: prior };
    }
    const documentType = doc.document_type || summary.document_type || 'unknown';
    if (!TOTALS_REREAD_CAPABLE_TYPES.includes(documentType) && summary?.extractor?.path !== 'unified') {
      return keep({ reason: `no_reread_extractor:${documentType}` });
    }
    const extractor = await lane.extractorFor({ documentType, extractorPath: summary?.extractor?.path || null });
    if (!extractor) return keep({ reason: `no_reread_extractor:${documentType}` });
    if (!doc.storage_bucket || !doc.storage_object_key) return keep({ reason: 'no_storage_reference' });

    // Touch the heartbeat around the call: the row is still `processing`
    // (stage 'writing') and the stuck sweep watches parse_heartbeat_at.
    await client.query(
      'update documents set parse_heartbeat_at=now() where firm_id=$1 and id=$2 and parse_run_id=$3::uuid',
      [firmId, documentId, parseRunId]
    );
    const bytes = await lane.fetchBytes({ bucket: doc.storage_bucket, key: doc.storage_object_key });
    const filename = doc.filename || doc.id;
    const mimeType = doc.payload?.mime_type || doc.payload?.file_storage?.mime_type || '';
    const currency = header?.currency || summary?.currency || null;
    let dateHint = '';
    try { dateHint = (await lane.dateHintFor({ firmId, clientId: doc.client_id })) || ''; } catch { dateHint = ''; }
    let clientIdentity = null;
    try { clientIdentity = await lane.identityFor({ firmId, clientId: doc.client_id }); } catch { clientIdentity = null; }
    const rereadHint = [dateHint, buildTotalsRereadHint({ validation, currency, documentType })].filter(Boolean).join('\n\n');

    const extraction = await extractor.extract({
      base64: Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes || '').toString('base64'),
      filename,
      mimeType,
      dateFormatHint: rereadHint,
      clientIdentity
    });
    const kind = extraction?.kind;
    if (kind !== 'completed' && kind !== 'completed_header') {
      const value = await persistReceipt({
        attempted: true,
        outcome: 'extraction_failed',
        extractor: extractor.type,
        model: extraction?.model || null,
        reason: extraction?.code || extraction?.reason || 'extraction_failed'
      });
      return { summary: { ...summary, totals_reread: value }, lines, receipt: value };
    }
    const rereadLines = Array.isArray(extraction.lines) ? extraction.lines : [];
    const rs = extraction.summary || {};
    // The header total is never replaced (the matcher's number); the re-read
    // supplies the line split and the roll-up inputs around it.
    const rereadSummary = {
      ...summary,
      subtotal_amount: rs.subtotal_amount ?? summary.subtotal_amount ?? null,
      tax_amount: rs.tax_amount ?? summary.tax_amount ?? null,
      shipping_amount: rs.shipping_amount ?? summary.shipping_amount ?? null,
      discount_amount: rs.discount_amount ?? summary.discount_amount ?? null,
      rounding_amount: rs.rounding_amount ?? summary.rounding_amount ?? null,
      line_amounts_include_tax: rs.line_amounts_include_tax ?? summary.line_amounts_include_tax ?? false,
      total_amount: summary.total_amount ?? header?.total_amount ?? null
    };
    const validation2 = validateReceiptTotals({ summary: rereadSummary, lines: rereadLines });
    const model = extraction.model || extraction.extractor_model || null;
    if (validation2.matches && rereadLines.length > 0) {
      const value = await persistReceipt({
        attempted: true,
        outcome: 'footed',
        extractor: extractor.type,
        model,
        lines_replaced: true,
        line_count: rereadLines.length,
        validation: validation2
      });
      return {
        summary: {
          ...summaryWithoutMismatch(rereadSummary),
          totals_validation: validation2,
          totals_reread: value,
          line_count: rereadLines.length,
          review_line_count: 0
        },
        lines: rereadLines,
        receipt: value
      };
    }
    const value = await persistReceipt({
      attempted: true,
      outcome: 'still_off',
      extractor: extractor.type,
      model,
      lines_replaced: false,
      line_count: rereadLines.length,
      validation: validation2
    });
    return { summary: { ...summary, totals_reread: value }, lines, receipt: value };
  } catch (error) {
    console.error(`[${TOTALS_LANE_LOG_TAG}] re-read lane threw — the first read stands, the owner lane takes over`, {
      document_id: documentId,
      error: error?.message || String(error)
    });
    const value = await persistReceipt({
      attempted: true,
      outcome: 'error',
      reason: String(error?.message || error).slice(0, 200)
    });
    return { summary: { ...summary, totals_reread: value }, lines, receipt: value };
  }
};

// An amount_mismatch row whose owner ask has since resolved or been
// cancelled is DONE — the reply reached a human or the ask was withdrawn —
// so the row must not linger open on the firm. Idempotent; client-scoped
// (cheap: the open document_line rows of one client).
export const settleResolvedTotalsAskRowsWithClient = async (client, { firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return { resolved: 0 };
  const result = await client.query(
    `update transaction_review_queue q
        set status='resolved', updated_at=now(),
            payload = q.payload || jsonb_build_object('lane', coalesce(q.payload->'lane', '{}'::jsonb) || '{"resolved_by":"owner_ask_resolved"}'::jsonb)
      where q.firm_id=$1 and q.client_id=$2
        and q.item_type='document_line' and q.reason='amount_mismatch' and q.status='open'
        and exists (
          select 1 from client_evidence_requests cer
           where cer.firm_id=q.firm_id and cer.client_id=q.client_id
             and cer.id = q.payload->'lane'->>'evidence_request_id'
             and cer.status in ('resolved', 'cancelled')
        )
      returning q.id`,
    [firmId, clientId]
  );
  return { resolved: result.rows.length };
};

const performWriteParsedDocumentExtraction = async ({
  client,
  firmId,
  documentId,
  parseRunId,
  header = {},
  summary,
  // PR 2: receipt extractor returns lines[]. PR 1 callers (and the
  // DOCUMENT_LINES_ENABLED=false code path) pass `lines: []`; the
  // helper still wipes any pre-existing lines so re-parses are clean.
  lines = [],
  // Classifier authoritative mode. When the worker's router override
  // changed the dispatched extractor, the new document_type is
  // propagated here so the row reflects the final classification.
  // When null/undefined the row's existing document_type is preserved
  // (COALESCE in the UPDATE below). The downstream reconciliation
  // dispatch reads `updated.rows[0].document_type` so it sees the new
  // value the same write it's persisted.
  documentType = null,
  // Direction is the AP/AR/internal axis derived from documentType.
  // Written into documents.direction so matchers and inbox filters
  // can branch on direction without maintaining a parallel IN-list of
  // types. null preserves the existing column value.
  direction = null,
  // RT-10 — injectable seams for the amount_mismatch lane (the re-read
  // extractor, the evidence bytes, the identity/date-hint readers, the
  // owner-ask writer). null ⇒ the real ones; tests drive the writer with
  // stubs. Production never passes it.
  totalsLaneDeps = null,
  materialRecovery = null
}) => {
  const laneDeps = resolveTotalsLaneDeps(totalsLaneDeps);
  // RT-10 (F-05 tail): the MACHINE lane runs before the transaction opens —
  // a network call never rides inside the writer's txn (F5) — and replaces
  // `summary` / `lines` with the re-read's when that one foots. Either way
  // `summary.totals_reread` is the receipt of what happened.
  if (Array.isArray(summary?.warnings) && summary.warnings.includes('amount_mismatch')) {
    const lane = await runTotalsRereadLane({
      client, firmId, documentId, parseRunId, header, summary, lines, deps: laneDeps
    });
    summary = lane.summary;
    lines = lane.lines;
  }
  const totalsJev = Array.isArray(summary?.warnings) && summary.warnings.includes('amount_mismatch')
    ? await (laneDeps.decideJevException || decideJevMaterialException)({ client, firmId, documentId, parseRunId,
      kind: 'totals_mismatch', evidence: { header, summary, lines: lines.slice(0, 256), lines_truncated: lines.length > 256 } })
    : null;
  if (totalsJev) summary = { ...summary, jev_exception: totalsJev };
  await client.query('begin');
  try {
    if(materialRecovery) {
      const locked=(await client.query('select * from documents where firm_id=$1 and id=$2 for update',[firmId,documentId])).rows[0];
      const {readJevCase,evidenceSummary}=await import('./jevPreview.js');
      const {hash}=await import('./jevEvidenceContract.js');
      const mapped=await readJevCase({client,firmId,clientId:locked.client_id,documentId,evidenceOnly:true,lockEvidence:true});
      const source=mapped.caseEvidence.documents.find(d=>d.id===documentId);
      if(hash({source:{...source,parse_summary:evidenceSummary(source.parse_summary)},checksum:locked.checksum_sha256,run:locked.parse_run_id})!==materialRecovery.source_digest) {
        throw Object.assign(new Error('Source changed before totals recovery write'),{code:'JEV_MATERIAL_SOURCE_CHANGED'});
      }
    }
    assertExecutionBudgetActive({ client });
    const updated = await client.query(
      `update documents
       set vendor_name=$4,
           customer_name=$5,
           document_date=$6,
           due_date=$7,
           total_amount=$8,
           currency=$9,
           tax_amount=$10,
           reference_number=$11,
           payment_status=coalesce($12, payment_status),
           extraction_confidence=$13,
           parse_status='completed',
           parse_stage=null,
           parse_progress_current=null,
           parse_progress_total=null,
           parse_summary=$14::jsonb,
           parse_error=null,
           parse_completed_at=now(),
           parse_heartbeat_at=now(),
           document_type=coalesce($15, document_type),
           direction=coalesce($16, direction),
           updated_at=now()
       where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
       returning ${DOC_THIN_COLUMNS}`,
      [
        firmId,
        documentId,
        parseRunId,
        header.vendor_name ?? null,
        header.customer_name ?? null,
        header.document_date ?? null,
        header.due_date ?? null,
        header.total_amount ?? null,
        header.currency ?? null,
        header.tax_amount ?? null,
        header.reference_number ?? null,
        header.payment_status ?? null,
        header.extraction_confidence ?? null,
        JSON.stringify(summary || {}),
        documentType || null,
        direction || null
      ]
    );
    assertExecutionBudgetActive({ client });
    if (!updated.rows.length) {
      // Row moved to a different parse_run_id between worker start
      // and this write. Same protection as markParseCompletedInDb;
      // skipping it is exactly the class of mistake that caused
      // PR #43–#53 (stuck-in-Queued) incidents. The line writes do
      // NOT execute — they live inside this same transaction and
      // the rollback below aborts them before they run.
      await client.query('rollback');
      return { handled: false, reason: 'stale_parse_run' };
    }

    // Lines are written inside the same transaction as the documents
    // UPDATE above. The parse_run_id gate on that UPDATE covers the
    // entire write — if a newer run claimed the doc, we never get
    // here. PR 3 replaces PR 2's delete-then-insert with a merge that
    // protects firm-edited rows (see `mergeDocumentLinesForRun`).
    const clientId = updated.rows[0].client_id;
    const amountMismatch =
      Array.isArray(summary?.warnings) && summary.warnings.includes('amount_mismatch');

    // PR 4 coding pass — runs between the gate and the merge so the
    // parse_run_id gate already covered the SELECTs by the time we
    // get here, and so the merge sees pre-coded inputs on its no-match
    // and needs_review-match branches. Accepted/deferred matches stay
    // sticky regardless (invariant 1).
    const codingResult = await codeDocumentLinesByRule({
      client,
      firmId,
      clientId,
      documentId,
      vendorName: header.vendor_name,
      lines
    });

    const mergeStats = await mergeDocumentLinesForRun(client, {
      firmId,
      clientId,
      documentId,
      currency: header.currency,
      lines: codingResult.codedLines
    });

    // Pull the surviving line ids post-merge. Used to scope
    // amount_mismatch queue writes (open-on-mismatch, close-on-reconcile)
    // and to recompute parse_summary counts.
    const surviving = await client.query(
      `select id from document_lines where firm_id=$1 and document_id=$2 order by id`,
      [firmId, documentId]
    );
    const survivingIds = surviving.rows.map((r) => r.id);
    const linesWritten = survivingIds.length;

    // A totals mismatch is one DOCUMENT exception, not N independent line
    // decisions. Older builds fanned it out to every surviving line (61 open
    // rows across eight Cactus documents). Close that whole document-scoped
    // set first, then — only when the mismatch remains — reopen one stable
    // representative-line anchor. We retain item_type=document_line so the
    // existing document-detail/correction lifecycle remains the sole owner;
    // payload.scope makes the aggregate semantics explicit.
    // RT-10: rows whose owner ask has since resolved/cancelled are done —
    // settle them before touching this document's own row (client-scoped,
    // idempotent; the resolve path already flips the anchored row itself,
    // this covers asks closed without the review_item hop).
    await settleResolvedTotalsAskRowsWithClient(client, { firmId, clientId });
    await client.query(
      `update transaction_review_queue
          set status='resolved', updated_at=now()
        where firm_id=$1
          and item_type='document_line'
          and reason='amount_mismatch'
          and status='open'
          and payload->>'document_id'=$2`,
      [firmId, documentId]
    );
    // RT-10: which lane closed (or now carries) the totals exception — the
    // audit below and the tray read it. 'footed' = the machine re-read fixed
    // the line split; 'owner_ask' = the owner holds it; null = no mismatch.
    let totalsLane = summary?.totals_reread?.outcome === 'footed' ? 'footed' : null;
    let totalsOwnerAskId = null;
    if (amountMismatch && survivingIds.length) {
      const anchorLineId = survivingIds[0];
      const reviewRowId = `rvq-${anchorLineId}-amount-mismatch`;
      await client.query(
        `insert into transaction_review_queue (
           id, firm_id, client_id, item_type, item_id, reason,
           priority, status, payload
         ) values (
           $1, $2, $3, 'document_line', $4, 'amount_mismatch',
           'normal', 'open', $5::jsonb
         )
         on conflict (firm_id, client_id, item_type, item_id, reason)
         do update set status='open', payload=excluded.payload, updated_at=now()`,
        [
          reviewRowId,
          firmId,
          clientId,
          anchorLineId,
          JSON.stringify({
            document_id: documentId,
            scope: 'document_totals',
            reason_details: 'totals_do_not_reconcile',
            // RT-04 (F-05): the numbers behind the verdict — expected /
            // total / drift / strategy — so the row can be diagnosed from
            // its own receipt. null only for a legacy summary that carried
            // the bare token.
            totals_validation: summary?.totals_validation ?? null,
            // RT-10: the machine lane's receipt (what the re-read found),
            // and the lane the row rests in — written below once the ask
            // exists, in this same transaction.
            totals_reread: summary?.totals_reread ?? null,
            lane: exceptionOwnerAskAllowed(totalsJev) ? { kind: 'owner_ask', status: 'minting' } : exceptionPendingLane(totalsJev),
            ...(totalsJev ? { jev_first: totalsJev } : {})
          })
        ]
      );
      // OWNER lane (RT-10, F-05 tail): the row never rests firm-side — the
      // ask is minted in the SAME transaction, through the ONE ask writer
      // (open-ask dedup per document, deterministic id, its own audit),
      // anchored on both the document and this review row so the resolve
      // path flips the row when the ask resolves. A mint failure fails the
      // write (the parse retries), never a row without a lane.
      if (exceptionOwnerAskAllowed(totalsJev)) {
        const counterparty = header?.vendor_name || header?.customer_name || summary?.counterparty_name || '';
        const mintOutcome = {};
        const request = await laneDeps.mintOwnerAsk({
          client,
          firmId,
          clientId,
          documentId,
          reviewItemId: reviewRowId,
          question: buildTotalsMismatchQuestion({
            documentType: updated.rows[0].document_type || summary?.document_type || 'document',
            counterparty,
            filename: updated.rows[0].filename || '',
            currency: header?.currency || summary?.currency || null,
            validation: summary?.totals_validation ?? null
          }),
          evidenceType: 'supporting_document',
          actorId: 'system',
          requestContext: {
            lane: 'totals_mismatch',
            ...(totalsJev ? { jev_first: totalsJev } : {}),
            review_item_id: reviewRowId,
            totals_validation: summary?.totals_validation ?? null,
            totals_reread: summary?.totals_reread
              ? { attempted: summary.totals_reread.attempted, outcome: summary.totals_reread.outcome, model: summary.totals_reread.model || null }
              : null
          },
          mintOutcome
        });
        totalsOwnerAskId = request?.id || null;
        totalsLane = 'owner_ask';
        await client.query(
          `update transaction_review_queue
              set payload = payload || $4::jsonb, updated_at=now()
            where firm_id=$1 and client_id=$2 and id=$3`,
          [
            firmId,
            clientId,
            reviewRowId,
            JSON.stringify({
              lane: {
                kind: 'owner_ask',
                status: 'open',
                evidence_request_id: totalsOwnerAskId,
                minted: mintOutcome.minted ?? null,
                minted_at: new Date().toISOString()
              }
            })
          ]
        );
      } else {
        totalsLane = totalsJev.execution;
      }
    }

    // Recompute parse_summary counts post-merge. `coded_line_count`
    // counts rows the firm (or a future PR 4/5 pass) has stamped with
    // an account_code; PR 3 only ever sets that on PATCH, so the count
    // reflects the firm's standing accept/override decisions across
    // the doc — not a parser output.
    const summaryCounts = await client.query(
      `select
         count(*)::int                                     as line_count,
         count(*) filter (where account_code is not null)::int as coded_line_count,
         count(*) filter (
           where id in (
             select item_id from transaction_review_queue
              where firm_id=$1 and item_type='document_line'
                and item_id = document_lines.id and status='open'
           )
         )::int                                            as review_line_count
       from document_lines
       where firm_id=$1 and document_id=$2`,
      [firmId, documentId]
    );
    const counts = summaryCounts.rows[0] || { line_count: 0, coded_line_count: 0, review_line_count: 0 };
    const existingWarnings = Array.isArray(summary?.warnings) ? summary.warnings.slice() : [];
    if (mergeStats.keptOrphans > 0 && !existingWarnings.includes('orphaned_lines_kept')) {
      existingWarnings.push('orphaned_lines_kept');
    }
    const nextSummary = {
      ...(summary || {}),
      line_count: counts.line_count,
      coded_line_count: counts.coded_line_count,
      review_line_count: counts.review_line_count,
      warnings: existingWarnings
    };
    await client.query(
      `update documents
         set parse_summary=$3::jsonb, updated_at=now()
       where firm_id=$1 and id=$2 and parse_run_id=$4::uuid`,
      [firmId, documentId, JSON.stringify(nextSummary), parseRunId]
    );

    // Reconciliation PR 1 — deterministic receipt candidate matching.
    // Runs inside the writer transaction so a rollback above also
    // rolls back the candidate rows. The orchestrator itself filters
    // on document_type='receipt' + total_amount IS NOT NULL + not a
    // duplicate, so non-receipt parses are a single SELECT no-op.
    if (updated.rows[0].document_type === 'receipt' && header?.total_amount != null) {
      await runReceiptReconciliationForDocument({
        client,
        firmId,
        clientId,
        documentId
      });
      // Reconciliation PR 3 — safe auto-explain. Runs inside the same
      // writer transaction so the four-row cascade (match flip, tx
      // status, doc payment_status, audit) commits or rolls back
      // atomically with the parse. The global env kill switch is
      // checked inside the entry point before any DB read.
      await autoExplainReceiptForDocument({
        client,
        firmId,
        clientId,
        documentId,
        parseRunId
      });
    }

    // Reconciliation PR 8 — sales-invoice candidate matching. Sibling
    // gate to the receipt path; the AR matcher scans money_in
    // transactions only and writes matched_object_type='sales_invoice'.
    // Soft-degrades on throw so a matcher failure never aborts the
    // invoice's parse (the invoice itself is already written above).
    //
    // PR 10 — AR auto-explain pass. Runs AFTER the matcher in the
    // same writer transaction so the four-row cascade (match flip,
    // tx status, doc payment_status, audit) commits or rolls back
    // atomically with the parse. Two kill switches gate it:
    // (a) global SALES_INVOICE_AUTO_EXPLAIN_ENABLED env var, checked
    // before any DB read; (b) per-firm `auto_explain.sales_invoice_enabled`
    // in firms.metadata, default false. Soft-degrades independently
    // of the matcher so a single failure mode contains.
    // sales_invoice + issued_receipt — same AR pipeline. issued_receipt
    // is structurally a receipt the firm ISSUED to a customer; it
    // matches money_in transactions on the firm's bank statement and
    // uses the same scoring tiers, customer-name fuzzy match, and
    // reference-substring logic as a sales invoice. Distinct
    // document_type is preserved on the row so accounting templates
    // can render "Receipt issued" rather than "Sales invoice / paid".
    const docType = updated.rows[0].document_type;
    if ((docType === 'sales_invoice' || docType === 'issued_receipt') && header?.total_amount != null) {
      try {
        await runSalesInvoiceReconciliationForDocument({
          client,
          firmId,
          clientId,
          documentId
        });
      } catch (error) {
        console.error('[salesInvoiceReconciliation] orchestrator threw — invoice parse continues', {
          documentId,
          error: error?.message || String(error)
        });
      }
      try {
        await autoExplainSalesInvoiceForDocument({
          client,
          firmId,
          clientId,
          documentId,
          parseRunId
        });
      } catch (error) {
        console.error('[salesInvoiceAutoExplain] orchestrator threw — invoice parse continues', {
          documentId,
          error: error?.message || String(error)
        });
      }
    }

    // Reconciliation PR 9 — supplier-bill candidate matching. Sibling
    // gate to the receipt + AR paths; the bill matcher scans money_out
    // transactions only and writes matched_object_type='supplier_bill'.
    // Coexists with the receipt matcher in the same direction (Q1 —
    // both may propose against the same money_out tx; the firm
    // resolves cross-document-type competition in the review UI).
    // Soft-degrades on throw so a matcher failure never aborts the
    // bill's parse.
    //
    // PR 11 — AP auto-explain pass. Runs AFTER the matcher in the
    // same writer transaction so the four-row cascade (match flip,
    // tx status, doc payment_status, audit) commits or rolls back
    // atomically with the parse. Two kill switches gate it:
    // (a) global BILL_AUTO_EXPLAIN_ENABLED env var, checked before
    // any DB read; (b) per-firm `auto_explain.supplier_bill_enabled`
    // in firms.metadata, default false. Soft-degrades independently
    // of the matcher so a single failure mode contains.
    if (updated.rows[0].document_type === 'supplier_bill' && header?.total_amount != null) {
      try {
        await runBillReconciliationForDocument({
          client,
          firmId,
          clientId,
          documentId
        });
      } catch (error) {
        console.error('[billReconciliation] orchestrator threw — bill parse continues', {
          documentId,
          error: error?.message || String(error)
        });
      }
      try {
        await autoExplainBillForDocument({
          client,
          firmId,
          clientId,
          documentId,
          parseRunId
        });
      } catch (error) {
        console.error('[billAutoExplain] orchestrator threw — bill parse continues', {
          documentId,
          error: error?.message || String(error)
        });
      }
    }

    // payment_account_statement (Amex / fuel-card / expense-platform
    // statements). Level-1 matcher: settlement total
    // ↔ outbound bank ACH. Reuses the bill matcher's scoring; writes
    // rows with matched_object_type='payment_account_statement'. No
    // auto-explain in this stage. Soft-degrades on throw so a matcher
    // failure never aborts the statement's parse.
    if (updated.rows[0].document_type === 'payment_account_statement' && header?.total_amount != null) {
      try {
        await runPaymentAccountStatementReconciliationForDocument({
          client,
          firmId,
          clientId,
          documentId
        });
      } catch (error) {
        console.error('[paymentAccountStatementReconciliation] orchestrator threw — statement parse continues', {
          documentId,
          error: error?.message || String(error)
        });
      }
    }

    // payment_confirmation (single-event outbound ACH/wire receipts —
    // Amex / IRS / lender payment confirmations). Matches the
    // extracted total_amount + counterparty + date against the
    // outbound bank ACH. Header.total_amount is only populated when
    // the generic extractor actually ran (Stage 2.5 wires the route);
    // pre-2.5 docs that landed extractor_unavailable skip this branch
    // by construction.
    if (updated.rows[0].document_type === 'payment_confirmation' && header?.total_amount != null) {
      try {
        await runPaymentConfirmationReconciliationForDocument({
          client,
          firmId,
          clientId,
          documentId
        });
      } catch (error) {
        console.error('[paymentConfirmationReconciliation] orchestrator threw — confirmation parse continues', {
          documentId,
          error: error?.message || String(error)
        });
      }
    }

    // RT-18 — payout statements / deposit slips (the firm's own revenue
    // arriving). Matches the extracted NET (header.total_amount) + the
    // payout reference + the payout date against the money_in feed. This
    // doc-side leg is what matches a payout that parses AFTER its bank
    // statement (the appliance has no periodic reconcile task; the
    // statement-side orchestrator above only runs on a statement parse) —
    // without it a late payout rests unmatched, a two-terminal violation.
    // Soft-degrades on throw so a matcher failure never aborts the parse.
    if (
      (updated.rows[0].document_type === 'payout_statement' || updated.rows[0].document_type === 'deposit_slip') &&
      header?.total_amount != null
    ) {
      try {
        await runPayoutReconciliationForDocument({
          client,
          firmId,
          clientId,
          documentId
        });
      } catch (error) {
        console.error('[payoutReconciliation] orchestrator threw — payout parse continues', {
          documentId,
          error: error?.message || String(error)
        });
      }
    }

    // After any of the per-doc-type matcher branches above runs, derive
    // category + account from the matched doc's vendor → CoA mapping
    // for the now-matched transaction. Pre-this-change, autoCategorize
    // only fired on the bank-statement parse-completion path — so a
    // payment_confirmation arriving AFTER the bank statement (the
    // Honeybee IRS case) got `MATCHED · AUTO` on the row but stayed
    // categorised as whatever the AI fallback assigned at bank-
    // statement-time (`taxes_fees · AI`). Gated on the document type
    // matching one of the tx-side matchers — contracts and bank
    // statements don't create tx matches here, so they skip the call.
    const matcherDocTypes = new Set([
      'receipt',
      'sales_invoice',
      'issued_receipt',
      'supplier_bill',
      'payment_account_statement',
      'payment_confirmation',
      // RT-18
      'payout_statement',
      'deposit_slip'
    ]);
    if (matcherDocTypes.has(updated.rows[0].document_type) && header?.total_amount != null) {
      try {
        await autoCategorizeMatchedTransactionsInDb({
          firmId,
          clientId,
          dbClient: client,
          inTransaction: true
        });
      } catch (error) {
        // Soft-degrade: a categorisation failure shouldn't unwind the
        // matcher's work the doc just produced.
        console.error('[autoCategorize] threw after per-doc-type matcher — match was created, categorisation skipped', {
          documentId,
          error: error?.message || String(error)
        });
      }
    }

    if (updated.rows[0].document_type === 'contract' &&
        Array.isArray(summary?.obligations) && summary.obligations.length > 0) {
      const obSql = writeObligationsForContractSql({
        firmId,
        clientId,
        documentId,
        obligations: summary.obligations
      });
      if (obSql.deleteSql) {
        await client.query(obSql.deleteSql, obSql.deleteParams);
        await client.query(obSql.insertSql, obSql.insertParams);
      }
    }

    await audit(client, {
      firmId,
      clientId,
      documentId,
      action: 'document.parse.completed',
      metadata: {
        parse_run_id: parseRunId,
        document_type: updated.rows[0].document_type || null,
        // Numeric extraction_confidence is OK to store in audit
        // (no PII). Free-text extracted fields stay out per the
        // plan's PII policy.
        extraction_confidence:
          header.extraction_confidence == null ? null : Number(header.extraction_confidence),
        line_count: linesWritten,
        amount_mismatch: amountMismatch,
        // RT-10 (the RT-04 follow-up): the numbers, not just the bool — and
        // the lane the exception took. Bounded numbers + enums only.
        totals_validation: summary?.totals_validation && typeof summary.totals_validation === 'object'
          ? {
              matches: summary.totals_validation.matches ?? null,
              expected: summary.totals_validation.expected ?? null,
              total: summary.totals_validation.total ?? null,
              drift: summary.totals_validation.drift ?? null,
              strategy: summary.totals_validation.strategy ?? null,
              basis: summary.totals_validation.basis ?? null
            }
          : null,
        totals_reread: summary?.totals_reread && typeof summary.totals_reread === 'object'
          ? {
              attempted: Boolean(summary.totals_reread.attempted),
              outcome: summary.totals_reread.outcome ?? null,
              reason: summary.totals_reread.reason ?? null,
              extractor: summary.totals_reread.extractor ?? null,
              model: summary.totals_reread.model ?? null
            }
          : null,
        totals_lane: totalsLane,
        ...(totalsJev ? { jev_first: totalsJev } : {}),
        totals_owner_ask_id: totalsOwnerAskId
      }
    });
    // Reconciliation PR 2 — semantic-classifier audit. Emitted once
    // per classified receipt (success OR fallback). Skipped when the
    // classifier did not run (flag off, extraction failed before the
    // worker invoked it, or non-receipt parse) — detected via the
    // absence of `nextSummary.semantic`. Metadata is IDs + fixed-enum
    // labels + bounded numbers only: `merchant_display_name`,
    // `business_purpose_guess`, `needs_human_reason`, and the raw
    // vendor name are deliberately NOT in the audit so the
    // PII-discipline mirror with `document.parse.completed` holds.
    const semantic = nextSummary.semantic;
    if (semantic && typeof semantic === 'object') {
      await audit(client, {
        firmId,
        clientId,
        documentId,
        action: 'document.classifier.completed',
        metadata: {
          parse_run_id: parseRunId,
          classifier_version: semantic.classifier_version || null,
          prompt_version: semantic.prompt_version || null,
          provider: semantic.provider || null,
          expense_kind: semantic.expense_kind || null,
          tax_sensitivity: semantic.tax_sensitivity || null,
          materiality_risk: semantic.materiality_risk || null,
          confidence:
            typeof semantic.confidence === 'number' ? semantic.confidence : null,
          evidence_sufficient_signal: Boolean(semantic.evidence_sufficient_signal),
          used_fallback: Boolean(semantic.used_fallback),
          fallback_reason: semantic.fallback_reason || null,
          warnings: Array.isArray(semantic.warnings) ? semantic.warnings : []
        }
      });
    }
    // Merge-specific audit. Counts only — no PII (no descriptions, no
    // account_code values). Skipped when nothing changed (PR 1 / lines
    // disabled callers pass empty input and there's no existing state).
    if (mergeStats.kept || mergeStats.refreshed || mergeStats.inserted ||
        mergeStats.deletedOrphans || mergeStats.keptOrphans) {
      await audit(client, {
        firmId,
        clientId,
        documentId,
        action: 'document.line.merged',
        metadata: {
          parse_run_id: parseRunId,
          kept_count: mergeStats.kept,
          refreshed_count: mergeStats.refreshed,
          inserted_count: mergeStats.inserted,
          deleted_count: mergeStats.deletedOrphans,
          orphaned_count: mergeStats.keptOrphans
        }
      });
    }
    assertExecutionBudgetActive({ client });
    await client.query('commit');
    // Donna Loops Phase 7.1 forward producer (post-commit, no-throw,
    // LOOPS_SHADOW-gated): the parse txn just committed this document's
    // reconciliation verdict above (the receipt/invoice/bill matchers ran
    // inside it). If it came back no_match with no live match, open the gap
    // case now instead of waiting for the sweep. Scoped to this document; a
    // non-reconciled doc type is a no-op (no verdict row to read).
    await onReconciliationRunCompleted({
      client, firmId, clientId,
      targets: [{ targetType: 'document', targetId: documentId }]
    });
    // Slice 3 — a canary+ firm's open questions may have changed; request a fresh
    // strong-LLM ask-batch draft (gated + coalesced inside the producer). Inert at
    // shadow / below canary.
    await onReconcileCompleteRequestAskDraft({ client, firmId, clientId });
    return { handled: true, document: rowToThinParseStatus(updated.rows[0]) };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  }
};

// One whole-book reconciliation pass can take minutes because it deliberately
// evaluates every eligible document with the strong matcher. Upload kicks and
// the minute cron can overlap; a scheduler timeout does not cancel the losing
// HTTP handler, so without single-flight each zombie starts another full scan.
// Coalesce by firm+client, remember one dirty re-run, and let followers return
// immediately. The active promise remains in this map until its underlying
// handler really settles, even if the scheduler stopped awaiting it.
const reconciliationFlights = new Map();

export const __runReconciliationSingleFlight = async ({ key, run } = {}) => {
  if (!key || typeof run !== 'function') {
    throw new Error('reconciliation single-flight requires key + run');
  }
  const existing = reconciliationFlights.get(key);
  if (existing) {
    existing.dirty = true;
    existing.nextRun = run;
    return { coalesced: true, reason: 'reconciliation_already_running' };
  }

  const state = { dirty: false, nextRun: run };
  reconciliationFlights.set(key, state);
  let passes = 1;
  try {
    state.dirty = false;
    let result = await state.nextRun();
    // At most one catch-up pass. Triggers arriving during that pass still
    // coalesce, but cannot keep one HTTP worker alive indefinitely; the
    // minute scheduler provides the next durable opportunity.
    if (state.dirty) {
      const catchUpRun = state.nextRun;
      state.dirty = false;
      result = await catchUpRun();
      passes = 2;
    }
    return passes === 2 && result && typeof result === 'object'
      ? { ...result, coalesced_reruns: 1 }
      : result;
  } finally {
    if (reconciliationFlights.get(key) === state) {
      reconciliationFlights.delete(key);
    }
  }
};

// Bank-statement-side reconciliation trigger. After a bank statement's
// transactions land in the DB, scan all completed documents for the
// same client and re-run the relevant matchers. This makes
// reconciliation order-agnostic: whichever side (document or bank
// statement) arrives second triggers the matching.
//
// Gated by BANK_STATEMENT_MATCHER_ENABLED env var (default off).
// Individual matchers also have their own gates
// (BILL_MATCHER_ENABLED, SALES_INVOICE_MATCHER_ENABLED); the receipt
// matcher has no gate and always runs. When a sub-matcher is disabled
// via its own kill switch, it returns `{ disabled: true, disabled_reason }`
// — the orchestrator logs the suppression and surfaces it in the
// returned `disabled_matchers` array.
//
// Soft-degrades per-document so one matcher failure never blocks the
// rest. Returns truthful counts:
//   - documents_evaluated  : rows the SELECT returned
//   - documents_processed  : rows whose matcher call completed without throwing
//   - match_rows_inserted  : sum of new reconciliation_matches rows
//   - match_rows_refreshed : sum of refreshed (existing row updated) rows
//   - auto_match_eligible  : sum of candidates that passed the auto-match gate
//   - errors               : count of matcher exceptions
//   - disabled_matchers    : list of matcher names that were kill-switched
export const runReconciliationForBankStatementInDb = async ({
  firmId,
  clientId,
  parseRunId = null,
  // Test seam: caller-supplied pg-style client. When set, skips
  // the `withFirmDbClient` borrow so unit tests can use the
  // makeMockClient pattern. Mirrors the convention on
  // updateClientRuleStatusInDb / __writeParsedDocumentExtractionWithClient.
  dbClient = null
} = {}) => {
  const baseStats = () => ({
    documents_evaluated: 0,
    documents_processed: 0,
    match_rows_inserted: 0,
    match_rows_refreshed: 0,
    auto_match_eligible: 0,
    // Rows upgraded from status='suggested' to 'auto_matched' on a
    // re-run. Rolled into match_rows_refreshed for the "did a row
    // land?" question, surfaced separately so the cron observability
    // can distinguish "matcher promoted N stale rows this run" from
    // "matcher inserted N fresh rows."
    auto_match_upgraded: 0,
    errors: 0,
    // Phase C convergence observability — count of amount-bearing bank lines
    // left hanging after the terminal drain, under the STRICT two-terminal
    // definition (CLAUDE.md). RT-13: read off the PERSISTED convergence
    // verdict (transactions.convergence_state, written by the ONE derivation
    // in reconcileConvergenceState.js inside every writer's transaction) —
    // the hand-mirrored SQL count this file carried is deleted, so there is
    // no second implementation of the law to keep in lock-step. A bare credit
    // the drain disposed 'chase_evidence' is hanging until its async owner
    // ask lands; `lines_awaiting_ask` is the subset hanging ONLY for that
    // reason (expected, clears on the next loops_inbox tick). A hang that is
    // NOT awaiting an ask, with the drain enabled, is the real invariant
    // breach worth alarming.
    lines_left_hanging: 0,
    lines_awaiting_ask: 0,
    ask_escalation_deferred: false,
    disabled_matchers: [],
    bank_statement_matcher_disabled: false
  });

  const raw = process?.env?.BANK_STATEMENT_MATCHER_ENABLED;
  const enabled = raw != null &&
    ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
  if (!enabled) {
    const result = baseStats();
    result.bank_statement_matcher_disabled = true;
    console.warn(
      '[bankStatementReconciliation] suppressed — BANK_STATEMENT_MATCHER_ENABLED not enabled',
      { firmId, clientId }
    );
    return result;
  }
  if (!firmId || !clientId) return baseStats();

  const runner = async (client) => {
    const docResult = await client.query(
      `select id, document_type
         from documents
        where firm_id = $1
          and client_id = $2
          and parse_status = 'completed'
          and total_amount is not null
          and duplicate_of is null
          and document_type in (
            'receipt',
            'supplier_bill',
            'sales_invoice',
            'issued_receipt',
            -- Stage 2.8 — Stages 2 and 2.5 added per-doc-type if-else
            -- branches below for payment_account_statement +
            -- payment_confirmation, but missed this SQL filter. The
            -- branches were unreachable: this query excluded those
            -- types from docResult.rows entirely, so the symmetric
            -- "bank statement arrives AFTER the doc" re-match path
            -- never fired for them. Without this, the only way to
            -- match an existing payment_confirmation doc was to
            -- re-upload it; the reconcile cron couldn't backfill.
            'payment_account_statement',
            'payment_confirmation',
            -- RT-18 — the payout / deposit-slip family (audit F-04 part 2):
            -- the NET payout matched to the money_in line by
            -- payoutReconciliationLlm.js. Listed here so the symmetric
            -- "bank statement arrives AFTER the payout" path re-matches
            -- it — the Stage 2.8 lesson applied at birth.
            'payout_statement',
            'deposit_slip'
          )`,
      [firmId, clientId]
    );

    const stats = baseStats();
    const loggedDisabled = new Set();
    const accumulate = (matcherStats) => {
      if (!matcherStats || typeof matcherStats !== 'object') return;
      // Stage 2.7 — matchers that promote tier 1 to auto_matched track
      // those rows in a separate counter (auto_match_inserted /
      // auto_match_refreshed). Roll both into the "row landed" tally
      // — the rollup question is "did a row land?", not "did it land
      // as suggested?".
      stats.match_rows_inserted += Number(matcherStats.suggested_inserted || 0)
        + Number(matcherStats.auto_match_inserted || 0);
      stats.match_rows_refreshed += Number(matcherStats.suggested_refreshed || 0)
        + Number(matcherStats.auto_match_refreshed || 0)
        + Number(matcherStats.auto_match_upgraded || 0);
      stats.auto_match_eligible += Number(matcherStats.auto_match_eligible || 0);
      stats.auto_match_upgraded += Number(matcherStats.auto_match_upgraded || 0);
    };
    const noteDisabled = (matcherName, matcherStats) => {
      if (!matcherStats?.disabled) return;
      if (!loggedDisabled.has(matcherName)) {
        console.warn(
          `[bankStatementReconciliation] ${matcherName} suppressed`,
          { reason: matcherStats.disabled_reason || 'unknown', firmId, clientId }
        );
        loggedDisabled.add(matcherName);
      }
      if (!stats.disabled_matchers.includes(matcherName)) {
        stats.disabled_matchers.push(matcherName);
      }
    };

    // Did the matcher loop touch a row? Drives the autoCategorize call
    // after the loop — when nothing matched, autoCategorize would
    // re-scan an unchanged review_queue for no benefit, so we skip it.
    let matchActivity = 0;
    // Phase 7.1: collect every document this matcher loop evaluates so the
    // forward producer can open a gap case for any that came back no_match —
    // fired post-commit after the loop (see below).
    const evaluatedTargets = [];
    for (const doc of docResult.rows) {
      stats.documents_evaluated += 1;
      try {
        if (doc.document_type === 'receipt') {
          const r = await runReceiptReconciliationForDocument({ client, firmId, clientId, documentId: doc.id });
          noteDisabled('receipt', r);
          accumulate(r);
          await autoExplainReceiptForDocument({ client, firmId, clientId, documentId: doc.id, parseRunId });
        } else if (doc.document_type === 'sales_invoice' || doc.document_type === 'issued_receipt') {
          const r = await runSalesInvoiceReconciliationForDocument({ client, firmId, clientId, documentId: doc.id });
          noteDisabled('sales_invoice', r);
          accumulate(r);
          await autoExplainSalesInvoiceForDocument({ client, firmId, clientId, documentId: doc.id, parseRunId });
        } else if (doc.document_type === 'supplier_bill') {
          const r = await runBillReconciliationForDocument({ client, firmId, clientId, documentId: doc.id });
          noteDisabled('supplier_bill', r);
          accumulate(r);
          await autoExplainBillForDocument({ client, firmId, clientId, documentId: doc.id, parseRunId });
        } else if (doc.document_type === 'payment_account_statement') {
          // Stage 2: symmetric path so a bank statement arriving AFTER
          // the payment_account_statement doc still re-runs the
          // matcher. No auto-explain in this stage.
          const r = await runPaymentAccountStatementReconciliationForDocument({ client, firmId, clientId, documentId: doc.id });
          noteDisabled('payment_account_statement', r);
          accumulate(r);
        } else if (doc.document_type === 'payment_confirmation') {
          // Stage 2.5: symmetric path so a bank statement arriving
          // AFTER the payment_confirmation doc still re-runs the
          // matcher. No auto-explain.
          const r = await runPaymentConfirmationReconciliationForDocument({ client, firmId, clientId, documentId: doc.id });
          noteDisabled('payment_confirmation', r);
          accumulate(r);
        } else if (doc.document_type === 'payout_statement' || doc.document_type === 'deposit_slip') {
          // RT-18: the payout / deposit-slip family — the NET settlement
          // against the money_in feed (authorizeMatch gates unchanged). No
          // auto-explain: a payout with no bank line is awaiting its
          // statement, never explained away.
          const r = await runPayoutReconciliationForDocument({ client, firmId, clientId, documentId: doc.id });
          noteDisabled('payout_statement', r);
          accumulate(r);
        }
        stats.documents_processed += 1;
        evaluatedTargets.push({ targetType: 'document', targetId: doc.id });
      } catch (error) {
        stats.errors += 1;
        console.error(
          `[bankStatementReconciliation] matcher threw for ${doc.document_type} doc ${doc.id} — continuing`,
          { documentId: doc.id, error: error?.message || String(error) }
        );
      }
    }

    matchActivity = stats.match_rows_inserted + stats.match_rows_refreshed;

    // After the matcher loop creates / refreshes matches, derive
    // category + account from the matched docs' vendor → CoA mapping.
    // Pre-this-change, the categorisation only ran on the bank-
    // statement parse-completion path (parseDocument.js:1167), so the
    // parse-cron `task=reconcile` backfill — and any doc that landed
    // BEFORE the matcher flag was on — got `MATCHED · AUTO` chips but
    // kept whatever category the AI fallback had assigned (Honeybee's
    // IRS row read `taxes_fees · AI` even though the matched doc was
    // clearly a tax payment). Sharing the orchestrator's client keeps
    // this on a single connection.
    if (matchActivity > 0) {
      try {
        await autoCategorizeMatchedTransactionsInDb({
          firmId,
          clientId,
          dbClient: client
        });
      } catch (categErr) {
        // Soft-degrade: a categorisation failure shouldn't unwind the
        // reconciliation work the orchestrator just completed.
        console.error(
          '[bankStatementReconciliation] autoCategorize threw — matches were created, categorisation skipped',
          { firmId, clientId, error: categErr?.message || String(categErr) }
        );
      }
    }

    // 2026-06-23 — TERMINAL DRAIN. Before opening gaps, dispose every bare
    // bank line the document matchers left unmatched (both directions) so a
    // revenue/expense line can't exit the loop hanging at 'suggested': the
    // strong model settles it (auto_explain) or writes a no_match verdict the
    // forward producer below turns into a client ask. Gated canary+ (inert at
    // shadow); soft-degrades (the sweep itself never throws). Its disposed
    // transaction targets join evaluatedTargets so the ONE
    // onReconciliationRunCompleted pass opens their gaps alongside the docs'.
    let drain = null;
    try {
      drain = await runReconciliationTerminalDrain({ client, firmId, clientId, challengerWithClient: withFirmDbClient });
      for (const target of (drain?.targets || [])) evaluatedTargets.push(target);
    } catch (drainErr) {
      console.error(
        '[bankStatementReconciliation] terminal drain threw — bare-line gaps/asks skipped this run',
        { firmId, clientId, error: drainErr?.message || String(drainErr) }
      );
    }

    // Donna Loops Phase 7.1 forward producer (post-commit, no-throw,
    // LOOPS_SHADOW-gated): every document this loop evaluated — plus every
    // bare line the drain just disposed — may carry a fresh no_match verdict
    // now that the matchers have committed. Open the gap case for any
    // unmatched one immediately rather than waiting for the sweep. Runs after
    // the loop on the orchestrator connection (no open txn).
    await onReconciliationRunCompleted({ client, firmId, clientId, targets: evaluatedTargets });
    // Slice 3 — request a fresh strong-LLM ask-batch draft now that this run's verdicts
    // committed (gated to canary+ and coalesced inside the producer). Inert otherwise.
    // The producer may DEFER the draft (parse-quiescence canary) when the client still has
    // documents parsing — escalating to the owner while a substantiating receipt is still
    // in flight is the forbidden third state; the deferral is honoured by the convergence
    // check below so a deliberately-held run is not mis-alarmed as an invariant breach.
    const askDraftResult = await onReconcileCompleteRequestAskDraft({ client, firmId, clientId });
    const askEscalationDeferred = askDraftResult?.reason === 'deferred_pending_parse_quiescence';
    if (askEscalationDeferred) stats.ask_escalation_deferred = true;

    // CONVERGENCE CHECK (the loop's invariant, made observable). After the
    // drain + gap/ask producers, every amount-bearing bank line should be
    // TERMINAL under the two-terminal principle (CLAUDE.md): auto-reconciled
    // (a settled+coded match, an auto_explain, an applied coding) or on the
    // owner (an open client_evidence_request). Everything else is HANGING —
    // a bare or materiality-held 'suggested' match, a needs_human /
    // chase_receipt verdict whose owner ask never landed, a cascade that
    // never landed, an answered ask nobody processed. RT-13: that law is no
    // longer re-implemented here in SQL — it is DERIVED ONCE
    // (reconcileConvergenceState.js deriveConvergenceState) and PERSISTED on
    // transactions.convergence_state by every writer's transaction, so this
    // check reads the column. `awaiting_ask` is the subset hanging ONLY
    // because a 'chase_evidence' disposition is queued but the async ask has
    // not landed yet (expected; clears on the next loops_inbox tick). This is
    // observability, not a hard stop: alarm LOUDLY only on a hang that is NOT
    // merely awaiting an ask (and only when the drain actually executed, so a
    // shadow firm's expected backlog doesn't cry wolf) so a real regression of
    // "nothing left hanging" is visible, never silent — and the routine
    // post-drain "ask is in flight" gap never manufactures a false alarm.
    try {
      // RT-13 — settle this run's marks first (the matchers and the drain
      // above changed inputs on this connection, transactional or not), then
      // count the persisted column. `disposition:chase_evidence` is the one
      // hanging reason that means "an owner ask is queued but not landed".
      const settledProjection = await settleConvergenceForRead(client, { firmId, clientId, scope: 'all' });
      if (settledProjection.projection_freshness) {
        stats.projection_freshness=settledProjection.projection_freshness;
        stats.converged=false; stats.accounting_ready=false;
      }
      const { evaluateRetainedProcessingScopeWithClient } = await import('./runtimeReadinessAdmission.js');
      const processingScope = await evaluateRetainedProcessingScopeWithClient({ client,firmId,clientId,lock:false });
      if (processingScope.enforced) {
        const pending = await client.query('select count(distinct (target_type,target_id))::int AS n from convergence_marks where firm_id=$1 and client_id=$2',[firmId,clientId]);
        const pendingTargets = Number(pending.rows[0]?.n || 0);
        stats.accounting_ready=false; stats.converged=false;
        stats.projection_freshness = {
          status: processingScope.reason_code !== 'processing_review_only' || pendingTargets || settledProjection.projection_freshness ? 'incomplete' : 'current',
          reason: processingScope.reason_code !== 'processing_review_only' ? processingScope.reason_code
            : pendingTargets || settledProjection.projection_freshness ? 'pending_convergence' : null,
          pending_targets: pendingTargets
        };
      }
      const hangingRes = await client.query(
        `select
            count(*) filter (where convergence_state = 'hanging')::int as hanging,
            count(*) filter (where convergence_state = 'hanging'
                               and convergence_reason = 'disposition:chase_evidence')::int as awaiting_ask
           from transactions
          where firm_id = $1
            and client_id = $2
            and (coalesce(money_in, 0) > 0 or coalesce(money_out, 0) > 0)`,
        [firmId, clientId]
      );
      stats.lines_left_hanging = Number(hangingRes.rows?.[0]?.hanging || 0);
      stats.lines_awaiting_ask = Number(hangingRes.rows?.[0]?.awaiting_ask || 0);
      // A hang that is NOT merely awaiting an in-flight ask is the real breach.
      // Post-E2 a materiality-held line with no covering authority is included
      // in `hanging` (the firm-ask rescue is retired), so it correctly counts
      // toward truly-stuck — surfaced, never laundered as a bounded transition.
      const trulyStuck = stats.lines_left_hanging - stats.lines_awaiting_ask;
      if (askEscalationDeferred && stats.lines_left_hanging > 0) {
        // NOT a breach: the ask escalation was deliberately HELD this run because the client
        // still has documents parsing (the parse-quiescence gate). These lines re-evaluate —
        // binding a late receipt or asking — when the queue drains and reconcile re-runs. The
        // deferral takes precedence over the breach alarm so a mass-upload-in-progress doesn't
        // cry wolf on a transient, expected hang.
        console.log(
          '[bankStatementReconciliation] convergence: ask escalation deferred pending parse quiescence',
          {
            firmId,
            clientId,
            lines_left_hanging: stats.lines_left_hanging,
            lines_awaiting_ask: stats.lines_awaiting_ask
          }
        );
      } else if (drain && drain.disabled === false && trulyStuck > 0) {
        console.warn(
          '[bankStatementReconciliation] convergence: bank lines still hanging after the drain — invariant breached',
          {
            firmId,
            clientId,
            lines_left_hanging: stats.lines_left_hanging,
            lines_awaiting_ask: stats.lines_awaiting_ask,
            truly_stuck: trulyStuck
          }
        );
      } else if (drain && drain.disabled === false && stats.lines_awaiting_ask > 0) {
        // Expected, not a breach: 'chase_evidence' asks queued, clearing on the
        // next loops_inbox tick.
        console.log(
          '[bankStatementReconciliation] convergence: lines awaiting a queued ask',
          {
            firmId,
            clientId,
            lines_awaiting_ask: stats.lines_awaiting_ask
          }
        );
      }
    } catch (convErr) {
      // The convergence read is observability; a failure here must never
      // unwind a reconcile run that otherwise committed.
      console.error(
        '[bankStatementReconciliation] convergence check failed (non-fatal)',
        { firmId, clientId, error: convErr?.message || String(convErr) }
      );
    }

    return stats;
  };

  if (dbClient) return runner(dbClient);
  return __runReconciliationSingleFlight({
    key: `${firmId}:${clientId}`,
    run: () => withFirmDbClient(runner)
  });
};

// Test seam: drive the bank-statement reconciliation orchestrator
// with a caller-supplied pg-style client. Mirrors
// `__writeParsedDocumentExtractionWithClient`.
export const __runReconciliationForBankStatementInDbWithClient = async (args) =>
  runReconciliationForBankStatementInDb(args);

// Leak C resolver — render the matched line's PERSISTED strong-coder verdict
// (payload.ai_suggestion) onto an active chart-of-accounts entry. The strong
// coder (firmDb.suggestTransactionCodingInDb → suggestTransactionCoding) codes
// a matched bank line FROM its matched document into ai_suggestion, so this is
// "code the account from the matched document" (CLAUDE.md: render the persisted
// verdict, not the legacy heuristic). Returns null — leaving the line surfaced
// as hanging — unless the verdict names a REAL account in the client's chart
// and is not a Suspense/unknown placeholder or an explicit low-confidence
// guess. A verdict that doesn't resolve is an upstream coder/CoA gap, NOT
// something to paper over by inventing an account (CLAUDE.md: chart-of-accounts
// resolution at write-back; confident ⇒ auto-reconcile, unsure ⇒ stays open).
const STRONG_VERDICT_SKIP_ACCOUNTS = new Set(['', 'suspense', 'unknown', 'uncategorized', 'uncategorised']);
const resolveStrongCoderVerdictAccount = (verdict, accounts) => {
  if (!verdict || typeof verdict !== 'object' || !Array.isArray(accounts) || !accounts.length) return null;
  if (String(verdict.confidence || '').trim().toLowerCase() === 'low') return null;
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const proposedName = norm(verdict.proposed_account);
  const proposedCode = norm(verdict.account_code);
  if (STRONG_VERDICT_SKIP_ACCOUNTS.has(proposedName) && !proposedCode) return null;
  const match = accounts.find((a) => {
    const name = norm(a.name || a.account_name);
    const code = norm(a.code);
    return (proposedCode && code && code === proposedCode)
      || (proposedName && name && name === proposedName)
      || (proposedName && code && code === proposedName);
  });
  if (!match) return null;
  return {
    name: match.name || match.account_name,
    code: match.code || null,
    confidence: verdict.confidence ?? 'high'
  };
};

// Mint-from-verdict canary (2026-06-25). The strong coder picks `proposed_account`
// from a WIDE menu — the registered country vocabulary UNIONed with the
// client's ledger_accounts — but resolveStrongCoderVerdictAccount above resolves only
// against ledger_accounts. For an infant chart (Honeybee's was a single row) a
// confident verdict like "Office expenses" is therefore pickable but unresolvable, so
// the matched line falls to Suspense even though the coder was right. This canary lets
// autoCategorize MINT the verdict-named account (the ledger_accounts header already
// promises the chart grows from verdicts) and post — confident ⇒ auto-reconcile.
// Fail-closed; client-scoped; NEVER widen by deleting the _CLIENTS allowlist while the
// flag is on. Only RECOGNIZED standard-vocabulary accounts are mintable — a name
// outside the vocabulary is a real gap (or a hallucination) and is left to surface.
// 0A.7: shared flag key so the env master var and the config-plane DB flag_key can never
// drift (mirrors EXACT_MATCH_BACKSTOP_FLAG_KEY). This env predicate is now the FALLBACK
// behind clientFlagActs — autoCategorizeMatchedTransactionsInDb passes
// () => mintVerdictAccountAllows(clientId) as envFallback, so a client with no
// client_capability_config row keeps exactly this behaviour.
export const MINT_VERDICT_ACCOUNT_FLAG_KEY = 'RECONCILIATION_MINT_VERDICT_ACCOUNT';
const mintVerdictAccountAllows = (clientId, env = process.env) => {
  const flag = String(env?.[MINT_VERDICT_ACCOUNT_FLAG_KEY] ?? '').trim().toLowerCase();
  if (!(flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes')) return false;
  const raw = env?.[`${MINT_VERDICT_ACCOUNT_FLAG_KEY}_CLIENTS`];
  const allow = raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!allow || !allow.length) return true; // flag on, no allowlist → every client
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// Render-the-persisted-verdict coding canary (RECONCILIATION_CODE_MATCHED_NO_REVIEW
// (+ _CLIENTS)). When ON, autoCategorize ALSO codes a STRONG terminal matched line
// (auto_matched/confirmed) that has NO open transaction-typed review row — so a
// confident match's persisted verdict is no longer gated on the racy legacy
// transaction_intel "unmatched" review artifact (refreshTransactionIntelForClient in
// firmDb.js deletes + regenerates those rows every run). Without this a strong
// auto_matched line whose legacy row was already cleared never enters the inner-join
// work-list and sticks at Suspense despite a resolvable verdict — the Honeybee Mann
// Lake $159.39 case (band=auto_matched, source=receipt_reconciliation_llm, verdict
// "Office expenses"). See CLAUDE.md "render the persisted verdict, not the legacy
// layer". Fail-closed, client-scoped; mirrors mintVerdictAccountAllows exactly. NEVER
// widen by deleting the _CLIENTS allowlist while the flag is on.
// 0A.7: shared flag key (see MINT_VERDICT_ACCOUNT_FLAG_KEY). Fallback behind clientFlagActs.
export const CODE_MATCHED_NO_REVIEW_FLAG_KEY = 'RECONCILIATION_CODE_MATCHED_NO_REVIEW';
const codeMatchedNoReviewAllows = (clientId, env = process.env) => {
  const flag = String(env?.[CODE_MATCHED_NO_REVIEW_FLAG_KEY] ?? '').trim().toLowerCase();
  if (!(flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes')) return false;
  const raw = env?.[`${CODE_MATCHED_NO_REVIEW_FLAG_KEY}_CLIENTS`];
  const allow = raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!allow || !allow.length) return true; // flag on, no allowlist → every client
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// Code-less vendor-coding fallback canary (RECONCILIATION_VENDOR_CODELESS_FALLBACK
// (+ _CLIENTS)). The vendor-signal branch below writes account_code =
// suggestion.account.code, with NO fallback to the account NAME. When the matched
// account is CODE-LESS (a verdict-grown / minted ledger row — code IS NULL),
// suggestion.account.code is null, so applyMatchedCategorization's
// `coalesce($3, account_code)` KEEPS the prior Suspense while still stamping
// auto_categorize_source=vendor_signal: the line reads MATCHED·AUTO in the chip but
// rests at Suspense in account_code — a two-terminal-states VIOLATION (neither
// auto-reconciled nor on the owner). The Leak C / verdict branch already mirrors
// `resolved.code || resolved.name` for exactly this code-less case; this canary brings
// the vendor branch in line. The Honeybee AMEX EPAYMENT ACH lines are the live case
// (vendor-signal → code-less "Credit card payable - American Express"). When ON, the
// vendor branch falls back to the account NAME for a code-less account so the line
// leaves Suspense to its real (liability) account. Fail-closed, client-scoped; mirrors
// codeMatchedNoReviewAllows exactly. See CLAUDE.md "render the persisted verdict".
// 0A.7: shared flag key (see MINT_VERDICT_ACCOUNT_FLAG_KEY). Fallback behind clientFlagActs.
export const VENDOR_CODELESS_FALLBACK_FLAG_KEY = 'RECONCILIATION_VENDOR_CODELESS_FALLBACK';
const vendorCodelessFallbackAllows = (clientId, env = process.env) => {
  const flag = String(env?.[VENDOR_CODELESS_FALLBACK_FLAG_KEY] ?? '').trim().toLowerCase();
  if (!(flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes')) return false;
  const raw = env?.[`${VENDOR_CODELESS_FALLBACK_FLAG_KEY}_CLIENTS`];
  const allow = raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!allow || !allow.length) return true; // flag on, no allowlist → every client
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// RT-16: the applied-coding review_state COLUMN-sync canary
// (RECONCILIATION_APPLIED_REVIEW_STATE_SYNC + _CLIENTS, 0A.7) is DELETED —
// terminal state (1) of the flags rail: the desync it papered over (a queue
// row's column at 'suggested' while its payload said 'accepted') cannot
// exist any more, because the queue row carries no coding state at all and
// applyMatchedCategorization writes the transaction's own coding_state
// unconditionally. See codingState.js.

// A verdict is eligible to MINT a new chart account only when it is HIGH confidence
// (a chart-of-accounts action deserves the strongest signal — stricter than the
// non-low bar resolveStrongCoderVerdictAccount applies to EXISTING accounts) and names
// a recognized standard-vocabulary account that is not a Suspense/unknown placeholder.
// Pure; exported for tests.
export const shouldMintVerdictAccount = (verdict, policy) => {
  if (!verdict || typeof verdict !== 'object') return false;
  if (String(verdict.confidence || '').trim().toLowerCase() !== 'high') return false;
  const name = String(verdict.proposed_account || '').trim().toLowerCase();
  if (!name || STRONG_VERDICT_SKIP_ACCOUNTS.has(name)) return false;
  return Array.isArray(policy?.accountOptions) && policy.accountOptions.some((option) => String(option).trim().toLowerCase() === name);
};

// Class for a freshly-minted account, inferred from the bank line's DIRECTION so the
// ledger row gets the right normal balance (outflow → expense/debit, inflow →
// revenue/credit — the load-bearing posting property). The firm can refine the exact
// type later. Pure; exported for tests.
export const verdictAccountClassForLine = (txPayload = {}) => {
  if (Number(txPayload?.money_out || 0) > 0) return 'expense';
  if (Number(txPayload?.money_in || 0) > 0) return 'revenue';
  return 'unknown';
};

// After reconciliation matches are created, auto-categorize and
// auto-accept matched transactions. Uses the matched document's
// vendor_name + the client's chart of accounts (ledger_accounts) to
// suggest an account code, then updates the review item payload so
// the bank feed shows the real category instead of "unknown/Suspense"
// and marks the item accepted.
//
// `dbClient` is a test seam (mirrors the convention on
// __runReconciliationForBankStatementInDbWithClient): when set we
// reuse the caller's connection instead of borrowing a new one. The
// orchestrator + each per-doc-type parse-completion site now call
// this with their existing client so the categorisation step shares
// the matcher's connection — no extra pool acquire per match.
export const autoCategorizeMatchedTransactionsInDb = async ({
  firmId,
  clientId,
  dbClient = null,
  inTransaction = false
} = {}) => {
  if (!firmId || !clientId) return { categorized: 0, errors: 0 };

  const runner = async (client) => {
    const accountsResult = await client.query(
      `select id, code, name, account_type
         from ledger_accounts
        where firm_id = $1 and client_id = $2
          and status = 'active'`,
      [firmId, clientId]
    );
    const accounts = accountsResult.rows;
    if (!accounts.length) return { categorized: 0, errors: 0 };

    // 0A.7 — config control plane shim. Resolve the per-client config snapshot ONCE per
    // run, here (after the empty-chart early-exit, so the no-accounts path adds no read and
    // the `calls.length === 1` exit is preserved). One shared snapshot serves all four
    // GATE-whole flags that fire below (mint-verdict / code-matched-no-review / vendor-
    // codeless / applied-review-state-sync) — they all live in THIS one run, with client /
    // firmId / clientId in scope. A DB row for this client ⇒ its stage decides (empty=∅,
    // fail-closed); no row ⇒ each flag's OWN env predicate (envFallback), byte-identical to
    // pre-0A.7. readClientConfigSnapshot soft-fails to {} so a missing table degrades to
    // env, never throws inside a reconcile run.
    const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
    if (clientFlagActs({ flagKey: 'JEV_RECONCILIATION', snapshot: configSnapshot, envFallback: () => false })) {
      return { categorized: 0, errors: 0, decision_engine: 'jev', reason: 'jev_coding_owns_decision' };
    }
    const mintVerdictAccountActs = clientFlagActs({
      flagKey: MINT_VERDICT_ACCOUNT_FLAG_KEY,
      snapshot: configSnapshot,
      envFallback: () => mintVerdictAccountAllows(clientId)
    });
    const codeMatchedNoReviewActs = clientFlagActs({
      flagKey: CODE_MATCHED_NO_REVIEW_FLAG_KEY,
      snapshot: configSnapshot,
      envFallback: () => codeMatchedNoReviewAllows(clientId)
    });
    const vendorCodelessFallbackActs = clientFlagActs({
      flagKey: VENDOR_CODELESS_FALLBACK_FLAG_KEY,
      snapshot: configSnapshot,
      envFallback: () => vendorCodelessFallbackAllows(clientId)
    });

    // Open review items that have a reconciliation match
    const itemsResult = await client.query(
      `select q.id as review_id, q.payload as review_payload,
              q.item_id as transaction_id,
              m.matched_object_id as document_id,
              d.vendor_name, d.customer_name, d.filename,
              t.description, t.raw_description, t.payload as transaction_payload
         from transaction_review_queue q
         join reconciliation_matches m
           on m.firm_id = q.firm_id
          and m.bank_transaction_id = q.item_id
         join documents d
           on d.firm_id = q.firm_id
          and d.id = m.matched_object_id
         left join transactions t
           on t.firm_id = q.firm_id
          and t.id = q.item_id
        where q.firm_id = $1
          and q.client_id = $2
          and q.status = 'open'
          and q.item_type = 'transaction'`,
      [firmId, clientId]
    );

    const rulesResult = await client.query(
      `select * from client_rules
        where firm_id = $1 and client_id = $2 and status = 'active'`,
      [firmId, clientId]
    );
    const clientRules = rulesResult.rows;

    const stats = { categorized: 0, errors: 0 };

    const applyMatchedCategorization = async (row, patch) => {
      // In the manually admitted AE cashbook, account-only legacy labels must
      // not make a still-uncoded tax-bearing line terminal before the strong coder.
      if (!['client_rule','merchant_lookup'].includes(patch.auto_categorize_source)) {
        const { loadClientTaxFactAutomation } = await import('./db/taxPostingFacts.js');
        const automation = await loadClientTaxFactAutomation({ client, firmId, clientId });
        const aeClient = (await client.query('select * from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0];
        if (automation?.clientEnabled(aeClient, configSnapshot)) return;
      }

      // RT-16: the patch's legacy `review_state` label is the INPUT that says
      // whether this categorisation is a decision ('accepted' → applied) or a
      // proposal ('suggested' → proposed); it never lands in a payload. The
      // case file (when one exists) gets the coding context only.
      const { review_state: legacyLabel, ...casePatch } = patch;
      const nextCodingState = codingStateFromReviewState(legacyLabel) || 'proposed';
      // review_id is null for a matched-but-no-review line surfaced by the
      // render-the-persisted-verdict canary (codeMatchedNoReviewAllows) below —
      // there is no review row to stamp, only the transaction gets coded.
      if (row.review_id) {
        await client.query(
          `update transaction_review_queue
              set payload = payload || $3::jsonb, updated_at = now()
            where firm_id = $1 and id = $2`,
          [firmId, row.review_id, JSON.stringify(casePatch)]
        );
      }
      await client.query(
        `update transactions
            set account_code = coalesce($3, account_code),
                category = coalesce($4, category),
                payload = payload || $5::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2`,
        [
          firmId, row.transaction_id,
          patch.account_code || null,
          patch.category || null,
          JSON.stringify({
            auto_categorize_source: patch.auto_categorize_source,
            auto_categorize_confidence: patch.auto_categorize_confidence,
            matched_client_rule_id: patch.matched_client_rule_id || undefined
          })
        ]
      );
      await applyCodingTransition(client, { firmId, clientId, transactionId: row.transaction_id, to: nextCodingState });
    };

    // Render-the-persisted-verdict (canary, fail-closed). The work-list above is
    // gated on an OPEN transaction-typed review row — owned + regenerated each run by
    // the legacy transaction_intel pass, so a strong terminal match whose legacy
    // "unmatched" row was already cleared is skipped and sticks at Suspense. Pull
    // those matched-but-uncoded lines (auto_matched/confirmed, no open transaction
    // review row) so they code from the SAME branches below (rule → vendor →
    // matched_document_verdict). review_id is null → applyMatchedCategorization writes
    // only the transaction. Restricted to uncoded lines (Suspense/blank) so an
    // already-coded line (incl. a firm correction) is never re-touched. Off →
    // workRows === itemsResult.rows (the canary-off path is byte-identical).
    const workRows = itemsResult.rows.slice();
    if (codeMatchedNoReviewActs) {
      const matchedNoReview = await client.query(
        `select null::text as review_id, null::jsonb as review_payload,
                t.id as transaction_id,
                m.matched_object_id as document_id,
                d.vendor_name, d.customer_name, d.filename,
                t.description, t.raw_description, t.payload as transaction_payload
           from transactions t
           join reconciliation_matches m
             on m.firm_id = t.firm_id
            and m.client_id = t.client_id
            and m.bank_transaction_id = t.id
            and m.status in ('auto_matched', 'confirmed')
           join documents d
             on d.firm_id = t.firm_id
            and d.id = m.matched_object_id
          where t.firm_id = $1
            and t.client_id = $2
            and coalesce(t.account_code, '') in ('', 'Suspense')
            and not exists (
              select 1 from transaction_review_queue q
               where q.firm_id = t.firm_id
                 and q.client_id = t.client_id
                 and q.item_id = t.id
                 and q.item_type = 'transaction'
                 and q.status = 'open'
            )`,
        [firmId, clientId]
      );
      workRows.push(...matchedNoReview.rows);
    }

    for (const row of workRows) {
      let activeTransaction = false;
      const finish = async () => {
        await client.query(inTransaction ? 'release savepoint matched_coding' : 'commit');
        activeTransaction = false;
      };
      try {
        await client.query(inTransaction ? 'savepoint matched_coding' : 'begin');
        activeTransaction = true;
        // A reopened case cannot grant a vendor, rule or old AI permission to
        // change accounting already accepted by a person or posted to a journal.
        const source = (await client.query(
          `select * from transactions where firm_id = $1 and client_id = $2 and id = $3 for update`,
          [firmId, clientId, row.transaction_id]
        )).rows[0];
        if (!source || ['applied', 'held', 'posted', 'synced', 'closed'].includes(source.coding_state)
            || ['posted', 'synced', 'closed'].includes(source.status)) {
          await finish();
          continue;
        }
        // The Finnish strong coder owns both account and evidence requirements.
        // Legacy account-only projection cannot accept its unresolved proposal
        // or move a live owner question back to applied.
        if (source.payload?.ai_suggestion?.coding_policy?.jurisdiction === 'fi') {
          const policy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId,
            businessDate: source.transaction_date, lockContext: true });
          assertCodingPolicyReceipt(policy, source.payload.ai_suggestion.coding_policy);
          await finish();
          continue;
        }
        const txPayload = source.payload || {};
        const txObj = {
          description: source.description,
          raw_description: source.raw_description,
          contact: txPayload.contact || '',
          source_line: txPayload.source_line || ''
        };
        const ruleMatch = clientRules.length ? clientRuleMatchFor(txObj, clientRules) : null;

        if (ruleMatch) {
          const matchedAccount = accounts.find((a) => a.code === ruleMatch.account_code);
          const accountName = matchedAccount?.name || ruleMatch.category || ruleMatch.account_code;
          const accountCode = matchedAccount?.code || ruleMatch.account_code;
          await applyMatchedCategorization(row, {
            proposed_account: accountName,
            category: accountName,
            account_code: accountCode,
            review_state: 'accepted',
            auto_categorized: true,
            auto_categorize_source: 'client_rule',
            auto_categorize_vendor: row.vendor_name || row.customer_name || '',
            auto_categorize_confidence: ruleMatch.confidence,
            matched_client_rule_id: ruleMatch.id,
            matched_client_rule_label: ruleMatch.label
          });
        } else {
          const vendorName = row.vendor_name || row.customer_name || '';
          const bankDesc = source.description || source.raw_description || '';
          const suggestion = suggestAccountForVendor(vendorName, bankDesc, accounts);
          if (suggestion) {
            const accountName = suggestion.account.name || suggestion.account.account_name;
            const accountCode = suggestion.account.code || null;
            // Code-less account fallback (canary): a verdict-grown / minted account has
            // code IS NULL, so a bare accountCode leaves the line at Suspense via
            // coalesce($3, account_code) even though the vendor signal resolved it.
            // Mirror the verdict branch's `code || name` so it leaves Suspense to its
            // real account. Off → byte-identical (writes the null, keeps Suspense).
            const resolvedAccountCode = vendorCodelessFallbackActs
              ? (accountCode || accountName)
              : accountCode;
            await applyMatchedCategorization(row, {
              proposed_account: accountName,
              category: accountName,
              account_code: resolvedAccountCode,
              review_state: 'accepted',
              auto_categorized: true,
              auto_categorize_source: suggestion.source,
              auto_categorize_vendor: vendorName,
              auto_categorize_confidence: suggestion.confidence
            });
          } else {
            // Leak C: the deterministic vendor heuristic only fires when the
            // client's chart-of-accounts NAME literally contains the signal
            // keyword (e.g. a "Fuel" account for a Chevron charge). When the
            // CoA names it differently the heuristic misses and the matched
            // line USED to fall through to Suspense — matched but uncoded, the
            // tri-state leak deriveConvergenceState marks 'hanging'. Instead
            // render the PERSISTED strong-coder verdict (it already coded this
            // line FROM the matched document) and auto-apply it when it names a
            // real account; a matched line is already confident by match
            // status, so applying its document-derived account is the
            // auto-reconcile branch. If there is no resolvable verdict, leave
            // the line uncoded — still surfaced as hanging, never silently
            // ratified — rather than inventing an account.
            // The queue is a case file, never coding authority. Read the current
            // transaction and policy together under locks before minting or applying.
            const sourcePayload = source.payload || {};
            const accepted = sourcePayload.accepted_coding_policy;
            const verdict = accepted ? {
              proposed_account: source.category || source.account_code,
              confidence: 'high'
            } : sourcePayload.ai_suggestion;
            if (!verdict) {
              await finish();
              continue;
            }
            const policy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId,
              businessDate: source.transaction_date, lockContext: true });
            assertCodingPolicyReceipt(policy, accepted || verdict.coding_policy);
            let resolved = resolveStrongCoderVerdictAccount(verdict, accounts);
            let mintedAccount = false;
            let mintedRow = null;
            if (!resolved && mintVerdictAccountActs && shouldMintVerdictAccount(verdict, policy)) {
              const minted = await ensureLedgerAccountFromVerdict({
                client, firmId, clientId,
                missingAccount: {
                  name: verdict.proposed_account,
                  account_type: verdictAccountClassForLine(source),
                  reason: 'auto-minted from a confident matched-line coder verdict'
                },
                sourceTransactionId: row.transaction_id
              });
              if (minted?.accountId) {
                mintedRow = { id: minted.accountId, code: null, name: minted.name, account_type: minted.accountType };
                resolved = { name: minted.name, code: null, confidence: verdict.confidence ?? 'high' };
                mintedAccount = true;
              }
            }
            if (!resolved) {
              await finish();
              continue;
            }
            await applyMatchedCategorization(row, {
              proposed_account: resolved.name, category: resolved.name,
              account_code: resolved.code || resolved.name, review_state: 'accepted',
              auto_categorized: true,
              auto_categorize_source: mintedAccount ? 'minted_verdict_account' : 'matched_document_verdict',
              auto_categorize_vendor: vendorName, auto_categorize_confidence: resolved.confidence
            });
            await recordCodingPolicyRecovery({ client, firmId, clientId,
              transactionIds: [row.transaction_id], policy });
            await finish();
            if (mintedRow) accounts.push(mintedRow);

          }
        }

        if (activeTransaction) await finish();
        stats.categorized += 1;
      } catch (error) {
        if (activeTransaction) {
          await client.query(inTransaction ? 'rollback to savepoint matched_coding' : 'rollback');
          if (inTransaction) await client.query('release savepoint matched_coding');
        }
        if (isCodingPolicyError(error)) await recordCodingPolicyFailure({ client, firmId, clientId,
          transactionIds: [row.transaction_id], error });
        stats.errors += 1;
        console.error(
          '[autoCategorize] failed for review item',
          { reviewId: row.review_id, error: error?.message || String(error) }
        );
      }
    }

    return stats;
  };

  if (dbClient) return runner(dbClient);
  return withFirmDbClient(runner);
};

// Test seam: drive autoCategorizeMatchedTransactionsInDb with a
// caller-supplied pg-style client. Mirrors
// `__runReconciliationForBankStatementInDbWithClient` /
// `__writeParsedDocumentExtractionWithClient`.
export const __autoCategorizeMatchedTransactionsInDbWithClient = async (args) =>
  autoCategorizeMatchedTransactionsInDb(args);

// Auto-categorize UNMATCHED transactions using bank description
// patterns. Runs after reconciliation — picks up transactions that
// didn't get a document match but have recognizable vendor patterns
// in the bank description. Only touches items still in 'open' status
// with no existing category.
export const autoCategorizeUnmatchedTransactionsInDb = async ({
  firmId,
  clientId,
  force = false
} = {}) => {
  if (!firmId || !clientId) return { categorized: 0, errors: 0 };

  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
    if (clientFlagActs({ flagKey: 'JEV_RECONCILIATION', snapshot, envFallback: () => false })) {
      return { categorized: 0, errors: 0, decision_engine: 'jev', reason: 'jev_coding_owns_decision' };
    }
    const accountsResult = await client.query(
      `select id, code, name, account_type
         from ledger_accounts
        where firm_id = $1 and client_id = $2
          and status = 'active'`,
      [firmId, clientId]
    );
    const accounts = accountsResult.rows;
    if (!accounts.length) return { categorized: 0, errors: 0 };

    const itemsResult = await client.query(
      `select q.id as review_id, q.payload as review_payload,
              q.item_id as transaction_id,
              t.description, t.raw_description, t.payload as transaction_payload,
              t.money_in, t.money_out, t.currency
         from transaction_review_queue q
         left join transactions t
           on t.firm_id = q.firm_id
          and t.id = q.item_id
        where q.firm_id = $1
          and q.client_id = $2
          and q.status = 'open'
          and q.item_type = 'transaction'
          and (${force ? 'true' : `(q.payload->>'category' is null
               or q.payload->>'category' = 'unknown')`})
          and not exists (
            select 1 from reconciliation_matches m
             where m.firm_id = q.firm_id
               and m.bank_transaction_id = q.item_id
               and m.status in ('suggested', 'confirmed', 'auto_matched')
          )`,
      [firmId, clientId]
    );

    const rulesResult = await client.query(
      `select * from client_rules
        where firm_id = $1 and client_id = $2 and status = 'active'`,
      [firmId, clientId]
    );
    const clientRules = rulesResult.rows;

    const stats = { categorized: 0, errors: 0, llm_identified: 0, louis_demoted: 0 };
    const needsLlmReview = [];

    const applyCategorization = async (row, patch) => {
      // RT-16: see applyMatchedCategorization — the legacy label is the
      // input, the transaction's coding_state is the state.
      const { review_state: legacyLabel, ...casePatch } = patch;
      const nextCodingState = codingStateFromReviewState(legacyLabel) || 'proposed';
      await client.query(
        `update transaction_review_queue
            set payload = payload || $3::jsonb, updated_at = now()
          where firm_id = $1 and id = $2`,
        [firmId, row.review_id, JSON.stringify(casePatch)]
      );
      await client.query(
        `update transactions
            set account_code = coalesce($3, account_code),
                category = coalesce($4, category),
                payload = payload || $5::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2`,
        [
          firmId, row.transaction_id,
          patch.account_code || null,
          patch.category || null,
          JSON.stringify({
            auto_categorize_source: patch.auto_categorize_source,
            auto_categorize_confidence: patch.auto_categorize_confidence,
            matched_client_rule_id: patch.matched_client_rule_id || undefined
          })
        ]
      );
      await applyCodingTransition(client, { firmId, clientId, transactionId: row.transaction_id, to: nextCodingState });
    };

    // Step 1: Client rules are final — apply immediately.
    for (const row of itemsResult.rows) {
      try {
        const txPayload = row.transaction_payload || {};
        const txObj = {
          description: row.description,
          raw_description: row.raw_description,
          contact: txPayload.contact || '',
          source_line: txPayload.source_line || ''
        };
        const ruleMatch = clientRules.length ? clientRuleMatchFor(txObj, clientRules) : null;

        if (ruleMatch) {
          const matchedAccount = accounts.find((a) => a.code === ruleMatch.account_code);
          const accountName = matchedAccount?.name || ruleMatch.category || ruleMatch.account_code;
          const accountCode = matchedAccount?.code || ruleMatch.account_code;
          await applyCategorization(row, {
            proposed_account: accountName,
            category: accountName,
            account_code: accountCode,
            review_state: 'accepted',
            auto_categorized: true,
            auto_categorize_source: 'client_rule',
            auto_categorize_confidence: ruleMatch.confidence,
            matched_client_rule_id: ruleMatch.id,
            matched_client_rule_label: ruleMatch.label
          });
          stats.categorized += 1;
        } else {
          needsLlmReview.push(row);
        }
      } catch (error) {
        stats.errors += 1;
        console.error(
          '[autoCategorizeUnmatched] failed for review item',
          { reviewId: row.review_id, error: error?.message || String(error) }
        );
      }
    }

    // Step 2: LLM merchant lookup for ALL remaining uncategorized
    // transactions (not just VENDOR_SIGNALS misses). VENDOR_SIGNALS
    // runs as a validation layer after the LLM, not as primary.
    if (isMerchantLookupEnabled() && needsLlmReview.length > 0) {
      try {
        // Phase 0B.1 bridge: resolve + persist the config snapshot ONCE per run, so every
        // coder llm_decisions row below can reference the exact config it ran under. Both
        // calls soft-fail (null) — behaviour-neutral, the receipt is just un-stamped on error.
        const runConfigSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
        const runConfigSnapshotId = await persistConfigSnapshot(client, {
          firmId, clientId, snapshot: runConfigSnapshot
        });

        const clientRow = await client.query(
          'select company_name, profile from clients where firm_id = $1 and id = $2',
          [firmId, clientId]
        );
        const clientName = clientRow.rows[0]?.company_name
          || clientRow.rows[0]?.profile?.companyName || '';
        const clientProfile = clientRow.rows[0]?.profile || {};

        const allMerchants = deduplicateMerchants(needsLlmReview);

        const existingPatterns = new Set(
          (await client.query(
            'select pattern_text from client_rules where firm_id = $1 and client_id = $2',
            [firmId, clientId]
          )).rows.map((r) => r.pattern_text)
        );
        const newMerchants = allMerchants.filter(
          (m) => !existingPatterns.has(m.canonicalPattern)
        );

        if (newMerchants.length > 0) {
          const results = await lookupMerchants({
            merchants: newMerchants,
            accounts,
            clientName
          });

          const rulesByPattern = new Map();
          for (const result of results) {
            const matchedAccount = accounts.find((a) => a.code === result.accountCode);
            const accountName = matchedAccount?.name || result.accountName || result.accountCode;
            const accountCode = matchedAccount?.code || result.accountCode;
            if (!accountCode) continue;

            const ruleId = [
              'client-rule',
              clientId.replace(/[^a-z0-9-]/g, '').slice(0, 64),
              result.canonicalPattern.replace(/[^a-z0-9]/g, '-').slice(0, 64),
              accountCode.replace(/[^a-z0-9]/g, '-').slice(0, 64)
            ].join('-').slice(0, 140);

            await client.query(
              `insert into client_rules (
                 id, firm_id, client_id, rule_type, pattern_text,
                 category_override, account_code, notes, created_by,
                 status, payload
               ) values ($1, $2, $3, 'merchant_category', $4, null, $5, $6, 'ai', 'active', $7::jsonb)
               on conflict (id) do nothing`,
              [
                ruleId, firmId, clientId,
                result.canonicalPattern,
                accountCode,
                `${result.merchantName}: ${result.merchantCategory}`,
                JSON.stringify({
                  source: 'llm_suggested',
                  merchant_name: result.merchantName,
                  merchant_pattern: result.canonicalPattern,
                  merchant_category: result.merchantCategory,
                  account_code: accountCode,
                  account_name: accountName,
                  confidence: result.confidence,
                  reasoning: result.reasoning,
                  label: `${result.merchantName} -> ${accountCode}`,
                  confirmation_count: 0
                })
              ]
            );

            rulesByPattern.set(result.canonicalPattern, {
              ruleId,
              accountName,
              accountCode,
              accountType: matchedAccount?.account_type || '',
              merchantName: result.merchantName,
              confidence: result.confidence,
              confidenceLabel: result.confidenceLabel,
              reasoning: result.reasoning
            });
          }

          // Step 3: Apply LLM results with VENDOR_SIGNALS validation + lane policy
          const apiKey = process.env.ANTHROPIC_API_KEY || '';
          const greenLaneDecisions = [];

          for (const row of needsLlmReview) {
            const desc = row.description || row.raw_description || '';
            const pattern = canonicalMerchantPattern(desc);
            const rule = pattern ? rulesByPattern.get(pattern) : null;
            if (!rule) continue;

            try {
              const vendorSignal = suggestAccountForVendor('', desc, accounts);
              const vendorAgrees = vendorSignal && vendorSignal.account?.code === rule.accountCode;
              const vendorDisagrees = vendorSignal && vendorSignal.account?.code !== rule.accountCode;

              let effectiveConfidence = rule.confidence;
              if (vendorAgrees) effectiveConfidence = Math.min(effectiveConfidence + 0.1, 0.98);

              const laneResult = classifyLane({
                decisionType: 'categorize',
                confidence: { score: effectiveConfidence, label: rule.confidenceLabel || 'medium' },
                signals: {
                  client_rule_match: vendorAgrees,
                  vendor_signal_agrees: vendorAgrees,
                  vendor_signal_disagrees: vendorDisagrees
                },
                accountType: rule.accountType,
                accountName: rule.accountName
              });

              if (laneResult.lane === 'red') {
                await recordLlmDecision({
                  client,
                  firmId,
                  clientId,
                  decisionType: 'categorize',
                  targetType: 'transaction',
                  targetId: row.transaction_id,
                  modelName: 'claude-opus-4-8',
                  deterministicSignals: {
                    vendor_signal: vendorSignal ? vendorSignal.account?.code : null,
                    vendor_signal_agrees: vendorAgrees,
                    vendor_signal_disagrees: vendorDisagrees
                  },
                  confidence: { score: effectiveConfidence, label: rule.confidenceLabel || 'medium' },
                  lane: 'red',
                  policyBlockers: laneResult.blockers,
                  llmReasoning: rule.reasoning,
                  finalState: 'blocked',
                  configSnapshotId: runConfigSnapshotId
                });
                continue;
              }

              let reviewState;
              if (laneResult.lane === 'green') {
                reviewState = 'accepted';
              } else if (vendorDisagrees) {
                reviewState = 'suggested';
              } else {
                reviewState = 'suggested';
              }

              const categorizationSource = vendorAgrees
                ? 'merchant_lookup_vendor_confirmed'
                : vendorDisagrees
                  ? 'merchant_lookup_vendor_conflict'
                  : 'merchant_lookup';

              await applyCategorization(row, {
                proposed_account: rule.accountName,
                category: rule.accountName,
                account_code: rule.accountCode,
                review_state: reviewState,
                auto_categorized: true,
                auto_categorize_source: categorizationSource,
                auto_categorize_confidence: effectiveConfidence,
                auto_categorize_vendor: rule.merchantName,
                auto_categorize_lane: laneResult.lane,
                matched_client_rule_id: rule.ruleId,
                vendor_signal_account: vendorSignal ? vendorSignal.account?.code : null,
                vendor_signal_agrees: vendorAgrees || false
              });

              const decisionId = await recordLlmDecision({
                client,
                firmId,
                clientId,
                decisionType: 'categorize',
                targetType: 'transaction',
                targetId: row.transaction_id,
                modelName: 'claude-opus-4-8',
                deterministicSignals: {
                  vendor_signal: vendorSignal ? vendorSignal.account?.code : null,
                  vendor_signal_agrees: vendorAgrees,
                  vendor_signal_disagrees: vendorDisagrees
                },
                confidence: { score: effectiveConfidence, label: rule.confidenceLabel || 'medium' },
                lane: laneResult.lane,
                policyBlockers: laneResult.blockers,
                llmReasoning: rule.reasoning,
                finalState: reviewState === 'accepted' ? 'auto_applied' : 'suggested',
                configSnapshotId: runConfigSnapshotId
              });

              if (laneResult.lane === 'green') {
                greenLaneDecisions.push({
                  decisionId,
                  row,
                  rule,
                  effectiveConfidence,
                  vendorAgrees
                });
              }

              stats.llm_identified += 1;
            } catch (error) {
              stats.errors += 1;
            }
          }

          // Step 4: Louis QA on green-lane categorizations
          for (const gld of greenLaneDecisions) {
            try {
              const louisResult = await evaluatePipelineDecision({
                decision: {
                  decision_type: 'categorize',
                  target_type: 'transaction',
                  target_id: gld.row.transaction_id,
                  lane: 'green',
                  confidence: { score: gld.effectiveConfidence },
                  deterministic_signals: { vendor_signal_agrees: gld.vendorAgrees },
                  llm_reasoning: gld.rule.reasoning
                },
                transaction: {
                  description: gld.row.description,
                  raw_description: gld.row.raw_description,
                  money_in: gld.row.money_in,
                  money_out: gld.row.money_out,
                  currency: gld.row.currency,
                  account_name: gld.rule.accountName,
                  account_code: gld.rule.accountCode
                },
                chartOfAccounts: accounts,
                clientProfile,
                apiKey
              });

              if (louisResult) {
                await recordLouisVerdict({ client, decisionId: gld.decisionId, verdict: louisResult });

                if (louisResult.verdict === 'fail') {
                  await applyCategorization(gld.row, {
                    proposed_account: gld.rule.accountName,
                    category: gld.rule.accountName,
                    account_code: gld.rule.accountCode,
                    review_state: 'suggested',
                    auto_categorized: true,
                    auto_categorize_source: 'merchant_lookup_louis_demoted',
                    auto_categorize_confidence: gld.effectiveConfidence,
                    auto_categorize_vendor: gld.rule.merchantName,
                    auto_categorize_lane: 'yellow',
                    matched_client_rule_id: gld.rule.ruleId
                  });
                  stats.louis_demoted += 1;
                }
              }
            } catch (louisError) {
              console.error(
                '[autoCategorizeUnmatched] Louis QA failed (non-blocking)',
                { decisionId: gld.decisionId, error: louisError?.message || String(louisError) }
              );
            }
          }
        }
      } catch (error) {
        console.error(
          '[autoCategorizeUnmatched] LLM merchant lookup failed (soft-degrade)',
          { error: error?.message || String(error) }
        );
      }
    }

    return stats;
  });
};

export const writeParsedDocumentExtractionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  documentId,
  parseRunId,
  header,
  summary,
  // PR 2: receipt extractor returns lines[]. The writer wipes any
  // pre-existing rows for the doc and inserts the new set inside the
  // same transaction as the documents UPDATE — so the parse_run_id
  // gate covers the whole write. PR 1 callers (and the
  // DOCUMENT_LINES_ENABLED=false code path) pass [].
  lines = [],
  // Authoritative router output, when present, drives the row's
  // final document_type. null preserves the existing column value.
  documentType = null,
  // Direction (incoming / outgoing / internal / unknown) derived from
  // documentType in the caller. null preserves the existing value.
  direction = null,
  postingTaxRepair = null,
  materialRecovery = null
} = {}) => {
  if (!firmId || !documentId || !parseRunId) {
    return { handled: false, reason: 'missing_fields' };
  }
  if (postingTaxRepair) {
    const { client, clientId, transactionId, expectedTax, taxAmount, receipt } = postingTaxRepair;
    if (!client || !Number.isFinite(taxAmount) || taxAmount < 0 || !receipt?.model || receipt?.review?.source_verified !== true) {
      throw Object.assign(new Error('A verified extraction is required for source tax repair.'), { code: 'POSTING_SOURCE_REPAIR_INVALID' });
    }
    // Called within recovery's admitted transaction and document/transaction locks.
    // Preserve line ids, matching and human corrections. This is a tax header
    // extraction repair only, never a change to the source total or tax law.
    const linked=await client.query(`select t.id from transactions t where t.firm_id=$1 and t.client_id=$2
      and (t.id=$3 or t.document_id=$4 or exists(select 1 from reconciliation_matches m where m.firm_id=$1 and m.client_id=$2 and m.bank_transaction_id=t.id and m.matched_object_id=$4)) order by t.id for update of t nowait`,[firmId,clientId,transactionId,documentId]);
    if(linked.rows.some(row=>row.id!==transactionId)) throw Object.assign(new Error('Shared document source repair needs all affected postings checked.'),{code:'POSTING_SOURCE_REPAIR_SHARED'});
    const held = await client.query(`select id from documents where firm_id=$1 and client_id=$2 and id=$3
      and parse_run_id=$4::uuid and parse_status='completed' and tax_amount is not distinct from $5::numeric
      and not exists(select 1 from document_corrections c where c.firm_id=$1 and c.document_id=$3)
      and not exists(select 1 from ledger_journals j where j.firm_id=$1 and j.client_id=$2
        and (j.source_id=$3 or j.payload #>> '{settlement,document_id}'=$3 or j.source_id in
          (select bank_transaction_id from reconciliation_matches m where m.firm_id=$1 and m.client_id=$2 and m.matched_object_id=$3)))
      for update`, [firmId,clientId,documentId,parseRunId,expectedTax]);
    if(held.rows.length!==1) throw Object.assign(new Error('The source is corrected, posted or changed; automatic tax repair is refused.'),{code:'POSTING_SOURCE_REPAIR_STALE'});
    assertExecutionBudgetActive({ client });
    await client.query(`update documents set tax_amount=$4, parse_summary=coalesce(parse_summary,'{}'::jsonb) || jsonb_build_object('tax_amount',$4::numeric,'posting_tax_recheck',$5::jsonb),updated_at=now()
      where firm_id=$1 and client_id=$2 and id=$3`,[firmId,clientId,documentId,taxAmount,JSON.stringify(receipt)]);
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'system','coding_convergence','document.extraction_tax_repaired','document',$3,$4::jsonb)`,
      [firmId,clientId,documentId,JSON.stringify({prior_value:expectedTax,corrected_value:taxAmount,...receipt})]);
    assertExecutionBudgetActive({ client });
    return {handled:true,tax_repaired:true};
  }
  return withFirmDbClient(async (client) =>
    performWriteParsedDocumentExtraction({
      client,
      firmId,
      documentId,
      parseRunId,
      header,
      summary,
      lines,
      documentType,
      direction,
      materialRecovery
    })
  );
};

// Test seam: drive the writer with a caller-supplied pg-style client.
// Mirrors __resolveDuplicateWithClient / __retryParseRunsWithClient.
export const __writeParsedDocumentExtractionWithClient = async (args) =>
  performWriteParsedDocumentExtraction(args);

// PR 2 of docs/invoice-receipt-parsing-plan.md — firm-side line read.
//
// Returns the document header subset, every `document_lines` row for
// that document (ordered by line_no, with created_at as a deterministic
// tiebreaker for rows the extractor returned without explicit
// numbering), and every open review-queue row of `item_type='document_line'`
// scoped to those lines. PR 3 fills `review_items` from
// `transaction_review_queue` rather than hardcoding []. Cross-firm
// reads are blocked at the API layer by the `getDocumentForParseInDb`
// 404 check before this is called — defence in depth is the firm_id
// predicate below.
export const getDocumentLinesForFirmInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  documentId
} = {}) => {
  if (!firmId || !documentId) return { document: null, lines: [], review_items: [] };
  const docResult = await queryFirmDb(
    `select id, firm_id, client_id, document_type, filename, vendor_name,
            customer_name, document_date, due_date, currency,
            tax_amount, total_amount, payment_status, parse_summary,
            extraction_confidence
       from documents
      where firm_id=$1 and id=$2`,
    [firmId, documentId]
  );
  if (!docResult.rows.length) return { document: null, lines: [], review_items: [] };
  const doc = docResult.rows[0];
  const linesResult = await queryFirmDb(
    `select id, line_no, description, quantity, unit_price, amount,
            tax_rate, fingerprint, account_code, category,
            coding_confidence, coding_source, review_status,
            payload, created_at, updated_at
       from document_lines
      where firm_id=$1 and document_id=$2
      order by line_no asc nulls last, created_at asc`,
    [firmId, documentId]
  );
  const lineIds = linesResult.rows.map((row) => row.id);
  // Open review-queue rows for those lines. We fetch all statuses
  // (not just `open`) so the FE can reason about recently-closed
  // items if it wants to. The default render filters to status='open'.
  const reviewResult = lineIds.length
    ? await queryFirmDb(
        `select id, firm_id, client_id, item_type, item_id, reason,
                priority, status, assigned_to, payload,
                created_at, updated_at
           from transaction_review_queue
          where firm_id=$1
            and item_type='document_line'
            and item_id = any($2::text[])
          order by created_at asc`,
        [firmId, lineIds]
      )
    : { rows: [] };
  return {
    document: {
      id: doc.id,
      client_id: doc.client_id,
      document_type: doc.document_type || null,
      filename: doc.filename || null,
      vendor_name: doc.vendor_name || null,
      customer_name: doc.customer_name || null,
      document_date: doc.document_date || null,
      due_date: doc.due_date || null,
      currency: doc.currency || null,
      // subtotal_amount and the total modifiers live on parse_summary,
      // not their own columns, so surface them from there for the FE
      // renderer. The modifiers are part of the totals identity the
      // validator checks (subtotal + tax + shipping − discount +
      // rounding = total) — omitting them renders math that doesn't
      // visibly close (e.g. a Mann Lake order with USD 9.95 shipping).
      subtotal_amount: doc.parse_summary?.subtotal_amount ?? null,
      shipping_amount: doc.parse_summary?.shipping_amount ?? null,
      discount_amount: doc.parse_summary?.discount_amount ?? null,
      rounding_amount: doc.parse_summary?.rounding_amount ?? null,
      tax_amount: doc.tax_amount == null ? null : Number(doc.tax_amount),
      total_amount: doc.total_amount == null ? null : Number(doc.total_amount),
      payment_status: doc.payment_status || 'unknown',
      extraction_confidence:
        doc.extraction_confidence == null ? null : Number(doc.extraction_confidence),
      parse_summary: doc.parse_summary || null
    },
    lines: linesResult.rows.map((row) => ({
      id: row.id,
      line_no: row.line_no,
      description: row.description,
      quantity: row.quantity == null ? null : Number(row.quantity),
      unit_price: row.unit_price == null ? null : Number(row.unit_price),
      amount: row.amount == null ? null : Number(row.amount),
      tax_rate: row.tax_rate == null ? null : Number(row.tax_rate),
      fingerprint: row.fingerprint,
      account_code: row.account_code,
      category: row.category,
      coding_confidence:
        row.coding_confidence == null ? null : Number(row.coding_confidence),
      coding_source: row.coding_source,
      review_status: row.review_status || 'needs_review',
      payload: row.payload || null,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at)
    })),
    review_items: reviewResult.rows.map((row) => rowToReviewItemPayload(row))
  };
};

// Look up a document with the columns the worker needs. We don't trust
// the Inngest event payload for ownership / storage location: re-read
// from the DB on every run.
export const getDocumentForParseInDb = async ({ firmId = DEFAULT_FIRM_ID, documentId } = {}) => {
  if (!firmId || !documentId) return null;
  const result = await queryFirmDb(
    `select ${DOC_THIN_COLUMNS} from documents where firm_id=$1 and id=$2`,
    [firmId, documentId]
  );
  if (!result.rows.length) return null;
  return rowToThinParseStatus(result.rows[0]);
};

// Bulk insert/upsert of extractor-produced transactions. The upsert is
// gated by `transactions.status = 'needs_review'` on the EXISTING row,
// so re-parses cannot clobber rows the firm has already moved past
// review (status=`ready`, `posted`, etc). Only parser-output columns
// are touched; firm decisions (status, category, account_code,
// reconciliation_status, ledger fields) are explicitly excluded.
//
// Batched: a single multi-row `INSERT … ON CONFLICT … RETURNING` per
// chunk replaces the previous per-row SELECT+INSERT loop. A 16-month
// bank statement that produced thousands of serial queries (and tripped
// Vercel's 300s function ceiling — the post-extraction parse-stall) now
// resolves in a constant number of round trips. The ON CONFLICT WHERE
// clause preserves the review-state skip; RETURNING gives us the
// `written` count and we derive `skipped` from `transactions.length`.
// Chunked at 1000 rows so the param count (16 per row → 16000) stays
// well below Postgres' ~65535 prepared-statement parameter cap, even
// for a multi-year statement.
//
// The ON CONFLICT payload merge deliberately does NOT replace the stored
// payload (corrections/enrichment live there); it layers in the re-parse
// receipt keys, plus — jsonb_strip_nulls, so absent keys never clobber —
// the semantic statement-line fields (counterparty / payment_method /
// message / reference) that the LLM-first extractor mints. Without that
// second merge a re-parse under BANK_STATEMENT_LLM_EXTRACTION would fix
// a line's display description but leave the matcher/coder's payload
// vendor signal empty on pre-existing rows.
const UPSERT_PARSED_TRANSACTIONS_CHUNK_SIZE = 1000;

const upsertParsedTransactionsChunkWithClient = async (
  client,
  { firmId, clientId, documentId, transactions }
) => {
  if (!transactions.length) return 0;
  const COLS_PER_ROW = 16;
  const valuesRows = [];
  const params = [];
  transactions.forEach((tx, i) => {
    const base = i * COLS_PER_ROW;
    valuesRows.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
      `$${base + 5}, $${base + 6}, ` +
      `$${base + 7}, $${base + 8}, $${base + 9}, ` +
      `coalesce($${base + 10}, 'needs_review'), ` +
      `$${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, ` +
      `$${base + 15}, $${base + 16}::jsonb)`
    );
    params.push(
      tx.id,
      firmId,
      clientId,
      documentId,
      tx.date || tx.transaction_date || null,
      tx.description || null,
      Number(tx.money_in || 0),
      Number(tx.money_out || 0),
      tx.currency_resolution
        ? tx.currency_resolution.currency || null
        : tx.account_currency || tx.currency || null,
      tx.status || 'needs_review',
      tx.external_transaction_id || null,
      tx.raw_description || tx.description || null,
      tx.cleaned_description || null,
      tx.direction || null,
      tx.confidence_score == null ? null : Number(tx.confidence_score),
      JSON.stringify({
        ...tx,
        ...(tx.currency_resolution ? {
          currency: tx.currency_resolution.currency || null,
          account_currency: tx.currency_resolution.currency || null
        } : {}),
        source_document_id: documentId,
        source: tx.source || 'async_parse'
      })
    );
  });
  const result = await client.query(
    `insert into transactions (
       id, firm_id, client_id, document_id, transaction_date, description,
       money_in, money_out, currency, status,
       external_transaction_id, raw_description, cleaned_description, direction,
       confidence_score, payload
     )
     values ${valuesRows.join(', ')}
     on conflict (id) do update set
       transaction_date = excluded.transaction_date,
       description = excluded.description,
       money_in = excluded.money_in,
       money_out = excluded.money_out,
       currency = excluded.currency,
       raw_description = excluded.raw_description,
       cleaned_description = excluded.cleaned_description,
       direction = excluded.direction,
       confidence_score = excluded.confidence_score,
       document_id = excluded.document_id,
       payload = transactions.payload || jsonb_build_object(
         'parser_run_at', to_jsonb(now()),
         'extraction_confidence', excluded.confidence_score
       ) || case when excluded.payload ? 'currency_resolution' then jsonb_build_object(
         'currency_resolution', excluded.payload->'currency_resolution',
         'currency', excluded.payload->'currency',
         'account_currency', excluded.payload->'account_currency',
         'ledger_currency', excluded.payload->'ledger_currency',
         'ledger_conversion_status', excluded.payload->'ledger_conversion_status'
       ) else '{}'::jsonb end || jsonb_strip_nulls(jsonb_build_object(
         'counterparty', excluded.payload->'counterparty',
         'payment_method', excluded.payload->'payment_method',
         'message', excluded.payload->'message',
         'reference', excluded.payload->'reference'
       )),
       updated_at = now()
     where transactions.status = 'needs_review'
     returning id`,
    params
  );
  return result.rows.length;
};

// Inner transactional logic — exported via __upsertParsedTransactionsWithClient
// so tests can drive it against an in-memory mock client without
// borrowing a Postgres pool. Mirrors the convention on
// __retryParseRunsWithClient / __writeParsedDocumentExtractionWithClient.
export const __upsertParsedTransactionsWithClient = async ({
  client,
  firmId,
  clientId,
  documentId,
  transactions = []
}) => {
  // Drop rows with no id BEFORE issuing SQL — they're unwritable. Surface
  // them in `skipped` so the caller's count still reflects "rows we did
  // not write". Preserves the per-row loop's `if (!tx?.id) continue`
  // semantics from the legacy path.
  const eligible = transactions.filter((tx) => tx?.id);
  const dropped = transactions.length - eligible.length;
  if (!eligible.length) return { written: 0, skipped: dropped };

  await client.query('begin');
  try {
    let written = 0;
    for (let i = 0; i < eligible.length; i += UPSERT_PARSED_TRANSACTIONS_CHUNK_SIZE) {
      assertExecutionBudgetActive({ client });
      const chunk = eligible.slice(i, i + UPSERT_PARSED_TRANSACTIONS_CHUNK_SIZE);
      written += await upsertParsedTransactionsChunkWithClient(client, {
        firmId,
        clientId,
        documentId,
        transactions: chunk
      });
    }
    assertExecutionBudgetActive({ client });
    await client.query('commit');
    return {
      written,
      // ON CONFLICT … WHERE transactions.status='needs_review' makes the
      // upsert a no-op for rows already past review — those don't show
      // up in RETURNING, so `eligible.length - written` is the count of
      // rows protected by the review-state guard. Plus rows we dropped
      // upfront for missing id.
      skipped: (eligible.length - written) + dropped
    };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  }
};

export const upsertParsedTransactionsInDb = async ({
  firmId,
  clientId,
  documentId,
  transactions = []
} = {}) => {
  if (!firmId || !clientId || !documentId || !transactions.length) return { written: 0, skipped: 0 };
  return withFirmDbClient((client) =>
    __upsertParsedTransactionsWithClient({
      client,
      firmId,
      clientId,
      documentId,
      transactions
    })
  );
};

// ── Activity feed: batch_id rollups (PR 4) ─────────────────────────────

// Group recent uploads by batch_id and report a rolled-up state
// breakdown — "Alice uploaded 23 documents · 18 ready, 2 parsing, 3
// failed". Reads directly off `documents.batch_id` rather than
// audit_events.metadata->>'batch_id' because the join with the current
// parse_status is the whole point, and audit_events would force a
// metadata-driven post-aggregation in app code.
//
// `windowDays` and `limit` cap the query: stale batches roll off and a
// runaway firm can't pin the snapshot. Returns newest-first.
export const fetchRecentUploadBatchesFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  windowDays = 7,
  limit = 25
} = {}) => {
  const safeWindow = Math.max(1, Math.min(90, Number(windowDays) || 7));
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const result = await queryFirmDb(
    `with batched as (
       select
         batch_id,
         firm_id,
         client_id,
         parse_status,
         filename,
         created_at,
         uploaded_at
       from documents
       where firm_id = $1
         and batch_id is not null
         and created_at >= now() - ($2 || ' days')::interval
     ),
     rolled as (
       select
         batch_id,
         min(client_id) as client_id,
         count(*)::int as total,
         count(*) filter (where parse_status = 'completed')::int as completed_count,
         count(*) filter (where parse_status in ('pending', 'processing'))::int as parsing_count,
         count(*) filter (where parse_status = 'failed')::int as failed_count,
         count(*) filter (where parse_status in ('duplicate_pending'))::int as duplicate_count,
         count(*) filter (where parse_status = 'skipped')::int as skipped_count,
         max(created_at) as last_activity_at,
         min(created_at) as first_activity_at
       from batched
       group by batch_id
     ),
     latest_filename as (
       select distinct on (batch_id)
         batch_id, filename
       from batched
       where filename is not null
       order by batch_id, created_at desc
     )
     select rolled.*, latest_filename.filename as latest_filename
     from rolled
     left join latest_filename using (batch_id)
     order by rolled.last_activity_at desc
     limit $3`,
    [firmId, String(safeWindow), safeLimit]
  );
  return result.rows.map((row) => ({
    batch_id: row.batch_id,
    client_id: row.client_id || null,
    total: Number(row.total || 0),
    completed: Number(row.completed_count || 0),
    parsing: Number(row.parsing_count || 0),
    failed: Number(row.failed_count || 0),
    duplicate_pending: Number(row.duplicate_count || 0),
    skipped: Number(row.skipped_count || 0),
    first_activity_at: toIso(row.first_activity_at),
    last_activity_at: toIso(row.last_activity_at),
    latest_filename: row.latest_filename || null
  }));
};

// Pure rollup helper — same shape as fetchRecentUploadBatchesFromDb's
// rows, but built from a documents-array input. Used by both the
// snapshot reader (where the rows are already in-memory) and tests.
export const rollupUploadBatches = (documents = []) => {
  const byBatch = new Map();
  for (const doc of documents) {
    const batchId = doc?.batch_id;
    if (!batchId) continue;
    let entry = byBatch.get(batchId);
    if (!entry) {
      entry = {
        batch_id: batchId,
        client_id: doc.client_id || null,
        total: 0,
        completed: 0,
        parsing: 0,
        failed: 0,
        duplicate_pending: 0,
        skipped: 0,
        first_activity_at: null,
        last_activity_at: null,
        latest_filename: null,
        _latest_ts: 0
      };
      byBatch.set(batchId, entry);
    }
    entry.total += 1;
    const status = doc.parse_status || 'completed';
    if (status === 'completed') entry.completed += 1;
    else if (status === 'pending' || status === 'processing') entry.parsing += 1;
    else if (status === 'failed') entry.failed += 1;
    else if (status === 'duplicate_pending') entry.duplicate_pending += 1;
    else if (status === 'skipped') entry.skipped += 1;
    const ts = doc.created_at ? Date.parse(doc.created_at) : 0;
    if (ts && (!entry.first_activity_at || ts < Date.parse(entry.first_activity_at))) {
      entry.first_activity_at = new Date(ts).toISOString();
    }
    if (ts && ts >= entry._latest_ts) {
      entry._latest_ts = ts;
      entry.last_activity_at = new Date(ts).toISOString();
      if (doc.filename) entry.latest_filename = doc.filename;
    }
  }
  const out = [];
  for (const entry of byBatch.values()) {
    delete entry._latest_ts;
    out.push(entry);
  }
  out.sort((a, b) => {
    const ta = a.last_activity_at ? Date.parse(a.last_activity_at) : 0;
    const tb = b.last_activity_at ? Date.parse(b.last_activity_at) : 0;
    return tb - ta;
  });
  return out;
};

// ── Storage-orphan cleanup helpers (PR 4) ──────────────────────────────

// Pull every storage_object_key in a bucket that documents.* references.
// Used by the daily orphan-cleanup cron to determine which storage
// objects DON'T have a backing row. Scoped to one bucket because the
// cron iterates buckets/firms in turn and we want to cap each query.
export const fetchReferencedStorageKeysInDb = async ({ bucket } = {}) => {
  if (!bucket) return new Set();
  const result = await queryFirmDb(
    `select storage_object_key
     from documents
     where storage_bucket = $1 and storage_object_key is not null`,
    [bucket]
  );
  return new Set(result.rows.map((row) => row.storage_object_key));
};

export const fetchDistinctStorageBucketsInDb = async () => {
  const result = await queryFirmDb(
    `select distinct storage_bucket
     from documents
     where storage_bucket is not null`
  );
  return result.rows.map((row) => row.storage_bucket).filter(Boolean);
};

// Pure cross-reference: given a listing of storage objects and the set
// of keys that DB rows reference, return the ones to delete. Filters
// objects younger than `minAgeMs` so we don't race an in-flight upload
// whose /register hasn't landed yet (the tray's pre-register retry on
// next mount handles that within the same session; this cron picks up
// abandoned-tab cases). Capped at `limit` so a runaway list can't push
// a single cron run past Vercel's 5min budget.
export const selectStorageOrphans = ({
  objects = [],
  referencedKeys = new Set(),
  minAgeMs = 60 * 60 * 1000, // 1h
  limit = 1000,
  now = Date.now()
} = {}) => {
  const orphans = [];
  for (const obj of objects) {
    if (orphans.length >= limit) break;
    const key = obj?.name;
    if (!key) continue;
    if (referencedKeys.has(key)) continue;
    const ageMs = (() => {
      const raw = obj?.created_at || obj?.updated_at;
      if (!raw) return null;
      const t = Date.parse(raw);
      return Number.isFinite(t) ? now - t : null;
    })();
    // Skip objects we can't age-verify — being conservative on storage
    // deletion is the right default. The next cron run will pick them
    // up once Supabase backfills timestamps (in practice they always
    // come back from /list).
    if (ageMs == null) continue;
    if (ageMs < minAgeMs) continue;
    orphans.push({
      key,
      size: Number(obj?.size || 0),
      age_ms: ageMs
    });
  }
  return orphans;
};

// Log one audit_event per orphaned storage object that was deleted.
// Bucket + key + size give ops enough to investigate a bad cron run.
// firm_id and client_id are derived from the key path (firmId/clientId/…)
// when possible — the cleanup endpoint passes them through, and we
// store NULL when the path doesn't decode (e.g. legacy keys).
export const logStorageOrphanCleanedInDb = async ({
  bucket,
  key,
  size,
  ageMs,
  firmId = null,
  clientId = null
} = {}) => {
  if (!bucket || !key) return;
  await queryFirmDb(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'storage.orphan_cleaned', 'storage_object', $3, $4::jsonb)`,
    [
      firmId,
      clientId,
      key,
      JSON.stringify({
        bucket,
        key,
        size: Number(size || 0),
        age_ms: Number(ageMs || 0)
      })
    ]
  );
};

// ── Outbox + stuck-job cron helpers ────────────────────────────────────

// Outbox sweeper picks rows where the Inngest send hasn't been
// confirmed yet (parse_event_sent_at IS NULL). The drain task is
// different: it picks ANY pending row past the threshold, regardless
// of `parse_event_sent_at`. The point of drain is to be a complete
// substitute for Inngest delivery — so an event "sent" to Inngest
// that never came back (cloud outage, missing env, signing
// mismatch, deleted webhook) gets processed inline by the cron
// instead. The parse_run_id claim gate in claimParseRunInDb keeps
// the drain runner and any late Inngest delivery from racing —
// only one will get the claim, the other no-ops.
//
// Threshold defaults to 60s so Inngest's push has a real chance to
// run first; drain only kicks in if Inngest hasn't.
// Clamps a (limit, thresholdSeconds) pair for the drain query.
// Exported for unit-testing because the SQL helper itself hits a
// live pool. Bounds: limit ∈ [1, 50] default 5; threshold ≥ 0s
// default 5. The original 60s floor existed to keep drain from
// racing in-flight Inngest deliveries — since we dropped Inngest as
// a hard dependency (PR #48), drain IS the primary path and can
// pick rows up as soon as /register has them. Atomic FOR UPDATE
// claim inside runParseInline still protects against multi-kick
// races on the same row.
export const clampDrainBounds = ({ limit = 5, thresholdSeconds = 5 } = {}) => {
  const rawThreshold = Number(thresholdSeconds);
  return {
    limit: Math.max(1, Math.min(50, Number(limit) || 5)),
    thresholdSeconds: Math.max(0, Number.isFinite(rawThreshold) ? rawThreshold : 5)
  };
};

// Default recheck window for a readiness-held row (RT-02). A row whose
// `payload.parse_hold.checked_at` is younger than this is returned with
// `hold_fresh: true` and sorted LAST, so the drain skips it without a claim
// (no per-minute `runtime.readiness_admission_blocked` audit) and other
// entities' rows are never starved behind a held batch. Env is a tuning
// knob, never a behavior gate.
export const PARSE_HOLD_RECHECK_SECONDS_DEFAULT = 300;

export const fetchDrainablePendingRowsInDb = async ({
  limit = 5,
  thresholdSeconds = 5,
  holdRecheckSeconds = Number(process.env.PARSE_HOLD_RECHECK_SECONDS || PARSE_HOLD_RECHECK_SECONDS_DEFAULT)
} = {}) => {
  const { limit: safeLimit, thresholdSeconds: safeThreshold } = clampDrainBounds({
    limit,
    thresholdSeconds
  });
  const safeHoldRecheck = Math.max(0, Number.isFinite(Number(holdRecheckSeconds))
    ? Number(holdRecheckSeconds)
    : PARSE_HOLD_RECHECK_SECONDS_DEFAULT);
  const result = await queryFirmDb(
    // Held rows last (RT-02), then small-docs-first (Kari, 2026-08-06): the
    // drain runs strictly one doc at a time, so FIFO let a 2-minute statement
    // park a dozen 10-second receipts behind it (observed: 800s+ queue waits
    // on a batch upload). Statements sort LAST within the unheld class;
    // everything else keeps FIFO among itself. coalesce so an untyped doc
    // sorts with the quick class rather than after the statements.
    `select id, firm_id, client_id, parse_run_id, parse_enqueued_at, document_type,
            parse_attempts,
            payload->'parse_hold' as parse_hold,
            (coalesce((payload->'parse_hold'->>'checked_at')::timestamptz, 'epoch'::timestamptz)
               > now() - ($3 || ' seconds')::interval) as hold_fresh
     from documents
     where parse_status='pending'
       and parse_run_id is not null
       and parse_enqueued_at < now() - ($1 || ' seconds')::interval
     order by (coalesce((payload->'parse_hold'->>'checked_at')::timestamptz, 'epoch'::timestamptz)
                 > now() - ($3 || ' seconds')::interval) asc,
              (coalesce(document_type, '') in ('bank_statement', 'statement', 'payment_account_statement')) asc,
              parse_enqueued_at asc
     limit $2`,
    [String(safeThreshold), safeLimit, String(safeHoldRecheck)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    parse_run_id: row.parse_run_id || null,
    parse_enqueued_at: toIso(row.parse_enqueued_at),
    document_type: row.document_type || null,
    parse_attempts: Number(row.parse_attempts ?? 0),
    parse_hold: row.parse_hold || null,
    hold_fresh: row.hold_fresh === true
  }));
};

export const fetchOutboxPendingRowsInDb = async ({ limit = 100 } = {}) => {
  const result = await queryFirmDb(
    `select id, firm_id, client_id, parse_run_id, parse_enqueued_at, document_type
     from documents
     where parse_status='pending'
       and parse_event_sent_at is null
       and parse_enqueued_at < now() - interval '30 seconds'
     order by parse_enqueued_at asc
     limit $1`,
    [Math.max(1, Math.min(500, Number(limit) || 100))]
  );
  return result.rows.map((row) => ({
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    parse_run_id: row.parse_run_id || null,
    parse_enqueued_at: toIso(row.parse_enqueued_at),
    document_type: row.document_type || null
  }));
};

export const failStuckProcessingRowsInDb = async ({
  thresholdSeconds = 300,
  requestAskDraftFn = onReconcileCompleteRequestAskDraft
} = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const stuck = await client.query(
        `select id, firm_id, client_id, parse_run_id
         from documents
         where parse_status='processing'
           and parse_heartbeat_at < now() - ($1 || ' seconds')::interval`,
        [String(Math.max(60, Number(thresholdSeconds) || 300))]
      );
      let failed = 0;
      const failedRows = [];
      for (const row of stuck.rows) {
        // parse_error is FE-visible, so we deliberately omit the
        // free-form `message` field (the worker's strict
        // categorizeError contract keeps raw provider responses /
        // stack traces in server logs only). `safe_user_message`
        // carries the user-facing copy.
        const parseError = {
          code: 'STUCK',
          safe_user_message: 'This parse timed out. You can retry it.',
          retryable: true,
          // The sweep is not a retry owner; the human click is (RT-02).
          retry_owner: 'manual',
          provider: 'internal',
          occurred_at: new Date().toISOString()
        };
        const update = await client.query(
          `update documents
           set parse_status='failed',
               parse_error=$3::jsonb,
               parse_heartbeat_at=now(),
               updated_at=now()
           where id=$1 and parse_status='processing' and parse_run_id=$2::uuid
           returning id`,
          [row.id, row.parse_run_id, JSON.stringify(parseError)]
        );
        if (update.rows.length) {
          failed += 1;
          failedRows.push(row);
          await audit(client, {
            firmId: row.firm_id,
            clientId: row.client_id,
            documentId: row.id,
            action: 'document.parse.failed',
            metadata: { parse_run_id: row.parse_run_id, code: 'STUCK', source: 'stuck_job_cron' }
          });
        }
      }
      await client.query('commit');
      // Donna Loops shadow producer (post-commit, no-throw, LOOPS_SHADOW-gated):
      // a stuck/timed-out parse opens an upload case with a parse_stale blocker.
      for (const row of failedRows) {
        await onDocumentParseFailed({
          client, firmId: row.firm_id, clientId: row.client_id,
          documentId: row.id, blockerType: 'parse_stale',
          parseError: { code: 'STUCK', safe_user_message: 'This parse timed out. You can retry it.', retry_owner: 'manual' },
          parseRunId: row.parse_run_id
        });
        await requestAskDraftFn({
          client, firmId: row.firm_id, clientId: row.client_id,
          source: 'document_parse_stale'
        });
      }
      return { stuck_count: stuck.rows.length, failed_count: failed };
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    }
  });
};

// ── Duplicate detection: period-overlap helpers ───────────────────────

// Pull structured start/end dates out of a parse_summary written by the
// worker's `buildStatementSummary`. Falls back to parsing the legacy
// `statement_period` string label (`YYYY-MM` or `YYYY-MM-DD to
// YYYY-MM-DD`) so summaries from earlier runs still work. Returns `null`
// when neither shape yields a usable pair.
export const extractPeriodBoundsFromSummary = (summary) => {
  if (!summary || typeof summary !== 'object') return null;
  const direct = {
    start: summary.period_start_date || null,
    end: summary.period_end_date || null
  };
  if (direct.start && direct.end) {
    return { start: String(direct.start), end: String(direct.end) };
  }
  const label = String(summary.statement_period || '').trim();
  if (!label) return null;
  const range = label.match(/^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/);
  if (range) return { start: range[1], end: range[2] };
  const monthOnly = label.match(/^(\d{4})-(\d{2})$/);
  if (monthOnly) {
    const year = Number(monthOnly[1]);
    const month = Number(monthOnly[2]);
    const start = `${monthOnly[1]}-${monthOnly[2]}-01`;
    // End-of-month: last day of `month`. Day 0 of next month rolls back
    // to the final day of the requested month.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const end = `${monthOnly[1]}-${monthOnly[2]}-${String(lastDay).padStart(2, '0')}`;
    return { start, end };
  }
  return null;
};

// Inclusive overlap test on ISO-formatted YYYY-MM-DD strings. Returns
// false when either bound is missing. String comparison is sound for
// ISO dates.
export const computeStatementPeriodOverlap = (a, b) => {
  if (!a || !b) return false;
  if (!a.start || !a.end || !b.start || !b.end) return false;
  return String(a.start) <= String(b.end) && String(b.start) <= String(a.end);
};

// Returns the most-recent completed statement for this account whose
// period overlaps the candidate, or null. Statements only — receipts /
// invoices fall back on byte-hash (plan §"Out of scope").
//
// `excludeDocumentId` is the in-flight doc itself, which would
// otherwise match its own account_fingerprint and trigger a self-
// duplicate.
export const findOverlappingStatementInDb = async ({
  firmId,
  clientId,
  accountFingerprint,
  periodStart,
  periodEnd,
  excludeDocumentId
} = {}) => {
  if (!firmId || !clientId || !accountFingerprint) return null;
  if (!periodStart || !periodEnd) return null;
  const result = await queryFirmDb(
    `select id, filename, parse_summary, parse_completed_at, uploaded_at
     from documents
     where firm_id=$1
       and client_id=$2
       and account_fingerprint=$3
       and id <> coalesce($4, '')
       and parse_status='completed'
     order by parse_completed_at desc nulls last, uploaded_at desc nulls last`,
    [firmId, clientId, accountFingerprint, excludeDocumentId || null]
  );
  const candidate = { start: periodStart, end: periodEnd };
  for (const row of result.rows) {
    const otherBounds = extractPeriodBoundsFromSummary(row.parse_summary);
    if (!otherBounds) continue;
    if (computeStatementPeriodOverlap(candidate, otherBounds)) {
      return {
        id: row.id,
        filename: row.filename || null,
        parse_summary: row.parse_summary || null,
        parse_completed_at: toIso(row.parse_completed_at),
        uploaded_at: toIso(row.uploaded_at)
      };
    }
  }
  return null;
};

// Worker calls this after extraction when it spots an overlap. The
// document transitions to `duplicate_pending` and the firm/owner resolves
// it via /resolve-duplicate. Atomic update gated by parse_run_id so a
// stale Inngest retry can't clobber a row that was already manually
// resolved.
// ── reconciliation_matches cleanup on duplicate transition ───────────
//
// When a document transitions from canonical (`duplicate_of IS NULL`)
// to duplicate, any rows it had previously written to
// `reconciliation_matches` become stale: the matchers filter
// `duplicate_of IS NULL` at the candidate SELECT, so the row stops
// getting refreshed; and the UI's read path JOINs on the same filter,
// so the stale rows aren't shown anyway. Functionally invisible, but
// they accumulate over time in scenarios where canonical assignment
// flips (e.g. after running the alex-morgan-dedup script or any time
// the resolveDuplicate flow re-marks a row).
//
// The fix is to delete the rows in the same transaction that sets
// `duplicate_of`. Idempotent — second call is a no-op once the rows
// are gone. Caller MUST pass an existing client (so the delete shares
// the caller's transaction); callers without their own transaction
// can use the standalone wrapper `clearReconciliationMatchesForDuplicateInDb`.
//
// Despite the "ForDuplicate" name, the helper is the generic
// "delete a document's match rows" primitive: the duplicate-replace
// path and firmDb's /documents/sync replacement path call it before
// deleting a document, because a match row whose matched_object_id
// points at a deleted doc still suppresses its bank line for every
// future matcher run (the June 2026 Honeybee orphan class).
export const __clearReconciliationMatchesForDuplicateWithClient = async (
  client,
  { firmId, documentId } = {}
) => {
  if (!client || !firmId || !documentId) return { deleted: 0 };
  const result = await client.query(
    `delete from reconciliation_matches
       where firm_id = $1 and matched_object_id = $2
     returning id`,
    [firmId, documentId]
  );
  return { deleted: result.rows.length };
};

// ── duplicate-chain heir on canonical delete ───────────────────────────
//
// `documents.duplicate_of` has no FK (migration 011), so every writer that
// deletes a canonical repoints the rows that named it. Clearing them all was
// the old answer; with several byte-identical collapsed rows that would mint
// several canonicals of the same bytes, which the unique index from migration
// 164 refuses. The one owner of that repoint, run AFTER the delete:
//   - per (client, bytes), the heir is an existing canonical of those bytes if
//     one survives, else the oldest row that is eligible to be one (not a
//     `duplicate_pending` placeholder, not `failed`), which is promoted;
//   - the other rows of that group are pointed at the heir;
//   - rows with no bytes, rows with no eligible heir, and `duplicate_pending`
//     placeholders (the owner's open question) are cleared as before.
export const __promoteDuplicateHeirsWithClient = async (
  client,
  { firmId, deletedIds = [], excludeIds = [] } = {}
) => {
  const ids = [...new Set(deletedIds.filter(Boolean))];
  const result = { promoted: [], repointed: {}, cleared: [] };
  if (!client || !firmId || !ids.length) return result;
  const orphans = (await client.query(
    `select id, client_id, checksum_sha256, parse_status from documents
      where firm_id = $1 and duplicate_of = any($2::text[]) and not (id = any($3::text[]))
      order by created_at asc, id asc
      for update`,
    [firmId, ids, excludeIds.filter(Boolean)]
  )).rows;
  const eligible = (row) => !['duplicate_pending', 'failed'].includes(row.parse_status);
  const groups = new Map();
  for (const row of orphans) {
    if (!row.checksum_sha256 || row.parse_status === 'duplicate_pending') {
      result.cleared.push(row.id);
      continue;
    }
    const key = JSON.stringify([row.client_id, row.checksum_sha256]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    const [{ client_id: clientId, checksum_sha256: checksum }] = rows;
    const surviving = (await client.query(
      `select id from documents
        where firm_id = $1 and client_id = $2 and checksum_sha256 = $3
          and duplicate_of is null and parse_status not in ('duplicate_pending', 'failed')
        order by created_at asc limit 1`,
      [firmId, clientId, checksum]
    )).rows[0];
    const heir = surviving?.id || rows.find(eligible)?.id || null;
    for (const row of rows) {
      if (!heir) result.cleared.push(row.id);
      else if (row.id === heir) result.promoted.push(row.id);
      else result.repointed[row.id] = heir;
    }
  }
  const toClear = [...result.promoted, ...result.cleared];
  if (toClear.length) {
    await client.query(
      `update documents set duplicate_of = null, updated_at = now()
        where firm_id = $1 and id = any($2::text[])`,
      [firmId, toClear]
    );
  }
  const repointed = Object.entries(result.repointed);
  if (repointed.length) {
    await client.query(
      `update documents d set duplicate_of = h.duplicate_of, updated_at = now()
         from unnest($2::text[], $3::text[]) as h(id, duplicate_of)
        where d.firm_id = $1 and d.id = h.id`,
      [firmId, repointed.map(([id]) => id), repointed.map(([, heir]) => heir)]
    );
  }
  return result;
};

export const clearReconciliationMatchesForDuplicateInDb = async ({
  firmId,
  documentId
} = {}) =>
  withFirmDbClient((client) =>
    __clearReconciliationMatchesForDuplicateWithClient(client, { firmId, documentId })
  );

// ── transaction-match unwind on document delete / replace / duplicate ─
//
// Companion to __clearReconciliationMatchesForDuplicateWithClient.
// When a `reconciliation_matches` row is confirmed (status='confirmed'
// or 'auto_matched'), `firmDb.js:2762-2779` stamps the matched
// transaction with `reconciliation_status='reconciled'`, sets
// `reconciled_at`, and writes
// `{reconciliation_match_id, reconciliation_match_type,
//   reconciliation_match_object_id, reconciliation_status:'reconciled'}`
// into `transactions.payload`. The matcher's candidate SELECT in
// billReconciliation.js / receiptReconciliation.js excludes
// transactions whose `reconciliation_status` sits in the done-set
// ('reconciled', 'auto_reconciled', 'explained', 'posted').
//
// If the matched document is deleted, replaced, or marked duplicate
// without an inverse unwind, the transaction is left pointing at thin
// air: invisible to the matcher, but no corresponding match record
// exists. The same asymmetric-cleanup shape PR #181 fixed for
// `documents.duplicate_of` and PR #182 fixed for `reconciliation_matches`,
// just on the transactions axis. Discovered during the
// honeybee-hills-apiary 15-NO-MATCH investigation (June 2026).
//
// Helper finds transactions where
//   payload->>'reconciliation_match_object_id' = documentId
// and reverts them:
//   - reconciliation_status -> 'needs_review'
//   - reconciled_at -> null
//   - payload strips the four keys the confirm path wrote
//     (symmetric inverse). Other payload keys — rule-engine state like
//     `support_status`, `auto_categorize_source` — are left untouched.
//
// Returns { unwound: N }. Caller MUST pass an existing client so the
// UPDATE shares the caller's transaction. Standalone callers use
// `unwindTransactionMatchesForDocumentInDb`. Idempotent: a second call
// finds zero rows. Safe to call unconditionally on any document
// delete; if no transactions were ever matched, the helper just
// returns { unwound: 0 }.
//
// Note: the historical orphans repaired by
// `scripts/repair_orphaned_reconciled_transactions.js` came in via
// `scripts/promote_matches.js` (a one-shot operational script) which
// stamps `reconciled` without writing the match_object_id link. Those
// txns can't be found by this document-scoped helper — the repair
// script's broader "no matching row in reconciliation_matches"
// detection covers them. This helper covers the forward case where
// firmDb.js's confirm path has properly written the link.
export const __unwindTransactionMatchesForDocumentWithClient = async (
  client,
  { firmId, documentId } = {}
) => {
  if (!client || !firmId || !documentId) return { unwound: 0 };
  const result = await client.query(
    `update transactions
        set reconciliation_status = 'needs_review',
            reconciled_at = null,
            payload = payload
              - 'reconciliation_match_id'
              - 'reconciliation_match_type'
              - 'reconciliation_match_object_id'
              - 'reconciliation_status',
            updated_at = now()
      where firm_id = $1
        and payload->>'reconciliation_match_object_id' = $2
      returning id`,
    [firmId, documentId]
  );
  return { unwound: result.rows.length };
};

export const unwindTransactionMatchesForDocumentInDb = async ({
  firmId,
  documentId
} = {}) =>
  withFirmDbClient((client) =>
    __unwindTransactionMatchesForDocumentWithClient(client, { firmId, documentId })
  );

// RT-10 (F-13): the period-overlap decision is the OWNER's, not a firm tray
// state. The duplicate_pending row stays as the mechanical state behind it
// (the 3-way resolver remains the executor — a firm member or, later, the
// reply lane calls it), but the row is ON THE OWNER from the moment it is
// written: a doc-anchored ask is minted in the same transaction, through the
// one ask writer (open-ask dedup per document), evidence_type
// 'statement_overlap'. `parse_summary.owner_ask_id` is the receipt the tray
// reads. Ask existence is never plane-gated.
export const STATEMENT_OVERLAP_ASK_EVIDENCE_TYPE = 'statement_overlap';

export const buildStatementOverlapQuestion = ({
  filename = '',
  existingFilename = '',
  existingPeriod = null
} = {}) => {
  const mine = String(filename || '').trim();
  const theirs = String(existingFilename || '').trim();
  const period = existingPeriod && existingPeriod.start && existingPeriod.end
    ? ` covering ${existingPeriod.start} to ${existingPeriod.end}`
    : '';
  return `The bank statement${mine ? ` "${mine}"` : ' you just uploaded'} overlaps the statement${theirs ? ` "${theirs}"` : ''}${period} already on file for the same account. Should we replace the earlier statement with this one, or keep the earlier one and discard this upload?`;
};

// Resolve the open statement-overlap ask for a document once the duplicate
// is resolved (create / replace / cancel) — the resolver IS the answer, so
// the ask must not outlive it. Idempotent; receipted per ask.
const resolveStatementOverlapAsksWithClient = async (client, { firmId, clientId, documentId, action } = {}) => {
  if (!client || !firmId || !documentId) return { resolved: 0 };
  const result = await client.query(
    `update client_evidence_requests
        set status='resolved',
            resolved_at=coalesce(resolved_at, now()),
            resolved_by='system',
            response_payload = coalesce(response_payload, '{}'::jsonb) || $4::jsonb,
            updated_at=now()
      where firm_id=$1
        and ($2::text is null or client_id=$2)
        and request_payload->>'document_id'=$3
        and evidence_type='${STATEMENT_OVERLAP_ASK_EVIDENCE_TYPE}'
        and status in ('draft', 'open', 'replied')
      returning id, client_id`,
    [firmId, clientId || null, documentId, JSON.stringify({ resolved_by_duplicate_resolution: action })]
  );
  for (const row of result.rows) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'system', 'evidence_request.resolve', 'client_evidence_request', $3, $4::jsonb)`,
      [firmId, row.client_id, row.id, JSON.stringify({ document_id: documentId, via: 'duplicate_resolution', action })]
    );
  }
  return { resolved: result.rows.length };
};

export const markParseDuplicatePendingInDb = async ({
  firmId,
  documentId,
  parseRunId,
  duplicateOf,
  reason,
  existingSummary,
  existingFilename,
  existingUploadedAt,
  // RT-10 — injectable owner-ask writer (tests); null ⇒ the real one.
  askDeps = null
} = {}) => {
  if (!firmId || !documentId || !parseRunId || !duplicateOf) return null;
  const mintOwnerAsk = askDeps?.mintOwnerAsk || ((args) => __createClientEvidenceRequestWithClient(args));
  return withFirmDbClient(async (client) => {
    const statementJev = await (askDeps?.decideJevException || decideJevMaterialException)({
      client, firmId, documentId, parseRunId, kind: 'statement_overlap',
      evidence: { reason, existing_summary: existingSummary, existing_filename: existingFilename,
        existing_uploaded_at: existingUploadedAt, limitation: 'The incoming statement has not yet been imported; no row-by-row comparison or safe replacement plan is available here.' }
    });
    await client.query('begin');
    try {
      const replaceBlocked = await isExistingReplaceBlocked(client, firmId, duplicateOf);
      const summary = {
        reason: reason || 'period_overlap',
        existing_document_id: duplicateOf,
        existing_filename: existingFilename || null,
        existing_summary: existingSummary || null,
        existing_uploaded_at: existingUploadedAt || null,
        replace_blocked: replaceBlocked,
        ...(statementJev ? { jev_exception: statementJev, lane: exceptionPendingLane(statementJev) } : {})
      };
      const updated = await client.query(
        `update documents
         set parse_status='duplicate_pending',
             duplicate_of=$4,
             parse_summary=$5::jsonb,
             parse_stage=null,
             parse_progress_current=null,
             parse_progress_total=null,
             parse_error=null,
             parse_completed_at=null,
             parse_heartbeat_at=now(),
             updated_at=now()
         where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
         returning ${DOC_THIN_COLUMNS}`,
        [firmId, documentId, parseRunId, duplicateOf, JSON.stringify(summary)]
      );
      if (!updated.rows.length) {
        await client.query('rollback');
        return null;
      }
      // The row just transitioned from canonical → duplicate. Any
      // reconciliation_matches rows it had written are now stale —
      // the matcher's candidate SELECT filters duplicate_of IS NULL,
      // so they'll never get refreshed. Delete them in the same
      // transaction so the table stays consistent with the live
      // canonical set.
      const cleared = await __clearReconciliationMatchesForDuplicateWithClient(
        client,
        { firmId, documentId }
      );
      const unwound = await __unwindTransactionMatchesForDocumentWithClient(
        client,
        { firmId, documentId }
      );
      // RT-10: the decision goes to the OWNER in this same transaction —
      // "this statement overlaps the one from <period>: replace or keep?"
      // (evidence_type statement_overlap, deduped on an open ask per
      // document by the writer). The row is never a firm tray state.
      const clientId = updated.rows[0].client_id;
      const mintOutcome = {};
      const request = exceptionOwnerAskAllowed(statementJev) ? await mintOwnerAsk({
        client,
        firmId,
        clientId,
        documentId,
        question: buildStatementOverlapQuestion({
          filename: updated.rows[0].filename || '',
          existingFilename: existingFilename || '',
          existingPeriod: extractPeriodBoundsFromSummary(existingSummary)
        }),
        evidenceType: STATEMENT_OVERLAP_ASK_EVIDENCE_TYPE,
        actorId: 'system',
        requestContext: {
          lane: 'statement_overlap',
          ...(statementJev ? { jev_first: statementJev } : {}),
          duplicate_of: duplicateOf,
          existing_filename: existingFilename || null,
          existing_period: extractPeriodBoundsFromSummary(existingSummary),
          parse_run_id: parseRunId
        },
        mintOutcome
      }) : null;
      const ownerAskId = request?.id || null;
      const receipted = await client.query(
        `update documents
            set parse_summary = coalesce(parse_summary, '{}'::jsonb) || $4::jsonb,
                updated_at=now()
          where firm_id=$1 and id=$2 and parse_run_id=$3::uuid
          returning ${DOC_THIN_COLUMNS}`,
        [firmId, documentId, parseRunId, JSON.stringify({
          owner_ask_id: ownerAskId,
          owner_asked_at: ownerAskId ? new Date().toISOString() : null,
          ...(statementJev ? { jev_exception: statementJev, lane: ownerAskId ? { kind: 'owner_ask', status: 'open', evidence_request_id: ownerAskId } : exceptionPendingLane(statementJev) } : {})
        })]
      );
      await audit(client, {
        firmId,
        clientId,
        documentId,
        action: 'document.parse.duplicate_pending',
        metadata: {
          parse_run_id: parseRunId,
          duplicate_of: duplicateOf,
          reason: reason || 'period_overlap',
          replace_blocked: replaceBlocked,
          stale_match_rows_deleted: cleared.deleted,
          transaction_matches_unwound: unwound.unwound,
          owner_ask_id: ownerAskId,
          ...(statementJev ? { jev_first: statementJev } : {}),
          owner_ask_minted: mintOutcome.minted ?? null
        }
      });
      await client.query('commit');
      return rowToThinParseStatus(receipted.rows[0] || updated.rows[0]);
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    }
  });
};

// ── /documents/<id>/resolve-duplicate ──────────────────────────────────

const SUPPORTED_RESOLVE_ACTIONS = new Set(['create', 'replace', 'cancel']);

// The resolution receipt names a collapse (see requeueAsCanonicalOrCollapse)
// and the collapsed rows that followed the placeholder to the canonical.
const collapseReceipt = (requeued) => (requeued.collapsedOnto
  ? {
    outcome: 'collapsed_onto_canonical',
    collapsed_onto: requeued.collapsedOnto,
    collapse_repointed_duplicates: requeued.heirs?.repointed || {},
    collapse_cleared_duplicates: requeued.heirs?.cleared || []
  }
  : {});

// Inner transactional logic. Exported so unit tests can drive it
// against a fake `client` shim instead of a live Postgres pool. The
// public `resolveDuplicateInDb` below wraps this in `withFirmDbClient`.
export const __resolveDuplicateWithClient = async ({
  client,
  firmId,
  documentId,
  action
}) => {
  if (!SUPPORTED_RESOLVE_ACTIONS.has(action)) {
    const error = new Error(`Unsupported resolve action: ${action}`);
    error.statusCode = 400;
    error.code = 'UNSUPPORTED_RESOLVE_ACTION';
    throw error;
  }
  await client.query('begin');
  try {
    const locked = await client.query(
      `select ${DOC_THIN_COLUMNS} from documents
       where firm_id=$1 and id=$2
       for update`,
      [firmId, documentId]
    );
    if (!locked.rows.length) {
      await client.query('rollback');
      const error = new Error('Document not found.');
      error.statusCode = 404;
      error.code = 'DOCUMENT_NOT_FOUND';
      throw error;
    }
    const row = locked.rows[0];

    // Idempotency: if the doc is no longer duplicate_pending, return
    // current state. The resolver action already ran (or was never
    // applicable). No event re-fires, no audit entry.
    if (row.parse_status !== 'duplicate_pending') {
      await client.query('commit');
      return {
        document: rowToThinParseStatus(row),
        action,
        applied: false
      };
    }

    // RT-10: resolving the duplicate IS the answer to the owner ask the
    // period-overlap writer minted — close it in the same transaction so
    // the row leaves "on the owner" with the decision, whoever made it.
    const overlapAsks = await resolveStatementOverlapAsksWithClient(client, {
      firmId, clientId: row.client_id, documentId, action
    });

    // Create and replace both make this placeholder a canonical again
    // (duplicate_of cleared, parse queued). Migration 164 allows one canonical
    // per (client, bytes): when the owner re-uploaded the same file while this
    // placeholder waited, that upload IS the canonical of these bytes, and
    // the placeholder settles the way /documents/register settles a lost race
    // — the byte-match collapse onto it, with the same summary and receipt.
    // Rows that were collapsed onto this placeholder follow it to the live
    // canonical through the one heir rule (__promoteDuplicateHeirsWithClient).
    const requeueAsCanonicalOrCollapse = async () => {
      const parseRunId = crypto.randomUUID();
      await client.query('savepoint resolve_duplicate_canonical');
      try {
        const updated = await client.query(
          `update documents
           set parse_status='pending',
               duplicate_of=null,
               parse_run_id=$3::uuid,
               parse_attempts=0,
               parse_stage=null,
               parse_progress_current=null,
               parse_progress_total=null,
               parse_error=null,
               parse_summary=null,
               parse_started_at=null,
               parse_heartbeat_at=null,
               parse_completed_at=null,
               parse_enqueued_at=now(),
               parse_event_sent_at=null,
               updated_at=now()
           where firm_id=$1 and id=$2
           returning ${DOC_THIN_COLUMNS}`,
          [firmId, documentId, parseRunId]
        );
        await client.query('release savepoint resolve_duplicate_canonical');
        return { document: updated.rows[0], parseRunId, collapsedOnto: null, heirs: null };
      } catch (error) {
        if (!isCanonicalChecksumViolation(error)) throw error;
        await client.query('rollback to savepoint resolve_duplicate_canonical');
        const existing = await readLiveCanonicalWithClient(client, {
          firmId, clientId: row.client_id, checksum: row.checksum_sha256, excludeId: documentId
        });
        if (!existing) throw error;
        const documentType = row.document_type || 'unknown';
        const collapsed = await client.query(
          `update documents
           set parse_status='skipped',
               duplicate_of=$3,
               parse_run_id=null,
               parse_attempts=0,
               parse_stage=null,
               parse_progress_current=null,
               parse_progress_total=null,
               parse_error=null,
               parse_summary=$4::jsonb,
               parse_started_at=null,
               parse_heartbeat_at=null,
               parse_completed_at=now(),
               parse_enqueued_at=null,
               parse_event_sent_at=null,
               updated_at=now()
           where firm_id=$1 and id=$2
           returning ${DOC_THIN_COLUMNS}`,
          [firmId, documentId, existing.id, JSON.stringify(
            buildByteMatchCollapseSummary({ existing, documentType, collapsedAt: new Date().toISOString() })
          )]
        );
        await auditByteMatchCollapse(client, {
          firmId, clientId: row.client_id, documentId, existing, batchId: row.batch_id || null, via: 'resolve_duplicate'
        });
        const heirs = await __promoteDuplicateHeirsWithClient(client, {
          firmId, deletedIds: [documentId], excludeIds: [documentId]
        });
        return { document: collapsed.rows[0], parseRunId: null, collapsedOnto: existing.id, heirs };
      }
    };

    if (action === 'create') {
      const requeued = await requeueAsCanonicalOrCollapse();
      const parseRunId = requeued.parseRunId;
      const updated = { rows: [requeued.document] };
      await audit(client, {
        firmId,
        clientId: row.client_id,
        documentId,
        action: 'document.parse.duplicate_resolved',
        metadata: {
          action: 'create',
          parse_run_id: parseRunId,
          previous_duplicate_of: row.duplicate_of || null,
          ...collapseReceipt(requeued),
          owner_asks_resolved: overlapAsks.resolved
        }
      });
      await client.query('commit');
      return {
        document: rowToThinParseStatus(updated.rows[0]),
        action,
        applied: true,
        parse_run_id: parseRunId,
        ...(requeued.collapsedOnto ? { collapsed_onto: requeued.collapsedOnto } : {})
      };
    }

    if (action === 'replace') {
      const oldId = row.duplicate_of;
      if (!oldId) {
        await client.query('rollback');
        const error = new Error('Duplicate row has no canonical reference.');
        error.statusCode = 409;
        error.code = 'REPLACE_NO_CANONICAL';
        throw error;
      }
      // Lock the canonical doc too. If it's been deleted out from under
      // us (e.g. another resolver cancelled it), treat as not found and
      // fall back to `create` semantics by clearing duplicate_of —
      // simpler to return an error and let the user retry the action.
      const oldLocked = await client.query(
        `select id, client_id from documents
         where firm_id=$1 and id=$2
         for update`,
        [firmId, oldId]
      );
      if (!oldLocked.rows.length) {
        await client.query('rollback');
        const error = new Error('Canonical document no longer exists.');
        error.statusCode = 409;
        error.code = 'REPLACE_CANONICAL_MISSING';
        throw error;
      }
      const counts = await countReviewedTransactionsForDoc(client, firmId, oldId);
      if (counts.accepted_count > 0) {
        await client.query('rollback');
        const error = new Error('Existing transactions have moved past needs_review.');
        error.statusCode = 409;
        error.code = 'REPLACE_BLOCKED_REVIEWED_TX';
        error.details = counts;
        throw error;
      }
      // Before the canonical DELETE, unwind any transactions whose
      // confirmed match pointed at it. Without this, the matched
      // transactions stay at reconciliation_status='reconciled' with
      // no corresponding match record — invisible to the matcher's
      // candidate SELECT and unable to be re-matched against the
      // new canonical. See the helper docstring for the full story.
      const unwound = await __unwindTransactionMatchesForDocumentWithClient(
        client,
        { firmId, documentId: oldId }
      );
      // Also delete the canonical's reconciliation_matches rows in the
      // same transaction. Single-doc delete has always done this
      // (firmDb.js deleteDocumentInDb); replace never did. The gap
      // surfaced on the June 2026 Honeybee reupload: auto_matched rows
      // left dangling at deleted doc ids read as "line taken" to the
      // matchers, and six bank lines sat NO MATCH until a manual
      // repair. The unwind above can also no-op when the transaction
      // never got the payload link (promote_matches.js-era rows), so
      // the match-row delete must not depend on it.
      const clearedMatches = await __clearReconciliationMatchesForDuplicateWithClient(
        client,
        { firmId, documentId: oldId }
      );
      // Delete the canonical's imported transactions explicitly.
      // transactions.document_id is ON DELETE SET NULL (migration 001)
      // — NOT cascade — so deleting the doc alone strands its imported
      // lines as document-less orphans while the replacement re-imports
      // the same statement: every line doubles (the 2026-06-11
      // Honeybee portal-replace twins, each twin coded independently).
      // reconciliation_matches.bank_transaction_id IS cascade, so the
      // lines' match rows follow automatically; the reviewed-tx gate
      // above already blocks replace when any line moved past review.
      const deletedTx = await client.query(
        `delete from transactions where firm_id=$1 and document_id=$2 returning id`,
        [firmId, oldId]
      );
      // Delete the canonical doc. audit_events.resource_id stays as
      // text so history is preserved (resource_id will dangle but
      // that's the documented schema choice — see migration 001).
      await client.query(
        `delete from documents where firm_id=$1 and id=$2`,
        [firmId, oldId]
      );
      const requeued = await requeueAsCanonicalOrCollapse();
      const parseRunId = requeued.parseRunId;
      const updated = { rows: [requeued.document] };
      // Repoint the OTHER rows in the chain that pointed at the deleted
      // canonical (multi-version uploads where ad287f23 ← dcbff74c,
      // c075768f): without it they keep dangling duplicate_of pointers.
      // Run after the delete and after this row took its place, so one heir
      // per (client, bytes) — this row, when its bytes match — survives.
      const heirs = await __promoteDuplicateHeirsWithClient(client, { firmId, deletedIds: [oldId] });
      await audit(client, {
        firmId,
        clientId: row.client_id,
        documentId,
        action: 'document.parse.duplicate_resolved',
        metadata: {
          action: 'replace',
          promoted_duplicates: [...heirs.promoted, ...heirs.cleared],
          repointed_duplicates: heirs.repointed,
          deleted_document_id: oldId,
          parse_run_id: parseRunId,
          transactions_deleted: deletedTx.rows.length,
          transaction_matches_unwound: unwound.unwound,
          match_rows_deleted: clearedMatches.deleted,
          ...collapseReceipt(requeued),
          owner_asks_resolved: overlapAsks.resolved
        }
      });
      await client.query('commit');
      return {
        document: rowToThinParseStatus(updated.rows[0]),
        action,
        applied: true,
        parse_run_id: parseRunId,
        deleted_document_id: oldId,
        ...(requeued.collapsedOnto ? { collapsed_onto: requeued.collapsedOnto } : {})
      };
    }

    // action === 'cancel'
    const storageBucket = row.storage_bucket || null;
    const storageObjectKey = row.storage_object_key || null;
    await client.query(
      `delete from documents where firm_id=$1 and id=$2`,
      [firmId, documentId]
    );
    // We log the orphan storage object key so PR 4's daily cleanup
    // cron can collect it. No deleteEvidenceObject() helper exists yet
    // — building one is explicitly out of scope per the PR 3 brief.
    await audit(client, {
      firmId,
      clientId: row.client_id,
      documentId,
      action: 'document.parse.duplicate_resolved',
      metadata: {
        action: 'cancel',
        storage_bucket: storageBucket,
        storage_object_key: storageObjectKey,
        orphaned_storage: Boolean(storageObjectKey),
        owner_asks_resolved: overlapAsks.resolved
      }
    });
    await client.query('commit');
    return {
      document: null,
      action,
      applied: true,
      deleted_document_id: documentId,
      orphaned_storage_object_key: storageObjectKey
    };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  }
};

export const resolveDuplicateInDb = async ({ firmId = DEFAULT_FIRM_ID, documentId, action } = {}) => {
  if (!documentId) throw Object.assign(new Error('document_id is required.'), { statusCode: 400 });
  return withFirmDbClient((client) =>
    __resolveDuplicateWithClient({ client, firmId, documentId, action })
  );
};

export const hashSha256 = sha256Hex;
