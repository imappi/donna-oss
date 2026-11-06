// The desktop `step.run` shim — Inngest's durable-step semantics over the
// local_job_steps table (technical plan §4; M0a findings §3: `step.run` is
// the ONLY Inngest primitive the tree's 23 call sites use).
//
// A completed step's result is memoized keyed by (job id, step key); a
// retried attempt of the same job returns the memoized result instead of
// re-running the step — matching Inngest's replay behavior, which is what
// the handlers' idempotency was written against. Results must survive a
// JSON round-trip (Inngest's own constraint; the handlers already comply).
//
// Unlike the inline shim in parseDocument.js (`__inline: true`, collapse to
// plain await), this shim keeps throw-to-retry semantics: a step failure
// propagates, the job fails, and the retry replays past the completed steps.
//
// `forget(name)` (RT-08) is the one thing Inngest's step has no need for: a
// step that RETURNED "could not run yet" (the parse claim refused by entity
// readiness; a run still owned by another attempt) is memoized like any
// return, so a job that then DEFERS itself would replay its own refusal on
// every recheck. The handler forgets the step before deferring; the next
// attempt re-runs it. Only the handler that produced the result knows it was
// a "not yet" — the shim stays agnostic.

import { deleteLocalStepResult, getLocalStepResult, saveLocalStepResult } from './localJobQueue.js';

const jsonRoundTrip = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

export const makeDurableStep = ({ jobId, client, deps = {} } = {}) => {
  const getStep = deps.getLocalStepResult || getLocalStepResult;
  const saveStep = deps.saveLocalStepResult || saveLocalStepResult;
  const deleteStep = deps.deleteLocalStepResult || deleteLocalStepResult;
  // Repeated step names within one run (e.g. a per-leg loop) get positional
  // suffixes, mirroring Inngest's positional hashing. Deterministic as long
  // as execution order is deterministic — the same assumption Inngest makes.
  const seen = new Map();
  const stepKeyFor = (name, occurrence) => (occurrence === 1 ? String(name) : `${name}#${occurrence}`);

  return {
    __desktop: true,
    run: async (name, fn) => {
      const occurrence = (seen.get(name) || 0) + 1;
      seen.set(name, occurrence);
      const stepKey = stepKeyFor(name, occurrence);

      const memoized = await getStep({ client, jobId, stepKey });
      if (memoized.found) return memoized.result;

      const result = jsonRoundTrip(await fn());
      await saveStep({ client, jobId, stepKey, result });
      return result;
    },
    // Drop the memoized result of the LATEST occurrence of `name` in this run
    // (the first, unless the name repeated), so the next attempt re-runs it.
    forget: async (name) => {
      const occurrence = seen.get(name) || 1;
      return deleteStep({ client, jobId, stepKey: stepKeyFor(name, occurrence) });
    }
  };
};
