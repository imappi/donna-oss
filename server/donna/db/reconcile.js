// server/donna/db/reconcile.js — plane S — reconciliation matches: matched-document loads, the manual match writer, the match update (confirm / reject) writer.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { toIsoDay } from '../dates.js';
import { onReconciliationMatchConfirmed, onReconciliationMatchRejected } from '../loopsShadowProducers.js';
import { delegatedAuthorityGrantId, delegationGateProof } from '../reconciliationLlmCore.js';
import { suspendGrantAfterCorrection } from '../reconciliationAuthorityGrants.js';
import { reverseCreditApplicationsForMatch, reverseReminderSettlementWithClient } from '../creditNoteApplications.js';
import { recordAcceptedEntityNameWithClient } from '../crossEntityGuard.js';

import { withFirmDbClient } from './pool.js';
import { DEFAULT_FIRM_ID } from './clients.js';
import { applyDocumentPaymentStatusAfterMatch, SUM_BASED_PAYMENT_STATUS_TYPES } from './documents.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

// Document evidence for the coding call: the best reconciliation match
// per bank line (confirmed > auto_matched > suggested) joined to its
// document header + line items. This is what lets the coding model see
// WHAT was bought instead of keyword-guessing off the bank descriptor —
// the matchers already did the hard work of pairing the evidence to the
// exact line.
const MATCH_STATUS_RANK = { confirmed: 0, auto_matched: 1, suggested: 2 };

