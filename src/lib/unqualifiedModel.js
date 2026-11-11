// The unqualified-local-model marker's one predicate (2026-11-10, the
// owner's decision: a self-hosted model may decide for one company, labelled
// for what it is — server/donna/modelLanes.js SELF_HOSTED_DECISION).
//
// Rendering only: it reads the PERSISTED policy basis a decision carries
// (`policy_basis` on the decision, or on its payload) — never a re-inference.
// The basis string is the server's (modelLanes.js SELF_HOSTED_BASIS), restated
// here because the browser bundle does not import server modules.
export const UNQUALIFIED_LOCAL_BASIS = 'self_hosted_unqualified';

export const policyBasisOf = (decision) => {
  if (typeof decision === 'string') return decision;
  if (!decision || typeof decision !== 'object') return null;
  return decision.policy_basis ?? decision.payload?.policy_basis ?? null;
};

export const isUnqualifiedLocalDecision = (decision) => policyBasisOf(decision) === UNQUALIFIED_LOCAL_BASIS;
