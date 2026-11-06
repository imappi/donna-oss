// Donna Inventory I4·posting — P7 §12 retry re-post (the ACTION driver, D-POST-14). ISOLATION-CLASS.
//
// The waiter-drain planner (postingWaiters.js) decides WHAT to do with each stuck posting; slice A
// (postingIncidentDb.js) actioned the escalate/open_incident dispositions. THIS module actions the
// remaining machine-driven disposition — `retry`: an integration/system-retry waiter whose bounded
// backoff has come DUE. Per §12 D-POST-14, an integration-retry waiter "has a concrete, bounded
// retry mechanism (the retry_after schedule + the condition it re-tests) and, on exhaustion, it
// ESCALATES to a named human queue — it never retries forever silently." This driver is the
// re-test-and-re-post half: for each due `retry`, it re-invokes the P5 executor
// (postInventoryJournalWithinTransaction — the ONE inventory post path, never a new backend) with a
// FRESHLY-REBUILT draft, and classifies the outcome.
//
// It POSTS ⇒ isolation-class. It does not fork the executor, does not write the ledger itself, and
// does not touch the attempts log / heads projection except THROUGH the executor. The re-post is
// safe at the same (operation, kind, posting_basis_version): the executor's idempotency re-fetch
// short-circuits ONLY on a prior SUCCESS, so a prior refused/integration_wait attempt does not block
// a re-post, and the partial-unique index constrains successful outcomes only.
//
// "Re-test the condition" is DOMAIN logic (is the FX fact present now? has the receipt arrived?
// re-run the §16 GRNI engine), owned by the CALLER — not the driver. The caller supplies a `rebuild`
// resolver that re-tests the condition and returns fresh executor params:
//   • condition NOW MET      → a success draft → the executor posts (the retry drains to POSTED).
//   • condition STILL UNMET  → a refusal draft (from the domain builder, still waiter_type
//                              integration_system_retry) → the executor records a fresh tracked
//                              attempt, advancing the retry count toward exhaustion so slice A's
//                              escalate eventually fires. This is how the loop stays BOUNDED and
//                              never a silent forever-retry.
//   • no resolver for this   → `null` → the driver takes NO action and surfaces it as `unhandled`
//     item (a different       in the summary (visible, never silently dropped) — the original
//     resolver / next cycle)  attempts still stand, and the drain will re-present it next cycle.
//
// The driver drives ONLY `retry`. wait stays waiting (not yet due); escalate/open_incident/
// human_owned are not its job (slice A / a human queue own them) — it echoes their counts for
// observability but takes no action on them.

import { planInventoryWaiterDrain } from './postingWaiterDb.js';
import { postInventoryJournalWithinTransaction } from './postingDb.js';
import { DEFAULT_RETRY_BACKOFF_MS } from './postingWaiters.js';

// The executor params a `rebuild` resolver may thread into the re-post. Only `draft` is required;
// the rest default in the executor. The driver forwards exactly these (an allow-list — a resolver
// can't smuggle in arbitrary executor internals).
const REBUILD_PARAM_KEYS = Object.freeze([
  'draft', 'postingBasisVersion', 'valuationIdentity', 'expectedInputHash', 'expectedProposalHash',
  'provenance', 'authorityGrantId', 'allocations', 'journalGroupId', 'relationship', 'period',
  'accountingReady', 'allowanceLot'
]);

// Classify one executor result into the driver's summary buckets. A re-post either drained to a
// success terminal, refused again (still a tracked waiter — progressing toward exhaustion), or was
// blocked by a locked period.
const classifyResult = (result) => {
  if (!result) return 'unhandled';
  if (result.outcome === 'posted' || result.status === 'posted') return 'reposted';
  if (result.outcome === 'no_journal_required') return 'no_journal';
  if (result.status === 'replayed') return 'already_applied';
  if (result.outcome === 'blocked_locked_period') return 'blocked';
  if (result.refused) return 'still_waiting'; // recorded a fresh tracked attempt → advances exhaustion
  return 'still_waiting';
};

