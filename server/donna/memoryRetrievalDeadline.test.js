// Donna — BizOS Slice 2c-iii (sub-PR 6): bounded/cancellable retrieval + breaker.
// Proves the hot-path timeout actually cancels (test 5), a throw/timeout never
// yields legacy (feeds classifyAndRenderV2 as unavailable), the breaker opens/
// closes, and the deadline clamp + sidecar sunset behave.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampCanaryDeadlineMs,
  resolveCanaryDeadlineMs,
  CANARY_DEADLINE_FLOOR_MS,
  CANARY_DEADLINE_CEIL_MS,
  MemoryRetrievalCircuitBreaker,
  buildMemoryBundleWithDeadline,
  shouldRunLegacyEvalSidecar
} from './memoryRetrievalDeadline.js';
import { classifyAndRenderV2 } from './ownerMemoryRender.js';

const invocation = { trustedContext: { tenant_id: 'f1' }, request: { purpose_id: 'portal_owner_context' } };
const okBundle = { status: 'ok', failure: null, bundle: { context_items: [{ subject_ref: 'legal_entity:c1', predicate: 'p', rendered_value: 'v' }], conflict_markers: [] }, consumer_receipt: { included: [{}], visible_excluded: [], as_of: '2026-07-01T00:00:00.000Z' } };

// ── deadline budget ────────────────────────────────────────────────────────────

test('clampCanaryDeadlineMs: clamp(shadow_p99 + 100, 250, 500)', () => {
  assert.equal(clampCanaryDeadlineMs(100), 250);   // 200 → floor
  assert.equal(clampCanaryDeadlineMs(300), 400);   // 400 in range
  assert.equal(clampCanaryDeadlineMs(900), 500);   // 1000 → ceil
  assert.equal(clampCanaryDeadlineMs(null), 350);  // default when no p99
});

test('resolveCanaryDeadlineMs: env knob honoured only within the sane range', () => {
  assert.equal(resolveCanaryDeadlineMs({ env: { MEMORY_RETRIEVAL_CANARY_TIMEOUT_MS: '420' } }), 420);
  assert.equal(resolveCanaryDeadlineMs({ env: { MEMORY_RETRIEVAL_CANARY_TIMEOUT_MS: '30000' }, shadowP99Ms: 300 }), 400); // absurd → clamp
  assert.ok(resolveCanaryDeadlineMs({ env: {} }) >= CANARY_DEADLINE_FLOOR_MS);
  assert.ok(resolveCanaryDeadlineMs({ env: {} }) <= CANARY_DEADLINE_CEIL_MS);
});

// ── circuit breaker ─────────────────────────────────────────────────────────────

test('circuit breaker: opens after threshold failures, closes after cooldown', () => {
  let clock = 1000;
  const b = new MemoryRetrievalCircuitBreaker({ threshold: 3, cooldownMs: 100, now: () => clock });
  assert.equal(b.isOpen(), false);
  b.onResult(false); b.onResult(false);
  assert.equal(b.isOpen(), false);          // 2 < 3
  b.onResult(false);
  assert.equal(b.isOpen(), true);           // tripped
  clock += 50;
  assert.equal(b.isOpen(), true);           // still in cooldown
  clock += 60;
  assert.equal(b.isOpen(), false);          // cooldown elapsed → half-open
});

test('circuit breaker: a success resets the failure count', () => {
  const b = new MemoryRetrievalCircuitBreaker({ threshold: 2, now: () => 0 });
  b.onResult(false);
  b.onResult(true);
  b.onResult(false);
  assert.equal(b.isOpen(), false);          // not two CONSECUTIVE
});

// ── deadline wrapper ────────────────────────────────────────────────────────────

test('buildMemoryBundleWithDeadline: fast success passes the bundle through', async () => {
  const out = await buildMemoryBundleWithDeadline({
    invocation, deadlineMs: 200, buildBundle: async () => okBundle,
    breaker: new MemoryRetrievalCircuitBreaker()
  });
  assert.equal(out.result, okBundle);
  assert.equal(out.timedOut, false);
  assert.equal(classifyAndRenderV2(out).status, 'available');
});

test('buildMemoryBundleWithDeadline: timeout → timedOut, aborts the underlying work (test 5)', async () => {
  let aborted = false;
  const buildBundle = ({ deps }) => new Promise((resolve) => {
    deps.signal.addEventListener('abort', () => { aborted = true; });
    setTimeout(() => resolve(okBundle), 200);     // slower than the deadline
  });
  const out = await buildMemoryBundleWithDeadline({
    invocation, deadlineMs: 20, buildBundle, breaker: new MemoryRetrievalCircuitBreaker()
  });
  assert.equal(out.timedOut, true);
  assert.equal(out.result, null);
  assert.equal(aborted, true, 'the underlying retrieval received the abort signal');
  // and it maps to unavailable/timeout — NOT legacy
  const ctx = classifyAndRenderV2(out);
  assert.equal(ctx.status, 'unavailable');
  assert.equal(ctx.public_reason, 'timeout');
});

test('buildMemoryBundleWithDeadline: a throw → threw (never legacy), unavailable status', async () => {
  const out = await buildMemoryBundleWithDeadline({
    invocation, deadlineMs: 200, buildBundle: async () => { throw new Error('db exploded'); },
    breaker: new MemoryRetrievalCircuitBreaker()
  });
  assert.equal(out.threw, true);
  assert.equal(classifyAndRenderV2(out).status, 'unavailable');
});

test('buildMemoryBundleWithDeadline: an open breaker short-circuits to unavailable (no attempt)', async () => {
  const b = new MemoryRetrievalCircuitBreaker({ threshold: 1, now: () => 0 });
  b.onResult(false);                                   // trip it
  let called = false;
  const out = await buildMemoryBundleWithDeadline({
    invocation, deadlineMs: 200, buildBundle: async () => { called = true; return okBundle; }, breaker: b
  });
  assert.equal(out.shortCircuited, true);
  assert.equal(called, false, 'sick dependency is not hammered');
  assert.equal(classifyAndRenderV2(out).status, 'unavailable');
});

test('buildMemoryBundleWithDeadline: a governed refusal does NOT trip the breaker', async () => {
  const b = new MemoryRetrievalCircuitBreaker({ threshold: 1, now: () => 0 });
  const refused = { status: 'refused', failure: 'policy_denied', bundle: { context_items: [] }, consumer_receipt: { visible_excluded: [] } };
  await buildMemoryBundleWithDeadline({ invocation, deadlineMs: 200, buildBundle: async () => refused, breaker: b });
  assert.equal(b.isOpen(), false, 'a policy refusal is a correct governed outcome, not an infra failure');
});

// ── sidecar sunset sampling ─────────────────────────────────────────────────────

test('shouldRunLegacyEvalSidecar: 100% at sampleRate 1, off at 0, deterministic per id', () => {
  assert.equal(shouldRunLegacyEvalSidecar({ retrievalId: 'r1', sampleRate: 1 }), true);
  assert.equal(shouldRunLegacyEvalSidecar({ retrievalId: 'r1', sampleRate: 0 }), false);
  const a = shouldRunLegacyEvalSidecar({ retrievalId: 'retr-stable', sampleRate: 0.5 });
  const b = shouldRunLegacyEvalSidecar({ retrievalId: 'retr-stable', sampleRate: 0.5 });
  assert.equal(a, b, 'same id → same bucket (deterministic)');
});
