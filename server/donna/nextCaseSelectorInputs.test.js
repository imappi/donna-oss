// Tests for the dependency-graph → NextCaseSelector input bridge (design §6.2↔§6.3).
// Pure / node --test only. Verifies the three derived signals (blockingImpact /
// dependencyDepth / blocksClose) over the bookkeeping_case_dependencies row shape,
// resolved-edge handling, cycle-safety, purity, and an END-TO-END pass straight
// into selectNextCases (the whole point of the bridge).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockingImpactOf,
  dependencyDepthOf,
  blocksCloseOf,
  dependencyInputsFor,
  deriveSelectorDependencyInputs,
  attachDependencyInputs
} from './nextCaseSelectorInputs.js';
import { selectNextCases } from './nextCaseSelector.js';

// Row shape = `select * from bookkeeping_case_dependencies`. parent = UPSTREAM
// (blocker), child = DOWNSTREAM (blocked). "E blocks C" ⇒ parent E, child C.
const blocks = (parent, child, resolvedAt = null) => ({
  parent_case_id: parent, child_case_id: child, relationship_type: 'blocks', resolved_at: resolvedAt
});

// E blocks C blocks M — the design's worked cascade (M is a monthly-close case).
const CHAIN = [blocks('E', 'C'), blocks('C', 'M')];

// ---- blockingImpact (transitive fan-out) ----------------------------------

test('blockingImpact: a root blocker counts its whole transitive chain', () => {
  assert.equal(blockingImpactOf(CHAIN, 'E'), 2); // C and M
  assert.equal(blockingImpactOf(CHAIN, 'C'), 1); // M
  assert.equal(blockingImpactOf(CHAIN, 'M'), 0);
});

test('blockingImpact: a diamond dedups the shared sink', () => {
  const diamond = [blocks('E', 'C'), blocks('C', 'M'), blocks('E', 'M')];
  assert.equal(blockingImpactOf(diamond, 'E'), 2); // C and M, not 3
});

test('blockingImpact: unknown / empty → 0', () => {
  assert.equal(blockingImpactOf(CHAIN, 'ZZZ'), 0);
  assert.equal(blockingImpactOf([], 'E'), 0);
});

// ---- dependencyDepth (longest upstream blocker chain) ---------------------

test('dependencyDepth: root is 0, each hop deeper +1', () => {
  assert.equal(dependencyDepthOf(CHAIN, 'E'), 0);
  assert.equal(dependencyDepthOf(CHAIN, 'C'), 1);
  assert.equal(dependencyDepthOf(CHAIN, 'M'), 2);
});

test('dependencyDepth: takes the LONGEST upstream path in a diamond', () => {
  const diamond = [blocks('E', 'C'), blocks('C', 'M'), blocks('E', 'M')];
  assert.equal(dependencyDepthOf(diamond, 'M'), 2); // E→C→M, not the direct E→M (1)
});

// ---- blocksClose ----------------------------------------------------------

test('blocksClose: true along the path to a close case, false at/below it', () => {
  const close = ['M'];
  assert.equal(blocksCloseOf(CHAIN, 'E', close), true);
  assert.equal(blocksCloseOf(CHAIN, 'C', close), true);
  assert.equal(blocksCloseOf(CHAIN, 'M', close), false); // M IS the close, doesn't block one
});

test('blocksClose: empty close set → always false; accepts a Set', () => {
  assert.equal(blocksCloseOf(CHAIN, 'E', []), false);
  assert.equal(blocksCloseOf(CHAIN, 'E', new Set(['M'])), true);
});

// ---- resolved-edge handling (activeOnly default true) ---------------------

test('a resolved blocker no longer binds: impact shrinks, depth drops', () => {
  const rows = [blocks('E', 'C', '2026-06-19T00:00:00Z'), blocks('C', 'M')];
  // E→C resolved: E now blocks nothing active; C is no longer blocked by E.
  assert.equal(blockingImpactOf(rows, 'E'), 0);
  assert.equal(dependencyDepthOf(rows, 'C'), 0);
  assert.equal(dependencyDepthOf(rows, 'M'), 1); // only C→M still active
});

