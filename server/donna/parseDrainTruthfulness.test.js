// RT-02 — parse drain truthfulness (audit F-02 containment, F-07).
//
// The desktop drain is the parse transport when Inngest is absent. Before this
// slice a retryable worker error was released to `pending` by the worker and
// then stamped `failed` by the drain in the same tick, with copy promising a
// retry nobody owned; an admission-refused claim was logged as a "benign
// skip". These tests drive the extracted tick loop with injected writers so
// the decision logic is pinned without a database. The real-PG interleaving
// (claim → release → drain) lives in parseDrainTruthfulnessPgLifecycle.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runParseDrainTick } from './api.js';

const row = (overrides = {}) => ({
  id: 'doc-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  parse_run_id: '00000000-0000-4000-8000-000000000001',
  parse_enqueued_at: '2026-09-01T00:00:00.000Z',
  document_type: 'receipt',
  parse_attempts: 0,
  parse_hold: null,
  hold_fresh: false,
  ...overrides
});

const rateLimited = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });

const harness = ({ runParse, markResult = null } = {}) => {
  const markCalls = [];
  const logs = [];
  return {
    markCalls,
    logs,
    deps: {
      runParse,
      markParseFailed: async (args) => {
        markCalls.push(args);
        return markResult;
      },
      log: {
        info: (...a) => logs.push(['info', ...a]),
        warn: (...a) => logs.push(['warn', ...a]),
        error: (...a) => logs.push(['error', ...a])
      }
    }
  };
};

test('retryable throw with attempts remaining leaves the released row pending (no failed write)', async () => {
  const h = harness({ runParse: async () => { throw rateLimited(); } });
  const summary = await runParseDrainTick({ drainable: [row({ parse_attempts: 0 })], maxAttempts: 4, ...h.deps });
  assert.equal(summary.retry_pending, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.exhausted, 0);
  // The only write allowed is the guard for a release that did NOT happen: it
  // must be status-fenced to `processing` so a row the worker already handed
  // back to `pending` is never overwritten.
  assert.equal(h.markCalls.length, 1);
  assert.deepEqual(h.markCalls[0].allowedStatuses, ['processing']);
  assert.equal(h.markCalls[0].parseError.retry_owner, 'manual');
  assert.doesNotMatch(h.markCalls[0].parseError.safe_user_message, /retrying shortly/i);
});

test('retryable throw on the last allowed attempt rests terminal: retryable:false, retry_owner null, honest copy', async () => {
  const h = harness({
    runParse: async () => { throw rateLimited(); },
    markResult: { id: 'doc-1', parse_status: 'failed' }
  });
  const summary = await runParseDrainTick({ drainable: [row({ parse_attempts: 3 })], maxAttempts: 4, ...h.deps });
  assert.equal(summary.exhausted, 1);
  assert.equal(summary.retry_pending, 0);
  assert.equal(h.markCalls.length, 1);
  const envelope = h.markCalls[0].parseError;
  assert.equal(envelope.retryable, false);
  assert.equal(envelope.retry_owner, null);
  assert.equal(envelope.code, 'OCR_RATE_LIMIT', 'the exhausted receipt still names what failed');
  assert.deepEqual(envelope.retry_exhausted, { attempts: 4, max_attempts: 4 });
  assert.match(envelope.safe_user_message, /4 attempts/);
  assert.doesNotMatch(envelope.safe_user_message, /retrying shortly/i);
  assert.deepEqual(h.markCalls[0].allowedStatuses, ['processing', 'pending']);
});

test('non-retryable throw is written terminal with no retry owner and no promise', async () => {
  const h = harness({
    runParse: async () => { throw Object.assign(new Error('not a pdf'), {}); },
    markResult: { id: 'doc-1', parse_status: 'failed' }
  });
  const summary = await runParseDrainTick({ drainable: [row()], maxAttempts: 4, ...h.deps });
  assert.equal(summary.failed, 1);
  assert.equal(h.markCalls[0].parseError.code, 'INVALID_PDF');
  assert.equal(h.markCalls[0].parseError.retryable, false);
  assert.equal(h.markCalls[0].parseError.retry_owner, null);
});

test('admission refusal is counted, logged once per row, and sibling rows of the entity are not re-claimed in the tick', async () => {
  const seen = [];
  const h = harness({
    runParse: async (r) => {
      seen.push(r.id);
      return {
        handled: false,
        reason: 'admission_refused',
        claim_outcome: 'admission_refused',
        reason_code: 'legacy_uncertified',
        hold: { reason_code: 'legacy_uncertified', since: 'x', checked_at: 'x', receipt_id: 7 }
      };
    }
  });
  const summary = await runParseDrainTick({
    drainable: [row({ id: 'doc-a' }), row({ id: 'doc-b' }), row({ id: 'doc-c', client_id: 'client-2' })],
    maxAttempts: 4,
    ...h.deps
  });
  assert.deepEqual(seen, ['doc-a', 'doc-c'], 'one admission check per entity per tick');
  assert.equal(summary.admission_refused, 3);
  assert.equal(summary.processed, 2);
  assert.equal(h.markCalls.length, 0, 'a refused claim is never a failure');
  assert.deepEqual(summary.holds.map((x) => x.document_id), ['doc-a', 'doc-c']);
  assert.equal(summary.holds[0].reason_code, 'legacy_uncertified');
  assert.equal(h.logs.filter(([, msg]) => /admission refused/.test(msg)).length, 2);
});

test('a row whose hold is still fresh is skipped without a claim (no per-minute audit)', async () => {
  let ran = 0;
  const h = harness({ runParse: async () => { ran += 1; return { handled: true, outcome: 'completed' }; } });
  const summary = await runParseDrainTick({
    drainable: [row({ id: 'held', hold_fresh: true, parse_hold: { reason_code: 'legacy_uncertified' } }), row({ id: 'free' })],
    maxAttempts: 4,
    ...h.deps
  });
  assert.equal(ran, 1);
  assert.equal(summary.held, 1);
  assert.equal(summary.succeeded, 1);
});

test('stale_run / not_pending outcomes are neither failures nor successes', async () => {
  const h = harness({ runParse: async () => ({ handled: false, reason: 'stale_run', claim_outcome: 'stale_run' }) });
  const summary = await runParseDrainTick({ drainable: [row()], maxAttempts: 4, ...h.deps });
  assert.equal(summary.not_claimed, 1);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.failed, 0);
});

test('a worker-marked terminal failure counts as worker_failed, not succeeded', async () => {
  const h = harness({ runParse: async () => ({ handled: true, outcome: 'failed', code: 'INVALID_PDF' }) });
  const summary = await runParseDrainTick({ drainable: [row()], maxAttempts: 4, ...h.deps });
  assert.equal(summary.worker_failed, 1);
  assert.equal(summary.succeeded, 0);
});
