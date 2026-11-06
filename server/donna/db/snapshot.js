// server/donna/db/snapshot.js — plane S compressed reads — the firm snapshot and the feed rows (the in-memory two-terminal projection sites).
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { projectEntityReadiness, projectHostReadiness } from '../runtimeReadinessProjection.js';
import { resolveRuntimeHostIdentity, CLOUD_RUNTIME_HOST } from '../runtimeHostIdentity.js';
import { hostReadinessIsMutationReady } from '../runtimeReadiness.js';
import { buildCaseId } from '../caseManager.js';
import { BANK_LINE_DISPOSITION_FAMILY, BANK_LINE_DISPOSITION_TARGET_TYPE, summarizeBankLineDispositions } from '../bankLineDispositionShape.js';
import { readLatestGoalReportsForCases } from '../loopGoalStore.js';
import { deriveReconciliationTerminalState } from '../reconciliationTerminalState.js';
import { convergenceMetrics, settleConvergenceForRead, readNativeConvergenceProjectionForRows } from '../reconcileConvergenceState.js';
// Doc-first terminal drain (Slice 1) — the ONE membership rule for "parsed
// reconcilable doc with no bank line" lives in the FE-shared inbox lib
// (same import direction as receiptAutoExplainBlockers: src/lib defines,
// server consumes), so the Reconcile section and the convergence metric can
// never disagree about which docs are in the population.
import { selectNoLineReconcilableDocs } from '../../../src/lib/documentsInbox.js';
import { attachAgreementEvidenceChecks } from '../snapshotAgreementEvidence.js';
import { rollupUploadBatches } from '../parseDocumentsDb.js';

import { loadPgPool, queryFirmDb, queryOptionalFirmDb, withFirmDbClient } from './pool.js';
import { DEFAULT_FIRM_ID, deriveAccountingConnectionByClient } from './clients.js';
import { rowToDocumentPayload } from './documents.js';
import { rowToTransactionPayload } from './transactions.js';
import { readReconcileActivityWithClient } from './reconcileActivity.js';
import { REVIEW_QUEUE_WITH_CODING_STATE_SQL, rowToTransactionReviewPayload } from './coding.js';
import { groupEvidenceAuditEventsByRequestId, rowToClientEvidenceRequestPayload } from './asks.js';
import { rowToLedgerAccountPayload, rowToLedgerJournalPayload, rowToLedgerLinePayload } from './ledger.js';
import { rowToCloseArchivePayload, rowToClosePeriodPayload } from './close.js';
import { __isXeroExportCandidateTransaction, rowToXeroAccountPayload, rowToXeroConnectionPayload, rowToXeroContactPayload } from './xero.js';

const rowsToPayloads = (rows = []) => rows.map((row) => row.payload || {});

// Match statuses that put a live reconciliation match on a bank line — the
// same set the snapshot's settled-set and the pipeline-doc gather use.
const FEED_CHAT_LIVE_MATCH_STATUSES = ['suggested', 'auto_matched', 'confirmed'];

// The feed chat's convergence + match enrichment — the chat-side twin of the
// enrichment getFirmSnapshotFromDb runs before the FE partitions the feed into
// its Open / Reconciled / Client-asks tabs. Every step reuses the snapshot's
// OWN building blocks (summarizeBankLineDispositions, the goal-report terminal
// override, and — since RT-17 PR 8 — the PERSISTED convergence column the
// writers derive through the ONE projection module), so the chat's per-row
// verdict is the SAME verdict the rendered chips carry — render the persisted
// verdict, never a second inference. Without this the chat saw only
// the raw legacy reconciliation_status column and told the firm that
// auto-matched lines were unmatched (the 2026-07-06 Honeybee stonewall: the
// UI said MATCHED · AUTO, the chat said "only two rows are auto_reconciled").
// Mutates the passed payloads in place (same style as the snapshot) and
// returns them.
export const attachCurrentNativeReviewProjection = async ({firmId,rows=[],client=null,currentRows=null}) => {
  if (!rows.length) return null;
  for (const row of rows) { delete row.processing_scope; delete row.projection_freshness; }
  const read = client ? await readNativeConvergenceProjectionForRows(client,{firmId,rows})
    : await withFirmDbClient(connection=>readNativeConvergenceProjectionForRows(connection,{firmId,rows}));
  if (!read) return null;
  const current = new Map(read.current.map(row=>[row.target_id,row]));
  const targets = new Set(read.targets.map(row=>row.id));
  const scopeByClient = new Map();
  for (const computed of read.current) if (computed.processing_scope) scopeByClient.set(computed.client_id, computed.processing_scope);
  const byClient = {};
  for (const row of rows) {
    if (!targets.has(row.id)) continue;
    const projected = current.get(row.id);
    if (projected && !projected.processing_scope?.enforced) continue;
    row.accounting_ready = false;
    row.converged = false;
    if (projected) {
      if (projected.current_transaction) {
        Object.assign(row,rowToTransactionPayload(projected.current_transaction));
        currentRows?.set(row.id, projected.current_transaction);
      }
      row.convergence_state = projected.derived?.state || 'hanging';
      row.convergence_reason = projected.derived?.reason || 'processing_review_only';
      row.processing_scope = projected.processing_scope;
      row.projection_freshness = projected.projection_freshness;
    } else {
      // F-33: a row outside the bounded refresh renders its PERSISTED verdict
      // (the column every writer derives through the one projection) — never a
      // second, blanket "hanging". Only the per-row review CURRENCY is unknown
      // here, so that alone is reported incomplete. The client-level scope comes
      // from a refreshed row of the same client (readNativeConvergenceProjection
      // ForRows always refreshes one per client): a client whose scope is not
      // enforced reads like its refreshed rows; an enforced one keeps the law's
      // own key for a terminal it forbids.
      const clientScope = scopeByClient.get(row.client_id);
      if (clientScope && !clientScope.enforced) continue;
      row.processing_scope = { ...(clientScope || {}), review_current:false,review_reason:'projection_not_current',pending:false,accounting_ready:false };
      row.projection_freshness = {status:'incomplete',reason:'projection_batch_limit'};
      if (!row.convergence_state) {
        row.convergence_state='hanging'; row.convergence_reason='projection_not_current';
      } else if (row.convergence_state==='auto_reconciled') {
        row.convergence_state='hanging'; row.convergence_reason=clientScope ? 'processing_review_only' : 'projection_not_current';
      }
    }
    row.accounting_ready=false; row.converged=false;
    const prior = byClient[row.client_id];
    if (!prior || row.projection_freshness.status==='incomplete') byClient[row.client_id]=row.projection_freshness;
  }
  return {status:read.capped || Object.values(byClient).some(value=>value.status==='incomplete') ? 'incomplete' : 'current',
    reason:read.capped ? 'projection_batch_limit' : Object.values(byClient).some(value=>value.status==='incomplete') ? 'pending_convergence' : null,
    by_client:byClient,accounting_ready:false,converged:false};
};

