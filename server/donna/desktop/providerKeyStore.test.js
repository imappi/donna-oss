import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyProviderKeysToEnv,
  decryptStoredProviderKeys,
  describeProviderKeyStatus,
  emptyProviderKeyFile,
  maskProviderKey,
  normalizeProviderKeyInput,
  parseProviderKeyFile,
  putProviderKey,
  readProviderKeyFile,
  removeProviderKey,
  serializeProviderKeyFile,
  writeProviderKeyFile
} from './providerKeyStore.js';
import { MOUNTED_SURFACE_MESSAGES } from '../../../src/i18n/catalogs/mountedSurfaces.en.js';

// A stand-in for Electron's safeStorage: reversible, obviously not crypto,
// and enough to pin that this module only ever handles CIPHERTEXT.
const codec = {
  encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (cipher) => {
    const text = Buffer.from(cipher, 'base64').toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
    return text.slice(4);
  }
};

test('rejects the paste accidents and accepts a real-shaped key', () => {
  assert.equal(normalizeProviderKeyInput('').ok, false);
  assert.equal(normalizeProviderKeyInput('   ').ok, false);
  assert.equal(normalizeProviderKeyInput('sk-short').ok, false);
  assert.equal(normalizeProviderKeyInput(`sk-${'a'.repeat(600)}`).ok, false);
  assert.equal(normalizeProviderKeyInput('sk-abc def-1234567').ok, false);
  assert.equal(normalizeProviderKeyInput('sk-abc\ndef-1234567').ok, false);
  const ok = normalizeProviderKeyInput('  sk-ant-api03-abcdefghijklmnop  ');
  assert.deepEqual(ok, { ok: true, value: 'sk-ant-api03-abcdefghijklmnop' });
});

test('masking never reveals the prefix and survives a short value', () => {
  assert.equal(maskProviderKey('sk-ant-api03-abcdWXYZ'), '••••WXYZ');
  assert.equal(maskProviderKey('short'), '••••');
  assert.equal(maskProviderKey(null), '••••');
});

test('the file round-trips ciphertext only, and junk degrades to empty', () => {
  const file = putProviderKey(emptyProviderKeyFile(), {
    providerId: 'openai',
    cipher: codec.encrypt('sk-live-openai-key-1234'),
    savedAt: '2026-08-07T18:00:00.000Z'
  });
  const text = serializeProviderKeyFile(file);
  assert.equal(text.includes('sk-live-openai-key-1234'), false, 'plaintext key must never hit disk');
  const parsed = parseProviderKeyFile(text);
  assert.deepEqual(parsed.providers.openai, {
    cipher: codec.encrypt('sk-live-openai-key-1234'),
    savedAt: '2026-08-07T18:00:00.000Z'
  });

  assert.deepEqual(parseProviderKeyFile('not json at all'), emptyProviderKeyFile());
  assert.deepEqual(parseProviderKeyFile('{"providers":{"mystery":{"cipher":"x"}}}').providers, {});
});

test('put/remove are pure and "all" clears the store', () => {
  const base = emptyProviderKeyFile();
  const withOpenai = putProviderKey(base, { providerId: 'openai', cipher: 'c1', savedAt: 'now' });
  const withBoth = putProviderKey(withOpenai, { providerId: 'anthropic', cipher: 'c2', savedAt: 'now' });
  assert.deepEqual(Object.keys(base.providers), [], 'input file is not mutated');
  assert.deepEqual(Object.keys(withBoth.providers).sort(), ['anthropic', 'openai']);
  assert.deepEqual(Object.keys(removeProviderKey(withBoth, 'openai').providers), ['anthropic']);
  assert.deepEqual(removeProviderKey(withBoth, 'all'), emptyProviderKeyFile());
  assert.throws(() => putProviderKey(base, { providerId: 'gemini', cipher: 'c' }), /unknown provider/);
});

test('the write is atomic and owner-only; an unreadable file reads as empty', () => {
  const writes = [];
  const renames = [];
  writeProviderKeyFile({
    filePath: '/data/runtime/provider-keys.json',
    file: putProviderKey(emptyProviderKeyFile(), { providerId: 'anthropic', cipher: 'c2' }),
    mkdirFn: () => {},
    writeFileFn: (p, body, options) => writes.push({ p, body, options }),
    renameFn: (from, to) => renames.push({ from, to })
  });
  assert.equal(writes[0].p, '/data/runtime/provider-keys.json.tmp', 'writes to a temp path first');
  assert.equal(writes[0].options.mode, 0o600);
  assert.deepEqual(renames, [
    { from: '/data/runtime/provider-keys.json.tmp', to: '/data/runtime/provider-keys.json' }
  ]);

  assert.deepEqual(
    readProviderKeyFile({
      filePath: '/nope',
      readFileFn: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
    }),
    emptyProviderKeyFile()
  );
});

test('an undecryptable entry is reported, not thrown', () => {
  const file = {
    version: 1,
    providers: {
      openai: { cipher: codec.encrypt('sk-openai-abcdefghij'), savedAt: null },
      anthropic: { cipher: 'not-really-ciphertext', savedAt: null }
    }
  };
  const { values, unreadable } = decryptStoredProviderKeys(file, { decrypt: codec.decrypt });
  assert.deepEqual(values, { OPENAI_API_KEY: 'sk-openai-abcdefghij' });
  assert.deepEqual(unreadable, ['anthropic']);
});

