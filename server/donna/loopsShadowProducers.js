// Donna Loops — shadow producers + backfill (Phase 1, slices 1.4 / 1.4a).
//
// Best-effort, post-commit hooks that OBSERVE existing write sites and record
// shadow workflow state. They are:
//   - gated by LOOPS_SHADOW (default OFF — every hook is a no-op when unset)
//   - table-presence guarded (pre-migration safe)
//   - wrapped in their own mini-transaction, no-throw BY CONTRACT: a shadow
//     failure can NEVER break the real flow it observes. The hooks run AFTER
//     the business commit, in a separate transaction on the same connection,
//     so a poisoned shadow statement can't abort the already-committed work.
//
// No LLM, no external calls, no accounting writes, no client-visible sends.
// This module does NOT import firmDb (no cycle): the post-commit hooks receive
// the live `client`; backfill is handed a `client` by its caller.

import {
  openOrFindCase, appendCaseEvent, linkObject, openBlocker, buildCaseId, resolveBlocker,
  markCaseResolved, loopsTablesPresent
} from './caseManager.js';
import { insertLoopEvent } from './loopEventInbox.js';
import { enqueueOutbox } from './loopEventOutbox.js';
import { decideLoopExecution, isLoopSystemEnabled, readFirmExecutionContext } from './loopExecutionGate.js';
import { clientFlagActs, clientFlagObserves, readClientConfigSnapshot } from './clientConfig.js';
import { retractAsksSettledByAutoExplain } from './reconciliationTwinAging.js';
import { runBankLineDispositionForClient } from './bankLineDispositionLlm.js';
import {
  BANK_LINE_DISPOSITION_CHALLENGER_LANE,
  bankLineDispositionChallengerConfigured,
  makeBankLineDispositionChallengerHook
} from './bankLineDispositionChallenger.js';
import { readLaneDecidingPolicy } from './modelLanePolicy.js';
import { RECONCILIATION_REASONING_LANE } from './reconciliationReasoningChallenger.js';
import { runDocumentDispositionForClient } from './documentDispositionLlm.js';
import { runDocumentSettlementEntriesForClient } from './documentSettlementEntry.js';
import { runDocumentSettlementReversalsForClient } from './documentSettlementReversal.js';
// Constants come from the dependency-free leaf: the gap-guard SQL below
// references them at MODULE INIT, and importing them through the producer
// (which pulls the core ↔ firmDb cycle) would hit the TDZ.
import {
  DOCUMENT_NO_LINE_DISPOSITION_FAMILY,
  DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY
} from './documentDispositionShape.js';
import { RECONCILIATION_GAP_GOAL, evaluateReconciliationGoal } from './loopGoalRegistry.js';
import { DOCUMENT_MATCH_TYPES_LOCKSTEP } from './reconcileConvergenceState.js';
import { DOCUMENT_CORRECTION_SUPERSEDED_BY } from './reconciliationProviderFailure.js';
import { persistGoalSpec, recordGoalReport, loopGoalTablesPresent, recordCaseDependency } from './loopGoalStore.js';
import { ASK_DRAFT_IDENTITY_CONTRACT } from './askPipeline.js';

// LEGACY raw-env predicate — a known straggler of the S3 tier-master
// migration. The producers below no longer use it (see runShadow); it stays
// exported for its remaining callers (api.js loop routes,
// feedChatProposalShadow.js), each of which needs its own deliberate
// re-point, not a silent semantics flip from here.
export const isLoopsShadowEnabled = () => {
  const raw = String(process.env.LOOPS_SHADOW || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
};

// Run a producer's writes post-commit in their own best-effort mini-transaction.
// No-throw: the business flow already committed; a shadow failure is swallowed.
//
// GATE (2026-08-24): isLoopSystemEnabled — the tier master (LOOPS_TIER,
// legacy LOOPS_SHADOW as fallback via globalLoopTier) — NOT the raw legacy
// predicate above. The desktop appliance ships LOOPS_TIER=canary and never
// sets LOOPS_SHADOW (hostRuntimeDefaults.js), so the raw predicate silently
// no-oped EVERY producer there: verdicts landed, but the verdict→gap→ask
// chain never ran — 28 bank lines resting open with no owner ask (the
// 2026-08-24 Cactus Blossom finding). Same bug, one seam deeper than the S3
// route fix (desktopRuntimePosture.test.js "loop cron tasks gate on the
// TIER master"); cloud behavior is byte-identical (globalLoopTier honors
// LOOPS_SHADOW when LOOPS_TIER is absent).
const runShadow = async (client, work) => {
  if (!isLoopSystemEnabled() || !client) return null;
  let began = false;
  try {
    if (!(await loopsTablesPresent(client))) return null;
    await client.query('begin');
    began = true;
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    if (began) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
    }
    try {
      console.warn(`[loops-shadow] producer swallowed error: ${error?.message || error}`);
    } catch { /* never throw from the logger */ }
    return null;
  }
};

// F5 — the UNTRANSACTED twin of runShadow for the strong-model drains: same
// LOOPS_SHADOW gate, same table guard, same swallow-everything no-throw
// contract, but NO wrapping begin/commit. The tree's own rule ("never hold a
// txn open across a network call — the firm pool is max 2",
// documentDispositionLlm's 4a answer leg) applies to the sweeps too: a
// backlog drain is N sequential model calls at seconds each, and one open
// transaction across them starves every concurrent reconcile/parse on the
// firm AND rolls back N−1 already-paid-for verdicts on a single late throw.
// `work` owns its own transaction posture — the disposition producers commit
// per item, so each verdict survives independently.
const runShadowUntransacted = async (client, work) => {
  if (!isLoopSystemEnabled() || !client) return null;
  try {
    if (!(await loopsTablesPresent(client))) return null;
    return await work();
  } catch (error) {
    try {
      console.warn(`[loops-shadow] producer swallowed error: ${error?.message || error}`);
    } catch { /* never throw from the logger */ }
    return null;
  }
};

// ── Shared per-entity mappings (no env gate, no txn — composed by hooks +
//    backfill, each of which owns the gating/transaction posture) ────────────

// 122 — the blocker's owner follows the ask's AUDIENCE (askAudience.js): a
// client ask blocks on the client (unchanged, and every caller that passes no
// audience keeps that behavior byte-identically); a seat ask blocks on a
// customer-side human via the firm lane ('firm' is the 033 enum's vocabulary
// for it); an agent ask is Donna-owed work ('system') — never a resting state.
const ASK_BLOCKER_OWNER_TYPE = Object.freeze({ client: 'client', seat: 'firm', agent: 'system' });

const openEvidenceCase = async ({ client, firmId, clientId, evidenceRequestId, transactionId = null, question = null, sent = false, audience = 'client' }) => {
  if (!evidenceRequestId) return null;
  const askAudience = ASK_BLOCKER_OWNER_TYPE[audience] ? audience : 'client';
  const kase = await openOrFindCase({
    client, firmId, clientId, caseType: 'evidence',
    primaryObject: { type: 'client_evidence_request', id: evidenceRequestId },
    title: question ? String(question).slice(0, 200) : null,
    summary: askAudience === 'client' ? 'Client evidence requested.' : 'Evidence requested.'
  });
  if (!kase) return null;
  await appendCaseEvent({
    client, firmId, clientId, caseId: kase.id,
    eventType: sent ? 'evidence_request.sent' : 'evidence_request.created',
    objectType: 'client_evidence_request', objectId: evidenceRequestId,
    payload: { transaction_id: transactionId || null, audience: askAudience }
  });
  await linkObject({ client, firmId, clientId, caseId: kase.id, objectType: 'client_evidence_request', objectId: evidenceRequestId, role: 'evidence' });
  if (transactionId) {
    await linkObject({ client, firmId, clientId, caseId: kase.id, objectType: 'transaction', objectId: transactionId, role: 'primary' });
  }
  await openBlocker({
    client, firmId, clientId, caseId: kase.id,
    blockerType: 'missing_client_answer', ownerType: ASK_BLOCKER_OWNER_TYPE[askAudience],
    objectType: 'client_evidence_request', objectId: evidenceRequestId,
    reason: askAudience === 'client'
      ? 'Awaiting client reply to evidence request.'
      : `Awaiting ${askAudience} reply to evidence request.`
  });
  return kase;
};

// §6.2 cross-type edge — `coding blocks reconciliation` (the third link in the
// design's upload→evidence→coding→reconciliation→close chain). When a client answer
// resolves a coding (ask-batch) case, the reconciliation case for the bank line that
// answer was about should re-evaluate. The edge is parent = coding C, child =
// reconciliation R, verb `blocks`, so a committed goal-MET coding wake's
// `case.resolved(C)` (engine-emitted) fans out through the Step-7 dispatcher to R as
// `dependency.resolved`. The downstream reconciliation wake evaluator + the
// dispatcher already exist; this is ONLY the missing edge.
//
// Trap 1 (ordering): the coding case (born at ask-batch send) and the reconciliation
// case (born later, on a no_match verdict / backfill) are created at different times,
// so the edge is written idempotently from BOTH sides — whichever case exists second
// records it; recordCaseDependency dedups on (parent, child, type). Trap 2 (stale
// verdict): the re-wake re-projects R's PERSISTED verdict (read-only, INV-12), so the
// edge alone does not CLOSE the gap — that needs a fresh upstream re-match. This slice
// is the edge only.
//
// Linkage data: an evidence request carries the bank line (`transaction_id` column)
// and its batch (`request_payload->>'ask_batch_id'`); the coding case is anchored on
// the batch, the reconciliation case on the transaction — so both deterministic case
// ids are derivable from those two columns. Both helpers existence-check the
// looked-up case (the dependencies FK requires both endpoints to exist) and skip when
// it isn't there yet (the other side will link on its creation).

// Ask-batch side: link a freshly-opened coding case to any reconciliation case that
// ALREADY exists on a bank line one of the batch's questions is about.
const linkCodingCaseToExistingReconciliationCases = async ({ client, firmId, clientId, codingCaseId, batchId }) => {
  if (!codingCaseId || !batchId) return { linked: 0 };
  const res = await client.query(
    `select distinct transaction_id from client_evidence_requests
      where firm_id = $1 and request_payload->>'ask_batch_id' = $2
        and transaction_id is not null`,
    [firmId, batchId]
  ).catch(() => ({ rows: [] }));
  let linked = 0;
  for (const row of res.rows) {
    const txId = row.transaction_id;
    // Trap 1: if the reconciliation case doesn't exist yet, the recon-open side links.
    if (!(await caseExists(client, firmId, clientId, 'reconciliation', 'transaction', txId))) continue;
    const dep = await recordCaseDependency({
      client, firmId, clientId, relationshipType: 'blocks',
      parentCaseId: codingCaseId,
      childCaseId: buildCaseId({ firmId, clientId, caseType: 'reconciliation', primaryObjectType: 'transaction', primaryObjectId: txId })
    });
    if (dep?.inserted) linked += 1;
  }
  return { linked };
};

// Recon-open side: link a freshly-opened reconciliation gap case (on a bank line) to
// any coding case whose ask batch covers that line. Path: transaction → evidence
// request (`transaction_id`) → ask batch (`request_payload->>'ask_batch_id'`) →
// coding case (anchored on the batch).
const linkReconciliationCaseToExistingCodingCases = async ({ client, firmId, clientId, reconCaseId, transactionId }) => {
  if (!reconCaseId || !transactionId) return { linked: 0 };
  const res = await client.query(
    `select distinct request_payload->>'ask_batch_id' as ask_batch_id
       from client_evidence_requests
      where firm_id = $1 and transaction_id = $2
        and request_payload->>'ask_batch_id' is not null`,
    [firmId, transactionId]
  ).catch(() => ({ rows: [] }));
  let linked = 0;
  for (const row of res.rows) {
    const batchId = row.ask_batch_id;
    if (!batchId) continue;
    // Trap 1: if the coding case doesn't exist (yet), the ask-batch side links.
    if (!(await caseExists(client, firmId, clientId, 'coding', 'client_ask_batch', batchId))) continue;
    const dep = await recordCaseDependency({
      client, firmId, clientId, relationshipType: 'blocks',
      parentCaseId: buildCaseId({ firmId, clientId, caseType: 'coding', primaryObjectType: 'client_ask_batch', primaryObjectId: batchId }),
      childCaseId: reconCaseId
    });
    if (dep?.inserted) linked += 1;
  }
  return { linked };
};

