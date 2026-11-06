import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every key a mounted surface destructures from useInterfaceLocale() must be
// a key the LocaleProvider value actually carries. The 2026-09-02 locale
// boundary (7e97170a) had ProfileTab and PeopleTab read `formatNumber` from
// the hook while the provider exposed formatAmount / formatDate /
// formatTimestamp only — `formatNumber(...)` was `undefined(...)`, the
// Profile click threw inside render, and with no error boundary above the
// lazy workspace the whole app unmounted to a white screen. A render that
// can only fail at click time is caught here at test time instead.

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const providerSource = readFileSync(path.join(SRC_ROOT, 'i18n/LocaleProvider.jsx'), 'utf8');

const providerValueKeys = () => {
  const start = providerSource.indexOf('const value = useMemo(() => ({');
  const end = providerSource.indexOf('}), [preferences, allowTestLocale');
  assert.ok(start > -1 && end > start, 'LocaleProvider value block not found');
  const block = providerSource.slice(start, end);
  return new Set([...block.matchAll(/^\s{4}(\w+)\s*[:,]/gm)].map((match) => match[1]));
};

const sourceFiles = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(jsx|js)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
};

const destructuredHookKeys = (source) => {
  const keys = [];
  for (const match of source.matchAll(/const\s*\{([^}]+)\}\s*=\s*useInterfaceLocale\(\)/g)) {
    for (const entry of match[1].split(',')) {
      const key = entry.trim().split(':')[0].split('=')[0].trim();
      if (key) keys.push(key);
    }
  }
  return keys;
};

test('the LocaleProvider value carries the interface number formatter', () => {
  const keys = providerValueKeys();
  for (const key of ['formatNumber', 'formatAmount', 'formatDate', 'formatTimestamp']) {
    assert.ok(keys.has(key), `useInterfaceLocale() must expose ${key}`);
  }
});

test('every key a surface destructures from useInterfaceLocale() exists on the provider value', () => {
  const exposed = providerValueKeys();
  const missing = [];
  let consumers = 0;
  for (const file of sourceFiles(SRC_ROOT)) {
    const keys = destructuredHookKeys(readFileSync(file, 'utf8'));
    if (keys.length) consumers += 1;
    for (const key of keys) {
      if (!exposed.has(key)) missing.push(`${path.relative(SRC_ROOT, file)} → ${key}`);
    }
  }
  assert.ok(consumers > 0, 'expected at least one useInterfaceLocale() consumer');
  assert.deepEqual(missing, [], `useInterfaceLocale() keys the provider does not expose:\n${missing.join('\n')}`);
});
