// Donna — the provider-adapter seam, slice Q1 (descent ladder).
//
// Spec: docs/design-donna-qwen-descent-ladder.md §2. Q1 delivers the seam's
// REGISTRY half only: endpoint classes, the known-host list that feeds the
// provider-URL lint ratchet, and the model-provenance classifier the two
// source-of-truth response sites stamp with. Request shaping and key
// resolution arrive with their first consumer (Q3/Q4) — building transport
// nobody calls would be speculative scaffolding.
//
// VOCABULARY SYNC, NOT IMPORT. The provenance values are the same three the
// EAW receipts use (`MODEL_PROVENANCE_CLASSIFICATIONS` in
// world/traceReceipts.js), but the world boundary forbids production modules
// importing world/ (`world_must_only_enter_through_runner`,
// worldBoundary.test.js) — so the values are restated here and
// providerEndpoints.test.js asserts value-level equality with the world
// module. One vocabulary, machine-checked, no boundary breach.
//
// Note on llmCall.js: its telemetry carries its own two-value
// `model_source` ('response' | 'request'). Migrating the envelope onto this
// three-value vocabulary is a deliberate later change, not a Q1 side effect
// — the envelope's telemetry shape has its own consumers.

// The four endpoint classes of the descent ladder (spec §2.2).
// `openai_compatible` (the Qwen-class rung) and `local` share the OpenAI
// chat/completions request schema and differ only in policy metadata
// (network egress, disclosure, cost ownership) — which is why they are two
// CLASSES, not one class with a flag.
export const ENDPOINT_CLASSES = Object.freeze([
  'typesafe',
  'anthropic',
  'openai',
  'openai_compatible',
  'local'
]);

// Same values as world/traceReceipts.js MODEL_PROVENANCE_CLASSIFICATIONS —
// sync pinned by test (see header).
export const MODEL_PROVENANCE = Object.freeze({
  LEGACY_UNPROVEN: 'legacy_unproven',
  RESPONSE_PROVEN: 'response_proven',
  CONFIGURED_FALLBACK: 'configured_fallback'
});

// Every provider host the tree is allowed to call. This list FEEDS the
// anti-fragmentation lint in llmCall.test.js (`providerUrlLintPattern`), so
// adding a host here automatically extends the ratchet's reach — the
// mechanism the spec requires so the lint cannot go blind on an
// OpenAI-compatible base URL introduced later (spec §1.4). An
// `openai_compatible` host (DashScope etc.) is added HERE in the same PR
// that wires it (Q3), never as a bare URL in a call site.
export const KNOWN_PROVIDER_HOSTS = Object.freeze([
  Object.freeze({ host: 'api.typesafe.ai', endpointClass: 'typesafe' }),
  Object.freeze({ host: 'api.openai.com', endpointClass: 'openai' }),
  Object.freeze({ host: 'api.anthropic.com', endpointClass: 'anthropic' }),
  // §9.5 DECIDED (Kari, 2026-08-12): the openai_compatible challenger host
  // is Together AI with zero-data-retention enabled on the account; first
  // candidate artifact is the open-weight Qwen/Qwen3.5-397B-A17B (env
  // OPENAI_COMPATIBLE_MODEL — an eval-specific reason may argue another
  // Qwen artifact). Data-terms call, not a benchmark call; the §7
  // disclosure copy names the provider in the same PR as this entry.
  Object.freeze({ host: 'api.together.xyz', endpointClass: 'openai_compatible' })
]);

// The lint pattern, derived from the registry. `hosts` is injectable so the
// derivation mechanism itself is testable with a hypothetical added host.
export const providerUrlLintPattern = (hosts = KNOWN_PROVIDER_HOSTS) =>
  new RegExp(hosts.map(({ host }) => host.replace(/\./g, '\\.')).join('|'));