export const loadMatchedDocumentsForTransactions = async ({ client, firmId, clientId, transactionIds = [] }) => {
  const byTransaction = new Map();
  const ids = transactionIds.filter(Boolean);
  if (!ids.length) return byTransaction;
  const matches = await client.query(
    `select rm.bank_transaction_id, rm.status as match_status, rm.matched_line_id,
            d.id as document_id, d.document_type, d.vendor_name, d.customer_name,
            d.total_amount, d.currency, d.document_date, d.filename, d.tax_amount, d.parse_summary,
            rm.created_at as matched_at
       from reconciliation_matches rm
       join documents d on d.firm_id = rm.firm_id and d.client_id = rm.client_id and d.id = rm.matched_object_id
      where rm.firm_id = $1 and rm.client_id = $2
        and rm.bank_transaction_id = any($3::text[])
        and rm.status in ('confirmed', 'auto_matched', 'suggested')
      order by rm.bank_transaction_id,
               case rm.status
                 when 'confirmed' then 0
                 when 'auto_matched' then 1
                 else 2
               end,
               rm.id`,
    [firmId, clientId, ids]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  for (const row of matches.rows) {
    const existing = byTransaction.get(row.bank_transaction_id);
    if (existing && MATCH_STATUS_RANK[existing.match_status] <= MATCH_STATUS_RANK[row.match_status]) continue;
    byTransaction.set(row.bank_transaction_id, {
      match_status: row.match_status,
      document_id: row.document_id,
      document_type: row.document_type,
      filename: row.filename || '',
      tax_amount: row.tax_amount == null ? null : Number(row.tax_amount),
      matched_at: row.matched_at || null,
      ...((row.parse_summary?.classification?.family || row.parse_summary?.router?.family) ? {source_family:row.parse_summary?.classification?.family || row.parse_summary?.router?.family} : {}),
      parse_summary: row.parse_summary || null,
      vendor_name: row.vendor_name,
      customer_name: row.customer_name,
      total_amount: row.total_amount == null ? null : Number(row.total_amount),
      currency: row.currency,
      document_date: row.document_date ? toIsoDay(row.document_date) : null,
      // RT-21c: a row match settles ONE listed row of a consolidated
      // statement — the coder (and RT-21f's split) read that row, not the
      // statement total. Filled from the lines query below.
      matched_line_id: row.matched_line_id || null,
      matched_line: null,
      lines: []
    });
  }
  const documentIds = [...new Set([...byTransaction.values()].map((doc) => doc.document_id))];
  if (documentIds.length) {
    const lines = await client.query(
      `select id, document_id, line_no, description, amount, tax_rate, payload,
              payload->'raw_extraction'->'settlement_row' as settlement_row
         from document_lines
        where firm_id = $1 and document_id = any($2::text[])
        order by document_id, line_no asc, id`,
      [firmId, documentIds]
    ).catch((error) => {
      if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
      throw error;
    });
    const linesByDocument = new Map();
    const linesById = new Map();
    for (const line of lines.rows) {
      const shaped = {
        id: line.id,
        description: line.description || '',
        amount: line.amount == null ? null : Number(line.amount),
        line_no: line.line_no, document_id: line.document_id,
        tax_rate: line.tax_rate == null ? null : Number(line.tax_rate),
        tax_amount: line.payload?.raw_extraction?.tax_amount ?? null,
        amount_kind: line.payload?.raw_extraction?.amount_kind ?? null,
        raw_extraction: line.payload?.raw_extraction || {},
        settlement_row: line.settlement_row || null
      };
      linesById.set(String(line.id), {
        ...shaped,
        id: line.id,
        line_no: line.line_no == null ? null : Number(line.line_no),
        settlement_row: line.settlement_row && typeof line.settlement_row === 'object' ? line.settlement_row : null
      });
      const list = linesByDocument.get(line.document_id) || [];
      list.push(shaped);
      linesByDocument.set(line.document_id, list);
    }
    for (const doc of byTransaction.values()) {
      doc.lines = linesByDocument.get(doc.document_id) || [];
      if (doc.matched_line_id) doc.matched_line = linesById.get(String(doc.matched_line_id)) || null;
    }
  }
  return byTransaction;
};

// THE LATE-BANK-LINE GUARD, detection half (documentSettlementEntry.js header's
// named follow-up; docs/donna-settlement-answer-and-ledger-entry-plan.md §3).
// A document the settlement lane already booked as owner-funded (DR expense /
// CR owner funds — payload.settlement_entry.journal_id is the marker) just got
// a bank line CONFIRMED against it: the owner said "cash" and was wrong, and
// the entry plus the coded bank line would silently double-count the expense.
// This funnel is the one seam every settle cascade runs (matcher cores, family
// matchers, auto-explain passes, the manual link, the patch confirm), so the
// detection rides here: ONE guarded UPDATE that surfaces the persisted
// needs_ledger_adjustment state, atomic with the confirm (same caller txn).
// Deterministic, marker-keyed, self-gating: a doc with no settlement entry is
// a no-op. The settle-context itself proves a settled match exists (non-sum
// callers only run on settle cascades; sum-based 'paid'/'partial' is computed
// FROM the settled-match sum) — deliberately NO reconciliation_matches
// subquery here. The REVERSAL is proposed/posted by the sibling producer
// (documentSettlementReversal.runDocumentSettlementReversalsForClient), which
// re-derives the condition from the doc × matches join — the marker is the
// surfaced state, never the guard's source of truth. Never silently
// double-count, never auto-un-post: the correction is a reversal journal via
// postLedgerAdjustmentInDb.
export const detectLateBankLineAfterMatch = async ({ client, firmId, matchId, documentId }) => {
  const marked = await client.query(
    `update documents
        set payload = jsonb_set(
              payload,
              '{settlement_entry,late_bank_line}',
              $3::jsonb,
              true),
            updated_at = now()
      where firm_id = $1 and id = $2
        and coalesce(payload->'settlement_entry'->>'journal_id', '') <> ''
        and payload->'settlement_entry'->'late_bank_line' is null
        and payload->'settlement_entry'->'reversal' is null
      returning client_id, payload->'settlement_entry'->>'journal_id' as settlement_journal_id`,
    [
      firmId,
      documentId,
      JSON.stringify({
        needs_ledger_adjustment: true,
        detected_at: new Date().toISOString(),
        match_id: matchId || null
      })
    ]
  );
  const row = marked.rows[0];
  // The journal id is required (the audit is meaningless without it), and
  // requiring it also keeps a mocked/foreign row from reading as a detection.
  if (!row || !row.settlement_journal_id) return { lateBankLineDetected: false };
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'document.settlement_late_bank_line', 'document', $3, $4::jsonb)`,
    [
      firmId,
      row.client_id,
      documentId,
      JSON.stringify({
        settlement_journal_id: row.settlement_journal_id,
        match_id: matchId || null,
        needs_ledger_adjustment: true
      })
    ]
  );
  return { lateBankLineDetected: true };
};

// Late-bank-line guard, interactive drive half. The drain wiring
// (loopsShadowProducers) runs the reversal producer on every reconcile tick,
// but an INTERACTIVE confirm (manual link / patch) may be a client's last
// tick for a while — so the writers call this post-commit, scoped to the one
// document, only when detection fired. No-throw (a producer failure must
// never unwind or fail a confirm that already committed); dynamic import for
// cycle safety (firmDb ← documentSettlementReversal ← firmDb, the
// documentSettlementEntry precedent in the other direction).
const runSettlementReversalGuardAfterConfirm = async ({ client, firmId, clientId, documentId, detected }) => {
  if (!detected || !clientId || !documentId) return;
  try {
    const { runDocumentSettlementReversalsForClient } = await import('../documentSettlementReversal.js');
    await runDocumentSettlementReversalsForClient({
      client, firmId, clientId, documentIds: [String(documentId)]
    });
  } catch (error) {
    console.warn('[firmDb] late-bank-line reversal producer failed post-confirm (non-fatal)', {
      firmId, clientId, documentId, error: error?.message || String(error)
    });
  }
};

// #ask-reply-match — auto-link the bank line to the document a client
// uploaded as evidence, once a reply-recode has APPLIED on that reply.
//
// Why this exists: when a client answers an evidence request by uploading
// the requested document (a Shopify payout report, a settlement statement)
// the strong coder reads it and applies the coding — but no
// `reconciliation_match` row was ever created, so the artifact drawer fell
// to matchExplanation.js's coding-verdict branch (a verbose category
// re-justification with `documentFile: null`) instead of the rich
// "Matched to <vendor> <type> (<amount>)" branch. This helper creates that
// link so the match branch renders automatically — same surface as any
// doc-matched line.
//
// This is a STATE link, NOT a new model inference (CLAUDE.md trust-the-
// strong-LLM): the client already provided THIS document against THIS
// evidence request and the coder already decided to apply. We do not ask a
// model to "decide" the match.
//
// Status is `auto_matched`/`created_by='system'` — Donna did this
// autonomously off the client's evidence; it is NOT a firm confirmation,
// so we keep the manual-link's `confirmed`/`'firm'` semantics honest and
// distinct. Both statuses are in MEANINGFUL_MATCH_STATUSES and render
// `confident` via confidenceLevelForMatch, and both count terminal in the
// convergence SQL (parseDocumentsDb.js) — so this REDUCES hanging.
//
// Runs INSIDE the caller's already-open transaction (both recode paths
// hold one) — no nested begin/commit, no extra pool connection (the firm
// pool is small, max 2). Idempotent via the reconciliation_matches unique
// (bank_transaction_id, matched_object_type, matched_object_id) +
// ON CONFLICT DO NOTHING: the synchronous portal reply path and the
// post-parse batch coder can both fire for the same line (the sync path
// usually runs before the upload finishes parsing) without duplicating.
// Best-effort per document — the SQL throws propagate to the caller's
// transaction, but a no-op (conflict) is silent.
export const linkReplyEvidenceMatchesInDb = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  replyDocuments = [],
  evidenceRequestId = null,
  fallbackAmount = null,
  supersedesDocumentId = null
} = {}) => {
  const docs = (replyDocuments || []).filter((doc) => doc && doc.id);
  if (!clientId || !transactionId || !docs.length) return { created: 0, matchIds: [] };

  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const matchIds = [];
  let created = 0;

  for (const doc of docs) {
    const matchedObjectType = String(doc.document_type || 'document');
    const docAmount = Number(doc.total_amount);
    const hasAmount = Number.isFinite(docAmount);
    // The amount that settled the bank line. The matchHero prefers
    // match_amount over the doc total precisely because it is the settled
    // amount — and the evidence document here is often sparsely extracted
    // (a payout settlement with no captured total), so the bank line is the
    // reliable source. Parse defensively: `transaction.money_*` can arrive
    // as the string "0.00", which `x || y` would treat as truthy.
    const fallback = Number(fallbackAmount);
    const matchAmount = hasAmount ? docAmount : (Number.isFinite(fallback) ? fallback : 0);
    // The client was ASKED for this exact evidence and PROVIDED it — there is
    // no matcher uncertainty to express. This is a certain link (1.0), the
    // same confidence the manual firm link writes; status `auto_matched`
    // (not `confirmed`) is what keeps "Donna did it, not the firm" honest.
    const matchConfidence = 1;

    let hash = 0;
    const raw = `${clientId}|${transactionId}|${matchedObjectType}|${doc.id}`;
    for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    const matchId = `recon-${slug(clientId)}-${slug(transactionId)}-${slug(matchedObjectType)}-${slug(doc.id)}-${Math.abs(hash).toString(36)}`.slice(0, 118);

    const payload = {
      source: 'client_reply_evidence',
      evidence_request_id: evidenceRequestId || null,
      // Honest match_reason: the client supplied this exact document as
      // evidence — we do NOT claim an exact-amount match (these settle
      // cross-currency via payment processors; see CLAUDE.md Failure B).
      // buildVendorPhrase renders "linked to <vendor>" off the document.
      match_reason: {
        source: 'client_reply_evidence',
        basis: 'client_provided_evidence',
        hints: []
      }
    };

    const insertResult = await client.query(
      `insert into reconciliation_matches (
         id, firm_id, client_id, bank_transaction_id,
         matched_object_type, matched_object_id,
         match_amount, match_confidence, match_reason,
         status, created_by, payload
       ) values (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8, $9,
         'auto_matched', 'system', $10::jsonb
       )
       on conflict (bank_transaction_id, matched_object_type, matched_object_id) do nothing
       returning id`,
      [
        matchId,
        firmId,
        clientId,
        transactionId,
        matchedObjectType,
        doc.id,
        matchAmount,
        matchConfidence,
        'Linked to client-provided evidence document.',
        JSON.stringify(payload)
      ]
    );

    if (supersedesDocumentId && docs.length === 1 && doc.id !== supersedesDocumentId) {
      const ask=(await client.query(`select id from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3
        and transaction_id=$4 and evidence_type='document_discrepancy'`,[firmId,clientId,evidenceRequestId,transactionId])).rows[0];
      if(!ask || !Number.isFinite(Number(fallbackAmount)) || Math.round(docAmount*100)!==Math.round(Number(fallbackAmount)*100)) throw Object.assign(new Error('A corrected receipt must answer the exact discrepancy and cover the bank amount.'),{code:'CORRECTED_RECEIPT_SOURCE_INVALID'});
      const retired=await client.query(`update reconciliation_matches set status='rejected',payload=payload || $5::jsonb,updated_at=now()
        where firm_id=$1 and client_id=$2 and bank_transaction_id=$3 and matched_object_id=$4 and status='auto_matched' returning id`,
        [firmId,clientId,transactionId,supersedesDocumentId,JSON.stringify({source:'client_corrected_receipt',evidence_request_id:evidenceRequestId,replacement_document_id:doc.id})]);
      for(const row of retired.rows) await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
        values($1,$2,'system','owner_reply_recovery','reconciliation_match.corrected_receipt','reconciliation_match',$3,$4::jsonb)`,
        [firmId,clientId,row.id,JSON.stringify({evidence_request_id:evidenceRequestId,replacement_document_id:doc.id,authority_basis:'persisted_owner_corrected_document'})]);
    }
    if (!insertResult.rows.length) continue; // conflict — a prior path already linked it; idempotent no-op.
    created += 1;
    matchIds.push(matchId);

    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'reconciliation_match.auto_link', 'reconciliation_match', $3, $4::jsonb)`,
      [
        firmId,
        clientId,
        matchId,
        JSON.stringify({
          status: 'auto_matched',
          source: 'client_reply_evidence',
          bank_transaction_id: transactionId,
          matched_object_type: matchedObjectType,
          matched_object_id: doc.id,
          evidence_request_id: evidenceRequestId || null
        })
      ]
    );
  }

  return { created, matchIds };
};

// Test-only export so the harness can drive the auto-link writer with a
// mock pg client without going through the recode/batch seams.
export const __linkReplyEvidenceMatchesInDb = linkReplyEvidenceMatchesInDb;

// Crossed-suggestion retirement — the ONE contract both confirm paths honour
// (DMEM-R1 W4, ACC-C01). A `suggested` edge whose line or document a human
// has just settled elsewhere is dead, and a dead suggestion is consequential:
// it suppresses the evidence ask on its line (db/asks.js gathers skip any line
// with a suggested match). Each retired edge flips to 'rejected' inside the
// caller's transaction and gets its own `crossed_suggestion_retired` receipt.
// The CALLER picks which edges are crossed: the group pairing retires every
// leftover edge in its selected tx×doc universe; a single confirm retires
// only the edges whose shared endpoint the confirm actually consumed
// (crossedSuggestionIdsForConfirmWithClient).
export const retireCrossedSuggestionsWithClient = async ({
  client,
  firmId,
  clientId,
  matchIds,
  source,
  reviewerNote,
  actorId = null,
  confirmedMatchId = null
}) => {
  const ids = [...new Set((matchIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const retired = await client.query(
    `update reconciliation_matches
        set status = 'rejected',
            payload = payload || $4::jsonb,
            updated_at = now()
      where firm_id = $1 and client_id = $2
        and id = any($3::text[])
        and status = 'suggested'
    returning id, bank_transaction_id, matched_object_id`,
    [firmId, clientId, ids, JSON.stringify({ source, reviewer_note: reviewerNote })]
  );
  for (const match of retired.rows) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'firm', $3, 'reconciliation_match.update', 'reconciliation_match', $4, $5::jsonb)`,
      [
        firmId,
        clientId,
        actorId || 'system',
        match.id,
        JSON.stringify({
          status: 'rejected',
          source,
          reason: 'crossed_suggestion_retired',
          bank_transaction_id: match.bank_transaction_id,
          matched_object_id: match.matched_object_id,
          ...(confirmedMatchId ? { confirmed_match_id: confirmedMatchId } : {})
        })
      ]
    );
  }
  return retired.rows;
};