export const attachFeedChatConvergence = async ({ firmId, clientId, rows = [] }) => {
  if (!rows.length) return rows;
  const txIds = rows.map((tx) => tx.id).filter(Boolean);
  // RT-17 PR 8 — settle whatever marks rest on this client first (a foreign
  // write leaves one; the hooked writers settle their own at commit), so the
  // column read below is the CURRENT verdict — the same settle-then-read
  // RT-13 gave the reconcile stats.
  await withFirmDbClient((client) => settleConvergenceForRead(client, { firmId, clientId, scope: 'all' }));
  const [matchesResult, dispositionResult] = await Promise.all([
    queryFirmDb(
      `select * from reconciliation_matches
        where firm_id = $1 and client_id = $2 and status = any($3)
        order by created_at desc`,
      [firmId, clientId, FEED_CHAT_LIVE_MATCH_STATUSES]
    ),
    queryOptionalFirmDb(
      `select target_id, target_type, matcher_family, verdict, unmatchable_reason, model, payload
         from reconciliation_evaluations
        where firm_id = $1 and target_type = $2 and matcher_family = $3 and target_id = any($4)`,
      [firmId, BANK_LINE_DISPOSITION_TARGET_TYPE, BANK_LINE_DISPOSITION_FAMILY, txIds]
    )
  ]);

  // Step 1 — disposition verdicts, with a live settling match outranking the
  // verdict (INV-4), exactly as the snapshot computes it.
  const settledTransactionIds = new Set(
    (matchesResult.rows || [])
      .filter((m) => m.status === 'confirmed' || m.status === 'auto_matched')
      .map((m) => m.bank_transaction_id)
      .filter(Boolean)
  );
  const dispositionByTx = summarizeBankLineDispositions(
    dispositionResult.rows || [],
    { settledTransactionIds }
  );
  for (const tx of rows) {
    const disposition = dispositionByTx.get(tx.id);
    if (disposition) tx.bank_line_disposition = disposition;
  }

  // Step 2 — the goal-report terminal override (design §10 Step 4): the loop
  // verdict outranks the legacy column when present, additive/inert otherwise.
  const reconCaseIdByTx = new Map();
  for (const tx of rows) {
    const caseId = buildCaseId({
      firmId, clientId, caseType: 'reconciliation',
      primaryObjectType: 'transaction', primaryObjectId: tx.id
    });
    if (caseId) reconCaseIdByTx.set(tx.id, caseId);
  }
  const reconGoalReportByCase = await readLatestGoalReportsForCases({
    client: await loadPgPool(), firmId, caseIds: [...reconCaseIdByTx.values()]
  });
  for (const tx of rows) {
    const report = reconGoalReportByCase.get(reconCaseIdByTx.get(tx.id));
    if (!report) continue;
    const terminal = deriveReconciliationTerminalState(report, { legacyStatus: tx.reconciliation_status });
    if (terminal.verdict_present && terminal.reconciliation_status) {
      tx.reconciliation_status = terminal.reconciliation_status;
    }
  }

  // Step 3 (RT-17 PR 8) — the owner-ask sets and the cascade verdict are no
  // longer re-collected here: the writers persisted the verdict they feed
  // (RT-13), and step 5 reads it.

  // Step 4 — the persisted match verdict per row: the LATEST live match (the
  // query is newest-first) with its authorization band. This is the state the
  // UI's "MATCHED · AUTO / SUGGESTED" chip renders; without it the chat argues
  // with the user about what their own screen shows.
  const latestMatchByTx = new Map();
  for (const m of matchesResult.rows || []) {
    if (m.bank_transaction_id && !latestMatchByTx.has(m.bank_transaction_id)) {
      latestMatchByTx.set(m.bank_transaction_id, m);
    }
  }
  const matchedDocIds = [...new Set(
    [...latestMatchByTx.values()].map((m) => m.matched_object_id).filter(Boolean)
  )];
  const matchedDocsResult = matchedDocIds.length
    ? await queryFirmDb(
        'select id, vendor_name, document_type, filename from documents where firm_id = $1 and id = any($2)',
        [firmId, matchedDocIds]
      )
    : { rows: [] };
  const matchedDocById = new Map(matchedDocsResult.rows.map((d) => [d.id, d]));
  for (const tx of rows) {
    const m = latestMatchByTx.get(tx.id);
    if (!m) continue;
    const doc = matchedDocById.get(m.matched_object_id) || null;
    tx.reconciliation_match = {
      status: m.status,
      authorization_band: m.payload?.authorization?.band || null,
      authorization_reasons: Array.isArray(m.payload?.authorization?.reasons)
        ? m.payload.authorization.reasons
        : null,
      matched_document_id: m.matched_object_id || null,
      matched_document_type: doc?.document_type || m.matched_object_type || null,
      matched_counterparty: doc?.vendor_name || null,
      matched_filename: doc?.filename || null
    };
  }

  // Step 5 (RT-17 PR 8) — the persisted two-terminal verdict. The writers
  // persist it review-item-first through the ONE derivation (RT-13,
  // reconcileConvergenceState.applyConvergenceState), so the row carries the
  // same verdict the rendered chips and the metric carry — render it, never
  // re-derive. Rows read with the column already carry it (the DTO); rows
  // handed in without it are looked up once.
  const missing = rows.filter((tx) => tx.convergence_state === undefined && tx.id);
  if (missing.length) {
    const verdictResult = await queryFirmDb(
      'select id, convergence_state, convergence_reason from transactions where firm_id = $1 and client_id = $2 and id = any($3)',
      [firmId, clientId, missing.map((tx) => tx.id)]
    );
    const verdictById = new Map((verdictResult.rows || []).map((row) => [row.id, row]));
    for (const tx of missing) {
      const row = verdictById.get(tx.id);
      tx.convergence_state = row?.convergence_state ?? null;
      tx.convergence_reason = row?.convergence_reason ?? null;
    }
  }
  await attachCurrentNativeReviewProjection({firmId,rows});
  return rows;
};