const openAskBatchCase = async ({ client, firmId, clientId, batchId, evidenceRequestIds = [] }) => {
  if (!batchId) return null;
  const kase = await openOrFindCase({
    client, firmId, clientId, caseType: 'coding',
    primaryObject: { type: 'client_ask_batch', id: batchId },
    summary: 'Client ask batch sent.'
  });
  if (!kase) return null;
  await appendCaseEvent({
    client, firmId, clientId, caseId: kase.id,
    eventType: 'ask_batch.sent', objectType: 'client_ask_batch', objectId: batchId,
    payload: { evidence_request_count: evidenceRequestIds.length }
  });
  await linkObject({ client, firmId, clientId, caseId: kase.id, objectType: 'client_ask_batch', objectId: batchId, role: 'primary' });
  await openBlocker({
    client, firmId, clientId, caseId: kase.id,
    blockerType: 'missing_client_answer', ownerType: 'client',
    objectType: 'client_ask_batch', objectId: batchId,
    reason: 'Awaiting client answers to the sent ask batch.'
  });
  // Each blocking question also rides its own evidence case, AND a typed
  // dependency edge: the evidence case BLOCKS this coding case (§6.2 "Evidence
  // case E blocks coding case C", parent = E, child = C). When E resolves (the
  // client answers), the Step-7 dispatcher fans a `dependency.resolved` event out
  // to this coding case, which re-evaluates "are all my questions answered?".
  // Idempotent: recordCaseDependency dedups on (parent, child, type).
  for (const reqId of evidenceRequestIds) {
    const evidenceCase = await openEvidenceCase({ client, firmId, clientId, evidenceRequestId: reqId, sent: true });
    if (evidenceCase?.id) {
      await recordCaseDependency({
        client, firmId, clientId,
        parentCaseId: evidenceCase.id, childCaseId: kase.id, relationshipType: 'blocks'
      });
    }
  }
  // §6.2 cross-type edge (ask-batch side): coding C blocks the reconciliation case
  // for any bank line this batch's questions cover, if that recon case already exists.
  // Trap 1 — when it opens later, the recon-open side writes the edge instead.
  await linkCodingCaseToExistingReconciliationCases({ client, firmId, clientId, codingCaseId: kase.id, batchId });
  return kase;
};

const openUploadCase = async ({ client, firmId, clientId, documentId, blockerType = 'parse_failed', parseError = null, parseRunId = null }) => {
  if (!documentId) return null;
  const kase = await openOrFindCase({
    client, firmId, clientId, caseType: 'upload',
    primaryObject: { type: 'document', id: documentId },
    summary: 'Document upload could not be read.'
  });
  if (!kase) return null;
  await appendCaseEvent({
    client, firmId, clientId, caseId: kase.id,
    eventType: 'document.parse_failed', objectType: 'document', objectId: documentId,
    payload: { blocker_type: blockerType, parse_run_id: parseRunId || null, parse_error_code: parseError?.code || null }
  });
  await linkObject({ client, firmId, clientId, caseId: kase.id, objectType: 'document', objectId: documentId, role: 'blocking_document' });
  await openBlocker({
    client, firmId, clientId, caseId: kase.id,
    blockerType, ownerType: 'system',
    objectType: 'document', objectId: documentId,
    reason: parseError?.safe_user_message || parseError?.code || 'Parse failed.'
  });
  return kase;
};

// Diagnostic blocker reason for a stuck (not-yet-failed) upload. Rail #3 —
// diagnose, don't guess: carry the OBSERVED stage / progress / age onto the
// reason string the Phase-4 dashboard renders, so a "stuck reading" doc is
// explained from data rather than a UI label. No content, only mechanical state.
const buildStuckReason = ({ parseStatus, parseStage, progressCurrent, progressTotal, staleSeconds }) => {
  const age = staleSeconds != null && Number.isFinite(Number(staleSeconds))
    ? `${Math.round(Number(staleSeconds))}s` : 'a while';
  if (parseStatus === 'pending') {
    return `Upload queued ${age} ago but parsing hasn't started.`;
  }
  const stage = parseStage ? ` at stage '${parseStage}'` : '';
  const progress = progressTotal != null
    ? ` (${Number(progressCurrent || 0)}/${Number(progressTotal)})` : '';
  return `Parsing stalled ${age}${stage}${progress}.`;
};

// Phase 5 — Upload Triage (stuck-upload sweep). A doc registered but stuck in
// 'pending' (queued, never picked up by a worker) or 'processing' (worker
// stalled mid-parse) past the stale threshold is NOT a hard failure yet — it's
// an in-flight upload nobody is watching. Open its upload case with a SOFT
// system blocker (parse_pending for a never-started doc → it's still pending;
// parse_stale for a stalled one) so it surfaces on the Phase-4 close-blocker
// dashboard as waiting_system, instead of being silently lost between the
// failed-parse hook and the stuck-PROCESSING cron (which never scans 'pending').
// §7-compliant: keyed off parse_status + a stale heartbeat/enqueue clock, never
// the document's CONTENT (INV-12). Idempotent — the deterministic upload-case id
// + openBlocker's equivalent-open dedup make re-sweeping the same stuck doc a
// no-op, and resumeUploadCaseOnParseCompleted clears the blocker the moment it
// finally parses (parse_pending / parse_stale are both in its resolve set).
const openStuckUploadCase = async ({
  client, firmId, clientId, documentId, parseStatus, parseRunId = null,
  parseStage = null, progressCurrent = null, progressTotal = null, staleSeconds = null
}) => {
  if (!documentId) return null;
  const blockerType = parseStatus === 'pending' ? 'parse_pending' : 'parse_stale';
  const kase = await openOrFindCase({
    client, firmId, clientId, caseType: 'upload',
    primaryObject: { type: 'document', id: documentId },
    summary: 'Document upload is taking longer than expected to read.'
  });
  if (!kase) return null;
  await appendCaseEvent({
    client, firmId, clientId, caseId: kase.id,
    eventType: 'document.parse_stuck', objectType: 'document', objectId: documentId,
    payload: {
      blocker_type: blockerType, parse_status: parseStatus, parse_run_id: parseRunId || null,
      parse_stage: parseStage || null,
      parse_progress: progressTotal != null
        ? { current: Number(progressCurrent || 0), total: Number(progressTotal) } : null,
      stale_seconds: staleSeconds != null && Number.isFinite(Number(staleSeconds)) ? Number(staleSeconds) : null
    }
  });
  await linkObject({ client, firmId, clientId, caseId: kase.id, objectType: 'document', objectId: documentId, role: 'blocking_document' });
  await openBlocker({
    client, firmId, clientId, caseId: kase.id,
    blockerType, ownerType: 'system',
    objectType: 'document', objectId: documentId,
    reason: buildStuckReason({ parseStatus, parseStage, progressCurrent, progressTotal, staleSeconds })
  });
  return kase;
};

// Phase 5 — Upload Triage: parse-completed auto-resume. The upload-case producers
// OPEN a case + a parse blocker when a parse FAILS (markParseFailedInDb →
// parse_failed) or STALLS (failStuckProcessingRowsInDb → parse_stale). This is the
// CLOSING half: when a previously-failed/stuck document is retried and finally
// parses, resolve its open parse blocker(s) so the upload case lifts off
// blocked/waiting_system and drops off the Phase-4 close-blocker dashboard. The
// upload-side analog of Phase 3's evidence-reply auto-resume. §7-compliant: the
// mechanical truth is the parse COMPLETING (an event), never the document's CONTENT
// (INV-12). It looks the case up by its deterministic id and NEVER opens one on
// success — a healthy first-parse has no upload case, so this is a no-op there
// (and idempotent on a duplicate completion: the second pass finds no open blocker).
const resumeUploadCaseOnParseCompleted = async ({ client, firmId, clientId, documentId, parseRunId = null, summary = null }) => {
  if (!documentId) return null;
  const caseId = buildCaseId({
    firmId, clientId, caseType: 'upload',
    primaryObjectType: 'document', primaryObjectId: documentId
  });
  if (!caseId) return null;
  const open = await client.query(
    `select id from bookkeeping_case_blockers
      where case_id = $1 and status = 'open'
        and blocker_type in ('parse_pending', 'parse_failed', 'parse_stale')
      order by created_at asc, id asc`,
    [caseId]
  );
  if (open.rows.length === 0) return null; // no upload case / nothing blocked → no-op
  const completedEvent = await appendCaseEvent({
    client, firmId, clientId, caseId,
    eventType: 'document.parse_completed', objectType: 'document', objectId: documentId,
    payload: { parse_run_id: parseRunId || null, transaction_count: Number(summary?.transaction_count || 0) }
  });
  let resolved = 0;
  let status = null;
  for (const b of open.rows) {
    const r = await resolveBlocker({
      client, blockerId: b.id,
      resolutionEventId: completedEvent?.id || null,
      reason: 'Document parsed successfully.'
    });
    if (r.resolved) { resolved += 1; status = r.status; }
  }
  if (resolved > 0) {
    const terminal = await markCaseResolved({
      client, firmId, clientId, caseId,
      reason: 'Document parsed successfully.',
      triggerEventId: completedEvent?.id || null
    });
    status = terminal?.status || status;
  }
  return { caseId, resolved, status };
};

// Phase 7 — Reconciliation-graph gap case. A reconciliation TARGET (an invoice /
// bill document, or a bank line) the matcher could not settle is a gap a human
// must resolve. Two mechanical shapes:
//   - 'unmatched_verdict'      — a PERSISTED reconciliation_evaluations verdict of
//                                no_match / no_candidates with no live match
//                                outranking it (the Failure-B class).
//   - 'unevaluated_obligation' — an unpaid item that never even reached the
//                                matcher (no evaluation row, no settled match).
// Open a reconciliation case anchored on the target with an `unclear_match`
// blocker (ownerType firm → waiting_firm), so it surfaces on the Phase-4 close
// dashboard. Renders the PERSISTED verdict (rail #1): the verdict /
// unmatchable_reason / model ride the event payload + reason; it NEVER re-runs
// matching (no LLM — the Loops hard non-goal). §7-compliant: keyed off persisted
// workflow columns (verdict, payment_status, match status), never the document's
// CONTENT (INV-12). Idempotent via the deterministic reconciliation-case id +
// openBlocker's equivalent-open dedup; onReconciliationMatchConfirmed closes it
// when a live match finally settles the target.
// Phase 7.2 — bank-line DISPOSITION verdicts (target_type 'transaction',
// from bankLineDispositionLlm.js) carry their own reasons. A bare debit
// was never "seeking a bank line to match", so render it as an
// unexplained line needing review, not "no matching bank line found".
// These two reason tokens are minted only by the disposition producer.
// These no_match gaps are OWNER-owned (waiting_client — evaluateReconciliationGoal
// flips them off the firm lane): the close-dashboard reason names what the OWNER
// must supply, mirroring the ask the ask-pipeline drafts. evidence_needed (the
// money-in chase_evidence sibling) joins needs_human_review / receipt_needed.
const DISPOSITION_GAP_REASON = {
  needs_human_review: 'Unexplained bank line — needs the owner to clarify what this is (no document, not auto-explainable).',
  receipt_needed: 'Unexplained bank line — the owner should provide the supporting receipt.',
  evidence_needed: 'Unexplained deposit — the owner should provide the payout report or invoice.'
};

const buildReconciliationGapReason = ({ gapKind, verdict, unmatchableReason, targetType, blockerType }) => {
  if (gapKind === 'unevaluated_obligation') {
    return 'Unpaid item not yet reconciled to a bank line (no matcher run).';
  }
  // Step 3 — a no_candidates verdict is now a TYPED blocker (missing_bank_statement,
  // from the registry evaluator) rather than a vague "no eligible lines": the firm
  // must upload the covering statement. Rendered from the persisted verdict, never a re-run.
  if (blockerType === 'missing_bank_statement') {
    return 'Upload the bank statement covering this period so the line can be matched.';
  }
  if (unmatchableReason && DISPOSITION_GAP_REASON[unmatchableReason]) {
    return DISPOSITION_GAP_REASON[unmatchableReason];
  }
  const why = unmatchableReason ? ` (${String(unmatchableReason).slice(0, 100)})` : '';
  // A bank-line target is the line itself — "no bank line found" is the
  // wrong frame for it (that's a document-anchored verdict).
  if (targetType === 'transaction') {
    return `Unexplained bank line could not be reconciled${why}.`;
  }
  const verdictLabel = verdict === 'no_candidates'
    ? 'No eligible bank lines to match against'
    : 'No matching bank line found';
  return `${verdictLabel}${why}.`;
};

const reconciliationGapSummary = ({ gapKind, targetType }) => {
  if (gapKind === 'unevaluated_obligation') return 'An unpaid item has not been reconciled to a bank line.';
  if (targetType === 'transaction') return 'An unexplained bank line needs review.';
  return 'A document could not be reconciled to a bank line.';
};

