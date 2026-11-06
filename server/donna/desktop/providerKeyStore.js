// The appliance's BYO provider-key store (technical plan §7: "the USER's
// key, stored via async safeStorage/Keychain … never in PG, never in logs,
// never in telemetry, never in renderer state").
//
// The settings screen shipped its key inputs on LOCAL STATE ONLY (UI-first,
// 2026-08-07): a pasted key evaporated on reload and nothing said so. This
// module is the storage half that closes it — the ciphertext file, its
// validation, and the env application — kept free of any `electron` import
// so it is testable under plain node. The CRYPTO is injected: the shell
// passes Electron's `safeStorage` (OS keychain-derived), and nothing here
// ever writes a key in plaintext. If encryption is unavailable, the caller
// must REFUSE to store — a plaintext fallback would quietly turn the
// keychain promise into a dotfile.
//
// PRECEDENCE, deliberately (the same only-where-unset seam as
// providerKeyDotEnv.js and hostRuntimeDefaults.js):
//
//   launch-line / shell env   >   this store (keychain)   >   repo .env
//
// The shell env wins because an explicitly-set var is an operator's direct
// instruction; the store beats the repo .env files because a key the user
// typed into their own appliance outranks a developer dotfile. When the
// shell env shadows a stored key the UI must SAY so — a silently ignored
// key is exactly the failure this module exists to end.
//
// A set-but-BLANK env var is NOT an instruction (Kari's dated call,
// 2026-08-16): it was the one state that both shadowed a freshly saved
// keychain key AND read as not-configured downstream (every runtime reader
// is `process.env.X || ''`) — it won and didn't work. Blank/whitespace is
// treated as unset at every provider-key seam (here and
// providerKeyDotEnv.js), which also aligns the appliance with the cloud
// entry (server/index.js reads these keys falsy). A deliberate "no key" is
// expressed by removing the key, never by a blank var — and the UI says
// "set but empty" so the state stays visible.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PROVIDER_KEYS = Object.freeze([
  Object.freeze({ id: 'openai', env: 'OPENAI_API_KEY', label: 'OpenAI' }),
  Object.freeze({ id: 'anthropic', env: 'ANTHROPIC_API_KEY', label: 'Anthropic' }),
  Object.freeze({ id: 'typesafe', env: 'TYPESAFE_API_KEY', label: 'TypeSafe' })
]);

const BY_ID = new Map(PROVIDER_KEYS.map((spec) => [spec.id, spec]));

export const providerKeySpec = (providerId) => BY_ID.get(String(providerId || '')) || null;

export const PROVIDER_KEY_FILE_VERSION = 1;

// A pasted key is a single opaque token: no whitespace, no control bytes.
// The bounds catch the two real paste accidents — a truncated fragment and
// a whole file pasted into the field.
const MIN_KEY_LENGTH = 12;
const MAX_KEY_LENGTH = 512;

export const normalizeProviderKeyInput = (raw) => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: 'A key is required.' };
  if (value.length < MIN_KEY_LENGTH) return { ok: false, reason: 'That looks too short to be an API key.' };
  if (value.length > MAX_KEY_LENGTH) return { ok: false, reason: 'That is too long to be an API key.' };
  const hasControlChar = Array.from(value)
    .some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (/\s/.test(value) || hasControlChar) {
    return { ok: false, reason: 'A key cannot contain spaces or line breaks — check the paste.' };
  }
  return { ok: true, value };
};

// Last four characters only, and only for a key long enough that four
// characters reveal nothing structural. Never the whole key, never a prefix.
export const maskProviderKey = (value) => {
  const text = typeof value === 'string' ? value : '';
  if (text.length < 8) return '••••';
  return `••••${text.slice(-4)}`;
};

export const emptyProviderKeyFile = () => ({ version: PROVIDER_KEY_FILE_VERSION, providers: {} });

// Tolerant of junk: a corrupt or hand-edited file degrades to "nothing
// stored" rather than throwing into shell boot. Entries for unknown
// providers are dropped, so retiring a provider retires its ciphertext.
export const parseProviderKeyFile = (text) => {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    return emptyProviderKeyFile();
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.providers !== 'object' || !parsed.providers) {
    return emptyProviderKeyFile();
  }
  const providers = {};
  for (const spec of PROVIDER_KEYS) {
    const entry = parsed.providers[spec.id];
    if (entry && typeof entry.cipher === 'string' && entry.cipher) {
      providers[spec.id] = {
        cipher: entry.cipher,
        savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : null
      };
    }
  }
  return { version: PROVIDER_KEY_FILE_VERSION, providers };
};

export const serializeProviderKeyFile = (file) =>
  `${JSON.stringify({ version: PROVIDER_KEY_FILE_VERSION, providers: file?.providers || {} }, null, 2)}\n`;

