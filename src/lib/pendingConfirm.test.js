import test from 'node:test';
import assert from 'node:assert';
import {
  stashConfirmEmail,
  readConfirmEmail,
  clearConfirmEmail,
  PENDING_CONFIRM_KEY
} from './pendingConfirm.js';

// Minimal localStorage shim so the browser-only module is exercisable under
// node's test runner (the functions read `window` at call time, not import).
const makeStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
};

test('stash + read round-trips a trimmed email', () => {
  global.window = { localStorage: makeStorage() };
  assert.equal(typeof PENDING_CONFIRM_KEY, 'string');
  stashConfirmEmail('  Owner@Example.com  ');
  assert.equal(readConfirmEmail(), 'Owner@Example.com');
  delete global.window;
});

test('blank or whitespace email is not stashed', () => {
  global.window = { localStorage: makeStorage() };
  stashConfirmEmail('   ');
  assert.equal(readConfirmEmail(), '');
  stashConfirmEmail(null);
  assert.equal(readConfirmEmail(), '');
  delete global.window;
});

test('clear removes the stashed email', () => {
  global.window = { localStorage: makeStorage() };
  stashConfirmEmail('owner@example.com');
  clearConfirmEmail();
  assert.equal(readConfirmEmail(), '');
  delete global.window;
});

test('read returns empty string when window is absent (SSR-safe)', () => {
  delete global.window;
  assert.equal(readConfirmEmail(), '');
});
