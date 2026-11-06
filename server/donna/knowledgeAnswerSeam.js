// Donna — K1-5 wiring: the ANSWER SEAM (design-donna-knowledge-base.md §10, §15).
//
// This is the single module that joins K1's retrieval (K1-4) and answer contract
// (K1-5) to an owner surface. Everything upstream of it is pure and uncalled;
// this is the first module that an owner-facing assembler imports to actually get
// a grounded answer. It follows `ownerMemorySeam.js` exactly: a flag-gated seam
// that the turn assembler calls with a DB client it already holds, returning a
// plain result the surface renders — never opening its own connection, never
// posting, never throwing into the owner turn.
//
// ── WHY THIS IMPORTS THE STRATEGY DIRECTLY, NOT THE REGISTRY ─────────────────
//
// §9's rail is "all retrieval through the governed contract with registered
// strategies", and K1's strategy IS registered (`knowledge.retrieve.v1`,
// knowledgeCapabilityPack.js) for governance, eval and telemetry. But the
// runtime INVOCATION imports the strategy function directly — the same pattern
// `ownerMemorySeam.js` uses for `memory.retrieve.v2` (it imports `buildMemory
// bundle` from memoryRetrieval.js, not the registry). This is deliberate and
// load-bearing: the capability REGISTRY is imported by the accounting-system
// adapters, which reach the ledger writers, so routing the call through the
// registry would drag a K1 read onto a posting path and trip §2's GROUND-vs-
// GOVERN boundary. The pack names its executor as a STRING for exactly this
// reason. So this seam imports only the four pure K1 modules (retrieval, answer,
// fact-resolution) + nothing that writes — and knowledgeRetrievalBoundary.test.js
// (rewritten as an allowlist under §15) asserts that this seam, and every K1
// ground module, forward-reaches NO ledger writer.
//
// ── WHAT IT PRODUCES TODAY ──────────────────────────────────────────────────
//
// Flag off (`KNOWLEDGE_BASE_RETRIEVAL`, born off) ⇒ returns null and the owner
// turn is byte-identical to before. Flag on with an EMPTY corpus ⇒ every answer
// is the deterministic outcome 4 (refusal) — honest and free, exactly as §6
// intends. Outcomes 1/2 (a composed, grounded answer) additionally need (a) a
// curated corpus, blocked on the network-open curation session, and (b) a
// `compose` function — the strong-model call that writes the prose under the
// floor-as-ceiling rule. `compose` is an injected dep here (default null), so the
// model call is wired in a follow-up without touching this boundary. Until both
// land, an owner cannot get a GROUNDED answer, and launch row 12 stays at 12.

import {
  retrieveKnowledge,
  knowledgeBaseRetrievalActs,
  KNOWLEDGE_RETRIEVAL_CAPABILITY_ID
} from './knowledgeRetrieval.js';
import { knowledgeCandidateLoader } from './knowledgeRetrievalDb.js';
import { answerKnowledgeQuestion } from './knowledgeAnswer.js';
import { resolveKnowledgeFacts, KNOWLEDGE_FACT_PROBE_VARIABLES } from './knowledgeFactResolution.js';

// Which purpose + consumer + audience each surface presents. The purpose registry
// (knowledgeRetrieval.js PURPOSE_DEFINITIONS) already enumerates these consumers;
// a surface not listed here cannot ground, which is the point.
const SURFACE_LANES = Object.freeze({
  client_portal: Object.freeze({
    purpose_id: 'owner_knowledge_answer',
    consumer_capability_id: 'clientPortalChatContext',
    audience_class: 'owner'
  }),
  owner_channel: Object.freeze({
    purpose_id: 'owner_knowledge_answer',
    consumer_capability_id: 'ownerChannelKnowledgeContext',
    audience_class: 'owner'
  })
});

export const knowledgeAnswerSeamSurfaces = () => Object.keys(SURFACE_LANES);