export const putProviderKey = (file, { providerId, cipher, savedAt }) => {
  const spec = providerKeySpec(providerId);
  if (!spec) throw new Error(`unknown provider: ${providerId}`);
  return {
    version: PROVIDER_KEY_FILE_VERSION,
    providers: { ...(file?.providers || {}), [spec.id]: { cipher, savedAt: savedAt || null } }
  };
};

// providerId 'all' clears every stored key — the "these are not my keys"
// escape hatch, one click.
export const removeProviderKey = (file, providerId) => {
  if (providerId === 'all') return emptyProviderKeyFile();
  const spec = providerKeySpec(providerId);
  if (!spec) throw new Error(`unknown provider: ${providerId}`);
  const providers = { ...(file?.providers || {}) };
  delete providers[spec.id];
  return { version: PROVIDER_KEY_FILE_VERSION, providers };
};

export const readProviderKeyFile = ({ filePath, readFileFn = readFileSync } = {}) => {
  try {
    return parseProviderKeyFile(readFileFn(filePath, 'utf8'));
  } catch {
    // Missing file is the common case (nothing saved yet); an unreadable
    // one must not take the shell down either.
    return emptyProviderKeyFile();
  }
};

// Atomic + owner-only: temp file at 0600, then rename. A half-written
// ciphertext file would read as "no keys" on the next boot, which is the
// silent-key-loss bug wearing a different hat.
export const writeProviderKeyFile = ({
  filePath,
  file,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  renameFn = renameSync
} = {}) => {
  mkdirFn(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileFn(tempPath, serializeProviderKeyFile(file), { encoding: 'utf8', mode: 0o600 });
  renameFn(tempPath, filePath);
  return filePath;
};

// Decrypt what is decryptable; report what is not. A key that no longer
// decrypts (restored to another machine, keychain reset) is NOT an error to
// throw — it is a state the screen must be able to explain.
export const decryptStoredProviderKeys = (file, { decrypt } = {}) => {
  const values = {};
  const unreadable = [];
  for (const spec of PROVIDER_KEYS) {
    const entry = file?.providers?.[spec.id];
    if (!entry?.cipher) continue;
    let plain = null;
    try {
      plain = decrypt(entry.cipher);
    } catch {
      plain = null;
    }
    if (typeof plain === 'string' && plain.trim()) values[spec.env] = plain.trim();
    else unreadable.push(spec.id);
  }
  return { values, unreadable };
};

// An env var counts as an operator instruction only when it carries a
// value — see the header's set-but-blank rationale. Shared by the apply
// below, the status projection, and providerKeyDotEnv.js so every
// provider-key seam answers "is this var set?" identically.
export const envValueSet = (value) => value != null && String(value).trim() !== '';

// Only where unset — and set-but-blank IS unset. Returns the NAMES applied
// plus which of those replaced a blank var (`overrodeBlank`, so the shell
// log can say why the env var did not win), never values: this result is
// logged.
export const applyProviderKeysToEnv = (env, values = {}) => {
  const applied = [];
  const overrodeBlank = [];
  for (const spec of PROVIDER_KEYS) {
    const value = values[spec.env];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (envValueSet(env[spec.env])) continue;
    if (env[spec.env] != null) overrodeBlank.push(spec.env);
    env[spec.env] = value;
    applied.push(spec.env);
  }
  return { applied, overrodeBlank };
};

// The renderer's view of the store: enough to decide, never enough to leak.
// `shadowedByEnv` is the honesty bit — a key stored here that the shell env
// overrides is doing nothing, and the screen has to say which one is live.
export const describeProviderKeyStatus = ({
  file,
  values = {},
  unreadable = [],
  env = {},
  encryptionAvailable = true,
  unavailableReason = ''
} = {}) => ({
  available: Boolean(encryptionAvailable),
  reason: encryptionAvailable ? '' : (unavailableReason || 'This machine has no OS keychain available.'),
  providers: PROVIDER_KEYS.map((spec) => {
    const entry = file?.providers?.[spec.id] || null;
    const stored = values[spec.env] || '';
    return {
      id: spec.id,
      label: spec.label,
      env: spec.env,
      saved: Boolean(entry),
      unreadable: unreadable.includes(spec.id),
      preview: stored ? maskProviderKey(stored) : '',
      savedAt: entry?.savedAt || null,
      // Same test `applyProviderKeysToEnv` uses, so the screen and the child
      // process can never disagree about which key is live.
      shadowedByEnv: envValueSet(env[spec.env]),
      // The state that used to win silently: present in the launch env but
      // blank. It no longer shadows anything — the card says so instead of
      // implying a live env key.
      envSetButEmpty: env[spec.env] != null && !envValueSet(env[spec.env])
    };
  })
});