// RT-17 PR 8 — the convergence metric over PERSISTED verdicts: the rows the
// snapshot renders (transactions + the no-line document population), each
// carrying the column the writers derived. Same shape as the retired
// in-memory aggregator (overall + by_client, unknown client bucketed); a row
// whose verdict was never derived counts as hanging under its own key —
// a row resting with no verdict is a violation to surface, never a row to
// drop from the metric (the nightly drift check names the same rows).
export const CONVERGENCE_NOT_DERIVED_REASON = 'convergence_not_derived';
const convergenceMetricsFromPersistedVerdicts = (rows = []) => {
  const verdicts = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.id == null) continue;
    const state = typeof row.convergence_state === 'string' ? row.convergence_state : null;
    verdicts.push({
      state: state || 'hanging',
      reason: state ? (row.convergence_reason ?? null) : CONVERGENCE_NOT_DERIVED_REASON,
      client_id: row.client_id ?? null
    });
  }
  const byClientRows = new Map();
  for (const row of verdicts) {
    const key = row.client_id == null ? '__unknown__' : row.client_id;
    if (!byClientRows.has(key)) byClientRows.set(key, []);
    byClientRows.get(key).push(row);
  }
  const by_client = {};
  for (const [key, group] of byClientRows) by_client[key] = convergenceMetrics(group);
  return { overall: convergenceMetrics(verdicts), by_client };
};

// The feed chat's scope-resolution universe: the client's transaction
// rows, newest first, capped, enriched with the SAME convergence verdict +
// persisted match state the rendered feed carries (attachFeedChatConvergence
// above). Returns { rows, totalCount } — the cap keeps the LLM context
// bounded; totalCount lets the context flag truncation so the model says so
// instead of silently resolving against a partial feed.
export const getFeedChatRowsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  limit = 400
} = {}) => {
  if (!clientId) {
    const error = new Error('client_id is required.');
    error.statusCode = 400;
    throw error;
  }
  const [rowsResult, countResult] = await Promise.all([
    queryFirmDb(
      `select * from transactions
        where firm_id = $1 and client_id = $2
        order by transaction_date desc nulls last, created_at desc
        limit $3`,
      [firmId, clientId, limit]
    ),
    queryFirmDb(
      'select count(*)::int as total from transactions where firm_id = $1 and client_id = $2',
      [firmId, clientId]
    )
  ]);
  const rows = rowsResult.rows.map(rowToTransactionPayload);
  // Enrichment must never kill the chat turn: on failure the chat degrades to
  // the bare rows (its pre-enrichment behavior), same soft-fail contract as
  // the other feed-chat context lookups in api.js.
  await attachFeedChatConvergence({ firmId, clientId, rows }).catch((err) => {
    console.warn('[feed-chat] convergence enrichment failed', err?.message || err);
  });
  return {
    rows,
    totalCount: countResult.rows[0]?.total ?? rowsResult.rows.length
  };
};

