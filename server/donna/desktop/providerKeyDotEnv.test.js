import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyProviderKeyDotEnvDefaults,
  parseDotEnv,
  PROVIDER_ENV_KEYS
} from './providerKeyDotEnv.js';

const REPO_ROOT_FOR_TEST = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const reader = (contentsByPath) => (filePath) => contentsByPath[filePath] ?? null;

test('copies a missing provider key from .env into the env', () => {
  const env = {};
  const { applied } = applyProviderKeyDotEnvDefaults(env, {
    files: ['/repo/.env.local', '/repo/.env'],
    readFileFn: reader({ '/repo/.env': 'ANTHROPIC_API_KEY=sk-ant-file\nOPENAI_MODEL=gpt-5.4' })
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-file');
  assert.equal(env.OPENAI_MODEL, 'gpt-5.4');
  assert.deepEqual(applied.sort(), ['ANTHROPIC_API_KEY', 'OPENAI_MODEL']);
});

test('an env VALUE always wins; a set-but-blank var is treated as unset and filled', () => {
  // The 2026-08-16 dated call (same rail as providerKeyStore): a blank
  // shell var used to block the .env fill AND read as not-configured —
  // the state that wins and doesn't work. Now only a value wins.
  const env = { ANTHROPIC_API_KEY: 'sk-ant-shell', OPENAI_API_KEY: '', LOUIS_MODEL: '   ' };
  const { applied, overrodeBlank } = applyProviderKeyDotEnvDefaults(env, {
    files: ['/repo/.env'],
    readFileFn: reader({ '/repo/.env': 'ANTHROPIC_API_KEY=sk-ant-file\nOPENAI_API_KEY=sk-file\nLOUIS_MODEL=louis-2' })
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-shell', 'a real shell value is never overwritten');
  assert.equal(env.OPENAI_API_KEY, 'sk-file');
  assert.equal(env.LOUIS_MODEL, 'louis-2', 'whitespace-only counts as blank');
  assert.deepEqual(applied.sort(), ['LOUIS_MODEL', 'OPENAI_API_KEY']);
  assert.deepEqual(overrodeBlank.sort(), ['LOUIS_MODEL', 'OPENAI_API_KEY']);
});

test('.env.local wins over .env (vite precedence)', () => {
  const env = {};
  applyProviderKeyDotEnvDefaults(env, {
    files: ['/repo/.env.local', '/repo/.env'],
    readFileFn: reader({
      '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-ant-local',
      '/repo/.env': 'ANTHROPIC_API_KEY=sk-ant-base'
    })
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-local');
});

test('non-provider keys in the file are NEVER copied (the narrow-list law)', () => {
  const env = {};
  applyProviderKeyDotEnvDefaults(env, {
    files: ['/repo/.env'],
    readFileFn: reader({
      '/repo/.env': 'LOOPS_TIER=canary\nCODING_AUTO_POST=true\nDATABASE_URL=postgres://x\nANTHROPIC_API_KEY=sk-ant-1'
    })
  });
  assert.equal(env.LOOPS_TIER, undefined);
  assert.equal(env.CODING_AUTO_POST, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-1');
});

test('parser strips quotes and an export prefix; blank values never apply', () => {
  const vars = parseDotEnv('export ANTHROPIC_API_KEY="sk-ant-q"\nOPENAI_API_KEY=\'sk-o\'\nLOUIS_MODEL=');
  assert.equal(vars.ANTHROPIC_API_KEY, 'sk-ant-q');
  assert.equal(vars.OPENAI_API_KEY, 'sk-o');
  const env = {};
  applyProviderKeyDotEnvDefaults(env, {
    files: ['/repo/.env'],
    readFileFn: reader({ '/repo/.env': 'LOUIS_MODEL=\nANTHROPIC_API_KEY=   ' })
  });
  assert.equal(env.LOUIS_MODEL, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('missing or unreadable files are a silent no-op', () => {
  const env = {};
  const { applied } = applyProviderKeyDotEnvDefaults(env, {
    files: ['/repo/.env.local', '/repo/.env'],
    readFileFn: (p) => { if (p.endsWith('.env')) throw new Error('EACCES'); return null; }
  });
  assert.deepEqual(applied, []);
});

test('the key list is exactly the server/index.js copies (provider keys + the openai_compatible pair + the challenger knobs)', () => {
  assert.deepEqual(
    [...PROVIDER_ENV_KEYS].sort(),
    [
      'ANTHROPIC_API_KEY',
      'JEV_SHADOW_SAMPLE_FRACTION',
      'LOUIS_MODEL',
      'MODEL_CHALLENGER_CAP_TOKENS',
      'OPENAI_API_KEY',
      'OPENAI_COMPATIBLE_API_KEY',
      'OPENAI_COMPATIBLE_BASE_URL',
      'OPENAI_COMPATIBLE_MODEL',
      'OPENAI_MODEL',
      'TYPESAFE_API_KEY',
      'TYPESAFE_MODEL'
    ]
  );
});

test('lockstep: every listed key is copied by server/index.js (the two lists move together)', () => {
  const indexSource = readFileSync(resolvePath(REPO_ROOT_FOR_TEST, 'server', 'index.js'), 'utf8');
  for (const key of PROVIDER_ENV_KEYS) {
    assert.ok(
      indexSource.includes(`process.env.${key} = env.${key}`),
      `${key} is in PROVIDER_ENV_KEYS but server/index.js does not copy it — extend both in the same commit`
    );
  }
});