// blockerType / ownerType default to the firm-owned unclear_match the gap producers
// always used; Step 3 lets the registry evaluator's desiredCase override them (e.g.
// no_candidates → missing_bank_statement) so the typed blocker lives in one place.
const openReconciliationGapCase = async ({
  client, firmId, clientId, targetType, targetId,
  gapKind = 'unmatched_verdict', verdict = null, unmatchableReason = null, model = null,
  blockerType = 'unclear_match', ownerType = 'firm'
}) => {
  if (!targetType || !targetId) return null;
  const kase = await openOrFindCase({
    client, firmId, clientId, caseType: 'reconciliation',
    primaryObject: { type: targetType, id: targetId },
    summary: reconciliationGapSummary({ gapKind, targetType })
  });
  if (!kase) return null;
  await appendCaseEvent({
    client, firmId, clientId, caseId: kase.id,
    eventType: 'reconciliation.gap_detected', objectType: targetType, objectId: targetId,
    modelName: model || null,
    payload: {
      blocker_type: blockerType, gap_kind: gapKind,
      verdict: verdict || null, unmatchable_reason: unmatchableReason || null, model: model || null
    }
  });
  await linkObject({ client, firmId, clientId, caseId: kase.id, objectType: targetType, objectId: targetId, role: 'primary' });
  await openBlocker({
    client, firmId, clientId, caseId: kase.id,
    blockerType, ownerType,
    objectType: targetType, objectId: targetId,
    reason: buildReconciliationGapReason({ gapKind, verdict, unmatchableReason, targetType, blockerType })
  });
  // §6.2 cross-type edge (recon-open side): only a bank-line (transaction) gap can be
  // blocked by a coding case — link any coding case whose ask batch covers this line.
  // Trap 1 — when the coding case opened first, recordCaseDependency dedups the overlap.
  if (targetType === 'transaction') {
    await linkReconciliationCaseToExistingCodingCases({ client, firmId, clientId, reconCaseId: kase.id, transactionId: targetId });
  }
  return kase;
};

// ── Step 3 — collapse the gap projection onto the registry evaluator ─────────
//
// Design §10 Step 3 / §13.2. The verdict was DECIDED upstream (reconciliationLlmCore,
// persisted in reconciliation_evaluations); loopGoalRegistry.evaluateReconciliationGoal
// is the ONE declarative place that projects that persisted state (+ live match state,
// INV-4) into { goalReport, action, desiredCase } — replacing the verdict→blocker
// branching the audit found duplicated across scan A / the forward hook / the close
// hook. Each producer now gathers PERSISTED state, asks the evaluator, performs the
// action, and persists the GoalReport. Workflow-only; never re-matches, never an LLM.

// Persist the reconciliation GoalReport for a case (§13.2). The bookkeeping_case_events
// pointer is MANDATORY: append a 'goal_evaluated' event FIRST and pass its id, so every
// report is reachable from the single append-only audit stream. Presence-guarded on the
// 037 goal tables so a pre-037 deploy degrades to a clean no-op (and never leaves a
// goal_evaluated event with no report behind it). Best-effort like the rest of the module.
const recordReconciliationGoalReport = async ({
  client, firmId, clientId, caseId, goalReport, model = null, triggerEventId = null
}) => {
  if (!caseId || !goalReport) return null;
  if (!(await loopGoalTablesPresent(client))) return null;
  const spec = await persistGoalSpec({ client, spec: RECONCILIATION_GAP_GOAL });
  const evt = await appendCaseEvent({
    client, firmId, clientId, caseId,
    eventType: 'goal_evaluated', triggerEventId, modelName: model || null,
    payload: {
      goal_key: goalReport.goalKey, goal_version: goalReport.goalVersion,
      status: goalReport.status, next_unmet_conditions: goalReport.nextUnmetConditions || []
    }
  });
  if (!evt?.id) return null; // no pointer → refuse to write the report (§13.2)
  return recordGoalReport({
    client, firmId, clientId, caseId, eventId: evt.id, goalReport,
    goalSpecHash: spec?.goalSpecHash || null, source: 'evaluation'
  });
};

