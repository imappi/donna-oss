// Donna — BizOS Slice 2c-iii (sub-PR 6): the bounded, cancellable, isolated
// hot-path retrieval (§J, amendments 7-adjacent + 8).
//
// Inline retrieval is unavoidable for a canary (it must feed the prompt), so it
// goes on the owner's critical path. A bare timeout that stops AWAITING a promise
// still leaks DB connections, CPU, cache. This module bounds it properly:
//
//   - `buildMemoryBundleWithDeadline` — races the governed read against a deadline
//     with real AbortSignal propagation, so the owner's TURN never waits past the
//     deadline and a signal-aware loader can stop work. On deadline → a `timedOut`
//     outcome the taxonomy maps to `unavailable/timeout` (§E1), NEVER legacy (§D).
//   - a small CIRCUIT BREAKER — after N consecutive infra failures/timeouts it
//     short-circuits to a controlled `unavailable` (no retry storm, no hammering a
//     sick dependency), and closes again after a cooldown.
//   - `resolveCanaryDeadlineMs` — the deadline from the shadow distribution, not a
//     round number: clamp(shadow_p99 + 100ms, 250, 500). `MEMORY_RETRIEVAL_CANARY_
//     TIMEOUT_MS` is a legit env tuning knob (config-plane rail: env keeps tuning
//     knobs). Alert on sustained timeout RATE, not by raising the timeout.
//   - `shouldRunLegacyEvalSidecar` — the legacy comparison stays a NON-BLOCKING
//     evaluation sidecar (2c-ii posts it post-response) with a SUNSET: after the
//     first period, move from 100% to sampled comparison, with a deletion date for
//     the legacy-set retention.
//
// The outcome shape ({ result, timedOut, threw, ... }) feeds `classifyAndRenderV2`
// directly. Pure-ish leaf: no config read, no model. The seam (sub-PR 7) kicks the
// retrieval off CONCURRENTLY with the other independent context lookups.

// ── Deadline budget (§L-4) ────────────────────────────────────────────────────

export const CANARY_DEADLINE_FLOOR_MS = 250;
export const CANARY_DEADLINE_CEIL_MS = 500;
export const CANARY_DEADLINE_DEFAULT_MS = 350;   // used only when no shadow p99 is known

export const clampCanaryDeadlineMs = (shadowP99Ms) => {
  const base = Number.isFinite(shadowP99Ms) ? shadowP99Ms + 100 : CANARY_DEADLINE_DEFAULT_MS;
  return Math.min(CANARY_DEADLINE_CEIL_MS, Math.max(CANARY_DEADLINE_FLOOR_MS, Math.round(base)));
};

// The env override is a tuning knob (never a rollout flag). An out-of-sane-range
// value is ignored (fail safe to the clamped value), so a fat-fingered env can
// never set a 30s owner-turn timeout.
export const resolveCanaryDeadlineMs = ({ env = process.env, shadowP99Ms = null } = {}) => {
  const raw = Number(env?.MEMORY_RETRIEVAL_CANARY_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= CANARY_DEADLINE_FLOOR_MS && raw <= CANARY_DEADLINE_CEIL_MS) {
    return Math.round(raw);
  }
  return clampCanaryDeadlineMs(shadowP99Ms);
};

// ── Circuit breaker ───────────────────────────────────────────────────────────
//
// Deliberately tiny + per-process. Counts only INFRA failures (throws / timeouts),
// never policy refusals (an `empty`/`blocked` is a correct governed outcome, not a
// sick dependency). `now` is injectable for deterministic tests.
export class MemoryRetrievalCircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 30000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this._now = now;
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  isOpen() {
    if (this.openedAt == null) return false;
    if (this._now() - this.openedAt >= this.cooldownMs) {
      // cooldown elapsed → half-open: allow one trial, reset the counter.
      this.openedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  onResult(ok) {
    if (ok) {
      this.consecutiveFailures = 0;
      this.openedAt = null;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) this.openedAt = this._now();
  }
}

// One shared breaker for the live seam; tests inject their own.
export const sharedMemoryRetrievalBreaker = new MemoryRetrievalCircuitBreaker();

// ── The deadline wrapper ──────────────────────────────────────────────────────
//
// buildMemoryBundleWithDeadline({ invocation, deps, deadlineMs, buildBundle, breaker, now })
//   → { result, timedOut, threw, shortCircuited, durationMs }
//
// `invocation` is { trustedContext, request }. The signal is threaded into the deps
// (a signal-aware loader may cancel its query); regardless, the caller stops
// awaiting at the deadline so the owner turn is never hung. The losing promise is
// swallowed to avoid an unhandled rejection.
export const buildMemoryBundleWithDeadline = async ({
  invocation,
  deps = {},
  deadlineMs = CANARY_DEADLINE_DEFAULT_MS,
  buildBundle,
  breaker = sharedMemoryRetrievalBreaker,
  now = () => Date.now()
} = {}) => {
  if (typeof buildBundle !== 'function') {
    throw new Error('buildMemoryBundleWithDeadline requires buildBundle');
  }
  const started = now();

  if (breaker && breaker.isOpen()) {
    // Sick dependency — do not even attempt; controlled unavailable (no retry storm).
    return { result: null, timedOut: false, threw: false, shortCircuited: true, durationMs: 0 };
  }

  const controller = new AbortController();
  const signalDeps = { ...deps, signal: controller.signal };

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__deadline__'), deadlineMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  let outcome;
  try {
    const work = Promise.resolve()
      .then(() => buildBundle({ ...invocation, deps: signalDeps }))
      .then((result) => ({ kind: 'result', result }), (err) => ({ kind: 'threw', err }));
    // Swallow the loser to prevent an unhandled rejection if the deadline wins.
    work.catch(() => {});

    const winner = await Promise.race([work, deadline]);

    if (winner === '__deadline__') {
      controller.abort();                                  // real cancellation signal
      breaker.onResult(false);
      outcome = { result: null, timedOut: true, threw: false, shortCircuited: false };
    } else if (winner.kind === 'threw') {
      breaker.onResult(false);
      outcome = { result: null, timedOut: false, threw: true, shortCircuited: false };
    } else {
      // A governed refusal is NOT an infra failure — only throws/timeouts trip the
      // breaker. A successful (ok/refused) bundle closes it.
      breaker.onResult(true);
      outcome = { result: winner.result, timedOut: false, threw: false, shortCircuited: false };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { ...outcome, durationMs: now() - started };
};

// ── Legacy-eval sidecar sunset (§J) ───────────────────────────────────────────
//
// The legacy comparison fetch runs off the response path (2c-ii posts it after the
// owner reply). Its SUNSET: 100% for the first period, then sampled, with a
// deletion date for the legacy-set retention. Deterministic sampler (no per-call
// RNG on the hot path): hashes the retrieval id to a stable bucket.
export const shouldRunLegacyEvalSidecar = ({ retrievalId = '', sampleRate = 1 } = {}) => {
  if (!(sampleRate > 0)) return false;
  if (sampleRate >= 1) return true;
  let h = 0;
  const s = String(retrievalId);
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 < sampleRate;
};
