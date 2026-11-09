// Coding convergence sweep — the cron-driven re-drive for the batch-coder leg.
//
// THE GAP THIS CLOSES (the 2026-07-03 August-Honeybee incident,
// docs/diagnostic-2026-07-03-open-tab-convergence-sql-pack.md). The strong
// batch coder runs ONCE, inline at the tail of a bank statement's post-parse
// chain (inngest/parseDocument.js). Prod runs parses inline on the per-minute
// parse-cron with a 300-second Vercel budget; when the reconciliation stage
// ahead of it spends the budget, the invocation is HARD-KILLED before the
// coder leg — no thrown error (the soft-degrade catch never fires), no audit,
// and nothing ever re-runs a completed document's post-parse legs. Twenty
// August lines rested at the parse-time classifier's unknown/Suspense with no
// terminal writer pending: the two-terminal-states violation, verbatim.
//
// WHAT IT DOES. Each tick, four bounded, self-healing steps:
//   1. RE-DRIVE THE CODER — find clients that still have CODABLE lines the
//      strong coder has never seen, or whose latest policy receipt still
//      requires recovery (mirroring the batch coder's pools), and run the SAME
//      batchSuggestTransactionCodingInDb the post-parse chain and the firm UI
//      call. The pool is incremental, so a killed tick just means the next
//      tick finishes the job — the resumability the fire-once inline call
//      lacks. When no client has unseen lines the tick is a few cheap SQL
//      reads and ZERO model calls.
//   1.5. RELEASE STRANDED 'waiting' ROWS — a review item flips to 'waiting'
//      when an owner ask goes out, and the ask lane's REPLY path flips it back.
//      But when the ask is AUTO-RESOLVED by a settling match instead
//      (cascadeAutoMatch → resolveOpenEvidenceRequestsForMatchedLine), nothing
//      touches the queue row: the line rests settled + coded-at-Suspense +
//      coding_state='asked' forever, invisible to the sweep below (which
//      reads only 'proposed') — matched-but-uncoded firm limbo with no
//      self-heal (the Honeybee Land-lease 865.13 receipt, 2026-08-06,
//      findings §4b-xxi). Each tick releases open 'waiting' rows whose line is
//      SETTLED and which carry NO live evidence request back to 'suggested',
//      audited, so the same tick's sweep can drive them terminal. Rows with a
//      live ask stay 'waiting' (still legitimately on the owner); unsettled
//      lines stay put (their ask lane still owns them).
//   1.75. HEAL PRE-HANDLE ASK DEAD LETTERS — an ask draft that exhausted its
//      retries because a model omitted or confused a long persisted id will
//      never be read again. Discover those cancelled ASK_PIPELINE_BAD_DRAFT
//      rows and request exactly one new draft under the call-local-handle
//      identity contract. The cancelled row and its original error stay
//      immutable; a contract marker prevents repeated recovery attempts.
//   2. AUTO-POST SWEEP — for clients with transaction-owned codings resting at
//      coding_state='proposed', run sweepCodingAutoPost (codingAutoPost.js).
//      That sweep is fail-closed behind the CODING_AUTO_POST canary — DB-first
//      via the config control plane (client_capability_config stage rows),
//      with the legacy env pair as byte-identical fallback — and returns
//      { gated: true } without touching anything until a client is staged or
//      allowlisted — shipping this schedule cannot silently flip a live book
//      into auto-posting.
//   3. LEDGER POST SWEEP — for clients with lines resting at
//      coding_state='applied' but no ledger journal (the "Ready to post"
//      residue — Kari's 2026-08-06 call: auto-reconciled must TERMINATE with
//      the journal posted), run sweepLedgerAutoPost (ledgerAutoPost.js).
//      Fail-closed behind the LEDGER_AUTO_POST control-plane flag (no env
//      pair), internal Donna ledger only, refusals receipted per line.
//
// Discovery deliberately EXCLUDES (mirrors the coder's own pool filters, so a
// line the coder would refuse can never hot-loop the trigger):
//   - lines already suggested (ai_suggestion present) — a resting SUGGESTED
//     line must NOT re-spend the model every tick; it is the sweep's job;
//   - decided lines (__isTerminalCodingState: coding_state applied/held/
//     posted/synced/closed — RT-16's one column);
//   - confident auto-sources (client_rule / merchant_lookup) — the coder
//     skips them, so they must not re-trigger discovery forever;
//   - lines with a live owner ask (draft/open/replied evidence request) —
//     draft/open rests on the owner; replied is owed system work handled by
//     the dedicated reply recovery step, never the ordinary coder.
//
// CLAUDE.md "Keep"-layer: this module calls no LLM itself and decides no
// verdict — it only re-drives the existing named writers on a bounded cadence.