// Project one target's PERSISTED state through the evaluator and act on the verdict:
// open the gap case (unmet) with the evaluator's TYPED desiredCase, then persist the
// GoalReport on it. A non-open_gap verdict (met/indeterminate at this site) opens
// nothing. Returns { action, kase, goalReport } so callers can keep their counting.
// Failure-B firm-limbo guard (the smaller half): a DOCUMENT the matcher could not
// place whose amount is ALREADY accounted for by a SETTLED bank line is corroborating
// a line the books already closed — not firm work. The strong matcher should have said
// 'already_settled'; the weighted matcher often misses an exact-amount line and returns
// 'no_plausible_match' (CLAUDE.md Failure-B). We do NOT create a match or re-code — we
// only decline to open (and, via resolve_gap, self-heal) firm limbo when a settled line
// already covers the amount. Conservative: exact net-amount match on a settled line, same
// currency when both are known. Read-only; best-effort (a failed read = no suppression).
export const __documentCoveredBySettledLine = async ({ client, firmId, clientId, documentId } = {}) => {
  if (!documentId) return false;
  const docRes = await client.query(
    `select total_amount, currency from documents
      where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
    [firmId, clientId, documentId]
  ).catch(() => ({ rows: [] }));
  const doc = docRes.rows[0];
  const amount = doc?.total_amount == null ? null : Math.abs(Number(doc.total_amount));
  if (!amount || !Number.isFinite(amount) || amount <= 0) return false;
  const currency = doc?.currency || null;
  const hit = await client.query(
    `select 1 from transactions t
      where t.firm_id = $1 and t.client_id = $2
        and t.reconciliation_status in ('reconciled', 'posted', 'auto_reconciled', 'explained')
        and (abs(coalesce(t.money_out, 0)) = $3 or abs(coalesce(t.money_in, 0)) = $3)
        and ($4::text is null or t.currency is null or t.currency = $4)
      limit 1`,
    [firmId, clientId, amount, currency]
  ).catch(() => ({ rows: [] }));
  return hit.rows.length > 0;
};

const projectReconciliationGap = async ({
  client, firmId, clientId, targetType, targetId, state = {}, model = null
}) => {
  // A document-anchored no_match whose amount a settled bank line already covers is
  // corroboration, not a firm gap (see __documentCoveredBySettledLine). Computed here
  // (the evaluator is pure) and honored exactly like the matcher's 'already_settled'.
  const coveredBySettledLine = (targetType === 'document' && state.verdict === 'no_match')
    ? await __documentCoveredBySettledLine({ client, firmId, clientId, documentId: targetId })
    : false;
  const { goalReport, action, desiredCase } = evaluateReconciliationGoal({
    verdict: state.verdict ?? null,
    unmatchableReason: state.unmatchableReason ?? null,
    hasStickyMatch: state.hasStickyMatch ?? false,
    paymentStatus: state.paymentStatus ?? null,
    hasAnyMatch: state.hasAnyMatch ?? false,
    hasEvaluation: state.hasEvaluation ?? (state.verdict != null),
    coveredBySettledLine
  });
  // resolve_gap — a SETTLED target (the matcher's 'already_settled' verdict here; a
  // sticky match is handled by the dedicated close hook): close any open gap on this
  // target instead of opening one. Self-heals the false "no matching bank line
  // (already_settled)" blockers the prior open-on-any-no_match behaviour created, on
  // the next reconcile pass. No-op (no open blocker) for a settled target that never
  // had a gap, so it never clutters either.
  if (action === 'resolve_gap') {
    const r = await resolveReconciliationGapCaseOnMatch({
      client, firmId, clientId,
      matchedObjectType: targetType === 'transaction' ? null : targetType,
      matchedObjectId: targetType === 'transaction' ? null : targetId,
      bankTransactionId: targetType === 'transaction' ? targetId : null
    });
    return { action, kase: null, goalReport, resolved: r?.resolved || 0 };
  }
  if (action !== 'open_gap' || !desiredCase) return { action, kase: null, goalReport };
  const kase = await openReconciliationGapCase({
    client, firmId, clientId, targetType, targetId,
    gapKind: desiredCase.gapKind, blockerType: desiredCase.blockerType, ownerType: desiredCase.ownerType,
    verdict: state.verdict ?? null, unmatchableReason: state.unmatchableReason ?? null, model
  });
  if (kase) {
    await recordReconciliationGoalReport({ client, firmId, clientId, caseId: kase.id, goalReport, model });
  }
  return { action, kase, goalReport };
};

// Phase 7 — the CLOSING half. When a reconciliation match is confirmed /
// auto-matched (the live row now outranks the verdict — INV-4 "decided rows are
// sticky"), resolve the open `unclear_match` blocker on the gap case so it lifts
// off the close dashboard. The gap case may be anchored on the document (the
// match's matched_object) OR the bank line (target_type 'transaction'), so both
// deterministic anchors are checked. The reconciliation analog of Phase 5's
// parse-completed auto-resume; never opens a case (no gap → no-op), idempotent on
// a duplicate confirm (no open blocker the second pass).
// `reason` / `goalInput` are optional overrides for a NON-match settle (the
// doc-first drain's auto_explain resolves a stale doc gap with an honest
// "explained" receipt instead of claiming a match confirmed); defaults keep
// every existing call site byte-identical.
const resolveReconciliationGapCaseOnMatch = async ({
  client, firmId, clientId, matchedObjectType, matchedObjectId, bankTransactionId,
  reason = 'A reconciliation match was confirmed.',
  goalInput = { hasStickyMatch: true }
}) => {
  const candidateCaseIds = [];
  if (matchedObjectId) {
    // Reconciliation evaluations/cases use the canonical workflow type
    // `document`; match rows use the concrete accounting subtype
    // (`supplier_bill`, `sales_invoice`, `receipt`, ...). Close the canonical
    // case first, while retaining the concrete key for any legacy case minted
    // before the workflow vocabulary was unified.
    for (const objectType of new Set(['document', matchedObjectType].filter(Boolean))) {
      const docCaseId = buildCaseId({
        firmId, clientId, caseType: 'reconciliation',
        primaryObjectType: objectType, primaryObjectId: matchedObjectId
      });
      if (docCaseId) candidateCaseIds.push(docCaseId);
    }
  }
  if (bankTransactionId) {
    const txCaseId = buildCaseId({
      firmId, clientId, caseType: 'reconciliation',
      primaryObjectType: 'transaction', primaryObjectId: bankTransactionId
    });
    if (txCaseId) candidateCaseIds.push(txCaseId);
  }
  if (candidateCaseIds.length === 0) return null;
  const open = await client.query(
    `select id from bookkeeping_case_blockers
      where case_id = any($1) and status = 'open' and blocker_type = 'unclear_match'
      order by created_at asc, id asc`,
    [candidateCaseIds]
  );
  if (open.rows.length === 0) return null; // no gap case / nothing blocked → no-op
  let resolved = 0;
  let status = null;
  const resolvedCaseIds = new Set();
  for (const b of open.rows) {
    const r = await resolveBlocker({ client, blockerId: b.id, reason });
    if (r.resolved) { resolved += 1; status = r.status; if (r.caseId) resolvedCaseIds.add(r.caseId); }
  }
  // Step 3 — the resolve_gap arm of the single evaluator: a sticky match settles the
  // target (INV-4 → goal met), so persist a MET GoalReport per settled case alongside
  // the blocker resolution. Same declarative verdict the gap-open arm reads.
  // (The doc-drain caller passes goalInput { verdict: 'auto_explained' } so the MET
  // report carries the honest auto_explained evidence, not a fabricated sticky match.)
  if (resolvedCaseIds.size > 0) {
    const { goalReport } = evaluateReconciliationGoal(goalInput);
    for (const caseId of resolvedCaseIds) {
      await recordReconciliationGoalReport({ client, firmId, clientId, caseId, goalReport });
      const terminal = await markCaseResolved({
        client, firmId, clientId, caseId, reason
      });
      status = terminal?.status || status;
    }
  }
  return { resolved, status };
};

const recordReplyInbox = async ({ client, firmId, clientId, evidenceRequestId, replyEventId, transactionId = null }) => {
  if (!evidenceRequestId || !replyEventId) return null;
  // Inbox-only in Phase 1: record the at-least-once event + link the reply to
  // its evidence case. Do NOT interpret, resolve, send, or create memory.
  const ev = await insertLoopEvent({
    client, firmId, clientId, source: 'client_portal',
    sourceEventId: replyEventId, eventType: 'client_reply.received',
    objectType: 'client_evidence_request', objectId: evidenceRequestId,
    payload: { transaction_id: transactionId || null }
  });
  const kase = await openOrFindCase({
    client, firmId, clientId, caseType: 'evidence',
    primaryObject: { type: 'client_evidence_request', id: evidenceRequestId }
  });
  if (kase) {
    await appendCaseEvent({
      client, firmId, clientId, caseId: kase.id,
      eventType: 'client_reply.received', objectType: 'client_evidence_request', objectId: evidenceRequestId,
      triggerEventId: ev?.id || null, payload: { transaction_id: transactionId || null }
    });
    await linkObject({ client, firmId, clientId, caseId: kase.id, objectType: 'client_evidence_request', objectId: evidenceRequestId, role: 'client_reply' });
  }
  return ev;
};

// ── Public post-commit hooks (slice 1.4) ────────────────────────────────────

export const onEvidenceRequestCreated = async ({ client, firmId, clientId, evidenceRequest } = {}) =>
  runShadow(client, () => openEvidenceCase({
    client, firmId, clientId,
    evidenceRequestId: evidenceRequest?.id,
    transactionId: evidenceRequest?.transaction_id || evidenceRequest?.payload?.transaction_id || null,
    question: evidenceRequest?.question || null,
    audience: evidenceRequest?.audience || 'client'
  }));

export const onAskBatchSent = async ({ client, firmId, clientId, batchId, evidenceRequestIds = [] } = {}) =>
  runShadow(client, () => openAskBatchCase({ client, firmId, clientId, batchId, evidenceRequestIds }));

export const onDocumentParseFailed = async ({ client, firmId, clientId, documentId, blockerType = 'parse_failed', parseError = null, parseRunId = null } = {}) =>
  runShadow(client, () => openUploadCase({ client, firmId, clientId, documentId, blockerType, parseError, parseRunId }));

export const onDocumentParseCompleted = async ({ client, firmId, clientId, documentId, parseRunId = null, summary = null } = {}) =>
  runShadow(client, () => resumeUploadCaseOnParseCompleted({ client, firmId, clientId, documentId, parseRunId, summary }));

export const onClientReplyReceived = async ({ client, firmId, clientId, evidenceRequestId, replyEventId, transactionId = null } = {}) =>
  runShadow(client, () => recordReplyInbox({ client, firmId, clientId, evidenceRequestId, replyEventId, transactionId }));

// Phase 6.1's forward memory-candidate producer (`onMemoryFactDistilled`) is
// DELETED by DMEM-R1 W1 (2026-09-04, audit F-02 / S04): it observed an ACTIVE
// firm_facts mint and staged the candidate already `promoted`, so the front
// gate stood behind the door. The distiller's one entry point is now
// firmFacts.js distillAndStageFirmFactCandidates, which stages `suggested` /
// `conflicted` candidates and mints no fact — one producer, gated on the
// MEMORY_CANDIDATES posture, no observer to keep in lock-step.

// Phase 7 post-commit hook: when a reconciliation match is confirmed /
// auto-matched, resolve the open reconciliation-gap blocker for the settled
// target. runShadow-wrapped (post-commit, no-throw, LOOPS_SHADOW-gated) so it
// never affects the match write it rides. Only the settling statuses act — a
// 'suggested'/'rejected' patch leaves any gap case standing.
export const onReconciliationMatchConfirmed = async ({
  client, firmId, clientId, matchedObjectType = null, matchedObjectId = null,
  bankTransactionId = null, status = null
} = {}) => {
  if (status !== 'confirmed' && status !== 'auto_matched') return null;
  return runShadow(client, () => resolveReconciliationGapCaseOnMatch({
    client, firmId, clientId, matchedObjectType, matchedObjectId, bankTransactionId
  }));
};

// Phase 8 / §13.10 — the goal-REGRESSION producers (Step 7's `goal.regressed`
// input). "Met once" is NOT "met forever": a goal that was MET can be INVALIDATED
// later (a settled match rejected, a corrected total moving the target, an
// externally-voided posting, retracted evidence — the REGRESSION_KINDS). Each
// producer below OBSERVES one such write site and enqueues a `goal.regressed`
// outbox row (INV-8: post-commit, inside runShadow's mini-txn) for the case(s) the
// invalidated state had resolved. We DECIDE nothing — the Step-7 dispatcher's pure
// decideRegression reopens (or IGNORES, when the goal was never met) against the
// case's CURRENT report; the dispatcher (canary+) reopens + re-wakes, while at
// shadow the row simply waits (HELD), exactly the careful-canary posture. Keep-layer
// movers: no verdict, no accounting write.
//
// §13.10 shared core: enqueue a `goal.regressed` outbox row (INV-8) for each
// EXISTING case in candidateCaseIds, carrying the typed regression event the
// dispatcher's pure decideRegression validates. We DECIDE nothing here — the
// dispatcher reopens, or IGNORES (a case whose goal was never met is correctly
// left alone), against the case's CURRENT report. Self-filters to cases that
// actually exist so the outbox stays free of dead rows (the dispatcher would no-op
// an absent case anyway). `regressionId` is the deterministic per-event id
// ("<kind>:<sourceId>"): it makes BOTH the regression event id and the outbox
// idempotencyKey deterministic, so a redelivery dedups (§13.4). Returns { enqueued }.
const enqueueGoalRegressionForCases = async ({
  client, firmId, clientId, candidateCaseIds = [], regressionId, kind, regressionDetail = null
}) => {
  const ids = [...new Set((candidateCaseIds || []).filter(Boolean))];
  if (ids.length === 0) return { enqueued: 0 };
  const present = await client.query(
    `select id from bookkeeping_cases where firm_id = $1 and id = any($2)`,
    [firmId, ids]
  );
  let enqueued = 0;
  for (const row of present.rows) {
    const caseId = row.id;
    const out = await enqueueOutbox({
      client, firmId, clientId,
      eventType: 'goal.regressed',
      objectType: 'bookkeeping_case', objectId: caseId,
      payload: {
        case_id: caseId,
        // { id, kind } is the regression event decideRegression validates; the
        // deterministic per-event id makes the dispatcher's reopen idempotent.
        // `regressionDetail` (W1) rides alongside — e.g. a material correction's
        // fresh_evaluation_required — and is not part of the validated event.
        regression: { id: regressionId, kind },
        ...(regressionDetail && typeof regressionDetail === 'object' ? regressionDetail : {}),
        idempotencyKey: `goal_regressed:${regressionId}:${caseId}`
      }
    });
    if (out?.id) enqueued += 1;
  }
  return { enqueued };
};

// match_rejected (INV-4 reversed, the Failure-B class): a previously-SETTLED match
// later un-settled leaves a stale `met` verdict on a resolved reconciliation case.
// Enqueue for the SAME dual anchor (document + bank line) the confirm hook resolves;
// the regression id is deterministic per match so a redelivery dedups.
const enqueueGoalRegressionForRejectedMatch = async ({
  client, firmId, clientId, matchId, matchedObjectType, matchedObjectId, bankTransactionId
}) => {
  // The SAME dual anchor (document + bank line) the confirm hook resolves.
  const candidateCaseIds = [];
  if (matchedObjectType && matchedObjectId) {
    candidateCaseIds.push(buildCaseId({
      firmId, clientId, caseType: 'reconciliation',
      primaryObjectType: matchedObjectType, primaryObjectId: matchedObjectId
    }));
  }
  if (bankTransactionId) {
    candidateCaseIds.push(buildCaseId({
      firmId, clientId, caseType: 'reconciliation',
      primaryObjectType: 'transaction', primaryObjectId: bankTransactionId
    }));
  }
  return enqueueGoalRegressionForCases({
    client, firmId, clientId, candidateCaseIds,
    regressionId: `match_rejected:${matchId}`, kind: 'match_rejected'
  });
};

// Phase 8 post-commit hook: a reconciliation match patch that REJECTS a previously
// settled match. Only the settled→rejected transition regresses a goal — a still-
// suggested match that's rejected never met anything (and the dispatcher would
// ignore it), so the caller passes `wasSettled` (prev status confirmed/auto_matched)
// and this self-filters, mirroring onReconciliationMatchConfirmed's status guard.
// runShadow-wrapped: post-commit, no-throw, LOOPS_SHADOW-gated — it can never affect
// the match write it rides.
export const onReconciliationMatchRejected = async ({
  client, firmId, clientId, matchId = null, matchedObjectType = null,
  matchedObjectId = null, bankTransactionId = null, status = null, wasSettled = false
} = {}) => {
  if (status !== 'rejected' || !wasSettled || !matchId) return null;
  return runShadow(client, () => enqueueGoalRegressionForRejectedMatch({
    client, firmId, clientId, matchId, matchedObjectType, matchedObjectId, bankTransactionId
  }));
};

// §13.10 — the corrected document fields that MOVE a reconciliation match's basis,
// so a settled match built on the old value may no longer hold. counterparty_role +
// document_type are the Failure-A direction/reclassification cascade; total/tax
// amounts, the document/due dates, and payment_status are the numeric/temporal basis
// the matcher settles on. A free-text reference_number or a vendor/customer-name
// cleanup is deliberately NOT here: a confirmed match is a human/strong-model verdict
// we will not un-settle on a name/reference typo fix. The set is the conservative
// "moved the goal's TARGET" gate; widen it only with a reason.
export const MATERIAL_CORRECTION_FIELDS = new Set([
  'total_amount', 'tax_amount', 'currency', 'document_date', 'due_date',
  'counterparty_role', 'document_type', 'payment_status'
]);

// DMEM-R1 W1 + FI-02 (doctrine §2.6 steps 4 and 8, INV-11; audit F-08, S02):
// a MATERIAL correction makes every SETTLED match on the corrected document
// ineligible IMMEDIATELY (`payload.invalidated_by_correction` +
// `fresh_evaluation_required`, read by the wake evaluator as "not sticky") and
// supersedes every live verdict on the document — each was judged on a value
// that no longer exists. Runs inside the CORRECTION WRITER's transaction
// (documentCorrections.js), ungated: this is reconciliation correctness, not
// loop workflow, so it holds on every host whatever its loop tier. The status
// move (settled → suggested, the line reopened) is the named match writer's,
// run right after the correction commits; the fresh evaluation is the family
// re-drive's (reconciliationProviderFailure.js). Receipted per match.
export const invalidateReconciliationForCorrectedDocument = async ({
  client, firmId, clientId, documentId, correctionId, fieldPath
}) => {
  if (!client || !documentId || !correctionId || !MATERIAL_CORRECTION_FIELDS.has(fieldPath)) {
    return { invalidated: [], bank_transaction_ids: [], superseded_evaluations: [] };
  }
  const invalidatedAt = new Date().toISOString();
  const marker = {
    invalidated_by_correction: { correction_id: correctionId, field_path: fieldPath, invalidated_at: invalidatedAt },
    fresh_evaluation_required: true
  };
  // A document match carries its FAMILY as matched_object_type ('supplier_bill',
  // 'receipt', … or 'document') — the lockstep set reconcileConvergenceState
  // reads, never a literal 'document'.
  const res = await client.query(
    `update reconciliation_matches
        set payload = coalesce(payload, '{}'::jsonb) || $4::jsonb,
            updated_at = now()
      where firm_id = $1 and client_id = $2
        and matched_object_type = any($6::text[]) and matched_object_id = $3
        and status in ('confirmed', 'auto_matched')
        and coalesce(payload->'invalidated_by_correction'->>'correction_id', '') <> $5
      returning id, bank_transaction_id, status`,
    [firmId, clientId, documentId, JSON.stringify(marker), correctionId, [...DOCUMENT_MATCH_TYPES_LOCKSTEP]]
  );
  for (const row of res.rows || []) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'reconciliation_match.invalidated_by_correction', 'reconciliation_match', $3, $4::jsonb)`,
      [firmId, clientId, row.id, JSON.stringify({
        document_id: documentId, bank_transaction_id: row.bank_transaction_id, match_status: row.status,
        correction_id: correctionId, field_path: fieldPath, fresh_evaluation_required: true
      })]
    );
  }
  // The live verdicts on the document (shadow rows stay observational). The
  // prior verdict rides the payload, the 'superseded' vocabulary the credit-note
  // reversal and the bank-line supersede already write.
  const superseded = await client.query(
    `update reconciliation_evaluations
        set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
              'prior_verdict', verdict,
              'superseded_by', $4::text,
              'correction_id', $5::text,
              'field_path', $6::text,
              'superseded_at', $7::text),
            verdict = 'superseded',
            evaluated_at = now()
      where firm_id = $1 and client_id = $2 and target_type = 'document' and target_id = $3
        and verdict <> 'superseded'
        and payload->>'matcher_mode' is distinct from 'shadow'
      returning id`,
    [firmId, clientId, documentId, DOCUMENT_CORRECTION_SUPERSEDED_BY, correctionId, fieldPath, invalidatedAt]
  );
  return {
    invalidated: (res.rows || []).map((row) => row.id),
    bank_transaction_ids: [...new Set((res.rows || []).map((row) => row.bank_transaction_id).filter(Boolean))],
    superseded_evaluations: (superseded.rows || []).map((row) => row.id)
  };
};

const enqueueGoalRegressionForCorrectedDocument = async ({
  client, firmId, clientId, documentId, correctionId, fieldPath, invalidatedMatchIds = [], bankTransactionIds = []
}) => {
  // The SAME dual anchor the reject hook regresses: the document, and every
  // bank line an invalidated match settled (that line's case carries the met
  // report the convergence gather would otherwise keep reading as settled).
  const candidateCaseIds = [buildCaseId({
    firmId, clientId, caseType: 'reconciliation',
    primaryObjectType: 'document', primaryObjectId: documentId
  })];
  for (const transactionId of bankTransactionIds || []) {
    candidateCaseIds.push(buildCaseId({
      firmId, clientId, caseType: 'reconciliation',
      primaryObjectType: 'transaction', primaryObjectId: transactionId
    }));
  }
  const regression = await enqueueGoalRegressionForCases({
    client, firmId, clientId,
    candidateCaseIds,
    regressionId: `document_corrected:${correctionId}`, kind: 'document_corrected',
    regressionDetail: {
      fresh_evaluation_required: true,
      correction: { id: correctionId, field_path: fieldPath, document_id: documentId },
      invalidated_match_ids: invalidatedMatchIds
    }
  });
  return { ...regression, invalidated_match_ids: invalidatedMatchIds };
};

