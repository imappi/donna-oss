// Document corrections — Slice C of the trust-the-strong-LLM strategy
// (CLAUDE.md + docs/donna-llm-trust-strategy.md).
//
// The strategy's first half ("give the strong LLM context, render
// what it says") is shipped across Slices A/B/E. This module is the
// spine of the second half: when a bookkeeper edits a rendered
// field on a parsed document, we
//   - record (firm_id, document_id, field_path, prior_value,
//     corrected_value, corrected_at) in `document_corrections`;
//   - write back to the corresponding `documents` column so the
//     artifact panel renders the corrected value immediately;
//   - feed the correction to the next parse of a SIMILAR document
//     via `buildCorrectionsPromptFragment` (consumed by
//     unifiedExtractor.js's user prompt).
//
// The allowlist below is the contract between the API and the DB:
// any field_path not on the list is rejected at the API boundary.
// The list is deliberately narrow on the first cut — every entry
// is a load-bearing header field that we already render on the
// artifact panel. Line-item edits land in a follow-up PR; the
// re-parse diff surface (showing prior corrections next to fresh
// extractions) ditto.
//
// Two of the allowlist entries — `counterparty_role` and
// `document_type` — record the correction but do NOT write back
// to a `documents` column. That's deliberate: a direction flip or
// a re-classification cascades downstream (the reconciliation
// matcher, the writer, AR/AP aging) and is its own UI flow. Slice
// C records the signal so the next-parse few-shot can learn from
// it; the cascade lands in a follow-up.

import crypto from 'node:crypto';

import {
  DEFAULT_FIRM_ID,
  queryFirmDb,
  updateReconciliationMatchInDb,
  withFirmDbClient
} from './firmDb.js';
import {
  invalidateReconciliationForCorrectedDocument,
  onDocumentCorrected
} from './loopsShadowProducers.js';
import { DOCUMENT_MATCH_TYPES_LOCKSTEP } from './reconcileConvergenceState.js';
import { normalizeLedgerCurrency } from './ledgerCurrency.js';

const STRING_LIMIT = 500;
const FEW_SHOT_DEFAULT_LIMIT = 20;
const FEW_SHOT_MAX_PROMPT_ENTRIES = 12;

const PAYMENT_STATUS_VOCAB = Object.freeze([
  'paid', 'unpaid', 'partial', 'unknown', 'void', 'credit_note'
]);
const DOCUMENT_TYPE_VOCAB = Object.freeze([
  'receipt', 'supplier_bill', 'sales_invoice', 'issued_receipt'
]);
const COUNTERPARTY_ROLE_VOCAB = Object.freeze(['vendor', 'customer']);

// Allowlist of field paths the API will accept. Each entry says how
// to validate the inbound value and (when applicable) which
// `documents` column the correction also writes back to.
//
// `writeback: null` → record-only; the artifact panel will not
// flip on this field until a follow-up PR lands the cascade.
//
// Adding a new field path: pin the validator + writeback shape and
// extend `documentCorrections.test.js` so the API surface stays
// deliberate.
const FIELD_SPECS = Object.freeze({
  vendor_name:      { writeback: 'vendor_name',      type: 'string' },
  customer_name:    { writeback: 'customer_name',    type: 'string' },
  document_date:    { writeback: 'document_date',    type: 'date' },
  due_date:         { writeback: 'due_date',         type: 'date' },
  total_amount:     { writeback: 'total_amount',     type: 'number' },
  tax_amount:       { writeback: 'tax_amount',       type: 'number' },
  currency:         { writeback: 'currency',         type: 'currency' },
  reference_number: { writeback: 'reference_number', type: 'string' },
  payment_status:   { writeback: 'payment_status',   type: 'enum', enum: PAYMENT_STATUS_VOCAB },
  counterparty_role: { writeback: null, type: 'enum', enum: COUNTERPARTY_ROLE_VOCAB },
  document_type:    { writeback: null, type: 'enum', enum: DOCUMENT_TYPE_VOCAB }
});

export const ALLOWED_CORRECTION_FIELDS = Object.freeze(Object.keys(FIELD_SPECS));

