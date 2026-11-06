// Donna — BizOS Slice 2c-iii (sub-PR 1): ownerMemoryContext taxonomy + typed
// composition. Pure unit tests, hand-built inputs. Proves the §E1 taxonomy and the
// §C impossible-state / cross-mode-leak guards that invariant 10 rests on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RETRIEVAL_FAILURES } from './memoryRetrieval.js';
import {
  MEMORY_STATUSES,
  MEMORY_PUBLIC_REASONS,
  classifyRetrieval,
  legacyMemoryContext,
  v2MemoryContext,
  composeOwnerPromptContext,
  assertNoCrossModeMemoryLeak,
  LEGACY_FACTS_FIELD,
  MEMORY_CONTEXT_FIELD,
  MEMORY_HISTORY_FIELD
} from './ownerMemoryContext.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const okResult = ({ items = [], visibleExcluded = [] } = {}) => ({
  status: 'ok',
  failure: null,
  bundle: { context_items: items, conflict_markers: [], confirmation_candidates: [], authoritative_read_requirements: [] },
  consumer_receipt: { included: items, visible_excluded: visibleExcluded, bundle_fingerprint: 'bundle-x', as_of: '2026-07-01T00:00:00.000Z' }
});

const refused = (failure) => ({
  status: 'refused',
  failure,
  bundle: { context_items: [], conflict_markers: [], confirmation_candidates: [], authoritative_read_requirements: [] },
  consumer_receipt: { included: [], visible_excluded: [], bundle_fingerprint: 'bundle-empty', as_of: null }
});

const aFact = { subject: 'legal_entity:c1', predicate: 'vat_number', value: 'GB123', as_of: '2026-05-01' };

// ── §E1 taxonomy ──────────────────────────────────────────────────────────────

test('classifyRetrieval: ok with ≥1 item → available', () => {
  const c = classifyRetrieval({ result: okResult({ items: [{ predicate: 'x' }] }) });
  assert.equal(c.status, 'available');
  assert.equal(c.public_reason, null);
  assert.equal(c.incomplete, false);
});

test('classifyRetrieval: ok with zero items → empty (NOT a failure)', () => {
  const c = classifyRetrieval({ result: okResult({ items: [] }) });
  assert.equal(c.status, 'empty');
  assert.equal(c.public_reason, null);
});

test('classifyRetrieval: empty and unavailable are DISTINCT (amendment 1, test 3)', () => {
  const empty = classifyRetrieval({ result: okResult({ items: [] }) });
  const unavailable = classifyRetrieval({ result: refused('service_unavailable') });
  assert.equal(empty.status, 'empty');
  assert.equal(unavailable.status, 'unavailable');
  assert.notEqual(empty.status, unavailable.status);
});

test('classifyRetrieval: timeout → unavailable/timeout (regardless of result)', () => {
  const c = classifyRetrieval({ result: okResult({ items: [{ predicate: 'x' }] }), timedOut: true });
  assert.equal(c.status, 'unavailable');
  assert.equal(c.public_reason, 'timeout');
});

test('classifyRetrieval: threw / null result → unavailable (invariant 10a — never legacy)', () => {
  assert.equal(classifyRetrieval({ threw: true }).status, 'unavailable');
  assert.equal(classifyRetrieval({ result: null }).status, 'unavailable');
  assert.equal(classifyRetrieval({}).status, 'unavailable');
});

test('classifyRetrieval: integrity_failed → blocked/integrity (hard stop, test 4)', () => {
  const c = classifyRetrieval({ result: refused('integrity_failed') });
  assert.equal(c.status, 'blocked');
  assert.equal(c.public_reason, 'integrity');
});

test('classifyRetrieval: principal/audience unresolved → blocked/identity', () => {
  assert.equal(classifyRetrieval({ result: refused('principal_unresolved') }).public_reason, 'identity');
  assert.equal(classifyRetrieval({ result: refused('audience_unresolved') }).status, 'blocked');
});

test('classifyRetrieval: top-level policy/acl denial → blocked/policy', () => {
  assert.equal(classifyRetrieval({ result: refused('policy_denied') }).public_reason, 'policy');
  assert.equal(classifyRetrieval({ result: refused('acl_resolution_failed') }).status, 'blocked');
  assert.equal(classifyRetrieval({ result: refused('consumer_not_permitted') }).public_reason, 'policy');
});

