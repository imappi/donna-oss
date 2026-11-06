// Donna Loops — the outbox-dispatch PLANNER (goal-first uplift, design §10 Step 7).
//
// See docs/loops-architecture-uplift-design.md §2 + §10 Step 7. Migration 033 ships
// loop_event_outbox but NO dispatcher — "Phase 1 NEVER marks a row 'dispatched'…
// No dispatcher ships here" (033:183-184) — so rows sit 'pending' forever. The real
// dispatcher (Step 7) is greenfield and must honor INV-11 (no external API call
// inside a core DB transaction — Xero/QBO are async) and at-least-once delivery.
//
// This leaf is the dispatcher's PURE brain: given a batch of outbox rows + a clock,
// it produces a DETERMINISTIC dispatch plan — what to send NOW, what to DEFER
// (backoff window, serialized behind an in-flight sibling, or over the concurrency
// cap), what to GIVE UP on (dead-letter → escalate), and what to DROP as a
// duplicate. It performs NO I/O and calls NO external API, so INV-11 is trivially
// satisfied: the dispatcher reads the plan and does the sends OUTSIDE the DB
// transaction, then re-plans on the next wake.
//
// CLAUDE.md "Keep"-layer: ordering, backoff, idempotency, and a dead-letter
// circuit-breaker are system-correctness scaffolding (at-least-once + INV-11), not
// intelligence-substituting rules. Deterministic so a dispatch run is auditable and
// replayable (asOf-injected, like nextCaseSelector) — the same discipline as
// loopRun's lease/budget pieces. Imports only the outbox status enum (its canonical
// owner) so it stays a thin leaf the worker can import without a cycle.

import { LOOP_OUTBOX_STATUSES } from './loopEventOutbox.js';

export { LOOP_OUTBOX_STATUSES };

// ---- dispatch policy ------------------------------------------------------

// Bounds the dispatcher the way executionPolicy bounds a wake. An absent field
// falls back to its default (never to "unbounded") — the same safe-default
// discipline as loopRun's budget caps.
export const DEFAULT_DISPATCH_POLICY = Object.freeze({
  maxAttempts: 5,                    // after this, dead-letter the row (escalate)
  baseBackoffMs: 1_000,              // exponential: base * 2^(attempts-1)
  maxBackoffMs: 60 * 60 * 1_000,     // cap a backoff window at 1h
  maxConcurrent: 8,                  // max lanes dispatched in one plan
  dispatchingStuckMs: 5 * 60 * 1_000 // reclaim a 'dispatching' row stuck this long (crashed dispatcher)
});

const posInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

export const normalizeDispatchPolicy = (policy = {}) => {
  const p = policy || {};
  return Object.freeze({
    maxAttempts: posInt(p.maxAttempts, DEFAULT_DISPATCH_POLICY.maxAttempts),
    baseBackoffMs: posInt(p.baseBackoffMs, DEFAULT_DISPATCH_POLICY.baseBackoffMs),
    maxBackoffMs: posInt(p.maxBackoffMs, DEFAULT_DISPATCH_POLICY.maxBackoffMs),
    maxConcurrent: posInt(p.maxConcurrent, DEFAULT_DISPATCH_POLICY.maxConcurrent),
    dispatchingStuckMs: posInt(p.dispatchingStuckMs, DEFAULT_DISPATCH_POLICY.dispatchingStuckMs)
  });
};

// Exponential backoff for a row that has already been attempted `attempts` times:
// base * 2^(attempts-1), capped. attempts<=0 (never tried) has no backoff window.
export const backoffMs = (attempts, policy = {}) => {
  const p = normalizeDispatchPolicy(policy);
  const n = Math.max(0, Math.floor(Number(attempts) || 0));
  if (n <= 0) return 0;
  return Math.min(p.maxBackoffMs, p.baseBackoffMs * (2 ** (n - 1)));
};

// ---- row normalization ----------------------------------------------------

const toMs = (t) => {
  if (t === null || t === undefined) return null;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
};

// When a row was last attempted — used to measure the backoff / stuck window. The
// outbox has no explicit last_attempt_at column, so derive it: an explicit
// override, else the failure stamp the dispatcher writes into last_error.at, else
// the success stamp, else created_at.
const lastAttemptAtMs = (row) =>
  toMs(row.lastAttemptAt) ?? toMs(row.last_error?.at) ?? toMs(row.dispatched_at) ?? toMs(row.created_at);

// Two rows are duplicates ONLY when they carry the SAME explicit idempotency key —
// never an inferred (event_type, object) heuristic, which could collapse distinct
// side effects. A null key means "unique; never deduped".
const dedupKeyOf = (row) => {
  const p = row.payload || {};
  return p.idempotencyKey ?? p.dedupeKey ?? null;
};

// Events for the SAME target object serialize (an external sync to one Xero
// invoice must not race itself); events with no shared target are independent.
const serializationKeyOf = (row) =>
  row.object_type && row.object_id ? `${row.object_type}:${row.object_id}` : null;

const rowView = (row) => ({
  id: String(row.id),
  status: row.status || 'pending',
  attempts: Math.max(0, Math.floor(Number(row.attempts) || 0)),
  createdAt: toMs(row.created_at),
  lastAttemptAt: lastAttemptAtMs(row),
  dedupKey: dedupKeyOf(row),
  serializationKey: serializationKeyOf(row)
});

