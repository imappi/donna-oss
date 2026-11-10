// server/donna/db/transactions.js — plane S — transaction rows: the DTO projection, the accounting-mutability guard, the transaction-intel refresh, the transaction update writer.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { analyzeTransactionIntel, normalizeIntelText } from '../transactionIntel.js';
import { toIsoDay } from '../dates.js';
// Q9 (the sole-model lab, 2026-08-16): the coding lane's model-policy
// resolution — same pattern as the disposition sweep owner (Q6c).
import { readLaneDecidingPolicy } from '../modelLanePolicy.js';
import { readClientConfigSnapshot } from '../clientConfig.js';
import { firstLineLaneDecides } from '../firstLineLane.js';
// RT-16 — the ONE coding state (transactions.coding_state, migration 138):
// the machine, the legacy-input mapping, the DTO projection, the writer.
import { applyCodingTransition, codingStateClosesReviewCase, isAppliedSuggestionReceipt, legacyReviewStateFor, nextCodingStateForPatch } from '../codingState.js';
import { enrichCodingWithXeroAccount } from '../xeroAccountMatcher.js';

import { queryFirmDb, withFirmDbClient } from './pool.js';
import { buildMultiRowValues, chunk, MULTI_ROW_CHUNK_SIZE, numberOrNull } from './shared.js';
import { DEFAULT_FIRM_ID, getClientJurisdictionForEnrichment } from './clients.js';
import { loadActiveClientRulesForAuthority, saveMerchantRuleForPayload } from './memory.js';
import { rowToDocumentPayload } from './documents.js';
import { fallbackSupportNoteForSuggestion, isIntercompanyAccount } from './coding.js';
import { resolveOpenEvidenceRequestsForTransaction } from './asks.js';
import { getXeroAccountsForClient } from './xero.js';
import { getFirmSnapshotFromDb } from './snapshot.js';
import { nativeReviewFocalChanged } from './codingEvidence.js';
import { assertNoReviewScopePatch } from '../reviewItem.js';

export const amountForPayload = (transaction = {}) => Number(transaction.money_in || transaction.money_out || transaction.amount || 0);

export const directionForPayload = (transaction = {}) => {
  if (Number(transaction.money_in || 0) > 0) return 'money_in';
  if (Number(transaction.money_out || 0) > 0) return 'money_out';
  return 'unknown';
};

export const rowToTransactionPayload = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  client_id: row.client_id,
  document_id: row.document_id,
  // toIsoDay, never the raw pg Date: a `date` column serializes to a
  // local-midnight UTC instant on a non-UTC host, shifting the calendar
  // day for every downstream slice/regex consumer (the January-in-December
  // stage-C canary sighting, 2026-08-26).
  date: row.transaction_date ? toIsoDay(row.transaction_date) : row.payload?.date,
  description: row.description || row.payload?.description,
  money_in: Number(row.money_in || 0),
  money_out: Number(row.money_out || 0),
  // Canonical currency, including a correction to unknown, outranks historical
  // candidates whether or not the old extraction carried a policy receipt.
  currency: Object.hasOwn(row, 'currency') ? row.currency
    : row.payload?.currency_resolution ? row.payload.currency_resolution.currency ?? null
      : row.payload?.currency,
  account_currency: Object.hasOwn(row, 'currency') ? row.currency
    : row.payload?.currency_resolution ? row.payload.currency_resolution.currency ?? null
      : row.payload?.account_currency || row.payload?.currency,
  status: row.status,
  external_transaction_id: row.external_transaction_id || row.payload?.external_transaction_id,
  raw_description: row.raw_description || row.payload?.raw_description,
  ...(Object.hasOwn(row, 'structured_reference')
    ? { structured_reference: row.structured_reference } : {}),
  cleaned_description: row.cleaned_description || row.payload?.cleaned_description,
  merchant_id: row.merchant_id || row.payload?.merchant_id,
  direction: row.direction || row.payload?.direction,
  category: row.category || row.payload?.category,
  account_code: row.account_code || row.payload?.account_code,
  confidence_score: row.confidence_score == null ? row.payload?.confidence_score : Number(row.confidence_score),
  reconciliation_status: row.reconciliation_status || row.payload?.reconciliation_status,
  // RT-16 — the ONE coding state and its projected legacy label (the DTO
  // contract src/lib/review-state.js reads). The column outranks any label
  // the payload spread may still carry; a row read without the column (an
  // in-memory fixture) keeps whatever it had.
  ...(row.coding_state !== undefined
    ? { coding_state: row.coding_state ?? null, review_state: legacyReviewStateFor(row.coding_state) ?? undefined }
    : {}),
  // RT-17 PR 8 — the persisted two-terminal verdict (RT-13, migration 137)
  // rides the DTO whenever the row was read with the column, so every
  // reader renders what the writers persisted and none re-derives it. A row
  // read without the column (an in-memory fixture) carries nothing.
  ...(row.convergence_state !== undefined
    ? { convergence_state: row.convergence_state ?? null, convergence_reason: row.convergence_reason ?? null }
    : {}),
  created_at: row.created_at ? new Date(row.created_at).getTime() : row.payload?.created_at,
  updated_at: row.updated_at ? new Date(row.updated_at).getTime() : row.payload?.updated_at
});

