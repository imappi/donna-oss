// server/donna/db/documents.js — plane S — document rows: the statement/document import writer, document update/delete, payment status after a match.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { __clearReconciliationMatchesForDuplicateWithClient, __promoteDuplicateHeirsWithClient, __unwindTransactionMatchesForDocumentWithClient } from '../parseDocumentsDb.js';
import { reverseCreditApplicationsForDocument, reverseReminderSettlementWithClient } from '../creditNoteApplications.js';
import { toIsoDay } from '../dates.js';

import { withFirmDbClient } from './pool.js';
import { buildMultiRowValues, chunk, dateOrNull, MULTI_ROW_CHUNK_SIZE, numberOrNull } from './shared.js';
import { DEFAULT_FIRM_ID } from './clients.js';
import { refreshTransactionIntelForClient } from './transactions.js';
import { detectLateBankLineAfterMatch } from './reconcile.js';
import { __heldFiscalYearsForRetention } from './close.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

export const rowToDocumentPayload = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  client_id: row.client_id,
  filename: row.filename,
  document_type: row.document_type,
  status: row.status,
  uploaded_at: row.uploaded_at ? new Date(row.uploaded_at).getTime() : row.payload?.uploaded_at,
  source: row.source || row.payload?.source,
  file_url: row.file_url || row.payload?.file_url,
  // Owner uploads persist storage metadata without a top-level file_size.
  // Normalize at the shared read boundary; historical payloads stay untouched.
  file_size: row.payload?.file_size ?? row.payload?.file_storage?.size,
  vendor_name: row.vendor_name || row.payload?.vendor_name,
  customer_name: row.customer_name || row.payload?.customer_name,
  // PostgreSQL DATE arrives at local midnight. Normalize before JSON turns
  // it into a UTC instant and moves the printed day on positive-offset Macs.
  document_date: row.document_date ? toIsoDay(row.document_date) : row.payload?.document_date,
  due_date: row.due_date ? toIsoDay(row.due_date) : row.payload?.due_date,
  total_amount: row.total_amount == null ? row.payload?.total_amount : Number(row.total_amount),
  currency: Object.hasOwn(row, 'currency') ? row.currency
    : row.parse_summary?.currency_resolution ? row.parse_summary.currency_resolution.currency ?? null
      : row.payload?.currency,
  tax_amount: row.tax_amount == null ? row.payload?.tax_amount : Number(row.tax_amount),
  reference_number: row.reference_number || row.payload?.reference_number,
  payment_status: row.payment_status || row.payload?.payment_status,
  extraction_confidence:
    row.extraction_confidence == null ? row.payload?.extraction_confidence : Number(row.extraction_confidence),
  parse_status: row.parse_status || 'completed',
  parse_summary: row.parse_summary || row.payload?.parse_summary || null,
  ...(row.parse_error !== undefined ? { parse_error: row.parse_error } : {}),
  ...(row.duplicate_of !== undefined ? { duplicate_of: row.duplicate_of } : {}),
  parse_completed_at: row.parse_completed_at
    ? new Date(row.parse_completed_at).getTime()
    : row.payload?.parse_completed_at || null,
  batch_id: row.batch_id || row.payload?.batch_id || null,
  // RT-17 PR 8 — the persisted two-terminal verdict (RT-13, migration 137;
  // NULL = not a reconcile row) rides the DTO whenever the row was read with
  // the column; a row read without it carries nothing.
  ...(row.convergence_state !== undefined
    ? { convergence_state: row.convergence_state ?? null, convergence_reason: row.convergence_reason ?? null }
    : {}),
  created_at: row.created_at ? new Date(row.created_at).toISOString() : row.payload?.created_at || null
});

const documentTotalAmount = (document = {}) =>
  numberOrNull(document.total_amount ?? document.totalAmount ?? document.amount);

const documentReferenceNumber = (document = {}) =>
  document.reference_number || document.referenceNumber || document.invoice_number || document.bill_number || null;

export const syncDocumentsAndTransactionsInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  documents = [],
  transactions = [],
  replaceDocumentIds = []
} = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const replacementIds = replaceDocumentIds.filter(Boolean);
      if (replacementIds.length) {
        await client.query(
          'delete from transactions where firm_id = $1 and document_id = any($2::text[])',
          [firmId, replacementIds]
        );
        const incomingDocumentIds = documents.map((document) => document?.id).filter(Boolean);
        // Unwind any confirmed transaction matches whose target is one
        // of the to-be-deleted docs, and delete the docs' match rows
        // (dangling matched_object_id rows read as "line taken" to the
        // matchers — the June 2026 Honeybee orphan class). Symmetric
        // inverse of the confirm path at firmDb.js:2762-2779. See
        // helper docstrings for the full asymmetric-cleanup story.
        // Loop is intentionally simple — replacementIds is bounded to
        // the size of one /documents/sync call, typically a handful.
        for (const docId of replacementIds) {
          if (!incomingDocumentIds.includes(docId)) {
            await __clearReconciliationMatchesForDuplicateWithClient(client, {
              firmId,
              documentId: docId
            });
            await __unwindTransactionMatchesForDocumentWithClient(client, {
              firmId,
              documentId: docId
            });
          }
        }
        const deletedDocuments = await client.query(
          `delete from documents
           where firm_id = $1
             and id = any($2::text[])
             and not (id = any($3::text[]))
           returning id`,
          [firmId, replacementIds, incomingDocumentIds]
        );
        // Repoint the rows that named a deleted doc as their canonical
        // (duplicate_of has no FK) — one heir per (client, bytes); see the
        // single-doc delete path below for the integrity story.
        await __promoteDuplicateHeirsWithClient(client, {
          firmId,
          deletedIds: deletedDocuments.rows.map((row) => row.id),
          excludeIds: incomingDocumentIds
        });
      }

      // Batched multi-row upserts. Statement uploads commonly produce
      // hundreds of transaction rows; the prior per-row loop did one DB
      // round-trip each, which on Vercel's serverless gateway pushed
      // /documents/sync past the 60s timeout and surfaced as 504s. One
      // chunked `INSERT … VALUES (...), (...) … ON CONFLICT` collapses
      // those round-trips into a handful.
      const documentRows = documents.filter((document) => document?.id && document?.client_id);
      // Pre-compute synthetic per-document parse_summary keyed on doc id.
      // /documents/sync is the legacy synchronous path: every doc it
      // writes is, by definition, already fully parsed, so we mint a
      // 'completed' status and a small summary (transaction count from
      // this same batch) inline. PR 2's async worker will be the only
      // writer of intermediate parse states.
      const syntheticParseSummaryByDocId = new Map();
      for (const transaction of transactions) {
        const documentId = transaction?.document_id;
        if (!documentId) continue;
        syntheticParseSummaryByDocId.set(
          documentId,
          (syntheticParseSummaryByDocId.get(documentId) || 0) + 1
        );
      }
      const TYPES_REQUIRING_EXTRACTION = new Set(['supplier_bill', 'receipt', 'sales_invoice', 'payment_confirmation']);
      const documentColumnCasts = ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '::jsonb', '', '::jsonb', ''];
      const documentValueFn = (document) => {
        const docType = document.document_type || 'unknown';
        const hasExtraction = document.vendor_name || document.vendorName
          || document.total_amount || document.totalAmount
          || document.customer_name || document.customerName;
        const needsParsing = TYPES_REQUIRING_EXTRACTION.has(docType) && !hasExtraction;
        return [
        document.id,
        firmId,
        document.client_id,
        document.filename || document.document_label || document.id,
        docType,
        document.status || 'received',
        document.uploaded_at ? new Date(Number(document.uploaded_at)).toISOString() : null,
        document.source || 'upload',
        document.file_url || null,
        document.vendor_name || document.vendorName || null,
        document.customer_name || document.customerName || null,
        dateOrNull(document.document_date || document.documentDate),
        dateOrNull(document.due_date || document.dueDate),
        documentTotalAmount(document),
        document.currency || document.statement_currency || null,
        numberOrNull(document.tax_amount || document.taxAmount),
        documentReferenceNumber(document),
        document.payment_status || 'unknown',
        numberOrNull(document.extraction_confidence || document.extractionConfidence),
        JSON.stringify(document),
        needsParsing ? 'pending' : 'completed',
        needsParsing ? null : JSON.stringify({
          source: 'documents_sync',
          transaction_count: syntheticParseSummaryByDocId.get(document.id) || 0
        }),
        needsParsing ? null : new Date().toISOString()
      ];
      };
      for (const batch of chunk(documentRows, MULTI_ROW_CHUNK_SIZE)) {
        if (!batch.length) continue;
        const { sql, params } = buildMultiRowValues(batch, documentValueFn, documentColumnCasts);
        await client.query(
          `insert into documents (
             id, firm_id, client_id, filename, document_type, status, uploaded_at,
             source, file_url, vendor_name, customer_name, document_date, due_date,
             total_amount, currency, tax_amount, reference_number, payment_status, extraction_confidence, payload,
             parse_status, parse_summary, parse_completed_at
           )
           values ${sql}
           on conflict (id) do update set
             client_id = excluded.client_id,
             filename = excluded.filename,
             document_type = excluded.document_type,
             status = excluded.status,
             uploaded_at = excluded.uploaded_at,
             source = excluded.source,
             file_url = excluded.file_url,
             vendor_name = excluded.vendor_name,
             customer_name = excluded.customer_name,
             document_date = excluded.document_date,
             due_date = excluded.due_date,
             total_amount = excluded.total_amount,
             currency = excluded.currency,
             tax_amount = excluded.tax_amount,
             reference_number = excluded.reference_number,
             -- F2: a re-import must not regress a SETTLED doc's payment flip —
             -- the settlement post set 'paid' off an owner-authorized entry;
             -- the parse-time value (often 'unpaid'/'unknown') would reopen a
             -- doc/ledger split-brain the FYI rail then double-notifies.
             payment_status = case
               when coalesce(documents.payload->'settlement_entry'->>'journal_id', '') <> ''
                 then documents.payment_status
               else excluded.payment_status
             end,
             extraction_confidence = excluded.extraction_confidence,
             -- F2: merge, never wholesale-replace. A re-import/re-sync used to
             -- overwrite the whole payload, wiping the producer-owned keys the
             -- loop's state machine lives in (no_line_disposition,
             -- settlement_entry, coding_auto_post — each carrying
             -- owner_notified). The merge keeps any key the import doesn't
             -- itself carry; keys the import DOES carry behave as before.
             payload = coalesce(documents.payload, '{}'::jsonb) || excluded.payload,
             parse_status = excluded.parse_status,
             parse_summary = excluded.parse_summary,
             parse_completed_at = excluded.parse_completed_at,
             updated_at = now()`,
          params
        );
      }

      const transactionRows = transactions.filter((transaction) => transaction?.id && transaction?.client_id);
      const transactionColumnCasts = ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '::jsonb'];
      const transactionValueFn = (transaction) => [
        transaction.id,
        firmId,
        transaction.client_id,
        transaction.document_id || null,
        transaction.date || null,
        transaction.description || null,
        Number(transaction.money_in || 0),
        Number(transaction.money_out || 0),
        transaction.account_currency || transaction.currency || null,
        transaction.status || 'needs_review',
        transaction.external_transaction_id || transaction.externalTransactionId || null,
        transaction.raw_description || transaction.description || null,
        transaction.cleaned_description || null,
        transaction.direction || null,
        transaction.category || null,
        transaction.account_code || transaction.proposed_account || null,
        numberOrNull(transaction.confidence_score),
        transaction.reconciliation_status || 'pending',
        JSON.stringify(transaction)
      ];
      for (const batch of chunk(transactionRows, MULTI_ROW_CHUNK_SIZE)) {
        if (!batch.length) continue;
        const { sql, params } = buildMultiRowValues(batch, transactionValueFn, transactionColumnCasts);
        // Re-parse / re-sync MUST NOT clobber firm decisions. Once a
        // transaction has moved past `needs_review` — i.e. the firm
        // marked it ready, posted it to the local ledger, synced it to
        // Xero, etc — only the firm can change `status`, `category`,
        // `account_code`, `reconciliation_status`, and the ledger /
        // contact fields baked into `payload`. Two-layer protection:
        //   1. The WHERE clause on the ON CONFLICT branch skips the
        //      whole update for rows past review.
        //   2. The SET list deliberately omits status / category /
        //      account_code / reconciliation_status / payload, so even
        //      on a needs_review row we only refresh the parser-output
        //      columns. (We still write `payload` on the initial
        //      INSERT — that's where the parser puts its raw output;
        //      we just don't overwrite it on re-parse.)
        await client.query(
          `insert into transactions (
            id, firm_id, client_id, document_id, transaction_date, description, money_in, money_out, currency, status,
            external_transaction_id, raw_description, cleaned_description, direction, category, account_code,
            confidence_score, reconciliation_status, payload
          )
          values ${sql}
          on conflict (id) do update set
            client_id = excluded.client_id,
            document_id = excluded.document_id,
            transaction_date = excluded.transaction_date,
            description = excluded.description,
            money_in = excluded.money_in,
            money_out = excluded.money_out,
            currency = excluded.currency,
            external_transaction_id = excluded.external_transaction_id,
            raw_description = excluded.raw_description,
            cleaned_description = excluded.cleaned_description,
            direction = excluded.direction,
            confidence_score = excluded.confidence_score,
            updated_at = now()
          where transactions.status = 'needs_review'`,
          params
        );
      }

      const touchedClientIds = [
        ...new Set([
          ...documents.map((document) => document?.client_id).filter(Boolean),
          ...transactions.map((transaction) => transaction?.client_id).filter(Boolean)
        ])
      ];
      for (const clientId of touchedClientIds) {
        await refreshTransactionIntelForClient({ client, firmId, clientId });
      }

      await client.query(
        `insert into audit_events (firm_id, actor_type, action, resource_type, metadata)
         values ($1, 'system', 'documents.sync', 'document', $2::jsonb)`,
        [
          firmId,
          JSON.stringify({
            document_count: documents.length,
            transaction_count: transactions.length,
            transaction_intel_client_count: touchedClientIds.length
          })
        ]
      );

      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// Server-owned identity/reference keys: they are written only by the
