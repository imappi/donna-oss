// Donna — the shared provider transport contract (2026-09-13, FI
// provider-failure pass; docs/finding-2026-09-13-fi-provider-failure-recovery.md).
//
// ONE LAW FOR EVERY LOAD-BEARING MODEL CALL. Before this module the matcher,
// the coder and the ask drafter each read the provider on their own terms:
// the coder persisted its deterministic template when the model returned an
// unreadable body or the socket reset, the matcher's wrapper answered a 401
// with the weighted matcher, a network TypeError reached the ask outbox
// without a code, and none of the three bounded the request — a body that
// never arrived pinned the worker past the scheduler's timeout and then
// wrote a late verdict. The same event got three different treatments, and
// each of them could turn a transport fact into an accounting claim.
//
// This module fixes the SHAPE, not the intelligence:
//
//   1. TYPED CAUSE. A provider failure is a `ProviderFailureError` with a
//      closed `code` (below), the provider, the HTTP status when there was
//      one, a short machine reason, `retryable`, and the human `owner` who
//      can act on it: a credential problem (`PROVIDER_KEY_MISSING`,
//      `PROVIDER_UNAUTHORIZED`) rests on the OPERATOR — it is never a missing
//      bookkeeping fact and never an owner question; everything transient
//      rests on the QUEUE (the existing clocks re-drive it).
//   2. THE SAME TREATMENT FOR THE SAME EVENT. A hung socket, a reset socket,
//      a 5xx, a 429 and a body that is not JSON are all "the provider did
//      not answer" — receipted with their cause, never persisted as a verdict,
//      re-driven when the provider answers.
//   3. A DEADLINE OVER THE WHOLE OPERATION. Headers AND body are read under
//      one AbortSignal; the per-attempt timeout never exceeds the worker's
//      remaining execution budget (executionBudget.js) minus a reserve, and
//      the scheduler's abort rejects an in-flight call at once. A response
//      that arrives after the deadline is DROPPED — it can no longer be
//      returned to the caller, so it can never be written.
//
// What this module deliberately does NOT do: choose models, rewrite prompts,
// retry on content, or judge what the model said (CLAUDE.md, the
// trust-the-strong-LLM rail) — the sole content rule is that a body the
// caller's parser cannot read at all is a transport failure
// (`PROVIDER_INVALID_OUTPUT`), because no judgment exists to render.
//
// Env knobs (tuning, per the flags rail): PROVIDER_REQUEST_TIMEOUT_MS (one
// attempt, headers + body; default 90s) and PROVIDER_BUDGET_RESERVE_MS (kept
// back for the worker's own receipts; default 15s).

import { currentExecutionBudget, remainingExecutionBudgetMs } from './executionBudget.js';

export const PROVIDER_FAILURE_CODES = Object.freeze({
  KEY_MISSING: 'PROVIDER_KEY_MISSING',
  UNAUTHORIZED: 'PROVIDER_UNAUTHORIZED',
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  REJECTED_REQUEST: 'PROVIDER_REJECTED_REQUEST',
  TIMEOUT: 'PROVIDER_TIMEOUT',
  NETWORK: 'PROVIDER_NETWORK',
  INVALID_OUTPUT: 'PROVIDER_INVALID_OUTPUT',
  SPEND_LIMIT: 'PROVIDER_SPEND_LIMIT'
});

export const PROVIDER_FAILURE_OWNERS = Object.freeze(['operator', 'queue']);

export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 90_000;
export const DEFAULT_PROVIDER_BUDGET_RESERVE_MS = 15_000;
// The shortest attempt worth starting: below this the budget is spent.
export const MIN_PROVIDER_ATTEMPT_MS = 2_000;

const PROVIDER_LABELS = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openai_compatible: 'openai_compatible endpoint'
});

