import { assertFirmAccess, resolveDesktopClientCreationPrincipal } from './authority.js';
import { readNativeChartLineage } from '../nativeChartLineage.js';
import { hash as evidenceHash } from '../jevEvidenceContract.js';
import { hasJevResolvedCoding } from '../jevDecisionReceipt.js';
import { isDeepStrictEqual } from 'node:util';
// server/donna/db/asks.js — plane C — the ask primitive: client evidence requests (create / resolve / accept / reject / cancel / amend / resend) and the ask-batch region (draft / send).
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { assertExecutionBudgetActive } from '../executionBudget.js';
import { codingEvidenceDigest, currentCodingEvidence, nativeCodingSourceReceipt, nativeReviewScopeBody, assertNativeCodingSourceWithClient } from './codingEvidence.js';
import { readJevCase, jevCasePrompt } from '../jevPreview.js';
import { emitReviewAudit } from '../reviewItem.js';
import { assertNativeCodingChoice } from '../codingAccountChoices.js';
import { hasVerifiedSourceForDiscrepancy } from '../documentAllocationComponents.js';
import { ownerReplyIdentity, assertCurrentOwnerReply } from '../ownerReplyIdentity.js';
import { isCodingPolicyError, codingPolicyReceipt } from '../codingPolicy.js';
import { recordCodingPolicyFailure, recordCodingPolicyRecovery } from '../codingPolicyRecovery.js';
import { normalizeIntelText } from '../transactionIntel.js';
import { toIsoDay } from '../dates.js';
import { suggestTransactionCoding } from '../transactionLlm.js';
// Q9 (the sole-model lab, 2026-08-16): the coding lane's model-policy
// resolution — same pattern as the disposition sweep owner (Q6c).
import { documentOwnerReplyDocumentId, redisposeDocumentOwnerReplyWithClient } from '../documentOwnerReply.js';
// `dismissFirmFact` (G2 PR-14): the reverse executor's memory leg routes a minted
// fact to the SAME governed tombstone writer the forget_fact verb uses (INV-1).
import { distillAndStageFirmFactCandidates } from '../firmFacts.js';
import { onAskBatchSent, onClientReplyReceived, onEvidenceRequestCreated } from '../loopsShadowProducers.js';
import { validateAskAddressee } from '../askAudience.js';
import { clientFlagActs, clientFlagObserves, readClientConfigSnapshot } from '../clientConfig.js';
import { readInternalPilotAccessWithClient, readInternalPilotSendContainmentWithClient } from '../internalPilotAccess.js';
import { loadEligibleCreditNotes } from '../creditNoteApplications.js';
import { checkEntityReadinessAdmissionWithClient, EntityReadinessAdmissionError, readRetainedProcessingScopeInDb } from '../runtimeReadinessAdmission.js';
// RT-16 — the ONE coding state (transactions.coding_state, migration 138):
// the machine, the legacy-input mapping, the DTO projection, the writer.
import { applyCodingTransition, applyCodingTransitionIfAllowed, codingStateFromReviewState, isDecidedCodingState, normalizeTransactionReviewState } from '../codingState.js';
import { auditTwinAgingWouldAsk, blockingOpenAskExistsSql, gatherAgedTwinAskGroups, gatherHeldMaterialAskGroups, heldMatchGroupReceipts, isSupersedableAskRow, retractAsksSettledByAutoExplain, RETRACTION_AUTOSEND_FLAG_KEY, settledBankLineSql, TWIN_AGING_ASK_FLAG_KEY, twinAskGroupReceipts } from '../reconciliationTwinAging.js';
import { askReaskNudgeDays, REASK_CADENCE_FLAG_KEY } from '../askReaskCadence.js';
import { buildCanonicalAnchor, buildDocumentCaseKey, normalizeBlockerCode } from '../askIdentity.js';
import { BANK_LINE_DISPOSITION_FAMILY, BANK_LINE_DISPOSITION_TARGET_TYPE, summarizeBankLineDispositions } from '../bankLineDispositionShape.js';
// Doc-first terminal drain (Slice 3) — constants from the dependency-free
// leaf (same TDZ reasoning as the bank-line shape import above).
import { DOCUMENT_NO_LINE_DISPOSITION_FAMILY, DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY, DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION, DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE } from '../documentDispositionShape.js';
import { assertAskDraftLocalEvidenceIntegrity, assertAskDraftTerminalCoverage, draftClientAskMessage } from '../askPipeline.js';
import { citableEvidenceCandidates, citableRefreshDue, loadLocalEvidenceCandidatesWithClient, localEvidenceCandidateReceipt } from '../localEvidenceInventory.js';
import { enrichCodingWithXeroAccount } from '../xeroAccountMatcher.js';
import { normalizeLedgerPeriod } from '../ledgerReadModel.js';

import { queryFirmDb, queryOptionalFirmDb, withFirmDbClient } from './pool.js';
import { shortHash } from './shared.js';
import { DEFAULT_FIRM_ID, loadClientOwnBankAccounts } from './clients.js';
import { amountForPayload, rowToTransactionPayload } from './transactions.js';
import { __isTerminalCodingState, assertCodingSuggestionForPolicy, resolveClientCodingPolicyWithClient, resolveCodingTransport, shouldCloseReviewForState, withClientCodingPolicy } from './coding.js';
import { linkReplyEvidenceMatchesInDb, loadMatchedDocumentsForTransactions } from './reconcile.js';
import { postLedgerTransactionInDb } from './ledger.js';
import { getXeroAccountsForClient } from './xero.js';
import { deliverEmailEvidenceAsksAfterSend, deliverSmsEvidenceAsksAfterSend, deliverTelegramEvidenceAsksAfterSend, deliverWhatsAppEvidenceAsksAfterSend } from './channels.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

export const rowToClientEvidenceRequestPayload = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  transaction_id: row.transaction_id,
  review_item_id: row.review_item_id,
  status: row.status,
  // 122 — one ask primitive, three audiences. Absent column (pre-122 row or
  // a projection that never selected it) reads 'client', byte-stable.
  audience: row.audience || 'client',
  addressee_principal_type: row.addressee_principal_type || null,
  addressee_principal_id: row.addressee_principal_id || null,
  evidence_type: row.evidence_type,
  question: row.question,
  request_payload: row.request_payload || {},
  response_payload: row.response_payload || {},
  first_sent_at: row.first_sent_at ? new Date(row.first_sent_at).toISOString() : null,
  last_sent_at: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
  send_count: Number(row.send_count || 0),
  due_at: row.due_at ? new Date(row.due_at).toISOString() : null,
  responded_at: row.responded_at ? new Date(row.responded_at).toISOString() : null,
  resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
  created_by: row.created_by || null,
  resolved_by: row.resolved_by || null,
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
});

const rowToAuditEventPayload = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  actor_type: row.actor_type || null,
  actor_id: row.actor_id || null,
  action: row.action,
  resource_type: row.resource_type || null,
  resource_id: row.resource_id || null,
  metadata: row.metadata || {},
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null
});

export const groupEvidenceAuditEventsByRequestId = (rows = []) => {
  const byRequestId = new Map();
  for (const row of rows) {
    const requestId = row.resource_type === 'client_evidence_request'
      ? row.resource_id
      : row.metadata?.evidence_request_id;
    if (!requestId) continue;
    if (!byRequestId.has(requestId)) byRequestId.set(requestId, []);
    byRequestId.get(requestId).push(rowToAuditEventPayload(row));
  }
  return byRequestId;
};

// Load the documents a client UPLOADED in reply to an evidence request, WITH
// their extracted content — header fields (vendor/customer, total, currency,
// date) plus up to 12 line items. The reply-recode used to load only
// {id, filename, document_type}, so the strong coder saw a bare filename and
// kept asking for evidence the client had already provided (e.g. a Shopify
// payout report uploaded with no text note → "the client reply field is blank").
// Giving the model the document's CONTENT is the trust-the-strong-LLM fix: it
// can read gross sales / fees / net off the report and settle the line. Shape
// mirrors loadMatchedDocumentsForTransactions so clientReplyContextInputFor can
// render either source identically. Degrades to the minimal shape on an older
// schema (missing columns / no document_lines table).
export const loadReplyDocumentsWithContent = async ({ client, firmId, clientId, documentIds = [] } = {}) => {
  const ids = (documentIds || []).filter(Boolean);
  if (!ids.length) return [];
  const docsResult = await client.query(
    `select id, filename, document_type, vendor_name, customer_name,
            total_amount, tax_amount, currency, document_date
       from documents
      where firm_id = $1 and client_id = $2 and id = any($3::text[])`,
    [firmId, clientId, ids]
  ).catch((error) => {
    // 42703 = undefined column (older schema): fall back to the minimal shape so
    // the recode still runs (just without the richer content).
    if (error?.code === '42703') {
      return client.query(
        'select id, filename, document_type from documents where firm_id = $1 and client_id = $2 and id = any($3::text[])',
        [firmId, clientId, ids]
      );
    }
    throw error;
  });
  const docs = docsResult.rows.map((row) => ({
    id: row.id,
    filename: row.filename || '',
    document_type: row.document_type || '',
    vendor_name: row.vendor_name || null,
    customer_name: row.customer_name || null,
    total_amount: row.total_amount == null ? null : Number(row.total_amount),
    tax_amount: row.tax_amount == null ? null : Number(row.tax_amount),
    currency: row.currency || null,
    document_date: row.document_date ? toIsoDay(row.document_date) : null,
    lines: []
  }));
  const linesResult = await client.query(
    `select document_id, description, amount
       from document_lines
      where firm_id = $1 and document_id = any($2::text[])
      order by document_id, line_no asc`,
    [firmId, ids]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  const linesByDocument = new Map();
  for (const line of linesResult.rows) {
    const list = linesByDocument.get(line.document_id) || [];
    if (list.length < 12) {
      list.push({ description: line.description || '', amount: line.amount == null ? null : Number(line.amount) });
    }
    linesByDocument.set(line.document_id, list);
  }
  for (const doc of docs) doc.lines = linesByDocument.get(doc.id) || [];
  return docs;
};

// DMEM-R1 W1 (INV-14, audit F-11, S10/L1, S03/L1): a mint is a DRAFT. The
// envelope carries no sent stamp — `sent_at` / `first_sent_at` are null until a
// deliverer (db/channels.js) actually sends, which is also the only place
// `send_count` moves (108) and the only place the row flips draft → open.
const evidenceRequestPayloadForTransaction = ({
  requestId,
  question,
  evidenceType,
  now,
  dueAt,
  sendCount
} = {}) => ({
  id: requestId,
  status: 'draft',
  evidence_type: evidenceType,
  question,
  sent_at: null,
  first_sent_at: null,
  drafted_at: new Date(now).getTime(),
  send_count: sendCount,
  due_at: dueAt ? new Date(dueAt).getTime() : null
});

// Transactional core shared by the standalone evidence-request POST and
// the ask-batch send path. Caller owns begin/commit. `requestContext`
// merges extra keys into request_payload (e.g. ask_batch_id so a
// batched question links back to its message).
// `markTransactionNeedsClient=false` creates the request without
// flipping the anchor transaction to needs_client — used by statement
// requests, whose anchor line is merely where the counterpart account
// number was seen (often already explained); pulling it back into the
// client queue would un-converge the feed for a line that isn't itself
// in question.
//
// Exported below as `__createClientEvidenceRequestWithClient` (the house
// dbClient-injectable test seam, same shape as
// `__draftClientAskBatchWithClient`) so the F-19 id-determinism contract is
// unit-pinned: two concurrent minters observing the same state must compute the
// SAME request id and collapse through the upsert's `on conflict (id)`.
const createClientEvidenceRequestWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  reviewItemId,
  // Doc-first terminal drain (Slice 3) — the DOCUMENT anchor: a request for a
  // doc with NO bank line (transaction_id stays null; the anchor rides
  // request_payload.document_id, LOCK-STEP with openOwnerAskDocIdsFrom in
  // src/lib/documentsInbox.js and the drain sweep's already-asked skip).
  documentId,
  // The STANDING subject (2026-07-30) — a target that is not an artifact.
  //
  // Every ask before this one was about a thing: a bank line, a review item, an
  // upload. Two lanes need an ask about the BOOK instead, and neither has an
  // artifact to point at:
  //
  //   * "which of your accounts is the VAT one" (canonicalRoleAsk.js) is about
  //     the CHART. It blocks every VAT-carrying sale at once and is answered
  //     once, so anchoring it to whichever invoice tripped it first would mint a
  //     fresh ask per invoice for one standing question — the KUILI duplicate
  //     loop (migration 108) in a different costume.
  //   * a period-elapsed statement chase is about SILENCE. Nothing was imported,
  //     so there is no transaction to anchor to, which is exactly why the
  //     existing evidence-driven statement_request lane cannot express it (it
  //     requires anchor_transaction_ids[0]).
  //
  // A standing subject is a typed rung on buildCanonicalAnchor's ladder, not a
  // free-text anchor: keeping the kinds closed is what stops this parameter from
  // becoming a hole through which any caller can invent an anchor the migration
  // 108 backfill never mirrors. Adding the next kind is one rung there and one
  // parameter here.
  accountRole,
  physicalCountLineId,
  question,
  evidenceType = 'supporting_document',
  dueAt,
  actorId = 'system',
  requestContext = {},
  markTransactionNeedsClient = true,
  // 122 — one ask primitive, three audiences (design-donna-universal-mentions
  // §5). Every existing caller passes nothing and keeps minting owner asks
  // byte-identically. A 'seat'/'agent' ask names its addressee principal;
  // the shape law (askAudience.js) refuses anything else fail-closed.
  audience = 'client',
  addresseePrincipalType = null,
  addresseePrincipalId = null,
  // G2 PR-14 — optional collector the caller passes to learn whether this call
  // MINTED the ask or collapsed onto a live one. Filled in beside the upsert below;
  // deliberately not a field on the returned request payload (see the note there).
  mintOutcome = null
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  const cleanTransactionId = String(transactionId || '').trim();
  const cleanReviewItemId = String(reviewItemId || '').trim();
  const cleanDocumentId = String(documentId || '').trim();
  const cleanAccountRole = String(accountRole || '').trim();
  const cleanQuestion = String(question || '').trim();
  const cleanEvidenceType = String(evidenceType || 'supporting_document').trim() || 'supporting_document';
  // Exactly one standing kind today. Kept as a named boolean so the next kind is
  // an `|| cleanPeriodKey` here rather than a re-reading of every branch below.
  const cleanPhysicalCountLineId = String(physicalCountLineId || '').trim();
  const hasStandingSubject = Boolean(cleanAccountRole || cleanPhysicalCountLineId);
  if (cleanPhysicalCountLineId) {
    const target = await client.query(
      `select l.id from inventory_count_lines l
       join inventory_count_sessions s on s.id=l.count_session_id
       where l.id::text=$3 and l.firm_id=$1 and l.client_id=$2
         and s.firm_id=$1 and s.client_id=$2 for share of l, s`,
      [firmId, cleanClientId, cleanPhysicalCountLineId]);
    if (!target.rows.length || cleanTransactionId || cleanReviewItemId || cleanDocumentId || cleanAccountRole) {
      throw Object.assign(new Error('Physical ask target is missing or ambiguous.'), { code: 'PHYSICAL_ASK_TARGET_INVALID', statusCode: 404 });
    }
  }
  if (!cleanClientId || (!cleanTransactionId && !cleanReviewItemId && !cleanDocumentId && !hasStandingSubject)) {
    const error = new Error('Client id and a transaction, review item, document, or standing subject are required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_TARGET_REQUIRED';
    throw error;
  }
  // A standing ask has no artifact to derive a question from, and the default
  // wording below is artifact-shaped ("...for this transaction"). Refuse rather
  // than mint an ask whose text describes something that does not exist.
  if (hasStandingSubject && !cleanQuestion) {
    const error = new Error('A standing evidence request must carry its own question.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_QUESTION_REQUIRED';
    throw error;
  }
  // 122 — audience/addressee shape law, refused app-side before the CHECK
  // constraint can fire so the error is typed. NEVER silently downgraded: an
  // unknown audience refusing here is what keeps an internal question off the
  // owner's channels.
  const addressee = validateAskAddressee({ audience, addresseePrincipalType, addresseePrincipalId });
  if (!addressee.ok) {
    const error = new Error(`Evidence request audience/addressee invalid: ${addressee.reason}.`);
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_AUDIENCE_INVALID';
    throw error;
  }
  const askAudience = addressee.audience;
  // The needs_client / review_state 'waiting' stamps are CLIENT vocabulary —
  // a seat/agent ask must not flip a transaction to "waiting on the client".
  const stampNeedsClient = markTransactionNeedsClient && askAudience === 'client';

  let transaction = null;
  let reviewItem = null;
  if (cleanReviewItemId) {
    const reviewResult = await client.query(
      `select *
       from transaction_review_queue
       where firm_id = $1 and id = $2 and client_id = $3
       limit 1`,
      [firmId, cleanReviewItemId, cleanClientId]
    );
    reviewItem = reviewResult.rows[0] || null;
  }
  const resolvedTransactionId = cleanTransactionId || reviewItem?.payload?.transaction_id || reviewItem?.item_id || '';
  if (resolvedTransactionId) {
    const transactionResult = await client.query(
      `select *
       from transactions
       where firm_id = $1 and client_id = $2 and id = $3
       limit 1`,
      [firmId, cleanClientId, resolvedTransactionId]
    );
    transaction = transactionResult.rows[0] ? rowToTransactionPayload(transactionResult.rows[0]) : null;
  }
  if (cleanEvidenceType === 'document_discrepancy') {
    const current=(await client.query('select * from transactions where firm_id=$1 and client_id=$2 and id=$3 for update',[firmId,cleanClientId,resolvedTransactionId])).rows[0];
    const source=await currentCodingEvidence({client,firmId,clientId:cleanClientId,transactionId:resolvedTransactionId});
    // The verified source is the re-read receipt, the writer's own complete
    // source validation, or the held source with complete printed components.
    if (!current || !hasVerifiedSourceForDiscrepancy({ posting_recovery: current.payload?.posting_recovery, matched_document: source })
      || current.payload?.ai_suggestion?.posting_requirement !== 'document_discrepancy'
      || current.payload.ai_suggestion.evidence_digest !== codingEvidenceDigest(source)
      || !cleanQuestion
      || ['posted','synced','closed'].includes(current.coding_state)) {
      throw Object.assign(new Error('The document-discrepancy question is stale or has no verified source.'),{code:'POSTING_DISCREPANCY_UNVERIFIED'});
    }
    transaction=rowToTransactionPayload(current);
  }
  let document = null;
  if (cleanDocumentId) {
    const documentResult = await client.query(
      `select id, document_type, vendor_name, customer_name, filename,
              total_amount, currency, document_date,
              -- Ask identity (108): the byte hash and the duplicate pointer
              -- parseDocumentsDb already persists. Read only, never written
              -- here: that writer is on the isolation list.
              checksum_sha256, parse_status, parse_summary
       from documents
       where firm_id = $1 and client_id = $2 and id = $3
       limit 1`,
      [firmId, cleanClientId, cleanDocumentId]
    );
    document = documentResult.rows[0] || null;
  }
  // A standing subject names no row to look up, so there is nothing to find and
  // nothing to 404 on. Artifact-targeted asks are unaffected: if a caller passed
  // an id, it still has to resolve.
  if (!transaction && !reviewItem && !document && !hasStandingSubject) {
    const error = new Error('Transaction, review item, or document was not found.');
    error.statusCode = 404;
    error.code = 'EVIDENCE_REQUEST_TARGET_NOT_FOUND';
    throw error;
  }
  if (!reviewItem && transaction?.id) {
    const reviewResult = await client.query(
      `select *
       from transaction_review_queue
       where firm_id = $1
         and client_id = $2
         and (item_id = $3 or payload->>'transaction_id' = $3)
       order by updated_at desc
       limit 1`,
      [firmId, cleanClientId, transaction.id]
    );
    reviewItem = reviewResult.rows[0] || null;
  }

  const now = new Date().toISOString();
  const documentLabel = document
    ? [document.vendor_name || document.customer_name || '', document.filename || ''].filter(Boolean).join(' — ')
    : '';
  const finalQuestion = cleanQuestion ||
    (document
      ? `How was ${documentLabel || 'this document'} paid — cash, a personal card, or an account we should have a statement for?`
      : `Please confirm the business purpose and upload supporting evidence for ${transaction?.description || 'this transaction'}.`);
  // ── Ask identity (108) — collapse duplicate UPLOADS onto one canonical case ──
  //
  // Every upload stays its own immutable document row. What changes is what the
  // ASK anchors on: the canonical document rather than the upload that happened
  // to arrive last. Two routes, tried in order:
  //
  //   1. the duplicate pointer parseDocumentsDb already wrote
  //      (parse_summary.existing_document_id on a `duplicate_pending` row), or a
  //      tenant-scoped checksum match against the documents(firm_id, client_id,
  //      checksum_sha256) index from 011 — the byte-identical re-send;
  //   2. the extracted CASE key (vendor + date + total + currency) — the
  //      re-photograph, whose bytes differ so no hash can collapse it.
  //
  // Read-only throughout. parseDocumentsDb.js is on the isolation list and is
  // not touched: this consumes what it already persists.
  let canonicalDocumentId = document?.id || '';
  let documentCaseKey = '';
  if (document) {
    documentCaseKey = buildDocumentCaseKey({
      documentType: document.document_type,
      vendorName: document.vendor_name,
      counterpartyName: document.customer_name,
      documentDate: document.document_date,
      totalAmount: document.total_amount,
      currency: document.currency
    });
    const summary = typeof document.parse_summary === 'string'
      ? (() => { try { return JSON.parse(document.parse_summary); } catch { return {}; } })()
      : (document.parse_summary && typeof document.parse_summary === 'object' ? document.parse_summary : {});
    const pointer = String(summary?.existing_document_id || '').trim();
    if (pointer) {
      canonicalDocumentId = pointer;
    } else if (document.checksum_sha256) {
      // Oldest non-duplicate row with these bytes IS the canonical artifact.
      const canonical = await client.query(
        `select id
           from documents
          where firm_id = $1 and client_id = $2 and checksum_sha256 = $3
            and parse_status <> 'duplicate_pending'
          order by created_at asc, id asc
          limit 1`,
        [firmId, cleanClientId, document.checksum_sha256]
      ).catch(() => ({ rows: [] }));
      if (canonical.rows[0]?.id) canonicalDocumentId = canonical.rows[0].id;
    }
  }
  const blockerCode = normalizeBlockerCode(cleanEvidenceType);
  const canonicalAnchor = buildCanonicalAnchor({
    transactionId: transaction?.id || '',
    reviewItemId: reviewItem?.id || cleanReviewItemId || '',
    canonicalDocumentId,
    caseKey: documentCaseKey,
    // Last rung, so an artifact always wins. A standing ask reaches it because
    // every rung above is empty, which is the definition of having no artifact.
    accountRole: cleanAccountRole,
    physicalCountLineId: cleanPhysicalCountLineId
  });

  // An ACTIVE ask on the same (anchor, blocker) IS this ask. The lookup keys on
  // the canonical anchor, so a second upload of one receipt finds the question
  // already put to the owner instead of minting a rival. The legacy per-upload
  // document_id clause is retained so rows written before 108 still match.
  // 122 — the live-ask collapse is AUDIENCE-SCOPED (including the legacy
  // per-artifact fallback clauses): asking the owner and asking a colleague
  // about one anchor are two live questions, so a new seat ask must never
  // collapse onto — or reword — the owner's open question.
  const openExisting = await client.query(
    `select *
     from client_evidence_requests
     where firm_id = $1
       and client_id = $2
       and status in ('draft', 'open', 'replied')
       and audience = $8
       and (($9::text <> 'ae_vat_business_use' and evidence_type <> 'ae_vat_business_use') or evidence_type = $9)
       and (
         ($6::text <> '' and canonical_anchor = $6 and coalesce(blocker_code, '') = $7)
         or ($3::text <> '' and transaction_id = $3)
         or ($4::text <> '' and review_item_id = $4)
         or ($5::text <> '' and request_payload->>'document_id' = $5)
       )
     order by created_at asc
     limit 1`,
    [
      firmId, cleanClientId,
      transaction?.id || '', reviewItem?.id || cleanReviewItemId || '', document?.id || '',
      canonicalAnchor, blockerCode, askAudience, cleanEvidenceType
    ]
  );
  const existing = openExisting.rows[0] || null;
  // F-19: the id of a NEW request is DETERMINISTIC on (anchor, generation).
  //
  // It used to hash Date.now() and the question text. That made the lookup above
  // a read-then-write race with nothing behind it: two concurrent asks about the
  // same transaction both saw no live request, both minted a DIFFERENT id, and
  // both inserted — so the owner got asked twice about one line, and the
  // `on conflict (id) do update` below (which exists precisely to make a re-mint
  // idempotent) could never fire because the ids never matched.
  //
  // Hashing the anchor instead means two concurrent minters observing the same
  // state compute the SAME id and collapse through that conflict clause into one
  // row with one send_count bump. The generation counter — how many requests this
  // anchor has ever had — keeps a legitimate RE-ASK after a resolved request a
  // new row rather than reopening closed history. The question text is
  // deliberately NOT in the hash: two drafters can word the same ask differently,
  // and that must not mint two asks.
  // 108: the anchor is now the CANONICAL one, so the generation counts how many
  // asks this CASE has ever had rather than how many this upload has had. Without
  // that, every re-upload would restart at generation 0 and mint a fresh id.
  const anchorKey = canonicalAnchor;
  let requestId = existing?.id || null;
  let generation = Number(existing?.generation || 0);
  if (!requestId) {
    // 122 — generation counts per AUDIENCE (how many times THIS audience has
    // been asked about this case), matching the audience-scoped identity index.
    const generationResult = await client.query(
      `select count(*)::int as generation
         from client_evidence_requests
        where firm_id = $1
          and client_id = $2
          and audience = $8
       and (($9::text <> 'ae_vat_business_use' and evidence_type <> 'ae_vat_business_use') or evidence_type = $9)
          and (
            ($6::text <> '' and canonical_anchor = $6 and coalesce(blocker_code, '') = $7)
            or ($3::text <> '' and transaction_id = $3)
            or ($4::text <> '' and review_item_id = $4)
            or ($5::text <> '' and request_payload->>'document_id' = $5)
          )`,
      [
        firmId, cleanClientId,
        transaction?.id || '', reviewItem?.id || cleanReviewItemId || '', document?.id || '',
        canonicalAnchor, blockerCode, askAudience, cleanEvidenceType
      ]
    );
    generation = Number(generationResult.rows[0]?.generation || 0);
    // 122 — a non-client audience joins the deterministic id, so a seat ask
    // and the owner's ask about the SAME anchor/generation can never collide
    // on `id` (the on-conflict collapse must stay within one audience). The
    // client id shape is BYTE-STABLE — every pre-122 id keeps resolving.
    const audienceKey = askAudience === 'client' ? '' : `:aud:${askAudience}`;
    requestId =
      `evidence-request-${firmId}-${cleanClientId}-${shortHash(`${anchorKey}:${cleanEvidenceType}${audienceKey}:gen${generation}`)}`;
  }
  // send_count counts OUTBOUND PROMPTS, not mints. Minting is a bookkeeping act
  // the owner never sees; bumping it here made "asked twice" indistinguishable
  // from "drafted twice, sent once" in the data. The deliverers own the
  // increment now (bumpEvidenceRequestSendCountWithClient), called only once a
  // message has actually left. A brand-new request starts at 0 and becomes 1
  // when it is genuinely sent.
  const sendCount = Number(existing?.send_count || 0);
  const evidenceRequestPayload = evidenceRequestPayloadForTransaction({
    requestId,
    question: finalQuestion,
    evidenceType: cleanEvidenceType,
    now,
    dueAt,
    sendCount
  });
  const requestPayload = {
    ...requestContext,
    ...(cleanPhysicalCountLineId ? { physical_count_line_id: cleanPhysicalCountLineId } : {}),
    transaction_id: transaction?.id || null,
    review_item_id: reviewItem?.id || cleanReviewItemId || null,
    // The doc anchor + display fields the client portal renders
    // (buildQuestionFromEvidenceRequest reads description/amount/currency/date).
    ...(document
      ? {
          document_id: document.id,
          document_type: document.document_type || null,
          description: documentLabel || null
        }
      : {}),
    // The standing subject, so a reply arriving days later can be resolved
    // against what was actually asked without re-deriving it from the anchor
    // string. Absent on every artifact-targeted ask, exactly as before.
    ...(cleanAccountRole ? { canonical_role: cleanAccountRole } : {}),
    transaction_description: transaction?.description || null,
    amount: transaction
      ? amountForPayload(transaction)
      : (document ? Number(document.total_amount || 0) : null),
    currency: transaction?.account_currency || transaction?.currency || (document?.currency ?? null),
    date: transaction?.date || transaction?.transaction_date
      || (document?.document_date ? toIsoDay(document.document_date) : null),
    evidence_request: evidenceRequestPayload
  };

  const upsertResult = await client.query(
    `insert into client_evidence_requests (
       id, firm_id, client_id, transaction_id, review_item_id, status,
       evidence_type, question, request_payload, created_at, first_sent_at, last_sent_at,
       send_count, due_at, created_by,
       canonical_anchor, blocker_code, generation,
       audience, addressee_principal_type, addressee_principal_id
     )
     values ($1, $2, $3, $4, $5, 'draft', $6, $7, $8::jsonb, $9::timestamptz, null, null, $10, $11::timestamptz, $12,
             nullif($13::text, ''), $14, $15, $16, $17, $18)
     on conflict (id) do update set
       -- W1 (INV-14): a re-mint that collapses onto a LIVE SENT ask leaves it
       -- open (the owner already has the question); any other prior state —
       -- draft, resolved, cancelled, replied — becomes a draft again, because
       -- THIS wording has not been sent. The sent stamps are the deliverers'
       -- alone (db/channels.js): a mint never writes them and never resets them.
       status = case when client_evidence_requests.status = 'open' then 'open' else 'draft' end,
       evidence_type = excluded.evidence_type,
       question = excluded.question,
       -- The envelope the portal renders is re-merged from the EXISTING row's
       -- send facts (INV-22: the columns are the truth — a re-mint never resets
       -- the envelope's stamps or its prompt count to the mint's zeros).
       request_payload = client_evidence_requests.request_payload || excluded.request_payload
         || jsonb_build_object('evidence_request',
              coalesce(client_evidence_requests.request_payload->'evidence_request', '{}'::jsonb)
                || coalesce(excluded.request_payload->'evidence_request', '{}'::jsonb)
                || jsonb_build_object(
                     'status', case when client_evidence_requests.status = 'open' then 'open' else 'draft' end,
                     'sent_at', client_evidence_requests.request_payload->'evidence_request'->'sent_at',
                     'first_sent_at', client_evidence_requests.request_payload->'evidence_request'->'first_sent_at',
                     'send_count', client_evidence_requests.send_count)),
       first_sent_at = client_evidence_requests.first_sent_at,
       last_sent_at = client_evidence_requests.last_sent_at,
       -- 108: a re-mint NEVER bumps send_count. Only an actual outbound prompt
       -- does (bumpEvidenceRequestSendCountWithClient), so the column keeps
       -- meaning "times the owner was prompted" — which is what the re-ask
       -- cadence and its escalation ceiling read it as.
       send_count = client_evidence_requests.send_count,
       due_at = coalesce(excluded.due_at, client_evidence_requests.due_at),
       canonical_anchor = coalesce(excluded.canonical_anchor, client_evidence_requests.canonical_anchor),
       blocker_code = coalesce(excluded.blocker_code, client_evidence_requests.blocker_code),
       -- 122: a same-id re-mint is same-audience by construction (the audience
       -- rides the deterministic id); the FIRST addressee holds the question —
       -- a re-mint never silently re-addresses a live ask.
       addressee_principal_type = coalesce(client_evidence_requests.addressee_principal_type, excluded.addressee_principal_type),
       addressee_principal_id = coalesce(client_evidence_requests.addressee_principal_id, excluded.addressee_principal_id),
       updated_at = now()
     returning *, (xmax = 0) as inserted`,
    [
      requestId,
      firmId,
      cleanClientId,
      transaction?.id || null,
      reviewItem?.id || cleanReviewItemId || null,
      cleanEvidenceType,
      finalQuestion,
      JSON.stringify(requestPayload),
      now,
      sendCount,
      dueAt ? new Date(dueAt).toISOString() : null,
      actorId,
      canonicalAnchor,
      blockerCode,
      generation,
      askAudience,
      addressee.addresseePrincipalType,
      addressee.addresseePrincipalId
    ]
  );
  const request = rowToClientEvidenceRequestPayload(upsertResult.rows[0]);
  // G2 PR-14 — the mint receipt, an OUT-PARAM rather than a field on `request`:
  // the request payload is rendered and persisted in several places, so the
  // "did this call create the row" signal must not ride inside it. The reverse leg
  // needs the answer because this upsert deliberately COLLAPSES onto a live ask for
  // the same anchor (F-19) — cancelling an ask the apply merely re-worded would close
  // a question the reversed action never opened. `xmax = 0` is the authority (the
  // pre-read `existing` can lose a race to a concurrent minter).
  if (mintOutcome && typeof mintOutcome === 'object') {
    mintOutcome.minted = Boolean(upsertResult.rows[0]?.inserted);
    mintOutcome.prior_status = existing?.status ?? null;
  }

  // Nothing silent: when this upsert COLLAPSED onto a live ask and actually
  // changed what the owner is being asked (the stale-ask supersede/refresh
  // lane, reconciliationTwinAging.js — but any live-ask reword lands here),
  // receipt it in the same transaction as the reword. The row survives with
  // its wording refreshed — never closed, never orphaned — so the line keeps
  // its open ask throughout; this event is how "a better basis replaced a
  // stale question" stays countable and attributable. A same-wording re-mint
  // (the idempotent collapse working as designed) is not a reword and stays
  // quiet.
  if (existing && ['draft', 'open'].includes(String(existing.status || ''))
      && String(existing.question || '') !== finalQuestion) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'client_evidence_request.refreshed', 'client_evidence_request', $4, $5::jsonb)`,
      [
        firmId,
        cleanClientId,
        actorId,
        request.id,
        JSON.stringify({
          transaction_id: transaction?.id || null,
          prior_evidence_type: existing.evidence_type || null,
          evidence_type: cleanEvidenceType,
          prior_created_by: existing.created_by || null,
          ask_batch_id: requestContext?.ask_batch_id || null
        })
      ]
    );
  }

  if (reviewItem?.id && stampNeedsClient) {
    await client.query(
      `update transaction_review_queue
       set status = 'open',
           payload = payload || $4::jsonb,
           updated_at = now()
       where firm_id = $1 and client_id = $2 and id = $3`,
      [
        firmId,
        cleanClientId,
        reviewItem.id,
        JSON.stringify({
          client_question: finalQuestion,
          evidence_request: evidenceRequestPayload
        })
      ]
    );
  }

  if (transaction?.id && stampNeedsClient) {
    await client.query(
      `update transactions
       set status = 'needs_client',
           payload = payload || $4::jsonb,
           updated_at = now()
       where firm_id = $1 and client_id = $2 and id = $3`,
      [
        firmId,
        cleanClientId,
        transaction.id,
        JSON.stringify({
          status: 'needs_client',
          transaction_status: 'needs_client',
          client_question: finalQuestion,
          evidence_request: evidenceRequestPayload
        })
      ]
    );
    // RT-16: the coding state moves to `asked` (client audience only). A line
    // already on a ledger rung keeps it — the ask still exists and puts the
    // line on the owner through the ask itself; the coding question is not
    // what is open there.
    await applyCodingTransitionIfAllowed(client, { firmId, clientId: cleanClientId, transactionId: transaction.id, to: 'asked' });
  }

  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'evidence_request.create', 'client_evidence_request', $4, $5::jsonb)`,
    [
      firmId,
      cleanClientId,
      actorId,
      request.id,
      JSON.stringify({
        transaction_id: transaction?.id || null,
        review_item_id: reviewItem?.id || null,
        document_id: document?.id || null,
        // "Nothing silent" applies to a standing ask too: without this the audit
        // row for a chart-anchored question would carry three nulls and no
        // subject at all, which reads as a mint with no target.
        canonical_role: cleanAccountRole || null,
        canonical_anchor: canonicalAnchor || null,
        evidence_type: cleanEvidenceType,
        send_count: sendCount,
        // 122 — who was asked. Client mints keep the extra keys null-free
        // shape stable except this one honest addition.
        audience: askAudience,
        ...(addressee.addresseePrincipalType
          ? {
              addressee_principal_type: addressee.addresseePrincipalType,
              addressee_principal_id: addressee.addresseePrincipalId
            }
          : {})
      })
    ]
  );

  return request;
};