// driveInventoryWaiterRetriesWithinTransaction — re-post every DUE retry in the caller's txn.
//
// Runs the READ-ONLY drain plan, then for each `retry` disposition asks `rebuild` for fresh
// executor params (re-testing the condition) and re-invokes the P5 executor. Mirrors the P6b/P6c
// multi-post primitives: the batch runs atomically in the caller's transaction (a genuine
// unexpected throw from the executor rolls the batch back — fail-safe, never a half-applied drain;
// KNOWN refusals do not throw, they record tracked attempts).
//
// `rebuild`: async ({ tx, item }) => executorParams | null. `item` is a plan row from
//   planWaiterDisposition ({ disposition:'retry', operation_id, posting_kind, condition, reason,
//   attempt_id, retries_used, retries_max, ... }). It may query `tx` (same txn) to re-test the
//   condition. Return the executor params (must include `draft`) or null to leave the retry
//   unhandled this cycle.
// `now`: the injected decision instant (Date | ISO) — dueness needs a clock (null → nothing is due).
// `dryRun`: forwarded to the executor (preview only — writes nothing).
export const driveInventoryWaiterRetriesWithinTransaction = async (tx, {
  firmId, clientId, actorId = 'system', now = null, rebuild, backoffMs = DEFAULT_RETRY_BACKOFF_MS, dryRun = false
} = {}) => {
  if (!tx || typeof tx.query !== 'function') throw new Error('driveInventoryWaiterRetries: a transaction client is required.');
  if (!firmId || !clientId) throw new Error('driveInventoryWaiterRetries: firmId and clientId are required.');
  if (typeof rebuild !== 'function') throw new Error('driveInventoryWaiterRetries: a rebuild(resolver) function is required.');

  const plan = await planInventoryWaiterDrain({ client: tx, firmId, clientId, now, backoffMs });
  const summary = { reposted: 0, still_waiting: 0, no_journal: 0, blocked: 0, already_applied: 0, unhandled: 0 };
  const results = [];

  for (const item of plan.plans) {
    if (item.disposition !== 'retry') continue; // wait / escalate / open_incident / human_owned are not this driver's job
    const rebuilt = await rebuild({ tx, item });
    if (rebuilt == null || typeof rebuilt !== 'object' || !rebuilt.draft) {
      // No resolver for this retry (or the resolver declined) — surfaced, never silently dropped.
      // The original attempts still stand; the next drain re-presents it (and exhaustion still
      // backstops via slice A once the count crosses the ceiling).
      summary.unhandled += 1;
      results.push({ operation_id: item.operation_id, posting_kind: item.posting_kind, disposition: 'unhandled', reason: item.reason, condition: item.condition });
      continue;
    }
    const params = { firmId, clientId, actorId, dryRun };
    for (const k of REBUILD_PARAM_KEYS) if (rebuilt[k] !== undefined) params[k] = rebuilt[k];
    const result = await postInventoryJournalWithinTransaction(tx, params);
    const bucket = classifyResult(result);
    summary[bucket] += 1;
    results.push({
      operation_id: item.operation_id, posting_kind: item.posting_kind, disposition: bucket,
      outcome: result.outcome ?? result.status ?? null, ledger_journal_id: result.ledger_journal_id ?? null,
      attempt_id: result.attempt_id ?? null, reason_code: result.reason_code ?? null,
      waiter_type: result.waiter_type ?? null
    });
  }

  return {
    status: dryRun ? 'dry_run' : 'driven',
    plan_summary: plan.summary,
    due_retries: results.length,
    summary,
    results
  };
};

// driveInventoryWaiterRetriesFromDb — the begins→commits wrapper (mirror the P5/P6b -FromDb form).
export const driveInventoryWaiterRetriesFromDb = async (db, params = {}) => {
  if (!db || typeof db.connect !== 'function') throw new Error('driveInventoryWaiterRetriesFromDb: a pg pool (db.connect) is required.');
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await driveInventoryWaiterRetriesWithinTransaction(client, params);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
