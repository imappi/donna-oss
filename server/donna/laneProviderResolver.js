// Donna — which provider answers a lane's call, and with which model.
//
// ONE resolver for every provider-agnostic lane. It is the unified
// extractor's resolver (RT-12, `resolveUnifiedProvider`) lifted out
// unchanged so the document lanes that moved off a single provider
// (2026-11-10, the owner's decision that Donna runs on Claude: an
// installation holding only an Anthropic key must read every document)
// resolve the same way instead of each growing its own copy.
//
// Order of authority:
//   1. an explicit `provider` argument (tests, eval scripts);
//   2. the lane's provider pin in the environment, when the lane has one;
//   3. the provider a pinned model id belongs to — an explicit `model`
//      argument, else the lane's own model knob(s) — so a claude id never
//      goes to OpenAI and a gpt id never goes to Anthropic;
//   4. KEY PRESENCE, in the lane's `providers` order from modelLanes.js
//      (the registry is the one place a lane's preference is written).
// The model is the explicit argument, else the lane's model knob when it
// belongs to the chosen provider, else that provider's own model knob (a
// provider-wide knob such as OPENAI_MODEL tunes the model on that provider
// and never pins the provider), else the lane's default for the provider.
//
// Every choice is receipted (`source`) so a silent downgrade is readable
// from the data. The model id that lands on a decision receipt is still the
// one the provider's RESPONSE names; this resolves what is REQUESTED.

import { getLane } from './modelLanes.js';

export const PROVIDER_KEY_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY'
});

export const inferProviderFromModel = (model) => {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return null;
  if (id.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o\d|chatgpt)/.test(id)) return 'openai';
  return null;
};

const firstNonEmpty = (env, keys) => {
  for (const key of keys || []) {
    const value = String(env?.[key] || '').trim();
    if (value) return value;
  }
  return '';
};

export const resolveLaneProvider = ({
  laneId,
  env = process.env,
  provider = null,
  model = null,
  keys = null,
  // Optional per-lane provider pin (the unified extractor's
  // UNIFIED_EXTRACTOR_PROVIDER). Lanes without one resolve from model ids
  // and keys alone.
  providerEnvKey = null,
  // The lane's own model knob(s), in precedence order. A value here pins the
  // provider it belongs to (step 3).
  modelEnvKeys = [],
  // Provider-wide model knobs: { openai: ['OPENAI_MODEL'] }. Model only.
  providerModelEnvKeys = {},
  // The lane's default model per provider.
  defaultModels = {},
  // Override the registry order (only the unified extractor's own export
  // passes it, value-synced with the registry by test).
  providers = null
} = {}) => {
  const order = providers || getLane(laneId)?.providers || [];
  const keyFor = (name) => String((keys && name in keys ? keys[name] : env?.[PROVIDER_KEY_ENV[name]]) || '').trim();
  const envProvider = providerEnvKey ? String(env?.[providerEnvKey] || '').trim().toLowerCase() : '';
  const envModel = firstNonEmpty(env, modelEnvKeys);
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
  const failed = (reason, name = chosen) => ({
    ok: false, provider: name, model: null, apiKey: '', reason, source: { provider: providerSource, model: null }, lane: laneId || null
  });
  if (!chosen) return failed('no_provider_key', null);
  if (!order.includes(chosen)) return failed(`unknown_provider:${chosen}`);
  const apiKey = keyFor(chosen);
  if (!apiKey) return failed(`no_provider_key:${chosen}`);

  let resolvedModel = defaultModels[chosen] || null;
  let modelSource = 'default';
  const providerModel = firstNonEmpty(env, providerModelEnvKeys[chosen]);
  if (requestedModel) { resolvedModel = requestedModel; modelSource = 'param'; }
  else if (envModel && (!inferProviderFromModel(envModel) || inferProviderFromModel(envModel) === chosen)) {
    resolvedModel = envModel; modelSource = 'env';
  } else if (providerModel && (!inferProviderFromModel(providerModel) || inferProviderFromModel(providerModel) === chosen)) {
    resolvedModel = providerModel; modelSource = 'env_provider';
  } else if (envModel) {
    modelSource = 'default_env_model_other_provider';
  }
  if (!resolvedModel) return failed(`no_default_model:${chosen}`);
  return { ok: true, provider: chosen, model: resolvedModel, apiKey, reason: null, source: { provider: providerSource, model: modelSource }, lane: laneId || null };
};

// The parse pipeline's question: can this lane run at all right now, and if
// not, what is the real cause? `reason` names the missing provider key
// (`no_provider_key` when no qualified provider holds one), never a
// specific provider the installation never meant to use.
export const laneProviderStatus = (options = {}) => {
  const resolved = resolveLaneProvider(options);
  return { configured: resolved.ok, provider: resolved.provider, reason: resolved.reason };
};

// A reason the receipt can carry when a lane has no key: names every key the
// lane would accept, in preference order (`ANTHROPIC_API_KEY|OPENAI_API_KEY`).
export const missingKeyDetail = (laneId) =>
  (getLane(laneId)?.providers || []).map((name) => PROVIDER_KEY_ENV[name]).filter(Boolean).join('|') || null;

// The lane modules read keys and knobs from process.env with the cwd's .env
// as a fallback (`process.env.X || dotEnv.X`). This is that merge as one
// env object: a non-empty process.env value wins, .env fills the rest.
export const envWithDotEnv = (dotEnv = {}, env = process.env) => {
  const merged = { ...(dotEnv || {}) };
  for (const [key, value] of Object.entries(env || {})) {
    if (value != null && String(value) !== '') merged[key] = value;
  }
  return merged;
};