// The dbClient-injectable test seam (house `__` idiom). Pins the F-19
// id-determinism contract without going through withFirmDbClient.
export { createClientEvidenceRequestWithClient as __createClientEvidenceRequestWithClient };

// Physical counts are a typed subject of the existing ask lifecycle. The
// inventory owner holds its scope fence and authority in this transaction;
// answering a count must not run the bank-line recoder or open a second commit.
export const resolvePhysicalCountRequestsWithClient = async ({
  client, firmId, clientId, lineId, actorId, actorType, reason,
  evidenceRefs = [], observationDigest = null
}) => {
  if (!actorId || !reason || !lineId) throw new Error('Physical ask resolution requires actor, line and reason.');
  const result = await client.query(
    `update client_evidence_requests r
     set status='resolved', resolved_at=now(), resolved_by=$4,
         response_payload=response_payload || $5::jsonb, updated_at=now()
     where r.firm_id=$1 and r.client_id=$2
       and r.canonical_anchor=$3 and r.evidence_type='physical_inventory'
       and r.status in ('draft','open','replied')
       and exists (select 1 from inventory_count_lines l
         where l.id::text=r.request_payload->>'physical_count_line_id'
           and l.firm_id=$1 and l.client_id=$2)
     returning id`,
    [firmId, clientId, buildCanonicalAnchor({ physicalCountLineId: lineId }), actorId,
      JSON.stringify({ resolution_note: reason, evidence_refs: evidenceRefs,
        observation_digest: observationDigest, resolved_at: new Date().toISOString() })]
  );
  for (const { id } of result.rows) await client.query(
    `insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
     values($1,$2,$3,$4,'evidence_request.resolve','client_evidence_request',$5,$6::jsonb)`,
    [firmId, clientId, actorType, actorId, id,
      JSON.stringify({ physical_count_line_id: String(lineId), reason, observation_digest: observationDigest })]
  );
  return result.rows.map(({ id }) => id);
};

// Bounded review-clock discovery receipt only. It does not deliver, resolve,
// reassign or change a deadline; persist scan order so restarts reach later asks.
export const markPhysicalCountRequestsClockCheckedWithClient = async ({ client, firmId, clientId, requestIds, checkedAt }) => {
  if (!requestIds?.length) return;
  await client.query(
    `update client_evidence_requests
     set request_payload=request_payload || jsonb_build_object('physical_clock_checked_at', $4::text)
     where firm_id=$1 and client_id=$2 and id=any($3::text[])
       and evidence_type='physical_inventory' and status in ('draft','open','replied')`,
    [firmId, clientId, requestIds, checkedAt]);
};

// Same canonical request, explicit handoff, immutable audit of the prior
// recipient. Escalation is not delivery: the new recipient must acknowledge.
export const escalatePhysicalCountRequestWithClient = async ({ client, firmId, clientId, requestId, recipient, dueAt, reason }) => {
  const prior = (await client.query(
    `select * from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3
     and evidence_type='physical_inventory' and status in ('draft','open','replied') for update`,
    [firmId, clientId, requestId])).rows[0];
  if (!prior || prior.request_payload?.physical_escalation) return null;
  const receipt = { reason, prior_recipient: { principalType: prior.addressee_principal_type, principalId: prior.addressee_principal_id },
    recipient, prior_due_at: prior.due_at, escalated_at: new Date().toISOString() };
  const updated = await client.query(
    `update client_evidence_requests set status='draft', addressee_principal_type=$4, addressee_principal_id=$5,
     due_at=$6::timestamptz, request_payload=request_payload || $7::jsonb, updated_at=now()
     where firm_id=$1 and client_id=$2 and id=$3 returning *`,
    [firmId, clientId, requestId, recipient.principalType, recipient.principalId, dueAt,
      JSON.stringify({ physical_escalation: receipt, physical_ack_recipient: null,
        delivery_status: 'not_delivered', evidence_request: { ...(prior.request_payload?.evidence_request || {}), status: 'draft' } })]);
  await client.query(
    `insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
     values($1,$2,'system','physical_review_clock','physical.ask_escalated','client_evidence_request',$3,$4::jsonb)`,
    [firmId, clientId, requestId, JSON.stringify(receipt)]);
  return updated.rows[0];
};

// The hosted pilot deliberately cannot send an ask batch. A material hold
// still owes a portal-visible question through the ordinary per-line writer.
// Render the persisted candidates without asserting that every material-tagged
// match is certain: the group may also contain amount/confidence refusals.
// There is no model call or transport here. Lock and read current evidence
// before rendering; never use a generation-time selection as write authority.
export const __createHeldMatchPortalAsksWithClient = async ({client, firmId, clientId} = {}) => {
  const initial = await gatherHeldMaterialAskGroups(client, {firmId, clientId, groupLimit:10, includePortalAsks:true});
  const requests = [];
  for (const selected of initial.groups) {
    // Existing drafts remain candidates for later source changes. Rotate the
    // bounded scan even on a no-op or refusal so its first page cannot hide
    // new questions or later stale drafts. This is discovery, not ask authority.
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'system','coding_auto_post','pilot.processing.held_ask_scan','transaction',$3,
        '{"purpose":"bounded_evidence_refresh_discovery"}'::jsonb)`,[firmId,clientId,selected.transaction_id]);
    await client.query('begin');
    try {
      await client.query('select id from clients where firm_id=$1 and id=$2 for update', [firmId, clientId]);
      const configSnapshot = await readInternalPilotAccessWithClient(client, {firmId, clientId})
        ? await readClientConfigSnapshot(client, {firmId, clientId, strict:true}) : null;
      if (!configSnapshot || !clientFlagActs({flagKey:'CODING_AUTO_POST', snapshot:configSnapshot, envFallback:() => false})) {
        await client.query('rollback'); break;
      }
      const tx = (await client.query(`select * from transactions
        where firm_id=$1 and client_id=$2 and id=$3 for update`, [firmId, clientId, selected.transaction_id])).rows[0];
      if (!tx || ['applied','posted','synced','closed'].includes(tx.coding_state)
        || ['reconciled','explained'].includes(tx.reconciliation_status)
        || (await client.query(`select 1 from ledger_journals where firm_id=$1 and client_id=$2
          and source_type='transaction' and source_id=$3 limit 1`, [firmId,clientId,tx.id])).rowCount) {
        await client.query('rollback'); continue;
      }
      // Client lock prevents new child evidence; row locks retain existing
      // document/match identity throughout the read-and-mint transaction.
      const documents = (await client.query(`select * from documents where firm_id=$1 and client_id=$2
        order by id limit 501 for share`, [firmId, clientId])).rows;
      if (documents.length > 500) throw Object.assign(new Error('Held-match evidence exceeds the bounded portal gather.'), {code:'HELD_MATCH_EVIDENCE_LIMIT'});
      await client.query(`select id from reconciliation_matches where firm_id=$1 and client_id=$2
        and bank_transaction_id=$3 order by id for update`, [firmId, clientId, tx.id]);
      // Discovery rotation may move this target beyond the next global page.
      // Revalidate the exact locked transaction, including every held candidate.
      const current = await gatherHeldMaterialAskGroups(client, {firmId, clientId, transactionId:tx.id,
        rowLimit:200, groupLimit:1, includePortalAsks:true});
      if (current.truncated) throw Object.assign(new Error('Held-match group exceeds the bounded evidence read.'), {code:'HELD_MATCH_EVIDENCE_LIMIT'});
      const group = current.groups.find(item => item.transaction_id === tx.id);
      const activeAsks = (await client.query(`select ask.*,
        (select a.actor_id from audit_events a where a.firm_id=ask.firm_id and a.client_id=ask.client_id
          and a.resource_id=ask.id and a.action='evidence_request.create' order by a.id desc limit 1) as last_mint_actor_id
        from client_evidence_requests ask where firm_id=$1 and client_id=$2
        and transaction_id=$3 and audience='client' and status in ('draft','open','replied') order by id for update`,
      [firmId,clientId,tx.id])).rows;
      const unsentMachineDraft = ask => ask.status === 'draft'
        && Number(ask.send_count) === 0 && !ask.first_sent_at && !ask.responded_at
        && !Object.keys(ask.response_payload || {}).length && !ask.request_payload?.amendments?.length
        && ask.last_mint_actor_id === 'coding_auto_post' && ask.created_by === 'coding_auto_post';
      // The held group already holds the document an unsent coder draft asked
      // for. The statutory source rule counts only a settled match, so the
      // owner's confirmation is the question that can settle it; the document
      // request gives way to it in this transaction (Kultalanka TyEL notice,
      // 2026-09-23). A sent or human-authored question keeps its owner.
      const suppliedSourceDrafts = group
        ? activeAsks.filter(ask => unsentMachineDraft(ask) && ask.evidence_type === 'supporting_document')
        : [];
      const remainingAsks = activeAsks.filter(ask => !suppliedSourceDrafts.includes(ask));
      const existing = remainingAsks[0];
      // Refresh only this producer's unsent settlement draft. The same
      // named writer preserves its identity and receipts the changed basis;
      // another human question or an in-flight reply retains ownership.
      const refreshable = remainingAsks.length === 1 && unsentMachineDraft(existing)
        && existing.evidence_type === 'business_purpose'
        && existing.request_payload?.channel === 'portal'
        && existing.request_payload?.authority_basis === 'persisted_match_requires_owner_confirmation';
      if (!group || (remainingAsks.length && !refreshable)) {
        await client.query('rollback'); continue;
      }
      const byId = new Map(documents.map(doc => [doc.id, doc]));
      if (group.candidates.some(candidate => {
        const doc = byId.get(candidate.document_id);
        return !doc || doc.parse_status !== 'completed' || doc.duplicate_of || doc.payload?.reconciliation_provider_failure;
      })) {
        throw Object.assign(new Error('Held match evidence is not currently ready.'), {code:'HELD_MATCH_EVIDENCE_NOT_READY'});
      }
      // The broad local inventory is a send-delay guard, not authority to
      // name settlement evidence. Start with the actual held match group;
      // customer credits enter only through the AR invoice eligibility gather.
      const evidence = new Map();
      for (const candidate of group.candidates) {
        const invoice = byId.get(candidate.document_id);
        evidence.set(invoice.id, {document_id:invoice.id, filename:invoice.filename});
        if (Number(tx.money_in) > 0 && !Number(tx.money_out)
          && ['sales_invoice','issued_receipt'].includes(invoice.document_type) && invoice.payment_status !== 'credit_note') {
          const {eligible} = await loadEligibleCreditNotes({client, firmId, clientId, invoice});
          for (const credit of eligible) evidence.set(credit.id, {document_id:credit.id, filename:credit.filename});
        }
      }
      const files = [...evidence.values()].filter(doc => doc.filename)
        .sort((a,b) => a.document_id.localeCompare(b.document_id));
      if (!files.length) throw Object.assign(new Error('Held match has no identifiable document.'), {code:'HELD_MATCH_EVIDENCE_NOT_READY'});
      const amount = Math.abs(Number(tx.money_out) || Number(tx.money_in)).toFixed(2);
      // One held document is a confirmation, not a choice between documents.
      const confirmation = files.length === 1
        ? 'Please confirm that this payment settles that document, and tell us about any other agreed adjustments. You do not need to upload it again.'
        : 'Please confirm which of these documents this payment settles, and tell us about any other agreed adjustments. You do not need to upload these files again.';
      // HELMIKUU S8 (Kari, 2026-09-24): a held statement row keeps its own
      // question. When other rows of the same statement are held too, the
      // question names them (row, amount, date) and offers to confirm them all
      // in one answer. The named rows are recorded; the reply acts on no other.
      const [row] = group.candidates;
      const {heldPlanCompletionActs, readHeldStatementSiblingsWithClient} = await import('../jevReconciliation.js');
      const siblings = group.candidates.length === 1 && row.matched_line_id && heldPlanCompletionActs(configSnapshot)
        ? await readHeldStatementSiblingsWithClient({client, firmId, clientId, documentId:row.document_id, transactionId:tx.id}) : [];
      const rowLabel = sibling => `row ${sibling.line_no ?? '?'}${sibling.line_description ? ` “${sibling.line_description}”` : ''}`;
      const siblingText = siblings.length
        ? ` This payment is ${rowLabel({line_no:row.matched_line_no, line_description:row.matched_line_description})} of that statement. `
          + `${siblings.length === 1 ? 'One other row of the same statement is' : `${siblings.length} other rows of the same statement are`} also waiting for your confirmation: `
          + `${siblings.map(sibling => `${rowLabel(sibling)}, ${sibling.currency} ${sibling.amount} ${sibling.direction} on ${sibling.date}`).join('; ')}. `
          + `You can confirm all the remaining rows at once in your answer, or keep answering row by row.`
        : '';
      const question = `About ${tx.currency || ''} ${amount} ${Number(tx.money_out) ? 'paid' : 'received'} on ${toIsoDay(tx.transaction_date)} — ${tx.description || ''}: we have ${files.map(doc => `“${doc.filename}”`).join(', ')} on file. ${confirmation}${siblingText}`;
      const requestContext = {held_match_groups:heldMatchGroupReceipts([group]), citable_local_evidence:files,
        authority_basis:'persisted_match_requires_owner_confirmation', channel:'portal',
        // A refreshed draft whose other rows all settled drops the old list
        // (the mint merges payloads); every other question is unchanged.
        ...(siblings.length ? {held_match_siblings:siblings} : existing?.request_payload?.held_match_siblings ? {held_match_siblings:[]} : {})};
      if (!suppliedSourceDrafts.length && existing && existing.question === question
        && isDeepStrictEqual(existing.request_payload?.citable_local_evidence, files)
        && isDeepStrictEqual(existing.request_payload?.held_match_groups, requestContext.held_match_groups)
        && isDeepStrictEqual(existing.request_payload?.held_match_siblings, requestContext.held_match_siblings)) {
        await client.query('rollback'); continue;
      }
      if (suppliedSourceDrafts.length) {
        await resolveOpenEvidenceRequestsForTransaction({client, firmId, clientId, transactionId:tx.id,
          actorId:'coding_auto_post', evidenceRequestIds:suppliedSourceDrafts.map(ask => ask.id),
          auditAction:'evidence_request.superseded_by_held_match',
          note:'The held match holds the requested document; the owner confirms the match instead.',
          responsePayload:{superseded_by_held_match:true, match_ids:group.candidates.map(candidate => candidate.match_id).filter(Boolean),
            document_ids:group.candidates.map(candidate => candidate.document_id)}});
      }
      const request = await createClientEvidenceRequestWithClient({client, firmId, clientId, transactionId:tx.id,
        question, evidenceType:'business_purpose', actorId:'coding_auto_post',
        requestContext});
      await client.query('commit');
      requests.push(request.id);
      await onEvidenceRequestCreated({client, firmId, clientId, evidenceRequest:request});
    } catch (error) {
      await client.query('rollback'); throw error;
    }
  }
  return [...new Set(requests)];
};

// `returnSnapshot: false` skips the firm-snapshot rebuild (same
// contract as updateTransactionReviewItemInDb) — for batch callers
// looping one request per row.
export const createClientEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  reviewItemId,
  // FI-9 (R) — the DOCUMENT anchor (doc-first terminal drain pattern): lets the
  // parse worker's e-invoice escalate terminal mint a doc-anchored owner ask
  // with no bank line. Pass-through to createClientEvidenceRequestWithClient,
  // which already owns the anchor semantics + the open-ask dedup per document.
  documentId,
  question,
  evidenceType = 'supporting_document',
  dueAt,
  actorId = 'system',
  // 122 — pass-through to the chokepoint's audience law (default 'client').
  audience = 'client',
  addresseePrincipalType = null,
  addresseePrincipalId = null,
  returnSnapshot = true
} = {}) =>
  withFirmDbClient(async (client) => {
    await client.query('begin');
    let request = null;
    // G2 PR-14: the mint receipt rides the WRAPPER's return (an internal shape),
    // never the request payload — the reverse capture needs to know whether this
    // apply created the ask or collapsed onto a live one.
    const mintOutcome = {};
    try {
      request = await createClientEvidenceRequestWithClient({
        client,
        firmId,
        clientId,
        transactionId,
        reviewItemId,
        documentId,
        question,
        evidenceType,
        dueAt,
        actorId,
        audience,
        addresseePrincipalType,
        addresseePrincipalId,
        mintOutcome
      });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    // Donna Loops shadow producer (post-commit, no-throw, LOOPS_SHADOW-gated).
    if (request) {
      await onEvidenceRequestCreated({ client, firmId, clientId, evidenceRequest: request });
    }
    const snapshot = returnSnapshot ? await getFirmSnapshotFromDb({ firmId }) : null;
    return {
      evidence_request: request,
      minted: mintOutcome.minted ?? null,
      prior_status: mintOutcome.prior_status ?? null,
      snapshot
    };
  });

// Applied coding outranks an open ask: once an account lands on the
// line (human apply, batch auto-apply, or reply-driven re-code), any
// still-open evidence request on that transaction is moot — leaving it
// open is how a line renders "ASKED" forever after the books moved.
export const resolveOpenEvidenceRequestsForTransaction = async ({
  client,
  firmId,
  clientId,
  transactionId,
  note = '',
  actorId = 'system',
  evidenceRequestIds = null,
  auditAction = 'evidence_request.superseded_by_coding',
  responsePayload = {}
} = {}) => {
  if (!clientId || !transactionId) return [];
  const result = await client.query(
    `update client_evidence_requests
     set status = 'resolved',
         resolved_at = now(),
         resolved_by = $4,
         response_payload = response_payload || $5::jsonb,
         updated_at = now()
     where firm_id = $1 and client_id = $2 and transaction_id = $3
       and status in ('draft', 'open', 'replied')
       and ($6::text[] is null or id = any($6::text[]))
     returning id`,
    [
      firmId,
      clientId,
      transactionId,
      actorId,
      JSON.stringify({
        ...responsePayload,
        resolution_note: note || 'Superseded by applied coding.',
        resolved_at: new Date().toISOString()
      }),
      evidenceRequestIds
    ]
  );
  const resolvedIds = result.rows.map((row) => row.id);
  if (resolvedIds.length) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, $6, 'transaction', $4, $5::jsonb)`,
      [
        firmId,
        clientId,
        actorId,
        transactionId,
        JSON.stringify({ evidence_request_ids: resolvedIds, note: note || null }),
        auditAction
      ]
    );
  }
  return resolvedIds;
};