// Phase 8 / §13.10 post-commit hook: a MATERIAL document correction (totals, dates,
// direction/type, payment status — MATERIAL_CORRECTION_FIELDS) may have moved the
// basis a settled reconciliation match was built on, so the reconciliation case the
// match resolved must re-evaluate (the document_corrected kind). It self-filters to
// material fields — a reference_number / name cleanup won't un-settle a confirmed
// match — and enqueues a `goal.regressed` row for the reconciliation case anchored on
// the document. We DECIDE nothing: the dispatcher's decideRegression reopens it only
// if its goal was actually MET (a never-settled / unmatched document has no met report
// → ignored). runShadow-wrapped: post-commit, no-throw, LOOPS_SHADOW-gated — it can
// never affect the correction write it rides. correctionId makes the regression
// id/key deterministic so a redelivery dedups (§13.4). The accounting half (the
// invalidation, the verdict supersede, the reopen, the fresh evaluation) is NOT
// here: it is ungated and owned by the correction writer (FI-02);
// `invalidatedMatchIds` is that half's receipt, carried on the regression.
export const onDocumentCorrected = async ({
  client, firmId, clientId, documentId = null, fieldPath = null, correctionId = null,
  invalidatedMatchIds = [], bankTransactionIds = []
} = {}) => {
  if (!documentId || !correctionId || !MATERIAL_CORRECTION_FIELDS.has(fieldPath)) return null;
  const result = await runShadow(client, () => enqueueGoalRegressionForCorrectedDocument({
    client, firmId, clientId, documentId, correctionId, fieldPath, invalidatedMatchIds, bankTransactionIds
  }));
  // The correction is already committed. Re-enter the existing bounded producer
  // so a currency repair can supersede a refused settlement proposal and reach
  // its named writer without waiting for another upload or reparse.
  if (fieldPath === 'currency') {
    let decidingPolicy = null;
    try {
      decidingPolicy = await readLaneDecidingPolicy({ client, firmId, clientId, laneId: RECONCILIATION_REASONING_LANE });
    } catch { decidingPolicy = null; }
    await runDocumentSettlementEntriesForClient({ client, firmId, clientId, documentIds: [documentId], decidingPolicy });
  }
  return result;
};

// Phase 7.1 — the forward (real-time) OPEN half, the complement of the 7.0
// backfill scan. After a reconciliation run commits, read the just-persisted
// verdict for one target and, if it is a `no_match` with no live sticky match
// outranking it (INV-4), open the gap case immediately instead of waiting for
// the sweep. Renders the PERSISTED verdict (rail #1) — it never re-matches or
// calls the model; the SELECT mirrors the sweep's scan A, scoped to one target.
//
// `no_match` ONLY — NOT `no_candidates`. At parse time `no_candidates` usually
// means the matching bank statement isn't uploaded yet (a transient "not yet",
// not a gap), so opening on it would raise a waiting_firm case on every fresh
// invoice. Genuine `no_candidates` / unevaluated obligations stay the sweep's job.

// Doc-first terminal drain (Slice 2) — two guards shared by the forward hook
// and the backfill's scan A, so the gap projection honours the doc drain:
//   1. A SHADOW-mode disposition verdict is observational — it must never
//      become the "latest no_match" the gap open projects (a shadow row
//      changing which reason/owner a gap gets is shadow leaking into live).
//   2. A doc the ACT-mode drain settled (documents.payload.no_line_disposition
//      = auto_explain — the same persisted verdict Slice 1's UI and the
//      convergence metric read) must not RE-open a firm gap off its older
//      family no_match row on the next matcher re-sweep.
const DOC_DISPOSITION_GAP_GUARDS = `
        and (e.matcher_family <> '${DOCUMENT_NO_LINE_DISPOSITION_FAMILY}'
             or e.payload->>'matcher_mode' is distinct from 'shadow')
        and not exists (
          select 1 from documents sd
           where e.target_type = 'document'
             and sd.firm_id = e.firm_id and sd.client_id = e.client_id
             and sd.id = e.target_id
             and sd.payload->'no_line_disposition'->>'disposition' = 'auto_explain'
        )`;

const openReconciliationGapForUnmatchedTarget = async ({
  client, firmId, clientId, targetType, targetId
}) => {
  if (!targetType || !targetId) return null;
  const res = await client.query(
    `select e.verdict, e.unmatchable_reason, e.model
       from reconciliation_evaluations e
      where e.firm_id = $1 and e.client_id = $2
        and e.target_type = $3 and e.target_id = $4
        and e.verdict = 'no_match'
        and not exists (
          select 1 from reconciliation_matches m
           where m.firm_id = e.firm_id and m.client_id = e.client_id
             and m.status in ('confirmed', 'auto_matched', 'rejected')
             and (
               (e.target_type = 'transaction' and m.bank_transaction_id = e.target_id)
               or (e.target_type <> 'transaction'
                   and m.matched_object_type = e.target_type and m.matched_object_id = e.target_id)
             )
        )${DOC_DISPOSITION_GAP_GUARDS}
      order by e.evaluated_at desc
      limit 1`,
    [firmId, clientId, targetType, targetId]
  );
  const row = res.rows[0];
  if (!row) return null;
  // The query already enforces no_match + no sticky match (INV-4); route the open
  // through the single evaluator so the same verdict is projected and its GoalReport
  // persisted. Real-time policy unchanged: only no_match opens here (no_candidates
  // stays the sweep's job — a fresh invoice whose statement isn't uploaded yet).
  const { kase } = await projectReconciliationGap({
    client, firmId, clientId, targetType, targetId,
    state: { verdict: row.verdict, unmatchableReason: row.unmatchable_reason, hasStickyMatch: false },
    model: row.model
  });
  return kase;
};

// ── Slice 5 (autonomous-loop demo) — the close-blocker LIFECYCLE fix ──────────
//
// The open producer above (Phase 7.1) only ever OPENED a gap on a no_match verdict;
// nothing in the SWEEP path ever CLOSED or RELABELED one when a later run settled or
// proposed a match. Two stale-blocker bugs fell out of that asymmetry:
//   - Gap 2 (the Dadant class): a bulk-sweep `auto_matched` is sticky (INV-4) but the
//     CLOSE producer (onReconciliationMatchConfirmed) is wired only into the interactive
//     match paths, never the sweep — so an earlier-opened gap stayed open forever.
//   - Gap 1 (proposed/suggested): a later sweep wrote a `suggested` (non-sticky) match +
//     a `proposed` verdict; evaluateReconciliationGoal('proposed') is indeterminate/noop,
//     so the open `unclear_match` blocker kept rendering the stale "no matching bank line"
//     text even though a candidate now existed.
// The verdict layer (evaluateReconciliationGoal / reconciliationTerminalState) is already
// CORRECT — this fixes the blocker LIFECYCLE only, never the judgment. The producer now
// reconciles EACH evaluated target's gap case to its FINAL state in one post-reconcile
// pass (see reconcileReconciliationGapForTarget).

// The live match state for one target: does a STICKY match (confirmed/auto_matched,
// INV-4) now outrank the verdict, or is there only a PROPOSED (suggested, non-sticky)
// match awaiting a human confirm? Anchor differs by target type — a bank line joins on
// bank_transaction_id, a document on matched_object_id. The workflow target
// type is canonically `document`, while match rows intentionally retain the
// concrete accounting subtype, so comparing those two type vocabularies would
// make every successful document match invisible to this close pass. bool_or
// over zero rows is null → coalesced false.
const readTargetMatchState = async ({ client, firmId, clientId, targetType, targetId }) => {
  // Params are built PER BRANCH: the transaction anchor references three
  // placeholders, the document anchor four. Passing an extra, unreferenced
  // parameter is a hard Postgres error ("could not determine data type of
  // parameter $3") — the 2026-08-25 appliance finding, latent until the
  // producer gate first opened for real bank-line targets.
  const anchor = targetType === 'transaction'
    ? 'm.bank_transaction_id = $3'
    : 'm.matched_object_id = $3';
  const params = targetType === 'transaction'
    ? [firmId, clientId, targetId]
    : [firmId, clientId, targetId];
  const res = await client.query(
    `select
       coalesce(bool_or(m.status in ('confirmed', 'auto_matched')), false) as has_sticky_match,
       coalesce(bool_or(m.status = 'suggested'), false) as has_suggested_match,
       coalesce(array_remove(array_agg(distinct m.bank_transaction_id)
         filter (where m.status in ('confirmed', 'auto_matched')), null), '{}')
         as sticky_bank_transaction_ids,
       coalesce(array_remove(array_agg(distinct m.bank_transaction_id)
         filter (where m.status = 'suggested'), null), '{}')
         as suggested_bank_transaction_ids
       from reconciliation_matches m
      where m.firm_id = $1 and m.client_id = $2 and ${anchor}`,
    params
  );
  const row = res.rows[0] || {};
  return {
    hasStickyMatch: Boolean(row.has_sticky_match),
    hasSuggestedMatch: Boolean(row.has_suggested_match),
    stickyBankTransactionIds: (row.sticky_bank_transaction_ids || []).map(String),
    suggestedBankTransactionIds: (row.suggested_bank_transaction_ids || []).map(String)
  };
};

// The reason a relabeled gap carries on the close dashboard. The end user (bookkeeper
// via admin, or business owner via the client portal) has the last say on unclear
// lines, so a proposed-but-unconfirmed match is surfaced as a confirm/reject decision,
// not silently resolved.
export const PROPOSED_MATCH_GAP_REASON =
  'A match was proposed — confirm or reject it to reconcile this line.';

// Gap 1 — the proposed-match RELABEL. A later sweep proposed a (suggested, non-sticky)
// match for a target that ALREADY carries an open unclear_match gap blocker: the line is
// no longer "no matching bank line", it is "a proposed match the human must confirm or
// reject". KEEP the blocker open (the line stays on the close dashboard) but rewrite its
// reason to the proposed-match prompt, and record the 'proposed' (indeterminate)
// GoalReport so the goal layer reads "awaiting confirmation" instead of the stale unmet
// gap. NEVER opens a case: a proposed match on a line that was never a gap has no open
// blocker to relabel → clean no-op. Idempotent — a re-sweep finds the reason already set
// and writes nothing.
const relabelReconciliationGapAsProposed = async ({
  client, firmId, clientId, targetType, targetId, model = null
}) => {
  const caseId = buildCaseId({
    firmId, clientId, caseType: 'reconciliation',
    primaryObjectType: targetType, primaryObjectId: targetId
  });
  if (!caseId) return null;
  const open = await client.query(
    `select id, reason from bookkeeping_case_blockers
      where case_id = $1 and status = 'open' and blocker_type = 'unclear_match'
      order by created_at asc, id asc`,
    [caseId]
  );
  if (open.rows.length === 0) return null; // no gap case / nothing to relabel → no-op
  let relabeled = 0;
  for (const b of open.rows) {
    if (b.reason === PROPOSED_MATCH_GAP_REASON) continue; // already relabeled → idempotent
    const upd = await client.query(
      `update bookkeeping_case_blockers
          set reason = $2, updated_at = now()
        where id = $1 and status = 'open'`,
      [b.id, PROPOSED_MATCH_GAP_REASON]
    );
    if ((upd.rowCount || 0) > 0) {
      relabeled += 1;
      // The blocker stayed open but its meaning changed — record the transition on the
      // append-only case stream (and bump last_activity_at so the line re-surfaces).
      await appendCaseEvent({
        client, firmId, clientId, caseId,
        eventType: 'reconciliation.gap_relabeled', objectType: targetType, objectId: targetId,
        modelName: model || null,
        payload: { blocker_id: b.id, blocker_type: 'unclear_match', verdict: 'proposed', reason: PROPOSED_MATCH_GAP_REASON }
      });
    }
  }
  // Goal-layer coherence: persist the 'proposed' (indeterminate) verdict so the
  // terminal-state read renders "awaiting confirmation", not the stale unmet gap. Same
  // declarative evaluator the open/resolve arms use — no new judgment.
  if (relabeled > 0) {
    const { goalReport } = evaluateReconciliationGoal({ verdict: 'proposed' });
    await recordReconciliationGoalReport({ client, firmId, clientId, caseId, goalReport, model });
  }
  return { relabeled };
};

