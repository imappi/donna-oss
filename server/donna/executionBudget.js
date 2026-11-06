// Donna — the worker execution budget (2026-09-13, FI provider-failure pass).
//
// THE PROBLEM. The desktop scheduler cuts a hung job with a timer
// (localScheduler.js `executeJob`): the job row FAILS at `timeoutMs`, but the
// handler promise keeps running as a zombie. A provider call the handler was
// awaiting (a coder body that never arrives, a matcher whose headers hang)
// therefore outlives the job that owned it and, when the provider finally
// answers, writes its verdict under a job the queue already retried or
// dead-lettered — the "late body writes a coding" reproduction in
// docs/finding-2026-09-13-fi-provider-failure-recovery.md.
//
// THE FIX SHAPE. The scheduler runs each job inside ONE ambient budget —
// an absolute deadline plus an AbortSignal — carried by AsyncLocalStorage so
// nothing between the scheduler and the provider transport has to thread it
// by hand (the matcher sits six calls below the job handler). The provider
// transport (providerTransport.js) reads the budget at every call: a request
// never outlives the job (per-attempt timeout = min(request timeout,
// remaining budget − reserve)), a retry is refused when the budget cannot
// hold it, and the scheduler's timeout ABORTS the signal so an in-flight
// call rejects at once instead of resolving late.
//
// This module decides nothing about accounting: it is a clock and a signal.
// Absent a budget (a route handler, a cloud function, a unit test) the
// transport applies its per-request timeout alone — byte-identical to a
// caller that never set one.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const verdictTransactions = new WeakMap();

const nowMs = (now) => (typeof now === 'function' ? now() : Date.now());

// Create a budget: `timeoutMs` from `now` (a function or a number), with its
// own AbortController so the owner (the scheduler) can cancel it. `label`
// names the owner in receipts ("parse-document#42").
export const createExecutionBudget = ({ timeoutMs, now = Date.now, label = null } = {}) => {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('createExecutionBudget needs a positive timeoutMs');
  const controller = new AbortController();
  const startedAt = nowMs(now);
  const budget = {
    label: label == null ? null : String(label),
    startedAt,
    deadlineAt: startedAt + ms,
    timeoutMs: ms,
    signal: controller.signal,
    abort: (reason = 'execution_budget_aborted') => {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  };
  return budget;
};

// Run `fn` with `budget` as the ambient execution budget. Everything awaited
// inside — including work dispatched through pg callbacks and durable step
// closures — sees the same budget through AsyncLocalStorage.
export const runWithExecutionBudget = (budget, fn) => {
  if (!budget || typeof budget !== 'object' || !Number.isFinite(budget.deadlineAt)) {
    throw new Error('runWithExecutionBudget needs a budget with a numeric deadlineAt');
  }
  return storage.run(budget, fn);
};

// The ambient budget, or null when none is set.
export const currentExecutionBudget = () => storage.getStore() || null;

// Recheck after database/authority waits, immediately before a named writer
// persists a model-derived verdict. Transport cancellation alone cannot fence
// a valid response that arrived before expiry and then waited on a row lock.
// Failure-receipt writers deliberately do not call this: their job is to leave
// an honest cause after cancellation, within the reserved shutdown time.
const assertBudgetActive = (budget, now = Date.now) => {
  if (!budget) return;
  if (budget.signal?.aborted || nowMs(now) >= budget.deadlineAt) {
    const error = new Error('The owning execution budget timed out before the verdict write.');
    error.code = 'EXECUTION_BUDGET_EXHAUSTED';
    error.retryable = true;
    throw error;
  }
};

export const assertExecutionBudgetActive = ({ client, now = Date.now } = {}) => {
  const budget = currentExecutionBudget();
  assertBudgetActive(budget, now);
  // Opt in only the transaction that contains this model-derived verdict.
  // A later failure-receipt transaction on the same client remains writable.
  if (budget && client) verdictTransactions.set(client, budget);
};

// The convergence hook may await locks after a writer requests COMMIT. Its
// final check must use the budget captured by the verdict writer, after all
// settling and immediately before sending COMMIT to PostgreSQL.
export const assertVerdictTransactionBudgetActive = (client) =>
  assertBudgetActive(verdictTransactions.get(client));
export const clearVerdictTransactionBudget = (client) => verdictTransactions.delete(client);

// Milliseconds left on the ambient budget (0 when spent or aborted); null when
// no budget is in force.
export const remainingExecutionBudgetMs = (now = Date.now) => {
  const budget = currentExecutionBudget();
  if (!budget) return null;
  if (budget.signal?.aborted) return 0;
  return Math.max(0, budget.deadlineAt - nowMs(now));
};

// A compact receipt of the ambient budget for failure records.
export const describeExecutionBudget = (now = Date.now) => {
  const budget = currentExecutionBudget();
  if (!budget) return null;
  return {
    label: budget.label,
    deadline_at: new Date(budget.deadlineAt).toISOString(),
    remaining_ms: remainingExecutionBudgetMs(now),
    aborted: Boolean(budget.signal?.aborted)
  };
};
