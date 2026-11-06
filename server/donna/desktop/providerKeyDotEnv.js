// The appliance's provider-key bridge to the repo's .env files (2026-08-06).
//
// The cloud entry (server/index.js) copies exactly four provider keys out of
// vite's loadEnv into process.env. The DESKTOP chain (desktop/main.mjs →
// runtime.mjs → runtimeServer) never read .env at all — the runtime child
// inherits only the shell env plus the DB/socket vars — so a key added to
// ~/donna/.env (the natural instruction, and the one the cloud entry honors)
// silently never reached the runtime: the model-lane receipt showed
// `anthropic DARK` while the file carried a valid key (the 2026-08-06
// key-install miss). This module closes that gap at the same only-where-unset
// boot seam as hostRuntimeDefaults.
//
// NARROW ON PURPOSE: only the same keys server/index.js copies (four
// original provider keys + the openai_compatible endpoint pair, descent
// ladder Q3 — the two lists move in lockstep). The repo
// .env also carries cloud dev config (flags, modes, connector secrets) —
// loading the whole file would let that leak into the appliance posture,
// which is the anti-goal. Precedence: a shell/launch-line VALUE always wins,
// but a set-but-blank var is treated as unset (Kari's dated call,
// 2026-08-16 — same rail as providerKeyStore.js: a blank key shadows and
// then reads as not-configured, the state that wins and doesn't work);
// between files, the desktop's home providers.env intentionally wins across
// checkouts, then .env.local, then .env. This also applies to checkout launches;
// a shell value is the explicit override for a stray home configuration.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { envValueSet } from './providerKeyStore.js';

export const PROVIDER_ENV_KEYS = Object.freeze([
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'ANTHROPIC_API_KEY',
  'LOUIS_MODEL',
  'TYPESAFE_API_KEY',
  'TYPESAFE_MODEL',
  // The openai_compatible endpoint pair (descent ladder Q3): BYOK key +
  // base URL for the Qwen-class challenger rung. No default host exists —
  // an unset pair means the endpoint refuses loudly, never guesses.
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  // The challenger's dispatch knobs (§9.2/§9.5 decided, Kari 2026-08-12):
  // candidate model id + per-client monthly token cap. Model ids and
  // tuning knobs are legitimate env per the flags rail; the BEHAVIOR gate
  // stays MODEL_CHALLENGER on the config plane. Both absent ⇒ the
  // challenger stays dark, fail-closed.
  'OPENAI_COMPATIBLE_MODEL',
  'MODEL_CHALLENGER_CAP_TOKENS',
  'JEV_SHADOW_SAMPLE_FRACTION'
]);

// server/donna/desktop → the repo root is three levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const defaultDotEnvFiles = () => [
  path.join(homedir(), '.config', 'donna', 'providers.env'),
  path.join(REPO_ROOT, '.env.local'),
  path.join(REPO_ROOT, '.env')
];

// Same parser shape as the existing readDotEnv fallbacks (askPipeline.js,
// merchantLookup.js), slightly forgiving: optional `export ` prefix and
// surrounding whitespace, single/double quotes stripped.
export const parseDotEnv = (text) => {
  const vars = {};
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return vars;
};

export const applyProviderKeyDotEnvDefaults = (env = process.env, {
  files = defaultDotEnvFiles(),
  readFileFn = (filePath) => (existsSync(filePath) ? readFileSync(filePath, 'utf8') : null)
} = {}) => {
  const applied = [];
  const overrodeBlank = [];
  for (const file of files) {
    let text = null;
    try {
      text = readFileFn(file);
    } catch {
      text = null; // unreadable file → skip, never throw into boot
    }
    if (!text) continue;
    const vars = parseDotEnv(text);
    for (const key of PROVIDER_ENV_KEYS) {
      if (!envValueSet(env[key]) && typeof vars[key] === 'string' && vars[key].trim()) {
        if (env[key] != null) overrodeBlank.push(key);
        env[key] = vars[key];
        applied.push(key);
      }
    }
  }
  return { applied, overrodeBlank };
};
