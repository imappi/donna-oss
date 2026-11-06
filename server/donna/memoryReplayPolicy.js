// Donna — BizOS 2c-iii producer: the DETERMINISTIC replay policy
// (design-donna-bizos-slice-2c-iii-replay-producer.md §3, §7).
//
// The honest division the review forced (and the CLAUDE.md L1 doctrine): the strong
// model returns BOUNDED semantic judgments (equivalence, purpose-fit, whether a fact
// is materially reflected in the answer); DETERMINISTIC policy here maps those
// judgments + SYSTEM RECEIPTS (authorization decision, governed-exclusion reason) to
// the gate's DIFF_CATEGORIES. The model never establishes authorization, governance
// eligibility, or the final gate category. Missing evidence, an unsupported model,
// invalid output, low confidence, or uncertainty → `unclassified` → the gate BLOCKS.
//
// Pure leaf: no DB, no model. Imports the gate's category vocabulary + synthetic
// suite so producer and gate share ONE definition (the review's "shared pure policy
// module") without the gate depending on the producer.

import {
  DIFF_CATEGORIES,
  classifyDiffItem,
  runSyntheticAdversarialSuite
} from './memoryRetrievalReplayGate.js';

// Re-exported so the producer has a single policy surface (the gate stays the home).
export { DIFF_CATEGORIES, classifyDiffItem, runSyntheticAdversarialSuite };

export const UNCLASSIFIED = 'unclassified';

// A model judgment below this is not assertable → unclassified (fail closed). Self-
// reported confidence is necessary, NOT sufficient — valid evidence spans + a
// recognised enum value are also required (see judgmentAssertable).
export const MIN_ASSERTABLE_CONFIDENCE = 0.85;

// The ONLY governed-exclusion reasons that make a drop `expected_governed_drop` —
// an allowlist of DETERMINISTIC reasons the service itself emits (never model prose).
// Aligned with memoryRetrieval.js reason codes + the governed-drop taxonomy (§3).
export const GOVERNED_DROP_REASONS = Object.freeze(new Set([
  'stale', 'stale_review_after', 'low_truth_confidence', 'low_confidence',
  'unverified_assertion', 'sensitive', 'conflicted', 'purpose_inappropriate',
  'section_not_permitted', 'confirmation_required', 'use_deny', 'budget', 'item_too_large'
]));

// A judgment is assertable only if structurally valid: a recognised relation, a
// confidence over the floor, and at least one evidence span. Bad/low/missing → false.
export const judgmentAssertable = (judgment) => {
  if (!judgment || typeof judgment !== 'object') return false;
  const relations = new Set(['equivalent', 'changed', 'distinct', 'uncertain']);
  const uses = new Set(['materially_reflected', 'not_materially_reflected', 'uncertain']);
  const fits = new Set(['in_scope', 'out_of_scope', 'uncertain']);
  if (!relations.has(judgment.semantic_relation)) return false;
  if (!uses.has(judgment.answer_material_use)) return false;
  if (!fits.has(judgment.purpose_fit)) return false;
  if (typeof judgment.confidence !== 'number' || judgment.confidence < MIN_ASSERTABLE_CONFIDENCE) return false;
  if (!Array.isArray(judgment.evidence) || judgment.evidence.length === 0) return false;
  return true;
};

// ── The deterministic map: (diff item + system receipts + model judgment) → category ─
//
// item: { kind: 'add' | 'drop' | 'matched', memory_id, ... }
// receipts: {
//   authorization: 'allow' | 'deny' | null,   // the SERVICE'S shadow-time decision (adds)
//   governedReason: <string> | null           // the deterministic exclusion reason (drops)
// }
// judgment: the model's bounded judgment (memret.diff.judgment.v1) or null.
export const deriveDiffCategory = ({ item = {}, receipts = {}, judgment = null } = {}) => {
  const assertable = judgmentAssertable(judgment);

  if (item.kind === 'add') {
    // Authorization is a POLICY result, never model prose. A deny receipt blocks; the
    // ABSENCE of a historical authorization receipt is unclassified (never "probably
    // authorised" — the §6 correction).
    if (receipts.authorization === 'deny') return 'unauthorised_add';
    if (receipts.authorization !== 'allow') return UNCLASSIFIED;
    if (!assertable) return UNCLASSIFIED;
    if (judgment.purpose_fit === 'out_of_scope') return 'unauthorised_add';
    if (judgment.purpose_fit === 'in_scope') return 'expected_authorised_add';
    return UNCLASSIFIED; // purpose_fit uncertain
  }

  if (item.kind === 'drop') {
    // A drop the answer MATERIALLY reflected is critical — even if the governance drop
    // was otherwise legitimate. Uncertainty about material use blocks.
    if (!assertable) return UNCLASSIFIED;
    if (judgment.answer_material_use === 'materially_reflected') return 'unexpected_critical_drop';
    if (judgment.answer_material_use !== 'not_materially_reflected') return UNCLASSIFIED;
    if (receipts.governedReason && GOVERNED_DROP_REASONS.has(receipts.governedReason)) return 'expected_governed_drop';
    return UNCLASSIFIED;
  }

  if (item.kind === 'matched') {
    // Same paired fact both sides. Equivalence must PRESERVE negation / uncertainty /
    // temporal / epistemic (the model asserts 'equivalent'); anything else is a real
    // change → not a benign ranking/rendering diff, so unclassified (blocks) unless it
    // was already decomposed into drop+add upstream.
    if (!assertable) return UNCLASSIFIED;
    if (judgment.semantic_relation !== 'equivalent') return UNCLASSIFIED;
    if (item.rendered_changed) return 'rendering_only';
    if (item.position_changed) return 'ranking_only';
    return 'ranking_only'; // equivalent + no observable change → treat as ranking-only (non-blocking)
  }

  return UNCLASSIFIED;
};

// ── Artifact freshness fields (§17) ─────────────────────────────────────────────
export const DEFAULT_ARTIFACT_TTL_DAYS = 7;

// generated_at + expires_at, computed from an INJECTED clock (never Date.now() in a
// pure fn). The gate enforces `now <= expires_at` with the lever's trusted clock.
export const buildArtifactFreshness = ({ generatedAt, ttlDays = DEFAULT_ARTIFACT_TTL_DAYS } = {}) => {
  const genMs = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(genMs)) return { generated_at: null, expires_at: null };
  return {
    generated_at: new Date(genMs).toISOString(),
    expires_at: new Date(genMs + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000).toISOString()
  };
};