const buildError = (message, code, statusCode, details = null) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates + coerces an inbound JSON value against the field
// spec. Throws a 400-shaped error on shape mismatch so the API
// handler can surface a clean validation error. null is always
// accepted — corrections can also CLEAR a field.
const validateValue = (fieldPath, value) => {
  const spec = FIELD_SPECS[fieldPath];
  if (!spec) {
    throw buildError(
      `Unknown field_path: ${fieldPath}`,
      'UNKNOWN_FIELD_PATH',
      400,
      { allowed: ALLOWED_CORRECTION_FIELDS }
    );
  }
  if (fieldPath === 'currency' && value === undefined) {
    throw buildError('An explicit corrected currency or null is required.', 'INVALID_FIELD_VALUE', 400);
  }
  if (value === null || value === undefined) return null;
  switch (spec.type) {
    case 'currency': {
      const currency = normalizeLedgerCurrency(value);
      if (!currency) {
        throw buildError('currency must be an explicit ISO currency code or null', 'INVALID_FIELD_VALUE', 400);
      }
      return currency;
    }
    case 'string':
      if (typeof value !== 'string') {
        throw buildError(`${fieldPath} must be a string or null`, 'INVALID_FIELD_VALUE', 400);
      }
      return value.trim().slice(0, STRING_LIMIT) || null;
    case 'number': {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) {
        throw buildError(`${fieldPath} must be a finite number or null`, 'INVALID_FIELD_VALUE', 400);
      }
      return num;
    }
    case 'date':
      if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
        throw buildError(`${fieldPath} must be a YYYY-MM-DD string or null`, 'INVALID_FIELD_VALUE', 400);
      }
      return value;
    case 'enum':
      if (!spec.enum.includes(value)) {
        throw buildError(
          `${fieldPath} must be one of: ${spec.enum.join(', ')}`,
          'INVALID_FIELD_VALUE',
          400,
          { allowed: [...spec.enum] }
        );
      }
      return value;
    default:
      throw buildError(`Unhandled field type: ${spec.type}`, 'INVALID_FIELD_SPEC', 500);
  }
};

const DOCUMENT_SELECT_COLUMNS =
  'id, client_id, document_type, vendor_name, customer_name, ' +
  'document_date, due_date, total_amount, tax_amount, currency, ' +
  'reference_number, payment_status, direction';

const correctionRowToDto = (row) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  document_id: row.document_id,
  field_path: row.field_path,
  prior_value: row.prior_value,
  corrected_value: row.corrected_value,
  source: row.source,
  corrected_by: row.corrected_by,
  document_type: row.document_type,
  corrected_at: row.corrected_at instanceof Date
    ? row.corrected_at.toISOString()
    : row.corrected_at
});