// A journal settles the source it posted against. Its document-anchored
// settlement asks (which statement or payment settled it) are answered by that
// journal; a business-purpose ask about the document stays open (the D3 law
// the credit-note owner already follows). Receipted like the transaction case.
export const SETTLEMENT_ASK_EVIDENCE_TYPES = Object.freeze(['bank_statement', 'payment_method']);
export const resolveOpenSettlementRequestsForDocument = async ({
  client, firmId, clientId, documentId, transactionId = null, note = '', actorId = 'system'
} = {}) => {
  if (!clientId || !documentId) return [];
  const result = await client.query(
    `update client_evidence_requests
     set status = 'resolved',
         resolved_at = now(),
         resolved_by = $4,
         response_payload = response_payload || $5::jsonb,
         updated_at = now()
     where firm_id = $1 and client_id = $2
       and request_payload->>'document_id' = $3
       and transaction_id is null
       and status in ('draft', 'open', 'replied')
       and evidence_type = any($6::text[])
     returning id, evidence_type`,
    [firmId, clientId, documentId, actorId,
      JSON.stringify({ resolution_note: note || 'Superseded by the journal posted against this document.',
        resolved_at: new Date().toISOString(), superseded_by_transaction_id: transactionId }),
      [...SETTLEMENT_ASK_EVIDENCE_TYPES]]
  );
  const resolvedIds = result.rows.map((row) => row.id);
  if (resolvedIds.length) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'evidence_request.superseded_by_coding', 'document', $4, $5::jsonb)`,
      [firmId, clientId, actorId, documentId,
        JSON.stringify({ evidence_request_ids: resolvedIds, evidence_types: result.rows.map((row) => row.evidence_type),
          transaction_id: transactionId, note: note || null })]
    );
  }
  return resolvedIds;
};

// Reply-driven re-code apply gate. The reply is the client speaking
// about their own business — when the strong model reads it and says
// high confidence + no further evidence needed, the verdict applies and
// the line clears. Anything less stays a suggestion (with the model's
// sharper follow-up question riding the next ask-batch). rules_fallback
// can never apply — the deterministic template must not overwrite a
// strong verdict (that's the 'not_configured' row class).
export const __shouldApplyReplyRecode = (suggestion = {}) =>
  Boolean(
    suggestion &&
    suggestion.native_choice?.kind !== 'unresolved' &&
    suggestion.source !== 'rules_fallback' &&
    !suggestion.missing_account &&
    suggestion.evidence_required === false &&
    !['owner_fact', 'payroll_package', 'document_discrepancy'].includes(suggestion.posting_requirement) &&
    (suggestion.confidence === 'high' || hasJevResolvedCoding(suggestion)) &&
    suggestion.proposed_account &&
    normalizeIntelText(suggestion.proposed_account) !== 'suspense'
  );

// The nonposting native result has the same persisted ask/answer consumer as
// every owner fact. This orchestrates existing writers; it sends no message.
export const consumeNativeUnresolvedCodingWithClient = async ({ client, firmId, clientId, transactionId,
  policy, suggestion, actorId = 'transaction_coding', answeredRequestId = null }) => {
  if (!policy.nativeMenu || suggestion.native_choice?.kind !== 'unresolved') return null;
  assertNativeCodingChoice(policy.nativeMenu, suggestion);
  await assertNativeCodingSourceWithClient({ client, firmId, clientId, transactionId, receipt: suggestion.native_source });
  if (answeredRequestId) await resolveOpenEvidenceRequestsForTransaction({ client, firmId, clientId, transactionId,
    actorId, evidenceRequestIds: [answeredRequestId], note: 'The answer was considered; a specific additional business fact is required.' });
  return createClientEvidenceRequestWithClient({ client, firmId, clientId, transactionId, actorId,
    question: suggestion.ask_client_question, evidenceType: 'business_purpose',
    requestContext: { authority_basis: 'current_native_coding_missing_fact', model: suggestion.model,
      native_choice: suggestion.native_choice, native_source: suggestion.native_source } });
};

// A client reply RESUMES the parked line when it carries ANY new evidence —
// text, an uploaded document, or both. We ask for a document (evidence_type
// 'supporting_document') far more often than for a sentence, and the natural
// answer to "send the payout report" is the file with NO text. Gating the
// resume on text alone stranded that exact case (the report landed on the
// evidence request, nothing re-ran, the line sat at ASKED). Pure so the resume
// decision is unit-pinned independent of the transactional resolve path.
export const __shouldResumeFromClientReply = ({ reply = '', documentIds = [] } = {}) =>
  Boolean(String(reply || '').trim()) ||
  (Array.isArray(documentIds) && documentIds.filter(Boolean).length > 0);

// The clear half of the ask-pipeline: a client reply re-invokes the
// strong coder on that one line WITH the original question, the reply
// (text + uploaded docs), and the prior verdict labeled as the model's
// own unconfirmed suggestion (provenance, not authority). The model
// decides: reply answers it → apply and clear (queue accepted, open
// requests resolved); reply doesn't → new suggested verdict whose
// follow-up ask_client_question rides the next ask-batch. Runs OUTSIDE
// the resolve transaction — the reply is already durable; a failed
// policy failures leave a durable recovery obligation and never erase the reply.
const recodeTransactionAfterClientReplyWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  evidenceRequest = {},
  reply = '',
  replyDocumentIds = [],
  actorId = 'system',
  suggestFn = suggestTransactionCoding,
  distillFactsFn = distillAndStageFirmFactCandidates,
  expectedReplyKey = null,
  decideHeldRowScopeFn = null
} = {}) => {
  const txResult = await client.query(
    'select * from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1',
    [firmId, clientId, transactionId]
  );
  if (!txResult.rows[0]) return { applied: false, skipped: 'transaction_not_found' };
  const transaction = rowToTransactionPayload(txResult.rows[0]);

  const clientResult = await client.query('select * from clients where firm_id = $1 and id = $2', [firmId, clientId]);
  const clientProfile = clientResult.rows[0]
    ? {
        ...(clientResult.rows[0].profile || {}),
        id: clientResult.rows[0].id,
        companyName: clientResult.rows[0].profile?.companyName || clientResult.rows[0].company_name,
        uen: clientResult.rows[0].profile?.uen || clientResult.rows[0].uen,
        jurisdiction: clientResult.rows[0].jurisdiction || ''
      }
    : { id: clientId };
  const rulesResult = await client.query(
    'select * from client_rules where firm_id = $1 and client_id = $2 and status = $3 order by updated_at desc limit 80',
    [firmId, clientId, 'active']
  );
  const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
  // Own-account roster → the reply-recode coder's internal-transfer anchor
  // (same attach as the single-suggest path — the tx-12/tx-13 class).
  clientProfile.knownBankAccounts = await loadClientOwnBankAccounts(client, { firmId, clientId });
  // FI-3 slice W (+ gb/au/us 2026-07-23): route the reply-recode coder to the
  // client's jurisdiction tax vocabulary.
  withClientCodingPolicy(clientProfile, await resolveClientCodingPolicyWithClient({
    client, firmId, clientId, businessDate: transaction.date
  }));
  if (clientProfile.codingPolicy.nativeMenu && (!expectedReplyKey || !actorId || actorId === 'system')) {
    throw Object.assign(new Error('Native reply coding requires the persisted attributable owner reply.'), { code: 'OWNER_REPLY_SUPERSEDED' });
  }
  const nativeCase = clientProfile.codingPolicy.nativeMenu
    ? await readJevCase({ client, firmId, clientId, transactionId, evidenceOnly: true }) : null;
  const matchedDocuments = await loadMatchedDocumentsForTransactions({
    client,
    firmId,
    clientId,
    transactionIds: [transactionId]
  });
  transaction.matched_document = matchedDocuments.get(transactionId) || null;
  if (nativeCase) {
    transaction.matched_document = nativeCase.matchedDocument;
    transaction.case_evidence = jevCasePrompt(nativeCase.caseEvidence);
  }

  const cleanReplyDocumentIds = (replyDocumentIds || []).filter(Boolean);
  // Load the reply documents WITH their extracted content (not just the
  // filename) so the strong coder can read the uploaded report and settle the
  // line instead of re-asking for evidence it was already given.
  const replyDocuments = await loadReplyDocumentsWithContent({
    client, firmId, clientId, documentIds: cleanReplyDocumentIds
  });

  const priorSuggestion = transaction.ai_suggestion && typeof transaction.ai_suggestion === 'object'
    ? transaction.ai_suggestion
    : null;
  transaction.reply_evidence_request_id = evidenceRequest.id || null;
  transaction.client_reply_context = {
    question_asked: evidenceRequest.question || '',
    client_reply: reply,
    reply_documents: replyDocuments,
    prior_verdict: priorSuggestion
      ? {
          proposed_account: priorSuggestion.proposed_account || '',
          confidence: priorSuggestion.confidence || '',
          reasoning: priorSuggestion.reasoning || '',
          provenance: 'machine_suggestion_unconfirmed'
        }
      : null
  };

  const suggestion = await suggestFn({
    clientProfile,
    transaction,
    clientRules: rulesResult.rows,
    xeroAccounts,
    // Q9 — the reply-recode coder decides under the same lane policy as
    // the single/batch paths (one lane, one policy, three owners).
    transport: await resolveCodingTransport(client, { firmId, clientId })
  });
  if (nativeCase && suggestion?.provider_failure) {
    throw Object.assign(new Error(suggestion.provider_failure.message || 'Coding provider unavailable'),
      { code: suggestion.provider_failure.code, details: suggestion.provider_failure });
  }
  if (!suggestion || suggestion.source === 'rules_fallback') {
    return { applied: false, skipped: 'llm_unavailable' };
  }

  const suggestionPayload = enrichCodingWithXeroAccount({
    jurisdiction: clientProfile.jurisdiction || null,
    coding: {
      ...suggestion,
      suggested_at: Date.now(),
      transaction_id: transactionId,
      source: suggestion.source || 'openai',
      recoded_from_reply: true,
      ...(nativeCase ? { native_source: nativeCodingSourceReceipt(nativeCase.caseEvidence) } : {}),
      ...(String(clientProfile.jurisdiction).toLowerCase() === 'fi' ? { evidence_digest: codingEvidenceDigest(transaction.matched_document) } : {}),
      evidence_request_id: evidenceRequest.id || null
    },
    transaction,
    xeroAccounts
  });
  const applies = __shouldApplyReplyRecode(suggestionPayload);
  // A held-source reply can establish the factual settlement without minting
  // material approval. Bind this existing reply-consumer decision to the exact
  // cited source and answer. With JEV_HELD_PLAN_COMPLETION (HELMIKUU S7) the
  // same bound reply also settles a held Jev match and completes its plan,
  // below; without it the match stays suggested.
  const heldSource=transaction.matched_document;
  if (applies && actorId && actorId!=='system' && reply.trim() && heldSource?.document_id
    && evidenceRequest.request_payload?.authority_basis==='persisted_match_requires_owner_confirmation'
    && evidenceRequest.request_payload?.citable_local_evidence?.some(item=>item.document_id===heldSource.document_id)) {
    suggestionPayload.source_reply_authority={authority_basis:'attributable_held_source_reply',actor_id:actorId,
      evidence_request_id:evidenceRequest.id,document_id:heldSource.document_id,
      document_digest:codingEvidenceDigest(heldSource),reply_digest:evidenceHash(reply.trim()),
      question_digest:evidenceHash(evidenceRequest.question || '')};
  }

  // HELMIKUU S8: a held statement row's question may name the other held rows
  // of the same statement. Whether this answer confirms them too is the strong
  // model's closed-choice reading (heldRowScope.js), taken here, outside the
  // transaction; anything but a clear all_remaining_rows acts on this row only.
  const heldSiblings = Array.isArray(evidenceRequest.request_payload?.held_match_siblings)
    ? evidenceRequest.request_payload.held_match_siblings : [];
  let heldRowScope = null;
  let heldRowOutcome = null;
  if (suggestionPayload.source_reply_authority && heldSiblings.length) {
    const { heldPlanCompletionActs } = await import('../jevReconciliation.js');
    if (heldPlanCompletionActs(await readClientConfigSnapshot(client, { firmId, clientId, strict: true }))) {
      const decide = decideHeldRowScopeFn || (await import('../heldRowScope.js')).decideHeldRowScope;
      heldRowScope = await decide({ request: evidenceRequest, reply: reply.trim(), siblings: heldSiblings });
    }
  }

  const supportNote = String(suggestionPayload.support_note || '').trim()
    || (reply ? `Client reply: ${reply.slice(0, 200)}` : '');

  await client.query('begin');
  try {
    const currentTransaction = (await client.query(
      'select coding_state, transaction_date, payload from transactions where firm_id = $1 and id = $2 for update',
      [firmId, transactionId]
    )).rows[0];
    if (!currentTransaction || __isTerminalCodingState(currentTransaction)) {
      await client.query('commit');
      return { applied: false, skipped: 'terminal_or_missing_transaction' };
    }
    if (expectedReplyKey) {
      const currentReply = (await client.query(
        'select * from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3 for update',
        [firmId, clientId, evidenceRequest.id]
      )).rows[0];
      assertCurrentOwnerReply(currentReply, expectedReplyKey);
      if (currentReply.transaction_id !== transactionId
        || (nativeCase && (currentReply.response_payload?.reply_processing?.actor_id !== actorId
          || currentReply.response_payload?.reply !== reply))) {
        throw Object.assign(new Error('The reply target changed during processing.'), { code: 'OWNER_REPLY_SUPERSEDED' });
      }
    }
    if (evidenceRequest.evidence_type === 'document_discrepancy' && cleanReplyDocumentIds.length) {
      await client.query('select id from documents where firm_id=$1 and client_id=$2 and id=any($3::text[]) order by id for share',[firmId,clientId,cleanReplyDocumentIds]);
      const currentReplyDocuments=await loadReplyDocumentsWithContent({client,firmId,clientId,documentIds:cleanReplyDocumentIds});
      if(codingEvidenceDigest(currentReplyDocuments)!==codingEvidenceDigest(replyDocuments)) throw Object.assign(new Error('The corrected document changed while the answer was considered.'),{code:'TRANSACTION_CODING_EVIDENCE_STALE'});
    }
    const currentPolicy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId, businessDate: rowToTransactionPayload(currentTransaction).date, lockContext: true });
    assertCodingSuggestionForPolicy(currentPolicy, suggestionPayload);
    if (currentPolicy.nativeMenu) {
      assertNativeCodingChoice(currentPolicy.nativeMenu, suggestionPayload, { applying: applies });
      await assertNativeCodingSourceWithClient({ client, firmId, clientId, transactionId, receipt: suggestionPayload.native_source });
    }
    if (suggestionPayload.evidence_digest && suggestionPayload.evidence_digest !== codingEvidenceDigest(await currentCodingEvidence({client,firmId,clientId,transactionId}))) {
      throw Object.assign(new Error('The coding document changed while the reply was being considered.'), {code:'TRANSACTION_CODING_EVIDENCE_STALE',statusCode:409});
    }
    if (applies) {
      // Merchant-rule learning deliberately stays off this path for
      // now — reply-confirmed lines are mostly one-offs (owner draws,
      // checks); the batch coding pass owns recurring-pattern memory.
      const txPatch = {
        ...(currentPolicy.nativeMenu ? { review_scope: null, account_id: suggestionPayload.account_id,
          native_choice: suggestionPayload.native_choice, native_source: suggestionPayload.native_source,
          category: suggestionPayload.proposed_account, accepted_coding_policy: codingPolicyReceipt(currentPolicy) } : {}),
        proposed_account: suggestionPayload.proposed_account,
        account_code: suggestionPayload.account_code || suggestionPayload.proposed_account,
        account_name: suggestionPayload.account_name || '',
        account_label: suggestionPayload.account_label || '',
        xero_account_id: suggestionPayload.xero_account_id || null,
        xero_account_code: suggestionPayload.xero_account_code || null,
        xero_account_name: suggestionPayload.xero_account_name || null,
        xero_account_type: suggestionPayload.xero_account_type || null,
        xero_tax_type: suggestionPayload.xero_tax_type || null,
                  tax_type: suggestionPayload.tax_type || null,
                  tax_code: suggestionPayload.tax_code || null,
        xero_account_match_status: suggestionPayload.xero_account_match_status || null,
        contact: suggestionPayload.contact || transaction.contact || '',
        tax_treatment: suggestionPayload.tax_treatment,
        confidence: suggestionPayload.confidence || 'high',
        support_note: supportNote,
        support_status: 'explained',
        support_explained_at: transaction.support_explained_at || Date.now(),
        reconciliation_status: transaction.reconciliation_status === 'reconciled' ? 'reconciled' : 'explained',
        status: transaction.status === 'approved' ? 'approved' : 'ready',
        ai_suggestion: suggestionPayload,
        ai_suggestion_status: 'auto_applied',
        ai_suggestion_applied_at: Date.now(),
        ai_suggestion_applied_via: 'client_reply',
        evidence_request: {
          ...(transaction.evidence_request || {}),
          status: 'resolved',
          resolved_at: Date.now()
        }
      };
      await client.query(
        `update transactions
         set account_code = $3,
             category = coalesce($5::jsonb->>'category',category),
             reconciliation_status = $4,
             status = case when status = 'approved' then status else 'ready' end,
             payload = payload || $5::jsonb,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [
          firmId,
          transactionId,
          txPatch.account_code,
          txPatch.reconciliation_status,
          JSON.stringify(txPatch)
        ]
      );
      // RT-16: the reply decided the coding.
      await applyCodingTransition(client, { firmId, clientId, transactionId, to: 'applied' });
      // Native acceptance finishes review without declaring accounting complete.
      await client.query(
        `update transaction_review_queue
         set status = case when $5 then 'resolved' else status end,
             payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and status = 'open'
           and (item_id = $3 or payload->>'transaction_id' = $3)`,
        [
          firmId,
          clientId,
          transactionId,
          JSON.stringify({
            ai_suggestion: suggestionPayload,
            ai_suggestion_status: 'auto_applied',
            reviewer_note: 'Client reply answered the question; coding applied.'
          }),
          Boolean(currentPolicy.nativeMenu)
        ]
      );
      await resolveOpenEvidenceRequestsForTransaction({
        client,
        firmId,
        clientId,
        transactionId,
        note: `Resolved by client reply — applied ${txPatch.account_code}.`,
        actorId
      });
      // #ask-reply-match — if the reply carried an uploaded evidence
      // document, link the bank line → that document so the artifact
      // renders the rich "Matched to <vendor> <type> (<amount>)" branch
      // instead of the bare coding-verdict dump. State link, not a model
      // call; idempotent with the batch path (ON CONFLICT DO NOTHING).
      await linkReplyEvidenceMatchesInDb({
        client,
        firmId,
        clientId,
        transactionId,
        replyDocuments: transaction.client_reply_context?.reply_documents || [],
        evidenceRequestId: evidenceRequest.id || null,
        // Magnitude of the bank line — money_in for receipts, money_out for
        // payments. Math.abs(Number(...)) per field so the string "0.00"
        // doesn't short-circuit `||` as truthy and zero the amount.
        fallbackAmount: Math.abs(Number(transaction.money_in)) || Math.abs(Number(transaction.money_out)) || 0,
        ...(evidenceRequest.evidence_type === 'document_discrepancy' && replyDocuments.length === 1
          && transaction.matched_document?.match_status === 'auto_matched'
          && replyDocuments[0].currency === transaction.matched_document.currency
          ? { supersedesDocumentId: transaction.matched_document.document_id } : {})
      });
      if (suggestionPayload.evidence_digest && evidenceRequest.evidence_type === 'document_discrepancy') {
        const rebound=await currentCodingEvidence({client,firmId,clientId,transactionId});
        if (rebound?.document_id !== transaction.matched_document?.document_id && !replyDocuments.some(doc=>doc.id===rebound?.document_id)) throw Object.assign(new Error('The reply coding has no current document anchor.'),{code:'TRANSACTION_CODING_EVIDENCE_STALE'});
        suggestionPayload.evidence_digest=codingEvidenceDigest(rebound);
        await client.query(`update transactions set payload=jsonb_set(payload,'{ai_suggestion,evidence_digest}',$3::jsonb) where firm_id=$1 and id=$2`,[firmId,transactionId,JSON.stringify(suggestionPayload.evidence_digest)]);
      }
      if (suggestionPayload.source_reply_authority) {
        const { completeOwnerConfirmedJevPlanWithClient, confirmRemainingHeldRowsWithClient } = await import('../jevReconciliation.js');
        const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
        const documentId = suggestionPayload.source_reply_authority.document_id;
        const answered = await completeOwnerConfirmedJevPlanWithClient({ client, firmId, clientId, transactionId,
          documentId, actorId, evidenceRequestId: evidenceRequest.id || null, configSnapshot,
          ...(heldRowScope ? { scopeDecision: heldRowScope } : {}) });
        // HELMIKUU S8: "all the remaining rows" settles every row the question
        // named that is still held, then answers those rows' own questions.
        if (answered.match_id && heldRowScope?.acts_on === 'all_remaining_rows') {
          heldRowOutcome = await confirmRemainingHeldRowsWithClient({ client, firmId, clientId, documentId,
            answeredTransactionId: transactionId, actorId, evidenceRequestId: evidenceRequest.id || null,
            siblings: heldSiblings, scopeDecision: heldRowScope, configSnapshot });
          for (const row of heldRowOutcome.filter(item => !item.skipped && !item.reason)) {
            const siblingAsks = (await client.query(`select id from client_evidence_requests where firm_id=$1 and client_id=$2
              and transaction_id=$3 and audience='client' and status in ('draft','open') and id<>$4
              and request_payload->>'authority_basis'='persisted_match_requires_owner_confirmation' order by id for update`,
            [firmId, clientId, row.transaction_id, evidenceRequest.id || ''])).rows.map(ask => ask.id);
            await resolveOpenEvidenceRequestsForTransaction({ client, firmId, clientId, transactionId: row.transaction_id,
              actorId, evidenceRequestIds: siblingAsks, auditAction: 'evidence_request.resolved_by_remaining_rows_answer',
              note: 'Confirmed together with the other rows of the same statement in one owner answer.',
              responsePayload: { confirmed_by_evidence_request_id: evidenceRequest.id || null, confirmed_by_actor_id: actorId,
                match_id: row.match_id, scope_decision: heldRowScope } });
            // Its question is answered and its match settled, so the line no
            // longer rests on the owner. Its coding is Donna's again: the
            // existing coding-evidence recovery and coder take it from here
            // (the same re-open a changed source gets), never a copied coding.
            const sibling = (await client.query(`select coding_state from transactions where firm_id=$1 and client_id=$2 and id=$3 for update`,
              [firmId, clientId, row.transaction_id])).rows[0];
            if (sibling?.coding_state === 'asked') {
              await client.query(`update transactions set status='needs_review',
                payload=payload || '{"status":"needs_review","transaction_status":"needs_review"}'::jsonb, updated_at=now()
                where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, row.transaction_id]);
              await applyCodingTransition(client, { firmId, clientId, transactionId: row.transaction_id, to: 'proposed' });
            }
          }
        }
      }
    } else {
      await client.query(
        `update transactions
         set payload = payload || $3::jsonb,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [
          firmId,
          transactionId,
          JSON.stringify({
            ai_suggestion: suggestionPayload,
            ...(currentPolicy.nativeMenu ? { review_scope: null } : {})
          })
        ]
      );
      // RT-16: the reply re-opened the coding as a fresh proposal.
      await applyCodingTransition(client, { firmId, clientId, transactionId, to: 'proposed' });
      await client.query(
        `update transaction_review_queue
         set payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and status = 'open'
           and (item_id = $3 or payload->>'transaction_id' = $3)`,
        [
          firmId,
          clientId,
          transactionId,
          JSON.stringify({
            ai_suggestion: suggestionPayload,
            reviewer_note: 'Client replied; model kept the line open with a follow-up question.'
          })
        ]
      );
    }

    await consumeNativeUnresolvedCodingWithClient({ client, firmId, clientId, transactionId, policy: currentPolicy,
      suggestion: suggestionPayload, actorId, answeredRequestId: evidenceRequest.id });
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'transaction.reply_recode', 'transaction', $4, $5::jsonb)`,
      [
        firmId,
        clientId,
        actorId,
        transactionId,
        JSON.stringify({
          applied: applies,
          evidence_request_id: evidenceRequest.id || null,
          proposed_account: suggestionPayload.proposed_account,
          confidence: suggestionPayload.confidence,
          evidence_required: suggestionPayload.evidence_required,
          follow_up_question: applies ? null : suggestionPayload.ask_client_question || null,
          model: suggestionPayload.model || null,
          ...(heldRowScope ? { held_row_scope: heldRowScope,
            remaining_rows: (heldRowOutcome || []).map(({ transaction_id, match_id, skipped = null, reason = null, refusal = null }) =>
              ({ transaction_id, match_id, skipped, reason, refusal })) } : {})
        })
      ]
    );
    if (expectedReplyKey) {
      const processing = { reply_key: expectedReplyKey, state: applies ? 'completed' : 'needs_clarification', applied: applies };
      const { recordOwnerReplyProcessingReceipt } = await import('../ownerReplyProcessingReceipt.js');
      await recordOwnerReplyProcessingReceipt({ client, firmId, clientId, actorId,
        evidenceRequestId: evidenceRequest.id, transactionId, processing,
        metadata: { model: suggestionPayload.model || null } });
    }
    await recordCodingPolicyRecovery({ client, firmId, clientId, transactionIds: [transactionId], policy: currentPolicy });
    if (applies && currentPolicy.nativeMenu) {
      // The reply writer can link its supplied document while accepting the
      // coding. Bind acceptance to that co-committed consequence, under the
      // source fence acquired above. Keep the model's original source receipt
      // in ai_suggestion unchanged; refresh never performs this transition.
      const acceptedCase = await readJevCase({ client,firmId,clientId,transactionId,evidenceOnly:true });
      await client.query("update transactions set payload=jsonb_set(payload,'{native_source}',$4::jsonb) where firm_id=$1 and client_id=$2 and id=$3",
        [firmId,clientId,transactionId,JSON.stringify(nativeCodingSourceReceipt(acceptedCase.caseEvidence))]);
      const accepted = (await client.query('select * from transactions where firm_id=$1 and client_id=$2 and id=$3',
        [firmId,clientId,transactionId])).rows[0];
      const reviewScope = nativeReviewScopeBody({ transaction: rowToTransactionPayload(accepted), policy: currentPolicy,
        actorId, authorityBasis: 'attributable_owner_reply_coding' });
      const auditId = await emitReviewAudit(client, { firmId,clientId,itemType:'transaction',itemId:transactionId,
        action:'review.accepted',actorId,actorType:evidenceRequest.response_payload?.reply_processing?.actor_type || 'user',
        metadata:{transaction_id:transactionId,review_scope:reviewScope,
          evidence_request_id:evidenceRequest.id,reply_key:expectedReplyKey,model:suggestionPayload.model || null} });
      if (!auditId) throw new Error('Native reply review acceptance audit was not persisted.');
      await client.query("update transactions set payload=payload || jsonb_build_object('review_scope',$4::jsonb) where firm_id=$1 and client_id=$2 and id=$3",
        [firmId,clientId,transactionId,JSON.stringify({...reviewScope,acceptance_audit:{store:'audit_events',id:auditId}})]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }

  // Layer-2 distillation: the client's reply is the richest source of
  // durable local knowledge ("EXAMPLE HOLDINGS is a shareholder, not a
  // customer"). Runs AFTER the recode commit and soft-fails end to
  // end — memory must never break the recode it rides.
  // W1 (INV-02 / INV-03): the TARGET is the candidate stage — a `suggested`
  // candidate for the owner to govern, never an active fact. (RT-20 drives the
  // resolve spine around this leg and adds no teach.)
  const distilled = await distillFactsFn({
    client,
    firmId,
    clientId,
    source: 'client_reply_recode',
    event: {
      kind: 'client_reply_recode',
      client: {
        name: clientProfile.companyName || '',
        registration_number: clientProfile.uen || '',
        jurisdiction: clientProfile.jurisdiction || ''
      },
      transaction: {
        description: transaction.description || '',
        money_in: Number(transaction.money_in || 0),
        money_out: Number(transaction.money_out || 0),
        currency: transaction.account_currency || transaction.currency || ''
      },
      question_asked: evidenceRequest.question || '',
      client_reply: reply,
      prior_verdict: transaction.client_reply_context?.prior_verdict || null,
      settled_coding: {
        proposed_account: suggestionPayload.proposed_account,
        tax_treatment: suggestionPayload.tax_treatment || null,
        applied: applies,
        reasoning: suggestionPayload.reasoning || ''
      }
    },
    provenance: {
      source: 'client_reply_recode',
      client_id: clientId,
      transaction_id: transactionId,
      evidence_request_id: evidenceRequest.id || null
    }
  }).catch(() => []);

  return {
    applied: applies,
    suggestion: suggestionPayload,
    // W1 (INV-04): the committed learning — candidates staged, never facts minted.
    learning: {
      rules_minted: [],
      facts_minted: [],
      candidates_staged: Array.isArray(distilled) ? distilled.length : 0,
      candidates_posture: distilled?.posture || null
    }
  };
};


export const __recodeTransactionAfterClientReplyWithClient = async (args = {}) => {
  try {
    return await recodeTransactionAfterClientReplyWithClient(args);
  } catch (error) {
    if (isCodingPolicyError(error)) {
      await recordCodingPolicyFailure({ client: args.client, firmId: args.firmId || DEFAULT_FIRM_ID, clientId: args.clientId, transactionIds: [args.transactionId], error });
    }
    throw error;
  }
};


// Authenticated transports carry their existing server principal, never a
// body/model identity. Resolve appliance-token humans before taking reply locks.
const prepareEvidenceReplyAuthority = async ({ firmId, replyAuthority, actorId }) => {
  if (replyAuthority == null) return { replyAuthority: null, actorId };
  if (!replyAuthority || typeof replyAuthority !== 'object'
    || Object.keys(replyAuthority).sort().join(',') !== 'principal,source'
    || !['authenticated_evidence_route', 'authenticated_client_chat'].includes(replyAuthority.source)
    || !replyAuthority.principal) {
    throw Object.assign(new Error('The reply requires a trusted authenticated principal.'), { code: 'EVIDENCE_REPLY_AUTHORITY_INVALID', statusCode: 403 });
  }
  const principal = await resolveDesktopClientCreationPrincipal({ firmId, principal: replyAuthority.principal });
  const human = ['firm_member', 'firm_collaborator'].includes(principal?.principalType);
  if (human && !principal.principalId) throw Object.assign(new Error('The reply principal is missing.'), { code: 'EVIDENCE_REPLY_AUTHORITY_INVALID', statusCode: 403 });
  if (!human && principal?.principalType !== 'access_token') throw Object.assign(new Error('Unsupported reply principal.'), { code: 'EVIDENCE_REPLY_AUTHORITY_INVALID', statusCode: 403 });
  return { replyAuthority: { principal, source: replyAuthority.source }, actorId: human
    ? principal.authenticatedVia === 'desktop_access_token' ? principal.principalId : principal.email || principal.userId || principal.principalId
    : actorId };
};

// Both existing reply owners use transaction → ask locks. The second read is
// canonical; an ask moved while waiting cannot redirect the already locked line.
const lockEvidenceReplyTarget = async (client, firmId, requestId) => {
  const selected = (await client.query(`select firm_id,client_id,transaction_id,review_item_id,canonical_anchor,
    request_payload->>'document_id' as document_id from client_evidence_requests where firm_id=$1 and id=$2`,
  [firmId, requestId])).rows[0] || null;
  const targets = (await client.query(`select t.id,t.client_id from transactions t join client_evidence_requests r
    on r.firm_id=t.firm_id and r.client_id=t.client_id and r.transaction_id=t.id
    where r.firm_id=$1 and r.id=$2 for update of t`, [firmId, requestId])).rows;
  const row = (await client.query(`select * from client_evidence_requests
    where firm_id=$1 and id=$2 limit 1 for update`, [firmId, requestId])).rows[0] || null;
  if (!row) throw Object.assign(new Error('Evidence request was not found.'), { statusCode: 404, code: 'EVIDENCE_REQUEST_NOT_FOUND' });
  const targetIdentity = value => [value?.firm_id, value?.client_id, value?.transaction_id || null,
    value?.review_item_id || null, value?.canonical_anchor || null, value?.document_id || null];
  if (!selected || JSON.stringify(targetIdentity(selected)) !== JSON.stringify(targetIdentity({ ...row,
    document_id: row.request_payload?.document_id })) || row.firm_id !== firmId || (row.transaction_id
    ? targets.length !== 1 || targets[0].id !== row.transaction_id || targets[0].client_id !== row.client_id
    : targets.length !== 0)) {
    throw Object.assign(new Error('The evidence request target changed; reload the question.'), { statusCode: 409, code: 'EVIDENCE_REQUEST_TARGET_CHANGED' });
  }
  return row;
};

const assertEvidenceReplyAuthority = async (client, { firmId, row, replyAuthority }) => {
  // Every marked native book requires a supported human transport, regardless
  // of rollout. Preserve existing non-native internal/channel/token contracts.
  const lineage = await readNativeChartLineage({ query: client.query.bind(client), firmId, clientId: row.client_id });
  const principal = replyAuthority?.principal;
  if (!['firm_member', 'firm_collaborator'].includes(principal?.principalType)) {
    if (lineage) throw Object.assign(new Error('A current authenticated human must answer this native processing question.'), {
      code: 'NATIVE_OWNER_REPLY_AUTHORITY_REQUIRED', statusCode: 409 });
    return null;
  }
  const access = await assertFirmAccess({ firmId, clientIds: [row.client_id], resolvedPrincipal: principal, dbClient: client });
  return { source: replyAuthority.source, firm_id: firmId, client_id: row.client_id,
    principal_type: access.principal.principalType, principal_id: access.principal.principalId };
};

export const recordEvidenceTopicTurnInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  evidenceRequestId,
  topicState,
  actorId = 'client',
  actorType = 'client',
  replyAuthority = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  const cleanRequestId = String(evidenceRequestId || '').trim();
  if (!cleanRequestId) {
    const error = new Error('Evidence request id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_ID_REQUIRED';
    throw error;
  }
  if (!topicState || typeof topicState !== 'object' || Array.isArray(topicState)) {
    const error = new Error('Evidence topic state is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_TOPIC_STATE_REQUIRED';
    throw error;
  }
  ({ replyAuthority, actorId } = await prepareEvidenceReplyAuthority({ firmId, replyAuthority, actorId }));
  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      const target = await lockEvidenceReplyTarget(client, firmId, cleanRequestId);
      const authority = await assertEvidenceReplyAuthority(client, { firmId, row: target, replyAuthority });
      const guardedTopic = authority ? { ...topicState, actor_id: actorId, reply_authority: authority } : topicState;
      const result = await client.query(
        `update client_evidence_requests
            set request_payload = coalesce(request_payload, '{}'::jsonb) || jsonb_build_object('evidence_topic', $3::jsonb),
                updated_at = now()
          where firm_id = $1
            and id = $2
            and status in ('draft', 'open')
          returning *`,
        // W1 (INV-14): a `draft` is a live question the owner can reach through
        // the portal (a pull, not a send) — a turn on it is honest engagement, so
        // the topic writer accepts both live states. The stamps stay untouched:
        // nothing was SENT.
        // Three placeholders, three values. The actor and channel already ride
        // INSIDE the topic state (buildEvidenceTopicState stamps actor_id +
        // channel); binding them here as $4/$5 was a PostgreSQL bind error
        // ("bind message supplies 5 parameters, but prepared statement requires
        // 3") that failed EVERY portal / SMS / Telegram / WhatsApp topic turn
        // since #1932 — the portal reply never left the ask row (2026-09-03).
        [firmId, cleanRequestId, JSON.stringify(guardedTopic)]
      );
      const row = result.rows[0] || null;
      if (!row) {
        const error = new Error('Open evidence request was not found.');
        error.statusCode = 404;
        error.code = 'OPEN_EVIDENCE_REQUEST_NOT_FOUND';
        throw error;
      }
      await client.query('commit');
      return { evidence_request: row, evidence_topic: row.request_payload?.evidence_topic || guardedTopic };
    } catch (error) { await client.query('rollback'); throw error; }
  });
};

export const listOpenEvidenceTopicsForReminderInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId = null,
  limit = 25,
  withFirmDbClientFn = withFirmDbClient
} = {}) => withFirmDbClientFn(async (client) => {
  const params = [firmId, Math.min(Math.max(Number(limit) || 25, 1), 200)];
  const clientClause = clientId ? `and client_id = $${params.push(clientId)}` : '';
  const result = await client.query(
    `select *
       from client_evidence_requests
      where firm_id = $1
        and status = 'open'
        and audience = 'client'
        and request_payload->'evidence_topic'->>'status' = 'open'
        ${clientClause}
      order by coalesce(request_payload->'evidence_topic'->>'last_owner_message_at', updated_at::text) asc
      limit $2`,
    params
  );
  return result.rows || [];
});

export const stampEvidenceTopicReminderInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  evidenceRequestId,
  topicState,
  actorId = 'evidence_topic_reminder_sweep',
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  const cleanRequestId = String(evidenceRequestId || '').trim();
  if (!cleanRequestId) {
    const error = new Error('Evidence request id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_ID_REQUIRED';
    throw error;
  }
  if (!topicState || typeof topicState !== 'object' || Array.isArray(topicState)) {
    const error = new Error('Evidence topic state is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_TOPIC_STATE_REQUIRED';
    throw error;
  }
  return withFirmDbClientFn(async (client) => {
    const result = await client.query(
      `update client_evidence_requests
          set request_payload = coalesce(request_payload, '{}'::jsonb) || jsonb_build_object('evidence_topic', $3::jsonb),
              updated_at = now()
        where firm_id = $1
          and id = $2
          and status = 'open'
          and request_payload->'evidence_topic'->>'status' = 'open'
        returning *`,
      // Three placeholders, three values (the same bind-count bug as the turn
      // writer above; the sweep's actor is in the topic state it stamps).
      [firmId, cleanRequestId, JSON.stringify(topicState)]
    );
    const row = result.rows[0] || null;
    if (!row) {
      const error = new Error('Open evidence topic was not found.');
      error.statusCode = 404;
      error.code = 'OPEN_EVIDENCE_TOPIC_NOT_FOUND';
      throw error;
    }
    return { evidence_request: row, evidence_topic: row.request_payload?.evidence_topic || topicState };
  });
};

// A1 (asks design Phase 0) — the out-of-band answer channels a firm principal
// may record an answer under. Closed set on purpose (Keep-layer): the source
// is attribution, not prose. Unknown values normalize to null, which the
// resolver treats as "not a firm-recorded answer".
export const ANSWER_SOURCES = Object.freeze(['phone', 'email', 'in_person', 'other']);
export const __normalizeAnswerSource = (value) => {
  const clean = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ANSWER_SOURCES.includes(clean) ? clean : null;
};

export const resolveClientEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  evidenceRequestId,
  reply,
  documentIds = [],
  nextReviewState = null,
  resolutionNote = '',
  actorId = 'system',
  actorType = 'system',
  replyAuthority = null,
  // A1 — set ONLY when a firm principal records the client's answer received
  // out-of-band (phone / their own email / in person). Rides the SAME resolve
  // spine as a portal reply — recode, evidence link, loops inbox event — the
  // affordance is attribution plumbing, never a second reply pipeline.
  answerSource = null
} = {}) => {
  const cleanRequestId = String(evidenceRequestId || '').trim();
  const cleanReply = String(reply || '').trim();
  const cleanAnswerSource = __normalizeAnswerSource(answerSource);
  const cleanNextReviewState = normalizeTransactionReviewState(nextReviewState);
  if (!cleanRequestId) {
    const error = new Error('Evidence request id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_ID_REQUIRED';
    throw error;
  }

  ({ replyAuthority, actorId } = await prepareEvidenceReplyAuthority({ firmId, replyAuthority, actorId }));
  const resolveResult = await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const row = await lockEvidenceReplyTarget(client, firmId, cleanRequestId);
      // Release the generic ask transaction before entering the opening
      // consumer's client → period → ask lock order. It owns post + closure.
      if (row.evidence_type === 'ae_opening_balance') {
        await client.query('rollback');
        return { aeOpeningClientId: row.client_id };
      }
      const authority = await assertEvidenceReplyAuthority(client, { firmId, row, replyAuthority });
      const now = new Date().toISOString();
      const nextRequestStatus = cleanNextReviewState ? 'resolved' : 'replied';
      // RT-16: a firm resolution names the line's next coding state in the
      // legacy label vocabulary; the ledger rungs are FACTS the posting
      // writers alone may write — resolving an ask cannot fabricate them.
      const nextCodingStateFromResolve = cleanNextReviewState ? codingStateFromReviewState(cleanNextReviewState) : null;
      if (nextCodingStateFromResolve && ['posted', 'synced', 'closed'].includes(nextCodingStateFromResolve)) {
        const error = new Error(`An evidence request cannot be resolved into "${cleanNextReviewState}" — that is a ledger fact written by the posting writers.`);
        error.statusCode = 400;
        error.code = 'EVIDENCE_REQUEST_RESOLVE_STATE_INVALID';
        throw error;
      }
      const cleanDocumentIds = Array.isArray(documentIds) && documentIds.length
        ? documentIds.filter(Boolean)
        : Array.isArray(row.response_payload?.document_ids)
          ? row.response_payload.document_ids.filter(Boolean)
          : [];
      const responsePayload = {
        ...(row.response_payload || {}),
        reply: cleanReply || row.response_payload?.reply || null,
        document_ids: cleanDocumentIds,
        resolution_note: resolutionNote || null,
        // A1 attribution: WHO recorded the answer and over WHICH channel.
        // Only stamped for firm-recorded out-of-band answers; a portal reply
        // keeps these absent, so the two ingestion lanes stay tellable apart
        // from the data alone.
        ...(cleanAnswerSource
          ? { answer_source: cleanAnswerSource, answer_recorded_by: actorId }
          : {}),
        responded_at: now,
        ...(cleanNextReviewState
          ? {
              resolved_review_state: cleanNextReviewState,
              resolved_at: now
            }
          : {})
      };
      if (!cleanNextReviewState) {
        responsePayload.reply_processing = {
          reply_key: ownerReplyIdentity({ id: row.id, response_payload: responsePayload }),
          state: 'pending', attempts: 0, actor_id: actorId, actor_type: actorType,
          ...(authority ? { authority_basis: authority } : {})
        };
      }
      const resolvedEvidencePayload = {
        ...(row.request_payload?.evidence_request || {}),
        id: row.id,
        status: nextRequestStatus,
        replied_at: new Date(now).getTime(),
        ...(cleanNextReviewState ? { resolved_at: new Date(now).getTime() } : {})
      };
      const updated = await client.query(
        `update client_evidence_requests
         set status = $3,
             response_payload = response_payload || $4::jsonb,
             responded_at = coalesce(responded_at, $5::timestamptz),
             resolved_at = case when $7::boolean then $5::timestamptz else resolved_at end,
             resolved_by = case when $7::boolean then $6 else resolved_by end,
             updated_at = now()
         where firm_id = $1 and id = $2
         returning *`,
        [firmId, cleanRequestId, nextRequestStatus, JSON.stringify(responsePayload), now, actorId, Boolean(cleanNextReviewState)]
      );
      let request = rowToClientEvidenceRequestPayload(updated.rows[0]);

      if (row.review_item_id) {
        const finalStatus = cleanNextReviewState && shouldCloseReviewForState(cleanNextReviewState) ? 'resolved' : 'open';
        await client.query(
          `update transaction_review_queue
           set status = $4,
               payload = payload || $5::jsonb,
               updated_at = now()
           where firm_id = $1 and client_id = $2 and id = $3`,
          [
            firmId,
            row.client_id,
            row.review_item_id,
            finalStatus,
            JSON.stringify({
              client_reply: cleanReply || null,
              evidence_request: resolvedEvidencePayload,
              evidence_document_ids: responsePayload.document_ids,
              reviewer_note: resolutionNote || (cleanNextReviewState
                ? 'Client evidence request resolved.'
                : 'Client replied; firm review required before posting.')
            })
          ]
        );
      }

      if (row.transaction_id) {
        await client.query(
          `update transactions
           set status = 'needs_review',
               payload = payload || $4::jsonb,
               updated_at = now()
           where firm_id = $1 and client_id = $2 and id = $3
             and coalesce(coding_state, '') not in ('posted', 'synced', 'closed')`,
          [
            firmId,
            row.client_id,
            row.transaction_id,
            JSON.stringify({
              status: 'needs_review',
              client_reply: cleanReply || null,
              evidence_request: resolvedEvidencePayload,
              evidence_document_ids: responsePayload.document_ids,
              evidence_responded_at: new Date(now).getTime(),
              ...(cleanNextReviewState ? { evidence_resolved_at: new Date(now).getTime() } : {})
            })
          ]
        );
        // RT-16: a firm resolution moves the coding state it named (refused
        // loudly if the machine forbids it — a posted line is not un-posted
        // by a resolve); a bare reply keeps the line `asked` (F8: an answered
        // ask is Donna's work now, projected off the request's own status).
        if (nextCodingStateFromResolve) {
          await applyCodingTransition(client, { firmId, clientId: row.client_id, transactionId: row.transaction_id, to: nextCodingStateFromResolve });
        } else {
          await applyCodingTransitionIfAllowed(client, { firmId, clientId: row.client_id, transactionId: row.transaction_id, to: 'asked' });
        }
      }

      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $7, $3, $6, 'client_evidence_request', $4, $5::jsonb)`,
        [
          firmId,
          row.client_id,
          actorId,
          row.id,
          JSON.stringify({
            transaction_id: row.transaction_id,
            review_item_id: row.review_item_id,
            ...(authority ? { authority_basis: authority } : {}),
            review_state: cleanNextReviewState,
            document_ids: responsePayload.document_ids,
            resolution_note: resolutionNote || null,
            ...(!cleanNextReviewState ? {
              reply_key: responsePayload.reply_processing.reply_key,
              reply: responsePayload.reply,
              responded_at: responsePayload.responded_at
            } : {}),
            ...(cleanAnswerSource ? { answer_source: cleanAnswerSource } : {})
          }),
          cleanNextReviewState ? 'evidence_request.resolve' : 'evidence_request.reply',
          actorType || 'system'
        ]
      );

      await client.query('commit');

      // A client REPLY resumes the line — and a reply can be TEXT, an uploaded
      // DOCUMENT, or both. We ask for a document (evidence_type
      // 'supporting_document') far more often than for a sentence, and a client
      // answering "send the payout report" naturally uploads the file with NO
      // text. Gating the resume on text alone stranded that exact case: the
      // report landed on the evidence request but nothing re-ran, so the line
      // sat at ASKED forever. Resume whenever EITHER text or a document arrived.
      const hasReplyContent = __shouldResumeFromClientReply({ reply: cleanReply, documentIds: cleanDocumentIds });

      // Donna Loops shadow producer (post-commit, no-throw, LOOPS_SHADOW-gated):
      // record the at-least-once client_reply.received inbox event + link it to
      // the evidence case. Inbox-only — no interpretation, no resolution. This
      // is what wakes the reconciliation case to re-match the line.
      if (hasReplyContent) {
        await onClientReplyReceived({
          client, firmId, clientId: row.client_id,
          evidenceRequestId: row.id, replyEventId: `${row.id}:${now}`,
          transactionId: row.transaction_id || null
        });
      }

      // The clear half: a client reply (text AND/OR an uploaded document, but
      // NOT a firm resolution with an explicit review_state) re-invokes the
      // strong coder on the line with the reply text and the uploaded documents
      // as evidence (__recode… already loads replyDocumentIds as coder context).
      // Runs after commit — the reply is durable; a failed re-code degrades to
      // a visible recovery obligation.
      let recode = null;
      const { supportsStructuredOwnerReply } = await import('../statutoryRegistry.js');
      const structuredReply = supportsStructuredOwnerReply(row);
      // A document-anchored ask (request_payload.document_id, transaction_id
      // null) without a registered factual consumer: its consumer is the
      // reply-informed re-disposition, driven through the SAME owner-reply
      // clock so a failed first attempt is retried under its bounds.
      const docAskDocumentId = documentOwnerReplyDocumentId(row);
      const documentReply = Boolean(docAskDocumentId) && !structuredReply;
      if (hasReplyContent && (row.transaction_id || structuredReply || documentReply) && !cleanNextReviewState) {
        try {
          const { processOwnerReplyWithClient } = await import('../ownerReplyRecovery.js');
          recode = await processOwnerReplyWithClient({ client, firmId, clientId: row.client_id,
            evidenceRequestId: row.id, actorId });
          if (recode?.applied || recode?.needsClarification) {
            const refreshed = await client.query(
              'select * from client_evidence_requests where firm_id = $1 and id = $2 limit 1',
              [firmId, cleanRequestId]
            );
            if (refreshed.rows[0]) request = rowToClientEvidenceRequestPayload(refreshed.rows[0]);
          }
        } catch (recodeError) {
          recode = { applied: false, error: recodeError?.message || 'Reply re-code failed.', ...(isCodingPolicyError(recodeError) ? { policy_failure: true, code: recodeError.code } : {}) };
        }
      }

      // Doc-first drain Slice 4a (docs/donna-settlement-answer-and-ledger-entry-plan.md
      // §2) — the ANSWER leg, the doc-anchored sibling of the recode branch
      // above: a reply on a doc-anchored ask feeds ONE reply-informed
      // re-disposition whose upserted verdict replaces the chase_evidence that
      // minted the ask, and the request flips 'resolved' in the same commit.
      // Gated on the SAME plane flag the ask leg acts under
      // (documentOwnerReply.js). A plain document ask rode the owner-reply
      // clock above; its outcome is reported here, never as a bank-line recode.
      let documentDisposition = null;
      if (documentReply && recode) {
        documentDisposition = recode.document_disposition
          || (recode.error ? { error: recode.error, code: recode.code || null } : { skipped: recode.skipped || null });
        recode = null;
      }
      // A registered factual consumer that also names a document keeps its
      // re-disposition pass. A matched invoice is the prerequisite for the VAT
      // business-use ask, never its answer: its consumer owns resolution,
      // including failed interpretation and clarification; the generic
      // live-match redisposition must not erase that still-owed fact.
      if (hasReplyContent && docAskDocumentId && structuredReply && !cleanNextReviewState && row.evidence_type !== 'ae_vat_business_use') {
        try {
          documentDisposition = await redisposeDocumentOwnerReplyWithClient({ client, firmId,
            request: { ...row, response_payload: { ...responsePayload, reply: cleanReply } }, actorId });
          if (documentDisposition?.request_resolved) {
            const refreshed = await client.query(
              'select * from client_evidence_requests where firm_id = $1 and id = $2 limit 1',
              [firmId, cleanRequestId]
            );
            if (refreshed.rows[0]) request = rowToClientEvidenceRequestPayload(refreshed.rows[0]);
          }
        } catch (redisposeError) {
          documentDisposition = { error: redisposeError?.message || 'Reply re-disposition failed.' };
        }
      }

      // Snapshot + any auto-post happen AFTER this txn commits (below), OUTSIDE
      // the connection — the firm DB pool is small (max 2) and ledger posting
      // grabs its own connection(s), so nesting it here would deadlock.
      return {
        evidence_request: request,
        recode,
        documentDisposition,
        clientId: row.client_id,
        transactionId: row.transaction_id || null
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  if (resolveResult.aeOpeningClientId) {
    const { actAeOpeningFromDb } = await import('../ae/openingBalanceDb.js');
    const result = await actAeOpeningFromDb({ firmId, clientId: resolveResult.aeOpeningClientId,
      askId: cleanRequestId, action: 'reply', reply: cleanReply, actorId,
      authorityBasis: { source: 'owner_portal_intake', answer_source: cleanAnswerSource } });
    const saved = await queryFirmDb('select * from client_evidence_requests where firm_id=$1 and id=$2', [firmId, cleanRequestId]);
    return { evidence_request: rowToClientEvidenceRequestPayload(saved.rows[0]), opening_balance: result,
      snapshot: await getFirmSnapshotFromDb({ firmId }) };
  }

  // #ask-reply-autopost — two-terminal-states: a confident reply-recode AUTO-
  // RECONCILES the line. Once the recode applied the coding (committed above),
  // post it to the Donna ledger (internal only — no external Xero call) so it
  // lands in the Reconciled tab as a posted line instead of resting at
  // "accepted, click to post". Runs OUTSIDE the resolve txn/connection (pool
  // max 2). Best-effort: a posting failure leaves the line accepted/explained
  // (still shown in the Reconciled tab) rather than failing the durable reply.
  if (resolveResult.recode?.applied && resolveResult.transactionId) {
    try {
      const scope = await readRetainedProcessingScopeInDb({ firmId,clientId:resolveResult.clientId });
      if (!scope.allowed) {
        resolveResult.recode.posted = false;
        resolveResult.recode.posting_unavailable = scope.reason_code;
      } else {
      await postLedgerTransactionInDb({
        firmId,
        clientId: resolveResult.clientId,
        transactionId: resolveResult.transactionId,
        dryRun: false
      });
      resolveResult.recode.posted = true;
      }
    } catch (postError) {
      resolveResult.recode.posted = false;
      resolveResult.recode.post_error = postError?.message || 'Ledger post failed.';
    }
  }

  const snapshot = await getFirmSnapshotFromDb({ firmId });
  return {
    evidence_request: resolveResult.evidence_request,
    recode: resolveResult.recode,
    document_disposition: resolveResult.documentDisposition || null,
    snapshot
  };
};

// ── Evidence-reply recode RESUME after the uploaded doc finishes parsing ──────
//
// The bug this closes (the "Shopify settlement" case): a client answers an ask by
// uploading the requested document. resolveClientEvidenceRequestInDb runs the
// reply-recode SYNCHRONOUSLY — but document parsing is ASYNC (the portal registers
// the file, which only ENQUEUES a parse, then resolves the request immediately).
// So the synchronous recode reads the doc via loadReplyDocumentsWithContent BEFORE
// any content exists (no document_lines, null totals) → the coder can't settle →
// __shouldApplyReplyRecode is false → the line is stranded at review_state
// 'waiting' / the request at 'replied' (on_owner), and NOTHING re-runs once the
// content lands (the parse worker's matcher scan is gated on a written bank
// statement, which an evidence doc is not). This is the parse-completion RETRY:
// once the evidence doc is parsed, re-run the SAME recode with content present so a
// client answer actually reconciles the line.
//
// With-client core (unit-pinned via a mock pg client, like the recode itself); the
// wrapper owns the connection + the post-commit auto-post.
export const __resumeEvidenceRecodeAfterParseWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  documentId,
  actorId = 'system',
  recodeFn = __recodeTransactionAfterClientReplyWithClient
} = {}) => {
  const cleanDocumentId = String(documentId || '').trim();
  if (!cleanDocumentId) return { applied: false, skipped: 'no_document' };

  // The evidence linkage is stored in the document payload JSONB (set at portal
  // registration — buildEvidenceDocument), NOT as columns: the top-level
  // evidence_request_id / transaction_id, with evidence_context as the fallback.
  const docRes = await client.query(
    `select id, client_id,
            coalesce(payload->>'channel', payload->>'source') as reply_channel,
            coalesce(payload->>'evidence_request_id', payload->'evidence_context'->>'request_id') as evidence_request_id,
            coalesce(payload->>'transaction_id', payload->'evidence_context'->>'transaction_id') as transaction_id
       from documents where firm_id = $1 and id = $2 limit 1`,
    [firmId, cleanDocumentId]
  );
  const doc = docRes.rows[0];
  if (!doc || !doc.evidence_request_id || !doc.transaction_id) {
    return { applied: false, skipped: 'not_evidence_linked' };
  }
  const clientId = doc.client_id;

  const reqRes = await client.query(
    `select * from client_evidence_requests
      where firm_id = $1 and id = $2 and client_id = $3 limit 1`,
    [firmId, doc.evidence_request_id, clientId]
  );
  const requestRow = reqRes.rows[0];
  if (!requestRow) return { applied: false, skipped: 'no_request' };
  // Only a client REPLY (status 'replied') is in scope — a firm resolution
  // ('resolved' with a review_state) or an unanswered request ('open'/'draft')
  // must not be recoded here.
  if (String(requestRow.status || '').trim().toLowerCase() !== 'replied') {
    return { applied: false, skipped: `request_status:${requestRow.status || 'none'}` };
  }

  // Guard: if the synchronous reply-recode already settled the line (content was
  // ready, or a text reply was enough), do nothing — idempotent across re-parses.
  const txRes = await client.query(
    `select id, reconciliation_status, coding_state
       from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
    [firmId, clientId, doc.transaction_id]
  );
  const tx = txRes.rows[0];
  if (!tx) return { applied: false, skipped: 'no_transaction' };
  const lc = (v) => String(v || '').trim().toLowerCase();
  // RT-16: decided on the ONE column, or settled on the reconciliation axis.
  const alreadySettled =
    isDecidedCodingState(tx.coding_state) ||
    ['reconciled', 'posted', 'auto_reconciled', 'explained'].includes(lc(tx.reconciliation_status));
  if (alreadySettled) return { applied: false, skipped: 'already_settled' };

  const request = rowToClientEvidenceRequestPayload(requestRow);
  const documentIds = Array.isArray(request.response_payload?.document_ids) && request.response_payload.document_ids.length
    ? request.response_payload.document_ids.filter(Boolean)
    : [cleanDocumentId];
  const replyText = String(request.response_payload?.reply || '');

  const recode = await recodeFn({
    client, firmId, clientId,
    transactionId: doc.transaction_id,
    evidenceRequest: request,
    reply: replyText,
    replyDocumentIds: documentIds,
    actorId
  });
  return { ...(recode || {}), clientId, transactionId: doc.transaction_id, evidenceRequestId: request.id, replyChannel: doc.reply_channel || null };
};

// Connection-owning wrapper: the parse worker calls this on parse-completion.
export const resumeEvidenceRecodeAfterParseInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  documentId,
  actorId = 'system'
} = {}) => {
  const { processOwnerReplyWithClient } = await import('../ownerReplyRecovery.js');
  const result = await withFirmDbClient((client) =>
    __resumeEvidenceRecodeAfterParseWithClient({ client, firmId, documentId, actorId,
      recodeFn: ({ clientId, evidenceRequest, replyDocumentIds }) => processOwnerReplyWithClient({
        client, firmId, clientId, evidenceRequestId: evidenceRequest.id, actorId, force: true,
        recodeFn: (args) => __recodeTransactionAfterClientReplyWithClient({ ...args,
          replyDocumentIds: args.replyDocumentIds.length ? args.replyDocumentIds : replyDocumentIds })
      })
    })
  );

  // #ask-reply-autopost (mirrors resolveClientEvidenceRequestInDb): a confident
  // recode AUTO-RECONCILES the line — post it to the Donna ledger so it lands in
  // Reconciled as a posted line. Runs OUTSIDE the resolve connection (pool max 2);
  // a post failure leaves the line accepted/explained (still in Reconciled).
  if (result?.applied && result.transactionId) {
    try {
      const scope = await readRetainedProcessingScopeInDb({ firmId,clientId:result.clientId });
      if (!scope.allowed) {
        result.posted = false;
        result.posting_unavailable = scope.reason_code;
      } else {
        await postLedgerTransactionInDb({ firmId,clientId:result.clientId,transactionId:result.transactionId,dryRun:false });
        result.posted = true;
      }
    } catch (postError) {
      result.posted = false;
      result.post_error = postError?.message || 'Ledger post failed.';
    }
  }

  // #ask-reply-confirm — the async sibling of the in-band text-reply consequence
  // line: a PHOTO/DOC answer reconciles here on parse-completion, long after the
  // inbound webhook acked, so tell the owner what Donna booked with a follow-up
  // WhatsApp message. Born dark (EVIDENCE_REPLY_RECONCILED_CONFIRM, config plane),
  // best-effort/no-throw, and fires ONLY on the single applied transition (the
  // resume's already-settled guard makes it idempotent). Dynamic import: this
  // module statically imports firmDb, so a static import here would be a cycle
  // (same reason documentDispositionLlm is imported dynamically above).
  if (result?.applied && !result.posting_unavailable && result.transactionId && result.clientId) {
    try {
      const { sendReplyReconciledConfirmation } = await import('../channels/evidenceReplyConfirm.js');
      result.confirmation = await sendReplyReconciledConfirmation({
        firmId,
        clientId: result.clientId,
        transactionId: result.transactionId,
        evidenceRequestId: result.evidenceRequestId || null,
        channel: result.replyChannel || 'whatsapp',
        recode: result
      });
    } catch (confirmError) {
      result.confirmation = { skipped: 'error', error: confirmError?.message || 'Confirmation send failed.' };
    }
  }
  return result;
};

export const acceptClientEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  evidenceRequestId,
  nextReviewState = 'accepted',
  resolutionNote = '',
  actorId = 'system',
  replyAuthority = null
} = {}) => {
  const cleanRequestId = String(evidenceRequestId || '').trim();
  const cleanNextReviewState = normalizeTransactionReviewState(nextReviewState) || 'accepted';
  if (!cleanRequestId) {
    const error = new Error('Evidence request id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_ID_REQUIRED';
    throw error;
  }

  const existing = await queryOptionalFirmDb(
    `select *
     from client_evidence_requests
     where firm_id = $1 and id = $2
     limit 1`,
    [firmId, cleanRequestId]
  );
  const row = existing.rows[0] || null;
  if (!row) {
    const error = new Error('Evidence request was not found.');
    error.statusCode = 404;
    error.code = 'EVIDENCE_REQUEST_NOT_FOUND';
    throw error;
  }
  const responsePayload = row.response_payload || {};
  const documentIds = Array.from(new Set([
    ...(Array.isArray(responsePayload.document_ids) ? responsePayload.document_ids : []),
    ...(Array.isArray(responsePayload.documents) ? responsePayload.documents.map((document) => document?.id || document) : [])
  ].filter(Boolean)));
  const hasClientResponse = Boolean(String(responsePayload.reply || '').trim() || documentIds.length || row.responded_at);
  if (!hasClientResponse || !['replied', 'resolved'].includes(row.status)) {
    const error = new Error('Client evidence has not been replied to yet.');
    error.statusCode = 409;
    error.code = 'EVIDENCE_REQUEST_NOT_REPLIED';
    throw error;
  }

  return resolveClientEvidenceRequestInDb({
    firmId,
    evidenceRequestId: cleanRequestId,
    reply: responsePayload.reply || '',
    documentIds,
    nextReviewState: cleanNextReviewState,
    resolutionNote: resolutionNote || 'Firm accepted client evidence for close.',
    actorId, replyAuthority
  });
};

export const rejectClientEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  evidenceRequestId,
  rejectionReason = '',
  followUpQuestion = '',
  dueAt,
  actorId = 'system'
} = {}) => {
  const cleanRequestId = String(evidenceRequestId || '').trim();
  const cleanReason = String(rejectionReason || '').trim();
  const cleanFollowUpQuestion = String(followUpQuestion || '').trim();
  if (!cleanRequestId) {
    const error = new Error('Evidence request id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_ID_REQUIRED';
    throw error;
  }

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const existing = await client.query(
        `select *
         from client_evidence_requests
         where firm_id = $1 and id = $2
         limit 1`,
        [firmId, cleanRequestId]
      );
      const row = existing.rows[0] || null;
      if (!row) {
        const error = new Error('Evidence request was not found.');
        error.statusCode = 404;
        error.code = 'EVIDENCE_REQUEST_NOT_FOUND';
        throw error;
      }

      const now = new Date().toISOString();
      const previousResponse = row.response_payload || {};
      const documentIds = Array.from(new Set([
        ...(Array.isArray(previousResponse.document_ids) ? previousResponse.document_ids : []),
        ...(Array.isArray(previousResponse.documents) ? previousResponse.documents.map((document) => document?.id || document) : [])
      ].filter(Boolean)));
      const nextQuestion = cleanFollowUpQuestion || row.question || row.request_payload?.evidence_request?.question || 'Please upload supporting evidence.';
      const nextSendCount = Number(row.send_count || 0) + 1;
      const rejectedEvidencePayload = {
        ...(row.request_payload?.evidence_request || {}),
        id: row.id,
        status: 'open',
        question: nextQuestion,
        sent_at: new Date(now).getTime(),
        send_count: nextSendCount,
        rejected_at: new Date(now).getTime()
      };
      const nextRequestPayload = {
        ...(row.request_payload || {}),
        evidence_request: rejectedEvidencePayload
      };
      const nextResponsePayload = {
        ...previousResponse,
        rejection: {
          status: 'rejected',
          reason: cleanReason || null,
          rejected_at: now,
          rejected_by: actorId,
          previous_document_ids: documentIds
        }
      };

      const updated = await client.query(
        `update client_evidence_requests
         set status = 'open',
             question = $3,
             request_payload = request_payload || $4::jsonb,
             response_payload = $5::jsonb,
             last_sent_at = $6::timestamptz,
             send_count = $7,
             due_at = coalesce($8::timestamptz, due_at),
             resolved_at = null,
             resolved_by = null,
             updated_at = now()
         where firm_id = $1 and id = $2
         returning *`,
        [
          firmId,
          cleanRequestId,
          nextQuestion,
          JSON.stringify(nextRequestPayload),
          JSON.stringify(nextResponsePayload),
          now,
          nextSendCount,
          dueAt ? new Date(dueAt).toISOString() : null
        ]
      );
      const request = rowToClientEvidenceRequestPayload(updated.rows[0]);

      if (row.review_item_id) {
        await client.query(
          `update transaction_review_queue
           set status = 'open',
               payload = payload || $4::jsonb,
               updated_at = now()
           where firm_id = $1 and client_id = $2 and id = $3`,
          [
            firmId,
            row.client_id,
            row.review_item_id,
            JSON.stringify({
              client_question: nextQuestion,
              evidence_request: rejectedEvidencePayload,
              evidence_document_ids: documentIds,
              reviewer_note: cleanReason
                ? `Client evidence rejected: ${cleanReason}`
                : 'Client evidence rejected; follow-up requested.'
            })
          ]
        );
      }

      if (row.transaction_id) {
        await client.query(
          `update transactions
           set status = 'needs_client',
               payload = payload || $4::jsonb,
               updated_at = now()
           where firm_id = $1 and client_id = $2 and id = $3`,
          [
            firmId,
            row.client_id,
            row.transaction_id,
            JSON.stringify({
              status: 'needs_client',
              transaction_status: 'needs_client',
              client_question: nextQuestion,
              evidence_request: rejectedEvidencePayload,
              evidence_document_ids: documentIds,
              evidence_rejected_at: new Date(now).getTime()
            })
          ]
        );
        // RT-16: the follow-up puts the coding back on the owner.
        await applyCodingTransitionIfAllowed(client, { firmId, clientId: row.client_id, transactionId: row.transaction_id, to: 'asked' });
      }

      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'evidence_request.reject', 'client_evidence_request', $4, $5::jsonb)`,
        [
          firmId,
          row.client_id,
          actorId,
          row.id,
          JSON.stringify({
            transaction_id: row.transaction_id,
            review_item_id: row.review_item_id,
            reason: cleanReason || null,
            follow_up_question: nextQuestion,
            document_ids: documentIds
          })
        ]
      );

      await client.query('commit');
      const snapshot = await getFirmSnapshotFromDb({ firmId });
      return {
        evidence_request: request,
        snapshot
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// ─── Ask lifecycle: cancel + resend (godmode build-spec PR-9 / G1b) ──────
//
// The statuses from which an ask may still be CANCELLED. Deliberately narrow:
// 'replied' is excluded because the owner already did their part — silently
// cancelling an answered question throws their answer away and tells them
// nothing. The chat verb points a "cancel" on a replied ask at the
// dispute/correct path instead (spec PR-9), and this writer refuses it so the
// route can never route around that.
export const CANCELLABLE_EVIDENCE_REQUEST_STATUSES = Object.freeze(['draft', 'open']);

// How recently an ask may have genuinely reached the owner before a further
// resend is refused as a duplicate. See resendClientEvidenceRequestInDb for
// why this is the verb's idempotency rather than a cadence rule.
export const RESEND_MIN_INTERVAL_MS = 5 * 60 * 1000;

// Cancel ONE open owner ask.
//
// The ground-truth audit's headline (plan §5 G1b): 'cancelled' was a DEAD
// enum value. Migration 009's CHECK has admitted it since the table was born,
// and two readers already depend on its meaning — askIdentity's
// ACTIVE_ASK_STATUSES excludes it so a cancel FREES the anchor for a
// legitimate re-ask (the KUILI rule), and reconcileConvergenceState's
// OPEN_OWNER_ASK_STATUSES excludes it so a cancelled ask stops resting on the
// owner. Nothing ever wrote it. This is that writer, and it needs no
// migration precisely because the CHECK was already right.
//
// Audit-as-precondition (the PR-10 posture): the `evidence_request.cancelled`
// row is written INSIDE the same transaction as the status flip, attributed to
// the acting principal — no record, no cancellation.
//
// The caller gets the two-terminal-states consequence back rather than a bare
// "done": cancelling removes the line from on_owner WITHOUT auto-reconciling
// it, so unless the line is already coded it returns to HANGING — which the
// FIRST principle calls a violation to surface, not to hide. `leaves_line_hanging`
// is that surfacing. (The other moot-ask path — resolveOpenEvidenceRequestsForTransaction,
// "applied coding outranks an open ask" — converges properly; cancel is for
// asks that should never have been sent.)
export const cancelClientEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId = '',
  evidenceRequestId,
  // Optional anchor scope. The per-transaction chat has no proposal-time
  // sanitizer (unlike the feed), so without this an ask id belonging to a
  // SIBLING line of the same client would pass the client check and be
  // cancelled from a case that has nothing to do with it. Absent ⇒ client
  // scope only, which is the feed's correct behaviour.
  transactionId = '',
  reason = '',
  actorId = 'system'
} = {}) => {
  const cleanRequestId = String(evidenceRequestId || '').trim();
  const cleanReason = String(reason || '').trim();
  if (!cleanRequestId) {
    const error = new Error('Evidence request id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_ID_REQUIRED';
    throw error;
  }

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      // FOR UPDATE: two operators cancelling the same ask, or a cancel racing
      // the owner's reply, must serialize on the row — the status guard below
      // is only honest under the lock.
      const existing = await client.query(
        `select * from client_evidence_requests
          where firm_id = $1 and id = $2
          for update`,
        [firmId, cleanRequestId]
      );
      const row = existing.rows[0] || null;
      // The feed/txn chats are client-scoped; an ask id from another book must
      // read as not-found, never as a cross-client write. With an anchor
      // scope, an ask on a sibling line reads the same way.
      if (!row
        || (clientId && row.client_id !== clientId)
        || (transactionId && String(row.transaction_id || '') !== String(transactionId))) {
        await client.query('rollback');
        const error = new Error('Evidence request was not found.');
        error.statusCode = 404;
        error.code = 'EVIDENCE_REQUEST_NOT_FOUND';
        throw error;
      }
      if (!CANCELLABLE_EVIDENCE_REQUEST_STATUSES.includes(row.status)) {
        await client.query('rollback');
        return {
          cancelled: false,
          evidence_request_id: row.id,
          prior_status: row.status,
          status: row.status,
          skipped_reason: row.status === 'replied' ? 'already_answered' : `not_cancellable_${row.status}`
        };
      }

      const nowIso = new Date().toISOString();
      const cancellation = {
        at: nowIso,
        by: String(actorId || 'system'),
        reason: cleanReason || null,
        prior_status: row.status,
        send_count: Number(row.send_count || 0)
      };
      // The request_payload.evidence_request envelope is what the client
      // portal renders (the re-ask cadence's precedent), so it has to carry
      // the closed status or the owner keeps seeing a live question.
      const envelope = {
        ...(row.request_payload?.evidence_request || {}),
        id: row.id,
        status: 'cancelled',
        cancelled_at: new Date(nowIso).getTime()
      };
      // due_at = null stops the re-ask clock. The sweep already filters on
      // status='open' so this is belt-and-braces, but leaving a due date on a
      // closed ask is the kind of stale clock that reads as a live obligation.
      const updated = await client.query(
        `update client_evidence_requests
            set status = 'cancelled',
                resolved_at = $3::timestamptz,
                resolved_by = $4,
                due_at = null,
                request_payload = coalesce(request_payload, '{}'::jsonb) || $5::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2
          returning *`,
        [
          firmId,
          cleanRequestId,
          nowIso,
          String(actorId || 'system'),
          JSON.stringify({ evidence_request: envelope, cancellation })
        ]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'firm', $3, 'evidence_request.cancelled', 'client_evidence_request', $4, $5::jsonb)`,
        [
          firmId,
          row.client_id,
          String(actorId || 'system'),
          row.id,
          JSON.stringify({
            transaction_id: row.transaction_id || null,
            review_item_id: row.review_item_id || null,
            ...cancellation
          })
        ]
      );
      await client.query('commit');
      // The consequence diff, computed ONCE here so every surface reports the
      // same thing: after the cancellation, does this line rest on either
      // sanctioned terminal? It does NOT if it carries no other live ask and
      // has no posted coding — that is the hanging state the FIRST principle
      // says to surface. Post-commit and best-effort: a read hiccup must never
      // unwind a committed cancellation, so an unknown answer is null, never a
      // confident "fine".
      let leavesLineHanging = null;
      if (row.transaction_id) {
        // Both halves lock-step with reconcileConvergenceState on purpose, so
        // this verdict and the convergence projection can never disagree:
        //   • the coded-account expression mirrors `codedAccountOf` (note
        //     `account_name` is NOT a transactions column — it lives in
        //     payload; the real-PG test caught exactly that, which a mock
        //     could not);
        //   • the live-ask count uses OPEN_OWNER_ASK_STATUSES ('draft','open')
        //     and deliberately EXCLUDES 'replied'. An answered-but-unprocessed
        //     ask is F8's `owner_answered_processing` bucket — firm-side work,
        //     i.e. already hanging. Counting it as "still resting on the
        //     owner" would report a hanging line as fine.
        leavesLineHanging = await client.query(
          `select
             (select count(*) from client_evidence_requests
               where firm_id = $1 and transaction_id = $2
                 and status in ('draft', 'open')) as live_asks,
             (select coalesce(
                       nullif(t.category, ''),
                       nullif(t.account_code, ''),
                       nullif(t.payload->>'account_name', ''),
                       nullif(t.payload->>'account_code', ''),
                       '')
                from transactions t where t.firm_id = $1 and t.id = $2) as coded_account`,
          [firmId, row.transaction_id]
        ).then((res) => {
          const state = res.rows[0] || {};
          return Number(state.live_asks || 0) === 0 && !String(state.coded_account || '').trim();
        }).catch((error) => {
          // Never unwind a committed cancellation over a read — but never fail
          // SILENTLY either: an unreported null here is how a broken
          // consequence diff would look exactly like "no anchor".
          console.warn('[cancel-ask] post-cancel convergence read failed', error?.message || error);
          return null;
        });
      }
      return {
        cancelled: true,
        evidence_request: rowToClientEvidenceRequestPayload(updated.rows[0]),
        evidence_request_id: row.id,
        transaction_id: row.transaction_id || null,
        prior_status: row.status,
        status: 'cancelled',
        question: row.question || null,
        reason: cleanReason || null,
        // true  → the line rests on NEITHER terminal (work the firm now owes)
        // false → still coded, or still carries another live owner ask
        // null  → no transaction anchor, or the state read failed
        leaves_line_hanging: leavesLineHanging
      };
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      throw error;
    }
  });
};

// Amend ONE already-SENT owner ask (G1b's §7.2 half, build-spec PR-9 —
// Kari's dated call 2026-08-14, the recommended two-source-aligned shape):
// NO SILENT EDIT OF A SENT ASK. The original question is PRESERVED as the
// head of the composite and the amendment rides below it, explicitly marked
// — every renderer and the resend fan-out read the `question` column, so the
// owner sees original + amendment everywhere without any surface changes.
// The structured history (request_payload.amendments) is the immutable
// record; `evidence_request.amended` audits in-transaction (the PR-10
// posture: no record, no amendment).
//
// Status guards: only an OPEN (sent, unanswered) ask is amendable. A draft
// was never sent — rewording it is the asks tab's editor (edit_ask, the
// pre-send verb, stays unbuilt); an answered/resolved/cancelled ask is
// history, not a live question. Amendments are capped so the composite
// stays a readable question, not a thread.
export const AMENDABLE_EVIDENCE_REQUEST_STATUSES = Object.freeze(['open']);
export const MAX_EVIDENCE_REQUEST_AMENDMENTS = 5;

export const amendClientEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId = '',
  evidenceRequestId,
  // Same optional anchor scope as cancel: the per-transaction chat has no
  // proposal-time sanitizer, so a sibling line's ask must read as not-found.
  transactionId = '',
  amendmentText = '',
  reason = '',
  actorId = 'system'
} = {}) => {
  const cleanRequestId = String(evidenceRequestId || '').trim();
  const cleanAmendment = String(amendmentText || '').trim().slice(0, 600);
  const cleanReason = String(reason || '').trim();
  if (!cleanRequestId) {
    const error = new Error('Evidence request id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_ID_REQUIRED';
    throw error;
  }
  if (!cleanAmendment) {
    const error = new Error('Amendment text is required.');
    error.statusCode = 400;
    error.code = 'AMENDMENT_TEXT_REQUIRED';
    throw error;
  }

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      // FOR UPDATE: an amend racing the owner's reply (or another amend) must
      // serialize on the row — the status guard is only honest under the lock.
      const existing = await client.query(
        `select * from client_evidence_requests
          where firm_id = $1 and id = $2
          for update`,
        [firmId, cleanRequestId]
      );
      const row = existing.rows[0] || null;
      if (!row
        || (clientId && row.client_id !== clientId)
        || (transactionId && String(row.transaction_id || '') !== String(transactionId))) {
        await client.query('rollback');
        const error = new Error('Evidence request was not found.');
        error.statusCode = 404;
        error.code = 'EVIDENCE_REQUEST_NOT_FOUND';
        throw error;
      }
      if (!AMENDABLE_EVIDENCE_REQUEST_STATUSES.includes(row.status)) {
        await client.query('rollback');
        return {
          amended: false,
          evidence_request_id: row.id,
          status: row.status,
          skipped_reason: row.status === 'draft'
            ? 'draft_not_sent'
            : (row.status === 'replied' ? 'already_answered' : `not_amendable_${row.status}`)
        };
      }
      const priorAmendments = Array.isArray(row.request_payload?.amendments)
        ? row.request_payload.amendments
        : [];
      if (priorAmendments.length >= MAX_EVIDENCE_REQUEST_AMENDMENTS) {
        await client.query('rollback');
        return {
          amended: false,
          evidence_request_id: row.id,
          status: row.status,
          amendment_count: priorAmendments.length,
          skipped_reason: 'amendment_limit'
        };
      }

      const nowIso = new Date().toISOString();
      const amendment = {
        at: nowIso,
        by: String(actorId || 'system'),
        text: cleanAmendment,
        reason: cleanReason || null,
        // The question as it read BEFORE this amendment — the immutable
        // record even if a future surface ever rewrites the composite.
        prior_question: row.question || ''
      };
      // The composite the owner sees: original head, amendment marked. Every
      // reader (portal, fan-out, known_asks) reads `question`, so visibility
      // needs no surface changes; the date keeps multiple amendments legible.
      const amendedQuestion = `${row.question || ''}\n\n[Amended ${nowIso.slice(0, 10)}]: ${cleanAmendment}`;
      // The portal envelope precedent (see the cancel writer): if an
      // evidence_request envelope exists it must carry the amended question
      // too, or the owner's portal keeps rendering the stale text.
      const envelope = row.request_payload?.evidence_request
        ? {
            ...(row.request_payload.evidence_request || {}),
            question: amendedQuestion,
            amended_at: new Date(nowIso).getTime()
          }
        : null;
      const updated = await client.query(
        `update client_evidence_requests
            set question = $3,
                request_payload = coalesce(request_payload, '{}'::jsonb) || $4::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2
          returning *`,
        [
          firmId,
          cleanRequestId,
          amendedQuestion,
          JSON.stringify({
            amendments: [...priorAmendments, amendment],
            ...(envelope ? { evidence_request: envelope } : {})
          })
        ]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'firm', $3, 'evidence_request.amended', 'client_evidence_request', $4, $5::jsonb)`,
        [
          firmId,
          row.client_id,
          String(actorId || 'system'),
          row.id,
          JSON.stringify({
            transaction_id: row.transaction_id || null,
            review_item_id: row.review_item_id || null,
            prior_question: row.question || '',
            amendment_text: cleanAmendment,
            reason: cleanReason || null,
            amendment_count: priorAmendments.length + 1
          })
        ]
      );
      await client.query('commit');
      return {
        amended: true,
        evidence_request: rowToClientEvidenceRequestPayload(updated.rows[0]),
        evidence_request_id: row.id,
        transaction_id: row.transaction_id || null,
        status: row.status,
        prior_question: row.question || null,
        question: amendedQuestion,
        amendment_count: priorAmendments.length + 1,
        reason: cleanReason || null
      };
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      throw error;
    }
  });
};