import { recoverRefusedCodingEvidenceInDb } from './db/codingRefusalRecovery.js';
import { recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { recoverPostedCodingCorrectionsInDb } from './db/codingCorrection.js';
import { withFirmDbClient, batchSuggestTransactionCodingInDb, readClientConfigSnapshotInDb, DEFAULT_FIRM_ID } from './firmDb.js';
import { sweepCodingAutoPost, codingAutoPostAllows } from './codingAutoPost.js';
import { sweepLedgerAutoPost, ledgerAutoPostAllows, DISCOVER_LEDGER_POST_CLIENTS_SQL } from './ledgerAutoPost.js';
import { onReconcileCompleteRequestAskDraft } from './loopsShadowProducers.js';
import { ASK_DRAFT_IDENTITY_CONTRACT } from './askPipeline.js';
import { entityReadinessExhaustedRestSql, runWithEntityReadinessWorkerAdmission } from './runtimeReadinessAdmission.js';
import { recoverOwnerRepliesInDb } from './ownerReplyRecovery.js';
import { recoverReconciliationProviderFailuresInDb } from './reconciliationProviderFailure.js';
import { recoverJevMaterialExceptionsInDb } from './jevMaterialException.js';
import { runHostedPilotTerminalConvergenceInDb } from './hostedPilotTerminalConvergence.js';
import { ACTIVE_CODING_POLICY_FAILURE_SQL, REFUSED_CROSS_WINDOW_GROUP_SQL } from './codingPolicyRecovery.js';

// Per-tick bounds. The cron runs every few minutes, so a burst larger than
// the cap simply converges across ticks instead of blowing the 300s budget.
export const CODING_CONVERGENCE_MAX_CODER_CLIENTS = 3;
export const CODING_CONVERGENCE_MAX_SWEEP_CLIENTS = 10;
export const CODING_CONVERGENCE_MAX_LEDGER_POST_CLIENTS = 10;
export const CODING_CONVERGENCE_MAX_ASK_RECOVERY_CLIENTS = 10;

// One-time bridge for rows cancelled before the model boundary switched from
// persisted ids to call-local handles. The prior failure remains on the old
// row (last_error.previous_error); recovery creates a new ordinary request.
// Any request carrying the current identity contract — regardless of its
// eventual status — proves this client has already exercised the bridge.
export const DISCOVER_ASK_DRAFT_IDENTITY_RECOVERY_SQL = `
  select distinct on (o.client_id)
         o.client_id, o.id as dead_letter_id, o.created_at as failed_request_created_at
    from loop_event_outbox o
   where o.firm_id = $1
     and o.event_type = 'ask_draft.requested'
     and o.status = 'cancelled'
     and coalesce(o.payload->>'identity_contract', '') <> $2
     and coalesce(
       o.last_error #>> '{previous_error,code}',
       o.last_error->>'code',
       ''
     ) = 'ASK_PIPELINE_BAD_DRAFT'
     and not exists (
       select 1 from loop_event_outbox current_contract
        where current_contract.firm_id = o.firm_id
          and current_contract.client_id = o.client_id
          and current_contract.event_type = 'ask_draft.requested'
          and current_contract.payload->>'identity_contract' = $2
     )
     and not exists (
       select 1 from loop_event_outbox live
        where live.firm_id = o.firm_id
          and live.client_id = o.client_id
          and live.event_type = 'ask_draft.requested'
          and live.status in ('pending', 'dispatching', 'failed')
     )
   order by o.client_id, o.created_at desc, o.id desc
   limit $3
`;

export const recoverAskDraftIdentityDeadLetters = async ({
  client,
  firmId,
  env = process.env,
  asOf = Date.now(),
  limit = CODING_CONVERGENCE_MAX_ASK_RECOVERY_CLIENTS,
  requestAskDraftFn = onReconcileCompleteRequestAskDraft
} = {}) => {
  if (!client || !firmId) return [];
  const result = await client.query(DISCOVER_ASK_DRAFT_IDENTITY_RECOVERY_SQL, [
    firmId,
    ASK_DRAFT_IDENTITY_CONTRACT,
    Math.min(Math.max(Number(limit) || CODING_CONVERGENCE_MAX_ASK_RECOVERY_CLIENTS, 1), 50)
  ]);
  const recovered = [];
  for (const row of result.rows || []) {
    if (!row?.client_id) continue;
    const requested = await requestAskDraftFn({
      client,
      firmId,
      clientId: row.client_id,
      env,
      source: 'identity_contract_recovery',
      requestedAt: new Date(asOf).toISOString()
    });
    recovered.push({
      client_id: row.client_id,
      dead_letter_id: row.dead_letter_id || null,
      enqueued: Number(requested?.enqueued || 0),
      ...(requested?.reason ? { reason: requested.reason } : {})
    });
  }
  return recovered;
};

// Outage dead letters (2026-09-12, FI reliability pass). The ask-draft
// consumer backs a provider failure off five times and then dead-letters the
// request as `cancelled` / max_attempts. Once the provider is healthy nothing
// re-requested the draft unless another upload or an unseen line happened to
// wake the producer — the owner's questions simply never got drafted. This
// step re-requests ONCE per dead letter whose recorded cause is the provider
// (`ASK_PIPELINE_LLM_UNAVAILABLE`), after a cooldown, and only while no later
// request for the client exists; the producer's own quiescence, tier and
// coalescing gates still decide whether a draft is owed.
export const ASK_DRAFT_OUTAGE_RECOVERY_COOLDOWN_MS = 15 * 60_000;
export const DISCOVER_ASK_DRAFT_OUTAGE_RECOVERY_SQL = `
  select distinct on (o.client_id)
         o.client_id, o.id as dead_letter_id, o.created_at as failed_request_created_at
    from loop_event_outbox o
   where o.firm_id = $1
     and o.event_type = 'ask_draft.requested'
     and o.status = 'cancelled'
     and coalesce(
       o.last_error #>> '{previous_error,code}',
       o.last_error->>'code',
       ''
     ) = 'ASK_PIPELINE_LLM_UNAVAILABLE'
     and coalesce(nullif(o.last_error->>'at', '')::timestamptz, o.created_at) < now() - interval '${ASK_DRAFT_OUTAGE_RECOVERY_COOLDOWN_MS} milliseconds'
     and not exists (
       select 1 from loop_event_outbox later
        where later.firm_id = o.firm_id
          and later.client_id = o.client_id
          and later.event_type = 'ask_draft.requested'
          and (later.created_at > o.created_at or later.status in ('pending', 'dispatching', 'failed'))
     )
   order by o.client_id, o.created_at desc, o.id desc
   limit $2
`;

export const recoverAskDraftOutageDeadLetters = async ({
  client,
  firmId,
  env = process.env,
  asOf = Date.now(),
  limit = CODING_CONVERGENCE_MAX_ASK_RECOVERY_CLIENTS,
  requestAskDraftFn = onReconcileCompleteRequestAskDraft
} = {}) => {
  if (!client || !firmId) return [];
  const result = await client.query(DISCOVER_ASK_DRAFT_OUTAGE_RECOVERY_SQL, [
    firmId,
    Math.min(Math.max(Number(limit) || CODING_CONVERGENCE_MAX_ASK_RECOVERY_CLIENTS, 1), 50)
  ]);
  const recovered = [];
  for (const row of result.rows || []) {
    if (!row?.client_id) continue;
    const requested = await requestAskDraftFn({
      client,
      firmId,
      clientId: row.client_id,
      env,
      source: 'provider_outage_recovery',
      requestedAt: new Date(asOf).toISOString()
    });
    recovered.push({
      client_id: row.client_id,
      dead_letter_id: row.dead_letter_id || null,
      enqueued: Number(requested?.enqueued || 0),
      ...(requested?.reason ? { reason: requested.reason } : {})
    });
  }
  return recovered;
};

const recoverAskDraftIdentityDeadLettersViaDb = (args) =>
  withFirmDbClient(async (client) => [
    ...await recoverAskDraftIdentityDeadLetters({ client, ...args }),
    ...await recoverAskDraftOutageDeadLetters({ client, ...args })
  ]);

// Clients with unseen codable lines or an unresolved coding-policy incident. Mirrors the
// batch coder's three pool shapes (open review-queue rows; matched-but-uncoded
// reconciled/explained lines; ordinary uncoded needs-review bank lines) and its
// refusal filters — see module header. The third arm is deliberately based on
// the transaction's own status, never on whether another subsystem happened to
// mint a queue row: item identity cannot be inferred from a case-file sidecar.
export const CODING_CONVERGENCE_ITEMS_SQL = `select t.id, t.client_id
    from transactions t
   where t.firm_id = $1
     and coalesce(t.payload->>'auto_categorize_source', '') not in ('client_rule', 'merchant_lookup')
     and (t.coding_state is null or t.coding_state not in ('applied', 'held', 'posted', 'synced', 'closed'))
     and not ${REFUSED_CROSS_WINDOW_GROUP_SQL}
     and (
       (${ACTIVE_CODING_POLICY_FAILURE_SQL})
       or ((t.payload->'ai_suggestion') is null and (
         t.status = 'needs_review'
         or t.reconciliation_status in ('reconciled', 'explained', 'auto_reconciled')
         or exists (
           select 1
             from transaction_review_queue q
            where q.firm_id = t.firm_id
              and q.client_id = t.client_id
              and q.status = 'open'
              and (q.item_id = t.id or q.payload->>'transaction_id' = t.id)
         )
       ))
     )
     and (t.payload ? 'coding_evidence_reconsideration' or not exists (
       select 1
         from client_evidence_requests r
        where r.firm_id = t.firm_id
          and r.client_id = t.client_id
          and r.transaction_id = t.id
          and lower(r.status) in ('draft', 'open', 'replied')
     ))
`;

// An exhausted readiness saga rests on the owner's Reopen; selecting it here
// would only mint one worker_discovery refusal per tick, forever.
export const DISCOVER_CODER_CLIENTS_SQL = `
  select t.client_id, count(*)::int as unseen_lines
    from (${CODING_CONVERGENCE_ITEMS_SQL}) t
   where not ${entityReadinessExhaustedRestSql('$1', 't.client_id')}
   group by t.client_id
   order by count(*) desc, t.client_id
   limit $2
`;

// Step 1.5's population: transaction-owned coding receipts stranded at
// `coding_state='asked'` after the ask that parked them was auto-resolved by a
// settling match. The transaction is the source of truth (RT-16: the ONE
// column; the SQL guard `coding_state = 'asked'` IS the machine's asked →
// proposed edge); an open review row is optional case-file context and must
// never be an admission ticket. The case rows are touched in the same
// statement so the audit names them.
const RELEASE_SETTLED_WAITING_SQL = `
  with releasable as materialized (
    select t.id as transaction_id,
           t.client_id
      from transactions t
     where t.firm_id = $1
       and (t.payload->'ai_suggestion') is not null
       and t.coding_state = 'asked'
       and (
         t.reconciliation_status in ('explained', 'reconciled', 'auto_reconciled', 'posted')
         or exists (
           select 1
             from reconciliation_matches m
            where m.firm_id = t.firm_id
              and m.client_id = t.client_id
              and m.bank_transaction_id = t.id
              and m.matched_object_type <> 'bank_line'
              and m.status in ('auto_matched', 'confirmed')
         )
       )
       and not exists (
         select 1
           from client_evidence_requests r
          where r.firm_id = t.firm_id
            and r.client_id = t.client_id
            and r.transaction_id = t.id
            and lower(r.status) in ('draft', 'open', 'replied')
       )
     for update of t skip locked
  ), released_transactions as (
    update transactions t
       set coding_state = 'proposed',
           coding_state_as_of = now(),
           updated_at = now()
      from releasable r
     where t.firm_id = $1
       and t.id = r.transaction_id
       and t.coding_state = 'asked'
     returning t.id as transaction_id, t.client_id
  ), released_reviews as (
    update transaction_review_queue q
       set updated_at = now()
      from released_transactions t
     where q.firm_id = $1
       and q.client_id = t.client_id
       and q.status = 'open'
       and q.item_type <> 'document_line'
       and coalesce(q.payload->>'transaction_id', q.item_id) = t.transaction_id
     returning q.id, q.client_id,
               coalesce(q.payload->>'transaction_id', q.item_id) as transaction_id
  )
  select t.client_id,
         t.transaction_id,
         min(q.id) as id
    from released_transactions t
    left join released_reviews q
      on q.client_id = t.client_id
     and q.transaction_id = t.transaction_id
   group by t.client_id, t.transaction_id
   order by t.client_id, t.transaction_id
`;

// Default DB release. Nothing silent: every released transaction rides an
// audit event (one per client, including any case-file rows updated alongside
// it), best-effort in the established triage style — an audit failure never
// blocks the release.
const releaseSettledWaitingViaDb = async ({ firmId }) =>
  withFirmDbClient(async (client) => {
    const result = await client.query(RELEASE_SETTLED_WAITING_SQL, [firmId]);
    const rows = result.rows || [];
    if (!rows.length) return rows;
    const byClient = new Map();
    for (const row of rows) {
      const list = byClient.get(row.client_id) || [];
      list.push(row);
      byClient.set(row.client_id, list);
    }
    for (const [clientId, released] of byClient) {
      try {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'transaction_review.waiting_released_after_settle', 'transaction', $3, $4::jsonb)`,
          [
            firmId,
            clientId,
            released[0].transaction_id,
            JSON.stringify({
              review_item_ids: released.map((r) => r.id).filter(Boolean),
              transaction_ids: released.map((r) => r.transaction_id),
              reason: 'ask_auto_resolved_line_settled'
            })
          ]
        );
      } catch (error) {
        console.warn('[codingConvergence] release audit write failed', {
          client_id: clientId,
          error: error?.message || String(error)
        });
      }
    }
    return rows;
  });

// RT-26 real-PG proof drives the release directly (the mechanism that returns a
// matched line's stale `asked` state to the coder).
export const __releaseSettledWaitingViaDb = releaseSettledWaitingViaDb;

// Clients with transactions resting at a suggested coding — the sweep's
// source-of-truth population. Runs AFTER the coder step so lines suggested
// this tick are swept this tick. A queue row is optional case-file context,
// never admission: when coding lands before a later document match, the
// transaction may be the only durable coding receipt.
export const DISCOVER_SWEEP_CLIENTS_SQL = `
  select distinct t.client_id
    from transactions t
   where t.firm_id = $1
     and (t.payload->'ai_suggestion') is not null
     and t.coding_state = 'proposed'
   order by t.client_id
   limit $2
`;

const discoverViaDb = (sql) => async ({ firmId, limit }) =>
  withFirmDbClient(async (client) => {
    const result = await client.query(sql, [firmId, limit]);
    return result.rows || [];
  });

const requestAskDraftViaDb = (args) =>
  withFirmDbClient((client) => onReconcileCompleteRequestAskDraft({ client, ...args }));

// Pull just the per-client coder counters out of the firm snapshot the batch
// coder returns (the snapshot itself is huge and belongs to the UI path).
const extractCoderSummary = (snapshot, clientId) => {
  const summaries = snapshot?.transaction_ai_batch?.summaries;
  const own = Array.isArray(summaries)
    ? summaries.find((s) => s?.client_id === clientId) || summaries[0]
    : null;
  if (!own) return { scanned: 0, suggested: 0, auto_applied: 0, remembered: 0 };
  return {
    scanned: Number(own.scanned || 0),
    suggested: Number(own.suggested || 0),
    auto_applied: Number(own.auto_applied || 0),
    remembered: Number(own.remembered || 0),
    ...(own.policy_failure ? {
      policy_failure: true,
      error: own.error || own.policy_error?.code || own.policy_failures?.[0]?.code || 'coding_policy_unavailable',
      policy_error: own.policy_error || null,
      ...(own.policy_failures?.length ? { policy_failures: own.policy_failures } : {})
    } : {}),
    ...(own.provider_failure ? { provider_failure: own.provider_failure } : {}),
    ...(own.provider_failures?.length ? { provider_failures: own.provider_failures } : {})
  };
};

export const runCodingConvergence = async ({
  firmId = DEFAULT_FIRM_ID,
  env = process.env,
  asOf = Date.now(),
  maxCoderClients = CODING_CONVERGENCE_MAX_CODER_CLIENTS,
  maxSweepClients = CODING_CONVERGENCE_MAX_SWEEP_CLIENTS,
  maxLedgerPostClients = CODING_CONVERGENCE_MAX_LEDGER_POST_CLIENTS,
  maxAskRecoveryClients = CODING_CONVERGENCE_MAX_ASK_RECOVERY_CLIENTS,
  discoverCoderClientsFn = discoverViaDb(DISCOVER_CODER_CLIENTS_SQL),
  discoverSweepClientsFn = discoverViaDb(DISCOVER_SWEEP_CLIENTS_SQL),
  discoverLedgerPostClientsFn = discoverViaDb(DISCOVER_LEDGER_POST_CLIENTS_SQL),
  releaseWaitingFn = releaseSettledWaitingViaDb,
  recoverAskDraftFn = recoverAskDraftIdentityDeadLettersViaDb,
  recoverOwnerRepliesFn = null,
  // 2026-09-13 — documents whose family matcher failed on the PROVIDER (a
  // rejected/missing key, an outage, a hung request; reconciliationProviderFailure.js)
  // are re-driven through the same orchestrators here, BEFORE the coder, so a
  // line whose bill matches on recovery is coded in the same tick.
  recoverReconciliationProviderFailuresFn = null,
  recoverMaterialExceptionsFn = null,
  hostedPilotTerminalConvergenceFn = null,
  recoverAeVatLegacyCodingFn = null,
  recoverChangedEvidenceFn = null,
  recoverPostedCorrectionsFn = null,
  recoverRefusedEvidenceFn = null,
  requestAskDraftFn = requestAskDraftViaDb,
  batchSuggestFn = batchSuggestTransactionCodingInDb,
  sweepFn = sweepCodingAutoPost,
  ledgerSweepFn = sweepLedgerAutoPost,
  // Config control plane: the snapshot is read once per candidate and passed to
  // BOTH the honest-summary pre-check and the sweep, so the two can never
  // disagree. The pre-check keeps its (clientId, env, snapshot) positional shape
  // so injected test doubles that ignore the third arg keep working.
  readConfigSnapshotFn = readClientConfigSnapshotInDb,
  canaryAllowsFn = (clientId, env, snapshot) => codingAutoPostAllows({ clientId, snapshot, env }),
  ledgerPostAllowsFn = (clientId, env, snapshot) => ledgerAutoPostAllows({ snapshot, env }),
  // Injectable so the deterministic scheduler tests stay I/O-local. The
  // production wrapper below always supplies the real database-backed lease.
  runWorkerAdmissionFn = async ({ work }) => work()
} = {}) => {
  const summary = {
    coder: [],
    released: [],
    ask_draft_recovery: [],
    swept: [],
    sweep_gated: 0,
    ledger_posted: [],
    ledger_post_gated: 0,
    errors: 0
  };

  if (recoverReconciliationProviderFailuresFn) {
    try {
      summary.reconciliation_provider_recovery = await recoverReconciliationProviderFailuresFn({ firmId, runWorkerAdmissionFn });
      summary.errors += (summary.reconciliation_provider_recovery || []).filter((item) => item.outcome === 'error').length;
    }
    catch (error) { summary.errors += 1; summary.reconciliation_provider_recovery_error = error?.message || String(error); }
  }

  if (recoverMaterialExceptionsFn) {
    try { summary.material_exception_recovery = await recoverMaterialExceptionsFn({firmId,runWorkerAdmissionFn}); }
    catch (error) { summary.errors += 1; summary.material_exception_recovery_error = error?.message || String(error); }
  }

  if (recoverOwnerRepliesFn) {
    try {
      summary.owner_reply_recovery = await recoverOwnerRepliesFn({ firmId, limit: maxAskRecoveryClients, runWorkerAdmissionFn });
      summary.errors += (summary.owner_reply_recovery || []).filter((item) => item.error).length;
    }
    catch (error) { summary.errors += 1; summary.owner_reply_recovery_error = error?.message || String(error); }
  }

  if (recoverAeVatLegacyCodingFn) {
    try { summary.ae_vat_coding_recovery = await recoverAeVatLegacyCodingFn({ firmId, limit: maxCoderClients }); }
    catch (error) { summary.errors += 1; summary.ae_vat_coding_recovery_error = error?.message || String(error); }
  }

  if (recoverRefusedEvidenceFn) {
    try { summary.posting_source_recovery = await recoverRefusedEvidenceFn({ firmId, limit: 2, runWorkerAdmissionFn }); }
    catch (error) { summary.errors += 1; summary.posting_source_recovery_error = error?.message || String(error); }
  }

  if (recoverChangedEvidenceFn) {
    try {
      summary.coding_evidence_recovery = await recoverChangedEvidenceFn({ firmId, limit: maxCoderClients, runWorkerAdmissionFn });
      // Contended clients are retried next tick; a failed client is an error.
      summary.errors += (summary.coding_evidence_recovery || []).filter(item => item?.skipped && item.state === 'failed').length;
      // F-26: contended / refused clients are counted (and receipted by the
      // recovery worker as runtime-policy incidents) instead of vanishing.
      summary.coding_evidence_contended = (summary.coding_evidence_recovery || []).filter(item => item?.skipped && item.state === 'contended').length;
      summary.coding_evidence_refused = (summary.coding_evidence_recovery || []).filter(item => item?.skipped && item.state === 'refused').length;
    }
    catch (error) { summary.errors += 1; summary.coding_evidence_recovery_error = error?.message || String(error); }
  }

  if (recoverPostedCorrectionsFn) {
    try {
      summary.posted_correction_recovery = await recoverPostedCorrectionsFn({firmId,limit:maxCoderClients,runWorkerAdmissionFn});
      summary.errors += summary.posted_correction_recovery.filter(item=>['failed','blocked'].includes(item.state)).length;
    } catch (error) { summary.errors += 1; summary.posted_correction_recovery_error = error?.message || String(error); }
  }

  if (hostedPilotTerminalConvergenceFn) {
    try {
      summary.hosted_pilot_terminal_convergence = await hostedPilotTerminalConvergenceFn({firmId, runWorkerAdmissionFn});
      summary.errors += (summary.hosted_pilot_terminal_convergence || []).filter(item => item.outcome === 'error').length;
    } catch (error) { summary.errors += 1; summary.hosted_pilot_terminal_convergence_error = error?.message || String(error); }
  }

  // Step 1 — re-drive the coder for clients with unseen codable lines. Each
  // client is its own try/catch: one failure never starves the rest, and the
  // incremental pool means a mid-run kill resumes next tick.
  let coderCandidates = [];
  try {
    coderCandidates = await discoverCoderClientsFn({ firmId, limit: maxCoderClients });
  } catch (error) {
    summary.errors += 1;
    summary.coder_discovery_error = error?.message || String(error);
  }
  for (const candidate of coderCandidates) {
    const clientId = candidate?.client_id;
    if (!clientId) continue;
    try {
      await runWorkerAdmissionFn({ firmId, clientId, work: async () => {
        const snapshot = await batchSuggestFn({ firmId, clientIds: [clientId] });
        const coderReceipt = {
          client_id: clientId,
          unseen_lines: Number(candidate.unseen_lines || 0),
          ...extractCoderSummary(snapshot, clientId)
        };
        if (coderReceipt.policy_failure) {
          // The DB boundary has already persisted the typed incident. A failed
          // policy read is not a model refusal and owes no missing-evidence ask.
          summary.errors += 1;
          if (!coderReceipt.suggested) {
            summary.coder.push(coderReceipt);
            return;
          }
        }
        // A coding run may have auto-applied some rows and left the genuinely
        // ambiguous remainder for the owner. Wake the existing, coalesced ask
        // producer after the persisted verdicts land. Its own gather/freshness
        // gates decide whether anything remains to ask; this clock only ensures
        // that a client does not depend on another upload to leave firm-side
        // limbo. Use the tick's injected time for a deterministic receipt.
        try {
          const requested = await requestAskDraftFn({
            firmId,
            clientId,
            env,
            source: 'coding_convergence',
            requestedAt: new Date(asOf).toISOString()
          });
          coderReceipt.ask_draft = {
            enqueued: Number(requested?.enqueued || 0),
            ...(requested?.reason ? { reason: requested.reason } : {})
          };
        } catch (error) {
          summary.errors += 1;
          coderReceipt.ask_draft_error = error?.message || String(error);
        }
        summary.coder.push(coderReceipt);
      } });
    } catch (error) {
      summary.errors += 1;
      summary.coder.push({ client_id: clientId, error: error?.message || String(error),
        code: error?.code || null, reason_code: error?.details?.reason_code || null });
    }
  }

  // Step 1.5 — release review rows stranded at 'waiting' after their ask was
  // auto-resolved by a settling match (see module header). Runs BEFORE the
  // sweep discovery so a released client is swept THIS tick, not next.
  try {
    const released = await releaseWaitingFn({ firmId });
    if (Array.isArray(released) && released.length) {
      summary.released = released.map((row) => ({
        client_id: row.client_id,
        review_item_id: row.id,
        transaction_id: row.transaction_id
      }));
    }
  } catch (error) {
    summary.errors += 1;
    summary.release_error = error?.message || String(error);
  }

  // Step 1.75 — old exhausted identity failures are terminal outbox rows, so
  // ordinary draining cannot see them. Re-request once under the new contract;
  // the producer still owns quiescence, tier gating, and in-flight coalescing.
  try {
    const recovered = await recoverAskDraftFn({
      firmId,
      env,
      asOf,
      limit: maxAskRecoveryClients
    });
    if (Array.isArray(recovered)) summary.ask_draft_recovery = recovered;
  } catch (error) {
    summary.errors += 1;
    summary.ask_draft_recovery_error = error?.message || String(error);
  }

  // Step 2 — auto-post sweep over clients with resting SUGGESTED lines. The
  // per-client canary is checked here only to keep the summary honest
  // (sweepCodingAutoPost re-checks it and fails closed on its own).
  let sweepCandidates = [];
  try {
    sweepCandidates = await discoverSweepClientsFn({ firmId, limit: maxSweepClients });
  } catch (error) {
    summary.errors += 1;
    summary.sweep_discovery_error = error?.message || String(error);
  }
  for (const candidate of sweepCandidates) {
    const clientId = candidate?.client_id;
    if (!clientId) continue;
    let snapshot = null;
    try {
      snapshot = await readConfigSnapshotFn({ firmId, clientId });
    } catch {
      snapshot = null; // soft-fail ⇒ env fallback, same as the sweep's own read
    }
    if (!canaryAllowsFn(clientId, env, snapshot)) {
      summary.sweep_gated += 1;
      continue;
    }
    try {
      const stats = await runWorkerAdmissionFn({
        firmId,
        clientId,
        work: () => sweepFn({ firmId, clientId, env, configSnapshot: snapshot })
      });
      summary.swept.push({ client_id: clientId, ...stats });
    } catch (error) {
      summary.errors += 1;
      summary.swept.push({ client_id: clientId, error: error?.message || String(error), code: error?.code || null });
    }
  }

  // Step 3 — ledger post sweep over clients with accepted-but-unposted lines
  // (module header; the per-client flag is re-checked inside the sweep, which
  // fails closed on its own — the pre-check keeps the summary honest).
  let ledgerPostCandidates = [];
  try {
    ledgerPostCandidates = await discoverLedgerPostClientsFn({ firmId, limit: maxLedgerPostClients });
  } catch (error) {
    summary.errors += 1;
    summary.ledger_post_discovery_error = error?.message || String(error);
  }
  for (const candidate of ledgerPostCandidates) {
    const clientId = candidate?.client_id;
    if (!clientId) continue;
    let snapshot = null;
    try {
      snapshot = await readConfigSnapshotFn({ firmId, clientId });
    } catch {
      snapshot = null; // soft-fail ⇒ fail-closed (no row, no env fallback)
    }
    if (!ledgerPostAllowsFn(clientId, env, snapshot)) {
      summary.ledger_post_gated += 1;
      continue;
    }
    try {
      const stats = await runWorkerAdmissionFn({
        firmId,
        clientId,
        work: () => ledgerSweepFn({ firmId, clientId, env, configSnapshot: snapshot })
      });
      summary.ledger_posted.push({
        client_id: clientId,
        unposted_lines: Number(candidate.unposted_lines || 0),
        ...stats
      });
    } catch (error) {
      summary.errors += 1;
      summary.ledger_posted.push({ client_id: clientId, error: error?.message || String(error), code: error?.code || null });
    }
  }

  return summary;
};

export const runCodingConvergenceInDb = async (args = {}) =>
  runCodingConvergence({
    recoverOwnerRepliesFn: recoverOwnerRepliesInDb,
    recoverReconciliationProviderFailuresFn: recoverReconciliationProviderFailuresInDb,
    recoverMaterialExceptionsFn: recoverJevMaterialExceptionsInDb,
    hostedPilotTerminalConvergenceFn: runHostedPilotTerminalConvergenceInDb,
    recoverChangedEvidenceFn: recoverChangedCodingEvidenceInDb,
    recoverPostedCorrectionsFn: recoverPostedCodingCorrectionsInDb,
    recoverRefusedEvidenceFn: recoverRefusedCodingEvidenceInDb,
    recoverAeVatLegacyCodingFn: async recoveryArgs => (await import('./db/coding.js')).recoverAeVatLegacyCodingInDb(recoveryArgs),
    ...args,
    runWorkerAdmissionFn: async ({ firmId, clientId, work }) => {
      // Discovery has its own short transaction; independently pooled child
      // writers retain their final admission guards. Release this coordinator
      // checkout (and its settle hook) before the child borrows from the pool.
      await withFirmDbClient((client) => runWithEntityReadinessWorkerAdmission({
        client, firmId, clientId, work: () => undefined, leaseAcrossWork: false
      }));
      return work();
    }
  });