// Records one correction in document_corrections and (when the
// field has a writeback target) updates the documents row so the
// next snapshot read returns the corrected value. The two writes
// + the audit-events insert run in one transaction so a thrown
// error rolls all three back.
export const __recordDocumentCorrectionWithClient = async ({
  client,
  firmId,
  documentId,
  fieldPath,
  correctedValue,
  correctedBy = null,
  clientId = null,
  sourceModel = null
}) => {
  if (!documentId) {
    throw buildError('document_id is required', 'DOCUMENT_ID_REQUIRED', 400);
  }
  if (!fieldPath) {
    throw buildError('field_path is required', 'FIELD_PATH_REQUIRED', 400);
  }
  const value = validateValue(fieldPath, correctedValue);
  const spec = FIELD_SPECS[fieldPath];

  await client.query('begin');
  try {
    const existing = await client.query(
      // Posting also locks its source document. Currency corrections must fail
      // promptly at this first fence, before the linked-transaction fence below.
      `select ${DOCUMENT_SELECT_COLUMNS} from documents where firm_id=$1 and id=$2 for update${fieldPath === 'currency' ? ' nowait' : ''}`,
      [firmId, documentId]
    );
    if (!existing.rows.length) {
      throw buildError('Document not found', 'DOCUMENT_NOT_FOUND', 404);
    }
    const doc = existing.rows[0];
    if (clientId && doc.client_id !== clientId) {
      throw buildError('Document belongs to a different client.', 'DOCUMENT_CLIENT_CONFLICT', 409);
    }
    if (fieldPath === 'currency') {
      if (!['receipt', 'supplier_bill'].includes(doc.document_type)) {
        throw buildError('Currency correction here supports receipts and supplier bills only.', 'DOCUMENT_CURRENCY_CORRECTION_UNSUPPORTED', 409);
      }
      if (!correctedBy || correctedBy === 'system') {
        throw buildError('An authenticated person must confirm document currency.', 'CORRECTION_ACTOR_REQUIRED', 403);
      }
      // This source lock serializes with the settlement writer. A correction
      // never changes the denomination underneath a retained posted journal.
      // Bank posting locks its transaction first. NOWAIT lets the caller retry
      // after it commits without creating a document↔transaction lock cycle.
      const linkedTransactions = await client.query(
        `select t.id from transactions t
          where t.firm_id = $1 and t.client_id = $2
            and (t.document_id = $3 or exists (
              select 1 from reconciliation_matches m
               where m.firm_id = t.firm_id and m.client_id = t.client_id
                 and m.bank_transaction_id = t.id and m.matched_object_id = $3
                 and m.status in ('confirmed', 'auto_matched')
            ))
          order by t.id for update of t nowait`,
        [firmId, doc.client_id, documentId]
      );
      const posted = await client.query(
        `select id from ledger_journals
          where firm_id = $1 and client_id = $2 and status in ('posted', 'closed')
            and (source_id = $3 or payload #>> '{settlement,document_id}' = $3
              or (source_type = 'transaction' and source_id = any($4::text[])))
          limit 1`,
        [firmId, doc.client_id, documentId, linkedTransactions.rows.map((row) => row.id)]
      );
      if (posted.rows.length) {
        throw buildError('This document already has a posted journal. Use a ledger adjustment to correct its currency.',
          'DOCUMENT_POSTED_CURRENCY_IMMUTABLE', 409);
      }
    }

    // Stamp prior_value from whichever source is canonical for
    // this field. Writeback fields read their `documents` column;
    // record-only fields (counterparty_role, document_type) read
    // a derived value so the few-shot has a coherent diff.
    let priorValue;
    if (spec.writeback) {
      priorValue = doc[spec.writeback];
    } else if (fieldPath === 'counterparty_role') {
      priorValue = doc.direction === 'ar' ? 'customer'
        : doc.direction === 'ap' ? 'vendor'
        : null;
    } else if (fieldPath === 'document_type') {
      priorValue = doc.document_type;
    } else {
      priorValue = null;
    }
    if (priorValue === undefined) priorValue = null;

    const id = crypto.randomUUID();
    const insertResult = await client.query(
      `insert into document_corrections
         (id, firm_id, client_id, document_id, field_path,
          prior_value, corrected_value, source, corrected_by, document_type)
       values ($1, $2, $3, $4, $5,
               $6::jsonb, $7::jsonb, 'manual', $8, $9)
       returning id, firm_id, client_id, document_id, field_path,
                 prior_value, corrected_value, source, corrected_by,
                 document_type, corrected_at`,
      [
        id, firmId, doc.client_id, documentId, fieldPath,
        JSON.stringify(priorValue),
        JSON.stringify(value),
        correctedBy,
        doc.document_type
      ]
    );

    if (spec.writeback) {
      await client.query(
        `update documents
            set ${spec.writeback} = $3, updated_at = now()
          where firm_id=$1 and id=$2`,
        [firmId, documentId, value]
      );
    }

    await client.query(
      `insert into audit_events
         (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata, actor_id)
       values ($1, $2, 'firm', 'document.correction', 'document', $3, $4::jsonb, $5)`,
      [
        firmId, doc.client_id || null, documentId,
        JSON.stringify({
          field_path: fieldPath,
          prior_value: priorValue,
          corrected_value: value,
          corrected_by: correctedBy,
          writeback: Boolean(spec.writeback),
          ...(sourceModel ? { model: sourceModel } : {}),
          ...(fieldPath === 'currency' ? { authority_basis: 'human_source_currency_confirmation' } : {})
        }),
        correctedBy
      ]
    );

    // FI-02 (INV-11): a MATERIAL correction makes the document's settled
    // matches ineligible and supersedes its verdicts in THIS transaction, so
    // the correction never commits without its reconciliation consequence.
    // The reopen and the fresh evaluation follow (recordDocumentCorrectionInDb).
    const reconciliation = await invalidateReconciliationForCorrectedDocument({
      client, firmId, clientId: doc.client_id, documentId, correctionId: id, fieldPath
    });

    await client.query('commit');
    // Donna Loops Phase 8 producer (§13.10, post-commit, no-throw, LOOPS_SHADOW-gated):
    // a MATERIAL correction (totals / dates / direction / type / payment status) may have
    // moved the basis a settled reconciliation match was built on, so enqueue a
    // goal.regressed row for the document's reconciliation case. Self-filters to material
    // fields; the dispatcher reopens only a case whose goal was actually MET.
    await onDocumentCorrected({
      client, firmId, clientId: doc.client_id || null,
      documentId, fieldPath, correctionId: insertResult.rows[0]?.id || id,
      invalidatedMatchIds: reconciliation.invalidated,
      bankTransactionIds: reconciliation.bank_transaction_ids
    });
    return {
      ...correctionRowToDto(insertResult.rows[0]),
      reconciliation: {
        invalidated_match_ids: reconciliation.invalidated,
        superseded_evaluation_ids: reconciliation.superseded_evaluations
      }
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
};

export const recordDocumentCorrectionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  documentId,
  fieldPath,
  correctedValue,
  correctedBy = null,
  clientId = null,
  sourceModel = null
} = {}) => {
  const correction = await withFirmDbClient((client) =>
    __recordDocumentCorrectionWithClient({
      client, firmId, documentId, fieldPath, correctedValue, correctedBy, clientId, sourceModel
    })
  );
  // After the correction's checkout is released (the match writer takes its
  // own): reopen what the correction invalidated. A failure here leaves the
  // marker in place and the family re-drive finishes the reopen on its next
  // tick, so the committed correction is never reported as failed.
  if (correction?.reconciliation?.invalidated_match_ids?.length) {
    try {
      correction.reconciliation.reopened = await reopenMatchesInvalidatedByCorrection({
        firmId, clientId: correction.client_id, documentId
      });
    } catch (error) {
      console.error('[documentCorrections] reopen after correction failed; the re-drive will finish it', {
        firmId, documentId, error: error?.message || String(error)
      });
      correction.reconciliation.reopen_error = error?.message || String(error);
    }
  }
  return correction;
};