// Re-send ONE already-open owner ask.
//
// NO new writer (INV-1): this routes to deliverEvidenceAsksOnAllChannels —
// "the ONE ask fan-out", which was extracted from the ask-batch send
// precisely so chat verbs could share it, and which ask_client already uses.
// Each channel deliverer bumps send_count (via
// __bumpEvidenceRequestSendCountWithClient, the "108 — the ONLY place
// send_count moves" rail) and bumps it ONLY on a genuinely successful send.
// That makes the delta an honest execution verifier rather than a hopeful
// one: bumped > 0 ⟺ at least one channel actually delivered. A resend where
// every channel is dark/unbound reports delivered: false — never a silent
// "sent".
//
// Routing to the DELIVERER and never to createClientEvidenceRequestInDb is
// what satisfies the spec's dedup requirement STRUCTURALLY: a resend cannot
// mint a second ask on the same anchor, which is exactly the KUILI bug
// askIdentity.js exists to prevent. That is a design invariant, not a
// runtime check.
//
// Replay safety is REAL here, not declared away. A resend is an outbound
// message, so a naive replay sends the owner a second nudge — and the closed
// capability manifest rightly refuses to register a new write verb with an
// idempotency gap. The natural key is (ask id, last successful send): a resend
// whose ask was successfully sent within RESEND_MIN_INTERVAL_MS is REFUSED and
// reported as a skip, so a double-click, a spine replay, or two operators
// chasing the same ask minutes apart cannot double-nag.
//
// Keyed on last_sent_at deliberately, because that column moves ONLY when a
// channel genuinely delivered (the 108 bump rail). A resend whose channels were
// all dark leaves it untouched, so retrying after fixing a binding is NOT
// blocked — only an actual recent message is. The window is short on purpose:
// this is replay protection, not cadence policy (askReaskCadence owns how often
// an unanswered owner is nagged).
//
// The audit is the gap this closes. The fan-out writes the
// message_delivery_ledger, never audit_events, and the only resend-shaped
// audit in the tree is the SYSTEM cadence's 'evidence_request.nudged'. An
// operator-initiated resend was unrecordable; it now emits
// 'evidence_request.resent' with the actor. Written post-fan-out on purpose:
// the fan-out is a network side effect that cannot join a DB transaction, so
// the receipt records what DID leave rather than what was intended.
export const resendClientEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  evidenceRequestId,
  // Same optional anchor scope as the cancel writer, for the same reason: the
  // per-transaction chat must not be able to nudge the owner about a sibling
  // line's question.
  transactionId = '',
  reason = '',
  actorId = 'system',
  deliverImpl = null
} = {}) => {
  const cleanRequestId = String(evidenceRequestId || '').trim();
  const cleanReason = String(reason || '').trim();
  if (!cleanRequestId) {
    const error = new Error('Evidence request id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_ID_REQUIRED';
    throw error;
  }

  return withFirmDbClient(async (client) => {
    const existing = await client.query(
      `select * from client_evidence_requests
        where firm_id = $1 and id = $2
        limit 1`,
      [firmId, cleanRequestId]
    );
    const row = existing.rows[0] || null;
    if (!row
      || (clientId && row.client_id !== clientId)
      || (transactionId && String(row.transaction_id || '') !== String(transactionId))) {
      const error = new Error('Evidence request was not found.');
      error.statusCode = 404;
      error.code = 'EVIDENCE_REQUEST_NOT_FOUND';
      throw error;
    }
    // 'open' only. A 'draft' was never sent, so re-sending it is a SEND, not a
    // resend — that path is the ask-batch send, which mints the first-sent
    // stamps. 'replied'/'resolved'/'cancelled' are closed: nagging an owner who
    // already answered is the honesty failure this guard exists for.
    if (row.status !== 'open') {
      return {
        resent: false,
        evidence_request_id: row.id,
        status: row.status,
        skipped_reason: row.status === 'draft' ? 'never_sent' : `not_open_${row.status}`
      };
    }
    // 122 — resend routes to the OWNER channels; a seat/agent ask has no
    // owner delivery to repeat. Refused here so the fan-out guard is never
    // the only thing standing between an internal question and the owner.
    if ((row.audience || 'client') !== 'client') {
      return {
        resent: false,
        evidence_request_id: row.id,
        status: row.status,
        skipped_reason: 'not_client_audience'
      };
    }
    const lastSentMs = row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;
    if (Number.isFinite(lastSentMs) && lastSentMs > 0
      && (Date.now() - lastSentMs) < RESEND_MIN_INTERVAL_MS) {
      return {
        resent: false,
        evidence_request_id: row.id,
        status: row.status,
        last_sent_at: row.last_sent_at,
        send_count: Number(row.send_count || 0),
        skipped_reason: 'sent_too_recently'
      };
    }

    const priorSendCount = Number(row.send_count || 0);
    const deliver = deliverImpl || deliverEvidenceAsksOnAllChannels;
    const channelFanout = await deliver({
      client, firmId, clientId: row.client_id, evidenceRequestIds: [row.id]
    }).catch((error) => ({ error: error?.message || 'fanout_failed' }));

    const after = await client.query(
      'select send_count, last_sent_at from client_evidence_requests where firm_id = $1 and id = $2 limit 1',
      [firmId, cleanRequestId]
    );
    const nextSendCount = Number(after.rows[0]?.send_count ?? priorSendCount);
    const delivered = nextSendCount > priorSendCount;

    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'firm', $3, 'evidence_request.resent', 'client_evidence_request', $4, $5::jsonb)`,
      [
        firmId,
        row.client_id,
        String(actorId || 'system'),
        row.id,
        JSON.stringify({
          transaction_id: row.transaction_id || null,
          reason: cleanReason || null,
          prior_send_count: priorSendCount,
          send_count: nextSendCount,
          delivered,
          channel_fanout: channelFanout,
          // Whether the re-ask cadence had already given up on this owner. Not
          // a block — the operator may legitimately try again — but the
          // receipt should not pretend the channel is healthy.
          previously_escalated_to_firm: Boolean(row.request_payload?.escalated_to_firm)
        })
      ]
    ).catch(() => null);

    return {
      resent: true,
      delivered,
      evidence_request_id: row.id,
      transaction_id: row.transaction_id || null,
      status: row.status,
      question: row.question || null,
      prior_send_count: priorSendCount,
      send_count: nextSendCount,
      last_sent_at: after.rows[0]?.last_sent_at || null,
      channel_fanout: channelFanout,
      previously_escalated_to_firm: Boolean(row.request_payload?.escalated_to_firm)
    };
  });
};

// The bounded known_asks universe for the ask-lifecycle chat verbs (PR-9).
// Client-scoped for the feed; the caller narrows to one transaction for the
// per-transaction chat. Only LIVE asks are listed — a closed ask is not a
// cancel/resend target, and listing one would invite a dead Apply button.
export const getOpenClientEvidenceRequestsForChatFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId = '',
  limit = 40
} = {}) => {
  if (!clientId) return [];
  const params = [firmId, clientId];
  let where = 'firm_id = $1 and client_id = $2';
  if (transactionId) {
    params.push(String(transactionId));
    where += ` and transaction_id = $${params.length}`;
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 40)));
  const result = await queryOptionalFirmDb(
    `select id, transaction_id, status, evidence_type, question, send_count, last_sent_at, due_at, created_at, audience
       from client_evidence_requests
      where ${where}
        and status in ('draft', 'open')
      order by updated_at desc
      limit $${params.length}`,
    params
  );
  return result.rows || [];
};

export const recordDocumentSignedUrlCreatedInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  document = {},
  actorId = 'system'
} = {}) => {
  if (!document?.id) return null;
  const evidenceRequestId = document.evidence_request_id ||
    document.evidence_context?.request_id ||
    document.payload?.evidence_request_id ||
    document.payload?.evidence_context?.request_id ||
    null;
  const result = await queryOptionalFirmDb(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'document.signed_url.created', 'document', $4, $5::jsonb)
     returning *`,
    [
      firmId,
      document.client_id || null,
      actorId,
      document.id,
      JSON.stringify({
        evidence_request_id: evidenceRequestId,
        filename: document.filename || null,
        storage_provider: document.storage_provider || document.file_storage?.provider || null,
        expires_in: 300
      })
    ]
  );
  return result.rows[0] ? rowToAuditEventPayload(result.rows[0]) : null;
};

export const getClientEvidenceRequestsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  status,
  periodStart,
  periodEnd
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  if (!cleanClientId) {
    const error = new Error('Client id is required.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_REQUEST_CLIENT_REQUIRED';
    throw error;
  }
  const statuses = String(status || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const period = periodStart || periodEnd ? normalizeLedgerPeriod({ periodStart, periodEnd }) : null;
  const params = [firmId, cleanClientId];
  let statusClause = '';
  if (statuses.length) {
    params.push(statuses);
    statusClause = `and status = any($${params.length}::text[])`;
  }
  let periodClause = '';
  if (period) {
    params.push(period.period_start, period.period_end);
    periodClause = `and coalesce(nullif(request_payload->>'date', '')::date, created_at::date) >= $${params.length - 1}::date
                    and coalesce(nullif(request_payload->>'date', '')::date, created_at::date) <= $${params.length}::date`;
  }

  const result = await queryOptionalFirmDb(
    `select *
     from client_evidence_requests
     where firm_id = $1
       and client_id = $2
       ${statusClause}
       ${periodClause}
     order by updated_at desc
     limit 500`,
    params
  );
  const requests = result.rows.map(rowToClientEvidenceRequestPayload);
  if (requests.length) {
    const auditResult = await queryOptionalFirmDb(
      `select *
       from audit_events
       where firm_id = $1
         and (
           resource_type = 'client_evidence_request'
           or metadata ? 'evidence_request_id'
         )
         and (
           resource_id = any($2::text[])
           or metadata->>'evidence_request_id' = any($2::text[])
         )
       order by created_at desc
       limit 1000`,
      [firmId, requests.map((request) => request.id)]
    );
    const auditByRequestId = groupEvidenceAuditEventsByRequestId(auditResult.rows);
    for (const request of requests) {
      request.evidence_audit_events = auditByRequestId.get(request.id) || [];
    }
  }
  return {
    source: 'client_evidence_requests',
    client_id: cleanClientId,
    period_start: period?.period_start || null,
    period_end: period?.period_end || null,
    counts: {
      total: requests.length,
      open: requests.filter((request) => ['draft', 'open', 'replied'].includes(request.status)).length,
      resolved: requests.filter((request) => request.status === 'resolved').length,
      cancelled: requests.filter((request) => request.status === 'cancelled').length
    },
    requests
  };
};

// ── Ask-pipeline batches ──────────────────────────────────────────────
//
// ONE drafted client message per (client, period), drafted by the
// strong model FROM the persisted coding verdicts (askPipeline.js owns
// the call and the no-fallback contract). The draft is the firm-review
// artifact; SEND turns its 'ask' items and statement requests into
// client_evidence_requests rows so replies ride the existing
// resolve/chat loop. Non-terminal source rows may only leave drafting as
// asks; courtesy FYIs are gathered separately from already-applied rows.

const rowToClientAskBatchPayload = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  period_start: row.period_start ? toIsoDay(row.period_start) : null,
  period_end: row.period_end ? toIsoDay(row.period_end) : null,
  status: row.status,
  subject: row.subject,
  message_markdown: row.message_markdown,
  draft: row.payload?.draft || null,
  input_stats: row.payload?.input_stats || null,
  sent: row.payload?.sent || null,
  verdicts_as_of: row.verdicts_as_of ? new Date(row.verdicts_as_of).toISOString() : null,
  model: row.model || null,
  created_by: row.created_by || null,
  sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
  sent_by: row.sent_by || null,
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
});

