// Donna Loops — derive NextCaseSelector dependency inputs from the typed graph.
//
// The bridge between two pure leaves: caseDependency.js (the typed
// case-dependency graph — design §6.2) and nextCaseSelector.js (the deterministic
// cross-case ranker — design §6.3). The ranker scores three dependency-shaped
// signals it does NOT compute itself — blockingImpact, dependencyDepth,
// blocksClose — and the design is explicit they are "caller-supplied numbers
// derived upstream from the typed case-dependency graph". This module is that
// caller-side derivation, kept pure and separate so the ranker stays a zero-import
// leaf and this graph math stays independently testable.
//
// PURE + zero-DB, like both modules it joins: every function takes the in-memory
// `select * from bookkeeping_case_dependencies` row array (the caseDependency
// shape) and returns plain numbers/booleans. No LLM, no I/O. The Step-5/7 engine
// fetches the rows and the close-case membership, calls attachDependencyInputs,
// and hands the enriched candidates to selectNextCases — selecting work and
// claiming it stay separate (INV-16), and the whole ranking stays replayable.
//
// Derivation semantics (all over the 'blocks' verb, the design's concrete
// cascade; activeOnly defaults TRUE — only an UNRESOLVED edge still binds, so a
// resolved blocker neither inflates impact nor gates a case):
//   blockingImpact  — how many cases this case TRANSITIVELY unblocks when it
//                     resolves (cascadeOrder fan-out). A root blocker outscores a
//                     leaf because resolving it frees the whole chain.
//   dependencyDepth — the longest chain of active blockers UPSTREAM of the case;
//                     depth 0 = nothing blocks it = actionable now. The ranker
//                     maps 0 → fully actionable and decays deeper.
//   blocksClose     — does its transitive downstream set reach a monthly-close
//                     case? (closeCaseIds is supplied by the caller — the
//                     LoopDefinition for close readiness identifies them; this
//                     module assumes nothing about the case-type vocabulary.)

import { cascadeOrder, upstreamOf } from './caseDependency.js';

const BLOCKS = ['blocks'];

// Transitive downstream count on active 'blocks' edges: the number of cases this
// case unblocks when it resolves. cascadeOrder excludes the root and is cycle-safe.
export const blockingImpactOf = (rows = [], caseId, { activeOnly = true } = {}) => {
  if (!caseId) return 0;
  return cascadeOrder(rows, caseId, { types: BLOCKS, activeOnly }).length;
};

// Longest chain of active blockers ending at caseId (0 = a root, nothing blocks
// it). Memoized DFS up the 'blocks' edges; cycle-SAFE — a node already on the
// current path contributes 0 rather than recursing forever (the graph is meant to
// be a DAG; caseDependency.hasCycle is the upstream assertion). The shared memo
// makes a whole-graph derivation linear-ish instead of re-walking each case.
export const dependencyDepthOf = (rows = [], caseId, { activeOnly = true, memo = new Map(), stack = new Set() } = {}) => {
  if (!caseId) return 0;
  if (memo.has(caseId)) return memo.get(caseId);
  if (stack.has(caseId)) return 0; // on the current path → cycle guard
  stack.add(caseId);
  let depth = 0;
  for (const blocker of upstreamOf(rows, caseId, { types: BLOCKS, activeOnly })) {
    depth = Math.max(depth, 1 + dependencyDepthOf(rows, blocker, { activeOnly, memo, stack }));
  }
  stack.delete(caseId);
  memo.set(caseId, depth);
  return depth;
};

// True when resolving this case (transitively, on active 'blocks' edges) reaches
// any case in closeCaseIds — i.e. it is on the critical path to a monthly close.
export const blocksCloseOf = (rows = [], caseId, closeCaseIds = [], { activeOnly = true } = {}) => {
  if (!caseId) return false;
  const closeSet = closeCaseIds instanceof Set ? closeCaseIds : new Set(closeCaseIds);
  if (closeSet.size === 0) return false;
  for (const downstream of cascadeOrder(rows, caseId, { types: BLOCKS, activeOnly })) {
    if (closeSet.has(downstream)) return true;
  }
  return false;
};

// The three derived selector inputs for one case, in one pass-friendly call.
export const dependencyInputsFor = (rows = [], caseId, { closeCaseIds = [], activeOnly = true, memo } = {}) => ({
  blockingImpact: blockingImpactOf(rows, caseId, { activeOnly }),
  dependencyDepth: dependencyDepthOf(rows, caseId, { activeOnly, memo: memo || new Map() }),
  blocksClose: blocksCloseOf(rows, caseId, closeCaseIds, { activeOnly })
});

// Derive the inputs for a set of case ids → Map<caseId, {blockingImpact,
// dependencyDepth, blocksClose}>. Shares one depth memo across all cases.
export const deriveSelectorDependencyInputs = (rows = [], caseIds = [], { closeCaseIds = [], activeOnly = true } = {}) => {
  const closeSet = closeCaseIds instanceof Set ? closeCaseIds : new Set(closeCaseIds);
  const memo = new Map();
  const out = new Map();
  for (const caseId of caseIds) {
    if (!caseId || out.has(caseId)) continue;
    out.set(caseId, {
      blockingImpact: blockingImpactOf(rows, caseId, { activeOnly }),
      dependencyDepth: dependencyDepthOf(rows, caseId, { activeOnly, memo }),
      blocksClose: blocksCloseOf(rows, caseId, closeSet, { activeOnly })
    });
  }
  return out;
};

// The one-call bridge to the ranker: return NEW candidate objects with the three
// derived fields populated from the graph, ready to hand to selectNextCases.
// Pure — never mutates the inputs. An explicit field already on a candidate is
// OVERWRITTEN by the derived value (the graph is the source of truth for these
// three; a caller that wants to override should do so after this call).
export const attachDependencyInputs = (cases = [], rows = [], { closeCaseIds = [], activeOnly = true } = {}) => {
  if (!Array.isArray(cases)) throw new Error('attachDependencyInputs: cases must be an array');
  const ids = cases.map((c) => (c && c.id !== undefined && c.id !== null ? String(c.id) : null)).filter(Boolean);
  const derived = deriveSelectorDependencyInputs(rows, ids, { closeCaseIds, activeOnly });
  return cases.map((c) => {
    const d = (c && c.id != null) ? derived.get(String(c.id)) : null;
    return d ? { ...c, ...d } : { ...c };
  });
};
