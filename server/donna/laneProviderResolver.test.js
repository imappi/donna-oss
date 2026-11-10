// The one provider resolver (laneProviderResolver.js): its order of
// authority is the unified extractor's (resolveUnifiedProvider wraps it),
// with the preference order read from the lane registry.
import assert from 'node:assert/strict';
import test from 'node:test';

import { envWithDotEnv, laneProviderStatus, missingKeyDetail, resolveLaneProvider } from './laneProviderResolver.js';

const DEFAULTS = { anthropic: 'claude-opus-5-5', openai: 'gpt-5.4' };
const resolve = (env, extra = {}) => resolveLaneProvider({ laneId: 'document_routing', env, defaultModels: DEFAULTS, modelEnvKeys: ['DOCUMENT_ROUTER_MODEL'], providerModelEnvKeys: { openai: ['OPENAI_MODEL'] }, ...extra });

test('key presence in the registry order: Anthropic first, OpenAI only without an Anthropic key', () => {
  assert.deepEqual(resolve({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }), {
    ok: true, provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'a', reason: null,
    source: { provider: 'key_presence', model: 'default' }, lane: 'document_routing'
  });
  assert.deepEqual([resolve({ OPENAI_API_KEY: 'o' }).provider, resolve({ OPENAI_API_KEY: 'o' }).model], ['openai', 'gpt-5.4']);
});

test('no key at all: the reason names the missing key, no provider', () => {
  const none = resolve({});
  assert.deepEqual([none.ok, none.provider, none.reason], [false, null, 'no_provider_key']);
  assert.deepEqual(laneProviderStatus({ laneId: 'document_routing', env: {}, defaultModels: DEFAULTS }), { configured: false, provider: null, reason: 'no_provider_key' });
  assert.equal(missingKeyDetail('document_routing'), 'ANTHROPIC_API_KEY|OPENAI_API_KEY');
});

test('an explicit argument, then the lane model knob (which pins its provider), then keys', () => {
  assert.equal(resolve({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, { provider: 'openai' }).provider, 'openai');
  const pinned = resolve({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', DOCUMENT_ROUTER_MODEL: 'gpt-5.4-mini' });
  assert.deepEqual([pinned.provider, pinned.model, pinned.source.provider, pinned.source.model], ['openai', 'gpt-5.4-mini', 'model_id', 'env']);
  const claudePinNoKey = resolve({ OPENAI_API_KEY: 'o', DOCUMENT_ROUTER_MODEL: 'claude-opus-5-5' });
  assert.deepEqual([claudePinNoKey.ok, claudePinNoKey.reason], [false, 'no_provider_key:anthropic'], 'a claude id never goes to OpenAI');
  assert.equal(resolve({ ANTHROPIC_API_KEY: 'a' }, { model: 'claude-opus-4-8' }).model, 'claude-opus-4-8');
});

test('a provider-wide knob tunes that provider\'s model and never pins the provider', () => {
  const both = resolve({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', OPENAI_MODEL: 'gpt-5.4-nano' });
  assert.deepEqual([both.provider, both.model], ['anthropic', 'claude-opus-5-5']);
  const openai = resolve({ OPENAI_API_KEY: 'o', OPENAI_MODEL: 'gpt-5.4-nano' });
  assert.deepEqual([openai.provider, openai.model, openai.source.model], ['openai', 'gpt-5.4-nano', 'env_provider']);
});

test('a provider the lane does not list is refused', () => {
  assert.equal(resolve({ ANTHROPIC_API_KEY: 'a' }, { provider: 'typesafe' }).reason, 'unknown_provider:typesafe');
});

test('envWithDotEnv: a non-empty process value wins, .env fills the rest', () => {
  assert.deepEqual(envWithDotEnv({ A: 'dot', B: 'dot' }, { A: '', B: 'proc', C: 'proc' }), { A: 'dot', B: 'proc', C: 'proc' });
});