// Disposition-driven ask canary (RECONCILIATION_DISPOSITION_DRIVEN_ASK (+ _CLIENTS)).
// ASK_BATCH_CANDIDATE_SQL gathers a line as a client-ask candidate ONLY when the strong
// CODER left an 'ai_suggestion' (still 'suggested'). A bare unmatched line the coder
// happened to skip therefore never becomes a client question — even when the bank-line
// DISPOSITION pass already stamped a no_match verdict (chase_evidence / needs_human)
// that says "the owner must clarify / supply evidence". Live case (Honeybee, money-in):
// Shopify $7,028.96 / Check #3852 $3,516.92 / Branch $3,500.03 / SQ GOSQ $2,502.93 /
// Credit Adj $89.14 — each has a COMPLETE no_match disposition verdict and NO coder
// ai_suggestion, so the ask surface rendered nothing and the line HUNG (neither
// auto-reconciled nor on the owner — the forbidden third state). When ON, the candidate
// gather ALSO admits a line carrying a persisted no_match bank-line disposition verdict,
// even with no coder verdict; the draft model then asks FROM the disposition
// (askPipeline.js). The disposition is the COMPLETE, authoritative "ask the owner"
// signal here (it covers every bare line; the coder is the incomplete pass) — rendering
// it is "render the persisted verdict, not the legacy layer" (CLAUDE.md). The candidate
// gather is recall-oriented: the DRAFT MODEL writes the grounded question and evidence
// type, while the runtime pins the already-decided terminal to owner_ask. Off → the candidate
// gate is byte-identical (coder-verdict only). Fail-closed, client-scoped; mirrors
// appliedReviewStateColumnSyncAllows exactly. NEVER widen by deleting the _CLIENTS
// allowlist while the flag is on.
//
// 0A.6b: this env predicate is now the FALLBACK behind the config control plane —
// __draftClientAskBatchWithClient passes `() => dispositionDrivenAskAllows(cleanClientId)`
// as clientFlagActs' envFallback, so a client with no client_capability_config row keeps
// exactly this behaviour. The flag key is shared with the config plane via
// DISPOSITION_DRIVEN_ASK_FLAG_KEY so the env master var and the DB flag_key can never drift
// (mirrors MATERIAL_AUTO_FYI_FLAG_KEY).
export const DISPOSITION_DRIVEN_ASK_FLAG_KEY = 'RECONCILIATION_DISPOSITION_DRIVEN_ASK';
const dispositionDrivenAskAllows = (clientId, env = process.env) => {
  const flag = String(env?.[DISPOSITION_DRIVEN_ASK_FLAG_KEY] ?? '').trim().toLowerCase();
  if (!(flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes')) return false;
  const raw = env?.[`${DISPOSITION_DRIVEN_ASK_FLAG_KEY}_CLIENTS`];
  const allow = raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!allow || !allow.length) return true; // flag on, no allowlist → every client
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// Terminal A (docs/design-coding-skip-class-terminals.md) — the owner-transfer
// decide-and-notify receipt + FYI cursor. Written by the coding auto-post sweep
// when the CODING_OWNER_TRANSFER_POST flag authorises an unattended owner-equity
// posting: `payload.coding_auto_post` records the authority basis (flag stage +
// source, policy, account, posted_at) and `owner_notified:false` is the gather
// key the ask-batch drafter reads (ASK_BATCH_CODING_FYI_SQL below); the single
// send chokepoint flips it true — FYI'd exactly once, mirroring the material
// auto-FYI's owner_notified lifecycle on reconciliation_matches.
export const markCodingAutoPostFyiPendingInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  client = null,
  receipt = {}
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  const cleanTransactionId = String(transactionId || '').trim();
  if (!cleanClientId || !cleanTransactionId) return { marked: false, reason: 'missing_ids' };
  const marker = {
    policy: 'owner_transfer_decide_and_notify',
    owner_notified: false,
    ...receipt
  };
  const query = client ? client.query.bind(client) : queryFirmDb;
  const result = await query(
    `update transactions
        set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{coding_auto_post}', $4::jsonb, true),
            updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3
      returning id`,
    [firmId, cleanClientId, cleanTransactionId, JSON.stringify(marker)]
  );
  return { marked: result.rows.length > 0 };
};

// Owner-transfer postings awaiting their one-time owner FYI (Terminal A's
// analogue of ASK_BATCH_APPLIED_FYI_SQL — same courtesy section, same
// send-chokepoint flip, keyed on the transaction marker instead of a match row).
// The journal, rather than a reconciliation or coding suggestion, owns "posted".
// Carry the actual lines so allocations cannot be flattened to a summary account.
const ASK_POSTED_JOURNAL_JOIN = `join lateral (
  select j.id as journal_id, j.updated_at as journal_updated_at,
    string_agg(distinct l.account_name, ', ' order by l.account_name) as coded_account,
    jsonb_agg(jsonb_build_object('account',l.account_name,'debit',l.debit,
      'credit',l.credit,'tax_type',l.tax_type) order by l.line_no) as journal_lines
  from ledger_journals j join ledger_lines l on l.journal_id=j.id
    and l.firm_id=j.firm_id and l.client_id=j.client_id
  where j.firm_id=t.firm_id and j.client_id=t.client_id
    and j.source_type='transaction' and j.source_id=t.id
    and j.status in ('posted','closed') and j.reversed_at is null
  group by j.id having count(*) >= 2 and sum(l.debit)=sum(l.credit)
) posted on true`;
const ASK_UNPOSTED_TRANSACTION = `not exists (select 1 from ledger_journals j
  where j.firm_id=t.firm_id and j.client_id=t.client_id
    and j.source_type='transaction' and j.source_id=t.id
    and j.status in ('posted','closed') and j.reversed_at is null)`;

const journalReceipt = row => ({ transaction_id: row.transaction_id,
  journal_id: row.journal_id,
  journal_lines: row.journal_lines });
const stalePostedReceipts = async (client, firmId, clientId, receipts = [], lock = false) => {
  if (!receipts.length) return [];
  if (lock) await client.query(`select id from ledger_journals
    where firm_id=$1 and client_id=$2 and id=any($3::text[]) order by id for share`,
    [firmId,clientId,receipts.map(receipt=>receipt.journal_id)]);
  const {rows} = await client.query(`select t.id as transaction_id, posted.*
    from transactions t ${ASK_POSTED_JOURNAL_JOIN}
    where t.firm_id=$1 and t.client_id=$2 and t.id=any($3::text[])`,
    [firmId,clientId,receipts.map(r=>r.transaction_id)]);
  return receipts.filter(receipt => !rows.some(row => isDeepStrictEqual(journalReceipt(row),journalReceipt(receipt))))
    .map(receipt => receipt.transaction_id);
};

const ASK_BATCH_CODING_FYI_SQL = `
  select t.id as transaction_id, t.transaction_date, t.description,
         t.money_in, t.money_out, t.currency,
         posted.coded_account, posted.journal_id, posted.journal_updated_at, posted.journal_lines
  from transactions t
  ${ASK_POSTED_JOURNAL_JOIN}
  where t.firm_id = $1
    and t.client_id = $2
    and coalesce(t.payload->'coding_auto_post'->>'owner_notified', '') = 'false'
    and ($3::date is null or t.transaction_date >= $3::date)
    and ($4::date is null or t.transaction_date <= $4::date)
  order by t.transaction_date nulls last, t.created_at
  limit 40`;

// Candidate gather: lines whose persisted verdict is still 'suggested'
// — the surviving feed rows. The gather decides membership only; once a
// non-terminal row survives these completed/open-ask guards, FIRST requires
// the drafter to render exactly one owner question for it. Decide-and-notify
// FYIs are gathered separately only after their accounting post completed.
const ASK_BATCH_CANDIDATE_SQL = `
  select t.*,
         -- The stale-ask law (reconciliationTwinAging.js): when the only open
         -- ask on the line is a supersedable sweep-minted generic evidence ask,
         -- the line is still gathered, tagged with that ask's identity and the
         -- citable receipt it last named. The assembler re-admits it ONLY when
         -- the citable candidate set has since changed (citableRefreshDue) —
         -- the send's mint then collapses onto the same request row and
         -- refreshes its wording in place.
         (
           select json_build_object(
             'request_id', cer.id,
             'citable_local_evidence', coalesce(cer.request_payload->'citable_local_evidence', '[]'::jsonb)
           )
             from client_evidence_requests cer
            where cer.firm_id = t.firm_id
              and cer.transaction_id = t.id
              and cer.status in ('draft', 'open')
              and cer.created_by = 'coding_auto_post'
              and cer.evidence_type = 'supporting_document'
              and coalesce(cer.audience, 'client') = 'client'
            order by cer.created_at asc
            limit 1
         ) as refreshable_open_ask
  from transactions t
  where t.firm_id = $1
    and t.client_id = $2
    and (
      -- Coded line (the existing gate, unchanged): a coder verdict nobody has
      -- decided on — RT-16: the ONE column is not in the DECIDED set (NULL and
      -- 'asked' stay eligible exactly as the legacy label list left them; the
      -- open-ask guards below are what keep an already-asked line out).
      (
        (t.payload->'ai_suggestion') is not null
        and (t.coding_state is null or t.coding_state not in ('applied', 'held', 'posted', 'synced', 'closed'))
      )
      -- OR (canary $5, fail-closed): a bare line the DISPOSITION pass already flagged
      -- for the owner — a persisted no_match bank-line disposition verdict
      -- (chase_evidence / needs_human) — even with NO coder ai_suggestion. Without this
      -- the ask surface gated on the coder verdict (treating the disposition as
      -- supplementary), so a material payout the coder happened to skip carried a
      -- correct "ask the owner" verdict that was never rendered → the line HUNG, neither
      -- auto-reconciled nor on the owner (the forbidden third state). Off ($5 = false) →
      -- this disjunct is constant-false → byte-identical to the coded-only gate. The
      -- open-ask + settling-match guards below still apply, so a disposition-only line
      -- that already has an ask, or a live match, is excluded exactly like a coded one.
      or (
        $5::boolean
        and exists (
          select 1 from reconciliation_evaluations e
           where e.firm_id = t.firm_id
             and e.client_id = t.client_id
             and e.target_type = '${BANK_LINE_DISPOSITION_TARGET_TYPE}'
             and e.matcher_family = '${BANK_LINE_DISPOSITION_FAMILY}'
             and e.target_id = t.id
             and e.verdict = 'no_match'
        )
      )
    )
    and ($3::date is null or t.transaction_date >= $3::date)
    and ($4::date is null or t.transaction_date <= $4::date)
    -- Spam guard (2026-06-25): don't re-ask a line the client was ALREADY
    -- asked about. Re-including a line whose open evidence request still
    -- stands is what re-sent the same question up to 9 times and fanned out
    -- a duplicate batch per upload — every re-draft put it back in the send,
    -- which re-upserts the open request (+1 send_count). Excluding it here
    -- makes a re-upload with no genuinely-new lines hit 'nothing_to_ask'.
    -- Supersedable carve-out (2026-09-01): a sweep-minted generic evidence ask
    -- does not block — the refreshable_open_ask projection above + the
    -- assembler's citableRefreshDue once-guard decide whether the line is
    -- actually re-fed, so the 9×-re-send loop stays impossible.
    and not ${blockingOpenAskExistsSql({ firmColumn: 't.firm_id', transactionColumn: 't.id' })}
    -- RT-11 (audit F-17): a line Donna already SETTLED — auto-explained by the
    -- disposition pass, explained by a human, reconciled or posted — is never
    -- asked about; a coded-but-explained line used to be gathered on its
    -- still-'suggested' coding alone (the Salik / Zoho asks, round-4 §A4).
    -- Lock-step with the send-time freshness check (settledBankLineSql).
    and not ${settledBankLineSql({ statusColumn: 't.reconciliation_status' })}
    -- Don't ask the client for a document the matcher ALREADY found. A
    -- suggested/auto/confirmed reconciliation match means the evidence is in
    -- the system; the resolution is firm-side (accept / E2 auto-FYI), not
    -- another client message. A REJECTED match is intentionally NOT excluded —
    -- the firm said that document does not settle the line, so it still needs
    -- input. (This is what was asking the client to upload AMEX / land-lease /
    -- Dadant receipts that were already parsed and matched.)
    and not exists (
      select 1 from reconciliation_matches rm
       where rm.bank_transaction_id = t.id
         and rm.status in ('suggested', 'auto_matched', 'confirmed')
    )
  order by t.transaction_date nulls last, t.created_at
  limit 40`;

// Internal-movement lines for the counterpart-statement gap check.
// Recall-oriented filter (transfer-ish account or description); the
// drafting model reads the descriptions and decides which named
// accounts actually lack statement coverage.
const ASK_BATCH_MOVEMENT_SQL = `
  select t.id, t.transaction_date, t.description, t.money_in, t.money_out, t.currency,
         coalesce(t.payload->'ai_suggestion'->>'proposed_account', t.payload->>'account_code', t.account_code, '') as coded_account
  from transactions t
  where t.firm_id = $1
    and t.client_id = $2
    and ${ASK_UNPOSTED_TRANSACTION}
    and (
      -- Terminal B (docs/design-coding-skip-class-terminals.md §2): card /
      -- charge-card settlement classes join the recall filter so a card
      -- payment line (e.g. "AMEX EPAYMENT" coded Credit card payable) reaches
      -- the drafter's counterpart-statement gap check — the account whose
      -- statement the firm is missing. Recall-oriented bulk filtering only;
      -- the drafting model still decides which accounts actually lack
      -- coverage.
      coalesce(t.payload->'ai_suggestion'->>'proposed_account', t.payload->>'account_code', t.account_code, '') ~* '(transfer|intercompany|owner|draw|equity|credit\\s*card|card\\s*payable|charge\\s*card)'
      or t.description ~* '(transfer|xfer|epayment)'
    )
    and ($3::date is null or t.transaction_date >= $3::date)
    and ($4::date is null or t.transaction_date <= $4::date)
    -- Same spam guard as ASK_BATCH_CANDIDATE_SQL, for the statement-coverage
    -- path: a transfer whose counterpart-statement request is already open
    -- must not be re-fed to the drafter, or its bank_statement evidence
    -- request gets re-sent every upload (the send_count 4-7 transfer loop).
    and not exists (
      select 1 from client_evidence_requests cer
       where cer.firm_id = t.firm_id
         and cer.transaction_id = t.id
         and cer.status in ('draft', 'open', 'replied')
    )
  order by t.transaction_date nulls last, t.created_at
  limit 60`;

const ASK_BATCH_COVERAGE_SQL = `
  select d.id, d.filename, d.document_type,
         d.payload->'statement_summary' as statement_summary,
         d.payload->>'period_label' as period_label,
         d.payload->>'statement_currency' as statement_currency,
         d.parse_status
  from documents d
  where d.firm_id = $1
    and d.client_id = $2
    and d.document_type in ('bank_statement', 'payment_account_statement')
  order by d.created_at
  limit 60`;

// E3 — bank lines the firm AUTO-RECONCILED as a confident material match that has
// NOT yet been FYI'd to the owner (the E2 auto-FYI accept: status 'auto_matched',
// payload.authorization.material_auto_fyi.owner_notified = false). These ride the
// next client message as a courtesy "already matched & posted — reply if wrong"
// section, and owner_notified flips to true when that batch is SENT (the single
// send chokepoint), so each auto-post is FYI'd exactly once.
const ASK_BATCH_APPLIED_FYI_SQL = `
  select m.id as match_id,
         m.matched_object_type,
         m.match_amount,
         t.id as transaction_id,
         t.transaction_date,
         t.description,
         t.money_in,
         t.money_out,
         t.currency,
         posted.coded_account, posted.journal_id, posted.journal_updated_at, posted.journal_lines,
         coalesce(d.payload->>'counterparty', d.payload->>'vendor_name', d.payload->>'customer_name', '') as counterparty,
         coalesce(d.payload->>'reference_number', d.payload->>'invoice_number', '') as reference,
         dl.line_no as settlement_row_no,
         dl.description as settlement_row_label,
         dl.amount as settlement_row_net
  from reconciliation_matches m
  join transactions t on t.id = m.bank_transaction_id and t.firm_id = m.firm_id
  ${ASK_POSTED_JOURNAL_JOIN}
  left join documents d on d.id = m.matched_object_id and d.firm_id = m.firm_id
  left join document_lines dl on dl.id = m.matched_line_id and dl.firm_id = m.firm_id
  where m.firm_id = $1
    and m.client_id = $2
    and m.status = 'auto_matched'
    and coalesce(m.payload->'authorization'->'material_auto_fyi'->>'owner_notified', '') = 'false'
    and ($3::date is null or t.transaction_date >= $3::date)
    and ($4::date is null or t.transaction_date <= $4::date)
  order by t.transaction_date nulls last, m.created_at
  limit 40`;

// Doc-first terminal drain (Slice 3) — documents whose LATEST current-policy
// ACT-mode disposition verdict is chase_evidence OR needs_human: the drain
// decided only the OWNER can resolve them, and the batch draft turns that into
// the question. BOTH non-settling doc verdicts feed this lane — a bare
// needs_human doc (business purpose unclear) that never reached the owner is a
// two-terminal-states VIOLATION (hanging firm-side with no pod to clear it);
// the ask model asks its business purpose, exactly as the bank-line needs_human
// lane already does. auto_explain is the ONLY settling verdict and never joins.
// Shadow discipline (reader #4, after the two gap guards and the wake
// evaluator): the lateral projects ACT rows ONLY, so a shadow verdict can
// never feed an owner ask — and the whole gather is additionally gated on
// clientFlagActs in the draft assembler (fail-closed, kill-switch honoured).
// Guards mirror the sweep population: no doc already settled by the act-mode
// payload merge, no open doc-anchored ask (spam guard — same shape as the
// candidate SQL's), no live match outranking the verdict (INV-4).
const ASK_BATCH_DOC_CANDIDATE_SQL = `
  select d.id, d.document_type, d.vendor_name, d.customer_name, d.filename,
         d.total_amount, d.currency, d.document_date,
         latest.payload as disposition_payload
  from documents d
  join lateral (
    select ev.payload
      from reconciliation_evaluations ev
     where ev.firm_id = d.firm_id
       and ev.client_id = d.client_id
       and ev.target_type = '${DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE}'
       and ev.matcher_family = '${DOCUMENT_NO_LINE_DISPOSITION_FAMILY}'
       and ev.target_id = d.id
       and ev.payload->>'policy_version' = '${DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION}'
       and ev.payload->>'matcher_mode' = 'act'
     order by ev.evaluated_at desc
     limit 1
  ) latest on latest.payload->>'disposition' in ('chase_evidence', 'needs_human')
  where d.firm_id = $1
    and d.client_id = $2
    and ($3::date is null or d.document_date is null or d.document_date >= $3::date)
    and ($4::date is null or d.document_date is null or d.document_date <= $4::date)
    and coalesce(d.payload->'no_line_disposition'->>'disposition', '') <> 'auto_explain'
    and not exists (
      select 1 from client_evidence_requests cer
       where cer.firm_id = d.firm_id
         and cer.client_id = d.client_id
         and cer.request_payload->>'document_id' = d.id
         and cer.status in ('draft', 'open', 'replied')
    )
    and not exists (
      select 1 from reconciliation_matches rm
       where rm.firm_id = d.firm_id
         and rm.client_id = d.client_id
         and rm.matched_object_id = d.id
         and rm.matched_object_type <> 'bank_line'
         and rm.status in ('suggested', 'auto_matched', 'confirmed')
    )
  order by d.document_date nulls last, d.created_at
  limit 40`;

// Doc-first terminal drain (Slice 3) — auto-explained documents awaiting
// their one-time owner FYI (the decide-and-notify half). Keyed PURELY on the
// owner_notified:false marker the act-mode payload merge seeds
// (documentDispositionLlm.stampDocumentDisposition), so it is self-gating:
// no act ever ran ⇒ no marker ⇒ empty — same pattern as the coding-FYI
// gather above. Flipped true at the single send chokepoint.
const ASK_BATCH_DOC_EXPLAINED_FYI_SQL = `
  select d.id as document_id, d.document_type, d.vendor_name, d.customer_name,
         d.filename, d.total_amount, d.currency, d.document_date,
         d.payload->'no_line_disposition' as no_line_disposition
  from documents d
  where d.firm_id = $1
    and d.client_id = $2
    and d.payload->'no_line_disposition'->>'disposition' = 'auto_explain'
    and exists (select 1 from ledger_journals j where j.firm_id=d.firm_id and j.client_id=d.client_id
      and j.source_type='document_settlement' and j.source_id=d.id
      and j.status in ('posted','closed') and j.reversed_at is null)
    and coalesce(d.payload->'no_line_disposition'->>'owner_notified', '') = 'false'
    and ($3::date is null or d.document_date is null or d.document_date >= $3::date)
    and ($4::date is null or d.document_date is null or d.document_date <= $4::date)
  order by d.document_date nulls last, d.created_at
  limit 40`;

// Slice 4b — documents whose settlement LEDGER ENTRY was posted (the named
// writer merged payload.settlement_entry) awaiting their one-time "recorded
// as paid from your own funds" FYI. Keyed PURELY on the writer's
// owner_notified:false marker (self-gating: no post ever ran ⇒ no marker ⇒
// empty), flipped true at the single send chokepoint — the exact
// explained-FYI pattern above, one lane stronger ("recorded" is TRUE here:
// these ARE posted). The writer also flipped the doc's weaker explained-FYI
// marker true, so one doc never renders two digest lines.
const ASK_BATCH_SETTLEMENT_FYI_SQL = `
  select d.id as document_id, d.document_type, d.vendor_name, d.customer_name,
         d.filename, d.total_amount, d.currency, d.document_date,
         d.payload->'settlement_entry' as settlement_entry
  from documents d
  where d.firm_id = $1
    and d.client_id = $2
    and exists (select 1 from ledger_journals j where j.firm_id=d.firm_id and j.client_id=d.client_id
      and j.id=d.payload->'settlement_entry'->>'journal_id' and j.source_type='document_settlement'
      and j.source_id=d.id and j.status in ('posted','closed') and j.reversed_at is null)
    and coalesce(d.payload->'settlement_entry'->>'owner_notified', '') = 'false'
    and ($3::date is null or d.document_date is null or d.document_date >= $3::date)
    and ($4::date is null or d.document_date is null or d.document_date <= $4::date)
  order by d.document_date nulls last, d.created_at
  limit 40`;

// Late-bank-line reversal guard — documents whose owner-funds settlement
// entry was REVERSED because a bank line later confirmed against them
// (documentSettlementReversal.js merged payload.settlement_entry.reversal),
// awaiting their one-time "also appeared on your statement, so we corrected
// it" FYI. Keyed PURELY on the producer's owner_notified:false marker
// (self-gating: no reversal ever posted ⇒ no marker ⇒ empty), flipped true
// at the single send chokepoint — the settlement-FYI pattern one lane
// further. The bank line rides along so the drafter can name the statement
// line the receipt turned out to match.
const ASK_BATCH_SETTLEMENT_REVERSAL_FYI_SQL = `
  select d.id as document_id, d.document_type, d.vendor_name, d.customer_name,
         d.filename, d.total_amount, d.currency, d.document_date,
         d.payload->'settlement_entry' as settlement_entry,
         t.transaction_date as bank_line_date, t.description as bank_line_description
  from documents d
  left join transactions t
    on t.firm_id = d.firm_id
   and t.id = d.payload->'settlement_entry'->'reversal'->>'bank_transaction_id'
  where d.firm_id = $1
    and d.client_id = $2
    and coalesce(d.payload->'settlement_entry'->'reversal'->>'journal_id', '') <> ''
    and coalesce(d.payload->'settlement_entry'->'reversal'->>'owner_notified', '') = 'false'
    and ($3::date is null or d.document_date is null or d.document_date >= $3::date)
    and ($4::date is null or d.document_date is null or d.document_date <= $4::date)
  order by d.document_date nulls last, d.created_at
  limit 40`;

export const __draftClientAskBatchWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart = null,
  periodEnd = null,
  actorId = 'system',
  draftFn = draftClientAskMessage
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  if (!cleanClientId) {
    const error = new Error('Client id is required.');
    error.statusCode = 400;
    error.code = 'ASK_BATCH_CLIENT_REQUIRED';
    throw error;
  }

  const clientResult = await client.query('select * from clients where firm_id = $1 and id = $2', [firmId, cleanClientId]);
  if (!clientResult.rows[0]) {
    const error = new Error('Client was not found.');
    error.statusCode = 404;
    error.code = 'ASK_BATCH_CLIENT_NOT_FOUND';
    throw error;
  }
  const clientProfile = {
    ...(clientResult.rows[0].profile || {}),
    id: clientResult.rows[0].id,
    companyName: clientResult.rows[0].profile?.companyName || clientResult.rows[0].company_name,
    jurisdiction: clientResult.rows[0].profile?.jurisdiction || clientResult.rows[0].jurisdiction || ''
  };

  const cleanPeriodStart = periodStart ? toIsoDay(periodStart) : null;
  const cleanPeriodEnd = periodEnd ? toIsoDay(periodEnd) : null;
  // 0A.6b — config control plane shim. Resolve the per-client config snapshot once for
  // this draft run; a DB row for this client ⇒ its stage decides the disposition-driven-ask
  // gate (empty=∅, fail-closed), no row ⇒ the env canary (envFallback), byte-identical to
  // pre-0A.6b. The resolved boolean is the $5 candidate-gather param (admits a bare line
  // carrying a no_match disposition verdict even with no coder verdict).
  const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId: cleanClientId });
  const dispositionAskActs = clientFlagActs({
    flagKey: DISPOSITION_DRIVEN_ASK_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => dispositionDrivenAskAllows(cleanClientId)
  });
  const candidateResult = await client.query(
    ASK_BATCH_CANDIDATE_SQL,
    [firmId, cleanClientId, cleanPeriodStart, cleanPeriodEnd, dispositionAskActs]
  );
  let codingItems = candidateResult.rows.map((row) => {
    const item = rowToTransactionPayload(row);
    // The stale-ask law's tag (see ASK_BATCH_CANDIDATE_SQL): present only when
    // the line's sole open ask is a supersedable sweep-minted generic one.
    if (row.refreshable_open_ask && typeof row.refreshable_open_ask === 'object') {
      item.refreshable_open_ask = row.refreshable_open_ask;
    }
    return item;
  });

  // An uploaded artifact is present evidence even before the parser/router or
  // formal matcher has converged. Inventory the client's local documents at
  // the same boundary that gathers ordinary asks, then carry the exact
  // candidates through generation and the send-time freshness receipt. This
  // is deliberately a hold/wording guard, not an accounting match writer.
  const localEvidenceCandidates = await loadLocalEvidenceCandidatesWithClient({
    client,
    firmId,
    clientId: cleanClientId,
    // Draft and freshness must inventory the SAME persisted transaction
    // shape. rowToTransactionPayload is a presentation row and intentionally
    // omits some source columns (for example structured_reference); passing it
    // here made a stable candidate appear only when freshness reloaded the DB,
    // so every draft self-invalidated as stale.
    transactionIds: codingItems.map((item) => item.id).filter(Boolean)
  });
  for (const item of codingItems) {
    item.local_evidence_candidates = localEvidenceCandidates.get(String(item.id)) || [];
  }

  // The stale-ask law's once-guard: a line carrying a supersedable open ask is
  // re-fed to the drafter ONLY when its citable candidate set changed since
  // that ask last named it (citableRefreshDue). Everything else drops here —
  // net behaviour identical to the old spam guard, so a re-upload with no
  // genuinely-new evidence still reaches 'nothing_to_ask' and the owner is
  // never re-prompted with an unchanged question. A refreshed line's send-time
  // mint collapses onto the SAME request row (wording refreshed in place, the
  // row never closed — the line always keeps its open ask) and re-stamps
  // citable_local_evidence, which is what makes this exactly-once.
  codingItems = codingItems.filter((item) => {
    if (!item.refreshable_open_ask) return true;
    return citableRefreshDue({
      persisted: item.refreshable_open_ask.citable_local_evidence,
      candidates: item.local_evidence_candidates
    });
  });

  // Path Y (supplementary context) — attach each coding line's bank-line
  // disposition verdict (the reconciliation pass's read of the line when the
  // document matchers found no match). The drafting model treats a
  // 'chase_evidence' disposition as corroborating signal to ask for the
  // missing payout report / invoice; it is never the gate (the coding verdict
  // still governs). Best-effort: a missing/failed read simply omits the signal.
  if (codingItems.length) {
    const codingIds = codingItems.map((item) => item.id).filter(Boolean);
    if (codingIds.length) {
      const dispoResult = await client.query(
        `select target_id, target_type, matcher_family, verdict, unmatchable_reason, payload, model
           from reconciliation_evaluations
          where firm_id = $1 and client_id = $2
            and target_type = $3
            and matcher_family = $4
            and target_id = any($5::text[])`,
        [firmId, cleanClientId, BANK_LINE_DISPOSITION_TARGET_TYPE, BANK_LINE_DISPOSITION_FAMILY, codingIds]
      );
      const dispositionByTx = summarizeBankLineDispositions(dispoResult.rows || []);
      for (const item of codingItems) {
        const disposition = dispositionByTx.get(item.id);
        if (disposition) item.bank_line_disposition = disposition;
      }
    }
  }

  const movementResult = await client.query(ASK_BATCH_MOVEMENT_SQL, [firmId, cleanClientId, cleanPeriodStart, cleanPeriodEnd]);
  const internalMovementLines = movementResult.rows.map((row) => ({
    id: row.id,
    date: row.transaction_date ? toIsoDay(row.transaction_date) : null,
    description: row.description || '',
    money_in: Number(row.money_in || 0),
    money_out: Number(row.money_out || 0),
    currency: row.currency || '',
    coded_account: row.coded_account || ''
  }));

  // E3 — auto-reconciled material matches awaiting their one-time owner FYI.
  const appliedFyiResult = await client.query(ASK_BATCH_APPLIED_FYI_SQL, [firmId, cleanClientId, cleanPeriodStart, cleanPeriodEnd]);
  const appliedFyiLines = appliedFyiResult.rows.map((row) => ({
    match_id: row.match_id,
    transaction_id: row.transaction_id,
    date: row.transaction_date ? toIsoDay(row.transaction_date) : null,
    description: row.description || '',
    money_in: Number(row.money_in || 0),
    money_out: Number(row.money_out || 0),
    currency: row.currency || '',
    coded_account: row.coded_account || '',
    journal_id: row.journal_id, journal_updated_at: row.journal_updated_at, journal_lines: row.journal_lines,
    matched_document_type: row.matched_object_type || '',
    counterparty: row.counterparty || '',
    reference: row.reference || '',
    // RT-21e: a koontilasku row auto-reconciled under the material FYI path
    // (migration 150 matched_line_id) is FYI'd as THAT row — its label and
    // net — never as the whole statement.
    settlement_row: row.settlement_row_no != null
      ? { line_no: Number(row.settlement_row_no), label: row.settlement_row_label || '', net: row.settlement_row_net == null ? null : Number(row.settlement_row_net) }
      : null
  }));
  const postedFyiMatchIds = appliedFyiLines.map((line) => line.match_id).filter(Boolean);

  // Terminal A — owner-transfer postings awaiting their one-time FYI. Rendered
  // in the SAME "already posted" courtesy section as material-match FYIs (the
  // drafter's posted_matches input); flipped owner_notified=true by the same
  // send chokepoint, keyed on transaction ids instead of match ids.
  const codingFyiResult = await client.query(ASK_BATCH_CODING_FYI_SQL, [firmId, cleanClientId, cleanPeriodStart, cleanPeriodEnd]);
  const codingFyiLines = codingFyiResult.rows.map((row) => ({
    match_id: null,
    transaction_id: row.transaction_id,
    date: row.transaction_date ? toIsoDay(row.transaction_date) : null,
    description: row.description || '',
    money_in: Number(row.money_in || 0),
    money_out: Number(row.money_out || 0),
    currency: row.currency || '',
    coded_account: row.coded_account || '',
    journal_id: row.journal_id, journal_updated_at: row.journal_updated_at, journal_lines: row.journal_lines,
    matched_document_type: 'owner transfer (posted directly)',
    counterparty: '',
    reference: ''
  }));
  const postedFyiTransactionIds = codingFyiLines.map((line) => line.transaction_id).filter(Boolean);
  const postedJournalReceipts = [...appliedFyiLines, ...codingFyiLines].filter(row=>row.journal_id).map(journalReceipt);

  // Doc-first terminal drain (Slice 3, docs/donna-doc-first-terminal-drain-plan.md)
  // — the two DOCUMENT lanes. Lane 1 (asks): chase_evidence + needs_human docs
  // join THIS per-client batch (both are non-settling owner-clarify verdicts;
  // needs_human without an owner ask is the hanging violation this closes)
  // (Kari's §8 call: one message listing all unresolved docs,
  // never one ping per receipt), gated on the SAME plane flag the drain acts
  // under (fail-closed; ∅/off/shadow ⇒ no gather, byte-identical draft).
  const docDispositionAsksAct = clientFlagActs({
    flagKey: DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => false // born on the plane — a DB stage row is the ONLY on
  });
  let documentItems = [];
  if (docDispositionAsksAct) {
    const docCandidateResult = await client.query(
      ASK_BATCH_DOC_CANDIDATE_SQL,
      [firmId, cleanClientId, cleanPeriodStart, cleanPeriodEnd]
    );
    documentItems = docCandidateResult.rows.map((row) => ({
      id: row.id,
      document_type: row.document_type || '',
      counterparty: row.vendor_name || row.customer_name || '',
      filename: row.filename || '',
      amount: Number(row.total_amount || 0),
      currency: row.currency || '',
      date: row.document_date ? toIsoDay(row.document_date) : null,
      disposition: row.disposition_payload || null
    }));
  }
  // Lane 2 (FYIs): auto-explained docs awaiting their one-time courtesy FYI.
  // Marker-gated (owner_notified:false only exists once an act ran), NOT
  // flag-gated: an already-settled doc still gets its decide-and-notify even
  // if the flag is later staged down — the settle stands until reversed.
  const explainedDocFyiResult = await client.query(
    ASK_BATCH_DOC_EXPLAINED_FYI_SQL,
    [firmId, cleanClientId, cleanPeriodStart, cleanPeriodEnd]
  );
  const explainedDocLines = explainedDocFyiResult.rows.map((row) => ({
    document_id: row.document_id,
    document_type: row.document_type || '',
    counterparty: row.vendor_name || row.customer_name || '',
    filename: row.filename || '',
    amount: Number(row.total_amount || 0),
    currency: row.currency || '',
    date: row.document_date ? toIsoDay(row.document_date) : null,
    expense_kind: row.no_line_disposition?.expense_kind || '',
    settlement_channel: row.no_line_disposition?.settlement_channel || ''
  }));
  const explainedFyiDocumentIds = explainedDocLines.map((line) => line.document_id).filter(Boolean);

  // Slice 4b — settlement entries posted under delegated authority awaiting
  // their one-time "recorded" FYI. Marker-gated like the explained lane (the
  // marker only exists once the named writer posted), NOT flag-gated: a
  // posted entry gets its decide-and-notify even if the flag is later staged
  // down — the post stands until reversed.
  const settlementFyiResult = await client.query(
    ASK_BATCH_SETTLEMENT_FYI_SQL,
    [firmId, cleanClientId, cleanPeriodStart, cleanPeriodEnd]
  );
  const recordedSettlementLines = settlementFyiResult.rows.map((row) => ({
    document_id: row.document_id,
    document_type: row.document_type || '',
    counterparty: row.vendor_name || row.customer_name || '',
    filename: row.filename || '',
    amount: Number(row.total_amount || 0),
    currency: row.currency || '',
    date: row.document_date ? toIsoDay(row.document_date) : null,
    expense_account: row.settlement_entry?.expense_account || '',
    settlement_channel: row.settlement_entry?.settlement_channel || ''
  }));
  const settlementFyiDocumentIds = recordedSettlementLines.map((line) => line.document_id).filter(Boolean);

  // Late-bank-line reversal guard — reversed settlement entries awaiting
  // their one-time correction FYI (marker-gated like the settlement lane,
  // NOT flag-gated: a posted reversal gets its decide-and-notify even if
  // the flag is later staged down).
  const settlementReversalFyiResult = await client.query(
    ASK_BATCH_SETTLEMENT_REVERSAL_FYI_SQL,
    [firmId, cleanClientId, cleanPeriodStart, cleanPeriodEnd]
  );
  const reversedSettlementLines = settlementReversalFyiResult.rows.map((row) => ({
    document_id: row.document_id,
    document_type: row.document_type || '',
    counterparty: row.vendor_name || row.customer_name || '',
    filename: row.filename || '',
    amount: Number(row.total_amount || 0),
    currency: row.currency || '',
    date: row.document_date ? toIsoDay(row.document_date) : null,
    expense_account: row.settlement_entry?.expense_account || '',
    settlement_channel: row.settlement_entry?.settlement_channel || '',
    bank_line_date: row.bank_line_date ? toIsoDay(row.bank_line_date) : null,
    bank_line_description: row.bank_line_description || ''
  }));
  const settlementReversalFyiDocumentIds = reversedSettlementLines.map((line) => line.document_id).filter(Boolean);

  // Twin-aging lane (design 2026-07-06 §1, Kari's 3-day clock): matcher-flagged
  // ambiguous twins resting at 'suggested' past the aging window convert to an
  // OWNER ask — the drafter receives each aged group (candidates + the
  // matcher's persisted tie reasoning) and writes the "which of these pays
  // this line?" question as an ordinary 'ask' item; the send chokepoint mints
  // the evidence request and stamps the twin_aged_to_ask receipt off
  // twin_ask_groups below. Plane-gated, fail-closed (born on the plane — a DB
  // stage row is the ONLY on); at shadow the would-mint is receipted and the
  // draft is byte-identical.
  const twinAgingActs = clientFlagActs({
    flagKey: TWIN_AGING_ASK_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => false
  });
  const twinAgingObserves = clientFlagObserves({
    flagKey: TWIN_AGING_ASK_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => false
  });
  let agedTwinAsks = [];
  if (twinAgingActs || twinAgingObserves) {
    const gathered = await gatherAgedTwinAskGroups(client, { firmId, clientId: cleanClientId });
    if (twinAgingActs) {
      agedTwinAsks = gathered.groups;
    } else if (gathered.groups.length) {
      await auditTwinAgingWouldAsk(client, {
        firmId, clientId: cleanClientId, groups: gathered.groups, source: 'ask_draft_gather'
      });
    }
  }

  // Material-hold → owner-confirm lane (2026-08-25, the land-lease rule): a
  // 'suggested' match held ONLY by materiality/authority — high confidence,
  // single unambiguous candidate, above the auto-reconcile ceiling with no
  // acting authority — is the textbook owner ask ("we matched X to Y —
  // confirm?"). Deliberately NOT plane-gated, unlike the twin lane: staging
  // (RECONCILIATION_MATERIAL_AUTO_FYI / grants) decides whether the match
  // auto-reconciles; it must never decide whether the ask EXISTS. Gating
  // this on staging is exactly the third-state hole that kept re-opening
  // every client reset (two-terminal-states, the first principle).
  const heldMaterialGathered = await gatherHeldMaterialAskGroups(client, {
    firmId, clientId: cleanClientId
  });
  const heldMatchConfirms = heldMaterialGathered.groups;

  // Retraction auto-send — RECONCILE_RETRACTION_AUTOSEND on the plane (the former
  // RECONCILE_RETRACTION_AUTOSEND_ENABLED env pair, converted RT-11: envFallback
  // false, seeded auto on desktop; env can only KILL it): when a line we ALREADY
  // ASKED the client about later auto-matches, fix #3 silently resolves the open
  // evidence request (response_payload.auto_resolved_by_match=true); when Donna's
  // own auto_explain settles the line, the D4 law retracts the ask
  // (response_payload.retracted=true). The question chased the client
  // autonomously; this is the autonomous all-clear. Surface those resolved-but-
  // not-yet-told requests so the message can say "you can ignore what we asked —
  // we've handled it" and an otherwise FYI-only draft becomes sendable
  // (askAutoSendProducer). Flag off ⇒ no query, behaviour byte-identical.
  const retractionAutoSendEnabled = clientFlagActs({
    flagKey: RETRACTION_AUTOSEND_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => false
  });
  // D4 re-evaluation at draft time (reconciliationTwinAging.js, plane-gated on
  // RECONCILE_AUTO_EXPLAIN_RETRACTS, receipted, idempotent): an open
  // purpose/document ask on a line the disposition pass has since auto-explained
  // is retracted HERE so this very draft carries the all-clear — the hourly sweep
  // and the loop drain run the same law right after they stamp a verdict.
  await retractAsksSettledByAutoExplain(client, { firmId, clientId: cleanClientId, configSnapshot });
  let retractedRequests = [];
  if (retractionAutoSendEnabled) {
    const retractedResult = await client.query(
      `select cer.id as request_id, cer.transaction_id,
              coalesce(cer.response_payload->>'retracted', '') = 'true' as retracted_by_auto_explain,
              t.transaction_date, t.description, t.money_in, t.money_out, t.currency
         from client_evidence_requests cer
         join transactions t on t.id = cer.transaction_id and t.firm_id = cer.firm_id
        where cer.firm_id = $1 and cer.client_id = $2
          and cer.status = 'resolved'
          and cer.audience = 'client'
          and (
            coalesce(cer.response_payload->>'auto_resolved_by_match', '') = 'true'
            or coalesce(cer.response_payload->>'retracted', '') = 'true'
          )
          and coalesce(cer.response_payload->>'retraction_notified', '') <> 'true'
        order by t.transaction_date nulls last, cer.id
        limit 40`,
      [firmId, cleanClientId]
    );
    retractedRequests = retractedResult.rows.map((row) => ({
      request_id: row.request_id,
      transaction_id: row.transaction_id,
      // Why the owner can ignore it: a document arrived and matched, or Donna
      // settled the line herself (immaterial, clearly business). Rendered as two
      // honest sentences below and persisted on retracted_items.
      reason: row.retracted_by_auto_explain ? 'auto_explained' : 'matched',
      date: row.transaction_date ? toIsoDay(row.transaction_date) : null,
      description: row.description || '',
      amount: Number(row.money_out || 0) || Number(row.money_in || 0) || 0,
      currency: row.currency || ''
    }));
  }
  // A line the client was ASKED about renders in the retraction section, not the courtesy
  // "already matched & posted" FYI — one mention only. owner_notified still flips for ALL
  // matched material lines (postedFyiMatchIds unchanged) so none re-gathers next draft.
  const retractedTxIds = new Set(retractedRequests.map((r) => r.transaction_id));
  const allFyiLines = appliedFyiLines.concat(codingFyiLines);
  const drafterFyiLines = retractionAutoSendEnabled
    ? allFyiLines.filter((line) => !retractedTxIds.has(line.transaction_id))
    : allFyiLines;

  if (!codingItems.length && !internalMovementLines.length && !allFyiLines.length
      && !retractedRequests.length && !documentItems.length && !explainedDocLines.length
      && !recordedSettlementLines.length && !reversedSettlementLines.length && !agedTwinAsks.length
      && !heldMatchConfirms.length) {
    return {
      batch: null,
      reason: 'nothing_to_ask',
      counts: { coding_items: 0, internal_movement_lines: 0, posted_matches: 0 }
    };
  }

  const coverageResult = await client.query(ASK_BATCH_COVERAGE_SQL, [firmId, cleanClientId]);
  const statementCoverage = coverageResult.rows.map((row) => ({
    document_type: row.document_type,
    filename: row.filename,
    statement_summary: row.statement_summary || null,
    period_label: row.period_label || '',
    statement_currency: row.statement_currency || '',
    parse_status: row.parse_status || ''
  }));
  const openRequestsResult = await client.query(
    `select id, transaction_id, review_item_id, status, evidence_type, question, created_by, audience,
            last_sent_at as sent_at, first_sent_at, send_count
     from client_evidence_requests
     where firm_id = $1 and client_id = $2 and status in ('draft', 'open', 'replied')
       and audience = 'client'
     order by created_at
     limit 80`,
    [firmId, cleanClientId]
  );
  // Lines being (re)drafted this run may carry a supersedable open ask (the
  // stale-ask law) that this draft's send will REPLACE through the mint's
  // collapse. The drafter is told "do not re-ask anything in
  // open_evidence_requests" and FIRST requires one ask per gathered line, so
  // handing it the superseded question would force a contradiction — filter
  // exactly those requests out of its input. Every other open request still
  // reaches the model unchanged.
  const draftedTransactionIds = new Set([
    ...codingItems.map((item) => String(item.id || '')),
    ...agedTwinAsks.map((group) => String(group.transaction_id || '')),
    ...heldMatchConfirms.map((group) => String(group.transaction_id || ''))
  ].filter(Boolean));
  const openRequestsForDrafter = openRequestsResult.rows.filter((row) =>
    !(isSupersedableAskRow(row) && draftedTransactionIds.has(String(row.transaction_id || ''))));

  // Staleness anchor: the newest signal the draft is based on. A
  // matcher sweep or coding run newer than this means re-draft, don't
  // send.
  const evalResult = await client.query(
    `select max(evaluated_at) as last_evaluated_at,
       (select jsonb_agg(jsonb_build_object(
         'suggested_at', t.payload->'ai_suggestion'->'suggested_at',
         'applied_at', t.payload->'ai_suggestion_applied_at'))
        from transactions t where t.firm_id=$1 and t.client_id=$2) as coding_movements
     from reconciliation_evaluations where firm_id = $1 and client_id = $2`,
    [firmId, cleanClientId]
  );
  const lastEvaluatedAtMs = evalResult.rows[0]?.last_evaluated_at
    ? new Date(evalResult.rows[0].last_evaluated_at).getTime()
    : 0;
  const lastSuggestedAtMs = Math.max(
    0,
    ...codingItems.map((item) => Number(item.ai_suggestion?.suggested_at || 0)),
    // The view compares every transaction's suggestion AND applied stamp.
    // Completed and already-asked rows are absent from codingItems; omitting
    // them made every replacement draft permanently stale and spent again.
    ...(evalResult.rows[0]?.coding_movements || []).flatMap(row => [row.suggested_at,row.applied_at])
      .map(value => Number(value) || Date.parse(value) || 0)
  );
  const verdictsAsOf = new Date(Math.max(lastEvaluatedAtMs, lastSuggestedAtMs) || Date.now()).toISOString();

  const { draft, model, response_id: responseId, language: draftLanguage } = await draftFn({
    clientProfile,
    codingItems,
    internalMovementLines,
    statementCoverage,
    openEvidenceRequests: openRequestsForDrafter,
    appliedFyiLines: drafterFyiLines,
    documentItems,
    explainedDocuments: explainedDocLines,
    recordedSettlements: recordedSettlementLines,
    settlementReversals: reversedSettlementLines,
    agedTwinAsks,
    heldMatchConfirms,
    periodStart: cleanPeriodStart,
    periodEnd: cleanPeriodEnd
  });

  // The provider path already runs this assertion inside askPipeline's
  // sanitizer. Run it again at the trusted DB boundary so injected/test
  // drafters and any future alternate provider cannot bypass FIRST: every
  // gathered unresolved row must become exactly one owner ask.
  const terminalAskAnchorIds = assertAskDraftTerminalCoverage(draft, {
    codingItems,
    documentItems,
    agedTwinAsks,
    heldMatchConfirms,
    rejectUnknown: true
  });
  assertAskDraftLocalEvidenceIntegrity(draft, {
    codingItems,
    rejectUnknown: true
  });

  // Generation-time freshness: the strong-model call runs outside a
  // transaction by design, so reconciliation may legitimately advance while
  // it is thinking. Re-read the exact ask anchors the model chose before
  // persisting any draft. A stale result is a retryable model run, never a
  // client-visible artifact (the auto-draft outbox backs it off and retries).
  const freshnessAnchorIds = directAskAnchorIds(draft, {
    agedTwinAsks,
    heldMatchConfirms,
    codingItems
  });
  const staleAnchors = await __findStaleAskDraftAnchors({
    client,
    firmId,
    clientId: cleanClientId,
    draft,
    freshnessAnchorIds
  });
  const stalePosted = await stalePostedReceipts(client,firmId,cleanClientId,postedJournalReceipts);
  if (stalePosted.length) { staleAnchors.stale = true; staleAnchors.stale_posted_transaction_ids = stalePosted; }
  if (staleAnchors.stale) {
    throw staleAskBatchError({ staleAnchors, phase: 'draft' });
  }

  // Deterministic retraction section (option a — no change to the strong-LLM prompt). The
  // matcher / the disposition pass already made the judgement; this only RELAYS which
  // previously-asked items are now handled, so it is system-correctness scaffolding,
  // not intelligence-substituting. Two honest sentences: "matched and posted" for
  // resolve-on-match, "settled ourselves" for an auto_explain retraction (D4).
  if (retractedRequests.length) {
    const renderLine = (r) => {
      const amount = r.amount ? `${r.currency ? `${r.currency} ` : ''}${r.amount.toFixed(2)}` : '';
      const parts = [r.date, amount, r.description].filter(Boolean);
      return `- ${parts.join(' — ')}`;
    };
    const matched = retractedRequests.filter((r) => r.reason !== 'auto_explained');
    const explained = retractedRequests.filter((r) => r.reason === 'auto_explained');
    const section = ['', '**Already handled — you can ignore these**'];
    if (matched.length) {
      section.push(
        "We've since found the supporting material for the following, so there's no need to send that material again:",
        ...matched.map(renderLine)
      );
    }
    if (explained.length) {
      section.push(
        "We've since settled the following ourselves — small, recurring and clearly business, so no receipt or explanation is needed:",
        ...explained.map(renderLine)
      );
    }
    draft.message_markdown = `${draft.message_markdown || ''}${section.join('\n')}\n`;
    draft.retracted_items = retractedRequests.map((r) => ({
      request_id: r.request_id,
      transaction_id: r.transaction_id,
      reason: r.reason,
      date: r.date,
      description: r.description
    }));
  }

  const batchId = `ask-batch-${cleanClientId}-${shortHash(`${cleanClientId}:${Date.now()}:${cleanPeriodStart || ''}:${cleanPeriodEnd || ''}`)}`;
  const batchPayload = {
    draft,
    response_id: responseId || '',
    // Drafting receipt beside the model id (the column) and response_id: the
    // owner language the drafter was instructed to write in. null when an
    // injected drafter does not report one.
    language: draftLanguage || null,
    // Exact direct-ask anchors generation-time validation approved. The send
    // writer rechecks only batches minted by this freshness-aware code; older
    // persisted drafts remain readable and follow their historical contract.
    freshness_anchor_ids: freshnessAnchorIds,
    posted_journal_receipts: postedJournalReceipts,
    // Generation receipt for the terminal-coverage assertion. Send rechecks
    // these exact model-visible unresolved anchors under the batch row lock;
    // no persisted skip/notify draft can cross the delivery chokepoint.
    terminal_ask_anchor_ids: terminalAskAnchorIds,
    // E3 — the auto-FYI match rows summarised in this draft's "already matched &
    // posted" section. The single send chokepoint flips owner_notified true for
    // exactly these when the batch is sent (FYI'd once, never re-gathered).
    posted_fyi_match_ids: postedFyiMatchIds,
    // Terminal A — owner-transfer postings in the same section; the send
    // chokepoint flips their transaction-payload owner_notified the same way.
    posted_fyi_transaction_ids: postedFyiTransactionIds,
    // The previously-asked evidence requests this draft tells the client are handled; the
    // send chokepoint flips retraction_notified on exactly these (told once, like FYIs).
    retracted_request_ids: retractedRequests.map((r) => r.request_id),
    // Doc-first drain (Slice 3) — the auto-explained docs summarised in this
    // draft's "Explained without a bank line" section; the send chokepoint
    // flips their payload owner_notified true (FYI'd once, never re-gathered).
    explained_fyi_document_ids: explainedFyiDocumentIds,
    // Slice 4b — the posted settlement entries summarised in this draft's
    // "Recorded as paid from your own funds" section; the send chokepoint
    // flips their settlement_entry owner_notified the same way.
    settlement_fyi_document_ids: settlementFyiDocumentIds,
    // Late-bank-line reversal guard — the reversed settlement entries this
    // draft tells the owner about; the send chokepoint flips their
    // settlement_entry.reversal owner_notified the same way.
    settlement_reversal_fyi_document_ids: settlementReversalFyiDocumentIds,
    // Twin-aging lane — the aged twin groups whose owner ask rides this
    // draft; the send chokepoint stamps each group's match rows with the
    // twin_aging marker + the reconciliation_match.twin_aged_to_ask audit
    // receipt once the ask item's evidence request actually mints.
    twin_ask_groups: twinAskGroupReceipts(agedTwinAsks),
    // Material-hold lane — the held-match groups whose owner confirm rides
    // this draft; the send chokepoint stamps each group's match rows with the
    // material_hold marker + the reconciliation_match.material_hold_to_ask
    // audit receipt once the ask item's evidence request actually mints.
    held_match_groups: heldMatchGroupReceipts(heldMatchConfirms),
    input_stats: {
      coding_items: codingItems.length,
      internal_movement_lines: internalMovementLines.length,
      statement_coverage: statementCoverage.length,
      open_evidence_requests: openRequestsForDrafter.length,
      posted_matches: appliedFyiLines.length,
      coding_fyi_lines: codingFyiLines.length,
      retracted_requests: retractedRequests.length,
      document_items: documentItems.length,
      explained_documents: explainedDocLines.length,
      recorded_settlements: recordedSettlementLines.length,
      reversed_settlements: reversedSettlementLines.length,
      aged_twin_asks: agedTwinAsks.length,
      held_match_confirms: heldMatchConfirms.length
    }
  };

  await client.query('begin');
  try {
    assertExecutionBudgetActive({ client });
    // One live draft per client: a stale draft reflects books that have
    // since moved, which is exactly what must never get sent.
    await client.query(
      `update client_ask_batches
       set status = 'superseded', updated_at = now()
       where firm_id = $1 and client_id = $2 and status = 'draft'`,
      [firmId, cleanClientId]
    );
    // Superseding may wait on a prior draft row lock.
    assertExecutionBudgetActive({ client });
    const insertResult = await client.query(
      `insert into client_ask_batches (
         id, firm_id, client_id, period_start, period_end, status,
         subject, message_markdown, payload, verdicts_as_of, model, created_by
       )
       values ($1, $2, $3, $4::date, $5::date, 'draft', $6, $7, $8::jsonb, $9::timestamptz, $10, $11)
       returning *`,
      [
        batchId,
        firmId,
        cleanClientId,
        cleanPeriodStart,
        cleanPeriodEnd,
        draft.subject,
        draft.message_markdown,
        JSON.stringify(batchPayload),
        verdictsAsOf,
        model || null,
        actorId
      ]
    );
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'ask_batch.draft', 'client_ask_batch', $4, $5::jsonb)`,
      [
        firmId,
        cleanClientId,
        actorId,
        batchId,
        JSON.stringify({
          model: model || null,
          language: draftLanguage || null,
          period_start: cleanPeriodStart,
          period_end: cleanPeriodEnd,
          counts: draft.counts,
          input_stats: batchPayload.input_stats
        })
      ]
    );
    assertExecutionBudgetActive({ client });
    await client.query('commit');
    return { batch: rowToClientAskBatchPayload(insertResult.rows[0]) };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
};

export const draftClientAskBatchInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart = null,
  periodEnd = null,
  actorId = 'system'
} = {}) =>
  withFirmDbClient((client) =>
    __draftClientAskBatchWithClient({ client, firmId, clientId, periodStart, periodEnd, actorId })
  );

export const getClientAskBatchesFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  status,
  limit = 20
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  if (!cleanClientId) {
    const error = new Error('Client id is required.');
    error.statusCode = 400;
    error.code = 'ASK_BATCH_CLIENT_REQUIRED';
    throw error;
  }
  const statuses = String(status || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const params = [firmId, cleanClientId];
  let statusClause = '';
  if (statuses.length) {
    params.push(statuses);
    statusClause = `and status = any($${params.length}::text[])`;
  }
  params.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
  const result = await queryOptionalFirmDb(
    `select *
     from client_ask_batches
     where firm_id = $1
       and client_id = $2
       ${statusClause}
     order by created_at desc
     limit $${params.length}`,
    params
  );
  return {
    source: 'client_ask_batches',
    client_id: cleanClientId,
    batches: result.rows.map(rowToClientAskBatchPayload)
  };
};

// Firm-wide live drafts for the inbox feed: at most one per client by the
// supersede contract, so no limit gymnastics. The caller (the /feed route)
// filters to the clients its authorized snapshot actually contains.
export const getAskBatchDraftsForFirmFromDb = async ({ firmId = DEFAULT_FIRM_ID } = {}) => {
  const result = await queryOptionalFirmDb(
    `select *
     from client_ask_batches
     where firm_id = $1
       and status = 'draft'
     order by created_at desc`,
    [firmId]
  );
  return result.rows.map(rowToClientAskBatchPayload);
};

// The ONE ask fan-out: every channel deliverer, in the ask-batch send's
// original order, each self-gating (env allowlist / binding / config-plane
// flag) and each fail-soft — a channel failure warns and never blocks the
// caller. Extracted from __sendClientAskBatchWithClient so the firm-chat
// ask_client verbs share the SAME fan-out instead of stopping at the DB
// (audit §4: "channel fan-out lives only in the ask-batch send"). Returns
// per-channel results so a caller's receipt can say what actually left.
// `deps` is passed through to every deliverer unchanged (their own transport
// seam, e.g. deps.deliverOwnerMessage) so tests drive the real fan-out.
export const deliverEvidenceAsksOnAllChannels = async ({ client, firmId, clientId, evidenceRequestIds = [], deps } = {}) => {
  const results = {};
  // 122 — the OWNER-channel guard, enforced once for all four channels: only
  // client-audience asks may reach WhatsApp/SMS/Telegram/email. A seat/agent
  // ask arriving here (a caller bug) is dropped and receipted in the result,
  // never delivered — an internal question on the owner's phone is the leak
  // this line exists to prevent.
  const requestedIds = (Array.isArray(evidenceRequestIds) ? evidenceRequestIds : []).filter(Boolean);
  let clientAudienceIds = requestedIds;
  if (requestedIds.length) {
    const audienceResult = await client.query(
      `select id from client_evidence_requests
        where firm_id = $1 and client_id = $2 and id = any($3::text[]) and audience = 'client'`,
      [firmId, clientId, requestedIds]
    );
    clientAudienceIds = audienceResult.rows.map((row) => row.id);
    if (clientAudienceIds.length !== requestedIds.length) {
      results.skipped_non_client_audience = requestedIds.filter((id) => !clientAudienceIds.includes(id));
    }
  }
  const evidenceRequestIdsForChannels = clientAudienceIds;
  const attempt = async (channel, deliver) => {
    try {
      return await deliver();
    } catch (error) {
      try { console.warn(`[${channel}] evidence ask delivery failed`, error?.message || error); } catch {}
      return { error: error?.message || 'delivery_failed' };
    }
  };
  results.whatsapp = await attempt('whatsapp', () =>
    deliverWhatsAppEvidenceAsksAfterSend({ client, firmId, clientId, evidenceRequestIds: evidenceRequestIdsForChannels, deps }));
  results.sms = await attempt('sms', () =>
    deliverSmsEvidenceAsksAfterSend({ client, firmId, clientId, evidenceRequestIds: evidenceRequestIdsForChannels, deps }));
  // G14 (outbound-actions M1): Telegram + owner-email join the ask fan-out.
  // Each deliverer carries its own gate (binding / config-plane flag), so an
  // unbound or dark channel is an internal no-op.
  results.telegram = await attempt('telegram', () =>
    deliverTelegramEvidenceAsksAfterSend({ client, firmId, clientId, evidenceRequestIds: evidenceRequestIdsForChannels, deps }));
  results.email = await attempt('email', () =>
    deliverEmailEvidenceAsksAfterSend({ client, firmId, clientId, evidenceRequestIds: evidenceRequestIdsForChannels, deps }));
  return results;
};

// Apply-time freshness for ask batches. The draft model may take long enough
// for a matcher, coder, or owner-answer transition to settle one of the rows it
// was shown. Database ids in a previously-valid model response are therefore
// not authority to contact the client: immediately before the batch persists
// (generation-time guard) and again under the send row lock (apply-time guard),
// every direct ask anchor must still satisfy the same source-of-truth lifecycle
// predicates that admitted it to the draft.
//
// This deliberately validates anchors, not prose. If any anchor is stale the
// whole batch is superseded/retried because editing model-authored markdown
// after the fact would be intelligence-substituting and could leave dangling
// references in the message.
const uniqueStringIds = (values = []) => [...new Set((Array.isArray(values) ? values : [])
  .filter(Boolean)
  .map((value) => String(value)))];

const directDraftAskIds = (draft = {}) => ({
  transactionIds: uniqueStringIds((Array.isArray(draft?.items) ? draft.items : [])
    .filter((item) => item?.disposition === 'ask' && item?.transaction_id)
    .map((item) => item.transaction_id)),
  documentIds: uniqueStringIds((Array.isArray(draft?.document_asks) ? draft.document_asks : [])
    .filter((item) => item?.disposition === 'ask' && item?.document_id)
    .map((item) => item.document_id))
});

// Preserve the admission lane across the model boundary. A suggested match
// invalidates an ordinary missing-evidence ask, but it is the prerequisite for
// both a twin-disambiguation ask and a material-authority confirmation. An
// id-only receipt loses that distinction and deterministically rejects the two
// specialist lanes as stale.
const directAskAnchorIds = (draft = {}, {
  agedTwinAsks = [], heldMatchConfirms = [], codingItems = []
} = {}) => {
  const direct = directDraftAskIds(draft);
  const heldSourceIds = new Set(uniqueStringIds(heldMatchConfirms.map((group) => group?.transaction_id)));
  const twinSourceIds = new Set(uniqueStringIds(agedTwinAsks.map((group) => group?.transaction_id)));
  const heldMatchTransactionIds = direct.transactionIds.filter((id) => heldSourceIds.has(id));
  const heldIds = new Set(heldMatchTransactionIds);
  const agedTwinTransactionIds = direct.transactionIds.filter((id) => twinSourceIds.has(id) && !heldIds.has(id));
  const twinIds = new Set(agedTwinTransactionIds);
  const transactionIds = direct.transactionIds.filter((id) => !heldIds.has(id) && !twinIds.has(id));
  const ordinaryIds = new Set(transactionIds);
  const candidateMap = new Map((Array.isArray(codingItems) ? codingItems : [])
    .filter((item) => ordinaryIds.has(String(item?.id || '')))
    .map((item) => [String(item.id), item.local_evidence_candidates || []]));
  return {
    transactionIds,
    agedTwinTransactionIds,
    heldMatchTransactionIds,
    documentIds: direct.documentIds,
    // Exact local-material universe the model was shown. Send rehydrates the
    // same deterministic inventory and refuses the whole batch if a file
    // arrived, disappeared, or changed parse state while the draft waited.
    localEvidenceByTransaction: localEvidenceCandidateReceipt(candidateMap)
  };
};

// The draft remains the complete source of anchor identity. The persisted
// receipt supplies only lane classification; any ask omitted from a malformed
// receipt falls back to the stricter ordinary lane. Legacy receipts contain
// only transactionIds/documentIds and therefore keep their historical
// ordinary-ask contract.
const normalizeAskFreshnessAnchors = (draft = {}, freshnessAnchorIds = null) => {
  const direct = directDraftAskIds(draft);
  const receipt = freshnessAnchorIds && typeof freshnessAnchorIds === 'object'
    ? freshnessAnchorIds
    : {};
  const directIds = new Set(direct.transactionIds);
  const heldMatchTransactionIds = uniqueStringIds(receipt.heldMatchTransactionIds)
    .filter((id) => directIds.has(id));
  const heldIds = new Set(heldMatchTransactionIds);
  const agedTwinTransactionIds = uniqueStringIds(receipt.agedTwinTransactionIds)
    .filter((id) => directIds.has(id) && !heldIds.has(id));
  const twinIds = new Set(agedTwinTransactionIds);
  const transactionIds = direct.transactionIds.filter((id) => !heldIds.has(id) && !twinIds.has(id));
  const ordinaryIds = new Set(transactionIds);
  const rawLocalEvidence = receipt.localEvidenceByTransaction
    && typeof receipt.localEvidenceByTransaction === 'object'
    ? receipt.localEvidenceByTransaction
    : {};
  const localEvidenceByTransaction = Object.fromEntries(Object.entries(rawLocalEvidence)
    .filter(([transactionId, candidates]) => ordinaryIds.has(transactionId) && Array.isArray(candidates))
    .map(([transactionId, candidates]) => [transactionId, candidates.map((candidate) => ({
      document_id: String(candidate?.document_id || ''),
      filename: String(candidate?.filename || ''),
      document_type: String(candidate?.document_type || ''),
      parse_status: String(candidate?.parse_status || ''),
      document_date: candidate?.document_date || null,
      total_amount: candidate?.total_amount == null ? null : Number(candidate.total_amount),
      currency: candidate?.currency || null,
      basis: String(candidate?.basis || ''),
      // Carried so send can re-derive the exclusive-citable assignment the
      // draft was validated under (nearest line wins a shared document).
      day_distance: candidate?.day_distance == null ? null : Number(candidate.day_distance)
    })).filter((candidate) => candidate.document_id)]));
  return {
    transactionIds,
    agedTwinTransactionIds,
    heldMatchTransactionIds,
    documentIds: direct.documentIds,
    localEvidenceByTransaction
  };
};

export const __findStaleAskDraftAnchors = async ({
  client, firmId, clientId, draft, freshnessAnchorIds = null
} = {}) => {
  const {
    transactionIds,
    agedTwinTransactionIds,
    heldMatchTransactionIds,
    documentIds,
    localEvidenceByTransaction
  } = normalizeAskFreshnessAnchors(draft, freshnessAnchorIds);
  const eligibleTransactionIds = new Set();
  const eligibleAgedTwinTransactionIds = new Set();
  const eligibleHeldMatchTransactionIds = new Set();
  const eligibleDocumentIds = new Set();
  const localEvidenceChanges = [];

  if (transactionIds.length) {
    const eligible = await client.query(
      `select t.id
         from transactions t
        where t.firm_id = $1
          and t.client_id = $2
          and t.id = any($3::text[])
          and (
            (
              (t.payload->'ai_suggestion') is not null
              and (t.coding_state is null or t.coding_state not in ('applied', 'held', 'posted', 'synced', 'closed'))
            )
            or exists (
              select 1 from reconciliation_evaluations e
               where e.firm_id = t.firm_id
                 and e.client_id = t.client_id
                 and e.target_type = '${BANK_LINE_DISPOSITION_TARGET_TYPE}'
                 and e.matcher_family = '${BANK_LINE_DISPOSITION_FAMILY}'
                 and e.target_id = t.id
                 and e.verdict = 'no_match'
            )
          )
          -- Lock-step with ASK_BATCH_CANDIDATE_SQL (the stale-ask law): a
          -- supersedable sweep-minted generic ask does not make the anchor
          -- stale — this send is what replaces it. An owner REPLY landing
          -- between draft and send still blocks (it is not supersedable), so
          -- the batch correctly goes stale and re-drafts without the line.
          and not ${blockingOpenAskExistsSql({ firmColumn: 't.firm_id', transactionColumn: 't.id' })}
          -- RT-11 (F-17 — the #1959 treatment for auto_explain): an anchor Donna
          -- settled after drafting is stale; the batch is superseded and
          -- re-drafted without it. Lock-step with ASK_BATCH_CANDIDATE_SQL.
          and not ${settledBankLineSql({ statusColumn: 't.reconciliation_status' })}
          and not exists (
            select 1 from reconciliation_matches rm
             where rm.firm_id = t.firm_id
               and rm.client_id = t.client_id
               and rm.bank_transaction_id = t.id
               and rm.status in ('suggested', 'auto_matched', 'confirmed')
          )`,
      [firmId, clientId, transactionIds]
    );
    for (const row of eligible.rows || []) eligibleTransactionIds.add(String(row.id));

    // Formal matches are already handled by the eligibility SQL above. This
    // second read closes the earlier hole: a plausible local artifact changes
    // what we may tell the client even while it is pending, skipped, misrouted,
    // or otherwise has no reconciliation_match row yet.
    const currentCandidates = await loadLocalEvidenceCandidatesWithClient({
      client,
      firmId,
      clientId,
      transactionIds
    });
    const currentReceipt = localEvidenceCandidateReceipt(currentCandidates);
    for (const transactionId of transactionIds) {
      const expected = Array.isArray(localEvidenceByTransaction?.[transactionId])
        ? localEvidenceByTransaction[transactionId]
        : [];
      const current = Array.isArray(currentReceipt?.[transactionId])
        ? currentReceipt[transactionId]
        : [];
      if (JSON.stringify(expected) !== JSON.stringify(current)) {
        localEvidenceChanges.push({ transaction_id: transactionId, expected, current });
      }
    }
  }

  if (agedTwinTransactionIds.length) {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const twinAgingActs = clientFlagActs({
      flagKey: TWIN_AGING_ASK_FLAG_KEY,
      snapshot,
      envFallback: () => false
    });
    if (twinAgingActs) {
      const gathered = await gatherAgedTwinAskGroups(client, {
        firmId,
        clientId,
        rowLimit: 200,
        groupLimit: 40
      });
      for (const group of gathered.groups || []) {
        eligibleAgedTwinTransactionIds.add(String(group.transaction_id));
      }
    }
  }

  if (heldMatchTransactionIds.length) {
    const gathered = await gatherHeldMaterialAskGroups(client, {
      firmId,
      clientId,
      rowLimit: 200,
      groupLimit: 40
    });
    for (const group of gathered.groups || []) {
      eligibleHeldMatchTransactionIds.add(String(group.transaction_id));
    }
  }

  if (documentIds.length) {
    const eligible = await client.query(
      `select d.id
         from documents d
        where d.firm_id = $1
          and d.client_id = $2
          and d.id = any($3::text[])
          and (
            select ev.payload->>'disposition'
              from reconciliation_evaluations ev
             where ev.firm_id = d.firm_id
               and ev.client_id = d.client_id
               and ev.target_type = '${DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE}'
               and ev.matcher_family = '${DOCUMENT_NO_LINE_DISPOSITION_FAMILY}'
               and ev.target_id = d.id
               and ev.payload->>'policy_version' = '${DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION}'
               and ev.payload->>'matcher_mode' = 'act'
             order by ev.evaluated_at desc
             limit 1
          ) in ('chase_evidence', 'needs_human')
          and coalesce(d.payload->'no_line_disposition'->>'disposition', '') <> 'auto_explain'
          and not exists (
            select 1 from client_evidence_requests cer
             where cer.firm_id = d.firm_id
               and cer.client_id = d.client_id
               and cer.request_payload->>'document_id' = d.id
               and cer.status in ('draft', 'open', 'replied')
          )
          and not exists (
            select 1 from reconciliation_matches rm
             where rm.firm_id = d.firm_id
               and rm.client_id = d.client_id
               and rm.matched_object_id = d.id
               and rm.matched_object_type <> 'bank_line'
               and rm.status in ('suggested', 'auto_matched', 'confirmed')
          )`,
      [firmId, clientId, documentIds]
    );
    for (const row of eligible.rows || []) eligibleDocumentIds.add(String(row.id));
  }

  const changedLocalEvidenceIds = new Set(localEvidenceChanges.map((change) => change.transaction_id));
  const staleOrdinaryTransactionIds = transactionIds
    .filter((id) => !eligibleTransactionIds.has(id) || changedLocalEvidenceIds.has(id));
  const staleAgedTwinTransactionIds = agedTwinTransactionIds
    .filter((id) => !eligibleAgedTwinTransactionIds.has(id));
  const staleHeldMatchTransactionIds = heldMatchTransactionIds
    .filter((id) => !eligibleHeldMatchTransactionIds.has(id));
  const staleTransactionIds = uniqueStringIds([
    ...staleOrdinaryTransactionIds,
    ...staleAgedTwinTransactionIds,
    ...staleHeldMatchTransactionIds
  ]);
  const staleDocumentIds = documentIds.filter((id) => !eligibleDocumentIds.has(id));
  return {
    stale: staleTransactionIds.length > 0 || staleDocumentIds.length > 0,
    stale_transaction_ids: staleTransactionIds,
    stale_document_ids: staleDocumentIds,
    local_evidence_changes: localEvidenceChanges,
    stale_transaction_ids_by_lane: {
      ordinary: staleOrdinaryTransactionIds,
      aged_twin: staleAgedTwinTransactionIds,
      held_match: staleHeldMatchTransactionIds
    }
  };
};

// The message states only what this writer actually did. It used to promise
// "Donna will draft a fresh one" unconditionally -- true on the auto-send path
// (askAutoSendProducer catches ASK_BATCH_STALE and calls requestRedraftFn) but
// NOT on the manual route, which just serialised the error while this writer had
// already committed the supersede. A user clicked Send, was told a fresh draft
// was coming, and was left with no draft at all. The promise now belongs to
// whoever actually requests the re-draft: the send route reports it back as
// `redraft_requested` and the surface says the true thing.
const staleAskBatchError = ({ batchId = null, staleAnchors, phase }) => {
  const error = new Error('This client message became outdated while Donna was finishing the books. It was not sent.');
  error.statusCode = 409;
  error.code = phase === 'draft' ? 'ASK_BATCH_STALE_DURING_DRAFT' : 'ASK_BATCH_STALE';
  error.details = { batch_id: batchId, phase, ...staleAnchors };
  return error;
};

const persistedDraftTerminalInputs = (batchRow = {}, draft = {}) => {
  const receipt = batchRow.payload?.terminal_ask_anchor_ids;
  const hasReceipt = receipt && typeof receipt === 'object';
  const transactionIds = hasReceipt
    ? uniqueStringIds(receipt.transaction_ids)
    : uniqueStringIds((Array.isArray(draft.items) ? draft.items : []).map((item) => item?.transaction_id));
  const documentIds = hasReceipt
    ? uniqueStringIds(receipt.document_ids)
    : uniqueStringIds((Array.isArray(draft.document_asks) ? draft.document_asks : []).map((item) => item?.document_id));
  return {
    hasReceipt,
    transactionIds,
    documentIds,
    codingItems: transactionIds.map((id) => ({ id })),
    documentItems: documentIds.map((id) => ({ id }))
  };
};

const assertPersistedDraftTerminalCoverage = (batchRow = {}, draft = {}) => {
  const expected = persistedDraftTerminalInputs(batchRow, draft);
  const coverage = assertAskDraftTerminalCoverage(draft, {
    codingItems: expected.codingItems,
    documentItems: expected.documentItems,
    rejectUnknown: true
  });
  if (!expected.hasReceipt && batchRow.payload?.input_stats) {
    const stats = batchRow.payload.input_stats;
    const expectedTransactionCount = ['coding_items', 'aged_twin_asks', 'held_match_confirms']
      .reduce((sum, key) => sum + Math.max(0, Number(stats[key]) || 0), 0);
    const expectedDocumentCount = Math.max(0, Number(stats.document_items) || 0);
    const failures = [];
    if (coverage.transaction_ids.length !== expectedTransactionCount) {
      failures.push(`transaction_count:${coverage.transaction_ids.length}/${expectedTransactionCount}`);
    }
    if (coverage.document_ids.length !== expectedDocumentCount) {
      failures.push(`document_count:${coverage.document_ids.length}/${expectedDocumentCount}`);
    }
    if (failures.length) {
      const error = new Error(`Draft terminal coverage does not match its gathered inputs: ${failures.join(', ')}.`);
      error.statusCode = 502;
      error.code = 'ASK_PIPELINE_BAD_DRAFT';
      error.details = { failures };
      throw error;
    }
  }
  return coverage;
};

const assertPersistedDraftLocalEvidenceIntegrity = (batchRow = {}, draft = {}) => {
  const receipt = batchRow.payload?.freshness_anchor_ids?.localEvidenceByTransaction;
  const localEvidenceByTransaction = receipt && typeof receipt === 'object' ? receipt : {};
  const codingItems = Object.entries(localEvidenceByTransaction).map(([id, candidates]) => ({
    id,
    local_evidence_candidates: (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
      id: candidate?.document_id,
      filename: candidate?.filename,
      document_type: candidate?.document_type,
      parse_status: candidate?.parse_status,
      document_date: candidate?.document_date,
      total_amount: candidate?.total_amount,
      currency: candidate?.currency,
      basis: candidate?.basis,
      day_distance: candidate?.day_distance == null ? null : Number(candidate.day_distance)
    }))
  }));
  return assertAskDraftLocalEvidenceIntegrity(draft, {
    codingItems,
    rejectUnknown: true
  });
};

const invalidTerminalAskBatchError = ({ batchId = null, receipt }) => {
  const error = new Error('This client message contained an unresolved item that was not turned into a question. It was not sent; Donna will draft a fresh one.');
  error.statusCode = 409;
  error.code = 'ASK_BATCH_NONTERMINAL_DRAFT';
  error.details = { batch_id: batchId, ...receipt };
  return error;
};

export const __sendClientAskBatchWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  batchId,
  clientId = '',
  actorId = 'system',
  // Autonomy receipt: when the auto-send producer (askAutoSendProducer) delivers a
  // drafted batch on the firm's standing authorization, it stamps the send audit so
  // an autonomous send is distinguishable from a firm operator's click in audit_events.
  // Defaults keep an interactive send byte-identical (no extra keys in the metadata).
  autoSend = false,
  authorizedBy = null
} = {}) => {
  const cleanBatchId = String(batchId || '').trim();
  if (!cleanBatchId) {
    const error = new Error('Ask batch id is required.');
    error.statusCode = 400;
    error.code = 'ASK_BATCH_ID_REQUIRED';
    throw error;
  }

  await client.query('begin');
  try {
    // FOR UPDATE: the send button is exactly the double-click shape that
    // produced the batch-coding double-run race — serialize on the row.
    const batchResult = await client.query(
      'select * from client_ask_batches where firm_id = $1 and id = $2 for update',
      [firmId, cleanBatchId]
    );
    const batchRow = batchResult.rows[0];
    if (!batchRow || (clientId && batchRow.client_id !== clientId)) {
      const error = new Error('Ask batch was not found.');
      error.statusCode = 404;
      error.code = 'ASK_BATCH_NOT_FOUND';
      throw error;
    }
    if (batchRow.status !== 'draft') {
      const error = new Error(`Ask batch is ${batchRow.status}; only drafts can be sent.`);
      error.statusCode = 409;
      error.code = 'ASK_BATCH_NOT_DRAFT';
      throw error;
    }

    // Pilot authority is review-only until an operator's receipted release.
    // Check the persisted batch's client under its send lock, covering both
    // the scheduled producer and manual Send. A release only removes this
    // hold; every gate below and every channel's own gate still apply.
    if ((await readInternalPilotSendContainmentWithClient(client, { firmId, clientId: batchRow.client_id })).contained) {
      throw Object.assign(new Error('Internal pilot questions remain drafts until an operator releases question sending for this client.'), {
        statusCode: 409, code: 'INTERNAL_PILOT_SEND_DISABLED'
      });
    }

    const admission = await checkEntityReadinessAdmissionWithClient({
      client,
      firmId,
      clientId: batchRow.client_id,
      boundary: 'ask_send',
      resourceType: 'client_ask_batch',
      resourceId: cleanBatchId
    });
    if (!admission.allowed) {
      await client.query('commit');
      const error = new EntityReadinessAdmissionError(admission);
      error.transactionCommitted = true;
      throw error;
    }

    const draft = batchRow.payload?.draft || {};
    // Apply-time FIRST guard. This catches both a corrupted new draft and an
    // older saved draft from the former ask/notify/skip contract. Retire the
    // whole batch under the row lock — never patch model-authored prose or
    // allow the send loop to silently ignore a non-terminal item.
    let terminalCoverageError = null;
    try {
      assertPersistedDraftTerminalCoverage(batchRow, draft);
      assertPersistedDraftLocalEvidenceIntegrity(batchRow, draft);
    } catch (error) {
      terminalCoverageError = error;
    }
    if (terminalCoverageError) {
      const terminalReceipt = {
        reason: 'draft_contains_nonterminal_items',
        checked_at: new Date().toISOString(),
        failures: terminalCoverageError.details?.failures || [],
        source_code: terminalCoverageError.code || 'ASK_PIPELINE_BAD_DRAFT'
      };
      await client.query(
        `update client_ask_batches
            set status = 'superseded',
                payload = payload || $3::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2 and status = 'draft'`,
        [firmId, cleanBatchId, JSON.stringify({ superseded_before_send: terminalReceipt })]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'ask_batch.superseded_before_send', 'client_ask_batch', $4, $5::jsonb)`,
        [firmId, batchRow.client_id, actorId, cleanBatchId, JSON.stringify(terminalReceipt)]
      );
      await client.query('commit');
      const error = invalidTerminalAskBatchError({ batchId: cleanBatchId, receipt: terminalReceipt });
      error.transactionCommitted = true;
      throw error;
    }
    const freshnessAware = batchRow.payload?.freshness_anchor_ids
      && typeof batchRow.payload.freshness_anchor_ids === 'object';
    const staleAnchors = freshnessAware
      ? await __findStaleAskDraftAnchors({
        client,
        firmId,
        clientId: batchRow.client_id,
        draft,
        freshnessAnchorIds: batchRow.payload.freshness_anchor_ids
      })
      : { stale: false, stale_transaction_ids: [], stale_document_ids: [] };
    const stalePosted = await stalePostedReceipts(client,firmId,batchRow.client_id,batchRow.payload?.posted_journal_receipts || [],true);
    if (!Array.isArray(batchRow.payload?.posted_journal_receipts)
      && (batchRow.payload?.posted_fyi_match_ids?.length || batchRow.payload?.posted_fyi_transaction_ids?.length)) {
      staleAnchors.stale = true;
      staleAnchors.posting_receipt_missing = true;
    }
    if (stalePosted.length) { staleAnchors.stale = true; staleAnchors.stale_posted_transaction_ids = stalePosted; }
    if (staleAnchors.stale) {
      const staleReceipt = {
        reason: 'ask_anchors_no_longer_eligible',
        checked_at: new Date().toISOString(),
        ...staleAnchors
      };
      await client.query(
        `update client_ask_batches
            set status = 'superseded',
                payload = payload || $3::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2 and status = 'draft'`,
        [firmId, cleanBatchId, JSON.stringify({ superseded_before_send: staleReceipt })]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'ask_batch.superseded_before_send', 'client_ask_batch', $4, $5::jsonb)`,
        [firmId, batchRow.client_id, actorId, cleanBatchId, JSON.stringify(staleReceipt)]
      );
      await client.query('commit');
      const error = staleAskBatchError({ batchId: cleanBatchId, staleAnchors, phase: 'send' });
      error.transactionCommitted = true;
      throw error;
    }
    // Re-ask cadence (design 2026-07-06 §3, flag-gated on the plane): when the
    // cadence acts for this client, every ask minted by this send carries
    // due_at = sent_at + the nudge interval — the clock the daily re-ask sweep
    // (askReaskCadence.runAskReaskSweep) reads. Flag off ⇒ dueAt null,
    // byte-identical to the pre-cadence mint.
    const sendConfigSnapshot = await readClientConfigSnapshot(client, {
      firmId, clientId: batchRow.client_id
    });
    const reaskCadenceActs = clientFlagActs({
      flagKey: REASK_CADENCE_FLAG_KEY,
      snapshot: sendConfigSnapshot,
      envFallback: () => false
    });
    const askDueAt = reaskCadenceActs
      ? new Date(Date.now() + askReaskNudgeDays() * 86400000).toISOString()
      : undefined;
    const evidenceRequestIds = [];
    // The stale-ask law's once-guard, send side: every ordinary ask records
    // which citable candidates were nameable at THIS send (derived from the
    // same freshness receipt the staleness check just validated, through the
    // same citable filter the draft used). The candidate gather compares the
    // next citable set against this stamp, so a refreshed ask is not re-fed
    // until the evidence picture genuinely changes again.
    const freshnessLocalEvidence = batchRow.payload?.freshness_anchor_ids?.localEvidenceByTransaction
      && typeof batchRow.payload.freshness_anchor_ids.localEvidenceByTransaction === 'object'
      ? batchRow.payload.freshness_anchor_ids.localEvidenceByTransaction
      : {};
    // transaction → minted request id, so the twin-aging receipt below stamps
    // ONLY groups whose ask actually minted in this send.
    const mintedRequestIdByTx = new Map();
    for (const item of draft.items || []) {
      if (item.disposition !== 'ask' || !item.transaction_id) continue;
      const receiptCandidates = freshnessLocalEvidence[item.transaction_id];
      const request = await createClientEvidenceRequestWithClient({
        client,
        firmId,
        clientId: batchRow.client_id,
        transactionId: item.transaction_id,
        question: item.question,
        evidenceType: item.evidence_type,
        dueAt: askDueAt,
        actorId,
        requestContext: {
          ask_batch_id: batchRow.id,
          ...(Array.isArray(receiptCandidates)
            ? {
                citable_local_evidence: citableEvidenceCandidates(receiptCandidates)
                  .map((candidate) => ({
                    document_id: String(candidate?.document_id || candidate?.id || ''),
                    filename: String(candidate?.filename || '')
                  }))
              }
            : {})
        }
      });
      evidenceRequestIds.push(request.id);
      mintedRequestIdByTx.set(item.transaction_id, request.id);
    }

    // Doc-first terminal drain (Slice 3) — mint the DOC-anchored requests: a
    // receipt/bill with no bank line whose disposition said only the owner can
    // resolve it. transaction_id stays null; the anchor is
    // request_payload.document_id (what Slice 1's awaiting_owner projection,
    // the convergence metric, and the drain's already-asked skip all read).
    let documentAskCount = 0;
    for (const docAsk of draft.document_asks || []) {
      if (docAsk.disposition !== 'ask' || !docAsk.document_id) continue;
      const request = await createClientEvidenceRequestWithClient({
        client,
        firmId,
        clientId: batchRow.client_id,
        documentId: docAsk.document_id,
        question: docAsk.question,
        evidenceType: docAsk.evidence_type,
        dueAt: askDueAt,
        actorId,
        requestContext: { ask_batch_id: batchRow.id }
      });
      evidenceRequestIds.push(request.id);
      documentAskCount += 1;
    }

    const skippedStatementRequests = [];
    for (const statementRequest of draft.statement_requests || []) {
      const anchorTransactionId = (statementRequest.anchor_transaction_ids || [])[0] || '';
      if (!anchorTransactionId) {
        // No anchoring line survived sanitization — the request still
        // ships inside message_markdown; it just has no per-transaction
        // reply thread.
        skippedStatementRequests.push(statementRequest.account_reference || '');
        continue;
      }
      const request = await createClientEvidenceRequestWithClient({
        client,
        firmId,
        clientId: batchRow.client_id,
        transactionId: anchorTransactionId,
        question: statementRequest.request_text,
        evidenceType: 'bank_statement',
        dueAt: askDueAt,
        actorId,
        requestContext: {
          ask_batch_id: batchRow.id,
          account_reference: statementRequest.account_reference || '',
          // Terminal B (B-i): the FULL anchor list, not just the row-anchoring
          // first id. One statement request covers every line that references
          // the missing account; the convergence projection + SQL hanging
          // metric read this list so the SIBLING lines count as on_owner while
          // the request is open, instead of hanging on a question the owner
          // already has (docs/design-coding-skip-class-terminals.md §2).
          anchor_transaction_ids: (statementRequest.anchor_transaction_ids || []).filter(Boolean)
        },
        markTransactionNeedsClient: false
      });
      evidenceRequestIds.push(request.id);
    }
    // A statement request can deliberately share the same transaction anchor
    // as an item-level ask. createClientEvidenceRequestWithClient correctly
    // returns the existing active row; normalize the collected receipt before
    // persistence and fan-out so one owner ask is counted and delivered once.
    const sentEvidenceRequestIds = uniqueStringIds(evidenceRequestIds);

    const updateResult = await client.query(
      `update client_ask_batches
       set status = 'sent', sent_at = now(), sent_by = $3,
           payload = payload || $4::jsonb, updated_at = now()
       where firm_id = $1 and id = $2
       returning *`,
      [
        firmId,
        cleanBatchId,
        actorId,
        JSON.stringify({
          sent: {
            evidence_request_ids: sentEvidenceRequestIds,
            skipped_statement_requests: skippedStatementRequests
          }
        })
      ]
    );
    // E3 — FYI the owner exactly once for each auto-reconciled material match
    // summarised in this batch's "already matched & posted" section: flip
    // owner_notified true now the message is sent, so the next draft never
    // re-gathers it. Guarded to the receipt's still-'false' rows — idempotent, a
    // concurrent flip is a clean no-op.
    const postedFyiMatchIds = Array.isArray(batchRow.payload?.posted_fyi_match_ids)
      ? batchRow.payload.posted_fyi_match_ids.filter(Boolean)
      : [];
    let postedFyiNotified = 0;
    if (postedFyiMatchIds.length) {
      const fyiResult = await client.query(
        `update reconciliation_matches
            set payload = jsonb_set(payload, '{authorization,material_auto_fyi,owner_notified}', 'true'::jsonb, true),
                updated_at = now()
          where firm_id = $1
            and id = any($2::text[])
            and status = 'auto_matched'
            and coalesce(payload->'authorization'->'material_auto_fyi'->>'owner_notified', '') = 'false'
          returning id`,
        [firmId, postedFyiMatchIds]
      );
      postedFyiNotified = fyiResult.rows.length;
    }
    // Terminal A — same exactly-once flip for owner-transfer posting FYIs, on
    // the transaction-payload marker the coding auto-post sweep wrote. Guarded
    // to still-'false' rows — idempotent, a concurrent flip is a clean no-op.
    const postedFyiTransactionIds = Array.isArray(batchRow.payload?.posted_fyi_transaction_ids)
      ? batchRow.payload.posted_fyi_transaction_ids.filter(Boolean)
      : [];
    let codingFyiNotified = 0;
    if (postedFyiTransactionIds.length) {
      const codingFyiResult = await client.query(
        `update transactions
            set payload = jsonb_set(payload, '{coding_auto_post,owner_notified}', 'true'::jsonb, true),
                updated_at = now()
          where firm_id = $1
            and id = any($2::text[])
            and coalesce(payload->'coding_auto_post'->>'owner_notified', '') = 'false'
          returning id`,
        [firmId, postedFyiTransactionIds]
      );
      codingFyiNotified = codingFyiResult.rows.length;
    }
    // Doc-first drain (Slice 3) — same exactly-once flip for the auto-explained
    // document FYIs, on the no_line_disposition marker the act-mode merge wrote.
    // Guarded to still-'false' auto_explain rows — idempotent, a concurrent
    // flip is a clean no-op.
    const explainedFyiDocumentIds = Array.isArray(batchRow.payload?.explained_fyi_document_ids)
      ? batchRow.payload.explained_fyi_document_ids.filter(Boolean)
      : [];
    let docExplainedFyiNotified = 0;
    if (explainedFyiDocumentIds.length) {
      const docFyiResult = await client.query(
        `update documents
            set payload = jsonb_set(payload, '{no_line_disposition,owner_notified}', 'true'::jsonb, true),
                updated_at = now()
          where firm_id = $1
            and id = any($2::text[])
            and payload->'no_line_disposition'->>'disposition' = 'auto_explain'
            and coalesce(payload->'no_line_disposition'->>'owner_notified', '') = 'false'
          returning id`,
        [firmId, explainedFyiDocumentIds]
      );
      docExplainedFyiNotified = docFyiResult.rows.length;
    }
    // Slice 4b — same exactly-once flip for the recorded-settlement FYIs, on
    // the settlement_entry marker the named writer wrote at post time.
    // Guarded to still-'false' posted rows — idempotent, a concurrent flip is
    // a clean no-op.
    const settlementFyiDocumentIds = Array.isArray(batchRow.payload?.settlement_fyi_document_ids)
      ? batchRow.payload.settlement_fyi_document_ids.filter(Boolean)
      : [];
    let settlementFyiNotified = 0;
    if (settlementFyiDocumentIds.length) {
      const settlementFyiResult = await client.query(
        `update documents
            set payload = jsonb_set(payload, '{settlement_entry,owner_notified}', 'true'::jsonb, true),
                updated_at = now()
          where firm_id = $1
            and id = any($2::text[])
            and coalesce(payload->'settlement_entry'->>'journal_id', '') <> ''
            and coalesce(payload->'settlement_entry'->>'owner_notified', '') = 'false'
          returning id`,
        [firmId, settlementFyiDocumentIds]
      );
      settlementFyiNotified = settlementFyiResult.rows.length;
    }
    // Late-bank-line reversal guard — same exactly-once flip for the
    // reversal FYIs, on the settlement_entry.reversal marker the producer
    // wrote at reversal time. Guarded to still-'false' reversed rows —
    // idempotent, a concurrent flip is a clean no-op.
    const settlementReversalFyiDocumentIds = Array.isArray(batchRow.payload?.settlement_reversal_fyi_document_ids)
      ? batchRow.payload.settlement_reversal_fyi_document_ids.filter(Boolean)
      : [];
    let settlementReversalFyiNotified = 0;
    if (settlementReversalFyiDocumentIds.length) {
      const reversalFyiResult = await client.query(
        `update documents
            set payload = jsonb_set(payload, '{settlement_entry,reversal,owner_notified}', 'true'::jsonb, true),
                updated_at = now()
          where firm_id = $1
            and id = any($2::text[])
            and coalesce(payload->'settlement_entry'->'reversal'->>'journal_id', '') <> ''
            and coalesce(payload->'settlement_entry'->'reversal'->>'owner_notified', '') = 'false'
          returning id`,
        [firmId, settlementReversalFyiDocumentIds]
      );
      settlementReversalFyiNotified = reversalFyiResult.rows.length;
    }
    // Retraction once-guard: mark the previously-asked evidence requests this batch just
    // told the client are handled, so the next draft never re-surfaces them (mirrors the
    // owner_notified flip above). The draft builder — flag-gated — is the only writer of
    // retracted_request_ids, so this is a safe no-op whenever the array is absent/empty.
    const retractedRequestIds = Array.isArray(batchRow.payload?.retracted_request_ids)
      ? batchRow.payload.retracted_request_ids.filter(Boolean)
      : [];
    let retractionNotified = 0;
    if (retractedRequestIds.length) {
      const retractionResult = await client.query(
        `update client_evidence_requests
            set response_payload = coalesce(response_payload, '{}'::jsonb) || '{"retraction_notified": true}'::jsonb,
                updated_at = now()
          where firm_id = $1
            and id = any($2::text[])
            and coalesce(response_payload->>'retraction_notified', '') <> 'true'
          returning id`,
        [firmId, retractedRequestIds]
      );
      retractionNotified = retractionResult.rows.length;
    }
    // Twin-aging lane — the mint IS the receipt's trigger: for each aged twin
    // group whose anchor line got an evidence request minted by THIS send,
    // stamp the group's match rows with the twin_aging marker (the gather's
    // asked-once guard) and record reconciliation_match.twin_aged_to_ask, in
    // the SAME transaction as the mint. The match rows are NOT re-banded —
    // the open ask is the persisted verdict that moves the line to terminal 2.
    // Guarded to still-unstamped 'suggested' rows — idempotent.
    const twinAskGroups = Array.isArray(batchRow.payload?.twin_ask_groups)
      ? batchRow.payload.twin_ask_groups
      : [];
    let twinAgedToAsk = 0;
    for (const group of twinAskGroups) {
      const requestId = mintedRequestIdByTx.get(group?.transaction_id);
      const matchIds = Array.isArray(group?.match_ids) ? group.match_ids.filter(Boolean) : [];
      if (!requestId || !matchIds.length) continue;
      const stamped = await client.query(
        `update reconciliation_matches
            set payload = jsonb_set(payload, '{twin_aging}', $3::jsonb, true),
                updated_at = now()
          where firm_id = $1
            and id = any($2::text[])
            and status = 'suggested'
            and coalesce(payload->'twin_aging'->>'asked_at', '') = ''
          returning id`,
        [firmId, matchIds, JSON.stringify({
          asked_at: new Date().toISOString(),
          evidence_request_id: requestId,
          ask_batch_id: cleanBatchId
        })]
      );
      if (stamped.rows.length) {
        twinAgedToAsk += 1;
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, 'reconciliation_match.twin_aged_to_ask', 'client_evidence_request', $4, $5::jsonb)`,
          [
            firmId,
            batchRow.client_id,
            actorId,
            requestId,
            JSON.stringify({
              transaction_id: group.transaction_id,
              match_ids: stamped.rows.map((r) => r.id),
              candidate_document_ids: Array.isArray(group.candidate_document_ids)
                ? group.candidate_document_ids
                : [],
              aged_days: group.aged_days ?? null,
              ask_batch_id: cleanBatchId
            })
          ]
        );
      }
    }
    // Material-hold lane — twin stamping's sibling: for each held-match group
    // whose anchor line got an evidence request minted by THIS send, stamp the
    // match rows with the material_hold marker (the gather's asked-once guard)
    // and record reconciliation_match.material_hold_to_ask, same transaction.
    // The match rows are NOT re-banded — the open ask IS terminal 2.
    const heldMatchGroups = Array.isArray(batchRow.payload?.held_match_groups)
      ? batchRow.payload.held_match_groups
      : [];
    let materialHoldToAsk = 0;
    for (const group of heldMatchGroups) {
      const requestId = mintedRequestIdByTx.get(group?.transaction_id);
      const matchIds = Array.isArray(group?.match_ids) ? group.match_ids.filter(Boolean) : [];
      if (!requestId || !matchIds.length) continue;
      const stamped = await client.query(
        `update reconciliation_matches
            set payload = jsonb_set(payload, '{material_hold}', $3::jsonb, true),
                updated_at = now()
          where firm_id = $1
            and id = any($2::text[])
            and status = 'suggested'
            and coalesce(payload->'material_hold'->>'asked_at', '') = ''
          returning id`,
        [firmId, matchIds, JSON.stringify({
          asked_at: new Date().toISOString(),
          evidence_request_id: requestId,
          ask_batch_id: cleanBatchId
        })]
      );
      if (stamped.rows.length) {
        materialHoldToAsk += 1;
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, 'reconciliation_match.material_hold_to_ask', 'client_evidence_request', $4, $5::jsonb)`,
          [
            firmId,
            batchRow.client_id,
            actorId,
            requestId,
            JSON.stringify({
              transaction_id: group.transaction_id,
              match_ids: stamped.rows.map((r) => r.id),
              candidate_document_ids: Array.isArray(group.candidate_document_ids)
                ? group.candidate_document_ids
                : [],
              hold_reasons: Array.isArray(group.hold_reasons) ? group.hold_reasons : [],
              ask_batch_id: cleanBatchId
            })
          ]
        );
      }
    }
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'ask_batch.send', 'client_ask_batch', $4, $5::jsonb)`,
      [
        firmId,
        batchRow.client_id,
        actorId,
        cleanBatchId,
        JSON.stringify({
          evidence_request_count: sentEvidenceRequestIds.length,
          skipped_statement_requests: skippedStatementRequests,
          posted_fyi_notified: postedFyiNotified,
          coding_fyi_notified: codingFyiNotified,
          retraction_notified: retractionNotified,
          document_ask_count: documentAskCount,
          doc_explained_fyi_notified: docExplainedFyiNotified,
          settlement_fyi_notified: settlementFyiNotified,
          settlement_reversal_fyi_notified: settlementReversalFyiNotified,
          twin_aged_to_ask: twinAgedToAsk,
          material_hold_to_ask: materialHoldToAsk,
          ...(autoSend
            ? { auto_send: true, authorized_by: authorizedBy || 'firm_setting:auto_send_client_asks' }
            : {})
        })
      ]
    );
    await client.query('commit');
    await deliverEvidenceAsksOnAllChannels({
      client, firmId, clientId: batchRow.client_id,
      evidenceRequestIds: sentEvidenceRequestIds
    });
    // Donna Loops shadow producer (post-commit, no-throw, LOOPS_SHADOW-gated).
    await onAskBatchSent({
      client, firmId, clientId: batchRow.client_id,
      batchId: cleanBatchId,
      evidenceRequestIds: sentEvidenceRequestIds
    });
    return rowToClientAskBatchPayload(updateResult.rows[0]);
  } catch (error) {
    if (!error?.transactionCommitted) await client.query('rollback');
    throw error;
  }
};