const envNumber = (name, fallback, { min = 0 } = {}) => {
  const raw = process.env?.[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

// A timeout must be positive; a reserve of 0 is a legitimate setting.
export const providerRequestTimeoutMs = () => envNumber('PROVIDER_REQUEST_TIMEOUT_MS', DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, { min: 1 });
export const providerBudgetReserveMs = () => envNumber('PROVIDER_BUDGET_RESERVE_MS', DEFAULT_PROVIDER_BUDGET_RESERVE_MS, { min: 0 });

export const providerLabel = (provider) => PROVIDER_LABELS[provider] || String(provider || 'provider');

// ── The typed failure ──────────────────────────────────────────────────────
export class ProviderFailureError extends Error {
  constructor({
    code,
    provider = null,
    status = null,
    reason = null,
    message = null,
    retryable = true,
    owner = 'queue',
    attempts = 1,
    cause = null,
    budget = null
  } = {}) {
    super(message || `${providerLabel(provider)} request failed (${code})`);
    this.name = 'ProviderFailureError';
    this.code = code;
    this.provider = provider;
    this.status = Number.isFinite(Number(status)) && Number(status) > 0 ? Number(status) : null;
    this.reason = reason || null;
    this.retryable = retryable !== false;
    this.owner = PROVIDER_FAILURE_OWNERS.includes(owner) ? owner : 'queue';
    this.attempts = Math.max(1, Number(attempts) || 1);
    this.providerFailure = true;
    this.budget = budget || null;
    if (cause !== null && cause !== undefined) this.cause = cause;
  }

  // The plain JSON receipt writers persist — never the stack, never the
  // provider body (it may carry document text).
  receipt() {
    return providerFailureReceipt(this);
  }
}

export const isProviderFailure = (error) =>
  Boolean(error && typeof error === 'object' && error.providerFailure === true && typeof error.code === 'string');

export const providerFailureReceipt = (error) => {
  if (!isProviderFailure(error)) return null;
  return {
    code: error.code,
    provider: error.provider || null,
    status: error.status ?? null,
    reason: error.reason || null,
    message: String(error.message || '').slice(0, 300),
    retryable: error.retryable !== false,
    owner: error.owner || 'queue',
    attempts: Number(error.attempts) || 1,
    ...(error.budget ? { budget: error.budget } : {})
  };
};

// The failure a caller raises BEFORE any request when its key is absent — a
// provisioning gap that rests on the operator, never a silent feature loss
// and never a weighted / template answer.
export const providerKeyMissing = (provider, { keyName = null } = {}) =>
  new ProviderFailureError({
    code: PROVIDER_FAILURE_CODES.KEY_MISSING,
    provider,
    status: null,
    reason: 'no_api_key',
    message: `${providerLabel(provider)} API key is not configured${keyName ? ` (${keyName})` : ''}.`,
    retryable: true,
    owner: 'operator'
  });

// A body the caller's parser could not read at all: the provider answered
// but no judgment exists to render. Retryable (a re-ask usually reads), and
// never a verdict.
export const providerInvalidOutput = (provider, { detail = null, status = 200, model = null } = {}) =>
  new ProviderFailureError({
    code: PROVIDER_FAILURE_CODES.INVALID_OUTPUT,
    provider,
    status,
    reason: 'invalid_output',
    message: `${model || providerLabel(provider)} returned an unreadable response${detail ? ` (${detail})` : ''}.`,
    retryable: true,
    owner: 'queue'
  });

// ── Classification ─────────────────────────────────────────────────────────
// HTTP statuses where a retry can plausibly succeed (Anthropic 529 is its
// Overloaded status; the rest are the standard slow-gateway family).
export const TRANSIENT_PROVIDER_STATUSES = Object.freeze(new Set([408, 425, 429, 500, 502, 503, 504, 529]));

const providerErrorMessage = (payload, fallback) => {
  const message = payload?.error?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
};

const providerErrorReason = (payload) => {
  const code = payload?.error?.code ?? payload?.error?.type;
  return typeof code === 'string' && code.trim() ? code.trim().slice(0, 80) : null;
};

// A non-OK HTTP status → the typed failure. `attempts` names how many tries
// this status closed (the message says so past the first).
export const classifyProviderStatus = ({ provider, status, payload = null, attempts = 1 } = {}) => {
  const n = Number(status) || 0;
  const label = providerLabel(provider);
  const detail = providerErrorMessage(payload, `${label} API request failed`);
  const reason = providerErrorReason(payload);
  const count = Math.max(1, Number(attempts) || 1);
  if (n === 401 || n === 403) {
    return new ProviderFailureError({
      code: PROVIDER_FAILURE_CODES.UNAUTHORIZED, provider, status: n,
      reason: reason || `${provider || 'provider'}_${n}`,
      message: `${label} API error ${n}: ${detail}`,
      retryable: false, owner: 'operator', attempts: count
    });
  }
  if (n === 429) {
    return new ProviderFailureError({
      code: PROVIDER_FAILURE_CODES.RATE_LIMITED, provider, status: n,
      reason: reason || 'rate_limited',
      message: count > 1
        ? `${label} API overloaded after ${count} attempts (last status ${n}): ${detail}`
        : `${label} API error ${n}: ${detail}`,
      retryable: true, owner: 'queue', attempts: count
    });
  }
  if (TRANSIENT_PROVIDER_STATUSES.has(n)) {
    return new ProviderFailureError({
      code: PROVIDER_FAILURE_CODES.UNAVAILABLE, provider, status: n,
      reason: reason || `${provider || 'provider'}_${n}`,
      message: count > 1
        ? `${label} API overloaded after ${count} attempts (last status ${n}): ${detail}`
        : `${label} API error ${n}: ${detail}`,
      retryable: true, owner: 'queue', attempts: count
    });
  }
  return new ProviderFailureError({
    code: PROVIDER_FAILURE_CODES.REJECTED_REQUEST, provider, status: n || null,
    reason: reason || `${provider || 'provider'}_${n || 'unknown'}`,
    message: `${label} API error ${n || 'unknown'}: ${detail}`,
    retryable: false, owner: 'operator', attempts: count
  });
};

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RESPONSE_STATUS_CODE',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

const errorCodeOf = (error) => {
  const own = typeof error?.code === 'string' ? error.code : null;
  const cause = typeof error?.cause?.code === 'string' ? error.cause.code : null;
  return own || cause || null;
};

const isAbortLike = (error) =>
  error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR' || error?.code === 23;

const isNetworkLike = (error) => {
  const code = errorCodeOf(error);
  if (code && (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR'))) return true;
  if (error instanceof TypeError && /fetch failed|network|socket|ECONN|terminated/i.test(String(error.message || ''))) return true;
  return false;
};

// A THROWN error from the transport → the typed failure, or null when the
// error is not a provider-transport event (a bug, a refused execution ref)
// — those propagate untouched: classification never launders a defect.
export const classifyProviderThrow = ({ provider, error, attempts = 1, timedOut = false, timeoutMs = null, reason = null } = {}) => {
  if (isProviderFailure(error)) return error;
  if (isProviderSpendLimit(error)) return new ProviderFailureError({
    code: PROVIDER_FAILURE_CODES.SPEND_LIMIT, provider, reason: 'spend_limit_reached',
    message: 'Model work is paused because its spending allowance is exhausted. Increase the allowance before retrying.',
    retryable: false, owner: 'operator', cause: error
  });
  const label = providerLabel(provider);
  const count = Math.max(1, Number(attempts) || 1);
  if (timedOut || isAbortLike(error)) {
    const why = reason || (timedOut ? 'request_timeout' : 'aborted');
    return new ProviderFailureError({
      code: PROVIDER_FAILURE_CODES.TIMEOUT, provider, status: null,
      reason: why,
      message: why === 'execution_budget_exhausted' || why === 'execution_budget_aborted'
        ? `${label} request cancelled: the worker's execution budget was ${why === 'execution_budget_aborted' ? 'aborted' : 'exhausted'}.`
        : `${label} request timed out${Number.isFinite(Number(timeoutMs)) ? ` after ${Number(timeoutMs)}ms` : ''} (headers or body never arrived).`,
      retryable: true, owner: 'queue', attempts: count, cause: error || null
    });
  }
  if (isNetworkLike(error)) {
    return new ProviderFailureError({
      code: PROVIDER_FAILURE_CODES.NETWORK, provider, status: null,
      reason: errorCodeOf(error) || 'network_error',
      message: `${label} request failed during transport: ${error?.message || String(error)}`,
      retryable: true, owner: 'queue', attempts: count, cause: error
    });
  }
  return null;
};

export const isProviderSpendLimit = (error) =>
  ['trial_spend_cap_refused', 'PROVIDER_SPEND_LIMIT'].includes(error?.code);

// ── The deadline ───────────────────────────────────────────────────────────
// The per-attempt timeout in force: the request timeout, capped by the
// ambient execution budget minus its reserve. Throws PROVIDER_TIMEOUT
// (reason execution_budget_exhausted) when the budget cannot hold even the
// shortest attempt — the caller receipts and stops, it does not start a call
// the worker cannot wait for.
export const resolveProviderDeadline = ({
  provider = null,
  timeoutMs = providerRequestTimeoutMs(),
  reserveMs = providerBudgetReserveMs(),
  minAttemptMs = MIN_PROVIDER_ATTEMPT_MS,
  now = Date.now
} = {}) => {
  const requestTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  const budget = currentExecutionBudget();
  if (!budget) return { timeoutMs: requestTimeout, budget: null, budgetSignal: null, remainingBudgetMs: null };
  const remaining = remainingExecutionBudgetMs(now);
  const usable = remaining - Math.max(0, Number(reserveMs) || 0);
  if (budget.signal?.aborted) {
    throw classifyProviderThrow({ provider, error: null, timedOut: true, reason: 'execution_budget_aborted' });
  }
  if (usable < Math.max(1, Number(minAttemptMs) || 1)) {
    budget.abort('execution_budget_exhausted');
    const error = classifyProviderThrow({ provider, error: null, timedOut: true, reason: 'execution_budget_exhausted' });
    error.budget = { label: budget.label, remaining_ms: remaining, reserve_ms: Number(reserveMs) || 0 };
    throw error;
  }
  return {
    timeoutMs: Math.min(requestTimeout, usable),
    budget,
    budgetSignal: budget.signal || null,
    remainingBudgetMs: remaining
  };
};

// Can the ambient budget hold a wait of `delayMs` and then one more attempt?
// Used by retrying callers before sleeping — a backoff that outlives the
// job is a zombie in waiting.
export const budgetAllowsRetry = ({ delayMs = 0, reserveMs = providerBudgetReserveMs(), minAttemptMs = MIN_PROVIDER_ATTEMPT_MS, now = Date.now } = {}) => {
  const remaining = remainingExecutionBudgetMs(now);
  if (remaining === null) return true;
  return remaining - (Number(reserveMs) || 0) - (Number(delayMs) || 0) >= (Number(minAttemptMs) || 0);
};

const abortError = (reason) => {
  const error = new Error(typeof reason === 'string' ? reason : 'aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (reason && typeof reason === 'object') error.cause = reason;
  return error;
};

// Timers can be delayed by a busy event loop. Check the absolute deadline
// after headers/body settle as well, before returning bytes to a writer.
const assertProviderDeadline = ({ deadlineAt, budget, controller, now, budgetLimited }) => {
  const signal = controller.signal;
  if (signal.aborted) throw abortError(signal.reason);
  if (budget?.signal?.aborted) throw abortError('execution_budget_aborted');
  if (now() >= deadlineAt || (budget && now() >= budget.deadlineAt)) {
    if (budget && (budgetLimited || now() >= budget.deadlineAt)) {
      budget.abort('execution_budget_exhausted');
      throw abortError('execution_budget_exhausted');
    }
    controller.abort('request_timeout');
    throw abortError('request_timeout');
  }
};

// The retry wait belongs to the same operation as its requests. Cancelling
// the invocation must interrupt backoff too, not merely refuse the next fetch.
export const waitForProviderRetry = async ({ provider, delayMs, sleepImpl, attempts = 1 } = {}) => {
  const budget = currentExecutionBudget();
  let timer;
  try {
    if (budget?.signal.aborted) throw abortError('execution_budget_aborted');
    const waiting = typeof sleepImpl === 'function'
      ? sleepImpl(delayMs)
      : new Promise((resolve) => { timer = setTimeout(resolve, delayMs); });
    await raceAbort(waiting, budget?.signal);
    if (budget && remainingExecutionBudgetMs() <= 0) throw abortError('execution_budget_exhausted');
  } catch (error) {
    throw classifyProviderThrow({ provider, error, attempts,
      reason: budget?.signal.aborted ? 'execution_budget_aborted' : 'execution_budget_exhausted' }) || error;
  } finally {
    clearTimeout(timer);
  }
};

// Race a promise against an AbortSignal. A late settlement of `promise`
// after the abort is DISCARDED: its value never reaches the caller and its
// rejection is swallowed (it was already reported as the abort).
export const raceAbort = (promise, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    Promise.resolve(promise).catch(() => {});
    reject(abortError(signal.reason));
    return;
  }
  let settled = false;
  const onAbort = () => {
    if (settled) return;
    settled = true;
    reject(abortError(signal.reason));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  Promise.resolve(promise).then(
    (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    },
    (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    }
  );
});

const readJsonBody = async (response) => {
  if (!response) return null;
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch (error) {
      // A reset after successful headers is still a network failure, not
      // unreadable model output. For rejected HTTP responses, keep the
      // status authoritative (a broken 401 body must not hide credentials).
      // Cancellation always propagates; the operation has lost its budget.
      if (isAbortLike(error) || isProviderFailure(error) || (response.ok && isNetworkLike(error))) throw error;
      // A non-JSON body (an HTML error page from an overloaded gateway) is
      // read as no payload; the status decides, as it always did.
      return null;
    }
  }
  return null;
};

// ── One bounded request ────────────────────────────────────────────────────
// Performs ONE fetch and reads its JSON body under a single deadline. Returns
// `{ response, payload, ok, status, timeoutMs }` for any HTTP status (the
// caller classifies non-OK through classifyProviderStatus so it owns its
// retry policy); THROWS a ProviderFailureError for a timeout (headers or
// body), a budget abort, or a network error — and rethrows anything else
// untouched. A response arriving after the deadline is dropped.
export const fetchProviderJson = async ({
  provider,
  url,
  init = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = providerRequestTimeoutMs(),
  reserveMs = providerBudgetReserveMs(),
  minAttemptMs = MIN_PROVIDER_ATTEMPT_MS,
  attempts = 1,
  now = Date.now
} = {}) => {
  if (typeof fetchImpl !== 'function') throw new Error('fetchProviderJson needs a fetch implementation');
  const deadline = resolveProviderDeadline({ provider, timeoutMs, reserveMs, minAttemptMs, now });
  const deadlineAt = now() + deadline.timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  let abortReason = null;
  const onBudgetAbort = () => {
    abortReason = deadline.budgetSignal.reason === 'execution_budget_exhausted'
      ? 'execution_budget_exhausted' : 'execution_budget_aborted';
    controller.abort(abortReason);
  };
  if (deadline.budgetSignal) {
    if (deadline.budgetSignal.aborted) onBudgetAbort();
    else deadline.budgetSignal.addEventListener('abort', onBudgetAbort, { once: true });
  }
  const onRequestAbort = () => {
    abortReason = 'request_aborted';
    controller.abort(abortReason);
  };
  init.signal?.addEventListener('abort', onRequestAbort, { once: true });
  if (init.signal?.aborted) onRequestAbort();
  // NOT unref'd: the timer is what frees a hung request; a process must not
  // exit around it.
  const timer = setTimeout(() => {
    timedOut = true;
    abortReason = deadline.budget && deadline.timeoutMs < Number(timeoutMs) ? 'execution_budget_exhausted' : 'request_timeout';
    controller.abort(abortReason);
    if (abortReason === 'execution_budget_exhausted') deadline.budget?.abort(abortReason);
  }, deadline.timeoutMs);
  try {
    if (controller.signal.aborted) throw abortError(controller.signal.reason);
    const response = await raceAbort(
      fetchImpl(url, { ...init, signal: controller.signal }),
      controller.signal
    );
    assertProviderDeadline({ deadlineAt, budget: deadline.budget, controller, now,
      budgetLimited: deadline.timeoutMs < Number(timeoutMs) });
    const payload = await raceAbort(readJsonBody(response), controller.signal);
    assertProviderDeadline({ deadlineAt, budget: deadline.budget, controller, now,
      budgetLimited: deadline.timeoutMs < Number(timeoutMs) });
    return {
      response,
      payload,
      ok: Boolean(response?.ok),
      status: Number(response?.status) || 0,
      timeoutMs: deadline.timeoutMs
    };
  } catch (error) {
    const typed = classifyProviderThrow({
      provider,
      error,
      attempts,
      timedOut: timedOut || controller.signal.aborted,
      timeoutMs: deadline.timeoutMs,
      reason: controller.signal.aborted ? abortReason : error?.name === 'AbortError' ? error.message : null
    });
    if (typed) {
      if (deadline.budget && !typed.budget) {
        typed.budget = { label: deadline.budget.label, remaining_ms: remainingExecutionBudgetMs(now), timeout_ms: deadline.timeoutMs };
      }
      throw typed;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    deadline.budgetSignal?.removeEventListener('abort', onBudgetAbort);
    init.signal?.removeEventListener('abort', onRequestAbort);
  }
};

// ── One bounded request, classified ────────────────────────────────────────
// fetchProviderJson + status classification: returns `{ response, payload,
// status }` on an OK response and THROWS the typed failure otherwise. For
// callers with no retry policy of their own (the coder, the ask drafter).
export const callProviderJson = async (options = {}) => {
  const result = await fetchProviderJson(options);
  if (!result.ok) {
    throw classifyProviderStatus({
      provider: options.provider,
      status: result.status,
      payload: result.payload,
      attempts: options.attempts || 1
    });
  }
  return result;
};

// ── A deadline-bearing fetch for sites that keep their own socket ──────────
// llmCall.js owns the fetch for the openai_compatible rung and reads the body
// itself. This wrapper gives such a site the SAME contract: one signal over
// headers and body (the returned response's json()/text() are raced against
// it), the budget cap, and typed throws — without moving its transport.
export const providerFetchWithDeadline = ({
  provider,
  fetchImpl = globalThis.fetch,
  timeoutMs = providerRequestTimeoutMs(),
  reserveMs = providerBudgetReserveMs(),
  minAttemptMs = MIN_PROVIDER_ATTEMPT_MS,
  now = Date.now
} = {}) => async (url, init = {}) => {
  const deadline = resolveProviderDeadline({ provider, timeoutMs, reserveMs, minAttemptMs, now });
  const deadlineAt = now() + deadline.timeoutMs;
  const controller = new AbortController();
  let abortReason = null;
  const onBudgetAbort = () => {
    abortReason = deadline.budgetSignal.reason === 'execution_budget_exhausted'
      ? 'execution_budget_exhausted' : 'execution_budget_aborted';
    controller.abort(abortReason);
  };
  if (deadline.budgetSignal) {
    if (deadline.budgetSignal.aborted) onBudgetAbort();
    else deadline.budgetSignal.addEventListener('abort', onBudgetAbort, { once: true });
  }
  const onRequestAbort = () => {
    abortReason = 'request_aborted';
    controller.abort(abortReason);
  };
  init.signal?.addEventListener('abort', onRequestAbort, { once: true });
  if (init.signal?.aborted) onRequestAbort();
  const timer = setTimeout(() => {
    abortReason = deadline.budget && deadline.timeoutMs < Number(timeoutMs) ? 'execution_budget_exhausted' : 'request_timeout';
    controller.abort(abortReason);
    if (abortReason === 'execution_budget_exhausted') deadline.budget?.abort(abortReason);
  }, deadline.timeoutMs);
  const release = () => {
    clearTimeout(timer);
    deadline.budgetSignal?.removeEventListener('abort', onBudgetAbort);
    init.signal?.removeEventListener('abort', onRequestAbort);
  };
  const wrapThrow = (error) => {
    const typed = classifyProviderThrow({
      provider, error, timedOut: controller.signal.aborted, timeoutMs: deadline.timeoutMs,
      reason: controller.signal.aborted ? abortReason : error?.name === 'AbortError' ? error.message : null
    });
    return typed || error;
  };
  let response;
  try {
    if (controller.signal.aborted) throw abortError(controller.signal.reason);
    response = await raceAbort(fetchImpl(url, { ...init, signal: controller.signal }), controller.signal);
    assertProviderDeadline({ deadlineAt, budget: deadline.budget, controller, now,
      budgetLimited: deadline.timeoutMs < Number(timeoutMs) });
  } catch (error) {
    release();
    throw wrapThrow(error);
  }
  // The body read keeps the same signal and the same timer; the timer is
  // released once the body has been read (or the read failed).
  const readUnderDeadline = (method) => async (...args) => {
    try {
      assertProviderDeadline({ deadlineAt, budget: deadline.budget, controller, now,
        budgetLimited: deadline.timeoutMs < Number(timeoutMs) });
      const value = await raceAbort(response[method](...args), controller.signal);
      assertProviderDeadline({ deadlineAt, budget: deadline.budget, controller, now,
        budgetLimited: deadline.timeoutMs < Number(timeoutMs) });
      return value;
    } catch (error) {
      throw wrapThrow(error);
    } finally {
      release();
    }
  };
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: response.url,
    json: typeof response.json === 'function' ? readUnderDeadline('json') : async () => { release(); return null; },
    text: typeof response.text === 'function' ? readUnderDeadline('text') : async () => { release(); return ''; }
  };
};