// Which suggested edges a single confirm of `matchId` crosses. Read AFTER the
// confirm's cascade (so documents.payment_status is the recomputed one), inside
// the same transaction. An edge is crossed only when the endpoint it shares
// with the confirmed edge is now consumed — never merely because it shares one:
//   - the DOCUMENT side: the document is now 'paid' (receipts always are after a
//     confirm; a sales invoice / supplier bill only once its settled sum covers
//     it, so an instalment or payout split keeps its other lines). A row-level
//     settlement (RT-21c matched_line_id) crosses only edges on that same row.
//   - the LINE side: the settled matches on the line carry amounts that cover
//     the line, so a payout bundling several invoices keeps its other documents.
//     An unknown amount is not proof of consumption — those edges stay.
export const crossedSuggestionIdsForConfirmWithClient = async ({ client, firmId, matchId }) => {
  const result = await client.query(
    `with c as (
       select id, client_id, bank_transaction_id, matched_object_type, matched_object_id, matched_line_id
         from reconciliation_matches
        where firm_id = $1 and id = $2
     ),
     line_settled as (
       select (bool_and(m.match_amount is not null)
               and coalesce(sum(abs(m.match_amount)), 0)
                   >= abs(coalesce(nullif(t.money_out, 0), t.money_in, 0)) - 0.005
               and abs(coalesce(nullif(t.money_out, 0), t.money_in, 0)) > 0) as consumed
         from c
         join transactions t on t.firm_id = $1 and t.id = c.bank_transaction_id
         join reconciliation_matches m
           on m.firm_id = $1 and m.bank_transaction_id = c.bank_transaction_id
          and m.status in ('confirmed', 'auto_matched')
        group by t.money_out, t.money_in
     ),
     doc_settled as (
       select d.payment_status = 'paid' as consumed
         from c
         join documents d on d.firm_id = $1 and d.id = c.matched_object_id
        where c.matched_object_type <> 'transfer'
     )
     select m.id
       from reconciliation_matches m, c
      where m.firm_id = $1 and m.client_id = c.client_id
        and m.id <> c.id
        and m.status = 'suggested'
        and (
          (m.bank_transaction_id = c.bank_transaction_id
            and coalesce((select consumed from line_settled), false))
          or (c.matched_object_type <> 'transfer'
            and m.matched_object_type = c.matched_object_type
            and m.matched_object_id = c.matched_object_id
            and m.bank_transaction_id <> c.bank_transaction_id
            and (case when c.matched_line_id is not null
                      then m.matched_line_id = c.matched_line_id
                      else m.matched_line_id is null
                           and coalesce((select consumed from doc_settled), false)
                 end))
        )
      order by m.id`,
    [firmId, matchId]
  );
  return result.rows.map((row) => row.id);
};

