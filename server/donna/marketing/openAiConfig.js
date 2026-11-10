// Shared OpenAI config for the marketing drafters. One source of truth for
// the key + model resolution so every load-bearing generation call follows
// the same convention: strong model by default, OPENAI_MODEL as the override
// knob (same as askPipeline.js / transactionLlm.js), .env fallback for local
// development.

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { getLane } from '../modelLanes.js';
import { missingKeyNameFor, resolveTextLaneProvider } from '../providerEndpoints.js';
import { anthropicStructuredRequest, openAiStructuredRequest, typedLlmCallFailure } from '../structuredRequest.js';

// Outward, brand-carrying copy is a load-bearing call — strong model default.
export const STRONG_MODEL_DEFAULT = 'gpt-5.4';

// 2026-11-10 (owner's decision: Claude only): the marketing drafters are
// provider-agnostic — Anthropic (claude-opus-5-5) when its key is present,
// OpenAI (STRONG_MODEL_DEFAULT) only when no Anthropic key is configured;
// OPENAI_MODEL may pin either family's id. Effort `medium` for every
// drafter: the copy is short, every draft rests 'proposed' under per-send
// approval, and validateDraftCopy refuses rail-violating copy at the mint.
const LANE_PROVIDERS = getLane('marketing_drafting').providers;
export const MARKETING_ANTHROPIC_EFFORT = 'medium';

let dotEnvCache = null;
const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Best-effort dotenv fallback for local development.
  }
  dotEnvCache = vars;
  return vars;
};

export const getOpenAiConfig = () => {
  const dotEnv = readDotEnv();
  return {
    apiKey: process.env.OPENAI_API_KEY || dotEnv.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || dotEnv.OPENAI_MODEL || STRONG_MODEL_DEFAULT
  };
};

// Which provider drafts, and with which model (providerEndpoints.js
// resolveLaneProvider — one resolver for every text lane). An explicit
// `openAiConfig` (the drafters' existing seam) pins OpenAI.
export const resolveMarketingProvider = ({ openAiConfig = null } = {}) =>
  resolveTextLaneProvider({ providers: LANE_PROVIDERS, openAiDefaultModel: STRONG_MODEL_DEFAULT, dotEnv: readDotEnv(), openAiConfig });

export const marketingKeyMissingMessage = (resolved, what) => {
  const { keyName } = missingKeyNameFor(resolved, LANE_PROVIDERS);
  return `No model key is configured (${keyName || 'ANTHROPIC_API_KEY'}); the ${what} has no fallback by design.`;
};

// The llmCall options for one drafter call on the resolved provider. The
// drafter makes the call itself (llmCall), keeps its own instructions,
// input and schema, and owns its failure. `parsed` / `model` (the id the
// RESPONSE named) come back on `result`.
export const marketingStructuredRequest = ({
  resolved, instructions, input, schemaName, schema, store = undefined,
  tools = null, openAiTools = null, executionType, executionId, fetchImpl = fetch
}) => {
  const execution = { root: { type: executionType, id: String(executionId || 'unattributed') } };
  if (resolved.provider === 'anthropic') {
    return anthropicStructuredRequest({
      apiKey: resolved.apiKey, model: resolved.model, system: instructions, user: input, schema,
      effort: MARKETING_ANTHROPIC_EFFORT, maxTokens: 32000, stream: true, tools, execution, fetchImpl
    });
  }
  const options = openAiStructuredRequest({
    apiKey: resolved.apiKey, model: resolved.model, instructions, input, schemaName, schema, store, execution, fetchImpl
  });
  if (openAiTools) {
    // The Responses body keeps its original key order (tools before text).
    const { text, ...rest } = options.body;
    options.body = { ...rest, tools: openAiTools, text };
  }
  return options;
};

// A failed drafter call → the honest message the drafter's 503 carries,
// naming the typed cause (no credit, bad key, rate limit, refusal, output
// limit) for either provider. null ⇒ not a provider failure (rethrow).
export const marketingFailureMessage = (provider, error) => {
  const typed = typedLlmCallFailure(provider, error);
  return typed ? typed.message : null;
};

// Generic env-with-.env-fallback read for the marketing modules' other
// secrets (e.g. COMPANIES_HOUSE_API_KEY). Secrets in env are the sanctioned
// pattern (CLAUDE.md config-control-plane rail: env keeps secrets).
export const envVar = (name) => process.env[name] || readDotEnv()[name] || '';

// Concatenate the Responses API's output text parts (output_text is the
// convenience field; the parts walk covers payloads that omit it).
export const outputTextFromResponse = (payload) => {
  if (typeof payload?.output_text === 'string' && payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
};