// FI-02 — the REOPEN half of a material correction. Each settled match the
// correction invalidated leaves the settled set through the named match writer
// (updateReconciliationMatchInDb → 'suggested': the line it settled reopens,
// the document's payment status, credit applications and covering grant
// unwind the way every un-settle does; no journal is touched). The live marker
// then becomes a receipt (`reopened_by_correction`), so a fresh evaluation
// that re-settles the same pair is sticky again. Idempotent: it acts only on
// settled rows still carrying the live marker; the family re-drive calls it
// again before every fresh evaluation.
export const reopenMatchesInvalidatedByCorrection = async ({
  firmId = DEFAULT_FIRM_ID, clientId, documentId,
  updateMatchFn = updateReconciliationMatchInDb, queryFn = queryFirmDb
} = {}) => {
  if (!clientId || !documentId) return [];
  const pending = await queryFn(
    `select id, status, payload->'invalidated_by_correction' as marker
       from reconciliation_matches
      where firm_id = $1 and client_id = $2 and matched_object_id = $3
        and matched_object_type = any($4::text[])
        and coalesce(payload->'invalidated_by_correction', 'null'::jsonb) <> 'null'::jsonb
      order by id`,
    [firmId, clientId, documentId, [...DOCUMENT_MATCH_TYPES_LOCKSTEP]]
  );
  const reopened = [];
  for (const row of pending.rows || []) {
    let change = null;
    if (row.status === 'confirmed' || row.status === 'auto_matched') {
      change = await updateMatchFn({
        firmId, matchId: row.id, actorId: 'system', captureBeforeState: true, returnSnapshot: false,
        patch: { status: 'suggested', reviewer_note: `Reopened: the document's ${row.marker?.field_path || 'basis'} was corrected` }
      });
    }
    // The marker becomes the receipt. `updated_at` is left alone so the
    // retire step can tell a pair the fresh evaluation re-proposed (its
    // upsert bumps updated_at past reopened_at) from one it did not.
    await queryFn(
      `update reconciliation_matches
          set payload = (payload - 'invalidated_by_correction' - 'fresh_evaluation_required')
            || jsonb_build_object('reopened_by_correction',
                 (payload->'invalidated_by_correction') || jsonb_build_object(
                   'prior_status', $4::text, 'reopened_at', now()))
        where firm_id = $1 and client_id = $2 and id = $3
          and coalesce(payload->'invalidated_by_correction', 'null'::jsonb) <> 'null'::jsonb
          and status in ('suggested', 'rejected')`,
      [firmId, clientId, row.id, row.status]
    );
    reopened.push({ match_id: row.id, prior_status: row.status, before_state: change?.before_state || null, after_state: change?.after_state || null });
  }
  return reopened;
};