// registration/parse writers. A generic patch merges into payload, and payload
// once fed the download projection, so these can never be set, changed or
// deleted (a null value is a delete) through updateDocumentInDb.
export const RESERVED_DOCUMENT_PATCH_KEYS = Object.freeze([
  'id', 'firm_id', 'client_id',
  'storage_bucket', 'storage_key', 'storage_object_key', 'storage_provider', 'file_storage',
  'checksum', 'checksum_sha256'
]);

// The HTTP review surface (PATCH /documents/:id) may write ONLY the human
// review fields. Every other payload key is producer-owned: the persisted
// two-terminal verdict (no_line_disposition), the settlement/credit/reminder
// records, the immateriality verdict, parse lineage, and the type/status/hold
// columns are written by the server callers that own them, which pass
// `producer: true`. An allowlist, not a denylist — a new producer key is
// protected by default. The review-note attribution (reviewer_note_by/_at) is
// stamped from the acting principal below, never taken from the body.
export const HTTP_DOCUMENT_PATCH_KEYS = Object.freeze(['reviewer_note', 'follow_up_at', 'reviewed_at']);

export const updateDocumentInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  documentId,
  patch = {},
  producer = false,
  actor = null
} = {}) => {
  if (!documentId) {
    const error = new Error('Document id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!producer) {
    const notAllowed = Object.keys(patch || {}).filter((key) => !HTTP_DOCUMENT_PATCH_KEYS.includes(key));
    if (notAllowed.length) {
      const error = new Error(`Document patch may not set server-owned fields: ${notAllowed.join(', ')}.`);
      error.statusCode = 400;
      error.code = 'DOCUMENT_PATCH_RESERVED_KEY';
      error.details = { keys: notAllowed };
      throw error;
    }
    if (Object.hasOwn(patch || {}, 'reviewer_note') && actor?.actorId) {
      patch = { ...patch, reviewer_note_by: actor.actorId, reviewer_note_at: new Date().toISOString() };
    }
  }
  const reserved = RESERVED_DOCUMENT_PATCH_KEYS.filter((key) => Object.hasOwn(patch || {}, key));
  if (reserved.length) {
    const error = new Error(`Document patch may not set server-owned fields: ${reserved.join(', ')}.`);
    error.statusCode = 400;
    error.code = 'DOCUMENT_PATCH_RESERVED_KEY';
    error.details = { keys: reserved };
    throw error;
  }

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      // F2: FOR UPDATE — this is a read-modify-write that replaces the whole
      // payload below; without the row lock, a concurrent producer merge (the
      // drain's no_line_disposition, an owner_notified flip, the settlement
      // writer) landing between this read and the write was silently erased.
      const existing = await client.query('select payload from documents where firm_id = $1 and id = $2 for update', [firmId, documentId]);
      if (!existing.rows.length) {
        const error = new Error('Document not found.');
        error.statusCode = 404;
        throw error;
      }
      const payload = { ...(existing.rows[0].payload || {}), ...patch };
      await client.query(
        `update documents
         set document_type = coalesce($3::text, document_type), status = coalesce($4::text, status), payload = $5::jsonb, updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, documentId, payload.document_type || null, payload.status || null, JSON.stringify(payload)]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, 'document.update', 'document', $5, $6::jsonb)`,
        [firmId, payload.client_id || null, actor?.actorType || 'system', actor?.actorId || null, documentId, JSON.stringify({ patch_keys: Object.keys(patch) })]
      );
      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// One-row access-check lookup. The document routes used to build a FULL
// firm snapshot just to learn which client a document belongs to (the
// snapshot precheck was ~half of every delete's cost — the 2026-07-21
// multi-delete slowness); the scope check only needs this value.
export const getDocumentClientIdInDb = async ({ firmId = DEFAULT_FIRM_ID, documentId } = {}) => {
  if (!documentId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      'select client_id from documents where firm_id = $1 and id = $2 limit 1',
      [firmId, documentId]
    );
    return result.rows[0]?.client_id || null;
  });
};