// Deterministic FIFO base order (created_at, then id). Everything downstream
// preserves it so the whole plan is replayable from (rows, asOf, policy).
const byCreatedThenId = (a, b) => {
  const ca = a.createdAt;
  const cb = b.createdAt;
  if (ca !== null && cb !== null && ca !== cb) return ca - cb;
  if (ca !== null && cb === null) return -1;
  if (ca === null && cb !== null) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// ---- the plan -------------------------------------------------------------

// Produce a deterministic dispatch plan over a batch of outbox rows:
//   ready        — dispatch NOW (one head per serialization lane, capped at
//                  maxConcurrent), each as `{ id, serializationKey, attempts, attempt }`
//   deferred     — not now: `{ id, reason, ... }` where reason ∈
//                  { backoff (+readyAt) | lane_blocked (+blockedBy) |
//                    concurrency_cap | dispatching }
//   deadLettered — out of attempts: `{ id, reason:'max_attempts', attempts }` → escalate
//   duplicates   — collapsed by idempotency key: `{ id, supersededBy, dedupKey }`
//
// Terminal rows (dispatched / cancelled) are ignored. asOf is injected (epoch ms or
// ISO) for replayability; it defaults to now only as a convenience.
export const planOutboxDispatch = ({ rows = [], asOf = Date.now(), policy } = {}) => {
  if (!Array.isArray(rows)) throw new Error('planOutboxDispatch: rows must be an array');
  const p = normalizeDispatchPolicy(policy);
  const asOfMs = toMs(asOf) ?? Date.now();

  const ready = [];
  const deferred = [];
  const deadLettered = [];
  const duplicates = [];

  // 1. Validate + drop terminal rows.
  const live = [];
  for (const row of rows) {
    if (!row || row.id === undefined || row.id === null || row.id === '') {
      throw new Error('planOutboxDispatch: every row needs an id');
    }
    const status = row.status || 'pending';
    if (!LOOP_OUTBOX_STATUSES.includes(status)) {
      throw new Error(`planOutboxDispatch: unknown outbox status "${status}" (row ${row.id})`);
    }
    if (status === 'dispatched' || status === 'cancelled') continue; // terminal
    live.push(rowView(row));
  }
  live.sort(byCreatedThenId);

  // 2. Dead-letter rows that are out of attempts (give up → escalate), ahead of
  //    any backoff: an exhausted row never becomes eligible again.
  const retryable = [];
  for (const r of live) {
    if (r.attempts >= p.maxAttempts) {
      deadLettered.push({ id: r.id, reason: 'max_attempts', attempts: r.attempts });
    } else {
      retryable.push(r);
    }
  }

  // 3. Dedup by explicit idempotency key — keep the earliest (FIFO), skip the rest.
  const survivors = [];
  const survivorByKey = new Map();
  for (const r of retryable) {
    if (r.dedupKey === null) { survivors.push(r); continue; }
    const survivor = survivorByKey.get(r.dedupKey);
    if (survivor) {
      duplicates.push({ id: r.id, supersededBy: survivor.id, dedupKey: r.dedupKey });
    } else {
      survivorByKey.set(r.dedupKey, r);
      survivors.push(r);
    }
  }

  // 4. Eligibility: honor the backoff window; reclaim a 'dispatching' row only once
  //    it has been stuck longer than dispatchingStuckMs (a crashed dispatcher).
  const eligible = [];
  for (const r of survivors) {
    if (r.status === 'dispatching') {
      const since = r.lastAttemptAt ?? r.createdAt;
      if (since !== null && asOfMs - since < p.dispatchingStuckMs) {
        deferred.push({ id: r.id, reason: 'dispatching' });
        continue;
      }
      eligible.push(r); // stuck → reclaim now (the stuck window already elapsed)
      continue;
    }
    if (r.attempts > 0) {
      const since = r.lastAttemptAt ?? r.createdAt ?? asOfMs;
      const readyAt = since + backoffMs(r.attempts, p);
      if (asOfMs < readyAt) {
        deferred.push({ id: r.id, reason: 'backoff', readyAt });
        continue;
      }
    }
    eligible.push(r);
  }

  // 5. Serialize per target: only the earliest eligible row of each serialization
  //    key may dispatch; later siblings wait behind their lane head.
  const laneHeadByKey = new Map();
  const heads = [];
  for (const r of eligible) {
    if (r.serializationKey === null) { heads.push(r); continue; } // independent
    const head = laneHeadByKey.get(r.serializationKey);
    if (head) {
      deferred.push({ id: r.id, reason: 'lane_blocked', blockedBy: head.id });
    } else {
      laneHeadByKey.set(r.serializationKey, r);
      heads.push(r);
    }
  }

  // 6. Concurrency cap: dispatch the first maxConcurrent lane heads now (FIFO); the
  //    rest wait for capacity on a later wake.
  heads.forEach((r, i) => {
    if (i < p.maxConcurrent) {
      ready.push({ id: r.id, serializationKey: r.serializationKey, attempts: r.attempts, attempt: r.attempts + 1 });
    } else {
      deferred.push({ id: r.id, reason: 'concurrency_cap' });
    }
  });

  return { ready, deferred, deadLettered, duplicates };
};