// Manual link-to-transaction — firm pairs a document with a bank
// transaction in one click when the matcher couldn't (or wouldn't).
//
// Writes a `reconciliation_matches` row at `status='confirmed'`,
// `created_by='firm'`, then runs the same cascade as
// `updateReconciliationMatchInDb` for the confirmed branch:
//   - transactions.reconciliation_status='reconciled' + reconciled_at
//   - documents.payment_status='paid'
//   - any open review-queue items for this tx → resolved
//   - one `reconciliation_match.update` audit (action name shared with
//     the existing endpoint so PR 5's learner picks it up unchanged)
//
// Idempotency / conflict semantics:
//   - If a match row already exists for (bank_transaction_id,
//     matched_object_type, document_id) and is `confirmed` or
//     `rejected`, return 409 — firm should use the existing PATCH
//     endpoint to update or reject explicitly.
//   - If one exists with `suggested` or `auto_matched`, UPSERT to
//     `confirmed` + `created_by='firm'` and run the cascade. Same
//     net effect as patching it via the existing endpoint plus a
//     `payload.source='firm_manual_link'` stamp.
//   - The unique constraint at `db/migrations/002:98` on
//     `(bank_transaction_id, matched_object_type, matched_object_id)`
//     keeps the upsert deterministic.
//
// `dbClient` optional override is for tests; production callers omit
// it and the pool client is borrowed via withFirmDbClient.
// `captureBeforeState: true` (the chat-apply callers) adds `before_state` /
// `after_state` to the return — the pod-safety #2 capture (see
// __matchBeforeAfter; a fresh link records match_status null → 'confirmed').
export const createManualReconciliationMatchInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  documentId,
  bankTransactionId,
  pairings = null,
  reviewerNote = null,
  actorId = null,
  captureBeforeState = false,
  dbClient = null,
  // Internal recursion controls for group mode. A group invokes this SAME
  // named writer once per selected pair on one shared transaction; these
  // controls prevent nested BEGIN/COMMIT and defer post-commit producers until
  // the whole group is durable.
  _transactionManagedExternally = false,
  _deferPostCommit = false
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  const groupMode = Array.isArray(pairings);
  const normalizedPairings = groupMode
    ? pairings.map((pair) => ({
        bankTransactionId: String(pair?.transaction_id || pair?.bankTransactionId || '').trim(),
        documentId: String(pair?.document_id || pair?.documentId || '').trim()
      }))
    : [];
  if (groupMode) {
    const txIds = normalizedPairings.map((pair) => pair.bankTransactionId);
    const docIds = normalizedPairings.map((pair) => pair.documentId);
    if (normalizedPairings.length < 2 || normalizedPairings.length > 20
        || txIds.some((id) => !id) || docIds.some((id) => !id)
        || new Set(txIds).size !== txIds.length
        || new Set(docIds).size !== docIds.length) {
      const error = new Error('pairings must contain 2-20 unique transaction/document pairs.');
      error.statusCode = 400;
      throw error;
    }
  }
  if (!groupMode && !documentId) {
    const error = new Error('document_id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!groupMode && !bankTransactionId) {
    const error = new Error('bank_transaction_id is required.');
    error.statusCode = 400;
    throw error;
  }

  const run = async (client) => {
    if (!_transactionManagedExternally) await client.query('begin');
    try {
      // 1. Verify document exists for this firm/client and grab the
      //    fields we need (document_type + total_amount drive the
      //    match row shape).
      const docResult = await client.query(
        `select id, document_type, total_amount, currency
           from documents
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, documentId]
      );
      if (!docResult.rows.length) {
        const error = new Error('Document not found for this firm/client.');
        error.statusCode = 404;
        throw error;
      }
      const document = docResult.rows[0];

      // 2. Verify transaction exists. reconciliation_status rides along as the
      //    pod-safety #2 pre-read (captured race-free inside this transaction).
      const txResult = await client.query(
        `select id, money_out, currency, reconciliation_status, money_in
           from transactions
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, bankTransactionId]
      );
      if (!txResult.rows.length) {
        const error = new Error('Transaction not found for this firm/client.');
        error.statusCode = 404;
        throw error;
      }

      // 3. matched_object_type reflects the document's own type when
      //    available — keeps the audit story consistent with the
      //    auto-match path. Falls back to 'document' for non-receipt
      //    document types (bill, invoice, …).
      const matchedObjectType = String(document.document_type || 'document');

      // 4. Look up any existing match on this (tx, type, doc) tuple.
      const priorResult = await client.query(
        `select id, status, created_by
           from reconciliation_matches
          where firm_id = $1 and client_id = $2
            and bank_transaction_id = $3
            and matched_object_type = $4
            and matched_object_id = $5`,
        [firmId, clientId, bankTransactionId, matchedObjectType, documentId]
      );
      const prior = priorResult.rows[0] || null;

      if (prior && (prior.status === 'confirmed' || prior.status === 'rejected')) {
        const error = new Error(`Match already exists with status '${prior.status}'. Use PATCH to update.`);
        error.statusCode = 409;
        throw error;
      }

      // RT-21c: a consolidated statement (settlement rows persisted by
      // RT-21b) is settled row by row. A human linking a bank line to such a
      // statement names no row, so the writer resolves it deterministically:
      // the single OPEN row whose net equals the bank line's amount. No such
      // row (or two) ⇒ a document-level confirm, as before, never a guess.
      const bankAmount = Number(txResult.rows[0].money_in) || Number(txResult.rows[0].money_out) || 0;
      const rowResult = await client.query(
        `select dl.id, dl.line_no, dl.amount, rm.bank_transaction_id as settled_by
           from document_lines dl
           left join reconciliation_matches rm
             on rm.matched_line_id = dl.id and rm.status in ('auto_matched', 'confirmed')
          where dl.firm_id = $1 and dl.document_id = $2
            and dl.payload->'raw_extraction'->'settlement_row' is not null
          order by dl.line_no asc`,
        [firmId, documentId]
      ).catch((error) => {
        if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
        throw error;
      });
      const openRowsAtAmount = (rowResult.rows || []).filter((row) =>
        (!row.settled_by || String(row.settled_by) === String(bankTransactionId))
        && Math.abs(Number(row.amount) - bankAmount) <= 0.01);
      const matchedLine = openRowsAtAmount.length === 1 ? openRowsAtAmount[0] : null;

      const matchAmount = matchedLine ? Number(matchedLine.amount) : Number(document.total_amount);
      const safeMatchAmount = Number.isFinite(matchAmount) ? matchAmount : Number(txResult.rows[0].money_out) || 0;

      const payload = {
        source: _transactionManagedExternally ? 'firm_group_pairing' : 'firm_manual_link',
        reviewer_note: reviewerNote || null,
        ...(matchedLine ? { settlement_row: { line_id: matchedLine.id, line_no: Number(matchedLine.line_no), net: Number(matchedLine.amount) } } : {})
      };

      let matchId;
      if (prior) {
        // UPSERT path — flip the existing suggested/auto_matched row to
        // confirmed + firm-created stamp.
        matchId = prior.id;
        await client.query(
          `update reconciliation_matches
              set status = 'confirmed',
                  created_by = 'firm',
                  match_amount = $3,
                  match_confidence = 1,
                  match_reason = $4,
                  payload = payload || $5::jsonb,
                  matched_line_id = coalesce(matched_line_id, $6),
                  updated_at = now()
            where firm_id = $1 and id = $2`,
          [firmId, prior.id, safeMatchAmount, 'Manually linked by firm reviewer.', JSON.stringify(payload), matchedLine ? matchedLine.id : null]
        );
      } else {
        // Fresh INSERT path — synthesize an id mirroring the
        // existing makeMatchId convention used elsewhere.
        const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
        let hash = 0;
        const raw = `${clientId}|${bankTransactionId}|${matchedObjectType}|${documentId}`;
        for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
        matchId = `recon-${slug(clientId)}-${slug(bankTransactionId)}-${slug(matchedObjectType)}-${slug(documentId)}-${Math.abs(hash).toString(36)}`.slice(0, 118);

        await client.query(
          `insert into reconciliation_matches (
             id, firm_id, client_id, bank_transaction_id,
             matched_object_type, matched_object_id,
             match_amount, match_confidence, match_reason,
             status, created_by, payload, matched_line_id
           ) values (
             $1, $2, $3, $4,
             $5, $6,
             $7, 1, 'Manually linked by firm reviewer.',
             'confirmed', 'firm', $8::jsonb, $9
           )`,
          [
            matchId,
            firmId,
            clientId,
            bankTransactionId,
            matchedObjectType,
            documentId,
            safeMatchAmount,
            JSON.stringify(payload),
            matchedLine ? matchedLine.id : null
          ]
        );
      }

      // 5. Cascade — mirrors updateReconciliationMatchInDb's confirmed
      //    branch. Predicate `is distinct from 'reconciled'` keeps
      //    this idempotent on re-runs.
      await client.query(
        `update transactions
            set reconciliation_status = 'reconciled',
                reconciled_at = coalesce(reconciled_at, now()),
                payload = payload || $3::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2`,
        [
          firmId,
          bankTransactionId,
          JSON.stringify({
            reconciliation_status: 'reconciled',
            reconciliation_match_id: matchId,
            reconciliation_match_type: matchedObjectType,
            reconciliation_match_object_id: documentId
          })
        ]
      );

      // PR 8 F2 — sales_invoice docs compute payment_status from the
      // sum of confirmed/auto_matched matches; receipts/bills keep the
      // 1:1 'paid' shortcut. The return carries the late-bank-line guard's
      // detection (an entry-settled doc just got a bank line confirmed).
      const paymentCascade = await applyDocumentPaymentStatusAfterMatch({
        client,
        firmId,
        matchId,
        matchedObjectType,
        documentId
      });

      // 6. Resolve any open transaction-review-queue items pointing at
      //    this transaction.
      await client.query(
        `update transaction_review_queue
            set status = 'resolved', updated_at = now()
          where firm_id = $1
            and client_id = $2
            and status = 'open'
            and (
              item_id = $3
              or payload->>'transaction_id' = $4
            )`,
        [firmId, clientId, matchId, bankTransactionId]
      );

      // 7. Audit. Reuses the existing action name so PR 5's learner
      //    consumes this audit alongside the auto-match-confirm path.
      //    `source: 'firm_manual_link'` discriminates in metadata.
      //    Pod-safety gap #1: actor_id records WHICH operator linked it
      //    (member email via the apply routes), never a bare 'system'
      //    when an authenticated principal drove the action.
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'firm', $3, 'reconciliation_match.update', 'reconciliation_match', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          actorId || 'system',
          matchId,
          JSON.stringify({
            status: 'confirmed',
            source: _transactionManagedExternally ? 'firm_group_pairing' : 'firm_manual_link',
            bank_transaction_id: bankTransactionId,
            matched_object_type: matchedObjectType,
            matched_object_id: documentId
          })
        ]
      );

      if (!_transactionManagedExternally) await client.query('commit');
      // Donna Loops Phase 7 producer (post-commit, no-throw, LOOPS_SHADOW-gated):
      // a confirmed manual link settles the target → resolve any open
      // reconciliation-gap blocker so the case lifts off the close dashboard.
      if (!_deferPostCommit) {
        await onReconciliationMatchConfirmed({
          client, firmId, clientId,
          matchedObjectType, matchedObjectId: documentId,
          bankTransactionId, status: 'confirmed'
        });
      }
      // Late-bank-line guard, drive half (post-commit, no-throw): an
      // interactive confirm may be the client's LAST tick for a while, so the
      // reversal producer runs scoped to this doc rather than waiting for the
      // next drain. Only when detection fired (entry-settled docs are rare —
      // keeps the extra pool borrow off the common path).
      if (!_deferPostCommit) {
        await runSettlementReversalGuardAfterConfirm({
          client, firmId, clientId, documentId, detected: paymentCascade?.lateBankLineDetected
        });
      }
      if (captureBeforeState) {
        const captured = {
          matchId,
          matchedObjectType,
          ...__matchBeforeAfter({
            matchId,
            prevMatchStatus: prior?.status ?? null,
            nextMatchStatus: 'confirmed',
            txReconciliationBefore: txResult.rows[0].reconciliation_status ?? null
          })
        };
        return _deferPostCommit
          ? { ...captured, __postCommit: { documentId, bankTransactionId, matchedObjectType, paymentCascade } }
          : captured;
      }
      const result = { matchId, matchedObjectType };
      return _deferPostCommit
        ? { ...result, __postCommit: { documentId, bankTransactionId, matchedObjectType, paymentCascade } }
        : result;
    } catch (error) {
      if (!_transactionManagedExternally) await client.query('rollback');
      throw error;
    }
  };

  const runGroup = async (client) => {
    await client.query('begin');
    try {
      const transactionIds = normalizedPairings.map((pair) => pair.bankTransactionId);
      const documentIds = normalizedPairings.map((pair) => pair.documentId);
      // A group proposal is valid only while none of its rows/documents has
      // reached a terminal match. This write-time re-read makes the complete
      // proposal stale as a unit instead of partially applying around a race.
      const terminal = await client.query(
        `select id, bank_transaction_id, matched_object_id, status
           from reconciliation_matches
          where firm_id = $1 and client_id = $2
            and (bank_transaction_id = any($3::text[])
                 or matched_object_id = any($4::text[]))
            and status in ('confirmed', 'auto_matched')
          for update`,
        [firmId, clientId, transactionIds, documentIds]
      );
      if (terminal.rows.length) {
        const error = new Error('The collision group changed after proposal; refresh before applying.');
        error.statusCode = 409;
        throw error;
      }

      const results = [];
      for (const pairing of normalizedPairings) {
        const result = await createManualReconciliationMatchInDb({
          firmId,
          clientId,
          documentId: pairing.documentId,
          bankTransactionId: pairing.bankTransactionId,
          reviewerNote: reviewerNote || 'Date-aligned collision group paired by firm reviewer.',
          actorId,
          captureBeforeState,
          dbClient: client,
          _transactionManagedExternally: true,
          _deferPostCommit: true
        });
        results.push({
          transaction_id: pairing.bankTransactionId,
          document_id: pairing.documentId,
          ...result
        });
      }

      // Every remaining suggested edge inside the selected tx×doc universe is
      // necessarily crossed: selected edges were promoted above. Retire them in
      // this same transaction so no stale suggestion survives either case.
      const crossed = await client.query(
        `select id
           from reconciliation_matches
          where firm_id = $1 and client_id = $2
            and bank_transaction_id = any($3::text[])
            and matched_object_id = any($4::text[])
            and status = 'suggested'
          order by id`,
        [firmId, clientId, transactionIds, documentIds]
      );
      const retired = {
        rows: await retireCrossedSuggestionsWithClient({
          client,
          firmId,
          clientId,
          matchIds: crossed.rows.map((row) => row.id),
          source: 'firm_group_pairing',
          reviewerNote: reviewerNote || 'Retired crossed suggestion during date-aligned group pairing.',
          actorId
        })
      };

      await client.query('commit');
      for (const result of results) {
        const postCommit = result.__postCommit;
        await onReconciliationMatchConfirmed({
          client,
          firmId,
          clientId,
          matchedObjectType: postCommit.matchedObjectType,
          matchedObjectId: postCommit.documentId,
          bankTransactionId: postCommit.bankTransactionId,
          status: 'confirmed'
        });
        await runSettlementReversalGuardAfterConfirm({
          client,
          firmId,
          clientId,
          documentId: postCommit.documentId,
          detected: postCommit.paymentCascade?.lateBankLineDetected
        });
      }
      const publicResults = results.map(({ __postCommit, ...result }) => result);
      return {
        results: publicResults,
        retiredMatches: retired.rows,
        before_after: publicResults
          .filter((result) => result.before_state && result.after_state)
          .map((result) => ({
            target: result.transaction_id,
            before: result.before_state,
            after: result.after_state
          }))
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  if (groupMode) {
    if (dbClient) return runGroup(dbClient);
    const result = await withFirmDbClient(runGroup);
    return { ...result, snapshot: await getFirmSnapshotFromDb({ firmId }) };
  }
  if (dbClient) return run(dbClient);
  const result = await withFirmDbClient(run);
  return { ...result, snapshot: await getFirmSnapshotFromDb({ firmId }) };
};

// Test-only export so the test harness can drive the writer with a
// mock pg client without going through the connection pool.
export const __createManualReconciliationMatchInDbWithClient = (args) =>
  createManualReconciliationMatchInDb({ ...args, dbClient: args.dbClient });

// `captureBeforeState: true` (the chat-apply callers) changes the return shape to
// `{ snapshot, before_state, after_state }` — the pod-safety #2 capture (see
// __matchBeforeAfter). `actorId` attributes the writer's own audit row (pod-safety
// #1); legacy callers omit both and are untouched. `returnSnapshot: false` (the
// reverse executor's batch apply) skips the firm-snapshot read on the capture
// return — mirrors updateTransactionReviewItemInDb's flag.
export const updateReconciliationMatchInDb = async ({ firmId = DEFAULT_FIRM_ID, matchId, patch = {}, actorId = 'system', captureBeforeState = false, returnSnapshot = true } = {}) => {
  if (!matchId) {
    const error = new Error('Reconciliation match id is required.');
    error.statusCode = 400;
    throw error;
  }

  const nextStatus = ['suggested', 'auto_matched', 'confirmed', 'rejected'].includes(String(patch.status || ''))
    ? String(patch.status)
    : null;
  if (!nextStatus) {
    const error = new Error('Valid reconciliation match status is required.');
    error.statusCode = 400;
    throw error;
  }

  const result = await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const existing = await client.query('select * from reconciliation_matches where firm_id = $1 and id = $2', [firmId, matchId]);
      if (!existing.rows.length) {
        const error = new Error('Reconciliation match not found.');
        error.statusCode = 404;
        throw error;
      }
      const match = existing.rows[0];
      const payload = { ...(match.payload || {}), reviewer_note: patch.reviewer_note || patch.note || null };
      // #5 Slice 3b — let an AUTHORITY confirm stamp a one-time authority_receipt
      // onto payload.authorization (§6) without clobbering the matcher's gate
      // receipt: shallow-merge into the existing authorization sub-object so the
      // band/gates/delegated_authority ride through and the human override is
      // additive. Backward compatible: callers that don't pass patch.authorization
      // (e.g. the PATCH /reconciliation-matches route) are unaffected.
      if (patch.authorization && typeof patch.authorization === 'object') {
        payload.authorization = { ...(payload.authorization || {}), ...patch.authorization };
      }
      const prevStatus = match.status;
      // A human confirm of a match held ONLY by the materiality ceiling is a
      // one-time authorisation of THIS line: stamp the receipt on the match so
      // the authority is reconstructable from the row. standing:false and no
      // grant — confirming never implies anything about future lines; that is
      // the separate, explicit "authorise future matches like this" grant.
      if (nextStatus === 'confirmed' && prevStatus === 'suggested' && delegationGateProof(match.payload?.authorization)) {
        payload.authorization = {
          ...(payload.authorization || {}),
          authority_receipt: {
            kind: 'one_time_confirm',
            standing: false,
            grant_id: null,
            confirmed_by: actorId || 'system',
            confirmed_at: new Date().toISOString()
          }
        };
      }
      // Late-bank-line guard detection (set by the confirm branch's cascade).
      let lateBankLineCascade = null;

      // Pod-safety #2: pre-read the transaction field this write's cascade mutates
      // so the before/after pair is captured race-free inside the same transaction.
      let txBefore = null;
      if (captureBeforeState && match.bank_transaction_id) {
        const txBeforeResult = await client.query(
          'select reconciliation_status from transactions where firm_id = $1 and id = $2',
          [firmId, match.bank_transaction_id]
        );
        txBefore = txBeforeResult.rows[0] || null;
      }

      await client.query(
        `update reconciliation_matches
         set status = $3, payload = $4::jsonb, updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, matchId, nextStatus, JSON.stringify(payload)]
      );

      if (nextStatus === 'confirmed' || nextStatus === 'auto_matched') {
        await client.query(
          `update transactions
           set reconciliation_status = 'reconciled',
               reconciled_at = coalesce(reconciled_at, now()),
               payload = payload || $3::jsonb,
               updated_at = now()
           where firm_id = $1 and id = $2`,
          [
            firmId,
            match.bank_transaction_id,
            JSON.stringify({
              reconciliation_status: 'reconciled',
              reconciliation_match_id: matchId,
              reconciliation_match_type: match.matched_object_type,
              reconciliation_match_object_id: match.matched_object_id
            })
          ]
        );

        if (match.matched_object_type !== 'transfer' && match.matched_object_id) {
          // PR 8 F2 — sales_invoice docs compute from the sum of
          // confirmed/auto_matched matches; non-AR docs keep the
          // 'paid' shortcut. See applyDocumentPaymentStatusAfterMatch.
          // The return carries the late-bank-line guard's detection.
          lateBankLineCascade = await applyDocumentPaymentStatusAfterMatch({
            client,
            firmId,
            matchId,
            matchedObjectType: match.matched_object_type,
            documentId: match.matched_object_id
          });
        }

        await client.query(
          `update transaction_review_queue
           set status = 'resolved', updated_at = now()
           where firm_id = $1
             and client_id = $2
             and status = 'open'
             and (
               item_id = $3
               or payload->>'transaction_id' = $4
             )`,
          [firmId, match.client_id, matchId, match.bank_transaction_id]
        );
      }

      // DMEM-R1 W4 (ACC-C01): a human confirm settles its line and document, so
      // the suggestions it crossed are dead — retire them here, in the confirm's
      // own transaction, under the same contract and receipt as the group
      // pairing. The other pairings (and splits the confirm did not consume)
      // stay live.
      if (nextStatus === 'confirmed') {
        await retireCrossedSuggestionsWithClient({
          client,
          firmId,
          clientId: match.client_id,
          matchIds: await crossedSuggestionIdsForConfirmWithClient({ client, firmId, matchId }),
          source: 'firm_single_confirm',
          reviewerNote: 'Retired crossed suggestion when another pairing was confirmed.',
          actorId,
          confirmedMatchId: matchId
        });
      }

      // A rejection — or a settled match demoted back to a suggestion (a
      // material document correction reopening it, FI-02) — leaves the line it
      // settled unsettled: the line no longer rests on this match.
      const demotedFromSettled = nextStatus === 'suggested' && (prevStatus === 'confirmed' || prevStatus === 'auto_matched');
      if (nextStatus === 'rejected' || demotedFromSettled) {
        await client.query(
          `update transactions
           set reconciliation_status = 'needs_review',
               payload = payload || $3::jsonb,
               updated_at = now()
           where firm_id = $1 and id = $2`,
          [firmId, match.bank_transaction_id, JSON.stringify({ reconciliation_status: 'needs_review' })]
        );
      }

      // PR 8 F2 / PR 9 — sum-based "revert on un-confirm". When a
      // match that was previously contributing to a settled sum
      // leaves the confirmed/auto_matched set, the document's
      // payment_status must drop accordingly (paid → partial or
      // partial → unpaid). Sales invoices and supplier bills both
      // need this because both compute payment_status from the sum
      // of confirmed matches. Receipts keep the legacy shortcut so
      // they're not in scope here.
      const wasSettled = prevStatus === 'confirmed' || prevStatus === 'auto_matched';
      const stillSettled = nextStatus === 'confirmed' || nextStatus === 'auto_matched';
      // RT-27 — a human "no" on a settlement that carried credit-note
      // applications frees those credits (status 'reversed', receipted) and the
      // credit note returns to the drain; the recompute below then drops them
      // from the invoice's settled sum. A human decision outranks the matcher.
      if (wasSettled && !stillSettled) {
        await reverseCreditApplicationsForMatch({
          client, firmId, matchId, reason: `match_${nextStatus}`, actorId: actorId || 'system'
        });
        if (match.payload?.reminder_obligation?.status === 'applied') await reverseReminderSettlementWithClient({
          client,firmId,matchId,reason:`match_${nextStatus}`,actorId:actorId || 'system'
        });
      }
      if (
        wasSettled &&
        !stillSettled &&
        SUM_BASED_PAYMENT_STATUS_TYPES.has(match.matched_object_type) &&
        match.matched_object_id
      ) {
        await applyDocumentPaymentStatusAfterMatch({
          client,
          firmId,
          matchId,
          matchedObjectType: match.matched_object_type,
          documentId: match.matched_object_id
        });
      }

      // Cross-entity learning (Kari's dated go, 2026-08-25): a human CONFIRM of
      // a match the intake guard capped is the owner vouching that paper bearing
      // the document's own-side name belongs in this book — record it so the
      // guard aligns on this book's future paper (crossEntityGuard.js). Same
      // transaction as the accept: a failed learning write fails the accept
      // loudly rather than committing silently-partial state.
      if (nextStatus === 'confirmed' && match.payload?.cross_entity?.detected && match.payload?.cross_entity?.own_side) {
        await recordAcceptedEntityNameWithClient(client, {
          firmId,
          clientId: match.client_id,
          ownSideName: match.payload.cross_entity.own_side,
          actorId: actorId || 'system',
          matchId
        });
      }

      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'reconciliation_match.update', 'reconciliation_match', $4, $5::jsonb)`,
        [firmId, match.client_id, actorId || 'system', matchId, JSON.stringify({ status: nextStatus })]
      );

      await client.query('commit');
      // Donna Loops Phase 7 producer (post-commit, no-throw, LOOPS_SHADOW-gated):
      // when this patch settles the match (confirmed / auto_matched), resolve any
      // open reconciliation-gap blocker for the target. The hook itself ignores
      // non-settling statuses (suggested / rejected).
      await onReconciliationMatchConfirmed({
        client, firmId, clientId: match.client_id,
        matchedObjectType: match.matched_object_type, matchedObjectId: match.matched_object_id,
        bankTransactionId: match.bank_transaction_id, status: nextStatus
      });
      // Late-bank-line guard, drive half (post-commit, no-throw): see the
      // manual-link writer's twin call for why the interactive path drives the
      // reversal producer itself instead of waiting for the next drain tick.
      await runSettlementReversalGuardAfterConfirm({
        client, firmId, clientId: match.client_id,
        documentId: match.matched_object_id,
        detected: lateBankLineCascade?.lateBankLineDetected
      });
      // Donna Loops Phase 8 producer (§13.10): the OPPOSITE transition — rejecting a
      // previously settled match (wasSettled) is a goal REGRESSION (INV-4 reversed),
      // so enqueue a `goal.regressed` outbox row for the case it resolved. The hook
      // self-filters on (status='rejected' && wasSettled); the dispatcher decides the
      // reopen against the case's current goal report.
      await onReconciliationMatchRejected({
        client, firmId, clientId: match.client_id, matchId,
        matchedObjectType: match.matched_object_type, matchedObjectId: match.matched_object_id,
        bankTransactionId: match.bank_transaction_id, status: nextStatus, wasSettled
      });
      // #5 Slice 5 — auto-suspend-on-correction (producer side). When this patch
      // is a human UNDOING a delegated-authority auto-accept (a settled match a
      // grant accepted, now rejected or demoted off the settled set), bump the
      // covering grant's correction_count and suspend it BEFORE its next use, so
      // the next findActiveAuthorityGrant fails closed. The grant id is read off
      // the prior PERSISTED receipt (delegatedAuthorityGrantId), never re-derived.
      // Post-commit + no-throw, like the loops producers above: a suspend failure
      // must never unwind a correction that already committed.
      if (wasSettled && !stillSettled) {
        const correctedGrantId = delegatedAuthorityGrantId(match.payload?.authorization);
        if (correctedGrantId) {
          try {
            await suspendGrantAfterCorrection({
              client,
              firmId,
              grantId: correctedGrantId,
              matchId,
              reason: nextStatus === 'rejected' ? 'match_rejected' : 'match_demoted'
            });
          } catch (suspendErr) {
            console.warn(
              '[updateReconciliationMatchInDb] delegated-authority grant auto-suspend failed (non-fatal)',
              { firmId, matchId, grantId: correctedGrantId, error: suspendErr?.message || suspendErr }
            );
          }
        }
      }
      if (captureBeforeState) {
        return {
          ...__matchBeforeAfter({
            matchId,
            prevMatchStatus: prevStatus,
            nextMatchStatus: nextStatus,
            txReconciliationBefore: txBefore?.reconciliation_status ?? null
          })
        };
      }
      return null;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
  // Response projection borrows from the pool only after the mutation checkout
  // and its convergence-release hook have completed.
  const snapshot = (!captureBeforeState || returnSnapshot) ? await getFirmSnapshotFromDb({ firmId }) : null;
  return captureBeforeState ? { snapshot, ...result } : snapshot;
};

// Pod-safety #2 capture, match-writer leg: the compact before/after of exactly the
// fields a reconciliation-match write mutates — the match row's status plus the bank
// transaction's reconciliation_status, with the after mirroring the writer's own
// branch semantics (confirmed/auto_matched ⇒ 'reconciled', rejected ⇒ 'needs_review',
// suggested ⇒ unchanged) so the recorded after IS what the update wrote. The
// document's payment_status is deliberately NOT captured: it is DERIVED
// (applyDocumentPaymentStatusAfterMatch recomputes it from the confirmed-match sum on
// every transition), so a match reverse restores it by cascade, not from the record.
// `target` for these rows is the bank transaction id (the #729 doctrine). The reverse
// EXECUTOR's match leg (reverseExecutor.planMatchReverseForRow → the pure builder
// reversePatch.matchReversePatchFromBeforeAfter) restores these rows through
// updateReconciliationMatchInDb — this shape is its input contract. Pure;
// exported for tests.
export const __matchBeforeAfter = ({
  matchId = null,
  prevMatchStatus = null,
  nextMatchStatus = null,
  txReconciliationBefore = null
} = {}) => {
  const settled = nextMatchStatus === 'confirmed' || nextMatchStatus === 'auto_matched';
  const demotedFromSettled = nextMatchStatus === 'suggested'
    && (prevMatchStatus === 'confirmed' || prevMatchStatus === 'auto_matched');
  const afterReconciliation = settled
    ? 'reconciled'
    : nextMatchStatus === 'rejected' || demotedFromSettled
      ? 'needs_review'
      : txReconciliationBefore;
  return {
    before_state: {
      match_id: matchId,
      match_status: prevMatchStatus,
      transaction: { reconciliation_status: txReconciliationBefore }
    },
    after_state: {
      match_id: matchId,
      match_status: nextMatchStatus,
      transaction: { reconciliation_status: afterReconciliation }
    }
  };
};