export const deleteDocumentInDb = async ({ firmId = DEFAULT_FIRM_ID, documentId, withFirmDbClientFn = withFirmDbClient } = {}) => {
  if (!documentId) {
    const error = new Error('Document id is required.');
    error.statusCode = 400;
    throw error;
  }
  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      const existing = await client.query(
        `select id, client_id, filename, document_type, payload,
                document_date::text as document_date, uploaded_at::text as uploaded_at
           from documents where firm_id = $1 and id = $2`,
        [firmId, documentId]
      );
      if (!existing.rows.length) {
        const error = new Error('Document not found.');
        error.statusCode = 404;
        throw error;
      }
      const doc = existing.rows[0];
      // G-9 (D-G9-3): a document dated inside a non-open Finnish fiscal year is
      // a tosite of the statutory book — held under KPL 2:10 for 6 years from
      // the end of the calendar year the fiscal year ended in. No per-document
      // override: the legitimate path for a wrong doc in a closed year is
      // reopening the fiscal year, not puncturing retention per row. Deletes in
      // OPEN fiscal years stay allowed (normal correction flow).
      const docDate = doc.document_date || (doc.uploaded_at ? String(doc.uploaded_at).slice(0, 10) : null);
      if (docDate) {
        const held = await __heldFiscalYearsForRetention(client, {
          firmId, clientId: doc.client_id, retentionClass: 'tosite', onDate: docDate
        });
        if (held) {
          const error = new Error(
            `KPL 2:10 retention holds this document (tosite of fiscal year ${held[0].label}) until ${held[0].hold.retain_until}.`
          );
          error.statusCode = 409;
          error.code = 'FINLAND_RETENTION_DOCUMENT_HELD';
          error.details = { fiscal_year: held[0].label, retain_until: held[0].hold.retain_until };
          throw error;
        }
      }
      await client.query(
        'delete from reconciliation_matches where firm_id = $1 and matched_object_id = $2',
        [firmId, documentId]
      );
      await client.query(
        'delete from transaction_review_queue where firm_id = $1 and item_type = $2 and item_id = $3',
        [firmId, 'document_line', documentId]
      );
      // Unwind confirmed transaction matches whose target is this doc.
      // Symmetric inverse of firmDb.js:2762-2779. See helper docstring
      // in parseDocumentsDb.js for the asymmetric-cleanup story.
      const unwound = await __unwindTransactionMatchesForDocumentWithClient(client, {
        firmId,
        documentId
      });
      // RT-27 — a deleted credit note frees the credit it applied; a deleted
      // invoice releases the credits applied to it. Receipted, and the
      // counterpart's payment_status recomputes — the FK cascade alone would
      // drop the rows and leave the invoice reading paid.
      await reverseCreditApplicationsForDocument({ client, firmId, documentId, reason: 'document_deleted', actorId: 'system' });
      const reminderReceipt = doc.payload?.reminder_obligation;
      if (reminderReceipt?.status === 'applied') await reverseReminderSettlementWithClient({client,firmId,matchId:reminderReceipt.settlement_match_id,reason:'document_deleted',actorId:'system'});
      // Delete the doc's imported transactions explicitly —
      // transactions.document_id is ON DELETE SET NULL (migration 001),
      // not cascade, so deleting a statement doc alone strands its
      // imported lines as document-less orphans (the 2026-06-11
      // Honeybee portal-replace twins were this gap in the replace
      // path). No-op for receipts/bills: transactions only ever point
      // at the statement that imported them. Match rows on those lines
      // follow via the bank_transaction_id cascade.
      const deletedTx = await client.query(
        'delete from transactions where firm_id = $1 and document_id = $2 returning id',
        [firmId, documentId]
      );
      await client.query(
        'delete from documents where firm_id = $1 and id = $2',
        [firmId, documentId]
      );
      // Repoint the rows that reference this doc as their canonical. The
      // column has no FK by design (migration 011 — "logical reference, no
      // FK"), so deleting a canonical without this leaves dangling pointers
      // that confuse re-dedup passes and break "view canonical" UI
      // affordances. One heir per (client, bytes) is promoted and the rest
      // point at it, after the delete, so the unique canonical index
      // (migration 164) never sees two canonicals of the same bytes.
      const heirs = await __promoteDuplicateHeirsWithClient(client, { firmId, deletedIds: [documentId] });
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'document.deleted', 'document', $3, $4::jsonb)`,
        [firmId, doc.client_id, documentId, JSON.stringify({
          filename: doc.filename,
          document_type: doc.document_type,
          promoted_duplicates: [...heirs.promoted, ...heirs.cleared],
          repointed_duplicates: heirs.repointed,
          transactions_deleted: deletedTx.rows.length,
          transaction_matches_unwound: unwound.unwound
        })]
      );
      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// Reconciliation PR 8 F2 / PR 9 — sum-based payment_status arithmetic
// for documents that can be settled by multiple bank transactions.
//
// Sales invoices (PR 8) and supplier bills (PR 9) both support partial
// payments — sales invoices because batched / installment customer
// payments are AR reality, bills because firms occasionally pay large
// invoices (equipment, retainer fees) in instalments. Both document
// types compute payment_status from `sum(match_amount where status
// in ('confirmed','auto_matched'))` against `total_amount`:
//   sum  >= total → 'paid'
//   sum  >  0     → 'partial'
//   sum  == 0     → 'unpaid'
//
// Receipts keep the 1:1 `'paid'`-on-confirm shortcut — receipts are
// paid-in-full at point of purchase, partial-payment isn't a concept
// on that path. `'transfer'` matches don't touch document
// payment_status at all (a transfer isn't a document).
//
// MUST run AFTER the triggering match row's status mutation has been
// flushed inside the transaction (the SUM read picks up the new
// state). The caller passes the documentId (matched_object_id) and
// the matched_object_type so the helper routes to the right branch.

export const SUM_BASED_PAYMENT_STATUS_TYPES = new Set(['sales_invoice', 'supplier_bill']);

const computeSumBasedPaymentStatus = async ({ client, firmId, documentId, matchedObjectType }) => {
  const totalResult = await client.query(
    `select total_amount from documents where firm_id = $1 and id = $2`,
    [firmId, documentId]
  );
  if (!totalResult.rows.length) return null;
  const total = Number(totalResult.rows[0].total_amount);
  if (!Number.isFinite(total) || total <= 0) {
    // No usable total — degrade to 'unpaid' rather than guessing.
    return 'unpaid';
  }
  const sumResult = await client.query(
    `select coalesce(sum(case when matched_object_id=$3 then match_amount
         else (payload->'reminder_obligation'->>'principal_amount')::numeric end), 0) as settled
       from reconciliation_matches
       where firm_id=$1 and status in ('confirmed','auto_matched')
         and ((matched_object_type=$2 and matched_object_id=$3)
           or (payload->'reminder_obligation'->>'invoice_document_id'=$3
             and payload->'reminder_obligation'->>'status'='applied'))`,
    [firmId, matchedObjectType, documentId]
  );
  let settled = Number(sumResult.rows[0]?.settled || 0);
  // RT-27 — a customer credit note APPLIED to a sales invoice settles part of
  // it without a bank line (document_credit_applications, status 'applied').
  // The invoice's remaining due is total − lines − applied credits; a
  // reversed application (a rejected settlement, a deleted document) drops
  // out of the sum and the status reverts — the same revert-on-un-confirm
  // law the match rows follow.
  if (matchedObjectType === 'sales_invoice') {
    const creditResult = await client.query(
      `select coalesce(sum(amount), 0) as applied
         from document_credit_applications
        where firm_id = $1 and invoice_document_id = $2 and status = 'applied'`,
      [firmId, documentId]
    );
    const applied = Number(creditResult.rows[0]?.applied || 0);
    if (Number.isFinite(applied) && applied > 0) settled += applied;
  }
  // 1¢ epsilon — guards against floating-point sum drift across many
  // partial payments. Same epsilon receipts' amountMatches uses.
  if (settled + 0.01 >= total) return 'paid';
  if (settled > 0) return 'partial';
  return 'unpaid';
};

// Helper — apply the sum-based payment_status to documents that
// support partial settlement (sales_invoice + supplier_bill). Other
// document types (receipt / generic 'document') keep the 1:1
// 'paid'-on-confirm shortcut PR 1 established. 'transfer' matches
// don't touch documents at all.
//
// Exported so the AR auto-explain pass (PR 10) can call it during
// the suggested → auto_matched cascade without duplicating the
// arithmetic.
export const applyDocumentPaymentStatusAfterMatch = async ({
  client,
  firmId,
  matchId,
  matchedObjectType,
  documentId
}) => {
  if (!documentId) return { lateBankLineDetected: false };
  if (matchedObjectType === 'transfer') return { lateBankLineDetected: false };
  if (SUM_BASED_PAYMENT_STATUS_TYPES.has(matchedObjectType)) {
    const nextStatus = await computeSumBasedPaymentStatus({
      client,
      firmId,
      documentId,
      matchedObjectType
    });
    if (!nextStatus) return { lateBankLineDetected: false };
    await client.query(
      `update documents
          set payment_status = $3,
              payload = payload || $4::jsonb,
              updated_at = now()
        where firm_id = $1 and id = $2`,
      [
        firmId,
        documentId,
        nextStatus,
        // RT-27: a credit-only recompute carries no match id — never overwrite
        // the stamped settlement match with null.
        JSON.stringify({ payment_status: nextStatus, ...(matchId ? { reconciliation_match_id: matchId } : {}) })
      ]
    );
    // 'paid'/'partial' is computed FROM the settled-match sum, so it doubles
    // as the settled-match-exists signal; 'unpaid' (the revert path) means no
    // settled match remains and there is nothing to guard.
    if (nextStatus === 'unpaid') return { lateBankLineDetected: false };
    return detectLateBankLineAfterMatch({ client, firmId, matchId, documentId });
  }
  // Receipts / generic 'document' — keep the 1:1 'paid'-on-confirm
  // shortcut. Partial payments aren't a concept on these paths.
  await client.query(
    `update documents
        set payment_status = 'paid',
            payload = payload || $3::jsonb,
            updated_at = now()
      where firm_id = $1 and id = $2`,
    [firmId, documentId, JSON.stringify({ payment_status: 'paid', reconciliation_match_id: matchId })]
  );
  return detectLateBankLineAfterMatch({ client, firmId, matchId, documentId });
};