test('activeOnly:false reasons over the structural graph incl. resolved edges', () => {
  const rows = [blocks('E', 'C', '2026-06-19T00:00:00Z'), blocks('C', 'M')];
  assert.equal(blockingImpactOf(rows, 'E', { activeOnly: false }), 2);
  assert.equal(dependencyDepthOf(rows, 'M', { activeOnly: false }), 2);
});

// ---- cycle safety ---------------------------------------------------------

test('a cycle terminates (never hangs) for impact and depth', () => {
  const cyclic = [blocks('A', 'B'), blocks('B', 'C'), blocks('C', 'A')];
  assert.equal(typeof blockingImpactOf(cyclic, 'A'), 'number');
  assert.equal(typeof dependencyDepthOf(cyclic, 'A'), 'number');
});

// ---- deriveSelectorDependencyInputs (the map) -----------------------------

test('deriveSelectorDependencyInputs: one Map entry per case', () => {
  const m = deriveSelectorDependencyInputs(CHAIN, ['E', 'C', 'M'], { closeCaseIds: ['M'] });
  assert.deepEqual(m.get('E'), { blockingImpact: 2, dependencyDepth: 0, blocksClose: true });
  assert.deepEqual(m.get('M'), { blockingImpact: 0, dependencyDepth: 2, blocksClose: false });
});

test('dependencyInputsFor: single-case convenience matches the map', () => {
  assert.deepEqual(
    dependencyInputsFor(CHAIN, 'C', { closeCaseIds: ['M'] }),
    { blockingImpact: 1, dependencyDepth: 1, blocksClose: true }
  );
});

// ---- attachDependencyInputs (purity + the bridge) -------------------------

test('attachDependencyInputs: returns NEW objects, does not mutate inputs', () => {
  const cases = [{ id: 'E', status: 'open' }];
  const before = JSON.stringify(cases);
  const out = attachDependencyInputs(cases, CHAIN, { closeCaseIds: ['M'] });
  assert.equal(JSON.stringify(cases), before);
  assert.notEqual(out[0], cases[0]);
  assert.equal(out[0].blockingImpact, 2);
  assert.equal(out[0].blocksClose, true);
});

test('attachDependencyInputs: overwrites any pre-set derived field (graph is source of truth)', () => {
  const out = attachDependencyInputs([{ id: 'M', blockingImpact: 999 }], CHAIN, { closeCaseIds: ['M'] });
  assert.equal(out[0].blockingImpact, 0);
});

test('attachDependencyInputs: a case absent from the graph gets a clean copy (no derived fields invented)', () => {
  const out = attachDependencyInputs([{ id: 'LONE', status: 'open' }], CHAIN, { closeCaseIds: ['M'] });
  assert.equal(out[0].blockingImpact, 0);
  assert.equal(out[0].dependencyDepth, 0);
  assert.equal(out[0].blocksClose, false);
});

test('attachDependencyInputs: non-array throws', () => {
  assert.throws(() => attachDependencyInputs('nope', CHAIN), /must be an array/);
});

// ---- END TO END: feed the bridge straight into selectNextCases ------------

test('end-to-end: a close-blocking root outranks a plain case via the derived inputs', () => {
  const cases = [
    { id: 'E', status: 'open', ownerType: 'system', goalStatus: 'unmet' }, // root blocker of close M
    { id: 'P', status: 'open', ownerType: 'system', goalStatus: 'unmet' }  // unrelated, no deps
  ];
  const enriched = attachDependencyInputs(cases, CHAIN, { closeCaseIds: ['M'] });
  const ranked = selectNextCases({ cases: enriched, asOf: '2026-06-20T00:00:00Z' });
  assert.equal(ranked.ranked[0].caseId, 'E');
  assert.match(ranked.ranked[0].explanation, /blocks monthly close/);
});