// ── The openai_compatible endpoint (Q3, host-agnostic half) ─────────────
// The descent ladder's first rung: any host serving the OpenAI
// chat/completions schema against a configurable base URL (DashScope,
// Together, Fireworks, and later the LOCAL endpoint — same schema, its own
// class). Q3's host-agnostic half: resolution + request shaping, BYOK env
// pair, fail-loud when unconfigured. The CONCRETE host is Kari's §9.5
// data-terms call — when made, the host joins KNOWN_PROVIDER_HOSTS (which
// extends the lint ratchet automatically) and the §7 disclosure copy names
// it, in that same PR.
//
// The env pair rides the narrow provider-key channel (server/index.js
// only-where-unset copies + desktop/providerKeyDotEnv.js) — secrets and
// endpoints are legitimate env per the flags rail; BEHAVIOR gates stay on
// the config plane (MODEL_CHALLENGER).
export const OPENAI_COMPATIBLE_ENV_KEYS = Object.freeze({
  apiKey: 'OPENAI_COMPATIBLE_API_KEY',
  baseUrl: 'OPENAI_COMPATIBLE_BASE_URL'
});

// Fail-loud resolution: an unconfigured endpoint is a typed refusal, never
// a silent default host (there IS no default — the host is a data-governance
// decision, not a fallback).
export const resolveOpenAiCompatibleEndpoint = ({ env = process.env } = {}) => {
  const baseUrl = String(env[OPENAI_COMPATIBLE_ENV_KEYS.baseUrl] || '').trim();
  const apiKey = String(env[OPENAI_COMPATIBLE_ENV_KEYS.apiKey] || '').trim();
  if (!baseUrl || !apiKey) {
    throw Object.assign(
      new Error(
        `openai_compatible endpoint is not configured — set ${OPENAI_COMPATIBLE_ENV_KEYS.baseUrl} and `
        + `${OPENAI_COMPATIBLE_ENV_KEYS.apiKey} (there is deliberately no default host; the host choice is `
        + 'a data-terms decision, spec §9.5)'
      ),
      { code: 'OPENAI_COMPATIBLE_NOT_CONFIGURED' }
    );
  }
  return {
    endpointClass: 'openai_compatible',
    url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    }
  };
};

// OpenAI chat/completions body from the protocol-neutral call shape. The
// system prompt travels as the first message (the compatible schema has no
// top-level system field).
export const shapeOpenAiCompatibleRequest = ({
  model,
  system = null,
  messages = [],
  maxTokens = null,
  temperature = null
} = {}) => {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages
    ]
  };
  if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
  if (Number.isFinite(temperature)) body.temperature = temperature;
  return body;
};

// The provenance classifier for provider-response sites: given what the
// provider RESPONSE named and what the request asked for, return the model
// id that actually governs plus which branch supplied it. Same
// non-empty-string test as llmCall.js rail 5 — a non-string or empty
// response model is treated as absent, never trusted.
//
// `response_proven`      — the provider's response named the model; that id
//                          is the receipt.
// `configured_fallback`  — the response omitted a model id; the requested
//                          (configured) string is all we can claim, and the
//                          receipt says so. This is the branch a silent
//                          env-override downgrade hides in.
// (`legacy_unproven` is never RETURNED here — it exists for receipts
// written before any classification ran, so old rows stay distinguishable
// from a genuine fallback.)
export const classifyModelProvenance = ({ responseModel, requestedModel } = {}) => {
  const served = typeof responseModel === 'string' && responseModel ? responseModel : null;
  if (served) return { model: served, model_source: MODEL_PROVENANCE.RESPONSE_PROVEN };
  const requested = typeof requestedModel === 'string' && requestedModel ? requestedModel : null;
  return { model: requested, model_source: MODEL_PROVENANCE.CONFIGURED_FALLBACK };
};

// Exact endpoints accepted by the cloud transport evidence producer.
export const CLOUD_VERIFIABLE_PROVIDER_ENDPOINTS = Object.freeze({
  'https://api.openai.com/v1/responses': 'openai',
  'https://api.openai.com/v1/chat/completions': 'openai',
  'https://api.anthropic.com/v1/messages': 'anthropic'
});
