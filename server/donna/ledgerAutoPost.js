// Ledger auto-post sweep — the self-heal for accepted-but-unposted lines.
//
// THE GAP (Kari's dated call, 2026-08-06 — docs/design-donna-ledger-auto-post.md):
// under two-terminal-states, "auto-reconciled" must TERMINATE with the journal
// posted — a line resting at review_state='accepted' until a human clicks
// "Post to ledger" is firm-side limbo wearing a stat card ("Ready to post N").
// The auto-accept lanes already post inline (the coding auto-post sweep and the
// #ask-reply-autopost sites both call postLedgerTransactionInDb best-effort),
// but BEST-EFFORT HAS NO RETRY: a line whose inline post failed — or that was
// accepted by any path without an inline post — rests at 'accepted' forever.
// Nothing re-visits it: the coding sweep's population is review_state
// ='suggested' only. This module is the bounded re-drive for that residue,
// step 3 of the coding-convergence cron.
//
// WHAT IT DOES, per (firm, client) tick:
//   - loads open review rows at review_state='accepted' whose transaction has
//     no ledger journal yet ('accepted' ONLY, deliberately narrow: 'resolved'
//     rows can carry resolution kinds that are not "coded and ready" — widening
//     is a later, deliberate call once Slice-0 shows a legit resolved residue);
//   - posts each through the EXISTING staged writer postLedgerTransactionInDb
//     (dry-run/execute split, period locks, LEDGER_ALREADY_POSTED refusal, the
//     ledger.post_transaction audit receipt — all invariants live there; this
//     module adds none and bypasses none);
//   - best-effort per line, and NOTHING SILENT: a refusal writes a
//     'ledger.auto_post_refused' audit event keyed on the TRANSACTION, so the
//     line's Audit tab shows why it did not post instead of resting mutely.
//     The discovery SQL uses that same receipt as retry damping — a refused
//     line is re-attempted only after it CHANGES (tx.updated_at advances past
//     the refusal) or after 24h, never hot-looped every tick;
//   - a transient database condition (lock not available, serialization
//     failure, deadlock: isFenceContention) is NOT a refusal: nothing is
//     recorded, the line stays exactly as it was and the next tick takes it
//     again. An error with no business code is stored as
//     LEDGER_POST_UNEXPECTED_FAILURE with its message, never under a raw code.
//
// SCOPE GUARD: internal Donna ledger ONLY (accounting_system='none').
// Publication into an external system of record (Xero/QBO) stays a deliberate,
// human-driven act — that staged gate is Keep-layer and this sweep must never
// reach around it.
//
// SAFETY: fail-closed behind the LEDGER_AUTO_POST flag, born on the config
// control plane (CLAUDE.md rail) — a client_capability_config stage row is the
// ONLY way to turn it on (envFallback is a constant false; there is
// deliberately NO env pair). CLIENT_CONFIG_FORCE_DISABLE kills it like any
// plane flag.
//
// CLAUDE.md "Keep"-layer: no LLM call, no verdict — it re-drives one existing
// named writer on a bounded cadence, exactly like the rest of the cron.

import { retainedNativeMarkerSql } from './nativeChartLineage.js';
import {
  withFirmDbClient,
  postLedgerTransactionInDb,
  getClientAccountingSystemFromDb,
  DEFAULT_FIRM_ID
} from './firmDb.js';
import { clientFlagActs } from './clientConfig.js';
import { readRetainedProcessingScopeInDb } from './runtimeReadinessAdmission.js';
import { isFenceContention, isRawDatabaseCode, isUnexpectedFailure, unexpectedFailureDetails, RAW_DATABASE_CODE_PATTERN } from './db/codingPolicyContext.js';

export const LEDGER_AUTO_POST_FLAG_KEY = 'LEDGER_AUTO_POST';

// Born on the control plane: DB stage row decides (canary/auto act); no row ⇒
// OFF everywhere. No env pair exists and none may be added.
export const ledgerAutoPostAllows = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagActs({
    flagKey: LEDGER_AUTO_POST_FLAG_KEY,
    snapshot,
    envFallback: () => false,
    env
  });

// Per-client per-tick cap. A larger backlog converges across ticks — the cron
// re-runs every few minutes and posting is idempotent (LEDGER_ALREADY_POSTED).
export const LEDGER_AUTO_POST_MAX_LINES_PER_TICK = 20;