test('stored keys fill only what the shell env left without a VALUE', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-from-launch-line' };
  const { applied, overrodeBlank } = applyProviderKeysToEnv(env, {
    OPENAI_API_KEY: 'sk-from-keychain',
    ANTHROPIC_API_KEY: 'sk-from-keychain-too'
  });
  assert.deepEqual(applied, ['OPENAI_API_KEY']);
  assert.deepEqual(overrodeBlank, []);
  assert.equal(env.OPENAI_API_KEY, 'sk-from-keychain');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-from-launch-line', 'a launch-line VALUE always wins');
});

test('a set-but-blank env var is treated as unset — the stored key applies and the receipt names it', () => {
  // The 2026-08-16 dated call: set-but-empty was the one state that both
  // shadowed a freshly saved keychain key AND read as not-configured
  // downstream. It must never win again.
  const blanked = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '   ' };
  const { applied, overrodeBlank } = applyProviderKeysToEnv(blanked, {
    OPENAI_API_KEY: 'sk-from-keychain',
    ANTHROPIC_API_KEY: 'sk-from-keychain-too'
  });
  assert.deepEqual(applied, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  assert.deepEqual(overrodeBlank, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], 'whitespace-only counts as blank');
  assert.equal(blanked.OPENAI_API_KEY, 'sk-from-keychain');
  assert.equal(blanked.ANTHROPIC_API_KEY, 'sk-from-keychain-too');
});

test('the status the renderer sees carries no key material', () => {
  const file = putProviderKey(emptyProviderKeyFile(), {
    providerId: 'openai',
    cipher: codec.encrypt('sk-openai-abcdWXYZ'),
    savedAt: '2026-08-07T18:00:00.000Z'
  });
  const { values, unreadable } = decryptStoredProviderKeys(file, { decrypt: codec.decrypt });
  const status = describeProviderKeyStatus({
    file,
    values,
    unreadable,
    env: { OPENAI_API_KEY: 'sk-from-launch-line' },
    encryptionAvailable: true
  });
  assert.equal(status.available, true);
  assert.equal(JSON.stringify(status).includes('sk-openai-abcdWXYZ'), false);
  assert.equal(JSON.stringify(status).includes('sk-from-launch-line'), false);

  const openai = status.providers.find((p) => p.id === 'openai');
  assert.deepEqual(openai, {
    id: 'openai',
    label: 'OpenAI',
    env: 'OPENAI_API_KEY',
    saved: true,
    unreadable: false,
    preview: '••••WXYZ',
    savedAt: '2026-08-07T18:00:00.000Z',
    shadowedByEnv: true,
    envSetButEmpty: false
  });
  const anthropic = status.providers.find((p) => p.id === 'anthropic');
  assert.equal(anthropic.saved, false);
  assert.equal(anthropic.shadowedByEnv, false);
  assert.equal(anthropic.envSetButEmpty, false);
});

test('a blank env var reads as "set but empty", never as a live shadow', () => {
  const file = putProviderKey(emptyProviderKeyFile(), {
    providerId: 'anthropic',
    cipher: codec.encrypt('sk-ant-api03-abcdWXYZ'),
    savedAt: '2026-08-16T09:00:00.000Z'
  });
  const { values, unreadable } = decryptStoredProviderKeys(file, { decrypt: codec.decrypt });
  const status = describeProviderKeyStatus({
    file,
    values,
    unreadable,
    env: { ANTHROPIC_API_KEY: '' },
    encryptionAvailable: true
  });
  const anthropic = status.providers.find((p) => p.id === 'anthropic');
  // The screen and applyProviderKeysToEnv must agree: the blank var does
  // not shadow (the stored key is live), and the card can say so.
  assert.equal(anthropic.shadowedByEnv, false);
  assert.equal(anthropic.envSetButEmpty, true);
  assert.equal(anthropic.saved, true);
});

test('lockstep: the settings card renders both env states the status projects', () => {
  // shadowedByEnv earned its copy on day one; envSetButEmpty is the
  // 2026-08-16 honesty bit. A status field the card never renders is a
  // silently ignored key wearing a new hat — pin both.
  const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const panelSource = readFileSync(
    resolvePath(repoRoot, 'src', 'components', 'settings', 'SettingsPanel.jsx'),
    'utf8'
  );
  assert.ok(panelSource.includes('provider.shadowedByEnv'), 'the card renders the shadowed-by-env state');
  assert.ok(panelSource.includes('provider.envSetButEmpty'), 'the card renders the set-but-empty state');
  assert.ok(panelSource.includes("message('mounted.settings.keys.shadowed'"), 'the shadowed state resolves through the interface catalog');
  assert.ok(panelSource.includes("message('mounted.settings.keys.emptyEnv'"), 'the set-but-empty state resolves through the interface catalog');
  assert.match(
    MOUNTED_SURFACE_MESSAGES['mounted.settings.keys.emptyEnv'],
    /\{environment\} is set but empty/,
    'the localized set-but-empty copy names the environment state'
  );
});

test('no keychain means the store says so instead of falling back to plaintext', () => {
  const status = describeProviderKeyStatus({
    file: emptyProviderKeyFile(),
    encryptionAvailable: false,
    unavailableReason: 'macOS Keychain is locked.'
  });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'macOS Keychain is locked.');
  assert.deepEqual(status.providers.map(p => p.id), ['openai', 'anthropic', 'typesafe']);
});
