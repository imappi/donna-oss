// Shared OpenAI config for the marketing drafters. One source of truth for
// the key + model resolution so every load-bearing generation call follows
// the same convention: strong model by default, OPENAI_MODEL as the override
// knob (same as askPipeline.js / transactionLlm.js), .env fallback for local
// development.

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// Outward, brand-carrying copy is a load-bearing call — strong model default.
export const STRONG_MODEL_DEFAULT = 'gpt-5.4';

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