// FI-02 — after the fresh evaluation ran: a reopened pair the evaluation did
// NOT re-propose is a stale suggestion with nothing behind it. It is retired
// through the named writer (system 'rejected', the crossed-edge retirement
// shape), so neither the line nor the document rests on it; the fresh verdict
// is what the document now stands on. A pair the evaluation re-proposed was
// refreshed by its upsert (updated_at past reopened_at) and is left to the
// verdict that wrote it.
export const retireUnrefreshedReopenedMatches = async ({
  firmId = DEFAULT_FIRM_ID, clientId, documentId,
  updateMatchFn = updateReconciliationMatchInDb, queryFn = queryFirmDb
} = {}) => {
  if (!clientId || !documentId) return [];
  const stale = await queryFn(
    `select m.id
       from reconciliation_matches m
      where m.firm_id = $1 and m.client_id = $2 and m.matched_object_id = $3
        and m.matched_object_type = any($4::text[])
        and m.status = 'suggested'
        and m.updated_at <= (m.payload->'reopened_by_correction'->>'reopened_at')::timestamptz
        and exists (
          select 1 from reconciliation_evaluations e
           where e.firm_id = m.firm_id and e.client_id = m.client_id
             and e.target_type = 'document' and e.target_id = m.matched_object_id
             and e.verdict <> 'superseded'
             and e.payload->>'matcher_mode' is distinct from 'shadow'
             and e.evaluated_at > (m.payload->'reopened_by_correction'->>'reopened_at')::timestamptz)
      order by m.id`,
    [firmId, clientId, documentId, [...DOCUMENT_MATCH_TYPES_LOCKSTEP]]
  );
  const retired = [];
  for (const row of stale.rows || []) {
    await updateMatchFn({
      firmId, matchId: row.id, actorId: 'system', captureBeforeState: true, returnSnapshot: false,
      patch: { status: 'rejected', reviewer_note: 'Retired: the fresh evaluation after the correction did not propose this pair' }
    });
    retired.push(row.id);
  }
  return retired;
};


export const getDocumentCorrectionsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  documentId
} = {}) => {
  if (!documentId) {
    throw buildError('document_id is required', 'DOCUMENT_ID_REQUIRED', 400);
  }
  const result = await queryFirmDb(
    `select id, firm_id, client_id, document_id, field_path,
            prior_value, corrected_value, source, corrected_by,
            document_type, corrected_at
       from document_corrections
      where firm_id=$1 and document_id=$2
      order by corrected_at desc`,
    [firmId, documentId]
  );
  return result.rows.map(correctionRowToDto);
};

// DMEM-R1 W1 (2026-09-04, doctrine INV-12 / INV-13; audit F-07, S02/L2): a
// correction is an example scoped to the LEGAL ENTITY it was recorded on. The
// few-shot read hard-filters scope BEFORE limiting — client (mandatory: a read
// with no legal entity returns NOTHING, it never restores the firm-wide
// context), document class, counterparty and jurisdiction when the caller
// knows them, and the document's own lineage (a re-parse of the corrected
// document, or of the document it duplicates, sees its corrections whatever
// the counterparty filter says). Every row comes back with its scope labels
// so the prompt fragment can carry them (§2.5: labels survive into the packet).
//
//   clientId       — REQUIRED; absent ⇒ [] (fail closed, INV-13)
//   documentType   — the routed class; when given, only corrections recorded on
//                    that class (a null class is not a wildcard: it excludes)
//   counterparty   — the document's vendor/customer name when already known
//                    (a re-parse); matched case-insensitively against the
//                    corrected document's own vendor_name / customer_name
//   jurisdiction   — the client's jurisdiction, carried as a label (a client has
//                    one jurisdiction, so the client filter already enforces it)
//   lineage        — { documentId, duplicateOf } — corrections on THESE documents
//                    are admitted regardless of the counterparty filter
export const getRecentFirmCorrectionsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId = null,
  documentType = null,
  counterparty = null,
  jurisdiction = null,
  lineage = null,
  limit = FEW_SHOT_DEFAULT_LIMIT
} = {}) => {
  if (!clientId) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || FEW_SHOT_DEFAULT_LIMIT, 100));
  const lineageIds = [...new Set([lineage?.documentId, lineage?.duplicateOf].filter(Boolean).map(String))];
  const counterpartyText = String(counterparty || '').trim().toLowerCase() || null;
  const params = [firmId, String(clientId), documentType ? String(documentType) : null, counterpartyText, lineageIds, safeLimit];
  const result = await queryFirmDb(
    `select c.id, c.firm_id, c.client_id, c.document_id, c.field_path,
            c.prior_value, c.corrected_value, c.source, c.corrected_by,
            c.document_type, c.corrected_at,
            d.vendor_name as document_vendor_name, d.customer_name as document_customer_name,
            (c.document_id = any($5::text[])) as same_lineage
       from document_corrections c
       left join documents d on d.id = c.document_id and d.firm_id = c.firm_id
      where c.firm_id = $1
        and c.client_id = $2
        and ($3::text is null or c.document_type = $3)
        and (
          c.document_id = any($5::text[])
          or $4::text is null
          or lower(coalesce(d.vendor_name, '')) = $4
          or lower(coalesce(d.customer_name, '')) = $4
        )
      order by same_lineage desc, c.corrected_at desc
      limit $6`,
    params
  );
  return result.rows.map((row) => ({
    ...correctionRowToDto(row),
    scope: {
      client_id: row.client_id,
      document_type: row.document_type || null,
      counterparty: row.document_vendor_name || row.document_customer_name || null,
      jurisdiction: jurisdiction || null,
      lineage: row.same_lineage ? 'same_document' : (counterpartyText ? 'same_counterparty' : 'same_entity_and_class')
    }
  }));
};

