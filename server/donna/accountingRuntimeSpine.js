// Donna — accounting runtime spine reconciliation (Accounting Runtime Hardening, Slice B).
//
// THE PROBLEM THIS MODULE EXISTS TO PREVENT (plan §2, the decision the rest of
// the arc hangs on): the tree already carries TWO partially-built spines —
//
//   1. the operator-contract substrate (migration 034: proposal_cards /
//      check_reports / apply_receipts, schemas in operatorContract.js,
//      persistence in proposalStore.js), and
//   2. the goal-first loop runtime (migration 037: loop_runs / loop_goal_reports,
//      loopRunEngine.js / loopGoalStore.js, the reconcileConvergenceState.js
//      read-collapse).
//
// They are UNRECONCILED — proposalStore.js and loopGoalStore.js do not reference
// each other. The "accounting runtime" must be the ASSEMBLY of these two, NOT a
// THIRD structure. Every downstream slice (snapshot v1, preflight v1, the
// consequence-diff engine, the proposal/receipt generalization) risks minting
// that forbidden third spine the moment it needs a "home" for a runtime concept
// and can't see that the home already exists. This module is the machine-checkable
// answer to "where does concept X live?" — exactly one home per concept, no
// duplicates, no third spine.
//
// Slice B is NEW FILES ONLY: no migration, no live-path edit, no behaviour change.
// It is a typed contract + its invariant test, the same shape Slice A took for the
// mutation inventory. Its value: the no-third-spine decision becomes a test that
// fails if a future slice invents a parallel home.
//
// Pure leaf: imports ONLY operatorContract.js and accountingMutationRegistry.js
// (the latter itself imports only operatorContract.js). It references the REAL
// exported schema objects by IDENTITY for the operator-contract-backed concepts —
// so the test proves no synonym was minted (the Phase-0 "reuse existing exported
// constants, do not mint synonyms" rule). The heavy homes (snapshot, authority
// grants, goal report, loop run, convergence projection) live in DB-backed modules
// that cannot import under in-sandbox `node --test`; the spine references them by a
// stable, grep-verified identifier ({ module, symbol, table, migration }) — each
// confirmed present in the running tree this session, NOT guessed (the lead lesson).

import {
  PROPOSAL_CARD_SCHEMA,
  CHECK_REPORT_SCHEMA,
  APPLY_RECEIPT_SCHEMA,
  REVIEW_MODES,
  OPERATOR_CONTRACT_INVARIANTS
} from './operatorContract.js';
import {
  ACCOUNTING_MUTATION_REGISTRY,
  KNOWN_WRITERS,
  accountingMutationVerbs
} from './accountingMutationRegistry.js';

// ── The closed spine vocabulary (the "no third spine" guard) ────────────────────
//
// Every concept's home belongs to exactly one of these four families. The first
// two are the real persisted spines; `shared` is a primitive that FEEDS both (it
// is not itself a spine — it has no apply path); `projection` is a pure read-only
// collapse with no table of its own. A home declaring any family OUTSIDE this set
// would BE the forbidden third spine — the test fails closed on it.
export const RUNTIME_SPINES = Object.freeze({
  operator_contract: 'Operator-contract substrate (migration 034): the proposal → check → receipt apply contract.',
  goal_first: 'Goal-first loop runtime (migration 037): bounded runs + the convergence verdict.',
  shared: 'A primitive that feeds BOTH spines (no apply path of its own).',
  projection: 'A pure read-only collapse (no table of its own).'
});

// The substrate migrations the spine is allowed to reference. Slice B mints NO new
// migration; a home pointing at a migration outside this set would mean a new
// backend snuck in (INV-1 violation at the schema layer).
export const KNOWN_SUBSTRATE_MIGRATIONS = Object.freeze(['034', '037', '040', '042']);

// The single invariant under which the registry's writers sit (operatorContract
// INV-1): "proposals route to existing named writers; the grammar is a router,
// never a second accounting backend." Slice A's KNOWN_WRITERS allowlist IS this
// invariant made data; the spine names the link so the test can pin it.
export const WRITERS_GOVERNING_INVARIANT = 'INV-1';