test('classifyRetrieval: wiring-bug refusals → blocked (fail loud + closed)', () => {
  assert.equal(classifyRetrieval({ result: refused('invalid_request') }).status, 'blocked');
  assert.equal(classifyRetrieval({ result: refused('unknown_purpose') }).status, 'blocked');
});

test('classifyRetrieval: every RETRIEVAL_FAILURES value maps to a valid status/reason', () => {
  for (const failure of RETRIEVAL_FAILURES) {
    const c = classifyRetrieval({ result: refused(failure) });
    assert.ok(MEMORY_STATUSES.includes(c.status), `status for ${failure}`);
    assert.ok(c.public_reason == null || MEMORY_PUBLIC_REASONS.includes(c.public_reason), `reason for ${failure}`);
    // a refusal never yields available/empty (those are ok-only)
    assert.ok(c.status === 'unavailable' || c.status === 'blocked', `refusal ${failure} is degraded`);
  }
});

test('classifyRetrieval: unknown failure code → blocked (fail closed, no silent answer)', () => {
  const c = classifyRetrieval({ result: { status: 'refused', failure: 'some_new_code_2027' } });
  assert.equal(c.status, 'blocked');
});

test('classifyRetrieval: budget-truncated projection → incomplete=true (test 11)', () => {
  const c = classifyRetrieval({ result: okResult({
    items: [{ predicate: 'x' }],
    visibleExcluded: [{ memory_id: 'm2', reason_category: 'budget' }]
  }) });
  assert.equal(c.status, 'available');
  assert.equal(c.incomplete, true);
});

test('classifyRetrieval: item_too_large also marks incomplete', () => {
  const c = classifyRetrieval({ result: okResult({
    items: [{ predicate: 'x' }],
    visibleExcluded: [{ memory_id: 'm2', reason_category: 'item_too_large' }]
  }) });
  assert.equal(c.incomplete, true);
});

test('classifyRetrieval: temporal exclusion is NOT truncation → incomplete stays false', () => {
  const c = classifyRetrieval({ result: okResult({
    items: [{ predicate: 'x' }],
    visibleExcluded: [{ memory_id: 'm2', reason_category: 'temporal_expired' }]
  }) });
  assert.equal(c.incomplete, false);
});

// ── Discriminated union construction (§C, impossible-state prevention) ─────────

test('v2MemoryContext: available with a fact → frozen union', () => {
  const ctx = v2MemoryContext({ status: 'available', recorded_facts: [aFact], as_of: '2026-07-01' });
  assert.equal(ctx.mode, 'v2');
  assert.equal(ctx.status, 'available');
  assert.equal(ctx.recorded_facts.length, 1);
  assert.throws(() => { ctx.status = 'empty'; }, /Cannot assign|read only|frozen/i);
});

test('v2MemoryContext: available REQUIRES ≥1 fact', () => {
  assert.throws(() => v2MemoryContext({ status: 'available', recorded_facts: [] }), /requires ≥1/);
});

test('v2MemoryContext: empty must carry NO facts', () => {
  assert.throws(() => v2MemoryContext({ status: 'empty', recorded_facts: [aFact] }), /must carry no recorded facts/);
  // empty with conflicts (pure-conflict slot) is allowed
  const ctx = v2MemoryContext({ status: 'empty', conflicts: [{ subject: 's', predicate: 'p', state: 'conflicted' }] });
  assert.equal(ctx.conflicts.length, 1);
});

test('v2MemoryContext: impossible state — degraded status carrying content is REFUSED (test 2)', () => {
  assert.throws(() => v2MemoryContext({ status: 'unavailable', recorded_facts: [aFact] }), /must carry no memory content/);
  assert.throws(() => v2MemoryContext({ status: 'blocked', conflicts: [{ subject: 's', predicate: 'p', state: 'conflicted' }] }), /must carry no memory content/);
});

test('v2MemoryContext: invalid status / public_reason rejected', () => {
  assert.throws(() => v2MemoryContext({ status: 'weird' }), /invalid status/);
  assert.throws(() => v2MemoryContext({ status: 'empty', public_reason: 'because' }), /invalid public_reason/);
});

test('v2MemoryContext: staleness — a stale/old as_of is carried as data, never re-stamped as now (test 12)', () => {
  const stale = { subject: 'legal_entity:c1', predicate: 'address', value: '1 Old St', as_of: '2019-01-01', valid_until: '2020-01-01' };
  const ctx = v2MemoryContext({ status: 'available', recorded_facts: [stale], as_of: '2026-07-01' });
  // the fact's own as_of/valid_until are preserved verbatim — the envelope as_of is
  // the retrieval clock, not a rewrite of the record's validity.
  assert.equal(ctx.recorded_facts[0].as_of, '2019-01-01');
  assert.equal(ctx.recorded_facts[0].valid_until, '2020-01-01');
  assert.equal(ctx.as_of, '2026-07-01');
});

