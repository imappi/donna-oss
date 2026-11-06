// S1 of design-donna-desktop-runtime-on.md — the map's mechanics.
// Posture-level assertions (do the values actually satisfy the gates?)
// live in desktopRuntimePosture.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_RUNTIME_ENV_DEFAULTS,
  applyDesktopHostRuntimeDefaults
} from './hostRuntimeDefaults.js';

test('virgin env → every key applied, none preserved', () => {
  const env = {};
  const { applied, preserved } = applyDesktopHostRuntimeDefaults(env);
  assert.deepEqual(applied.sort(), Object.keys(DESKTOP_RUNTIME_ENV_DEFAULTS).sort());
  assert.deepEqual(preserved, []);
  for (const [key, value] of Object.entries(DESKTOP_RUNTIME_ENV_DEFAULTS)) {
    assert.equal(env[key], value);
  }
});

test('an explicit launch-line value is never overwritten — including false', () => {
  const env = { BANK_STATEMENT_MATCHER_ENABLED: 'false', LOOPS_TIER: 'off' };
  const { preserved } = applyDesktopHostRuntimeDefaults(env);
  assert.equal(env.BANK_STATEMENT_MATCHER_ENABLED, 'false');
  assert.equal(env.LOOPS_TIER, 'off');
  assert.ok(preserved.includes('BANK_STATEMENT_MATCHER_ENABLED'));
  assert.ok(preserved.includes('LOOPS_TIER'));
});

test('an explicit empty string counts as set and is preserved', () => {
  const env = { SALES_INVOICE_MATCHER_ENABLED: '' };
  applyDesktopHostRuntimeDefaults(env);
  assert.equal(env.SALES_INVOICE_MATCHER_ENABLED, '');
});

test('idempotent — a second application changes nothing', () => {
  const env = {};
  applyDesktopHostRuntimeDefaults(env);
  const snapshot = { ...env };
  const { applied } = applyDesktopHostRuntimeDefaults(env);
  assert.deepEqual(applied, []);
  assert.deepEqual(env, snapshot);
});

test('the map stays inside its declared scope — no plane anti-pattern keys', () => {
  const keys = Object.keys(DESKTOP_RUNTIME_ENV_DEFAULTS);
  // A client allowlist in env is the config-plane anti-pattern; the map
  // must never grow one. CODING_AUTO_POST is plane-rows-only (S2), and
  // OWNER_EMAIL_ASKS belongs to the asks design.
  assert.ok(!keys.some((key) => key.endsWith('_CLIENTS')));
  assert.ok(!keys.includes('CODING_AUTO_POST'));
  assert.ok(!keys.includes('OWNER_EMAIL_ASKS'));
});