const TRANSACTION_ACCOUNTING_MUTATION_KEYS = new Set([
  'date',
  'transaction_date',
  'transactionDate',
  'description',
  'money_in',
  'money_out',
  'amount',
  'currency',
  'account_currency',
  'status',
  'reconciliation_status',
  'account_code',
  'proposed_account',
  'account_name',
  'account_label',
  'xero_account_id',
  'xero_account_code',
  'xero_account_name',
  'xero_tax_type',
  'tax_type',
  'tax_treatment',
  'tax_posting_facts',
  'category',
  'review_state',
  'reviewState',
  'coding_state',
  'codingState',
  'ai_suggestion_status'
]);

const patchTouchesTransactionAccounting = (patch = {}) =>
  Object.keys(patch || {}).some((key) => TRANSACTION_ACCOUNTING_MUTATION_KEYS.has(key));

export const assertTransactionAccountingMutable = async ({ client, firmId, transactionId, patch = {} } = {}) => {
  if (!patchTouchesTransactionAccounting(patch)) return;
  const result = await client.query(
    `select t.id, t.client_id, t.transaction_date, t.payload, t.coding_state, cp.id as close_period_id
     from transactions t
     left join close_periods cp
       on cp.firm_id = t.firm_id
      and cp.client_id = t.client_id
      and cp.status = 'locked'
      and t.transaction_date >= cp.period_start
      and t.transaction_date <= cp.period_end
     where t.firm_id = $1
       and t.id = $2
     limit 1`,
    [firmId, transactionId]
  );
  const row = result.rows[0];
  if (row?.close_period_id && (row.payload?.ledger_journal_id || row.payload?.ledger_status === 'posted' || row.coding_state === 'posted')) {
    const error = new Error('Transaction belongs to a locked close period. Use a ledger adjustment instead of editing accounting fields.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_TRANSACTION_IMMUTABLE';
    throw error;
  }
};

// The firm's word on whether a document is still owed for a line.
// Writes into payload.ai_suggestion.evidence_required — the SAME key
// the #378 "Waiting evidence" pill and the auto-apply gates read, so
// there is exactly one evidence verdict per row (render the persisted
// verdict, not a parallel field). Provenance keys make the human
// override distinguishable from the model's own judgment. Creates an
// ai_suggestion object when the row never had a verdict (a human
// "invoice to follow" on an uncoded row is still a real state).
export const setTransactionAiEvidenceRequiredInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  evidenceRequired,
  source = 'feed_chat',
  actorId = 'system'
} = {}) => {
  if (!clientId || !transactionId || typeof evidenceRequired !== 'boolean') {
    const error = new Error('client_id, transaction_id, and a boolean evidenceRequired are required.');
    error.statusCode = 400;
    throw error;
  }
  const stamp = {
    evidence_required: evidenceRequired,
    evidence_required_source: source,
    evidence_required_set_at: Date.now()
  };
  const result = await queryFirmDb(
    `update transactions
        set payload = jsonb_set(
              payload,
              '{ai_suggestion}',
              coalesce(payload->'ai_suggestion', '{}'::jsonb) || $4::jsonb,
              true
            ),
            updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3
      returning id`,
    [firmId, clientId, transactionId, JSON.stringify(stamp)]
  );
  if (!result.rows.length) {
    const error = new Error('Transaction not found for this firm/client.');
    error.statusCode = 404;
    throw error;
  }
  // Pod-safety #1: the audit records WHICH operator stamped the flag (the
  // spine-attributed actorId threads through the feed-chat dispatcher), never
  // an actor-less row.
  await queryFirmDb(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm', $3, 'transaction.evidence_required.set', 'transaction', $4, $5::jsonb)`,
    [firmId, clientId, actorId || 'system', transactionId, JSON.stringify({ evidence_required: evidenceRequired, source })]
  );
  return { transaction_id: transactionId, evidence_required: evidenceRequired };
};

// Step-aside (2026-08-17, Kari's dated go): the reconcile-lane SEATS that
// displace transaction_intel's settling and match-writing. An ACTIVE
// model_lane_policy row for either lane covering (firm, client) — client-
// specific or firm-wide (client_id null) — means a governed model lane owns
// disposition/matching for this book: intel keeps enrichment but stamps no
// statuses and writes no reconciliation_matches rows (transfer pairs
// included). The seat itself is the gate — no env flag; books with no
// policy rows are byte-identical (readLaneDecidingPolicy fail-closed:
// missing table or no active row ⇒ null ⇒ legacy behavior). A policy
// seating the lane's strong default still counts: the governed lane is
// running either way, and racing it is the bug (the 2026-08-16 INTUIT QBO
// sighting).
const INTEL_STEP_ASIDE_LANES = ['bank_line_disposition', 'reconciliation_reasoning'];
export const TRANSACTION_INTEL_STEPPED_ASIDE_ACTION = 'transaction_intel.stepped_aside';