// ── The canonical runtime concepts (the rows of plan §2's table) ────────────────
//
// One key per box in the north-star loop (plan §1) that needs a persisted home.
// This list is the totality contract: the test asserts SPINE_MAP covers EXACTLY
// these — no concept without a home, no home without a concept.
export const RUNTIME_CONCEPTS = Object.freeze([
  'compressed_snapshot',
  'typed_proposal',
  'deterministic_checks',
  'authority_envelope',
  'consequence_diff',
  'convergence_verdict',
  'bounded_execution',
  'terminal_projection'
]);

// ── The reconciliation map: each concept → its ONE home ─────────────────────────
//
// `contractObject` is the ACTUAL imported operatorContract.js export (identity-
// checkable) for the concepts the operator-contract spine owns — that is how the
// test proves the spine reuses the real schema, not a re-declared synonym. For the
// heavy-module homes it is null and the home is named by { module, symbol, table }.
// `homeKey` is the deduplication identity: the persisted table, or the module#symbol
// for a tableless home. Two concepts sharing a homeKey would be a duplicate/third
// home — the test forbids it.
export const SPINE_MAP = Object.freeze([
  {
    concept: 'compressed_snapshot',
    spine: 'shared',
    module: 'operatorCaseSnapshot.js',
    symbol: 'getOperatorCaseSnapshot',
    table: null,                       // in-memory L1 read; identity is the snapshot_id it computes
    homeKey: 'operatorCaseSnapshot.js#snapshot_id',
    migration: null,
    contractObject: null,
    role: 'L1 read — the compressed bookkeeping case the model and the loop run both consume. Same snapshot feeds BOTH spines (plan §2), which is why it is `shared`, not owned by either.'
  },
  {
    concept: 'typed_proposal',
    spine: 'operator_contract',
    module: 'proposalStore.js',
    symbol: 'PROPOSAL_CARD_SCHEMA',
    table: 'proposal_cards',
    homeKey: 'proposal_cards',
    migration: '034',
    contractObject: PROPOSAL_CARD_SCHEMA,
    role: "The strong model's typed judgment, validated against the card schema before insert. Immutable once written."
  },
  {
    concept: 'deterministic_checks',
    spine: 'operator_contract',
    module: 'preflight.js + proposalStore.js',
    symbol: 'runDeterministicPreflight',
    table: 'check_reports',
    homeKey: 'check_reports',
    migration: '034',
    contractObject: CHECK_REPORT_SCHEMA,
    role: 'The Keep-layer deterministic preflight; its verdict persists as a CheckReport. Slice D extends preflight with accounting-domain checks; the home does not move.'
  },
  {
    concept: 'authority_envelope',
    spine: 'shared',
    module: 'reconciliationAuthorityGrants.js',
    symbol: 'findActiveAuthorityGrant',
    table: 'reconciliation_authority_grants',
    homeKey: 'reconciliation_authority_grants',
    migration: '040',
    contractObject: REVIEW_MODES,      // the vocabulary the envelope classifies INTO (reused, not re-declared)
    role: 'Durable, scoped, auto-suspend-on-correction grants (the #5 design). Classifies a proposal into a REVIEW_MODES envelope; never a per-row approval prompt. Feeds both spines (a grant can clear an operator-contract apply OR a goal-first run), so `shared`.'
  },
  {
    concept: 'consequence_diff',
    spine: 'operator_contract',
    module: 'proposalStore.js',
    symbol: 'APPLY_RECEIPT_SCHEMA',
    table: 'apply_receipts',
    homeKey: 'apply_receipts',
    migration: '034',
    contractObject: APPLY_RECEIPT_SCHEMA,
    role: 'The mandatory consequence diff — what an apply CHANGED and whether it is safe (rows_touched + per_target + checks + writer). An apply is NEVER "done"; it returns this receipt. Slice E fills the diff; the home is already here.',
    complementaryWith: 'convergence_verdict'
  },
  {
    concept: 'convergence_verdict',
    spine: 'goal_first',
    module: 'loopGoalStore.js',
    symbol: 'readLatestGoalReport',
    table: 'loop_goal_reports',
    homeKey: 'loop_goal_reports',
    migration: '037',
    contractObject: null,
    role: 'The GoalReport — did the CASE reach a terminal (auto_reconciled / on_owner / hanging). Append-only; surfaces render it by reading, never by re-inferring (the persisted-verdict rail).',
    complementaryWith: 'consequence_diff'
  },
  {
    concept: 'bounded_execution',
    spine: 'goal_first',
    module: 'loopRunEngine.js',
    symbol: 'runLoopWake',
    table: 'loop_runs',
    homeKey: 'loop_runs',
    migration: '037',
    contractObject: null,
    role: 'The LoopRun — one bounded, budgeted, single-flight wake with a persisted stop_reason. Where a runtime apply is autonomous, the orchestration IS this LoopRun (plan §2) — not a third executor.'
  },
  {
    concept: 'terminal_projection',
    spine: 'projection',
    module: 'reconcileConvergenceState.js',
    symbol: 'deriveConvergenceState',
    table: null,                       // pure projection; unknown state ⇒ hanging
    homeKey: 'reconcileConvergenceState.js#deriveConvergenceState',
    migration: null,
    contractObject: null,
    role: 'The terminal-state POLICY home — the two-terminal-states FIRST principle made code. Call it, never re-implement it. Unknown ⇒ hanging (never fake-terminal).'
  }
]);