// The client's agreement (contract) documents that carry extracted obligations
// — the feed chat's agreement-evidence source. The feed chat computes a
// READ-ONLY CheckReport from these against the feed rows; docs without
// obligations (e.g. an NDA) are useless to the check, so they're filtered out
// here. Bounded so a client with many contracts can't bloat the turn.
export const getFeedChatAgreementDocsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  limit = 25
} = {}) => {
  if (!clientId) return [];
  const result = await queryFirmDb(
    `select * from documents
       where firm_id = $1 and client_id = $2 and document_type = 'contract'
       order by created_at desc
       limit $3`,
    [firmId, clientId, limit]
  );
  return result.rows
    .map(rowToDocumentPayload)
    .filter((doc) => Array.isArray(doc.parse_summary?.obligations) && doc.parse_summary.obligations.length > 0);
};

// pipeline_state source for the feed chat (the snapshot's THIRD consumer,
// #396). The matched documents of the given feed rows that are NOT cleanly
// parsed — stuck / in-flight / errored (the READING·1-OF-1 class). A
// 'completed' matched doc is excluded on purpose: its diagnose answer is
// the bank line's bookkeeping state (coding verdict / reconciliation), not
// a parse stall — so the healthy case returns [] and the feed chat pays
// nothing. ONE query (reconciliation_matches ⋈ documents); bank_transaction_id
// ties each doc back to the row the chat resolves by id, and the cap bounds
// the block. Rows are shaped by operatorCaseSnapshot.pipelineStateFromDoc at
// the call site (one shaper, no per-consumer drift).
export const getFeedChatPipelineDocsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionIds = [],
  limit = 30
} = {}) => {
  if (!clientId || !Array.isArray(transactionIds) || transactionIds.length === 0) return [];
  const result = await queryFirmDb(
    `select m.bank_transaction_id as transaction_id,
            d.id, d.parse_status, d.parse_stage,
            d.parse_progress_current, d.parse_progress_total,
            d.parse_summary, d.parse_error, d.parse_run_id
       from reconciliation_matches m
       join documents d
         on d.firm_id = m.firm_id and d.id = m.matched_object_id
      where m.firm_id = $1
        and m.bank_transaction_id = any($2)
        and m.status in ('suggested', 'confirmed', 'auto_matched')
        and d.parse_status is distinct from 'completed'
      order by m.match_confidence desc nulls last
      limit $3`,
    [firmId, transactionIds, limit]
  );
  return result.rows;
};

