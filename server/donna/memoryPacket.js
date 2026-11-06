// Donna — memory packet v1 (accounting-runtime hardening, Slice H: receipt-only).
//
// The apply receipt's `facts_available` / `facts_used` / `facts_conflicted`
// fields (operatorContract.APPLY_RECEIPT_SCHEMA — the fields have existed since
// the contract landed, hardcoded empty until this slice) record WHICH firm
// memory was in reach when a chat apply was captured, and which of it the model
// says it relied on or contradicted. Telemetry and governance inputs ONLY —
// never a gate (contract §: "self-reported ⇒ telemetry"), and never a fuzzy
// text-match: facts are free-text sentences (firmFacts.js), so deriving
// used/conflicted by comparing text to the applied action would be exactly the
// intelligence-substituting classifier the #497 guard forbids. The rules here
// are set arithmetic on fact IDS:
//
//   facts_available — the ids the retrieval returned for the case (deterministic;
//                     the chat prompt hands the model these same ids via
//                     known_facts, transactionChat.js).
//   facts_used /    — the model's SELF-REPORT (emitted by the transaction- and
//   facts_conflicted  feed-chat contracts since Slice H's emission halves:
//                     ACTION_SCHEMA fields + the prompts' CITE YOUR MEMORY USE
//                     instruction; doc-chat has no known_facts channel, so its
//                     actions carry no report), sanitized to ids ∩ available:
//                     a claimed id the retrieval never surfaced is DROPPED
//                     (hallucination guard), and an id claimed both ways
//                     counts once, as conflicted (the stronger, more
//                     actionable claim). No self-report ⇒ both stay [] —
//                     honestly empty, never inferred. On the feed leg,
//                     "available" is the mint-time payload.facts_available
//                     stamp (ONE batch-level packet — the prompt is one
//                     context for the whole turn, so per-target attribution
//                     would be fabricated).
//
// Pure leaf: no DB, no env reads beyond the injected config helpers. The
// retrieval itself is firmFacts.getFirmFactsForTransactionCase (ONE retrieval
// home); the per-client gate is MEMORY_PACKET_RECEIPTS through the config
// plane, mirroring LOOPS_SHADOW_RISK_CONTEXT's observe-only dual exactly.

import { clientFlagObserves } from './clientConfig.js';

// Per-client gate for the shadow capture's memory enrichment (config plane,
// migration 042). OBSERVE-only — the facts read feeds a SHADOW receipt and
// never touches live state — so it gates on the stageObserves dual
// (shadow/canary/auto observe; off/dry_run do not), NOT stageActs. Default
// (no row) is observe via the env fallback, matching the risk-context gate:
// the enrichment is inert until LOOPS_SHADOW is on anyway, and a client can
// be staged off through the plane. CLIENT_CONFIG_FORCE_DISABLE kills it
// fleet-wide, like every plane flag.
export const MEMORY_PACKET_FLAG_KEY = 'MEMORY_PACKET_RECEIPTS';

export const memoryPacketObserves = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagObserves({ flagKey: MEMORY_PACKET_FLAG_KEY, snapshot, envFallback: () => true, env });

const sanitizeIdList = (value) => {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry.trim() : (entry && typeof entry.id === 'string' ? entry.id.trim() : '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

// facts: the rows getFirmFactsForTransactionCase returned (array — possibly
// empty, a REAL "no facts known" signal), or null/undefined when nothing was
// loaded (gate off, read soft-failed, surface not wired) — null ⇒ null packet,
// so the receipt keeps its bare [] fields and a governance reader can tell
// "no memory recorded" from "memory recorded: none known".
// selfReport: { used, conflicted } — id arrays the model claimed (emitted by
// the transaction- and feed-chat contracts; doc-chat passes none, stays null).
export const buildMemoryPacket = ({ facts = null, selfReport = null } = {}) => {
  if (!Array.isArray(facts)) return null;
  const available = sanitizeIdList(facts);
  const availableSet = new Set(available);
  const claimedConflicted = sanitizeIdList(selfReport?.conflicted).filter((id) => availableSet.has(id));
  const conflictedSet = new Set(claimedConflicted);
  const claimedUsed = sanitizeIdList(selfReport?.used)
    .filter((id) => availableSet.has(id) && !conflictedSet.has(id));
  return {
    facts_available: available,
    facts_used: claimedUsed,
    facts_conflicted: claimedConflicted
  };
};

// The self-report fields the transaction- and feed-chat contracts carry on
// the persisted assistant ACTION (read defensively — a surface without the
// fields, e.g. doc-chat, or a pre-emission persisted action is no report;
// a non-array is no report). Named here so the hooks and the contracts
// share one vocabulary instead of ad-hoc field names drifting apart.
export const selfReportFromAction = (action = {}) => {
  const used = Array.isArray(action?.facts_used) ? action.facts_used : null;
  const conflicted = Array.isArray(action?.facts_conflicted) ? action.facts_conflicted : null;
  if (!used && !conflicted) return null;
  return { used: used || [], conflicted: conflicted || [] };
};