test('legacyMemoryContext: wraps known_facts (null-safe)', () => {
  assert.deepEqual(legacyMemoryContext({ knownFacts: ['a', 'b'] }), { mode: 'legacy', known_facts: ['a', 'b'] });
  assert.deepEqual(legacyMemoryContext({}), { mode: 'legacy', known_facts: null });
});

// ── Composition (§C, no mutation) ─────────────────────────────────────────────

test('composeOwnerPromptContext: v2 mode sets memory, nulls legacy, does not mutate base', () => {
  const base = { locale: 'en-GB', known_facts: ['leaked legacy fact'] };
  const mem = v2MemoryContext({ status: 'available', recorded_facts: [aFact] });
  const out = composeOwnerPromptContext({ baseContext: base, memoryContext: mem });
  assert.equal(out[LEGACY_FACTS_FIELD], null);
  assert.equal(out[MEMORY_CONTEXT_FIELD], mem);
  assert.equal(out.locale, 'en-GB');
  // base untouched
  assert.deepEqual(base.known_facts, ['leaked legacy fact']);
});

test('composeOwnerPromptContext: legacy mode sets known_facts, nulls memory', () => {
  const base = { locale: 'en-GB', memory: { mode: 'v2', status: 'available' } };
  const out = composeOwnerPromptContext({ baseContext: base, memoryContext: legacyMemoryContext({ knownFacts: ['f1'] }) });
  assert.deepEqual(out[LEGACY_FACTS_FIELD], ['f1']);
  assert.equal(out[MEMORY_CONTEXT_FIELD], null);
});

test('composeOwnerPromptContext: threads governed history under memory_history', () => {
  const out = composeOwnerPromptContext({
    baseContext: {},
    memoryContext: legacyMemoryContext({ knownFacts: null }),
    history: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(out[MEMORY_HISTORY_FIELD].length, 1);
});

test('composeOwnerPromptContext: rejects a non-union memoryContext', () => {
  assert.throws(() => composeOwnerPromptContext({ baseContext: {}, memoryContext: { foo: 1 } }), /discriminated union/);
});

// ── Cross-mode leak assertion (§C/§F, invariant 10) ───────────────────────────

test('assertNoCrossModeMemoryLeak: v2 mode with clean context passes', () => {
  const mem = v2MemoryContext({ status: 'available', recorded_facts: [aFact] });
  const out = composeOwnerPromptContext({ baseContext: { known_facts: ['x'] }, memoryContext: mem });
  assert.equal(assertNoCrossModeMemoryLeak(out, 'v2'), true);
});

test('assertNoCrossModeMemoryLeak: v2 mode but legacy facts present → throws', () => {
  const mem = v2MemoryContext({ status: 'available', recorded_facts: [aFact] });
  const leaked = { known_facts: ['still here'], memory: mem };
  assert.throws(() => assertNoCrossModeMemoryLeak(leaked, 'v2'), /legacy known_facts present/);
});

test('assertNoCrossModeMemoryLeak: legacy mode but v2 section present → throws', () => {
  const bad = { known_facts: ['f'], memory: { mode: 'v2', status: 'available', recorded_facts: [aFact], conflicts: [] } };
  assert.throws(() => assertNoCrossModeMemoryLeak(bad, 'legacy'), /v2 memory context present/);
});

test('assertNoCrossModeMemoryLeak: v2 mode with no v2 section → throws', () => {
  assert.throws(() => assertNoCrossModeMemoryLeak({ known_facts: null, memory: null }, 'v2'), /no v2 memory context/);
});

test('assertNoCrossModeMemoryLeak: empty legacy array in v2 mode is NOT a leak', () => {
  const mem = v2MemoryContext({ status: 'empty' });
  const out = composeOwnerPromptContext({ baseContext: { known_facts: [] }, memoryContext: mem });
  // compose nulls it anyway, but assert tolerates an empty array too
  assert.equal(assertNoCrossModeMemoryLeak({ known_facts: [], memory: mem }, 'v2'), true);
});

test('assertNoCrossModeMemoryLeak: unknown mode → throws', () => {
  assert.throws(() => assertNoCrossModeMemoryLeak({ memory: null }, 'sideways'), /unknown mode/);
});