// buildKnowledgeGrounding — resolve the owner's question against K1, or return
// null. NEVER throws: a grounding failure must degrade the owner turn to its
// legacy (ungrounded) shape, never break it — the ownerMemorySeam / selfKnowledge
// posture. Returns { outcome, answer, retrieval_status, receipt } on success.
export const buildKnowledgeGrounding = async ({
  client,
  clientId = null,
  clientProfile = null,
  questionText = '',
  topics = [],
  decisionDate = null,
  occurredAt = null,
  sourceEventId = null,
  modelId = null,
  configSnapshot = null,
  configSnapshotId = null,
  openAsks = [],
  surface = 'client_portal',
  env = process.env,
  deps = {}
} = {}) => {
  try {
    const lane = SURFACE_LANES[surface];
    if (!lane) return null;

    // The whole seam is a no-op unless the flag acts. Checked here so that with
    // the flag off we do not even build a request — byte-identical legacy turn.
    if (!knowledgeBaseRetrievalActs({ snapshot: configSnapshot, env })) return null;

    // A question with no words to match is not a knowledge query; skip silently
    // rather than spend a retrieval on it.
    const question = String(questionText || '').trim();
    if (!question) return null;

    const nowIso = occurredAt
      ? (occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt))
      : new Date().toISOString();

    const trustedContext = {
      // legal_entity is server-resolved from the client row (§9) — jurisdiction is
      // NOT a caller claim. clientProfile came from getClientChatProfileFromDb.
      legal_entity: {
        client_id: clientId,
        jurisdiction: clientProfile?.jurisdiction ?? null
      },
      resolved_audience: { audience_class: lane.audience_class },
      consumer_capability_id: lane.consumer_capability_id,
      source_event_id: sourceEventId,
      occurred_at: nowIso,
      // The ANSWERING model — recorded, never inferred (CLAUDE.md). null until the
      // compose call is wired, which is honest: no model answered yet.
      model_id: modelId,
      config_snapshot: configSnapshot,
      config_snapshot_id: configSnapshotId
    };

    const request = {
      purpose_id: lane.purpose_id,
      question_text: question,
      topics: Array.isArray(topics) ? topics : [],
      decision_date: decisionDate
    };

    // Resolve-before-asking (§6, outcome 2): pre-resolve the business-fact
    // variables from what the turn already holds, so the answer never asks a
    // question the data answers. Pure; failing open to asking.
    let resolution = null;
    try {
      resolution = resolveKnowledgeFacts({
        variables: KNOWLEDGE_FACT_PROBE_VARIABLES,
        context: { client: clientProfile || {} },
        openAsks: Array.isArray(openAsks) ? openAsks : []
      });
    } catch {
      resolution = null;
    }

    const loadKnowledgeCandidates = typeof deps.loadKnowledgeCandidates === 'function'
      ? deps.loadKnowledgeCandidates
      : knowledgeCandidateLoader(client);

    const retrieval = await retrieveKnowledge({
      trustedContext,
      request,
      deps: { loadKnowledgeCandidates, env }
    });

    const answer = await answerKnowledgeQuestion({
      retrieval,
      // The strong-model composition call. Injected so it can be wired without
      // touching this seam or the boundary; null ⇒ only the deterministic
      // outcomes (3 refusal-with-adjacent, 4 refusal) render, with no model call.
      compose: typeof deps.compose === 'function' ? deps.compose : null,
      resolution,
      citationStyle: 'compact',
      composedBy: modelId
    });

    return {
      capability: KNOWLEDGE_RETRIEVAL_CAPABILITY_ID,
      surface,
      outcome: answer?.outcome ?? null,
      retrieval_status: retrieval?.status ?? null,
      answer,
      receipt: answer?.receipt ?? null
    };
  } catch (err) {
    // Fail-safe to null — the caller (assembleClientPortalTurn) also wraps this in
    // a catch, but the seam owns its own failure so a K1 bug can never surface as
    // a broken owner turn.
    console.warn('[knowledge-seam] grounding failed (fail-safe to none)', err?.message || err);
    return null;
  }
};