export const getFirmSnapshotFromDb = async ({ firmId = DEFAULT_FIRM_ID, observedAt = new Date().toISOString() } = {}) => {
  // RT-17 PR 8 — settle whatever marks rest on this firm first (a foreign
  // write leaves one; the hooked writers settle their own at commit), so the
  // persisted verdicts read below are current — the same settle-then-read
  // RT-13 gave the reconcile stats.
  await withFirmDbClient((client) => settleConvergenceForRead(client, { firmId, scope: 'all' }));
  const [
    firmResult,
    membersResult,
    collaboratorsResult,
    clientsResult,
    assignmentsResult,
    documentsResult,
    transactionsResult,
    rulesResult,
    clientRulesResult,
    merchantsResult,
    xeroConnectionsResult,
    xeroAccountsResult,
    xeroContactsResult,
    xeroSyncRunsResult,
    ledgerAccountsResult,
    ledgerJournalsResult,
    ledgerLinesResult,
    closePeriodsResult,
    closeChecksResult,
    closeArchivesResult,
    evidenceRequestResult,
    evidenceAuditResult,
    reconciliationResult,
    transactionReviewResult,
    queueResult,
    historyResult,
    llmDecisionsResult,
    qboConnectionsResult,
    procountorConnectionsResult,
    bankLineDispositionResult,
    qboPendingExportResult,
    procountorPendingExportResult,
    entityReadinessResult,
    hostReadinessResult
  ] = await Promise.all([
    queryFirmDb('select * from firms where id = $1', [firmId]),
    queryFirmDb('select * from firm_members where firm_id = $1 order by name', [firmId]),
    queryFirmDb('select * from firm_collaborators where firm_id = $1 order by name', [firmId]),
    queryFirmDb('select * from clients where firm_id = $1 and status <> $2 order by created_at, company_name', [firmId, 'deleted']),
    queryFirmDb('select * from client_assignments where firm_id = $1 order by client_id, principal_type, principal_id', [firmId]),
    queryFirmDb('select * from documents where firm_id = $1 order by uploaded_at nulls last, created_at', [firmId]),
    queryFirmDb('select * from transactions where firm_id = $1 order by transaction_date nulls last, created_at', [firmId]),
    queryFirmDb('select payload from accounting_rules where firm_id = $1 order by created_at', [firmId]),
    queryFirmDb('select * from client_rules where firm_id = $1 order by created_at', [firmId]),
    queryFirmDb('select * from merchants where firm_id = $1 order by canonical_name', [firmId]),
    queryOptionalFirmDb('select * from xero_connections where firm_id = $1 order by connected_at desc', [firmId]),
    queryOptionalFirmDb('select * from xero_accounts where firm_id = $1 order by code nulls last, name', [firmId]),
    queryOptionalFirmDb('select * from xero_contacts where firm_id = $1 order by name nulls last', [firmId]),
    queryOptionalFirmDb('select * from xero_sync_runs where firm_id = $1 order by started_at desc limit 40', [firmId]),
    queryOptionalFirmDb('select * from ledger_accounts where firm_id = $1 order by code nulls last, name', [firmId]),
    queryOptionalFirmDb('select * from ledger_journals where firm_id = $1 order by journal_date desc, created_at desc limit 500', [firmId]),
    queryOptionalFirmDb('select * from ledger_lines where firm_id = $1 order by created_at desc limit 1000', [firmId]),
    queryOptionalFirmDb('select * from close_periods where firm_id = $1 order by period_start desc', [firmId]),
    queryOptionalFirmDb('select * from close_checks where firm_id = $1 order by created_at desc', [firmId]),
    queryOptionalFirmDb('select * from close_archives where firm_id = $1 order by generated_at desc limit 100', [firmId]),
    queryOptionalFirmDb('select * from client_evidence_requests where firm_id = $1 order by updated_at desc limit 500', [firmId]),
    queryOptionalFirmDb(
      `select *
       from audit_events
       where firm_id = $1
         and (
           resource_type = 'client_evidence_request'
           or metadata ? 'evidence_request_id'
         )
       order by created_at desc
       limit 1000`,
      [firmId]
    ),
    queryFirmDb('select * from reconciliation_matches where firm_id = $1 order by created_at desc', [firmId]),
    queryFirmDb(`select q.*, t.coding_state as transaction_coding_state from ${REVIEW_QUEUE_WITH_CODING_STATE_SQL} where q.firm_id = $1 and q.status = $2 order by q.created_at desc`, [firmId, 'open']),
    queryFirmDb('select payload from queue_items where firm_id = $1 and status = $2 order by created_at', [firmId, 'open']),
    queryFirmDb('select payload from history_items where firm_id = $1 order by happened_at desc nulls last, created_at desc', [firmId]),
    // Projection minimisation (policy doc §5): decision receipts are no longer
    // fetched into the firm snapshot at all. Nothing read them — not the
    // frontend, not any server module — and `/snapshot` serialises this object
    // to the browser. Minimised at the SOURCE rather than only at the access
    // filter, so a firm member's payload no longer carries model prose either.
    // Resolved to an empty result so the destructuring below is untouched.
    Promise.resolve({ rows: [] }),
    queryOptionalFirmDb('select * from qbo_connections where firm_id = $1 order by connected_at desc', [firmId]),
    queryOptionalFirmDb('select * from procountor_connections where firm_id = $1 order by connected_at desc', [firmId]),
    // Phase 7.2b-ii — persisted bank-line disposition verdicts (the strong-model
    // successor to bankLineAutoExplain). Read-only here; rendered on the feed.
    // queryOptional so a not-yet-migrated env degrades to [] instead of throwing.
    queryOptionalFirmDb(
      `select target_id, target_type, matcher_family, verdict, unmatchable_reason, model, payload
         from reconciliation_evaluations
        where firm_id = $1 and target_type = $2 and matcher_family = $3`,
      [firmId, BANK_LINE_DISPOSITION_TARGET_TYPE, BANK_LINE_DISPOSITION_FAMILY]
    ),
    // INT-4d — QBO posted-not-exported: posted journals with no synced mirror
    // row (the exact candidate set the batch-writeback verb drains). Xero's
    // equivalent is counted from transaction payload flags below.
    queryOptionalFirmDb(
      `select j.client_id, count(*)::int as pending
         from ledger_journals j
         left join qbo_journal_mirrors m
           on m.journal_id = j.id and m.status = 'synced'
        where j.firm_id = $1 and j.status = 'posted' and m.id is null
        group by j.client_id`,
      [firmId]
    ),
    queryOptionalFirmDb(
      `select j.client_id, count(*)::int as pending
         from ledger_journals j
         left join procountor_journal_mirrors m
           on m.journal_id = j.id and m.status = 'synced'
        where j.firm_id = $1 and j.status = 'posted' and m.id is null
        group by j.client_id`,
      [firmId]
    ),
    queryOptionalFirmDb(
      `select * from entity_readiness_sagas
        where firm_id = $1
        order by client_id`,
      [firmId]
    ),
    queryOptionalFirmDb(
      `select h.*, a.certificate from runtime_host_readiness h
        join runtime_host_readiness_attempts a on a.id = h.latest_attempt_id
        where h.host_id = $1`,
      [resolveRuntimeHostIdentity().host_id]
    )
  ]);

  const firm = firmResult.rows[0] || null;
  const hostIdentity = resolveRuntimeHostIdentity();
  let hostRow = hostReadinessResult.rows[0] || null;
  if (hostRow && hostIdentity.runtime_host === CLOUD_RUNTIME_HOST && !hostReadinessIsMutationReady({ certificate: hostRow.certificate, asOf: observedAt, hostIdentity })) {
    hostRow = { ...hostRow, status: 'INCOMPLETE', reason_code: hostIdentity.reason || hostRow.reason_code || 'cloud_host_evidence_unproven' };
  }
  const runtimeReadinessHost = projectHostReadiness(hostRow, { asOf: observedAt, runtimeHost: hostIdentity.runtime_host });
  const entityReadinessByClient = new Map(
    entityReadinessResult.rows.map((row) => [row.client_id, row])
  );

  // Phase 3a / 2.1d — per-client accounting-system connection, derived from
  // the connection rows already loaded above and surfaced as
  // client.accounting_system_connection (never cached on the profile). The
  // connection that surfaces follows the client's chosen accounting_system:
  // QBO clients see their qbo_connections row, everyone else (xero / unset)
  // sees xero_connections — matching DEFAULT_ACCOUNTING_SYSTEM.
  const xeroConnectionByClient = deriveAccountingConnectionByClient(xeroConnectionsResult.rows);
  const qboConnectionByClient = deriveAccountingConnectionByClient(qboConnectionsResult.rows);
  const procountorConnectionByClient = deriveAccountingConnectionByClient(procountorConnectionsResult.rows);

  // INT-4d — posted-not-exported visibility. Per-client counts of entries the
  // one-click batch export (/xero|qbo/writeback-transactions) would drain:
  // QBO from the mirror-row query above; Xero from the same payload flags the
  // close diagnostics' missing_in_xero uses (isTransactionPostedToDonnaLedger
  // && !isTransactionSyncedToXero). Surfaced on accounting_system_connection so
  // the operator card renders the count next to its Mirror action.
  const qboPendingExportByClient = new Map(
    (qboPendingExportResult?.rows || []).map((r) => [r.client_id, Number(r.pending) || 0])
  );
  const procountorPendingExportByClient = new Map(
    (procountorPendingExportResult?.rows || []).map((r) => [r.client_id, Number(r.pending) || 0])
  );
  const xeroPendingExportByClient = new Map();
  for (const row of transactionsResult.rows) {
    // Same predicate the export batch applies (settled verdict, not synced,
    // not suspense-parked) so the operator card's "Export N" is a promise the
    // batch keeps. status lives on the row; the settled/coding fields on the
    // payload.
    const t = { ...(row.payload || {}), status: row.status || row.payload?.status };
    if (__isXeroExportCandidateTransaction(t)) {
      xeroPendingExportByClient.set(row.client_id, (xeroPendingExportByClient.get(row.client_id) || 0) + 1);
    }
  }

  const clients = clientsResult.rows.map((row) => {
    const acctSystem = String(row.profile?.accounting_system || '').toLowerCase();
    const connectionByClient = acctSystem === 'qbo'
      ? qboConnectionByClient
      : acctSystem === 'procountor'
        ? procountorConnectionByClient
        : xeroConnectionByClient;
    const baseConnection = connectionByClient.get(row.id) || null;
    return {
      ...row.profile,
      id: row.id,
      // Retain both persisted identity homes for setup conflict repair. The
      // historical flattened display fields below must not hide disagreement.
      persisted_identity: {
        jurisdiction: row.jurisdiction ?? null,
        entity_type: row.entity_type ?? null,
        profile_jurisdiction: row.profile?.jurisdiction ?? null,
        profile_entity_type: row.profile?.entity_type ?? null,
        profile_entityType: row.profile?.entityType ?? null
      },
      companyName: row.profile?.companyName || row.company_name,
      uen: row.profile?.uen || row.uen,
      entityType: row.profile?.entityType || row.entity_type,
      incorporationDate: row.profile?.incorporationDate || row.incorporation_date,
      stage: row.profile?.stage || row.stage,
      nextDeadline: row.profile?.nextDeadline || row.next_deadline,
      // Server-derived; always overwrites any stale profile-borne value.
      runtime_readiness: projectEntityReadiness(entityReadinessByClient.get(row.id) || null, {
        hostReadiness: runtimeReadinessHost,
        asOf: observedAt
      }),
      accounting_system_connection: baseConnection
        ? {
            ...baseConnection,
            pending_export_count: acctSystem === 'qbo'
              ? qboPendingExportByClient.get(row.id) || 0
              : acctSystem === 'procountor'
                ? procountorPendingExportByClient.get(row.id) || 0
                : xeroPendingExportByClient.get(row.id) || 0
          }
        : null
    };
  });

  const evidenceAuditByRequestId = groupEvidenceAuditEventsByRequestId(evidenceAuditResult.rows);
  const clientEvidenceRequests = evidenceRequestResult.rows.map((row) => {
    const request = rowToClientEvidenceRequestPayload(row);
    return {
      ...request,
      evidence_audit_events: evidenceAuditByRequestId.get(request.id) || []
    };
  });

  const documentPayloads = documentsResult.rows.map(rowToDocumentPayload);
  // PR 4 — firm-side activity feed rollup. Group every upload (last 7d
  // is fine for an in-memory rollup; the FE just renders newest-first)
  // by batch_id so the actions panel renders one entry per batch
  // instead of one per file. Empty rollup is a valid result and falls
  // through to the existing UI.
  const recentUploadBatches = rollupUploadBatches(documentPayloads);

  // Read-only agreement evidence: compute a CheckReport per agreement document
  // against its own client's bank lines, ONCE on this read path (a read-model
  // derivation over the strong LLM's already-persisted obligations, like the
  // other snapshot chips), so the documents-list cue and the artifact panel
  // render the same verdict instead of recomputing per open. It must reflect
  // CURRENT transactions, so it lives here, not as a stale parse-time field.
  // Never posts/reconciles/clears.
  const transactionPayloads = transactionsResult.rows.map(rowToTransactionPayload);
  const currentRows = new Map();
  const nativeProjection = await attachCurrentNativeReviewProjection({firmId,rows:transactionPayloads,currentRows});
  const currentNativeReviewRows = new Set(transactionPayloads.filter(row => row.processing_scope?.enforced === true
    && row.processing_scope.review_current === true && !row.processing_scope.pending
    && row.projection_freshness?.status === 'current' && currentRows.has(row.id)).map(row => currentRows.get(row.id)));
  // Activity consumes the same current transaction objects as the verified
  // projection. An old raw row or a same-id clone cannot inherit the exemption.
  const activityTransactions = transactionsResult.rows.map(row => currentRows.get(row.id) || row);
  // Job evidence is display metadata, never a replacement terminal verdict.
  const processingById = await withFirmDbClient(client => readReconcileActivityWithClient(client, {
        firmId, transactions: activityTransactions, documents: documentsResult.rows, matches: reconciliationResult.rows, observedAt,
        currentNativeReviewRows,
        readinessByClient: new Map(clients.map(client => [client.id, client.runtime_readiness]))
      }));
  for (const tx of transactionPayloads) tx.processing_activity = processingById.get(tx.id) || null;
  for (const doc of documentPayloads) doc.processing_activity = processingById.get(`document:${doc.id}`) || null;
  // Phase 7.2b-ii — surface the persisted bank-line disposition verdict on the
  // feed rows, a read-model derivation over the already-persisted verdict (like
  // attachAgreementEvidenceChecks below): render the verdict, never re-infer.
  // INV-4 — a live settling match outranks the verdict, so settled lines drop.
  const settledTransactionIds = new Set(
    (reconciliationResult.rows || [])
      .filter((m) => m.status === 'confirmed' || m.status === 'auto_matched')
      .map((m) => m.bank_transaction_id)
      .filter(Boolean)
  );
  const bankLineDispositionByTx = summarizeBankLineDispositions(
    bankLineDispositionResult.rows || [],
    { settledTransactionIds }
  );
  for (const tx of transactionPayloads) {
    const disposition = bankLineDispositionByTx.get(tx.id);
    if (disposition) tx.bank_line_disposition = disposition;
  }
  // Step 4 — the single reconciliation terminal-state derivation (design §10 Step 4 /
  // §8 / INV-13). Read the latest reconciliation GoalReport (the append-only
  // loop_goal_reports written by Step 3 — NOT the latest_goal_report_id pointer, NOT
  // transactions.reconciliation_status) for each bank line's reconciliation case, and
  // let the verdict OUTRANK the legacy column when present. This kills the #315 class
  // by construction: no surface renders the legacy field over the verdict, because the
  // field IS the verdict whenever one exists. Absent (pre-037 / shadow never produced
  // one) → the legacy value stands, so this is additive and inert until then. Like the
  // disposition enrichment above: render the persisted verdict, never re-infer.
  const reconCaseIdByTx = new Map();
  for (const tx of transactionPayloads) {
    const caseId = buildCaseId({
      firmId, clientId: tx.client_id, caseType: 'reconciliation',
      primaryObjectType: 'transaction', primaryObjectId: tx.id
    });
    if (caseId) reconCaseIdByTx.set(tx.id, caseId);
  }
  const reconGoalReportByCase = await readLatestGoalReportsForCases({
    client: await loadPgPool(), firmId, caseIds: [...reconCaseIdByTx.values()]
  });
  for (const tx of transactionPayloads) {
    const report = reconGoalReportByCase.get(reconCaseIdByTx.get(tx.id));
    if (!report) continue;
    const terminal = deriveReconciliationTerminalState(report, { legacyStatus: tx.reconciliation_status });
    tx.reconciliation_terminal_state = terminal;
    // Only a present, terminal verdict overrides the legacy column; an indeterminate
    // verdict defers to it (a pending proposed match never flips a settled line).
    if (terminal.verdict_present && terminal.reconciliation_status) {
      tx.reconciliation_status = terminal.reconciliation_status;
    }
  }
  // The single convergence verdict per reconcile row (CLAUDE.md, the FIRST
  // principle) — RT-17 PR 8: READ from the persisted column (RT-13, migration
  // 137), which every writer derives inside its own transaction through the
  // ONE module (reconcileConvergenceState). `rowToTransactionPayload` carries
  // `convergence_state` / `convergence_reason` off the row, so the feed, the
  // Reconcile UI's filter, the review case files and the metric below all
  // render the SAME persisted verdict — no in-memory re-projection, no ask
  // set rebuilt from a capped read, no second implementation of the law.
  const enrichedTxById = new Map(transactionPayloads.map((tx) => [tx.id, tx]));
  const documentsWithEvidence = attachAgreementEvidenceChecks({
    documents: documentPayloads,
    transactions: transactionPayloads,
    clients
  });
  // Slice J — the convergence metrics backend's live consumer. Aggregate the
  // SAME projected feed rows (deduped one-per-tx) into hanging_by_reason /
  // prompts_per_100 / authority_misses, per client + firm-wide. Read-only and
  // additive: rides the rows already loaded (no extra query), changes no
  // behaviour, and uses the SAME projection module the rendered chips do so the
  // metric and the feed never disagree. Computed off `reviewItemPayloads` so the
  // queue is mapped once and reused in the return below.
  const reviewItemPayloads = transactionReviewResult.rows.map(rowToTransactionReviewPayload);
  // Doc-first terminal drain (Slice 1): the no-line document population —
  // violations AND terminalized rows — enters the SAME metric, so "PARSED ·
  // AWAITING A BANK LINE" finally counts as hanging instead of being
  // invisible to convergence. Membership comes from the shared selector
  // (one rule with the Reconcile section); rows project through
  // convergenceForUnmatchedDocument off the flattened doc payloads.
  const noLineDocRows = selectNoLineReconcilableDocs({
    documents: documentPayloads,
    reconciliationMatches: reconciliationResult.rows,
    reviewItems: reviewItemPayloads,
    clientEvidenceRequests: evidenceRequestResult.rows
  });
  const convergenceMetrics = convergenceMetricsFromPersistedVerdicts([
    ...transactionPayloads,
    ...noLineDocRows.map((row) => row.document)
  ]);

  if (nativeProjection) {
    Object.assign(convergenceMetrics.overall,{projection_freshness:nativeProjection,accounting_ready:false,converged:false});
    for (const [clientId,freshness] of Object.entries(nativeProjection.by_client)) {
      if (convergenceMetrics.by_client[clientId]) Object.assign(convergenceMetrics.by_client[clientId],
        {projection_freshness:freshness,accounting_ready:false,converged:false});
    }
  }
  return {
    ...(nativeProjection ? {projection_freshness:nativeProjection,accounting_ready:false,converged:false} : {}),
    source: 'database',
    firm: firm
      ? {
          id: firm.id,
          name: firm.name,
          slug: firm.slug,
          jurisdiction: firm.jurisdiction,
          defaultCurrency: firm.default_currency,
          metadata: firm.metadata || {}
        }
      : null,
    runtimeReadinessHost,
    members: membersResult.rows,
    collaborators: collaboratorsResult.rows,
    assignments: assignmentsResult.rows,
    clients,
    documents: documentsWithEvidence,
    recentUploadBatches,
    transactions: transactionPayloads,
    accountingRules: rowsToPayloads(rulesResult.rows),
    clientRules: clientRulesResult.rows,
    merchants: merchantsResult.rows,
    xeroConnections: xeroConnectionsResult.rows.map(rowToXeroConnectionPayload),
    xeroAccounts: xeroAccountsResult.rows.map(rowToXeroAccountPayload),
    xeroContacts: xeroContactsResult.rows.map(rowToXeroContactPayload),
    xeroSyncRuns: xeroSyncRunsResult.rows,
    ledgerAccounts: ledgerAccountsResult.rows.map(rowToLedgerAccountPayload),
    ledgerJournals: ledgerJournalsResult.rows.map(rowToLedgerJournalPayload),
    ledgerLines: ledgerLinesResult.rows.map(rowToLedgerLinePayload),
    closePeriods: closePeriodsResult.rows.map(rowToClosePeriodPayload),
    closeChecks: closeChecksResult.rows,
    closeArchives: closeArchivesResult.rows.map(rowToCloseArchivePayload),
    clientEvidenceRequests,
    reconciliationMatches: reconciliationResult.rows,
    convergenceMetrics,
    // A review case file renders its transaction's persisted verdict: the
    // writers derive the column review-item-first (an open case file's payload
    // is an input to the ONE derivation), so the file and its line can never
    // disagree (RT-17 PR 8).
    transactionReviewQueue: reviewItemPayloads
      .map((item) => {
        const tx = enrichedTxById.get(item.payload?.transaction_id || item.item_id) || {};
        return { ...item, convergence_state: tx.convergence_state ?? null, convergence_reason: tx.convergence_reason ?? null,
          ...(tx.processing_scope ? {processing_scope:tx.processing_scope,projection_freshness:tx.projection_freshness,accounting_ready:false} : {}) };
      }),
    queue: rowsToPayloads(queueResult.rows),
    history: rowsToPayloads(historyResult.rows),
    // Always [] — see the projection-minimisation note above. The key is kept
    // so the snapshot shape is stable for any consumer doing `?? []`, and so the
    // source lint keeps checking it.
    llmDecisions: llmDecisionsResult.rows
  };
};
