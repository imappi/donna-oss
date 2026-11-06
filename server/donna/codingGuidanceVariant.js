// FIK-2: the ONE reader of the coding decision-guidance variant. Call owners
// that already hold the client's strict config snapshot pass its answer to
// resolveCodingPolicy, which stays flag-free. Every other resolve site inherits
// the variant from the policy those owners stamp (requireCodingPolicyForClient).
//
// FI_JEV_DECISION_GUIDANCE (plan-2026-09-22-fi-jev-decision-knowledge.md §8,
// FIK-4) selects the reviewed Finnish guidance ("v8") over the authored one
// ("v7"). Off for every client; staging it is FIK-4's canary decision. Only a
// definition with reviewed guidance honours it, so no other market changes.
import { clientFlagActs } from './clientConfig.js';

export const FI_JEV_DECISION_GUIDANCE_FLAG = 'FI_JEV_DECISION_GUIDANCE';

export const codingGuidanceVariantForSnapshot = (snapshot) =>
  (clientFlagActs({ flagKey: FI_JEV_DECISION_GUIDANCE_FLAG, snapshot, envFallback: () => false }) ? 'reviewed' : null);
