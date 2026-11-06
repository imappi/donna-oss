// One budget per actual HTTP invocation, including SDK discovery, executed
// steps, headers, bodies and provider retries. A durable step replay is a NEW
// invocation; memoized steps never get new work or a new accounting verdict.
import { Middleware } from 'inngest';
import {
  createExecutionBudget, currentExecutionBudget, remainingExecutionBudgetMs,
  runWithExecutionBudget
} from '../executionBudget.js';

// api/inngest.js permits 300s. Stop work 15s before the platform hard kill so
// the existing failure writers and SDK can return the retry receipt.
export const INNGEST_INVOCATION_TIMEOUT_MS = 285_000;

export class InngestExecutionBudgetError extends Error {
  constructor(reason) {
    super(`Inngest invocation stopped: ${reason}`);
    this.name = 'InngestExecutionBudgetError';
    this.code = 'INNGEST_EXECUTION_BUDGET_EXHAUSTED';
    this.reason = reason;
    this.retryable = true;
  }
}

const assertLive = () => {
  const budget = currentExecutionBudget();
  if (!budget) throw new InngestExecutionBudgetError('execution_budget_missing');
  if (remainingExecutionBudgetMs() <= 0) {
    throw new InngestExecutionBudgetError(
      budget.signal.aborted ? String(budget.signal.reason) : 'execution_budget_exhausted'
    );
  }
};

export const runInngestRequestWithBudget = async (req, res, next, {
  timeoutMs = INNGEST_INVOCATION_TIMEOUT_MS,
  now = Date.now
} = {}) => {
  const parent = currentExecutionBudget();
  const requested = Number(timeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('Inngest invocation needs a positive timeoutMs');
  }
  const budget = createExecutionBudget({
    timeoutMs: Math.min(requested, INNGEST_INVOCATION_TIMEOUT_MS),
    now,
    label: 'inngest-http-invocation'
  });
  // Nesting must never reset an earlier owning deadline.
  if (parent) budget.deadlineAt = Math.min(budget.deadlineAt, parent.deadlineAt);
  const abortParent = () => budget.abort('execution_budget_aborted');
  const abortRequest = () => budget.abort('inngest_request_aborted');
  const closeResponse = () => budget.abort(
    res.writableFinished ? 'inngest_response_finished' : 'inngest_response_closed'
  );
  parent?.signal?.addEventListener('abort', abortParent, { once: true });
  req.once?.('aborted', abortRequest);
  res.once?.('close', closeResponse);
  res.once?.('finish', closeResponse);
  if (parent?.signal?.aborted) abortParent();
  if (req.aborted || res.destroyed) abortRequest();
  const timer = setTimeout(() => budget.abort('execution_budget_exhausted'),
    Math.max(0, budget.deadlineAt - now()));
  try {
    // Await the HTTP handler, NOT wrapFunctionHandler.next(): the latter
    // intentionally never settles when the SDK discovers a durable step.
    return await runWithExecutionBudget(budget, next);
  } finally {
    clearTimeout(timer);
    parent?.signal?.removeEventListener('abort', abortParent);
    req.off?.('aborted', abortRequest);
    res.off?.('close', closeResponse);
    res.off?.('finish', closeResponse);
    // Any continuation left by discovery or a closed response loses the
    // invocation's authority to start/return another provider operation.
    budget.abort('inngest_invocation_finished');
  }
};

export class InngestExecutionBudgetMiddleware extends Middleware.BaseMiddleware {
  id = 'donna-execution-budget';

  async wrapStepHandler({ next }) {
    assertLive();
    const result = await next();
    // A worker may intentionally receipt a provider failure and return a
    // summary. An aborted invocation must still fail its actual SDK step,
    // preserving Inngest retry/memoization rather than caching that summary.
    assertLive();
    return result;
  }

  async wrapFunctionHandler({ next }) {
    assertLive();
    const result = await next();
    assertLive();
    return result;
  }
}