// Applied transactions whose line has no journal. The transaction is the
// source of truth (RT-16: `coding_state = 'applied'`, the ONE column — the
// review-queue row carries no coding state).
export const ELIGIBLE_LINES_SQL = `
  with scope as materialized (select $1::text as firm_id, $2::text as client_id)
  select t.id as transaction_id
    from transactions t
   where t.firm_id = $1
     and not exists (select 1 from scope s where ${retainedNativeMarkerSql('s')})
     and t.client_id = $2
     and ($4::text is null or t.id = $4)
     and t.coding_state = 'applied'
     and (t.payload->>'ledger_journal_id') is null
     and coalesce(t.payload->>'ledger_status', '') <> 'posted'
     and t.status <> 'posted'
     and not exists (
       select 1
         from audit_events a
        where a.firm_id = t.firm_id
          and a.client_id = t.client_id
          and a.action = 'ledger.auto_post_refused'
          and a.resource_id = t.id
          and a.created_at > t.updated_at
          -- A receipt stored under a raw SQLSTATE before the transient rule was
          -- never a refusal: it does not damp (withdrawDatabaseCodeRefusalViaDb).
          and not (coalesce(a.metadata->>'code', '') ~ '${RAW_DATABASE_CODE_PATTERN}' and a.metadata->>'code' ~ '[0-9]')
          and a.created_at > now() - case
            when a.metadata->>'code' like 'posting_%'
              or a.metadata->>'code' like 'jurisdiction_%'
              or a.metadata->>'code' like 'coding_policy_%'
              or a.metadata->>'code' = 'TRANSACTION_CODING_EVIDENCE_PENDING'
              or (a.metadata->>'code' = 'TRANSACTION_DOCUMENT_ALLOCATION_INVALID'
                and t.payload->'ai_suggestion'->>'posting_requirement' = 'document_allocation'
                and jsonb_array_length(case when jsonb_typeof(t.payload->'ai_suggestion'->'document_allocations')='array'
                  then t.payload->'ai_suggestion'->'document_allocations' else '[]'::jsonb end)=1
                and t.payload #>> '{ai_suggestion,document_allocations,0,line_handle}' = 'line_1'
                and t.payload #>> '{ai_suggestion,document_allocations,0,account}' = t.payload->'ai_suggestion'->>'proposed_account'
                and exists(select 1 from clients c where c.firm_id=t.firm_id and c.id=t.client_id and lower(c.jurisdiction)='fi'))
            then interval '5 minutes' else interval '24 hours' end
     )
   order by t.transaction_date, t.created_at
   limit $3
`;

const loadEligibleLinesViaDb = async ({ firmId, clientId, limit, transactionId = null }) =>
  withFirmDbClient(async (client) => {
    const result = await client.query(ELIGIBLE_LINES_SQL, [firmId, clientId, limit, transactionId]);
    return (result.rows || []).map((row) => row.transaction_id).filter(Boolean);
  });

