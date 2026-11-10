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

// ── The provider endpoints a provider-agnostic lane calls ─────────────────
// Strings, not calls: the lane module hands them to llmCall. They live here
// (the host registry, exempt from the provider-URL ratchet because it makes
// no call) so the shared request shaping in structuredRequest.js names no
// host of its own. `ANTHROPIC_API_VERSION` is the Messages API version the
// moved text lanes send (2026-10-21: no sampling parameters, which none of
// these requests carry).
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_API_VERSION = '2026-10-21';

export const LANE_PROVIDER_KEY_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY'
});

// The strong defaults of the text lanes moved onto both providers by the
// owner's decision of 2026-11-10 (Donna runs on Claude only; OpenAI stays a
// qualified alternative that runs only when no Anthropic key is present).
// Each lane's model-id env knob may still pin another id.
export const TEXT_LANE_DEFAULT_MODELS = Object.freeze({
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.4'
});

// Which provider a model id belongs to, from its family prefix. null when
// the id says nothing (a Qwen id, a typo) — the caller then falls through
// to key presence.
export const inferProviderFromModel = (model) => {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return null;
  if (id.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o\d|chatgpt)/.test(id)) return 'openai';
  return null;
};

// A process env with a parsed .env file under it: a value set (non-blank) in
// the process wins, the file fills the rest — the same `process.env.X ||
// dotEnv.X` rule every lane module applied key by key.
export const envWithDotEnvFallback = (env = process.env, dotEnv = {}) => {
  const merged = { ...(dotEnv || {}) };
  for (const [name, value] of Object.entries(env || {})) {
    if (value != null && String(value) !== '') merged[name] = value;
  }
  return merged;
};

// ── THE lane provider resolver (one owner, RT-12's rule generalised) ──────
// Which provider answers a lane's call, and with which model. Order of
// authority: an explicit `provider` argument, then the lane's provider env
// pin (when it has one), then the provider a pinned model id belongs to,
// then KEY PRESENCE in the registry's preference order (`providers`). The
// model is the explicit argument, else the first set model env knob (only
// when it belongs to the resolved provider — a claude id never goes to
// OpenAI), else the provider's strong default. Every choice is receipted
// (`source`) so a silent downgrade is readable from the data. The model id
// a RECEIPT carries is still the response's; this is only what is asked for.
export const resolveLaneProvider = ({
  providers,
  defaultModels,
  providerEnvKey = null,
  modelEnvKeys = [],
  env = process.env,
  provider = null,
  model = null,
  keys = null
} = {}) => {
  const order = Array.isArray(providers) ? providers : [];
  const keyFor = (name) => String((keys && name in keys ? keys[name] : env?.[LANE_PROVIDER_KEY_ENV[name]]) || '').trim();
  const envProvider = providerEnvKey ? String(env?.[providerEnvKey] || '').trim().toLowerCase() : '';
  const envModel = (modelEnvKeys || []).map((name) => String(env?.[name] || '').trim()).find(Boolean) || '';
  const requestedModel = String(model || '').trim() || null;

  let chosen = null;
  let providerSource = null;
  if (provider) { chosen = String(provider).trim().toLowerCase(); providerSource = 'param'; }
  else if (envProvider) { chosen = envProvider; providerSource = 'env'; }
  else if (inferProviderFromModel(requestedModel || envModel)) {
    chosen = inferProviderFromModel(requestedModel || envModel);
    providerSource = 'model_id';
  } else {
    chosen = order.find((name) => keyFor(name)) || null;
    providerSource = 'key_presence';
  }
  if (!chosen) return { ok: false, provider: null, model: null, apiKey: '', reason: 'no_provider_key', source: { provider: providerSource, model: null } };
  if (!order.includes(chosen)) {
    return { ok: false, provider: chosen, model: null, apiKey: '', reason: `unknown_provider:${chosen}`, source: { provider: providerSource, model: null } };
  }
  const apiKey = keyFor(chosen);
  if (!apiKey) {
    return { ok: false, provider: chosen, model: null, apiKey: '', reason: `no_provider_key:${chosen}`, source: { provider: providerSource, model: null } };
  }
  let resolvedModel = defaultModels?.[chosen] || null;
  let modelSource = 'default';
  if (requestedModel) { resolvedModel = requestedModel; modelSource = 'param'; }
  else if (envModel) {
    const belongsTo = inferProviderFromModel(envModel);
    if (!belongsTo || belongsTo === chosen) { resolvedModel = envModel; modelSource = 'env'; }
    else modelSource = 'default_env_model_other_provider';
  }
  return { ok: true, provider: chosen, model: resolvedModel, apiKey, reason: null, source: { provider: providerSource, model: modelSource } };
};

// The text lanes' resolver (2026-11-10): resolveLaneProvider with the text
// lanes' strong defaults, the lane's own model knob(s) (OPENAI_MODEL is the
// existing knob on most of them — it may pin a claude-* id too) and the
// module's .env fallback. An explicit `openAiConfig` — the seam those lanes'
// callers and tests already pass — is an explicit provider argument: it
// pins OpenAI with exactly that key and model.
export const resolveTextLaneProvider = ({
  providers,
  openAiDefaultModel = TEXT_LANE_DEFAULT_MODELS.openai,
  anthropicDefaultModel = TEXT_LANE_DEFAULT_MODELS.anthropic,
  modelEnvKeys = ['OPENAI_MODEL'],
  env = process.env,
  dotEnv = {},
  openAiConfig = null,
  provider = null,
  model = null
} = {}) => {
  if (openAiConfig) {
    const apiKey = String(openAiConfig.apiKey || '').trim();
    const pinned = String(openAiConfig.model || '').trim();
    const source = { provider: 'param', model: pinned ? 'param' : 'default' };
    return apiKey
      ? { ok: true, provider: 'openai', model: pinned || openAiDefaultModel, apiKey, reason: null, source }
      : { ok: false, provider: 'openai', model: null, apiKey: '', reason: 'no_provider_key:openai', source };
  }
  return resolveLaneProvider({
    providers,
    defaultModels: { anthropic: anthropicDefaultModel, openai: openAiDefaultModel },
    modelEnvKeys,
    env: envWithDotEnvFallback(env, dotEnv),
    provider,
    model
  });
};

// The env key a resolution that found no key should name: the resolved
// provider's, or — when no provider was chosen at all — the lane's first.
export const missingKeyNameFor = (resolved, providers = []) => {
  const name = resolved?.provider || providers[0] || null;
  return { provider: name, keyName: LANE_PROVIDER_KEY_ENV[name] || null };
};
