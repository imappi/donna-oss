// Donna Inventory I4·posting — P7 §12 waiter drain (the PURE disposition planner, D-POST-14).
//
// Every non-human waiter on a posting attempt must carry an EXECUTABLE trigger, not just a label
// (§12 D-POST-14): an integration/system-retry waiter has a concrete, bounded retry schedule and,
// on exhaustion, ESCALATES to a named human queue — it never retries forever silently; an
// engineering-incident waiter opens an actual incident record with an owning path. This module is
// the PURE, deterministic decision of WHAT the drain driver should do with a given waiter attempt —
// no DB, no I/O, no Date.now/Math.random/new Date (the clock is injected). The read-side that
// gathers due waiters + their retry counts and the writers that ACT on the plan (re-post — an
// isolation-class re-invocation of the executor; open an incident; record an escalation) are
// separate slices; this ships the read+compute core first, like P6a's read-only engines.
//
// KEEP-LAYER: this is deterministic routing arithmetic (is this retry due? exhausted? whose queue
// owns it now?). It substitutes for no model judgment — it just refuses to let a non-human waiter
// become a silent dead end (the FIRST principle: nothing rests un-owned).

// The disposition the driver should execute for a waiter attempt.
//   retry         — an integration/system-retry whose next attempt is DUE (re-test the condition,
//                   re-invoke the executor — the isolation-class action, behind a GO).
//   wait          — a retry that is scheduled but NOT yet due (rests with a concrete next_retry_at).
//   escalate      — a retry that EXHAUSTED its bounded schedule → hand to a named human queue.
//   open_incident — an engineering-incident waiter → open an actual incident record + owning path.
//   human_owned   — a waiter a human queue already owns (owner / accountant / operator / compliance):
//                   a valid resting state, no automated drive.
export const WAITER_DISPOSITIONS = Object.freeze(['retry', 'wait', 'escalate', 'open_incident', 'human_owned']);

// Waiter types a HUMAN queue already owns — the driver takes no automated action (two-terminal-states:
// these rest visibly owned). Mirrors postingLog.js INVENTORY_POSTING_WAITER_TYPES minus the two
// machine-driven ones (integration_system_retry, engineering_incident).
export const HUMAN_OWNED_WAITERS = Object.freeze(['owner', 'accountant_operator', 'integration_operator', 'product_compliance']);

// The default BOUNDED retry backoff for an integration/system-retry waiter (ms since the most
// recent failed attempt). After this many failed attempts the waiter EXHAUSTS and escalates —
// never an unbounded retry loop (§12 D-POST-14). Deterministic; overridable per call.
export const DEFAULT_RETRY_BACKOFF_MS = Object.freeze([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]); // 1m · 5m · 30m · 2h · 6h

// The named human queue an EXHAUSTED integration retry escalates to (§12: "bounded, then operator").
export const RETRY_EXHAUSTION_QUEUE = 'integration_operator';
// The owning path an engineering-incident waiter routes to.
export const ENGINEERING_INCIDENT_QUEUE = 'engineering';

const toEpoch = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const asInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };

// planWaiterDisposition — decide the driver action for ONE non-terminal waiter attempt.
//
// `attempt`: an inventory_posting_heads / inventory_posting_attempts row — { waiter_type,
//   reason_code, next_action, created_at, operation_id, posting_kind, ... }. `created_at` is the
//   most-recent attempt's timestamp (the backoff anchor).
// `retryCount`: how many integration/system-retry attempts have ALREADY been made for this
//   (operation, kind) — ≥1 for an existing retry waiter. Exhaustion = retryCount ≥ backoffMs.length.
// `now`: the injected decision instant (Date | ISO). A null now can still decide exhaustion /
//   incident / human-owned; it only forces a due retry to 'wait' (dueness needs a clock).
//
// Returns { disposition, waiter_type, condition, target_queue, next_retry_at, retries_used,
//   retries_max, reason }.
export const planWaiterDisposition = ({ attempt = {}, retryCount = 0, now = null, backoffMs = DEFAULT_RETRY_BACKOFF_MS } = {}) => {
  const waiter = attempt.waiter_type ?? attempt.waiterType ?? null;
  const condition = attempt.next_action ?? attempt.nextAction ?? null;
  const reason = attempt.reason_code ?? attempt.reasonCode ?? null;
  const base = {
    waiter_type: waiter, condition, reason,
    operation_id: attempt.operation_id ?? attempt.operationId ?? null,
    posting_kind: attempt.posting_kind ?? attempt.postingKind ?? null,
    // The head attempt this plan is about — provenance for the incident record (084).
    attempt_id: attempt.attempt_id ?? attempt.attemptId ?? attempt.id ?? null
  };

  // An engineering incident opens a record with an owning path — never a retry, never a human ask.
  if (waiter === 'engineering_incident') {
    return { ...base, disposition: 'open_incident', target_queue: ENGINEERING_INCIDENT_QUEUE, next_retry_at: null, retries_used: null, retries_max: null };
  }

  // A bounded, executable retry (§12 D-POST-14).
  if (waiter === 'integration_system_retry') {
    const schedule = Array.isArray(backoffMs) && backoffMs.length > 0 ? backoffMs : DEFAULT_RETRY_BACKOFF_MS;
    const max = schedule.length;
    const used = Math.max(asInt(retryCount), 0);
    // Exhausted → escalate to the named human queue (no clock needed).
    if (used >= max) {
      return { ...base, disposition: 'escalate', target_queue: RETRY_EXHAUSTION_QUEUE, next_retry_at: null, retries_used: used, retries_max: max };
    }
    // Not exhausted → the next attempt is scheduled backoffMs[used] after the most recent failure.
    const anchor = toEpoch(attempt.created_at ?? attempt.createdAt);
    const delay = schedule[used];
    const nextAtEpoch = anchor != null ? anchor + delay : null;
    const nowEpoch = toEpoch(now);
    // Due only when we can prove the clock has passed the schedule; every doubt → wait (never an
    // over-eager retry). retry_after already persisted on the row wins if present (an explicit
    // schedule the executor set), else the computed backoff.
    const persistedRetryAfter = toEpoch(attempt.retry_after ?? attempt.retryAfter);
    const dueAtEpoch = persistedRetryAfter != null ? persistedRetryAfter : nextAtEpoch;
    const due = nowEpoch != null && dueAtEpoch != null && nowEpoch >= dueAtEpoch;
    return {
      ...base,
      disposition: due ? 'retry' : 'wait',
      target_queue: null,
      next_retry_at: dueAtEpoch != null ? new Date(dueAtEpoch).toISOString() : null,
      retries_used: used, retries_max: max
    };
  }

  // A human queue already owns it (owner / accountant / operator / compliance) — a valid resting
  // state, no automated drive. An unknown/absent waiter fails toward a human (accountant/operator),
  // never a silent auto-action.
  const target = HUMAN_OWNED_WAITERS.includes(String(waiter)) ? waiter : 'accountant_operator';
  return { ...base, disposition: 'human_owned', target_queue: target, next_retry_at: null, retries_used: null, retries_max: null };
};

// planWaiterDrainBatch — map the planner over a set of gathered waiter attempts + their retry
// counts, returning the plans plus a disposition summary. PURE (the DB gather is postingWaiterDb).
export const planWaiterDrainBatch = ({ waiters = [], now = null, backoffMs = DEFAULT_RETRY_BACKOFF_MS } = {}) => {
  const plans = (Array.isArray(waiters) ? waiters : []).map((w) =>
    planWaiterDisposition({ attempt: w.attempt ?? w, retryCount: w.retryCount ?? w.retry_count ?? 0, now, backoffMs })
  );
  const summary = { retry: 0, wait: 0, escalate: 0, open_incident: 0, human_owned: 0 };
  for (const p of plans) if (p.disposition in summary) summary[p.disposition] += 1;
  return { plans, summary, total: plans.length };
};