export const sendClientAskBatchInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  batchId,
  clientId = '',
  actorId = 'system',
  autoSend = false,
  authorizedBy = null
} = {}) =>
  withFirmDbClient((client) =>
    __sendClientAskBatchWithClient({ client, firmId, batchId, clientId, actorId, autoSend, authorizedBy })
  );

// Tenancy guard for the owner apply route: the evidence request the model
// named must actually belong to THIS (firm, client) — the resolve writer
// itself is keyed (firm, request-id) only, so the route checks scope here
// before executing.
export const getClientEvidenceRequestForClientFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  evidenceRequestId
} = {}) => {
  if (!clientId || !evidenceRequestId) return null;
  // 122 — the OWNER apply route may only touch client-audience asks: a
  // colleague/agent question is not the owner's to answer or even see.
  const result = await queryFirmDb(
    `select * from client_evidence_requests
      where firm_id = $1 and client_id = $2 and id = $3 and audience = 'client'
      limit 1`,
    [firmId, clientId, evidenceRequestId]
  );
  if (!result.rows.length) return null;
  return rowToClientEvidenceRequestPayload(result.rows[0]);
};

// By-id ask reader for the inbound dispatch: a context-id-anchored reply carries
// only ask_id, and the specialized routes (opening_balance / invoice_issuance)
// key off the ask's evidence_type + request_payload — without this default the
// dispatch would silently fall through to the generic evidence path. Returns the
// RAW row (the same shape getOpenAskByRef yields).
export const getClientEvidenceRequestByIdInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, askId } = {}) => {
  if (!askId) return null;
  return withFirmDbClient(async (client) => {
    // 122 — inbound CLIENT replies only: a reply arriving on the owner's
    // channel must never resolve a seat/agent-audience ask.
    const result = await client.query(
      `select * from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3 and audience = 'client' limit 1`,
      [firmId, clientId, askId]
    );
    return result.rows[0] || null;
  });
};