// The complementary-not-competing pair (plan §2, uplift §4.3): the apply receipt
// answers "what did this apply change + is it safe", the GoalReport answers "did the
// case reach a terminal". They are LINKED, not redundant — a receipt's
// context_snapshot_id and a report's run share the same compressed snapshot. The
// test pins that both homes exist, differ, and reference each other.
export const COMPLEMENTARY_NOT_COMPETING = Object.freeze({
  receipt_concept: 'consequence_diff',
  verdict_concept: 'convergence_verdict',
  linked_via: 'context_snapshot_id',     // shared compressed_snapshot id
  competes: false
});

// ── Helpers ─────────────────────────────────────────────────────────────────────

export const spineEntryForConcept = (concept) =>
  SPINE_MAP.find((entry) => entry.concept === concept) || null;

export const conceptsForSpine = (spine) =>
  SPINE_MAP.filter((entry) => entry.spine === spine).map((entry) => entry.concept);

// The homeKey of every concept — the deduplication surface. If this list has any
// repeat, two concepts collapsed to one home (a duplicate) — a spine bug.
export const spineHomeKeys = () => SPINE_MAP.map((entry) => entry.homeKey);

// Totality check (data form of the test's first assertion): every canonical concept
// has exactly one home and the map carries no home for an unlisted concept.
export const spineReconciliationIsTotal = () => {
  const mapped = SPINE_MAP.map((entry) => entry.concept);
  const everyConceptHasOneHome = RUNTIME_CONCEPTS.every(
    (concept) => mapped.filter((c) => c === concept).length === 1
  );
  const noExtraHome = mapped.every((concept) => RUNTIME_CONCEPTS.includes(concept));
  const noDuplicateHome = new Set(spineHomeKeys()).size === SPINE_MAP.length;
  return everyConceptHasOneHome && noExtraHome && noDuplicateHome;
};

// INV-1 link: every writer the Slice A registry routes an ACCOUNTING mutation to is
// in the KNOWN_WRITERS allowlist — i.e. the grammar is a router onto existing named
// writers, never a second backend. That discipline IS WRITERS_GOVERNING_INVARIANT.
export const registryWritersSitUnderInv1 = () => {
  const writersOk = ACCOUNTING_MUTATION_REGISTRY.every((entry) =>
    KNOWN_WRITERS.includes(entry.writer)
  );
  const invExists = OPERATOR_CONTRACT_INVARIANTS.some(
    (inv) => inv.id === WRITERS_GOVERNING_INVARIANT
  );
  return writersOk && invExists && accountingMutationVerbs().length > 0;
};
