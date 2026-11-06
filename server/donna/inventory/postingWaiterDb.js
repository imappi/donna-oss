// Donna Inventory I4·posting — P7 §12 waiter drain (the READ-ONLY driver, D-POST-14).
//
// The pure disposition logic lives in postingWaiters.js; this module is its read-side shell: it
// gathers the non-terminal waiter attempts a client currently rests on (the latest attempt per
// (operation, kind) that is still waitered) plus each one's integration-retry count, runs the pure
// planner, and returns the drain PLAN + a disposition summary. It is strictly READ-ONLY — no
// INSERT/UPDATE/DELETE, no ledger write, no re-post. The three ACTIONS the plan implies each land
// in a later slice: a `retry` re-invokes the executor (isolation-class — a GO'd slice); an
// `open_incident` / `escalate` writes a NEW ops record (an additive slice). This ships the
// read+compute core first, mirroring P6a's read-only reconciliation engines.

import { planWaiterDrainBatch, DEFAULT_RETRY_BACKOFF_MS } from './postingWaiters.js';

// The HEAD outcomes that mean "a non-human/human waiter is still open" (drainable). A successful
// terminal (posted / no_journal_required), a superseded attempt, or an already-opened incident are
// NOT drainable. Explicit (not a NOT-IN wildcard) so a new outcome is a deliberate inclusion.
const DRAINABLE_OUTCOMES = Object.freeze(['refused', 'integration_wait', 'blocked_locked_period']);

const isMissingRelation = (error) => error?.code === '42P01' || error?.code === '42703';

// Read the current waiter HEADS — the latest attempt per (operation, kind) that is still in a
// drainable waiter state with a waiter_type set. Uses the rebuildable inventory_posting_heads
// projection so a later resolved/posted attempt correctly hides an earlier waiter. READ-ONLY.
export const readOpenWaiterHeads = async (client, firmId, clientId) => {
  const res = await client.query(
    `select attempt_id, operation_id, posting_kind, posting_basis_version, outcome, reason_code,
            waiter_type, waiter_id, next_action, retry_after, created_at
       from inventory_posting_heads
      where firm_id = $1 and client_id = $2
        and waiter_type is not null
        and outcome = any($3)
      order by created_at asc, attempt_id asc`,
    [firmId, clientId, DRAINABLE_OUTCOMES]
  );
  return res.rows || [];
};

// Per-(operation, kind) count of integration/system-retry attempts already made — the backoff
// index + exhaustion input for the planner. Counts the append-only attempt log (every failed retry
// appended one), NOT the heads view. READ-ONLY.
export const readIntegrationRetryCounts = async (client, firmId, clientId) => {
  const res = await client.query(
    `select operation_id, posting_kind, count(*)::int as retry_count
       from inventory_posting_attempts
      where firm_id = $1 and client_id = $2
        and waiter_type = 'integration_system_retry'
      group by operation_id, posting_kind`,
    [firmId, clientId]
  );
  const byKey = new Map();
  for (const r of res.rows || []) byKey.set(`${r.operation_id}::${r.posting_kind}`, Number(r.retry_count));
  return byKey;
};

// gatherWaiterState — the open waiter heads joined to their retry counts. Degrades to empty
// pre-migration (080 absent) rather than throwing into the caller. READ-ONLY.
export const gatherWaiterState = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) throw new Error('gatherWaiterState requires client, firmId, clientId');
  let heads = [];
  let retryCounts = new Map();
  try {
    heads = await readOpenWaiterHeads(client, firmId, clientId);
    retryCounts = await readIntegrationRetryCounts(client, firmId, clientId);
  } catch (error) {
    if (!isMissingRelation(error)) throw error; // pre-080: nothing to drain
  }
  return heads.map((h) => ({
    attempt: h,
    retryCount: retryCounts.get(`${h.operation_id}::${h.posting_kind}`) ?? 0
  }));
};

// planInventoryWaiterDrain — gather + run the pure planner, returning the drain plan + summary.
// READ-ONLY end to end: it returns what the driver SHOULD do; nothing is retried, escalated, or
// opened here (those consume the plan in later slices). `now` is injected (the caller owns the
// clock); `backoffMs` is overridable for tests / tuning.
export const planInventoryWaiterDrain = async ({ client, firmId, clientId, now = null, backoffMs = DEFAULT_RETRY_BACKOFF_MS } = {}) => {
  const waiters = await gatherWaiterState({ client, firmId, clientId });
  return planWaiterDrainBatch({ waiters, now, backoffMs });
};