// Reconcile ONE evaluated target's gap case to its FINAL state in a single
// post-reconcile pass, so a gap opened earlier in the loop is lifted/relabeled the
// moment the matcher settles or proposes a match — not left stale until an interactive
// click (Gap 2) or forever (Gap 1):
//   1. STICKY match (confirmed/auto_matched, INV-4) → CLOSE the gap (+ MET report),
//      reusing the same close helper the interactive paths use. Kills Gap 2.
//   2. PROPOSED (suggested, non-sticky) match → RELABEL any open gap to "confirm the
//      proposed match" (+ proposed report); the end user has the last say. Kills Gap 1.
//   3. otherwise → the original forward OPEN (a no_match verdict with no live match).
// Returns per-target counters for the caller's rollup.
const reconcileReconciliationGapForTarget = async ({
  client, firmId, clientId, targetType, targetId
}) => {
  const {
    hasStickyMatch,
    hasSuggestedMatch,
    stickyBankTransactionIds,
    suggestedBankTransactionIds
  } = await readTargetMatchState({
    client, firmId, clientId, targetType, targetId
  });

  // A document matcher writes one row that has TWO workflow anchors: the
  // document it evaluated and the bank transaction it settled/proposed. The
  // post-run sweep commonly receives only document targets, so project the
  // same persisted match state onto every named bank line here. Otherwise a
  // sticky match can close the document case while an earlier transaction gap
  // keeps asking the owner for the receipt Donna has just matched.
  if (targetType !== 'transaction' && (hasStickyMatch || hasSuggestedMatch)) {
    let resolved = 0;
    let relabeled = 0;
    if (hasStickyMatch) {
      const r = await resolveReconciliationGapCaseOnMatch({
        client, firmId, clientId,
        matchedObjectType: targetType, matchedObjectId: targetId,
        bankTransactionId: null
      });
      resolved += r?.resolved || 0;
    } else if (hasSuggestedMatch) {
      const r = await relabelReconciliationGapAsProposed({
        client, firmId, clientId, targetType, targetId
      });
      relabeled += r?.relabeled || 0;
    }
    for (const bankTransactionId of stickyBankTransactionIds) {
      const r = await resolveReconciliationGapCaseOnMatch({
        client, firmId, clientId,
        matchedObjectType: null, matchedObjectId: null, bankTransactionId
      });
      resolved += r?.resolved || 0;
    }
    const stickyIds = new Set(stickyBankTransactionIds);
    for (const bankTransactionId of suggestedBankTransactionIds) {
      if (stickyIds.has(bankTransactionId)) continue;
      const r = await relabelReconciliationGapAsProposed({
        client, firmId, clientId, targetType: 'transaction', targetId: bankTransactionId
      });
      relabeled += r?.relabeled || 0;
    }
    return { opened: 0, resolved, relabeled };
  }

  if (hasStickyMatch) {
    const r = await resolveReconciliationGapCaseOnMatch({
      client, firmId, clientId,
      matchedObjectType: targetType === 'transaction' ? null : targetType,
      matchedObjectId: targetType === 'transaction' ? null : targetId,
      bankTransactionId: targetType === 'transaction' ? targetId : null
    });
    return { opened: 0, resolved: r?.resolved || 0, relabeled: 0 };
  }

  if (hasSuggestedMatch) {
    const r = await relabelReconciliationGapAsProposed({
      client, firmId, clientId, targetType, targetId
    });
    return { opened: 0, resolved: 0, relabeled: r?.relabeled || 0 };
  }

  const kase = await openReconciliationGapForUnmatchedTarget({
    client, firmId, clientId, targetType, targetId
  });
  return { opened: kase ? 1 : 0, resolved: 0, relabeled: 0 };
};

// Doc-first terminal drain (Slice 2, docs/donna-doc-first-terminal-drain-plan.md).
// The document MIRROR of runReconciliationTerminalDrain: after the family matchers
// have had their chance at a document and found no line, ONE strong-model call
// (documentDispositionLlm.js) disposes it — auto_explain settles the row
// ("Explained"; the doc stays matcher-eligible for a late statement line),
// chase_evidence writes the no_match verdict Slice 3's ask leg turns into the
// owner question, needs_human stays the surfaced violation. Gated ENTIRELY on the
// config-plane flag DOCUMENT_NO_LINE_DISPOSITION (born on the plane: envFallback
// () => false, NO env pair; kill switch CLIENT_CONFIG_FORCE_DISABLE):
//   ∅ / off / dry_run → inert (this returns disabled — byte-identical to no drain)
//   shadow            → verdicts written (payload.matcher_mode 'shadow'), NOTHING
//                       acts: no payload merge, no gap change, no ask, no FYI
//   canary / auto     → act: auto_explain merges the payload verdict Slice 1
//                       renders + resolves any stale doc gap case.
// NOT shadow-wrapped itself: it runs INSIDE onReconciliationRunCompleted's
// UNTRANSACTED shadow pass (the plan's "same orchestrator pass" —
// parseDocumentsDb, isolation-listed, is not touched); the standalone export
// below wraps it for a direct sweep. F5: no caller holds a transaction across
// this — the disposition producer commits per doc, the gap resolutions below
// commit per case.
const documentTerminalDrainForClient = async ({
  client, firmId, clientId, documentIds = null, env = process.env, fetchImpl
}) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const flag = {
    flagKey: DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY,
    snapshot,
    envFallback: () => false, // born on the plane — a DB stage row is the ONLY on
    env
  };
  if (!clientFlagObserves(flag)) {
    return { disabled: true, reason: 'flag_off', mode: null, stats: null, settledDocIds: [] };
  }
  // The #1748 shape: the reconciliation_reasoning lane's active policy row
  // (the doc-disposition call rides that lane's core transport). Best-effort
  // read — missing table / no row ⇒ null ⇒ the strong default decides.
  let decidingPolicy = null;
  try {
    decidingPolicy = await readLaneDecidingPolicy({
      client, firmId, clientId, laneId: RECONCILIATION_REASONING_LANE
    });
  } catch { decidingPolicy = null; }
  const stats = await runDocumentDispositionForClient({
    client, firmId, clientId, documentIds,
    mode: clientFlagActs(flag) ? 'act' : 'shadow',
    fetchImpl,
    decidingPolicy
  });
  if (stats?.disabled) {
    return { disabled: true, reason: stats.disabled_reason, mode: null, stats, settledDocIds: [] };
  }
  // Act-mode auto_explain settles the doc — resolve any STALE open gap case a
  // prior family no_match had opened (the two-terminal close half; the honest
  // "explained" receipt, not a fabricated match confirm). Shadow settles nothing.
  // F5: the drain runs UNTRANSACTED (the sweep's model calls own per-doc
  // commits), so each gap resolution commits in its own mini-transaction —
  // a failed resolve rolls back that case only and never the sweep's verdicts.
  let resolvedGaps = 0;
  for (const docId of (stats?.settled_doc_ids || [])) {
    try {
      await client.query('begin');
      const r = await resolveReconciliationGapCaseOnMatch({
        client, firmId, clientId,
        matchedObjectType: 'document', matchedObjectId: docId, bankTransactionId: null,
        reason: 'Donna explained this document — settled outside the visible bank feed.',
        goalInput: { verdict: 'auto_explained' }
      });
      await client.query('commit');
      resolvedGaps += r?.resolved || 0;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      console.warn(`[loops-shadow] settled-doc gap resolve failed (verdict stands)`, {
        document_id: docId,
        error: error?.message || String(error)
      });
    }
  }
  return {
    disabled: false,
    mode: stats?.mode || null,
    stats,
    settledDocIds: stats?.settled_doc_ids || [],
    resolvedGaps
  };
};

// Standalone doc-drain entry point (backfill of the existing no-line backlog /
// tests / a future cron): the runShadow-wrapped twin of the inner pass above.
// documentIds null = full-client sweep (the incremental policy-version guard
// keeps re-sweeps cheap and verdicts stable).
export const runDocumentTerminalDrain = async ({
  client, firmId, clientId, documentIds = null, env = process.env, fetchImpl
} = {}) => {
  if (!firmId || !clientId) return null;
  // F5 — UNTRANSACTED: the full-client backlog sweep is exactly the shape that
  // used to hold one txn across hundreds of model calls; the producer commits
  // per doc now.
  const result = await runShadowUntransacted(client, () => documentTerminalDrainForClient({
    client, firmId, clientId, documentIds, env, fetchImpl
  }));
  // Slice 3 — a backlog sweep must drive its chase verdicts all the way to the
  // ask terminal, not leave them as verdict-only rows waiting for the next
  // reconcile tick: request the client's ask-batch (re)draft through the same
  // coalesced producer the reconcile-complete path uses (its own gating —
  // canary+ proposal_creation, parse quiescence — still applies). Called
  // AFTER the drain pass completes (its own runShadow owns a transaction).
  // Shadow mode never reaches here with chase counts acting on
  // anything, but the guard is on ACT mode explicitly all the same.
  if (result && !result.disabled && result.mode === 'act' && (result.stats?.chase_evidence || 0) > 0) {
    await onReconcileCompleteRequestAskDraft({ client, firmId, clientId, env });
  }
  // Slice 4b — the settlement-entry producer, called OUTSIDE runShadow
  // (runShadow's contract forbids accounting writes; the producer owns its
  // own per-doc transactions and routes every write through the named
  // writer). Own plane flag (DOCUMENT_SETTLEMENT_LEDGER_ENTRY, ∅ ⇒ inert);
  // documentIds=null on the standalone drain = the full settled-without-entry
  // backlog, which makes this sweep the backlog lever. No-throw by contract.
  if (result && !result.disabled) {
    // The #1748 shape: same lane policy as the disposition drain above —
    // best-effort read, null ⇒ the strong default decides.
    let settlementPolicy = null;
    try {
      settlementPolicy = await readLaneDecidingPolicy({
        client, firmId, clientId, laneId: RECONCILIATION_REASONING_LANE
      });
    } catch { settlementPolicy = null; }
    const settlement = await runDocumentSettlementEntriesForClient({
      client, firmId, clientId, documentIds, env, fetchImpl,
      decidingPolicy: settlementPolicy
    });
    if (settlement && !settlement.disabled) {
      result.settlementEntries = {
        mode: settlement.mode,
        gathered: settlement.gathered,
        cards_minted: settlement.cards_minted,
        posted: settlement.posted,
        rested_proposed: settlement.rested_proposed
      };
    }
    // The late-bank-line reversal guard (documentSettlementReversal.js):
    // entry-settled docs a bank line has since confirmed against. Same seam,
    // same flag, deterministic (no model call). No-throw by contract.
    const reversals = await runDocumentSettlementReversalsForClient({
      client, firmId, clientId, documentIds, env
    });
    if (reversals && !reversals.disabled) {
      result.settlementReversals = {
        mode: reversals.mode,
        gathered: reversals.gathered,
        cards_minted: reversals.cards_minted,
        reversed: reversals.reversed,
        self_healed: reversals.self_healed,
        rested_proposed: reversals.rested_proposed
      };
    }
  }
  return result;
};