const readIntelStepAsideSeats = async (client, { firmId, clientId }) => {
  const seats = [];
  for (const laneId of INTEL_STEP_ASIDE_LANES) {
    const policy = await readLaneDecidingPolicy({ client, firmId, clientId, laneId });
    if (policy?.deciding_model) {
      seats.push({ lane: laneId, deciding_model: policy.deciding_model, basis: policy.basis || null });
    }
  }
  return seats;
};

export const refreshTransactionIntelForClient = async ({ client, firmId, clientId, retireSuggestedResidueOnly = false, retirementAuthority = null }) => {
  // Prepared hosted pilot re-enrollment: use this writer's existing namespace
  // retirement without re-enriching a populated book. Never reinterpret a
  // settled/human/governed match or change coding, asks, or journal rows.
  if (retireSuggestedResidueOnly) {
    const seats = await readIntelStepAsideSeats(client, { firmId, clientId });
    if (!seats.length) throw Object.assign(new Error('A governed reconcile lane must own this book before legacy suggestions retire.'), { code: 'INTEL_GOVERNED_LANE_REQUIRED' });
    const authority = retirementAuthority;
    const staged = authority?.actorId && authority?.receiptId && authority?.reviewDigest ? await client.query(`select 1 from audit_events
      where id=$1 and firm_id=$2 and client_id=$3 and actor_type='firm_member' and actor_id=$4
        and action='pilot.processing.staged' and resource_type='client' and resource_id=$3
        and metadata->>'review_digest'=$5
        and metadata->>'authority_basis'='active_member_confirmed_exact_client_configuration'`,
      [authority.receiptId,firmId,clientId,authority.actorId,authority.reviewDigest]) : {rowCount:0};
    if (!staged.rowCount) throw Object.assign(new Error('Legacy suggestion retirement requires the member processing review receipt.'), {code:'INTEL_RETIREMENT_AUTHORITY_REQUIRED'});
    // Lock parents before a fresh statement checks their children. FK inserts
    // take key-share locks, so no committed child can race into a cascade.
    const lockedMatches = await client.query(`select id from reconciliation_matches
      where firm_id=$1 and client_id=$2 and created_by='system' and status='suggested'
        and payload->>'source'='transaction_intel'
        and (payload->'authorization' is null or payload->'authorization'='null'::jsonb)
      for update`, [firmId,clientId]);
    const retired = await client.query(`delete from reconciliation_matches m
      where firm_id=$1 and client_id=$2 and created_by='system' and status='suggested'
        and id=any($3::text[])
        and payload->>'source'='transaction_intel'
        and (payload->'authorization' is null or payload->'authorization'='null'::jsonb)
        and not exists(select 1 from reconciliation_authorization_requests auth_ref where auth_ref.match_id=m.id)
        and not exists(select 1 from document_credit_applications credit_ref where credit_ref.settlement_match_id=m.id)
      returning id,bank_transaction_id`, [firmId,clientId,lockedMatches.rows.map(row=>row.id)]);
    const ids = [...new Set(retired.rows.map(row => row.bank_transaction_id))];
    const lockedReviews = ids.length ? await client.query(`select id from transaction_review_queue
      where firm_id=$1 and client_id=$2 and status='open' and payload->>'source'='transaction_intel'
        and coalesce(payload->>'transaction_id',item_id)=any($3::text[]) for update`, [firmId,clientId,ids]) : {rows:[]};
    const reviews = ids.length ? await client.query(`delete from transaction_review_queue q
      where firm_id=$1 and client_id=$2 and status='open' and payload->>'source'='transaction_intel'
        and coalesce(payload->>'transaction_id',item_id)=any($3::text[])
        and id=any($4::text[])
        and not exists(select 1 from client_evidence_requests a where a.review_item_id=q.id)`, [firmId,clientId,ids,lockedReviews.rows.map(row=>row.id)]) : { rowCount:0 };
    if (retired.rowCount) await client.query(`insert into audit_events
      (firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'firm_member',$3,$4,'client',$2,$5::jsonb)`,
      [firmId,clientId,authority.actorId,TRANSACTION_INTEL_STEPPED_ASIDE_ACTION,JSON.stringify({
        mode:'suggested_residue_only',seats,lines_enriched:0,
        processing_receipt_id:authority.receiptId,review_digest:authority.reviewDigest,
        authority_basis:'active_member_confirmed_exact_client_configuration',
        stale_intel_matches_cleared:retired.rowCount,stale_intel_review_items_cleared:reviews.rowCount,
        retired_match_ids:retired.rows.map(row=>row.id),transaction_ids:ids
      })]);
    return { mode:'suggested_residue_only',retired_matches:retired.rowCount,retired_reviews:reviews.rowCount };
  }

  const documentsResult = await client.query('select * from documents where firm_id = $1 and client_id = $2', [firmId, clientId]);
  const transactionsResult = await client.query('select * from transactions where firm_id = $1 and client_id = $2', [firmId, clientId]);
  // W1 (S09/L2): the ONE read boundary — with MEMORY_LEGACY_AI_RULE_DEMOTION
  // acting, legacy model-minted active rules are not deterministic authority for
  // the intel refresh (they never stamp rule_explained / matched_client_rule_id).
  const { authoritative: activeClientRules } = await loadActiveClientRulesForAuthority({ client, firmId, clientId });
  const clientRulesResult = { rows: activeClientRules };
  const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
  const transactionById = new Map(transactionsResult.rows.map((row) => [row.id, rowToTransactionPayload(row)]));

  // 0A.10 — resolve the per-run config snapshot here (the db client is in scope)
  // and thread it into the pure analyzer, so transaction_intel's inline auto-match
  // canary is config-plane-aware without the module reading the db itself (it stays
  // dependency-free to avoid the firmDb import cycle). Soft-fails to {} ⇒ env fallback.
  const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });

  const stepAsideSeats = await readIntelStepAsideSeats(client, { firmId, clientId });
  const jevFirst = firstLineLaneDecides({ snapshot: configSnapshot });
  const stepAside = jevFirst || stepAsideSeats.length > 0;

  const analysis = analyzeTransactionIntel({
    firmId,
    documents: documentsResult.rows.map(rowToDocumentPayload),
    transactions: transactionsResult.rows.map(rowToTransactionPayload),
    clientRules: clientRulesResult.rows,
    configSnapshot,
    stepAside
  });

  if (!analysis.transactionPatches.length) return analysis;

  // Reconciliation PR 1 — narrow the DELETE to the legacy namespace
  // only, so receipt_reconciliation candidates (PR 1's namespace) and
  // any future namespaces survive this sweep. Null-source rows are
  // pre-PR-1 legacy inserts and are treated as 'transaction_intel'
  // via the coalesce default — no backfill SQL needed. In step-aside
  // mode the DELETEs still run (nothing re-inserts behind them): intel's
  // undecided residue clears so the governed lanes re-decide those
  // lines and the scoreboard's per-writer count converges to zero
  // intel rows. Firm decisions (confirmed/rejected) survive as before.
  const staleIntelMatches = await client.query(
    `delete from reconciliation_matches
     where firm_id = $1
       and client_id = $2
       and created_by = 'system'
       and status in ('suggested', 'auto_matched')
       and coalesce(payload->>'source', 'transaction_intel') = 'transaction_intel'`,
    [firmId, clientId]
  );
  const staleIntelReviewItems = await client.query(
    `delete from transaction_review_queue
     where firm_id = $1
       and client_id = $2
       and status = 'open'
       and payload->>'source' = 'transaction_intel'`,
    [firmId, clientId]
  );

  // Batched writes. Each of these loops used to make one DB round-trip
  // per row; for a fresh statement upload yielding hundreds of patches /
  // matches / review items that alone pushed the parent /documents/sync
  // call past the Vercel gateway timeout. One chunked statement per
  // collection keeps the same transactional semantics.
  const enrichmentJurisdiction = await getClientJurisdictionForEnrichment({ client, firmId, clientId });
  const enrichedPatches = analysis.transactionPatches.map((rawPatch) =>
    enrichCodingWithXeroAccount({
      coding: rawPatch,
      transaction: transactionById.get(rawPatch.id) || rawPatch,
      xeroAccounts,
      jurisdiction: enrichmentJurisdiction
    })
  );
  if (stepAside) {
    // Enrichment-only write: no reconciliation_status column, no status
    // flip, no reconciled_at stamp — the governed lanes own settling. The
    // payload merge carries the enrichment keys plus the provenance
    // marker and deliberately OMITS reconciliation_status/support_status/
    // support_note (merging nulls would clobber keys a governed writer
    // may have set).
    const enrichmentPatchValueFn = (patch) => [
      patch.id,
      patch.raw_description,
      patch.cleaned_description,
      patch.direction,
      patch.category,
      patch.account_code,
      patch.confidence_score,
      JSON.stringify({
        raw_description: patch.raw_description,
        cleaned_description: patch.cleaned_description,
        direction: patch.direction,
        category: patch.category,
        account_code: patch.account_code,
        confidence_score: patch.confidence_score,
        matched_client_rule_id: patch.matched_client_rule_id || undefined,
        matched_client_rule_label: patch.matched_client_rule_label || undefined,
        tax_treatment: patch.tax_treatment || undefined,
        account_name: patch.account_name || undefined,
        account_label: patch.account_label || undefined,
        xero_account_id: patch.xero_account_id || undefined,
        xero_account_code: patch.xero_account_code || undefined,
        xero_account_name: patch.xero_account_name || undefined,
        xero_account_type: patch.xero_account_type || undefined,
        xero_tax_type: patch.xero_tax_type || undefined,
        xero_account_match_status: patch.xero_account_match_status || undefined,
        contact: patch.contact || undefined,
        proposed_account: patch.proposed_account || patch.account_code || undefined,
        conversion_detail: patch.conversion_detail || undefined,
        intel_provenance: patch.intel_provenance || 'transaction_intel:enrichment_only'
      })
    ];
    const enrichmentColumnCasts = ['::text', '::text', '::text', '::text', '::text', '::text', '::numeric', '::jsonb'];
    for (const batch of chunk(enrichedPatches, MULTI_ROW_CHUNK_SIZE)) {
      if (!batch.length) continue;
      const { sql, params } = buildMultiRowValues(batch, enrichmentPatchValueFn, enrichmentColumnCasts);
      const firmIdParamIndex = params.length + 1;
      params.push(firmId);
      await client.query(
        `update transactions as t
         set raw_description = v.raw_description,
             cleaned_description = v.cleaned_description,
             direction = v.direction,
             category = v.category,
             account_code = v.account_code,
             confidence_score = v.confidence_score,
             payload = t.payload || v.patch_payload,
             updated_at = now()
         from (values ${sql})
           as v(id, raw_description, cleaned_description, direction, category, account_code,
                confidence_score, patch_payload)
         where t.firm_id = $${firmIdParamIndex} and t.id = v.id`,
        params
      );
    }
  } else {
  const patchValueFn = (patch) => [
    patch.id,
    patch.raw_description,
    patch.cleaned_description,
    patch.direction,
    patch.category,
    patch.account_code,
    patch.confidence_score,
    patch.reconciliation_status,
    JSON.stringify({
      raw_description: patch.raw_description,
      cleaned_description: patch.cleaned_description,
      direction: patch.direction,
      category: patch.category,
      account_code: patch.account_code,
      confidence_score: patch.confidence_score,
      reconciliation_status: patch.reconciliation_status,
      support_status: patch.support_status || undefined,
      support_note: patch.support_note || undefined,
      matched_client_rule_id: patch.matched_client_rule_id || undefined,
      matched_client_rule_label: patch.matched_client_rule_label || undefined,
      tax_treatment: patch.tax_treatment || undefined,
      account_name: patch.account_name || undefined,
      account_label: patch.account_label || undefined,
      xero_account_id: patch.xero_account_id || undefined,
      xero_account_code: patch.xero_account_code || undefined,
      xero_account_name: patch.xero_account_name || undefined,
      xero_account_type: patch.xero_account_type || undefined,
      xero_tax_type: patch.xero_tax_type || undefined,
      xero_account_match_status: patch.xero_account_match_status || undefined,
      contact: patch.contact || undefined,
      proposed_account: patch.proposed_account || patch.account_code || undefined,
      conversion_detail: patch.conversion_detail || undefined
    })
  ];
  // text-typed casts on the VALUES placeholders so Postgres can resolve
  // the column types without each tuple's NULLs being treated as
  // unknown. The trailing ::jsonb mirrors the original single-row cast.
  const patchColumnCasts = ['::text', '::text', '::text', '::text', '::text', '::text', '::numeric', '::text', '::jsonb'];
  for (const batch of chunk(enrichedPatches, MULTI_ROW_CHUNK_SIZE)) {
    if (!batch.length) continue;
    const { sql, params } = buildMultiRowValues(batch, patchValueFn, patchColumnCasts);
    const firmIdParamIndex = params.length + 1;
    params.push(firmId);
    await client.query(
      `update transactions as t
       set raw_description = v.raw_description,
           cleaned_description = v.cleaned_description,
           direction = v.direction,
           category = v.category,
           account_code = v.account_code,
           confidence_score = v.confidence_score,
           reconciliation_status = v.reconciliation_status,
           status = case
             when v.reconciliation_status = 'explained' and t.status = 'needs_review' then 'ready'
             else t.status
           end,
           reconciled_at = case
             when v.reconciliation_status = 'auto_reconciled' then coalesce(t.reconciled_at, now())
             else t.reconciled_at
           end,
           payload = t.payload || v.patch_payload,
           updated_at = now()
       from (values ${sql})
         as v(id, raw_description, cleaned_description, direction, category, account_code,
              confidence_score, reconciliation_status, patch_payload)
       where t.firm_id = $${firmIdParamIndex} and t.id = v.id`,
      params
    );
  }
  }

  const matchValueFn = (match) => [
    match.id,
    firmId,
    match.client_id,
    match.bank_transaction_id,
    match.matched_object_type,
    match.matched_object_id,
    match.match_amount,
    match.match_confidence,
    match.match_reason,
    match.status,
    match.created_by,
    JSON.stringify(match.payload || {})
  ];
  const matchColumnCasts = ['', '', '', '', '', '', '', '', '', '', '', '::jsonb'];
  // The DO UPDATE carries the same namespace discipline as the DELETE
  // above: intel may only overwrite rows it owns. The DELETE skips firm
  // decisions (confirmed/rejected) and family-matcher rows, but without
  // this guard the upsert clobbered the survivors on re-propose —
  // status AND payload replaced wholesale, flipping a strong matcher's
  // verdict back to intel's weaker suggestion on every coding click
  // (the 2026-06-10 Honeybee sweep lost 13 of 15 LLM-proposed matches
  // this way). Mirrors the status gate every other matcher upsert
  // already carries (reconciliationLlmCore / weighted families).
  for (const batch of chunk(analysis.matches, MULTI_ROW_CHUNK_SIZE)) {
    if (!batch.length) continue;
    const { sql, params } = buildMultiRowValues(batch, matchValueFn, matchColumnCasts);
    await client.query(
      `insert into reconciliation_matches (
         id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id,
         match_amount, match_confidence, match_reason, status, created_by, payload
       )
       values ${sql}
       on conflict (bank_transaction_id, matched_object_type, matched_object_id) do update set
         match_amount = excluded.match_amount,
         match_confidence = excluded.match_confidence,
         match_reason = excluded.match_reason,
         status = excluded.status,
         payload = excluded.payload,
         updated_at = now()
       where reconciliation_matches.status not in ('confirmed', 'rejected')
         and coalesce(reconciliation_matches.payload->>'source', 'transaction_intel') = 'transaction_intel'`,
      params
    );
  }

  // RT-16: the intel pass mints CASE FILES (reason, priority, payload
  // context) — never a coding state. The line's coding_state is the
  // transaction's own column and is untouched by a re-run of this pass.
  const reviewItemsWithState = analysis.reviewItems.map((item) => ({ item }));
  // Two bank lines can best-match the SAME object (e.g. both vendor-
  // match one document inside the date window), yielding review items
  // that share the queue's conflict key (firm, client, item_type,
  // item_id, reason) — item_id is the matched OBJECT's id, not the
  // transaction's. Postgres rejects a multi-row ON CONFLICT DO UPDATE
  // that affects one row twice ("cannot affect row a second time" —
  // the 2026-06-11 fresh-reupload Honeybee crash, which killed every
  // coding run at its first step). Collapse duplicates to the first
  // occurrence before the insert; one open item per object+reason is
  // also the correct queue semantics.
  const seenReviewKeys = new Set();
  const dedupedReviewItems = reviewItemsWithState.filter(({ item }) => {
    const key = `${item.item_type}|${item.item_id}|${item.reason}`;
    if (seenReviewKeys.has(key)) return false;
    seenReviewKeys.add(key);
    return true;
  });
  const reviewItemValueFn = ({ item }) => [
    item.id,
    firmId,
    item.client_id,
    item.item_type,
    item.item_id,
    item.reason,
    item.priority,
    item.status,
    JSON.stringify(item.payload || {})
  ];
  const reviewItemColumnCasts = ['', '', '', '', '', '', '', '', '::jsonb'];
  for (const batch of chunk(dedupedReviewItems, MULTI_ROW_CHUNK_SIZE)) {
    if (!batch.length) continue;
    const { sql, params } = buildMultiRowValues(batch, reviewItemValueFn, reviewItemColumnCasts);
    await client.query(
      `insert into transaction_review_queue (
         id, firm_id, client_id, item_type, item_id, reason, priority, status, payload
       )
       values ${sql}
       on conflict (firm_id, client_id, item_type, item_id, reason) do update set
         priority = excluded.priority,
         status = excluded.status,
         payload = excluded.payload,
         updated_at = now()`,
      params
    );
  }

  if (stepAside) {
    // One receipt per (run, client), in the SAME transaction as the
    // suppressed writes — an invisible behavior change on the reconcile
    // path is the anti-pattern this slice exists to kill. Counts + lane
    // seats only, PII-safe (no amounts, no descriptions).
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'client', $4, $5::jsonb)`,
      [
        firmId,
        clientId,
        TRANSACTION_INTEL_STEPPED_ASIDE_ACTION,
        clientId,
        JSON.stringify({
          seats: stepAsideSeats, decision_engine: jevFirst ? 'jev' : 'model_policy',
          lines_enriched: analysis.stepAside?.lines_enriched ?? analysis.transactionPatches.length,
          settles_suppressed: analysis.stepAside?.settles_suppressed ?? 0,
          match_rows_suppressed: analysis.stepAside?.match_rows_suppressed ?? 0,
          review_items_suppressed: analysis.stepAside?.review_items_suppressed ?? 0,
          stale_intel_matches_cleared: staleIntelMatches?.rowCount || 0,
          stale_intel_review_items_cleared: staleIntelReviewItems?.rowCount || 0
        })
      ]
    );
  }

  return analysis;
};

// Test seam — mirrors __resolveDuplicateWithClient /
// __writeParsedDocumentExtractionWithClient in parseDocumentsDb.js.
// Lets receiptReconciliation.test.js exercise the DELETE-predicate
// shape without spinning up a Postgres pool.
export const __refreshTransactionIntelForClientWithClient = refreshTransactionIntelForClient;

export const refreshTransactionIntelInDb = async ({ firmId = DEFAULT_FIRM_ID, clientIds = [] } = {}) => {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return getFirmSnapshotFromDb({ firmId });

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      for (const clientId of ids) {
        await refreshTransactionIntelForClient({ client, firmId, clientId });
      }
      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

export const updateTransactionInDb = async ({ firmId = DEFAULT_FIRM_ID, transactionId, patch = {} } = {}) => {
  assertNoReviewScopePatch(patch);
  if (!transactionId) {
    const error = new Error('Transaction id is required.');
    error.statusCode = 400;
    throw error;
  }

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      // F2: FOR UPDATE — same RMW shape as updateDocumentInDb; protects
      // coding_auto_post, the bank-line disposition markers, and the send-
      // chokepoint flips from being erased by a concurrent full-payload write.
      const existing = await client.query('select * from transactions where firm_id = $1 and id = $2 for update', [firmId, transactionId]);
      if (!existing.rows.length) {
        const error = new Error('Transaction not found.');
        error.statusCode = 404;
        throw error;
      }
      await assertTransactionAccountingMutable({ client, firmId, transactionId, patch });
      const payload = { ...(existing.rows[0].payload || {}), ...patch };
      // RT-16: the coding state is the column, moved by the patch's legacy
      // signals (an explicit label, an applied receipt, a needs_client stamp,
      // a sync marker) — a patch with no coding signal leaves it alone. The
      // legacy label keys never enter the payload again.
      const priorCodingState = existing.rows[0].coding_state ?? null;
      let nextCodingState = nextCodingStateForPatch({ currentState: priorCodingState, patch });
      delete payload.review_state;
      delete payload.reviewState;
      delete payload.coding_state;
      delete payload.codingState;
      if (String(payload.ai_suggestion_status || '') === 'suggested') delete payload.ai_suggestion_status;
      const clientId = existing.rows[0].client_id || payload.client_id || null;
      const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
      const jurisdiction = await getClientJurisdictionForEnrichment({ client, firmId, clientId });
      const enrichedPayload = enrichCodingWithXeroAccount({ coding: payload, transaction: payload, xeroAccounts, jurisdiction });
      Object.assign(payload, enrichedPayload);
      if (payload.ai_suggestion && typeof payload.ai_suggestion === 'object') {
        payload.ai_suggestion = enrichCodingWithXeroAccount({
          coding: payload.ai_suggestion,
          transaction: payload,
          xeroAccounts,
          jurisdiction
        });
      }
      const aiSuggestion = payload.ai_suggestion && typeof payload.ai_suggestion === 'object' ? payload.ai_suggestion : {};
      const accountCode = payload.account_code || payload.proposed_account || aiSuggestion.proposed_account || '';
      const intercompanyApplied = isIntercompanyAccount(accountCode);
      const canLearnMerchant = Boolean(
        (aiSuggestion.merchant_pattern || aiSuggestion.contact || payload.contact || payload.merchant_pattern) &&
        accountCode &&
        normalizeIntelText(accountCode) !== 'suspense'
      );
      const shouldLearnAppliedAiRule = Boolean(
        payload.ai_suggestion_status === 'applied' &&
        canLearnMerchant &&
        (aiSuggestion.remember_candidate || aiSuggestion.evidence_required === false || intercompanyApplied)
      );
      // W1 (S09/L1, INV-01): a rule learned FROM the applied AI suggestion is a
      // model proposal (source 'ai_applied' → status 'proposed', no cascade).
      // Only a HUMAN intent — the drawer's own remember toggle
      // (`remember_merchant_rule` on THIS patch) or the explicit `learn_rule`
      // verb — activates. A `remember_merchant_rule: true` that merely survives
      // in the persisted payload (a pre-W1 batch stamp) is never re-read as
      // human intent: it mints a proposal, as the model that set it deserved.
      const humanRememberIntent = Boolean(patch.remember_merchant_rule || patch.learn_rule || payload.learn_rule);
      const ruleMintSource = humanRememberIntent ? 'transaction_drawer' : 'ai_applied';
      if (shouldLearnAppliedAiRule) {
        const suggestedLimit = Number(aiSuggestion.auto_explain_limit || 0);
        const approvedAmount = amountForPayload(payload);
        const learnedLimit = intercompanyApplied
          ? 999999999
          : aiSuggestion.evidence_required === false && Number.isFinite(approvedAmount) && approvedAmount > 0
          ? Math.max(Number.isFinite(suggestedLimit) ? suggestedLimit : 0, approvedAmount)
          : suggestedLimit || null;
        payload.remember_merchant_rule = true;
        payload.merchant_pattern = payload.merchant_pattern || aiSuggestion.merchant_pattern || aiSuggestion.contact || payload.contact || '';
        payload.merchant_rule_account = payload.merchant_rule_account || accountCode;
        payload.merchant_rule_auto_explain_limit = payload.merchant_rule_auto_explain_limit || learnedLimit;
      }
      let supportNote = String(payload.support_note || '').trim();
      if (!supportNote && payload.ai_suggestion_status === 'applied') {
        supportNote = fallbackSupportNoteForSuggestion(aiSuggestion, accountCode);
      }
      if (supportNote) {
        payload.support_note = supportNote;
        payload.support_status = payload.support_status || 'explained';
        payload.support_explained_at = payload.support_explained_at || Date.now();
        if (!payload.reconciliation_status || payload.reconciliation_status === 'needs_review') {
          payload.reconciliation_status = 'explained';
        }
      }
      // A support note / approval on a line still proposed (or never coded)
      // IS the firm's decision: the case closes below and the coding state
      // lands applied with it — the pre-138 writer closed the case at
      // 'resolved' while leaving the transaction at 'suggested' (F-14).
      const explainsOrApproves = Boolean(supportNote) || payload.status === 'approved';
      if (explainsOrApproves && (!nextCodingState || nextCodingState === 'proposed')) nextCodingState = 'applied';
      await client.query(
        `update transactions
         set
           transaction_date = $3,
           description = $4,
           money_in = $5,
           money_out = $6,
           currency = $7,
           status = $8,
           reconciliation_status = coalesce($9, reconciliation_status),
           account_code = coalesce($10, account_code),
           category = coalesce($11, category),
           confidence_score = coalesce($12, confidence_score),
           payload = $13::jsonb,
           updated_at = now()
         where firm_id = $1 and id = $2`,
        [
          firmId,
          transactionId,
          payload.date || null,
          payload.description || null,
          Number(payload.money_in || 0),
          Number(payload.money_out || 0),
          payload.account_currency || payload.currency || null,
          payload.status || 'needs_review',
          payload.reconciliation_status || null,
          payload.account_code || payload.proposed_account || null,
          payload.category || null,
          numberOrNull(payload.confidence_score),
          JSON.stringify(payload)
        ]
      );
      if (nextCodingState) {
        await applyCodingTransition(client, { firmId, transactionId, to: nextCodingState });
      }
      if (
        clientId &&
        isAppliedSuggestionReceipt(payload.ai_suggestion_status)
      ) {
        await resolveOpenEvidenceRequestsForTransaction({
          client,
          firmId,
          clientId,
          transactionId,
          note: `Superseded by applied coding (${payload.account_code || payload.proposed_account || 'account set'}).`
        });
      }
      if ((payload.remember_merchant_rule || payload.learn_rule) && clientId) {
        const savedRule = await saveMerchantRuleForPayload({
          client,
          firmId,
          clientId,
          transactionId,
          payload,
          supportNote,
          source: ruleMintSource
        });
        if (savedRule && savedRule.status === 'active') {
          payload.matched_client_rule_id = payload.matched_client_rule_id || savedRule.ruleId;
          payload.matched_client_rule_label = payload.matched_client_rule_label || savedRule.rulePayload.label;
          await client.query(
            `update transactions
             set payload = payload || $3::jsonb, updated_at = now()
             where firm_id = $1 and id = $2`,
            [
              firmId,
              transactionId,
              JSON.stringify({
                matched_client_rule_id: payload.matched_client_rule_id,
                matched_client_rule_label: payload.matched_client_rule_label,
                merchant_rule_cascade: savedRule.cascadeResult
              })
            ]
          );
        }
      }
      if ((payload.remember_merchant_rule || payload.learn_rule) && clientId) {
        await refreshTransactionIntelForClient({ client, firmId, clientId });
      }
      if (explainsOrApproves) {
        // The case closes when the decision came from THIS write (a proposed
        // / never-coded line the note or approval decided) or when the line
        // sits on a ledger/hold rung; an applied-and-open case stays open
        // until it posts (the batch and accept paths' convention).
        const decidedHere = !priorCodingState || priorCodingState === 'proposed';
        const nextQueueStatus = (decidedHere || codingStateClosesReviewCase(nextCodingState)) ? 'resolved' : 'open';
        await client.query(
          `update transaction_review_queue
           set status = $5,
               payload = payload || $4::jsonb,
               updated_at = now()
           where firm_id = $1
             and client_id = $2
             and status = 'open'
             and (
               item_id = $3
               or payload->>'transaction_id' = $3
             )`,
          [
            firmId,
            clientId,
            transactionId,
            JSON.stringify({
              closed_by: supportNote ? 'support_note' : 'transaction_approval',
              support_status: payload.support_status || null
            }),
            nextQueueStatus
          ]
        );
      }
      if (existing.rows[0].payload?.review_scope) {
        const after = (await client.query('select * from transactions where firm_id=$1 and id=$2', [firmId,transactionId])).rows[0];
        if (nativeReviewFocalChanged(existing.rows[0], after)) {
          await client.query("update transactions set payload=payload-'review_scope' where firm_id=$1 and id=$2", [firmId,transactionId]);
        }
      }
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'transaction.update', 'transaction', $3, $4::jsonb)`,
        [firmId, payload.client_id || null, transactionId, JSON.stringify({ patch_keys: Object.keys(patch) })]
      );
      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};