// The refusal receipt — the visible hole where a post SHOULD be (design
// §5.1 of the audit timeline: no record of why is itself a bug). The audit
// and row stamp commit together; a failed receipt must retry the sweep.
// RT-23: the refusal also lands on the ROW (`payload.ledger_post_refusal`),
// because the audit event is not a convergence input and an applied-but-
// refused line otherwise projected `auto_reconciled` — the refused post that
// convergence never surfaced (orchestrator-9 candidate (h)). The payload
// write fires the transactions mark, so the settle hook re-derives the row
// as `hanging / ledger_post_refused:<code>` in the same call; a later
// successful post removes the stamp (db/ledger.js commit). The stamp leaves
// `updated_at` alone on purpose: the eligibility SQL damps retries by
// comparing the audit row's created_at against it.
export const LEDGER_POST_REFUSAL_PAYLOAD_KEY = 'ledger_post_refusal';
export const recordRefusalViaDb = async ({ firmId, clientId, transactionId, error, actorId = 'ledger_auto_post', source = 'ledger_auto_post_sweep' }) => {
  try {
    await withFirmDbClient(async (client) => {
      await client.query('begin');
      try {
        const refusal = {
          error: error?.message || String(error),
          code: error?.code || null,
          details: error?.details || null,
          source
        };
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $5, 'ledger.auto_post_refused', 'transaction', $3, $4::jsonb)`,
          [firmId, clientId, transactionId, JSON.stringify(refusal), actorId]
        );
        const stamped = await client.query(
          `update transactions
           set payload = payload || jsonb_build_object($4::text, $5::jsonb)
           where firm_id = $1 and client_id = $2 and id = $3`,
          [firmId, clientId, transactionId, LEDGER_POST_REFUSAL_PAYLOAD_KEY, JSON.stringify({ ...refusal, refused_at: new Date().toISOString() })]
        );
        if (stamped.rowCount !== 1) throw new Error('Refusal receipt transaction disappeared.');
        await client.query('commit');
      } catch (writeError) {
        await client.query('rollback');
        throw writeError;
      }
    });
    return true;
  } catch (auditError) {
    console.warn('[ledger_auto_post] refusal audit write failed', {
      transaction_id: transactionId,
      error: auditError?.message || String(auditError)
    });
    throw auditError;
  }
};

// A line that carries a raw PostgreSQL code as its posting refusal (stored
// before the transient rule: a lock, a serialization failure, a constraint
// error) was never refused. Before it is posted again its stamp is withdrawn
// and updated_at advances, so neither the eligibility damping nor the
// convergence projection (both read the receipt only while created_at >
// updated_at) nor any panel reading the stamp keeps listing it. The receipt
// that is withdrawn stays in the audit trail; the withdrawal is its own audit
// row, in the same transaction. A row another writer holds is left for the
// next tick (NOWAIT, classified like any other transient condition).
export const LEDGER_POST_REFUSAL_WITHDRAWN_ACTION = 'ledger.auto_post_refusal_withdrawn';
// Two literal statements (the second takes the row NOWAIT), not one template.
const REFUSAL_STATE_SQL = `select t.payload->'ledger_post_refusal' as stamp,
    (select a.metadata from audit_events a
      where a.firm_id = t.firm_id and a.client_id = t.client_id
        and a.action = 'ledger.auto_post_refused' and a.resource_type = 'transaction' and a.resource_id = t.id
        and a.created_at > t.updated_at
      order by a.created_at desc, a.id desc limit 1) as receipt
   from transactions t where t.firm_id = $1 and t.client_id = $2 and t.id = $3`;
const REFUSAL_STATE_FOR_UPDATE_SQL = `select t.payload->'ledger_post_refusal' as stamp,
    (select a.metadata from audit_events a
      where a.firm_id = t.firm_id and a.client_id = t.client_id
        and a.action = 'ledger.auto_post_refused' and a.resource_type = 'transaction' and a.resource_id = t.id
        and a.created_at > t.updated_at
      order by a.created_at desc, a.id desc limit 1) as receipt
   from transactions t where t.firm_id = $1 and t.client_id = $2 and t.id = $3 for update of t nowait`;
const databaseCodeRefusal = (row) => {
  if (!row) return null;
  const stamp = row.stamp && typeof row.stamp === 'object' ? row.stamp : null;
  if (stamp) return isRawDatabaseCode(stamp.code) ? stamp : null;
  return isRawDatabaseCode(row.receipt?.code) ? row.receipt : null;
};
export const withdrawDatabaseCodeRefusalViaDb = async ({ firmId, clientId, transactionId }) =>
  withFirmDbClient(async (client) => {
    if (!databaseCodeRefusal((await client.query(REFUSAL_STATE_SQL, [firmId, clientId, transactionId])).rows[0])) return false;
    await client.query('begin');
    try {
      const previous = databaseCodeRefusal((await client.query(REFUSAL_STATE_FOR_UPDATE_SQL, [firmId, clientId, transactionId])).rows[0]);
      if (!previous) { await client.query('rollback'); return false; }
      await client.query(
        `update transactions set payload = payload - $4::text, updated_at = now()
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, transactionId, LEDGER_POST_REFUSAL_PAYLOAD_KEY]);
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'ledger_auto_post', $4, 'transaction', $3, $5::jsonb)`,
        [firmId, clientId, transactionId, LEDGER_POST_REFUSAL_WITHDRAWN_ACTION,
          JSON.stringify({ reason: 'database_condition_was_not_a_refusal', previous_refusal: previous })]);
      await client.query('commit');
      return true;
    } catch (error) { await client.query('rollback'); throw error; }
  });

// What the receipt says. A named refusal is recorded as itself; anything else
// is an unexpected failure, recorded under that name with its message.
const refusalReceiptFor = (error) => isUnexpectedFailure(error)
  ? Object.assign(new Error(error?.pgMessage || error?.message || String(error)), {
    code: 'LEDGER_POST_UNEXPECTED_FAILURE', details: unexpectedFailureDetails(error) })
  : error;

// Run the sweep for one client. The flag is re-checked here (fail-closed on
// its own, like sweepCodingAutoPost) — the cron's pre-check only keeps the
// summary honest. Returns per-client stats; every count maps to a receipt.
export const sweepLedgerAutoPost = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId = null,
  env = process.env,
  configSnapshot = null,
  maxLines = LEDGER_AUTO_POST_MAX_LINES_PER_TICK,
  loadEligibleLinesFn = loadEligibleLinesViaDb,
  accountingSystemFn = getClientAccountingSystemFromDb,
  postLedgerFn = postLedgerTransactionInDb,
  processingScopeFn = readRetainedProcessingScopeInDb,
  recordRefusalFn = recordRefusalViaDb,
  withdrawRefusalFn = withdrawDatabaseCodeRefusalViaDb
} = {}) => {
  if (!clientId) return { gated: true, reason: 'missing_client_id' };
  if (!ledgerAutoPostAllows({ snapshot: configSnapshot, env })) {
    return { gated: true, reason: 'flag_off' };
  }
  // A missing profile key means no external system was ever connected — the
  // internal Donna ledger, same null→'none' read as api.js/feedChatApply.js.
  const accountingSystem = String((await accountingSystemFn({ firmId, clientId })) || 'none');
  if (accountingSystem !== 'none') {
    // External system of record — publication stays a deliberate human act.
    return { gated: true, reason: `external_accounting_system:${accountingSystem}` };
  }

  const scope = await processingScopeFn({ firmId, clientId });
  if (!scope.allowed) return { gated: true, reason: scope.reason_code, retryable: false };

  const stats = { gated: false, eligible: 0, posted: 0, refused: 0, refusal_receipts: 0 };
  // A repair invocation narrows discovery; it cannot relax eligibility, retry
  // damping, the config gate, or the named ledger writer's source fences.
  const discovered = await loadEligibleLinesFn({ firmId, clientId, limit: maxLines, transactionId });
  const transactionIds = transactionId ? discovered.filter((id) => id === transactionId) : discovered;
  stats.eligible = transactionIds.length;
  for (const transactionId of transactionIds) {
    const currentScope = await processingScopeFn({ firmId, clientId });
    if (!currentScope.allowed) return { ...stats, gated: true, reason: currentScope.reason_code, retryable: false };
    try {
      if (await withdrawRefusalFn({ firmId, clientId, transactionId })) stats.withdrawn = (stats.withdrawn || 0) + 1;
      const result = await postLedgerFn({
        firmId,
        clientId,
        transactionId,
        dryRun: false,
        actorId: 'ledger_auto_post',
        skipSnapshot: true
      });
      if (result?.ledger_posting?.state === 'waiting_on_owner') stats.waiting_on_owner = (stats.waiting_on_owner || 0) + 1;
      else stats.posted += 1;
    } catch (error) {
      if (isFenceContention(error)) {
        // Another writer (or autovacuum) held what the posting writer needed,
        // or the database aborted the attempt to keep it consistent. Nothing
        // was refused: no stamp, no receipt, no damping. The writer rolled
        // back whole; the next tick takes the line again, this one moves on.
        stats.contended = (stats.contended || 0) + 1;
        console.info('[ledger_auto_post] post contended (line untouched, next tick retries)', {
          client_id: clientId, transaction_id: transactionId, code: error.code
        });
        continue;
      }
      const receipt = refusalReceiptFor(error);
      stats.refused += 1;
      if (receipt !== error) stats.unexpected = (stats.unexpected || 0) + 1;
      const receipted = await recordRefusalFn({ firmId, clientId, transactionId, error: receipt });
      if (receipted) stats.refusal_receipts += 1;
      (receipt === error ? console.warn : console.error)(receipt === error
        ? '[ledger_auto_post] post refused (line stays accepted, receipted)'
        : '[ledger_auto_post] post failed unexpectedly (line stays accepted, receipted as LEDGER_POST_UNEXPECTED_FAILURE)', {
        client_id: clientId,
        transaction_id: transactionId,
        error_message: error?.message || String(error),
        code: error?.code || null,
        ...(receipt === error ? {} : { stack: error?.stack || null })
      });
    }
  }
  return stats;
};

// Cron discovery: clients carrying accepted-but-unposted lines (the same
// population shape the per-client sweep re-filters, minus the damping — a
// damped-only client costs one cheap query and sweeps zero lines).
// The retained marker is a per-client fact: evaluate it once per distinct
// client, never once per candidate line.
export const DISCOVER_LEDGER_POST_CLIENTS_SQL = `
  with unposted as materialized (
    select t.firm_id, t.client_id
      from transactions t
     where t.firm_id = $1
       and t.coding_state = 'applied'
       and (t.payload->>'ledger_journal_id') is null
       and coalesce(t.payload->>'ledger_status', '') <> 'posted'
       and t.status <> 'posted'
  ), scopes as materialized (
    select distinct firm_id, client_id from unposted
  ), marked as materialized (
    select s.client_id from scopes s where ${retainedNativeMarkerSql('s')}
  )
  select u.client_id, count(*)::int as unposted_lines
    from unposted u
   where not exists (select 1 from marked m where m.client_id = u.client_id)
   group by u.client_id
   order by count(*) desc, u.client_id
   limit $2
`;