// Phase 7.1 / Slice 5 public post-commit hook. Fired AFTER a reconciliation run
// commits, for the set of just-evaluated targets (the parse path passes the one
// parsed document; the bank-statement path passes every document its matcher loop
// touched). runShadow-wrapped: post-commit, no-throw, LOOPS_SHADOW-gated — it can
// never affect the matcher run it rides. Each target is reconciled to its FINAL
// state (Slice 5): CLOSE on a sticky match, RELABEL on a proposed/suggested one, or
// OPEN on a no_match — one pass, no multi-sweep churn. Idempotent: openOrFindCase +
// the open-blocker dedup + the relabel's reason guard mean a re-run is a no-op.
// Doc-first drain (Slice 2): the run's DOCUMENT targets are disposed FIRST — the
// family matchers just had their chance this cycle (the plan's quiescence), so a
// still-bare doc is exactly the drain's population — and a doc the drain settled
// skips gap projection (its gap, if any, was resolved inside the drain).
export const onReconciliationRunCompleted = async ({
  client, firmId, clientId, targets = [], env = process.env, fetchImpl
} = {}) => {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const docTargetIds = [...new Set(
    targets
      .filter((t) => (t?.targetType || 'document') === 'document' && t?.targetId)
      .map((t) => String(t.targetId))
  )];
  // F5 — one shadow envelope (single gate + table check), two transaction
  // postures inside. Phase 1, the doc drain's MODEL calls, runs UNTRANSACTED
  // (the producer commits per doc; one open txn across N Anthropic calls
  // starves the max-2 firm pool). Phase 2, the DB-only gap projection, runs
  // in its own explicit mini-transaction — a projection failure rolls back
  // the projection only, never the drain's already-committed verdicts.
  const shadowResult = await runShadowUntransacted(client, async () => {
    let docDrain = null;
    if (docTargetIds.length) {
      docDrain = await documentTerminalDrainForClient({
        client, firmId, clientId, documentIds: docTargetIds, env, fetchImpl
      });
    }
    const settledDocs = new Set(docDrain?.settledDocIds || []);
    let opened = 0;
    let resolved = docDrain?.resolvedGaps || 0;
    let relabeled = 0;
    const seen = new Set();
    await client.query('begin');
    try {
      for (const target of targets) {
        const targetType = target?.targetType || 'document';
        const targetId = target?.targetId;
        if (!targetId) continue;
        const key = `${targetType}:${targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (targetType === 'document' && settledDocs.has(String(targetId))) continue;
        const r = await reconcileReconciliationGapForTarget({
          client, firmId, clientId, targetType, targetId
        });
        opened += r.opened || 0;
        resolved += r.resolved || 0;
        relabeled += r.relabeled || 0;
      }
      await client.query('commit');
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      // Rethrow into the envelope's swallow — same null result the old
      // single-transaction failure produced.
      throw error;
    }
    return {
      opened, resolved, relabeled,
      docDrain: docDrain && !docDrain.disabled
        ? { mode: docDrain.mode, evaluated: docDrain.stats?.evaluated ?? 0, settled: settledDocs.size }
        : null
    };
  });
  // Slice 4b — the settlement-entry producer, AFTER the runShadow pass
  // returns (accounting writes are forbidden inside it; the producer owns
  // its own per-doc transactions and routes writes through the named
  // writer). Scoped to this run's document targets; own plane flag
  // (DOCUMENT_SETTLEMENT_LEDGER_ENTRY, ∅ ⇒ inert). No-throw by contract.
  if (shadowResult && docTargetIds.length) {
    // The #1748 shape: same lane policy as the disposition producer — best-
    // effort read, null ⇒ the strong default decides.
    let settlementPolicy = null;
    try {
      settlementPolicy = await readLaneDecidingPolicy({
        client, firmId, clientId, laneId: RECONCILIATION_REASONING_LANE
      });
    } catch { settlementPolicy = null; }
    const settlement = await runDocumentSettlementEntriesForClient({
      client, firmId, clientId, documentIds: docTargetIds, env, fetchImpl,
      decidingPolicy: settlementPolicy
    });
    if (settlement && !settlement.disabled) {
      shadowResult.settlementEntries = {
        mode: settlement.mode,
        gathered: settlement.gathered,
        cards_minted: settlement.cards_minted,
        posted: settlement.posted,
        rested_proposed: settlement.rested_proposed
      };
    }
    // The late-bank-line reversal guard — the run's doc targets that are
    // entry-settled AND now carry a settled bank-line match (a matcher pass
    // this run may have just confirmed one). Deterministic; no-throw.
    const reversals = await runDocumentSettlementReversalsForClient({
      client, firmId, clientId, documentIds: docTargetIds, env
    });
    if (reversals && !reversals.disabled) {
      shadowResult.settlementReversals = {
        mode: reversals.mode,
        gathered: reversals.gathered,
        cards_minted: reversals.cards_minted,
        reversed: reversals.reversed,
        self_healed: reversals.self_healed,
        rested_proposed: reversals.rested_proposed
      };
    }
  }
  return shadowResult;
};

// Ask-escalation parse-quiescence canary (RECONCILIATION_ASK_QUIESCENCE_GATE (+ _CLIENTS)).
// During a mass upload the bank-statement side can race to a `no_match` disposition and
// escalate a bare line to an OWNER ASK while a still-parsing receipt that would auto-match
// the line sits in the parse queue. Live root cause (Honeybee, Aug $26.83 POS CHEVRON): the
// receipt finished parsing 18s AFTER the owner reply had already explained the line, so it
// could never bind and the ask was avoidable. Escalating to the owner while the system itself
// still holds the substantiating evidence in flight is the forbidden third state under
// CLAUDE.md's two-terminal-states principle — the line rested 'on owner' when there was still
// something WE could do. When ON, onReconcileCompleteRequestAskDraft DEFERS the ask-batch
// draft for any client that still has documents parsing; the late doc's own parse-completion
// re-runs reconcile, which binds the receipt (or asks then if the line is genuinely bare).
// Off → byte-identical (no quiescence check). Fail-closed, client-scoped; mirrors
// appliedReviewStateColumnSyncAllows. NEVER widen by deleting the _CLIENTS allowlist while on.
//
// 0A.6c: this env predicate is now the FALLBACK behind the config control plane —
// onReconcileCompleteRequestAskDraft passes `() => askEscalationQuiescenceGateAllows(clientId, env)`
// as clientFlagActs' envFallback, so a client with no client_capability_config row keeps
// exactly this behaviour. The flag key is shared with the config plane via
// ASK_QUIESCENCE_GATE_FLAG_KEY so the env master var and the DB flag_key can never drift
// (mirrors MATERIAL_AUTO_FYI_FLAG_KEY).
export const ASK_QUIESCENCE_GATE_FLAG_KEY = 'RECONCILIATION_ASK_QUIESCENCE_GATE';
export const askEscalationQuiescenceGateAllows = (clientId, env = process.env) => {
  const flag = String(env?.[ASK_QUIESCENCE_GATE_FLAG_KEY] ?? '').trim().toLowerCase();
  if (!(flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes')) return false;
  const raw = env?.[`${ASK_QUIESCENCE_GATE_FLAG_KEY}_CLIENTS`];
  const allow = raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!allow || !allow.length) return true; // flag on, no allowlist → every client
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// A client is "non-quiescent" while it still has documents actively parsing — parse_status in
// the in-flight set AND enqueued within the backstop window. The backstop bounds the worst-case
// ask delay: a doc wedged in-flight longer than this (the READING·1-OF-1 stall class) stops
// blocking asks, so one stuck upload can't silence a client's questions indefinitely. The
// common case clears the moment the last doc reaches a terminal parse_status (completed/failed/
// skipped) — so a normal upload defers asks only for as long as parsing is genuinely in flight.
const ASK_QUIESCENCE_INFLIGHT_STATUSES = ['pending', 'processing', 'duplicate_pending'];
const ASK_QUIESCENCE_INFLIGHT_BACKSTOP_MINUTES = 60;

export const clientHasInFlightDocumentsForAskQuiescence = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return false;
  const res = await client.query(
    `select 1 from documents
      where firm_id = $1 and client_id = $2
        and parse_status = any($3)
        and created_at > now() - ($4::int * interval '1 minute')
      limit 1`,
    [firmId, clientId, ASK_QUIESCENCE_INFLIGHT_STATUSES, ASK_QUIESCENCE_INFLIGHT_BACKSTOP_MINUTES]
  );
  return res.rows.length > 0;
};

// Slice 3 (autonomous-loop demo) — the auto-DRAFT request producer. After a
// reconciliation run completes for a client, its set of open questions may have
// changed; enqueue a durable `ask_draft.requested` outbox row asking the strong-LLM
// ask pipeline to (re)draft the client's batch — so a firm operator no longer has to
// click "draft" for Donna to ask. The drained consumer (askAutoDraftConsumer) runs the
// model OUTSIDE any txn (INV-11) and re-gates per firm.
//
// GATED HERE to canary+ (drafting is `proposal_creation`): a shadow firm never accrues a
// held request, so there is no backlog at shadow — byte-identical to no producer (the
// careful-canary inertness). COALESCED to at most one in-flight request per client so
// frequent uploads don't fan out N drafts; the draft pipeline supersedes, so the latest
// drained tick wins. The eventType is a STRING LITERAL on purpose: the loopEventRegistry
// source-scan only attributes a producer by a quoted eventType (a constant would escape
// the parked-event invariant — the proposal_rerun.requested-class orphan).
export const onReconcileCompleteRequestAskDraft = async ({
  client, firmId, clientId, env = process.env,
  source = 'reconcile_complete', requestedAt = new Date().toISOString()
} = {}) => {
  if (!firmId || !clientId) return null;
  return runShadow(client, async () => {
    const { firmMetadata } = await readFirmExecutionContext(client, firmId);
    const gate = decideLoopExecution({
      loopKey: 'coding_ask_batch_resolution', firmMetadata,
      requestedAction: 'proposal_creation', env
    });
    if (!gate.actionAllowed) {
      return { enqueued: 0, reason: gate.actionBlockedReason || gate.blockedReason };
    }
    // Parse-quiescence gate (canary, fail-closed). Defer the owner-ask draft while the
    // client still has documents parsing — escalating now would ask the owner for evidence
    // the system already holds in its own parse queue (CLAUDE.md two-terminal-states: a line
    // must not rest 'on owner' while there is still something WE can do). The late doc's own
    // parse-completion re-runs reconcile, which binds the receipt (or asks then if the line
    // is genuinely bare). Off → skipped (byte-identical). See askEscalationQuiescenceGateAllows.
    //
    // 0A.6c — config control plane shim. A DB row for this client ⇒ its stage decides
    // (empty=∅, fail-closed); no row ⇒ the env canary (envFallback), byte-identical to
    // pre-0A.6c. The snapshot is resolved only on this post-actionAllowed path (the blocked
    // path returns above without a config read). The `&&` short-circuit is preserved: the
    // in-flight parse query runs only when the gate acts.
    const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const quiescenceActs = clientFlagActs({
      flagKey: ASK_QUIESCENCE_GATE_FLAG_KEY,
      snapshot: configSnapshot,
      envFallback: () => askEscalationQuiescenceGateAllows(clientId, env),
      env
    });
    if (
      quiescenceActs &&
      await clientHasInFlightDocumentsForAskQuiescence({ client, firmId, clientId })
    ) {
      return { enqueued: 0, reason: 'deferred_pending_parse_quiescence', deferred: true };
    }
    // Coalesce: skip if a draft request for this client is already in flight (pending /
    // dispatching / failed-awaiting-retry). The consumer's draft supersedes, so one
    // in-flight request always (re)produces the latest draft.
    const existing = await client.query(
      `select 1 from loop_event_outbox
        where firm_id = $1 and client_id = $2 and event_type = 'ask_draft.requested'
          and status in ('pending', 'dispatching', 'failed')
        limit 1`,
      [firmId, clientId]
    );
    if (existing.rows[0]) return { enqueued: 0, reason: 'already_pending' };
    const out = await enqueueOutbox({
      client, firmId, clientId,
      eventType: 'ask_draft.requested',
      objectType: 'client', objectId: clientId,
      payload: {
        requested_at: new Date(requestedAt).toISOString(),
        source,
        identity_contract: ASK_DRAFT_IDENTITY_CONTRACT
      }
    });
    return { enqueued: out?.id ? 1 : 0 };
  });
};

// Universal mentions slice 4 — the agent-ask ANSWER request producer. An
// @agent ask is a scoped runtime task: the mint (createClientEvidenceRequest
// audience 'agent') opened the evidence case with its system-owned blocker
// (openEvidenceCase above — an agent ask is Donna-owed work, never a resting
// state), and THIS enqueues the durable execution request the dedicated
// consumer (agentAskAnswerConsumer.js) drains — model call OUTSIDE any txn,
// D7-composed authorization, answer-or-escalate. Mirrors
// onReconcileCompleteRequestAskDraft exactly: canary+ proposal_creation (a
// shadow firm never accrues a held request — the ROUTE refuses the mint below
// that tier, so a shadow firm mints no agent asks at all), coalesced to one
// in-flight request per ask.
export const onAgentAskCreatedRequestAnswer = async ({
  client, firmId, clientId, evidenceRequestId, env = process.env
} = {}) => {
  if (!firmId || !clientId || !evidenceRequestId) return null;
  return runShadow(client, async () => {
    const { firmMetadata } = await readFirmExecutionContext(client, firmId);
    const gate = decideLoopExecution({
      loopKey: 'agent_ask_resolution', firmMetadata,
      requestedAction: 'proposal_creation', env
    });
    if (!gate.actionAllowed) {
      return { enqueued: 0, reason: gate.actionBlockedReason || gate.blockedReason };
    }
    const existing = await client.query(
      `select 1 from loop_event_outbox
        where firm_id = $1 and client_id = $2 and event_type = 'agent_answer.requested'
          and object_id = $3
          and status in ('pending', 'dispatching', 'failed')
        limit 1`,
      [firmId, clientId, evidenceRequestId]
    );
    if (existing.rows[0]) return { enqueued: 0, reason: 'already_pending' };
    const out = await enqueueOutbox({
      client, firmId, clientId,
      eventType: 'agent_answer.requested',
      objectType: 'client_evidence_request', objectId: evidenceRequestId,
      payload: { requested_at: new Date().toISOString() }
    });
    return { enqueued: out?.id ? 1 : 0 };
  });
};

// 2026-06-23 — the reconcile loop's TERMINAL DRAIN. After the document
// matchers run, a bare bank line with no document match would otherwise sit
// at 'suggested' forever (coded but neither matched nor asked — the
// Shopify/Square revenue hang). This drains every still-unmatched line in
// BOTH directions through the strong-model disposition producer
// (bankLineDispositionLlm): auto_explain settles it; everything else writes
// a no_match verdict the verdict→gap→ask chain escalates to a client
// question. It is the mechanism that lets the loop honour "no line exits
// still hanging — it is matched, explained, or asked."
//
// Returns the disposed TRANSACTION targets so the caller folds them into
// the single onReconciliationRunCompleted pass that opens the gaps (the
// drain itself never opens gaps — same separation as the document path).
//
// Gated exactly like onReconcileCompleteRequestAskDraft (runShadow +
// canary+ proposal_creation), so a shadow firm is byte-identical to no
// producer. enabledOverride:true runs the disposition sweep under THIS loop
// authority instead of requiring the standalone BANK_LINE_DISPOSITION_MODE
// env flag. The sweep never throws (it fails a line toward a human), and
// each direction is independent — a failure in one still lets the other run.
export const runReconciliationTerminalDrain = async ({
  client, firmId, clientId, env = process.env, fetchImpl,
  // Descent-ladder Q6a: a CONNECTION INJECTOR for the shadow-challenger
  // receipt write (this module deliberately imports no firmDb — the caller
  // supplies withFirmDbClient). The challenger must never share the drain's
  // own connection: its fire-and-forget insert could land inside a later
  // line's stamp transaction. Absent injector ⇒ no challenger, sweep as before.
  challengerWithClient = null
} = {}) => {
  if (!firmId || !clientId) return null;
  // F5 — UNTRANSACTED: the sweep's model calls must not run under one open
  // transaction on the max-2 firm pool. The gate check is read-only and the
  // disposition producer commits per line, so each verdict survives on its own.
  return runShadowUntransacted(client, async () => {
    const { firmMetadata } = await readFirmExecutionContext(client, firmId);
    const gate = decideLoopExecution({
      loopKey: 'reconciliation_terminal_drain', firmMetadata,
      requestedAction: 'proposal_creation', env
    });
    if (!gate.actionAllowed) {
      return { disabled: true, reason: gate.actionBlockedReason || gate.blockedReason, targets: [] };
    }
    // Q6c — the lane's active model-policy row (which QUALIFIED model
    // decides). Best-effort read: unreadable ⇒ the strong default sweeps.
    let decidingPolicy = null;
    try {
      decidingPolicy = await readLaneDecidingPolicy({
        client, firmId, clientId, laneId: BANK_LINE_DISPOSITION_CHALLENGER_LANE
      });
    } catch { decidingPolicy = null; }
    // Q6a — hook construction is best-effort and can never affect the drain.
    // (Q6c: an active policy also constructs — the REVERSE-shadow mode needs
    // no compatible env, so the forward predicate alone must not gate it.)
    let challengerHook = null;
    if (typeof challengerWithClient === 'function'
      && (bankLineDispositionChallengerConfigured(env) || decidingPolicy)) {
      try {
        const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
        challengerHook = makeBankLineDispositionChallengerHook({
          firmId, clientId, snapshot, withClient: challengerWithClient, env, decidingPolicy
        });
      } catch { challengerHook = null; }
    }
    const targets = [];
    const byDirection = {};
    for (const direction of ['money_out', 'money_in']) {
      const stats = await runBankLineDispositionForClient({
        client, firmId, clientId, direction, enabledOverride: true, fetchImpl, challengerHook, decidingPolicy
      });
      byDirection[direction] = stats;
      for (const id of (stats?.evaluated_target_ids || [])) {
        targets.push({ targetType: 'transaction', targetId: id });
      }
    }
    // RT-11 / D4 — same law as inngest/bankLineDisposition.js, run right after
    // the verdicts land so an ask never rests on a line Donna just settled
    // (plane-gated on RECONCILE_AUTO_EXPLAIN_RETRACTS, receipted, idempotent;
    // each retraction is one atomic statement, so untransacted is safe here).
    // Best-effort: logged, never affects the drain's targets.
    let asksRetracted = 0;
    try {
      const retraction = await retractAsksSettledByAutoExplain(client, {
        firmId, clientId, env,
        configSnapshot: await readClientConfigSnapshot(client, { firmId, clientId })
      });
      asksRetracted = retraction.retracted_request_ids?.length || 0;
    } catch (error) {
      try { console.warn('[loops] auto-explain ask retraction failed', { firm_id: firmId, client_id: clientId, error: error?.message || String(error) }); } catch {}
    }
    return { disabled: false, byDirection, targets, asks_retracted: asksRetracted };
  });
};

// ── Backfill / reconciliation (slice 1.4a) ──────────────────────────────────
//
// Idempotent. Opens shadow cases for the existing OPEN evidence requests, SENT
// ask batches, FAILED parses, and STUCK in-flight uploads (pending/processing
// past the stale threshold — the Phase-5 sweep) of one client. Default
// dryRun=true; never auto-runs in prod. Respects LOOPS_SHADOW unless
// allowWhenDisabled is passed (for a deliberate dev/test run). The caller
// provides `client` (wrap it in withFirmDbClient on Kari's side).
const caseExists = async (client, firmId, clientId, caseType, primaryObjectType, primaryObjectId) => {
  const res = await client.query(
    `select 1 from bookkeeping_cases
      where firm_id = $1 and client_id = $2 and case_type = $3
        and primary_object_type = $4 and primary_object_id = $5
      limit 1`,
    [firmId, clientId, caseType, primaryObjectType, primaryObjectId]
  );
  return res.rows.length > 0;
};

export const backfillLoopsShadow = async ({
  client, firmId, clientId, dryRun = true, limit = 500, allowWhenDisabled = false,
  stuckThresholdSeconds = 300
} = {}) => {
  const summary = {
    scanned: 0, created_cases: 0, existing_cases: 0,
    created_links: 0, created_blockers: 0, stuck_scanned: 0,
    recon_scanned: 0,
    skipped: 0, errors: 0, dry_run: Boolean(dryRun)
  };
  if (!client || !firmId || !clientId) return summary;
  if (!isLoopsShadowEnabled() && !allowWhenDisabled) { summary.skipped = -1; return summary; }
  if (!(await loopsTablesPresent(client))) { summary.skipped = -1; return summary; }
  const bounded = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  // Reuse failStuckProcessingRowsInDb's 300s heartbeat threshold (floored at 60s
  // so a misconfig can't open cases for healthy in-flight uploads).
  const stuckThreshold = Math.max(60, Number(stuckThresholdSeconds) || 300);

  const evidence = await client.query(
    `select id, transaction_id, question, audience from client_evidence_requests
      where firm_id = $1 and client_id = $2 and status in ('draft', 'open', 'replied')
      order by created_at asc limit $3`,
    [firmId, clientId, bounded]
  ).catch(() => ({ rows: [] }));
  const batches = await client.query(
    `select id from client_ask_batches
      where firm_id = $1 and client_id = $2 and status = 'sent'
      order by created_at asc limit $3`,
    [firmId, clientId, bounded]
  ).catch(() => ({ rows: [] }));
  const failures = await client.query(
    `select id, parse_error, parse_run_id from documents
      where firm_id = $1 and client_id = $2 and parse_status = 'failed'
      order by uploaded_at asc limit $3`,
    [firmId, clientId, bounded]
  ).catch(() => ({ rows: [] }));
  // Stuck in-flight uploads: 'pending' (queued, never picked up) or 'processing'
  // (worker stalled) whose last activity clock — heartbeat for processing,
  // enqueue for pending — is older than the stale threshold. coalesce picks the
  // right clock per state. These get a SOFT system blocker, not parse_failed.
  const stuck = await client.query(
    `select id, parse_status, parse_run_id, parse_stage,
            parse_progress_current, parse_progress_total,
            coalesce(parse_heartbeat_at, parse_enqueued_at) as last_activity_at
       from documents
      where firm_id = $1 and client_id = $2
        and parse_status in ('pending', 'processing')
        and coalesce(parse_heartbeat_at, parse_enqueued_at) < now() - ($3 || ' seconds')::interval
      order by uploaded_at asc limit $4`,
    [firmId, clientId, String(stuckThreshold), bounded]
  ).catch(() => ({ rows: [] }));

  // Phase 7 — reconciliation-graph gaps. Scan A: a PERSISTED no_match /
  // no_candidates verdict (reconciliation_evaluations, rail #1) with no live
  // sticky match outranking it (INV-4). The match join handles either anchor —
  // a transaction target joins on bank_transaction_id, a document target on
  // matched_object_(type,id). Renders the persisted verdict; no re-matching.
  const reconVerdicts = await client.query(
    `select e.target_type, e.target_id, e.verdict, e.unmatchable_reason, e.model
       from reconciliation_evaluations e
      where e.firm_id = $1 and e.client_id = $2
        and e.verdict in ('no_match', 'no_candidates')
        and not exists (
          select 1 from reconciliation_matches m
           where m.firm_id = e.firm_id and m.client_id = e.client_id
             and m.status in ('confirmed', 'auto_matched', 'rejected')
             and (
               (e.target_type = 'transaction' and m.bank_transaction_id = e.target_id)
               or (e.target_type <> 'transaction'
                   and m.matched_object_type = e.target_type and m.matched_object_id = e.target_id)
             )
        )${DOC_DISPOSITION_GAP_GUARDS}
      order by e.evaluated_at asc limit $3`,
    [firmId, clientId, bounded]
  ).catch(() => ({ rows: [] }));
  // Scan B: an unpaid obligation that never reached the matcher — no evaluation
  // row AND no sticky match. Keyed off payment_status (persisted workflow state),
  // never document content (INV-12). Broader coverage than the verdict scan: it
  // catches obligations the matcher never even evaluated.
  const reconUnevaluated = await client.query(
    `select d.id as document_id
       from documents d
      where d.firm_id = $1 and d.client_id = $2
        and d.payment_status = 'unpaid'
        and not exists (
          select 1 from reconciliation_evaluations e
           where e.firm_id = d.firm_id and e.target_type = 'document' and e.target_id = d.id
        )
        and not exists (
          select 1 from reconciliation_matches m
           where m.firm_id = d.firm_id and m.matched_object_type = 'document' and m.matched_object_id = d.id
             and m.status in ('confirmed', 'auto_matched', 'rejected')
        )
      order by d.uploaded_at asc limit $3`,
    [firmId, clientId, bounded]
  ).catch(() => ({ rows: [] }));

  summary.stuck_scanned = stuck.rows.length;
  summary.recon_scanned = reconVerdicts.rows.length + reconUnevaluated.rows.length;
  summary.scanned = evidence.rows.length + batches.rows.length + failures.rows.length
    + stuck.rows.length + summary.recon_scanned;
  if (dryRun) { summary.skipped = summary.scanned; return summary; }

  for (const row of evidence.rows) {
    try {
      const before = await caseExists(client, firmId, clientId, 'evidence', 'client_evidence_request', row.id);
      await openEvidenceCase({ client, firmId, clientId, evidenceRequestId: row.id, transactionId: row.transaction_id, question: row.question, audience: row.audience || 'client' });
      if (before) summary.existing_cases += 1; else summary.created_cases += 1;
    } catch { summary.errors += 1; }
  }
  for (const row of batches.rows) {
    try {
      const before = await caseExists(client, firmId, clientId, 'coding', 'client_ask_batch', row.id);
      await openAskBatchCase({ client, firmId, clientId, batchId: row.id });
      if (before) summary.existing_cases += 1; else summary.created_cases += 1;
    } catch { summary.errors += 1; }
  }
  for (const row of failures.rows) {
    try {
      const before = await caseExists(client, firmId, clientId, 'upload', 'document', row.id);
      await openUploadCase({ client, firmId, clientId, documentId: row.id, blockerType: 'parse_failed', parseError: row.parse_error, parseRunId: row.parse_run_id });
      if (before) summary.existing_cases += 1; else summary.created_cases += 1;
    } catch { summary.errors += 1; }
  }
  for (const row of stuck.rows) {
    try {
      const before = await caseExists(client, firmId, clientId, 'upload', 'document', row.id);
      const lastActivity = row.last_activity_at ? new Date(row.last_activity_at).getTime() : null;
      const staleSeconds = lastActivity ? Math.max(0, Math.round((Date.now() - lastActivity) / 1000)) : null;
      await openStuckUploadCase({
        client, firmId, clientId, documentId: row.id, parseStatus: row.parse_status,
        parseRunId: row.parse_run_id, parseStage: row.parse_stage,
        progressCurrent: row.parse_progress_current, progressTotal: row.parse_progress_total,
        staleSeconds
      });
      if (before) summary.existing_cases += 1; else summary.created_cases += 1;
    } catch { summary.errors += 1; }
  }
  for (const row of reconVerdicts.rows) {
    try {
      const before = await caseExists(client, firmId, clientId, 'reconciliation', row.target_type, row.target_id);
      // The scan's not-exists already excluded sticky-matched targets (INV-4), so
      // hasStickyMatch is false here; the evaluator types the blocker from the verdict
      // (no_match → unclear_match, no_candidates → missing_bank_statement).
      const { kase } = await projectReconciliationGap({
        client, firmId, clientId, targetType: row.target_type, targetId: row.target_id,
        state: { verdict: row.verdict, unmatchableReason: row.unmatchable_reason, hasStickyMatch: false },
        model: row.model
      });
      if (kase) { if (before) summary.existing_cases += 1; else summary.created_cases += 1; }
    } catch { summary.errors += 1; }
  }
  for (const row of reconUnevaluated.rows) {
    try {
      const before = await caseExists(client, firmId, clientId, 'reconciliation', 'document', row.document_id);
      // unpaid obligation, no evaluation, no settling match → the evaluator's
      // unevaluated_obligation gap (scan B). State mirrors the scan's where-clause.
      const { kase } = await projectReconciliationGap({
        client, firmId, clientId, targetType: 'document', targetId: row.document_id,
        state: { paymentStatus: 'unpaid', hasEvaluation: false, hasAnyMatch: false }
      });
      if (kase) { if (before) summary.existing_cases += 1; else summary.created_cases += 1; }
    } catch { summary.errors += 1; }
  }
  return summary;
};
