// Donna Loops — the typed case-dependency graph: derive + traverse (uplift §6.2).
//
// Migration 037 stores case dependencies in ONE canonical direction only
// (parent_case_id → child_case_id, a typed edge) so the graph can never
// contradict itself. The design (loops-architecture-uplift-design.md §6.2) is
// explicit that the inverses — blocked_by / unblocks / parent_of — are DERIVED
// through read helpers, NEVER stored as their own rows. This leaf is those
// helpers, plus the cascade traversal that turns the graph into an operating
// system: "Evidence case E blocks coding case C blocks monthly-close M — when E's
// goal is met, C re-evaluates; if C resolves, M re-evaluates."
//
// PURE + dependency-light on purpose: every function takes an in-memory array of
// dependency rows (exactly the shape `select * from bookkeeping_case_dependencies`
// returns) and computes over it — zero DB, so it is node --test-able in-sandbox
// like loopGoal.js. The Step-3 caller fetches the rows (via a future store read)
// and the inbox emits the cascade events; this module only decides the shape and
// the order. It imports just the canonical vocabulary from loopGoalStore (the
// single source the migration test pins), so it stays free of any DB import cycle.
//
// THE storage convention every reader and writer must share (so derivation is
// unambiguous): parent_case_id is the UPSTREAM case (the blocker / origin /
// container / superseder / hierarchy-parent); child_case_id is the DOWNSTREAM
// case (the blocked / offspring / member / superseded / hierarchy-child). The
// design's worked example fixes it: "E blocks C" ⇒ parent = E, child = C.

import { CASE_DEPENDENCY_TYPES } from './loopGoalStore.js';

export { CASE_DEPENDENCY_TYPES };

// The label each canonical edge carries when viewed from its OTHER end — the
// derived inverse, for the "what depends on me / what do I depend on" UI and for
// naming a cascade event. Stored nowhere; computed here. Every canonical verb has
// exactly one inverse label (caseDependency.test.js pins this set against
// CASE_DEPENDENCY_TYPES so a new verb can't ship without its inverse).
export const INVERSE_RELATIONSHIP = Object.freeze({
  blocks: 'blocked_by',
  spawned_from: 'spawned',
  satisfies: 'satisfied_by',
  aggregates: 'aggregated_into',
  supersedes: 'superseded_by',
  child_of: 'parent_of'
});

export const inverseLabel = (type) => INVERSE_RELATIONSHIP[type] || null;

const KNOWN = new Set(CASE_DEPENDENCY_TYPES);

// An edge counts only if it is well-formed (both endpoints + a known verb) and,
// when activeOnly, not yet resolved (a resolved dependency no longer binds).
const edgeOk = (e, types, activeOnly) =>
  e && e.parent_case_id && e.child_case_id &&
  KNOWN.has(e.relationship_type) &&
  (!types || types.includes(e.relationship_type)) &&
  (!activeOnly || e.resolved_at == null);

// Cases DOWNSTREAM of caseId on the given verbs: the child_case_id of every edge
// where caseId is the parent. These are the cases caseId affects when it resolves.
export const downstreamOf = (rows = [], caseId, { types = null, activeOnly = false } = {}) => {
  const out = [];
  const seen = new Set();
  for (const e of rows) {
    if (!edgeOk(e, types, activeOnly)) continue;
    if (e.parent_case_id === caseId && !seen.has(e.child_case_id)) {
      seen.add(e.child_case_id);
      out.push(e.child_case_id);
    }
  }
  return out;
};

// Cases UPSTREAM of caseId on the given verbs: the parent_case_id of every edge
// where caseId is the child. These are the cases caseId depends on.
export const upstreamOf = (rows = [], caseId, { types = null, activeOnly = false } = {}) => {
  const out = [];
  const seen = new Set();
  for (const e of rows) {
    if (!edgeOk(e, types, activeOnly)) continue;
    if (e.child_case_id === caseId && !seen.has(e.parent_case_id)) {
      seen.add(e.parent_case_id);
      out.push(e.parent_case_id);
    }
  }
  return out;
};

// ── the named inverses the design calls for (§6.2) ──────────────────────────

// Cases that BLOCK caseId right now (caseId is the child of an active 'blocks'
// edge). The derived `blocked_by` view — what caseId is waiting on.
export const blockedBy = (rows = [], caseId, { activeOnly = true } = {}) =>
  upstreamOf(rows, caseId, { types: ['blocks'], activeOnly });

// Cases caseId will UNBLOCK when it resolves (caseId is the parent of a 'blocks'
// edge). The derived `unblocks` view — who becomes newly actionable.
export const unblocks = (rows = [], caseId, { activeOnly = true } = {}) =>
  downstreamOf(rows, caseId, { types: ['blocks'], activeOnly });

// The hierarchy parents of caseId (caseId is child_of these). Derived `parent_of`
// is the reverse: hierarchyChildrenOf.
export const hierarchyParentsOf = (rows = [], caseId) =>
  upstreamOf(rows, caseId, { types: ['child_of'] });