// Render a JSON value as a compact human-readable token for the
// few-shot prompt. Strings get quoted; null renders as "(empty)";
// numbers and booleans pass through.
const renderValue = (value) => {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

// Format the most-recent correction per (field_path, document_type)
// as a compact "previously corrected" prompt section. The unified
// extractor appends this to its user prompt so the strong model
// sees the firm's accumulated correction history as few-shot
// alongside the firm-side anchor + the document.
//
// Deduplication: corrections is expected to arrive ordered by
// corrected_at DESC (which is what
// `getRecentFirmCorrectionsFromDb` returns). For each
// (field_path, document_type) the FIRST entry wins — later (older)
// entries are skipped. This means a follow-up correction overrides
// a stale one without us needing a SQL DISTINCT ON.
export const buildCorrectionsPromptFragment = (corrections, {
  maxEntries = FEW_SHOT_MAX_PROMPT_ENTRIES,
  documentType = null
} = {}) => {
  if (!Array.isArray(corrections) || corrections.length === 0) return '';
  const seen = new Set();
  const lines = [];
  for (const c of corrections) {
    if (!c?.field_path) continue;
    // If a documentType filter is supplied, only show corrections
    // recorded on the same document_type — receipts shouldn't
    // contaminate sales_invoice prompts and vice versa. When the
    // filter is null, every type is included (used by tests and
    // by callers that want the full history).
    if (documentType && c.document_type && c.document_type !== documentType) continue;
    const key = `${c.field_path}|${c.document_type || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // W1 (INV-12 / §2.5): each example keeps its scope labels in the packet —
    // whose correction this is, on which class, for which counterparty and
    // jurisdiction, and how it relates to the document being parsed.
    const scope = c.scope && typeof c.scope === 'object' ? c.scope : null;
    const labels = scope
      ? [
        `entity ${scope.client_id || 'unknown'}`,
        scope.document_type ? `class ${scope.document_type}` : null,
        scope.counterparty ? `counterparty "${scope.counterparty}"` : null,
        scope.jurisdiction ? `jurisdiction ${scope.jurisdiction}` : null,
        scope.lineage ? `basis ${scope.lineage.replace(/_/g, ' ')}` : null
      ].filter(Boolean).join(' · ')
      : null;
    lines.push(`- ${c.field_path}: ${renderValue(c.prior_value)} → ${renderValue(c.corrected_value)}${labels ? ` [${labels}]` : ''}`);
    if (lines.length >= maxEntries) break;
  }
  if (!lines.length) return '';
  return `

PRIOR CORRECTIONS — when this legal entity's earlier documents of the same class were parsed, a human corrected the following fields (each example names its scope; an example from another entity is never shown). When the same situation applies on the document above, prefer the corrected interpretation:
${lines.join('\n')}`;
};

export const __TEST__ = Object.freeze({
  FIELD_SPECS,
  validateValue,
  renderValue,
  PAYMENT_STATUS_VOCAB,
  DOCUMENT_TYPE_VOCAB,
  COUNTERPARTY_ROLE_VOCAB
});
