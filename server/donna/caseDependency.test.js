// Donna Loops — typed case-dependency derivation + cascade (caseDependency.js)
// unit tests. Load-bearing properties (uplift §6.2):
//   - every canonical verb has a derived inverse label (pinned against the
//     migration/store vocabulary so a new verb can't ship without its inverse)
//   - blocked_by / unblocks / parent_of are DERIVED from the one canonical
//     direction, never read from a stored inverse row
//   - resolved edges stop binding (activeOnly)
//   - the cascade is a TOPOLOGICAL order (M re-evaluates only after C) and is
//     CYCLE-SAFE (a malformed cycle never hangs)

import test from 'node:test';
import assert from 'node:assert/strict';

import { CASE_DEPENDENCY_TYPES } from './loopGoalStore.js';
import {
  INVERSE_RELATIONSHIP, inverseLabel, downstreamOf, upstreamOf,
  blockedBy, unblocks, hierarchyParentsOf, hierarchyChildrenOf,
  deriveEdges, cascadeOrder, hasCycle
} from './caseDependency.js';

const dep = (parent, child, type, resolved_at = null) => ({
  parent_case_id: parent, child_case_id: child, relationship_type: type, resolved_at
});

test('every canonical verb has exactly one inverse label (pinned to the vocabulary)', () => {
  assert.deepEqual(
    Object.keys(INVERSE_RELATIONSHIP).sort(),
    [...CASE_DEPENDENCY_TYPES].sort(),
    'INVERSE_RELATIONSHIP covers exactly the canonical relationship verbs'
  );
  assert.equal(inverseLabel('blocks'), 'blocked_by');
  assert.equal(inverseLabel('child_of'), 'parent_of');
  assert.equal(inverseLabel('not_a_verb'), null);
});

test('blockedBy / unblocks derive both directions from one canonical blocks edge', () => {
  const rows = [dep('E', 'C', 'blocks')]; // E blocks C (E upstream, C downstream)
  assert.deepEqual(blockedBy(rows, 'C'), ['E']);   // C is blocked_by E
  assert.deepEqual(unblocks(rows, 'E'), ['C']);    // E unblocks C when it resolves
  // and the opposite ends see nothing
  assert.deepEqual(blockedBy(rows, 'E'), []);
  assert.deepEqual(unblocks(rows, 'C'), []);
});

test('a resolved dependency stops binding (activeOnly default on blockedBy)', () => {
  const rows = [dep('A', 'B', 'blocks'), dep('X', 'B', 'blocks', '2026-06-20T00:00:00Z')];
  assert.deepEqual(blockedBy(rows, 'B'), ['A']);                       // resolved X dropped
  assert.deepEqual(blockedBy(rows, 'B', { activeOnly: false }).sort(), ['A', 'X']); // unless asked for all
});

test('hierarchyParentsOf / hierarchyChildrenOf derive parent_of from child_of', () => {
  const rows = [dep('Close', 'Coding', 'child_of')]; // Coding is a member of Close
  assert.deepEqual(hierarchyParentsOf(rows, 'Coding'), ['Close']);
  assert.deepEqual(hierarchyChildrenOf(rows, 'Close'), ['Coding']);
});

test('deriveEdges: outgoing keeps the canonical verb, incoming carries the inverse label', () => {
  const rows = [dep('E', 'C', 'blocks'), dep('C', 'M', 'blocks')];
  const edges = deriveEdges(rows, 'C');
  assert.deepEqual(edges.outgoing, [{ caseId: 'M', relationshipType: 'blocks', resolved: false }]);
  assert.deepEqual(edges.incoming, [{ caseId: 'E', relationshipType: 'blocked_by', resolved: false }]);
});

test('downstreamOf / upstreamOf honour the requested verbs and dedupe', () => {
  const rows = [dep('A', 'B', 'blocks'), dep('A', 'B', 'aggregates'), dep('A', 'C', 'blocks')];
  assert.deepEqual(downstreamOf(rows, 'A', { types: ['blocks'] }).sort(), ['B', 'C']);
  assert.deepEqual(downstreamOf(rows, 'A', { types: ['aggregates'] }), ['B']);
  assert.deepEqual(upstreamOf(rows, 'B', { types: ['blocks'] }), ['A']);
});

test('cascadeOrder: a linear chain re-evaluates downstream in order', () => {
  // E blocks C blocks M — resolving E re-evaluates C, then M.
  const rows = [dep('E', 'C', 'blocks'), dep('C', 'M', 'blocks')];
  assert.deepEqual(cascadeOrder(rows, 'E'), ['C', 'M']);
  assert.deepEqual(cascadeOrder(rows, 'C'), ['M']);
  assert.deepEqual(cascadeOrder(rows, 'M'), []); // a leaf cascades to nobody
});

test('cascadeOrder: a diamond still re-evaluates M only AFTER C (topological)', () => {
  // E blocks both C and M; C also blocks M. M must wait for C.
  const rows = [dep('E', 'C', 'blocks'), dep('E', 'M', 'blocks'), dep('C', 'M', 'blocks')];
  assert.deepEqual(cascadeOrder(rows, 'E'), ['C', 'M']);
});

test('cascadeOrder: a cycle is safe — it never hangs and returns all reachable', () => {
  const rows = [dep('A', 'B', 'blocks'), dep('B', 'C', 'blocks'), dep('C', 'A', 'blocks')];
  const order = cascadeOrder(rows, 'A');
  assert.deepEqual(order.sort(), ['B', 'C']); // root excluded; both reachable nodes emitted
});

test('cascadeOrder: only the requested verbs propagate (default blocks)', () => {
  const rows = [dep('E', 'C', 'blocks'), dep('C', 'M', 'aggregates')];
  assert.deepEqual(cascadeOrder(rows, 'E'), ['C']);                       // aggregates not followed
  assert.deepEqual(cascadeOrder(rows, 'E', { types: ['blocks', 'aggregates'] }), ['C', 'M']);
});

test('hasCycle: true on a directed cycle, false on a DAG', () => {
  assert.equal(hasCycle([dep('A', 'B', 'blocks'), dep('B', 'C', 'blocks'), dep('C', 'A', 'blocks')]), true);
  assert.equal(hasCycle([dep('E', 'C', 'blocks'), dep('E', 'M', 'blocks'), dep('C', 'M', 'blocks')]), false);
});

test('malformed / unknown-verb rows are ignored, not thrown on', () => {
  const rows = [
    dep('A', 'B', 'totally_made_up'),  // unknown verb
    { parent_case_id: 'A' },           // missing child
    null,                              // junk
    dep('A', 'B', 'blocks')            // the one good edge
  ];
  assert.deepEqual(blockedBy(rows, 'B'), ['A']);
  assert.deepEqual(cascadeOrder(rows, 'A'), ['B']);
  assert.equal(hasCycle(rows), false);
});