export const hierarchyChildrenOf = (rows = [], caseId) =>
  downstreamOf(rows, caseId, { types: ['child_of'] });

// The full derived edge view for one case: its outgoing edges (canonical verb)
// and its incoming edges (the derived inverse label). What a "dependencies" panel
// renders, and what the cascade planner reads — never a stored inverse row.
export const deriveEdges = (rows = [], caseId) => {
  const outgoing = [];
  const incoming = [];
  for (const e of rows) {
    if (!edgeOk(e, null, false)) continue;
    if (e.parent_case_id === caseId) {
      outgoing.push({ caseId: e.child_case_id, relationshipType: e.relationship_type, resolved: e.resolved_at != null });
    }
    if (e.child_case_id === caseId) {
      incoming.push({ caseId: e.parent_case_id, relationshipType: inverseLabel(e.relationship_type), resolved: e.resolved_at != null });
    }
  }
  return { outgoing, incoming };
};

// ── the cascade (the load-bearing traversal) ────────────────────────────────

const buildAdjacency = (rows, types, activeOnly) => {
  const adj = new Map();
  for (const e of rows) {
    if (!edgeOk(e, types, activeOnly)) continue;
    if (!adj.has(e.parent_case_id)) adj.set(e.parent_case_id, new Set());
    adj.get(e.parent_case_id).add(e.child_case_id);
  }
  return adj;
};

// The order in which downstream cases must RE-EVALUATE when rootCaseId resolves.
// Walks parent → child along the given verbs (default ['blocks'] — the design's
// concrete cascade) and returns a topological order: a case appears only AFTER
// every in-cascade case it depends on, so `E blocks C blocks M` yields [C, M] and
// the diamond `E→C→M, E→M` still yields [C, M] (M waits for C). Cycle-SAFE: a
// malformed cycle never hangs — its trapped nodes are appended in discovery order
// (use hasCycle to assert acyclicity upstream). rootCaseId is excluded from the
// result. activeOnly defaults false: the cascade reasons over the structural graph
// regardless of which edges have already been marked resolved.
export const cascadeOrder = (rows = [], rootCaseId, { types = ['blocks'], activeOnly = false } = {}) => {
  if (!rootCaseId) return [];
  const adj = buildAdjacency(rows, types, activeOnly);

  // Reachable set from root (root excluded from output, included for traversal).
  const reachable = new Set();
  const stack = [...(adj.get(rootCaseId) || [])];
  while (stack.length) {
    const n = stack.pop();
    if (n === rootCaseId || reachable.has(n)) continue;
    reachable.add(n);
    for (const m of (adj.get(n) || [])) if (m !== rootCaseId && !reachable.has(m)) stack.push(m);
  }

  // Topological order over {root} ∪ reachable using only edges among those nodes.
  const nodes = new Set([rootCaseId, ...reachable]);
  const indeg = new Map([...nodes].map((n) => [n, 0]));
  for (const [from, tos] of adj) {
    if (!nodes.has(from)) continue;
    for (const to of tos) if (nodes.has(to) && to !== rootCaseId) indeg.set(to, indeg.get(to) + 1);
  }

  const queue = [rootCaseId];           // seed with root; it is the resolved case
  const seen = new Set([rootCaseId]);
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    if (n !== rootCaseId) order.push(n);
    for (const to of (adj.get(n) || [])) {
      if (!nodes.has(to) || to === rootCaseId) continue;
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) <= 0 && !seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  // Any reachable node a cycle kept from reaching in-degree 0 still gets emitted.
  for (const n of reachable) if (!seen.has(n)) { seen.add(n); order.push(n); }
  return order;
};

// True when the graph (over the given verbs) contains a directed cycle. The
// migration forbids self-edges but not longer cycles; a typed dependency graph
// that wants to be an operating system should be able to assert it is a DAG.
export const hasCycle = (rows = [], { types = null, activeOnly = false } = {}) => {
  const adj = buildAdjacency(rows, types, activeOnly);
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map();
  const colorOf = (n) => color.get(n) || WHITE;

  const visit = (start) => {
    // Iterative DFS with an explicit recursion stack so a deep/wide graph can't
    // blow the call stack.
    const stack = [[start, adj.get(start) ? [...adj.get(start)] : []]];
    color.set(start, GREY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const [node, kids] = frame;
      if (kids.length) {
        const next = kids.pop();
        const c = colorOf(next);
        if (c === GREY) return true;            // back-edge → cycle
        if (c === WHITE) {
          color.set(next, GREY);
          stack.push([next, adj.get(next) ? [...adj.get(next)] : []]);
        }
      } else {
        color.set(node, BLACK);
        stack.pop();
      }
    }
    return false;
  };

  for (const from of adj.keys()) {
    if (colorOf(from) === WHITE && visit(from)) return true;
  }
  return false;
};
